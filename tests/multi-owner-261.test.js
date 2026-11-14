'use strict';
// Multi-Owner tests (v2.7.0) — run with: node --test tests/multi-owner-261.test.js
// Spawns the real server on a scratch port (4855) with a temp DB/uploads
// dir. No real network call ever happens. Covers:
//  - first signup -> OWNER + Lifetime; second (non-listed) signup -> USER
//  - allowlisted non-first signups (josnking01@gmail.com,
//    a030210523@gmail.com) -> OWNER + Lifetime
//  - isOwnerEmail() unit checks (case-insensitive, rejects others)
//  - login promotes a demoted allowlisted account back to OWNER
//    (end-to-end via HTTP: OWNER demotes the allowlisted OWNER to USER,
//    that user logs in again and is OWNER again). Note: signup already
//    auto-promotes allowlisted emails, so a listed USER row cannot be
//    produced through the API in a fresh DB — the demote-then-login path
//    is the observable form of the promotion logic, and it is also the
//    real pre-v2.6.1 case (an account created before the allowlist
//    existed, or demoted by another OWNER).
//  - OWNER promotes USER -> OWNER (both role endpoints) and ADMIN -> OWNER
//  - ADMIN gets 403 granting OWNER, and 403 demoting/suspending/deleting
//    an OWNER (both endpoints where applicable)
//  - last-OWNER protection: demoting down to one OWNER works; the sole
//    OWNER cannot self-demote (400) or self-delete (400); an ADMIN
//    cannot delete the sole OWNER (403); exactly one OWNER remains
//  - wrong-password login -> 401 with the exact server message
//  - health reports version 2.7.0, phase 13
//  - public/app.js maps an unreachable server to the friendly
//    SERVER_UNREACHABLE_MSG and contains no 'Failed to fetch'
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-multi-owner-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4855;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let ownerACookie = '';
let ownerBCookie = '';
let ownerCCookie = '';
let plainCookie = '';
let adminCookie = '';
let extraCookie = '';
let ownerAId = 0;
let ownerBId = 0;
let ownerCId = 0;
let plainId = 0;
let adminId = 0;
let extraId = 0;

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

async function login(email, password = 'password123') {
  return req('/api/auth/login', { method: 'POST', body: { email, password } });
}

async function me(cookie) {
  const r = await req('/api/auth/me', { cookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.user;
}

async function listUsers(cookie) {
  const r = await req('/api/admin/users', { cookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.users;
}

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth();
  // Signup order matters: first account is OWNER by the first-account
  // rule; the rest prove the allowlist (or its absence).
  const a = await signup('Owner A', 'kingaamir022@gmail.com');
  ownerACookie = a.cookie; ownerAId = a.id;
  const p = await signup('Plain User', 'plain-user@test.local');
  plainCookie = p.cookie; plainId = p.id;
  const b = await signup('Owner B', 'josnking01@gmail.com');
  ownerBCookie = b.cookie; ownerBId = b.id;
  const c = await signup('Owner C', 'a030210523@gmail.com');
  ownerCCookie = c.cookie; ownerCId = c.id;
  const ad = await signup('Admin User', 'admin-user@test.local');
  adminCookie = ad.cookie; adminId = ad.id;
  const e = await signup('Extra User', 'extra-user@test.local');
  extraCookie = e.cookie; extraId = e.id;
  // Promote the admin fixture to ADMIN (OWNER-only grant, admin endpoint).
  const promo = await req(`/api/admin/users/${adminId}/role`, { method: 'PATCH', cookie: ownerACookie, body: { role: 'ADMIN' } });
  assert.equal(promo.status, 200, JSON.stringify(promo.json));
  assert.equal(promo.json.user.role, 'ADMIN');
});

after(async () => {
  if (server) server.kill('SIGKILL');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// --- Signup: first account + allowlist -------------------------------------

test('Multi-Owner: first signup is OWNER + Lifetime; second (non-listed) signup is USER + Free', async () => {
  const first = await me(ownerACookie);
  assert.equal(first.email, 'kingaamir022@gmail.com');
  assert.equal(first.role, 'OWNER');
  assert.equal(first.plan, 'Lifetime');
  const second = await me(plainCookie);
  assert.equal(second.email, 'plain-user@test.local');
  assert.equal(second.role, 'USER');
  assert.equal(second.plan, 'Free');
});

test('Multi-Owner: allowlisted non-first signups are OWNER + Lifetime', async () => {
  const b = await me(ownerBCookie);
  assert.equal(b.email, 'josnking01@gmail.com');
  assert.equal(b.role, 'OWNER');
  assert.equal(b.plan, 'Lifetime');
  const c = await me(ownerCCookie);
  assert.equal(c.email, 'a030210523@gmail.com');
  assert.equal(c.role, 'OWNER');
  assert.equal(c.plan, 'Lifetime');
  const owners = (await listUsers(ownerACookie)).filter((u) => u.role === 'OWNER');
  assert.equal(owners.length, 3, 'exactly the three allowlisted accounts are OWNER');
});

test('Multi-Owner: isOwnerEmail() matches case-insensitively and rejects others', async () => {
  const { isOwnerEmail, OWNER_EMAILS } = require('../src/ownerEmails');
  assert.deepEqual(
    [...OWNER_EMAILS].sort(),
    ['a030210523@gmail.com', 'josnking01@gmail.com', 'kingaamir022@gmail.com'],
    'allowlist holds exactly the three OWNER Gmails',
  );
  assert.equal(isOwnerEmail('kingaamir022@gmail.com'), true);
  assert.equal(isOwnerEmail('KINGAAMIR022@GMAIL.COM'), true, 'match is case-insensitive');
  assert.equal(isOwnerEmail('  josnking01@gmail.com  '), true, 'surrounding spaces are trimmed');
  assert.equal(isOwnerEmail('a030210523@gmail.com'), true);
  assert.equal(isOwnerEmail('plain-user@test.local'), false);
  assert.equal(isOwnerEmail('kingaamir022@gmail.comm'), false);
  assert.equal(isOwnerEmail(''), false);
  assert.equal(isOwnerEmail(null), false);
  assert.equal(isOwnerEmail(undefined), false);
});

// --- Login promotion ---------------------------------------------------------

test('Multi-Owner: login promotes a demoted allowlisted account back to OWNER', async () => {
  // OWNER A demotes OWNER B (josnking01) to USER — allowed while other
  // OWNERs remain.
  const demoted = await req(`/api/admin/users/${ownerBId}/role`, { method: 'PATCH', cookie: ownerACookie, body: { role: 'USER' } });
  assert.equal(demoted.status, 200, JSON.stringify(demoted.json));
  assert.equal(demoted.json.user.role, 'USER');
  // B logs in again: the allowlist promotes the account back to OWNER.
  const again = await login('josnking01@gmail.com');
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.user.role, 'OWNER');
  assert.equal(again.json.user.plan, 'Lifetime');
  ownerBCookie = again.setCookie.split(';')[0];
  const owners = (await listUsers(ownerACookie)).filter((u) => u.role === 'OWNER');
  assert.equal(owners.length, 3, 'three OWNERs again after login promotion');
});

// --- OWNER grants ------------------------------------------------------------

test('Multi-Owner: OWNER promotes USER to OWNER via the admin role endpoint', async () => {
  const up = await req(`/api/admin/users/${plainId}/role`, { method: 'PATCH', cookie: ownerACookie, body: { role: 'OWNER' } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.user.role, 'OWNER');
  // Restore: demote back to USER so later owner-count tests stay exact.
  const back = await req(`/api/admin/users/${plainId}/role`, { method: 'PATCH', cookie: ownerACookie, body: { role: 'USER' } });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(back.json.user.role, 'USER');
});

test('Multi-Owner: OWNER promotes USER to OWNER via the Admin Panel endpoint (PATCH /api/users/:id)', async () => {
  const up = await req(`/api/users/${extraId}`, { method: 'PATCH', cookie: ownerACookie, body: { role: 'OWNER' } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.user.role, 'OWNER');
  // Restore via the same endpoint.
  const back = await req(`/api/users/${extraId}`, { method: 'PATCH', cookie: ownerACookie, body: { role: 'USER' } });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(back.json.user.role, 'USER');
});

test('Multi-Owner: OWNER promotes ADMIN to OWNER', async () => {
  const up = await req(`/api/admin/users/${adminId}/role`, { method: 'PATCH', cookie: ownerACookie, body: { role: 'OWNER' } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.user.role, 'OWNER');
  // Restore to ADMIN via the Admin Panel endpoint (covers that path too).
  const back = await req(`/api/users/${adminId}`, { method: 'PATCH', cookie: ownerACookie, body: { role: 'ADMIN' } });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(back.json.user.role, 'ADMIN');
});

// --- ADMIN cannot touch OWNERs (regression) ---------------------------------

test('Multi-Owner: ADMIN promoting to OWNER is 403 on both role endpoints', async () => {
  const viaAdmin = await req(`/api/admin/users/${extraId}/role`, { method: 'PATCH', cookie: adminCookie, body: { role: 'OWNER' } });
  assert.equal(viaAdmin.status, 403, JSON.stringify(viaAdmin.json));
  assert.match(String(viaAdmin.json.error || ''), /Only the OWNER can grant/i);
  const viaSystem = await req(`/api/users/${extraId}`, { method: 'PATCH', cookie: adminCookie, body: { role: 'OWNER' } });
  assert.equal(viaSystem.status, 403, JSON.stringify(viaSystem.json));
  assert.match(String(viaSystem.json.error || ''), /Only the OWNER can grant/i);
  const stillUser = (await listUsers(ownerACookie)).find((u) => u.id === extraId);
  assert.equal(stillUser.role, 'USER', 'the refused grant changed nothing');
});

test('Multi-Owner: ADMIN demoting, suspending or deleting an OWNER is 403', async () => {
  const demoteAdmin = await req(`/api/admin/users/${ownerAId}/role`, { method: 'PATCH', cookie: adminCookie, body: { role: 'USER' } });
  assert.equal(demoteAdmin.status, 403, JSON.stringify(demoteAdmin.json));
  const demoteSystem = await req(`/api/users/${ownerAId}`, { method: 'PATCH', cookie: adminCookie, body: { role: 'USER' } });
  assert.equal(demoteSystem.status, 403, JSON.stringify(demoteSystem.json));
  const suspend = await req(`/api/admin/users/${ownerAId}/suspend`, { method: 'POST', cookie: adminCookie });
  assert.equal(suspend.status, 403, JSON.stringify(suspend.json));
  assert.match(String(suspend.json.error || ''), /OWNER.*protected/i);
  const del = await req(`/api/admin/users/${ownerAId}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(del.status, 403, JSON.stringify(del.json));
  assert.match(String(del.json.error || ''), /OWNER.*protected/i);
  const stillOwner = await me(ownerACookie);
  assert.equal(stillOwner.role, 'OWNER', 'OWNER A is untouched after the refused ADMIN actions');
});

// --- Last-OWNER protection ---------------------------------------------------

test('Multi-Owner: last-OWNER protection — demote down to one OWNER, then the sole OWNER stays', async () => {
  // Three OWNERs at this point (A, B, C). Demote C, then B: both 200.
  const demoteC = await req(`/api/admin/users/${ownerCId}/role`, { method: 'PATCH', cookie: ownerACookie, body: { role: 'USER' } });
  assert.equal(demoteC.status, 200, JSON.stringify(demoteC.json));
  assert.equal(demoteC.json.user.role, 'USER');
  const demoteB = await req(`/api/admin/users/${ownerBId}/role`, { method: 'PATCH', cookie: ownerACookie, body: { role: 'USER' } });
  assert.equal(demoteB.status, 200, JSON.stringify(demoteB.json));
  assert.equal(demoteB.json.user.role, 'USER');
  let owners = (await listUsers(ownerACookie)).filter((u) => u.role === 'OWNER');
  assert.deepEqual(owners.map((u) => u.email), ['kingaamir022@gmail.com'], 'OWNER A is now the sole OWNER');

  // Sole OWNER cannot self-demote (admin endpoint: 400, existing message).
  const selfDemote = await req(`/api/admin/users/${ownerAId}/role`, { method: 'PATCH', cookie: ownerACookie, body: { role: 'ADMIN' } });
  assert.equal(selfDemote.status, 400, JSON.stringify(selfDemote.json));
  assert.match(String(selfDemote.json.error || ''), /cannot demote your own/i);
  // Same through the Admin Panel endpoint: also refused, 400.
  const selfDemoteSys = await req(`/api/users/${ownerAId}`, { method: 'PATCH', cookie: ownerACookie, body: { role: 'ADMIN' } });
  assert.equal(selfDemoteSys.status, 400, JSON.stringify(selfDemoteSys.json));
  // Sole OWNER cannot self-delete (400).
  const selfDelete = await req(`/api/admin/users/${ownerAId}`, { method: 'DELETE', cookie: ownerACookie });
  assert.equal(selfDelete.status, 400, JSON.stringify(selfDelete.json));
  // An ADMIN cannot delete the sole OWNER (403).
  const adminDelete = await req(`/api/admin/users/${ownerAId}`, { method: 'DELETE', cookie: adminCookie });
  assert.equal(adminDelete.status, 403, JSON.stringify(adminDelete.json));

  // Invariant: exactly one OWNER remains, and it is OWNER A.
  owners = (await listUsers(ownerACookie)).filter((u) => u.role === 'OWNER');
  assert.equal(owners.length, 1, 'an OWNER always remains');
  assert.equal(owners[0].email, 'kingaamir022@gmail.com');
  const stillOwner = await me(ownerACookie);
  assert.equal(stillOwner.role, 'OWNER');
});

test('Multi-Owner: last-OWNER guard strings exist in both role routes', async () => {
  const adminSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
  assert.ok(adminSrc.includes('Cannot demote the last OWNER.'), 'admin.js demote guard');
  assert.ok(adminSrc.includes('Cannot delete the last OWNER.'), 'admin.js delete guard');
  const systemSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'system.js'), 'utf8');
  assert.ok(systemSrc.includes('Cannot demote the last OWNER.'), 'system.js demote guard');
  // system.js has no delete endpoint (user delete lives only in admin.js),
  // so no delete guard is expected there.
});

// --- Login errors + health + client message ----------------------------------

test('Multi-Owner: wrong-password login is 401 with the exact server message', async () => {
  const bad = await login('kingaamir022@gmail.com', 'wrongpassword');
  assert.equal(bad.status, 401, JSON.stringify(bad.json));
  assert.equal(bad.json.error, 'Email or password is incorrect.');
});

test('Multi-Owner: health reports version 2.7.0, phase 13', async () => {
  const h = await req('/api/health');
  assert.equal(h.status, 200, JSON.stringify(h.json));
  assert.equal(h.json.version, '2.7.0');
  assert.equal(h.json.phase, 13);
});

test('Multi-Owner: app.js maps an unreachable server to the friendly message', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const msg = 'Server se connect nahi ho raha — Start.bat chal raha hai? Page refresh karke dobara koshish karein.';
  assert.ok(src.includes(msg), 'SERVER_UNREACHABLE_MSG string is in app.js');
  assert.ok(src.includes('SERVER_UNREACHABLE_MSG'), 'the shared constant is used');
  assert.ok(/instanceof TypeError/.test(src), 'the fetch catch maps TypeError');
  assert.ok(!src.includes('Failed to fetch'), "the bare browser message must not appear in app.js");
});
