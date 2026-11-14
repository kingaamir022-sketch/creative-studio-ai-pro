'use strict';
// electron-260.test.js — v2.7.0 Desktop App (Electron shell) tests.
// Imports ONLY electron/app-config.js (pure logic, no require('electron')),
// so this file runs in plain Node. The shell itself is never launched here:
// window behaviour, single-instance and the NSIS migration are verified on
// real Windows (see docs/FEATURE_COMPLETION.md §1h); Linux verification of
// the running shell was done under Xvfb by Worker 1. Port 4854 is this
// file's scratch port — no other test file uses it (others: 4831–4853).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const cfg = require('../electron/app-config');

const PORT = 4854; // this file's scratch base port
const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-electron-260-test-'));

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Listen on every port in [base, base + 20] (21 ports) and hand back a
// closer. Used for the "all ports busy" case.
async function occupyPorts(base, count) {
  const servers = [];
  for (let i = 0; i < count; i++) {
    const srv = net.createServer();
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(base + i, '127.0.0.1', resolve);
    });
    servers.push(srv);
  }
  return async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  };
}

// Is anything listening on 127.0.0.1:port? (Test-side probe, independent
// of the implementation's own isPortBusy.)
function probeBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

/* ---------- resolveServerPort ---------- */

test('resolveServerPort: free preferred port is returned as-is', async () => {
  assert.equal(await probeBusy(PORT), false, 'scratch port must start free');
  assert.equal(await cfg.resolveServerPort(PORT), PORT);
});

test('resolveServerPort: busy preferred port is skipped for the next free one', async () => {
  const busy = net.createServer();
  await new Promise((resolve, reject) => {
    busy.once('error', reject);
    busy.listen(PORT + 1, '127.0.0.1', resolve);
  });
  try {
    assert.equal(await cfg.resolveServerPort(PORT + 1), PORT + 2);
  } finally {
    await new Promise((r) => busy.close(r));
  }
});

test('resolveServerPort: default preferred port is 4820', async (t) => {
  if (await probeBusy(4820)) {
    t.skip('port 4820 is busy on this box — default-port case cannot be observed here');
    return;
  }
  assert.equal(await cfg.resolveServerPort(), 4820);
});

test('resolveServerPort: throws when all 21 ports in range are busy', async () => {
  const free = await occupyPorts(PORT + 6, 21); // 4860..4880
  try {
    await assert.rejects(cfg.resolveServerPort(PORT + 6), /No free port/);
  } finally {
    await free();
  }
});

/* ---------- waitForHealth ---------- */

test('waitForHealth: resolves with the health object once the server answers {ok:true}', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/health');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '2.7.0', phase: 13, db: 'ok' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const health = await cfg.waitForHealth(`http://127.0.0.1:${server.address().port}`);
    assert.equal(health.ok, true);
    assert.equal(health.version, '2.7.0');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('waitForHealth: rejects within the timeout against a dead port', async () => {
  // A port nothing listens on: allocate an ephemeral one, then close it.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const started = Date.now();
  await assert.rejects(
    cfg.waitForHealth(`http://127.0.0.1:${deadPort}`, 500),
    /did not become healthy/,
  );
  assert.ok(Date.now() - started < 5000, `rejection took ${Date.now() - started} ms — must stay inside a short timeout`);
});

/* ---------- window state ---------- */

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

test('loadWindowState: missing file returns the 1280x800 defaults', () => {
  assert.deepEqual(cfg.loadWindowState(path.join(tmp, 'no-such-state.json'), WORK_AREA), {
    width: 1280, height: 800, maximized: false,
  });
});

test('loadWindowState: corrupt JSON returns the defaults and never throws', () => {
  const file = path.join(tmp, 'corrupt-state.json');
  fs.writeFileSync(file, '{ this is not json {{{');
  assert.deepEqual(cfg.loadWindowState(file, WORK_AREA), {
    width: 1280, height: 800, maximized: false,
  });
});

test('clampWindowState: off-screen and oversized values clamp to a visible area', () => {
  const off = cfg.clampWindowState({ x: -5000, y: -5000, width: 1280, height: 800, maximized: false }, WORK_AREA);
  assert.ok(off.x + off.width >= 200, `at least 200px of width must stay visible, got x=${off.x} width=${off.width}`);
  assert.ok(off.y + off.height > 0, `window must not sit fully above the screen, got y=${off.y}`);
  assert.ok(off.x <= WORK_AREA.width - 200 && off.y <= WORK_AREA.height - 100, 'window must not sit fully off the right/bottom edge');
  const big = cfg.clampWindowState({ x: 0, y: 0, width: 5000, height: 5000, maximized: false }, WORK_AREA);
  assert.equal(big.width, 1920);
  assert.equal(big.height, 1080);
  const small = cfg.clampWindowState({ x: 0, y: 0, width: 100, height: 100, maximized: false }, WORK_AREA);
  assert.equal(small.width, 800, 'width clamps up to the 800 minimum');
  assert.equal(small.height, 600, 'height clamps up to the 600 minimum');
});

test('saveWindowState + loadWindowState: round-trips the saved rect', () => {
  const file = path.join(tmp, 'nested', 'window-state.json');
  cfg.saveWindowState(file, { x: 100, y: 120, width: 1400, height: 900, maximized: true });
  assert.deepEqual(cfg.loadWindowState(file, WORK_AREA), {
    x: 100, y: 120, width: 1400, height: 900, maximized: true,
  });
});

/* ---------- getServerCommand ---------- */

test('getServerCommand: dev shape is plain `node server.js` with PORT/HOST env', () => {
  const spec = cfg.getServerCommand('/some/app', false, 4820);
  assert.equal(spec.command, 'node');
  assert.ok(spec.args[0].endsWith(path.join('some', 'app', 'server.js')), `args must point at server.js, got ${spec.args}`);
  assert.equal(spec.env.PORT, '4820');
  assert.equal(spec.env.HOST, '127.0.0.1');
  assert.equal(spec.cwd, '/some/app');
});

test('getServerCommand: packaged shape uses the bundled runtime/node.exe and prepends the app bin dir to PATH', () => {
  const fakeApp = path.join(tmp, 'fake-app');
  fs.mkdirSync(path.join(fakeApp, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(fakeApp, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fakeApp, 'runtime', 'node.exe'), '');
  const spec = cfg.getServerCommand(fakeApp, true, 4821);
  assert.ok(spec.command.endsWith(path.join('runtime', 'node.exe')), `packaged command must be runtime/node.exe, got ${spec.command}`);
  assert.ok(spec.args[0].endsWith('server.js'));
  assert.equal(spec.env.PORT, '4821');
  assert.equal(spec.env.PATH.split(path.delimiter)[0], path.join(fakeApp, 'bin'), 'bundled ffmpeg/ffprobe bin dir must come first on PATH');
});

test('getServerCommand: packaged without a bundled node falls back to plain node (never a silent wrong runtime)', () => {
  const fakeApp = path.join(tmp, 'fake-app-no-runtime');
  fs.mkdirSync(fakeApp, { recursive: true });
  const spec = cfg.getServerCommand(fakeApp, true, 4820);
  assert.equal(spec.command, 'node');
});

/* ---------- buildMenuTemplate ---------- */

function fakeHandlers() {
  const fn = () => {};
  return {
    onNewProject: fn, onQuit: fn, onReload: fn, onZoomIn: fn, onZoomOut: fn,
    onZoomReset: fn, onToggleDevTools: fn, onMinimize: fn, onAbout: fn,
    onOpenDataFolder: fn,
  };
}

test('buildMenuTemplate: exactly the File/View/Window/Help groups, in order', () => {
  const menu = cfg.buildMenuTemplate(fakeHandlers(), '2.7.0');
  assert.deepEqual(menu.map((g) => g.label), ['File', 'View', 'Window', 'Help']);
});

test('buildMenuTemplate: every leaf item has a click handler or a role — no dead entries', () => {
  const menu = cfg.buildMenuTemplate(fakeHandlers(), '2.7.0');
  const leaves = [];
  const walk = (items) => {
    for (const item of items) {
      if (item.type === 'separator') continue;
      if (item.submenu) { walk(item.submenu); continue; }
      leaves.push(item);
    }
  };
  walk(menu);
  assert.ok(leaves.length >= 8, `expected at least 8 leaf menu items, got ${leaves.length}`);
  for (const item of leaves) {
    assert.ok(
      typeof item.click === 'function' || typeof item.role === 'string',
      `menu item "${item.label}" has neither a click handler nor a role — dead entry`,
    );
  }
});

test('buildMenuTemplate: Help > About carries the current version', () => {
  const menu = cfg.buildMenuTemplate(fakeHandlers(), '2.7.0');
  const help = menu.find((g) => g.label === 'Help');
  assert.ok(help.submenu.some((i) => i.label && i.label.includes('2.7.0')), 'About item must show v2.7.0');
});

/* ---------- icon.ico ---------- */

test('icon.ico: real ICO file with 16/32/48/256 sizes', () => {
  const iconPath = path.join(ROOT, 'electron', 'icon.ico');
  assert.ok(fs.existsSync(iconPath), 'electron/icon.ico must exist');
  const buf = fs.readFileSync(iconPath);
  assert.ok(buf.length > 6 + 16, 'icon file must hold a header plus at least one image entry');
  assert.equal(buf.readUInt16LE(0), 0, 'ICO reserved field must be 0');
  assert.equal(buf.readUInt16LE(2), 1, 'ICO type must be 1 (icon, not cursor)');
  const count = buf.readUInt16LE(4);
  assert.ok(count >= 4, `expected at least 4 icon sizes, got ${count}`);
  const sizes = new Set();
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const w = buf[off] === 0 ? 256 : buf[off]; // a 0 byte means 256
    const h = buf[off + 1] === 0 ? 256 : buf[off + 1];
    assert.equal(w, h, `icon entry ${i} must be square, got ${w}x${h}`);
    sizes.add(w);
  }
  for (const size of [16, 32, 48, 256]) {
    assert.ok(sizes.has(size), `icon must include a ${size}px image (has: ${[...sizes].sort((a, b) => a - b).join(', ')})`);
  }
});

/* ---------- main.js / preload.js static guards ---------- */

test('main.js: single-instance lock + secure webPreferences, and the server is never require()d in-process', () => {
  const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  assert.ok(src.includes('requestSingleInstanceLock'), 'main.js must take the single-instance lock');
  assert.ok(src.includes('contextIsolation'), 'main.js must set contextIsolation on its windows');
  assert.ok(src.includes('preload'), 'main.js must wire a preload script');
  assert.ok(!src.includes("require('./server')"), 'the shell must never require the server in-process');
  assert.ok(!src.includes('require("../server")'), 'the shell must never require the server in-process');
  assert.ok(!src.includes("require('./server.js')"), 'the shell must never require the server in-process');
});

test('preload.js exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'electron', 'preload.js')), 'electron/preload.js must exist');
});
