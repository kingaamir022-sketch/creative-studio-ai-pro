'use strict';
// Shorts analysis (Phase 6) — real local analysis, no AI key, no provider.
// Three FFmpeg signals, all measured from the actual file:
//   1. Scene changes — `select='gt(scene,…)'` + metadata print (lavfi.scene_score).
//   2. Silence — `silencedetect` (speech activity = "not silent").
//   3. Audio energy — the file is decoded to 8 kHz mono PCM and RMS is
//      computed per 0.5 s window in Node (same decode pattern as Phase 5).
// Clip candidates are built from scene-bounded segments and ranked by an
// EXPLAINABLE score: a transparent weighted sum of speech density, energy,
// scene-change rate and position. The breakdown is stored with every clip
// and shown in the UI. It is a content-activity score — it NEVER claims to
// predict virality.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const { probeMedia } = require('./ffmpeg');

function runCapture(cmd, args, { timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`${cmd} failed: ${String(stderr || err.message).slice(-600)}`);
        e.stderr = stderr || '';
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
  });
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// --- Scene changes -------------------------------------------------------
async function detectScenes(filePath, threshold = 0.35) {
  // select passes only frames whose scene score exceeds the threshold;
  // metadata=print reports lavfi.scene_score + pts_time for those frames.
  const { stderr } = await runCapture('ffmpeg', [
    '-v', 'info', '-i', filePath,
    '-vf', `select='gt(scene,${threshold})',metadata=print:key=lavfi.scene_score`,
    '-f', 'null', '-',
  ]);
  const scenes = [];
  let pendingTime = null;
  for (const line of String(stderr).split('\n')) {
    const tm = line.match(/pts_time:([0-9.]+)/);
    if (tm) pendingTime = parseFloat(tm[1]);
    const sm = line.match(/lavfi\.scene_score=([0-9.]+)/);
    if (sm && pendingTime !== null) {
      const score = parseFloat(sm[1]);
      if (pendingTime > 0.5 && score >= threshold) scenes.push({ time: Math.round(pendingTime * 100) / 100, score: Math.round(score * 1000) / 1000 });
      pendingTime = null;
    }
  }
  // Dedupe (same frame can be reported twice) and sort.
  const out = [];
  for (const s of scenes.sort((a, b) => a.time - b.time)) {
    if (!out.length || s.time - out[out.length - 1].time > 0.3) out.push(s);
  }
  return out;
}

// --- Silence -------------------------------------------------------------
async function detectSilence(filePath, noiseDb = -35, minDur = 0.5) {
  const { stderr } = await runCapture('ffmpeg', [
    '-v', 'info', '-i', filePath,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`,
    '-f', 'null', '-',
  ]);
  const silences = [];
  let start = null;
  for (const line of String(stderr).split('\n')) {
    const sm = line.match(/silence_start:\s*([0-9.]+)/);
    if (sm) start = parseFloat(sm[1]);
    const em = line.match(/silence_end:\s*([0-9.]+)/);
    if (em && start !== null) {
      silences.push({ start: Math.round(start * 100) / 100, end: Math.round(parseFloat(em[1]) * 100) / 100 });
      start = null;
    }
  }
  return silences;
}

// --- Audio energy curve --------------------------------------------------
// Decodes to 8 kHz mono s16le PCM and computes RMS per window (default
// 0.5 s). Returns { windowSeconds, rms: [0..1 normalised], maxRms }.
// A file with no audio stream returns an empty curve (callers treat
// speech/energy as 0, not as an error).
async function energyCurve(filePath, windowSeconds = 0.5) {
  const probe = await probeMedia(filePath);
  if (!probe || !probe.hasAudio) return { windowSeconds, rms: [], maxRms: 0, hasAudio: false };
  const samples = await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', filePath, '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', () => { /* ignore progress chatter */ });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`FFmpeg audio decode failed (code ${code}).`));
      resolve(Buffer.concat(chunks));
    });
  });
  const perWindow = Math.max(1, Math.round(8000 * windowSeconds));
  const rms = [];
  let maxRms = 0;
  for (let off = 0; off + perWindow * 2 <= samples.length; off += perWindow * 2) {
    let sum = 0;
    for (let i = 0; i < perWindow; i++) {
      const v = samples.readInt16LE(off + i * 2) / 32768;
      sum += v * v;
    }
    const r = Math.sqrt(sum / perWindow);
    rms.push(r);
    if (r > maxRms) maxRms = r;
  }
  const norm = maxRms > 0 ? rms.map((r) => Math.round((r / maxRms) * 1000) / 1000) : rms.map(() => 0);
  return { windowSeconds, rms: norm, maxRms, hasAudio: true };
}

// --- Motion centroid (for the 9:16 reframe) ------------------------------
// Samples the segment at 2 fps, 160 px wide, grayscale; the horizontal
// centroid of frame-to-frame difference energy is where the action is.
// Returns a 0..1 x-position (0.5 = centre) or null when nothing moves.
async function motionCentroid(filePath, start, end) {
  const dur = Math.max(0.5, end - start);
  const sampleDur = Math.min(dur, 10);
  const frames = await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v', 'error', '-ss', String(start), '-t', String(sampleDur),
      '-i', filePath, '-vf', 'fps=2,scale=160:-1,format=gray',
      '-f', 'rawvideo', '-',
    ]);
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`FFmpeg frame sampling failed (code ${code}).`));
      resolve(Buffer.concat(chunks));
    });
  });
  // Frame size is unknown until we know the scaled height; recover it from
  // the probe (aspect preserved by scale=160:-1).
  const probe = await probeMedia(filePath);
  if (!probe || !probe.width || !probe.height) return null;
  const w = 160;
  const h = Math.max(2, Math.round((160 * probe.height) / probe.width));
  const frameBytes = w * h;
  if (frames.length < frameBytes * 2) return null;
  const nFrames = Math.floor(frames.length / frameBytes);
  let colEnergy = new Array(w).fill(0);
  for (let f = 1; f < nFrames; f++) {
    const prev = frames.subarray((f - 1) * frameBytes, f * frameBytes);
    const cur = frames.subarray(f * frameBytes, (f + 1) * frameBytes);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.abs(cur[y * w + x] - prev[y * w + x]);
        if (d > 12) colEnergy[x] += d;
      }
    }
  }
  let total = 0;
  let weighted = 0;
  for (let x = 0; x < w; x++) { total += colEnergy[x]; weighted += colEnergy[x] * (x + 0.5); }
  if (total <= 0) return null;
  return Math.round((weighted / total / w) * 1000) / 1000;
}

// --- Full video analysis -------------------------------------------------
async function analyseVideo(filePath, { sceneThreshold = 0.35, silenceDb = -35 } = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`Video file "${filePath}" is missing on disk.`);
  const probe = await probeMedia(filePath);
  if (!probe || !probe.hasVideo) throw new Error('This file has no video stream. Shorts need a video file.');
  if (!probe.durationSeconds || probe.durationSeconds <= 0) throw new Error('Could not read this video\'s duration.');
  const [scenes, silences, energy] = await Promise.all([
    detectScenes(filePath, sceneThreshold),
    probe.hasAudio ? detectSilence(filePath, silenceDb, 0.5) : Promise.resolve([]),
    energyCurve(filePath, 0.5),
  ]);
  return {
    durationSeconds: Math.round(probe.durationSeconds * 100) / 100,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    hasAudio: Boolean(probe.hasAudio),
    scenes,
    silences,
    energyCurve: energy,
    method: 'local-ffmpeg',
    analysedAt: new Date().toISOString(),
  };
}

// --- Clip candidates + explainable ranking -------------------------------
const SCORE_WEIGHTS = { speech: 0.45, energy: 0.30, sceneRate: 0.15, position: 0.10 };

function silentFraction(silences, start, end) {
  let silent = 0;
  for (const s of silences) {
    const overlap = Math.max(0, Math.min(end, s.end) - Math.max(start, s.start));
    silent += overlap;
  }
  return clamp(silent / Math.max(0.001, end - start), 0, 1);
}

function meanEnergy(energy, start, end) {
  if (!energy || !energy.rms || !energy.rms.length) return 0;
  const w = energy.windowSeconds || 0.5;
  const i0 = Math.max(0, Math.floor(start / w));
  const i1 = Math.min(energy.rms.length - 1, Math.floor(end / w));
  if (i1 < i0) return 0;
  let sum = 0;
  for (let i = i0; i <= i1; i++) sum += energy.rms[i];
  return Math.round((sum / (i1 - i0 + 1)) * 1000) / 1000;
}

function buildClipCandidates(analysis, {
  minClipSeconds = 15, maxClipSeconds = 60, maxClips = 10,
} = {}) {
  const dur = analysis.durationSeconds;
  const minC = Math.max(3, minClipSeconds);
  const maxC = Math.max(minC, maxClipSeconds);
  const boundaries = [0, ...analysis.scenes.map((s) => s.time), dur]
    .filter((t, i, a) => t >= 0 && t <= dur && a.indexOf(t) === i)
    .sort((a, b) => a - b);
  // Base segments between scene boundaries.
  let segments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    segments.push({ start: boundaries[i], end: boundaries[i + 1] });
  }
  // Merge segments shorter than the minimum into the following one (or the
  // previous one for the last segment) so no candidate is a flash frame.
  const merged = [];
  for (const seg of segments) {
    if (merged.length && (seg.end - seg.start) < minC && merged[merged.length - 1].end - merged[merged.length - 1].start < maxC) {
      merged[merged.length - 1].end = seg.end;
    } else if (merged.length && (merged[merged.length - 1].end - merged[merged.length - 1].start) < minC) {
      merged[merged.length - 1].end = seg.end;
    } else {
      merged.push({ ...seg });
    }
  }
  segments = merged.filter((s) => s.end - s.start >= 1);
  // Split segments longer than the maximum at silence midpoints, else evenly.
  const split = [];
  for (const seg of segments) {
    let cursor = seg.start;
    while (seg.end - cursor > maxC) {
      const cutAt = cursor + maxC;
      // Prefer a silence boundary near the cut: use the silence midpoint
      // closest to the ideal cut within ±25% of maxC.
      let best = cutAt;
      for (const s of analysis.silences || []) {
        const mid = (s.start + s.end) / 2;
        if (mid > cursor + maxC * 0.5 && mid < cursor + maxC && Math.abs(mid - cutAt) < Math.abs(best - cutAt)) best = mid;
      }
      split.push({ start: cursor, end: Math.round(best * 100) / 100 });
      cursor = Math.round(best * 100) / 100;
    }
    split.push({ start: cursor, end: seg.end });
  }
  // Score every candidate with a transparent breakdown.
  const scored = split
    .filter((s) => s.end - s.start >= minC - 0.001)
    .map((s) => {
      const len = s.end - s.start;
      const speech = Math.round((1 - silentFraction(analysis.silences || [], s.start, s.end)) * 1000) / 1000;
      const energy = meanEnergy(analysis.energyCurve, s.start, s.end);
      const innerScenes = analysis.scenes.filter((sc) => sc.time > s.start + 0.5 && sc.time < s.end - 0.5).length;
      const sceneRate = Math.round(clamp(innerScenes / 3, 0, 1) * 1000) / 1000;
      const position = Math.round(clamp(1 - (s.start / dur) * 0.5, 0.5, 1) * 1000) / 1000;
      const score = Math.round(100 * (
        SCORE_WEIGHTS.speech * speech +
        SCORE_WEIGHTS.energy * energy +
        SCORE_WEIGHTS.sceneRate * sceneRate +
        SCORE_WEIGHTS.position * position
      ));
      return {
        start: Math.round(s.start * 100) / 100,
        end: Math.round(s.end * 100) / 100,
        duration: Math.round(len * 100) / 100,
        score,
        breakdown: { speechDensity: speech, energy, sceneRate, position },
        weights: { ...SCORE_WEIGHTS },
      };
    });
  scored.sort((a, b) => b.score - a.score || a.start - b.start);
  return scored.slice(0, Math.max(1, maxClips));
}

// --- Reframe geometry ----------------------------------------------------
// 9:16 crop window for a source frame. cropW/cropH follow the source
// height (the full height is kept); x is centred on the motion centroid
// (0..1) and clamped so the window never leaves the frame. Everything is
// rounded to even numbers (yuv420p chroma safety).
function reframeWindow(sourceWidth, sourceHeight, motionX = 0.5, outW = 1080, outH = 1920) {
  const targetAspect = outW / outH; // 9:16
  let cropW;
  let cropH;
  let cropY = 0;
  if (sourceWidth / sourceHeight > targetAspect) {
    // Wider than 9:16 — crop the width, keep full height.
    cropH = sourceHeight;
    cropW = Math.round(sourceHeight * targetAspect);
  } else {
    // Taller than (or equal to) 9:16 — crop the height, keep full width.
    cropW = sourceWidth;
    cropH = Math.round(sourceWidth / targetAspect);
    cropY = Math.round((sourceHeight - cropH) / 2);
  }
  cropW = Math.max(2, Math.round(cropW / 2) * 2);
  cropH = Math.max(2, Math.round(cropH / 2) * 2);
  cropY = Math.max(0, Math.round(cropY / 2) * 2);
  const maxX = Math.max(0, sourceWidth - cropW);
  const cx = clamp(motionX ?? 0.5, 0, 1);
  const cropX = Math.max(0, Math.min(maxX, Math.round((cx * sourceWidth - cropW / 2) / 2) * 2));
  return { cropW, cropH, cropX, cropY };
}

module.exports = {
  detectScenes, detectSilence, energyCurve, motionCentroid,
  analyseVideo, buildClipCandidates, reframeWindow, silentFraction, meanEnergy,
  SCORE_WEIGHTS,
};
