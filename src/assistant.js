'use strict';
// AI Assistant (v2.2.4, Release D) — project-aware help through the LLM
// abstraction (chatJson). Without an LLM key every action refuses
// PROVIDER_KEY_NEEDED honestly and creates nothing.
//
// Actions:
//   summarise        — any project type: short summary + key points.
//   suggest          — any project type: prioritised improvement ideas.
//   make-professional— design + deck: rewrite the copy/palette into a
//                      NEW project (the original is never touched).
//   five-versions    — design only: five headline/palette variants as
//                      five NEW projects.
//
// Destructive edits never happen in place: every action that changes a
// project creates a new one and returns a preview (the new project id +
// what changed), so the user reviews before using it.
const db = require('./db');
const ai = require('./ai');
const credits = require('./credits');
const { validateDesign } = require('./design-model');
const { reflowDesign } = require('./magic-resize');
const ds = require('./docs-slides');

const ASSISTANT_ACTIONS = [
  { id: 'summarise', name: 'Summarise this project', types: ['design', 'video', 'deck', 'doc', 'bulk', 'shorts', 'social'], cost: 'ai_write', description: 'A short summary, key points, audience and tone.' },
  { id: 'suggest', name: 'Suggest improvements', types: ['design', 'video', 'deck', 'doc', 'bulk', 'shorts', 'social'], cost: 'ai_write', description: 'Prioritised, specific suggestions — nothing is changed.' },
  { id: 'make-professional', name: 'Make this more professional', types: ['design', 'deck'], cost: 'ai_design', description: 'Rewrites the copy and palette into a NEW project. The original is never touched.' },
  { id: 'five-versions', name: 'Create five versions', types: ['design'], cost: 'ai_design', description: 'Five headline/palette variants as five NEW projects.' },
];

function actionById(id) {
  return ASSISTANT_ACTIONS.find((a) => a.id === id) || null;
}

// A compact, honest digest of a project for the LLM: real content only
// (names, counts, actual text), truncated so the prompt stays small.
function projectDigest(project) {
  let content = {};
  try { content = JSON.parse(project.content || '{}'); } catch { content = {}; }
  const texts = [];
  const pushText = (t) => {
    const s = String(t || '').trim();
    if (s) texts.push(s);
  };
  let stats = {};
  if (project.type === 'design') {
    const layers = Array.isArray(content.layers) ? content.layers : [];
    stats = { width: content.width, height: content.height, layers: layers.length, textLayers: layers.filter((l) => l.type === 'text').length };
    layers.filter((l) => l.type === 'text').slice(0, 20).forEach((l) => pushText(l.text && l.text.text));
  } else if (project.type === 'deck') {
    const slides = Array.isArray(content.slides) ? content.slides : [];
    stats = { title: content.title, slides: slides.length };
    slides.forEach((s, i) => {
      (s.elements || []).filter((e) => e.type === 'text').forEach((e) => pushText(`[slide ${i + 1} ${s.layout}] ${e.text && e.text.text}`));
    });
  } else if (project.type === 'video') {
    const tracks = Array.isArray(content.tracks) ? content.tracks : [];
    const clips = tracks.flatMap((t) => t.clips || []);
    stats = { width: content.width, height: content.height, fps: content.fps, tracks: tracks.length, clips: clips.length };
    clips.filter((c) => c.kind === 'text').slice(0, 20).forEach((c) => pushText(c.text && c.text.text));
  } else if (project.type === 'doc') {
    const blocks = Array.isArray(content.blocks) ? content.blocks : [];
    stats = { title: content.title, blocks: blocks.length };
    blocks.slice(0, 20).forEach((b) => { pushText(b.text); if (Array.isArray(b.items)) b.items.forEach(pushText); });
  } else {
    stats = { keys: Object.keys(content).slice(0, 10) };
  }
  const joined = texts.join(' | ').slice(0, 3000);
  return { name: project.name, type: project.type, stats, texts: joined };
}

function loadProject(userId, projectId) {
  const project = db.getProject(userId, projectId);
  if (!project) throw new Error('Project not found.');
  return project;
}

function chargeOrThrow(userId, action, detail) {
  const r = credits.chargeCredits(userId, action, detail);
  if (!r.ok) throw new Error(r.error || 'Not enough credits.');
  return r;
}

async function summarise(userId, projectId, signal) {
  const project = loadProject(userId, projectId);
  const digest = projectDigest(project);
  const out = await ai.chatJson(userId, {
    system: 'You are a helpful creative assistant. Reply with valid JSON only, no other text.',
    user: `Summarise this ${digest.type} project named "${digest.name}". Stats: ${JSON.stringify(digest.stats)}. Text content: ${digest.texts || '(no text)'}. Reply as a JSON object {"summary":"2-3 sentences, plain and specific","keyPoints":["up to 5 short bullet points"],"audience":"who this is for, one short phrase","tone":"one or two words"}. Rules: only describe what is actually in the project — never invent features, numbers or claims that are not there.`,
  }, signal);
  const summary = String(out.summary || '').trim();
  if (!summary) throw new Error('The LLM returned no summary.');
  chargeOrThrow(userId, 'ai_write', `Assistant summarised project ${project.id} ("${project.name}")`);
  return {
    action: 'summarise', project: { id: project.id, name: project.name, type: project.type },
    summary,
    keyPoints: Array.isArray(out.keyPoints) ? out.keyPoints.slice(0, 5).map((x) => String(x).slice(0, 200)) : [],
    audience: String(out.audience || '').slice(0, 120),
    tone: String(out.tone || '').slice(0, 60),
    stats: digest.stats,
  };
}

async function suggest(userId, projectId, signal) {
  const project = loadProject(userId, projectId);
  const digest = projectDigest(project);
  const out = await ai.chatJson(userId, {
    system: 'You are a senior designer and video editor giving a critique. Reply with valid JSON only, no other text.',
    user: `Suggest improvements for this ${digest.type} project named "${digest.name}". Stats: ${JSON.stringify(digest.stats)}. Text content: ${digest.texts || '(no text)'}. Reply as a JSON object {"suggestions":[{"area":"layout|typography|colour|copy|structure|other","suggestion":"one specific, actionable sentence","priority":"high|medium|low"}]} with 3-6 suggestions. Rules: every suggestion must refer to something actually in the project; never invent missing content as if it existed; nothing is changed by this action — suggestions only.`,
  }, signal);
  const suggestions = Array.isArray(out.suggestions) ? out.suggestions : [];
  if (!suggestions.length) throw new Error('The LLM returned no suggestions.');
  const clean = suggestions.slice(0, 6).map((s) => ({
    area: String(s.area || 'other').slice(0, 30),
    suggestion: String(s.suggestion || '').trim().slice(0, 300),
    priority: ['high', 'medium', 'low'].includes(s.priority) ? s.priority : 'medium',
  })).filter((s) => s.suggestion);
  if (!clean.length) throw new Error('The LLM returned no usable suggestions.');
  chargeOrThrow(userId, 'ai_write', `Assistant suggested improvements for project ${project.id} ("${project.name}")`);
  return { action: 'suggest', project: { id: project.id, name: project.name, type: project.type }, suggestions: clean };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
function cleanPalette(pal) {
  const p = pal || {};
  return {
    primary: HEX.test(p.primary || '') ? p.primary : '#7c5cff',
    secondary: HEX.test(p.secondary || '') ? p.secondary : '#22d3ee',
    accent: HEX.test(p.accent || '') ? p.accent : '#3b82f6',
  };
}
function buildProfessionalDesign(sourceContent, s) {
  const suggestions = {
    headline: String(s.headline || 'Your headline here').slice(0, 80),
    subheading: String(s.subheading || 'Made with CreativeStudio AI Pro').slice(0, 140),
    cta: String(s.cta || 'LEARN MORE').slice(0, 24),
    palette: cleanPalette(s.palette),
    fonts: s.fonts || {},
  };
  const design = ai.buildDesignFromSuggestions(suggestions, 'professional');
  // buildDesignFromSuggestions always builds 1080×1080; reflow to the
  // source canvas size so the format never changes silently.
  if (sourceContent.width !== 1080 || sourceContent.height !== 1080) {
    return reflowDesign(design, sourceContent.width, sourceContent.height).design;
  }
  return design;
}

async function makeProfessional(userId, projectId, signal) {
  const project = loadProject(userId, projectId);
  const digest = projectDigest(project);
  if (project.type === 'design') {
    let content = {};
    try { content = JSON.parse(project.content || '{}'); } catch { content = {}; }
    const v = validateDesign(content);
    if (!v.ok) throw new Error('Invalid design: ' + v.errors.join(' '));
    const out = await ai.chatJson(userId, {
      system: 'You are a professional graphic designer. Reply with valid JSON only, no other text.',
      user: `Make this design more professional. Current design "${digest.name}" (${digest.stats.width}×${digest.stats.height}), current text: ${digest.texts || '(no text)'}. Reply as a JSON object {"headline":"short bold headline, max 8 words","subheading":"one supporting line, max 16 words","palette":{"primary":"#RRGGBB","secondary":"#RRGGBB","accent":"#RRGGBB"},"fonts":{"heading":"one of Poppins, Inter, Montserrat, Playfair Display, Roboto, Oswald, Lato, Raleway, Bebas Neue, Dancing Script","body":"one of the same list"},"cta":"short button text, max 2 words"}. Rules: keep the meaning of the original copy, tighten it, do not invent new claims, prices or dates.`,
    }, signal);
    if (!out.headline || typeof out.headline !== 'string') throw new Error('The LLM returned no professional rewrite.');
    const design = buildProfessionalDesign(content, out);
    const created = db.createProject(userId, { name: `${project.name} (professional)`.slice(0, 200), type: 'design', content: design });
    chargeOrThrow(userId, 'ai_design', `Assistant made a professional version of project ${project.id} → ${created.id}`);
    return {
      action: 'make-professional', project: { id: project.id, name: project.name, type: project.type },
      newProject: { id: created.id, name: created.name, type: created.type },
      preview: { headline: out.headline, subheading: out.subheading || '', palette: cleanPalette(out.palette) },
      note: 'A NEW project was created — the original was not changed. Open the new project to review it.',
    };
  }
  if (project.type === 'deck') {
    let deck = {};
    try { deck = JSON.parse(project.content || '{}'); } catch { deck = {}; }
    const check = ds.validateDeck(deck);
    if (!check.ok) throw new Error('Invalid deck: ' + check.errors.join(' '));
    const out = await ai.chatJson(userId, {
      system: 'You are a professional presentation designer. Reply with valid JSON only, no other text.',
      user: `Make this deck more professional. Deck "${digest.title || digest.name}", ${digest.stats.slides} slides. Slide text: ${digest.texts || '(no text)'}. Reply as a JSON object {"slides":[{"heading":"slide title, max 10 words","bullets":["up to 5 short bullets, each max 12 words"]}]} with exactly one entry per slide, in order. Rules: keep the meaning and facts, tighten the wording, do not invent new claims or numbers; quiz slides are left unchanged by the app, so for a quiz slide return its current heading and bullets unchanged.`,
    }, signal);
    const rewrites = Array.isArray(out.slides) ? out.slides : [];
    if (rewrites.length !== deck.slides.length) {
      throw new Error(`The LLM returned ${rewrites.length} slide rewrites for ${deck.slides.length} slides — nothing was created. Try again.`);
    }
    const next = JSON.parse(JSON.stringify(deck));
    next.slides.forEach((slide, i) => {
      if (slide.layout === 'quiz' || slide.layout === 'chart') return; // kept unchanged
      const rw = rewrites[i] || {};
      const byRole = (role) => (slide.elements || []).find((e) => e.type === 'text' && e.role === role);
      const title = byRole('title');
      if (title && typeof rw.heading === 'string' && rw.heading.trim()) title.text.text = String(rw.heading).trim().slice(0, 120);
      const body = byRole('body');
      if (body && Array.isArray(rw.bullets)) {
        body.text.text = rw.bullets.slice(0, 5).map((b) => `•  ${String(b).slice(0, 140)}`).join('\n');
      }
      const sub = byRole('subtitle');
      if (sub && Array.isArray(rw.bullets) && rw.bullets[0]) sub.text.text = String(rw.bullets[0]).slice(0, 120);
    });
    const fit = ds.deckFitCheck(next);
    if (!fit.ok) throw new Error('Professional deck is invalid: ' + fit.errors.join(' '));
    let finalDeck = next;
    if (fit.needsAttention.length) {
      for (const n of fit.needsAttention) {
        for (const s of finalDeck.slides) {
          const el = (s.elements || []).find((e) => e.id === n.layerId);
          if (!el || el.type !== 'text') continue;
          if (n.fittedFont && n.fittedFont >= 12) el.text.fontSize = n.fittedFont;
          else if (n.suggestedText) el.text.text = n.suggestedText;
        }
      }
    }
    finalDeck = ds.applyDeckUniformFonts(finalDeck).deck;
    const created = db.createProject(userId, { name: `${project.name} (professional)`.slice(0, 200), type: 'deck', content: finalDeck });
    chargeOrThrow(userId, 'ai_design', `Assistant made a professional version of deck ${project.id} → ${created.id}`);
    return {
      action: 'make-professional', project: { id: project.id, name: project.name, type: project.type },
      newProject: { id: created.id, name: created.name, type: created.type },
      preview: { slides: rewrites.length, note: 'Quiz and chart slides were kept unchanged.' },
      note: 'A NEW project was created — the original was not changed. Open the new project to review it.',
    };
  }
  throw new Error(`"Make this more professional" supports design and deck projects (this one is ${project.type}). Summarise and Suggest work for any project type.`);
}

async function fiveVersions(userId, projectId, signal) {
  const project = loadProject(userId, projectId);
  if (project.type !== 'design') {
    throw new Error(`"Create five versions" supports design projects (this one is ${project.type}).`);
  }
  const digest = projectDigest(project);
  let content = {};
  try { content = JSON.parse(project.content || '{}'); } catch { content = {}; }
  const v = validateDesign(content);
  if (!v.ok) throw new Error('Invalid design: ' + v.errors.join(' '));
  const out = await ai.chatJson(userId, {
    system: 'You are a professional graphic designer. Reply with valid JSON only, no other text.',
    user: `Create five different versions of this design. Current design "${digest.name}" (${digest.stats.width}×${digest.stats.height}), current text: ${digest.texts || '(no text)'}. Reply as a JSON object {"versions":[{"headline":"max 8 words","subheading":"max 16 words","palette":{"primary":"#RRGGBB","secondary":"#RRGGBB","accent":"#RRGGBB"},"cta":"max 2 words"}]} with exactly 5 versions. Rules: each version must be genuinely different (different headline angle or palette), keep the meaning of the original, do not invent new claims, prices or dates.`,
  }, signal);
  const versions = Array.isArray(out.versions) ? out.versions : [];
  if (versions.length !== 5) throw new Error(`The LLM returned ${versions.length} versions instead of 5 — nothing was created. Try again.`);
  for (let i = 0; i < versions.length; i++) {
    if (!versions[i].headline || typeof versions[i].headline !== 'string') {
      throw new Error(`The LLM returned no headline for version ${i + 1} — nothing was created. Try again.`);
    }
  }
  const created = [];
  for (let i = 0; i < versions.length; i++) {
    const design = buildProfessionalDesign(content, versions[i]);
    const p = db.createProject(userId, { name: `${project.name} (version ${i + 1})`.slice(0, 200), type: 'design', content: design });
    chargeOrThrow(userId, 'ai_design', `Assistant created version ${i + 1} of project ${project.id} → ${p.id}`);
    created.push({ id: p.id, name: p.name, type: p.type, headline: String(versions[i].headline).slice(0, 80), palette: cleanPalette(versions[i].palette) });
  }
  return {
    action: 'five-versions', project: { id: project.id, name: project.name, type: project.type },
    versions: created,
    note: 'Five NEW projects were created — the original was not changed. Open any version to review it.',
  };
}

module.exports = { ASSISTANT_ACTIONS, actionById, projectDigest, summarise, suggest, makeProfessional, fiveVersions };
