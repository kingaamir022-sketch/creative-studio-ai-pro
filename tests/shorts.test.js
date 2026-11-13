'use strict';
// Phase 6 tests — run with: npm test
// Spawns the real server on a scratch port with a temp DB/uploads dir.
// Covers: real local analysis on an FFmpeg-generated video with KNOWN
// structure (scene cuts at 10s/20s, silence 8–12s and 20–24s, tone bursts
// elsewhere), explainable + deterministic ranking, motion-centroid
// reframe, manual-transcript captions (plain/SRT/VTT, word timing,
// ASS burn-in, SRT/VTT export round-trip), STT refusing honestly without
// a key, 9:16 renders (1080x1920, ffprobe-valid, audio present), clip
// review, ZIP export, per-user isolation, anonymous 401. All 84 earlier
// tests must still pass.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const {
  detectScenes, detectSilence, energyCurve, motionCentroid,
  analyseVideo, buildClipCandidates, reframeWindow,
} = require('../src/shorts-analysis');
const {
  parseTimedText, distributePlainText, normaliseCues, wordsForCue,
  toSRT, toVTT, buildAss, cuesForClip,
} = require('../src/captions');
const { buildShortRenderPlan } = require('../src/shorts');
const { probeMedia } = require('../src/ffmpeg');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-shorts-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4837;
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

// 30 s test video with KNOWN structure:
//   video: white 0–10s, black 10–20s, white 20–30s (hard cuts at 10, 20 —
//   white↔black luma difference is large, so scene detection must find them)
//   audio: 440 Hz tone 0–8s, silence 8–12s, tone 12–20s, silence 20–24s,
//   tone 24–30s.
function makeTestVideo(file) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x180:d=10',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=10',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x180:d=10',
    '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*440*t)*(between(t,0,8)+between(t,12,20)+between(t,24,30))':duration=30",
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
    { timeout: 60000 });
}

// 6 s video with motion only on the RIGHT half (left = static black,
// right = moving testsrc). The motion centroid must land on the right.
function makeMotionVideo(file) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x180:d=6',
    '-f', 'lavfi', '-i', 'testsrc=duration=6:size=160x180:rate=30',
    '-filter_complex', '[0:v][1:v]hstack=inputs=2[v]',
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', file],
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

async function waitForAnalysis(jobId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await req(`/api/shorts/jobs/${jobId}`, { cookie: ownerCookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    if (r.json.job.status === 'ready') return r.json;
    if (r.json.job.status === 'failed') throw new Error(`Analysis failed: ${r.json.job.error || ''}`);
    if (Date.now() > deadline) throw new Error(`Analysis did not finish in ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

let testVideo;
let motionVideo;
let videoMedia;
let shortsJobId;

before(async () => {
  testVideo = path.join(tmp, 'long.mp4');
  motionVideo = path.join(tmp, 'motion.mp4');
  makeTestVideo(testVideo);
  makeMotionVideo(motionVideo);
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
  videoMedia = await uploadMedia(testVideo, 'long.mp4', 'video/mp4');
});

after(() => {
  if (server) server.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ---------- Pure analysis: known structure ---------- */

test('analysis: scene cuts at 10s and 20s are found within tolerance', async () => {
  const scenes = await detectScenes(testVideo, 0.35);
  const times = scenes.map((s) => s.time);
  assert.ok(times.some((t) => Math.abs(t - 10) <= 0.6), `no scene near 10s: ${JSON.stringify(times)}`);
  assert.ok(times.some((t) => Math.abs(t - 20) <= 0.6), `no scene near 20s: ${JSON.stringify(times)}`);
});

test('analysis: silence windows 8-12s and 20-24s are found within tolerance', async () => {
  const sil = await detectSilence(testVideo, -35, 0.5);
  assert.ok(sil.some((s) => Math.abs(s.start - 8) <= 0.7 && Math.abs(s.end - 12) <= 0.7),
    `no silence near 8-12s: ${JSON.stringify(sil)}`);
  assert.ok(sil.some((s) => Math.abs(s.start - 20) <= 0.7 && Math.abs(s.end - 24) <= 0.7),
    `no silence near 20-24s: ${JSON.stringify(sil)}`);
});

test('analysis: energy curve is high on tone, ~zero in silence', async () => {
  const e = await energyCurve(testVideo, 0.5);
  assert.ok(e.hasAudio);
  assert.equal(e.rms.length, 60); // 30 s / 0.5 s windows
  const toneMean = e.rms.slice(0, 16).reduce((a, b) => a + b, 0) / 16;
  const silenceMean = e.rms.slice(16, 24).reduce((a, b) => a + b, 0) / 8;
  assert.ok(toneMean > 0.8, `tone energy too low: ${toneMean}`);
  assert.ok(silenceMean < 0.05, `silence energy too high: ${silenceMean}`);
});

test('ranking: deterministic, explainable, breakdown sums to score', async () => {
  const analysis = await analyseVideo(testVideo);
  const opts = { minClipSeconds: 8, maxClipSeconds: 20, maxClips: 10 };
  const once = buildClipCandidates(analysis, opts);
  const twice = buildClipCandidates(analysis, opts);
  assert.deepEqual(once, twice, 'ranking must be deterministic');
  assert.ok(once.length >= 1, 'at least one candidate');
  for (const c of once) {
    assert.ok(c.start >= 0 && c.end <= 30.001 && c.end > c.start, `invalid timestamps ${c.start}-${c.end}`);
    assert.ok(c.end - c.start >= 8 - 0.01 && c.end - c.start <= 20 + 0.01, `clip length out of bounds: ${c.end - c.start}`);
    const b = c.breakdown;
    const expected = Math.round(100 * (0.45 * b.speechDensity + 0.30 * b.energy + 0.15 * b.sceneRate + 0.10 * b.position));
    assert.ok(Math.abs(expected - c.score) <= 1, `score ${c.score} != breakdown sum ${expected}`);
  }
  for (let i = 1; i < once.length; i++) assert.ok(once[i].score <= once[i - 1].score, 'clips must be ranked by score desc');
});

test('reframe: motion centroid lands on the moving half; crop stays in frame', async () => {
  const mc = await motionCentroid(motionVideo, 0, 6);
  assert.ok(mc !== null, 'motion should be detected');
  assert.ok(mc > 0.55 && mc <= 1, `centroid should be on the right half, got ${mc}`);
  const w = reframeWindow(1920, 1080, 0.5, 1080, 1920);
  assert.equal(w.cropW, 608); // 1080 * 9/16 = 607.5 -> 608 (even)
  assert.equal(w.cropH, 1080);
  assert.equal(w.cropX, 656); // centred: 0.5*1920 - 304
  const left = reframeWindow(1920, 1080, 0, 1080, 1920);
  assert.equal(left.cropX, 0);
  const right = reframeWindow(1920, 1080, 1, 1080, 1920);
  assert.equal(right.cropX, 1920 - 608);
  assert.ok(right.cropX + right.cropW <= 1920, 'crop window must stay inside the frame');
});

/* ---------- Pure captions ---------- */

test('captions: SRT parse + export round-trips; plain text gets estimated timing', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,500\nHello world\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line here\n';
  const { cues, errors } = parseTimedText(srt, 'srt');
  assert.equal(errors.length, 0);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 3.5);
  const back = toSRT(cues);
  const again = parseTimedText(back, 'srt');
  assert.deepEqual(again.cues, cues, 'SRT export must round-trip');
  const vtt = toVTT(cues);
  assert.ok(vtt.startsWith('WEBVTT'));
  const vttBack = parseTimedText(vtt, 'vtt');
  assert.equal(vttBack.cues.length, 2);
  assert.equal(vttBack.cues[1].text, 'Second line here');

  const plain = distributePlainText('First sentence here.\nSecond sentence here.', 10);
  assert.equal(plain.length, 2);
  assert.ok(plain[0].start === 0 && plain[1].end <= 10.01, 'plain text must spread across the duration');
  const words = wordsForCue({ start: 0, end: 4, text: 'one two three' });
  assert.equal(words.length, 3);
  assert.ok(words[0].start === 0 && words[2].end === 4, 'words must cover the whole cue');
  assert.ok(words[0].end <= words[1].start && words[1].end <= words[2].start, 'words must not overlap');

  const ass = buildAss(cues, { language: 'en', outWidth: 1080, outHeight: 1920 });
  assert.ok(ass.includes('[Script Info]') && ass.includes('Dialogue:'));
  assert.ok(ass.includes('{\\k'), 'word-by-word karaoke tags must be present');
  const assAr = buildAss(cues, { language: 'ar', outWidth: 1080, outHeight: 1920 });
  assert.ok(assAr.includes('Noto Naskh Arabic'), 'Arabic captions must use an Arabic font');
  const clipped = cuesForClip(cues, 2, 5);
  assert.equal(clipped.length, 2);
  assert.equal(clipped[0].start, 0, 'clip-relative times must start at 0');
  assert.equal(clipped[1].end, 3, 'cues are trimmed to the clip window');
});

test('captions: normaliseCues clamps, sorts and trims overlaps', () => {
  const { cues, warnings } = normaliseCues([
    { start: 5, end: 8, text: 'second' },
    { start: 0, end: 6, text: 'first overlaps' },
    { start: 40, end: 50, text: 'outside' },
    { start: 9, end: 9, text: 'zero length' },
    { start: 10, end: 12, text: '' },
  ], 30);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'first overlaps');
  assert.ok(cues[0].end <= cues[1].start, 'overlaps must be trimmed');
  assert.ok(warnings.length >= 2, 'warnings must explain what was dropped/trimmed');
});

/* ---------- API: jobs, transcripts, review ---------- */

test('shorts API: anonymous gets 401; health reports Phase 9 / 2.2.0', async () => {
  const anon = await req('/api/shorts/jobs');
  assert.equal(anon.status, 401);
  const h = await req('/api/health');
  assert.equal(h.json.version, '2.2.0');
  assert.equal(h.json.phase, 9);
});

test('shorts API: analyse finds candidates with valid timestamps', async () => {
  const created = await req('/api/shorts/jobs', {
    method: 'POST', cookie: ownerCookie,
    body: { mediaId: videoMedia.id, settings: { minClipSeconds: 8, maxClipSeconds: 20, maxClips: 10 }, language: 'en' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  shortsJobId = created.json.job.id;
  const detail = await waitForAnalysis(shortsJobId);
  assert.equal(detail.job.status, 'ready');
  assert.ok(detail.clips.length >= 1, 'expected at least one candidate');
  for (const c of detail.clips) {
    assert.ok(c.start >= 0 && c.end <= 30.01 && c.end > c.start, `bad clip ${c.start}-${c.end}`);
    assert.ok(c.end - c.start >= 8 - 0.01 && c.end - c.start <= 20 + 0.01);
    assert.ok(c.score >= 0 && c.score <= 100);
    assert.ok(c.breakdown && typeof c.breakdown.speechDensity === 'number');
    assert.ok(c.motionX === null || (c.motionX >= 0 && c.motionX <= 1));
  }
  const scores = detail.clips.map((c) => c.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'clips must be score-ranked');
});

test('shorts API: STT without a key refuses honestly, no fake transcript', async () => {
  const r = await req(`/api/shorts/jobs/${shortsJobId}/transcribe`, { method: 'POST', cookie: ownerCookie, body: {} });
  assert.equal(r.status, 402, JSON.stringify(r.json));
  assert.equal(r.json.code, 'PROVIDER_KEY_NEEDED');
  const after = await req(`/api/shorts/jobs/${shortsJobId}`, { cookie: ownerCookie });
  assert.equal(after.json.job.transcript, null, 'no transcript must be created by a refused STT call');
});

test('shorts API: manual transcript (plain + SRT) saves, exports round-trip', async () => {
  const plain = await req(`/api/shorts/jobs/${shortsJobId}/transcript`, {
    method: 'POST', cookie: ownerCookie,
    body: { format: 'text', language: 'en', text: 'Welcome to the video.\nThis is the second line of the transcript.' },
  });
  assert.equal(plain.status, 200, JSON.stringify(plain.json));
  assert.equal(plain.json.timing, 'estimated');
  assert.ok(plain.json.cues >= 2);
  assert.ok((plain.json.warnings || []).some((w) => /estimated/i.test(w)), 'estimated timing must be labelled');

  const srtText = '1\n00:00:01,000 --> 00:00:04,000\nHello from the short\n\n2\n00:00:05,000 --> 00:00:09,000\nSecond caption line\n';
  const srt = await req(`/api/shorts/jobs/${shortsJobId}/transcript`, {
    method: 'POST', cookie: ownerCookie,
    body: { format: 'srt', language: 'en', text: srtText },
  });
  assert.equal(srt.status, 200, JSON.stringify(srt.json));
  assert.equal(srt.json.timing, 'exact');
  assert.equal(srt.json.cues, 2);

  const exp = await req(`/api/shorts/jobs/${shortsJobId}/captions.srt`, { cookie: ownerCookie });
  assert.equal(exp.status, 200);
  assert.ok(exp.text.includes('Hello from the short'));
  const reparsed = parseTimedText(exp.text, 'srt');
  assert.equal(reparsed.cues.length, 2);
  const vtt = await req(`/api/shorts/jobs/${shortsJobId}/captions.vtt`, { cookie: ownerCookie });
  assert.equal(vtt.status, 200);
  assert.ok(vtt.text.startsWith('WEBVTT'));

  const detail = await req(`/api/shorts/jobs/${shortsJobId}`, { cookie: ownerCookie });
  assert.ok(detail.json.clips.some((c) => c.captionStatus === 'ready'), 'clips overlapping cues must report captions ready');
});

test('shorts API: per-user isolation; other user gets 404', async () => {
  const r = await req(`/api/shorts/jobs/${shortsJobId}`, { cookie: userCookie });
  assert.equal(r.status, 404);
  const mine = await req(`/api/shorts/jobs/${shortsJobId}`, { cookie: ownerCookie });
  assert.equal(mine.status, 200);
});

/* ---------- E2E render: 1080x1920 with captions ---------- */

test('shorts e2e: approved clip renders 1080x1920 with audio + captions', async () => {
  // Render plan (pure): 1080p from a 1920x1080 source crops 608x1080.
  const plan = await buildShortRenderPlan({
    mediaFile: testVideo,
    probe: { width: 1920, height: 1080, fps: 30, hasAudio: true },
    clip: { start_s: 0, end_s: 10, motion_x: 0.5 },
    transcript: { cues: [{ start: 1, end: 4, text: 'Hello from the short' }], language: 'en' },
    resolution: '1080p',
    tmpDir: path.join(tmp, 'plan-tmp'),
  });
  assert.equal(plan.expected.width, 1080);
  assert.equal(plan.expected.height, 1920);
  assert.equal(plan.cuesUsed, 1);
  assert.ok(plan.args.join(' ').includes('subtitles='), 'captions must be burned in via the subtitles filter');
  assert.ok(fs.existsSync(plan.assPath), 'ASS file must be written for the render');
  const assText = fs.readFileSync(plan.assPath, 'utf8');
  // Words are split by karaoke {\k…} tags, so check per word, not the phrase.
  for (const w of ['Hello', 'from', 'the', 'short']) assert.ok(assText.includes(w), `ASS must contain word "${w}"`);

  // Real render through the API + job queue.
  const detail = await req(`/api/shorts/jobs/${shortsJobId}`, { cookie: ownerCookie });
  const clip = detail.json.clips.find((c) => c.status === 'candidate' || c.status === 'approved');
  assert.ok(clip, 'expected a renderable clip');
  const patched = await req(`/api/shorts/jobs/${shortsJobId}/clips/${clip.id}`, {
    method: 'PATCH', cookie: ownerCookie, body: { status: 'approved' },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  const rendered = await req(`/api/shorts/jobs/${shortsJobId}/render`, {
    method: 'POST', cookie: ownerCookie, body: { clipIds: [clip.id], resolution: '1080p' },
  });
  assert.equal(rendered.status, 201, JSON.stringify(rendered.json));
  const jobId = rendered.json.jobs[0].jobId;
  const doneJob = await waitForJob(jobId, 180000);
  assert.equal(doneJob.status, 'done');
  assert.ok(doneJob.hasOutput, 'rendered job must report an output');
  // Verify the finished file through the clip download endpoint (the job
  // API deliberately does not expose server paths).
  const dlPath = path.join(tmp, 'downloaded-short.mp4');
  const dlRes = await fetch(`${BASE}/api/shorts/jobs/${shortsJobId}/clips/${clip.id}/download`, { headers: { cookie: ownerCookie } });
  assert.equal(dlRes.status, 200);
  fs.writeFileSync(dlPath, Buffer.from(await dlRes.arrayBuffer()));
  assert.ok(fs.existsSync(dlPath) && fs.statSync(dlPath).size > 0, 'downloaded Short must exist and be non-empty');
  const outPath = dlPath;
  const info = await ffprobe(outPath);
  const video = info.streams.find((s) => s.codec_type === 'video');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.equal(video.codec_name, 'h264');
  assert.ok(audio, 'rendered Short must keep the source audio');
  assert.ok(Math.abs(parseFloat(info.format.duration) - (clip.end - clip.start)) <= 0.75,
    `duration ${info.format.duration} should match clip length ${clip.end - clip.start}`);

  // Thumbnail + ZIP all serve real files (download already verified above).
  const thumb = await req(`/api/shorts/jobs/${shortsJobId}/clips/${clip.id}/thumbnail`, { cookie: ownerCookie });
  assert.equal(thumb.status, 200);
  const zip = await req(`/api/shorts/jobs/${shortsJobId}/zip`, { cookie: ownerCookie });
  assert.equal(zip.status, 200);
});
