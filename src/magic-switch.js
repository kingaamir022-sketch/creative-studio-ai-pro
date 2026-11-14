'use strict';
// Magic Switch (v2.2.4, Release D) — convert a design between
// formats/sizes/platforms AND translate its text.
//
// Resize is pure local reflow (the v2.2.2 engine): layers scale and
// reposition, text re-wraps and shrinks through fitText, anything that
// still cannot fit is flagged "Needs attention" — never rendered broken.
// Translation goes through the LLM abstraction (chatJson): without an LLM
// key it refuses PROVIDER_KEY_NEEDED honestly and creates NOTHING — no
// fake translation, no half-switched project.
//
// The original project is NEVER touched: the result is always a NEW
// project. Translation happens BEFORE the reflow, so the reflow's fit
// check measures the translated text, not the original.
const db = require('./db');
const { SIZES, validateDesign } = require('./design-model');
const { reflowDesign } = require('./magic-resize');
const ai = require('./ai');
const credits = require('./credits');

const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ur', name: 'Urdu' },
  { code: 'ur-roman', name: 'Roman Urdu' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'tr', name: 'Turkish' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'ja', name: 'Japanese' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'bn', name: 'Bengali' },
  { code: 'pa', name: 'Punjabi' },
];

function languageByCode(code) {
  return SUPPORTED_LANGUAGES.find((l) => l.code === String(code || '').toLowerCase()) || null;
}

function textLayersOf(design) {
  return (design.layers || []).filter((l) => l.type === 'text' && l.text && typeof l.text.text === 'string');
}

// Translate every text layer via the LLM. Returns a NEW design object;
// the input is never mutated. Throws PROVIDER_KEY_NEEDED (from chatJson)
// when no LLM key is configured.
async function translateDesignText(userId, design, language, signal) {
  const layers = textLayersOf(design);
  if (!layers.length) throw new Error('This design has no text layers to translate.');
  const items = layers.map((l) => ({ layerId: l.id, text: l.text.text }));
  const out = await ai.chatJson(userId, {
    system: 'You are a professional translator. Reply with valid JSON only, no other text.',
    user: `Translate each text to ${language.name} (${language.code}). Reply as a JSON object {"translations":[{"layerId":"...","text":"..."}]} with exactly one entry per input item, in the same order, with the same layerId values. Rules: translate the meaning, keep the tone; keep line breaks (\\n) where they are; NEVER translate or alter {{PLACEHOLDER}} bindings — copy them unchanged; never add explanations or extra fields; if a text is already in ${language.name}, return it unchanged. Inputs: ${JSON.stringify(items)}`,
  }, signal);
  const list = Array.isArray(out.translations) ? out.translations : [];
  if (list.length !== items.length) {
    throw new Error(`The LLM returned ${list.length} translations for ${items.length} text layers — nothing was created. Try again.`);
  }
  const byId = new Map(list.map((t) => [t.layerId, t]));
  for (const item of items) {
    const t = byId.get(item.layerId);
    if (!t || typeof t.text !== 'string' || !t.text.trim()) {
      throw new Error(`The LLM returned no translation for text layer "${item.layerId}" — nothing was created. Try again.`);
    }
  }
  const next = JSON.parse(JSON.stringify(design));
  for (const layer of next.layers) {
    if (layer.type !== 'text' || !layer.text) continue;
    const t = byId.get(layer.id);
    if (t) layer.text.text = t.text;
  }
  return next;
}

async function switchDesign(userId, { projectId, targetSizeId, translateTo, name } = {}, signal) {
  const project = db.getProject(userId, projectId);
  if (!project) throw new Error('Design project not found.');
  if (project.type !== 'design') throw new Error(`Magic Switch needs a design project (this one is ${project.type}).`);
  let content = {};
  try { content = JSON.parse(project.content || '{}'); } catch { content = {}; }
  const v = validateDesign(content);
  if (!v.ok) throw new Error('Invalid design: ' + v.errors.join(' '));

  let language = null;
  let working = content;
  if (translateTo) {
    language = languageByCode(translateTo);
    if (!language) throw new Error(`Unsupported language: ${translateTo}. Supported: ${SUPPORTED_LANGUAGES.map((l) => l.code).join(', ')}.`);
    // Credit gate is enforced by the route (pre-flight); charge on success.
    working = await translateDesignText(userId, content, language, signal);
  }

  let report = null;
  let target = null;
  if (targetSizeId) {
    const size = SIZES.find((s) => s.id === String(targetSizeId));
    if (!size) throw new Error(`Unknown size preset: ${targetSizeId}. Available: ${SIZES.map((s) => s.id).join(', ')}.`);
    const reflowed = reflowDesign(working, size.width, size.height);
    working = reflowed.design;
    report = reflowed.report;
    target = { id: size.id, name: size.name, width: size.width, height: size.height };
  } else if (!translateTo) {
    throw new Error('Magic Switch needs a target size, a language to translate to, or both.');
  }

  const suffix = [target ? target.name : null, language ? `in ${language.name}` : null].filter(Boolean).join(' · ');
  const newName = (name && String(name).trim()) || `${project.name} (${suffix || 'switched'})`;
  const created = db.createProject(userId, { name: newName.slice(0, 200), type: 'design', content: working });
  if (language) {
    credits.chargeCredits(userId, 'ai_write', `Magic Switch translation to ${language.name}: project ${project.id} → ${created.id}`);
  }
  db.audit(userId, 'magic_switch', 'project', created.id,
    `Magic Switch: "${project.name}" → "${created.name}"${target ? ` (${target.width}×${target.height})` : ''}${language ? ` translated to ${language.name}` : ''}${report && report.needsAttention.length ? ` — ${report.needsAttention.length} layer(s) need attention` : ''}`);
  return {
    project: { id: created.id, name: created.name, type: created.type },
    sourceProjectId: project.id,
    target,
    language: language ? { code: language.code, name: language.name } : null,
    translated: Boolean(language),
    report,
  };
}

module.exports = { switchDesign, translateDesignText, languageByCode, SUPPORTED_LANGUAGES, SWITCH_TARGETS: SIZES };
