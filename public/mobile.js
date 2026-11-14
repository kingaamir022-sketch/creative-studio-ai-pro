'use strict';
/* CreativeStudio AI Pro — Mobile shell (v2.7.0, CapCut mobile exact).
   Renders the five mobile views (Edit home, Templates, AI Lab, Inbox, Me)
   + the All Tools sheet + bottom nav + FAB at viewport <=860px. Desktop
   (>860px) never loads a mobile view: render() only calls the mobile
   home branch when isMobile(), and the m-* views are only reachable from
   the mobile nav.
   HONESTY: every tile opens its real local feature (or the closest real
   one, with the mapping stated in the delivery report). Nothing here
   invents followers, views, rewards, badges or use-counts. */
window.MobileShell = (() => {
  const MOBILE_VIEWS = ['home', 'm-templates', 'm-ailab', 'm-inbox', 'm-me'];
  const BP = 860;
  let lastMobile = null;
  let inboxBadgeTimer = null;

  function isMobile() { return window.matchMedia(`(max-width: ${BP}px)`).matches; }
  function isUnlimited(u) { return !!u && (u.plan === 'Lifetime' || u.plan === 'Enterprise' || u.role === 'OWNER'); }
  function creditsText(u) { return isUnlimited(u) ? '∞' : String(u ? u.creditsBalance : 0); }
  function fmtDur(s) {
    if (s === null || s === undefined) return '';
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }
  function fmtCount(n) {
    if (n == null) return '';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(n);
  }
  function typeIcon(t) { return { video: '🎬', design: '🎨', deck: '📊', doc: '📝', bulk: '📹', shorts: '✂️', social: '📣' }[t] || '📁'; }
  function thumbClass(t) {
    if (t.kind === 'video') return 'm-thumb-video';
    if (t.kind === 'deck') return 'm-thumb-deck';
    if (t.category === 'Social') return 'm-thumb-social';
    if (t.category === 'Promo') return 'm-thumb-promo';
    return 'm-thumb-design';
  }
  function planPillLabel(u) {
    if (!u) return '💎 See plans';
    if (isUnlimited(u)) return '✓ Lifetime Free';
    return `💎 ${u.plan} plan — see plans`;
  }
  function openView(v, params) { go(v, params || {}); }

  /* Install a template (built-in or community) and open the real project. */
  async function installTemplate(t) {
    try {
      let r;
      if (t.builtin === false || (t.builtin === undefined && t.authorName)) {
        r = await api(`/api/marketplace/${encodeURIComponent(t.id)}/install`, { method: 'POST' });
      } else {
        r = await api(`/api/marketplace/builtin/${encodeURIComponent(t.id)}/install`, { method: 'POST' });
      }
      toast('Template installed.');
      openProjectInEditor({ id: r.installed.id, type: r.installed.kind });
    } catch (e) { toast(e.message, true); }
  }

  /* Carry a typed AI Lab prompt into the real AI Video Generator and
     pre-fill its prompt box (the generator itself is unchanged). */
  function carryPromptToVideo(prompt) {
    const p = String(prompt || '').trim();
    if (!p) { toast('Type a prompt first — e.g. "a sunset timelapse over mountains".', true); return; }
    openView('ai-video');
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const f = document.getElementById('ai-f-prompt');
      if (state.view !== 'ai-video') { clearInterval(timer); return; }
      if (f) {
        clearInterval(timer);
        f.value = p;
        try { f.focus(); } catch { /* ignore */ }
        toast('Prompt carried over — press Generate in AI Video.');
      } else if (tries > 50) {
        clearInterval(timer);
        toast('Prompt was not carried over — paste it into the prompt box.', true);
      }
    }, 100);
  }

  /* ---------- Shell: bottom nav + FAB + editor sheet buttons ---------- */
  function activeTab() {
    switch (state.view) {
      case 'home': return 'home';
      case 'm-templates': return 'templates';
      case 'm-ailab': return 'ailab';
      case 'm-inbox': return 'inbox';
      case 'm-me': return 'me';
      default: return '';
    }
  }
  function removeSheetChrome() {
    ['m-sheet-scrim', 'm-sheet-tools-btn', 'm-sheet-details-btn'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    document.body.classList.remove('m-sheet-tools', 'm-sheet-details');
  }
  function updateSheetUI() {
    const open = document.body.classList.contains('m-sheet-tools') || document.body.classList.contains('m-sheet-details');
    let scrim = document.getElementById('m-sheet-scrim');
    if (open && !scrim) {
      scrim = document.createElement('div');
      scrim.id = 'm-sheet-scrim';
      scrim.addEventListener('click', () => {
        document.body.classList.remove('m-sheet-tools', 'm-sheet-details');
        updateSheetUI();
      });
      document.body.appendChild(scrim);
    } else if (!open && scrim) {
      scrim.remove();
    }
  }
  function refreshInboxBadge() {
    const badge = document.getElementById('m-nav-badge');
    if (!badge) return;
    api('/api/notifications').then(({ unreadCount }) => {
      const b = document.getElementById('m-nav-badge');
      if (!b) return;
      if (unreadCount > 0) { b.textContent = unreadCount > 99 ? '99+' : String(unreadCount); b.style.display = 'flex'; }
      else b.style.display = 'none';
    }).catch(() => { /* badge stays hidden when offline */ });
  }
  function mount() {
    const mobile = isMobile();
    document.body.classList.toggle('m-mobile', mobile);
    document.body.classList.toggle('m-chrome', mobile && MOBILE_VIEWS.includes(state.view));
    const inEditor = mobile && (state.view === 'video-timeline' || state.view === 'video-editor');
    document.body.classList.toggle('m-editor', inEditor);
    if (!inEditor) removeSheetChrome();
    let nav = document.getElementById('m-nav');
    let fab = document.getElementById('m-fab');
    if (!mobile) {
      if (nav) nav.remove();
      if (fab) fab.remove();
      removeSheetChrome();
      return;
    }
    const tab = activeTab();
    if (!nav) {
      nav = document.createElement('nav');
      nav.id = 'm-nav';
      nav.setAttribute('aria-label', 'Mobile navigation');
      document.body.appendChild(nav);
    }
    nav.innerHTML = `
      <button class="m-tab ${tab === 'home' ? 'active' : ''}" id="m-tab-home" data-m-go="home"><span class="m-ico">✂️</span>Edit</button>
      <button class="m-tab ${tab === 'templates' ? 'active' : ''}" id="m-tab-templates" data-m-go="m-templates"><span class="m-ico">▦</span>Templates</button>
      <button class="m-tab ${tab === 'ailab' ? 'active' : ''}" id="m-tab-ailab" data-m-go="m-ailab"><span class="m-ico">✦</span>AI Lab</button>
      <button class="m-tab ${tab === 'inbox' ? 'active' : ''}" id="m-tab-inbox" data-m-go="m-inbox"><span class="m-ico">🔔<span class="m-badge" id="m-nav-badge" style="display:none"></span></span>Inbox</button>
      <button class="m-tab ${tab === 'me' ? 'active' : ''}" id="m-tab-me" data-m-go="m-me"><span class="m-ico">👤</span>Me</button>`;
    nav.querySelectorAll('[data-m-go]').forEach((b) => b.addEventListener('click', () => openView(b.dataset.mGo)));
    if (!fab) {
      fab = document.createElement('button');
      fab.id = 'm-fab';
      fab.textContent = '+';
      fab.title = 'New project';
      fab.setAttribute('aria-label', 'New project');
      fab.addEventListener('click', () => openNewProjectFlow());
      document.body.appendChild(fab);
    }
    if (inEditor) {
      if (!document.getElementById('m-sheet-tools-btn')) {
        const toolsBtn = document.createElement('button');
        toolsBtn.id = 'm-sheet-tools-btn';
        toolsBtn.className = 'm-sheet-btn';
        toolsBtn.textContent = '🛠 Tools';
        toolsBtn.addEventListener('click', () => {
          document.body.classList.remove('m-sheet-details');
          document.body.classList.toggle('m-sheet-tools');
          updateSheetUI();
        });
        document.body.appendChild(toolsBtn);
        const detBtn = document.createElement('button');
        detBtn.id = 'm-sheet-details-btn';
        detBtn.className = 'm-sheet-btn';
        detBtn.textContent = '🎛 Details';
        detBtn.addEventListener('click', () => {
          document.body.classList.remove('m-sheet-tools');
          document.body.classList.toggle('m-sheet-details');
          updateSheetUI();
        });
        document.body.appendChild(detBtn);
      }
    } else {
      ['m-sheet-tools-btn', 'm-sheet-details-btn'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.remove();
      });
    }
    clearTimeout(inboxBadgeTimer);
    inboxBadgeTimer = setTimeout(refreshInboxBadge, 50);
  }
  function watchResize() {
    if (lastMobile === null) lastMobile = isMobile();
    window.addEventListener('resize', () => {
      const now = isMobile();
      if (now === lastMobile) return;
      lastMobile = now;
      if (!now && state.view && state.view.startsWith('m-')) { go('home'); return; }
      render();
    });
  }

  /* ---------- All Tools sheet ---------- */
  // Every tile opens its real local feature. Tiles with no exact local
  // counterpart map to the closest real feature and say so (toast + the
  // delivery report lists each mapping). Nothing here is dead.
  const ALL_TOOLS = [
    { section: 'Quick actions', tiles: [
      { label: 'Retouch', icon: '💄', go: 'ai-retouch' },
      { label: 'Auto captions', icon: '💬', go: 'captions' },
      { label: 'Teleprompter', icon: '📺', go: 'captions', note: 'No teleprompter in this app — your script and transcript live in Auto Captions.' },
      { label: 'Camera', icon: '📷', go: 'media', note: 'No in-app camera — import photos and videos from the Media Library.' },
      { label: 'Auto enhance', icon: '✨', go: 'ai-enhance' },
      { label: 'Record', icon: '🎙️', go: 'voices', note: 'Recorded narration lives in Voices; in-editor voiceover recording is in the Video Editor → Audio tab.' },
      { label: 'Collage', icon: '▦', go: 'graphic-editor', note: 'No collage preset — arrange photos freely in the Graphic Editor.' },
      { label: 'Frame capture', icon: '🖼️', go: 'export', note: 'Frame capture lives in the Export Center — export a frame PNG from a finished render.' },
      { label: 'Desktop editor', icon: '🎬', go: 'video-editor', note: 'This opens the full desktop video editor — same editor, larger layout.' },
    ] },
    { section: 'AI tools', tiles: [
      { label: 'AutoCut', icon: '✂️', go: 'ai-autocut' },
      { label: 'AI avatars', icon: '🗣️', go: 'ai-avatar', note: 'AI Avatar is a still photo + spoken script — lip-sync is not available in this build.' },
      { label: 'AI dialogue scene', icon: '🎭', go: 'ai-director', note: 'Dialogue scenes live in Director Mode — recurring characters, scenes and style for AI short dramas.' },
      { label: 'AI image', icon: '🖼️', go: 'ai-image' },
      { label: 'AI effects', icon: '🌟', go: 'effects' },
      { label: 'AI video', icon: '🎥', go: 'ai-video' },
      { label: 'Generate media', icon: '➕', go: 'ai-studio' },
      { label: 'Video to carousel', icon: '🗂️', go: 'social', note: 'No carousel builder — compose a multi-image post in Social Creator.' },
    ] },
    { section: 'Photo editing', tiles: [
      { label: 'Photo editor', icon: '🎨', go: 'graphic-editor' },
      { label: 'Remove background', icon: '🪄', go: 'mg-remove-bg' },
      { label: 'Smart lighting', icon: '💡', go: 'ai-enhance', note: 'No Smart lighting tool — Video Enhance is the closest local feature.' },
      { label: 'AI expand', icon: '↔️', go: 'mg-expand' },
      { label: 'Text to image', icon: '✍️', go: 'ai-image' },
      { label: 'AI photo editor', icon: '🖼️', go: 'graphic-editor' },
      { label: 'Cover maker', icon: '📕', go: 'graphic-editor', note: 'Design your cover in the Graphic Editor — pick a thumbnail size (e.g. YouTube Thumbnail) and export PNG.' },
    ] },
    { section: 'Marketing tools', tiles: [
      { label: 'Smart ads', icon: '📣', go: 'social' },
      { label: 'Product photos', icon: '🛍️', go: 'ai-image', note: 'No dedicated product-photo studio — describe the product shot in AI Image.' },
      { label: 'AI poster', icon: '🖼️', go: 'ai-design' },
      { label: 'AI fashion model', icon: '👕', go: 'ai-image', note: 'No fashion-model generator — describe the look and model in AI Image.' },
    ] },
  ];
  function openAllTools() {
    closeAllTools();
    const sheet = document.createElement('div');
    sheet.id = 'm-alltools';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'All tools');
    sheet.innerHTML = `
      <div class="m-alltools-head"><h2>All tools</h2>
        <button class="m-alltools-close" id="m-alltools-close" aria-label="Close all tools">✕</button></div>
      ${ALL_TOOLS.map((s) => `
        <h3>${esc(s.section)}</h3>
        <div class="m-tools-grid">
          ${s.tiles.map((t, i) => `
            <button class="m-tool" data-m-section="${esc(s.section)}" data-m-tile="${i}">
              <span class="m-tool-tile">${t.icon}</span>
              <span class="m-tool-label">${esc(t.label)}</span>
            </button>`).join('')}
        </div>`).join('')}
      <button class="m-new-project" id="m-alltools-new"><span aria-hidden="true">＋</span> New project</button>`;
    document.body.appendChild(sheet);
    sheet.querySelector('#m-alltools-close').addEventListener('click', closeAllTools);
    sheet.querySelector('#m-alltools-new').addEventListener('click', () => { closeAllTools(); openNewProjectFlow(); });
    sheet.querySelectorAll('[data-m-tile]').forEach((b) => b.addEventListener('click', () => {
      const sec = ALL_TOOLS.find((s) => s.section === b.dataset.mSection);
      const t = sec && sec.tiles[Number(b.dataset.mTile)];
      if (!t) return;
      closeAllTools();
      openView(t.go);
      if (t.note) setTimeout(() => toast(t.note), 350);
    }));
  }
  function closeAllTools() {
    const el = document.getElementById('m-alltools');
    if (el) el.remove();
  }

  /* ---------- Mobile Edit home ---------- */
  async function viewHome(c) {
    const [d, tpl] = await Promise.all([
      api('/api/dashboard'),
      api('/api/marketplace/builtin').catch(() => ({ templates: [] })),
    ]);
    const u = state.user;
    const recent = d.recentProjects || [];
    const allTemplates = tpl.templates || [];
    let sort = 'updated-desc';
    c.innerHTML = `
    <div class="m-view" id="m-home">
      <div class="m-home-top">
        <button class="m-plan-pill" id="m-plan-pill">💎 ${esc(isUnlimited(u) ? 'Try Standard 7 days for -' : `${u.plan} plan — see plans`)}</button>
        <button class="m-icon-btn" id="m-home-search-btn" aria-label="Search projects and templates">🔍</button>
      </div>
      <div id="m-search-bar" style="display:none;margin-bottom:12px">
        <input class="m-input" id="m-search-input" type="search" placeholder="Search your projects &amp; templates…" autocomplete="off">
        <div class="m-search-results" id="m-search-results" style="margin-top:8px"></div>
      </div>
      <div class="m-hero">
        <button class="m-hero-card" id="m-new-video">
          <span class="m-hero-ico">＋</span><span class="m-hero-label">New video</span>
        </button>
        <button class="m-hero-card" id="m-edit-photo">
          <span class="m-hero-badge">Seedream 5.5</span>
          <span class="m-hero-ico">🖼️</span><span class="m-hero-label">Edit photo</span>
        </button>
      </div>
      <div class="m-tools-grid">
        <button class="m-tool" data-m-go="ai-autocut"><span class="m-tool-tile">✂️</span><span class="m-tool-label">AutoCut</span></button>
        <button class="m-tool" data-m-go="ai-retouch"><span class="m-tool-tile">💄</span><span class="m-tool-label">Retouch</span></button>
        <button class="m-tool" data-m-go="ai-studio"><span class="m-tool-tile">✨</span><span class="m-tool-label">AI generator</span></button>
        <button class="m-tool" data-m-go="captions"><span class="m-tool-tile">💬</span><span class="m-tool-label">Auto captions</span></button>
        <button class="m-tool" data-m-go="graphic-editor"><span class="m-tool-tile">🎨</span><span class="m-tool-label">Photo editor</span></button>
        <button class="m-tool" id="m-cover-maker"><span class="m-tool-tile">📕</span><span class="m-tool-label">Cover maker</span></button>
        <button class="m-tool" id="m-desktop-editor"><span class="m-tool-tile">🎬</span><span class="m-tool-label">Desktop editor</span></button>
        <button class="m-tool" id="m-all-tools"><span class="m-tool-tile">▦</span><span class="m-tool-label">All tools</span></button>
      </div>
      <div class="m-section-head">
        <h2>Projects</h2><span class="m-spacer"></span>
        <button class="m-space-btn" id="m-space-btn">☁️ Space</button>
        <button class="m-icon-btn" id="m-projects-sort" aria-label="Sort projects" title="Sort projects">☰</button>
      </div>
      <div id="m-project-list"></div>
    </div>`;
    const renderProjects = (list) => {
      const host = document.getElementById('m-project-list');
      if (!host) return;
      host.innerHTML = list.length ? list.map((p) => `
        <button class="m-project" data-open-project="${p.id}">
          <span class="m-project-thumb ${thumbClass({ kind: p.type === 'video' ? 'video' : p.type === 'deck' ? 'deck' : 'design' })}">${typeIcon(p.type)}</span>
          <span style="flex:1;min-width:0">
            <span class="m-project-name">${esc(p.name)}</span>
            <span class="m-project-meta" style="display:block">${esc(p.type)} · Updated ${fmtDate(p.updatedAt)}${p.durationSeconds ? ` · ⏱ ${fmtDur(p.durationSeconds)}` : ''}</span>
          </span>
        </button>`).join('') : `
        <div class="m-empty"><div class="big">🎬✂️</div>
        <p>Your projects will appear here.<br>Start creating now.</p></div>`;
      host.querySelectorAll('[data-open-project]').forEach((el) => el.addEventListener('click', () => {
        const p = recent.find((x) => String(x.id) === String(el.dataset.openProject));
        if (p) openProjectInEditor(p);
      }));
    };
    renderProjects(sortProjects(recent, sort));
    document.getElementById('m-plan-pill').addEventListener('click', () => openView('subscription'));
    document.getElementById('m-new-video').addEventListener('click', () => openNewProjectFlow());
    document.getElementById('m-edit-photo').addEventListener('click', () => openView('graphic-editor'));
    document.getElementById('m-all-tools').addEventListener('click', openAllTools);
    document.getElementById('m-cover-maker').addEventListener('click', () => {
      openView('graphic-editor');
      setTimeout(() => toast('Design your cover in the Graphic Editor — pick a thumbnail size (e.g. YouTube Thumbnail) and export PNG.'), 350);
    });
    document.getElementById('m-desktop-editor').addEventListener('click', () => {
      openView('video-editor');
      setTimeout(() => toast('This opens the full desktop video editor — same editor, larger layout.'), 350);
    });
    document.getElementById('m-space-btn').addEventListener('click', () => openView('projects'));
    document.getElementById('m-projects-sort').addEventListener('click', () => {
      sort = sort === 'updated-desc' ? 'name-asc' : 'updated-desc';
      renderProjects(sortProjects(recent, sort));
      toast(sort === 'name-asc' ? 'Sorted by name.' : 'Sorted by most recent.');
    });
    c.querySelectorAll('[data-m-go]').forEach((b) => b.addEventListener('click', () => openView(b.dataset.mGo)));
    const searchBtn = document.getElementById('m-home-search-btn');
    const searchBar = document.getElementById('m-search-bar');
    const searchInput = document.getElementById('m-search-input');
    const searchResults = document.getElementById('m-search-results');
    searchBtn.addEventListener('click', () => {
      const open = searchBar.style.display === 'none';
      searchBar.style.display = open ? '' : 'none';
      if (open) searchInput.focus();
    });
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) { searchResults.innerHTML = ''; return; }
      const prows = recent.filter((p) => `${p.name} ${p.type}`.toLowerCase().includes(q)).slice(0, 5);
      const trows = allTemplates.filter((t) => `${t.name} ${t.category} ${t.kind}`.toLowerCase().includes(q)).slice(0, 5);
      searchResults.innerHTML = (prows.length || trows.length) ? [
        ...prows.map((p) => `<button class="m-search-row" data-m-search-project="${p.id}">📁 ${esc(p.name)} — ${esc(p.type)} project</button>`),
        ...trows.map((t) => `<button class="m-search-row" data-m-search-template="${esc(t.id)}">🎨 ${esc(t.name)} — template</button>`),
      ].join('') : '<div class="m-empty" style="padding:16px"><p>No matches found.</p></div>';
      searchResults.querySelectorAll('[data-m-search-project]').forEach((el) => el.addEventListener('click', () => {
        const p = recent.find((x) => String(x.id) === String(el.dataset.mSearchProject));
        if (p) openProjectInEditor(p);
      }));
      searchResults.querySelectorAll('[data-m-search-template]').forEach((el) => el.addEventListener('click', () => {
        const t = allTemplates.find((x) => String(x.id) === String(el.dataset.mSearchTemplate));
        if (t) installTemplate(t);
      }));
    });
  }

  /* ---------- Mobile Templates ---------- */
  async function viewTemplates(c) {
    const [trend, tpl] = await Promise.all([
      api('/api/marketplace/trending').catch(() => null),
      api('/api/marketplace/builtin').catch(() => ({ templates: [], categories: [] })),
    ]);
    const rows = (trend && trend.rows) ? trend.rows : null;
    const forYou = rows ? rows.forYou : (tpl.templates || []).slice(0, 8);
    const community = (trend && trend.trending) ? trend.trending : [];
    const builtins = tpl.templates || [];
    const categories = tpl.categories || [...new Set(builtins.map((t) => t.category))].sort();
    let chip = 'foryou';
    let query = '';
    let moreCats = false;
    c.innerHTML = `
    <div class="m-view" id="m-templates">
      <div class="m-tpl-search">
        <input class="m-input" id="m-tpl-search" type="search" placeholder="Search CapCut" autocomplete="off" title="Search this install's template library">
        <button class="m-autocut" id="m-tpl-autocut"><span>✂️</span>AutoCut</button>
      </div>
      <div class="m-chips" id="m-tpl-chips"></div>
      <div class="m-tpl-grid" id="m-tpl-grid"></div>
      <div class="m-empty" id="m-tpl-empty" style="display:none"></div>
    </div>`;
    const chipDefs = () => {
      const base = [
        { id: 'following', label: 'Following' },
        { id: 'foryou', label: 'For you' },
        { id: 'pro', label: 'Pro' },
      ];
      const shown = moreCats ? categories : categories.slice(0, 2);
      return [...base, ...shown.map((cat) => ({ id: `cat:${cat}`, label: cat })), { id: 'more', label: moreCats ? 'Less ▴' : 'More ▾' }];
    };
    const currentList = () => {
      let list;
      if (chip === 'following') list = [];
      else if (chip === 'foryou') list = forYou;
      else if (chip === 'pro') list = community;
      else if (chip.startsWith('cat:')) {
        const cat = chip.slice(4);
        list = [...builtins.filter((t) => t.category === cat), ...community.filter((t) => t.category === cat)];
      } else list = forYou;
      if (query) list = list.filter((t) => `${t.name} ${t.category} ${t.kind} ${t.authorName || ''}`.toLowerCase().includes(query));
      return list;
    };
    const emptyMessage = () => {
      if (chip === 'following') return '<div class="big">👥</div><p>You don\'t follow any creators.<br>This install has no creator follows — community templates appear under For you.</p>';
      if (chip === 'pro') return '<div class="big">⭐</div><p>No community templates yet.<br>Pro here means creator-published templates — publish one from the Marketplace to start the feed.</p>';
      if (query) return '<div class="big">🔍</div><p>No templates match that search.</p>';
      return '<div class="big">🎨</div><p>Nothing here yet.</p>';
    };
    const renderChips = () => {
      document.getElementById('m-tpl-chips').innerHTML = chipDefs().map((d) => `
        <button class="m-chip ${chip === d.id || (d.id === 'more' && moreCats) ? 'active' : ''}" data-m-chip="${esc(d.id)}">${esc(d.label)}</button>`).join('');
      document.querySelectorAll('[data-m-chip]').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.mChip === 'more') { moreCats = !moreCats; renderChips(); return; }
        chip = b.dataset.mChip;
        renderChips();
        renderGrid();
      }));
    };
    const renderGrid = () => {
      const list = currentList();
      const grid = document.getElementById('m-tpl-grid');
      const empty = document.getElementById('m-tpl-empty');
      grid.innerHTML = list.map((t) => `
        <button class="m-tpl-card" data-m-template="${esc(t.id)}">
          <span class="m-thumb ${thumbClass(t)}">
            <span class="m-thumb-kind">${esc((t.kind || 'design').toUpperCase())}</span>
            <span class="m-thumb-emoji">${typeIcon(t.kind === 'video' ? 'video' : t.kind === 'deck' ? 'deck' : 'design')}</span>
            ${t.downloads != null ? `<span class="m-uses">✂️ ${fmtCount(t.downloads)}</span>` : ''}
          </span>
          <span class="m-tpl-name" style="display:block">${esc(t.name)}</span>
          <span class="m-tpl-creator"><span class="m-avatar">${esc(((t.authorName || 'C')[0] || 'C').toUpperCase())}</span>${esc(t.authorName || 'CreativeStudio (built-in)')}</span>
        </button>`).join('');
      grid.querySelectorAll('[data-m-template]').forEach((el) => el.addEventListener('click', () => {
        const t = [...builtins, ...community, ...forYou].find((x) => String(x.id) === String(el.dataset.mTemplate));
        if (t) installTemplate(t);
      }));
      empty.style.display = list.length ? 'none' : '';
      empty.innerHTML = list.length ? '' : emptyMessage();
    };
    renderChips();
    renderGrid();
    document.getElementById('m-tpl-autocut').addEventListener('click', () => openView('ai-autocut'));
    document.getElementById('m-tpl-search').addEventListener('input', (e) => {
      query = e.target.value.trim().toLowerCase();
      renderGrid();
    });
  }

  /* ---------- Mobile AI Lab ---------- */
  async function viewAILab(c) {
    const d = await api('/api/dashboard').catch(() => null);
    const u = state.user;
    const credits = d ? d.creditsBalance : u.creditsBalance;
    const creditLabel = isUnlimited(u) ? '∞' : String(credits);
    c.innerHTML = `
    <div class="m-view" id="m-ailab">
      <div class="m-ailab-top">
        <button class="m-ailab-pill" id="m-ailab-credits" title="${isUnlimited(u) ? 'Unlimited credits — Lifetime Free, never charged.' : 'Your credit balance — see Subscription & Credits for the ledger.'}">✦ ${esc(creditLabel)}</button>
        <button class="m-ailab-pill m-icon" id="m-ailab-history" aria-label="AI job history" title="AI job history">🕐</button>
      </div>
      <h1 class="m-ailab-heading">What are we creating today?</h1>
      <button class="m-remix" id="m-remix">
        <span class="m-remix-strip" aria-hidden="true"><div>🛍️</div><div>🤵</div><div>🚗</div><div>🤵</div></span>
        <span class="m-remix-label">Remix viral content <span style="margin-left:auto">›</span></span>
      </button>
      <div class="m-ailab-pills">
        <button class="m-ailab-pillbtn" data-m-go="graphic-editor">🖼️ Quick photo edit</button>
        <button class="m-ailab-pillbtn" data-m-go="ai-autocut">✂️ AutoCut</button>
        <button class="m-ailab-pillbtn" data-m-go="ai-video">🎥 Create AI video</button>
        <button class="m-ailab-pillbtn" data-m-go="ai-seedance">🌱 Try Seedance 2.5</button>
      </div>
      <div class="m-ailab-inputbar">
        <textarea id="m-ailab-prompt" rows="2" placeholder="Turn Photos into AI Videos"></textarea>
        <div class="m-ailab-actions">
          <button class="m-ailab-round" id="m-ailab-attach" aria-label="Attach media" title="Attach media from your library">＋</button>
          <button class="m-ailab-round" id="m-ailab-tools" aria-label="More tools" title="All tools">▦</button>
          <button class="m-ailab-round m-send" id="m-ailab-send" aria-label="Send prompt" title="Send to AI Video Generator">➤</button>
          <button class="m-ailab-round m-mic" id="m-ailab-mic" aria-label="Voice input" title="Voice — record narration in Voices">🎙️</button>
        </div>
      </div>
      <p class="m-sub" style="margin-top:12px">Prompts go to the real AI Video Generator (needs a video provider key — without one it refuses honestly, never fakes a video). Seedance Extend is not built locally and fails with that exact reason.</p>
    </div>`;
    document.getElementById('m-ailab-credits').addEventListener('click', () => openView('subscription'));
    document.getElementById('m-ailab-history').addEventListener('click', () => openView('ai-studio'));
    document.getElementById('m-remix').addEventListener('click', () => openView('m-templates'));
    c.querySelectorAll('[data-m-go]').forEach((b) => b.addEventListener('click', () => openView(b.dataset.mGo)));
    document.getElementById('m-ailab-attach').addEventListener('click', () => openView('media'));
    document.getElementById('m-ailab-tools').addEventListener('click', openAllTools);
    document.getElementById('m-ailab-mic').addEventListener('click', () => openView('voices'));
    document.getElementById('m-ailab-send').addEventListener('click', () => {
      carryPromptToVideo(document.getElementById('m-ailab-prompt').value);
    });
  }

  /* ---------- Mobile Inbox ---------- */
  async function viewInbox(c) {
    const [notif, jobsRes, shared] = await Promise.all([
      api('/api/notifications').catch(() => ({ notifications: [], unreadCount: 0 })),
      api('/api/jobs').catch(() => ({ jobs: [] })),
      api('/api/collab/shared-with-me').catch(() => ({ projects: [] })),
    ]);
    const notices = notif.notifications || [];
    const unread = notif.unreadCount || 0;
    const jobs = jobsRes.jobs || [];
    const sharedProjects = shared.projects || [];
    // Real collaboration comments on projects shared with me.
    let comments = [];
    for (const p of sharedProjects) {
      try {
        const r = await api(`/api/collab/projects/${p.id}/comments`);
        for (const t of (r.comments || [])) {
          comments.push({ author: t.authorName || 'Someone', body: t.body, projectId: p.id, projectName: p.name, createdAt: t.createdAt });
          for (const rep of (t.replies || [])) {
            comments.push({ author: rep.authorName || 'Someone', body: rep.body, projectId: p.id, projectName: p.name, createdAt: rep.createdAt });
          }
        }
      } catch { /* a project whose comments fail to load is skipped, never faked */ }
    }
    comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    let tab = 'interactions';
    let filter = 'all';
    c.innerHTML = `
    <div class="m-view" id="m-inbox">
      <h1 class="m-title" style="text-align:center">Inbox</h1>
      <div class="m-inbox-tabs">
        <button class="m-inbox-tab" id="m-inbox-tab-official">CapCut official(${unread})</button>
        <button class="m-inbox-tab active" id="m-inbox-tab-interactions">Interactions</button>
      </div>
      <div class="m-chips" id="m-inbox-filters">
        <button class="m-chip active" data-m-filter="all">✉️ All</button>
        <button class="m-chip" data-m-filter="exports">✂️ Exports</button>
        <button class="m-chip" data-m-filter="likes">🤍 Likes</button>
        <button class="m-chip" data-m-filter="comments">💬 Comments</button>
      </div>
      <p class="m-note" id="m-inbox-note">System notices from CreativeStudio on this install — not CapCut. There are no CapCut-cloud followers here, so nobody can follow you and no Follow button is shown.</p>
      <h2 class="m-inbox-section">New</h2>
      <div id="m-inbox-list"></div>
    </div>`;
    const noticeRow = (n) => `
      <div class="m-inbox-row">
        <span class="m-avatar">C</span>
        <span class="m-inbox-body">
          <span class="m-inbox-name">CreativeStudio</span>
          <span class="m-inbox-meta" style="display:block">${fmtDate(n.createdAt)} · ${esc(n.detail || n.action)}</span>
        </span>
      </div>`;
    const exportRow = (j) => `
      <div class="m-inbox-row">
        <span class="m-avatar">🎬</span>
        <span class="m-inbox-body">
          <span class="m-inbox-name">Export ${esc(j.status || '')}</span>
          <span class="m-inbox-meta" style="display:block">${fmtDate(j.created_at)} · ${esc(j.type || 'render')} job #${j.id}</span>
        </span>
        <button class="m-inbox-action" data-m-open-export="1">Open</button>
      </div>`;
    const commentRow = (cm) => `
      <div class="m-inbox-row">
        <span class="m-avatar">${esc((cm.author[0] || '?').toUpperCase())}</span>
        <span class="m-inbox-body">
          <span class="m-inbox-name">${esc(cm.author)}</span>
          <span class="m-inbox-meta" style="display:block">${fmtDate(cm.createdAt)} · commented on “${esc(cm.projectName)}”: ${esc(String(cm.body).slice(0, 120))}</span>
        </span>
        <button class="m-inbox-action" data-m-open-project="${cm.projectId}">View</button>
      </div>`;
    const renderList = () => {
      const host = document.getElementById('m-inbox-list');
      const filtersEl = document.getElementById('m-inbox-filters');
      const note = document.getElementById('m-inbox-note');
      filtersEl.style.display = tab === 'interactions' ? '' : 'none';
      note.style.display = tab === 'official' ? '' : 'none';
      let html = '';
      if (tab === 'official') {
        html = notices.length ? notices.map(noticeRow).join('')
          : '<div class="m-empty"><div class="big">🔔</div><p>No system notices yet.<br>Create a project or upload media and it will show up here.</p></div>';
      } else {
        const exps = jobs.filter((j) => (j.status === 'done' || j.status === 'failed' || j.status === 'running' || j.status === 'queued'));
        if (filter === 'exports') {
          html = exps.length ? exps.map(exportRow).join('')
            : '<div class="m-empty"><div class="big">✂️</div><p>No exports yet.<br>Finished renders will appear here.</p></div>';
        } else if (filter === 'comments') {
          html = comments.length ? comments.map(commentRow).join('')
            : '<div class="m-empty"><div class="big">💬</div><p>No comments yet.<br>Comments on projects shared with you will appear here.</p></div>';
        } else if (filter === 'likes') {
          html = '<div class="m-empty"><div class="big">🤍</div><p>No likes yet.<br>This app does not track likes on projects — likes will appear here if that is ever added.</p></div>';
        } else {
          const parts = [...comments.map(commentRow), ...exps.map(exportRow)];
          html = parts.length ? parts.join('')
            : '<div class="m-empty"><div class="big">📥</div><p>Nothing here yet.<br>Render a video or get a comment on a shared project and it will show up here.</p></div>';
        }
      }
      host.innerHTML = html;
      host.querySelectorAll('[data-m-open-project]').forEach((b) => b.addEventListener('click', () => openView('project', { id: Number(b.dataset.mOpenProject) })));
      host.querySelectorAll('[data-m-open-export]').forEach((b) => b.addEventListener('click', () => openView('export')));
    };
    const setTab = (t) => {
      tab = t;
      document.getElementById('m-inbox-tab-official').classList.toggle('active', t === 'official');
      document.getElementById('m-inbox-tab-interactions').classList.toggle('active', t === 'interactions');
      renderList();
    };
    document.getElementById('m-inbox-tab-official').addEventListener('click', () => setTab('official'));
    document.getElementById('m-inbox-tab-interactions').addEventListener('click', () => setTab('interactions'));
    document.querySelectorAll('[data-m-filter]').forEach((b) => b.addEventListener('click', () => {
      filter = b.dataset.mFilter;
      document.querySelectorAll('[data-m-filter]').forEach((x) => x.classList.toggle('active', x === b));
      renderList();
    }));
    renderList();
    // Opening the inbox marks notices seen (same rule as the bell).
    try { await api('/api/notifications/seen', { method: 'POST' }); } catch { /* badge already refreshed by mount() */ }
    refreshInboxBadge();
  }

  /* ---------- Mobile Me / profile ---------- */
  async function viewMe(c) {
    const [d, an] = await Promise.all([
      api('/api/dashboard').catch(() => null),
      api('/api/analytics?days=30').catch(() => null),
    ]);
    const u = state.user;
    const recent = (d && d.recentProjects) || [];
    const totals = (an && an.totals) || {};
    const renders30 = an ? (an.rendersByDay || []).reduce((s, r) => s + (r.count || 0), 0) : 0;
    const topTpl = an && an.topTemplates && an.topTemplates[0] ? an.topTemplates[0] : null;
    c.innerHTML = `
    <div class="m-view" id="m-me">
      <div class="m-me-top">
        <button class="m-plan-pill" id="m-me-plan">💎 ${esc(isUnlimited(u) ? 'FREE year of Pro' : `${u.plan} plan`)}</button>
        <button class="m-renew-btn" id="m-me-renew">Renew Pro</button>
        <button class="m-icon-btn" id="m-me-bell" aria-label="Notifications">🔔</button>
        <button class="m-icon-btn" id="m-me-settings" aria-label="Settings">⚙️</button>
      </div>
      <div class="m-profile">
        <span class="m-avatar-lg">${esc((u.name || '?')[0].toUpperCase())}</span>
        <span style="min-width:0">
          <span class="m-profile-name" style="display:block">${esc(u.name)}</span>
          <button class="m-profile-link" id="m-view-profile">View profile ›</button>
        </span>
      </div>
      <div class="m-progress-grid">
        <div class="m-progress-card">
          <h3>Your progress</h3>
          <div class="m-stat-num">${totals.projects ?? (d && d.counts ? d.counts.projects : 0)}</div>
          <div class="m-stat-lbl">projects created (all-time, this install)</div>
          <div class="m-stat-num" style="margin-top:8px">${totals.rendersDone ?? 0}</div>
          <div class="m-stat-lbl">renders completed</div>
        </div>
        <div class="m-progress-card" style="background:linear-gradient(135deg,#e0e7ff,#c7d2fe)">
          <h3>Honor Wall</h3>
          <div class="m-stat-lbl" style="color:#1e293b;font-size:14px;line-height:1.5">No badges yet — create and export to earn your first. This app has no badge system; nothing here is a cloud level.</div>
        </div>
      </div>
      <div class="m-creator-card">
        <h3>Creator center</h3>
        <div class="m-creator-stats">
          <div><div class="m-num">${renders30}</div><div class="m-lbl">renders · last 30 days</div></div>
          <div><div class="m-num">${totals.aiJobs ?? 0}</div><div class="m-lbl">AI jobs · all-time</div></div>
          <div><div class="m-num">${topTpl ? fmtCount(topTpl.downloads || 0) : '0'}</div><div class="m-lbl">top template installs</div></div>
        </div>
        <p class="m-sub" style="margin:10px 0 0">Real counts from this install only — no views, followers or rewards exist here, so none are shown.</p>
        <div class="m-recent-strip" id="m-me-recent"></div>
      </div>
      <div class="m-me-duo">
        <button class="m-card m-tool" id="m-me-tasks" style="text-align:left">
          <h3>🎁 Creation tasks</h3><p class="m-sub">Content Planner tasks — no cash rewards in this app.</p>
        </button>
        <button class="m-card m-tool" id="m-me-inspo" style="text-align:left">
          <h3>💡 Inspiration hub</h3><p class="m-sub">Trending templates on this install.</p>
        </button>
      </div>
      <h2 class="m-title" style="font-size:22px">More</h2>
      <button class="m-more-row" id="m-me-creator"><span class="m-more-ico">💳</span><span>Apply to be a creator<span class="m-more-sub">No creator program — publish a template in the Marketplace instead.</span></span><span class="m-more-chev">›</span></button>
      <button class="m-more-row" id="m-me-events"><span class="m-more-ico">🏆</span><span>Events<span class="m-more-sub">No events in this app.</span></span><span class="m-more-chev">›</span></button>
      <button class="m-more-row" id="m-me-purchased"><span class="m-more-ico">🛒</span><span>Purchased<span class="m-more-sub">Your plan${isUnlimited(u) ? ' is Lifetime Free' : ` is ${u.plan}`} — nothing was purchased.</span></span><span class="m-more-chev">›</span></button>
    </div>`;
    const strip = document.getElementById('m-me-recent');
    strip.innerHTML = recent.length ? recent.slice(0, 4).map((p) => `
      <button class="m-thumb ${thumbClass({ kind: p.type === 'video' ? 'video' : p.type === 'deck' ? 'deck' : 'design' })}" data-m-open-project="${p.id}" title="${esc(p.name)}" style="border:none;cursor:pointer">
        <span class="m-thumb-emoji">${typeIcon(p.type)}</span>
      </button>`).join('') : '<p class="m-sub">No projects yet — your recent work will appear here.</p>';
    strip.querySelectorAll('[data-m-open-project]').forEach((el) => el.addEventListener('click', () => {
      const p = recent.find((x) => String(x.id) === String(el.dataset.mOpenProject));
      if (p) openProjectInEditor(p);
    }));
    document.getElementById('m-me-plan').addEventListener('click', () => openView('subscription'));
    document.getElementById('m-me-renew').addEventListener('click', () => openView('subscription'));
    document.getElementById('m-me-bell').addEventListener('click', () => openView('m-inbox'));
    document.getElementById('m-me-settings').addEventListener('click', () => openView('settings'));
    document.getElementById('m-view-profile').addEventListener('click', () => openView('settings'));
    document.getElementById('m-me-tasks').addEventListener('click', () => openView('planner'));
    document.getElementById('m-me-inspo').addEventListener('click', () => openView('m-templates'));
    document.getElementById('m-me-creator').addEventListener('click', () => openView('marketplace'));
    document.getElementById('m-me-events').addEventListener('click', () => toast('No events in this app — nothing is scheduled.'));
    document.getElementById('m-me-purchased').addEventListener('click', () => openView('subscription'));
  }

  watchResize();
  return { isMobile, mount, viewHome, viewTemplates, viewAILab, viewInbox, viewMe, openAllTools };
})();
