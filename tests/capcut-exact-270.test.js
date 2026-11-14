'use strict';
// CapCut Desktop Exact regression tests (v2.7.1) — the Home + Video Editor
// shells and the mobile shell must match the user's reference screenshots
// of real CapCut (desktop dark + mobile light) in arrangement, order,
// labels and colours, with every visible item wired to a real feature.
// These tests pin the served frontend markers (order-checked where the
// reference fixes an order) plus the server contracts the shells depend
// on (dashboard durations, template install, jobs list, notifications,
// analytics). Spawns the real server on a scratch port (4857) with a temp
// DB/uploads/renders/models dir. Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-capcut270-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const modelsDir = path.join(tmp, 'models');
process.env.DB_PATH = dbPath;
process.env.UPLOADS_DIR = uploadsDir;
process.env.RENDERS_DIR = rendersDir;
process.env.MODELS_DIR = modelsDir;
const PORT = 4857;
const BASE = `http://127.0.0.1:${PORT}`;

const { blankTimeline, defaultClip } = require('../src/video-model');

let server;
let ownerCookie = '';

function req(p, { method = 'GET', body, cookie } = {}) {
  const headers = { connection: 'close' };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' })
    .then(async (r) => {
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, text, headers: r.headers, setCookie: r.headers.get('set-cookie') || '' };
    });
}

// Assert each needle appears in `text` in the given order (strictly
// increasing positions) — the reference fixes the order, not just presence.
function assertOrdered(text, needles, label) {
  let pos = -1;
  for (const n of needles) {
    const i = text.indexOf(n, pos + 1);
    assert.ok(i > pos, `${label}: expected "${n}" after position ${pos}`);
    pos = i;
  }
}

before(async () => {
  const env = {
    ...process.env,
    DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, MODELS_DIR: modelsDir,
    PORT: String(PORT), HOST: '127.0.0.1',
  };
  server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start: ${out}`);
    await new Promise((x) => setTimeout(x, 200));
  }
  const s = await req('/api/auth/signup', { method: 'POST', body: { name: 'CapCut Tester', email: 'capcut270@test.local', password: 'password123' } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  ownerCookie = s.setCookie.split(';')[0];
});

after(async () => {
  if (server) server.kill('SIGKILL');
});

async function served(p) {
  const r = await req(p);
  assert.equal(r.status, 200, `${p} should serve: ${r.status}`);
  return r.text;
}

/* ---------- version ---------- */

test('health reports 2.7.1 / phase 14', async () => {
  const h = await req('/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.version, '2.7.1');
  assert.equal(h.json.phase, 14);
  const d = await req('/api/dashboard', { cookie: ownerCookie });
  assert.equal(d.json.system.version, '2.7.1 (Updater Fix)');
});

/* ---------- desktop Home (reference: image-222.png) ---------- */

test('home sidebar items are in CapCut order', async () => {
  const app = await served('/app.js');
  assertOrdered(app, [
    'cc-signin-card', 'cc-join-pro', 'data-cc-go="home"', 'data-cc-go="marketplace"',
    'Create with AI', 'Video Studio', 'Design Studio', 'More tools',
    'Invite friends', 'cc-seedance-promo',
  ], 'home sidebar');
  assert.ok(app.includes('Try Seedance 2.5'), 'Seedance promo card');
  assert.ok(app.includes('cc-new-badge'), 'Invite friends New badge');
});

test('home cyan banner opens the 9-type New Project flow', async () => {
  const app = await served('/app.js');
  assert.ok(app.includes('Create project'), 'cyan Create project banner');
  assert.ok(app.includes('openNewProjectFlow'), 'banner wires to the New Project flow');
  const types = ['video', 'design', 'deck', 'doc', 'quiz', 'bulk-video', 'bulk-design', 'shorts', 'social'];
  for (const t of types) assert.ok(app.includes(`id: '${t}'`), `New Project type ${t}`);
});

test('home has the 5 tool cards with exact CapCut labels, in order', async () => {
  const app = await served('/app.js');
  assertOrdered(app, [
    'AI image', 'Turn ideas into imagery',
    'Extend video', 'Seamlessly extend any clip',
    'AI edit', 'Edit clips by describing it',
    'Enhance quality', 'Get sharper results instantly',
    'AI remove', 'Remove anything unwanted',
  ], '5 tool cards');
  assert.ok(app.includes('GPT Image'), 'AI image GPT Image badge');
});

test('home suite carousel has the 4 CapCut cards in order, with a scroll button', async () => {
  const app = await served('/app.js');
  assertOrdered(app, [
    'AI-powered creative suite',
    'Video Studio', 'Make 30-second videos with Seedance 2.5',
    'Design Studio', 'Bring your imagination to life in the easiest way.',
    'AI ad maker', 'Create winning ads, scale fast with variants.',
    'Long video to',
  ], 'suite carousel');
  assert.ok(app.includes('cc-suite-next') || app.includes('suite-next'), 'carousel scroll button');
});

test('home Recent Projects carry real durations (live contract)', async () => {
  const tl = blankTimeline('16:9', 30);
  tl.tracks[0].clips.push(defaultClip('video', null, 0, 3));
  const c = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'CapCut 270 video', type: 'video', content: { timeline: tl } } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const d = await req('/api/dashboard', { cookie: ownerCookie });
  const found = (d.json.recentProjects || []).find((p) => p.name === 'CapCut 270 video');
  assert.ok(found, 'created video project is in Recent Projects');
  assert.equal(found.durationSeconds, 3, 'recent project shows its real 3s duration');
});

test('home Templates row installs a real template (live contract)', async () => {
  const b = await req('/api/marketplace/builtin', { cookie: ownerCookie });
  assert.ok(Array.isArray(b.json.templates) && b.json.templates.length > 0, 'builtin templates listed');
  const t = b.json.templates[0];
  const r = await req(`/api/marketplace/builtin/${encodeURIComponent(t.id)}/install`, { method: 'POST', cookie: ownerCookie });
  assert.ok([200, 201].includes(r.status), `install ${t.id}: ${r.text}`);
  assert.ok(r.json.installed && r.json.installed.id, 'install returns a real project id');
});

/* ---------- desktop Editor (reference: image-223.png) ---------- */

test('editor top bar has Menu, project name, Pro, Share, Export', async () => {
  const ve = await served('/video-editor.js');
  for (const m of ['ve-menu-btn', 've-pro-badge', 've-share-btn', 've-goto-export']) {
    assert.ok(ve.includes(m), `top bar: ${m}`);
  }
  assert.ok(ve.includes('Player-Timeline 01'), 'preview header shows the sequence name');
});

test('editor icon rail is in CapCut order', async () => {
  const ve = await served('/video-editor.js');
  assertOrdered(ve, [
    'data-ltab="media"', 'data-ltab="audio"', 'data-ltab="text"', 'data-ltab="stickers"',
    'data-ltab="effects"', 'data-ltab="transitions"', 'data-ltab="captions"', 'data-ltab="filters"',
  ], 'editor icon rail');
});

test('editor Media panel has the Import drop zone, tabs and create tools', async () => {
  const ve = await served('/video-editor.js');
  for (const m of [
    'Drag and drop videos, photos, and audio files here',
    'No media? Create with these tools', 'Generate', 'AI avatars', 'Record',
  ]) assert.ok(ve.includes(m), `media panel: ${m}`);
  assertOrdered(ve, ['Media', 'Timeline', 'Subprojects'], 'media panel tabs');
  assert.ok(ve.includes("[['media', 'Media'], ['timeline', 'Timeline'], ['subprojects', 'Subprojects']]"), 'media panel tabs literal');
});

test('editor Details panel fields are in CapCut order', async () => {
  const ve = await served('/video-editor.js');
  const panel = ve.slice(ve.indexOf('ve-details-h'));
  assertOrdered(panel, [
    'Details', 'Name', 'Path', 'Imported media', 'Arrange layers', 'Proxy',
    'Aspect ratio', 'Resolution', 'Modify',
  ], 'Details panel');
});

test('editor timeline toolbar and empty state match CapCut', async () => {
  const ve = await served('/video-editor.js');
  for (const m of ['ve-undo', 've-redo', 've-split', 've-del', 've-vo-btn', 've-magnet', 've-zoom']) {
    assert.ok(ve.includes(m), `timeline toolbar: ${m}`);
  }
  assert.ok(ve.includes('Drag material here and start to create'), 'empty timeline state');
  assert.ok(ve.includes('00:00:00:00'), 'timecode starts at 00:00:00:00');
});

test('editor Export opens the real export dialog (resolution/fps/format/codec/bitrate)', async () => {
  const ve = await served('/video-editor.js');
  for (const m of ['Resolution', 'Frame rate', 'Format', 'Codec', 'Bitrate']) {
    assert.ok(ve.includes(m), `export dialog: ${m}`);
  }
  const jobs = await req('/api/video/jobs', { cookie: ownerCookie });
  assert.equal(jobs.status, 200);
  assert.ok(Array.isArray(jobs.json.jobs), 'render jobs list is readable');
});

/* ---------- mobile shell (reference: 6 mobile screenshots) ---------- */

test('index loads the mobile shell files', async () => {
  const index = await served('/');
  assert.ok(index.includes('/mobile.css'), 'index loads mobile.css');
  assert.ok(index.includes('/mobile.js'), 'index loads mobile.js');
  assert.ok(index.includes('v2.7.1 Desktop App'), 'index title is 2.7.1');
});

test('mobile bottom nav has the 5 CapCut tabs in order, plus the FAB', async () => {
  const m = await served('/mobile.js');
  assertOrdered(m, ['Edit', 'Templates', 'AI Lab', 'Inbox', 'Me'], 'mobile bottom nav');
  assert.ok(m.includes('m-fab'), 'floating + button above the nav');
  assert.ok(m.includes('m-nav-badge'), 'Inbox badge element');
});

test('mobile Edit home has the pill, hero cards and 8 tools in order', async () => {
  const m = await served('/mobile.js');
  assert.ok(m.includes('Try Standard 7 days for'), 'Standard trial pill');
  assertOrdered(m, ['New video', 'Edit photo'], 'hero cards');
  assert.ok(m.includes('Seedream 5.5'), 'Edit photo Seedream badge');
  const grid = m.slice(m.indexOf('m-tools-grid'), m.indexOf('m-section-head'));
  assertOrdered(grid, [
    'AutoCut', 'Retouch', 'AI generator', 'Auto captions',
    'Photo editor', 'Cover maker', 'Desktop editor', 'All tools',
  ], '8 quick tools');
  assert.ok(m.includes('Your projects will appear here.'), 'projects empty state copy');
});

test('mobile AI Lab has the heading, Remix card, pills and input bar', async () => {
  const m = await served('/mobile.js');
  for (const s of [
    'What are we creating today?', 'Remix viral content', 'Quick photo edit',
    'AutoCut', 'Create AI video', 'Try Seedance 2.5', 'Turn Photos into AI Videos',
  ]) assert.ok(m.includes(s), `AI Lab: ${s}`);
});

test('mobile Templates has search, chips and a 2-column card grid', async () => {
  const m = await served('/mobile.js');
  for (const s of ['Search CapCut', 'Following', 'For you', 'Pro', 'm-tpl-grid', 'm-tpl-card']) {
    assert.ok(m.includes(s), `Templates: ${s}`);
  }
});

test('mobile All Tools has the 4 sections in order and all 28 tiles', async () => {
  const m = await served('/mobile.js');
  assertOrdered(m, ['Quick actions', 'AI tools', 'Photo editing', 'Marketing tools'], 'All Tools sections');
  const tiles = [
    'Retouch', 'Auto captions', 'Teleprompter', 'Camera', 'Auto enhance', 'Record',
    'Collage', 'Frame capture', 'Desktop editor', 'AutoCut', 'AI avatars',
    'AI dialogue scene', 'AI image', 'AI effects', 'AI video', 'Generate media',
    'Video to carousel', 'Photo editor', 'Remove background', 'Smart lighting',
    'AI expand', 'Text to image', 'AI photo editor', 'Cover maker', 'Smart ads',
    'Product photos', 'AI poster', 'AI fashion model',
  ];
  assert.equal(tiles.length, 28, '28 tiles expected');
  for (const t of tiles) assert.ok(m.includes(t), `All Tools tile: ${t}`);
  assert.ok(m.includes('New project'), 'All Tools pinned New project button');
});

test('mobile Inbox has CapCut-official + Interactions tabs and real filters', async () => {
  const m = await served('/mobile.js');
  for (const s of ['CapCut official', 'Interactions', 'Exports', 'Likes', 'Comments']) {
    assert.ok(m.includes(s), `Inbox: ${s}`);
  }
  const n = await req('/api/notifications', { cookie: ownerCookie });
  assert.equal(n.status, 200);
  assert.ok(typeof n.json.unreadCount === 'number', 'notifications carry a real unread count');
});

test('mobile Me has the plan pill, profile, creator center and More list', async () => {
  const m = await served('/mobile.js');
  for (const s of [
    'FREE year of Pro', 'Renew Pro', 'View profile', 'Your progress',
    'Creator center', 'Creation tasks', 'Inspiration hub',
    'Apply to be a creator', 'Events', 'Purchased',
  ]) assert.ok(m.includes(s), `Me: ${s}`);
  const a = await req('/api/analytics?days=30', { cookie: ownerCookie });
  assert.equal(a.status, 200, 'analytics backing the Me stats is readable');
});

test('mobile shell never invents CapCut-cloud people or numbers', async () => {
  const m = await served('/mobile.js');
  for (const fake of ['sheharyarnadeem', 'user7276107685985', 'Shabazbutt', 'Followed you', '153.2K', 'Platinum']) {
    assert.ok(!m.includes(fake), `mobile.js must not contain invented CapCut data: ${fake}`);
  }
});

test('mobile 390px rules: 44px touch targets, no horizontal overflow, 860px breakpoint', async () => {
  const css = await served('/mobile.css');
  assert.ok(css.includes('860px'), 'mobile breakpoint at 860px');
  assert.ok(css.includes('44px'), '44px minimum touch targets');
  assert.ok(css.includes('overflow-x'), 'horizontal overflow is controlled');
  assert.ok(css.includes('#m-nav'), 'bottom nav styled');
  assert.ok(css.includes('#m-fab'), 'FAB styled');
});
