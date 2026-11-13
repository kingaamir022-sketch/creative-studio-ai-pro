'use strict';
// Social & business tools tests (Phase 8) — run with: npm test
// Spawns the real server on a scratch port (4839) with a temp DB/uploads
// dir, PLUS a local MOCK server (random port) that speaks the real shapes
// of the Facebook Graph API, X API v2, OpenAI Chat, and the Google OAuth /
// Drive / Sheets APIs. No real platform, provider or Google call ever
// happens. Covers: social post CRUD + per-platform char limits + calendar,
// publish refusal when unconnected, publish via mock platform + scheduler,
// mark-manual, AI caption (no-key refusal, then real charge via mock LLM),
// local caption + hashtags, credit ledger (charge, history, zero-balance
// block), bulk start credit gate, Google Sheets import with dedupe, plan
// requests + OWNER approval, admin RBAC + suspend/unsuspend, marketplace
// publish/install/rate round-trip, analytics numbers matching seeded rows.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-social-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4839;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let mockServer;
let mockPort;
let ownerCookie = '';
let userCookie = '';
let ownerId = 0;
let userId = 0;
let testImage;

function req(path, { method = 'GET', body, cookie, form } = {}) {
  // Default to the owner session; pass cookie: null for unauthenticated.
  if (cookie === undefined) cookie = ownerCookie;
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

// Format a Date as a LOCAL 'YYYY-MM-DD HH:MM:SS' wall-clock string — the
// format the browser's datetime-local input sends and the API parses as
// local time. (Sending a UTC ISO string instead shifts the stored time by
// the server timezone offset, which moved early-morning posts onto the
// previous UTC day and broke the calendar assertion.)
function localDbDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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

// --- Local mock server: Facebook, X, OpenAI Chat, Google -------------------
function mockHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  let body = Buffer.alloc(0);
  req.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body.toString('utf8')); } catch { json = null; }

    // Facebook Graph API: POST /me/feed
    if (req.method === 'POST' && p === '/me/feed') {
      if (!json || !json.message) return sendJson(400, { error: { message: 'message required' } });
      return sendJson(200, { id: 'fb_post_123' });
    }
    // X API v2: POST /tweets
    if (req.method === 'POST' && p === '/tweets') {
      if (!json || !json.text) return sendJson(400, { error: 'text required' });
      return sendJson(201, { data: { id: 'tw_456', text: json.text } });
    }
    // OpenAI Chat (LLM): caption requests get a real caption JSON.
    if (req.method === 'POST' && p === '/chat/completions') {
      const text = json && json.messages ? json.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n') : '';
      if (text.toLowerCase().includes('caption')) {
        return sendJson(200, { choices: [{ message: { content: JSON.stringify({ caption: 'Mock caption: fresh quiz night is here!', hashtags: ['#quiz', '#mock'] }) } }] });
      }
      return sendJson(200, { choices: [{ message: { content: '{"ok":true}' } }] });
    }
    // Google OAuth token exchange / refresh.
    if (req.method === 'POST' && p === '/token') {
      return sendJson(200, { access_token: 'g_access_token', refresh_token: 'g_refresh_token', expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/spreadsheets.readonly' });
    }
    // Google Drive: list spreadsheets.
    if (req.method === 'GET' && p === '/drive/v3/files') {
      return sendJson(200, { files: [
        { id: 'sheet1', name: 'Quiz Sheet', modifiedTime: '2026-11-12T00:00:00Z' },
        { id: 'sheet2', name: 'Products', modifiedTime: '2026-11-11T00:00:00Z' },
      ] });
    }
    // Google Sheets: spreadsheet metadata (tabs).
    if (req.method === 'GET' && p === '/sheets/v4/spreadsheets/sheet1') {
      return sendJson(200, { sheets: [{ properties: { title: 'Questions' } }, { properties: { title: 'Answers' } }] });
    }
    // Google Sheets: values (3 data rows, one exact duplicate).
    if (req.method === 'GET' && p === '/sheets/v4/spreadsheets/sheet1/values/Questions') {
      return sendJson(200, { values: [
        ['QUESTION', 'OPTION_A', 'OPTION_B', 'CORRECT'],
        ['What is 2+2?', '3', '4', 'B'],
        ['What is 2+2?', '3', '4', 'B'],
        ['Capital of France?', 'London', 'Paris', 'B'],
      ] });
    }
    return sendJson(404, { error: `mock: no route ${req.method} ${p}` });
  });
}

async function getBalance(cookie) {
  const r = await req('/api/billing/balance', { cookie: cookie || ownerCookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

async function resetCredits(userId, amount, cookie) {
  const r = await req(`/api/admin/users/${userId}/reset-credits`, { method: 'POST', cookie: cookie || ownerCookie, body: { credits: amount } });
  assert.equal(r.status, 200, `reset credits: ${JSON.stringify(r.json)}`);
  return r.json;
}

async function createQuizBulkJob(name, cookie) {
  const r = await req('/api/bulk', { method: 'POST', cookie: cookie || ownerCookie, body: { name, kind: 'video', templateProjectId: 'quiz', settings: {} } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.job;
}

before(async () => {
  testImage = path.join(tmp, 'test.png');
  makeTestImage(testImage, 'blue');

  mockServer = http.createServer(mockHandler);
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;
  const mockBase = `http://127.0.0.1:${mockPort}`;

  const env = {
    ...process.env,
    DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir,
    PORT: String(PORT), HOST: '127.0.0.1',
    GOOGLE_API_BASE: mockBase, GOOGLE_OAUTH_BASE: mockBase, GOOGLE_AUTH_BASE: mockBase,
    SOCIAL_SCHEDULER_INTERVAL_MS: '600000',
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

  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'Social Tester', email: 'social@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  assert.equal(s.json.user.role, 'OWNER');
  ownerCookie = s.setCookie.split(';')[0];
  ownerId = s.json.user.id;

  const u = await req('/api/auth/signup', { method: 'POST', body: { name: 'Regular User', email: 'regular@test.local', password: 'password123' } });
  assert.equal(u.status, 201, JSON.stringify(u.json));
  userCookie = u.setCookie.split(';')[0];
  userId = u.json.user.id;

  await uploadMedia(testImage, 'social.png', 'image/png');
});

after(async () => {
  if (server) server.kill('SIGKILL');
  if (mockServer) await new Promise((r) => mockServer.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ---------------- Health / version ---------------- */
test('Health reports v2.2.1 phase 9', async () => {
  const r = await req('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.version, '2.2.1');
  assert.equal(r.json.phase, 9);
});

/* ---------------- Social post CRUD + limits ---------------- */
let draftPostId;
let mediaId;

test('Social: platforms list shows real limits and no connections', async () => {
  const r = await req('/api/social/platforms');
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.json.platforms.map((p) => [p.id, p]));
  assert.equal(byId.x.charLimit, 280);
  assert.equal(byId.facebook.charLimit, 63206);
  assert.equal(byId.instagram.charLimit, 2200);
  assert.equal(byId.tiktok.videoOnly, true);
  assert.equal(byId.youtube.videoOnly, true);
  assert.ok(r.json.platforms.every((p) => p.connected === false), 'fresh install: nothing connected');
});

test('Social: create draft, enforce X char limit, edit, list, calendar', async () => {
  const media = await req('/api/media?limit=100');
  mediaId = media.json.media[0].id;
  const tooLong = await req('/api/social/posts', { method: 'POST', body: { platform: 'x', text: 'a'.repeat(281) } });
  assert.equal(tooLong.status, 400, '281 chars on X must be refused');
  assert.match(tooLong.json.error, /280/);

  const created = await req('/api/social/posts', { method: 'POST', body: { platform: 'x', title: '', text: 'Hello from the test suite #quiz', mediaIds: [mediaId] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.post.status, 'draft');
  assert.deepEqual(created.json.post.mediaIds, [mediaId]);
  draftPostId = created.json.post.id;

  const edited = await req(`/api/social/posts/${draftPostId}`, { method: 'PATCH', body: { text: 'Edited post text' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.post.text, 'Edited post text');

  const list = await req('/api/social/posts?status=draft');
  assert.equal(list.status, 200);
  assert.ok(list.json.posts.some((p) => p.id === draftPostId));

  const month = new Date().toISOString().slice(0, 7);
  const cal = await req(`/api/social/calendar?month=${month}`);
  assert.equal(cal.status, 200);
  assert.equal(cal.json.month, month);
});

test('Social: publish refuses when the platform is not connected', async () => {
  const r = await req(`/api/social/posts/${draftPostId}/publish`, { method: 'POST' });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.code, 'NOT_CONNECTED');
  const fresh = await req(`/api/social/posts/${draftPostId}`);
  assert.equal(fresh.json.post.status, 'draft', 'failed publish must not change the status');
});

/* ---------------- Connect mock platforms + scheduler publish ---------------- */
let fbPostId;
let xPostId;

test('Social: connect mock Facebook + X, schedule past-due posts, scheduler publishes them', async () => {
  const mockBase = `http://127.0.0.1:${mockPort}`;
  const fb = await req('/api/social/connections', { method: 'POST', body: { platform: 'facebook', accountName: 'Test Page', accessToken: 'fb-token-12345', baseUrl: mockBase } });
  assert.equal(fb.status, 201, JSON.stringify(fb.json));
  assert.ok(!('accessToken' in fb.json.connection) && !JSON.stringify(fb.json).includes('fb-token-12345'), 'token must never be returned');
  const x = await req('/api/social/connections', { method: 'POST', body: { platform: 'x', accountName: 'Test X', accessToken: 'x-token-12345', baseUrl: mockBase } });
  assert.equal(x.status, 201, JSON.stringify(x.json));

  const past = localDbDate(new Date(Date.now() - 60000));
  const p1 = await req('/api/social/posts', { method: 'POST', body: { platform: 'facebook', text: 'Scheduled Facebook post', status: 'scheduled', scheduledAt: past } });
  assert.equal(p1.status, 201, JSON.stringify(p1.json));
  fbPostId = p1.json.post.id;
  const p2 = await req('/api/social/posts', { method: 'POST', body: { platform: 'x', text: 'Scheduled X post', status: 'scheduled', scheduledAt: past } });
  assert.equal(p2.status, 201, JSON.stringify(p2.json));
  xPostId = p2.json.post.id;

  const run = await req('/api/social/scheduler/run', { method: 'POST' });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  assert.equal(run.json.processed, 2);

  const f1 = await req(`/api/social/posts/${fbPostId}`);
  assert.equal(f1.json.post.status, 'published');
  assert.equal(f1.json.post.providerPostId, 'fb_post_123');
  const f2 = await req(`/api/social/posts/${xPostId}`);
  assert.equal(f2.json.post.status, 'published');
  assert.equal(f2.json.post.providerPostId, 'tw_456');

  // The published posts appear on the calendar.
  const month = new Date().toISOString().slice(0, 7);
  const cal = await req(`/api/social/calendar?month=${month}`);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok((cal.json.byDay[today] || []).some((p) => p.id === fbPostId), 'published post on calendar');
});

test('Social: due post on an unconnected platform fails honestly via the scheduler', async () => {
  const past = localDbDate(new Date(Date.now() - 60000));
  const p = await req('/api/social/posts', { method: 'POST', body: { platform: 'linkedin', text: 'LinkedIn is not connected', status: 'scheduled', scheduledAt: past } });
  assert.equal(p.status, 201, JSON.stringify(p.json));
  const run = await req('/api/social/scheduler/run', { method: 'POST' });
  assert.equal(run.status, 200);
  const fresh = await req(`/api/social/posts/${p.json.post.id}`);
  assert.equal(fresh.json.post.status, 'failed');
  assert.match(fresh.json.post.error, /not connected/i);
});

test('Social: mark posted manually records note + link, never a fake API publish', async () => {
  const r = await req(`/api/social/posts/${draftPostId}/mark-manual`, { method: 'POST', body: { note: 'Posted from the Facebook app', url: 'https://facebook.com/posts/999' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.post.status, 'manual');
  assert.equal(r.json.post.manualUrl, 'https://facebook.com/posts/999');
  assert.equal(r.json.post.providerPostId, null, 'manual posts have no provider id');
});

/* ---------------- AI caption / local caption / hashtags ---------------- */
test('Social: AI caption refuses without an LLM key; local caption + hashtags work', async () => {
  const noKey = await req('/api/social/caption', { method: 'POST', body: { text: 'quiz night', platform: 'facebook' } });
  assert.equal(noKey.status, 402, JSON.stringify(noKey.json));
  assert.equal(noKey.json.code, 'PROVIDER_KEY_NEEDED');

  const local = await req('/api/social/caption-local', { method: 'POST', body: { text: 'quiz night' } });
  assert.equal(local.status, 200);
  assert.equal(local.json.source, 'local-template');
  assert.ok(local.json.captions.length >= 3);
  assert.ok(local.json.note.toLowerCase().includes('not ai'));

  const tags = await req('/api/social/hashtags', { method: 'POST', body: { text: 'Fresh quiz night with tricky questions and big prizes' } });
  assert.equal(tags.status, 200);
  assert.ok(tags.json.hashtags.includes('#quiz'));
  assert.ok(tags.json.hashtags.every((t) => t.startsWith('#')));
});

test('Social: AI caption via mock LLM works and charges exactly 1 credit', async () => {
  // v2.2.0: billing tests run as the regular USER — the OWNER is unlimited
  // (Lifetime) and is never charged, so the owner cannot prove charging.
  const mockBase = `http://127.0.0.1:${mockPort}`;
  const cfg = await req('/api/providers/llm/config', { method: 'POST', body: { baseUrl: mockBase } });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.json));
  const key = await req('/api/providers/llm/key', { method: 'POST', body: { key: 'mock-test-key-12345' } });
  assert.equal(key.status, 200, JSON.stringify(key.json));

  const beforeBal = await getBalance(userCookie);
  const r = await req('/api/social/caption', { method: 'POST', cookie: userCookie, body: { text: 'quiz night caption', platform: 'facebook' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.source, 'llm');
  assert.match(r.json.caption, /Mock caption/);
  assert.deepEqual(r.json.hashtags, ['#quiz', '#mock']);
  assert.equal(r.json.charged, 1);
  const afterBal = await getBalance(userCookie);
  assert.equal(afterBal.creditsBalance, beforeBal.creditsBalance - 1, 'exactly 1 credit deducted');
  const hist = await req('/api/billing/history?limit=5', { cookie: userCookie });
  assert.equal(hist.status, 200);
  assert.ok(hist.json.history.some((h) => h.action === 'social_caption' && h.credits === -1), 'ledger shows the -1 charge');
});

/* ---------------- Credit ledger: zero balance blocks ---------------- */
test('Billing: zero balance blocks a generation with a clear message', async () => {
  await resetCredits(userId, 0);
  const bal = await getBalance(userCookie);
  assert.equal(bal.creditsBalance, 0);
  const r = await req('/api/social/caption', { method: 'POST', cookie: userCookie, body: { text: 'blocked caption', platform: 'facebook' } });
  assert.equal(r.status, 402, JSON.stringify(r.json));
  assert.equal(r.json.code, 'INSUFFICIENT_CREDITS');
  assert.match(r.json.error, /Not enough credits/);
  await resetCredits(userId, 100);
  const restored = await getBalance(userCookie);
  assert.equal(restored.creditsBalance, 100);
});

test('Billing: bulk start is refused up front when the batch costs more than the balance', async () => {
  const job = await createQuizBulkJob('Credit Gate Batch', userCookie);
  const csv = 'QUESTION,OPTION_A,OPTION_B,OPTION_C,OPTION_D,CORRECT\nWhat is 2+2?,3,4,5,6,B\nCapital of France?,London,Paris,Rome,Madrid,B';
  const up = await req(`/api/bulk/${job.id}/dataset`, { method: 'POST', cookie: userCookie, body: { text: csv } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.dedupeSummary.unique, 2);
  await resetCredits(userId, 1);
  const start = await req(`/api/bulk/${job.id}/start`, { method: 'POST', cookie: userCookie });
  assert.equal(start.status, 402, JSON.stringify(start.json));
  assert.equal(start.json.code, 'INSUFFICIENT_CREDITS');
  assert.match(start.json.error, /2 rows/);
  await resetCredits(userId, 100);
});

/* ---------------- Google Sheets import ---------------- */
test('Google: OAuth config + callback + sheets import with dedupe', async () => {
  const cfg = await req('/api/integrations/google/config', { method: 'POST', body: { clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'test-secret-12345', redirectUri: `http://127.0.0.1:${PORT}/api/integrations/google/callback` } });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.json));
  assert.equal(cfg.json.configured, true);

  const st0 = await req('/api/integrations/google/status');
  assert.equal(st0.json.configured, true);
  assert.equal(st0.json.connected, false);

  const authUrl = await req('/api/integrations/google/auth-url');
  assert.equal(authUrl.status, 200);
  assert.ok(authUrl.json.url.includes('test-client.apps.googleusercontent.com'));
  assert.ok(authUrl.json.url.includes('spreadsheets.readonly'));

  // Simulate Google redirecting back with a code (mock token endpoint).
  const cb = await req(`/api/integrations/google/callback?code=test-code-123&state=${ownerId}.randomstate`);
  assert.equal(cb.status, 302, JSON.stringify(cb.json));
  assert.ok(cb.headers.get('location').includes('google=connected'));

  const st1 = await req('/api/integrations/google/status');
  assert.equal(st1.json.connected, true);

  const sheets = await req('/api/integrations/google/spreadsheets');
  assert.equal(sheets.status, 200);
  assert.equal(sheets.json.spreadsheets[0].id, 'sheet1');
  assert.equal(sheets.json.spreadsheets[0].name, 'Quiz Sheet');

  const tabs = await req('/api/integrations/google/spreadsheets/sheet1/tabs');
  assert.equal(tabs.status, 200);
  assert.deepEqual(tabs.json.tabs, ['Questions', 'Answers']);

  const job = await createQuizBulkJob('Google Sheet Batch');
  const imp = await req('/api/integrations/google/import', { method: 'POST', body: { spreadsheetId: 'sheet1', tab: 'Questions', bulkJobId: job.id } });
  assert.equal(imp.status, 200, JSON.stringify(imp.json));
  assert.deepEqual(imp.json.dataset.columns, ['QUESTION', 'OPTION_A', 'OPTION_B', 'CORRECT']);
  assert.equal(imp.json.dataset.totalRows, 3);
  assert.equal(imp.json.dedupeSummary.unique, 2, '3 sheet rows, 1 duplicate -> 2 unique');
  assert.equal(imp.json.dedupeSummary.skipped, 1);
  assert.equal(imp.json.rows.filter((r) => r.status === 'skipped').length, 1);
});

/* ---------------- Plan requests ---------------- */
test('Billing: plan request -> OWNER approval changes plan and tops up credits', async () => {
  const plans = await req('/api/billing/plans', { cookie: userCookie });
  assert.equal(plans.status, 200);
  assert.ok(plans.json.plans.some((p) => p.id === 'Pro' && p.credits === 5000));
  assert.match(plans.json.paymentNote, /No payment is taken/);

  const reqPro = await req('/api/billing/requests', { method: 'POST', cookie: userCookie, body: { plan: 'Pro' } });
  assert.equal(reqPro.status, 201, JSON.stringify(reqPro.json));
  assert.equal(reqPro.json.request.status, 'pending');
  const reqId = reqPro.json.request.id;

  const dup = await req('/api/billing/requests', { method: 'POST', cookie: userCookie, body: { plan: 'Pro' } });
  assert.equal(dup.status, 400, 'duplicate pending request refused');

  const list = await req('/api/billing/admin/requests?status=pending');
  assert.equal(list.status, 200);
  assert.ok(list.json.requests.some((r) => r.id === reqId));

  const approve = await req(`/api/billing/admin/requests/${reqId}/approve`, { method: 'POST' });
  assert.equal(approve.status, 200, JSON.stringify(approve.json));
  assert.equal(approve.json.user.plan, 'Pro');
  assert.equal(approve.json.user.creditsBalance, 5000);

  const me = await req('/api/auth/me', { cookie: userCookie });
  assert.equal(me.json.user.plan, 'Pro');
  assert.equal(me.json.user.creditsBalance, 5000);

  const again = await req('/api/billing/requests', { method: 'POST', cookie: userCookie, body: { plan: 'Pro' } });
  assert.equal(again.status, 400, 'already on Pro');
});

/* ---------------- Admin RBAC + suspend ---------------- */
test('Admin: regular user gets 403; OWNER suspends, login dies, unsuspend restores', async () => {
  const forbidden = await req('/api/admin/stats', { cookie: userCookie });
  assert.equal(forbidden.status, 403, JSON.stringify(forbidden.json));
  const forbidden2 = await req('/api/admin/users', { cookie: userCookie });
  assert.equal(forbidden2.status, 403);

  const stats = await req('/api/admin/stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.json.stats.users >= 2);
  assert.ok(stats.json.stats.socialPosts >= 3);

  const users = await req('/api/admin/users');
  assert.equal(users.status, 200);
  const regular = users.json.users.find((u) => u.email === 'regular@test.local');
  assert.ok(regular, 'regular user listed');

  const suspend = await req(`/api/admin/users/${regular.id}/suspend`, { method: 'POST' });
  assert.equal(suspend.status, 200, JSON.stringify(suspend.json));
  assert.equal(suspend.json.user.suspended, true);

  // Old session is dead immediately.
  const meDead = await req('/api/auth/me', { cookie: userCookie });
  assert.equal(meDead.status, 401);
  // Login is refused while suspended.
  const loginDead = await req('/api/auth/login', { method: 'POST', body: { email: 'regular@test.local', password: 'password123' } });
  assert.equal(loginDead.status, 403);
  assert.match(loginDead.json.error, /suspended/i);

  const unsuspend = await req(`/api/admin/users/${regular.id}/unsuspend`, { method: 'POST' });
  assert.equal(unsuspend.status, 200);
  const loginOk = await req('/api/auth/login', { method: 'POST', body: { email: 'regular@test.local', password: 'password123' } });
  assert.equal(loginOk.status, 200, JSON.stringify(loginOk.json));
  userCookie = loginOk.setCookie.split(';')[0];

  const audit = await req('/api/admin/audit?limit=50');
  assert.equal(audit.status, 200);
  assert.ok(audit.json.entries.some((e) => e.action === 'admin_suspend'));
  assert.ok(audit.json.entries.some((e) => e.action === 'admin_unsuspend'));

  const health = await req('/api/admin/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.health.ffmpeg.ok, true);
  assert.ok(health.json.health.db.bytes > 0);
});

/* ---------------- Marketplace ---------------- */
let templateId;

test('Marketplace: publish, browse, install a real editable copy, rate', async () => {
  const design = await req('/api/projects', { method: 'POST', body: { name: 'Sale Poster', type: 'design', content: { version: 1, width: 1080, height: 1080, layers: [{ id: 'l1', type: 'text', text: 'SALE' }] } } });
  assert.equal(design.status, 201, JSON.stringify(design.json));
  const projectId = design.json.project.id;

  const pub = await req('/api/marketplace', { method: 'POST', body: { name: 'Sale Poster Template', description: 'Bold sale poster', kind: 'design', tags: ['sale', 'poster'], sourceProjectId: projectId } });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  templateId = pub.json.template.id;

  const browse = await req('/api/marketplace?q=sale');
  assert.equal(browse.status, 200);
  assert.ok(browse.json.templates.some((t) => t.id === templateId));
  assert.match(browse.json.note, /in-app marketplace/);

  const install = await req(`/api/marketplace/${templateId}/install`, { method: 'POST', cookie: userCookie });
  assert.equal(install.status, 201, JSON.stringify(install.json));
  assert.equal(install.json.installed.type, 'project');
  const copy = await req(`/api/projects/${install.json.installed.id}`, { cookie: userCookie });
  assert.equal(copy.status, 200, JSON.stringify(copy.json));
  assert.equal(copy.json.project.type, 'design');
  assert.ok(JSON.stringify(copy.json.project.content).includes('SALE'), 'installed copy is a real editable project, not a flat image');

  const rate = await req(`/api/marketplace/${templateId}/rate`, { method: 'POST', cookie: userCookie, body: { rating: 5 } });
  assert.equal(rate.status, 200, JSON.stringify(rate.json));
  assert.equal(rate.json.template.avgRating, 5);
  assert.equal(rate.json.template.ratingCount, 1);

  const report = await req(`/api/marketplace/${templateId}/report`, { method: 'POST', cookie: userCookie, body: { reason: 'test report' } });
  assert.equal(report.status, 200);

  const badRate = await req(`/api/marketplace/${templateId}/rate`, { method: 'POST', cookie: userCookie, body: { rating: 9 } });
  assert.equal(badRate.status, 400);
});

/* ---------------- Analytics ---------------- */
test('Analytics: numbers match the rows this suite created', async () => {
  const a = await req('/api/analytics?days=30');
  assert.equal(a.status, 200, JSON.stringify(a.json));
  const j = a.json;
  assert.ok(j.totals.socialPosts >= 4, `socialPosts ${j.totals.socialPosts}`);
  assert.ok(j.totals.marketplaceTemplates >= 1);
  const pub = j.postsByStatus.find((r) => r.status === 'published');
  assert.ok(pub && pub.count >= 2, 'two scheduler-published posts counted');
  const fb = j.postsByPlatform.find((r) => r.platform === 'facebook');
  assert.ok(fb && fb.count >= 1);
  // v2.2.0: the caption charge now lands on the regular USER's ledger (the
  // OWNER is unlimited and is never charged), so check the burn as the user.
  const mine = await req('/api/analytics?days=30', { cookie: userCookie });
  assert.equal(mine.status, 200);
  const burn = mine.json.creditBurn.find((r) => r.action === 'social_caption');
  assert.ok(burn && burn.count >= 1 && burn.total <= -1, 'caption charge in credit burn');
  assert.match(j.note, /own database/);
  const top = j.topTemplates.find((t) => t.id === templateId);
  assert.ok(top && top.downloads >= 1, 'installed template counted');
});
