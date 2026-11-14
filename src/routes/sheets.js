'use strict';
// Sheets routes (v2.5.0, item #21).
//   GET    /api/sheets                      — list sheet projects
//   POST   /api/sheets                      — create a sheet project
//   GET    /api/sheets/:id                  — sheet + evaluated values
//   PUT    /api/sheets/:id                  — replace sheet content / set cells
//   POST   /api/sheets/:id/cells            — set one batch of cells {cells:{A1:{v|f,fmt}}}
//   GET    /api/sheets/:id/rows             — sheet rows as a bulk data source
//   POST   /api/sheets/import               — CSV or XLSX upload → sheet project
//   GET    /api/sheets/:id/export/csv|xlsx  — download
// Sheets are normal projects of type 'sheet' (db.createProject), so the
// Projects list, trash and duplicate flows work on them unchanged.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const auth = require('../auth');
const {
  blankSheet, validateSheet, evaluateSheet, sheetRows,
  sheetToCsv, csvToSheet, sheetToXlsx, xlsxToSheet,
} = require('../sheets');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function getSheetProject(req, id) {
  const p = db.getProject(req.user.id, id);
  if (!p) return null;
  if (p.type !== 'sheet') return { wrongType: true };
  let content;
  try { content = JSON.parse(p.content || '{}'); } catch { content = {}; }
  return { ...p, content };
}

function publicSheet(p) {
  const { values, errors } = evaluateSheet(p.content);
  return {
    id: p.id, name: p.name, type: 'sheet', folderId: p.folder_id,
    content: p.content, values, errors,
    createdAt: p.created_at, updatedAt: p.updated_at,
  };
}

router.get('/', auth.requireAuth, (req, res) => {
  const list = db.listProjects(req.user.id, {}).filter((p) => p.type === 'sheet');
  const out = list.map((p) => {
    let content = {};
    try { content = JSON.parse(p.content || '{}'); } catch { /* keep {} */ }
    return { id: p.id, name: p.name, type: 'sheet', rows: content.rows || 0, cols: content.cols || 0, cells: Object.keys(content.cells || {}).length, createdAt: p.created_at, updatedAt: p.updated_at };
  });
  res.json({ sheets: out });
});

router.post('/', auth.requireAuth, (req, res) => {
  const { name, title, cols, rows, content } = req.body || {};
  let sheet;
  try {
    sheet = content ? content : blankSheet({ title: title || name || 'Untitled Sheet', cols, rows });
    if (content && content.title === undefined && (title || name)) sheet.title = String(title || name).slice(0, 120);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const v = validateSheet(sheet);
  if (!v.ok) return res.status(400).json({ error: 'Invalid sheet: ' + v.errors.join(' ') });
  const p = db.createProject(req.user.id, { name: (name || sheet.title || 'Untitled Sheet').trim().slice(0, 120), type: 'sheet', content: sheet });
  res.status(201).json({ sheet: publicSheet({ ...p, content: sheet }) });
});

router.get('/:id', auth.requireAuth, (req, res) => {
  const p = getSheetProject(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Sheet not found.' });
  if (p.wrongType) return res.status(400).json({ error: 'That project is not a sheet.' });
  res.json({ sheet: publicSheet(p) });
});

router.put('/:id', auth.requireAuth, (req, res) => {
  const p = getSheetProject(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Sheet not found.' });
  if (p.wrongType) return res.status(400).json({ error: 'That project is not a sheet.' });
  const { content, name } = req.body || {};
  if (!content) return res.status(400).json({ error: 'Sheet content is required.' });
  const v = validateSheet(content);
  if (!v.ok) return res.status(400).json({ error: 'Invalid sheet: ' + v.errors.join(' ') });
  const updated = db.updateProject(req.user.id, p.id, { content, name: name ? String(name).slice(0, 120) : undefined });
  res.json({ sheet: publicSheet({ ...updated, content }) });
});

// Set a batch of cells (partial update — the grid sends only what changed).
router.post('/:id/cells', auth.requireAuth, (req, res) => {
  const p = getSheetProject(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Sheet not found.' });
  if (p.wrongType) return res.status(400).json({ error: 'That project is not a sheet.' });
  const { cells } = req.body || {};
  if (!cells || typeof cells !== 'object' || Array.isArray(cells)) return res.status(400).json({ error: 'Send { cells: { "A1": { v: 12 } } }.' });
  const next = JSON.parse(JSON.stringify(p.content));
  next.cells = next.cells || {};
  for (const [addr, cell] of Object.entries(cells)) {
    if (cell === null) delete next.cells[addr];
    else next.cells[addr] = cell;
  }
  const v = validateSheet(next);
  if (!v.ok) return res.status(400).json({ error: 'Invalid sheet: ' + v.errors.join(' ') });
  const updated = db.updateProject(req.user.id, p.id, { content: next });
  res.json({ sheet: publicSheet({ ...updated, content: next }) });
});

// Sheet rows as a data source for bulk jobs (header row = row 1).
router.get('/:id/rows', auth.requireAuth, (req, res) => {
  const p = getSheetProject(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Sheet not found.' });
  if (p.wrongType) return res.status(400).json({ error: 'That project is not a sheet.' });
  const headerRow = Math.max(1, parseInt(req.query.headerRow, 10) || 1);
  const out = sheetRows(p.content, { headerRow });
  res.json({ sheetId: p.id, name: p.name, headerRow, headers: out.headers, rows: out.rows, rowCount: out.rows.length });
});

router.post('/import', auth.requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a CSV or XLSX file (field "file").' });
  const name = String(req.body && req.body.name ? req.body.name : req.file.originalname.replace(/\.(csv|xlsx)$/i, '')).slice(0, 120) || 'Imported Sheet';
  try {
    const isXlsx = /\.xlsx$/i.test(req.file.originalname) || req.file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const sheet = isXlsx ? xlsxToSheet(req.file.buffer, { title: name }) : csvToSheet(req.file.buffer.toString('utf8'), { title: name });
    const v = validateSheet(sheet);
    if (!v.ok) return res.status(400).json({ error: 'Invalid sheet: ' + v.errors.join(' ') });
    const p = db.createProject(req.user.id, { name, type: 'sheet', content: sheet });
    res.status(201).json({ sheet: publicSheet({ ...p, content: sheet }) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e).slice(0, 500) });
  }
});

router.get('/:id/export/csv', auth.requireAuth, (req, res) => {
  const p = getSheetProject(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Sheet not found.' });
  if (p.wrongType) return res.status(400).json({ error: 'That project is not a sheet.' });
  const csv = sheetToCsv(p.content);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${p.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'sheet'}.csv"`);
  res.send(csv);
});

router.get('/:id/export/xlsx', auth.requireAuth, (req, res) => {
  const p = getSheetProject(req, req.params.id);
  if (!p) return res.status(404).json({ error: 'Sheet not found.' });
  if (p.wrongType) return res.status(400).json({ error: 'That project is not a sheet.' });
  const buf = sheetToXlsx(p.content);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${p.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'sheet'}.xlsx"`);
  res.send(buf);
});

module.exports = router;
