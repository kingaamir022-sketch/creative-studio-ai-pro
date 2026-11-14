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
// never data/, never uploads/, never node.exe/ffmpeg), replaced files are
// backed up first (last 2 backups kept), and Rollback restores the
// previous version. A package that needs fresh dependencies sets
// fullReinstall: true and is NEVER applied — the UI says plainly that
// it needs a fresh download.
//
// v2.2.4 — dependency updates in place: a package may ALSO carry a
// node_modules overlay (pure-JS dependency files only, every file
// SHA-256 verified, backup + rollback cover them too). Native modules
// (.node binaries) are refused — those releases still need fullReinstall.
// See docs/UPDATER.md for the full design.
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
// v2.2.4 — node_modules overlay (dependency updates in-app). A release
// that adds/changes a pure-JS production dependency may carry the changed
// package files under `node_modules/` in the update bundle. Caps keep a
// bad package from filling the disk; native modules are NEVER carried
// (a .node binary or binding.gyp needs a compiled build for the user's
// exact platform — those releases still set fullReinstall).
const MAX_OVERLAY_BYTES = 250 * 1024 * 1024;
const MAX_OVERLAY_FILES = 50000;

// App-code files only. Everything else (secrets, user data, runtimes) is
// never touched by an update package.
const ALLOWED = (p) => {
  if (!p || typeof p !== 'string') return false;
  if (p.includes('..') || path.isAbsolute(p) || p.includes('\\')) return false;
  return p === 'server.js' || p === 'package.json' || p === 'Start.bat' ||
    p.startsWith('src/') || p.startsWith('public/') || p.startsWith('docs/') ||
    p.startsWith('scripts/') || p.startsWith('.github/');
};
// Overlay files: only regular files under node_modules/, no traversal,
// no absolute paths, no backslashes, no symlinks (content is always a
// regular file in the bundle — there is no way to express a symlink).
const ALLOWED_OVERLAY = (p) => {
  if (!p || typeof p !== 'string') return false;
  if (p.includes('..') || path.isAbsolute(p) || p.includes('\\')) return false;
  if (!p.startsWith('node_modules/')) return false;
  if (p.endsWith('/')) return false;
  return true;
};
const isNativeFile = (p) => p.toLowerCase().endsWith('.node') || p.endsWith('binding.gyp');
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
// `addedFiles` (v2.2.4): node_modules files the update ADDS (they did not
// exist before) — on failure they are deleted, because restoring the
// backup cannot remove a file the backup never had.
function buildApplyBatch({ appDir, stagedDir, backupDir, pid, launcher, electronPid, addedFiles = [] }) {
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  const launch = launcher || path.join(appDir, 'Start.bat');
  const lines = [
    '@echo off',
    'REM CreativeStudio AI Pro — auto-update apply (written by the updater).',
    'REM Waits for the server to exit, swaps in the staged files, relaunches.',
    `set APPDIR=${q(appDir)}`,
    `set STAGED=${q(stagedDir)}`,
    `set BACKUP=${q(backupDir)}`,
    `set SRVPID=${pid || ''}`,
    // v2.7.1 — desktop app: also wait for the Electron parent process to
    // exit before copying, so the batch never fights the running shell.
    `set ELECTRONPID=${electronPid || ''}`,
    'timeout /t 2 /nobreak >nul',
    ':waitloop',
    'if "%SRVPID%"=="" goto waitloop2',
    'tasklist /FI "PID eq %SRVPID%" 2>nul | find /I "%SRVPID%" >nul',
    'if %errorlevel%==0 (timeout /t 1 /nobreak >nul & goto waitloop)',
    ':waitloop2',
    'if "%ELECTRONPID%"=="" goto docopy',
    'tasklist /FI "PID eq %ELECTRONPID%" 2>nul | find /I "%ELECTRONPID%" >nul',
    'if %errorlevel%==0 (timeout /t 1 /nobreak >nul & goto waitloop2)',
    ':docopy',
    `xcopy /E /Y /Q %STAGED%\\* %APPDIR%\\ >nul 2>&1`,
    'if %errorlevel% neq 0 goto failed',
    `start "" ${q(launch)}`,
    'del "%~f0"',
    'exit /b 0',
    ':failed',
    `echo Update copy failed — restoring backup. > ${q(path.join(appDir, 'update-error.log'))}`,
  ];
  if (addedFiles.length) {
    // Delete files the update added (the backup never had them, so a plain
    // restore would leave them behind). The list lives in the backup dir
    // as ADDED-FILES.txt, one Windows-style relative path per line.
    lines.push(`if exist ${q(path.join(backupDir, 'ADDED-FILES.txt'))} for /F "usebackq delims=" %%F in (${q(path.join(backupDir, 'ADDED-FILES.txt'))}) do if exist ${q('%APPDIR%\\%%F')} del /F /Q ${q('%APPDIR%\\%%F')} >nul 2>&1`);
  }
  lines.push(
    `xcopy /E /Y /Q %BACKUP%\\* %APPDIR%\\ >nul 2>&1`,
    'del "%~f0"',
    'exit /b 1',
  );
  return lines.join('\r\n');
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
    // v2.2.4: a package that carries native modules cannot be applied in
    // place — treat it as fullReinstall even if the publisher forgot the
    // flag, so the UI tells the user to download the fresh package.
    const fullReinstall = Boolean(manifest.fullReinstall || manifest.hasNativeModules);
    s.available = newer
      ? { version: manifest.version, notes: manifest.notes || '', publishedAt: manifest.publishedAt || '', fullReinstall, depsChanged: Array.isArray(manifest.depsChanged) ? manifest.depsChanged : [], hasNodeModules: Boolean(manifest.hasNodeModules) }
      : null;
    s.lastCheckError = null;
    saveState(s);
    return {
      configured: true, current: cur, latest: manifest.version, available: newer,
      notes: manifest.notes || '', fullReinstall, manifest,
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
    // v2.2.4 — node_modules overlay: every overlay file is verified the
    // same way (path allow-list + per-file SHA-256) BEFORE anything is
    // staged. Native modules are refused outright — they need a compiled
    // build for the user's platform, which an overlay cannot provide.
    const overlay = bundle.nodeModules || {};
    const overlayNames = Object.keys(overlay);
    if (bundle.hasNativeModules) {
      throw new Error('Update package contains native modules (.node binaries) — it cannot be applied in place. Download the fresh package instead (fullReinstall).');
    }
    if (overlayNames.length > MAX_OVERLAY_FILES) {
      throw new Error(`Update package carries too many dependency files (${overlayNames.length} > ${MAX_OVERLAY_FILES}) — rejected.`);
    }
    let overlayBytes = 0;
    for (const name of overlayNames) {
      if (!ALLOWED_OVERLAY(name)) throw new Error('Package contains a dependency file outside node_modules/: ' + name + ' — rejected.');
      if (isNativeFile(name)) throw new Error('Package contains a native module file: ' + name + ' — rejected (needs a fresh install).');
      const bytes = Buffer.from(overlay[name].content_b64, 'base64');
      if (sha256(bytes) !== overlay[name].sha256) throw new Error('File hash mismatch in package: ' + name + ' — rejected.');
      overlayBytes += bytes.length;
    }
    if (overlayBytes > MAX_OVERLAY_BYTES) {
      throw new Error(`Update package carries too much dependency data (${Math.round(overlayBytes / 1024 / 1024)} MB > ${MAX_OVERLAY_BYTES / 1024 / 1024} MB) — rejected. Download the fresh package instead (fullReinstall).`);
    }
    fs.rmSync(stagedDir, { recursive: true, force: true });
    fs.mkdirSync(stagedDir, { recursive: true });
    for (const name of names) {
      const dest = path.join(stagedDir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(bundle.files[name].content_b64, 'base64'));
    }
    for (const name of overlayNames) {
      const dest = path.join(stagedDir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(overlay[name].content_b64, 'base64'));
    }
    const s = state();
    s.staged = { version: bundle.version, notes: bundle.notes || '', fullReinstall: Boolean(bundle.fullReinstall), at: new Date().toISOString(), files: names, nodeModules: overlayNames, depsChanged: Array.isArray(bundle.depsChanged) ? bundle.depsChanged : [] };
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

  // Back up the files an update will replace — app files AND overlay
  // (node_modules) files — so rollback can restore both. Files the update
  // ADDS (no previous version on disk) are recorded in
  // `addedNodeModules` + ADDED-FILES.txt: rollback DELETES them instead
  // of restoring. Returns { dir, addedNodeModules }.
  function makeBackup(files, nodeModules, from, to) {
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
    const addedNodeModules = [];
    for (const name of nodeModules || []) {
      const cur = path.join(appDir, name);
      if (fs.existsSync(cur)) {
        const b = path.join(backupDir, name);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(cur, b);
      } else {
        addedNodeModules.push(name);
      }
    }
    fs.writeFileSync(path.join(backupDir, 'BACKUP-META.json'), JSON.stringify({ from, to, files, nodeModules: nodeModules || [], addedNodeModules, at: new Date().toISOString() }, null, 1));
    // Windows batch reads this (one Windows-style path per line) to delete
    // added files when a batch apply fails.
    fs.writeFileSync(path.join(backupDir, 'ADDED-FILES.txt'), addedNodeModules.map((p) => p.split('/').join('\\')).join('\r\n'));
    pruneBackups();
    return { dir: backupDir, addedNodeModules };
  }

  // Restore one file from the backup, or delete it when the backup never
  // had it (the update added it).
  function restoreOne(backupDir, name) {
    const b = path.join(backupDir, name);
    const dest = path.join(appDir, name);
    if (fs.existsSync(b)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(b, dest); }
    else if (fs.existsSync(dest)) fs.rmSync(dest);
  }

  // In-process apply (Linux / dev / tests): backup, copy, record history.
  // The new code takes effect after the server restarts.
  function applyStaged() {
    const s = state();
    if (!s.staged) throw new Error('No staged update to apply.');
    const from = currentVersion(), to = s.staged.version;
    const files = s.staged.files;
    const nodeModules = s.staged.nodeModules || [];
    const { dir: backupDir } = makeBackup(files, nodeModules, from, to);
    try {
      for (const name of files) {
        const dest = path.join(appDir, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(stagedDir, name), dest);
      }
      for (const name of nodeModules) {
        const dest = path.join(appDir, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(stagedDir, name), dest);
      }
    } catch (e) {
      // Half-applied install: restore the backup immediately and report.
      try {
        for (const name of files) restoreOne(backupDir, name);
        for (const name of nodeModules) restoreOne(backupDir, name);
      } catch { /* best effort; the backup on disk is still there */ }
      throw new Error('Apply failed, rolled back to ' + from + ': ' + (e.message || e));
    }
    s.history.push({ action: 'apply', from, to, at: new Date().toISOString(), backup: path.basename(backupDir), nodeModules: nodeModules.length });
    s.staged = null; s.available = null; s.pendingRestart = true; s.lastApplied = { version: to, at: new Date().toISOString() };
    saveState(s);
    return { from, to, backup: path.basename(backupDir), restartRequired: true, nodeModulesApplied: nodeModules.length };
  }

  // Windows apply: backup + write the apply batch, launch it detached, then
  // the caller exits the server. The batch waits for our PID, swaps the
  // files, and relaunches Start.bat. Returns {from, to, restarting: true}.
  // v2.7.1 — desktop mode: `opts.desktop` writes the restart flag (so the
  // Electron shell quits quietly instead of showing its crash dialog) and
  // the batch waits for the Electron PID too, relaunching via `launcher`
  // (the desktop exe) instead of Start.bat. With no opts the behaviour
  // is exactly as before: Start.bat launcher, no flag file.
  function applyViaBatch(opts = {}) {
    const s = state();
    if (!s.staged) throw new Error('No staged update to apply.');
    const from = currentVersion(), to = s.staged.version;
    const files = s.staged.files;
    const nodeModules = s.staged.nodeModules || [];
    const { dir: backupDir, addedNodeModules } = makeBackup(files, nodeModules, from, to);
    const batch = buildApplyBatch({
      appDir, stagedDir, backupDir, pid: process.pid,
      launcher: opts.launcher || path.join(appDir, 'Start.bat'),
      electronPid: opts.electronPid,
      addedFiles: addedNodeModules,
    });
    fs.mkdirSync(updDir, { recursive: true });
    fs.writeFileSync(batchFile, batch);
    s.history.push({ action: 'apply', from, to, at: new Date().toISOString(), backup: path.basename(backupDir), via: 'batch', nodeModules: nodeModules.length });
    s.staged = null; s.available = null; s.pendingRestart = true; s.lastApplied = { version: to, at: new Date().toISOString() };
    saveState(s);
    if (opts.desktop) writeUpdateRestartFlag();
    try {
      const child = spawn('cmd.exe', ['/c', batchFile], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (e) {
      throw new Error('Could not start the Windows apply batch: ' + (e.message || e));
    }
    return { from, to, backup: path.basename(backupDir), restarting: true, nodeModulesApplied: nodeModules.length };
  }

  function rollback() {
    const s = state();
    let backups = [];
    try { backups = fs.readdirSync(updDir).filter((d) => d.startsWith('backup-')).sort(); } catch { /* none */ }
    if (!backups.length) throw new Error('No backup available to roll back to.');
    const dir = path.join(updDir, backups[backups.length - 1]);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'BACKUP-META.json'), 'utf8'));
    for (const name of meta.files) restoreOne(dir, name);
    for (const name of meta.nodeModules || []) restoreOne(dir, name);
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

  // v2.7.1 — desktop update-restart flag. The server writes it when a
  // desktop (Electron) update apply starts; the Electron shell consumes
  // it on the server child's exit and quits quietly instead of showing
  // its "Server band ho gaya" crash dialog. The flag lives in updDir
  // (data/updates/), which the shell's dataDir shares, so both sides
  // see the same file. clear is a no-op when the flag is absent.
  const restartFlagFile = path.join(updDir, 'restarting-for-update');
  function writeUpdateRestartFlag() {
    fs.mkdirSync(updDir, { recursive: true });
    fs.writeFileSync(restartFlagFile, new Date().toISOString());
  }
  function clearUpdateRestartFlag() {
    try { fs.rmSync(restartFlagFile, { force: true }); } catch { /* absent or unreadable — nothing to clear */ }
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
    writeUpdateRestartFlag, clearUpdateRestartFlag,
    startUpdateChecker, updDir, stagedDir, batchFile,
  };
}

module.exports = {
  createUpdater, cmpVer, ALLOWED, ALLOWED_OVERLAY, isNativeFile,
  effectiveFeed, buildApplyBatch,
  DEFAULT_FEED_URL, MAX_BACKUPS, MAX_OVERLAY_BYTES, MAX_OVERLAY_FILES,
};
