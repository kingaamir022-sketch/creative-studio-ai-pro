'use strict';
// Phase 3 tests — run with: npm test
// Spawns the real server on a scratch port with a temp DB/uploads dir.
// Covers: timeline model (validation, split/trim/ripple, keyframes),
// video API (effects, validate, auth), media probing + thumbnails, and a
// REAL end-to-end FFmpeg render (generated test videos, ffprobe-validated
// output), plus job cancel / retry / per-user isolation.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const {
  blankTimeline, defaultClip, validateTimeline, allClips, totalDuration,
  splitClipAt, trimClip, rippleDelete, keyframeAt, outputDims, TRANSITIONS,
} = require('../src/video-model');
const { probeMedia } = require('../src/ffmpeg');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-video-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4833;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let ownerCookie = '';
let userCookie = '';

function req(path, { method = 'GET', body, cookie, form } = {}) {
  // No keep-alive reuse: after a long idle gap (a render) the server
  // may have closed the connection and the next fetch gets EPIPE.
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

function makeTestVideo(file, seconds, tone) {
  // Real video + real audio: testsrc picture with a sine tone.
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x180:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
    { timeout: 60000 });
}

let clipA, clipB; // paths to generated test videos
let mediaA, mediaB;

before(async () => {
  clipA = path.join(tmp, 'a.mp4');
  clipB = path.join(tmp, 'b.mp4');
  makeTestVideo(clipA, 4, 440);
  makeTestVideo(clipB, 4, 880);
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
});

after(() => {
  if (server) server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ---------------- Model (pure) ---------------- */
test('timeline model: blank timeline, validation, output dims', () => {
  const tl = blankTimeline('9:16', 30);
  assert.equal(tl.width, 720);
  assert.equal(tl.height, 1280);
  assert.equal(tl.tracks.length, 3);
  assert.deepEqual(validateTimeline(tl), ['Timeline has no clips — add at least one video, audio or text clip.']);
  const c = defaultClip('video', 1, 0, 2);
  tl.tracks[0].clips.push(c);
  assert.deepEqual(validateTimeline(tl), []);
  assert.equal(totalDuration(tl), 2);
  const d = outputDims(tl, '720p');
  assert.equal(d.width, 720);
  assert.equal(d.height, 1280);
  const bad = blankTimeline('16:9', 30);
  const badClip = defaultClip('video', 1, 0, 2);
  badClip.speed = 101; // above the v2.5.0 0.1–100 range
  bad.tracks[0].clips.push(badClip);
  assert.ok(validateTimeline(bad).some((e) => e.includes('speed')));
  const overlap = blankTimeline('16:9', 30);
  overlap.tracks[0].clips.push(defaultClip('video', 1, 0, 2), defaultClip('video', 2, 1, 2));
  assert.ok(validateTimeline(overlap).some((e) => e.includes('overlaps')));
  assert.ok(TRANSITIONS.some((t) => t.id === 'fade' && t.xfade === 'fade'));
});

test('timeline model: split, trim, ripple delete math', () => {
  const tl = blankTimeline('16:9', 30);
  const c = defaultClip('video', 1, 0, 4);
  c.srcStart = 1;
  c.keyframes = [{ t: 1, x: 20, y: 50, scale: 1, opacity: 1 }, { t: 3, x: 80, y: 50, scale: 2, opacity: 0.5 }];
  tl.tracks[0].clips.push(c);
  const split = splitClipAt(tl, c.id, 2);
  assert.equal(split.error, null);
  assert.equal(split.timeline.tracks[0].clips.length, 2);
  const [left, right] = split.timeline.tracks[0].clips;
  assert.equal(left.duration, 2);
  assert.equal(right.start, 2);
  assert.equal(right.duration, 2);
  assert.equal(right.srcStart, 3); // srcStart 1 + 2s at 1x speed
  assert.equal(right.keyframes.length, 1);
  assert.equal(right.keyframes[0].t, 1); // keyframe at 3s -> 1s into right clip
  assert.equal(left.keyframes.length, 1);
  const trimmed = trimClip(split.timeline, right.id, { duration: 1 });
  assert.equal(trimmed.timeline.tracks[0].clips[1].duration, 1);
  const rippled = rippleDelete(trimmed.timeline, left.id);
  assert.equal(rippled.error, null);
  assert.equal(rippled.timeline.tracks[0].clips.length, 1);
  assert.equal(rippled.timeline.tracks[0].clips[0].start, 0); // pulled earlier by 2s
  const edge = splitClipAt(tl, c.id, 0.01);
  assert.ok(edge.error);
});

test('timeline model: keyframe linear interpolation', () => {
  const clip = defaultClip('video', 1, 0, 4);
  clip.keyframes = [
    { t: 0, x: 0, y: 50, scale: 1, opacity: 1 },
    { t: 4, x: 100, y: 50, scale: 2, opacity: 0 },
  ];
  // v2.5.0 #5: keyframeAt now samples rotation + volume too.
  assert.deepEqual(keyframeAt(clip, 0), { x: 0, y: 50, scale: 1, opacity: 1, rotation: 0, volume: 1 });
  const mid = keyframeAt(clip, 2);
  assert.equal(mid.x, 50);
  assert.equal(mid.scale, 1.5);
  assert.equal(mid.opacity, 0.5);
  assert.deepEqual(keyframeAt(clip, 4), { x: 100, y: 50, scale: 2, opacity: 0, rotation: 0, volume: 1 });
  assert.deepEqual(keyframeAt({ ...clip, keyframes: [] }, 2), { x: 50, y: 50, scale: 1, opacity: 1, rotation: 0, volume: 1 });
  assert.equal(allClips(blankTimeline('16:9', 30)).length, 0);
});

/* ---------------- API ---------------- */
test('video API requires login; effects list only real capabilities', async () => {
  const anon = await req('/api/video/effects');
  assert.equal(anon.status, 401);
  const fx = await req('/api/video/effects', { cookie: ownerCookie });
  assert.equal(fx.status, 200);
  assert.ok(fx.json.transitions.some((t) => t.id === 'fade'));
  assert.ok(!fx.json.transitions.some((t) => t.id === 'zoom'), 'zoom is not listed — it cannot be rendered');
  assert.ok(fx.json.filters.some((f) => f.id === 'brightness'));
  assert.ok(fx.json.notYet.length > 0);
  const v = await req('/api/video/validate', { method: 'POST', cookie: ownerCookie, body: { timeline: blankTimeline('16:9', 30) } });
  // v2.5.0: an invalid timeline is a 400 with { valid: false, errors }.
  assert.equal(v.status, 400);
  assert.equal(v.json.valid, false);
});

async function uploadVideo(file, name) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), name);
  const r = await req('/api/media/upload', { method: 'POST', cookie: ownerCookie, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.media;
}

async function waitForProbe(mediaId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await req('/api/media', { cookie: ownerCookie });
    const m = (r.json.media || []).find((x) => x.id === mediaId);
    if (m && m.durationSeconds) return m;
    if (Date.now() > deadline) throw new Error(`probe did not land for media ${mediaId}`);
    await new Promise((x) => setTimeout(x, 300));
  }
}

test('media probe + thumbnail: real duration, size, fps, codec on upload', async () => {
  mediaA = await uploadVideo(clipA, 'clip-a.mp4');
  mediaB = await uploadVideo(clipB, 'clip-b.mp4');
  const probed = await waitForProbe(mediaA.id);
  assert.equal(probed.width, 320);
  assert.equal(probed.height, 180);
  assert.ok(Math.abs(probed.durationSeconds - 4) < 0.2, `duration ${probed.durationSeconds}`);
  assert.equal(probed.fps, 30);
  assert.equal(probed.codec, 'h264');
  assert.ok(probed.thumbnailUrl, 'thumbnail URL present');
  const thumb = await req(`/api/media/${mediaA.id}/thumbnail`, { cookie: ownerCookie });
  assert.equal(thumb.status, 200);
  assert.ok((thumb.headers.get('content-type') || '').includes('image/jpeg'));
  // Direct ffprobe agrees with the stored probe.
  const direct = await probeMedia(path.join(uploadsDir, '1', fs.readdirSync(path.join(uploadsDir, '1')).find((f) => f.endsWith('.mp4'))));
  assert.ok(direct.hasAudio, 'test video really has audio');
});

function renderTimeline() {
  const tl = blankTimeline('16:9', 30);
  const a = defaultClip('video', mediaA.id, 0, 2);
  a.name = 'Clip A';
  a.srcStart = 0;
  a.filters.brightness = 0.1;
  a.keyframes = [
    { t: 0, x: 20, y: 50, scale: 1, opacity: 1 },
    { t: 2, x: 80, y: 50, scale: 1.5, opacity: 0.7 },
  ];
  const b = defaultClip('video', mediaB.id, 2, 2);
  b.name = 'Clip B';
  b.srcStart = 0;
  b.transition = { type: 'fade', duration: 0.5 };
  tl.tracks[0].clips.push(a, b);
  const tx = defaultClip('text', null, 0.5, 2);
  tx.text = { ...tx.text, text: 'Hello Render', fontSize: 32, animIn: 'fade', animOut: 'fade' };
  tl.tracks[2].clips.push(tx);
  return tl;
}

let projectId;
let doneJobId;

test('end-to-end render: real MP4, ffprobe-validated', async () => {
  const tl = renderTimeline();
  const created = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'Render Test', type: 'video', content: { timeline: tl } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  projectId = created.json.project.id;

  const job = await req('/api/video/jobs', { method: 'POST', cookie: ownerCookie, body: { projectId, settings: { width: 320, height: 180, fps: 30 } } });
  assert.equal(job.status, 201, JSON.stringify(job.json));
  assert.equal(job.json.job.status, 'queued');
  doneJobId = job.json.job.id;

  // Poll for real progress (never a fake bar — the server reports FFmpeg's time=).
  let last = null;
  let sawProgress = false;
  const deadline = Date.now() + 60000;
  for (;;) {
    const r = await req(`/api/video/jobs/${doneJobId}`, { cookie: ownerCookie });
    assert.equal(r.status, 200);
    last = r.json.job;
    if (last.progress > 0) sawProgress = true;
    if (['done', 'failed', 'cancelled'].includes(last.status)) break;
    if (Date.now() > deadline) throw new Error(`render did not finish; last status ${JSON.stringify(last)}`);
    await new Promise((x) => setTimeout(x, 500));
  }
  assert.equal(last.status, 'done', `render failed: ${last.error}`);
  assert.equal(last.progress, 100);
  assert.ok(sawProgress, 'progress moved above 0 during the render');
  assert.equal(last.hasOutput, true);

  const log = await req(`/api/video/jobs/${doneJobId}/log`, { cookie: ownerCookie });
  assert.equal(log.status, 200);
  assert.ok((log.json.log || '').includes('ffmpeg'), 'log contains the ffmpeg command');

  const dl = await req(`/api/video/jobs/${doneJobId}/download`, { cookie: ownerCookie });
  assert.equal(dl.status, 200);
  assert.ok((dl.headers.get('content-type') || '').includes('video/mp4'));
  const outFile = path.join(tmp, 'rendered.mp4');
  fs.writeFileSync(outFile, Buffer.from(await fetch(BASE + `/api/video/jobs/${doneJobId}/download`, { headers: { cookie: ownerCookie } }).then((r) => r.arrayBuffer())));
  assert.ok(fs.statSync(outFile).size > 10000, 'downloaded MP4 is a real file, not empty');
  const probe = await ffprobe(outFile);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.ok(Math.abs(parseFloat(video.avg_frame_rate.split('/')[0]) / parseFloat(video.avg_frame_rate.split('/')[1]) - 30) < 1.5);
  assert.ok(Math.abs(parseFloat(probe.format.duration) - 3.5) < 0.75, `rendered duration ${probe.format.duration}, expected 3.5 (4s timeline minus 0.5s fade)`);
  assert.ok(audio, 'rendered output has a mixed audio stream');
});

test('render jobs: isolation, bad input rejected, retry rules', async () => {
  const other = await req(`/api/video/jobs/${doneJobId}`, { cookie: userCookie });
  assert.equal(other.status, 404);
  const cancelOther = await req(`/api/video/jobs/${doneJobId}/cancel`, { method: 'POST', cookie: userCookie });
  assert.equal(cancelOther.status, 404);
  const cancelDone = await req(`/api/video/jobs/${doneJobId}/cancel`, { method: 'POST', cookie: ownerCookie });
  assert.equal(cancelDone.status, 400, 'a finished job cannot be cancelled');
  const retryDone = await req(`/api/video/jobs/${doneJobId}/retry`, { method: 'POST', cookie: ownerCookie });
  assert.equal(retryDone.status, 400, 'a finished job cannot be retried');
  const badTl = renderTimeline();
  badTl.tracks[0].clips[0].mediaId = 999999;
  const bad = await req('/api/video/jobs', { method: 'POST', cookie: ownerCookie, body: { timeline: badTl, settings: { resolution: '720p', fps: 30 } } });
  assert.equal(bad.status, 400);
  const badFps = await req('/api/video/jobs', { method: 'POST', cookie: ownerCookie, body: { timeline: renderTimeline(), settings: { resolution: '720p', fps: 120 } } });
  assert.equal(badFps.status, 400);
});

test('render job: cancel a long render, then retry and cancel again', async () => {
  // 60s source, 1080p output — slow enough to cancel reliably.
  const longFile = path.join(tmp, 'long.mp4');
  makeTestVideo(longFile, 60, 440);
  const m = await uploadVideo(longFile, 'long.mp4');
  const tl = blankTimeline('16:9', 30);
  const c = defaultClip('video', m.id, 0, 60);
  c.srcStart = 0;
  tl.tracks[0].clips.push(c);
  const job = await req('/api/video/jobs', { method: 'POST', cookie: ownerCookie, body: { timeline: tl, settings: { resolution: '1080p', fps: 30 } } });
  assert.equal(job.status, 201, JSON.stringify(job.json));
  const jobId = job.json.job.id;
  await new Promise((r) => setTimeout(r, 1200));
  const cancelled = await req(`/api/video/jobs/${jobId}/cancel`, { method: 'POST', cookie: ownerCookie });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  // Poll until the worker records the cancellation.
  const deadline = Date.now() + 15000;
  let final = null;
  for (;;) {
    const r = await req(`/api/video/jobs/${jobId}`, { cookie: ownerCookie });
    final = r.json.job;
    if (final.status === 'cancelled') break;
    if (final.status === 'done') throw new Error('long render finished before the cancel landed');
    if (Date.now() > deadline) throw new Error(`cancel did not land; status ${final.status}`);
    await new Promise((x) => setTimeout(x, 300));
  }
  assert.equal(final.hasOutput, false, 'cancelled render leaves no output file');
  const retry = await req(`/api/video/jobs/${jobId}/retry`, { method: 'POST', cookie: ownerCookie });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.job.status, 'queued');
  const cancelAgain = await req(`/api/video/jobs/${jobId}/cancel`, { method: 'POST', cookie: ownerCookie });
  assert.equal(cancelAgain.status, 200);
});

test('export center lists jobs; save-to-library stores a real file', async () => {
  const list = await req('/api/video/jobs', { cookie: ownerCookie });
  assert.equal(list.status, 200);
  assert.ok(list.json.jobs.some((j) => j.id === doneJobId && j.status === 'done'));
  const saved = await req(`/api/video/jobs/${doneJobId}/save-to-library`, { method: 'POST', cookie: ownerCookie });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  const lib = await req('/api/media?search=render-', { cookie: ownerCookie });
  assert.ok(lib.json.media.some((m) => m.id === saved.json.media.id && m.kind === 'video'));
});
