'use strict';
// Social Media Studio routes (Phase 8) + Content Planner depth (v2.5.0, #25).
//
// Compose + schedule posts, content calendar, platform connections,
// AI captions/hashtags (LLM via Phase 7 — honest key_needed without a
// key), local template captions (clearly labelled, never "AI"), and
// publishing ONLY through official platform APIs when connected.
// A post is NEVER marked published without a real provider response;
// the user can also mark a post "posted manually elsewhere" with a note
// and link. The background scheduler (src/social-scheduler.js) picks up
// due posts; POST /scheduler/run runs it on demand.
//
// v2.5.0 planner (tables live in src/social-scheduler.js, which this
// router requires — the tables are created on first load, no db.js edit):
//   - Approval workflow: draft -> pending_approval -> approved/rejected
//     -> scheduled. A post with a planner row publishes ONLY once it is
//     approved (the scheduler skips unapproved due posts instead of
//     failing them). Posts without a planner row keep the old behaviour.
//   - Campaigns: named campaigns posts belong to; campaign view.
//   - Recurring / series posts: one post expands into dated copies that
//     share a series_id.
//   - Bulk scheduling: create many scheduled posts in one call.
//   - Best-time-to-post: from the user's own published history; when
//     there is no history yet the response says so and offers general
//     guidance windows, labelled as such (never presented as personal data).
//   - Calendar + post list filter by platform / status / campaign.
//   - Drag-and-drop rescheduling: POST /posts/:id/reschedule moves a
//     draft/scheduled/failed (or pending-approval) post to a new date.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');
const { encrypt, decrypt } = require('../crypto-util');
const { PLATFORMS, platformInfo, publishToPlatform } = require('../social-publish');
const { runDuePosts, publishOne } = require('../social-scheduler');
const ai = require('../ai');
const credits = require('../credits');

const router = express.Router();

// --- Planner helpers (social_planner / social_campaigns live in
// src/social-scheduler.js; these helpers read them through db.db) --------
function plannerRow(postId) {
  return db.db.prepare('SELECT * FROM social_planner WHERE post_id = ?').get(postId) || null;
}
function plannerFor(postId) {
  const row = plannerRow(postId);
  if (!row) return { approvalStatus: 'draft', campaignId: null, campaignName: null, seriesId: null, recurrence: null, bestTime: null };
  let recurrence = null;
  try { recurrence = row.recurrence ? JSON.parse(row.recurrence) : null; } catch { recurrence = null; }
  const camp = row.campaign_id
    ? db.db.prepare('SELECT name FROM social_campaigns WHERE id = ?').get(row.campaign_id)
    : null;
  return {
    approvalStatus: row.approval_status, campaignId: row.campaign_id,
    campaignName: camp ? camp.name : null, seriesId: row.series_id,
    recurrence, bestTime: row.best_time,
  };
}
function upsertPlanner(postId, fields) {
  const cur = plannerRow(postId);
  const next = {
    approval_status: fields.approvalStatus !== undefined ? fields.approvalStatus : (cur ? cur.approval_status : 'draft'),
    campaign_id: fields.campaignId !== undefined ? fields.campaignId : (cur ? cur.campaign_id : null),
    series_id: fields.seriesId !== undefined ? fields.seriesId : (cur ? cur.series_id : null),
    recurrence: fields.recurrence !== undefined
      ? (fields.recurrence ? JSON.stringify(fields.recurrence) : '')
      : (cur ? cur.recurrence : ''),
    best_time: fields.bestTime !== undefined ? fields.bestTime : (cur ? cur.best_time : null),
    decided_by: fields.decidedBy !== undefined ? fields.decidedBy : (cur ? cur.decided_by : null),
    decided_at: fields.decidedAt !== undefined ? fields.decidedAt : (cur ? cur.decided_at : null),
  };
  db.db.prepare(`INSERT INTO social_planner
    (post_id, approval_status, campaign_id, series_id, recurrence, best_time, decided_by, decided_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(post_id) DO UPDATE SET
    approval_status = excluded.approval_status, campaign_id = excluded.campaign_id,
    series_id = excluded.series_id, recurrence = excluded.recurrence,
    best_time = excluded.best_time, decided_by = excluded.decided_by,
    decided_at = excluded.decided_at, updated_at = datetime('now')`)
    .run(postId, next.approval_status, next.campaign_id, next.series_id, next.recurrence, next.best_time, next.decided_by, next.decided_at);
  return plannerRow(postId);
}
function getCampaign(userId, id) {
  return db.db.prepare('SELECT * FROM social_campaigns WHERE id = ? AND user_id = ?').get(id, userId) || null;
}
function publicCampaign(c) {
  if (!c) return null;
  return { id: c.id, name: c.name, description: c.description, color: c.color, createdAt: c.created_at, updatedAt: c.updated_at };
}

function publicPost(row) {
  if (!row) return null;
  let mediaIds = [];
  try { mediaIds = JSON.parse(row.media_ids || '[]'); } catch { mediaIds = []; }
  let providerResponse = null;
  try { providerResponse = row.provider_response ? JSON.parse(row.provider_response) : null; } catch { providerResponse = null; }
  return {
    id: row.id, platform: row.platform, title: row.title, text: row.text,
    mediaIds, status: row.status, scheduledAt: row.scheduled_at,
    publishedAt: row.published_at, providerPostId: row.provider_post_id,
    providerResponse, manualNote: row.manual_note, manualUrl: row.manual_url,
    error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
    ...plannerFor(row.id),
  };
}

function validDate(s) {
  if (!s || typeof s !== 'string') return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

function toDbDate(s) {
  return new Date(s).toISOString().slice(0, 19).replace('T', ' ');
}

// --- Platforms + connections ---
router.get('/platforms', auth.requireAuth, (req, res) => {
  const connected = {};
  for (const c of db.listSocialConnections(req.user.id)) connected[c.platform] = db.publicSocialConnection(c);
  res.json({
    platforms: Object.entries(PLATFORMS).map(([id, p]) => ({
      id, label: p.label, charLimit: p.charLimit, needsMedia: p.needsMedia,
      videoOnly: p.videoOnly, about: p.about,
      connected: Boolean(connected[id]), connection: connected[id] || null,
    })),
    note: 'Publishing works only through each platform\'s official API and only after you connect that platform here. Nothing is ever marked published without a real provider response.',
  });
});

router.get('/connections', auth.requireAuth, (req, res) => {
  res.json({ connections: db.listSocialConnections(req.user.id).map(db.publicSocialConnection) });
});

// Connect a platform: store the OAuth access token encrypted. `baseUrl`
// overrides the official API base (used by tests against a local mock);
// `extra` holds platform-specific fields (pageId, authorUrn, igUserId,
// publicBaseUrl). The raw token is never returned.
router.post('/connections', auth.requireAuth, (req, res) => {
  const { platform, accountName, accessToken, extra, baseUrl } = req.body || {};
  const info = platformInfo(platform);
  if (!info) return res.status(400).json({ error: `Unknown platform. Available: ${Object.keys(PLATFORMS).join(', ')}.` });
  if (!accessToken || typeof accessToken !== 'string' || accessToken.trim().length < 4) {
    return res.status(400).json({ error: 'An access token is required. Connect via the platform\'s OAuth flow and paste the token here (it is stored encrypted).' });
  }
  if (baseUrl !== undefined && baseUrl !== '' && !/^https?:\/\//.test(baseUrl)) {
    return res.status(400).json({ error: 'Base URL must start with http:// or https://.' });
  }
  const conn = db.createSocialConnection(req.user.id, {
    platform, accountName: accountName || platform,
    credentialsEncrypted: encrypt(JSON.stringify({ access_token: accessToken.trim() })),
    baseUrl: baseUrl || null, extra: extra || {},
  });
  db.audit(req.user.id, 'social_connect', 'social_connection', conn.id, `Connected ${info.label} as ${conn.account_name}`);
  res.status(201).json({ connection: db.publicSocialConnection(conn) });
});

router.delete('/connections/:platform', auth.requireAuth, (req, res) => {
  const conn = db.getSocialConnection(req.user.id, req.params.platform);
  if (!conn) return res.status(404).json({ error: 'No connection for that platform.' });
  db.deleteSocialConnection(req.user.id, req.params.platform);
  db.audit(req.user.id, 'social_disconnect', 'social_connection', conn.id, `Disconnected ${req.params.platform}`);
  res.json({ ok: true });
});

// --- Campaigns (v2.5.0 planner) -------------------------------------------
router.get('/campaigns', auth.requireAuth, (req, res) => {
  const rows = db.db.prepare('SELECT * FROM social_campaigns WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  const counts = {};
  for (const r of db.db.prepare(`SELECT campaign_id, COUNT(*) AS c FROM social_planner
      WHERE campaign_id IS NOT NULL GROUP BY campaign_id`).all()) counts[r.campaign_id] = r.c;
  res.json({ campaigns: rows.map((c) => ({ ...publicCampaign(c), postCount: counts[c.id] || 0 })) });
});

router.post('/campaigns', auth.requireAuth, (req, res) => {
  const { name, description, color } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
    return res.status(400).json({ error: 'A campaign name is required (max 80 characters).' });
  }
  if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(color))) {
    return res.status(400).json({ error: 'Color must be a hex value like #7c5cff.' });
  }
  const info = db.db.prepare('INSERT INTO social_campaigns (user_id, name, description, color) VALUES (?,?,?,?)')
    .run(req.user.id, name.trim(), String(description || '').slice(0, 500), color || '#7c5cff');
  const row = db.db.prepare('SELECT * FROM social_campaigns WHERE id = ?').get(info.lastInsertRowid);
  db.audit(req.user.id, 'social_campaign_created', 'social_campaign', row.id, `Campaign "${row.name}" created`);
  res.status(201).json({ campaign: publicCampaign(row) });
});

router.get('/campaigns/:id', auth.requireAuth, (req, res) => {
  const camp = getCampaign(req.user.id, req.params.id);
  if (!camp) return res.status(404).json({ error: 'Campaign not found.' });
  const ids = db.db.prepare('SELECT post_id FROM social_planner WHERE campaign_id = ?').all(camp.id).map((r) => r.post_id);
  const posts = ids.map((id) => db.getSocialPost(req.user.id, id)).filter(Boolean).map(publicPost);
  res.json({ campaign: publicCampaign(camp), posts });
});

router.patch('/campaigns/:id', auth.requireAuth, (req, res) => {
  const camp = getCampaign(req.user.id, req.params.id);
  if (!camp) return res.status(404).json({ error: 'Campaign not found.' });
  const { name, description, color } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 80)) {
    return res.status(400).json({ error: 'Campaign name must be 1–80 characters.' });
  }
  if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(color))) {
    return res.status(400).json({ error: 'Color must be a hex value like #7c5cff.' });
  }
  db.db.prepare(`UPDATE social_campaigns SET
    name = COALESCE(?, name), description = COALESCE(?, description), color = COALESCE(?, color),
    updated_at = datetime('now') WHERE id = ?`)
    .run(name !== undefined ? name.trim() : null, description !== undefined ? String(description).slice(0, 500) : null, color || null, camp.id);
  res.json({ campaign: publicCampaign(db.db.prepare('SELECT * FROM social_campaigns WHERE id = ?').get(camp.id)) });
});

router.delete('/campaigns/:id', auth.requireAuth, (req, res) => {
  const camp = getCampaign(req.user.id, req.params.id);
  if (!camp) return res.status(404).json({ error: 'Campaign not found.' });
  db.db.prepare('UPDATE social_planner SET campaign_id = NULL WHERE campaign_id = ?').run(camp.id);
  db.db.prepare('DELETE FROM social_campaigns WHERE id = ?').run(camp.id);
  db.audit(req.user.id, 'social_campaign_deleted', 'social_campaign', camp.id, `Campaign "${camp.name}" deleted (its posts were kept)`);
  res.json({ ok: true });
});

// --- Best time to post (v2.5.0 planner) ------------------------------------
// Real data only: hours are ranked from THIS user's own published /
// manually-posted history. With fewer than 3 published posts the response
// says so and returns general guidance windows, labelled as general
// guidance — never presented as the user's own best time.
router.get('/best-times', auth.requireAuth, (req, res) => {
  const { platform } = req.query;
  if (platform !== undefined && platform !== '' && !platformInfo(platform)) {
    return res.status(400).json({ error: 'Unknown platform.' });
  }
  let sql = `SELECT published_at FROM social_posts WHERE user_id = ?
    AND status IN ('published','manual') AND published_at IS NOT NULL`;
  const params = [req.user.id];
  if (platform) { sql += ' AND platform = ?'; params.push(platform); }
  const rows = db.db.prepare(sql).all(...params);
  const byHour = new Map();
  for (const r of rows) {
    const h = Number(String(r.published_at).slice(11, 13));
    if (Number.isFinite(h)) byHour.set(h, (byHour.get(h) || 0) + 1);
  }
  const ranked = [...byHour.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([hour, count]) => ({ hour, count, label: `${String(hour).padStart(2, '0')}:00` }));
  if (rows.length >= 3 && ranked.length) {
    return res.json({
      platform: platform || 'all', source: 'your-history',
      publishedPostsCount: rows.length,
      suggestions: ranked,
      note: `Ranked from your own ${rows.length} published post(s) on this install.`,
    });
  }
  return res.json({
    platform: platform || 'all', source: 'general-guidance',
    publishedPostsCount: rows.length,
    suggestions: [
      { hour: 9, label: '09:00', note: 'Morning scroll — general guidance, not your data' },
      { hour: 13, label: '13:00', note: 'Lunch break — general guidance, not your data' },
      { hour: 19, label: '19:00', note: 'Evening peak — general guidance, not your data' },
    ],
    note: rows.length
      ? `Only ${rows.length} published post(s) so far — not enough history for a personal best time. These are general guidance windows.`
      : 'No published posts yet — these are general guidance windows, not your data. Publish a few posts and the suggestions will be ranked from your own history.',
  });
});

// --- Posts ---
function validatePlannerInput(req, body) {
  // Returns { campaignId, approvalStatus, recurrence } or throws a 400.
  const out = {};
  if (body.campaignId !== undefined && body.campaignId !== null && body.campaignId !== '') {
    const camp = getCampaign(req.user.id, body.campaignId);
    if (!camp) throw Object.assign(new Error('Campaign not found.'), { status: 400 });
    out.campaignId = camp.id;
  }
  if (body.needsApproval) out.approvalStatus = 'pending_approval';
  if (body.recurrence !== undefined && body.recurrence !== null) {
    const r = body.recurrence;
    if (typeof r !== 'object' || !['daily', 'weekly', 'monthly'].includes(r.frequency)) {
      throw Object.assign(new Error('recurrence.frequency must be daily, weekly or monthly.'), { status: 400 });
    }
    const count = Number(r.count);
    if (!Number.isInteger(count) || count < 2 || count > 52) {
      throw Object.assign(new Error('recurrence.count must be a whole number from 2 to 52.'), { status: 400 });
    }
    out.recurrence = { frequency: r.frequency, interval: Math.max(1, Math.min(4, Number(r.interval) || 1)), count };
  }
  return out;
}

router.post('/posts', auth.requireAuth, (req, res) => {
  const { platform, title, text, mediaIds, status, scheduledAt } = req.body || {};
  const info = platformInfo(platform);
  if (!info) return res.status(400).json({ error: `Unknown platform. Available: ${Object.keys(PLATFORMS).join(', ')}.` });
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Post text is required.' });
  if (text.length > info.charLimit) {
    return res.status(400).json({ error: `Text is ${text.length} characters — ${info.label} allows ${info.charLimit}. Shorten it first.` });
  }
  const ids = Array.isArray(mediaIds) ? mediaIds : [];
  for (const id of ids) {
    if (!db.getMedia(req.user.id, id)) return res.status(400).json({ error: `Media ${id} not found in your library.` });
  }
  const st = status || 'draft';
  if (!['draft', 'scheduled'].includes(st)) return res.status(400).json({ error: 'New posts start as draft or scheduled.' });
  if (st === 'scheduled' && !validDate(scheduledAt)) return res.status(400).json({ error: 'A scheduled post needs a valid scheduledAt date/time.' });
  let planner;
  try { planner = validatePlannerInput(req, req.body || {}); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const post = db.createSocialPost(req.user.id, {
    platform, title: title || '', text: text.trim(), mediaIds: ids,
    status: st, scheduledAt: st === 'scheduled' ? toDbDate(scheduledAt) : null,
  });
  if (planner.campaignId !== undefined || planner.approvalStatus || planner.recurrence) {
    upsertPlanner(post.id, planner);
  }
  db.audit(req.user.id, 'social_post_created', 'social_post', post.id, `Post created for ${info.label} (${st})`);
  res.status(201).json({ post: publicPost(post) });
});

// Bulk scheduling (v2.5.0): create many posts in one call — each entry is
// validated exactly like a single post; one bad entry rejects the whole
// batch with the entry number, nothing is half-created.
router.post('/posts/bulk', auth.requireAuth, (req, res) => {
  const { posts } = req.body || {};
  if (!Array.isArray(posts) || !posts.length) return res.status(400).json({ error: 'posts must be a non-empty array.' });
  if (posts.length > 50) return res.status(400).json({ error: 'Bulk scheduling is limited to 50 posts at a time.' });
  const prepared = [];
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i] || {};
    const info = platformInfo(p.platform);
    if (!info) return res.status(400).json({ error: `Post ${i + 1}: unknown platform.` });
    if (!p.text || typeof p.text !== 'string' || !p.text.trim()) return res.status(400).json({ error: `Post ${i + 1}: text is required.` });
    if (p.text.length > info.charLimit) return res.status(400).json({ error: `Post ${i + 1}: text is ${p.text.length} characters — ${info.label} allows ${info.charLimit}.` });
    const ids = Array.isArray(p.mediaIds) ? p.mediaIds : [];
    for (const id of ids) {
      if (!db.getMedia(req.user.id, id)) return res.status(400).json({ error: `Post ${i + 1}: media ${id} not found in your library.` });
    }
    const st = p.status || 'scheduled';
    if (!['draft', 'scheduled'].includes(st)) return res.status(400).json({ error: `Post ${i + 1}: status must be draft or scheduled.` });
    if (st === 'scheduled' && !validDate(p.scheduledAt)) return res.status(400).json({ error: `Post ${i + 1}: a scheduled post needs a valid scheduledAt date/time.` });
    let planner;
    try { planner = validatePlannerInput(req, p); }
    catch (e) { return res.status(400).json({ error: `Post ${i + 1}: ${e.message}` }); }
    prepared.push({ ...p, info, ids, st, planner });
  }
  const created = prepared.map((p) => {
    const post = db.createSocialPost(req.user.id, {
      platform: p.platform, title: p.title || '', text: p.text.trim(), mediaIds: p.ids,
      status: p.st, scheduledAt: p.st === 'scheduled' ? toDbDate(p.scheduledAt) : null,
    });
    if (p.planner.campaignId !== undefined || p.planner.approvalStatus || p.planner.recurrence) upsertPlanner(post.id, p.planner);
    return publicPost(post);
  });
  db.audit(req.user.id, 'social_posts_bulk', 'social_post', null, `Bulk-scheduled ${created.length} post(s)`);
  res.status(201).json({ posts: created, count: created.length });
});

router.get('/posts', auth.requireAuth, (req, res) => {
  const { campaignId, approvalStatus } = req.query;
  let posts = db.listSocialPosts(req.user.id, {
    status: req.query.status, platform: req.query.platform,
    from: req.query.from, to: req.query.to,
  });
  if (campaignId) {
    const ids = new Set(db.db.prepare('SELECT post_id FROM social_planner WHERE campaign_id = ?').all(campaignId).map((r) => r.post_id));
    posts = posts.filter((p) => ids.has(p.id));
  }
  let out = posts.map(publicPost);
  if (approvalStatus) out = out.filter((p) => p.approvalStatus === approvalStatus);
  res.json({ posts: out });
});

router.get('/posts/:id', auth.requireAuth, (req, res) => {
  const post = db.getSocialPost(req.user.id, req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  res.json({ post: publicPost(post) });
});

router.patch('/posts/:id', auth.requireAuth, (req, res) => {
  const post = db.getSocialPost(req.user.id, req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (!['draft', 'scheduled', 'failed'].includes(post.status)) {
    return res.status(400).json({ error: `A ${post.status} post cannot be edited. Duplicate it to make changes.` });
  }
  const { platform, title, text, mediaIds, status, scheduledAt } = req.body || {};
  const patch = {};
  if (platform !== undefined) {
    if (!platformInfo(platform)) return res.status(400).json({ error: 'Unknown platform.' });
    patch.platform = platform;
  }
  const nextPlatform = patch.platform || post.platform;
  if (text !== undefined) {
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'Post text is required.' });
    if (String(text).length > PLATFORMS[nextPlatform].charLimit) {
      return res.status(400).json({ error: `Text is ${String(text).length} characters — ${PLATFORMS[nextPlatform].label} allows ${PLATFORMS[nextPlatform].charLimit}.` });
    }
    patch.text = String(text).trim();
  }
  if (title !== undefined) patch.title = String(title || '');
  if (mediaIds !== undefined) {
    if (!Array.isArray(mediaIds)) return res.status(400).json({ error: 'mediaIds must be an array.' });
    for (const id of mediaIds) {
      if (!db.getMedia(req.user.id, id)) return res.status(400).json({ error: `Media ${id} not found in your library.` });
    }
    patch.media_ids = mediaIds;
  }
  if (status !== undefined) {
    if (!['draft', 'scheduled'].includes(status)) return res.status(400).json({ error: 'Posts can only be set back to draft or scheduled here.' });
    patch.status = status;
    if (status === 'scheduled' && !validDate(scheduledAt || post.scheduled_at)) {
      return res.status(400).json({ error: 'A scheduled post needs a valid scheduledAt date/time.' });
    }
    patch.scheduled_at = status === 'scheduled' ? toDbDate(scheduledAt || post.scheduled_at) : null;
    patch.error = null;
  } else if (scheduledAt !== undefined) {
    if (!validDate(scheduledAt)) return res.status(400).json({ error: 'scheduledAt must be a valid date/time.' });
    patch.scheduled_at = toDbDate(scheduledAt);
  }
  // v2.5.0: a campaign can be (re)assigned on edit.
  let plannerPatch = null;
  try { plannerPatch = validatePlannerInput(req, { campaignId: req.body.campaignId }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const updated = db.updateSocialPost(post.id, patch);
  if (plannerPatch.campaignId !== undefined) upsertPlanner(post.id, { campaignId: plannerPatch.campaignId });
  else if (req.body.campaignId === null) upsertPlanner(post.id, { campaignId: null });
  res.json({ post: publicPost(updated) });
});

// Drag-and-drop rescheduling (v2.5.0): move a post to a new date/time.
// Works for draft / scheduled / failed posts, including ones waiting for
// approval — moving the date does not approve anything.
router.post('/posts/:id/reschedule', auth.requireAuth, (req, res) => {
  const post = db.getSocialPost(req.user.id, req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (!['draft', 'scheduled', 'failed'].includes(post.status)) {
    return res.status(400).json({ error: `A ${post.status} post cannot be rescheduled.` });
  }
  const { scheduledAt } = req.body || {};
  if (!validDate(scheduledAt)) return res.status(400).json({ error: 'A valid scheduledAt date/time is required.' });
  const updated = db.updateSocialPost(post.id, {
    status: 'scheduled', scheduled_at: toDbDate(scheduledAt), error: null,
  });
  db.audit(req.user.id, 'social_post_rescheduled', 'social_post', post.id, `Post rescheduled to ${updated.scheduled_at}`);
  res.json({ post: publicPost(updated) });
});

// Approval workflow (v2.5.0): submit -> approve / reject.
// Submit: the post owner. Approve/reject: OWNER or ADMIN (an author can
// approve their own post only if they are OWNER/ADMIN — a plain USER
// cannot approve their own work; that is the point of the workflow).
router.post('/posts/:id/approval', auth.requireAuth, (req, res) => {
  const post = db.getSocialPost(req.user.id, req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const { action } = req.body || {};
  if (!['submit', 'approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be submit, approve or reject.' });
  }
  const row = plannerRow(post.id);
  const cur = row ? row.approval_status : 'draft';
  if (action === 'submit') {
    if (cur === 'approved') return res.status(400).json({ error: 'This post is already approved.' });
    if (!['draft', 'scheduled', 'failed'].includes(post.status)) {
      return res.status(400).json({ error: `A ${post.status} post cannot be submitted for approval.` });
    }
    upsertPlanner(post.id, { approvalStatus: 'pending_approval' });
    db.audit(req.user.id, 'social_post_submit_approval', 'social_post', post.id, `Post submitted for approval (${post.platform})`);
    return res.json({ post: publicPost(db.getSocialPost(req.user.id, post.id)) });
  }
  // approve / reject — OWNER or ADMIN only.
  if (req.user.role !== 'OWNER' && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only an OWNER or ADMIN can approve or reject posts.' });
  }
  if (cur !== 'pending_approval') {
    return res.status(400).json({ error: `Only a post pending approval can be ${action === 'approve' ? 'approved' : 'rejected'} (current state: ${cur}).` });
  }
  upsertPlanner(post.id, {
    approvalStatus: action === 'approve' ? 'approved' : 'rejected',
    decidedBy: req.user.id, decidedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  });
  db.audit(req.user.id, `social_post_${action}d`, 'social_post', post.id, `Post ${action === 'approve' ? 'approved' : 'rejected'} by ${req.user.name} (${post.platform})`);
  res.json({ post: publicPost(db.getSocialPost(req.user.id, post.id)) });
});

// Recurring / series posts (v2.5.0): expand one post into dated copies.
// The original post becomes copy #1 of the series; copies 2..N are new
// scheduled posts sharing its series_id, text, platform and media.
router.post('/posts/:id/series', auth.requireAuth, (req, res) => {
  const post = db.getSocialPost(req.user.id, req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (!['draft', 'scheduled', 'failed'].includes(post.status)) {
    return res.status(400).json({ error: `A ${post.status} post cannot be turned into a series.` });
  }
  const { frequency, interval, count } = req.body || {};
  if (!['daily', 'weekly', 'monthly'].includes(frequency)) {
    return res.status(400).json({ error: 'frequency must be daily, weekly or monthly.' });
  }
  const n = Number(count);
  if (!Number.isInteger(n) || n < 2 || n > 52) {
    return res.status(400).json({ error: 'count must be a whole number from 2 to 52.' });
  }
  const step = Math.max(1, Math.min(4, Number(interval) || 1));
  const base = post.scheduled_at ? new Date(post.scheduled_at.replace(' ', 'T')) : new Date();
  if (Number.isNaN(base.getTime())) return res.status(400).json({ error: 'The post needs a valid scheduled date to repeat from — set one first.' });
  const seriesId = `series_${post.id}_${crypto.randomBytes(4).toString('hex')}`;
  const advance = (d, i) => {
    const out = new Date(d);
    if (frequency === 'daily') out.setDate(out.getDate() + step * i);
    else if (frequency === 'weekly') out.setDate(out.getDate() + 7 * step * i);
    else out.setMonth(out.getMonth() + step * i);
    return out;
  };
  const cur = plannerRow(post.id);
  const campaignId = cur ? cur.campaign_id : null;
  const approvalStatus = cur ? cur.approval_status : 'draft';
  upsertPlanner(post.id, { seriesId, recurrence: { frequency, interval: step, count: n }, campaignId, approvalStatus });
  if (post.status === 'draft') db.updateSocialPost(post.id, { status: 'scheduled', scheduled_at: toDbDate(base.toISOString()) });
  const copies = [publicPost(db.getSocialPost(req.user.id, post.id))];
  for (let i = 1; i < n; i++) {
    const at = advance(base, i);
    const mediaIds = (() => { try { return JSON.parse(post.media_ids || '[]'); } catch { return []; } })();
    const copy = db.createSocialPost(req.user.id, {
      platform: post.platform, title: post.title, text: post.text, mediaIds,
      status: 'scheduled', scheduledAt: toDbDate(at.toISOString()),
    });
    upsertPlanner(copy.id, { seriesId, recurrence: { frequency, interval: step, count: n }, campaignId, approvalStatus });
    copies.push(publicPost(copy));
  }
  db.audit(req.user.id, 'social_series_created', 'social_post', post.id, `Series ${seriesId}: ${frequency} x${n} for ${post.platform}`);
  res.status(201).json({ seriesId, posts: copies, count: copies.length });
});

router.delete('/posts/:id', auth.requireAuth, (req, res) => {
  const post = db.getSocialPost(req.user.id, req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (post.status === 'published') return res.status(400).json({ error: 'A published post cannot be deleted here — remove it on the platform itself, then mark this record manually.' });
  // C-27: a 'manual' post IS a publication record (posted on the platform
  // by hand and recorded here with its link) — deleting it would erase
  // the only record that the post went out.
  if (post.status === 'manual') return res.status(400).json({ error: 'A manually-posted record cannot be deleted — it is the only record that this post went out. Remove the post on the platform itself first if it should not be live.' });
  db.deleteSocialPost(req.user.id, post.id);
  db.audit(req.user.id, 'social_post_deleted', 'social_post', post.id, `Deleted ${post.status} post for ${post.platform}`);
  res.json({ ok: true });
});

// Publish now (same honest path as the scheduler).
router.post('/posts/:id/publish', auth.requireAuth, async (req, res) => {
  const post = db.getSocialPost(req.user.id, req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (!['draft', 'scheduled', 'failed'].includes(post.status)) {
    return res.status(400).json({ error: `A ${post.status} post cannot be published again.` });
  }
  const row = plannerRow(post.id);
  if (row && row.approval_status === 'pending_approval') {
    return res.status(409).json({ error: 'This post is still waiting for approval. An OWNER or ADMIN must approve it first.', code: 'AWAITING_APPROVAL', post: publicPost(post) });
  }
  if (row && row.approval_status === 'rejected') {
    return res.status(409).json({ error: 'This post was rejected in approval. Edit it and submit it again.', code: 'APPROVAL_REJECTED', post: publicPost(post) });
  }
  const conn = db.getSocialConnection(req.user.id, post.platform);
  if (!conn) return res.status(409).json({ error: `Platform "${platformInfo(post.platform).label}" is not connected. Connect it in Social Studio → Connections first.`, code: 'NOT_CONNECTED' });
  const out = await publishOne(db.getSocialPostAny(post.id));
  const fresh = db.getSocialPost(req.user.id, post.id);
  if (out.status === 'published') return res.json({ post: publicPost(fresh) });
  return res.status(409).json({ post: publicPost(fresh), error: out.error, code: 'PUBLISH_FAILED' });
});

// Mark as posted manually elsewhere (user did the posting themselves).
router.post('/posts/:id/mark-manual', auth.requireAuth, (req, res) => {
  const post = db.getSocialPost(req.user.id, req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (!['draft', 'scheduled', 'failed'].includes(post.status)) {
    return res.status(400).json({ error: `A ${post.status} post cannot be marked manually.` });
  }
  const { note, url } = req.body || {};
  const updated = db.updateSocialPost(post.id, {
    status: 'manual', published_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    manual_note: note || '', manual_url: url || '', error: null,
  });
  db.audit(req.user.id, 'social_post_manual', 'social_post', post.id, `Marked as posted manually on ${post.platform}${url ? ` (${url})` : ''}`);
  res.json({ post: publicPost(updated) });
});

// --- Calendar ---
router.get('/calendar', auth.requireAuth, (req, res) => {
  const month = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)
    ? req.query.month
    : new Date().toISOString().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${month}-${String(lastDay).padStart(2, '0')}`;
  let posts = db.listSocialPosts(req.user.id, {
    from, to,
    status: req.query.status || undefined,
    platform: req.query.platform || undefined,
  });
  if (req.query.campaignId) {
    const ids = new Set(db.db.prepare('SELECT post_id FROM social_planner WHERE campaign_id = ?').all(req.query.campaignId).map((r) => r.post_id));
    posts = posts.filter((p) => ids.has(p.id));
  }
  let out = posts.map(publicPost);
  if (req.query.approvalStatus) out = out.filter((p) => p.approvalStatus === req.query.approvalStatus);
  const byDay = {};
  for (const p of out) {
    const day = (p.scheduledAt || p.createdAt || '').slice(0, 10);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(p);
  }
  res.json({ month, from, to, byDay, total: out.length });
});

// --- AI caption + hashtags ---
// LLM caption (Phase 7 provider). Costs 1 credit; without an LLM key it
// refuses with 402 PROVIDER_KEY_NEEDED and creates nothing.
router.post('/caption', auth.requireAuth, async (req, res) => {
  const { text, topic, platform, tone } = req.body || {};
  const source = String(text || topic || '').trim();
  if (!source) return res.status(400).json({ error: 'Give some text or a topic to write a caption about.' });
  if (platform !== undefined && platform !== '' && !platformInfo(platform)) {
    return res.status(400).json({ error: 'Unknown platform.' });
  }
  const check = credits.checkCredits(req.user.id, 'social_caption');
  if (!check.ok) return res.status(402).json({ error: check.error, code: check.code, needed: check.needed, balance: check.balance });
  try {
    const limit = platform ? PLATFORMS[platform].charLimit : 2200;
    const out = await ai.chatJson(req.user.id, {
      system: 'You write social media captions. Always reply with valid JSON only: {"caption": string, "hashtags": [string]}. The caption must fit the platform limit and sound natural, not spammy.',
      user: JSON.stringify({
        topic: source, platform: platform || 'any', tone: tone || 'friendly',
        maxChars: Math.min(limit, 2200),
      }),
    });
    const caption = String(out.caption || '').trim();
    const hashtags = Array.isArray(out.hashtags) ? out.hashtags.map((h) => String(h).trim()).filter(Boolean).slice(0, 15) : [];
    if (!caption) throw new Error('The LLM provider returned an empty caption.');
    credits.chargeCredits(req.user.id, 'social_caption', `AI caption for ${platform || 'social'}: "${source.slice(0, 60)}"`);
    res.json({ caption, hashtags, source: 'llm', charged: 1, balance: db.getUserById(req.user.id).credits_balance });
  } catch (err) {
    if (err.code === 'PROVIDER_KEY_NEEDED') {
      return res.status(402).json({ error: err.message, code: 'PROVIDER_KEY_NEEDED' });
    }
    return res.status(400).json({ error: err.message });
  }
});

// Local template captions — clearly labelled, NEVER presented as AI.
const LOCAL_TEMPLATES = [
  (t) => `${t} — behind the scenes, real talk, no filter. What do you think? 👇`,
  (t) => `New drop: ${t} ✨ Save this for later and share it with someone who needs it.`,
  (t) => `${t} — we made this for you. Like, comment and follow for more.`,
  (t) => `Quick one today: ${t} 💡 Tell us your take in the comments.`,
];
router.post('/caption-local', auth.requireAuth, (req, res) => {
  const { text, topic } = req.body || {};
  const source = String(text || topic || '').trim();
  if (!source) return res.status(400).json({ error: 'Give some text or a topic to write a caption about.' });
  res.json({
    captions: LOCAL_TEMPLATES.map((fn) => fn(source)),
    source: 'local-template',
    note: 'These are local fill-in templates, not AI. For real AI captions, use the AI caption button (needs an LLM key in Settings → AI Providers).',
  });
});

// Hashtags from the post text itself (local keyword extraction, free).
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'this', 'that', 'it', 'its', 'you', 'your', 'we', 'our', 'i', 'me', 'my', 'be', 'by', 'at', 'as', 'from', 'have', 'has', 'had', 'will', 'can', 'just', 'now', 'new', 'get', 'got']);
router.post('/hashtags', auth.requireAuth, (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Text is required.' });
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  const tags = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([w]) => `#${w}`);
  res.json({ hashtags: tags, source: 'local' });
});

// --- Scheduler (manual run) ---
router.post('/scheduler/run', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const results = await runDuePosts();
  res.json({ ok: true, processed: results.length, results });
});

module.exports = router;
