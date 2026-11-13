'use strict';
// Voice profiles + TTS provider abstraction (post-Phase-5 quiz upgrade).
//
// USER RULES (2026-11-12):
//   (a) The user's OWN voice: they record/upload a short spoken sample (a
//       few words); the system builds their voice profile and sets it as
//       the DEFAULT voice applied to ALL videos.
//   (b) AI voices are also available to pick.
//   (c) Bulk voice option: one voice picked for a whole batch; a per-row
//       VOICE column can override it.
//
// HONESTY: real cloned/AI speech needs a voice provider key (ElevenLabs for
// cloning + TTS, or OpenAI for generic TTS voices). NO key exists yet, so
// synthesis REFUSES with a clear `key_needed` error and creates no audio
// file — never a fake voice, never a robotic local fallback passed off as
// the best voice. Recorded narration (the user's own audio files) works
// NOW with no key (see src/bulk.js — NARRATION_AUDIO column).
//
// When a key IS configured (Settings → AI Providers, stored encrypted like
// every other key), synthesis works: text → audio per narration segment,
// cached by (provider, voice, text hash) as a Media Library audio row
// (tag "narration"), so the Phase 3 renderer mixes it like any audio clip.
// Voice cloning uploads the sample to the provider's voices/add endpoint
// and stores the returned provider voice id on the profile. Cloning quality
// depends on the sample — a few words give a rough match; a minute of clean
// speech is much better (the UI says so).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const providers = require('./providers');

// NOTE (Phase 7): base URLs and keys come from the provider registry
// (src/providers.js) — configurable in Settings → AI Providers — never
// hardcoded. The constants below are only the defaults the registry uses.
const ELEVENLABS_API = 'https://api.elevenlabs.io/v1';
const OPENAI_API = 'https://api.openai.com/v1';

// Generic OpenAI TTS voices (real voice names from the OpenAI TTS API).
const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

function providerKey(providerId) {
  // Stored (encrypted) key wins; env is the fallback — same rule as the
  // other providers in src/providers.js. Resolved through the registry so
  // a configured base URL / model override is honoured too.
  const r = providers.resolveProvider(providerId);
  return r ? r.key : null;
}

function providerBaseUrl(providerId) {
  const r = providers.resolveProvider(providerId);
  return r ? r.baseUrl : null;
}

function envKey(name) { return process.env[name] || null; }

function voiceProviderStatus() {
  const elevenKey = providerKey('voice_clone') || envKey('ELEVENLABS_API_KEY');
  const openaiKey = providerKey('tts') || envKey('OPENAI_API_KEY');
  return {
    voiceClone: {
      id: 'voice_clone', label: 'Voice cloning + TTS (ElevenLabs)',
      configured: Boolean(elevenKey),
      status: elevenKey ? 'configured' : 'key_needed',
      note: elevenKey
        ? 'Key saved. Voice cloning and cloned-voice speech are available.'
        : 'No ElevenLabs key. Cloned-voice speech is unavailable until a key is added in Settings → AI Providers.',
    },
    tts: {
      id: 'tts', label: 'Text-to-speech (OpenAI)',
      configured: Boolean(openaiKey),
      status: openaiKey ? 'configured' : 'key_needed',
      voices: OPENAI_VOICES,
      note: openaiKey
        ? 'Key saved. Generic AI voices are available.'
        : 'No OpenAI key. Generic AI voices are unavailable until a key is added in Settings → AI Providers.',
    },
  };
}

function keyNeededError(providerLabel) {
  const err = new Error(`${providerLabel} is not configured: no API key. Add one in Settings → AI Providers. No audio was generated.`);
  err.code = 'PROVIDER_KEY_NEEDED';
  return err;
}

async function fetchWithTimeout(url, options, ms = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Voice resolution --------------------------------------------------------
// Per-row VOICE value (profile name or numeric id) beats the bulk job's
// voice, which beats the user's default voice. Returns { profile, source }
// where source is 'row' | 'job' | 'default' | null.
function resolveVoice(userId, rowVoiceValue, jobVoiceProfileId) {
  const byValue = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return db.getVoiceProfile(userId, parseInt(s, 10));
    return db.getVoiceProfileByName(userId, s);
  };
  const rowProfile = byValue(rowVoiceValue);
  if (rowProfile) return { profile: rowProfile, source: 'row' };
  if (jobVoiceProfileId) {
    const p = db.getVoiceProfile(userId, jobVoiceProfileId);
    if (p) return { profile: p, source: 'job' };
  }
  const def = db.getDefaultVoiceProfile(userId);
  if (def) return { profile: def, source: 'default' };
  return { profile: null, source: null };
}

function publicVoiceProfile(p) {
  if (!p) return null;
  return {
    id: p.id, name: p.name, language: p.language, kind: p.kind,
    sampleMediaId: p.sample_media_id, providerVoiceId: p.provider_voice_id || null,
    aiVoice: p.ai_voice || null, isDefault: Boolean(p.is_default),
    // "ready" = this profile can actually speak: a cloned voice needs its
    // provider voice id (cloning done); a generic AI voice needs its name.
    // A clone profile without a provider voice id is "sample saved, not
    // cloned yet" — it can still be picked, but synthesis will refuse
    // until cloning runs (which itself needs a key).
    ready: p.kind === 'ai' ? Boolean(p.ai_voice) : Boolean(p.provider_voice_id),
    createdAt: p.created_at, updatedAt: p.updated_at,
  };
}

// --- Synthesis ---------------------------------------------------------------
// Synthesise one narration segment's text with a voice profile.
// Returns { mediaId, filePath, cached, provider }.
// Throws PROVIDER_KEY_NEEDED when no usable key/voice exists (nothing is
// created, nothing is faked).
async function synthesizeSpeech(userId, profile, text) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Nothing to speak — the text is empty.');
  if (!profile) throw new Error('Pick a voice first — no voice profile was given.');
  const status = voiceProviderStatus();

  let audioBuffer = null;
  let provider = null;

  if (profile.kind === 'clone' && profile.provider_voice_id) {
    const key = providerKey('voice_clone') || envKey('ELEVENLABS_API_KEY');
    if (!key) throw keyNeededError('Voice cloning + TTS (ElevenLabs)');
    const res = await fetchWithTimeout(
      `${providerBaseUrl('voice_clone') || ELEVENLABS_API}/text-to-speech/${encodeURIComponent(profile.provider_voice_id)}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: clean, model_id: 'eleven_multilingual_v2', output_format: 'mp3_44100_128' }),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`ElevenLabs speech failed (${res.status}): ${detail.slice(0, 200) || 'no detail'}`);
      err.code = 'PROVIDER_ERROR';
      throw err;
    }
    audioBuffer = Buffer.from(await res.arrayBuffer());
    provider = 'elevenlabs';
  } else if (profile.kind === 'ai' && profile.ai_voice) {
    const key = providerKey('tts') || envKey('OPENAI_API_KEY');
    if (!key) throw keyNeededError('Text-to-speech (OpenAI)');
    const res = await fetchWithTimeout(`${providerBaseUrl('tts') || OPENAI_API}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: clean, voice: profile.ai_voice }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`OpenAI speech failed (${res.status}): ${detail.slice(0, 200) || 'no detail'}`);
      err.code = 'PROVIDER_ERROR';
      throw err;
    }
    audioBuffer = Buffer.from(await res.arrayBuffer());
    provider = 'openai-tts';
  } else if (profile.kind === 'clone') {
    // Sample saved, but the voice was never cloned to the provider.
    const err = new Error(`Voice "${profile.name}" has a sample but no cloned provider voice yet. Clone it first (needs an ElevenLabs key in Settings → AI Providers). No audio was generated.`);
    err.code = 'VOICE_NOT_CLONED';
    throw err;
  } else {
    throw new Error(`Voice "${profile.name}" has no AI voice selected.`);
  }

  if (!audioBuffer || audioBuffer.length < 100) {
    const err = new Error('The voice provider returned an empty audio file.');
    err.code = 'PROVIDER_ERROR';
    throw err;
  }

  // Cache by (provider, voice, text hash): the same segment spoken with the
  // same voice is never synthesised twice. Cached audio is a normal Media
  // Library audio row (tag "narration") so the renderer can mix it.
  const hash = crypto.createHash('sha256').update(`${provider}|${profile.id}|${profile.provider_voice_id || profile.ai_voice}|${clean}`).digest('hex');
  const storedName = `narration-${hash.slice(0, 16)}.mp3`;
  const dir = path.join(config.uploadsDir, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const existing = db.listMedia(userId, { kind: 'audio', search: storedName }).find((m) => m.stored_name === storedName);
  if (existing && fs.existsSync(path.join(dir, storedName))) {
    return { mediaId: existing.id, filePath: path.join(dir, storedName), cached: true, provider };
  }
  const filePath = path.join(dir, storedName);
  fs.writeFileSync(filePath, audioBuffer);
  const media = db.createMedia(userId, {
    originalName: `narration-${profile.name}-${hash.slice(0, 8)}.mp3`,
    storedName, mimeType: 'audio/mpeg', kind: 'audio',
    sizeBytes: audioBuffer.length, tags: 'narration',
  });
  // Probe for duration so the render can trim the clip to the real length.
  try {
    const { probeMedia } = require('./ffmpeg');
    const probe = await probeMedia(filePath);
    if (probe && probe.durationSeconds) db.updateMedia(userId, media.id, { durationSeconds: probe.durationSeconds });
  } catch { /* duration stays unknown; the clip is trimmed by the segment */ }
  return { mediaId: media.id, filePath, cached: false, provider };
}

// --- Cloning -----------------------------------------------------------------
// Send a voice profile's sample to ElevenLabs voices/add and store the
// returned voice id. Needs an ElevenLabs key; refuses honestly without one.
async function cloneVoice(userId, profile) {
  const key = providerKey('voice_clone') || envKey('ELEVENLABS_API_KEY');
  if (!key) throw keyNeededError('Voice cloning + TTS (ElevenLabs)');
  if (!profile.sample_media_id) throw new Error(`Voice "${profile.name}" has no sample audio. Upload or record a sample first.`);
  const media = db.getMedia(userId, profile.sample_media_id);
  if (!media) throw new Error('The voice sample file is missing (it may have been deleted). Upload it again.');
  const filePath = path.join(config.uploadsDir, String(userId), media.stored_name);
  if (!fs.existsSync(filePath)) throw new Error('The voice sample file is missing on disk. Upload it again.');
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('name', profile.name);
  form.append('files', new Blob([buf], { type: media.mime_type || 'audio/mpeg' }), media.original_name);
  const res = await fetchWithTimeout(`${providerBaseUrl('voice_clone') || ELEVENLABS_API}/voices/add`, {
    method: 'POST', headers: { 'xi-api-key': key }, body: form,
  }, 120000);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`ElevenLabs voice cloning failed (${res.status}): ${detail.slice(0, 300) || 'no detail'}`);
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  const json = await res.json();
  if (!json.voice_id) throw new Error('ElevenLabs did not return a voice id.');
  return db.updateVoiceProfile(userId, profile.id, { providerVoiceId: json.voice_id });
}

module.exports = {
  OPENAI_VOICES, voiceProviderStatus, publicVoiceProfile,
  resolveVoice, synthesizeSpeech, cloneVoice,
};
