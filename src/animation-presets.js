'use strict';
// Magic Animate presets — one-click animation sets (v2.2.2, Release A).
//
// Two targets, one preset list:
//  * Design layers (Graphic Editor): the preset is stored on the layer as
//    `animation: { presetId, durationMs, delayMs, loop, keyframes }` where
//    keyframes are CSS-friendly [{ offset 0..1, opacity, translateX,
//    translateY, scale, rotate }]. The editor previews them with a real CSS
//    @keyframes rule. No server render is involved, so every preset here
//    is honestly previewable.
//  * Video clips (Video Editor): the same preset is expanded into the
//    clip keyframe shape { t (seconds), x, y (percent), scale, opacity }
//    that src/video-model.js already validates and the FFmpeg renderer
//    already interpolates (linearly — presets add intermediate keyframes
//    to approximate easing). 'typewriter' is design-only: it cannot be
//    rendered with drawtext, so it is never offered for clips.
//
// Pure functions — no DB, no provider. The route layer just calls these.
const PRESETS = [
  {
    id: 'fade', name: 'Fade In', description: 'Gently fades in from transparent.',
    durationMs: 800, appliesTo: ['design', 'clip'],
    design: [{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }],
    clip: (dur) => [
      { t: 0, opacity: 0 },
      { t: Math.min(dur, 0.8), opacity: 1 },
    ],
  },
  {
    id: 'slide-up', name: 'Slide Up', description: 'Rises from below while fading in.',
    durationMs: 700, appliesTo: ['design', 'clip'],
    design: [
      { offset: 0, opacity: 0, translateY: 40 },
      { offset: 1, opacity: 1, translateY: 0 },
    ],
    clip: (dur, clip) => [
      { t: 0, opacity: 0, y: Math.min(100, (clip.y ?? 50) + 12) },
      { t: Math.min(dur, 0.7), opacity: 1, y: clip.y ?? 50 },
    ],
  },
  {
    id: 'slide-left', name: 'Slide Left', description: 'Slides in from the right while fading in.',
    durationMs: 700, appliesTo: ['design', 'clip'],
    design: [
      { offset: 0, opacity: 0, translateX: 60 },
      { offset: 1, opacity: 1, translateX: 0 },
    ],
    clip: (dur, clip) => [
      { t: 0, opacity: 0, x: Math.min(100, (clip.x ?? 50) + 12) },
      { t: Math.min(dur, 0.7), opacity: 1, x: clip.x ?? 50 },
    ],
  },
  {
    id: 'pop', name: 'Pop', description: 'Pops in from small to full size.',
    durationMs: 600, appliesTo: ['design', 'clip'],
    design: [
      { offset: 0, opacity: 0, scale: 0.6 },
      { offset: 0.7, opacity: 1, scale: 1.05 },
      { offset: 1, opacity: 1, scale: 1 },
    ],
    clip: (dur) => [
      { t: 0, opacity: 0, scale: 0.6 },
      { t: Math.min(dur, 0.42), opacity: 1, scale: 1.05 },
      { t: Math.min(dur, 0.6), opacity: 1, scale: 1 },
    ],
  },
  {
    id: 'zoom', name: 'Zoom In', description: 'Slowly zooms from 100% to 115% across the clip.',
    durationMs: 2000, appliesTo: ['design', 'clip'],
    design: [
      { offset: 0, scale: 1 },
      { offset: 1, scale: 1.15 },
    ],
    clip: (dur) => [
      { t: 0, scale: 1 },
      { t: dur, scale: 1.15 },
    ],
  },
  {
    id: 'bounce', name: 'Bounce', description: 'Bounces in with a soft overshoot.',
    durationMs: 900, appliesTo: ['design', 'clip'],
    design: [
      { offset: 0, opacity: 0, scale: 0.5 },
      { offset: 0.5, opacity: 1, scale: 1.1 },
      { offset: 0.75, scale: 0.95 },
      { offset: 1, scale: 1 },
    ],
    clip: (dur) => [
      { t: 0, opacity: 0, scale: 0.5 },
      { t: Math.min(dur, 0.45), opacity: 1, scale: 1.1 },
      { t: Math.min(dur, 0.68), scale: 0.95 },
      { t: Math.min(dur, 0.9), scale: 1 },
    ],
  },
  {
    id: 'float', name: 'Float', description: 'Gently floats up and down (loops).',
    durationMs: 2400, loop: true, appliesTo: ['design', 'clip'],
    design: [
      { offset: 0, translateY: 0 },
      { offset: 0.5, translateY: -12 },
      { offset: 1, translateY: 0 },
    ],
    clip: (dur, clip) => {
      const y = clip.y ?? 50;
      return [
        { t: 0, y },
        { t: dur / 2, y: Math.max(0, y - 4) },
        { t: dur, y },
      ];
    },
  },
  {
    id: 'pulse', name: 'Pulse', description: 'Softly grows and shrinks (loops).',
    durationMs: 1600, loop: true, appliesTo: ['design', 'clip'],
    design: [
      { offset: 0, scale: 1, opacity: 1 },
      { offset: 0.5, scale: 1.06, opacity: 0.9 },
      { offset: 1, scale: 1, opacity: 1 },
    ],
    clip: (dur) => [
      { t: 0, scale: 1, opacity: 1 },
      { t: dur / 2, scale: 1.06, opacity: 0.9 },
      { t: dur, scale: 1, opacity: 1 },
    ],
  },
  {
    id: 'spin', name: 'Spin', description: 'Rotates once while fading in.',
    durationMs: 1000, appliesTo: ['design'],
    design: [
      { offset: 0, opacity: 0, rotate: -90 },
      { offset: 1, opacity: 1, rotate: 0 },
    ],
    clip: null,
  },
  {
    id: 'typewriter', name: 'Typewriter', description: 'Text appears letter by letter (design preview only — video rendering cannot draw it, so it is never offered for clips).',
    durationMs: 1800, appliesTo: ['design'],
    design: [
      { offset: 0, opacity: 1, typewriter: 0 },
      { offset: 1, opacity: 1, typewriter: 1 },
    ],
    clip: null,
  },
];

function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

function listPresets(target) {
  const list = target ? PRESETS.filter((p) => p.appliesTo.includes(target)) : PRESETS;
  return list.map((p) => ({
    id: p.id, name: p.name, description: p.description,
    durationMs: p.durationMs, loop: Boolean(p.loop), appliesTo: [...p.appliesTo],
  }));
}

function cleanDuration(v, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(100, Math.min(30000, n));
}

// Apply a preset to a design layer. Returns a NEW layer object with
// `animation` set; the input layer is not mutated.
function applyPresetToLayer(layer, presetId, { durationMs, delayMs = 0, loop } = {}) {
  if (!layer || typeof layer !== 'object') throw new Error('A design layer is required.');
  const preset = getPreset(presetId);
  if (!preset) throw new Error(`Unknown animation preset: ${presetId}. Available: ${PRESETS.map((p) => p.id).join(', ')}.`);
  if (!preset.appliesTo.includes('design')) throw new Error(`Preset "${presetId}" cannot be used on a design layer.`);
  const dur = cleanDuration(durationMs, preset.durationMs);
  const delay = Math.max(0, Math.min(30000, parseInt(delayMs, 10) || 0));
  const next = JSON.parse(JSON.stringify(layer));
  next.animation = {
    presetId: preset.id,
    durationMs: dur,
    delayMs: delay,
    loop: loop !== undefined ? Boolean(loop) : Boolean(preset.loop),
    keyframes: preset.design.map((k) => ({ ...k })),
  };
  return next;
}

// Apply a preset to a video clip. Returns a NEW clip object whose
// keyframes are replaced by the preset's expansion over the clip's
// duration (the input clip is not mutated). Existing keyframes are
// replaced — the preset IS the animation for that clip.
function applyPresetToClip(clip, presetId, { durationMs } = {}) {
  if (!clip || typeof clip !== 'object') throw new Error('A video clip is required.');
  const preset = getPreset(presetId);
  if (!preset) throw new Error(`Unknown animation preset: ${presetId}. Available: ${PRESETS.map((p) => p.id).join(', ')}.`);
  if (!preset.appliesTo.includes('clip') || typeof preset.clip !== 'function') {
    throw new Error(`Preset "${presetId}" cannot be used on a video clip (it needs CSS-only animation).`);
  }
  const dur = clip.duration && Number.isFinite(clip.duration) ? clip.duration : 5;
  const span = cleanDuration(durationMs, preset.durationMs) / 1000;
  const spanSec = Math.min(dur, span);
  // Base position: text clips carry x/y on clip.text; anything else
  // animates around the frame centre (50/50).
  const base = { x: (clip.text && clip.text.x) ?? 50, y: (clip.text && clip.text.y) ?? 50 };
  const kfs = preset.clip(spanSec, base).map((k) => {
    const out = { t: Math.max(0, Math.min(dur, Number(k.t) || 0)) };
    if (k.x !== undefined) out.x = Math.max(0, Math.min(100, k.x));
    if (k.y !== undefined) out.y = Math.max(0, Math.min(100, k.y));
    if (k.scale !== undefined) out.scale = Math.max(0.5, Math.min(3, k.scale));
    if (k.opacity !== undefined) out.opacity = Math.max(0, Math.min(1, k.opacity));
    return out;
  });
  // Hold the final state to the end of the clip so the animation does not
  // snap back mid-clip.
  const last = kfs[kfs.length - 1];
  if (last && last.t < dur) {
    const hold = { ...last, t: dur };
    kfs.push(hold);
  }
  const next = JSON.parse(JSON.stringify(clip));
  next.keyframes = kfs;
  next.animationPreset = preset.id;
  return next;
}

module.exports = { PRESETS, getPreset, listPresets, applyPresetToLayer, applyPresetToClip };
