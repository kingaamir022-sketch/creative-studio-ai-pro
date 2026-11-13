'use strict';
// Design model — pure functions shared by the server (validation, templates)
// and the API tests. The browser editor (public/editor.js) uses the same
// JSON shape; keep this file's contract in sync with it.
//
// Design JSON:
// {
//   version: 1,
//   width, height,                       // canvas size in px
//   background: { type: 'color'|'gradient'|'transparent',
//                 color: '#rrggbb',
//                 gradient: { from, to, angle } },
//   layers: [ { id, type, name, x, y, w, h, rotation, opacity, locked, hidden, groupId,
//     text: { text, fontFamily, fontSize, fontWeight, fontStyle, underline,
//             align, color, letterSpacing, lineHeight,
//             shadow: { color, blur, offsetX, offsetY } | null,
//             stroke: { color, width } | null,
//             gradient: { from, to } | null },
//     shape: { kind: 'rect'|'ellipse'|'triangle'|'line', fill, stroke, strokeWidth,
//             radius, shadow: { color, blur, offsetX, offsetY } | null },
//     image: { mediaId, src, filters: { grayscale, sepia, brightness, contrast, saturate },
//             flipH, flipV, crop: { left, top, right, bottom } } } ]
// }

const SIZES = [
  { id: 'instagram-post', name: 'Instagram Post', width: 1080, height: 1080 },
  { id: 'instagram-story', name: 'Instagram Story', width: 1080, height: 1920 },
  { id: 'facebook-post', name: 'Facebook Post', width: 1200, height: 630 },
  { id: 'facebook-cover', name: 'Facebook Cover', width: 820, height: 312 },
  { id: 'youtube-thumbnail', name: 'YouTube Thumbnail', width: 1280, height: 720 },
  { id: 'youtube-banner', name: 'YouTube Channel Banner', width: 2560, height: 1440 },
  { id: 'tiktok-cover', name: 'TikTok Cover', width: 1080, height: 1920 },
  { id: 'pinterest', name: 'Pinterest Graphic', width: 1000, height: 1500 },
  { id: 'business-card', name: 'Business Card', width: 1050, height: 600 },
  { id: 'flyer-a4', name: 'Flyer (A4)', width: 1240, height: 1754 },
  { id: 'poster', name: 'Poster', width: 1080, height: 1350 },
  { id: 'presentation', name: 'Presentation Slide', width: 1920, height: 1080 },
];

const FONTS = [
  'Inter', 'Poppins', 'Montserrat', 'Roboto', 'Lato', 'Raleway', 'Oswald',
  'Playfair Display', 'Bebas Neue', 'Dancing Script',
  'Arial', 'Georgia', 'Times New Roman', 'Verdana', 'Courier New',
];

let uidCounter = 0;
function uid(prefix = 'layer') {
  uidCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${uidCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

function isHexColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}
function isNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function isBool(v) { return typeof v === 'boolean'; }

function blankDesign(width = 1080, height = 1080) {
  return {
    version: 1,
    width, height,
    background: { type: 'color', color: '#151d3a', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } },
    layers: [],
  };
}

function defaultTextLayer(x, y, text, opts = {}) {
  return {
    id: uid(), type: 'text', name: opts.name || 'Text', x, y, w: opts.w || 600, h: opts.h || 90,
    rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null,
    text: {
      text, fontFamily: opts.fontFamily || 'Poppins', fontSize: opts.fontSize || 64,
      fontWeight: opts.fontWeight || 700, fontStyle: 'normal', underline: false,
      align: opts.align || 'center', color: opts.color || '#ffffff',
      letterSpacing: 0, lineHeight: 1.2, shadow: null, stroke: null, gradient: null,
    },
  };
}
function defaultShapeLayer(kind, x, y, w, h, opts = {}) {
  return {
    id: uid(), type: 'shape', name: opts.name || (kind === 'ellipse' ? 'Circle' : kind === 'line' ? 'Line' : 'Rectangle'),
    x, y, w, h, rotation: opts.rotation || 0, opacity: 1, locked: false, hidden: false, groupId: null,
    shape: {
      kind, fill: opts.fill || '#7c5cff', stroke: opts.stroke || '', strokeWidth: opts.strokeWidth || 0,
      radius: opts.radius !== undefined ? opts.radius : 12,
      shadow: opts.shadow || null,
    },
  };
}
function defaultImageLayer(x, y, w, h, src, mediaId = null) {
  return {
    id: uid(), type: 'image', name: 'Image', x, y, w, h, rotation: 0, opacity: 1,
    locked: false, hidden: false, groupId: null,
    image: {
      mediaId, src,
      filters: { grayscale: 0, sepia: 0, brightness: 100, contrast: 100, saturate: 100 },
      flipH: false, flipV: false, crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
  };
}

// Validate a design object. Returns { ok, errors: [] }.
function validateDesign(d) {
  const errors = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, errors: ['Design must be a JSON object.'] };
  if (d.version !== undefined && d.version !== 1) errors.push('Unsupported design version.');
  if (!isNumber(d.width) || d.width < 10 || d.width > 8000) errors.push('Canvas width must be a number between 10 and 8000.');
  if (!isNumber(d.height) || d.height < 10 || d.height > 8000) errors.push('Canvas height must be a number between 10 and 8000.');
  const bg = d.background;
  if (!bg || typeof bg !== 'object') errors.push('Design background is required.');
  else {
    if (!['color', 'gradient', 'transparent'].includes(bg.type)) errors.push('Background type must be color, gradient or transparent.');
    if (bg.type === 'color' && !isHexColor(bg.color)) errors.push('Background color must be a #rrggbb hex color.');
    if (bg.type === 'gradient') {
      if (!bg.gradient || !isHexColor(bg.gradient.from) || !isHexColor(bg.gradient.to)) errors.push('Gradient background needs two #rrggbb colors.');
      if (bg.gradient && bg.gradient.angle !== undefined && (!isNumber(bg.gradient.angle) || bg.gradient.angle < 0 || bg.gradient.angle > 360)) errors.push('Gradient angle must be 0–360.');
    }
  }
  if (!Array.isArray(d.layers)) errors.push('Design layers must be an array.');
  else {
    if (d.layers.length > 500) errors.push('A design may have at most 500 layers.');
    const ids = new Set();
    d.layers.forEach((l, i) => {
      const where = `Layer ${i + 1}`;
      if (!l || typeof l !== 'object') { errors.push(`${where}: must be an object.`); return; }
      if (!l.id || typeof l.id !== 'string') errors.push(`${where}: id is required.`);
      else if (ids.has(l.id)) errors.push(`${where}: duplicate layer id "${l.id}".`);
      else ids.add(l.id);
      if (!['text', 'shape', 'image'].includes(l.type)) errors.push(`${where}: type must be text, shape or image.`);
      for (const k of ['x', 'y', 'w', 'h']) {
        if (!isNumber(l[k])) errors.push(`${where}: ${k} must be a number.`);
      }
      if (isNumber(l.w) && l.w < 1) errors.push(`${where}: width must be at least 1px.`);
      if (isNumber(l.h) && l.h < 1) errors.push(`${where}: height must be at least 1px.`);
      if (l.rotation !== undefined && (!isNumber(l.rotation) || l.rotation < -360 || l.rotation > 360)) errors.push(`${where}: rotation must be -360–360.`);
      if (l.opacity !== undefined && (!isNumber(l.opacity) || l.opacity < 0 || l.opacity > 1)) errors.push(`${where}: opacity must be 0–1.`);
      if (l.locked !== undefined && !isBool(l.locked)) errors.push(`${where}: locked must be true/false.`);
      if (l.hidden !== undefined && !isBool(l.hidden)) errors.push(`${where}: hidden must be true/false.`);
      if (l.type === 'text') {
        const t = l.text;
        if (!t || typeof t !== 'object') errors.push(`${where}: text settings are required.`);
        else {
          if (typeof t.text !== 'string') errors.push(`${where}: text content must be a string.`);
          if (!isNumber(t.fontSize) || t.fontSize < 6 || t.fontSize > 1000) errors.push(`${where}: font size must be 6–1000.`);
          if (t.color !== undefined && !isHexColor(t.color)) errors.push(`${where}: text color must be a #rrggbb hex color.`);
          if (t.gradient && (!isHexColor(t.gradient.from) || !isHexColor(t.gradient.to))) errors.push(`${where}: gradient text needs two #rrggbb colors.`);
          if (t.stroke && (!isHexColor(t.stroke.color) || !isNumber(t.stroke.width) || t.stroke.width < 0 || t.stroke.width > 50)) errors.push(`${where}: text outline needs a #rrggbb color and width 0–50.`);
          if (t.letterSpacing !== undefined && (!isNumber(t.letterSpacing) || t.letterSpacing < -20 || t.letterSpacing > 100)) errors.push(`${where}: letter spacing must be -20–100.`);
          if (t.lineHeight !== undefined && (!isNumber(t.lineHeight) || t.lineHeight < 0.5 || t.lineHeight > 3)) errors.push(`${where}: line height must be 0.5–3.`);
        }
      }
      if (l.type === 'shape') {
        const s = l.shape;
        if (!s || typeof s !== 'object') errors.push(`${where}: shape settings are required.`);
        else {
          if (!['rect', 'ellipse', 'triangle', 'line'].includes(s.kind)) errors.push(`${where}: shape kind must be rect, ellipse, triangle or line.`);
          if (s.fill !== undefined && s.fill !== '' && !isHexColor(s.fill)) errors.push(`${where}: shape fill must be a #rrggbb hex color.`);
          if (s.stroke !== undefined && s.stroke !== '' && !isHexColor(s.stroke)) errors.push(`${where}: shape stroke must be a #rrggbb hex color.`);
          if (s.strokeWidth !== undefined && (!isNumber(s.strokeWidth) || s.strokeWidth < 0 || s.strokeWidth > 100)) errors.push(`${where}: stroke width must be 0–100.`);
          if (s.radius !== undefined && (!isNumber(s.radius) || s.radius < 0 || s.radius > 500)) errors.push(`${where}: corner radius must be 0–500.`);
        }
      }
      if (l.type === 'image') {
        const im = l.image;
        if (!im || typeof im !== 'object') errors.push(`${where}: image settings are required.`);
        else {
          if (typeof im.src !== 'string' || !im.src) errors.push(`${where}: image src is required.`);
          const f = im.filters || {};
          for (const [k, lo, hi] of [['grayscale', 0, 100], ['sepia', 0, 100], ['brightness', 0, 300], ['contrast', 0, 300], ['saturate', 0, 300]]) {
            if (f[k] !== undefined && (!isNumber(f[k]) || f[k] < lo || f[k] > hi)) errors.push(`${where}: filter ${k} must be ${lo}–${hi}.`);
          }
          const c = im.crop || {};
          for (const k of ['left', 'top', 'right', 'bottom']) {
            if (c[k] !== undefined && (!isNumber(c[k]) || c[k] < 0 || c[k] > 90)) errors.push(`${where}: crop ${k} must be 0–90%.`);
          }
        }
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

function validateBrand(b) {
  const errors = [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, errors: ['Brand must be a JSON object.'] };
  if (!b.name || typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 80) errors.push('Brand name is required (max 80 characters).');
  for (const k of ['primaryColor', 'secondaryColor', 'accentColor']) {
    if (b[k] !== undefined && b[k] !== '' && b[k] !== null && !isHexColor(b[k])) errors.push(`${k} must be a #rrggbb hex color.`);
  }
  for (const k of ['fontHeading', 'fontBody']) {
    if (b[k] !== undefined && (typeof b[k] !== 'string' || b[k].length > 60)) errors.push(`${k} must be a font name (max 60 characters).`);
  }
  if (b.handles !== undefined && (typeof b.handles !== 'object' || b.handles === null || Array.isArray(b.handles))) errors.push('Social handles must be an object, e.g. {"instagram":"@studio"}.');
  else if (b.handles) {
    for (const [k, v] of Object.entries(b.handles)) {
      if (typeof v !== 'string' || v.length > 120) errors.push(`Handle "${k}" must be a string (max 120 characters).`);
    }
  }
  if (b.logoMediaId !== undefined && b.logoMediaId !== null && !Number.isInteger(b.logoMediaId)) errors.push('logoMediaId must be a media id or null.');
  return { ok: errors.length === 0, errors };
}

module.exports = {
  SIZES, FONTS, uid, blankDesign, defaultTextLayer, defaultShapeLayer, defaultImageLayer,
  validateDesign, validateBrand, isHexColor,
};
