'use strict';
// Minimal .env loader (no dependency) + central config.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

const config = {
  port: parseInt(process.env.PORT || '4820', 10),
  host: process.env.HOST || '127.0.0.1',
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'creative-studio.db'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(root, 'uploads'),
  // Renders dir is env-overridable so parallel test servers (and multi-user
  // installs) never share output files: render jobs are named by their
  // per-DB integer id, so two servers sharing one dir would overwrite each
  // other's outputs.
  rendersDir: process.env.RENDERS_DIR || path.join(root, 'renders'),
  maxUploadMB: parseInt(process.env.MAX_UPLOAD_MB || '200', 10),
  appEncryptionKey: process.env.APP_ENCRYPTION_KEY || '',
  root,
};

module.exports = config;
