'use strict';
// Self-update system for CreativeStudio AI Pro (v2.1.0) — modelled on
// PageCommand Pro's proven updater (src/lib/updater.js there), adapted to
// this project's layout (server.js, src/, public/, port 4820, SQLite in
// data/). The user's standing requirement, same as PageCommand: new
// features and fixes must arrive IN the app — no delete/reinstall, ever.
//
// Feed: a base URL (default: the project's GitHub repo, raw.githubusercontent)
// containing:
//   version.json           {app, version, notes, package, packageSha256,
//                           publishedAt, fullReinstall?}
//   update-<version>.json  bundle {app, version, notes, files:
//                           {path: {sha256, content_b64}}, fullReinstall?}
// A local folder feed is also supported (same two files in a folder).
// Packages are produced by scripts/publish-update.js.
//
// Safety (same as PageCommand): package SHA-256 verified, every file's
// SHA-256 verified, paths are allow-listed (app code only — never .env,
// never data/, never uploads/, never node_modules/, never node.exe/ffmpeg),
// replaced files are backed up first (last 2 backups kept), and Rollback
// restores the previous version. A package that needs fresh dependencies
// sets fullReinstall: true and is NEVER applied — the UI says plainly that
// it needs a fresh download.
//
// Windows file locks: the running server cannot be replaced safely from
// inside itself on Windows, so on win32 the apply writes a small
// apply-update.bat next to the install: it waits for the server process to
// exit, copies the staged files over the install (restoring the backup if
// a copy fails), then relaunches Start.bat. On other platforms the apply
// copies in-process and flags pendingRestart (restart the server to finish).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_FEED_URL = 'https://raw.githubusercontent.com/kingaamir022-sketch/creative-studio-ai-pro/main/updates';
const MAX_BACKUPS = 2;

// App-code files only. Everything else (secrets, user data, runtimes) is
// never touched by an update package.
const ALLOWED = (p) => {
  if (!p || typeof p !== 'string') return false;
  if (p.includes('..') || path.isAbsolute(p) || p.includes('\\')) return false;
  return p === 'server.js' || p === 'package.json' || p === 'Start.bat' ||
    p.startsWith('src/') || p.startsWith('public/') || p.startsWith('docs/') ||
    p.startsWith('scripts/') || p.startsWith('.github/');
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const cmpVer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); }
  return 0;
};

// The feed's effective type: an http(s) value is ALWAYS a URL feed, even
// if the stored type says 'folder' (PageCommand's lesson: a user pasted the
// update URL while the type dropdown still said Folder, and the app went
// looking for a local file named after the URL). The value wins.
function effectiveFeed(st) {
  const value = String((st && (st.feedUrl || st.feed)) || '').trim();
  if (/^https?:\/\//i.test(value)) return { type: 'url', value };
  return { type: (st && st.feedType) || 'url', value };
}

// The Windows apply batch (pure function — unit-testable without Windows).
// Waits for the server PID to disappear, copies staged files over the
// install, restores the backup if a copy fails, then relaunches Start.bat.
function buildApplyBatch({ appDir, stagedDir, backupDir, pid, launcher }) {
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  const launch = launcher || path.join(appDir, 'Start.bat');
  return [
    '@echo off',
    'REM CreativeStudio AI Pro — auto-update apply (written by the updater).',
    'REM Waits for the server to exit, swaps in the staged files, relaunches.',
    `set APPDIR=${q(appDir)}`,
    `set STAGED=${q(stagedDir)}`,
    `set BACKUP=${q(backupDir)}`,
    `set SRVPID=${pid || ''}`,
    'timeout /t 2 /nobreak >nul',
    ':waitloop',
    'if "%SRVPID%"=="" goto docopy',
    'tasklist /FI "PID eq %SRVPID%" 2>nul | find /I "%SRVPID%" >nul',
    'if %errorlevel%==0 (timeout /t 1 /nobreak >nul & goto waitloop)',
    ':docopy',
    `xcopy /E /Y /Q %STAGED%\\* %APPDIR%\\ >nul 2>&1`,
    'if %errorlevel% neq 0 goto failed',
    `start "" ${q(launch)}`,
    'del "%~f0"',
    'exit /b 0',
    ':failed',
    `echo Update copy failed — restoring backup. > ${q(path.join(appDir, 'update-error.log'))}`,
    `xcopy /E /Y /Q %BACKUP%\\* %APPDIR%\\ >nul 2>&1`,
    'del "%~f0"',
    'exit /b 1',
  ].join('\r\n');
}

function createUpdater(appDir, dataDir) {
  const updDir = path.join(dataDir, 'updates');
  const stateFile = path.join(updDir, 'state.json');
  const stagedDir = path.join(updDir, 'staged');
  const batchFile = path.join(updDir, 'apply-update.bat');

  const state = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch { return { lastCheck: null, lastCheckError: null, available: null, staged: null, pendingRestart: false, dismissed: {}, history: [], lastApplied: null }; }
  };
  const saveState = (s) => {
    fs.mkdirSync(updDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(s, null, 1));
  };
  const currentVersion = () => {
    try { return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version; }
    catch { return '0.0.0'; }
  };

  async function readFeed(feed, name) {
    if (feed.type === 'folder') {
      const fp = path.join(feed.value, name);
      if (!fs.existsSync(fp)) throw new Error('Feed file not found: ' + fp);
      return fs.readFileSync(fp);
    }
    const url = feed.value.replace(/\/$/, '') + '/' + name;
    let r;
    try {
      r = await fetch(url, { headers: { 'User-Agent': 'CreativeStudio-Updater' } });
    } catch (e) {
      throw new Error('Feed not reachable: ' + (e.message || e));
    }
    if (!r.ok) throw new Error(`Feed not reachable: HTTP ${r.status} for ${name}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async function check(feed) {
    const s = state();
    s.lastCheck = new Date().toISOString();
    if (!feed || !feed.value) {
      s.available = null; s.lastCheckError = 'No update feed configured.';
      saveState(s);
      return { configured: false, current: currentVersion(), feedReachable: false, error: s.lastCheckError };
    }
    let manifest;
    try {
      manifest = JSON.parse((await readFeed(feed, 'version.json')).toString('utf8'));
    } catch (e) {
      s.available = null; s.lastCheckError = String(e.message || e);
      saveState(s);
      return { configured: true, current: currentVersion(), feedReachable: false, error: s.lastCheckError };
    }
    if (!manifest || typeof manifest.version !== 'string' || !manifest.package) {
      s.available = null; s.lastCheckError = 'Feed manifest is invalid (missing version/package).';
      saveState(s);
      return { configured: true, current: currentVersion(), feedReachable: false, error: s.lastCheckError };
    }
    const cur = currentVersion();
    const newer = cmpVer(manifest.version, cur) > 0;
    s.available = newer
      ? { version: manifest.version, notes: manifest.notes || '', publishedAt: manifest.publishedAt || '', fullReinstall: Boolean(manifest.fullReinstall) }
      : null;
    s.lastCheckError = null;
    saveState(s);
    return {
      configured: true, current: cur, latest: manifest.version, available: newer,
      notes: manifest.notes || '', fullReinstall: Boolean(manifest.fullReinstall), manifest,
    };
  }

  async function downloadAndStage(feed, manifest) {
    const raw = await readFeed(feed, manifest.package);
    if (sha256(raw) !== manifest.packageSha256) {
      throw new Error('Update package hash mismatch — package rejected (tampered or corrupt).');
    }
    const bundle = JSON.parse(raw.toString('utf8'));
    if (bundle.version !== manifest.version) throw new Error('Package version does not match the feed manifest.');
    const names = Object.keys(bundle.files || {});
    if (!names.length) throw new Error('Update package has no files — rejected.');
    for (const name of names) {
      if (!ALLOWED(name)) throw new Error('Package contains a file outside the app code area: ' + name + ' — rejected.');
      const bytes = Buffer.from(bundle.files[name].content_b64, 'base64');
      if (sha256(bytes) !== bundle.files[name].sha256) throw new Error('File hash mismatch in package: ' + name + ' — rejected.');
    }
    fs.rmSync(stagedDir, { recursive: true, force: true });
    fs.mkdirSync(stagedDir, { recursive: true });
    for (const name of names) {
      const dest = path.join(stagedDir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(bundle.files[name].content_b64, 'base64'));
    }
    const s = state();
    s.staged = { version: bundle.version, notes: bundle.notes || '', fullReinstall: Boolean(bundle.fullReinstall), at: new Date().toISOString(), files: names };
    saveState(s);
    return s.staged;
  }

  function pruneBackups() {
    let dirs = [];
    try { dirs = fs.readdirSync(updDir).filter((d) => d.startsWith('backup-')).sort(); } catch { return; }
    while (dirs.length > MAX_BACKUPS) {
      const old = dirs.shift();
      try { fs.rmSync(path.join(updDir, old), { recursive: true, force: true }); } catch { /* keep going */ }
    }
  }

  function makeBackup(files, from, to) {
    const backupDir = path.join(updDir, 'backup-' + from + '-' + Date.now());
    fs.mkdirSync(backupDir, { recursive: true });
    for (const name of files) {
      const cur = path.join(appDir, name);
      if (fs.existsSync(cur)) {
        const b = path.join(backupDir, name);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(cur, b);
      }
    }
    fs.writeFileSync(path.join(backupDir, 'BACKUP-META.json'), JSON.stringify({ from, to, files, at: new Date().toISOString() }, null, 1));
    pruneBackups();
    return backupDir;
  }

  // In-process apply (Linux / dev / tests): backup, copy, record history.
  // The new code takes effect after the server restarts.
  function applyStaged() {
    const s = state();
    if (!s.staged) throw new Error('No staged update to apply.');
    const from = currentVersion(), to = s.staged.version;
    const files = s.staged.files;
    const backupDir = makeBackup(files, from, to);
    try {
      for (const name of files) {
        const dest = path.join(appDir, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(stagedDir, name), dest);
      }
    } catch (e) {
      // Half-applied install: restore the backup immediately and report.
      try {
        for (const name of files) {
          const b = path.join(backupDir, name), dest = path.join(appDir, name);
          if (fs.existsSync(b)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(b, dest); }
          else if (fs.existsSync(dest)) fs.rmSync(dest);
        }
      } catch { /* best effort; the backup on disk is still there */ }
      throw new Error('Apply failed, rolled back to ' + from + ': ' + (e.message || e));
    }
    s.history.push({ action: 'apply', from, to, at: new Date().toISOString(), backup: path.basename(backupDir) });
    s.staged = null; s.available = null; s.pendingRestart = true; s.lastApplied = { version: to, at: new Date().toISOString() };
    saveState(s);
    return { from, to, backup: path.basename(backupDir), restartRequired: true };
  }

  // Windows apply: backup + write the apply batch, launch it detached, then
  // the caller exits the server. The batch waits for our PID, swaps the
  // files, and relaunches Start.bat. Returns {from, to, restarting: true}.
  function applyViaBatch() {
    const s = state();
    if (!s.staged) throw new Error('No staged update to apply.');
    const from = currentVersion(), to = s.staged.version;
    const files = s.staged.files;
    const backupDir = makeBackup(files, from, to);
    const batch = buildApplyBatch({
      appDir, stagedDir, backupDir, pid: process.pid,
      launcher: path.join(appDir, 'Start.bat'),
    });
    fs.mkdirSync(updDir, { recursive: true });
    fs.writeFileSync(batchFile, batch);
    s.history.push({ action: 'apply', from, to, at: new Date().toISOString(), backup: path.basename(backupDir), via: 'batch' });
    s.staged = null; s.available = null; s.pendingRestart = true; s.lastApplied = { version: to, at: new Date().toISOString() };
    saveState(s);
    try {
      const child = spawn('cmd.exe', ['/c', batchFile], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (e) {
      throw new Error('Could not start the Windows apply batch: ' + (e.message || e));
    }
    return { from, to, backup: path.basename(backupDir), restarting: true };
  }

  function rollback() {
    const s = state();
    let backups = [];
    try { backups = fs.readdirSync(updDir).filter((d) => d.startsWith('backup-')).sort(); } catch { /* none */ }
    if (!backups.length) throw new Error('No backup available to roll back to.');
    const dir = path.join(updDir, backups[backups.length - 1]);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'BACKUP-META.json'), 'utf8'));
    for (const name of meta.files) {
      const b = path.join(dir, name), dest = path.join(appDir, name);
      if (fs.existsSync(b)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(b, dest); }
      else if (fs.existsSync(dest)) fs.rmSync(dest); // file was added by the update
    }
    s.history.push({ action: 'rollback', from: meta.to, to: meta.from, at: new Date().toISOString() });
    s.pendingRestart = true; s.lastApplied = null;
    saveState(s);
    return { restored: meta.from };
  }

  function backupsCount() {
    try { return fs.readdirSync(updDir).filter((d) => d.startsWith('backup-')).length; }
    catch { return 0; }
  }
  function dismiss(version) {
    const s = state();
    s.dismissed[version] = new Date().toISOString();
    saveState(s);
    return s.dismissed;
  }
  function clearPendingRestart() {
    const s = state();
    if (s.pendingRestart) { s.pendingRestart = false; saveState(s); }
  }

  // Auto-check loop: first check after `initialDelayMs`, then every
  // `intervalMs`. Never throws — a failed check is recorded, never fatal.
  // getSettings: () => ({feedType, feedUrl, autoCheck, autoApply}).
  // onAvailable: async ({version, notes, fullReinstall}) — the caller
  // decides whether to auto-apply (autoApply ON) or just notify.
  function startUpdateChecker(getSettings, onAvailable, opts = {}) {
    const intervalMs = opts.intervalMs || 6 * 60 * 60 * 1000;
    const initialDelayMs = opts.initialDelayMs != null ? opts.initialDelayMs : 10000;
    let timer = null;
    let running = false;
    async function tick() {
      if (running) return;
      running = true;
      try {
        const st = getSettings();
        if (!st || st.autoCheck === false) return;
        const feed = effectiveFeed(st);
        const res = await check(feed);
        if (res.available && onAvailable) await onAvailable(res);
      } catch (e) {
        console.error('[updater] auto-check failed:', e.message || e);
      } finally { running = false; }
    }
    const startTimer = setTimeout(() => { tick(); timer = setInterval(tick, intervalMs); }, initialDelayMs);
    return {
      stop() { clearTimeout(startTimer); if (timer) clearInterval(timer); },
      checkNow: tick,
    };
  }

  return {
    currentVersion, check, downloadAndStage, applyStaged, applyViaBatch,
    rollback, state, backupsCount, dismiss, clearPendingRestart,
    startUpdateChecker, updDir, stagedDir, batchFile,
  };
}

module.exports = {
  createUpdater, cmpVer, ALLOWED, effectiveFeed, buildApplyBatch,
  DEFAULT_FEED_URL, MAX_BACKUPS,
};
