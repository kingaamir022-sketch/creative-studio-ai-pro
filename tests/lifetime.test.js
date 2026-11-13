'use strict';
// OWNER Lifetime Free tests (v2.2.0) — run with: npm test
// Spawns the real server on a scratch port (4842) with a temp DB/uploads
// dir and exercises the Lifetime plan end to end over HTTP:
//  - first signup (OWNER) gets Lifetime; later signups stay Free (100)
//  - Lifetime plan definition (price 0, unlimited fields)
//  - a regular user requesting Lifetime is refused
//  - the OWNER stays unlimited even when the stored plan says Free
//    (belt and braces: role OWNER bypasses every credit gate)
//  - the boot migration upgrades an existing OWNER from Free to Lifetime
//    and leaves a regular USER on Free untouched
//  - a regular USER is still gated by their balance
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-lifetime-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4842;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let ownerCookie = '';
let userCookie = '';
let ownerId = 0;
let userId = 0;

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

function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return waitForHealth();
}

async function stopServer() {
  if (!server) return;
  server.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  server = null;
}

before(async () => {
  await startServer();
  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'Lifetime Owner', email: 'lifetime-owner@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  ownerCookie = s.setCookie.split(';')[0];
  ownerId = s.json.user.id;
  const u = await req('/api/auth/signup', { method: 'POST', body: { name: 'Lifetime User', email: 'lifetime-user@test.local', password: 'password123' } });
  assert.equal(u.status, 201, JSON.stringify(u.json));
  userCookie = u.setCookie.split(';')[0];
  userId = u.json.user.id;
});

after(async () => {
  await stopServer();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('Lifetime: first signup is OWNER on Lifetime; second signup is USER on Free with 100 credits', async () => {
  const me = await req('/api/auth/me', { cookie: ownerCookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.role, 'OWNER');
  assert.equal(me.json.user.plan, 'Lifetime');
  assert.equal(me.json.user.creditsBalance, 0, 'Lifetime has no finite balance');

  const mu = await req('/api/auth/me', { cookie: userCookie });
  assert.equal(mu.status, 200);
  assert.equal(mu.json.user.role, 'USER');
  assert.equal(mu.json.user.plan, 'Free');
  assert.equal(mu.json.user.creditsBalance, 100);
});

test('Lifetime: plan definition — price 0, credits/storage/projects unlimited', async () => {
  const r = await req('/api/billing/plans', { cookie: ownerCookie });
  assert.equal(r.status, 200);
  const lt = r.json.plans.find((p) => p.id === 'Lifetime');
  assert.ok(lt, 'Lifetime plan is listed');
  assert.equal(lt.name, 'Lifetime');
  assert.equal(lt.price, 0);
  assert.equal(lt.credits, null);
  assert.equal(lt.storageMB, null);
  assert.equal(lt.maxProjects, null);
  assert.ok(r.json.plans.some((p) => p.id === 'Free' && p.credits === 100), 'Free still 100 credits');
  assert.ok(r.json.plans.some((p) => p.id === 'Pro' && p.price === 29 && p.credits === 5000), 'Pro still $29 / 5000');
});

test('Lifetime: a regular user requesting Lifetime is refused', async () => {
  const r = await req('/api/billing/requests', { method: 'POST', cookie: userCookie, body: { plan: 'Lifetime' } });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /Lifetime.*OWNER|reserved for the OWNER/i);
  const mine = await req('/api/billing/requests', { cookie: userCookie });
  assert.ok(!mine.json.requests.some((x) => x.plan === 'Lifetime'), 'no Lifetime request was recorded');
});

async function makeTwoRowJob(cookie) {
  const job = await req('/api/bulk', { method: 'POST', cookie, body: { name: 'Lifetime Gate Batch', kind: 'video', templateProjectId: 'quiz', settings: {} } });
  assert.equal(job.status, 201, JSON.stringify(job.json));
  const csv = 'QUESTION,OPTION_A,OPTION_B,OPTION_C,OPTION_D,CORRECT\nWhat is 2+2?,3,4,5,6,B\nCapital of France?,London,Paris,Rome,Madrid,B';
  const up = await req(`/api/bulk/${job.json.job.id}/dataset`, { method: 'POST', cookie, body: { text: csv } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.dedupeSummary.unique, 2);
  return job.json.job.id;
}

test('Lifetime: OWNER stays unlimited even when the stored plan says Free', async () => {
  // Demote the OWNER's stored plan to Free (admin self-change; role untouched).
  const demoted = await req(`/api/users/${ownerId}`, { method: 'PATCH', cookie: ownerCookie, body: { plan: 'Free' } });
  assert.equal(demoted.status, 200, JSON.stringify(demoted.json));
  assert.equal(demoted.json.user.plan, 'Free');
  // Drain the OWNER balance to zero.
  const reset = await req(`/api/admin/users/${ownerId}/reset-credits`, { method: 'POST', cookie: ownerCookie, body: { credits: 0 } });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  // A limited Free account with 0 balance is refused 402 INSUFFICIENT_CREDITS
  // before any work. The OWNER must pass the credit gate — the caption then
  // fails only on the missing LLM key (PROVIDER_KEY_NEEDED), never on credits.
  const r = await req('/api/social/caption', { method: 'POST', cookie: ownerCookie, body: { text: 'quiz night caption', platform: 'facebook' } });
  assert.equal(r.status, 402, JSON.stringify(r.json));
  assert.equal(r.json.code, 'PROVIDER_KEY_NEEDED', 'credit gate passed; only the missing key blocks');
});

test('Lifetime: boot migration upgrades an existing OWNER from Free to Lifetime and leaves a USER on Free', async () => {
  // The OWNER is on Free now (previous test demoted them); the USER is on Free too.
  await stopServer();
  await startServer(); // boot runs the migration
  const me = await req('/api/auth/me', { cookie: ownerCookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.plan, 'Lifetime', 'migration upgraded the OWNER');
  const mu = await req('/api/auth/me', { cookie: userCookie });
  assert.equal(mu.status, 200);
  assert.equal(mu.json.user.plan, 'Free', 'migration left the regular USER untouched');
  const bal = await req('/api/billing/balance', { cookie: ownerCookie });
  assert.equal(bal.json.plan, 'Lifetime');
  // Migration is idempotent: a second restart changes nothing.
  await stopServer();
  await startServer();
  const me2 = await req('/api/auth/me', { cookie: ownerCookie });
  assert.equal(me2.json.user.plan, 'Lifetime');
});

test('Lifetime: regular USER is still gated by their balance', async () => {
  const jobId = await makeTwoRowJob(userCookie);
  const reset = await req(`/api/admin/users/${userId}/reset-credits`, { method: 'POST', cookie: ownerCookie, body: { credits: 1 } });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  const start = await req(`/api/bulk/${jobId}/start`, { method: 'POST', cookie: userCookie });
  assert.equal(start.status, 402, JSON.stringify(start.json));
  assert.equal(start.json.code, 'INSUFFICIENT_CREDITS');
  assert.match(start.json.error, /2 rows/);
  await req(`/api/admin/users/${userId}/reset-credits`, { method: 'POST', cookie: ownerCookie, body: { credits: 100 } });
});

test('Lifetime: OWNER on Lifetime with zero balance passes the credit gate (plan-based unlimited)', async () => {
  const bal = await req('/api/billing/balance', { cookie: ownerCookie });
  assert.equal(bal.json.plan, 'Lifetime');
  assert.equal(bal.json.creditsBalance, 0);
  // Same probe as the role test: the credit gate must pass, so the caption
  // fails only on the missing LLM key — never on credits.
  const r = await req('/api/social/caption', { method: 'POST', cookie: ownerCookie, body: { text: 'quiz night caption', platform: 'facebook' } });
  assert.equal(r.status, 402, JSON.stringify(r.json));
  assert.equal(r.json.code, 'PROVIDER_KEY_NEEDED', 'credit gate passed; only the missing key blocks');
});
