// Video rendering API — jobs, effects catalog, audio extraction, captions,
// waveforms, estimates, transitions, LUT uploads and cover frames.
// (v2.5.0 RENDER + MODEL)
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const auth = require('../auth');
const credits = require('../credits');
const db = require('../db');
const vm = require('../video-model');
const { run, probeMedia } = require('../ffmpeg');
const { cancelJob, rendersDirFor } = require('../render');
const config = require('../config');
const { parseTimedText, toSRT, normaliseCues } = require('../captions');
const { waveformPeaks } = require('../music-analysis');

const router = express.Router();

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function num(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

// Decode an audio file to a mono Float32Array (used by the waveform
// endpoint). Caps at 10 minutes so a long track cannot exhaust memory.
function decodeAudioMono(filePath, { maxSeconds = 600, sampleRate = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', filePath, '-t', String(maxSeconds),
      '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-']);
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Could not decode audio${stderr ? `: ${stderr.slice(-300)}` : ''}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

function publicJob(j) {
  let settings = {};
  let timeline = null;
  try {
    const p = JSON.parse(j.payload || '{}');
    settings = p.settings || {};
    timeline = p.timeline ? { width: p.timeline.width, height: p.timeline.height, fps: p.timeline.fps } : null;
  } catch { /* payload stays empty */ }
  // Queue position (1-based) among the user's queued render jobs, so the
  // UI can show "2nd in queue" while a render is running.
  let queuePosition = null;
  if (j.status === 'queued') {
    try {
      const queued = db.listJobs(j.user_id).filter((x) => x.status === 'queued').sort((a, b) => a.id - b.id);
      const idx = queued.findIndex((x) => x.id === j.id);
      queuePosition = idx >= 0 ? idx + 1 : null;
    } catch { /* position is best-effort */ }
  }
  return {
    id: j.id, type: j.type, status: j.status, progress: j.progress,
    error: j.error, projectId: j.project_id, settings, timeline,
    queuePosition,
    hasOutput: Boolean(j.output_path && fs.existsSync(j.output_path)),
    createdAt: j.created_at, updatedAt: j.updated_at,
  };
}

// ---------------------------------------------------------------------------
// GET /api/video/effects — the full catalog the editor reads dynamically.
// ---------------------------------------------------------------------------
router.get('/effects', auth.requireAuth, (req, res) => {
  res.json({
    transitions: vm.TRANSITIONS.map((t) => ({
      id: t.id, name: t.name, maxDuration: t.maxDuration,
      description: t.id === 'none' ? 'No transition.' : `Real xfade "${t.id}".`,
    })),
    filters: vm.FILTERS,
    // #2 — the real video-effects library (each id maps to an FFmpeg
    // filter chain in render.js; intensity is 0–1).
    effects: vm.EFFECTS.map((e) => ({ id: e.id, name: e.name, description: e.description })),
    // #7 — filter presets as stored slider bundles; clip.filterPreset
    // selects one, and non-zero clip.filters values override it.
    filterPresets: vm.FILTER_PRESETS.map((p) => ({ id: p.id, name: p.name, sliders: p.sliders })),
    // #4 — speed-curve presets (points: t 0..1, speed multiplier).
    speedCurvePresets: vm.SPEED_CURVE_PRESETS.map((p) => ({ id: p.id, name: p.name, points: p.points })),
    // #59 — velocity effects are named speed-curve presets.
    velocityEffects: vm.VELOCITY_EFFECTS.map((v) => ({ id: v.id, name: v.name, curve: v.curve })),
    captionStyles: vm.CAPTION_STYLE_PRESETS.map((s) => ({ id: s.id, name: s.name })),
    // #53 — export presets for the UI (each is a settings bundle).
    exportPresets: vm.EXPORT_PRESETS.map((p) => ({
      id: p.id, name: p.name, resolution: p.resolution, fps: p.fps,
      format: p.format, codec: p.codec, note: p.note,
    })),
    keyframeProperties: [
      { id: 'x', name: 'Position X', note: 'Keyframed position uses the segment path (no geq sampling).' },
      { id: 'y', name: 'Position Y', note: 'Keyframed position uses the segment path (no geq sampling).' },
      { id: 'scale', name: 'Scale', note: 'Keyframed scale uses the segment path (no geq sampling).' },
      { id: 'opacity', name: 'Opacity (0–1)', note: 'Per-segment constant alpha — no geq sampling.' },
      { id: 'rotation', name: 'Rotation (0–360°)', note: 'Smooth rotation via per-frame rotate expressions.' },
      { id: 'volume', name: 'Volume (0–2)', note: 'Per-frame volume automation (volume eval=frame).' },
      { id: 'easing', name: 'Easing', note: 'linear, ease-in, ease-out or ease-in-out, set on the target keyframe.' },
    ],
    aspects: vm.ASPECTS,
    resolutions: vm.RESOLUTIONS,
    fpsOptions: vm.FPS_OPTIONS,
    audioFx: {
      denoise: 'FFT noise reduction (afftdn).',
      enhanceVoice: 'High/low-pass plus denoise, tuned for spoken audio.',
      vocalIsolation: 'Centre-channel vocal remove/keep — DSP only, not AI stem separation.',
      loudnorm: 'EBU R128 loudness normalisation to -16 LUFS.',
      ducking: 'Music ducks under dialogue via sidechain compression.',
    },
    notYet: [
      'Proxy editing for large videos (later phase)',
      'Face tracking / motion tracking',
      'AI style transfer on video',
      'Stock video search (needs a Pexels key)',
    ],
  });
});

// ---------------------------------------------------------------------------
// POST /api/video/validate — check a timeline without rendering it.
// ---------------------------------------------------------------------------
router.post('/validate', auth.requireAuth, (req, res) => {
  const { timeline } = req.body || {};
  if (!timeline) return res.status(400).json({ error: 'A timeline is required.' });
  const errors = vm.validateTimeline(timeline);
  if (errors.length) return res.status(400).json({ valid: false, errors });
  res.json({ valid: true, duration: vm.totalDuration(timeline) });
});

// ---------------------------------------------------------------------------
// GET /api/video/jobs — list render jobs (newest first).
// ---------------------------------------------------------------------------
router.get('/jobs', auth.requireAuth, (req, res) => {
  const jobs = db.listJobs(req.user.id, 'render');
  res.json({ jobs: jobs.map(publicJob) });
});

// ---------------------------------------------------------------------------
// POST /api/video/jobs — queue a render.
// ---------------------------------------------------------------------------
router.post('/jobs', auth.requireAuth, async (req, res) => {
  const { projectId, timeline, settings = {} } = req.body || {};
  let tl = timeline;
  let project = null;
  if (projectId !== undefined && projectId !== null) {
    project = db.getProject(req.user.id, projectId);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    if (project.type !== 'video') return res.status(400).json({ error: 'Only video projects can be rendered.' });
    try {
      const content = JSON.parse(project.content || '{}');
      tl = content.timeline || content;
    } catch {
      return res.status(400).json({ error: 'Project content is not valid JSON.' });
    }
  }
  if (!tl) return res.status(400).json({ error: 'A timeline is required.' });
  const errors = vm.validateTimeline(tl);
  if (errors.length) return res.status(400).json({ error: `Invalid timeline: ${errors.join(' ')}` });
  // #72 — gradient text is refused at job creation, not as a failed
  // render. The user sees the reason before any credits are touched.
  for (const c of vm.allClips(tl)) {
    if (c.kind === 'text' && c.text && c.text.gradient && c.text.gradient.enabled) {
      return res.status(400).json({
        error: `Gradient text is not supported in renders — remove the gradient from clip "${c.name}" or use a solid color.`,
      });
    }
  }
  // ---- settings validation (v2.5.0) ----
  const fps = settings.fps || tl.fps;
  if (!vm.FPS_OPTIONS.includes(fps)) {
    return res.status(400).json({ error: `fps must be one of ${vm.FPS_OPTIONS.join(', ')}.` });
  }
  if (settings.width !== undefined || settings.height !== undefined) {
    if (!Number.isInteger(settings.width) || !Number.isInteger(settings.height)
      || settings.width < 160 || settings.width > 3840
      || settings.height < 160 || settings.height > 3840
      || settings.width % 2 || settings.height % 2) {
      return res.status(400).json({ error: 'Custom render size must be even numbers, 160–3840 px.' });
    }
  }
  const resolution = settings.resolution || '720p';
  if (!vm.RESOLUTIONS.find((r) => r.id === resolution) && settings.width === undefined) {
    return res.status(400).json({ error: `Unknown resolution "${resolution}".` });
  }
  const format = settings.format || 'mp4';
  if (!['mp4', 'mov', 'webm'].includes(format)) {
    return res.status(400).json({ error: 'Format must be "mp4", "mov" or "webm".' });
  }
  const hdr = !!settings.hdr;
  const codec = settings.codec || (hdr ? 'hevc' : 'h264');
  if (!['h264', 'hevc'].includes(codec)) {
    return res.status(400).json({ error: 'Codec must be "h264" or "hevc".' });
  }
  if (format === 'webm' && codec === 'hevc') {
    return res.status(400).json({ error: 'WebM uses VP9 — HEVC is not available in a WebM container. Use mp4 or mov for HEVC.' });
  }
  if (hdr && codec === 'h264') {
    return res.status(400).json({ error: 'HDR export uses HEVC (H.265) — set codec to "hevc" (or leave it unset).' });
  }
  const audioOnly = !!settings.audioOnly;
  const audioFormat = settings.audioFormat || 'mp3';
  if (audioOnly && !['mp3', 'wav'].includes(audioFormat)) {
    return res.status(400).json({ error: 'Audio format must be "mp3" or "wav".' });
  }
  if (settings.bitrateKbps !== undefined
    && (!Number.isFinite(settings.bitrateKbps) || settings.bitrateKbps < 100 || settings.bitrateKbps > 100000)) {
    return res.status(400).json({ error: 'bitrateKbps must be 100–100000.' });
  }
  if (settings.crf !== undefined && (!Number.isInteger(settings.crf) || settings.crf < 0 || settings.crf > 51)) {
    return res.status(400).json({ error: 'crf must be an integer 0–51.' });
  }
  if (settings.quality !== undefined && !['low', 'medium', 'high', 'best'].includes(settings.quality)) {
    return res.status(400).json({ error: 'quality must be low, medium, high or best.' });
  }
  if (settings.audioBitrateKbps !== undefined
    && (!Number.isFinite(settings.audioBitrateKbps) || settings.audioBitrateKbps < 32 || settings.audioBitrateKbps > 512)) {
    return res.status(400).json({ error: 'audioBitrateKbps must be 32–512.' });
  }
  if (audioOnly && (settings.frameExport || settings.gifExport)) {
    return res.status(400).json({ error: 'Frame/GIF export needs a video render, not an audio-only export.' });
  }
  let frameExport = null;
  if (settings.frameExport !== undefined && settings.frameExport !== null && settings.frameExport !== false) {
    if (settings.frameExport === true) frameExport = { at: null };
    else if (typeof settings.frameExport === 'object'
      && (settings.frameExport.at === undefined || settings.frameExport.at === null || isNum(settings.frameExport.at))) {
      frameExport = { at: settings.frameExport.at ?? null };
    } else {
      return res.status(400).json({ error: 'frameExport must be true or { at: seconds }.' });
    }
  }
  const gifExport = !!settings.gifExport;
  let filename = null;
  if (settings.filename !== undefined && settings.filename !== null && settings.filename !== '') {
    filename = String(settings.filename).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!filename) return res.status(400).json({ error: 'filename must contain at least one valid character.' });
  }
  // ---- media checks (incl. nested compound media, LUTs, background) ----
  const checkMedia = (t) => {
    for (const c of vm.allClips(t)) {
      if (c.kind === 'compound' && c.nested) { const e = checkMedia(c.nested); if (e) return e; }
      if (c.lutMediaId != null) {
        const m = db.getMedia(req.user.id, c.lutMediaId);
        if (!m) return `LUT file #${c.lutMediaId} used by clip "${c.name}" was not found.`;
      }
      if (!c.mediaId) continue;
      const m = db.getMedia(req.user.id, c.mediaId);
      if (!m) return `Media file #${c.mediaId} used by clip "${c.name}" was not found. Re-add it to the timeline.`;
      if (c.kind === 'video' && m.kind !== 'video' && m.kind !== 'image') {
        return `Clip "${c.name}" is on a video track but its media is ${m.kind}, not video or image.`;
      }
      if (c.kind === 'audio' && m.kind !== 'audio' && m.kind !== 'video') {
        return `Clip "${c.name}" is on an audio track but its media is ${m.kind}.`;
      }
    }
    const bg = t.background;
    if (bg && typeof bg === 'object' && (bg.type === 'image' || bg.type === 'blur') && bg.mediaId != null) {
      if (!db.getMedia(req.user.id, bg.mediaId)) return `Background media #${bg.mediaId} was not found.`;
    }
    return null;
  };
  const mediaError = checkMedia(tl);
  if (mediaError) return res.status(400).json({ error: mediaError });
  const check = credits.checkCredits(req.user.id, 'render');
  if (!check.ok) return res.status(402).json({ error: check.error, code: check.code, needed: check.needed, balance: check.balance });
  const jobSettings = {
    resolution, fps, format, codec, hdr, audioOnly, audioFormat,
    bitrateKbps: settings.bitrateKbps, quality: settings.quality, crf: settings.crf,
    audioBitrateKbps: settings.audioBitrateKbps, frameExport, gifExport, filename,
    width: settings.width, height: settings.height,
  };
  const job = db.createJob(req.user.id, {
    type: 'render',
    projectId: project ? project.id : null,
    payload: { timeline: tl, settings: jobSettings },
  });
  db.audit(req.user.id, 'render_queued', 'job', job.id,
    `Render queued for "${project ? project.name : 'timeline'}" (${resolution}, ${fps}fps, ${format.toUpperCase()}${hdr ? '/HDR' : ''}${audioOnly ? ', audio-only' : ''})`);
  res.status(201).json({ job: publicJob(job) });
});

// ---------------------------------------------------------------------------
// GET /api/video/jobs/:id — one job.
// ---------------------------------------------------------------------------
router.get('/jobs/:id', auth.requireAuth, (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  res.json({ job: publicJob(j) });
});

// ---------------------------------------------------------------------------
// POST /api/video/jobs/:id/cancel
// ---------------------------------------------------------------------------
router.post('/jobs/:id/cancel', auth.requireAuth, (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') {
    return res.status(400).json({ error: `Job is already ${j.status}.` });
  }
  if (cancelJob(j.id)) {
    return res.json({ ok: true, job: publicJob(db.getJob(req.user.id, j.id)) });
  }
  const fresh = db.getJob(req.user.id, j.id);
  if (fresh && fresh.status === 'cancelled') return res.json({ ok: true, job: publicJob(fresh) });
  res.status(500).json({ error: 'Could not cancel this job.' });
});

// ---------------------------------------------------------------------------
// POST /api/video/jobs/:id/retry — re-queue a failed/cancelled job.
// ---------------------------------------------------------------------------
router.post('/jobs/:id/retry', auth.requireAuth, (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  if (j.status !== 'failed' && j.status !== 'cancelled') {
    return res.status(400).json({ error: `Only failed or cancelled jobs can be retried (this one is ${j.status}).` });
  }
  const check = credits.checkCredits(req.user.id, 'render');
  if (!check.ok) return res.status(402).json({ error: check.error, code: check.code, needed: check.needed, balance: check.balance });
  db.updateJob(j.id, { status: 'queued', progress: 0, error: null });
  db.audit(req.user.id, 'render_retry', 'job', j.id, `Render job ${j.id} re-queued`);
  res.json({ job: publicJob(db.getJob(req.user.id, j.id)) });
});

// ---------------------------------------------------------------------------
// DELETE /api/video/jobs/:id — delete a finished job record (+ its file).
// ---------------------------------------------------------------------------
router.delete('/jobs/:id', auth.requireAuth, (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  if (j.status === 'running' || j.status === 'queued') {
    return res.status(400).json({ error: 'Cancel a running or queued job before deleting it.' });
  }
  if (j.output_path) {
    try { if (fs.existsSync(j.output_path)) fs.unlinkSync(j.output_path); } catch { /* ignore */ }
    try { if (fs.existsSync(j.log_path)) fs.unlinkSync(j.log_path); } catch { /* ignore */ }
    try { fs.rmSync(path.join(rendersDirFor(req.user.id), `tmp-${j.id}`), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  db.deleteJob(j.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/video/jobs/:id/download — the finished render, under the
// project's filename when one was set at job creation.
// ---------------------------------------------------------------------------
router.get('/jobs/:id/download', auth.requireAuth, (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  if (j.status !== 'done' || !j.output_path || !fs.existsSync(j.output_path)) {
    return res.status(404).json({ error: 'No finished render is available for this job yet.' });
  }
  const ext = path.extname(j.output_path).toLowerCase().slice(1) || 'mp4';
  const types = {
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', gif: 'image/gif',
    mp3: 'audio/mpeg', wav: 'audio/wav', jpg: 'image/jpeg', png: 'image/png',
  };
  let filename = `creative-studio-render-${j.id}.${ext}`;
  try {
    const p = JSON.parse(j.payload || '{}');
    if (p.settings && p.settings.filename) filename = `${p.settings.filename}.${ext}`;
  } catch { /* keep the default name */ }
  res.type(types[ext] || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  fs.createReadStream(j.output_path).pipe(res);
});

// ---------------------------------------------------------------------------
// GET /api/video/jobs/:id/cover?at=SECONDS — a JPEG frame from a finished
// render (cover/thumbnail). The extracted frame is cached next to the
// render so repeat calls are cheap.
// ---------------------------------------------------------------------------
router.get('/jobs/:id/cover', auth.requireAuth, async (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  if (j.status !== 'done' || !j.output_path || !fs.existsSync(j.output_path)) {
    return res.status(404).json({ error: 'No finished render is available for this job yet.' });
  }
  const ext = path.extname(j.output_path).toLowerCase();
  if (!['.mp4', '.mov', '.webm'].includes(ext)) {
    return res.status(400).json({ error: 'Cover frames can only be taken from a finished video render.' });
  }
  const probe = await probeMedia(j.output_path);
  const dur = probe && probe.durationSeconds ? probe.durationSeconds : 0;
  const at = req.query.at !== undefined ? parseFloat(req.query.at) : dur / 2;
  if (!Number.isFinite(at) || at < 0 || (dur && at > dur)) {
    return res.status(400).json({ error: `Cover time must be 0–${dur.toFixed(2)}s.` });
  }
  const coverPath = path.join(path.dirname(j.output_path), `${j.id}-cover-${String(at).replace('.', '_')}.jpg`);
  if (!fs.existsSync(coverPath)) {
    try {
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', j.output_path,
        '-frames:v', '1', '-q:v', '3', coverPath]);
    } catch (e) {
      return res.status(400).json({ error: `Cover frame extraction failed: ${e.message}` });
    }
  }
  res.type('image/jpeg');
  fs.createReadStream(coverPath).pipe(res);
});

// ---------------------------------------------------------------------------
// GET /api/video/jobs/:id/log — the ffmpeg log.
// ---------------------------------------------------------------------------
router.get('/jobs/:id/log', auth.requireAuth, (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  const logPath = path.join(rendersDirFor(req.user.id), `${j.id}.log`);
  if (!fs.existsSync(logPath)) return res.json({ log: '' });
  res.json({ log: fs.readFileSync(logPath, 'utf8') });
});

// ---------------------------------------------------------------------------
// POST /api/video/jobs/:id/save-to-library — save a finished video render
// as a Media Library file.
// ---------------------------------------------------------------------------
router.post('/jobs/:id/save-to-library', auth.requireAuth, async (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  if (j.status !== 'done' || !j.output_path || !fs.existsSync(j.output_path)) {
    return res.status(404).json({ error: 'No finished render is available for this job yet.' });
  }
  const ext = path.extname(j.output_path).toLowerCase().slice(1);
  if (!['mp4', 'mov', 'webm'].includes(ext)) {
    return res.status(400).json({ error: 'Only finished video renders can be saved to the Media Library.' });
  }
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const dest = path.join(config.uploadsDir, String(req.user.id), storedName);
  fs.copyFileSync(j.output_path, dest);
  const probe = await probeMedia(dest);
  const mime = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }[ext] || 'video/mp4';
  const media = db.createMedia(req.user.id, {
    originalName: `render-${j.id}.${ext}`,
    storedName, mimeType: mime, kind: 'video',
    sizeBytes: fs.statSync(dest).size,
    width: probe ? probe.width : null, height: probe ? probe.height : null,
    durationSeconds: probe ? probe.durationSeconds : null,
    tags: 'render',
  });
  res.status(201).json({ media });
});

// ---------------------------------------------------------------------------
// POST /api/video/:projectId/extract-audio {clipId} — extract the audio of
// one video clip to a new media file and return the audio-clip object the
// UI inserts on its audio track. The endpoint only extracts and returns;
// it never edits the project itself.
// ---------------------------------------------------------------------------
router.post('/:projectId/extract-audio', auth.requireAuth, async (req, res) => {
  const { clipId } = req.body || {};
  if (!clipId) return res.status(400).json({ error: 'clipId is required.' });
  const project = db.getProject(req.user.id, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (project.type !== 'video') return res.status(400).json({ error: 'Only video projects have clips to extract audio from.' });
  let tl;
  try {
    const c = JSON.parse(project.content || '{}');
    tl = c.timeline || c;
  } catch {
    return res.status(400).json({ error: 'Project content is not valid JSON.' });
  }
  const clip = vm.allClips(tl).find((c) => c.id === clipId);
  if (!clip) return res.status(404).json({ error: 'Clip not found in this project.' });
  if (clip.kind === 'compound') {
    return res.status(400).json({ error: 'Audio cannot be extracted from a compound clip — extract it from the nested timeline instead.' });
  }
  if (clip.kind !== 'video') return res.status(400).json({ error: 'Only video clips have audio to extract.' });
  if (!clip.mediaId) return res.status(400).json({ error: 'This clip has no media file.' });
  const m = db.getMedia(req.user.id, clip.mediaId);
  if (!m) return res.status(404).json({ error: `Media file #${clip.mediaId} was not found.` });
  const mediaFile = path.join(config.uploadsDir, String(req.user.id), m.stored_name);
  if (!fs.existsSync(mediaFile)) return res.status(404).json({ error: 'Media file is missing on disk.' });
  const probe = await probeMedia(mediaFile);
  if (!probe || !probe.hasAudio) return res.status(400).json({ error: 'This clip has no audio track to extract.' });
  // The source range: speed curves change how much source the clip
  // consumes, so integrate the curve rather than multiplying by speed.
  const srcDur = Math.max(0.1, vm.curveIntegral(clip, clip.duration));
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.mp3`;
  const userDir = path.join(config.uploadsDir, String(req.user.id));
  fs.mkdirSync(userDir, { recursive: true });
  const outFile = path.join(userDir, storedName);
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', mediaFile,
      '-ss', String(clip.srcStart || 0), '-t', String(srcDur),
      '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', outFile]);
  } catch (e) {
    return res.status(400).json({ error: `Audio extraction failed: ${e.message}` });
  }
  const outProbe = await probeMedia(outFile);
  const media = db.createMedia(req.user.id, {
    originalName: `audio-from-${clip.name || 'clip'}.mp3`,
    storedName, mimeType: 'audio/mpeg', kind: 'audio',
    sizeBytes: fs.statSync(outFile).size,
    width: null, height: null,
    durationSeconds: outProbe ? outProbe.durationSeconds : srcDur,
    tags: 'extracted',
  });
  const audioClip = vm.defaultClip('audio', media.id, clip.start, clip.duration);
  audioClip.name = `Audio from ${clip.name || 'clip'}`;
  audioClip.linkedTo = clip.id;
  audioClip.volume = clip.volume !== undefined ? clip.volume : 1;
  audioClip.speed = 1;
  audioClip.srcStart = 0;
  res.status(201).json({
    media: { id: media.id, originalName: media.original_name, durationSeconds: media.duration_seconds },
    clip: audioClip,
  });
});

// ---------------------------------------------------------------------------
// POST /api/video/:projectId/captions/import {srt:"..."} — parse raw SRT
// (or VTT) text and return the text clips the UI inserts on the text
// track. Times come from the cues; overlaps are trimmed by normaliseCues.
// ---------------------------------------------------------------------------
router.post('/:projectId/captions/import', auth.requireAuth, (req, res) => {
  const { srt } = req.body || {};
  if (typeof srt !== 'string' || !srt.trim()) return res.status(400).json({ error: 'srt text is required.' });
  const project = db.getProject(req.user.id, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (project.type !== 'video') return res.status(400).json({ error: 'Only video projects have captions.' });
  const isVtt = /^\s*WEBVTT/i.test(srt);
  const { cues, errors } = parseTimedText(srt, isVtt ? 'vtt' : 'srt');
  if (!cues.length) {
    return res.status(400).json({ error: `No captions found in the ${isVtt ? 'VTT' : 'SRT'} text.` + (errors.length ? ` (${errors[0]})` : '') });
  }
  const { cues: norm } = normaliseCues(cues, null);
  const clips = norm.map((cue) => {
    const c = vm.defaultClip('text', null, cue.start, cue.end - cue.start);
    c.text.text = cue.text;
    return c;
  });
  res.status(201).json({ clips, skipped: errors });
});

// ---------------------------------------------------------------------------
// GET /api/video/:projectId/captions/export?format=srt|txt — build SRT or
// plain text from the project's text clips.
// ---------------------------------------------------------------------------
router.get('/:projectId/captions/export', auth.requireAuth, (req, res) => {
  const format = String(req.query.format || 'srt').toLowerCase();
  if (!['srt', 'txt'].includes(format)) return res.status(400).json({ error: 'format must be srt or txt.' });
  const project = db.getProject(req.user.id, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  let tl;
  try {
    const c = JSON.parse(project.content || '{}');
    tl = c.timeline || c;
  } catch {
    return res.status(400).json({ error: 'Project content is not valid JSON.' });
  }
  const cues = vm.allClips(tl)
    .filter((c) => c.kind === 'text' && c.text && typeof c.text.text === 'string' && c.text.text.trim())
    .sort((a, b) => a.start - b.start)
    .map((c) => ({ start: c.start, end: c.start + c.duration, text: c.text.text.trim() }));
  if (format === 'txt') return res.json({ text: cues.map((c) => c.text).join('\n') });
  res.json({ srt: toSRT(cues) });
});

// ---------------------------------------------------------------------------
// GET /api/video/media/:id/waveform — peaks for timeline drawing.
// 404 when the media has no audio. (The canonical path is
// GET /api/media/:id/waveform in the media router; this alias lives here
// because the waveform code is render-side, and waveformHandler is
// exported below so the media router can mount the exact path with one
// line.)
// ---------------------------------------------------------------------------
async function waveformHandler(req, res) {
  const m = db.getMedia(req.user.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Media file not found.' });
  const filePath = path.join(config.uploadsDir, String(req.user.id), m.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Media file is missing on disk.' });
  let probe;
  try {
    probe = await probeMedia(filePath);
  } catch (e) {
    return res.status(400).json({ error: `Could not read this media file: ${e.message}` });
  }
  if (!probe || !probe.hasAudio) return res.status(404).json({ error: 'This media file has no audio.' });
  const buckets = Math.max(100, Math.min(200, parseInt(req.query.buckets || '150', 10) || 150));
  let samples;
  try {
    samples = await decodeAudioMono(filePath);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!samples.length) return res.status(404).json({ error: 'This media file has no audio.' });
  const peaks = waveformPeaks(samples, buckets);
  res.json({
    peaks, durationSeconds: probe.durationSeconds, buckets,
    truncated: probe.durationSeconds != null && probe.durationSeconds > 600,
  });
}
router.get('/media/:id/waveform', auth.requireAuth, waveformHandler);

// ---------------------------------------------------------------------------
// POST /api/video/estimate {timeline, settings} — estimated output size
// from resolution/fps/codec/bitrate. An estimate is not a guarantee: the
// real file depends on the content, but it is close enough to show in the
// export dialog (same bitrate model as the renderer).
// ---------------------------------------------------------------------------
router.post('/estimate', auth.requireAuth, (req, res) => {
  const { timeline, settings = {} } = req.body || {};
  if (!timeline) return res.status(400).json({ error: 'A timeline is required to estimate.' });
  const errors = vm.validateTimeline(timeline);
  if (errors.length) return res.status(400).json({ error: `Invalid timeline: ${errors.join(' ')}` });
  const durationSeconds = vm.totalDuration(timeline);
  const resolution = settings.resolution || '720p';
  const fps = settings.fps || timeline.fps || 30;
  const format = settings.format || 'mp4';
  const codec = settings.codec || (settings.hdr ? 'hevc' : 'h264');
  let videoBitrateKbps = 0;
  if (!settings.audioOnly) {
    let pixels = 1280 * 720;
    if (vm.RESOLUTIONS.find((r) => r.id === resolution)) {
      const d = vm.outputDims(timeline, resolution);
      pixels = d.width * d.height;
    } else if (settings.width && settings.height) {
      pixels = settings.width * settings.height;
    }
    // 720p ≈ 5 Mbps at 30 fps (the renderer's default); scales with
    // pixels and fps, HEVC/VP9 are ~35% cheaper per pixel.
    const baseKbps = 5000 * (pixels / 921600);
    let factor = fps / 30;
    if (format === 'webm' || codec === 'hevc') factor *= 0.65;
    const qualityFactor = { low: 0.6, medium: 1, high: 1.6, best: 2.5 }[settings.quality] || 1;
    factor *= qualityFactor;
    if (settings.crf !== undefined) factor *= Math.pow(2, (23 - num(settings.crf, 23)) / 6);
    videoBitrateKbps = Math.round(baseKbps * factor);
    if (settings.bitrateKbps) videoBitrateKbps = Math.round(num(settings.bitrateKbps, 0));
  }
  const hasAudio = vm.allClips(timeline).some((c) => c.kind === 'audio' || (c.kind === 'video' && c.mediaId));
  const audioBitrateKbps = settings.audioOnly
    ? Math.round(num(settings.audioBitrateKbps, 192))
    : (hasAudio ? Math.round(num(settings.audioBitrateKbps, 128)) : 0);
  const bitrateKbps = videoBitrateKbps + audioBitrateKbps;
  const bytes = Math.round((bitrateKbps * 1000 * durationSeconds) / 8);
  res.json({
    bytes, durationSeconds, bitrateKbps, videoBitrateKbps, audioBitrateKbps,
    resolution, fps, format, codec, hdr: !!settings.hdr, audioOnly: !!settings.audioOnly,
  });
});

// ---------------------------------------------------------------------------
// POST /api/video/:projectId/transitions/apply-all {type, duration} — set
// the same transition on every video clip in the project, then save.
// ---------------------------------------------------------------------------
router.post('/:projectId/transitions/apply-all', auth.requireAuth, (req, res) => {
  const { type, duration } = req.body || {};
  const trDef = vm.TRANSITIONS.find((t) => t.id === type);
  if (!trDef) return res.status(400).json({ error: `Unknown transition "${type}".` });
  if (type !== 'none' && (!isNum(duration) || duration <= 0 || duration > trDef.maxDuration)) {
    return res.status(400).json({ error: `Transition duration must be 0–${trDef.maxDuration}s.` });
  }
  const project = db.getProject(req.user.id, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (project.type !== 'video') return res.status(400).json({ error: 'Only video projects have transitions.' });
  let content;
  let tl;
  try {
    content = JSON.parse(project.content || '{}');
    tl = content.timeline || content;
  } catch {
    return res.status(400).json({ error: 'Project content is not valid JSON.' });
  }
  let updated = 0;
  for (const tr of tl.tracks || []) {
    if (tr.kind !== 'video') continue;
    for (const c of tr.clips || []) {
      c.transition = { type, duration: type === 'none' ? 0.5 : duration };
      updated++;
    }
  }
  const newContent = content.timeline ? { ...content, timeline: tl } : tl;
  db.updateProject(req.user.id, project.id, { content: newContent });
  res.json({ ok: true, updated, type, duration });
});

// ---------------------------------------------------------------------------
// POST /api/video/luts — upload a .CUBE/.3DL LUT file. The media upload
// endpoint only accepts image/video/audio, so LUTs need their own upload
// route; the returned media id is what clip.lutMediaId references.
// ---------------------------------------------------------------------------
const lutUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(config.uploadsDir, String(req.user.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname || '').toLowerCase()}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/\.(cube|3dl)$/i.test(file.originalname || '')) return cb(null, true);
    cb(new Error('Only .CUBE and .3DL LUT files are allowed.'));
  },
});
router.post('/luts', auth.requireAuth, (req, res) => {
  lutUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'A .CUBE or .3DL file is required.' });
    // The media table only allows kind image/video/audio/other, so a LUT
    // is stored as kind 'other' with tags 'lut'; the renderer identifies
    // it by the file extension, not by kind.
    let m;
    try {
      m = db.createMedia(req.user.id, {
        originalName: req.file.originalname,
        storedName: req.file.filename,
        mimeType: 'application/octet-stream', kind: 'other',
        sizeBytes: req.file.size, width: null, height: null, durationSeconds: null, tags: 'lut',
      });
    } catch (e) {
      return res.status(400).json({ error: `Could not save the LUT file: ${e.message}` });
    }
    res.status(201).json({ media: { id: m.id, originalName: m.original_name, kind: 'lut' } });
  });
});

router.waveformHandler = waveformHandler;

module.exports = router;
