'use strict';
// Library & Assistant tests (v2.2.4, Release D) — run with: npm test
// Spawns the real server on a scratch port (4846 — ports 4831-4845 are all
// taken by the other 15 suites) with a temp DB/uploads dir, PLUS two local
// MOCK LLM HTTP servers (A = OpenAI-style provider "llm", B = Gemini-style
// provider "gemini") and a MOCK Openverse HTTP server (Openverse is pointed
// at it via OPENVERSE_BASE_URL so nothing depends on the live internet).
// Covers: the LLM active-provider UI fix end to end (switch provider,
// the quiz job really calls the newly active provider), Stock Assets
// (search/item/save with attribution + duplicate save, video search
// refused honestly), the expanded template library (26 built-ins) +
// marketplace install, Magic Switch (reflow + translate, key_needed),
// AI Assistant (summarise/suggest/make-professional/five-versions,
// key_needed), Collaboration (link + per-user share + comments, read-only),
// and the updater node_modules overlay (hash verification, traversal and
// native refusal, backup + rollback, publish-time dep diff).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-lib-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4846;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let mockLlmA; let mockLlmB; let mockOpenverse;
let mockPortA; let mockPortB; let mockOvPort;
let ownerCookie = '';
let userCookie = '';
let thirdCookie = '';
let testImage;
let testAudio;
const hitsA = { count: 0, last: null };
const hitsB = { count: 0, last: null };
const mockStateB = { flaky503: 0, retire38: false, retireAll: false };

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
async function downloadGet(p, cookie) {
  const r = await fetch(BASE + p, { headers: { cookie: cookie || ownerCookie, connection: 'close' }, redirect: 'manual' });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
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
async function runQuizJob(cookie) {
  const r = await req('/api/ai/jobs', {
    method: 'POST', cookie: cookie || ownerCookie,
    body: { mode: 'quiz', topic: 'Test topic', count: 2, difficulty: 'easy', language: 'en' },
  });
  assert.equal(r.status, 201, `create quiz job: ${JSON.stringify(r.json)}`);
  return pollAiJob(r.json.job.id, cookie);
}
function makeTestImage(file, color = 'red', size = '320x180') {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=1`, '-frames:v', '1', file], { timeout: 30000 });
}
function makeTestAudio(file) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', file], { timeout: 30000 });
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// --- Local mock LLM -----------------------------------------------------------
// Two identical servers (A and B) that speak chat/completions + /models.
// They count every chat/completions call so the provider-switch test can
// prove WHICH provider a job really used. The reply is picked from the
// user message so one mock serves quiz, translate and assistant prompts.
// `state` lets a test arm a failure mode on one mock only:
//   flaky503 — answer the next N calls with 503 "high demand", then 200
//   retire38 — answer gemini-3.8-flash with Google's retired-model 404
//   retireAll — answer every Gemini model with the retired-model 404
function mockLlmHandler(hits, state = {}) {
  return (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let body = Buffer.alloc(0);
    req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
    req.on('end', () => {
      if (req.method === 'POST' && url.pathname === '/chat/completions') {
        hits.count += 1;
        let parsed = {};
        try { parsed = JSON.parse(body.toString()); } catch { /* ignore */ }
        hits.last = parsed;
        // Google-style 404 for a retired/unknown Gemini model — the app
        // must fall back to the next listed model, not fail on it.
        const model = parsed.model;
        const retired = (m) => `This model models/${m} is no longer available. Please update your code to use models/gemini-3.8-flash`;
        if (model && /^gemini-/.test(model)) {
          if (state.retireAll) return sendJson(404, { error: { code: 404, message: retired(model), status: 'NOT_FOUND' } });
          if (state.retire38 && model === 'gemini-3.8-flash') return sendJson(404, { error: { code: 404, message: retired(model), status: 'NOT_FOUND' } });
          if (model !== 'gemini-3.8-flash' && model !== 'gemini-2.5-flash') return sendJson(404, { error: { code: 404, message: retired(model), status: 'NOT_FOUND' } });
        }
        // Transient overload: fail the next N calls, then succeed.
        if (state.flaky503 > 0) {
          state.flaky503 -= 1;
          return sendJson(503, { error: { code: 503, message: 'The model is currently experiencing high demand. Please try again later.', status: 'UNAVAILABLE' } });
        }
        const userMsg = ((parsed.messages || []).find((m) => m.role === 'user') || {}).content || '';
        let content;
        if (userMsg.includes('Generate quiz questions')) {
          content = JSON.stringify({ questions: [
            { question: 'What is two plus two?', options: ['Three', 'Four', 'Five', 'Six'], correct: 'B', explanation: 'Two plus two is four.' },
            { question: 'What colour is the sky?', options: ['Green', 'Red', 'Blue', 'Pink'], correct: 'C', explanation: 'The sky looks blue.' },
          ] });
        } else if (userMsg.includes('Translate each text')) {
          const m = userMsg.match(/Inputs: (\[.*\])/s);
          let items = [];
          try { items = JSON.parse(m ? m[1] : '[]'); } catch { /* ignore */ }
          content = JSON.stringify({ translations: items.map((i) => ({ layerId: i.layerId, text: `TR-${i.text}` })) });
        } else if (userMsg.includes('Create five different versions')) {
          content = JSON.stringify({ versions: [1, 2, 3, 4, 5].map((n) => ({
            headline: `Version ${n} headline`, palette: { background: '#151d3a', accent: '#7c5cff', text: '#ffffff' },
            fontFamily: 'Poppins', tone: `tone ${n}`,
          })) });
        } else if (userMsg.includes('Make this design more professional')) {
          content = JSON.stringify({ headline: 'A professional headline', subheading: 'A calmer subheading', palette: { background: '#101828', accent: '#7c5cff', text: '#f8fafc' }, fontFamily: 'Inter', tone: 'confident, professional' });
        } else if (userMsg.includes('Make this deck more professional')) {
          content = JSON.stringify({ slides: [1, 2, 3, 4, 5].map((n) => ({ heading: `Slide ${n} — professional`, bullets: [`Clear point ${n} for the audience.`, `Second point ${n}.`] })) });
        } else if (userMsg.includes('Summarise this')) {
          content = JSON.stringify({ summary: 'A test design with a headline and a shape.', keyPoints: ['Has a headline layer', 'Uses a purple background'], audience: 'general', tone: 'cheerful' });
        } else if (userMsg.includes('Suggest improvements')) {
          content = JSON.stringify({ suggestions: [
            { area: 'Contrast', suggestion: 'Raise the text contrast against the background.', priority: 'high' },
            { area: 'Spacing', suggestion: 'Add more breathing room around the headline.', priority: 'medium' },
            { area: 'Call to action', suggestion: 'Add a short call to action.', priority: 'low' },
          ] });
        } else {
          content = JSON.stringify({ ok: true });
        }
        return sendJson(200, { choices: [{ message: { content } }] });
      }
      if (req.method === 'GET' && url.pathname === '/models') return sendJson(200, { data: [{ id: 'mock-model' }] });
      return sendJson(404, { error: `mock: no route ${req.method} ${url.pathname}` });
    });
  };
}

// --- Local mock Openverse -----------------------------------------------------
// Serves two images + one audio item. The file URLs point back at this
// server so /api/stock/save downloads real bytes through the app's code.
function mockOpenverseHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const base = `http://127.0.0.1:${mockOvPort}`;
  const imageItem = (id, title) => ({
    id, title, creator: 'Test Photographer', creator_url: `${base}/creator`,
    license: 'by', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: `${title} by Test Photographer is licensed under CC BY 4.0.`,
    url: `${base}/file/test.png`, foreign_landing_url: `${base}/photo/${id}`,
    thumbnail: `${base}/file/test.png`, width: 320, height: 180,
  });
  const audioItem = (id, title) => ({
    id, title, creator: 'Test Musician', creator_url: `${base}/creator`,
    license: 'by', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: `${title} by Test Musician is licensed under CC BY 4.0.`,
    url: `${base}/file/test.mp3`, foreign_landing_url: `${base}/audio/${id}`,
    thumbnail: null, duration: 500,
  });
  if (req.method === 'GET' && p === '/file/test.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(fs.readFileSync(testImage));
  }
  if (req.method === 'GET' && p === '/file/test.mp3') {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    return res.end(fs.readFileSync(testAudio));
  }
  if (req.method === 'GET' && p === '/v1/images/') {
    return sendJson(200, { result_count: 2, page_size: 2, results: [imageItem('img-1', 'Mountain sunrise'), imageItem('img-2', 'Mountain lake')] });
  }
  if (req.method === 'GET' && p === '/v1/audio/') {
    return sendJson(200, { result_count: 1, page_size: 1, results: [audioItem('aud-1', 'Soft piano')] });
  }
  if (req.method === 'GET' && p === '/v1/images/img-1') return sendJson(200, imageItem('img-1', 'Mountain sunrise'));
  if (req.method === 'GET' && p === '/v1/audio/aud-1') return sendJson(200, audioItem('aud-1', 'Soft piano'));
  return sendJson(404, { detail: 'mock openverse: not found' });
}

before(async () => {
  testImage = path.join(tmp, 'test.png');
  testAudio = path.join(tmp, 'test.mp3');
  makeTestImage(testImage, 'red', '320x180');
  makeTestAudio(testAudio);

  mockLlmA = http.createServer(mockLlmHandler(hitsA));
  await new Promise((resolve) => mockLlmA.listen(0, '127.0.0.1', resolve));
  mockPortA = mockLlmA.address().port;
  mockLlmB = http.createServer(mockLlmHandler(hitsB, mockStateB));
  await new Promise((resolve) => mockLlmB.listen(0, '127.0.0.1', resolve));
  mockPortB = mockLlmB.address().port;
  mockOpenverse = http.createServer(mockOpenverseHandler);
  await new Promise((resolve) => mockOpenverse.listen(0, '127.0.0.1', resolve));
  mockOvPort = mockOpenverse.address().port;

  const env = {
    ...process.env,
    DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir,
    PORT: String(PORT), HOST: '127.0.0.1',
    OPENVERSE_BASE_URL: `http://127.0.0.1:${mockOvPort}/v1`,
    // Fast retry backoff for the retry/fallback tests (production
    // default is 2000, 5000, 10000 ms).
    AI_RETRY_DELAYS_MS: '30,60,120',
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

  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'Library Tester', email: 'lib@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  ownerCookie = s.setCookie.split(';')[0];

  const u = await req('/api/auth/signup', { method: 'POST', body: { name: 'Second User', email: 'second-lib@test.local', password: 'password123' } });
  assert.equal(u.status, 201, JSON.stringify(u.json));
  userCookie = u.setCookie.split(';')[0];

  const t = await req('/api/auth/signup', { method: 'POST', body: { name: 'Third User', email: 'third-lib@test.local', password: 'password123' } });
  assert.equal(t.status, 201, JSON.stringify(t.json));
  thirdCookie = t.setCookie.split(';')[0];
});

after(async () => {
  if (server) server.kill('SIGKILL');
  for (const m of [mockLlmA, mockLlmB, mockOpenverse]) {
    if (m) await new Promise((r) => m.close(r));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function configureMockLlm() {
  const cfgA = await req('/api/providers/llm/config', { method: 'POST', cookie: ownerCookie, body: { baseUrl: `http://127.0.0.1:${mockPortA}` } });
  assert.equal(cfgA.status, 200, `config llm: ${JSON.stringify(cfgA.json)}`);
  const keyA = await req('/api/providers/llm/key', { method: 'POST', cookie: ownerCookie, body: { key: 'mock-test-key-A' } });
  assert.equal(keyA.status, 200, `key llm: ${JSON.stringify(keyA.json)}`);
  const cfgB = await req('/api/providers/gemini/config', { method: 'POST', cookie: ownerCookie, body: { baseUrl: `http://127.0.0.1:${mockPortB}` } });
  assert.equal(cfgB.status, 200, `config gemini: ${JSON.stringify(cfgB.json)}`);
  const keyB = await req('/api/providers/gemini/key', { method: 'POST', cookie: ownerCookie, body: { key: 'mock-test-key-B' } });
  assert.equal(keyB.status, 200, `key gemini: ${JSON.stringify(keyB.json)}`);
}

function testDesign() {
  return {
    version: 1, width: 1080, height: 1080,
    background: { type: 'color', color: '#7c5cff' },
    layers: [
      { id: 'layer-t1', type: 'text', name: 'Headline', x: 140, y: 400, w: 800, h: 120, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: 'Hello Library', fontFamily: 'Poppins', fontSize: 72, fontWeight: 700, fontStyle: 'normal', underline: false, align: 'center', color: '#ffffff', letterSpacing: 0, lineHeight: 1.2, shadow: null, stroke: null, gradient: null } },
      { id: 'layer-s1', type: 'shape', name: 'Bar', x: 140, y: 560, w: 800, h: 24, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, shape: { kind: 'rect', fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 12, shadow: null } },
    ],
  };
}

// --- LLM active-provider fix: static guard + end-to-end switch ------------
// Phase A runs with NO LLM key configured: every LLM job must refuse
// honestly with key_needed and create nothing.
test('LLM active-provider UI: no hardcoded active-kind list in app.js', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!appJs.includes("['image', 'tts']"), 'the old hardcoded active-kind list must be gone');
  assert.ok(appJs.includes('new Set(prov.providers.map'), 'kinds must be derived from the provider list');
  assert.ok(appJs.includes('data-active-kind'), 'the section must render a per-kind active-provider select');
  assert.ok(appJs.includes('/api/providers/active'), 'the section must post to the active-provider API');
});

test('without an LLM key, a quiz job fails key_needed and creates nothing', async () => {
  const beforeJobs = await req('/api/ai/jobs', { cookie: ownerCookie });
  assert.equal(beforeJobs.status, 200, JSON.stringify(beforeJobs.json));
  const job = await runQuizJob(ownerCookie);
  assert.equal(job.status, 'failed', JSON.stringify(job));
  assert.ok(/not configured|no API key|key_needed/i.test(job.error || ''), `error must say the LLM is not configured: ${job.error}`);
  const afterJobs = await req('/api/ai/jobs', { cookie: ownerCookie });
  assert.equal(afterJobs.json.jobs.length, beforeJobs.json.jobs.length + 1, 'only the failed job itself was recorded');
});

test('without an LLM key, assistant + switch-translate refuse 402 key_needed', async () => {
  const design = await createProject('Switch Source', 'design', testDesign());
  const countBefore = (await req('/api/projects', { cookie: ownerCookie })).json.projects.length;
  const sum = await req('/api/assistant/summarise', { method: 'POST', cookie: ownerCookie, body: { projectId: design.id } });
  assert.equal(sum.status, 402, JSON.stringify(sum.json));
  assert.equal(sum.json.code, 'PROVIDER_KEY_NEEDED', JSON.stringify(sum.json));
  const sw = await req('/api/magic/switch', { method: 'POST', cookie: ownerCookie, body: { projectId: design.id, translateTo: 'ur' } });
  assert.equal(sw.status, 402, JSON.stringify(sw.json));
  assert.equal(sw.json.code, 'PROVIDER_KEY_NEEDED', JSON.stringify(sw.json));
  const countAfter = (await req('/api/projects', { cookie: ownerCookie })).json.projects.length;
  assert.equal(countAfter, countBefore, 'no project may be created when the key is missing');
});

// Phase B: configure both mock LLMs, then prove the switch works end to end.
test('configure both mock LLMs and switch the active LLM provider to Gemini', async () => {
  await configureMockLlm();
  const before = await req('/api/providers', { cookie: ownerCookie });
  assert.equal(before.status, 200, JSON.stringify(before.json));
  const llmProv = before.json.providers.find((p) => p.id === 'llm');
  const gemProv = before.json.providers.find((p) => p.id === 'gemini');
  assert.ok(llmProv && llmProv.active, 'OpenAI-style provider is the default active LLM provider');
  assert.ok(gemProv && !gemProv.active, 'Gemini is not active yet');

  // Default active provider runs the job: mock A is hit, mock B is not.
  hitsA.count = 0; hitsB.count = 0;
  const jobA = await runQuizJob(ownerCookie);
  assert.equal(jobA.status, 'done', JSON.stringify(jobA));
  assert.equal(hitsA.count, 1, 'the default (OpenAI) mock must be called once');
  assert.equal(hitsB.count, 0, 'the Gemini mock must not be called while it is inactive');

  // Switch to Gemini, as the user does in Settings after pasting a key.
  const sw = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'gemini' } });
  assert.equal(sw.status, 200, JSON.stringify(sw.json));
  const after = await req('/api/providers', { cookie: ownerCookie });
  const gemAfter = after.json.providers.find((p) => p.id === 'gemini');
  const llmAfter = after.json.providers.find((p) => p.id === 'llm');
  assert.ok(gemAfter.active && !llmAfter.active, 'Gemini must now be the active LLM provider');
  assert.ok(gemAfter.label && /Gemini/i.test(gemAfter.label), 'the active provider label must say Gemini');

  // The next job really calls Gemini, not OpenAI.
  hitsA.count = 0; hitsB.count = 0;
  const jobB = await runQuizJob(ownerCookie);
  assert.equal(jobB.status, 'done', JSON.stringify(jobB));
  assert.equal(hitsB.count, 1, 'the Gemini mock must be called once after the switch');
  assert.equal(hitsA.count, 0, 'the OpenAI mock must not be called after the switch');
  assert.ok(Array.isArray(jobB.result.questions) && jobB.result.questions.length === 2, 'the quiz result must come back from the mock');

  // Non-admin users cannot change the active provider.
  const no = await req('/api/providers/active', { method: 'POST', cookie: userCookie, body: { kind: 'llm', provider: 'llm' } });
  assert.ok([401, 403].includes(no.status), `second user must be refused: ${no.status}`);
  // Switch back to the default provider so later tests use mock A.
  const back = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'llm' } });
  assert.equal(back.status, 200, JSON.stringify(back.json));
});

// --- Gemini default model (v2.2.4): gemini-2.0-flash was retired by Google ---
test('Gemini default model is gemini-3.8-flash; a retired model upgrades, an unknown one falls back to the working default', async () => {
  const st = await req('/api/providers', { cookie: ownerCookie });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  const gemini = st.json.providers.find((p) => p.id === 'gemini');
  assert.ok(gemini.models.includes('gemini-3.8-flash'), 'gemini-3.8-flash must be offered');
  assert.ok(!gemini.models.includes('gemini-2.0-flash'), 'retired gemini-2.0-flash must not be offered');
  assert.equal(gemini.model, 'gemini-3.8-flash', 'the resolved default model must be gemini-3.8-flash');

  // A stored override naming the retired model is upgraded at resolve time.
  const setOld = await req('/api/providers/gemini/config', { method: 'POST', cookie: ownerCookie, body: { model: 'gemini-2.0-flash' } });
  assert.equal(setOld.status, 200, JSON.stringify(setOld.json));
  const afterOld = await req('/api/providers', { cookie: ownerCookie });
  assert.equal(afterOld.json.providers.find((p) => p.id === 'gemini').model, 'gemini-3.8-flash', 'a stored gemini-2.0-flash override must resolve to gemini-3.8-flash');

  // With Gemini active, a quiz job really calls the new default model.
  const act = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'gemini' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  hitsB.count = 0; hitsB.last = null;
  const job = await runQuizJob(ownerCookie);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(hitsB.last && hitsB.last.model, 'gemini-3.8-flash', 'the request must be built with gemini-3.8-flash');

  // An unknown model 404s — and the call falls back to the working
  // default instead of failing. The job result records which model
  // finally succeeded.
  const setFake = await req('/api/providers/gemini/config', { method: 'POST', cookie: ownerCookie, body: { model: 'gemini-9.9-fake' } });
  assert.equal(setFake.status, 200, JSON.stringify(setFake.json));
  hitsB.count = 0; hitsB.last = null;
  const bad = await runQuizJob(ownerCookie);
  assert.equal(bad.status, 'done', JSON.stringify(bad));
  assert.equal(bad.result.model, 'gemini-3.8-flash', 'the job must fall back to the working default model');
  assert.equal(hitsB.count, 2, 'one 404 on the unknown model, then one success on the fallback');
  assert.equal(hitsB.last && hitsB.last.model, 'gemini-3.8-flash', 'the fallback request must use gemini-3.8-flash');

  // Clean up: clear the override (empty model = use the default) and hand
  // the active provider back to OpenAI.
  const clear = await req('/api/providers/gemini/config', { method: 'POST', cookie: ownerCookie, body: { model: '' } });
  assert.equal(clear.status, 200, JSON.stringify(clear.json));
  const afterClear = await req('/api/providers', { cookie: ownerCookie });
  assert.equal(afterClear.json.providers.find((p) => p.id === 'gemini').model, 'gemini-3.8-flash');
  const back = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'llm' } });
  assert.equal(back.status, 200, JSON.stringify(back.json));
});

// --- Retry + fallback (v2.2.4): a transient overload must never fail a job ---
test('LLM retries a transient 503 and succeeds — the user never presses Retry', async () => {
  const act = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'gemini' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  mockStateB.flaky503 = 2;
  hitsB.count = 0; hitsB.last = null;
  try {
    const job = await runQuizJob(ownerCookie);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal(job.result.model, 'gemini-3.8-flash', 'the job must succeed on the configured model');
    assert.ok(Array.isArray(job.result.questions) && job.result.questions.length === 2, 'the quiz result must come back');
    assert.equal(hitsB.count, 3, 'two 503s, then a success on the third attempt — no user retry needed');
  } finally {
    mockStateB.flaky503 = 0;
    await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'llm' } });
  }
});

test('LLM falls back to gemini-2.5-flash when gemini-3.8-flash returns 404', async () => {
  const act = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'gemini' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  mockStateB.retire38 = true;
  hitsB.count = 0; hitsB.last = null;
  try {
    const job = await runQuizJob(ownerCookie);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal(job.result.model, 'gemini-2.5-flash', 'the job must record the fallback model that finally succeeded');
    assert.equal(hitsB.last && hitsB.last.model, 'gemini-2.5-flash', 'the fallback request must use gemini-2.5-flash');
    assert.equal(hitsB.count, 2, 'one 404 on gemini-3.8-flash, then one success on gemini-2.5-flash');
  } finally {
    mockStateB.retire38 = false;
    await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'llm' } });
  }
});

test('when every Gemini model is retired, the job fails with one friendly line, never a raw dump', async () => {
  const act = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'gemini' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  mockStateB.retireAll = true;
  try {
    const job = await runQuizJob(ownerCookie);
    assert.equal(job.status, 'failed', JSON.stringify(job));
    assert.ok(/no longer available/i.test(job.error || ''), `the error must say the models are no longer available: ${job.error}`);
    assert.ok((job.error || '').includes('gemini-3.8-flash'), `the error must name a model that was tried: ${job.error}`);
    assert.ok(!(job.error || '').includes('{"error"'), 'the error must not be a raw provider JSON dump');
    assert.ok(!(job.error || '').includes('"code"'), 'the error must not leak raw provider fields');
    assert.ok(!(job.error || '').includes('\n'), 'the error must be one plain line');
  } finally {
    mockStateB.retireAll = false;
    await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'llm' } });
  }
});

test('when Gemini stays overloaded, the job fails with one friendly line after all retries and fallbacks', async () => {
  const act = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'gemini' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  mockStateB.flaky503 = 99;
  hitsB.count = 0;
  try {
    const job = await runQuizJob(ownerCookie);
    assert.equal(job.status, 'failed', JSON.stringify(job));
    assert.ok(/overloaded/i.test(job.error || ''), `the error must say the provider is overloaded: ${job.error}`);
    assert.ok(/try again in a few minutes/i.test(job.error || ''), `the error must tell the user what to do: ${job.error}`);
    assert.ok(!(job.error || '').includes('{"error"'), 'the error must not be a raw provider JSON dump');
    assert.ok(!(job.error || '').includes('high demand'), 'the raw provider wording must stay in the log, not the user message');
    assert.equal(hitsB.count, 8, '4 attempts on gemini-3.8-flash, then 4 on the gemini-2.5-flash fallback');
  } finally {
    mockStateB.flaky503 = 0;
    await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'llm' } });
  }
});

test('fetchWithRetry retries transient 503s, gives up after the budget, and never retries a 500', async () => {
  const providers = require('../src/providers');
  const prev = process.env.AI_RETRY_DELAYS_MS;
  process.env.AI_RETRY_DELAYS_MS = '10,20,30';
  const servers = [];
  try {
    let n = 0;
    const flaky = http.createServer((req, res) => {
      n += 1;
      if (n <= 2) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'overloaded' } })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
    servers.push(flaky);
    const meta = {};
    const res = await providers.fetchWithRetry(`http://127.0.0.1:${flaky.address().port}/x`, {}, 5000, meta);
    assert.equal(res.status, 200);
    assert.equal(meta.attempts, 3, 'two 503s then a success = 3 attempts');
    assert.equal(meta.retried, true);
    assert.equal(n, 3);

    let m = 0;
    const down = http.createServer((req, res) => { m += 1; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'overloaded' } })); });
    await new Promise((r) => down.listen(0, '127.0.0.1', r));
    servers.push(down);
    const meta2 = {};
    const res2 = await providers.fetchWithRetry(`http://127.0.0.1:${down.address().port}/x`, {}, 5000, meta2);
    assert.equal(res2.status, 503);
    assert.equal(meta2.attempts, 4, 'initial + 3 retries');
    assert.equal(m, 4);

    let k = 0;
    const err500 = http.createServer((req, res) => { k += 1; res.writeHead(500); res.end('boom'); });
    await new Promise((r) => err500.listen(0, '127.0.0.1', r));
    servers.push(err500);
    const meta3 = {};
    const res3 = await providers.fetchWithRetry(`http://127.0.0.1:${err500.address().port}/x`, {}, 5000, meta3);
    assert.equal(res3.status, 500);
    assert.equal(meta3.attempts, 1, 'a 500 must not be retried');
    assert.equal(k, 1);
  } finally {
    if (prev === undefined) delete process.env.AI_RETRY_DELAYS_MS;
    else process.env.AI_RETRY_DELAYS_MS = prev;
    for (const s of servers) await new Promise((r) => s.close(r));
  }
});

// --- Stock Assets -------------------------------------------------------------
test('stock search returns real results; video search is refused honestly', async () => {
  const images = await req('/api/stock/search?type=image&q=mountain', { cookie: ownerCookie });
  assert.equal(images.status, 200, JSON.stringify(images.json));
  assert.equal(images.json.results.length, 2, JSON.stringify(images.json));
  assert.ok(images.json.results[0].attribution, 'results must carry an attribution string');
  assert.ok(images.json.results[0].license, 'results must carry a license');
  assert.ok(images.json.note && images.json.note.includes('Openverse'), 'the search response must name Openverse as the source');
  const audio = await req('/api/stock/search?type=audio&q=piano', { cookie: ownerCookie });
  assert.equal(audio.status, 200, JSON.stringify(audio.json));
  assert.equal(audio.json.results.length, 1, JSON.stringify(audio.json));
  const video = await req('/api/stock/search?type=video&q=mountain', { cookie: ownerCookie });
  assert.equal(video.status, 400, JSON.stringify(video.json));
  assert.equal(video.json.code, 'NO_VIDEO_SEARCH', JSON.stringify(video.json));
  const noQ = await req('/api/stock/search?type=image', { cookie: ownerCookie });
  assert.equal(noQ.status, 400, 'search without a query must be refused');
  const anon = await req('/api/stock/search?type=image&q=mountain');
  assert.equal(anon.status, 401, 'anonymous stock search must be refused');
});

test('stock save stores the file with attribution and duplicates are skipped', async () => {
  const item = await req('/api/stock/item/image/img-1', { cookie: ownerCookie });
  assert.equal(item.status, 200, JSON.stringify(item.json));
  assert.ok(item.json.item.attribution.includes('CC BY'), JSON.stringify(item.json));
  const first = await req('/api/stock/save', { method: 'POST', cookie: ownerCookie, body: { type: 'image', id: 'img-1' } });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.ok(first.json.media, JSON.stringify(first.json));
  assert.equal(first.json.media.kind, 'image');
  assert.ok(first.json.media.licenseNote && first.json.media.licenseNote.includes('CC BY'), 'attribution must be stored on the media row');
  const file = await downloadGet(`/api/media/${first.json.media.id}/file`, ownerCookie);
  assert.equal(file.status, 200, JSON.stringify(file.headers));
  assert.deepEqual([...file.buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'the saved stock image must be a real PNG served from the Media Library');
  const countBefore = (await req('/api/media', { cookie: ownerCookie })).json.media.length;
  const dup = await req('/api/stock/save', { method: 'POST', cookie: ownerCookie, body: { type: 'image', id: 'img-1' } });
  assert.equal(dup.status, 200, JSON.stringify(dup.json));
  assert.equal(dup.json.duplicate, true, 're-saving the same stock item must report duplicate');
  assert.equal(dup.json.media.id, first.json.media.id, 'the duplicate must point at the same media row');
  const countAfter = (await req('/api/media', { cookie: ownerCookie })).json.media.length;
  assert.equal(countAfter, countBefore, 'no second media row may be created');
  const aud = await req('/api/stock/save', { method: 'POST', cookie: ownerCookie, body: { type: 'audio', id: 'aud-1' } });
  assert.equal(aud.status, 201, JSON.stringify(aud.json));
  assert.equal(aud.json.media.kind, 'audio');
  assert.ok(aud.json.media.durationSeconds > 0, 'audio duration must be probed from the file');
  const missing = await req('/api/stock/save', { method: 'POST', cookie: ownerCookie, body: { type: 'image', id: 'no-such-id' } });
  assert.equal(missing.status, 404, JSON.stringify(missing.json));
});

// --- Template library ---------------------------------------------------------
test('template library has 26 built-ins and marketplace install makes real projects', async () => {
  const all = await req('/api/marketplace/builtin', { cookie: ownerCookie });
  assert.equal(all.status, 200, JSON.stringify(all.json));
  assert.equal(all.json.templates.length, 26, `expected 26 built-ins, got ${all.json.templates.length}`);
  assert.deepEqual(all.json.counts, { design: 20, video: 3, deck: 3 }, JSON.stringify(all.json.counts));
  const decks = await req('/api/marketplace/builtin?kind=deck', { cookie: ownerCookie });
  assert.equal(decks.json.templates.length, 3, JSON.stringify(decks.json));
  const pitch = await req('/api/marketplace/builtin?q=pitch', { cookie: ownerCookie });
  assert.equal(pitch.json.templates.length, 1, JSON.stringify(pitch.json));
  assert.equal(pitch.json.templates[0].id, 'builtin-deck-pitch');

  const designOnly = await req('/api/design/templates', { cookie: ownerCookie });
  assert.equal(designOnly.status, 200, JSON.stringify(designOnly.json));
  assert.equal(designOnly.json.templates.length, 20, 'the Graphic Editor must see design templates only');
  assert.ok(designOnly.json.templates.every((t) => t.kind === 'design'));

  const deckInstall = await req('/api/marketplace/builtin/builtin-deck-pitch/install', { method: 'POST', cookie: ownerCookie });
  assert.equal(deckInstall.status, 201, JSON.stringify(deckInstall.json));
  assert.equal(deckInstall.json.installed.kind, 'deck');
  const deck = await req(`/api/projects/${deckInstall.json.installed.id}`, { cookie: ownerCookie });
  assert.equal(deck.json.project.content.slides.length, 5, 'the installed pitch deck must have 5 slides');

  const videoInstall = await req('/api/marketplace/builtin/builtin-video-intro/install', { method: 'POST', cookie: ownerCookie });
  assert.equal(videoInstall.status, 201, JSON.stringify(videoInstall.json));
  assert.equal(videoInstall.json.installed.kind, 'video');

  const designInstall = await req('/api/marketplace/builtin/builtin-eid-post/install', { method: 'POST', cookie: ownerCookie });
  assert.equal(designInstall.status, 201, JSON.stringify(designInstall.json));
  assert.equal(designInstall.json.installed.kind, 'design');

  const missing = await req('/api/marketplace/builtin/builtin-nope/install', { method: 'POST', cookie: ownerCookie });
  assert.equal(missing.status, 404, JSON.stringify(missing.json));
});

test('a deck project can be published to the marketplace and installed', async () => {
  const install = await req('/api/marketplace/builtin/builtin-deck-quiz/install', { method: 'POST', cookie: ownerCookie });
  assert.equal(install.status, 201, JSON.stringify(install.json));
  const deck = install.json.installed;
  const pub = await req('/api/marketplace', { method: 'POST', cookie: ownerCookie, body: { sourceProjectId: deck.id, kind: 'deck', name: 'Quiz Deck Template', category: 'Education', description: 'A quiz deck for the marketplace test.' } });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  const list = await req('/api/marketplace?kind=deck', { cookie: ownerCookie });
  assert.ok(list.json.templates.some((t) => t.id === pub.json.template.id), 'the published deck must appear in the marketplace');
  const installed = await req(`/api/marketplace/${pub.json.template.id}/install`, { method: 'POST', cookie: userCookie });
  assert.equal(installed.status, 201, JSON.stringify(installed.json));
  assert.equal(installed.json.installed.kind, 'deck');
});

// --- Magic Switch ---------------------------------------------------------------
test('magic switch reflows a design and translates it; bad inputs are refused', async () => {
  const targets = await req('/api/magic/switch/targets', { cookie: ownerCookie });
  assert.equal(targets.status, 200, JSON.stringify(targets.json));
  assert.ok(targets.json.targets.some((t) => t.id === 'instagram-story'), 'Instagram Story must be a switch target');
  assert.ok(targets.json.languages.some((l) => l.code === 'ur'), 'Urdu must be a translation language');
  assert.ok(targets.json.languages.some((l) => l.code === 'ur-roman'), 'Roman Urdu must be a translation language');

  const src = await createProject('Switch Me', 'design', testDesign());
  const switched = await req('/api/magic/switch', { method: 'POST', cookie: ownerCookie, body: { projectId: src.id, targetSizeId: 'instagram-story' } });
  assert.equal(switched.status, 201, JSON.stringify(switched.json));
  assert.equal(switched.json.project.type, 'design');
  assert.equal(switched.json.target.id, 'instagram-story');
  assert.equal(switched.json.target.width, 1080);
  assert.equal(switched.json.target.height, 1920);
  const switchedProject = await req(`/api/projects/${switched.json.project.id}`, { cookie: ownerCookie });
  assert.equal(switchedProject.json.project.content.width, 1080);
  assert.equal(switchedProject.json.project.content.height, 1920, 'the new design must be story-sized');
  assert.ok(switchedProject.json.project.name.includes('Story'), 'the new project name must name the target');
  const orig = await req(`/api/projects/${src.id}`, { cookie: ownerCookie });
  assert.equal(orig.json.project.content.width, 1080, 'the original must stay square');
  assert.equal(orig.json.project.content.height, 1080, 'the original must stay square');

  // Translate with the mock LLM: every text gets the TR- prefix.
  const translated = await req('/api/magic/switch', { method: 'POST', cookie: ownerCookie, body: { projectId: src.id, targetSizeId: 'instagram-post', translateTo: 'es' } });
  assert.equal(translated.status, 201, JSON.stringify(translated.json));
  assert.equal(translated.json.translated, true);
  const translatedProject = await req(`/api/projects/${translated.json.project.id}`, { cookie: ownerCookie });
  assert.equal(translatedProject.json.project.content.width, 1080);
  assert.equal(translatedProject.json.project.content.height, 1080);
  const texts = translatedProject.json.project.content.layers.filter((l) => l.type === 'text').map((l) => l.text.text);
  assert.ok(texts.length > 0 && texts.every((t) => t.startsWith('TR-')), `translated texts must carry the mock prefix: ${JSON.stringify(texts)}`);

  const badTarget = await req('/api/magic/switch', { method: 'POST', cookie: ownerCookie, body: { projectId: src.id, targetSizeId: 'not-a-size' } });
  assert.equal(badTarget.status, 400, JSON.stringify(badTarget.json));
  const neither = await req('/api/magic/switch', { method: 'POST', cookie: ownerCookie, body: { projectId: src.id } });
  assert.equal(neither.status, 400, JSON.stringify(neither.json));
  const badLang = await req('/api/magic/switch', { method: 'POST', cookie: ownerCookie, body: { projectId: src.id, translateTo: 'xx' } });
  assert.equal(badLang.status, 400, JSON.stringify(badLang.json));
  const anon = await req('/api/magic/switch', { method: 'POST', body: { projectId: src.id, targetSizeId: 'instagram-post' } });
  assert.equal(anon.status, 401, 'anonymous switch must be refused');
});

// --- AI Assistant ---------------------------------------------------------------
test('assistant actions: summarise, suggest, make-professional, five-versions', async () => {
  const actions = await req('/api/assistant/actions', { cookie: ownerCookie });
  assert.equal(actions.status, 200, JSON.stringify(actions.json));
  assert.deepEqual(actions.json.actions.map((a) => a.id), ['summarise', 'suggest', 'make-professional', 'five-versions']);
  assert.equal(actions.json.llm.configured, true, 'the mock LLM must be configured by now');

  const design = await createProject('Assist Me', 'design', testDesign());
  const sum = await req('/api/assistant/summarise', { method: 'POST', cookie: ownerCookie, body: { projectId: design.id } });
  assert.equal(sum.status, 200, JSON.stringify(sum.json));
  assert.ok(sum.json.summary && sum.json.summary.length > 10, JSON.stringify(sum.json));
  assert.ok(Array.isArray(sum.json.keyPoints) && sum.json.keyPoints.length > 0);

  const sug = await req('/api/assistant/suggest', { method: 'POST', cookie: ownerCookie, body: { projectId: design.id } });
  assert.equal(sug.status, 200, JSON.stringify(sug.json));
  assert.equal(sug.json.suggestions.length, 3, JSON.stringify(sug.json));
  assert.ok(sug.json.suggestions.every((s) => s.suggestion && s.priority), JSON.stringify(sug.json));

  const countBefore = (await req('/api/projects', { cookie: ownerCookie })).json.projects.length;
  const pro = await req('/api/assistant/make-professional', { method: 'POST', cookie: ownerCookie, body: { projectId: design.id } });
  assert.equal(pro.status, 200, JSON.stringify(pro.json));
  assert.equal(pro.json.newProject.type, 'design');
  assert.ok(pro.json.newProject.name.toLowerCase().includes('professional'), JSON.stringify(pro.json));
  const proDesign = await req(`/api/projects/${pro.json.newProject.id}`, { cookie: ownerCookie });
  const headlineLayer = proDesign.json.project.content.layers.find((l) => l.type === 'text' && l.text.text === 'A professional headline');
  assert.ok(headlineLayer, 'the professional version must carry the LLM headline');
  const orig = await req(`/api/projects/${design.id}`, { cookie: ownerCookie });
  assert.equal(orig.json.project.content.layers.find((l) => l.id === 'layer-t1').text.text, 'Hello Library', 'the original must be untouched');

  const five = await req('/api/assistant/five-versions', { method: 'POST', cookie: ownerCookie, body: { projectId: design.id } });
  assert.equal(five.status, 200, JSON.stringify(five.json));
  assert.equal(five.json.versions.length, 5, JSON.stringify(five.json));
  assert.ok(five.json.versions.every((v) => v.id && v.headline), JSON.stringify(five.json));
  const countAfter = (await req('/api/projects', { cookie: ownerCookie })).json.projects.length;
  assert.equal(countAfter, countBefore + 6, 'make-professional (1) + five-versions (5) must create exactly 6 new projects');

  // Wrong-type actions are refused.
  const video = await createProject('Assist Video', 'video', { version: 1, duration: 5, width: 1080, height: 1920, fps: 30, tracks: [{ id: 'tr1', kind: 'text', name: 'Text', locked: false, visible: true, clips: [{ id: 'cl1', type: 'text', text: 'Hi', fontFamily: 'Poppins', fontSize: 72, color: '#ffffff', start: 0, duration: 5 }] }] });
  const wrong = await req('/api/assistant/five-versions', { method: 'POST', cookie: ownerCookie, body: { projectId: video.id } });
  assert.equal(wrong.status, 400, JSON.stringify(wrong.json));
  const unknown = await req('/api/assistant/dance', { method: 'POST', cookie: ownerCookie, body: { projectId: design.id } });
  assert.equal(unknown.status, 400, JSON.stringify(unknown.json));
  const anon = await req('/api/assistant/actions');
  assert.equal(anon.status, 401, 'anonymous assistant listing must be refused');
});

test('assistant make-professional on a deck rewrites slide titles', async () => {
  const install = await req('/api/marketplace/builtin/builtin-deck-pitch/install', { method: 'POST', cookie: ownerCookie });
  const deckId = install.json.installed.id;
  const pro = await req('/api/assistant/make-professional', { method: 'POST', cookie: ownerCookie, body: { projectId: deckId } });
  assert.equal(pro.status, 200, JSON.stringify(pro.json));
  assert.equal(pro.json.newProject.type, 'deck');
  const newDeck = await req(`/api/projects/${pro.json.newProject.id}`, { cookie: ownerCookie });
  assert.equal(newDeck.json.project.content.slides.length, 5, 'the professional deck must keep all 5 slides');
  const titles = newDeck.json.project.content.slides.flatMap((s) => s.elements.filter((e) => e.type === 'text' && e.role === 'title').map((e) => e.text.text));
  assert.equal(titles.length, 5, `every slide must still have a title: ${JSON.stringify(titles)}`);
  // The pitch deck's 4th slide is a chart slide — the app keeps chart
  // slides unchanged, so exactly the other 4 titles are rewritten.
  assert.equal(titles.filter((t) => t.includes('professional')).length, 4, `4 titles must be rewritten: ${JSON.stringify(titles)}`);
  assert.ok(!titles[3].includes('professional'), 'the chart slide title must stay unchanged');
});

// --- Collaboration --------------------------------------------------------------
test('collaboration: link share, per-user share, comments — read-only only', async () => {
  const project = await createProject('Shared Design', 'design', testDesign());

  // Link share: anonymous access works, owner details are not leaked.
  const link = await req(`/api/collab/projects/${project.id}/link`, { method: 'POST', cookie: ownerCookie });
  assert.equal(link.status, 201, JSON.stringify(link.json));
  assert.ok(link.json.link.token && link.json.link.url, JSON.stringify(link.json));
  const again = await req(`/api/collab/projects/${project.id}/link`, { method: 'POST', cookie: ownerCookie });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.alreadyExists, true);
  assert.equal(again.json.link.token, link.json.link.token, 'the same link must be returned, not a new one');
  const shared = await req(`/api/collab/shared/${link.json.link.token}`);
  assert.equal(shared.status, 200, JSON.stringify(shared.json));
  assert.equal(shared.json.project.id, project.id);
  assert.ok(!JSON.stringify(shared.json).includes('lib@test.local'), 'the anonymous view must not leak the owner email');
  const reveal = await req(`/api/collab/projects/${project.id}/link/reveal`, { method: 'POST', cookie: ownerCookie });
  assert.equal(reveal.status, 200, JSON.stringify(reveal.json));
  assert.equal(reveal.json.link.token, link.json.link.token);
  const revealUser = await req(`/api/collab/projects/${project.id}/link/reveal`, { method: 'POST', cookie: userCookie });
  assert.equal(revealUser.status, 404, 'a non-owner must not reveal the link');

  // Per-user share.
  const share = await req(`/api/collab/projects/${project.id}/share`, { method: 'POST', cookie: ownerCookie, body: { email: 'second-lib@test.local' } });
  assert.equal(share.status, 201, JSON.stringify(share.json));
  const shareAgain = await req(`/api/collab/projects/${project.id}/share`, { method: 'POST', cookie: ownerCookie, body: { email: 'second-lib@test.local' } });
  assert.equal(shareAgain.status, 200, JSON.stringify(shareAgain.json));
  assert.equal(shareAgain.json.alreadyShared, true, 're-sharing the same user must not duplicate the share');
  const shareSelf = await req(`/api/collab/projects/${project.id}/share`, { method: 'POST', cookie: ownerCookie, body: { email: 'lib@test.local' } });
  assert.equal(shareSelf.status, 400, JSON.stringify(shareSelf.json));
  const shareGhost = await req(`/api/collab/projects/${project.id}/share`, { method: 'POST', cookie: ownerCookie, body: { email: 'nobody@test.local' } });
  assert.equal(shareGhost.status, 404, JSON.stringify(shareGhost.json));
  const shareByUser = await req(`/api/collab/projects/${project.id}/share`, { method: 'POST', cookie: userCookie, body: { email: 'third-lib@test.local' } });
  assert.equal(shareByUser.status, 404, 'a non-owner must not be able to share the project');

  // Shared-with-me for the second user; read-only means no edits.
  const mine = await req('/api/collab/shared-with-me', { cookie: userCookie });
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  assert.ok(mine.json.projects.some((p) => p.id === project.id), JSON.stringify(mine.json));
  const view = await req(`/api/collab/shared-with-me/${project.id}`, { cookie: userCookie });
  assert.equal(view.status, 200, JSON.stringify(view.json));
  assert.equal(view.json.shared, true);
  const editTry = await req(`/api/projects/${project.id}`, { method: 'PATCH', cookie: userCookie, body: { name: 'Hijacked' } });
  assert.ok([403, 404].includes(editTry.status), `a shared (read-only) user must not edit: ${editTry.status}`);

  // Comments: add, reply, resolve, delete — with permission checks.
  const c1 = await req(`/api/collab/projects/${project.id}/comments`, { method: 'POST', cookie: userCookie, body: { body: 'The headline feels small.' } });
  assert.equal(c1.status, 201, JSON.stringify(c1.json));
  const reply = await req(`/api/collab/projects/${project.id}/comments`, { method: 'POST', cookie: ownerCookie, body: { body: 'Agreed — will bump it.', parentId: c1.json.comment.id } });
  assert.equal(reply.status, 201, JSON.stringify(reply.json));
  const nested = await req(`/api/collab/projects/${project.id}/comments`, { method: 'POST', cookie: ownerCookie, body: { body: 'Too deep.', parentId: reply.json.comment.id } });
  assert.equal(nested.status, 400, 'replies are one level only');
  const list = await req(`/api/collab/projects/${project.id}/comments`, { cookie: ownerCookie });
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.equal(list.json.comments.length, 1);
  assert.equal(list.json.comments[0].replies.length, 1);
  const resolve = await req(`/api/collab/projects/${project.id}/comments/${c1.json.comment.id}/resolve`, { method: 'POST', cookie: userCookie, body: {} });
  assert.equal(resolve.status, 200, JSON.stringify(resolve.json));
  assert.equal(resolve.json.comment.status, 'resolved');
  const resolveStranger = await req(`/api/collab/projects/${project.id}/comments/${c1.json.comment.id}/resolve`, { method: 'POST', cookie: thirdCookie, body: {} });
  assert.ok([403, 404].includes(resolveStranger.status), `a user with no access must not resolve: ${resolveStranger.status}`);
  const delStranger = await req(`/api/collab/projects/${project.id}/comments/${c1.json.comment.id}`, { method: 'DELETE', cookie: thirdCookie });
  assert.ok([403, 404].includes(delStranger.status), `a user with no access must not delete: ${delStranger.status}`);
  const delAuthor = await req(`/api/collab/projects/${project.id}/comments/${c1.json.comment.id}`, { method: 'DELETE', cookie: userCookie });
  assert.equal(delAuthor.status, 200, JSON.stringify(delAuthor.json));
  const listAfter = await req(`/api/collab/projects/${project.id}/comments`, { cookie: ownerCookie });
  assert.equal(listAfter.json.comments.length, 0, 'deleting the thread must remove its replies too');

  // Leave + revoke.
  const leave = await req(`/api/collab/shared-with-me/${project.id}/leave`, { method: 'POST', cookie: userCookie });
  assert.equal(leave.status, 200, JSON.stringify(leave.json));
  const mineAfter = await req('/api/collab/shared-with-me', { cookie: userCookie });
  assert.ok(!mineAfter.json.projects.some((p) => p.id === project.id), 'after leaving, the project must disappear from shared-with-me');
  const revoked = await req(`/api/collab/projects/${project.id}/link`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  const dead = await req(`/api/collab/shared/${link.json.link.token}`);
  assert.equal(dead.status, 404, 'a revoked link must stop working');
  const anonComments = await req(`/api/collab/projects/${project.id}/comments`);
  assert.equal(anonComments.status, 401, 'anonymous comment reading must be refused');
});

// --- Updater node_modules overlay ------------------------------------------------
const updater = require('../src/updater');
const publishUpdate = require('../scripts/publish-update');

function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function writeFile(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }

function fakeAppDir(root, version) {
  writeJson(path.join(root, 'package.json'), { name: 'fake-app', version, dependencies: { 'old-dep': '^1.0.0' } });
  writeFile(path.join(root, 'server.js'), `// fake server v${version}\n`);
  writeFile(path.join(root, 'src', 'foo.js'), `module.exports = 'foo-${version}';\n`);
  writeJson(path.join(root, 'node_modules', 'old-dep', 'package.json'), { name: 'old-dep', version: '1.0.0' });
  writeFile(path.join(root, 'node_modules', 'old-dep', 'index.js'), "module.exports = 'old';\n");
  return root;
}
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function makeFolderFeed(feedDir, appDir, version, extra) {
  // The bundle describes the NEW app: a new package.json + src/foo.js,
  // plus an optional nodeModules overlay from `extra`.
  const newPkg = { name: 'fake-app', version, dependencies: { 'old-dep': '^1.0.0', 'new-dep': '^1.0.0' } };
  const newPkgText = JSON.stringify(newPkg, null, 2);
  const newFooText = `module.exports = 'foo-${version}';\n`;
  const bundle = {
    version,
    files: {
      'package.json': { sha256: crypto.createHash('sha256').update(newPkgText).digest('hex'), size: Buffer.byteLength(newPkgText), content_b64: b64(newPkgText) },
      'src/foo.js': { sha256: crypto.createHash('sha256').update(newFooText).digest('hex'), size: Buffer.byteLength(newFooText), content_b64: b64(newFooText) },
    },
    ...(extra || {}),
  };
  const bundlePath = path.join(feedDir, 'update-2.2.4.json');
  writeJson(bundlePath, bundle);
  writeJson(path.join(feedDir, 'version.json'), {
    app: 'fake-app', version, package: 'update-2.2.4.json',
    packageSha256: sha256(bundlePath), publishedAt: new Date().toISOString(),
    depsChanged: (extra && extra.depsChanged) || [], hasNodeModules: Boolean(extra && extra.nodeModules),
    hasNativeModules: Boolean(extra && extra.hasNativeModules),
  });
  return feedDir;
}

test('updater overlay: add a new dep in-app, verify, apply, roll back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-updater-'));
  const appDir = fakeAppDir(path.join(root, 'app'), '2.2.3');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const feedDir = path.join(root, 'feed');
  fs.mkdirSync(feedDir, { recursive: true });
  // A fake new dependency (pure JS, no native code).
  const depDir = path.join(root, 'dep', 'new-dep');
  writeJson(path.join(depDir, 'package.json'), { name: 'new-dep', version: '1.0.0', main: 'index.js' });
  writeFile(path.join(depDir, 'index.js'), "module.exports = 'new';\n");
  const overlay = {
    'node_modules/new-dep/package.json': { sha256: sha256(path.join(depDir, 'package.json')), size: fs.statSync(path.join(depDir, 'package.json')).size, content_b64: b64(fs.readFileSync(path.join(depDir, 'package.json'), 'utf8')) },
    'node_modules/new-dep/index.js': { sha256: sha256(path.join(depDir, 'index.js')), size: fs.statSync(path.join(depDir, 'index.js')).size, content_b64: b64(fs.readFileSync(path.join(depDir, 'index.js'), 'utf8')) },
  };
  makeFolderFeed(feedDir, appDir, '2.2.4', { nodeModules: overlay, depsChanged: ['new-dep'], hasNativeModules: false });

  const u = updater.createUpdater(appDir, dataDir);
  const feed = { type: 'folder', value: feedDir };
  const avail = await u.check(feed);
  assert.equal(avail.available, true, JSON.stringify(avail));
  assert.equal(avail.latest, '2.2.4');
  assert.equal(avail.fullReinstall, false, 'a pure-JS dep change must NOT need fullReinstall');
  assert.deepEqual(avail.manifest.depsChanged, ['new-dep']);
  assert.equal(avail.manifest.hasNodeModules, true);

  const staged = await u.downloadAndStage(feed, avail.manifest);
  assert.equal(staged.nodeModules.length, 2, 'both overlay files must be staged');
  const applied = u.applyStaged();
  assert.equal(applied.to, '2.2.4');
  assert.equal(applied.nodeModulesApplied, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version, '2.2.4', 'package.json must be bumped');
  assert.equal(fs.readFileSync(path.join(appDir, 'node_modules', 'new-dep', 'index.js'), 'utf8'), "module.exports = 'new';\n", 'the new dep must land in node_modules');
  assert.equal(fs.readFileSync(path.join(appDir, 'src', 'foo.js'), 'utf8'), "module.exports = 'foo-2.2.4';\n", 'the app file must be updated too');
  assert.ok(fs.existsSync(path.join(appDir, 'node_modules', 'old-dep', 'index.js')), 'the old dep must survive');
  const backupDirs = fs.readdirSync(path.join(dataDir, 'updates')).filter((d) => d.startsWith('backup-2.2.3-'));
  assert.equal(backupDirs.length, 1, `exactly one backup dir: ${JSON.stringify(backupDirs)}`);
  const backupDir = path.join(dataDir, 'updates', backupDirs[0]);
  assert.ok(fs.existsSync(path.join(backupDir, 'BACKUP-META.json')), 'the backup meta must exist');
  const meta = JSON.parse(fs.readFileSync(path.join(backupDir, 'BACKUP-META.json'), 'utf8'));
  assert.deepEqual([...meta.addedNodeModules].sort(), ['node_modules/new-dep/index.js', 'node_modules/new-dep/package.json'].sort(), 'added overlay files must be recorded in the backup meta');
  assert.ok(fs.existsSync(path.join(backupDir, 'ADDED-FILES.txt')), 'ADDED-FILES.txt must exist for the Windows batch');

  const rolled = u.rollback();
  assert.equal(rolled.restored, '2.2.3');
  assert.equal(JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version, '2.2.3', 'rollback must restore package.json');
  assert.equal(fs.readFileSync(path.join(appDir, 'src', 'foo.js'), 'utf8'), "module.exports = 'foo-2.2.3';\n", 'rollback must restore app files');
  assert.ok(!fs.existsSync(path.join(appDir, 'node_modules', 'new-dep', 'index.js')), 'rollback must remove the added dep');
  fs.rmSync(root, { recursive: true, force: true });
});

test('updater overlay: tampered hash, traversal and native files are refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-updater-bad-'));
  const appDir = fakeAppDir(path.join(root, 'app'), '2.2.3');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const feedDir = path.join(root, 'feed');
  fs.mkdirSync(feedDir, { recursive: true });
  const good = { sha256: crypto.createHash('sha256').update('test').digest('hex'), size: 4, content_b64: b64('test') };

  // Tampered hash.
  const badHash = { ...good, content_b64: b64('evil') };
  makeFolderFeed(feedDir, appDir, '2.2.4', { nodeModules: { 'node_modules/new-dep/index.js': badHash }, depsChanged: ['new-dep'] });
  const u = updater.createUpdater(appDir, dataDir);
  const feed = { type: 'folder', value: feedDir };
  const avail = await u.check(feed);
  await assert.rejects(() => u.downloadAndStage(feed, avail.manifest), /hash mismatch/i, 'a tampered overlay file must be refused');

  // Path traversal.
  makeFolderFeed(feedDir, appDir, '2.2.4', { nodeModules: { 'node_modules/../evil.js': good }, depsChanged: ['new-dep'] });
  const avail2 = await u.check(feed);
  await assert.rejects(() => u.downloadAndStage(feed, avail2.manifest), /not allowed|traversal|outside node_modules/i, 'an overlay path escaping node_modules must be refused');

  // Native module (.node) is refused — must fall back to fullReinstall.
  const native = { ...good };
  makeFolderFeed(feedDir, appDir, '2.2.4', { nodeModules: { 'node_modules/new-dep/native.node': native }, depsChanged: ['new-dep'], hasNativeModules: true });
  const avail3 = await u.check(feed);
  assert.equal(avail3.fullReinstall, true, 'a native module in the bundle must force fullReinstall');
  await assert.rejects(() => u.downloadAndStage(feed, avail3.manifest), /native/i, 'a .node overlay file must be refused');
  fs.rmSync(root, { recursive: true, force: true });
});

test('updater overlay: publish-time dep diff collects a new dep and flags native ones', () => {
  // previousReleaseDeps reads the real previous bundle (updates/update-2.2.3.json).
  const prev = publishUpdate.previousReleaseDeps('2.2.4');
  assert.ok(prev, 'a previous release bundle must exist');
  assert.equal(prev.version, '2.2.3', JSON.stringify(prev));
  assert.ok(prev.deps && typeof prev.deps === 'object', 'previous deps must be the dependency map');
  assert.ok('express' in prev.deps, 'express must be a dependency of the previous release');

  // multer is pure JS with transitive deps (append-field, busboy, ...).
  const overlay = publishUpdate.computeDepsOverlay(['multer']);
  assert.equal(overlay.hasNativeModules, false);
  assert.ok(overlay.depsChanged.includes('multer'), 'multer must be in the dep diff');
  assert.ok(overlay.depsChanged.includes('busboy'), 'transitive deps must be in the dep diff');
  assert.ok(overlay.overlay['node_modules/multer/index.js'], 'the dep files must be in the overlay');
  assert.ok(Object.keys(overlay.overlay).some((p) => p.startsWith('node_modules/busboy/')), 'transitive dep files must be in the overlay');
  assert.ok(Object.values(overlay.overlay).every((e) => e.sha256 && e.content_b64), 'every overlay entry needs a hash + content');

  // better-sqlite3 carries a compiled .node binary: flagged, never
  // silently treated as an in-app overlay candidate.
  const withNative = publishUpdate.computeDepsOverlay(['better-sqlite3']);
  assert.equal(withNative.hasNativeModules, true, 'a .node file must flag hasNativeModules');
  assert.ok(Object.keys(withNative.overlay).some((p) => p.endsWith('.node')), 'the native file is present in the collected overlay (the publish flow refuses it unless --full-reinstall)');
});

test('updater overlay: only node_modules paths are allowed', () => {
  assert.equal(updater.ALLOWED_OVERLAY('node_modules/foo/index.js'), true);
  assert.equal(updater.ALLOWED_OVERLAY('node_modules/foo/package.json'), true);
  assert.equal(updater.ALLOWED_OVERLAY('src/foo.js'), false, 'app files are not overlay paths');
  assert.equal(updater.ALLOWED_OVERLAY('node_modules/../evil.js'), false, 'traversal is not allowed');
  assert.equal(updater.ALLOWED_OVERLAY('/abs/node_modules/x.js'), false, 'absolute paths are not allowed');
  assert.equal(updater.ALLOWED_OVERLAY('node_modules\\foo\\index.js'), false, 'backslashes are not allowed');
  assert.equal(updater.ALLOWED_OVERLAY('node_modules/'), false, 'a bare directory is not allowed');
});
