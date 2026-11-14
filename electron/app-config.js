'use strict';
// Pure logic for the Electron shell — NO require('electron') here, so this
// file can be imported in plain Node (tests do exactly that).
// The Electron shell is THIN: the real app is server.js, run as a CHILD
// PROCESS (never require()'d into Electron) because better-sqlite3 is
// compiled for Node's ABI and Electron's Node ABI differs.
const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_PORT = 4820;
const PORT_SCAN_LIMIT = 20; // 4820..4840, then give up loudly
const DEFAULT_WINDOW = { width: 1280, height: 800, maximized: false };

// Is anything listening on 127.0.0.1:port? A refused connection means free.
function isPortBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

// First free port starting at `preferred` (default 4820), scanning up to
// preferred+20. Throws when every port in the range is busy.
async function resolveServerPort(preferred = DEFAULT_PORT) {
  for (let port = preferred; port <= preferred + PORT_SCAN_LIMIT; port++) {
    if (!(await isPortBusy(port))) return port;
  }
  throw new Error(
    `No free port in range ${preferred}-${preferred + PORT_SCAN_LIMIT} — ` +
    'close another CreativeStudio copy (or whatever holds those ports) and try again.',
  );
}

// Poll GET <baseUrl>/api/health every 250 ms until it answers {ok:true}.
// Resolves with the parsed health object; rejects on timeout.
function waitForHealth(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const lib = baseUrl.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = lib.get(`${baseUrl.replace(/\/$/, '')}/api/health`, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data && data.ok === true) return resolve(data);
          } catch { /* not JSON yet — keep polling */ }
          if (Date.now() >= deadline) return reject(new Error(`Server did not become healthy at ${baseUrl} within ${timeoutMs} ms.`));
          setTimeout(attempt, 250);
        });
      });
      req.on('error', () => {
        if (Date.now() >= deadline) return reject(new Error(`Server did not become healthy at ${baseUrl} within ${timeoutMs} ms.`));
        setTimeout(attempt, 250);
      });
      req.setTimeout(2000, () => req.destroy(new Error('health probe timed out')));
    };
    attempt();
  });
}

// Clamp a saved window rect so at least part of the window lands on a
// visible work area (defaults to a 1920x1080 primary display; main.js
// passes the real work area from Electron's screen API).
function clampWindowState(state, workArea = { x: 0, y: 0, width: 1920, height: 1080 }) {
  const width = Math.min(Math.max(state.width || DEFAULT_WINDOW.width, 800), workArea.width);
  const height = Math.min(Math.max(state.height || DEFAULT_WINDOW.height, 600), workArea.height);
  const x = Math.min(
    Math.max(state.x ?? workArea.x, workArea.x - width + 200),
    workArea.x + workArea.width - 200,
  );
  const y = Math.min(
    Math.max(state.y ?? workArea.y, workArea.y),
    workArea.y + workArea.height - 100,
  );
  return { x, y, width, height, maximized: !!state.maximized };
}

function loadWindowState(filePath, workArea) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_WINDOW };
    return clampWindowState(raw, workArea);
  } catch {
    return { ...DEFAULT_WINDOW };
  }
}

function saveWindowState(filePath, state) {
  const clean = {
    x: Math.round(state.x), y: Math.round(state.y),
    width: Math.round(state.width), height: Math.round(state.height),
    maximized: !!state.maximized,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(clean, null, 1));
}

// How to launch the server child process. `appPath` is the app root
// (project root in dev, resources/app inside a packaged app).
//   Windows packaged: bundled runtime/node.exe server.js, with
//     <appPath>/bin prepended to PATH (bundled ffmpeg/ffprobe).
//   Anything else (dev, or a packaged build whose runtime/node.exe is
//   missing — e.g. the Linux verification build): plain `node server.js`.
// On win32 packaged the bundled node.exe is REQUIRED, so it is returned
// even if the file is absent — the spawn then fails loudly instead of
// silently running some other Node.
function getServerCommand(appPath, isPackaged, port = DEFAULT_PORT) {
  const serverJs = path.join(appPath, 'server.js');
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
  };
  const binDir = path.join(appPath, 'bin');
  const pathSep = process.platform === 'win32' ? ';' : ':';
  if (fs.existsSync(binDir)) env.PATH = binDir + pathSep + (process.env.PATH || '');
  if (isPackaged) {
    const bundledNode = path.join(appPath, 'runtime', 'node.exe');
    if (process.platform === 'win32' || fs.existsSync(bundledNode)) {
      return { command: bundledNode, args: [serverJs], env, cwd: appPath };
    }
  }
  return { command: 'node', args: [serverJs], env, cwd: appPath };
}

// Pure menu-template data. No Electron calls inside — main.js passes real
// handlers in `h` and Electron's Menu.buildFromTemplate consumes the
// result. Every entry must do something real; there are no dead items.
function buildMenuTemplate(h, version) {
  return [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project',
          accelerator: 'Ctrl+N',
          // Opens the SPA's real New Project flow (clicks the in-page
          // "＋ New Project" button — see public/app.js openNewProjectFlow).
          click: h.onNewProject,
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Ctrl+Q', click: h.onQuit },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'Ctrl+R', click: h.onReload },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'Ctrl+Plus', click: h.onZoomIn },
        { label: 'Zoom Out', accelerator: 'Ctrl+-', click: h.onZoomOut },
        { label: 'Actual Size', accelerator: 'Ctrl+0', click: h.onZoomReset },
        { type: 'separator' },
        { label: 'Toggle Developer Tools', accelerator: 'Ctrl+Shift+I', click: h.onToggleDevTools },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', accelerator: 'Ctrl+M', click: h.onMinimize },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: `About CreativeStudio AI Pro v${version}`, click: h.onAbout },
        { label: 'Open Data Folder', click: h.onOpenDataFolder },
      ],
    },
  ];
}

module.exports = {
  DEFAULT_PORT,
  resolveServerPort,
  waitForHealth,
  loadWindowState,
  saveWindowState,
  clampWindowState,
  getServerCommand,
  buildMenuTemplate,
};
