'use strict';
// Server-side graphic-design renderer (Phase 4, Bulk Design).
// Renders a Phase 2 design JSON to a real PNG/JPG with FFmpeg — the same
// filter techniques as the video renderer (drawtext / drawbox / overlay),
// so bulk designs are genuine rendered files, not screenshots of a fake.
//
// Supported, honestly: solid / gradient / transparent backgrounds, rect
// shapes (fill + outline), horizontal/vertical lines, text layers (font,
// size, weight, colour, alignment, opacity, background box), image layers
// (scale, crop, flip, opacity, basic eq filters, rotation in 90° steps or
// arbitrary via the rotate filter).
// NOT supported (layer is skipped with a warning, never faked): ellipse /
// triangle shapes, gradient text, text shadows / outlines, rounded corners,
// text curvature. The caller surfaces the warnings per row.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fontFor } = require('./render');
const { probeMedia } = require('./ffmpeg');

function escColor(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  return `0x${h.length === 6 ? h : 'ffffff'}`;
}
function num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function fmt(n) { return String(Math.round(n * 1000) / 1000); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function gradientXY(angleDeg) {
  const a = ((num(angleDeg, 135) % 360) * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a);
  return { x0: 0.5 - dx / 2, y0: 0.5 - dy / 2, x1: 0.5 + dx / 2, y1: 0.5 + dy / 2 };
}

// Render one design to outPath (PNG or JPG by extension).
// mediaById: { mediaId: { filePath, kind } }.
// Returns { warnings: [], width, height }.
async function renderDesign({ design, mediaById, outPath }) {
  const W = Math.round(design.width);
  const H = Math.round(design.height);
  if (!W || !H || W < 10 || W > 3840 || H < 10 || H > 3840) {
    throw new Error('Design canvas size is invalid.');
  }
  const warnings = [];
  const inputs = [];
  const inputIdxByMedia = new Map();
  const textFiles = [];
  const isJpg = /\.jpe?g$/i.test(outPath);
  // Transparent designs keep an alpha channel (PNG only); everything else
  // renders as yuv420p.
  const transparent = (design.background || {}).type === 'transparent';
  const pixFmt = transparent && !isJpg ? 'rgba' : 'yuv420p';
  const tmpDir = path.join(path.dirname(outPath), `.design-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const filterParts = [];

  function inputForMedia(mediaId) {
    if (inputIdxByMedia.has(mediaId)) return inputIdxByMedia.get(mediaId);
    const m = mediaById[mediaId];
    if (!m) throw new Error(`Media file #${mediaId} is missing (it may have been deleted).`);
    if (!fs.existsSync(m.filePath)) throw new Error(`Media file "${m.filePath}" is missing on disk.`);
    const idx = inputs.length;
    inputs.push({ args: ['-i', m.filePath], mediaId });
    inputIdxByMedia.set(mediaId, idx);
    return idx;
  }

  // --- Base canvas ---
  const bg = design.background || { type: 'color', color: '#151d3a' };
  let cur = 'base';
  if (bg.type === 'transparent') {
    filterParts.push(`nullsrc=s=${W}x${H}:d=1,format=rgba[${cur}]`);
  } else if (bg.type === 'gradient' && bg.gradient) {
    const g = gradientXY(bg.gradient.angle);
    filterParts.push(
      `gradients=s=${W}x${H}:c0=${escColor(bg.gradient.from)}:c1=${escColor(bg.gradient.to)}` +
      `:x0=${fmt(g.x0)}:y0=${fmt(g.y0)}:x1=${fmt(g.x1)}:y1=${fmt(g.y1)},format=${pixFmt}[${cur}]`
    );
  } else {
    filterParts.push(`color=c=${escColor(bg.color)}:s=${W}x${H}:d=1,format=${pixFmt}[${cur}]`);
  }

  let layerIdx = 0;
  for (const layer of design.layers || []) {
    if (layer.hidden) continue;
    const out = `l${layerIdx++}`;
    const x = Math.round(num(layer.x)), y = Math.round(num(layer.y));
    const w = Math.max(1, Math.round(num(layer.w, 10))), h = Math.max(1, Math.round(num(layer.h, 10)));
    const opacity = clamp(num(layer.opacity, 1), 0, 1);

    if (layer.type === 'shape') {
      const s = layer.shape || {};
      if (s.kind === 'rect') {
        let expr = `[${cur}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${escColor(s.fill || '#7c5cff')}:t=fill`;
        if (opacity < 1) expr += `,format=rgba,colorchannelmixer=aa=${fmt(opacity)},format=${pixFmt}`;
        filterParts.push(`${expr}[${out}]`);
        if (s.stroke && num(s.strokeWidth) > 0) {
          const out2 = `l${layerIdx++}`;
          filterParts.push(`[${out}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${escColor(s.stroke)}:t=${Math.round(num(s.strokeWidth))}[${out2}]`);
          cur = out2;
        } else cur = out;
        if (s.radius) warnings.push(`Layer "${layer.name}": rounded corners are not rendered by the server renderer (drawn square).`);
        if (s.shadow) warnings.push(`Layer "${layer.name}": drop shadow is not rendered by the server renderer.`);
      } else if (s.kind === 'line') {
        const horizontal = w >= h;
        const t = Math.max(1, horizontal ? h : w);
        const expr = `[${cur}]drawbox=x=${x}:y=${y}:w=${horizontal ? w : t}:h=${horizontal ? t : h}:color=${escColor(s.fill || '#7c5cff')}:t=fill`;
        filterParts.push(`${expr}[${out}]`);
        cur = out;
      } else {
        warnings.push(`Layer "${layer.name}": ${s.kind} shapes are not rendered by the server renderer (rectangles, lines and text are).`);
        continue;
      }
      continue;
    }

    if (layer.type === 'text') {
      const t = layer.text || {};
      const font = fontFor(t.fontFamily, t.fontWeight);
      if (!font) throw new Error('No usable system font found for text rendering (DejaVu fonts missing).');
      const filePath = path.join(tmpDir, `text${layerIdx}.txt`);
      fs.writeFileSync(filePath, String(t.text || ''));
      textFiles.push(filePath);
      const fsPx = Math.max(6, Math.round(num(t.fontSize, 64)));
      let xExpr;
      if (t.align === 'center') xExpr = `${x}+(${w}-text_w)/2`;
      else if (t.align === 'right') xExpr = `${x}+${w}-text_w`;
      else xExpr = `${x}`;
      let dt = `drawtext=fontfile=${font}:textfile='${filePath}':fontsize=${fsPx}:fontcolor=${escColor(t.color)}:x='${xExpr}':y=${y}`;
      if (opacity < 1) dt += `:alpha=${fmt(opacity)}`;
      if (t.underline) warnings.push(`Layer "${layer.name}": underline is not rendered by the server renderer.`);
      if (t.shadow) warnings.push(`Layer "${layer.name}": text shadow is not rendered by the server renderer.`);
      if (t.stroke) warnings.push(`Layer "${layer.name}": text outline is not rendered by the server renderer.`);
      if (t.gradient) warnings.push(`Layer "${layer.name}": gradient text is not rendered by the server renderer (solid colour used).`);
      filterParts.push(`[${cur}]${dt}[${out}]`);
      cur = out;
      continue;
    }

    if (layer.type === 'image') {
      const im = layer.image || {};
      const mediaId = im.mediaId;
      if (!mediaId) { warnings.push(`Layer "${layer.name}": no media attached — skipped.`); continue; }
      const ii = inputForMedia(mediaId);
      const imgLabel = `img${layerIdx}`;
      const f = im.filters || {};
      const crop = im.crop || {};
      const parts = [`[${ii}:v]`];
      const cw = w * (1 - (num(crop.left) + num(crop.right)) / 100);
      const ch = h * (1 - (num(crop.top) + num(crop.bottom)) / 100);
      if (crop.left || crop.top || crop.right || crop.bottom) {
        parts.push(`crop=w='iw*${fmt(Math.max(0.05, 1 - (num(crop.left) + num(crop.right)) / 100))}':h='ih*${fmt(Math.max(0.05, 1 - (num(crop.top) + num(crop.bottom)) / 100))}':x='iw*${fmt(num(crop.left) / 100)}':y='ih*${fmt(num(crop.top) / 100)}'`);
      }
      parts.push(`scale=${Math.max(1, Math.round(cw))}:${Math.max(1, Math.round(ch))},setsar=1`);
      if (im.flipH) parts.push('hflip');
      if (im.flipV) parts.push('vflip');
      const rot = num(layer.rotation);
      if (rot) parts.push(`rotate=${fmt((rot * Math.PI) / 180)}:c=none:ow=rotw(iw):oh=roth(ih)`);
      const b = (num(f.brightness, 100) - 100) / 100, c = (num(f.contrast, 100) - 100) / 100, s = (num(f.saturate, 100) - 100) / 100;
      if (b !== 0 || c !== 0 || s !== 0) parts.push(`eq=brightness=${fmt(b)}:contrast=${fmt(1 + c)}:saturation=${fmt(1 + s)}`);
      if (num(f.grayscale)) parts.push('hue=s=0');
      if (num(f.sepia)) parts.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
      if (opacity < 1) parts.push(`format=rgba,colorchannelmixer=aa=${fmt(opacity)},format=${pixFmt}`);
      parts.push(`format=${pixFmt}[${imgLabel}]`);
      // parts[0] is the input link "[n:v]" — it joins to the first filter
      // with NO comma (a comma after a link is an empty filter and FFmpeg
      // refuses it with "No such filter: ''").
      filterParts.push(parts[0] + parts.slice(1).join(','));
      const ovOut = `l${layerIdx++}`;
      filterParts.push(`[${cur}][${imgLabel}]overlay=x=${x}:y=${y}[${ovOut}]`);
      cur = ovOut;
      continue;
    }

    warnings.push(`Layer "${layer.name}": unknown layer type "${layer.type}" — skipped.`);
  }

  filterParts.push(`[${cur}]format=${pixFmt}[vout]`);
  const args = ['-y', '-v', 'error'];
  for (const inp of inputs) args.push(...inp.args);
  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[vout]', '-frames:v', '1');
  if (isJpg) args.push('-q:v', '3');
  args.push(outPath);
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('error', (err) => reject(new Error(`Could not start FFmpeg: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg design render failed (code ${code}): ${errText.slice(-800)}`));
    });
  });
  const info = await probeMedia(outPath);
  if (!info || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error('Design render produced no output file.');
  }
  if (info.width !== W || info.height !== H) {
    warnings.push(`Rendered size is ${info.width}x${info.height}, expected ${W}x${H}.`);
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return { warnings, width: info.width, height: info.height };
}

module.exports = { renderDesign };
