'use strict';
// AI Music Sync Director — real audio analysis (Phase 5).
// Local DSP only: no API key, no provider, no guessing. FFmpeg decodes the
// audio to raw mono PCM; everything below is pure Node math on that PCM.
//
// Pipeline:
//   1. Decode to 22050 Hz mono float32 PCM (FFmpeg, `-t 600` cap).
//   2. Onset envelope = spectral flux from a 1024-point FFT, hop 512.
//   3. BPM = autocorrelation of the onset envelope over 60–200 BPM, with
//      octave (half/double tempo) checks.
//   4. Beat grid = phase search that maximises onset strength at grid
//      points, then each beat is refined to its nearest local onset peak.
//   5. Downbeat = the bar position (in 4-beat bars) with the strongest
//      average onset energy — an estimate, labelled as such.
//   6. Energy curve = per-second RMS; drops = sustained energy jumps.
//   7. Waveform peaks = 200 buckets for display.
//   8. Confidence = 0–1 from autocorrelation strength + beat/onset
//      alignment. Energy/onset detection is weaker on ambient, classical
//      and vocal-only audio — the UI warns when confidence is low and the
//      number is never a claim of "perfect" sync.
//
// Nothing here returns a guessed or default BPM: if the onset envelope is
// too flat to find a tempo, analyseAudioFile throws instead of inventing one.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const SAMPLE_RATE = 22050;
const FFT_SIZE = 1024;
const HOP = 512;
const FRAME_RATE = SAMPLE_RATE / HOP; // ~43.07 frames/second
const MAX_ANALYSE_SECONDS = 600;
const MIN_BPM = 60;
const MAX_BPM = 200;

// --- Small radix-2 FFT (iterative, in place, real input) ---
function fft(re, im) {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

// Spectral-flux onset envelope, one value per hop.
function onsetEnvelope(samples) {
  const window = hannWindow(FFT_SIZE);
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  const env = new Float32Array(frames);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let prevMag = new Float64Array(FFT_SIZE / 2);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) { re[i] = samples[off + i] * window[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const d = mag - prevMag[k];
      if (d > 0) flux += d;
      prevMag[k] = mag;
    }
    env[f] = flux;
  }
  return env;
}

function autocorrelate(x, maxLag) {
  const n = x.length;
  const mean = x.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const r = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += (x[i] - mean) * (x[i + lag] - mean);
    r[lag] = s / Math.max(1, n - lag);
  }
  return r;
}

// Fractional-lag autocorrelation: the true period is rarely an integer
// number of hops (e.g. 120 BPM = 21.53 hops), and integer lags make the
// 0.5 s peak look weaker than the 1.0 s peak of the same click train.
// Interpolating the envelope between frames fixes that.
function autocorrelateFrac(x, minLag, maxLag, step = 0.25) {
  const n = x.length;
  const mean = x.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const out = [];
  for (let lag = minLag; lag <= maxLag + 1e-9; lag += step) {
    const i0 = Math.floor(lag);
    const frac = lag - i0;
    let s = 0;
    const count = n - i0 - 1;
    for (let i = 0; i < count; i++) {
      const shifted = x[i + i0] * (1 - frac) + x[i + i0 + 1] * frac;
      s += (x[i] - mean) * (shifted - mean);
    }
    out.push({ lag, value: s / Math.max(1, count) });
  }
  return out;
}

// Mean onset strength at the best-phase grid for a candidate period.
// The phase search is the same idea as detectBeats, scored per grid point.
function gridMeanOnset(env, periodSeconds, durationSeconds) {
  const periodFrames = periodSeconds * FRAME_RATE;
  let best = 0;
  for (let ph = 0; ph < periodFrames; ph += 1) {
    let score = 0;
    let count = 0;
    for (let t = ph / FRAME_RATE; t < durationSeconds; t += periodSeconds) {
      const f = Math.round(t * FRAME_RATE);
      if (f >= 0 && f < env.length) { score += env[f]; count++; }
    }
    if (count > 0) best = Math.max(best, score / count);
  }
  return best;
}

// Fraction of grid points (at the best phase) that land on a real onset
// (onset strength above 25% of the track maximum). This is the octave
// discriminator: a too-slow grid leaves real onsets between its points
// (low coverage), while the true grid and its double both cover every
// onset — so equal coverage is broken towards the faster tempo.
function gridCoverage(env, periodSeconds, durationSeconds) {
  const max = Math.max(...env, 1e-9);
  const threshold = max * 0.25;
  const periodFrames = periodSeconds * FRAME_RATE;
  let best = 0;
  for (let ph = 0; ph < periodFrames; ph += 1) {
    let hit = 0;
    let count = 0;
    for (let t = ph / FRAME_RATE; t < durationSeconds; t += periodSeconds) {
      const f = Math.round(t * FRAME_RATE);
      if (f >= 0 && f < env.length) { count++; if (env[f] > threshold) hit++; }
    }
    if (count > 0) best = Math.max(best, hit / count);
  }
  return best;
}

// BPM from the onset envelope. Returns { bpm, periodSeconds, strength }
// where strength is the normalised autocorrelation peak (0–1). Throws when
// the envelope is too flat to contain any tempo information.
function detectBpm(env) {
  if (env.length < FRAME_RATE * 2) throw new Error('Audio is too short to detect a tempo (needs at least ~2 seconds).');
  const max = Math.max(...env);
  if (max <= 0) {
    throw new Error('No clear beats found in this audio — the onset envelope is almost flat (common for ambient, drone or very quiet audio). Try a track with a clearer rhythm.');
  }
  // Flatness gate: real onsets are sparse spikes — the 95th percentile of
  // the envelope must tower over its median. A steady drone fails this
  // (its flux is just FFT leakage wobble, p95/median ≈ 1.7), while a click
  // track is in the thousands. Without this gate the leakage wobble gets
  // "detected" as a phantom tempo with a near-zero confidence.
  const sorted = [...env].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  if (p95 <= 0 || (median > 0 && p95 < median * 4)) {
    throw new Error('No clear beats found in this audio — the onset envelope is almost flat (common for ambient, drone or very quiet audio). Try a track with a clearer rhythm.');
  }
  const durationSeconds = env.length / FRAME_RATE;
  // Normalise the envelope so the autocorrelation scale is comparable.
  const norm = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) norm[i] = env[i] / max;
  const minLag = (60 / MAX_BPM) * FRAME_RATE; // 200 BPM
  const maxLag = (60 / MIN_BPM) * FRAME_RATE; // 60 BPM
  const r = autocorrelateFrac(norm, minLag, maxLag);
  const r0 = autocorrelate(norm, 0)[0] || 1;
  let best = r[0];
  for (const p of r) if (p.value > best.value) best = p;
  // Parabolic interpolation for a fractional lag (sub-hop BPM accuracy).
  const idx = r.indexOf(best);
  let frac = best.lag;
  if (idx > 0 && idx < r.length - 1) {
    const a = r[idx - 1].value, b = r[idx].value, c = r[idx + 1].value;
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-12) frac = best.lag + 0.125 * (a - c) / denom;
  }
  const basePeriod = frac / FRAME_RATE;
  // Octave disambiguation: a periodic click train correlates equally at
  // the period and at multiples of it, so the raw peak alone cannot tell
  // 60 BPM from 120 BPM — and the mean onset per grid point cannot
  // either, because MP3 smearing makes alternate onsets weaker. The
  // discriminator is grid COVERAGE: the fraction of grid points that land
  // on a real onset. A too-slow grid strands real onsets between its
  // points (coverage ~0.5); the true grid covers them all. Equal coverage
  // is broken towards the faster tempo. Known limit: music with strong
  // off-beat eighth notes (hi-hats as loud as the kick) can read one
  // octave fast — the UI shows the BPM and the beat grid so the user can
  // see it, and the beat grid itself is still on real onsets.
  const candidates = [basePeriod, basePeriod / 2, basePeriod * 2]
    .filter((p) => p > 0)
    .map((p) => ({ period: p, bpm: 60 / p }))
    .filter((c) => c.bpm >= MIN_BPM - 0.01 && c.bpm <= MAX_BPM + 0.01);
  const scored = candidates.map((c) => ({
    ...c,
    coverage: gridCoverage(norm, c.period, durationSeconds),
    mean: gridMeanOnset(norm, c.period, durationSeconds),
  }));
  const bestCoverage = Math.max(...scored.map((c) => c.coverage));
  const pool = scored.filter((c) => c.coverage >= bestCoverage - 0.05);
  pool.sort((a, b) => b.bpm - a.bpm);
  const chosen = pool[0];
  const bpm = Math.round(chosen.bpm * 100) / 100;
  return { bpm, periodSeconds: chosen.period, strength: Math.max(0, Math.min(1, best.value / r0)) };
}

// Beat grid: search the phase (0..period) that maximises onset strength at
// grid points, then refine each beat to its nearest local onset peak.
function detectBeats(env, periodSeconds, durationSeconds) {
  const periodFrames = periodSeconds * FRAME_RATE;
  let bestPhase = 0;
  let bestScore = -Infinity;
  const step = 1; // one hop ≈ 23 ms
  for (let ph = 0; ph < periodFrames; ph += step) {
    let score = 0;
    let count = 0;
    for (let t = ph / FRAME_RATE; t < durationSeconds; t += periodSeconds) {
      const f = Math.round(t * FRAME_RATE);
      if (f >= 0 && f < env.length) { score += env[f]; count++; }
    }
    if (count > 0) {
      const avg = score / count;
      if (avg > bestScore) { bestScore = avg; bestPhase = ph; }
    }
  }
  const beats = [];
  for (let t = bestPhase / FRAME_RATE; t < durationSeconds; t += periodSeconds) {
    // Refine to the strongest onset within ±60 ms.
    const centre = Math.round(t * FRAME_RATE);
    let bf = centre;
    let bv = -Infinity;
    for (let f = Math.max(0, centre - 3); f <= Math.min(env.length - 1, centre + 3); f++) {
      if (env[f] > bv) { bv = env[f]; bf = f; }
    }
    beats.push(Math.round((bf / FRAME_RATE) * 1000) / 1000);
  }
  // The phase search can put the first beat before the first real onset
  // (a grid point in silence). Drop leading beats with almost no onset.
  const onsetMax = Math.max(...env);
  while (beats.length > 1) {
    const f = Math.round(beats[0] * FRAME_RATE);
    if (f < env.length && env[f] < onsetMax * 0.05) beats.shift();
    else break;
  }
  return beats;
}

// Downbeat estimate: average onset energy at each position inside a 4-beat
// bar; the strongest position is the downbeat offset. Honest estimate only.
function detectDownbeats(beats, env) {
  if (beats.length < 4) return { offset: 0, downbeats: beats.slice() };
  const sums = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  beats.forEach((b, i) => {
    const f = Math.round(b * FRAME_RATE);
    const v = f < env.length ? env[f] : 0;
    sums[i % 4] += v;
    counts[i % 4] += 1;
  });
  let offset = 0;
  let best = -Infinity;
  for (let i = 0; i < 4; i++) {
    const avg = counts[i] ? sums[i] / counts[i] : 0;
    if (avg > best) { best = avg; offset = i; }
  }
  return { offset, downbeats: beats.filter((_, i) => i % 4 === offset) };
}

// Per-second RMS energy, normalised 0–1.
function energyCurve(samples, durationSeconds) {
  const perSec = Math.max(1, Math.floor(durationSeconds));
  const curve = [];
  const perBucket = SAMPLE_RATE;
  for (let s = 0; s < perSec; s++) {
    const start = s * perBucket;
    const end = Math.min(samples.length, start + perBucket);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    curve.push(rms);
  }
  const max = Math.max(...curve, 1e-9);
  return curve.map((v) => Math.round((v / max) * 1000) / 1000);
}

// Drops: a sustained jump to a much louder section (≥2 s of high energy
// after ≥2 s of lower energy). Returns [{ t, before, after }].
function detectDrops(samples, durationSeconds) {
  const bucketSec = 0.25;
  const n = Math.floor(durationSeconds / bucketSec);
  if (n < 16) return [];
  const rms = new Float32Array(n);
  const perBucket = Math.floor(SAMPLE_RATE * bucketSec);
  for (let b = 0; b < n; b++) {
    const start = b * perBucket;
    const end = Math.min(samples.length, start + perBucket);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    rms[b] = Math.sqrt(sum / Math.max(1, end - start));
  }
  const max = Math.max(...rms, 1e-9);
  const norm = Array.from(rms, (v) => v / max);
  const drops = [];
  const beforeWin = 8; // 2 s
  const afterWin = 8; // 2 s
  for (let b = beforeWin; b + afterWin < n; b++) {
    let before = 0, after = 0, sustained = 0;
    for (let i = 0; i < beforeWin; i++) before += norm[b - 1 - i];
    for (let i = 0; i < afterWin; i++) after += norm[b + i];
    for (let i = afterWin; i < Math.min(afterWin + 8, n - b); i++) sustained += norm[b + i];
    before /= beforeWin; after /= afterWin;
    const susCount = Math.min(8, n - b - afterWin);
    sustained = susCount ? sustained / susCount : 0;
    if (before > 0.08 && after > before * 1.6 && after - before > 0.15 && sustained > before * 1.3) {
      const t = Math.round(b * bucketSec * 100) / 100;
      if (!drops.length || t - drops[drops.length - 1].t > 3) {
        drops.push({ t, before: Math.round(before * 100) / 100, after: Math.round(after * 100) / 100 });
      }
    }
  }
  return drops.slice(0, 20);
}

function waveformPeaks(samples, buckets = 200) {
  const peaks = new Float32Array(buckets);
  const perBucket = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    const start = b * perBucket;
    const end = Math.min(samples.length, start + perBucket);
    let m = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(samples[i]);
      if (a > m) m = a;
    }
    peaks[b] = m;
  }
  const max = Math.max(...peaks, 1e-9);
  return Array.from(peaks, (v) => Math.round((v / max) * 1000) / 1000);
}

// Confidence 0–1: how much the detected tempo/beat grid can be trusted.
// 60% beat/onset alignment + 40% autocorrelation peak strength.
function confidenceScore(env, beats, bpmStrength) {
  if (!beats.length) return 0;
  const onsetMax = Math.max(...env, 1e-9);
  let aligned = 0;
  for (const b of beats) {
    const f = Math.round(b * FRAME_RATE);
    if (f < env.length && env[f] > onsetMax * 0.25) aligned++;
  }
  const alignFrac = aligned / beats.length;
  return Math.round((0.6 * alignFrac + 0.4 * Math.min(1, bpmStrength * 3)) * 100) / 100;
}

// Pure analysis from PCM samples (no I/O) — the unit-testable core.
function analyzePcm(samples, sampleRate = SAMPLE_RATE) {
  if (!samples || samples.length < sampleRate * 2) {
    throw new Error('Audio is too short to analyse (needs at least ~2 seconds).');
  }
  const durationSeconds = Math.round((samples.length / sampleRate) * 100) / 100;
  const env = onsetEnvelope(samples);
  const { bpm, periodSeconds, strength } = detectBpm(env);
  const beats = detectBeats(env, periodSeconds, durationSeconds);
  if (beats.length < 2) {
    throw new Error('No clear beats found in this audio — the onset envelope is almost flat (common for ambient, drone or very quiet audio). Try a track with a clearer rhythm.');
  }
  const { offset, downbeats } = detectDownbeats(beats, env);
  const confidence = confidenceScore(env, beats, strength);
  return {
    durationSeconds,
    bpm,
    periodSeconds: Math.round(periodSeconds * 1000) / 1000,
    beats,
    downbeats,
    downbeatOffset: offset,
    energyCurve: energyCurve(samples, durationSeconds),
    drops: detectDrops(samples, durationSeconds),
    waveformPeaks: waveformPeaks(samples, 200),
    confidence,
    lowConfidence: confidence < 0.45,
    method: 'local-dsp',
    sampleRate,
  };
}

// Decode an audio file to mono float32 PCM with FFmpeg.
function decodeAudio(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-i', filePath, '-t', String(MAX_ANALYSE_SECONDS),
      '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(new Error(`Could not start FFmpeg: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Could not decode this audio file with FFmpeg${stderr ? `: ${stderr.slice(-300)}` : ''}`));
      }
      const buf = Buffer.concat(chunks);
      const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
      if (samples.length < SAMPLE_RATE * 2) {
        return reject(new Error('Audio is too short to analyse (needs at least ~2 seconds).'));
      }
      resolve(samples);
    });
  });
}

async function analyzeAudioFile(filePath) {
  const samples = await decodeAudio(filePath);
  const analysis = analyzePcm(samples, SAMPLE_RATE);
  analysis.analyzedSeconds = analysis.durationSeconds;
  if (analysis.durationSeconds >= MAX_ANALYSE_SECONDS) {
    analysis.truncated = true;
    analysis.truncationNote = `Only the first ${MAX_ANALYSE_SECONDS / 60} minutes were analysed.`;
  }
  return analysis;
}

function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

module.exports = {
  SAMPLE_RATE, FRAME_RATE, MAX_ANALYSE_SECONDS, MIN_BPM, MAX_BPM,
  analyzeAudioFile, analyzePcm, decodeAudio, fileHash,
  onsetEnvelope, detectBpm, detectBeats, detectDownbeats, energyCurve,
  detectDrops, waveformPeaks, confidenceScore, autocorrelate,
  autocorrelateFrac, gridMeanOnset,
};
