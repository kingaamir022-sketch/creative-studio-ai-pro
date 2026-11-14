'use strict';
// Collaboration routes (v2.2.4 share + comments; v2.5.0 #26 depth).
//
//   POST   /api/collab/projects/:id/link          — create/get read-only link (owner)
//   DELETE /api/collab/projects/:id/link          — revoke the link (owner)
//   GET    /api/collab/projects/:id/shares        — list shares (owner)
//   POST   /api/collab/projects/:id/share {email, permission} — share with a user (owner)
//   PATCH  /api/collab/projects/:id/shares/:shareId {permission} — change a share (owner)
//   DELETE /api/collab/projects/:id/shares/:shareId — remove a share (owner)
//   GET    /api/collab/shared-with-me            — projects shared with me (with permission)
//   GET    /api/collab/shared-with-me/:projectId — view (shared user; edit info included)
//   PATCH  /api/collab/shared-with-me/:projectId — save name/content (edit shares only)
//   POST   /api/collab/shared-with-me/:projectId/leave — remove my own share
//   GET    /api/collab/projects/:id/comments     — list threads (owner/shared)
//   POST   /api/collab/projects/:id/comments     — add comment/reply (owner/shared)
//   POST   /api/collab/projects/:id/comments/:commentId/resolve — resolve/reopen
//   DELETE /api/collab/projects/:id/comments/:commentId — delete (owner/author)
//   GET    /api/collab/projects/:id/activity     — per-project activity feed
//   GET    /api/collab/shared/:token             — PUBLIC read-only view (no login)
//
// v2.5.0: shares can grant 'edit' as well as 'view'. The base
// project_shares table in db.js still CHECKs permission IN ('view'), so
// the edit grant lives in collab_share_permissions (created here, in this
// module — no db.js edit): a per-user share with an 'edit' row there can
// save the project's name/content through PATCH /shared-with-me/:id.
// Link shares are ALWAYS view-only (a public link must never edit).
// There is still NO live co-editing: an edit share saves whole-project
// content like the owner does; two people editing at once last-write-wins.
// @mentions: "@Name" in a comment notifies the matched user of this
// install through their bell (an audit entry). Comments can be pinned to
// a layer/slide (layerRef) — stored on the comment row. Every share /
// comment / edit is written to the per-project activity feed.
//
// OWNER-untouchable rule (unchanged): nothing in this file touches user
// roles. Granting 'edit' on one project never grants admin powers, never
// changes anyone's role, and can never make someone OWNER — role changes
// stay in the Admin routes, where an ADMIN still cannot touch the OWNER.
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

// --- v2.5.0 tables/columns (this module only — no db.js edit) -------------
db.db.exec(`CREATE TABLE IF NOT EXISTS collab_share_permissions (
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  permission TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view','edit')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS project_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_activity_project ON project_activity(project_id, created_at);`);
// Pinned comments: additive columns on the existing comments table.
for (const col of ['layer_ref TEXT', 'mentions TEXT NOT NULL DEFAULT \'[]\'']) {
  const name = col.split(' ')[0];
  const has = db.db.prepare('PRAGMA table_info(project_comments)').all().some((c) => c.name === name);
  if (!has) db.db.exec(`ALTER TABLE project_comments ADD COLUMN ${col}`);
}

function logActivity(projectId, userId, action, detail) {
  db.db.prepare('INSERT INTO project_activity (project_id, user_id, action, detail) VALUES (?,?,?,?)')
    .run(projectId, userId, action, detail || '');
}

function sharePermission(projectId, userId) {
  const row = db.db.prepare('SELECT permission FROM collab_share_permissions WHERE project_id = ? AND user_id = ?')
    .get(projectId, userId);
  return row ? row.permission : 'view';
}
function setSharePermission(projectId, userId, permission) {
  db.db.prepare(`INSERT INTO collab_share_permissions (project_id, user_id, permission, updated_at)
    VALUES (?,?,?,datetime('now'))
    ON CONFLICT(project_id, user_id) DO UPDATE SET permission = excluded.permission, updated_at = datetime('now')`)
    .run(projectId, userId, permission);
}
function canEditProject(userId, project) {
  if (!project) return false;
  if (project.user_id === userId) return true;
  const share = db.getProjectShareForUser(project.id, userId);
  if (!share) return false;
  return sharePermission(project.id, userId) === 'edit';
}

function publicProject(p) {
  if (!p) return null;
  let content = {};
  try { content = JSON.parse(p.content || '{}'); } catch { content = {}; }
  return { id: p.id, name: p.name, type: p.type, content, createdAt: p.created_at, updatedAt: p.updated_at };
}

function loadOwnedProject(req, res) {
  const p = db.getProject(req.user.id, req.params.id);
  if (!p) { res.status(404).json({ error: 'Project not found.' }); return null; }
  return p;
}

function loadViewableProject(req, res) {
  const p = db.getProjectAny(req.params.id);
  if (!p) { res.status(404).json({ error: 'Project not found.' }); return null; }
  if (!db.canViewProject(req.user.id, p)) { res.status(403).json({ error: 'This project has not been shared with you.' }); return null; }
  return p;
}

// @mentions: match "@Firstname", "@Full Name" or "@email-local-part"
// against the users of this install. Returns the matched user rows.
// (Per-user candidate match: the old tokenising regex swallowed the rest
// of the sentence after a mid-sentence mention, so "@Second please check…"
// never matched anyone.)
function findMentionedUsers(body, authorId) {
  const text = String(body || '');
  const users = db.db.prepare('SELECT id, name, email FROM users').all()
    .filter((u) => u.id !== authorId);
  const found = new Map();
  for (const u of users) {
    const full = String(u.name || '').trim();
    const first = full.split(' ')[0] || '';
    const emailLocal = String(u.email || '').split('@')[0];
    for (const candidate of [full, first, emailLocal]) {
      if (!candidate) continue;
      const esc = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`@${esc}(?![A-Za-z0-9._-])`, 'i').test(text)) found.set(u.id, u);
    }
  }
  return [...found.values()];
}

// --- Read-only link ----------------------------------------------------------
router.post('/projects/:id/link', auth.requireAuth, (req, res) => {
  const p = loadOwnedProject(req, res);
  if (!p) return;
  const existing = db.getProjectLinkShare(p.id);
  if (existing) return res.json({ link: { token: existing.token, url: `/api/collab/shared/${existing.token}`, createdAt: existing.created_at }, alreadyExists: true });
  const token = crypto.randomBytes(24).toString('hex');
  const share = db.createProjectShare(req.user.id, p.id, { token });
  db.audit(req.user.id, 'share_link_created', 'project', p.id, `Created a read-only share link for "${p.name}"`);
  logActivity(p.id, req.user.id, 'share_link_created', `Created a read-only share link for "${p.name}"`);
  res.status(201).json({ link: { token: share.token, url: `/api/collab/shared/${share.token}`, createdAt: share.created_at }, alreadyExists: false });
});

router.delete('/projects/:id/link', auth.requireAuth, (req, res) => {
  const p = loadOwnedProject(req, res);
  if (!p) return;
  const existing = db.getProjectLinkShare(p.id);
  if (!existing) return res.status(404).json({ error: 'This project has no share link.' });
  db.deleteProjectShare(existing.id);
  db.audit(req.user.id, 'share_link_revoked', 'project', p.id, `Revoked the read-only share link for "${p.name}"`);
  logActivity(p.id, req.user.id, 'share_link_revoked', `Revoked the share link for "${p.name}"`);
  res.json({ ok: true });
});

// Reveal the full link URL (owner only — the shares list masks the token).
router.post('/projects/:id/link/reveal', auth.requireAuth, (req, res) => {
  const p = loadOwnedProject(req, res);
  if (!p) return;
  const existing = db.getProjectLinkShare(p.id);
  if (!existing) return res.status(404).json({ error: 'This project has no share link.' });
  res.json({ link: { token: existing.token, url: `/api/collab/shared/${existing.token}`, createdAt: existing.created_at } });
});

// --- Per-user shares ---------------------------------------------------------
router.get('/projects/:id/shares', auth.requireAuth, (req, res) => {
  const p = loadOwnedProject(req, res);
  if (!p) return;
  const shares = db.listProjectShares(p.id).map((s) => ({
    id: s.id,
    kind: s.token ? 'link' : 'user',
    sharedWithUserId: s.shared_with_user_id,
    sharedWithName: s.shared_with_name || null,
    sharedWithEmail: s.shared_with_email || null,
    // Link shares are always view-only; per-user shares read the v2.5.0
    // permission table (default 'view' for shares made before it existed).
    permission: s.token ? 'view' : sharePermission(p.id, s.shared_with_user_id),
    token: s.token ? s.token.slice(0, 8) + '…' : null,
    createdAt: s.created_at,
  }));
  res.json({ project: { id: p.id, name: p.name }, shares, note: 'Per-user shares can be view or edit. Link shares are always view-only. There is no live co-editing — an edit share saves whole-project content, last write wins.' });
});

router.post('/projects/:id/share', auth.requireAuth, (req, res) => {
  const p = loadOwnedProject(req, res);
  if (!p) return;
  const email = String((req.body && req.body.email) || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid email address is required.' });
  const permission = (req.body && req.body.permission) || 'view';
  if (!['view', 'edit'].includes(permission)) return res.status(400).json({ error: 'permission must be view or edit.' });
  const target = db.getUserByEmail(email);
  if (!target) return res.status(404).json({ error: `No user with email "${email}" exists on this install — shares only work between users of this install.` });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You already own this project — it cannot be shared with yourself.' });
  const share = db.createProjectShare(req.user.id, p.id, { sharedWithUserId: target.id });
  setSharePermission(p.id, target.id, permission);
  db.audit(req.user.id, 'share_user', 'project', p.id, `Shared "${p.name}" (${permission}) with ${target.email}${share.alreadyShared ? ' (already shared — permission updated)' : ''}`);
  db.audit(target.id, 'share_received', 'project', p.id, `${req.user.name} shared "${p.name}" with you (${permission === 'edit' ? 'you can edit it' : 'view only'})`);
  logActivity(p.id, req.user.id, 'share_user', `Shared with ${target.name || target.email} (${permission})`);
  res.status(share.alreadyShared ? 200 : 201).json({
    share: { id: share.id, sharedWithUserId: target.id, sharedWithName: target.name, sharedWithEmail: target.email, permission, createdAt: share.created_at },
    alreadyShared: Boolean(share.alreadyShared),
    note: permission === 'edit'
      ? 'Shared with edit access. The user can save name/content changes (no live co-editing — last write wins). They gain no admin or role powers.'
      : 'Shared read-only. The user can view and comment, never edit.',
  });
});

// Change a share's permission (owner only). Link shares cannot be edited.
router.patch('/projects/:id/shares/:shareId', auth.requireAuth, (req, res) => {
  const p = loadOwnedProject(req, res);
  if (!p) return;
  const share = db.getProjectShare(req.params.shareId);
  if (!share || share.project_id !== p.id) return res.status(404).json({ error: 'Share not found on this project.' });
  if (share.token) return res.status(400).json({ error: 'A share link is always view-only — it cannot be given edit access.' });
  const permission = (req.body && req.body.permission) || '';
  if (!['view', 'edit'].includes(permission)) return res.status(400).json({ error: 'permission must be view or edit.' });
  setSharePermission(p.id, share.shared_with_user_id, permission);
  db.audit(req.user.id, 'share_permission', 'project', p.id, `Share permission for "${p.name}" changed to ${permission}`);
  logActivity(p.id, req.user.id, 'share_permission', `Share permission changed to ${permission}`);
  res.json({ share: { id: share.id, sharedWithUserId: share.shared_with_user_id, permission } });
});

router.delete('/projects/:id/shares/:shareId', auth.requireAuth, (req, res) => {
  const p = loadOwnedProject(req, res);
  if (!p) return;
  const share = db.getProjectShare(req.params.shareId);
  if (!share || share.project_id !== p.id) return res.status(404).json({ error: 'Share not found on this project.' });
  db.db.prepare('DELETE FROM collab_share_permissions WHERE project_id = ? AND user_id = ?').run(p.id, share.shared_with_user_id);
  db.deleteProjectShare(share.id);
  db.audit(req.user.id, 'share_removed', 'project', p.id, `Removed a share from "${p.name}"`);
  logActivity(p.id, req.user.id, 'share_removed', `Removed a share from "${p.name}"`);
  res.json({ ok: true });
});

// --- Shared with me ----------------------------------------------------------
router.get('/shared-with-me', auth.requireAuth, (req, res) => {
  const rows = db.listSharedWithMe(req.user.id);
  res.json({
    projects: rows.map((r) => ({
      id: r.id, name: r.name, type: r.type, shareId: r.share_id, sharedAt: r.shared_at,
      ownerName: r.owner_name, ownerEmail: r.owner_email, updatedAt: r.updated_at,
      permission: sharePermission(r.id, req.user.id),
    })),
    note: 'Projects shared with you. View shares are read-only (view + comment); edit shares can also save name/content changes. There is no live co-editing.',
  });
});

router.get('/shared-with-me/:projectId', auth.requireAuth, (req, res) => {
  const p = db.getProjectAny(req.params.projectId);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const share = db.getProjectShareForUser(p.id, req.user.id);
  if (!share && p.user_id !== req.user.id) return res.status(403).json({ error: 'This project has not been shared with you.' });
  const isOwner = p.user_id === req.user.id;
  res.json({
    project: publicProject(p),
    shared: Boolean(share),
    permission: isOwner ? 'owner' : sharePermission(p.id, req.user.id),
    canEdit: isOwner || sharePermission(p.id, req.user.id) === 'edit',
  });
});

// Save through an edit share (owner or edit-share only). The owner keeps
// using /api/projects/:id; this endpoint is the shared user's edit path.
router.patch('/shared-with-me/:projectId', auth.requireAuth, (req, res) => {
  const p = db.getProjectAny(req.params.projectId);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  if (!canEditProject(req.user.id, p)) {
    return res.status(403).json({ error: 'This project is shared with you as view-only. Ask the owner for edit access.' });
  }
  const { name, content } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'Project name cannot be empty.' });
  }
  if (content !== undefined && (typeof content !== 'object' || content === null || Array.isArray(content))) {
    return res.status(400).json({ error: 'Project content must be a JSON object.' });
  }
  db.db.prepare(`UPDATE projects SET
    name = COALESCE(?, name), content = COALESCE(?, content), updated_at = datetime('now')
    WHERE id = ?`).run(
    name !== undefined ? name.trim() : null,
    content !== undefined ? JSON.stringify(content) : null,
    p.id,
  );
  const fresh = db.getProjectAny(p.id);
  db.audit(req.user.id, 'shared_project_edit', 'project', p.id, `${req.user.name} saved changes to shared project "${p.name}"`);
  logActivity(p.id, req.user.id, 'project_edited', `${req.user.name} saved changes${name !== undefined ? ` (renamed to "${name.trim()}")` : ''}`);
  res.json({ project: publicProject(fresh) });
});

router.post('/shared-with-me/:projectId/leave', auth.requireAuth, (req, res) => {
  const share = db.getProjectShareForUser(req.params.projectId, req.user.id);
  if (!share) return res.status(404).json({ error: 'You do not have a share on this project.' });
  db.db.prepare('DELETE FROM collab_share_permissions WHERE project_id = ? AND user_id = ?').run(req.params.projectId, req.user.id);
  db.deleteProjectShare(share.id);
  res.json({ ok: true });
});

// --- Comments ----------------------------------------------------------------
function publicComment(t) {
  let mentions = [];
  try { mentions = JSON.parse(t.mentions || '[]'); } catch { mentions = []; }
  return {
    id: t.id, body: t.body, status: t.status, authorName: t.author_name, authorId: t.user_id,
    layerRef: t.layer_ref || null, mentions,
    createdAt: t.created_at, updatedAt: t.updated_at,
  };
}

router.get('/projects/:id/comments', auth.requireAuth, (req, res) => {
  const p = loadViewableProject(req, res);
  if (!p) return;
  const rows = db.listProjectComments(p.id);
  const byId = new Map(rows.map((r) => [r.id, { ...publicComment(r), replies: [] }]));
  const threads = [];
  for (const r of rows) {
    if (r.parent_id && byId.get(r.parent_id)) byId.get(r.parent_id).replies.push(byId.get(r.id));
    else if (!r.parent_id) threads.push(byId.get(r.id));
  }
  res.json({ project: { id: p.id, name: p.name }, comments: threads });
});

router.post('/projects/:id/comments', auth.requireAuth, (req, res) => {
  const p = loadViewableProject(req, res);
  if (!p) return;
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'A comment needs some text.' });
  if (body.length > 2000) return res.status(400).json({ error: 'A comment is at most 2000 characters.' });
  // Pin to a layer/slide: free-form reference like "Layer: Title" or
  // "Slide 3" — stored verbatim and shown on the thread.
  const layerRef = req.body && req.body.layerRef !== undefined
    ? String(req.body.layerRef || '').trim().slice(0, 120)
    : null;
  const parentId = req.body && req.body.parentId ? Number(req.body.parentId) : null;
  try {
    const c = db.createProjectComment(req.user.id, p.id, { body, parentId });
    const mentioned = findMentionedUsers(body, req.user.id);
    const mentionJson = JSON.stringify(mentioned.map((u) => ({ id: u.id, name: u.name })));
    db.db.prepare('UPDATE project_comments SET layer_ref = ?, mentions = ? WHERE id = ?')
      .run(layerRef, mentionJson, c.id);
    // @mentions notify: an audit entry for the mentioned user shows up in
    // their bell (the same channel as every other notification).
    for (const u of mentioned) {
      db.audit(u.id, 'comment_mention', 'project', p.id,
        `${req.user.name} mentioned you in a comment on "${p.name}": ${body.slice(0, 120)}`);
    }
    db.audit(req.user.id, 'comment_added', 'project', p.id, `Comment on "${p.name}": ${body.slice(0, 80)}`);
    logActivity(p.id, req.user.id, 'comment_added',
      `${req.user.name} commented${layerRef ? ` on ${layerRef}` : ''}${mentioned.length ? ` (mentioned ${mentioned.map((u) => u.name).join(', ')})` : ''}: ${body.slice(0, 80)}`);
    const fresh = db.getProjectComment(c.id);
    res.status(201).json({ comment: { ...publicComment(fresh), mentions: mentioned.map((u) => ({ id: u.id, name: u.name })) } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/projects/:id/comments/:commentId/resolve', auth.requireAuth, (req, res) => {
  const p = loadViewableProject(req, res);
  if (!p) return;
  const c = db.getProjectComment(req.params.commentId);
  if (!c || c.project_id !== p.id) return res.status(404).json({ error: 'Comment not found on this project.' });
  const isOwner = p.user_id === req.user.id;
  const isAuthor = c.user_id === req.user.id;
  if (!isOwner && !isAuthor) return res.status(403).json({ error: 'Only the project owner or the comment author can resolve a thread.' });
  const resolved = req.body && req.body.resolved !== undefined ? Boolean(req.body.resolved) : c.status !== 'resolved';
  const out = db.resolveProjectComment(c.id, resolved);
  logActivity(p.id, req.user.id, resolved ? 'comment_resolved' : 'comment_reopened', `${req.user.name} ${resolved ? 'resolved' : 'reopened'} a comment thread`);
  res.json({ comment: { id: out.id, status: out.status } });
});

router.delete('/projects/:id/comments/:commentId', auth.requireAuth, (req, res) => {
  const p = loadViewableProject(req, res);
  if (!p) return;
  const c = db.getProjectComment(req.params.commentId);
  if (!c || c.project_id !== p.id) return res.status(404).json({ error: 'Comment not found on this project.' });
  const isOwner = p.user_id === req.user.id;
  const isAuthor = c.user_id === req.user.id;
  if (!isOwner && !isAuthor) return res.status(403).json({ error: 'Only the project owner or the comment author can delete a comment.' });
  db.deleteProjectComment(c.id);
  logActivity(p.id, req.user.id, 'comment_deleted', `${req.user.name} deleted a comment`);
  res.json({ ok: true });
});

// --- Per-project activity feed (v2.5.0) --------------------------------------
router.get('/projects/:id/activity', auth.requireAuth, (req, res) => {
  const p = loadViewableProject(req, res);
  if (!p) return;
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const rows = db.db.prepare(`SELECT a.*, u.name AS user_name
    FROM project_activity a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.project_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(p.id, limit);
  res.json({
    project: { id: p.id, name: p.name },
    activity: rows.map((r) => ({ id: r.id, action: r.action, detail: r.detail, userName: r.user_name || null, userId: r.user_id, createdAt: r.created_at })),
  });
});

// --- Public read-only link view (NO login) -----------------------------------
router.get('/shared/:token', (req, res) => {
  const share = db.getProjectShareByToken(String(req.params.token || ''));
  if (!share) return res.status(404).json({ error: 'This share link is invalid or has been revoked.' });
  const p = db.getProjectAny(share.project_id);
  if (!p || p.trashed) return res.status(404).json({ error: 'This share link is invalid or has been revoked.' });
  res.json({
    project: publicProject(p),
    sharedBy: null,
    note: 'Read-only share link. You can view this project, but not edit it — there is no live co-editing and no sign-in is needed to view.',
  });
});

module.exports = router;
