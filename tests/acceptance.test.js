'use strict';
// Phase 10 — Final QA acceptance tests (A–D). Run with: npm test
// Spawns the real server on a scratch port (4840) with a temp DB/uploads dir.
//   A: Bulk Video end-to-end on 10 UNIQUE rows (the full 100-row run lives in
//      scripts/acceptance-a.js — 100 sequential 1 s renders are too slow for
//      the suite, and the script asserts exactly the same things).
//   B: Music Sync re-verified: cuts/transitions land on real beat times and
//      a synced render carries audible mixed music.
//   C: Long Video to Shorts re-verified on the known-structure 30 s video:
//      valid ranked in-bounds clips, approved clip renders 1080x1920 with
//      audio + burned-in captions. A full 60-minute video was NOT rendered
//      end-to-end (same pipeline; see docs/FEATURE_COMPLETION.md).
//   D: Graphic Design round-trip: save -> close -> reopen, byte-identical.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { blankTimeline, defaultClip, validateTimeline } = require('../src/video-model');
const { buildRowTimeline } = require('../src/bulk-model');
const { blankDesign, defaultTextLayer, defaultShapeLayer, defaultImageLayer } = require('../src/design-model');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-acceptance-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4840;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let ownerCookie = '';
let ownerId = '';

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
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', file],
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
}

function makeTestImage(file, color) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:d=1`, '-frames:v', '1', file],
    { timeout: 30000 });
}

function makeTestVideo(file, seconds, tone) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x180:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
    { timeout: 60000 });
}

function makeSilentVideo(file, seconds) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x180:rate=30`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', file],
    { timeout: 60000 });
}

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

// 30 s video with KNOWN structure (same as tests/shorts.test.js):
// video white 0-10s, black 10-20s, white 20-30s; audio tone 0-8s,
// silence 8-12s, tone 12-20s, silence 20-24s, tone 24-30s.
function makeKnownVideo(file) {
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

function readPixel(file, time, x, y) {
  const out = execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(time), '-i', file,
    '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { timeout: 30000, maxBuffer: 1024 * 1024 });
  return [out[0], out[1], out[2]];
}

function countNearWhitePixels(file, time, y) {
  // Counts near-white pixels along a horizontal strip — the white centred
  // product text must show up against every solid-colour background used.
  // drawtext's y is the TOP of the glyphs, so sample a small vertical band
  // around the given row and take the best row (a single row at the very
  // top edge of the text barely touches any glyph).
  let best = 0;
  for (const yy of [y - 12, y, y + 12]) {
    let count = 0;
    for (let x = 100; x <= 1180; x += 20) {
      const [r, g, b] = readPixel(file, time, x, yy);
      if (r > 200 && g > 200 && b > 200) count++;
    }
    best = Math.max(best, count);
  }
  return best;
}

async function uploadMedia(file, name, mime) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime }), name);
  const r = await req('/api/media/upload', { method: 'POST', cookie: ownerCookie, form });
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
    await new Promise((x) => setTimeout(x, 1000));
  }
}

async function waitForBulkJob(jobId, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const r = await req(`/api/bulk/${jobId}`, { cookie: ownerCookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    last = r.json;
    if (['done', 'partial', 'failed', 'cancelled'].includes(last.job.status)) return last;
    if (Date.now() > deadline) throw new Error(`bulk job ${jobId} did not finish; last ${JSON.stringify(last.job)}`);
    await new Promise((x) => setTimeout(x, 700));
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
    await new Promise((x) => setTimeout(x, 1500));
  }
}

before(async () => {
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
  assert.equal(a.status, 201, JSON.stringify(a.json));
  ownerCookie = a.setCookie.split(';')[0];
  const users = await req('/api/admin/users', { cookie: ownerCookie });
  assert.equal(users.status, 200, JSON.stringify(users.json));
  ownerId = users.json.users.find((u) => u.email === 'owner@test.local').id;
  // Acceptance runs burn real credits (1 per bulk row / render); a fresh
  // Free account only starts with 100, so top the owner up first.
  const reset = await req(`/api/admin/users/${ownerId}/reset-credits`, { method: 'POST', cookie: ownerCookie, body: { credits: 10000 } });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
});

after(() => {
  if (server) server.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('health reports Phase 14 / 2.7.1', async () => {
  const h = await req('/api/health');
  assert.equal(h.json.version, '2.7.1');
  assert.equal(h.json.phase, 14);
});

/* ---------- A (suite scale): 10 unique rows, real MP4s ---------- */

test('A (suite): 10 unique rows -> 10 MP4s, ffprobe-valid, all backgrounds different, logo positioned, row text present', async () => {
  // 10 visually distinct solid-colour backgrounds + one magenta logo.
  const colours = ['red', 'lime', 'blue', 'yellow', 'cyan', 'orange', 'teal', 'navy', 'olive', 'maroon'];
  const bgIds = [];
  for (const c of colours) {
    const f = path.join(tmp, `bg-${c}.png`);
    makeTestImage(f, c);
    bgIds.push((await uploadMedia(f, `bg-${c}.png`, 'image/png')).id);
  }
  const logoFile = path.join(tmp, 'logo-magenta.png');
  makeTestImage(logoFile, 'magenta');
  const logo = await uploadMedia(logoFile, 'logo.png', 'image/png');

  // Template: background clip + centred {{PRODUCT_NAME}} text + logo overlay
  // pinned top-left via a keyframe (x 5%, y 5%).
  const tl = blankTimeline('16:9', 30);
  const bg = defaultClip('video', bgIds[0], 0, 1);
  bg.name = 'Background';
  bg.isBackground = true;
  const tx = defaultClip('text', null, 0, 1);
  tx.text = { ...tx.text, text: '{{PRODUCT_NAME}} — {{PRODUCT_PRICE}}', fontSize: 48, align: 'center' };
  const logoClip = defaultClip('video', logo.id, 0, 1);
  logoClip.name = 'Logo';
  logoClip.keyframes = [{ t: 0, x: 5, y: 5, scale: 1, opacity: 1 }];
  // The logo overlay lives on the second video track (the render engine's
  // PiP overlay track). It must be a 'video'-kind clip: the validator only
  // allows video/audio/text track kinds, and the renderer detects image
  // media by the media's kind, not the clip's. (An earlier draft put the
  // logo on tracks[1] — the audio track — which fails validation.)
  tl.tracks.splice(1, 0, { id: 'track-overlay', kind: 'video', name: 'Overlay', locked: false, muted: false, clips: [] });
  tl.tracks[0].clips.push(bg);
  tl.tracks[1].clips.push(logoClip);
  tl.tracks[3].clips.push(tx);
  assert.deepEqual(validateTimeline(tl), [], 'acceptance template must validate');

  const created = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'Acceptance Template', type: 'video', content: { timeline: tl } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const templateId = created.json.project.id;

  const rows = Array.from({ length: 10 }, (_, i) => ({
    PRODUCT_NAME: `Product ${String(i + 1).padStart(2, '0')} Deluxe`,
    PRODUCT_PRICE: `Rs ${(1000 + i * 137).toLocaleString('en-US')}`,
  }));
  const csv = 'PRODUCT_NAME,PRODUCT_PRICE\n' + rows.map((r) => `${r.PRODUCT_NAME},${r.PRODUCT_PRICE}`).join('\n');
  const jobRes = await req('/api/bulk', { method: 'POST', cookie: ownerCookie, body: { name: 'Acceptance A (10 rows)', kind: 'video', templateProjectId: templateId } });
  assert.equal(jobRes.status, 201, JSON.stringify(jobRes.json));
  const jobId = jobRes.json.job.id;
  const ds = await req(`/api/bulk/${jobId}/dataset`, { method: 'POST', cookie: ownerCookie, body: { text: csv } });
  assert.equal(ds.status, 200, JSON.stringify(ds.json));
  assert.equal(ds.json.dedupeSummary.unique, 10, 'all 10 rows must be unique (no duplicates in this run)');
  assert.equal(ds.json.dedupeSummary.skipped, 0);
  const patch = await req(`/api/bulk/${jobId}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { fieldMapping: { PRODUCT_NAME: 'PRODUCT_NAME', PRODUCT_PRICE: 'PRODUCT_PRICE' }, background: { mode: 'random', poolMediaIds: bgIds, repeatRule: 'no-repeat' } } } });
  assert.equal(patch.status, 200, JSON.stringify(patch.json));
  const assigned = await req(`/api/bulk/${jobId}/assign`, { method: 'POST', cookie: ownerCookie });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.json));

  // Row-data correctness at the substitution level: every row's text is its
  // own product name + price (the render then burns exactly this text in).
  for (let i = 0; i < rows.length; i++) {
    const built = buildRowTimeline(tl, rows[i], { fieldMapping: { PRODUCT_NAME: 'PRODUCT_NAME', PRODUCT_PRICE: 'PRODUCT_PRICE' } });
    const clip = built.timeline.tracks[3].clips[0];
    assert.ok(clip.text.text.includes(rows[i].PRODUCT_NAME), `row ${i + 1} text must carry its product name`);
    assert.ok(clip.text.text.includes(rows[i].PRODUCT_PRICE), `row ${i + 1} text must carry its price`);
  }

  const start = await req(`/api/bulk/${jobId}/start`, { method: 'POST', cookie: ownerCookie });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const finished = await waitForBulkJob(jobId);
  assert.equal(finished.job.status, 'done', `job finished as ${finished.job.status}; rows: ${JSON.stringify(finished.rows.map((r) => [r.rowNumber, r.status, r.error]))}`);
  assert.equal(finished.job.rowsDone, 10);
  assert.equal(finished.job.rowsFailed, 0);
  const done = finished.rows.filter((r) => r.status === 'done');
  assert.equal(done.length, 10);
  assert.equal(new Set(done.map((r) => r.backgroundMediaId)).size, 10, 'all 10 rows used a different background (no-repeat)');

  const hashes = [];
  for (const r of done) {
    // connection: close on every download: the pixel/ffprobe checks between
    // downloads take far longer than the server's 5 s keep-alive timeout,
    // and reusing the dead pooled socket fails mid-body (UND_ERR_SOCKET).
    const dl = await fetch(BASE + `/api/bulk/${jobId}/rows/${r.id}/download`, { headers: { cookie: ownerCookie, connection: 'close' }, redirect: 'manual' });
    assert.equal(dl.status, 200, `download row ${r.rowNumber}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.ok(buf.length > 1000, `row ${r.rowNumber} MP4 is a real file`);
    const outFile = path.join(tmp, `acc-a-row-${r.rowNumber}.mp4`);
    fs.writeFileSync(outFile, buf);
    const probe = await ffprobe(outFile);
    const video = probe.streams.find((s) => s.codec_type === 'video');
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.width, 1280);
    assert.equal(video.height, 720);
    assert.ok(Math.abs(parseFloat(probe.format.duration) - 1) < 0.75, `row ${r.rowNumber} duration ${probe.format.duration}, expected ~1s`);
    hashes.push(crypto.createHash('sha256').update(buf).digest('hex'));
    // Logo check on the first and a middle row: the overlay is 384x216 at
    // (45, 25), so its centre (237, 133) must be magenta, not the background.
    if (r.rowNumber === 1 || r.rowNumber === 5) {
      const [lr, lg, lb] = readPixel(outFile, 0.5, 237, 133);
      assert.ok(lr > 200 && lg < 80 && lb > 200, `row ${r.rowNumber} logo pixel should be magenta, got [${lr},${lg},${lb}]`);
      // Row text check: white centred text must appear on the middle strip
      // (y=380 is mid-glyph: drawtext y=360 is the TOP of the glyphs).
      const white = countNearWhitePixels(outFile, 0.5, 380);
      assert.ok(white >= 5, `row ${r.rowNumber} should show white product text (found ${white} near-white samples)`);
    }
  }
  assert.equal(new Set(hashes).size, 10, 'all 10 outputs differ (different backgrounds/text)');
});

/* ---------- B: Music Sync ---------- */

test('B: cuts + transitions land on real beat times; synced render carries audible music', async () => {
  const clickFile = path.join(tmp, 'click120.mp3');
  makeClickTrack(clickFile, 8, 0.5, 'mp3');
  const audio120 = await uploadMedia(clickFile, 'click120.mp3', 'audio/mpeg');
  const analysed = await req(`/api/music/tracks/${audio120.id}/analyze`, { method: 'POST', cookie: ownerCookie });
  assert.equal(analysed.status, 200, JSON.stringify(analysed.json));
  assert.ok(Math.abs(analysed.json.analysis.bpm - 120) <= 2, `BPM ${analysed.json.analysis.bpm}, expected ~120`);

  const vidFile = path.join(tmp, 'sync-video.mp4');
  makeTestVideo(vidFile, 4, 440);
  const videoMedia = await uploadMedia(vidFile, 'sync-video.mp4', 'video/mp4');
  const tl = blankTimeline('16:9', 30);
  tl.tracks[0].clips.push(defaultClip('video', videoMedia.id, 0, 4));
  tl.tracks[2].clips.push(defaultClip('text', null, 0, 4));
  const proj = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'Acceptance B', type: 'video', content: { timeline: tl } } });
  assert.equal(proj.status, 201, JSON.stringify(proj.json));
  const projectId = proj.json.project.id;

  const synced = await req(`/api/music/projects/${projectId}/apply-sync`, {
    method: 'POST', cookie: ownerCookie,
    body: { mediaId: audio120.id, options: { syncMode: 'both', beatDivisor: 2, transition: { type: 'fade', duration: 0.5 }, pulse: { enabled: true, target: 'text', strength: 0.6 }, volume: 0.8, fitMode: 'loop' } },
  });
  assert.equal(synced.status, 200, JSON.stringify(synced.json));
  assert.equal(synced.json.report.bpm, 120.41);
  assert.equal(synced.json.report.cuts, 4);
  assert.equal(synced.json.report.transitions, 4);
  const starts = synced.json.timeline.tracks[0].clips.map((c) => c.start);
  for (const b of [0.45, 1.45, 2.45, 3.45]) {
    assert.ok(starts.some((s) => Math.abs(s - b) < 0.06), `no clip starts near beat ${b} (starts: ${starts.join(', ')})`);
  }

  // Render proof: silent video + short looped click track — any audio in the
  // output can only be the mixed music, and it must be audible.
  const shortFile = path.join(tmp, 'click120-short.mp3');
  makeClickTrack(shortFile, 3, 0.5, 'mp3');
  const shortAudio = await uploadMedia(shortFile, 'click120-short.mp3', 'audio/mpeg');
  const silentFile = path.join(tmp, 'silent.mp4');
  makeSilentVideo(silentFile, 4);
  const silentMedia = await uploadMedia(silentFile, 'silent.mp4', 'video/mp4');
  const tl2 = blankTimeline('16:9', 30);
  tl2.tracks[0].clips.push(defaultClip('video', silentMedia.id, 0, 4));
  tl2.tracks[2].clips.push(defaultClip('text', null, 0, 4));
  const proj2 = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'Acceptance B render', type: 'video', content: { timeline: tl2 } } });
  assert.equal(proj2.status, 201, JSON.stringify(proj2.json));
  const synced2 = await req(`/api/music/projects/${proj2.json.project.id}/apply-sync`, {
    method: 'POST', cookie: ownerCookie,
    body: { mediaId: shortAudio.id, options: { syncMode: 'cut', beatDivisor: 1, pulse: { enabled: false }, volume: 0.8, fitMode: 'loop' } },
  });
  assert.equal(synced2.status, 200, JSON.stringify(synced2.json));
  const jobRes = await req('/api/video/jobs', { method: 'POST', cookie: ownerCookie, body: { projectId: proj2.json.project.id, settings: { resolution: '720p', fps: 30 } } });
  assert.equal(jobRes.status, 201, JSON.stringify(jobRes.json));
  const job = await waitForJob(jobRes.json.job.id);
  assert.equal(job.status, 'done');
  const outFile = path.join(tmp, 'acc-b-render.mp4');
  fs.writeFileSync(outFile, Buffer.from(await fetch(BASE + `/api/video/jobs/${job.id}/download`, { headers: { cookie: ownerCookie, connection: 'close' } }).then((r) => r.arrayBuffer())));
  const probe = await ffprobe(outFile);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  assert.ok(video && video.codec_name === 'h264', 'synced render must have h264 video');
  assert.ok(audio, 'synced render must have an audio stream — the music was not mixed in');
  assert.ok(Math.abs(parseFloat(probe.format.duration) - 4) < 0.75, `duration ${probe.format.duration}, expected ~4s`);
  const stats = await new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-v', 'info', '-i', outFile, '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-'],
      (err, stdout, stderr) => (err ? reject(err) : resolve(stderr)));
  });
  const rmsMatch = String(stats).match(/RMS level dB:\s*(-?[\d.]+)/);
  assert.ok(rmsMatch, 'could not read audio RMS from the render');
  assert.ok(parseFloat(rmsMatch[1]) > -60, `rendered audio is (near) silent: RMS ${rmsMatch[1]} dB`);
});

/* ---------- C: Long Video to Shorts ---------- */

test('C: known-structure video -> valid ranked clips; approved clip renders 1080x1920 with audio + captions', async () => {
  const knownFile = path.join(tmp, 'known30.mp4');
  makeKnownVideo(knownFile);
  const videoMedia = await uploadMedia(knownFile, 'known30.mp4', 'video/mp4');
  const created = await req('/api/shorts/jobs', {
    method: 'POST', cookie: ownerCookie,
    body: { mediaId: videoMedia.id, settings: { minClipSeconds: 8, maxClipSeconds: 20, maxClips: 10 }, language: 'en' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const shortsJobId = created.json.job.id;
  const detail = await waitForAnalysis(shortsJobId);
  assert.equal(detail.job.status, 'ready');
  assert.ok(detail.clips.length >= 1, 'expected at least one candidate clip');
  for (const c of detail.clips) {
    assert.ok(c.start >= 0 && c.end <= 30.01 && c.end > c.start, `bad clip ${c.start}-${c.end}`);
    assert.ok(c.end - c.start >= 8 - 0.01 && c.end - c.start <= 20 + 0.01, `clip length ${c.end - c.start} out of 8-20s bounds`);
    assert.ok(c.score >= 0 && c.score <= 100, 'score must be 0-100');
    assert.ok(c.breakdown && typeof c.breakdown.speechDensity === 'number', 'clip must carry an explainable breakdown');
  }
  const scores = detail.clips.map((c) => c.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'clips must be score-ranked');

  const srtText = '1\n00:00:01,000 --> 00:00:04,000\nHello from the short\n\n2\n00:00:05,000 --> 00:00:09,000\nSecond caption line\n';
  const srt = await req(`/api/shorts/jobs/${shortsJobId}/transcript`, {
    method: 'POST', cookie: ownerCookie, body: { format: 'srt', language: 'en', text: srtText },
  });
  assert.equal(srt.status, 200, JSON.stringify(srt.json));
  assert.equal(srt.json.timing, 'exact');

  const clip = detail.clips[0];
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
  const dlPath = path.join(tmp, 'acc-c-short.mp4');
  const dlRes = await fetch(`${BASE}/api/shorts/jobs/${shortsJobId}/clips/${clip.id}/download`, { headers: { cookie: ownerCookie, connection: 'close' } });
  assert.equal(dlRes.status, 200);
  fs.writeFileSync(dlPath, Buffer.from(await dlRes.arrayBuffer()));
  const info = await ffprobe(dlPath);
  const video = info.streams.find((s) => s.codec_type === 'video');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.equal(video.codec_name, 'h264');
  assert.ok(audio, 'rendered Short must keep the source audio');
  assert.ok(Math.abs(parseFloat(info.format.duration) - (clip.end - clip.start)) <= 0.75,
    `duration ${info.format.duration} should match clip length ${clip.end - clip.start}`);
});

/* ---------- D: Graphic Design round-trip ---------- */

test('D: design save -> close -> reopen, every layer preserved byte-for-byte', async () => {
  const logoFile = path.join(tmp, 'design-logo.png');
  makeTestImage(logoFile, 'magenta');
  const logoMedia = await uploadMedia(logoFile, 'design-logo.png', 'image/png');

  const design = blankDesign(1080, 1080);
  design.background = { type: 'gradient', color: '#7c5cff', gradient: { from: '#111832', to: '#7c5cff', angle: 45 } };
  const groupId = 'grp_acc_d_1';
  const headline = defaultTextLayer(90, 120, 'Round Trip', { fontSize: 96 });
  headline.text.shadow = { color: '#000000', blur: 6, offsetX: 2, offsetY: 2 };
  headline.groupId = groupId;
  const shape = defaultShapeLayer('rect', 90, 300, 400, 120, { fill: '#22d3ee', radius: 20 });
  shape.groupId = groupId;
  const img = defaultImageLayer(600, 300, 300, 300, `/api/media/${logoMedia.id}/file`, logoMedia.id);
  img.image.filters = { grayscale: 20, sepia: 10, brightness: 110, contrast: 105, saturate: 90 };
  img.image.crop = { left: 5, top: 5, right: 5, bottom: 5 };
  img.image.flipH = true;
  design.layers = [headline, shape, img];

  const created = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'Acceptance D Design', type: 'design', content: design } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const pid = created.json.project.id;

  // Simulate an edit + autosave, then "close" (no further calls) and reopen.
  design.layers[0].text.text = 'Round Trip (edited)';
  design.layers.push(defaultTextLayer(90, 900, 'Footer note', { fontSize: 28 }));
  const saved = await req(`/api/projects/${pid}`, { method: 'PATCH', cookie: ownerCookie, body: { content: design, saveVersion: true } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));

  const reopened = await req(`/api/projects/${pid}`, { cookie: ownerCookie });
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.json.project.content, design, 'reopened design must match exactly what was saved');
  assert.equal(reopened.json.project.content.layers[0].text.text, 'Round Trip (edited)');
  assert.equal(reopened.json.project.content.layers[2].image.filters.grayscale, 20);
  assert.equal(reopened.json.project.content.layers[2].image.crop.left, 5);
  assert.equal(reopened.json.project.content.layers[2].image.flipH, true);
  assert.equal(reopened.json.project.content.layers[0].groupId, 'grp_acc_d_1');
  assert.equal(reopened.json.project.content.background.gradient.angle, 45);
  assert.equal(reopened.json.project.content.layers.length, 4);

  // Reopen a second time (fresh GET) — still identical.
  const reopened2 = await req(`/api/projects/${pid}`, { cookie: ownerCookie });
  assert.deepEqual(reopened2.json.project.content, design, 'second reopen must still match');
  const versions = await req(`/api/projects/${pid}/versions`, { cookie: ownerCookie });
  assert.ok(versions.json.versions.length >= 1, 'edited save must have a version');
  await req(`/api/projects/${pid}/trash`, { method: 'POST', cookie: ownerCookie });
  await req(`/api/projects/${pid}`, { method: 'DELETE', cookie: ownerCookie });
});
