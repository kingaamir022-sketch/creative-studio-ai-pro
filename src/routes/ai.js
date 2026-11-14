'use strict';
// AI Creative Studio routes (Phase 7).
//   AI jobs: every generation mode runs as an async job (create → poll →
//   result), with cancel + retry. Results are saved to the Media Library.
//   Without a configured provider key every mode refuses with
//   PROVIDER_KEY_NEEDED and creates no output — the job fails honestly.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const ai = require('../ai');
const providers = require('../providers');
const credits = require('../credits');

const router = express.Router();

const MODE_PARAMS = {
  'image': ['prompt', 'size', 'style'],
  'image-edit': ['prompt', 'size', 'style', 'sourceMediaId'],
  'video': ['prompt', 'duration', 'aspect'],
  'video-image': ['prompt', 'duration', 'aspect', 'sourceMediaId'],
  'voice': ['text', 'voiceProfileId'],
  'quiz': ['topic', 'count', 'difficulty', 'language'],
  'design': ['prompt', 'name', 'projectId'],
  'transcribe': ['mediaId', 'language', 'shortsJobId'],
  'music-mood': ['mediaId'],
  'music-generate': ['prompt', 'duration'],
  'write': ['prompt', 'task', 'tone', 'length'],
  'deck': ['topic', 'slideCount', 'style', 'audience'],
  // v2.5.0 new modes.
  'autocut': ['mediaIds', 'template', 'musicMediaId', 'name'],
  'editpilot': ['projectId', 'prompt', 'alternate'],
  'seedance': ['providerId', 'prompt', 'sourceMediaId', 'duration', 'aspect', 'seedanceMode', 'editPrompt'],
  'video-enhance': ['mediaId', 'kind', 'strength'],
  'video-translate': ['mediaId', 'fromLanguage', 'toLanguage', 'voiceProfileId'],
  'director': ['title', 'premise', 'characters', 'episodes'],
  'avatar': ['script', 'photoMediaId', 'voiceProfileId', 'name'],
  'infinite-canvas': ['prompt', 'skill'],
  'lyrics': ['mediaId', 'language'],
  'ai-lab': ['topic', 'kind', 'count'],
  'batch-edit': ['projectIds', 'op'],
  'retouch': ['mediaId', 'kind', 'intensity'],
  'bilingual': ['mediaId', 'language', 'secondLanguage', 'speakers'],
  'transcript-edit': ['mediaId', 'cues', 'keepText'],
  'silence-remove': ['mediaId', 'thresholdDb', 'minDuration', 'keepPadding'],
  'magic-grab': ['mediaId', 'x', 'y'],
};

function cleanParams(mode, body) {
  const allowed = MODE_PARAMS[mode] || [];
  const out = {};
  for (const k of allowed) if (body && body[k] !== undefined) out[k] = body[k];
  return out;
}

// --- Provider status for the AI Studio (per kind, active + configured) ---
router.get('/status', auth.requireAuth, (req, res) => {
  const status = providers.providerStatus();
  const byKind = {};
  for (const kind of providers.KINDS) {
    const list = status.filter((p) => p.kind === kind);
    byKind[kind] = {
      active: providers.activeProviderForKind(kind),
      providers: list,
      configured: list.some((p) => p.configured),
    };
  }
  // v2.5.0: extended providers (Kling/Veo/PixVerse/Sora/Seedance,
  // Seedream/Nano Banana, Pexels) — same shape, listed under their kind.
  const ext = ai.extendedProviderStatus();
  for (const p of ext) {
    if (!byKind[p.kind]) byKind[p.kind] = { active: db.getActiveProvider(p.kind), providers: [], configured: false };
    byKind[p.kind].providers.push(p);
    if (p.configured) byKind[p.kind].configured = true;
    if (db.getActiveProvider(p.kind) === p.id) byKind[p.kind].active = p.id;
  }
  res.json({ kinds: byKind, modes: ai.AI_MODES, extendedProviders: ext, canvasSkills: ai.CANVAS_SKILLS });
});

// v2.5.0: save / remove a key for an extended provider (encrypted store,
// same as the core providers in routes/system.js — which only knows the
// core registry). Pexels included (id 'pexels', kind 'stock').
router.post('/providers/:id/key', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  const { encrypt } = require('../crypto-util');
  const { key } = req.body || {};
  const def = ai.getExtendedProvider(req.params.id);
  if (!def) return res.status(404).json({ error: 'Unknown extended provider. Core providers are managed in Settings → AI Providers.' });
  if (!key || typeof key !== 'string' || key.trim().length < 8) {
    return res.status(400).json({ error: 'A valid API key is required (at least 8 characters).' });
  }
  db.upsertProvider(def.id, def.label, encrypt(key.trim()), 'stored');
  db.audit(req.user.id, 'provider_key_saved', 'provider', null, `API key saved for ${def.label} (encrypted, never shown in full)`);
  res.json({ ok: true, provider: ai.extendedProviderStatus().find((p) => p.id === def.id) });
});

router.delete('/providers/:id/key', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  const def = ai.getExtendedProvider(req.params.id);
  if (!def) return res.status(404).json({ error: 'Unknown extended provider.' });
  db.upsertProvider(def.id, def.label, null, 'none');
  db.audit(req.user.id, 'provider_key_removed', 'provider', null, `API key removed for ${def.label}`);
  res.json({ ok: true });
});

// Set the active provider per kind (extended ids included).
router.post('/providers/active', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  const { kind, provider } = req.body || {};
  const ext = ai.getExtendedProvider(provider);
  if (!ext || ext.kind !== kind) return res.status(400).json({ error: `Unknown extended provider "${provider}" for kind "${kind}".` });
  db.setActiveProvider(kind, provider);
  db.audit(req.user.id, 'provider_active_set', 'provider', null, `Active ${kind} provider set to ${ext.label}`);
  res.json({ ok: true, kind, provider });
});

// --- Silence detection (sync, local FFmpeg) — #45 --------------------------
router.post('/silence/detect', auth.requireAuth, async (req, res) => {
  const { mediaId, thresholdDb, minDuration } = req.body || {};
  if (!mediaId) return res.status(400).json({ error: 'mediaId is required.' });
  try {
    const out = await ai.detectSilenceFor(req.user.id, { mediaId, thresholdDb, minDuration });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err).slice(0, 500) });
  }
});

// --- Jobs ---
router.get('/jobs', auth.requireAuth, (req, res) => {
  res.json({ jobs: db.listAiJobs(req.user.id).map(ai.publicAiJob) });
});

router.get('/jobs/:id', auth.requireAuth, (req, res) => {
  const job = db.getAiJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'AI job not found.' });
  res.json({ job: ai.publicAiJob(job) });
});

// Create + start a job. The generation runs in the background; poll the job.
// Phase 8: pre-flight credit check — the job is only created when the user
// can afford it (charged on success inside src/ai.js).
router.post('/jobs', auth.requireAuth, (req, res) => {
  const { mode, name } = req.body || {};
  if (!mode || !ai.AI_MODES.includes(mode)) {
    return res.status(400).json({ error: `Unknown AI mode: ${mode}. Available: ${ai.AI_MODES.join(', ')}.` });
  }
  const action = credits.AI_MODE_COSTS[mode];
  if (action) {
    const check = credits.checkCredits(req.user.id, action);
    if (!check.ok) return res.status(402).json({ error: check.error, code: check.code, needed: check.needed, balance: check.balance });
  }
  try {
    const job = ai.createAiJobEntry(req.user.id, { mode, name, params: cleanParams(mode, req.body || {}) });
    db.audit(req.user.id, 'ai_job_created', 'ai_job', job.id, `AI ${mode} job started`);
    res.status(201).json({ job: ai.publicAiJob(job) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/jobs/:id/cancel', auth.requireAuth, (req, res) => {
  const job = ai.cancelAiJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'AI job not found.' });
  res.json({ job: ai.publicAiJob(job) });
});

router.post('/jobs/:id/retry', auth.requireAuth, (req, res) => {
  const job0 = db.getAiJob(req.user.id, req.params.id);
  if (!job0) return res.status(404).json({ error: 'AI job not found.' });
  const action = credits.AI_MODE_COSTS[job0.mode];
  if (action) {
    const check = credits.checkCredits(req.user.id, action);
    if (!check.ok) return res.status(402).json({ error: check.error, code: check.code, needed: check.needed, balance: check.balance });
  }
  try {
    const job = ai.retryAiJob(req.user.id, req.params.id);
    if (!job) return res.status(404).json({ error: 'AI job not found.' });
    res.json({ job: ai.publicAiJob(job) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/jobs/:id', auth.requireAuth, (req, res) => {
  const ok = db.deleteAiJob(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'AI job not found.' });
  res.json({ ok: true });
});

module.exports = router;
