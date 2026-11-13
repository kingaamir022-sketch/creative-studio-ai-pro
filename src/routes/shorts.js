'use strict';
// Shorts Studio routes (Phase 6).
// Long Video → ranked Shorts candidates → review → 9:16 renders with
// burned-in captions. Analysis is real local FFmpeg (scene changes,
// silence, audio energy) — no key, no provider. The engagement score is
// a transparent weighted sum shown with its breakdown; it never claims
// to predict virality. Captions have two honest paths: STT transcription
// via a provider (Phase 7: real Whisper calls when a key is configured;
// without a key the endpoint refuses with key_needed, never fakes a
// transcript) and manual transcripts, which work now. Renders run through
// the Phase 3 job queue.
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const { analyseVideo, buildClipCandidates, motionCentroid } = require('../shorts-analysis');
const { parseTimedText, distributePlainText, normaliseCues, toSRT, toVTT, cuesForClip, languageMeta, SUPPORTED_LANGUAGES } = require('../captions');
const { makeClipThumbnail, buildShortsZip } = require('../shorts');

const router = express.Router();

const DEFAULT_SETTINGS = {
  minClipSeconds: 15, maxClipSeconds: 60, maxClips: 10,
  sceneThreshold: 0.35, silenceDb: -35, resolution: '720p',
};

function publicJob(j) {
  let analysis = {};
  try { analysis = JSON.parse(j.analysis || '{}'); } catch { analysis = {}; }
  let transcript = null;
  try { transcript = JSON.parse(j.transcript || 'null'); } catch { transcript = null; }
  return {
    id: j.id, mediaId: j.media_id, name: j.name, status: j.status,
    language: j.language, transcriptSource: j.transcript_source,
    error: j.error || null,
    settings: JSON.parse(j.settings || '{}'),
    analysis: {
      durationSeconds: analysis.durationSeconds ?? null,
      width: analysis.width ?? null, height: analysis.height ?? null,
      fps: analysis.fps ?? null, hasAudio: Boolean(analysis.hasAudio),
      scenes: (analysis.scenes || []).length,
      silences: (analysis.silences || []).length,
      method: analysis.method || 'local-ffmpeg',
    },
    transcript: transcript ? {
      language: transcript.language, timing: transcript.timing,
      source: transcript.source, cues: transcript.cues.length,
    } : null,
    createdAt: j.created_at, updatedAt: j.updated_at,
  };
}

function publicClip(c) {
  let breakdown = {};
  try { breakdown = JSON.parse(c.breakdown || '{}'); } catch { breakdown = {}; }
  return {
    id: c.id, jobId: c.job_id, start: c.start_s, end: c.end_s,
    duration: Math.round((c.end_s - c.start_s) * 100) / 100,
    score: c.score, breakdown, status: c.status,
    motionX: c.motion_x, captionStatus: c.caption_status,
    outputJobId: c.output_job_id, error: c.error || null,
    hasOutput: Boolean(c.output_path && fs.existsSync(c.output_path)),
    createdAt: c.created_at,
  };
}

function mediaFilePath(userId, media) {
  return path.join(config.uploadsDir, String(userId), media.stored_name);
}

function refreshClipCaptionStatus(jobId) {
  const job = db.getShortsJobAny(jobId);
  if (!job) return;
  let transcript = null;
  try { transcript = JSON.parse(job.transcript || 'null'); } catch { transcript = null; }
  for (const clip of db.listShortsClips(jobId)) {
    if (clip.status === 'done') {
      db.updateShortsClip(clip.id, { caption_status: 'burned' });
      continue;
    }
    if (!transcript || !transcript.cues || !transcript.cues.length) {
      db.updateShortsClip(clip.id, { caption_status: 'none' });
    } else {
      const cues = cuesForClip(transcript.cues, clip.start_s, clip.end_s);
      db.updateShortsClip(clip.id, { caption_status: cues.length ? 'ready' : 'no-cues' });
    }
  }
}

// Background analysis: runs after POST /jobs returns, so a 60-minute
// video does not block the request. The job polls to 'ready' / 'failed'.
async function runShortsAnalysis(jobId) {
  const job = db.getShortsJobAny(jobId);
  if (!job) return;
  try {
    const media = db.getMedia(job.user_id, job.media_id);
    if (!media) throw new Error('Source video is missing (it may have been deleted).');
    const filePath = mediaFilePath(job.user_id, media);
    const settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(job.settings || '{}')) };
    const analysis = await analyseVideo(filePath, {
      sceneThreshold: settings.sceneThreshold, silenceDb: settings.silenceDb,
    });
    const candidates = buildClipCandidates(analysis, {
      minClipSeconds: settings.minClipSeconds,
      maxClipSeconds: settings.maxClipSeconds,
      maxClips: settings.maxClips,
    });
    // Motion centroid per candidate (reframe window). Sampled, capped to
    // the first 10 s of the clip inside motionCentroid.
    for (const c of candidates) {
      try {
        c.motionX = await motionCentroid(filePath, c.start, c.end);
      } catch { c.motionX = null; }
    }
    db.replaceShortsClips(jobId, candidates);
    db.updateShortsJob(jobId, { status: 'ready', analysis, error: null });
    db.audit(job.user_id, 'shorts_analysis_done', 'shorts_job', jobId,
      `Analysed "${job.name}": ${analysis.durationSeconds}s, ${analysis.scenes.length} scenes, ${candidates.length} clip candidates`);
  } catch (err) {
    db.updateShortsJob(jobId, { status: 'failed', error: String(err.message).slice(0, 1000) });
    db.audit(job.user_id, 'shorts_analysis_failed', 'shorts_job', jobId, String(err.message).slice(0, 500));
  }
}

// --- Videos available for Shorts ---
router.get('/videos', auth.requireAuth, (req, res) => {
  const videos = db.listMedia(req.user.id, { kind: 'video' });
  const jobs = db.listShortsJobs(req.user.id);
  const byMedia = new Map();
  for (const j of jobs) if (!byMedia.has(j.media_id)) byMedia.set(j.media_id, j);
  res.json({
    videos: videos.map((m) => {
      const j = byMedia.get(m.id);
      return {
        id: m.id, originalName: m.original_name, durationSeconds: m.duration_seconds,
        width: m.width, height: m.height, sizeBytes: m.size_bytes,
        thumbnail: m.thumbnail || null, createdAt: m.created_at,
        shortsJob: j ? { id: j.id, status: j.status, name: j.name } : null,
      };
    }),
  });
});

// --- Create a Shorts job (analysis starts in the background) ---
router.post('/jobs', auth.requireAuth, (req, res) => {
  const { mediaId, settings = {}, language = 'en', name } = req.body || {};
  const media = db.getMedia(req.user.id, mediaId);
  if (!media) return res.status(404).json({ error: 'Video not found.' });
  if (media.kind !== 'video') return res.status(400).json({ error: 'Shorts need a video file. This file is ' + media.kind + '.' });
  if (!languageMeta(language)) return res.status(400).json({ error: `Unsupported caption language: ${language}.` });
  const merged = {
    minClipSeconds: Math.max(3, Math.min(120, Number(settings.minClipSeconds) || DEFAULT_SETTINGS.minClipSeconds)),
    maxClipSeconds: Math.max(5, Math.min(180, Number(settings.maxClipSeconds) || DEFAULT_SETTINGS.maxClipSeconds)),
    maxClips: Math.max(1, Math.min(25, Number(settings.maxClips) || DEFAULT_SETTINGS.maxClips)),
    sceneThreshold: Math.max(0.1, Math.min(0.9, Number(settings.sceneThreshold) || DEFAULT_SETTINGS.sceneThreshold)),
    silenceDb: Math.max(-60, Math.min(-10, Number(settings.silenceDb) || DEFAULT_SETTINGS.silenceDb)),
    resolution: settings.resolution === '1080p' ? '1080p' : '720p',
  };
  if (merged.maxClipSeconds < merged.minClipSeconds) {
    return res.status(400).json({ error: 'Maximum clip length must be at least the minimum clip length.' });
  }
  const job = db.createShortsJob(req.user.id, {
    mediaId: media.id,
    name: name || `${media.original_name} — Shorts`,
    settings: merged, language,
  });
  db.audit(req.user.id, 'shorts_job_created', 'shorts_job', job.id, `Shorts job for "${media.original_name}"`);
  setImmediate(() => { runShortsAnalysis(job.id).catch(() => { /* errors are stored on the job */ }); });
  res.status(201).json({ job: publicJob(job), clips: [] });
});

// --- List jobs ---
router.get('/jobs', auth.requireAuth, (req, res) => {
  const jobs = db.listShortsJobs(req.user.id);
  res.json({
    jobs: jobs.map((j) => {
      const clips = db.listShortsClips(j.id);
      return {
        ...publicJob(j),
        clips: clips.length,
        approved: clips.filter((c) => c.status === 'approved' || c.status === 'done').length,
        done: clips.filter((c) => c.status === 'done').length,
      };
    }),
    supportedLanguages: SUPPORTED_LANGUAGES,
  });
});

// --- One job + its clips ---
router.get('/jobs/:id', auth.requireAuth, (req, res) => {
  const job = db.getShortsJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Shorts job not found.' });
  const clips = db.listShortsClips(job.id);
  res.json({
    job: publicJob(job),
    clips: clips.map(publicClip),
    supportedLanguages: SUPPORTED_LANGUAGES,
    scoreExplained: 'Score = 45% speech density + 30% audio energy + 15% scene-change rate + 10% position (earlier is slightly better). It measures how much is happening in a segment — it does not predict views or virality.',
    reframeNote: 'Reframe crops to 9:16 around the centre of motion in each clip. There is no face/subject tracking without a vision model (Phase 7).',
  });
});

// --- STT transcription (provider) — Phase 7: real Whisper calls. Without
// a key it refuses honestly with key_needed and creates no transcript.
router.post('/jobs/:id/transcribe', auth.requireAuth, async (req, res) => {
  const job = db.getShortsJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Shorts job not found.' });
  const language = (req.body && req.body.language) || job.language || undefined;
  try {
    const ai = require('../ai');
    const t = await ai.transcribeAudio(req.user.id, job.media_id, { language });
    const transcript = {
      cues: t.cues, timing: 'exact', source: 'stt', language: language || job.language || 'en',
      text: t.text, updatedAt: new Date().toISOString(),
    };
    db.updateShortsJob(job.id, { transcript, transcript_source: 'stt', language: transcript.language });
    refreshClipCaptionStatus(job.id);
    db.audit(req.user.id, 'shorts_transcribed', 'shorts_job', job.id,
      `Auto-transcribed "${job.name}" (${t.cues.length} cues, ${t.provider})`);
    res.json({ job: publicJob(db.getShortsJob(req.user.id, job.id)), cues: t.cues.length, timing: 'exact', warnings: t.warnings || [], provider: t.provider });
  } catch (err) {
    if (err.code === 'PROVIDER_KEY_NEEDED') {
      return res.status(402).json({
        error: err.message,
        code: 'PROVIDER_KEY_NEEDED',
        provider: 'stt',
        honestNote: 'No transcript was created and none was faked. Add a speech-to-text key in Settings → AI Providers, or use a manual transcript instead (paste text or SRT/VTT).',
      });
    }
    return res.status(400).json({ error: err.message, code: err.code || 'PROVIDER_ERROR' });
  }
});

// --- Save a manual transcript (plain text, SRT or VTT) ---
router.post('/jobs/:id/transcript', auth.requireAuth, (req, res) => {
  const job = db.getShortsJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Shorts job not found.' });
  const { format = 'text', text = '', language } = req.body || {};
  if (language && !languageMeta(language)) return res.status(400).json({ error: `Unsupported caption language: ${language}.` });
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Transcript text is empty.' });
  if (text.length > 200000) return res.status(400).json({ error: 'Transcript is too long (200,000 characters max).' });
  let analysis = {};
  try { analysis = JSON.parse(job.analysis || '{}'); } catch { analysis = {}; }
  const duration = analysis.durationSeconds || null;
  let cues;
  let timing;
  let source;
  const warnings = [];
  if (format === 'srt' || format === 'vtt') {
    const parsed = parseTimedText(text, format);
    cues = parsed.cues;
    warnings.push(...parsed.errors);
    timing = 'exact';
    source = format === 'srt' ? 'manual-srt' : 'manual-vtt';
    if (!cues.length) return res.status(400).json({ error: 'No valid cues found in the pasted ' + format.toUpperCase() + '. Check the timestamps.', warnings });
  } else if (format === 'text') {
    if (!duration) return res.status(400).json({ error: 'This job has no analysed duration yet — wait for analysis to finish before adding a plain-text transcript.' });
    cues = distributePlainText(text, duration);
    timing = 'estimated';
    source = 'manual-text';
    if (!cues.length) return res.status(400).json({ error: 'No transcript lines found.' });
    warnings.push('Timing is estimated: plain text has no timestamps, so lines are spread across the video by character count. Paste SRT/VTT for exact timing.');
  } else {
    return res.status(400).json({ error: `Unknown transcript format: ${format}. Use "text", "srt" or "vtt".` });
  }
  const norm = normaliseCues(cues, duration);
  warnings.push(...norm.warnings);
  const lang = language || job.language || 'en';
  const transcript = {
    cues: norm.cues, timing, source, language: lang,
    updatedAt: new Date().toISOString(),
  };
  db.updateShortsJob(job.id, { transcript, transcriptSource: source, language: lang });
  refreshClipCaptionStatus(job.id);
  db.audit(req.user.id, 'shorts_transcript_saved', 'shorts_job', job.id,
    `Manual transcript (${source}, ${norm.cues.length} cues, ${timing} timing)`);
  res.json({ job: publicJob(db.getShortsJob(req.user.id, job.id)), cues: norm.cues.length, timing, warnings });
});

// --- Export captions (line-level SRT / VTT) ---
router.get('/jobs/:id/captions.srt', auth.requireAuth, (req, res) => {
  const job = db.getShortsJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Shorts job not found.' });
  let transcript = null;
  try { transcript = JSON.parse(job.transcript || 'null'); } catch { transcript = null; }
  if (!transcript || !transcript.cues || !transcript.cues.length) {
    return res.status(400).json({ error: 'No transcript saved for this job yet.' });
  }
  res.type('text/plain; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="shorts-${job.id}-captions.srt"`);
  res.send(toSRT(transcript.cues));
});
router.get('/jobs/:id/captions.vtt', auth.requireAuth, (req, res) => {
  const job = db.getShortsJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Shorts job not found.' });
  let transcript = null;
  try { transcript = JSON.parse(job.transcript || 'null'); } catch { transcript = null; }
  if (!transcript || !transcript.cues || !transcript.cues.length) {
    return res.status(400).json({ error: 'No transcript saved for this job yet.' });
  }
  res.type('text/vtt; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="shorts-${job.id}-captions.vtt"`);
  res.send(toVTT(transcript.cues));
});

// --- Review one clip: approve / reject / re-open / trim ---
router.patch('/jobs/:id/clips/:clipId', auth.requireAuth, (req, res) => {
  const job = db.getShortsJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Shorts job not found.' });
  const clip = db.getShortsClip(job.id, req.params.clipId);
  if (!clip) return res.status(404).json({ error: 'Clip not found.' });
  if (clip.status === 'rendering' || clip.status === 'done') {
    return res.status(400).json({ error: `A ${clip.status} clip cannot be edited. Reject it first is not possible — rendered clips stay as they are; create a new analysis to re-cut.` });
  }
  const { status, start, end } = req.body || {};
  const fields = {};
  if (status !== undefined) {
    if (!['candidate', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: `Invalid clip status: ${status}.` });
    }
    fields.status = status;
  }
  let analysis = {};
  try { analysis = JSON.parse(job.analysis || '{}'); } catch { analysis = {}; }
  const duration = analysis.durationSeconds || Infinity;
  const newStart = start !== undefined ? Number(start) : clip.start_s;
  const newEnd = end !== undefined ? Number(end) : clip.end_s;
  if (start !== undefined || end !== undefined) {
    if (!Number.isFinite(newStart) || !Number.isFinite(newEnd) || newEnd <= newStart) {
      return res.status(400).json({ error: 'Clip end must be after clip start.' });
    }
    if (newStart < 0 || newEnd > duration + 0.01) {
      return res.status(400).json({ error: `Clip must stay inside the video (0–${Math.round(duration)}s).` });
    }
    if (newEnd - newStart < 3) return res.status(400).json({ error: 'A Short must be at least 3 seconds long.' });
    fields.start_s = Math.round(newStart * 100) / 100;
    fields.end_s = Math.round(newEnd * 100) / 100;
  }
  const updated = db.updateShortsClip(clip.id, fields);
  res.json({ clip: publicClip(updated) });
});

// --- Render approved clips (9:16, captions burned in) ---
router.post('/jobs/:id/render', auth.requireAuth, (req, res) => {
  const job = db.getShortsJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Shorts job not found.' });
  const { clipIds, resolution } = req.body || {};
  let clips = db.listShortsClips(job.id).filter((c) => c.status === 'approved');
  if (Array.isArray(clipIds) && clipIds.length) {
    const wanted = new Set(clipIds.map((x) => Number(x)));
    clips = clips.filter((c) => wanted.has(c.id));
  }
  if (!clips.length) return res.status(400).json({ error: 'No approved clips to render. Approve at least one clip first.' });
  const resName = resolution === '1080p' ? '1080p' : '720p';
  const created = [];
  for (const clip of clips) {
    const renderJob = db.createJob(req.user.id, {
      type: 'shorts',
      payload: { shorts: { shortsJobId: job.id, clipId: clip.id, resolution: resName } },
    });
    db.updateShortsClip(clip.id, { status: 'rendering', output_job_id: renderJob.id, error: null });
    created.push({ clipId: clip.id, jobId: renderJob.id, start: clip.start_s, end: clip.end_s });
  }
  db.audit(req.user.id, 'shorts_render_started', 'shorts_job', job.id,
    `Rendering ${created.length} Short(s) at ${resName} with captions`);
  res.status(201).json({ jobs: created, resolution: resName });
});

// --- ZIP of finished Shorts ---
router.get('/jobs/:id/zip', auth.requireAuth, async (req, res) => {
  const job = db.getShortsJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Shorts job not found.' });
  try {
    const zipPath = await buildShortsZip(req.user.id, job);
    res.type('application/zip');
    res.set('Content-Disposition', `attachment; filename="shorts-${job.id}-clips.zip"`);
    fs.createReadStream(zipPath).pipe(res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Download one finished Short ---
router.get('/jobs/:id/clips/:clipId/download', auth.requireAuth, (req, res) => {
  const job = db.getShortsJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Shorts job not found.' });
  const clip = db.getShortsClip(job.id, req.params.clipId);
  if (!clip) return res.status(404).json({ error: 'Clip not found.' });
  if (!clip.output_path || !fs.existsSync(clip.output_path)) {
    return res.status(400).json({ error: 'This clip has no finished render to download yet.' });
  }
  res.type('video/mp4');
  res.set('Content-Disposition', `attachment; filename="short-${clip.id}-${Math.round(clip.start_s)}s-${Math.round(clip.end_s)}s.mp4"`);
  fs.createReadStream(clip.output_path).pipe(res);
});

// --- Clip thumbnail (midpoint frame, cached in the renders dir) ---
router.get('/jobs/:id/clips/:clipId/thumbnail', auth.requireAuth, async (req, res) => {
  const job = db.getShortsJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Shorts job not found.' });
  const clip = db.getShortsClip(job.id, req.params.clipId);
  if (!clip) return res.status(404).json({ error: 'Clip not found.' });
  const media = db.getMedia(req.user.id, job.media_id);
  if (!media) return res.status(404).json({ error: 'Source video not found.' });
  const thumbPath = path.join(config.rendersDir, String(req.user.id), `shorts-thumb-${clip.id}.jpg`);
  try {
    if (!fs.existsSync(thumbPath)) {
      await makeClipThumbnail(mediaFilePath(req.user.id, media), clip, thumbPath);
    }
    res.type('image/jpeg');
    fs.createReadStream(thumbPath).pipe(res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Delete a job ---
router.delete('/jobs/:id', auth.requireAuth, (req, res) => {
  const job = db.getShortsJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Shorts job not found.' });
  db.deleteShortsJob(req.user.id, job.id);
  res.json({ deleted: true });
});

module.exports = router;
module.exports.runShortsAnalysis = runShortsAnalysis;
