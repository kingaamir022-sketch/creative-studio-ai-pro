'use strict';
// AI Creative Studio tests (Phase 7) — run with: npm test
// Spawns the real server on a scratch port (4838) with a temp DB/uploads
// dir, PLUS a local MOCK provider HTTP server (random port) that speaks
// the real provider APIs (OpenAI Images/Chat/Whisper/TTS, Runway tasks,
// Replicate predictions, Stability balance, ElevenLabs user). No real key
// and no real network call to a provider ever happens: every AI call in
// this file goes to the mock. Covers: no-key refusal for every mode (no
// output created), text-to-image + image-to-image saving real PNGs to the
// Media Library, text-to-video + image-to-video producing real MP4s,
// TTS audio landing in a narration render (ffprobe-valid), STT transcript
// becoming captions (AI Studio + Shorts route), LLM quiz questions
// validating, AI Design Assist creating a real editable project, music
// mood tags, music generation, bulk AI backgrounds via the assign API,
// job cancel + retry, per-user isolation, anonymous 401, provider
// config + test-connection against the mock.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-ai-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4838;
const BASE = `http://127.0.0.1:${PORT}`;

const PNG_1X1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server;
let mockServer;
let mockPort;
let ownerCookie = '';
let userCookie = '';
let testWav;
let testMp4;
let testImage;

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

function makeTestAudio(file, seconds, freq = 880) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
    '-c:a', 'pcm_s16le', file], { timeout: 30000 });
}
function makeTestVideo(file, seconds = 2) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { timeout: 60000 });
}
function makeTestImage(file, color) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:d=1`, '-frames:v', '1', file], { timeout: 30000 });
}

async function uploadMedia(file, name, mime, cookie) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime }), name);
  const r = await req('/api/media/upload', { method: 'POST', cookie: cookie || ownerCookie, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.media;
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

async function countMedia(cookie) {
  const r = await req('/api/media?limit=100', { cookie: cookie || ownerCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return (r.json.media || []).length;
}

// There is no GET /api/media/:id route — look a row up in the list.
async function getMediaById(mediaId, cookie) {
  const r = await req('/api/media?limit=100', { cookie: cookie || ownerCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return (r.json.media || []).find((m) => m.id === mediaId) || null;
}

// --- Local mock provider ----------------------------------------------------
// Speaks the REAL provider shapes (OpenAI Images/Chat/Whisper/TTS,
// Runway task polling, Replicate prediction polling, Stability balance,
// ElevenLabs user). State is per-process so tests can drive failures.
const mockState = { failOnceDone: false, taskPolls: {}, predPolls: {} };

function mockHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const sendBytes = (code, buf, type) => { res.writeHead(code, { 'Content-Type': type }); res.end(buf); };
  let body = Buffer.alloc(0);
  req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body.toString('utf8')); } catch { json = null; }
    const userText = json && json.messages ? json.messages.map((m) => m.content || '').join('\n') : '';

    if (req.method === 'GET' && p === '/models') return sendJson(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'dall-e-3' }, { id: 'whisper-1' }, { id: 'tts-1' }] });
    if (req.method === 'GET' && p === '/v1/models') return sendJson(200, { data: [{ id: 'gpt-4o-mini' }] });
    if (req.method === 'GET' && p === '/v1/user/balance') return sendJson(200, { credits: 42 });
    if (req.method === 'GET' && p === '/v1/user') return sendJson(200, { subscription: { type: 'free', character_count: 1000, character_limit: 10000 } });
    if (req.method === 'GET' && p === '/tasks') return sendJson(200, { tasks: [] });
    if (req.method === 'GET' && p === '/predictions') return sendJson(200, { results: [] });
    if (req.method === 'GET' && p === '/files/out.mp4') return sendBytes(200, fs.readFileSync(testMp4), 'video/mp4');
    if (req.method === 'GET' && p === '/files/out.wav') return sendBytes(200, fs.readFileSync(testWav), 'audio/wav');

    if (req.method === 'POST' && p === '/images/generations') {
      const prompt = String((json && json.prompt) || '');
      if (prompt.includes('SLOW_IMAGE')) {
        // Cancel test: delay so the job is still running when we cancel.
        return setTimeout(() => sendJson(200, { created: 1, data: [{ b64_json: PNG_1X1_B64 }] }), 5000);
      }
      if (prompt.includes('FAIL_ONCE') && !mockState.failOnceDone) {
        mockState.failOnceDone = true;
        return sendJson(500, { error: { message: 'mock failure once' } });
      }
      return sendJson(200, { created: 1, data: [{ b64_json: PNG_1X1_B64, revised_prompt: prompt }] });
    }
    if (req.method === 'POST' && p === '/images/edits') {
      return sendJson(200, { created: 1, data: [{ b64_json: PNG_1X1_B64 }] });
    }
    if (req.method === 'POST' && p === '/chat/completions') {
      if (userText.includes('Generate quiz questions')) {
        return sendJson(200, { choices: [{ message: { content: JSON.stringify({ questions: [
          { question: 'What is the capital of Pakistan?', options: ['Lahore', 'Islamabad', 'Karachi', 'Quetta'], correct: 'B', explanation: 'Islamabad is the capital.' },
          { question: 'How many days are in a leap year?', options: ['364', '365', '366', '367'], correct: 'C', explanation: 'A leap year has 366 days.' },
          { question: 'What is 2 + 2?', options: ['3', '4', '5', '6'], correct: 'B', explanation: '2 + 2 = 4.' },
          { question: 'Which planet is known as the Red Planet?', options: ['Venus', 'Jupiter', 'Mars', 'Saturn'], correct: 'C', explanation: 'Mars looks red from iron oxide.' },
          { question: 'What is H2O?', options: ['Salt', 'Water', 'Oxygen', 'Hydrogen'], correct: 'B', explanation: 'H2O is water.' },
        ] }) } }] });
      }
      if (userText.includes('Design assist')) {
        return sendJson(200, { choices: [{ message: { content: JSON.stringify({
          headline: 'Summer Sale', subheading: 'Big discounts on all shoes this week',
          palette: { primary: '#7c5cff', secondary: '#22d3ee', accent: '#3b82f6' },
          fonts: { heading: 'Poppins', body: 'Inter' }, cta: 'SHOP NOW',
        }) } }] });
      }
      if (userText.includes('Music mood')) {
        return sendJson(200, { choices: [{ message: { content: JSON.stringify({
          mood: 'Energetic', energy: 8, tempoFeel: 'fast', genres: ['pop', 'dance'], tags: ['upbeat', 'party', 'workout'],
        }) } }] });
      }
      return sendJson(200, { choices: [{ message: { content: '{"ok":true}' } }] });
    }
    if (req.method === 'POST' && p === '/audio/transcriptions') {
      return sendJson(200, {
        text: 'Hello world this is a test',
        duration: 2,
        words: [
          { word: 'Hello', start: 0, end: 0.4 }, { word: 'world', start: 0.4, end: 0.8 },
          { word: 'this', start: 0.8, end: 1.1 }, { word: 'is', start: 1.1, end: 1.3 },
          { word: 'a', start: 1.3, end: 1.4 }, { word: 'test', start: 1.4, end: 1.8 },
        ],
      });
    }
    if (req.method === 'POST' && p === '/audio/speech') {
      return sendBytes(200, fs.readFileSync(testWav), 'audio/wav');
    }
    if (req.method === 'POST' && p === '/text_to_video') {
      return sendJson(200, { id: 'task_1', status: 'RUNNING' });
    }
    if (req.method === 'POST' && p === '/image_to_video') {
      return sendJson(200, { id: 'task_2', status: 'RUNNING' });
    }
    if (req.method === 'GET' && p.startsWith('/tasks/')) {
      const id = p.split('/')[2];
      mockState.taskPolls[id] = (mockState.taskPolls[id] || 0) + 1;
      if (mockState.taskPolls[id] < 2) return sendJson(200, { id, status: 'RUNNING' });
      return sendJson(200, { id, status: 'SUCCEEDED', output: [`http://127.0.0.1:${mockPort}/files/out.mp4`] });
    }
    if (req.method === 'POST' && p === '/models/meta/musicgen/predictions') {
      return sendJson(201, { id: 'pred_1', status: 'starting', urls: { get: `http://127.0.0.1:${mockPort}/predictions/pred_1` } });
    }
    if (req.method === 'GET' && p === '/predictions/pred_1') {
      mockState.predPolls.pred_1 = (mockState.predPolls.pred_1 || 0) + 1;
      if (mockState.predPolls.pred_1 < 2) return sendJson(200, { id: 'pred_1', status: 'processing' });
      return sendJson(200, { id: 'pred_1', status: 'succeeded', output: `http://127.0.0.1:${mockPort}/files/out.wav` });
    }
    return sendJson(404, { error: `mock: no route ${req.method} ${p}` });
  });
}

let srcImage;
let srcAudio;
let srcVideo;
let aiVoiceProfile;

before(async () => {
  testWav = path.join(tmp, 'test.wav');
  testMp4 = path.join(tmp, 'test.mp4');
  testImage = path.join(tmp, 'test.png');
  makeTestAudio(testWav, 2);
  makeTestVideo(testMp4, 2);
  makeTestImage(testImage, 'red');

  // Mock provider server on a random port.
  mockServer = http.createServer(mockHandler);
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;

  // Real app server on 4838 with a temp DB.
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

  // Owner signup (first account = OWNER).
  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'AI Tester', email: 'ai@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  ownerCookie = s.setCookie.split(';')[0];

  // Second user for isolation checks.
  const u = await req('/api/auth/signup', { method: 'POST', body: { name: 'Second User', email: 'second@test.local', password: 'password123' } });
  assert.equal(u.status, 201, JSON.stringify(u.json));
  userCookie = u.setCookie.split(';')[0];

  // Source media used across tests (uploaded while no keys exist — uploads
  // are not AI, so they work).
  srcImage = await uploadMedia(testImage, 'src.png', 'image/png');
  srcAudio = await uploadMedia(testWav, 'src.wav', 'audio/wav');
  srcVideo = await uploadMedia(testMp4, 'src.mp4', 'video/mp4');
  // A generic AI voice profile (kind 'ai', voice 'alloy') for voice tests.
  const vp = await req('/api/voice/profiles', { method: 'POST', cookie: ownerCookie, body: { name: 'Alloy', kind: 'ai', aiVoice: 'alloy' } });
  assert.equal(vp.status, 201, JSON.stringify(vp.json));
  aiVoiceProfile = vp.json.profile;
});

after(async () => {
  if (server) server.kill('SIGKILL');
  if (mockServer) await new Promise((r) => mockServer.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function configureMockProviders() {
  const mockBase = `http://127.0.0.1:${mockPort}`;
  // Every provider points at the local mock; keys are dummy (the mock
  // accepts anything — the point is the wiring, not the provider's auth).
  for (const id of ['llm', 'image', 'video', 'stt', 'tts', 'music', 'stability']) {
    const cfg = await req(`/api/providers/${id}/config`, { method: 'POST', cookie: ownerCookie, body: { baseUrl: mockBase } });
    assert.equal(cfg.status, 200, `config ${id}: ${JSON.stringify(cfg.json)}`);
    const key = await req(`/api/providers/${id}/key`, { method: 'POST', cookie: ownerCookie, body: { key: 'mock-test-key-12345' } });
    assert.equal(key.status, 200, `key ${id}: ${JSON.stringify(key.json)}`);
  }
  // ElevenLabs base URL is https://api.elevenlabs.io/v1 by default, so its
  // test path is /user under the configured base — point it at /v1.
  const vc = await req('/api/providers/voice_clone/config', { method: 'POST', cookie: ownerCookie, body: { baseUrl: `${mockBase}/v1` } });
  assert.equal(vc.status, 200, JSON.stringify(vc.json));
  const vck = await req('/api/providers/voice_clone/key', { method: 'POST', cookie: ownerCookie, body: { key: 'mock-test-key-12345' } });
  assert.equal(vck.status, 200, JSON.stringify(vck.json));
}

async function downloadMediaFile(mediaId, cookie) {
  const r = await fetch(`${BASE}/api/media/${mediaId}/file`, { headers: { cookie: cookie || ownerCookie }, redirect: 'manual' });
  assert.equal(r.status, 200, `download media ${mediaId}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// --- No-key path: every mode refuses honestly, no output is created. --------
test('no key: every AI mode refuses with key_needed and creates no output', async () => {
  const beforeCount = await countMedia();
  const st = await req('/api/ai/status', { cookie: ownerCookie });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  for (const kind of ['image', 'video', 'llm', 'tts', 'stt', 'music']) {
    assert.equal(st.json.kinds[kind].configured, false, `${kind} must start unconfigured`);
  }
  const cases = [
    ['image', { prompt: 'A red balloon' }],
    ['image-edit', { prompt: 'Make it blue', sourceMediaId: srcImage.id }],
    ['video', { prompt: 'A flying balloon', duration: 5, aspect: '16:9' }],
    ['video-image', { prompt: 'The balloon floats', sourceMediaId: srcImage.id, duration: 5, aspect: '16:9' }],
    ['voice', { text: 'Hello world', voiceProfileId: aiVoiceProfile.id }],
    ['quiz', { topic: 'Space', count: 3 }],
    ['design', { prompt: 'A poster for a cafe', name: 'Cafe Poster' }],
    ['transcribe', { mediaId: srcVideo.id }],
    ['music-mood', { mediaId: srcAudio.id }],
    ['music-generate', { prompt: 'A calm piano piece', duration: 5 }],
  ];
  for (const [mode, params] of cases) {
    const job = await runAiJob(mode, params);
    assert.equal(job.status, 'failed', `${mode} must fail without a key: ${JSON.stringify(job)}`);
    assert.match(job.error, /no API key|key needed|not configured/i, `${mode} error must name the missing key: ${job.error}`);
    assert.equal(job.outputMediaId, null, `${mode} must not create output`);
    assert.equal(job.result, null, `${mode} must not create a result`);
  }
  assert.equal(await countMedia(), beforeCount, 'no media may be created by refused AI jobs');
});

test('provider config + test connection against the mock (real calls, real answers)', async () => {
  await configureMockProviders();
  const st = await req('/api/ai/status', { cookie: ownerCookie });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  for (const kind of ['image', 'video', 'llm', 'tts', 'stt', 'music']) {
    assert.equal(st.json.kinds[kind].configured, true, `${kind} must be configured after setting a key`);
  }
  // Test connection: minimal real calls to the mock, reported honestly.
  for (const id of ['llm', 'image', 'stability', 'video', 'stt', 'tts', 'music', 'voice_clone']) {
    const t = await req(`/api/providers/${id}/test`, { method: 'POST', cookie: ownerCookie });
    assert.equal(t.status, 200, `test ${id}: ${JSON.stringify(t.json)}`);
    assert.equal(t.json.ok, true, `test ${id} must pass against the mock: ${JSON.stringify(t.json)}`);
  }
  // Active provider per kind can be switched (image has two providers now).
  const act = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'image', provider: 'stability' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  const back = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'image', provider: 'image' } });
  assert.equal(back.status, 200, JSON.stringify(back.json));
});

test('text-to-image saves a real PNG to the Media Library', async () => {
  const job = await runAiJob('image', { prompt: 'A red balloon over a green field', size: '1:1' });
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.ok(job.outputMediaId, 'image job must have output media');
  const bytes = await downloadMediaFile(job.outputMediaId);
  assert.ok(bytes.length > 10, 'image file must be non-empty');
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'output must be a real PNG (magic bytes)');
  const lib = await getMediaById(job.outputMediaId);
  assert.ok(lib, 'generated image must be in the Media Library');
  assert.ok((lib.tags || '').includes('ai-generated'), 'generated image must be tagged ai-generated');
});

test('image-to-image edits a source image into a real PNG', async () => {
  const job = await runAiJob('image-edit', { prompt: 'Make the sky purple', sourceMediaId: srcImage.id, size: '1:1' });
  assert.equal(job.status, 'done', JSON.stringify(job));
  const bytes = await downloadMediaFile(job.outputMediaId);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'edited output must be a real PNG');
});

test('text-to-video produces a real MP4; image-to-video too', async () => {
  const job = await runAiJob('video', { prompt: 'A drone shot over a lake', duration: 5, aspect: '16:9' });
  assert.equal(job.status, 'done', JSON.stringify(job));
  const bytes = await downloadMediaFile(job.outputMediaId);
  assert.ok(bytes.includes(Buffer.from('ftyp')), 'video output must be a real MP4 (ftyp box)');
  const tmpFile = path.join(tmp, `ai-video-${job.outputMediaId}.mp4`);
  fs.writeFileSync(tmpFile, bytes);
  const probe = await ffprobe(tmpFile);
  assert.ok((probe.streams || []).some((s) => s.codec_type === 'video'), 'video output must have a video stream');

  const job2 = await runAiJob('video-image', { prompt: 'The camera slowly zooms in', sourceMediaId: srcImage.id, duration: 5, aspect: '16:9' });
  assert.equal(job2.status, 'done', JSON.stringify(job2));
  const bytes2 = await downloadMediaFile(job2.outputMediaId);
  assert.ok(bytes2.includes(Buffer.from('ftyp')), 'image-to-video output must be a real MP4');
});

test('AI voice returns real audio that lands in a narration render (ffprobe-valid)', async () => {
  const job = await runAiJob('voice', { text: 'Hello world, welcome to the quiz', voiceProfileId: aiVoiceProfile.id });
  assert.equal(job.status, 'done', JSON.stringify(job));
  const bytes = await downloadMediaFile(job.outputMediaId);
  assert.ok(bytes.length > 100, 'voice audio must be non-empty');
  const tmpFile = path.join(tmp, `ai-voice-${job.outputMediaId}.wav`);
  fs.writeFileSync(tmpFile, bytes);
  const probe = await ffprobe(tmpFile);
  assert.ok((probe.streams || []).some((s) => s.codec_type === 'audio'), 'voice output must have an audio stream');
});

test('AI quiz questions validate (4 options, A-D answer) and export as CSV', async () => {
  const job = await runAiJob('quiz', { topic: 'General knowledge', count: 5, difficulty: 'mixed' });
  assert.equal(job.status, 'done', JSON.stringify(job));
  const qs = job.result.questions;
  assert.equal(qs.length, 5, 'exactly 5 questions');
  for (const q of qs) {
    assert.ok(q.question && q.question.length > 0, 'question text required');
    assert.equal(q.options.length, 4, 'exactly 4 options');
    assert.ok(q.options.every((o) => o && o.length > 0), 'every option non-empty');
    assert.ok(['A', 'B', 'C', 'D'].includes(q.correct), 'correct must be A-D');
  }
  const lines = job.result.csv.split('\n');
  assert.equal(lines[0], 'QUESTION,OPTION_A,OPTION_B,OPTION_C,OPTION_D,CORRECT,EXPLANATION,CATEGORY,DIFFICULTY,TIMER_SECONDS');
  assert.equal(lines.length, 6, 'CSV must have header + 5 question rows');
});

test('AI Design Assist creates a real editable design project (original untouched)', async () => {
  const job = await runAiJob('design', { prompt: 'Summer sale poster for a shoe store', name: 'Summer Sale' });
  assert.equal(job.status, 'done', JSON.stringify(job));
  const pid = job.result.projectId;
  assert.ok(pid, 'design job must return a project id');
  const pr = await req(`/api/projects/${pid}`, { cookie: ownerCookie });
  assert.equal(pr.status, 200, JSON.stringify(pr.json));
  const content = pr.json.project.content || {};
  assert.ok(Array.isArray(content.layers) && content.layers.length >= 4, 'AI design must have real layers');
  const texts = content.layers.filter((l) => l.type === 'text').map((l) => l.text && l.text.text);
  assert.ok(texts.includes('Summer Sale'), 'AI headline must be in the design layers');
});

test('AI transcribe returns word-timed cues; Shorts route saves them as captions', async () => {
  const job = await runAiJob('transcribe', { mediaId: srcVideo.id });
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.ok(job.result.text.includes('Hello world'), 'transcript text must come from the provider');
  assert.ok(job.result.cues.length >= 1, 'transcript must have cues');
  assert.ok(job.result.cues.every((c) => c.end > c.start && c.text), 'every cue must have a valid span and text');

  // Shorts route with a key: real STT, transcript saved on the job.
  const sj = await req('/api/shorts/jobs', { method: 'POST', cookie: ownerCookie, body: { mediaId: srcVideo.id, name: 'AI STT Shorts' } });
  assert.equal(sj.status, 201, JSON.stringify(sj.json));
  const tr = await req(`/api/shorts/jobs/${sj.json.job.id}/transcribe`, { method: 'POST', cookie: ownerCookie, body: {} });
  assert.equal(tr.status, 200, JSON.stringify(tr.json));
  assert.ok(tr.json.cues >= 1, 'shorts transcribe must return cue count');
  const after = await req(`/api/shorts/jobs/${sj.json.job.id}`, { cookie: ownerCookie });
  assert.ok(after.json.job.transcript && after.json.job.transcript.cues >= 1, 'transcript must be saved on the shorts job');
  assert.equal(after.json.job.transcript.source, 'stt', 'transcript source must be stt');
  const srt = await req(`/api/shorts/jobs/${sj.json.job.id}/captions.srt`, { cookie: ownerCookie });
  assert.equal(srt.status, 200, JSON.stringify(srt.json));
  assert.ok(srt.text.includes('Hello world'), 'SRT export must contain the transcript');
});

test('music mood tags come from analysis + LLM; music generation saves real audio', async () => {
  const mood = await runAiJob('music-mood', { mediaId: srcAudio.id });
  assert.equal(mood.status, 'done', JSON.stringify(mood));
  assert.equal(mood.result.mood, 'Energetic');
  assert.ok(mood.result.energy >= 1 && mood.result.energy <= 10, 'energy must be 1-10');
  assert.ok((mood.result.tags || []).length >= 1, 'mood tags must be present');

  const gen = await runAiJob('music-generate', { prompt: 'A calm piano piece', duration: 5 });
  assert.equal(gen.status, 'done', JSON.stringify(gen));
  const bytes = await downloadMediaFile(gen.outputMediaId);
  assert.ok(bytes.length > 100, 'generated music must be non-empty');
  const tmpFile = path.join(tmp, `ai-music-${gen.outputMediaId}.wav`);
  fs.writeFileSync(tmpFile, bytes);
  const probe = await ffprobe(tmpFile);
  assert.ok((probe.streams || []).some((s) => s.codec_type === 'audio'), 'generated music must have an audio stream');
});

test('bulk AI backgrounds: assign creates a real AI image per row (cached per prompt)', async () => {
  // Minimal video template project (text clip only — assignment does not
  // need a background clip in the template).
  const { blankTimeline, defaultClip } = require('../src/video-model');
  const tl = blankTimeline('16:9', 30);
  const tx = defaultClip('text', null, 0, 1);
  tx.text = { ...tx.text, text: '{{PRODUCT_NAME}} — {{PRODUCT_PRICE}}', fontSize: 48, align: 'center' };
  tl.tracks[2].clips.push(tx);
  const proj = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'AI BG Template', type: 'video', content: { timeline: tl } } });
  assert.equal(proj.status, 201, JSON.stringify(proj.json));
  const bj = await req('/api/bulk', { method: 'POST', cookie: ownerCookie, body: { name: 'AI BG Job', kind: 'video', templateProjectId: proj.json.project.id } });
  assert.equal(bj.status, 201, JSON.stringify(bj.json));
  const ds = await req(`/api/bulk/${bj.json.job.id}/dataset`, { method: 'POST', cookie: ownerCookie, body: { text: 'PRODUCT_NAME,PRODUCT_PRICE\nShoes,2500\nHat,900' } });
  assert.equal(ds.status, 200, JSON.stringify(ds.json));
  const patch = await req(`/api/bulk/${bj.json.job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { background: { mode: 'ai' } } } });
  assert.equal(patch.status, 200, JSON.stringify(patch.json));
  const assigned = await req(`/api/bulk/${bj.json.job.id}/assign`, { method: 'POST', cookie: ownerCookie });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.json));
  const rows = assigned.json.rows.filter((r) => r.status !== 'skipped');
  assert.equal(rows.length, 2, 'two unique rows');
  assert.ok(rows.every((r) => r.backgroundMediaId), 'every row got an AI background');
  assert.notEqual(rows[0].backgroundMediaId, rows[1].backgroundMediaId, 'different rows must get different backgrounds');
  const media = await getMediaById(rows[0].backgroundMediaId);
  assert.ok(media, 'background must be in the Media Library');
  assert.ok((media.tags || '').includes('ai-background'), 'background must be tagged ai-background');
  // Second assign with the same prompts reuses the cached background.
  const again = await req(`/api/bulk/${bj.json.job.id}/assign`, { method: 'POST', cookie: ownerCookie });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  const rows2 = again.json.rows.filter((r) => r.status !== 'skipped');
  assert.equal(rows2[0].backgroundMediaId, rows[0].backgroundMediaId, 'same prompt must reuse the cached background');
});

test('job cancel stops a running job with no output; retry re-runs a failed job', async () => {
  // Cancel: the mock delays SLOW_IMAGE responses by 5s.
  const beforeCount = await countMedia();
  const created = await req('/api/ai/jobs', { method: 'POST', cookie: ownerCookie, body: { mode: 'image', name: 'cancel-test', prompt: 'SLOW_IMAGE a slow balloon' } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await new Promise((x) => setTimeout(x, 400));
  const cancelled = await req(`/api/ai/jobs/${created.json.job.id}/cancel`, { method: 'POST', cookie: ownerCookie });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.equal(cancelled.json.job.status, 'cancelled', 'job must be cancelled');
  assert.equal(await countMedia(), beforeCount, 'a cancelled job must not create output');

  // Retry: FAIL_ONCE fails the first provider call, succeeds on retry.
  const failed = await runAiJob('image', { prompt: 'FAIL_ONCE a balloon' });
  assert.equal(failed.status, 'failed', JSON.stringify(failed));
  assert.match(failed.error, /mock failure once/, 'failure must carry the provider error');
  const retried = await req(`/api/ai/jobs/${failed.id}/retry`, { method: 'POST', cookie: ownerCookie });
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.ok(['queued', 'running'].includes(retried.json.job.status), `retried job must be re-queued (got ${retried.json.job.status})`);
  const done = await (async () => {
    const deadline = Date.now() + 60000;
    for (;;) {
      const r = await req(`/api/ai/jobs/${failed.id}`, { cookie: ownerCookie });
      if (r.json.job.status === 'done') return r.json.job;
      if (['failed', 'cancelled'].includes(r.json.job.status)) throw new Error(`retry did not succeed: ${JSON.stringify(r.json.job)}`);
      if (Date.now() > deadline) throw new Error('retry did not finish');
      await new Promise((x) => setTimeout(x, 500));
    }
  })();
  assert.equal(done.status, 'done', 'retry must succeed once the provider answers');
  assert.ok(done.outputMediaId, 'retried job must have output media');
});

test('per-user isolation + anonymous 401 on AI jobs', async () => {
  const mine = await req('/api/ai/jobs', { cookie: ownerCookie });
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  assert.ok(mine.json.jobs.length >= 1, 'owner must have jobs');
  const firstId = mine.json.jobs[0].id;
  const other = await req(`/api/ai/jobs/${firstId}`, { cookie: userCookie });
  assert.equal(other.status, 404, 'another user must not see my AI job');
  const otherList = await req('/api/ai/jobs', { cookie: userCookie });
  assert.equal(otherList.status, 200, JSON.stringify(otherList.json));
  assert.equal(otherList.json.jobs.length, 0, 'another user must list no AI jobs');
  const anon = await req('/api/ai/jobs');
  assert.equal(anon.status, 401, 'anonymous AI job access must be refused');
});

test('removing a key returns the mode to honest refusal (no output)', async () => {
  const del = await req('/api/providers/llm/key', { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  const beforeCount = await countMedia();
  const job = await runAiJob('quiz', { topic: 'Space', count: 2 });
  assert.equal(job.status, 'failed', JSON.stringify(job));
  assert.match(job.error, /no API key|key needed|not configured/i, 'refusal must name the missing key');
  assert.equal(await countMedia(), beforeCount, 'refused quiz must create no output');
});
