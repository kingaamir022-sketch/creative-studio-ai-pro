'use strict';
// Quiz Video template model (Phase 4 preset).
// A quiz Short is built from spreadsheet rows — one row = one question —
// into a real Phase 3 timeline (9:16) that the FFmpeg renderer renders.
//
// RESEARCH SPEC (defaults — user-changeable; see README §Quiz):
//   Source: "Best Quiz Video Design Spec" (research 2026-11-12,
//   ~/workspace/research_notes/best-quiz-video-editors-research-20261112-1159/report.md),
//   synthesised from Videotto, Velosofy, GhostShorts, Versely, Clippie,
//   MakeViral and the bundle.social safe-zone checker. The top channels'
//   exact fonts/px/colours were NOT frame-audited — these numbers are
//   guide/template defaults, not measured facts.
//   1080x1920, 9:16, 30fps, 5 questions. Hook = first question in frame 1
//   (0-1s), no title card. Per question ~7s: ~2s read + 3s countdown
//   (identical every question, never <3s or >6s) + 1-2s reveal, then a 3s
//   score card ("Kitne sahi hue? Comment mein score likho").
//   Layout: question centred in the middle band; 4 options as a full-width
//   STACKED list (2x2 grid only for image tiles); one timer style per video
//   (load-bar, the top-channel default). Safe box x48-888, y288-1248
//   (strict intersection of TikTok/Reels/Shorts safe zones) — nothing
//   essential outside it. Typography: heavy bold sans; question cap height
//   ~90-130px, options ≥54-60px cap height, max 2 lines, contrast ≥4.5:1.
//   Colours: deep navy #14213D + white bold text + one amber accent #FCA311.
//   Correct = highlight + tick (never colour alone — always tick/cross +
//   label); wrong = fade/dim + cross. Difficulty ramp easy/easy/medium/
//   hard/hardest-last. Hard caps: question ≤80 chars / <12 words, options
//   ≤22 chars — over-cap text gets a "Needs attention" warning FIRST, then
//   the uniform-shrink safety net (never below the readable minimum).
//   RTL: mirrored layout + linear bar (ring stays clockwise), Noto Kufi/
//   Sans Arabic, line-height ≥1.5, zero letter-spacing.
//
// Decisions where the research spec and the user's earlier rules differ:
//   - Correct-option highlight stays GREEN (#16a34a) per the user's rule;
//     amber is the template accent (countdown bar, chip, score card).
//   - 5 questions at the 3s-countdown default run ≈38s, not 45-60s — the
//     report's 45-60s assumes 5s countdowns. 60s+ needs 8 questions or a
//     5-6s countdown (both are settings).
//
// Round structure (per question):
//   Read (~2s) — question + options on screen, full timer bar
//   Countdown (3s) — load-bar drains, 3-2-1, identical every question
//   Reveal (2s) — correct option green + ✓ (pulse/fade), wrong dim + ✗,
//     one-line explanation
//   Score card (3s, once at the end) — "Kitne sahi hue? Comment mein score likho"
// Single-question video = 10s; multi-question (5) = 38s, easiest first,
// hardest last, 9:16 vertical, everything inside the safe box.
//
// AUTO-FIT: fitText() is the single source of truth for sizing. The server
// uses it to build the timeline (font sizes + wrapped lines) and the browser
// preview asks the server (/api/bulk/quiz/fit) for the same numbers, so
// preview and render can never disagree.
//
// Honest limits: no AI-generated questions (LLM is Phase 7) — questions
// always come from the user's spreadsheet. Narration: recorded audio works
// now (NARRATION_AUDIO column); AI/cloned speech needs a voice provider key
// (src/voice.js) and refuses honestly without one — never a fake voice.

const QUIZ_SPEC = {
  width: 1080, height: 1920, fps: 30, questionsPerVideo: 5,
  readSeconds: 2, timerSeconds: 3, revealSeconds: 2, scoreSeconds: 3,
  timerMin: 3, timerMax: 6,
  // Strict safe box (TikTok/Reels/Shorts intersection) at 1080x1920.
  safeBox: { x: 48, y: 288, w: 840, h: 960 },
  background: '#14213D', accent: '#FCA311',
  correctFill: '#16a34a', correctBorder: '#4ade80',
  maxQuestionChars: 80, maxQuestionWords: 12, maxOptionChars: 22,
  source: 'Best Quiz Video Design Spec (research 2026-11-12): Videotto, Velosofy, GhostShorts, Versely, Clippie, MakeViral; safe zones bundle.social. Numbers are guide/template defaults, not frame-audited measurements.',
};

// Safe box scaled to any output size (from the 1080x1920 spec box).
function safeBoxFor(W, H) {
  const s = QUIZ_SPEC.safeBox;
  return {
    x: Math.round(s.x * (W / 1080)),
    y: Math.round(s.y * (H / 1920)),
    w: Math.round(s.w * (W / 1080)),
    h: Math.round(s.h * (H / 1920)),
  };
}

// RTL detection (Arabic/Hebrew ranges) — drives the mirrored layout.
const RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
function isRtl(text) { return RTL_RE.test(String(text || '')); }

// Hard text caps (research spec §3): question ≤80 chars / <12 words,
// options ≤22 chars. Over-cap text is warned about FIRST ("Needs attention")
// and only then shrunk by the uniform-fit safety net.
function checkCaps(question, optionTexts) {
  const qChars = String(question || '').trim().length;
  const qWords = String(question || '').trim().split(/\s+/).filter(Boolean).length;
  const messages = [];
  if (qChars > QUIZ_SPEC.maxQuestionChars) messages.push(`Question is ${qChars} characters (recommended max ${QUIZ_SPEC.maxQuestionChars}) — shorten it so it reads in 2 seconds.`);
  if (qWords >= QUIZ_SPEC.maxQuestionWords) messages.push(`Question is ${qWords} words (recommended under ${QUIZ_SPEC.maxQuestionWords}) — shorten it so it reads in 2 seconds.`);
  let maxOptionChars = 0;
  optionTexts.forEach((t, i) => {
    const n = String(t || '').trim().length;
    if (n > maxOptionChars) maxOptionChars = n;
    if (n > QUIZ_SPEC.maxOptionChars) messages.push(`Option ${String.fromCharCode(65 + i)} is ${n} characters (recommended max ${QUIZ_SPEC.maxOptionChars}) — use 1-3 words.`);
  });
  return { questionChars: qChars, questionWords: qWords, maxOptionChars, exceeded: messages.length > 0, messages };
}


const QUIZ_COLUMNS = [
  'QUESTION', 'OPTION_A', 'OPTION_B', 'OPTION_C', 'OPTION_D', 'CORRECT',
  'EXPLANATION', 'CATEGORY', 'DIFFICULTY', 'TIMER_SECONDS', 'QUESTION_IMAGE',
  'NARRATION_AUDIO', 'VOICE',
];

const DIFFICULTY_RANK = { easy: 0, medium: 1, hard: 2, hardest: 3 };

// --- Text measurement (render pixels, DejaVu/Poppins-ish metrics) -----------
// The estimator is deliberately CONSERVATIVE (over-estimates widths, plus an
// 8% safety margin in fitText): DejaVu Bold — the font FFmpeg actually
// renders with — is wider than the Poppins the browser preview uses, so a
// line that fits here is guaranteed to fit in the render.
function charWidth(ch, fontSize) {
  if (ch === ' ') return 0.30 * fontSize;
  if ('ilj.,:;\'|!'.includes(ch)) return 0.32 * fontSize;
  if ('MW%@#&'.includes(ch)) return 0.90 * fontSize;
  if ('mw'.includes(ch)) return 0.82 * fontSize;
  if (/[A-Z]/.test(ch)) return 0.68 * fontSize;
  if (/[0-9]/.test(ch)) return 0.58 * fontSize;
  return 0.58 * fontSize;
}
function textWidth(str, fontSize) {
  let w = 0;
  for (const ch of String(str || '')) w += charWidth(ch, fontSize);
  return w;
}

function wrapLines(text, fontSize, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = '';
  for (const word of words) {
    const trial = cur ? `${cur} ${word}` : word;
    if (textWidth(trial, fontSize) <= maxWidth) { cur = trial; continue; }
    if (cur) lines.push(cur);
    // A single word wider than the box: hard-split it by characters.
    if (textWidth(word, fontSize) > maxWidth) {
      let chunk = '';
      for (const ch of word) {
        if (textWidth(chunk + ch, fontSize) > maxWidth && chunk) { lines.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      cur = chunk;
    } else cur = word;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Fit text into a box: WRAP first, then SHRINK the font step by step until
// it fits (down to minFont, the readable minimum). If it still does not fit,
// allow MORE lines (extendedMaxLines) at minFont — the box grows instead of
// the text overflowing. Only as a last resort (absurdly long text) shrink
// below the readable minimum to hardMinFont, and if even that fails,
// truncate with an ellipsis and flag the row "Needs attention" with a
// suggested shorter text. Text NEVER renders outside its box.
//
// Returns { fontSize, lines, lineHeight, heightPx, status, suggestedText }.
//   status: 'ok' (fit at maxFont) | 'adjusted' (font shrunk and/or more lines)
//           | 'attention' (below readable minimum, or truncated — check it).
// All sizes are RENDER pixels at the output size.
function fitText(text, maxWidth, { maxFont = 64, minFont = 20, maxLines = 2, lineHeight = 1.25, hardMinFont = 12 } = {}) {
  const clean = String(text || '').trim();
  const safeWidth = maxWidth * 0.92; // 8% safety margin vs the real renderer
  if (!clean) return { fontSize: maxFont, lines: [''], lineHeight, heightPx: maxFont * lineHeight, status: 'ok', suggestedText: null };
  const fitsAt = (f, linesCap) => {
    const lines = wrapLines(clean, f, safeWidth);
    return lines.length <= linesCap && lines.every((l) => textWidth(l, f) <= safeWidth + 0.5) ? lines : null;
  };
  for (let f = maxFont; f >= minFont; f -= 1) {
    const lines = fitsAt(f, maxLines);
    if (lines) return { fontSize: f, lines, lineHeight, heightPx: lines.length * f * lineHeight, status: f === maxFont ? 'ok' : 'adjusted', suggestedText: null };
  }
  // Auto-fix: more lines at the readable minimum (box grows, grid intact).
  const extended = maxLines * 2;
  const extLines = fitsAt(minFont, extended);
  if (extLines) return { fontSize: minFont, lines: extLines, lineHeight, heightPx: extLines.length * minFont * lineHeight, status: 'adjusted', suggestedText: null };
  // Below the readable minimum, down to the hard floor.
  for (let f = minFont - 1; f >= hardMinFont; f -= 1) {
    const lines = fitsAt(f, extended);
    if (lines) return { fontSize: f, lines, lineHeight, heightPx: lines.length * f * lineHeight, status: 'attention', suggestedText: suggestShorter(clean, safeWidth, minFont, maxLines) };
  }
  // Last resort: truncate (flagged — the user sees the suggestion instead).
  const lines = wrapLines(clean, hardMinFont, safeWidth).slice(0, extended);
  if (lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length > 3 ? `${last.slice(0, -3)}…` : last;
  }
  return { fontSize: hardMinFont, lines, lineHeight, heightPx: lines.length * hardMinFont * lineHeight, status: 'attention', suggestedText: suggestShorter(clean, safeWidth, minFont, maxLines) };
}

// A shorter version of the text that WOULD fit at minFont within maxLines —
// shown to the user as the suggested fix for "Needs attention" rows.
function suggestShorter(text, safeWidth, minFont, maxLines) {
  const lines = wrapLines(text, minFont, safeWidth).slice(0, maxLines);
  if (!lines.length) return text.slice(0, 40) + '…';
  let out = lines.join(' ').trim();
  if (out.length < text.trim().length) out = out.replace(/[\s,;:.]+$/, '') + '…';
  return out;
}

// --- Question parsing --------------------------------------------------------
function parseQuestion(row, rowIndex = 0) {
  const get = (col) => {
    const v = row[col];
    return v === undefined || v === null ? '' : String(v).trim();
  };
  const question = get('QUESTION');
  if (!question) throw new Error(`Row ${rowIndex + 1}: QUESTION is empty.`);
  const optionTexts = [get('OPTION_A'), get('OPTION_B'), get('OPTION_C'), get('OPTION_D')].filter(Boolean);
  if (optionTexts.length < 2) throw new Error(`Row ${rowIndex + 1}: at least two options (OPTION_A, OPTION_B) are required.`);
  const correctRaw = get('CORRECT');
  let correctIndex = -1;
  if (/^[A-D]$/i.test(correctRaw)) {
    correctIndex = correctRaw.toUpperCase().charCodeAt(0) - 65;
  } else if (correctRaw) {
    correctIndex = optionTexts.findIndex((t) => t.toLowerCase() === correctRaw.toLowerCase());
  }
  if (correctIndex < 0 || correctIndex >= optionTexts.length) {
    throw new Error(`Row ${rowIndex + 1}: CORRECT ("${correctRaw}") does not match any option (A–${String.fromCharCode(65 + optionTexts.length - 1)} or the option text).`);
  }
  const timerRaw = parseFloat(get('TIMER_SECONDS'));
  // Spec: countdown identical every question, never <3s or >6s (default 3s).
  const timerSeconds = Number.isFinite(timerRaw) ? Math.max(QUIZ_SPEC.timerMin, Math.min(QUIZ_SPEC.timerMax, Math.round(timerRaw))) : QUIZ_SPEC.timerSeconds;
  const rtl = isRtl(question + ' ' + optionTexts.join(' '));
  const caps = checkCaps(question, optionTexts);
  return {
    rowIndex,
    question,
    options: optionTexts.map((text, i) => ({ label: String.fromCharCode(65 + i), text })),
    correctIndex,
    explanation: get('EXPLANATION'),
    category: get('CATEGORY') || 'General',
    difficulty: get('DIFFICULTY') || '',
    difficultyRank: DIFFICULTY_RANK[get('DIFFICULTY').toLowerCase()] ?? 1,
    timerSeconds,
    imageValue: get('QUESTION_IMAGE'),
    // Narration + voice (post-Phase-5 upgrade): NARRATION_AUDIO is the
    // recorded narration for this row (a Media Library audio id, or the
    // audio file's original name); VOICE is a per-row voice override (a
    // voice profile name or id — the bulk job voice or the user's default
    // voice applies when it is empty).
    narrationAudio: get('NARRATION_AUDIO'),
    voice: get('VOICE'),
    rtl,
    caps,
  };
}

// Fit text at a FIXED font size (batch/uniform fonts): wrap, allow up to
// extendedLines lines (box grows), truncate only as a last resort.
// Returns { lines, status } — 'ok' | 'adjusted' | 'attention'.
function fitAtFont(text, maxWidth, fontSize, { maxLines = 2, extendedLines = 4, lineHeight = 1.25 } = {}) {
  const clean = String(text || '').trim();
  const safeWidth = maxWidth * 0.92;
  if (!clean) return { lines: [''], status: 'ok', heightPx: fontSize * lineHeight };
  const lines = wrapLines(clean, fontSize, safeWidth);
  if (lines.length <= maxLines) return { lines, status: 'ok', heightPx: lines.length * fontSize * lineHeight };
  if (lines.length <= extendedLines) return { lines, status: 'adjusted', heightPx: lines.length * fontSize * lineHeight };
  const cut = lines.slice(0, extendedLines);
  const last = cut[cut.length - 1];
  cut[cut.length - 1] = last.length > 3 ? `${last.slice(0, -3)}…` : last;
  return { lines: cut, status: 'attention', heightPx: cut.length * fontSize * lineHeight };
}

// UNIFORM FONT (user rule): one font size for a whole SET of texts (all four
// options in a question; all questions in a batch; all values of one field).
// The size is set by the LONGEST text in the set — every other text uses
// that same size, never its own bigger one. If one outlier would drag the
// set below the readable minimum, the set keeps its proper size and the
// outlier is flagged "Needs attention" (with a shorter-text suggestion)
// instead of shrinking the whole batch.
// items: [{ key, text }]. Returns { font, linesByKey, statuses, outliers }.
function uniformFont(items, maxWidth, { maxFont = 38, minFont = 16, maxLines = 2, lineHeight = 1.25 } = {}) {
  const fits = items.map((it) => ({
    key: it.key,
    fit: fitText(it.text, maxWidth, { maxFont, minFont, maxLines, lineHeight }),
  }));
  const ok = fits.filter((f) => f.fit.fontSize >= minFont);
  const font = ok.length ? Math.min(...ok.map((f) => f.fit.fontSize)) : minFont;
  const linesByKey = {};
  const statuses = {};
  const outliers = [];
  for (const f of fits) {
    const at = fitAtFont(items.find((i) => i.key === f.key).text, maxWidth, font, { maxLines, extendedLines: maxLines * 2, lineHeight });
    linesByKey[f.key] = at.lines;
    statuses[f.key] = at.status;
    if (f.fit.fontSize < minFont) {
      outliers.push({ key: f.key, requiredFont: f.fit.fontSize, suggestedText: f.fit.suggestedText });
    }
  }
  return { font, linesByKey, statuses, outliers };
}

// Readable-minimum fonts (render px at 720x1280 — 28/24/21px at 1080x1920).
// They scale with the output width: minFont(W) = MIN_FONTS.x * (W / 720).
const MIN_FONTS = { question: 19, option: 16, explanation: 14 };
function minFontsFor(W) {
  const s = W / 720;
  return {
    question: Math.max(8, Math.round(MIN_FONTS.question * s)),
    option: Math.max(8, Math.round(MIN_FONTS.option * s)),
    explanation: Math.max(8, Math.round(MIN_FONTS.explanation * s)),
  };
}

// --- Layout (output pixels at W x H, 9:16) ----------------------------------
// Research spec: everything essential lives inside the safe box
// (x48-888, y288-1248 at 1080x1920, scaled to W x H). The question sits in
// the middle band, the options are a full-width STACKED list (2x2 grid only
// for image tiles), the timer is a load-bar under the question. RTL text
// mirrors the layout (labels on the right, right-aligned text, line-height
// 1.5, Noto Kufi Arabic — set on the clips by buildQuizTimeline).
//
// Compress step: after fitting, if the flowed content is taller than the
// safe box, fonts shrink step by step to the readable minimum; if that is
// still not enough, the explanation is dropped first, then the question is
// truncated (flagged "Needs attention" — never rendered outside the box).
//
// fonts (optional, batch-level): { question, option, explanation } render px.
// Without fonts, the question fits itself and the options share one uniform
// font within the question (set by the longest option).
// Returns the layout + a fit report:
//   { ..., fitReport: { overall, questionFont, optionFont, explanationFont,
//     question, options, explanation, outlier, suggestedText, safeZoneOk,
//     balanced, issues, caps, rtl } }
function layoutRound(q, { W = 720, H = 1280, hasImage = false, fonts = null } = {}) {
  const sx = W / 720;
  const sy = H / 1280;
  const safe = safeBoxFor(W, H);
  const margin = safe.x;
  const boxW = safe.w;
  const lineHeight = q.rtl ? 1.5 : 1.25;
  const gap = Math.round(10 * sy);
  const issues = [];
  let outlier = false;
  let suggestedText = null;
  const mins = minFontsFor(W);
  // Spec typography (render px at W): question cap height ~90-130px at 1080w
  // (max 96px at 720w = 144px at 1080w, cap ≈ 100px); options ≥54-60px cap
  // height at 1080w (max 54px at 720w = 81px at 1080w, cap ≈ 57px).
  const maxQFont = Math.round(96 * sx);
  const maxOFont = Math.round(54 * sx);
  const maxEFont = Math.round(32 * sx);

  // --- Fit pass: returns the flowed layout for a given font set. ---
  const compute = (qFont, oFont, eFont) => {
    const qFit = fitAtFont(q.question, boxW, qFont, { maxLines: 4, extendedLines: 8, lineHeight });
    const oFits = {};
    let oStatus = 'ok';
    for (const o of q.options) {
      const f = fitAtFont(`${o.label}. ${o.text}`, boxW - Math.round(32 * sx), oFont, { maxLines: 2, extendedLines: 4, lineHeight });
      oFits[o.label] = f;
      if (f.status === 'attention') oStatus = 'attention';
      else if (f.status === 'adjusted' && oStatus !== 'attention') oStatus = 'adjusted';
    }
    const eFit = q.explanation
      ? fitAtFont(q.explanation, boxW, eFont, { maxLines: 2, extendedLines: 3, lineHeight })
      : { lines: [], status: 'ok', heightPx: 0 };
    // Flow positions (all inside the safe box by construction, then checked).
    const chipH = Math.round(26 * sy);
    const chipY = safe.y;
    const qBoxH = Math.round(qFit.heightPx) + Math.round(16 * sy);
    const qBox = { x: safe.x, y: chipY + chipH + Math.round(16 * sy), w: boxW, h: qBoxH };
    const barY = qBox.y + qBox.h + Math.round(18 * sy);
    const barH = Math.round(12 * sy);
    const imageBox = hasImage
      ? { x: Math.round((W - 320 * sx) / 2), y: barY + barH + Math.round(20 * sy), w: Math.round(320 * sx), h: Math.round(160 * sy) }
      : null;
    let gridY = Math.max(safe.y + Math.round(120 * sy), barY + barH + Math.round(22 * sy));
    if (imageBox) gridY = Math.max(gridY, imageBox.y + imageBox.h + Math.round(22 * sy));
    const optionBoxes = q.options.map((opt) => {
      const lines = oFits[opt.label].lines;
      const h = Math.max(Math.round(56 * sy), Math.round(lines.length * oFont * lineHeight) + Math.round(16 * sy));
      return {
        label: opt.label, text: opt.text,
        x: safe.x, y: gridY, w: boxW, h,
        fontSize: oFont, lines, fullText: `${opt.label}. ${opt.text}`,
      };
    });
    // Stacked: each row's y is the grid top + all rows above it (+ gaps).
    const optionBoxesH = optionBoxes.map((b) => b.h);
    optionBoxes.forEach((b, i) => {
      b.y = gridY + optionBoxesH.slice(0, i).reduce((a, h) => a + h + gap, 0);
    });
    const gridBottom = optionBoxes.length ? Math.max(...optionBoxes.map((b) => b.y + b.h)) : gridY;
    const explBox = { x: safe.x, y: gridBottom + Math.round(20 * sy), w: boxW, h: Math.round(eFit.heightPx || 0) };
    const bottom = (q.explanation ? explBox.y + explBox.h : gridBottom);
    // fitAtFont returns lines/status only — attach the font so callers
    // (timeline builder, preview) can use the fitted size directly.
    return { qFit: { ...qFit, fontSize: qFont }, oFits, oStatus, eFit: { ...eFit, fontSize: eFont }, chipY, chipH, qBox, barY, barH, imageBox, gridY, optionBoxes, gridBottom, explBox, bottom };
  };

  // --- Fonts: batch fonts when given, else fit this question. ---
  let qFont, oFont, eFont, qStatus = 'ok', oStatus = 'ok', eStatus = 'ok';
  let qFit, oFits, eFit;
  if (fonts) {
    qFont = fonts.question; oFont = fonts.option; eFont = fonts.explanation;
    const c = compute(qFont, oFont, eFont);
    ({ qFit, oFits, eFit } = c);
    qStatus = c.qFit.status; oStatus = c.oStatus; eStatus = c.eFit.status;
  } else {
    const qf = fitText(q.question, boxW, { maxFont: maxQFont, minFont: mins.question, maxLines: 4, lineHeight });
    qFont = qf.fontSize; qStatus = qf.status;
    const u = uniformFont(q.options.map((o) => ({ key: o.label, text: `${o.label}. ${o.text}` })), boxW - Math.round(32 * sx),
      { maxFont: maxOFont, minFont: mins.option, maxLines: 2, lineHeight });
    oFont = u.font;
    if (u.outliers.length) { outlier = true; suggestedText = u.outliers[0].suggestedText; }
    const ef = q.explanation
      ? fitText(q.explanation, boxW, { maxFont: maxEFont, minFont: mins.explanation, maxLines: 2, lineHeight })
      : { fontSize: maxEFont, lines: [], heightPx: 0, status: 'ok', suggestedText: null };
    eFont = ef.fontSize; eStatus = ef.status || 'ok';
  }
  if (qStatus === 'attention' && !suggestedText) {
    const s = fitText(q.question, boxW, { maxFont: maxQFont, minFont: mins.question, maxLines: 4, lineHeight });
    suggestedText = s.suggestedText;
    outlier = true;
  }
  if (qStatus === 'attention' || oStatus === 'attention' || eStatus === 'attention') outlier = true;

  // --- Compress: shrink fonts stepwise until the flow fits the safe box. ---
  let c = compute(qFont, oFont, eFont);
  let compressed = false;
  let guard = 0;
  while (c.bottom > safe.y + safe.h && guard < 60) {
    guard += 1;
    compressed = true;
    if (qFont > mins.question && qFont >= oFont) { qFont = Math.max(mins.question, qFont - 2); }
    else if (oFont > mins.option) { oFont = Math.max(mins.option, oFont - 2); }
    else if (eFont > mins.explanation) { eFont = Math.max(mins.explanation, eFont - 2); }
    else break;
    c = compute(qFont, oFont, eFont);
  }
  if (c.bottom > safe.y + safe.h) {
    // Still too tall at the readable minimum: drop the explanation first,
    // then truncate the question (flagged — the user gets the suggestion).
    issues.push('Content is taller than the safe box even at the readable minimum — shorten the question or an option.');
    outlier = true;
    if (q.explanation) {
      const noExpl = { ...q, explanation: '' };
      const saved = q.explanation;
      q = noExpl;
      const c2 = compute(qFont, oFont, eFont);
      if (c2.bottom <= safe.y + safe.h) { c = c2; issues.push('Explanation hidden to fit the safe box.'); }
      else q = { ...q, explanation: saved };
    }
    if (c.bottom > safe.y + safe.h) {
      // Last resort: cap the question lines (flagged, never overflowing).
      const capped = { ...c };
      capped.qFit = { ...c.qFit, lines: c.qFit.lines.slice(0, 4) };
      capped.qFit.heightPx = capped.qFit.lines.length * qFont * lineHeight;
      c = { ...c, qFit: capped.qFit };
      const rec = compute(qFont, oFont, eFont);
      c = { ...rec, qFit: capped.qFit };
      if (!suggestedText) {
        const s = fitText(q.question, boxW, { maxFont: maxQFont, minFont: mins.question, maxLines: 4, lineHeight });
        suggestedText = s.suggestedText;
      }
    }
  }
  if (compressed) {
    // Compression is normal fitting (Adjusted) unless it drove a font to
    // the readable minimum — then the batch is at its limit (attention).
    if (qFont <= mins.question || oFont <= mins.option) {
      issues.push(`Layout compressed to the readable minimum to fit the safe box (question font ${qFont}px, option font ${oFont}px) — shorten the question or an option.`);
      outlier = true;
    } else {
      if (qStatus === 'ok') qStatus = 'adjusted';
      if (oStatus === 'ok') oStatus = 'adjusted';
    }
  }
  const { qBox, barY, barH, imageBox, gridY, optionBoxes, gridBottom, explBox, chipY, chipH } = c;
  qFit = c.qFit; oFits = c.oFits; eFit = c.eFit; oStatus = c.oStatus;

  // --- Safe-zone + balance checks (everything must sit in the safe box). ---
  const boxesInside = (b) => b.x >= safe.x && b.y >= safe.y && b.x + b.w <= safe.x + safe.w && b.y + b.h <= safe.y + safe.h;
  const safeZoneOk = boxesInside(qBox)
    && optionBoxes.every(boxesInside)
    && (!q.explanation || boxesInside({ ...explBox, h: Math.max(explBox.h, 1) }))
    && barY >= safe.y && barY + barH <= safe.y + safe.h;
  if (!safeZoneOk) issues.push('A layout element falls outside the safe box.');
  // Balanced = the content block is centred inside the SAFE box (the spec
  // safe box is deliberately off-centre in the frame — 48px left, 192px
  // right at 1080w — so frame-centring is the wrong test) and every box
  // shares the safe box's horizontal centre.
  const contentTop = chipY;
  const contentBottom = c.bottom;
  const contentCenterY = (contentTop + contentBottom) / 2;
  const safeCenterY = safe.y + safe.h / 2;
  const balanced = Math.abs(contentCenterY - safeCenterY) <= safe.h * 0.15
    && optionBoxes.every((b) => Math.abs(b.x + b.w / 2 - (safe.x + safe.w / 2)) < 2);

  const capsExceeded = Boolean(q.caps && q.caps.exceeded);
  if (capsExceeded) {
    issues.push(...(q.caps.messages || []));
    outlier = true;
  }
  const overall = outlier || issues.length ? 'Needs attention'
    : (qStatus === 'adjusted' || oStatus === 'adjusted' || eStatus === 'adjusted') ? 'Adjusted' : 'OK';
  return {
    W, H, margin, boxW, captionReserve: Math.round(H - (safe.y + safe.h)), topReserve: safe.y,
    safeBox: safe,
    qFit: { ...qFit, fontSize: qFont },
    qBox, barY, barH, chipY, chipH,
    stacked: true, twoCol: false, cellW: boxW, gridY, gridBottom,
    imageBox, optionBoxes, eFit, explBox,
    rtl: Boolean(q.rtl),
    inBounds: safeZoneOk,
    fitReport: {
      overall,
      questionFont: qFont,
      optionFont: oFont,
      explanationFont: eFont,
      question: { status: qStatus, from: maxQFont, to: qFont, lines: qFit.lines.length },
      options: { status: oStatus, from: maxOFont, to: oFont },
      explanation: { status: eStatus, from: maxEFont, to: eFont },
      outlier, suggestedText, safeZoneOk, balanced, issues,
      caps: q.caps || null,
      rtl: Boolean(q.rtl),
    },
  };
}

// --- Narration sequencing + per-element animations (post-Phase-5 upgrade) --
// USER RULE (2026-11-12): a quiz round is SPOKEN in order — first the
// QUESTION, then the OPTIONS one by one, then the ANSWER (correct option +
// explanation). Every element gets an animation, in BOTH modes:
//   AUTO — sensible defaults (question fades in, options slide in staggered,
//     answer pops + highlights); MANUAL — the user sets each element's
//     animation type, delay and duration.
//
// Animation types are REAL in the FFmpeg render (src/render.js draws them
// with drawtext alpha/x/y/fontsize expressions): fade, slide-left/right/
// up/down, pop (fontsize ramp + fade). 'typewriter' is NOT possible with
// drawtext — it is never offered and never claimed.
//
// The narration plan is the single source of truth for segment timing: the
// timeline builder, the phone-frame preview (/api/bulk/quiz/narration-plan)
// and the TTS/recorded-narration placement all use these same times.
//   Visual stagger: the question appears at the round start; option i
//     appears at roundStart + optionStagger * (i + 1) inside the READ phase,
//     so every option is on screen before the countdown starts.
//   Spoken order: the question is spoken during the READ phase; the options
//     are spoken one per slot during the COUNTDOWN (timerSeconds / nOptions
//     each — the voice reads the options while the timer ticks, exactly
//     like a real quiz video); the answer + explanation are spoken during
//     the REVEAL phase.
// A segment is { element, label, text, start, duration, animation } where
// start/duration are absolute seconds in the VIDEO (not the round).
const ANIM_TYPES = ['none', 'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'pop'];
const ANIM_ELEMENTS = ['question', 'option', 'answer', 'explanation', 'chip'];
const DEFAULT_ANIMATIONS = {
  question: { type: 'fade', delay: 0, duration: 0.5 },
  option: { type: 'slide-left', delay: 0, duration: 0.4 },
  answer: { type: 'pop', delay: 0, duration: 0.4 },
  explanation: { type: 'fade', delay: 0, duration: 0.4 },
  chip: { type: 'fade', delay: 0, duration: 0.4 },
};
const OPTION_STAGGER_DEFAULT = 0.4; // seconds between option appearances

function sanitizeAnim(a, fallback) {
  const base = { ...(fallback || { type: 'fade', delay: 0, duration: 0.4 }) };
  if (!a || typeof a !== 'object') return base;
  if (ANIM_TYPES.includes(a.type)) base.type = a.type;
  const delay = parseFloat(a.delay);
  if (Number.isFinite(delay)) base.delay = Math.max(0, Math.min(5, delay));
  const duration = parseFloat(a.duration);
  if (Number.isFinite(duration)) base.duration = Math.max(0.1, Math.min(2, duration));
  return base;
}

// Validate + normalise a user-supplied animation setting. Throws on a bad
// mode or an unknown element/type. Returns the resolved setting:
// { mode: 'auto'|'manual', optionStagger, elements: { question, option,
//   answer, explanation, chip } }.
function validateAnimations(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const mode = raw.mode === 'manual' ? 'manual' : 'auto';
  const staggerRaw = parseFloat(raw.optionStagger);
  const optionStagger = Number.isFinite(staggerRaw)
    ? Math.max(0, Math.min(2, staggerRaw)) : OPTION_STAGGER_DEFAULT;
  const elements = {};
  for (const el of ANIM_ELEMENTS) {
    if (raw.elements && raw.elements[el] !== undefined) {
      if (typeof raw.elements[el] !== 'object' || raw.elements[el] === null) {
        throw new Error(`Animation for "${el}" must be an object { type, delay, duration }.`);
      }
      if (raw.elements[el].type !== undefined && !ANIM_TYPES.includes(raw.elements[el].type)) {
        throw new Error(`Unknown animation type "${raw.elements[el].type}" for "${el}" — use one of: ${ANIM_TYPES.join(', ')}.`);
      }
    }
    // Auto mode always uses the defaults, even if overrides were sent —
    // the user picks Manual to take control.
    elements[el] = mode === 'auto'
      ? { ...DEFAULT_ANIMATIONS[el] }
      : sanitizeAnim(raw.elements ? raw.elements[el] : undefined, DEFAULT_ANIMATIONS[el]);
  }
  return { mode, optionStagger, elements };
}

function resolveAnimations(input) {
  try { return validateAnimations(input); }
  catch { return validateAnimations(null); }
}

// The timed narration plan for ONE round (absolute video seconds).
// q: parsed question; roundStart: absolute start of the round.
// Returns { roundStart, roundDuration, questionPhase, countdownStart,
//   revealStart, segments: [...] } — segments in spoken order.
function buildNarrationPlan(q, roundStart, { readSeconds = QUIZ_SPEC.readSeconds, revealSeconds = QUIZ_SPEC.revealSeconds, animations = null } = {}) {
  const anims = resolveAnimations(animations);
  const r3 = (n) => Math.round(n * 1000) / 1000; // no float dust in times
  const questionPhase = readSeconds + q.timerSeconds;
  const roundDuration = questionPhase + revealSeconds;
  const countdownStart = roundStart + readSeconds;
  const revealStart = countdownStart + q.timerSeconds;
  const nOptions = q.options.length;
  const optionSlot = q.timerSeconds / Math.max(1, nOptions);
  const segments = [];
  segments.push({
    element: 'question', label: 'Question', text: q.question,
    start: r3(roundStart), duration: r3(readSeconds), animation: anims.elements.question,
  });
  q.options.forEach((opt, i) => {
    // Visual appearance: staggered inside the read phase. A manual stagger
    // that would push an option past the question phase is clamped so the
    // option is still on screen at least 0.5s before the countdown ends —
    // the plan and the render always agree.
    const appearAt = Math.min(
      roundStart + anims.optionStagger * (i + 1),
      roundStart + questionPhase - 0.5
    );
    segments.push({
      element: 'option', label: `Option ${opt.label}`, text: `${opt.label}. ${opt.text}`,
      appearAt: r3(appearAt),
      // Spoken: one slot each during the countdown.
      start: r3(countdownStart + i * optionSlot), duration: r3(optionSlot),
      animation: anims.elements.option,
    });
  });
  const correct = q.options[q.correctIndex];
  segments.push({
    element: 'answer', label: 'Answer',
    text: correct ? `Correct answer: ${correct.label}. ${correct.text}` : 'Correct answer',
    start: r3(revealStart), duration: r3(revealSeconds), animation: anims.elements.answer,
  });
  if (q.explanation) {
    segments.push({
      element: 'explanation', label: 'Explanation', text: q.explanation,
      start: r3(revealStart), duration: r3(revealSeconds), animation: anims.elements.explanation,
    });
  }
  return {
    roundStart: r3(roundStart), roundDuration: r3(roundDuration),
    questionPhase: r3(questionPhase), countdownStart: r3(countdownStart), revealStart: r3(revealStart),
    optionStagger: anims.optionStagger, mode: anims.mode,
    segments,
  };
}

// --- Timeline builder --------------------------------------------------------
// questions: parsed questions (parseQuestion output), each with
//   backgroundMediaId / backgroundKind attached by the caller.
// opts: { W, H, fps, readSeconds, revealSeconds, ctaSeconds (score card),
//         ctaText, ctaSub, brandColor, fonts }
// Defaults (research spec): 1080x1920, 30fps, read 2s + countdown 3s +
// reveal 2s per question, 3s score card at the end.
// The timeline uses ONE text track per simultaneous element lane (chip,
// question, countdown/bar, one per option, explanation, score, score sub) —
// Phase 3's validateTimeline forbids overlapping clips on the SAME track,
// and a quiz round has many simultaneous texts; separate lanes keep the
// timeline valid while the renderer composites all text tracks.
// Returns { timeline, rounds, warnings, totalDuration, fitReports, fonts, spec }.
function buildQuizTimeline(questions, opts = {}) {
  const W = opts.W || QUIZ_SPEC.width;
  const H = opts.H || QUIZ_SPEC.height;
  const fps = opts.fps || QUIZ_SPEC.fps;
  const readSeconds = opts.readSeconds || QUIZ_SPEC.readSeconds;
  const revealSeconds = opts.revealSeconds || QUIZ_SPEC.revealSeconds;
  const ctaSeconds = opts.ctaSeconds || QUIZ_SPEC.scoreSeconds;
  // Batch-level uniform fonts (rule D): one question font + one options font
  // for the whole batch, set by the longest text. If absent, each question
  // fits itself (options still share one font within the question).
  const fonts = opts.fonts || null;
  // Accent: amber #FCA311 (spec); the brand colour overrides it when set.
  const accent = opts.brandColor || QUIZ_SPEC.accent;
  // Narration + animations (post-Phase-5 upgrade): auto defaults unless
  // the caller passes manual overrides (validated by resolveAnimations).
  const animations = resolveAnimations(opts.animations);
  const warnings = [];
  if (!questions.length) throw new Error('No questions to build a quiz from.');
  // Easiest first, hardest last (spec ramp: easy/easy/medium/hard/hardest).
  const ordered = [...questions].sort((a, b) => a.difficultyRank - b.difficultyRank);
  const safe = safeBoxFor(W, H);
  const mkTrack = (id, kind, name) => ({ id: `${id}_${Date.now().toString(36)}`, kind, name, locked: false, muted: false, clips: [] });
  const timeline = {
    version: 1, width: W, height: H, fps, background: QUIZ_SPEC.background,
    tracks: [
      mkTrack('track_video', 'video', 'Background'),
      mkTrack('track_video2', 'video', 'Images'),
      mkTrack('track_audio', 'audio', 'Audio'),
      mkTrack('track_text_chip', 'text', 'Chip'),
      mkTrack('track_text_question', 'text', 'Question'),
      mkTrack('track_text_countdown', 'text', 'Countdown'),
      mkTrack('track_text_optA', 'text', 'Option A'),
      mkTrack('track_text_optB', 'text', 'Option B'),
      mkTrack('track_text_optC', 'text', 'Option C'),
      mkTrack('track_text_optD', 'text', 'Option D'),
      mkTrack('track_text_expl', 'text', 'Explanation'),
      mkTrack('track_text_score', 'text', 'Score card'),
      mkTrack('track_text_scoresub', 'text', 'Score card sub'),
    ],
    markers: [],
  };
  const [videoTrack, imageTrack] = timeline.tracks;
  const chipTrack = timeline.tracks[3];
  const questionTrack = timeline.tracks[4];
  const countdownTrack = timeline.tracks[5];
  const optionTracks = [timeline.tracks[6], timeline.tracks[7], timeline.tracks[8], timeline.tracks[9]];
  const explTrack = timeline.tracks[10];
  const scoreTrack = timeline.tracks[11];
  const scoreSubTrack = timeline.tracks[12];
  const scaleFont = (renderPx) => Math.max(8, Math.round(renderPx * (1080 / W)));
  const pctX = (px) => (px / W) * 100;
  const pctY = (px) => (px / H) * 100;
  const textClip = (id, text, start, duration, extra) => ({
    id, mediaId: null, kind: 'text', name: id, start, duration, srcStart: 0,
    speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, rotation: 0, flip: 'none',
    opacity: 1, scaleMode: 'fit', zoom: 1,
    filters: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, blur: 0, vignette: 0 },
    transition: { type: 'none', duration: 0.5 }, groupId: null,
    text: {
      text, fontFamily: 'Poppins', fontSize: 64, fontWeight: 700, color: '#ffffff',
      align: 'center', x: 50, y: 50, bgColor: '', animIn: 'none', animOut: 'none', ...(extra || {}),
    },
    keyframes: [],
  });
  let cursor = 0;
  const rounds = [];
  const total = ordered.length;

  ordered.forEach((q, qi) => {
    const roundStart = cursor;
    const questionPhase = readSeconds + q.timerSeconds;
    const roundDur = questionPhase + revealSeconds;
    // Single source of truth for segment timing (visual + spoken).
    const plan = buildNarrationPlan(q, roundStart, { readSeconds, revealSeconds, animations });
    const countdownStart = plan.countdownStart;
    const revealStart = plan.revealStart;
    const hasImage = Boolean(q.imageMediaId);
    const L = layoutRound(q, { W, H, hasImage, fonts });
    if (!L.inBounds) warnings.push(`Question ${qi + 1}: layout exceeds the safe box — check long options.`);
    // RTL text uses the Arabic font + right alignment (fontFor resolves it
    // to Noto Kufi Arabic / Noto Sans Arabic in the renderer).
    const rtlFont = q.rtl ? { fontFamily: 'Noto Kufi Arabic' } : {};

    // Background clip for this round (or a gap = solid navy background).
    // Quality bar: a busy background is auto-blurred + darkened so the text
    // never fights it; a bright one is darkened a touch more.
    if (q.backgroundMediaId) {
      const busy = Boolean(q.backgroundStats && q.backgroundStats.busy);
      const bright = q.backgroundStats && typeof q.backgroundStats.luminance === 'number'
        ? q.backgroundStats.luminance > 0.65 : false;
      videoTrack.clips.push({
        id: `clip_bg_${qi}`, mediaId: q.backgroundMediaId, kind: 'video',
        name: `Background Q${qi + 1}`, start: roundStart, duration: roundDur, srcStart: 0,
        speed: 1, volume: 0, muted: true, fadeIn: 0, fadeOut: 0, rotation: 0, flip: 'none',
        opacity: 1, scaleMode: 'fill', zoom: 1, loop: q.backgroundKind === 'video',
        filters: { brightness: bright ? -0.16 : -0.08, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, blur: busy ? 2 : 0, vignette: 0 },
        transition: { type: 'none', duration: 0.5 }, groupId: null,
        text: { text: '', fontFamily: 'Poppins', fontSize: 64, fontWeight: 700, color: '#ffffff', align: 'center', x: 50, y: 50, bgColor: '', animIn: 'none', animOut: 'none' },
        keyframes: [],
      });
    }
    // Question image overlay (during the question phase only, centred in
    // the layout's image box).
    if (hasImage) {
      imageTrack.clips.push({
        id: `clip_img_${qi}`, mediaId: q.imageMediaId, kind: 'video',
        name: `Image Q${qi + 1}`, start: roundStart, duration: questionPhase, srcStart: 0,
        speed: 1, volume: 0, muted: true, fadeIn: 0, fadeOut: 0, rotation: 0, flip: 'none',
        opacity: 1, scaleMode: 'fit', zoom: 1, loop: false,
        filters: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, blur: 0, vignette: 0 },
        transition: { type: 'none', duration: 0.5 }, groupId: null,
        text: { text: '', fontFamily: 'Poppins', fontSize: 64, fontWeight: 700, color: '#ffffff', align: 'center', x: 50, y: 50, bgColor: '', animIn: 'none', animOut: 'none' },
        keyframes: [{ t: 0, x: pctX(L.imageBox.x + L.imageBox.w / 2), y: pctY(L.imageBox.y + L.imageBox.h / 2), scale: 1, opacity: 1 }],
      });
    }

    // Progress + category chip (top of the safe box).
    chipTrack.clips.push(textClip(`clip_chip_${qi}`,
      `Q${qi + 1}/${total}  •  ${q.category.toUpperCase()}${q.difficulty ? `  •  ${q.difficulty.toUpperCase()}` : ''}`,
      roundStart, questionPhase,
      { fontSize: scaleFont(26), fontWeight: 600, color: accent, align: q.rtl ? 'right' : 'left', x: q.rtl ? pctX(W - L.margin) : pctX(L.margin), y: pctY(L.chipY), animIn: animations.elements.chip.type, animDuration: animations.elements.chip.duration, ...rtlFont }));

    // Question text (auto-fit, centred in its box) — on screen from frame 1.
    questionTrack.clips.push(textClip(`clip_q_${qi}`, L.qFit.lines.join('\n'), roundStart, questionPhase,
      { fontSize: scaleFont(L.qFit.fontSize), fontWeight: 800, align: 'center', x: 50, y: pctY(L.qBox.y + 8), animIn: animations.elements.question.type, animDuration: animations.elements.question.duration, ...rtlFont }));

    // Timer load-bar: FULL during the read phase, then draining 3-2-1
    // (one 1s number clip per second, each with its shrinking bar panel).
    // A text clip with a single space renders an invisible label + the panel.
    countdownTrack.clips.push(textClip(`clip_bar_${qi}`, ' ', roundStart, readSeconds,
      { fontSize: scaleFont(20), panel: { x: L.margin, y: L.barY, w: L.boxW, h: L.barH, fill: accent } }));
    for (let s = 0; s < q.timerSeconds; s++) {
      const remaining = q.timerSeconds - s;
      const barW = Math.round(L.boxW * (remaining / q.timerSeconds));
      countdownTrack.clips.push(textClip(`clip_cd_${qi}_${s}`, String(remaining), countdownStart + s, 1,
        {
          fontSize: scaleFont(54), fontWeight: 800, color: '#ffffff', align: 'right',
          x: pctX(W - L.margin), y: pctY(30),
          panel: { x: L.margin, y: L.barY, w: barW, h: L.barH, fill: accent },
        }));
    }

    // Option boxes — question phase (normal) + reveal phase (green/dim).
    // Narration rule: options appear ONE BY ONE (staggered, from the plan),
    // each with the option animation — never all at once.
    q.options.forEach((opt, oi) => {
      const box = L.optionBoxes[oi];
      const labelText = box.fullText;
      const panel = { x: box.x, y: box.y, w: box.w, h: box.h, fill: '#1e293b', border: '#475569', borderWidth: 2 };
      // Centre the text in the cell (the cell grew with the option's lines).
      const textY = box.y + Math.round((box.h - box.fontSize * 1.25 * box.lines.length) / 2);
      const base = {
        fontSize: scaleFont(box.fontSize), fontWeight: 700, color: '#ffffff',
        align: q.rtl ? 'right' : 'left',
        x: q.rtl ? pctX(box.x + box.w - 16) : pctX(box.x + 16), y: pctY(textY),
        animIn: animations.elements.option.type, animDuration: animations.elements.option.duration,
        ...rtlFont,
      };
      const appearAt = plan.segments[1 + oi].appearAt;
      const appearDur = Math.max(0.5, questionPhase - (appearAt - roundStart));
      optionTracks[oi].clips.push(textClip(`clip_opt_${qi}_${oi}_q`, box.lines.join('\n'), appearAt, appearDur, { ...base, panel }));
      const isCorrect = oi === q.correctIndex;
      const revealPanel = isCorrect
        ? { x: box.x, y: box.y, w: box.w, h: box.h, fill: QUIZ_SPEC.correctFill, border: QUIZ_SPEC.correctBorder, borderWidth: 3 }
        : { x: box.x, y: box.y, w: box.w, h: box.h, fill: '#0f172a', border: '#1e293b', borderWidth: 2 };
      const mark = isCorrect ? '✓ ' : '✗ ';
      const revealText = mark + labelText;
      const reveal = textClip(`clip_opt_${qi}_${oi}_r`, revealText, revealStart, revealSeconds,
        { ...base, panel: revealPanel, alpha: isCorrect ? 1 : 0.45, animIn: animations.elements.answer.type, animDuration: animations.elements.answer.duration });
      // Smooth reveal: the green highlight fades in instead of popping.
      // The ✓/✗ prefix must not change the font (uniform rule) or add a
      // line the cell cannot hold — if it would, the panel + mark alone
      // mark it (the mark is kept; the wrapped lines are used as-is).
      const rFit = fitAtFont(revealText, box.w - 32, box.fontSize, { maxLines: box.lines.length, extendedLines: box.lines.length, lineHeight: q.rtl ? 1.5 : 1.25 });
      reveal.text.text = rFit.lines.join('\n');
      optionTracks[oi].clips.push(reveal);
    });

    // Explanation (reveal phase, below the options) — only when the layout
    // actually shows it (a too-tall layout drops the explanation to fit the
    // safe box; an empty-text clip would fail validation).
    if (q.explanation && L.eFit.lines.join('').trim()) {
      explTrack.clips.push(textClip(`clip_ex_${qi}`, L.eFit.lines.join('\n'), revealStart, revealSeconds,
        { fontSize: scaleFont(fonts ? fonts.explanation : L.eFit.fontSize), fontWeight: 600, color: '#fde68a', align: 'center', x: 50, y: pctY(L.explBox.y), animIn: animations.elements.explanation.type, animDuration: animations.elements.explanation.duration, ...rtlFont }));
    }

    rounds.push({
      questionIndex: q.rowIndex, start: roundStart, duration: roundDur,
      readSeconds, timerSeconds: q.timerSeconds, countdownStart,
      revealStart, revealSeconds, correctIndex: q.correctIndex,
      category: q.category, difficulty: q.difficulty, rtl: q.rtl,
      fitReport: L.fitReport,
      narration: plan,
    });
    cursor += roundDur;
  });

  // Score card at the very end (3s, centred in the safe box).
  const ctaText = opts.ctaText || 'Kitne sahi hue? Comment mein score likho';
  const ctaSub = opts.ctaSub || 'Follow for more quizzes';
  const ctaStart = cursor;
  const scoreY = safe.y + Math.round(safe.h / 2) - Math.round(80 * (H / 1920));
  scoreTrack.clips.push(textClip('clip_cta', ctaText, ctaStart, ctaSeconds,
    { fontSize: scaleFont(48), fontWeight: 800, color: '#ffffff', align: 'center', x: 50, y: pctY(scoreY), animIn: 'fade', animOut: 'fade' }));
  scoreSubTrack.clips.push(textClip('clip_cta_sub', ctaSub, ctaStart, ctaSeconds,
    { fontSize: scaleFont(28), fontWeight: 600, color: accent, align: 'center', x: 50, y: pctY(scoreY + Math.round(110 * (H / 1920))), animIn: 'fade', animOut: 'fade' }));
  cursor += ctaSeconds;

  return {
    timeline, rounds, warnings, totalDuration: cursor, spec: QUIZ_SPEC,
    fitReports: rounds.map((r) => r.fitReport),
    narration: rounds.map((r) => r.narration),
    animations,
    // Without batch fonts, the batch fonts are the minimum across rounds.
    fonts: fonts || {
      question: rounds.length ? Math.min(...rounds.map((r) => r.fitReport.questionFont)) : 0,
      option: rounds.length ? Math.min(...rounds.map((r) => r.fitReport.optionFont)) : 0,
      explanation: rounds.length ? Math.min(...rounds.map((r) => r.fitReport.explanationFont)) : 0,
    },
  };
}

module.exports = {
  QUIZ_COLUMNS, QUIZ_SPEC, DIFFICULTY_RANK, MIN_FONTS, minFontsFor,
  safeBoxFor, isRtl, checkCaps,
  charWidth, textWidth, wrapLines, fitText, fitAtFont, uniformFont,
  parseQuestion, layoutRound, buildQuizTimeline,
  ANIM_TYPES, ANIM_ELEMENTS, DEFAULT_ANIMATIONS, OPTION_STAGGER_DEFAULT,
  validateAnimations, resolveAnimations, buildNarrationPlan,
};
