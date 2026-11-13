'use strict';
/* CreativeStudio AI Pro — Phase 1 frontend (vanilla JS, no build step).
   Working views: Dashboard, Projects, Media Library, Settings, Subscription.
   All other sidebar items render an honest "not yet built" state. */

const NAV = [
  { section: 'Create' },
  { id: 'dashboard', label: 'Dashboard', icon: '🏠', phase: 1, live: true },
  { id: 'ai-design', label: 'AI Design Studio', icon: '✨', phase: 7, live: true, blurb: 'Prompt-to-editable-design: AI picks layout, assets, typography and colours, then hands you a fully editable design (never a flattened image).' },
  { id: 'ai-studio', label: 'AI Studio', icon: '✨', phase: 7, live: true, blurb: 'Text-to-image, image-to-video, AI voice, quiz questions, transcription, music — one studio, real provider calls, job queue with cancel & retry.' },
  { id: 'graphic-editor', label: 'Graphic Editor', icon: '🎨', phase: 2, live: true, blurb: 'Canvas editor with layers, shapes, text, filters, brand colours and transparent PNG export.' },
  { id: 'video-editor', label: 'Video Editor', icon: '🎬', phase: 3, live: true, blurb: 'Multi-track timeline, trimming, transitions, keyframes, colour grading and the FFmpeg render engine.' },
  { id: 'ai-video', label: 'AI Video Generator', icon: '🎥', phase: 7, live: true, blurb: 'Text-to-video and image-to-video through configurable providers (Runway Gen-4), with job queue, progress and preview. Needs a video provider key.' },
  { id: 'ai-image', label: 'AI Image Generator', icon: '🖼️', phase: 7, live: true, blurb: 'Text-to-image and image-to-image (OpenAI Images / Stability SD3). Needs an image provider key.' },
  { section: 'Bulk & Automation' },
  { id: 'bulk-design', label: 'Bulk Design Studio', icon: '📄', phase: 4, live: true, blurb: 'One template + spreadsheet = hundreds of personalised designs, with field mapping and ZIP export.' },
  { id: 'bulk-video', label: 'Bulk Video Studio', icon: '📹', phase: 4, live: true, blurb: 'The flagship: one master template, hundreds of rows, and a different background for every video via the Dynamic Background Engine.' },
  { id: 'template-builder', label: 'Smart Template Builder', icon: '🧩', phase: 4, live: true, blurb: 'Build master templates with dynamic fields like {{PRODUCT_NAME}} and {{BACKGROUND_IMAGE}}.' },
  { id: 'shorts', label: 'Long Video to Shorts', icon: '✂️', phase: 6, live: true, blurb: 'Upload a long video; the studio finds the best moments with real local analysis, cuts 9:16 clips and burns in captions.' },
  { id: 'music', label: 'Music Sync Director', icon: '🎵', phase: 5, live: true, blurb: 'Real BPM/beat analysis (local DSP, no key) that syncs cuts, transitions and effects to the music. Licensed or user-provided music only.' },
  { id: 'voices', label: 'Voices', icon: '🎙️', phase: 5, live: true, blurb: 'Your own voice from a short sample (default on all videos) plus AI voices — narration for quizzes & bulk videos. AI speech needs a provider key; recorded narration works now.' },
  { id: 'captions', label: 'Auto Captions', icon: '💬', phase: 6, live: true, blurb: 'Multilingual captions incl. Urdu, Roman Urdu and Arabic (RTL), word-by-word burn-in, SRT/VTT export. STT needs a provider key; manual transcripts work now.' },
  { section: 'Tools' },
  { id: 'bg-remover', label: 'Background Remover', icon: '🪄', phase: 7, blurb: 'One-click background removal for images and video, powered by a configurable AI provider.' },
  { id: 'effects', label: 'Effects & Transitions', icon: '🌈', phase: 3, live: true, blurb: 'Searchable library of filters, transitions, motion effects and text animations.' },
  { id: 'animation', label: 'Animation Studio', icon: '🎞️', phase: 3, live: true, blurb: 'Keyframes with linear interpolation and text fade/slide animations. Motion paths and easing curves are not built yet.' },
  { id: 'brand-kit', label: 'Brand Kit', icon: '🏷️', phase: 2, live: true, blurb: 'Multiple brand profiles: logos, colours and fonts — one-click apply to designs.' },
  { section: 'Library' },
  { id: 'media', label: 'Media Library', icon: '🗂️', phase: 1, live: true },
  { id: 'stock', label: 'Stock Assets', icon: '📚', phase: 8, blurb: 'Licensed stock images, videos, music and sound effects with favourites and collections.' },
  { section: 'Publish & Grow' },
  { id: 'social', label: 'Social Media Creator', icon: '📣', phase: 8, live: true, blurb: 'AI post/caption/hashtag generator, thumbnails and optional publishing via official platform APIs.' },
  { id: 'calendar', label: 'Content Calendar', icon: '📅', phase: 8, live: true, blurb: 'Plan and schedule content across platforms from one calendar.' },
  { id: 'export', label: 'Export Center', icon: '📤', phase: 3, live: true, blurb: 'Batch export: PNG/JPG designs and MP4 videos at 720p/1080p, with ZIP download.' },
  { id: 'projects', label: 'Projects', icon: '📁', phase: 1, live: true },
  { id: 'marketplace', label: 'Templates Marketplace', icon: '🛍️', phase: 8, live: true, blurb: 'Browse, favourite and use community and premium templates.' },
  { id: 'assistant', label: 'AI Assistant', icon: '🤖', phase: 7, blurb: 'A project-aware assistant: "make this more professional", "sync with music", "create five versions" — previews before destructive edits.' },
  { id: 'analytics', label: 'Analytics', icon: '📊', phase: 8, live: true, blurb: 'Projects, renders, exports and credit usage over time.' },
  { section: 'Account' },
  { id: 'admin', label: 'Admin Panel', icon: '🛡️', phase: 8, live: true, blurb: 'Users, plan requests, platform stats, audit log and system health (OWNER/ADMIN only).' },
  { id: 'settings', label: 'Settings', icon: '⚙️', phase: 1, live: true },
  { id: 'subscription', label: 'Subscription & Credits', icon: '💳', phase: 1, live: true },
];

const state = { user: null, view: 'dashboard', params: {}, data: {}, searchTimer: null };
const root = document.getElementById('root');

// v2.2.0 — OWNER Lifetime Free: Lifetime / Enterprise plans and the OWNER
// role are unlimited — never show them a finite credit number.
function isUnlimitedUser(u) {
  return !!u && (u.plan === 'Lifetime' || u.plan === 'Enterprise' || u.role === 'OWNER');
}
function creditsLabel(u) {
  return isUnlimitedUser(u) ? 'Unlimited credits' : `${u.creditsBalance} credits`;
}

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}
async function apiForm(path, formData) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', body: formData });
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new Error((body && body.error) || `Upload failed (${res.status})`);
  return body;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
};
const fmtDate = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString() : '—';

function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/* ---------- Theme (v2.0.0): Light / Dark, persisted, OS-aware on first load ---------- */
function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('cs-theme', t); } catch { /* private mode */ }
  const b = document.getElementById('theme-btn');
  if (b) { b.textContent = t === 'light' ? '🌙' : '☀️'; b.title = t === 'light' ? 'Switch to dark theme' : 'Switch to light theme'; b.setAttribute('aria-label', b.title); }
}

/* ---------- Routing ---------- */
function go(view, params = {}) {
  state.view = view; state.params = params;
  closeNotif();
  render();
  window.scrollTo(0, 0);
}

async function boot() {
  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
  } catch { state.user = null; }
  render();
}

/* ---------- Shell ---------- */
function render() {
  if (!state.user) return renderAuth();
  const nav = NAV.find((n) => n.id === state.view) || NAV[1];
  root.innerHTML = `
  <div class="app">
    <aside class="sidebar">
      <div class="logo"><div class="logo-mark">C</div><div class="logo-name">Creative<span>Studio</span> AI Pro</div></div>
      <nav class="nav">
        ${NAV.map((n) => n.section
          ? `<div class="nav-section">${esc(n.section)}</div>`
          : `<button class="nav-item ${state.view === n.id ? 'active' : ''}" data-nav="${n.id}">
               <span class="ico">${n.icon}</span><span class="txt">${esc(n.label)}</span>
               ${n.live ? '<span class="phase done">Live</span>' : `<span class="phase">P${n.phase}</span>`}
             </button>`).join('')}
      </nav>
      <div class="sidebar-foot">
        <div class="user-chip">
          <div class="avatar">${esc((state.user.name || '?')[0].toUpperCase())}</div>
          <div class="who"><div class="nm">${esc(state.user.name)}</div><div class="rl">${esc(state.user.role)} · ${esc(state.user.plan)}</div></div>
        </div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn hamburger" id="hamburger" aria-label="Open menu">☰</button>
        <h1>${esc(nav.label)}</h1>
        <div class="search-box">
          <span class="s-ico">🔍</span>
          <input id="global-search" type="search" placeholder="Search projects & media…" autocomplete="off">
          <div class="search-results" id="search-results"></div>
        </div>
        <div class="top-actions">
          <span class="credits-pill">⚡ <b>${isUnlimitedUser(state.user) ? 'Unlimited' : state.user.creditsBalance}</b> credits · ${esc(state.user.plan)}</span>
          <button class="icon-btn" id="theme-btn" title="Switch to light theme" aria-label="Switch to light theme">☀️</button>
          <button class="icon-btn" id="notif-btn" title="Notifications">🔔<span class="dot" id="notif-dot" style="display:none"></span></button>
          <div class="profile-wrap">
            <button class="profile-btn" id="profile-btn" aria-haspopup="true" aria-expanded="false">
              <span class="avatar">${esc((state.user.name || '?')[0].toUpperCase())}</span><span>${esc(state.user.name.split(' ')[0])}</span>
            </button>
            <div class="profile-menu" id="profile-menu">
              <div class="pm-head"><div class="nm">${esc(state.user.name)}</div><div class="em">${esc(state.user.email)}</div><div class="em">${esc(state.user.role)} · ${esc(state.user.plan)} plan · ${creditsLabel(state.user)}</div></div>
              <button class="pm-item" id="pm-settings">⚙️ Settings</button>
              <button class="pm-item" id="pm-subscription">💳 Subscription &amp; Credits</button>
              <button class="pm-item danger" id="pm-logout">Sign out</button>
            </div>
          </div>
        </div>
        <div class="notif-panel" id="notif-panel"><h3>Notifications</h3><div id="notif-list"><div class="notif-item">Loading…</div></div></div>
      </header>
      <main class="content" id="content"></main>
    </div>
  </div>`;
  document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => { document.body.classList.remove('sidebar-open'); go(b.dataset.nav); }));
  document.getElementById('hamburger').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  applyTheme(currentTheme());
  document.getElementById('theme-btn').addEventListener('click', () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light'));
  const profileBtn = document.getElementById('profile-btn');
  const profileMenu = document.getElementById('profile-menu');
  profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = profileMenu.classList.toggle('open');
    profileBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    closeNotif();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.profile-wrap')) { profileMenu.classList.remove('open'); profileBtn.setAttribute('aria-expanded', 'false'); }
  });
  document.getElementById('pm-settings').addEventListener('click', () => go('settings'));
  document.getElementById('pm-subscription').addEventListener('click', () => go('subscription'));
  document.getElementById('pm-logout').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    state.user = null; render();
  });
  document.getElementById('notif-btn').addEventListener('click', toggleNotif);
  const searchInput = document.getElementById('global-search');
  searchInput.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => runGlobalSearch(searchInput.value.trim()), 250);
  });
  searchInput.addEventListener('blur', () => setTimeout(() => { const r = document.getElementById('search-results'); if (r) r.style.display = 'none'; }, 200));
  renderView();
}

async function runGlobalSearch(q) {
  const box = document.getElementById('search-results');
  if (!box) return;
  if (!q) { box.style.display = 'none'; return; }
  try {
    const [p, m] = await Promise.all([api(`/api/projects?search=${encodeURIComponent(q)}`), api(`/api/media?search=${encodeURIComponent(q)}`)]);
    const rows = [
      ...p.projects.slice(0, 5).map((x) => ({ label: `📁 ${x.name} — project`, go: () => go('project', { id: x.id }) })),
      ...m.media.slice(0, 5).map((x) => ({ label: `🗂️ ${x.originalName} — ${x.kind}`, go: () => go('media') })),
    ];
    box.innerHTML = rows.length ? '' : '<div>No matches found.</div>';
    rows.forEach((r) => {
      const d = document.createElement('div');
      d.textContent = r.label;
      d.addEventListener('mousedown', r.go);
      box.appendChild(d);
    });
    box.style.display = 'block';
  } catch (e) { box.style.display = 'none'; }
}

async function toggleNotif() {
  const panel = document.getElementById('notif-panel');
  if (!panel) return;
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  try {
    const { notifications } = await api('/api/notifications');
    const dot = document.getElementById('notif-dot');
    if (dot) dot.style.display = notifications.length ? 'flex' : 'none';
    document.getElementById('notif-list').innerHTML = notifications.length
      ? notifications.map((n) => `<div class="notif-item">${esc(n.detail || n.action)}<small>${fmtDate(n.createdAt)}</small></div>`).join('')
      : '<div class="notif-item">No activity yet. Create a project or upload media and it will show up here.</div>';
  } catch (e) {
    document.getElementById('notif-list').innerHTML = `<div class="notif-item">Could not load notifications: ${esc(e.message)}</div>`;
  }
}
function closeNotif() { const p = document.getElementById('notif-panel'); if (p) p.style.display = 'none'; }

async function renderView() {
  const c = document.getElementById('content');
  if (!c) return;
  /* Skeleton loading state (v2.0.0): shaped like the content, not a blank area. */
  c.innerHTML = `<div class="grid grid-4" aria-hidden="true">
    <div class="skel-card"><div class="skeleton" style="height:14px;width:40%"></div><div class="skeleton" style="height:28px;width:60%;margin-top:12px"></div></div>
    <div class="skel-card"><div class="skeleton" style="height:14px;width:40%"></div><div class="skeleton" style="height:28px;width:50%;margin-top:12px"></div></div>
    <div class="skel-card"><div class="skeleton" style="height:14px;width:40%"></div><div class="skeleton" style="height:28px;width:55%;margin-top:12px"></div></div>
    <div class="skel-card"><div class="skeleton" style="height:14px;width:40%"></div><div class="skeleton" style="height:28px;width:45%;margin-top:12px"></div></div>
  </div>
  <div class="skel-card" style="margin-top:16px" aria-hidden="true"><div class="skeleton" style="height:16px;width:30%"></div><div class="skeleton" style="height:12px;width:80%;margin-top:12px"></div><div class="skeleton" style="height:12px;width:65%;margin-top:8px"></div></div>`;
  const v = state.view;
  try {
    if (v === 'dashboard') return await viewDashboard(c);
    if (v === 'graphic-editor') return await viewGraphicEditor(c);
    if (v === 'design-editor') return await viewDesignEditor(c);
    if (v === 'video-editor') return await viewVideoEditor(c);
    if (v === 'video-timeline') return await viewVideoTimeline(c);
    if (v === 'export') return await viewExportCenter(c);
    if (v === 'effects') return await viewEffects(c);
    if (v === 'animation') return await viewAnimation(c);
    if (v === 'ai-design') return await viewAIDesign(c);
    if (v === 'ai-studio') return await viewAIStudio(c);
    if (v === 'ai-video') return await viewAIStudio(c, 'video');
    if (v === 'ai-image') return await viewAIStudio(c, 'image');
    if (v === 'brand-kit') return await viewBrandKit(c);
    if (v === 'projects') return await viewProjects(c);
    if (v === 'project') return await viewProjectDetail(c);
    if (v === 'media') return await viewMedia(c);
    if (v === 'bulk-video') return await viewBulkVideo(c);
    if (v === 'bulk-design') return await viewBulkDesign(c);
    if (v === 'music') return await viewMusicSync(c);
    if (v === 'voices') return await viewVoices(c);
    if (v === 'shorts') return await viewShorts(c);
    if (v === 'captions') return await viewCaptions(c);
    if (v === 'template-builder') return await viewTemplateBuilder(c);
    if (v === 'social') return await viewSocial(c);
    if (v === 'calendar') return await viewCalendar(c);
    if (v === 'marketplace') return await viewMarketplace(c);
    if (v === 'admin') return await viewAdmin(c);
    if (v === 'analytics') return await viewAnalytics(c);
    if (v === 'settings') return await viewSettings(c);
    if (v === 'subscription') return await viewSubscription(c);
    return viewPlaceholder(c, NAV.find((n) => n.id === v));
  } catch (e) {
    c.innerHTML = `<div class="empty"><div class="big">⚠️</div><h3 style="margin-bottom:6px">Something went wrong</h3><p>${esc(e.message)}</p><p style="margin-top:6px">Check your connection and try again — your data was not changed.</p><button class="btn btn-primary" id="view-retry">Try again</button> <button class="btn" id="view-reload">Reload page</button></div>`;
    document.getElementById('view-retry').addEventListener('click', () => renderView());
    document.getElementById('view-reload').addEventListener('click', () => location.reload());
  }
}

/* ---------- Auth screen ---------- */
function renderAuth() {
  root.innerHTML = `
  <div class="auth-wrap"><div class="auth-card">
    <div class="logo"><div class="logo-mark">C</div><div class="logo-name">Creative<span>Studio</span> AI Pro</div></div>
    <p class="auth-sub">All-in-one AI design, video & bulk content studio.<br>v2.2.1 — Free AI + Super Admin</p>
    <div class="auth-toggle">
      <button id="tab-login" class="active">Log in</button>
      <button id="tab-signup">Sign up</button>
    </div>
    <div class="error" id="auth-error"></div>
    <div class="success" id="auth-ok"></div>
    <form id="auth-form">
      <div id="name-field" style="display:none"><label for="f-name">Full name</label><input id="f-name" autocomplete="name"></div>
      <label for="f-email">Email</label>
      <input id="f-email" type="email" required autocomplete="email" placeholder="you@example.com">
      <label for="f-pass">Password</label>
      <input id="f-pass" type="password" required autocomplete="current-password" placeholder="At least 8 characters">
      <div style="margin-top:18px"><button class="btn btn-primary" style="width:100%;justify-content:center" type="submit" id="auth-submit">Log in</button></div>
    </form>
    <p class="hint">The first account created on this installation becomes the <b>OWNER</b>. Later accounts are regular users. Passwords are hashed with scrypt and never stored in plain text.</p>
  </div></div>`;
  let mode = 'login';
  const errBox = document.getElementById('auth-error');
  const okBox = document.getElementById('auth-ok');
  const setMode = (m) => {
    mode = m;
    document.getElementById('tab-login').classList.toggle('active', m === 'login');
    document.getElementById('tab-signup').classList.toggle('active', m === 'signup');
    document.getElementById('name-field').style.display = m === 'signup' ? 'block' : 'none';
    document.getElementById('auth-submit').textContent = m === 'signup' ? 'Create account' : 'Log in';
    errBox.style.display = 'none'; okBox.style.display = 'none';
  };
  document.getElementById('tab-login').addEventListener('click', () => setMode('login'));
  document.getElementById('tab-signup').addEventListener('click', () => setMode('signup'));
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.style.display = 'none'; okBox.style.display = 'none';
    const email = document.getElementById('f-email').value.trim();
    const password = document.getElementById('f-pass').value;
    const name = document.getElementById('f-name').value.trim();
    try {
      const body = mode === 'signup'
        ? await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name, email, password }) })
        : await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      state.user = body.user;
      if (mode === 'signup' && body.firstAccount) toast('Welcome! You are the OWNER of this installation.');
      render();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  });
}

/* ---------- Dashboard ---------- */
async function viewDashboard(c) {
  const [d, upd] = await Promise.all([
    api('/api/dashboard'),
    api('/api/updates/status').catch(() => null),
  ]);
  const ff = d.system.ffmpeg;
  const usedPct = d.storage.limitBytes ? Math.min(100, Math.round((d.storage.usedBytes / d.storage.limitBytes) * 100)) : 0;
  c.innerHTML = `
  ${upd && upd.available && !upd.availableDismissed ? `<div class="card" style="border-color:var(--warning);margin-bottom:16px"><h3>⬆ Update available: v${esc(upd.latest)}</h3>
    <p class="sub">${esc(upd.available.notes || 'A new version is on the update feed.')}</p>
    ${upd.available.fullReinstall ? '<p class="sub" style="color:var(--warning)">⚠ This update changes dependencies and needs a fresh download — download the new portable/source package from Drive instead of applying it here.</p>' : ''}
    <div style="margin-top:10px">
      ${!upd.available.fullReinstall ? '<button class="btn btn-primary" id="dash-update-now">Update now</button> ' : ''}
      <button class="btn" id="dash-update-settings">Update settings</button>
      <button class="btn btn-ghost" id="dash-update-dismiss">Dismiss</button>
    </div></div>` : ''}
  ${upd && upd.pendingRestart ? `<div class="card" style="border-color:var(--warning);margin-bottom:16px"><h3>✓ Update applied${upd.lastApplied ? ` — v${esc(upd.lastApplied.version)}` : ''}</h3>
    <p class="sub">The new files are in place. Restart the server (close Start.bat / run npm start again) to finish the update.</p></div>` : ''}
  <div class="grid grid-4">
    <div class="stat"><div class="lbl">Projects</div><div class="num">${d.counts.projects}</div><div class="foot">${d.counts.trashedProjects} in trash</div></div>
    <div class="stat"><div class="lbl">Media files</div><div class="num">${d.counts.media}</div><div class="foot">${esc(d.storage.usedLabel)} used</div></div>
    <div class="stat"><div class="lbl">Render jobs</div><div class="num">${d.counts.jobs}</div><div class="foot">${d.counts.jobsActive} active · FFmpeg render engine live</div></div>
    <div class="stat"><div class="lbl">AI credits</div><div class="num">${(d.plan === 'Lifetime' || d.plan === 'Enterprise') ? '∞' : d.creditsBalance}</div><div class="foot">${esc(d.plan)} plan · ledger in Subscription &amp; Credits</div></div>
  </div>
  <div class="quick-actions">
    <button class="btn btn-primary" id="qa-project">＋ New project</button>
    <button class="btn" id="qa-media">⬆ Upload media</button>
    <button class="btn" id="qa-bulk">Bulk Video Studio — Phase 4</button>
  </div>
  <div class="grid grid-2" style="margin-top:16px">
    <div class="card"><h3>Recent projects</h3>
      ${d.recentProjects.length ? d.recentProjects.map((p) => `
        <div class="list-row" data-open-project="${p.id}" style="cursor:pointer">
          <div class="grow"><div class="t">${esc(p.name)}</div><div class="m">${esc(p.type)} · updated ${fmtDate(p.updatedAt)}</div></div>
          <span class="badge">Open →</span>
        </div>`).join('') : '<p class="sub" style="margin-top:8px">No projects yet.</p><button class="btn btn-primary btn-sm" id="dash-create-project" style="margin-top:12px">＋ Create your first project</button>'}
      <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" id="dash-all-projects">View all projects →</button></div>
    </div>
    <div class="card"><h3>System status</h3>
      <div class="kv"><span>Database</span><span class="badge ok">● OK</span></div>
      <div class="kv"><span>FFmpeg (rendering engine)</span><span class="badge ${ff.available ? 'ok' : 'err'}">${ff.available ? '● Available · ' + esc(ff.version) : '● Not found'}</span></div>
      <div class="kv"><span>Storage used</span><span>${esc(d.storage.usedLabel)} of ${esc(d.storage.limitLabel)}</span></div>
      <div class="progress"><div style="width:${usedPct}%"></div></div>
      <div class="kv"><span>Max upload size</span><span>${d.system.maxUploadMB} MB</span></div>
      <div class="kv"><span>Version</span><span class="mono">${esc(d.system.version)}</span></div>
      ${ff.available ? '' : '<p class="sub" style="margin-top:10px">FFmpeg is required for video rendering in Phase 3. Install it and restart the server — the status above will turn green.</p>'}
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Recent media</h3>
    ${d.recentMedia.length ? `<div class="media-grid" style="margin-top:12px">${d.recentMedia.map((m) => `
      <div class="media-card"><div class="thumb">${m.kind === 'image' ? `<img src="${m.url}" alt="">` : `<span class="file-ico">${m.kind === 'video' ? '🎬' : '🎵'}</span>`}</div>
      <div class="body"><div class="nm">${esc(m.originalName)}</div><div class="mt">${esc(m.kind)}</div></div></div>`).join('')}</div>`
    : '<p class="sub" style="margin-top:8px">No media uploaded yet.</p>'}
  </div>`;
  document.getElementById('qa-project').addEventListener('click', () => openProjectModal());
  const dashUpdateNow = document.getElementById('dash-update-now');
  if (dashUpdateNow) dashUpdateNow.addEventListener('click', async () => {
    if (!confirm('Apply the available update now? The current version is backed up first.')) return;
    dashUpdateNow.textContent = 'Updating…'; dashUpdateNow.disabled = true;
    try {
      const r = await api('/api/updates/apply', { method: 'POST' });
      toast(r.message || `Updated to ${r.to}.`);
      setTimeout(() => { window.location.reload(); }, 3000);
    } catch (e) { toast(e.message, true); renderView(); }
  });
  const dashUpdateSettings = document.getElementById('dash-update-settings');
  if (dashUpdateSettings) dashUpdateSettings.addEventListener('click', () => go('settings'));
  const dashUpdateDismiss = document.getElementById('dash-update-dismiss');
  if (dashUpdateDismiss) dashUpdateDismiss.addEventListener('click', async () => {
    try { await api('/api/updates/dismiss', { method: 'POST', body: JSON.stringify({ version: upd.latest }) }); } catch { /* ignore */ }
    renderView();
  });
  const dashCreate = document.getElementById('dash-create-project');
  if (dashCreate) dashCreate.addEventListener('click', () => openProjectModal());
  document.getElementById('qa-media').addEventListener('click', () => go('media'));
  document.getElementById('qa-bulk').addEventListener('click', () => go('bulk-video'));
  document.getElementById('dash-all-projects').addEventListener('click', () => go('projects'));
  c.querySelectorAll('[data-open-project]').forEach((el) => el.addEventListener('click', () => go('project', { id: el.dataset.openProject })));
}

/* ---------- Projects ---------- */
async function viewProjects(c) {
  const [res, folders] = await Promise.all([api('/api/projects'), api('/api/projects/folders/list')]);
  const trash = await api('/api/projects?trashed=1');
  const showTrash = state.params.trash === true;
  const list = showTrash ? trash.projects : res.projects;
  c.innerHTML = `
  <div class="toolbar">
    <button class="btn btn-primary" id="new-project-btn">＋ New project</button>
    <button class="btn" id="new-folder-btn">＋ Folder</button>
    <input id="proj-search" type="search" placeholder="Search projects…" value="${esc(state.params.q || '')}">
    <select id="proj-type"><option value="">All types</option>${['design', 'video', 'bulk', 'shorts', 'social'].map((t) => `<option ${state.params.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <button class="btn ${showTrash ? 'btn-danger' : ''}" id="trash-toggle">${showTrash ? '← Back to projects' : `🗑 Trash (${trash.projects.length})`}</button>
  </div>
  <div id="proj-list">
    ${list.length ? list.map((p) => `
      <div class="list-row">
        <div class="grow" style="cursor:pointer" data-open="${p.id}">
          <div class="t">${esc(p.name)}</div>
          <div class="m">${esc(p.type)} · updated ${fmtDate(p.updatedAt)}</div>
        </div>
        <span class="badge">${esc(p.type)}</span>
        ${showTrash ? `
          <button class="btn btn-sm" data-restore="${p.id}">Restore</button>
          <button class="btn btn-sm btn-danger" data-del="${p.id}">Delete forever</button>`
        : `
          <button class="btn btn-sm" data-dup="${p.id}">Duplicate</button>
          <button class="btn btn-sm btn-danger" data-trash="${p.id}">Trash</button>`}
      </div>`).join('') : `<div class="empty"><div class="big">📁</div><p>${showTrash ? 'Trash is empty.' : 'No projects yet.'}</p><p style="margin-top:6px">Create your first project to get started.</p></div>`}
  </div>
  ${folders.folders.length ? `<div class="card" style="margin-top:16px"><h3>Folders</h3>${folders.folders.map((f) => `<div class="kv"><span>📁 ${esc(f.name)}</span><button class="btn btn-sm btn-ghost" data-del-folder="${f.id}">Delete</button></div>`).join('')}</div>` : ''}`;
  document.getElementById('new-project-btn').addEventListener('click', () => openProjectModal());
  document.getElementById('new-folder-btn').addEventListener('click', () => openFolderModal('project'));
  document.getElementById('trash-toggle').addEventListener('click', () => go('projects', { trash: !showTrash }));
  const search = document.getElementById('proj-search');
  search.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(async () => {
      const q = search.value.trim();
      const r = await api(`/api/projects?search=${encodeURIComponent(q)}${showTrash ? '&trashed=1' : ''}`);
      state.params.q = q; renderView();
    }, 300);
  });
  document.getElementById('proj-type').addEventListener('change', (e) => {
    const t = e.target.value;
    c.querySelectorAll('#proj-list .list-row').forEach((row) => {
      row.style.display = !t || row.querySelector('.badge').textContent === t ? 'flex' : 'none';
    });
  });
  c.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => go('project', { id: el.dataset.open })));
  c.querySelectorAll('[data-dup]').forEach((el) => el.addEventListener('click', async () => {
    try { await api(`/api/projects/${el.dataset.dup}/duplicate`, { method: 'POST' }); toast('Project duplicated.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-trash]').forEach((el) => el.addEventListener('click', async () => {
    try { await api(`/api/projects/${el.dataset.trash}/trash`, { method: 'POST' }); toast('Moved to trash.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-restore]').forEach((el) => el.addEventListener('click', async () => {
    try { await api(`/api/projects/${el.dataset.restore}/restore`, { method: 'POST' }); toast('Project restored.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', async () => {
    if (!confirm('Permanently delete this project? This cannot be undone.')) return;
    try { await api(`/api/projects/${el.dataset.del}`, { method: 'DELETE' }); toast('Project permanently deleted.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-del-folder]').forEach((el) => el.addEventListener('click', async () => {
    try { await api(`/api/projects/folders/${el.dataset.delFolder}`, { method: 'DELETE' }); toast('Folder deleted.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
}

/* ---------- Project detail (autosave + versions) ---------- */
async function viewProjectDetail(c) {
  const id = state.params.id;
  const { project } = await api(`/api/projects/${id}`);
  const { versions } = await api(`/api/projects/${id}/versions`);
  c.innerHTML = `
  <div class="toolbar" style="margin-top:0">
    <button class="btn" id="back-projects">← Projects</button>
    <span class="badge info">${esc(project.type)}</span>
    <span class="badge" id="save-state">Saved</span>
    <span style="flex:1"></span>
    ${project.type === 'design' ? '<button class="btn btn-primary" id="open-editor-btn">🎨 Open in Graphic Editor</button>' : ''}
    ${project.type === 'video' ? '<button class="btn btn-primary" id="open-video-btn">🎬 Open in Video Editor</button>' : ''}
    <button class="btn" id="save-version-btn">💾 Save version</button>
    <button class="btn" id="dup-btn">Duplicate</button>
    <button class="btn btn-danger" id="trash-btn">Move to trash</button>
  </div>
  <div class="grid grid-2">
    <div class="card">
      <h3>Project details</h3>
      <label for="p-name">Name</label>
      <input id="p-name" value="${esc(project.name)}">
      <label for="p-type">Type</label>
      <select id="p-type">${['design', 'video', 'bulk', 'shorts', 'social'].map((t) => `<option ${project.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <p class="sub" style="margin-top:14px">${project.type === 'design'
        ? 'This design opens in the Graphic Editor — layers, text, shapes, images, brand colours and PNG/JPG export. The JSON below is the exact design the editor saves and restores.'
        : project.type === 'video'
        ? 'This video opens in the Video Editor — multi-track timeline, trimming, transitions, keyframes and FFmpeg rendering. The JSON below is the exact timeline the editor saves and restores.'
        : 'The full timeline editor arrives in Phase 3 (video). In the meantime the project content below is stored as real JSON, autosaved, versioned and restored exactly.'}</p>
      <div class="kv"><span>Created</span><span>${fmtDate(project.createdAt)}</span></div>
      <div class="kv"><span>Last updated</span><span>${fmtDate(project.updatedAt)}</span></div>
    </div>
    <div class="card">
      <h3>Version history (${versions.length})</h3>
      ${versions.length ? versions.map((v) => `
        <div class="kv"><span>${esc(v.note)} · ${fmtDate(v.createdAt)}</span><button class="btn btn-sm" data-restore-ver="${v.id}">Restore</button></div>`).join('')
      : '<p class="sub">No versions yet — edit the content and it will autosave a version.</p>'}
    </div>
  </div>
  <div class="card" style="margin-top:16px">
    <h3>Project content (JSON)</h3>
    <p class="sub">Edit freely — changes autosave after 1 second. Invalid JSON is rejected with an error, never silently saved.</p>
    <textarea id="p-content" class="code" spellcheck="false">${esc(JSON.stringify(project.content, null, 2))}</textarea>
    <div class="error" id="content-error"></div>
  </div>`;
  const saveState = document.getElementById('save-state');
  const setState = (t, cls) => { saveState.textContent = t; saveState.className = 'badge ' + (cls || ''); };
  let timer = null;
  const doSave = async (saveVersion) => {
    const raw = document.getElementById('p-content').value;
    let content;
    try { content = JSON.parse(raw); } catch { setState('Invalid JSON — not saved', 'err'); document.getElementById('content-error').style.display = 'block'; document.getElementById('content-error').textContent = 'Invalid JSON — fix the content before it can be saved.'; return; }
    document.getElementById('content-error').style.display = 'none';
    setState('Saving…', 'warn');
    try {
      await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ content, saveVersion: !!saveVersion }) });
      setState('Saved ✓', 'ok');
    } catch (e) { setState('Save failed', 'err'); toast(e.message, true); }
  };
  document.getElementById('p-content').addEventListener('input', () => {
    setState('Unsaved changes…', 'warn');
    clearTimeout(timer); timer = setTimeout(() => doSave(false), 1000);
  });
  document.getElementById('p-name').addEventListener('change', async (e) => {
    try { await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name: e.target.value }) }); toast('Name saved.'); }
    catch (err) { toast(err.message, true); }
  });
  document.getElementById('p-type').addEventListener('change', async (e) => {
    try { await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ type: e.target.value }) }); toast('Type saved.'); renderView(); }
    catch (err) { toast(err.message, true); }
  });
  document.getElementById('save-version-btn').addEventListener('click', async () => { await doSave(true); renderView(); });
  document.getElementById('dup-btn').addEventListener('click', async () => {
    try { const r = await api(`/api/projects/${id}/duplicate`, { method: 'POST' }); toast('Duplicated.'); go('project', { id: r.project.id }); }
    catch (e) { toast(e.message, true); }
  });
  document.getElementById('trash-btn').addEventListener('click', async () => {
    try { await api(`/api/projects/${id}/trash`, { method: 'POST' }); toast('Moved to trash.'); go('projects'); }
    catch (e) { toast(e.message, true); }
  });
  document.getElementById('back-projects').addEventListener('click', () => go('projects'));
  const openEd = document.getElementById('open-editor-btn');
  if (openEd) openEd.addEventListener('click', () => go('design-editor', { projectId: id }));
  const openVid = document.getElementById('open-video-btn');
  if (openVid) openVid.addEventListener('click', () => go('video-timeline', { projectId: id }));
  c.querySelectorAll('[data-restore-ver]').forEach((el) => el.addEventListener('click', async () => {
    try { await api(`/api/projects/${id}/versions/${el.dataset.restoreVer}/restore`, { method: 'POST' }); toast('Version restored.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
}

/* ---------- Media Library ---------- */
async function viewMedia(c) {
  const q = state.params.q || '';
  const kind = state.params.kind || '';
  const fav = state.params.fav === true;
  const [res, folders] = await Promise.all([
    api(`/api/media?search=${encodeURIComponent(q)}&kind=${kind}${fav ? '&favorite=1' : ''}`),
    api('/api/media/folders/list'),
  ]);
  c.innerHTML = `
  <div class="toolbar">
    <button class="btn btn-primary" id="upload-btn">⬆ Upload files</button>
    <button class="btn" id="media-folder-btn">＋ Folder</button>
    <input id="media-search" type="search" placeholder="Search by name or tag…" value="${esc(q)}">
    <select id="media-kind">
      <option value="">All types</option>
      ${['image', 'video', 'audio'].map((k) => `<option value="${k}" ${kind === k ? 'selected' : ''}>${k}</option>`).join('')}
    </select>
    <button class="btn ${fav ? 'btn-primary' : ''}" id="fav-toggle">★ Favorites</button>
    <input type="file" id="media-file" multiple accept="image/*,video/*,audio/*" style="display:none">
  </div>
  <p class="sub">Images, video and audio up to the configured limit. Files are stored on disk under <span class="mono">uploads/</span> with metadata in the database. Unsupported types are rejected.</p>
  <div id="upload-progress" style="margin-top:12px"></div>
  ${res.media.length ? `<div class="media-grid" style="margin-top:14px">${res.media.map((m) => `
    <div class="media-card">
      <div class="thumb" data-preview="${m.id}" style="cursor:pointer">
        ${m.kind === 'image' ? `<img src="${m.url}" alt="${esc(m.originalName)}" loading="lazy">`
          : m.kind === 'video' ? `<video src="${m.url}" preload="metadata" muted></video>`
          : `<span class="file-ico">🎵</span>`}
      </div>
      <div class="body">
        <div class="nm" title="${esc(m.originalName)}">${esc(m.originalName)}</div>
        <div class="mt">${esc(m.kind)} · ${fmtBytes(m.sizeBytes)} · ${fmtDate(m.createdAt)}</div>
        ${m.tags ? `<div class="mt">🏷 ${esc(m.tags)}</div>` : ''}
        <div class="acts">
          <button class="btn btn-sm" data-preview="${m.id}">Preview</button>
          <button class="btn btn-sm" data-fav="${m.id}">${m.favorite ? '★ Unfavorite' : '☆ Favorite'}</button>
          <button class="btn btn-sm" data-tag="${m.id}">Tags</button>
          <button class="btn btn-sm btn-danger" data-del-media="${m.id}">Delete</button>
        </div>
      </div>
    </div>`).join('')}</div>`
  : `<div class="empty" style="margin-top:14px"><div class="big">🗂️</div><p>No media found.</p><p style="margin-top:6px">Upload images, videos or audio to build your library.</p><button class="btn btn-primary" id="media-empty-upload">⬆ Upload your first files</button></div>`}
  ${folders.folders.length ? `<div class="card" style="margin-top:16px"><h3>Folders</h3>${folders.folders.map((f) => `<div class="kv"><span>📁 ${esc(f.name)}</span><button class="btn btn-sm btn-ghost" data-del-mfolder="${f.id}">Delete</button></div>`).join('')}</div>` : ''}`;
  const fileInput = document.getElementById('media-file');
  document.getElementById('upload-btn').addEventListener('click', () => fileInput.click());
  const emptyUpload = document.getElementById('media-empty-upload');
  if (emptyUpload) emptyUpload.addEventListener('click', () => fileInput.click());
  document.getElementById('media-folder-btn').addEventListener('click', () => openFolderModal('media'));
  document.getElementById('fav-toggle').addEventListener('click', () => go('media', { ...state.params, fav: !fav }));
  document.getElementById('media-kind').addEventListener('change', (e) => go('media', { ...state.params, kind: e.target.value }));
  document.getElementById('media-search').addEventListener('input', (e) => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => go('media', { ...state.params, q: e.target.value.trim() }), 300);
  });
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    if (!files.length) return;
    const prog = document.getElementById('upload-progress');
    let ok = 0, failed = 0;
    for (const f of files) {
      prog.innerHTML = `<div class="card"><p class="sub">Uploading ${esc(f.name)}… (${ok + failed + 1}/${files.length})</p></div>`;
      const fd = new FormData();
      fd.append('file', f);
      try { await apiForm('/api/media/upload', fd); ok++; }
      catch (e) { failed++; toast(`${f.name}: ${e.message}`, true); }
    }
    prog.innerHTML = '';
    toast(failed ? `Uploaded ${ok} file(s), ${failed} failed.` : `Uploaded ${ok} file(s).`, failed > 0);
    renderView();
  });
  c.querySelectorAll('[data-preview]').forEach((el) => el.addEventListener('click', () => {
    const m = res.media.find((x) => String(x.id) === el.dataset.preview);
    if (m) openMediaPreview(m);
  }));
  c.querySelectorAll('[data-fav]').forEach((el) => el.addEventListener('click', async () => {
    const m = res.media.find((x) => String(x.id) === el.dataset.fav);
    try { await api(`/api/media/${m.id}`, { method: 'PATCH', body: JSON.stringify({ favorite: !m.favorite }) }); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-tag]').forEach((el) => el.addEventListener('click', () => {
    const m = res.media.find((x) => String(x.id) === el.dataset.tag);
    openTagModal(m);
  }));
  c.querySelectorAll('[data-del-media]').forEach((el) => el.addEventListener('click', async () => {
    if (!confirm('Delete this file permanently?')) return;
    try { await api(`/api/media/${el.dataset.delMedia}`, { method: 'DELETE' }); toast('Media deleted.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-del-mfolder]').forEach((el) => el.addEventListener('click', async () => {
    try { await api(`/api/media/folders/${el.dataset.delMfolder}`, { method: 'DELETE' }); toast('Folder deleted.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
}

/* ---------- Settings ---------- */
async function viewSettings(c) {
  const [prov, users, googleStatus, updStatus, updSettings] = await Promise.all([
    api('/api/providers'),
    state.user.role === 'OWNER' || state.user.role === 'ADMIN' ? api('/api/users').catch(() => ({ users: [] })) : Promise.resolve({ users: null }),
    api('/api/integrations/google/status').catch(() => null),
    api('/api/updates/status').catch(() => null),
    state.user.role === 'OWNER' || state.user.role === 'ADMIN' ? api('/api/updates/settings').catch(() => null) : Promise.resolve(null),
  ]);
  const d = await api('/api/dashboard');
  const isAdmin = state.user.role === 'OWNER' || state.user.role === 'ADMIN';
  c.innerHTML = `
  <div class="grid grid-2">
    <div class="card"><h3>Profile</h3>
      <div class="error" id="profile-error"></div><div class="success" id="profile-ok"></div>
      <label for="s-name">Display name</label>
      <input id="s-name" value="${esc(state.user.name)}">
      <label>Email</label>
      <input value="${esc(state.user.email)}" disabled>
      <div style="margin-top:14px"><button class="btn btn-primary" id="save-profile">Save profile</button></div>
      <h3 style="margin-top:24px">Change password</h3>
      <div class="error" id="pw-error"></div><div class="success" id="pw-ok"></div>
      <label for="pw-cur">Current password</label><input id="pw-cur" type="password">
      <label for="pw-new">New password (min 8 characters)</label><input id="pw-new" type="password">
      <div style="margin-top:14px"><button class="btn" id="save-pw">Change password</button></div>
    </div>
    <div class="card"><h3>Storage & limits</h3>
      <div class="kv"><span>Plan</span><span>${esc(d.plan)}</span></div>
      <div class="kv"><span>Storage used</span><span>${esc(d.storage.usedLabel)} of ${esc(d.storage.limitLabel)}</span></div>
      <div class="kv"><span>Projects</span><span>${d.counts.projects} of ${d.planLimits.maxProjects ?? 'unlimited'}</span></div>
      <div class="kv"><span>Max upload size</span><span>${d.system.maxUploadMB} MB</span></div>
      <div class="kv"><span>AI credits</span><span>${(d.plan === 'Lifetime' || d.plan === 'Enterprise') ? 'Unlimited' : d.creditsBalance}</span></div>
      <p class="sub" style="margin-top:12px">Phase 8: storage limits are enforced per plan (see Subscription &amp; Credits).</p>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h3>AI Providers</h3>
    <p class="sub">Provider keys are stored encrypted (AES-256-GCM) and are never shown in full. Phase 7: live AI calls are enabled as soon as a key is configured — Test connection makes a minimal real call (list models / balance / account) and reports the provider's actual answer. Base URL and model can be changed to point a provider at a compatible endpoint.</p>
    <div style="margin-top:12px">${prov.providers.map((p) => `
      <div class="kv" style="align-items:flex-start"><span><b>${esc(p.label)}</b> <small style="color:var(--muted)">(${esc(p.kind)}${p.active ? ' · active' : ''})</small><br><small style="color:var(--muted)">${esc(p.note)}</small><br>
        <small style="color:var(--muted2)">Base URL: ${esc(p.baseUrl || p.defaultBaseUrl)} · Model: ${esc(p.model)}</small><br>
        <label style="margin-top:6px">Base URL</label><input data-cfg-base="${p.id}" value="${esc(p.baseUrl || '')}" placeholder="${esc(p.defaultBaseUrl)}" style="width:100%">
        <label>Model</label><input data-cfg-model="${p.id}" value="${esc(p.model || '')}" style="width:100%">
        <small style="color:var(--muted2)">Models: ${esc((p.models || []).join(', '))}</small>
      </span>
      <span style="text-align:right;min-width:190px">
        <span class="badge ${p.configured ? 'ok' : 'warn'}">${p.configured ? '● Configured · ' + esc(p.source) : '○ Key needed'}</span><br>
        <small style="color:var(--muted2)">Live in Phase ${p.phase}</small><br>
        <button class="btn btn-sm" data-set-key="${p.id}">${p.configured ? 'Replace key' : 'Add key'}</button>
        <button class="btn btn-sm" data-test-prov="${p.id}">Test connection</button>
        <button class="btn btn-sm" data-save-cfg="${p.id}">Save config</button>
        ${p.configured ? `<button class="btn btn-sm btn-danger" data-del-key="${p.id}">Remove</button>` : ''}
        <div class="sub" id="prov-test-${p.id}" style="margin-top:6px"></div>
      </span></div>`).join('')}</div>
    <p class="sub" style="margin-top:12px">Active provider per kind (used when a kind has several providers):</p>
    <div>${['image', 'tts'].map((kind) => {
      const list = prov.providers.filter((p) => p.kind === kind);
      if (list.length < 2) return '';
      const active = list.find((p) => p.active) || list[0];
      return `<div class="kv"><span><b>${esc(kind)}</b> — active provider</span><span><select data-active-kind="${kind}">${list.map((p) => `<option value="${p.id}" ${p.id === active.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></span></div>`;
    }).join('')}</div>
  </div>
  ${googleStatus ? `<div class="card" style="margin-top:16px"><h3>Google Sheets (bulk import)</h3>
    <p class="sub">Import rows straight from a Google Sheet into a Bulk Video / Bulk Design job. Read-only scopes — the app never modifies your sheets. ${googleStatus.configured ? '' : 'First, an OWNER/ADMIN adds the Google OAuth Client ID + Secret (from Google Cloud Console → APIs & Services → Credentials → OAuth client ID, Web application).'}</p>
    <div class="kv"><span>OAuth configured</span><span>${googleStatus.configured ? '<span class="badge ok">● Yes</span>' : '<span class="badge warn">○ No</span>'}</span></div>
    <div class="kv"><span>Connected as</span><span>${googleStatus.connected ? esc(googleStatus.accountName) : 'Not connected'}</span></div>
    ${googleStatus.clientId ? `<div class="kv"><span>Client ID</span><span>${esc(googleStatus.clientId.slice(0, 24))}…</span></div>` : ''}
    ${isAdmin ? `
    <div class="form-row" style="margin-top:10px">
      <label style="flex:2">Google Client ID <input id="g-client" value="${esc(googleStatus.clientId || '')}" placeholder="…apps.googleusercontent.com"></label>
      <label style="flex:2">Client secret <input id="g-secret" type="password" autocomplete="off" placeholder="Leave empty to keep the saved secret"></label>
    </div>
    <label>Redirect URI (optional — must match the one in Google Cloud Console) <input id="g-redirect" value="${esc(googleStatus.redirectUri || '')}" placeholder="http://localhost:4820/api/integrations/google/callback"></label>
    <div class="form-row" style="margin-top:10px"><button class="btn" id="g-save">Save Google OAuth config</button></div>` : ''}
    <div class="form-row" style="margin-top:10px">
      <button class="btn btn-primary" id="g-connect" ${googleStatus.configured ? '' : 'disabled'}>Connect Google</button>
      ${googleStatus.connected ? '<button class="btn btn-danger" id="g-disconnect">Disconnect Google</button>' : ''}
    </div>
    <div class="error" id="g-err"></div><div class="success" id="g-ok"></div>
  </div>` : ''}
  ${updStatus ? `<div class="card" style="margin-top:16px"><h3>Updates (auto-update)</h3>
    <p class="sub">New versions arrive in the app itself — no delete/reinstall. The app checks the update feed on start and every 6 hours. When an update is available you get a banner on the Dashboard; with auto-apply OFF (recommended) nothing installs until you click Update now. Every file is SHA-256 verified and the previous version is backed up first — Rollback restores it.</p>
    <div class="kv"><span>Current version</span><span class="mono">${esc(updStatus.current)}</span></div>
    <div class="kv"><span>Latest on feed</span><span>${updStatus.available ? `<span class="badge warn">● ${esc(updStatus.latest)} available</span>` : (updStatus.feedReachable === false ? '<span class="badge err">● Feed not reachable</span>' : `<span class="badge ok">● Up to date (${esc(updStatus.latest)})</span>`)}</span></div>
    <div class="kv"><span>Feed</span><span class="mono" style="word-break:break-all">${esc(updStatus.feed.url)}</span></div>
    <div class="kv"><span>Last check</span><span>${updStatus.lastCheck ? fmtDate(updStatus.lastCheck) : 'Never checked'}${updStatus.lastCheckError ? ` — <span style="color:var(--danger)">${esc(updStatus.lastCheckError)}</span>` : ''}</span></div>
    ${updStatus.available ? `<div class="kv"><span>Release notes</span><span>${esc(updStatus.available.notes || '—')}</span></div>` : ''}
    ${updStatus.lastApplied ? `<div class="kv"><span>Last applied update</span><span>v${esc(updStatus.lastApplied.version)} · ${fmtDate(updStatus.lastApplied.at)}</span></div>` : ''}
    ${updStatus.pendingRestart ? '<p class="sub" style="margin-top:8px;color:var(--warning)">⚠ An update was applied — restart the server (close Start.bat / npm start again) to finish it.</p>' : ''}
    ${updStatus.staged ? `<div class="kv"><span>Staged update</span><span>v${esc(updStatus.staged.version)} · ${updStatus.staged.files.length} files</span></div>` : ''}
    <div class="kv"><span>Backups kept</span><span>${updStatus.backups}</span></div>
    ${updStatus.available && updStatus.available.fullReinstall ? '<p class="sub" style="margin-top:8px;color:var(--warning)">⚠ This update changes dependencies and needs a fresh download — it will NOT be applied in place. Download the new portable/source package from Drive instead.</p>' : ''}
    ${isAdmin && updSettings ? `
    <div class="form-row" style="margin-top:10px">
      <label style="flex:1">Feed type <select id="u-feed-type"><option value="url" ${updSettings.feedType === 'url' ? 'selected' : ''}>URL feed</option><option value="folder" ${updSettings.feedType === 'folder' ? 'selected' : ''}>Local folder</option></select></label>
      <label style="flex:3">Feed URL or folder <input id="u-feed-url" value="${esc(updSettings.feedUrl)}"></label>
    </div>
    <div class="form-row" style="margin-top:10px">
      <label><input type="checkbox" id="u-auto-check" ${updSettings.autoCheck ? 'checked' : ''}> Auto-check (on start + every 6 h)</label>
      <label><input type="checkbox" id="u-auto-apply" ${updSettings.autoApply ? 'checked' : ''}> Auto-apply updates without asking</label>
    </div>
    <p class="sub">⚠ Auto-apply ON means a new version installs itself as soon as the feed publishes it — the app restarts on its own. Keep it OFF unless you want that.</p>
    <div class="error" id="u-err"></div><div class="success" id="u-ok"></div>
    <div class="form-row" style="margin-top:10px">
      <button class="btn" id="u-save">Save update settings</button>
      <button class="btn" id="u-check">Check now</button>
      ${updStatus.available && !updStatus.available.fullReinstall ? '<button class="btn btn-primary" id="u-apply">Update now</button>' : ''}
      ${updStatus.backups ? '<button class="btn btn-danger" id="u-rollback">Roll back to previous version</button>' : ''}
    </div>` : `
    <div class="form-row" style="margin-top:10px">
      <button class="btn" id="u-check">Check now</button>
      ${updStatus.available && !updStatus.available.fullReinstall && isAdmin ? '<button class="btn btn-primary" id="u-apply">Update now</button>' : ''}
    </div>
    <p class="sub">Only OWNER/ADMIN can change update settings or apply updates.</p>`}
    ${updStatus.history && updStatus.history.length ? `<h3 style="margin-top:16px">Update history</h3>${updStatus.history.slice().reverse().map((h) => `<div class="kv"><span>${esc(h.action)} ${esc(h.from)} → ${esc(h.to)}</span><span>${fmtDate(h.at)}</span></div>`).join('')}` : ''}
  </div>` : ''}
  ${users.users ? `<div class="card" style="margin-top:16px"><h3>Users (admin)</h3>
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Plan</th><th>Credits</th><th></th></tr></thead><tbody>
    ${users.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(u.plan)}</td><td>${(u.plan === 'Lifetime' || u.plan === 'Enterprise') ? '∞' : u.credits_balance}</td>
    <td>${u.id !== state.user.id ? `<select data-role-for="${u.id}">
      ${['USER', 'ADMIN', 'OWNER'].map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>` : '<span class="badge">you</span>'}</td></tr>`).join('')}
    </tbody></table></div>` : ''}`;
  document.getElementById('save-profile').addEventListener('click', async () => {
    const errBox = document.getElementById('profile-error'); const okBox = document.getElementById('profile-ok');
    errBox.style.display = 'none'; okBox.style.display = 'none';
    try {
      const r = await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ name: document.getElementById('s-name').value }) });
      state.user = r.user; okBox.textContent = 'Profile saved.'; okBox.style.display = 'block'; render();
    } catch (e) { errBox.textContent = e.message; errBox.style.display = 'block'; }
  });
  document.getElementById('save-pw').addEventListener('click', async () => {
    const errBox = document.getElementById('pw-error'); const okBox = document.getElementById('pw-ok');
    errBox.style.display = 'none'; okBox.style.display = 'none';
    try {
      await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: document.getElementById('pw-cur').value, newPassword: document.getElementById('pw-new').value }) });
      okBox.textContent = 'Password changed.'; okBox.style.display = 'block';
      document.getElementById('pw-cur').value = ''; document.getElementById('pw-new').value = '';
    } catch (e) { errBox.textContent = e.message; errBox.style.display = 'block'; }
  });
  c.querySelectorAll('[data-set-key]').forEach((el) => el.addEventListener('click', () => openProviderKeyModal(el.dataset.setKey)));
  c.querySelectorAll('[data-save-cfg]').forEach((el) => el.addEventListener('click', async () => {
    const id = el.dataset.saveCfg;
    const baseEl = c.querySelector(`[data-cfg-base="${id}"]`);
    const modelEl = c.querySelector(`[data-cfg-model="${id}"]`);
    try {
      await api(`/api/providers/${id}/config`, { method: 'POST', body: JSON.stringify({ baseUrl: baseEl.value.trim(), model: modelEl.value.trim() }) });
      toast('Provider config saved.'); renderView();
    } catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-test-prov]').forEach((el) => el.addEventListener('click', async () => {
    const id = el.dataset.testProv;
    const box = document.getElementById(`prov-test-${id}`);
    box.textContent = 'Testing — making a real call…';
    try {
      const r = await api(`/api/providers/${id}/test`, { method: 'POST' });
      box.textContent = r.ok ? `✓ ${r.detail}` : `✗ ${r.error}`;
      box.style.color = r.ok ? 'var(--success)' : 'var(--danger)';
    } catch (e) { box.textContent = `✗ ${e.message}`; }
  }));
  c.querySelectorAll('[data-active-kind]').forEach((el) => el.addEventListener('change', async () => {
    try {
      await api('/api/providers/active', { method: 'POST', body: JSON.stringify({ kind: el.dataset.activeKind, provider: el.value }) });
      toast('Active provider updated.'); renderView();
    } catch (e) { toast(e.message, true); renderView(); }
  }));
  c.querySelectorAll('[data-del-key]').forEach((el) => el.addEventListener('click', async () => {
    if (!confirm('Remove this provider key? AI features using it will stop being configured.')) return;
    try { await api(`/api/providers/${el.dataset.delKey}/key`, { method: 'DELETE' }); toast('Provider key removed.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-role-for]').forEach((el) => el.addEventListener('change', async () => {
    try {
      await api(`/api/users/${el.dataset.roleFor}`, { method: 'PATCH', body: JSON.stringify({ role: el.value }) });
      toast('Role updated.'); renderView();
    } catch (e) { toast(e.message, true); renderView(); }
  }));
  const gSave = document.getElementById('g-save');
  if (gSave) gSave.addEventListener('click', async () => {
    const errBox = document.getElementById('g-err'); const okBox = document.getElementById('g-ok');
    errBox.style.display = 'none'; okBox.style.display = 'none';
    try {
      const secret = document.getElementById('g-secret').value.trim();
      await api('/api/integrations/google/config', { method: 'POST', body: JSON.stringify({
        clientId: document.getElementById('g-client').value.trim(),
        ...(secret ? { clientSecret: secret } : {}),
        redirectUri: document.getElementById('g-redirect').value.trim(),
      }) });
      okBox.textContent = 'Google OAuth config saved (secret encrypted). Now click Connect Google.'; okBox.style.display = 'block'; renderView();
    } catch (e) { errBox.textContent = e.message; errBox.style.display = 'block'; }
  });
  const gConnect = document.getElementById('g-connect');
  if (gConnect) gConnect.addEventListener('click', async () => {
    try {
      const r = await api('/api/integrations/google/auth-url');
      window.open(r.url, '_blank');
      toast('Authorise on Google, then come back — your sheets will be listed in Bulk Video → Data → Google Sheets.');
    } catch (e) { toast(e.message, true); }
  });
  const gDisconnect = document.getElementById('g-disconnect');
  if (gDisconnect) gDisconnect.addEventListener('click', async () => {
    if (!confirm('Disconnect Google? Bulk import from Sheets will stop working until you reconnect.')) return;
    try { await api('/api/integrations/google/connection', { method: 'DELETE' }); toast('Google disconnected.'); renderView(); }
    catch (e) { toast(e.message, true); }
  });
  const uSave = document.getElementById('u-save');
  if (uSave) uSave.addEventListener('click', async () => {
    const errBox = document.getElementById('u-err'); const okBox = document.getElementById('u-ok');
    errBox.style.display = 'none'; okBox.style.display = 'none';
    try {
      await api('/api/updates/settings', { method: 'POST', body: JSON.stringify({
        feedType: document.getElementById('u-feed-type').value,
        feedUrl: document.getElementById('u-feed-url').value.trim(),
        autoCheck: document.getElementById('u-auto-check').checked,
        autoApply: document.getElementById('u-auto-apply').checked,
      }) });
      okBox.textContent = 'Update settings saved.'; okBox.style.display = 'block'; renderView();
    } catch (e) { errBox.textContent = e.message; errBox.style.display = 'block'; }
  });
  const uCheck = document.getElementById('u-check');
  if (uCheck) uCheck.addEventListener('click', async () => {
    uCheck.textContent = 'Checking…'; uCheck.disabled = true;
    try {
      const r = await api('/api/updates/check', { method: 'POST' });
      toast(r.available ? `Update ${r.latest} is available.` : 'You are up to date.');
    } catch (e) { toast(e.message, true); }
    renderView();
  });
  const uApply = document.getElementById('u-apply');
  if (uApply) uApply.addEventListener('click', async () => {
    if (!confirm('Apply the available update now? The current version is backed up first; the app will restart on Windows.')) return;
    uApply.textContent = 'Updating…'; uApply.disabled = true;
    try {
      const r = await api('/api/updates/apply', { method: 'POST' });
      toast(r.message || `Updated to ${r.to}.`);
      if (r.restarting) toast('The app is restarting to apply the update — it will reopen on its own.');
      setTimeout(() => { window.location.reload(); }, 3000);
    } catch (e) { toast(e.message, true); renderView(); }
  });
  const uRollback = document.getElementById('u-rollback');
  if (uRollback) uRollback.addEventListener('click', async () => {
    if (!confirm('Roll back to the previous version? The current version will be replaced by its backup.')) return;
    try {
      const r = await api('/api/updates/rollback', { method: 'POST' });
      toast(r.message || `Rolled back to ${r.restored}.`);
      setTimeout(() => { window.location.reload(); }, 2000);
    } catch (e) { toast(e.message, true); }
  });
}

/* ---------- Subscription ---------- */
async function viewSubscription(c) {
  const [s, billing, myRequests] = await Promise.all([
    api('/api/subscription'),
    api('/api/billing/balance').catch(() => null),
    api('/api/billing/requests').catch(() => ({ requests: [] })),
  ]);
  const cur = s.plans.find((p) => p.name === s.currentPlan);
  const pending = myRequests.requests.filter((r) => r.status === 'pending');
  c.innerHTML = `
  <div class="card"><h3>Current plan: ${esc(s.currentPlan)}</h3>
    <p class="sub">Credit balance: <b style="color:var(--cyan)">${(s.currentPlan === 'Lifetime' || s.currentPlan === 'Enterprise') ? 'Unlimited' : s.creditsBalance + ' credits'}</b>${(s.currentPlan === 'Lifetime' || s.currentPlan === 'Enterprise') ? ' — everything unlimited, no ledger deduction.' : '. Every AI generation, render and bulk row deducts credits transparently — each charge appears in the usage log below with the exact cost.'}</p>
    <p class="sub" style="margin-top:8px"><b>No payment is taken in this build.</b> To change plan, request it below — the OWNER approves it in Admin and the plan changes then. No card, no checkout.</p>
    ${pending.length ? `<p class="sub" style="margin-top:8px">⏳ Pending request: <b>${esc(pending.map((r) => r.plan).join(', '))}</b> — waiting for OWNER approval.</p>` : ''}
  </div>
  <div class="grid grid-3" style="margin-top:16px">
    ${s.plans.map((p) => `
    <div class="card" style="${p.name === s.currentPlan ? 'border-color:var(--accent)' : ''}">
      <h3>${esc(p.name)} ${p.name === s.currentPlan ? '<span class="badge ok">Current</span>' : ''}</h3>
      <div style="font-size:24px;font-weight:800;margin:6px 0">${p.name === 'Lifetime' ? 'Free forever' : p.price === null ? 'Custom' : p.price === 0 ? 'Free' : '$' + p.price + '/mo'}</div>
      <ul style="list-style:none;color:var(--muted);font-size:13px;line-height:1.9">
        ${p.features.map((f) => `<li>✓ ${esc(f)}</li>`).join('')}
      </ul>
      ${p.name !== s.currentPlan ? (p.name === 'Lifetime' ? '<p class="sub" style="margin-top:12px">OWNER only — the OWNER account is lifetime-free.</p>' : `<button class="btn" style="margin-top:12px" data-plan="${p.name}">Request ${esc(p.name)}</button>`) : ''}
    </div>`).join('')}
  </div>
  ${billing ? `<div class="card" style="margin-top:16px"><h3>Credit costs</h3>
    <p class="sub">What each action costs. A charge only happens when the action succeeds — failed or refused actions cost nothing.</p>
    <table><thead><tr><th>Action</th><th>Credits</th></tr></thead><tbody>
    ${Object.entries(billing.costs).map(([a, n]) => `<tr><td>${esc(a)}</td><td>${n}</td></tr>`).join('')}</tbody></table>
  </div>` : ''}
  ${myRequests.requests.length ? `<div class="card" style="margin-top:16px"><h3>My plan requests</h3>
    <table><thead><tr><th>Plan</th><th>Status</th><th>Requested</th><th>Decided</th></tr></thead><tbody>
    ${myRequests.requests.map((r) => `<tr><td>${esc(r.plan)}</td><td>${esc(r.status)}</td><td>${fmtDate(r.createdAt)}</td><td>${r.decidedAt ? fmtDate(r.decidedAt) : '—'}</td></tr>`).join('')}</tbody></table>
  </div>` : ''}
  <div class="card" style="margin-top:16px"><h3>Credit usage log</h3>
    ${s.usage.length ? `<table><thead><tr><th>When</th><th>Action</th><th>Credits</th><th>Detail</th></tr></thead><tbody>
      ${s.usage.map((u) => `<tr><td>${fmtDate(u.created_at)}</td><td>${esc(u.action)}</td><td>${u.credits}</td><td>${esc(u.detail || '')}</td></tr>`).join('')}</tbody></table>`
    : '<p class="sub" style="margin-top:8px">No credit usage yet. AI actions, renders and bulk rows will be logged here with the exact credit cost.</p>'}
  </div>`;
  c.querySelectorAll('[data-plan]').forEach((el) => el.addEventListener('click', async () => {
    try {
      await api('/api/billing/requests', { method: 'POST', body: JSON.stringify({ plan: el.dataset.plan }) });
      toast(`Plan request sent for ${el.dataset.plan} — the OWNER approves it in Admin. No payment taken.`); render();
    } catch (e) { toast(e.message, true); }
  }));
}

/* ---------- Graphic Editor (Phase 2) ---------- */
async function viewGraphicEditor(c) {
  const [sizes, templates, mine] = await Promise.all([
    api('/api/design/sizes').catch(() => ({ sizes: [] })),
    api('/api/design/templates').catch(() => ({ templates: [] })),
    api('/api/projects?search=').catch(() => ({ projects: [] })),
  ]);
  const designs = mine.projects.filter((p) => p.type === 'design');
  c.innerHTML = `
  <div class="card"><h3>New design</h3>
    <p class="sub">Pick a size to start a blank design, or open a starter template — templates load as real editable layers, never a flattened image.</p>
    <div class="grid grid-3" style="margin-top:14px">
      ${sizes.sizes.map((s) => `
        <button class="btn" style="justify-content:space-between" data-size="${s.id}">
          <span>${esc(s.name)}</span><span class="badge">${s.width}×${s.height}</span>
        </button>`).join('')}
    </div>
    <div class="ed-row" style="margin-top:14px">
      <div class="ed-field" style="flex:2"><label>Custom size — width (px)</label><input type="number" id="ge-cw" value="1080" min="10" max="8000"></div>
      <div class="ed-field" style="flex:2"><label>Custom size — height (px)</label><input type="number" id="ge-ch" value="1080" min="10" max="8000"></div>
      <div class="ed-field" style="flex:1"><label>&nbsp;</label><button class="btn btn-primary" id="ge-custom" style="width:100%">Create custom</button></div>
    </div>
  </div>
  <div class="grid grid-2" style="margin-top:16px">
    <div class="card"><h3>Starter templates</h3>
      ${templates.templates.map((t) => `
        <div class="list-row">
          <div class="grow" style="cursor:pointer" data-template="${esc(t.id)}">
            <div class="t">${esc(t.name)}</div>
            <div class="m">${esc(t.category)} · ${t.width}×${t.height}${t.builtin ? '' : ' · yours'}</div>
          </div>
          <button class="btn btn-sm btn-primary" data-template="${esc(t.id)}">Use template →</button>
        </div>`).join('') || '<p class="sub">No templates available.</p>'}
    </div>
    <div class="card"><h3>Your designs</h3>
      ${designs.length ? designs.map((p) => `
        <div class="list-row">
          <div class="grow" style="cursor:pointer" data-open-design="${p.id}">
            <div class="t">${esc(p.name)}</div>
            <div class="m">updated ${fmtDate(p.updatedAt)}</div>
          </div>
          <button class="btn btn-sm btn-primary" data-open-design="${p.id}">Open →</button>
        </div>`).join('') : '<p class="sub" style="margin-top:8px">No designs yet. Create one above.</p>'}
    </div>
  </div>`;
  const createFrom = async (width, height, templateId) => {
    const name = prompt('Design name', templateId ? 'Untitled design' : 'Untitled design');
    if (!name || !name.trim()) return;
    try {
      let content = { version: 1, width, height, background: { type: 'color', color: '#151d3a', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } }, layers: [] };
      if (templateId) {
        const t = await api(`/api/design/templates/${encodeURIComponent(templateId)}`);
        content = t.template.design;
      }
      const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: name.trim(), type: 'design', content }) });
      go('design-editor', { projectId: r.project.id });
    } catch (e) { toast(e.message, true); }
  };
  c.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
    const s = sizes.sizes.find((x) => x.id === b.dataset.size);
    if (s) createFrom(s.width, s.height, null);
  }));
  document.getElementById('ge-custom').addEventListener('click', () => {
    const w = Math.max(10, Math.min(8000, parseInt(document.getElementById('ge-cw').value, 10) || 1080));
    const h = Math.max(10, Math.min(8000, parseInt(document.getElementById('ge-ch').value, 10) || 1080));
    createFrom(w, h, null);
  });
  c.querySelectorAll('[data-template]').forEach((b) => b.addEventListener('click', () => createFrom(0, 0, b.dataset.template)));
  c.querySelectorAll('[data-open-design]').forEach((b) => b.addEventListener('click', () => go('design-editor', { projectId: b.dataset.openDesign })));
}

async function viewDesignEditor(c) {
  const projectId = state.params.projectId;
  if (!projectId) { go('graphic-editor'); return; }
  let project;
  try {
    project = (await api(`/api/projects/${projectId}`)).project;
  } catch (e) {
    c.innerHTML = `<div class="card"><h3>Design not found</h3><p class="sub">${esc(e.message)}</p><br><button class="btn" id="de-back">← Back to Graphic Editor</button></div>`;
    document.getElementById('de-back').addEventListener('click', () => go('graphic-editor'));
    return;
  }
  c.style.maxWidth = 'none';
  c.style.padding = '16px';
  await window.DesignEditor.open(c, { project });
}

/* ---------- AI Design Studio (Phase 2: honest + local layout helper) ---------- */
async function viewAIDesign(c) {
  const prov = await api('/api/providers').catch(() => ({ providers: [] }));
  const llm = prov.providers.find((p) => p.id === 'llm');
  const img = prov.providers.find((p) => p.id === 'image');
  // Design Assist uses the LLM only (it picks headline, palette, fonts);
  // the image provider is needed for image generation, not for this.
  const aiReady = Boolean(llm && llm.configured);
  c.innerHTML = `
  <div class="grid grid-2">
    <div class="card"><h3>Describe your design</h3>
      <p class="sub">Example: “Create a professional restaurant advertisement with a premium food background.”</p>
      <div class="ed-field"><label>Design prompt</label>
      <textarea id="ai-prompt" rows="4" placeholder="e.g. Summer sale poster for a shoe store, bold and energetic"></textarea></div>
      <div class="ed-field"><label>Design name</label><input id="ai-name" value="AI Design"></div>
      <div class="ed-btnrow">
        <button class="btn btn-primary" id="ai-layout">✨ Generate layout (local helper)</button>
        <button class="btn" id="ai-generate" ${aiReady ? '' : 'disabled title="Needs an LLM provider key — add one in Settings → AI Providers."'}>Generate with AI ${aiReady ? '' : '(needs LLM key)'}</button>
      </div>
      <div class="error" id="ai-error"></div>
      <div class="success" id="ai-ok" style="display:none"></div>
    </div>
    <div class="card"><h3>How this works — honestly</h3>
      <div class="kv"><span>LLM provider</span><span class="badge ${llm && llm.configured ? 'ok' : 'warn'}">${llm && llm.configured ? '● Configured' : '○ Key needed'}</span></div>
      <div class="kv"><span>Image provider</span><span class="badge ${img && img.configured ? 'ok' : 'warn'}">${img && img.configured ? '● Configured' : '○ Key needed'}</span></div>
      <div class="ed-note"><b>Live AI generation is built (Phase 7)</b> — it needs a real provider key in Settings → AI Providers. The LLM picks the headline, palette, fonts and call-to-action, and the result is always a NEW editable design project — your existing designs are never changed. Nothing here fakes AI output.</div>
      <div class="ed-note"><b>Local layout helper</b> (the button on the left) is <i>not</i> AI: it is a rule-based helper that turns your prompt into an editable design — headline from your words, a gradient background, a subheading and a call-to-action — and opens it in the Graphic Editor, where every layer stays editable. It never returns a flattened image.</div>
      <div class="ed-btnrow"><button class="btn" id="ai-settings">Open Settings → AI Providers</button></div>
    </div>
  </div>`;
  document.getElementById('ai-settings').addEventListener('click', () => go('settings'));
  // Live AI Design Assist (Phase 7): LLM → new editable design project.
  document.getElementById('ai-generate').addEventListener('click', async () => {
    const prompt = document.getElementById('ai-prompt').value.trim();
    const name = document.getElementById('ai-name').value.trim() || 'AI Design';
    const errBox = document.getElementById('ai-error');
    const okBox = document.getElementById('ai-ok');
    errBox.style.display = 'none'; okBox.style.display = 'none';
    if (!prompt) { errBox.textContent = 'Write a short prompt first — e.g. “Summer sale poster for a shoe store”.'; errBox.style.display = 'block'; return; }
    try {
      const { job } = await api('/api/ai/jobs', { method: 'POST', body: JSON.stringify({ mode: 'design', name, prompt }) });
      okBox.textContent = 'AI is designing… this usually takes a few seconds.';
      okBox.style.display = 'block';
      const finalJob = await AIStudio.pollJob(job.id);
      if (finalJob.status === 'done' && finalJob.result && finalJob.result.projectId) {
        toast('AI design created — opening it in the Graphic Editor (fully editable).');
        go('design-editor', { projectId: finalJob.result.projectId });
      } else {
        errBox.textContent = finalJob.error || 'AI design failed.'; errBox.style.display = 'block'; okBox.style.display = 'none';
      }
    } catch (e) {
      errBox.textContent = e.message; errBox.style.display = 'block'; okBox.style.display = 'none';
    }
  });
  document.getElementById('ai-layout').addEventListener('click', async () => {
    const prompt = document.getElementById('ai-prompt').value.trim();
    const name = document.getElementById('ai-name').value.trim() || 'AI Design';
    const errBox = document.getElementById('ai-error');
    errBox.style.display = 'none';
    if (!prompt) { errBox.textContent = 'Write a short prompt first — e.g. “Summer sale poster for a shoe store”.'; errBox.style.display = 'block'; return; }
    // Rule-based layout helper (NOT AI): headline = prompt words, capped.
    const words = prompt.replace(/[“”"'.!?]/g, '').split(/\s+/).filter(Boolean);
    const headline = words.slice(0, 4).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    const sub = words.slice(4, 12).join(' ') || 'Made with CreativeStudio AI Pro';
    const content = {
      version: 1, width: 1080, height: 1080,
      background: { type: 'gradient', color: '#7c5cff', gradient: { from: '#7c5cff', to: '#22d3ee', angle: 135 } },
      layers: [
        { id: 'lh_badge', type: 'shape', name: 'Badge', x: 390, y: 110, w: 300, h: 60, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, shape: { kind: 'rect', fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 30, shadow: null } },
        { id: 'lh_badge_t', type: 'text', name: 'Badge text', x: 390, y: 120, w: 300, h: 44, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: 'NEW DESIGN', fontFamily: 'Poppins', fontSize: 28, fontWeight: 800, fontStyle: 'normal', underline: false, align: 'center', color: '#7c5cff', letterSpacing: 2, lineHeight: 1.2, shadow: null, stroke: null, gradient: null } },
        { id: 'lh_head', type: 'text', name: 'Headline', x: 90, y: 280, w: 900, h: 260, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: headline, fontFamily: 'Poppins', fontSize: 110, fontWeight: 800, fontStyle: 'normal', underline: false, align: 'center', color: '#ffffff', letterSpacing: 0, lineHeight: 1.05, shadow: { color: '#000000', blur: 10, offsetX: 0, offsetY: 4 }, stroke: null, gradient: null } },
        { id: 'lh_sub', type: 'text', name: 'Subheading', x: 140, y: 580, w: 800, h: 90, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: sub, fontFamily: 'Inter', fontSize: 36, fontWeight: 400, fontStyle: 'normal', underline: false, align: 'center', color: '#e8ecf8', letterSpacing: 0, lineHeight: 1.3, shadow: null, stroke: null, gradient: null } },
        { id: 'lh_cta', type: 'shape', name: 'CTA button', x: 390, y: 720, w: 300, h: 88, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, shape: { kind: 'rect', fill: '#ffffff', stroke: '', strokeWidth: 0, radius: 44, shadow: null } },
        { id: 'lh_cta_t', type: 'text', name: 'CTA text', x: 390, y: 736, w: 300, h: 56, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, text: { text: 'LEARN MORE', fontFamily: 'Poppins', fontSize: 34, fontWeight: 800, fontStyle: 'normal', underline: false, align: 'center', color: '#3b82f6', letterSpacing: 0, lineHeight: 1.2, shadow: null, stroke: null, gradient: null } },
      ],
    };
    try {
      const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, type: 'design', content }) });
      toast('Layout created with the local helper — edit every layer in the Graphic Editor.');
      go('design-editor', { projectId: r.project.id });
    } catch (e) {
      errBox.textContent = e.message;
      errBox.style.display = 'block';
    }
  });
}

/* ---------- Brand Kit (Phase 2) ---------- */
async function viewBrandKit(c) {
  const [brands, media] = await Promise.all([
    api('/api/design/brands').catch(() => ({ brands: [] })),
    api('/api/media?kind=image').catch(() => ({ media: [] })),
  ]);
  const fonts = await api('/api/design/fonts').catch(() => ({ fonts: ['Poppins', 'Inter'] }));
  const list = brands.brands;
  c.innerHTML = `
  <div class="grid grid-2">
    <div class="card"><h3>${list.length ? 'Your brands' : 'No brands yet'}</h3>
      ${list.length ? list.map((b) => `
        <div class="ed-brand-card">
          <div class="t">${esc(b.name)}</div>
          <div class="ed-swatches" style="margin:8px 0">
            <span class="ed-swatch" style="background:${esc(b.primaryColor)}" title="Primary"></span>
            <span class="ed-swatch" style="background:${esc(b.secondaryColor)}" title="Secondary"></span>
            <span class="ed-swatch" style="background:${esc(b.accentColor)}" title="Accent"></span>
          </div>
          <div style="font-size:12px;color:var(--muted)">${esc(b.fontHeading)} / ${esc(b.fontBody)}${b.handles && Object.keys(b.handles).length ? ' · ' + Object.entries(b.handles).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ') : ''}</div>
          <div class="ed-btnrow">
            <button class="btn btn-sm" data-edit-brand="${b.id}">Edit</button>
            <button class="btn btn-sm btn-danger" data-del-brand="${b.id}">Delete</button>
          </div>
        </div>`).join('') : '<p class="sub" style="margin-top:8px">Create your first brand on the right — logo, colours, fonts and social handles. Brands appear in the Graphic Editor and can be applied to any design in one click.</p>'}
    </div>
    <div class="card"><h3 id="bk-form-title">New brand</h3>
      <div class="error" id="bk-error"></div>
      <div class="success" id="bk-ok"></div>
      <input type="hidden" id="bk-id" value="">
      <div class="ed-field"><label>Brand name</label><input id="bk-name" placeholder="e.g. Studio"></div>
      <div class="ed-field"><label>Logo (from your uploaded images)</label>
        <select id="bk-logo"><option value="">No logo</option>${media.media.map((m) => `<option value="${m.id}">${esc(m.originalName)}</option>`).join('')}</select>
      </div>
      <div class="ed-row">
        <div class="ed-field"><label>Primary colour</label><input type="color" id="bk-primary" value="#7c5cff"></div>
        <div class="ed-field"><label>Secondary colour</label><input type="color" id="bk-secondary" value="#3b82f6"></div>
        <div class="ed-field"><label>Accent colour</label><input type="color" id="bk-accent" value="#22d3ee"></div>
      </div>
      <div class="ed-row">
        <div class="ed-field"><label>Heading font</label><select id="bk-font-h">${fonts.fonts.map((f) => `<option>${esc(f)}</option>`).join('')}</select></div>
        <div class="ed-field"><label>Body font</label><select id="bk-font-b">${fonts.fonts.map((f) => `<option ${f === 'Inter' ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div>
      </div>
      <div class="ed-field"><label>Social handles (one per line, e.g. instagram: @studio)</label>
      <textarea id="bk-handles" rows="3" placeholder="instagram: @studio&#10;facebook: studio"></textarea></div>
      <div class="ed-btnrow">
        <button class="btn btn-primary" id="bk-save">Save brand</button>
        <button class="btn" id="bk-clear">Clear form</button>
      </div>
    </div>
  </div>`;
  const parseHandles = (text) => {
    const out = {};
    for (const line of String(text || '').split('\n')) {
      const m = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
      if (m) out[m[1].trim().toLowerCase()] = m[2].trim();
    }
    return out;
  };
  const readForm = () => ({
    name: document.getElementById('bk-name').value.trim(),
    logoMediaId: document.getElementById('bk-logo').value ? parseInt(document.getElementById('bk-logo').value, 10) : null,
    primaryColor: document.getElementById('bk-primary').value,
    secondaryColor: document.getElementById('bk-secondary').value,
    accentColor: document.getElementById('bk-accent').value,
    fontHeading: document.getElementById('bk-font-h').value,
    fontBody: document.getElementById('bk-font-b').value,
    handles: parseHandles(document.getElementById('bk-handles').value),
  });
  const fillForm = (b) => {
    document.getElementById('bk-form-title').textContent = 'Edit brand';
    document.getElementById('bk-id').value = b.id;
    document.getElementById('bk-name').value = b.name;
    document.getElementById('bk-logo').value = b.logoMediaId ? String(b.logoMediaId) : '';
    document.getElementById('bk-primary').value = b.primaryColor;
    document.getElementById('bk-secondary').value = b.secondaryColor;
    document.getElementById('bk-accent').value = b.accentColor;
    document.getElementById('bk-font-h').value = b.fontHeading;
    document.getElementById('bk-font-b').value = b.fontBody;
    document.getElementById('bk-handles').value = Object.entries(b.handles || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  };
  document.getElementById('bk-clear').addEventListener('click', () => renderView());
  document.getElementById('bk-save').addEventListener('click', async () => {
    const errBox = document.getElementById('bk-error');
    const okBox = document.getElementById('bk-ok');
    errBox.style.display = 'none'; okBox.style.display = 'none';
    const body = readForm();
    const id = document.getElementById('bk-id').value;
    try {
      if (id) {
        await api(`/api/design/brands/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
        okBox.textContent = 'Brand updated.';
      } else {
        await api('/api/design/brands', { method: 'POST', body: JSON.stringify(body) });
        okBox.textContent = 'Brand created.';
      }
      okBox.style.display = 'block';
      toast('Brand saved.');
      setTimeout(() => renderView(), 600);
    } catch (e) { errBox.textContent = e.message; errBox.style.display = 'block'; }
  });
  c.querySelectorAll('[data-edit-brand]').forEach((b) => b.addEventListener('click', () => {
    const brand = list.find((x) => String(x.id) === b.dataset.editBrand);
    if (brand) fillForm(brand);
    window.scrollTo(0, 0);
  }));
  c.querySelectorAll('[data-del-brand]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this brand? Designs already made keep their colours.')) return;
    try { await api(`/api/design/brands/${b.dataset.delBrand}`, { method: 'DELETE' }); toast('Brand deleted.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
}

/* ---------- Video Editor (Phase 3) ---------- */
async function viewVideoEditor(c) {
  const mine = await api('/api/projects?search=').catch(() => ({ projects: [] }));
  const videos = mine.projects.filter((p) => p.type === 'video');
  c.innerHTML = `
  <div class="card"><h3>New video project</h3>
    <p class="sub">Pick an aspect ratio and frame rate. The timeline starts empty — add video/audio from your Media Library, add text overlays, then render a real MP4 with FFmpeg.</p>
    <div class="ed-row" style="margin-top:14px">
      <div class="ed-field" style="flex:2"><label>Aspect ratio</label>
        <select id="ve-aspect"><option value="16:9">Landscape 16:9 (1280×720)</option><option value="9:16">Vertical 9:16 (720×1280)</option><option value="1:1">Square 1:1 (720×720)</option><option value="4:5">Portrait 4:5 (720×900)</option></select></div>
      <div class="ed-field" style="flex:1"><label>Frame rate</label>
        <select id="ve-fps"><option value="24">24 fps</option><option value="30" selected>30 fps</option><option value="60">60 fps</option></select></div>
      <div class="ed-field" style="flex:2"><label>Project name</label><input id="ve-name" value="Untitled video"></div>
      <div class="ed-field" style="flex:1"><label>&nbsp;</label><button class="btn btn-primary" id="ve-create" style="width:100%">Create video</button></div>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Your video projects</h3>
    ${videos.length ? videos.map((p) => `
      <div class="list-row">
        <div class="grow" style="cursor:pointer" data-open-video="${p.id}">
          <div class="t">${esc(p.name)}</div>
          <div class="m">updated ${fmtDate(p.updatedAt)}</div>
        </div>
        <button class="btn btn-sm btn-primary" data-open-video="${p.id}">Open editor →</button>
      </div>`).join('') : '<p class="sub" style="margin-top:8px">No video projects yet. Create one above.</p>'}
  </div>`;
  document.getElementById('ve-create').addEventListener('click', async () => {
    const name = document.getElementById('ve-name').value.trim() || 'Untitled video';
    const aspect = document.getElementById('ve-aspect').value;
    const fps = parseInt(document.getElementById('ve-fps').value, 10);
    try {
      const timeline = window.VideoEditor.blankTimeline(aspect, fps);
      const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, type: 'video', content: { timeline } }) });
      go('video-timeline', { projectId: r.project.id });
    } catch (e) { toast(e.message, true); }
  });
  c.querySelectorAll('[data-open-video]').forEach((b) => b.addEventListener('click', () => go('video-timeline', { projectId: b.dataset.openVideo })));
}

async function viewVideoTimeline(c) {
  const projectId = state.params.projectId;
  if (!projectId) { go('video-editor'); return; }
  let project;
  try {
    project = (await api(`/api/projects/${projectId}`)).project;
  } catch (e) {
    c.innerHTML = `<div class="card"><h3>Video project not found</h3><p class="sub">${esc(e.message)}</p><br><button class="btn" id="vt-back">← Back to Video Editor</button></div>`;
    document.getElementById('vt-back').addEventListener('click', () => go('video-editor'));
    return;
  }
  if (project.type !== 'video') {
    c.innerHTML = `<div class="card"><h3>Not a video project</h3><p class="sub">This project is a ${esc(project.type)} project. Video editing needs a video project.</p><br><button class="btn" id="vt-back">← Back</button></div>`;
    document.getElementById('vt-back').addEventListener('click', () => go('projects'));
    return;
  }
  c.style.maxWidth = 'none';
  c.style.padding = '16px';
  await window.VideoEditor.open(c, { project });
}

/* ---------- Export Center (Phase 3) ---------- */
async function viewExportCenter(c) {
  const { jobs } = await api('/api/video/jobs').catch(() => ({ jobs: [] }));
  const badge = { queued: 'warn', running: '', done: 'ok', failed: 'err', cancelled: 'err' };
  c.innerHTML = `
  <div class="card"><h3>Render jobs</h3>
    <p class="sub">Every video render runs as a real FFmpeg job. Progress is read from FFmpeg itself. Download finished MP4s, retry failures, or save a finished render to the Media Library.</p>
    <div style="margin-top:12px">${jobs.length ? jobs.map((j) => `
      <div class="ve-job">
        <div><b>Job #${j.id}</b> <span class="badge ${badge[j.status] || ''}">${j.status}</span> <span style="float:right">${j.progress}%</span>
        <span class="sub" style="display:block;margin-top:4px">${esc(j.settings.resolution || '')} · ${esc(String(j.settings.fps || ''))}fps · ${fmtDate(j.createdAt)}</span></div>
        <div class="ve-progress"><div style="width:${j.progress}%"></div></div>
        ${j.error ? `<div class="error" style="display:block">${esc(j.error)}</div>` : ''}
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          ${j.status === 'done' && j.hasOutput ? `<a class="btn btn-sm btn-primary" href="/api/video/jobs/${j.id}/download">⬇ Download MP4</a>` : ''}
          ${['queued', 'running'].includes(j.status) ? `<button class="btn btn-sm btn-danger" data-ec-cancel="${j.id}">Cancel</button>` : ''}
          ${['failed', 'cancelled'].includes(j.status) ? `<button class="btn btn-sm" data-ec-retry="${j.id}">Retry</button>` : ''}
          ${j.status === 'done' ? `<button class="btn btn-sm" data-ec-lib="${j.id}">Save to Media Library</button>` : ''}
          <button class="btn btn-sm btn-ghost" data-ec-log="${j.id}">View log</button>
          ${!['queued', 'running'].includes(j.status) ? `<button class="btn btn-sm btn-danger" data-ec-del="${j.id}">Delete</button>` : ''}
        </div>
        <div id="ec-log-${j.id}"></div>
      </div>`).join('') : '<p class="sub" style="margin-top:8px">No renders yet. Open a video project in the Video Editor and press Render.</p>'}
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Image exports</h3>
    <p class="sub">Graphic designs export as PNG/JPG from the Graphic Editor (real canvas pixels, transparent PNG supported). Batch image export and ZIP download arrive with Bulk Design in Phase 4.</p>
  </div>`;
  const refresh = () => renderView();
  c.querySelectorAll('[data-ec-cancel]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/video/jobs/${b.dataset.ecCancel}/cancel`, { method: 'POST' }); toast('Cancel requested.'); setTimeout(refresh, 800); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-ec-retry]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/video/jobs/${b.dataset.ecRetry}/retry`, { method: 'POST' }); toast('Render re-queued.'); setTimeout(refresh, 800); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-ec-lib]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/video/jobs/${b.dataset.ecLib}/save-to-library`, { method: 'POST' }); toast('Saved to Media Library.'); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-ec-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this render job and its MP4 file?')) return;
    try { await api(`/api/video/jobs/${b.dataset.ecDel}`, { method: 'DELETE' }); toast('Job deleted.'); refresh(); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-ec-log]').forEach((b) => b.addEventListener('click', async () => {
    const box = document.getElementById(`ec-log-${b.dataset.ecLog}`);
    if (!box) return;
    if (box.innerHTML) { box.innerHTML = ''; return; }
    try {
      const r = await api(`/api/video/jobs/${b.dataset.ecLog}/log`);
      box.innerHTML = `<div class="ve-log">${esc((r.log || '(log is empty)') + (r.error ? `\nERROR: ${r.error}` : ''))}</div>`;
    } catch (e) { box.innerHTML = `<div class="error" style="display:block">${esc(e.message)}</div>`; }
  }));
  // Auto-refresh while any job is active.
  if (jobs.some((j) => ['queued', 'running'].includes(j.status))) {
    setTimeout(() => { if (state.view === 'export') renderView(); }, 2000);
  }
}

/* ---------- Effects & Transitions (Phase 3 — only what is really supported) ---------- */
async function viewEffects(c) {
  const fx = await api('/api/video/effects').catch(() => ({ transitions: [], filters: [], notYet: [] }));
  c.innerHTML = `
  <div class="grid grid-2">
    <div class="card"><h3>Transitions — supported &amp; rendered</h3>
      <p class="sub">Apply between adjacent clips on the same video track (right panel → Transition). Rendered with FFmpeg xfade.</p>
      ${fx.transitions.map((t) => `
        <div class="kv"><span><b>${esc(t.name)}</b><br><small style="color:var(--muted)">${esc(t.note)}</small></span>
        <span class="badge">up to ${t.maxDuration}s</span></div>`).join('')}
    </div>
    <div class="card"><h3>Filters — per clip</h3>
      <p class="sub">Sliders in the Video Editor's right panel. They apply to the preview and to the FFmpeg render.</p>
      ${fx.filters.map((f) => `<div class="kv"><span><b>${esc(f.name)}</b></span><span>${f.min} to ${f.max}</span></div>`).join('')}
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Not in Phase 3 — honestly</h3>
    <p class="sub">${(fx.notYet || []).map((n) => `• ${esc(n)}`).join('<br>')}</p>
    <div style="margin-top:12px"><button class="btn btn-primary" id="fx-open-editor">Open Video Editor →</button></div>
  </div>`;
  document.getElementById('fx-open-editor').addEventListener('click', () => go('video-editor'));
}

/* ---------- Animation Studio (Phase 3 — keyframes live in the Video Editor) ---------- */
async function viewAnimation(c) {
  const fx = await api('/api/video/effects').catch(() => ({ keyframeProperties: [] }));
  c.innerHTML = `
  <div class="card"><h3>Keyframe animation</h3>
    <p class="sub">Keyframes live on each clip in the Video Editor (right panel → Keyframes tab). Add a keyframe at the playhead, edit its values, and the render interpolates linearly between points.</p>
    ${(fx.keyframeProperties || []).map((p) => `<div class="kv"><span><b>${esc(p.name)}</b><br><small style="color:var(--muted)">${esc(p.note)}</small></span></div>`).join('')}
    <p class="sub" style="margin-top:12px">Not in Phase 3: motion paths and easing curves — keyframes interpolate linearly. Text animation (fade/slide in and out) is set per text clip in the Clip tab.</p>
    <div style="margin-top:12px;display:flex;gap:10px">
      <button class="btn btn-primary" id="an-open-editor">Open Video Editor →</button>
      <button class="btn" id="an-effects">Effects &amp; Transitions</button>
    </div>
  </div>`;
  document.getElementById('an-open-editor').addEventListener('click', () => go('video-editor'));
  document.getElementById('an-effects').addEventListener('click', () => go('effects'));
}

/* ---------- Later-phase placeholder (honest, no fake UI) ---------- */
function viewPlaceholder(c, nav) {
  if (!nav) { c.innerHTML = '<div class="card"><h3>Not found</h3></div>'; return; }
  c.innerHTML = `
  <div class="phase-hero">
    <div class="big">${nav.icon}</div>
    <h2>${esc(nav.label)}</h2>
    <p>${esc(nav.blurb || '')}</p>
    <p><span class="badge warn">Phase ${nav.phase} — not yet built</span></p>
    <p style="margin-top:14px">This module is part of the Phase ${nav.phase} scope. It is listed in the sidebar so the full platform structure is visible, but no editor, button or result is faked here — the work starts in Phase ${nav.phase}.</p>
    <div style="margin-top:18px;display:flex;gap:10px;justify-content:center">
      <button class="btn btn-primary" id="ph-dash">← Back to Dashboard</button>
      <button class="btn" id="ph-projects">Open Projects</button>
    </div>
  </div>`;
  document.getElementById('ph-dash').addEventListener('click', () => go('dashboard'));
  document.getElementById('ph-projects').addEventListener('click', () => go('projects'));
}

/* ---------- Modals ---------- */
function openModal(html) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${html}</div>`;
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  document.body.appendChild(back);
  return back;
}
function openProjectModal() {
  const back = openModal(`
    <h2>New project</h2><p class="sub">Projects hold your designs, videos and bulk jobs.</p>
    <div class="error" id="np-error"></div>
    <label for="np-name">Project name</label><input id="np-name" placeholder="e.g. Summer Sale Campaign">
    <label for="np-type">Type</label>
    <select id="np-type"><option value="design">Design</option><option value="video">Video</option><option value="bulk">Bulk video</option><option value="shorts">Shorts</option><option value="social">Social post</option></select>
    <div class="modal-actions"><button class="btn" id="np-cancel">Cancel</button><button class="btn btn-primary" id="np-create">Create project</button></div>`);
  back.querySelector('#np-cancel').addEventListener('click', () => back.remove());
  back.querySelector('#np-create').addEventListener('click', async () => {
    const name = back.querySelector('#np-name').value.trim();
    const type = back.querySelector('#np-type').value;
    try {
      const r = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, type, content: { title: name, elements: [] } }) });
      back.remove(); toast('Project created.'); go('project', { id: r.project.id });
    } catch (e) {
      const eb = back.querySelector('#np-error'); eb.textContent = e.message; eb.style.display = 'block';
    }
  });
  back.querySelector('#np-name').focus();
}
function openFolderModal(kind) {
  const back = openModal(`
    <h2>New ${kind} folder</h2>
    <div class="error" id="nf-error"></div>
    <label for="nf-name">Folder name</label><input id="nf-name" placeholder="e.g. Client work">
    <div class="modal-actions"><button class="btn" id="nf-cancel">Cancel</button><button class="btn btn-primary" id="nf-create">Create folder</button></div>`);
  back.querySelector('#nf-cancel').addEventListener('click', () => back.remove());
  back.querySelector('#nf-create').addEventListener('click', async () => {
    try {
      const path = kind === 'media' ? '/api/media/folders' : '/api/projects/folders';
      await api(path, { method: 'POST', body: JSON.stringify({ name: back.querySelector('#nf-name').value.trim() }) });
      back.remove(); toast('Folder created.'); renderView();
    } catch (e) {
      const eb = back.querySelector('#nf-error'); eb.textContent = e.message; eb.style.display = 'block';
    }
  });
}
function openTagModal(m) {
  const back = openModal(`
    <h2>Edit tags</h2><p class="sub">${esc(m.originalName)}</p>
    <label for="tg-input">Tags (comma separated)</label><input id="tg-input" value="${esc(m.tags)}" placeholder="product, summer, hero">
    <div class="modal-actions"><button class="btn" id="tg-cancel">Cancel</button><button class="btn btn-primary" id="tg-save">Save tags</button></div>`);
  back.querySelector('#tg-cancel').addEventListener('click', () => back.remove());
  back.querySelector('#tg-save').addEventListener('click', async () => {
    try { await api(`/api/media/${m.id}`, { method: 'PATCH', body: JSON.stringify({ tags: back.querySelector('#tg-input').value.trim() }) }); back.remove(); toast('Tags saved.'); renderView(); }
    catch (e) { toast(e.message, true); }
  });
}
function openMediaPreview(m) {
  const back = openModal(`
    <h2>${esc(m.originalName)}</h2>
    <p class="sub">${esc(m.kind)} · ${fmtBytes(m.sizeBytes)} · ${fmtDate(m.createdAt)}${m.tags ? ' · 🏷 ' + esc(m.tags) : ''}</p>
    <div style="margin-top:12px;background:var(--bg2);border-radius:10px;overflow:hidden;display:flex;justify-content:center">
      ${m.kind === 'image' ? `<img src="${m.url}" style="max-width:100%;max-height:420px" alt="">`
        : m.kind === 'video' ? `<video src="${m.url}" controls style="max-width:100%;max-height:420px"></video>`
        : `<audio src="${m.url}" controls style="width:100%;margin:20px"></audio>`}
    </div>
    <div class="modal-actions"><button class="btn btn-primary" id="pv-close">Close</button></div>`);
  back.querySelector('#pv-close').addEventListener('click', () => back.remove());
}
function openProviderKeyModal(providerId) {
  const back = openModal(`
    <h2>Add provider API key</h2>
    <p class="sub">The key is stored encrypted in the database and never displayed in full. It is only used server-side by the provider in a later phase.</p>
    <div class="error" id="pk-error"></div>
    <label for="pk-key">API key</label><input id="pk-key" type="password" placeholder="sk-… / key…" autocomplete="off">
    <div class="modal-actions"><button class="btn" id="pk-cancel">Cancel</button><button class="btn btn-primary" id="pk-save">Save key</button></div>`);
  back.querySelector('#pk-cancel').addEventListener('click', () => back.remove());
  back.querySelector('#pk-save').addEventListener('click', async () => {
    try {
      await api(`/api/providers/${providerId}/key`, { method: 'POST', body: JSON.stringify({ key: back.querySelector('#pk-key').value }) });
      back.remove(); toast('Provider key saved (encrypted).'); renderView();
    } catch (e) {
      const eb = back.querySelector('#pk-error'); eb.textContent = e.message; eb.style.display = 'block';
    }
  });
}

boot();
