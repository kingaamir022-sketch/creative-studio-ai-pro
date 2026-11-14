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
const { decrypt } = require('./crypto-util');
const credits = require('./credits');
const { probeMedia, run } = require('./ffmpeg');
const { normaliseCues } = require('./captions');
const { fitText } = require('./quiz-model');

const AI_MODES = ['image', 'image-edit', 'video', 'video-image', 'voice', 'quiz', 'design', 'transcribe', 'music-mood', 'music-generate', 'write', 'deck',
  // v2.5.0 new modes (items #44, #45, #60–#69, #29).
  'autocut', 'editpilot', 'seedance', 'video-enhance', 'video-translate', 'director', 'avatar',
  'infinite-canvas', 'lyrics', 'ai-lab', 'batch-edit', 'retouch', 'bilingual',
  'transcript-edit', 'silence-remove', 'magic-grab'];

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
  const providerId = db.getActiveProvider('image');
  const p = (providerId && getExtendedProvider(providerId)) ? resolveExtendedProvider(providerId) : providers.resolveProvider(providers.activeProviderForKind('image'));
  if (!p.configured) throw keyNeededError(p.label, 'AI image generation arrives with a key — see Phase 7 (AI Creative Studio).');
  // v2.5.0: Seedream / Nano Banana live in the extended registry (#64).
  if (getExtendedProvider(p.id)) {
    return generateImageExtended(p, userId, { prompt: clean, size, sourceMediaId }, signal);
  }

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
  const activeVideo = db.getActiveProvider('video');
  const p = (activeVideo && getExtendedProvider(activeVideo)) ? resolveExtendedProvider(activeVideo) : providers.resolveProvider(providers.activeProviderForKind('video'));
  if (!p.configured) throw keyNeededError(p.label, 'AI video generation arrives with a key — see Phase 7 (AI Creative Studio).');
  // v2.5.0: Kling / Veo / PixVerse / Sora / Seedance (#63, #66).
  if (getExtendedProvider(p.id)) {
    return generateVideoExtended(userId, { providerId: p.id, prompt: clean, sourceMediaId, duration: secs, aspect: ratio }, signal, onProgress);
  }
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
  // C-13: fit every AI-written text layer to its box (wrap, then shrink)
  // BEFORE the design is saved — the old code put an up-to-8-word
  // headline at 110px into a 2-line box and it overflowed every time.
  // Returns the fitted {text, fontSize} plus a needsAttention note when
  // even the smallest readable size cannot fit the box.
  const needsAttention = [];
  const fitLayer = (text, boxW, boxH, maxFont, lineHeight, label) => {
    const maxLines = Math.max(1, Math.floor(boxH / (maxFont * lineHeight)));
    const fit = fitText(text, boxW * 0.95, { maxFont, minFont: 12, maxLines, lineHeight });
    if (fit.status === 'attention') needsAttention.push(`${label} does not fit its box even at the smallest readable size — shorten it (suggested: "${(fit.suggestedText || '').slice(0, 60)}")`);
    return { text: fit.lines.join('\n'), fontSize: fit.fontSize };
  };
  const headFit = fitLayer(headline, 900, 260, 110, 1.05, 'Headline');
  const subFit = fitLayer(sub, 800, 90, 36, 1.3, 'Subheading');
  const ctaFit = fitLayer(cta, 300, 56, 34, 1.2, 'CTA text');
  const badgeFit = fitLayer('NEW DESIGN', 300, 44, 28, 1.2, 'Badge text');
  return {
    version: 1, width: 1080, height: 1080,
    background: { type: 'gradient', color: from, gradient: { from, to, angle: 135 } },
    layers: [
      { id: 'ai_badge', type: 'shape', name: 'Badge', x: 390, y: 110, w: 300, h: 60, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, shape: { kind: 'rect', fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 30, shadow: null } },
      { id: 'ai_badge_t', type: 'text', name: 'Badge text', x: 390, y: 120, w: 300, h: 44, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: badgeFit.text, fontFamily: headingFont, fontSize: badgeFit.fontSize, fontWeight: 800, fontStyle: 'normal', underline: false, align: 'center', color: from, letterSpacing: 2, lineHeight: 1.2, shadow: null, stroke: null, gradient: null } },
      { id: 'ai_head', type: 'text', name: 'Headline', x: 90, y: 280, w: 900, h: 260, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: headFit.text, fontFamily: headingFont, fontSize: headFit.fontSize, fontWeight: 800, fontStyle: 'normal', underline: false, align: 'center', color: '#ffffff', letterSpacing: 0, lineHeight: 1.05, shadow: { color: '#000000', blur: 10, offsetX: 0, offsetY: 4 }, stroke: null, gradient: null } },
      { id: 'ai_sub', type: 'text', name: 'Subheading', x: 140, y: 580, w: 800, h: 90, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: subFit.text, fontFamily: bodyFont, fontSize: subFit.fontSize, fontWeight: 400, fontStyle: 'normal', underline: false, align: 'center', color: '#e8ecf8', letterSpacing: 0, lineHeight: 1.3, shadow: null, stroke: null, gradient: null } },
      { id: 'ai_cta', type: 'shape', name: 'CTA button', x: 390, y: 720, w: 300, h: 88, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, shape: { kind: 'rect', fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 44, shadow: null } },
      { id: 'ai_cta_t', type: 'text', name: 'CTA text', x: 390, y: 736, w: 300, h: 56, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: ctaFit.text, fontFamily: headingFont, fontSize: ctaFit.fontSize, fontWeight: 800, fontStyle: 'normal', underline: false, align: 'center', color: accent, letterSpacing: 0, lineHeight: 1.2, shadow: null, stroke: null, gradient: null } },
    ],
    _ai: { prompt: name, suggestions: { headline, subheading: sub, cta, palette: { primary: from, secondary: to, accent }, fonts: { heading: headingFont, body: bodyFont } }, needsAttention },
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
  return { project: { id: project.id, name: project.name, type: project.type }, suggestions: content._ai.suggestions, needsAttention: content._ai.needsAttention || [], sourceProjectId: projectId || null };
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

// --- Extended providers (v2.5.0, items #63, #64, #66) --------------------------
// src/providers.js is owned by another builder in this round, so the new
// providers live here as an extension registry with the SAME rules: keys
// come from the encrypted provider_settings store (provider id) or env,
// never hardcoded; no key → PROVIDER_KEY_NEEDED, never a fake call.
// Keys are saved through POST /api/ai/providers/:id/key (routes/ai.js)
// and the active provider per kind through POST /api/ai/providers/active.
//   Video: Kling 3.0, Veo 3.0/3.1, PixVerse, Sora, Seedance (Edit/Extend)
//   Image: Seedream, Nano Banana (Gemini image), GPT Image (via OpenAI)
// Pexels (stock video) lives in src/openverse.js with the same store.
const EXTENDED_PROVIDERS = [
  { id: 'kling', kind: 'video', label: 'Video — Kling 3.0', envKey: 'KLING_API_KEY', defaultBaseUrl: 'https://api.klingai.com/v1', models: ['kling-v2.1', 'kling-v2.0'], defaultModel: 'kling-v2.1', phase: 250, about: 'Text/image-to-video (Kling 3.0). Auth is a Bearer JWT access token generated from your Kling AccessKey/SecretKey — paste the JWT here, not the raw keys.' },
  { id: 'veo', kind: 'video', label: 'Video — Veo 3.0 / 3.1 (Google)', envKey: 'VEO_API_KEY', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['veo-3.1-generate-preview', 'veo-3.0-generate-001'], defaultModel: 'veo-3.1-generate-preview', phase: 250, about: 'Text/image-to-video via the Google Gemini API (same free-tier key as Gemini works).' },
  { id: 'pixverse', kind: 'video', label: 'Video — PixVerse', envKey: 'PIXVERSE_API_KEY', defaultBaseUrl: 'https://app-api.pixverse.ai/openapi/v2', models: ['v4.5', 'v4'], defaultModel: 'v4.5', phase: 250, about: 'Text/image-to-video via the PixVerse OpenAPI (API-KEY header).' },
  { id: 'sora', kind: 'video', label: 'Video — Sora (OpenAI)', envKey: 'OPENAI_API_KEY', defaultBaseUrl: 'https://api.openai.com/v1', models: ['sora-2', 'sora-2-pro'], defaultModel: 'sora-2', phase: 250, about: 'Text-to-video via the OpenAI Videos API (same OpenAI key as the LLM/image providers).' },
  { id: 'seedance', kind: 'video', label: 'Video — Seedance (ByteDance)', envKey: 'SEEDANCE_API_KEY', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['seedance-1-0-20250617', 'seedance-1-0-lite-20250617'], defaultModel: 'seedance-1-0-20250617', phase: 250, about: 'AI Video / AI Edit / AI Extend via BytePlus Ark (Seedance). Edit refines existing footage; Extend lengthens a clip.' },
  { id: 'seedream', kind: 'image', label: 'Image — Seedream (ByteDance)', envKey: 'SEEDREAM_API_KEY', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seedream-4-0-250828'], defaultModel: 'doubao-seedream-4-0-250828', phase: 250, about: 'Text/image-to-image via BytePlus Ark (Seedream). Powers the AI Design Studio canvas.' },
  { id: 'nano-banana', kind: 'image', label: 'Image — Nano Banana (Gemini image)', envKey: 'GEMINI_API_KEY', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-flash-image'], defaultModel: 'gemini-2.5-flash-image', phase: 250, about: 'Image generation/editing via the Gemini image model (same free-tier Gemini key).' },
  { id: 'pexels', kind: 'stock', label: 'Stock video — Pexels', envKey: 'PEXELS_API_KEY', defaultBaseUrl: 'https://api.pexels.com', models: [], defaultModel: '', phase: 250, about: 'Free stock video search (Pexels API key, free at pexels.com/api). Powers Stock Assets video search.' },
];

function getExtendedProvider(id) { return EXTENDED_PROVIDERS.find((p) => p.id === id) || null; }

function resolveExtendedProvider(id) {
  const def = getExtendedProvider(id);
  if (!def) return null;
  const cfg = db.getProviderConfig(id) || {};
  let key = null;
  try {
    const row = (db.getProviderSettings() || []).find((r) => r.provider === id);
    if (row && row.api_key_encrypted) { try { key = decrypt(row.api_key_encrypted); } catch { key = null; } }
  } catch { /* ignore */ }
  if (!key) key = process.env[def.envKey] || null;
  const model = cfg.model || def.defaultModel;
  return { ...def, key, baseUrl: (cfg.base_url || def.defaultBaseUrl).replace(/\/$/, ''), model, configured: Boolean(key), source: key ? 'stored (encrypted)' : 'none' };
}

function extendedProviderStatus() {
  return EXTENDED_PROVIDERS.map((p) => {
    const r = resolveExtendedProvider(p.id);
    return {
      id: p.id, kind: p.kind, label: p.label, models: p.models, model: r.model,
      baseUrl: r.baseUrl, defaultBaseUrl: p.defaultBaseUrl, phase: p.phase,
      configured: r.configured, active: db.getActiveProvider(p.kind) === p.id,
      source: r.source, maskedKey: r.configured ? '••••••••' : '',
      status: r.configured ? 'configured' : 'key_needed', about: p.about,
      note: r.configured ? 'Key saved. Live AI calls are enabled.' : 'No API key configured. AI features using this provider will refuse with "key needed" until a key is added in AI Studio → Providers.',
    };
  });
}

function requireExtendedProvider(id) {
  const r = resolveExtendedProvider(id);
  if (!r) throw new Error(`Unknown provider: ${id}`);
  if (!r.configured) {
    const err = new Error(`AI provider "${r.label}" is not configured: no API key. Add one in AI Studio → Providers. No output was created.`);
    err.code = 'PROVIDER_KEY_NEEDED';
    err.provider = id;
    throw err;
  }
  return r;
}

// The active video/image provider, extended ids included: an active pref
// naming an extended provider wins; otherwise the core registry decides.
function resolveVideoProvider() {
  const active = db.getActiveProvider('video');
  if (active && getExtendedProvider(active)) return resolveExtendedProvider(active);
  return providers.resolveProvider(providers.activeProviderForKind('video'));
}
function resolveImageProvider() {
  const active = db.getActiveProvider('image');
  if (active && getExtendedProvider(active)) return resolveExtendedProvider(active);
  return providers.resolveProvider(providers.activeProviderForKind('image'));
}

// --- Extended image generation: Seedream / Nano Banana (#64) -----------------
async function generateImageExtended(p, userId, { prompt, size = '1:1', sourceMediaId } = {}, signal) {
  const clean = String(prompt || '').trim();
  const sizeMap = { '1:1': '1024x1024', '9:16': '1024x1792', '16:9': '1792x1024' };
  let buffer;
  let providerName;
  if (p.id === 'seedream') {
    // BytePlus Ark images API (OpenAI-compatible shape).
    const body = { model: p.model, prompt: clean, size: sizeMap[size] || '1024x1024', response_format: 'b64_json' };
    if (sourceMediaId) {
      const media = db.getMedia(userId, sourceMediaId);
      if (!media || media.kind !== 'image') throw new Error('Seedream image-to-image needs a source image.');
      const buf = fs.readFileSync(mediaFilePath(userId, media));
      body.image = `data:${media.mime_type || 'image/png'};base64,${buf.toString('base64')}`;
    }
    const res = await providers.fetchWithRetry(`${p.baseUrl}/images/generations`, {
      method: 'POST', headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal,
    }, 120000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    const json = await res.json();
    const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
    if (!b64) throw new Error('Seedream returned no image data.');
    buffer = Buffer.from(b64, 'base64');
    providerName = `seedream-${p.model}`;
  } else if (p.id === 'nano-banana') {
    // Gemini image model: generateContent with inlineData response.
    const parts = [{ text: clean }];
    if (sourceMediaId) {
      const media = db.getMedia(userId, sourceMediaId);
      if (!media || media.kind !== 'image') throw new Error('Nano Banana image-to-image needs a source image.');
      const buf = fs.readFileSync(mediaFilePath(userId, media));
      parts.push({ inline_data: { mime_type: media.mime_type || 'image/png', data: buf.toString('base64') } });
    }
    const res = await providers.fetchWithRetry(`${p.baseUrl}/models/${encodeURIComponent(p.model)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': p.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }), signal,
    }, 120000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    const json = await res.json();
    const cand = json && json.candidates && json.candidates[0];
    const part = cand && cand.content && cand.content.parts && cand.content.parts.find((x) => x.inlineData && x.inlineData.data);
    if (!part) throw new Error('Nano Banana returned no image data.');
    buffer = Buffer.from(part.inlineData.data, 'base64');
    providerName = `nano-banana-${p.model}`;
  } else {
    throw new Error(`Extended image provider "${p.id}" is not implemented.`);
  }
  const stamp = Date.now().toString(36);
  const saved = await saveGeneratedBuffer(userId, {
    buffer, name: `ai-image-${stamp}.png`, kind: 'image', mimeType: 'image/png', tags: 'ai-generated',
  });
  credits.chargeCredits(userId, 'ai_image', `Generated image (${providerName}): "${clean.slice(0, 80)}"`);
  return { media: saved.media, filePath: saved.filePath, url: mediaUrl(saved.media), provider: providerName, prompt: clean };
}

// --- Extended video generation (#63, #66) ------------------------------------
// One generic create→poll→download flow per provider, each against that
// provider's real documented API. The provider's own error text is
// surfaced (friendly, one line) — a 401/404 from a provider is reported,
// never papered over with a fake file.
async function pollVideoTask(p, task, signal, onProgress) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let polls = 0;
  for (;;) {
    if (signal && signal.aborted) throw cancelledError();
    const poll = task.poll;
    const res = await providers.fetchWithRetry(poll.url(), {
      method: 'GET', headers: poll.headers(), signal,
    }, 30000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    const json = await res.json();
    polls += 1;
    if (onProgress) onProgress(Math.min(85, 30 + polls * 4));
    const out = task.parsePoll(json);
    if (out.done) return out.url;
    if (out.failed) throw new Error(`Video generation failed: ${String(out.reason || 'no detail').slice(0, 300)}`);
    if (Date.now() > deadline) throw new Error('Video generation timed out after 10 minutes (the provider task never finished).');
    await sleep(5000);
  }
}

async function generateVideoExtended(userId, { providerId, prompt, sourceMediaId, duration = 5, aspect = '16:9', mode = 'generate', editPrompt } = {}, signal, onProgress) {
  const p = requireExtendedProvider(providerId);
  const clean = String(prompt || '').trim();
  if (!clean && mode === 'generate') throw new Error('A video prompt is required.');
  const secs = Math.max(2, Math.min(16, parseInt(duration, 10) || 5));
  const ratio = aspect === '9:16' ? '9:16' : '16:9';
  let sourceDataUri = null;
  if (sourceMediaId) {
    const media = db.getMedia(userId, sourceMediaId);
    if (!media) throw new Error('Source media not found in your Media Library.');
    // Seedance Extend takes a VIDEO source (validated in the seedance
    // branch below); every other mode needs an image reference.
    if (mode !== 'extend') {
      if (media.kind !== 'image') throw new Error('Image-to-video needs a source image.');
      const buf = fs.readFileSync(mediaFilePath(userId, media));
      sourceDataUri = `data:${media.mime_type || 'image/png'};base64,${buf.toString('base64')}`;
    }
  }
  const text = mode === 'edit' && editPrompt ? `${clean}\nEdit instruction: ${editPrompt}` : clean;
  let task;
  if (p.id === 'kling') {
    const body = { model_name: p.model, prompt: text, duration: String(secs), aspect_ratio: ratio, mode: 'std' };
    if (sourceDataUri) body.image_url = sourceDataUri;
    const res = await providers.fetchWithRetry(`${p.baseUrl}/videos/text2video`, {
      method: 'POST', headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal,
    }, 60000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    const json = await res.json();
    const taskId = json && json.data && json.data.task_id;
    if (!taskId) throw new Error('Kling did not return a task id.');
    task = { poll: { url: () => `${p.baseUrl}/videos/${encodeURIComponent(taskId)}`, headers: () => ({ Authorization: `Bearer ${p.key}` }) }, parsePoll: (j) => {
      const d = j && j.data;
      const st = String(d && d.task_status || '').toLowerCase();
      if (st === 'succeed') return { done: true, url: d.task_result && d.task_result.videos && d.task_result.videos[0] && d.task_result.videos[0].url };
      if (st === 'failed') return { failed: true, reason: d.task_status_msg };
      return { done: false };
    } };
  } else if (p.id === 'veo') {
    const model = p.model;
    const res = await providers.fetchWithRetry(`${p.baseUrl}/models/${encodeURIComponent(model)}:predictLongRunning`, {
      method: 'POST', headers: { 'x-goog-api-key': p.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: [{ prompt: text, ...(sourceDataUri ? { image: { bytesBase64Encoded: sourceDataUri.split(',')[1] } } : {}) }], parameters: { aspectRatio: ratio, durationSeconds: secs } }), signal,
    }, 60000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    const json = await res.json();
    const opName = json && json.name;
    if (!opName) throw new Error('Veo did not return an operation name.');
    task = { poll: { url: () => `${p.baseUrl}/${opName}`, headers: () => ({ 'x-goog-api-key': p.key }) }, parsePoll: (j) => {
      if (j.done) {
        const sample = j.response && j.response.generateVideoResponse && j.response.generateVideoResponse.generatedSamples && j.response.generateVideoResponse.generatedSamples[0];
        const uri = sample && sample.video && sample.video.uri;
        if (!uri) return { failed: true, reason: 'Veo finished without a video URL.' };
        return { done: true, url: uri };
      }
      if (j.error) return { failed: true, reason: j.error.message };
      return { done: false };
    } };
  } else if (p.id === 'pixverse') {
    const res = await providers.fetchWithRetry(`${p.baseUrl}/video/text/generate`, {
      method: 'POST', headers: { 'API-KEY': p.key, 'Content-Type': 'application/json', 'Ai-Trace-Id': `cs-${Date.now()}` },
      body: JSON.stringify({ model: p.model, prompt: text, duration, aspect_ratio: ratio, ...(sourceDataUri ? { image_url: sourceDataUri } : {}) }), signal,
    }, 60000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    const json = await res.json();
    if (json.ErrCode !== 0) throw new Error(`PixVerse rejected the request (${json.ErrCode}): ${String(json.ErrMsg || 'no detail').slice(0, 300)}`);
    const videoId = json.Resp && json.Resp.video_id;
    if (!videoId) throw new Error('PixVerse did not return a video id.');
    task = { poll: { url: () => `${p.baseUrl}/video/result/${encodeURIComponent(videoId)}`, headers: () => ({ 'API-KEY': p.key }) }, parsePoll: (j) => {
      const r = j && j.Resp;
      const st = r && Number(r.status);
      if (st === 1) return { done: true, url: r.url };
      if (st === 5 || st === 6) return { failed: true, reason: r.err_msg || `status ${st}` };
      return { done: false };
    } };
  } else if (p.id === 'sora') {
    const res = await providers.fetchWithRetry(`${p.baseUrl}/videos`, {
      method: 'POST', headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: p.model, prompt: text, seconds: secs, size: ratio === '9:16' ? '720x1280' : '1280x720' }), signal,
    }, 60000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    const json = await res.json();
    const videoId = json && json.id;
    if (!videoId) throw new Error('Sora did not return a video id.');
    task = { poll: { url: () => `${p.baseUrl}/videos/${encodeURIComponent(videoId)}`, headers: () => ({ Authorization: `Bearer ${p.key}` }) }, parsePoll: (j) => {
      const st = String(j && j.status || '').toLowerCase();
      if (st === 'completed') return { done: true, url: `${p.baseUrl}/videos/${encodeURIComponent(videoId)}/content`, _soraContent: true };
      if (st === 'failed') return { failed: true, reason: j.error && j.error.message };
      return { done: false };
    } };
    const outputUrl = await pollVideoTask(p, task, signal, onProgress);
    // Sora's /content endpoint needs the Bearer key, not a plain download.
    const dl = await providers.fetchWithRetry(outputUrl, { headers: { Authorization: `Bearer ${p.key}` }, signal }, 300000);
    if (!dl.ok) throw new Error(`Could not download the generated video (${dl.status}).`);
    const buffer = Buffer.from(await dl.arrayBuffer());
    const stamp = Date.now().toString(36);
    const saved = await saveGeneratedBuffer(userId, { buffer, name: `ai-video-${stamp}.mp4`, kind: 'video', mimeType: 'video/mp4', tags: 'ai-generated' });
    credits.chargeCredits(userId, 'ai_video', `Generated video (Sora ${p.model}, ${secs}s): "${clean.slice(0, 80)}"`);
    return { media: saved.media, filePath: saved.filePath, url: mediaUrl(saved.media), provider: `sora-${p.model}`, prompt: clean, taskId: videoId };
  } else if (p.id === 'seedance') {
    // BytePlus Ark contents API: generate / edit / extend are the same
    // endpoint with different content blocks. Edit/Extend need a source
    // video: for Extend the source is a video media row; for Edit the
    // source image/video is the reference.
    let content;
    if (mode === 'extend') {
      if (!sourceMediaId) throw new Error('Seedance Extend needs a source video to lengthen.');
      const media = db.getMedia(userId, sourceMediaId);
      if (!media || media.kind !== 'video') throw new Error('Seedance Extend needs a source video.');
      content = { type: 'video', video_url: `file://${mediaFilePath(userId, media)}`, text: text || 'Extend this video naturally.' };
      // Ark cannot fetch a local file — honest limitation: Extend uploads
      // are not supported from a local-only install without a public URL.
      throw new Error('Seedance Extend needs the source video at a publicly reachable URL — this local install cannot provide one. Upload the clip somewhere public first, or use a local FFmpeg loop/extend instead (see video-enhance).');
    } else if (mode === 'edit') {
      if (!sourceDataUri) throw new Error('Seedance Edit needs a source image or video frame to refine.');
      content = { type: 'image', image_url: sourceDataUri, text: text || editPrompt || 'Refine this footage.' };
    } else {
      content = { type: 'text', text };
      if (sourceDataUri) content.image_url = sourceDataUri;
    }
    const res = await providers.fetchWithRetry(`${p.baseUrl}/contents/generations`, {
      method: 'POST', headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: p.model, content, resolution: ratio === '9:16' ? '720p' : '720p', duration: secs, camerafixed: false, mode: 'pro' }), signal,
    }, 60000);
    if (!res.ok) throw providerError(p.label, res, await res.text().catch(() => ''));
    const json = await res.json();
    const taskId = json && json.id;
    if (!taskId) throw new Error('Seedance did not return a task id.');
    task = { poll: { url: () => `${p.baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`, headers: () => ({ Authorization: `Bearer ${p.key}` }) }, parsePoll: (j) => {
      const st = String(j && j.status || '').toLowerCase();
      if (st === 'succeeded') return { done: true, url: j.content && j.content.video_url };
      if (st === 'failed') return { failed: true, reason: j.error && (j.error.message || j.error.code) };
      return { done: false };
    } };
  } else {
    throw new Error(`Extended video provider "${p.id}" is not implemented.`);
  }
  if (onProgress) onProgress(25);
  const outputUrl = await pollVideoTask(p, task, signal, onProgress);
  if (!outputUrl) throw new Error('The video provider finished but returned no output URL.');
  if (onProgress) onProgress(90);
  const headers = p.id === 'veo' ? { 'x-goog-api-key': p.key } : {};
  const dl = await providers.fetchWithRetry(outputUrl, { headers, signal }, 300000);
  if (!dl.ok) throw new Error(`Could not download the generated video (${dl.status}).`);
  const buffer = Buffer.from(await dl.arrayBuffer());
  const stamp = Date.now().toString(36);
  const saved = await saveGeneratedBuffer(userId, {
    buffer, name: `ai-video-${stamp}.mp4`, kind: 'video', mimeType: 'video/mp4', tags: 'ai-generated',
  });
  credits.chargeCredits(userId, 'ai_video', `Generated video (${p.id} ${p.model}, ${secs}s): "${clean.slice(0, 80)}"`);
  return { media: saved.media, filePath: saved.filePath, url: mediaUrl(saved.media), provider: `${p.id}-${p.model}`, prompt: clean };
}

// --- Local video processing (v2.5.0, items #45, #60, #68) ----------------------
// All of these are REAL FFmpeg operations on the user's own media — no key,
// no provider, no fake output. Filters were verified present in this
// FFmpeg build: hqdn3d (denoise), deflicker, smartblur, eq, silencedetect.
function mediaPathFor(userId, mediaId) {
  const media = db.getMedia(userId, mediaId);
  if (!media) throw new Error('Media not found.');
  const filePath = mediaFilePath(userId, media);
  if (!fs.existsSync(filePath)) throw new Error('The media file is missing on disk.');
  return { media, filePath };
}

async function runFfmpegFile(args, { timeout = 300000 } = {}) {
  await run('ffmpeg', args, { timeout });
}

async function saveProcessedVideo(userId, { srcPath, filter, name, extraArgs = [] }) {
  const stamp = Date.now().toString(36);
  const outName = `${name}-${stamp}.mp4`;
  const dir = path.join(config.uploadsDir, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, outName);
  const args = ['-y', '-v', 'error', '-i', srcPath];
  if (filter) args.push('-vf', filter);
  args.push(...extraArgs, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outPath);
  await runFfmpegFile(args);
  const probe = await probeMedia(outPath);
  const media = db.createMedia(userId, {
    originalName: outName, storedName: outName, mimeType: 'video/mp4', kind: 'video',
    sizeBytes: fs.statSync(outPath).size,
    width: probe && probe.width, height: probe && probe.height,
    durationSeconds: probe && probe.durationSeconds, tags: 'ai-processed',
  });
  return { media, filePath: outPath, url: mediaUrl(media), probe };
}

// #60 — video enhance / denoise / deflicker / upscale (local FFmpeg).
// 'upscale' is a real Lanczos upscale + sharpen, NOT an AI upscaler — it
// is labelled as such in the result. 'expand'/'remix'/'relight' need a
// video AI provider key (Seedance/Runway) and refuse honestly without one.
async function enhanceVideo(userId, { mediaId, kind = 'denoise', strength = 3 } = {}) {
  const { media, filePath } = mediaPathFor(userId, mediaId);
  if (media.kind !== 'video') throw new Error('Video enhancement needs a video file.');
  const s = Math.max(1, Math.min(10, Number(strength) || 3));
  if (kind === 'denoise') {
    const out = await saveProcessedVideo(userId, { srcPath: filePath, filter: `hqdn3d=${s}:${s}:${s * 2}:${s * 2}`, name: 'denoised' });
    return { ...out, kind, method: 'FFmpeg hqdn3d (local denoise)', note: 'Local denoise — no AI model involved.' };
  }
  if (kind === 'deflicker') {
    const out = await saveProcessedVideo(userId, { srcPath: filePath, filter: 'deflicker=size=10:mode=am', name: 'deflickered' });
    return { ...out, kind, method: 'FFmpeg deflicker (local)', note: 'Removes temporal luminance flicker.' };
  }
  if (kind === 'enhance') {
    const out = await saveProcessedVideo(userId, { srcPath: filePath, filter: 'eq=brightness=0.04:contrast=1.08:saturation=1.08,unsharp=5:5:0.6:5:5:0.0', name: 'enhanced' });
    return { ...out, kind, method: 'FFmpeg eq + unsharp (local grade)', note: 'Local contrast/colour/sharpness pass — not an AI enhancer.' };
  }
  if (kind === 'upscale') {
    const probe = await probeMedia(filePath);
    const w = (probe.width || 1280) * 2, h = (probe.height || 720) * 2;
    const out = await saveProcessedVideo(userId, { srcPath: filePath, filter: `scale=${w}:${h}:flags=lanczos,unsharp=5:5:0.5:5:5:0.0`, name: 'upscaled' });
    return { ...out, kind, method: `FFmpeg Lanczos upscale to ${w}x${h} (local)`, note: 'Lanczos upscale + sharpen — NOT an AI upscaler; it cannot invent detail.' };
  }
  if (['expand', 'remix', 'relight'].includes(kind)) {
    const p = resolveVideoProvider();
    if (!p.configured) throw keyNeededError(p.label, `AI video ${kind} needs a video provider key (Seedance or Runway). Add one in AI Studio → Providers.`);
    throw new Error(`AI video ${kind} needs the Seedance provider: set Seedance as the active video provider in AI Studio → Providers, then run the 'seedance' job with mode 'edit'.`);
  }
  throw new Error(`Unknown enhancement kind: ${kind}. Use denoise, deflicker, enhance, upscale, expand, remix or relight.`);
}

// #68 — retouch / beauty (local, frame-level, honestly labelled).
// smartblur + eq genuinely smooth skin tones and even out colour on the
// WHOLE frame. Face-tracked smoothing, blemish removal, makeup, body
// slimming, halos and face mosaic need a face/body ML model this install
// does not have — those kinds refuse with NOT_AVAILABLE, never a fake.
async function retouchVideo(userId, { mediaId, kind = 'smooth', intensity = 50 } = {}) {
  const { media, filePath } = mediaPathFor(userId, mediaId);
  if (media.kind !== 'video' && media.kind !== 'image') throw new Error('Retouch needs a video or image file.');
  const pct = Math.max(0, Math.min(100, Number(intensity) || 50));
  if (kind === 'smooth' || kind === 'skin') {
    const radius = (0.5 + pct / 50).toFixed(2);
    const strength = (pct / 100).toFixed(2);
    if (media.kind === 'image') {
      const stamp = Date.now().toString(36);
      const outName = `retouched-${stamp}.png`;
      const dir = path.join(config.uploadsDir, String(userId));
      const outPath = path.join(dir, outName);
      await runFfmpegFile(['-y', '-v', 'error', '-i', filePath, '-vf', `smartblur=lr=${radius}:ls=${strength}:lt=0,eq=saturation=${(1 + pct / 400).toFixed(2)}`, '-frames:v', '1', outPath]);
      const probe = await probeMedia(outPath);
      const m = db.createMedia(userId, { originalName: outName, storedName: outName, mimeType: 'image/png', kind: 'image', sizeBytes: fs.statSync(outPath).size, width: probe && probe.width, height: probe && probe.height, tags: 'ai-processed,retouch' });
      return { media: m, filePath: outPath, url: mediaUrl(m), kind, method: 'FFmpeg smartblur + eq (frame-level)', note: 'Frame-level smoothing — it softens the whole frame, not just faces. No face tracking in this build.' };
    }
    const out = await saveProcessedVideo(userId, { srcPath: filePath, filter: `smartblur=lr=${radius}:ls=${strength}:lt=0,eq=saturation=${(1 + pct / 400).toFixed(2)}`, name: 'retouched' });
    return { ...out, kind, method: 'FFmpeg smartblur + eq (frame-level)', note: 'Frame-level smoothing — it softens the whole frame, not just faces. No face tracking in this build.' };
  }
  const unavailable = ['blemish', 'makeup', 'slim', 'halo', 'mosaic', 'outline', 'dynamic-lines', 'reshape', 'hair'];
  if (unavailable.includes(kind)) {
    const err = new Error(`Retouch "${kind}" is not available in this build: it needs a face/body ML model (face detection + segmentation) that is not installed. What works locally: smooth / skin tone (frame-level smartblur).`);
    err.code = 'NOT_AVAILABLE';
    throw err;
  }
  throw new Error(`Unknown retouch kind: ${kind}. Use smooth, skin, blemish, makeup, slim, halo, mosaic, outline, dynamic-lines, reshape or hair.`);
}

// #45 — silence detection + removal (ffmpeg silencedetect, real).
async function detectSilenceFor(userId, { mediaId, thresholdDb = -35, minDuration = 0.5 } = {}) {
  const { media, filePath } = mediaPathFor(userId, mediaId);
  if (media.kind !== 'video' && media.kind !== 'audio') throw new Error('Silence detection needs an audio or video file.');
  const { detectSilence } = require('./shorts-analysis');
  const silences = await detectSilence(filePath, Number(thresholdDb) || -35, Number(minDuration) || 0.5);
  const probe = await probeMedia(filePath);
  const duration = (probe && probe.durationSeconds) || 0;
  const kept = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) kept.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) kept.push({ start: cursor, end: duration });
  return { mediaId: media.id, durationSeconds: duration, thresholdDb: Number(thresholdDb) || -35, silences, keptSegments: kept, silentSeconds: silences.reduce((a, s) => a + (s.end - s.start), 0) };
}

async function removeSilence(userId, { mediaId, thresholdDb = -35, minDuration = 0.5, keepPadding = 0.15 } = {}) {
  const det = await detectSilenceFor(userId, { mediaId, thresholdDb, minDuration });
  const { filePath } = mediaPathFor(userId, mediaId);
  if (!det.keptSegments.length) throw new Error('The whole file is silent at this threshold — nothing to keep. Lower the silence threshold and try again.');
  const pad = Math.max(0, Math.min(1, Number(keepPadding) || 0));
  const segs = det.keptSegments.map((s) => ({ start: Math.max(0, s.start - pad), end: Math.min(det.durationSeconds, s.end + pad) })).filter((s) => s.end - s.start > 0.1);
  const tmpDir = path.join(config.rendersDir, `silence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const parts = [];
    for (let i = 0; i < segs.length; i++) {
      const part = path.join(tmpDir, `part-${i}.mp4`);
      await runFfmpegFile(['-y', '-v', 'error', '-ss', String(segs[i].start), '-to', String(segs[i].end), '-i', filePath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', part]);
      parts.push(part);
    }
    const listPath = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listPath, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const stamp = Date.now().toString(36);
    const outName = `silence-removed-${stamp}.mp4`;
    const outPath = path.join(config.uploadsDir, String(userId), outName);
    await runFfmpegFile(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
    const probe = await probeMedia(outPath);
    const media = db.createMedia(userId, {
      originalName: outName, storedName: outName, mimeType: 'video/mp4', kind: 'video',
      sizeBytes: fs.statSync(outPath).size,
      width: probe && probe.width, height: probe && probe.height,
      durationSeconds: probe && probe.durationSeconds, tags: 'ai-processed,silence-removed',
    });
    return { media, filePath: outPath, url: mediaUrl(media), removedSeconds: det.silentSeconds, keptSegments: segs, originalDuration: det.durationSeconds, newDuration: probe && probe.durationSeconds };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// #45 — transcript-based editing: the user edits the transcript text;
// the words they DELETE are cut from the video. Cues come from STT or a
// manual transcript (params.cues: [{start,end,text}]); params.keep is the
// edited text — cues whose words are all absent from keep are cut.
async function transcriptEdit(userId, { mediaId, cues, keepText } = {}) {
  const { media, filePath } = mediaPathFor(userId, mediaId);
  if (media.kind !== 'video') throw new Error('Transcript editing needs a video file.');
  if (!Array.isArray(cues) || !cues.length) throw new Error('Transcript cues are required (transcribe the video first, or paste a timed transcript).');
  const keep = String(keepText || '').toLowerCase();
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06FF ]/g, ' ').split(/\s+/).filter(Boolean);
  const keepWords = new Set(norm(keep));
  const kept = [];
  const cut = [];
  for (const c of cues) {
    const words = norm(c.text);
    const keptWords = words.filter((w) => keepWords.has(w));
    if (words.length && keptWords.length === 0) cut.push(c);
    else kept.push(c);
  }
  if (!kept.length) throw new Error('The edited transcript keeps nothing — every cue was cut. Keep at least one line.');
  // Merge kept cues into contiguous segments (gap < 0.5s joins).
  const segs = [];
  for (const c of kept) {
    const last = segs[segs.length - 1];
    if (last && c.start - last.end < 0.5) last.end = Math.max(last.end, c.end);
    else segs.push({ start: c.start, end: c.end });
  }
  const tmpDir = path.join(config.rendersDir, `transcript-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const parts = [];
    for (let i = 0; i < segs.length; i++) {
      const part = path.join(tmpDir, `part-${i}.mp4`);
      await runFfmpegFile(['-y', '-v', 'error', '-ss', String(segs[i].start), '-to', String(segs[i].end), '-i', filePath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', part]);
      parts.push(part);
    }
    const listPath = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listPath, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const stamp = Date.now().toString(36);
    const outName = `transcript-cut-${stamp}.mp4`;
    const outPath = path.join(config.uploadsDir, String(userId), outName);
    await runFfmpegFile(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
    const probe = await probeMedia(outPath);
    const m = db.createMedia(userId, {
      originalName: outName, storedName: outName, mimeType: 'video/mp4', kind: 'video',
      sizeBytes: fs.statSync(outPath).size,
      width: probe && probe.width, height: probe && probe.height,
      durationSeconds: probe && probe.durationSeconds, tags: 'ai-processed,transcript-cut',
    });
    return { media: m, filePath: outPath, url: mediaUrl(m), cutCues: cut.length, keptCues: kept.length, segments: segs };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// #44 — AutoCut: pick clips/photos → a styled first edit (music +
// template), editable after as a real video project.
async function autocut(userId, { mediaIds, template = 'cinematic', musicMediaId, name } = {}) {
  if (!Array.isArray(mediaIds) || mediaIds.length < 2) throw new Error('AutoCut needs at least 2 clips or photos.');
  const { blankTimeline, defaultClip, validateTimeline } = require('./video-model');
  const tl = blankTimeline('16:9', 30);
  const templates = {
    cinematic: { clipSeconds: 3, transition: { type: 'fade', duration: 0.5 } },
    energetic: { clipSeconds: 1.5, transition: { type: 'slide', duration: 0.4 } },
    calm: { clipSeconds: 4, transition: { type: 'fade', duration: 1 } },
  };
  const tpl = templates[template] || templates.cinematic;
  let cursor = 0;
  for (const id of mediaIds) {
    const { media, filePath } = mediaPathFor(userId, id);
    if (media.kind !== 'video' && media.kind !== 'image') throw new Error(`AutoCut needs video or photo files (media #${id} is ${media.kind}).`);
    const probe = await probeMedia(filePath);
    const dur = media.kind === 'image' ? tpl.clipSeconds : Math.min(tpl.clipSeconds, probe.durationSeconds || tpl.clipSeconds);
    const clip = defaultClip(media.kind, media.id, cursor, dur);
    clip.name = media.original_name;
    clip.transition = { ...tpl.transition };
    tl.tracks[0].clips.push(clip);
    cursor += dur;
  }
  if (musicMediaId) {
    const { media } = mediaPathFor(userId, musicMediaId);
    if (media.kind !== 'audio') throw new Error('AutoCut music must be an audio file.');
    const audio = defaultClip('audio', media.id, 0, cursor);
    audio.name = media.original_name;
    audio.volume = 0.7;
    tl.tracks[1].clips.push(audio);
  }
  const errors = validateTimeline(tl);
  if (errors.length) throw new Error('AutoCut timeline is invalid: ' + errors.join(' '));
  const project = db.createProject(userId, {
    name: (name || `AutoCut — ${template}`).slice(0, 120),
    type: 'video', content: tl,
  });
  credits.chargeCredits(userId, 'ai_video', `AutoCut assembled ${mediaIds.length} clips (${template} template) → project ${project.id}`);
  return { project: { id: project.id, name: project.name, type: project.type }, clips: mediaIds.length, durationSeconds: cursor, template };
}

// #62 — EditPilot: prompt-driven first-pass edit. The LLM plans timeline
// ops (trim / cut-silence / remove-filler / reorder / transitions /
// alternate version); ops are validated against the real timeline and
// applied as real timeline edits. Without an LLM key it refuses.
async function editPilot(userId, { projectId, prompt, alternate = false } = {}, signal) {
  const clean = String(prompt || '').trim();
  if (!clean) throw new Error('EditPilot needs a prompt (e.g. "trim the intro, remove pauses, make it punchier").');
  const project = db.getProject(userId, projectId);
  if (!project) throw new Error('Video project not found.');
  if (project.type !== 'video') throw new Error('EditPilot needs a video project.');
  let tl;
  try { tl = JSON.parse(project.content || '{}'); } catch { throw new Error('Video project content is unreadable.'); }
  const { validateTimeline } = require('./video-model');
  const clips = (tl.tracks || []).flatMap((t) => (t.clips || []).map((c) => ({ id: c.id, kind: c.kind, name: c.name, start: c.start, duration: c.duration, mediaId: c.mediaId })));
  const plan = await chatJson(userId, {
    system: 'You are a video editor planning a first-pass edit. Reply with valid JSON only, no other text.',
    user: `EditPilot plan. Prompt: "${clean}". Timeline clips: ${JSON.stringify(clips)}. Reply as {"ops":[{"op":"trim","clipId":"...","start":0,"duration":2},{"op":"remove","clipId":"..."},{"op":"reorder","clipId":"...","toIndex":0},{"op":"transition","clipId":"...","type":"fade","duration":0.5},{"op":"rename","clipId":"...","name":"..."}]}. Rules: only use clip ids from the list; trim durations must be > 0 and within the clip; toIndex must be a valid position on that clip's track; transition type must be none/fade/dissolve/slide/wipe. If nothing in the prompt maps to a real op, return {"ops":[]} with no invented clips.`,
  }, signal);
  const ops = Array.isArray(plan.ops) ? plan.ops : [];
  const applied = [];
  const skipped = [];
  const findClip = (id) => {
    for (const t of tl.tracks || []) {
      const i = (t.clips || []).findIndex((c) => c.id === id);
      if (i >= 0) return { track: t, index: i, clip: t.clips[i] };
    }
    return null;
  };
  for (const op of ops) {
    const found = op.clipId ? findClip(op.clipId) : null;
    if (!found) { skipped.push(`Unknown clip "${op.clipId}" — skipped.`); continue; }
    if (op.op === 'trim') {
      const start = Number(op.start);
      const dur = Number(op.duration);
      if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0 || start < 0 || start + dur > found.clip.duration + 0.01) { skipped.push(`Trim on "${found.clip.name}" is out of range — skipped.`); continue; }
      found.clip.srcStart = (found.clip.srcStart || 0) + start;
      found.clip.duration = dur;
      applied.push(`Trimmed "${found.clip.name}" to ${dur}s.`);
    } else if (op.op === 'remove') {
      found.track.clips.splice(found.index, 1);
      applied.push(`Removed "${found.clip.name}".`);
    } else if (op.op === 'reorder') {
      const to = Number(op.toIndex);
      if (!Number.isInteger(to) || to < 0 || to >= found.track.clips.length) { skipped.push(`Reorder of "${found.clip.name}" is out of range — skipped.`); continue; }
      const [c] = found.track.clips.splice(found.index, 1);
      found.track.clips.splice(to, 0, c);
      applied.push(`Moved "${c.name}" to position ${to + 1}.`);
    } else if (op.op === 'transition') {
      if (!['none', 'fade', 'dissolve', 'slide', 'wipe'].includes(op.type)) { skipped.push(`Transition "${op.type}" is not supported — skipped.`); continue; }
      found.clip.transition = { type: op.type, duration: Math.max(0.1, Math.min(5, Number(op.duration) || 0.5)) };
      applied.push(`Set "${found.clip.name}" transition to ${op.type}.`);
    } else if (op.op === 'rename') {
      found.clip.name = String(op.name || found.clip.name).slice(0, 120);
      applied.push(`Renamed a clip to "${found.clip.name}".`);
    } else skipped.push(`Unknown op "${op.op}" — skipped.`);
  }
  // Re-time the video track sequentially after edits.
  for (const t of tl.tracks || []) {
    if (t.kind !== 'video') continue;
    let cur = 0;
    for (const c of t.clips || []) { c.start = cur; cur += c.duration; }
  }
  const errors = validateTimeline(tl);
  if (errors.length) throw new Error('EditPilot produced an invalid timeline: ' + errors.join(' '));
  let outProject = project;
  if (alternate) {
    outProject = db.createProject(userId, { name: `${project.name} (EditPilot alternate)`, type: 'video', content: tl });
  } else {
    db.updateProject(userId, project.id, { content: tl });
    outProject = db.getProject(userId, project.id);
  }
  return { project: { id: outProject.id, name: outProject.name, type: 'video' }, applied, skipped, alternate: Boolean(alternate) };
}

// #61 — Video translator / AI dubbing: STT → LLM translate → TTS dub →
// mixed back over the video (original audio lowered to 20%).
async function translateVideo(userId, { mediaId, fromLanguage, toLanguage = 'en', voiceProfileId } = {}, signal) {
  const { media, filePath } = mediaPathFor(userId, mediaId);
  if (media.kind !== 'video') throw new Error('Video translation needs a video file.');
  const t = await transcribeAudio(userId, media.id, { language: fromLanguage }, signal);
  if (!t.text) throw new Error('No speech was found to translate.');
  const out = await chatJson(userId, {
    system: 'You are a professional translator. Reply with valid JSON only, no other text.',
    user: `Translate this transcript to ${toLanguage}. Keep the same line breaks and meaning; do not add commentary. Transcript:\n${t.text}\nReply as {"text":"the full translated transcript"}.`,
  }, signal);
  const translated = String(out.text || '').trim();
  if (!translated) throw new Error('The LLM returned no translation.');
  const spoken = await synthesizeVoice(userId, { text: translated, voiceProfileId });
  const dubPath = mediaFilePath(userId, spoken.media);
  const stamp = Date.now().toString(36);
  const outName = `dubbed-${toLanguage}-${stamp}.mp4`;
  const outPath = path.join(config.uploadsDir, String(userId), outName);
  await runFfmpegFile(['-y', '-v', 'error', '-i', filePath, '-i', dubPath,
    '-filter_complex', '[0:a]volume=0.2[orig];[1:a]volume=1.0[dub];[orig][dub]amix=inputs=2:duration=first:dropout_transition=0[aout]',
    '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outPath]);
  const probe = await probeMedia(outPath);
  const m = db.createMedia(userId, {
    originalName: outName, storedName: outName, mimeType: 'video/mp4', kind: 'video',
    sizeBytes: fs.statSync(outPath).size,
    width: probe && probe.width, height: probe && probe.height,
    durationSeconds: probe && probe.durationSeconds, tags: 'ai-processed,dubbed',
  });
  return { media: m, filePath: outPath, url: mediaUrl(m), fromLanguage: fromLanguage || 'auto', toLanguage, originalText: t.text, translatedText: translated, provider: spoken.provider };
}

// #65 — Director Mode: continuity bible (characters/scenes/props) + first
// scene script, as a real doc project; first scene image via image provider.
// #65 — AI avatars: script + photo → TTS voice + a photo-avatar video
// (static photo + voice). Lip-sync is NOT available — the result says so.
async function directorMode(userId, { title, premise, characters = [], episodes = 1 } = {}, signal) {
  const clean = String(premise || '').trim();
  if (!clean) throw new Error('Director Mode needs a premise for the short drama.');
  const out = await chatJson(userId, {
    system: 'You are a short-drama director. Reply with valid JSON only, no other text.',
    user: `Director Mode bible. Title: "${String(title || 'Untitled Drama').slice(0, 80)}". Premise: "${clean}". Characters so far: ${JSON.stringify(characters)}. Reply as {"characters":[{"name":"...","look":"visual description for continuity","voice":"..."}],"scenes":[{"name":"...","setting":"...","props":["..."]}],"episodes":[{"title":"...","script":"scene-by-scene script, 300-600 words, with dialogue and camera notes"}]}. Rules: keep every character's look identical across episodes (continuity); reuse the same props; scripts are production-ready.`,
  }, signal);
  const chars = Array.isArray(out.characters) ? out.characters : [];
  const scenes = Array.isArray(out.scenes) ? out.scenes : [];
  const eps = Array.isArray(out.episodes) ? out.episodes.slice(0, Math.max(1, Math.min(10, parseInt(episodes, 10) || 1))) : [];
  const { blankDoc } = require('./docs-slides');
  const doc = blankDoc({ title: `${title || 'Untitled Drama'} — Director Bible` });
  doc.blocks = [
    { id: 'b-title', type: 'heading', level: 1, text: `${title || 'Untitled Drama'} — Director Bible` },
    { id: 'b-premise', type: 'paragraph', text: clean },
    { id: 'b-chars-h', type: 'heading', level: 2, text: 'Characters (continuity)' },
    ...chars.map((c, i) => ({ id: `b-char-${i}`, type: 'paragraph', text: `${c.name}: ${c.look || ''}${c.voice ? ` — voice: ${c.voice}` : ''}` })),
    { id: 'b-scenes-h', type: 'heading', level: 2, text: 'Recurring scenes & props' },
    ...scenes.map((s, i) => ({ id: `b-scene-${i}`, type: 'paragraph', text: `${s.name} — ${s.setting || ''} (props: ${(s.props || []).join(', ')})` })),
    ...eps.flatMap((e, i) => [
      { id: `b-ep-${i}-h`, type: 'heading', level: 2, text: `Episode ${i + 1}: ${e.title || ''}` },
      { id: `b-ep-${i}`, type: 'paragraph', text: e.script || '' },
    ]),
  ];
  const project = db.createProject(userId, { name: `${title || 'Untitled Drama'} — Director Bible`, type: 'doc', content: doc });
  return { project: { id: project.id, name: project.name, type: 'doc' }, characters: chars, scenes, episodes: eps.length };
}

async function avatarVideo(userId, { script, photoMediaId, voiceProfileId, name } = {}) {
  const clean = String(script || '').trim();
  if (!clean) throw new Error('An avatar needs a script to speak.');
  const { media, filePath } = mediaPathFor(userId, photoMediaId);
  if (media.kind !== 'image') throw new Error('An avatar needs a photo (image file).');
  const spoken = await synthesizeVoice(userId, { text: clean, voiceProfileId });
  const dubPath = mediaFilePath(userId, spoken.media);
  const stamp = Date.now().toString(36);
  const outName = `avatar-${stamp}.mp4`;
  const outPath = path.join(config.uploadsDir, String(userId), outName);
  await runFfmpegFile(['-y', '-v', 'error', '-loop', '1', '-i', filePath, '-i', dubPath,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outPath]);
  const probe = await probeMedia(outPath);
  const m = db.createMedia(userId, {
    originalName: outName, storedName: outName, mimeType: 'video/mp4', kind: 'video',
    sizeBytes: fs.statSync(outPath).size,
    width: probe && probe.width, height: probe && probe.height,
    durationSeconds: probe && probe.durationSeconds, tags: 'ai-generated,avatar',
  });
  return {
    media: m, filePath: outPath, url: mediaUrl(m),
    note: 'Photo avatar: your photo with the spoken script as audio. Lip-sync (mouth moving to the words) is NOT available in this build — no lip-sync model is installed — so the photo stays still while the voice speaks.',
    provider: spoken.provider,
  };
}

// #64 — AI Design Studio / Infinite Canvas: an LLM agent plans a large
// canvas (nodes = design layers arranged on a 3840×2160 canvas) from a
// prompt, using "Skills" (named prompt recipes). The result is a real
// editable design project — the canvas UI (ai-studio.js) pans/zooms it.
const CANVAS_SKILLS = {
  'brand-board': 'Brand board: logo lockup, colour swatches, typography scale',
  'moodboard': 'Moodboard: image tiles + palette + keywords',
  'storyboard': 'Storyboard: 6 panels with captions',
  'social-kit': 'Social kit: post + story + thumbnail variants',
  'ad-set': 'Ad set: 3 headline variants + CTA',
};
async function infiniteCanvas(userId, { prompt, skill = 'brand-board' } = {}, signal) {
  const clean = String(prompt || '').trim();
  if (!clean) throw new Error('The canvas agent needs a prompt.');
  if (!CANVAS_SKILLS[skill]) throw new Error(`Unknown canvas skill: ${skill}. Available: ${Object.keys(CANVAS_SKILLS).join(', ')}.`);
  const out = await chatJson(userId, {
    system: 'You are an AI design agent working on an infinite canvas. Reply with valid JSON only, no other text.',
    user: `Infinite canvas plan. Skill: ${CANVAS_SKILLS[skill]}. Brief: "${clean}". Reply as {"nodes":[{"type":"text","text":"...","x":100,"y":100,"w":800,"h":120,"fontSize":72,"color":"#ffffff"},{"type":"shape","fill":"#7c5cff","x":100,"y":300,"w":400,"h":240}],"palette":{"primary":"#RRGGBB","secondary":"#RRGGBB","accent":"#RRGGBB"},"notes":"one short design note"}. Rules: coordinates are on a 3840x2160 canvas; at most 24 nodes; text is short; colours are #RRGGBB.`,
  }, signal);
  const nodes = Array.isArray(out.nodes) ? out.nodes.slice(0, 24) : [];
  if (!nodes.length) throw new Error('The canvas agent returned no nodes.');
  const { blankDesign, defaultTextLayer, defaultShapeLayer } = require('./design-model');
  const design = blankDesign(3840, 2160);
  const pal = out.palette || {};
  design.background = { type: 'gradient', color: pal.primary || '#151d3a', gradient: { from: pal.primary || '#7c5cff', to: pal.secondary || '#3b82f6', angle: 135 } };
  design.layers = nodes.map((n, i) => {
    if (n.type === 'shape') return defaultShapeLayer('rect', Math.max(0, n.x || 0), Math.max(0, n.y || 0), Math.max(10, n.w || 200), Math.max(10, n.h || 200), { name: `Node ${i + 1}`, fill: n.fill || '#7c5cff' });
    return defaultTextLayer(Math.max(0, n.x || 0), Math.max(0, n.y || 0), String(n.text || '').slice(0, 200), { name: `Node ${i + 1}`, fontSize: Math.max(12, Math.min(200, n.fontSize || 48)), color: n.color || '#ffffff', w: Math.max(50, n.w || 600), h: Math.max(20, n.h || 90) });
  });
  const project = db.createProject(userId, { name: `${clean.slice(0, 40)} (Canvas — ${skill})`, type: 'design', content: design });
  return { project: { id: project.id, name: project.name, type: 'design' }, nodes: design.layers.length, skill, palette: pal, notes: out.notes || '' };
}

// #67 — Auto Lyrics: transcribe a song (STT) → LLM formats timed lyrics
// → SRT/VTT. Lyrics mode is speech transcription + LLM line grouping;
// it is labelled as lyrics captioning, not a dedicated lyrics model.
async function autoLyrics(userId, { mediaId, language } = {}, signal) {
  const t = await transcribeAudio(userId, mediaId, { language }, signal);
  const out = await chatJson(userId, {
    system: 'You are a lyric formatter. Reply with valid JSON only, no other text.',
    user: `Format this song transcript as lyrics. Transcript with timings: ${JSON.stringify(t.cues)}. Reply as {"lines":[{"start":0,"end":2.5,"text":"..."}]}. Rules: one short line per cue (max 8 words), keep the original timings, drop spoken filler, do not invent words.`,
  }, signal);
  const lines = Array.isArray(out.lines) ? out.lines.filter((l) => l && l.text) : [];
  if (!lines.length) throw new Error('The LLM returned no lyric lines.');
  const { toSRT, toVTT } = require('./captions');
  const cues = lines.map((l) => ({ start: Number(l.start) || 0, end: Number(l.end) || 0, text: String(l.text).slice(0, 120) })).filter((c) => c.end > c.start);
  return { lines: cues, srt: toSRT(cues), vtt: toVTT(cues), source: 'stt+llm', note: 'Lyrics captioning from speech transcription + LLM line grouping (no dedicated lyrics model).' };
}

// #67 — AI Lab: brainstorming surface — LLM returns ideas, hooks, angles.
async function aiLab(userId, { topic, kind = 'ideas', count = 5 } = {}, signal) {
  const clean = String(topic || '').trim();
  if (!clean) throw new Error('AI Lab needs a topic.');
  const n = Math.max(1, Math.min(10, parseInt(count, 10) || 5));
  const kinds = { ideas: 'content ideas', hooks: 'opening hooks', angles: 'fresh angles', titles: 'titles', scripts: 'short video scripts' };
  const out = await chatJson(userId, {
    system: 'You are a creative brainstorming partner. Reply with valid JSON only, no other text.',
    user: `AI Lab — ${kinds[kind] || 'content ideas'} about "${clean}". Return exactly ${n} items as {"items":[{"title":"...","detail":"1-2 sentences"}]}. No placeholders, no duplicates.`,
  }, signal);
  const items = Array.isArray(out.items) ? out.items.slice(0, n) : [];
  if (!items.length) throw new Error('AI Lab returned no ideas.');
  return { topic: clean, kind, items };
}

// #67 — Batch edit: apply one op to many video projects at once.
async function batchEditProjects(userId, { projectIds, op } = {}) {
  if (!Array.isArray(projectIds) || !projectIds.length) throw new Error('Batch edit needs at least one project.');
  if (!op || typeof op !== 'object') throw new Error('Batch edit needs an op.');
  const { validateTimeline } = require('./video-model');
  const results = [];
  for (const id of projectIds) {
    const project = db.getProject(userId, id);
    if (!project) { results.push({ projectId: id, ok: false, error: 'Project not found.' }); continue; }
    if (project.type !== 'video') { results.push({ projectId: id, ok: false, error: 'Not a video project.' }); continue; }
    let tl;
    try { tl = JSON.parse(project.content || '{}'); } catch { results.push({ projectId: id, ok: false, error: 'Content unreadable.' }); continue; }
    let changed = 0;
    try {
      if (op.op === 'transition-all') {
        if (!['none', 'fade', 'dissolve', 'slide', 'wipe'].includes(op.type)) throw new Error('Bad transition type.');
        for (const t of tl.tracks || []) for (const c of t.clips || []) { c.transition = { type: op.type, duration: Math.max(0.1, Math.min(5, Number(op.duration) || 0.5)) }; changed += 1; }
      } else if (op.op === 'volume-all') {
        const v = Math.max(0, Math.min(2, Number(op.volume)));
        if (!Number.isFinite(v)) throw new Error('Bad volume.');
        for (const t of tl.tracks || []) for (const c of t.clips || []) if (c.kind === 'audio' || c.kind === 'video') { c.volume = v; changed += 1; }
      } else if (op.op === 'rename-prefix') {
        const prefix = String(op.prefix || '').slice(0, 60);
        db.updateProject(userId, id, { name: `${prefix}${project.name}` });
        results.push({ projectId: id, ok: true, changed: 0, renamed: true });
        continue;
      } else throw new Error(`Unknown batch op: ${op.op}. Use transition-all, volume-all or rename-prefix.`);
      const errors = validateTimeline(tl);
      if (errors.length) throw new Error('Invalid timeline after edit: ' + errors.join(' '));
      db.updateProject(userId, id, { content: tl });
      results.push({ projectId: id, ok: true, changed });
    } catch (e) {
      results.push({ projectId: id, ok: false, error: String(e.message || e).slice(0, 300) });
    }
  }
  return { results, okCount: results.filter((r) => r.ok).length, total: projectIds.length };
}

// #69 — Bilingual captions + speaker ID: STT → LLM translates to a second
// language and assigns speaker labels from the dialogue (LLM-inferred
// from the text, NOT acoustic diarization — the result says so plainly).
async function bilingualCaptions(userId, { mediaId, language, secondLanguage = 'ur', speakers = 2 } = {}, signal) {
  const t = await transcribeAudio(userId, mediaId, { language }, signal);
  const out = await chatJson(userId, {
    system: 'You are a caption editor. Reply with valid JSON only, no other text.',
    user: `Bilingual captions + speaker ID. Cues: ${JSON.stringify(t.cues)}. Second language: ${secondLanguage}. Speakers (max ${Math.max(1, Math.min(6, parseInt(speakers, 10) || 2))}): assign each cue a speaker label like "Speaker 1" from the dialogue flow (who is talking). Reply as {"cues":[{"start":0,"end":2.5,"text":"...","translation":"...","speaker":"Speaker 1"}]}. Rules: keep every cue's timing; translate every line; do not invent lines.`,
  }, signal);
  const cues = Array.isArray(out.cues) ? out.cues.filter((c) => c && c.text) : [];
  if (!cues.length) throw new Error('The LLM returned no bilingual cues.');
  const { toSRT, toVTT } = require('./captions');
  const primary = cues.map((c) => ({ start: Number(c.start) || 0, end: Number(c.end) || 0, text: `[${c.speaker || 'Speaker 1'}] ${String(c.text).slice(0, 200)}` })).filter((c) => c.end > c.start);
  const bilingual = cues.map((c) => ({ start: Number(c.start) || 0, end: Number(c.end) || 0, text: `[${c.speaker || 'Speaker 1'}] ${String(c.text).slice(0, 200)}\n${String(c.translation || '').slice(0, 200)}` })).filter((c) => c.end > c.start);
  return {
    cues: bilingual, primaryLanguage: language || 'auto', secondLanguage,
    srt: toSRT(bilingual), vtt: toVTT(bilingual),
    primarySrt: toSRT(primary),
    note: 'Speaker labels are inferred by the LLM from the dialogue text, not from acoustic voice diarization — no diarization model is installed.',
  };
}

// #29 — Magic Grab, per-object: segment (U-2-Net, no prior BG-remover run
// needed) → connected component at the click → transparent PNG of ONLY
// that object. A click on background fails honestly (NO_OBJECT_AT_POINT).
async function magicGrabObject(userId, { mediaId, x, y } = {}) {
  const { media, filePath } = mediaPathFor(userId, mediaId);
  if (media.kind !== 'image') throw new Error('Magic Grab needs an image file.');
  const segmentation = require('./segmentation');
  const tmpDir = path.join(config.rendersDir, `grab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const seg = await segmentation.segmentImageFile(filePath, tmpDir);
    if (!seg.foregroundFraction || seg.foregroundFraction <= 0.001) {
      const err = new Error('The segmentation found no foreground in this image — there is nothing to grab.');
      err.code = 'NO_OBJECT_AT_POINT';
      throw err;
    }
    const comp = await segmentation.extractObjectMask(seg.maskPath, x, y, tmpDir);
    const info = await probeMedia(filePath);
    const { x: bx, y: by, w: bw, h: bh } = comp.bbox;
    const cropImg = path.join(tmpDir, 'crop.png');
    const cropMask = path.join(tmpDir, 'crop-mask.png');
    const outPath = path.join(tmpDir, 'grab.png');
    await runFfmpegFile(['-y', '-v', 'error', '-i', filePath, '-vf', `crop=${bw}:${bh}:${bx}:${by}`, cropImg]);
    await runFfmpegFile(['-y', '-v', 'error', '-i', comp.maskPath, '-vf', `crop=${bw}:${bh}:${bx}:${by}`, cropMask]);
    await segmentation.applyMaskAsAlpha(cropImg, cropMask, outPath);
    const buf = fs.readFileSync(outPath);
    const stamp = Date.now().toString(36);
    const saved = await saveGeneratedBuffer(userId, {
      buffer: buf, name: `grab-object-${stamp}.png`, kind: 'image', mimeType: 'image/png', tags: 'magic-grab',
    });
    // Re-tag as magic-grab (saveGeneratedBuffer tags ai-generated by
    // default via the caller — fix the tag here).
    db.updateMedia(userId, saved.media.id, { tags: 'magic-grab' });
    credits.chargeCredits(userId, 'magic_grab', `Grabbed one object from "${media.original_name}" at (${comp.clicked.x}, ${comp.clicked.y})`);
    return { media: saved.media, filePath: saved.filePath, url: mediaUrl(saved.media), bbox: comp.bbox, pixels: comp.pixels, clicked: comp.clicked, foregroundFraction: seg.foregroundFraction };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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
      case 'autocut': {
        const a = await autocut(userId, params);
        result = { projectId: a.project.id, projectName: a.project.name, clips: a.clips, durationSeconds: a.durationSeconds, template: a.template };
        break;
      }
      case 'editpilot': {
        const e = await editPilot(userId, params, ctrl.signal);
        result = { projectId: e.project.id, projectName: e.project.name, applied: e.applied, skipped: e.skipped, alternate: e.alternate };
        break;
      }
      case 'seedance': {
        const providerId = params.providerId || 'seedance';
        const g = await generateVideoExtended(userId, { providerId, prompt: params.prompt, sourceMediaId: params.sourceMediaId, duration: params.duration, aspect: params.aspect, mode: params.seedanceMode || 'generate', editPrompt: params.editPrompt }, ctrl.signal, setProgress);
        result = { mediaId: g.media.id, url: g.url, provider: g.provider, prompt: g.prompt, mode: params.seedanceMode || 'generate' };
        outputMediaId = g.media.id;
        break;
      }
      case 'video-enhance': {
        const e = await enhanceVideo(userId, params);
        result = { mediaId: e.media.id, url: e.url, kind: e.kind, method: e.method, note: e.note };
        outputMediaId = e.media.id;
        break;
      }
      case 'video-translate': {
        const t = await translateVideo(userId, params, ctrl.signal);
        result = { mediaId: t.media.id, url: t.url, toLanguage: t.toLanguage, translatedText: t.translatedText, originalText: t.originalText };
        outputMediaId = t.media.id;
        break;
      }
      case 'director': {
        const d = await directorMode(userId, params, ctrl.signal);
        result = { projectId: d.project.id, projectName: d.project.name, characters: d.characters, scenes: d.scenes, episodes: d.episodes };
        break;
      }
      case 'avatar': {
        const a = await avatarVideo(userId, params);
        result = { mediaId: a.media.id, url: a.url, note: a.note, provider: a.provider };
        outputMediaId = a.media.id;
        break;
      }
      case 'infinite-canvas': {
        const c = await infiniteCanvas(userId, params, ctrl.signal);
        result = { projectId: c.project.id, projectName: c.project.name, nodes: c.nodes, skill: c.skill, palette: c.palette, notes: c.notes };
        break;
      }
      case 'lyrics': {
        const l = await autoLyrics(userId, params, ctrl.signal);
        result = { lines: l.lines, srt: l.srt, vtt: l.vtt, note: l.note };
        break;
      }
      case 'ai-lab': {
        const l = await aiLab(userId, params, ctrl.signal);
        result = { topic: l.topic, kind: l.kind, items: l.items };
        break;
      }
      case 'batch-edit': {
        const b = await batchEditProjects(userId, params);
        result = { results: b.results, okCount: b.okCount, total: b.total };
        break;
      }
      case 'retouch': {
        const r = await retouchVideo(userId, params);
        result = { mediaId: r.media.id, url: r.url, kind: r.kind, method: r.method, note: r.note };
        outputMediaId = r.media.id;
        break;
      }
      case 'bilingual': {
        const b = await bilingualCaptions(userId, params, ctrl.signal);
        result = { cues: b.cues, srt: b.srt, vtt: b.vtt, primarySrt: b.primarySrt, note: b.note, secondLanguage: b.secondLanguage };
        break;
      }
      case 'transcript-edit': {
        const t = await transcriptEdit(userId, params);
        result = { mediaId: t.media.id, url: t.url, cutCues: t.cutCues, keptCues: t.keptCues, segments: t.segments };
        outputMediaId = t.media.id;
        break;
      }
      case 'silence-remove': {
        const s = await removeSilence(userId, params);
        result = { mediaId: s.media.id, url: s.url, removedSeconds: s.removedSeconds, newDuration: s.newDuration, originalDuration: s.originalDuration };
        outputMediaId = s.media.id;
        break;
      }
      case 'magic-grab': {
        const g = await magicGrabObject(userId, params);
        result = { mediaId: g.media.id, url: g.url, bbox: g.bbox, pixels: g.pixels, clicked: g.clicked };
        outputMediaId = g.media.id;
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
  AI_MODES, EXTENDED_PROVIDERS, CANVAS_SKILLS,
  getExtendedProvider, resolveExtendedProvider, extendedProviderStatus, requireExtendedProvider,
  resolveVideoProvider, resolveImageProvider,
  generateImage, generateImageExtended, generateAiBackground,
  generateVideo, generateVideoExtended,
  chatJson,
  generateQuizQuestions, designAssist, buildDesignFromSuggestions,
  generateWriting, WRITE_TASKS, generateDeck,
  transcribeAudio, musicMood, generateMusic, synthesizeVoice,
  autocut, editPilot, enhanceVideo, retouchVideo,
  detectSilenceFor, removeSilence, transcriptEdit,
  translateVideo, directorMode, avatarVideo, infiniteCanvas,
  autoLyrics, aiLab, batchEditProjects, bilingualCaptions, magicGrabObject,
  saveGeneratedBuffer, publicAiJob, createAiJobEntry, runAiJob,
  startAiQueue, cancelAiJob, retryAiJob, pumpAiQueue,
};
