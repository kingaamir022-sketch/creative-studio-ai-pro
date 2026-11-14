'use strict';
// Auth routes: signup, login, logout, me, change password.
const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();
const PLANS = require('./plans');
const { isOwnerEmail } = require('../ownerEmails');

function validEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()); }

router.post('/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'A valid email address is required.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.getUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists.' });

  const isFirst = db.countUsers() === 0;
  // v2.6.1 — Multi-Owner: an allowlisted OWNER_EMAILS address is OWNER
  // (Lifetime Free) even when it is not the first account.
  const isAllowlistedOwner = isOwnerEmail(email);
  const role = (isFirst || isAllowlistedOwner) ? 'OWNER' : 'USER';
  // v2.2.0 — OWNER Lifetime Free: the first account (OWNER) is lifetime-free
  // with everything unlimited; later signups stay on Free (100 credits).
  // Lifetime has no finite credit allowance (credits null), so the stored
  // balance is 0 — the ledger balance is never drawn from for unlimited
  // users (see credits.js isUnlimited).
  const plan = (isFirst || isAllowlistedOwner) ? 'Lifetime' : 'Free';
  const credits = PLANS[plan].credits ?? 0;
  const user = db.createUser({
    name: name.trim(), email: email.trim().toLowerCase(),
    passwordHash: auth.hashPassword(password), role, plan, credits,
  });
  db.audit(user.id, 'signup', 'user', user.id, `Account created as ${role}`);
  const token = auth.createSessionFor(user.id);
  res.cookie('cs_session', token, auth.sessionCookieOptions());
  res.status(201).json({ user: auth.publicUser(user), firstAccount: isFirst });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!validEmail(email) || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = db.getUserByEmail(email);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  // Phase 8: suspended accounts cannot sign in.
  if (user.suspended) {
    return res.status(403).json({ error: 'This account is suspended. Contact the OWNER to restore access.' });
  }
  // v2.6.1 — Multi-Owner: an allowlisted OWNER_EMAILS address that signed
  // up before the allowlist (or was demoted) is promoted to OWNER + Lifetime
  // on login.
  let loginUser = user;
  if (isOwnerEmail(user.email) && user.role !== 'OWNER') {
    loginUser = db.updateUser(user.id, { role: 'OWNER', plan: 'Lifetime' });
    db.audit(user.id, 'owner_promoted', 'user', user.id, 'Promoted to OWNER via OWNER_EMAILS allowlist');
  }
  const token = auth.createSessionFor(user.id);
  res.cookie('cs_session', token, auth.sessionCookieOptions());
  db.audit(user.id, 'login', 'user', user.id, 'Signed in');
  res.json({ user: auth.publicUser(loginUser) });
});

router.post('/logout', auth.requireAuth, (req, res) => {
  if (req.sessionToken) db.deleteSession(req.sessionToken);
  res.clearCookie('cs_session', { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: auth.publicUser(req.user) });
});

router.post('/change-password', auth.requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required.' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  if (!auth.verifyPassword(currentPassword, req.user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  db.setPassword(req.user.id, auth.hashPassword(newPassword));
  db.audit(req.user.id, 'change_password', 'user', req.user.id, 'Password changed');
  res.json({ ok: true });
});

module.exports = router;
