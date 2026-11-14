'use strict';
// Multi-OWNER allowlist (v2.6.1, user-requested 2026-11-14): these three
// Gmail accounts are OWNER on any installation, not just the first account
// created. Signup grants OWNER + Lifetime to any of them; login promotes an
// existing non-OWNER account with one of these emails to OWNER.
// Env override OWNER_EMAILS (comma-separated) replaces the list when set.
const OWNER_EMAILS = process.env.OWNER_EMAILS
  ? process.env.OWNER_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  : ['kingaamir022@gmail.com', 'josnking01@gmail.com', 'a030210523@gmail.com'];

function isOwnerEmail(email) {
  if (typeof email !== 'string') return false;
  return OWNER_EMAILS.includes(email.trim().toLowerCase());
}

module.exports = { OWNER_EMAILS, isOwnerEmail };
