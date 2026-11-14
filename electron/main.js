'use strict';
// CreativeStudio AI Pro — Electron shell (THIN wrapper).
// The real app is server.js, run as a CHILD PROCESS (bundled
// runtime/node.exe on Windows, plain `node` in dev). It is NEVER require()'d
// here: better-sqlite3 is compiled for Node's ABI, Electron's Node ABI
// differs. Electron only opens the window.
const { app, BrowserWindow, Menu, dialog, shell, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cfg = require('./app-config');

// NOTE on Linux-as-root: Chromium refuses to start as root unless
// --no-sandbox is passed on the COMMAND LINE (the check happens before any
// JS runs, so app.commandLine.appendSwitch cannot help). Verification on
// this VM therefore runs `electron --no-sandbox ...`. Real Windows/macOS
// installs never hit this — end users are never root.

const APP_NAME = 'CreativeStudio AI Pro';
const pkg = require('../package.json');
const APP_VERSION = pkg.version || '0.0.0';
const isPackaged = app.isPackaged;
// App root: in dev, the project root (NOT app.getAppPath() — when the entry
// point is electron/main.js, Electron reports the electron/ dir as the app
// path). In a packaged build, app.getAppPath() is resources/app — correct.
const appPath = isPackaged ? app.getAppPath() : path.join(__dirname, '..');
const userDataDir = app.getPath('userData');
const stateFile = path.join(userDataDir, 'window-state.json');
// The server keeps its own data next to server.js (data/, uploads/,
// renders/ under the app root) — that is the folder Help > Open Data
// Folder opens.
const dataDir = path.join(appPath, 'data');

let mainWindow = null;
let loadingWindow = null;
let serverChild = null;
let serverPort = cfg.DEFAULT_PORT;
let quitting = false;
let restartRequested = false;

function log(...args) { console.log('[desktop]', ...args); }

function showLoadingWindow() {
  loadingWindow = new BrowserWindow({
    width: 420, height: 260, resizable: false, minimizable: false,
    maximizable: false, frame: true, title: APP_NAME,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  loadingWindow.loadFile(path.join(__dirname, 'loading.html'));
  loadingWindow.on('closed', () => { loadingWindow = null; });
}

function startServer(port) {
  const spec = cfg.getServerCommand(appPath, isPackaged, port);
  log(`starting server: ${spec.command} ${spec.args.join(' ')} (port ${port})`);
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.on('error', (err) => {
    log('server spawn failed:', err.message);
    if (!quitting) offerServerRestart(`Server start nahi ho saka: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    log(`server exited (code ${code}, signal ${signal})`);
    serverChild = null;
    if (quitting) return;
    if (restartRequested) { restartRequested = false; return; }
    offerServerRestart(`Server band ho gaya (exit code ${code ?? '?'}) — kaam save hai, server dobara chalaya ja sakta hai.`);
  });
  return child;
}

async function offerServerRestart(message) {
  if (!mainWindow || mainWindow.isDestroyed()) { app.quit(); return; }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: APP_NAME,
    message,
    buttons: ['Restart server', 'Quit'],
    defaultId: 0, cancelId: 1,
  });
  if (response === 0) {
    restartRequested = true;
    serverChild = startServer(serverPort);
    try {
      const baseUrl = `http://127.0.0.1:${serverPort}`;
      await cfg.waitForHealth(baseUrl);
      mainWindow.loadURL(`${baseUrl}/`);
    } catch (e) {
      offerServerRestart(`Server dobara start nahi ho saka: ${e.message}`);
    }
  } else {
    quitting = true;
    app.quit();
  }
}

// File > New Project: drive the SPA's REAL New Project flow
// (public/app.js openNewProjectFlow) by clicking the in-page button.
// The button lives on Home (#home-new-project) and on the projects views
// (#new-project-btn / #dash-create / #qa-project); if none is visible we
// first go Home via the sidebar, then click. Returns true when the flow
// opened (the New Project modal appeared).
async function triggerNewProject(win) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const ids = ['home-new-project', 'new-project-btn', 'dash-create', 'qa-project'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el.offsetParent !== null) { el.click(); return id; }
    }
    const homeNav = document.querySelector('[data-nav="home"]');
    if (homeNav) { homeNav.click(); return 'went-home'; }
    return null;
  })()`);
  if (clicked === 'went-home') {
    await new Promise((r) => setTimeout(r, 500));
    await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('home-new-project');
      if (el) el.click();
    })()`);
  }
  await new Promise((r) => setTimeout(r, 400));
  const opened = await win.webContents.executeJavaScript(
    `!!document.querySelector('.np-grid, #np-form-slot')`,
  );
  log('New Project:', clicked, '-> modal open:', opened);
  return opened;
}

function buildMenu(win) {
  const zoomStep = (delta) => {
    const level = win.webContents.getZoomLevel() + delta;
    win.webContents.setZoomLevel(Math.min(Math.max(level, -3), 3));
  };
  const template = cfg.buildMenuTemplate({
    onNewProject: () => { triggerNewProject(win).catch((e) => log('New Project failed:', e.message)); },
    onQuit: () => { quitting = true; app.quit(); },
    onReload: () => win.webContents.reload(),
    onZoomIn: () => zoomStep(0.5),
    onZoomOut: () => zoomStep(-0.5),
    onZoomReset: () => win.webContents.setZoomLevel(0),
    onToggleDevTools: () => win.webContents.toggleDevTools(),
    onMinimize: () => win.minimize(),
    onAbout: () => {
      dialog.showMessageBox(win, {
        type: 'info', title: `About ${APP_NAME}`,
        message: `${APP_NAME} v${APP_VERSION}`,
        detail: 'All-in-one AI graphic design, video editing, bulk video automation & social media platform.\n\nDesktop app: Electron shell — the server runs locally on your PC (http://127.0.0.1) and your data stays in the app folder.',
        buttons: ['OK'],
      });
    },
    onOpenDataFolder: () => {
      fs.mkdirSync(dataDir, { recursive: true });
      shell.openPath(dataDir);
    },
  }, APP_VERSION);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(port, workArea) {
  const saved = cfg.loadWindowState(stateFile, workArea);
  mainWindow = new BrowserWindow({
    x: saved.x, y: saved.y, width: saved.width, height: saved.height,
    minWidth: 900, minHeight: 600,
    show: false, title: APP_NAME,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // SPA needs only fetch/XHR — verified working under xvfb
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  if (saved.maximized) mainWindow.maximize();
  buildMenu(mainWindow);

  mainWindow.on('close', () => {
    if (mainWindow.isMaximized()) {
      cfg.saveWindowState(stateFile, { ...mainWindow.getBounds(), maximized: true });
    } else {
      cfg.saveWindowState(stateFile, { ...mainWindow.getBounds(), maximized: false });
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('did-finish-load', () => {
    log('loaded', mainWindow.webContents.getURL(), '| title:', mainWindow.webContents.getTitle());
  });

  return mainWindow;
}

async function boot() {
  showLoadingWindow();
  serverPort = await cfg.resolveServerPort(cfg.DEFAULT_PORT);
  if (serverPort !== cfg.DEFAULT_PORT) {
    log(`port ${cfg.DEFAULT_PORT} busy — using ${serverPort}`);
  }
  serverChild = startServer(serverPort);
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  try {
    const health = await cfg.waitForHealth(baseUrl);
    log('server healthy:', JSON.stringify(health));
  } catch (e) {
    if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close();
    dialog.showErrorBox(APP_NAME, `Server start nahi ho saka (30s mein healthy nahi hua):\n${e.message}`);
    quitting = true;
    app.quit();
    return;
  }
  const workArea = screen.getPrimaryDisplay().workArea;
  const win = createMainWindow(serverPort, workArea);
  await win.loadURL(`${baseUrl}/`);
  win.show();
  if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close();
  win.focus();

  // Verification hooks (automated runs only — never set in production):
  //   CS_MENU_PROBE=new-project  run File > New Project once, log the result
  //   CS_TEST_EMAIL / CS_TEST_PASSWORD  log in first (probe only), so the
  //     New Project button actually exists on the Home view
  //   CS_QUIT_AFTER_MS=<ms>      quit after N ms (lets xvfb runs end cleanly)
  if (process.env.CS_MENU_PROBE === 'new-project') {
    if (process.env.CS_TEST_EMAIL && process.env.CS_TEST_PASSWORD) {
      const loggedIn = await win.webContents.executeJavaScript(`(async () => {
        const r = await fetch('/api/auth/login', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: ${JSON.stringify(process.env.CS_TEST_EMAIL)}, password: ${JSON.stringify(process.env.CS_TEST_PASSWORD)} }) });
        return r.ok;
      })()`).catch(() => false);
      log('menu-probe login ok:', loggedIn);
      if (loggedIn) { await win.loadURL(`${baseUrl}/`); await new Promise((r) => setTimeout(r, 1200)); }
    }
    const opened = await triggerNewProject(win).catch(() => false);
    log('menu-probe new-project opened:', opened);
  }
  if (process.env.CS_QUIT_AFTER_MS) {
    setTimeout(() => { quitting = true; app.quit(); }, Number(process.env.CS_QUIT_AFTER_MS));
  }
}

// Second instance: never open a second window — focus the existing one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => boot().catch((e) => {
    log('boot failed:', e);
    dialog.showErrorBox(APP_NAME, `Start nahi ho saka:\n${e.message}`);
    quitting = true;
    app.quit();
  }));

  // No orphan node.exe: on quit, kill the server child and wait for it.
  app.on('before-quit', (event) => {
    if (serverChild && !serverChild.killed) {
      event.preventDefault();
      quitting = true;
      log('stopping server child...');
      const child = serverChild;
      serverChild = null;
      const forceKill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 5000);
      child.once('exit', () => { clearTimeout(forceKill); app.quit(); });
      child.kill('SIGTERM');
    }
  });

  app.on('window-all-closed', () => {
    // This is a single-window desktop app on every platform: closing the
    // window quits (macOS included — no tray/menu-bar mode).
    app.quit();
  });
}
