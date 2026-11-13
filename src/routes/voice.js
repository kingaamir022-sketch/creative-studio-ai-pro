'use strict';
// Voice profiles + narration speech routes (post-Phase-5 quiz upgrade).
//   Voice profiles: the user's OWN voice (recorded sample → clone) and
//   generic AI voices. One default voice per user, applied to all videos
//   unless a bulk job or a row picks another voice.
//   Speech: synthesis goes through src/voice.js and REFUSES honestly with
//   key_needed when no provider key is configured — no fake audio, no
//   robotic local fallback passed off as the best voice.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const voice = require('../voice');
const credits = require('../credits');

const router = express.Router();

function getProfileOr404(req, res) {
  const p = db.getVoiceProfile(req.user.id, req.params.id);
  if (!p) { res.status(404).json({ error: 'Voice profile not found.' }); return null; }
  return p;
}

// --- List profiles (with TTS status, so the UI can be honest) ---
router.get('/profiles', auth.requireAuth, (req, res) => {
  res.json({
    profiles: db.listVoiceProfiles(req.user.id).map(voice.publicVoiceProfile),
    tts: voice.voiceProviderStatus(),
  });
});

router.get('/default', auth.requireAuth, (req, res) => {
  const d = db.getDefaultVoiceProfile(req.user.id);
  res.json({ profile: voice.publicVoiceProfile(d), tts: voice.voiceProviderStatus() });
});

// --- TTS status only (key state + available AI voices) ---
router.get('/tts-status', auth.requireAuth, (req, res) => {
  res.json({ tts: voice.voiceProviderStatus() });
});

// --- Create a profile ---
// kind 'clone': needs sampleMediaId (an audio file from the Media Library —
// the user's recorded voice, a few words). kind 'ai': needs aiVoice (one of
// the OpenAI TTS voices). The first profile a user creates becomes their
// default voice automatically.
router.post('/profiles', auth.requireAuth, (req, res) => {
  const { name, language = 'en', kind = 'clone', sampleMediaId, aiVoice } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
    return res.status(400).json({ error: 'Voice name is required (max 80 characters).' });
  }
  if (!['clone', 'ai'].includes(kind)) return res.status(400).json({ error: 'Kind must be "clone" (your own voice) or "ai" (a generic AI voice).' });
  if (language !== undefined && (typeof language !== 'string' || language.length > 10)) {
    return res.status(400).json({ error: 'Language must be a short code like "en" or "ur".' });
  }
  let sample = null;
  if (kind === 'clone') {
    if (!sampleMediaId) return res.status(400).json({ error: 'A voice sample is required: record a few words and upload the audio in the Media Library first, then pick it here.' });
    sample = db.getMedia(req.user.id, sampleMediaId);
    if (!sample) return res.status(404).json({ error: 'Sample audio not found in your Media Library.' });
    if (sample.kind !== 'audio') return res.status(400).json({ error: 'The voice sample must be an audio file.' });
  } else {
    if (!aiVoice || !voice.OPENAI_VOICES.includes(aiVoice)) {
      return res.status(400).json({ error: `Pick an AI voice: ${voice.OPENAI_VOICES.join(', ')}.` });
    }
  }
  const created = db.createVoiceProfile(req.user.id, {
    name: name.trim(), language: language || 'en', kind,
    sampleMediaId: sample ? sample.id : null, aiVoice: kind === 'ai' ? aiVoice : null,
  });
  // First profile = default voice (the user's voice on ALL videos).
  if (db.listVoiceProfiles(req.user.id).length === 1) db.setDefaultVoiceProfile(req.user.id, created.id);
  db.audit(req.user.id, 'voice_create', 'voice_profile', created.id, `Created voice "${created.name}" (${kind})`);
  res.status(201).json({ profile: voice.publicVoiceProfile(db.getVoiceProfile(req.user.id, created.id)) });
});

// --- Update a profile (rename / language / make default) ---
router.patch('/profiles/:id', auth.requireAuth, (req, res) => {
  const p = getProfileOr404(req, res);
  if (!p) return;
  const { name, language, isDefault } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 80)) {
    return res.status(400).json({ error: 'Voice name must be 1–80 characters.' });
  }
  if (language !== undefined && (typeof language !== 'string' || language.length > 10)) {
    return res.status(400).json({ error: 'Language must be a short code like "en" or "ur".' });
  }
  let updated = db.updateVoiceProfile(req.user.id, p.id, { name: name !== undefined ? name.trim() : undefined, language });
  if (isDefault === true) updated = db.setDefaultVoiceProfile(req.user.id, p.id);
  res.json({ profile: voice.publicVoiceProfile(updated) });
});

// --- Delete a profile (its sample audio stays in the Media Library) ---
router.delete('/profiles/:id', auth.requireAuth, (req, res) => {
  const p = getProfileOr404(req, res);
  if (!p) return;
  db.deleteVoiceProfile(req.user.id, p.id);
  db.audit(req.user.id, 'voice_delete', 'voice_profile', p.id, `Deleted voice "${p.name}"`);
  res.json({ ok: true });
});

// --- Clone a profile's sample into a provider voice (needs a key) ---
router.post('/profiles/:id/clone', auth.requireAuth, async (req, res) => {
  const p = getProfileOr404(req, res);
  if (!p) return;
  if (p.kind !== 'clone') return res.status(400).json({ error: 'Only your own voice (kind "clone") can be cloned. AI voices are ready as-is.' });
  if (p.provider_voice_id) return res.json({ profile: voice.publicVoiceProfile(p), alreadyCloned: true });
  try {
    const updated = await voice.cloneVoice(req.user.id, p);
    db.audit(req.user.id, 'voice_cloned', 'voice_profile', p.id, `Cloned voice "${p.name}" to the provider`);
    res.json({ profile: voice.publicVoiceProfile(updated) });
  } catch (err) {
    if (err.code === 'PROVIDER_KEY_NEEDED') return res.status(503).json({ error: err.message, code: 'PROVIDER_KEY_NEEDED' });
    res.status(400).json({ error: err.message });
  }
});

// --- Synthesise one text with a voice (narration segment) ---
// Body: { text, voiceProfileId? } — no profile id = the user's default voice.
// Without a key this REFUSES (503, code PROVIDER_KEY_NEEDED) and creates
// no audio file. With a key it returns the cached/created Media audio row.
router.post('/synthesise', auth.requireAuth, async (req, res) => {
  const { text, voiceProfileId } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Text is required.' });
  if (text.length > 2000) return res.status(400).json({ error: 'Text is too long for one narration segment (max 2000 characters).' });
  let profile = null;
  if (voiceProfileId) {
    profile = db.getVoiceProfile(req.user.id, voiceProfileId);
    if (!profile) return res.status(404).json({ error: 'Voice profile not found.' });
  } else {
    profile = db.getDefaultVoiceProfile(req.user.id);
    if (!profile) return res.status(400).json({ error: 'No voice profile yet. Create one first (your own voice from a sample, or an AI voice).' });
  }
  // Phase 8: pre-flight credit check, charge on success.
  const check = credits.checkCredits(req.user.id, 'ai_voice');
  if (!check.ok) return res.status(402).json({ error: check.error, code: check.code, needed: check.needed, balance: check.balance });
  try {
    const result = await voice.synthesizeSpeech(req.user.id, profile, text);
    credits.chargeCredits(req.user.id, 'ai_voice', `Spoke ${text.length} chars with "${profile.name}" (${result.provider}${result.cached ? ', cached' : ''})`);
    db.audit(req.user.id, 'voice_synthesised', 'voice_profile', profile.id,
      `Spoke ${text.length} chars with "${profile.name}" (${result.provider}${result.cached ? ', cached' : ''})`);
    res.json({
      mediaId: result.mediaId, cached: result.cached, provider: result.provider,
      voice: voice.publicVoiceProfile(profile),
    });
  } catch (err) {
    if (err.code === 'PROVIDER_KEY_NEEDED') {
      return res.status(503).json({ error: err.message, code: 'PROVIDER_KEY_NEEDED', tts: voice.voiceProviderStatus() });
    }
    res.status(400).json({ error: err.message, code: err.code || undefined });
  }
});

module.exports = router;
