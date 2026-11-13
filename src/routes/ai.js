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
  res.json({ kinds: byKind, modes: ai.AI_MODES });
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
