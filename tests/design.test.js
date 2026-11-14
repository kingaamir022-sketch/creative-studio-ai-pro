'use strict';
// Phase 2 API tests — run with: npm test
// Spawns the real server on a scratch port with a temp DB/uploads dir.
// Covers: design validation, templates (built-in + user-saved), Brand Kit
// CRUD + ownership, design project round-trip, editor frontend assets.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { validateDesign, blankDesign, defaultTextLayer, defaultShapeLayer, defaultImageLayer, SIZES, FONTS } = require('../src/design-model');
const { listBuiltinTemplates, builtinTemplate } = require('../src/design-templates');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pro-design-test-'));
const dbPath = path.join(tmp, 'test.db');
const uploadsDir = path.join(tmp, 'uploads');
const rendersDir = path.join(tmp, 'renders');
const PORT = 4832;
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
      return { status: r.status, json, text, setCookie: r.headers.get('set-cookie') || '' };
    });
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOADS_DIR: uploadsDir, RENDERS_DIR: rendersDir, HOST: '127.0.0.1' },
    stdio: 'pipe',
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start in time');
    await new Promise((r) => setTimeout(r, 200));
  }
  const a = await req('/api/auth/signup', { method: 'POST', body: { name: 'Design Owner', email: 'design-owner@test.local', password: 'password123' } });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  ownerCookie = a.setCookie.split(';')[0];
  const b = await req('/api/auth/signup', { method: 'POST', body: { name: 'Design User', email: 'design-user@test.local', password: 'password123' } });
  assert.equal(b.status, 201);
  userCookie = b.setCookie.split(';')[0];
});

after(() => {
  if (server) server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ---------- Unit: design model ---------- */
test('design model: sizes and fonts are sane', () => {
  assert.ok(SIZES.length >= 12);
  const post = SIZES.find((s) => s.id === 'instagram-post');
  assert.deepEqual([post.width, post.height], [1080, 1080]);
  assert.ok(FONTS.includes('Poppins'));
  assert.ok(FONTS.includes('Playfair Display'));
});

test('design model: validateDesign accepts a full design and rejects bad ones', () => {
  const d = blankDesign(1080, 1080);
  d.background = { type: 'gradient', color: '#7c5cff', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } };
  const t = defaultTextLayer(90, 100, 'Hello', { fontSize: 64 });
  t.text.shadow = { color: '#000000', blur: 8, offsetX: 2, offsetY: 2 };
  t.text.gradient = { from: '#ffffff', to: '#22d3ee' };
  const s = defaultShapeLayer('ellipse', 100, 300, 200, 200, { fill: '#ef4444' });
  const im = defaultImageLayer(500, 300, 300, 300, '/api/media/1/file', 1);
  im.image.filters.grayscale = 50;
  im.image.crop = { left: 10, top: 0, right: 10, bottom: 0 };
  d.layers = [t, s, im];
  assert.deepEqual(validateDesign(d), { ok: true, errors: [] });

  const badWidth = blankDesign(0, 1080);
  assert.equal(validateDesign(badWidth).ok, false);
  const badColor = blankDesign(1080, 1080);
  badColor.background = { type: 'color', color: 'red' };
  assert.equal(validateDesign(badColor).ok, false);
  const badLayer = blankDesign(1080, 1080);
  badLayer.layers = [{ id: 'x', type: 'video', x: 0, y: 0, w: 10, h: 10 }];
  assert.equal(validateDesign(badLayer).ok, false);
  const dup = blankDesign(1080, 1080);
  const l1 = defaultTextLayer(0, 0, 'A'); const l2 = defaultTextLayer(0, 0, 'B');
  l2.id = l1.id; dup.layers = [l1, l2];
  assert.equal(validateDesign(dup).ok, false);
  const badFilter = blankDesign(1080, 1080);
  const fi = defaultImageLayer(0, 0, 100, 100, '/x');
  fi.image.filters.brightness = 999; badFilter.layers = [fi];
  assert.equal(validateDesign(badFilter).ok, false);
});

test('design model: built-in templates are real editable designs', () => {
  // Design-only list: the full library also holds video + deck templates
  // (listBuiltinTemplates() with no kind), which have no .design.
  const list = listBuiltinTemplates('design');
  assert.ok(list.length >= 20, `expected >= 20 design templates, got ${list.length}`);
  for (const t of list) {
    assert.ok(t.design.layers.length >= 3, `${t.id} has too few layers`);
    assert.equal(validateDesign(t.design).ok, true, `${t.id}: ${JSON.stringify(validateDesign(t.design).errors)}`);
    assert.ok(t.design.layers.every((l) => ['text', 'shape', 'image'].includes(l.type)));
  }
  const promo = builtinTemplate('builtin-promo-post');
  assert.equal(promo.name, 'Instagram Promo Post');
  assert.equal(builtinTemplate('nope'), null);
});

/* ---------- API ---------- */
test('health reports Phase 13', async () => {
  const r = await req('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.phase, 13);
  assert.equal(r.json.version, '2.7.0');
});

test('design endpoints require login', async () => {
  for (const p of ['/api/design/sizes', '/api/design/templates', '/api/design/brands']) {
    const r = await req(p);
    assert.equal(r.status, 401, p);
  }
});

test('sizes and fonts endpoints return real data', async () => {
  const sizes = await req('/api/design/sizes', { cookie: ownerCookie });
  assert.equal(sizes.status, 200);
  assert.ok(sizes.json.sizes.length >= 12);
  assert.ok(sizes.json.sizes.some((s) => s.id === 'youtube-thumbnail' && s.width === 1280 && s.height === 720));
  const fonts = await req('/api/design/fonts', { cookie: ownerCookie });
  assert.equal(fonts.status, 200);
  assert.ok(fonts.json.fonts.includes('Montserrat'));
});

test('validate endpoint accepts and rejects designs', async () => {
  const good = blankDesign(800, 600);
  good.layers = [defaultTextLayer(10, 10, 'Hi')];
  const ok = await req('/api/design/validate', { method: 'POST', cookie: ownerCookie, body: { design: good } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.deepEqual(ok.json.errors, []);
  const bad = blankDesign(800, 600);
  bad.background = { type: 'color', color: 'not-a-color' };
  const no = await req('/api/design/validate', { method: 'POST', cookie: ownerCookie, body: { design: bad } });
  assert.equal(no.status, 200);
  assert.equal(no.json.ok, false);
  assert.ok(no.json.errors.length > 0);
  const missing = await req('/api/design/validate', { method: 'POST', cookie: ownerCookie, body: {} });
  assert.equal(missing.status, 400);
});

test('templates: built-ins listed, user template save/get/delete, isolation', async () => {
  const list = await req('/api/design/templates', { cookie: ownerCookie });
  assert.equal(list.status, 200);
  const builtins = list.json.templates.filter((t) => t.builtin);
  assert.ok(builtins.length >= 8);
  assert.ok(builtins.every((t) => Array.isArray(t.design.layers) && t.design.layers.length >= 3));

  const one = await req('/api/design/templates/builtin-quote-post', { cookie: ownerCookie });
  assert.equal(one.status, 200);
  assert.equal(one.json.template.design.width, 1080);
  const missing = await req('/api/design/templates/builtin-nope', { cookie: ownerCookie });
  assert.equal(missing.status, 404);

  // Invalid design cannot be saved as a template.
  const badDesign = blankDesign(100, 100);
  badDesign.layers = [{ id: 'z', type: 'text', x: 0, y: 0, w: 10, h: 10, text: { text: 'x', fontSize: 99999 } }];
  const bad = await req('/api/design/templates', { method: 'POST', cookie: ownerCookie, body: { name: 'Bad', content: badDesign } });
  assert.equal(bad.status, 400);

  const design = blankDesign(1080, 1080);
  design.layers = [defaultTextLayer(50, 50, 'My Template'), defaultShapeLayer('rect', 50, 200, 200, 100, { fill: '#22d3ee' })];
  const saved = await req('/api/design/templates', { method: 'POST', cookie: ownerCookie, body: { name: 'My Promo', category: 'Promo', content: design } });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  assert.equal(saved.json.template.builtin, false);
  const tid = saved.json.template.id;

  const got = await req(`/api/design/templates/${tid}`, { cookie: ownerCookie });
  assert.equal(got.status, 200);
  assert.equal(got.json.template.design.layers.length, 2);

  // Other user cannot see or delete it.
  const otherGet = await req(`/api/design/templates/${tid}`, { cookie: userCookie });
  assert.equal(otherGet.status, 404);
  const otherDel = await req(`/api/design/templates/${tid}`, { method: 'DELETE', cookie: userCookie });
  assert.equal(otherDel.status, 404);

  // Built-ins cannot be deleted.
  const delBuiltin = await req('/api/design/templates/builtin-promo-post', { method: 'DELETE', cookie: ownerCookie });
  assert.equal(delBuiltin.status, 400);

  const del = await req(`/api/design/templates/${tid}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 200);
  const gone = await req(`/api/design/templates/${tid}`, { cookie: ownerCookie });
  assert.equal(gone.status, 404);
});

let logoMediaId;
test('brands: CRUD, validation, logo ownership, isolation', async () => {
  // Upload a real image to use as a logo.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'logo.png');
  const up = await req('/api/media/upload', { method: 'POST', cookie: ownerCookie, form });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  logoMediaId = up.json.media.id;

  const badColor = await req('/api/design/brands', { method: 'POST', cookie: ownerCookie, body: { name: 'Bad', primaryColor: 'purple' } });
  assert.equal(badColor.status, 400);
  const noName = await req('/api/design/brands', { method: 'POST', cookie: ownerCookie, body: { primaryColor: '#111111' } });
  assert.equal(noName.status, 400);
  const badLogo = await req('/api/design/brands', { method: 'POST', cookie: ownerCookie, body: { name: 'Bad logo', logoMediaId: 99999 } });
  assert.equal(badLogo.status, 400);

  const created = await req('/api/design/brands', {
    method: 'POST', cookie: ownerCookie,
    body: {
      name: 'Studio Brand', logoMediaId, primaryColor: '#7c5cff', secondaryColor: '#3b82f6',
      accentColor: '#22d3ee', fontHeading: 'Poppins', fontBody: 'Inter',
      handles: { instagram: '@studio', facebook: 'studio' },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const bid = created.json.brand.id;
  assert.equal(created.json.brand.handles.instagram, '@studio');

  const list = await req('/api/design/brands', { cookie: ownerCookie });
  assert.equal(list.status, 200);
  assert.ok(list.json.brands.some((b) => b.id === bid));

  const updated = await req(`/api/design/brands/${bid}`, { method: 'PATCH', cookie: ownerCookie, body: { primaryColor: '#ef4444', fontHeading: 'Montserrat' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.brand.primaryColor, '#ef4444');
  assert.equal(updated.json.brand.fontHeading, 'Montserrat');
  assert.equal(updated.json.brand.secondaryColor, '#3b82f6', 'unchanged fields stay');

  // Other user cannot see, edit or delete this brand.
  const otherList = await req('/api/design/brands', { cookie: userCookie });
  assert.ok(!otherList.json.brands.some((b) => b.id === bid));
  const otherPatch = await req(`/api/design/brands/${bid}`, { method: 'PATCH', cookie: userCookie, body: { name: 'Hijack' } });
  assert.equal(otherPatch.status, 404);
  const otherDel = await req(`/api/design/brands/${bid}`, { method: 'DELETE', cookie: userCookie });
  assert.equal(otherDel.status, 404);

  const del = await req(`/api/design/brands/${bid}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 200);
  const gone = await req('/api/design/brands', { cookie: ownerCookie });
  assert.ok(!gone.json.brands.some((b) => b.id === bid));
});

test('design project round-trip: save, reopen, every layer preserved', async () => {
  const design = blankDesign(1080, 1080);
  design.background = { type: 'gradient', color: '#7c5cff', gradient: { from: '#111832', to: '#7c5cff', angle: 45 } };
  const groupId = 'grp_test_1';
  const headline = defaultTextLayer(90, 120, 'Round Trip', { fontSize: 96 });
  headline.text.shadow = { color: '#000000', blur: 6, offsetX: 2, offsetY: 2 };
  headline.groupId = groupId;
  const shape = defaultShapeLayer('rect', 90, 300, 400, 120, { fill: '#22d3ee', radius: 20 });
  shape.groupId = groupId;
  const img = defaultImageLayer(600, 300, 300, 300, `/api/media/${logoMediaId}/file`, logoMediaId);
  img.image.filters = { grayscale: 20, sepia: 10, brightness: 110, contrast: 105, saturate: 90 };
  img.image.crop = { left: 5, top: 5, right: 5, bottom: 5 };
  img.image.flipH = true;
  design.layers = [headline, shape, img];

  const created = await req('/api/projects', { method: 'POST', cookie: ownerCookie, body: { name: 'Round Trip Design', type: 'design', content: design } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const pid = created.json.project.id;

  // Simulate an edit: change headline text, add a layer, then autosave.
  design.layers[0].text.text = 'Round Trip (edited)';
  design.layers.push(defaultTextLayer(90, 900, 'Footer note', { fontSize: 28 }));
  const saved = await req(`/api/projects/${pid}`, { method: 'PATCH', cookie: ownerCookie, body: { content: design, saveVersion: true } });
  assert.equal(saved.status, 200);

  const reopened = await req(`/api/projects/${pid}`, { cookie: ownerCookie });
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.json.project.content, design, 'reopened design must match exactly what was saved');
  assert.equal(reopened.json.project.content.layers[0].text.text, 'Round Trip (edited)');
  assert.equal(reopened.json.project.content.layers[2].image.filters.grayscale, 20);
  assert.equal(reopened.json.project.content.layers[0].groupId, 'grp_test_1');
  assert.equal(reopened.json.project.content.background.gradient.angle, 45);

  const versions = await req(`/api/projects/${pid}/versions`, { cookie: ownerCookie });
  assert.ok(versions.json.versions.length >= 1);
  await req(`/api/projects/${pid}/trash`, { method: 'POST', cookie: ownerCookie });
  await req(`/api/projects/${pid}`, { method: 'DELETE', cookie: ownerCookie });
});

test('editor frontend assets are served and contain the export code', async () => {
  const js = await req('/editor.js');
  assert.equal(js.status, 200);
  assert.ok(js.text.includes('renderToCanvas'), 'editor.js must contain the canvas export renderer');
  assert.ok(js.text.includes('exportDesign'), 'editor.js must contain the export function');
  assert.ok(js.text.includes('toBlob'), 'export must produce a real blob download');
  const css = await req('/editor.css');
  assert.equal(css.status, 200);
  assert.ok(css.text.includes('.ed-stage'));
  const index = await req('/');
  assert.equal(index.status, 200);
  assert.ok(index.text.includes('/editor.js'), 'index.html must load the editor');
  assert.ok(index.text.includes('fonts.googleapis.com'), 'Google Fonts must be loaded for typography');
});

/* ---------- v2.3.0 CapCut design pass ---------- */

test('v2.3.0 sidebar: CapCut grouping — every feature under its proper heading, nothing mixed', async () => {
  const js = await req('/app.js');
  assert.equal(js.status, 200);
  const m = js.text.match(/const NAV = (\[[\s\S]*?\n\];)/);
  assert.ok(m, 'app.js must define the NAV array');
  const NAV = new Function(`return (${m[1].slice(0, -1)})`)();
  const sections = NAV.filter((n) => n.section).map((n) => n.section);
  assert.deepEqual(sections, ['Create', 'AI Studio', 'Edit', 'Bulk & Automation', 'Library', 'Publish & Grow', 'Account'],
    'sidebar groups must be CapCut-ordered: Create, AI Studio, Edit, Bulk & Automation, Library, Publish & Grow, Account');
  // Walk the NAV in order and record which section each item sits under.
  const groupOf = {};
  let current = null;
  for (const n of NAV) {
    if (n.section) { current = n.section; continue; }
    assert.ok(!groupOf[n.id], `nav item ${n.id} must appear exactly once`);
    groupOf[n.id] = current;
  }
  const expected = {
    home: 'Create', dashboard: 'Create', 'ai-design': 'Create', 'graphic-editor': 'Create', presentations: 'Create', documents: 'Create', charts: 'Create', sheets: 'Create',
    'ai-studio': 'AI Studio', 'ai-video': 'AI Studio', 'ai-image': 'AI Studio', assistant: 'AI Studio',
    'video-editor': 'Edit', effects: 'Edit', transitions: 'Edit', animation: 'Edit', 'bg-remover': 'Edit', captions: 'Edit',
    'bulk-design': 'Bulk & Automation', 'bulk-video': 'Bulk & Automation', 'template-builder': 'Bulk & Automation',
    shorts: 'Bulk & Automation', music: 'Bulk & Automation', voices: 'Bulk & Automation',
    media: 'Library', stock: 'Library', marketplace: 'Library', projects: 'Library', 'brand-kit': 'Library',
    social: 'Publish & Grow', calendar: 'Publish & Grow', planner: 'Publish & Grow', website: 'Publish & Grow', print: 'Publish & Grow',
    export: 'Publish & Grow', analytics: 'Publish & Grow',
    admin: 'Account', settings: 'Account', subscription: 'Account',
  };
  assert.equal(Object.keys(groupOf).length, 39, 'sidebar must list all 38 features + Home');
  for (const [id, section] of Object.entries(expected)) {
    assert.equal(groupOf[id], section, `${id} must sit under "${section}", not "${groupOf[id]}"`);
  }
});

test('v2.3.0 video editor: CapCut left tabs, magnetic timeline, Export top-right', async () => {
  const js = await req('/video-editor.js');
  assert.equal(js.status, 200);
  for (const tab of ['media', 'audio', 'text', 'stickers', 'effects', 'transitions', 'captions', 'filters']) {
    assert.ok(js.text.includes(`data-ltab="${tab}"`), `video editor left rail must have a ${tab} tab`);
  }
  assert.ok(js.text.includes('ve-magnet'), 'timeline must have a Magnet toggle');
  assert.ok(js.text.includes('ed.magnet !== false'), 'clip-edge snapping must be gated on the Magnet toggle');
  assert.ok(js.text.includes('magnet: true'), 'magnet must default to on');
  assert.ok(js.text.includes('⬆ Export'), 'top-right action must be Export (was Render)');
  assert.ok(js.text.includes('id="ve-goto-export"'), 'Export button must keep its id');
  assert.ok(js.text.includes("data-seek-clip"), 'Captions tab must let the user jump to a text clip');
  assert.ok(js.text.includes("tab === 'audio'"), 'Audio tab must list audio files separately from video');
  assert.ok(js.text.includes("data-bundle-sticker"), 'Stickers tab places real stickers on the timeline (v2.5.0 bundled library — no longer an empty state)');
  assert.ok(js.text.includes('function addSticker'), 'sticker placement builds an overlay-track image clip');
  const css = await req('/video-editor.css');
  assert.equal(css.status, 200);
  assert.ok(css.text.includes('.ve-left-rail'), 'left panel must be a rail + panel layout');
  assert.ok(css.text.includes('flex-direction: column'), 'tab rail must be vertical on desktop');
  assert.ok(css.text.includes('.ve-playhead::before'), 'playhead must have a visible handle');
  assert.ok(css.text.includes('--editor-rail-w'), 'rail width must come from the CapCut token');
  assert.ok(css.text.includes('calc(100vh'), 'editor must fill the viewport like CapCut');
  assert.ok(css.text.includes('@media (max-width: 860px)'), 'editor must stack on mobile');
});

test('v2.3.0 graphic editor: vertical icon rail, Elements tab, Export top-right kept', async () => {
  const js = await req('/editor.js');
  assert.equal(js.status, 200);
  assert.ok(js.text.includes('data-tab="add"'), 'Elements tab must keep the data-tab="add" id');
  assert.ok(js.text.includes('>Elements<'), 'Add tab must be labelled Elements (CapCut)');
  for (const label of ['Canvas', 'Elements', 'Layers', 'Templates', 'Media', 'Brand']) {
    assert.ok(js.text.includes(`>${label}<`), `graphic editor rail must have a ${label} tab`);
  }
  assert.ok(js.text.includes('id="ed-export-png"'), 'Export PNG must stay top-right');
  assert.ok(js.text.includes('id="ed-export-jpg"'), 'Export JPG must stay top-right');
  const css = await req('/editor.css');
  assert.equal(css.status, 200);
  assert.ok(css.text.includes('.ed-tabs'), 'graphic editor must style the tab rail');
  assert.ok(css.text.includes('flex-direction: column'), 'graphic editor rail must be vertical on desktop');
});

test('v2.3.0 tokens: CapCut tokens defined in dark AND light — no token left dark-only', async () => {
  const css = await req('/tokens.css');
  assert.equal(css.status, 200);
  const [dark, light] = css.text.split('[data-theme="light"] {');
  assert.ok(light, 'tokens.css must have a light-theme block');
  // Width token: same in both themes, defined once.
  assert.ok(dark.includes('--editor-rail-w:'), 'rail width token must be defined');
  // Colour tokens: must exist in BOTH themes (light parity, not dark-only).
  for (const tok of ['--editor-rail-bg', '--editor-rail-active', '--timeline-bg', '--timeline-track-bg',
    '--timeline-ruler', '--playhead', '--snap-guide', '--stage-bg',
    '--clip-video', '--clip-audio', '--clip-text', '--export-btn', '--export-btn-hover']) {
    assert.ok(dark.includes(tok + ':'), `${tok} must be defined in the dark theme`);
    assert.ok(light.includes(tok + ':'), `${tok} must be defined in the light theme too`);
  }
});

test('v2.3.0 light theme: no hardcoded dark chrome left in docs-slides, no duplicate modal rules', async () => {
  const css = await req('/docs-slides.css');
  assert.equal(css.status, 200);
  assert.ok(!css.text.includes('.modal-back {'), 'docs-slides must not duplicate the shared .modal-back rule (it killed the light backdrop)');
  assert.ok(!css.text.includes('.modal {'), 'docs-slides must not duplicate the shared .modal rule');
  assert.ok(!css.text.includes('#24304f'), 'chart placeholder must not hardcode a dark background');
  assert.ok(css.text.includes('--surface-raised'), 'chart placeholder must use a token');
  assert.ok(css.text.includes('var(--success)'), 'alert colours must use tokens');
  const styles = await req('/styles.css');
  assert.equal(styles.status, 200);
  assert.ok(styles.text.includes('.nav-section'), 'sidebar groups must be styled');
  assert.ok(styles.text.includes('border-top: 1px solid var(--border)'), 'sidebar groups must be separated');
  assert.ok(styles.text.includes('.nav-item .txt'), 'nav labels must have overflow rules (never-overflow)');
  const bulk = await req('/bulk.css');
  assert.equal(bulk.status, 200);
  assert.ok(!bulk.text.includes('color: var(--text-2); font-size: 10px'), 'quiz caption bar must not use muted text on a dark phone frame');
});
