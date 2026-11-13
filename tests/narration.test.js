'use strict';
// Quiz Narration + Voice tests (post-Phase-5 upgrade) — run with: npm test
// Spawns the real server on a scratch port (4836) with a temp DB/uploads dir.
// Covers: narration plan timing (question → options → answer), auto defaults
// vs manual animation overrides (timeline changes), voice profile CRUD +
// default switching + per-user isolation, TTS refusing honestly without a
// key (no audio file created), bulk voice (job voice on all rows, per-row
// VOICE override wins), and an end-to-end recorded-narration render
// (real MP4, ffprobe-valid, audio stream present).
//
// NOTE: the pure voice-resolution tests use a SEPARATE scratch DB (set via
// env before requiring the modules) so they never touch the HTTP server's DB.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-narr-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4836;
const BASE = `http://127.0.0.1:${PORT}`;

// --- Direct-DB voice resolution tests use their own scratch DB. ---
const dbTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-narr-db-'));
process.env.DB_PATH = path.join(dbTmp, 'unit.db');
process.env.UPLOADS_DIR = path.join(dbTmp, 'uploads');
process.env.RENDERS_DIR = path.join(dbTmp, 'renders');

const {
  parseQuestion, buildQuizTimeline, buildNarrationPlan,
  validateAnimations, resolveAnimations,
} = require('../src/quiz-model');
const { validateTimeline } = require('../src/video-model');
const db = require('../src/db');
const bulk = require('../src/bulk');

let server;
let ownerCookie = '';
let userCookie = '';

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

async function waitForBulkJob(jobId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await req(`/api/bulk/${jobId}`, { cookie: ownerCookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    if (['done', 'partial', 'failed', 'cancelled'].includes(r.json.job.status)) return r.json;
    if (Date.now() > deadline) throw new Error(`bulk job ${jobId} did not finish; last ${JSON.stringify(r.json.job)}`);
    await new Promise((x) => setTimeout(x, 700));
  }
}

async function downloadBulkRow(jobId, rowId) {
  const r = await fetch(BASE + `/api/bulk/${jobId}/rows/${rowId}/download`, { headers: { cookie: ownerCookie }, redirect: 'manual' });
  assert.equal(r.status, 200, `download row ${rowId}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const QUIZ_ROW = {
  QUESTION: 'What is 2 + 2?', OPTION_A: '3', OPTION_B: '4', OPTION_C: '5', OPTION_D: '6',
  CORRECT: 'B', EXPLANATION: '2 + 2 = 4.', CATEGORY: 'Maths', DIFFICULTY: 'easy', TIMER_SECONDS: 3,
};

let narrAudio;
let bgImage;

before(async () => {
  const audioFile = path.join(tmp, 'narr.wav');
  const imgFile = path.join(tmp, 'bg.png');
  makeTestAudio(audioFile, 3, 880);
  makeTestImage(imgFile, '0x1e40af');
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
  const b = await req('/api/auth/signup', { method: 'POST', body: { name: 'User', email: 'user@test.local', password: 'password123' } });
  assert.equal(b.status, 201, JSON.stringify(b.json));
  userCookie = b.setCookie.split(';')[0];
  narrAudio = await uploadMedia(audioFile, 'narr.wav', 'audio/wav');
  bgImage = await uploadMedia(imgFile, 'bg.png', 'image/png');
});

after(() => {
  if (server) server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(dbTmp, { recursive: true, force: true });
});

/* ---------------- Narration plan (pure) ---------------- */
test('narration plan: question first, then options one by one, then answer', () => {
  const q = parseQuestion(QUIZ_ROW, 0);
  const plan = buildNarrationPlan(q, 0, {});
  const qSeg = plan.segments.find((s) => s.element === 'question');
  const optSegs = plan.segments.filter((s) => s.element === 'option');
  const ansSeg = plan.segments.find((s) => s.element === 'answer');
  assert.equal(qSeg.start, 0, 'question segment starts the round');
  assert.equal(qSeg.duration, 2, 'question is spoken during the 2s read phase');
  assert.equal(optSegs.length, 4);
  // Spoken order: every option starts after the question and before the answer.
  for (let i = 0; i < optSegs.length; i++) {
    assert.ok(optSegs[i].start > qSeg.start, `option ${i} spoken after the question`);
    assert.ok(optSegs[i].start < ansSeg.start, `option ${i} spoken before the answer`);
    if (i > 0) assert.ok(optSegs[i].start > optSegs[i - 1].start, `option ${i} staggered after option ${i - 1}`);
    assert.ok(optSegs[i].appearAt > qSeg.start, `option ${i} appears after the question`);
    if (i > 0) assert.ok(optSegs[i].appearAt > optSegs[i - 1].appearAt, `option ${i} appears after option ${i - 1}`);
  }
  assert.equal(ansSeg.start, 5, 'answer reveal at 2s read + 3s countdown');
  assert.equal(ansSeg.duration, 2, 'answer spoken during the 2s reveal');
  // Visual stagger stays inside the read phase: all options visible before
  // the countdown starts (2s).
  assert.ok(Math.max(...optSegs.map((s) => s.appearAt)) < 2, 'all options appear before the countdown');
});

test('narration plan: auto defaults present; manual override changes the timeline', () => {
  const q = parseQuestion(QUIZ_ROW, 0);
  const auto = buildQuizTimeline([q], {});
  assert.equal(auto.animations.mode, 'auto');
  assert.equal(auto.animations.elements.question.type, 'fade', 'auto: question fades in');
  assert.equal(auto.animations.elements.option.type, 'slide-left', 'auto: options slide in');
  assert.equal(auto.animations.elements.answer.type, 'pop', 'auto: answer pops');
  // Option A question-phase clip starts staggered (0.4s) with slide-left.
  const optATrack = auto.timeline.tracks.find((t) => t.name === 'Option A');
  const optAClip = optATrack.clips.find((c) => c.id.includes('_q'));
  assert.equal(optAClip.start, 0.4, 'option A appears 0.4s after the question');
  assert.equal(optAClip.text.animIn, 'slide-left');
  // The reveal clip carries the ANSWER animation (pop), not the option one.
  const revealClip = optATrack.clips.find((c) => c.id.includes('_r'));
  assert.equal(revealClip.text.animIn, 'pop');
  // Manual: option pop at 0.8s + a 1.0s stagger moves every option.
  const manual = buildQuizTimeline([q], {
    animations: { mode: 'manual', optionStagger: 1, elements: { option: { type: 'pop', duration: 0.8 } } },
  });
  assert.equal(manual.animations.mode, 'manual');
  const mOptA = manual.timeline.tracks.find((t) => t.name === 'Option A').clips.find((c) => c.id.includes('_q'));
  assert.equal(mOptA.start, 1, 'manual stagger 1.0s moves option A to 1s');
  assert.equal(mOptA.text.animIn, 'pop');
  assert.equal(mOptA.text.animDuration, 0.8);
  // Both timelines validate (no overlaps on any track).
  assert.deepEqual(validateTimeline(auto.timeline), []);
  assert.deepEqual(validateTimeline(manual.timeline), []);
});

test('validateAnimations rejects unknown types; typewriter is never offered', () => {
  assert.throws(() => validateAnimations({ mode: 'manual', elements: { question: { type: 'typewriter' } } }), /Unknown animation type/);
  assert.throws(() => validateAnimations({ mode: 'manual', elements: { question: { type: 'spin' } } }), /Unknown animation type/);
  const resolved = resolveAnimations({ mode: 'manual', elements: { question: { type: 'slide-up', duration: 1.2 } } });
  assert.equal(resolved.elements.question.type, 'slide-up');
  assert.equal(resolved.elements.question.duration, 1.2);
  // Auto mode ignores overrides — the user must pick Manual to take control.
  const auto = resolveAnimations({ mode: 'auto', elements: { question: { type: 'pop' } } });
  assert.equal(auto.elements.question.type, 'fade');
});

/* ---------------- Voice resolution (direct DB) ---------------- */
test('bulk voice: row VOICE beats job voice beats default voice', () => {
  const u1 = db.createUser({ name: 'U1', email: 'u1@test.local', passwordHash: 'x', role: 'USER', plan: 'Free', credits: 100 });
  const u2 = db.createUser({ name: 'U2', email: 'u2@test.local', passwordHash: 'x', role: 'USER', plan: 'Free', credits: 100 });
  const mine = db.createVoiceProfile(u1.id, { name: 'My Voice', language: 'en', kind: 'clone', sampleMediaId: null });
  const ai = db.createVoiceProfile(u1.id, { name: 'AI Voice', language: 'en', kind: 'ai', aiVoice: 'alloy' });
  db.setDefaultVoiceProfile(u1.id, mine.id);
  // Row override by name wins over the job voice.
  let r = bulk.resolveVoiceForRow(u1.id, { VOICE: 'AI Voice' }, { voice: { profileId: mine.id } });
  assert.equal(r.profile.name, 'AI Voice');
  assert.equal(r.source, 'row');
  // Row override by id wins too.
  r = bulk.resolveVoiceForRow(u1.id, { VOICE: String(ai.id) }, { voice: { profileId: mine.id } });
  assert.equal(r.profile.id, ai.id);
  assert.equal(r.source, 'row');
  // No row voice: the job voice applies to the whole batch.
  r = bulk.resolveVoiceForRow(u1.id, {}, { voice: { profileId: ai.id } });
  assert.equal(r.profile.name, 'AI Voice');
  assert.equal(r.source, 'job');
  // Neither: the default voice.
  r = bulk.resolveVoiceForRow(u1.id, {}, { voice: {} });
  assert.equal(r.profile.name, 'My Voice');
  assert.equal(r.source, 'default');
  // An unknown row voice falls back to the job voice (never crashes).
  r = bulk.resolveVoiceForRow(u1.id, { VOICE: 'No Such Voice' }, { voice: { profileId: ai.id } });
  assert.equal(r.source, 'job');
  // Another user sees none of user 1's voices.
  r = bulk.resolveVoiceForRow(u2.id, {}, { voice: {} });
  assert.equal(r.profile, null);
  assert.equal(r.source, null);
});

/* ---------------- Voice profiles (API) ---------------- */
test('voice profiles: CRUD, default switching, per-user isolation', async () => {
  const anon = await req('/api/voice/profiles');
  assert.equal(anon.status, 401, 'anonymous gets 401');
  // Clone profile needs a sample; AI profile needs a real voice name.
  const bad1 = await req('/api/voice/profiles', { method: 'POST', cookie: ownerCookie, body: { name: 'No Sample', kind: 'clone' } });
  assert.equal(bad1.status, 400);
  const bad2 = await req('/api/voice/profiles', { method: 'POST', cookie: ownerCookie, body: { name: 'Bad AI', kind: 'ai', aiVoice: 'not-a-voice' } });
  assert.equal(bad2.status, 400);
  const mine = await req('/api/voice/profiles', { method: 'POST', cookie: ownerCookie, body: { name: 'My Voice', kind: 'clone', sampleMediaId: narrAudio.id, language: 'en' } });
  assert.equal(mine.status, 201, JSON.stringify(mine.json));
  assert.equal(mine.json.profile.isDefault, true, 'first profile becomes the default voice');
  assert.equal(mine.json.profile.ready, false, 'clone without a provider voice id is not ready to speak yet');
  const ai = await req('/api/voice/profiles', { method: 'POST', cookie: ownerCookie, body: { name: 'AI Voice', kind: 'ai', aiVoice: 'alloy' } });
  assert.equal(ai.status, 201, JSON.stringify(ai.json));
  assert.equal(ai.json.profile.ready, true, 'an AI voice with a voice name is ready (key still needed to speak)');
  assert.equal(ai.json.profile.isDefault, false);
  // Switch the default: the old default loses it.
  const switched = await req(`/api/voice/profiles/${ai.json.profile.id}`, { method: 'PATCH', cookie: ownerCookie, body: { isDefault: true } });
  assert.equal(switched.status, 200);
  assert.equal(switched.json.profile.isDefault, true);
  const list = await req('/api/voice/profiles', { cookie: ownerCookie });
  assert.equal(list.json.profiles.length, 2);
  assert.equal(list.json.profiles.find((p) => p.name === 'My Voice').isDefault, false);
  // The default endpoint agrees.
  const def = await req('/api/voice/default', { cookie: ownerCookie });
  assert.equal(def.json.profile.name, 'AI Voice');
  // Another user sees none of the owner's voices (isolation).
  const other = await req('/api/voice/profiles', { cookie: userCookie });
  assert.equal(other.json.profiles.length, 0);
  const peek = await req(`/api/voice/profiles/${mine.json.profile.id}`, { method: 'PATCH', cookie: userCookie, body: { isDefault: true } });
  assert.equal(peek.status, 404, 'cannot touch another user\'s voice');
  // Delete + delete-again 404.
  const del = await req(`/api/voice/profiles/${mine.json.profile.id}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 200);
  const del2 = await req(`/api/voice/profiles/${mine.json.profile.id}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del2.status, 404);
});

test('TTS without a key refuses honestly and creates no audio file', async () => {
  const status = await req('/api/voice/tts-status', { cookie: ownerCookie });
  assert.equal(status.status, 200);
  assert.equal(status.json.tts.voiceClone.status, 'key_needed', 'no ElevenLabs key is configured');
  assert.equal(status.json.tts.tts.status, 'key_needed', 'no OpenAI key is configured');
  // Find the default voice (the AI Voice profile from the previous test).
  const def = await req('/api/voice/default', { cookie: ownerCookie });
  assert.ok(def.json.profile, 'a default voice exists');
  const before = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.startsWith('narration-')) before.push(p);
    }
  };
  walk(uploadsDir);
  const r = await req('/api/voice/synthesise', { method: 'POST', cookie: ownerCookie, body: { text: 'What is two plus two?', voiceProfileId: def.json.profile.id } });
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.equal(r.json.code, 'PROVIDER_KEY_NEEDED');
  assert.match(r.json.error, /no API key/i);
  const after = [];
  walk(uploadsDir);
  assert.deepEqual(after, before, 'refused synthesis created no narration audio file');
  // Cloning also refuses without a key.
  const list = await req('/api/voice/profiles', { cookie: ownerCookie });
  const mine = await req('/api/voice/profiles', { method: 'POST', cookie: ownerCookie, body: { name: 'Clone Me', kind: 'clone', sampleMediaId: narrAudio.id } });
  assert.equal(mine.status, 201);
  const clone = await req(`/api/voice/profiles/${mine.json.profile.id}/clone`, { method: 'POST', cookie: ownerCookie });
  assert.equal(clone.status, 503, JSON.stringify(clone.json));
  assert.equal(clone.json.code, 'PROVIDER_KEY_NEEDED');
});

/* ---------------- Narration plan endpoint ---------------- */
test('narration-plan endpoint: same timing as the builder, auth enforced', async () => {
  const anon = await req('/api/bulk/quiz/narration-plan', { method: 'POST', body: { row: QUIZ_ROW } });
  assert.equal(anon.status, 401);
  const bad = await req('/api/bulk/quiz/narration-plan', { method: 'POST', cookie: ownerCookie, body: { row: { QUESTION: '' } } });
  assert.equal(bad.status, 400);
  const ok = await req('/api/bulk/quiz/narration-plan', { method: 'POST', cookie: ownerCookie, body: { row: QUIZ_ROW } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.plan.segments[0].element, 'question');
  assert.equal(ok.json.plan.segments[ok.json.plan.segments.length - 1].element, 'explanation');
  assert.ok(ok.json.animTypes.includes('pop') && !ok.json.animTypes.includes('typewriter'), 'typewriter is never offered');
  const badAnim = await req('/api/bulk/quiz/narration-plan', { method: 'POST', cookie: ownerCookie, body: { row: QUIZ_ROW, animations: { mode: 'manual', elements: { question: { type: 'spin' } } } } });
  assert.equal(badAnim.status, 400);
});

/* ---------------- Bulk voice settings ---------------- */
test('bulk voice: job voice is stored and reported; unknown profile rejected', async () => {
  const list = await req('/api/voice/profiles', { cookie: ownerCookie });
  const aiVoice = list.json.profiles.find((p) => p.name === 'AI Voice');
  assert.ok(aiVoice, 'AI Voice profile exists');
  const job = await req('/api/bulk', { method: 'POST', cookie: ownerCookie, body: { name: 'Voice Job', kind: 'video', templateProjectId: 'quiz', settings: { resolution: '720p' } } });
  assert.equal(job.status, 201, JSON.stringify(job.json));
  assert.equal(job.json.job.voice, null, 'no voice picked yet');
  const bad = await req(`/api/bulk/${job.json.job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { voice: { profileId: 99999 } } } });
  assert.equal(bad.status, 400);
  const patched = await req(`/api/bulk/${job.json.job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { voice: { profileId: aiVoice.id, tts: false } } } });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(patched.json.job.voice.name, 'AI Voice', 'job report shows the batch voice');
  const badAnim = await req(`/api/bulk/${job.json.job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { quiz: { animations: { mode: 'manual', elements: { answer: { type: 'spin' } } } } } } });
  assert.equal(badAnim.status, 400, 'bad animation type is rejected on the job');
  const goodAnim = await req(`/api/bulk/${job.json.job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { quiz: { animations: { mode: 'manual', optionStagger: 0.6, elements: { answer: { type: 'slide-up', duration: 0.6 } } } } } } });
  assert.equal(goodAnim.status, 200, JSON.stringify(goodAnim.json));
  assert.equal(goodAnim.json.job.settings.quiz.animations.elements.answer.type, 'slide-up');
});

/* ---------------- E2E: recorded narration renders with audio ---------------- */
test('e2e recorded narration: quiz row renders a real MP4 with an audio stream', async () => {
  const job = await req('/api/bulk', { method: 'POST', cookie: ownerCookie, body: { name: 'Narr Quiz', kind: 'video', templateProjectId: 'quiz', settings: { resolution: '720p', quiz: { mode: 'single', readSeconds: 2, timerSeconds: 3, revealSeconds: 2, ctaSeconds: 3 } } } });
  assert.equal(job.status, 201, JSON.stringify(job.json));
  const jobId = job.json.job.id;
  const csv = 'QUESTION,OPTION_A,OPTION_B,OPTION_C,OPTION_D,CORRECT,EXPLANATION,CATEGORY,DIFFICULTY,TIMER_SECONDS,NARRATION_AUDIO\n'
    + `What is 2 + 2?,3,4,5,6,B,2 + 2 = 4.,Maths,easy,3,${narrAudio.id}`;
  const up = await req(`/api/bulk/${jobId}/dataset`, { method: 'POST', cookie: ownerCookie, body: { text: csv } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.dedupeSummary.unique, 1);
  await req(`/api/bulk/${jobId}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { background: { mode: 'random', poolMediaIds: [bgImage.id], repeatRule: 'no-repeat' } } } });
  const fc = await req(`/api/bulk/${jobId}/fit-check`, { method: 'POST', cookie: ownerCookie });
  assert.equal(fc.status, 200, JSON.stringify(fc.json));
  // Sample render: the response reports the voice used for the row.
  const sample = await req(`/api/bulk/${jobId}/sample`, { method: 'POST', cookie: ownerCookie, body: { rowIndex: 0 } });
  assert.equal(sample.status, 201, JSON.stringify(sample.json));
  assert.ok(sample.json.voiceUsed, 'sample reports the voice used');
  assert.equal(sample.json.voiceUsed[0].audio, 'recorded', 'recorded narration is attached');
  // Wait for the sample render job itself (the bulk job stays a draft
  // after a sample — the render job is what finishes).
  const renderDeadline = Date.now() + 180000;
  for (;;) {
    const j = await req(`/api/video/jobs/${sample.json.jobId}`, { cookie: ownerCookie });
    assert.equal(j.status, 200, JSON.stringify(j.json));
    if (j.json.job.status === 'done') break;
    if (j.json.job.status === 'failed' || j.json.job.status === 'cancelled') {
      throw new Error(`sample render failed: ${j.json.job.error}`);
    }
    if (Date.now() > renderDeadline) throw new Error('sample render did not finish');
    await new Promise((x) => setTimeout(x, 700));
  }
  const after = await req(`/api/bulk/${jobId}`, { cookie: ownerCookie });
  const row = after.json.rows.find((r) => r.rowIndex === 0);
  assert.equal(row.status, 'done', JSON.stringify(row));
  const buf = await downloadBulkRow(jobId, row.id);
  const outFile = path.join(tmp, 'narr-quiz.mp4');
  fs.writeFileSync(outFile, buf);
  const probe = await ffprobe(outFile);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.width, 720);
  assert.equal(video.height, 1280);
  assert.ok(Math.abs(parseFloat(probe.format.duration) - 10) < 1, `quiz duration ${probe.format.duration}, expected 10s`);
  assert.ok(audio, 'rendered quiz video has an audio stream (the recorded narration)');
});
