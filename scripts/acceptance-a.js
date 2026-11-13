'use strict';
// Acceptance test A — full 100-row run (Phase 9, Final QA).
// Why a script, not part of `npm test`: 100 sequential 1 s renders take
// several minutes; the suite keeps a 10-row version of the same assertions
// in tests/acceptance.test.js, and this script runs the real 100-row case.
//
// Usage:  node scripts/acceptance-a.js
// Spawns the real server on port 4841 with a throwaway DB/uploads dir,
// builds a real 100-row .xlsx (100 UNIQUE rows — duplicates must NOT
// produce videos, so the run uses unique rows), uploads 100 distinct
// solid-colour backgrounds + a magenta logo, runs a real bulk video job
// end to end, then verifies: 100 videos, correct row data (substitution +
// white-text pixels), all 100 backgrounds different (no-repeat), logo
// positioned (magenta pixel at the logo centre), EVERY output ffprobe-valid
// (h264, 1280x720, ~1 s). Writes docs/acceptance-a-report.json and exits
// non-zero on any failure. Cleans up its server and temp dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const XLSX = require('xlsx');
const { blankTimeline, defaultClip, validateTimeline } = require('../src/video-model');
const { buildRowTimeline } = require('../src/bulk-model');

const PORT = 4841;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-acceptance-a-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const REPORT_PATH = path.join(__dirname, '..', 'docs', 'acceptance-a-report.json');

let server;
let ownerCookie = '';
const failures = [];
function check(cond, msg) {
  if (!cond) { failures.push(msg); console.error('FAIL:', msg); }
  else console.log('ok:', msg);
}

function req(path, { method = 'GET', body, cookie, form } = {}) {
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

function makeImage(file, color) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:d=1`, '-frames:v', '1', file],
    { timeout: 30000 });
}

function readPixel(file, time, x, y) {
  const out = execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(time), '-i', file,
    '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { timeout: 30000, maxBuffer: 1024 * 1024 });
  return [out[0], out[1], out[2]];
}

function countNearWhitePixels(file, time, y) {
  // drawtext's y is the TOP of the glyphs, so sample a small vertical band
  // around the given row and take the best row (a single row at the very
  // top edge of the text barely touches any glyph).
  let best = 0;
  for (const yy of [y - 12, y, y + 12]) {
    let count = 0;
    for (let x = 100; x <= 1180; x += 20) {
      const [r, g, b] = readPixel(file, time, x, yy);
      if (r > 200 && g > 200 && b > 200) count++;
    }
    best = Math.max(best, count);
  }
  return best;
}

async function uploadMedia(file, name, mime) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime }), name);
  const r = await req('/api/media/upload', { method: 'POST', cookie: ownerCookie, form });
  if (r.status !== 201) throw new Error(`upload ${name} failed: ${r.status} ${r.text}`);
  return r.json.media;
}

async function waitForBulkJob(jobId, timeoutMs = 900000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const r = await req(`/api/bulk/${jobId}`, { cookie: ownerCookie });
    if (r.status !== 200) throw new Error(`bulk job poll failed: ${r.status}`);
    last = r.json;
    if (['done', 'partial', 'failed', 'cancelled'].includes(last.job.status)) return last;
    if (Date.now() > deadline) throw new Error(`bulk job ${jobId} did not finish; last ${JSON.stringify(last.job)}`);
    await new Promise((x) => setTimeout(x, 1000));
  }
}

async function main() {
  const startedAt = Date.now();
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, HOST: '127.0.0.1', RENDER_CONCURRENCY: '1' },
    stdio: 'pipe',
  });
  const upDeadline = Date.now() + 15000;
  for (;;) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > upDeadline) throw new Error('server did not start in time');
    await new Promise((r) => setTimeout(r, 200));
  }
  const a = await req('/api/auth/signup', { method: 'POST', body: { name: 'Owner', email: 'owner@test.local', password: 'password123' } });
  if (a.status !== 201) throw new Error(`signup failed: ${a.status} ${a.text}`);
  ownerCookie = a.setCookie.split(';')[0];
  const users = await req('/api/admin/users', { cookie: ownerCookie });
  const ownerId = users.json.users.find((u) => u.email === 'owner@test.local').id;
  const reset = await req(`/api/admin/users/${ownerId}/reset-credits`, { method: 'POST', cookie: ownerCookie, body: { credits: 10000 } });
  if (reset.status !== 200) throw new Error(`credit reset failed: ${reset.status}`);

  // 100 distinct backgrounds: unique hue per row (HSL -> hex), avoiding the
  // magenta logo hue (~300) so the logo pixel check stays unambiguous.
  const bgIds = [];
  for (let i = 0; i < 100; i++) {
    // Unique hue per row; the magenta band (280-320) is shifted away so the
    // logo pixel check stays unambiguous. All 100 hues stay distinct.
    let h = (i * 3.6) % 360;
    if (h >= 280 && h <= 320) h = (h + 40) % 360;
    const hex = hslToHex(h, 80, 55);
    const f = path.join(tmp, `bg-${String(i).padStart(3, '0')}.png`);
    makeImage(f, `0x${hex}`);
    bgIds.push((await uploadMedia(f, `bg-${i}.png`, 'image/png')).id);
    if ((i + 1) % 25 === 0) console.log(`uploaded ${i + 1}/100 backgrounds`);
  }
  const logoFile = path.join(tmp, 'logo-magenta.png');
  makeImage(logoFile, 'magenta');
  const logo = await uploadMedia(logoFile, 'logo.png', 'image/png');

  const tl = blankTimeline('16:9', 30);
  const bg = defaultClip('video', bgIds[0], 0, 1);
  bg.name = 'Background';
  bg.isBackground = true;
  const tx = defaultClip('text', null, 0, 1);
  tx.text = { ...tx.text, text: '{{PRODUCT_NAME}} — {{PRODUCT_PRICE}}', fontSize: 48, align: 'center' };
  const logoClip = defaultClip('video', logo.id, 0, 1);
  logoClip.name = 'Logo';
  logoClip.keyframes = [{ t: 0, x: 5, y: 5, scale: 1, opacity: 1 }];
  // Logo overlay goes on the second video track (the render engine's PiP
  // overlay track) as a 'video'-kind clip — see tests/acceptance.test.js.
  tl.tracks.splice(1, 0, { id: 'track-overlay', kind: 'video', name: 'Overlay', locked: false, muted: false, clips: [] });
  tl.tracks[0].clips.push(bg);
  tl.tracks[1].clips.push(logoClip);
  tl.tracks[3].clips.push(tx);
  check(JSON.stringify(validateTimeline(tl)) === '[]', 'acceptance template validates');

  const created = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'Acceptance A Template (100 rows)', type: 'video', content: { timeline: tl } } });
  if (created.status !== 201) throw new Error(`template project failed: ${created.status} ${created.text}`);
  const templateId = created.json.project.id;

  const rows = Array.from({ length: 100 }, (_, i) => ({
    PRODUCT_NAME: `Product ${String(i + 1).padStart(3, '0')} Deluxe`,
    PRODUCT_PRICE: `Rs ${(1000 + i * 137).toLocaleString('en-US')}`,
  }));
  const xlsxPath = path.join(tmp, 'products-100.xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Products');
  XLSX.writeFile(wb, xlsxPath);

  const jobRes = await req('/api/bulk', { method: 'POST', cookie: ownerCookie, body: { name: 'Acceptance A (100 rows)', kind: 'video', templateProjectId: templateId } });
  if (jobRes.status !== 201) throw new Error(`bulk job create failed: ${jobRes.status} ${jobRes.text}`);
  const jobId = jobRes.json.job.id;
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(xlsxPath)], { type: 'application/octet-stream' }), 'products-100.xlsx');
  const ds = await req(`/api/bulk/${jobId}/dataset`, { method: 'POST', cookie: ownerCookie, form });
  if (ds.status !== 200) throw new Error(`dataset upload failed: ${ds.status} ${ds.text}`);
  check(ds.json.dedupeSummary.unique === 100, `xlsx parsed: 100 unique rows (got ${ds.json.dedupeSummary && ds.json.dedupeSummary.unique})`);
  check(ds.json.dedupeSummary.skipped === 0, `no rows skipped (got ${ds.json.dedupeSummary && ds.json.dedupeSummary.skipped})`);
  const patch = await req(`/api/bulk/${jobId}`, { method: 'PATCH', cookie: ownerCookie, body: { settings: { fieldMapping: { PRODUCT_NAME: 'PRODUCT_NAME', PRODUCT_PRICE: 'PRODUCT_PRICE' }, background: { mode: 'random', poolMediaIds: bgIds, repeatRule: 'no-repeat' } } } });
  if (patch.status !== 200) throw new Error(`job patch failed: ${patch.status} ${patch.text}`);
  const assigned = await req(`/api/bulk/${jobId}/assign`, { method: 'POST', cookie: ownerCookie });
  if (assigned.status !== 200) throw new Error(`assign failed: ${assigned.status} ${assigned.text}`);

  for (let i = 0; i < rows.length; i++) {
    const built = buildRowTimeline(tl, rows[i], { fieldMapping: { PRODUCT_NAME: 'PRODUCT_NAME', PRODUCT_PRICE: 'PRODUCT_PRICE' } });
    const clip = built.timeline.tracks[3].clips[0];
    if (!clip.text.text.includes(rows[i].PRODUCT_NAME) || !clip.text.text.includes(rows[i].PRODUCT_PRICE)) {
      failures.push(`row ${i + 1} substitution wrong: ${clip.text.text}`);
    }
  }
  check(failures.length === 0, 'all 100 rows substitute their own product name + price');

  const start = await req(`/api/bulk/${jobId}/start`, { method: 'POST', cookie: ownerCookie });
  if (start.status !== 200) throw new Error(`job start failed: ${start.status} ${start.text}`);
  console.log('job started, rendering 100 rows (sequential, one render at a time)...');
  const renderStarted = Date.now();
  const finished = await waitForBulkJob(jobId);
  const renderSeconds = ((Date.now() - renderStarted) / 1000).toFixed(1);
  check(finished.job.status === 'done', `job status done (got ${finished.job.status})`);
  check(finished.job.rowsDone === 100, `rowsDone 100 (got ${finished.job.rowsDone})`);
  check(finished.job.rowsFailed === 0, `rowsFailed 0 (got ${finished.job.rowsFailed})`);
  const done = finished.rows.filter((r) => r.status === 'done');
  check(done.length === 100, `100 done rows (got ${done.length})`);
  check(new Set(done.map((r) => r.backgroundMediaId)).size === 100, 'all 100 rows used a different background (no-repeat)');

  const hashes = [];
  let probeFailures = 0;
  let logoChecked = 0;
  let logoOk = 0;
  let textChecked = 0;
  let textOk = 0;
  for (const r of done) {
    const dl = await fetch(BASE + `/api/bulk/${jobId}/rows/${r.id}/download`, { headers: { cookie: ownerCookie, connection: 'close' }, redirect: 'manual' });
    if (dl.status !== 200) { probeFailures++; failures.push(`row ${r.rowNumber} download ${dl.status}`); continue; }
    const buf = Buffer.from(await dl.arrayBuffer());
    const outFile = path.join(tmp, `row-${String(r.rowNumber).padStart(3, '0')}.mp4`);
    fs.writeFileSync(outFile, buf);
    let probe;
    try { probe = await ffprobe(outFile); } catch (e) { probeFailures++; failures.push(`row ${r.rowNumber} ffprobe failed: ${e.message}`); continue; }
    const video = probe.streams.find((s) => s.codec_type === 'video');
    if (!video || video.codec_name !== 'h264' || video.width !== 1280 || video.height !== 720 || Math.abs(parseFloat(probe.format.duration) - 1) >= 0.75) {
      probeFailures++;
      failures.push(`row ${r.rowNumber} bad probe: ${JSON.stringify(probe)}`);
    }
    hashes.push(crypto.createHash('sha256').update(buf).digest('hex'));
    if ([1, 25, 50, 75, 100].includes(r.rowNumber)) {
      logoChecked++;
      const [lr, lg, lb] = readPixel(outFile, 0.5, 237, 133);
      if (lr > 200 && lg < 80 && lb > 200) logoOk++;
      else failures.push(`row ${r.rowNumber} logo pixel not magenta: [${lr},${lg},${lb}]`);
      textChecked++;
      const white = countNearWhitePixels(outFile, 0.5, 380); // mid-glyph: drawtext y=360 is the TOP of the glyphs
      if (white >= 5) textOk++;
      else failures.push(`row ${r.rowNumber} white product text not found (${white} samples)`);
    }
  }
  check(probeFailures === 0, `all 100 outputs ffprobe-valid h264 1280x720 ~1s (${probeFailures} failures)`);
  check(new Set(hashes).size === 100, `all 100 outputs byte-distinct (got ${new Set(hashes).size} unique hashes)`);
  check(logoOk === logoChecked, `logo positioned in spot-checked rows (${logoOk}/${logoChecked})`);
  check(textOk === textChecked, `row text visible in spot-checked rows (${textOk}/${textChecked})`);

  const report = {
    acceptance: 'A — Bulk Video (100-row Excel)',
    runAt: new Date().toISOString(),
    durationSeconds: ((Date.now() - startedAt) / 1000).toFixed(1),
    renderSeconds: Number(renderSeconds),
    rows: 100,
    rowsDone: finished.job.rowsDone,
    rowsFailed: finished.job.rowsFailed,
    rowsSkipped: finished.job.dedupeSummary ? finished.job.dedupeSummary.skipped : 0,
    uniqueBackgrounds: new Set(done.map((r) => r.backgroundMediaId)).size,
    uniqueOutputHashes: new Set(hashes).size,
    ffprobeFailures: probeFailures,
    logoSpotCheck: `${logoOk}/${logoChecked}`,
    textSpotCheck: `${textOk}/${textChecked}`,
    jobStatus: finished.job.status,
    failures,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nAcceptance A: ${report.verdict} — ${report.rowsDone}/100 videos, ${report.uniqueBackgrounds} unique backgrounds, render time ${renderSeconds}s`);
  console.log(`Report: ${REPORT_PATH}`);
  return failures.length === 0;
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return to(f(0)) + to(f(8)) + to(f(4));
}

main().then((ok) => {
  if (server) server.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(ok ? 0 : 1);
}).catch((err) => {
  console.error('Acceptance A crashed:', err);
  if (server) server.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
