'use strict';
// FFmpeg render engine (Phase 3, extended v2.5.0 — CapCut parity round).
// Real video rendering, no simulation. Builds a filter graph from a
// validated timeline, runs FFmpeg as a background child process, reports
// real progress (parsed from FFmpeg's time= output), validates the result
// with ffprobe, and cleans up.
//
// v2.5.0 notes (what changed and why):
// - Keyframe opacity NO LONGER uses `geq` (that was the 0.06x-realtime
//   bottleneck): opacity is now a constant per <=0.2s segment via
//   `format=rgba,colorchannelmixer=aa=...`, and the segment's alpha is
//   composited onto the timeline background before xfade/concat — which
//   also fixes the old code silently dropping clip opacity (the old
//   `format=yuv420p` after the alpha step discarded it entirely).
// - Keyframes now animate rotation (FFmpeg `rotate` with a per-frame
//   angle expression) and volume (`volume` with eval=frame), each with
//   per-keyframe easing (linear/ease-in/ease-out/ease-in-out).
// - Speed curves / reverse / freeze are one unified segment planner
//   (src/video-model.js clipSegments): the source-time mapping is exact
//   (piecewise-linear curve integrates analytically), reverse is correct
//   per segment, and a freeze holds one frame via the `loop` filter.
// - Stabilisation is a source pre-pass (vidstabdetect + vidstabtransform,
//   cached per media+strength): the .trf is indexed by source frame, so
//   applying it per segment would misalign transforms. The stabilised
//   source is a normal input afterwards, so curves/reverse/freeze still
//   work on it.
// - Fonts: Google Fonts TTFs download on first use into data/fonts
//   (cached); the renderer uses the font the user picked instead of
//   mapping everything to DejaVu. Offline, it falls back to DejaVu and
//   says so in the job log — never silently.
// - Emoji / letter-spaced text: letter spacing renders through libass
//   (ASS + the `subtitles` filter), because drawtext cannot do letter
//   spacing. Emoji does NOT go through libass: verified live (2026-11-14)
//   that neither drawtext nor libass renders colour emoji from Noto Color
//   Emoji on this box (drawtext draws a monochrome silhouette, libass a
//   tofu box, even with an explicit {\fnNoto Color Emoji} override).
//   Emoji text is pre-rendered to a transparent PNG with Python + Pillow
//   (FreeType with FT_LOAD_COLOR at the font's 109px strike — the same
//   spawn-python pattern as pngToCmykJpeg in src/pdf-writer.js) and
//   overlaid as an image. When Python/Pillow is missing, the render falls
//   back to the ASS path and the job log says so.
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const EMOJI_STRIKE_PX = 109; // Noto Color Emoji's only bitmap strike (Pillow fails other sizes)

// Where a colour emoji font lives, in search order (Linux system font,
// Windows Segoe UI Emoji, macOS Apple Color Emoji, data/fonts).
function emojiFontPath() {
  const candidates = [
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
    path.join(process.env.HOME || '', '.fonts', 'NotoColorEmoji.ttf'),
    'C:\\Windows\\Fonts\\seguiemj.ttf',
    '/System/Library/Fonts/Apple Color Emoji.ttc',
    path.join(fontsDir(), 'NotoColorEmoji.ttf'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  try {
    for (const f of fs.readdirSync(fontsDir())) {
      if (/emoji/i.test(f) && /\.(ttf|ttc|otf)$/i.test(f)) return path.join(fontsDir(), f);
    }
  } catch { /* fonts dir may not exist yet */ }
  return null;
}

// Split text into grapheme runs, marking emoji runs. Intl.Segmenter keeps
// ZWJ sequences, skin tones and flags together as one grapheme.
function splitEmojiRuns(text) {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  return String(text || '').split('\n').map((line) => {
    const runs = [];
    for (const { segment } of segmenter.segment(line)) {
      const isEmoji = EMOJI_RE.test(segment);
      const last = runs[runs.length - 1];
      if (last && last.emoji === isEmoji) last.graphemes.push(segment);
      else runs.push({ emoji: isEmoji, graphemes: [segment] });
    }
    return runs;
  });
}

// Run a Python one-liner, trying `python3` then `python` (Windows).
function runPythonScript(script, args) {
  const attempt = (cmd) => new Promise((resolve, reject) => {
    const child = spawn(cmd, ['-c', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('error', (err) => reject(Object.assign(new Error(err.message), { spawnFailed: true })));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Python exited with code ${code}: ${errText.slice(-400) || 'Pillow (PIL) may not be installed.'}`));
    });
  });
  return attempt('python3').catch((e) => (e.spawnFailed ? attempt('python') : Promise.reject(e)));
}

const EMOJI_PNG_SCRIPT = [
  'import sys, json',
  'from PIL import Image, ImageDraw, ImageFont',
  'def hx(s):',
  '    s = (s or "#ffffff").lstrip("#")',
  '    if len(s) < 6: s = "ffffff"',
  '    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), 255)',
  'spec = json.load(open(sys.argv[1]))',
  'out_png, out_side = sys.argv[2], sys.argv[3]',
  'fs = int(spec["fontSize"])',
  'letter = ImageFont.truetype(spec["fontPath"], fs)',
  'emoji_font = ImageFont.truetype(spec["emojiFontPath"], 109)',
  'LH = fs * float(spec.get("lineHeight") or 1.2)',
  'LS = float(spec.get("letterSpacing") or 0)',
  'ascent, descent = letter.getmetrics()',
  'lines = spec["lines"]',
  'widths = []',
  'for line in lines:',
  '    w = 0.0',
  '    for run in line:',
  '        if run["emoji"]:',
  '            w += len(run["graphemes"]) * (fs + LS)',
  '        else:',
  '            for g in run["graphemes"]:',
  '                w += letter.getlength(g) + LS',
  '    if line: w -= LS',
  '    widths.append(max(0.0, w))',
  'max_w = max(widths) if widths else 0.0',
  'total_h = len(lines) * LH',
  'pad = 24',
  'tiles = {}',
  'def tile(g):',
  '    if g in tiles: return tiles[g]',
  '    tmp = Image.new("RGBA", (170, 170), (0, 0, 0, 0))',
  '    d = ImageDraw.Draw(tmp)',
  '    d.text((10, 10), g, font=emoji_font, embedded_color=True)',
  '    bbox = tmp.getbbox()',
  '    if not bbox:',
  '        t = Image.new("RGBA", (fs, fs), (0, 0, 0, 0))',
  '    else:',
  '        crop = tmp.crop(bbox)',
  '        crop.thumbnail((fs, fs), Image.LANCZOS)',
  '        t = Image.new("RGBA", (fs, fs), (0, 0, 0, 0))',
  '        t.alpha_composite(crop, ((fs - crop.width) // 2, (fs - crop.height) // 2))',
  '    tiles[g] = t',
  '    return t',
  'W = int(max_w + 2 * pad + 2)',
  'H = int(total_h + 2 * pad + 2)',
  'img = Image.new("RGBA", (W, H), (0, 0, 0, 0))',
  'd = ImageDraw.Draw(img)',
  'bg = spec.get("bg")',
  'if bg:',
  '    d.rectangle([pad - 12, pad - 12, pad + max_w + 12, pad + total_h + 12], fill=hx(bg))',
  'align = spec.get("align") or "center"',
  'stroke = spec.get("stroke") or {}',
  'sw = int(stroke.get("width") or 0) if stroke.get("enabled") else 0',
  'sc = stroke.get("color") or "#000000"',
  'shadow = spec.get("shadow") or {}',
  'sh_on = bool(shadow.get("enabled"))',
  'sh_dx = int(shadow.get("dx") or 2)',
  'sh_dy = int(shadow.get("dy") or 2)',
  'sh_c = shadow.get("color") or "#000000"',
  'color = spec.get("color") or "#ffffff"',
  'def line_x0(li):',
  '    w = widths[li]',
  '    if align == "left": return pad',
  '    if align == "right": return pad + max_w - w',
  '    return pad + (max_w - w) / 2',
  'def draw_runs(li, dx, dy, fill, with_stroke, with_emoji):',
  '    x = line_x0(li)',
  '    ytop = pad + li * LH',
  '    base = ytop + (LH - (ascent + descent)) / 2',
  '    for run in lines[li]:',
  '        for g in run["graphemes"]:',
  '            if run["emoji"]:',
  '                if with_emoji:',
  '                    t = tile(g)',
  '                    img.alpha_composite(t, (int(round(x + dx)), int(round(ytop + (LH - fs) / 2 + dy))))',
  '                x += fs + LS',
  '            else:',
  '                d.text((x + dx, base + dy), g, font=letter, fill=fill, stroke_width=sw if with_stroke else 0, stroke_fill=hx(sc) if with_stroke else None)',
  '                x += letter.getlength(g) + LS',
  'for li in range(len(lines)):',
  '    if sh_on: draw_runs(li, sh_dx, sh_dy, hx(sh_c), False, False)',
  '    draw_runs(li, 0, 0, hx(color), True, True)',
  'img.save(out_png)',
  'px = float(spec["px"]); py = float(spec["py"])',
  'left = px if align == "left" else (px - max_w if align == "right" else px - max_w / 2)',
  'json.dump({"x": int(round(left - pad)), "y": int(round(py - pad)), "w": W, "h": H}, open(out_side, "w"))',
].join('\n');

// Pre-render one emoji text clip to a transparent PNG (colour emoji via
// Pillow). Returns { path, x, y, w, h } in video-frame pixels. Throws
// when Python/Pillow or an emoji font is missing — the caller falls back
// to the ASS path and logs the reason.
async function renderEmojiTextPng({ clip, W, H, tmpDir }) {
  const txt = clip.text || {};
  const fsPx = Math.max(8, Math.round(num(txt.fontSize, 64) * (W / 1080)));
  const fontPath = fontFor(txt.fontFamily, txt.fontWeight);
  if (!fontPath) throw new Error('No usable font found for emoji text rendering.');
  const emojiFont = emojiFontPath();
  if (!emojiFont) throw new Error('No colour emoji font found (Noto Color Emoji / Segoe UI Emoji).');
  const cs = txt.captionStyle || {};
  const color = cs.preset === 'karaoke' ? (cs.color || '#facc15') : (txt.color || '#ffffff');
  const bg = txt.bgColor || (cs.preset === 'highlight' ? (cs.highlight || '#facc15') : null);
  const spec = {
    fontPath, emojiFontPath: emojiFont, fontSize: fsPx, color,
    align: txt.align || 'center', lineHeight: num(txt.lineHeight, 1.2),
    letterSpacing: num(txt.letterSpacing, 0),
    stroke: txt.stroke && txt.stroke.enabled
      ? { enabled: true, color: txt.stroke.color, width: txt.stroke.width }
      : (cs.preset === 'bold' ? { enabled: true, color: '#000000', width: 2 } : { enabled: false }),
    shadow: txt.shadow && txt.shadow.enabled
      ? { enabled: true, color: txt.shadow.color, dx: txt.shadow.dx, dy: txt.shadow.dy }
      : ((cs.preset === 'glow' || cs.glow) ? { enabled: true, color: '#ffffff', dx: 3, dy: 3 } : { enabled: false }),
    bg,
    px: num(txt.x, 50) / 100 * W, py: num(txt.y, 50) / 100 * H,
    lines: splitEmojiRuns(txt.text || ''),
  };
  const tag = `emoji-${String(clip.id).replace(/[^A-Za-z0-9_-]/g, '')}`;
  const specPath = path.join(tmpDir, `${tag}.json`);
  const pngPath = path.join(tmpDir, `${tag}.png`);
  const sidePath = path.join(tmpDir, `${tag}.side.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec));
  await runPythonScript(EMOJI_PNG_SCRIPT, [specPath, pngPath, sidePath]);
  if (!fs.existsSync(pngPath) || fs.statSync(pngPath).size === 0) {
    throw new Error('Emoji PNG render produced no image.');
  }
  const side = JSON.parse(fs.readFileSync(sidePath, 'utf8'));
  return { path: pngPath, x: side.x, y: side.y, w: side.w, h: side.h };
}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const db = require('./db');
const config = require('./config');
const credits = require('./credits');
const { probeMedia, parseFFmpegTime, run } = require('./ffmpeg');
const vm = require('./video-model');
const { motionCentroid, reframeWindow } = require('./shorts-analysis');

const RENDERS_DIR = config.rendersDir;
const CONCURRENCY = Math.max(1, parseInt(process.env.RENDER_CONCURRENCY || '1', 10));
const FONT_DIR = '/usr/share/fonts/truetype/dejavu';
const FONTS = {
  sans: path.join(FONT_DIR, 'DejaVuSans.ttf'),
  sansBold: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
  serif: path.join(FONT_DIR, 'DejaVuSerif.ttf'),
  serifBold: path.join(FONT_DIR, 'DejaVuSerif-Bold.ttf'),
};

// --- Google Fonts (downloaded on first use, cached in data/fonts) ---------
// Real TTFs from the google/fonts repo (OFL). Variable fonts are used
// where the repo only ships a variable file; drawtext then renders the
// default (Regular) instance — the family is still the one picked.
const FONT_FAMILIES = {
  'Poppins': { regular: 'Poppins-Regular.ttf', bold: 'Poppins-Bold.ttf', base: 'https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/' },
  'Montserrat': { regular: 'Montserrat[wght].ttf', bold: 'Montserrat[wght].ttf', base: 'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/' },
  'Inter': { regular: 'Inter[opsz,wght].ttf', bold: 'Inter[opsz,wght].ttf', base: 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/' },
  'Roboto': { regular: 'Roboto[wdth,wght].ttf', bold: 'Roboto[wdth,wght].ttf', base: 'https://raw.githubusercontent.com/google/fonts/main/apache/roboto/' },
  'Open Sans': { regular: 'OpenSans[wdth,wght].ttf', bold: 'OpenSans[wdth,wght].ttf', base: 'https://raw.githubusercontent.com/google/fonts/main/ofl/opensans/' },
  'Lato': { regular: 'Lato-Regular.ttf', bold: 'Lato-Bold.ttf', base: 'https://raw.githubusercontent.com/google/fonts/main/ofl/lato/' },
  'Bebas Neue': { regular: 'BebasNeue-Regular.ttf', bold: 'BebasNeue-Regular.ttf', base: 'https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/' },
  'Oswald': { regular: 'Oswald[wght].ttf', bold: 'Oswald[wght].ttf', base: 'https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/' },
  'Playfair Display': { regular: 'PlayfairDisplay[wght].ttf', bold: 'PlayfairDisplay[wght].ttf', base: 'https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/' },
};

function fontsDir() {
  return process.env.FONTS_DIR || path.join(config.root, 'data', 'fonts');
}
function stabCacheDir() {
  return process.env.STAB_CACHE_DIR || path.join(config.root, 'data', 'stab');
}

function downloadedFontPath(family, bold) {
  const key = Object.keys(FONT_FAMILIES).find((k) => k.toLowerCase() === String(family || '').trim().toLowerCase());
  if (!key) return null;
  const entry = FONT_FAMILIES[key];
  const file = bold ? (entry.bold || entry.regular) : entry.regular;
  const p = path.join(fontsDir(), file);
  return fs.existsSync(p) ? p : null;
}

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects while downloading a font.'));
    https.get(url, { headers: { 'User-Agent': 'CreativeStudio/2.5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadFile(res.headers.location, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Font download failed (HTTP ${res.statusCode}).`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

const fontDownloadPromises = new Map();
// Download a Google Font TTF on first use (cached forever after). Returns
// the file path, or null when the family is unknown or the download fails
// (offline) — the caller then falls back to DejaVu honestly.
async function ensureFont(family, weight) {
  const bold = (weight || 400) >= 700;
  const key = `${String(family || '').toLowerCase()}|${bold ? 'b' : 'r'}`;
  if (fontDownloadPromises.has(key)) return fontDownloadPromises.get(key);
  const p = (async () => {
    const existing = downloadedFontPath(family, bold);
    if (existing) return existing;
    const famKey = Object.keys(FONT_FAMILIES).find((k) => k.toLowerCase() === String(family || '').trim().toLowerCase());
    if (!famKey) return null;
    const entry = FONT_FAMILIES[famKey];
    const file = bold ? (entry.bold || entry.regular) : entry.regular;
    const url = entry.base + encodeURIComponent(file);
    fs.mkdirSync(fontsDir(), { recursive: true });
    const tmp = path.join(fontsDir(), `${file}.tmp-${process.pid}`);
    await downloadFile(url, tmp);
    const buf = fs.readFileSync(tmp);
    if (buf.length < 20000) throw new Error(`Downloaded font ${file} is suspiciously small (${buf.length} bytes).`);
    const magic = buf.slice(0, 4).toString('latin1');
    const isTtf = buf[0] === 0x00 && buf[1] === 0x01;
    if (!isTtf && magic !== 'true' && magic !== 'OTTO') {
      throw new Error(`Downloaded file ${file} is not a font (bad magic).`);
    }
    fs.renameSync(tmp, path.join(fontsDir(), file));
    return path.join(fontsDir(), file);
  })();
  fontDownloadPromises.set(key, p);
  try {
    return await p;
  } catch {
    fontDownloadPromises.delete(key);
    return null;
  }
}

function fontFor(family, weight) {
  const bold = (weight || 400) >= 700;
  const fam = String(family || '');
  // The font the user picked, when it has been downloaded (see ensureFont).
  const dl = downloadedFontPath(fam, bold);
  if (dl) return dl;
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
  if (/^liberation\s*serif/i.test(fam)) {
    const f = `/usr/share/fonts/truetype/liberation/LiberationSerif-${bold ? 'Bold' : 'Regular'}.ttf`;
    if (fs.existsSync(f)) return f;
  }
  if (/^liberation/i.test(fam)) {
    const f = `/usr/share/fonts/truetype/liberation/LiberationSans-${bold ? 'Bold' : 'Regular'}.ttf`;
    if (fs.existsSync(f)) return f;
  }
  const serif = /playfair|georgia|times|serif/i.test(fam);
  const pick = serif ? (bold ? FONTS.serifBold : FONTS.serif) : (bold ? FONTS.sansBold : FONTS.sans);
  return fs.existsSync(pick) ? pick : null;
}

// Display name for libass (fontconfig resolves the name; downloaded fonts
// are found via the subtitles filter's fontsdir option).
function fontDisplayName(fontPath, family) {
  if (!fontPath) return 'DejaVu Sans';
  const base = path.basename(fontPath);
  if (/DejaVuSans/.test(base)) return 'DejaVu Sans';
  if (/DejaVuSerif/.test(base)) return 'DejaVu Serif';
  if (/LiberationSans/.test(base)) return 'Liberation Sans';
  if (/LiberationSerif/.test(base)) return 'Liberation Serif';
  if (/NotoNaskhArabic/.test(base)) return 'Noto Naskh Arabic';
  if (/NotoKufiArabic/.test(base)) return 'Noto Kufi Arabic';
  if (/NotoSans/.test(base)) return 'Noto Sans';
  if (/NotoSerif/.test(base)) return 'Noto Serif';
  return String(family || 'DejaVu Sans').replace(/["']/g, '');
}

function escColor(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  return `0x${h.length === 6 ? h : 'ffffff'}`;
}
function escFilterPath(p) {
  // subtitles filter: escape backslash, single-quote and colon.
  return String(p).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}
function num(v, d = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}
// Unique temp-file tag (same shape as video-model's uid; render.js cannot
// import it — video-model has no uid export — so it is defined here).
function uid(prefix) {
  return `${prefix || 'x'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function fmt(n) {
  // Short, FFmpeg-safe number formatting (no exponential notation).
  return String(Math.round(n * 1000) / 1000);
}

// Media key for a clip: stabilised clips read their pre-rendered source,
// compound clips read their pre-rendered nested timeline.
function mediaKeyFor(clip) {
  if (clip.stabilize && clip.stabilize.enabled) return `stab:${clip.id}`;
  if (clip.kind === 'compound') return `compound:${clip.id}`;
  return clip.mediaId;
}

// atempo only accepts 0.5..100 — decompose slower speeds into chained factors.
function atempoChain(speed) {
  const factors = [];
  let s = speed;
  while (s < 0.5) { factors.push(0.5); s *= 2; }
  factors.push(Math.round(s * 1000) / 1000);
  return factors.map((f) => `atempo=${fmt(f)}`).join(',');
}

// #2 — one effect id -> a real FFmpeg filter chain (intensity 0..1).
function effectFilter(id, intensity) {
  const i = Math.max(0, Math.min(1, num(intensity, 1)));
  switch (id) {
    case 'glitch': return `rgbashift=rh=${fmt(8 * i)}:rv=${fmt(4 * i)}:gh=${fmt(-6 * i)}:bh=${fmt(-8 * i)},noise=alls=${fmt(12 * i)}:allf=t`;
    case 'retro': return `curves=cross_process,eq=saturation=${fmt(1 - 0.15 * i)}:contrast=${fmt(1 - 0.05 * i)},noise=alls=${fmt(6 * i)}:allf=t,vignette=angle=3.14159/5`;
    case 'blur': return `gblur=sigma=${fmt(0.5 + 4 * i)}`;
    case 'vhs': return `noise=alls=${fmt(20 * i)}:allf=t+u,eq=saturation=${fmt(1 - 0.25 * i)}:contrast=${fmt(1 - 0.1 * i)}:brightness=${fmt(0.02 * i)}`;
    case 'grain': return `noise=alls=${fmt(18 * i)}:allf=t`;
    case 'lightleak': return `colorbalance=rs=${fmt(0.2 * i)}:gs=${fmt(0.05 * i)}:bs=${fmt(-0.12 * i)},eq=brightness=${fmt(0.06 * i)}:saturation=${fmt(1 + 0.25 * i)}`;
    case 'vintage': return `curves=vintage,eq=saturation=${fmt(1 - 0.3 * i)}:contrast=${fmt(1 - 0.05 * i)}`;
    case 'noir': return `hue=s=0,eq=contrast=${fmt(1 + 0.25 * i)}:brightness=${fmt(-0.03 * i)}`;
    case 'neon': return `eq=saturation=${fmt(1 + 1.2 * i)}:contrast=${fmt(1 + 0.2 * i)},unsharp=5:5:${fmt(0.5 + 0.5 * i)}`;
    case 'dream': return `gblur=sigma=${fmt(0.5 + 1.5 * i)},eq=brightness=${fmt(0.05 * i)}:saturation=${fmt(1 + 0.3 * i)}`;
    case 'sharpen': return `unsharp=5:5:${fmt(0.3 + 1.2 * i)}`;
    case 'pixelate': {
      const div = Math.max(2, Math.round(4 + 20 * i));
      return `scale='iw/${div}':'ih/${div}':flags=neighbor,scale='iw*${div}':'ih*${div}':flags=neighbor,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
    }
    case 'invert': return 'negate';
    case 'warm': return `colorbalance=rs=${fmt(0.25 * i)}:bs=${fmt(-0.2 * i)}`;
    case 'cool': return `colorbalance=rs=${fmt(-0.15 * i)}:bs=${fmt(0.25 * i)}`;
    case 'edge': return 'edgedetect=low=0.1:high=0.4';
    default: return '';
  }
}

// #59 — velocity effects: a visual treatment over the speed ramp. The
// speed part lives in the clip's (effective) speed curve; this is the look.
function velocityFilter(id, W, H) {
  switch (id) {
    case 'flash': return 'eq=brightness=0.15:saturation=1.1';
    case 'blur-shake': return `gblur=sigma=1.5,crop=w=iw-8:h=ih-8:x='4+4*sin(t*25)':y='4+4*cos(t*20)',scale=${W}:${H},setsar=1`;
    case 'fade-blur': return 'gblur=sigma=2,eq=brightness=-0.03';
    case 'retro-zoom': return `curves=vintage,crop=w='iw/1.15':h='ih/1.15':x='(iw-ow)/2':y='(ih-oh)/2',scale=${W}:${H},setsar=1`;
    case 'rainbow': return "hue=h='360*t/4':s=1.5";
    default: return '';
  }
}

// A velocity effect implies its speed curve when the clip has no curve of
// its own. Returns the clip to render (a copy when a curve is implied).
function effectiveClip(clip) {
  if (!clip.velocityEffect || clip.velocityEffect === 'none') return clip;
  const sc = clip.speedCurve;
  if (sc && sc.preset && sc.preset !== 'none') return clip;
  const v = vm.VELOCITY_EFFECTS.find((x) => x.id === clip.velocityEffect);
  if (!v || !v.curve) return clip;
  return { ...clip, speedCurve: { preset: v.curve, points: [] } };
}

// FFmpeg expression for eased progress u (an expression string).
function easingExpr(name, u) {
  switch (name) {
    case 'ease-in': return `((${u})*((${u})))`;
    case 'ease-out': return `(1-(1-(${u}))*(1-(${u})))`;
    case 'ease-in-out': return `(if(lt(${u},0.5),2*(${u})*(${u}),1-pow(-2*(${u})+2,2)/2))`;
    default: return `(${u})`;
  }
}

// Easing of the keyframe interval containing [t0, t1] for one property.
function easingFor(clip, prop, t0, t1) {
  const defined = [...(clip.keyframes || [])].filter((k) => k[prop] !== undefined).sort((a, b) => a.t - b.t);
  for (let i = 0; i < defined.length - 1; i++) {
    const a = defined[i], b = defined[i + 1];
    if (t0 >= a.t - 1e-9 && t1 <= b.t + 1e-9) return b.easing || 'linear';
  }
  return 'linear';
}

// Pre-scale filters: auto-reframe crop (subject re-centre, Shorts centroid).
// Stabilisation is NOT here — it is a source pre-pass (see
// stabilizedSourcePath), because the .trf is indexed by source frame.
function clipPreFilters(clip, ctx) {
  const parts = [];
  if (clip.autoReframe && clip.autoReframe.enabled) {
    const target = String(clip.autoReframe.targetAspect || '9:16').split(':').map(Number);
    if (target.length === 2 && target[0] > 0 && target[1] > 0) {
      const probe = ctx.probeFor(clip);
      const motionX = (ctx.motionX && ctx.motionX[clip.id] != null) ? ctx.motionX[clip.id] : 0.5;
      const win = reframeWindow(probe.width, probe.height, motionX, target[0], target[1]);
      parts.push(`crop=${win.cropW}:${win.cropH}:${win.cropX}:${win.cropY}`);
    }
  }
  return parts.join(',');
}

// Static per-clip filters applied after scaling to output size.
// Returns { chain, hasAlpha }: hasAlpha means the output carries an alpha
// channel the caller must composite (flatten onto the background for the
// main track, or let the overlay filter blend for overlay tracks).
function clipTailFilters(clip, W, H, dur, ctx) {
  const parts = [];
  let hasAlpha = false;
  if (clip.rotation === 90) parts.push('transpose=1');
  else if (clip.rotation === 180) parts.push('transpose=2,transpose=2');
  else if (clip.rotation === 270) parts.push('transpose=2');
  // Rotation fix (v2.4.0): a 90°/270° transpose swaps the frame to H×W,
  // so without this the output is the transposed size and the render
  // validator fails — and xfade fails outright when the rotated segment
  // meets an unrotated one. Scale+pad back to the project size right
  // after the transpose.
  if (clip.rotation === 90 || clip.rotation === 270) {
    parts.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
  }
  if (clip.flip === 'h') parts.push('hflip');
  else if (clip.flip === 'v') parts.push('vflip');
  // Chroma key first (it needs clean colours): the keyed frame carries
  // alpha from here on.
  const ch = clip.chroma;
  if (ch && ch.enabled) {
    parts.push(`chromakey=color=${escColor(ch.color || '#00ff00')}:similarity=${fmt(num(ch.similarity, 0.1))}:blend=${fmt(num(ch.blend, 0.05))}`);
    hasAlpha = true;
  }
  // Base filters: preset-merged sliders (see video-model.effectiveFilters).
  const f = vm.effectiveFilters(clip);
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
  // Video effects library (#2) + velocity look (#59).
  for (const e of clip.effects || []) {
    const s2 = effectFilter(e.id, num(e.intensity, 1));
    if (s2) parts.push(s2);
  }
  if (clip.velocityEffect && clip.velocityEffect !== 'none') {
    const s2 = velocityFilter(clip.velocityEffect, W, H);
    if (s2) parts.push(s2);
  }
  // Custom LUT (#7). The path was resolved by the job pre-pass; a missing
  // path here is a hard error, never a silent skip.
  if (clip.lutMediaId != null) {
    const lutPath = ctx.lutPaths && ctx.lutPaths[clip.id];
    if (!lutPath) throw new Error(`LUT file for clip "${clip.name}" was not resolved (media #${clip.lutMediaId} is missing or is not a .CUBE/.3DL file).`);
    parts.push(`lut3d=file='${String(lutPath).replace(/'/g, "\\'")}'`);
  }
  if (num(clip.opacity) < 1) {
    parts.push(`format=rgba,colorchannelmixer=aa=${fmt(clip.opacity)},format=yuva420p`);
    hasAlpha = true;
  }
  if (num(clip.fadeIn) > 0) parts.push(`fade=t=in:st=0:d=${fmt(clip.fadeIn)}`);
  if (num(clip.fadeOut) > 0) parts.push(`fade=t=out:st=${fmt(Math.max(0, dur - clip.fadeOut))}:d=${fmt(clip.fadeOut)}`);
  return { chain: parts.join(','), hasAlpha };
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

// --- Video masking (#9) ---------------------------------------------------
// The mask is a static PNG (one frame, generated with FFmpeg itself):
// white = visible, black = transparent. geq draws rect/circle/linear/
// mirror masks; heart/star use a DejaVu glyph. Feather blurs the mask,
// rotation rotates it, invert negates it.
function ensureMaskFile(clip, W, H, tmpDir) {
  const m = clip.mask;
  const key = [m.type, m.x, m.y, m.w, m.h, m.rotation, m.feather, m.invert, W, H].join('|');
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  const out = path.join(tmpDir, `mask-${hash}.png`);
  if (fs.existsSync(out)) return out;
  const cx = (num(m.x, 50) / 100) * W;
  const cy = (num(m.y, 50) / 100) * H;
  const mw = (num(m.w, 80) / 100) * W;
  const mh = (num(m.h, 80) / 100) * H;
  let vf;
  if (m.type === 'heart' || m.type === 'star') {
    const glyph = m.type === 'heart' ? '♥' : '★';
    const fsPx = Math.max(8, Math.round(Math.min(mw, mh) * 1.15));
    vf = `drawtext=fontfile=${FONTS.sans}:text='${glyph}':fontsize=${fsPx}:fontcolor=white:x='${fmt(cx)}-text_w/2':y='${fmt(cy)}-text_h/2',format=gray`;
  } else {
    let lum;
    if (m.type === 'rect') {
      const x0 = Math.round(cx - mw / 2), x1 = Math.round(cx + mw / 2);
      const y0 = Math.round(cy - mh / 2), y1 = Math.round(cy + mh / 2);
      lum = `if(between(X,${x0},${x1})*between(Y,${y0},${y1}),255,0)`;
    } else if (m.type === 'circle') {
      const r = Math.min(mw, mh) / 2;
      lum = `if(lt(pow(X-${fmt(cx)},2)+pow(Y-${fmt(cy)},2),${fmt(r * r)}),255,0)`;
    } else if (m.type === 'linear') {
      lum = `255*(1-X/${W})`;
    } else { // mirror: symmetric gradient, opaque in the middle
      lum = `255*(1-abs(X-${W / 2})/${W / 2})`;
    }
    vf = `geq=lum='${lum}':cb=128:cr=128,format=gray`;
  }
  if (num(m.feather, 0) > 0) vf += `,gblur=sigma=${fmt(num(m.feather, 0))}`;
  if (num(m.rotation, 0) !== 0) vf += `,rotate=a='${fmt((num(m.rotation, 0) * Math.PI) / 180)}':fillcolor=black`;
  if (m.invert) vf += ',negate';
  fs.mkdirSync(tmpDir, { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=1:r=1`,
    '-vf', vf, '-frames:v', '1', out], { timeout: 30000 });
  return out;
}

// --- Text via libass (#38 emoji, #72 letter spacing) -----------------------
function assEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');
}
function assColor(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  const v = h.length === 6 ? h : 'ffffff';
  return `&H00${v.slice(4, 6)}${v.slice(2, 4)}${v.slice(0, 2)}`;
}
function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const r = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(2, '0')}`;
}
function buildTextAss({ text, fontName, fontSize, bold, color, align, letterSpacing, captionStyle, x, y, W, H, start, end }) {
  const cs = captionStyle || {};
  const primary = assColor(cs.color || color || '#ffffff');
  const alignment = { left: 7, center: 8, right: 9 }[align] || 8;
  const isHighlight = cs.preset === 'highlight';
  const borderStyle = isHighlight ? 3 : 1;
  const backColour = isHighlight ? assColor(cs.highlight || '#000000') : '&HCC000000';
  const outline = cs.preset === 'bold' ? 2 : 1;
  const shadow = (cs.preset === 'glow' || cs.glow) ? 2 : 0;
  const lines = [];
  lines.push('[Script Info]');
  lines.push('ScriptType: v4.00+');
  lines.push(`PlayResX: ${W}`);
  lines.push(`PlayResY: ${H}`);
  lines.push('WrapStyle: 0');
  lines.push('ScaledBorderAndShadow: yes');
  lines.push('');
  lines.push('[V4+ Styles]');
  lines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
  lines.push(`Style: Default,${fontName},${fontSize},${primary},&H0000D8FF,&H00000000,${backColour},${bold ? 1 : 0},0,0,0,100,100,${Math.round(num(letterSpacing, 0))},0,${borderStyle},${outline},${shadow},${alignment},0,0,0,1`);
  lines.push('');
  lines.push('[Events]');
  lines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');
  lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,{\\pos(${Math.round(x)},${Math.round(y)})}${assEscape(text)}`);
  return lines.join('\n') + '\n';
}

// --- One video clip's chain ------------------------------------------------
// Returns { text, label, hasAlpha }. W/H are the clip's target frame size
// (project size for main-track clips, overlay size for PiP clips).
// ctx: { probeFor, lutPaths, motionX, stabilized, isOverlay }.
function clipChain(inputIdx, clip, W, H, fps, label, ctx) {
  const effClip = effectiveClip(clip);
  // Overlay clips keep their existing semantics: x/y/scale keyframes move
  // the overlay on the canvas (handled by the overlay filter), so only
  // rotation/opacity keyframes animate inside the overlay frame.
  const chainClip = ctx.isOverlay
    ? {
      ...effClip,
      keyframes: (effClip.keyframes || [])
        .map((k) => ({ t: k.t, rotation: k.rotation, opacity: k.opacity, easing: k.easing }))
        .filter((k) => k.rotation !== undefined || k.opacity !== undefined),
    }
    : effClip;
  const hasKf = Array.isArray(chainClip.keyframes) && chainClip.keyframes.length > 0;
  const curve = vm.speedCurvePoints(chainClip);
  let minSpeed = num(chainClip.speed, 1);
  if (curve) for (const p of curve) minSpeed = Math.min(minSpeed, p.speed * num(chainClip.speed, 1));
  const needsSegmented = hasKf || !!curve || !!chainClip.reverse
    || !!(chainClip.freeze && chainClip.freeze.enabled)
    || (chainClip.opticalFlow && minSpeed < 0.5);
  if (chainClip.stabilize && chainClip.stabilize.enabled && !(ctx.stabilized && ctx.stabilized[chainClip.id])) {
    throw new Error(`Stabilisation for clip "${chainClip.name}" was not pre-rendered — render through the job queue.`);
  }
  const pre = clipPreFilters(chainClip, ctx);

  if (!needsSegmented) {
    const srcDur = chainClip.duration * chainClip.speed;
    const parts = [
      `[${inputIdx}:v]trim=start=${fmt(chainClip.srcStart)}:end=${fmt(chainClip.srcStart + srcDur)}`,
      `setpts=(PTS-STARTPTS)/${fmt(chainClip.speed)}`,
    ];
    if (pre) parts.push(pre);
    parts.push(scaleChain(chainClip, W, H));
    const zoom = zoomChain(chainClip, W, H);
    if (zoom) parts.push(zoom);
    const tail = clipTailFilters(chainClip, W, H, chainClip.duration, ctx);
    if (tail.chain) parts.push(tail.chain);
    parts.push(`fps=${fps},format=${tail.hasAlpha ? 'yuva420p' : 'yuv420p'}`);
    return { text: `${parts.join(',')}[${label}]`, label, hasAlpha: tail.hasAlpha };
  }

  // Segmented path: keyframes / speed curve / reverse / freeze / optical flow.
  const segs = vm.clipSegments(chainClip);
  const segLabels = [];
  const chains = [];
  let segHasAlpha = false;
  const hasOpacityKf = hasKf && (chainClip.keyframes || []).some((k) => k.opacity !== undefined);
  const hasRotationKf = hasKf && (chainClip.keyframes || []).some((k) => k.rotation !== undefined);
  segs.forEach((seg, i) => {
    const sl = `${label}_s${i}`;
    segLabels.push(sl);
    const mid = (seg.t0 + seg.t1) / 2;
    const kf = hasKf ? vm.keyframeAt(chainClip, mid) : null;
    const kf0 = hasKf ? vm.keyframeAt(chainClip, seg.t0) : null;
    const kf1 = hasKf ? vm.keyframeAt(chainClip, seg.t1) : null;
    let chain;
    if (seg.frozen) {
      const fs0 = chainClip.srcStart + seg.srcStart;
      chain = `[${inputIdx}:v]trim=start=${fmt(fs0)}:end=${fmt(fs0 + 0.04)},setpts=PTS-STARTPTS,` +
        `loop=loop=-1:size=1:start=0,setpts=PTS-STARTPTS,trim=start=0:end=${fmt(seg.duration)}`;
    } else {
      chain = `[${inputIdx}:v]trim=start=${fmt(chainClip.srcStart + seg.srcStart)}:end=${fmt(chainClip.srcStart + seg.srcEnd)}`;
      if (seg.reverse) chain += ',reverse';
      chain += `,setpts=(PTS-STARTPTS)/${fmt(seg.speed)}`;
    }
    if (pre) chain += `,${pre}`;
    if (hasKf) {
      const s = kf.scale;
      const u = `(t/${fmt(seg.duration)})`;
      const xExpr = `(iw-ow)*(${fmt(kf0.x / 100)}+(${fmt(kf1.x / 100)}-${fmt(kf0.x / 100)})*${easingExpr(easingFor(chainClip, 'x', seg.t0, seg.t1), u)})`;
      const yExpr = `(ih-oh)*(${fmt(kf0.y / 100)}+(${fmt(kf1.y / 100)}-${fmt(kf0.y / 100)})*${easingExpr(easingFor(chainClip, 'y', seg.t0, seg.t1), u)})`;
      chain += `,crop=w='iw/${fmt(s)}':h='ih/${fmt(s)}':x='${xExpr}':y='${yExpr}',scale=${W}:${H},setsar=1`;
      if (hasRotationKf) {
        const r0 = kf0.rotation ?? 0, r1 = kf1.rotation ?? 0;
        const e = easingExpr(easingFor(chainClip, 'rotation', seg.t0, seg.t1), u);
        chain += `,rotate=a='((${fmt(r0)}+(${fmt(r1)}-${fmt(r0)})*${e})*PI/180)':fillcolor=black`;
      }
    } else {
      chain += `,${scaleChain(chainClip, W, H)}`;
      const zoom = zoomChain(chainClip, W, H);
      if (zoom) chain += `,${zoom}`;
    }
    if (hasOpacityKf) {
      segHasAlpha = true;
      chain += `,format=rgba,colorchannelmixer=aa=${fmt(kf.opacity)},format=yuva420p`;
    }
    if (chainClip.opticalFlow && seg.speed < 0.5 && !seg.frozen) {
      chain += `,minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`;
    } else {
      chain += `,fps=${fps}`;
    }
    chain += `[${sl}]`;
    chains.push(chain);
  });
  let out = chains.join(';');
  let catLabel;
  if (segLabels.length > 1) {
    catLabel = `${label}_cat`;
    out += `;${segLabels.map((l) => `[${l}]`).join('')}concat=n=${segLabels.length}:v=1:a=0[${catLabel}]`;
  } else {
    catLabel = segLabels[0];
  }
  const tail = clipTailFilters(chainClip, W, H, chainClip.duration, ctx);
  let tailText = `[${catLabel}]`;
  if (tail.chain) tailText += `${tail.chain},`;
  tailText += `fps=${fps},format=${(tail.hasAlpha || segHasAlpha) ? 'yuva420p' : 'yuv420p'}[${label}]`;
  out += `;${tailText}`;
  return { text: out, label, hasAlpha: tail.hasAlpha || segHasAlpha };
}

// --- Audio -----------------------------------------------------------------
// Volume expression over clip time t (piecewise-linear between volume
// keyframes, with easing). Null when the clip has no volume keyframes.
function volumeExpr(clip) {
  const kfs = [...(clip.keyframes || [])].filter((k) => k.volume !== undefined).sort((a, b) => a.t - b.t);
  if (!kfs.length) return null;
  function build(i) {
    if (i >= kfs.length - 1) return fmt(kfs[kfs.length - 1].volume);
    const a = kfs[i], b = kfs[i + 1];
    const u = `(t-${fmt(a.t)})/${fmt(b.t - a.t)}`;
    const e = easingExpr(b.easing || 'linear', u);
    const val = `${fmt(a.volume)}+(${fmt(b.volume)}-${fmt(a.volume)})*(${e})`;
    return `if(lt(t,${fmt(b.t)}),${val},${build(i + 1)})`;
  }
  if (kfs[0].t > 0) return `if(lt(t,${fmt(kfs[0].t)}),${fmt(kfs[0].volume)},${build(0)})`;
  return build(0);
}

// Voice processing (#17). Vocal isolation is centre-channel based
// (karaoke-style): 'remove' cancels the centre, 'keep' extracts it as
// mono. That is a real DSP technique, not AI stem separation, and the
// effects list says so.
function audioFxChain(clip) {
  const a = clip.audioFx || {};
  const parts = [];
  if (a.denoise) parts.push('afftdn=nr=12:nf=-50');
  if (a.enhanceVoice) parts.push('highpass=f=80,lowpass=f=12000,afftdn=nr=8:nf=-45');
  if (a.vocalIsolation === 'remove') parts.push('pan=stereo|c0=c0-c1|c1=c1-c0');
  else if (a.vocalIsolation === 'keep') parts.push('pan=mono|c0=0.5*c0+0.5*c1,aresample=48000,aformat=channel_layouts=stereo');
  if (a.loudnorm) parts.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  return parts.join(',');
}

// One audio clip's chain (segmented like the video chain, so speed curves,
// reverse and freeze stay in sync). Returns { text, label }.
// ctx: { n } — a shared label counter object.
function audioClipChain(inputIdx, clip, startOverride, ctx) {
  const effClip = effectiveClip(clip);
  const segs = vm.clipSegments(effClip);
  const segLabels = [];
  const parts = [];
  segs.forEach((seg) => {
    const sl = `as${ctx.n++}`;
    if (seg.frozen) {
      // A frozen picture holds no audio: silence for the frozen interval.
      parts.push(`anullsrc=r=48000:cl=stereo:d=${fmt(seg.duration)}[${sl}]`);
    } else {
      const src0 = clip.srcStart + seg.srcStart;
      const src1 = clip.srcStart + seg.srcEnd;
      let chain = `[${inputIdx}:a]atrim=start=${fmt(src0)}:end=${fmt(src1)}`;
      if (seg.reverse) chain += ',areverse';
      chain += ',asetpts=PTS-STARTPTS';
      if (seg.speed !== 1) chain += `,${atempoChain(seg.speed)}`;
      chain += ',aresample=48000,aformat=channel_layouts=stereo';
      parts.push(`${chain}[${sl}]`);
    }
    segLabels.push(sl);
  });
  let cur;
  if (segLabels.length === 1) {
    cur = segLabels[0];
  } else {
    cur = `ac${ctx.n++}`;
    parts.push(`${segLabels.map((l) => `[${l}]`).join('')}concat=n=${segLabels.length}:v=0:a=1[${cur}]`);
  }
  const fx = audioFxChain(clip);
  if (fx) {
    const out = `afx${ctx.n++}`;
    parts.push(`[${cur}]${fx}[${out}]`);
    cur = out;
  }
  const vexpr = volumeExpr(clip);
  const out = `av${ctx.n++}`;
  if (vexpr) parts.push(`[${cur}]volume='${vexpr}':eval=frame[${out}]`);
  else parts.push(`[${cur}]volume=${fmt(clip.volume)}[${out}]`);
  cur = out;
  if (num(clip.fadeIn) > 0) {
    const o2 = `afi${ctx.n++}`;
    parts.push(`[${cur}]afade=t=in:st=0:d=${fmt(clip.fadeIn)}[${o2}]`);
    cur = o2;
  }
  if (num(clip.fadeOut) > 0) {
    const o2 = `afo${ctx.n++}`;
    parts.push(`[${cur}]afade=t=out:st=${fmt(Math.max(0, clip.duration - clip.fadeOut))}:d=${fmt(clip.fadeOut)}[${o2}]`);
    cur = o2;
  }
  const start = startOverride !== undefined ? startOverride : clip.start;
  const o3 = `ad${ctx.n++}`;
  parts.push(`[${cur}]adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)}[${o3}]`);
  return { text: parts.join(';'), label: o3 };
}

// ---------------------------------------------------------------------------
// Render plan
// ---------------------------------------------------------------------------

// Output CRF for a quality preset (or an explicit crf setting).
function crfFor(settings, vcodec) {
  if (settings.crf !== undefined && settings.crf !== null) {
    return Math.max(0, Math.min(51, Math.round(num(settings.crf, 23))));
  }
  const q = settings.quality || 'medium';
  const map = {
    libx264: { low: 28, medium: 23, high: 18, best: 14 },
    libx265: { low: 32, medium: 28, high: 23, best: 18 },
    libvpx: { low: 35, medium: 30, high: 25, best: 18 },
  };
  const m = map[vcodec] || map.libx264;
  return m[q] || m.medium;
}

// Build the full ffmpeg invocation for a timeline.
// mediaById: { mediaId: { filePath, probe, kind } } — probe from ffprobe.
//   Compound clips use key `compound:<clipId>`; stabilised clips use
//   key `stab:<clipId>` (see prepareTimelineSources).
// settings: { width?, height?, resolution?, fps, format, codec, bitrateKbps,
//   quality, crf, hdr, audioOnly, audioFormat, audioBitrateKbps }
// tmpDir: directory for drawtext/ASS/mask files (created by caller).
// extras: { lutPaths, motionX, stabilized } from the job pre-pass.
// Returns { args, inputs, expected, textFiles, totalDuration, warnings }.
function buildRenderPlan({ timeline, mediaById, settings = {}, tmpDir, extras = {} }) {
  const errors = vm.validateTimeline(timeline);
  if (errors.length) throw new Error(`Invalid timeline: ${errors.join(' ')}`);
  // Gradient text is refused honestly at render time: drawtext cannot do
  // gradients, and a solid render would be a silent lie.
  for (const c of vm.allClips(timeline)) {
    if (c.kind === 'text' && c.text && c.text.gradient && c.text.gradient.enabled) {
      throw new Error(`Gradient text is not supported in renders — remove the gradient from clip "${c.name}" or use a solid color.`);
    }
  }
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
  const finalFmt = settings.hdr ? 'yuv420p10le' : 'yuv420p';
  const warnings = [];
  const audioOnly = !!settings.audioOnly;
  const bgHex = escColor(vm.backgroundColor(timeline));
  const bg = timeline.background;
  const bgMediaKey = (bg && typeof bg === 'object' && (bg.type === 'image' || bg.type === 'blur') && bg.mediaId != null) ? bg.mediaId : null;
  if (bgMediaKey && !mediaById[bgMediaKey]) {
    throw new Error(`Background media #${bgMediaKey} is missing (it may have been deleted).`);
  }

  const inputs = []; // { args: [...], mediaId? }
  const inputIdxByMedia = new Map();
  const IMAGE_CODECS = ['png', 'mjpeg', 'jpeg', 'jpg', 'bmp', 'webp', 'gif', 'tiff'];
  function inputForMedia(key, opts = {}) {
    const m = mediaById[key];
    if (!m) throw new Error(`Media file #${key} is missing (it may have been deleted). Re-add it to the timeline.`);
    const isImage = m.kind === 'image' || (m.probe && m.probe.codec && IMAGE_CODECS.includes(String(m.probe.codec).toLowerCase()));
    const loop = Boolean(opts.loop);
    const k = `${key}|${loop ? 'L' : ''}|${isImage ? 'I' : ''}`;
    if (inputIdxByMedia.has(k)) return inputIdxByMedia.get(k);
    if (!fs.existsSync(m.filePath)) throw new Error(`Media file "${m.filePath}" is missing on disk.`);
    const idx = inputs.length;
    const args = isImage ? ['-loop', '1', '-i', m.filePath]
      : loop ? ['-stream_loop', '-1', '-i', m.filePath]
      : ['-i', m.filePath];
    inputs.push({ args, mediaId: key });
    inputIdxByMedia.set(k, idx);
    return idx;
  }
  function maskInput(maskPath) {
    const key = `mask:${maskPath}`;
    if (inputIdxByMedia.has(key)) return inputIdxByMedia.get(key);
    const idx = inputs.length;
    inputs.push({ args: ['-loop', '1', '-i', maskPath] });
    inputIdxByMedia.set(key, idx);
    return idx;
  }
  // A pre-rendered image (e.g. an emoji text PNG) as a looped input.
  function imageInput(pngPath) {
    const key = `img:${pngPath}`;
    if (inputIdxByMedia.has(key)) return inputIdxByMedia.get(key);
    const idx = inputs.length;
    inputs.push({ args: ['-loop', '1', '-i', pngPath] });
    inputIdxByMedia.set(key, idx);
    return idx;
  }
  function gapInput(dur) {
    const idx = inputs.length;
    inputs.push({ args: ['-f', 'lavfi', '-i', `color=c=${bgHex}:s=${W}x${H}:r=${fps}:d=${fmt(dur)}`] });
    return idx;
  }

  const ctx = {
    tmpDir,
    lutPaths: extras.lutPaths || {},
    motionX: extras.motionX || {},
    stabilized: extras.stabilized || {},
    textPngs: extras.textPngs || {},
    isOverlay: false,
    probeFor(clip) {
      const m = mediaById[mediaKeyFor(clip)] || mediaById[clip.mediaId];
      if (m && m.probe && m.probe.width && m.probe.height) return { width: m.probe.width, height: m.probe.height };
      return { width: timeline.width, height: timeline.height };
    },
  };

  const videoTracks = timeline.tracks.filter((t) => t.kind === 'video');
  const audioTracks = timeline.tracks.filter((t) => t.kind === 'audio');
  const textTracks = timeline.tracks.filter((t) => t.kind === 'text');
  const effectTracks = timeline.tracks.filter((t) => t.kind === 'effect');
  const mainTrack = videoTracks[0] || null;

  const filterParts = [];
  let segCounter = 0;
  const textFiles = [];

  // Does any main-track clip carry alpha that must be composited onto the
  // background before xfade/concat (chroma, opacity, opacity keyframes,
  // mask)? If so, build the background base stream first.
  const mainClips = mainTrack ? mainTrack.clips : [];
  const needsFlatten = mainClips.some((c) =>
    (c.chroma && c.chroma.enabled) || num(c.opacity, 1) < 1
    || (c.keyframes || []).some((k) => k.opacity !== undefined)
    || (c.mask && c.mask.type && c.mask.type !== 'none'));
  let bgbaseLabel = null;
  if (needsFlatten && !audioOnly) {
    bgbaseLabel = 'bgbase';
    if (bgMediaKey && mediaById[bgMediaKey]) {
      const bi = inputForMedia(bgMediaKey);
      const blurPart = (bg.type === 'blur') ? ',gblur=sigma=20' : '';
      filterParts.push(`[${bi}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}${blurPart},setsar=1,format=yuv420p[${bgbaseLabel}]`);
    } else {
      filterParts.push(`color=c=${bgHex}:s=${W}x${H}:r=${fps}:d=${fmt(Math.max(1, total))}[${bgbaseLabel}]`);
    }
  }
  // Composite an alpha-carrying label onto the background. Full-size
  // segments use the shared background base; split-screen sides get an
  // inline colour source at their own size.
  function flatten(label, w, h, dur) {
    const out = `fl${segCounter++}`;
    if (w === W && h === H && bgbaseLabel) {
      filterParts.push(`[${bgbaseLabel}][${label}]overlay=format=yuv420[${out}]`);
    } else {
      const bgSrc = `flbg${segCounter++}`;
      filterParts.push(`color=c=${bgHex}:s=${w}x${h}:r=${fps}:d=${fmt(Math.max(0.1, dur))}[${bgSrc}];[${bgSrc}][${label}]overlay=format=yuv420[${out}]`);
    }
    return out;
  }
  // Apply a video mask (alphamerge with the generated mask image).
  function applyMask(label, clip, w, h) {
    const mp = ensureMaskFile(clip, w, h, tmpDir);
    const mi = maskInput(mp);
    const mkImg = `mki${segCounter++}`, rg = `mkr${segCounter++}`, out = `mko${segCounter++}`;
    filterParts.push(`[${mi}:v]format=gray,scale=${w}:${h},setsar=1,fps=${fps}[${mkImg}]`);
    filterParts.push(`[${label}]format=rgba[${rg}];[${rg}][${mkImg}]alphamerge,format=yuva420p[${out}]`);
    return out;
  }
  function gapChain(dur, label) {
    if (bgMediaKey && mediaById[bgMediaKey]) {
      const bi = inputForMedia(bgMediaKey);
      const blurPart = (bg.type === 'blur') ? ',gblur=sigma=20' : '';
      return `[${bi}:v]trim=start=0:end=${fmt(dur)},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}${blurPart},setsar=1,format=yuv420p,fps=${fps}[${label}]`;
    }
    const gi = gapInput(dur);
    return `[${gi}:v]fps=${fps},scale=${W}:${H},setsar=1,format=yuv420p[${label}]`;
  }
  function findClip(id) {
    for (const c of vm.allClips(timeline)) if (c.id === id) return c;
    return null;
  }
  // One main-track segment (a clip, possibly split-screen) -> final label.
  function buildClipSegment(seg, baseLabel) {
    const clip = seg.clip;
    const ii = inputForMedia(mediaKeyFor(clip), { loop: clip.loop });
    if (clip.splitScreen && clip.splitScreen.enabled) {
      const partner = findClip(clip.splitScreen.partnerClipId);
      if (!partner) throw new Error(`Split-screen partner clip "${clip.splitScreen.partnerClipId}" was not found.`);
      const W2 = Math.round(W / 2 / 2) * 2;
      const mainR = clipChain(ii, clip, W2, H, fps, baseLabel, ctx);
      filterParts.push(mainR.text);
      let mainL = mainR.label;
      const mainMasked = clip.mask && clip.mask.type && clip.mask.type !== 'none';
      if (mainMasked) mainL = applyMask(mainL, clip, W2, H);
      if (mainR.hasAlpha || mainMasked) mainL = flatten(mainL, W2, H, seg.dur);
      const pi = inputForMedia(mediaKeyFor(partner), { loop: partner.loop });
      // The partner plays its source over the split-screen window, so it
      // is rendered with the window's duration (its own start is ignored).
      const partnerView = { ...partner, duration: clip.duration };
      const partR = clipChain(pi, partnerView, W2, H, fps, `${baseLabel}_p`, ctx);
      filterParts.push(partR.text);
      let partL = partR.label;
      const partMasked = partner.mask && partner.mask.type && partner.mask.type !== 'none';
      if (partMasked) partL = applyMask(partL, partner, W2, H);
      if (partR.hasAlpha || partMasked) partL = flatten(partL, W2, H, seg.dur);
      const ssLabel = `ss${segCounter++}`;
      filterParts.push(`[${mainL}][${partL}]hstack=inputs=2[${ssLabel}]`);
      return ssLabel;
    }
    const r = clipChain(ii, clip, W, H, fps, baseLabel, ctx);
    filterParts.push(r.text);
    let segLabel = r.label;
    const masked = clip.mask && clip.mask.type && clip.mask.type !== 'none';
    if (masked) segLabel = applyMask(segLabel, clip, W, H);
    if (r.hasAlpha || masked) segLabel = flatten(segLabel, W, H, seg.dur);
    return segLabel;
  }

  // --- Audio mix (built in both modes; video mode needs the transition
  // shift map, so the video chain runs first when not audio-only).
  const audioCtx = { n: 0 };
  let audioLabel = null;
  let renderedDur = total;
  let shiftAt = (t) => t;
  const renderStartByClip = new Map();

  function collectAudioClips(track, clips, useRenderStart) {
    const out = [];
    for (const clip of clips) {
      if (track.muted || clip.muted) continue;
      if (num(clip.volume, 1) <= 0 && !volumeExpr(clip)) continue;
      const key = mediaKeyFor(clip);
      const m = mediaById[key] || mediaById[clip.mediaId];
      if (!m || !m.probe || !m.probe.hasAudio) continue;
      const ii = inputForMedia(key, { loop: clip.loop });
      const startOverride = useRenderStart ? renderStartByClip.get(clip.id) : shiftAt(clip.start);
      const chain = audioClipChain(ii, clip, startOverride, audioCtx);
      filterParts.push(chain.text);
      out.push({ label: chain.label, ducking: !!(clip.audioFx && clip.audioFx.ducking) });
    }
    return out;
  }
  function buildAudioMix() {
    const audioChains = [];
    if (mainTrack) audioChains.push(...collectAudioClips(mainTrack, mainTrack.clips, true));
    for (const tr of videoTracks.slice(1)) audioChains.push(...collectAudioClips(tr, tr.clips, false));
    for (const tr of audioTracks) audioChains.push(...collectAudioClips(tr, tr.clips, false));
    const ducking = audioChains.filter((c) => c.ducking);
    const dialogue = audioChains.filter((c) => !c.ducking);
    let mixLabels = [];
    if (ducking.length && dialogue.length) {
      let dlgLabel;
      if (dialogue.length === 1) {
        dlgLabel = dialogue[0].label;
      } else {
        dlgLabel = `dlg${segCounter++}`;
        filterParts.push(`${dialogue.map((c) => `[${c.label}]`).join('')}amix=inputs=${dialogue.length}:normalize=0[${dlgLabel}]`);
      }
      mixLabels.push(dlgLabel);
      for (const d of ducking) {
        const out = `dk${segCounter++}`;
        filterParts.push(`[${d.label}][${dlgLabel}]sidechaincompress=threshold=0.05:ratio=6:attack=5:release=250[${out}]`);
        mixLabels.push(out);
      }
    } else {
      if (ducking.length && !dialogue.length) {
        warnings.push('Auto-ducking had no dialogue track to duck under — the music was left unducked.');
      }
      mixLabels = audioChains.map((c) => c.label);
    }
    if (mixLabels.length === 1) {
      filterParts.push(`[${mixLabels[0]}]atrim=0:${fmt(renderedDur)},asetpts=PTS-STARTPTS[aout]`);
      audioLabel = 'aout';
    } else if (mixLabels.length > 1) {
      filterParts.push(`${mixLabels.map((l) => `[${l}]`).join('')}amix=inputs=${mixLabels.length}:normalize=0,atrim=0:${fmt(renderedDur)},asetpts=PTS-STARTPTS[aout]`);
      audioLabel = 'aout';
    }
  }

  if (!audioOnly) {
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

    // Split-screen partners are rendered inside the main segment, so they
    // must not also be composited from their own track.
    const usedAsSplitPartner = new Set();
    for (const c of mainClips) {
      if (c.splitScreen && c.splitScreen.enabled && c.splitScreen.partnerClipId) {
        usedAsSplitPartner.add(c.splitScreen.partnerClipId);
      }
    }

    let curLabel = null;
    let curDur = 0;
    let prevWasClip = false;
    // A transition overlaps the previous clip, so everything after it
    // renders earlier than its timeline time. Track the shift per clip so
    // audio and text stay in sync with the video.
    let overlap = 0;
    const transitionBoundaries = []; // { boundary (timeline s), d }
    for (const seg of segments) {
      const baseLabel = `seg${segCounter++}`;
      let segLabel;
      if (seg.type === 'gap') {
        filterParts.push(gapChain(seg.dur, baseLabel));
        segLabel = baseLabel;
      } else {
        segLabel = buildClipSegment(seg, baseLabel);
      }
      if (!curLabel) {
        curLabel = segLabel; curDur = seg.dur; prevWasClip = seg.type === 'clip';
        continue;
      }
      const tr = seg.type === 'clip' ? (seg.clip.transition || { type: 'none' }) : { type: 'none' };
      const trDef = vm.TRANSITIONS.find((x) => x.id === tr.type);
      if (seg.type === 'clip' && prevWasClip && trDef && trDef.xfade) {
        const d = Math.min(num(tr.duration, 0.5), curDur, seg.dur, trDef.maxDuration);
        const out = `xf${segCounter++}`;
        filterParts.push(`[${curLabel}][${segLabel}]xfade=transition=${trDef.xfade}:duration=${fmt(d)}:offset=${fmt(curDur - d)}[${out}]`);
        curLabel = out; curDur = curDur + seg.dur - d;
        overlap += d;
        transitionBoundaries.push({ boundary: seg.start, d });
      } else {
        const out = `cc${segCounter++}`;
        filterParts.push(`[${curLabel}][${segLabel}]concat=n=2:v=1:a=0[${out}]`);
        curLabel = out; curDur = curDur + seg.dur;
      }
      prevWasClip = seg.type === 'clip';
      if (seg.type === 'clip') renderStartByClip.set(seg.clip.id, seg.start - overlap);
    }
    renderedDur = curDur;
    // Timeline time -> rendered time (subtract every transition overlap
    // whose boundary is at or before that time).
    shiftAt = (t) => {
      let s = t;
      for (const b of transitionBoundaries) if (t >= b.boundary) s -= b.d;
      return Math.max(0, s);
    };
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
    // --- Overlay (PiP) video tracks: every video track beyond track 0.
    for (const tr of videoTracks.slice(1)) {
      for (const clip of [...tr.clips].sort((a, b) => a.start - b.start)) {
        if (usedAsSplitPartner.has(clip.id)) continue;
        const ii = inputForMedia(mediaKeyFor(clip), { loop: clip.loop });
        const oLabel = `ov${segCounter++}`;
        const ov = clip.overlay || {};
        const ow = Math.max(160, Math.round(W * num(ov.w, 30) / 100 / 2) * 2);
        let oh;
        if (ov.h) {
          oh = Math.max(80, Math.round(H * num(ov.h, 0) / 100 / 2) * 2);
        } else {
          const rot90 = clip.rotation === 90 || clip.rotation === 270;
          oh = Math.round(ow * (rot90 ? timeline.width / timeline.height : timeline.height / timeline.width) / 2) * 2;
        }
        const pos = clip.overlay
          ? { x: num(clip.overlay.x, 70), y: num(clip.overlay.y, 70) }
          : (clip.keyframes && clip.keyframes.length ? vm.keyframeAt(clip, 0) : { x: 70, y: 70 });
        const ox = Math.round((W - ow) * (num(pos.x, 70) / 100));
        const oy = Math.round((H - oh) * (num(pos.y, 70) / 100));
        const r = clipChain(ii, clip, ow, oh, fps, oLabel, { ...ctx, isOverlay: true });
        filterParts.push(r.text);
        let ovLabel = r.label;
        if (clip.mask && clip.mask.type && clip.mask.type !== 'none') ovLabel = applyMask(ovLabel, clip, ow, oh);
        const out = `ovr${segCounter++}`;
        const S = shiftAt(clip.start), E = shiftAt(clip.start + clip.duration);
        filterParts.push(`[${curLabel}][${ovLabel}]overlay=x=${ox}:y=${oy}:enable='between(t,${fmt(S)},${fmt(E)})'[${out}]`);
        curLabel = out;
      }
    }
    // --- Effect tracks (adjustment layers, #42): each effect clip grades
    // the composited frame beneath it for its own time range.
    for (const tr of effectTracks) {
      for (const clip of [...tr.clips].sort((a, b) => a.start - b.start)) {
        let filt = '';
        if (Array.isArray(clip.effects) && clip.effects.length) {
          filt = clip.effects.map((e) => effectFilter(e.id, num(e.intensity, 1))).filter(Boolean).join(',');
        } else if (clip.effectId) {
          filt = effectFilter(clip.effectId, num(clip.intensity, 0.8));
        }
        if (!filt) continue;
        const S = Math.max(0, Math.min(renderedDur, shiftAt(clip.start)));
        const E = Math.max(0, Math.min(renderedDur, shiftAt(clip.start + clip.duration)));
        if (E - S < 0.01) continue;
        if (S <= 0.001 && E >= renderedDur - 0.001) {
          const out = `fx${segCounter++}`;
          filterParts.push(`[${curLabel}]${filt}[${out}]`);
          curLabel = out;
          continue;
        }
        const parts = [];
        const labels = [];
        if (S > 0.001) {
          const a = `fxa${segCounter++}`;
          labels.push(`[${a}]`);
          parts.push(`[${curLabel}]trim=start=0:end=${fmt(S)},setpts=PTS-STARTPTS[${a}]`);
        }
        const b = `fxb${segCounter++}`;
        labels.push(`[${b}]`);
        parts.push(`[${curLabel}]trim=start=${fmt(S)}:end=${fmt(E)},setpts=PTS-STARTPTS,${filt}[${b}]`);
        if (E < renderedDur - 0.001) {
          const c = `fxc${segCounter++}`;
          labels.push(`[${c}]`);
          parts.push(`[${curLabel}]trim=start=${fmt(E)}:end=${fmt(renderedDur)},setpts=PTS-STARTPTS[${c}]`);
        }
        const out = `fx${segCounter++}`;
        parts.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[${out}]`);
        filterParts.push(parts.join(';'));
        curLabel = out;
      }
    }
    // --- Text overlays.
    const textFilesLocal = textFiles;
    fs.mkdirSync(tmpDir, { recursive: true });
    let textIdx = 0;
    for (const tr of textTracks) {
      for (const clip of [...tr.clips].sort((a, b) => a.start - b.start)) {
        const txt = clip.text || {};
        const font = fontFor(txt.fontFamily, txt.fontWeight);
        if (!font) throw new Error('No usable system font found for text rendering (DejaVu fonts missing). Install fonts-dejavu and retry.');
        const fsPx = Math.max(8, Math.round(num(txt.fontSize, 64) * (W / 1080)));
        const px = num(txt.x, 50) / 100 * W;
        const py = num(txt.y, 50) / 100 * H;
        const S = shiftAt(clip.start), E = shiftAt(clip.start + clip.duration);
        const useAss = EMOJI_RE.test(String(txt.text || '')) || num(txt.letterSpacing, 0) !== 0;
        const animDur = Math.max(0.1, Math.min(2, num(txt.animDuration, 0.4)));
        const animIn = String(txt.animIn || 'none');
        // Slide offsets (drawtext path only — ASS text does not slide, so
        // its panel stays put too).
        let dxExpr = '0', dyExpr = '0';
        if (!useAss) {
          const slideK = `max(0,1-(t-${fmt(S)})/${fmt(animDur)})`;
          const maxLeft = txt.panel ? num(txt.panel.x, 0) : px;
          const maxRight = txt.panel ? W - (num(txt.panel.x, 0) + num(txt.panel.w, 100)) : W - px;
          const maxUp = txt.panel ? num(txt.panel.y, 0) : py;
          const maxDown = txt.panel ? H - (num(txt.panel.y, 0) + num(txt.panel.h, 40)) : H - py;
          if (animIn === 'slide' || animIn === 'slide-left') dxExpr = `-${Math.max(0, Math.min(120, maxLeft))}*${slideK}`;
          else if (animIn === 'slide-right') dxExpr = `${Math.max(0, Math.min(120, maxRight))}*${slideK}`;
          else if (animIn === 'slide-up') dyExpr = `-${Math.max(0, Math.min(80, maxUp))}*${slideK}`;
          else if (animIn === 'slide-down') dyExpr = `${Math.max(0, Math.min(80, maxDown))}*${slideK}`;
        }
        // Phase 4: option panel (drawbox behind the text — quiz option
        // boxes, timer bar). Time-gated like its text.
        if (txt.panel) {
          const p = txt.panel;
          const pOut = `tx${segCounter++}`;
          const pAlpha = p.alpha !== undefined ? `@${fmt(Math.max(0, Math.min(1, num(p.alpha, 1))))}` : '';
          const pX = dxExpr !== '0' ? `${fmt(num(p.x, 0))}+(${dxExpr})` : fmt(num(p.x, 0));
          const pY = dyExpr !== '0' ? `${fmt(num(p.y, 0))}+(${dyExpr})` : fmt(num(p.y, 0));
          filterParts.push(`[${curLabel}]drawbox=x='${pX}':y='${pY}':w=${fmt(num(p.w, 100))}:h=${fmt(num(p.h, 40))}:color=${escColor(p.fill || '#1e293b')}${pAlpha}:t=fill:enable='between(t,${fmt(S)},${fmt(E)})'[${pOut}]`);
          curLabel = pOut;
          if (p.border && num(p.borderWidth) > 0) {
            const bOut = `tx${segCounter++}`;
            filterParts.push(`[${curLabel}]drawbox=x='${pX}':y='${pY}':w=${fmt(num(p.w, 100))}:h=${fmt(num(p.h, 40))}:color=${escColor(p.border)}:t=${Math.round(num(p.borderWidth))}:enable='between(t,${fmt(S)},${fmt(E)})'[${bOut}]`);
            curLabel = bOut;
          }
        }
        const emojiPng = ctx.textPngs && ctx.textPngs[clip.id];
        if (emojiPng) {
          // Colour emoji (#38): pre-rendered transparent PNG (Pillow).
          // The panel above still draws; the ASS/drawtext text is
          // skipped so no tofu box appears behind the emoji.
          const pIdx = imageInput(emojiPng.path);
          const pLabel = `tx${segCounter++}e`;
          const pOut = `tx${segCounter++}`;
          filterParts.push(`[${pIdx}:v]format=rgba[${pLabel}]`);
          filterParts.push(`[${curLabel}][${pLabel}]overlay=x=${Math.round(emojiPng.x)}:y=${Math.round(emojiPng.y)}:format=yuv420:enable='between(t,${fmt(S)},${fmt(E)})'[${pOut}]`);
          curLabel = pOut;
          continue;
        }
        if (useAss) {
          // Letter spacing: libass handles ASS Spacing. (Emoji used to
          // come through this path too, but libass renders colour emoji
          // as tofu on this box — emoji clips are pre-rendered to PNGs
          // above, and only reach here when that pre-render failed.)
          const assPath = path.join(tmpDir, `text${textIdx++}.ass`);
          const ass = buildTextAss({
            text: txt.text || '', fontName: fontDisplayName(font, txt.fontFamily),
            fontSize: fsPx, bold: (txt.fontWeight || 400) >= 700, color: txt.color,
            align: txt.align, letterSpacing: txt.letterSpacing, captionStyle: txt.captionStyle,
            x: px, y: py, W, H, start: S, end: E,
          });
          fs.writeFileSync(assPath, ass);
          textFilesLocal.push(assPath);
          const out = `tx${segCounter++}`;
          filterParts.push(`[${curLabel}]subtitles=filename='${escFilterPath(assPath)}':fontsdir='${escFilterPath(fontsDir())}'[${out}]`);
          curLabel = out;
          continue;
        }
        const filePath = path.join(tmpDir, `text${textIdx++}.txt`);
        fs.writeFileSync(filePath, String(txt.text || ''));
        textFilesLocal.push(filePath);
        let xExpr;
        if (txt.align === 'center') xExpr = `(w-text_w)/2+(${fmt(px - W / 2)})`;
        else if (txt.align === 'right') xExpr = `w-text_w-(${fmt(W - px)})`;
        else xExpr = `${fmt(px)}`;
        let yExpr = `${fmt(py)}`;
        if (dxExpr !== '0') xExpr = `(${xExpr})+(${dxExpr})`;
        if (dyExpr !== '0') yExpr = `(${yExpr})+(${dyExpr})`;
        const baseAlpha = Math.max(0, Math.min(1, num(txt.alpha, 1)));
        let alpha = `${fmt(baseAlpha)}`;
        const fadeIn = animIn === 'fade' || animIn === 'pop'
          ? `if(lt(t,${fmt(S + animDur)}),(t-${fmt(S)})/${fmt(animDur)},1)` : '1';
        const aOut = txt.animOut === 'fade' ? `if(gt(t,${fmt(E - 0.4)}),1-(t-${fmt(E - 0.4)})/0.4,1)` : '1';
        if (animIn === 'fade' || animIn === 'pop' || txt.animOut === 'fade') alpha = `${fmt(baseAlpha)}*${fadeIn}*${aOut}`;
        let fsExpr = `${fsPx}`;
        if (animIn === 'pop') fsExpr = `${fsPx}*(0.7+0.3*min(1,(t-${fmt(S)})/${fmt(animDur)}))`;
        const cs = txt.captionStyle || {};
        const fontColorHex = cs.preset === 'karaoke' ? (cs.color || '#facc15') : (txt.color || '#ffffff');
        let dt = `drawtext=fontfile=${font}:textfile='${filePath}':fontsize='${fsExpr}':fontcolor=${escColor(fontColorHex)}:x='${xExpr}':y='${yExpr}':alpha='${alpha}':enable='between(t,${fmt(S)},${fmt(E)})'`;
        if (txt.bgColor) dt += `:box=1:boxcolor=${escColor(txt.bgColor)}@0.85:boxborderw=12`;
        else if (cs.preset === 'highlight') dt += `:box=1:boxcolor=${escColor(cs.highlight || '#facc15')}@0.85:boxborderw=12`;
        if (txt.shadow && txt.shadow.enabled) {
          dt += `:shadowcolor=${escColor(txt.shadow.color || '#000000')}:shadowx=${Math.round(num(txt.shadow.dx, 2))}:shadowy=${Math.round(num(txt.shadow.dy, 2))}`;
        } else if (cs.preset === 'glow' || cs.glow) {
          dt += ':shadowcolor=0xffffff:shadowx=3:shadowy=3';
        }
        if (txt.stroke && txt.stroke.enabled) {
          dt += `:borderw=${Math.round(num(txt.stroke.width, 2))}:bordercolor=${escColor(txt.stroke.color || '#000000')}`;
        } else if (cs.preset === 'bold') {
          dt += ':borderw=2:bordercolor=0x000000';
        }
        const lh = num(txt.lineHeight, 1.2);
        if (lh !== 1.2) dt += `:line_spacing=${Math.max(0, Math.round(fsPx * (lh - 1.2)))}`;
        const out = `tx${segCounter++}`;
        filterParts.push(`[${curLabel}]${dt}[${out}]`);
        curLabel = out;
      }
    }
    filterParts.push(`[${curLabel}]fps=${fps},setsar=1,format=${finalFmt}[vout]`);
  }

  // --- Audio (both modes).
  buildAudioMix();

  const args = ['-y', '-v', 'info'];
  for (const inp of inputs) args.push(...inp.args);
  args.push('-filter_complex', filterParts.join(';'));
  let expected;
  if (audioOnly) {
    if (!audioLabel) throw new Error('This timeline has no audio to export — add an audio clip first.');
    args.push('-map', `[${audioLabel}]`);
    if (settings.audioFormat === 'wav') args.push('-c:a', 'pcm_s16le');
    else args.push('-c:a', 'libmp3lame', '-b:a', `${Math.round(num(settings.audioBitrateKbps, 192))}k`);
    args.push('-t', fmt(total));
    expected = { width: null, height: null, fps, duration: total, hasAudio: true, audioOnly: true };
  } else {
    args.push('-map', '[vout]');
    if (audioLabel) args.push('-map', `[${audioLabel}]`);
    const format = settings.format || 'mp4';
    const hdr = !!settings.hdr;
    let vcodec = 'libx264';
    if (format === 'webm') vcodec = 'libvpx-vp9';
    else if (hdr || settings.codec === 'hevc') vcodec = 'libx265';
    args.push('-c:v', vcodec);
    if (vcodec === 'libvpx-vp9') args.push('-deadline', 'good', '-cpu-used', '4');
    else args.push('-preset', 'veryfast');
    if (settings.bitrateKbps) {
      const k = Math.round(num(settings.bitrateKbps, 0));
      args.push('-b:v', `${k}k`, '-maxrate', `${k}k`, '-bufsize', `${k * 2}k`);
    } else {
      args.push('-crf', String(crfFor(settings, vcodec === 'libvpx-vp9' ? 'libvpx' : vcodec)));
    }
    args.push('-pix_fmt', hdr ? 'yuv420p10le' : 'yuv420p', '-r', String(fps));
    if (audioLabel) args.push('-c:a', format === 'webm' ? 'libopus' : 'aac', '-b:a', `${Math.round(num(settings.audioBitrateKbps, 128))}k`);
    if (format === 'mp4' || format === 'mov') args.push('-movflags', '+faststart');
    args.push('-t', fmt(renderedDur));
    expected = { width: W, height: H, fps, duration: renderedDur, hasAudio: Boolean(audioLabel) };
  }

  return {
    args, inputs,
    expected,
    textFiles, totalDuration: audioOnly ? total : renderedDur,
    warnings,
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

// ---------------------------------------------------------------------------
// Job pre-passes + worker
// ---------------------------------------------------------------------------

// Run one ffmpeg command to completion (used by the pre-passes and the
// frame/GIF post-steps). Rejects with the tail of FFmpeg's stderr.
function runFfmpeg(args, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (d) => { tail = (tail + d.toString()).slice(-4000); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`FFmpeg timed out after ${Math.round(timeoutMs / 1000)}s. ${tail.slice(-500)}`));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`Could not start FFmpeg: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg exited with code ${code}. ${tail.split('\n').filter(Boolean).slice(-5).join(' ').slice(0, 1000)}`));
    });
  });
}

// Stabilisation, two-pass (#8). The .trf is indexed by source frame, so
// the stabilised SOURCE is rendered once (cached per media+strength) and
// the clip then renders from it like any normal source — curves, reverse
// and freeze all still work on it. Still images are returned unchanged
// (there is nothing to stabilise) and the caller marks them handled.
async function stabilizedSourcePath(media, strength) {
  const dir = stabCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const size = fs.existsSync(media.filePath) ? fs.statSync(media.filePath).size : 0;
  const key = crypto.createHash('sha1').update(`${media.filePath}:${size}:${Math.round(strength * 100)}`).digest('hex').slice(0, 16);
  const outPath = path.join(dir, `${key}.mp4`);
  const trfPath = path.join(dir, `${key}.trf`);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outPath;
  const shakiness = Math.max(1, Math.min(10, Math.round(1 + num(strength, 0.5) * 9)));
  const smoothing = Math.round(5 + num(strength, 0.5) * 25);
  if (!fs.existsSync(trfPath) || fs.statSync(trfPath).size === 0) {
    await runFfmpeg(['-y', '-v', 'error', '-i', media.filePath,
      '-vf', `format=yuv420p,vidstabdetect=shakiness=${shakiness}:accuracy=15:result=${trfPath}`,
      '-f', 'null', '-']);
  }
  await runFfmpeg(['-y', '-v', 'error', '-i', media.filePath,
    '-vf', `vidstabtransform=input=${trfPath}:smoothing=${smoothing}:optzoom=1:crop=keep,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'copy', outPath]);
  return outPath;
}

// Render a compound clip's nested timeline to a temp file (recursive).
async function renderCompoundClip(nested, userId, tmpDir, depth) {
  if (depth > 3) throw new Error('Compound clips nest at most 3 deep.');
  const prep = await prepareTimelineSources(nested, userId, tmpDir, depth, { resolution: '720p', fps: nested.fps || 30 });
  const ctmp = path.join(tmpDir, `compound-tmp-${uid('c')}`);
  fs.mkdirSync(ctmp, { recursive: true });
  const outPath = path.join(tmpDir, `compound-${uid('c')}.mp4`);
  const plan = buildRenderPlan({
    timeline: nested, mediaById: prep.mediaById,
    settings: { resolution: '720p', fps: nested.fps || 30 },
    tmpDir: ctmp,
    extras: { lutPaths: prep.lutPaths, motionX: prep.motionX, stabilized: prep.stabilized, textPngs: prep.textPngs },
  });
  await runFfmpeg([...plan.args, outPath], { timeoutMs: 600000 });
  const chk = await validateRenderedOutput(outPath, plan.expected, { format: 'mp4', codec: 'h264' });
  if (!chk.ok) throw new Error(`Compound clip render failed: ${chk.problems.join(' ')}`);
  return outPath;
}

// Resolve every media file a timeline needs and run the async pre-passes:
// compound clips, stabilised sources, auto-reframe centroids, LUT paths,
// colour-emoji text PNGs. Returns
// { mediaById, lutPaths, motionX, stabilized, textPngs, textPngWarnings }.
async function prepareTimelineSources(timeline, userId, tmpDir, depth = 0, settings = {}) {
  const mediaById = {};
  const lutPaths = {};
  const motionX = {};
  const stabilized = {};
  const mediaIds = new Set();
  const bgMediaIds = new Set();
  const collect = (tl) => {
    for (const c of vm.allClips(tl)) {
      if (c.mediaId) mediaIds.add(c.mediaId);
      if (c.lutMediaId != null) mediaIds.add(c.lutMediaId);
      if (c.kind === 'compound' && c.nested) collect(c.nested);
    }
    const bg = tl.background;
    if (bg && typeof bg === 'object' && (bg.type === 'image' || bg.type === 'blur') && bg.mediaId != null) {
      bgMediaIds.add(bg.mediaId);
    }
  };
  collect(timeline);
  // Compound clips render first (recursive).
  for (const c of vm.allClips(timeline)) {
    if (c.kind === 'compound' && c.nested) {
      const subPath = await renderCompoundClip(c.nested, userId, tmpDir, depth + 1);
      const probe = await probeMedia(subPath);
      mediaById[`compound:${c.id}`] = { filePath: subPath, probe, kind: 'video' };
    }
  }
  for (const id of new Set([...mediaIds, ...bgMediaIds])) {
    const row = db.getMedia(userId, id);
    if (!row) throw new Error(`Media file #${id} is missing (it may have been deleted). Re-add it to the timeline.`);
    const filePath = path.join(config.uploadsDir, String(userId), row.stored_name);
    if (!fs.existsSync(filePath)) throw new Error(`Media file "${row.original_name}" is missing on disk.`);
    const probe = await probeMedia(filePath);
    mediaById[id] = { filePath, probe, kind: row.kind };
  }
  // LUTs (#7).
  for (const c of vm.allClips(timeline)) {
    if (c.lutMediaId != null) {
      const m = mediaById[c.lutMediaId];
      if (!m) throw new Error(`LUT file #${c.lutMediaId} for clip "${c.name}" is missing.`);
      if (!/\.(cube|3dl)$/i.test(m.filePath)) {
        throw new Error(`LUT file for clip "${c.name}" is not a .CUBE or .3DL file.`);
      }
      lutPaths[c.id] = m.filePath;
    }
  }
  // Stabilisation (#8) — source pre-pass, cached per media+strength.
  for (const c of vm.allClips(timeline)) {
    if (c.kind !== 'video' && c.kind !== 'compound') continue;
    if (!(c.stabilize && c.stabilize.enabled)) continue;
    const srcKey = c.kind === 'compound' ? `compound:${c.id}` : c.mediaId;
    const m = mediaById[srcKey];
    if (!m) throw new Error(`Media for clip "${c.name}" is missing (stabilisation needs the source).`);
    if (!m.probe || !m.probe.hasVideo) {
      // A still image has no motion to stabilise; the original file is
      // the stabilised source.
      mediaById[`stab:${c.id}`] = m;
      stabilized[c.id] = true;
      continue;
    }
    const stabPath = await stabilizedSourcePath(m, num(c.stabilize.strength, 0.5));
    const probe = await probeMedia(stabPath);
    mediaById[`stab:${c.id}`] = { filePath: stabPath, probe, kind: 'video' };
    stabilized[c.id] = true;
  }
  // Auto-reframe centroids (#18) — the Shorts motion-centroid approach.
  for (const c of vm.allClips(timeline)) {
    if (!(c.autoReframe && c.autoReframe.enabled)) continue;
    const srcKey = c.kind === 'compound' ? `compound:${c.id}` : c.mediaId;
    const m = mediaById[srcKey] || mediaById[c.mediaId];
    if (m && m.probe && m.probe.hasVideo) {
      try {
        const mx = await motionCentroid(m.filePath, c.srcStart || 0,
          (c.srcStart || 0) + Math.max(0.5, (c.duration || 2) * num(c.speed, 1)));
        if (mx != null) motionX[c.id] = mx;
      } catch { /* centroid failure: the renderer centres on 0.5 */ }
    }
  }
  // Colour emoji text (#38): pre-render emoji text clips to transparent
  // PNGs with Pillow (libass/drawtext cannot do colour emoji — verified
  // live). A failed pre-render does NOT fail the job: the clip falls
  // back to the ASS path (monochrome/tofu, as before) and the reason is
  // logged as a warning by the caller.
  const textPngs = {};
  const textPngWarnings = [];
  {
    const dims = (settings.width && settings.height)
      ? { width: settings.width, height: settings.height }
      : vm.outputDims(timeline, settings.resolution || '720p');
    for (const c of vm.allClips(timeline)) {
      if (c.kind !== 'text' || !c.text || !EMOJI_RE.test(String(c.text.text || ''))) continue;
      try {
        const png = await renderEmojiTextPng({ clip: c, W: dims.width, H: dims.height, tmpDir });
        textPngs[c.id] = png;
      } catch (e) {
        textPngWarnings.push(`Colour emoji for clip "${c.name}" could not be pre-rendered (${e.message}) — falling back to monochrome text.`);
      }
    }
  }
  return { mediaById, lutPaths, motionX, stabilized, textPngs, textPngWarnings };
}

// Validate a rendered video against the plan (codec-aware: h264 / hevc /
// vp9, and 10-bit pix_fmt for HDR). ffprobe-based, no guessing.
async function validateRenderedOutput(outPath, expected, settings) {
  const info = await probeMedia(outPath);
  if (!info) return { ok: false, problems: ['ffprobe could not read the rendered file.'], info: null };
  const problems = [];
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
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
  const want = settings.format === 'webm' ? 'vp9'
    : ((settings.hdr || settings.codec === 'hevc') ? 'hevc' : 'h264');
  if (info.codec && info.codec !== want) problems.push(`Video codec is ${info.codec}, expected ${want}.`);
  if (settings.hdr) {
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', outPath]);
      const pix = String(stdout || '').trim().split('\n')[0];
      if (pix && pix !== 'yuv420p10le') problems.push(`Pixel format is ${pix}, expected yuv420p10le for HDR.`);
    } catch { /* pix_fmt check is best-effort */ }
  }
  return { ok: problems.length === 0, problems, info };
}

async function validateAudioOutput(outPath, expected) {
  const info = await probeMedia(outPath);
  if (!info) return { ok: false, problems: ['ffprobe could not read the rendered audio.'], info: null };
  const problems = [];
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    problems.push('Rendered audio is missing or empty.');
  }
  if (!info.hasAudio) problems.push('Rendered file has no audio stream.');
  if (expected.duration !== undefined && info.durationSeconds !== null) {
    if (Math.abs(info.durationSeconds - expected.duration) > 0.75) {
      problems.push(`Duration is ${info.durationSeconds.toFixed(2)}s, expected ${expected.duration.toFixed(2)}s.`);
    }
  }
  return { ok: problems.length === 0, problems, info };
}

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

function collectFontFamilies(timeline, out = new Set()) {
  for (const c of vm.allClips(timeline)) {
    if (c.kind === 'text' && c.text && c.text.fontFamily) out.add(c.text.fontFamily);
    if (c.kind === 'compound' && c.nested) collectFontFamilies(c.nested, out);
  }
  return out;
}

// Run the main render ffmpeg process with progress + watchdog. Resolves
// 'done' or 'cancelled'; rejects on ffmpeg failure or watchdog timeout.
function runMainRender(plan, outPath, job, logPath, total, entry) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [...plan.args, outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    entry.child = child;
    // v2.4.0 — watchdog: a corrupt or undecodable input (e.g. a broken
    // image with -loop 1, which FFmpeg retries forever) used to keep
    // FFmpeg alive indefinitely and brick the single-slot queue, so
    // every later render stayed queued forever. Kill it after a generous
    // duration-based limit and fail this job honestly instead. The limit
    // is 30x the video length (worst observed render speed is ~0.06x
    // realtime ≈ 17x, so 30x leaves headroom) with a 10-minute floor;
    // RENDER_WATCHDOG_MS overrides it (used by tests).
    const watchdogMs = parseInt(process.env.RENDER_WATCHDOG_MS || '', 10)
      || Math.max(600_000, Math.ceil(total * 30) * 1000);
    const watchdog = setTimeout(() => {
      appendLog(logPath, `\nRender watchdog: FFmpeg exceeded ${Math.round(watchdogMs / 60000)} min for a ${total}s render — killing it. The source media may be corrupt.\n`);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`Render timed out after ${Math.round(watchdogMs / 60000)} minutes (expected ~${total}s of video). The source media may be corrupt — try re-uploading it.`));
    }, watchdogMs);
    if (watchdog.unref) watchdog.unref();
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
    child.on('error', (err) => { clearTimeout(watchdog); reject(new Error(`Could not start FFmpeg: ${err.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(watchdog);
      if (entry.cancelled) return resolve('cancelled');
      if (code === 0) return resolve('done');
      const lastLines = tail.split('\n').filter(Boolean).slice(-8).join(' ');
      reject(new Error(`FFmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ''}. ${lastLines.slice(0, 1000)}`));
    });
  });
}

async function processJob(job) {
  const payload = JSON.parse(job.payload || '{}');
  const timeline = payload.timeline;
  const settings = payload.settings || {};
  const userId = job.user_id;
  const dir = rendersDirFor(userId);
  const format = settings.format || 'mp4';
  let ext = format;
  if (settings.audioOnly) ext = settings.audioFormat === 'wav' ? 'wav' : 'mp3';
  else if (settings.frameExport) ext = 'jpg';
  else if (settings.gifExport) ext = 'gif';
  const outPath = path.join(dir, `${job.id}.${ext}`);
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
  const shortsFinished = (status, extra) => {
    try {
      const r = require('./shorts').onShortsJobFinished(job, status, extra || {});
      if (r && typeof r.catch === 'function') r.catch(() => { /* shorts runner handles its own errors */ });
    } catch { /* bookkeeping must never break a render */ }
  };
  bulkStarted();
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
    // Fonts first (#14): download the text fonts the timeline uses, so
    // the render uses the font the user picked. A failed download falls
    // back to DejaVu and is logged honestly — never silently.
    for (const fam of collectFontFamilies(timeline)) {
      try {
        const p = await ensureFont(fam, 700);
        if (p) appendLog(logPath, `Font ready: ${fam} -> ${p}\n`);
        else appendLog(logPath, `Font "${fam}" is not available (unknown family or download failed) — falling back to DejaVu.\n`);
      } catch (e) {
        appendLog(logPath, `Font download for "${fam}" failed: ${e.message} — falling back to DejaVu.\n`);
      }
    }
    // Async pre-passes: compound clips, stabilised sources, reframe
    // centroids, LUT paths, colour-emoji text PNGs.
    const prep = await prepareTimelineSources(timeline, userId, tmpDir, 0, settings);
    const plan = buildRenderPlan({
      timeline, mediaById: prep.mediaById, settings, tmpDir,
      extras: { lutPaths: prep.lutPaths, motionX: prep.motionX, stabilized: prep.stabilized, textPngs: prep.textPngs },
    });
    for (const w of plan.warnings || []) appendLog(logPath, `Warning: ${w}\n`);
    for (const w of prep.textPngWarnings || []) appendLog(logPath, `Warning: ${w}\n`);
    appendLog(logPath, `ffmpeg ${plan.args.join(' ')}\n`);
    const total = plan.totalDuration;
    // Frame/GIF exports render the video first, then extract/convert.
    let videoPath = outPath;
    if ((settings.frameExport || settings.gifExport) && !settings.audioOnly) {
      const vExt = format === 'webm' ? 'webm' : format === 'mov' ? 'mov' : 'mp4';
      videoPath = path.join(dir, `${job.id}.video.${vExt}`);
    }
    const result = await runMainRender(plan, videoPath, job, logPath, total, entry);
    if (result === 'cancelled' || entry.cancelled) {
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
      try { if (videoPath !== outPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch { /* ignore */ }
      db.updateJob(job.id, { status: 'cancelled', progress: 0, error: 'Render cancelled.' });
      db.audit(userId, 'render_cancelled', 'job', job.id, `Render job ${job.id} cancelled`);
      bulkFinished('cancelled');
      shortsFinished('cancelled');
      return;
    }
    if (settings.audioOnly) {
      const chk = await validateAudioOutput(videoPath, plan.expected);
      if (!chk.ok) throw new Error(`Render validation failed: ${chk.problems.join(' ')}`);
    } else {
      const chk = await validateRenderedOutput(videoPath, plan.expected, settings);
      if (!chk.ok) throw new Error(`Render validation failed: ${chk.problems.join(' ')}`);
    }
    if (settings.frameExport && !settings.audioOnly) {
      const atRaw = settings.frameExport && typeof settings.frameExport === 'object' ? settings.frameExport.at : null;
      const at = Math.max(0, Math.min(total - 0.1, num(atRaw, total / 2)));
      await runFfmpeg(['-y', '-v', 'error', '-ss', String(at), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outPath]);
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
        throw new Error('Frame extraction produced no image.');
      }
      appendLog(logPath, `Cover frame extracted at ${at.toFixed(2)}s -> ${outPath}\n`);
      try { fs.unlinkSync(videoPath); } catch { /* ignore */ }
      db.updateJob(job.id, { output_path: outPath });
    } else if (settings.gifExport && !settings.audioOnly) {
      const gifDur = Math.min(total, 10);
      const palPath = path.join(tmpDir, 'palette.png');
      await runFfmpeg(['-y', '-v', 'error', '-i', videoPath, '-t', String(gifDur),
        '-vf', 'fps=15,scale=640:-1:flags=lanczos,palettegen', palPath]);
      await runFfmpeg(['-y', '-v', 'error', '-i', videoPath, '-i', palPath, '-t', String(gifDur),
        '-lavfi', 'fps=15,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse', outPath]);
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
        throw new Error('GIF export produced no file.');
      }
      appendLog(logPath, `GIF exported (${gifDur}s, 640px wide) -> ${outPath}\n`);
      try { fs.unlinkSync(videoPath); } catch { /* ignore */ }
      db.updateJob(job.id, { output_path: outPath });
    }
    db.updateJob(job.id, { status: 'done', progress: 100 });
    const desc = settings.audioOnly
      ? `Rendered audio-only (${settings.audioFormat || 'mp3'}), ${plan.expected.duration.toFixed(1)}s`
      : `Rendered ${plan.expected.width}x${plan.expected.height} @ ${plan.expected.fps}fps, ${plan.expected.duration.toFixed(1)}s (${format.toUpperCase()}${settings.codec === 'hevc' || settings.hdr ? '/HEVC' : ''}${settings.hdr ? '/HDR' : ''}${settings.frameExport ? ', frame' : ''}${settings.gifExport ? ', GIF' : ''})`;
    credits.chargeCredits(userId, 'render', desc);
    db.audit(userId, 'render_done', 'job', job.id, desc);
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

module.exports = {
  buildRenderPlan, fontFor, ensureFont, fontsDir, effectFilter,
  RENDERS_DIR, CONCURRENCY,
  startRenderQueue, cancelJob, processJob, rendersDirFor,
  runFfmpeg, stabilizedSourcePath, prepareTimelineSources, renderCompoundClip,
  validateRenderedOutput, validateAudioOutput,
  renderEmojiTextPng, emojiFontPath,
};
