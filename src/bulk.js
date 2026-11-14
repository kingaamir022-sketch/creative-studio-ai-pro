'use strict';
// Bulk runner (Phase 4) — drives bulk video/design batches through the
// Phase 3 render queue, one row at a time. No second renderer: every row
// becomes a normal render job (type 'bulk-row' / 'bulk-design-row') and the
// render worker reports back through onRowJobStarted / onRowJobFinished.
//
// DUPLICATE RULE (user, 2026-11-12): duplicate rows are PERMANENTLY skipped.
// Only the first copy of a row is ever generated — never at the start, never
// at the end, never after the unique rows finish. Skipped rows get no job,
// no output, no credit/usage count, and never appear in the retry list.
// Retry touches FAILED rows only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const credits = require('./credits');
const vm = require('./video-model');
const dm = require('./design-model');
const bm = require('./bulk-model');
const qm = require('./quiz-model');
const { probeMedia } = require('./ffmpeg');

const MAX_ROWS_HARD = 1000;
const MAX_DOWNLOAD_MB = 50;

function num(v, d = 0) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

function parseSettings(bulkJob) {
  let s = {};
  try { s = JSON.parse(bulkJob.settings || '{}'); } catch { s = {}; }
  return {
    fieldMapping: s.fieldMapping || {},
    mediaBindings: s.mediaBindings || {},
    designBindings: s.designBindings || [],
    backgroundClipId: s.backgroundClipId || null,
    background: {
      mode: 'random', poolMediaIds: [], categoryColumn: null, categoryMap: {},
      repeatRule: 'no-repeat', repeatAfterN: 5, manual: {}, column: null, promptColumn: null, aiPrompt: null,
      ...(s.background || {}),
    },
    readability: { enabled: true, overlayAlpha: 0.35, brandTint: false, ...(s.readability || {}) },
    backgroundAudio: Boolean(s.backgroundAudio),
    resolution: s.resolution || '720p',
    fps: s.fps || 30,
    format: s.format || 'png',
    outputNameTemplate: s.outputNameTemplate || '{{PRODUCT_NAME}}',
    maxRows: s.maxRows || 100,
    dedupe: { mode: 'whole-row', keyColumn: null, ...(s.dedupe || {}) },
    dedupeSummary: s.dedupeSummary || null,
    quiz: {
      enabled: false, mode: 'single', questionsPerVideo: 5,
      // Research spec defaults: 2s read + 3s countdown + 2s reveal per
      // question, 3s score card at the end.
      readSeconds: 2, timerSeconds: 3, revealSeconds: 2, ctaSeconds: 3,
      ctaText: 'Kitne sahi hue? Comment mein score likho', ctaSub: 'Follow for more quizzes',
      ...(s.quiz || {}),
    },
    // Batch-level uniform fonts (rule D), computed by checkRowFit and stored
    // so generation uses exactly the sizes the preview showed.
    quizFonts: s.quizFonts || null,
    uniformFonts: s.uniformFonts || {},
    // Voice (post-Phase-5 upgrade): one voice for the whole batch, picked
    // when the job is created; a row's VOICE column overrides it per row;
    // the user's default voice applies when neither is set. tts=true asks
    // the voice provider to speak the narration segments (needs a key —
    // without one the row fails with a clear key_needed error, never a
    // fake voice). tts=false (default) uses recorded NARRATION_AUDIO only.
    voice: { profileId: null, tts: false, ...(s.voice || {}) },
  };
}

function getQuizTemplateFields() {
  return {
    kind: 'video', quiz: true, project: null,
    scan: { fields: qm.QUIZ_COLUMNS.map((c) => ({ name: c, kind: c === 'QUESTION' ? 'text' : 'media', clipId: null, trackKind: 'quiz' })), textClips: [], mediaClips: [], backgroundClipId: null },
  };
}

// Parse one quiz question row, attaching its assigned background + image.
async function buildQuizQuestion(bulkJob, row, settings) {
  const rowData = JSON.parse(row.data || '{}');
  const q = qm.parseQuestion(rowData, row.row_index);
  const bgRow = db.getBulkRowAny(row.id);
  if (bgRow && bgRow.background_media_id) {
    const m = db.getMedia(bulkJob.user_id, bgRow.background_media_id);
    if (m) {
      q.backgroundMediaId = m.id; q.backgroundKind = m.kind;
      // Quality bar: measure the background (bright/busy) so the render can
      // auto-blur / darken it behind the text. Images are measured directly;
      // videos are measured from their thumbnail frame.
      const fp = m.kind === 'image'
        ? mediaFilePath(bulkJob.user_id, m.id)
        : (m.thumbnail ? path.join(config.uploadsDir, String(bulkJob.user_id), m.thumbnail) : null);
      if (fp && fs.existsSync(fp)) q.backgroundStats = await measureBackgroundStats(fp);
    }
  }
  if (q.imageValue) {
    const res = await resolveMediaValue(bulkJob.user_id, q.imageValue, { kinds: ['image'] });
    if (res) q.imageMediaId = res.mediaId;
  }
  // Recorded narration for this row (works now, no key): NARRATION_AUDIO
  // holds a Media Library audio id or the audio file's original name.
  if (q.narrationAudio) {
    const res = await resolveMediaValue(bulkJob.user_id, q.narrationAudio, { kinds: ['audio'] });
    if (res) q.narrationMediaId = res.mediaId;
  }
  // Spec: the countdown is identical every question, never <3s or >6s.
  if (settings.quiz.timerSeconds) q.timerSeconds = Math.max(3, Math.min(6, parseInt(settings.quiz.timerSeconds, 10) || q.timerSeconds));
  return q;
}

// --- Narration + voice (post-Phase-5 upgrade) -------------------------------
// Resolve the voice for one row: the row's VOICE column (profile name or
// id) beats the bulk job's voice, which beats the user's default voice.
function resolveVoiceForRow(userId, rowData, settings) {
  const voice = require('./voice');
  const rowVoice = rowData ? rowData.VOICE : '';
  return voice.resolveVoice(userId, rowVoice, settings.voice ? settings.voice.profileId : null);
}

// Attach narration audio to a built quiz timeline (mutates the timeline's
// audio track). One clip per round for recorded narration (the file plays
// from the round start, in the order it was recorded: question → options
// → answer). When settings.voice.tts is true, each narration segment is
// spoken by the resolved voice instead (provider synthesis, cached per
// voice+text) and placed at its segment time. Returns the voice report
// (which voice spoke each round, and how) for the job report.
async function attachQuizNarration(userId, built, questions, settings) {
  const voice = require('./voice');
  const audioTrack = (built.timeline.tracks || []).find((t) => t.kind === 'audio');
  const voiceUsed = [];
  if (!audioTrack) return { voiceUsed };
  for (const round of built.rounds || []) {
    const q = questions.find((x) => x.rowIndex === round.questionIndex) || questions[0];
    if (!q) continue;
    const { profile, source } = resolveVoiceForRow(userId, { VOICE: q.voice }, settings);
    const entry = {
      questionIndex: round.questionIndex,
      voiceProfileId: profile ? profile.id : null,
      voiceName: profile ? profile.name : null,
      voiceSource: source,
      audio: 'none',
    };
    if (q.narrationMediaId) {
      const m = db.getMedia(userId, q.narrationMediaId);
      if (m) {
        const dur = Math.max(0.5, Math.min(m.duration_seconds || round.duration, round.duration));
        const clip = vm.defaultClip('audio', m.id, round.start, dur);
        clip.name = 'Narration (recorded)';
        clip.fadeOut = 0.2;
        audioTrack.clips.push(clip);
        entry.audio = 'recorded';
        entry.narrationMediaId = m.id;
      }
    } else if (settings.voice && settings.voice.tts) {
      // No recorded narration — speak the segments with the resolved voice.
      // Without a key this throws a clear key_needed error (the row fails
      // visibly; nothing is faked).
      if (!profile) throw new Error('AI narration needs a voice: create a voice profile first, or record narration audio (NARRATION_AUDIO column).');
      const plan = round.narration;
      for (const seg of plan.segments) {
        const spoken = await voice.synthesizeSpeech(userId, profile, seg.text);
        const spokenMedia = db.getMedia(userId, spoken.mediaId);
        const audioDur = (spokenMedia && spokenMedia.duration_seconds) || seg.duration;
        const dur = Math.max(0.3, Math.min(audioDur, seg.duration));
        const clip = vm.defaultClip('audio', spoken.mediaId, seg.start, dur);
        clip.name = `Narration (${seg.label})`;
        clip.fadeOut = 0.1;
        audioTrack.clips.push(clip);
      }
      entry.audio = 'tts';
    }
    voiceUsed.push(entry);
  }
  audioTrack.clips.sort((a, b) => a.start - b.start);
  return { voiceUsed };
}

// Output size for a quiz render: resolution or explicit width/height.
function quizOutputSize(settings) {
  if (settings.width && settings.height) return { width: settings.width, height: settings.height };
  const res = settings.resolution === '1080p' ? 1080 : 720;
  return { width: res, height: Math.round(res * 16 / 9) };
}

// --- Uniform fonts, batch level (rule D) -----------------------------------
// One question font + one options font for the whole batch, set by the row
// with the longest text. A row whose own fit falls below the readable
// minimum is an OUTLIER: it is flagged "Needs attention" (with a shorter
// text suggestion) and the rest of the batch keeps its proper size — the
// batch font is never dragged below the minimum by one row.
function computeBatchQuizFonts(bulkJob) {
  const settings = parseSettings(bulkJob);
  const size = quizOutputSize(settings);
  const rows = db.listBulkRows(bulkJob.id).filter((r) => r.selected && r.status !== 'skipped');
  const reports = [];
  for (const row of rows) {
    try {
      const q = qm.parseQuestion(JSON.parse(row.data || '{}'), row.row_index);
      const L = qm.layoutRound(q, { W: size.width, H: size.height, hasImage: Boolean(q.imageValue) });
      reports.push({ rowIndex: row.row_index, report: L.fitReport });
    } catch { /* unparsable rows fail at build time with their own error */ }
  }
  if (!reports.length) return null;
  const mins = qm.minFontsFor(size.width);
  const pick = (key, min) => {
    const ok = reports.filter((r) => r.report[key] >= min);
    return ok.length ? Math.min(...ok.map((r) => r.report[key])) : min;
  };
  return {
    question: pick('questionFont', mins.question),
    option: pick('optionFont', mins.option),
    explanation: pick('explanationFont', mins.explanation),
    outliers: reports.filter((r) => r.report.outlier)
      .map((r) => ({ rowIndex: r.rowIndex, suggestedText: r.report.suggestedText, issues: r.report.issues })),
  };
}

// Same rule for non-quiz video templates: every text element bound to one
// {{FIELD}} shares one font across the batch (set by the longest value).
function computeBatchUniformFonts(bulkJob) {
  const settings = parseSettings(bulkJob);
  const project = db.getProject(bulkJob.user_id, bulkJob.template_project_id);
  if (!project) return null;
  const timeline = extractTimeline(project);
  const scan = bm.scanVideoTemplate(timeline);
  const rows = db.listBulkRows(bulkJob.id).filter((r) => r.selected && r.status !== 'skipped');
  if (!rows.length || !scan.textClips.length) return null;
  const W = timeline.width || 1080;
  const fonts = {};
  const outliers = [];
  const fields = [...new Set(scan.textClips.flatMap((c) => c.fields))];
  for (const field of fields) {
    const clips = scan.textClips.filter((c) => c.fields.includes(field));
    const fits = [];
    for (const clip of clips) {
      const fb = clip.fitBox || {};
      const maxW = ((fb.maxWidthPct ?? 90) / 100) * W;
      const maxLines = fb.maxLines ?? 3;
      const minFont = Math.max(8, Math.round((fb.minFontRender ?? 22) * (1080 / W)));
      const baseFont = clip.fontSize || 48;
      for (const row of rows) {
        const data = JSON.parse(row.data || '{}');
        const col = settings.fieldMapping[field];
        const text = col !== undefined ? String(data[col] ?? '') : '';
        if (!text) continue;
        const f = qm.fitText(text, maxW, { maxFont: baseFont, minFont, maxLines });
        fits.push({ rowIndex: row.row_index, clipId: clip.clipId, fit: f, minFont });
        if (f.fontSize < minFont) {
          outliers.push({ rowIndex: row.row_index, field, clipId: clip.clipId, suggestedText: f.suggestedText });
        }
      }
    }
    if (!fits.length) continue;
    const ok = fits.filter((x) => x.fit.fontSize >= x.minFont);
    fonts[field] = ok.length ? Math.min(...ok.map((x) => x.fit.fontSize)) : Math.min(...fits.map((x) => x.minFont));
  }
  return { fonts, outliers };
}

// Pre-flight fit check (rule C): measure every text element of every unique
// row against its box BEFORE any render, compute the batch uniform fonts,
// store a per-row fit report, and return a summary. Nothing here renders.
async function checkRowFit(bulkJob) {
  const settings = parseSettings(bulkJob);
  let quizFonts = null;
  let uniformFonts = null;
  if (bulkJob.kind === 'video' && settings.quiz.enabled) quizFonts = computeBatchQuizFonts(bulkJob);
  if (bulkJob.kind === 'video' && !settings.quiz.enabled) uniformFonts = computeBatchUniformFonts(bulkJob);
  const merged = JSON.parse(bulkJob.settings || '{}');
  if (quizFonts) merged.quizFonts = quizFonts;
  if (uniformFonts) merged.uniformFonts = uniformFonts.fonts;
  // updateBulkJob stringifies settings itself — pass the object, not a string.
  db.updateBulkJob(bulkJob.id, { settings: merged });

  const rows = db.listBulkRows(bulkJob.id).filter((r) => r.selected && r.status !== 'skipped');
  const reports = [];
  for (const row of rows) {
    let fitReport = null;
    try {
      const rowData = JSON.parse(row.data || '{}');
      if (bulkJob.kind === 'video' && settings.quiz.enabled) {
        const q = await buildQuizQuestion(bulkJob, row, settings);
        const size = quizOutputSize(settings);
        const L = qm.layoutRound(q, {
          W: size.width, H: size.height,
          hasImage: Boolean(q.imageMediaId || q.imageValue), fonts: quizFonts,
        });
        fitReport = L.fitReport;
      } else if (bulkJob.kind === 'video') {
        const project = db.getProject(bulkJob.user_id, bulkJob.template_project_id);
        if (!project) throw new Error('Template project not found.');
        const built = bm.buildRowTimeline(extractTimeline(project), rowData, {
          fieldMapping: settings.fieldMapping,
          uniformFonts: uniformFonts ? uniformFonts.fonts : {},
        });
        fitReport = built.fitReport;
      } else if (bulkJob.kind === 'design') {
        const project = db.getProject(bulkJob.user_id, bulkJob.template_project_id);
        if (!project) throw new Error('Template project not found.');
        const sub = bm.substituteDesign(extractDesign(project), rowData, {
          fieldMapping: settings.fieldMapping, bindings: settings.designBindings,
        });
        fitReport = sub.fitReport;
      }
    } catch (err) {
      fitReport = { overall: 'Needs attention', elements: [], outlier: true, suggestedText: null, safeZoneOk: false, error: String(err.message).slice(0, 200) };
    }
    if (fitReport) {
      db.updateBulkRow(row.id, { fit_report: JSON.stringify(fitReport) });
      reports.push({ rowId: row.id, rowIndex: row.row_index, fitReport });
    }
  }
  const counts = { ok: 0, adjusted: 0, attention: 0 };
  for (const r of reports) {
    if (r.fitReport.overall === 'OK') counts.ok++;
    else if (r.fitReport.overall === 'Adjusted') counts.adjusted++;
    else counts.attention++;
  }
  return { rows: reports, counts, quizFonts, uniformFonts };
}

function mediaFilePath(userId, mediaId) {
  const m = db.getMedia(userId, mediaId);
  if (!m) return null;
  return path.join(config.uploadsDir, String(userId), m.stored_name);
}

function extractTimeline(project) {
  let content = {};
  try { content = JSON.parse(project.content || '{}'); } catch { throw new Error('Template project content is not valid JSON.'); }
  const tl = content.timeline || content;
  const errors = vm.validateTimeline(tl);
  if (errors.length) throw new Error(`Template timeline is invalid: ${errors.join(' ')}`);
  return tl;
}

function extractDesign(project) {
  let content = {};
  try { content = JSON.parse(project.content || '{}'); } catch { throw new Error('Template project content is not valid JSON.'); }
  const design = content.design || content;
  const { ok, errors } = dm.validateDesign(design);
  if (!ok) throw new Error(`Template design is invalid: ${errors.join(' ')}`);
  return design;
}

function getTemplateFields(userId, projectId) {
  const project = db.getProject(userId, projectId);
  if (!project) return null;
  if (project.type === 'video') {
    const timeline = extractTimeline(project);
    return { kind: 'video', project, scan: bm.scanVideoTemplate(timeline) };
  }
  if (project.type === 'design') {
    const design = extractDesign(project);
    return { kind: 'design', project, scan: bm.scanDesignTemplate(design) };
  }
  return { kind: project.type, project, scan: { fields: [] } };
}

// --- Media resolution ------------------------------------------------------
// A cell value resolves to library media by: numeric media id, exact file
// name in the user's library, a /api/media/<id>/file URL, or a public
// http(s) URL (downloaded once, stored in the library with tag
// 'bulk-download'). Returns { mediaId, kind } or null when unresolvable.
async function resolveMediaValue(userId, value, { kinds = ['image', 'video', 'audio'] } = {}) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  const urlMatch = str.match(/\/api\/media\/(\d+)\/file/);
  const idNum = urlMatch ? parseInt(urlMatch[1], 10) : (/^\d+$/.test(str) ? parseInt(str, 10) : null);
  if (idNum !== null) {
    const m = db.getMedia(userId, idNum);
    if (m && kinds.includes(m.kind)) return { mediaId: m.id, kind: m.kind };
    return null;
  }
  if (/^https?:\/\//i.test(str)) return downloadMedia(userId, str, kinds);
  // Exact file-name match in the user's library.
  const all = db.listMedia(userId, {});
  const hit = all.find((m) => m.original_name === str && kinds.includes(m.kind));
  if (hit) return { mediaId: hit.id, kind: hit.kind };
  return null;
}

async function downloadMedia(userId, url, kinds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    clearTimeout(timer);
    return null;
  }
  clearTimeout(timer);
  if (!res.ok) return null;
  const ctype = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const kind = ctype.startsWith('image/') ? 'image' : ctype.startsWith('video/') ? 'video' : ctype.startsWith('audio/') ? 'audio' : null;
  if (!kind || !kinds.includes(kind)) return null;
  const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/wav': '.wav' };
  let ext = extMap[ctype] || '';
  if (!ext) {
    const m = url.split('?')[0].match(/(\.[a-z0-9]{2,5})$/i);
    ext = m ? m[1].toLowerCase() : (kind === 'image' ? '.jpg' : kind === 'video' ? '.mp4' : '.mp3');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_DOWNLOAD_MB * 1024 * 1024) return null;
  const storedName = `bulk-dl-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)}-${Date.now()}${ext}`;
  const userDir = path.join(config.uploadsDir, String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, storedName), buf);
  const base = decodeURIComponent(url.split('?')[0].split('/').pop() || 'downloaded-media');
  const m = db.createMedia(userId, {
    originalName: base.slice(0, 120) || 'downloaded-media',
    storedName, mimeType: ctype || 'application/octet-stream', kind,
    sizeBytes: buf.length, tags: 'bulk-download',
  });
  return { mediaId: m.id, kind };
}

// Mean luminance (0..1) of an image via FFmpeg signalstats. Null on failure.
async function measureLuminance(filePath) {
  try {
    const { execFile } = require('child_process');
    const out = await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-v', 'info', '-i', filePath, '-vf', 'signalstats', '-f', 'null', '-'],
        { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) return reject(err);
          resolve(`${stdout || ''}\n${stderr || ''}`);
        });
    });
    const vals = [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => parseFloat(m[1]));
    if (!vals.length) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.max(0, Math.min(1, mean));
  } catch { return null; }
}

// Background quality stats (viewer quality bar): luminance (bright/dark)
// + edge density (busy/cluttered). A busy background gets an automatic
// blur + a stronger dark overlay so the text never fights the background.
// Returns { luminance, edgeDensity, busy } or null on failure.
async function measureBackgroundStats(filePath) {
  try {
    const { execFile } = require('child_process');
    const out = await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-v', 'info', '-i', filePath, '-vf', 'edgedetect,signalstats', '-frames:v', '1', '-f', 'null', '-'],
        { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) return reject(err);
          resolve(`${stdout || ''}\n${stderr || ''}`);
        });
    });
    const vals = [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => parseFloat(m[1]));
    if (!vals.length) return null;
    const edgeDensity = vals.reduce((a, b) => a + b, 0) / vals.length;
    const luminance = await measureLuminance(filePath);
    return { luminance, edgeDensity, busy: edgeDensity > 0.06 };
  } catch { return null; }
}

// --- Dedupe ----------------------------------------------------------------
// (Re)classifies rows as queued/skipped for the current dedupe settings.
// Draft jobs only. Returns the dedupe summary.
function applyDedupe(bulkJob) {
  const dataset = JSON.parse(bulkJob.dataset || '{"columns":[],"rows":[]}');
  const settings = parseSettings(bulkJob);
  const cols = bm.dedupeColumns(dataset.columns, settings.fieldMapping);
  const res = bm.dedupeRows(dataset.rows, { mode: settings.dedupe.mode, keyColumn: settings.dedupe.keyColumn, columns: cols });
  const skippedSet = new Map(res.skipped.map((s) => [s.rowIndex, s]));
  for (const r of db.listBulkRows(bulkJob.id)) {
    if (['done', 'rendering'].includes(r.status)) continue; // never touch live/finished rows
    const sk = skippedSet.get(r.row_index);
    if (sk) {
      db.updateBulkRow(r.id, {
        status: 'skipped', error: null, output_job_id: null, output_path: null,
        warnings: [`Duplicate of row ${sk.duplicateOfRowNumber} — skipped. Only the first copy is generated.`],
      });
    } else if (r.status === 'skipped') {
      db.updateBulkRow(r.id, { status: 'queued', warnings: [] });
    }
  }
  const summary = {
    total: dataset.rows.length, unique: res.unique.length, skipped: res.skipped.length,
    skippedRows: res.skipped, mode: settings.dedupe.mode,
    keyColumn: settings.dedupe.keyColumn || null, columns: cols,
  };
  settings.dedupeSummary = summary;
  db.updateBulkJob(bulkJob.id, { settings });
  db.refreshBulkJobCounts(bulkJob.id);
  return summary;
}

// --- Background assignment -------------------------------------------------
// AI prompt for 'ai' mode: the user's template with {{FIELD}} substitution,
// or a prompt built from the row's own text fields when no template is set.
function aiPromptForRow(bg, row) {
  const template = String(bg.aiPrompt || '').trim();
  if (template) {
    return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, col) => String(row[col] ?? '').trim());
  }
  const texts = Object.entries(row)
    .filter(([k, v]) => v !== undefined && v !== null && String(v).trim() && !/^(BACKGROUND_PROMPT|BACKGROUND_IMAGE)$/i.test(k))
    .map(([, v]) => String(v).trim());
  const subject = texts.slice(0, 2).join(', ') || 'product';
  return `A clean professional background scene for "${subject}", photographic, well lit, no text, no watermark`;
}

async function assignBackgroundsForJob(bulkJob) {
  const settings = parseSettings(bulkJob);
  const bg = settings.background;
  const mode = bg.mode || 'random';
  if (mode === 'ai' || mode === 'prompt') {
    // Phase 7: REAL AI backgrounds via the image provider (cached per
    // prompt, so the same prompt is never generated twice). Without a key
    // this throws PROVIDER_KEY_NEEDED naming Phase 7 — the batch refuses
    // to start, never a silent fallback to pool images.
    const ai = require('./ai');
    const active = db.listBulkRows(bulkJob.id)
      .filter((r) => r.selected && r.status !== 'skipped' && r.status !== 'done');
    if (!active.length) throw new Error('No rows to assign backgrounds to.');
    for (const row of active) {
      const data = JSON.parse(row.data || '{}');
      let prompt = null;
      if (mode === 'prompt') {
        const col = bg.promptColumn || 'BACKGROUND_PROMPT';
        prompt = String(data[col] ?? '').trim();
        if (!prompt) {
          db.updateBulkRow(row.id, { status: 'failed', error: `No prompt in column "${col}" for this row (row ${row.row_index + 1}). Fill the column or switch background modes.` });
          continue;
        }
      } else {
        prompt = aiPromptForRow(bg, data);
      }
      const gen = await ai.generateAiBackground(bulkJob.user_id, prompt);
      db.updateBulkRow(row.id, {
        background_media_id: gen.media.id, background_source: mode,
        background_prompt: prompt,
        warnings: gen.cached ? ['Background reused from cache (same prompt as an earlier row).'] : [],
      });
    }
    db.refreshBulkJobCounts(bulkJob.id);
    return;
  }
  const active = db.listBulkRows(bulkJob.id)
    .filter((r) => r.selected && r.status !== 'skipped' && r.status !== 'done');
  if (!active.length) throw new Error('No rows to assign backgrounds to.');
  // Validate pool media (must exist, belong to the user, be image/video).
  const validPool = [];
  for (const id of bg.poolMediaIds || []) {
    const m = db.getMedia(bulkJob.user_id, id);
    if (m && (m.kind === 'image' || m.kind === 'video')) validPool.push(m.id);
  }
  const dataRows = active.map((r) => JSON.parse(r.data || '{}'));
  let opts = { mode, pool: validPool, categoryColumn: bg.categoryColumn, categoryMap: bg.categoryMap || {}, repeatRule: bg.repeatRule || 'no-repeat', repeatAfterN: bg.repeatAfterN || 5 };
  // C-16: a quiz batch has a spec solid-navy background, so it never needs a
  // pool. With no pool at all (and no manual assignments), leave rows
  // unassigned — buildRowJobPayload renders them on solid navy with a
  // warning — instead of refusing to run. (Non-quiz video batches still
  // refuse: a template video needs a background.)
  const manualAssigned = mode === 'manual' && bg.manual && Object.keys(bg.manual).length > 0;
  if (settings.quiz && settings.quiz.enabled && !validPool.length && (mode === 'random' || mode === 'pool' || (mode === 'manual' && !manualAssigned))) {
    for (const r of active) db.updateBulkRow(r.id, { background_media_id: null, background_source: null });
    db.refreshBulkJobCounts(bulkJob.id);
    return;
  }
  if (mode === 'manual') {
    const manualPos = {};
    active.forEach((r, i) => { if (bg.manual && bg.manual[r.row_index]) manualPos[i] = bg.manual[r.row_index]; });
    opts.manual = manualPos;
  }
  if (mode === 'column') {
    if (!bg.column) throw new Error('Background mode "From a column" needs a background column. Pick the column that holds the background media.');
    const columnMediaIds = {};
    const assignable = [];
    for (let i = 0; i < active.length; i++) {
      const val = dataRows[i][bg.column];
      const res = (val !== undefined && val !== null && String(val) !== '')
        ? await resolveMediaValue(bulkJob.user_id, val, { kinds: ['image', 'video'] }) : null;
      if (res) { columnMediaIds[assignable.length] = res.mediaId; assignable.push(active[i]); }
      else {
        db.updateBulkRow(active[i].id, { status: 'failed', error: `No background media found in column "${bg.column}" for this row (value: "${String(val ?? '').slice(0, 60)}").` });
      }
    }
    if (!assignable.length) throw new Error(`No row has a usable background in column "${bg.column}".`);
    const assignments = bm.assignBackgrounds(assignable.map((r) => JSON.parse(r.data || '{}')), { ...opts, columnMediaIds });
    assignments.forEach((a, i) => {
      db.updateBulkRow(assignable[i].id, { background_media_id: a.mediaId, background_source: a.source, warnings: a.warning ? [a.warning] : [] });
    });
    db.refreshBulkJobCounts(bulkJob.id);
    return;
  }
  const assignments = bm.assignBackgrounds(dataRows, opts);
  assignments.forEach((a, i) => {
    db.updateBulkRow(active[i].id, { background_media_id: a.mediaId, background_source: a.source, warnings: a.warning ? [a.warning] : [] });
  });
  db.refreshBulkJobCounts(bulkJob.id);
}

// --- Row payload -----------------------------------------------------------
async function buildRowJobPayload(bulkJob, row) {
  const settings = parseSettings(bulkJob);
  const rowData = JSON.parse(row.data || '{}');
  const brand = bulkJob.brand_id ? db.getBrand(bulkJob.user_id, bulkJob.brand_id) : null;

  // Quiz preset, single-question mode: one row = one 10s video (spec defaults).
  if (bulkJob.kind === 'video' && settings.quiz.enabled && settings.quiz.mode !== 'multi') {
    const q = await buildQuizQuestion(bulkJob, row, settings);
    // C-16: no background assigned ⇒ solid spec background (navy #14213D).
    // The quiz timeline renders a gap as the solid background colour, so a
    // fresh batch works out of the box; the row is warned, not refused.
    const fallbackWarnings = [];
    if (!q.backgroundMediaId) fallbackWarnings.push('No background assigned — using the solid navy background (#14213D). Pick a background pool to use images or video instead.');
    const size = quizOutputSize(settings);
    const built = qm.buildQuizTimeline([q], {
      W: size.width, H: size.height, fps: [24, 30, 60].includes(settings.fps) ? settings.fps : 30,
      readSeconds: settings.quiz.readSeconds,
      revealSeconds: settings.quiz.revealSeconds, ctaSeconds: settings.quiz.ctaSeconds,
      ctaText: settings.quiz.ctaText, ctaSub: settings.quiz.ctaSub,
      fonts: settings.quizFonts || undefined,
      brandColor: brand && brand.primary_color ? brand.primary_color : undefined,
      animations: settings.quiz.animations || undefined,
    });
    const narration = await attachQuizNarration(bulkJob.user_id, built, [q], settings);
    const ext = 'mp4';
    return {
      type: 'bulk-row',
      payload: {
        timeline: built.timeline,
        settings: { width: size.width, height: size.height, fps: [24, 30, 60].includes(settings.fps) ? settings.fps : 30 },
      },
      outputName: bm.outputFileName(settings.outputNameTemplate, rowData, settings.fieldMapping, row.row_index, ext),
      backgroundMediaId: q.backgroundMediaId, backgroundSource: db.getBulkRowAny(row.id).background_source,
      warnings: [...fallbackWarnings, ...built.warnings], luminance: null,
      fitReport: built.fitReports[0] || null,
      fonts: built.fonts,
      voiceUsed: narration.voiceUsed,
      narration: built.narration,
    };
  }

  if (bulkJob.kind === 'design') {
    const project = db.getProject(bulkJob.user_id, bulkJob.template_project_id);
    if (!project) throw new Error('Template project not found.');
    const design = extractDesign(project);
    const resolvedImages = {};
    const warnings = [];
    for (const b of settings.designBindings || []) {
      if (b.kind !== 'image' || !b.column) continue;
      const val = rowData[b.column];
      if (val === undefined || val === null || String(val) === '') continue;
      const res = await resolveMediaValue(bulkJob.user_id, val, { kinds: ['image'] });
      if (res) resolvedImages[b.layerId] = { mediaId: res.mediaId, src: `/api/media/${res.mediaId}/file` };
      else warnings.push(`Could not resolve the image for a layer from column "${b.column}" ("${String(val).slice(0, 60)}"); kept the template image.`);
    }
    const sub = bm.substituteDesign(design, rowData, {
      fieldMapping: settings.fieldMapping, bindings: settings.designBindings, resolvedImages,
    });
    const ext = settings.format === 'jpg' ? 'jpg' : 'png';
    return {
      type: 'bulk-design-row',
      payload: { design: sub.design, format: ext },
      outputName: bm.outputFileName(settings.outputNameTemplate, rowData, settings.fieldMapping, row.row_index, ext),
      backgroundMediaId: null, backgroundSource: null,
      warnings: [...warnings, ...sub.warnings], luminance: null,
      fitReport: sub.fitReport,
    };
  }

  // Video.
  const project = db.getProject(bulkJob.user_id, bulkJob.template_project_id);
  if (!project) throw new Error('Template project not found.');
  const timeline = extractTimeline(project);
  const scan = bm.scanVideoTemplate(timeline);
  const resolvedMedia = {};
  const warnings = [];
  for (const mc of scan.mediaClips) {
    const col = (settings.mediaBindings && settings.mediaBindings[mc.clipId]) || settings.fieldMapping[mc.field];
    const val = col !== undefined ? rowData[col] : undefined;
    if (val === undefined || val === null || String(val) === '') {
      if (mc.field === 'LOGO' && brand && brand.logo_media_id) {
        resolvedMedia[mc.field] = { mediaId: brand.logo_media_id, kind: 'image' };
      }
      continue;
    }
    const kinds = mc.kind === 'audio' ? ['audio', 'video'] : ['video', 'image'];
    const res = await resolveMediaValue(bulkJob.user_id, val, { kinds });
    if (res) resolvedMedia[mc.field] = res;
    else warnings.push(`Could not resolve ${mc.field} ("${String(val).slice(0, 60)}") to a media file; kept the template's media.`);
  }
  const bgRow = db.getBulkRowAny(row.id);
  let background = null;
  if (bgRow && bgRow.background_media_id) {
    const m = db.getMedia(bulkJob.user_id, bgRow.background_media_id);
    if (m) background = { mediaId: m.id, kind: m.kind };
  }
  // C-16: no background assigned ⇒ fall back to the template's own
  // background media (or a solid-colour gap when the template has none),
  // with a warning — the batch refuses only when nothing can render.
  if (!background) warnings.push('No background assigned — using the template\u2019s own background. Pick a background pool to give each row its own background.');
  const built = bm.buildRowTimeline(timeline, rowData, {
    fieldMapping: settings.fieldMapping, resolvedMedia, background,
    backgroundClipId: settings.backgroundClipId || scan.backgroundClipId,
    backgroundMuted: !settings.backgroundAudio,
    uniformFonts: settings.uniformFonts || {},
  });
  warnings.push(...built.warnings);
  let overlayAlpha = settings.readability && settings.readability.enabled === false
    ? 0 : num(settings.readability ? settings.readability.overlayAlpha : 0.35, 0.35);
  let luminance = null;
  if (background && background.kind === 'image' && settings.readability && settings.readability.enabled !== false) {
    const fp = mediaFilePath(bulkJob.user_id, background.mediaId);
    if (fp) {
      const stats = await measureBackgroundStats(fp);
      if (stats) {
        luminance = stats.luminance;
        if (luminance > 0.65) overlayAlpha = Math.min(0.6, overlayAlpha + 0.2);
        else if (luminance < 0.3) overlayAlpha = Math.max(0.1, overlayAlpha - 0.15);
        // Busy background: auto-blur the background clip + a stronger overlay
        // so the text stays readable (viewer quality bar).
        if (stats.busy) {
          overlayAlpha = Math.min(0.6, overlayAlpha + 0.1);
          const bgId = settings.backgroundClipId || scan.backgroundClipId;
          for (const tr of built.timeline.tracks || []) {
            for (const c of tr.clips || []) {
              if (c.id === bgId && c.filters) c.filters.blur = 2;
            }
          }
        }
      }
    }
  }
  const readabilityColor = settings.readability && settings.readability.brandTint && brand
    ? brand.primary_color : '#000000';
  const fps = [24, 30, 60].includes(settings.fps) ? settings.fps : 30;
  return {
    type: 'bulk-row',
    payload: {
      timeline: built.timeline,
      settings: { resolution: settings.resolution === '1080p' ? '1080p' : '720p', fps, readabilityOverlay: overlayAlpha, readabilityColor },
    },
    outputName: bm.outputFileName(settings.outputNameTemplate, rowData, settings.fieldMapping, row.row_index, 'mp4'),
    backgroundMediaId: background ? background.mediaId : null, backgroundSource: bgRow.background_source,
    warnings, luminance,
    fitReport: built.fitReport,
  };
}

// Quiz multi-question mode: one video per group of N questions.
async function buildQuizGroupPayload(bulkJob, groupRows) {
  const settings = parseSettings(bulkJob);
  const questions = [];
  for (const r of groupRows) questions.push(await buildQuizQuestion(bulkJob, r, settings));
  // C-16: questions without a background render on the solid navy
  // background instead of refusing the whole group.
  const missing = questions.filter((q) => !q.backgroundMediaId);
  const groupWarnings = missing.length
    ? [`${missing.length} question(s) have no background assigned — using the solid navy background (#14213D). Pick a background pool to use images or video instead.`]
    : [];
  const size = quizOutputSize(settings);
  const brand = bulkJob.brand_id ? db.getBrand(bulkJob.user_id, bulkJob.brand_id) : null;
  const built = qm.buildQuizTimeline(questions, {
    W: size.width, H: size.height, fps: [24, 30, 60].includes(settings.fps) ? settings.fps : 30,
    readSeconds: settings.quiz.readSeconds,
    revealSeconds: settings.quiz.revealSeconds, ctaSeconds: settings.quiz.ctaSeconds,
    ctaText: settings.quiz.ctaText, ctaSub: settings.quiz.ctaSub,
    fonts: settings.quizFonts || undefined,
    brandColor: brand && brand.primary_color ? brand.primary_color : undefined,
    animations: settings.quiz.animations || undefined,
  });
  const narration = await attachQuizNarration(bulkJob.user_id, built, questions, settings);
  const firstData = JSON.parse(groupRows[0].data || '{}');
  return {
    type: 'bulk-row',
    payload: {
      timeline: built.timeline,
      settings: { width: size.width, height: size.height, fps: [24, 30, 60].includes(settings.fps) ? settings.fps : 30 },
    },
    outputName: bm.outputFileName(`Quiz ${groupRows[0].row_index + 1}-${groupRows[groupRows.length - 1].row_index + 1}`, firstData, {}, 0, 'mp4'),
    backgroundMediaId: questions[0].backgroundMediaId,
    backgroundSource: db.getBulkRowAny(groupRows[0].id).background_source,
    warnings: [...groupWarnings, ...built.warnings], luminance: null,
    // Fit reports keyed by the row's data index (rounds are sorted easiest-first).
    fitReports: built.rounds.map((r) => ({ rowIndex: r.questionIndex, fitReport: r.fitReport })),
    fonts: built.fonts,
    voiceUsed: narration.voiceUsed,
    narration: built.narration,
  };
}

// --- Runner ----------------------------------------------------------------
async function advanceBulkJob(bulkJobId) {
  const job = db.getBulkJobAny(bulkJobId);
  if (!job || job.status !== 'running') return;
  const settings = parseSettings(job);
  const rows = db.listBulkRows(bulkJobId);

  // Quiz multi-question mode: one video per group of N queued questions.
  if (job.kind === 'video' && settings.quiz.enabled && settings.quiz.mode === 'multi') {
    const group = rows.filter((r) => r.selected && r.status === 'queued')
      .slice(0, Math.max(2, Math.min(10, parseInt(settings.quiz.questionsPerVideo, 10) || 5)));
    if (!group.length) { await finalizeBulkJob(bulkJobId); return; }
    if (group[0].output_job_id) {
      const j = db.getJobAny(group[0].output_job_id);
      if (j && (j.status === 'queued' || j.status === 'running')) return; // still in flight
    }
    try {
      const built = await buildQuizGroupPayload(job, group);
      const created = db.createJob(job.user_id, {
        type: built.type, projectId: job.template_project_id,
        payload: { ...built.payload, bulkJobId: job.id, bulkRowIds: group.map((r) => r.id) },
      });
      for (const r of group) {
        const fr = (built.fitReports || []).find((x) => x.rowIndex === r.row_index);
        db.updateBulkRow(r.id, {
          output_job_id: created.id, output_name: built.outputName,
          warnings: built.warnings,
          fit_report: fr ? JSON.stringify(fr.fitReport) : undefined,
        });
      }
    } catch (err) {
      for (const r of group) db.updateBulkRow(r.id, { status: 'failed', error: String(err.message).slice(0, 1000) });
      db.refreshBulkJobCounts(bulkJobId);
      return advanceBulkJob(bulkJobId);
    }
    return;
  }

  const next = rows.find((r) => r.selected && r.status === 'queued');
  if (!next) { await finalizeBulkJob(bulkJobId); return; }
  if (next.output_job_id) {
    const j = db.getJobAny(next.output_job_id);
    if (j && (j.status === 'queued' || j.status === 'running')) return; // still in flight; its completion hook advances
  }
  try {
    const built = await buildRowJobPayload(job, next);
    const created = db.createJob(job.user_id, {
      type: built.type, projectId: job.template_project_id,
      payload: { ...built.payload, bulkJobId: job.id, bulkRowId: next.id },
    });
    db.updateBulkRow(next.id, {
      output_job_id: created.id, output_name: built.outputName,
      background_media_id: built.backgroundMediaId ?? next.background_media_id,
      background_source: built.backgroundSource ?? next.background_source,
      warnings: built.warnings, luminance: built.luminance ?? null,
      fit_report: built.fitReport ? JSON.stringify(built.fitReport) : undefined,
    });
  } catch (err) {
    db.updateBulkRow(next.id, { status: 'failed', error: String(err.message).slice(0, 1000) });
    db.refreshBulkJobCounts(bulkJobId);
    return advanceBulkJob(bulkJobId);
  }
}

async function finalizeBulkJob(bulkJobId) {
  const counts = db.refreshBulkJobCounts(bulkJobId);
  const job = db.getBulkJobAny(bulkJobId);
  if (!job || job.status !== 'running') return;
  const settings = parseSettings(job);
  const skipped = settings.dedupeSummary ? settings.dedupeSummary.skipped : 0;
  const status = counts.failed === 0 ? 'done' : (counts.done === 0 ? 'failed' : 'partial');
  db.updateBulkJob(bulkJobId, { status });
  db.audit(job.user_id, 'bulk_finished', 'bulk_job', bulkJobId,
    `Bulk job "${job.name}" finished: ${counts.done} done, ${counts.failed} failed, ${skipped} duplicates skipped.`);
}

async function startBulkJob(userId, bulkJobId) {
  const job = db.getBulkJob(userId, bulkJobId);
  if (!job) throw new Error('Bulk job not found.');
  if (job.status === 'running') throw new Error('This batch is already running.');
  if (!['draft', 'partial', 'failed', 'cancelled'].includes(job.status)) {
    throw new Error(`Cannot start a batch in status "${job.status}".`);
  }
  const dataset = JSON.parse(job.dataset || '{"columns":[],"rows":[]}');
  if (!dataset.rows || !dataset.rows.length) throw new Error('No data rows yet. Import a spreadsheet (XLSX/CSV/JSON) or add rows manually first.');
  const settings = parseSettings(job);
  // C-01 pre-flight: every template field must resolve to a spreadsheet
  // column — via the explicit mapping or the same-name fallback. Refuse
  // up front with the field names instead of rendering blank text.
  if (!(job.kind === 'video' && settings.quiz.enabled)) {
    const project = db.getProject(userId, job.template_project_id);
    if (project) {
      let fields = [];
      try {
        fields = job.kind === 'design'
          ? bm.scanDesignTemplate(extractDesign(project)).fields
          : bm.scanVideoTemplate(extractTimeline(project)).fields;
      } catch { fields = []; }
      const columns = dataset.columns || [];
      const unresolved = fields.filter((f) => {
        const mapped = settings.fieldMapping[f.name];
        if (mapped && columns.includes(mapped)) return false;
        return !columns.some((c) => bm.normField(c) === f.name);
      }).map((f) => f.name);
      if (unresolved.length) {
        throw new Error(`Template fields with no spreadsheet column: ${unresolved.map((f) => `{{${f}}}`).join(', ')} — map them in Step 1 (Template & field mapping) or add a same-name column to the spreadsheet. Nothing was generated.`);
      }
    }
  }
  const maxRows = Math.max(1, Math.min(MAX_ROWS_HARD, parseInt(settings.maxRows || '100', 10)));
  const selected = db.listBulkRows(bulkJobId).filter((r) => r.selected && r.status !== 'skipped');
  if (!selected.length) {
    const skipped = settings.dedupeSummary ? settings.dedupeSummary.skipped : 0;
    throw new Error(`No unique rows to generate${skipped ? ` — all ${dataset.rows.length} rows were skipped as duplicates (${skipped} duplicates)` : ''}. Import data with unique rows first.`);
  }
  if (selected.length > maxRows) {
    throw new Error(`This batch has ${selected.length} unique rows, over the ${maxRows}-row limit. Raise the limit in Settings (max ${MAX_ROWS_HARD}) or split the batch.`);
  }
  // (Re)assign backgrounds for video batches; design batches skip this.
  // AI modes are handled inside assignBackgroundsForJob (Phase 7: real
  // generation; without a key it throws and the batch refuses to start).
  if (job.kind === 'video') await assignBackgroundsForJob(job);
  const afterAssign = db.listBulkRows(bulkJobId).filter((r) => r.selected && r.status === 'queued');
  if (!afterAssign.length) throw new Error('No rows left to generate after background assignment (every row failed assignment). Check the row errors.');
  // Pre-flight fit check: batch uniform fonts + per-row fit reports, so the
  // renders use exactly the sizes the preview showed.
  await checkRowFit(db.getBulkJob(userId, bulkJobId));
  const skipped = settings.dedupeSummary ? settings.dedupeSummary.skipped : 0;
  db.updateBulkJob(bulkJobId, { status: 'running' });
  db.refreshBulkJobCounts(bulkJobId);
  db.audit(userId, 'bulk_started', 'bulk_job', bulkJobId,
    `Bulk job "${job.name}" started: ${afterAssign.length} unique rows, ${skipped} duplicates skipped.`);
  await advanceBulkJob(bulkJobId);
  return db.getBulkJob(userId, bulkJobId);
}

function onRowJobStarted(job) {
  let payload = {};
  try { payload = JSON.parse(job.payload || '{}'); } catch { /* ignore */ }
  const rowIds = payload.bulkRowIds || (payload.bulkRowId ? [payload.bulkRowId] : []);
  for (const id of rowIds) {
    const row = db.getBulkRowAny(id);
    if (row && row.status === 'queued') db.updateBulkRow(row.id, { status: 'rendering' });
  }
}

async function onRowJobFinished(job, status, extra = {}) {
  let payload = {};
  try { payload = JSON.parse(job.payload || '{}'); } catch { /* ignore */ }
  if ((!payload.bulkRowId && !payload.bulkRowIds) || !payload.bulkJobId) return;
  const rowIds = payload.bulkRowIds || [payload.bulkRowId];
  const rows = rowIds.map((id) => db.getBulkRowAny(id)).filter(Boolean);
  if (!rows.length) return;
  try {
    for (const row of rows) {
      if (status === 'done') {
        const j = db.getJobAny(job.id);
        const prevWarnings = JSON.parse(row.warnings || '[]');
        const merged = [...prevWarnings, ...(extra.warnings || [])].filter((w, i, a) => a.indexOf(w) === i);
        // Phase 8: one bulk-row credit per finished row (the render itself
        // charges 1 render credit in src/render.js). If the balance ran
        // out mid-batch the charge is refused but the finished video is
        // still the user's — the batch was gated on balance at start.
        credits.chargeCredits(job.user_id, 'bulk_row', `Bulk row ${row.row_index + 1} of job ${payload.bulkJobId} rendered`);
        db.updateBulkRow(row.id, {
          status: 'done',
          output_path: (j && j.output_path) || extra.outputPath || null,
          warnings: merged,
        });
      } else if (status === 'failed') {
        db.updateBulkRow(row.id, { status: 'failed', error: extra.error || job.error || 'Render failed.' });
      } else if (status === 'cancelled') {
        db.updateBulkRow(row.id, { status: 'cancelled' });
      }
    }
    db.refreshBulkJobCounts(payload.bulkJobId);
    const bj = db.getBulkJobAny(payload.bulkJobId);
    if (!bj) return;
    if (bj.status === 'running' && status !== 'cancelled') await advanceBulkJob(payload.bulkJobId);
  } catch (err) {
    // Bookkeeping failure must never stall the batch silently: mark it.
    try {
      db.updateBulkJob(payload.bulkJobId, { status: 'failed' });
      db.audit(job.user_id, 'bulk_error', 'bulk_job', payload.bulkJobId, `Bulk runner error: ${String(err.message).slice(0, 500)}`);
    } catch { /* ignore */ }
  }
}

async function cancelBulkJob(userId, bulkJobId) {
  const job = db.getBulkJob(userId, bulkJobId);
  if (!job) return null;
  if (job.status !== 'running') return job;
  const { cancelJob } = require('./render');
  for (const r of db.listBulkRows(bulkJobId)) {
    if (r.output_job_id) {
      const j = db.getJobAny(r.output_job_id);
      if (j && (j.status === 'queued' || j.status === 'running')) cancelJob(j.id);
    }
    if (r.status === 'queued' || r.status === 'rendering') db.updateBulkRow(r.id, { status: 'cancelled' });
  }
  db.updateBulkJob(bulkJobId, { status: 'cancelled' });
  db.refreshBulkJobCounts(bulkJobId);
  db.audit(userId, 'bulk_cancelled', 'bulk_job', bulkJobId, `Bulk job "${job.name}" cancelled.`);
  return db.getBulkJob(userId, bulkJobId);
}

async function retryBulkRows(userId, bulkJobId, rowIds) {
  const job = db.getBulkJob(userId, bulkJobId);
  if (!job) throw new Error('Bulk job not found.');
  if (!['draft', 'done', 'partial', 'failed', 'cancelled'].includes(job.status)) {
    throw new Error(`Cannot retry while the batch is ${job.status}.`);
  }
  const rows = db.listBulkRows(bulkJobId);
  // Retry list = FAILED rows only. Skipped duplicates are never retried:
  // they are permanently skipped (user rule) — only the first copy is made.
  const targets = rows.filter((r) => r.status === 'failed' && (!rowIds || rowIds.includes(r.id)));
  if (!targets.length) {
    throw new Error('No failed rows to retry. Skipped duplicates are never retried — only the first copy of a row is generated.');
  }
  for (const r of targets) {
    db.updateBulkRow(r.id, { status: 'queued', error: null, output_job_id: null, output_path: null });
  }
  // Re-assign backgrounds for the retried rows (video only): a row that
  // failed because its background column was empty can succeed after the
  // user switches the background mode — without this, retry would fail
  // again on the missing background. Done rows are never re-assigned.
  if (job.kind === 'video') {
    try {
      await assignBackgroundsForJob(db.getBulkJob(userId, bulkJobId));
    } catch (err) {
      for (const r of targets) db.updateBulkRow(r.id, { status: 'failed', error: String(err.message).slice(0, 1000) });
      db.refreshBulkJobCounts(bulkJobId);
      throw err;
    }
  }
  db.updateBulkJob(bulkJobId, { status: 'running' });
  db.refreshBulkJobCounts(bulkJobId);
  db.audit(userId, 'bulk_retry', 'bulk_job', bulkJobId, `Retrying ${targets.length} failed row(s).`);
  await advanceBulkJob(bulkJobId);
  return db.getBulkJob(userId, bulkJobId);
}

// --- ZIP export ------------------------------------------------------------
async function buildBulkZip(userId, bulkJob) {
  const archiver = require('archiver');
  const rows = db.listBulkRows(bulkJob.id)
    .filter((r) => r.status === 'done' && r.output_path && fs.existsSync(r.output_path));
  if (!rows.length) throw new Error('No finished outputs to zip yet.');
  const dir = path.join(config.rendersDir, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, `bulk-${bulkJob.id}.zip`);
  const out = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 6 } });
  await new Promise((resolve, reject) => {
    out.on('close', resolve);
    out.on('error', reject);
    archive.on('error', reject);
    archive.pipe(out);
    const seen = new Set();
    for (const r of rows) {
      let name = r.output_name || path.basename(r.output_path);
      if (seen.has(name)) {
        const parsed = path.parse(name);
        name = `${parsed.name}-row${r.row_index + 1}${parsed.ext}`;
      }
      seen.add(name);
      archive.file(r.output_path, { name });
    }
    archive.finalize();
  });
  return zipPath;
}

module.exports = {
  parseSettings, MAX_ROWS_HARD,
  getTemplateFields, getQuizTemplateFields, extractTimeline, extractDesign,
  buildQuizQuestion, buildQuizGroupPayload, quizOutputSize,
  resolveMediaValue, measureLuminance, measureBackgroundStats,
  applyDedupe, assignBackgroundsForJob, buildRowJobPayload,
  computeBatchQuizFonts, computeBatchUniformFonts, checkRowFit,
  resolveVoiceForRow, attachQuizNarration,
  startBulkJob, advanceBulkJob, finalizeBulkJob,
  onRowJobStarted, onRowJobFinished,
  cancelBulkJob, retryBulkRows, buildBulkZip,
};
