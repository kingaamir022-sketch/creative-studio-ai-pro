'use strict';
// Design routes (Phase 2): sizes/fonts metadata, design validation, built-in
// + user-saved templates, Brand Kit CRUD. Designs themselves are stored as
// project content via the Phase 1 projects API (type 'design').
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { SIZES, FONTS, validateDesign, validateBrand } = require('../design-model');
const { listBuiltinTemplates, builtinTemplate } = require('../design-templates');

const router = express.Router();

router.get('/sizes', auth.requireAuth, (req, res) => {
  res.json({ sizes: SIZES });
});
router.get('/fonts', auth.requireAuth, (req, res) => {
  res.json({ fonts: FONTS });
});

// Validate a design JSON object (used by the editor before saving).
router.post('/validate', auth.requireAuth, (req, res) => {
  const { design } = req.body || {};
  if (design === undefined) return res.status(400).json({ error: 'Design JSON is required.' });
  const result = validateDesign(design);
  res.json({ ok: result.ok, errors: result.errors });
});

// --- Templates ---
router.get('/templates', auth.requireAuth, (req, res) => {
  const builtins = listBuiltinTemplates();
  const mine = db.listUserTemplates(req.user.id).map(publicUserTemplate);
  res.json({ templates: [...builtins, ...mine] });
});

router.get('/templates/:id', auth.requireAuth, (req, res) => {
  const builtin = builtinTemplate(req.params.id);
  if (builtin) return res.json({ template: builtin });
  const t = db.getUserTemplate(req.user.id, req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found.' });
  res.json({ template: publicUserTemplate(t) });
});

router.post('/templates', auth.requireAuth, (req, res) => {
  const { name, category, content } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    return res.status(400).json({ error: 'Template name is required (max 100 characters).' });
  }
  if (category !== undefined && (typeof category !== 'string' || category.length > 60)) {
    return res.status(400).json({ error: 'Category must be a string (max 60 characters).' });
  }
  const result = validateDesign(content);
  if (!result.ok) return res.status(400).json({ error: 'Invalid design: ' + result.errors.join(' ') });
  const t = db.createUserTemplate(req.user.id, { name: name.trim(), category: category || 'My templates', content });
  db.audit(req.user.id, 'template_save', 'template', t.id, `Saved template "${t.name}"`);
  res.status(201).json({ template: publicUserTemplate(t) });
});

router.delete('/templates/:id', auth.requireAuth, (req, res) => {
  if (builtinTemplate(req.params.id)) {
    return res.status(400).json({ error: 'Built-in templates cannot be deleted.' });
  }
  if (!db.deleteUserTemplate(req.user.id, req.params.id)) {
    return res.status(404).json({ error: 'Template not found.' });
  }
  db.audit(req.user.id, 'template_delete', 'template', req.params.id, 'Deleted a saved template');
  res.json({ ok: true });
});

// --- Brand Kit ---
function publicBrand(b) {
  return {
    id: b.id, name: b.name, logoMediaId: b.logo_media_id,
    primaryColor: b.primary_color, secondaryColor: b.secondary_color, accentColor: b.accent_color,
    fontHeading: b.font_heading, fontBody: b.font_body,
    handles: JSON.parse(b.handles || '{}'),
    createdAt: b.created_at, updatedAt: b.updated_at,
  };
}

router.get('/brands', auth.requireAuth, (req, res) => {
  res.json({ brands: db.listBrands(req.user.id).map(publicBrand) });
});

router.post('/brands', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  const result = validateBrand(body);
  if (!result.ok) return res.status(400).json({ error: result.errors.join(' ') });
  if (body.logoMediaId) {
    const media = db.getMedia(req.user.id, body.logoMediaId);
    if (!media || media.kind !== 'image') return res.status(400).json({ error: 'Brand logo must be one of your uploaded images.' });
  }
  const b = db.createBrand(req.user.id, body);
  db.audit(req.user.id, 'brand_create', 'brand', b.id, `Created brand "${b.name}"`);
  res.status(201).json({ brand: publicBrand(b) });
});

router.patch('/brands/:id', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  const cur = db.getBrand(req.user.id, req.params.id);
  if (!cur) return res.status(404).json({ error: 'Brand not found.' });
  const merged = {
    name: body.name !== undefined ? body.name : cur.name,
    primaryColor: body.primaryColor !== undefined ? body.primaryColor : cur.primary_color,
    secondaryColor: body.secondaryColor !== undefined ? body.secondaryColor : cur.secondary_color,
    accentColor: body.accentColor !== undefined ? body.accentColor : cur.accent_color,
    fontHeading: body.fontHeading !== undefined ? body.fontHeading : cur.font_heading,
    fontBody: body.fontBody !== undefined ? body.fontBody : cur.font_body,
    handles: body.handles !== undefined ? body.handles : JSON.parse(cur.handles || '{}'),
    logoMediaId: body.logoMediaId !== undefined ? body.logoMediaId : cur.logo_media_id,
  };
  const result = validateBrand(merged);
  if (!result.ok) return res.status(400).json({ error: result.errors.join(' ') });
  if (merged.logoMediaId) {
    const media = db.getMedia(req.user.id, merged.logoMediaId);
    if (!media || media.kind !== 'image') return res.status(400).json({ error: 'Brand logo must be one of your uploaded images.' });
  }
  const b = db.updateBrand(req.user.id, req.params.id, body);
  db.audit(req.user.id, 'brand_update', 'brand', b.id, `Updated brand "${b.name}"`);
  res.json({ brand: publicBrand(b) });
});

router.delete('/brands/:id', auth.requireAuth, (req, res) => {
  if (!db.deleteBrand(req.user.id, req.params.id)) {
    return res.status(404).json({ error: 'Brand not found.' });
  }
  db.audit(req.user.id, 'brand_delete', 'brand', req.params.id, 'Deleted a brand');
  res.json({ ok: true });
});

function publicUserTemplate(t) {
  const design = JSON.parse(t.content || '{}');
  return {
    id: String(t.id), name: t.name, category: t.category, builtin: false,
    width: design.width, height: design.height, design,
    createdAt: t.created_at, updatedAt: t.updated_at,
  };
}

module.exports = router;
