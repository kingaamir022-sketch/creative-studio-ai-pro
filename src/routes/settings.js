'use strict';
// Settings pages API (v2.5.0, #55) — Performance, Draft/Cache, project
// defaults, language, privacy/data. Mount: app.use('/api/settings', …).
//
// Settings are per-user, stored in user_settings (created here, in this
// module — no db.js edit). The app_settings table stays for the
// app-global keys the updater already uses; nothing here touches it.
// Every value returned is either the user's stored value or a documented
// default — no setting is shown as saved when it is not.
//
// Honest limits, stated where the UI reads them:
//   - proxy: stored per user + per project (project settings dialog);
//     the video editor preview does not yet consume it, so the dialog
//     says so instead of pretending the preview is proxied.
//   - hardwareEncode: offered only when the local FFmpeg build actually
//     has a hardware encoder (checked live); otherwise the setting is
//     stored but reported unavailable.
//   - language: stored; the interface itself is English-only today, so
//     the UI says the choice applies where translations exist.
//   - face detection: available only if a local face model file exists
//     in the models dir. Only the background-removal model ships, so
//     today this reports not available — it is never faked.
//   - cache clear: removes only regenerable temp files (renders *.tmp /
//     tmp-*); thumbnails and renders are kept. The response reports the
//     exact bytes freed.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');

const router = express.Router();

db.db.exec(`CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);`);

const MODELS_DIR = process.env.MODELS_DIR || path.join(config.root, 'data', 'models');

const DEFAULTS = {
  performance: {
    proxyEnabled: false, proxyResolution: '540p', hardwareEncode: false, previewQuality: 'full',
  },
  projectDefaults: {
    defaultAspect: '16:9', defaultResolution: '1080p', defaultFps: 30,
    defaultAutosave: true, defaultAutosaveIntervalSeconds: 30, defaultProxy: false,
    printColorMode: 'RGB',
  },
  language: { language: 'en' },
  privacy: { analyticsOptOut: false, shareUsageData: false },
  cache: { cacheLocation: 'default' },
};

function getUserSettings(userId) {
  const rows = db.db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(userId);
  const out = {};
  for (const r of rows) {
    const [group, key] = r.key.split('.', 2);
    if (!group || !key) continue;
    if (!out[group]) out[group] = {};
    let v = r.value;
    try { v = JSON.parse(r.value); } catch { /* plain string */ }
    out[group][key] = v;
  }
  const merged = {};
  for (const [group, defs] of Object.entries(DEFAULTS)) merged[group] = { ...defs, ...(out[group] || {}) };
  return merged;
}

function setGroupSettings(userId, group, values) {
  const defs = DEFAULTS[group];
  if (!defs) return null;
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    if (!(key in defs)) continue;
    db.db.prepare(`INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?,?,?,datetime('now'))
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
      .run(userId, `${group}.${key}`, JSON.stringify(value));
    saved[key] = value;
  }
  return { ...defs, ...getUserSettings(userId)[group] };
}

const VALID = {
  performance: {
    proxyEnabled: (v) => typeof v === 'boolean',
    proxyResolution: (v) => ['360p', '540p', '720p'].includes(v),
    hardwareEncode: (v) => typeof v === 'boolean',
    previewQuality: (v) => ['performance', 'full'].includes(v),
  },
  projectDefaults: {
    defaultAspect: (v) => ['16:9', '9:16', '1:1', '4:5'].includes(v),
    defaultResolution: (v) => ['720p', '1080p'].includes(v),
    defaultFps: (v) => [24, 30, 60].includes(v),
    defaultAutosave: (v) => typeof v === 'boolean',
    defaultAutosaveIntervalSeconds: (v) => Number.isInteger(v) && v >= 5 && v <= 600,
    defaultProxy: (v) => typeof v === 'boolean',
    printColorMode: (v) => ['RGB', 'CMYK'].includes(v),
  },
  language: {
    language: (v) => ['en', 'ur', 'ar', 'es', 'fr', 'de'].includes(v),
  },
  privacy: {
    analyticsOptOut: (v) => typeof v === 'boolean',
    shareUsageData: (v) => typeof v === 'boolean',
  },
  cache: {
    cacheLocation: (v) => typeof v === 'string' && v.length <= 200,
  },
};

function dirSize(dir) {
  let bytes = 0; let files = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(full);
        else { bytes += fs.statSync(full).size; files += 1; }
      } catch { /* unreadable entry — skip */ }
    }
  };
  walk(dir);
  return { bytes, files };
}

let hwCache = null;
function hardwareEncoders() {
  if (hwCache) return Promise.resolve(hwCache);
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-encoders']);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve({ available: [], note: 'FFmpeg was not found, so hardware encoding cannot be checked.' }));
    p.on('close', (code) => {
      if (code !== 0) return resolve({ available: [], note: 'FFmpeg did not list encoders.' });
      const found = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox', 'hevc_nvenc', 'hevc_qsv']
        .filter((name) => new RegExp(`\\b${name}\\b`).test(out));
      hwCache = { available: found, note: found.length ? '' : 'This FFmpeg build has no hardware encoder — renders use software encoding (libx264).' };
      resolve(hwCache);
    });
  });
}

function faceDetectionStatus() {
  try {
    if (!fs.existsSync(MODELS_DIR)) return { available: false, reason: 'No models directory exists on this install.' };
    const files = fs.readdirSync(MODELS_DIR);
    const face = files.filter((f) => /face/i.test(f));
    if (face.length) return { available: true, models: face, reason: '' };
    return {
      available: false,
      reason: 'No local face-detection model is installed (the models folder only holds the background-removal model). Face grouping is not available and is not faked — add a local face model file to enable it.',
      models: files,
    };
  } catch (e) {
    return { available: false, reason: `Could not read the models directory: ${e.message}` };
  }
}

// --- Settings groups ---------------------------------------------------------
router.get('/', auth.requireAuth, async (req, res) => {
  const settings = getUserSettings(req.user.id);
  const hw = await hardwareEncoders();
  const thumbs = dirSize(path.join(config.uploadsDir, String(req.user.id)));
  const renders = dirSize(config.rendersDir);
  res.json({
    settings,
    performance: {
      ...settings.performance,
      hardwareEncoders: hw.available,
      hardwareEncodeAvailable: hw.available.length > 0,
      hardwareNote: hw.note,
      previewNote: 'Preview quality applies to the editor preview. "Performance" renders the preview at a lower resolution; "Full" renders it at project resolution.',
      proxyNote: 'Proxy renders are used by the editor preview when it supports them. This build stores the setting; the current preview still renders at full quality.',
    },
    cache: {
      ...settings.cache,
      uploadsBytes: thumbs.bytes, uploadsFiles: thumbs.files,
      rendersBytes: renders.bytes, rendersFiles: renders.files,
      totalBytes: thumbs.bytes + renders.bytes,
      location: config.uploadsDir,
      note: 'Cache size counts your uploads and renders on disk. "Clear cache" removes only regenerable temp files (*.tmp, tmp-*); your media, thumbnails and finished renders are kept.',
    },
    languageNote: 'Stored for your account. The interface itself is English-only today — the choice applies where translations exist.',
    faceDetection: faceDetectionStatus(),
  });
});

router.put('/:group', auth.requireAuth, (req, res) => {
  const group = req.params.group;
  if (!VALID[group]) return res.status(400).json({ error: `Unknown settings group. Use one of: ${Object.keys(VALID).join(', ')}.` });
  const values = req.body || {};
  for (const [key, value] of Object.entries(values)) {
    if (!VALID[group][key]) return res.status(400).json({ error: `Unknown setting "${key}" for group "${group}".` });
    if (!VALID[group][key](value)) return res.status(400).json({ error: `Invalid value for "${key}".` });
  }
  const saved = setGroupSettings(req.user.id, group, values);
  db.audit(req.user.id, 'settings_updated', 'settings', null, `Settings group "${group}" updated`);
  res.json({ group, settings: saved });
});

// Clear cache: regenerable temp files only. Reports exactly what was freed.
router.post('/cache/clear', auth.requireAuth, (req, res) => {
  let freedBytes = 0; let removed = 0;
  const sweep = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) { sweep(full); return; }
        if (/\.tmp$/.test(e.name) || /^tmp-/.test(e.name)) {
          freedBytes += fs.statSync(full).size;
          fs.unlinkSync(full);
          removed += 1;
        }
      } catch { /* keep going */ }
    }
  };
  sweep(config.rendersDir);
  sweep(path.join(config.uploadsDir, String(req.user.id)));
  db.audit(req.user.id, 'cache_cleared', 'settings', null, `Cache cleared: ${removed} temp file(s), ${freedBytes} bytes freed`);
  res.json({ ok: true, removedFiles: removed, freedBytes, note: 'Only regenerable temp files were removed. Media, thumbnails and finished renders were kept.' });
});

// Export my data (summary): counts + settings as JSON. No other user's data.
router.get('/export', auth.requireAuth, (req, res) => {
  const one = (sql) => db.db.prepare(sql).get(req.user.id).c;
  res.json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, plan: req.user.plan },
    counts: {
      projects: one('SELECT COUNT(*) AS c FROM projects WHERE user_id = ?'),
      media: one('SELECT COUNT(*) AS c FROM media WHERE user_id = ?'),
      socialPosts: one('SELECT COUNT(*) AS c FROM social_posts WHERE user_id = ?'),
      socialConnections: one('SELECT COUNT(*) AS c FROM social_connections WHERE user_id = ?'),
      sharedWithMe: db.db.prepare('SELECT COUNT(*) AS c FROM project_shares WHERE shared_with_user_id = ?').get(req.user.id).c,
    },
    settings: getUserSettings(req.user.id),
    exportedAt: new Date().toISOString(),
    note: 'This is a summary of your own data on this install. Full file export (media + project JSON) is not included — download media from the Media Library.',
  });
});

// --- Print sizes + checklist (v2.5.0 #27) ------------------------------------
const PRINT_SIZES = [
  { id: 'A5', name: 'A5', widthMm: 148, heightMm: 210 },
  { id: 'A4', name: 'A4', widthMm: 210, heightMm: 297 },
  { id: 'A3', name: 'A3', widthMm: 297, heightMm: 420 },
  { id: 'A6', name: 'A6', widthMm: 105, heightMm: 148 },
  { id: 'flyer', name: 'Flyer', widthMm: 210, heightMm: 297 },
  { id: 'business-card', name: 'Business card', widthMm: 85, heightMm: 55 },
  { id: 'custom', name: 'Custom size', widthMm: null, heightMm: null },
];
router.get('/print-sizes', auth.requireAuth, (req, res) => {
  res.json({ sizes: PRINT_SIZES, note: 'Print sizes for the print-ready checklist. The PDF export itself lives in the Print view; this checklist runs before you export.' });
});

// Print-ready checklist for a design project (or explicit dimensions):
// bleed, safe zone, resolution at 300 dpi, and CMYK state. CMYK state
// comes from the user's own setting (projectDefaults.printColorMode,
// default RGB). The checklist never claims CMYK when the setting says RGB.
router.get('/print-checklist', auth.requireAuth, (req, res) => {
  let width = Number(req.query.width);
  let height = Number(req.query.height);
  let name = 'Custom design';
  const sizeId = String(req.query.size || '');
  const size = PRINT_SIZES.find((s) => s.id === sizeId);
  if (req.query.projectId) {
    const p = db.getProjectAny(req.query.projectId);
    if (!p) return res.status(404).json({ error: 'Project not found.' });
    if (p.user_id !== req.user.id && !db.canViewProject(req.user.id, p)) {
      return res.status(403).json({ error: 'This project has not been shared with you.' });
    }
    name = p.name;
    try {
      const content = JSON.parse(p.content || '{}');
      if (Number.isFinite(content.width)) width = content.width;
      if (Number.isFinite(content.height)) height = content.height;
    } catch { /* fall through to query params */ }
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return res.status(400).json({ error: 'Give a projectId or width/height in pixels.' });
  }
  const settings = getUserSettings(req.user.id);
  const colorMode = (db.db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'projectDefaults.printColorMode'")
    .get(req.user.id) || {}).value;
  const cmyk = colorMode ? JSON.parse(colorMode) === 'CMYK' : false;
  // Resolution: pixels per inch at the chosen print size (default A4 when
  // no size is given). 300 dpi is print-ready; 150–300 is usable with a
  // warning; below 150 is not print-ready.
  const wMm = size && size.widthMm ? size.widthMm : (req.query.widthMm ? Number(req.query.widthMm) : 210);
  const hMm = size && size.heightMm ? size.heightMm : (req.query.heightMm ? Number(req.query.heightMm) : 297);
  const dpiW = Math.round((width / wMm) * 25.4);
  const dpiH = Math.round((height / hMm) * 25.4);
  const dpi = Math.min(dpiW, dpiH);
  const items = [
    {
      id: 'size', label: 'Print size', status: 'pass',
      detail: size ? `${size.name} — ${wMm}×${hMm} mm` : `Custom — ${wMm}×${hMm} mm`,
    },
    {
      id: 'resolution', label: 'Resolution at 300 dpi', status: dpi >= 300 ? 'pass' : dpi >= 150 ? 'warn' : 'fail',
      detail: `${width}×${height} px prints at ~${dpi} dpi on ${wMm}×${hMm} mm${dpi >= 300 ? ' — print-ready.' : dpi >= 150 ? ' — usable, but soft at close range. Use a larger design for crisp print.' : ' — too low for print. Make the design bigger (300 dpi needs ' + Math.round(wMm / 25.4 * 300) + '×' + Math.round(hMm / 25.4 * 300) + ' px).'}`,
    },
    {
      id: 'bleed', label: 'Bleed (3 mm)', status: 'warn',
      detail: 'This app does not record a bleed margin on designs yet — add 3 mm of bleed around the edges before sending to print (the Print view already exports full-bleed PDFs).',
    },
    {
      id: 'safe-zone', label: 'Safe zone', status: 'warn',
      detail: 'Keep text and logos at least 5 mm inside the trim edge. The checklist cannot measure your margins automatically — check the preview before exporting.',
    },
    {
      id: 'cmyk', label: 'Colour mode (CMYK)', status: cmyk ? 'pass' : 'warn',
      detail: cmyk
        ? 'CMYK is selected in your project defaults — export as CMYK.'
        : 'RGB is selected (default). For professional print, switch the colour mode to CMYK in Settings → Project defaults before exporting.',
    },
  ];
  const blocked = items.some((i) => i.status === 'fail');
  res.json({
    project: name, size: size ? size.id : 'custom', widthMm: wMm, heightMm: hMm,
    widthPx: width, heightPx: height, dpi, colorMode: cmyk ? 'CMYK' : 'RGB',
    items, ready: !blocked,
    summary: blocked
      ? 'Not print-ready yet — fix the failed item(s) above first.'
      : 'Ready to export, with the warnings above noted. Bleed and safe zone still need your visual check.',
  });
});

module.exports = router;
