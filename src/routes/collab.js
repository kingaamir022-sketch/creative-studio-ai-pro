'use strict';
// Collaboration routes (v2.2.4, Release D) — share + comments.
//
//   POST   /api/collab/projects/:id/link          — create/get read-only link (owner)
//   DELETE /api/collab/projects/:id/link          — revoke the link (owner)
//   GET    /api/collab/projects/:id/shares        — list shares (owner)
//   POST   /api/collab/projects/:id/share {email} — share with a user (owner)
//   DELETE /api/collab/projects/:id/shares/:shareId — remove a share (owner)
//   GET    /api/collab/shared-with-me            — projects shared with me
//   GET    /api/collab/shared-with-me/:projectId — read-only view (shared user)
//   POST   /api/collab/shared-with-me/:projectId/leave — remove my own share
//   GET    /api/collab/projects/:id/comments     — list threads (owner/shared)
//   POST   /api/collab/projects/:id/comments     — add comment/reply (owner/shared)
//   POST   /api/collab/projects/:id/comments/:commentId/resolve — resolve/reopen
//   DELETE /api/collab/projects/:id/comments/:commentId — delete (owner/author)
//   GET    /api/collab/shared/:token             — PUBLIC read-only view (no login)
//
// Shares are READ-ONLY by design (permission is always 'view'). There is
// NO live co-editing: a shared user can view the project and comment, but
// never edit it — the UI and the docs say so. The public link view returns
// the project name/type/content only — no owner details, no user list.
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

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

// --- Read-only link ----------------------------------------------------------
router.post('/projects/:id/link', auth.requireAuth, (req, res) => {
  const p = loadOwnedProject(req, res);
  if (!p) return;
  const existing = db.getProjectLinkShare(p.id);
  if (existing) return res.json({ link: { token: existing.token, url: `/api/collab/shared/${existing.token}`, createdAt: existing.created_at }, alreadyExists: true });
  const token = crypto.randomBytes(24).toString('hex');
  const share = db.createProjectShare(req.user.id, p.id, { token });
  db.audit(req.user.id, 'share_link_created', 'project', p.id, `Created a read-only share link for "${p.name}"`);
  res.status(201).json({ link: { token: share.token, url: `/api/collab/shared/${share.token}`, createdAt: share.created_at }, alreadyExists: false });
});

router.delete('/projects/:id/link', auth.requireAuth, (req, res) => {
  const p = loadOwnedProject(req, res);
  if (!p) return;
  const existing = db.getProjectLinkShare(p.id);
  if (!existing) return res.status(404).json({ error: 'This project has no share link.' });
  db.deleteProjectShare(existing.id);
  db.audit(req.user.id, 'share_link_revoked', 'project', p.id, `Revoked the read-only share link for "${p.name}"`);
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
    permission: s.permission,
    token: s.token ? s.token.slice(0, 8) + '…' : null,
    createdAt: s.created_at,
  }));
  res.json({ project: { id: p.id, name: p.name }, shares, note: 'Shares are read-only. There is no live co-editing — shared users can view and comment, never edit.' });
});

router.post('/projects/:id/share', auth.requireAuth, (req, res) => {
  const p = loadOwnedProject(req, res);
  if (!p) return;
  const email = String((req.body && req.body.email) || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid email address is required.' });
  const target = db.getUserByEmail(email);
  if (!target) return res.status(404).json({ error: `No user with email "${email}" exists on this install — shares only work between users of this install.` });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You already own this project — it cannot be shared with yourself.' });
  const share = db.createProjectShare(req.user.id, p.id, { sharedWithUserId: target.id });
  db.audit(req.user.id, 'share_user', 'project', p.id, `Shared "${p.name}" read-only with ${target.email}${share.alreadyShared ? ' (already shared)' : ''}`);
  res.status(share.alreadyShared ? 200 : 201).json({
    share: { id: share.id, sharedWithUserId: target.id, sharedWithName: target.name, sharedWithEmail: target.email, permission: 'view', createdAt: share.created_at },
    alreadyShared: Boolean(share.alreadyShared),
    note: share.alreadyShared ? 'This project was already shared with that user — no duplicate share was created.' : 'Shared read-only. The user can view and comment, never edit.',
  });
});

router.delete('/projects/:id/shares/:shareId', auth.requireAuth, (req, res) => {
  const p = loadOwnedProject(req, res);
  if (!p) return;
  const share = db.getProjectShare(req.params.shareId);
  if (!share || share.project_id !== p.id) return res.status(404).json({ error: 'Share not found on this project.' });
  db.deleteProjectShare(share.id);
  db.audit(req.user.id, 'share_removed', 'project', p.id, `Removed a share from "${p.name}"`);
  res.json({ ok: true });
});

// --- Shared with me ----------------------------------------------------------
router.get('/shared-with-me', auth.requireAuth, (req, res) => {
  const rows = db.listSharedWithMe(req.user.id);
  res.json({
    projects: rows.map((r) => ({
      id: r.id, name: r.name, type: r.type, shareId: r.share_id, sharedAt: r.shared_at,
      ownerName: r.owner_name, ownerEmail: r.owner_email, updatedAt: r.updated_at,
    })),
    note: 'Projects shared with you are read-only — you can view and comment, never edit. There is no live co-editing.',
  });
});

router.get('/shared-with-me/:projectId', auth.requireAuth, (req, res) => {
  const p = db.getProjectAny(req.params.projectId);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  const share = db.getProjectShareForUser(p.id, req.user.id);
  if (!share && p.user_id !== req.user.id) return res.status(403).json({ error: 'This project has not been shared with you.' });
  res.json({ project: publicProject(p), shared: Boolean(share) });
});

router.post('/shared-with-me/:projectId/leave', auth.requireAuth, (req, res) => {
  const share = db.getProjectShareForUser(req.params.projectId, req.user.id);
  if (!share) return res.status(404).json({ error: 'You do not have a share on this project.' });
  db.deleteProjectShare(share.id);
  res.json({ ok: true });
});

// --- Comments ----------------------------------------------------------------
router.get('/projects/:id/comments', auth.requireAuth, (req, res) => {
  const p = loadViewableProject(req, res);
  if (!p) return;
  const rows = db.listProjectComments(p.id);
  const byId = new Map(rows.map((r) => [r.id, { ...r, replies: [] }]));
  const threads = [];
  for (const r of rows) {
    if (r.parent_id && byId.get(r.parent_id)) byId.get(r.parent_id).replies.push(byId.get(r.id));
    else if (!r.parent_id) threads.push(byId.get(r.id));
  }
  res.json({
    project: { id: p.id, name: p.name },
    comments: threads.map((t) => ({
      id: t.id, body: t.body, status: t.status, authorName: t.author_name, authorId: t.user_id,
      createdAt: t.created_at, updatedAt: t.updated_at,
      replies: t.replies.map((x) => ({ id: x.id, body: x.body, status: x.status, authorName: x.author_name, authorId: x.user_id, createdAt: x.created_at })),
    })),
  });
});

router.post('/projects/:id/comments', auth.requireAuth, (req, res) => {
  const p = loadViewableProject(req, res);
  if (!p) return;
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'A comment needs some text.' });
  if (body.length > 2000) return res.status(400).json({ error: 'A comment is at most 2000 characters.' });
  const parentId = req.body && req.body.parentId ? Number(req.body.parentId) : null;
  try {
    const c = db.createProjectComment(req.user.id, p.id, { body, parentId });
    db.audit(req.user.id, 'comment_added', 'project', p.id, `Comment on "${p.name}": ${body.slice(0, 80)}`);
    res.status(201).json({ comment: { id: c.id, body: c.body, status: c.status, authorName: c.author_name, authorId: c.user_id, createdAt: c.created_at } });
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
  res.json({ ok: true });
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
