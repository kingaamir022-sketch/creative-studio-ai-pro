'use strict';
// Phase 4 tests — run with: npm test
// Spawns the real server on a scratch port with a temp DB/uploads dir.
// Covers: dedupe (whole-row + key-column, never regenerated), XLSX/CSV
// parsing of real files, column detection + mapping validation, background
// assignment (no-repeat + pool exhaustion), template substitution + fit,
// quiz auto-fit + uniform fonts + overflow proof, end-to-end small batches
// (real MP4s via FFmpeg, ffprobe-validated, different backgrounds), failed
// row retry, ZIP export, bulk design PNGs, per-user isolation, and the
// viewer quality gate (thumbnail pixel checks + safe zones).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const XLSX = require('xlsx');
const {
  dedupeRows, dedupeColumns, validateDataset, assignBackgrounds,
  buildRowTimeline, substituteDesign,
} = require('../src/bulk-model');
const {
  parseQuestion, layoutRound, buildQuizTimeline, fitText, uniformFont,
} = require('../src/quiz-model');
const { blankTimeline, defaultClip, validateTimeline } = require('../src/video-model');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-bulk-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4834;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let ownerCookie = '';
let userCookie = '';

function req(path, { method = 'GET', body, cookie, form } = {}) {
  // No keep-alive reuse: after a long idle gap (a render) the server
  // may have closed the connection and the next fetch gets EPIPE.
  const headers = { connection: 'close' };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) { payload = form; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' })
    .then(async (r) => {
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, text, headers: r.headers, setCookie: r.headers.get('set-cookie') || '' };
    });
}

function ffprobe(file) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', file],
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
  });
}

function makeTestVideo(file, seconds, tone) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x180:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
    { timeout: 60000 });
}

function makeTestImage(file, color) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:d=1`, '-frames:v', '1', file],
    { timeout: 30000 });
}

// One pixel from a video frame, as [r, g, b]. The format=rgb24 step first
// matters: a 1x1 crop straight from a yuv420p frame fails (chroma
// subsampling needs even dimensions), so convert to full-res RGB, then crop.
function readPixel(file, time, x, y) {
  const out = execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(time), '-i', file,
    '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { timeout: 30000, maxBuffer: 1024 * 1024 });
  return [out[0], out[1], out[2]];
}

function extractFrame(file, time, outFile) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', outFile],
    { timeout: 30000 });
}

async function uploadMedia(file, name, mime) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime }), name);
  const r = await req('/api/media/upload', { method: 'POST', cookie: ownerCookie, form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.media;
}

async function waitForBulkJob(jobId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const r = await req(`/api/bulk/${jobId}`, { cookie: ownerCookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    last = r.json;
    if (['done', 'partial', 'failed', 'cancelled'].includes(last.job.status)) return last;
    if (Date.now() > deadline) throw new Error(`bulk job ${jobId} did not finish; last ${JSON.stringify(last.job)}`);
    await new Promise((x) => setTimeout(x, 700));
  }
}

async function downloadBulkRow(jobId, rowId) {
  const r = await fetch(BASE + `/api/bulk/${jobId}/rows/${rowId}/download`, { headers: { cookie: ownerCookie }, redirect: 'manual' });
  assert.equal(r.status, 200, `download row ${rowId}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

let bgVideoA, bgVideoB, bgImageBlue, bgImageRed, productImg;

before(async () => {
  const va = path.join(tmp, 'bg-a.mp4');
  const vb = path.join(tmp, 'bg-b.mp4');
  const ib = path.join(tmp, 'bg-blue.png');
  const ir = path.join(tmp, 'bg-red.png');
  const pi = path.join(tmp, 'product.png');
  makeTestVideo(va, 4, 440);
  makeTestVideo(vb, 4, 880);
  makeTestImage(ib, '0x1e40af');
  makeTestImage(ir, '0x991b1b');
  makeTestImage(pi, '0x166534');
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, HOST: '127.0.0.1', RENDER_CONCURRENCY: '1' },
    stdio: 'pipe',
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start in time');
    await new Promise((r) => setTimeout(r, 200));
  }
  const a = await req('/api/auth/signup', { method: 'POST', body: { name: 'Owner', email: 'owner@test.local', password: 'password123' } });
  assert.equal(a.status, 201);
  ownerCookie = a.setCookie.split(';')[0];
  const b = await req('/api/auth/signup', { method: 'POST', body: { name: 'User', email: 'user@test.local', password: 'password123' } });
  assert.equal(b.status, 201);
  userCookie = b.setCookie.split(';')[0];
  bgVideoA = await uploadMedia(va, 'bg-a.mp4', 'video/mp4');
  bgVideoB = await uploadMedia(vb, 'bg-b.mp4', 'video/mp4');
  bgImageBlue = await uploadMedia(ib, 'bg-blue.png', 'image/png');
  bgImageRed = await uploadMedia(ir, 'bg-red.png', 'image/png');
  productImg = await uploadMedia(pi, 'product.png', 'image/png');
});

after(() => {
  if (server) server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ---------------- Dedupe (pure) ---------------- */
const SIX_ROWS = [
  { PRODUCT_NAME: 'Shoes', PRICE: '2500', DESCRIPTION: 'Running shoes' },
  { PRODUCT_NAME: 'Shoes', PRICE: '2500', DESCRIPTION: 'Running shoes' }, // dup of row 1
  { PRODUCT_NAME: 'Hat', PRICE: '900', DESCRIPTION: 'Sun hat' },
  { PRODUCT_NAME: 'Socks', PRICE: '300', DESCRIPTION: 'Cotton socks' },
  { PRODUCT_NAME: 'Bag', PRICE: '1800', DESCRIPTION: 'Travel bag' },
  { PRODUCT_NAME: 'Hat', PRICE: '900', DESCRIPTION: 'Sun hat' }, // dup of row 3
];

test('dedupe: whole-row — 6 rows with 2 duplicates -> 4 unique, skipped rows named', () => {
  const r = dedupeRows(SIX_ROWS, { mode: 'whole-row' });
  assert.deepEqual(r.unique, [0, 2, 3, 4]);
  assert.equal(r.skipped.length, 2);
  assert.deepEqual(r.skipped.map((s) => s.rowNumber), [2, 6]);
  assert.deepEqual(r.skipped.map((s) => s.duplicateOfRowNumber), [1, 3]);
  // Trim + case-insensitive: '  shoes ' with 'running SHOES' still matches row 1.
  const norm = dedupeRows([
    { PRODUCT_NAME: 'Shoes', PRICE: '2500', DESCRIPTION: 'Running shoes' },
    { PRODUCT_NAME: '  shoes ', PRICE: '2500', DESCRIPTION: 'running SHOES' },
  ], { mode: 'whole-row' });
  assert.equal(norm.skipped.length, 1, 'normalised duplicates are caught');
});

test('dedupe: key-column — same name, different price still counts as duplicate', () => {
  const rows = [
    { PRODUCT_NAME: 'Shoes', PRICE: '2500' },
    { PRODUCT_NAME: 'Shoes', PRICE: '1999' }, // same key, different price
    { PRODUCT_NAME: 'Hat', PRICE: '900' },
  ];
  const r = dedupeRows(rows, { mode: 'key', keyColumn: 'PRODUCT_NAME' });
  assert.deepEqual(r.unique, [0, 2]);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].duplicateOfRowNumber, 1);
  assert.throws(() => dedupeRows(rows, { mode: 'key' }), /key column/i);
});

test('dedupe: validation flags missing values per row', () => {
  const { errors, rowIssues } = validateDataset(['PRODUCT_NAME', 'PRICE'], [
    { PRODUCT_NAME: 'Shoes', PRICE: '2500' },
    { PRODUCT_NAME: 'Hat', PRICE: '' },
  ]);
  assert.deepEqual(errors, []);
  assert.equal(rowIssues.length, 1);
  assert.equal(rowIssues[0].rowNumber, 2);
  assert.deepEqual(rowIssues[0].missing, ['PRICE']);
});

/* ---------------- Background assignment (pure) ---------------- */
test('backgrounds: no-repeat within a batch, pool exhaustion reshuffles with a warning', () => {
  const rows = [{}, {}, {}, {}];
  // Pure test with stable ids (no server needed — ids are just integers here).
  const ids = [11, 22, 33];
  const out = assignBackgrounds(rows, { mode: 'random', pool: ids, repeatRule: 'no-repeat' });
  assert.equal(out.length, 4);
  const firstThree = out.slice(0, 3).map((o) => o.mediaId);
  assert.equal(new Set(firstThree).size, 3, 'first three rows all get different backgrounds');
  assert.equal(out[0].warning, null);
  assert.ok(out[3].warning && out[3].warning.includes('reused'), 'the 4th row (pool exhausted) carries a reuse warning');
  assert.ok(ids.includes(out[3].mediaId));
});

test('backgrounds: after-N rule never repeats inside the window; AI modes refuse honestly', () => {
  const rows = [{}, {}, {}, {}, {}];
  const out = assignBackgrounds(rows, { mode: 'random', pool: [1, 2, 3, 4, 5], repeatRule: 'after-n', repeatAfterN: 3 });
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < Math.min(out.length, i + 3); j++) {
      assert.notEqual(out[i].mediaId, out[j].mediaId, `rows ${i + 1} and ${j + 1} must not repeat within 3`);
    }
  }
  // Pool smaller than the window: a repeat is unavoidable — it must carry a warning, not fail silently.
  const small = assignBackgrounds([{}, {}, {}, {}], { mode: 'random', pool: [1, 2, 3], repeatRule: 'after-n', repeatAfterN: 3 });
  assert.ok(small.some((o) => o.warning && o.warning.includes('repeat')), 'small pool warns that a background repeated sooner');
  assert.throws(() => assignBackgrounds([{}], { mode: 'ai', pool: [1] }), /Phase 7/);
  assert.throws(() => assignBackgrounds([{}], { mode: 'prompt', pool: [1] }), /Phase 7/);
  assert.throws(() => assignBackgrounds([{}, {}], { mode: 'manual', manual: { 0: 5 } }), /missing for row 2/i);
});

/* ---------------- Template substitution + fit (pure) ---------------- */
function productTemplate() {
  const tl = blankTimeline('16:9', 30);
  const bg = defaultClip('video', bgVideoA.id, 0, 1);
  bg.name = 'Background';
  bg.isBackground = true;
  const tx = defaultClip('text', null, 0, 1);
  tx.text = { ...tx.text, text: '{{PRODUCT_NAME}} — {{PRODUCT_PRICE}}', fontSize: 48, align: 'center' };
  tl.tracks[0].clips.push(bg);
  tl.tracks[2].clips.push(tx);
  return tl;
}

test('template substitution: {{fields}} replaced per row, fit report attached', () => {
  const tl = productTemplate();
  const built = buildRowTimeline(tl, { PRODUCT_NAME: 'Running Shoes', PRODUCT_PRICE: 'Rs 2,500' },
    { fieldMapping: { PRODUCT_NAME: 'PRODUCT_NAME', PRODUCT_PRICE: 'PRODUCT_PRICE' } });
  const textClip = built.timeline.tracks[2].clips[0];
  assert.ok(textClip.text.text.includes('Running Shoes'), 'product name substituted');
  assert.ok(textClip.text.text.includes('Rs 2,500'), 'price substituted');
  assert.ok(built.fitReport, 'fit report present');
  assert.equal(built.fitReport.overall, 'OK');
  // A very long product name shrinks instead of overflowing its box.
  // (~180 chars: at 48px it needs more than the 3 allowed lines, so the
  // wrap-first-then-shrink fit must reduce the font.)
  const long = buildRowTimeline(productTemplate(), { PRODUCT_NAME: 'Super Ultra Mega Deluxe Limited Edition Running Shoes With Extra Long Name For Testing Purposes Only And Even More Words To Make This Product Name Extremely Long', PRODUCT_PRICE: 'Rs 2,500' },
    { fieldMapping: { PRODUCT_NAME: 'PRODUCT_NAME', PRODUCT_PRICE: 'PRODUCT_PRICE' } });
  const longClip = long.timeline.tracks[2].clips[0];
  assert.ok(longClip.text.fontSize < 48, `long text shrank from 48 to ${longClip.text.fontSize}`);
  assert.ok(['Adjusted', 'Needs attention'].includes(long.fitReport.overall));
});

/* ---------------- Quiz model (pure) ---------------- */
const SHORT_Q = { QUESTION: 'What is 2 + 2?', OPTION_A: '3', OPTION_B: '4', OPTION_C: '5', OPTION_D: '6', CORRECT: 'B', EXPLANATION: '2 + 2 = 4.', CATEGORY: 'Maths', DIFFICULTY: 'easy', TIMER_SECONDS: 5 };
const LONG_Q = {
  QUESTION: 'Which of the following statements most accurately describes the primary reason why the ancient city of Rome, which was founded on the banks of the river Tiber, eventually grew to become the capital of one of the largest empires the ancient world had ever seen?',
  OPTION_A: 'A short answer',
  OPTION_B: 'A considerably longer option that explains the trade routes and military strategy in some detail for the reader',
  OPTION_C: 'Another very long option about the political system and the senate and the way laws were made in Rome',
  OPTION_D: 'Yes',
  CORRECT: 'B', EXPLANATION: 'Trade and military power built the empire over centuries of expansion.',
  CATEGORY: 'History', DIFFICULTY: 'hard', TIMER_SECONDS: 5,
};

test('quiz: parseQuestion accepts letter and option-text CORRECT; auto-fit shrinks long text', () => {
  const byLetter = parseQuestion(SHORT_Q, 0);
  assert.equal(byLetter.correctIndex, 1);
  const byText = parseQuestion({ ...SHORT_Q, CORRECT: '4' }, 0);
  assert.equal(byText.correctIndex, 1, 'CORRECT as option text resolves to the same index');
  assert.throws(() => parseQuestion({ QUESTION: 'x', OPTION_A: 'a', OPTION_B: 'b', CORRECT: 'Z' }, 0), /CORRECT/);
  const shortFit = fitText(SHORT_Q.QUESTION, 640, { maxFont: 62, minFont: 19, maxLines: 4 });
  const longFit = fitText(LONG_Q.QUESTION, 640, { maxFont: 62, minFont: 19, maxLines: 4 });
  assert.ok(longFit.fontSize < shortFit.fontSize, `long question font ${longFit.fontSize} < short ${shortFit.fontSize}`);
});

test('quiz: uniform font — all four options share one size, set by the longest', () => {
  const q = parseQuestion(LONG_Q, 0);
  const L = layoutRound(q, { W: 720, H: 1280 });
  const fonts = L.optionBoxes.map((b) => b.fontSize);
  assert.ok(fonts.every((f) => f === fonts[0]), `all options equal font: ${fonts.join(', ')}`);
  assert.ok(L.inBounds, 'all option boxes inside the frame and above the caption reserve');
  assert.ok(L.fitReport.optionFont <= L.fitReport.questionFont, 'options never bigger than the question');
  // Uniform-font helper directly: different lengths, one size.
  const u = uniformFont([
    { key: 'A', text: 'A. Yes' },
    { key: 'B', text: 'B. A considerably longer option that explains the trade routes and military strategy in some detail' },
    { key: 'C', text: 'C. No' },
    { key: 'D', text: 'D. Maybe' },
  ], 280, { maxFont: 38, minFont: 16, maxLines: 2 });
  assert.ok(u.font < 38, 'the long option pulled the shared size down');
  assert.deepEqual(Object.keys(u.linesByKey).sort(), ['A', 'B', 'C', 'D']);
});

test('quiz: overflow proof — 200+ char question and 80+ char options stay in bounds', () => {
  const huge = parseQuestion({
    QUESTION: 'X'.repeat(40) + ' ' + 'word '.repeat(40),
    OPTION_A: 'A'.repeat(85), OPTION_B: 'B'.repeat(90), OPTION_C: 'C'.repeat(80), OPTION_D: 'D'.repeat(95),
    CORRECT: 'A', EXPLANATION: 'E'.repeat(120), CATEGORY: 'Test', DIFFICULTY: 'medium', TIMER_SECONDS: 5,
  }, 0);
  const L = layoutRound(huge, { W: 720, H: 1280 });
  assert.ok(L.inBounds, 'even the huge question keeps every box in bounds');
  assert.ok(L.qBox.y + L.qBox.h <= L.gridY, 'question box does not run into the grid');
  assert.ok(L.fitReport.questionFont >= 19, 'question never goes below the readable minimum (19px @720w)');
  assert.ok(L.fitReport.optionFont >= 16, 'options never go below the readable minimum (16px @720w)');
  // Render input bounds: every text clip x/y (percent) stays on frame.
  // (Text now lives on one lane per simultaneous element — chip, question,
  // countdown, one per option, explanation, score — so collect all of them.)
  const built = buildQuizTimeline([huge], { W: 720, H: 1280, readSeconds: 2, revealSeconds: 2, ctaSeconds: 3 });
  const allText = built.timeline.tracks.filter((t) => t.kind === 'text').flatMap((t) => t.clips);
  assert.ok(allText.length > 10, `all text lanes carry clips (${allText.length})`);
  for (const clip of allText) {
    assert.ok(clip.text.x >= 0 && clip.text.x <= 100, `text clip ${clip.id} x=${clip.text.x} in frame`);
    assert.ok(clip.text.y >= 0 && clip.text.y <= 100, `text clip ${clip.id} y=${clip.text.y} in frame`);
    assert.ok(clip.text.fontSize >= 8, `text clip ${clip.id} font ${clip.text.fontSize} readable`);
  }
  // The built timeline is valid for the Phase 3 renderer (no overlapping
  // clips on any one track).
  assert.deepEqual(validateTimeline(built.timeline), [], 'quiz timeline passes Phase 3 validation');
});

test('quiz: reveal segment + correct-option green highlight in the render data', () => {
  const q = parseQuestion({ ...SHORT_Q, TIMER_SECONDS: 3 }, 0);
  const built = buildQuizTimeline([q], { W: 720, H: 1280, readSeconds: 2, revealSeconds: 2, ctaSeconds: 3 });
  // Spec timing: 2s read + 3s countdown + 2s reveal + 3s score card = 10s.
  assert.equal(built.totalDuration, 2 + 3 + 2 + 3, 'duration = read + countdown + reveal + score card');
  assert.equal(built.rounds.length, 1);
  assert.equal(built.rounds[0].readSeconds, 2);
  assert.equal(built.rounds[0].countdownStart, 2, 'countdown starts after the 2s read');
  assert.equal(built.rounds[0].revealStart, 5);
  assert.equal(built.rounds[0].revealSeconds, 2);
  const allText = built.timeline.tracks.filter((t) => t.kind === 'text').flatMap((t) => t.clips);
  const reveal = allText.filter((c) => c.id.includes('_r'));
  assert.equal(reveal.length, 4, 'one reveal clip per option');
  const correct = reveal.find((c) => c.id === 'clip_opt_0_1_r');
  assert.equal(correct.text.panel.fill, '#16a34a', 'correct option gets the green panel');
  assert.equal(correct.text.alpha, 1);
  assert.ok(correct.text.text.startsWith('✓'), 'correct option carries the tick (never colour alone)');
  const wrong = reveal.find((c) => c.id === 'clip_opt_0_0_r');
  assert.equal(wrong.text.alpha, 0.45, 'wrong options dim to 0.45');
  assert.ok(wrong.text.text.startsWith('✗'), 'wrong options carry the cross');
  assert.equal(correct.text.animIn, 'pop', 'answer reveal pops (auto default — user rule 2026-11-12: answer reveal pop + highlight; supersedes the Phase 4 fade)');
  // Score card: the final 3s segment asks for the score.
  const score = allText.find((c) => c.id === 'clip_cta');
  assert.ok(score, 'score card clip present');
  assert.equal(score.start, 7, 'score card starts after the round');
  assert.equal(score.duration, 3, 'score card runs 3s');
  assert.ok(score.text.text.includes('Kitne sahi hue?'), 'score card asks for the score');
  // Batch fonts: the long question sets the size for the whole batch.
  const built2 = buildQuizTimeline([parseQuestion(SHORT_Q, 0), parseQuestion(LONG_Q, 1)], { W: 720, H: 1280, readSeconds: 2, revealSeconds: 2, ctaSeconds: 3 });
  assert.equal(built2.rounds.length, 2);
  assert.equal(built2.fonts.option, Math.min(...built2.rounds.map((r) => r.fitReport.optionFont)), 'batch option font is the minimum across rounds');
  // Spec defaults: navy background, amber accent.
  assert.equal(built.timeline.background, '#14213D', 'spec navy background');
  const chip = allText.find((c) => c.id === 'clip_chip_0');
  assert.equal(chip.text.color, '#FCA311', 'chip uses the amber accent');
});

test('quiz: research spec — stacked options inside the safe box, spec fonts', () => {
  const q = parseQuestion(SHORT_Q, 0);
  const L = layoutRound(q, { W: 720, H: 1280 });
  // Safe box at 720x1280: x32-592, y192-832 (spec x48-888, y288-1248 @1080x1920).
  assert.deepEqual(L.safeBox, { x: 32, y: 192, w: 560, h: 640 }, 'safe box scales from the spec box');
  // Stacked full-width list: same x and width, increasing y (no 2x2 grid).
  assert.ok(L.stacked, 'options are a stacked list, not a 2x2 grid');
  assert.ok(L.optionBoxes.every((b) => b.x === L.margin && b.w === L.boxW), 'every option spans the full safe-box width');
  const ys = L.optionBoxes.map((b) => b.y);
  assert.ok(ys.every((y, i) => i === 0 || y > ys[i - 1]), `option rows stack downwards: ${ys.join(', ')}`);
  // Everything essential inside the safe box.
  const inside = (b) => b.x >= L.safeBox.x && b.y >= L.safeBox.y && b.x + b.w <= L.safeBox.x + L.safeBox.w && b.y + b.h <= L.safeBox.y + L.safeBox.h;
  assert.ok(inside(L.qBox), 'question box inside the safe box');
  assert.ok(L.optionBoxes.every(inside), 'every option inside the safe box');
  assert.ok(L.qBox.y >= L.safeBox.y && L.gridBottom <= L.safeBox.y + L.safeBox.h, 'flow stays inside the safe box');
  // Spec typography: question max 96px @720w (cap ~100px @1080w), options
  // max 54px @720w (cap ~57px @1080w).
  assert.equal(L.fitReport.question.from, 96, 'question max font is the spec 96px @720w');
  assert.equal(L.fitReport.options.from, 54, 'option max font is the spec 54px @720w');
  assert.ok(L.fitReport.balanced, 'layout is balanced inside the safe box');
});

test('quiz: text caps — over-cap question/option gets Needs attention first', () => {
  const overQ = parseQuestion({
    QUESTION: 'This is a deliberately over-long quiz question that runs past eighty characters so the cap warning must fire before any shrinking happens at all.',
    OPTION_A: 'Short', OPTION_B: 'Also short', OPTION_C: 'C', OPTION_D: 'D', CORRECT: 'A',
  }, 0);
  assert.ok(overQ.caps.exceeded, '90+ char question exceeds the 80-char cap');
  assert.ok(overQ.caps.messages.some((m) => m.includes('80')), 'cap message names the 80-char limit');
  const L = layoutRound(overQ, { W: 720, H: 1280 });
  assert.equal(L.fitReport.overall, 'Needs attention', 'over-cap row is Needs attention, not silently shrunk');
  assert.ok(L.fitReport.caps && L.fitReport.caps.exceeded, 'fit report carries the caps result');
  const overOpt = parseQuestion({
    QUESTION: 'Short question?', OPTION_A: 'A very long option that is far over twenty-two characters', OPTION_B: 'B', OPTION_C: 'C', OPTION_D: 'D', CORRECT: 'A',
  }, 0);
  assert.ok(overOpt.caps.exceeded, '25+ char option exceeds the 22-char cap');
  assert.ok(overOpt.caps.messages.some((m) => m.includes('22')), 'cap message names the 22-char limit');
  // Within caps: no warning.
  const okQ = parseQuestion(SHORT_Q, 0);
  assert.equal(okQ.caps.exceeded, false, 'short question and options are within caps');
});

test('quiz: RTL — Arabic question mirrors the layout and uses the Arabic font', () => {
  const q = parseQuestion({
    QUESTION: 'ما هي عاصمة فرنسا؟', OPTION_A: 'باريس', OPTION_B: 'لندن', OPTION_C: 'مدريد', OPTION_D: 'روما', CORRECT: 'A',
    EXPLANATION: 'باريس هي العاصمة.', CATEGORY: 'جغرافيا', DIFFICULTY: 'easy', TIMER_SECONDS: 3,
  }, 0);
  assert.equal(q.rtl, true, 'Arabic question detected as RTL');
  const L = layoutRound(q, { W: 720, H: 1280 });
  assert.equal(L.rtl, true, 'layout reports RTL');
  assert.ok(L.inBounds, 'RTL layout stays in bounds');
  const built = buildQuizTimeline([q], { W: 720, H: 1280, readSeconds: 2, revealSeconds: 2, ctaSeconds: 3 });
  const allText = built.timeline.tracks.filter((t) => t.kind === 'text').flatMap((t) => t.clips);
  const qClip = allText.find((c) => c.id === 'clip_q_0');
  assert.equal(qClip.text.fontFamily, 'Noto Kufi Arabic', 'RTL question renders in Noto Kufi Arabic');
  const optQ = allText.find((c) => c.id === 'clip_opt_0_0_q');
  assert.equal(optQ.text.align, 'right', 'RTL options are right-aligned');
  assert.deepEqual(validateTimeline(built.timeline), [], 'RTL timeline passes validation');
});

/* ---------------- API: dataset import + dedupe ---------------- */
async function makeVideoProject(name) {
  const tl = productTemplate();
  const created = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name, type: 'video', content: { timeline: tl } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.project.id;
}

async function createBulkJob(name, kind, templateProjectId, settings) {
  const r = await req('/api/bulk', { method: 'POST', cookie: ownerCookie, body: { name, kind, templateProjectId, settings: settings || {} } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.job;
}

function uploadDatasetForm(jobId, filePath, fileName) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)], { type: 'application/octet-stream' }), fileName);
  return req(`/api/bulk/${jobId}/dataset`, { method: 'POST', cookie: ownerCookie, form });
}

const PRODUCT_CSV = `PRODUCT_NAME,PRODUCT_PRICE,DESCRIPTION,CATEGORY
Shoes,2500,Running shoes,Sports
Shoes,2500,Running shoes,Sports
Hat,900,Sun hat,Fashion
Socks,300,Cotton socks,Fashion
Bag,1800,Travel bag,Fashion
Hat,900,Sun hat,Fashion`;

let videoProjectId;
let bulkJobId;

test('API: XLSX upload parses a real file; duplicates skipped, counts reported', async () => {
  videoProjectId = await makeVideoProject('Bulk Template');
  bulkJobId = (await createBulkJob('Bulk Test', 'video', videoProjectId)).id;
  // A real .xlsx file, written by the xlsx library.
  const xlsxPath = path.join(tmp, 'products.xlsx');
  const ws = XLSX.utils.aoa_to_sheet([
    ['PRODUCT_NAME', 'PRODUCT_PRICE', 'DESCRIPTION', 'CATEGORY'],
    ['Shoes', 2500, 'Running shoes', 'Sports'],
    ['Shoes', 2500, 'Running shoes', 'Sports'],
    ['Hat', 900, 'Sun hat', 'Fashion'],
    ['Socks', 300, 'Cotton socks', 'Fashion'],
    ['Bag', 1800, 'Travel bag', 'Fashion'],
    ['Hat', 900, 'Sun hat', 'Fashion'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Products');
  XLSX.writeFile(wb, xlsxPath);
  const up = await uploadDatasetForm(bulkJobId, xlsxPath, 'products.xlsx');
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.deepEqual(up.json.dataset.columns, ['PRODUCT_NAME', 'PRODUCT_PRICE', 'DESCRIPTION', 'CATEGORY'], 'columns auto-detected from the header row');
  assert.equal(up.json.dedupeSummary.total, 6);
  assert.equal(up.json.dedupeSummary.unique, 4, '6 rows, 2 duplicates -> 4 unique');
  assert.equal(up.json.dedupeSummary.skipped, 2);
  assert.deepEqual(up.json.dedupeSummary.skippedRows.map((s) => s.rowNumber), [2, 6]);
  assert.deepEqual(up.json.dedupeSummary.skippedRows.map((s) => s.duplicateOfRowNumber), [1, 3]);
  const skipped = up.json.rows.filter((r) => r.status === 'skipped');
  assert.equal(skipped.length, 2);
  assert.ok(up.json.rows.filter((r) => r.status !== 'skipped').length === 4);
});

test('API: CSV upload parses the same data; mapping validation rejects bad columns', async () => {
  const job = await createBulkJob('CSV Test', 'video', videoProjectId);
  const csvPath = path.join(tmp, 'products.csv');
  fs.writeFileSync(csvPath, PRODUCT_CSV);
  const up = await uploadDatasetForm(job.id, csvPath, 'products.csv');
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.dedupeSummary.unique, 4);
  // Mapping a field to a column that is not in the dataset is rejected.
  const badMap = await req(`/api/bulk/${job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { fieldMapping: { PRODUCT_NAME: 'NO_SUCH_COLUMN' } } } });
  assert.equal(badMap.status, 400);
  assert.ok(badMap.json.error.includes('NO_SUCH_COLUMN'));
  // A valid mapping saves, and a bad key column is rejected too.
  const goodMap = await req(`/api/bulk/${job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { fieldMapping: { PRODUCT_NAME: 'PRODUCT_NAME', PRODUCT_PRICE: 'PRODUCT_PRICE' } } } });
  assert.equal(goodMap.status, 200, JSON.stringify(goodMap.json));
  const badKey = await req(`/api/bulk/${job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { dedupe: { mode: 'key', keyColumn: 'MISSING_COL' } } } });
  assert.equal(badKey.status, 400);
});

test('API: key-column dedupe — same name, different price still skips', async () => {
  const job = await createBulkJob('Key Dedupe', 'video', videoProjectId);
  const csv = `PRODUCT_NAME,PRODUCT_PRICE\nShoes,2500\nShoes,1999\nHat,900`;
  const up = await req(`/api/bulk/${job.id}/dataset`, { method: 'POST', cookie: ownerCookie, body: { text: csv } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.dedupeSummary.unique, 3, 'whole-row dedupe keeps all three (prices differ)');
  const patched = await req(`/api/bulk/${job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { dedupe: { mode: 'key', keyColumn: 'PRODUCT_NAME' } } } });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(patched.json.dedupeSummary.unique, 2, 'key-column dedupe drops the second Shoes row');
  assert.equal(patched.json.dedupeSummary.skipped, 1);
  const rows = await req(`/api/bulk/${job.id}/rows`, { cookie: ownerCookie });
  assert.equal(rows.json.rows.filter((r) => r.status === 'skipped').length, 1);
});

test('API: background assignment — no-repeat per row; AI modes refuse honestly', async () => {
  // Map the fields, then assign from a 3-item pool for 4 unique rows.
  await req(`/api/bulk/${bulkJobId}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { fieldMapping: { PRODUCT_NAME: 'PRODUCT_NAME', PRODUCT_PRICE: 'PRODUCT_PRICE' } } } });
  await req(`/api/bulk/${bulkJobId}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { background: { mode: 'random', poolMediaIds: [bgVideoA.id, bgVideoB.id, bgImageBlue.id], repeatRule: 'no-repeat' } } } });
  const assigned = await req(`/api/bulk/${bulkJobId}/assign`, { method: 'POST', cookie: ownerCookie });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.json));
  const unique = assigned.json.rows.filter((r) => r.status !== 'skipped');
  assert.equal(unique.length, 4);
  assert.ok(unique.every((r) => r.backgroundMediaId), 'every unique row got a background');
  const firstThree = unique.slice(0, 3).map((r) => r.backgroundMediaId);
  assert.equal(new Set(firstThree).size, 3, 'first three rows: three different backgrounds');
  // AI mode cannot start a batch without a key.
  const aiJob = await createBulkJob('AI Refusal', 'video', videoProjectId);
  await req(`/api/bulk/${aiJob.id}/dataset`, { method: 'POST', cookie: ownerCookie, body: { text: 'PRODUCT_NAME,PRODUCT_PRICE\nShoes,2500' } });
  await req(`/api/bulk/${aiJob.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { background: { mode: 'ai', poolMediaIds: [bgVideoA.id] } } } });
  const start = await req(`/api/bulk/${aiJob.id}/start`, { method: 'POST', cookie: ownerCookie });
  assert.equal(start.status, 400);
  assert.ok(start.json.error.includes('Phase 7'), `AI refusal names Phase 7: ${start.json.error}`);
  // Google Sheets is honest about needing OAuth (Phase 8: real Google
  // OAuth; unconfigured here, so the import is unavailable).
  const sheets = await req('/api/bulk/sheets-info', { cookie: ownerCookie });
  assert.equal(sheets.status, 200);
  assert.equal(sheets.json.available, false);
  assert.ok(sheets.json.reason.includes('Google OAuth'));
});

test('API: fit-check — per-row fit reports, batch-uniform fonts, outlier flagged', async () => {
  const job = await createBulkJob('Fit Check Job', 'video', videoProjectId);
  // Row 2 (~150 chars) forces the whole batch's PRODUCT_NAME font below the
  // template's 48; row 4 (~700 chars) cannot fit even at the readable
  // minimum with extended lines and must be flagged "Needs attention".
  const veryLong = 'Very long product name '.repeat(30);
  const csv = `PRODUCT_NAME,PRODUCT_PRICE\nShort,100\nA very long product name that keeps going and going and going and going and going and going and going and going and going and going and going and going,200\nMedium name here,300\n${veryLong},400`;
  await req(`/api/bulk/${job.id}/dataset`, { method: 'POST', cookie: ownerCookie, body: { text: csv } });
  await req(`/api/bulk/${job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { fieldMapping: { PRODUCT_NAME: 'PRODUCT_NAME', PRODUCT_PRICE: 'PRODUCT_PRICE' } } } });
  const fc = await req(`/api/bulk/${job.id}/fit-check`, { method: 'POST', cookie: ownerCookie });
  assert.equal(fc.status, 200, JSON.stringify(fc.json));
  assert.equal(fc.json.counts.ok + fc.json.counts.adjusted + fc.json.counts.attention, 4);
  const rows = fc.json.rows;
  assert.ok(rows.every((r) => r.fitReport), 'every row carries a fit report');
  // Uniform font: the PRODUCT_NAME element font is the same on every row,
  // and the long row pulled it below the template's 48 (batch-level adjust).
  const nameFonts = rows.map((r) => {
    const el = (r.fitReport.elements || []).find((e) => e.fields && e.fields.includes('PRODUCT_NAME'));
    return el ? el.to : null;
  });
  assert.ok(nameFonts.every((f) => f !== null), 'each row reports its PRODUCT_NAME font');
  assert.ok(nameFonts.every((f) => f === nameFonts[0]), `batch-uniform PRODUCT_NAME font: ${nameFonts.join(', ')}`);
  assert.ok(nameFonts[0] < 48, `the long row pulled the batch font below the template 48 (got ${nameFonts[0]})`);
  // The outlier row (350+ chars) is flagged Needs attention with a suggestion.
  const outlier = rows.find((r) => r.rowIndex === 3);
  assert.equal(outlier.fitReport.overall, 'Needs attention', `outlier row fit: ${outlier.fitReport.overall}`);
  assert.ok(outlier.fitReport.suggestedText, 'outlier carries a suggested shorter text');
});

/* ---------------- End-to-end: bulk video ---------------- */
test('e2e bulk video: start -> 4 unique MP4s, ffprobe-valid, backgrounds differ', async () => {
  const start = await req(`/api/bulk/${bulkJobId}/start`, { method: 'POST', cookie: ownerCookie });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const finished = await waitForBulkJob(bulkJobId);
  assert.equal(finished.job.status, 'done', `job finished as ${finished.job.status}; rows: ${JSON.stringify(finished.rows.map((r) => [r.rowNumber, r.status, r.error]))}`);
  assert.equal(finished.job.rowsDone, 4);
  assert.equal(finished.job.rowsFailed, 0);
  const done = finished.rows.filter((r) => r.status === 'done');
  assert.equal(done.length, 4);
  // Skipped duplicates have no output and no job — permanently.
  const skipped = finished.rows.filter((r) => r.status === 'skipped');
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((r) => !r.outputJobId && !r.hasOutput), 'skipped rows got no job and no output');
  assert.equal(finished.job.dedupeSummary.skipped, 2, 'job report says 2 duplicates skipped');
  // Every output is a real MP4; the first three used different backgrounds.
  const hashes = [];
  for (const r of done) {
    const buf = await downloadBulkRow(bulkJobId, r.id);
    assert.ok(buf.length > 1000, `row ${r.rowNumber} MP4 is a real file (${buf.length} bytes)`);
    const outFile = path.join(tmp, `bulk-row-${r.rowNumber}.mp4`);
    fs.writeFileSync(outFile, buf);
    const probe = await ffprobe(outFile);
    const video = probe.streams.find((s) => s.codec_type === 'video');
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.width, 1280);
    assert.equal(video.height, 720);
    assert.ok(Math.abs(parseFloat(probe.format.duration) - 1) < 0.75, `row ${r.rowNumber} duration ${probe.format.duration}, expected ~1s`);
    hashes.push(crypto.createHash('sha256').update(buf).digest('hex'));
  }
  assert.equal(new Set(hashes).size, 4, 'all four outputs differ (different backgrounds/text)');
  const bgIds = done.slice(0, 3).map((r) => r.backgroundMediaId);
  assert.equal(new Set(bgIds).size, 3, 'first three rows used three different backgrounds');
});

test('e2e: ZIP export contains all 4 outputs', async () => {
  const zipRes = await fetch(BASE + `/api/bulk/${bulkJobId}/zip`, { headers: { cookie: ownerCookie }, redirect: 'manual' });
  assert.equal(zipRes.status, 200, `zip status ${zipRes.status}`);
  assert.ok((zipRes.headers.get('content-type') || '').includes('zip'));
  const zipPath = path.join(tmp, 'bulk.zip');
  fs.writeFileSync(zipPath, Buffer.from(await zipRes.arrayBuffer()));
  const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  const names = listing.split('\n').filter((l) => l.trim().endsWith('.mp4')).map((l) => l.trim().split(/\s+/).pop());
  assert.equal(names.length, 4, `zip lists 4 MP4s, got: ${listing}`);
});

test('e2e: failed-row retry works; skipped duplicates are never retried', async () => {
  const job = await createBulkJob('Retry Test', 'video', videoProjectId);
  await req(`/api/bulk/${job.id}/dataset`, { method: 'POST', cookie: ownerCookie, body: { text: 'PRODUCT_NAME,PRODUCT_PRICE,BACKGROUND_IMAGE\nShoes,2500,' + bgVideoA.id + '\nHat,900,no-such-background.mp4' } });
  await req(`/api/bulk/${job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { fieldMapping: { PRODUCT_NAME: 'PRODUCT_NAME', PRODUCT_PRICE: 'PRODUCT_PRICE' }, background: { mode: 'column', column: 'BACKGROUND_IMAGE' } } } });
  const start = await req(`/api/bulk/${job.id}/start`, { method: 'POST', cookie: ownerCookie });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const finished = await waitForBulkJob(job.id);
  assert.equal(finished.job.status, 'partial', `expected partial, got ${finished.job.status}`);
  assert.equal(finished.job.rowsDone, 1);
  assert.equal(finished.job.rowsFailed, 1);
  const failed = finished.rows.find((r) => r.status === 'failed');
  assert.ok(failed && failed.error, 'failed row carries a real error message');
  // Fix it the way a user would: the column value was bad, so switch the
  // batch to the random pool and retry — the retry re-assigns backgrounds
  // for the failed row (done rows are never re-assigned).
  const fix = await req(`/api/bulk/${job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { background: { mode: 'random', poolMediaIds: [bgVideoA.id, bgVideoB.id], repeatRule: 'no-repeat' } } } });
  assert.equal(fix.status, 200, JSON.stringify(fix.json));
  const retry = await req(`/api/bulk/${job.id}/retry-row/${failed.id}`, { method: 'POST', cookie: ownerCookie });
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  const after = await waitForBulkJob(job.id);
  assert.equal(after.job.status, 'done', `after retry: ${after.job.status}`);
  assert.equal(after.job.rowsDone, 2);
  // A batch with no failed rows refuses to retry — and skipped rows are never in the retry list.
  const nothing = await req(`/api/bulk/${job.id}/retry`, { method: 'POST', cookie: ownerCookie });
  assert.equal(nothing.status, 400);
  assert.ok(nothing.json.error.includes('No failed rows'));
});

/* ---------------- End-to-end: bulk design ---------------- */
test('e2e bulk design: 2 rows -> 2 real PNGs with substituted text', async () => {
  const design = {
    version: 1, width: 400, height: 300,
    background: { type: 'color', color: '#151d3a' },
    layers: [
      { id: 'l1', type: 'text', name: 'Product', x: 20, y: 40, w: 360, h: 60, text: { text: '{{PRODUCT_NAME}}', fontFamily: 'Poppins', fontSize: 36, fontWeight: 700, color: '#ffffff', align: 'center' } },
      { id: 'l2', type: 'shape', name: 'Bar', x: 20, y: 200, w: 360, h: 40, shape: { kind: 'rect', fill: '#22d3ee' } },
    ],
  };
  const created = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'Design Template', type: 'design', content: { design } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const job = await createBulkJob('Design Batch', 'design', created.json.project.id);
  await req(`/api/bulk/${job.id}/dataset`, { method: 'POST', cookie: ownerCookie, body: { text: 'PRODUCT_NAME\nShoes\nHat\nShoes' } });
  await req(`/api/bulk/${job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { fieldMapping: { PRODUCT_NAME: 'PRODUCT_NAME' } } } });
  const start = await req(`/api/bulk/${job.id}/start`, { method: 'POST', cookie: ownerCookie });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const finished = await waitForBulkJob(job.id);
  assert.equal(finished.job.status, 'done', JSON.stringify(finished.rows.map((r) => [r.rowNumber, r.status, r.error])));
  assert.equal(finished.job.rowsDone, 2, '3 rows with 1 duplicate -> 2 designs');
  for (const r of finished.rows.filter((x) => x.status === 'done')) {
    const buf = await downloadBulkRow(job.id, r.id);
    assert.ok(buf.length > 1000, 'design PNG is a real file');
    const outFile = path.join(tmp, `design-row-${r.rowNumber}.png`);
    fs.writeFileSync(outFile, buf);
    const probe = await ffprobe(outFile);
    assert.equal(probe.streams[0].width, 400);
    assert.equal(probe.streams[0].height, 300);
  }
});

/* ---------------- Quiz end-to-end ---------------- */
const LONG_Q_TEXT = 'Which of the following statements most accurately describes the primary reason why the ancient city of Rome; which was founded on the banks of the river Tiber; eventually grew to become the capital of one of the largest empires the ancient world had ever seen?';
const LONG_Q_OPTS = {
  OPTION_A: 'A short answer',
  OPTION_B: 'A considerably longer option that explains the trade routes and military strategy in some detail for the reader',
  OPTION_C: 'Another very long option about the political system and the senate and the way laws were made in Rome',
  OPTION_D: 'Yes',
};
const QUIZ_CSV = `QUESTION,OPTION_A,OPTION_B,OPTION_C,OPTION_D,CORRECT,EXPLANATION,CATEGORY,DIFFICULTY,TIMER_SECONDS
What is 2 + 2?,3,4,5,6,B,2 + 2 = 4.,Maths,easy,3
What is the capital of France?,London,Paris,Berlin,Madrid,B,Paris is the capital of France.,Geography,easy,3
True or false: the sun rises in the east.,True,False,,,A,The sun rises in the east.,Science,easy,3
Which planet is known as the Red Planet?,Venus,Mars,Jupiter,Saturn,B,Mars looks red because of iron oxide.,Science,medium,3
${LONG_Q_TEXT},${LONG_Q_OPTS.OPTION_A},${LONG_Q_OPTS.OPTION_B},${LONG_Q_OPTS.OPTION_C},${LONG_Q_OPTS.OPTION_D},B,Trade and military power built the empire over centuries of expansion.,History,hard,3`;

async function makeQuizJob(name, quizSettings) {
  // Tests render at 720p for speed; the product default is 1080p (spec).
  const job = await createBulkJob(name, 'video', 'quiz', { resolution: '720p', quiz: quizSettings || {} });
  return job;
}

let quizSingleJobId;

test('quiz e2e single: long question renders; font smaller than short; reveal pixel is green', async () => {
  // Spec timing: 2s read + 3s countdown + 2s reveal + 3s score card = 10s.
  const job = await makeQuizJob('Quiz Single', { mode: 'single', readSeconds: 2, timerSeconds: 3, revealSeconds: 2, ctaSeconds: 3 });
  quizSingleJobId = job.id;
  const up = await req(`/api/bulk/${job.id}/dataset`, { method: 'POST', cookie: ownerCookie, body: { text: QUIZ_CSV } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.dedupeSummary.unique, 5);
  await req(`/api/bulk/${job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { background: { mode: 'random', poolMediaIds: [bgImageBlue.id, bgImageRed.id], repeatRule: 'no-repeat' } } } });
  // Fit check first: batch-uniform fonts — the long row sets the size for all.
  const fc = await req(`/api/bulk/${job.id}/fit-check`, { method: 'POST', cookie: ownerCookie });
  assert.equal(fc.status, 200, JSON.stringify(fc.json));
  const fonts = fc.json.rows.map((r) => r.fitReport.optionFont);
  assert.ok(fonts.every((f) => f === fonts[0]), `batch-uniform option font across 5 rows: ${fonts.join(', ')}`);
  const longRow = fc.json.rows.find((r) => r.rowIndex === 4);
  assert.ok(['Adjusted', 'Needs attention'].includes(longRow.fitReport.overall), `long row fit: ${longRow.fitReport.overall}`);
  assert.ok(fc.json.quizFonts, 'batch quiz fonts computed');
  // Render only the long row (row 5) as the single-question sample of the batch.
  const start = await req(`/api/bulk/${job.id}/start`, { method: 'POST', cookie: ownerCookie });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const finished = await waitForBulkJob(job.id, 180000);
  assert.equal(finished.job.status, 'done', JSON.stringify(finished.rows.map((r) => [r.rowNumber, r.status, r.error])));
  assert.equal(finished.job.rowsDone, 5);
  const longDone = finished.rows.find((r) => r.rowIndex === 4);
  const buf = await downloadBulkRow(job.id, longDone.id);
  const outFile = path.join(tmp, 'quiz-long.mp4');
  fs.writeFileSync(outFile, buf);
  const probe = await ffprobe(outFile);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  assert.equal(video.width, 720);
  assert.equal(video.height, 1280);
  assert.ok(Math.abs(parseFloat(probe.format.duration) - 10) < 1, `quiz duration ${probe.format.duration}, expected 2 + 3 + 2 + 3 = 10s (spec timing)`);
  // Pixel check: the correct option (B, index 1) is green in the reveal phase…
  // Use the REAL long question (same text, options and batch fonts as the
  // render) so the layout — and the pixel coordinates — match exactly.
  const q = parseQuestion({
    QUESTION: LONG_Q_TEXT, ...LONG_Q_OPTS,
    CORRECT: 'B', EXPLANATION: 'Trade and military power built the empire over centuries of expansion.',
    CATEGORY: 'History', DIFFICULTY: 'hard', TIMER_SECONDS: 3,
  }, 4);
  const L = layoutRound(q, { W: 720, H: 1280, fonts: fc.json.quizFonts });
  const box = L.optionBoxes[1];
  // Sample the panel corner (away from the text glyphs): green in reveal,
  // dark slate in the question phase. Reveal starts at 2 + 3 = 5s.
  const cx = Math.round(box.x + 5);
  const cy = Math.round(box.y + 5);
  const revealPx = readPixel(outFile, 5.5, cx, cy);
  assert.ok(revealPx[1] > 100 && revealPx[1] > revealPx[0] + 30, `reveal-phase pixel at correct option centre is green: rgb(${revealPx.join(',')})`);
  const questionPx = readPixel(outFile, 1, cx, cy);
  assert.ok(!(questionPx[1] > 100 && questionPx[1] > questionPx[0] + 30), `question-phase pixel is NOT green (no premature highlight): rgb(${questionPx.join(',')})`);
});

test('quiz quality gate: thumbnail has readable text, safe zones respected, layout balanced', async () => {
  const job = await req(`/api/bulk/${quizSingleJobId}`, { cookie: ownerCookie });
  const longDone = job.json.rows.find((r) => r.rowIndex === 4);
  const buf = await downloadBulkRow(quizSingleJobId, longDone.id);
  const outFile = path.join(tmp, 'quiz-long.mp4');
  fs.writeFileSync(outFile, buf);
  // Thumbnail from the question phase.
  const thumb = path.join(tmp, 'quiz-thumb.jpg');
  extractFrame(outFile, 1, thumb);
  const tprobe = await ffprobe(thumb);
  assert.equal(tprobe.streams[0].width, 720);
  assert.equal(tprobe.streams[0].height, 1280);
  // Text present: sample the question-box area — some pixel must be bright
  // (white question text on the darkened background), not uniform background.
  // Same real question + the batch fonts the render used (from the row's
  // stored fit report — the job is done, so fit-check would refuse it).
  const longRow = job.json.rows.find((r) => r.rowIndex === 4);
  const fr = longRow.fitReport || {};
  const q = parseQuestion({
    QUESTION: LONG_Q_TEXT, ...LONG_Q_OPTS,
    CORRECT: 'B', EXPLANATION: 'Trade and military power built the empire over centuries of expansion.',
    CATEGORY: 'History', DIFFICULTY: 'hard', TIMER_SECONDS: 3,
  }, 4);
  const L = layoutRound(q, { W: 720, H: 1280, fonts: { question: fr.questionFont, option: fr.optionFont, explanation: fr.explanationFont } });
  let bright = 0;
  for (let x = L.qBox.x + 10; x < L.qBox.x + L.qBox.w - 10; x += 12) {
    for (let y = L.qBox.y + 6; y < L.qBox.y + Math.min(L.qBox.h, 120); y += 12) {
      const px = readPixel(outFile, 1, x, y);
      if (px[0] > 180 && px[1] > 180 && px[2] > 180) bright += 1;
    }
  }
  assert.ok(bright > 0, 'white question text is visible in the question box (readable on a phone)');
  // Safe zones (spec safe box, not just the frame): nothing essential below
  // the caption reserve or in the top UI strip; everything inside the box.
  assert.ok(L.optionBoxes.every((b) => b.y + b.h <= 1280 - 90), 'all option boxes above the bottom caption reserve');
  assert.ok(L.qBox.y >= 56, 'question starts below the top UI reserve');
  assert.ok(L.optionBoxes.every((b) => b.y >= L.safeBox.y && b.y + b.h <= L.safeBox.y + L.safeBox.h), 'all option boxes inside the spec safe box');
  assert.ok(L.qBox.y >= L.safeBox.y && L.qBox.y + L.qBox.h <= L.safeBox.y + L.safeBox.h, 'question box inside the spec safe box');
  // Balanced: the stacked list is centred inside the safe box.
  assert.ok(Math.abs(L.margin + L.boxW / 2 - (L.safeBox.x + L.safeBox.w / 2)) < 2, 'options list is centred inside the safe box');
  assert.ok(L.fitReport.balanced, 'layout reports balanced');
  assert.ok(L.fitReport.safeZoneOk, 'layout reports safe zones OK');
});

test('quiz e2e multi: 5 rows -> 1 video with 5 rounds', async () => {
  const job = await makeQuizJob('Quiz Multi', { mode: 'multi', questionsPerVideo: 5, readSeconds: 2, timerSeconds: 3, revealSeconds: 2, ctaSeconds: 3 });
  await req(`/api/bulk/${job.id}/dataset`, { method: 'POST', cookie: ownerCookie, body: { text: QUIZ_CSV } });
  await req(`/api/bulk/${job.id}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { background: { mode: 'random', poolMediaIds: [bgImageBlue.id, bgImageRed.id], repeatRule: 'no-repeat' } } } });
  const start = await req(`/api/bulk/${job.id}/start`, { method: 'POST', cookie: ownerCookie });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const finished = await waitForBulkJob(job.id, 180000);
  assert.equal(finished.job.status, 'done', JSON.stringify(finished.rows.map((r) => [r.rowNumber, r.status, r.error])));
  const done = finished.rows.filter((r) => r.status === 'done');
  assert.equal(done.length, 5, 'all five questions marked done in the one group video');
  assert.equal(new Set(done.map((r) => r.outputJobId)).size, 1, 'all five rows share one render job (one video)');
  const buf = await downloadBulkRow(job.id, done[0].id);
  const outFile = path.join(tmp, 'quiz-multi.mp4');
  fs.writeFileSync(outFile, buf);
  const probe = await ffprobe(outFile);
  assert.ok(Math.abs(parseFloat(probe.format.duration) - 38) < 2, `multi duration ${probe.format.duration}, expected 5 x (2+3+2) + 3 = 38s (spec timing)`);
});

/* ---------------- Isolation + honest states ---------------- */
test('bulk jobs: per-user isolation; anonymous gets 401', async () => {
  const other = await req(`/api/bulk/${bulkJobId}`, { cookie: userCookie });
  assert.equal(other.status, 404);
  const otherList = await req('/api/bulk', { cookie: userCookie });
  assert.equal(otherList.status, 200);
  assert.ok(!otherList.json.jobs.some((j) => j.id === bulkJobId), 'second user does not see the first user’s batches');
  const anon = await req('/api/bulk');
  assert.equal(anon.status, 401);
  const otherZip = await fetch(BASE + `/api/bulk/${bulkJobId}/zip`, { headers: { cookie: userCookie }, redirect: 'manual' });
  assert.equal(otherZip.status, 404);
});

test('bulk jobs: sample refuses skipped duplicates; delete removes the batch', async () => {
  const job = await createBulkJob('Sample Guard', 'video', videoProjectId);
  await req(`/api/bulk/${job.id}/dataset`, { method: 'POST', cookie: ownerCookie, body: { text: 'PRODUCT_NAME,PRODUCT_PRICE\nShoes,2500\nShoes,2500' } });
  const rows = await req(`/api/bulk/${job.id}/rows`, { cookie: ownerCookie });
  const skipped = rows.json.rows.find((r) => r.status === 'skipped');
  assert.ok(skipped, 'second identical row is skipped');
  const sample = await req(`/api/bulk/${job.id}/sample`, { method: 'POST', cookie: ownerCookie, body: { rowIndex: skipped.rowIndex } });
  assert.equal(sample.status, 400);
  assert.ok(sample.json.error.includes('skipped duplicate'));
  const del = await req(`/api/bulk/${job.id}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 200);
  const gone = await req(`/api/bulk/${job.id}`, { cookie: ownerCookie });
  assert.equal(gone.status, 404);
});
