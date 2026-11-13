'use strict';
// Project routes: list/search, create, read, autosave, versions, duplicate,
// trash/restore, permanent delete, folders.
const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();
const TYPES = ['design', 'video', 'bulk', 'shorts', 'social'];

router.get('/', auth.requireAuth, (req, res) => {
  const { search = '', trashed = '0', folderId = '' } = req.query;
  const projects = db.listProjects(req.user.id, {
    search, trashed: trashed === '1', folderId: folderId || null,
  });
  res.json({ projects: projects.map(publicProject) });
});

router.post('/', auth.requireAuth, (req, res) => {
  const { name, type = 'design', folderId = null, content } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Project name is required.' });
  if (!TYPES.includes(type)) return res.status(400).json({ error: `Invalid project type. Use one of: ${TYPES.join(', ')}.` });
  if (content !== undefined && (typeof content !== 'object' || content === null || Array.isArray(content))) {
    return res.status(400).json({ error: 'Project content must be a JSON object.' });
  }
  const p = db.createProject(req.user.id, { name: name.trim(), type, folderId, content: content || {} });
  db.audit(req.user.id, 'project_create', 'project', p.id, `Created "${p.name}" (${p.type})`);
  res.status(201).json({ project: publicProject(p) });
});

router.get('/:id', auth.requireAuth, (req, res) => {
  const p = db.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  res.json({ project: publicProject(p) });
});

// Autosave: updates content (and optionally name). A version snapshot is kept.
router.patch('/:id', auth.requireAuth, (req, res) => {
  const { name, type, folderId, content, saveVersion } = req.body || {};
  if (type !== undefined && !TYPES.includes(type)) return res.status(400).json({ error: `Invalid project type.` });
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) return res.status(400).json({ error: 'Project name cannot be empty.' });
  if (content !== undefined && (typeof content !== 'object' || content === null || Array.isArray(content))) {
    return res.status(400).json({ error: 'Project content must be a JSON object.' });
  }
  const before = db.getProject(req.user.id, req.params.id);
  if (!before) return res.status(404).json({ error: 'Project not found.' });
  const p = db.updateProject(req.user.id, req.params.id, { name, type, folderId, content });
  if (content !== undefined && saveVersion) db.saveProjectVersion(p.id, content, 'manual save');
  else if (content !== undefined) db.saveProjectVersion(p.id, content, 'autosave');
  res.json({ project: publicProject(p) });
});

router.post('/:id/duplicate', auth.requireAuth, (req, res) => {
  const copy = db.duplicateProject(req.user.id, req.params.id);
  if (!copy) return res.status(404).json({ error: 'Project not found.' });
  db.audit(req.user.id, 'project_duplicate', 'project', copy.id, `Duplicated "${copy.name}"`);
  res.status(201).json({ project: publicProject(copy) });
});

router.post('/:id/trash', auth.requireAuth, (req, res) => {
  const p = db.updateProject(req.user.id, req.params.id, { trashed: true });
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  db.audit(req.user.id, 'project_trash', 'project', p.id, `Moved "${p.name}" to trash`);
  res.json({ project: publicProject(p) });
});

router.post('/:id/restore', auth.requireAuth, (req, res) => {
  const p = db.updateProject(req.user.id, req.params.id, { trashed: false });
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  db.audit(req.user.id, 'project_restore', 'project', p.id, `Restored "${p.name}" from trash`);
  res.json({ project: publicProject(p) });
});

router.delete('/:id', auth.requireAuth, (req, res) => {
  const p = db.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  if (!p.trashed) return res.status(400).json({ error: 'Move the project to trash first — permanent delete only works from trash.' });
  db.deleteProjectPermanently(req.user.id, req.params.id);
  db.audit(req.user.id, 'project_delete', 'project', p.id, `Permanently deleted "${p.name}"`);
  res.json({ ok: true });
});

router.get('/:id/versions', auth.requireAuth, (req, res) => {
  const p = db.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  res.json({ versions: db.listProjectVersions(p.id) });
});

router.post('/:id/versions/:versionId/restore', auth.requireAuth, (req, res) => {
  const p = db.getProject(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const v = db.getProjectVersion(req.params.versionId);
  if (!v || v.project_id !== p.id) return res.status(404).json({ error: 'Version not found.' });
  const content = JSON.parse(v.content);
  const updated = db.updateProject(req.user.id, p.id, { content });
  db.saveProjectVersion(p.id, content, `restored from version ${v.id}`);
  db.audit(req.user.id, 'project_version_restore', 'project', p.id, `Restored version from ${v.created_at}`);
  res.json({ project: publicProject(updated) });
});

// Folders (project kind)
router.get('/folders/list', auth.requireAuth, (req, res) => {
  res.json({ folders: db.listFolders(req.user.id, 'project') });
});
router.post('/folders', auth.requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Folder name is required.' });
  res.status(201).json({ folder: db.createFolder(req.user.id, String(name).trim(), 'project') });
});
router.delete('/folders/:id', auth.requireAuth, (req, res) => {
  if (!db.deleteFolder(req.user.id, req.params.id)) return res.status(404).json({ error: 'Folder not found.' });
  res.json({ ok: true });
});

function publicProject(p) {
  return {
    id: p.id, name: p.name, type: p.type, folderId: p.folder_id,
    content: JSON.parse(p.content || '{}'), trashed: Boolean(p.trashed),
    createdAt: p.created_at, updatedAt: p.updated_at,
  };
}

module.exports = router;
