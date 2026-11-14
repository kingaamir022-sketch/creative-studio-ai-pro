'use strict';
// Phase 1 API tests — run with: npm test
// Spawns the real server on a scratch port with a temp DB/uploads dir and
// exercises the important workflows end to end over HTTP.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4831;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let ownerCookie = '';
let userCookie = '';

function req(path, { method = 'GET', body, cookie, form } = {}) {
  // No keep-alive reuse: after a long idle gap (a render) the server
  // may have closed the connection and the next fetch gets EPIPE.
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
      return { status: r.status, json, text, setCookie: r.headers.get('set-cookie') || '' };
    });
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, HOST: '127.0.0.1' },
    stdio: 'pipe',
  });
  // Wait for the server to answer.
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start in time');
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => {
  if (server) server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('health endpoint is up', async () => {
  const r = await req('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.phase, 14);
  assert.equal(r.json.version, '2.7.1');
});

test('unauthenticated API calls are rejected', async () => {
  const r = await req('/api/dashboard');
  assert.equal(r.status, 401);
});

test('first signup becomes OWNER; second becomes USER', async () => {
  const a = await req('/api/auth/signup', { method: 'POST', body: { name: 'Owner One', email: 'owner@test.local', password: 'password123' } });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.equal(a.json.user.role, 'OWNER');
  assert.equal(a.json.firstAccount, true);
  ownerCookie = a.setCookie.split(';')[0];

  const b = await req('/api/auth/signup', { method: 'POST', body: { name: 'User Two', email: 'user@test.local', password: 'password123' } });
  assert.equal(b.status, 201);
  assert.equal(b.json.user.role, 'USER');
  assert.equal(b.json.firstAccount, false);
  userCookie = b.setCookie.split(';')[0];
});

test('signup validation rejects bad input', async () => {
  const short = await req('/api/auth/signup', { method: 'POST', body: { name: 'X', email: 'x@test.local', password: 'short' } });
  assert.equal(short.status, 400);
  const badEmail = await req('/api/auth/signup', { method: 'POST', body: { name: 'X', email: 'not-an-email', password: 'password123' } });
  assert.equal(badEmail.status, 400);
  const dup = await req('/api/auth/signup', { method: 'POST', body: { name: 'X', email: 'owner@test.local', password: 'password123' } });
  assert.equal(dup.status, 409);
});

test('login rejects wrong password, accepts correct one', async () => {
  const bad = await req('/api/auth/login', { method: 'POST', body: { email: 'owner@test.local', password: 'wrongpass' } });
  assert.equal(bad.status, 401);
  const good = await req('/api/auth/login', { method: 'POST', body: { email: 'owner@test.local', password: 'password123' } });
  assert.equal(good.status, 200);
  assert.equal(good.json.user.email, 'owner@test.local');
  ownerCookie = good.setCookie.split(';')[0];
});

test('dashboard returns real counts and FFmpeg status', async () => {
  const r = await req('/api/dashboard', { cookie: ownerCookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.counts.projects, 0);
  assert.equal(r.json.counts.media, 0);
  assert.equal(r.json.counts.jobs, 0);
  assert.equal(r.json.plan, 'Lifetime');
  assert.equal(r.json.creditsBalance, 0, 'OWNER on Lifetime has no finite balance');
  assert.ok(r.json.system);
  assert.equal(typeof r.json.system.ffmpeg.available, 'boolean');
});

let projectId;
test('project CRUD: create, autosave, version, duplicate, trash, restore, delete', async () => {
  const created = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'Test Design', type: 'design', content: { title: 'Test Design', elements: [] } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  projectId = created.json.project.id;

  const bad = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: '', type: 'design' } });
  assert.equal(bad.status, 400);

  const saved = await req(`/api/projects/${projectId}`, { method: 'PATCH', cookie: ownerCookie, body: { content: { title: 'Test Design', elements: [{ type: 'text', text: 'Hello' }] }, saveVersion: true } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.project.content.elements.length, 1);

  const versions = await req(`/api/projects/${projectId}/versions`, { cookie: ownerCookie });
  assert.equal(versions.status, 200);
  assert.ok(versions.json.versions.length >= 1);

  const restored = await req(`/api/projects/${projectId}/versions/${versions.json.versions[0].id}/restore`, { method: 'POST', cookie: ownerCookie });
  assert.equal(restored.status, 200);

  const dup = await req(`/api/projects/${projectId}/duplicate`, { method: 'POST', cookie: ownerCookie });
  assert.equal(dup.status, 201);
  assert.equal(dup.json.project.name, 'Test Design (copy)');

  const trashed = await req(`/api/projects/${projectId}/trash`, { method: 'POST', cookie: ownerCookie });
  assert.equal(trashed.status, 200);
  assert.equal(trashed.json.project.trashed, true);

  const list = await req('/api/projects', { cookie: ownerCookie });
  assert.ok(!list.json.projects.some((p) => p.id === projectId));

  const restoredP = await req(`/api/projects/${projectId}/restore`, { method: 'POST', cookie: ownerCookie });
  assert.equal(restoredP.status, 200);

  // Permanent delete requires trash first.
  const tooSoon = await req(`/api/projects/${projectId}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(tooSoon.status, 400);
  await req(`/api/projects/${projectId}/trash`, { method: 'POST', cookie: ownerCookie });
  const gone = await req(`/api/projects/${projectId}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(gone.status, 200);
  const missing = await req(`/api/projects/${projectId}`, { cookie: ownerCookie });
  assert.equal(missing.status, 404);
});

test('projects are isolated per user', async () => {
  const mine = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'Owner Only', type: 'video' } });
  assert.equal(mine.status, 201);
  const other = await req(`/api/projects/${mine.json.project.id}`, { cookie: userCookie });
  assert.equal(other.status, 404);
  await req(`/api/projects/${mine.json.project.id}/trash`, { method: 'POST', cookie: ownerCookie });
  await req(`/api/projects/${mine.json.project.id}`, { method: 'DELETE', cookie: ownerCookie });
});

test('project folders: create and delete', async () => {
  const f = await req('/api/projects/folders', { method: 'POST', cookie: ownerCookie, body: { name: 'Client work' } });
  assert.equal(f.status, 201);
  const list = await req('/api/projects/folders/list', { cookie: ownerCookie });
  assert.ok(list.json.folders.some((x) => x.name === 'Client work'));
  const del = await req(`/api/projects/folders/${f.json.folder.id}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 200);
});

let mediaId;
test('media upload: real file on disk, search, favorite, tags, delete', async () => {
  // 1x1 transparent PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const up = await req('/api/media/upload', { method: 'POST', cookie: ownerCookie, form });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  mediaId = up.json.media.id;
  assert.equal(up.json.media.kind, 'image');
  assert.equal(up.json.media.sizeBytes, png.length);
  const userDir = path.join(uploadsDir, '1');
  assert.ok(fs.existsSync(userDir), 'uploads dir for user exists');
  assert.equal(fs.readdirSync(userDir).length, 1, 'exactly one file stored on disk');

  const file = await req(`/api/media/${mediaId}/file`, { cookie: ownerCookie });
  assert.equal(file.status, 200);

  const search = await req('/api/media?search=pixel', { cookie: ownerCookie });
  assert.equal(search.json.media.length, 1);

  const fav = await req(`/api/media/${mediaId}`, { method: 'PATCH', cookie: ownerCookie, body: { favorite: true, tags: 'test, pixel' } });
  assert.equal(fav.status, 200);
  assert.equal(fav.json.media.favorite, true);
  assert.equal(fav.json.media.tags, 'test, pixel');

  const favList = await req('/api/media?favorite=1', { cookie: ownerCookie });
  assert.equal(favList.json.media.length, 1);

  const del = await req(`/api/media/${mediaId}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 200);
  const gone = await req(`/api/media/${mediaId}/file`, { cookie: ownerCookie });
  assert.equal(gone.status, 404);
  assert.equal(fs.readdirSync(path.join(uploadsDir, '1')).length, 0, 'stored file removed from disk');
});

test('media upload rejects unsupported types', async () => {
  const form = new FormData();
  form.append('file', new Blob(['MZ fake exe'], { type: 'application/x-msdownload' }), 'evil.exe');
  const r = await req('/api/media/upload', { method: 'POST', cookie: ownerCookie, form });
  assert.equal(r.status, 400);
});

test('providers report key_needed honestly and accept an encrypted key', async () => {
  const before = await req('/api/providers', { cookie: ownerCookie });
  assert.equal(before.status, 200);
  const llm = before.json.providers.find((p) => p.id === 'llm');
  assert.equal(llm.status, 'key_needed');
  assert.ok(!JSON.stringify(before.json).includes('sk-'), 'no key material leaks in status');

  // Regular USER cannot manage provider keys.
  const denied = await req('/api/providers/llm/key', { method: 'POST', cookie: userCookie, body: { key: 'sk-test-12345678' } });
  assert.equal(denied.status, 403);

  const saved = await req('/api/providers/llm/key', { method: 'POST', cookie: ownerCookie, body: { key: 'sk-test-12345678' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.provider.configured, true);
  assert.equal(saved.json.provider.source, 'stored (encrypted)');

  const after = await req('/api/providers', { cookie: ownerCookie });
  const llmAfter = after.json.providers.find((p) => p.id === 'llm');
  assert.equal(llmAfter.configured, true);
  assert.ok(!JSON.stringify(after.json).includes('sk-test-12345678'), 'stored key is never returned');

  const removed = await req('/api/providers/llm/key', { method: 'DELETE', cookie: ownerCookie });
  assert.equal(removed.status, 200);
});

test('subscription shows plans, usage log starts empty', async () => {
  const r = await req('/api/subscription', { cookie: ownerCookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.currentPlan, 'Lifetime');
  assert.equal(r.json.plans.length, 6);
  assert.deepEqual(r.json.usage, []);
  assert.ok(r.json.plans.find((p) => p.name === 'Enterprise'));
  assert.ok(r.json.plans.find((p) => p.name === 'Lifetime' && p.price === 0 && p.credits === null));
});

test('notifications reflect real audit activity', async () => {
  const r = await req('/api/notifications', { cookie: ownerCookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.notifications.length > 0);
  assert.ok(r.json.notifications.some((n) => n.action === 'signup'));
});

test('admin user list is OWNER/ADMIN only', async () => {
  const denied = await req('/api/users', { cookie: userCookie });
  assert.equal(denied.status, 403);
  const ok = await req('/api/users', { cookie: ownerCookie });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.users.length, 2);
});

test('change password works and old password stops working', async () => {
  const bad = await req('/api/auth/change-password', { method: 'POST', cookie: userCookie, body: { currentPassword: 'wrong', newPassword: 'newpassword123' } });
  assert.equal(bad.status, 400);
  const good = await req('/api/auth/change-password', { method: 'POST', cookie: userCookie, body: { currentPassword: 'password123', newPassword: 'newpassword123' } });
  assert.equal(good.status, 200);
  const oldLogin = await req('/api/auth/login', { method: 'POST', body: { email: 'user@test.local', password: 'password123' } });
  assert.equal(oldLogin.status, 401);
  const newLogin = await req('/api/auth/login', { method: 'POST', body: { email: 'user@test.local', password: 'newpassword123' } });
  assert.equal(newLogin.status, 200);
});

test('logout invalidates the session', async () => {
  const out = await req('/api/auth/logout', { method: 'POST', cookie: userCookie });
  assert.equal(out.status, 200);
  const after = await req('/api/dashboard', { cookie: userCookie });
  assert.equal(after.status, 401);
});
