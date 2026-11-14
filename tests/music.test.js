'use strict';
// Phase 5 tests — run with: npm test
// Spawns the real server on a scratch port with a temp DB/uploads dir.
// Covers: real DSP beat/BPM analysis on FFmpeg-generated audio with KNOWN
// tempos (120 BPM MP3 click track, 90 BPM WAV click track, 100 BPM
// music-like tone bursts), analysis caching, per-user isolation, anonymous
// 401, license notes, apply-sync cuts/transitions at real beat times, and
// a REAL end-to-end render with looped music mixed in (ffprobe-validated,
// audio stream present). Plus pure-function tests of the sync engine.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const {
  blankTimeline, defaultClip, validateTimeline, totalDuration,
} = require('../src/video-model');
const { applyMusicSync, snapToBeat, stripSync } = require('../src/music-sync');
const { analyzePcm } = require('../src/music-analysis');
const { probeMedia } = require('../src/ffmpeg');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-music-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4835;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let ownerCookie = '';
let userCookie = '';

function req(path, { method = 'GET', body, cookie, form } = {}) {
  const headers = { connection: 'close' };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) { payload = form; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' })
    .then(async (r) => {
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, text, headers: r.headers, setCookie: r.headers.get('set-cookie') || '' };
    });
}

function ffprobe(file) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate', '-show_entries', 'format=duration', '-of', 'json', file],
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
}

// Click track: a 1 kHz burst in the last 0.05 s of every beat period, over
// a quiet 110 Hz drone (so the track is not just silence between clicks).
// Bursts start at 0.45 + k*period — that is the KNOWN beat grid.
function makeClickTrack(file, seconds, period, codec) {
  const args = ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `aevalsrc='sin(2*PI*1000*t)*gt(mod(t,${period}),${period - 0.05})':duration=${seconds}`,
    '-f', 'lavfi', '-i', `aevalsrc='0.15*sin(2*PI*110*t)':duration=${seconds}`,
    '-filter_complex', 'amix=inputs=2:normalize=0'];
  if (codec === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', '4');
  else args.push('-c:a', 'pcm_s16le');
  args.push(file);
  execFileSync('ffmpeg', args, { timeout: 60000 });
}

// Music-like track: 100 BPM tone bursts (440 Hz + 880 Hz harmonic) over a
// soft 55 Hz bass drone. Bursts start at 0.55 + k*0.6.
function makeToneTrack(file, seconds) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `aevalsrc='sin(2*PI*440*t)*gt(mod(t,0.6),0.55)+0.3*sin(2*PI*880*t)*gt(mod(t,0.6),0.55)+0.1*sin(2*PI*55*t)':duration=${seconds}`,
    '-c:a', 'pcm_s16le', file], { timeout: 60000 });
}

// Flat drone: no onsets at all — analysis must refuse, not guess a BPM.
function makeDrone(file, seconds) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `aevalsrc='0.1*sin(2*PI*110*t)':duration=${seconds}`,
    '-c:a', 'pcm_s16le', file], { timeout: 60000 });
}

function makeTestVideo(file, seconds, tone) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x180:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
    { timeout: 60000 });
}

// Video with NO audio track: the render test uses it so the only audio in
// the output can be the looped music — an RMS check then genuinely proves
// the music was mixed in (not the clip's own tone).
function makeSilentVideo(file, seconds) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x180:rate=30`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', file],
    { timeout: 60000 });
}

async function uploadMedia(file, name, mime, cookie) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime }), name);
  const r = await req('/api/media/upload', { method: 'POST', cookie: cookie || ownerCookie, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.media;
}

async function waitForJob(jobId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await req(`/api/video/jobs/${jobId}`, { cookie: ownerCookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    if (r.json.job.status === 'done') return r.json.job;
    if (r.json.job.status === 'failed' || r.json.job.status === 'cancelled') {
      throw new Error(`Render job ${jobId} ended ${r.json.job.status}: ${r.json.job.error || ''}`);
    }
    if (Date.now() > deadline) throw new Error(`Render job ${jobId} did not finish in ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

let click120, click90, tone100, drone, clipVideo;
let audio120, audio90, audio100, audioDrone, videoMedia;

before(async () => {
  click120 = path.join(tmp, 'click120.mp3');
  click90 = path.join(tmp, 'click90.wav');
  tone100 = path.join(tmp, 'tone100.wav');
  drone = path.join(tmp, 'drone.wav');
  clipVideo = path.join(tmp, 'clip.mp4');
  makeClickTrack(click120, 8, 0.5, 'mp3'); // 120 BPM
  makeClickTrack(click90, 9, 2 / 3, 'wav'); // 90 BPM
  makeToneTrack(tone100, 9); // ~100 BPM
  makeDrone(drone, 4);
  makeTestVideo(clipVideo, 4, 440);
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, HOST: '127.0.0.1', RENDER_CONCURRENCY: '1' },
    stdio: 'pipe',
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start in time');
    await new Promise((r) => setTimeout(r, 200));
  }
  const a = await req('/api/auth/signup', { method: 'POST', body: { name: 'Owner', email: 'owner@test.local', password: 'password123' } });
  assert.equal(a.status, 201);
  ownerCookie = a.setCookie.split(';')[0];
  const b = await req('/api/auth/signup', { method: 'POST', body: { name: 'User', email: 'user@test.local', password: 'password123' } });
  assert.equal(b.status, 201);
  userCookie = b.setCookie.split(';')[0];
  audio120 = await uploadMedia(click120, 'click120.mp3', 'audio/mpeg');
  audio90 = await uploadMedia(click90, 'click90.wav', 'audio/wav');
  audio100 = await uploadMedia(tone100, 'tone100.wav', 'audio/wav');
  audioDrone = await uploadMedia(drone, 'drone.wav', 'audio/wav');
  videoMedia = await uploadMedia(clipVideo, 'clip.mp4', 'video/mp4');
});

after(() => {
  if (server) server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Beats within `tol` seconds of every expected burst time.
function assertBeatsNear(beats, expected, tol, label) {
  for (const t of expected) {
    const near = beats.some((b) => Math.abs(b - t) <= tol);
    assert.ok(near, `${label}: no detected beat within ${tol}s of expected beat ${t}s (beats: ${beats.slice(0, 8).join(', ')})`);
  }
}

/* ---------------- Pure sync engine ---------------- */
test('music sync model: cuts, transitions, pulse, markers, strip', () => {
  const tl = blankTimeline('16:9', 30);
  tl.tracks[0].clips.push(defaultClip('video', 1, 0, 4));
  tl.tracks[2].clips.push(defaultClip('text', null, 0, 4));
  const analysis = {
    durationSeconds: 8, bpm: 120, periodSeconds: 0.5,
    beats: [0.45, 0.95, 1.45, 1.95, 2.45, 2.95, 3.45, 3.95],
    downbeats: [0.45, 2.45], drops: [{ t: 3.0, before: 0.3, after: 0.9 }],
    energyCurve: [], waveformPeaks: [], confidence: 0.95, lowConfidence: false,
  };
  const { timeline, report, error } = applyMusicSync(tl, analysis, 7, 'click.mp3', {
    syncMode: 'both', beatDivisor: 2, transition: { type: 'fade', duration: 0.5 },
    pulse: { enabled: true, target: 'text', strength: 0.6 }, volume: 0.8, fitMode: 'loop',
  });
  assert.equal(error, null, error);
  assert.equal(report.cuts, 4);
  assert.equal(report.transitions, 4);
  assert.equal(report.beatsUsed, 4);
  assert.ok(report.pulseKeyframes > 0);
  // Clip starts sit on the (thinned) beat grid.
  const starts = timeline.tracks[0].clips.map((c) => c.start);
  for (const b of [0.45, 1.45, 2.45, 3.45]) {
    assert.ok(starts.some((s) => Math.abs(s - b) < 0.05), `no clip starts near beat ${b} (starts: ${starts.join(', ')})`);
  }
  assert.deepEqual(validateTimeline(timeline), []);
  assert.equal(totalDuration(timeline), 4);
  // Audio clip: looped music, marked as the sync clip.
  const audioClip = timeline.tracks[1].clips[0];
  assert.equal(audioClip.mediaId, 7);
  assert.equal(audioClip.loop, true);
  assert.equal(audioClip.musicSync, true);
  assert.equal(audioClip.duration, 4);
  assert.ok(timeline.markers.some((m) => m.label === 'Drop' && Math.abs(m.t - 3) < 0.05));
  assert.equal(timeline.musicSync.bpm, 120);
  assert.deepEqual(timeline.musicSync.downbeats, [0.45, 2.45]);
  // Beat snap helper.
  assert.equal(snapToBeat(1.42, timeline.musicSync.beats), 1.45);
  assert.equal(snapToBeat(1.30, timeline.musicSync.beats), null);
  assert.equal(snapToBeat(0.5, timeline.musicSync.beats, 0.08), 0.45);
  // Strip removes the sync but keeps the cuts (user can restore the saved version).
  const stripped = stripSync(timeline);
  assert.equal(stripped.tracks[1].clips.length, 0);
  assert.equal(stripped.markers.length, 0);
  assert.equal(stripped.musicSync, undefined);
  assert.equal(stripped.tracks[0].clips.length, 5);
  // Bad options are rejected, never silently applied.
  const bad = applyMusicSync(tl, analysis, 7, 'x.mp3', { syncMode: 'both', beatDivisor: 3 });
  assert.ok(bad.error && bad.error.includes('beatDivisor'));
});

test('music analysis model: silent audio throws, never guesses a BPM', () => {
  const silence = new Float32Array(22050 * 4);
  assert.throws(() => analyzePcm(silence, 22050), /too short|No clear beats/);
});

/* ---------------- API: auth, health ---------------- */
test('music API: anonymous gets 401; health reports Phase 9 / 2.3.1', async () => {
  const anon = await req('/api/music/tracks');
  assert.equal(anon.status, 401);
  const anon2 = await req(`/api/music/tracks/${audio120.id}/analyze`, { method: 'POST' });
  assert.equal(anon2.status, 401);
  const health = await req('/api/health');
  assert.equal(health.json.version, '2.3.1');
  assert.equal(health.json.phase, 9);
});

/* ---------------- API: real analysis ---------------- */
test('analysis: 120 BPM MP3 click track — BPM ±2, beats ±60ms', async () => {
  const r = await req(`/api/music/tracks/${audio120.id}/analyze`, { method: 'POST', cookie: ownerCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.cached, false);
  const a = r.json.analysis;
  assert.ok(Math.abs(a.bpm - 120) <= 2, `BPM ${a.bpm} is not within ±2 of 120`);
  assert.ok(a.confidence >= 0.7, `confidence ${a.confidence} too low for a clean click track`);
  assert.equal(a.waveformPeaks.length, 200);
  assert.ok(a.energyCurve.length >= 7, `energy curve has ${a.energyCurve.length} points`);
  assert.equal(a.method, 'local-dsp');
  const expected = [0.45, 0.95, 1.45, 1.95, 2.45, 2.95, 3.45, 3.95];
  assertBeatsNear(a.beats, expected, 0.06, '120 BPM');
});

test('analysis: 90 BPM WAV click track — BPM ±2, beats ±60ms', async () => {
  const r = await req(`/api/music/tracks/${audio90.id}/analyze`, { method: 'POST', cookie: ownerCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const a = r.json.analysis;
  assert.ok(Math.abs(a.bpm - 90) <= 2, `BPM ${a.bpm} is not within ±2 of 90`);
  assert.ok(a.confidence >= 0.7);
  const expected = [0.6167, 1.2833, 1.95, 2.6167, 3.2833, 3.95, 4.6167, 5.2833];
  assertBeatsNear(a.beats, expected, 0.06, '90 BPM');
});

test('analysis: music-like 100 BPM tone bursts — BPM within ±3', async () => {
  const r = await req(`/api/music/tracks/${audio100.id}/analyze`, { method: 'POST', cookie: ownerCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const a = r.json.analysis;
  assert.ok(Math.abs(a.bpm - 100) <= 3, `BPM ${a.bpm} is not within ±3 of 100`);
  assert.ok(a.beats.length >= 8, `only ${a.beats.length} beats detected`);
});

test('analysis: flat drone refuses instead of guessing a BPM', async () => {
  const r = await req(`/api/music/tracks/${audioDrone.id}/analyze`, { method: 'POST', cookie: ownerCookie });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /No clear beats|too short/i);
});

test('analysis: caching — second analyse is instant and identical', async () => {
  const first = await req(`/api/music/tracks/${audio120.id}/analyze`, { method: 'POST', cookie: ownerCookie });
  assert.equal(first.status, 200);
  assert.equal(first.json.cached, true);
  assert.equal(first.json.analysis.bpm, 120.41);
  const cached = await req(`/api/music/tracks/${audio120.id}/analysis`, { cookie: ownerCookie });
  assert.equal(cached.status, 200);
  assert.equal(cached.json.analysis.bpm, first.json.analysis.bpm);
  assert.deepEqual(cached.json.analysis.beats, first.json.analysis.beats);
});

test('music tracks: per-user isolation + license notes', async () => {
  // The second user cannot see or analyse the owner's track.
  const other = await req(`/api/music/tracks/${audio120.id}/analysis`, { cookie: userCookie });
  assert.equal(other.status, 404);
  const otherAnalyse = await req(`/api/music/tracks/${audio120.id}/analyze`, { method: 'POST', cookie: userCookie });
  assert.equal(otherAnalyse.status, 404);
  const list = await req('/api/music/tracks', { cookie: userCookie });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.tracks, []);
  assert.equal(list.json.licensedOnly, true);
  // License note round-trip.
  const note = 'Licensed from Artlist, 2026 — my own channel use';
  const saved = await req(`/api/music/tracks/${audio120.id}/license`, {
    method: 'PATCH', cookie: ownerCookie, body: { licenseNote: note },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.media.licenseNote, note);
  const list2 = await req('/api/music/tracks', { cookie: ownerCookie });
  const row = list2.json.tracks.find((t) => t.id === audio120.id);
  assert.equal(row.licenseNote, note);
  assert.equal(row.bpm, 120.41);
  // A non-audio file cannot be analysed.
  const bad = await req(`/api/music/tracks/${videoMedia.id}/analyze`, { method: 'POST', cookie: ownerCookie });
  assert.equal(bad.status, 400);
});

/* ---------------- API: apply sync + render ---------------- */
async function makeVideoProject(name, media) {
  const tl = blankTimeline('16:9', 30);
  tl.tracks[0].clips.push(defaultClip('video', (media || videoMedia).id, 0, 4));
  tl.tracks[2].clips.push(defaultClip('text', null, 0, 4));
  const r = await req('/api/projects', {
    method: 'POST', cookie: ownerCookie,
    body: { name, type: 'video', content: { timeline: tl } },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.project;
}

test('apply-sync: cuts + transitions land on real beat times', async () => {
  const project = await makeVideoProject('Sync test — both');
  const r = await req(`/api/music/projects/${project.id}/apply-sync`, {
    method: 'POST', cookie: ownerCookie,
    body: {
      mediaId: audio120.id,
      options: {
        syncMode: 'both', beatDivisor: 2,
        transition: { type: 'fade', duration: 0.5 },
        pulse: { enabled: true, target: 'text', strength: 0.6 },
        volume: 0.8, fitMode: 'loop',
      },
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.report.bpm, 120.41);
  assert.equal(r.json.report.cuts, 4);
  assert.equal(r.json.report.transitions, 4);
  assert.equal(r.json.report.beatsUsed, 4);
  assert.ok(r.json.report.warnings.some((w) => w.includes('shorter than the timeline')));
  const tl = r.json.timeline;
  assert.deepEqual(validateTimeline(tl), []);
  const starts = tl.tracks[0].clips.map((c) => c.start);
  for (const b of [0.45, 1.45, 2.45, 3.45]) {
    assert.ok(starts.some((s) => Math.abs(s - b) < 0.06), `no clip starts near beat ${b} (starts: ${starts.join(', ')})`);
  }
  const faded = tl.tracks[0].clips.filter((c) => c.transition && c.transition.type === 'fade');
  assert.equal(faded.length, 4);
  assert.ok(tl.tracks[2].clips[0].keyframes.length > 0, 'pulse keyframes missing on text clip');
  assert.ok(tl.markers.some((m) => m.label === 'Beat'));
  assert.equal(tl.musicSync.bpm, 120.41);
  // Sync state endpoint + remove.
  const state = await req(`/api/music/projects/${project.id}/sync`, { cookie: ownerCookie });
  assert.equal(state.json.synced, true);
  assert.equal(state.json.musicSync.beats.length, 4);
  const removed = await req(`/api/music/projects/${project.id}/remove-sync`, { method: 'POST', cookie: ownerCookie });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.equal(removed.json.synced, false);
  assert.equal(removed.json.timeline.musicSync, undefined);
  const state2 = await req(`/api/music/projects/${project.id}/sync`, { cookie: ownerCookie });
  assert.equal(state2.json.synced, false);
});

test('apply-sync + render: cut-only sync with looped music renders a real MP4 with audio', async () => {
  // Short 3 s music track, looped to fill the 4 s video. The video itself
  // is silent, so any audio in the render can only be the looped music.
  const shortFile = path.join(tmp, 'click120-short.mp3');
  makeClickTrack(shortFile, 3, 0.5, 'mp3');
  const shortAudio = await uploadMedia(shortFile, 'click120-short.mp3', 'audio/mpeg');
  const silentFile = path.join(tmp, 'silent.mp4');
  makeSilentVideo(silentFile, 4);
  const silentMedia = await uploadMedia(silentFile, 'silent.mp4', 'video/mp4');
  const analysed = await req(`/api/music/tracks/${shortAudio.id}/analyze`, { method: 'POST', cookie: ownerCookie });
  assert.equal(analysed.status, 200, JSON.stringify(analysed.json));
  assert.ok(Math.abs(analysed.json.analysis.bpm - 120) <= 2);

  const project = await makeVideoProject('Sync test — render', silentMedia);
  const synced = await req(`/api/music/projects/${project.id}/apply-sync`, {
    method: 'POST', cookie: ownerCookie,
    body: {
      mediaId: shortAudio.id,
      options: { syncMode: 'cut', beatDivisor: 1, pulse: { enabled: false }, volume: 0.8, fitMode: 'loop' },
    },
  });
  assert.equal(synced.status, 200, JSON.stringify(synced.json));
  assert.equal(synced.json.report.cuts, 6);
  assert.equal(synced.json.report.transitions, 0);
  assert.ok(!synced.json.report.warnings.some((w) => w.includes('shorter than the video')),
    'loop mode must not warn about music ending early');

  const jobRes = await req('/api/video/jobs', {
    method: 'POST', cookie: ownerCookie,
    body: { projectId: project.id, settings: { resolution: '720p', fps: 30 } },
  });
  assert.equal(jobRes.status, 201, JSON.stringify(jobRes.json));
  const job = await waitForJob(jobRes.json.job.id);
  assert.equal(job.status, 'done');
  const dl = await req(`/api/video/jobs/${job.id}/download`, { cookie: ownerCookie });
  assert.equal(dl.status, 200);
  const outFile = path.join(tmp, 'music-render.mp4');
  fs.writeFileSync(outFile, Buffer.from(await fetch(BASE + `/api/video/jobs/${job.id}/download`, { headers: { cookie: ownerCookie } }).then((r) => r.arrayBuffer())));
  const probe = await ffprobe(outFile);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  assert.ok(video, 'rendered file has no video stream');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, 1280);
  assert.ok(audio, 'rendered file has no audio stream — the music was not mixed in');
  assert.ok(Math.abs(probe.format.duration - 4) < 0.75, `rendered duration ${probe.format.duration}s, expected ~4s`);
  // The mixed audio is actually audible (not silence): RMS above the floor.
  // (astats prints its stats at info level, so this probe runs -v info.)
  const stats = await new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-v', 'info', '-i', outFile, '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-'],
      (err, stdout, stderr) => (err ? reject(err) : resolve(stderr)));
  });
  const rmsMatch = String(stats).match(/RMS level dB:\s*(-?[\d.]+)/);
  assert.ok(rmsMatch, 'could not read audio RMS from the render');
  assert.ok(parseFloat(rmsMatch[1]) > -60, `rendered audio is (near) silent: RMS ${rmsMatch[1]} dB`);
});
