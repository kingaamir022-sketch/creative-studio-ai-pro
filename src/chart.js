'use strict';
// Charts (v2.2.3, Docs & Slides) — bar / line / pie / doughnut.
// Pure model + rendering: SVG (for embedding in docs/websites) and PNG
// (a pure-JS rasterizer for the plot + one FFmpeg pass for the text labels,
// so the PNG carries real text with the project's own fonts — the same
// DejaVu files the design renderer uses).
//
// Standing rules: duplicate rows are PERMANENTLY skipped (normalized full
// row, trim + case-insensitive) — a pasted CSV with the same row twice
// produces one series entry and a skipped count, never a doubled chart.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { fontFor } = require('./render');

const CHART_TYPES = ['bar', 'line', 'pie', 'doughnut'];
const PALETTE = ['#7c5cff', '#3b82f6', '#16a34a', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4', '#8b5cf6'];
const MAX_LABELS = 60;
const MAX_DATASETS = 8;

function isHexColor(v) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v); }
function num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function validateChart(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['Chart must be a JSON object.'] };
  if (!CHART_TYPES.includes(spec.type)) errors.push(`Chart type must be one of: ${CHART_TYPES.join(', ')}.`);
  if (spec.title !== undefined && (typeof spec.title !== 'string' || spec.title.length > 120)) errors.push('Chart title must be a string (max 120 characters).');
  if (!Array.isArray(spec.labels) || !spec.labels.length) errors.push('Chart labels must be a non-empty array.');
  else {
    if (spec.labels.length > MAX_LABELS) errors.push(`A chart may have at most ${MAX_LABELS} labels.`);
    spec.labels.forEach((l, i) => { if (typeof l !== 'string' || !l.trim()) errors.push(`Label ${i + 1} must be a non-empty string.`); });
  }
  if (!Array.isArray(spec.datasets) || !spec.datasets.length) errors.push('Chart datasets must be a non-empty array.');
  else {
    if (spec.datasets.length > MAX_DATASETS) errors.push(`A chart may have at most ${MAX_DATASETS} datasets.`);
    spec.datasets.forEach((d, i) => {
      const where = `Dataset ${i + 1}`;
      if (!d || typeof d !== 'object') { errors.push(`${where}: must be an object.`); return; }
      if (typeof d.label !== 'string' || !d.label.trim()) errors.push(`${where}: label is required.`);
      if (d.color !== undefined && d.color !== '' && !isHexColor(d.color)) errors.push(`${where}: color must be a #rrggbb hex color.`);
      if (!Array.isArray(d.values)) errors.push(`${where}: values must be an array of numbers.`);
      else {
        if (spec.labels && d.values.length !== spec.labels.length) errors.push(`${where}: values must have one number per label (${spec.labels.length}).`);
        d.values.forEach((v, j) => { if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${where}: value ${j + 1} must be a finite number.`); });
      }
    });
  }
  if ((spec.type === 'pie' || spec.type === 'doughnut') && Array.isArray(spec.datasets) && spec.datasets.length > 1) {
    errors.push('Pie and doughnut charts take exactly one dataset.');
  }
  if ((spec.type === 'pie' || spec.type === 'doughnut') && Array.isArray(spec.datasets) && spec.datasets[0] && Array.isArray(spec.datasets[0].values)) {
    const total = spec.datasets[0].values.reduce((a, b) => a + Math.max(0, b), 0);
    if (total <= 0) errors.push('Pie and doughnut charts need at least one value above zero.');
  }
  if (spec.showValues !== undefined && typeof spec.showValues !== 'boolean') errors.push('showValues must be true/false.');
  if (spec.legend !== undefined && typeof spec.legend !== 'boolean') errors.push('legend must be true/false.');
  return { ok: errors.length === 0, errors };
}

function normalizeChart(spec) {
  const out = JSON.parse(JSON.stringify(spec));
  out.type = spec.type;
  out.title = String(spec.title || '').trim();
  out.labels = spec.labels.map((l) => String(l).trim());
  out.datasets = spec.datasets.map((d, i) => ({
    label: String(d.label).trim(),
    values: d.values.map((v) => Number(v)),
    color: d.color && isHexColor(d.color) ? d.color : PALETTE[i % PALETTE.length],
  }));
  out.showValues = spec.showValues !== false;
  out.legend = spec.legend !== false;
  return out;
}

// --- CSV / table parsing (with the standing duplicate-skip rule) ------------
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

// CSV shape: first row = header (first cell = label column name, rest =
// series names); each following row = label + one number per series.
// Identical rows (label + every value, normalized) are skipped permanently.
function parseCsvTable(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Paste CSV data first (header row + one row per label).');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row.');
  const header = parseCsvLine(lines[0]);
  if (header.length < 2) throw new Error('CSV needs at least two columns: a label column and one series column.');
  const seriesNames = header.slice(1);
  for (const s of seriesNames) if (!s) throw new Error('Every series column needs a name in the header row.');
  const labels = [];
  const columns = seriesNames.map(() => []);
  const seen = new Set();
  let skipped = 0;
  const skippedRows = [];
  lines.slice(1).forEach((line, idx) => {
    const cells = parseCsvLine(line);
    if (cells.length < header.length) throw new Error(`Row ${idx + 2}: expected ${header.length} columns, got ${cells.length}.`);
    const label = cells[0];
    if (!label) throw new Error(`Row ${idx + 2}: the label (first column) is empty.`);
    const values = cells.slice(1, header.length).map((c, j) => {
      const v = parseFloat(c);
      if (!Number.isFinite(v)) throw new Error(`Row ${idx + 2}, column "${seriesNames[j]}": "${c}" is not a number.`);
      return v;
    });
    const key = JSON.stringify([label.toLowerCase(), ...values]);
    if (seen.has(key)) { skipped++; skippedRows.push(idx + 2); return; }
    seen.add(key);
    labels.push(label);
    values.forEach((v, j) => columns[j].push(v));
  });
  if (!labels.length) throw new Error('No data rows left after removing duplicates.');
  if (labels.length > MAX_LABELS) throw new Error(`A chart may have at most ${MAX_LABELS} labels (got ${labels.length}).`);
  const datasets = seriesNames.map((label, i) => ({ label, values: columns[i], color: PALETTE[i % PALETTE.length] }));
  return { labels, datasets, skipped, skippedRows, totalRows: lines.length - 1 };
}

// Same dedupe for a manually edited table {labels, datasets}.
function dedupeTable({ labels, datasets }) {
  const seen = new Set();
  const keepLabels = [];
  const keepCols = datasets.map(() => []);
  let skipped = 0;
  labels.forEach((label, i) => {
    const values = datasets.map((d) => d.values[i]);
    const key = JSON.stringify([String(label).toLowerCase(), ...values]);
    if (seen.has(key)) { skipped++; return; }
    seen.add(key);
    keepLabels.push(label);
    values.forEach((v, j) => keepCols[j].push(v));
  });
  return {
    labels: keepLabels,
    datasets: datasets.map((d, i) => ({ ...d, values: keepCols[i] })),
    skipped,
  };
}

// --- Scale ------------------------------------------------------------------
function niceScale(max) {
  if (!(max > 0)) return { max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 1e9) / 1e9);
  return { max: top, step, ticks };
}
function fmtNum(v) {
  if (Math.abs(v) >= 1000) return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return String(Math.round(v * 100) / 100);
}

// Layout shared by the SVG and the PNG (same boxes, same numbers).
function chartLayout(type, width, height) {
  const hasTitle = true;
  const titleH = 44;
  const legendH = 30;
  const plot = {
    x: type === 'pie' || type === 'doughnut' ? 8 : 64,
    y: titleH + 8,
    w: width - (type === 'pie' || type === 'doughnut' ? 16 : 80),
    h: height - titleH - 8 - 44 - legendH,
  };
  return { titleH, legendH, plot };
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- SVG --------------------------------------------------------------------
function chartToSvg(spec, { width = 960, height = 540 } = {}) {
  const v = validateChart(spec);
  if (!v.ok) throw new Error('Invalid chart: ' + v.errors.join(' '));
  const c = normalizeChart(spec);
  const L = chartLayout(c.type, width, height);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter, Arial, sans-serif">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  if (c.title) parts.push(`<text x="${width / 2}" y="30" text-anchor="middle" font-size="24" font-weight="700" fill="#111827">${escXml(c.title)}</text>`);
  if (c.type === 'bar' || c.type === 'line') {
    const max = Math.max(0, ...c.datasets.flatMap((d) => d.values));
    const scale = niceScale(max);
    const { plot } = L;
    for (const t of scale.ticks) {
      const y = plot.y + plot.h - (t / scale.max) * plot.h;
      parts.push(`<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`);
      parts.push(`<text x="${plot.x - 8}" y="${y + 4}" text-anchor="end" font-size="13" fill="#6b7280">${fmtNum(t)}</text>`);
    }
    const n = c.labels.length;
    const step = c.type === 'bar' ? plot.w / n : (n > 1 ? plot.w / (n - 1) : 0);
    const groupW = c.type === 'bar' ? step * 0.7 : 0;
    const barW = c.type === 'bar' ? groupW / c.datasets.length : 0;
    c.labels.forEach((label, i) => {
      const cx = c.type === 'bar' ? plot.x + step * i + step / 2 : plot.x + step * i;
      if (c.type === 'bar') {
        c.datasets.forEach((d, j) => {
          const val = d.values[i];
          const bh = (Math.max(0, val) / scale.max) * plot.h;
          const bx = plot.x + step * i + (step - groupW) / 2 + j * barW;
          parts.push(`<rect x="${bx.toFixed(1)}" y="${(plot.y + plot.h - bh).toFixed(1)}" width="${Math.max(1, barW - 3).toFixed(1)}" height="${bh.toFixed(1)}" fill="${d.color}" rx="2"/>`);
          if (c.showValues) parts.push(`<text x="${(bx + (barW - 3) / 2).toFixed(1)}" y="${(plot.y + plot.h - bh - 6).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="600" fill="#111827">${fmtNum(val)}</text>`);
        });
      } else {
        c.datasets.forEach((d) => {
          const y = plot.y + plot.h - (Math.max(0, d.values[i]) / scale.max) * plot.h;
          if (i > 0) {
            const px = plot.x + step * (i - 1);
            const py = plot.y + plot.h - (Math.max(0, d.values[i - 1]) / scale.max) * plot.h;
            parts.push(`<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${d.color}" stroke-width="3" stroke-linecap="round"/>`);
          }
          parts.push(`<circle cx="${cx.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${d.color}" stroke="#ffffff" stroke-width="2"/>`);
          if (c.showValues) parts.push(`<text x="${cx.toFixed(1)}" y="${(y - 12).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="600" fill="#111827">${fmtNum(d.values[i])}</text>`);
        });
      }
      if (n <= 12 || i % Math.ceil(n / 12) === 0) {
        parts.push(`<text x="${cx.toFixed(1)}" y="${plot.y + plot.h + 20}" text-anchor="middle" font-size="13" fill="#374151">${escXml(label)}</text>`);
      }
    });
  } else {
    const d = c.datasets[0];
    const total = d.values.reduce((a, b) => a + Math.max(0, b), 0);
    const { plot } = L;
    const cx = plot.x + plot.w / 2;
    const cy = plot.y + plot.h / 2;
    const R = Math.min(plot.w, plot.h) / 2 - 8;
    const innerR = c.type === 'doughnut' ? R * 0.55 : 0;
    let a0 = -Math.PI / 2;
    d.values.forEach((val, i) => {
      const frac = Math.max(0, val) / total;
      const a1 = a0 + frac * Math.PI * 2;
      if (frac <= 0) return;
      const large = frac > 0.5 ? 1 : 0;
      const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0);
      const x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
      if (innerR > 0) {
        const ix1 = cx + innerR * Math.cos(a1), iy1 = cy + innerR * Math.sin(a1);
        const ix0 = cx + innerR * Math.cos(a0), iy0 = cy + innerR * Math.sin(a0);
        parts.push(`<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} L ${ix1.toFixed(1)} ${iy1.toFixed(1)} A ${innerR} ${innerR} 0 ${large} 0 ${ix0.toFixed(1)} ${iy0.toFixed(1)} Z" fill="${PALETTE[i % PALETTE.length]}" stroke="#ffffff" stroke-width="2"/>`);
      } else {
        parts.push(`<path d="M ${cx} ${cy} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${PALETTE[i % PALETTE.length]}" stroke="#ffffff" stroke-width="2"/>`);
      }
      const mid = (a0 + a1) / 2;
      const lr = innerR > 0 ? (R + innerR) / 2 : R * 0.68;
      const lx = cx + lr * Math.cos(mid), ly = cy + lr * Math.sin(mid);
      if (c.showValues && frac >= 0.04) {
        parts.push(`<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="700" fill="#ffffff">${Math.round(frac * 100)}%</text>`);
      }
      a0 = a1;
    });
  }
  // Legend (bottom, centred).
  if (c.legend) {
    const items = c.type === 'pie' || c.type === 'doughnut'
      ? c.labels.map((l, i) => ({ label: l, color: PALETTE[i % PALETTE.length] }))
      : c.datasets.map((d) => ({ label: d.label, color: d.color }));
    const widths = items.map((it) => 22 + it.label.length * 7.5);
    const totalW = widths.reduce((a, b) => a + b, 0);
    let x = (width - totalW) / 2;
    const y = height - 18;
    items.forEach((it, i) => {
      parts.push(`<rect x="${x.toFixed(1)}" y="${y - 12}" width="14" height="14" rx="3" fill="${it.color}"/>`);
      parts.push(`<text x="${(x + 20).toFixed(1)}" y="${y}" font-size="13" fill="#374151">${escXml(it.label)}</text>`);
      x += widths[i];
    });
  }
  parts.push('</svg>');
  return parts.join('\n');
}

// --- Pure-JS PNG rasterizer (plot only — text comes from FFmpeg) ------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgba, width, height) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function rasterizeChart(spec, { width = 960, height = 540 } = {}) {
  const v = validateChart(spec);
  if (!v.ok) throw new Error('Invalid chart: ' + v.errors.join(' '));
  const c = normalizeChart(spec);
  const buf = Buffer.alloc(width * height * 4);
  // White background.
  for (let i = 0; i < width * height; i++) { buf[i * 4] = 255; buf[i * 4 + 1] = 255; buf[i * 4 + 2] = 255; buf[i * 4 + 3] = 255; }
  const setPx = (x, y, [r, g, b, a = 255]) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
    const o = (yi * width + xi) * 4;
    if (a >= 255) { buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255; return; }
    const s = a / 255;
    buf[o] = Math.round(r * s + buf[o] * (1 - s));
    buf[o + 1] = Math.round(g * s + buf[o + 1] * (1 - s));
    buf[o + 2] = Math.round(b * s + buf[o + 2] * (1 - s));
    buf[o + 3] = 255;
  };
  const fillRect = (x0, y0, x1, y1, rgb) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x1)); x++) setPx(x, y, rgb);
    }
  };
  const drawLine = (x0, y0, x1, y1, rgb, thick = 3) => {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
    for (let i = 0; i <= steps; i++) {
      const x = x0 + (dx * i) / steps, y = y0 + (dy * i) / steps;
      const r = Math.floor(thick / 2);
      for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
        if (ox * ox + oy * oy <= r * r + r) setPx(x + ox, y + oy, rgb);
      }
    }
  };
  const fillCircle = (cx, cy, r, rgb) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) setPx(x, y, rgb);
      }
    }
  };
  const L = chartLayout(c.type, width, height);
  const { plot } = L;
  const GRID = [229, 231, 235];
  if (c.type === 'bar' || c.type === 'line') {
    const max = Math.max(0, ...c.datasets.flatMap((d) => d.values));
    const scale = niceScale(max);
    for (const t of scale.ticks) {
      const y = plot.y + plot.h - (t / scale.max) * plot.h;
      fillRect(plot.x, y, plot.x + plot.w, y + 1, GRID);
    }
    const n = c.labels.length;
    const step = c.type === 'bar' ? plot.w / n : (n > 1 ? plot.w / (n - 1) : 0);
    const groupW = c.type === 'bar' ? step * 0.7 : 0;
    const barW = c.type === 'bar' ? groupW / c.datasets.length : 0;
    c.labels.forEach((label, i) => {
      const cx = c.type === 'bar' ? plot.x + step * i + step / 2 : plot.x + step * i;
      if (c.type === 'bar') {
        c.datasets.forEach((d, j) => {
          const val = d.values[i];
          const bh = (Math.max(0, val) / scale.max) * plot.h;
          const bx = plot.x + step * i + (step - groupW) / 2 + j * barW;
          fillRect(bx, plot.y + plot.h - bh, bx + Math.max(1, barW - 3), plot.y + plot.h, hexToRgb(d.color));
        });
      } else {
        c.datasets.forEach((d) => {
          const y = plot.y + plot.h - (Math.max(0, d.values[i]) / scale.max) * plot.h;
          if (i > 0) {
            const px = plot.x + step * (i - 1);
            const py = plot.y + plot.h - (Math.max(0, d.values[i - 1]) / scale.max) * plot.h;
            drawLine(px, py, cx, y, hexToRgb(d.color), 3);
          }
          fillCircle(cx, y, 5, hexToRgb(d.color));
          fillCircle(cx, y, 2.5, [255, 255, 255]);
        });
      }
    });
  } else {
    const d = c.datasets[0];
    const total = d.values.reduce((a, b) => a + Math.max(0, b), 0);
    const cx = plot.x + plot.w / 2;
    const cy = plot.y + plot.h / 2;
    const R = Math.min(plot.w, plot.h) / 2 - 8;
    const innerR = c.type === 'doughnut' ? R * 0.55 : 0;
    let a0 = -Math.PI / 2;
    const slices = d.values.map((val, i) => {
      const frac = Math.max(0, val) / total;
      const a1 = a0 + frac * Math.PI * 2;
      const s = { a0, a1, color: hexToRgb(PALETTE[i % PALETTE.length]) };
      a0 = a1;
      return s;
    });
    for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
      for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
        const dx = x - cx, dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > R || r < innerR) continue;
        let ang = Math.atan2(dy, dx);
        if (ang < -Math.PI / 2) ang += Math.PI * 2;
        // Slices are measured from -PI/2 going clockwise (screen y down =
        // angle grows clockwise in atan2 with y down, matching SVG arcs).
        const s = slices.find((sl) => ang >= sl.a0 - 1e-9 && ang < sl.a1 - 1e-9);
        if (s) setPx(x, y, s.color);
      }
    }
    // White separators between slices.
    for (const s of slices) {
      for (const a of [s.a0, s.a1]) {
        drawLine(cx + innerR * Math.cos(a), cy + innerR * Math.sin(a), cx + R * Math.cos(a), cy + R * Math.sin(a), [255, 255, 255], 2);
      }
    }
  }
  return { png: encodePng(buf, width, height), width, height, layout: L };
}

// --- PNG with real text labels (FFmpeg drawtext over the raster) ------------
function escDrawtext(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/%/g, '\\%').replace(/'/g, "\\'");
}

async function renderChartPng(spec, outPath, { width = 960, height = 540 } = {}) {
  const v = validateChart(spec);
  if (!v.ok) throw new Error('Invalid chart: ' + v.errors.join(' '));
  const c = normalizeChart(spec);
  const { png, layout: L } = rasterizeChart(c, { width, height });
  const tmpDir = path.join(path.dirname(outPath), `.chart-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const basePng = path.join(tmpDir, 'plot.png');
    fs.writeFileSync(basePng, png);
    const titleFont = fontFor('Inter', 700);
    const labelFont = fontFor('Inter', 400);
    const boldFont = fontFor('Inter', 700);
    if (!titleFont || !labelFont) throw new Error('No usable system font found for chart labels (DejaVu fonts missing).');
    const filters = [];
    // Title (drawtext cannot take a file here — titles are short; escape it).
    if (c.title) {
      filters.push(`drawtext=fontfile=${titleFont}:text='${escDrawtext(c.title)}':fontsize=26:fontcolor=0x111827:x=(w-text_w)/2:y=10`);
    }
    const { plot } = L;
    if (c.type === 'bar' || c.type === 'line') {
      const max = Math.max(0, ...c.datasets.flatMap((d) => d.values));
      const scale = niceScale(max);
      for (const t of scale.ticks) {
        const y = Math.round(plot.y + plot.h - (t / scale.max) * plot.h);
        filters.push(`drawtext=fontfile=${labelFont}:text='${escDrawtext(fmtNum(t))}':fontsize=15:fontcolor=0x6b7280:x=${plot.x - 10}-text_w:y=${y - 8}`);
      }
      const n = c.labels.length;
      const step = c.type === 'bar' ? plot.w / n : (n > 1 ? plot.w / (n - 1) : 0);
      const every = n <= 12 ? 1 : Math.ceil(n / 12);
      c.labels.forEach((label, i) => {
        if (i % every !== 0) return;
        const cx = c.type === 'bar' ? plot.x + step * i + step / 2 : plot.x + step * i;
        filters.push(`drawtext=fontfile=${labelFont}:text='${escDrawtext(label)}':fontsize=15:fontcolor=0x374151:x=${Math.round(cx)}-text_w/2:y=${Math.round(plot.y + plot.h + 8)}`);
      });
      if (c.showValues) {
        c.datasets.forEach((d) => {
          d.values.forEach((val, i) => {
            const cx = c.type === 'bar' ? plot.x + step * i + step / 2 : plot.x + step * i;
            const y = plot.y + plot.h - (Math.max(0, val) / scale.max) * plot.h;
            if (c.type === 'bar') {
              const groupW = step * 0.7;
              const barW = groupW / c.datasets.length;
              const j = c.datasets.indexOf(d);
              const bx = plot.x + step * i + (step - groupW) / 2 + j * barW;
              filters.push(`drawtext=fontfile=${boldFont}:text='${escDrawtext(fmtNum(val))}':fontsize=13:fontcolor=0x111827:x=${Math.round(bx + (barW - 3) / 2)}-text_w/2:y=${Math.round(y - 22)}`);
            } else {
              filters.push(`drawtext=fontfile=${boldFont}:text='${escDrawtext(fmtNum(val))}':fontsize=13:fontcolor=0x111827:x=${Math.round(cx)}-text_w/2:y=${Math.round(y - 26)}`);
            }
          });
        });
      }
    } else {
      // Pie/doughnut: percentage labels on slices >= 4%.
      const d = c.datasets[0];
      const total = d.values.reduce((a, b) => a + Math.max(0, b), 0);
      const cx = plot.x + plot.w / 2;
      const cy = plot.y + plot.h / 2;
      const R = Math.min(plot.w, plot.h) / 2 - 8;
      const innerR = c.type === 'doughnut' ? R * 0.55 : 0;
      let a0 = -Math.PI / 2;
      d.values.forEach((val) => {
        const frac = Math.max(0, val) / total;
        const a1 = a0 + frac * Math.PI * 2;
        if (frac >= 0.04) {
          const mid = (a0 + a1) / 2;
          const lr = innerR > 0 ? (R + innerR) / 2 : R * 0.68;
          const lx = Math.round(cx + lr * Math.cos(mid));
          const ly = Math.round(cy + lr * Math.sin(mid));
          filters.push(`drawtext=fontfile=${boldFont}:text='${Math.round(frac * 100)}\\%':fontsize=15:fontcolor=white:x=${lx}-text_w/2:y=${ly - 8}`);
        }
        a0 = a1;
      });
    }
    // Legend (bottom centre): colour box + name per item.
    if (c.legend) {
      const items = c.type === 'pie' || c.type === 'doughnut'
        ? c.labels.map((l, i) => ({ label: l, color: PALETTE[i % PALETTE.length] }))
        : c.datasets.map((d) => ({ label: d.label, color: d.color }));
      const estW = items.reduce((a, it) => a + 22 + it.label.length * 8, 0);
      let x = Math.round((width - estW) / 2);
      const y = height - 24;
      for (const it of items) {
        const [r, g, b] = hexToRgb(it.color);
        filters.push(`drawbox=x=${x}:y=${y - 4}:w=14:h=14:color=0x${it.color.replace('#', '')}:t=fill`);
        filters.push(`drawtext=fontfile=${labelFont}:text='${escDrawtext(it.label)}':fontsize=14:fontcolor=0x374151:x=${x + 20}:y=${y - 6}`);
        x += 22 + it.label.length * 8;
      }
    }
    const args = ['-y', '-v', 'error', '-i', basePng];
    if (filters.length) args.push('-vf', filters.join(','));
    args.push(outPath);
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let errText = '';
      child.stderr.on('data', (d) => { errText += d.toString(); });
      child.on('error', (err) => reject(new Error(`Could not start FFmpeg: ${err.message}`)));
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Chart label render failed (code ${code}): ${errText.slice(-600)}`))));
    });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) throw new Error('Chart PNG render produced no output file.');
    return { width, height, svg: chartToSvg(c, { width, height }) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = {
  CHART_TYPES, PALETTE, MAX_LABELS, MAX_DATASETS,
  validateChart, normalizeChart, parseCsvTable, dedupeTable,
  niceScale, fmtNum, chartLayout, chartToSvg, rasterizeChart, renderChartPng,
};
