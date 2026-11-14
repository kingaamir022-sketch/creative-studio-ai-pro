'use strict';
// AI Creative Studio — Phase 7.
//
// Real provider clients + the AI job runner. Every client resolves its
// provider through src/providers.js: no key → the call REFUSES with
// PROVIDER_KEY_NEEDED and creates no output file. Nothing here fakes AI
// output, and no stock/random file is ever passed off as generated.
//
// Clients implemented against the providers' REAL, documented APIs:
//   image  — OpenAI Images (dall-e-3 / gpt-image-1) and Stability SD3
//   video  — Runway Gen-4 (async tasks, polled until done)
//   llm    — OpenAI Chat Completions (JSON mode)
//   stt    — OpenAI Whisper (verbose_json word timestamps)
//   music  — Replicate MusicGen (async model predictions)
//   tts    — OpenAI TTS + ElevenLabs cloning (see src/voice.js, reused here)
//
// AI jobs live in their OWN table (ai_jobs): the Phase 3 render queue
// claims any 'queued' row in the shared jobs table, so AI jobs must never
// live there. The runner processes one AI job at a time, supports cancel
// (aborts the in-flight fetch) and retry.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const providers = require('./providers');
const credits = require('./credits');
const { probeMedia, run } = require('./ffmpeg');
const { normaliseCues } = require('./captions');

const AI_MODES = ['image', 'image-edit', 'video', 'video-image', 'voice', 'quiz', 'design', 'transcribe', 'music-mood', 'music-generate', 'write', 'deck'];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function keyNeededError(providerLabel, extra) {
  const err = new Error(`${providerLabel} is not configured: no API key. Add one in Settings → AI Providers. No output was created.${extra ? ' ' + extra : ''}`);
  err.code = 'PROVIDER_KEY_NEEDED';
  return err;
}

function providerError(providerLabel, res, detail, retried = false) {
  // One plain line for the user; the raw detail goes to the server log
  // only (see providers.friendlyProviderError) — never a raw JSON dump.
  return providers.friendlyProviderError(providerLabel, res.status, detail, { retried });
}

function cancelledError() {
  const err = new Error('AI job cancelled.');
  err.code = 'JOB_CANCELLED';
  return err;
}

// --- Saving generated files --------------------------------------------------
// Every generated file becomes a normal Media Library row (kind image /
// video / audio, tag 'ai-generated') so the rest of the app — editors,
// bulk backgrounds, renders — can use it like any uploaded file.
async function saveGeneratedBuffer(userId, { buffer, name, kind, mimeType, tags }) {
  if (!buffer || buffer.length < 10) throw new Error('The provider returned an empty file.');
  const dir = path.join(config.uploadsDir, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
  let storedName = safe;
  let n = 1;
  while (fs.existsSync(path.join(dir, storedName))) {
    storedName = safe.replace(/(\.[^.]+)$/, `-${n}$1`);
    n += 1;
  }
  const filePath = path.join(dir, storedName);
  fs.writeFileSync(filePath, buffer);
  const probe = await probeMedia(filePath);
  const media = db.createMedia(userId, {
    originalName: safe, storedName, mimeType, kind,
    sizeBytes: buffer.length,
    width: probe && probe.width, height: probe && probe.height,
    durationSeconds: probe && probe.durationSeconds, tags: tags || 'ai-generated',
  });
  return { media, filePath, probe };
}

function mediaUrl(media) { return `/api/media/${media.id}/file`; }
function mediaFilePath(userId, media) { return path.join(config.uploadsDir, String(userId), media.stored_name); }

// --- Image -------------------------------------------------------------------
// size: '1:1' | '9:16' | '16:9' (mapped to the provider's real sizes).
const OPENAI_IMAGE_SIZES = { '1:1': '1024x1024', '9:16': '1024x1792', '16:9': '1792x1024' };

async function generateImage(userId, { prompt, size = '1:1', style, sourceMediaId, model: modelOverride } = {}, signal) {
  const clean = String(prompt || '').trim();
  if (!clean) throw new Error('An image prompt is required.');
  if (clean.length > 4000) throw new Error('Image prompt is too long (max 4000 characters).');
  const providerId = providers.activeProviderForKind('image');
  const p = providers.resolveProvider(providerId);
  if (!p.configured) throw keyNeededError(p.label, 'AI image generation arrives with a key — see Phase 7 (AI Creative Studio).');

  let buffer;
  let providerName;
  if (p.id === 'stability') {
    if (sourceMediaId) {
      throw new Error('Image-to-image is not supported by the Stability provider in this app yet — switch the active image provider to OpenAI Images in Settings → AI Providers.');
    }
    const form = new FormData();
    form.append('prompt', clean);
    form.append('output_format', 'png');
    form.append('aspect_ratio', size in OPENAI_IMAGE_SIZES ? size : '1:1');
    if (style) form.append('style_preset', style);
    const res = await providers.fetchWithRetry(`${p.baseUrl}/v2beta/stable-image/generate/sd3`, {
      method: 'POST', headers: { Authorization: `Bearer ${p.key}`, Accept: 'image/*' }, body: form, signal,
    }, 120000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    buffer = Buffer.from(await res.arrayBuffer());
    providerName = 'stability-sd3';
  } else {
    // OpenAI Images (dall-e-3 / gpt-image-1).
    const model = modelOverride || p.model;
    const sizePx = OPENAI_IMAGE_SIZES[size] || '1024x1024';
    if (sourceMediaId) {
      const media = db.getMedia(userId, sourceMediaId);
      if (!media) throw new Error('Source image not found in your Media Library.');
      if (media.kind !== 'image') throw new Error('Image-to-image needs a source image.');
      const editModel = model === 'dall-e-3' ? 'gpt-image-1' : model; // dall-e-3 has no edits endpoint
      const fileBuf = fs.readFileSync(mediaFilePath(userId, media));
      const form = new FormData();
      form.append('image', new Blob([fileBuf], { type: media.mime_type || 'image/png' }), media.original_name);
      form.append('prompt', clean);
      form.append('model', editModel);
      form.append('size', sizePx);
      const res = await providers.fetchWithRetry(`${p.baseUrl}/images/edits`, {
        method: 'POST', headers: { Authorization: `Bearer ${p.key}` }, body: form, signal,
      }, 120000);
      if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
      const json = await res.json();
      const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
      if (!b64) throw new Error('The image provider returned no image data.');
      buffer = Buffer.from(b64, 'base64');
      providerName = `openai-${editModel}`;
    } else {
      const body = { model, prompt: clean, size: sizePx, n: 1, response_format: 'b64_json' };
      if (style) body.style = style;
      const res = await providers.fetchWithRetry(`${p.baseUrl}/images/generations`, {
        method: 'POST', headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal,
      }, 120000);
      if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
      const json = await res.json();
      const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
      if (!b64) throw new Error('The image provider returned no image data.');
      buffer = Buffer.from(b64, 'base64');
      providerName = `openai-${model}`;
    }
  }
  const stamp = Date.now().toString(36);
  const saved = await saveGeneratedBuffer(userId, {
    buffer, name: `ai-image-${stamp}.png`, kind: 'image', mimeType: 'image/png', tags: 'ai-generated',
  });
  credits.chargeCredits(userId, 'ai_image', `Generated image (${providerName}): "${clean.slice(0, 80)}"`);
  return { media: saved.media, filePath: saved.filePath, url: mediaUrl(saved.media), provider: providerName, prompt: clean };
}

// One AI background for a bulk row, cached by prompt hash so the same
// prompt is never generated (or billed) twice.
async function generateAiBackground(userId, prompt) {
  const clean = String(prompt || '').trim();
  if (!clean) throw new Error('AI background needs a prompt (use the BACKGROUND_PROMPT column, or the AI prompt template).');
  const providerId = providers.activeProviderForKind('image');
  const p = providers.resolveProvider(providerId);
  if (!p.configured) {
    throw keyNeededError(p.label, 'AI background generation needs an image provider key (Phase 7 — AI Creative Studio). Add one in Settings → AI Providers first. Until then this mode cannot start a batch.');
  }
  const hash = crypto.createHash('sha256').update(`${providerId}|${clean}`).digest('hex');
  const storedName = `ai-bg-${hash.slice(0, 16)}.png`;
  const existing = db.listMedia(userId, { tag: 'ai-background' }).find((m) => m.stored_name === storedName);
  if (existing && fs.existsSync(mediaFilePath(userId, existing))) {
    return { media: existing, cached: true, prompt: clean };
  }
  const gen = await generateImage(userId, { prompt: clean, size: '1:1' });
  // Rename to the hash-based name so the cache lookup above finds it next
  // time (generateImage saves under a timestamped name).
  const targetPath = path.join(config.uploadsDir, String(userId), storedName);
  try { fs.renameSync(gen.filePath, targetPath); } catch { /* keep the original name; the row still points at a valid file */ }
  const updated = db.updateMedia(userId, gen.media.id, { tags: 'ai-generated,ai-background', storedName: fs.existsSync(targetPath) ? storedName : undefined });
  return { media: updated || gen.media, cached: false, prompt: clean };
}

// --- Video -------------------------------------------------------------------
// Runway Gen-4: async tasks — create, then poll until SUCCEEDED and
// download the output. Poll interval 5 s, hard cap ~10 minutes.
async function pollRunwayTask(p, taskId, signal, onProgress) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let polls = 0;
  for (;;) {
    if (signal && signal.aborted) throw cancelledError();
    const res = await providers.fetchWithRetry(`${p.baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET', headers: { Authorization: `Bearer ${p.key}` }, signal,
    }, 30000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    const task = await res.json();
    polls += 1;
    if (onProgress) onProgress(Math.min(85, 30 + polls * 4));
    const status = String(task.status || '').toUpperCase();
    if (status === 'SUCCEEDED') {
      const out = task.output;
      const url = Array.isArray(out) ? out[0] : (typeof out === 'string' ? out : null);
      if (!url) throw new Error('The video provider finished but returned no output URL.');
      return url;
    }
    if (status === 'FAILED' || status === 'CANCELLED') {
      throw new Error(`Video generation ${status.toLowerCase()}: ${String(task.failure || task.error || 'no detail').slice(0, 300)}`);
    }
    if (Date.now() > deadline) throw new Error('Video generation timed out after 10 minutes (the provider task never finished).');
    await sleep(5000);
  }
}

async function generateVideo(userId, { prompt, sourceMediaId, duration = 5, aspect = '16:9' } = {}, signal, onProgress) {
  const clean = String(prompt || '').trim();
  if (!clean) throw new Error('A video prompt is required.');
  if (clean.length > 4000) throw new Error('Video prompt is too long (max 4000 characters).');
  const secs = Math.max(2, Math.min(16, parseInt(duration, 10) || 5));
  const ratio = aspect === '9:16' ? '9:16' : '16:9';
  const p = providers.resolveProvider(providers.activeProviderForKind('video'));
  if (!p.configured) throw keyNeededError(p.label, 'AI video generation arrives with a key — see Phase 7 (AI Creative Studio).');
  if (onProgress) onProgress(10);

  let taskId;
  if (sourceMediaId) {
    const media = db.getMedia(userId, sourceMediaId);
    if (!media) throw new Error('Source image not found in your Media Library.');
    if (media.kind !== 'image') throw new Error('Image-to-video needs a source image.');
    const buf = fs.readFileSync(mediaFilePath(userId, media));
    const dataUri = `data:${media.mime_type || 'image/png'};base64,${buf.toString('base64')}`;
    const res = await providers.fetchWithRetry(`${p.baseUrl}/image_to_video`, {
      method: 'POST', headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json', 'X-Runway-Version': '2024-11-06' },
      body: JSON.stringify({ promptImage: dataUri, promptText: clean, model: p.model, ratio, duration: secs }), signal,
    }, 60000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    taskId = (await res.json()).id;
  } else {
    const res = await providers.fetchWithRetry(`${p.baseUrl}/text_to_video`, {
      method: 'POST', headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json', 'X-Runway-Version': '2024-11-06' },
      body: JSON.stringify({ promptText: clean, model: p.model, ratio, duration: secs }), signal,
    }, 60000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    taskId = (await res.json()).id;
  }
  if (!taskId) throw new Error('The video provider did not return a task id.');
  if (onProgress) onProgress(25);
  const outputUrl = await pollRunwayTask(p, taskId, signal, onProgress);
  if (onProgress) onProgress(90);
  const dl = await providers.fetchWithRetry(outputUrl, { signal }, 300000);
  if (!dl.ok) throw new Error(`Could not download the generated video (${dl.status}).`);
  const buffer = Buffer.from(await dl.arrayBuffer());
  const stamp = Date.now().toString(36);
  const saved = await saveGeneratedBuffer(userId, {
    buffer, name: `ai-video-${stamp}.mp4`, kind: 'video', mimeType: 'video/mp4', tags: 'ai-generated',
  });
  credits.chargeCredits(userId, 'ai_video', `Generated video (Runway ${p.model}, ${secs}s): "${clean.slice(0, 80)}"`);
  return { media: saved.media, filePath: saved.filePath, url: mediaUrl(saved.media), provider: `runway-${p.model}`, prompt: clean, taskId };
}

// --- LLM (JSON mode) -----------------------------------------------------------
async function chatJson(userId, { system, user, model: modelOverride, temperature = 0.3 } = {}, signal, meta = {}) {
  const p = providers.resolveProvider(providers.activeProviderForKind('llm'));
  // Free alternative (v2.2.1): when the paid OpenAI provider has no key,
  // point the user at Google Gemini — a free Google AI Studio key, no card.
  const keyHint = p.id === 'llm'
    ? 'AI text generation arrives with a key — see Phase 7 (AI Creative Studio). Free alternative: Google Gemini — get a free key from Google AI Studio (aistudio.google.com, no card required), add it in Settings → AI Providers, and set Gemini as the active LLM provider.'
    : 'AI text generation arrives with a key — see Phase 7 (AI Creative Studio).';
  if (!p.configured) throw keyNeededError(p.label, keyHint);
  // v2.2.4 — retry + fallback. Candidates: the configured model first,
  // then the provider's other listed models in order. Each candidate gets
  // the full transient retry budget (429/503/... with backoff, inside
  // fetchWithRetry). A 404 naming a retired model moves to the next
  // candidate at once; a model that stays overloaded after its retries
  // also moves on. Anything else (bad key, bad request) fails now —
  // another model would not help. `meta` reports what really happened
  // ({ model, attempts, fallback, modelsTried }) so callers can log and
  // record which model finally succeeded.
  const requested = modelOverride || p.model;
  const candidates = [requested, ...((p.models || []).filter((m) => m && m !== requested))];
  const tried = [];
  let totalAttempts = 0;
  for (const model of candidates) {
    const callMeta = {};
    const res = await providers.fetchWithRetry(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system || 'You are a helpful assistant. Always reply with valid JSON only.' },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature,
      }),
      signal,
    }, 120000, callMeta);
    totalAttempts += callMeta.attempts || 1;
    tried.push(model);
    meta.modelsTried = [...tried];
    meta.attempts = totalAttempts;
    if (res.ok) {
      const json = await res.json();
      const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      if (!content) throw new Error('The LLM provider returned no text.');
      const stripped = String(content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(stripped);
      } catch {
        const err = new Error('The LLM provider returned text that is not valid JSON.');
        err.code = 'PROVIDER_ERROR';
        throw err;
      }
      meta.model = model;
      meta.fallback = model !== requested;
      if (model !== requested) console.log(`[LLM] ${p.label}: model "${requested}" unavailable, succeeded with fallback "${model}" (tried: ${tried.join(', ')})`);
      else if (callMeta.retried) console.log(`[LLM] ${p.label}: succeeded with "${model}" after ${callMeta.attempts} attempts`);
      return parsed;
    }
    const detail = await res.text().catch(() => '');
    const isLast = model === candidates[candidates.length - 1];
    if (res.status === 404 && providers.friendlyModelError(p, model, res.status, detail)) {
      console.log(`[LLM] ${p.label}: model "${model}" is no longer available — trying the next model`);
      if (isLast) {
        const err = new Error(`All ${p.label} models tried (${tried.join(', ')}) are no longer available. Check Settings → AI Providers for the current model list.`);
        err.code = 'MODEL_NOT_FOUND';
        err.status = 404;
        meta.model = null;
        meta.fallback = true;
        throw err;
      }
      continue;
    }
    if (providers.TRANSIENT_STATUSES.includes(res.status)) {
      console.log(`[LLM] ${p.label}: model "${model}" stayed overloaded after ${callMeta.attempts || 1} attempts — trying the next model`);
      if (isLast) {
        meta.model = null;
        meta.fallback = candidates.length > 1;
        throw providerError(p.label, res, detail, true);
      }
      continue;
    }
    // Any other failure (bad key, bad request, server error): fail now.
    meta.model = null;
    throw providerError(p.label, res, detail, Boolean(callMeta.retried));
  }
  // Unreachable — candidates always has at least the requested model.
  throw new Error(`The LLM provider returned no result (tried: ${tried.join(', ')}).`);
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const QUIZ_DIFFICULTIES = ['easy', 'medium', 'hard', 'hardest'];

async function generateQuizQuestions(userId, { topic, count = 5, difficulty = 'mixed', language = 'en' } = {}, signal) {
  const cleanTopic = String(topic || '').trim();
  if (!cleanTopic) throw new Error('A quiz topic is required.');
  const n = Math.max(1, Math.min(10, parseInt(count, 10) || 5));
  const diff = QUIZ_DIFFICULTIES.includes(difficulty) ? difficulty : 'mixed';
  const meta = {};
  const out = await chatJson(userId, {
    system: 'You write quiz questions. Reply with valid JSON only, no other text.',
    user: `Generate quiz questions. Write exactly ${n} multiple-choice quiz questions about "${cleanTopic}" (difficulty: ${diff}, language: ${language}). Reply as a JSON object {"questions":[{"question":"...","options":["...","...","...","..."],"correct":"A","explanation":"one short sentence"}]}. Rules: exactly 4 options per question, correct is the letter A, B, C or D, options are short (under 22 characters when possible), questions under 80 characters when possible.`,
  }, signal, meta);
  const list = Array.isArray(out.questions) ? out.questions : [];
  if (!list.length) throw new Error('The LLM provider returned no quiz questions.');
  const questions = list.slice(0, n).map((q, i) => {
    const options = Array.isArray(q.options) ? q.options.slice(0, 4).map((o) => String(o ?? '').trim()) : [];
    if (!q.question || options.length !== 4 || options.some((o) => !o)) {
      throw new Error(`The LLM returned a malformed question (item ${i + 1}): each question needs exactly 4 non-empty options.`);
    }
    const correct = String(q.correct || '').trim().toUpperCase();
    if (!['A', 'B', 'C', 'D'].includes(correct)) {
      throw new Error(`The LLM returned a malformed question (item ${i + 1}): "correct" must be A, B, C or D.`);
    }
    return {
      question: String(q.question).trim(),
      options,
      correct,
      explanation: String(q.explanation || '').trim(),
      category: cleanTopic, difficulty: diff, timerSeconds: 3,
    };
  });
  const header = 'QUESTION,OPTION_A,OPTION_B,OPTION_C,OPTION_D,CORRECT,EXPLANATION,CATEGORY,DIFFICULTY,TIMER_SECONDS';
  const csv = [header, ...questions.map((q) => [
    q.question, ...q.options, q.correct, q.explanation, q.category, q.difficulty, q.timerSeconds,
  ].map(csvEscape).join(','))].join('\n');
  credits.chargeCredits(userId, 'ai_quiz', `Generated ${questions.length} quiz questions about "${cleanTopic}"`);
  return { questions, csv, topic: cleanTopic, model: meta.model || null };
}

const DESIGN_FONTS = ['Poppins', 'Inter', 'Montserrat', 'Playfair Display', 'Roboto', 'Oswald', 'Lato', 'Raleway', 'Bebas Neue', 'Dancing Script'];
const HEX = /^#[0-9a-fA-F]{6}$/;

function buildDesignFromSuggestions(s, name) {
  const headline = String(s.headline || 'Your headline here').slice(0, 80);
  const sub = String(s.subheading || 'Made with CreativeStudio AI Pro').slice(0, 140);
  const cta = String(s.cta || 'LEARN MORE').slice(0, 24);
  const pal = s.palette || {};
  const from = HEX.test(pal.primary || '') ? pal.primary : '#7c5cff';
  const to = HEX.test(pal.secondary || '') ? pal.secondary : '#22d3ee';
  const accent = HEX.test(pal.accent || '') ? pal.accent : '#3b82f6';
  const headingFont = DESIGN_FONTS.includes(s.fonts && s.fonts.heading) ? s.fonts.heading : 'Poppins';
  const bodyFont = DESIGN_FONTS.includes(s.fonts && s.fonts.body) ? s.fonts.body : 'Inter';
  const words = headline.replace(/[“”"'.!?]/g, '').split(/\s+/).filter(Boolean);
  return {
    version: 1, width: 1080, height: 1080,
    background: { type: 'gradient', color: from, gradient: { from, to, angle: 135 } },
    layers: [
      { id: 'ai_badge', type: 'shape', name: 'Badge', x: 390, y: 110, w: 300, h: 60, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, shape: { kind: 'rect', fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 30, shadow: null } },
      { id: 'ai_badge_t', type: 'text', name: 'Badge text', x: 390, y: 120, w: 300, h: 44, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: 'NEW DESIGN', fontFamily: headingFont, fontSize: 28, fontWeight: 800, fontStyle: 'normal', underline: false, align: 'center', color: from, letterSpacing: 2, lineHeight: 1.2, shadow: null, stroke: null, gradient: null } },
      { id: 'ai_head', type: 'text', name: 'Headline', x: 90, y: 280, w: 900, h: 260, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: headline, fontFamily: headingFont, fontSize: 110, fontWeight: 800, fontStyle: 'normal', underline: false, align: 'center', color: '#ffffff', letterSpacing: 0, lineHeight: 1.05, shadow: { color: '#000000', blur: 10, offsetX: 0, offsetY: 4 }, stroke: null, gradient: null } },
      { id: 'ai_sub', type: 'text', name: 'Subheading', x: 140, y: 580, w: 800, h: 90, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: sub, fontFamily: bodyFont, fontSize: 36, fontWeight: 400, fontStyle: 'normal', underline: false, align: 'center', color: '#e8ecf8', letterSpacing: 0, lineHeight: 1.3, shadow: null, stroke: null, gradient: null } },
      { id: 'ai_cta', type: 'shape', name: 'CTA button', x: 390, y: 720, w: 300, h: 88, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, shape: { kind: 'rect', fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 44, shadow: null } },
      { id: 'ai_cta_t', type: 'text', name: 'CTA text', x: 390, y: 736, w: 300, h: 56, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: cta, fontFamily: headingFont, fontSize: 34, fontWeight: 800, fontStyle: 'normal', underline: false, align: 'center', color: accent, letterSpacing: 0, lineHeight: 1.2, shadow: null, stroke: null, gradient: null } },
    ],
    _ai: { prompt: name, suggestions: { headline, subheading: sub, cta, palette: { primary: from, secondary: to, accent }, fonts: { heading: headingFont, body: bodyFont } } },
  };
}

// AI Design Assist: the LLM picks headline, palette and fonts; the result
// is ALWAYS a NEW editable design project — the original (if any) is never
// touched, so nothing destructive happens without a preview.
async function designAssist(userId, { prompt, name, projectId } = {}, signal) {
  const clean = String(prompt || '').trim();
  if (!clean) throw new Error('A design prompt is required.');
  if (projectId) {
    const p = db.getProject(userId, projectId);
    if (!p) throw new Error('Design project not found.');
    if (p.type !== 'design') throw new Error('Design Assist needs a design project.');
  }
  const out = await chatJson(userId, {
    system: 'You are a professional graphic designer. Reply with valid JSON only, no other text.',
    user: `Design assist. For this design brief: "${clean}" — reply as a JSON object {"headline":"short bold headline, max 8 words","subheading":"one supporting line, max 16 words","palette":{"primary":"#RRGGBB","secondary":"#RRGGBB","accent":"#RRGGBB"},"fonts":{"heading":"one of Poppins, Inter, Montserrat, Playfair Display, Roboto, Oswald, Lato, Raleway, Bebas Neue, Dancing Script","body":"one of the same list"},"cta":"short button text, max 2 words"}.`,
  }, signal);
  if (!out.headline || typeof out.headline !== 'string') {
    throw new Error('The LLM provider returned no design suggestion.');
  }
  const designName = (name || clean.slice(0, 40) || 'AI Design').trim();
  const content = buildDesignFromSuggestions(out, clean);
  const project = db.createProject(userId, { name: `${designName} (AI assist)`, type: 'design', content });
  credits.chargeCredits(userId, 'ai_design', `AI Design Assist: "${clean.slice(0, 80)}" → project ${project.id}`);
  return { project: { id: project.id, name: project.name, type: project.type }, suggestions: content._ai.suggestions, sourceProjectId: projectId || null };
}

// --- Magic Write (general AI writing) ----------------------------------------
// The general-purpose writing tool the audit found missing: headlines,
// posts, scripts, blog intros, rewrites, shortening and tone changes —
// routed through the same LLM abstraction as quiz/design, so it works with
// the free Gemini provider when configured and refuses key_needed honestly
// when no LLM key is set. Returns { text, alternatives, task }.
const WRITE_TASKS = {
  headline: 'Write punchy headlines',
  post: 'Write a social media post',
  script: 'Write a short video script',
  blog: 'Write a blog introduction',
  rewrite: 'Rewrite the text, keeping the meaning',
  shorten: 'Shorten the text, keeping the key points',
  tone: 'Rewrite the text in a different tone',
};

async function generateWriting(userId, { prompt, task = 'post', tone = '', length = 'medium' } = {}, signal) {
  const clean = String(prompt || '').trim();
  if (!clean) throw new Error('Magic Write needs some text or a topic to write about.');
  if (clean.length > 4000) throw new Error('Magic Write input is too long (max 4000 characters).');
  const t = WRITE_TASKS[task] ? task : 'post';
  const toneLine = tone ? ` Tone: ${String(tone).slice(0, 60)}.` : '';
  const lenLine = ['short', 'medium', 'long'].includes(length) ? ` Length: ${length}.` : '';
  const out = await chatJson(userId, {
    system: 'You are a professional copywriter. Reply with valid JSON only, no other text.',
    user: `Magic Write — ${WRITE_TASKS[t]}. Input: "${clean}".${toneLine}${lenLine} Reply as a JSON object {"text":"the main written piece","alternatives":["up to 3 shorter alternative versions, may be empty"]}. Rules: text is ready to publish (no placeholders, no meta-commentary), alternatives are real rewrites, not copies of text.`,
  }, signal);
  const text = String(out.text || '').trim();
  if (!text) throw new Error('The LLM provider returned no writing.');
  const alternatives = Array.isArray(out.alternatives)
    ? out.alternatives.slice(0, 3).map((a) => String(a || '').trim()).filter(Boolean)
    : [];
  credits.chargeCredits(userId, 'ai_write', `Magic Write (${t}): "${clean.slice(0, 80)}"`);
  return { text, alternatives, task: t };
}

// --- AI Presentations (v2.2.3) -------------------------------------------------
// The LLM writes a slide outline; the deck is built from the app's own slide
// templates (never a flattened image), then auto-fitted: every text layer is
// checked with the project's fitText and shrunk to fit, or shortened with
// the suggested text. Anything that still does not fit is reported honestly
// in result.needsAttention — never rendered broken. Without an LLM key the
// job fails key_needed (chatJson refuses) and creates no project.
async function generateDeck(userId, { topic, slideCount = 6, style = 'professional', audience = '' } = {}, signal) {
  const clean = String(topic || '').trim();
  if (!clean) throw new Error('A topic is required for AI deck generation.');
  const count = Math.max(2, Math.min(20, parseInt(slideCount, 10) || 6));
  const ds = require('./docs-slides');
  const out = await chatJson(userId, {
    system: 'You are a professional presentation designer. Reply with valid JSON only, no other text.',
    user: `Create a ${count}-slide presentation outline about: "${clean}". Style: ${String(style).slice(0, 40)}. Audience: ${String(audience).slice(0, 120) || 'general'}. Reply as a JSON object {"title":"deck title, max 10 words","slides":[{"layout":"title","heading":"slide title","bullets":[],"notes":"speaker notes, 1-2 sentences"},{"layout":"text","heading":"slide title","bullets":["up to 5 short bullet points, each max 12 words"],"notes":"..."}]}. Rules: first slide layout "title", the rest "text" (use "quiz" for at most one slide with "question", "options" (4 strings) and "correctIndex" 0-3, or "chart" for at most one slide with "chart":{"type":"bar","labels":[...],"datasets":[{"label":"...","values":[...]}]}). Every heading max 10 words, every bullet max 12 words, no placeholders.`,
  }, signal);
  const title = String(out.title || clean).trim().slice(0, 100) || clean;
  const outlines = Array.isArray(out.slides) ? out.slides.slice(0, count) : [];
  if (!outlines.length) throw new Error('The LLM provider returned no slide outline.');
  const deck = ds.blankDeck({ title });
  deck.slides = [];
  outlines.forEach((o, i) => {
    const layout = ['title', 'text', 'text-image', 'chart', 'quiz'].includes(o.layout) ? o.layout : 'text';
    const slide = ds.blankSlide(layout, { width: deck.width, height: deck.height });
    slide.notes = String(o.notes || '').slice(0, 500);
    const byRole = (role) => slide.elements.find((e) => e.type === 'text' && e.role === role);
    const byName = (name) => slide.elements.find((e) => e.name === name);
    const heading = String(o.heading || '').trim().slice(0, 120);
    if (layout === 'title') {
      const t = byRole('title'); if (t && heading) t.text.text = heading;
      const sub = byRole('subtitle'); if (sub) sub.text.text = String(o.bullets && o.bullets[0] ? o.bullets[0] : clean).slice(0, 120);
    } else if (layout === 'text') {
      const t = byRole('title'); if (t && heading) t.text.text = heading;
      const body = byRole('body');
      if (body) {
        const bullets = Array.isArray(o.bullets) ? o.bullets.slice(0, 5).map((b) => String(b).slice(0, 140)) : [];
        body.text.text = bullets.length ? bullets.map((b) => `•  ${b}`).join('\n') : '';
      }
    } else if (layout === 'quiz') {
      const q = byRole('question'); if (q && o.question) q.text.text = String(o.question).slice(0, 160);
      const options = Array.isArray(o.options) ? o.options.slice(0, 4).map((x) => String(x).slice(0, 90)) : [];
      const correct = Number.isInteger(o.correctIndex) ? o.correctIndex : 0;
      slide.elements.forEach((e) => {
        if (e.type === 'text' && e.role === 'option') {
          const idx = ['Option A', 'Option B', 'Option C', 'Option D'].indexOf(e.name);
          if (idx >= 0 && options[idx]) e.text.text = `${String.fromCharCode(65 + idx)}. ${options[idx]}`;
        }
        if (e.type === 'shape' && e.name && e.name.startsWith('Option ')) {
          const idx = ['Option A box', 'Option B box', 'Option C box', 'Option D box'].indexOf(e.name);
          e.shape.fill = idx === correct ? '#16a34a' : '#24304f';
        }
      });
    } else if (layout === 'chart') {
      const t = byRole('title'); if (t && heading) t.text.text = heading;
      const chartEl = slide.elements.find((e) => e.type === 'chart');
      if (chartEl && o.chart && typeof o.chart === 'object') {
        const { validateChart } = require('./chart');
        const cand = {
          type: ['bar', 'line', 'pie', 'doughnut'].includes(o.chart.type) ? o.chart.type : 'bar',
          title: '',
          labels: Array.isArray(o.chart.labels) ? o.chart.labels.slice(0, 12).map((l) => String(l).slice(0, 30)) : [],
          datasets: Array.isArray(o.chart.datasets) ? o.chart.datasets.slice(0, 3).map((d, di) => ({
            label: String(d.label || `Series ${di + 1}`).slice(0, 40),
            values: Array.isArray(d.values) ? d.values.slice(0, 12).map((v) => Number(v) || 0) : [],
          })) : [],
        };
        if (validateChart(cand).ok) chartEl.chart = cand;
      }
    }
    deck.slides.push(slide);
  });
  // Auto-fit: shrink any overflowing text to its fitted size, or shorten it
  // with the suggested text. What still does not fit is reported, not hidden.
  let needsAttention = [];
  for (let pass = 0; pass < 2; pass++) {
    const check = ds.deckFitCheck(deck);
    if (!check.ok) throw new Error('Generated deck is invalid: ' + check.errors.join(' '));
    needsAttention = check.needsAttention;
    if (!needsAttention.length) break;
    for (const n of needsAttention) {
      for (const s of deck.slides) {
        const el = (s.elements || []).find((e) => e.id === n.layerId);
        if (!el || el.type !== 'text') continue;
        if (n.fittedFont && n.fittedFont >= 12) el.text.fontSize = n.fittedFont;
        else if (n.suggestedText) el.text.text = n.suggestedText;
      }
    }
  }
  const finalCheck = ds.deckFitCheck(deck);
  if (!finalCheck.ok) throw new Error('Generated deck is invalid: ' + finalCheck.errors.join(' '));
  const applied = ds.applyDeckUniformFonts(deck);
  const project = db.createProject(userId, { name: `${title} (AI deck)`, type: 'deck', content: applied.deck });
  credits.chargeCredits(userId, 'ai_deck', `AI deck: "${clean.slice(0, 80)}" → project ${project.id} (${applied.deck.slides.length} slides)`);
  return { deck: applied.deck, project: { id: project.id, name: project.name, type: project.type }, needsAttention: finalCheck.needsAttention };
}

// --- Speech-to-text (Whisper) -------------------------------------------------
async function transcribeAudio(userId, mediaId, { language } = {}, signal) {
  const media = db.getMedia(userId, mediaId);
  if (!media) throw new Error('Media not found.');
  if (media.kind !== 'audio' && media.kind !== 'video') throw new Error('Transcription needs an audio or video file.');
  const p = providers.resolveProvider(providers.activeProviderForKind('stt'));
  if (!p.configured) throw keyNeededError(p.label, 'Automatic transcription arrives with a key — see Phase 7 (AI Creative Studio). Use a manual transcript instead (paste text or SRT/VTT).');
  const srcPath = path.join(config.uploadsDir, String(userId), media.stored_name);
  if (!fs.existsSync(srcPath)) throw new Error('The media file is missing on disk.');
  // Whisper wants audio: extract the audio track to MP3 (video input works
  // too — the -vn flag drops the picture).
  const tmpMp3 = path.join(config.uploadsDir, String(userId), `stt-${media.id}-${Date.now().toString(36)}.mp3`);
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', srcPath, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', tmpMp3], { timeout: 300000 });
  } catch (e) {
    throw new Error(`Could not extract audio for transcription: ${e.message}`);
  }
  try {
    const buf = fs.readFileSync(tmpMp3);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('model', p.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    if (language) form.append('language', language);
    const res = await providers.fetchWithRetry(`${p.baseUrl}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${p.key}` }, body: form, signal,
    }, 300000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    const json = await res.json();
    const text = String(json.text || '').trim();
    if (!text) throw new Error('The transcription provider returned an empty transcript.');
    const words = Array.isArray(json.words) ? json.words
      .filter((w) => w && typeof w.word === 'string')
      .map((w) => ({ text: String(w.word).trim(), start: Number(w.start) || 0, end: Number(w.end) || 0 }))
      .filter((w) => w.text) : [];
    // Group words into cues (~6 s / ~42 chars each), then normalise.
    const rawCues = [];
    let cur = null;
    for (const w of words) {
      if (!cur) cur = { start: w.start, end: w.end, text: w.text };
      else if (w.end - cur.start > 6 || (cur.text + ' ' + w.text).length > 42) { rawCues.push(cur); cur = { start: w.start, end: w.end, text: w.text }; }
      else { cur.end = w.end; cur.text = `${cur.text} ${w.text}`; }
    }
    if (cur) rawCues.push(cur);
    const probe = await probeMedia(srcPath);
    const { cues, warnings } = normaliseCues(rawCues, probe && probe.durationSeconds);
    credits.chargeCredits(userId, 'ai_transcribe', `Transcribed "${media.original_name}" (${cues.length} cues)`);
    return { text, words, cues, warnings, durationSeconds: probe && probe.durationSeconds, provider: `openai-${p.model}` };
  } finally {
    try { fs.unlinkSync(tmpMp3); } catch { /* ignore */ }
  }
}

// --- Music ---------------------------------------------------------------------
// Mood tagging is LLM + the Phase 5 local analysis (no music key needed).
async function musicMood(userId, mediaId, signal) {
  const media = db.getMedia(userId, mediaId);
  if (!media) throw new Error('Media not found.');
  if (media.kind !== 'audio') throw new Error('Mood tagging needs an audio file.');
  const cached = db.getAudioAnalysis(userId, mediaId);
  const analysis = cached ? cached.analysis : {};
  const out = await chatJson(userId, {
    system: 'You are a music analyst. Reply with valid JSON only, no other text.',
    user: `Music mood tagging. A track "${media.original_name}" was analysed locally: BPM ${analysis.bpm ?? 'unknown'}, duration ${analysis.durationSeconds ?? 'unknown'}s, energy curve available, drops at ${(analysis.drops || []).map((d) => d.time).join(', ') || 'none'}. Reply as a JSON object {"mood":"one or two words, e.g. Energetic","energy":7,"tempoFeel":"fast","genres":["pop","dance"],"tags":["upbeat","party","workout"]} where energy is 1-10. Base the tags on the analysis numbers, not on the file name alone.`,
  }, signal);
  const tags = {
    mood: String(out.mood || 'Unknown').slice(0, 40),
    energy: Math.max(1, Math.min(10, parseInt(out.energy, 10) || 5)),
    tempoFeel: String(out.tempoFeel || '').slice(0, 30),
    genres: Array.isArray(out.genres) ? out.genres.slice(0, 5).map((g) => String(g).slice(0, 30)) : [],
    tags: Array.isArray(out.tags) ? out.tags.slice(0, 8).map((t) => String(t).slice(0, 30)) : [],
  };
  credits.chargeCredits(userId, 'ai_music_mood', `Mood tags for "${media.original_name}": ${tags.mood}`);
  return { ...tags, bpm: analysis.bpm ?? null, provider: 'llm' };
}

// Music generation via Replicate MusicGen (async model predictions).
async function generateMusic(userId, { prompt, duration = 8 } = {}, signal, onProgress) {
  const clean = String(prompt || '').trim();
  if (!clean) throw new Error('A music prompt is required.');
  const secs = Math.max(2, Math.min(30, parseInt(duration, 10) || 8));
  const p = providers.resolveProvider(providers.activeProviderForKind('music'));
  if (!p.configured) throw keyNeededError(p.label, 'AI music generation arrives with a key — see Phase 7 (AI Creative Studio).');
  if (onProgress) onProgress(10);
  const create = await providers.fetchWithRetry(`${p.baseUrl}/models/meta/musicgen/predictions`, {
    method: 'POST',
    headers: { Authorization: `Token ${p.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { prompt: clean, duration: secs } }), signal,
  }, 60000);
  if (!create.ok) throw providerError(p.label, create, await create.text().catch(() => ''));
  const pred = await create.json();
  const pollUrl = (pred.urls && pred.urls.get) || `${p.baseUrl}/predictions/${encodeURIComponent(pred.id || '')}`;
  if (!pred.id && !pollUrl) throw new Error('The music provider did not return a prediction id.');
  const deadline = Date.now() + 10 * 60 * 1000;
  let polls = 0;
  for (;;) {
    if (signal && signal.aborted) throw cancelledError();
    const res = await providers.fetchWithRetry(pollUrl, {
      method: 'GET', headers: { Authorization: `Token ${p.key}` }, signal,
    }, 30000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    const cur = await res.json();
    polls += 1;
    if (onProgress) onProgress(Math.min(85, 25 + polls * 4));
    const status = String(cur.status || '').toLowerCase();
    if (status === 'succeeded') {
      const out = cur.output;
      const url = Array.isArray(out) ? out[0] : (typeof out === 'string' ? out : null);
      if (!url) throw new Error('The music provider finished but returned no audio URL.');
      if (onProgress) onProgress(90);
      const dl = await providers.fetchWithRetry(url, { signal }, 300000);
      if (!dl.ok) throw new Error(`Could not download the generated music (${dl.status}).`);
      const buffer = Buffer.from(await dl.arrayBuffer());
      const stamp = Date.now().toString(36);
      const saved = await saveGeneratedBuffer(userId, {
        buffer, name: `ai-music-${stamp}.wav`, kind: 'audio', mimeType: 'audio/wav', tags: 'ai-generated',
      });
      credits.chargeCredits(userId, 'ai_music', `Generated music (${secs}s): "${clean.slice(0, 80)}"`);
      return { media: saved.media, filePath: saved.filePath, url: mediaUrl(saved.media), provider: 'replicate-musicgen', prompt: clean };
    }
    if (status === 'failed' || status === 'canceled') {
      throw new Error(`Music generation ${status}: ${String(cur.error || 'no detail').slice(0, 300)}`);
    }
    if (Date.now() > deadline) throw new Error('Music generation timed out after 10 minutes.');
    await sleep(5000);
  }
}

// --- Voice (TTS) — delegates to src/voice.js, which already speaks the ---
// real OpenAI / ElevenLabs APIs and refuses honestly without a key. -------
async function synthesizeVoice(userId, { text, voiceProfileId } = {}) {
  const voice = require('./voice');
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Text is required.');
  if (clean.length > 2000) throw new Error('Text is too long for one narration segment (max 2000 characters).');
  let profile = null;
  if (voiceProfileId) {
    profile = db.getVoiceProfile(userId, voiceProfileId);
    if (!profile) throw new Error('Voice profile not found.');
  } else {
    profile = db.getDefaultVoiceProfile(userId);
    if (!profile) throw new Error('No voice profile yet. Create one first (your own voice from a sample, or an AI voice).');
  }
  const result = await voice.synthesizeSpeech(userId, profile, text);
  credits.chargeCredits(userId, 'ai_voice', `Spoke ${clean.length} chars with "${profile.name}" (${result.provider}${result.cached ? ', cached' : ''})`);
  const media = db.getMedia(userId, result.mediaId);
  return { media, filePath: result.filePath, url: media ? mediaUrl(media) : null, cached: result.cached, provider: result.provider, voice: voice.publicVoiceProfile(profile) };
}

// --- AI job runner -----------------------------------------------------------
const aborts = new Map(); // jobId -> AbortController
let queueRunning = false;

function publicAiJob(row) {
  if (!row) return null;
  let params = {};
  let result = null;
  try { params = JSON.parse(row.params || '{}'); } catch { params = {}; }
  try { result = row.result ? JSON.parse(row.result) : null; } catch { result = null; }
  return {
    id: row.id, mode: row.mode, name: row.name, status: row.status,
    params, result, progress: row.progress, error: row.error,
    outputMediaId: row.output_media_id,
    outputUrl: row.output_media_id ? `/api/media/${row.output_media_id}/file` : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function createAiJobEntry(userId, { mode, params, name }) {
  if (!AI_MODES.includes(mode)) throw new Error(`Unknown AI mode: ${mode}. Available: ${AI_MODES.join(', ')}.`);
  const job = db.createAiJob(userId, { mode, name: name || mode, params: params || {} });
  pumpAiQueue();
  return job;
}

async function runAiJob(jobRow) {
  const job = db.getAiJobAny(jobRow.id);
  if (!job || job.status !== 'queued') return;
  db.updateAiJob(job.id, { status: 'running', progress: 5 });
  const ctrl = new AbortController();
  aborts.set(job.id, ctrl);
  const params = JSON.parse(job.params || '{}');
  const setProgress = (pct) => {
    const cur = db.getAiJobAny(job.id);
    if (cur && cur.status === 'running') db.updateAiJob(job.id, { progress: Math.max(0, Math.min(95, pct)) });
  };
  const checkNotCancelled = () => {
    const cur = db.getAiJobAny(job.id);
    if (!cur || cur.status !== 'running') throw cancelledError();
    if (ctrl.signal.aborted) throw cancelledError();
  };
  try {
    let result = null;
    let outputMediaId = null;
    const userId = job.user_id;
    switch (job.mode) {
      case 'image': {
        const gen = await generateImage(userId, params, ctrl.signal);
        result = { mediaId: gen.media.id, url: gen.url, provider: gen.provider, prompt: gen.prompt };
        outputMediaId = gen.media.id;
        break;
      }
      case 'image-edit': {
        const gen = await generateImage(userId, { ...params, sourceMediaId: params.sourceMediaId }, ctrl.signal);
        result = { mediaId: gen.media.id, url: gen.url, provider: gen.provider, prompt: gen.prompt };
        outputMediaId = gen.media.id;
        break;
      }
      case 'video':
      case 'video-image': {
        const gen = await generateVideo(userId, params, ctrl.signal, setProgress);
        result = { mediaId: gen.media.id, url: gen.url, provider: gen.provider, prompt: gen.prompt };
        outputMediaId = gen.media.id;
        break;
      }
      case 'voice': {
        const spoken = await synthesizeVoice(userId, params);
        result = { mediaId: spoken.media.id, url: spoken.url, provider: spoken.provider, cached: spoken.cached };
        outputMediaId = spoken.media.id;
        break;
      }
      case 'quiz': {
        const q = await generateQuizQuestions(userId, params, ctrl.signal);
        result = { questions: q.questions, csv: q.csv, topic: q.topic, model: q.model || null };
        break;
      }
      case 'design': {
        const d = await designAssist(userId, params, ctrl.signal);
        result = { projectId: d.project.id, projectName: d.project.name, suggestions: d.suggestions };
        break;
      }
      case 'transcribe': {
        const t = await transcribeAudio(userId, params.mediaId, { language: params.language }, ctrl.signal);
        result = { text: t.text, cues: t.cues, warnings: t.warnings, durationSeconds: t.durationSeconds, provider: t.provider };
        if (params.shortsJobId) {
          const sj = db.getShortsJob(userId, params.shortsJobId);
          if (sj) db.updateShortsJob(sj.id, { transcript: { cues: t.cues, text: t.text }, transcript_source: 'stt', language: params.language || sj.language });
        }
        break;
      }
      case 'music-mood': {
        const m = await musicMood(userId, params.mediaId, ctrl.signal);
        result = m;
        break;
      }
      case 'music-generate': {
        const gen = await generateMusic(userId, params, ctrl.signal, setProgress);
        result = { mediaId: gen.media.id, url: gen.url, provider: gen.provider, prompt: gen.prompt };
        outputMediaId = gen.media.id;
        break;
      }
      case 'write': {
        const w = await generateWriting(userId, params, ctrl.signal);
        result = { text: w.text, alternatives: w.alternatives, task: w.task };
        break;
      }
      case 'deck': {
        const d = await generateDeck(userId, params, ctrl.signal);
        result = { deck: d.deck, projectId: d.project.id, projectName: d.project.name, slideCount: d.deck.slides.length, needsAttention: d.needsAttention };
        break;
      }
      default:
        throw new Error(`Unknown AI mode: ${job.mode}`);
    }
    checkNotCancelled();
    db.updateAiJob(job.id, { status: 'done', progress: 100, result, output_media_id: outputMediaId });
  } catch (err) {
    if (err.code === 'JOB_CANCELLED' || ctrl.signal.aborted) {
      db.updateAiJob(job.id, { status: 'cancelled', error: 'AI job cancelled.' });
    } else {
      db.updateAiJob(job.id, { status: 'failed', error: String(err.message || err).slice(0, 1000) });
    }
  } finally {
    aborts.delete(job.id);
  }
}

function pumpAiQueue() {
  if (queueRunning) return;
  const next = db.nextQueuedAiJob();
  if (!next) return;
  queueRunning = true;
  runAiJob(next).finally(() => {
    queueRunning = false;
    setTimeout(pumpAiQueue, 100);
  });
}

function startAiQueue() {
  // Re-queue jobs interrupted by a restart; running jobs are picked up again.
  const rows = db.db.prepare("SELECT id FROM ai_jobs WHERE status = 'running'").all();
  for (const r of rows) db.updateAiJob(r.id, { status: 'queued', progress: 0, error: 'AI job was interrupted by a server restart and will run again.' });
  if (rows.length) console.log(`AI queue: re-queued ${rows.length} interrupted AI job(s).`);
  pumpAiQueue();
}

function cancelAiJob(userId, jobId) {
  const job = db.getAiJob(userId, jobId);
  if (!job) return null;
  const ctrl = aborts.get(job.id);
  if (ctrl) ctrl.abort();
  if (job.status === 'queued' || job.status === 'running') {
    db.updateAiJob(job.id, { status: 'cancelled', error: 'AI job cancelled.' });
  }
  return db.getAiJob(userId, jobId);
}

function retryAiJob(userId, jobId) {
  const job = db.getAiJob(userId, jobId);
  if (!job) return null;
  if (job.status !== 'failed' && job.status !== 'cancelled') {
    throw new Error(`Only failed or cancelled AI jobs can be retried (this one is ${job.status}).`);
  }
  db.updateAiJob(job.id, { status: 'queued', progress: 0, error: null });
  pumpAiQueue();
  return db.getAiJob(userId, jobId);
}

module.exports = {
  AI_MODES,
  generateImage, generateAiBackground, generateVideo, chatJson,
  generateQuizQuestions, designAssist, buildDesignFromSuggestions,
  generateWriting, WRITE_TASKS, generateDeck,
  transcribeAudio, musicMood, generateMusic, synthesizeVoice,
  saveGeneratedBuffer, publicAiJob, createAiJobEntry, runAiJob,
  startAiQueue, cancelAiJob, retryAiJob, pumpAiQueue,
};
