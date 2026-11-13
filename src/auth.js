'use strict';
// Authentication: scrypt password hashing, opaque session tokens in an
// httpOnly cookie, RBAC roles OWNER / ADMIN / USER.
// First account on an empty system becomes OWNER; later signups are USER.
const crypto = require('crypto');
const db = require('./db');

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [, saltHex, hashHex] = stored.split(':');
    const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

function createSessionFor(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  db.createSession(token, userId, expires);
  return token;
}

function sessionCookieOptions() {
  return { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000 };
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, plan: u.plan, creditsBalance: u.credits_balance, createdAt: u.created_at };
}

// Middleware: attach req.user when a valid session cookie is present.
// Phase 8: a suspended user's session is dead immediately — req.user is
// null even with a still-valid cookie (suspend also deletes sessions).
function authMiddleware(req, res, next) {
  const token = req.cookies && req.cookies.cs_session;
  if (!token) { req.user = null; return next(); }
  const session = db.getSession(token);
  if (!session) { req.user = null; return next(); }
  const user = db.getUserById(session.user_id) || null;
  req.user = user && user.suspended ? null : user;
  req.sessionToken = token;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in. Please log in.' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `This action requires role: ${roles.join(' or ')}.` });
    }
    next();
  };
}

module.exports = { hashPassword, verifyPassword, createSessionFor, sessionCookieOptions, publicUser, authMiddleware, requireAuth, requireRole };
