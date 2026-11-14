'use strict';
// AI Assistant routes (v2.2.4, Release D).
//   GET  /api/assistant/actions
//   POST /api/assistant/:action { projectId }
//
// Every action runs through the LLM abstraction: without a configured LLM
// key it refuses with 402 PROVIDER_KEY_NEEDED and creates nothing.
// Actions that change a project always create a NEW project — the
// original is never edited in place.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const credits = require('../credits');
const assistant = require('../assistant');

const router = express.Router();

function handleAssistantError(res, err) {
  const code = err && err.code;
  if (code === 'PROVIDER_KEY_NEEDED') return res.status(402).json({ error: err.message, code });
  if (code === 'INSUFFICIENT_CREDITS') return res.status(402).json({ error: err.message, code, needed: err.needed, balance: err.balance });
  return res.status(400).json({ error: String((err && err.message) || err).slice(0, 500) });
}

function creditGate(req, res, action, times = 1) {
  // Pre-flight balance check. For five-versions the cost is 5× ai_design;
  // checkCredits only covers a single action, so multiply manually.
  const user = db.getUserById(req.user.id);
  if (!user) { res.status(401).json({ error: 'User not found.' }); return false; }
  if (credits.isUnlimited(user)) return true;
  const cost = credits.costOf(action) * times;
  if (cost > 0 && user.credits_balance < cost) {
    res.status(402).json({
      error: `Not enough credits: needs ${cost}, balance is ${user.credits_balance}. Ask the OWNER for more credits or upgrade your plan.`,
      code: 'INSUFFICIENT_CREDITS', needed: cost, balance: user.credits_balance,
    });
    return false;
  }
  return true;
}

router.get('/actions', auth.requireAuth, (req, res) => {
  const status = require('../providers').providerStatus();
  const llm = status.filter((p) => p.kind === 'llm');
  res.json({
    actions: assistant.ASSISTANT_ACTIONS,
    llm: {
      configured: llm.some((p) => p.configured),
      active: llm.find((p) => p.active) ? llm.find((p) => p.active).id : null,
      providers: llm.map((p) => ({ id: p.id, label: p.label, configured: p.configured, active: p.active })),
    },
    note: 'The assistant needs an LLM key (free Gemini works — add it in Settings → AI Providers and set it active). Without one every action refuses with key_needed and creates nothing.',
  });
});

router.post('/:action', auth.requireAuth, async (req, res) => {
  const def = assistant.actionById(req.params.action);
  if (!def) return res.status(400).json({ error: `Unknown assistant action: ${req.params.action}. Available: ${assistant.ASSISTANT_ACTIONS.map((a) => a.id).join(', ')}.` });
  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' });
  const project = db.getProject(req.user.id, projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (!def.types.includes(project.type)) {
    return res.status(400).json({ error: `"${def.name}" supports ${def.types.join(', ')} projects (this one is ${project.type}).` });
  }
  const times = def.id === 'five-versions' ? 5 : 1;
  if (!creditGate(req, res, def.cost, times)) return;
  try {
    let out;
    if (def.id === 'summarise') out = await assistant.summarise(req.user.id, projectId);
    else if (def.id === 'suggest') out = await assistant.suggest(req.user.id, projectId);
    else if (def.id === 'make-professional') out = await assistant.makeProfessional(req.user.id, projectId);
    else if (def.id === 'five-versions') out = await assistant.fiveVersions(req.user.id, projectId);
    else throw new Error(`Assistant action not implemented: ${def.id}`);
    db.audit(req.user.id, 'assistant_' + def.id, 'project', projectId, `Assistant "${def.name}" on "${project.name}"`);
    res.json(out);
  } catch (err) {
    handleAssistantError(res, err);
  }
});

module.exports = router;
