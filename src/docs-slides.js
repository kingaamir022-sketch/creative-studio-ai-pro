'use strict';
// Docs & Slides (v2.2.3, Release B) — decks, documents, charts, websites,
// print. Pure model + export engine shared by the API routes and the tests.
//
// Standing rules enforced here:
//  - Text NEVER overflows its box: slideFitCheck / doc pagination use the
//    project's own fitText (the single source of truth — same DejaVu metrics
//    as the FFmpeg renderer). Un-fittable text is flagged "Needs attention"
//    with a shorter suggestion, never rendered broken.
//  - Uniform font: quiz-slide options share ONE size (set by the longest);
//    deckUniformFonts computes one question font + one option font for the
//    whole deck (batch-level), exactly like the quiz batch rule.
//  - Duplicate rows are permanently skipped (charts) — see src/chart.js.
//  - Nothing is faked: exports that cannot be produced throw an honest
//    error; AI deck generation refuses key_needed without an LLM key.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { validateDesign, blankDesign, uid } = require('./design-model');
const { fitText, uniformFont } = require('./quiz-model');
const { validateChart, normalizeChart, renderChartPng, chartToSvg } = require('./chart');
const { writeImagePdf, pngToJpeg } = require('./pdf-writer');
const { renderDesign } = require('./design-render');
const { probeMedia } = require('./ffmpeg');

const DECK_LAYOUTS = ['title', 'text', 'text-image', 'chart', 'quiz', 'blank'];
const DOC_BLOCK_TYPES = ['heading', 'paragraph', 'list', 'quote', 'table', 'image', 'divider', 'chart'];

function isHexColor(v) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v); }
function isNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

function textLayer(x, y, w, h, text, opts = {}) {
  return {
    id: uid('layer'), type: 'text', name: opts.name || 'Text', x, y, w, h,
    rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null,
    role: opts.role || 'body',
    text: {
      text, fontFamily: opts.fontFamily || 'Poppins', fontSize: opts.fontSize || 48,
      fontWeight: opts.fontWeight || 700, fontStyle: 'normal', underline: false,
      align: opts.align || 'left', color: opts.color || '#ffffff',
      letterSpacing: 0, lineHeight: opts.lineHeight || 1.25, shadow: null, stroke: null, gradient: null,
    },
  };
}
function shapeLayer(x, y, w, h, fill, opts = {}) {
  return {
    id: uid('layer'), type: 'shape', name: opts.name || 'Rectangle', x, y, w, h,
    rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null,
    shape: { kind: opts.kind || 'rect', fill, stroke: opts.stroke || '', strokeWidth: opts.strokeWidth || 0, radius: opts.radius || 0, shadow: null },
  };
}

// --- Decks ------------------------------------------------------------------
function blankSlide(layout = 'blank', { width = 1920, height = 1080 } = {}) {
  if (!DECK_LAYOUTS.includes(layout)) throw new Error(`Unknown slide layout: ${layout}. Use one of: ${DECK_LAYOUTS.join(', ')}.`);
  const bg = { type: 'color', color: '#151d3a', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const slide = { id: uid('slide'), layout, background: bg, notes: '', duration: 5, elements: [] };
  const cx = (w) => Math.round((width - w) / 2);
  if (layout === 'title') {
    slide.elements.push(shapeLayer(0, 0, width, height, '#151d3a', { name: 'Background' }));
    slide.elements.push(textLayer(cx(1400), 380, 1400, 120, 'Presentation Title', { name: 'Title', role: 'title', fontSize: 96, align: 'center' }));
    slide.elements.push(textLayer(cx(1000), 540, 1000, 60, 'A short subtitle for your deck', { name: 'Subtitle', role: 'subtitle', fontSize: 40, fontWeight: 400, align: 'center', color: '#c7d2fe' }));
  } else if (layout === 'text') {
    slide.elements.push(textLayer(120, 90, 1680, 100, 'Slide Title', { name: 'Title', role: 'title', fontSize: 64, align: 'left' }));
    slide.elements.push(shapeLayer(120, 210, 160, 8, '#7c5cff', { name: 'Accent' }));
    slide.elements.push(textLayer(120, 260, 1680, 700, 'Write your points here.\nEach line is a new point.', { name: 'Body', role: 'body', fontSize: 36, fontWeight: 400, align: 'left' }));
  } else if (layout === 'text-image') {
    slide.elements.push(textLayer(120, 90, 900, 100, 'Slide Title', { name: 'Title', role: 'title', fontSize: 64, align: 'left' }));
    slide.elements.push(textLayer(120, 260, 900, 700, 'Text on the left, image on the right. Add an image from the Media Library.', { name: 'Body', role: 'body', fontSize: 36, fontWeight: 400, align: 'left' }));
    slide.elements.push(shapeLayer(1080, 220, 720, 640, '#24304f', { name: 'Image placeholder' }));
    slide.elements.push(textLayer(1080, 500, 720, 60, 'Image goes here', { name: 'Placeholder label', role: 'body', fontSize: 28, fontWeight: 400, align: 'center', color: '#94a3b8' }));
  } else if (layout === 'chart') {
    slide.elements.push(textLayer(120, 90, 1680, 100, 'Chart Title', { name: 'Title', role: 'title', fontSize: 64, align: 'left' }));
    slide.elements.push({
      id: uid('layer'), type: 'chart', name: 'Chart', x: 160, y: 240, w: 1600, h: 720,
      rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null,
      chart: {
        type: 'bar', title: '', legend: true, showValues: true,
        labels: ['Jan', 'Feb', 'Mar', 'Apr'],
        datasets: [{ label: 'Series 1', values: [12, 19, 8, 15], color: '#7c5cff' }],
      },
    });
  } else if (layout === 'quiz') {
    slide.elements.push(textLayer(120, 90, 1680, 120, 'Question goes here?', { name: 'Question', role: 'question', fontSize: 56, align: 'left' }));
    const opts = ['Option A', 'Option B', 'Option C', 'Option D'];
    opts.forEach((t, i) => {
      const y = 260 + i * 170;
      slide.elements.push(shapeLayer(120, y, 1680, 140, i === 0 ? '#16a34a' : '#24304f', { name: `Option ${String.fromCharCode(65 + i)} box` }));
      slide.elements.push(textLayer(180, y + 40, 1560, 60, `${String.fromCharCode(65 + i)}. ${t}`, { name: `Option ${String.fromCharCode(65 + i)}`, role: 'option', fontSize: 40, fontWeight: 500, align: 'left' }));
    });
  }
  return slide;
}

function blankDeck({ title = 'Untitled Deck', width = 1920, height = 1080 } = {}) {
  return { version: 1, title, width, height, slides: [blankSlide('title', { width, height })] };
}

function validateDeck(deck) {
  const errors = [];
  if (!deck || typeof deck !== 'object' || Array.isArray(deck)) return { ok: false, errors: ['Deck must be a JSON object.'] };
  if (deck.version !== undefined && deck.version !== 1) errors.push('Unsupported deck version.');
  if (typeof deck.title !== 'string' || !deck.title.trim() || deck.title.length > 200) errors.push('Deck title is required (max 200 characters).');
  if (!isNumber(deck.width) || deck.width < 160 || deck.width > 3840) errors.push('Deck width must be 160–3840.');
  if (!isNumber(deck.height) || deck.height < 160 || deck.height > 3840) errors.push('Deck height must be 160–3840.');
  if (!Array.isArray(deck.slides) || !deck.slides.length) errors.push('A deck needs at least one slide.');
  else {
    if (deck.slides.length > 200) errors.push('A deck may have at most 200 slides.');
    const ids = new Set();
    deck.slides.forEach((s, i) => {
      const where = `Slide ${i + 1}`;
      if (!s || typeof s !== 'object') { errors.push(`${where}: must be an object.`); return; }
      if (!s.id || typeof s.id !== 'string') errors.push(`${where}: id is required.`);
      else if (ids.has(s.id)) errors.push(`${where}: duplicate slide id "${s.id}".`);
      else ids.add(s.id);
      if (!DECK_LAYOUTS.includes(s.layout)) errors.push(`${where}: layout must be one of: ${DECK_LAYOUTS.join(', ')}.`);
      if (s.duration !== undefined && (!isNumber(s.duration) || s.duration < 1 || s.duration > 60)) errors.push(`${where}: duration must be 1–60 seconds.`);
      if (s.background) {
        if (!['color', 'gradient'].includes(s.background.type)) errors.push(`${where}: background type must be color or gradient.`);
        if (s.background.type === 'color' && !isHexColor(s.background.color)) errors.push(`${where}: background color must be a #rrggbb hex color.`);
      }
      if (!Array.isArray(s.elements)) errors.push(`${where}: elements must be an array.`);
      else {
        const design = { version: 1, width: deck.width, height: deck.height, background: s.background || { type: 'color', color: '#151d3a' }, layers: s.elements.filter((e) => e.type !== 'chart') };
        const check = validateDesign(design);
        if (!check.ok) errors.push(`${where}: ${check.errors.join(' ')}`);
        s.elements.forEach((e, j) => {
          if (e.type === 'chart') {
            if (!e.chart) errors.push(`${where}, element ${j + 1}: chart settings are required.`);
            else {
              const cv = validateChart(e.chart);
              if (!cv.ok) errors.push(`${where}, element ${j + 1}: ${cv.errors.join(' ')}`);
            }
            for (const k of ['x', 'y', 'w', 'h']) if (!isNumber(e[k])) errors.push(`${where}, element ${j + 1}: ${k} must be a number.`);
          }
        });
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

function addSlide(deck, layout, index) {
  const v = validateDeck(deck);
  if (!v.ok) throw new Error('Invalid deck: ' + v.errors.join(' '));
  const next = clone(deck);
  const slide = blankSlide(layout, { width: next.width, height: next.height });
  const at = index === undefined ? next.slides.length : clamp(Math.round(index), 0, next.slides.length);
  next.slides.splice(at, 0, slide);
  return { deck: next, slide };
}
function moveSlide(deck, from, to) {
  const next = clone(deck);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= next.slides.length || to < 0 || to >= next.slides.length) {
    throw new Error('Slide move is out of range.');
  }
  const [s] = next.slides.splice(from, 1);
  next.slides.splice(to, 0, s);
  return next;
}
function duplicateSlide(deck, slideId) {
  const next = clone(deck);
  const idx = next.slides.findIndex((s) => s.id === slideId);
  if (idx < 0) throw new Error(`Slide "${slideId}" not found.`);
  const copy = clone(next.slides[idx]);
  copy.id = uid('slide');
  for (const el of copy.elements || []) el.id = uid('layer');
  next.slides.splice(idx + 1, 0, copy);
  return { deck: next, slide: copy };
}
function deleteSlide(deck, slideId) {
  const next = clone(deck);
  if (next.slides.length <= 1) throw new Error('A deck needs at least one slide — it cannot be emptied.');
  const idx = next.slides.findIndex((s) => s.id === slideId);
  if (idx < 0) throw new Error(`Slide "${slideId}" not found.`);
  next.slides.splice(idx, 1);
  return next;
}

// --- Fit checks (never-overflow + uniform font) -------------------------------
function slideFitCheck(slide, { width, height }) {
  const needsAttention = [];
  const options = [];
  for (const el of slide.elements || []) {
    if (el.hidden) continue;
    if (el.type === 'text') {
      const t = el.text || {};
      const maxLines = Math.max(1, Math.floor(el.h / Math.max(1, (t.fontSize || 48) * (t.lineHeight || 1.25))));
      const fit = fitText(t.text || '', el.w, { maxFont: t.fontSize || 48, minFont: 12, maxLines, lineHeight: t.lineHeight || 1.25 });
      if (el.role === 'option') options.push({ key: el.id, text: t.text || '', layer: el });
      if (fit.status === 'attention' || fit.heightPx > el.h + 1) {
        needsAttention.push({ layerId: el.id, name: el.name || 'Text', reason: 'Text does not fit its box even at the smallest readable size.', suggestedText: fit.suggestedText, fittedFont: fit.fontSize });
      }
    }
  }
  // Quiz slides: all options share ONE font size (set by the longest).
  let uniformOptionFont = null;
  if (options.length >= 2) {
    const u = uniformFont(options.map((o) => ({ key: o.key, text: o.text })), Math.min(...options.map((o) => o.layer.w)), { maxFont: Math.min(...options.map((o) => o.layer.text.fontSize || 40)), minFont: 12, maxLines: 2, lineHeight: 1.25 });
    uniformOptionFont = u.font;
    for (const out of u.outliers) {
      const layer = options.find((o) => o.key === out.key);
      needsAttention.push({ layerId: out.key, name: (layer && layer.layer.name) || 'Option', reason: 'Option text does not fit at the shared option font size.', suggestedText: out.suggestedText, fittedFont: out.requiredFont });
    }
  }
  return { fits: needsAttention.length === 0, needsAttention, uniformOptionFont };
}

function deckFitCheck(deck) {
  const v = validateDeck(deck);
  if (!v.ok) return { ok: false, errors: v.errors, slides: [], needsAttention: [] };
  const slides = deck.slides.map((s) => ({ slideId: s.id, ...slideFitCheck(s, { width: deck.width, height: deck.height }) }));
  // Batch-level uniform fonts across all quiz slides (like the quiz batch
  // rule: one question size, one option size for the whole deck).
  const questions = [];
  const options = [];
  for (const s of deck.slides) {
    if (s.layout !== 'quiz') continue;
    for (const el of s.elements || []) {
      if (el.type !== 'text' || el.hidden) continue;
      if (el.role === 'question') questions.push({ key: `${s.id}:${el.id}`, text: el.text.text || '' });
      if (el.role === 'option') options.push({ key: `${s.id}:${el.id}`, text: el.text.text || '' });
    }
  }
  let batchFonts = null;
  if (questions.length || options.length) {
    batchFonts = {
      question: questions.length ? uniformFont(questions, deck.width - 240, { maxFont: 56, minFont: 12, maxLines: 3, lineHeight: 1.25 }).font : null,
      option: options.length ? uniformFont(options, deck.width - 360, { maxFont: 40, minFont: 12, maxLines: 2, lineHeight: 1.25 }).font : null,
    };
  }
  return {
    ok: true, slides,
    needsAttention: slides.flatMap((s) => s.needsAttention.map((n) => ({ slideId: s.slideId, ...n }))),
    batchFonts,
  };
}

function applyDeckUniformFonts(deck) {
  const next = clone(deck);
  const check = deckFitCheck(next);
  if (!check.ok || !check.batchFonts) return { deck: next, applied: false };
  const { question, option } = check.batchFonts;
  for (const s of next.slides) {
    if (s.layout !== 'quiz') continue;
    for (const el of s.elements || []) {
      if (el.type !== 'text') continue;
      if (el.role === 'question' && question) el.text.fontSize = question;
      if (el.role === 'option' && option) el.text.fontSize = option;
    }
  }
  return { deck: next, applied: true, batchFonts: check.batchFonts };
}

// Convert a slide to a design JSON for the server renderer. Chart layers
// are pre-rendered to PNGs by the caller; chartFiles maps layer id → file
// path, and mediaById maps the synthetic media id → { filePath, kind }.
function slideToDesign(slide, { width, height }) {
  const design = blankDesign(width, height);
  design.background = slide.background || { type: 'color', color: '#151d3a' };
  design.layers = [];
  for (const el of slide.elements || []) {
    if (el.type === 'chart') {
      design.layers.push({
        id: el.id, type: 'image', name: el.name || 'Chart', x: el.x, y: el.y, w: el.w, h: el.h,
        rotation: el.rotation || 0, opacity: el.opacity ?? 1, locked: false, hidden: !!el.hidden, groupId: null,
        image: {
          mediaId: `chart:${el.id}`, src: 'chart.png',
          filters: { grayscale: 0, sepia: 0, brightness: 100, contrast: 100, saturate: 100 },
          flipH: false, flipV: false, crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      });
    } else {
      design.layers.push(clone(el));
    }
  }
  return design;
}

function deckToDesigns(deck) {
  const v = validateDeck(deck);
  if (!v.ok) throw new Error('Invalid deck: ' + v.errors.join(' '));
  return deck.slides.map((s) => slideToDesign(s, { width: deck.width, height: deck.height }));
}

// --- Documents ----------------------------------------------------------------
function blankDoc({ title = 'Untitled Document' } = {}) {
  return {
    version: 1,
    title,
    blocks: [
      { id: uid('block'), type: 'heading', level: 1, text: title },
      { id: uid('block'), type: 'paragraph', text: 'Start writing here. Add headings, lists, tables and images from the toolbar.' },
    ],
  };
}

function validateDoc(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, errors: ['Document must be a JSON object.'] };
  if (doc.version !== undefined && doc.version !== 1) errors.push('Unsupported document version.');
  if (typeof doc.title !== 'string' || !doc.title.trim() || doc.title.length > 200) errors.push('Document title is required (max 200 characters).');
  if (!Array.isArray(doc.blocks)) errors.push('Document blocks must be an array.');
  else {
    if (doc.blocks.length > 2000) errors.push('A document may have at most 2000 blocks.');
    const ids = new Set();
    doc.blocks.forEach((b, i) => {
      const where = `Block ${i + 1}`;
      if (!b || typeof b !== 'object') { errors.push(`${where}: must be an object.`); return; }
      if (!b.id || typeof b.id !== 'string') errors.push(`${where}: id is required.`);
      else if (ids.has(b.id)) errors.push(`${where}: duplicate block id "${b.id}".`);
      else ids.add(b.id);
      if (!DOC_BLOCK_TYPES.includes(b.type)) errors.push(`${where}: type must be one of: ${DOC_BLOCK_TYPES.join(', ')}.`);
      if (b.type === 'heading') {
        if (![1, 2, 3].includes(b.level)) errors.push(`${where}: heading level must be 1, 2 or 3.`);
        if (typeof b.text !== 'string' || !b.text.trim()) errors.push(`${where}: heading text is required.`);
      }
      if (b.type === 'paragraph' || b.type === 'quote') {
        if (typeof b.text !== 'string') errors.push(`${where}: text must be a string.`);
      }
      if (b.type === 'list') {
        if (!['bullet', 'number'].includes(b.style)) errors.push(`${where}: list style must be bullet or number.`);
        if (!Array.isArray(b.items) || !b.items.length) errors.push(`${where}: list needs at least one item.`);
        else b.items.forEach((it, j) => { if (typeof it !== 'string') errors.push(`${where}, item ${j + 1}: must be a string.`); });
      }
      if (b.type === 'table') {
        if (!Array.isArray(b.headers) || !b.headers.length) errors.push(`${where}: table needs at least one header.`);
        if (!Array.isArray(b.rows)) errors.push(`${where}: table rows must be an array.`);
        else b.rows.forEach((row, j) => {
          if (!Array.isArray(row) || row.length !== (b.headers || []).length) errors.push(`${where}, row ${j + 1}: must have one cell per header.`);
        });
      }
      if (b.type === 'image') {
        if (!Number.isInteger(b.mediaId)) errors.push(`${where}: image needs a mediaId from the Media Library.`);
      }
      if (b.type === 'chart') {
        if (!b.chart) errors.push(`${where}: chart settings are required.`);
        else {
          const cv = validateChart(b.chart);
          if (!cv.ok) errors.push(`${where}: ${cv.errors.join(' ')}`);
        }
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Semantic HTML + print CSS. Word-compatible: opening this file in Word
// renders the document (and the .docx export below is the real Word file).
function docToHtml(doc, { fullPage = true } = {}) {
  const v = validateDoc(doc);
  if (!v.ok) throw new Error('Invalid document: ' + v.errors.join(' '));
  const body = [];
  for (const b of doc.blocks) {
    if (b.type === 'heading') body.push(`<h${b.level}>${escHtml(b.text)}</h${b.level}>`);
    else if (b.type === 'paragraph') body.push(`<p>${escHtml(b.text).replace(/\n/g, '<br>')}</p>`);
    else if (b.type === 'quote') body.push(`<blockquote>${escHtml(b.text)}</blockquote>`);
    else if (b.type === 'list') {
      const tag = b.style === 'number' ? 'ol' : 'ul';
      body.push(`<${tag}>${b.items.map((it) => `<li>${escHtml(it)}</li>`).join('')}</${tag}>`);
    } else if (b.type === 'table') {
      body.push(`<table><thead><tr>${b.headers.map((h) => `<th>${escHtml(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (b.type === 'image') {
      body.push(`<figure><img src="${escHtml(b.imageUrl || '')}" alt="${escHtml(b.caption || 'Image')}">${b.caption ? `<figcaption>${escHtml(b.caption)}</figcaption>` : ''}</figure>`);
    } else if (b.type === 'divider') body.push('<hr>');
    else if (b.type === 'chart') body.push(`<div class="chart">${chartToSvg(normalizeChart(b.chart), { width: 960, height: 540 })}</div>`);
  }
  const inner = body.join('\n');
  if (!fullPage) return inner;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${escHtml(doc.title)}</title>
<style>
body{font-family:Inter,Arial,sans-serif;color:#111827;max-width:800px;margin:40px auto;padding:0 24px;line-height:1.6}
h1{font-size:32px;line-height:1.2;margin:28px 0 12px}h2{font-size:26px;margin:24px 0 10px}h3{font-size:21px;margin:20px 0 8px}
p{margin:0 0 14px}blockquote{border-left:4px solid #7c5cff;margin:14px 0;padding:4px 16px;color:#374151}
table{border-collapse:collapse;width:100%;margin:14px 0}th,td{border:1px solid #d1d5db;padding:8px 10px;text-align:left}th{background:#f3f4f6}
img{max-width:100%}figure{margin:14px 0;text-align:center}figcaption{color:#6b7280;font-size:14px;margin-top:6px}
hr{border:none;border-top:1px solid #d1d5db;margin:24px 0}.chart svg{max-width:100%;height:auto}
@media print{body{margin:0;max-width:none}h1,h2,h3{break-after:avoid}table,figure{break-inside:avoid}}
</style></head><body><article>${inner}</article></body></html>`;
}

// Minimal real .docx (Word Open XML) via archiver. Headings, paragraphs,
// lists (as prefixed text — Word renders them, no numbering.xml needed),
// tables, and embedded images (word/media + drawing). No fake content:
// every block in the doc appears in the file.
async function docToDocx(doc, { mediaById = {}, outPath } = {}) {
  const v = validateDoc(doc);
  if (!v.ok) throw new Error('Invalid document: ' + v.errors.join(' '));
  const archiver = require('archiver');
  const escXml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rels = [];
  const mediaFiles = []; // {name, filePath}
  let mediaIdx = 0;
  // C-10: charts are real images in the .docx, not placeholder text.
  // Chart PNGs are rendered into a temp dir next to the output and
  // removed once the archive is written.
  const chartTmpDir = path.join(path.dirname(outPath), `.docx-charts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const emu = (px) => Math.round(px * 9525);
  // Register an image file in word/media and return its drawing paragraph.
  const embedImage = (filePath, wPx, hPx, label) => {
    mediaIdx += 1;
    const ext = path.extname(filePath).replace('.', '').toLowerCase() || 'png';
    const name = `image${mediaIdx}.${ext === 'jpg' ? 'jpeg' : ext}`;
    mediaFiles.push({ name, filePath });
    rels.push({ id: `rId${mediaIdx}`, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: `media/${name}` });
    return `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${emu(wPx)}" cy="${emu(hPx)}"/><wp:docPr id="${mediaIdx}" name="${escXml(label)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${mediaIdx}" name="${escXml(label)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId${mediaIdx}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(wPx)}" cy="${emu(hPx)}"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  };
  const para = (text, { style = null, bold = false, size = null } = {}) => {
    const pPr = [
      style ? `<w:pStyle w:val="${style}"/>` : '',
      `<w:spacing w:after="160" w:line="276" w:lineRule="auto"/>`,
    ].join('');
    const rPr = [
      bold ? '<w:b/>' : '',
      size ? `<w:sz w:val="${size}"/>` : '',
    ].join('');
    const runs = String(text || '').split('\n').map((line, i) => (
      `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${escXml(line)}</w:t>${i < String(text || '').split('\n').length - 1 ? '<w:br/>' : ''}</w:r>`
    )).join('');
    return `<w:p><w:pPr>${pPr}</w:pPr>${runs}</w:p>`;
  };
  const body = [];
  for (const b of doc.blocks) {
    if (b.type === 'heading') {
      body.push(para(b.text, { style: `Heading${b.level}`, bold: true, size: b.level === 1 ? 32 : b.level === 2 ? 28 : 24 }));
    } else if (b.type === 'paragraph') body.push(para(b.text));
    else if (b.type === 'quote') body.push(para(b.text, { style: 'IntenseQuote' }));
    else if (b.type === 'list') {
      b.items.forEach((it, i) => body.push(para(b.style === 'number' ? `${i + 1}. ${it}` : `•  ${it}`)));
    } else if (b.type === 'table') {
      const cols = b.headers.length;
      const grid = `<w:tblGrid>${b.headers.map(() => '<w:gridCol w:w="2400"/>').join('')}</w:tblGrid>`;
      const headRow = `<w:tr>${b.headers.map((h) => `<w:tc><w:tcPr><w:shd w:fill="F3F4F6"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escXml(h)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`;
      const dataRows = b.rows.map((row) => `<w:tr>${row.map((c) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${escXml(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('');
      body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${cols * 2400}" w:type="dxa"/></w:tblPr>${grid}${headRow}${dataRows}</w:tbl>`);
    } else if (b.type === 'image') {
      const m = mediaById[b.mediaId];
      if (m && fs.existsSync(m.filePath)) {
        const wPx = Math.min(600, m.width || 600);
        const hPx = Math.round(wPx * ((m.height || 400) / (m.width || 600)));
        body.push(embedImage(m.filePath, wPx, hPx, `Image ${mediaIdx + 1}`));
        if (b.caption) body.push(para(b.caption, { size: 20 }));
      } else {
        body.push(para('[Image missing from the Media Library]', { size: 20 }));
      }
    } else if (b.type === 'divider') body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="D1D5DB"/></w:pBdr></w:pPr><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>');
    else if (b.type === 'chart') {
      // C-10: render the chart to a real PNG and embed it like any image —
      // a .docx must never drop a chart to placeholder text.
      try {
        fs.mkdirSync(chartTmpDir, { recursive: true });
        const chartPath = path.join(chartTmpDir, `chart-${b.id || mediaIdx + 1}.png`);
        await renderChartPng(b.chart, chartPath, { width: 960, height: 540 });
        const wPx = 600;
        const hPx = Math.round(wPx * 540 / 960);
        body.push(embedImage(chartPath, wPx, hPx, `Chart ${mediaIdx + 1}`));
        if (b.chart && b.chart.title) body.push(para(b.chart.title, { size: 20 }));
      } catch (e) {
        body.push(para(`[Chart "${(b.chart && b.chart.title) || b.chart.type}" could not be rendered: ${e.message}]`, { size: 20 }));
      }
    }
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join('')}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId0" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>${rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join('')}</Relationships>`;
  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join('')}</Relationships>`;
  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append(contentTypes, { name: '[Content_Types].xml' });
      archive.append(relsXml, { name: '_rels/.rels' });
      archive.append(docRelsXml, { name: 'word/_rels/document.xml.rels' });
      archive.append(documentXml, { name: 'word/document.xml' });
      for (const mf of mediaFiles) archive.file(mf.filePath, { name: `word/media/${mf.name}` });
      archive.finalize();
    });
  } finally {
    // C-10: chart PNGs were copied into the archive; remove the temp dir.
    try { fs.rmSync(chartTmpDir, { recursive: true, force: true }); } catch { /* temp cleanup is best-effort */ }
  }
  return { blocks: doc.blocks.length, images: mediaFiles.length };
}

// Paginate a document into A4 designs (1240x1754) for the PDF renderer.
// Text is split by fitText lines, so a paragraph never overflows its page
// and a long paragraph flows onto the next page. Tables repeat their header
// when they split across pages.
function docToDesignPages(doc, { pageWidth = 1240, pageHeight = 1754, mediaById = {}, chartFiles = {} } = {}) {
  const v = validateDoc(doc);
  if (!v.ok) throw new Error('Invalid document: ' + v.errors.join(' '));
  const ML = 90, MR = 90, MT = 90, MB = 90;
  const contentW = pageWidth - ML - MR;
  const styles = {
    h1: { fontSize: 54, lineHeight: 1.2, weight: 800, color: '#111827', gap: 30 },
    h2: { fontSize: 44, lineHeight: 1.2, weight: 700, color: '#111827', gap: 26 },
    h3: { fontSize: 36, lineHeight: 1.25, weight: 700, color: '#111827', gap: 22 },
    p: { fontSize: 28, lineHeight: 1.4, weight: 400, color: '#1f2937', gap: 20 },
    quote: { fontSize: 30, lineHeight: 1.4, weight: 400, color: '#374151', gap: 20 },
    li: { fontSize: 28, lineHeight: 1.4, weight: 400, color: '#1f2937', gap: 10 },
    cell: { fontSize: 24, lineHeight: 1.3, weight: 400, color: '#1f2937', gap: 0 },
    head: { fontSize: 24, lineHeight: 1.3, weight: 700, color: '#111827', gap: 0 },
  };
  const pages = [];
  let layers = [];
  let y = MT;
  const newPage = () => {
    const design = blankDesign(pageWidth, pageHeight);
    design.background = { type: 'color', color: '#ffffff' };
    design.layers = layers;
    pages.push(design);
    layers = [];
    y = MT;
  };
  const need = (h) => { if (y + h > pageHeight - MB && layers.length) newPage(); };
  const addText = (text, st, { x = ML, w = contentW, align = 'left' } = {}) => {
    const fit = fitText(text, w, { maxFont: st.fontSize, minFont: 12, maxLines: 1000, lineHeight: st.lineHeight });
    layers.push(textLayer(x, y, w, Math.ceil(fit.heightPx) + 4, text, { fontSize: fit.fontSize, fontWeight: st.weight, color: st.color, align, lineHeight: st.lineHeight }));
    y += Math.ceil(fit.heightPx) + 4;
  };
  const addTextLines = (lines, st, { x = ML, w = contentW } = {}) => {
    // lines: pre-wrapped lines; split across pages when they do not fit.
    const lineH = Math.ceil(st.fontSize * st.lineHeight);
    let i = 0;
    while (i < lines.length) {
      const room = pageHeight - MB - y;
      const fits = Math.max(0, Math.floor(room / lineH));
      if (fits === 0) { newPage(); continue; }
      const chunk = lines.slice(i, i + fits);
      layers.push(textLayer(x, y, w, chunk.length * lineH + 4, chunk.join('\n'), { fontSize: st.fontSize, fontWeight: st.weight, color: st.color, align: 'left', lineHeight: st.lineHeight }));
      y += chunk.length * lineH + 4;
      i += chunk.length;
    }
  };
  for (const b of doc.blocks) {
    if (b.type === 'heading') {
      const st = styles[`h${b.level}`];
      const fit = fitText(b.text, contentW, { maxFont: st.fontSize, minFont: 12, maxLines: 4, lineHeight: st.lineHeight });
      need(Math.ceil(fit.heightPx) + 4 + st.gap);
      addText(b.text, st);
      y += st.gap;
    } else if (b.type === 'paragraph') {
      const st = styles.p;
      const fit = fitText(b.text, contentW, { maxFont: st.fontSize, minFont: 12, maxLines: 1000, lineHeight: st.lineHeight });
      addTextLines(fit.lines, st);
      y += st.gap;
    } else if (b.type === 'quote') {
      const st = styles.quote;
      const fit = fitText(b.text, contentW - 40, { maxFont: st.fontSize, minFont: 12, maxLines: 1000, lineHeight: st.lineHeight });
      need(Math.ceil(fit.heightPx) + 4 + st.gap);
      layers.push(shapeLayer(ML, y, 8, Math.ceil(fit.heightPx) + 4, '#7c5cff', { name: 'Quote bar' }));
      addTextLines(fit.lines, st, { x: ML + 40, w: contentW - 40 });
      y += st.gap;
    } else if (b.type === 'list') {
      const st = styles.li;
      b.items.forEach((item, i) => {
        const prefix = b.style === 'number' ? `${i + 1}. ` : '•  ';
        const fit = fitText(prefix + item, contentW, { maxFont: st.fontSize, minFont: 12, maxLines: 1000, lineHeight: st.lineHeight });
        addTextLines(fit.lines, st);
        y += st.gap;
      });
      y += 10;
    } else if (b.type === 'divider') {
      need(30);
      layers.push(shapeLayer(ML, y + 12, contentW, 2, '#d1d5db', { name: 'Divider', kind: 'line' }));
      y += 30;
    } else if (b.type === 'table') {
      const cols = b.headers.length;
      const colW = contentW / cols;
      const headH = 52;
      const rowHFor = (row) => {
        let h = 0;
        row.forEach((cell) => {
          const fit = fitText(String(cell ?? ''), colW - 24, { maxFont: styles.cell.fontSize, minFont: 12, maxLines: 1000, lineHeight: styles.cell.lineHeight });
          h = Math.max(h, Math.ceil(fit.heightPx) + 16);
        });
        return Math.max(44, h);
      };
      const drawRow = (cells, isHead, rowY, rowH) => {
        if (isHead) layers.push(shapeLayer(ML, rowY, contentW, rowH, '#f3f4f6', { name: 'Table header' }));
        cells.forEach((cell, j) => {
          const cx = ML + j * colW;
          const st = isHead ? styles.head : styles.cell;
          layers.push(textLayer(cx + 12, rowY + 8, colW - 24, rowH - 16, String(cell ?? ''), { fontSize: st.fontSize, fontWeight: st.weight, color: st.color, align: 'left', lineHeight: st.lineHeight }));
        });
      };
      const tableTop = y;
      need(headH);
      drawRow(b.headers, true, y, headH);
      y += headH;
      const rowBounds = [tableTop, y];
      for (const row of b.rows) {
        const rh = rowHFor(row);
        if (y + rh > pageHeight - MB) {
          // Grid lines for the finished part, then continue on a new page.
          drawGridLines(tableTop, y);
          newPage();
          drawRow(b.headers, true, y, headH);
          y += headH;
          rowBounds.length = 0;
          rowBounds.push(y - headH, y);
        }
        drawRow(row, false, y, rh);
        y += rh;
        rowBounds.push(y);
      }
      drawGridLines(rowBounds[0], y);
      y += 20;
      function drawGridLines(top, bottom) {
        // Horizontal lines at every row boundary + vertical lines per column.
        for (const by of rowBounds) layers.push(shapeLayer(ML, by, contentW, 1, '#d1d5db', { name: 'Table line', kind: 'line' }));
        for (let j = 0; j <= cols; j++) {
          layers.push(shapeLayer(ML + j * colW, top, 1, bottom - top, '#d1d5db', { name: 'Table line', kind: 'line' }));
        }
      }
    } else if (b.type === 'image') {
      const m = mediaById[b.mediaId];
      if (m && m.filePath) {
        const w = Math.min(contentW, 900);
        const h = Math.min(620, Math.round(w * ((m.height || 400) / (m.width || 600))));
        need(h + (b.caption ? 44 : 0) + 20);
        layers.push({
          id: uid('layer'), type: 'image', name: 'Image', x: ML + Math.round((contentW - w) / 2), y, w, h,
          rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null,
          image: { mediaId: b.mediaId, src: 'image', filters: { grayscale: 0, sepia: 0, brightness: 100, contrast: 100, saturate: 100 }, flipH: false, flipV: false, crop: { left: 0, top: 0, right: 0, bottom: 0 } },
        });
        y += h + 8;
        if (b.caption) { addText(b.caption, { fontSize: 22, lineHeight: 1.3, weight: 400, color: '#6b7280', gap: 0 }, { align: 'center' }); }
        y += 20;
      } else {
        need(40);
        addText('[Image missing from the Media Library]', { fontSize: 22, lineHeight: 1.3, weight: 400, color: '#9ca3af', gap: 0 });
        y += 20;
      }
    } else if (b.type === 'chart') {
      const file = chartFiles[b.id];
      if (file) {
        const w = Math.min(contentW, 980);
        const h = Math.round(w * 540 / 960);
        need(h + 20);
        layers.push({
          id: uid('layer'), type: 'image', name: 'Chart', x: ML + Math.round((contentW - w) / 2), y, w, h,
          rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null,
          image: { mediaId: `chart:${b.id}`, src: 'chart.png', filters: { grayscale: 0, sepia: 0, brightness: 100, contrast: 100, saturate: 100 }, flipH: false, flipV: false, crop: { left: 0, top: 0, right: 0, bottom: 0 } },
        });
        y += h + 20;
      }
    }
  }
  if (layers.length || !pages.length) {
    const design = blankDesign(pageWidth, pageHeight);
    design.background = { type: 'color', color: '#ffffff' };
    design.layers = layers;
    pages.push(design);
  }
  return pages;
}

// --- Print --------------------------------------------------------------------
// Page sizes at 150 DPI (the render resolution). PDF points are 1/72 inch.
const PRINT_SIZES = {
  a4: { id: 'a4', name: 'A4', widthMm: 210, heightMm: 297, ptW: 595.28, ptH: 841.89, pxW: 1240, pxH: 1754 },
  letter: { id: 'letter', name: 'US Letter', widthMm: 215.9, heightMm: 279.4, ptW: 612, ptH: 792, pxW: 1275, pxH: 1650 },
  poster: { id: 'poster', name: 'Poster 18×24 in', widthMm: 457.2, heightMm: 609.6, ptW: 1296, ptH: 1728, pxW: 2160, pxH: 2880 },
};

function scaleDesign(design, s) {
  const d = clone(design);
  d.width = Math.round(d.width * s);
  d.height = Math.round(d.height * s);
  for (const l of d.layers || []) {
    l.x = Math.round(l.x * s); l.y = Math.round(l.y * s);
    l.w = Math.round(l.w * s); l.h = Math.round(l.h * s);
    if (l.type === 'text' && l.text) l.text.fontSize = Math.round(l.text.fontSize * s);
  }
  return d;
}

// Render designs to a print-ready PDF: full-bleed pages (trim size + bleed),
// crop marks at the trim corners and a safe-zone rectangle (vector lines).
// Returns { outPath, pages, sizePt: {w, h}, bleedPt, marginPt }.
async function designsToPrintPdf(designs, { sizeId = 'a4', bleedMm = 3, marginMm = 10, mediaById = {}, chartFiles = {}, workDir, outPath } = {}) {
  const size = PRINT_SIZES[sizeId];
  if (!size) throw new Error(`Unknown print size: ${sizeId}. Use one of: ${Object.keys(PRINT_SIZES).join(', ')}.`);
  if (!Array.isArray(designs) || !designs.length) throw new Error('At least one design is required for a print PDF.');
  if (bleedMm < 0 || bleedMm > 10) throw new Error('Bleed must be 0–10 mm.');
  if (marginMm < 0 || marginMm > 50) throw new Error('Margin must be 0–50 mm.');
  const dpi = 150;
  const mmToPx = (mm) => Math.round((mm / 25.4) * dpi);
  const mmToPt = (mm) => (mm / 25.4) * 72;
  const bleedPx = mmToPx(bleedMm);
  const bleedPt = mmToPt(bleedMm);
  const marginPt = mmToPt(marginMm);
  const pagePtW = size.ptW + bleedPt * 2;
  const pagePtH = size.ptH + bleedPt * 2;
  fs.mkdirSync(workDir, { recursive: true });
  const pages = [];
  for (let i = 0; i < designs.length; i++) {
    const d = designs[i];
    // Scale the design to the full-bleed canvas (trim + bleed on all sides).
    const s = (size.pxW + bleedPx * 2) / d.width;
    const scaled = scaleDesign(d, s);
    // Chart layers need their pre-rendered PNGs in mediaById.
    const mb = { ...mediaById };
    for (const l of scaled.layers || []) {
      if (l.type === 'image' && String(l.image.mediaId || '').startsWith('chart:')) {
        const file = chartFiles[l.image.mediaId.slice(6)];
        if (file) mb[l.image.mediaId] = { filePath: file, kind: 'image' };
      }
    }
    const pngPath = path.join(workDir, `page-${i + 1}.png`);
    await renderDesign({ design: scaled, mediaById: mb, outPath: pngPath });
    const jpegPath = path.join(workDir, `page-${i + 1}.jpg`);
    const { width: iw, height: ih } = await pngToJpeg(pngPath, jpegPath, 2);
    // Crop marks: 12pt lines at each trim corner, pointing outward.
    const tx0 = bleedPt, ty0 = bleedPt, tx1 = bleedPt + size.ptW, ty1 = bleedPt + size.ptH;
    const m = 12;
    const lines = [
      { x1: tx0 - m, y1: ty1, x2: tx0, y2: ty1, color: '#000000', width: 0.5 },
      { x1: tx0, y1: ty1, x2: tx0, y2: ty1 + m, color: '#000000', width: 0.5 },
      { x1: tx1, y1: ty1, x2: tx1 + m, y2: ty1, color: '#000000', width: 0.5 },
      { x1: tx1, y1: ty1, x2: tx1, y2: ty1 + m, color: '#000000', width: 0.5 },
      { x1: tx0 - m, y1: ty0, x2: tx0, y2: ty0, color: '#000000', width: 0.5 },
      { x1: tx0, y1: ty0 - m, x2: tx0, y2: ty0, color: '#000000', width: 0.5 },
      { x1: tx1, y1: ty0, x2: tx1 + m, y2: ty0, color: '#000000', width: 0.5 },
      { x1: tx1, y1: ty0 - m, x2: tx1, y2: ty0, color: '#000000', width: 0.5 },
    ];
    const rects = marginPt > 0 ? [{ x: tx0 + marginPt, y: ty0 + marginPt, w: size.ptW - marginPt * 2, h: size.ptH - marginPt * 2, color: '#7c5cff', width: 0.75 }] : [];
    pages.push({ jpegPath, imgWidth: iw, imgHeight: ih, widthPt: pagePtW, heightPt: pagePtH, vector: { lines, rects } });
  }
  const result = writeImagePdf(pages, outPath);
  return { outPath, pages: result.pages, bytes: result.bytes, sizePt: { w: pagePtW, h: pagePtH }, bleedPt, marginPt, size: size.name };
}

// --- Websites -----------------------------------------------------------------
function slugify(text) {
  const base = String(text || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

function layerToHtml(layer, { assetUrl }) {
  const x = Math.round(layer.x), y = Math.round(layer.y), w = Math.round(layer.w), h = Math.round(layer.h);
  const style = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
  if (layer.type === 'text') {
    const t = layer.text || {};
    const align = t.align || 'left';
    return `<div style="${style}font-family:${escHtml(t.fontFamily || 'Inter')},sans-serif;font-size:${t.fontSize}px;font-weight:${t.fontWeight || 400};color:${escHtml(t.color || '#111827')};text-align:${align};line-height:${t.lineHeight || 1.25};overflow:hidden;">${escHtml(t.text || '').replace(/\n/g, '<br>')}</div>`;
  }
  if (layer.type === 'shape') {
    const s = layer.shape || {};
    const bg = s.fill || 'transparent';
    const border = s.stroke ? `border:${Math.max(1, s.strokeWidth || 1)}px solid ${escHtml(s.stroke)};` : '';
    const radius = s.radius ? `border-radius:${s.radius}px;` : '';
    return `<div style="${style}background:${escHtml(bg)};${border}${radius}"></div>`;
  }
  if (layer.type === 'image') {
    const src = assetUrl(layer);
    if (!src) return '';
    return `<img src="${escHtml(src)}" alt="" style="${style}object-fit:cover;">`;
  }
  return '';
}

function designToHtmlPage(design, { title, assetUrl }) {
  const layers = (design.layers || []).filter((l) => !l.hidden).map((l) => layerToHtml(l, { assetUrl })).join('\n');
  const bg = design.background || { type: 'color', color: '#ffffff' };
  const bgCss = bg.type === 'gradient' && bg.gradient
    ? `background:linear-gradient(${bg.gradient.angle || 135}deg, ${bg.gradient.from}, ${bg.gradient.to});`
    : `background:${bg.type === 'transparent' ? '#ffffff' : (bg.color || '#ffffff')};`;
  return `<div class="page" style="position:relative;width:${design.width}px;height:${design.height}px;${bgCss}">${layers}</div>`;
}

// Build a static website from a design, deck or doc into outDir.
// Returns { files: [relative paths], index: 'index.html' }.
// Images are copied into assets/ and referenced relatively — the folder is
// a complete shareable site (open index.html anywhere).
function buildWebsite({ kind, title, design, deck, doc, mediaById = {}, chartFiles = {}, outDir }) {
  if (!['design', 'deck', 'doc'].includes(kind)) throw new Error(`Website source must be design, deck or doc (got "${kind}").`);
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  const assets = [];
  const assetUrl = (layer) => {
    const mediaId = layer.type === 'image' ? layer.image.mediaId : null;
    if (!mediaId) return null;
    let file = null;
    if (String(mediaId).startsWith('chart:')) file = chartFiles[String(mediaId).slice(6)];
    else if (mediaById[mediaId]) file = mediaById[mediaId].filePath;
    if (!file || !fs.existsSync(file)) return null;
    const ext = path.extname(file).toLowerCase() || '.png';
    const name = `assets/${String(mediaId).replace(/[^a-zA-Z0-9_-]/g, '_')}${ext}`;
    fs.copyFileSync(file, path.join(outDir, name));
    assets.push(name);
    return name;
  };
  let body = '';
  let extraCss = '';
  // C-19: published design/deck pages are fixed-size (e.g. 1920×1080) —
  // without scaling they overflow any narrower viewport (a phone shows a
  // horizontal scrollbar and a cut-off page). The fitter below scales each
  // .page to the viewport width and reserves its scaled height, so the
  // page always fits and the content below sits right under it.
  const fitScript = `<script>
(function(){
function fitPages(){
  document.querySelectorAll('.page').forEach(function(p){
    var w=p.offsetWidth,h=p.offsetHeight;
    if(!w||!h)return;
    var s=Math.min(1,(window.innerWidth-48)/w);
    p.style.transformOrigin='top center';
    p.style.transform='scale('+s+')';
    if(p.parentElement) p.parentElement.style.height=Math.round(h*s)+'px';
  });
}
window.__fitPages=fitPages;
window.addEventListener('resize',fitPages);
window.addEventListener('load',fitPages);
fitPages();
})();
</script>`;
  if (kind === 'design') {
    body = `<div class="page-wrap">${designToHtmlPage(design, { title, assetUrl })}</div>${fitScript}`;
    extraCss = '.page{margin:0 auto;box-shadow:0 10px 40px rgba(0,0,0,.15)}';
  } else if (kind === 'deck') {
    const slides = deckToDesigns(deck).map((d) => designToHtmlPage(d, { title, assetUrl }));
    body = `<div class="deck">${slides.map((s, i) => `<section class="slide" data-slide="${i}" style="display:${i === 0 ? 'block' : 'none'}">${s}</section>`).join('\n')}</div>
<div class="deck-nav"><button id="deck-prev" type="button">← Previous</button><span id="deck-pos">1 / ${slides.length}</span><button id="deck-next" type="button">Next →</button><button id="deck-present" type="button">⛶ Present</button></div>
${fitScript}
<script>
(function(){var slides=[].slice.call(document.querySelectorAll('.slide'));var i=0;var pos=document.getElementById('deck-pos');
function show(n){i=Math.max(0,Math.min(slides.length-1,n));slides.forEach(function(s,j){s.style.display=j===i?'block':'none';});pos.textContent=(i+1)+' / '+slides.length;if(window.__fitPages)window.__fitPages();}
document.getElementById('deck-prev').onclick=function(){show(i-1);};
document.getElementById('deck-next').onclick=function(){show(i+1);};
document.getElementById('deck-present').onclick=function(){if(document.documentElement.requestFullscreen)document.documentElement.requestFullscreen();};
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight')show(i+1);if(e.key==='ArrowLeft')show(i-1);});
})();
</script>`;
    extraCss = '.deck .page{margin:0 auto;box-shadow:0 10px 40px rgba(0,0,0,.15)}.deck-nav{display:flex;gap:12px;align-items:center;justify-content:center;margin:20px 0}.deck-nav button{padding:10px 18px;border-radius:8px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-size:15px}';
  } else {
    // doc: reuse the semantic HTML (images resolved to local assets).
    const docHtml = docToHtml({ ...doc, blocks: doc.blocks.map((b) => {
      if (b.type !== 'image') return b;
      const m = mediaById[b.mediaId];
      if (!m || !fs.existsSync(m.filePath)) return b;
      const ext = path.extname(m.filePath).toLowerCase() || '.png';
      const name = `assets/doc-img-${b.id}${ext}`;
      fs.copyFileSync(m.filePath, path.join(outDir, name));
      assets.push(name);
      return { ...b, imageUrl: name };
    }) }, { fullPage: false });
    body = `<article class="doc">${docHtml}</article>`;
    extraCss = '.doc{max-width:800px;margin:0 auto;background:#fff;padding:40px 32px;box-shadow:0 10px 40px rgba(0,0,0,.1)}.doc h1{font-size:32px}.doc h2{font-size:26px}.doc h3{font-size:21px}.doc table{border-collapse:collapse;width:100%}.doc th,.doc td{border:1px solid #d1d5db;padding:8px 10px;text-align:left}.doc th{background:#f3f4f6}.doc blockquote{border-left:4px solid #7c5cff;margin:14px 0;padding:4px 16px;color:#374151}.doc img{max-width:100%}.doc figure{text-align:center}';
  }
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escHtml(title)}</title>
<style>body{margin:0;font-family:Inter,Arial,sans-serif;background:#f3f4f6;color:#111827;line-height:1.6;padding:24px}header{text-align:center;margin-bottom:20px}header h1{font-size:22px;margin:0}header p{color:#6b7280;margin:4px 0 0}${extraCss}</style></head>
<body><header><h1>${escHtml(title)}</h1><p>Published with CreativeStudio AI Pro</p></header>${body}</body></html>`;
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  return { files: ['index.html', ...assets], index: 'index.html' };
}

// --- Deck image export + video job --------------------------------------------
// Render every slide of a deck to a PNG (chart layers pre-rendered by the
// caller into chartFiles: {layerId: pngPath}). Returns [{slideId, pngPath,
// width, height, warnings}].
async function renderDeckImages(deck, { workDir, chartFiles = {}, mediaById = {} } = {}) {
  const v = validateDeck(deck);
  if (!v.ok) throw new Error('Invalid deck: ' + v.errors.join(' '));
  fs.mkdirSync(workDir, { recursive: true });
  const designs = deckToDesigns(deck);
  const out = [];
  for (let i = 0; i < designs.length; i++) {
    const mb = { ...mediaById };
    for (const l of designs[i].layers || []) {
      if (l.type === 'image' && String(l.image.mediaId || '').startsWith('chart:')) {
        const file = chartFiles[l.image.mediaId.slice(6)];
        if (file) mb[l.image.mediaId] = { filePath: file, kind: 'image' };
      }
    }
    const pngPath = path.join(workDir, `slide-${i + 1}.png`);
    const res = await renderDesign({ design: designs[i], mediaById: mb, outPath: pngPath });
    out.push({ slideId: deck.slides[i].id, pngPath, width: res.width, height: res.height, warnings: res.warnings });
  }
  return out;
}

// Render a deck to MP4 (slideshow: each slide holds for secondsPerSlide).
// Runs inside the render queue via src/render.js processJob (payload.deck).
async function processDeckJob(job, payload, { dir, logPath }) {
  const db = require('./db');
  const deck = payload.deck;
  const userId = job.user_id;
  const secondsPerSlide = Math.max(1, Math.min(60, Number(payload.secondsPerSlide) || 5));
  const fps = [24, 25, 30].includes(Number(payload.fps)) ? Number(payload.fps) : 30;
  const outPath = path.join(dir, `${job.id}.mp4`);
  const tmpDir = path.join(dir, `tmp-deck-${job.id}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(logPath, `Deck render job ${job.id} started ${new Date().toISOString()}\n`);
  db.updateJob(job.id, { output_path: outPath, log_path: logPath });
  // Pre-render chart layers to PNGs.
  const chartFiles = {};
  for (const s of deck.slides || []) {
    for (const el of s.elements || []) {
      if (el.type === 'chart' && el.chart) {
        const pngPath = path.join(tmpDir, `chart-${el.id}.png`);
        await renderChartPng(el.chart, pngPath, { width: Math.min(1200, Math.max(320, el.w || 960)), height: Math.min(700, Math.max(200, el.h || 540)) });
        chartFiles[el.id] = pngPath;
      }
    }
  }
  const mediaById = {};
  for (const s of deck.slides || []) {
    for (const el of s.elements || []) {
      if (el.type === 'image' && el.image && el.image.mediaId && !String(el.image.mediaId).startsWith('chart:')) {
        const row = db.getMedia(userId, el.image.mediaId);
        if (!row) throw new Error(`Media file #${el.image.mediaId} is missing (it may have been deleted).`);
        const config = require('./config');
        const filePath = path.join(config.uploadsDir, String(userId), row.stored_name);
        if (!fs.existsSync(filePath)) throw new Error(`Media file "${row.original_name}" is missing on disk.`);
        mediaById[el.image.mediaId] = { filePath, kind: row.kind };
      }
    }
  }
  const slides = await renderDeckImages(deck, { workDir: tmpDir, chartFiles, mediaById });
  const warnings = slides.flatMap((s) => s.warnings || []);
  // Per-slide "-loop 1 -t <secondsPerSlide>" inputs joined by the concat
  // filter: each slide is exactly secondsPerSlide long. (The concat
  // demuxer recipe — durations + a repeated last file — adds a phantom
  // extra slide-length to the output, so it is not used here.)
  const totalDuration = slides.length * secondsPerSlide;
  const args = ['-y', '-v', 'error'];
  for (const s of slides) args.push('-loop', '1', '-t', String(secondsPerSlide), '-i', s.pngPath);
  const inputs = slides.map((_, i) => `[${i}:v]`).join('');
  args.push('-filter_complex', `${inputs}concat=n=${slides.length}:v=1:a=0,fps=${fps},format=yuv420p[vout]`,
    '-map', '[vout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-movflags', '+faststart', outPath);
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('error', (err) => reject(new Error(`Could not start FFmpeg: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Deck video render failed (code ${code}): ${errText.slice(-800)}`))));
  });
  const info = await probeMedia(outPath);
  if (!info || info.width !== deck.width || info.height !== deck.height) {
    throw new Error(`Deck video validation failed: expected ${deck.width}x${deck.height}, got ${info ? `${info.width}x${info.height}` : 'no output'}.`);
  }
  if (Math.abs((info.durationSeconds || 0) - totalDuration) > 1.5) {
    warnings.push(`Video duration is ${(info.durationSeconds || 0).toFixed(1)}s, expected ${totalDuration}s.`);
  }
  fs.appendFileSync(logPath, `Rendered deck video ${info.width}x${info.height}, ${totalDuration}s\n`);
  return { outPath, warnings, width: info.width, height: info.height, duration: totalDuration };
}

module.exports = {
  DECK_LAYOUTS, DOC_BLOCK_TYPES,
  blankSlide, blankDeck, validateDeck, addSlide, moveSlide, duplicateSlide, deleteSlide,
  slideFitCheck, deckFitCheck, applyDeckUniformFonts, slideToDesign, deckToDesigns,
  textLayer, shapeLayer,
  blankDoc, validateDoc, docToHtml, docToDocx, docToDesignPages,
  PRINT_SIZES, scaleDesign, designsToPrintPdf, buildWebsite, renderDeckImages, processDeckJob,
  slugify,
};

