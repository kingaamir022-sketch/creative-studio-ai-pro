'use strict';
// Music Sync Director routes (Phase 5).
// Real local-DSP analysis (no key, no provider): decode with FFmpeg and
// compute BPM / beat grid / drops in src/music-analysis.js. Analysis is
// cached per (user, media, file hash) so re-analysis is instant.
// Music is user-provided / licensed only: the UI labels every track that
// way and lets the owner record a license/source note. Nothing here
// downloads stock music or generates music (generation is Phase 7).
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const vm = require('../video-model');
const { analyzeAudioFile, fileHash } = require('../music-analysis');
const { applyMusicSync, stripSync } = require('../music-sync');

const router = express.Router();

function publicAnalysis(row) {
  const a = row.analysis || {};
  return {
    mediaId: row.media_id,
    fileHash: row.file_hash,
    bpm: a.bpm ?? null,
    durationSeconds: a.durationSeconds ?? null,
    confidence: a.confidence ?? null,
    lowConfidence: Boolean(a.lowConfidence),
    beats: a.beats || [],
    downbeats: a.downbeats || [],
    drops: a.drops || [],
    energyCurve: a.energyCurve || [],
    waveformPeaks: a.waveformPeaks || [],
    periodSeconds: a.periodSeconds ?? null,
    method: a.method || 'local-dsp',
    truncated: Boolean(a.truncated),
    truncationNote: a.truncationNote || null,
    analysedAt: row.updated_at,
  };
}

function mediaFilePath(userId, media) {
  return path.join(config.uploadsDir, String(userId), media.stored_name);
}

async function analyseMedia(userId, media) {
  const filePath = mediaFilePath(userId, media);
  if (!fs.existsSync(filePath)) throw new Error(`Audio file "${media.original_name}" is missing on disk.`);
  const hash = await fileHash(filePath);
  const cached = db.getAudioAnalysis(userId, media.id);
  if (cached && cached.file_hash === hash) return { analysis: publicAnalysis(cached), cached: true };
  const analysis = await analyzeAudioFile(filePath);
  const saved = db.upsertAudioAnalysis(userId, media.id, hash, analysis);
  return { analysis: publicAnalysis(saved), cached: false };
}

// --- Music Library: the user's own audio tracks, with analysis status ---
router.get('/tracks', auth.requireAuth, (req, res) => {
  const audio = db.listMedia(req.user.id, { kind: 'audio' });
  const cached = new Map(db.listAudioAnalyses(req.user.id).map((r) => [r.media_id, r]));
  res.json({
    licensedOnly: true,
    notice: 'Licensed or user-provided music only. CreativeStudio does not download stock or copyrighted music and does not generate music (AI music generation is Phase 7 and needs a provider key).',
    tracks: audio.map((m) => {
      const row = cached.get(m.id);
      const a = row ? JSON.parse(row.analysis || '{}') : null;
      return {
        id: m.id, originalName: m.original_name, mimeType: m.mime_type,
        sizeBytes: m.size_bytes, durationSeconds: m.duration_seconds,
        licenseNote: m.license_note || '',
        analysed: Boolean(row),
        bpm: a ? a.bpm : null,
        confidence: a ? a.confidence : null,
        lowConfidence: a ? Boolean(a.lowConfidence) : false,
        beats: a ? (a.beats || []).length : 0,
        drops: a ? (a.drops || []).length : 0,
        createdAt: m.created_at,
      };
    }),
  });
});

// --- Analyse one track (cached by file hash) ---
router.post('/tracks/:id/analyze', auth.requireAuth, async (req, res) => {
  const m = db.getMedia(req.user.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Media not found.' });
  if (m.kind !== 'audio') return res.status(400).json({ error: 'Only audio files can be analysed for beats. This file is ' + m.kind + '.' });
  try {
    const { analysis, cached } = await analyseMedia(req.user.id, m);
    db.audit(req.user.id, cached ? 'music_analysis_cached' : 'music_analysis_done', 'media', m.id,
      `Analysed "${m.original_name}": ${analysis.bpm} BPM, ${analysis.beats.length} beats, confidence ${analysis.confidence}${cached ? ' (cached)' : ''}`);
    res.json({ analysis, cached });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Cached analysis for one track ---
router.get('/tracks/:id/analysis', auth.requireAuth, (req, res) => {
  const m = db.getMedia(req.user.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Media not found.' });
  const row = db.getAudioAnalysis(req.user.id, m.id);
  if (!row) return res.status(404).json({ error: 'This track has not been analysed yet.', analysed: false });
  res.json({ analysis: publicAnalysis(row), cached: true });
});

// --- License / source note for a track ---
router.patch('/tracks/:id/license', auth.requireAuth, (req, res) => {
  const { licenseNote } = req.body || {};
  if (licenseNote !== undefined && (typeof licenseNote !== 'string' || licenseNote.length > 300)) {
    return res.status(400).json({ error: 'License note must be a string of at most 300 characters.' });
  }
  const m = db.getMedia(req.user.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Media not found.' });
  if (m.kind !== 'audio') return res.status(400).json({ error: 'Only audio tracks carry a license note.' });
  const updated = db.updateMedia(req.user.id, m.id, { licenseNote: licenseNote || '' });
  res.json({ media: { id: updated.id, originalName: updated.original_name, licenseNote: updated.license_note || '' } });
});

// --- Apply sync to a video project ---
router.post('/projects/:projectId/apply-sync', auth.requireAuth, async (req, res) => {
  const { mediaId, options = {} } = req.body || {};
  const project = db.getProject(req.user.id, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (project.type !== 'video') return res.status(400).json({ error: 'Only video projects can be synced to music.' });
  const media = db.getMedia(req.user.id, mediaId);
  if (!media) return res.status(404).json({ error: 'Music track not found.' });
  if (media.kind !== 'audio') return res.status(400).json({ error: 'The music track must be an audio file.' });
  let content;
  try { content = JSON.parse(project.content || '{}'); } catch {
    return res.status(400).json({ error: 'Project content is not valid JSON.' });
  }
  const timeline = content.timeline || content;
  if (!timeline || !Array.isArray(timeline.tracks)) {
    return res.status(400).json({ error: 'This project has no timeline yet. Open it in the Video Editor and add clips first.' });
  }
  try {
    const { analysis } = await analyseMedia(req.user.id, media);
    const { timeline: synced, report, error } = applyMusicSync(timeline, analysis, media.id, media.original_name, options);
    if (error) return res.status(400).json({ error });
    db.saveProjectVersion(project.id, project.content, `Before music sync (${analysis.bpm} BPM)`);
    db.updateProject(req.user.id, project.id, { content: { timeline: synced } });
    db.audit(req.user.id, 'music_sync_applied', 'project', project.id,
      `Synced "${project.name}" to "${media.original_name}" (${analysis.bpm} BPM): ${report.cuts} cuts, ${report.transitions} transitions, ${report.beatsUsed} beats`);
    res.json({ project: { id: project.id, name: project.name }, timeline: synced, report, analysis: { bpm: analysis.bpm, confidence: analysis.confidence, beats: analysis.beats.length } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Current sync state of a project ---
router.get('/projects/:projectId/sync', auth.requireAuth, (req, res) => {
  const project = db.getProject(req.user.id, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  let content;
  try { content = JSON.parse(project.content || '{}'); } catch { content = {}; }
  const timeline = content.timeline || content;
  const musicSync = timeline && timeline.musicSync ? timeline.musicSync : null;
  res.json({ synced: Boolean(musicSync), musicSync, project: { id: project.id, name: project.name } });
});

// --- Remove sync (restores the pre-sync timeline shape: music clip +
// beat/drop markers + metadata are stripped; the cuts stay, since the
// user can Undo in the editor or restore the saved version) ---
router.post('/projects/:projectId/remove-sync', auth.requireAuth, (req, res) => {
  const project = db.getProject(req.user.id, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  let content;
  try { content = JSON.parse(project.content || '{}'); } catch {
    return res.status(400).json({ error: 'Project content is not valid JSON.' });
  }
  const timeline = content.timeline || content;
  if (!timeline || !timeline.musicSync) return res.status(400).json({ error: 'This project has no music sync to remove.' });
  const stripped = stripSync(timeline);
  db.saveProjectVersion(project.id, project.content, 'Before removing music sync');
  db.updateProject(req.user.id, project.id, { content: { timeline: stripped } });
  db.audit(req.user.id, 'music_sync_removed', 'project', project.id, `Removed music sync from "${project.name}"`);
  res.json({ timeline: stripped, synced: false });
});

module.exports = router;
