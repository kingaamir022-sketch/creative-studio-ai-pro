// parity-editor-250.test.js — v2.5.0 editor slice: bundled sticker library,
// editor-shell UI markers, honest voice/stock-video refusals, and the new
// video-capability lists + timeline-model invariants the editor depends on
// (volume 0–2, N video tracks, keyframe rotation/volume/easing, compound
// clips, effect/adjustment tracks, render estimate, audio waveform).
// Spawns the real server on a scratch port (4853) with a temp DB/uploads/
// renders/models — exactly like the other parity tests, so it never touches
// live data. No provider keys are set here on purpose: the TTS and stock
// video calls below must FAIL honestly.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const PORT = 4853;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-editor250-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const modelsDir = path.join(tmp, 'models');
for (const d of [uploadsDir, rendersDir, modelsDir]) fs.mkdirSync(d, { recursive: true });

let server;
let ownerCookie = '';

async function req(p, opts = {}) {
  const headers = { ...(opts.cookie ? { cookie: opts.cookie } : {}) };
  let body;
  if (opts.form) { body = opts.form; }
  else if (opts.body) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const r = await fetch(BASE + p, { method: opts.method || 'GET', headers, body });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: r.status, text, json, headers: r.headers };
}

function ffprobe(file) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', file],
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
}

function makeTestVideo(file, seconds, tone) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x180:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
    { timeout: 60000 });
}

function makeToneAudio(file, seconds) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:a', 'libmp3lame', '-q:a', '4', file], { timeout: 60000 });
}

async function uploadFile(name, buf, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), name);
  const r = await req('/api/media/upload', { method: 'POST', cookie: ownerCookie, form: fd });
  assert.equal(r.status, 201, `upload ${name} should be accepted: ${r.text}`);
  return r.json.media;
}

function blankTimeline() {
  return {
    width: 1280, height: 720, fps: 30,
    background: '#000000',
    tracks: [
      { id: 'track-main', kind: 'video', name: 'Main', locked: false, muted: false, clips: [] },
      { id: 'track-audio', kind: 'audio', name: 'Audio', locked: false, muted: false, clips: [] },
      { id: 'track-text', kind: 'text', name: 'Text', locked: false, muted: false, clips: [] },
    ],
    markers: [],
  };
}

function videoClip(mediaId, start, duration, extra = {}) {
  return {
    id: 'clip-' + Math.random().toString(36).slice(2, 8), kind: 'video', mediaId,
    start, duration, srcStart: 0, speed: 1, volume: 1, muted: false,
    // Base fields the v2.5.0 validator requires (mirror src/video-model.js defaultClip).
    fadeIn: 0, fadeOut: 0, rotation: 0, flip: 'none', opacity: 1, scaleMode: 'fit', zoom: 1,
    filters: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, blur: 0, vignette: 0 },
    effects: [], filterPreset: 'none',
    lutMediaId: null, chroma: { enabled: false, color: '#00ff00', similarity: 0.4, blend: 0.1 },
    speedCurve: { preset: 'none', points: [] }, stabilize: { enabled: false, strength: 0.5 },
    mask: { type: 'none', x: 50, y: 50, w: 60, h: 60, rotation: 0, feather: 10, invert: false },
    reverse: false, freeze: { enabled: false, at: 0, duration: 3 },
    audioFx: { denoise: false, enhanceVoice: false, vocalIsolation: 'off', loudnorm: false, ducking: false },
    autoReframe: { enabled: false, targetAspect: '9:16' }, opticalFlow: false,
    overlay: null, linkedTo: null, splitScreen: { enabled: false, partnerClipId: null },
    keyframes: [], transitions: { in: null, out: null }, fade: { in: 0, out: 0 },
    ...extra,
  };
}

let mediaVideo;
let mediaAudio;

before(async () => {
  const vidPath = path.join(tmp, 'clip.mp4');
  makeTestVideo(vidPath, 4, 440);
  const audioPath = path.join(tmp, 'tone.mp3');
  makeToneAudio(audioPath, 3);
  const env = {
    ...process.env,
    DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, MODELS_DIR: modelsDir,
    PORT: String(PORT), HOST: '127.0.0.1', RENDER_WATCHDOG_MS: '120000',
  };
  server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) break;
    } catch { /* not up yet */ }
    assert.ok(Date.now() < deadline, `server did not start in 20s: ${out}`);
    await new Promise((x) => setTimeout(x, 200));
  }
  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'Editor Tester', email: 'editor250@test.local', password: 'password123' } });
  assert.equal(s.status, 201, `signup should succeed: ${s.text}`);
  ownerCookie = s.headers.get('set-cookie') || '';
  assert.ok(ownerCookie, 'signup should set a session cookie');
  mediaVideo = await uploadFile('clip.mp4', fs.readFileSync(vidPath), 'video/mp4');
  mediaAudio = await uploadFile('tone.mp3', fs.readFileSync(audioPath), 'audio/mpeg');
});

after(() => {
  if (server) server.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('bundled sticker library: index lists 20 stickers, each SVG serves', async () => {
  const idx = await req('/stickers/index.json');
  assert.equal(idx.status, 200, `sticker index should serve: ${idx.text}`);
  assert.equal(idx.json.stickers.length, 20, '20 bundled stickers expected');
  for (const s of idx.json.stickers) {
    assert.ok(s.id && s.file && (s.name || s.label), `sticker entry complete: ${JSON.stringify(s)}`);
    const svg = await req(s.file.startsWith('/') ? s.file : `/stickers/${s.file}`);
    assert.equal(svg.status, 200, `sticker ${s.file} should serve`);
    assert.ok(svg.headers.get('content-type').includes('svg'), `sticker ${s.file} is SVG`);
    assert.ok(svg.text.includes('<svg'), `sticker ${s.file} has SVG content`);
  }
});

test('editor bundle carries the v2.5.0 UI surface (shortcuts, waveforms, effects, export breadth)', async () => {
  const r = await req('/video-editor.js');
  assert.equal(r.status, 200, 'video-editor.js should serve');
  const markers = [
    'DEFAULT_SHORTCUTS', 've-subtabs', 'waveformBars', 'extractAudio',
    'makeCompound', 'speedCurve', 'chroma', 'stabilize', 'captionStyle',
    'filterPresets', 'exportPresets', 've-safezones', 've-overlays',
    'showShortcutsPanel', 'showBackgroundDialog', 'splitCaptionAtPlayhead',
    've-compound-bar', 'Audio-only', 'Estimate size', 'GIF (3s from playhead)',
  ];
  for (const m of markers) assert.ok(r.text.includes(m), `video-editor.js must contain ${m}`);
  const css = await req('/video-editor.css');
  assert.equal(css.status, 200, 'video-editor.css should serve');
  for (const m of ['.ve-subtabs', '.ve-wave', '.ve-compound-bar', '.ve-preview-ctl', '.ve-clip.compound']) {
    assert.ok(css.text.includes(m), `video-editor.css must contain ${m}`);
  }
});

test('TTS without a provider key refuses honestly (no fake audio)', async () => {
  const r = await req('/api/voice/synthesise', { method: 'POST', cookie: ownerCookie, body: { text: 'Hello world' } });
  assert.ok([400, 503].includes(r.status), `synthesise without a voice profile/key must fail honestly: ${r.status} ${r.text}`);
  assert.ok(!r.json || !r.json.mediaId, 'no media id should be returned on a failed synthesis');
});

test('stock video without a Pexels key refuses honestly (NO_VIDEO_SEARCH)', async () => {
  const r = await req('/api/stock/search?type=video&q=ocean&page=1', { cookie: ownerCookie });
  assert.equal(r.status, 400, `stock video without a Pexels key must 400: ${r.status} ${r.text}`);
  assert.equal(r.json.code, 'NO_VIDEO_SEARCH', 'error code must name NO_VIDEO_SEARCH');
});

test('effects endpoint lists video effects, filter presets and export presets', async () => {
  const r = await req('/api/video/effects', { cookie: ownerCookie });
  assert.equal(r.status, 200, `effects endpoint should respond: ${r.text}`);
  assert.ok(Array.isArray(r.json.transitions) && r.json.transitions.length >= 4, 'transitions listed');
  assert.ok(Array.isArray(r.json.filters) && r.json.filters.length >= 7, 'filters listed');
  assert.ok(Array.isArray(r.json.effects) && r.json.effects.length >= 12, '>=12 video effects listed');
  assert.ok(Array.isArray(r.json.filterPresets) && r.json.filterPresets.length >= 1, 'filter presets listed');
  assert.ok(Array.isArray(r.json.speedCurvePresets) && r.json.speedCurvePresets.length >= 1, 'speed-curve presets listed');
  assert.ok(Array.isArray(r.json.exportPresets) && r.json.exportPresets.length >= 1, 'export presets listed');
});

test('timeline validation: volume up to 2, speed 0.1, 3 video tracks, keyframe rotation+volume+easing', async () => {
  const tl = blankTimeline();
  tl.tracks.splice(1, 0,
    { id: 'track-ov1', kind: 'video', name: 'Overlay 1', locked: false, muted: false, clips: [] },
    { id: 'track-ov2', kind: 'video', name: 'Overlay 2', locked: false, muted: false, clips: [] });
  tl.tracks[0].clips.push(videoClip(mediaVideo.id, 0, 4, {
    volume: 2, speed: 0.1,
    keyframes: [
      { t: 0, x: 0, y: 0, scale: 1, opacity: 1, rotation: 0, volume: 0.5, easing: 'ease-in' },
      { t: 4, x: 0, y: 0, scale: 1, opacity: 1, rotation: 90, volume: 2, easing: 'ease-out' },
    ],
  }));
  const r = await req('/api/video/validate', { method: 'POST', cookie: ownerCookie, body: { timeline: tl } });
  assert.equal(r.status, 200, `validation should pass: ${r.text}`);
  assert.equal(r.json.valid, true, `validation must be valid: ${r.text}`);
});

test('timeline validation: compound clip and effect (adjustment) track validate', async () => {
  const tl = blankTimeline();
  const nested = blankTimeline();
  nested.tracks[0].clips.push(videoClip(mediaVideo.id, 0, 2));
  tl.tracks[0].clips.push({
    id: 'clip-compound', kind: 'compound', mediaId: null,
    start: 0, duration: 2, srcStart: 0, speed: 1, volume: 1, muted: false,
    fadeIn: 0, fadeOut: 0, rotation: 0, flip: 'none', opacity: 1, scaleMode: 'fit', zoom: 1,
    filters: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, blur: 0, vignette: 0 },
    keyframes: [], nested,
  });
  tl.tracks.push({ id: 'track-fx', kind: 'effect', name: 'Adjustment', locked: false, muted: false, clips: [
    { id: 'clip-fx', kind: 'effect', mediaId: null, start: 0, duration: 2, srcStart: 0, speed: 1, volume: 1, muted: false,
      fadeIn: 0, fadeOut: 0, rotation: 0, flip: 'none', opacity: 1, scaleMode: 'fit', zoom: 1,
      filters: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, blur: 0, vignette: 0 },
      effectId: 'blur', intensity: 0.7, keyframes: [] },
  ] });
  const r = await req('/api/video/validate', { method: 'POST', cookie: ownerCookie, body: { timeline: tl } });
  assert.equal(r.status, 200, `compound+effect validation should pass: ${r.text}`);
  assert.equal(r.json.valid, true, `compound+effect must be valid: ${r.text}`);
});

test('render estimate returns a size for a real timeline', async () => {
  const tl = blankTimeline();
  tl.tracks[0].clips.push(videoClip(mediaVideo.id, 0, 4));
  const r = await req('/api/video/estimate', { method: 'POST', cookie: ownerCookie, body: { timeline: tl, settings: { resolution: '1080p', fps: 30 } } });
  assert.equal(r.status, 200, `estimate should respond: ${r.text}`);
  assert.ok(r.json.bytes > 0, `estimate bytes positive: ${JSON.stringify(r.json)}`);
  assert.ok(r.json.durationSeconds > 0, `estimate duration positive: ${JSON.stringify(r.json)}`);
});

test('audio waveform: peaks for an uploaded audio file, 404 for video-only media', async () => {
  const w = await req(`/api/media/${mediaAudio.id}/waveform`, { cookie: ownerCookie });
  assert.equal(w.status, 200, `waveform should respond: ${w.text}`);
  assert.ok(Array.isArray(w.json.peaks) && w.json.peaks.length >= 100, `peaks array present: ${JSON.stringify(w.json).slice(0, 120)}`);
  assert.ok(w.json.peaks.every((p) => p >= 0 && p <= 1), 'peaks are 0..1');
  assert.ok(w.json.durationSeconds > 0, 'waveform duration positive');
  const v = await req(`/api/media/${mediaVideo.id}/waveform`, { cookie: ownerCookie });
  assert.ok([200, 404].includes(v.status), `video waveform is 200 (has audio) or 404: ${v.status}`);
});
