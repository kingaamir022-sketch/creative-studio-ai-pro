'use strict';
// Dashboard, settings, providers, subscription, notifications, jobs.
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const { detectFFmpeg } = require('../ffmpeg');
const providers = require('../providers');
const { encrypt } = require('../crypto-util');
const PLANS = require('./plans');

const router = express.Router();

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// --- Dashboard ---
router.get('/dashboard', auth.requireAuth, async (req, res) => {
  const counts = db.dashboardCounts(req.user.id);
  const ff = await detectFFmpeg();
  const plan = PLANS[req.user.plan] || PLANS.Free;
  const recent = db.listProjects(req.user.id, {}).slice(0, 6);
  const recentMedia = db.listMedia(req.user.id, {}).slice(0, 6);
  let diskFree = null;
  try {
    const uploads = config.uploadsDir;
    fs.mkdirSync(uploads, { recursive: true });
    diskFree = null; // free-space probing is platform-specific; report used bytes instead
  } catch { /* ignore */ }
  res.json({
    counts: {
      projects: counts.projects, media: counts.media, jobs: counts.jobs,
      jobsActive: counts.jobsActive, trashedProjects: counts.trashedProjects,
    },
    creditsBalance: req.user.credits_balance,
    plan: req.user.plan,
    planLimits: plan,
    storage: {
      usedBytes: counts.storageBytes, usedLabel: formatBytes(counts.storageBytes),
      limitBytes: plan.storageMB ? plan.storageMB * 1024 * 1024 : null,
      limitLabel: plan.storageMB ? formatBytes(plan.storageMB * 1024 * 1024) : 'Unlimited',
    },
    system: {
      db: 'ok',
      ffmpeg: ff,
      maxUploadMB: config.maxUploadMB,
      version: '2.2.1 (Free AI + Super Admin)',
    },
    recentProjects: recent.map((p) => ({ id: p.id, name: p.name, type: p.type, updatedAt: p.updated_at })),
    recentMedia: recentMedia.map((m) => ({ id: m.id, originalName: m.original_name, kind: m.kind, url: `/api/media/${m.id}/file`, createdAt: m.created_at })),
  });
});

// --- Notifications (real audit events for this user) ---
router.get('/notifications', auth.requireAuth, (req, res) => {
  const items = db.listAudit(req.user.id, 30).map((a) => ({
    id: a.id, action: a.action, detail: a.detail, entity: a.entity, entityId: a.entity_id, createdAt: a.created_at,
  }));
  res.json({ notifications: items });
});

// --- Jobs (rendering engine live in Phase 3; full job API is /api/video/jobs) ---
router.get('/jobs', auth.requireAuth, (req, res) => {
  res.json({ jobs: db.listJobs(req.user.id), note: 'Render jobs are managed in the Export Center (/api/video/jobs).' });
});

// --- Settings: profile ---
router.patch('/profile', auth.requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  const u = db.updateUser(req.user.id, { name: name.trim() });
  db.audit(req.user.id, 'profile_update', 'user', u.id, 'Profile name updated');
  res.json({ user: auth.publicUser(u) });
});

// --- AI Providers ---
router.get('/providers', auth.requireAuth, (req, res) => {
  res.json({ providers: providers.providerStatus() });
});

router.post('/providers/:id/key', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  const { key } = req.body || {};
  const def = providers.PROVIDERS.find((p) => p.id === req.params.id);
  if (!def) return res.status(404).json({ error: 'Unknown provider.' });
  if (!key || typeof key !== 'string' || key.trim().length < 8) {
    return res.status(400).json({ error: 'A valid API key is required (at least 8 characters).' });
  }
  db.upsertProvider(def.id, def.label, encrypt(key.trim()), 'stored');
  db.audit(req.user.id, 'provider_key_saved', 'provider', null, `API key saved for ${def.label} (encrypted, never shown in full)`);
  res.json({ ok: true, provider: providers.providerStatus().find((p) => p.id === def.id) });
});

router.delete('/providers/:id/key', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  const def = providers.PROVIDERS.find((p) => p.id === req.params.id);
  if (!def) return res.status(404).json({ error: 'Unknown provider.' });
  db.upsertProvider(def.id, def.label, null, 'none');
  db.audit(req.user.id, 'provider_key_removed', 'provider', null, `API key removed for ${def.label}`);
  res.json({ ok: true });
});

// --- Provider config: base URL + model override (Phase 7) ---
// Lets a provider point at a compatible endpoint (or a local mock in
// tests) and pick a model. Keys are never accepted here — only config.
router.post('/providers/:id/config', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  const def = providers.PROVIDERS.find((p) => p.id === req.params.id);
  if (!def) return res.status(404).json({ error: 'Unknown provider.' });
  const { baseUrl, model } = req.body || {};
  if (baseUrl !== undefined && (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl.trim()))) {
    return res.status(400).json({ error: 'Base URL must start with http:// or https://.' });
  }
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.trim().length > 120)) {
    return res.status(400).json({ error: 'Model must be a short non-empty string.' });
  }
  const saved = db.upsertProviderConfig(def.id, {
    baseUrl: baseUrl === undefined ? undefined : baseUrl.trim(),
    model: model === undefined ? undefined : model.trim(),
  });
  db.audit(req.user.id, 'provider_config_saved', 'provider', null, `Config saved for ${def.label} (baseUrl/model)`);
  res.json({ ok: true, config: saved, provider: providers.providerStatus().find((p) => p.id === def.id) });
});

// --- Active provider per kind (when a kind has several providers) ---
router.post('/providers/active', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  const { kind, provider } = req.body || {};
  if (!providers.KINDS.includes(kind)) return res.status(400).json({ error: `Unknown kind: ${kind}. Available: ${providers.KINDS.join(', ')}.` });
  const def = providers.PROVIDERS.find((p) => p.id === provider);
  if (!def || def.kind !== kind) return res.status(400).json({ error: `Provider "${provider}" is not an ${kind} provider.` });
  db.setActiveProvider(kind, provider);
  db.audit(req.user.id, 'provider_active_set', 'provider', null, `Active ${kind} provider set to ${def.label}`);
  res.json({ ok: true, kind, provider, providers: providers.providerStatus() });
});

// --- Test connection: a minimal REAL call; reports the actual result ---
router.post('/providers/:id/test', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const def = providers.PROVIDERS.find((p) => p.id === req.params.id);
  if (!def) return res.status(404).json({ error: 'Unknown provider.' });
  const result = await providers.testProvider(def.id);
  res.json({ provider: def.id, ...result });
});

// --- Subscription ---
router.get('/subscription', auth.requireAuth, (req, res) => {
  const plan = PLANS[req.user.plan] || PLANS.Free;
  res.json({
    currentPlan: req.user.plan,
    creditsBalance: req.user.credits_balance,
    plans: Object.values(PLANS),
    planLimits: plan,
    usage: db.listUsage(req.user.id, 50),
    note: 'Phase 8: every AI generation, render and bulk row deducts credits from the ledger below (see Billing for the full price list). Plan upgrades are requests the OWNER approves in Admin — no payment is taken in this build.',
  });
});

// Plan change is OWNER or Super Admin and only between listed plans; no
// payment is taken. The Lifetime plan is reserved for the OWNER account —
// a Super Admin may change their own (or another's) plan to any other
// listed plan, but never to Lifetime.
router.post('/subscription/plan', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  const { plan } = req.body || {};
  if (!PLANS[plan]) return res.status(400).json({ error: `Unknown plan. Available: ${Object.keys(PLANS).join(', ')}.` });
  if (plan === 'Lifetime' && req.user.role !== 'OWNER') {
    return res.status(403).json({ error: 'The Lifetime plan is reserved for the OWNER account.' });
  }
  const u = db.updateUser(req.user.id, { plan, credits_balance: PLANS[plan].credits === null ? req.user.credits_balance : PLANS[plan].credits });
  db.audit(req.user.id, 'plan_change', 'user', u.id, `Plan changed to ${plan} (no payment taken)`);
  res.json({ user: auth.publicUser(u), planLimits: PLANS[plan] });
});

// --- Admin: user list (OWNER/ADMIN only) ---
router.get('/users', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  res.json({ users: db.listUsers() });
});

router.patch('/users/:id', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  const { role, plan } = req.body || {};
  if (role !== undefined && !['OWNER', 'ADMIN', 'USER'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (plan !== undefined && !PLANS[plan]) return res.status(400).json({ error: 'Invalid plan.' });
  const target = db.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  // Super Admin rule: the OWNER account is untouchable for ADMIN callers,
  // and granting the OWNER role (or the Lifetime plan) stays OWNER-only.
  if (target.role === 'OWNER' && req.user.role !== 'OWNER') {
    return res.status(403).json({ error: 'The OWNER account is protected — only the OWNER can manage it.' });
  }
  if (role === 'OWNER' && req.user.role !== 'OWNER') {
    return res.status(403).json({ error: 'Only the OWNER can grant the OWNER role.' });
  }
  if (plan === 'Lifetime' && req.user.role !== 'OWNER') {
    return res.status(403).json({ error: 'The Lifetime plan is reserved for the OWNER account.' });
  }
  if (target.id === req.user.id && role && role !== req.user.role) {
    return res.status(400).json({ error: 'You cannot change your own role.' });
  }
  const u = db.updateUser(target.id, { role, plan });
  db.audit(req.user.id, 'user_update', 'user', u.id, `Updated ${u.email}: role=${u.role}, plan=${u.plan}`);
  res.json({ user: auth.publicUser(u) });
});

module.exports = router;
