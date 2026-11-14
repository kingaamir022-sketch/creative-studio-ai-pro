'use strict';
// Docs & Slides tests (v2.2.3, Release B) — run with: npm test
// Spawns the real server on a scratch port (4845 — ports 4831-4844 are all
// taken by the other 14 suites) with a temp DB/uploads dir, PLUS a local
// MOCK LLM HTTP server that speaks the real chat-completions API (AI deck
// generation). Covers: deck validation + slide fit checks (never-overflow,
// uniform quiz fonts, Needs attention), chart CSV parse (duplicate rows
// skipped) + render (SVG + real PNG in the Media Library), deck exports
// (slide images ZIP, PDF, MP4 video through the render queue), document
// exports (HTML, real .docx, A4 PDF), website publish/serve/unpublish,
// print-ready PDF (bleed page size, crop marks), AI deck generation
// (no-key job fails key_needed with no project; mock-LLM job builds a real
// deck project), per-user isolation + anonymous 401.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-docs-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4845;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let mockServer;
let mockPort;
let ownerCookie = '';
let userCookie = '';
let testImage;

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
async function download(p, cookie) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { cookie: cookie || ownerCookie, 'Content-Type': 'application/json', connection: 'close' }, redirect: 'manual' });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
}
async function downloadGet(p, cookie) {
  const r = await fetch(BASE + p, { headers: { cookie: cookie || ownerCookie, connection: 'close' }, redirect: 'manual' });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), text: null, headers: r.headers };
}
function ffprobe(file) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,duration', '-show_entries', 'format=duration', '-of', 'json', file],
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
}
function pdfinfo(file) {
  return new Promise((resolve, reject) => {
    execFile('pdfinfo', [file], (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
function unzipList(file) {
  return new Promise((resolve, reject) => {
    execFile('unzip', ['-l', file], (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
function unzipFile(file, member) {
  return new Promise((resolve, reject) => {
    // Binary output: execFile must return a Buffer, otherwise UTF-8
    // decoding corrupts the PNG bytes.
    execFile('unzip', ['-p', file, member], { maxBuffer: 10 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
function makeTestImage(file, color = 'red', size = '320x180') {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=1`, '-frames:v', '1', file], { timeout: 30000 });
}
async function uploadMedia(file, name, mime, cookie) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime }), name);
  const r = await req('/api/media/upload', { method: 'POST', cookie: cookie || ownerCookie, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.media;
}
async function createProject(name, type, content, cookie) {
  const r = await req('/api/projects', { method: 'POST', cookie: cookie || ownerCookie, body: { name, type, content } });
  assert.equal(r.status, 201, `create ${type} project: ${JSON.stringify(r.json)}`);
  return r.json.project;
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
async function pollRenderJob(jobId, cookie) {
  const deadline = Date.now() + 180000;
  for (;;) {
    const r = await req(`/api/video/jobs/${jobId}`, { cookie: cookie || ownerCookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const job = r.json.job;
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`Render job ${jobId} did not finish; last ${JSON.stringify(job)}`);
    await new Promise((x) => setTimeout(x, 500));
  }
}

// --- Local mock LLM -----------------------------------------------------------
// Only chat/completions (AI deck outline) + /models (provider test).
function mockHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  let body = Buffer.alloc(0);
  req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
  req.on('end', () => {
    if (req.method === 'POST' && p === '/chat/completions') {
      return sendJson(200, { choices: [{ message: { content: JSON.stringify({
        title: 'Healthy Breakfast Ideas',
        slides: [
          { layout: 'title', heading: 'Healthy Breakfast Ideas', bullets: ['Fuel your morning right'], notes: 'Welcome everyone.' },
          { layout: 'text', heading: 'Why Breakfast Matters', bullets: ['Boosts energy for the day', 'Improves focus at school', 'Keeps you full until lunch'], notes: 'Three reasons.' },
          { layout: 'chart', heading: 'What Kids Eat', chart: { type: 'bar', labels: ['Cereal', 'Fruit', 'Eggs', 'Toast'], datasets: [{ label: 'Kids', values: [40, 30, 20, 10] }] }, notes: 'Survey data.' },
          { layout: 'quiz', heading: 'Quick Check', question: 'Which breakfast has the most protein?', options: ['Orange juice', 'Eggs', 'White toast', 'Jam'], correctIndex: 1, notes: 'Eggs win.' },
        ],
      }) } }] });
    }
    if (req.method === 'GET' && p === '/models') return sendJson(200, { data: [{ id: 'gpt-4o-mini' }] });
    return sendJson(404, { error: `mock: no route ${req.method} ${p}` });
  });
}

function testDeck() {
  return {
    version: 1, title: 'Test Deck', width: 1920, height: 1080,
    slides: [
      {
        id: 'slide_1', layout: 'title', background: { type: 'color', color: '#151d3a' }, notes: 'Intro', duration: 5,
        elements: [
          { id: 'layer_t1', type: 'text', name: 'Title', x: 260, y: 380, w: 1400, h: 120, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, role: 'title', text: { text: 'Test Deck', fontFamily: 'Poppins', fontSize: 96, fontWeight: 700, fontStyle: 'normal', underline: false, align: 'center', color: '#ffffff', letterSpacing: 0, lineHeight: 1.25, shadow: null, stroke: null, gradient: null } },
        ],
      },
      {
        id: 'slide_2', layout: 'chart', background: { type: 'color', color: '#151d3a' }, notes: '', duration: 5,
        elements: [
          { id: 'layer_t2', type: 'text', name: 'Title', x: 120, y: 90, w: 1680, h: 100, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, role: 'title', text: { text: 'Chart Title', fontFamily: 'Poppins', fontSize: 64, fontWeight: 700, fontStyle: 'normal', underline: false, align: 'left', color: '#ffffff', letterSpacing: 0, lineHeight: 1.25, shadow: null, stroke: null, gradient: null } },
          { id: 'layer_c1', type: 'chart', name: 'Chart', x: 160, y: 240, w: 1600, h: 720, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, chart: { type: 'bar', title: '', legend: true, showValues: true, labels: ['Jan', 'Feb', 'Mar'], datasets: [{ label: 'Sales', values: [12, 19, 8], color: '#7c5cff' }] } },
        ],
      },
    ],
  };
}
function testQuizDeck() {
  const d = testDeck();
  d.slides.push({
    id: 'slide_q', layout: 'quiz', background: { type: 'color', color: '#151d3a' }, notes: '', duration: 5,
    elements: [
      { id: 'layer_q', type: 'text', name: 'Question', x: 120, y: 90, w: 1680, h: 120, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, role: 'question', text: { text: 'Which planet is known as the Red Planet?', fontFamily: 'Poppins', fontSize: 56, fontWeight: 700, fontStyle: 'normal', underline: false, align: 'left', color: '#ffffff', letterSpacing: 0, lineHeight: 1.25, shadow: null, stroke: null, gradient: null } },
      ...['Mars', 'Venus is a very long option name that keeps going and going', 'Jupiter', 'Saturn'].map((t, i) => ({
        id: `layer_o${i}`, type: 'text', name: `Option ${String.fromCharCode(65 + i)}`, x: 180, y: 300 + i * 170, w: 1560, h: 60, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, role: 'option',
        text: { text: `${String.fromCharCode(65 + i)}. ${t}`, fontFamily: 'Poppins', fontSize: 40, fontWeight: 500, fontStyle: 'normal', underline: false, align: 'left', color: '#ffffff', letterSpacing: 0, lineHeight: 1.25, shadow: null, stroke: null, gradient: null },
      })),
    ],
  });
  return d;
}
function testDoc(mediaId) {
  return {
    version: 1, title: 'Test Document',
    blocks: [
      { id: 'b1', type: 'heading', level: 1, text: 'Test Document' },
      { id: 'b2', type: 'paragraph', text: 'This is the opening paragraph of the test document. It has more than one sentence so the PDF pagination has something to wrap.' },
      { id: 'b3', type: 'list', style: 'bullet', items: ['First point', 'Second point', 'Third point'] },
      { id: 'b4', type: 'table', headers: ['Name', 'Score'], rows: [['Aisha', '95'], ['Bilal', '88']] },
      { id: 'b5', type: 'image', mediaId, caption: 'A test image' },
      { id: 'b6', type: 'quote', text: 'A short quote to check the quote block.' },
    ],
  };
}
function testDesign() {
  return {
    version: 1, width: 1080, height: 1080,
    background: { type: 'color', color: '#7c5cff', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } },
    layers: [
      { id: 'layer-d1', type: 'text', name: 'Headline', x: 140, y: 400, w: 800, h: 120, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: 'Hello Website', fontFamily: 'Poppins', fontSize: 72, fontWeight: 700, fontStyle: 'normal', underline: false, align: 'center', color: '#ffffff', letterSpacing: 0, lineHeight: 1.2, shadow: null, stroke: null, gradient: null } },
      { id: 'layer-d2', type: 'shape', name: 'Bar', x: 140, y: 560, w: 800, h: 24, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, shape: { kind: 'rect', fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 12, shadow: null } },
    ],
  };
}

before(async () => {
  testImage = path.join(tmp, 'test.png');
  makeTestImage(testImage, 'red', '320x180');

  mockServer = http.createServer(mockHandler);
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;

  const env = {
    ...process.env,
    DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir,
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

  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'Docs Tester', email: 'docs@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  ownerCookie = s.setCookie.split(';')[0];

  const u = await req('/api/auth/signup', { method: 'POST', body: { name: 'Second User', email: 'second-docs@test.local', password: 'password123' } });
  assert.equal(u.status, 201, JSON.stringify(u.json));
  userCookie = u.setCookie.split(';')[0];
});

after(async () => {
  if (server) server.kill('SIGKILL');
  if (mockServer) await new Promise((r) => mockServer.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function configureMockLlm() {
  const mockBase = `http://127.0.0.1:${mockPort}`;
  const cfg = await req('/api/providers/llm/config', { method: 'POST', cookie: ownerCookie, body: { baseUrl: mockBase } });
  assert.equal(cfg.status, 200, `config llm: ${JSON.stringify(cfg.json)}`);
  const key = await req('/api/providers/llm/key', { method: 'POST', cookie: ownerCookie, body: { key: 'mock-test-key-12345' } });
  assert.equal(key.status, 200, `key llm: ${JSON.stringify(key.json)}`);
}

// --- Deck validation + fit checks ---------------------------------------------
test('deck validation accepts a good deck and refuses bad ones', async () => {
  const good = await req('/api/docs-slides/decks/validate', { method: 'POST', cookie: ownerCookie, body: { deck: testDeck() } });
  assert.equal(good.status, 200, JSON.stringify(good.json));
  assert.equal(good.json.needsAttention.length, 0, 'a reasonable deck must need no attention');
  assert.equal(good.json.slides.length, 2, 'two slides reported');

  const empty = await req('/api/docs-slides/decks/validate', { method: 'POST', cookie: ownerCookie, body: { deck: { version: 1, title: 'X', width: 1920, height: 1080, slides: [] } } });
  assert.equal(empty.status, 400, 'a deck with no slides must be refused');

  const badLayout = testDeck();
  badLayout.slides[0].layout = 'not-a-layout';
  const bad = await req('/api/docs-slides/decks/validate', { method: 'POST', cookie: ownerCookie, body: { deck: badLayout } });
  assert.equal(bad.status, 400, 'an unknown slide layout must be refused');

  const anon = await req('/api/docs-slides/decks/validate', { method: 'POST', body: { deck: testDeck() } });
  assert.equal(anon.status, 401, 'anonymous deck validation must be refused');
});

test('deck fit check flags overflowing text as Needs attention (never broken)', async () => {
  const d = testDeck();
  d.slides[0].elements[0].text.text = 'A'.repeat(1500);
  d.slides[0].elements[0].w = 200;
  d.slides[0].elements[0].h = 60;
  const r = await req('/api/docs-slides/decks/validate', { method: 'POST', cookie: ownerCookie, body: { deck: d } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.needsAttention.length >= 1, 'absurdly long text must be flagged');
  assert.equal(r.json.needsAttention[0].layerId, 'layer_t1', JSON.stringify(r.json));
  assert.ok(r.json.needsAttention[0].suggestedText, 'flagged text must carry a shorter suggestion');
});

test('quiz slides share one option font across the deck (uniform font)', async () => {
  const d = testQuizDeck();
  const r = await req('/api/docs-slides/decks/validate', { method: 'POST', cookie: ownerCookie, body: { deck: d, applyUniformFonts: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.appliedUniformFonts, true, 'uniform fonts must be applied');
  assert.ok(r.json.batchFonts && r.json.batchFonts.option >= 12, `batch option font must be readable: ${JSON.stringify(r.json.batchFonts)}`);
  const optionLayers = r.json.deck.slides[2].elements.filter((e) => e.role === 'option');
  assert.equal(optionLayers.length, 4, 'four option layers');
  const sizes = new Set(optionLayers.map((l) => l.text.fontSize));
  assert.equal(sizes.size, 1, `all options must share ONE font size, got ${[...sizes]}`);
});

// --- Charts ---------------------------------------------------------------------
test('chart CSV parse skips duplicate rows permanently and refuses bad numbers', async () => {
  const r = await req('/api/docs-slides/charts/parse', {
    method: 'POST', cookie: ownerCookie,
    body: { csv: 'Month,Sales,Costs\nJan,10,4\nFeb,20,8\nJan,10,4\nMar,15,6' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.labels, ['Jan', 'Feb', 'Mar'], 'duplicate Jan row must be dropped');
  assert.equal(r.json.skipped, 1, 'one duplicate skipped');
  assert.deepEqual(r.json.skippedRows, [4], 'skipped row number reported (file line, header is line 1)');
  assert.equal(r.json.totalRows, 4, 'total rows reported');
  assert.deepEqual(r.json.datasets[0].values, [10, 20, 15], 'values follow the deduped labels');

  const bad = await req('/api/docs-slides/charts/parse', {
    method: 'POST', cookie: ownerCookie,
    body: { csv: 'Month,Sales\nJan,ten' },
  });
  assert.equal(bad.status, 400, 'a non-number value must be refused');

  const anon = await req('/api/docs-slides/charts/parse', { method: 'POST', body: { csv: 'Month,Sales\nJan,10' } });
  assert.equal(anon.status, 401, 'anonymous chart parse must be refused');
});

test('chart render returns SVG and a real PNG in the Media Library', async () => {
  const spec = { type: 'bar', title: 'Sales', labels: ['Jan', 'Feb', 'Mar'], datasets: [{ label: 'Sales', values: [12, 19, 8] }] };
  const r = await req('/api/docs-slides/charts/render', { method: 'POST', cookie: ownerCookie, body: { spec } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.svg.includes('<svg'), 'SVG must be returned');
  assert.ok(r.json.svg.includes('Sales'), 'SVG must carry the title');
  assert.ok(r.json.media && r.json.media.id, 'rendered chart must be saved to the Media Library');
  assert.equal(r.json.media.width, 960, 'chart PNG width');
  assert.equal(r.json.media.height, 540, 'chart PNG height');
  const buf = await downloadGet(`/api/media/${r.json.media.id}/file`);
  assert.equal(buf.status, 200, 'saved chart must download');
  const tmpFile = path.join(tmp, 'chart-lib.png');
  fs.writeFileSync(tmpFile, buf.buf);
  const info = await ffprobe(tmpFile);
  assert.equal(info.streams[0].width, 960, 'saved chart file width');
  assert.equal(info.streams[0].height, 540, 'saved chart file height');

  const pie = await req('/api/docs-slides/charts/render', { method: 'POST', cookie: ownerCookie, body: { spec: { type: 'pie', title: 'Share', labels: ['A', 'B'], datasets: [{ label: 'S', values: [70, 30] }] } } });
  assert.equal(pie.status, 200, JSON.stringify(pie.json));
  assert.ok(pie.json.svg.includes('<path'), 'pie SVG must carry slice paths');

  const bad = await req('/api/docs-slides/charts/render', { method: 'POST', cookie: ownerCookie, body: { spec: { type: 'bar', labels: [], datasets: [] } } });
  assert.equal(bad.status, 400, 'an invalid chart spec must be refused');
});

// --- Deck exports ----------------------------------------------------------------
let deckProject;
test('deck project can be created and exported as slide images (ZIP)', async () => {
  deckProject = await createProject('Export Deck', 'deck', testDeck());
  const dl = await download(`/api/docs-slides/decks/${deckProject.id}/export/images`);
  assert.equal(dl.status, 200, `images export: ${dl.status}`);
  assert.ok(dl.buf.length > 1000, 'ZIP must not be empty');
  const zipPath = path.join(tmp, 'deck-slides.zip');
  fs.writeFileSync(zipPath, dl.buf);
  const list = await unzipList(zipPath);
  assert.ok(list.includes('slide-01.png'), 'ZIP must contain slide-01.png');
  assert.ok(list.includes('slide-02.png'), 'ZIP must contain slide-02.png');
  const png = await unzipFile(zipPath, 'slide-01.png');
  const pngPath = path.join(tmp, 'slide-01.png');
  fs.writeFileSync(pngPath, png);
  const info = await ffprobe(pngPath);
  assert.equal(info.streams[0].width, 1920, 'slide image width');
  assert.equal(info.streams[0].height, 1080, 'slide image height');
});

test('deck export to PDF has one page per slide at slide aspect', async () => {
  const dl = await download(`/api/docs-slides/decks/${deckProject.id}/export/pdf`);
  assert.equal(dl.status, 200, `pdf export: ${dl.status}`);
  const pdfPath = path.join(tmp, 'deck.pdf');
  fs.writeFileSync(pdfPath, dl.buf);
  assert.equal(dl.buf.slice(0, 5).toString(), '%PDF-', 'output must be a PDF');
  const info = await pdfinfo(pdfPath);
  assert.match(info, /Pages:\s+2/, `deck PDF must have 2 pages: ${info}`);
  assert.match(info, /Page size:\s+1280 x 720 pts/, `deck PDF page size must be 1280x720: ${info}`);
});

test('deck export to video renders a real MP4 through the render queue', async () => {
  const r = await req(`/api/docs-slides/decks/${deckProject.id}/export/video`, { method: 'POST', cookie: ownerCookie, body: { secondsPerSlide: 2, fps: 30 } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const job = await pollRenderJob(r.json.job.id);
  assert.equal(job.status, 'done', `deck video job must finish done: ${JSON.stringify(job)}`);
  assert.equal(job.hasOutput, true, 'deck video job must have output');
  const dl = await downloadGet(`/api/video/jobs/${job.id}/download`);
  assert.equal(dl.status, 200, `video download: ${dl.status}`);
  const mp4Path = path.join(tmp, 'deck.mp4');
  fs.writeFileSync(mp4Path, dl.buf);
  const info = await ffprobe(mp4Path);
  const video = info.streams.find((s) => s.codec_type === 'video');
  assert.equal(video.width, 1920, 'deck video width');
  assert.equal(video.height, 1080, 'deck video height');
  const dur = parseFloat(info.format.duration);
  // v2.5.0 #19: per-slide durations win over secondsPerSlide — this deck's
  // slides each carry duration: 5, so 5 + 5 = 10s (no transitions to subtract).
  assert.ok(dur >= 9.5 && dur <= 10.5, `deck video duration ~10s (2 slides x 5s per-slide duration): ${dur}`);
});

// --- Documents -------------------------------------------------------------------
let docProject;
let docImage;
test('document exports: HTML, real DOCX and A4 PDF', async () => {
  docImage = await uploadMedia(testImage, 'doc-img.png', 'image/png');
  docProject = await createProject('Export Doc', 'doc', testDoc(docImage.id));

  const html = await download(`/api/docs-slides/docs/${docProject.id}/export/html`);
  assert.equal(html.status, 200, `html export: ${html.status}`);
  const htmlText = html.buf.toString('utf8');
  assert.ok(htmlText.includes('<h1>Test Document</h1>'), 'HTML must carry the heading');
  assert.ok(htmlText.includes('<table>'), 'HTML must carry the table');
  assert.ok(htmlText.includes('Aisha'), 'HTML must carry the table data');

  const docx = await download(`/api/docs-slides/docs/${docProject.id}/export/docx`);
  assert.equal(docx.status, 200, `docx export: ${docx.status}`);
  const docxPath = path.join(tmp, 'doc.docx');
  fs.writeFileSync(docxPath, docx.buf);
  const list = await unzipList(docxPath);
  assert.ok(list.includes('word/document.xml'), 'DOCX must contain word/document.xml');
  assert.ok(list.includes('[Content_Types].xml'), 'DOCX must contain [Content_Types].xml');
  assert.ok(list.includes('word/media/'), 'DOCX must embed the image');
  const docXml = await unzipFile(docxPath, 'word/document.xml');
  assert.ok(docXml.includes('Test Document'), 'DOCX document.xml must carry the heading');
  assert.ok(docXml.includes('Aisha'), 'DOCX document.xml must carry the table data');

  const pdf = await download(`/api/docs-slides/docs/${docProject.id}/export/pdf`);
  assert.equal(pdf.status, 200, `pdf export: ${pdf.status}`);
  const pdfPath = path.join(tmp, 'doc.pdf');
  fs.writeFileSync(pdfPath, pdf.buf);
  const info = await pdfinfo(pdfPath);
  assert.match(info, /Pages:\s+1/, `doc PDF must have 1 page: ${info}`);
  assert.match(info, /Page size:\s+595.28 x 841.89 pts/, `doc PDF must be A4: ${info}`);
});

// --- Websites --------------------------------------------------------------------
let siteSlug;
test('website publish serves the design and unpublish removes it', async () => {
  const designProject = await createProject('Site Design', 'design', testDesign());
  const r = await req('/api/docs-slides/websites/publish', { method: 'POST', cookie: ownerCookie, body: { projectId: designProject.id } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(r.json.site.slug, 'published site must have a slug');
  assert.ok(r.json.site.url.startsWith('/sites/'), 'site url must be under /sites/');
  siteSlug = r.json.site.slug;
  const page = await downloadGet(r.json.site.url);
  assert.equal(page.status, 200, `site page: ${page.status}`);
  assert.ok(page.buf.toString('utf8').includes('Site Design'), 'site page must carry the project title');
  assert.ok(page.buf.toString('utf8').includes('Hello Website'), 'site page must carry the design text');

  const list = await req('/api/docs-slides/websites', { cookie: ownerCookie });
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.ok(list.json.sites.some((s) => s.slug === siteSlug), 'published site must be listed');

  const del = await req(`/api/docs-slides/websites/${siteSlug}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  const gone = await downloadGet(`/sites/${siteSlug}/`);
  assert.equal(gone.status, 404, 'unpublished site must 404');

  const bad = await req('/api/docs-slides/websites/publish', { method: 'POST', cookie: ownerCookie, body: { projectId: 999999 } });
  assert.equal(bad.status, 404, 'publishing a missing project must 404');
});

// --- Print ------------------------------------------------------------------------
test('print PDF is full-bleed A4 with crop marks (page bigger than trim)', async () => {
  const designProject = await createProject('Print Design', 'design', testDesign());
  const res = await fetch(`${BASE}/api/docs-slides/print/pdf`, {
    method: 'POST', headers: { cookie: ownerCookie, 'Content-Type': 'application/json', connection: 'close' },
    body: JSON.stringify({ projectId: designProject.id, sizeId: 'a4', bleedMm: 3, marginMm: 10 }),
    redirect: 'manual',
  });
  assert.equal(res.status, 200, `print pdf: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const pdfPath = path.join(tmp, 'print.pdf');
  fs.writeFileSync(pdfPath, buf);
  const info = await pdfinfo(pdfPath);
  // A4 trim 595.28 x 841.89 pt + 3mm bleed each side (8.5pt) = 612.288 x 858.898.
  assert.match(info, /Pages:\s+1/, `print PDF must have 1 page: ${info}`);
  assert.match(info, /Page size:\s+612\.28\d* x 858\.89\d* pts/, `print PDF page must be full-bleed A4: ${info}`);
  const text = buf.toString('latin1');
  assert.ok(text.includes('0.000 0.000 0.000 RG'), 'print PDF must draw crop marks in black');
  assert.ok(text.includes('0.486 0.361 1.000 RG'), 'print PDF must draw the purple safe-zone rectangle');

  const badSize = await req('/api/docs-slides/print/pdf', { method: 'POST', cookie: ownerCookie, body: { projectId: designProject.id, sizeId: 'nope' } });
  assert.equal(badSize.status, 400, 'an unknown print size must be refused');
});

// --- AI deck generation ------------------------------------------------------------
test('AI deck generation refuses without an LLM key (no project created)', async () => {
  const countDecks = (list) => (list.json.projects || []).filter((p) => p.type === 'deck').length;
  const before = await req('/api/projects?limit=100', { cookie: ownerCookie });
  const beforeCount = countDecks(before);
  const created = await req('/api/docs-slides/decks/generate', { method: 'POST', cookie: ownerCookie, body: { topic: 'Healthy breakfast ideas', slideCount: 4 } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const job = await pollAiJob(created.json.job.id);
  assert.equal(job.status, 'failed', JSON.stringify(job));
  assert.match(job.error, /no API key|key needed|not configured/i, `refusal must name the missing key: ${job.error}`);
  assert.equal(job.result, null, 'a refused deck job must not create a result');
  const after = await req('/api/projects?limit=100', { cookie: ownerCookie });
  assert.equal(countDecks(after), beforeCount, 'a refused deck job must create no project');
});

test('AI deck generation with a mock LLM builds a real deck project', async () => {
  await configureMockLlm();
  const created = await req('/api/docs-slides/decks/generate', { method: 'POST', cookie: ownerCookie, body: { topic: 'Healthy breakfast ideas', slideCount: 4 } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const job = await pollAiJob(created.json.job.id);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.ok(job.result, 'deck job must have a result');
  assert.ok(job.result.projectId, 'deck job must return the new project id');
  assert.equal(job.result.slideCount, 4, 'deck must have 4 slides');
  const p = await req(`/api/projects/${job.result.projectId}`, { cookie: ownerCookie });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.project.type, 'deck', 'generated project must be a deck');
  assert.equal(p.json.project.content.slides.length, 4, 'generated deck must have 4 slides');
  assert.equal(p.json.project.content.slides[0].layout, 'title', 'first slide must be the title layout');
  const quizSlide = p.json.project.content.slides.find((s) => s.layout === 'quiz');
  assert.ok(quizSlide, 'the mock outline includes a quiz slide');
  const correctBox = quizSlide.elements.find((e) => e.type === 'shape' && e.shape.fill === '#16a34a');
  assert.ok(correctBox, 'the correct option box must be green');
  // The generated deck must pass the fit check (auto-fit applied).
  const check = await req('/api/docs-slides/decks/validate', { method: 'POST', cookie: ownerCookie, body: { deck: p.json.project.content } });
  assert.equal(check.status, 200, JSON.stringify(check.json));
  assert.equal(check.json.needsAttention.length, 0, `generated deck must fit: ${JSON.stringify(check.json.needsAttention)}`);
});

// --- Isolation + anonymous ----------------------------------------------------------
test('per-user isolation + anonymous 401 on docs-slides routes', async () => {
  const otherReq = await fetch(`${BASE}/api/docs-slides/decks/${deckProject.id}/export/pdf`, {
    method: 'POST', headers: { cookie: userCookie, 'Content-Type': 'application/json', connection: 'close' }, redirect: 'manual',
  });
  assert.equal(otherReq.status, 404, "another user must not export my deck");
  const otherSite = await req('/api/docs-slides/websites/publish', { method: 'POST', cookie: userCookie, body: { projectId: deckProject.id } });
  assert.equal(otherSite.status, 404, "another user must not publish my project");
  const anon = await req('/api/docs-slides/charts/render', { method: 'POST', body: { spec: { type: 'bar', labels: ['A'], datasets: [{ label: 'S', values: [1] }] } } });
  assert.equal(anon.status, 401, 'anonymous chart render must be refused');
  const anonPrint = await req('/api/docs-slides/print/pdf', { method: 'POST', body: { projectId: deckProject.id } });
  assert.equal(anonPrint.status, 401, 'anonymous print must be refused');
});
