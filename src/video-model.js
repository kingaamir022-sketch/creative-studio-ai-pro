'use strict';
// Video timeline model (Phase 3, extended v2.5.0 — CapCut parity round).
// Pure functions + validation. The timeline JSON is stored as project content
// (type 'video') and is the single source of truth for both the browser
// editor preview and the server-side FFmpeg renderer.
//
// Timeline shape:
// {
//   version: 1, width, height, fps,
//   background: '#000000' | { type:'color'|'image'|'blur', color, mediaId },
//   tracks: [
//     { id, kind: 'video'|'audio'|'text'|'effect', name, locked, muted,
//       clips: [ clip ] }
//   ],
//   markers: [ { t, label } ]
// }
// Clip shape (all new v2.5.0 fields are optional; old timelines validate
// and render exactly as before):
// {
//   id, mediaId (null for text/effect/compound clips), kind: 'video'|'audio'|'text'|'effect'|'compound',
//   name, start, duration, srcStart, speed (0.1..100), volume (0..2), muted,
//   fadeIn, fadeOut, rotation (0|90|180|270), flip, opacity, scaleMode, zoom,
//   filters: {...7 sliders}, filterPreset: 'none'|preset id, lutMediaId: null|media id,
//   transition: { type, duration } (into this clip),
//   groupId, linkedTo: null|clip id (J/L cut link),
//   effects: [ { id, intensity 0..1 } ]            (#2 video effects)
//   chroma: { enabled, color, similarity, blend }  (#3 green screen)
//   speedCurve: { preset, points:[{t,speed}] }     (#4 speed ramping)
//   stabilize: { enabled, strength 0..1 }          (#8)
//   mask: { type, x,y,w,h (%), rotation, feather, invert }  (#9)
//   reverse: bool, freeze: { enabled, at, duration }        (#16)
//   audioFx: { denoise, enhanceVoice, vocalIsolation, loudnorm, ducking }  (#17)
//   autoReframe: { enabled, targetAspect }         (#18)
//   opticalFlow: bool                              (#43)
//   velocityEffect: 'none'|preset                  (#59)
//   splitScreen: { enabled, partnerClipId }        (#58)
//   overlay: { x,y,w,h } percent (PiP position)    (#40)
//   nested: timeline object (compound clips only)  (#35)
//   text: { text, fontFamily, fontSize, fontWeight, color, align, x, y,
//           bgColor, animIn, animOut, captionStyle, letterSpacing,
//           lineHeight, shadow, stroke, gradient },
//   keyframes: [ { t, x, y, scale, opacity, rotation, volume, easing } ]
// }
// Keyframes interpolate with per-keyframe easing (easing lives on the
// TARGET keyframe and shapes the segment leading into it). Rotation
// keyframes are 0–360 and are relative to the clip's static rotation;
// volume keyframes are 0–2.

const TRANSITIONS = [
  { id: 'none', name: 'None (hard cut)', xfade: null, maxDuration: 0 },
  { id: 'fade', name: 'Fade', xfade: 'fade', maxDuration: 5 },
  { id: 'dissolve', name: 'Dissolve', xfade: 'dissolve', maxDuration: 5 },
  { id: 'slide', name: 'Slide left', xfade: 'slideleft', maxDuration: 5 },
  { id: 'slideleft', name: 'Slide left', xfade: 'slideleft', maxDuration: 5 },
  { id: 'slideright', name: 'Slide right', xfade: 'slideright', maxDuration: 5 },
  { id: 'slideup', name: 'Slide up', xfade: 'slideup', maxDuration: 5 },
  { id: 'slidedown', name: 'Slide down', xfade: 'slidedown', maxDuration: 5 },
  { id: 'wipe', name: 'Wipe left', xfade: 'wipeleft', maxDuration: 5 },
  { id: 'wipeleft', name: 'Wipe left', xfade: 'wipeleft', maxDuration: 5 },
  { id: 'wiperight', name: 'Wipe right', xfade: 'wiperight', maxDuration: 5 },
  { id: 'wipeup', name: 'Wipe up', xfade: 'wipeup', maxDuration: 5 },
  { id: 'wipedown', name: 'Wipe down', xfade: 'wipedown', maxDuration: 5 },
  { id: 'circlecrop', name: 'Circle crop', xfade: 'circlecrop', maxDuration: 5 },
  { id: 'circleopen', name: 'Circle open', xfade: 'circleopen', maxDuration: 5 },
  { id: 'rectcrop', name: 'Rectangle crop', xfade: 'rectcrop', maxDuration: 5 },
  { id: 'pixelize', name: 'Pixelize', xfade: 'pixelize', maxDuration: 5 },
  { id: 'radial', name: 'Radial', xfade: 'radial', maxDuration: 5 },
  { id: 'smoothleft', name: 'Smooth slide left', xfade: 'smoothleft', maxDuration: 5 },
  { id: 'smoothright', name: 'Smooth slide right', xfade: 'smoothright', maxDuration: 5 },
  { id: 'smoothup', name: 'Smooth slide up', xfade: 'smoothup', maxDuration: 5 },
  { id: 'smoothdown', name: 'Smooth slide down', xfade: 'smoothdown', maxDuration: 5 },
  { id: 'fadeblack', name: 'Fade to black', xfade: 'fadeblack', maxDuration: 5 },
  { id: 'fadewhite', name: 'Fade to white', xfade: 'fadewhite', maxDuration: 5 },
  { id: 'diagtl', name: 'Diagonal (top-left)', xfade: 'diagtl', maxDuration: 5 },
  { id: 'diagbr', name: 'Diagonal (bottom-right)', xfade: 'diagbr', maxDuration: 5 },
  { id: 'hblur', name: 'Horizontal blur', xfade: 'hblur', maxDuration: 5 },
  { id: 'distance', name: 'Distance', xfade: 'distance', maxDuration: 5 },
];

// #2 — Video effects library. Every id maps to a real FFmpeg filter chain
// in src/render.js (effectFilter). Intensity is 0..1.
const EFFECTS = [
  { id: 'glitch', name: 'Glitch', description: 'RGB channel shift + digital noise.' },
  { id: 'retro', name: 'Retro', description: 'Cross-process curves, muted colours, grain and vignette.' },
  { id: 'blur', name: 'Blur', description: 'Soft Gaussian blur.' },
  { id: 'vhs', name: 'VHS', description: 'Tracking noise, soft contrast and a worn-tape look.' },
  { id: 'grain', name: 'Film grain', description: 'Animated film grain over the picture.' },
  { id: 'lightleak', name: 'Light leak', description: 'Warm leak in the highlights, lifted blacks.' },
  { id: 'vintage', name: 'Vintage', description: 'Faded film look with warm tones.' },
  { id: 'noir', name: 'Noir', description: 'High-contrast black and white.' },
  { id: 'neon', name: 'Neon', description: 'Boosted saturation and contrast with a sharpened edge.' },
  { id: 'dream', name: 'Dream', description: 'Soft glow, lifted brightness and gentle saturation.' },
  { id: 'sharpen', name: 'Sharpen', description: 'Unsharp-mask sharpening.' },
  { id: 'pixelate', name: 'Pixelate', description: 'Blocky low-resolution mosaic.' },
  { id: 'invert', name: 'Invert', description: 'Negative image.' },
  { id: 'warm', name: 'Warm', description: 'Warm colour balance.' },
  { id: 'cool', name: 'Cool', description: 'Cool colour balance.' },
  { id: 'edge', name: 'Edge detect', description: 'Line-art edge drawing.' },
];

// #7 — Named filter presets. A preset is a stored bundle of the 7 slider
// values; clip.filters values that are non-zero override the preset (a
// zero filter value means "use the preset value").
const FILTER_PRESETS = [
  { id: 'none', name: 'None', sliders: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, blur: 0, vignette: 0 } },
  { id: 'vivid', name: 'Vivid', sliders: { brightness: 0.05, contrast: 0.15, saturation: 0.5, temperature: 0, sharpness: 0.1, blur: 0, vignette: 0 } },
  { id: 'retro', name: 'Retro', sliders: { brightness: 0.02, contrast: -0.05, saturation: -0.25, temperature: 0.25, sharpness: 0, blur: 0, vignette: 0.35 } },
  { id: 'bw', name: 'Black & white', sliders: { brightness: 0, contrast: 0.1, saturation: -1, temperature: 0, sharpness: 0.1, blur: 0, vignette: 0 } },
  { id: 'warm', name: 'Warm', sliders: { brightness: 0.03, contrast: 0.05, saturation: 0.15, temperature: 0.4, sharpness: 0, blur: 0, vignette: 0 } },
  { id: 'cool', name: 'Cool', sliders: { brightness: 0, contrast: 0.05, saturation: 0.1, temperature: -0.4, sharpness: 0, blur: 0, vignette: 0 } },
  { id: 'noir', name: 'Noir', sliders: { brightness: -0.05, contrast: 0.2, saturation: -1, temperature: 0, sharpness: 0.15, blur: 0, vignette: 0.2 } },
  { id: 'golden', name: 'Golden hour', sliders: { brightness: 0.05, contrast: 0.05, saturation: 0.3, temperature: 0.5, sharpness: 0, blur: 0, vignette: 0.15 } },
  { id: 'teal', name: 'Teal', sliders: { brightness: 0, contrast: 0.1, saturation: 0.2, temperature: -0.3, sharpness: 0.05, blur: 0, vignette: 0 } },
  { id: 'faded', name: 'Faded', sliders: { brightness: 0.08, contrast: -0.2, saturation: -0.2, temperature: 0, sharpness: 0, blur: 0, vignette: 0.1 } },
];

// #4 — Speed curve presets. points are {t: 0..1 (fraction of the clip),
// speed: multiplier}. 'custom' uses the clip's own points.
const SPEED_CURVE_PRESETS = [
  { id: 'none', name: 'None (constant speed)', points: [] },
  { id: 'montage', name: 'Montage', points: [{ t: 0, speed: 0.5 }, { t: 0.5, speed: 2.5 }, { t: 1, speed: 0.5 }] },
  { id: 'hero', name: 'Hero', points: [{ t: 0, speed: 1 }, { t: 0.35, speed: 0.25 }, { t: 0.65, speed: 0.25 }, { t: 1, speed: 1 }] },
  { id: 'bullet', name: 'Bullet', points: [{ t: 0, speed: 3 }, { t: 0.5, speed: 0.4 }, { t: 1, speed: 1 }] },
  { id: 'jumpcut', name: 'Jump cut', points: [{ t: 0, speed: 1 }, { t: 0.25, speed: 3 }, { t: 0.5, speed: 0.5 }, { t: 0.75, speed: 3 }, { t: 1, speed: 1 }] },
  { id: 'flashin', name: 'Flash in', points: [{ t: 0, speed: 4 }, { t: 0.6, speed: 1 }, { t: 1, speed: 0.5 }] },
  { id: 'flashout', name: 'Flash out', points: [{ t: 0, speed: 0.5 }, { t: 0.4, speed: 1 }, { t: 1, speed: 4 }] },
  { id: 'custom', name: 'Custom', points: [] },
];

// #59 — Velocity effects: a speed ramp plus a visual treatment, applied
// over the speed system.
const VELOCITY_EFFECTS = [
  { id: 'none', name: 'None', description: 'No velocity effect.' },
  { id: 'flash', name: 'Flash', description: 'Fast-in speed ramp with a bright flash look.', curve: 'flashin' },
  { id: 'blur-shake', name: 'Blur shake', description: 'Jump-cut ramp with blur and a handheld shake.', curve: 'jumpcut' },
  { id: 'fade-blur', name: 'Fade blur', description: 'Slow ramp with a soft blurred fade.', curve: 'flashout' },
  { id: 'retro-zoom', name: 'Retro zoom', description: 'Montage ramp with a vintage grade and a slow zoom.', curve: 'montage' },
  { id: 'rainbow', name: 'Rainbow', description: 'Hero ramp with a cycling hue shift.', curve: 'hero' },
];

// #49 — Caption styles for text clips.
const CAPTION_STYLE_PRESETS = [
  { id: 'default', name: 'Default', description: 'Plain text in the clip colour.' },
  { id: 'highlight', name: 'Highlight', description: 'Text on a solid highlight box.' },
  { id: 'glow', name: 'Glow', description: 'Text with a soft glow shadow.' },
  { id: 'karaoke', name: 'Karaoke', description: 'High-contrast yellow text for sung/spoken lines.' },
  { id: 'bold', name: 'Bold outline', description: 'Text with a dark outline for readability.' },
];

// #53 — Export presets (UI list; the jobs endpoint accepts the same fields).
const EXPORT_PRESETS = [
  { id: 'tiktok', name: 'TikTok / Reels / Shorts', resolution: '1080p', fps: 30, format: 'mp4', aspect: '9:16', note: '1080×1920 vertical, 30 fps, H.264.' },
  { id: 'youtube', name: 'YouTube 1080p', resolution: '1080p', fps: 30, format: 'mp4', aspect: '16:9', note: '1920×1080, 30 fps, H.264.' },
  { id: 'youtube-4k', name: 'YouTube 4K', resolution: '4K', fps: 30, format: 'mp4', aspect: '16:9', note: '3840×2160, 30 fps, HEVC.' },
  { id: 'instagram-square', name: 'Instagram square', resolution: '1080p', fps: 30, format: 'mp4', aspect: '1:1', note: '1080×1080, 30 fps, H.264.' },
  { id: 'web', name: 'Web (WebM)', resolution: '720p', fps: 30, format: 'webm', aspect: '16:9', note: '1280×720, 30 fps, VP9.' },
  { id: 'x-720', name: 'X / general 720p', resolution: '720p', fps: 30, format: 'mp4', aspect: '16:9', note: '1280×720, 30 fps, H.264.' },
  { id: 'audio-mp3', name: 'Audio only (MP3)', resolution: '720p', fps: 30, format: 'mp3', aspect: '16:9', note: 'Audio-only export, MP3 192 kbps.', audioOnly: true },
  { id: 'gif', name: 'Animated GIF', resolution: '720p', fps: 15, format: 'gif', aspect: '16:9', note: 'Animated GIF, first 10 seconds, 640 px wide.', gifExport: true },
];

const EASING_TYPES = ['linear', 'ease-in', 'ease-out', 'ease-in-out'];
const MASK_TYPES = ['none', 'circle', 'rect', 'linear', 'mirror', 'heart', 'star'];
const VOCAL_ISOLATION_TYPES = ['off', 'remove', 'keep'];

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
  { id: '2K', name: '2K QHD', scale: 1440 },
  { id: '4K', name: '4K UHD', scale: 2160 },
];

const FPS_OPTIONS = [24, 25, 30, 50, 60];

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function isHex(v) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function uid(prefix) {
  return `${prefix || 'clip'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function deep(o) { return JSON.parse(JSON.stringify(o)); }
function num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

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
  if (kind === 'effect') {
    return {
      id: uid('clip'), mediaId: null, kind: 'effect', effectId: 'noir', intensity: 0.8,
      name: 'Effect layer', start, duration, srcStart: 0, speed: 1, volume: 1, muted: false,
      fadeIn: 0, fadeOut: 0, rotation: 0, flip: 'none', opacity: 1, scaleMode: 'fit', zoom: 1,
      filters: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, blur: 0, vignette: 0 },
      transition: { type: 'none', duration: 0.5 }, groupId: null, effects: [], keyframes: [],
    };
  }
  return {
    id: uid('clip'), mediaId: mediaId || null, kind,
    name: kind === 'text' ? 'Text clip' : kind === 'audio' ? 'Audio clip' : 'Video clip',
    start, duration, srcStart: 0,
    speed: 1, volume: 1, muted: false,
    fadeIn: 0, fadeOut: 0, rotation: 0, flip: 'none',
    opacity: 1, scaleMode: 'fit', zoom: 1,
    filters: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, blur: 0, vignette: 0 },
    filterPreset: 'none', lutMediaId: null,
    transition: { type: 'none', duration: 0.5 },
    groupId: null, linkedTo: null,
    effects: [],
    chroma: { enabled: false, color: '#00ff00', similarity: 0.1, blend: 0.05 },
    speedCurve: { preset: 'none', points: [] },
    stabilize: { enabled: false, strength: 0.5 },
    mask: { type: 'none', x: 50, y: 50, w: 80, h: 80, rotation: 0, feather: 0, invert: false },
    reverse: false, freeze: { enabled: false, at: 0, duration: 1 },
    audioFx: { denoise: false, enhanceVoice: false, vocalIsolation: 'off', loudnorm: false, ducking: false },
    autoReframe: { enabled: false, targetAspect: '9:16' },
    opticalFlow: false, velocityEffect: 'none',
    splitScreen: { enabled: false, partnerClipId: null },
    overlay: null,
    text: {
      text: 'Your text', fontFamily: 'Poppins', fontSize: 64, fontWeight: 700, color: '#ffffff',
      align: 'center', x: 50, y: 50, bgColor: '', animIn: 'fade', animOut: 'fade',
      captionStyle: { preset: 'default', color: '', glow: false, highlight: '' },
      letterSpacing: 0, lineHeight: 1.2,
      shadow: { enabled: false, color: '#000000', dx: 2, dy: 2 },
      stroke: { enabled: false, color: '#000000', width: 2 },
      gradient: { enabled: false, colors: [] },
    },
    keyframes: [],
  };
}

// Effective slider values: a named filter preset supplies the base, and any
// non-zero clip filter value overrides it (zero = "use the preset").
function effectiveFilters(clip) {
  const base = { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, blur: 0, vignette: 0 };
  const preset = FILTER_PRESETS.find((p) => p.id === (clip.filterPreset || 'none'));
  if (preset) Object.assign(base, preset.sliders);
  const f = clip.filters || {};
  for (const k of Object.keys(base)) if (isNum(f[k]) && f[k] !== 0) base[k] = f[k];
  return base;
}

// Timeline background as a plain colour (string timelines and
// {type:'color'} objects); image/blur backgrounds fall back to black here
// (the renderer composites the real image separately).
function backgroundColor(t) {
  const bg = t && t.background;
  if (typeof bg === 'string' && isHex(bg)) return bg;
  if (bg && typeof bg === 'object' && isHex(bg.color)) return bg.color;
  return '#000000';
}

// --- Speed curves --------------------------------------------------------
// Resolved control points for a clip (null = constant speed).
function speedCurvePoints(clip) {
  const sc = clip.speedCurve;
  if (!sc || !sc.preset || sc.preset === 'none') return null;
  if (sc.preset === 'custom') {
    const pts = (sc.points || []).filter((p) => p && isNum(p.t) && isNum(p.speed))
      .map((p) => ({ t: p.t, speed: p.speed })).sort((a, b) => a.t - b.t);
    return pts.length >= 2 ? pts : null;
  }
  const preset = SPEED_CURVE_PRESETS.find((p) => p.id === sc.preset);
  if (!preset) return null;
  if (Array.isArray(sc.points) && sc.points.length >= 2) {
    return sc.points.filter((p) => p && isNum(p.t) && isNum(p.speed))
      .map((p) => ({ t: p.t, speed: p.speed })).sort((a, b) => a.t - b.t);
  }
  return preset.points.map((p) => ({ ...p }));
}

// Effective speed multiplier (base speed x curve) at clip time t (seconds).
function curveSpeedAt(clip, t) {
  const base = num(clip.speed, 1);
  const pts = speedCurvePoints(clip);
  if (!pts) return base;
  const D = Math.max(0.001, clip.duration);
  const f = clamp(t / D, 0, 1);
  if (f <= pts[0].t) return base * pts[0].speed;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (f >= a.t && f <= b.t) {
      const k = b.t === a.t ? 0 : (f - a.t) / (b.t - a.t);
      return base * (a.speed + (b.speed - a.speed) * k);
    }
  }
  return base * pts[pts.length - 1].speed;
}

// Source seconds consumed by clip time t (forward playback, no freeze or
// reverse). Piecewise-linear speed integrates exactly (trapezoid rule).
function curveIntegral(clip, t) {
  const base = num(clip.speed, 1);
  const D = Math.max(0.001, clip.duration);
  const tt = clamp(t, 0, D);
  const pts = speedCurvePoints(clip);
  if (!pts) return base * tt;
  const f = tt / D;
  let total = 0;
  let prevT = 0;
  let prevM = pts[0].speed;
  for (const pt of pts) {
    if (f <= pt.t) {
      const dt = f - prevT;
      if (dt > 0) {
        const k = pt.t === prevT ? 0 : dt / (pt.t - prevT);
        const mEnd = prevM + (pt.speed - prevM) * k;
        total += base * D * dt * (prevM + mEnd) / 2;
      }
      return total;
    }
    const dt = pt.t - prevT;
    if (dt > 0) total += base * D * dt * (prevM + pt.speed) / 2;
    prevT = pt.t;
    prevM = pt.speed;
  }
  const dt = f - prevT;
  if (dt > 0) total += base * D * dt * prevM;
  return total;
}

// Source offset (seconds from srcStart) shown at clip time t, accounting
// for the speed curve, freeze (holds the frame) and reverse.
function sourceTimeAt(clip, t) {
  const D = clip.duration;
  let tEff = clamp(t, 0, D);
  const fr = clip.freeze;
  if (fr && fr.enabled) {
    if (tEff >= fr.at && tEff < fr.at + fr.duration) tEff = fr.at;
    else if (tEff >= fr.at + fr.duration) tEff = tEff - fr.duration;
  }
  if (clip.reverse) return curveIntegral(clip, D) - curveIntegral(clip, tEff);
  return curveIntegral(clip, tEff);
}

// Render segments for a clip: [{t0, t1, duration, srcStart, srcEnd,
// srcDur, frozen, reverse, speed}]. Boundaries sit at keyframe times,
// speed-curve control points and freeze edges; long stretches are split
// into short pieces (<=0.2s when keyframes/curves animate, <=2s when
// reversing so `reverse` never has to buffer a whole clip).
function clipSegments(clip) {
  const D = clip.duration;
  const bounds = new Set([0, D]);
  if (Array.isArray(clip.keyframes)) {
    for (const k of clip.keyframes) if (isNum(k.t)) bounds.add(clamp(k.t, 0, D));
  }
  const pts = speedCurvePoints(clip);
  if (pts) for (const p of pts) bounds.add(clamp(p.t * D, 0, D));
  const fr = clip.freeze;
  if (fr && fr.enabled) {
    bounds.add(clamp(fr.at, 0, D));
    bounds.add(clamp(fr.at + fr.duration, 0, D));
  }
  const sorted = [...bounds].sort((a, b) => a - b);
  const hasKf = Array.isArray(clip.keyframes) && clip.keyframes.length > 0;
  const maxStep = (hasKf || pts) ? 0.2 : (clip.reverse ? 2 : D);
  const raw = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    let a = sorted[i];
    const b = sorted[i + 1];
    if (b - a < 1e-6) continue;
    const frozenInterval = !!(fr && fr.enabled && a >= fr.at - 1e-9 && b <= fr.at + fr.duration + 1e-9);
    if (frozenInterval) { raw.push([a, b]); continue; }
    while (b - a > maxStep + 1e-9) { raw.push([a, a + maxStep]); a += maxStep; }
    if (b - a > 1e-6) raw.push([a, b]);
  }
  return raw.map(([t0, t1]) => {
    const frozen = !!(fr && fr.enabled && t0 >= fr.at - 1e-9 && t0 < fr.at + fr.duration - 1e-9);
    const s0 = sourceTimeAt(clip, t0);
    const s1 = frozen ? s0 : sourceTimeAt(clip, t1);
    const srcDur = Math.abs(s1 - s0);
    const dur = t1 - t0;
    return {
      t0, t1, duration: dur,
      srcStart: Math.min(s0, s1), srcEnd: Math.max(s0, s1), srcDur,
      frozen, reverse: !!clip.reverse && !frozen,
      speed: dur > 0 ? srcDur / dur : 1,
    };
  });
}

function easingFn(name) {
  switch (name) {
    case 'ease-in': return (f) => f * f;
    case 'ease-out': return (f) => 1 - (1 - f) * (1 - f);
    case 'ease-in-out': return (f) => (f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2);
    default: return (f) => f;
  }
}

function validateTimeline(t, depth = 0) {
  const errors = [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['Timeline must be a JSON object.'];
  if (depth > 3) return ['Compound clips nest at most 3 deep.'];
  if (!isNum(t.width) || t.width < 160 || t.width > 3840) errors.push('Timeline width must be 160–3840 px.');
  if (!isNum(t.height) || t.height < 160 || t.height > 3840) errors.push('Timeline height must be 160–3840 px.');
  if (!FPS_OPTIONS.includes(t.fps)) errors.push(`fps must be one of ${FPS_OPTIONS.join(', ')}.`);
  if (!Array.isArray(t.tracks) || t.tracks.length === 0) errors.push('Timeline needs at least one track.');
  if (t.markers !== undefined && !Array.isArray(t.markers)) errors.push('Markers must be an array.');
  if (t.background !== undefined) {
    if (typeof t.background === 'string') {
      if (!isHex(t.background)) errors.push('Timeline background must be a #rrggbb hex color.');
    } else if (t.background && typeof t.background === 'object') {
      const bg = t.background;
      if (!['color', 'image', 'blur'].includes(bg.type)) errors.push('Timeline background type must be color, image or blur.');
      if (bg.color !== undefined && !isHex(bg.color)) errors.push('Timeline background color must be a #rrggbb hex color.');
      if ((bg.type === 'image' || bg.type === 'blur') && !isNum(bg.mediaId)) errors.push('Timeline background image/blur needs a mediaId.');
    } else {
      errors.push('Timeline background must be a #rrggbb color string or an object.');
    }
  }
  // Second pass needs every clip id (linkedTo / split-screen partner).
  const allIds = new Map(); // id -> { kind, trackKind, trackId }
  for (const tr of t.tracks || []) {
    for (const c of tr.clips || []) allIds.set(c.id, { kind: c.kind, trackKind: tr.kind, trackId: tr.id });
  }
  let clipCount = 0;
  for (const tr of t.tracks || []) {
    if (!['video', 'audio', 'text', 'effect'].includes(tr.kind)) { errors.push(`Track "${tr.name || tr.id}" has an unknown kind.`); continue; }
    if (!Array.isArray(tr.clips)) { errors.push(`Track "${tr.name || tr.id}" needs a clips array.`); continue; }
    const sorted = [...tr.clips].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      clipCount++;
      const where = `clip "${c.name || c.id}" on track "${tr.name}"`;
      if (tr.kind === 'effect') {
        if (c.kind !== 'effect') errors.push(`${where}: an effect track only holds effect clips.`);
      } else if (c.kind === 'compound') {
        if (tr.kind !== 'video') errors.push(`${where}: compound clips live on a video track.`);
      } else if (c.kind !== tr.kind) {
        errors.push(`${where}: clip kind "${c.kind}" does not match track kind "${tr.kind}".`);
      }
      if (!isNum(c.start) || c.start < 0) errors.push(`${where}: start must be >= 0.`);
      if (!isNum(c.duration) || c.duration <= 0 || c.duration > 36000) errors.push(`${where}: duration must be > 0 and <= 10 hours.`);
      if (c.kind === 'effect') {
        if (!EFFECTS.find((e) => e.id === c.effectId)) errors.push(`${where}: unknown effect "${c.effectId}".`);
        if (c.intensity !== undefined && (!isNum(c.intensity) || c.intensity < 0 || c.intensity > 1)) errors.push(`${where}: effect intensity must be 0–1.`);
        if (i > 0) {
          const prev = sorted[i - 1];
          if (c.start < prev.start + prev.duration - 1e-6) errors.push(`${where}: overlaps the previous clip on the same track (clips on one track must not overlap).`);
        }
        continue;
      }
      if (!isNum(c.srcStart) || c.srcStart < 0) errors.push(`${where}: srcStart must be >= 0.`);
      if (!isNum(c.speed) || c.speed < 0.1 || c.speed > 100) errors.push(`${where}: speed must be 0.1–100.`);
      if (!isNum(c.volume) || c.volume < 0 || c.volume > 2) errors.push(`${where}: volume must be 0–2.`);
      if (!isNum(c.opacity) || c.opacity < 0 || c.opacity > 1) errors.push(`${where}: opacity must be 0–1.`);
      if (!isNum(c.zoom) || c.zoom < 0.5 || c.zoom > 3) errors.push(`${where}: zoom must be 0.5–3.`);
      if (![0, 90, 180, 270].includes(c.rotation)) errors.push(`${where}: rotation must be 0, 90, 180 or 270.`);
      if (!['none', 'h', 'v'].includes(c.flip)) errors.push(`${where}: flip must be none, h or v.`);
      if (!['fit', 'fill'].includes(c.scaleMode)) errors.push(`${where}: scaleMode must be fit or fill.`);
      if (c.kind === 'compound') {
        if (c.mediaId !== null && c.mediaId !== undefined) errors.push(`${where}: a compound clip has no media file of its own (it renders its nested timeline).`);
        if (!c.nested || typeof c.nested !== 'object' || Array.isArray(c.nested)) {
          errors.push(`${where}: a compound clip needs a nested timeline object.`);
        } else {
          for (const e of validateTimeline(c.nested, depth + 1)) errors.push(`${where}: nested timeline: ${e}`);
        }
      } else if (c.kind !== 'text' && (c.mediaId === null || c.mediaId === undefined)) {
        errors.push(`${where}: a ${c.kind} clip needs a media file.`);
      }
      if (c.kind === 'text' && (!c.text || typeof c.text.text !== 'string' || (!c.text.text.trim() && !(c.text.panel && typeof c.text.panel === 'object')))) errors.push(`${where}: a text clip needs text (a panel-only clip is allowed).`);
      if (c.kind === 'text' && c.text) {
        if (c.text.alpha !== undefined && (!isNum(c.text.alpha) || c.text.alpha < 0 || c.text.alpha > 1)) errors.push(`${where}: text alpha must be 0–1.`);
        if (c.text.letterSpacing !== undefined && (!isNum(c.text.letterSpacing) || c.text.letterSpacing < -5 || c.text.letterSpacing > 20)) errors.push(`${where}: letter spacing must be -5–20.`);
        if (c.text.lineHeight !== undefined && (!isNum(c.text.lineHeight) || c.text.lineHeight < 0.5 || c.text.lineHeight > 3)) errors.push(`${where}: line height must be 0.5–3.`);
        if (c.text.shadow !== undefined) {
          const s = c.text.shadow;
          if (!s || typeof s !== 'object') errors.push(`${where}: text shadow must be an object.`);
          else {
            if (s.enabled !== undefined && typeof s.enabled !== 'boolean') errors.push(`${where}: text shadow enabled must be true/false.`);
            if (s.color !== undefined && !isHex(s.color)) errors.push(`${where}: text shadow color must be a #rrggbb hex color.`);
            for (const k of ['dx', 'dy']) if (s[k] !== undefined && (!isNum(s[k]) || s[k] < -20 || s[k] > 20)) errors.push(`${where}: text shadow ${k} must be -20–20.`);
          }
        }
        if (c.text.stroke !== undefined) {
          const s = c.text.stroke;
          if (!s || typeof s !== 'object') errors.push(`${where}: text stroke must be an object.`);
          else {
            if (s.enabled !== undefined && typeof s.enabled !== 'boolean') errors.push(`${where}: text stroke enabled must be true/false.`);
            if (s.color !== undefined && !isHex(s.color)) errors.push(`${where}: text stroke color must be a #rrggbb hex color.`);
            if (s.width !== undefined && (!isNum(s.width) || s.width < 0 || s.width > 10)) errors.push(`${where}: text stroke width must be 0–10.`);
          }
        }
        if (c.text.gradient !== undefined) {
          const g = c.text.gradient;
          if (!g || typeof g !== 'object') errors.push(`${where}: text gradient must be an object.`);
          else {
            if (g.enabled !== undefined && typeof g.enabled !== 'boolean') errors.push(`${where}: text gradient enabled must be true/false.`);
            // The colors only matter when the gradient is actually on —
            // a disabled gradient with no colors (the default shape) is
            // fine, and the renderer refuses an enabled one anyway.
            if (g.enabled && (!Array.isArray(g.colors) || g.colors.length !== 2 || !g.colors.every(isHex))) errors.push(`${where}: text gradient needs exactly two #rrggbb colors.`);
          }
        }
        if (c.text.captionStyle !== undefined) {
          const cs = c.text.captionStyle;
          if (!cs || typeof cs !== 'object') errors.push(`${where}: caption style must be an object.`);
          else {
            if (cs.preset !== undefined && !CAPTION_STYLE_PRESETS.find((p) => p.id === cs.preset)) errors.push(`${where}: unknown caption style "${cs.preset}".`);
            if (cs.color !== undefined && cs.color !== '' && !isHex(cs.color)) errors.push(`${where}: caption style color must be a #rrggbb hex color.`);
            if (cs.highlight !== undefined && cs.highlight !== '' && !isHex(cs.highlight)) errors.push(`${where}: caption style highlight must be a #rrggbb hex color.`);
            if (cs.glow !== undefined && typeof cs.glow !== 'boolean') errors.push(`${where}: caption style glow must be true/false.`);
          }
        }
        if (c.text.panel !== undefined) {
          const p = c.text.panel;
          if (!p || typeof p !== 'object') errors.push(`${where}: text panel must be an object.`);
          else {
            for (const k of ['x', 'y', 'w', 'h']) if (p[k] !== undefined && !isNum(p[k])) errors.push(`${where}: panel ${k} must be a number.`);
            if (p.fill !== undefined && !isHex(p.fill)) errors.push(`${where}: panel fill must be a #rrggbb hex color.`);
            if (p.border !== undefined && !isHex(p.border)) errors.push(`${where}: panel border must be a #rrggbb hex color.`);
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
      if (c.filterPreset !== undefined && c.filterPreset !== null && !FILTER_PRESETS.find((p) => p.id === c.filterPreset)) {
        errors.push(`${where}: unknown filter preset "${c.filterPreset}".`);
      }
      if (c.lutMediaId !== undefined && c.lutMediaId !== null && !Number.isInteger(c.lutMediaId)) {
        errors.push(`${where}: lutMediaId must be a media id (integer).`);
      }
      if (Array.isArray(c.effects)) {
        for (const e of c.effects) {
          if (!e || !EFFECTS.find((x) => x.id === e.id)) errors.push(`${where}: unknown effect "${e && e.id}".`);
          else if (e.intensity !== undefined && (!isNum(e.intensity) || e.intensity < 0 || e.intensity > 1)) errors.push(`${where}: effect "${e.id}" intensity must be 0–1.`);
        }
      } else if (c.effects !== undefined) {
        errors.push(`${where}: effects must be an array.`);
      }
      if (c.chroma !== undefined) {
        const ch = c.chroma;
        if (!ch || typeof ch !== 'object') errors.push(`${where}: chroma must be an object.`);
        else {
          if (ch.enabled !== undefined && typeof ch.enabled !== 'boolean') errors.push(`${where}: chroma enabled must be true/false.`);
          if (ch.color !== undefined && !isHex(ch.color)) errors.push(`${where}: chroma color must be a #rrggbb hex color.`);
          if (ch.similarity !== undefined && (!isNum(ch.similarity) || ch.similarity < 0 || ch.similarity > 1)) errors.push(`${where}: chroma similarity must be 0–1.`);
          if (ch.blend !== undefined && (!isNum(ch.blend) || ch.blend < 0 || ch.blend > 1)) errors.push(`${where}: chroma blend must be 0–1.`);
        }
      }
      if (c.speedCurve !== undefined) {
        const sc = c.speedCurve;
        if (!sc || typeof sc !== 'object') errors.push(`${where}: speedCurve must be an object.`);
        else {
          if (sc.preset !== undefined && !SPEED_CURVE_PRESETS.find((p) => p.id === sc.preset)) errors.push(`${where}: unknown speed curve preset "${sc.preset}".`);
          if (sc.points !== undefined) {
            if (!Array.isArray(sc.points)) errors.push(`${where}: speed curve points must be an array.`);
            else {
              for (const p of sc.points) {
                if (!p || !isNum(p.t) || p.t < 0 || p.t > 1 || !isNum(p.speed) || p.speed < 0.1 || p.speed > 100) {
                  errors.push(`${where}: speed curve points need t 0–1 and speed 0.1–100.`);
                  break;
                }
              }
              if (sc.preset === 'custom' && sc.points.length < 2) errors.push(`${where}: a custom speed curve needs at least 2 points.`);
            }
          } else if (sc.preset === 'custom') {
            errors.push(`${where}: a custom speed curve needs points.`);
          }
        }
      }
      if (c.stabilize !== undefined) {
        const s = c.stabilize;
        if (!s || typeof s !== 'object') errors.push(`${where}: stabilize must be an object.`);
        else {
          if (s.enabled !== undefined && typeof s.enabled !== 'boolean') errors.push(`${where}: stabilize enabled must be true/false.`);
          if (s.strength !== undefined && (!isNum(s.strength) || s.strength < 0 || s.strength > 1)) errors.push(`${where}: stabilize strength must be 0–1.`);
        }
      }
      if (c.mask !== undefined) {
        const m = c.mask;
        if (!m || typeof m !== 'object') errors.push(`${where}: mask must be an object.`);
        else {
          if (m.type !== undefined && !MASK_TYPES.includes(m.type)) errors.push(`${where}: unknown mask type "${m.type}".`);
          for (const k of ['x', 'y', 'w', 'h']) if (m[k] !== undefined && (!isNum(m[k]) || m[k] < 0 || m[k] > 100)) errors.push(`${where}: mask ${k} must be 0–100.`);
          if (m.rotation !== undefined && (!isNum(m.rotation) || m.rotation < 0 || m.rotation > 360)) errors.push(`${where}: mask rotation must be 0–360.`);
          if (m.feather !== undefined && (!isNum(m.feather) || m.feather < 0 || m.feather > 30)) errors.push(`${where}: mask feather must be 0–30.`);
          if (m.invert !== undefined && typeof m.invert !== 'boolean') errors.push(`${where}: mask invert must be true/false.`);
        }
      }
      if (c.reverse !== undefined && typeof c.reverse !== 'boolean') errors.push(`${where}: reverse must be true/false.`);
      if (c.freeze !== undefined) {
        const f = c.freeze;
        if (!f || typeof f !== 'object') errors.push(`${where}: freeze must be an object.`);
        else {
          if (f.enabled !== undefined && typeof f.enabled !== 'boolean') errors.push(`${where}: freeze enabled must be true/false.`);
          if (f.at !== undefined && (!isNum(f.at) || f.at < 0 || f.at > c.duration)) errors.push(`${where}: freeze at must be within the clip.`);
          if (f.duration !== undefined && (!isNum(f.duration) || f.duration <= 0)) errors.push(`${where}: freeze duration must be > 0.`);
          if (f.enabled && isNum(f.at) && isNum(f.duration) && f.at + f.duration > c.duration) errors.push(`${where}: freeze (at + duration) must fit inside the clip.`);
        }
      }
      if (c.audioFx !== undefined) {
        const a = c.audioFx;
        if (!a || typeof a !== 'object') errors.push(`${where}: audioFx must be an object.`);
        else {
          for (const k of ['denoise', 'enhanceVoice', 'loudnorm', 'ducking']) {
            if (a[k] !== undefined && typeof a[k] !== 'boolean') errors.push(`${where}: audioFx ${k} must be true/false.`);
          }
          if (a.vocalIsolation !== undefined && !VOCAL_ISOLATION_TYPES.includes(a.vocalIsolation)) errors.push(`${where}: vocalIsolation must be off, remove or keep.`);
        }
      }
      if (c.autoReframe !== undefined) {
        const r = c.autoReframe;
        if (!r || typeof r !== 'object') errors.push(`${where}: autoReframe must be an object.`);
        else {
          if (r.enabled !== undefined && typeof r.enabled !== 'boolean') errors.push(`${where}: autoReframe enabled must be true/false.`);
          // Only format-check the aspect when reframing is actually on —
          // a disabled block may carry an empty aspect from another
          // client, and that must not fail validation.
          if (r.enabled && r.targetAspect !== undefined && !/^\d+:\d+$/.test(String(r.targetAspect))) errors.push(`${where}: autoReframe targetAspect must look like "9:16".`);
        }
      }
      if (c.opticalFlow !== undefined && typeof c.opticalFlow !== 'boolean') errors.push(`${where}: opticalFlow must be true/false.`);
      if (c.velocityEffect !== undefined && !VELOCITY_EFFECTS.find((v) => v.id === c.velocityEffect)) {
        errors.push(`${where}: unknown velocity effect "${c.velocityEffect}".`);
      }
      if (c.linkedTo !== undefined && c.linkedTo !== null) {
        if (typeof c.linkedTo !== 'string') errors.push(`${where}: linkedTo must be a clip id.`);
        else if (!allIds.has(c.linkedTo)) errors.push(`${where}: linkedTo refers to a clip that does not exist ("${c.linkedTo}").`);
        else if (c.linkedTo === c.id) errors.push(`${where}: a clip cannot link to itself.`);
      }
      if (c.splitScreen !== undefined) {
        const ss = c.splitScreen;
        if (!ss || typeof ss !== 'object') errors.push(`${where}: splitScreen must be an object.`);
        else if (ss.enabled) {
          if (typeof ss.partnerClipId !== 'string' || !allIds.has(ss.partnerClipId)) {
            errors.push(`${where}: split-screen needs a partnerClipId of an existing clip.`);
          } else {
            const partner = allIds.get(ss.partnerClipId);
            if (partner.trackId === tr.id) errors.push(`${where}: the split-screen partner must be on a different video track.`);
            if (partner.kind !== 'video' && partner.kind !== 'compound') errors.push(`${where}: the split-screen partner must be a video clip.`);
          }
        }
      }
      if (c.overlay !== undefined && c.overlay !== null) {
        const o = c.overlay;
        if (!o || typeof o !== 'object') errors.push(`${where}: overlay must be an object.`);
        else for (const k of ['x', 'y', 'w', 'h']) {
          if (o[k] !== undefined && (!isNum(o[k]) || o[k] < 0 || o[k] > 100)) errors.push(`${where}: overlay ${k} must be 0–100.`);
        }
      }
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
          if (k.rotation !== undefined && (!isNum(k.rotation) || k.rotation < 0 || k.rotation > 360)) errors.push(`${where}: keyframe rotation must be 0–360.`);
          if (k.volume !== undefined && (!isNum(k.volume) || k.volume < 0 || k.volume > 2)) errors.push(`${where}: keyframe volume must be 0–2.`);
          if (k.easing !== undefined && !EASING_TYPES.includes(k.easing)) errors.push(`${where}: keyframe easing must be one of ${EASING_TYPES.join(', ')}.`);
          for (const key of Object.keys(k)) {
            if (['t', 'x', 'y', 'scale', 'opacity', 'rotation', 'volume', 'easing'].includes(key)) continue;
            errors.push(`${where}: keyframe property "${key}" is not supported (keyframes animate x, y, scale, opacity, rotation and volume only).`);
          }
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
    // A freeze that straddles the split stays on the side that still holds
    // it; a freeze entirely on the other side is dropped there.
    for (const half of [left, right]) {
      if (half.freeze && half.freeze.enabled) {
        const at = half.freeze.at - (half === right ? rel : 0);
        if (at < 0 || at + half.freeze.duration > half.duration) half.freeze = { enabled: false, at: 0, duration: 1 };
        else half.freeze = { ...half.freeze, at };
      }
    }
    // The split-off clip is no longer linked to the same partner.
    right.linkedTo = null;
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

// Interpolated keyframed properties at a time (seconds from clip start).
// Returns { x, y, scale, opacity, rotation, volume }. Rotation defaults to
// the clip's static rotation and volume to the clip's volume when no
// keyframes define them. Easing lives on the target keyframe.
function keyframeAt(clip, time) {
  const out = { x: 50, y: 50, scale: 1, opacity: 1, rotation: num(clip.rotation, 0), volume: num(clip.volume, 1) };
  const kfs = [...(clip.keyframes || [])].sort((a, b) => a.t - b.t);
  if (!kfs.length) return out;
  const props = ['x', 'y', 'scale', 'opacity', 'rotation', 'volume'];
  for (const p of props) {
    const defined = kfs.filter((k) => k[p] !== undefined);
    if (!defined.length) continue;
    if (time <= defined[0].t) { out[p] = defined[0][p]; continue; }
    if (time >= defined[defined.length - 1].t) { out[p] = defined[defined.length - 1][p]; continue; }
    for (let i = 0; i < defined.length - 1; i++) {
      const a = defined[i], b = defined[i + 1];
      if (time >= a.t && time <= b.t) {
        const f = b.t === a.t ? 0 : (time - a.t) / (b.t - a.t);
        const e = easingFn(b.easing || 'linear')(f);
        out[p] = a[p] + (b[p] - a[p]) * e;
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
  EFFECTS, FILTER_PRESETS, SPEED_CURVE_PRESETS, VELOCITY_EFFECTS,
  CAPTION_STYLE_PRESETS, EXPORT_PRESETS, EASING_TYPES, MASK_TYPES,
  blankTimeline, defaultClip, validateTimeline, allClips, totalDuration,
  splitClipAt, trimClip, rippleDelete, keyframeAt, outputDims,
  effectiveFilters, backgroundColor,
  speedCurvePoints, curveSpeedAt, curveIntegral, sourceTimeAt, clipSegments,
  easingFn, clamp, deep, uid, num,
};
