'use strict';
// Social Media Studio routes (Phase 8).
//
// Compose + schedule posts, content calendar, platform connections,
// AI captions/hashtags (LLM via Phase 7 — honest key_needed without a
// key), local template captions (clearly labelled, never "AI"), and
// publishing ONLY through official platform APIs when connected.
// A post is NEVER marked published without a real provider response;
// the user can also mark a post "posted manually elsewhere" with a note
// and link. The background scheduler (src/social-scheduler.js) picks up
// due posts; POST /scheduler/run runs it on demand.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { encrypt, decrypt } = require('../crypto-util');
const { PLATFORMS, platformInfo, publishToPlatform } = require('../social-publish');
const { runDuePosts, publishOne } = require('../social-scheduler');
const ai = require('../ai');
const credits = require('../credits');

const router = express.Router();

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

// --- Posts ---
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
  const post = db.createSocialPost(req.user.id, {
    platform, title: title || '', text: text.trim(), mediaIds: ids,
    status: st, scheduledAt: st === 'scheduled' ? toDbDate(scheduledAt) : null,
  });
  db.audit(req.user.id, 'social_post_created', 'social_post', post.id, `Post created for ${info.label} (${st})`);
  res.status(201).json({ post: publicPost(post) });
});

router.get('/posts', auth.requireAuth, (req, res) => {
  const posts = db.listSocialPosts(req.user.id, {
    status: req.query.status, platform: req.query.platform,
    from: req.query.from, to: req.query.to,
  });
  res.json({ posts: posts.map(publicPost) });
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
  const updated = db.updateSocialPost(post.id, patch);
  res.json({ post: publicPost(updated) });
});

router.delete('/posts/:id', auth.requireAuth, (req, res) => {
  const post = db.getSocialPost(req.user.id, req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (post.status === 'published') return res.status(400).json({ error: 'A published post cannot be deleted here — remove it on the platform itself, then mark this record manually.' });
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
  const posts = db.listSocialPosts(req.user.id, { from, to });
  const byDay = {};
  for (const p of posts) {
    const day = (p.scheduled_at || p.created_at || '').slice(0, 10);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(publicPost(p));
  }
  res.json({ month, from, to, byDay, total: posts.length });
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
