'use strict';
// Credit ledger (Phase 8).
//
// Every paid action in the app costs a small, fixed number of credits.
// Charges are a single SQLite transaction: balance check + deduct + usage
// log entry happen atomically, so two concurrent charges can never drive a
// balance below zero. Enterprise and Lifetime plans are unlimited (no
// deduction, the usage is still logged with 0 credits) — and the OWNER role
// is always unlimited too, even if the stored plan field says otherwise
// (belt and braces: the owner can never be locked out of their own app).
//
// Costs are deliberately small: a Free account starts with 100 credits,
// and a full test suite run stays far below that per user.
const db = require('./db');

const CREDIT_COSTS = {
  ai_image: 2,
  ai_image_edit: 2,
  ai_video: 5,
  ai_video_image: 5,
  ai_voice: 1,
  ai_quiz: 1,
  ai_design: 2,
  ai_transcribe: 2,
  ai_music_mood: 1,
  ai_music: 5,
  render: 1,
  bulk_row: 1,
  social_caption: 1,
  social_post: 0,
};

// AI job mode -> credit action (same keys as CREDIT_COSTS).
const AI_MODE_COSTS = {
  image: 'ai_image',
  'image-edit': 'ai_image_edit',
  video: 'ai_video',
  'video-image': 'ai_video_image',
  voice: 'ai_voice',
  quiz: 'ai_quiz',
  design: 'ai_design',
  transcribe: 'ai_transcribe',
  'music-mood': 'ai_music_mood',
  'music-generate': 'ai_music',
};

function costOf(action) {
  return CREDIT_COSTS[action] ?? 0;
}

function isUnlimited(user) {
  return !!user && (user.plan === 'Enterprise' || user.plan === 'Lifetime' || user.role === 'OWNER');
}

// Balance check only — no deduction. Used as a pre-flight gate at job
// creation so a user is told up front instead of after the work is done.
function checkCredits(userId, action) {
  const user = db.getUserById(userId);
  if (!user) return { ok: false, code: 'USER_NOT_FOUND', error: 'User not found.' };
  const cost = costOf(action);
  if (isUnlimited(user) || cost === 0) return { ok: true, cost, balance: user.credits_balance };
  if (user.credits_balance < cost) {
    return {
      ok: false, code: 'INSUFFICIENT_CREDITS',
      error: `Not enough credits for ${action}: needs ${cost}, balance is ${user.credits_balance}. Ask the OWNER for more credits or upgrade your plan.`,
      needed: cost, balance: user.credits_balance,
    };
  }
  return { ok: true, cost, balance: user.credits_balance };
}

// Deduct `cost` credits for `action` (atomic). Returns { ok } or
// { ok:false, code:'INSUFFICIENT_CREDITS', ... }. On success the usage log
// gets a negative-credits entry, so the ledger is always auditable.
function chargeCredits(userId, action, detail) {
  const cost = costOf(action);
  const user = db.getUserById(userId);
  if (!user) return { ok: false, code: 'USER_NOT_FOUND', error: 'User not found.' };
  if (isUnlimited(user) || cost === 0) {
    db.logUsage(userId, action, 0, detail || '');
    return { ok: true, charged: 0, balance: user.credits_balance };
  }
  const res = db.db.transaction(() => {
    const cur = db.getUserById(userId);
    if (cur.credits_balance < cost) {
      return {
        ok: false, code: 'INSUFFICIENT_CREDITS',
        error: `Not enough credits for ${action}: needs ${cost}, balance is ${cur.credits_balance}.`,
        needed: cost, balance: cur.credits_balance,
      };
    }
    db.db.prepare("UPDATE users SET credits_balance = credits_balance - ?, updated_at = datetime('now') WHERE id = ?")
      .run(cost, userId);
    db.logUsage(userId, action, -cost, detail || '');
    const after = db.getUserById(userId);
    return { ok: true, charged: cost, balance: after.credits_balance };
  })();
  return res;
}

// Add credits (admin reset / plan approval). `amount` must be positive.
function grantCredits(userId, amount, detail) {
  const user = db.getUserById(userId);
  if (!user) return { ok: false, error: 'User not found.' };
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: 'Amount must be a positive number of credits.' };
  db.db.transaction(() => {
    db.db.prepare("UPDATE users SET credits_balance = credits_balance + ?, updated_at = datetime('now') WHERE id = ?")
      .run(amount, userId);
    db.logUsage(userId, 'credit_grant', amount, detail || '');
  })();
  return { ok: true, balance: db.getUserById(userId).credits_balance };
}

module.exports = { CREDIT_COSTS, AI_MODE_COSTS, costOf, checkCredits, chargeCredits, grantCredits, isUnlimited };
