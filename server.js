'use strict';
// CreativeStudio AI Pro — Phase 1 Foundation server.
// Express + SQLite (better-sqlite3). Serves the API and the vanilla-JS frontend.
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./src/config');
const auth = require('./src/auth');

const app = express();
app.use(express.json({ limit: '2mb' }));

// Tiny cookie parser (avoids an extra dependency).
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq > -1) req.cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  next();
});

app.use(auth.authMiddleware);

fs.mkdirSync(config.uploadsDir, { recursive: true });

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/projects', require('./src/routes/projects'));
app.use('/api/media', require('./src/routes/media'));
app.use('/api/design', require('./src/routes/design'));
app.use('/api/video', require('./src/routes/video'));
app.use('/api/bulk', require('./src/routes/bulk'));
app.use('/api/music', require('./src/routes/music'));
app.use('/api/voice', require('./src/routes/voice'));
app.use('/api/shorts', require('./src/routes/shorts'));
app.use('/api/ai', require('./src/routes/ai'));
app.use('/api/social', require('./src/routes/social'));
app.use('/api/integrations', require('./src/routes/integrations'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/billing', require('./src/routes/billing'));
app.use('/api/marketplace', require('./src/routes/marketplace'));
app.use('/api/analytics', require('./src/routes/analytics'));
app.use('/api/updates', require('./src/routes/updates'));
app.use('/api', require('./src/routes/system'));

// Health check (no auth) — used by tests and the dashboard status.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '2.2.0', phase: 9, db: 'ok' });
});

// Frontend (single-page app).
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler — always JSON, never a stack leak to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

if (require.main === module) {
  // Render queue: re-queues any render interrupted by a restart.
  require('./src/render').startRenderQueue();
  // AI queue: re-queues any AI job interrupted by a restart.
  require('./src/ai').startAiQueue();
  // Social scheduler: publishes due scheduled posts (every 15 s).
  require('./src/social-scheduler').startSocialScheduler();
  // Auto-update checker: feed check on start + every 6 h (notifies when
  // auto-apply is off, applies when it is on).
  require('./src/routes/updates').startUpdateChecker();
  app.listen(config.port, config.host, () => {
    console.log(`CreativeStudio AI Pro (v2.2.0 — Auto-Update) running at http://${config.host}:${config.port}`);
    console.log(`DB: ${config.dbPath}`);
    console.log(`Uploads: ${config.uploadsDir}`);
  });
}

module.exports = app;
