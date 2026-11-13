'use strict';
// Google OAuth + Sheets/Drive client (Phase 8).
//
// Real Google APIs, with env-configurable bases so tests can point them
// at a local mock server (GOOGLE_API_BASE, GOOGLE_OAUTH_BASE,
// GOOGLE_AUTH_BASE). No Google call is ever made without a stored OAuth
// connection (access token in social_connections, platform 'google').
//
// Scopes: spreadsheets.readonly + drive.readonly — the app only READS
// sheets for bulk import; it never writes to the user's Drive.
const db = require('./db');
const { encrypt, decrypt } = require('./crypto-util');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly'];

function apiBase() { return (process.env.GOOGLE_API_BASE || 'https://www.googleapis.com').replace(/\/$/, ''); }
function oauthBase() { return (process.env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com').replace(/\/$/, ''); }
function authBase() { return (process.env.GOOGLE_AUTH_BASE || 'https://accounts.google.com').replace(/\/$/, ''); }

function getGoogleOAuthConfig() {
  return db.getOAuthConfig('google');
}

function googleConfigured() {
  const cfg = getGoogleOAuthConfig();
  return Boolean(cfg && cfg.client_id && cfg.client_secret_encrypted);
}

function authUrl(redirectUri, state) {
  const cfg = getGoogleOAuthConfig();
  if (!cfg || !cfg.client_id) {
    const err = new Error('Google OAuth is not configured. Add your Google Client ID + Secret in Settings → Google Sheets first.');
    err.code = 'GOOGLE_NOT_CONFIGURED';
    throw err;
  }
  const q = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: state || '',
  });
  return `${authBase()}/o/oauth2/v2/auth?${q.toString()}`;
}

async function exchangeCode(code, redirectUri) {
  const cfg = getGoogleOAuthConfig();
  if (!cfg || !cfg.client_id || !cfg.client_secret_encrypted) {
    const err = new Error('Google OAuth is not configured.');
    err.code = 'GOOGLE_NOT_CONFIGURED';
    throw err;
  }
  const secret = decrypt(cfg.client_secret_encrypted);
  const res = await fetch(`${oauthBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: cfg.client_id, client_secret: secret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google rejected the code exchange (${res.status}): ${json.error_description || json.error || 'no detail'}`);
    err.code = 'GOOGLE_OAUTH_ERROR';
    throw err;
  }
  return json;
}

async function refreshAccessToken(conn) {
  const creds = JSON.parse(decrypt(conn.credentials_encrypted));
  const cfg = getGoogleOAuthConfig();
  if (!creds.refresh_token) {
    const err = new Error('Google connection has no refresh token. Reconnect Google in Settings.');
    err.code = 'GOOGLE_REAUTH_NEEDED';
    throw err;
  }
  const res = await fetch(`${oauthBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: creds.refresh_token, client_id: cfg.client_id,
      client_secret: decrypt(cfg.client_secret_encrypted), grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google rejected the token refresh (${res.status}): ${json.error_description || json.error || 'no detail'}`);
    err.code = 'GOOGLE_OAUTH_ERROR';
    throw err;
  }
  const updated = { ...creds, access_token: json.access_token, expires_at: Date.now() + (json.expires_in || 3600) * 1000 };
  db.updateSocialConnection(conn.user_id, 'google', { credentialsEncrypted: encrypt(JSON.stringify(updated)) });
  return updated.access_token;
}

// Returns a valid access token, refreshing first when it has expired.
async function validAccessToken(userId) {
  const conn = db.getSocialConnection(userId, 'google');
  if (!conn || !conn.credentials_encrypted) {
    const err = new Error('Google is not connected. Connect it in Settings → Google Sheets first.');
    err.code = 'GOOGLE_NOT_CONNECTED';
    throw err;
  }
  const creds = JSON.parse(decrypt(conn.credentials_encrypted));
  if (creds.access_token && creds.expires_at && creds.expires_at > Date.now() + 60000) return creds.access_token;
  return refreshAccessToken(conn);
}

async function googleGet(userId, path) {
  const token = await validAccessToken(userId);
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google API error (${res.status}): ${(json.error && json.error.message) || 'no detail'}`);
    err.code = 'GOOGLE_API_ERROR';
    err.status = res.status;
    throw err;
  }
  return json;
}

async function listSpreadsheets(userId) {
  const json = await googleGet(userId, "/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.spreadsheet%27&fields=files(id%2Cname%2CmodifiedTime)&pageSize=50&orderBy=modifiedTime%20desc");
  return (json.files || []).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
}

async function getSpreadsheetTabs(userId, spreadsheetId) {
  const json = await googleGet(userId, `/sheets/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties`);
  return (json.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean);
}

async function getSheetValues(userId, spreadsheetId, tab) {
  const range = encodeURIComponent(tab);
  const json = await googleGet(userId, `/sheets/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}`);
  const values = json.values || [];
  if (!values.length) return { columns: [], rows: [] };
  const columns = values[0].map((c) => String(c ?? '').trim());
  const rows = values.slice(1)
    .filter((r) => r.some((c) => String(c ?? '').trim() !== ''))
    .map((r) => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = String(r[i] ?? ''); });
      return obj;
    });
  return { columns, rows };
}

module.exports = {
  SCOPES, apiBase, oauthBase, authBase,
  getGoogleOAuthConfig, googleConfigured, authUrl, exchangeCode,
  validAccessToken, listSpreadsheets, getSpreadsheetTabs, getSheetValues,
};
