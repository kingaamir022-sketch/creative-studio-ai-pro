'use strict';
// Auto-update API (v2.1.0) — PageCommand-Pro-style self-update.
// Settings live in the app_settings DB table; runtime state (last check,
// available version, staged package, history, dismissals) lives in
// data/updates/state.json via src/updater.js.
const express = require('express');
const path = require('path');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const { createUpdater, effectiveFeed, DEFAULT_FEED_URL } = require('../updater');

const router = express.Router();
const ADMIN = ['OWNER', 'ADMIN'];

const appDir = process.env.CS_UPDATE_APP_DIR || config.root;
const dataDir = path.dirname(config.dbPath);
const updater = createUpdater(appDir, dataDir);

function getSettings() {
  return {
    feedType: db.getAppSetting('updates.feedType', 'url') || 'url',
    feedUrl: db.getAppSetting('updates.feedUrl', DEFAULT_FEED_URL) || DEFAULT_FEED_URL,
    autoCheck: db.getAppSetting('updates.autoCheck', '1') !== '0',
    autoApply: db.getAppSetting('updates.autoApply', '0') === '1',
  };
}

function statusPayload() {
  const st = updater.state();
  const settings = getSettings();
  const available = st.available;
  return {
    current: updater.currentVersion(),
    feed: { type: effectiveFeed(settings).type, url: settings.feedUrl, storedType: settings.feedType },
    autoCheck: settings.autoCheck,
    autoApply: settings.autoApply,
    lastCheck: st.lastCheck,
    lastCheckError: st.lastCheckError,
    feedReachable: st.lastCheck ? !st.lastCheckError : null,
    available: available || null,
    availableDismissed: available ? Boolean(st.dismissed[available.version]) : false,
    latest: available ? available.version : updater.currentVersion(),
    staged: st.staged || null,
    pendingRestart: Boolean(st.pendingRestart),
    lastApplied: st.lastApplied || null,
    backups: updater.backupsCount(),
    history: (st.history || []).slice(-10),
  };
}

// --- Status (any signed-in user may see it) ---
router.get('/status', auth.requireAuth, (req, res) => {
  res.json(statusPayload());
});

// --- Manual check (OWNER/ADMIN) ---
router.post('/check', auth.requireAuth, auth.requireRole(...ADMIN), async (req, res) => {
  const settings = getSettings();
  const feed = effectiveFeed(settings);
  const res2 = await updater.check(feed);
  if (!res2.configured || res2.error) {
    return res.status(502).json({ ok: false, error: res2.error || 'Update feed is not configured.', ...statusPayload() });
  }
  res.json({ ok: true, ...statusPayload(), notes: res2.notes || '' });
});

// --- Apply the available update (OWNER/ADMIN) ---
router.post('/apply', auth.requireAuth, auth.requireRole(...ADMIN), async (req, res) => {
  const settings = getSettings();
  const feed = effectiveFeed(settings);
  const st = updater.state();
  try {
    let manifest = null;
    if (st.available) {
      // Re-check so the manifest (and fullReinstall flag) is fresh.
      const res2 = await updater.check(feed);
      if (res2.error) return res.status(502).json({ error: 'Feed check failed before apply: ' + res2.error });
      manifest = res2.manifest;
    } else {
      const res2 = await updater.check(feed);
      if (res2.error) return res.status(502).json({ error: 'Feed check failed before apply: ' + res2.error });
      if (!res2.available) return res.status(409).json({ error: 'No update is available.' });
      manifest = res2.manifest;
    }
    if (manifest.fullReinstall || manifest.hasNativeModules) {
      return res.status(409).json({
        error: 'This update needs a fresh download (it changes dependencies in a way that cannot be applied in place). It was NOT applied — download the new portable/source package from Drive instead.',
        fullReinstall: true,
      });
    }
    await updater.downloadAndStage(feed, manifest);
    let out;
    if (process.platform === 'win32') {
      out = updater.applyViaBatch();
      // Give the HTTP response a moment to leave, then exit so the batch
      // can swap the files and relaunch Start.bat.
      setTimeout(() => { console.log('[updater] exiting for update apply, batch will relaunch.'); process.exit(0); }, 600);
      return res.json({ ok: true, ...out, message: `Update ${out.to} staged — the app is restarting to apply it.` });
    }
    out = updater.applyStaged();
    db.audit(req.user.id, 'update_applied', 'system', null, `Updated ${out.from} → ${out.to} (restart to finish)`);
    return res.json({ ok: true, ...out, message: `Update ${out.to} applied — restart the server to finish.` });
  } catch (e) {
    return res.status(502).json({ error: 'Update failed: ' + (e.message || e) });
  }
});

// --- Roll back to the latest backup (OWNER/ADMIN) ---
router.post('/rollback', auth.requireAuth, auth.requireRole(...ADMIN), (req, res) => {
  try {
    const out = updater.rollback();
    db.audit(req.user.id, 'update_rollback', 'system', null, `Rolled back to ${out.restored}`);
    res.json({ ok: true, ...out, message: `Rolled back to ${out.restored} — restart the server to finish.`, pendingRestart: true });
  } catch (e) {
    res.status(409).json({ error: e.message || 'Rollback failed.' });
  }
});

// --- Dismiss an available version's banner (any signed-in user, own view) ---
router.post('/dismiss', auth.requireAuth, (req, res) => {
  const { version } = req.body || {};
  if (!version || typeof version !== 'string') return res.status(400).json({ error: 'version is required.' });
  updater.dismiss(version);
  res.json({ ok: true, dismissed: version });
});

// --- Settings (OWNER/ADMIN) ---
router.get('/settings', auth.requireAuth, auth.requireRole(...ADMIN), (req, res) => {
  res.json(getSettings());
});

router.post('/settings', auth.requireAuth, auth.requireRole(...ADMIN), (req, res) => {
  const { feedType, feedUrl, autoCheck, autoApply } = req.body || {};
  if (feedType !== undefined) {
    if (!['url', 'folder'].includes(feedType)) return res.status(400).json({ error: "feedType must be 'url' or 'folder'." });
    db.setAppSetting('updates.feedType', feedType);
  }
  if (feedUrl !== undefined) {
    if (typeof feedUrl !== 'string' || !feedUrl.trim()) return res.status(400).json({ error: 'feedUrl must not be empty.' });
    db.setAppSetting('updates.feedUrl', feedUrl.trim());
  }
  if (autoCheck !== undefined) db.setAppSetting('updates.autoCheck', autoCheck ? '1' : '0');
  if (autoApply !== undefined) db.setAppSetting('updates.autoApply', autoApply ? '1' : '0');
  db.audit(req.user.id, 'update_settings', 'system', null, 'Update settings saved');
  res.json(getSettings());
});

// --- Auto-check loop (started from server.js) ---
// When autoApply is ON and an update is found: stage it and apply it
// (Windows batch path, or in-process + pendingRestart elsewhere). When OFF:
// just record it — the dashboard banner does the notifying.
async function autoApplyAvailable(res2) {
  if (res2.fullReinstall) {
    console.log('[updater] update ' + res2.latest + ' needs a fresh download (fullReinstall) — not auto-applied.');
    return;
  }
  try {
    const settings = getSettings();
    const manifest = res2.manifest;
    await updater.downloadAndStage(effectiveFeed(settings), manifest);
    if (process.platform === 'win32') {
      updater.applyViaBatch();
      setTimeout(() => { console.log('[updater] exiting for auto-update apply.'); process.exit(0); }, 600);
    } else {
      const out = updater.applyStaged();
      console.log(`[updater] auto-applied ${out.from} → ${out.to}; restart to finish.`);
    }
  } catch (e) {
    console.error('[updater] auto-apply failed:', e.message || e);
  }
}

function startUpdateChecker(opts = {}) {
  const intervalMs = opts.intervalMs || Number(process.env.UPDATE_CHECK_INTERVAL_MS || 6 * 60 * 60 * 1000);
  const initialDelayMs = opts.initialDelayMs != null
    ? opts.initialDelayMs
    : Number(process.env.UPDATE_CHECK_INITIAL_DELAY_MS || 10000);
  return updater.startUpdateChecker(getSettings, async (res2) => {
    const settings = getSettings();
    if (settings.autoApply) await autoApplyAvailable(res2);
    // autoApply OFF: the check already recorded `available` — the
    // dashboard banner notifies the user. Nothing else to do.
  }, { intervalMs, initialDelayMs });
}

module.exports = router;
module.exports.startUpdateChecker = startUpdateChecker;
module.exports._updater = updater;
module.exports._getSettings = getSettings;
