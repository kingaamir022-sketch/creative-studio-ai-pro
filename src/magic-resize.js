'use strict';
// Magic Resize — pure reflow engine (v2.2.2, Release A "Magic Tools").
//
// One click resizes a design to another format and REFLOWS the content to
// fit: every layer is scaled and repositioned onto the new canvas, text
// re-wraps and shrinks through the project's own fitText() (the single
// source of truth for sizing — never-overflow rule), and any layer that
// still cannot fit is flagged "Needs attention" instead of rendering
// broken. Fully local, no provider, no key.
//
// The input design is never mutated — a new design object is returned.
// Returns { design, report } where report is:
//   { from: {width,height}, to: {width,height},
//     layers: [{ id, name, actions: ['scaled','font-shrunk',...] }],
//     needsAttention: [{ layerId, name, reason, suggestedText }] }
const { SIZES, validateDesign } = require('./design-model');
const { fitText } = require('./quiz-model');

const MIN_READABLE_FONT = 12;

function round2(n) { return Math.round(n * 100) / 100; }

function reflowDesign(design, targetWidth, targetHeight) {
  if (!design || typeof design !== 'object' || Array.isArray(design)) {
    throw new Error('A design object is required.');
  }
  const tw = Number(targetWidth);
  const th = Number(targetHeight);
  if (!Number.isFinite(tw) || !Number.isFinite(th) || tw < 10 || tw > 8000 || th < 10 || th > 8000) {
    throw new Error('Target size must be a width and height between 10 and 8000 px.');
  }
  const v = validateDesign(design);
  if (!v.ok) throw new Error('Invalid design: ' + v.errors.join(' '));
  const fromW = design.width;
  const fromH = design.height;
  if (tw === fromW && th === fromH) {
    return {
      design: JSON.parse(JSON.stringify(design)),
      report: { from: { width: fromW, height: fromH }, to: { width: tw, height: th }, layers: [], needsAttention: [], unchanged: true },
    };
  }
  const sx = tw / fromW;
  const sy = th / fromH;
  const fontScale = Math.min(sx, sy);
  const out = JSON.parse(JSON.stringify(design));
  out.width = tw;
  out.height = th;
  const report = { from: { width: fromW, height: fromH }, to: { width: tw, height: th }, layers: [], needsAttention: [] };

  for (const layer of out.layers || []) {
    const actions = [];
    const orig = { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
    layer.x = round2(layer.x * sx);
    layer.y = round2(layer.y * sy);
    layer.w = round2(Math.max(1, layer.w * sx));
    layer.h = round2(Math.max(1, layer.h * sy));
    actions.push('scaled');
    // Clamp inside the new canvas: shift first, then shrink.
    if (layer.x < 0) { layer.x = 0; actions.push('clamped-left'); }
    if (layer.y < 0) { layer.y = 0; actions.push('clamped-top'); }
    if (layer.x + layer.w > tw) {
      const overflow = layer.x + layer.w - tw;
      if (layer.x >= overflow) { layer.x = round2(layer.x - overflow); actions.push('shifted-left'); }
      else { layer.w = round2(Math.max(1, tw - layer.x)); actions.push('shrunk-to-fit'); }
    }
    if (layer.y + layer.h > th) {
      const overflow = layer.y + layer.h - th;
      if (layer.y >= overflow) { layer.y = round2(layer.y - overflow); actions.push('shifted-up'); }
      else { layer.h = round2(Math.max(1, th - layer.y)); actions.push('shrunk-to-fit'); }
    }
    if (layer.type === 'text' && layer.text) {
      const t = layer.text;
      const scaledFont = Math.max(MIN_READABLE_FONT, Math.round((t.fontSize || 64) * fontScale));
      const lineHeight = t.lineHeight || 1.2;
      // Lines the new box can hold at the scaled font.
      const maxLines = Math.max(1, Math.floor(layer.h / Math.max(1, scaledFont * lineHeight)));
      const fit = fitText(t.text || '', layer.w, {
        maxFont: scaledFont, minFont: MIN_READABLE_FONT, maxLines, lineHeight,
      });
      if (fit.fontSize !== t.fontSize) {
        t.fontSize = fit.fontSize;
        actions.push(fit.status === 'ok' ? 'font-scaled' : 'font-shrunk');
      }
      // The box must hold the fitted text height; grow it if there is room,
      // otherwise flag it — never render text outside its box.
      const needH = Math.ceil(fit.heightPx);
      if (needH > layer.h) {
        if (layer.y + needH <= th) {
          layer.h = needH;
          actions.push('box-grew-for-text');
        } else {
          report.needsAttention.push({
            layerId: layer.id, name: layer.name || 'Text',
            reason: `Text needs ${needH}px of height but only ${Math.round(layer.h)}px fits on the ${tw}×${th} canvas at the readable minimum (${MIN_READABLE_FONT}px).`,
            suggestedText: fit.suggestedText || null,
          });
          actions.push('needs-attention');
        }
      }
      if (fit.status === 'attention') {
        report.needsAttention.push({
          layerId: layer.id, name: layer.name || 'Text',
          reason: 'Text is too long for this size even at the readable minimum font — it was truncated with an ellipsis.',
          suggestedText: fit.suggestedText || null,
        });
        actions.push('needs-attention');
      }
    }
    report.layers.push({ id: layer.id, name: layer.name || layer.type, actions, from: orig });
  }
  const check = validateDesign(out);
  if (!check.ok) throw new Error('Reflow produced an invalid design: ' + check.errors.join(' '));
  return { design: out, report };
}

function sizeById(id) {
  return SIZES.find((s) => s.id === id) || null;
}

module.exports = { reflowDesign, sizeById, MIN_READABLE_FONT };
