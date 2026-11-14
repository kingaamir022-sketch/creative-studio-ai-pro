'use strict';
// Local background-removal segmentation — U-2-Net ONNX, free, no key.
//
// Model: U-2-Net (rembg ONNX export, Apache 2.0 — same licence as the
// original model), repo BritishWerewolf/U-2-Net, file onnx/model.onnx,
// 175,997,641 bytes, SHA-256 verified on download (measured 2026-11-13).
// Runtime: onnxruntime-web (pure JS/WASM — NO native module, so the same
// code runs on the Linux dev box and the Windows portable).
//
// The model file is NEVER committed to the repo and NEVER bundled into an
// update package. It downloads on first use into data/models/ (cached
// forever after), with progress exposed via modelStatus(). Offline, the
// download fails honestly (MODEL_DOWNLOAD_FAILED) and no fake result is
// ever produced.
//
// Verified end-to-end 2026-11-13 (scratch run, not a test): session loads,
// a 640x480 image with two coloured rectangles segments to a 27.3%
// foreground mask (rectangles are 26.6% of the frame), cutout PNG is
// ffprobe-valid with an alpha channel.
//
// Test hook: CS_SEGMENTATION_MOCK=1 makes segmentImageFile return a
// deterministic synthetic mask (centred rectangle) without downloading or
// loading any model. Server-side env only — a user can never trigger it
// from the UI. Tests spawn the server with this env.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('./config');

const MODEL_ID = 'BritishWerewolf/U-2-Net';
const MODEL_FILE = 'u2net.onnx';
const MODEL_URL = 'https://huggingface.co/BritishWerewolf/U-2-Net/resolve/main/onnx/model.onnx';
const MODEL_BYTES = 175997641;
const MODEL_SHA256 = '8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491';
const MODEL_INPUT_SIZE = 320;
const MODEL_LICENSE = 'Apache 2.0 (U-2-Net)';

function modelsDir() {
  return process.env.MODELS_DIR || path.join(config.root, 'data', 'models');
}
function modelPath() {
  return path.join(modelsDir(), MODEL_FILE);
}
function isMock() {
  return process.env.CS_SEGMENTATION_MOCK === '1';
}

// --- Download state (module-level; the server is one process) -------------
const state = {
  status: 'unknown', // unknown | not-downloaded | downloading | ready | error
  downloadedBytes: 0,
  totalBytes: MODEL_BYTES,
  error: null,
  mock: false,
};
let downloadPromise = null;
let sessionPromise = null;

function refreshState() {
  if (isMock()) {
    state.status = 'ready';
    state.mock = true;
    state.downloadedBytes = MODEL_BYTES;
    state.error = null;
    return state;
  }
  state.mock = false;
  if (downloadPromise) {
    state.status = 'downloading';
    return state;
  }
  try {
    if (fs.existsSync(modelPath()) && fs.statSync(modelPath()).size === MODEL_BYTES) {
      state.status = 'ready';
      state.downloadedBytes = MODEL_BYTES;
      state.error = null;
    } else {
      state.status = 'not-downloaded';
      state.downloadedBytes = 0;
      state.error = null;
    }
  } catch {
    state.status = 'not-downloaded';
    state.downloadedBytes = 0;
  }
  return state;
}

function modelStatus() {
  refreshState();
  return {
    model: MODEL_ID,
    file: MODEL_FILE,
    bytes: MODEL_BYTES,
    sizeMB: Math.round((MODEL_BYTES / 1024 / 1024) * 10) / 10,
    license: MODEL_LICENSE,
    url: MODEL_URL,
    path: modelPath(),
    mock: state.mock,
    ...state,
  };
}

function downloadError(message) {
  const err = new Error(message);
  err.code = 'MODEL_DOWNLOAD_FAILED';
  return err;
}

async function ensureModel(onProgress) {
  if (isMock()) return modelPath();
  refreshState();
  if (state.status === 'ready') return modelPath();
  if (downloadPromise) return downloadPromise;
  downloadPromise = (async () => {
    state.status = 'downloading';
    state.downloadedBytes = 0;
    state.error = null;
    const dir = modelsDir();
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, `${MODEL_FILE}.part`);
    try {
      const res = await fetch(MODEL_URL, { redirect: 'follow' });
      if (!res.ok || !res.body) {
        throw downloadError(`Could not download the background-removal model (${res.status}). Check your internet connection and try again — nothing was changed.`);
      }
      const total = parseInt(res.headers.get('content-length') || String(MODEL_BYTES), 10) || MODEL_BYTES;
      state.totalBytes = total;
      const out = fs.createWriteStream(tmpPath);
      const reader = res.body.getReader();
      const hash = crypto.createHash('sha256');
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        hash.update(value);
        state.downloadedBytes = received;
        if (onProgress) onProgress(received, total);
        await new Promise((resolve, reject) => out.write(Buffer.from(value), (e) => (e ? reject(e) : resolve())));
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      if (received !== MODEL_BYTES) {
        throw downloadError(`The background-removal model download was incomplete (${received} of ${MODEL_BYTES} bytes). Check your internet connection and try again.`);
      }
      const digest = hash.digest('hex');
      if (digest !== MODEL_SHA256) {
        throw downloadError('The downloaded background-removal model failed its integrity check (SHA-256 mismatch). The file was discarded — try again.');
      }
      fs.renameSync(tmpPath, modelPath());
      // C-03: clear the in-flight promise on success too (it was only
      // cleared on error), so modelStatus() reports 'ready' afterwards
      // instead of 'downloading' forever.
      downloadPromise = null;
      state.status = 'ready';
      state.downloadedBytes = MODEL_BYTES;
      state.error = null;
      return modelPath();
    } catch (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      state.status = 'error';
      state.error = err.code === 'MODEL_DOWNLOAD_FAILED'
        ? err.message
        : `Could not download the background-removal model: ${err.message || err}. Check your internet connection and try again — nothing was changed.`;
      downloadPromise = null;
      const wrap = err.code === 'MODEL_DOWNLOAD_FAILED' ? err : downloadError(state.error);
      throw wrap;
    }
  })();
  return downloadPromise;
}

// --- FFmpeg raw helpers ------------------------------------------------------
// execFile's maxBuffer + string encoding corrupt binary data, so raw video
// goes through spawn with explicit Buffer collection (same pattern as
// src/design-render.js).
function ffmpegRawIn(args, inputBuffer, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let errText = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } reject(new Error('FFmpeg timed out.')); }, timeout);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`Could not start FFmpeg: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`FFmpeg failed (code ${code}): ${errText.slice(-500)}`));
    });
    if (inputBuffer) {
      child.stdin.on('error', () => {});
      child.stdin.end(inputBuffer);
    } else child.stdin.end();
  });
}
function ffmpegFile(args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } reject(new Error('FFmpeg timed out.')); }, timeout);
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`Could not start FFmpeg: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (code ${code}): ${errText.slice(-500)}`));
    });
  });
}

async function probeImageSize(filePath) {
  const { probeMedia } = require('./ffmpeg');
  const info = await probeMedia(filePath);
  if (!info || !info.width || !info.height) throw new Error('Could not read the image size.');
  return { width: info.width, height: info.height };
}

// --- ONNX session ------------------------------------------------------------
function loadOrt() {
  let ort;
  try {
    ort = require('onnxruntime-web');
  } catch (e) {
    const err = new Error('Background Remover needs a fresh install (v2.2.2 or newer): the local AI runtime is missing. Download the new Setup.exe — in-place updates cannot add it.');
    err.code = 'RUNTIME_MISSING';
    throw err;
  }
  return ort;
}

async function getSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const model = await ensureModel();
    const ort = loadOrt();
    try { ort.env.wasm.numThreads = 1; } catch { /* keep default */ }
    return ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  })();
  sessionPromise.catch(() => { sessionPromise = null; });
  return sessionPromise;
}

function sigmoidNormalize(values) {
  // rembg convention: sigmoid, then stretch min..max to 0..255. Works
  // whether the model outputs logits or probabilities.
  const sig = new Float32Array(values.length);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < values.length; i++) {
    sig[i] = 1 / (1 + Math.exp(-values[i]));
    if (sig[i] < mn) mn = sig[i];
    if (sig[i] > mx) mx = sig[i];
  }
  const range = Math.max(1e-6, mx - mn);
  const gray = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i++) gray[i] = Math.round(255 * (sig[i] - mn) / range);
  return gray;
}

// --- Mock mask (test hook only) ----------------------------------------------
async function mockMaskFor(imagePath, width, height, tmpDir) {
  // Deterministic centred rectangle: foreground = middle 50% of the frame.
  const small = path.join(tmpDir, 'mock-mask-320.png');
  await ffmpegFile(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x320:d=1',
    '-vf', 'drawbox=x=80:y=80:w=160:h=160:color=white:t=fill', '-frames:v', '1', small]);
  const maskPath = path.join(tmpDir, 'mask.png');
  await ffmpegFile(['-y', '-v', 'error', '-i', small, '-vf', `scale=${width}:${height}`, maskPath]);
  return { maskPath, width, height, foregroundFraction: 0.25 };
}

// Segment an image file. Returns { maskPath, width, height,
// foregroundFraction }. maskPath is a PNG (white = foreground) at the
// image's own size, inside tmpDir (caller-owned — the caller moves or
// deletes it).
async function segmentImageFile(imagePath, tmpDir) {
  const { width, height } = await probeImageSize(imagePath);
  fs.mkdirSync(tmpDir, { recursive: true });
  if (isMock()) return mockMaskFor(imagePath, width, height, tmpDir);

  // 1. Decode + resize to the model's 320x320 RGB input.
  const raw = await ffmpegRawIn(['-y', '-v', 'error', '-i', imagePath,
    '-vf', `scale=${MODEL_INPUT_SIZE}:${MODEL_INPUT_SIZE}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], null);
  const N = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  if (raw.length < N * 3) throw new Error('Could not decode the image for segmentation.');
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const data = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 3; c++) data[c * N + i] = (raw[i * 3 + c] / 255 - mean[c]) / std[c];
  }

  // 2. Run the model (first output is the main mask).
  const session = await getSession();
  const ort = loadOrt();
  const tensor = new ort.Tensor('float32', data, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
  const out = await session.run({ [session.inputNames[0]]: tensor });
  const mask = out[session.outputNames[0]];
  if (!mask || !mask.data || mask.data.length !== N) {
    throw new Error('The segmentation model returned an unexpected result.');
  }
  const gray = sigmoidNormalize(mask.data);

  // 3. Mask back to the image's own size (via a raw grey file — stdin
  // pipes are unreliable for binary input through the file helper).
  const rawPath = path.join(tmpDir, 'mask320.raw');
  fs.writeFileSync(rawPath, gray);
  const maskPath = path.join(tmpDir, 'mask.png');
  await ffmpegFile(['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray',
    '-s', `${MODEL_INPUT_SIZE}x${MODEL_INPUT_SIZE}`, '-i', rawPath,
    '-vf', `scale=${width}:${height}`, maskPath]);
  if (!fs.existsSync(maskPath) || fs.statSync(maskPath).size === 0) {
    throw new Error('Could not build the segmentation mask.');
  }
  let fg = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] > 128) fg++;
  return { maskPath, width, height, foregroundFraction: fg / gray.length };
}

// Apply a mask PNG as the alpha channel of an image → transparent PNG.
async function applyMaskAsAlpha(imagePath, maskPath, outPath) {
  await ffmpegFile(['-y', '-v', 'error', '-i', imagePath, '-i', maskPath,
    '-filter_complex', '[0:v][1:v]alphamerge', '-frames:v', '1', outPath]);
  return outPath;
}

// Greyscale value (0-255) of a mask PNG at one pixel.
async function maskValueAt(maskPath, x, y) {
  const buf = await ffmpegRawIn(['-y', '-v', 'error', '-i', maskPath,
    '-vf', `crop=1:1:${Math.max(0, Math.round(x))}:${Math.max(0, Math.round(y))}`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], null);
  if (!buf.length) throw new Error('Could not read the mask at that point.');
  return buf[0];
}

// Bounding box of the foreground (pixels > 128) in a mask PNG.
// Returns null when the mask has no foreground at all.
async function foregroundBBox(maskPath) {
  const { width, height } = await probeImageSize(maskPath);
  const buf = await ffmpegRawIn(['-y', '-v', 'error', '-i', maskPath,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], null);
  if (buf.length < width * height) throw new Error('Could not read the mask.');
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      if (buf[yy * width + xx] > 128) {
        if (xx < minX) minX = xx;
        if (xx > maxX) maxX = xx;
        if (yy < minY) minY = yy;
        if (yy > maxY) maxY = yy;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, width, height };
}

module.exports = {
  MODEL_ID, MODEL_FILE, MODEL_URL, MODEL_BYTES, MODEL_SHA256, MODEL_LICENSE,
  modelsDir, modelPath, modelStatus, ensureModel, getSession,
  segmentImageFile, applyMaskAsAlpha, maskValueAt, foregroundBBox,
  isMock, _state: state,
};
