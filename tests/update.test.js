'use strict';
// Auto-update tests (v2.1.0) — run with: npm test
// Spawns the real server on a scratch port (4841) with a temp DB/uploads
// dir, PLUS a local MOCK feed server speaking the manifest + update-package
// shapes (version.json + update-<version>.json). No real feed or GitHub call
// ever happens. The updater's file operations target a TEMP COPY of the app
// tree (CS_UPDATE_APP_DIR) — the real project tree is never modified.
// Covers: status honesty, settings RBAC, check newer/up-to-date, URL-value
// forcing, auto-apply OFF, tampered-package rejection, apply + rollback,
// fullReinstall refusal, dismiss, the Windows apply batch, and the
// publish-update script.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-update-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const appCopy = path.join(tmp, 'app');
const PORT = 4841;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let mockServer;
let mockPort;
let ownerCookie = '';
let userCookie = '';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

// --- Mock feed state (mutable per test) ---
const feed = {
  version: '9.9.9',
  notes: 'Test release 9.9.9',
  fullReinstall: false,
  mode: 'good', // good | bad-package-sha | bad-file-sha
  files: null, // {rel: content string} — null = default package below
};
function defaultFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(appCopy, 'package.json'), 'utf8'));
  pkg.version = feed.version;
  return {
    'package.json': JSON.stringify(pkg, null, 2) + '\n',
    'docs/update-test.txt': 'hello-update ' + feed.version,
  };
}
function buildPackage() {
  const files = feed.files || defaultFiles();
  const bundleFiles = {};
  for (const [rel, content] of Object.entries(files)) {
    bundleFiles[rel] = {
      sha256: feed.mode === 'bad-file-sha' && rel === 'docs/update-test.txt' ? sha256('wrong-content') : sha256(content),
      content_b64: b64(content),
    };
  }
  const bundle = { app: 'CreativeStudio AI Pro', version: feed.version, notes: feed.notes, files: bundleFiles };
  if (feed.fullReinstall) bundle.fullReinstall = true;
  const raw = Buffer.from(JSON.stringify(bundle), 'utf8');
  return { bundle, raw, sha: sha256(raw) };
}
function mockHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/version.json') {
    const { sha } = buildPackage();
    const manifest = {
      app: 'CreativeStudio AI Pro', version: feed.version, notes: feed.notes,
      package: `update-${feed.version}.json`, packageSha256: sha,
      publishedAt: new Date().toISOString(),
    };
    if (feed.fullReinstall) manifest.fullReinstall = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest));
    return;
  }
  if (url.pathname.startsWith('/update-') && url.pathname.endsWith('.json')) {
    const { raw } = buildPackage();
    if (feed.mode === 'bad-package-sha') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"tampered":true}');
      return;
    }
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
async function setFeedUrl(url) {
  const r = await req('/api/updates/settings', { method: 'POST', body: { feedType: 'url', feedUrl: url } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r;
}

before(async () => {
  copyTree(path.resolve(__dirname, '..'), appCopy);
  assert.equal(appVersion(), '2.2.1', 'test app copy must start at 2.2.1');

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

  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'Update Tester', email: 'update@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  assert.equal(s.json.user.role, 'OWNER');
  ownerCookie = s.setCookie.split(';')[0];

  const u = await req('/api/auth/signup', { method: 'POST', body: { name: 'Regular User', email: 'regular2@test.local', password: 'password123' } });
  assert.equal(u.status, 201, JSON.stringify(u.json));
  userCookie = u.setCookie.split(';')[0];
});

after(async () => {
  if (server) server.kill();
  if (mockServer) mockServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Updates: status shows current version; unreachable feed reported honestly, never fake up-to-date', async () => {
  const st = await req('/api/updates/status');
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.equal(st.json.current, '2.2.1');
  assert.equal(st.json.available, null, 'nothing available before any check');
  assert.equal(st.json.feedReachable, null, 'never checked yet — must not claim reachable');
  // Point at a dead feed: the check must fail honestly.
  await setFeedUrl('http://127.0.0.1:1/updates');
  const chk = await req('/api/updates/check', { method: 'POST' });
  assert.equal(chk.status, 502, JSON.stringify(chk.json));
  assert.match(chk.json.error, /not reachable/i);
  const st2 = await req('/api/updates/status');
  assert.equal(st2.json.feedReachable, false);
  assert.equal(st2.json.available, null, 'a failed check must never report up-to-date or available');
  assert.ok(st2.json.lastCheckError, 'the failure reason is recorded');
});

test('Updates: settings RBAC — regular user gets 403; validation rejects bad feedType', async () => {
  const g = await req('/api/updates/settings', { cookie: userCookie });
  assert.equal(g.status, 403, JSON.stringify(g.json));
  const p = await req('/api/updates/settings', { method: 'POST', cookie: userCookie, body: { feedUrl: 'http://x/' } });
  assert.equal(p.status, 403);
  const bad = await req('/api/updates/settings', { method: 'POST', body: { feedType: 'carrier-pigeon' } });
  assert.equal(bad.status, 400);
  const ok = await setFeedUrl(`http://127.0.0.1:${mockPort}`);
  assert.equal(ok.json.feedUrl, `http://127.0.0.1:${mockPort}`);
  assert.equal(ok.json.autoCheck, true, 'auto-check defaults ON');
  assert.equal(ok.json.autoApply, false, 'auto-apply defaults OFF');
});

test('Updates: check finds a newer version; up-to-date when equal', async () => {
  feed.version = '9.9.9'; feed.mode = 'good'; feed.fullReinstall = false;
  const chk = await req('/api/updates/check', { method: 'POST' });
  assert.equal(chk.status, 200, JSON.stringify(chk.json));
  assert.ok(chk.json.available, 'update should be available');
  assert.equal(chk.json.latest, '9.9.9');
  assert.equal(chk.json.current, '2.2.1');
  const st = await req('/api/updates/status');
  assert.equal(st.json.available.version, '9.9.9');
  assert.equal(st.json.feedReachable, true);
  feed.version = '2.2.1';
  const chk2 = await req('/api/updates/check', { method: 'POST' });
  assert.equal(chk2.status, 200, JSON.stringify(chk2.json));
  assert.equal(chk2.json.available, null, 'equal version is up-to-date');
  const st2 = await req('/api/updates/status');
  assert.equal(st2.json.available, null);
});

test('Updates: feed URL value forces URL treatment even if stored type is folder', async () => {
  feed.version = '9.9.9'; feed.mode = 'good';
  const r = await req('/api/updates/settings', { method: 'POST', body: { feedType: 'folder', feedUrl: `http://127.0.0.1:${mockPort}` } });
  assert.equal(r.status, 200);
  const chk = await req('/api/updates/check', { method: 'POST' });
  assert.equal(chk.status, 200, JSON.stringify(chk.json));
  assert.ok(chk.json.available, 'an http(s) feed value is always a URL feed');
  assert.equal(chk.json.feed.type, 'url');
});

test('Updates: auto-apply OFF never applies without the apply call', async () => {
  feed.version = '9.9.9'; feed.mode = 'good'; feed.fullReinstall = false;
  const chk = await req('/api/updates/check', { method: 'POST' });
  assert.ok(chk.json.available, 'update should be available');
  assert.equal(appVersion(), '2.2.1', 'check alone must not change any file');
  assert.ok(!fs.existsSync(path.join(appCopy, 'docs', 'update-test.txt')), 'no staged file landed without apply');
});

test('Updates: tampered package rejected — wrong package SHA, and wrong inner file SHA', async () => {
  feed.version = '9.9.9'; feed.mode = 'bad-package-sha';
  const a = await req('/api/updates/apply', { method: 'POST' });
  assert.equal(a.status, 502, JSON.stringify(a.json));
  assert.match(a.json.error, /hash mismatch/i);
  assert.equal(appVersion(), '2.2.1', 'tampered package changed nothing');
  feed.mode = 'bad-file-sha';
  const b = await req('/api/updates/apply', { method: 'POST' });
  assert.equal(b.status, 502, JSON.stringify(b.json));
  assert.match(b.json.error, /hash mismatch/i);
  assert.equal(appVersion(), '2.2.1');
  feed.mode = 'good';
});

test('Updates: apply updates files + bumps version; rollback restores the backup', async () => {
  feed.version = '9.9.9'; feed.mode = 'good'; feed.fullReinstall = false;
  const a = await req('/api/updates/apply', { method: 'POST' });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.from, '2.2.1');
  assert.equal(a.json.to, '9.9.9');
  assert.equal(a.json.restartRequired, true, 'Linux apply needs a restart to take effect');
  assert.equal(appVersion(), '9.9.9', 'package.json on disk is the new version');
  assert.equal(fs.readFileSync(path.join(appCopy, 'docs', 'update-test.txt'), 'utf8'), 'hello-update 9.9.9');
  const st = await req('/api/updates/status');
  assert.equal(st.json.current, '9.9.9');
  assert.equal(st.json.pendingRestart, true);
  assert.equal(st.json.backups, 1, 'one backup kept');
  assert.equal(st.json.history.at(-1).action, 'apply');
  const rb = await req('/api/updates/rollback', { method: 'POST' });
  assert.equal(rb.status, 200, JSON.stringify(rb.json));
  assert.equal(rb.json.restored, '2.2.1');
  assert.equal(appVersion(), '2.2.1', 'rollback restored package.json');
  assert.ok(!fs.existsSync(path.join(appCopy, 'docs', 'update-test.txt')), 'rollback removed the file the update added');
  const st2 = await req('/api/updates/status');
  assert.equal(st2.json.current, '2.2.1');
});

test('Updates: fullReinstall update is refused — nothing applied', async () => {
  feed.version = '9.9.10'; feed.mode = 'good'; feed.fullReinstall = true;
  const a = await req('/api/updates/apply', { method: 'POST' });
  assert.equal(a.status, 409, JSON.stringify(a.json));
  assert.match(a.json.error, /fresh download/i);
  assert.equal(a.json.fullReinstall, true);
  assert.equal(appVersion(), '2.2.1', 'full-reinstall package changed nothing');
  assert.ok(!fs.existsSync(path.join(appCopy, 'docs', 'update-test.txt')));
  feed.fullReinstall = false; feed.version = '9.9.9';
});

test('Updates: dismiss hides the banner once for that version', async () => {
  feed.version = '9.9.9'; feed.mode = 'good';
  const chk = await req('/api/updates/check', { method: 'POST' });
  assert.ok(chk.json.available, 'update should be available');
  const d = await req('/api/updates/dismiss', { method: 'POST', body: { version: '9.9.9' } });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const st = await req('/api/updates/status');
  assert.equal(st.json.availableDismissed, true);
  // A different version is not dismissed.
  feed.version = '9.9.10';
  const chk2 = await req('/api/updates/check', { method: 'POST' });
  assert.ok(chk2.json.available, 'newer version should be available');
  const st2 = await req('/api/updates/status');
  assert.equal(st2.json.availableDismissed, false);
  feed.version = '9.9.9';
});

test('Updates: apply + check + rollback are OWNER/ADMIN only', async () => {
  for (const [pathName, body] of [
    ['/api/updates/check', undefined],
    ['/api/updates/apply', undefined],
    ['/api/updates/rollback', undefined],
  ]) {
    const r = await req(pathName, { method: 'POST', cookie: userCookie, body });
    assert.equal(r.status, 403, `${pathName} must reject a regular user`);
  }
  // But status is visible to everyone signed in.
  const st = await req('/api/updates/status', { cookie: userCookie });
  assert.equal(st.status, 200);
});

test('Updates: Windows apply batch is a real script (waits, copies, relaunches)', () => {
  const { buildApplyBatch } = require('../src/updater');
  const batch = buildApplyBatch({
    appDir: 'C:\\Apps\\CreativeStudio',
    stagedDir: 'C:\\Apps\\CreativeStudio\\data\\updates\\staged',
    backupDir: 'C:\\Apps\\CreativeStudio\\data\\updates\\backup-2.2.1-1',
    pid: 1234,
    launcher: 'C:\\Apps\\CreativeStudio\\Start.bat',
  });
  assert.match(batch, /tasklist \/FI "PID eq %SRVPID%"/);
  assert.match(batch, /xcopy \/E \/Y \/Q %STAGED%\\\* %APPDIR%\\/);
  assert.match(batch, /start "" "C:\\Apps\\CreativeStudio\\Start\.bat"/);
  assert.match(batch, /restoring backup/i);
  assert.match(batch, /del "%~f0"/);
  assert.match(batch, /1234/);
});

test('Updates: publish-update script builds a verifiable package', async () => {
  const outDir = path.join(tmp, 'pub-out');
  execFileSync(process.execPath, ['scripts/publish-update.js', '--out', outDir, '--version', '2.1.0', '--notes', 'test build'], { cwd: path.resolve(__dirname, '..'), timeout: 30000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'version.json'), 'utf8'));
  assert.equal(manifest.version, '2.1.0');
  assert.equal(manifest.package, 'update-2.1.0.json');
  const raw = fs.readFileSync(path.join(outDir, manifest.package));
  assert.equal(sha256(raw), manifest.packageSha256, 'package hash matches the manifest');
  const bundle = JSON.parse(raw.toString('utf8'));
  assert.equal(bundle.version, '2.1.0');
  assert.ok(Object.keys(bundle.files).length > 50, 'package carries the app files');
  assert.ok(bundle.files['server.js'] && bundle.files['src/updater.js'] && bundle.files['public/app.js']);
  for (const [rel, f] of Object.entries(bundle.files)) {
    assert.ok(!rel.startsWith('node_modules/') && !rel.startsWith('data/') && !rel.startsWith('uploads/') && !rel.startsWith('renders/') && rel !== '.env' && !rel.startsWith('tests/'), 'no disallowed file in package: ' + rel);
    assert.equal(sha256(Buffer.from(f.content_b64, 'base64')), f.sha256, 'file hash matches: ' + rel);
  }
});
