'use strict';
// Bulk Design + Bulk Video routes (Phase 4).
// Dataset import (XLSX/CSV/JSON/paste/manual), field mapping, background
// assignment, batch start/cancel/retry, per-row status, ZIP export.
// Duplicate rule (user, 2026-11-12): duplicates are PERMANENTLY skipped —
// only the first copy of a row is ever generated; skipped rows get no job,
// no output and never appear in the retry list.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const auth = require('../auth');
const bm = require('../bulk-model');
const bulk = require('../bulk');
const config = require('../config');
const credits = require('../credits');

// Phase 8: a bulk batch costs 2 credits per row that will render
// (1 bulk_row + 1 render). Refuse the start up front when the balance
// cannot cover the whole batch, so a batch never stalls halfway.
function bulkStartCheck(req, j) {
  // Rows that will render: queued (fresh start) or failed (retry).
  const rows = db.listBulkRows(j.id).filter((r) => r.selected && (r.status === 'queued' || r.status === 'failed'));
  if (!rows.length) return null;
  const user = db.getUserById(req.user.id);
  if (credits.isUnlimited(user)) return null;
  const needed = rows.length * (credits.costOf('bulk_row') + credits.costOf('render'));
  if (user.credits_balance < needed) {
    return { error: `Not enough credits to run this batch: ${rows.length} rows × 2 credits = ${needed}, balance is ${user.credits_balance}. Ask the OWNER for more credits or upgrade your plan.`, needed, balance: user.credits_balance };
  }
  return null;
}

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function publicBulkJob(j) {
  const settings = bulk.parseSettings(j);
  let voice = null;
  if (settings.voice && settings.voice.profileId) {
    const p = db.getVoiceProfile(j.user_id, settings.voice.profileId);
    if (p) voice = { profileId: p.id, name: p.name, kind: p.kind };
  }
  return {
    id: j.id, name: j.name, kind: j.kind, templateProjectId: j.template_project_id,
    brandId: j.brand_id, status: j.status,
    rowsTotal: j.rows_total, rowsDone: j.rows_done, rowsFailed: j.rows_failed,
    dedupeSummary: settings.dedupeSummary,
    voice, ttsEnabled: Boolean(settings.voice && settings.voice.tts),
    settings,
    createdAt: j.created_at, updatedAt: j.updated_at,
  };
}

function publicBulkRow(r) {
  let data = {};
  let warnings = [];
  let fitReport = null;
  try { data = JSON.parse(r.data || '{}'); } catch { /* ignore */ }
  try { warnings = JSON.parse(r.warnings || '[]'); } catch { /* ignore */ }
  try { fitReport = r.fit_report ? JSON.parse(r.fit_report) : null; } catch { /* ignore */ }
  return {
    id: r.id, rowIndex: r.row_index, rowNumber: r.row_index + 1, data,
    selected: Boolean(r.selected), status: r.status,
    backgroundMediaId: r.background_media_id, backgroundSource: r.background_source,
    backgroundPrompt: r.background_prompt, outputJobId: r.output_job_id,
    outputName: r.output_name, hasOutput: Boolean(r.output_path && fs.existsSync(r.output_path)),
    error: r.error, warnings, luminance: r.luminance, fitReport,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// Fit summary for a job: counts of OK / Adjusted / Needs attention rows.
function fitSummary(rows) {
  const counts = { ok: 0, adjusted: 0, attention: 0, unchecked: 0 };
  let questionFont = null;
  let optionFont = null;
  for (const r of rows) {
    let fr = null;
    try { fr = r.fit_report ? JSON.parse(r.fit_report) : null; } catch { /* ignore */ }
    if (!fr) { counts.unchecked++; continue; }
    if (fr.overall === 'OK') counts.ok++;
    else if (fr.overall === 'Adjusted') counts.adjusted++;
    else counts.attention++;
    if (typeof fr.questionFont === 'number') questionFont = questionFont === null ? fr.questionFont : Math.min(questionFont, fr.questionFont);
    if (typeof fr.optionFont === 'number') optionFont = optionFont === null ? fr.optionFont : Math.min(optionFont, fr.optionFont);
  }
  return { ...counts, questionFont, optionFont };
}

function getJobOr404(req, res) {
  const j = db.getBulkJob(req.user.id, req.params.id);
  if (!j) { res.status(404).json({ error: 'Bulk job not found.' }); return null; }
  return j;
}

function parseDatasetBuffer(buffer, filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (ext === 'json') {
    const parsed = JSON.parse(buffer.toString('utf8'));
    if (Array.isArray(parsed)) return rowsToDataset(parsed);
    if (parsed && Array.isArray(parsed.rows)) {
      return { columns: parsed.columns || Object.keys(parsed.rows[0] || {}), rows: parsed.rows };
    }
    throw new Error('JSON data must be an array of row objects, or { columns, rows }.');
  }
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('The spreadsheet has no sheets.');
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
  return aoaToDataset(aoa);
}

function parseDatasetText(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('No data pasted. Paste CSV, TSV or JSON rows.');
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return parseDatasetBuffer(Buffer.from(trimmed, 'utf8'), 'data.json');
  }
  const wb = XLSX.read(trimmed, { type: 'string' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Could not read the pasted data.');
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
  return aoaToDataset(aoa);
}

function aoaToDataset(aoa) {
  const rows = (aoa || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
  if (!rows.length) throw new Error('No data found. The file needs a header row and at least one data row.');
  const rawCols = rows[0].map((c, i) => String(c ?? '').trim() || `Column ${i + 1}`);
  // De-duplicate identical header names (SheetJS would collapse them).
  const seen = new Map();
  const columns = rawCols.map((c) => {
    if (!seen.has(c)) { seen.set(c, 1); return c; }
    const n = seen.get(c) + 1;
    seen.set(c, n);
    return `${c} ${n}`;
  });
  const data = rows.slice(1).map((r) => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = r[i] === undefined || r[i] === null ? '' : r[i]; });
    return obj;
  });
  return { columns, rows: data };
}

function rowsToDataset(arr) {
  if (!arr.length) throw new Error('No data rows were found.');
  const columns = [...new Set(arr.flatMap((r) => Object.keys(r || {})))];
  const rows = arr.map((r) => {
    const obj = {};
    columns.forEach((c) => { obj[c] = r[c] === undefined || r[c] === null ? '' : r[c]; });
    return obj;
  });
  return { columns, rows };
}

function datasetIssues(dataset) {
  return bm.validateDataset(dataset.columns, dataset.rows);
}

// --- Google Sheets: honest status (real integration is Phase 8) ---
router.get('/sheets-info', auth.requireAuth, (req, res) => {
  const google = require('../google');
  const db = require('../db');
  const configured = google.googleConfigured();
  const connected = Boolean(db.getSocialConnection(req.user.id, 'google'));
  res.json({
    available: configured && connected,
    configured, connected,
    reason: !configured
      ? 'Google Sheets import needs Google OAuth — an OWNER/ADMIN adds the Client ID + Secret in Settings → Google Sheets, then connects Google.'
      : !connected
        ? 'Google OAuth is configured but not connected yet — connect it in Settings → Google Sheets, or from the Google Sheets button here.'
        : 'Google Sheets import is ready: pick a spreadsheet and tab to import its rows.',
  });
});

// --- Quiz Video preset (Phase 4): auto-fit + layout served from the same
// server-side logic the renderer uses, so preview and render agree. ---
router.post('/quiz/fit', auth.requireAuth, (req, res) => {
  const { text = '', maxWidth = 640, maxFont = 62, minFont = 20, maxLines = 2 } = req.body || {};
  const qm = require('../quiz-model');
  res.json({ fit: qm.fitText(text, maxWidth, { maxFont, minFont, maxLines }) });
});

router.post('/quiz/layout', auth.requireAuth, (req, res) => {
  const qm = require('../quiz-model');
  try {
    const { row = {}, W = 720, H = 1280 } = req.body || {};
    const q = qm.parseQuestion(row, 0);
    const layout = qm.layoutRound(q, { W, H, hasImage: Boolean(q.imageValue) });
    res.json({ question: q, layout });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Narration plan (post-Phase-5 upgrade): the timed segment plan for one
// quiz round — the SAME times the timeline builder, the phone-frame preview
// and the narration placement use, so preview and render can never disagree.
// Body: { row, animations?, readSeconds?, revealSeconds? }.
router.post('/quiz/narration-plan', auth.requireAuth, (req, res) => {
  const qm = require('../quiz-model');
  try {
    const { row = {}, animations, readSeconds, revealSeconds } = req.body || {};
    const q = qm.parseQuestion(row, 0);
    const resolved = qm.validateAnimations(animations);
    const plan = qm.buildNarrationPlan(q, 0, {
      readSeconds: readSeconds || qm.QUIZ_SPEC.readSeconds,
      revealSeconds: revealSeconds || qm.QUIZ_SPEC.revealSeconds,
      animations: resolved,
    });
    res.json({ question: q, plan, animations: resolved, animTypes: qm.ANIM_TYPES });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Templates / field scanning ---
router.get('/templates/:projectId/fields', auth.requireAuth, (req, res) => {
  try {
    if (req.params.projectId === 'quiz') {
      const t = bulk.getQuizTemplateFields();
      return res.json({ kind: 'video', quiz: true, projectId: 'quiz', projectName: 'Quiz Video (preset)', fields: t.scan.fields, scan: t.scan });
    }
    const t = bulk.getTemplateFields(req.user.id, req.params.projectId);
    if (!t) return res.status(404).json({ error: 'Template project not found.' });
    res.json({ kind: t.kind, projectId: t.project.id, projectName: t.project.name, fields: t.scan.fields, scan: t.scan });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Smart Template Builder: save dynamic bindings onto a template project.
router.patch('/templates/:projectId/bindings', auth.requireAuth, (req, res) => {
  const project = db.getProject(req.user.id, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Template project not found.' });
  const { bindings = [], backgroundClipId = null } = req.body || {};
  try {
    if (project.type === 'video') {
      const timeline = bulk.extractTimeline(project);
      for (const b of bindings) {
        const clip = (timeline.tracks || []).flatMap((t) => t.clips).find((c) => c.id === b.clipId);
        if (!clip) return res.status(400).json({ error: `Clip "${b.clipId}" not found in this template.` });
        if (b.dynamicMediaField !== undefined) clip.dynamicMediaField = b.dynamicMediaField ? bm.normField(b.dynamicMediaField) : undefined;
        if (b.isBackground !== undefined) clip.isBackground = Boolean(b.isBackground);
      }
      if (backgroundClipId) {
        for (const c of (timeline.tracks || []).flatMap((t) => t.clips)) c.isBackground = c.id === backgroundClipId;
      }
      const errors = require('../video-model').validateTimeline(timeline);
      if (errors.length) return res.status(400).json({ error: `Template is invalid: ${errors.join(' ')}` });
      const updated = db.updateProject(req.user.id, project.id, { content: { timeline } });
      const scan = bm.scanVideoTemplate(timeline);
      return res.json({ project: { id: updated.id, name: updated.name, type: updated.type }, fields: scan.fields, scan });
    }
    if (project.type === 'design') {
      const design = bulk.extractDesign(project);
      for (const b of bindings) {
        const layer = (design.layers || []).find((l) => l.id === b.layerId);
        if (!layer) return res.status(400).json({ error: `Layer "${b.layerId}" not found in this template.` });
        if (layer.type !== 'image') return res.status(400).json({ error: `Layer "${layer.name}" is not an image layer.` });
        layer.image.dynamicField = b.dynamicField ? bm.normField(b.dynamicField) : undefined;
      }
      const { ok, errors } = require('../design-model').validateDesign(design);
      if (!ok) return res.status(400).json({ error: `Template is invalid: ${errors.join(' ')}` });
      const updated = db.updateProject(req.user.id, project.id, { content: { design } });
      const scan = bm.scanDesignTemplate(design);
      return res.json({ project: { id: updated.id, name: updated.name, type: updated.type }, fields: scan.fields, scan });
    }
    return res.status(400).json({ error: `Project type "${project.type}" cannot be a bulk template. Use a video or design project.` });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// --- Bulk jobs ---
router.get('/', auth.requireAuth, (req, res) => {
  res.json({ jobs: db.listBulkJobs(req.user.id).map(publicBulkJob) });
});

router.post('/', auth.requireAuth, (req, res) => {
  const { name, kind = 'video', templateProjectId, brandId, settings = {} } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Bulk job name is required.' });
  if (!['video', 'design'].includes(kind)) return res.status(400).json({ error: 'Kind must be "video" or "design".' });
  if (!templateProjectId) return res.status(400).json({ error: 'Pick a template project first.' });
  const isQuiz = templateProjectId === 'quiz';
  if (isQuiz && kind !== 'video') return res.status(400).json({ error: 'The Quiz Video preset is a video template.' });
  let project = null;
  if (!isQuiz) {
    project = db.getProject(req.user.id, templateProjectId);
    if (!project) return res.status(404).json({ error: 'Template project not found.' });
    if (project.type !== kind) return res.status(400).json({ error: `Template "${project.name}" is a ${project.type} project, not a ${kind} template.` });
  }
  if (brandId) {
    const brand = db.getBrand(req.user.id, brandId);
    if (!brand) return res.status(400).json({ error: 'Brand not found.' });
  }
  try {
    const t = isQuiz ? bulk.getQuizTemplateFields() : bulk.getTemplateFields(req.user.id, templateProjectId);
    const mergedSettings = isQuiz
      // Research-spec defaults: 1080x1920, 2s read + 3s countdown + 2s
      // reveal per question, 3s score card at the end.
      ? { resolution: '1080p', ...settings, quiz: { enabled: true, mode: 'single', questionsPerVideo: 5, readSeconds: 2, timerSeconds: 3, revealSeconds: 2, ctaSeconds: 3, ctaText: 'Kitne sahi hue? Comment mein score likho', ctaSub: 'Follow for more quizzes', ...(settings.quiz || {}) } }
      : settings;
    const job = db.createBulkJob(req.user.id, {
      name: name.trim(), kind, templateProjectId: isQuiz ? null : templateProjectId,
      brandId: brandId || null, settings: mergedSettings,
    });
    db.audit(req.user.id, 'bulk_create', 'bulk_job', job.id,
      `Created bulk ${kind} job "${job.name}" from template "${isQuiz ? 'Quiz Video (preset)' : project.name}"`);
    res.status(201).json({ job: publicBulkJob(job), fields: t.scan.fields, scan: t.scan });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', auth.requireAuth, (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  const dataset = JSON.parse(j.dataset || '{"columns":[],"rows":[]}');
  const rows = db.listBulkRows(j.id);
  res.json({
    job: publicBulkJob(j),
    dataset: { columns: dataset.columns, totalRows: dataset.rows.length },
    rows: rows.map(publicBulkRow),
    fitSummary: fitSummary(rows),
  });
});

router.get('/:id/rows', auth.requireAuth, (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  res.json({ rows: db.listBulkRows(j.id).map(publicBulkRow), job: publicBulkJob(j) });
});

// --- Dataset import ---
router.post('/:id/dataset', auth.requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than the 10 MB dataset limit.' : err.message });
    const j = getJobOr404(req, res);
    if (!j) return;
    if (j.status !== 'draft') return res.status(400).json({ error: `Data can only be imported while the batch is a draft (this one is ${j.status}).` });
    try {
      let dataset;
      if (req.file) dataset = parseDatasetBuffer(req.file.buffer, req.file.originalname);
      else if (req.body && typeof req.body.text === 'string') dataset = parseDatasetText(req.body.text);
      else if (req.body && Array.isArray(req.body.rows)) dataset = rowsToDataset(req.body.rows);
      else if (req.body && Array.isArray(req.body.columns) && Array.isArray(req.body.rows)) {
        dataset = { columns: req.body.columns, rows: req.body.rows };
      } else return res.status(400).json({ error: 'Upload an XLSX/CSV/JSON file, paste CSV/JSON text, or send { columns, rows }.' });
      if (dataset.rows.length > bulk.MAX_ROWS_HARD) {
        return res.status(400).json({ error: `This file has ${dataset.rows.length} rows — the hard limit is ${bulk.MAX_ROWS_HARD}. Split it into smaller files.` });
      }
      const { errors, rowIssues } = datasetIssues(dataset);
      if (errors.length) return res.status(400).json({ error: errors.join(' ') });
      db.updateBulkJob(j.id, { dataset });
      db.replaceBulkRows(j.id, dataset.rows.map((data, i) => ({ rowIndex: i, data, selected: true })));
      const summary = bulk.applyDedupe(db.getBulkJob(req.user.id, j.id));
      db.audit(req.user.id, 'bulk_dataset', 'bulk_job', j.id,
        `Imported ${dataset.rows.length} rows (${summary.unique} unique, ${summary.skipped} duplicates skipped).`);
      res.json({
        job: publicBulkJob(db.getBulkJob(req.user.id, j.id)),
        dataset: { columns: dataset.columns, totalRows: dataset.rows.length },
        rows: db.listBulkRows(j.id).map(publicBulkRow),
        dedupeSummary: summary, rowIssues,
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

// --- Settings / mapping update (draft only for dedupe + mapping) ---
router.patch('/:id', auth.requireAuth, (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  const { name, brandId, settings = {} } = req.body || {};
  const current = bulk.parseSettings(j);
  const dedupeChanged = settings.dedupe !== undefined &&
    JSON.stringify(settings.dedupe) !== JSON.stringify({ mode: current.dedupe.mode, keyColumn: current.dedupe.keyColumn });
  const mappingChanged = settings.fieldMapping !== undefined &&
    JSON.stringify(settings.fieldMapping) !== JSON.stringify(current.fieldMapping);
  if ((dedupeChanged || mappingChanged) && j.status !== 'draft') {
    return res.status(400).json({ error: 'Dedupe settings and field mapping can only change while the batch is a draft.' });
  }
  if (settings.dedupe) {
    if (!['whole-row', 'key'].includes(settings.dedupe.mode)) return res.status(400).json({ error: 'Dedupe mode must be "whole-row" or "key".' });
    if (settings.dedupe.mode === 'key' && !settings.dedupe.keyColumn) {
      return res.status(400).json({ error: 'Key-column dedupe needs a key column (e.g. PRODUCT_NAME).' });
    }
    const dataset = JSON.parse(j.dataset || '{"columns":[],"rows":[]}');
    if (settings.dedupe.mode === 'key' && dataset.columns.length && !dataset.columns.includes(settings.dedupe.keyColumn)) {
      return res.status(400).json({ error: `Key column "${settings.dedupe.keyColumn}" is not in the dataset.` });
    }
  }
  if (settings.fieldMapping) {
    const dataset = JSON.parse(j.dataset || '{"columns":[],"rows":[]}');
    for (const [field, col] of Object.entries(settings.fieldMapping)) {
      if (col && dataset.columns.length && !dataset.columns.includes(col)) {
        return res.status(400).json({ error: `Field ${field} is mapped to column "${col}", which is not in the dataset.` });
      }
    }
  }
  // Voice for the batch: one voice profile for every row (a row's VOICE
  // column can still override it). Must belong to this user.
  if (settings.voice) {
    if (settings.voice.profileId !== undefined && settings.voice.profileId !== null) {
      const p = db.getVoiceProfile(req.user.id, settings.voice.profileId);
      if (!p) return res.status(400).json({ error: 'Voice profile not found.' });
    }
    if (settings.voice.tts !== undefined && typeof settings.voice.tts !== 'boolean') {
      return res.status(400).json({ error: 'Voice "tts" must be true or false.' });
    }
  }
  // Quiz animations: auto defaults, or manual per-element overrides.
  if (settings.quiz && settings.quiz.animations !== undefined) {
    try {
      require('../quiz-model').validateAnimations(settings.quiz.animations);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  const merged = {
    ...current,
    ...settings,
    background: { ...current.background, ...(settings.background || {}) },
    readability: { ...current.readability, ...(settings.readability || {}) },
    dedupe: { ...current.dedupe, ...(settings.dedupe || {}) },
    quiz: { ...current.quiz, ...(settings.quiz || {}) },
    voice: { ...current.voice, ...(settings.voice || {}) },
  };
  const updates = { settings: merged };
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Bulk job name cannot be empty.' });
    updates.name = name.trim();
  }
  if (brandId !== undefined) {
    if (brandId) {
      const brand = db.getBrand(req.user.id, brandId);
      if (!brand) return res.status(400).json({ error: 'Brand not found.' });
    }
    updates.brand_id = brandId || null;
  }
  db.updateBulkJob(j.id, updates);
  let summary = merged.dedupeSummary;
  if ((dedupeChanged || mappingChanged) && j.status === 'draft') {
    summary = bulk.applyDedupe(db.getBulkJob(req.user.id, j.id));
  }
  res.json({ job: publicBulkJob(db.getBulkJob(req.user.id, j.id)), dedupeSummary: summary });
});

// --- Row edit (draft only; re-runs dedupe) ---
router.patch('/:id/rows/:rowId', auth.requireAuth, (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  if (j.status !== 'draft') return res.status(400).json({ error: 'Rows can only be edited while the batch is a draft.' });
  const row = db.getBulkRow(j.id, req.params.rowId);
  if (!row) return res.status(404).json({ error: 'Row not found.' });
  const { data, selected, backgroundMediaId } = req.body || {};
  const updates = {};
  if (data !== undefined) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return res.status(400).json({ error: 'Row data must be an object.' });
    updates.data = data;
    // Keep the stored dataset in sync so dedupe + generation see the edit.
    const dataset = JSON.parse(j.dataset || '{"columns":[],"rows":[]}');
    dataset.rows[row.row_index] = data;
    db.updateBulkJob(j.id, { dataset });
  }
  if (selected !== undefined) updates.selected = selected ? 1 : 0;
  if (backgroundMediaId !== undefined) {
    if (backgroundMediaId) {
      const m = db.getMedia(req.user.id, backgroundMediaId);
      if (!m || (m.kind !== 'image' && m.kind !== 'video')) return res.status(400).json({ error: 'Background must be an image or video from the Media Library.' });
    }
    updates.background_media_id = backgroundMediaId || null;
    updates.background_source = backgroundMediaId ? 'manual' : null;
  }
  db.updateBulkRow(row.id, updates);
  const summary = bulk.applyDedupe(db.getBulkJob(req.user.id, j.id));
  res.json({ row: publicBulkRow(db.getBulkRow(j.id, row.id)), dedupeSummary: summary });
});

// --- Background assignment preview / re-run ---
router.post('/:id/assign', auth.requireAuth, async (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  if (j.kind !== 'video') return res.status(400).json({ error: 'Background assignment only applies to video batches.' });
  if (!['draft', 'partial', 'failed'].includes(j.status)) {
    return res.status(400).json({ error: `Backgrounds can only be assigned while the batch is a draft or failed (this one is ${j.status}).` });
  }
  try {
    await bulk.assignBackgroundsForJob(db.getBulkJob(req.user.id, j.id));
    res.json({ rows: db.listBulkRows(j.id).map(publicBulkRow), job: publicBulkJob(db.getBulkJob(req.user.id, j.id)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Sample render (one row, real render) ---
// --- Pre-flight fit check (rule C + D): measure every row before rendering ---
router.post('/:id/fit-check', auth.requireAuth, async (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  if (!['draft', 'partial', 'failed'].includes(j.status)) {
    return res.status(400).json({ error: `Fit check runs while the batch is a draft or failed (this one is ${j.status}).` });
  }
  try {
    const result = await bulk.checkRowFit(j);
    const rows = db.listBulkRows(j.id);
    res.json({ ...result, rows: rows.map(publicBulkRow), fitSummary: fitSummary(rows) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/sample', auth.requireAuth, async (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  const { rowIndex = 0 } = req.body || {};
  const rows = db.listBulkRows(j.id);
  const row = rows.find((r) => r.row_index === rowIndex);
  if (!row) return res.status(404).json({ error: `Row ${rowIndex + 1} not found.` });
  if (row.status === 'skipped') return res.status(400).json({ error: `Row ${rowIndex + 1} is a skipped duplicate — only its first copy is generated. Pick a unique row for the sample.` });
  if (row.status === 'done') return res.status(400).json({ error: `Row ${rowIndex + 1} is already rendered. Pick another row.` });
  if (!['draft', 'partial', 'failed'].includes(j.status)) return res.status(400).json({ error: `Samples can only run while the batch is a draft or failed (this one is ${j.status}).` });
  try {
    const freshJob = db.getBulkJob(req.user.id, j.id);
    if (j.kind === 'video') await bulk.assignBackgroundsForJob(freshJob);
    // Fit check first, so the sample uses the true batch fonts (uniform rule).
    await bulk.checkRowFit(freshJob);
    const sampleJob = db.getBulkJob(req.user.id, j.id);
    const freshSettings = bulk.parseSettings(sampleJob);
    if (j.kind === 'video' && freshSettings.quiz.enabled && freshSettings.quiz.mode === 'multi') {
      const group = db.listBulkRows(j.id).filter((r) => r.selected && r.status === 'queued')
        .slice(0, Math.max(2, Math.min(10, parseInt(freshSettings.quiz.questionsPerVideo, 10) || 5)));
      if (!group.length) return res.status(400).json({ error: 'No queued rows left for a multi-question sample.' });
      const built = await bulk.buildQuizGroupPayload(sampleJob, group);
      const created = db.createJob(req.user.id, {
        type: built.type, projectId: j.template_project_id,
        payload: { ...built.payload, bulkJobId: j.id, bulkRowIds: group.map((r) => r.id) },
      });
      for (const r of group) {
        const fr = (built.fitReports || []).find((x) => x.rowIndex === r.row_index);
        db.updateBulkRow(r.id, {
          output_job_id: created.id, output_name: built.outputName, warnings: built.warnings,
          fit_report: fr ? JSON.stringify(fr.fitReport) : undefined,
        });
      }
      return res.status(201).json({ jobId: created.id, rows: group.map((r) => publicBulkRow(db.getBulkRow(j.id, r.id))), voiceUsed: built.voiceUsed || null });
    }
    const built = await bulk.buildRowJobPayload(sampleJob, db.getBulkRow(j.id, row.id));
    const created = db.createJob(req.user.id, {
      type: built.type, projectId: j.template_project_id,
      payload: { ...built.payload, bulkJobId: j.id, bulkRowId: row.id },
    });
    db.updateBulkRow(row.id, {
      output_job_id: created.id, output_name: built.outputName,
      background_media_id: built.backgroundMediaId ?? row.background_media_id,
      background_source: built.backgroundSource ?? row.background_source,
      warnings: built.warnings, luminance: built.luminance ?? null,
      fit_report: built.fitReport ? JSON.stringify(built.fitReport) : undefined,
    });
    res.status(201).json({ jobId: created.id, row: publicBulkRow(db.getBulkRow(j.id, row.id)), voiceUsed: built.voiceUsed || null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Batch lifecycle ---
router.post('/:id/start', auth.requireAuth, async (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  const blocked = bulkStartCheck(req, j);
  if (blocked) return res.status(402).json({ ...blocked, code: 'INSUFFICIENT_CREDITS' });
  try {
    const started = await bulk.startBulkJob(req.user.id, j.id);
    res.json({ job: publicBulkJob(started), rows: db.listBulkRows(j.id).map(publicBulkRow) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/cancel', auth.requireAuth, async (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  const cancelled = await bulk.cancelBulkJob(req.user.id, j.id);
  res.json({ job: publicBulkJob(cancelled), rows: db.listBulkRows(j.id).map(publicBulkRow) });
});

router.post('/:id/retry', auth.requireAuth, async (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  const blocked = bulkStartCheck(req, j);
  if (blocked) return res.status(402).json({ ...blocked, code: 'INSUFFICIENT_CREDITS' });
  try {
    const retried = await bulk.retryBulkRows(req.user.id, j.id, req.body && req.body.rowIds);
    res.json({ job: publicBulkJob(retried), rows: db.listBulkRows(j.id).map(publicBulkRow) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/retry-row/:rowId', auth.requireAuth, async (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  const row = db.getBulkRow(j.id, req.params.rowId);
  if (!row) return res.status(404).json({ error: 'Row not found.' });
  if (row.status === 'skipped') {
    return res.status(400).json({ error: 'Skipped duplicates are never retried — only the first copy of a row is generated.' });
  }
  const user = db.getUserById(req.user.id);
  if (!credits.isUnlimited(user) && user.credits_balance < 2) {
    return res.status(402).json({ error: `Not enough credits to retry this row: needs 2, balance is ${user.credits_balance}.`, code: 'INSUFFICIENT_CREDITS', needed: 2, balance: user.credits_balance });
  }
  try {
    const retried = await bulk.retryBulkRows(req.user.id, j.id, [row.id]);
    res.json({ job: publicBulkJob(retried), rows: db.listBulkRows(j.id).map(publicBulkRow) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Downloads ---
router.get('/:id/zip', auth.requireAuth, async (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  try {
    const zipPath = await bulk.buildBulkZip(req.user.id, j);
    res.type('application/zip');
    res.set('Content-Disposition', `attachment; filename="bulk-${j.id}-outputs.zip"`);
    fs.createReadStream(zipPath).pipe(res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/rows/:rowId/download', auth.requireAuth, (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  const row = db.getBulkRow(j.id, req.params.rowId);
  if (!row || !row.output_path || !fs.existsSync(row.output_path)) {
    return res.status(404).json({ error: 'No finished output for this row yet.' });
  }
  const ext = path.extname(row.output_path).toLowerCase();
  res.type(ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'video/mp4');
  res.set('Content-Disposition', `attachment; filename="${row.output_name || path.basename(row.output_path)}"`);
  fs.createReadStream(row.output_path).pipe(res);
});

// --- Delete (not while running) ---
router.delete('/:id', auth.requireAuth, (req, res) => {
  const j = getJobOr404(req, res);
  if (!j) return;
  if (j.status === 'running') return res.status(400).json({ error: 'Cancel the running batch first.' });
  const zipPath = path.join(config.rendersDir, String(req.user.id), `bulk-${j.id}.zip`);
  try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch { /* ignore */ }
  // Render outputs stay in the Export Center (they are the same files the
  // per-row render jobs point at); only the bulk records are deleted.
  db.deleteBulkJob(req.user.id, j.id);
  db.audit(req.user.id, 'bulk_delete', 'bulk_job', j.id, `Deleted bulk job "${j.name}".`);
  res.json({ ok: true });
});

module.exports = router;
