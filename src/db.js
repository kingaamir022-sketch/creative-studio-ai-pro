'use strict';
// SQLite data layer (better-sqlite3). All schema + queries live here so the
// rest of the app never touches SQL directly.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('OWNER','ADMIN','USER')),
  plan TEXT NOT NULL DEFAULT 'Free',
  credits_balance INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project','media')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'design' CHECK (type IN ('design','video','bulk','shorts','social','deck','doc')),
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  content TEXT NOT NULL DEFAULT '{}',
  thumbnail TEXT,
  trashed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video','audio','other')),
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  tags TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL DEFAULT '{}',
  progress INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS provider_settings (
  provider TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  api_key_encrypted TEXT,
  key_source TEXT NOT NULL DEFAULT 'none' CHECK (key_source IN ('none','env','stored')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  logo_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  primary_color TEXT NOT NULL DEFAULT '#7c5cff',
  secondary_color TEXT NOT NULL DEFAULT '#3b82f6',
  accent_color TEXT NOT NULL DEFAULT '#22d3ee',
  font_heading TEXT NOT NULL DEFAULT 'Poppins',
  font_body TEXT NOT NULL DEFAULT 'Inter',
  handles TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS design_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'My templates',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bulk_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'video' CHECK (kind IN ('video','design')),
  template_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  dataset TEXT NOT NULL DEFAULT '{"columns":[],"rows":[]}',
  settings TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','done','partial','failed','cancelled')),
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_done INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bulk_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bulk_job_id INTEGER NOT NULL REFERENCES bulk_jobs(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  selected INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','rendering','done','failed','skipped','cancelled')),
  background_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  background_source TEXT,
  background_prompt TEXT,
  output_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  output_path TEXT,
  output_name TEXT,
  error TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  luminance REAL,
  fit_report TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audio_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  file_hash TEXT NOT NULL,
  analysis TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, media_id)
);
CREATE TABLE IF NOT EXISTS shorts_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'analysing' CHECK (status IN ('analysing','ready','failed')),
  analysis TEXT NOT NULL DEFAULT '{}',
  settings TEXT NOT NULL DEFAULT '{}',
  transcript TEXT,
  transcript_source TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS shorts_clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES shorts_jobs(id) ON DELETE CASCADE,
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  breakdown TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','approved','rejected','rendering','done','failed')),
  motion_x REAL,
  output_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  output_path TEXT,
  caption_status TEXT NOT NULL DEFAULT 'none',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shorts_jobs_user ON shorts_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_shorts_clips_job ON shorts_clips(job_id);
CREATE TABLE IF NOT EXISTS voice_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  kind TEXT NOT NULL DEFAULT 'clone' CHECK (kind IN ('clone','ai')),
  sample_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  provider_voice_id TEXT,
  ai_voice TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS provider_config (
  provider TEXT PRIMARY KEY,
  base_url TEXT,
  model TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS provider_prefs (
  kind TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ai_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  params TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  output_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_user ON ai_jobs(user_id);
CREATE TABLE IF NOT EXISTS social_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('facebook','instagram','x','tiktok','youtube','linkedin','google')),
  account_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','expired','error')),
  credentials_encrypted TEXT,
  base_url TEXT,
  extra TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, platform)
);
CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('facebook','instagram','x','tiktok','youtube','linkedin')),
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  media_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published','failed','manual')),
  scheduled_at TEXT,
  published_at TEXT,
  provider_post_id TEXT,
  provider_response TEXT,
  manual_note TEXT,
  manual_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS plan_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS marketplace_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'design' CHECK (kind IN ('design','video','deck')),
  source_type TEXT NOT NULL DEFAULT 'template' CHECK (source_type IN ('template','project')),
  source_id INTEGER,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  content TEXT NOT NULL DEFAULT '{}',
  preview_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS marketplace_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES marketplace_templates(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(template_id, user_id)
);
CREATE TABLE IF NOT EXISTS marketplace_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES marketplace_templates(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- v2.2.4 — Collaboration: project sharing + comments. NO live co-editing
-- (explicitly out of scope): a share is read-only access, a comment is a
-- thread on a project. A share is either a per-user share
-- (shared_with_user_id set, token NULL) or a read-only link share
-- (token set, shared_with_user_id NULL). One row per (project, user) and
-- one link per project at most — duplicates are never created.
CREATE TABLE IF NOT EXISTS project_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_with_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE,
  permission TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, shared_with_user_id),
  UNIQUE(project_id, token)
);
CREATE TABLE IF NOT EXISTS project_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES project_comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_shares_project ON project_shares(project_id);
CREATE INDEX IF NOT EXISTS idx_project_shares_token ON project_shares(token);
CREATE INDEX IF NOT EXISTS idx_project_shares_user ON project_shares(shared_with_user_id);
CREATE INDEX IF NOT EXISTS idx_project_comments_project ON project_comments(project_id, created_at);
CREATE TABLE IF NOT EXISTS oauth_configs (
  provider TEXT PRIMARY KEY,
  client_id TEXT,
  client_secret_encrypted TEXT,
  redirect_uri TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS websites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  dir TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_websites_user ON websites(user_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_user ON social_posts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_social_posts_due ON social_posts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_social_conn_user ON social_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_status ON marketplace_templates(status, created_at);
CREATE INDEX IF NOT EXISTS idx_plan_requests_status ON plan_requests(status);
CREATE INDEX IF NOT EXISTS idx_voice_profiles_user ON voice_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_audio_tracks_user ON audio_tracks(user_id);
CREATE INDEX IF NOT EXISTS idx_bulk_rows_job ON bulk_rows(bulk_job_id);
CREATE INDEX IF NOT EXISTS idx_brands_user ON brands(user_id);
CREATE INDEX IF NOT EXISTS idx_templates_user ON design_templates(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, trashed);
CREATE INDEX IF NOT EXISTS idx_media_user ON media(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
`);

// v2.2.3 — Docs & Slides: projects gained the 'deck' and 'doc' types.
// SQLite cannot ALTER a CHECK constraint, so an existing projects table is
// rebuilt (rename → create → copy → drop). Idempotent: skipped when the
// stored CREATE TABLE already mentions 'deck'. Runs on every boot.
(function migrateProjectTypes() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get();
  if (!row || !row.sql || row.sql.includes("'deck'")) return;
  db.exec(`PRAGMA foreign_keys=OFF;
    BEGIN TRANSACTION;
    ALTER TABLE projects RENAME TO projects_old_v223;
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'design' CHECK (type IN ('design','video','bulk','shorts','social','deck','doc')),
      folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      content TEXT NOT NULL DEFAULT '{}',
      thumbnail TEXT,
      trashed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO projects (id, user_id, name, type, folder_id, content, thumbnail, trashed, created_at, updated_at)
      SELECT id, user_id, name, type, folder_id, content, thumbnail, trashed, created_at, updated_at FROM projects_old_v223;
    DROP TABLE projects_old_v223;
    COMMIT;
    PRAGMA foreign_keys=ON;`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, trashed)');
})();

// v2.2.4 — Library & Assistant: marketplace templates gained the 'deck'
// kind (deck projects can now be published/installed). Same rebuild
// pattern as v2.2.3 — SQLite cannot ALTER a CHECK constraint. Idempotent.
(function migrateMarketplaceKinds() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='marketplace_templates'").get();
  if (!row || !row.sql || row.sql.includes("'deck'")) return;
  db.exec(`PRAGMA foreign_keys=OFF;
    BEGIN TRANSACTION;
    ALTER TABLE marketplace_templates RENAME TO marketplace_templates_old_v224;
    CREATE TABLE marketplace_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'design' CHECK (kind IN ('design','video','deck')),
      source_type TEXT NOT NULL DEFAULT 'template' CHECK (source_type IN ('template','project')),
      source_id INTEGER,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'General',
      content TEXT NOT NULL DEFAULT '{}',
      preview_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
      downloads INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO marketplace_templates (id, user_id, kind, source_type, source_id, name, description, tags, category, content, preview_media_id, downloads, status, created_at, updated_at)
      SELECT id, user_id, kind, source_type, source_id, name, description, tags, category, content, preview_media_id, downloads, status, created_at, updated_at FROM marketplace_templates_old_v224;
    DROP TABLE marketplace_templates_old_v224;
    COMMIT;
    PRAGMA foreign_keys=ON;`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_marketplace_status ON marketplace_templates(status, created_at)');
})();

// Phase 3 columns (added idempotently so existing installs migrate on boot).
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn('media', 'fps', 'REAL');
ensureColumn('users', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('media', 'codec', 'TEXT');
ensureColumn('media', 'thumbnail', 'TEXT');
ensureColumn('media', 'license_note', 'TEXT');
ensureColumn('jobs', 'output_path', 'TEXT');
ensureColumn('jobs', 'log_path', 'TEXT');
ensureColumn('jobs', 'project_id', 'INTEGER');
ensureColumn('bulk_rows', 'fit_report', 'TEXT');

// v2.2.0 — OWNER Lifetime Free: upgrade every OWNER still on a limited plan
// to Lifetime. Idempotent and safe to run on every boot (the WHERE clause
// only matches OWNERs whose plan is not already Lifetime); regular users
// are never touched.
const ownersToUpgrade = db.prepare("SELECT id FROM users WHERE role = 'OWNER' AND plan IS NOT 'Lifetime'").all();
if (ownersToUpgrade.length) {
  db.prepare("UPDATE users SET plan = 'Lifetime' WHERE role = 'OWNER' AND plan IS NOT 'Lifetime'").run();
  for (const o of ownersToUpgrade) {
    audit(o.id, 'plan_migrated', 'user', o.id, 'OWNER upgraded to Lifetime plan (v2.2.0: OWNER is lifetime-free, everything unlimited)');
  }
}

// --- Users ---
function createUser({ name, email, passwordHash, role, plan, credits }) {
  const info = db.prepare(
    'INSERT INTO users (name, email, password_hash, role, plan, credits_balance) VALUES (?,?,?,?,?,?)'
  ).run(name, email, passwordHash, role, plan, credits);
  return getUserById(info.lastInsertRowid);
}
function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
}
function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function countUsers() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}
function listUsers() {
  return db.prepare('SELECT id, name, email, role, plan, credits_balance, created_at FROM users ORDER BY id').all();
}
function updateUser(id, fields) {
  const allowed = ['name', 'plan', 'credits_balance', 'role', 'suspended'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return getUserById(id);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getUserById(id);
}
function setPassword(id, hash) {
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, id);
}

// --- Sessions ---
function createSession(id, userId, expiresAt) {
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)').run(id, userId, expiresAt);
}
function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > datetime(\'now\')').get(id);
}
function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
function deleteSessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// --- Folders ---
function listFolders(userId, kind) {
  return db.prepare('SELECT * FROM folders WHERE user_id = ? AND kind = ? ORDER BY name').all(userId, kind);
}
function createFolder(userId, name, kind) {
  const info = db.prepare('INSERT INTO folders (user_id, name, kind) VALUES (?,?,?)').run(userId, name, kind);
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(info.lastInsertRowid);
}
function deleteFolder(userId, id) {
  const r = db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(id, userId);
  return r.changes > 0;
}

// --- Projects ---
function listProjects(userId, { search = '', trashed = 0, folderId = null } = {}) {
  let sql = 'SELECT * FROM projects WHERE user_id = ? AND trashed = ?';
  const params = [userId, trashed ? 1 : 0];
  if (search) { sql += ' AND name LIKE ?'; params.push(`%${search}%`); }
  if (folderId) { sql += ' AND folder_id = ?'; params.push(folderId); }
  sql += ' ORDER BY updated_at DESC';
  return db.prepare(sql).all(...params);
}
function getProject(userId, id) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(id, userId);
}
function getProjectAny(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}
function createProject(userId, { name, type = 'design', folderId = null, content = {} }) {
  const info = db.prepare(
    'INSERT INTO projects (user_id, name, type, folder_id, content) VALUES (?,?,?,?,?)'
  ).run(userId, name, type, folderId, JSON.stringify(content));
  return getProject(userId, info.lastInsertRowid);
}
function updateProject(userId, id, { name, type, folderId, content, trashed }) {
  const p = getProject(userId, id);
  if (!p) return null;
  db.prepare(`UPDATE projects SET
    name = COALESCE(?, name), type = COALESCE(?, type), folder_id = ?,
    content = COALESCE(?, content), trashed = COALESCE(?, trashed),
    updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(
      name ?? null, type ?? null,
      folderId === undefined ? p.folder_id : folderId,
      content !== undefined ? JSON.stringify(content) : null,
      trashed === undefined ? null : (trashed ? 1 : 0),
      id, userId
    );
  return getProject(userId, id);
}
function saveProjectVersion(projectId, content, note) {
  db.prepare('INSERT INTO project_versions (project_id, content, note) VALUES (?,?,?)')
    .run(projectId, JSON.stringify(content), note || 'autosave');
  // Keep only the latest 20 versions per project.
  db.prepare(`DELETE FROM project_versions WHERE project_id = ? AND id NOT IN
    (SELECT id FROM project_versions WHERE project_id = ? ORDER BY id DESC LIMIT 20)`)
    .run(projectId, projectId);
}
function listProjectVersions(projectId) {
  return db.prepare('SELECT id, note, created_at FROM project_versions WHERE project_id = ? ORDER BY id DESC').all(projectId);
}
function getProjectVersion(id) {
  return db.prepare('SELECT * FROM project_versions WHERE id = ?').get(id);
}
function duplicateProject(userId, id) {
  const p = getProject(userId, id);
  if (!p) return null;
  const copy = createProject(userId, {
    name: `${p.name} (copy)`, type: p.type, folderId: p.folder_id, content: JSON.parse(p.content || '{}'),
  });
  return copy;
}
function deleteProjectPermanently(userId, id) {
  const r = db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(id, userId);
  return r.changes > 0;
}

// --- Media ---
function listMedia(userId, { search = '', kind = '', folderId = null, favorite = false, tag = '' } = {}) {
  let sql = 'SELECT * FROM media WHERE user_id = ?';
  const params = [userId];
  if (search) { sql += ' AND (original_name LIKE ? OR tags LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  if (kind) { sql += ' AND kind = ?'; params.push(kind); }
  if (folderId) { sql += ' AND folder_id = ?'; params.push(folderId); }
  if (favorite) sql += ' AND favorite = 1';
  if (tag) { sql += ' AND tags LIKE ?'; params.push(`%${tag}%`); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}
function getMedia(userId, id) {
  return db.prepare('SELECT * FROM media WHERE id = ? AND user_id = ?').get(id, userId);
}
function createMedia(userId, m) {
  const info = db.prepare(`INSERT INTO media
    (user_id, folder_id, original_name, stored_name, mime_type, kind, size_bytes, width, height, duration_seconds, tags)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    userId, m.folderId || null, m.originalName, m.storedName, m.mimeType, m.kind,
    m.sizeBytes, m.width || null, m.height || null, m.durationSeconds || null, m.tags || ''
  );
  return getMedia(userId, info.lastInsertRowid);
}
function updateMedia(userId, id, { tags, favorite, folderId, width, height, durationSeconds, fps, codec, thumbnail, licenseNote, storedName }) {
  const m = getMedia(userId, id);
  if (!m) return null;
  db.prepare(`UPDATE media SET tags = COALESCE(?, tags), favorite = COALESCE(?, favorite), folder_id = ?,
    width = COALESCE(?, width), height = COALESCE(?, height), duration_seconds = COALESCE(?, duration_seconds),
    fps = COALESCE(?, fps), codec = COALESCE(?, codec), thumbnail = COALESCE(?, thumbnail),
    license_note = COALESCE(?, license_note), stored_name = COALESCE(?, stored_name)
    WHERE id = ? AND user_id = ?`)
    .run(tags ?? null, favorite === undefined ? null : (favorite ? 1 : 0), folderId === undefined ? m.folder_id : folderId,
      width ?? null, height ?? null, durationSeconds ?? null, fps ?? null, codec ?? null, thumbnail ?? null,
      licenseNote ?? null, storedName ?? null, id, userId);
  return getMedia(userId, id);
}
function deleteMedia(userId, id) {
  const r = db.prepare('DELETE FROM media WHERE id = ? AND user_id = ?').run(id, userId);
  return r.changes > 0;
}
function mediaStorageBytes(userId) {
  const row = db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS s FROM media WHERE user_id = ?').get(userId);
  return row.s;
}

// --- Jobs (Phase 3 rendering) ---
function countJobs(userId, status) {
  if (status) return db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND status = ?').get(userId, status).c;
  return db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE user_id = ?').get(userId).c;
}
function listJobs(userId) {
  return db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId);
}
function createJob(userId, { type, projectId, payload }) {
  const info = db.prepare(
    'INSERT INTO jobs (user_id, type, status, payload, project_id) VALUES (?,?,?, ?,?)'
  ).run(userId, type, 'queued', JSON.stringify(payload || {}), projectId || null);
  return getJob(userId, info.lastInsertRowid);
}
function getJob(userId, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(id, userId);
}
function getJobAny(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}
function updateJob(id, fields) {
  const allowed = ['status', 'progress', 'error', 'output_path', 'log_path'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return getJobAny(id);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getJobAny(id);
}
function deleteJob(userId, id) {
  return db.prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}
function nextQueuedJob() {
  return db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get();
}
function resetRunningJobs() {
  // A render interrupted by a server restart is re-queued, not silently lost.
  const r = db.prepare("UPDATE jobs SET status = 'queued', progress = 0, error = 'Render was interrupted by a server restart and will run again.' WHERE status = 'running'").run();
  return r.changes;
}

// --- Provider settings ---
function getProviderSettings() {
  return db.prepare('SELECT provider, label, api_key_encrypted, key_source, updated_at FROM provider_settings').all();
}
function upsertProvider(provider, label, encryptedOrNull, source) {
  db.prepare(`INSERT INTO provider_settings (provider, label, api_key_encrypted, key_source)
    VALUES (?,?,?,?) ON CONFLICT(provider) DO UPDATE SET
    api_key_encrypted = excluded.api_key_encrypted, key_source = excluded.key_source,
    updated_at = datetime('now')`).run(provider, label, encryptedOrNull, source);
}

// --- AI jobs (Phase 7) ---
// Kept in their OWN table on purpose: the Phase 3 render queue picks up
// ANY row with status 'queued' from the shared `jobs` table, so AI jobs
// must never live there or the renderer would try to render them.
function createAiJob(userId, { mode, name, params }) {
  const info = db.prepare(`INSERT INTO ai_jobs (user_id, mode, name, params)
    VALUES (?,?,?,?)`).run(userId, mode, name || '', JSON.stringify(params || {}));
  return getAiJob(userId, info.lastInsertRowid);
}
function getAiJob(userId, id) {
  return db.prepare('SELECT * FROM ai_jobs WHERE id = ? AND user_id = ?').get(id, userId);
}
function getAiJobAny(id) {
  return db.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(id);
}
function listAiJobs(userId, limit = 50) {
  return db.prepare('SELECT * FROM ai_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
}
function updateAiJob(id, fields) {
  const allowed = ['status', 'progress', 'error', 'result', 'output_media_id'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(k === 'result' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return getAiJobAny(id);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE ai_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getAiJobAny(id);
}
function nextQueuedAiJob() {
  return db.prepare("SELECT * FROM ai_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get();
}
function deleteAiJob(userId, id) {
  return db.prepare('DELETE FROM ai_jobs WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// --- Provider config (Phase 7): per-provider base URL + model overrides,
// and the active provider per AI kind (when a kind has several providers). ---
function getProviderConfig(provider) {
  return db.prepare('SELECT * FROM provider_config WHERE provider = ?').get(provider) || null;
}
function listProviderConfig() {
  return db.prepare('SELECT * FROM provider_config').all();
}
function upsertProviderConfig(provider, { baseUrl, model }) {
  const cur = getProviderConfig(provider);
  // Compute the next values in JS, then assign them outright. An empty
  // string means CLEAR the override (store NULL, back to the provider
  // default); undefined means "not provided, keep the current value".
  // (The old COALESCE(excluded.x, provider_config.x) form could not tell
  // "clear" apart from "keep" — an emptied model field silently kept the
  // old, possibly retired, model.)
  const nextBaseUrl = baseUrl !== undefined ? (baseUrl || null) : (cur ? cur.base_url : null);
  const nextModel = model !== undefined ? (model || null) : (cur ? cur.model : null);
  db.prepare(`INSERT INTO provider_config (provider, base_url, model)
    VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET
    base_url = excluded.base_url,
    model = excluded.model,
    updated_at = datetime('now')`).run(
    provider,
    nextBaseUrl,
    nextModel
  );
  return getProviderConfig(provider);
}

// --- App settings (generic key/value store; used by the auto-updater) ---
function getAppSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setAppSetting(key, value) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(key, String(value));
  return String(value);
}
function getActiveProvider(kind) {
  const row = db.prepare('SELECT provider FROM provider_prefs WHERE kind = ?').get(kind);
  return row ? row.provider : null;
}
function setActiveProvider(kind, provider) {
  db.prepare(`INSERT INTO provider_prefs (kind, provider) VALUES (?,?)
    ON CONFLICT(kind) DO UPDATE SET provider = excluded.provider, updated_at = datetime('now')`)
    .run(kind, provider);
  return getActiveProvider(kind);
}

// --- Usage / audit ---
function logUsage(userId, action, credits, detail) {
  db.prepare('INSERT INTO usage_log (user_id, action, credits, detail) VALUES (?,?,?,?)')
    .run(userId, action, credits, detail || '');
}
function listUsage(userId, limit = 50) {
  return db.prepare('SELECT * FROM usage_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
}
function audit(userId, action, entity, entityId, detail) {
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)')
    .run(userId, action, entity || null, entityId || null, detail || '');
}
function listAudit(userId, limit = 50) {
  return db.prepare('SELECT * FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
}
// --- Brands (Phase 2) ---
function listBrands(userId) {
  return db.prepare('SELECT * FROM brands WHERE user_id = ? ORDER BY name').all(userId);
}
function getBrand(userId, id) {
  return db.prepare('SELECT * FROM brands WHERE id = ? AND user_id = ?').get(id, userId);
}
function createBrand(userId, b) {
  const info = db.prepare(`INSERT INTO brands
    (user_id, name, logo_media_id, primary_color, secondary_color, accent_color, font_heading, font_body, handles)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    userId, b.name, b.logoMediaId ?? null, b.primaryColor || '#7c5cff',
    b.secondaryColor || '#3b82f6', b.accentColor || '#22d3ee',
    b.fontHeading || 'Poppins', b.fontBody || 'Inter', JSON.stringify(b.handles || {})
  );
  return getBrand(userId, info.lastInsertRowid);
}
function updateBrand(userId, id, b) {
  const cur = getBrand(userId, id);
  if (!cur) return null;
  db.prepare(`UPDATE brands SET
    name = COALESCE(?, name), logo_media_id = ?, primary_color = COALESCE(?, primary_color),
    secondary_color = COALESCE(?, secondary_color), accent_color = COALESCE(?, accent_color),
    font_heading = COALESCE(?, font_heading), font_body = COALESCE(?, font_body),
    handles = COALESCE(?, handles), updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(
      b.name ?? null, b.logoMediaId === undefined ? cur.logo_media_id : b.logoMediaId,
      b.primaryColor ?? null, b.secondaryColor ?? null, b.accentColor ?? null,
      b.fontHeading ?? null, b.fontBody ?? null,
      b.handles !== undefined ? JSON.stringify(b.handles) : null, id, userId
    );
  return getBrand(userId, id);
}
function deleteBrand(userId, id) {
  return db.prepare('DELETE FROM brands WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// --- User-saved design templates (Phase 2; built-ins live in design-templates.js) ---
function listUserTemplates(userId) {
  return db.prepare('SELECT * FROM design_templates WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}
function getUserTemplate(userId, id) {
  return db.prepare('SELECT * FROM design_templates WHERE id = ? AND user_id = ?').get(id, userId);
}
function createUserTemplate(userId, { name, category, content }) {
  const info = db.prepare('INSERT INTO design_templates (user_id, name, category, content) VALUES (?,?,?,?)')
    .run(userId, name, category || 'My templates', JSON.stringify(content));
  return getUserTemplate(userId, info.lastInsertRowid);
}
function deleteUserTemplate(userId, id) {
  return db.prepare('DELETE FROM design_templates WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// --- Bulk jobs + rows (Phase 4) ---
function createBulkJob(userId, { name, kind, templateProjectId, brandId, settings }) {
  const info = db.prepare(`INSERT INTO bulk_jobs
    (user_id, name, kind, template_project_id, brand_id, settings)
    VALUES (?,?,?,?,?,?)`).run(
    userId, name, kind || 'video', templateProjectId || null, brandId || null,
    JSON.stringify(settings || {})
  );
  return getBulkJob(userId, info.lastInsertRowid);
}
function getBulkJob(userId, id) {
  return db.prepare('SELECT * FROM bulk_jobs WHERE id = ? AND user_id = ?').get(id, userId);
}
function getBulkJobAny(id) {
  return db.prepare('SELECT * FROM bulk_jobs WHERE id = ?').get(id);
}
function listBulkJobs(userId) {
  return db.prepare('SELECT * FROM bulk_jobs WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}
function updateBulkJob(id, fields) {
  const allowed = ['name', 'brand_id', 'dataset', 'settings', 'status', 'rows_total', 'rows_done', 'rows_failed'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push((k === 'dataset' || k === 'settings') ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return getBulkJobAny(id);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE bulk_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getBulkJobAny(id);
}
function deleteBulkJob(userId, id) {
  return db.prepare('DELETE FROM bulk_jobs WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}
function createBulkRows(bulkJobId, rows) {
  const insert = db.prepare(`INSERT INTO bulk_rows
    (bulk_job_id, row_index, data, selected) VALUES (?,?,?,?)`);
  const tx = db.transaction((list) => {
    for (const r of list) insert.run(bulkJobId, r.rowIndex, JSON.stringify(r.data || {}), r.selected === false ? 0 : 1);
  });
  tx(rows);
}
function replaceBulkRows(bulkJobId, rows) {
  db.prepare('DELETE FROM bulk_rows WHERE bulk_job_id = ?').run(bulkJobId);
  if (rows.length) createBulkRows(bulkJobId, rows);
}
function listBulkRows(bulkJobId) {
  return db.prepare('SELECT * FROM bulk_rows WHERE bulk_job_id = ? ORDER BY row_index').all(bulkJobId);
}
function getBulkRow(bulkJobId, rowId) {
  return db.prepare('SELECT * FROM bulk_rows WHERE id = ? AND bulk_job_id = ?').get(rowId, bulkJobId);
}
function getBulkRowAny(rowId) {
  return db.prepare('SELECT * FROM bulk_rows WHERE id = ?').get(rowId);
}
function updateBulkRow(rowId, fields) {
  const allowed = ['data', 'selected', 'status', 'background_media_id', 'background_source',
    'background_prompt', 'output_job_id', 'output_path', 'output_name', 'error', 'warnings', 'luminance', 'fit_report'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push((k === 'data' || k === 'warnings') ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return getBulkRowAny(rowId);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE bulk_rows SET ${sets.join(', ')} WHERE id = ?`).run(...vals, rowId);
  return getBulkRowAny(rowId);
}
function refreshBulkJobCounts(bulkJobId) {
  const rows = listBulkRows(bulkJobId);
  const done = rows.filter((r) => r.status === 'done').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  // Skipped duplicates are not part of the batch: they get no video, no job
  // and no count (user rule, Phase 4).
  const total = rows.filter((r) => r.selected && r.status !== 'skipped').length;
  updateBulkJob(bulkJobId, { rows_total: total, rows_done: done, rows_failed: failed });
  return { total, done, failed };
}

// --- Audio analysis cache (Phase 5) ---
// One cached analysis per (user, media file). The file hash is stored so a
// re-uploaded / replaced file is never served a stale analysis.
function getAudioAnalysis(userId, mediaId) {
  const row = db.prepare('SELECT * FROM audio_tracks WHERE user_id = ? AND media_id = ?').get(userId, mediaId);
  if (!row) return null;
  let analysis = {};
  try { analysis = JSON.parse(row.analysis || '{}'); } catch { analysis = {}; }
  return { ...row, analysis };
}
function upsertAudioAnalysis(userId, mediaId, fileHash, analysis) {
  db.prepare(`INSERT INTO audio_tracks (user_id, media_id, file_hash, analysis)
    VALUES (?,?,?,?) ON CONFLICT(user_id, media_id) DO UPDATE SET
    file_hash = excluded.file_hash, analysis = excluded.analysis,
    updated_at = datetime('now')`).run(userId, mediaId, fileHash, JSON.stringify(analysis));
  return getAudioAnalysis(userId, mediaId);
}
function listAudioAnalyses(userId) {
  return db.prepare('SELECT * FROM audio_tracks WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}

// --- Voice profiles (post-Phase-5 quiz upgrade) ---
// kind 'clone': the user's own voice, built from a recorded sample; the
// provider voice id is filled in by cloning (needs an ElevenLabs key).
// kind 'ai': a generic provider voice (e.g. OpenAI TTS voice name).
// One default voice per user — it is applied to ALL videos unless a bulk
// job or a row picks another voice.
function listVoiceProfiles(userId) {
  return db.prepare('SELECT * FROM voice_profiles WHERE user_id = ? ORDER BY is_default DESC, name').all(userId);
}
function getVoiceProfile(userId, id) {
  return db.prepare('SELECT * FROM voice_profiles WHERE id = ? AND user_id = ?').get(id, userId);
}
function getVoiceProfileByName(userId, name) {
  return db.prepare('SELECT * FROM voice_profiles WHERE user_id = ? AND lower(name) = lower(?)').get(userId, name);
}
function createVoiceProfile(userId, { name, language, kind, sampleMediaId, aiVoice }) {
  const info = db.prepare(`INSERT INTO voice_profiles
    (user_id, name, language, kind, sample_media_id, ai_voice)
    VALUES (?,?,?,?,?,?)`).run(
    userId, name, language || 'en', kind || 'clone',
    sampleMediaId || null, aiVoice || null
  );
  return getVoiceProfile(userId, info.lastInsertRowid);
}
function updateVoiceProfile(userId, id, fields) {
  const cur = getVoiceProfile(userId, id);
  if (!cur) return null;
  db.prepare(`UPDATE voice_profiles SET
    name = COALESCE(?, name), language = COALESCE(?, language),
    sample_media_id = ?, provider_voice_id = COALESCE(?, provider_voice_id),
    ai_voice = COALESCE(?, ai_voice),
    updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(
      fields.name ?? null, fields.language ?? null,
      fields.sampleMediaId === undefined ? cur.sample_media_id : fields.sampleMediaId,
      fields.providerVoiceId ?? null, fields.aiVoice ?? null, id, userId
    );
  return getVoiceProfile(userId, id);
}
function deleteVoiceProfile(userId, id) {
  return db.prepare('DELETE FROM voice_profiles WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}
function setDefaultVoiceProfile(userId, id) {
  const target = getVoiceProfile(userId, id);
  if (!target) return null;
  db.transaction(() => {
    db.prepare('UPDATE voice_profiles SET is_default = 0 WHERE user_id = ?').run(userId);
    db.prepare("UPDATE voice_profiles SET is_default = 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(id, userId);
  })();
  return getVoiceProfile(userId, id);
}
function getDefaultVoiceProfile(userId) {
  return db.prepare('SELECT * FROM voice_profiles WHERE user_id = ? AND is_default = 1').get(userId);
}

// --- Shorts jobs + clips (Phase 6) ---
// One shorts job = one long video + its analysis + ranked clip candidates.
// Transcript is job-level (the whole video); clips render with the cues
// overlapping their own window. caption_status is per clip: 'none' (no
// transcript yet), 'ready' (cues overlap this clip), 'burned' (rendered
// with captions), 'no-cues' (transcript exists but no cue falls in it).
function createShortsJob(userId, { mediaId, name, settings, language }) {
  const info = db.prepare(`INSERT INTO shorts_jobs
    (user_id, media_id, name, settings, language) VALUES (?,?,?,?,?)`).run(
    userId, mediaId, name, JSON.stringify(settings || {}), language || 'en'
  );
  return getShortsJob(userId, info.lastInsertRowid);
}
function getShortsJob(userId, id) {
  return db.prepare('SELECT * FROM shorts_jobs WHERE id = ? AND user_id = ?').get(id, userId);
}
function getShortsJobAny(id) {
  return db.prepare('SELECT * FROM shorts_jobs WHERE id = ?').get(id);
}
function listShortsJobs(userId) {
  return db.prepare('SELECT * FROM shorts_jobs WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}
function updateShortsJob(id, fields) {
  const allowed = ['name', 'status', 'analysis', 'settings', 'transcript', 'transcript_source', 'language', 'error'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push((k === 'analysis' || k === 'settings' || k === 'transcript') ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return getShortsJobAny(id);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE shorts_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getShortsJobAny(id);
}
function deleteShortsJob(userId, id) {
  return db.prepare('DELETE FROM shorts_jobs WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// --- Websites (v2.2.3) ---------------------------------------------------------
function createWebsite(userId, { projectId, slug, kind, title, dir }) {
  const info = db.prepare(`INSERT INTO websites (user_id, project_id, slug, kind, title, dir)
    VALUES (?,?,?,?,?,?)`).run(userId, projectId || null, slug, kind, title, dir);
  return db.prepare('SELECT * FROM websites WHERE id = ?').get(info.lastInsertRowid);
}
function getWebsite(userId, slug) {
  return db.prepare('SELECT * FROM websites WHERE slug = ? AND user_id = ?').get(slug, userId);
}
function getWebsiteBySlug(slug) {
  return db.prepare('SELECT * FROM websites WHERE slug = ?').get(slug);
}
function listWebsites(userId) {
  return db.prepare('SELECT * FROM websites WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}
function deleteWebsite(userId, slug) {
  return db.prepare('DELETE FROM websites WHERE slug = ? AND user_id = ?').run(slug, userId).changes > 0;
}
function createShortsClips(jobId, clips) {
  const insert = db.prepare(`INSERT INTO shorts_clips
    (job_id, start_s, end_s, score, breakdown, motion_x) VALUES (?,?,?,?,?,?)`);
  const tx = db.transaction((list) => {
    for (const c of list) insert.run(jobId, c.start, c.end, c.score, JSON.stringify(c.breakdown || {}), c.motionX ?? null);
  });
  tx(clips);
  return listShortsClips(jobId);
}
function replaceShortsClips(jobId, clips) {
  db.prepare('DELETE FROM shorts_clips WHERE job_id = ?').run(jobId);
  return clips.length ? createShortsClips(jobId, clips) : [];
}
function listShortsClips(jobId) {
  return db.prepare('SELECT * FROM shorts_clips WHERE job_id = ? ORDER BY score DESC, start_s ASC').all(jobId);
}
function getShortsClip(jobId, clipId) {
  return db.prepare('SELECT * FROM shorts_clips WHERE id = ? AND job_id = ?').get(clipId, jobId);
}
function getShortsClipAny(clipId) {
  return db.prepare('SELECT * FROM shorts_clips WHERE id = ?').get(clipId);
}
function updateShortsClip(clipId, fields) {
  const allowed = ['start_s', 'end_s', 'score', 'breakdown', 'status', 'motion_x', 'output_job_id', 'output_path', 'caption_status', 'error'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(k === 'breakdown' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return getShortsClipAny(clipId);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE shorts_clips SET ${sets.join(', ')} WHERE id = ?`).run(...vals, clipId);
  return getShortsClipAny(clipId);
}

// --- Social connections + posts (Phase 8) ---
// A connection holds ONE platform account per user. Credentials are an
// encrypted JSON blob { access_token, refresh_token, expires_at, ... };
// they are never returned to the frontend (only presence + account name).
function createSocialConnection(userId, { platform, accountName, credentialsEncrypted, baseUrl, extra }) {
  const info = db.prepare(`INSERT INTO social_connections
    (user_id, platform, account_name, credentials_encrypted, base_url, extra)
    VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, platform) DO UPDATE SET
    account_name = excluded.account_name,
    credentials_encrypted = excluded.credentials_encrypted,
    base_url = excluded.base_url, extra = excluded.extra,
    status = 'connected', updated_at = datetime('now')`).run(
    userId, platform, accountName || '', credentialsEncrypted || null,
    baseUrl || null, JSON.stringify(extra || {})
  );
  return getSocialConnection(userId, platform);
}
function getSocialConnection(userId, platform) {
  return db.prepare('SELECT * FROM social_connections WHERE user_id = ? AND platform = ?').get(userId, platform);
}
function listSocialConnections(userId) {
  return db.prepare('SELECT * FROM social_connections WHERE user_id = ? ORDER BY platform').all(userId);
}
function updateSocialConnection(userId, platform, fields) {
  const cur = getSocialConnection(userId, platform);
  if (!cur) return null;
  db.prepare(`UPDATE social_connections SET
    account_name = COALESCE(?, account_name),
    credentials_encrypted = COALESCE(?, credentials_encrypted),
    base_url = ?, extra = COALESCE(?, extra), status = COALESCE(?, status),
    updated_at = datetime('now') WHERE user_id = ? AND platform = ?`).run(
    fields.accountName ?? null, fields.credentialsEncrypted ?? null,
    fields.baseUrl === undefined ? cur.base_url : fields.baseUrl,
    fields.extra !== undefined ? JSON.stringify(fields.extra) : null,
    fields.status ?? null, userId, platform
  );
  return getSocialConnection(userId, platform);
}
function deleteSocialConnection(userId, platform) {
  return db.prepare('DELETE FROM social_connections WHERE user_id = ? AND platform = ?').run(userId, platform).changes > 0;
}
function publicSocialConnection(row) {
  if (!row) return null;
  let extra = {};
  try { extra = JSON.parse(row.extra || '{}'); } catch { extra = {}; }
  return {
    id: row.id, platform: row.platform, accountName: row.account_name,
    status: row.status, baseUrl: row.base_url, extra,
    hasCredentials: Boolean(row.credentials_encrypted),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function createSocialPost(userId, { platform, title, text, mediaIds, status, scheduledAt }) {
  const info = db.prepare(`INSERT INTO social_posts
    (user_id, platform, title, text, media_ids, status, scheduled_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    userId, platform, title || '', text, JSON.stringify(mediaIds || []),
    status || 'draft', scheduledAt || null
  );
  return getSocialPost(userId, info.lastInsertRowid);
}
function getSocialPost(userId, id) {
  return db.prepare('SELECT * FROM social_posts WHERE id = ? AND user_id = ?').get(id, userId);
}
function getSocialPostAny(id) {
  return db.prepare('SELECT * FROM social_posts WHERE id = ?').get(id);
}
function listSocialPosts(userId, { status, platform, from, to } = {}) {
  let sql = 'SELECT * FROM social_posts WHERE user_id = ?';
  const params = [userId];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (platform) { sql += ' AND platform = ?'; params.push(platform); }
  if (from) { sql += ' AND date(COALESCE(scheduled_at, created_at)) >= date(?)'; params.push(from); }
  if (to) { sql += ' AND date(COALESCE(scheduled_at, created_at)) <= date(?)'; params.push(to); }
  sql += ' ORDER BY COALESCE(scheduled_at, created_at) DESC, id DESC';
  return db.prepare(sql).all(...params);
}
function updateSocialPost(id, fields) {
  const allowed = ['platform', 'title', 'text', 'media_ids', 'status', 'scheduled_at',
    'published_at', 'provider_post_id', 'provider_response', 'manual_note', 'manual_url', 'error'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push((k === 'media_ids' || k === 'provider_response') ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return getSocialPostAny(id);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE social_posts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getSocialPostAny(id);
}
function deleteSocialPost(userId, id) {
  return db.prepare('DELETE FROM social_posts WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}
function listDueSocialPosts(nowIso) {
  return db.prepare(`SELECT * FROM social_posts
    WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
    ORDER BY scheduled_at ASC LIMIT 20`).all(nowIso);
}

// --- Plan upgrade requests (Phase 8) ---
// No payment gateway exists: a user requests a plan, an OWNER approves or
// rejects it in Admin, and approval applies the plan + its credits.
function createPlanRequest(userId, { plan, note }) {
  const info = db.prepare(`INSERT INTO plan_requests (user_id, plan, note) VALUES (?,?,?)`)
    .run(userId, plan, note || '');
  return getPlanRequest(info.lastInsertRowid);
}
function getPlanRequest(id) {
  return db.prepare('SELECT * FROM plan_requests WHERE id = ?').get(id);
}
function listPlanRequests({ userId, status } = {}) {
  let sql = 'SELECT * FROM plan_requests WHERE 1=1';
  const params = [];
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}
function updatePlanRequest(id, fields) {
  const sets = [];
  const vals = [];
  if (fields.status !== undefined) { sets.push('status = ?'); vals.push(fields.status); }
  if (fields.decidedBy !== undefined) { sets.push('decided_by = ?'); vals.push(fields.decidedBy); }
  if (fields.status !== undefined) sets.push("decided_at = datetime('now')");
  if (!sets.length) return getPlanRequest(id);
  db.prepare(`UPDATE plan_requests SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getPlanRequest(id);
}

// --- Marketplace (Phase 8, in-app only) ---
// There is NO external marketplace: listings are the users' own saved
// templates published inside this install. Installed copies are real,
// editable templates — never flattened images.
function createMarketplaceTemplate(userId, t) {
  const info = db.prepare(`INSERT INTO marketplace_templates
    (user_id, kind, source_type, source_id, name, description, tags, category, content, preview_media_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    userId, t.kind || 'design', t.sourceType || 'template', t.sourceId || null,
    t.name, t.description || '', t.tags || '', t.category || 'General',
    JSON.stringify(t.content || {}), t.previewMediaId || null
  );
  return getMarketplaceTemplate(info.lastInsertRowid);
}
function getMarketplaceTemplate(id) {
  return db.prepare('SELECT * FROM marketplace_templates WHERE id = ?').get(id);
}
function listMarketplaceTemplates({ q, category, kind, status = 'active', includeRemoved = false } = {}) {
  let sql = `SELECT m.*, u.name AS author_name,
    COALESCE((SELECT AVG(rating) FROM marketplace_ratings WHERE template_id = m.id), 0) AS avg_rating,
    (SELECT COUNT(*) FROM marketplace_ratings WHERE template_id = m.id) AS rating_count,
    (SELECT COUNT(*) FROM marketplace_reports WHERE template_id = m.id) AS report_count
    FROM marketplace_templates m JOIN users u ON u.id = m.user_id WHERE 1=1`;
  const params = [];
  if (!includeRemoved) { sql += " AND m.status = ?"; params.push(status); }
  if (kind) { sql += ' AND m.kind = ?'; params.push(kind); }
  if (category) { sql += ' AND m.category = ?'; params.push(category); }
  if (q) { sql += ' AND (m.name LIKE ? OR m.description LIKE ? OR m.tags LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY m.downloads DESC, m.created_at DESC';
  return db.prepare(sql).all(...params);
}
function updateMarketplaceTemplate(id, fields) {
  const allowed = ['name', 'description', 'tags', 'category', 'status', 'downloads'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return getMarketplaceTemplate(id);
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE marketplace_templates SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getMarketplaceTemplate(id);
}
function deleteMarketplaceTemplate(id) {
  return db.prepare('DELETE FROM marketplace_templates WHERE id = ?').run(id).changes > 0;
}
function rateMarketplaceTemplate(templateId, userId, rating, comment) {
  db.prepare(`INSERT INTO marketplace_ratings (template_id, user_id, rating, comment)
    VALUES (?,?,?,?) ON CONFLICT(template_id, user_id) DO UPDATE SET
    rating = excluded.rating, comment = excluded.comment, created_at = datetime('now')`)
    .run(templateId, userId, rating, comment || '');
  return db.prepare('SELECT * FROM marketplace_ratings WHERE template_id = ? AND user_id = ?').get(templateId, userId);
}
function listMarketplaceRatings(templateId) {
  return db.prepare('SELECT * FROM marketplace_ratings WHERE template_id = ? ORDER BY created_at DESC').all(templateId);
}
function reportMarketplaceTemplate(templateId, userId, reason) {
  const info = db.prepare('INSERT INTO marketplace_reports (template_id, user_id, reason) VALUES (?,?,?)')
    .run(templateId, userId, reason);
  return db.prepare('SELECT * FROM marketplace_reports WHERE id = ?').get(info.lastInsertRowid);
}

// --- Project shares + comments (v2.2.4, Collaboration) ----------------------
// Shares are READ-ONLY by design (permission is always 'view'). There is
// NO live co-editing: a shared user can view the project and comment, but
// never edit it. A share is either per-user (shared_with_user_id) or a
// read-only link (token). The UNIQUE constraints make duplicate shares
// impossible — re-sharing returns the existing row.
function createProjectShare(ownerUserId, projectId, { sharedWithUserId = null, token = null } = {}) {
  if (sharedWithUserId) {
    const existing = db.prepare('SELECT * FROM project_shares WHERE project_id = ? AND shared_with_user_id = ?').get(projectId, sharedWithUserId);
    if (existing) return { ...existing, alreadyShared: true };
    const info = db.prepare(`INSERT INTO project_shares
      (project_id, owner_user_id, shared_with_user_id, token, permission) VALUES (?,?,?,NULL,'view')`)
      .run(projectId, ownerUserId, sharedWithUserId);
    return db.prepare('SELECT * FROM project_shares WHERE id = ?').get(info.lastInsertRowid);
  }
  if (token) {
    const existing = db.prepare('SELECT * FROM project_shares WHERE project_id = ? AND token = ?').get(projectId, token);
    if (existing) return { ...existing, alreadyShared: true };
    const info = db.prepare(`INSERT INTO project_shares
      (project_id, owner_user_id, shared_with_user_id, token, permission) VALUES (?,?,NULL,?,'view')`)
      .run(projectId, ownerUserId, token);
    return db.prepare('SELECT * FROM project_shares WHERE id = ?').get(info.lastInsertRowid);
  }
  throw new Error('A share needs either a user or a link token.');
}
function getProjectShare(id) {
  return db.prepare('SELECT * FROM project_shares WHERE id = ?').get(id);
}
function getProjectShareByToken(token) {
  return db.prepare('SELECT * FROM project_shares WHERE token = ?').get(token);
}
function getProjectShareForUser(projectId, userId) {
  return db.prepare('SELECT * FROM project_shares WHERE project_id = ? AND shared_with_user_id = ?').get(projectId, userId);
}
function getProjectLinkShare(projectId) {
  return db.prepare('SELECT * FROM project_shares WHERE project_id = ? AND token IS NOT NULL').get(projectId);
}
function listProjectShares(projectId) {
  return db.prepare(`SELECT s.*, u.name AS shared_with_name, u.email AS shared_with_email
    FROM project_shares s LEFT JOIN users u ON u.id = s.shared_with_user_id
    WHERE s.project_id = ? ORDER BY s.created_at`).all(projectId);
}
function deleteProjectShare(id) {
  return db.prepare('DELETE FROM project_shares WHERE id = ?').run(id).changes > 0;
}
function listSharedWithMe(userId) {
  return db.prepare(`SELECT p.*, s.id AS share_id, s.created_at AS shared_at,
      u.name AS owner_name, u.email AS owner_email
    FROM project_shares s
    JOIN projects p ON p.id = s.project_id
    JOIN users u ON u.id = s.owner_user_id
    WHERE s.shared_with_user_id = ? AND p.trashed = 0 ORDER BY s.created_at DESC`).all(userId);
}
function canViewProject(userId, project) {
  if (!project) return false;
  if (project.user_id === userId) return true;
  return Boolean(getProjectShareForUser(project.id, userId));
}

// Comments: one level of replies only (parent_id points at a top-level
// comment). Resolving applies to the whole thread (the top-level comment).
function createProjectComment(userId, projectId, { body, parentId = null }) {
  if (parentId) {
    const parent = db.prepare('SELECT * FROM project_comments WHERE id = ? AND project_id = ?').get(parentId, projectId);
    if (!parent) throw new Error('The comment being replied to was not found on this project.');
    if (parent.parent_id) throw new Error('Replies can only be added to a top-level comment, not to another reply.');
  }
  const info = db.prepare(`INSERT INTO project_comments
    (project_id, user_id, parent_id, body) VALUES (?,?,?,?)`).run(projectId, userId, parentId, body);
  return getProjectComment(info.lastInsertRowid);
}
function getProjectComment(id) {
  return db.prepare(`SELECT c.*, u.name AS author_name
    FROM project_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`).get(id);
}
function listProjectComments(projectId) {
  return db.prepare(`SELECT c.*, u.name AS author_name
    FROM project_comments c JOIN users u ON u.id = c.user_id
    WHERE c.project_id = ? ORDER BY c.created_at ASC`).all(projectId);
}
function resolveProjectComment(id, resolved) {
  const cur = db.prepare('SELECT * FROM project_comments WHERE id = ?').get(id);
  if (!cur) return null;
  const topId = cur.parent_id || cur.id;
  db.prepare(`UPDATE project_comments SET status = ?, updated_at = datetime('now')
    WHERE id = ? OR parent_id = ?`).run(resolved ? 'resolved' : 'open', topId, topId);
  return getProjectComment(id);
}
function deleteProjectComment(id) {
  return db.prepare('DELETE FROM project_comments WHERE id = ?').run(id).changes > 0;
}

// --- Google OAuth config (Phase 8) ---
// Client id/secret for Google OAuth (Sheets + Drive read). The secret is
// encrypted at rest; the client id is not a secret and is returned.
function getOAuthConfig(provider) {
  return db.prepare('SELECT * FROM oauth_configs WHERE provider = ?').get(provider) || null;
}
function upsertOAuthConfig(provider, { clientId, clientSecretEncrypted, redirectUri }) {
  const cur = getOAuthConfig(provider);
  db.prepare(`INSERT INTO oauth_configs (provider, client_id, client_secret_encrypted, redirect_uri)
    VALUES (?,?,?,?) ON CONFLICT(provider) DO UPDATE SET
    client_id = COALESCE(excluded.client_id, oauth_configs.client_id),
    client_secret_encrypted = COALESCE(excluded.client_secret_encrypted, oauth_configs.client_secret_encrypted),
    redirect_uri = COALESCE(excluded.redirect_uri, oauth_configs.redirect_uri),
    updated_at = datetime('now')`).run(
    provider,
    clientId !== undefined ? (clientId || null) : (cur ? cur.client_id : null),
    clientSecretEncrypted !== undefined ? (clientSecretEncrypted || null) : (cur ? cur.client_secret_encrypted : null),
    redirectUri !== undefined ? (redirectUri || null) : (cur ? cur.redirect_uri : null)
  );
  return getOAuthConfig(provider);
}

// --- Admin helpers (Phase 8) ---
function listUsersAdmin(search) {
  if (!search) return listUsers();
  const like = `%${search}%`;
  return db.prepare(`SELECT id, name, email, role, plan, credits_balance, suspended, created_at
    FROM users WHERE name LIKE ? OR email LIKE ? ORDER BY id`).all(like, like);
}
function listAuditAll({ userId, action, limit = 100 } = {}) {
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  if (action) { sql += ' AND action = ?'; params.push(action); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}
function deleteUserById(id) {
  return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}
function platformStats() {
  const one = (sql) => db.prepare(sql).get().c;
  return {
    users: one('SELECT COUNT(*) AS c FROM users'),
    suspendedUsers: one('SELECT COUNT(*) AS c FROM users WHERE suspended = 1'),
    projects: one('SELECT COUNT(*) AS c FROM projects'),
    media: one('SELECT COUNT(*) AS c FROM media'),
    renderJobs: one('SELECT COUNT(*) AS c FROM jobs'),
    rendersDone: one("SELECT COUNT(*) AS c FROM jobs WHERE status = 'done'"),
    bulkJobs: one('SELECT COUNT(*) AS c FROM bulk_jobs'),
    shortsJobs: one('SELECT COUNT(*) AS c FROM shorts_jobs'),
    aiJobs: one('SELECT COUNT(*) AS c FROM ai_jobs'),
    aiJobsDone: one("SELECT COUNT(*) AS c FROM ai_jobs WHERE status = 'done'"),
    socialPosts: one('SELECT COUNT(*) AS c FROM social_posts'),
    socialPublished: one("SELECT COUNT(*) AS c FROM social_posts WHERE status = 'published'"),
    marketplaceTemplates: one("SELECT COUNT(*) AS c FROM marketplace_templates WHERE status = 'active'"),
    creditsOutstanding: one('SELECT COALESCE(SUM(credits_balance),0) AS c FROM users'),
    creditsSpent: one('SELECT COALESCE(SUM(-credits),0) AS c FROM usage_log WHERE credits < 0'),
    storageBytes: one('SELECT COALESCE(SUM(size_bytes),0) AS c FROM media'),
    pendingPlanRequests: one("SELECT COUNT(*) AS c FROM plan_requests WHERE status = 'pending'"),
  };
}
function userUsageSummary(userId) {
  const spent = db.prepare('SELECT COALESCE(SUM(-credits),0) AS c FROM usage_log WHERE user_id = ? AND credits < 0').get(userId).c;
  const byAction = db.prepare(`SELECT action, COUNT(*) AS n, COALESCE(SUM(-credits),0) AS spent
    FROM usage_log WHERE user_id = ? AND credits < 0 GROUP BY action ORDER BY spent DESC`).all(userId);
  return { spent, byAction, log: listUsage(userId, 100) };
}

function dashboardCounts(userId) {
  return {
    projects: db.prepare('SELECT COUNT(*) AS c FROM projects WHERE user_id = ? AND trashed = 0').get(userId).c,
    media: db.prepare('SELECT COUNT(*) AS c FROM media WHERE user_id = ?').get(userId).c,
    jobs: countJobs(userId),
    jobsActive: countJobs(userId, 'queued') + countJobs(userId, 'running'),
    trashedProjects: db.prepare('SELECT COUNT(*) AS c FROM projects WHERE user_id = ? AND trashed = 1').get(userId).c,
    storageBytes: mediaStorageBytes(userId),
  };
}

module.exports = {
  db, createUser, getUserByEmail, getUserById, countUsers, listUsers, updateUser, setPassword,
  createSession, getSession, deleteSession, deleteSessionsForUser,
  listFolders, createFolder, deleteFolder,
  listProjects, getProject, getProjectAny, createProject, updateProject, saveProjectVersion, listProjectVersions,
  getProjectVersion, duplicateProject, deleteProjectPermanently,
  listMedia, getMedia, createMedia, updateMedia, deleteMedia, mediaStorageBytes,
  countJobs, listJobs, createJob, getJob, getJobAny, updateJob, deleteJob,
  nextQueuedJob, resetRunningJobs,
  listBrands, getBrand, createBrand, updateBrand, deleteBrand,
  listUserTemplates, getUserTemplate, createUserTemplate, deleteUserTemplate,
  createBulkJob, getBulkJob, getBulkJobAny, listBulkJobs, updateBulkJob, deleteBulkJob,
  createBulkRows, replaceBulkRows, listBulkRows, getBulkRow, getBulkRowAny, updateBulkRow,
  refreshBulkJobCounts,
  getAudioAnalysis, upsertAudioAnalysis, listAudioAnalyses,
  listVoiceProfiles, getVoiceProfile, getVoiceProfileByName, createVoiceProfile,
  updateVoiceProfile, deleteVoiceProfile, setDefaultVoiceProfile, getDefaultVoiceProfile,
  createShortsJob, getShortsJob, getShortsJobAny, listShortsJobs, updateShortsJob,
  deleteShortsJob, createShortsClips, replaceShortsClips, listShortsClips,
  createWebsite, getWebsite, getWebsiteBySlug, listWebsites, deleteWebsite,
  getShortsClip, getShortsClipAny, updateShortsClip,
  createSocialConnection, getSocialConnection, listSocialConnections,
  updateSocialConnection, deleteSocialConnection, publicSocialConnection,
  createSocialPost, getSocialPost, getSocialPostAny, listSocialPosts,
  updateSocialPost, deleteSocialPost, listDueSocialPosts,
  createPlanRequest, getPlanRequest, listPlanRequests, updatePlanRequest,
  createMarketplaceTemplate, getMarketplaceTemplate, listMarketplaceTemplates,
  updateMarketplaceTemplate, deleteMarketplaceTemplate, rateMarketplaceTemplate,
  listMarketplaceRatings, reportMarketplaceTemplate,
  createProjectShare, getProjectShare, getProjectShareByToken, getProjectShareForUser,
  getProjectLinkShare, listProjectShares, deleteProjectShare, listSharedWithMe,
  canViewProject, createProjectComment, getProjectComment, listProjectComments,
  resolveProjectComment, deleteProjectComment,
  getOAuthConfig, upsertOAuthConfig,
  listUsersAdmin, listAuditAll, deleteUserById, platformStats, userUsageSummary,
  getProviderSettings, upsertProvider,
  getProviderConfig, listProviderConfig, upsertProviderConfig,
  getAppSetting, setAppSetting,
  getActiveProvider, setActiveProvider,
  createAiJob, getAiJob, getAiJobAny, listAiJobs, updateAiJob,
  nextQueuedAiJob, deleteAiJob,
  logUsage, listUsage, audit, listAudit, dashboardCounts,
};
