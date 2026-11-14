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
// as a JSON snapshot, kind is 'design'|'video'|'deck' (v2.2.4 added deck),
// and status is 'active'|'removed'.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { listBuiltinTemplates, builtinTemplate } = require('../design-templates');

const router = express.Router();
const KINDS = ['design', 'video', 'deck'];

// Built-in template library (v2.2.4): 26 templates (20 design, 3 video,
// 3 deck) — real editable projects, searchable/browsable here. Installing
// one creates a real project of the matching type. v2.5.0: 6 more built-ins
// (résumé, logo, certificate, menu, invitation, presentation set).
router.get('/builtin', auth.requireAuth, (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : '';
  const q = String(req.query.q || '').trim().toLowerCase();
  const category = String(req.query.category || '').trim();
  let list = listBuiltinTemplates(kind || undefined);
  if (q) list = list.filter((t) => t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q));
  if (category) list = list.filter((t) => t.category === category);
  res.json({
    templates: list.map((t) => ({ id: t.id, name: t.name, category: t.category, size: t.size, kind: t.kind, builtin: true, width: t.width, height: t.height })),
    categories: [...new Set(listBuiltinTemplates().map((t) => t.category))].sort(),
    counts: { design: listBuiltinTemplates('design').length, video: listBuiltinTemplates('video').length, deck: listBuiltinTemplates('deck').length },
    note: 'Built-in templates — installing one creates a real editable project, never a flattened image.',
  });
});

// --- v2.5.0 #56: trending feed + guided placeholder swap -------------------
// Trending = the community's most-installed templates on this install,
// plus the newest built-ins. When the community list is still empty (a
// fresh install), the feed says so and shows the built-in starters
// instead — labelled as starters, never as if they were trending installs.
const TRENDING_BUILTIN_IDS = ['builtin-resume', 'builtin-logo', 'builtin-certificate', 'builtin-menu', 'builtin-birthday-invite', 'builtin-deck-presentation-set'];
router.get('/trending', auth.requireAuth, (req, res) => {
  const community = db.listMarketplaceTemplates({ q: '', kind: '' })
    .sort((a, b) => (b.downloads || 0) - (a.downloads || 0)).slice(0, 8)
    .map(publicTemplate);
  const starters = TRENDING_BUILTIN_IDS
    .map((id) => builtinTemplate(id)).filter(Boolean)
    .map((t) => ({ id: t.id, name: t.name, category: t.category, size: t.size, kind: t.kind, builtin: true, width: t.width, height: t.height }));
  res.json({
    trending: community,
    trendingSource: community.length ? 'community-installs' : 'none-yet',
    starters,
    rows: {
      forYou: listBuiltinTemplates().slice(0, 8).map((t) => ({ id: t.id, name: t.name, category: t.category, size: t.size, kind: t.kind, builtin: true, width: t.width, height: t.height })),
      trending: community.length ? community : starters,
      commercial: listBuiltinTemplates().filter((t) => ['Business', 'Promo'].includes(t.category)).map((t) => ({ id: t.id, name: t.name, category: t.category, size: t.size, kind: t.kind, builtin: true, width: t.width, height: t.height })),
      social: listBuiltinTemplates().filter((t) => t.category === 'Social').map((t) => ({ id: t.id, name: t.name, category: t.category, size: t.size, kind: t.kind, builtin: true, width: t.width, height: t.height })),
    },
    note: community.length
      ? 'Trending is ranked by installs on this install.'
      : 'No community template has been installed yet — trending is empty, so the feed shows new built-in starters instead.',
  });
});

// Placeholders of a built-in template: image layers (swap the picture)
// and text layers whose name/text reads like a placeholder ("YOUR …",
// "Photo placeholder", "Your Name" …). The guided swap flow in the UI
// offers exactly these — nothing is guessed from other layers.
//
// Layer ids are STABLE across builds: listBuiltinTemplates() rebuilds the
// template (and its random layer ids) on every call, so a layerId returned
// by GET /placeholders would not exist in the fresh build used by POST
// /install. The placeholder id is therefore the layer's index
// ("layer:<index>"), resolved back to that index at install time.
function templatePlaceholders(t) {
  const out = [];
  const content = t.content || {};
  if (t.kind === 'design' && Array.isArray(content.layers)) {
    for (let i = 0; i < content.layers.length; i++) {
      const layer = content.layers[i];
      if (layer.type === 'image') {
        out.push({ layerId: `layer:${i}`, index: i, name: layer.name || 'Image', kind: 'image', currentText: '' });
      } else if (layer.type === 'text') {
        const text = String((layer.text && layer.text.text) || '');
        const name = String(layer.name || '');
        if (/^(YOUR|Your Name|Your Title|Your Business|Your Property|YOUR PROPERTY)/.test(name)
          || /^(YOUR|Your Name|Your Title|Your Business|Your Property|YOUR PROPERTY)/.test(text)
          || /placeholder/i.test(name)) {
          out.push({ layerId: `layer:${i}`, index: i, name: name || 'Text', kind: 'text', currentText: text });
        }
      }
    }
  }
  return out;
}
router.get('/builtin/:id/placeholders', auth.requireAuth, (req, res) => {
  const t = builtinTemplate(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found.' });
  res.json({ template: { id: t.id, name: t.name, kind: t.kind }, placeholders: templatePlaceholders(t) });
});

router.post('/builtin/:id/install', auth.requireAuth, (req, res) => {
  const t = builtinTemplate(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found.' });
  // Guided placeholder swap (v2.5.0 #56): swaps = [{ layerId, text?, mediaId? }]
  // applied to the template content BEFORE the project is created, so the
  // installed project already carries the user's own picture/text.
  const swaps = Array.isArray((req.body || {}).swaps) ? req.body.swaps : [];
  let content = t.content;
  if (swaps.length && t.kind === 'design' && content && Array.isArray(content.layers)) {
    const byId = new Map(content.layers.map((l) => [l.id, l]));
    for (const s of swaps) {
      // Stable placeholder ids are "layer:<index>" (see templatePlaceholders);
      // a raw layer id also resolves, for a swap sent against the same build.
      let layer = null;
      const m = /^layer:(\d+)$/.exec(String(s.layerId || ''));
      if (m) layer = content.layers[Number(m[1])] || null;
      else layer = byId.get(s.layerId) || null;
      if (!layer) return res.status(400).json({ error: `Placeholder layer ${s.layerId} not found in this template.` });
      if (s.mediaId !== undefined && s.mediaId !== null) {
        if (layer.type !== 'image') return res.status(400).json({ error: `Layer "${layer.name || layer.id}" is not an image placeholder — pick a text swap for it instead.` });
        const m = db.getMedia(req.user.id, Number(s.mediaId));
        if (!m) return res.status(400).json({ error: `Media ${s.mediaId} not found in your library.` });
        layer.image = { ...(layer.image || {}), mediaId: m.id, src: `/api/media/${m.id}/file` };
        layer.name = m.original_name || layer.name;
      }
      if (s.text !== undefined && s.text !== null) {
        if (layer.type !== 'text') return res.status(400).json({ error: `Layer "${layer.name || layer.id}" is not a text placeholder.` });
        if (typeof s.text !== 'string' || !s.text.trim() || s.text.length > 500) {
          return res.status(400).json({ error: 'Swap text must be 1–500 characters.' });
        }
        layer.text = { ...(layer.text || {}), text: s.text.trim() };
      }
    }
  }
  const p = db.createProject(req.user.id, { name: `${t.name} (template)`, type: t.kind, content });
  db.audit(req.user.id, 'builtin_template_install', 'project', p.id, `Installed built-in template "${t.name}" (${t.kind}) as project ${p.id}${swaps.length ? ` with ${swaps.length} placeholder swap(s)` : ''}`);
  res.status(201).json({ installed: { type: 'project', id: p.id, name: p.name, kind: p.type }, template: { id: t.id, name: t.name, kind: t.kind }, swapsApplied: swaps.length });
});

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
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Kind must be design, video or deck.' });
  if (!sourceProjectId) return res.status(400).json({ error: 'A design/video/deck template needs a project to publish from.' });
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
