'use strict';
// Captions (Phase 6) — manual transcripts + SRT/VTT, with honest timing.
// Two paths, both real:
//   (a) STT transcription via a provider — NO key exists yet, so the API
//       refuses with key_needed (see routes/shorts.js). Never faked.
//   (b) Manual transcript, which works NOW: the user pastes/uploads a
//       transcript as plain text or as SRT/VTT. Plain text has no
//       timestamps, so lines are distributed across the video by character
//       count and labelled timing: 'estimated'; SRT/VTT cues keep their own
//       timestamps (timing: 'exact'). Words inside a cue are distributed
//       by character length — also estimated, and labelled as such.
// Burn-in uses an ASS file + the libass `subtitles` filter (proper shaping
// for Arabic/Urdu/Devanagari, which drawtext cannot do), with karaoke
// (\k) tags for word-by-word highlight. SRT/VTT export is line-level.
const SUPPORTED_LANGUAGES = [
  { id: 'en', label: 'English', font: 'DejaVu Sans', script: 'latin' },
  { id: 'ur', label: 'Urdu', font: 'Noto Naskh Arabic', script: 'arabic' },
  { id: 'roman-ur', label: 'Roman Urdu', font: 'DejaVu Sans', script: 'latin' },
  { id: 'ar', label: 'Arabic', font: 'Noto Naskh Arabic', script: 'arabic' },
  { id: 'hi', label: 'Hindi', font: 'Noto Sans Devanagari', script: 'devanagari' },
];

function languageMeta(id) {
  return SUPPORTED_LANGUAGES.find((l) => l.id === id) || SUPPORTED_LANGUAGES[0];
}
function isRtl(language) {
  return languageMeta(language).script === 'arabic';
}

function parseSrtTime(s) {
  const m = String(s || '').trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
}
function parseVttTime(s) {
  const m = String(s || '').trim().match(/(?:(\d+):)?(\d+):(\d+)\.(\d+)/);
  if (!m) return null;
  return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
}

function parseTimedText(text, format) {
  // Parses SRT or VTT into [{start, end, text}]. Returns { cues, errors }.
  const isVtt = format === 'vtt';
  const parseTime = isVtt ? parseVttTime : parseSrtTime;
  const blocks = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\s*\n/);
  const cues = [];
  const errors = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (isVtt && lines[0].toUpperCase().startsWith('WEBVTT')) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0])) i = 1; // SRT cue number
    if (i >= lines.length) continue;
    const timeLine = lines[i];
    const tm = timeLine.match(/([0-9:.,]+)\s*-->\s*([0-9:.,]+)/);
    if (!tm) { errors.push(`Skipped a block with no timestamp: "${timeLine.slice(0, 60)}"`); continue; }
    const start = parseTime(tm[1]);
    const end = parseTime(tm[2]);
    if (start === null || end === null || end <= start) {
      errors.push(`Skipped a cue with an invalid time range: "${timeLine.slice(0, 60)}"`);
      continue;
    }
    const cueText = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!cueText) continue;
    cues.push({ start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100, text: cueText });
  }
  cues.sort((a, b) => a.start - b.start);
  return { cues, errors };
}

// Plain text -> cues distributed across the video by character count.
// Each line (or sentence) becomes a cue; timing is ESTIMATED.
function distributePlainText(text, durationSeconds, { minCueSeconds = 1.2 } = {}) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n').split('\n')
    .flatMap((l) => l.split(/(?<=[.!?؟۔])\s+/))
    .map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !durationSeconds || durationSeconds <= 0) return [];
  const totalChars = lines.reduce((s, l) => s + l.length, 0);
  const cues = [];
  let cursor = 0;
  for (const line of lines) {
    const share = Math.max(minCueSeconds, (line.length / totalChars) * durationSeconds);
    const start = Math.round(cursor * 100) / 100;
    const end = Math.round(Math.min(durationSeconds, cursor + share) * 100) / 100;
    if (end > start) cues.push({ start, end, text: line });
    cursor += share;
  }
  return cues;
}

// Normalise + validate a cue list against a duration: sort, clamp, drop
// empties and zero-length cues, trim overlaps (a cue never starts before
// the previous one ends). Returns { cues, warnings }.
function normaliseCues(cues, durationSeconds) {
  const warnings = [];
  const sorted = [...(cues || [])]
    .map((c) => ({ start: Number(c.start), end: Number(c.end), text: String(c.text || '').trim() }))
    .filter((c) => c.text && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of sorted) {
    const start = Math.max(0, Math.round(c.start * 100) / 100);
    let end = Math.round(c.end * 100) / 100;
    if (durationSeconds) end = Math.min(end, Math.round(durationSeconds * 100) / 100);
    if (end <= start) { warnings.push(`Dropped a cue outside the video: "${c.text.slice(0, 40)}"`); continue; }
    if (out.length && start < out[out.length - 1].end) {
      warnings.push(`Trimmed an overlapping cue: "${c.text.slice(0, 40)}"`);
      if (start >= out[out.length - 1].end) continue;
      out[out.length - 1].end = start;
      if (out[out.length - 1].end <= out[out.length - 1].start) out.pop();
    }
    out.push({ start, end, text: c.text });
  }
  return { cues: out, warnings };
}

// Words inside one cue, distributed by character length (estimated timing).
function wordsForCue(cue) {
  const words = String(cue.text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const totalChars = words.reduce((s, w) => s + w.length, 0) || 1;
  const span = cue.end - cue.start;
  let cursor = cue.start;
  return words.map((w, i) => {
    const share = (w.length / totalChars) * span;
    const start = Math.round(cursor * 100) / 100;
    const end = Math.round((i === words.length - 1 ? cue.end : cursor + share) * 100) / 100;
    cursor += share;
    return { text: w, start, end };
  });
}

function fmtSrtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const r = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${r}`;
}
function fmtVttTime(t) {
  return fmtSrtTime(t).replace(',', '.');
}

function toSRT(cues) {
  return (cues || []).map((c, i) =>
    `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${c.text}\n`).join('\n');
}
function toVTT(cues) {
  return 'WEBVTT\n\n' + (cues || []).map((c) =>
    `${fmtVttTime(c.start)} --> ${fmtVttTime(c.end)}\n${c.text}\n`).join('\n');
}

// ASS subtitle text for burn-in. Karaoke \k tags (centiseconds) highlight
// each word as it is "spoken". libass shapes Arabic/Urdu/Devanagari
// correctly; drawtext cannot, which is why ASS is used here.
function assEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}
function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const r = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(2, '0')}`;
}

function buildAss(cues, { language = 'en', outWidth = 1080, outHeight = 1920, timeOffset = 0 } = {}) {
  const meta = languageMeta(language);
  const scale = outWidth / 1080;
  const fontSize = Math.max(28, Math.round(64 * scale));
  const marginV = Math.max(48, Math.round(140 * scale));
  const styleFont = meta.font;
  const lines = [];
  lines.push('[Script Info]');
  lines.push('ScriptType: v4.00+');
  lines.push(`PlayResX: ${outWidth}`);
  lines.push(`PlayResY: ${outHeight}`);
  lines.push('WrapStyle: 0');
  lines.push('ScaledBorderAndShadow: yes');
  lines.push('');
  lines.push('[V4+ Styles]');
  lines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
  // Primary = white, Secondary (karaoke highlight) = yellow, Back = translucent black box.
  lines.push(`Style: Default,${styleFont},${fontSize},&H00FFFFFF,&H0000D8FF,&H00000000,&HCC000000,1,0,0,0,100,100,0,0,1,3,0,2,60,60,${marginV},1`);
  lines.push('');
  lines.push('[Events]');
  lines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');
  for (const cue of cues || []) {
    const start = Math.max(0, cue.start - timeOffset);
    const end = Math.max(0, cue.end - timeOffset);
    if (end <= start) continue;
    const words = wordsForCue({ ...cue, start, end });
    // Word-by-word karaoke: each word highlighted for its own duration.
    // RTL scripts: keep the visual word order as written; libass shapes
    // and orders the line correctly for the script.
    const text = words.map((w) => {
      const durCs = Math.max(1, Math.round((w.end - w.start) * 100));
      return `{\\k${durCs}}${assEscape(w.text)}`;
    }).join(' ');
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
  }
  return lines.join('\n') + '\n';
}

// Cues overlapping a clip window [start, end], shifted so the clip starts
// at t=0. Used when rendering one Short from a job-level transcript.
function cuesForClip(cues, start, end) {
  const out = [];
  for (const c of cues || []) {
    if (c.end <= start || c.start >= end) continue;
    const s = Math.max(0, Math.round((c.start - start) * 100) / 100);
    const e = Math.round((Math.min(c.end, end) - start) * 100) / 100;
    if (e > s) out.push({ start: s, end: e, text: c.text });
  }
  return out;
}

module.exports = {
  SUPPORTED_LANGUAGES, languageMeta, isRtl,
  parseTimedText, distributePlainText, normaliseCues, wordsForCue,
  toSRT, toVTT, buildAss, cuesForClip, fmtSrtTime, fmtVttTime,
};
