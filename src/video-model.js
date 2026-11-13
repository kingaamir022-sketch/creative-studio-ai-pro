'use strict';
// Video timeline model (Phase 3).
// Pure functions + validation. The timeline JSON is stored as project content
// (type 'video') and is the single source of truth for both the browser
// editor preview and the server-side FFmpeg renderer.
//
// Timeline shape:
// {
//   version: 1, width, height, fps, background: '#000000',
//   tracks: [
//     { id, kind: 'video'|'audio'|'text', name, locked, muted,
//       clips: [ clip ] }
//   ],
//   markers: [ { t, label } ]
// }
// Clip shape:
// {
//   id, mediaId (null for text clips), kind: 'video'|'audio'|'text',
//   name, start (timeline seconds), duration, srcStart (in-point, seconds),
//   speed (0.25..4), volume (0..1), muted,
//   fadeIn, fadeOut (seconds), rotation (0|90|180|270), flip: 'none'|'h'|'v',
//   opacity (0..1), scaleMode: 'fit'|'fill', zoom (0.5..3),
//   filters: { brightness (-1..1), contrast (-1..1), saturation (-1..2),
//              temperature (-1..1), sharpness (0..1), blur (0..10), vignette (0..1) },
//   transition: { type: 'none'|'fade'|'dissolve'|'slide'|'wipe', duration } (into this clip),
//   groupId: null|string,
//   text: { text, fontFamily, fontSize, fontWeight, color, align, x, y (percent),
//           bgColor ('' = none), animIn: 'none'|'fade'|'slide', animOut: 'none'|'fade'|'slide' },
//   keyframes: [ { t (seconds from clip start), x, y (percent), scale, opacity } ]
// }
// Keyframes interpolate linearly (position / scale / opacity). At least two
// keyframes are needed for a visible animation; a single keyframe is a hold.

const TRANSITIONS = [
  { id: 'none', name: 'None (hard cut)', xfade: null, maxDuration: 0 },
  { id: 'fade', name: 'Fade', xfade: 'fade', maxDuration: 2 },
  { id: 'dissolve', name: 'Dissolve', xfade: 'dissolve', maxDuration: 2 },
  { id: 'slide', name: 'Slide', xfade: 'slideleft', maxDuration: 2 },
  { id: 'wipe', name: 'Wipe', xfade: 'wipeleft', maxDuration: 2 },
];

const FILTERS = [
  { id: 'brightness', name: 'Brightness', min: -1, max: 1, def: 0 },
  { id: 'contrast', name: 'Contrast', min: -1, max: 1, def: 0 },
  { id: 'saturation', name: 'Saturation', min: -1, max: 2, def: 0 },
  { id: 'temperature', name: 'Temperature', min: -1, max: 1, def: 0 },
  { id: 'sharpness', name: 'Sharpness', min: 0, max: 1, def: 0 },
  { id: 'blur', name: 'Blur', min: 0, max: 10, def: 0 },
  { id: 'vignette', name: 'Vignette', min: 0, max: 1, def: 0 },
];

const ASPECTS = [
  { id: '16:9', name: 'Landscape 16:9', width: 1280, height: 720 },
  { id: '9:16', name: 'Vertical 9:16', width: 720, height: 1280 },
  { id: '1:1', name: 'Square 1:1', width: 720, height: 720 },
  { id: '4:5', name: 'Portrait 4:5', width: 720, height: 900 },
];

const RESOLUTIONS = [
  { id: '720p', name: '720p HD', scale: 720 },
  { id: '1080p', name: '1080p Full HD', scale: 1080 },
];

const FPS_OPTIONS = [24, 30, 60];

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function uid(prefix) {
  return `${prefix || 'clip'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function deep(o) { return JSON.parse(JSON.stringify(o)); }

function blankTimeline(aspectId = '16:9', fps = 30) {
  const a = ASPECTS.find((x) => x.id === aspectId) || ASPECTS[0];
  return {
    version: 1, width: a.width, height: a.height, fps,
    background: '#000000',
    tracks: [
      { id: uid('track'), kind: 'video', name: 'Video 1', locked: false, muted: false, clips: [] },
      { id: uid('track'), kind: 'audio', name: 'Audio 1', locked: false, muted: false, clips: [] },
      { id: uid('track'), kind: 'text', name: 'Text 1', locked: false, muted: false, clips: [] },
    ],
    markers: [],
  };
}

function defaultClip(kind, mediaId, start = 0, duration = 2) {
  return {
    id: uid('clip'), mediaId: mediaId || null, kind,
    name: kind === 'text' ? 'Text clip' : kind === 'audio' ? 'Audio clip' : 'Video clip',
    start, duration, srcStart: 0,
    speed: 1, volume: 1, muted: false,
    fadeIn: 0, fadeOut: 0, rotation: 0, flip: 'none',
    opacity: 1, scaleMode: 'fit', zoom: 1,
    filters: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, blur: 0, vignette: 0 },
    transition: { type: 'none', duration: 0.5 },
    groupId: null,
    text: { text: 'Your text', fontFamily: 'Poppins', fontSize: 64, fontWeight: 700, color: '#ffffff', align: 'center', x: 50, y: 50, bgColor: '', animIn: 'fade', animOut: 'fade' },
    keyframes: [],
  };
}

function validateTimeline(t) {
  const errors = [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['Timeline must be a JSON object.'];
  if (!isNum(t.width) || t.width < 160 || t.width > 3840) errors.push('Timeline width must be 160–3840 px.');
  if (!isNum(t.height) || t.height < 160 || t.height > 3840) errors.push('Timeline height must be 160–3840 px.');
  if (!FPS_OPTIONS.includes(t.fps)) errors.push(`fps must be one of ${FPS_OPTIONS.join(', ')}.`);
  if (!Array.isArray(t.tracks) || t.tracks.length === 0) errors.push('Timeline needs at least one track.');
  if (t.markers !== undefined && !Array.isArray(t.markers)) errors.push('Markers must be an array.');
  const videoTracks = (t.tracks || []).filter((tr) => tr.kind === 'video');
  if (videoTracks.length > 2) errors.push('Phase 3 supports at most 2 video tracks (main + one overlay/PiP track).');
  let clipCount = 0;
  for (const tr of t.tracks || []) {
    if (!['video', 'audio', 'text'].includes(tr.kind)) { errors.push(`Track "${tr.name || tr.id}" has an unknown kind.`); continue; }
    if (!Array.isArray(tr.clips)) { errors.push(`Track "${tr.name || tr.id}" needs a clips array.`); continue; }
    const sorted = [...tr.clips].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      clipCount++;
      const where = `clip "${c.name || c.id}" on track "${tr.name}"`;
      if (c.kind !== tr.kind) errors.push(`${where}: clip kind "${c.kind}" does not match track kind "${tr.kind}".`);
      if (!isNum(c.start) || c.start < 0) errors.push(`${where}: start must be >= 0.`);
      if (!isNum(c.duration) || c.duration <= 0 || c.duration > 36000) errors.push(`${where}: duration must be > 0 and <= 10 hours.`);
      if (!isNum(c.srcStart) || c.srcStart < 0) errors.push(`${where}: srcStart must be >= 0.`);
      if (!isNum(c.speed) || c.speed < 0.25 || c.speed > 4) errors.push(`${where}: speed must be 0.25–4.`);
      if (!isNum(c.volume) || c.volume < 0 || c.volume > 1) errors.push(`${where}: volume must be 0–1.`);
      if (!isNum(c.opacity) || c.opacity < 0 || c.opacity > 1) errors.push(`${where}: opacity must be 0–1.`);
      if (!isNum(c.zoom) || c.zoom < 0.5 || c.zoom > 3) errors.push(`${where}: zoom must be 0.5–3.`);
      if (![0, 90, 180, 270].includes(c.rotation)) errors.push(`${where}: rotation must be 0, 90, 180 or 270.`);
      if (!['none', 'h', 'v'].includes(c.flip)) errors.push(`${where}: flip must be none, h or v.`);
      if (!['fit', 'fill'].includes(c.scaleMode)) errors.push(`${where}: scaleMode must be fit or fill.`);
      if (c.kind !== 'text' && (c.mediaId === null || c.mediaId === undefined)) errors.push(`${where}: a ${c.kind} clip needs a media file.`);
      if (c.kind === 'text' && (!c.text || typeof c.text.text !== 'string' || (!c.text.text.trim() && !(c.text.panel && typeof c.text.panel === 'object')))) errors.push(`${where}: a text clip needs text (a panel-only clip is allowed).`);
      if (c.kind === 'text' && c.text) {
        // Phase 4: optional base alpha (reveal dimming) + option panel (quiz).
        if (c.text.alpha !== undefined && (!isNum(c.text.alpha) || c.text.alpha < 0 || c.text.alpha > 1)) errors.push(`${where}: text alpha must be 0–1.`);
        if (c.text.panel !== undefined) {
          const p = c.text.panel;
          if (!p || typeof p !== 'object') errors.push(`${where}: text panel must be an object.`);
          else {
            for (const k of ['x', 'y', 'w', 'h']) if (p[k] !== undefined && !isNum(p[k])) errors.push(`${where}: panel ${k} must be a number.`);
            if (p.fill !== undefined && !/^#[0-9a-fA-F]{6}$/.test(p.fill)) errors.push(`${where}: panel fill must be a #rrggbb hex color.`);
            if (p.border !== undefined && !/^#[0-9a-fA-F]{6}$/.test(p.border)) errors.push(`${where}: panel border must be a #rrggbb hex color.`);
            if (p.alpha !== undefined && (!isNum(p.alpha) || p.alpha < 0 || p.alpha > 1)) errors.push(`${where}: panel alpha must be 0–1.`);
          }
        }
      }
      if (c.transition) {
        const trDef = TRANSITIONS.find((x) => x.id === c.transition.type);
        if (!trDef) errors.push(`${where}: unknown transition "${c.transition.type}".`);
        else if (c.transition.type !== 'none' && (!isNum(c.transition.duration) || c.transition.duration <= 0 || c.transition.duration > trDef.maxDuration)) {
          errors.push(`${where}: transition duration must be 0–${trDef.maxDuration}s.`);
        }
      }
      if (c.filters) {
        for (const f of FILTERS) {
          const v = c.filters[f.id];
          if (v !== undefined && (!isNum(v) || v < f.min || v > f.max)) errors.push(`${where}: filter ${f.id} must be ${f.min}–${f.max}.`);
        }
      }
      // Phase 4 bulk-template metadata (ignored by the renderer except loop).
      if (c.loop !== undefined && typeof c.loop !== 'boolean') errors.push(`${where}: loop must be true/false.`);
      if (c.isBackground !== undefined && typeof c.isBackground !== 'boolean') errors.push(`${where}: isBackground must be true/false.`);
      if (c.dynamicMediaField !== undefined && (typeof c.dynamicMediaField !== 'string' || !c.dynamicMediaField.trim() || c.dynamicMediaField.length > 80)) {
        errors.push(`${where}: dynamicMediaField must be a field name (max 80 characters).`);
      }
      if (Array.isArray(c.keyframes)) {
        for (const k of c.keyframes) {
          if (!isNum(k.t) || k.t < 0 || k.t > c.duration) errors.push(`${where}: keyframe time must be within the clip (0–${c.duration}s).`);
          if (k.x !== undefined && (!isNum(k.x) || k.x < 0 || k.x > 100)) errors.push(`${where}: keyframe x must be 0–100.`);
          if (k.y !== undefined && (!isNum(k.y) || k.y < 0 || k.y > 100)) errors.push(`${where}: keyframe y must be 0–100.`);
          if (k.scale !== undefined && (!isNum(k.scale) || k.scale < 0.5 || k.scale > 3)) errors.push(`${where}: keyframe scale must be 0.5–3.`);
          if (k.opacity !== undefined && (!isNum(k.opacity) || k.opacity < 0 || k.opacity > 1)) errors.push(`${where}: keyframe opacity must be 0–1.`);
        }
      }
      if (i > 0) {
        const prev = sorted[i - 1];
        if (c.start < prev.start + prev.duration - 1e-6) {
          errors.push(`${where}: overlaps the previous clip on the same track (clips on one track must not overlap).`);
        }
      }
    }
  }
  if (clipCount === 0) errors.push('Timeline has no clips — add at least one video, audio or text clip.');
  return errors;
}

function allClips(t) {
  return (t.tracks || []).flatMap((tr) => tr.clips.map((c) => ({ ...c, trackKind: tr.kind, trackId: tr.id, trackMuted: tr.muted, trackLocked: tr.locked })));
}

function totalDuration(t) {
  let d = 0;
  for (const c of allClips(t)) d = Math.max(d, c.start + c.duration);
  return d;
}

// --- Pure timeline edits (used by the editor and the tests) ---
function splitClipAt(timeline, clipId, atTime) {
  const t = deep(timeline);
  for (const tr of t.tracks) {
    const idx = tr.clips.findIndex((c) => c.id === clipId);
    if (idx === -1) continue;
    const c = tr.clips[idx];
    const rel = atTime - c.start;
    if (rel <= 0.05 || rel >= c.duration - 0.05) return { timeline: t, error: 'Playhead must be inside the clip (not at its edges) to split.' };
    const left = deep(c);
    const right = deep(c);
    right.id = uid('clip'); // the split-off clip is a new clip, not a copy of the id
    left.duration = rel;
    right.start = atTime;
    right.duration = c.duration - rel;
    right.srcStart = c.srcStart + rel * c.speed;
    right.transition = { type: 'none', duration: 0.5 };
    right.keyframes = (c.keyframes || []).filter((k) => k.t >= rel).map((k) => ({ ...k, t: k.t - rel }));
    left.keyframes = (c.keyframes || []).filter((k) => k.t < rel);
    // Keyframes on the right clip keep their absolute values; a keyframe
    // exactly at the split is kept on the left.
    tr.clips.splice(idx, 1, left, right);
    return { timeline: t, error: null, leftId: left.id, rightId: right.id };
  }
  return { timeline: t, error: 'Clip not found.' };
}

function trimClip(timeline, clipId, { start, duration, srcStart }) {
  const t = deep(timeline);
  for (const tr of t.tracks) {
    const c = tr.clips.find((x) => x.id === clipId);
    if (!c) continue;
    if (start !== undefined) c.start = Math.max(0, start);
    if (duration !== undefined) c.duration = Math.max(0.05, duration);
    if (srcStart !== undefined) c.srcStart = Math.max(0, srcStart);
    return { timeline: t, error: null };
  }
  return { timeline: t, error: 'Clip not found.' };
}

// Ripple delete: remove the clip and pull every later clip on the same track
// earlier by the removed clip's duration.
function rippleDelete(timeline, clipId) {
  const t = deep(timeline);
  for (const tr of t.tracks) {
    const idx = tr.clips.findIndex((c) => c.id === clipId);
    if (idx === -1) continue;
    const removed = tr.clips[idx];
    tr.clips.splice(idx, 1);
    for (const c of tr.clips) {
      if (c.start >= removed.start + removed.duration - 1e-6) c.start -= removed.duration;
    }
    return { timeline: t, error: null };
  }
  return { timeline: t, error: 'Clip not found.' };
}

// Linear interpolation of keyframed properties at a time (seconds from clip
// start). Returns { x, y, scale, opacity } with defaults when no keyframes.
function keyframeAt(clip, time) {
  const out = { x: 50, y: 50, scale: 1, opacity: 1 };
  const kfs = [...(clip.keyframes || [])].sort((a, b) => a.t - b.t);
  if (!kfs.length) return out;
  const props = ['x', 'y', 'scale', 'opacity'];
  for (const p of props) {
    const defined = kfs.filter((k) => k[p] !== undefined);
    if (!defined.length) continue;
    if (time <= defined[0].t) { out[p] = defined[0][p]; continue; }
    if (time >= defined[defined.length - 1].t) { out[p] = defined[defined.length - 1][p]; continue; }
    for (let i = 0; i < defined.length - 1; i++) {
      const a = defined[i], b = defined[i + 1];
      if (time >= a.t && time <= b.t) {
        const f = b.t === a.t ? 0 : (time - a.t) / (b.t - a.t);
        out[p] = a[p] + (b[p] - a[p]) * f;
        break;
      }
    }
  }
  return out;
}

// Output dimensions for a named resolution at the timeline's aspect ratio.
function outputDims(timeline, resolutionId) {
  const res = RESOLUTIONS.find((r) => r.id === resolutionId) || RESOLUTIONS[0];
  const ar = timeline.width / timeline.height;
  if (ar >= 1) return { width: Math.round(res.scale * ar / 2) * 2, height: res.scale };
  return { width: res.scale, height: Math.round(res.scale / ar / 2) * 2 };
}

module.exports = {
  TRANSITIONS, FILTERS, ASPECTS, RESOLUTIONS, FPS_OPTIONS,
  blankTimeline, defaultClip, validateTimeline, allClips, totalDuration,
  splitClipAt, trimClip, rippleDelete, keyframeAt, outputDims,
  clamp, deep, uid,
};
