'use strict';
// Subscription plans — single source of truth used by signup, settings and the
// Subscription view. Credits are tracked in the DB; nothing is charged here
// (billing integration is Phase 8).
const PLANS = {
  Free: {
    name: 'Free', price: 0, credits: 100, storageMB: 1024, maxProjects: 10,
    maxExportsPerMonth: 10, features: ['10 projects', '1 GB storage', '100 AI credits / month', '720p exports', 'Community templates'],
  },
  Starter: {
    name: 'Starter', price: 9, credits: 1000, storageMB: 10240, maxProjects: 100,
    maxExportsPerMonth: 100, features: ['100 projects', '10 GB storage', '1,000 AI credits / month', '1080p exports', 'Bulk Design Studio'],
  },
  Pro: {
    name: 'Pro', price: 29, credits: 5000, storageMB: 102400, maxProjects: 1000,
    maxExportsPerMonth: 1000, features: ['1,000 projects', '100 GB storage', '5,000 AI credits / month', '4K exports', 'Bulk Video Studio', 'AI Music Sync'],
  },
  Business: {
    name: 'Business', price: 79, credits: 20000, storageMB: 512000, maxProjects: 10000,
    maxExportsPerMonth: 10000, features: ['Unlimited-ish projects', '500 GB storage', '20,000 AI credits / month', 'Team seats (5)', 'Priority rendering'],
  },
  Enterprise: {
    name: 'Enterprise', price: null, credits: null, storageMB: null, maxProjects: null,
    maxExportsPerMonth: null, features: ['Unlimited everything', 'Custom storage', 'Unlimited credits', 'SSO & audit', 'Dedicated support'],
  },
  // v2.2.0 — OWNER Lifetime Free: the OWNER account is lifetime-free with
  // everything unlimited, forever. Never requestable by regular users
  // (billing.js refuses Lifetime requests) and granted to the first
  // account at signup + to existing OWNERs by the boot migration in db.js.
  Lifetime: {
    name: 'Lifetime', price: 0, credits: null, storageMB: null, maxProjects: null,
    maxExportsPerMonth: null, features: ['Lifetime free for the OWNER', 'Unlimited everything, forever', 'Unlimited credits', 'Unlimited projects & storage', 'No expiry, no renewal'],
  },
};

module.exports = PLANS;
