'use strict';
// Shorts rendering (Phase 6) — real FFmpeg renders, no simulation.
// One clip = trim the source segment, crop to 9:16 around the motion
// centroid (the "smart crop" — no face tracking without a vision model,
// and the UI says so), scale to 1080x1920 (or 720x1280), burn captions in
// with the libass `subtitles` filter (proper Arabic/Urdu/Devanagari
// shaping), keep the source audio. Renders run through the Phase 3 job
// queue: processShortsJob is called from render.js's processJob when the
// payload has `shorts`, exactly like the bulk-design hook.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');
const config = require('./config');
const { probeMedia, validateOutput, parseFFmpegTime } = require('./ffmpeg');
const { reframeWindow } = require('./shorts-analysis');
const { buildAss, cuesForClip } = require('./captions');

function fmt(n) {
  return String(Math.round(n * 1000) / 1000);
}
function escFilterPath(p) {
  // subtitles filter: escape backslash, single-quote and colon.
  return String(p).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

// Build the ffmpeg args for one Short. Returns { args, expected, assPath }.
// tmpDir is created by the caller (the queue worker's per-job tmp dir).
async function buildShortRenderPlan({ mediaFile, probe, clip, transcript, language, resolution, tmpDir }) {
  const outW = resolution === '720p' ? 720 : 1080;
  const outH = resolution === '720p' ? 1280 : 1920;
  const fps = probe.fps && probe.fps > 0 ? Math.round(probe.fps) : 30;
  const start = clip.start_s;
  const dur = Math.max(0.5, clip.end_s - clip.start_s);
  const win = reframeWindow(probe.width, probe.height, clip.motion_x ?? 0.5, outW, outH);
  const vf = [
    `crop=${win.cropW}:${win.cropH}:${win.cropX}:${win.cropY}`,
    // Plain scale (no aspect preservation): the crop is already ~9:16
    // (within the even-number rounding), and a plain scale guarantees
    // the exact output dims. force_original_aspect_ratio=increase would
    // overshoot (e.g. 1088x1920) because the rounded crop is a hair wider
    // than 9:16 — found by the e2e test.
    `scale=${outW}:${outH}`,
    `setsar=1`,
    `fps=${fps}`,
    'format=yuv420p',
  ];
  let assPath = null;
  const cues = transcript && transcript.cues ? cuesForClip(transcript.cues, start, clip.end_s) : [];
  if (cues.length) {
    const lang = (transcript && transcript.language) || language || 'en';
    const ass = buildAss(cues, { language: lang, outWidth: outW, outHeight: outH, timeOffset: 0 });
    assPath = path.join(tmpDir, 'captions.ass');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(assPath, ass);
    vf.push(`subtitles=filename='${escFilterPath(assPath)}'`);
  }
  const args = ['-y', '-v', 'info', '-ss', fmt(start), '-i', mediaFile, '-t', fmt(dur),
    '-filter_complex', `[0:v]${vf.join(',')}[vout]`,
    '-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-r', String(fps)];
  if (probe.hasAudio) args.push('-map', '0:a', '-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart');
  return {
    args,
    expected: { width: outW, height: outH, fps, duration: dur, hasAudio: Boolean(probe.hasAudio) },
    assPath, cuesUsed: cues.length, window: win,
  };
}

// Queue-worker entry point (called from render.js processJob).
async function processShortsJob(job, payload, { dir, logPath }) {
  const shorts = payload.shorts || {};
  const userId = job.user_id;
  const clip = db.getShortsClipAny(shorts.clipId);
  if (!clip) throw new Error(`Shorts clip #${shorts.clipId} is missing.`);
  const sjob = db.getShortsJobAny(shorts.shortsJobId);
  if (!sjob) throw new Error(`Shorts job #${shorts.shortsJobId} is missing.`);
  const media = db.getMedia(userId, sjob.media_id);
  if (!media) throw new Error('Source video is missing (it may have been deleted).');
  const mediaFile = path.join(config.uploadsDir, String(userId), media.stored_name);
  if (!fs.existsSync(mediaFile)) throw new Error(`Source video "${media.original_name}" is missing on disk.`);
  const probe = await probeMedia(mediaFile);
  if (!probe || !probe.hasVideo) throw new Error('Source file has no video stream.');
  const tmpDir = path.join(dir, `tmp-${job.id}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(dir, `${job.id}.mp4`);
  let transcript = null;
  try { transcript = JSON.parse(sjob.transcript || 'null'); } catch { transcript = null; }
  const plan = await buildShortRenderPlan({
    mediaFile, probe,
    clip: { start_s: clip.start_s, end_s: clip.end_s, motion_x: clip.motion_x },
    transcript, language: sjob.language || 'en',
    resolution: shorts.resolution || '720p', tmpDir,
  });
  fs.writeFileSync(logPath, `Shorts render job ${job.id} started ${new Date().toISOString()}\n`);
  fs.appendFileSync(logPath, `Clip ${clip.start_s}s–${clip.end_s}s, crop ${plan.window.cropW}x${plan.window.cropH}+${plan.window.cropX}+${plan.window.cropY}, captions: ${plan.cuesUsed} cues${plan.assPath ? '' : ' (none)'}\n`);
  db.updateJob(job.id, { output_path: outPath, log_path: logPath });
  const total = plan.expected.duration;
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [...plan.args, outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (buf) => {
      const text = buf.toString();
      try { fs.appendFileSync(logPath, text); } catch { /* ignore */ }
      tail = (tail + text).slice(-4000);
      const m = text.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/g);
      if (m && total > 0) {
        const t = parseFFmpegTime(m[m.length - 1].replace('time=', ''));
        if (t !== null) db.updateJob(job.id, { progress: Math.max(0, Math.min(99, Math.round((t / total) * 100))) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => reject(new Error(`Could not start FFmpeg: ${err.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) return resolve('done');
      const lastLines = tail.split('\n').filter(Boolean).slice(-8).join(' ');
      reject(new Error(`FFmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ''}. ${lastLines.slice(0, 1000)}`));
    });
  });
  const check = await validateOutput(outPath, plan.expected);
  if (!check.ok) throw new Error(`Render validation failed: ${check.problems.join(' ')}`);
  db.updateJob(job.id, { status: 'done', progress: 100 });
  db.audit(userId, 'render_done', 'job', job.id,
    `Rendered Short ${plan.expected.width}x${plan.expected.height} @ ${plan.expected.fps}fps, ${plan.expected.duration.toFixed(1)}s (${plan.cuesUsed} caption cues)`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return { outPath, cuesUsed: plan.cuesUsed, window: plan.window };
}

// Queue hook — mirrors the bulk hook in render.js. Marks the clip done /
// failed when its render job finishes, so the gallery stays truthful.
function onShortsJobFinished(job, status, extra = {}) {
  let payload = {};
  try { payload = JSON.parse(job.payload || '{}'); } catch { payload = {}; }
  const shorts = payload.shorts;
  if (!shorts || !shorts.clipId) return;
  const clip = db.getShortsClipAny(shorts.clipId);
  if (!clip) return;
  if (status === 'done') {
    db.updateShortsClip(clip.id, {
      status: 'done',
      output_job_id: job.id,
      output_path: extra.outputPath || job.output_path || null,
    });
  } else if (status === 'failed') {
    db.updateShortsClip(clip.id, { status: 'failed', error: (extra.error || job.error || 'Render failed.').slice(0, 1000) });
  } else if (status === 'cancelled') {
    db.updateShortsClip(clip.id, { status: 'approved', error: 'Render cancelled.' });
  }
}

// One JPEG thumbnail for a clip, taken at its midpoint.
async function makeClipThumbnail(mediaFile, clip, outPath) {
  const mid = Math.max(0, (clip.start_s + clip.end_s) / 2);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-v', 'error', '-ss', String(mid), '-i', mediaFile, '-frames:v', '1', '-q:v', '4', outPath]);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Thumbnail failed (code ${code}).`))));
  });
  return outPath;
}

// ZIP of every finished clip in a job (archiver, same pattern as bulk).
async function buildShortsZip(userId, shortsJob) {
  const archiver = require('archiver');
  const clips = db.listShortsClips(shortsJob.id)
    .filter((c) => c.status === 'done' && c.output_path && fs.existsSync(c.output_path));
  if (!clips.length) throw new Error('No finished Shorts to zip yet.');
  const dir = path.join(config.rendersDir, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, `shorts-${shortsJob.id}.zip`);
  const out = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 6 } });
  await new Promise((resolve, reject) => {
    out.on('close', resolve);
    out.on('error', reject);
    archive.on('error', reject);
    archive.pipe(out);
    const seen = new Set();
    clips.forEach((c, i) => {
      let name = `short-${String(i + 1).padStart(2, '0')}-${Math.round(c.start_s)}s-${Math.round(c.end_s)}s.mp4`;
      if (seen.has(name)) name = `short-${String(i + 1).padStart(2, '0')}-${c.id}.mp4`;
      seen.add(name);
      archive.file(c.output_path, { name });
    });
    archive.finalize();
  });
  return zipPath;
}

module.exports = { buildShortRenderPlan, processShortsJob, onShortsJobFinished, makeClipThumbnail, buildShortsZip };
