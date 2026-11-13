'use strict';
// FFmpeg detection + probing + thumbnails + output validation (Phase 3).
// Rendering itself lives in src/render.js; these helpers are shared by the
// media routes (probe on upload) and the render worker (validate output).
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let cached = null;

function detectFFmpeg() {
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        cached = { available: false, version: null, error: 'ffmpeg binary not found on PATH' };
      } else {
        const first = String(stdout || '').split('\n')[0] || '';
        const m = first.match(/ffmpeg version (\S+)/);
        cached = { available: true, version: m ? m[1] : first, error: null };
      }
      resolve(cached);
    });
  });
}

function run(cmd, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`${cmd} failed: ${String(stderr || err.message).slice(-500)}`);
        e.stderr = stderr || '';
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
  });
}

// Probe a media file with ffprobe. Returns null on failure (never throws for
// a missing/corrupt file — callers treat null as "unknown").
async function probeMedia(filePath) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate',
      '-show_entries', 'format=duration',
      '-of', 'json', filePath,
    ]);
    const data = JSON.parse(stdout);
    const video = (data.streams || []).find((s) => s.codec_type === 'video');
    const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
    const duration = data.format && data.format.duration ? parseFloat(data.format.duration) : null;
    let fps = null;
    if (video) {
      const rate = video.avg_frame_rate || video.r_frame_rate;
      if (rate && rate.includes('/')) {
        const [n, d] = rate.split('/').map(Number);
        if (d) fps = n / d;
      }
    }
    return {
      width: video ? video.width : null,
      height: video ? video.height : null,
      durationSeconds: duration,
      fps: fps && Number.isFinite(fps) ? Math.round(fps * 100) / 100 : null,
      codec: video ? video.codec_name : (audio ? audio.codec_name : null),
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
    };
  } catch {
    return null;
  }
}

// One JPEG thumbnail for a video, taken near the middle (or 1s in).
async function makeThumbnail(filePath, outPath, durationSeconds) {
  const at = durationSeconds && durationSeconds > 2 ? Math.min(2, durationSeconds / 2) : 1;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await run('ffmpeg', [
    '-y', '-v', 'error', '-ss', String(at), '-i', filePath,
    '-frames:v', '1', '-q:v', '4', outPath,
  ], { timeout: 30000 });
  return outPath;
}

// Validate a rendered output against the requested settings. Returns
// { ok, problems[], info } — info is the probed output metadata.
async function validateOutput(filePath, expected) {
  const info = await probeMedia(filePath);
  const problems = [];
  if (!info) return { ok: false, problems: ['ffprobe could not read the rendered file.'], info: null };
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    problems.push('Rendered file is missing or empty.');
  }
  if (expected.width && info.width !== expected.width) problems.push(`Width is ${info.width}, expected ${expected.width}.`);
  if (expected.height && info.height !== expected.height) problems.push(`Height is ${info.height}, expected ${expected.height}.`);
  if (expected.duration !== undefined && info.durationSeconds !== null) {
    if (Math.abs(info.durationSeconds - expected.duration) > 0.75) {
      problems.push(`Duration is ${info.durationSeconds.toFixed(2)}s, expected ${expected.duration.toFixed(2)}s.`);
    }
  }
  if (expected.fps && info.fps && Math.abs(info.fps - expected.fps) > 1.5) {
    problems.push(`Frame rate is ${info.fps}, expected ${expected.fps}.`);
  }
  if (info.codec && info.codec !== 'h264') problems.push(`Video codec is ${info.codec}, expected h264.`);
  return { ok: problems.length === 0, problems, info };
}

function parseFFmpegTime(str) {
  // "HH:MM:SS.xx" -> seconds
  const m = String(str || '').match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

module.exports = { detectFFmpeg, probeMedia, makeThumbnail, validateOutput, parseFFmpegTime, run, spawn };
