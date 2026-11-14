'use strict';
// Stock Assets routes (v2.2.4, Release D).
//   GET  /api/stock/search?type=image|audio&q=...&page=&licenseType=&license=&category=
//   GET  /api/stock/item/:type/:id
//   POST /api/stock/save {type, id} — downloads into the Media Library
//
// All calls go to the Openverse public API (no key). Video search is NOT
// offered: Openverse v1 has no video endpoint, and the search response and
// the UI say so plainly. Saving the same asset twice returns the existing
// Media Library row (duplicate: true) — never a second copy.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const openverse = require('../openverse');

const router = express.Router();

function publicMedia(m) {
  if (!m) return null;
  return {
    id: m.id, originalName: m.original_name, mimeType: m.mime_type, kind: m.kind,
    sizeBytes: m.size_bytes, width: m.width, height: m.height,
    durationSeconds: m.duration_seconds, tags: m.tags,
    licenseNote: m.license_note || null,
    url: `/api/media/${m.id}/file`, createdAt: m.created_at,
  };
}

function handleStockError(res, err) {
  const code = err && err.code;
  if (code === 'NOT_FOUND') return res.status(404).json({ error: err.message, code });
  if (code === 'OPENVERSE_RATE_LIMITED') return res.status(503).json({ error: err.message, code });
  if (code === 'OPENVERSE_ERROR') return res.status(502).json({ error: err.message, code });
  return res.status(400).json({ error: String((err && err.message) || err).slice(0, 500) });
}

router.get('/search', auth.requireAuth, async (req, res) => {
  const type = req.query.type === 'audio' ? 'audio' : req.query.type === 'image' ? 'image' : null;
  if (!type) {
    return res.status(400).json({
      error: "Stock type must be 'image' or 'audio'. Openverse (the free stock source used here) has no video search in its API — upload your own video files instead.",
      code: 'NO_VIDEO_SEARCH',
    });
  }
  try {
    const out = await openverse.searchOpenverse(type, {
      q: req.query.q || '',
      page: req.query.page || 1,
      licenseType: req.query.licenseType || 'all',
      license: req.query.license || '',
      category: req.query.category || '',
    });
    res.json(out);
  } catch (err) {
    handleStockError(res, err);
  }
});

router.get('/item/:type/:id', auth.requireAuth, async (req, res) => {
  try {
    const item = await openverse.getOpenverseItem(req.params.type, req.params.id);
    res.json({ item });
  } catch (err) {
    handleStockError(res, err);
  }
});

router.post('/save', auth.requireAuth, async (req, res) => {
  const { type, id } = req.body || {};
  if (!type || !id) return res.status(400).json({ error: 'Stock type and asset id are required.' });
  try {
    const out = await openverse.saveToLibrary(req.user.id, type, id);
    res.status(out.duplicate ? 200 : 201).json({
      media: publicMedia(out.media),
      duplicate: out.duplicate,
      attribution: out.attribution,
      note: out.duplicate
        ? 'Already in your Media Library — the existing file was returned, no second copy was made.'
        : 'Saved to your Media Library. The attribution is stored on the media row (license_note) — keep it when you publish.',
    });
  } catch (err) {
    handleStockError(res, err);
  }
});

module.exports = router;
