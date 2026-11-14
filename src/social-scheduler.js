'use strict';
// Social scheduler (Phase 8).
//
// Every N seconds (default 15s, env SOCIAL_SCHEDULER_INTERVAL_MS) the
// server picks up posts whose status is 'scheduled' and whose
// scheduled_at has passed, and attempts the real publish through the
// platform adapter. Outcomes are honest:
//  - platform connected + provider accepts → 'published' with the real
//    provider post id + response stored.
//  - anything else → 'failed' with the real error message (not connected,
//    provider rejection, video-only refusal...). Failed posts can be
//    edited and re-scheduled by the user.
// The scheduler only runs when started explicitly (server.js main block);
// a manual run endpoint exists for deterministic testing.
const path = require('path');
const db = require('./db');
const { decrypt } = require('./crypto-util');
const { publishToPlatform } = require('./social-publish');
const config = require('./config');

let timer = null;

// Local DB timestamp ('YYYY-MM-DD HH:MM:SS') — the format scheduled_at is
// stored in, so string comparison in listDueSocialPosts works.
function nowIso() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

// --- v2.5.0 planner tables (created here, in this module — no db.js edit) ---
// social_planner: one row per social post carrying the planner state that
// the base social_posts CHECK constraint cannot hold (approval workflow
// statuses) plus campaign / series / recurrence data.
// social_campaigns: named campaigns a post can belong to.
db.db.exec(`CREATE TABLE IF NOT EXISTS social_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#7c5cff',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS social_planner (
  post_id INTEGER PRIMARY KEY REFERENCES social_posts(id) ON DELETE CASCADE,
  approval_status TEXT NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft','pending_approval','approved','rejected')),
  campaign_id INTEGER REFERENCES social_campaigns(id) ON DELETE SET NULL,
  series_id TEXT,
  recurrence TEXT NOT NULL DEFAULT '',
  best_time TEXT,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_social_planner_campaign ON social_planner(campaign_id);
CREATE INDEX IF NOT EXISTS idx_social_planner_series ON social_planner(series_id);
CREATE INDEX IF NOT EXISTS idx_social_planner_approval ON social_planner(approval_status);`);

// Approval gate (v2.5.0): a post that carries a planner row may only be
// published once its approval_status is 'approved'. Posts with no planner
// row (created before v2.5.0, or created without the workflow) keep the
// old behaviour and publish normally. A pending/rejected post is SKIPPED,
// never marked failed — failing it would destroy the draft.
function plannerRow(postId) {
  return db.db.prepare('SELECT * FROM social_planner WHERE post_id = ?').get(postId) || null;
}
function approvalBlocked(postId) {
  const row = plannerRow(postId);
  return Boolean(row && row.approval_status !== 'approved');
}

async function publishOne(post) {
  if (approvalBlocked(post.id)) {
    return { id: post.id, status: 'awaiting_approval', error: 'This post is waiting for approval and will not publish until it is approved.' };
  }
  const conn = db.getSocialConnection(post.user_id, post.platform);
  if (!conn) {
    db.updateSocialPost(post.id, { status: 'failed', error: `Platform "${post.platform}" is not connected. Connect it in Social Studio → Connections first.` });
    db.audit(post.user_id, 'social_publish_failed', 'social_post', post.id, `Scheduled post failed: ${post.platform} not connected`);
    return { id: post.id, status: 'failed', error: 'not connected' };
  }
  let credentials = null;
  try {
    credentials = conn.credentials_encrypted ? JSON.parse(decrypt(conn.credentials_encrypted)) : null;
  } catch { credentials = null; }
  if (!credentials || !credentials.access_token) {
    db.updateSocialPost(post.id, { status: 'failed', error: `Platform "${post.platform}" is connected but has no access token. Reconnect it in Social Studio → Connections.` });
    return { id: post.id, status: 'failed', error: 'no access token' };
  }
  // Resolve attached media to file paths/urls the adapters need.
  const mediaIds = (() => { try { return JSON.parse(post.media_ids || '[]'); } catch { return []; } })();
  const media = mediaIds.map((id) => db.getMedia(post.user_id, id)).filter(Boolean).map((m) => ({
    id: m.id,
    kind: m.kind,
    mimeType: m.mime_type,
    url: `/api/media/${m.id}/file`,
    filePath: path.join(config.uploadsDir, String(post.user_id), m.stored_name),
    sizeBytes: m.size_bytes,
  }));
  try {
    const out = await publishToPlatform(post.platform, {
      text: post.text, title: post.title, media, connection: conn, credentials,
    });
    db.updateSocialPost(post.id, {
      status: 'published', published_at: nowIso(),
      provider_post_id: out.providerPostId, provider_response: out.response, error: null,
    });
    db.audit(post.user_id, 'social_published', 'social_post', post.id, `Published to ${post.platform} (provider id ${out.providerPostId})`);
    return { id: post.id, status: 'published', providerPostId: out.providerPostId };
  } catch (err) {
    db.updateSocialPost(post.id, { status: 'failed', error: String(err.message || err).slice(0, 1000) });
    db.audit(post.user_id, 'social_publish_failed', 'social_post', post.id, `Scheduled post failed on ${post.platform}: ${String(err.message || err).slice(0, 300)}`);
    return { id: post.id, status: 'failed', error: String(err.message || err).slice(0, 300) };
  }
}

async function runDuePosts(now) {
  const due = db.listDueSocialPosts(now || nowIso());
  const results = [];
  for (const post of due) {
    // Re-read: a previous iteration cannot change it, but the post may
    // have been edited/cancelled between listing and publishing.
    const fresh = db.getSocialPostAny(post.id);
    if (!fresh || fresh.status !== 'scheduled') continue;
    // v2.5.0 approval gate: due posts still waiting for approval are
    // skipped (left scheduled) — never published, never failed.
    if (approvalBlocked(fresh.id)) continue;
    results.push(await publishOne(fresh));
  }
  return results;
}

function startSocialScheduler(intervalMs) {
  if (timer) return timer;
  const ms = Number(intervalMs || process.env.SOCIAL_SCHEDULER_INTERVAL_MS || 15000);
  timer = setInterval(() => {
    runDuePosts().catch((err) => console.error('Social scheduler error:', err));
  }, ms);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { runDuePosts, startSocialScheduler, nowIso, publishOne };
