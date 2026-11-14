'use strict';
// Docs & Slides routes (v2.2.3, Release B).
//   Charts:  POST /api/docs-slides/charts/parse    — CSV / table → chart data (duplicates skipped)
//            POST /api/docs-slides/charts/render   — chart → SVG + PNG saved to Media Library
//   Decks:   POST /api/docs-slides/decks/validate  — validate + never-overflow fit report
//            POST /api/docs-slides/decks/generate  — AI outline → deck (LLM key needed)
//            POST /api/docs-slides/decks/:id/export/images|pdf|video
//   Docs:    POST /api/docs-slides/docs/:id/export/html|docx|pdf
//   Website: POST /api/docs-slides/websites/publish — design/deck/doc → static site
//            GET  /api/docs-slides/websites — list; DELETE /:slug — unpublish
//   Print:   POST /api/docs-slides/print/pdf — print-ready PDF (bleed, crop marks, safe zone)
//            GET  /api/docs-slides/print-sizes
//
// Public sites are served at /sites/:slug/... (mounted in server.js).
// Honest errors: invalid input 400, missing project/media 404, no LLM key
// 402 key_needed (AI deck generation), insufficient credits 402.
const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const credits = require('../credits');
const ai = require('../ai');
const { probeMedia } = require('../ffmpeg');
const {
  validateDeck, deckFitCheck, applyDeckUniformFonts, deckToDesigns,
  blankDeck, blankDoc, validateDoc, docToHtml, docToDocx, docToDesignPages,
  PRINT_SIZES, designsToPrintPdf, buildWebsite, renderDeckImages, slugify,
} = require('../docs-slides');
const {
  CHART_TYPES, validateChart, normalizeChart, parseCsvTable, dedupeTable,
  chartToSvg, renderChartPng,
} = require('../chart');
const { writeImagePdf, pngToJpeg } = require('../pdf-writer');
const { renderDesign } = require('../design-render');

const router = express.Router();
const WEBSITES_DIR = path.join(config.root, 'data', 'websites');

function publicMedia(m) {
  return {
    id: m.id, originalName: m.original_name, mimeType: m.mime_type, kind: m.kind,
    sizeBytes: m.size_bytes, width: m.width, height: m.height,
    tags: m.tags, url: `/api/media/${m.id}/file`, createdAt: m.created_at,
  };
}
function mediaFilePath(userId, media) {
  return path.join(config.uploadsDir, String(userId), media.stored_name);
}
function mediaByIdFor(userId, ids) {
  const out = {};
  for (const id of ids) {
    const row = db.getMedia(userId, id);
    if (!row) throw Object.assign(new Error(`Media file #${id} was not found.`), { code: 'NOT_FOUND' });
    const filePath = mediaFilePath(userId, row);
    if (!fs.existsSync(filePath)) throw new Error(`Media file "${row.original_name}" is missing on disk.`);
    out[id] = { filePath, kind: row.kind, width: row.width, height: row.height };
  }
  return out;
}
function tmpWorkDir(userId, tag) {
  const dir = path.join(config.rendersDir, String(userId), `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function sendDownload(res, filePath, filename) {
  res.download(filePath, filename, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: 'Download failed.' });
    // Best-effort cleanup of the temp export folder.
    try { fs.rmSync(path.dirname(filePath), { recursive: true, force: true }); } catch { /* ignore */ }
  });
}
function getProjectOr404(req, id) {
  const p = db.getProject(req.user.id, id);
  if (!p) return null;
  return { ...p, content: JSON.parse(p.content || '{}') };
}
async function renderChartFilesForDeck(deck, workDir) {
  const chartFiles = {};
  for (const s of deck.slides || []) {
    for (const el of s.elements || []) {
      if (el.type === 'chart' && el.chart) {
        const pngPath = path.join(workDir, `chart-${el.id}.png`);
        await renderChartPng(el.chart, pngPath, { width: Math.min(1200, Math.max(320, el.w || 960)), height: Math.min(700, Math.max(200, el.h || 540)) });
        chartFiles[el.id] = pngPath;
      }
    }
  }
  return chartFiles;
}

// --- Charts -------------------------------------------------------------------
router.get('/print-sizes', auth.requireAuth, (req, res) => {
  res.json({ sizes: Object.values(PRINT_SIZES).map((s) => ({ id: s.id, name: s.name, widthMm: s.widthMm, heightMm: s.heightMm, ptW: s.ptW, ptH: s.ptH })) });
});

router.post('/charts/parse', auth.requireAuth, (req, res) => {
  const { csv, labels, datasets } = req.body || {};
  try {
    if (csv !== undefined) {
      const out = parseCsvTable(csv);
      return res.json({ labels: out.labels, datasets: out.datasets, skipped: out.skipped, skippedRows: out.skippedRows, totalRows: out.totalRows });
    }
    if (labels !== undefined || datasets !== undefined) {
      if (!Array.isArray(labels) || !Array.isArray(datasets)) return res.status(400).json({ error: 'Send { labels, datasets } with arrays.' });
      const out = dedupeTable({ labels, datasets });
      return res.json({ labels: out.labels, datasets: out.datasets, skipped: out.skipped, skippedRows: [], totalRows: labels.length });
    }
    return res.status(400).json({ error: 'Send { csv } (pasted CSV text) or { labels, datasets } (manual table).' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/charts/render', auth.requireAuth, (req, res) => {
  const { spec, width, height, saveToLibrary = true, name } = req.body || {};
  if (!spec) return res.status(400).json({ error: 'Chart spec is required.' });
  const v = validateChart(spec);
  if (!v.ok) return res.status(400).json({ error: 'Invalid chart: ' + v.errors.join(' ') });
  const w = width === undefined ? 960 : Number(width);
  const h = height === undefined ? 540 : Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 320 || w > 2400 || h < 200 || h > 1600) {
    return res.status(400).json({ error: 'Chart size must be 320–2400 × 200–1600 px.' });
  }
  const dir = tmpWorkDir(req.user.id, 'chart');
  const pngPath = path.join(dir, 'chart.png');
  renderChartPng(normalizeChart(spec), pngPath, { width: w, height: h })
    .then(async () => {
      const svg = chartToSvg(normalizeChart(spec), { width: w, height: h });
      let media = null;
      if (saveToLibrary) {
        const stamp = Date.now().toString(36);
        const safe = String(name || `chart-${stamp}.png`).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
        const userDir = path.join(config.uploadsDir, String(req.user.id));
        fs.mkdirSync(userDir, { recursive: true });
        const storedName = safe.endsWith('.png') ? safe : `${safe}.png`;
        const dest = path.join(userDir, storedName);
        fs.copyFileSync(pngPath, dest);
        const probe = await probeMedia(dest);
        media = db.createMedia(req.user.id, {
          originalName: storedName, storedName, mimeType: 'image/png', kind: 'image',
          sizeBytes: fs.statSync(dest).size, width: probe && probe.width, height: probe && probe.height,
          tags: 'chart',
        });
        db.audit(req.user.id, 'chart_rendered', 'media', media.id, `Rendered a ${spec.type} chart (${w}×${h}) to the Media Library`);
      }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      res.json({ svg, media: media ? publicMedia(media) : null, width: w, height: h });
    })
    .catch((err) => res.status(400).json({ error: String(err.message || err).slice(0, 500) }));
});

// --- Decks --------------------------------------------------------------------
router.post('/decks/validate', auth.requireAuth, (req, res) => {
  const { deck, applyUniformFonts } = req.body || {};
  if (!deck) return res.status(400).json({ error: 'Deck JSON is required.' });
  const check = deckFitCheck(deck);
  if (!check.ok) return res.status(400).json({ error: 'Invalid deck: ' + check.errors.join(' ') });
  let outDeck = deck;
  let applied = false;
  if (applyUniformFonts) {
    const r = applyDeckUniformFonts(deck);
    outDeck = r.deck;
    applied = r.applied;
  }
  res.json({ deck: outDeck, appliedUniformFonts: applied, slides: check.slides, needsAttention: check.needsAttention, batchFonts: check.batchFonts });
});

router.post('/decks/generate', auth.requireAuth, (req, res) => {
  const { topic, slideCount = 6, style = 'professional', audience = '' } = req.body || {};
  if (!topic || typeof topic !== 'string' || !topic.trim()) return res.status(400).json({ error: 'A topic is required for AI deck generation.' });
  const count = Number(slideCount);
  if (!Number.isInteger(count) || count < 2 || count > 20) return res.status(400).json({ error: 'slideCount must be 2–20.' });
  const action = credits.AI_MODE_COSTS.deck;
  if (action) {
    const check = credits.checkCredits(req.user.id, action);
    if (!check.ok) return res.status(402).json({ error: check.error, code: check.code, needed: check.needed, balance: check.balance });
  }
  try {
    const job = ai.createAiJobEntry(req.user.id, {
      mode: 'deck', name: `Deck: ${topic.trim().slice(0, 60)}`,
      params: { topic: topic.trim(), slideCount: count, style: String(style).slice(0, 40), audience: String(audience).slice(0, 120) },
    });
    db.audit(req.user.id, 'ai_job_created', 'ai_job', job.id, `AI deck job started ("${topic.trim().slice(0, 80)}")`);
    res.status(201).json({ job: ai.publicAiJob(job) });
  } catch (err) {
    console.error('[docs-slides] failed:', err);
    res.status(500).json({ error: String(err.message || err).slice(0, 500) });
  }
});

function deckProjectOr400(req, res) {
  const p = getProjectOr404(req, req.params.id);
  if (!p) { res.status(404).json({ error: 'Project not found.' }); return null; }
  if (p.type !== 'deck') { res.status(400).json({ error: 'Only deck projects can be exported as a deck.' }); return null; }
  const check = validateDeck(p.content);
  if (!check.ok) { res.status(400).json({ error: 'Invalid deck: ' + check.errors.join(' ') }); return null; }
  return p;
}

router.post('/decks/:id/export/images', auth.requireAuth, async (req, res) => {
  const p = deckProjectOr400(req, res);
  if (!p) return;
  const workDir = tmpWorkDir(req.user.id, 'deck-images');
  try {
    const chartFiles = await renderChartFilesForDeck(p.content, workDir);
    const mediaIds = new Set();
    for (const s of p.content.slides) for (const el of s.elements || []) {
      if (el.type === 'image' && el.image && el.image.mediaId && !String(el.image.mediaId).startsWith('chart:')) mediaIds.add(el.image.mediaId);
    }
    const mediaById = mediaByIdFor(req.user.id, [...mediaIds]);
    const slides = await renderDeckImages(p.content, { workDir, chartFiles, mediaById });
    const zipPath = path.join(workDir, `${p.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'deck'}-slides.zip`);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      slides.forEach((s, i) => archive.file(s.pngPath, { name: `slide-${String(i + 1).padStart(2, '0')}.png` }));
      archive.finalize();
    });
    db.audit(req.user.id, 'deck_export_images', 'project', p.id, `Exported deck "${p.name}" as ${slides.length} slide images`);
    sendDownload(res, zipPath, path.basename(zipPath));
  } catch (err) {
    console.error('[docs-slides] failed:', err);
    res.status(500).json({ error: String(err.message || err).slice(0, 500) });
  }
});

router.post('/decks/:id/export/pdf', auth.requireAuth, async (req, res) => {
  const p = deckProjectOr400(req, res);
  if (!p) return;
  const workDir = tmpWorkDir(req.user.id, 'deck-pdf');
  try {
    const designs = deckToDesigns(p.content);
    const chartFiles = await renderChartFilesForDeck(p.content, workDir);
    const mediaIds = new Set();
    for (const s of p.content.slides) for (const el of s.elements || []) {
      if (el.type === 'image' && el.image && el.image.mediaId && !String(el.image.mediaId).startsWith('chart:')) mediaIds.add(el.image.mediaId);
    }
    const mediaById = mediaByIdFor(req.user.id, [...mediaIds]);
    const pages = [];
    for (let i = 0; i < designs.length; i++) {
      const mb = { ...mediaById };
      for (const l of designs[i].layers || []) {
        if (l.type === 'image' && String(l.image.mediaId || '').startsWith('chart:')) {
          const file = chartFiles[l.image.mediaId.slice(6)];
          if (file) mb[l.image.mediaId] = { filePath: file, kind: 'image' };
        }
      }
      const pngPath = path.join(workDir, `slide-${i + 1}.png`);
      await renderDesign({ design: designs[i], mediaById: mb, outPath: pngPath });
      const jpegPath = path.join(workDir, `slide-${i + 1}.jpg`);
      const { width, height } = await pngToJpeg(pngPath, jpegPath, 2);
      pages.push({ jpegPath, imgWidth: width, imgHeight: height, widthPt: (p.content.width / p.content.height) * 720, heightPt: 720 });
    }
    const pdfPath = path.join(workDir, `${p.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'deck'}.pdf`);
    const result = writeImagePdf(pages, pdfPath);
    db.audit(req.user.id, 'deck_export_pdf', 'project', p.id, `Exported deck "${p.name}" as PDF (${result.pages} pages)`);
    sendDownload(res, pdfPath, path.basename(pdfPath));
  } catch (err) {
    console.error('[docs-slides] failed:', err);
    res.status(500).json({ error: String(err.message || err).slice(0, 500) });
  }
});

router.post('/decks/:id/export/video', auth.requireAuth, (req, res) => {
  const p = deckProjectOr400(req, res);
  if (!p) return;
  const { secondsPerSlide = 5, fps = 30 } = req.body || {};
  const secs = Number(secondsPerSlide);
  if (!Number.isFinite(secs) || secs < 1 || secs > 60) return res.status(400).json({ error: 'secondsPerSlide must be 1–60.' });
  const check = credits.checkCredits(req.user.id, 'render');
  if (!check.ok) return res.status(402).json({ error: check.error, code: check.code, needed: check.needed, balance: check.balance });
  const job = db.createJob(req.user.id, {
    type: 'render',
    projectId: p.id,
    payload: { deck: p.content, secondsPerSlide: secs, fps: Number(fps) || 30 },
  });
  db.audit(req.user.id, 'render_queued', 'job', job.id, `Deck video render queued for "${p.name}" (${p.content.slides.length} slides, ${secs}s each)`);
  res.status(201).json({ job: { id: job.id, type: job.type, status: job.status, projectId: job.project_id, createdAt: job.created_at } });
});

// --- Docs ---------------------------------------------------------------------
function docProjectOr400(req, res) {
  const p = getProjectOr404(req, req.params.id);
  if (!p) { res.status(404).json({ error: 'Project not found.' }); return null; }
  if (p.type !== 'doc') { res.status(400).json({ error: 'Only document projects can be exported as a document.' }); return null; }
  const check = validateDoc(p.content);
  if (!check.ok) { res.status(400).json({ error: 'Invalid document: ' + check.errors.join(' ') }); return null; }
  return p;
}

router.post('/docs/:id/export/html', auth.requireAuth, (req, res) => {
  const p = docProjectOr400(req, res);
  if (!p) return;
  try {
    const mediaIds = new Set();
    for (const b of p.content.blocks || []) if (b.type === 'image' && Number.isInteger(b.mediaId)) mediaIds.add(b.mediaId);
    const mediaById = mediaByIdFor(req.user.id, [...mediaIds]);
    const doc = {
      ...p.content,
      blocks: p.content.blocks.map((b) => (b.type === 'image' && mediaById[b.mediaId]
        ? { ...b, imageUrl: `/api/media/${b.mediaId}/file` } : b)),
    };
    const html = docToHtml(doc, { fullPage: true });
    const filename = `${p.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'document'}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
  } catch (err) {
    console.error('[docs-slides] failed:', err);
    res.status(500).json({ error: String(err.message || err).slice(0, 500) });
  }
});

router.post('/docs/:id/export/docx', auth.requireAuth, async (req, res) => {
  const p = docProjectOr400(req, res);
  if (!p) return;
  const workDir = tmpWorkDir(req.user.id, 'doc-docx');
  try {
    const mediaIds = new Set();
    for (const b of p.content.blocks || []) if (b.type === 'image' && Number.isInteger(b.mediaId)) mediaIds.add(b.mediaId);
    const mediaById = mediaByIdFor(req.user.id, [...mediaIds]);
    const filename = `${p.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'document'}.docx`;
    const outPath = path.join(workDir, filename);
    const result = await docToDocx(p.content, { mediaById, outPath });
    db.audit(req.user.id, 'doc_export_docx', 'project', p.id, `Exported document "${p.name}" as DOCX (${result.blocks} blocks, ${result.images} images)`);
    sendDownload(res, outPath, filename);
  } catch (err) {
    console.error('[docs-slides] failed:', err);
    res.status(500).json({ error: String(err.message || err).slice(0, 500) });
  }
});

router.post('/docs/:id/export/pdf', auth.requireAuth, async (req, res) => {
  const p = docProjectOr400(req, res);
  if (!p) return;
  const workDir = tmpWorkDir(req.user.id, 'doc-pdf');
  try {
    const mediaIds = new Set();
    for (const b of p.content.blocks || []) if (b.type === 'image' && Number.isInteger(b.mediaId)) mediaIds.add(b.mediaId);
    const mediaById = mediaByIdFor(req.user.id, [...mediaIds]);
    const chartFiles = {};
    for (const b of p.content.blocks || []) {
      if (b.type === 'chart' && b.chart) {
        const pngPath = path.join(workDir, `chart-${b.id}.png`);
        await renderChartPng(b.chart, pngPath, { width: 960, height: 540 });
        chartFiles[b.id] = pngPath;
      }
    }
    const designs = docToDesignPages(p.content, { mediaById, chartFiles });
    const pages = [];
    for (let i = 0; i < designs.length; i++) {
      const mb = { ...mediaById };
      for (const l of designs[i].layers || []) {
        if (l.type === 'image' && String(l.image.mediaId || '').startsWith('chart:')) {
          const file = chartFiles[l.image.mediaId.slice(6)];
          if (file) mb[l.image.mediaId] = { filePath: file, kind: 'image' };
        }
      }
      const pngPath = path.join(workDir, `page-${i + 1}.png`);
      await renderDesign({ design: designs[i], mediaById: mb, outPath: pngPath });
      const jpegPath = path.join(workDir, `page-${i + 1}.jpg`);
      const { width, height } = await pngToJpeg(pngPath, jpegPath, 2);
      pages.push({ jpegPath, imgWidth: width, imgHeight: height, widthPt: 595.28, heightPt: 841.89 });
    }
    const filename = `${p.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'document'}.pdf`;
    const pdfPath = path.join(workDir, filename);
    const result = writeImagePdf(pages, pdfPath);
    db.audit(req.user.id, 'doc_export_pdf', 'project', p.id, `Exported document "${p.name}" as PDF (${result.pages} pages)`);
    sendDownload(res, pdfPath, filename);
  } catch (err) {
    console.error('[docs-slides] failed:', err);
    res.status(500).json({ error: String(err.message || err).slice(0, 500) });
  }
});

// --- Websites -------------------------------------------------------------------
function siteDir(slug) { return path.join(WEBSITES_DIR, slug); }

router.get('/websites', auth.requireAuth, (req, res) => {
  const sites = db.listWebsites(req.user.id).map((s) => ({
    id: s.id, slug: s.slug, kind: s.kind, title: s.title, projectId: s.project_id,
    url: `/sites/${s.slug}/`, createdAt: s.created_at,
  }));
  res.json({ sites });
});

router.post('/websites/publish', auth.requireAuth, (req, res) => {
  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: 'projectId is required.' });
  const p = getProjectOr404(req, projectId);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  if (!['design', 'deck', 'doc'].includes(p.type)) return res.status(400).json({ error: 'Only design, deck and document projects can be published as a website.' });
  try {
    let design = null, deck = null, doc = null;
    if (p.type === 'design') {
      const { validateDesign } = require('../design-model');
      const check = validateDesign(p.content);
      if (!check.ok) return res.status(400).json({ error: 'Invalid design: ' + check.errors.join(' ') });
      design = p.content;
    } else if (p.type === 'deck') {
      const check = validateDeck(p.content);
      if (!check.ok) return res.status(400).json({ error: 'Invalid deck: ' + check.errors.join(' ') });
      deck = p.content;
    } else {
      const check = validateDoc(p.content);
      if (!check.ok) return res.status(400).json({ error: 'Invalid document: ' + check.errors.join(' ') });
      doc = p.content;
    }
    const mediaIds = new Set();
    const collect = (layers) => { for (const l of layers || []) if (l.type === 'image' && l.image && l.image.mediaId && !String(l.image.mediaId).startsWith('chart:')) mediaIds.add(l.image.mediaId); };
    if (design) collect(design.layers);
    if (deck) for (const s of deck.slides) collect(s.elements);
    if (doc) for (const b of doc.blocks || []) if (b.type === 'image' && Number.isInteger(b.mediaId)) mediaIds.add(b.mediaId);
    const mediaById = mediaByIdFor(req.user.id, [...mediaIds]);
    const chartFiles = {};
    const workDir = tmpWorkDir(req.user.id, 'site-charts');
    const chartJobs = [];
    if (deck) for (const s of deck.slides) for (const el of s.elements || []) {
      if (el.type === 'chart' && el.chart) chartJobs.push([el.id, el.chart]);
    }
    if (doc) for (const b of doc.blocks || []) if (b.type === 'chart' && b.chart) chartJobs.push([b.id, b.chart]);
    const build = (async () => {
      for (const [id, spec] of chartJobs) {
        const pngPath = path.join(workDir, `chart-${id}.png`);
        await renderChartPng(spec, pngPath, { width: 960, height: 540 });
        chartFiles[id] = pngPath;
      }
      const slug = slugify(p.name);
      const outDir = siteDir(slug);
      const built = buildWebsite({ kind: p.type, title: p.name, design, deck, doc, mediaById, chartFiles, outDir });
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
      const site = db.createWebsite(req.user.id, { projectId: p.id, slug, kind: p.type, title: p.name, dir: outDir });
      db.audit(req.user.id, 'website_published', 'website', site.id, `Published "${p.name}" as a website at /sites/${slug}/`);
      res.status(201).json({ site: { id: site.id, slug: site.slug, kind: site.kind, title: site.title, projectId: site.project_id, url: `/sites/${site.slug}/`, files: built.files } });
    })();
    build.catch((err) => { console.error('[docs-slides] website build failed:', err); res.status(500).json({ error: String(err.message || err).slice(0, 500) }); });
  } catch (err) {
    console.error('[docs-slides] failed:', err);
    res.status(500).json({ error: String(err.message || err).slice(0, 500) });
  }
});

router.delete('/websites/:slug', auth.requireAuth, (req, res) => {
  const site = db.getWebsite(req.user.id, req.params.slug);
  if (!site) return res.status(404).json({ error: 'Website not found.' });
  try { fs.rmSync(site.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  db.deleteWebsite(req.user.id, req.params.slug);
  db.audit(req.user.id, 'website_unpublished', 'website', site.id, `Unpublished website "${site.title}" (${site.slug})`);
  res.json({ ok: true });
});

// Public site serving (mounted at /sites in server.js — no auth).
function siteStatic(req, res, next) {
  const parts = req.path.split('/').filter(Boolean);
  const slug = parts[0];
  if (!slug) return res.status(404).send('Site not found.');
  const site = db.getWebsiteBySlug(slug);
  if (!site) return res.status(404).send('Site not found.');
  const rel = parts.slice(1).join('/') || 'index.html';
  if (rel.includes('..')) return res.status(400).send('Bad path.');
  const file = path.join(site.dir, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.status(404).send('Page not found.');
  res.sendFile(file);
}

// --- Print ----------------------------------------------------------------------
router.post('/print/pdf', auth.requireAuth, async (req, res) => {
  const { projectId, design, deck, doc, sizeId = 'a4', bleedMm = 3, marginMm = 10 } = req.body || {};
  if (!PRINT_SIZES[sizeId]) return res.status(400).json({ error: `Unknown print size: ${sizeId}.` });
  let designs = null;
  let name = 'print';
  try {
    if (projectId) {
      const p = getProjectOr404(req, projectId);
      if (!p) return res.status(404).json({ error: 'Project not found.' });
      name = p.name;
      if (p.type === 'design') {
        const { validateDesign } = require('../design-model');
        const check = validateDesign(p.content);
        if (!check.ok) return res.status(400).json({ error: 'Invalid design: ' + check.errors.join(' ') });
        designs = [p.content];
      } else if (p.type === 'deck') {
        const check = validateDeck(p.content);
        if (!check.ok) return res.status(400).json({ error: 'Invalid deck: ' + check.errors.join(' ') });
        designs = deckToDesigns(p.content);
      } else if (p.type === 'doc') {
        const check = validateDoc(p.content);
        if (!check.ok) return res.status(400).json({ error: 'Invalid document: ' + check.errors.join(' ') });
        const mediaIds = new Set();
        for (const b of p.content.blocks || []) if (b.type === 'image' && Number.isInteger(b.mediaId)) mediaIds.add(b.mediaId);
        const mediaById = mediaByIdFor(req.user.id, [...mediaIds]);
        designs = docToDesignPages(p.content, { mediaById });
      } else {
        return res.status(400).json({ error: 'Only design, deck and document projects can be printed.' });
      }
    } else if (design) {
      const { validateDesign } = require('../design-model');
      const check = validateDesign(design);
      if (!check.ok) return res.status(400).json({ error: 'Invalid design: ' + check.errors.join(' ') });
      designs = [design];
    } else if (deck) {
      const check = validateDeck(deck);
      if (!check.ok) return res.status(400).json({ error: 'Invalid deck: ' + check.errors.join(' ') });
      designs = deckToDesigns(deck);
    } else if (doc) {
      const check = validateDoc(doc);
      if (!check.ok) return res.status(400).json({ error: 'Invalid document: ' + check.errors.join(' ') });
      designs = docToDesignPages(doc, { mediaById: {} });
    } else {
      return res.status(400).json({ error: 'Send a projectId, or inline design / deck / doc JSON.' });
    }
    const mediaIds = new Set();
    for (const d of designs) for (const l of d.layers || []) {
      if (l.type === 'image' && l.image && l.image.mediaId && !String(l.image.mediaId).startsWith('chart:')) mediaIds.add(l.image.mediaId);
    }
    const mediaById = mediaByIdFor(req.user.id, [...mediaIds]);
    const workDir = tmpWorkDir(req.user.id, 'print');
    const chartFiles = {};
    // Charts inside decks/docs need PNGs before the print render.
    const chartJobs = [];
    if (projectId) {
      const p = getProjectOr404(req, projectId);
      if (p && p.type === 'deck') for (const s of p.content.slides) for (const el of s.elements || []) if (el.type === 'chart' && el.chart) chartJobs.push([el.id, el.chart]);
      if (p && p.type === 'doc') for (const b of p.content.blocks || []) if (b.type === 'chart' && b.chart) chartJobs.push([b.id, b.chart]);
    } else if (deck) {
      for (const s of deck.slides) for (const el of s.elements || []) if (el.type === 'chart' && el.chart) chartJobs.push([el.id, el.chart]);
    } else if (doc) {
      for (const b of doc.blocks || []) if (b.type === 'chart' && b.chart) chartJobs.push([b.id, b.chart]);
    }
    for (const [id, spec] of chartJobs) {
      const pngPath = path.join(workDir, `chart-${id}.png`);
      await renderChartPng(spec, pngPath, { width: 960, height: 540 });
      chartFiles[id] = pngPath;
    }
    const filename = `${String(name).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'print'}-print.pdf`;
    const outPath = path.join(workDir, filename);
    const result = await designsToPrintPdf(designs, { sizeId, bleedMm: Number(bleedMm), marginMm: Number(marginMm), mediaById, chartFiles, workDir, outPath });
    db.audit(req.user.id, 'print_pdf', 'project', projectId || null, `Print-ready PDF (${result.size}, ${result.pages} pages, ${bleedMm}mm bleed)`);
    sendDownload(res, outPath, filename);
  } catch (err) {
    console.error('[print] failed:', err);
    res.status(500).json({ error: String(err.message || err).slice(0, 500) });
  }
});

module.exports = router;
module.exports.siteStatic = siteStatic;
