'use strict';
// AI provider registry — Phase 7 (AI Creative Studio).
//
// One registry for every AI kind: image, video, llm, tts, stt, music.
// Each provider has a REAL, documented API shape and a configurable base
// URL + model, so a compatible endpoint (or a local mock in tests) can be
// pointed at it. Keys are NEVER hardcoded and NEVER sent to the frontend:
// they come from env or the encrypted DB store (AES-256-GCM, same as
// Phase 1), resolved by getProviderConfig().
//
// HONESTY: a provider is "configured" only when a key exists. Every AI
// action without a configured key refuses with PROVIDER_KEY_NEEDED and
// creates no output file. "Test connection" makes a minimal REAL call
// (list models / balance / user) and reports the provider's actual result
// — never a fake success.
//
// Provider ids keep their Phase 1 names where they existed ('llm',
// 'image', 'video', 'stt', 'tts', 'music', 'voice_clone') so earlier
// code (Settings, voice profiles, Shorts STT) keeps working. New
// providers get new ids ('stability').
const db = require('./db');
const { mask, decrypt } = require('./crypto-util');

const KINDS = ['image', 'video', 'llm', 'tts', 'stt', 'music'];

const PROVIDERS = [
  {
    id: 'llm', kind: 'llm', label: 'LLM — OpenAI Chat (GPT)',
    envKey: 'OPENAI_API_KEY', defaultBaseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'], defaultModel: 'gpt-4o-mini',
    test: { method: 'GET', path: '/models' },
    phase: 7,
    about: 'Chat completions. Powers AI quiz questions, design assist, captions/posts and music mood tags.',
  },
  {
    id: 'gemini', kind: 'llm', label: 'LLM — Google Gemini (free tier)',
    envKey: 'GEMINI_API_KEY', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // v2.2.4: Google retired gemini-2.0-flash (404 "no longer available").
    // The current default is gemini-3.8-flash; see RETIRED_MODELS below
    // for installs that still have the old model saved.
    models: ['gemini-3.8-flash', 'gemini-2.5-flash'], defaultModel: 'gemini-3.8-flash',
    test: { method: 'GET', path: '/models' },
    phase: 7,
    about: 'Chat completions via Google\'s OpenAI-compatible endpoint (beta — same chat/completions shape, Bearer key). Free API key from Google AI Studio (aistudio.google.com), no card required. The free tier has rate limits — check your project\'s limits in AI Studio. Powers AI quiz questions, design assist, captions/posts and music mood tags.',
  },
  {
    id: 'image', kind: 'image', label: 'Image — OpenAI Images (DALL·E 3 / GPT Image)',
    envKey: 'OPENAI_API_KEY', defaultBaseUrl: 'https://api.openai.com/v1',
    models: ['dall-e-3', 'gpt-image-1'], defaultModel: 'dall-e-3',
    test: { method: 'GET', path: '/models' },
    phase: 7,
    about: 'Text-to-image and image-to-image (edits). Powers AI Studio images and AI bulk backgrounds.',
  },
  {
    id: 'stability', kind: 'image', label: 'Image — Stability AI (SD3)',
    envKey: 'STABILITY_API_KEY', defaultBaseUrl: 'https://api.stability.ai',
    models: ['sd3.5-large', 'sd3.5-medium'], defaultModel: 'sd3.5-large',
    test: { method: 'GET', path: '/v1/user/balance' },
    phase: 7,
    about: 'Text-to-image via the Stability SD3 API. Alternative image provider for AI Studio and bulk backgrounds.',
  },
  {
    id: 'video', kind: 'video', label: 'Video — Runway Gen-4',
    envKey: 'RUNWAY_API_KEY', defaultBaseUrl: 'https://api.dev.runwayml.com/v1',
    models: ['gen4_turbo'], defaultModel: 'gen4_turbo',
    test: { method: 'GET', path: '/tasks?limit=1' },
    phase: 7,
    about: 'Text-to-video and image-to-video (async tasks, polled until done). Powers AI Studio video generation.',
  },
  {
    id: 'stt', kind: 'stt', label: 'Speech-to-text — OpenAI Whisper',
    envKey: 'OPENAI_API_KEY', defaultBaseUrl: 'https://api.openai.com/v1',
    models: ['whisper-1'], defaultModel: 'whisper-1',
    test: { method: 'GET', path: '/models' },
    phase: 7,
    about: 'Audio transcription with word timestamps. Powers Shorts auto-transcription and AI Studio Transcribe.',
  },
  {
    id: 'tts', kind: 'tts', label: 'Text-to-speech — OpenAI TTS',
    envKey: 'OPENAI_API_KEY', defaultBaseUrl: 'https://api.openai.com/v1',
    models: ['tts-1', 'tts-1-hd'], defaultModel: 'tts-1',
    test: { method: 'GET', path: '/models' },
    phase: 7,
    about: 'Generic AI voices (alloy, echo, fable, onyx, nova, shimmer). Powers narration speech.',
  },
  {
    id: 'music', kind: 'music', label: 'Music generation — Replicate MusicGen',
    envKey: 'REPLICATE_API_TOKEN', defaultBaseUrl: 'https://api.replicate.com/v1',
    models: ['meta/musicgen'], defaultModel: 'meta/musicgen',
    test: { method: 'GET', path: '/predictions?limit=1' },
    phase: 7,
    about: 'Text-to-music via Replicate model predictions (async, polled until done). Mood tagging uses the LLM provider instead and needs no music key.',
  },
  {
    id: 'voice_clone', kind: 'tts', label: 'Voice cloning + TTS (ElevenLabs)',
    envKey: 'ELEVENLABS_API_KEY', defaultBaseUrl: 'https://api.elevenlabs.io/v1',
    models: ['eleven_multilingual_v2'], defaultModel: 'eleven_multilingual_v2',
    test: { method: 'GET', path: '/user' },
    phase: 7,
    about: 'Clone your own voice from a short sample, then speak any text with it. Powers narration with your voice.',
  },
];

// Models a provider has retired (Google answers 404 for them). A stored
// model override naming one is upgraded to the provider's current default
// at resolve time, so an install that saved the old default keeps working
// after an update — no manual fix, no failed job. The stored value is
// left alone; the resolved (effective) model is what every call uses.
const RETIRED_MODELS = { 'gemini-2.0-flash': 'gemini-3.8-flash' };

// The default (primary) provider per kind — used until the user picks another.
const DEFAULT_ACTIVE = { image: 'image', video: 'video', llm: 'llm', tts: 'tts', stt: 'stt', music: 'music' };

function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

function storedKey(id) {
  const row = db.getProviderSettings().find((r) => r.provider === id);
  if (row && row.api_key_encrypted) {
    try { return decrypt(row.api_key_encrypted); } catch { return null; }
  }
  return null;
}

// Resolve everything a live call needs. Returns null-key when unconfigured
// (callers then refuse with PROVIDER_KEY_NEEDED — never a fake call).
function resolveProvider(id) {
  const def = getProvider(id);
  if (!def) return null;
  const cfg = db.getProviderConfig(id) || {};
  const key = storedKey(id) || process.env[def.envKey] || null;
  // A stored model override naming a retired model is upgraded to the
  // provider's current default (see RETIRED_MODELS above).
  const storedModel = cfg.model || null;
  const model = storedModel && RETIRED_MODELS[storedModel]
    ? RETIRED_MODELS[storedModel]
    : (storedModel || def.defaultModel);
  return {
    ...def,
    key,
    baseUrl: (cfg.base_url || def.defaultBaseUrl).replace(/\/$/, ''),
    model,
    configured: Boolean(key),
    source: storedKey(id) ? 'stored (encrypted)' : (process.env[def.envKey] ? 'environment' : 'none'),
  };
}

function activeProviderForKind(kind) {
  const pref = db.getActiveProvider(kind);
  if (pref && getProvider(pref) && getProvider(pref).kind === kind) return pref;
  return DEFAULT_ACTIVE[kind] || null;
}

function providerStatus() {
  return PROVIDERS.map((p) => {
    const r = resolveProvider(p.id);
    return {
      id: p.id,
      kind: p.kind,
      label: p.label,
      models: p.models,
      model: r.model,
      baseUrl: r.baseUrl,
      defaultBaseUrl: p.defaultBaseUrl,
      phase: p.phase,
      configured: r.configured,
      active: activeProviderForKind(p.kind) === p.id,
      source: r.source,
      maskedKey: r.configured ? mask('key-present') : '',
      status: r.configured ? 'configured' : 'key_needed',
      about: p.about,
      note: r.configured
        ? 'Key saved. Live AI calls are enabled.'
        : 'No API key configured. AI features using this provider will refuse with "key needed" until a key is added in Settings → AI Providers.',
    };
  });
}

// Throw the honest key-needed error (or return the resolved provider).
// Legacy callers used this as a gate; it no longer throws
// PROVIDER_NOT_IMPLEMENTED — a configured provider is genuinely callable
// in Phase 7.
function requireProvider(id) {
  const r = resolveProvider(id);
  if (!r) throw new Error(`Unknown provider: ${id}`);
  if (!r.configured) {
    const err = new Error(`AI provider "${r.label}" is not configured: no API key. Add one in Settings → AI Providers.`);
    err.code = 'PROVIDER_KEY_NEEDED';
    err.provider = id;
    throw err;
  }
  return r;
}

// A provider 404 that names a model ("... is no longer available ...")
// means the configured model was retired — not that the key or the
// account is broken. Turn the raw provider dump into a message that
// names the working alternative and where to change it. Returns null
// when the response is not a model-not-found — callers then use the
// generic provider error. `provider` is a resolved provider object
// (from resolveProvider) or a provider id.
function friendlyModelError(provider, model, status, detail) {
  if (!provider || status !== 404) return null;
  const text = String(detail || '');
  const isModelNotFound = /no longer available|not found|does not exist|is not supported/i.test(text)
    || /models\/[A-Za-z0-9._-]+/i.test(text);
  if (!isModelNotFound) return null;
  const p = typeof provider === 'string' ? resolveProvider(provider) : provider;
  const label = (p && p.label) || 'the provider';
  // Google itself names the replacement ("... update your code to use
  // models/gemini-3.8-flash") — prefer that; otherwise the provider's
  // current default model.
  const named = text.match(/use models\/([A-Za-z0-9._-]+)/i);
  const fallback = (named && named[1]) || (p && p.defaultModel) || null;
  const where = `Settings → AI Providers → ${label} (Model)`;
  const err = new Error(
    `The model "${model}" is no longer available on ${label} (404). `
    + (fallback && fallback !== model
      ? `Use "${fallback}" instead — change the model in ${where}, or clear the model field to use the current default.`
      : `Pick a current model in ${where}.`),
  );
  err.code = 'MODEL_NOT_FOUND';
  err.status = 404;
  err.provider = p ? p.id : null;
  err.model = model;
  err.suggestedModel = fallback;
  return err;
}

async function fetchWithTimeout(url, options, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  // Honour a caller-supplied abort signal (e.g. an AI job being cancelled)
  // as well as the timeout: either one aborts the fetch.
  const signal = options && options.signal ? AbortSignal.any([options.signal, ctrl.signal]) : ctrl.signal;
  try {
    return await fetch(url, { ...options, signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Transient failures: retry + friendly errors (v2.2.4) ------------------
// A provider that answers 429 (rate limit), 502, 503 (overloaded) or 504
// is usually fine a few seconds later — a single try must never fail a
// job. 500 is deliberately NOT retried: it usually means a real request
// problem, and retrying it would only burn time.
const TRANSIENT_STATUSES = [429, 502, 503, 504];
// 4 attempts, waits of 2s, 5s, 10s between them. Tests set
// AI_RETRY_DELAYS_MS (e.g. '30,60,120') so retry tests run fast.
const DEFAULT_RETRY_DELAYS_MS = [2000, 5000, 10000];
function retryDelays() {
  const raw = process.env.AI_RETRY_DELAYS_MS;
  if (raw) {
    const parsed = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0);
    if (parsed.length) return parsed;
  }
  return DEFAULT_RETRY_DELAYS_MS;
}
function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(t); resolve(); }
      else signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    }
  });
}
// Retry a provider fetch on transient HTTP statuses. Returns the final
// Response (ok or not — callers still check res.ok). `meta` (optional)
// receives { attempts, retried }. A caller abort (job cancelled) is
// never retried; a timeout is treated as transient and retried.
async function fetchWithRetry(url, options, ms = 20000, meta) {
  const delays = retryDelays();
  const maxAttempts = delays.length + 1;
  const callerSignal = options && options.signal;
  let lastRes = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res;
    try {
      res = await fetchWithTimeout(url, options, ms);
    } catch (e) {
      if (callerSignal && callerSignal.aborted) throw e;
      if (attempt === maxAttempts) throw e;
      if (meta) { meta.attempts = attempt; meta.retried = true; }
      console.log(`[provider] ${url} timed out (attempt ${attempt}/${maxAttempts}) — retrying in ${delays[attempt - 1]} ms`);
      await sleepAbortable(delays[attempt - 1], callerSignal);
      continue;
    }
    if (meta) { meta.attempts = attempt; meta.retried = attempt > 1; }
    if (res.ok || !TRANSIENT_STATUSES.includes(res.status) || attempt === maxAttempts) return res;
    // Consume the error body so the connection can be reused, then wait.
    try { await res.text(); } catch { /* ignore */ }
    console.log(`[provider] ${url} returned ${res.status} (attempt ${attempt}/${maxAttempts}) — retrying in ${delays[attempt - 1]} ms`);
    await sleepAbortable(delays[attempt - 1], callerSignal);
    if (callerSignal && callerSignal.aborted) return res;
    lastRes = res;
  }
  return lastRes;
}

// One plain line for the user, raw detail in the server log only — never
// a raw provider JSON dump on screen. Returns an Error (code
// PROVIDER_ERROR, .status set) so callers can throw it directly.
function friendlyProviderError(providerLabel, status, detail, { retried = false } = {}) {
  const raw = String(detail || '');
  // The raw detail is for diagnosis — it goes to the log, never to the user.
  try { console.error(`[AI] ${providerLabel} failed (${status}): ${raw.slice(0, 500)}`); } catch { /* ignore */ }
  const tried = retried ? ' The request was retried automatically.' : '';
  let message;
  if (status === 429) {
    message = `${providerLabel} is rate-limited right now (429).${tried} Please try again in a minute or two.`;
  } else if (status === 503 || /overload|high demand|temporarily unavailable/i.test(raw)) {
    message = `${providerLabel} is temporarily overloaded (${status}).${tried} Please try again in a few minutes — no key or settings change is needed.`;
  } else if (status === 401 || status === 403) {
    message = `${providerLabel} rejected the key (${status}). Check the key in Settings → AI Providers — it may be wrong, revoked, or out of credit.`;
  } else {
    // One plain line from the provider's own message when it has one.
    let line = '';
    try {
      const j = JSON.parse(raw);
      const m = (j && j.error && (j.error.message || j.error)) || (j && j.message) || '';
      line = String(m || '');
    } catch { line = raw.split('\n')[0] || ''; }
    line = line.replace(/["{}[\]]/g, '').trim().slice(0, 200);
    message = line
      ? `${providerLabel} failed (${status}): ${line}`
      : `${providerLabel} failed (${status}). Please try again.`;
  }
  const err = new Error(message);
  err.code = 'PROVIDER_ERROR';
  err.status = status;
  return err;
}

// Minimal REAL validation call for a provider: list models / balance /
// user — whatever the provider offers that proves the key works without
// spending credits on a generation. Returns { ok, detail } — never faked.
async function testProvider(id) {
  const r = resolveProvider(id);
  if (!r) return { ok: false, error: `Unknown provider: ${id}` };
  if (!r.configured) {
    return { ok: false, code: 'PROVIDER_KEY_NEEDED', error: `No API key configured for ${r.label}. Add one in Settings → AI Providers first.` };
  }
  const headers = {};
  if (id === 'voice_clone') headers['xi-api-key'] = r.key;
  else if (id === 'music') headers.Authorization = `Token ${r.key}`;
  else headers.Authorization = `Bearer ${r.key}`;
  try {
    const res = await fetchWithRetry(`${r.baseUrl}${r.test.path}`, { method: r.test.method, headers }, 20000);
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, error: friendlyProviderError(r.label, res.status, text).message };
    }
    let detail = 'Connection OK — the key was accepted.';
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json.data)) detail = `Connection OK — the key was accepted (${json.data.length} models listed).`;
      else if (json.credits !== undefined) detail = `Connection OK — the key was accepted (balance: ${json.credits} credits).`;
      else if (json.subscription) detail = 'Connection OK — the key was accepted (account found).';
    } catch { /* keep the generic detail */ }
    return { ok: true, detail };
  } catch (err) {
    return { ok: false, error: `Could not reach ${r.label} (${r.baseUrl}): ${err.message}` };
  }
}

module.exports = {
  KINDS, PROVIDERS, DEFAULT_ACTIVE, RETIRED_MODELS,
  TRANSIENT_STATUSES, DEFAULT_RETRY_DELAYS_MS, retryDelays,
  getProvider, resolveProvider, activeProviderForKind,
  providerStatus, requireProvider, testProvider, fetchWithTimeout,
  fetchWithRetry, friendlyProviderError, friendlyModelError,
};
