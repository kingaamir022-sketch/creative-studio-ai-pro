'use strict';
// Bulk model — pure functions for Phase 4 (Bulk Design + Bulk Video).
// No I/O here: parsing, media resolution and rendering live in the routes,
// bulk.js and design-render.js. Everything in this file is unit-testable.
//
// Data model:
//   dataset = { columns: ['PRODUCT_NAME', 'PRICE', ...],
//               rows: [ { PRODUCT_NAME: 'Shoes', PRICE: '2500', ... }, ... ] }
//   fieldMapping = { FIELD_NAME: 'COLUMN_NAME' }  (template field -> dataset column)
//   background assignment = { rowIndex, mediaId, source, warning }

const { fitText, fitAtFont } = require('./quiz-model');

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_ ]+?)\s*\}\}/g;

function normField(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '_');
}

function extractPlaceholders(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    const f = normField(m[1]);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

// Scan a video timeline for dynamic fields.
// Returns { fields: [{name, kind:'text'|'media', clipId, trackKind}],
//           textClips, mediaClips, backgroundClipId }
function scanVideoTemplate(timeline) {
  const fields = [];
  const textClips = [];
  const mediaClips = [];
  let backgroundClipId = null;
  const push = (name, kind, clipId, trackKind) => {
    const n = normField(name);
    if (!n) return;
    if (!fields.some((f) => f.name === n)) fields.push({ name: n, kind, clipId, trackKind });
  };
  for (const tr of timeline.tracks || []) {
    for (const c of tr.clips || []) {
      if (c.isBackground && !backgroundClipId) backgroundClipId = c.id;
      if (c.kind === 'text' && c.text && typeof c.text.text === 'string') {
        const found = extractPlaceholders(c.text.text);
        // Font + fit box feed the batch uniform-font computation (rule D).
        textClips.push({ clipId: c.id, trackKind: tr.kind, text: c.text.text, fields: found, fontSize: c.text.fontSize || 48, fitBox: c.fitBox || null });
        found.forEach((f) => push(f, 'text', c.id, tr.kind));
      }
      if (c.dynamicMediaField) {
        mediaClips.push({ clipId: c.id, trackKind: tr.kind, kind: c.kind, field: normField(c.dynamicMediaField) });
        push(c.dynamicMediaField, 'media', c.id, tr.kind);
      }
    }
  }
  if (!backgroundClipId) {
    // Default background clip: the first video clip on the first video track.
    const vt = (timeline.tracks || []).find((t) => t.kind === 'video');
    const first = vt && vt.clips && vt.clips[0];
    if (first) backgroundClipId = first.id;
  }
  return { fields, textClips, mediaClips, backgroundClipId };
}

// Scan a graphic design for dynamic fields (text layers + bound image layers).
function scanDesignTemplate(design) {
  const fields = [];
  const textLayers = [];
  const imageLayers = [];
  const push = (name, kind, layerId) => {
    const n = normField(name);
    if (!n) return;
    if (!fields.some((f) => f.name === n)) fields.push({ name: n, kind, layerId });
  };
  for (const l of design.layers || []) {
    if (l.type === 'text' && l.text && typeof l.text.text === 'string') {
      const found = extractPlaceholders(l.text.text);
      textLayers.push({ layerId: l.id, text: l.text.text, fields: found });
      found.forEach((f) => push(f, 'text', l.id));
    }
    if (l.type === 'image' && l.image && l.image.dynamicField) {
      imageLayers.push({ layerId: l.id, field: normField(l.image.dynamicField) });
      push(l.image.dynamicField, 'media', l.id);
    }
  }
  return { fields, textLayers, imageLayers };
}

// Substitute {{FIELD}} placeholders in a string using a row + mapping.
// mapping: { FIELD: 'COLUMN' }. When a field has NO mapping entry, the
// same-name dataset column is used (C-01: the default mapping is empty,
// so skipping the mapping step used to blank every value silently).
// Returns { text, missing: [FIELD] }.
function substituteText(text, row, mapping) {
  const missing = [];
  if (typeof text !== 'string') return { text: text || '', missing };
  const out = text.replace(PLACEHOLDER_RE, (whole, name) => {
    const field = normField(name);
    let col = mapping && mapping[field];
    if (col === undefined && row) {
      // Same-name fallback: a dataset column whose normalised name
      // matches the field (case/space-insensitive).
      const sameName = Object.keys(row).find((k) => normField(k) === field);
      if (sameName !== undefined) col = sameName;
    }
    const val = col !== undefined && row ? row[col] : undefined;
    if (val === undefined || val === null || String(val) === '') {
      if (!missing.includes(field)) missing.push(field);
      return '';
    }
    return String(val);
  });
  return { text: out, missing };
}

// Build one row's timeline from a template timeline.
// opts: { row, fieldMapping, resolvedMedia: { FIELD: { mediaId, kind } },
//         background: { mediaId, kind } | null, backgroundClipId,
//         backgroundMuted (default true), brandLogoMediaId }
// Returns { timeline, warnings: [], missing: [] }.
function buildRowTimeline(template, row, opts = {}) {
  const tl = JSON.parse(JSON.stringify(template));
  const mapping = opts.fieldMapping || {};
  const warnings = [];
  const missing = [];
  const resolved = opts.resolvedMedia || {};
  // Batch uniform fonts (rule D): { FIELD: fontSizeClipUnits }. Text clips
  // bound to a field use that font — never their own per-row size.
  const uniformFonts = opts.uniformFonts || {};
  const fitElements = [];
  const W = tl.width || 1080;
  const H = tl.height || 1080;
  for (const tr of tl.tracks || []) {
    for (const c of tr.clips || []) {
      if (c.kind === 'text' && c.text && typeof c.text.text === 'string') {
        const fields = extractPlaceholders(c.text.text);
        const r = substituteText(c.text.text, row, mapping);
        c.text.text = r.text;
        r.missing.forEach((f) => { if (!missing.includes(f)) missing.push(f); });
        // --- Overflow-proof fit (rule C) + uniform font (rule D) ---
        // Box: the clip's own fitBox, else 90% of frame width, max 3 lines,
        // readable minimum 22px render (clip units: 22 * 1080 / W).
        const fb = c.fitBox || {};
        const maxW = ((fb.maxWidthPct ?? 90) / 100) * W;
        const maxLines = fb.maxLines ?? 3;
        const minFontRender = fb.minFontRender ?? 22;
        const minFont = Math.max(8, Math.round(minFontRender * (1080 / W)));
        const baseFont = c.text.fontSize || 48;
        // Uniform font: if this clip is bound to a batch-font field, use the
        // smallest such font (one size per set).
        let font = baseFont;
        const boundFonts = fields.map((f) => uniformFonts[f]).filter((x) => typeof x === 'number');
        if (boundFonts.length) font = Math.min(...boundFonts);
        let fit;
        if (boundFonts.length) {
          // Uniform font (rule D): the batch font IS the rendered size —
          // never shrunk per row. Wrap at that fixed font; if the text
          // cannot fit even with extended lines, flag the row "Needs
          // attention" (with a shorter-text suggestion) instead of
          // shrinking this row or dragging the whole batch down.
          const at = fitAtFont(c.text.text, maxW, font, { maxLines, extendedLines: maxLines * 2, lineHeight: 1.25 });
          let suggestedText = null;
          if (at.status === 'attention') {
            const probe = fitText(c.text.text, maxW, { maxFont: minFont, minFont, maxLines, lineHeight: 1.25 });
            suggestedText = probe.suggestedText || null;
          }
          fit = { fontSize: font, lines: at.lines, status: at.status, suggestedText, heightPx: at.heightPx };
        } else {
          fit = fitText(c.text.text, maxW, { maxFont: font, minFont, maxLines, lineHeight: 1.25 });
        }
        const status = fit.status === 'attention' ? 'attention' : fit.status === 'adjusted' ? 'adjusted' : 'ok';
        if (font !== baseFont || status !== 'ok') {
          c.text.fontSize = fit.fontSize;
        }
        // Wrap the text into the fitted lines (render draws \n verbatim).
        if (fit.lines && fit.lines.length) c.text.text = fit.lines.join('\n');
        fitElements.push({
          clipId: c.id, name: c.name || c.id, fields,
          status, from: baseFont, to: fit.fontSize, lines: fit.lines.length,
          suggestedText: fit.suggestedText || null,
        });
        if (status === 'attention') {
          warnings.push(`Text in clip "${c.name || c.id}" needs attention — suggested shorter text: "${(fit.suggestedText || '').slice(0, 80)}".`);
        }
      }
      if (c.dynamicMediaField) {
        const field = normField(c.dynamicMediaField);
        const res = resolved[field];
        if (res && res.mediaId) {
          c.mediaId = res.mediaId;
          // A resolved image on a video track renders as a looped still
          // (render.js handles image media on video tracks).
        } else {
          // Same-name column fallback (C-01), same as substituteText.
          let col = mapping[field];
          if (col === undefined && row) {
            const sameName = Object.keys(row).find((k) => normField(k) === field);
            if (sameName !== undefined) col = sameName;
          }
          const val = col !== undefined && row ? row[col] : undefined;
          if (val === undefined || val === null || String(val) === '') {
            // Empty value: keep the template's default media, warn.
            warnings.push(`Row has no value for ${field}; kept the template's media for clip "${c.name}".`);
          } else {
            warnings.push(`Could not resolve ${field} ("${String(val).slice(0, 60)}") to a media file; kept the template's media for clip "${c.name}".`);
          }
        }
      }
      // Background assignment: replace the background clip's media.
      if (opts.background && c.id === opts.backgroundClipId) {
        c.mediaId = opts.background.mediaId;
        c.scaleMode = 'fill';
        c.srcStart = 0;
        if (opts.background.kind === 'video') c.loop = true; // loop short backgrounds to fill the clip
        if (opts.backgroundMuted !== false) { c.muted = true; c.volume = 0; }
        if (c.keyframes && c.keyframes.length) c.keyframes = []; // a background is a still frame, not a pan
      }
    }
  }
  // Fit report for this row (rule C + D): every substituted text element,
  // its status, and the font it rendered at.
  const attention = fitElements.filter((e) => e.status === 'attention').length;
  const adjusted = fitElements.filter((e) => e.status === 'adjusted').length;
  const fitReport = {
    overall: attention ? 'Needs attention' : adjusted ? 'Adjusted' : 'OK',
    elements: fitElements,
    outlier: attention > 0,
    suggestedText: (fitElements.find((e) => e.status === 'attention') || {}).suggestedText || null,
    safeZoneOk: true,
  };
  return { timeline: tl, warnings, missing, fitReport };
}

// Substitute fields in a graphic design for one row.
// bindings: [{ layerId, column, kind: 'text'|'image' }] for direct column
// binding, plus {{FIELD}} substitution in text layers via fieldMapping.
// resolvedImages: { layerId: { mediaId, src } } for bound image layers.
// Returns { design, warnings: [], missing: [] }.
function substituteDesign(template, row, opts = {}) {
  const d = JSON.parse(JSON.stringify(template));
  const mapping = opts.fieldMapping || {};
  const warnings = [];
  const missing = [];
  const bindings = opts.bindings || [];
  const resolvedImages = opts.resolvedImages || {};
  const fitElements = [];
  for (const l of d.layers || []) {
    if (l.type === 'text' && l.text && typeof l.text.text === 'string') {
      const binding = bindings.find((b) => b.layerId === l.id && b.kind === 'text');
      if (binding && binding.column && row && row[binding.column] !== undefined && String(row[binding.column]) !== '') {
        l.text.text = String(row[binding.column]);
      } else {
        const r = substituteText(l.text.text, row, mapping);
        l.text.text = r.text;
        r.missing.forEach((f) => { if (!missing.includes(f)) missing.push(f); });
      }
      // Overflow-proof fit for designs (single-line shrink): a substituted
      // value wider than its layer shrinks until it fits or the 12px floor.
      const layerW = l.w || 200;
      const baseFont = l.text.fontSize || 24;
      const fit = fitText(l.text.text, layerW * 0.95, { maxFont: baseFont, minFont: 12, maxLines: 1 });
      if (fit.fontSize < baseFont) l.text.fontSize = fit.fontSize;
      fitElements.push({ layerId: l.id, name: l.name || l.id, status: fit.status === 'attention' ? 'attention' : fit.status === 'adjusted' ? 'adjusted' : 'ok', from: baseFont, to: fit.fontSize, suggestedText: fit.suggestedText || null });
      if (fit.status === 'attention') {
        warnings.push(`Text in layer "${l.name || l.id}" needs attention — suggested shorter text: "${(fit.suggestedText || '').slice(0, 80)}".`);
      }
    }
    if (l.type === 'image' && l.image) {
      const binding = bindings.find((b) => b.layerId === l.id && b.kind === 'image');
      const res = resolvedImages[l.id];
      if (res && res.mediaId) {
        l.image.mediaId = res.mediaId;
        l.image.src = res.src;
      } else if (binding && binding.column && row && row[binding.column] !== undefined && String(row[binding.column]) !== '') {
        warnings.push(`Could not resolve the image for layer "${l.name}" from column "${binding.column}"; kept the template image.`);
      } else if (l.image.dynamicField) {
        const r = substituteText(`{{${l.image.dynamicField}}}`, row, mapping);
        if (r.missing.length) warnings.push(`No value for ${normField(l.image.dynamicField)}; kept the template image for layer "${l.name}".`);
      }
    }
  }
  const attention = fitElements.filter((e) => e.status === 'attention').length;
  const adjusted = fitElements.filter((e) => e.status === 'adjusted').length;
  const fitReport = {
    overall: attention ? 'Needs attention' : adjusted ? 'Adjusted' : 'OK',
    elements: fitElements,
    outlier: attention > 0,
    suggestedText: (fitElements.find((e) => e.status === 'attention') || {}).suggestedText || null,
    safeZoneOk: true,
  };
  return { design: d, warnings, missing, fitReport };
}

// --- Background assignment -------------------------------------------------
// rows: [{...}] (dataset rows, in order)
// opts: { mode: 'random'|'category'|'pool'|'column'|'manual'|'ai'|'prompt',
//         pool: [{id, kind}], categoryColumn, categoryMap: {category: [mediaIds]},
//         columnMediaIds: {rowIndex: mediaId} (mode 'column', pre-resolved),
//         manual: {rowIndex: mediaId}, repeatRule: 'no-repeat'|'after-n'|'random',
//         repeatAfterN }
// Returns [{ rowIndex, mediaId, source, warning }] — one entry per row.
// Throws an Error with a clear message when assignment is impossible.
function assignBackgrounds(rows, opts = {}) {
  const mode = opts.mode || 'random';
  const pool = (opts.pool || []).map((m) => (typeof m === 'object' ? m.id : m)).filter((x) => Number.isInteger(x));
  const out = [];
  if (mode === 'ai' || mode === 'prompt') {
    throw new Error('AI background generation is not implemented yet — it arrives in Phase 7 (AI Creative Studio). Add an image provider key in Settings → AI Providers first; until Phase 7 this mode cannot start a batch. Use Random, Category or Uploaded Pool instead.');
  }
  if (mode === 'manual') {
    for (let i = 0; i < rows.length; i++) {
      const id = opts.manual && opts.manual[i];
      if (!id) throw new Error(`Manual background assignment is missing for row ${i + 1}. Assign a background to every row, or switch to No repetition / Random.`);
      out.push({ rowIndex: i, mediaId: id, source: 'manual', warning: null });
    }
    return out;
  }
  if (mode === 'column') {
    for (let i = 0; i < rows.length; i++) {
      const id = opts.columnMediaIds && opts.columnMediaIds[i];
      if (!id) throw new Error(`Row ${i + 1} has no background media in its background column. Fill the column or pick a different background mode.`);
      out.push({ rowIndex: i, mediaId: id, source: 'column', warning: null });
    }
    return out;
  }
  if (mode === 'category') {
    const catCol = opts.categoryColumn;
    if (!catCol) throw new Error('Category mode needs a category column. Pick the column that holds the product category.');
    const catMap = opts.categoryMap || {};
    const cycles = {}; // category -> { order: [ids], pos }
    for (let i = 0; i < rows.length; i++) {
      const cat = String(rows[i][catCol] ?? '').trim();
      let ids = catMap[cat];
      let source = 'category';
      let warning = null;
      if (!ids || !ids.length) {
        if (pool.length) { ids = pool; source = 'category-fallback'; warning = `No background pool for category "${cat || '(empty)'}"; used the default pool.`; }
        else throw new Error(`No background pool for category "${cat || '(empty)'}" (row ${i + 1}) and no default pool is set. Add a pool for this category or set a default pool.`);
      }
      if (!cycles[cat]) cycles[cat] = { order: shuffled(ids), pos: 0 };
      const cyc = cycles[cat];
      if (cyc.pos >= cyc.order.length) { cyc.order = shuffled(ids); cyc.pos = 0; warning = (warning ? warning + ' ' : '') + `Category "${cat}" pool reused — ${ids.length} background(s) for more rows.`; }
      out.push({ rowIndex: i, mediaId: cyc.order[cyc.pos], source, warning });
      cyc.pos += 1;
    }
    return out;
  }
  // Modes 'random' and 'pool' (uploaded pool): same engine, different label.
  if (!pool.length) {
    throw new Error('No backgrounds selected. Pick at least one image or video from the Media Library as the background pool.');
  }
  const rule = opts.repeatRule || 'no-repeat';
  if (rule === 'random') {
    for (let i = 0; i < rows.length; i++) {
      out.push({ rowIndex: i, mediaId: pool[Math.floor(Math.random() * pool.length)], source: mode === 'pool' ? 'pool-random' : 'random', warning: null });
    }
    return out;
  }
  if (rule === 'after-n') {
    const n = Math.max(1, parseInt(opts.repeatAfterN || '5', 10));
    const recent = [];
    for (let i = 0; i < rows.length; i++) {
      const allowed = pool.filter((id) => !recent.includes(id));
      const pickFrom = allowed.length ? allowed : pool;
      const id = pickFrom[Math.floor(Math.random() * pickFrom.length)];
      out.push({ rowIndex: i, mediaId: id, source: mode === 'pool' ? 'pool' : 'random', warning: allowed.length ? null : `Pool smaller than the repeat window (${n}); a background repeated sooner.` });
      recent.push(id);
      while (recent.length > n) recent.shift();
    }
    return out;
  }
  // Default: no-repeat — shuffled cycle, reshuffled each pass.
  let order = shuffled(pool);
  let pos = 0;
  for (let i = 0; i < rows.length; i++) {
    if (pos >= order.length) {
      order = shuffled(pool);
      pos = 0;
      if (rows.length > pool.length) {
        out.push({ rowIndex: i, mediaId: order[pos], source: mode === 'pool' ? 'pool' : 'random', warning: `Background pool of ${pool.length} reused — ${rows.length} rows need more backgrounds than the pool holds.` });
        pos += 1;
        continue;
      }
    }
    out.push({ rowIndex: i, mediaId: order[pos], source: mode === 'pool' ? 'pool' : 'random', warning: null });
    pos += 1;
  }
  return out;
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Dataset validation ----------------------------------------------------
function validateDataset(columns, rows) {
  const errors = [];
  const rowIssues = [];
  if (!Array.isArray(columns) || !columns.length) errors.push('No columns were detected. Check the file has a header row.');
  if (!Array.isArray(rows) || !rows.length) errors.push('No data rows were found.');
  const seen = new Map();
  rows.forEach((row, i) => {
    const missing = columns.filter((c) => row[c] === undefined || row[c] === null || String(row[c]).trim() === '');
    const key = columns.map((c) => String(row[c] ?? '')).join('␟');
    const dupOf = seen.has(key) ? seen.get(key) : null;
    if (!dupOf) seen.set(key, i + 1);
    if (missing.length || dupOf) rowIssues.push({ rowIndex: i, rowNumber: i + 1, missing, duplicateOf: dupOf });
  });
  return { errors, rowIssues };
}

function sanitizeFileName(s, fallback = 'output') {
  const clean = String(s || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^\.+/, '').slice(0, 80);
  return clean || fallback;
}

// --- Duplicate skip (user rule, Phase 4) -----------------------------------
// A row is a duplicate when its normalised content matches an earlier row:
// trim + case-insensitive compare, empty == empty, internal whitespace
// collapsed. Default key = the whole row over the given columns (the mapped
// columns when a field mapping exists, otherwise every dataset column).
// With mode 'key', only the chosen key column is compared.
// Returns { unique: [rowIndex, ...],
//           skipped: [{ rowIndex, rowNumber, duplicateOfIndex, duplicateOfRowNumber }] }.
function normCell(v) {
  return String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function dedupeRows(rows, opts = {}) {
  const mode = opts.mode === 'key' ? 'key' : 'whole-row';
  const columns = Array.isArray(opts.columns) && opts.columns.length
    ? opts.columns
    : Object.keys(rows[0] || {});
  const seen = new Map();
  const unique = [];
  const skipped = [];
  rows.forEach((row, i) => {
    let key;
    if (mode === 'key') {
      if (!opts.keyColumn) throw new Error('Key-column dedupe needs a key column. Pick a column (e.g. PRODUCT_NAME).');
      key = normCell(row[opts.keyColumn]);
    } else {
      key = columns.map((c) => normCell(row[c])).join('␟');
    }
    if (seen.has(key)) {
      skipped.push({
        rowIndex: i, rowNumber: i + 1,
        duplicateOfIndex: seen.get(key), duplicateOfRowNumber: seen.get(key) + 1,
      });
    } else {
      seen.set(key, i);
      unique.push(i);
    }
  });
  return { unique, skipped };
}

// Columns the whole-row dedupe compares: the mapped columns when a field
// mapping exists (the template's mapped fields), otherwise all columns.
function dedupeColumns(columns, fieldMapping) {
  if (!fieldMapping) return columns;
  const mapped = [...new Set(Object.values(fieldMapping).filter(Boolean))];
  return mapped.length ? mapped.filter((c) => columns.includes(c)) : columns;
}

function outputFileName(nameTemplate, row, mapping, rowIndex, ext) {
  let name = nameTemplate || `row-${rowIndex + 1}`;
  const { text } = substituteText(name, row, mapping || {});
  return `${sanitizeFileName(text, `row-${rowIndex + 1}`)}.${ext}`;
}

module.exports = {
  normField, extractPlaceholders,
  scanVideoTemplate, scanDesignTemplate,
  substituteText, substituteDesign, buildRowTimeline,
  assignBackgrounds, validateDataset, sanitizeFileName, outputFileName,
  dedupeRows, dedupeColumns,
};
