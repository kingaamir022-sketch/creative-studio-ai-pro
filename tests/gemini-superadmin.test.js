'use strict';
// Gemini free provider + Super Admin tests (v2.2.1) — run with: npm test
// Spawns the real server on a scratch port (4843) with a temp DB/uploads
// dir, PLUS a local MOCK provider HTTP server that speaks the real
// OpenAI-compatible chat/completions shape. No real key and no real network
// call to Google ever happens: every LLM call in this file goes to the mock.
// Covers:
//  - Gemini is registered (kind llm, free-tier label, OpenAI-compatible
//    base URL, gemini-3.8-flash / gemini-2.5-flash) and OpenAI stays the
//    default active LLM provider
//  - the LLM key-needed error names Gemini as the free alternative
//  - quiz generation routes through Gemini when it is the active provider
//    (mock records model, Bearer key, response_format json_object)
//  - Super Admin: ADMIN can suspend, change roles, delete and approve
//    plans for USERs; ADMIN gets 403 on OWNER targets, 403 when granting
//    the OWNER role or assigning Lifetime; OWNER can still do everything;
//    self-demotion stays blocked; regular USERs still get 403 on admin
//    endpoints.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-gemini-admin-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4843;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let mockServer;
let mockPort;
let ownerCookie = '';
let adminCookie = '';
let userACookie = '';
let userBCookie = '';
let userCCookie = '';
let userDCookie = '';
let ownerId = 0;
let adminId = 0;
let userAId = 0;
let userBId = 0;
let userCId = 0;
let userDId = 0;

// --- Local mock provider (OpenAI-compatible chat/completions) --------------
const mockState = { lastChat: null, chatCount: 0 };

function mockHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  let body = Buffer.alloc(0);
  req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body.toString('utf8')); } catch { json = null; }
    if (req.method === 'GET' && url.pathname === '/models') {
      return sendJson(200, { data: [{ id: 'gemini-3.8-flash' }, { id: 'gemini-2.5-flash' }] });
    }
    if (req.method === 'POST' && url.pathname === '/chat/completions') {
      mockState.chatCount += 1;
      mockState.lastChat = {
        model: json && json.model,
        auth: req.headers.authorization || '',
        responseFormat: json && json.response_format,
        messages: json && json.messages,
      };
      const questions = [1, 2, 3].map((n) => ({
        question: `Mock question ${n} about the topic?`,
        options: ['Alpha', 'Beta', 'Gamma', 'Delta'],
        correct: 'B',
        explanation: 'Mock explanation.',
      }));
      return sendJson(200, { choices: [{ message: { content: JSON.stringify({ questions }) } }] });
    }
    return sendJson(404, { error: 'mock: unknown route ' + url.pathname });
  });
}

function req(pathName, { method = 'GET', body, cookie } = {}) {
  const headers = { connection: 'close' };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return fetch(BASE + pathName, { method, headers, body: payload, redirect: 'manual' })
    .then(async (r) => {
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, text, setCookie: r.headers.get('set-cookie') || '' };
    });
}

async function waitForHealth() {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function signup(name, email) {
  const s = await req('/api/auth/signup', { method: 'POST', body: { name, email, password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  return { cookie: s.setCookie.split(';')[0], id: s.json.user.id };
}

async function runAiJob(mode, params, cookie) {
  const created = await req('/api/ai/jobs', { method: 'POST', cookie: cookie || ownerCookie, body: { mode, name: `test-${mode}`, ...params } });
  assert.equal(created.status, 201, `create ${mode} job: ${JSON.stringify(created.json)}`);
  const jobId = created.json.job.id;
  const deadline = Date.now() + 120000;
  for (;;) {
    const r = await req(`/api/ai/jobs/${jobId}`, { cookie: cookie || ownerCookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const job = r.json.job;
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`AI job ${jobId} (${mode}) did not finish; last ${JSON.stringify(job)}`);
    await new Promise((x) => setTimeout(x, 500));
  }
}

before(async () => {
  mockServer = http.createServer(mockHandler);
  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
  mockPort = mockServer.address().port;
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth();
  const o = await signup('Gemini Owner', 'gemini-owner@test.local');
  ownerCookie = o.cookie; ownerId = o.id;
  const a = await signup('Gemini Admin', 'gemini-admin@test.local');
  adminCookie = a.cookie; adminId = a.id;
  const ua = await signup('Gemini UserA', 'gemini-usera@test.local');
  userACookie = ua.cookie; userAId = ua.id;
  const ub = await signup('Gemini UserB', 'gemini-userb@test.local');
  userBCookie = ub.cookie; userBId = ub.id;
  const uc = await signup('Gemini UserC', 'gemini-userc@test.local');
  userCCookie = uc.cookie; userCId = uc.id;
  const ud = await signup('Gemini UserD', 'gemini-userd@test.local');
  userDCookie = ud.cookie; userDId = ud.id;
  // Promote the second account to ADMIN (Super Admin under test).
  const promo = await req(`/api/admin/users/${adminId}/role`, { method: 'PATCH', cookie: ownerCookie, body: { role: 'ADMIN' } });
  assert.equal(promo.status, 200, JSON.stringify(promo.json));
  assert.equal(promo.json.user.role, 'ADMIN');
});

after(async () => {
  if (server) server.kill('SIGKILL');
  if (mockServer) await new Promise((r) => mockServer.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// --- Gemini provider ---------------------------------------------------------

test('Gemini: provider is registered as a free-tier LLM with the OpenAI-compatible base URL', async () => {
  const st = await req('/api/ai/status', { cookie: ownerCookie });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  const llm = st.json.kinds.llm;
  const gemini = llm.providers.find((p) => p.id === 'gemini');
  assert.ok(gemini, 'gemini provider is listed');
  assert.equal(gemini.kind, 'llm');
  assert.match(gemini.label, /Gemini/i);
  assert.match(gemini.label, /free tier/i);
  assert.equal(gemini.defaultBaseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.ok(gemini.models.includes('gemini-3.8-flash'), 'gemini-3.8-flash listed');
  assert.ok(!gemini.models.includes('gemini-2.0-flash'), 'retired gemini-2.0-flash must not be listed');
  assert.ok(gemini.models.includes('gemini-2.5-flash'), 'gemini-2.5-flash listed');
  assert.equal(gemini.configured, false, 'no key configured yet');
  assert.match(gemini.about || '', /free/i, 'about text says the key is free');
});

test('Gemini: OpenAI stays the default active LLM provider', async () => {
  const st = await req('/api/ai/status', { cookie: ownerCookie });
  assert.equal(st.json.kinds.llm.active, 'llm', 'OpenAI is still the default LLM provider');
});

test('Gemini: the LLM key-needed error names Gemini as the free alternative', async () => {
  const job = await runAiJob('quiz', { topic: 'Space', count: 2 });
  assert.equal(job.status, 'failed', JSON.stringify(job));
  assert.match(String(job.error || ''), /no API key/i);
  assert.match(String(job.error || ''), /Gemini/, 'error names Gemini as the free alternative');
  assert.match(String(job.error || ''), /free/i);
  assert.match(String(job.error || ''), /Google AI Studio/i);
});

test('Gemini: quiz generation routes through Gemini when it is the active LLM provider', async () => {
  const mockBase = `http://127.0.0.1:${mockPort}`;
  const cfg = await req('/api/providers/gemini/config', { method: 'POST', cookie: ownerCookie, body: { baseUrl: mockBase } });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.json));
  const key = await req('/api/providers/gemini/key', { method: 'POST', cookie: ownerCookie, body: { key: 'mock-gemini-key-12345' } });
  assert.equal(key.status, 200, JSON.stringify(key.json));
  const act = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'gemini' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  const st = await req('/api/ai/status', { cookie: ownerCookie });
  assert.equal(st.json.kinds.llm.active, 'gemini', 'Gemini is now the active LLM provider');
  assert.equal(st.json.kinds.llm.configured, true, 'Gemini configured once the key is set');

  const job = await runAiJob('quiz', { topic: 'Space', count: 3 });
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.ok(job.result && Array.isArray(job.result.questions), 'quiz result has questions');
  assert.equal(job.result.questions.length, 3, 'exactly 3 questions generated');
  assert.equal(mockState.chatCount, 1, 'exactly one chat/completions call hit the mock');
  assert.equal(mockState.lastChat.model, 'gemini-3.8-flash', 'the mock was called with the Gemini default model');
  assert.equal(mockState.lastChat.auth, 'Bearer mock-gemini-key-12345', 'Bearer key auth used');
  assert.equal(mockState.lastChat.responseFormat && mockState.lastChat.responseFormat.type, 'json_object', 'JSON mode requested');
});

test('Gemini: Test connection succeeds against the mock', async () => {
  const t = await req('/api/providers/gemini/test', { method: 'POST', cookie: ownerCookie });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.equal(t.json.ok, true, JSON.stringify(t.json));
  assert.match(String(t.json.detail || ''), /models listed|Connection OK/i);
});

test('Gemini: switching the active LLM provider back to OpenAI works', async () => {
  const act = await req('/api/providers/active', { method: 'POST', cookie: ownerCookie, body: { kind: 'llm', provider: 'llm' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  const st = await req('/api/ai/status', { cookie: ownerCookie });
  assert.equal(st.json.kinds.llm.active, 'llm', 'OpenAI is active again');
});

// --- Super Admin -------------------------------------------------------------

test('Super Admin: ADMIN can suspend a USER, but not the OWNER', async () => {
  const s = await req(`/api/admin/users/${userAId}/suspend`, { method: 'POST', cookie: adminCookie });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal(s.json.user.suspended, true);
  const blocked = await req(`/api/admin/users/${ownerId}/suspend`, { method: 'POST', cookie: adminCookie });
  assert.equal(blocked.status, 403, JSON.stringify(blocked.json));
  assert.match(String(blocked.json.error || ''), /OWNER.*protected/i);
  const un = await req(`/api/admin/users/${userAId}/unsuspend`, { method: 'POST', cookie: ownerCookie });
  assert.equal(un.status, 200, JSON.stringify(un.json));
  assert.equal(un.json.user.suspended, false);
});

test('Super Admin: ADMIN can change a USER role, but not an OWNER row and never to OWNER', async () => {
  const up = await req(`/api/admin/users/${userAId}/role`, { method: 'PATCH', cookie: adminCookie, body: { role: 'ADMIN' } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.user.role, 'ADMIN');
  const targetOwner = await req(`/api/admin/users/${ownerId}/role`, { method: 'PATCH', cookie: adminCookie, body: { role: 'USER' } });
  assert.equal(targetOwner.status, 403, JSON.stringify(targetOwner.json));
  const grantOwner = await req(`/api/admin/users/${userBId}/role`, { method: 'PATCH', cookie: adminCookie, body: { role: 'OWNER' } });
  assert.equal(grantOwner.status, 403, JSON.stringify(grantOwner.json));
  assert.match(String(grantOwner.json.error || ''), /Only the OWNER can grant/i);
  // OWNER can still do it — restore userA to USER.
  const back = await req(`/api/admin/users/${userAId}/role`, { method: 'PATCH', cookie: ownerCookie, body: { role: 'USER' } });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(back.json.user.role, 'USER');
});

test('Super Admin: self-demotion stays blocked for ADMIN and OWNER', async () => {
  const adminSelf = await req(`/api/admin/users/${adminId}/role`, { method: 'PATCH', cookie: adminCookie, body: { role: 'USER' } });
  assert.equal(adminSelf.status, 400, JSON.stringify(adminSelf.json));
  assert.match(String(adminSelf.json.error || ''), /cannot demote your own/i);
  const ownerSelf = await req(`/api/admin/users/${ownerId}/role`, { method: 'PATCH', cookie: ownerCookie, body: { role: 'ADMIN' } });
  assert.equal(ownerSelf.status, 400, JSON.stringify(ownerSelf.json));
});

test('Super Admin: ADMIN can change a USER plan, but not an OWNER plan and never to Lifetime', async () => {
  const up = await req(`/api/users/${userAId}`, { method: 'PATCH', cookie: adminCookie, body: { plan: 'Pro' } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.user.plan, 'Pro');
  const targetOwner = await req(`/api/users/${ownerId}`, { method: 'PATCH', cookie: adminCookie, body: { plan: 'Pro' } });
  assert.equal(targetOwner.status, 403, JSON.stringify(targetOwner.json));
  const lifetime = await req(`/api/users/${userAId}`, { method: 'PATCH', cookie: adminCookie, body: { plan: 'Lifetime' } });
  assert.equal(lifetime.status, 403, JSON.stringify(lifetime.json));
  assert.match(String(lifetime.json.error || ''), /Lifetime.*reserved/i);
  const selfLifetime = await req('/api/subscription/plan', { method: 'POST', cookie: adminCookie, body: { plan: 'Lifetime' } });
  assert.equal(selfLifetime.status, 403, JSON.stringify(selfLifetime.json));
  const selfPro = await req('/api/subscription/plan', { method: 'POST', cookie: adminCookie, body: { plan: 'Pro' } });
  assert.equal(selfPro.status, 200, JSON.stringify(selfPro.json));
  // Restore: OWNER puts the admin back on Free.
  const restore = await req(`/api/users/${adminId}`, { method: 'PATCH', cookie: ownerCookie, body: { plan: 'Free' } });
  assert.equal(restore.status, 200, JSON.stringify(restore.json));
});

test('Super Admin: ADMIN can approve a plan request for a USER', async () => {
  const rq = await req('/api/billing/requests', { method: 'POST', cookie: userBCookie, body: { plan: 'Pro' } });
  assert.equal(rq.status, 201, JSON.stringify(rq.json));
  const ap = await req(`/api/billing/admin/requests/${rq.json.request.id}/approve`, { method: 'POST', cookie: adminCookie });
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  assert.equal(ap.json.user.plan, 'Pro');
  const me = await req('/api/auth/me', { cookie: userBCookie });
  assert.equal(me.json.user.plan, 'Pro');
});

test('Super Admin: approving a Lifetime request for a non-OWNER is refused', async () => {
  // Seed the request directly: the request endpoint itself refuses Lifetime
  // for non-OWNERs, so a pending one can only exist by direct DB insert.
  const Database = require('better-sqlite3');
  const tdb = new Database(dbPath);
  const ins = tdb.prepare("INSERT INTO plan_requests (user_id, plan, status) VALUES (?, 'Lifetime', 'pending')").run(userDId);
  tdb.close();
  const ap = await req(`/api/billing/admin/requests/${ins.lastInsertRowid}/approve`, { method: 'POST', cookie: adminCookie });
  assert.equal(ap.status, 400, JSON.stringify(ap.json));
  assert.match(String(ap.json.error || ''), /Lifetime.*reserved/i);
  const apOwner = await req(`/api/billing/admin/requests/${ins.lastInsertRowid}/approve`, { method: 'POST', cookie: ownerCookie });
  assert.equal(apOwner.status, 400, JSON.stringify(apOwner.json));
  const list = await req('/api/billing/admin/requests', { cookie: ownerCookie });
  const row = list.json.requests.find((r) => r.id === ins.lastInsertRowid);
  assert.ok(row && row.status === 'pending', 'request stays pending after refused approvals');
});

test('Super Admin: ADMIN can delete a USER, but not the OWNER; OWNER can still delete', async () => {
  const del = await req(`/api/admin/users/${userBId}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  const gone = await req(`/api/admin/users/${userBId}`, { cookie: ownerCookie });
  assert.equal(gone.status, 404, JSON.stringify(gone.json));
  const blocked = await req(`/api/admin/users/${ownerId}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(blocked.status, 403, JSON.stringify(blocked.json));
  assert.match(String(blocked.json.error || ''), /OWNER.*protected/i);
  const ownerDel = await req(`/api/admin/users/${userCId}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(ownerDel.status, 200, JSON.stringify(ownerDel.json));
});

test('Super Admin: regular USERs still get 403 on admin endpoints', async () => {
  // userA was suspended earlier (which revokes sessions), so sign in again
  // for a live USER cookie before probing the admin endpoints.
  const login = await req('/api/auth/login', { method: 'POST', body: { email: 'gemini-usera@test.local', password: 'password123' } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  userACookie = login.setCookie.split(';')[0];
  const role = await req(`/api/admin/users/${userAId}/role`, { method: 'PATCH', cookie: userACookie, body: { role: 'ADMIN' } });
  assert.equal(role.status, 403, JSON.stringify(role.json));
  const list = await req('/api/admin/users', { cookie: userACookie });
  assert.equal(list.status, 403, JSON.stringify(list.json));
});

test('Super Admin: OWNER can still do everything (suspend, role, delete)', async () => {
  const s = await req(`/api/admin/users/${userAId}/suspend`, { method: 'POST', cookie: ownerCookie });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const un = await req(`/api/admin/users/${userAId}/unsuspend`, { method: 'POST', cookie: ownerCookie });
  assert.equal(un.status, 200, JSON.stringify(un.json));
  const role = await req(`/api/admin/users/${userAId}/role`, { method: 'PATCH', cookie: ownerCookie, body: { role: 'ADMIN' } });
  assert.equal(role.status, 200, JSON.stringify(role.json));
  const back = await req(`/api/admin/users/${userAId}/role`, { method: 'PATCH', cookie: ownerCookie, body: { role: 'USER' } });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  const del = await req(`/api/admin/users/${userDId}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 200, JSON.stringify(del.json));
});
