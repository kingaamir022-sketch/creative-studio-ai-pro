'use strict';
// Magic image tools (v2.2.2, Release A) — the server-side work behind
// POST /api/magic/*.
//
//  * removeBackground / grab — LOCAL, free, no key: the U-2-Net ONNX model
//    in src/segmentation.js (downloaded once into data/models/).
//  * erase / expand (AI mode) — provider-backed: OpenAI Images `images/edits`
//    with a real mask PNG. Needs an image provider key; without one the
//    call refuses with PROVIDER_KEY_NEEDED and creates nothing.
//  * expand (solid / blur modes) — LOCAL FFmpeg effects, honestly labelled:
//    solid colour padding and a blurred-edge extend. No key needed.
//
// Every result is saved as a normal Media Library row (tag magic-*) so the
// editor, bulk backgrounds and renders can use it like any upload.
// Nothing here fakes a result: a failed provider call or a missing model
// throws, and no output file is created.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const providers = require('./providers');
const credits = require('./credits');
const { probeMedia, run } = require('./ffmpeg');
const segmentation = require('./segmentation');
const ai = require('./ai');

function mediaFilePath(userId, media) {
  return path.join(config.uploadsDir, String(userId), media.stored_name);
}

function keyNeededError(providerLabel, extra) {
  const err = new Error(`${providerLabel} is not configured: no API key. Add one in Settings → AI Providers. No output was created.${extra ? ' ' + extra : ''}`);
  err.code = 'PROVIDER_KEY_NEEDED';
  return err;
}

function requireImageMedia(userId, mediaId) {
  const media = db.getMedia(userId, mediaId);
  if (!media) {
    const err = new Error('Image not found in your Media Library.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (media.kind !== 'image') throw new Error('This tool needs an image — pick an image from your Media Library.');
  const filePath = mediaFilePath(userId, media);
  if (!fs.existsSync(filePath)) throw new Error('The image file is missing on disk.');
  return { media, filePath };
}

async function saveResult(userId, { buffer, name, tags, width, height }) {
  const dir = path.join(config.uploadsDir, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
  let storedName = safe;
  let n = 1;
  while (fs.existsSync(path.join(dir, storedName))) {
    storedName = safe.replace(/(\.[^.]+)$/, `-${n}$1`);
    n += 1;
  }
  const filePath = path.join(dir, storedName);
  fs.writeFileSync(filePath, buffer);
  const media = db.createMedia(userId, {
    originalName: safe, storedName, mimeType: 'image/png', kind: 'image',
    sizeBytes: buffer.length, width: width || null, height: height || null, tags,
  });
  return { media, filePath };
}

function tmpDir() {
  const dir = path.join(config.uploadsDir, `.magic-tmp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// --- Background Remover (local model) ----------------------------------------
async function removeBackground(userId, mediaId) {
  const { media, filePath } = requireImageMedia(userId, mediaId);
  const dir = tmpDir();
  try {
    const seg = await segmentation.segmentImageFile(filePath, dir);
    const cutoutPath = path.join(dir, 'cutout.png');
    await segmentation.applyMaskAsAlpha(filePath, seg.maskPath, cutoutPath);
    const cutoutBuf = fs.readFileSync(cutoutPath);
    const maskBuf = fs.readFileSync(seg.maskPath);
    const stamp = Date.now().toString(36);
    const cutout = await saveResult(userId, {
      buffer: cutoutBuf, name: `bg-removed-${media.id}-${stamp}.png`,
      tags: 'magic-bg-removed', width: seg.width, height: seg.height,
    });
    const mask = await saveResult(userId, {
      buffer: maskBuf, name: `bg-mask-${media.id}-${stamp}.png`,
      tags: 'magic-mask', width: seg.width, height: seg.height,
    });
    credits.chargeCredits(userId, 'magic_bg_remove', `Removed background from "${media.original_name}" (local U-2-Net model)`);
    return {
      media: cutout.media, maskMedia: mask.media,
      width: seg.width, height: seg.height,
      foregroundFraction: Math.round(seg.foregroundFraction * 1000) / 1000,
      model: segmentation.MODEL_ID, local: true,
    };
  } finally {
    rmTmp(dir);
  }
}

// --- Magic Grab (local model mask) -------------------------------------------
// The mask is the salient subject (usually one object). A click inside the
// foreground extracts that subject as its own transparent layer; a click
// on the background refuses honestly. If the photo has several separate
// foreground objects they come out together — the mask has no instances.
async function grabObject(userId, { mediaId, maskMediaId, x, y }) {
  const { media, filePath } = requireImageMedia(userId, mediaId);
  const maskRow = db.getMedia(userId, maskMediaId);
  if (!maskRow || maskRow.kind !== 'image') throw new Error('A background-removal mask is required — run Background Remover on this image first, then Grab.');
  const maskPath = mediaFilePath(userId, maskRow);
  if (!fs.existsSync(maskPath)) throw new Error('The mask file is missing on disk. Run Background Remover again.');
  const info = await probeMedia(filePath);
  if (!info || !info.width || !info.height) throw new Error('Could not read the image size.');
  const px = Math.max(0, Math.min(info.width - 1, Math.round(Number(x) || 0)));
  const py = Math.max(0, Math.min(info.height - 1, Math.round(Number(y) || 0)));
  const value = await segmentation.maskValueAt(maskPath, px, py);
  if (value <= 128) {
    const err = new Error(`No object at that point (${px}, ${py}) — the mask says background there. Click on the main subject itself.`);
    err.code = 'NO_OBJECT_AT_POINT';
    throw err;
  }
  const bbox = await segmentation.foregroundBBox(maskPath);
  if (!bbox) {
    const err = new Error('The mask has no foreground to grab.');
    err.code = 'NO_OBJECT_AT_POINT';
    throw err;
  }
  const dir = tmpDir();
  try {
    // Crop both image and mask to the subject box, then apply the cropped
    // mask as alpha — a standalone transparent layer of just the subject.
    const cropImg = path.join(dir, 'crop.png');
    const cropMask = path.join(dir, 'crop-mask.png');
    const outPath = path.join(dir, 'grab.png');
    await run('ffmpeg', ['-y', '-v', 'error', '-i', filePath,
      '-vf', `crop=${bbox.w}:${bbox.h}:${bbox.x}:${bbox.y}`, cropImg], { timeout: 60000 });
    await run('ffmpeg', ['-y', '-v', 'error', '-i', maskPath,
      '-vf', `crop=${bbox.w}:${bbox.h}:${bbox.x}:${bbox.y}`, cropMask], { timeout: 60000 });
    await segmentation.applyMaskAsAlpha(cropImg, cropMask, outPath);
    const buf = fs.readFileSync(outPath);
    const stamp = Date.now().toString(36);
    const saved = await saveResult(userId, {
      buffer: buf, name: `grab-${media.id}-${stamp}.png`,
      tags: 'magic-grab', width: bbox.w, height: bbox.h,
    });
    credits.chargeCredits(userId, 'magic_grab', `Grabbed the subject from "${media.original_name}" (local U-2-Net mask)`);
    return { media: saved.media, bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h }, clicked: { x: px, y: py, maskValue: value } };
  } finally {
    rmTmp(dir);
  }
}

// --- Provider-backed erase / expand ------------------------------------------
// OpenAI Images `images/edits` with a mask: transparent pixels in the mask
// are the area the model may change; opaque pixels are kept. The app never
// sent a mask before v2.2.2 — this is the first mask-aware provider call.
async function callImageEdits({ userId, imageBuf, imageName, maskBuf, prompt, size }) {
  const p = providers.resolveProvider(providers.activeProviderForKind('image'));
  if (!p.configured) {
    throw keyNeededError(p.label, 'Magic Eraser and AI Expand need an image provider key (OpenAI Images). Add one in Settings → AI Providers.');
  }
  if (p.id === 'stability') {
    throw new Error('Magic Eraser and AI Expand need the OpenAI Images provider — Stability has no image-edit endpoint. Switch the active image provider to OpenAI Images in Settings → AI Providers.');
  }
  const model = p.model === 'dall-e-3' ? 'gpt-image-1' : p.model;
  const form = new FormData();
  form.append('image', new Blob([imageBuf], { type: 'image/png' }), imageName);
  if (maskBuf) form.append('mask', new Blob([maskBuf], { type: 'image/png' }), 'mask.png');
  form.append('prompt', prompt);
  form.append('model', model);
  form.append('size', size);
  const res = await providers.fetchWithRetry(`${p.baseUrl}/images/edits`, {
    method: 'POST', headers: { Authorization: `Bearer ${p.key}` }, body: form,
  }, 180000);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw providers.friendlyProviderError(p.label, res.status, detail);
  }
  const json = await res.json();
  const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
  if (!b64) throw new Error('The image provider returned no image data.');
  return { buffer: Buffer.from(b64, 'base64'), provider: `openai-${model}` };
}

function sizeFor(width, height) {
  const r = width / height;
  if (r > 1.25) return '16:9';
  if (r < 0.8) return '9:16';
  return '1:1';
}

function decodeMaskDataUrl(dataUrl) {
  // OpenAI mask format: the region to erase is TRANSPARENT, everything to
  // keep is opaque white. (The Magic Tools mask painter exports exactly
  // this: it paints the erase region as a hole in an opaque white canvas.)
  const m = String(dataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('Mask must be a PNG data URL (data:image/png;base64,...) painted in the Magic Tools mask editor.');
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > 8 * 1024 * 1024) throw new Error('Mask image is empty or too large (max 8 MB).');
  return buf;
}

// Mean alpha (0-255) of a PNG: 255 = fully opaque (nothing to erase).
// C-04: force RGBA first — alphaextract needs an alpha plane, and an
// alpha-less (RGB) mask used to fail with a raw FFmpeg stderr dump. An
// RGB mask is fully opaque, so it now correctly reads 255 and the
// friendly "Nothing to erase" guard fires instead.
async function meanAlpha(maskPath) {
  // C-04: format=rgba first so an alpha-less (RGB) mask reads as fully
  // opaque instead of failing in alphaextract. signalstats on this FFmpeg
  // build prints nothing by itself — its per-frame stats only surface via
  // the metadata filter (lavfi.signalstats.YAVG=<n>). Without metadata=print
  // this always returned null and the "Nothing to erase" guard never fired.
  const { stdout, stderr } = await run('ffmpeg', ['-v', 'info', '-i', maskPath,
    '-vf', 'format=rgba,alphaextract,signalstats,metadata=print', '-f', 'null', '-'], { timeout: 60000 });
  const text = `${stdout || ''}\n${stderr || ''}`;
  const m = text.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/g) || text.match(/YAVG:\s*([0-9.]+)/g);
  if (!m || !m.length) return null;
  const last = m[m.length - 1].match(/([0-9.]+)\s*$/);
  return last ? parseFloat(last[1]) : null;
}

async function eraseImage(userId, { mediaId, maskDataUrl }) {
  const { media, filePath } = requireImageMedia(userId, mediaId);
  const maskBuf = decodeMaskDataUrl(maskDataUrl);
  const info = await probeMedia(filePath);
  if (!info || !info.width || !info.height) throw new Error('Could not read the image size.');
  const dir = tmpDir();
  try {
    // The provider requires the mask at the image's own size.
    const maskPath = path.join(dir, 'mask.png');
    fs.writeFileSync(maskPath, maskBuf);
    const sizedMask = path.join(dir, 'mask-sized.png');
    await run('ffmpeg', ['-y', '-v', 'error', '-i', maskPath,
      '-vf', `scale=${info.width}:${info.height}`, sizedMask], { timeout: 60000 });
    // Refuse an empty mask (nothing painted): the provider would return
    // the image unchanged and still bill the call.
    const alpha = await meanAlpha(sizedMask);
    if (alpha !== null && alpha >= 250) {
      throw new Error('Nothing to erase — paint the region to remove in the mask editor first (the painted area is the hole in the mask).');
    }
    const sizedBuf = fs.readFileSync(sizedMask);
    const imageBuf = fs.readFileSync(filePath);
    const out = await callImageEdits({
      userId, imageBuf, imageName: media.original_name || 'image.png', maskBuf: sizedBuf,
      prompt: 'Remove the object covered by the transparent mask area and fill in the background naturally so it looks like the object was never there. Keep everything outside the mask exactly as it is.',
      size: sizeFor(info.width, info.height),
    });
    const stamp = Date.now().toString(36);
    const saved = await saveResult(userId, {
      buffer: out.buffer, name: `erased-${media.id}-${stamp}.png`,
      tags: 'magic-erase', width: info.width, height: info.height,
    });
    credits.chargeCredits(userId, 'magic_erase', `Erased a masked region from "${media.original_name}" (${out.provider})`);
    return { media: saved.media, provider: out.provider };
  } finally {
    rmTmp(dir);
  }
}

async function expandImage(userId, { mediaId, targetWidth, targetHeight, mode = 'ai', fill = '#000000' }) {
  const { media, filePath } = requireImageMedia(userId, mediaId);
  const tw = parseInt(targetWidth, 10);
  const th = parseInt(targetHeight, 10);
  if (!Number.isFinite(tw) || !Number.isFinite(th) || tw < 10 || tw > 8000 || th < 10 || th > 8000) {
    throw new Error('Target size must be a width and height between 10 and 8000 px.');
  }
  const info = await probeMedia(filePath);
  if (!info || !info.width || !info.height) throw new Error('Could not read the image size.');
  if (tw <= info.width && th <= info.height) {
    throw new Error(`Expand grows the canvas — the target (${tw}×${th}) must be bigger than the image (${info.width}×${info.height}) in at least one dimension.`);
  }
  const dir = tmpDir();
  try {
    const stamp = Date.now().toString(36);
    if (mode === 'solid' || mode === 'blur') {
      // Local FFmpeg extend — honestly labelled, no key needed.
      const outPath = path.join(dir, 'expanded.png');
      if (mode === 'solid') {
        const hex = /^#[0-9a-fA-F]{6}$/.test(String(fill)) ? String(fill) : '#000000';
        await run('ffmpeg', ['-y', '-v', 'error', '-i', filePath,
          '-vf', `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=${hex.replace('#', '0x')}`,
          '-frames:v', '1', outPath], { timeout: 120000 });
      } else {
        // Blurred-edge extend: a blurred, enlarged copy fills the frame
        // behind the original, centred. The blurred background MUST be the
        // overlay's main (first) input — overlay outputs the main input's
        // size, so [0:v] first would shrink the result back to the
        // original size.
        await run('ffmpeg', ['-y', '-v', 'error', '-i', filePath,
          '-filter_complex',
          `[0:v]scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},gblur=sigma=40[bg];[bg][0:v]overlay=(W-w)/2:(H-h)/2`,
          '-frames:v', '1', outPath], { timeout: 120000 });
      }
      const buf = fs.readFileSync(outPath);
      const saved = await saveResult(userId, {
        buffer: buf, name: `expanded-${mode}-${media.id}-${stamp}.png`,
        tags: 'magic-expand', width: tw, height: th,
      });
      credits.chargeCredits(userId, 'magic_expand_local', `Expanded "${media.original_name}" to ${tw}×${th} (${mode === 'solid' ? 'solid colour' : 'blurred edge'} — local, no key)`);
      return { media: saved.media, mode, provider: 'local-ffmpeg', width: tw, height: th };
    }
    if (mode !== 'ai') throw new Error(`Unknown expand mode: ${mode}. Use ai, solid or blur.`);
    // AI outpaint: original centred on a transparent canvas, mask =
    // transparent where the model may paint, opaque over the original.
    const canvasPath = path.join(dir, 'canvas.png');
    const maskPath = path.join(dir, 'mask.png');
    await run('ffmpeg', ['-y', '-v', 'error', '-i', filePath,
      '-vf', `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
      '-frames:v', '1', canvasPath], { timeout: 120000 });
    const ox = Math.round((tw - info.width) / 2);
    const oy = Math.round((th - info.height) / 2);
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black@0:s=${tw}x${th}:d=1`,
      '-vf', `drawbox=x=${ox}:y=${oy}:w=${info.width}:h=${info.height}:color=white:t=fill`,
      '-frames:v', '1', maskPath], { timeout: 60000 });
    const out = await callImageEdits({
      userId, imageBuf: fs.readFileSync(canvasPath), imageName: 'expand-canvas.png',
      maskBuf: fs.readFileSync(maskPath),
      prompt: 'Outpainting: extend this image naturally to fill the whole frame. Keep the original picture in the centre exactly as it is and paint a seamless, matching continuation around it.',
      size: sizeFor(tw, th),
    });
    const saved = await saveResult(userId, {
      buffer: out.buffer, name: `expanded-ai-${media.id}-${stamp}.png`,
      tags: 'magic-expand', width: tw, height: th,
    });
    credits.chargeCredits(userId, 'magic_expand_ai', `Expanded "${media.original_name}" to ${tw}×${th} with AI outpainting (${out.provider})`);
    return { media: saved.media, mode: 'ai', provider: out.provider, width: tw, height: th };
  } finally {
    rmTmp(dir);
  }
}

module.exports = { removeBackground, grabObject, eraseImage, expandImage, keyNeededError };
