'use strict';
// Billing & credits (Phase 8): real bookkeeping, honest payments.
//
// - Plans: Free / Starter / Pro / Business / Enterprise / Lifetime
//   (defined in src/routes/plans.js) with credit allowances. Lifetime is
//   the OWNER-only lifetime-free plan (everything unlimited) and can never
//   be requested by a regular user.
// - Credit ledger: every charge writes a usage_log entry (negative
//   credits) and grants a positive entry, so the balance is always
//   auditable. Balance and full history are visible to the user.
// - NO payment gateway exists in this build. Upgrading is a REQUEST:
//   the user asks, the OWNER approves in Admin, and only then does the
//   plan + credits change. The UI says plainly: no payment is taken in
//   this build.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const PLANS = require('./plans');
const { CREDIT_COSTS } = require('../credits');

const router = express.Router();

router.get('/plans', auth.requireAuth, (req, res) => {
  res.json({
    plans: Object.entries(PLANS).map(([id, p]) => ({
      id, name: p.name, price: p.price, credits: p.credits,
      storageMB: p.storageMB, maxProjects: p.maxProjects, features: p.features,
    })),
    yourPlan: req.user.plan,
    yourCredits: req.user.credits_balance,
    paymentNote: 'No payment is taken in this build. To upgrade, request a plan below — the OWNER approves it in Admin and the plan changes then. No card, no checkout.',
  });
});

router.get('/balance', auth.requireAuth, (req, res) => {
  const user = db.getUserById(req.user.id);
  res.json({
    plan: user.plan, creditsBalance: user.credits_balance,
    planCredits: PLANS[user.plan] ? PLANS[user.plan].credits : null,
    costs: CREDIT_COSTS,
  });
});

router.get('/history', auth.requireAuth, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
  const rows = db.listUsage(req.user.id, limit);
  res.json({
    history: rows.map((r) => ({
      id: r.id, action: r.action, credits: r.credits, detail: r.detail, createdAt: r.created_at,
    })),
  });
});

// Request a plan upgrade/downgrade. One open request per user per plan.
// The Lifetime plan is reserved for the OWNER account and can never be
// requested — regular users asking for it are refused up front.
router.post('/requests', auth.requireAuth, (req, res) => {
  const { plan } = req.body || {};
  if (!PLANS[plan]) return res.status(400).json({ error: `Unknown plan. Available: ${Object.keys(PLANS).join(', ')}.` });
  if (plan === 'Lifetime' && req.user.role !== 'OWNER') return res.status(400).json({ error: 'The Lifetime plan is reserved for the OWNER account — it cannot be requested. Regular accounts stay on Free unless the OWNER approves another plan.' });
  if (plan === req.user.plan) return res.status(400).json({ error: `You are already on the ${plan} plan.` });
  const open = db.listPlanRequests({ status: 'pending', userId: req.user.id }).find((r) => r.plan === plan);
  if (open) return res.status(400).json({ error: `You already have a pending request for the ${plan} plan.` });
  const r = db.createPlanRequest(req.user.id, { plan });
  db.audit(req.user.id, 'plan_request_created', 'plan_request', r.id, `Requested the ${plan} plan (no payment taken)`);
  res.status(201).json({
    request: {
      id: r.id, plan: r.plan, status: r.status, createdAt: r.created_at,
      note: 'No payment is taken in this build. The OWNER reviews this request in Admin.',
    },
  });
});

router.get('/requests', auth.requireAuth, (req, res) => {
  const mine = db.listPlanRequests({ userId: req.user.id });
  res.json({
    requests: mine.map((r) => ({
      id: r.id, plan: r.plan, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at,
    })),
  });
});

// OWNER/ADMIN: list all requests, approve / reject.
// Approving sets the plan and tops the credits up to the plan's
// allowance (never below the current balance).
router.get('/admin/requests', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  res.json({
    requests: db.listPlanRequests({ status: req.query.status || undefined }).map((r) => {
      const u = db.getUserById(r.user_id);
      return {
        id: r.id, plan: r.plan, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at,
        user: u ? { id: u.id, name: u.name, email: u.email, plan: u.plan, creditsBalance: u.credits_balance } : { id: r.user_id },
      };
    }),
  });
});

router.post('/admin/requests/:id/approve', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  const r = db.getPlanRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (r.status !== 'pending') return res.status(400).json({ error: `This request was already ${r.status}.` });
  const user = db.getUserById(r.user_id);
  if (!user) return res.status(404).json({ error: 'The requesting user no longer exists.' });
  // The Lifetime plan is reserved for the OWNER account — approving it for
  // anyone else is refused even if such a request somehow exists.
  if (r.plan === 'Lifetime' && user.role !== 'OWNER') {
    return res.status(400).json({ error: 'The Lifetime plan is reserved for the OWNER account and cannot be approved for this user.' });
  }
  const plan = PLANS[r.plan];
  const newBalance = Math.max(user.credits_balance, plan.credits);
  db.db.transaction(() => {
    db.updateUser(user.id, { plan: r.plan, credits_balance: newBalance });
    if (newBalance > user.credits_balance) db.logUsage(user.id, 'credit_grant', newBalance - user.credits_balance, `Plan approved: ${r.plan} (top-up to plan allowance)`);
    db.updatePlanRequest(r.id, { status: 'approved', decidedBy: req.user.id });
  })();
  db.audit(req.user.id, 'plan_request_approved', 'plan_request', r.id, `Approved ${r.plan} plan for ${user.email} (no payment taken)`);
  res.json({ ok: true, user: { id: user.id, email: user.email, plan: r.plan, creditsBalance: newBalance } });
});

router.post('/admin/requests/:id/reject', auth.requireAuth, auth.requireRole('OWNER', 'ADMIN'), (req, res) => {
  const r = db.getPlanRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (r.status !== 'pending') return res.status(400).json({ error: `This request was already ${r.status}.` });
  db.updatePlanRequest(r.id, { status: 'rejected', decidedBy: req.user.id });
  db.audit(req.user.id, 'plan_request_rejected', 'plan_request', r.id, `Rejected ${r.plan} plan request for user ${r.user_id}`);
  res.json({ ok: true });
});

module.exports = router;
