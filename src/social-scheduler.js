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

function nowIso() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

async function publishOne(post) {
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
