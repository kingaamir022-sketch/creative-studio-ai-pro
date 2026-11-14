'use strict';
// Analytics (Phase 8): real numbers from the DB only.
//
// Renders over time, AI generations by mode, posts by status/platform,
// storage used, top marketplace templates, credit burn. No invented
// benchmarks, no "industry average" comparisons — everything here is
// counted from this install's own rows.
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');

const router = express.Router();

router.use(auth.requireAuth);

function dirSize(dir) {
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
}

router.get('/', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  // C-22: OWNER/ADMIN see platform-wide numbers; a plain USER sees only
  // their own rows (totals, render/AI series and storage all scoped).
  const isAdmin = req.user.role === 'OWNER' || req.user.role === 'ADMIN';
  const stats = isAdmin ? db.platformStats() : db.userStats(req.user.id);
  const userFilter = isAdmin ? '' : ' WHERE user_id = ?';
  const userArgs = isAdmin ? [] : [req.user.id];
  const rendersByDay = db.db.prepare(
    `SELECT date(created_at) AS day, COUNT(*) AS count FROM jobs WHERE created_at >= ?${isAdmin ? '' : ' AND user_id = ?'} GROUP BY day ORDER BY day`
  ).all(since, ...userArgs);
  const rendersByStatus = db.db.prepare(
    `SELECT status, COUNT(*) AS count FROM jobs${userFilter} GROUP BY status`
  ).all(...userArgs);
  const aiByMode = db.db.prepare(
    `SELECT mode, COUNT(*) AS count FROM ai_jobs${userFilter} GROUP BY mode ORDER BY count DESC`
  ).all(...userArgs);
  const aiByStatus = db.db.prepare(
    `SELECT status, COUNT(*) AS count FROM ai_jobs${userFilter} GROUP BY status`
  ).all(...userArgs);
  const postsByStatus = db.db.prepare(
    "SELECT status, COUNT(*) AS count FROM social_posts WHERE user_id = ? GROUP BY status"
  ).all(req.user.id);
  const postsByPlatform = db.db.prepare(
    "SELECT platform, COUNT(*) AS count FROM social_posts WHERE user_id = ? GROUP BY platform"
  ).all(req.user.id);
  const creditBurn = db.db.prepare(
    "SELECT action, COUNT(*) AS count, SUM(credits) AS total FROM usage_log WHERE user_id = ? AND created_at >= ? AND credits < 0 GROUP BY action ORDER BY total ASC"
  ).all(req.user.id, since);
  const creditEarned = db.db.prepare(
    "SELECT SUM(credits) AS total FROM usage_log WHERE user_id = ? AND created_at >= ? AND credits > 0"
  ).get(req.user.id, since);
  const myCredits = db.getUserById(req.user.id).credits_balance;
  const topTemplates = db.db.prepare(
    "SELECT m.id, m.name, m.kind, m.downloads, COALESCE((SELECT AVG(rating) FROM marketplace_ratings WHERE template_id = m.id), 0) AS avg_rating FROM marketplace_templates m WHERE m.status = 'active' ORDER BY m.downloads DESC, m.created_at DESC LIMIT 10"
  ).all();
  const storage = isAdmin ? {
    uploads: dirSize(config.uploadsDir),
    renders: dirSize(config.rendersDir),
  } : {
    // C-22: a plain USER's storage card counts only their own folders.
    uploads: dirSize(path.join(config.uploadsDir, String(req.user.id))),
    renders: dirSize(path.join(config.rendersDir, String(req.user.id))),
  };
  const mediaByKind = db.db.prepare(
    "SELECT kind, COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes FROM media WHERE user_id = ? GROUP BY kind"
  ).all(req.user.id);
  res.json({
    range: { days, since },
    totals: {
      users: stats.users, projects: stats.projects, media: stats.media,
      renders: stats.renderJobs, rendersDone: stats.rendersDone,
      aiJobs: stats.aiJobs, socialPosts: stats.socialPosts,
      bulkJobs: stats.bulkJobs, shortsJobs: stats.shortsJobs,
      marketplaceTemplates: stats.marketplaceTemplates,
    },
    rendersByDay, rendersByStatus,
    aiByMode, aiByStatus,
    postsByStatus, postsByPlatform,
    creditBurn, creditEarned: (creditEarned && creditEarned.total) || 0,
    myCredits,
    topTemplates, storage, mediaByKind,
    note: 'Every number here is counted from this install\'s own database. No benchmarks, no industry averages.',
  });
});

module.exports = router;
