'use strict';
// Fix-round regression tests (v2.3.1) — one test per audit gap C-01–C-27
// from the full feature-by-feature verification of v2.3.0. Each test covers
// the gap's EXACT failure (the unmapped bulk batch rendering blank, the
// quiz CTA ink outside the safe box, ...), so a future regression fails
// here instead of reaching the user's PC. Run with: npm test
// Spawns the real server on a scratch port (4847 — ports 4831-4846 are all
// taken by the other 16 suites) with a temp DB/uploads/renders/models dir,
// PLUS one local MOCK LLM HTTP server (Gemini-style) for the AI Studio
// deck + design-assist end-to-end tests.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

// Scratch env FIRST — before any project module is required, so the
// in-process requires below open the scratch DB, not the real one.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-fix231-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const modelsDir = path.join(tmp, 'models');
process.env.DB_PATH = dbPath;
process.env.UPLOADS_DIR = uploadsDir;
process.env.RENDERS_DIR = rendersDir;
process.env.MODELS_DIR = modelsDir;
const PORT = 4847;
const BASE = `http://127.0.0.1:${PORT}`;

// Project modules under test (in-process; the DB-backed ones only ever
// touch the scratch DB above).
const { substituteText } = require('../src/bulk-model');
const qm = require('../src/quiz-model');
const { fitText } = qm;
const { BUILTIN_TEMPLATES, builtinTemplate } = require('../src/design-templates');
const { buildDesignFromSuggestions } = require('../src/ai');
const { docToDocx, buildWebsite } = require('../src/docs-slides');
const { buildRenderPlan } = require('../src/render');
const { blankTimeline, defaultClip } = require('../src/video-model');
const { applyMusicSync } = require('../src/music-sync');
const { probeMedia } = require('../src/ffmpeg');
const { renderDesign } = require('../src/design-render');

let server;
let mockLlm;
let mockLlmPort;
let ownerCookie = '';
let userCookie = '';
let testImage;
let testAudio;
let testVideo;
let testVideoShort;
let rgbMaskDataUrl;
let designProjectId;

function req(p, { method = 'GET', body, cookie, form } = {}) {
  const headers = { connection: 'close' };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) { payload = form; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' })
    .then(async (r) => {
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, text, headers: r.headers, setCookie: r.headers.get('set-cookie') || '' };
    });
}
async function uploadMedia(file, name, mime, cookie) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime }), name);
  const r = await req('/api/media/upload', { method: 'POST', cookie: cookie || ownerCookie, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.media;
}
function makeTestImage(file, color = 'red', size = '320x180', pixFmt) {
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=1`, '-frames:v', '1'];
  if (pixFmt) args.push('-pix_fmt', pixFmt);
  args.push(file);
  execFileSync('ffmpeg', args, { timeout: 30000 });
}
function makeTestAudio(file, seconds = 5) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, file], { timeout: 30000 });
}
function makeTestVideo(file, seconds = 2) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=320x180:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { timeout: 60000 });
}
function makeShortsVideo(file) {
  // 12 s with tone 0-5s, silence 5-8s, tone 8-12s (enough for analysis).
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x180:d=6',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=6',
    '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*440*t)*(between(t,0,5)+between(t,8,12))':duration=12",
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
    { timeout: 60000 });
}
async function pollAiJob(jobId, cookie) {
  const deadline = Date.now() + 120000;
  for (;;) {
    const r = await req(`/api/ai/jobs/${jobId}`, { cookie: cookie || ownerCookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const job = r.json.job;
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`AI job ${jobId} did not finish; last ${JSON.stringify(job)}`);
    await new Promise((x) => setTimeout(x, 500));
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

// --- Local mock LLM (Gemini-style) ------------------------------------------
// Answers the deck-outline and design-assist prompts with valid JSON so
// the C-11 (deck mode) and C-13 (design fit) end-to-end tests exercise the
// real job runner, not a stub.
function mockLlmHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  let body = Buffer.alloc(0);
  req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
  req.on('end', () => {
    if (req.method === 'POST' && url.pathname === '/chat/completions') {
      let parsed = {};
      try { parsed = JSON.parse(body.toString()); } catch { /* ignore */ }
      const userMsg = ((parsed.messages || []).find((m) => m.role === 'user') || {}).content || '';
      let content;
      if (userMsg.includes('presentation outline')) {
        content = JSON.stringify({ title: 'Test Deck', slides: [
          { layout: 'title', heading: 'Test Deck Title', bullets: ['A test deck outline.'], notes: 'Opening notes.' },
          { layout: 'text', heading: 'First point', bullets: ['One clear point for the audience.', 'Second point here.'], notes: 'Notes for slide two.' },
          { layout: 'text', heading: 'Second point', bullets: ['Another clear point.', 'And one more.'], notes: 'Notes for slide three.' },
        ] });
      } else if (userMsg.includes('Design assist')) {
        content = JSON.stringify({ headline: 'SUPER MEGA SUMMER SALE EVENT TODAY ONLY', subheading: 'Get fifty percent off all sneakers and running shoes this weekend only in store', palette: { primary: '#7c5cff', secondary: '#22d3ee', accent: '#3b82f6' }, fonts: { heading: 'Poppins', body: 'Inter' }, cta: 'SHOP NOW' });
      } else {
        content = JSON.stringify({ ok: true });
      }
      return sendJson(200, { choices: [{ message: { content } }] });
    }
    if (req.method === 'GET' && url.pathname === '/models') return sendJson(200, { data: [{ id: 'mock-model' }] });
    return sendJson(404, { error: `mock: no route ${req.method} ${url.pathname}` });
  });
}

before(async () => {
  testImage = path.join(tmp, 'test.png');
  testAudio = path.join(tmp, 'test.mp3');
  testVideo = path.join(tmp, 'test.mp4');
  testVideoShort = path.join(tmp, 'shorts.mp4');
  const rgbMask = path.join(tmp, 'rgb-mask.png');
  makeTestImage(testImage, 'red', '320x180');
  makeTestAudio(testAudio, 5);
  makeTestVideo(testVideo, 2);
  makeShortsVideo(testVideoShort);
  // RGB mask with NO alpha channel (the C-04 trigger): -pix_fmt rgb24.
  makeTestImage(rgbMask, 'white', '320x180', 'rgb24');
  rgbMaskDataUrl = `data:image/png;base64,${fs.readFileSync(rgbMask).toString('base64')}`;

  mockLlm = http.createServer(mockLlmHandler);
  await new Promise((resolve) => mockLlm.listen(0, '127.0.0.1', resolve));
  mockLlmPort = mockLlm.address().port;

  const env = {
    ...process.env,
    DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, MODELS_DIR: modelsDir,
    PORT: String(PORT), HOST: '127.0.0.1',
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

  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'Fix Tester', email: 'fix@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  ownerCookie = s.setCookie.split(';')[0];
  const u = await req('/api/auth/signup', { method: 'POST', body: { name: 'Plain User', email: 'plain@test.local', password: 'password123' } });
  assert.equal(u.status, 201, JSON.stringify(u.json));
  userCookie = u.setCookie.split(';')[0];
});

after(async () => {
  if (server) server.kill('SIGKILL');
  if (mockLlm) await new Promise((r) => mockLlm.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function configureMockGemini() {
  const cfg = await req('/api/providers/gemini/config', { method: 'POST', cookie: ownerCookie, body: { baseUrl: `http://127.0.0.1:${mockLlmPort}` } });
  assert.equal(cfg.status, 200, `config gemini: ${JSON.stringify(cfg.json)}`);
  const key = await req('/api/providers/gemini/key', { method: 'POST', cookie: ownerCookie, body: { key: 'mock-test-key' } });
  assert.equal(key.status, 200, `key gemini: ${JSON.stringify(key.json)}`);
  const act = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'gemini' } });
  assert.equal(act.status, 200, `active llm: ${JSON.stringify(act.json)}`);
}

/* ---------------- C-01: unmapped {{FIELD}} blanks the value ---------------- */
// Before the fix, substituteText only honoured an explicit fieldMapping, so
// a bulk batch whose template said {{NAME}} rendered "Hello " (blank) with
// no warning when the mapping was empty (the default).
test('C-01: unmapped {{FIELD}} falls back to the same-name dataset column', () => {
  const r = substituteText('Hello {{NAME}}', { NAME: 'Alpha', PRICE: '2500' }, {});
  assert.equal(r.text, 'Hello Alpha', 'same-name column must fill the field');
  assert.deepEqual(r.missing, []);
  // An explicit mapping still wins over the same-name column.
  const m = substituteText('Hello {{NAME}}', { NAME: 'Alpha', OTHER: 'Beta' }, { NAME: 'OTHER' });
  assert.equal(m.text, 'Hello Beta');
  // A field with no column anywhere is still reported missing, not faked.
  const missing = substituteText('Hello {{NOPE}}', { NAME: 'Alpha' }, {});
  assert.equal(missing.text, 'Hello ');
  assert.deepEqual(missing.missing, ['NOPE']);
});

/* ---------------- C-02: quiz score-card CTA overflows the frame ------------ */
// Before the fix the CTA was drawn at a fixed 48px with no fit check, so a
// long CTA ran past both frame edges.
test('C-02: quiz score-card CTA is fit-checked into the safe box', () => {
  const q = qm.parseQuestion({ QUESTION: 'What is two plus two?', OPTION_A: 'Three', OPTION_B: 'Four', OPTION_C: 'Five', OPTION_D: 'Six', CORRECT: 'B' }, 0);
  const built = qm.buildQuizTimeline([q], {
    ctaText: 'CLICK HERE TO SEE THE FULL ANSWER AND WIN A PRIZE TODAY',
    ctaSub: 'Follow for more quizzes every single day of the week',
  });
  const scoreTrack = built.timeline.tracks.find((t) => t.name === 'Score card');
  assert.ok(scoreTrack && scoreTrack.clips.length === 1, 'one CTA clip expected');
  const cta = scoreTrack.clips[0];
  assert.ok(cta.text.fontSize < 48, `long CTA must shrink below the 48px default (got ${cta.text.fontSize})`);
  // The fitted CTA must actually fit the safe box at its fitted size.
  const safeW = 1080 - 48 - 48;
  const check = fitText(cta.text.text, safeW, { maxFont: cta.text.fontSize, minFont: 12, maxLines: 2, lineHeight: 1.25 });
  assert.notEqual(check.status, 'attention', 'fitted CTA must fit the safe box');
  // An absurdly long CTA is flagged, never rendered broken.
  const absurd = qm.buildQuizTimeline([q], {
    ctaText: 'CLICK HERE RIGHT NOW TO SEE THE FULL ANSWER AND WIN A HUGE PRIZE TODAY AND TOMORROW AND EVERY DAY AFTER THAT FOREVER AND EVER AND EVER AND EVER, PLUS A BONUS PRIZE, PLUS ANOTHER BONUS, PLUS A THIRD BONUS, PLUS A FOURTH BONUS, PLUS A FIFTH BONUS, AND SO MUCH MORE WAITING FOR YOU INSIDE RIGHT NOW',
  });
  assert.ok(absurd.warnings.some((w) => /Score-card text does not fit/.test(w)), `expected an attention warning, got: ${absurd.warnings.join(' | ')}`);
});

/* ---------------- C-03: model status stuck on "downloading" --------------- */
// Before the fix, downloadPromise was only cleared on the error path, so
// after a successful 168 MB download modelStatus() reported "downloading"
// forever. This drives a real (stubbed) successful download end to end:
// the fetch stub streams exactly MODEL_BYTES and the hash stub answers
// with the real model's SHA-256, so the rename + status flip must happen.
test('C-03: model status is "ready" after a successful download, not stuck on "downloading"', async () => {
  const seg = require('../src/segmentation');
  const MODEL_BYTES = 175997641;
  const MODEL_SHA256 = '8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491';
  const realFetch = globalThis.fetch;
  const realCreateHash = crypto.createHash;
  try {
    let remaining = MODEL_BYTES;
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: () => String(MODEL_BYTES) },
      body: { getReader: () => ({ async read() {
        if (remaining <= 0) return { done: true, value: undefined };
        const n = Math.min(1024 * 1024, remaining);
        remaining -= n;
        return { done: false, value: Buffer.alloc(n) };
      } }) },
    });
    crypto.createHash = () => ({ update() {}, digest: () => MODEL_SHA256 });
    const p = await seg.ensureModel();
    assert.ok(p.endsWith('u2net.onnx'), `model path expected, got ${p}`);
    assert.ok(fs.existsSync(p) && fs.statSync(p).size === MODEL_BYTES, 'downloaded model file must exist at full size');
    const st = seg.modelStatus();
    assert.equal(st.status, 'ready', `status must be ready after a successful download (got ${st.status})`);
    // A second ensureModel must return immediately, not re-download.
    const p2 = await seg.ensureModel();
    assert.equal(p2, p);
    assert.equal(seg.modelStatus().status, 'ready');
  } finally {
    globalThis.fetch = realFetch;
    crypto.createHash = realCreateHash;
  }
});

/* ---------------- C-04: Magic Eraser raw FFmpeg dump on RGB masks -------- */
// Before the fix, meanAlpha ran alphaextract on an alpha-less (RGB) mask
// and the raw FFmpeg stderr ("alphaextract: Requested planes not
// available") reached the user. An RGB mask is fully opaque, so the
// friendly "Nothing to erase" guard must fire instead.
test('C-04: Magic Eraser on an RGB (alpha-less) mask answers friendly, never a raw FFmpeg dump', async () => {
  const media = await uploadMedia(testImage, 'erase.png', 'image/png');
  const r = await req('/api/magic/erase', { method: 'POST', cookie: ownerCookie, body: { mediaId: media.id, mask: rgbMaskDataUrl } });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.ok(/Nothing to erase/.test(r.json.error || ''), `expected the friendly guard, got: ${r.json.error}`);
  assert.ok(!/alphaextract|Requested planes|ffmpeg/i.test(r.json.error || ''), `raw FFmpeg stderr must never reach the client: ${r.json.error}`);
});

/* ---------------- C-05: built-in template text layers overflow ----------- */
// Before the fix, 17 of 107 built-in template text layers overflowed their
// boxes (e.g. "SUMMER\nSALE" needed 360px in a 280px box). Every layer
// must fit at its authored size now.
test('C-05: every built-in template text layer fits its box', () => {
  let checked = 0;
  const overflowing = [];
  for (const t of BUILTIN_TEMPLATES) {
    if (t.kind !== 'design') continue;
    const design = builtinTemplate(t.id).design;
    for (const layer of design.layers || []) {
      if (layer.type !== 'text') continue;
      checked += 1;
      const tex = layer.text;
      const lh = tex.lineHeight || 1.2;
      const maxLines = Math.max(1, Math.floor(layer.h / (tex.fontSize * lh)));
      const fit = fitText(tex.text, layer.w * 0.95, { maxFont: tex.fontSize, minFont: 12, maxLines, lineHeight: lh });
      if (fit.status === 'attention') overflowing.push(`${t.id} / ${layer.name}: "${String(tex.text).slice(0, 40)}"`);
    }
  }
  assert.ok(checked >= 100, `expected 100+ template text layers, checked ${checked}`);
  assert.deepEqual(overflowing, [], `overflowing layers: ${overflowing.join('; ')}`);
});

/* ---------------- C-06: Graphic Editor autofit + server render ----------- */
// Before the fix the editor had no autofit (preview clipped, export drew
// past the box) and the server renderer ignored lineHeight. The server
// renderer must now fit text to its box and flag what still cannot fit.
test('C-06: server design render fits text to its box and flags the un-fittable', async () => {
  const textLayer = (text, fontSize, w, h, lineHeight = 1.05) => ({
    id: `l-${Math.random().toString(36).slice(2, 8)}`, type: 'text', name: 'Headline', x: 90, y: 280, w, h,
    rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null,
    text: { text, fontFamily: 'Poppins', fontSize, fontWeight: 800, fontStyle: 'normal', underline: false, align: 'center', color: '#ffffff', letterSpacing: 0, lineHeight, shadow: null, stroke: null, gradient: null },
  });
  const design = (layers) => ({ version: 1, width: 1080, height: 1080, background: { type: 'color', color: '#151d3a' }, layers });
  // Un-fittable: a long headline in a 1-line box must warn, not render broken.
  const outBad = path.join(tmp, 'c06-bad.png');
  const bad = await renderDesign({ design: design([textLayer('This is a very long headline that will never fit in one line at any readable size because it keeps going and going and going', 110, 200, 60)]), mediaById: {}, outPath: outBad });
  assert.ok(bad.warnings.some((w) => /does not fit its box/.test(w)), `expected a fit warning, got: ${bad.warnings.join(' | ')}`);
  assert.ok(fs.existsSync(outBad), 'render must still produce a file');
  // Fittable (with a tall lineHeight, exercising the line_spacing path):
  // a short headline shrinks into its box and renders cleanly.
  const outOk = path.join(tmp, 'c06-ok.png');
  const ok = await renderDesign({ design: design([textLayer('SUMMER SALE NOW', 110, 900, 260, 1.8)]), mediaById: {}, outPath: outOk });
  assert.deepEqual(ok.warnings.filter((w) => /does not fit/.test(w)), []);
  assert.ok(fs.existsSync(outOk) && fs.statSync(outOk).size > 1000, 'fitted render must produce a real PNG');
});

/* ---------------- C-07: quiz slide animation clips text at the edge ------ */
// Before the fix, slide-left shifted only the drawtext x by a fixed 120px
// while the option panel stayed put, so the text slid out of its panel and
// clipped at the frame edge. Text and panel must now move together, with
// the offset clamped so neither leaves the frame.
test('C-07: slide animation moves the panel with its text, clamped inside the frame', async () => {
  const tl = blankTimeline('9:16', 30);
  const videoTrack = tl.tracks.find((t) => t.kind === 'video');
  const textTrack = tl.tracks.find((t) => t.kind === 'text');
  assert.ok(videoTrack && textTrack, 'timeline needs video + text tracks');
  videoTrack.clips.push(defaultClip('video', 1, 0, 2));
  const clip = defaultClip('text', null, 0, 2);
  clip.text = { text: 'Option A — a fairly long answer', fontFamily: 'Poppins', fontSize: 64, fontWeight: 700, color: '#ffffff', align: 'left', x: 10, y: 50, bgColor: '', animIn: 'slide-left', animOut: 'fade', panel: { x: 48, y: 1000, w: 984, h: 120, fill: '#1e293b' } };
  textTrack.clips.push(clip);
  const probe = await probeMedia(testVideo);
  const plan = buildRenderPlan({
    timeline: tl,
    mediaById: { 1: { filePath: testVideo, probe } },
    settings: {}, tmpDir: path.join(tmp, 'c07-tmp'),
  });
  const filter = plan.args.join(' ');
  // Panel left edge is 48px from the frame, so the slide is clamped to 48px.
  assert.ok(filter.includes("drawbox=x='48+(-48*max(0,1-(t-"), `panel must slide with the text by the clamped offset; filter: ${filter.slice(0, 600)}`);
  assert.ok(!filter.includes('-120*max(0,1-(t-'), 'the old fixed 120px shift must be gone');
  // The slide expression holds a comma (inside max(...)), so drawbox x/y
  // must be quoted — an unquoted comma splits the filter graph and FFmpeg
  // refuses the whole render (this is what broke the quiz e2e renders).
  assert.ok(!/drawbox=x=[^']*max\(/.test(filter), 'drawbox x with a slide expression must be quoted');
  assert.ok(!/drawbox=x='[^']*':y=[^']*max\(/.test(filter), 'drawbox y with a slide expression must be quoted');
  // And the graph must actually parse: run the plan's own args through
  // FFmpeg (null output, 1 frame) — a string check alone did not catch
  // the unquoted-comma break.
  const ff = spawnSync('ffmpeg', [...plan.args, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(ff.status, 0, `the C-07 filter graph must parse and render: ${(ff.stderr || '').slice(0, 500)}`);
});

/* ---------------- C-08: Music Sync refuses occupied audio tracks --------- */
// Before the fix, apply-sync pushed the music clip onto the first audio
// track whatever was already there, so any project with an audio clip got
// a 400 ("overlaps the previous clip"). It must now use an empty track
// (or a new one) and leave the existing clip alone.
test('C-08: Music Sync applies onto an empty/new audio track when the first is occupied', () => {
  const tl = blankTimeline('16:9', 30);
  const videoTrack = tl.tracks.find((t) => t.kind === 'video');
  const audioTrack = tl.tracks.find((t) => t.kind === 'audio');
  videoTrack.clips.push(defaultClip('video', 1, 0, 10));
  const existing = defaultClip('audio', 2, 0, 10);
  existing.name = 'Voiceover';
  audioTrack.clips.push(existing);
  const analysis = { bpm: 120, beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5], downbeats: [0.5, 2.5, 4.5, 6.5, 8.5], drops: [], durationSeconds: 30, confidence: 0.9, lowConfidence: false };
  const { timeline, report, error } = applyMusicSync(tl, analysis, 3, 'test-track.mp3', {});
  assert.equal(error, undefined, `sync must not refuse: ${error}`);
  assert.ok(report, 'a report is expected');
  const audioTracks = timeline.tracks.filter((t) => t.kind === 'audio');
  assert.equal(audioTracks.length, 2, 'a second audio track must be created for the music');
  const musicClip = audioTracks.flatMap((t) => t.clips).find((c) => c.musicSync);
  assert.ok(musicClip, 'music clip must exist');
  const musicTrack = audioTracks.find((t) => t.clips.includes(musicClip));
  assert.equal(musicTrack.clips.length, 1, 'the music clip must sit alone on its track');
  const kept = audioTracks.flatMap((t) => t.clips).find((c) => c.name === 'Voiceover');
  assert.ok(kept && kept.start === 0 && kept.duration === 10, 'the existing clip must be untouched');
});

/* ---------------- C-09: A/V drift after transitions ---------------------- */
// Before the fix, audio-track clips kept their raw timeline start while
// the video rendered earlier by every transition overlap (0.5s drift per
// transition). The audio must now be shift-compensated like the video.
test('C-09: audio-track clips are shift-compensated after a transition (no 0.5s drift)', async () => {
  const tl = blankTimeline('16:9', 30);
  const videoTrack = tl.tracks.find((t) => t.kind === 'video');
  const audioTrack = tl.tracks.find((t) => t.kind === 'audio');
  videoTrack.clips.push(defaultClip('video', 1, 0, 5));
  const second = defaultClip('video', 1, 5, 5);
  second.transition = { type: 'fade', duration: 0.5 };
  videoTrack.clips.push(second);
  audioTrack.clips.push(defaultClip('audio', 2, 5, 5));
  const videoProbe = await probeMedia(testVideo);
  const audioProbe = await probeMedia(testAudio);
  const plan = buildRenderPlan({
    timeline: tl,
    mediaById: { 1: { filePath: testVideo, probe: videoProbe }, 2: { filePath: testAudio, probe: audioProbe } },
    settings: {}, tmpDir: path.join(tmp, 'c09-tmp'),
  });
  const filter = plan.args.join(' ');
  assert.ok(filter.includes('adelay=4500|4500'), `audio starting at timeline 5s must be delayed to rendered 4.5s after the 0.5s transition; filter: ${filter.slice(0, 800)}`);
  assert.ok(!filter.includes('adelay=5000|5000'), 'the unshifted 5s delay must be gone');
});

/* ---------------- C-10: DOCX drops charts to placeholder text ------------ */
// Before the fix, a chart block in a .docx became "[Chart: ... — see the
// chart image in the app]". The chart must now be a real embedded PNG.
test('C-10: DOCX export embeds chart blocks as real images, not placeholder text', async () => {
  const outPath = path.join(tmp, 'c10.docx');
  const doc = { title: 'C10', blocks: [
    { id: 'b1', type: 'heading', level: 1, text: 'Sales report' },
    { id: 'c1', type: 'chart', chart: { type: 'bar', title: 'Sales by month', labels: ['Jan', 'Feb', 'Mar'], datasets: [{ label: 'Sales', values: [10, 20, 15] }] } },
  ] };
  const result = await docToDocx(doc, { mediaById: {}, outPath });
  assert.equal(result.blocks, 2);
  assert.ok(result.images >= 1, 'the chart must count as an embedded image');
  const xml = execFileSync('unzip', ['-p', outPath, 'word/document.xml'], { encoding: 'utf8' });
  assert.ok(!xml.includes('[Chart:'), 'no chart placeholder text may remain in the document');
  assert.ok(xml.includes('<w:drawing>'), 'the chart must be embedded as a drawing');
  const listing = execFileSync('unzip', ['-l', outPath], { encoding: 'utf8' });
  assert.ok(/word\/media\/image\d+\.png/.test(listing), `a chart PNG must be in word/media: ${listing}`);
});

/* ---------------- C-11: AI Studio hides the deck mode -------------------- */
// Before the fix the UI hardcoded 11 of the backend's 12 modes (deck was
// missing) so AI deck generation was unreachable from AI Studio.
test('C-11: AI Studio lists the deck mode (derived from /api/ai/status) and generates a deck end to end', async () => {
  const st = await req('/api/ai/status', { cookie: ownerCookie });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.ok(Array.isArray(st.json.modes) && st.json.modes.includes('deck'), `backend modes must include deck: ${JSON.stringify(st.json.modes)}`);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'ai-studio.js'), 'utf8');
  assert.ok(src.includes("'deck'") && src.includes('AI Deck'), 'AI Studio must define the deck mode');
  assert.ok(src.includes('status.modes'), 'the mode list must be derived from /api/ai/status, not hardcoded');
  assert.ok(/case 'deck'/.test(src), 'AI Studio must have a deck form');
  await configureMockGemini();
  const created = await req('/api/ai/jobs', { method: 'POST', cookie: ownerCookie, body: { mode: 'deck', topic: 'Test deck', slideCount: 3, style: 'professional', audience: 'testers' } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const job = await pollAiJob(created.json.job.id);
  assert.equal(job.status, 'done', `deck job failed: ${job.error || ''}`);
  assert.ok(job.result && job.result.projectId, 'deck job must create a project');
  const proj = await req(`/api/projects/${job.result.projectId}`, { cookie: ownerCookie });
  assert.equal(proj.status, 200, JSON.stringify(proj.json));
  assert.equal(proj.json.project.type, 'deck');
  assert.equal(proj.json.project.content.slides.length, 3, 'the deck must have the requested 3 slides');
});

/* ---------------- C-12: server renderer drops features silently ---------- */
// Before the fix the editor never warned that the server renderer drops
// ellipse/triangle shapes, rounded corners, shadows and gradient text, so
// Bulk/PDF exports silently lost them. The editor must warn in place.
test('C-12: Graphic Editor warns about features the server renderer drops', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'editor.js'), 'utf8');
  assert.ok(src.includes('ed-server-warn'), 'editor must have the server-render warning element');
  assert.ok(src.includes('serverRenderWarnings'), 'editor must compute the dropped-feature list');
  for (const feature of ['ellipse', 'triangle', 'rounded corners', 'gradient text']) {
    assert.ok(src.toLowerCase().includes(feature), `warning must mention ${feature}`);
  }
});

/* ---------------- C-13: AI Design Assist headline never fits ------------- */
// Before the fix, buildDesignFromSuggestions put an up-to-8-word headline
// at 110px into a 2-line box with no fit check, so it overflowed every
// time. The headline (and subheading/CTA) must now be fitted to its box.
test('C-13: AI Design Assist fits its headline into its box', () => {
  const design = buildDesignFromSuggestions(
    { headline: 'SUPER MEGA SUMMER SALE EVENT TODAY ONLY', subheading: 'Get fifty percent off all sneakers and running shoes this weekend only in store', palette: { primary: '#7c5cff', secondary: '#22d3ee', accent: '#3b82f6' }, fonts: { heading: 'Poppins', body: 'Inter' }, cta: 'SHOP NOW' },
    'Summer sale poster',
  );
  const head = design.layers.find((l) => l.id === 'ai_head');
  assert.ok(head, 'headline layer expected');
  assert.ok(head.text.fontSize < 110, `8-word headline must shrink below 110px (got ${head.text.fontSize})`);
  const lh = head.text.lineHeight || 1.05;
  const maxLines = Math.max(1, Math.floor(head.h / (head.text.fontSize * lh)));
  const check = fitText(head.text.text, head.w * 0.95, { maxFont: head.text.fontSize, minFont: 12, maxLines, lineHeight: lh });
  assert.notEqual(check.status, 'attention', 'fitted headline must fit its box');
  const sub = design.layers.find((l) => l.id === 'ai_sub');
  assert.ok(sub.text.fontSize <= 36, 'subheading must not exceed its authored size');
  assert.deepEqual(design._ai.needsAttention, [], 'a fittable design must not need attention');
});

/* ---------------- C-14: uploaded images never get width/height ------------ */
// Before the fix the upload route probed video/audio only, so image rows
// kept NULL dimensions and every consumer guessed 600×400.
test('C-14: uploading an image stores its real width/height', async () => {
  const media = await uploadMedia(testImage, 'dims.png', 'image/png');
  let found = null;
  const deadline = Date.now() + 15000;
  for (;;) {
    const list = await req('/api/media?limit=100', { cookie: ownerCookie });
    assert.equal(list.status, 200, JSON.stringify(list.json));
    found = (list.json.media || []).find((m) => m.id === media.id);
    if (found && found.width === 320 && found.height === 180) break;
    if (Date.now() > deadline) throw new Error(`image dimensions never landed: ${JSON.stringify(found)}`);
    await new Promise((x) => setTimeout(x, 200));
  }
  assert.equal(found.width, 320);
  assert.equal(found.height, 180);
});

/* ---------------- C-15: Shorts manual transcript never saved ------------- */
// Before the fix the route passed camelCase transcriptSource to the DB
// allow-list (which only accepts transcript_source), so a manual
// transcript was silently dropped from the record.
test('C-15: a manual Shorts transcript is stored with its source', async () => {
  const media = await uploadMedia(testVideoShort, 'shorts.mp4', 'video/mp4');
  const created = await req('/api/shorts/jobs', { method: 'POST', cookie: ownerCookie, body: { mediaId: media.id, settings: { minClipSeconds: 3, maxClipSeconds: 12, maxClips: 5 }, language: 'en' } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const jobId = created.json.job.id;
  await waitForAnalysis(jobId);
  const saved = await req(`/api/shorts/jobs/${jobId}/transcript`, { method: 'POST', cookie: ownerCookie, body: { format: 'text', text: 'Hello world.\nSecond line here.' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.ok(saved.json.cues >= 1, 'cues must be saved');
  const detail = await req(`/api/shorts/jobs/${jobId}`, { cookie: ownerCookie });
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  assert.equal(detail.json.job.transcriptSource, 'manual-text', `transcript_source must be stored, got: ${detail.json.job.transcriptSource}`);
});

/* ---------------- C-16: quiz rows with no background are refused --------- */
// Before the fix, a single-quiz bulk row with no background assigned threw
// "This row has no background assigned" and the batch could not run. It
// must now render on the solid spec navy background, with a warning.
test('C-16: a quiz bulk row with no background renders on solid navy, not refused', async () => {
  const job = await req('/api/bulk', { method: 'POST', cookie: ownerCookie, body: { name: 'Fix231 Quiz', kind: 'video', templateProjectId: 'quiz', settings: {} } });
  assert.equal(job.status, 201, JSON.stringify(job.json));
  const jobId = job.json.job.id;
  const ds = await req(`/api/bulk/${jobId}/dataset`, { method: 'POST', cookie: ownerCookie, body: { rows: [{ QUESTION: 'What is two plus two?', OPTION_A: 'Three', OPTION_B: 'Four', OPTION_C: 'Five', OPTION_D: 'Six', CORRECT: 'B' }] } });
  assert.equal(ds.status, 200, JSON.stringify(ds.json));
  const sample = await req(`/api/bulk/${jobId}/sample`, { method: 'POST', cookie: ownerCookie, body: { rowIndex: 0 } });
  assert.equal(sample.status, 201, `sample must build (old code threw "no background assigned"): ${JSON.stringify(sample.json)}`);
  assert.ok((sample.json.row.warnings || []).some((w) => /solid navy background/.test(w)), `expected the navy-fallback warning, got: ${JSON.stringify(sample.json.row.warnings)}`);
  // Cancel the render job the sample queued, so the suite does not render it.
  if (sample.json.jobId) {
    await req(`/api/video/jobs/${sample.json.jobId}/cancel`, { method: 'POST', cookie: ownerCookie });
  }
});

/* ---------------- C-17: Export Center stale copy ------------------------ */
test('C-17: Export Center no longer promises Bulk Design "arrives in Phase 4"', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!src.includes('arrive with Bulk Design in Phase 4'), 'stale Phase 4 copy must be gone');
  assert.ok(src.includes('Batch image export is live in Bulk Design'), 'the copy must say batch export is live');
});

/* ---------------- C-18: republishing mints a second live site ----------- */
// Before the fix every publish created a new website row with a fresh
// random slug, so republishing left two live sites. It must now update
// the project's existing site (same URL).
test('C-18: republishing a project updates its site instead of minting a second one', async () => {
  const design = { version: 1, width: 1080, height: 1080, background: { type: 'color', color: '#ffffff' }, layers: [] };
  const created = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'Site Design', type: 'design', content: design } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const pid = created.json.project.id;
  const first = await req('/api/docs-slides/websites/publish', { method: 'POST', cookie: ownerCookie, body: { projectId: pid } });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const slug = first.json.site.slug;
  const second = await req('/api/docs-slides/websites/publish', { method: 'POST', cookie: ownerCookie, body: { projectId: pid } });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(second.json.site.slug, slug, 'republish must keep the same slug/URL');
  assert.equal(second.json.republished, true);
  const list = await req('/api/docs-slides/websites', { cookie: ownerCookie });
  assert.equal(list.status, 200, JSON.stringify(list.json));
  const mine = (list.json.sites || []).filter((s) => s.projectId === pid);
  assert.equal(mine.length, 1, `exactly one live site per project, got ${mine.length}`);
  assert.equal(mine[0].slug, slug);
});

/* ---------------- C-19: published pages have no viewport scaling -------- */
// Before the fix a published 1920×1080 deck/design page overflowed any
// narrower viewport with no scaling. The built site must now carry a
// fit-to-width scaler.
test('C-19: published design sites scale to the viewport width', () => {
  const outDir = path.join(tmp, 'c19-site');
  const design = { version: 1, width: 1920, height: 1080, background: { type: 'color', color: '#ffffff' }, layers: [
    { id: 'l1', type: 'text', name: 'Title', x: 100, y: 400, w: 1720, h: 200, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: 'Hello site', fontFamily: 'Inter', fontSize: 120, fontWeight: 700, fontStyle: 'normal', underline: false, align: 'center', color: '#111827', letterSpacing: 0, lineHeight: 1.2, shadow: null, stroke: null, gradient: null } },
  ] };
  const built = buildWebsite({ kind: 'design', title: 'C19 Site', design, mediaById: {}, chartFiles: {}, outDir });
  assert.ok(built.files.includes('index.html'));
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  assert.ok(html.includes('__fitPages'), 'the site must include the fit-to-width scaler');
  assert.ok(html.includes('scale('), 'the scaler must scale the page');
  assert.ok(html.includes('page-wrap'), 'the design page must be wrapped for scaled-height layout');
  assert.ok(html.includes('window.innerWidth'), 'scaling must be relative to the viewport');
});

/* ---------------- C-20: malformed JSON returns 500 ---------------------- */
// Before the fix a malformed JSON body fell through to the generic error
// handler and came back as a 500 (server error). It is a client error.
test('C-20: malformed JSON body returns 400, not 500', async () => {
  const r = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { cookie: ownerCookie, 'Content-Type': 'application/json', connection: 'close' },
    body: '{bad json', redirect: 'manual',
  });
  assert.equal(r.status, 400, `malformed JSON must be 400, got ${r.status}`);
  const body = await r.json();
  assert.ok(/not valid JSON/.test(body.error || ''), `expected a JSON error, got: ${JSON.stringify(body)}`);
});

/* ---------------- C-21: notification bell dot never evaluated ----------- */
// Before the fix the bell dot was only evaluated when the bell was opened,
// and there was no read/unread state at all. The dot must reflect the
// server's per-user unread count on page load, and opening the bell must
// mark everything seen.
test('C-21: notification dot follows the per-user unread count; opening the bell marks seen', async () => {
  const seen = await req('/api/notifications/seen', { method: 'POST', cookie: ownerCookie });
  assert.equal(seen.status, 200, JSON.stringify(seen.json));
  const afterSeen = await req('/api/notifications', { cookie: ownerCookie });
  assert.equal(afterSeen.status, 200, JSON.stringify(afterSeen.json));
  assert.equal(afterSeen.json.unreadCount, 0, 'after marking seen there must be no unread notifications');
  // A new audit event (media upload) must raise the count again. The seen
  // marker has 1-second granularity, so wait past the second boundary.
  await new Promise((x) => setTimeout(x, 1200));
  await uploadMedia(testImage, 'notif.png', 'image/png');
  const afterEvent = await req('/api/notifications', { cookie: ownerCookie });
  assert.ok(afterEvent.json.unreadCount >= 1, `a new event must be unread, got ${afterEvent.json.unreadCount}`);
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(appSrc.includes('refreshNotifDot'), 'the client must evaluate the dot on load');
});

/* ---------------- C-22: analytics totals leak platform-wide ------------- */
// Before the fix every user saw platform-wide totals (all users' projects,
// renders, AI jobs...). A plain USER must now see only their own rows.
test('C-22: analytics totals are scoped per-user for non-admins', async () => {
  const beforeUser = await req('/api/analytics', { cookie: userCookie });
  assert.equal(beforeUser.status, 200, JSON.stringify(beforeUser.json));
  const beforeProjects = beforeUser.json.totals.projects;
  const created = await req('/api/projects', { method: 'POST', cookie: userCookie, body: { name: 'User Only Project', type: 'design', content: { version: 1, width: 800, height: 800, background: { type: 'color', color: '#ffffff' }, layers: [] } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const afterUser = await req('/api/analytics', { cookie: userCookie });
  assert.equal(afterUser.json.totals.projects, beforeProjects + 1, 'user totals must grow by exactly their own project');
  const ownerView = await req('/api/analytics', { cookie: ownerCookie });
  assert.ok(ownerView.json.totals.projects > afterUser.json.totals.projects, `owner (platform) total (${ownerView.json.totals.projects}) must exceed the single user's total (${afterUser.json.totals.projects})`);
  assert.ok(afterUser.json.totals.users === 1, 'a plain user must not see the platform user count');
});

/* ---------------- C-23: deleting a user orphans their files ------------ */
// Before the fix the DB row was deleted but uploads/renders/websites
// stayed on disk forever. Deleting a user must remove their files too.
test('C-23: deleting a user removes their uploads, renders and website folders', async () => {
  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'Doomed User', email: 'doomed@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  const doomedCookie = s.setCookie.split(';')[0];
  const doomedId = s.json.user.id;
  await uploadMedia(testImage, 'doomed.png', 'image/png', doomedCookie);
  const upDir = path.join(uploadsDir, String(doomedId));
  const reDir = path.join(rendersDir, String(doomedId));
  assert.ok(fs.existsSync(upDir), 'uploads folder must exist before delete');
  const del = await req(`/api/admin/users/${doomedId}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.ok(del.json.filesRemoved >= 1, `files must be reported removed, got: ${JSON.stringify(del.json)}`);
  assert.ok(!fs.existsSync(upDir), 'uploads folder must be gone after delete');
  assert.ok(!fs.existsSync(reDir), 'renders folder must be gone after delete');
  const list = await req('/api/admin/users', { cookie: ownerCookie });
  assert.ok(!(list.json.users || []).some((u) => u.id === doomedId), 'user must be gone from the admin list');
});

/* ---------------- C-24: provider Test returns 200 on failure ------------ */
// Before the fix a failed provider test came back HTTP 200 with
// {ok:false}, so callers treated a dead key as success. It must be 402.
test('C-24: a failing provider test returns 402, not 200', async () => {
  const r = await req('/api/providers/llm/test', { method: 'POST', cookie: ownerCookie });
  assert.equal(r.status, 402, `unconfigured provider test must be 402, got ${r.status}: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.ok, false);
  assert.ok(/No API key configured/.test(r.json.error || ''), `expected the key-needed error, got: ${r.json.error}`);
});

/* ---------------- C-25: dashboard FFmpeg line is static text ------------ */
// Before the fix the dashboard always said "FFmpeg render engine live"
// even when FFmpeg was missing. It must now come from the live probe.
test('C-25: dashboard reports the live FFmpeg probe, not static text', async () => {
  const d = await req('/api/dashboard', { cookie: ownerCookie });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.ok(d.json.system && d.json.system.ffmpeg, 'dashboard must carry the ffmpeg probe');
  assert.equal(d.json.system.ffmpeg.available, true, 'FFmpeg is installed in this environment, so the probe must say available');
  assert.ok(d.json.system.ffmpeg.version, 'the probe must report a version');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!appSrc.includes('FFmpeg render engine live'), 'the static line must be gone');
  assert.ok(appSrc.includes('d.system.ffmpeg'), 'the dashboard must render from the probe');
});

/* ---------------- C-26: version list has no content fingerprint --------- */
// Before the fix versions listed only {id, note, created_at}, so two
// identical autosaves were indistinguishable. Each version must now carry
// a SHA-256 fingerprint + byte size of its content.
test('C-26: project versions carry a content fingerprint', async () => {
  const content = { version: 1, width: 800, height: 800, background: { type: 'color', color: '#ffffff' }, layers: [] };
  const created = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'Versioned', type: 'design', content } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const pid = created.json.project.id;
  const p1 = await req(`/api/projects/${pid}`, { method: 'PATCH', cookie: ownerCookie, body: { content, saveVersion: true } });
  assert.equal(p1.status, 200, JSON.stringify(p1.json));
  const p2 = await req(`/api/projects/${pid}`, { method: 'PATCH', cookie: ownerCookie, body: { content, saveVersion: true } });
  assert.equal(p2.status, 200, JSON.stringify(p2.json));
  const versions = await req(`/api/projects/${pid}/versions`, { cookie: ownerCookie });
  assert.equal(versions.status, 200, JSON.stringify(versions.json));
  assert.ok(versions.json.versions.length >= 2, 'two saves must produce two versions');
  for (const v of versions.json.versions) {
    assert.ok(/^[0-9a-f]{64}$/.test(v.sha256 || ''), `version needs a 64-hex SHA-256, got: ${v.sha256}`);
    assert.ok(typeof v.bytes === 'number' && v.bytes > 0, 'version needs a byte size');
  }
  assert.equal(versions.json.versions[0].sha256, versions.json.versions[1].sha256, 'identical contents must share a fingerprint');
  const changed = { ...content, background: { type: 'color', color: '#000000' } };
  await req(`/api/projects/${pid}`, { method: 'PATCH', cookie: ownerCookie, body: { content: changed, saveVersion: true } });
  const again = await req(`/api/projects/${pid}/versions`, { cookie: ownerCookie });
  assert.notEqual(again.json.versions[0].sha256, again.json.versions[1].sha256, 'changed content must change the fingerprint');
});

/* ---------------- C-27: manual posts can be deleted --------------------- */
// Before the fix a 'manual' post (the only record that a post went out,
// marked by hand) could be deleted like a draft. Published AND manual
// records must now be protected.
test('C-27: a manually-posted record cannot be deleted', async () => {
  const created = await req('/api/social/posts', { method: 'POST', cookie: ownerCookie, body: { platform: 'x', text: 'Hello from the fix-round test #c27' } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const postId = created.json.post.id;
  const marked = await req(`/api/social/posts/${postId}/mark-manual`, { method: 'POST', cookie: ownerCookie, body: { note: 'Posted from the app', url: 'https://x.com/posts/999' } });
  assert.equal(marked.status, 200, JSON.stringify(marked.json));
  assert.equal(marked.json.post.status, 'manual');
  const del = await req(`/api/social/posts/${postId}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 400, `manual record delete must be refused, got ${del.status}: ${JSON.stringify(del.json)}`);
  assert.ok(/manually-posted record cannot be deleted/.test(del.json.error || ''), `expected the manual-record error, got: ${del.json.error}`);
  const stillThere = await req('/api/social/posts?status=manual', { cookie: ownerCookie });
  assert.ok((stillThere.json.posts || []).some((p) => p.id === postId), 'the manual record must still exist');
  // A plain draft must still be deletable (the fix must not over-block).
  const draft = await req('/api/social/posts', { method: 'POST', cookie: ownerCookie, body: { platform: 'x', text: 'A throwaway draft' } });
  assert.equal(draft.status, 201, JSON.stringify(draft.json));
  const delDraft = await req(`/api/social/posts/${draft.json.post.id}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(delDraft.status, 200, JSON.stringify(delDraft.json));
  const socialSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'social.js'), 'utf8');
  assert.ok(socialSrc.includes("'manual'"), 'the UI must also hide Delete for manual posts');
});
