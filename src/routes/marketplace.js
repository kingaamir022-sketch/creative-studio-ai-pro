'use strict';
// Templates Marketplace (Phase 8) — IN-APP only.
//
// This is the local marketplace of this CreativeStudio install: users
// publish their own design/video projects, others browse, search,
// install and rate them. There is NO external marketplace, no public
// store, no download from anywhere else — the UI says so plainly.
//
// An installed template is a REAL editable copy (a new project with the
// published content snapshot), never a flattened image. The published
// content snapshot is stored on the listing, so installing works even
// after the author deletes their original project.
//
// Schema note: the table stores tags as a comma-separated string, content
// as a JSON snapshot, kind is 'design'|'video', and status is
// 'active'|'removed'.
const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

function publicTemplate(t) {
  if (!t) return null;
  let content = {};
  try { content = JSON.parse(t.content || '{}'); } catch { content = {}; }
  const tags = String(t.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    id: t.id, name: t.name, description: t.description, kind: t.kind,
    category: t.category, tags, previewMediaId: t.preview_media_id,
    downloads: t.downloads, status: t.status,
    avgRating: t.avg_rating !== undefined && t.avg_rating !== null ? Number(t.avg_rating) : null,
    ratingCount: t.rating_count || 0, reportCount: t.report_count || 0,
    authorId: t.user_id, authorName: t.author_name || null,
    sourceType: t.source_type, sourceId: t.source_id,
    hasContent: Object.keys(content).length > 0,
    createdAt: t.created_at,
  };
}

// Browse (only active listings).
router.get('/', auth.requireAuth, (req, res) => {
  const templates = db.listMarketplaceTemplates({
    q: req.query.q || '', kind: req.query.kind || '', category: req.query.category || '',
  });
  res.json({
    templates: templates.map(publicTemplate),
    note: 'This is the in-app marketplace of this CreativeStudio install only. There is no external store — templates here are published by users of this install.',
  });
});

router.get('/:id', auth.requireAuth, (req, res) => {
  const t = db.getMarketplaceTemplate(req.params.id);
  if (!t || t.status !== 'active') return res.status(404).json({ error: 'Template not found.' });
  const withAuthor = { ...t, author_name: (db.getUserById(t.user_id) || {}).name || null };
  res.json({ template: publicTemplate(withAuthor), ratings: db.listMarketplaceRatings(t.id) });
});

// Publish one of my own design/video projects. The project's content is
// snapshotted onto the listing, so the template stays installable even if
// the original project is later deleted.
router.post('/', auth.requireAuth, (req, res) => {
  const { name, description, kind, tags, category, previewMediaId, sourceProjectId } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'A name is required.' });
  if (!['design', 'video'].includes(kind)) return res.status(400).json({ error: 'Kind must be design or video.' });
  if (!sourceProjectId) return res.status(400).json({ error: 'A design/video template needs a project to publish from.' });
  const p = db.getProject(req.user.id, sourceProjectId);
  if (!p) return res.status(400).json({ error: 'Project not found.' });
  if (p.type !== kind) return res.status(400).json({ error: `That project is a ${p.type} project, not ${kind}.` });
  if (previewMediaId !== undefined && previewMediaId !== null && !db.getMedia(req.user.id, previewMediaId)) {
    return res.status(400).json({ error: 'Preview media not found in your library.' });
  }
  let content = {};
  try { content = JSON.parse(p.content || '{}'); } catch { content = {}; }
  const tagString = Array.isArray(tags) ? tags.map(String).join(', ') : String(tags || '');
  const t = db.createMarketplaceTemplate(req.user.id, {
    kind, sourceType: 'project', sourceId: p.id,
    name: name.trim(), description: description || '',
    tags: tagString, category: category || 'General',
    content, previewMediaId: previewMediaId || null,
  });
  db.audit(req.user.id, 'marketplace_publish', 'marketplace_template', t.id, `Published template "${t.name}" (${t.kind}) to the in-app marketplace`);
  res.status(201).json({ template: publicTemplate({ ...t, author_name: req.user.name }) });
});

// My published templates (including removed ones).
router.get('/mine/all', auth.requireAuth, (req, res) => {
  const all = db.listMarketplaceTemplates({ includeRemoved: true });
  res.json({ templates: all.filter((t) => t.user_id === req.user.id).map(publicTemplate) });
});

// Install: creates a real editable project from the stored content
// snapshot (never a flattened image).
router.post('/:id/install', auth.requireAuth, (req, res) => {
  const t = db.getMarketplaceTemplate(req.params.id);
  if (!t || t.status !== 'active') return res.status(404).json({ error: 'Template not found.' });
  let content = {};
  try { content = JSON.parse(t.content || '{}'); } catch { content = {}; }
  const p = db.createProject(req.user.id, { name: `${t.name} (from marketplace)`, type: t.kind, content });
  db.updateMarketplaceTemplate(t.id, { downloads: t.downloads + 1 });
  db.audit(req.user.id, 'marketplace_install', 'marketplace_template', t.id, `Installed template "${t.name}" as project ${p.id}`);
  res.status(201).json({
    installed: { type: 'project', id: p.id, name: p.name, kind: p.type },
    template: publicTemplate(db.getMarketplaceTemplate(t.id)),
  });
});

router.post('/:id/rate', auth.requireAuth, (req, res) => {
  const t = db.getMarketplaceTemplate(req.params.id);
  if (!t || t.status !== 'active') return res.status(404).json({ error: 'Template not found.' });
  const rating = Number(req.body && req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
  }
  db.rateMarketplaceTemplate(t.id, req.user.id, rating, (req.body && req.body.comment) || '');
  const fresh = db.listMarketplaceTemplates({ q: '', kind: '' }).find((x) => x.id === t.id)
    || db.getMarketplaceTemplate(t.id);
  res.json({ template: publicTemplate(fresh) });
});

router.post('/:id/report', auth.requireAuth, (req, res) => {
  const t = db.getMarketplaceTemplate(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found.' });
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required.' });
  db.reportMarketplaceTemplate(t.id, req.user.id, reason);
  res.json({ ok: true, note: 'Reported. An admin reviews reported templates.' });
});

// Unpublish my own template (status -> removed).
router.delete('/:id', auth.requireAuth, (req, res) => {
  const t = db.getMarketplaceTemplate(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found.' });
  const isOwner = t.user_id === req.user.id;
  if (!isOwner && req.user.role !== 'OWNER' && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only the author (or an admin) can remove this template.' });
  }
  db.updateMarketplaceTemplate(t.id, { status: 'removed' });
  db.audit(req.user.id, 'marketplace_unpublish', 'marketplace_template', t.id, `Unpublished template "${t.name}"`);
  res.json({ ok: true });
});

module.exports = router;
