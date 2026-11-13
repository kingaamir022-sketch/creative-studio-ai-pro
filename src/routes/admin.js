'use strict';
// Admin panel routes (Phase 8). OWNER/ADMIN only; regular users (role USER)
// get 403. Every admin action is written to the audit log.
//
// User management: list (search), role change (OWNER only), suspend /
// unsuspend (suspended users cannot log in and their sessions die),
// reset credits, delete (OWNER only, with confirmation in the UI).
// Platform stats, per-user usage detail, audit log, system health.
const express = require('express');
const fs = require('fs');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const credits = require('../credits');

const router = express.Router();

// All admin routes require OWNER or ADMIN.
router.use(auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'));

function publicAdminUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, plan: u.plan,
    creditsBalance: u.credits_balance, suspended: Boolean(u.suspended),
    createdAt: u.created_at,
  };
}

// Per-user usage detail, built from the real rows (db.userUsageSummary
// only returns spend totals + the usage log).
function userUsageDetail(userId) {
  const user = db.getUserById(userId);
  const one = (sql) => db.db.prepare(sql).get(userId).c;
  const summary = db.userUsageSummary(userId);
  return {
    counts: {
      projects: one('SELECT COUNT(*) AS c FROM projects WHERE user_id = ?'),
      media: one('SELECT COUNT(*) AS c FROM media WHERE user_id = ?'),
      mediaBytes: one('SELECT COALESCE(SUM(size_bytes),0) AS c FROM media WHERE user_id = ?'),
      renders: one('SELECT COUNT(*) AS c FROM jobs WHERE user_id = ?'),
      aiJobs: one('SELECT COUNT(*) AS c FROM ai_jobs WHERE user_id = ?'),
      socialPosts: one('SELECT COUNT(*) AS c FROM social_posts WHERE user_id = ?'),
      bulkJobs: one('SELECT COUNT(*) AS c FROM bulk_jobs WHERE user_id = ?'),
    },
    creditsBalance: user.credits_balance, plan: user.plan,
    spent: summary.spent, byAction: summary.byAction,
    recentUsage: summary.log.map((r) => ({
      id: r.id, action: r.action, credits: r.credits, detail: r.detail, createdAt: r.created_at,
    })),
  };
}

router.get('/users', (req, res) => {
  const users = db.listUsersAdmin(req.query.q || '');
  res.json({ users: users.map(publicAdminUser) });
});

router.get('/users/:id', (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: publicAdminUser(user), usage: userUsageDetail(user.id) });
});

// Role change — OWNER only.
router.patch('/users/:id/role', auth.requireRole('OWNER'), (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const role = req.body && req.body.role;
  if (!['OWNER', 'ADMIN', 'USER'].includes(role)) {
    return res.status(400).json({ error: 'Role must be OWNER, ADMIN or USER.' });
  }
  if (user.id === req.user.id && role !== 'OWNER') {
    return res.status(400).json({ error: 'You cannot demote your own account — another OWNER must do it.' });
  }
  db.updateUser(user.id, { role });
  db.audit(req.user.id, 'admin_role_change', 'user', user.id, `Role of ${user.email} changed to ${role}`);
  res.json({ user: publicAdminUser(db.getUserById(user.id)) });
});

router.post('/users/:id/suspend', (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot suspend your own account.' });
  db.updateUser(user.id, { suspended: 1 });
  db.deleteSessionsForUser(user.id);
  db.audit(req.user.id, 'admin_suspend', 'user', user.id, `Suspended ${user.email} (sessions revoked)`);
  res.json({ user: publicAdminUser(db.getUserById(user.id)) });
});

router.post('/users/:id/unsuspend', (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  db.updateUser(user.id, { suspended: 0 });
  db.audit(req.user.id, 'admin_unsuspend', 'user', user.id, `Unsuspended ${user.email}`);
  res.json({ user: publicAdminUser(db.getUserById(user.id)) });
});

// Reset a user's credit balance to a given amount (default: their plan's
// allowance). The old balance is recorded in the audit log.
router.post('/users/:id/reset-credits', (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const PLANS = require('./plans');
  const amount = req.body && req.body.credits !== undefined
    ? Number(req.body.credits)
    : (PLANS[user.plan] ? PLANS[user.plan].credits : 100);
  if (!Number.isInteger(amount) || amount < 0) return res.status(400).json({ error: 'credits must be a whole number >= 0.' });
  const old = user.credits_balance;
  db.updateUser(user.id, { credits_balance: amount });
  db.logUsage(user.id, 'credit_reset', amount - old, `Admin reset credits ${old} -> ${amount}`);
  db.audit(req.user.id, 'admin_credit_reset', 'user', user.id, `Credits of ${user.email} reset ${old} -> ${amount}`);
  res.json({ user: publicAdminUser(db.getUserById(user.id)) });
});

// Delete a user — OWNER only. Their sessions, data rows and media stay
// owned by the deleted id only where foreign keys allow; the user row
// itself is removed. Confirmation is the UI's job; this is the hard delete.
router.delete('/users/:id', auth.requireRole('OWNER'), (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  db.deleteUserById(user.id);
  db.audit(req.user.id, 'admin_user_delete', 'user', user.id, `Deleted user ${user.email} (${user.role}, ${user.plan})`);
  res.json({ ok: true });
});

// Platform stats (real DB counts only).
router.get('/stats', (req, res) => {
  res.json({ stats: db.platformStats() });
});

// Per-user usage detail.
router.get('/users/:id/usage', (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: publicAdminUser(user), usage: userUsageDetail(user.id) });
});

// Audit log (append-only), newest first.
router.get('/audit', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
  res.json({ entries: db.listAuditAll({ limit }) });
});

// System health: FFmpeg presence/version, disk usage of the uploads and
// renders dirs, DB file size, uptime.
router.get('/health', async (req, res) => {
  const { spawn } = require('child_process');
  const ffmpegVersion = await new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? out.split('\n')[0].trim() : null));
  });
  const dirSize = (dir) => {
    let total = 0; let files = 0;
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = `${d}/${e.name}`;
        if (e.isDirectory()) walk(full);
        else { total += fs.statSync(full).size; files += 1; }
      }
    };
    walk(dir);
    return { bytes: total, files };
  };
  const dbSize = fs.existsSync(config.dbPath) ? fs.statSync(config.dbPath).size : 0;
  const uploads = dirSize(config.uploadsDir);
  const renders = dirSize(config.rendersDir);
  res.json({
    health: {
      ffmpeg: ffmpegVersion ? { ok: true, version: ffmpegVersion } : { ok: false, version: null },
      db: { path: config.dbPath, bytes: dbSize },
      uploads, renders,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      memory: process.memoryUsage(),
    },
  });
});

module.exports = router;
