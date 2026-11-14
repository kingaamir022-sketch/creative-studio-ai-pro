'use strict';
// FFmpeg render engine (Phase 3) — real video rendering, no simulation.
// Builds a filter graph from a validated timeline, runs FFmpeg as a
// background child process, reports real progress (parsed from FFmpeg's
// time= output), validates the result with ffprobe, and cleans up.
//
// Verified filter techniques (tested against FFmpeg 8.1.2 before writing):
// - crop x/y expressions accept 't' (smooth pan); crop w/h do NOT — scale
//   keyframes are therefore sampled into <=0.2s sub-segments with a constant
//   crop window each (visually smooth, joins are seamless).
// - geq alpha accepts 'T' (smooth opacity keyframes); colorchannelmixer aa
//   does NOT accept time — it is used only for constant clip opacity.
// - xfade / acrossfade chain consecutive clips; drawtext alpha + x accept
//   't' (fade/slide text animation); drawtext textfile avoids escaping.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');
const config = require('./config');
const credits = require('./credits');
const { probeMedia, validateOutput, parseFFmpegTime } = require('./ffmpeg');
const vm = require('./video-model');

const RENDERS_DIR = config.rendersDir;
const CONCURRENCY = Math.max(1, parseInt(process.env.RENDER_CONCURRENCY || '1', 10));
const FONT_DIR = '/usr/share/fonts/truetype/dejavu';
const FONTS = {
  sans: path.join(FONT_DIR, 'DejaVuSans.ttf'),
  sansBold: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
  serif: path.join(FONT_DIR, 'DejaVuSerif.ttf'),
  serifBold: path.join(FONT_DIR, 'DejaVuSerif-Bold.ttf'),
};

function fontFor(family, weight) {
  const bold = (weight || 400) >= 700;
  const fam = String(family || '');
  // Per-script fonts resolve to real files when installed (Arabic quiz text
  // uses Noto Kufi/Sans Arabic — DejaVu has no Arabic glyphs). Falls back
  // to DejaVu when the file is missing; never throws for an unknown family.
  const NOTO_DIR = '/usr/share/fonts/truetype/noto';
  if (/kufi/i.test(fam)) {
    const f = path.join(NOTO_DIR, bold ? 'NotoKufiArabic-Bold.ttf' : 'NotoKufiArabic-Regular.ttf');
    if (fs.existsSync(f)) return f;
  }
  if (/arabic/i.test(fam)) {
    const f = path.join(NOTO_DIR, bold ? 'NotoSansArabic-Bold.ttf' : 'NotoSansArabic-Regular.ttf');
    if (fs.existsSync(f)) return f;
  }
  const serif = /playfair|georgia|times|serif/i.test(fam);
  const pick = serif ? (bold ? FONTS.serifBold : FONTS.serif) : (bold ? FONTS.sansBold : FONTS.sans);
  return fs.existsSync(pick) ? pick : null;
}

function escColor(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  return `0x${h.length === 6 ? h : 'ffffff'}`;
}
function num(v, d = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}
function fmt(n) {
  // Short, FFmpeg-safe number formatting (no exponential notation).
  return String(Math.round(n * 1000) / 1000);
}

// atempo only accepts 0.5..100 — decompose slower speeds into chained factors.
function atempoChain(speed) {
  const factors = [];
  let s = speed;
  while (s < 0.5) { factors.push(0.5); s *= 2; }
  factors.push(Math.round(s * 1000) / 1000);
  return factors.map((f) => `atempo=${fmt(f)}`).join(',');
}

function clipFilters(clip, W, H, dur) {
  // Static per-clip filters applied after scaling to output size.
  const f = clip.filters || {};
  const parts = [];
  if (clip.rotation === 90) parts.push('transpose=1');
  else if (clip.rotation === 180) parts.push('transpose=2,transpose=2');
  else if (clip.rotation === 270) parts.push('transpose=2');
  if (clip.flip === 'h') parts.push('hflip');
  else if (clip.flip === 'v') parts.push('vflip');
  const b = num(f.brightness), c = num(f.contrast), s = num(f.saturation);
  if (b !== 0 || c !== 0 || s !== 0) {
    parts.push(`eq=brightness=${fmt(b)}:contrast=${fmt(1 + c)}:saturation=${fmt(1 + s)}`);
  }
  const t = num(f.temperature);
  if (t !== 0) parts.push(`colorbalance=rs=${fmt(t * 0.25)}:bs=${fmt(-t * 0.2)}`);
  const sh = num(f.sharpness);
  if (sh > 0) parts.push(`unsharp=5:5:${fmt(sh)}`);
  const bl = num(f.blur);
  if (bl > 0) parts.push(`gblur=sigma=${fmt(Math.min(bl, 5))}`);
  if (num(f.vignette) > 0) parts.push('vignette=angle=3.14159/5');
  if (num(clip.opacity) < 1) parts.push(`format=rgba,colorchannelmixer=aa=${fmt(clip.opacity)},format=yuv420p`);
  if (num(clip.fadeIn) > 0) parts.push(`fade=t=in:st=0:d=${fmt(clip.fadeIn)}`);
  if (num(clip.fadeOut) > 0) parts.push(`fade=t=out:st=${fmt(Math.max(0, dur - clip.fadeOut))}:d=${fmt(clip.fadeOut)}`);
  return parts.join(',');
}

// Scale a clip's source frame to the output frame.
function scaleChain(clip, W, H) {
  if (clip.scaleMode === 'fill') {
    return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  }
  return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}

// Zoom (static): crop a centred window then scale back up.
function zoomChain(clip, W, H) {
  const z = num(clip.zoom, 1);
  if (z <= 1.001) return '';
  return `crop=w='iw/${fmt(z)}':h='ih/${fmt(z)}':x='(iw-ow)/2':y='(ih-oh)/2',scale=${W}:${H},setsar=1`;
}

// Build one video clip's segment chain (no keyframes). Returns filter text
// producing [label].
function plainClipChain(inputIdx, clip, W, H, fps, label) {
  const srcDur = clip.duration * clip.speed;
  const parts = [
    `[${inputIdx}:v]trim=start=${fmt(clip.srcStart)}:end=${fmt(clip.srcStart + srcDur)}`,
    `setpts=(PTS-STARTPTS)/${fmt(clip.speed)}`,
    scaleChain(clip, W, H),
  ];
  const zoom = zoomChain(clip, W, H);
  if (zoom) parts.push(zoom);
  const extra = clipFilters(clip, W, H, clip.duration);
  if (extra) parts.push(extra);
  parts.push(`fps=${fps},format=yuv420p`);
  return `${parts.join(',')}[${label}]`;
}

// Keyframed clip: sample scale/position/opacity into <=0.2s sub-segments.
// Each sub-segment has a constant crop window (sampled scale) and smooth
// position/opacity expressions inside the segment. Sub-segments are then
// concatenated; static filters are applied once afterwards.
function keyframedClipChain(inputIdx, clip, W, H, fps, label) {
  const kfs = [...(clip.keyframes || [])].sort((a, b) => a.t - b.t);
  const bounds = [0, ...kfs.map((k) => k.t), clip.duration]
    .filter((v, i, a) => v >= 0 && v <= clip.duration && a.indexOf(v) === i)
    .sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    let a = bounds[i];
    const b = bounds[i + 1];
    while (b - a > 0.2001) {
      segs.push([a, a + 0.2]);
      a += 0.2;
    }
    if (b - a > 0.001) segs.push([a, b]);
  }
  const hasOpacityKf = kfs.some((k) => k.opacity !== undefined);
  const labels = [];
  const chains = [];
  segs.forEach(([a, b], i) => {
    const mid = (a + b) / 2;
    const s = vm.keyframeAt(clip, mid).scale;
    const p0 = vm.keyframeAt(clip, a);
    const p1 = vm.keyframeAt(clip, b);
    const segDur = b - a;
    const sl = `${label}_s${i}`;
    labels.push(sl);
    const xExpr = `(iw-ow)*(${fmt(p0.x / 100)}+(${fmt(p1.x / 100)}-${fmt(p0.x / 100)})*t/${fmt(segDur)})`;
    const yExpr = `(ih-oh)*(${fmt(p0.y / 100)}+(${fmt(p1.y / 100)}-${fmt(p0.y / 100)})*t/${fmt(segDur)})`;
    let chain = `[${inputIdx}:v]trim=start=${fmt(clip.srcStart + a * clip.speed)}:end=${fmt(clip.srcStart + b * clip.speed)},` +
      `setpts=(PTS-STARTPTS)/${fmt(clip.speed)},` +
      `crop=w='iw/${fmt(s)}':h='ih/${fmt(s)}':x='${xExpr}':y='${yExpr}',` +
      `scale=${W}:${H},setsar=1`;
    if (hasOpacityKf) {
      const o0 = p0.opacity, o1 = p1.opacity;
      chain += `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*(${fmt(o0)}+(${fmt(o1)}-${fmt(o0)})*T/${fmt(segDur)})',format=yuv420p`;
    }
    chain += `,fps=${fps}[${sl}]`;
    chains.push(chain);
  });
  let out = chains.join(';');
  if (labels.length > 1) {
    out += `;${labels.map((l) => `[${l}]`).join('')}concat=n=${labels.length}:v=1:a=0[${label}_cat]`;
  } else {
    out += `;[${labels[0]}]null[${label}_cat]`;
  }
  const extra = clipFilters(clip, W, H, clip.duration);
  const tail = [scaleChain(clip, W, H)];
  // NOTE: keyframed chain already scaled to WxH per segment; the scaleChain
  // here is a no-op safeguard only if the clip used fit/fill padding — it
  // is applied to an already-WxH frame, so it is a harmless identity.
  if (extra) tail.push(extra);
  tail.push(`fps=${fps},format=yuv420p`);
  out += `;[${label}_cat]${tail.join(',')}[${label}]`;
  return out;
}

function clipChain(inputIdx, clip, W, H, fps, label) {
  if (clip.keyframes && clip.keyframes.length) return keyframedClipChain(inputIdx, clip, W, H, fps, label);
  return plainClipChain(inputIdx, clip, W, H, fps, label);
}

function audioChain(inputIdx, clip, hasAudio, startOverride) {
  if (!hasAudio) return null;
  const srcDur = clip.duration * clip.speed;
  const start = startOverride !== undefined ? startOverride : clip.start;
  const parts = [
    `[${inputIdx}:a]atrim=start=${fmt(clip.srcStart)}:end=${fmt(clip.srcStart + srcDur)}`,
    'asetpts=PTS-STARTPTS',
    atempoChain(clip.speed),
    `volume=${fmt(clip.volume)}`,
  ];
  if (num(clip.fadeIn) > 0) parts.push(`afade=t=in:st=0:d=${fmt(clip.fadeIn)}`);
  if (num(clip.fadeOut) > 0) parts.push(`afade=t=out:st=${fmt(Math.max(0, clip.duration - clip.fadeOut))}:d=${fmt(clip.fadeOut)}`);
  parts.push(`adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)}`);
  return parts.join(',');
}

// Build the full ffmpeg invocation for a timeline.
// mediaById: { mediaId: { filePath, probe } } — probe from ffprobe.
// settings: { width?, height?, resolution?, fps }
// tmpDir: directory for drawtext text files (created by caller).
// Returns { args, inputs, expected, textFiles }.
function buildRenderPlan({ timeline, mediaById, settings = {}, tmpDir }) {
  const errors = vm.validateTimeline(timeline);
  if (errors.length) throw new Error(`Invalid timeline: ${errors.join(' ')}`);
  const total = vm.totalDuration(timeline);
  const fps = settings.fps || timeline.fps || 30;
  let W, H;
  if (settings.width && settings.height) {
    W = settings.width; H = settings.height;
  } else {
    const d = vm.outputDims(timeline, settings.resolution || '720p');
    W = d.width; H = d.height;
  }
  W = Math.round(W / 2) * 2; H = Math.round(H / 2) * 2;

  const inputs = []; // { args: [...], mediaId? }
  const inputIdxByMedia = new Map();
  const IMAGE_CODECS = ['png', 'mjpeg', 'jpeg', 'jpg', 'bmp', 'webp', 'gif', 'tiff'];
  function inputForMedia(mediaId, opts = {}) {
    const m = mediaById[mediaId];
    if (!m) throw new Error(`Media file #${mediaId} is missing (it may have been deleted). Re-add it to the timeline.`);
    const isImage = m.kind === 'image' || (m.probe && m.probe.codec && IMAGE_CODECS.includes(String(m.probe.codec).toLowerCase()));
    const loop = Boolean(opts.loop);
    const key = `${mediaId}|${loop ? 'L' : ''}|${isImage ? 'I' : ''}`;
    if (inputIdxByMedia.has(key)) return inputIdxByMedia.get(key);
    if (!fs.existsSync(m.filePath)) throw new Error(`Media file "${m.filePath}" is missing on disk.`);
    const idx = inputs.length;
    // Phase 4: image media renders as a looped still; looped video clips
    // (bulk backgrounds) repeat their source to fill the clip.
    const args = isImage ? ['-loop', '1', '-i', m.filePath]
      : loop ? ['-stream_loop', '-1', '-i', m.filePath]
      : ['-i', m.filePath];
    inputs.push({ args, mediaId });
    inputIdxByMedia.set(key, idx);
    return idx;
  }
  function gapInput(dur) {
    const idx = inputs.length;
    inputs.push({ args: ['-f', 'lavfi', '-i', `color=c=${(timeline.background || '#000000').replace('#', '0x')}:s=${W}x${H}:r=${fps}:d=${fmt(dur)}`] });
    return idx;
  }

  const videoTracks = timeline.tracks.filter((t) => t.kind === 'video');
  const audioTracks = timeline.tracks.filter((t) => t.kind === 'audio');
  const textTracks = timeline.tracks.filter((t) => t.kind === 'text');
  const mainTrack = videoTracks[0];
  const overlayTrack = videoTracks[1] || null;

  const filterParts = [];
  const audioLabels = [];
  let segCounter = 0;

  // --- Main video chain: segments chained with xfade (transitions) or concat.
  const segments = [];
  if (mainTrack) {
    const clips = [...mainTrack.clips].sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const clip of clips) {
      if (clip.start > cursor + 0.001) segments.push({ type: 'gap', start: cursor, dur: clip.start - cursor });
      segments.push({ type: 'clip', clip, start: clip.start, dur: clip.duration });
      cursor = clip.start + clip.duration;
    }
    if (total > cursor + 0.001) segments.push({ type: 'gap', start: cursor, dur: total - cursor });
  }
  if (!segments.length) segments.push({ type: 'gap', start: 0, dur: total });

  let curLabel = null;
  let curDur = 0;
  let prevWasClip = false;
  // A transition overlaps the previous clip, so everything after it renders
  // earlier than its timeline time. Track the shift per clip so audio and
  // text stay in sync with the video (renderStart = timeline start minus
  // the transition overlap accumulated before it).
  let overlap = 0;
  const renderStartByClip = new Map();
  const transitionBoundaries = []; // { boundary (timeline s), d }
  for (const seg of segments) {
    const label = `seg${segCounter++}`;
    if (seg.type === 'gap') {
      const gi = gapInput(seg.dur);
      filterParts.push(`[${gi}:v]fps=${fps},scale=${W}:${H},setsar=1,format=yuv420p[${label}]`);
    } else {
      const ii = inputForMedia(seg.clip.mediaId, { loop: seg.clip.loop });
      filterParts.push(clipChain(ii, seg.clip, W, H, fps, label));
    }
    if (!curLabel) {
      curLabel = label; curDur = seg.dur; prevWasClip = seg.type === 'clip';
      continue;
    }
    const tr = seg.type === 'clip' ? (seg.clip.transition || { type: 'none' }) : { type: 'none' };
    const trDef = vm.TRANSITIONS.find((x) => x.id === tr.type);
    if (seg.type === 'clip' && prevWasClip && trDef && trDef.xfade) {
      const d = Math.min(num(tr.duration, 0.5), curDur, seg.dur, 2);
      const out = `xf${segCounter++}`;
      filterParts.push(`[${curLabel}][${label}]xfade=transition=${trDef.xfade}:duration=${fmt(d)}:offset=${fmt(curDur - d)}[${out}]`);
      curLabel = out; curDur = curDur + seg.dur - d;
      overlap += d;
      transitionBoundaries.push({ boundary: seg.start, d });
    } else {
      const out = `cc${segCounter++}`;
      filterParts.push(`[${curLabel}][${label}]concat=n=2:v=1:a=0[${out}]`);
      curLabel = out; curDur = curDur + seg.dur;
    }
    prevWasClip = seg.type === 'clip';
    // A clip's own incoming transition pulls its render start earlier.
    if (seg.type === 'clip') renderStartByClip.set(seg.clip.id, seg.start - overlap);
  }
  const renderedDur = curDur;
  // --- Readability protection (Phase 4): a translucent overlay over the
  // background so template text stays readable. Applied after the main
  // video chain, before overlays and text, so the text stays crisp.
  const ro = Math.max(0, Math.min(0.6, num(settings.readabilityOverlay, 0)));
  if (ro > 0) {
    const rc = settings.readabilityColor && /^#[0-9a-fA-F]{6}$/.test(settings.readabilityColor)
      ? settings.readabilityColor.replace('#', '0x') : '0x000000';
    const out = `ro${segCounter++}`;
    filterParts.push(`[${curLabel}]drawbox=x=0:y=0:w=iw:h=ih:color=${rc}@${fmt(ro)}:t=fill[${out}]`);
    curLabel = out;
  }
  // Timeline time -> rendered time (subtract every transition overlap whose
  // boundary is at or before that time).
  function shiftAt(t) {
    let s = t;
    for (const b of transitionBoundaries) if (t >= b.boundary) s -= b.d;
    return Math.max(0, s);
  }

  // --- Overlay (PiP) video track, if present.
  if (overlayTrack) {
    for (const clip of [...overlayTrack.clips].sort((a, b) => a.start - b.start)) {
      const ii = inputForMedia(clip.mediaId, { loop: clip.loop });
      const oLabel = `ov${segCounter++}`;
      const ow = Math.max(160, Math.round(W * 0.3 * num(clip.zoom, 1)));
      const pos = clip.keyframes && clip.keyframes.length ? vm.keyframeAt(clip, 0) : { x: 70, y: 70 };
      const ox = Math.round((W - ow) * (pos.x / 100));
      const srcDur = clip.duration * clip.speed;
      const oy = Math.round((H - Math.round(ow * (timeline.height / timeline.width))) * (pos.y / 100));
      filterParts.push(
        `[${ii}:v]trim=start=${fmt(clip.srcStart)}:end=${fmt(clip.srcStart + srcDur)},setpts=(PTS-STARTPTS)/${fmt(clip.speed)},` +
        `scale=${ow}:-2,setsar=1,fps=${fps},format=yuv420p[${oLabel}]`
      );
      const out = `ovr${segCounter++}`;
      filterParts.push(`[${curLabel}][${oLabel}]overlay=x=${ox}:y=${oy}:enable='between(t,${fmt(clip.start)},${fmt(clip.start + clip.duration)})'[${out}]`);
      curLabel = out;
    }
  }

  // --- Text overlays (drawtext, one filter per text clip).
  const textFiles = [];
  fs.mkdirSync(tmpDir, { recursive: true });
  let textIdx = 0;
  for (const tr of textTracks) {
    for (const clip of [...tr.clips].sort((a, b) => a.start - b.start)) {
      const txt = clip.text || {};
      const font = fontFor(txt.fontFamily, txt.fontWeight);
      if (!font) throw new Error('No usable system font found for text rendering (DejaVu fonts missing). Install fonts-dejavu and retry.');
      const filePath = path.join(tmpDir, `text${textIdx++}.txt`);
      fs.writeFileSync(filePath, String(txt.text || ''));
      textFiles.push(filePath);
      const fsPx = Math.max(8, Math.round(num(txt.fontSize, 64) * (W / 1080)));
      const px = num(txt.x, 50) / 100 * W;
      const py = num(txt.y, 50) / 100 * H;
      const S = shiftAt(clip.start), E = shiftAt(clip.start + clip.duration);
      // --- Text entrance animation (real drawtext expressions).
      // animDuration (seconds, default 0.4, clamped 0.1–2) is the length of
      // the entrance; the delay is the clip's own start time.
      //   fade: alpha ramps 0 → base over the duration.
      //   slide-left/right/up/down: the text glides in from 120px (x) or
      //     80px (y) away over the duration. 'slide' is the legacy alias
      //     for slide-left.
      //   pop: fontsize ramps 70% → 100% (drawtext fontsize IS an
      //     expression on FFmpeg 8 — verified live) plus a fade.
      //   none: the text is simply there for the whole clip.
      // 'typewriter' is NOT possible with drawtext and is never offered.
      const animDur = Math.max(0.1, Math.min(2, num(txt.animDuration, 0.4)));
      const animIn = String(txt.animIn || 'none');
      let xExpr;
      if (txt.align === 'center') xExpr = `(w-text_w)/2+(${fmt(px - W / 2)})`;
      else if (txt.align === 'right') xExpr = `w-text_w-(${fmt(W - px)})`;
      else xExpr = `${fmt(px)}`;
      let yExpr = `${fmt(py)}`;
      const slideK = `max(0,1-(t-${fmt(S)})/${fmt(animDur)})`;
      // C-07: the slide offset is ONE shared value, clamped so the clip's
      // panel (when it has one) never leaves the frame, and applied
      // identically to the text AND its panel. The old code shifted only
      // the drawtext x/y by a fixed 120px/80px while the panel stayed
      // put, so the text slid out of its panel and clipped at the frame
      // edge. Clamp bounds come from the panel when present (its edges
      // are the visual container), else from the text anchor.
      let dxExpr = '0', dyExpr = '0';
      const maxLeft = txt.panel ? num(txt.panel.x, 0) : px;
      const maxRight = txt.panel ? W - (num(txt.panel.x, 0) + num(txt.panel.w, 100)) : W - px;
      const maxUp = txt.panel ? num(txt.panel.y, 0) : py;
      const maxDown = txt.panel ? H - (num(txt.panel.y, 0) + num(txt.panel.h, 40)) : H - py;
      if (animIn === 'slide' || animIn === 'slide-left') dxExpr = `-${Math.max(0, Math.min(120, maxLeft))}*${slideK}`;
      else if (animIn === 'slide-right') dxExpr = `${Math.max(0, Math.min(120, maxRight))}*${slideK}`;
      else if (animIn === 'slide-up') dyExpr = `-${Math.max(0, Math.min(80, maxUp))}*${slideK}`;
      else if (animIn === 'slide-down') dyExpr = `${Math.max(0, Math.min(80, maxDown))}*${slideK}`;
      if (dxExpr !== '0') xExpr = `(${xExpr})+(${dxExpr})`;
      if (dyExpr !== '0') yExpr = `(${yExpr})+(${dyExpr})`;
      // Phase 4: a text clip may carry a base alpha (reveal dimming) and an
      // option panel (drawbox behind the text — quiz option boxes, timer bar).
      const baseAlpha = Math.max(0, Math.min(1, num(txt.alpha, 1)));
      let alpha = `${fmt(baseAlpha)}`;
      const fadeIn = animIn === 'fade' || animIn === 'pop'
        ? `if(lt(t,${fmt(S + animDur)}),(t-${fmt(S)})/${fmt(animDur)},1)` : '1';
      const aOut = txt.animOut === 'fade' ? `if(gt(t,${fmt(E - 0.4)}),1-(t-${fmt(E - 0.4)})/0.4,1)` : '1';
      if (animIn === 'fade' || animIn === 'pop' || txt.animOut === 'fade') alpha = `${fmt(baseAlpha)}*${fadeIn}*${aOut}`;
      let fsExpr = `${fsPx}`;
      if (animIn === 'pop') fsExpr = `${fsPx}*(0.7+0.3*min(1,(t-${fmt(S)})/${fmt(animDur)}))`;
      if (txt.panel) {
        const p = txt.panel;
        const pOut = `tx${segCounter++}`;
        const pAlpha = p.alpha !== undefined ? `@${fmt(Math.max(0, Math.min(1, num(p.alpha, 1))))}` : '';
        // C-07: the panel slides with its text by the same clamped offset
        // (dxExpr/dyExpr above), so text never leaves its panel.
        const pX = dxExpr !== '0' ? `${fmt(num(p.x, 0))}+(${dxExpr})` : fmt(num(p.x, 0));
        const pY = dyExpr !== '0' ? `${fmt(num(p.y, 0))}+(${dyExpr})` : fmt(num(p.y, 0));
        // The panel is time-gated like its text: without the enable the
        // panel would show for the whole video (e.g. a green reveal panel
        // visible during the question phase).
        filterParts.push(`[${curLabel}]drawbox=x='${pX}':y='${pY}':w=${fmt(num(p.w, 100))}:h=${fmt(num(p.h, 40))}:color=${escColor(p.fill || '#1e293b')}${pAlpha}:t=fill:enable='between(t,${fmt(S)},${fmt(E)})'[${pOut}]`);
        curLabel = pOut;
        if (p.border && num(p.borderWidth) > 0) {
          const bOut = `tx${segCounter++}`;
          filterParts.push(`[${curLabel}]drawbox=x='${pX}':y='${pY}':w=${fmt(num(p.w, 100))}:h=${fmt(num(p.h, 40))}:color=${escColor(p.border)}:t=${Math.round(num(p.borderWidth))}:enable='between(t,${fmt(S)},${fmt(E)})'[${bOut}]`);
          curLabel = bOut;
        }
      }
      let dt = `drawtext=fontfile=${font}:textfile='${filePath}':fontsize='${fsExpr}':fontcolor=${escColor(txt.color)}:x='${xExpr}':y='${yExpr}':alpha='${alpha}':enable='between(t,${fmt(S)},${fmt(E)})'`;
      if (txt.bgColor) dt += `:box=1:boxcolor=${escColor(txt.bgColor)}@0.85:boxborderw=12`;
      const out = `tx${segCounter++}`;
      filterParts.push(`[${curLabel}]${dt}[${out}]`);
      curLabel = out;
    }
  }

  filterParts.push(`[${curLabel}]fps=${fps},setsar=1,format=yuv420p[vout]`);

  // --- Audio: every audible clip, delayed to its timeline start, mixed.
  const audioSources = [];
  function collectAudio(track, clips, useRenderStart) {
    for (const clip of clips) {
      if (track.muted || clip.muted || num(clip.volume, 1) <= 0) continue;
      const m = mediaById[clip.mediaId];
      if (!m || !m.probe || !m.probe.hasAudio) continue;
      // Phase 5: a looped music clip repeats its source to fill the video
      // (stream_loop input); a plain clip plays once and then goes silent.
      const ii = inputForMedia(clip.mediaId, { loop: clip.loop });
      // C-09: audio-track clips have no renderStartByClip entry (that map
      // only covers main-track video segments), so they used to keep their
      // raw timeline start — after a transition the video renders earlier
      // and the audio drifted late by the overlap (0.5s per transition).
      // Shift-compensate with shiftAt, the same mechanism the video uses.
      const startOverride = useRenderStart ? renderStartByClip.get(clip.id) : shiftAt(clip.start);
      const chain = audioChain(ii, clip, true, startOverride);
      if (chain) audioSources.push(chain);
    }
  }
  if (mainTrack) collectAudio(mainTrack, mainTrack.clips, true);
  if (overlayTrack) collectAudio(overlayTrack, overlayTrack.clips, true);
  for (const tr of audioTracks) collectAudio(tr, tr.clips, false);

  let audioLabel = null;
  if (audioSources.length === 1) {
    const only = audioSources[0];
    filterParts.push(`${only},atrim=0:${fmt(renderedDur)},asetpts=PTS-STARTPTS[aout]`);
    audioLabel = 'aout';
  } else if (audioSources.length > 1) {
    const labels = audioSources.map((_, i) => {
      const l = `au${i}`;
      filterParts.push(`${audioSources[i]}[${l}]`);
      return `[${l}]`;
    });
    filterParts.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0,atrim=0:${fmt(renderedDur)},asetpts=PTS-STARTPTS[aout]`);
    audioLabel = 'aout';
  }

  const args = ['-y', '-v', 'info'];
  for (const inp of inputs) args.push(...inp.args);
  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[vout]');
  if (audioLabel) args.push('-map', `[${audioLabel}]`);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', String(fps));
  if (audioLabel) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart', '-t', fmt(renderedDur));

  return {
    args, inputs,
    expected: { width: W, height: H, fps, duration: renderedDur, hasAudio: Boolean(audioLabel) },
    textFiles, totalDuration: renderedDur,
  };
}

// Phase 4: render one bulk-design row (a still image, not a timeline).
// Returns { outPath, warnings, width, height }.
async function processDesignJob(job, payload, { dir, logPath }) {
  const { renderDesign } = require('./design-render');
  const userId = job.user_id;
  const format = payload.format === 'jpg' ? 'jpg' : 'png';
  const outPath = path.join(dir, `${job.id}.${format}`);
  fs.writeFileSync(logPath, `Design render job ${job.id} started ${new Date().toISOString()}\n`);
  db.updateJob(job.id, { output_path: outPath, log_path: logPath });
  const design = payload.design;
  if (!design) throw new Error('Design job has no design snapshot.');
  const mediaIds = new Set();
  for (const l of design.layers || []) {
    if (l.type === 'image' && l.image && l.image.mediaId) mediaIds.add(l.image.mediaId);
  }
  const mediaById = {};
  for (const id of mediaIds) {
    const row = db.getMedia(userId, id);
    if (!row) throw new Error(`Media file #${id} is missing (it may have been deleted).`);
    const filePath = path.join(config.uploadsDir, String(userId), row.stored_name);
    if (!fs.existsSync(filePath)) throw new Error(`Media file "${row.original_name}" is missing on disk.`);
    mediaById[id] = { filePath, kind: row.kind };
  }
  const result = await renderDesign({ design, mediaById, outPath });
  fs.appendFileSync(logPath, `Rendered ${result.width}x${result.height} ${format.toUpperCase()}\n`);
  if (result.warnings.length) fs.appendFileSync(logPath, `Warnings: ${result.warnings.join(' | ')}\n`);
  return { outPath, warnings: result.warnings, width: result.width, height: result.height };
}

module.exports = { buildRenderPlan, fontFor, RENDERS_DIR, CONCURRENCY };

// ---------------------------------------------------------------------------
// Job queue + worker. One active render at a time by default (configurable
// via RENDER_CONCURRENCY). Progress is parsed from FFmpeg's real time=
// output; nothing is simulated.
// ---------------------------------------------------------------------------
const activeJobs = new Map(); // jobId -> { child, cancelled }
let queueTimer = null;
let queueStarted = false;

function rendersDirFor(userId) {
  const d = path.join(RENDERS_DIR, String(userId));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function appendLog(logPath, text) {
  try { fs.appendFileSync(logPath, text); } catch { /* log failure is non-fatal */ }
}

async function processJob(job) {
  const payload = JSON.parse(job.payload || '{}');
  const timeline = payload.timeline;
  const settings = payload.settings || {};
  const userId = job.user_id;
  const dir = rendersDirFor(userId);
  const outPath = path.join(dir, `${job.id}.mp4`);
  const logPath = path.join(dir, `${job.id}.log`);
  const tmpDir = path.join(dir, `tmp-${job.id}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(logPath, `Render job ${job.id} started ${new Date().toISOString()}\n`);
  db.updateJob(job.id, { status: 'running', progress: 0, output_path: outPath, log_path: logPath, error: null });
  const entry = { child: null, cancelled: false };
  activeJobs.set(job.id, entry);
  // Phase 4 bulk hooks — no-ops for plain renders (payload has no bulk ids).
  const bulkStarted = () => { try { require('./bulk').onRowJobStarted(job); } catch { /* bookkeeping must never break a render */ } };
  const bulkFinished = (status, extra) => {
    try {
      const r = require('./bulk').onRowJobFinished(job, status, extra || {});
      if (r && typeof r.catch === 'function') r.catch(() => { /* bulk runner handles its own errors */ });
    } catch { /* bookkeeping must never break a render */ }
  };
  bulkStarted();
  const shortsFinished = (status, extra) => {
    try {
      const r = require('./shorts').onShortsJobFinished(job, status, extra || {});
      if (r && typeof r.catch === 'function') r.catch(() => { /* shorts runner handles its own errors */ });
    } catch { /* bookkeeping must never break a render */ }
  };
  try {
    // Phase 6: Shorts clips render a reframed 9:16 segment with captions.
    if (payload.shorts) {
      const res = await require('./shorts').processShortsJob(job, payload, { dir, logPath });
      db.updateJob(job.id, { status: 'done', progress: 100 });
      credits.chargeCredits(userId, 'render', `Rendered Shorts clip (job ${job.id})`);
      shortsFinished('done', { outputPath: res.outPath });
      return;
    }
    // Phase 4: bulk-design rows render a still image, not a timeline.
    if (payload.design) {
      const res = await processDesignJob(job, payload, { dir, logPath });
      db.updateJob(job.id, { status: 'done', progress: 100 });
      credits.chargeCredits(userId, 'render', `Rendered design ${res.width}x${res.height} (${payload.format || 'png'})`);
      db.audit(userId, 'render_done', 'job', job.id, `Rendered design ${res.width}x${res.height} (${payload.format || 'png'})`);
      bulkFinished('done', { outputPath: res.outPath, warnings: res.warnings });
      return;
    }
    // v2.2.3: deck slideshows render each slide to a still, then a video.
    if (payload.deck) {
      const res = await require('./docs-slides').processDeckJob(job, payload, { dir, logPath });
      db.updateJob(job.id, { status: 'done', progress: 100 });
      credits.chargeCredits(userId, 'render', `Rendered deck video ${res.width}x${res.height}, ${res.duration}s`);
      db.audit(userId, 'render_done', 'job', job.id, `Rendered deck video ${res.width}x${res.height}, ${res.duration}s`);
      bulkFinished('done', { outputPath: res.outPath, warnings: res.warnings });
      return;
    }
    if (!timeline) throw new Error('Job has no timeline snapshot.');
    // Resolve media files (ownership-checked: only this user's media).
    const mediaIds = new Set();
    for (const c of vm.allClips(timeline)) if (c.mediaId) mediaIds.add(c.mediaId);
    const mediaById = {};
    for (const id of mediaIds) {
      const row = db.getMedia(userId, id);
      if (!row) throw new Error(`Media file #${id} is missing (it may have been deleted). Re-add it to the timeline.`);
      const filePath = path.join(config.uploadsDir, String(userId), row.stored_name);
      if (!fs.existsSync(filePath)) throw new Error(`Media file "${row.original_name}" is missing on disk.`);
      const probe = await probeMedia(filePath);
      mediaById[id] = { filePath, probe, kind: row.kind };
    }
    const plan = buildRenderPlan({ timeline, mediaById, settings, tmpDir });
    appendLog(logPath, `ffmpeg ${plan.args.join(' ')}\n`);
    const total = plan.totalDuration;
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', [...plan.args, outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      entry.child = child;
      let tail = '';
      const onData = (buf) => {
        const text = buf.toString();
        appendLog(logPath, text);
        tail = (tail + text).slice(-4000);
        const m = text.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/g);
        if (m && total > 0) {
          const t = parseFFmpegTime(m[m.length - 1].replace('time=', ''));
          if (t !== null) {
            const pct = Math.max(0, Math.min(99, Math.round((t / total) * 100)));
            db.updateJob(job.id, { progress: pct });
          }
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (err) => reject(new Error(`Could not start FFmpeg: ${err.message}`)));
      child.on('close', (code, signal) => {
        if (entry.cancelled) return resolve('cancelled');
        if (code === 0) return resolve('done');
        const lastLines = tail.split('\n').filter(Boolean).slice(-8).join(' ');
        reject(new Error(`FFmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ''}. ${lastLines.slice(0, 1000)}`));
      });
    });
    if (entry.cancelled) {
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
      db.updateJob(job.id, { status: 'cancelled', progress: 0, error: 'Render cancelled.' });
      db.audit(userId, 'render_cancelled', 'job', job.id, `Render job ${job.id} cancelled`);
      bulkFinished('cancelled');
      shortsFinished('cancelled');
      return;
    }
    const check = await validateOutput(outPath, plan.expected);
    if (!check.ok) {
      throw new Error(`Render validation failed: ${check.problems.join(' ')}`);
    }
    db.updateJob(job.id, { status: 'done', progress: 100 });
    credits.chargeCredits(userId, 'render', `Rendered ${plan.expected.width}x${plan.expected.height} @ ${plan.expected.fps}fps, ${plan.expected.duration.toFixed(1)}s`);
    db.audit(userId, 'render_done', 'job', job.id,
      `Rendered ${plan.expected.width}x${plan.expected.height} @ ${plan.expected.fps}fps, ${plan.expected.duration.toFixed(1)}s`);
    bulkFinished('done', { outputPath: outPath });
  } catch (err) {
    if (entry.cancelled) {
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
      db.updateJob(job.id, { status: 'cancelled', progress: 0, error: 'Render cancelled.' });
      bulkFinished('cancelled');
      shortsFinished('cancelled');
      return;
    }
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
    appendLog(logPath, `\nERROR: ${err.message}\n`);
    db.updateJob(job.id, { status: 'failed', error: String(err.message).slice(0, 2000) });
    db.audit(userId, 'render_failed', 'job', job.id, String(err.message).slice(0, 500));
    bulkFinished('failed', { error: String(err.message).slice(0, 2000) });
    shortsFinished('failed', { error: String(err.message).slice(0, 2000) });
  } finally {
    activeJobs.delete(job.id);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function pumpQueue() {
  if (activeJobs.size >= CONCURRENCY) return;
  const job = db.nextQueuedJob();
  if (!job) return;
  // Claim it immediately so a second pump cannot pick the same job.
  db.updateJob(job.id, { status: 'running', progress: 0 });
  processJob({ ...job, status: 'running' }).catch((err) => {
    // processJob handles its own errors; this is a last-resort guard.
    try { db.updateJob(job.id, { status: 'failed', error: String(err && err.message || err).slice(0, 1000) }); } catch { /* ignore */ }
  }).finally(() => { setTimeout(pumpQueue, 100); });
}

function startRenderQueue() {
  if (queueStarted) return;
  queueStarted = true;
  const resumed = db.resetRunningJobs();
  if (resumed) console.log(`Render queue: re-queued ${resumed} interrupted render(s).`);
  queueTimer = setInterval(pumpQueue, 500);
  pumpQueue();
}

function cancelJob(jobId) {
  const entry = activeJobs.get(jobId);
  if (entry) {
    entry.cancelled = true;
    try { if (entry.child) entry.child.kill('SIGKILL'); } catch { /* ignore */ }
    return true;
  }
  const job = db.getJobAny(jobId);
  if (job && job.status === 'queued') {
    db.updateJob(jobId, { status: 'cancelled', error: 'Render cancelled.' });
    return true;
  }
  return false;
}

module.exports.startRenderQueue = startRenderQueue;
module.exports.cancelJob = cancelJob;
module.exports.processJob = processJob;
module.exports.rendersDirFor = rendersDirFor;
