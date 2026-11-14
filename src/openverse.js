'use strict';
// Stock Assets — Openverse (v2.2.4, Release D "Library & Assistant").
//
// Openverse (api.openverse.org, run by WordPress) is a search engine for
// openly licensed media. Its public API needs NO key for anonymous access
// (verified live 2026-11-14 from this machine: image + audio search both
// return 200 with real results; anonymous tier is 20 requests/min burst,
// 200/day, page_size max 20).
//
// HONEST LIMIT — Openverse v1 covers IMAGES and AUDIO ONLY. There is no
// video endpoint in the v1 API (video is on their roadmap, not exposed).
// The Stock view says so plainly instead of pretending video search
// exists; free stock video stays an upload-your-own-file flow.
//
// Every result carries its own license + ready-made attribution string;
// saving an asset stores that attribution on the Media Library row
// (license_note) so credit is never lost. Saving the same Openverse asset
// twice is a duplicate: the existing row is returned, never recreated
// (standing duplicate rule).
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const { probeMedia } = require('./ffmpeg');

const BASE = process.env.OPENVERSE_BASE_URL || 'https://api.openverse.org/v1';
const PAGE_SIZE = 20; // anonymous maximum
const SEARCH_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 120000;

const IMAGE_EXTS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
const AUDIO_EXTS = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/aac': 'aac' };

function openverseError(status, detail) {
  const err = new Error(detail);
  if (status === 429) {
    err.code = 'OPENVERSE_RATE_LIMITED';
    err.message = 'Openverse rate limit reached (anonymous tier: 20 requests per minute, 200 per day). Wait a minute and try again — no key is needed, the limit is per-day traffic.';
  } else if (status === 404) {
    err.code = 'NOT_FOUND';
    err.message = 'That stock asset was not found on Openverse (it may have been removed).';
  } else {
    err.code = 'OPENVERSE_ERROR';
    err.message = `Openverse request failed (${status || 'no response'}): ${String(detail || '').slice(0, 200)}`;
  }
  return err;
}

// Openverse's paths are NOT both plural: images live under /v1/images/
// but audio lives under /v1/audio/ (singular). The real API answers 404
// for /v1/audios/ — verified live 2026-11-14.
const endpointFor = (type) => (type === 'image' ? 'images' : 'audio');

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'CreativeStudio-AI-Pro/2.2.4 (stock-assets)' }, signal: ctrl.signal });
  } catch (e) {
    throw openverseError(0, e.name === 'AbortError' ? 'request timed out' : (e.message || e));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw openverseError(res.status, `HTTP ${res.status}`);
  return res.json();
}

function normalizeItem(type, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const isImage = type === 'image';
  return {
    id: String(raw.id || ''),
    type,
    title: String(raw.title || 'Untitled').slice(0, 200),
    creator: raw.creator ? String(raw.creator).slice(0, 120) : null,
    creatorUrl: raw.creator_url || null,
    license: raw.license ? String(raw.license) : null,
    licenseVersion: raw.license_version ? String(raw.license_version) : null,
    licenseUrl: raw.license_url || null,
    attribution: raw.attribution ? String(raw.attribution) : null,
    url: raw.url || null,
    landingUrl: raw.foreign_landing_url || null,
    thumbnail: raw.thumbnail || (isImage ? (raw.url || null) : null),
    width: Number.isFinite(Number(raw.width)) ? Number(raw.width) : null,
    height: Number.isFinite(Number(raw.height)) ? Number(raw.height) : null,
    durationSeconds: !isImage && Number.isFinite(Number(raw.duration)) ? Math.round(Number(raw.duration) / 1000) : null,
    provider: raw.provider ? String(raw.provider) : null,
    source: raw.source ? String(raw.source) : null,
  };
}

const LICENSE_TYPES = ['all', 'commercial', 'modification'];
const IMAGE_CATEGORIES = ['photograph', 'illustration', 'digitized_artwork'];
const AUDIO_CATEGORIES = ['music', 'sound_effect', 'podcast'];

async function searchOpenverse(type, { q, page = 1, licenseType = 'all', license = '', category = '' } = {}) {
  if (!['image', 'audio'].includes(type)) throw new Error("Stock type must be 'image' or 'audio'. Openverse has no video search — see the Stock view note.");
  const query = String(q || '').trim();
  if (!query) throw new Error('A search term is required.');
  if (query.length > 200) throw new Error('Search term is too long (max 200 characters).');
  const p = Math.max(1, Math.min(500, parseInt(page, 10) || 1));
  const params = new URLSearchParams({ q: query, page_size: String(PAGE_SIZE), page: String(p) });
  if (LICENSE_TYPES.includes(licenseType) && licenseType !== 'all') params.set('license_type', licenseType);
  const cleanLicense = String(license || '').trim().toLowerCase();
  if (cleanLicense) params.set('license', cleanLicense);
  const cleanCategory = String(category || '').trim();
  const allowedCategories = type === 'image' ? IMAGE_CATEGORIES : AUDIO_CATEGORIES;
  if (cleanCategory && allowedCategories.includes(cleanCategory)) params.set('category', cleanCategory);
  const json = await fetchJson(`${BASE}/${endpointFor(type)}/?${params.toString()}`, SEARCH_TIMEOUT_MS);
  const results = Array.isArray(json.results) ? json.results.map((r) => normalizeItem(type, r)).filter(Boolean) : [];
  return {
    type,
    query,
    page: p,
    pageSize: PAGE_SIZE,
    resultCount: Number(json.result_count) || results.length,
    pageCount: Number(json.page_count) || 1,
    results,
    note: 'Openverse (openly licensed images + audio, no key needed). Video search is not available through the Openverse API — upload your own video files instead.',
    limits: 'Anonymous tier: 20 requests/min, 200/day, 20 results per page.',
  };
}

async function getOpenverseItem(type, id) {
  if (!['image', 'audio'].includes(type)) throw new Error("Stock type must be 'image' or 'audio'.");
  const cleanId = String(id || '').trim();
  if (!cleanId || cleanId.length > 100) throw new Error('A valid stock asset id is required.');
  const json = await fetchJson(`${BASE}/${endpointFor(type)}/${encodeURIComponent(cleanId)}`, SEARCH_TIMEOUT_MS);
  const item = normalizeItem(type, json);
  if (!item || !item.url) throw openverseError(404, 'asset has no file URL');
  return item;
}

function extFor(item, contentType) {
  const map = item.type === 'image' ? IMAGE_EXTS : AUDIO_EXTS;
  if (contentType && map[contentType.split(';')[0].trim()]) return map[contentType.split(';')[0].trim()];
  try {
    const ext = path.extname(new URL(item.url).pathname).toLowerCase().replace(/^\./, '').slice(0, 5);
    if (ext && /^[a-z0-9]+$/.test(ext)) return ext;
  } catch { /* fall through */ }
  return item.type === 'image' ? 'jpg' : 'mp3';
}

// Download an Openverse asset into the Media Library. The stored name is
// derived from the Openverse id, so saving the same asset twice finds the
// existing row and returns it as a duplicate — never a second copy.
async function saveToLibrary(userId, type, id) {
  const item = await getOpenverseItem(type, id);
  const safeTitle = (item.title || `stock-${type}`).replace(/[^A-Za-z0-9._ -]+/g, '-').trim().slice(0, 80) || `stock-${type}`;
  const dir = path.join(config.uploadsDir, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  // Duplicate check BEFORE downloading: the stored name is derived from
  // the Openverse id, so a re-save finds the existing row and returns it
  // without another download. The extension usually comes from the file
  // URL; it is re-checked after the download (content-type wins).
  const urlExt = extFor(item, '');
  const urlStoredName = `stock-${type}-${item.id}.${urlExt}`;
  const alreadySaved = db.listMedia(userId, { tag: 'openverse' }).find((m) => m.stored_name === urlStoredName);
  if (alreadySaved) {
    return { media: alreadySaved, item, duplicate: true, attribution: alreadySaved.license_note || item.attribution };
  }
  // Download the file, then save it under the id-based stored name.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(item.url, { headers: { 'User-Agent': 'CreativeStudio-AI-Pro/2.2.4 (stock-assets)' }, signal: ctrl.signal });
  } catch (e) {
    throw openverseError(0, e.name === 'AbortError' ? 'download timed out' : (e.message || e));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw openverseError(res.status, `download failed with HTTP ${res.status}`);
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  const expectedPrefix = type === 'image' ? 'image/' : 'audio/';
  if (contentType && !contentType.startsWith(expectedPrefix)) {
    throw new Error(`Openverse returned a ${contentType || 'unknown'} file, not ${type} — the asset was not saved.`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const maxBytes = config.maxUploadMB * 1024 * 1024;
  if (buf.length > maxBytes) throw new Error(`Stock file is larger than the ${config.maxUploadMB} MB upload limit — not saved.`);
  if (buf.length < 10) throw new Error('Openverse returned an empty file — nothing was saved.');
  const ext = extFor(item, contentType);
  const storedName = `stock-${type}-${item.id}.${ext}`;
  const existing = db.listMedia(userId, { tag: 'openverse' }).find((m) => m.stored_name === storedName);
  if (existing) {
    // The content-type extension differed from the URL extension and the
    // file was already saved under this name — still a duplicate, and the
    // just-downloaded bytes are discarded, not stored twice.
    return { media: existing, item, duplicate: true, attribution: existing.license_note || item.attribution };
  }
  const filePath = path.join(dir, storedName);
  fs.writeFileSync(filePath, buf);
  let probe = null;
  try { probe = await probeMedia(filePath); } catch { probe = null; }
  const attribution = item.attribution
    || (item.title && item.creator && item.license
      ? `"${item.title}" by ${item.creator} is licensed under ${item.license.toUpperCase()}${item.licenseVersion ? ' ' + item.licenseVersion : ''}.`
      : null);
  const media = db.createMedia(userId, {
    originalName: `${safeTitle}.${ext}`,
    storedName,
    mimeType: contentType || (type === 'image' ? 'image/jpeg' : 'audio/mpeg'),
    kind: type,
    sizeBytes: buf.length,
    width: probe && probe.width ? probe.width : item.width,
    height: probe && probe.height ? probe.height : item.height,
    durationSeconds: probe && probe.durationSeconds ? probe.durationSeconds : item.durationSeconds,
    tags: 'stock,openverse',
  });
  if (attribution) db.updateMedia(userId, media.id, { licenseNote: attribution });
  const saved = db.getMedia(userId, media.id);
  db.audit(userId, 'stock_save', 'media', saved.id, `Saved stock ${type} "${item.title}" from Openverse (${item.license || 'license unknown'})`);
  return { media: saved, item, duplicate: false, attribution };
}

module.exports = { searchOpenverse, getOpenverseItem, saveToLibrary, normalizeItem, BASE, PAGE_SIZE };
