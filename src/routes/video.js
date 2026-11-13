'use strict';
// Video Editor + render job routes (Phase 3).
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const vm = require('../video-model');
const { cancelJob, rendersDirFor } = require('../render');
const { probeMedia } = require('../ffmpeg');
const credits = require('../credits');

const router = express.Router();

function publicJob(j) {
  let settings = {};
  let timeline = null;
  try {
    const p = JSON.parse(j.payload || '{}');
    settings = p.settings || {};
    timeline = p.timeline ? { width: p.timeline.width, height: p.timeline.height, fps: p.timeline.fps } : null;
  } catch { /* payload stays empty */ }
  return {
    id: j.id, type: j.type, status: j.status, progress: j.progress,
    error: j.error, projectId: j.project_id, settings, timeline,
    hasOutput: Boolean(j.output_path && fs.existsSync(j.output_path)),
    createdAt: j.created_at, updatedAt: j.updated_at,
  };
}

// --- Capability lists: only what the editor + renderer actually support.
router.get('/effects', auth.requireAuth, (req, res) => {
  res.json({
    transitions: vm.TRANSITIONS.filter((t) => t.id !== 'none').map((t) => ({
      id: t.id, name: t.name, xfade: t.xfade, maxDuration: t.maxDuration,
      note: 'Rendered with FFmpeg xfade between adjacent clips on the same video track.',
    })),
    filters: vm.FILTERS,
    keyframeProperties: [
      { id: 'x', name: 'Position X (%)', note: 'Smooth pan via crop expressions.' },
      { id: 'y', name: 'Position Y (%)', note: 'Smooth pan via crop expressions.' },
      { id: 'scale', name: 'Scale / zoom (0.5–3)', note: 'Sampled into small segments; visually smooth.' },
      { id: 'opacity', name: 'Opacity (0–1)', note: 'Smooth fade via per-frame alpha.' },
    ],
    aspects: vm.ASPECTS,
    resolutions: vm.RESOLUTIONS,
    fpsOptions: vm.FPS_OPTIONS,
    notYet: [
      'Chroma key / green screen (Phase 7 AI tools)',
      'Stabilization and AI object removal (later phase)',
      'Proxy editing for large videos (later phase)',
      'Speed ramping curves and motion paths (later phase)',
    ],
  });
});

router.post('/validate', auth.requireAuth, (req, res) => {
  const errors = vm.validateTimeline(req.body && req.body.timeline);
  res.json({ valid: errors.length === 0, errors, duration: errors.length ? null : vm.totalDuration(req.body.timeline) });
});

// --- Render jobs ---
router.get('/jobs', auth.requireAuth, (req, res) => {
  res.json({ jobs: db.listJobs(req.user.id).map(publicJob) });
});

router.get('/jobs/:id', auth.requireAuth, (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  res.json({ job: publicJob(j) });
});

router.post('/jobs', auth.requireAuth, async (req, res) => {
  const { projectId, timeline, settings = {} } = req.body || {};
  let tl = timeline;
  let project = null;
  if (projectId) {
    project = db.getProject(req.user.id, projectId);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    if (project.type !== 'video') return res.status(400).json({ error: 'Only video projects can be rendered.' });
    try { tl = JSON.parse(project.content || '{}').timeline || JSON.parse(project.content || '{}'); } catch {
      return res.status(400).json({ error: 'Project content is not valid JSON.' });
    }
    // Project content may be the timeline itself or { timeline }.
    if (tl && tl.timeline) tl = tl.timeline;
  }
  if (!tl) return res.status(400).json({ error: 'A timeline is required to render.' });
  const errors = vm.validateTimeline(tl);
  if (errors.length) return res.status(400).json({ error: `Invalid timeline: ${errors.join(' ')}` });
  const fps = settings.fps || tl.fps;
  if (!vm.FPS_OPTIONS.includes(fps)) return res.status(400).json({ error: `fps must be one of ${vm.FPS_OPTIONS.join(', ')}.` });
  if (settings.width !== undefined || settings.height !== undefined) {
    if (!Number.isInteger(settings.width) || !Number.isInteger(settings.height) ||
        settings.width < 160 || settings.width > 1920 || settings.height < 160 || settings.height > 1920 ||
        settings.width % 2 || settings.height % 2) {
      return res.status(400).json({ error: 'Custom render size must be even numbers, 160–1920 px.' });
    }
  }
  const resolution = settings.resolution || '720p';
  if (!vm.RESOLUTIONS.find((r) => r.id === resolution) && settings.width === undefined) {
    return res.status(400).json({ error: `Unknown resolution "${resolution}".` });
  }
  // Every referenced media file must exist and belong to this user.
  for (const c of vm.allClips(tl)) {
    if (!c.mediaId) continue;
    const m = db.getMedia(req.user.id, c.mediaId);
    if (!m) return res.status(400).json({ error: `Media file #${c.mediaId} used by clip "${c.name}" was not found. Re-add it to the timeline.` });
    if (c.kind === 'video' && m.kind !== 'video') return res.status(400).json({ error: `Clip "${c.name}" is on a video track but its media is ${m.kind}, not video.` });
    if (c.kind === 'audio' && m.kind !== 'audio' && m.kind !== 'video') return res.status(400).json({ error: `Clip "${c.name}" is on an audio track but its media is ${m.kind}.` });
  }
  // Phase 8: a render costs 1 credit — refuse up front when the balance
  // cannot cover it (the actual charge happens on render success).
  const check = credits.checkCredits(req.user.id, 'render');
  if (!check.ok) return res.status(402).json({ error: check.error, code: check.code, needed: check.needed, balance: check.balance });
  const job = db.createJob(req.user.id, {
    type: 'render',
    projectId: project ? project.id : null,
    payload: { timeline: tl, settings: { resolution, fps, width: settings.width, height: settings.height } },
  });
  db.audit(req.user.id, 'render_queued', 'job', job.id, `Render queued for "${project ? project.name : 'timeline'}" (${resolution}, ${fps}fps)`);
  res.status(201).json({ job: publicJob(job) });
});

router.post('/jobs/:id/cancel', auth.requireAuth, (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  if (['done', 'failed', 'cancelled'].includes(j.status)) {
    return res.status(400).json({ error: `Job is already ${j.status} and cannot be cancelled.` });
  }
  cancelJob(j.id);
  db.audit(req.user.id, 'render_cancel_requested', 'job', j.id, 'Cancel requested');
  res.json({ job: publicJob(db.getJob(req.user.id, j.id)) });
});

router.post('/jobs/:id/retry', auth.requireAuth, (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  if (!['failed', 'cancelled'].includes(j.status)) {
    return res.status(400).json({ error: `Only failed or cancelled jobs can be retried (this one is ${j.status}).` });
  }
  db.updateJob(j.id, { status: 'queued', progress: 0, error: null });
  db.audit(req.user.id, 'render_retry', 'job', j.id, 'Render retried');
  res.json({ job: publicJob(db.getJob(req.user.id, j.id)) });
});

router.delete('/jobs/:id', auth.requireAuth, (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  if (['queued', 'running'].includes(j.status)) {
    return res.status(400).json({ error: 'Cancel a running or queued job first — it cannot be deleted while active.' });
  }
  if (j.output_path && fs.existsSync(j.output_path)) {
    try { fs.unlinkSync(j.output_path); } catch { /* ignore */ }
  }
  if (j.log_path && fs.existsSync(j.log_path)) {
    try { fs.unlinkSync(j.log_path); } catch { /* ignore */ }
  }
  db.deleteJob(req.user.id, j.id);
  res.json({ ok: true });
});

router.get('/jobs/:id/download', auth.requireAuth, (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  if (j.status !== 'done' || !j.output_path || !fs.existsSync(j.output_path)) {
    return res.status(404).json({ error: 'No finished render is available for this job yet.' });
  }
  res.type('video/mp4');
  res.set('Content-Disposition', `attachment; filename="creative-studio-render-${j.id}.mp4"`);
  fs.createReadStream(j.output_path).pipe(res);
});

router.get('/jobs/:id/log', auth.requireAuth, (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  let log = '';
  if (j.log_path && fs.existsSync(j.log_path)) {
    log = fs.readFileSync(j.log_path, 'utf8').slice(-20000);
  }
  res.json({ log, error: j.error, status: j.status });
});

router.post('/jobs/:id/save-to-library', auth.requireAuth, async (req, res) => {
  const j = db.getJob(req.user.id, req.params.id);
  if (!j) return res.status(404).json({ error: 'Render job not found.' });
  if (j.status !== 'done' || !j.output_path || !fs.existsSync(j.output_path)) {
    return res.status(400).json({ error: 'Only a finished render can be saved to the Media Library.' });
  }
  const crypto = require('crypto');
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.mp4`;
  const userDir = path.join(config.uploadsDir, String(req.user.id));
  fs.mkdirSync(userDir, { recursive: true });
  fs.copyFileSync(j.output_path, path.join(userDir, storedName));
  const probe = await probeMedia(j.output_path);
  const m = db.createMedia(req.user.id, {
    originalName: `render-${j.id}.mp4`,
    storedName,
    mimeType: 'video/mp4',
    kind: 'video',
    sizeBytes: fs.statSync(j.output_path).size,
    width: probe ? probe.width : null,
    height: probe ? probe.height : null,
    durationSeconds: probe ? probe.durationSeconds : null,
    tags: 'render',
  });
  if (probe) db.updateMedia(req.user.id, m.id, { fps: probe.fps, codec: probe.codec });
  db.audit(req.user.id, 'render_saved_to_library', 'media', m.id, `Render job ${j.id} saved to Media Library`);
  res.status(201).json({ media: { id: m.id, originalName: m.original_name } });
});

module.exports = router;
