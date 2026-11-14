'use strict';
// Music Sync Director — timeline rewriting (Phase 5).
// Pure functions: given a validated Phase 3 timeline, a real audio
// analysis (src/music-analysis.js) and sync options, produce a new
// timeline whose cuts, transitions, markers and audio follow the beat grid.
//
// Rules:
// - Beats are taken from the analysis, thinned by beatDivisor (every beat,
//   every 2nd, every 4th) and shifted by the audio trim offset (timeline
//   time = audio time - offset).
// - Cut mode splits main-video-track clips at beat times (Phase 3
//   no-overlap rules are preserved by splitClipAt).
// - Transition mode sets the chosen Phase 3 transition on clips that
//   start on a beat. NOTE: an xfade transition overlaps the previous clip
//   and shortens the rendered video by its duration, so later scenes sit
//   slightly earlier than the music grid — the report says so honestly.
// - Pulse mode adds scale/opacity keyframes to text clips (or the overlay
//   video track) at beat times: a quick swell that settles back in 0.15 s.
// - The music itself is added as one audio-track clip (marked
//   musicSync: true so re-apply / remove can find it). fitMode 'loop'
//   repeats the track to fill the video; 'trim' lets the music end early
//   (reported as a warning, never silently stretched).
// - Re-applying is idempotent: the previous sync (audio clip, beat/drop
//   markers, musicSync metadata) is stripped first.
const vm = require('./video-model');

const SYNC_MODES = ['cut', 'transition', 'both'];
const BEAT_DIVISORS = [1, 2, 4];
const PULSE_TARGETS = ['text', 'overlay'];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round2(v) { return Math.round(v * 100) / 100; }

function validateOptions(options = {}) {
  const o = {
    syncMode: options.syncMode || 'both',
    beatDivisor: options.beatDivisor || 1,
    transition: { type: 'fade', duration: 0.5, ...(options.transition || {}) },
    pulse: { enabled: false, target: 'text', strength: 0.6, ...(options.pulse || {}) },
    offset: options.offset || 0,
    fadeIn: options.fadeIn || 0,
    fadeOut: options.fadeOut || 0,
    volume: options.volume === undefined ? 0.8 : options.volume,
    fitMode: options.fitMode || 'loop',
  };
  const errors = [];
  if (!SYNC_MODES.includes(o.syncMode)) errors.push(`syncMode must be one of ${SYNC_MODES.join(', ')}.`);
  if (!BEAT_DIVISORS.includes(o.beatDivisor)) errors.push('beatDivisor must be 1, 2 or 4.');
  const trDef = vm.TRANSITIONS.find((t) => t.id === o.transition.type);
  if (!trDef || o.transition.type === 'none') errors.push('transition must be fade, dissolve, slide or wipe.');
  else if (!o.transition.duration || o.transition.duration <= 0 || o.transition.duration > trDef.maxDuration) {
    errors.push(`transition duration must be 0–${trDef.maxDuration}s.`);
  }
  if (!PULSE_TARGETS.includes(o.pulse.target)) errors.push('pulse target must be text or overlay.');
  if (o.pulse.strength < 0 || o.pulse.strength > 1) errors.push('pulse strength must be 0–1.');
  if (o.offset < 0 || o.offset > 3600) errors.push('offset must be 0–3600s.');
  if (o.fadeIn < 0 || o.fadeIn > 5) errors.push('fadeIn must be 0–5s.');
  if (o.fadeOut < 0 || o.fadeOut > 5) errors.push('fadeOut must be 0–5s.');
  if (o.volume < 0 || o.volume > 1) errors.push('volume must be 0–1.');
  if (!['loop', 'trim'].includes(o.fitMode)) errors.push("fitMode must be 'loop' or 'trim'.");
  return { options: o, errors };
}

// Beats in timeline time: thin by divisor, subtract the trim offset, keep
// only beats inside the video.
function timelineBeats(analysis, options, videoDuration) {
  const beats = (analysis.beats || []).filter((_, i) => i % options.beatDivisor === 0);
  return beats
    .map((b) => round2(b - options.offset))
    .filter((b) => b > 0.05 && b < videoDuration - 0.05);
}

// Nearest beat to a time, within a threshold (seconds). Returns the beat
// time or null. Used by the Video Editor's beat-snap.
function snapToBeat(time, beats, threshold = 0.08) {
  if (!beats || !beats.length) return null;
  let best = null;
  let bestD = threshold;
  for (const b of beats) {
    const d = Math.abs(b - time);
    if (d <= bestD) { best = b; bestD = d; }
  }
  return best;
}

// Remove a previous sync from a timeline (audio clip, beat/drop markers,
// metadata). Returns a deep copy.
function stripSync(timeline) {
  const t = vm.deep(timeline);
  for (const tr of t.tracks) {
    tr.clips = tr.clips.filter((c) => !c.musicSync);
  }
  t.markers = (t.markers || []).filter((m) => m.label !== 'Beat' && m.label !== 'Drop');
  delete t.musicSync;
  return t;
}

function applyMusicSync(timeline, analysis, mediaId, trackName, rawOptions = {}) {
  const { options, errors } = validateOptions(rawOptions);
  if (errors.length) return { timeline, report: null, error: errors.join(' ') };
  if (!analysis || !Array.isArray(analysis.beats) || analysis.beats.length < 2) {
    return { timeline, report: null, error: 'This track has no analysed beat grid yet. Analyse it first.' };
  }
  const videoDuration = vm.totalDuration(timeline);
  if (videoDuration <= 0) return { timeline, report: null, error: 'The timeline is empty — add video clips before syncing.' };
  const audioDuration = analysis.durationSeconds;
  const audioRemaining = audioDuration - options.offset;
  if (audioRemaining <= 0.5) {
    return { timeline, report: null, error: `The trim offset (${options.offset}s) is longer than the track (${audioDuration}s).` };
  }

  let t = stripSync(timeline);
  const beats = timelineBeats(analysis, options, videoDuration);
  const warnings = [];
  if (analysis.lowConfidence) {
    warnings.push(`Low beat confidence (${analysis.confidence}) — this track's rhythm is hard to detect (common for ambient, classical or vocal-only audio). Check the beat grid in the editor before rendering.`);
  }
  if (!beats.length) {
    warnings.push('No beats fall inside this video — the video may be shorter than one beat, or the trim offset pushed the grid out. The music clip was still added, but no cuts or transitions were made.');
  }

  let cuts = 0;
  let transitions = 0;
  const mainTrackOf = (tl) => tl.tracks.find((tr) => tr.kind === 'video');
  const doCut = options.syncMode === 'cut' || options.syncMode === 'both';
  const doTransition = options.syncMode === 'transition' || options.syncMode === 'both';

  // --- Cut the main video track at beat times.
  if (doCut && beats.length) {
    for (const beat of beats) {
      // Re-fetch the track each time: splitClipAt returns a NEW timeline.
      const track = mainTrackOf(t);
      if (!track) break;
      const clip = track.clips.find((c) => beat > c.start + 0.05 && beat < c.start + c.duration - 0.05);
      if (!clip) continue;
      const res = vm.splitClipAt(t, clip.id, beat);
      if (!res.error) {
        t = res.timeline;
        cuts++;
      }
    }
  }

  // --- Transitions on clips that start on a beat.
  if (doTransition && beats.length) {
    const mainTrack = mainTrackOf(t);
    const beatSet = new Set(beats.map((b) => b.toFixed(2)));
    const sorted = [...mainTrack.clips].sort((a, b) => a.start - b.start);
    sorted.forEach((clip, idx) => {
      if (idx === 0) return; // the first clip has nothing to transition from
      if (!beatSet.has(clip.start.toFixed(2))) return;
      const d = Math.min(options.transition.duration, clip.duration / 2, 2);
      if (d < 0.1) return;
      clip.transition = { type: options.transition.type, duration: round2(d) };
      transitions++;
    });
    if (transitions > 0) {
      warnings.push(`Each ${options.transition.type} transition overlaps the previous clip, so the rendered video is ~${round2(transitions * options.transition.duration)}s shorter than the timeline and later scenes sit slightly earlier than the music grid. Use "Cut on beat" alone for sample-exact sync.`);
    }
  }

  // --- Beat pulse keyframes (text or overlay video).
  let pulseKeyframes = 0;
  if (options.pulse.enabled) {
    const swell = 1 + 0.3 * options.pulse.strength;
    const addPulse = (clip, beatTimes) => {
      clip.keyframes = clip.keyframes || [];
      for (const b of beatTimes) {
        const rel = round2(b - clip.start);
        if (rel < 0.05 || rel > clip.duration - 0.2) continue;
        const up = { t: rel, scale: round2(swell), opacity: 1 };
        const down = { t: round2(Math.min(clip.duration, rel + 0.15)), scale: 1, opacity: 1 };
        clip.keyframes.push(up, down);
        pulseKeyframes += 2;
      }
      // De-duplicate identical times (beats can coincide with existing keys).
      const seen = new Set();
      clip.keyframes = clip.keyframes
        .filter((k) => {
          const key = `${k.t}:${k.scale}:${k.opacity}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => a.t - b.t);
    };
    if (options.pulse.target === 'text') {
      for (const tr of t.tracks.filter((x) => x.kind === 'text')) {
        for (const clip of tr.clips) addPulse(clip, beats);
      }
    } else {
      const overlay = t.tracks.filter((x) => x.kind === 'video')[1];
      if (overlay) for (const clip of overlay.clips) addPulse(clip, beats);
      else warnings.push('Pulse target was the overlay video track, but this project has no overlay track — no pulse was added.');
    }
  }

  // --- Markers: beats (capped so a long video does not get 1000 markers)
  // and drops inside the video.
  const markerBeats = beats.slice(0, 200);
  for (const b of markerBeats) t.markers.push({ t: b, label: 'Beat' });
  let dropMarkers = 0;
  for (const d of analysis.drops || []) {
    const dt = round2(d.t - options.offset);
    if (dt > 0 && dt < videoDuration) { t.markers.push({ t: dt, label: 'Drop' }); dropMarkers++; }
  }
  t.markers.sort((a, b) => a.t - b.t);

  // --- Music audio clip (one track + the video's own audio is out of scope
  // for multi-track mixing; the renderer's amix blends both).
  // C-08: never push the music clip onto an occupied audio track — an
  // existing clip there would overlap it and the timeline validation
  // would refuse the whole sync (400). Use the first audio track whose
  // clips do not overlap [0, audioClipDuration), else add a new track.
  const loop = options.fitMode === 'loop';
  const audioClipDuration = loop ? videoDuration : Math.min(audioRemaining, videoDuration);
  let audioTrack = t.tracks.filter((tr) => tr.kind === 'audio').find((tr) => !tr.clips.some((c) => 0 < c.start + c.duration && c.start < audioClipDuration));
  if (!audioTrack) {
    const audioCount = t.tracks.filter((tr) => tr.kind === 'audio').length;
    audioTrack = { id: vm.uid('track'), kind: 'audio', name: `Audio ${audioCount + 1}`, locked: false, muted: false, clips: [] };
    t.tracks.push(audioTrack);
  }
  const audioClip = vm.defaultClip('audio', mediaId, 0, round2(audioClipDuration));
  audioClip.name = `Music: ${trackName}`;
  audioClip.volume = options.volume;
  audioClip.fadeIn = options.fadeIn;
  audioClip.fadeOut = options.fadeOut;
  audioClip.srcStart = options.offset;
  audioClip.loop = loop;
  audioClip.musicSync = true;
  audioTrack.clips.push(audioClip);
  if (!loop && audioRemaining < videoDuration) {
    warnings.push(`The music (${round2(audioRemaining)}s after the trim) is shorter than the video (${round2(videoDuration)}s) and fit mode is "trim", so the last ${round2(videoDuration - audioRemaining)}s play without music. Switch to "loop" to repeat the track.`);
  }

  t.musicSync = {
    mediaId, trackName, bpm: analysis.bpm, confidence: analysis.confidence,
    lowConfidence: analysis.lowConfidence,
    beats, downbeats: analysis.downbeats || [],
    beatDivisor: options.beatDivisor, syncMode: options.syncMode,
    transition: options.transition, pulse: options.pulse,
    offset: options.offset, fitMode: options.fitMode,
    appliedAt: new Date().toISOString(),
  };

  // Round clip times to milliseconds: repeated splits accumulate float
  // dust (e.g. 1.0000000000000002s) that is harmless but ugly in the UI
  // and in FFmpeg arguments.
  for (const tr of t.tracks) {
    for (const c of tr.clips) {
      c.start = round2(c.start);
      c.duration = Math.max(0.05, round2(c.duration));
      c.srcStart = round2(c.srcStart);
    }
  }

  const validation = vm.validateTimeline(t);
  if (validation.length) {
    return { timeline, report: null, error: `Sync produced an invalid timeline: ${validation.join(' ')}` };
  }

  const report = {
    bpm: analysis.bpm,
    confidence: analysis.confidence,
    lowConfidence: analysis.lowConfidence,
    beatsUsed: beats.length,
    cuts, transitions, pulseKeyframes,
    markersAdded: markerBeats.length + dropMarkers,
    dropMarkers,
    videoDuration: round2(videoDuration),
    audioDuration: round2(audioDuration),
    audioEndsAt: round2(audioClipDuration),
    fitMode: options.fitMode,
    warnings,
  };
  return { timeline: t, report, error: null };
}

module.exports = {
  SYNC_MODES, BEAT_DIVISORS, PULSE_TARGETS,
  validateOptions, timelineBeats, snapToBeat, stripSync, applyMusicSync,
};
