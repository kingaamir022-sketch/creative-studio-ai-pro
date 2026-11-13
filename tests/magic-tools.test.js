'use strict';
// Magic Tools tests (v2.2.2, Release A) — run with: npm test
// Spawns the real server on a scratch port (4844) with a temp DB/uploads
// dir, PLUS a local MOCK provider HTTP server (random port) that speaks
// the real provider APIs (OpenAI Images edits + Chat completions). The
// segmentation model is MOCKED (CS_SEGMENTATION_MOCK=1): no real model
// download happens — the mock returns a deterministic centred-rectangle
// mask (foreground = middle 50% of the frame, 25% of the pixels).
// Covers: Magic Resize reflow (in-bounds, text fits via the project's own
// fitText, attention flagged for un-fittable text, invalid target 400,
// anon 401); Magic Animate presets (list, design + clip apply, design-only
// typewriter refused for clips, unknown preset 400, anon 401); local model
// status; Eraser/Expand honest behaviour (no-key 402 PROVIDER_KEY_NEEDED
// with no output, local solid/blur expand producing real ffprobe-valid
// PNGs at the target size, erase working against the mock); Background
// Remover with the mock model (transparent cutout with alpha, mask saved,
// foreground 25%); Magic Grab (inside click lifts the subject, outside
// click 400 NO_OBJECT_AT_POINT, isolation); Magic Write (no-key job fails
// key_needed with no output, with-mock-LLM job returns text + alternatives);
// per-user isolation + anonymous 401 on magic routes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile, execFileSync } = require('child_process');
const { fitText } = require('../src/quiz-model');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-magic-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4844;
const BASE = `http://127.0.0.1:${PORT}`;

const PNG_1X1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server;
let mockServer;
let mockPort;
let ownerCookie = '';
let userCookie = '';
let testImage;
let testMask;
let srcImage;

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
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt', '-of', 'json', file],
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
}

function makeTestImage(file, color = 'red', size = '320x180') {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=1`, '-frames:v', '1', file], { timeout: 30000 });
}

// OpenAI-format mask: opaque white everywhere, transparent hole where the
// user painted (the region to erase). Built with geq so the hole is real
// alpha, not just dark pixels.
function makeTestMask(file) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x180:d=1',
    '-vf', "format=rgba,geq=lum=255:a='if(between(X,110,209)*between(Y,60,119),0,255)'",
    '-frames:v', '1', file], { timeout: 30000 });
}

async function uploadMedia(file, name, mime, cookie) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime }), name);
  const r = await req('/api/media/upload', { method: 'POST', cookie: cookie || ownerCookie, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.media;
}

async function countMedia(cookie) {
  const r = await req('/api/media?limit=100', { cookie: cookie || ownerCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return (r.json.media || []).length;
}

async function downloadMediaFile(mediaId, cookie) {
  const r = await fetch(`${BASE}/api/media/${mediaId}/file`, { headers: { cookie: cookie || ownerCookie }, redirect: 'manual' });
  assert.equal(r.status, 200, `download media ${mediaId}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function runAiJob(mode, params, cookie) {
  const created = await req('/api/ai/jobs', { method: 'POST', cookie: cookie || ownerCookie, body: { mode, name: `test-${mode}`, ...params } });
  assert.equal(created.status, 201, `create ${mode} job: ${JSON.stringify(created.json)}`);
  const jobId = created.json.job.id;
  const deadline = Date.now() + 180000;
  for (;;) {
    const r = await req(`/api/ai/jobs/${jobId}`, { cookie: cookie || ownerCookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const job = r.json.job;
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`AI job ${jobId} (${mode}) did not finish; last ${JSON.stringify(job)}`);
    await new Promise((x) => setTimeout(x, 500));
  }
}

// --- Local mock provider ----------------------------------------------------
// Only the two endpoints Magic Tools needs: OpenAI image edits (Eraser,
// AI Expand) and chat completions (Magic Write). Everything else 404s.
function mockHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  let body = Buffer.alloc(0);
  req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body.toString('utf8')); } catch { json = null; }
    const userText = json && json.messages ? json.messages.map((m) => m.content || '').join('\n') : '';
    if (req.method === 'POST' && p === '/images/edits') {
      return sendJson(200, { created: 1, data: [{ b64_json: PNG_1X1_B64 }] });
    }
    if (req.method === 'POST' && p === '/chat/completions') {
      if (userText.includes('Magic Write')) {
        return sendJson(200, { choices: [{ message: { content: JSON.stringify({
          text: 'Summer Sale — 50% off all sneakers this week only. Shop now before sizes run out!',
          alternatives: ['Half price sneakers, this week only.', 'Your favourite sneakers, now 50% off.'],
        }) } }] });
      }
      return sendJson(200, { choices: [{ message: { content: '{"ok":true}' } }] });
    }
    if (req.method === 'GET' && p === '/models') return sendJson(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'dall-e-3' }] });
    return sendJson(404, { error: `mock: no route ${req.method} ${p}` });
  });
}

function testDesign() {
  return {
    version: 1, width: 1080, height: 1080,
    background: { type: 'color', color: '#151d3a', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } },
    layers: [
      {
        id: 'layer-text', type: 'text', name: 'Headline', x: 240, y: 200, w: 600, h: 90,
        rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null,
        text: {
          text: 'Summer Sale', fontFamily: 'Poppins', fontSize: 64, fontWeight: 700,
          fontStyle: 'normal', underline: false, align: 'center', color: '#ffffff',
          letterSpacing: 0, lineHeight: 1.2, shadow: null, stroke: null, gradient: null,
        },
      },
      {
        id: 'layer-shape', type: 'shape', name: 'Rectangle', x: 140, y: 800, w: 800, h: 120,
        rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null,
        shape: { kind: 'rect', fill: '#7c5cff', stroke: '', strokeWidth: 0, radius: 12, shadow: null },
      },
    ],
  };
}

before(async () => {
  testImage = path.join(tmp, 'test.png');
  testMask = path.join(tmp, 'mask.png');
  makeTestImage(testImage, 'red', '320x180');
  makeTestMask(testMask);

  mockServer = http.createServer(mockHandler);
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;

  const env = {
    ...process.env,
    DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir,
    PORT: String(PORT), HOST: '127.0.0.1',
    CS_SEGMENTATION_MOCK: '1',
  };
  server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
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

  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'Magic Tester', email: 'magic@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  ownerCookie = s.setCookie.split(';')[0];

  const u = await req('/api/auth/signup', { method: 'POST', body: { name: 'Second User', email: 'second-magic@test.local', password: 'password123' } });
  assert.equal(u.status, 201, JSON.stringify(u.json));
  userCookie = u.setCookie.split(';')[0];

  srcImage = await uploadMedia(testImage, 'src.png', 'image/png');
});

after(async () => {
  if (server) server.kill('SIGKILL');
  if (mockServer) await new Promise((r) => mockServer.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function configureMockLlmAndImage() {
  const mockBase = `http://127.0.0.1:${mockPort}`;
  for (const id of ['llm', 'image']) {
    const cfg = await req(`/api/providers/${id}/config`, { method: 'POST', cookie: ownerCookie, body: { baseUrl: mockBase } });
    assert.equal(cfg.status, 200, `config ${id}: ${JSON.stringify(cfg.json)}`);
    const key = await req(`/api/providers/${id}/key`, { method: 'POST', cookie: ownerCookie, body: { key: 'mock-test-key-12345' } });
    assert.equal(key.status, 200, `key ${id}: ${JSON.stringify(key.json)}`);
  }
}

// --- Local model status -------------------------------------------------------
test('model status reports the free local model (mocked in tests)', async () => {
  const r = await req('/api/magic/model/status', { cookie: ownerCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.mock, true, 'tests run with the mocked segmentation model');
  assert.equal(r.json.status, 'ready', JSON.stringify(r.json));
  assert.equal(r.json.model, 'BritishWerewolf/U-2-Net', JSON.stringify(r.json));
  assert.ok(r.json.sizeMB >= 160 && r.json.sizeMB <= 180, `model size ~168 MB: ${r.json.sizeMB}`);
  const dl = await req('/api/magic/model/download', { method: 'POST', cookie: ownerCookie });
  assert.equal(dl.status, 200, JSON.stringify(dl.json));
  assert.equal(dl.json.status, 'ready', 'a ready model must not start a download');
  const anon = await req('/api/magic/model/status');
  assert.equal(anon.status, 401, 'anonymous model status must be refused');
});

// --- Magic Resize -------------------------------------------------------------
test('Magic Resize reflows a design: layers stay in-bounds, text fits', async () => {
  const r = await req('/api/magic/resize', {
    method: 'POST', cookie: ownerCookie,
    body: { design: testDesign(), targetSizeId: 'instagram-story' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.report.to.width, 1080, JSON.stringify(r.json.report));
  assert.equal(r.json.report.to.height, 1920, JSON.stringify(r.json.report));
  assert.equal(r.json.design.width, 1080);
  assert.equal(r.json.design.height, 1920);
  assert.deepEqual(r.json.report.needsAttention, [], 'a reasonable design must need no attention');
  for (const layer of r.json.design.layers) {
    assert.ok(layer.x >= 0 && layer.y >= 0, `layer ${layer.id} must not go off-canvas left/top`);
    assert.ok(layer.x + layer.w <= 1080 + 0.01, `layer ${layer.id} must stay inside the new width`);
    assert.ok(layer.y + layer.h <= 1920 + 0.01, `layer ${layer.id} must stay inside the new height`);
    if (layer.type === 'text') {
      assert.ok(layer.text.fontSize >= 12, 'text must never shrink below the readable minimum');
      // Independent check with the project's own fitText: the fitted text
      // height must fit inside the (possibly grown) box.
      const lineHeight = layer.text.lineHeight || 1.2;
      const maxLines = Math.max(1, Math.floor(layer.h / Math.max(1, layer.text.fontSize * lineHeight)));
      const fit = fitText(layer.text.text, layer.w, { maxFont: layer.text.fontSize, minFont: 12, maxLines, lineHeight });
      assert.ok(fit.heightPx <= layer.h + 1, `text "${layer.text.text}" must fit its box: ${fit.heightPx}px in ${layer.h}px`);
    }
  }
  // Same-size resize is a no-op copy (input never mutated).
  const same = await req('/api/magic/resize', {
    method: 'POST', cookie: ownerCookie,
    body: { design: testDesign(), targetWidth: 1080, targetHeight: 1080 },
  });
  assert.equal(same.status, 200, JSON.stringify(same.json));
  assert.deepEqual(same.json.design, testDesign(), 'same-size resize must return the design unchanged');
});

test('Magic Resize flags un-fittable text as Needs attention (never broken)', async () => {
  const d = testDesign();
  d.layers[0].text.text = 'A'.repeat(1200);
  d.layers[0].w = 200;
  d.layers[0].h = 60;
  const r = await req('/api/magic/resize', {
    method: 'POST', cookie: ownerCookie,
    body: { design: d, targetWidth: 1080, targetHeight: 1920 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.report.needsAttention.length >= 1, 'absurdly long text must be flagged');
  assert.equal(r.json.report.needsAttention[0].layerId, 'layer-text', JSON.stringify(r.json.report));
  assert.ok(r.json.report.needsAttention[0].suggestedText, 'flagged text must carry a shorter suggestion');
});

test('Magic Resize rejects bad input and anonymous callers', async () => {
  const badSize = await req('/api/magic/resize', {
    method: 'POST', cookie: ownerCookie,
    body: { design: testDesign(), targetWidth: 0, targetHeight: 100 },
  });
  assert.equal(badSize.status, 400, JSON.stringify(badSize.json));
  const badPreset = await req('/api/magic/resize', {
    method: 'POST', cookie: ownerCookie,
    body: { design: testDesign(), targetSizeId: 'not-a-size' },
  });
  assert.equal(badPreset.status, 400, JSON.stringify(badPreset.json));
  const anon = await req('/api/magic/resize', {
    method: 'POST', body: { design: testDesign(), targetWidth: 1080, targetHeight: 1920 },
  });
  assert.equal(anon.status, 401, 'anonymous resize must be refused');
});

// --- Magic Animate ------------------------------------------------------------
test('Magic Animate presets exist and apply to a design layer', async () => {
  const list = await req('/api/magic/animate/presets', { cookie: ownerCookie });
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.ok(list.json.presets.length >= 8, `at least 8 presets expected, got ${list.json.presets.length}`);
  const ids = list.json.presets.map((p) => p.id);
  for (const want of ['fade', 'slide-up', 'pop', 'bounce', 'typewriter']) {
    assert.ok(ids.includes(want), `preset ${want} must exist`);
  }
  const clips = await req('/api/magic/animate/presets?target=clip', { cookie: ownerCookie });
  assert.equal(clips.status, 200, JSON.stringify(clips.json));
  assert.ok(!clips.json.presets.some((p) => p.id === 'typewriter'), 'typewriter is design-only and must never be offered for clips');

  const r = await req('/api/magic/animate', {
    method: 'POST', cookie: ownerCookie,
    body: { design: testDesign(), layerId: 'layer-text', presetId: 'fade' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.animation.presetId, 'fade', JSON.stringify(r.json));
  assert.ok(r.json.animation.durationMs > 0, 'preset must carry a duration');
  assert.ok(Array.isArray(r.json.animation.keyframes) && r.json.animation.keyframes.length >= 2, 'preset must carry keyframes');
  for (const k of r.json.animation.keyframes) {
    assert.ok(k.offset >= 0 && k.offset <= 1, `keyframe offset must be 0..1: ${JSON.stringify(k)}`);
  }
  const layer = r.json.design.layers.find((l) => l.id === 'layer-text');
  assert.equal(layer.animation.presetId, 'fade', 'the design must carry the animation on the layer');
  // The other layer is untouched.
  const other = r.json.design.layers.find((l) => l.id === 'layer-shape');
  assert.equal(other.animation, undefined, 'other layers must not gain an animation');
});

test('Magic Animate expands a preset into clip keyframes held to the clip end', async () => {
  const clip = { text: { text: 'Hello', x: 50, y: 50 }, duration: 3, keyframes: [] };
  const r = await req('/api/magic/animate', {
    method: 'POST', cookie: ownerCookie,
    body: { clip, presetId: 'pop' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.keyframes.length >= 2, JSON.stringify(r.json));
  for (const k of r.json.keyframes) {
    assert.ok(k.t >= 0 && k.t <= 3, `clip keyframe t must be within the clip: ${JSON.stringify(k)}`);
  }
  const last = r.json.keyframes[r.json.keyframes.length - 1];
  assert.equal(last.t, 3, 'the final state must be held to the end of the clip');
  assert.equal(r.json.clip.animationPreset, 'pop');
});

test('Magic Animate refuses unknown presets, design-only presets on clips, and anonymous callers', async () => {
  const bad = await req('/api/magic/animate', {
    method: 'POST', cookie: ownerCookie,
    body: { design: testDesign(), layerId: 'layer-text', presetId: 'nope' },
  });
  assert.equal(bad.status, 400, JSON.stringify(bad.json));
  const tw = await req('/api/magic/animate', {
    method: 'POST', cookie: ownerCookie,
    body: { clip: { text: { text: 'Hi', x: 50, y: 50 }, duration: 3, keyframes: [] }, presetId: 'typewriter' },
  });
  assert.equal(tw.status, 400, 'typewriter must be refused for clips: ' + JSON.stringify(tw.json));
  const missing = await req('/api/magic/animate', {
    method: 'POST', cookie: ownerCookie,
    body: { design: testDesign(), layerId: 'no-such-layer', presetId: 'fade' },
  });
  assert.equal(missing.status, 404, JSON.stringify(missing.json));
  const anon = await req('/api/magic/animate/presets');
  assert.equal(anon.status, 401, 'anonymous preset list must be refused');
});

// --- Eraser / Expand: honest no-key behaviour + local modes ------------------
test('Eraser and AI Expand refuse without a key (402) and create nothing', async () => {
  const beforeCount = await countMedia();
  const maskDataUrl = `data:image/png;base64,${fs.readFileSync(testMask).toString('base64')}`;
  const erase = await req('/api/magic/erase', {
    method: 'POST', cookie: ownerCookie,
    body: { mediaId: srcImage.id, mask: maskDataUrl },
  });
  assert.equal(erase.status, 402, JSON.stringify(erase.json));
  assert.equal(erase.json.code, 'PROVIDER_KEY_NEEDED', JSON.stringify(erase.json));
  const expandAi = await req('/api/magic/expand', {
    method: 'POST', cookie: ownerCookie,
    body: { mediaId: srcImage.id, targetWidth: 640, targetHeight: 360, mode: 'ai' },
  });
  assert.equal(expandAi.status, 402, JSON.stringify(expandAi.json));
  assert.equal(expandAi.json.code, 'PROVIDER_KEY_NEEDED', JSON.stringify(expandAi.json));
  assert.equal(await countMedia(), beforeCount, 'refused magic calls must create no media');
});

test('Expand solid and blur work locally with no key (real PNGs at target size)', async () => {
  for (const mode of ['solid', 'blur']) {
    const r = await req('/api/magic/expand', {
      method: 'POST', cookie: ownerCookie,
      body: { mediaId: srcImage.id, targetWidth: 640, targetHeight: 360, mode, fill: '#112233' },
    });
    assert.equal(r.status, 201, `${mode}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.mode, mode, JSON.stringify(r.json));
    assert.equal(r.json.width, 640, JSON.stringify(r.json));
    assert.equal(r.json.height, 360, JSON.stringify(r.json));
    assert.equal(r.json.provider, 'local-ffmpeg', 'solid/blur expand must be labelled local');
    const buf = await downloadMediaFile(r.json.media.id);
    const tmpFile = path.join(tmp, `expand-${mode}.png`);
    fs.writeFileSync(tmpFile, buf);
    const info = await ffprobe(tmpFile);
    assert.equal(info.streams[0].width, 640, `${mode} file width`);
    assert.equal(info.streams[0].height, 360, `${mode} file height`);
  }
  const tooSmall = await req('/api/magic/expand', {
    method: 'POST', cookie: ownerCookie,
    body: { mediaId: srcImage.id, targetWidth: 100, targetHeight: 100, mode: 'solid' },
  });
  assert.equal(tooSmall.status, 400, 'expand must refuse a target smaller than the source');
});

// --- Background Remover + Grab (mock model) ----------------------------------
let bgCutout;
let bgMask;
test('Background Remover with the mock model returns a transparent cutout + mask', async () => {
  const r = await req('/api/magic/remove-background', {
    method: 'POST', cookie: ownerCookie, body: { mediaId: srcImage.id },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.width, 320, JSON.stringify(r.json));
  assert.equal(r.json.height, 180, JSON.stringify(r.json));
  assert.equal(r.json.foregroundFraction, 0.25, 'mock mask is 25% foreground');
  assert.equal(r.json.local, true, 'background removal must be labelled local');
  bgCutout = r.json.media;
  bgMask = r.json.maskMedia;
  assert.ok(bgCutout.id && bgMask.id, 'cutout and mask media must be returned');
  const buf = await downloadMediaFile(bgCutout.id);
  const tmpFile = path.join(tmp, 'cutout.png');
  fs.writeFileSync(tmpFile, buf);
  const info = await ffprobe(tmpFile);
  assert.equal(info.streams[0].width, 320, 'cutout width must match the source');
  assert.equal(info.streams[0].height, 180, 'cutout height must match the source');
  assert.ok(String(info.streams[0].pix_fmt || '').includes('a'), `cutout must have an alpha channel: ${info.streams[0].pix_fmt}`);
});

test('Magic Grab lifts the subject on an inside click, refuses background clicks', async () => {
  const r = await req('/api/magic/grab', {
    method: 'POST', cookie: ownerCookie,
    body: { mediaId: srcImage.id, maskMediaId: bgMask.id, x: 160, y: 90 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  // Mock mask rect scaled to 320x180: x=80, y=45, w=160, h=90 (allow a
  // pixel of scale bleed either way).
  assert.ok(Math.abs(r.json.bbox.x - 80) <= 3, `bbox.x ~80: ${JSON.stringify(r.json.bbox)}`);
  assert.ok(Math.abs(r.json.bbox.y - 45) <= 3, `bbox.y ~45: ${JSON.stringify(r.json.bbox)}`);
  assert.ok(Math.abs(r.json.bbox.w - 160) <= 4, `bbox.w ~160: ${JSON.stringify(r.json.bbox)}`);
  assert.ok(Math.abs(r.json.bbox.h - 90) <= 4, `bbox.h ~90: ${JSON.stringify(r.json.bbox)}`);
  assert.equal(r.json.media.width, r.json.bbox.w, 'grabbed media width must equal the bbox');
  assert.equal(r.json.media.height, r.json.bbox.h, 'grabbed media height must equal the bbox');
  const buf = await downloadMediaFile(r.json.media.id);
  const tmpFile = path.join(tmp, 'grab.png');
  fs.writeFileSync(tmpFile, buf);
  const info = await ffprobe(tmpFile);
  assert.equal(info.streams[0].width, r.json.bbox.w, 'grabbed file width must match the bbox');
  assert.equal(info.streams[0].height, r.json.bbox.h, 'grabbed file height must match the bbox');
  assert.ok(String(info.streams[0].pix_fmt || '').includes('a'), 'grabbed layer must have an alpha channel');

  const outside = await req('/api/magic/grab', {
    method: 'POST', cookie: ownerCookie,
    body: { mediaId: srcImage.id, maskMediaId: bgMask.id, x: 10, y: 10 },
  });
  assert.equal(outside.status, 400, JSON.stringify(outside.json));
  assert.equal(outside.json.code, 'NO_OBJECT_AT_POINT', JSON.stringify(outside.json));
  const noMask = await req('/api/magic/grab', {
    method: 'POST', cookie: ownerCookie,
    body: { mediaId: srcImage.id, x: 160, y: 90 },
  });
  assert.equal(noMask.status, 400, 'grab without a mask must be refused');
});

// --- Magic Write ---------------------------------------------------------------
test('Magic Write refuses without an LLM key (no output)', async () => {
  const beforeCount = await countMedia();
  const job = await runAiJob('write', { prompt: 'A summer sale for a shoe store, 50% off sneakers', task: 'headline', tone: 'professional', length: 'short' });
  assert.equal(job.status, 'failed', JSON.stringify(job));
  assert.match(job.error, /no API key|key needed|not configured/i, `refusal must name the missing key: ${job.error}`);
  assert.equal(job.outputMediaId, null, 'a refused write must not create output');
  assert.equal(job.result, null, 'a refused write must not create a result');
  assert.equal(await countMedia(), beforeCount, 'a refused write must create no media');
});

test('Magic Write with a mock LLM returns text + alternatives', async () => {
  await configureMockLlmAndImage();
  const job = await runAiJob('write', { prompt: 'A summer sale for a shoe store, 50% off sneakers', task: 'headline', tone: 'professional', length: 'short' });
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.ok(job.result, 'write job must have a result');
  assert.match(job.result.text, /Summer Sale/i, 'write result must be the mock text');
  assert.equal(job.result.task, 'headline', 'write result must echo the task');
  assert.ok(Array.isArray(job.result.alternatives) && job.result.alternatives.length >= 1, 'write result must carry alternatives');
});

// Eraser against the mock provider (after the mock is configured).
test('Eraser works against a mock image provider', async () => {
  const maskDataUrl = `data:image/png;base64,${fs.readFileSync(testMask).toString('base64')}`;
  const r = await req('/api/magic/erase', {
    method: 'POST', cookie: ownerCookie,
    body: { mediaId: srcImage.id, mask: maskDataUrl },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(r.json.media.id, 'erased media must be returned');
  assert.equal(r.json.provider, 'openai-gpt-image-1', 'erase provider must be named');
  const buf = await downloadMediaFile(r.json.media.id);
  const tmpFile = path.join(tmp, 'erased.png');
  fs.writeFileSync(tmpFile, buf);
  const info = await ffprobe(tmpFile);
  assert.equal(info.streams[0].codec_name, 'png', 'erased output must be a real PNG');
});

// --- Isolation + anonymous ------------------------------------------------------
test('per-user isolation + anonymous 401 on magic routes', async () => {
  const other = await req('/api/magic/remove-background', {
    method: 'POST', cookie: userCookie, body: { mediaId: srcImage.id },
  });
  assert.equal(other.status, 404, "another user must not remove the background of my image: " + JSON.stringify(other.json));
  const otherGrab = await req('/api/magic/grab', {
    method: 'POST', cookie: userCookie,
    body: { mediaId: srcImage.id, maskMediaId: bgMask.id, x: 160, y: 90 },
  });
  assert.equal(otherGrab.status, 404, "another user must not grab from my image: " + JSON.stringify(otherGrab.json));
  const anon = await req('/api/magic/remove-background', {
    method: 'POST', body: { mediaId: srcImage.id },
  });
  assert.equal(anon.status, 401, 'anonymous background removal must be refused');
  const anonExpand = await req('/api/magic/expand', {
    method: 'POST', body: { mediaId: srcImage.id, targetWidth: 640, targetHeight: 360, mode: 'solid' },
  });
  assert.equal(anonExpand.status, 401, 'anonymous expand must be refused');
});
