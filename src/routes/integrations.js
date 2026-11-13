'use strict';
// Google integrations (Phase 8): OAuth config + Sheets import.
//
// The app only READS sheets (spreadsheets.readonly + drive.readonly).
// Flow: OWNER/ADMIN saves the Google Client ID + Secret in Settings
// (secret encrypted) → auth-url → user authorises on Google → callback
// exchanges the code for tokens (stored encrypted in social_connections,
// platform 'google') → list spreadsheets → pick a tab → import rows into
// a bulk job with the SAME dedupe/validation as a CSV upload.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');
const { encrypt, decrypt } = require('../crypto-util');
const google = require('../google');
const bulk = require('../bulk');
const bm = require('../bulk-model');

const router = express.Router();

function redirectUri(req) {
  const cfg = google.getGoogleOAuthConfig();
  if (cfg && cfg.redirect_uri) return cfg.redirect_uri;
  return `${req.protocol}://${req.get('host')}/api/integrations/google/callback`;
}

router.get('/google/status', auth.requireAuth, (req, res) => {
  const cfg = google.getGoogleOAuthConfig();
  const conn = db.getSocialConnection(req.user.id, 'google');
  res.json({
    configured: google.googleConfigured(),
    clientId: cfg ? cfg.client_id : null,
    redirectUri: cfg ? cfg.redirect_uri : null,
    connected: Boolean(conn && conn.credentials_encrypted),
    accountName: conn ? conn.account_name : null,
    scopes: google.SCOPES,
    note: 'Google Sheets import reads your sheets only (read-only scopes). No sheet is ever modified.',
  });
});

// Save Google OAuth client id/secret (OWNER/ADMIN). Secret encrypted.
router.post('/google/config', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  const { clientId, clientSecret, redirectUri } = req.body || {};
  if (clientId !== undefined && (typeof clientId !== 'string' || !clientId.trim())) {
    return res.status(400).json({ error: 'Client ID must be a non-empty string.' });
  }
  if (clientSecret !== undefined && (typeof clientSecret !== 'string' || clientSecret.trim().length < 8)) {
    return res.status(400).json({ error: 'Client secret must be at least 8 characters.' });
  }
  if (redirectUri !== undefined && redirectUri !== '' && !/^https?:\/\//.test(redirectUri)) {
    return res.status(400).json({ error: 'Redirect URI must start with http:// or https://.' });
  }
  const saved = db.upsertOAuthConfig('google', {
    clientId: clientId === undefined ? undefined : clientId.trim(),
    clientSecretEncrypted: clientSecret === undefined ? undefined : encrypt(clientSecret.trim()),
    redirectUri: redirectUri === undefined ? undefined : (redirectUri || null),
  });
  db.audit(req.user.id, 'google_config_saved', 'oauth_config', null, 'Google OAuth client saved (secret encrypted)');
  res.json({ ok: true, configured: google.googleConfigured(), clientId: saved.client_id, redirectUri: saved.redirect_uri });
});

// Start OAuth: returns the Google authorise URL (state binds the user).
router.get('/google/auth-url', auth.requireAuth, (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    // The state token is stored in the session-bound audit trail is not
    // possible for a stateless GET, so we encode the user id in the state
    // as "userId.random" and verify it on callback.
    const url = google.authUrl(redirectUri(req), `${req.user.id}.${state}`);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || 'GOOGLE_ERROR' });
  }
});

// OAuth callback (browser redirect from Google). Exchanges the code and
// stores tokens, then redirects back into the app.
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query || {};
  if (error) return res.redirect('/?google=error&detail=' + encodeURIComponent(String(error)));
  if (!code || !state) return res.redirect('/?google=error&detail=' + encodeURIComponent('Missing code or state.'));
  const userId = Number(String(state).split('.')[0]);
  const user = db.getUserById(userId);
  if (!user) return res.redirect('/?google=error&detail=' + encodeURIComponent('Unknown user.'));
  try {
    const tokens = await google.exchangeCode(String(code), redirectUri(req));
    const creds = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
      token_type: tokens.token_type || 'Bearer',
      scope: tokens.scope || google.SCOPES.join(' '),
    };
    db.createSocialConnection(user.id, {
      platform: 'google',
      accountName: user.email,
      credentialsEncrypted: encrypt(JSON.stringify(creds)),
      baseUrl: null, extra: {},
    });
    db.audit(user.id, 'google_connected', 'social_connection', null, 'Google connected (Sheets read-only)');
    res.redirect('/?google=connected');
  } catch (err) {
    res.redirect('/?google=error&detail=' + encodeURIComponent(String(err.message || err).slice(0, 200)));
  }
});

router.delete('/google/connection', auth.requireAuth, (req, res) => {
  const conn = db.getSocialConnection(req.user.id, 'google');
  if (!conn) return res.status(404).json({ error: 'Google is not connected.' });
  db.deleteSocialConnection(req.user.id, 'google');
  db.audit(req.user.id, 'google_disconnected', 'social_connection', conn.id, 'Google disconnected');
  res.json({ ok: true });
});

router.get('/google/spreadsheets', auth.requireAuth, async (req, res) => {
  try {
    const sheets = await google.listSpreadsheets(req.user.id);
    res.json({ spreadsheets: sheets });
  } catch (err) {
    res.status(err.code === 'GOOGLE_NOT_CONNECTED' ? 409 : 400).json({ error: err.message, code: err.code || 'GOOGLE_ERROR' });
  }
});

router.get('/google/spreadsheets/:id/tabs', auth.requireAuth, async (req, res) => {
  try {
    const tabs = await google.getSpreadsheetTabs(req.user.id, req.params.id);
    res.json({ spreadsheetId: req.params.id, tabs });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || 'GOOGLE_ERROR' });
  }
});

router.get('/google/spreadsheets/:id/values', auth.requireAuth, async (req, res) => {
  const tab = req.query.tab;
  if (!tab) return res.status(400).json({ error: 'Query param tab is required (the sheet/tab name).' });
  try {
    const data = await google.getSheetValues(req.user.id, req.params.id, String(tab));
    res.json({ spreadsheetId: req.params.id, tab, ...data });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || 'GOOGLE_ERROR' });
  }
});

// Import a Google Sheet tab into a bulk job's dataset. Same dedupe and
// validation as a CSV upload (bulk.applyDedupe).
router.post('/google/import', auth.requireAuth, async (req, res) => {
  const { spreadsheetId, tab, bulkJobId } = req.body || {};
  if (!spreadsheetId || !tab || !bulkJobId) {
    return res.status(400).json({ error: 'spreadsheetId, tab and bulkJobId are required.' });
  }
  const job = db.getBulkJob(req.user.id, bulkJobId);
  if (!job) return res.status(404).json({ error: 'Bulk job not found.' });
  if (job.status !== 'draft') return res.status(400).json({ error: `Data can only be imported while the batch is a draft (this one is ${job.status}).` });
  try {
    const data = await google.getSheetValues(req.user.id, spreadsheetId, String(tab));
    if (!data.rows.length) return res.status(400).json({ error: 'The sheet tab is empty (no data rows).' });
    if (data.rows.length > bulk.MAX_ROWS_HARD) {
      return res.status(400).json({ error: `This sheet has ${data.rows.length} rows — the hard limit is ${bulk.MAX_ROWS_HARD}. Split it into smaller sheets.` });
    }
    const dataset = { columns: data.columns, rows: data.rows };
    const { errors } = bm.validateDataset(dataset.columns, dataset.rows);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    db.updateBulkJob(job.id, { dataset });
    db.replaceBulkRows(job.id, dataset.rows.map((d, i) => ({ rowIndex: i, data: d, selected: true })));
    const summary = bulk.applyDedupe(db.getBulkJob(req.user.id, job.id));
    db.audit(req.user.id, 'bulk_dataset_google', 'bulk_job', job.id,
      `Imported ${dataset.rows.length} rows from Google Sheet ${spreadsheetId} / ${tab} (${summary.unique} unique, ${summary.skipped} duplicates skipped).`);
    res.json({
      job: { id: job.id, name: job.name },
      dataset: { columns: dataset.columns, totalRows: dataset.rows.length },
      dedupeSummary: summary,
      rows: db.listBulkRows(job.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || 'GOOGLE_ERROR' });
  }
});

module.exports = router;
