'use strict';
// Magic Tools routes (v2.2.2, Release A).
//   POST /api/magic/resize           — Magic Resize (pure local reflow)
//   GET  /api/magic/animate/presets — one-click animation presets
//   POST /api/magic/animate         — apply a preset to a design layer or a video clip
//   GET  /api/magic/model/status    — local segmentation model state
//   POST /api/magic/model/download  — start the first-use model download
//   POST /api/magic/remove-background — local U-2-Net background removal
//   POST /api/magic/grab           — extract the subject as its own layer
//   POST /api/magic/erase          — provider mask edit (needs image key)
//   POST /api/magic/expand         — AI outpaint (key) or local solid/blur
//
// Honest errors: PROVIDER_KEY_NEEDED (402) when a provider tool has no
// key, MODEL_DOWNLOAD_FAILED / RUNTIME_MISSING (503) when the local model
// cannot be fetched or the runtime is missing, NO_OBJECT_AT_POINT (400)
// when Grab is clicked on background. Nothing is faked and no output is
// created on failure.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const credits = require('../credits');
const { validateDesign } = require('../design-model');
const { reflowDesign, sizeById } = require('../magic-resize');
const magicSwitch = require('../magic-switch');
const { listPresets, applyPresetToLayer, applyPresetToClip } = require('../animation-presets');
const segmentation = require('../segmentation');
const magic = require('../magic-image');

const router = express.Router();

function publicMedia(m) {
  return {
    id: m.id, originalName: m.original_name, mimeType: m.mime_type, kind: m.kind,
    sizeBytes: m.size_bytes, width: m.width, height: m.height,
    tags: m.tags, url: `/api/media/${m.id}/file`, createdAt: m.created_at,
  };
}

function handleMagicError(res, err) {
  const code = err && err.code;
  if (code === 'PROVIDER_KEY_NEEDED') return res.status(402).json({ error: err.message, code });
  if (code === 'MODEL_DOWNLOAD_FAILED' || code === 'RUNTIME_MISSING') return res.status(503).json({ error: err.message, code });
  if (code === 'NOT_FOUND') return res.status(404).json({ error: err.message, code });
  if (code === 'NO_OBJECT_AT_POINT') return res.status(400).json({ error: err.message, code });
  if (code === 'INSUFFICIENT_CREDITS') return res.status(402).json({ error: err.message, code, needed: err.needed, balance: err.balance });
  return res.status(400).json({ error: String((err && err.message) || err).slice(0, 500) });
}

function creditGate(req, res, action) {
  const check = credits.checkCredits(req.user.id, action);
  if (!check.ok) {
    res.status(402).json({ error: check.error, code: check.code, needed: check.needed, balance: check.balance });
    return false;
  }
  return true;
}

// --- Magic Resize ------------------------------------------------------------
router.post('/resize', auth.requireAuth, (req, res) => {
  const { design, targetSizeId, targetWidth, targetHeight } = req.body || {};
  if (design === undefined) return res.status(400).json({ error: 'Design JSON is required.' });
  let tw = targetWidth;
  let th = targetHeight;
  if (targetSizeId) {
    const size = sizeById(String(targetSizeId));
    if (!size) return res.status(400).json({ error: `Unknown size preset: ${targetSizeId}.` });
    tw = size.width;
    th = size.height;
  }
  try {
    const out = reflowDesign(design, tw, th);
    res.json({ design: out.design, report: out.report });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Magic Switch (v2.2.4) ---------------------------------------------------
// Convert a design between formats/sizes/platforms AND translate its text.
// Resize is local (free); translation needs an LLM key and costs 1 credit
// (ai_write). The original project is never touched — the result is always
// a NEW project. Without a key the request refuses with 402 key_needed
// and creates nothing.
router.get('/switch/targets', auth.requireAuth, (req, res) => {
  res.json({
    targets: magicSwitch.SWITCH_TARGETS,
    languages: magicSwitch.SUPPORTED_LANGUAGES,
    note: 'Switching creates a NEW project — the original is never changed. Translation needs an LLM key (free Gemini works); without one the request refuses with key_needed and creates nothing.',
  });
});

router.post('/switch', auth.requireAuth, async (req, res) => {
  const { projectId, targetSizeId, translateTo, name } = req.body || {};
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' });
  if (translateTo && !creditGate(req, res, 'ai_write')) return;
  try {
    const out = await magicSwitch.switchDesign(req.user.id, { projectId, targetSizeId, translateTo, name });
    res.status(201).json(out);
  } catch (err) {
    handleMagicError(res, err);
  }
});

// --- Magic Animate -----------------------------------------------------------
router.get('/animate/presets', auth.requireAuth, (req, res) => {
  const target = req.query.target === 'clip' ? 'clip' : req.query.target === 'design' ? 'design' : null;
  res.json({ presets: listPresets(target) });
});

router.post('/animate', auth.requireAuth, (req, res) => {
  const { design, layerId, clip, presetId, durationMs, delayMs, loop } = req.body || {};
  if (!presetId) return res.status(400).json({ error: 'presetId is required.' });
  try {
    if (design !== undefined) {
      if (!layerId) return res.status(400).json({ error: 'layerId is required when animating a design layer.' });
      const v = validateDesign(design);
      if (!v.ok) return res.status(400).json({ error: 'Invalid design: ' + v.errors.join(' ') });
      const layer = (design.layers || []).find((l) => l.id === layerId);
      if (!layer) return res.status(404).json({ error: `Layer "${layerId}" not found in this design.` });
      const nextLayer = applyPresetToLayer(layer, presetId, { durationMs, delayMs, loop });
      const nextDesign = JSON.parse(JSON.stringify(design));
      nextDesign.layers = nextDesign.layers.map((l) => (l.id === layerId ? nextLayer : l));
      const check = validateDesign(nextDesign);
      if (!check.ok) return res.status(400).json({ error: 'Animated design is invalid: ' + check.errors.join(' ') });
      return res.json({ design: nextDesign, layer: nextLayer, animation: nextLayer.animation });
    }
    if (clip !== undefined) {
      const nextClip = applyPresetToClip(clip, presetId, { durationMs });
      return res.json({ clip: nextClip, keyframes: nextClip.keyframes, presetId: nextClip.animationPreset });
    }
    return res.status(400).json({ error: 'Send either { design, layerId } or { clip }.' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// --- Local model state -------------------------------------------------------
router.get('/model/status', auth.requireAuth, (req, res) => {
  res.json(segmentation.modelStatus());
});

router.post('/model/download', auth.requireAuth, (req, res) => {
  const st = segmentation.modelStatus();
  if (st.status === 'ready') return res.json({ status: 'ready', message: 'The background-removal model is already downloaded.' });
  // Start in the background — the download is ~168 MB and takes minutes;
  // the client polls GET /model/status for progress.
  segmentation.ensureModel().catch(() => { /* state carries the error */ });
  res.status(202).json({ status: 'downloading', message: 'Downloading the free background-removal model (~168 MB, once only). Poll GET /api/magic/model/status for progress.' });
});

// --- Background Remover / Grab (local, no key) -------------------------------
router.post('/remove-background', auth.requireAuth, async (req, res) => {
  const { mediaId } = req.body || {};
  if (!mediaId) return res.status(400).json({ error: 'mediaId is required.' });
  if (!creditGate(req, res, 'magic_bg_remove')) return;
  try {
    const out = await magic.removeBackground(req.user.id, mediaId);
    db.audit(req.user.id, 'magic_bg_remove', 'media', out.media.id, `Removed background from media ${mediaId} (local model)`);
    res.status(201).json({
      media: publicMedia(out.media), maskMedia: publicMedia(out.maskMedia),
      width: out.width, height: out.height,
      foregroundFraction: out.foregroundFraction, model: out.model, local: true,
    });
  } catch (err) {
    handleMagicError(res, err);
  }
});

router.post('/grab', auth.requireAuth, async (req, res) => {
  const { mediaId, maskMediaId, x, y } = req.body || {};
  if (!mediaId || !maskMediaId) return res.status(400).json({ error: 'mediaId and maskMediaId are required (run Background Remover first).' });
  if (x === undefined || y === undefined) return res.status(400).json({ error: 'Click point x and y (image pixels) are required.' });
  if (!creditGate(req, res, 'magic_grab')) return;
  try {
    const out = await magic.grabObject(req.user.id, { mediaId, maskMediaId, x, y });
    db.audit(req.user.id, 'magic_grab', 'media', out.media.id, `Grabbed subject from media ${mediaId} at (${out.clicked.x}, ${out.clicked.y})`);
    res.status(201).json({ media: publicMedia(out.media), bbox: out.bbox, clicked: out.clicked });
  } catch (err) {
    handleMagicError(res, err);
  }
});

// --- Eraser / Expand ---------------------------------------------------------
router.post('/erase', auth.requireAuth, async (req, res) => {
  const { mediaId, mask } = req.body || {};
  if (!mediaId || !mask) return res.status(400).json({ error: 'mediaId and mask (PNG data URL from the mask editor) are required.' });
  if (!creditGate(req, res, 'magic_erase')) return;
  try {
    const out = await magic.eraseImage(req.user.id, { mediaId, maskDataUrl: mask });
    db.audit(req.user.id, 'magic_erase', 'media', out.media.id, `Erased a masked region from media ${mediaId} (${out.provider})`);
    res.status(201).json({ media: publicMedia(out.media), provider: out.provider });
  } catch (err) {
    handleMagicError(res, err);
  }
});

router.post('/expand', auth.requireAuth, async (req, res) => {
  const { mediaId, targetWidth, targetHeight, mode, fill } = req.body || {};
  if (!mediaId) return res.status(400).json({ error: 'mediaId is required.' });
  const m = mode || 'ai';
  if (!['ai', 'solid', 'blur'].includes(m)) return res.status(400).json({ error: `Unknown expand mode: ${m}. Use ai, solid or blur.` });
  if (!creditGate(req, res, m === 'ai' ? 'magic_expand_ai' : 'magic_expand_local')) return;
  try {
    const out = await magic.expandImage(req.user.id, { mediaId, targetWidth, targetHeight, mode: m, fill });
    db.audit(req.user.id, 'magic_expand', 'media', out.media.id, `Expanded media ${mediaId} to ${out.width}×${out.height} (${m}, ${out.provider})`);
    res.status(201).json({ media: publicMedia(out.media), mode: out.mode, provider: out.provider, width: out.width, height: out.height });
  } catch (err) {
    handleMagicError(res, err);
  }
});

module.exports = router;
