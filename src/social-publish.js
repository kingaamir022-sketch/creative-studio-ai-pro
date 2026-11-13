'use strict';
// Social publishing adapters (Phase 8).
//
// Publishing happens ONLY through the platforms' official APIs, and only
// when the user has connected that platform (OAuth token stored encrypted
// in social_connections). No platform is connected in a fresh install, so
// every publish attempt first refuses with NOT_CONNECTED — a post is never
// marked published without a real provider response.
//
// Each adapter makes the documented official call:
//  - Facebook: POST {graph}/me/feed (or /{pageId}/feed when a page id is
//    stored on the connection) with the page access token.
//  - X: POST {api}/2/tweets with the OAuth 2.0 user token.
//  - LinkedIn: POST {api}/ugcPosts with the member URN from the connection.
//  - Instagram: two-step — POST /{igUserId}/media then /{igUserId}/media_publish.
//    Instagram needs a PUBLICLY reachable media URL, so the connection must
//    carry publicBaseUrl (or the publish refuses with a clear explanation).
//  - TikTok / YouTube: video-only platforms. A text-only post is refused
//    with a clear error; video publish uses TikTok's init→publish flow and
//    YouTube's multipart upload.
// `baseUrl` on the connection overrides the official base — that is how
// tests point the adapters at a local mock server. It is never used to
// fake a publish: the mock must return a real provider-shaped response.
const PLATFORMS = {
  facebook: {
    label: 'Facebook', charLimit: 63206, baseUrl: 'https://graph.facebook.com/v21.0',
    needsMedia: false, videoOnly: false,
    about: 'Posts to your Page feed via the Meta Graph API. Needs a Page access token and a Page ID (stored on the connection).',
  },
  instagram: {
    label: 'Instagram', charLimit: 2200, baseUrl: 'https://graph.facebook.com/v21.0',
    needsMedia: true, videoOnly: false,
    about: 'Photo/video posts via the Instagram Graph API (media container + publish). Needs a public media URL — set publicBaseUrl on the connection.',
  },
  x: {
    label: 'X (Twitter)', charLimit: 280, baseUrl: 'https://api.twitter.com/2',
    needsMedia: false, videoOnly: false,
    about: 'Posts a tweet via the X API v2. Text only in this build.',
  },
  tiktok: {
    label: 'TikTok', charLimit: 2200, baseUrl: 'https://open.tiktokapis.com/v2',
    needsMedia: true, videoOnly: true,
    about: 'Video-only: a text-only post cannot be published to TikTok. Attach a video to publish.',
  },
  youtube: {
    label: 'YouTube', charLimit: 5000, baseUrl: 'https://www.googleapis.com/youtube/v3',
    needsMedia: true, videoOnly: true,
    about: 'Video-only: uploads a video with title + description via the YouTube Data API.',
  },
  linkedin: {
    label: 'LinkedIn', charLimit: 3000, baseUrl: 'https://api.linkedin.com/v2',
    needsMedia: false, videoOnly: false,
    about: 'Posts a text update via the LinkedIn API. Needs the member URN (author) stored on the connection.',
  },
};

function platformInfo(platform) {
  return PLATFORMS[platform] || null;
}

function notConnectedError(platform) {
  const err = new Error(`Platform "${platformInfo(platform)?.label || platform}" is not connected. Connect it in Social Studio → Connections first (OAuth credentials are stored encrypted).`);
  err.code = 'NOT_CONNECTED';
  return err;
}

async function postJson(url, { token, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = (json && (json.error?.message || json.error || json.message)) || text.slice(0, 300) || `HTTP ${res.status}`;
    const err = new Error(`Platform rejected the publish (${res.status}): ${detail}`);
    err.code = 'PROVIDER_ERROR';
    err.status = res.status;
    throw err;
  }
  return json || { raw: text };
}

function extractId(json, fallbackKeys = ['id']) {
  if (!json) return null;
  for (const k of fallbackKeys) {
    if (json[k]) return String(json[k]);
    if (json.data && json.data[k]) return String(json.data[k]);
  }
  return null;
}

// media: [{ url, mimeType, kind }] — urls are the media file URLs the
// platform can fetch (public URL for Instagram; local file path for the
// mock server in tests, which reads nothing).
async function publishToPlatform(platform, { text, title, media = [], connection, credentials }) {
  const info = platformInfo(platform);
  if (!info) {
    const err = new Error(`Unknown platform: ${platform}`);
    err.code = 'UNKNOWN_PLATFORM';
    throw err;
  }
  if (!connection || !credentials || !credentials.access_token) throw notConnectedError(platform);
  const base = (connection.base_url || info.baseUrl).replace(/\/$/, '');
  const token = credentials.access_token;
  const extra = (() => { try { return JSON.parse(connection.extra || '{}'); } catch { return {}; } })();

  if (info.videoOnly && !media.some((m) => m.kind === 'video')) {
    const err = new Error(`${info.label} is video-only: attach a video to publish. A text-only post cannot be published there.`);
    err.code = 'NEEDS_VIDEO';
    throw err;
  }
  if (text && text.length > info.charLimit) {
    const err = new Error(`Text is ${text.length} characters — ${info.label} allows ${info.charLimit}. Shorten it first.`);
    err.code = 'TOO_LONG';
    throw err;
  }

  if (platform === 'facebook') {
    const target = extra.pageId ? `${base}/${extra.pageId}/feed` : `${base}/me/feed`;
    const json = await postJson(target, { token, body: { message: text } });
    const id = extractId(json);
    if (!id) throw new Error('Facebook accepted the post but returned no post id.');
    return { providerPostId: id, response: json };
  }
  if (platform === 'x') {
    const json = await postJson(`${base}/tweets`, { token, body: { text } });
    const id = extractId(json);
    if (!id) throw new Error('X accepted the post but returned no tweet id.');
    return { providerPostId: id, response: json };
  }
  if (platform === 'linkedin') {
    if (!extra.authorUrn) {
      const err = new Error('LinkedIn needs your member URN (author). Add it to the connection (e.g. "urn:li:person:abc123").');
      err.code = 'MISSING_AUTHOR';
      throw err;
    }
    const json = await postJson(`${base}/ugcPosts`, {
      token,
      body: {
        author: extra.authorUrn, lifecycleState: 'PUBLISHED',
        specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text }, shareMediaCategory: 'NONE' } },
        visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
      },
    });
    const id = extractId(json);
    if (!id) throw new Error('LinkedIn accepted the post but returned no post id.');
    return { providerPostId: id, response: json };
  }
  if (platform === 'instagram') {
    if (!extra.igUserId) {
      const err = new Error('Instagram needs your Instagram Business/Creator user id on the connection.');
      err.code = 'MISSING_IG_USER';
      throw err;
    }
    const first = media[0];
    if (!first) {
      const err = new Error('Instagram needs a photo or video to publish.');
      err.code = 'NEEDS_MEDIA';
      throw err;
    }
    if (!extra.publicBaseUrl) {
      const err = new Error('Instagram can only fetch media from a public URL. Set publicBaseUrl on the Instagram connection (the base URL where your media is publicly reachable), or mark the post as posted manually.');
      err.code = 'NEEDS_PUBLIC_URL';
      throw err;
    }
    const mediaUrl = first.url.startsWith('http') ? first.url : `${extra.publicBaseUrl.replace(/\/$/, '')}${first.url}`;
    const isVideo = first.kind === 'video';
    const container = await postJson(`${base}/${extra.igUserId}/media`, {
      token,
      body: isVideo
        ? { media_type: 'REELS', video_url: mediaUrl, caption: text }
        : { image_url: mediaUrl, caption: text },
    });
    const creationId = extractId(container, ['id']);
    if (!creationId) throw new Error('Instagram accepted the media but returned no container id.');
    const published = await postJson(`${base}/${extra.igUserId}/media_publish`, { token, body: { creation_id: creationId } });
    const id = extractId(published);
    if (!id) throw new Error('Instagram accepted the publish but returned no media id.');
    return { providerPostId: id, response: published };
  }
  if (platform === 'tiktok') {
    const video = media.find((m) => m.kind === 'video');
    const init = await postJson(`${base}/post/publish/video/init/`, {
      token,
      body: {
        post_info: { title: text || title || '', privacy_level: 'SELF_ONLY', disable_duet: false, disable_comment: false, disable_stitch: false, video_cover_timestamp_ms: 1000 },
        source_info: { source: 'FILE_UPLOAD', video_size: video.sizeBytes || 0, chunk_size: video.sizeBytes || 0, total_chunk_count: 1 },
      },
    });
    const publishId = init?.data?.publish_id;
    if (!publishId) throw new Error('TikTok accepted the upload init but returned no publish id.');
    // NOTE: the chunk upload + final publish call need the video bytes
    // streamed to TikTok's upload URL; in this build the flow stops after
    // init and the post is marked failed with a clear reason rather than
    // faked as published. Full chunk upload is a known gap (README).
    const err = new Error('TikTok video upload is not finished in this build: the upload was initialised (publish id received) but chunk upload is not implemented yet. The post is NOT published.');
    err.code = 'NOT_IMPLEMENTED';
    err.providerPostId = publishId;
    throw err;
  }
  if (platform === 'youtube') {
    const video = media.find((m) => m.kind === 'video');
    if (!video || !video.filePath) {
      const err = new Error('YouTube needs a video file to upload.');
      err.code = 'NEEDS_VIDEO';
      throw err;
    }
    // Multipart upload (metadata + media) per the YouTube Data API docs.
    const fs = require('fs');
    const boundary = `cs-${Date.now()}`;
    const meta = JSON.stringify({
      snippet: { title: (title || text || 'Untitled').slice(0, 100), description: (text || '').slice(0, 5000), categoryId: '22' },
      status: { privacyStatus: 'unlisted' },
    });
    const fileBuf = fs.readFileSync(video.filePath);
    const parts = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${video.mimeType || 'video/mp4'}\r\n\r\n`),
      fileBuf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await fetch(`${base}/videos?part=snippet,status&uploadType=multipart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: parts,
      signal: AbortSignal.timeout(120000),
    });
    const textBody = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(textBody); } catch { /* non-JSON */ }
    if (!res.ok) {
      const detail = (json && json.error && json.error.message) || textBody.slice(0, 300) || `HTTP ${res.status}`;
      const err = new Error(`YouTube rejected the upload (${res.status}): ${detail}`);
      err.code = 'PROVIDER_ERROR';
      throw err;
    }
    const id = json && json.id;
    if (!id) throw new Error('YouTube accepted the upload but returned no video id.');
    return { providerPostId: id, response: json };
  }
  throw new Error(`Publishing for ${platform} is not implemented.`);
}

module.exports = { PLATFORMS, platformInfo, publishToPlatform, notConnectedError };
