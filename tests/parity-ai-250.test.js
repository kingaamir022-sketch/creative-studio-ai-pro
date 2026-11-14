'use strict';
// Parity AI + NEW TYPES regression tests (v2.5.0, items #19–#24, #29–#30,
// #44–#45, #60–#69) — AI Studio modes, Sheets, CMYK print, DOCX internals,
// TikTok chunk upload, Pexels stock video, Magic Grab, deck transitions +
// slide animations, website extras, curved text.
//
// The real server runs in-process on scratch port 4851 with a temp
// DB/uploads/renders/models dir, CS_SEGMENTATION_MOCK=1 (deterministic
// centred-rectangle mask — no 176 MB model download), and a local mock
// Pexels API (PEXELS_BASE_URL). TikTok is exercised directly against a
// local mock Content Posting API. The Sheets router is mounted on a small
// harness app on port 4852 with its own temp DB, because /api/sheets is
// not yet mounted in server.js (one-line mount still owed — see report).
// Run ONLY this file: node --test tests/parity-ai-250.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile, execFileSync } = require('child_process');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-parity-ai250-test-'));
const dbPath = path.join(tmp, 'test.db');
const dbPathSheets = path.join(tmp, 'sheets.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const modelsDir = path.join(tmp, 'models');
const PORT = 4851;
const SHEETS_PORT = 4852;
const BASE = `http://127.0.0.1:${PORT}`;
const SHEETS_BASE = `http://127.0.0.1:${SHEETS_PORT}`;

// Env BEFORE requiring any src module (config/db read it at load time).
// The test process itself only ever opens the scratch sheets DB.
process.env.DB_PATH = dbPathSheets;
process.env.UPLOADS_DIR = uploadsDir;
process.env.RENDERS_DIR = rendersDir;
process.env.MODELS_DIR = modelsDir;

const { blankDeck, blankSlide, blankDoc } = require('../src/docs-slides');
const { blankDesign, defaultTextLayer } = require('../src/design-model');
const { blankTimeline, defaultClip } = require('../src/video-model');
const { publishToPlatform } = require('../src/social-publish');
const XLSX = require('xlsx');

let server;
let ownerCookie = '';
let sheetsCookie = '';
let sheetsApp;
let sheetsHttp;
let pexelsMock;
let tiktokMock;
let pexelsPort = 0;
let tiktokPort = 0;
let mediaVideo;
let mediaVideo2;
let mediaSilent;
let mediaPng;

function req(p, { method = 'GET', body, cookie, base = BASE } = {}) {
  const headers = { connection: 'close' };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return fetch(base + p, { method, headers, body: payload, redirect: 'manual' })
    .then(async (r) => {
      const buf = Buffer.from(await r.arrayBuffer());
      let json = null;
      try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
      return { status: r.status, json, buf, text: buf.toString('utf8'), setCookie: r.headers.get('set-cookie') || '' };
    });
}
function reqRaw(p, { method = 'GET', cookie, base = BASE } = {}) {
  const headers = { connection: 'close' };
  if (cookie) headers.cookie = cookie;
  return fetch(base + p, { method, headers, redirect: 'manual' })
    .then(async (r) => ({ status: r.status, buf: Buffer.from(await r.arrayBuffer()), text: '', headers: r.headers }));
}

function ffprobe(file) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', file],
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
}
function makeVideo(file, seconds = 4, tone = 440) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x180:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { timeout: 60000 });
}
function makeSilentGapVideo(file) {
  // Tone 0–1s, silence 1–3s, tone 3–4s (for silencedetect + removal).
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*440*t)*(lt(t\\,1)+gt(t\\,3)):duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { timeout: 60000 });
}
function makePng(outPath) {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x2e7d32:s=64x64:d=1:r=1', '-frames:v', '1', outPath], { stdio: 'pipe' });
}
async function uploadFile(name, buf, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), name);
  const res = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers: { cookie: ownerCookie }, body: fd });
  const json = await res.json();
  assert.equal(res.status, 201, `upload ${name} should be accepted: ${JSON.stringify(json)}`);
  return json.media;
}
async function createProject(name, type, content) {
  const r = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name, type, content } });
  assert.equal(r.status, 201, `create ${type} project: ${r.text}`);
  return r.json.project;
}
async function createAiJob(mode, params) {
  const r = await req('/api/ai/jobs', { method: 'POST', cookie: ownerCookie, body: { mode, ...params } });
  assert.equal(r.status, 201, `create AI job ${mode}: ${r.text}`);
  return r.json.job;
}
async function waitAiJob(id, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const r = await req(`/api/ai/jobs/${id}`, { cookie: ownerCookie });
    assert.equal(r.status, 200, `job ${id} readable: ${r.text}`);
    last = r.json.job;
    if (['done', 'failed', 'cancelled'].includes(last.status)) return last;
    assert.ok(Date.now() < deadline, `AI job ${id} (${last.mode}) did not finish within ${timeoutMs}ms (last: ${JSON.stringify(last)})`);
    await new Promise((x) => setTimeout(x, 500));
  }
}
async function runAiJobExpect(mode, params, wantStatus, timeoutMs = 120000) {
  const job = await createAiJob(mode, params);
  const done = await waitAiJob(job.id, timeoutMs);
  assert.equal(done.status, wantStatus, `AI job ${mode} should be ${wantStatus}, got ${done.status}: ${done.error || JSON.stringify(done.result)}`);
  return done;
}
function zipMembers(buf) {
  // List + read members of a zip (DOCX) via Python's zipfile (stdlib).
  const zipPath = path.join(tmp, `docx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.zip`);
  fs.writeFileSync(zipPath, buf);
  const out = execFileSync('python3', ['-c',
    'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print("\\n".join(z.namelist())); print("---MEMBERS---");\nfor n in ["word/document.xml","word/styles.xml","word/numbering.xml"]:\n    print("### " + n); print(z.read(n).decode("utf-8", "replace")[:6000])',
    zipPath], { encoding: 'utf8', timeout: 30000 });
  return out;
}

// --- Mock Pexels API ---------------------------------------------------------
function pexelsVideo() {
  return {
    id: 424242, width: 1280, height: 720, duration: 4,
    url: 'https://www.pexels.com/video/test-424242',
    image: 'https://images.pexels.com/test.jpg',
    user: { name: 'Test Creator', url: 'https://www.pexels.com/@test' },
    video_files: [{ quality: 'hd', link: `http://127.0.0.1:${pexelsPort}/file.mp4`, width: 1280, height: 720, file_type: 'video/mp4' }],
  };
}
function startPexelsMock() {
  return new Promise((resolve) => {
    pexelsMock = http.createServer((rq, rs) => {
      if (rq.url.startsWith('/videos/search')) {
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({ videos: [pexelsVideo()], total_results: 1, page: 1, per_page: 15 }));
      } else if (rq.url.startsWith('/videos/videos/424242')) {
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify(pexelsVideo()));
      } else if (rq.url === '/file.mp4') {
        const buf = fs.readFileSync(path.join(tmp, 'clip.mp4'));
        rs.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
        rs.end(buf);
      } else { rs.writeHead(404); rs.end('not found'); }
    });
    pexelsMock.listen(0, '127.0.0.1', () => { pexelsPort = pexelsMock.address().port; resolve(); });
  });
}

// --- Mock TikTok Content Posting API -----------------------------------------
function startTiktokMock() {
  return new Promise((resolve) => {
    tiktokMock = http.createServer((rq, rs) => {
      let body = '';
      rq.on('data', (d) => { body += d; });
      rq.on('end', () => {
        if (rq.url === '/v2/post/publish/video/init/' && rq.method === 'POST') {
          const parsed = JSON.parse(body || '{}');
          const failChunk = (parsed.post_info && parsed.post_info.title) === 'fail-chunk';
          rs.writeHead(200, { 'Content-Type': 'application/json' });
          rs.end(JSON.stringify({ data: { publish_id: 'pub_test_1', upload_url: `http://127.0.0.1:${tiktokPort}${failChunk ? '/upload-fail' : '/upload'}` } }));
        } else if (rq.url === '/upload' && rq.method === 'PUT') {
          rs.writeHead(200, { 'Content-Type': 'application/json' });
          rs.end(JSON.stringify({}));
        } else if (rq.url === '/upload-fail' && rq.method === 'PUT') {
          rs.writeHead(500, { 'Content-Type': 'text/plain' });
          rs.end('chunk rejected');
        } else if (rq.url === '/v2/post/publish/status/fetch/' && rq.method === 'POST') {
          rs.writeHead(200, { 'Content-Type': 'application/json' });
          rs.end(JSON.stringify({ data: { status: 'PUBLISH_COMPLETE', video_id: 'tiktok_vid_4242' } }));
        } else { rs.writeHead(404); rs.end('not found'); }
      });
    });
    tiktokMock.listen(0, '127.0.0.1', () => { tiktokPort = tiktokMock.address().port; resolve(); });
  });
}

before(async () => {
  const vidPath = path.join(tmp, 'clip.mp4');
  const vid2Path = path.join(tmp, 'clip2.mp4');
  const silentPath = path.join(tmp, 'silent.mp4');
  const pngPath = path.join(tmp, 'green.png');
  makeVideo(vidPath, 4, 440);
  makeVideo(vid2Path, 4, 660);
  makeSilentGapVideo(silentPath);
  makePng(pngPath);
  await startPexelsMock();
  await startTiktokMock();

  const env = {
    ...process.env,
    DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, MODELS_DIR: modelsDir,
    PORT: String(PORT), HOST: '127.0.0.1', RENDER_WATCHDOG_MS: '120000',
    CS_SEGMENTATION_MOCK: '1',
    PEXELS_BASE_URL: `http://127.0.0.1:${pexelsPort}`,
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
  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'Parity AI Tester', email: 'parity-ai@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  ownerCookie = s.setCookie.split(';')[0];
  mediaVideo = await uploadFile('clip.mp4', fs.readFileSync(vidPath), 'video/mp4');
  mediaVideo2 = await uploadFile('clip2.mp4', fs.readFileSync(vid2Path), 'video/mp4');
  mediaSilent = await uploadFile('silent.mp4', fs.readFileSync(silentPath), 'video/mp4');
  mediaPng = await uploadFile('green.png', fs.readFileSync(pngPath), 'image/png');

  // Sheets harness app (own temp DB) — /api/sheets is not mounted in
  // server.js yet, so the router is verified here on its real mount path.
  const auth = require('../src/auth');
  sheetsApp = express();
  sheetsApp.use(express.json({ limit: '2mb' }));
  // Tiny cookie parser (same as server.js) — without it authMiddleware
  // never sees the cs_session cookie and every call 401s.
  sheetsApp.use((req, res, next) => {
    req.cookies = {};
    const header = req.headers.cookie;
    if (header) {
      for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq > -1) req.cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
    next();
  });
  sheetsApp.use(auth.authMiddleware);
  sheetsApp.use('/api/auth', require('../src/routes/auth'));
  sheetsApp.use('/api/sheets', require('../src/routes/sheets'));
  sheetsHttp = sheetsApp.listen(SHEETS_PORT, '127.0.0.1');
  await new Promise((r) => sheetsHttp.once('listening', r));
  const ss = await req('/api/auth/signup', { method: 'POST', body: { name: 'Sheets Tester', email: 'sheets@test.local', password: 'password123' }, base: SHEETS_BASE });
  assert.equal(ss.status, 201, JSON.stringify(ss.json));
  sheetsCookie = ss.setCookie.split(';')[0];
});

after(async () => {
  if (server) server.kill('SIGKILL');
  if (sheetsHttp) sheetsHttp.close();
  if (pexelsMock) pexelsMock.close();
  if (tiktokMock) tiktokMock.close();
});

test('health endpoint is up', async () => {
  const r = await req('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('#63/#64/#24 AI status lists every extended provider as key_needed', async () => {
  const r = await req('/api/ai/status', { cookie: ownerCookie });
  assert.equal(r.status, 200);
  const ids = (r.json.extendedProviders || []).map((p) => p.id);
  for (const id of ['kling', 'veo', 'pixverse', 'sora', 'seedance', 'seedream', 'nano-banana', 'pexels']) {
    assert.ok(ids.includes(id), `extended providers should include ${id}: ${ids.join(',')}`);
  }
  for (const p of r.json.extendedProviders) assert.equal(p.configured, false, `${p.id} starts unconfigured`);
  assert.ok(r.json.modes.includes('autocut') && r.json.modes.includes('magic-grab') && r.json.modes.includes('seedance'));
});

// --- Sheets (#21) ------------------------------------------------------------
let sheetId;
test('#21 Sheets: create + formulas evaluate (SUM/AVERAGE/IF + real errors)', async () => {
  const cr = await req('/api/sheets', { method: 'POST', cookie: sheetsCookie, body: { name: 'Formula Sheet', cols: 5, rows: 10 }, base: SHEETS_BASE });
  assert.equal(cr.status, 201, cr.text);
  sheetId = cr.json.sheet.id;
  const cells = await req(`/api/sheets/${sheetId}/cells`, {
    method: 'POST', cookie: sheetsCookie,
    body: { cells: { A1: { v: 10 }, A2: { v: 20 }, A3: { v: 30 }, B1: { f: '=SUM(A1:A3)' }, B2: { f: '=AVERAGE(A1:A3)' }, B3: { f: '=IF(A1>5,"big","small")' }, B4: { f: '=1/0' }, C1: { f: '=C1' }, D1: { v: 'Hello', fmt: { bold: true } } } },
    base: SHEETS_BASE,
  });
  assert.equal(cells.status, 200, cells.text);
  const v = cells.json.sheet.values;
  assert.equal(v.B1, 60, 'SUM(A1:A3) = 60');
  assert.equal(v.B2, 20, 'AVERAGE(A1:A3) = 20');
  assert.equal(v.B3, 'big', 'IF works');
  assert.equal(cells.json.sheet.errors.B4, '#DIV/0!', 'division by zero is a real error, not blank');
  assert.equal(cells.json.sheet.errors.C1, '#CIRC!', 'self-reference is #CIRC!');
  assert.equal(cells.json.sheet.content.cells.D1.fmt.bold, true, 'formatting is stored');
});

test('#21 Sheets: rows endpoint is a bulk-job data source; CSV/XLSX round-trip', async () => {
  const cr = await req('/api/sheets', { method: 'POST', cookie: sheetsCookie, body: { name: 'Bulk Source', cols: 3, rows: 5 }, base: SHEETS_BASE });
  const id = cr.json.sheet.id;
  await req(`/api/sheets/${id}/cells`, { method: 'POST', cookie: sheetsCookie, body: { cells: { A1: { v: 'Name' }, B1: { v: 'Prompt' }, A2: { v: 'Clip 1' }, B2: { v: 'A sunset' }, A3: { v: 'Clip 2' }, B3: { v: 'A forest' } } }, base: SHEETS_BASE });
  const rows = await req(`/api/sheets/${id}/rows`, { cookie: sheetsCookie, base: SHEETS_BASE });
  assert.equal(rows.status, 200, rows.text);
  assert.deepEqual(rows.json.headers.slice(0, 2), ['Name', 'Prompt']);
  assert.equal(rows.json.rowCount, 2);
  assert.equal(rows.json.rows[0].Name, 'Clip 1');
  assert.equal(rows.json.rows[1].Prompt, 'A forest');

  const csv = await reqRaw(`/api/sheets/${sheetId}/export/csv`, { cookie: sheetsCookie, base: SHEETS_BASE });
  assert.equal(csv.status, 200);
  assert.ok(csv.buf.toString('utf8').includes('60'), `CSV export carries the computed SUM value: ${csv.buf.toString('utf8').slice(0, 200)}`);
  assert.ok(csv.buf.toString('utf8').includes('#DIV/0!'), 'CSV export carries the real formula error');

  const xlsxRes = await reqRaw(`/api/sheets/${sheetId}/export/xlsx`, { cookie: sheetsCookie, base: SHEETS_BASE });
  assert.equal(xlsxRes.status, 200);
  const wb = XLSX.read(xlsxRes.buf, { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  assert.equal(aoa[0][1], 60, 'XLSX round-trip keeps the computed SUM value');

  const fd = new FormData();
  fd.append('file', new Blob(['Name,Prompt\nClip 1,A sunset\nClip 2,A forest\n'], { type: 'text/csv' }), 'import.csv');
  const imp = await fetch(`${SHEETS_BASE}/api/sheets/import`, { method: 'POST', headers: { cookie: sheetsCookie }, body: fd });
  const impJson = await imp.json();
  assert.equal(imp.status, 201, JSON.stringify(impJson));
  assert.equal(impJson.sheet.content.cells.A2.v, 'Clip 1', 'CSV import reads real rows');
});

test('#21 Sheets frontend ships initSheets (grid UI) + wiring notes', async () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'sheets.js'), 'utf8');
  assert.ok(/function initSheets/.test(js), 'public/sheets.js defines initSheets');
  assert.ok(/window\.Sheets = \{ initSheets \}/.test(js), 'Sheets.initSheets is exposed for wiring');
  assert.ok(js.includes('/api/sheets'), 'frontend talks to /api/sheets');
  assert.ok(/=SUM/.test(js), 'frontend documents formulas');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'sheets.css'), 'utf8');
  assert.ok(css.includes('.sh-grid'), 'sheets.css styles the grid');
  const ed = fs.readFileSync(path.join(__dirname, '..', 'public', 'editor.js'), 'utf8');
  assert.ok(ed.includes('id="ed-curve"'), 'Graphic Editor has the curve-angle control (#69)');
  const ds = fs.readFileSync(path.join(__dirname, '..', 'public', 'docs-slides.js'), 'utf8');
  assert.ok(ds.includes('id="ds-transition"'), 'deck editor has a transition control (#19)');
  assert.ok(ds.includes('ds-entrance'), 'deck editor has entrance-animation controls (#19)');
  assert.ok(ds.includes('ds-print-colorspace'), 'print view offers a CMYK colour-space choice (#22)');
  assert.ok(ds.includes('data-settings'), 'websites view has SEO/password settings (#30)');
  const dcss = fs.readFileSync(path.join(__dirname, '..', 'public', 'docs-slides.css'), 'utf8');
  for (const k of ['ds-ent-fade', 'ds-ent-slide', 'ds-ent-zoom', 'ds-ent-wipe']) assert.ok(dcss.includes(k), `docs-slides.css defines ${k}`);
});

// --- Decks (#19) + CMYK (#22) + DOCX (#23) ------------------------------------
let deckId;
let docId;
function testDeck() {
  const deck = blankDeck({ title: 'Parity Deck' });
  const s2 = blankSlide('text');
  s2.duration = 2;
  s2.transition = { type: 'fade', duration: 0.5 };
  const titleEl = s2.elements.find((e) => e.type === 'text');
  if (titleEl) titleEl.entrance = { type: 'fade', duration: 0.6, delay: 0 };
  deck.slides[0].duration = 2;
  deck.slides.push(s2);
  return deck;
}
test('#19 deck validate accepts transitions + entrance animations', async () => {
  const r = await req('/api/docs-slides/decks/validate', { method: 'POST', cookie: ownerCookie, body: { deck: testDeck() } });
  assert.equal(r.status, 200, r.text);
  assert.ok(!r.json.errors || r.json.errors.length === 0, `deck should validate: ${JSON.stringify(r.json.errors)}`);
  const bad = testDeck();
  bad.slides[1].transition = { type: 'spin', duration: 0.5 };
  const rb = await req('/api/docs-slides/decks/validate', { method: 'POST', cookie: ownerCookie, body: { deck: bad } });
  assert.equal(rb.status, 400, 'an unknown transition type must not validate');
  assert.match(rb.json.error || '', /transition/, `the 400 names the transition problem: ${rb.text}`);
});

test('#19/#22 deck PDF export: RGB uses DeviceRGB, CMYK uses DeviceCMYK', async () => {
  const p = await createProject('Parity Deck', 'deck', testDeck());
  deckId = p.id;
  const rgbRes = await fetch(`${BASE}/api/docs-slides/decks/${deckId}/export/pdf`, { method: 'POST', headers: { cookie: ownerCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ colorSpace: 'rgb' }) });
  assert.equal(rgbRes.status, 200);
  const rgbBuf = Buffer.from(await rgbRes.arrayBuffer());
  assert.ok(rgbBuf.slice(0, 5).toString() === '%PDF-', 'RGB export is a PDF');
  assert.ok(rgbBuf.includes(Buffer.from('/DeviceRGB')), 'RGB PDF declares /DeviceRGB');
  const cmykRes = await fetch(`${BASE}/api/docs-slides/decks/${deckId}/export/pdf`, { method: 'POST', headers: { cookie: ownerCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ colorSpace: 'cmyk' }) });
  assert.equal(cmykRes.status, 200);
  const cmykBuf = Buffer.from(await cmykRes.arrayBuffer());
  assert.ok(cmykBuf.includes(Buffer.from('/DeviceCMYK')), 'CMYK PDF declares /DeviceCMYK (real DeviceCMYK JPEGs, not relabelled RGB)');
  assert.ok(!cmykBuf.includes(Buffer.from('/DeviceRGB')), 'CMYK PDF must not declare /DeviceRGB');
});

test('#19 deck MP4 export joins slides with a real xfade (duration proves it)', async () => {
  const r = await req(`/api/docs-slides/decks/${deckId}/export/video`, { method: 'POST', cookie: ownerCookie, body: { secondsPerSlide: 2, fps: 30 } });
  assert.equal(r.status, 201, r.text);
  const jobId = r.json.job.id;
  const deadline = Date.now() + 120000;
  let last = null;
  for (;;) {
    const jr = await req(`/api/video/jobs/${jobId}`, { cookie: ownerCookie });
    if (jr.status === 200) last = jr.json.job;
    if (last && ['done', 'failed', 'cancelled'].includes(last.status)) break;
    assert.ok(Date.now() < deadline, `deck video did not finish (last: ${JSON.stringify(last)})`);
    await new Promise((x) => setTimeout(x, 1000));
  }
  assert.equal(last.status, 'done', `deck video failed: ${last.error || 'unknown'}`);
  const dl = await reqRaw(`/api/video/jobs/${jobId}/download`, { cookie: ownerCookie });
  assert.equal(dl.status, 200);
  const outFile = path.join(tmp, 'deck.mp4');
  fs.writeFileSync(outFile, dl.buf);
  const probe = await ffprobe(outFile);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  assert.ok(video, 'deck MP4 has a video stream');
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  // 2 slides × 2s minus the 0.5s xfade overlap = 3.5s. A concat (no
  // transition) would be 4s — the duration proves the xfade ran.
  assert.ok(Math.abs(parseFloat(probe.format.duration) - 3.5) < 1.0, `deck duration ${probe.format.duration}, expected ~3.5s with xfade`);
});

test('#23 DOCX export has real numbering.xml, styles.xml (Heading1/2/3, IntenseQuote), headers/footers + sectPr', async () => {
  const doc = blankDoc({ title: 'Parity Doc' });
  doc.blocks = [
    { id: 'b1', type: 'heading', level: 1, text: 'Chapter One' },
    { id: 'b2', type: 'heading', level: 2, text: 'Section' },
    { id: 'b3', type: 'paragraph', text: 'Body text here.' },
    { id: 'b4', type: 'quote', text: 'A quoted line.' },
    { id: 'b5', type: 'list', style: 'number', items: ['First', 'Second'], numbering: 'restart' },
    { id: 'b6', type: 'list', style: 'bullet', items: ['Bullet one'] },
  ];
  const p = await createProject('Parity Doc', 'doc', doc);
  docId = p.id;
  const res = await fetch(`${BASE}/api/docs-slides/docs/${docId}/export/docx`, { method: 'POST', headers: { cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK', 'DOCX is a zip');
  const dump = zipMembers(buf);
  for (const member of ['word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/header1.xml', 'word/footer1.xml']) {
    assert.ok(dump.includes(member), `DOCX contains ${member}:\n${dump.slice(0, 400)}`);
  }
  assert.ok(dump.includes('Heading1') && dump.includes('Heading2') && dump.includes('Heading3'), 'styles.xml defines Heading1/2/3');
  assert.ok(dump.includes('IntenseQuote'), 'styles.xml defines IntenseQuote');
  assert.ok(dump.includes('sectPr'), 'document.xml carries sectPr (A4 + margins + header/footer refs)');
  assert.ok(dump.includes('<w:numFmt'), 'numbering.xml defines real numbering formats');
});

test('#22/#69 print PDF in CMYK renders a design with curved text', async () => {
  const design = blankDesign(1280, 720);
  const layer = defaultTextLayer(140, 260, 'Curved Title', { fontSize: 96, color: '#ffffff', w: 1000, h: 140 });
  layer.text.curve = { angle: 90 };
  design.layers = [layer];
  const v = await req('/api/design/validate', { method: 'POST', cookie: ownerCookie, body: { design } });
  assert.equal(v.status, 200);
  assert.equal(v.json.ok, true, `curved-text design validates: ${JSON.stringify(v.json.errors)}`);
  const bad = JSON.parse(JSON.stringify(design));
  bad.layers[0].text.curve = { angle: 200 };
  const vb = await req('/api/design/validate', { method: 'POST', cookie: ownerCookie, body: { design: bad } });
  assert.equal(vb.json.ok, false, 'curve angle 200 must not validate');
  const p = await createProject('Curved Design', 'design', design);
  const res = await fetch(`${BASE}/api/docs-slides/print/pdf`, { method: 'POST', headers: { cookie: ownerCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: p.id, sizeId: 'a4', bleedMm: 3, marginMm: 10, colorSpace: 'cmyk' }) });
  if (res.status !== 200) assert.fail(`print PDF failed: ${(await res.text()).slice(0, 300)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.slice(0, 5).toString() === '%PDF-', 'print export is a PDF');
  assert.ok(buf.includes(Buffer.from('/DeviceCMYK')), 'print PDF in CMYK declares /DeviceCMYK');
});

// --- TikTok (#20) + Pexels (#24) ----------------------------------------------
test('#20 TikTok chunk upload ends published with a real video id', async () => {
  const out = await publishToPlatform('tiktok', {
    text: 'Test publish',
    media: [{ kind: 'video', filePath: path.join(tmp, 'clip.mp4'), mimeType: 'video/mp4' }],
    connection: { base_url: `http://127.0.0.1:${tiktokPort}/v2`, extra: '{}' },
    credentials: { access_token: 'tok_test' },
  });
  assert.equal(out.providerPostId, 'tiktok_vid_4242', 'publish returns the real TikTok video id from the status poll');
});

test('#20 TikTok fails honestly: text-only refused, failed chunk aborts', async () => {
  await assert.rejects(
    publishToPlatform('tiktok', { text: 'no video', media: [], connection: { base_url: `http://127.0.0.1:${tiktokPort}/v2`, extra: '{}' }, credentials: { access_token: 'tok' } }),
    (e) => e.code === 'NEEDS_VIDEO',
  );
  await assert.rejects(
    publishToPlatform('tiktok', {
      text: 'fail-chunk',
      media: [{ kind: 'video', filePath: path.join(tmp, 'clip.mp4'), mimeType: 'video/mp4' }],
      connection: { base_url: `http://127.0.0.1:${tiktokPort}/v2`, extra: '{}' },
      credentials: { access_token: 'tok_test' },
    }),
    (e) => e.code === 'PROVIDER_ERROR' && /chunk 1\/1/.test(e.message),
  );
});

test('#24 Pexels stock video: no key keeps honest NO_VIDEO_SEARCH; with key search + save work end to end', async () => {
  const noKey = await req('/api/stock/search?type=video&q=ocean', { cookie: ownerCookie });
  assert.equal(noKey.status, 400, noKey.text);
  assert.equal(noKey.json.code, 'NO_VIDEO_SEARCH', 'without a Pexels key video search refuses honestly');
  const saveKey = await req('/api/ai/providers/pexels/key', { method: 'POST', cookie: ownerCookie, body: { key: 'test-pexels-key-12345' } });
  assert.equal(saveKey.status, 200, saveKey.text);
  assert.equal(saveKey.json.provider.configured, true);
  const search = await req('/api/stock/search?type=video&q=ocean', { cookie: ownerCookie });
  assert.equal(search.status, 200, search.text);
  assert.equal(search.json.results.length, 1, 'mock Pexels returns one video');
  assert.equal(search.json.results[0].id, '424242');
  assert.equal(search.json.results[0].source, 'pexels');
  assert.ok(search.json.results[0].url.endsWith('/file.mp4'), 'result carries a real downloadable mp4 link');
  const save = await req('/api/stock/save', { method: 'POST', cookie: ownerCookie, body: { type: 'video', id: '424242' } });
  assert.equal(save.status, 201, save.text);
  assert.equal(save.json.media.kind, 'video');
  assert.ok(save.json.media.sizeBytes > 1000, 'saved Pexels video is a real file, not empty');
  const dup = await req('/api/stock/save', { method: 'POST', cookie: ownerCookie, body: { type: 'video', id: '424242' } });
  assert.equal(dup.status, 200, 'second save returns the existing file');
  assert.equal(dup.json.duplicate, true);
});

// --- AI jobs: local modes that really run -------------------------------------
test('#44 AutoCut builds a real editable video project from clips', async () => {
  const done = await runAiJobExpect('autocut', { mediaIds: [mediaVideo.id, mediaVideo2.id], template: 'cinematic', name: 'Parity AutoCut' }, 'done');
  assert.equal(done.result.clips, 2);
  assert.ok(done.result.projectId, 'AutoCut returns a project id');
  const p = await req(`/api/projects/${done.result.projectId}`, { cookie: ownerCookie });
  assert.equal(p.status, 200);
  assert.equal(p.json.project.type, 'video');
  assert.equal(p.json.project.content.tracks[0].clips.length, 2, 'project has both clips on the timeline');
});

test('#45 silence detect finds the real gap; silence-remove shortens the video', async () => {
  const det = await req('/api/ai/silence/detect', { method: 'POST', cookie: ownerCookie, body: { mediaId: mediaSilent.id, thresholdDb: -35, minDuration: 0.5 } });
  assert.equal(det.status, 200, det.text);
  assert.ok(Array.isArray(det.json.silences) && det.json.silences.length >= 1, `silencedetect finds the gap: ${JSON.stringify(det.json.silences)}`);
  const gap = det.json.silences[0];
  assert.ok(gap.start >= 0.5 && gap.start <= 1.5 && gap.end >= 2.5, `gap is ~1–3s: ${JSON.stringify(gap)}`);
  const done = await runAiJobExpect('silence-remove', { mediaId: mediaSilent.id, thresholdDb: -35, minDuration: 0.5 }, 'done');
  assert.ok(done.result.newDuration < 3, `silence removed: ${done.result.originalDuration}s → ${done.result.newDuration}s`);
  assert.ok(done.result.removedSeconds > 1, 'more than a second of silence was removed');
});

test('#45 transcript editing cuts the cue whose words were deleted', async () => {
  const cues = [
    { start: 0, end: 1, text: 'hello world' },
    { start: 1, end: 2, text: 'goodbye friend' },
    { start: 2, end: 3, text: 'hello again' },
  ];
  const done = await runAiJobExpect('transcript-edit', { mediaId: mediaVideo.id, cues, keepText: 'hello again' }, 'done');
  assert.equal(done.result.cutCues, 1, 'only the fully-deleted cue is cut');
  assert.equal(done.result.keptCues, 2);
});

test('#60 video enhance: denoise + deflicker run locally; expand needs a key', async () => {
  const den = await runAiJobExpect('video-enhance', { mediaId: mediaVideo.id, kind: 'denoise', strength: 3 }, 'done');
  assert.equal(den.result.kind, 'denoise');
  assert.ok(/hqdn3d/.test(den.result.method), 'denoise method is FFmpeg hqdn3d');
  assert.ok(den.outputMediaId, 'denoised video saved to the Media Library');
  const def = await runAiJobExpect('video-enhance', { mediaId: mediaVideo.id, kind: 'deflicker' }, 'done');
  assert.ok(/deflicker/.test(def.result.method));
  const exp = await runAiJobExpect('video-enhance', { mediaId: mediaVideo.id, kind: 'expand' }, 'failed', 30000);
  assert.match(exp.error || '', /not configured|no API key/i, 'AI expand without a video key fails honestly');
});

test('#68 retouch smooth runs locally; face/body ML kinds refuse as NOT_AVAILABLE', async () => {
  const ok = await runAiJobExpect('retouch', { mediaId: mediaVideo.id, kind: 'smooth', intensity: 50 }, 'done');
  assert.ok(/smartblur/.test(ok.result.method), 'smooth retouch is FFmpeg smartblur');
  const no = await runAiJobExpect('retouch', { mediaId: mediaVideo.id, kind: 'slim' }, 'failed', 30000);
  assert.match(no.error || '', /not available/i, 'body slimming refuses honestly instead of faking it');
});

test('#29 Magic Grab (mock mask): click on the object grabs only it; click on background fails honestly', async () => {
  // Mock mask is a centred rectangle (~25% of the frame): (32,32) is inside.
  const hit = await runAiJobExpect('magic-grab', { mediaId: mediaPng.id, x: 32, y: 32 }, 'done');
  assert.ok(hit.result.bbox.x >= 14 && hit.result.bbox.x <= 18, `grab bbox starts near the mock rectangle edge (16): ${JSON.stringify(hit.result.bbox)}`);
  assert.ok(hit.result.bbox.w >= 28 && hit.result.bbox.w <= 36, `grab bbox is only the clicked component, not the whole frame: ${JSON.stringify(hit.result.bbox)}`);
  assert.ok(hit.result.pixels > 500, 'grabbed component has real pixels');
  assert.ok(hit.outputMediaId, 'grabbed object saved as a transparent PNG');
  const miss = await runAiJobExpect('magic-grab', { mediaId: mediaPng.id, x: 5, y: 5 }, 'failed', 60000);
  assert.match(miss.error || '', /No object at that point|no foreground/i, 'a background click fails honestly, never a cropped empty image');
});

test('#67 batch edit applies one op to many video projects', async () => {
  const tl = blankTimeline('16:9', 30);
  tl.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2));
  const p1 = await createProject('Batch One', 'video', tl);
  const tl2 = blankTimeline('16:9', 30);
  tl2.tracks[0].clips.push(defaultClip('video', mediaVideo2.id, 0, 2));
  const p2 = await createProject('Batch Two', 'video', tl2);
  const done = await runAiJobExpect('batch-edit', { projectIds: [p1.id, p2.id], op: { op: 'transition-all', type: 'fade', duration: 0.5 } }, 'done');
  assert.equal(done.result.okCount, 2);
  const after = await req(`/api/projects/${p1.id}`, { cookie: ownerCookie });
  assert.equal(after.json.project.content.tracks[0].clips[0].transition.type, 'fade', 'batch op landed as a real timeline edit');
});

// --- Key-gated modes fail honestly --------------------------------------------
test('#61/#62/#64/#65/#67/#69 key-gated modes fail honestly without keys', async () => {
  const tl = blankTimeline('16:9', 30);
  tl.tracks[0].clips.push(defaultClip('video', mediaVideo.id, 0, 2));
  const vp = await createProject('EditPilot Target', 'video', tl);
  const cases = [
    ['seedance', { providerId: 'seedance', prompt: 'A street at dusk', duration: 5, aspect: '16:9', seedanceMode: 'generate' }],
    ['editpilot', { projectId: vp.id, prompt: 'trim the intro' }],
    ['video-translate', { mediaId: mediaVideo.id, toLanguage: 'es' }],
    ['director', { title: 'Test Drama', premise: 'Two friends open a shop.', characters: [], episodes: 1 }],
    ['avatar', { script: 'Hello world', photoMediaId: mediaPng.id }],
    ['infinite-canvas', { prompt: 'A brand board for a coffee shop', skill: 'brand-board' }],
    ['lyrics', { mediaId: mediaVideo.id }],
    ['ai-lab', { topic: 'morning routines', kind: 'ideas', count: 3 }],
    ['bilingual', { mediaId: mediaVideo.id, secondLanguage: 'ur', speakers: 2 }],
  ];
  for (const [mode, params] of cases) {
    const done = await runAiJobExpect(mode, params, 'failed', 30000);
    assert.match(done.error || '', /not configured|no API key|needs.*key|No voice profile yet/i, `${mode} without a key must fail honestly, got: ${done.error}`);
  }
});

test('#64 Seedream/Nano Banana image generation needs a key (active provider path)', async () => {
  const set = await req('/api/ai/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'image', provider: 'nano-banana' } });
  assert.equal(set.status, 200, set.text);
  const done = await runAiJobExpect('image', { prompt: 'A red bicycle on a beach' }, 'failed', 30000);
  assert.match(done.error || '', /not configured|no API key/i, 'Nano Banana without a key fails honestly');
});

test('#63/#66 Seedance: key saves + status flips to configured; Extend still refuses honestly (no public URL)', async () => {
  const saveKey = await req('/api/ai/providers/kling/key', { method: 'POST', cookie: ownerCookie, body: { key: 'test-kling-key-12345678' } });
  assert.equal(saveKey.status, 200, saveKey.text);
  const st = await req('/api/ai/status', { cookie: ownerCookie });
  const kling = st.json.extendedProviders.find((p) => p.id === 'kling');
  assert.equal(kling.configured, true, 'saved Kling key shows as configured');
  const seedKey = await req('/api/ai/providers/seedance/key', { method: 'POST', cookie: ownerCookie, body: { key: 'test-seedance-key-12345678' } });
  assert.equal(seedKey.status, 200, seedKey.text);
  const done = await runAiJobExpect('seedance', { providerId: 'seedance', prompt: 'Extend this clip', sourceMediaId: mediaVideo.id, duration: 5, aspect: '16:9', seedanceMode: 'extend' }, 'failed', 30000);
  assert.match(done.error || '', /publicly reachable URL/i, 'Seedance Extend on a local-only file refuses honestly instead of faking an extension');
});

// --- Websites (#30) ------------------------------------------------------------
test('#30 website: SEO meta lands in the page, password gates it, views are counted; no custom domain', async () => {
  const design = blankDesign(1280, 720);
  design.layers = [defaultTextLayer(140, 260, 'Hello Website', { fontSize: 72, color: '#ffffff', w: 1000, h: 120 })];
  const p = await createProject('Parity Site', 'design', design);
  const pub = await req('/api/docs-slides/websites/publish', {
    method: 'POST', cookie: ownerCookie,
    body: { projectId: p.id, seo: { title: 'Parity SEO Title', description: 'A test site description', keywords: 'test, parity' }, password: 'secret123' },
  });
  assert.ok([200, 201].includes(pub.status), pub.text);
  const slug = pub.json.site.slug;
  assert.ok(pub.json.site.url.startsWith('/sites/'), 'sites live under /sites/ only');
  assert.ok(!('customDomain' in (pub.json.site || {})), 'no custom domain is offered or returned');
  const gated = await reqRaw(`/sites/${slug}/`);
  assert.equal(gated.status, 401, 'password-protected site refuses without the password');
  const open = await reqRaw(`/sites/${slug}/?pw=secret123`);
  assert.equal(open.status, 200, 'correct password opens the site');
  assert.ok(open.buf.toString('utf8').includes('Parity SEO Title'), 'published HTML carries the SEO title');
  const settings = await req(`/api/docs-slides/websites/${slug}/settings`, { cookie: ownerCookie });
  assert.equal(settings.status, 200);
  assert.equal(settings.json.passwordProtected, true);
  assert.equal(settings.json.seo.title, 'Parity SEO Title');
  const an = await req(`/api/docs-slides/websites/${slug}/analytics`, { cookie: ownerCookie });
  assert.equal(an.status, 200);
  assert.ok(an.json.views >= 1, `local analytics counted the visit(s): ${JSON.stringify(an.json)}`);
});
