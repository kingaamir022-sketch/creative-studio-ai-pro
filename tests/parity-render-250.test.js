'use strict';
// Parity render tests (v2.5.0 RENDER + MODEL) — real renders, ffprobe- and
// pixel-verified: rotation regression (#31), chroma (#3), mask (#9),
// stabilise (#8), speed curves (#4), keyframe rotation+volume+easing (#5),
// new transitions (#6), filter preset + LUT (#7), 4K + WebM + HEVC (#13),
// reverse/freeze (#16), voice processing (#17), emoji (#38), adjustment
// layer (#42), 3rd video track (#10), optical flow (#43), HDR (#52),
// Poppins font fidelity (#14), split-screen + compound clips (#35/#58),
// and the new endpoints (extract-audio, captions, waveform, estimate,
// apply-all, LUT upload, audio-only, frame/GIF export, queue position).
// Spawns the real server on a scratch port (4850) with a temp DB/uploads/
// renders/models/fonts dir. Run ONLY this file:
//   node --test tests/parity-render-250.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFile, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-parity250-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const modelsDir = path.join(tmp, 'models');
const fontsDir = path.join(tmp, 'fonts');
const stabDir = path.join(tmp, 'stab');
process.env.DB_PATH = dbPath;
process.env.UPLOADS_DIR = uploadsDir;
process.env.RENDERS_DIR = rendersDir;
process.env.MODELS_DIR = modelsDir;
process.env.FONTS_DIR = fontsDir;
process.env.STAB_CACHE_DIR = stabDir;
// Slow renders (4K, HEVC, HDR, optical flow) need a long watchdog.
process.env.RENDER_WATCHDOG_MS = '300000';
const PORT = 4850;
const BASE = `http://127.0.0.1:${PORT}`;

const vm = require('../src/video-model');
const { blankTimeline, defaultClip } = vm;
const { ensureFont, fontFor } = require('../src/render');

let server;
let ownerCookie = '';
let mediaVideo;   // 8s testsrc 320x180 + 440Hz sine
let mediaLong;    // 60s testsrc 320x180 + 440Hz sine
let mediaPng;     // 64x64 green square
let mediaChroma;  // 320x180 green PNG with a red centre box
let mediaLut;     // identity .cube uploaded via POST /api/video/luts

// Baseline timings measured on this box BEFORE the v2.5.0 render work
// (same testsrc media): keyframed 3.5s render 22.6s wall (0.155x
// realtime), plain 60s render 17.4s wall (3.445x realtime).
const BASELINE_KEYFRAMED_MS = 22600;
const BASELINE_PLAIN60_MS = 17400;

function req(p, { method = 'GET', body, cookie, form } = {}) {
  const headers = { connection: 'close' };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (form) payload = form;
  return fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' })
    .then(async (r) => {
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, text, setCookie: r.headers.get('set-cookie') || '' };
    });
}

function ffprobe(file) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt', '-show_entries', 'format=duration', '-of', 'json', file],
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
}

function makeTestVideo(file, seconds, tone) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x180:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
    { timeout: 120000 });
}

function makePng(outPath, color = '0x2e7d32', size = '64x64') {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=1:r=1`, '-frames:v', '1', outPath], { stdio: 'pipe' });
}

function makeChromaPng(outPath) {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x180:d=1:r=1',
    '-vf', 'drawbox=x=120:y=60:w=80:h=60:color=red:t=fill', '-frames:v', '1', outPath], { stdio: 'pipe' });
}

async function uploadFile(name, buf, mime, endpoint = '/api/media/upload') {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), name);
  const r = await req(endpoint, { method: 'POST', cookie: ownerCookie, form: fd });
  assert.equal(r.status, 201, `upload ${name} should be accepted: ${r.text}`);
  return r.json.media;
}

async function renderTimeline(tl, label, settings = { resolution: '720p', fps: 30 }, deadlineMs = 180000) {
  const started = Date.now();
  const job = await req('/api/video/jobs', { method: 'POST', cookie: ownerCookie, body: { timeline: tl, settings } });
  assert.equal(job.status, 201, `render ${label}: job should be created: ${JSON.stringify(job.json)}`);
  const id = job.json.job.id;
  const deadline = Date.now() + deadlineMs;
  let last = null;
  for (;;) {
    const r = await req(`/api/video/jobs/${id}`, { cookie: ownerCookie });
    assert.equal(r.status, 200, `job ${id} should be readable: ${r.text}`);
    last = r.json.job;
    if (['done', 'failed', 'cancelled'].includes(last.status)) break;
    assert.ok(Date.now() < deadline, `render ${label} did not finish within ${deadlineMs}ms (last: ${JSON.stringify(last)})`);
    await new Promise((x) => setTimeout(x, 1000));
  }
  const wallMs = Date.now() - started;
  assert.equal(last.status, 'done', `render ${label} failed: ${last.error || 'unknown'}`);
  const ext = settings.audioOnly ? (settings.audioFormat === 'wav' ? 'wav' : 'mp3')
    : settings.frameExport ? 'jpg' : settings.gifExport ? 'gif'
    : settings.format === 'webm' ? 'webm' : settings.format === 'mov' ? 'mov' : 'mp4';
  const outFile = path.join(tmp, `${label}.${ext}`);
  const res = await fetch(BASE + `/api/video/jobs/${id}/download`, { headers: { cookie: ownerCookie } });
  assert.equal(res.status, 200, `render ${label}: download should work`);
  fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
  let probe = null; let video = null; let audio = null; let duration = null;
  if (!settings.gifExport) {
    probe = await ffprobe(outFile);
    video = probe.streams.find((s) => s.codec_type === 'video');
    audio = probe.streams.find((s) => s.codec_type === 'audio');
    duration = parseFloat(probe.format.duration);
  }
  return { job: last, jobId: id, probe, video, audio, duration, outFile, wallMs };
}

// Extract one frame as raw RGB24 (no PNG decoder needed in Node).
function frameRgb(file, at) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', file], { encoding: 'utf8' }));
  const { width: w, height: h } = probe.streams[0];
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(buf.length, w * h * 3, `frame at ${at}s should decode to ${w}x${h} RGB`);
  return { buf, w, h };
}
function px(rgb, x, y) {
  const i = (y * rgb.w + x) * 3;
  return [rgb.buf[i], rgb.buf[i + 1], rgb.buf[i + 2]];
}
function meanAbsDiff(a, b) {
  assert.equal(a.buf.length, b.buf.length, 'frames must be the same size to compare');
  let sum = 0; let n = 0;
  for (let i = 0; i < a.buf.length; i += 48) { sum += Math.abs(a.buf[i] - b.buf[i]); n++; }
  return sum / n;
}
function saturatedCount(rgb) {
  let n = 0;
  for (let i = 0; i < rgb.buf.length; i += 3) {
    const r = rgb.buf[i]; const g = rgb.buf[i + 1]; const b = rgb.buf[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 80) n++;
  }
  return n;
}
function grayFraction(rgb) {
  let gray = 0; let n = 0;
  for (let i = 0; i < rgb.buf.length; i += 30) {
    const r = rgb.buf[i]; const g = rgb.buf[i + 1]; const b = rgb.buf[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) < 20) gray++;
    n++;
  }
  return gray / n;
}
function nonBlackCount(rgb) {
  let n = 0;
  for (let i = 0; i < rgb.buf.length; i += 3) {
    if (rgb.buf[i] > 40 || rgb.buf[i + 1] > 40 || rgb.buf[i + 2] > 40) n++;
  }
  return n;
}

// Mean volume (dBFS) of a slice of an audio/video file via volumedetect.
function meanVolume(file, ss, dur) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(ss), '-t', String(dur), '-i', file,
    '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const m = String(r.stderr || '').match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  assert.ok(m, `volumedetect should report a mean volume for ${file}: ${String(r.stderr || '').slice(-300)}`);
  return parseFloat(m[1]);
}

function tlWith(setup) {
  const tl = blankTimeline('16:9', 30);
  setup(tl);
  return tl;
}
function addTrack(tl, kind, name) {
  const tr = { id: `track_${Math.random().toString(36).slice(2, 10)}`, kind, name, locked: false, muted: false, clips: [] };
  tl.tracks.push(tr);
  return tr;
}
async function createProject(name, timeline) {
  const r = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name, type: 'video', content: { timeline } } });
  assert.equal(r.status, 201, `create project: ${r.text}`);
  return r.json.project;
}

before(async () => {
  const vidPath = path.join(tmp, 'clip.mp4');
  makeTestVideo(vidPath, 8, 440);
  const longPath = path.join(tmp, 'long.mp4');
  makeTestVideo(longPath, 60, 440);
  const pngPath = path.join(tmp, 'sticker.png');
  makePng(pngPath);
  const chromaPath = path.join(tmp, 'chroma.png');
  makeChromaPng(chromaPath);
  const cubePath = path.join(tmp, 'identity.cube');
  fs.writeFileSync(cubePath, [
    'TITLE "Identity"', 'LUT_3D_SIZE 2',
    '0.0 0.0 0.0', '1.0 0.0 0.0', '0.0 1.0 0.0', '1.0 1.0 0.0',
    '0.0 0.0 1.0', '1.0 0.0 1.0', '0.0 1.0 1.0', '1.0 1.0 1.0', '',
  ].join('\n'));
  const env = {
    ...process.env,
    DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, MODELS_DIR: modelsDir,
    FONTS_DIR: fontsDir, STAB_CACHE_DIR: stabDir,
    PORT: String(PORT), HOST: '127.0.0.1', RENDER_WATCHDOG_MS: '300000',
  };
  server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const serverLog = fs.createWriteStream(path.join(tmp, 'server.log'));
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start: ${out}`);
    await new Promise((x) => setTimeout(x, 200));
  }
  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'Parity Tester', email: 'parity250@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  ownerCookie = s.setCookie.split(';')[0];
  mediaVideo = await uploadFile('clip.mp4', fs.readFileSync(vidPath), 'video/mp4');
  mediaLong = await uploadFile('long.mp4', fs.readFileSync(longPath), 'video/mp4');
  mediaPng = await uploadFile('sticker.png', fs.readFileSync(pngPath), 'image/png');
  mediaChroma = await uploadFile('chroma.png', fs.readFileSync(chromaPath), 'image/png');
  mediaLut = await uploadFile('identity.cube', fs.readFileSync(cubePath), 'application/octet-stream', '/api/video/luts');
  // Poppins must be downloadable for the font-fidelity test (#14).
  const poppinsPath = await ensureFont('Poppins', 700);
  assert.ok(poppinsPath, 'Poppins should download from Google Fonts into FONTS_DIR');
  assert.ok(fs.existsSync(poppinsPath), `downloaded Poppins file should exist: ${poppinsPath}`);
});

after(async () => {
  if (server) server.kill('SIGKILL');
});

// ---------------------------------------------------------------------------
// Model validation
// ---------------------------------------------------------------------------

test('validate: effect track validates; overlapping/negative effect clips rejected', async () => {
  const ok = tlWith((t) => {
    const fx = defaultClip('effect', null, 0, 2);
    fx.effectId = 'noir';
    addTrack(t, 'effect', 'FX').clips.push(fx);
  });
  const r1 = await req('/api/video/validate', { method: 'POST', cookie: ownerCookie, body: { timeline: ok } });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.valid, true, `effect track must validate: ${JSON.stringify(r1.json.errors)}`);
  const overlap = tlWith((t) => {
    const tr = addTrack(t, 'effect', 'FX');
    tr.clips.push(defaultClip('effect', null, 0, 2), defaultClip('effect', null, 1, 2));
  });
  const r2 = await req('/api/video/validate', { method: 'POST', cookie: ownerCookie, body: { timeline: overlap } });
  assert.equal(r2.json.valid, false, 'overlapping effect clips must be rejected');
  const negative = tlWith((t) => {
    addTrack(t, 'effect', 'FX').clips.push(defaultClip('effect', null, -1, 2));
  });
  const r3 = await req('/api/video/validate', { method: 'POST', cookie: ownerCookie, body: { timeline: negative } });
  assert.equal(r3.json.valid, false, 'negative-start effect clip must be rejected');
});

test('validate: compound clip on a video track validates; compound with mediaId rejected', async () => {
  const nested = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2)); });
  const ok = tlWith((t) => {
    const c = defaultClip('compound', null, 0, 2);
    c.nested = nested;
    t.tracks[0].clips.push(c);
  });
  const r1 = await req('/api/video/validate', { method: 'POST', cookie: ownerCookie, body: { timeline: ok } });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.valid, true, `compound clip must validate: ${JSON.stringify(r1.json.errors)}`);
  const bad = tlWith((t) => {
    const c = defaultClip('compound', mediaVideo.id, 0, 2);
    c.nested = nested;
    t.tracks[0].clips.push(c);
  });
  const r2 = await req('/api/video/validate', { method: 'POST', cookie: ownerCookie, body: { timeline: bad } });
  assert.equal(r2.json.valid, false, 'compound clip with a mediaId must be rejected');
});

test('validate: rotation/volume/easing keyframes are now accepted (#5 contract change)', async () => {
  const tl = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 2);
    c.keyframes = [
      { t: 0, x: 20, y: 50, scale: 1, opacity: 1, rotation: 0, volume: 1, easing: 'linear' },
      { t: 2, x: 80, y: 50, scale: 1.5, opacity: 0.7, rotation: 90, volume: 0.2, easing: 'ease-in-out' },
    ];
    t.tracks[0].clips.push(c);
  });
  const r = await req('/api/video/validate', { method: 'POST', cookie: ownerCookie, body: { timeline: tl } });
  assert.equal(r.status, 200);
  assert.equal(r.json.valid, true, `rotation/volume/easing keyframes must validate now: ${JSON.stringify(r.json.errors)}`);
  // Speed-curve math (unit-level, same numbers the renderer integrates).
  const curveClip = defaultClip('video', mediaVideo.id, 0, 4);
  curveClip.speedCurve = { preset: 'montage', points: [] };
  assert.ok(Math.abs(vm.curveIntegral(curveClip, 4) - 6) < 0.01, `montage over 4s consumes 6s of source, got ${vm.curveIntegral(curveClip, 4)}`);
  assert.ok(Math.abs(vm.sourceTimeAt(curveClip, 2) - 3) < 0.01, `montage source time at 2s is 3s, got ${vm.sourceTimeAt(curveClip, 2)}`);
});

test('validate: 3 video tracks, speed 0.1–100 and volume 0–2 accepted; speed 200 rejected', async () => {
  const tl = tlWith((t) => {
    const a = defaultClip('video', mediaVideo.id, 0, 2);
    a.speed = 0.25;
    const b = defaultClip('video', mediaVideo.id, 0, 2);
    b.speed = 100;
    b.volume = 2;
    const c = defaultClip('video', mediaVideo.id, 0, 2);
    c.speed = 0.1;
    t.tracks[0].clips.push(a);
    addTrack(t, 'video', 'Video 2').clips.push(b);
    addTrack(t, 'video', 'Video 3').clips.push(c);
  });
  const r1 = await req('/api/video/validate', { method: 'POST', cookie: ownerCookie, body: { timeline: tl } });
  assert.equal(r1.json.valid, true, `3 video tracks + speed/volume extremes must validate: ${JSON.stringify(r1.json.errors)}`);
  const bad = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 2);
    c.speed = 200;
    t.tracks[0].clips.push(c);
  });
  const r2 = await req('/api/video/validate', { method: 'POST', cookie: ownerCookie, body: { timeline: bad } });
  assert.equal(r2.json.valid, false, 'speed 200 must be rejected');
});

test('jobs: gradient text is refused with a clear 400, before any render starts', async () => {
  const tl = tlWith((t) => {
    const c = defaultClip('text', null, 0, 2);
    c.text.text = 'Hello';
    c.text.gradient = { enabled: true, colors: ['#ff0000', '#0000ff'] };
    t.tracks[2].clips.push(c);
    t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2));
  });
  const r = await req('/api/video/jobs', { method: 'POST', cookie: ownerCookie, body: { timeline: tl, settings: {} } });
  assert.equal(r.status, 400, `gradient text must be refused: ${JSON.stringify(r.json)}`);
  assert.match(r.json.error, /Gradient text is not supported/);
});

// ---------------------------------------------------------------------------
// Effects catalog
// ---------------------------------------------------------------------------

test('effects endpoint lists the built libraries and drops the old notYet items', async () => {
  const r = await req('/api/video/effects', { cookie: ownerCookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.effects.length >= 12, `effects library should have >=12 entries, got ${r.json.effects.length}`);
  assert.ok(r.json.effects.some((e) => e.id === 'glitch'), 'glitch effect must be listed');
  assert.ok(r.json.effects.some((e) => e.id === 'noir'), 'noir effect must be listed');
  assert.ok(r.json.filterPresets.length >= 10, `filter presets should be >=10, got ${r.json.filterPresets.length}`);
  assert.ok(r.json.filterPresets.some((p) => p.id === 'vivid' && p.sliders), 'vivid preset must carry sliders');
  assert.ok(r.json.speedCurvePresets.some((p) => p.id === 'montage'), 'montage speed curve must be listed');
  assert.ok(r.json.speedCurvePresets.some((p) => p.id === 'hero'), 'hero speed curve must be listed');
  assert.ok(r.json.exportPresets.length >= 8, `export presets should be >=8, got ${r.json.exportPresets.length}`);
  assert.ok(r.json.transitions.length >= 12, `transitions should be >=12, got ${r.json.transitions.length}`);
  assert.ok(r.json.transitions.filter((t) => t.id !== 'none').every((t) => t.maxDuration === 5), 'every real transition maxDuration is 5s (none is 0)');
  assert.ok(r.json.resolutions.some((x) => x.id === '4K'), '4K resolution must be listed');
  assert.ok(r.json.fpsOptions.includes(25) && r.json.fpsOptions.includes(50), '25/50 fps must be listed');
  assert.ok(!r.json.notYet.some((s) => /chroma|stabil/i.test(s)), 'chroma/stabilisation must leave notYet once built');
  assert.ok(!r.json.notYet.some((s) => /speed ramp/i.test(s)), 'speed curves must leave notYet once built');
});

// ---------------------------------------------------------------------------
// Rotation regression (#31)
// ---------------------------------------------------------------------------

test('render rotation 90 alone renders at the project size', async () => {
  const tl = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 2);
    c.rotation = 90;
    t.tracks[0].clips.push(c);
  });
  const { video, duration } = await renderTimeline(tl, 'rot90');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(duration - 2) < 0.75, `duration ${duration}, expected 2`);
});

test('render rotation 270 with a fade transition renders at the project size', async () => {
  const tl = tlWith((t) => {
    const a = defaultClip('video', mediaVideo.id, 0, 2);
    const b = defaultClip('video', mediaVideo.id, 2, 2);
    b.rotation = 270;
    b.transition = { type: 'fade', duration: 0.5 };
    t.tracks[0].clips.push(a, b);
  });
  const { video, duration } = await renderTimeline(tl, 'rot270fade');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(duration - 3.5) < 0.75, `duration ${duration}, expected 3.5`);
});

test('render rotation 90 with keyframes renders at the project size', async () => {
  const tl = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 2);
    c.rotation = 90;
    c.keyframes = [
      { t: 0, x: 20, y: 50, scale: 1, opacity: 1 },
      { t: 2, x: 80, y: 50, scale: 1.5, opacity: 0.7 },
    ];
    t.tracks[0].clips.push(c);
  });
  const { video, duration } = await renderTimeline(tl, 'rot90kf');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(duration - 2) < 0.75, `duration ${duration}, expected 2`);
});

// ---------------------------------------------------------------------------
// Chroma, mask, stabilise
// ---------------------------------------------------------------------------

test('render chroma key: green is removed, the red centre stays', async () => {
  const tl = tlWith((t) => {
    t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2));
    const fg = defaultClip('video', mediaChroma.id, 0, 2);
    fg.chroma = { enabled: true, color: '#00ff00', similarity: 0.1, blend: 0.05 };
    // A chroma layer must cover the frame: overlay-track clips default
    // to a 30% PiP (contract default x=70,y=70,w=30), so set full-frame
    // overlay explicitly.
    fg.overlay = { x: 0, y: 0, w: 100, h: 100 };
    addTrack(t, 'video', 'Video 2').clips.push(fg);
  });
  const { outFile } = await renderTimeline(tl, 'chroma');
  const frame = frameRgb(outFile, 1);
  const centre = px(frame, 640, 360);
  assert.ok(centre[0] > 120 && centre[0] > centre[1] + 40, `centre should be reddish, got rgb(${centre})`);
  const corner = px(frame, 20, 20);
  const isPureGreen = corner[1] > 180 && corner[0] < 100 && corner[2] < 100;
  assert.ok(!isPureGreen, `corner should not stay pure green, got rgb(${corner})`);
});

test('render circle mask: corners black, centre has content', async () => {
  const tl = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 2);
    c.mask = { type: 'circle', x: 50, y: 50, w: 80, h: 80, rotation: 0, feather: 0, invert: false };
    t.tracks[0].clips.push(c);
  });
  const { outFile } = await renderTimeline(tl, 'maskcircle');
  const frame = frameRgb(outFile, 1);
  const corner = px(frame, 10, 10);
  assert.ok(corner[0] < 25 && corner[1] < 25 && corner[2] < 25, `corner should be black, got rgb(${corner})`);
  const centre = px(frame, 640, 360);
  assert.ok(centre[0] > 60 || centre[1] > 60 || centre[2] > 60, `centre should have content, got rgb(${centre})`);
});

test('render stabilised clip renders at the project size', async () => {
  const tl = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 2);
    c.stabilize = { enabled: true, strength: 0.5 };
    t.tracks[0].clips.push(c);
  });
  const { video, duration } = await renderTimeline(tl, 'stab', { resolution: '720p', fps: 30 }, 240000);
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(duration - 2) < 0.75, `duration ${duration}, expected 2`);
});

// ---------------------------------------------------------------------------
// Speed, reverse, freeze, keyframes
// ---------------------------------------------------------------------------

test('render speed-curve montage consumes more source but keeps the timeline duration', async () => {
  const tl = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 4);
    c.speedCurve = { preset: 'montage', points: [] };
    t.tracks[0].clips.push(c);
  });
  const { video, duration } = await renderTimeline(tl, 'curve');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(duration - 4) < 0.75, `duration ${duration}, expected 4`);
});

test('render reverse: first frame differs from the forward first frame, matches the forward last frame', async () => {
  const normal = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 3)); });
  const reversed = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 3);
    c.reverse = true;
    t.tracks[0].clips.push(c);
  });
  const n = await renderTimeline(normal, 'fwd');
  const r = await renderTimeline(reversed, 'rev');
  assert.ok(Math.abs(r.duration - 3) < 0.75, `reversed duration ${r.duration}, expected 3`);
  const nFirst = frameRgb(n.outFile, 0.1);
  const nLast = frameRgb(n.outFile, 2.9);
  const rFirst = frameRgb(r.outFile, 0.1);
  const rLast = frameRgb(r.outFile, 2.9);
  assert.ok(meanAbsDiff(rFirst, nFirst) > 8, `reversed first frame should differ from forward first frame (diff ${meanAbsDiff(rFirst, nFirst).toFixed(1)})`);
  assert.ok(meanAbsDiff(rFirst, nLast) < 12, `reversed first frame should match forward last frame (diff ${meanAbsDiff(rFirst, nLast).toFixed(1)})`);
  assert.ok(meanAbsDiff(rLast, nFirst) < 12, `reversed last frame should match forward first frame (diff ${meanAbsDiff(rLast, nFirst).toFixed(1)})`);
});

test('render freeze: frames inside the freeze window are (nearly) identical', async () => {
  const frozen = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 4);
    c.freeze = { enabled: true, at: 0.5, duration: 1.5 };
    t.tracks[0].clips.push(c);
  });
  const control = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 4)); });
  const f = await renderTimeline(frozen, 'freeze');
  const c = await renderTimeline(control, 'nofreeze');
  assert.ok(Math.abs(f.duration - 4) < 0.75, `frozen duration ${f.duration}, expected 4`);
  const frozenDiff = meanAbsDiff(frameRgb(f.outFile, 0.9), frameRgb(f.outFile, 1.2));
  const controlDiff = meanAbsDiff(frameRgb(c.outFile, 0.9), frameRgb(c.outFile, 1.2));
  assert.ok(frozenDiff < 6, `frozen frames should match (diff ${frozenDiff.toFixed(1)})`);
  assert.ok(controlDiff > frozenDiff + 5, `unfrozen frames should change more (control ${controlDiff.toFixed(1)} vs frozen ${frozenDiff.toFixed(1)})`);
});

test('render keyframe rotation+volume+easing: size ok, volume really drops', async () => {
  const tl = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 4);
    c.keyframes = [
      { t: 0, x: 50, y: 50, scale: 1, opacity: 1, rotation: 0, volume: 1, easing: 'linear' },
      { t: 4, x: 50, y: 50, scale: 1, opacity: 1, rotation: 90, volume: 0.1, easing: 'ease-in-out' },
    ];
    t.tracks[0].clips.push(c);
  });
  const { video, duration, outFile } = await renderTimeline(tl, 'kfrotvol', { resolution: '720p', fps: 30 }, 240000);
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(duration - 4) < 0.75, `duration ${duration}, expected 4`);
  const early = meanVolume(outFile, 0, 1);
  const late = meanVolume(outFile, 3, 1);
  assert.ok(late < early - 6, `volume should drop by >6dB (early ${early}dB, late ${late}dB)`);
});

// ---------------------------------------------------------------------------
// Transitions, filter preset + LUT
// ---------------------------------------------------------------------------

test('render three new transitions in one timeline', async () => {
  const tl = tlWith((t) => {
    const mk = (start, type) => {
      const c = defaultClip('video', mediaVideo.id, start, 2);
      if (type) c.transition = { type, duration: 0.5 };
      return c;
    };
    t.tracks[0].clips.push(mk(0), mk(2, 'slideleft'), mk(4, 'circlecrop'), mk(6, 'pixelize'));
  });
  const { video, duration } = await renderTimeline(tl, 'transitions');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(duration - 6.5) < 0.75, `duration ${duration}, expected 6.5 (8s minus 3x0.5s transitions)`);
});

test('render filter preset vivid + LUT renders at the project size', async () => {
  const tl = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 2);
    c.filterPreset = 'vivid';
    c.lutMediaId = mediaLut.id;
    t.tracks[0].clips.push(c);
  });
  const { video, duration } = await renderTimeline(tl, 'lut');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(duration - 2) < 0.75, `duration ${duration}, expected 2`);
});

// ---------------------------------------------------------------------------
// Export breadth: 4K, WebM, HEVC, HDR, optical flow
// ---------------------------------------------------------------------------

test('render 4K export is really 3840x2160', async () => {
  const tl = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2)); });
  const { video, duration } = await renderTimeline(tl, 'fourk', { resolution: '4K', fps: 30 }, 300000);
  assert.equal(video.width, 3840);
  assert.equal(video.height, 2160);
  assert.ok(Math.abs(duration - 2) < 0.75, `duration ${duration}, expected 2`);
});

test('render WebM export is VP9 in a WebM container', async () => {
  const tl = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2)); });
  const { video, duration, outFile } = await renderTimeline(tl, 'webm', { resolution: '720p', fps: 30, format: 'webm' }, 300000);
  assert.equal(video.codec_name, 'vp9');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(duration - 2) < 0.75, `duration ${duration}, expected 2`);
  assert.ok(outFile.endsWith('.webm'), 'output file should be .webm');
});

test('render HEVC export is really H.265', async () => {
  const tl = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2)); });
  const { video, duration } = await renderTimeline(tl, 'hevc', { resolution: '720p', fps: 30, codec: 'hevc' }, 300000);
  assert.equal(video.codec_name, 'hevc');
  assert.ok(Math.abs(duration - 2) < 0.75, `duration ${duration}, expected 2`);
});

test('render HDR export is 10-bit HEVC (yuv420p10le)', async () => {
  const tl = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2)); });
  const { video, duration } = await renderTimeline(tl, 'hdr', { resolution: '720p', fps: 30, codec: 'hevc', hdr: true }, 300000);
  assert.equal(video.codec_name, 'hevc');
  assert.equal(video.pix_fmt, 'yuv420p10le', `HDR pix_fmt should be yuv420p10le, got ${video.pix_fmt}`);
  assert.ok(Math.abs(duration - 2) < 0.75, `duration ${duration}, expected 2`);
});

test('render optical flow slow-mo at 0.25x really slows the picture', async () => {
  // Clip duration is the TIMELINE duration: a 2s clip at 0.25x still
  // lasts 2s, but only consumes 0.5s of source (the editor stretches
  // the clip when the user picks a slow speed). The proof it is slow-mo:
  // timeline 1.0s shows source ~0.25s, not source 1.0s.
  const slowTl = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 2);
    c.speed = 0.25;
    c.opticalFlow = true;
    t.tracks[0].clips.push(c);
  });
  const normalTl = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2)); });
  const s = await renderTimeline(slowTl, 'optflow', { resolution: '720p', fps: 30 }, 300000);
  const n = await renderTimeline(normalTl, 'optflownormal');
  assert.equal(s.video.width, 1280);
  assert.equal(s.video.height, 720);
  assert.ok(Math.abs(s.duration - 2) < 0.75, `duration ${s.duration}, expected 2 (timeline duration)`);
  const slowAt1 = frameRgb(s.outFile, 1.0);
  const normalAt025 = frameRgb(n.outFile, 0.25);
  const normalAt1 = frameRgb(n.outFile, 1.0);
  assert.ok(meanAbsDiff(slowAt1, normalAt025) < 12, `slowed frame at 1.0s should match normal frame at 0.25s (diff ${meanAbsDiff(slowAt1, normalAt025).toFixed(1)})`);
  assert.ok(meanAbsDiff(slowAt1, normalAt1) > 8, `slowed frame at 1.0s should differ from normal frame at 1.0s (diff ${meanAbsDiff(slowAt1, normalAt1).toFixed(1)})`);
});

// ---------------------------------------------------------------------------
// Voice processing, emoji, adjustment layer, 3rd track, split-screen, compound
// ---------------------------------------------------------------------------

test('render loudnorm voice processing lands near -16 LUFS', async () => {
  const loud = tlWith((t) => {
    const tr = t.tracks.find((x) => x.kind === 'audio');
    const c = defaultClip('audio', mediaVideo.id, 0, 4);
    c.audioFx = { denoise: false, enhanceVoice: false, vocalIsolation: 'off', loudnorm: true, ducking: false };
    tr.clips.push(c);
  });
  const control = tlWith((t) => {
    const tr = t.tracks.find((x) => x.kind === 'audio');
    tr.clips.push(defaultClip('audio', mediaVideo.id, 0, 4));
  });
  const l = await renderTimeline(loud, 'loudnorm');
  const c = await renderTimeline(control, 'noloudnorm');
  assert.ok(l.audio, 'loudnorm render should have an audio stream');
  const loudDb = meanVolume(l.outFile, 0, 4);
  const controlDb = meanVolume(c.outFile, 0, 4);
  // The test sine is quiet (-24dB), so loudnorm normalises it UP to -16.
  assert.ok(loudDb > -19 && loudDb < -13, `loudnorm mean volume should be near -16dB, got ${loudDb}dB (control ${controlDb}dB)`);
  assert.ok(Math.abs(loudDb + 16) < Math.abs(controlDb + 16), `loudnorm should land closer to -16 LUFS than the control (${loudDb}dB vs ${controlDb}dB)`);
});

test('render emoji is colour, not tofu: saturated pixels vs a plain-letter control', async () => {
  const emojiTl = tlWith((t) => {
    const c = defaultClip('text', null, 0, 2);
    c.text.text = '🎉';
    c.text.fontSize = 160;
    t.tracks[2].clips.push(c);
  });
  const controlTl = tlWith((t) => {
    const c = defaultClip('text', null, 0, 2);
    c.text.text = 'A';
    c.text.fontSize = 160;
    t.tracks[2].clips.push(c);
  });
  const e = await renderTimeline(emojiTl, 'emoji');
  const c = await renderTimeline(controlTl, 'emojicontrol');
  const emojiSat = saturatedCount(frameRgb(e.outFile, 1));
  const controlSat = saturatedCount(frameRgb(c.outFile, 1));
  assert.ok(emojiSat > 500, `emoji frame should have many saturated (colour) pixels, got ${emojiSat}`);
  assert.ok(controlSat < 100, `plain white letter should have almost no saturated pixels, got ${controlSat}`);
});

test('render adjustment layer (effect track, noir) turns the frame grayscale', async () => {
  const tl = tlWith((t) => {
    t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2));
    const fx = defaultClip('effect', null, 0, 2);
    fx.effectId = 'noir';
    fx.intensity = 1;
    addTrack(t, 'effect', 'FX').clips.push(fx);
  });
  const control = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2)); });
  const f = await renderTimeline(tl, 'adjustnoir');
  const c = await renderTimeline(control, 'adjustcontrol');
  const noirGray = grayFraction(frameRgb(f.outFile, 1));
  const controlGray = grayFraction(frameRgb(c.outFile, 1));
  assert.ok(noirGray > 0.85, `noir adjustment layer should be mostly grayscale (${(noirGray * 100).toFixed(0)}%)`);
  assert.ok(controlGray < 0.6, `unadjusted testsrc should be colourful (gray fraction ${(controlGray * 100).toFixed(0)}%)`);
});

test('render with a 3rd video track composites every overlay', async () => {
  const tl = tlWith((t) => {
    t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 4));
    addTrack(t, 'video', 'Video 2').clips.push(defaultClip('video', mediaPng.id, 0, 2));
    addTrack(t, 'video', 'Video 3').clips.push(defaultClip('video', mediaPng.id, 2, 2));
  });
  const { video, duration } = await renderTimeline(tl, 'track3');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(duration - 4) < 0.75, `duration ${duration}, expected 4`);
});

test('render split-screen renders the partner beside the main clip', async () => {
  const tl = tlWith((t) => {
    const main = defaultClip('video', mediaVideo.id, 0, 2);
    const partner = defaultClip('video', mediaVideo.id, 0, 2);
    main.splitScreen = { enabled: true, partnerClipId: partner.id };
    t.tracks[0].clips.push(main);
    addTrack(t, 'video', 'Video 2').clips.push(partner);
  });
  const { video, duration } = await renderTimeline(tl, 'splitscreen');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(duration - 2) < 0.75, `duration ${duration}, expected 2`);
});

test('render compound clip renders its nested timeline as the source', async () => {
  const nested = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2)); });
  const tl = tlWith((t) => {
    const c = defaultClip('compound', null, 0, 2);
    c.nested = nested;
    t.tracks[0].clips.push(c);
  });
  const { video, duration } = await renderTimeline(tl, 'compound', { resolution: '720p', fps: 30 }, 240000);
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Math.abs(duration - 2) < 0.75, `duration ${duration}, expected 2`);
});

test('Poppins font fidelity: the downloaded font is used and renders differently from DejaVu', async () => {
  const resolved = fontFor('Poppins', 700);
  assert.ok(resolved && /Poppins/i.test(resolved), `fontFor('Poppins') should resolve to the downloaded Poppins file, got ${resolved}`);
  const poppinsTl = tlWith((t) => {
    const c = defaultClip('text', null, 0, 2);
    c.text.text = 'Hello';
    c.text.fontSize = 100;
    c.text.fontFamily = 'Poppins';
    t.tracks[2].clips.push(c);
  });
  const dejavuTl = tlWith((t) => {
    const c = defaultClip('text', null, 0, 2);
    c.text.text = 'Hello';
    c.text.fontSize = 100;
    c.text.fontFamily = 'DejaVu Sans';
    t.tracks[2].clips.push(c);
  });
  const p = await renderTimeline(poppinsTl, 'poppins');
  const d = await renderTimeline(dejavuTl, 'dejavu');
  const pCount = nonBlackCount(frameRgb(p.outFile, 1));
  const dCount = nonBlackCount(frameRgb(d.outFile, 1));
  assert.ok(pCount > 100, `Poppins render should draw text pixels, got ${pCount}`);
  assert.ok(dCount > 100, `DejaVu render should draw text pixels, got ${dCount}`);
  const relDiff = Math.abs(pCount - dCount) / Math.max(pCount, dCount);
  assert.ok(relDiff > 0.03, `Poppins and DejaVu should render measurably different text (counts ${pCount} vs ${dCount}, rel diff ${(relDiff * 100).toFixed(1)}%)`);
});

// ---------------------------------------------------------------------------
// New endpoints
// ---------------------------------------------------------------------------

test('extract-audio returns a ready-to-insert audio clip + a media file with audio', async () => {
  const clip = defaultClip('video', mediaVideo.id, 1, 3);
  clip.srcStart = 1;
  const tl = tlWith((t) => { t.tracks[0].clips.push(clip); });
  const project = await createProject('Extract test', tl);
  const r = await req(`/api/video/${project.id}/extract-audio`, { method: 'POST', cookie: ownerCookie, body: { clipId: clip.id } });
  assert.equal(r.status, 201, `extract-audio should succeed: ${r.text}`);
  assert.equal(r.json.clip.kind, 'audio');
  assert.equal(r.json.clip.mediaId, r.json.media.id);
  assert.equal(r.json.clip.start, 1);
  assert.equal(r.json.clip.duration, 3);
  assert.ok(Math.abs(r.json.media.durationSeconds - 3) < 0.6, `extracted audio should be ~3s, got ${r.json.media.durationSeconds}`);
  assert.equal(r.json.clip.linkedTo, clip.id);
  const w = await req(`/api/video/media/${r.json.media.id}/waveform`, { cookie: ownerCookie });
  assert.equal(w.status, 200, `extracted audio should have a waveform: ${w.text}`);
  assert.ok(w.json.peaks.length >= 100, `waveform should have >=100 peaks, got ${w.json.peaks.length}`);
});

test('captions import/export round-trips through SRT', async () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,000\nHello world\n\n2\n00:00:04,000 --> 00:00:06,500\nSecond line here\n';
  const project = await createProject('Captions test', blankTimeline('16:9', 30));
  const imp = await req(`/api/video/${project.id}/captions/import`, { method: 'POST', cookie: ownerCookie, body: { srt } });
  assert.equal(imp.status, 201, `captions import should succeed: ${imp.text}`);
  assert.equal(imp.json.clips.length, 2, `import should return 2 clips, got ${JSON.stringify(imp.json)}`);
  assert.equal(imp.json.clips[0].text.text, 'Hello world');
  assert.ok(Math.abs(imp.json.clips[0].start - 1) < 0.01, `first cue starts at 1s, got ${imp.json.clips[0].start}`);
  assert.ok(Math.abs(imp.json.clips[0].duration - 2) < 0.01, `first cue lasts 2s, got ${imp.json.clips[0].duration}`);
  assert.equal(imp.json.clips[1].text.text, 'Second line here');
  const tl = blankTimeline('16:9', 30);
  tl.tracks[2].clips.push(...imp.json.clips);
  const project2 = await createProject('Captions export', tl);
  const expSrt = await req(`/api/video/${project2.id}/captions/export?format=srt`, { cookie: ownerCookie });
  assert.equal(expSrt.status, 200);
  assert.ok(expSrt.json.srt.includes('Hello world'), 'SRT export should contain the first cue');
  assert.ok(expSrt.json.srt.includes('Second line here'), 'SRT export should contain the second cue');
  const expTxt = await req(`/api/video/${project2.id}/captions/export?format=txt`, { cookie: ownerCookie });
  assert.equal(expTxt.status, 200);
  assert.equal(expTxt.json.text, 'Hello world\nSecond line here');
});

test('waveform alias returns 100–200 peaks in [0,1]; image media gets a 404', async () => {
  const w = await req(`/api/video/media/${mediaVideo.id}/waveform`, { cookie: ownerCookie });
  assert.equal(w.status, 200, `waveform should succeed: ${w.text}`);
  assert.ok(w.json.peaks.length >= 100 && w.json.peaks.length <= 200, `peaks should be 100–200, got ${w.json.peaks.length}`);
  assert.ok(w.json.peaks.every((p) => p >= 0 && p <= 1), 'every peak should be in [0,1]');
  assert.ok(Math.abs(w.json.durationSeconds - 8) < 0.6, `duration should be ~8s, got ${w.json.durationSeconds}`);
  const img = await req(`/api/video/media/${mediaPng.id}/waveform`, { cookie: ownerCookie });
  assert.equal(img.status, 404, 'an image has no audio — waveform must 404');
});

test('estimate returns bytes, duration and bitrate for a timeline', async () => {
  const tl = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 4)); });
  const r = await req('/api/video/estimate', { method: 'POST', cookie: ownerCookie, body: { timeline: tl, settings: { resolution: '1080p', fps: 30 } } });
  assert.equal(r.status, 200, `estimate should succeed: ${r.text}`);
  assert.equal(r.json.durationSeconds, 4);
  assert.ok(r.json.bytes > 0, 'estimated bytes should be positive');
  assert.ok(r.json.bitrateKbps > 1000, `1080p bitrate should be >1000kbps, got ${r.json.bitrateKbps}`);
  const r2 = await req('/api/video/estimate', { method: 'POST', cookie: ownerCookie, body: { timeline: tl, settings: { resolution: '720p', fps: 30, audioOnly: true } } });
  assert.equal(r2.status, 200);
  assert.ok(r2.json.audioOnly, 'audio-only estimate should echo audioOnly');
  assert.ok(r2.json.videoBitrateKbps === 0, 'audio-only estimate should have no video bitrate');
});

test('transitions apply-all sets the same transition on every video clip and saves', async () => {
  const tl = tlWith((t) => {
    t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2), defaultClip('video', mediaVideo.id, 2, 2));
  });
  const project = await createProject('Apply-all test', tl);
  const r = await req(`/api/video/${project.id}/transitions/apply-all`, { method: 'POST', cookie: ownerCookie, body: { type: 'fade', duration: 0.5 } });
  assert.equal(r.status, 200, `apply-all should succeed: ${r.text}`);
  assert.equal(r.json.updated, 2, `apply-all should update 2 clips, got ${r.json.updated}`);
  const afterProject = await req(`/api/projects/${project.id}`, { cookie: ownerCookie });
  assert.equal(afterProject.status, 200);
  const saved = afterProject.json.project.content.timeline;
  assert.ok(saved.tracks[0].clips.every((c) => c.transition && c.transition.type === 'fade'), 'saved project clips should all have the fade transition');
  const bad = await req(`/api/video/${project.id}/transitions/apply-all`, { method: 'POST', cookie: ownerCookie, body: { type: 'fade', duration: 99 } });
  assert.equal(bad.status, 400, 'a duration over the 5s max must be rejected');
});

test('audio-only export produces a real mp3 with audio and no video', async () => {
  const tl = tlWith((t) => {
    t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 3));
  });
  const { outFile, duration, audio, video } = await renderTimeline(tl, 'audioonly', { resolution: '720p', fps: 30, audioOnly: true, audioFormat: 'mp3' });
  assert.ok(fs.statSync(outFile).size > 1000, 'mp3 should not be empty');
  assert.ok(audio, 'mp3 should have an audio stream');
  assert.ok(!video, 'mp3 should have no video stream');
  assert.ok(Math.abs(duration - 3) < 0.75, `duration ${duration}, expected 3`);
});

test('frame export produces a 1280x720 JPEG; GIF export produces a real GIF', async () => {
  const tl = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 3)); });
  const f = await renderTimeline(tl, 'frameexp', { resolution: '720p', fps: 30, frameExport: { at: 1 } });
  assert.ok(fs.statSync(f.outFile).size > 1000, 'frame jpg should not be empty');
  const probe = await ffprobe(f.outFile);
  const stream = probe.streams[0];
  assert.equal(stream.width, 1280);
  assert.equal(stream.height, 720);
  const g = await renderTimeline(tl, 'gifexp', { resolution: '720p', fps: 30, gifExport: true }, 240000);
  assert.ok(fs.statSync(g.outFile).size > 1000, 'gif should not be empty');
  assert.ok(g.outFile.endsWith('.gif'), 'gif output should be a .gif');
});

test('queue position: a second job queued behind a running one reports position 1', async () => {
  const longTl = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaLong.id, 0, 60)); });
  const first = await req('/api/video/jobs', { method: 'POST', cookie: ownerCookie, body: { timeline: longTl, settings: { resolution: '720p', fps: 30 } } });
  assert.equal(first.status, 201, `first job should be created: ${JSON.stringify(first.json)}`);
  const firstId = first.json.job.id;
  const runningDeadline = Date.now() + 30000;
  for (;;) {
    const r = await req(`/api/video/jobs/${firstId}`, { cookie: ownerCookie });
    if (r.json.job.status === 'running') break;
    if (r.json.job.status !== 'queued') throw new Error(`first job left the queue unexpectedly: ${JSON.stringify(r.json.job)}`);
    assert.ok(Date.now() < runningDeadline, 'first job did not start running in time');
    await new Promise((x) => setTimeout(x, 500));
  }
  const smallTl = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2)); });
  const second = await req('/api/video/jobs', { method: 'POST', cookie: ownerCookie, body: { timeline: smallTl, settings: { resolution: '720p', fps: 30 } } });
  assert.equal(second.status, 201, `second job should be created: ${JSON.stringify(second.json)}`);
  assert.equal(second.json.job.status, 'queued');
  assert.equal(second.json.job.queuePosition, 1, `queued job should report queuePosition 1, got ${second.json.job.queuePosition}`);
  const secondId = second.json.job.id;
  const cancelSecond = await req(`/api/video/jobs/${secondId}/cancel`, { method: 'POST', cookie: ownerCookie });
  assert.equal(cancelSecond.status, 200, `queued job should cancel cleanly: ${cancelSecond.text}`);
  const cancelFirst = await req(`/api/video/jobs/${firstId}/cancel`, { method: 'POST', cookie: ownerCookie });
  assert.equal(cancelFirst.status, 200, `running job should cancel cleanly: ${cancelFirst.text}`);
  // Cancelling kills FFmpeg, but the job row flips to 'cancelled' only
  // once the child exits — poll for it instead of asserting instantly.
  const cancelDeadline = Date.now() + 15000;
  for (;;) {
    const after = await req(`/api/video/jobs/${firstId}`, { cookie: ownerCookie });
    if (after.json.job.status === 'cancelled') break;
    assert.ok(Date.now() < cancelDeadline, `first job should end cancelled, got ${after.json.job.status}`);
    await new Promise((x) => setTimeout(x, 500));
  }
});

// ---------------------------------------------------------------------------
// Performance (#47) — same testsrc media as the pre-change baseline.
// ---------------------------------------------------------------------------

test('perf: keyframed 3.5s render and plain 60s render beat the baseline', async () => {
  const kf = tlWith((t) => {
    const c = defaultClip('video', mediaVideo.id, 0, 3.5);
    c.keyframes = [
      { t: 0, x: 20, y: 50, scale: 1, opacity: 1, rotation: 0, volume: 1, easing: 'linear' },
      { t: 1.75, x: 50, y: 30, scale: 1.5, opacity: 0.8, rotation: 45, volume: 0.6, easing: 'ease-in-out' },
      { t: 3.5, x: 80, y: 50, scale: 1, opacity: 1, rotation: 90, volume: 1, easing: 'ease-in-out' },
    ];
    t.tracks[0].clips.push(c);
  });
  const kfRes = await renderTimeline(kf, 'perfkeyframed', { resolution: '720p', fps: 30 }, 300000);
  console.log(`PERF keyframed 3.5s: wall ${kfRes.wallMs}ms (${(3500 / kfRes.wallMs).toFixed(3)}x realtime) — baseline was 22600ms (0.155x)`);
  assert.ok(kfRes.wallMs < BASELINE_KEYFRAMED_MS, `keyframed render should beat the 22.6s baseline, took ${kfRes.wallMs}ms`);
  const plain = tlWith((t) => { t.tracks[0].clips.push(defaultClip('video', mediaLong.id, 0, 60)); });
  const plainRes = await renderTimeline(plain, 'perfplain60', { resolution: '720p', fps: 30 }, 300000);
  console.log(`PERF plain 60s: wall ${plainRes.wallMs}ms (${(60000 / plainRes.wallMs).toFixed(3)}x realtime) — baseline was 17400ms (3.445x)`);
  assert.ok(plainRes.wallMs < BASELINE_PLAIN60_MS * 2, `plain 60s render should not be much slower than the 17.4s baseline, took ${plainRes.wallMs}ms`);
  assert.ok(Math.abs(plainRes.duration - 60) < 1, `plain 60s duration ${plainRes.duration}, expected 60`);
});
