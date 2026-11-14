'use strict';
// Updater Fix tests (v2.7.1) — run with: node --test tests/updater-fix-271.test.js
// Spawns the real server on a scratch port (4858) with a temp DB/uploads
// dir, PLUS a local MOCK feed server (version.json only — no package is
// ever downloaded here). The updater's file operations target a TEMP COPY
// of the app tree (CS_UPDATE_APP_DIR) — the real project tree is never
// modified. Covers the v2.7.1 updater fixes:
//   1. boot clears a stale pendingRestart flag (the stuck orange warning),
//   2. the Windows apply batch waits for BOTH the server PID and the
//      Electron PID and relaunches the desktop exe (never Start.bat),
//   3. consumeUpdateRestartFlag (electron/app-config.js),
//   4. status honesty: a lastApplied from another version is omitted,
//      one matching the running version is surfaced,
//   5. check-now on the latest version reports no update available,
//   6. apply with no update available stays a 409 'No update is available.'
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-updater-fix-271-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const appCopy = path.join(tmp, 'app');
const updDir = path.join(tmp, 'updates');
const stateFile = path.join(updDir, 'state.json');
const PORT = 4858;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let mockServer;
let mockPort;
let ownerCookie = '';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

// --- Mock feed state (mutable per test) ---
const feed = { version: '2.7.1', notes: 'Test release 2.7.1' };
function buildPackage() {
  const pkg = JSON.parse(fs.readFileSync(path.join(appCopy, 'package.json'), 'utf8'));
  pkg.version = feed.version;
  const bundle = {
    app: 'CreativeStudio AI Pro', version: feed.version, notes: feed.notes,
    files: { 'package.json': { sha256: sha256(JSON.stringify(pkg, null, 2) + '\n'), content_b64: b64(JSON.stringify(pkg, null, 2) + '\n') } },
  };
  const raw = Buffer.from(JSON.stringify(bundle), 'utf8');
  return { raw, sha: sha256(raw) };
}
function mockHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/version.json') {
    const { sha } = buildPackage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      app: 'CreativeStudio AI Pro', version: feed.version, notes: feed.notes,
      package: `update-${feed.version}.json`, packageSha256: sha,
      publishedAt: new Date().toISOString(),
    }));
    return;
  }
  if (url.pathname.startsWith('/update-') && url.pathname.endsWith('.json')) {
    const { raw } = buildPackage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(raw);
    return;
  }
  res.writeHead(404); res.end('not found');
}

function req(pathName, { method = 'GET', body, cookie } = {}) {
  if (cookie === undefined) cookie = ownerCookie;
  const headers = { connection: 'close' };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return fetch(BASE + pathName, { method, headers, body: payload, redirect: 'manual' })
    .then(async (r) => {
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, text, headers: r.headers, setCookie: r.headers.get('set-cookie') || '' };
    });
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', 'uploads', 'renders'].includes(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}
function appVersion() {
  return JSON.parse(fs.readFileSync(path.join(appCopy, 'package.json'), 'utf8')).version;
}
// The updater reads data/updates/state.json live on every status call,
// so a test can re-seed it mid-run without restarting the server.
function seedState(overrides = {}) {
  fs.mkdirSync(updDir, { recursive: true });
  const base = {
    lastCheck: null, lastCheckError: null, available: null, staged: null,
    pendingRestart: false, dismissed: {}, history: [], lastApplied: null,
  };
  fs.writeFileSync(stateFile, JSON.stringify({ ...base, ...overrides }, null, 1));
}
async function setFeedUrl(url) {
  const r = await req('/api/updates/settings', { method: 'POST', body: { feedType: 'url', feedUrl: url } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r;
}

before(async () => {
  copyTree(path.resolve(__dirname, '..'), appCopy);
  assert.equal(appVersion(), '2.7.1', 'test app copy must start at 2.7.1');

  // A stale pendingRestart + a stale lastApplied from an older version,
  // as left behind by a previous run that never restarted cleanly.
  seedState({ pendingRestart: true, lastApplied: { version: '2.2.3', at: '2026-11-10T00:00:00.000Z' } });

  mockServer = http.createServer(mockHandler);
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;

  const env = {
    ...process.env,
    DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir,
    PORT: String(PORT), HOST: '127.0.0.1',
    CS_UPDATE_APP_DIR: appCopy,
    UPDATE_CHECK_INTERVAL_MS: '3600000',
    UPDATE_CHECK_INITIAL_DELAY_MS: '3600000',
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

  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'Updater Fix Tester', email: 'updater-fix@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  assert.equal(s.json.user.role, 'OWNER');
  ownerCookie = s.setCookie.split(';')[0];
});

after(async () => {
  if (server) server.kill();
  if (mockServer) mockServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Updater Fix: boot clears a stale pendingRestart flag — the orange warning is gone', async () => {
  const st = await req('/api/updates/status');
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.equal(st.json.pendingRestart, false, 'a stale pendingRestart seeded before boot must be cleared by boot');
});

test('Updater Fix: desktop apply batch waits for both PIDs and relaunches the exe, never Start.bat', () => {
  const { buildApplyBatch } = require('../src/updater');
  const batch = buildApplyBatch({
    appDir: 'C:\\App',
    stagedDir: 'C:\\App\\data\\updates\\staged',
    backupDir: 'C:\\App\\data\\updates\\backup-2.7.1-1',
    pid: 5678,
    launcher: 'C:\\App\\CreativeStudio AI Pro.exe',
    electronPid: 1234,
  });
  assert.ok(batch.includes('C:\\App\\CreativeStudio AI Pro.exe'), 'batch must relaunch the desktop exe');
  assert.ok(!batch.includes('Start.bat'), 'desktop batch must never launch Start.bat');
  assert.match(batch, /set SRVPID=5678/);
  assert.match(batch, /set ELECTRONPID=1234/);
  assert.match(batch, /tasklist \/FI "PID eq %SRVPID%"/);
  assert.match(batch, /tasklist \/FI "PID eq %ELECTRONPID%"/);

  // Default call (no launcher, no Electron PID): Start.bat, as before.
  const plain = buildApplyBatch({
    appDir: 'C:\\App',
    stagedDir: 'C:\\App\\data\\updates\\staged',
    backupDir: 'C:\\App\\data\\updates\\backup-2.7.1-1',
    pid: 5678,
  });
  assert.ok(plain.includes('Start.bat'), 'default batch still relaunches Start.bat');
  // Separator-agnostic: on Linux path.join uses '/', on Windows '\'.
  assert.match(plain, /start "" ".*Start\.bat"/);
});

test('Updater Fix: consumeUpdateRestartFlag returns true once, then false', () => {
  const { consumeUpdateRestartFlag } = require('../electron/app-config');
  const dataDir = fs.mkdtempSync(path.join(tmp, 'flag-data-'));
  const flagFile = path.join(dataDir, 'updates', 'restarting-for-update');
  assert.equal(consumeUpdateRestartFlag(dataDir), false, 'absent flag → false');
  fs.mkdirSync(path.dirname(flagFile), { recursive: true });
  fs.writeFileSync(flagFile, new Date().toISOString());
  assert.equal(consumeUpdateRestartFlag(dataDir), true, 'present flag → true');
  assert.ok(!fs.existsSync(flagFile), 'consuming the flag deletes the file');
  assert.equal(consumeUpdateRestartFlag(dataDir), false, 'second consume → false');
});

test('Updater Fix: status omits a lastApplied from another version', async () => {
  seedState({ pendingRestart: false, lastApplied: { version: '2.2.3', at: '2026-11-10T00:00:00.000Z' } });
  const st = await req('/api/updates/status');
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.equal(st.json.current, '2.7.1');
  assert.equal(st.json.lastApplied, null, 'lastApplied 2.2.3 is stale under running 2.7.1 — must not surface');
});

test('Updater Fix: status surfaces a lastApplied matching the running version', async () => {
  seedState({ pendingRestart: false, lastApplied: { version: '2.7.1', at: '2026-11-14T00:00:00.000Z' } });
  const st = await req('/api/updates/status');
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.equal(st.json.current, '2.7.1');
  assert.equal(st.json.lastApplied && st.json.lastApplied.version, '2.7.1', 'lastApplied matching the running version is surfaced');
});

test('Updater Fix: check-now on the latest version reports no update available', async () => {
  feed.version = '2.7.1';
  await setFeedUrl(`http://127.0.0.1:${mockPort}`);
  const chk = await req('/api/updates/check', { method: 'POST' });
  assert.equal(chk.status, 200, JSON.stringify(chk.json));
  assert.equal(chk.json.current, '2.7.1');
  assert.equal(chk.json.latest, '2.7.1');
  assert.equal(chk.json.available, null, 'equal version is up-to-date');
});

test('Updater Fix: apply with no update available stays a 409 (server behaviour unchanged)', async () => {
  feed.version = '2.7.1';
  const a = await req('/api/updates/apply', { method: 'POST' });
  assert.equal(a.status, 409, JSON.stringify(a.json));
  assert.match(a.json.error, /No update is available\./);
  assert.equal(appVersion(), '2.7.1', 'a refused apply changes nothing');
});
