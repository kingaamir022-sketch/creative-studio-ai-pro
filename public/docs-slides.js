'use strict';
/* Docs & Slides frontend (v2.2.3) — Presentations, Documents, Charts,
   Websites, Print. Global entry points used by app.js routing. */
async function viewPresentations(c) { return DocsSlides.presentations(c); }
async function viewDocuments(c) { return DocsSlides.documents(c); }
async function viewCharts(c) { return DocsSlides.charts(c); }
async function viewWebsites(c) { return DocsSlides.websites(c); }
async function viewPrint(c) { return DocsSlides.print(c); }

const DocsSlides = (() => {
  const LAYOUTS = [
    { id: 'title', label: 'Title slide' },
    { id: 'text', label: 'Title + text' },
    { id: 'text-image', label: 'Text + image' },
    { id: 'chart', label: 'Chart slide' },
    { id: 'quiz', label: 'Quiz slide' },
    { id: 'blank', label: 'Blank' },
  ];
  let decks = [];
  let docs = [];
  let media = [];
  let currentDeck = null;
  let currentSlide = 0;
  let currentDoc = null;
  let chartSpec = null;
  let chartSvg = null;
  let sites = [];
  let saveTimer = null;

  async function loadProjects(type) {
    const r = await api(`/api/projects?type=${type}&limit=100`).catch(() => ({ projects: [] }));
    return r.projects || [];
  }
  async function loadMedia() {
    const r = await api('/api/media?kind=image&limit=100').catch(() => ({ media: [] }));
    media = (r.media || []).filter((m) => m.kind === 'image');
  }
  function deckContent(p) { return p.content || {}; }
  function saveStatus(el, msg) { if (el) el.textContent = msg; }

  // --- Presentations ---------------------------------------------------------
  async function presentations(c) {
    decks = await loadProjects('deck');
    await loadMedia();
    c.innerHTML = `<div class="page-head"><div><h2>📊 Presentations</h2><p class="muted">Multi-slide decks — layouts, presenter notes, present mode, export to images, PDF or video.</p></div>
      <div style="display:flex;gap:8px"><button class="btn" id="ds-ai-deck">✨ AI Deck</button><button class="btn btn-primary" id="ds-new-deck">+ New Deck</button></div></div>
      <div id="ds-deck-list" class="grid grid-3"></div>
      <div id="ds-deck-editor"></div>
      <div id="ds-present" class="ds-present" style="display:none"></div>`;
    const list = c.querySelector('#ds-deck-list');
    list.innerHTML = decks.length ? decks.map((d) => `
      <div class="card"><h3>${esc(d.name)}</h3><p class="muted">${(deckContent(d).slides || []).length} slides · ${esc(d.updatedAt || '')}</p>
      <div style="display:flex;gap:6px;margin-top:10px"><button class="btn btn-primary" data-open="${d.id}">Open</button>
      <button class="btn" data-dup="${d.id}">Duplicate</button><button class="btn" data-trash="${d.id}">Trash</button></div></div>`).join('')
      : '<div class="empty"><div class="big">📊</div><p>No decks yet — create your first one.</p></div>';
    list.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openDeck(+b.dataset.open, c)));
    list.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/projects/${b.dataset.dup}/duplicate`, { method: 'POST' }); toast('Deck duplicated.'); renderView(); }));
    list.querySelectorAll('[data-trash]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/projects/${b.dataset.trash}/trash`, { method: 'POST' }); toast('Deck moved to trash.'); renderView(); }));
    c.querySelector('#ds-new-deck').addEventListener('click', async () => {
      const seed = { version: 1, title: 'Untitled Deck', width: 1920, height: 1080, slides: [{ id: `slide_${Date.now().toString(36)}`, layout: 'title', background: { type: 'color', color: '#151d3a' }, notes: '', duration: 5, elements: [
        { id: `layer_${Date.now().toString(36)}a`, type: 'text', name: 'Title', x: 260, y: 380, w: 1400, h: 120, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, role: 'title', text: { text: 'Untitled Deck', fontFamily: 'Poppins', fontSize: 96, fontWeight: 700, fontStyle: 'normal', underline: false, align: 'center', color: '#ffffff', letterSpacing: 0, lineHeight: 1.25, shadow: null, stroke: null, gradient: null } },
        { id: `layer_${Date.now().toString(36)}b`, type: 'text', name: 'Subtitle', x: 460, y: 540, w: 1000, h: 60, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, role: 'subtitle', text: { text: 'A short subtitle for your deck', fontFamily: 'Poppins', fontSize: 40, fontWeight: 400, fontStyle: 'normal', underline: false, align: 'center', color: '#c7d2fe', letterSpacing: 0, lineHeight: 1.25, shadow: null, stroke: null, gradient: null } },
      ] }] };
      const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Untitled Deck', type: 'deck', content: seed }) });
      toast('Deck created.');
      decks = await loadProjects('deck');
      openDeck(p.project.id, c);
    });
    c.querySelector('#ds-ai-deck').addEventListener('click', () => aiDeckDialog(c));
    // v2.4.0 — New Project flow deep link: land straight inside the deck editor.
    if (state.params.deckId) { const id = +state.params.deckId; state.params.deckId = null; openDeck(id, c); }
  }

  async function openDeck(id, c) {
    const p = await api(`/api/projects/${id}`);
    currentDeck = p.project;
    currentSlide = 0;
    renderDeckEditor(c);
  }

  // Client mirror of the server's blankSlide templates (src/docs-slides.js)
  // so "add slide" creates an editable slide, not an empty one.
  function blankSlideClient(layout) {
    const uid = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const txt = (name, role, x, y, w, h, text, fontSize, opts = {}) => ({ id: uid('layer'), type: 'text', name, x, y, w, h, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, role, text: { text, fontFamily: 'Poppins', fontSize, fontWeight: opts.weight || 700, fontStyle: 'normal', underline: false, align: opts.align || 'left', color: opts.color || '#ffffff', letterSpacing: 0, lineHeight: 1.25, shadow: null, stroke: null, gradient: null } });
    const shp = (name, x, y, w, h, fill) => ({ id: uid('layer'), type: 'shape', name, x, y, w, h, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, shape: { kind: 'rect', fill, stroke: '', strokeWidth: 0, radius: 0, shadow: null } });
    const slide = { id: uid('slide'), layout, background: { type: 'color', color: '#151d3a' }, notes: '', duration: 5, elements: [] };
    if (layout === 'title') {
      slide.elements.push(txt('Title', 'title', 260, 380, 1400, 120, 'Slide Title', 96, { align: 'center' }));
      slide.elements.push(txt('Subtitle', 'subtitle', 460, 540, 1000, 60, 'A short subtitle', 40, { weight: 400, align: 'center', color: '#c7d2fe' }));
    } else if (layout === 'text') {
      slide.elements.push(txt('Title', 'title', 120, 90, 1680, 100, 'Slide Title', 64));
      slide.elements.push(shp('Accent', 120, 210, 160, 8, '#7c5cff'));
      slide.elements.push(txt('Body', 'body', 120, 260, 1680, 700, 'Write your points here.', 36, { weight: 400 }));
    } else if (layout === 'text-image') {
      slide.elements.push(txt('Title', 'title', 120, 90, 900, 100, 'Slide Title', 64));
      slide.elements.push(txt('Body', 'body', 120, 260, 900, 700, 'Text on the left, image on the right.', 36, { weight: 400 }));
      slide.elements.push(shp('Image placeholder', 1080, 220, 720, 640, '#24304f'));
      slide.elements.push(txt('Placeholder label', 'body', 1080, 500, 720, 60, 'Image goes here', 28, { weight: 400, align: 'center', color: '#94a3b8' }));
    } else if (layout === 'chart') {
      slide.elements.push(txt('Title', 'title', 120, 90, 1680, 100, 'Chart Title', 64));
      slide.elements.push({ id: uid('layer'), type: 'chart', name: 'Chart', x: 160, y: 240, w: 1600, h: 720, rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null, chart: { type: 'bar', title: '', legend: true, showValues: true, labels: ['Jan', 'Feb', 'Mar', 'Apr'], datasets: [{ label: 'Series 1', values: [12, 19, 8, 15], color: '#7c5cff' }] } });
    } else if (layout === 'quiz') {
      slide.elements.push(txt('Question', 'question', 120, 90, 1680, 120, 'Question goes here?', 56));
      ['Option A', 'Option B', 'Option C', 'Option D'].forEach((name, i) => {
        const y = 260 + i * 170;
        slide.elements.push(shp(`${name} box`, 120, y, 1680, 140, i === 0 ? '#16a34a' : '#24304f'));
        slide.elements.push(txt(name, 'option', 180, y + 40, 1560, 60, `${String.fromCharCode(65 + i)}. ${name}`, 40, { weight: 500 }));
      });
    }
    return slide;
  }

  // v2.5.0 #19: entrance animations — an element with entrance {type,
  // duration, delay} animates in (CSS) in the editor preview, the present
  // view and thumbnails. The MP4 export keeps the slide's static image and
  // animates BETWEEN slides with a real xfade transition instead.
  function entranceStyle(e) {
    const en = e && e.entrance;
    if (!en || !en.type || en.type === 'none') return '';
    const dur = Math.max(0.1, Math.min(5, Number(en.duration) || 0.6));
    const delay = Math.max(0, Math.min(10, Number(en.delay) || 0));
    return `animation:ds-ent-${en.type} ${dur}s ease ${delay}s both;`;
  }

  function slideEl(slide) {
    const els = slide.elements || [];
    return els.map((e) => {
      if (e.type === 'text') return `<div class="ds-slide-el" style="left:${(e.x / 19.2).toFixed(1)}%;top:${(e.y / 10.8).toFixed(1)}%;width:${(e.w / 19.2).toFixed(1)}%;font-size:${Math.max(9, Math.round((e.text.fontSize || 40) / 3.2))}px;color:${esc(e.text.color || '#fff')};text-align:${e.text.align || 'left'};${entranceStyle(e)}">${esc(e.text.text || '')}</div>`;
      if (e.type === 'shape') return `<div class="ds-slide-el" style="left:${(e.x / 19.2).toFixed(1)}%;top:${(e.y / 10.8).toFixed(1)}%;width:${(e.w / 19.2).toFixed(1)}%;height:${(e.h / 10.8).toFixed(1)}%;background:${esc(e.shape.fill || '#7c5cff')};${entranceStyle(e)}"></div>`;
      if (e.type === 'chart') return `<div class="ds-slide-el ds-chart-ph" style="left:${(e.x / 19.2).toFixed(1)}%;top:${(e.y / 10.8).toFixed(1)}%;width:${(e.w / 19.2).toFixed(1)}%;height:${(e.h / 10.8).toFixed(1)}%;${entranceStyle(e)}">📈 ${esc(e.chart.type)} chart</div>`;
      if (e.type === 'image') return `<div class="ds-slide-el" style="left:${(e.x / 19.2).toFixed(1)}%;top:${(e.y / 10.8).toFixed(1)}%;width:${(e.w / 19.2).toFixed(1)}%;height:${(e.h / 10.8).toFixed(1)}%;background:#24304f;display:flex;align-items:center;justify-content:center;color:#94a3b8;${entranceStyle(e)}">🖼️ image</div>`;
      return '';
    }).join('');
  }

  function renderDeckEditor(c) {
    const ed = c.querySelector('#ds-deck-editor');
    if (!ed || !currentDeck) return;
    const deck = deckContent(currentDeck);
    const slides = deck.slides || [];
    const slide = slides[currentSlide];
    ed.innerHTML = `<div class="card" style="margin-top:16px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="ds-deck-title" class="input" style="flex:1;min-width:200px" value="${esc(deck.title || currentDeck.name)}">
        <span class="muted" id="ds-save-state">Saved</span>
        <button class="btn" id="ds-present-btn">▶ Present</button>
        <button class="btn" id="ds-fit-btn">Fit check</button>
        <button class="btn" id="ds-exp-images">Images (ZIP)</button>
        <button class="btn" id="ds-exp-pdf">PDF</button>
        <button class="btn" id="ds-exp-video">Video</button>
      </div>
      <div id="ds-fit-report" style="margin-top:10px"></div>
      <div class="ds-deck-wrap">
        <div class="ds-slide-list">${slides.map((s, i) => `<div class="ds-slide-thumb ${i === currentSlide ? 'active' : ''}" data-slide="${i}">
          <div class="ds-slide-mini" style="background:${esc((s.background && s.background.color) || '#151d3a')}">${slideEl(s)}</div>
          <div class="muted" style="font-size:12px;margin-top:4px">${i + 1}. ${esc(s.layout)}</div>
          <div style="display:flex;gap:4px;margin-top:4px">
            <button class="btn btn-xs" data-move="-1" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn btn-xs" data-move="1" data-i="${i}" ${i === slides.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn btn-xs" data-dupslide="${i}">⧉</button>
            <button class="btn btn-xs" data-delslide="${i}">🗑</button>
          </div></div>`).join('')}
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${LAYOUTS.map((l) => `<button class="btn btn-xs" data-addlayout="${l.id}">+ ${l.label}</button>`).join('')}</div>
        </div>
        <div class="ds-slide-main">
          ${slide ? `<div class="ds-slide-canvas" style="background:${esc((slide.background && slide.background.color) || '#151d3a')}">${slideEl(slide)}</div>
          <div style="margin-top:10px"><label class="muted">Speaker notes</label>
          <textarea id="ds-notes" class="input" rows="2" placeholder="Notes for this slide…">${esc(slide.notes || '')}</textarea></div>
          <div style="margin-top:10px"><label class="muted">Slide duration in video (seconds)</label>
          <input id="ds-duration" class="input" type="number" min="1" max="60" value="${slide.duration || 5}" style="width:90px"></div>
          <div style="margin-top:10px"><label class="muted">Transition into this slide (video export — real FFmpeg xfade)</label>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <select id="ds-transition" class="input" style="width:150px">${['none', 'fade', 'slide', 'wipe', 'zoom'].map((t) => `<option value="${t}" ${((slide.transition && slide.transition.type) || 'fade') === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <label class="muted">Duration <input id="ds-transition-dur" class="input" type="number" min="0.2" max="5" step="0.1" value="${(slide.transition && slide.transition.duration) || 0.5}" style="width:70px"> s</label>
          <span class="muted" style="font-size:12px">Fade→fade, Slide→slideleft, Wipe→wipeleft, Zoom→circleopen.</span></div></div>
          <div style="margin-top:10px"><label class="muted">Slide text — click a text layer to edit it:</label>
          <div id="ds-text-layers">${(slide.elements || []).filter((e) => e.type === 'text').map((e, i) => `<div style="margin-top:6px"><div class="muted" style="font-size:12px">${esc(e.name || 'Text')} (${esc(e.role || 'body')})</div><textarea class="input ds-text-edit" data-layer="${e.id}" rows="2">${esc(e.text.text || '')}</textarea><div style="display:flex;gap:6px;align-items:center;margin-top:4px"><label class="muted" style="font-size:12px">Entrance</label><select class="input ds-entrance" data-layer="${e.id}" style="width:130px">${['none', 'fade', 'slide', 'zoom', 'wipe'].map((t) => `<option value="${t}" ${((e.entrance && e.entrance.type) || 'none') === t ? 'selected' : ''}>${t}</option>`).join('')}</select><span class="muted" style="font-size:12px">animates in the preview &amp; present view (0.6s).</span></div></div>`).join('') || '<p class="muted">No text layers on this slide.</p>'}</div></div>`
          : '<p class="muted">This deck has no slides yet — add one from the layout buttons.</p>'}
        </div>
      </div></div>`;
    const save = async () => {
      saveStatus(ed.querySelector('#ds-save-state'), 'Saving…');
      const r = await api(`/api/projects/${currentDeck.id}`, { method: 'PATCH', body: JSON.stringify({ name: ed.querySelector('#ds-deck-title').value.trim() || currentDeck.name, content: deckContent(currentDeck) }) });
      currentDeck = r.project;
      saveStatus(ed.querySelector('#ds-save-state'), 'Saved ✓');
    };
    const debounceSave = () => { clearTimeout(saveTimer); saveStatus(ed.querySelector('#ds-save-state'), 'Saving…'); saveTimer = setTimeout(save, 800); };
    ed.querySelector('#ds-deck-title').addEventListener('input', (e) => { deck.title = e.target.value; debounceSave(); });
    ed.querySelectorAll('[data-slide]').forEach((t) => t.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      currentSlide = +t.dataset.slide; renderDeckEditor(c);
    }));
    ed.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const i = +b.dataset.i, dir = +b.dataset.move;
      const arr = deck.slides; const [s] = arr.splice(i, 1); arr.splice(i + dir, 0, s);
      currentSlide = i + dir; await save(); renderDeckEditor(c);
    }));
    ed.querySelectorAll('[data-dupslide]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const copy = JSON.parse(JSON.stringify(deck.slides[+b.dataset.dupslide]));
      copy.id = `slide_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      (copy.elements || []).forEach((el) => { el.id = `layer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`; });
      deck.slides.splice(+b.dataset.dupslide + 1, 0, copy);
      await save(); renderDeckEditor(c);
    }));
    ed.querySelectorAll('[data-delslide]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (deck.slides.length <= 1) { toast('A deck needs at least one slide.', true); return; }
      deck.slides.splice(+b.dataset.delslide, 1);
      currentSlide = Math.max(0, currentSlide - 1); await save(); renderDeckEditor(c);
    }));
    ed.querySelectorAll('[data-addlayout]').forEach((b) => b.addEventListener('click', async () => {
      const layout = b.dataset.addlayout;
      const slide = blankSlideClient(layout);
      deck.slides.push(slide);
      currentSlide = deck.slides.length - 1;
      await save(); renderDeckEditor(c);
    }));
    const notes = ed.querySelector('#ds-notes');
    if (notes) notes.addEventListener('input', () => { slide.notes = notes.value; debounceSave(); });
    const dur = ed.querySelector('#ds-duration');
    if (dur) dur.addEventListener('change', () => { slide.duration = Math.max(1, Math.min(60, +dur.value || 5)); debounceSave(); });
    // v2.5.0 #19: per-slide transition (xfade in the MP4 export) + per-text
    // entrance animation (CSS in preview/present).
    const trSel = ed.querySelector('#ds-transition');
    const trDur = ed.querySelector('#ds-transition-dur');
    const saveTransition = () => {
      slide.transition = { type: trSel ? trSel.value : 'fade', duration: Math.max(0.2, Math.min(5, trDur ? (+trDur.value || 0.5) : 0.5)) };
      debounceSave();
    };
    if (trSel) trSel.addEventListener('change', saveTransition);
    if (trDur) trDur.addEventListener('change', saveTransition);
    ed.querySelectorAll('.ds-entrance').forEach((s) => s.addEventListener('change', () => {
      const el = (slide.elements || []).find((e) => e.id === s.dataset.layer);
      if (el) { el.entrance = { type: s.value, duration: 0.6, delay: 0 }; debounceSave(); renderDeckEditor(c); }
    }));
    ed.querySelectorAll('.ds-text-edit').forEach((t) => t.addEventListener('input', () => {
      const el = (slide.elements || []).find((e) => e.id === t.dataset.layer);
      if (el) { el.text.text = t.value; debounceSave(); }
    }));
    ed.querySelector('#ds-fit-btn').addEventListener('click', async () => {
      const rep = await api('/api/docs-slides/decks/validate', { method: 'POST', body: JSON.stringify({ deck: deckContent(currentDeck), applyUniformFonts: true }) });
      const box = ed.querySelector('#ds-fit-report');
      if (rep.needsAttention && rep.needsAttention.length) {
        box.innerHTML = `<div class="alert warn">⚠️ Needs attention (${rep.needsAttention.length}):<ul>${rep.needsAttention.map((n) => `<li>Slide ${deck.slides.findIndex((s) => s.id === n.slideId) + 1} — ${esc(n.name)}: ${esc(n.reason)} ${n.suggestedText ? `Try: “${esc(n.suggestedText)}”` : ''}</li>`).join('')}</ul></div>`;
      } else {
        box.innerHTML = `<div class="alert ok">✓ Every slide fits — text is inside its box.${rep.batchFonts && rep.batchFonts.question ? ` Quiz fonts: question ${rep.batchFonts.question}px, options ${rep.batchFonts.option}px (uniform across the deck).` : ''}</div>`;
      }
      if (rep.appliedUniformFonts) { currentDeck.content = rep.deck; await save(); }
    });
    ed.querySelector('#ds-present-btn').addEventListener('click', () => presentDeck(c));
    ed.querySelector('#ds-exp-images').addEventListener('click', () => downloadExport(`/api/docs-slides/decks/${currentDeck.id}/export/images`, 'slides.zip'));
    ed.querySelector('#ds-exp-pdf').addEventListener('click', () => downloadExport(`/api/docs-slides/decks/${currentDeck.id}/export/pdf`, 'deck.pdf'));
    ed.querySelector('#ds-exp-video').addEventListener('click', async () => {
      const r = await api(`/api/docs-slides/decks/${currentDeck.id}/export/video`, { method: 'POST', body: JSON.stringify({ secondsPerSlide: (slide && slide.duration) || 5, fps: 30 }) });
      toast(`Video render queued (job #${r.job.id}) — check the Export Center for the MP4.`);
    });
  }

  async function downloadExport(url, fallbackName) {
    const res = await fetch(url, { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) { const j = await res.json().catch(() => ({})); toast(j.error || 'Export failed.', true); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    a.download = m ? m[1] : fallbackName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function presentDeck(c) {
    const deck = deckContent(currentDeck);
    const box = c.querySelector('#ds-present');
    let i = currentSlide;
    const show = (n) => {
      i = Math.max(0, Math.min(deck.slides.length - 1, n));
      const s = deck.slides[i];
      box.innerHTML = `<div class="ds-present-slide" style="background:${esc((s.background && s.background.color) || '#151d3a')}">${slideEl(s)}
        <div class="ds-present-bar"><button class="btn" id="ds-p-prev">←</button><span>${i + 1} / ${deck.slides.length}</span><button class="btn" id="ds-p-next">→</button><button class="btn" id="ds-p-exit">✕ Exit</button></div>
        ${s.notes ? `<div class="ds-present-notes">Notes: ${esc(s.notes)}</div>` : ''}</div>`;
      box.querySelector('#ds-p-prev').addEventListener('click', () => show(i - 1));
      box.querySelector('#ds-p-next').addEventListener('click', () => show(i + 1));
      box.querySelector('#ds-p-exit').addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; });
    };
    box.style.display = 'block';
    show(i);
    box.onkeydown = (e) => { if (e.key === 'ArrowRight') show(i + 1); if (e.key === 'ArrowLeft') show(i - 1); if (e.key === 'Escape') { box.style.display = 'none'; box.innerHTML = ''; } };
    box.tabIndex = 0; box.focus();
  }

  function aiDeckDialog(c) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    wrap.innerHTML = `<div class="modal"><h3>✨ AI Deck</h3><p class="muted">The LLM writes the outline; every slide is a real editable deck (never a flattened image). Needs an LLM key — Gemini's free key works.</p>
      <label class="muted">Topic</label><input id="ds-ai-topic" class="input" placeholder="e.g. Healthy breakfast ideas for kids">
      <label class="muted">Slides</label><input id="ds-ai-count" class="input" type="number" min="2" max="20" value="6" style="width:90px">
      <label class="muted">Style</label><input id="ds-ai-style" class="input" value="professional">
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" id="ds-ai-go">Generate deck</button><button class="btn" id="ds-ai-cancel">Cancel</button></div>
      <div id="ds-ai-status" style="margin-top:10px"></div></div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#ds-ai-cancel').addEventListener('click', () => wrap.remove());
    wrap.querySelector('#ds-ai-go').addEventListener('click', async () => {
      const st = wrap.querySelector('#ds-ai-status');
      st.textContent = 'Generating…';
      try {
        const job = await api('/api/docs-slides/decks/generate', { method: 'POST', body: JSON.stringify({ topic: wrap.querySelector('#ds-ai-topic').value, slideCount: +wrap.querySelector('#ds-ai-count').value || 6, style: wrap.querySelector('#ds-ai-style').value }) });
        const poll = async () => {
          const j = await api(`/api/ai/jobs/${job.job.id}`);
          if (j.job.status === 'done') {
            st.textContent = 'Done — opening your deck.';
            wrap.remove();
            decks = await loadProjects('deck');
            openDeck(j.job.result.projectId, c);
          } else if (j.job.status === 'failed' || j.job.status === 'cancelled') {
            st.textContent = `Failed: ${j.job.error || 'cancelled'}`;
          } else setTimeout(poll, 1500);
        };
        poll();
      } catch (e) { st.textContent = e.message; }
    });
  }

  // --- Documents ---------------------------------------------------------------
  async function documents(c) {
    docs = await loadProjects('doc');
    await loadMedia();
    c.innerHTML = `<div class="page-head"><div><h2>📝 Documents</h2><p class="muted">Rich-text documents — headings, lists, tables, images, charts. Autosaves as you type.</p></div>
      <button class="btn btn-primary" id="ds-new-doc">+ New Document</button></div>
      <div id="ds-doc-list" class="grid grid-3"></div><div id="ds-doc-editor"></div>`;
    const list = c.querySelector('#ds-doc-list');
    list.innerHTML = docs.length ? docs.map((d) => `
      <div class="card"><h3>${esc(d.name)}</h3><p class="muted">${((deckContent(d).blocks || []).length)} blocks · ${esc(d.updatedAt || '')}</p>
      <div style="display:flex;gap:6px;margin-top:10px"><button class="btn btn-primary" data-open="${d.id}">Open</button>
      <button class="btn" data-dup="${d.id}">Duplicate</button><button class="btn" data-trash="${d.id}">Trash</button></div></div>`).join('')
      : '<div class="empty"><div class="big">📝</div><p>No documents yet — create your first one.</p></div>';
    list.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openDoc(+b.dataset.open, c)));
    list.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/projects/${b.dataset.dup}/duplicate`, { method: 'POST' }); toast('Document duplicated.'); renderView(); }));
    list.querySelectorAll('[data-trash]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/projects/${b.dataset.trash}/trash`, { method: 'POST' }); toast('Document moved to trash.'); renderView(); }));
    c.querySelector('#ds-new-doc').addEventListener('click', async () => {
      const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Untitled Document', type: 'doc', content: { version: 1, title: 'Untitled Document', blocks: [{ id: `block_${Date.now().toString(36)}`, type: 'heading', level: 1, text: 'Untitled Document' }, { id: `block_${Date.now().toString(36)}x`, type: 'paragraph', text: 'Start writing here.' }] } }) });
      toast('Document created.');
      docs = await loadProjects('doc');
      openDoc(p.project.id, c);
    });
    // v2.4.0 — New Project flow deep link: land straight inside the document editor.
    if (state.params.docId) { const id = +state.params.docId; state.params.docId = null; openDoc(id, c); }
  }

  async function openDoc(id, c) {
    const p = await api(`/api/projects/${id}`);
    currentDoc = p.project;
    renderDocEditor(c);
  }

  function blockEditorHtml(b, i) {
    const head = `<div class="ds-block-head"><span class="muted">#${i + 1} · ${b.type}</span><span style="display:flex;gap:4px">
      <button class="btn btn-xs" data-bup="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn btn-xs" data-bdown="${i}">↓</button>
      <button class="btn btn-xs" data-bdel="${i}">🗑</button></span></div>`;
    if (b.type === 'heading') return `${head}<input class="input ds-b-text" data-i="${i}" value="${esc(b.text)}"><select class="input ds-b-level" data-i="${i}">${[1, 2, 3].map((l) => `<option value="${l}" ${b.level === l ? 'selected' : ''}>Heading ${l}</option>`).join('')}</select>`;
    if (b.type === 'paragraph' || b.type === 'quote') return `${head}<textarea class="input ds-b-text" data-i="${i}" rows="3">${esc(b.text)}</textarea>`;
    if (b.type === 'list') return `${head}<select class="input ds-b-style" data-i="${i}"><option value="bullet" ${b.style === 'bullet' ? 'selected' : ''}>Bulleted</option><option value="number" ${b.style === 'number' ? 'selected' : ''}>Numbered</option></select><textarea class="input ds-b-items" data-i="${i}" rows="${Math.max(2, b.items.length)}">${esc(b.items.join('\n'))}</textarea><p class="muted" style="font-size:12px">One item per line.</p>`;
    if (b.type === 'table') return `${head}<input class="input ds-b-headers" data-i="${i}" value="${esc(b.headers.join(', '))}"><p class="muted" style="font-size:12px">Headers, comma-separated.</p><textarea class="input ds-b-rows" data-i="${i}" rows="${Math.max(2, b.rows.length)}">${esc(b.rows.map((r) => r.join(', ')).join('\n'))}</textarea><p class="muted" style="font-size:12px">One row per line, cells comma-separated.</p>`;
    if (b.type === 'image') return `${head}<select class="input ds-b-media" data-i="${i}"><option value="">— Choose an image —</option>${media.map((m) => `<option value="${m.id}" ${b.mediaId === m.id ? 'selected' : ''}>${esc(m.originalName)}</option>`).join('')}</select><input class="input ds-b-caption" data-i="${i}" placeholder="Caption (optional)" value="${esc(b.caption || '')}">`;
    if (b.type === 'chart') return `${head}<p class="muted">Chart: ${esc(b.chart.type)} — ${esc((b.chart.labels || []).join(', '))}. Edit it in the Charts view, then re-add it here.</p>`;
    if (b.type === 'divider') return `${head}<hr>`;
    return head;
  }

  function renderDocEditor(c) {
    const ed = c.querySelector('#ds-doc-editor');
    if (!ed || !currentDoc) return;
    const doc = deckContent(currentDoc);
    ed.innerHTML = `<div class="card" style="margin-top:16px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="ds-doc-title" class="input" style="flex:1;min-width:200px" value="${esc(doc.title || currentDoc.name)}">
        <span class="muted" id="ds-doc-save">Saved</span>
        <button class="btn" id="ds-doc-printview">🖨 Print view</button>
        <button class="btn" id="ds-doc-html">HTML</button>
        <button class="btn" id="ds-doc-docx">DOCX</button>
        <button class="btn" id="ds-doc-pdf">PDF</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">
        ${[['heading', '+ Heading'], ['paragraph', '+ Paragraph'], ['list', '+ List'], ['quote', '+ Quote'], ['table', '+ Table'], ['image', '+ Image'], ['divider', '+ Divider']].map(([t, l]) => `<button class="btn btn-xs" data-addblock="${t}">${l}</button>`).join('')}
      </div>
      <div id="ds-blocks" style="margin-top:12px">${(doc.blocks || []).map((b, i) => `<div class="ds-block">${blockEditorHtml(b, i)}</div>`).join('')}</div></div>`;
    const save = async () => {
      saveStatus(ed.querySelector('#ds-doc-save'), 'Saving…');
      const r = await api(`/api/projects/${currentDoc.id}`, { method: 'PATCH', body: JSON.stringify({ name: ed.querySelector('#ds-doc-title').value.trim() || currentDoc.name, content: deckContent(currentDoc) }) });
      currentDoc = r.project;
      saveStatus(ed.querySelector('#ds-doc-save'), 'Saved ✓');
    };
    const debounceSave = () => { clearTimeout(saveTimer); saveStatus(ed.querySelector('#ds-doc-save'), 'Saving…'); saveTimer = setTimeout(save, 800); };
    ed.querySelector('#ds-doc-title').addEventListener('input', (e) => { doc.title = e.target.value; debounceSave(); });
    const newBlock = (type) => {
      const id = `block_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
      const base = { id, type };
      if (type === 'heading') return { ...base, level: 2, text: 'New heading' };
      if (type === 'paragraph') return { ...base, text: '' };
      if (type === 'quote') return { ...base, text: '' };
      if (type === 'list') return { ...base, style: 'bullet', items: ['First item'] };
      if (type === 'table') return { ...base, headers: ['Column 1', 'Column 2'], rows: [['', '']] };
      if (type === 'image') return { ...base, mediaId: null, caption: '' };
      return base;
    };
    ed.querySelectorAll('[data-addblock]').forEach((b) => b.addEventListener('click', async () => {
      doc.blocks.push(newBlock(b.dataset.addblock));
      await save(); renderDocEditor(c);
    }));
    ed.querySelectorAll('[data-bup]').forEach((b) => b.addEventListener('click', async () => { const i = +b.dataset.bup; const [x] = doc.blocks.splice(i, 1); doc.blocks.splice(i - 1, 0, x); await save(); renderDocEditor(c); }));
    ed.querySelectorAll('[data-bdown]').forEach((b) => b.addEventListener('click', async () => { const i = +b.dataset.bdown; if (i >= doc.blocks.length - 1) return; const [x] = doc.blocks.splice(i, 1); doc.blocks.splice(i + 1, 0, x); await save(); renderDocEditor(c); }));
    ed.querySelectorAll('[data-bdel]').forEach((b) => b.addEventListener('click', async () => { doc.blocks.splice(+b.dataset.bdel, 1); await save(); renderDocEditor(c); }));
    ed.querySelectorAll('.ds-b-text').forEach((t) => t.addEventListener('input', () => { doc.blocks[+t.dataset.i].text = t.value; debounceSave(); }));
    ed.querySelectorAll('.ds-b-level').forEach((s) => s.addEventListener('change', () => { doc.blocks[+s.dataset.i].level = +s.value; debounceSave(); }));
    ed.querySelectorAll('.ds-b-style').forEach((s) => s.addEventListener('change', () => { doc.blocks[+s.dataset.i].style = s.value; debounceSave(); }));
    ed.querySelectorAll('.ds-b-items').forEach((t) => t.addEventListener('input', () => { doc.blocks[+t.dataset.i].items = t.value.split('\n'); debounceSave(); }));
    ed.querySelectorAll('.ds-b-headers').forEach((t) => t.addEventListener('input', () => { doc.blocks[+t.dataset.i].headers = t.value.split(',').map((x) => x.trim()); debounceSave(); }));
    ed.querySelectorAll('.ds-b-rows').forEach((t) => t.addEventListener('input', () => { doc.blocks[+t.dataset.i].rows = t.value.split('\n').filter((x) => x.trim()).map((r) => r.split(',').map((x) => x.trim())); debounceSave(); }));
    ed.querySelectorAll('.ds-b-media').forEach((s) => s.addEventListener('change', () => { doc.blocks[+s.dataset.i].mediaId = s.value ? +s.value : null; debounceSave(); }));
    ed.querySelectorAll('.ds-b-caption').forEach((t) => t.addEventListener('input', () => { doc.blocks[+t.dataset.i].caption = t.value; debounceSave(); }));
    ed.querySelector('#ds-doc-printview').addEventListener('click', async () => {
      const r = await fetch(`/api/docs-slides/docs/${currentDoc.id}/export/html`, { method: 'POST', credentials: 'same-origin' });
      const html = await r.text();
      const w = window.open('', '_blank');
      w.document.write(html);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 400);
    });
    ed.querySelector('#ds-doc-html').addEventListener('click', () => downloadExport(`/api/docs-slides/docs/${currentDoc.id}/export/html`, 'document.html'));
    ed.querySelector('#ds-doc-docx').addEventListener('click', () => downloadExport(`/api/docs-slides/docs/${currentDoc.id}/export/docx`, 'document.docx'));
    ed.querySelector('#ds-doc-pdf').addEventListener('click', () => downloadExport(`/api/docs-slides/docs/${currentDoc.id}/export/pdf`, 'document.pdf'));
  }

  // --- Charts ------------------------------------------------------------------
  async function charts(c) {
    chartSpec = chartSpec || { type: 'bar', title: 'My Chart', labels: ['Jan', 'Feb', 'Mar', 'Apr'], datasets: [{ label: 'Series 1', values: [12, 19, 8, 15] }] };
    c.innerHTML = `<div class="page-head"><div><h2>📈 Charts</h2><p class="muted">Bar, line, pie and doughnut charts from pasted CSV or a manual table — duplicate rows are skipped, never doubled. Save to the Media Library and use the image anywhere.</p></div></div>
    <div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select id="ds-chart-type" class="input" style="width:160px">${['bar', 'line', 'pie', 'doughnut'].map((t) => `<option ${chartSpec.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <input id="ds-chart-title" class="input" style="flex:1;min-width:180px" value="${esc(chartSpec.title || '')}" placeholder="Chart title">
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ds-chart-values" ${chartSpec.showValues !== false ? 'checked' : ''}> Values</label>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ds-chart-legend" ${chartSpec.legend !== false ? 'checked' : ''}> Legend</label>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px">
      <div><label class="muted">Paste CSV (header row + one row per label)</label>
      <textarea id="ds-chart-csv" class="input" rows="7" placeholder="Month,Sales,Costs&#10;Jan,10,4&#10;Feb,20,8"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-primary" id="ds-chart-load-csv">Load CSV</button><button class="btn" id="ds-chart-manual">Use manual table</button></div>
      <div id="ds-chart-parse" style="margin-top:8px"></div>
      <div id="ds-chart-table" style="margin-top:10px"></div></div>
      <div><label class="muted">Preview</label><div id="ds-chart-preview" class="ds-chart-preview">${chartSvg || '<p class="muted">Render the chart to preview it.</p>'}</div>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-primary" id="ds-chart-render">Render &amp; save to Library</button></div>
      <div id="ds-chart-result" style="margin-top:8px"></div></div>
    </div></div>`;
    const typeSel = c.querySelector('#ds-chart-type');
    const titleIn = c.querySelector('#ds-chart-title');
    typeSel.addEventListener('change', () => { chartSpec.type = typeSel.value; if (chartSpec.type === 'pie' || chartSpec.type === 'doughnut') chartSpec.datasets = chartSpec.datasets.slice(0, 1); });
    titleIn.addEventListener('input', () => { chartSpec.title = titleIn.value; });
    c.querySelector('#ds-chart-values').addEventListener('change', (e) => { chartSpec.showValues = e.target.checked; });
    c.querySelector('#ds-chart-legend').addEventListener('change', (e) => { chartSpec.legend = e.target.checked; });
    const renderTable = () => {
      const t = c.querySelector('#ds-chart-table');
      t.innerHTML = `<table class="ds-table"><thead><tr><th>Label</th>${chartSpec.datasets.map((d, j) => `<th><input class="input ds-series-name" data-j="${j}" value="${esc(d.label)}"></th>`).join('')}</tr></thead>
      <tbody>${chartSpec.labels.map((l, i) => `<tr><td><input class="input ds-label" data-i="${i}" value="${esc(l)}"></td>${chartSpec.datasets.map((d, j) => `<td><input class="input ds-val" data-i="${i}" data-j="${j}" type="number" step="any" value="${d.values[i]}"></td>`).join('')}</tr>`).join('')}</tbody></table>
      <div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-xs" id="ds-add-row">+ Row</button><button class="btn btn-xs" id="ds-add-series">+ Series</button><button class="btn btn-xs" id="ds-del-row">− Last row</button></div>`;
      t.querySelectorAll('.ds-label').forEach((inp) => inp.addEventListener('input', () => { chartSpec.labels[+inp.dataset.i] = inp.value; }));
      t.querySelectorAll('.ds-series-name').forEach((inp) => inp.addEventListener('input', () => { chartSpec.datasets[+inp.dataset.j].label = inp.value; }));
      t.querySelectorAll('.ds-val').forEach((inp) => inp.addEventListener('input', () => { chartSpec.datasets[+inp.dataset.j].values[+inp.dataset.i] = parseFloat(inp.value) || 0; }));
      t.querySelector('#ds-add-row').addEventListener('click', () => { chartSpec.labels.push(`Label ${chartSpec.labels.length + 1}`); chartSpec.datasets.forEach((d) => d.values.push(0)); renderTable(); });
      t.querySelector('#ds-add-series').addEventListener('click', () => { if (chartSpec.type === 'pie' || chartSpec.type === 'doughnut') { toast('Pie and doughnut charts take one series.', true); return; } chartSpec.datasets.push({ label: `Series ${chartSpec.datasets.length + 1}`, values: chartSpec.labels.map(() => 0) }); renderTable(); });
      t.querySelector('#ds-del-row').addEventListener('click', () => { if (chartSpec.labels.length <= 1) return; chartSpec.labels.pop(); chartSpec.datasets.forEach((d) => d.values.pop()); renderTable(); });
    };
    renderTable();
    c.querySelector('#ds-chart-load-csv').addEventListener('click', async () => {
      const csv = c.querySelector('#ds-chart-csv').value;
      const out = await api('/api/docs-slides/charts/parse', { method: 'POST', body: JSON.stringify({ csv }) }).catch((e) => ({ error: e.message }));
      const box = c.querySelector('#ds-chart-parse');
      if (out.error) { box.innerHTML = `<div class="alert warn">${esc(out.error)}</div>`; return; }
      chartSpec.labels = out.labels;
      chartSpec.datasets = out.datasets;
      box.innerHTML = `<div class="alert ok">Loaded ${out.totalRows} rows${out.skipped ? ` — ${out.skipped} duplicate row(s) skipped (rows ${out.skippedRows.join(', ')}).` : ', no duplicates.'}</div>`;
      renderTable();
    });
    c.querySelector('#ds-chart-manual').addEventListener('click', async () => {
      const out = await api('/api/docs-slides/charts/parse', { method: 'POST', body: JSON.stringify({ labels: chartSpec.labels, datasets: chartSpec.datasets }) }).catch((e) => ({ error: e.message }));
      const box = c.querySelector('#ds-chart-parse');
      if (out.error) { box.innerHTML = `<div class="alert warn">${esc(out.error)}</div>`; return; }
      chartSpec.labels = out.labels; chartSpec.datasets = out.datasets;
      box.innerHTML = `<div class="alert ok">Table checked — ${out.skipped ? `${out.skipped} duplicate row(s) skipped.` : 'no duplicates.'}</div>`;
      renderTable();
    });
    c.querySelector('#ds-chart-render').addEventListener('click', async () => {
      const box = c.querySelector('#ds-chart-result');
      box.textContent = 'Rendering…';
      try {
        const r = await api('/api/docs-slides/charts/render', { method: 'POST', body: JSON.stringify({ spec: chartSpec, name: `${chartSpec.title || 'chart'}.png` }) });
        chartSvg = r.svg;
        c.querySelector('#ds-chart-preview').innerHTML = r.svg;
        box.innerHTML = r.media ? `<div class="alert ok">Saved to Media Library as “${esc(r.media.originalName)}” — use it as an image in any design, deck or document.</div>` : '<div class="alert ok">Rendered.</div>';
      } catch (e) { box.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
    });
  }

  // --- Websites ------------------------------------------------------------------
  async function websites(c) {
    const r = await api('/api/docs-slides/websites').catch(() => ({ sites: [] }));
    sites = r.sites || [];
    const projects = await api('/api/projects?limit=100').catch(() => ({ projects: [] }));
    const publishable = (projects.projects || []).filter((p) => ['design', 'deck', 'doc'].includes(p.type));
    c.innerHTML = `<div class="page-head"><div><h2>🌐 Websites</h2><p class="muted">Publish a design, deck or document as a static website — hosted locally by this app under /sites/. No custom domain, no external host.</p></div></div>
    <div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select id="ds-site-project" class="input" style="flex:1;min-width:220px">${publishable.map((p) => `<option value="${p.id}">${esc(p.name)} (${p.type})</option>`).join('') || '<option value="">No publishable projects yet</option>'}</select>
      <button class="btn btn-primary" id="ds-site-publish">Publish as website</button></div>
      <div id="ds-site-result" style="margin-top:10px"></div></div>
    <div class="grid grid-3" style="margin-top:16px">${sites.length ? sites.map((s) => `<div class="card"><h3>${esc(s.title)}</h3><p class="muted">${esc(s.kind)} · <a href="${esc(s.url)}" target="_blank">${esc(s.url)}</a></p>
      <p class="muted" style="font-size:12px">👁 ${s.views || 0} view${s.views === 1 ? '' : 's'}${s.passwordProtected ? ' · 🔒 password protected' : ''}${s.seo && s.seo.title ? ` · SEO: ${esc(s.seo.title)}` : ''}</p>
      <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap"><a class="btn btn-primary" href="${esc(s.url)}" target="_blank">Open site</a><button class="btn" data-settings="${esc(s.slug)}">⚙️ SEO &amp; password</button><button class="btn" data-unpub="${esc(s.slug)}">Unpublish</button></div>
      <div id="ds-site-settings-${esc(s.slug)}" style="margin-top:10px"></div></div>`).join('') : '<div class="empty"><div class="big">🌐</div><p>No websites published yet.</p></div>'}</div>`;
    c.querySelector('#ds-site-publish').addEventListener('click', async () => {
      const pid = +c.querySelector('#ds-site-project').value;
      if (!pid) { toast('Pick a project first.', true); return; }
      const box = c.querySelector('#ds-site-result');
      box.textContent = 'Publishing…';
      try {
        const s = await api('/api/docs-slides/websites/publish', { method: 'POST', body: JSON.stringify({ projectId: pid }) });
        box.innerHTML = `<div class="alert ok">Published: <a href="${esc(s.site.url)}" target="_blank">${esc(s.site.url)}</a></div>`;
        renderView();
      } catch (e) { box.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
    });
    // v2.5.0 #30: per-site SEO/meta + password protection + local analytics
    // (page-view counts, no third party). Custom domain stays out by design.
    c.querySelectorAll('[data-settings]').forEach((b) => b.addEventListener('click', async () => {
      const slug = b.dataset.settings;
      const box = c.querySelector(`#ds-site-settings-${CSS.escape(slug)}`);
      if (!box) return;
      if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = ''; return; }
      box.dataset.open = '1';
      box.innerHTML = '<p class="muted">Loading settings…</p>';
      try {
        const [st, an] = await Promise.all([
          api(`/api/docs-slides/websites/${encodeURIComponent(slug)}/settings`),
          api(`/api/docs-slides/websites/${encodeURIComponent(slug)}/analytics`).catch(() => ({ views: 0, byDay: [] })),
        ]);
        const seo = st.seo || {};
        box.innerHTML = `<div style="border-top:1px solid var(--border,#2a3352);padding-top:10px">
          <label class="muted">SEO title</label><input class="input ds-seo-title" value="${esc(seo.title || '')}" placeholder="Page title for search engines">
          <label class="muted">SEO description</label><textarea class="input ds-seo-desc" rows="2" placeholder="Short description shown in search results">${esc(seo.description || '')}</textarea>
          <label class="muted">Keywords (comma-separated)</label><input class="input ds-seo-kw" value="${esc(seo.keywords || '')}">
          <label class="muted">Password (min 4 chars — leave blank to keep, or clear below)</label><input class="input ds-site-pass" type="password" placeholder="Set a site password">
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap"><button class="btn btn-primary ds-seo-save">Save settings</button><button class="btn ds-pass-clear">Remove password</button></div>
          <div class="ds-seo-status" style="margin-top:8px"></div>
          <p class="muted" style="font-size:12px;margin-top:8px">📊 Analytics (local, no cookies): <b>${an.views || 0}</b> total view${an.views === 1 ? '' : 's'}${(an.byDay || []).length ? ` — ${(an.byDay || []).slice(0, 5).map((d) => `${esc(d.day)}: ${d.views}`).join(', ')}` : ''}. No custom domain — sites live under /sites/ only.</p></div>`;
        const statusEl = box.querySelector('.ds-seo-status');
        box.querySelector('.ds-seo-save').addEventListener('click', async () => {
          const pass = box.querySelector('.ds-site-pass').value;
          const body = { seo: { title: box.querySelector('.ds-seo-title').value, description: box.querySelector('.ds-seo-desc').value, keywords: box.querySelector('.ds-seo-kw').value } };
          if (pass) body.password = pass;
          try {
            const r = await api(`/api/docs-slides/websites/${encodeURIComponent(slug)}/settings`, { method: 'POST', body: JSON.stringify(body) });
            statusEl.innerHTML = `<div class="alert ok">✓ Saved${r.passwordProtected ? ' — site is password protected.' : ''} The published site was rebuilt with the new meta tags.</div>`;
            renderView();
          } catch (e) { statusEl.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
        });
        box.querySelector('.ds-pass-clear').addEventListener('click', async () => {
          try {
            await api(`/api/docs-slides/websites/${encodeURIComponent(slug)}/settings`, { method: 'POST', body: JSON.stringify({ clearPassword: true }) });
            statusEl.innerHTML = '<div class="alert ok">✓ Password removed — the site is public again.</div>';
            renderView();
          } catch (e) { statusEl.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
        });
      } catch (e) { box.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
    }));
    c.querySelectorAll('[data-unpub]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/docs-slides/websites/${encodeURIComponent(b.dataset.unpub)}`, { method: 'DELETE' });
      toast('Website unpublished.');
      renderView();
    }));
  }

  // --- Print ------------------------------------------------------------------
  async function print(c) {
    const projects = await api('/api/projects?limit=100').catch(() => ({ projects: [] }));
    const printable = (projects.projects || []).filter((p) => ['design', 'deck', 'doc'].includes(p.type));
    const sizes = await api('/api/docs-slides/print-sizes').catch(() => ({ sizes: [] }));
    c.innerHTML = `<div class="page-head"><div><h2>🖨️ Print</h2><p class="muted">Print-ready PDFs: full bleed, crop marks and a safe-zone guide. Colour space: RGB (screen) or CMYK — CMYK embeds real DeviceCMYK JPEGs (Pillow-converted) with CMYK vector marks for print.</p></div></div>
    <div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select id="ds-print-project" class="input" style="flex:1;min-width:220px">${printable.map((p) => `<option value="${p.id}">${esc(p.name)} (${p.type})</option>`).join('') || '<option value="">No printable projects yet</option>'}</select>
      <select id="ds-print-size" class="input" style="width:170px">${(sizes.sizes || []).map((s) => `<option value="${s.id}">${esc(s.name)} — ${s.widthMm}×${s.heightMm} mm</option>`).join('')}</select>
      <select id="ds-print-colorspace" class="input" style="width:130px"><option value="rgb">RGB</option><option value="cmyk">CMYK (print)</option></select>
      <label class="muted">Bleed <input id="ds-print-bleed" class="input" type="number" min="0" max="10" value="3" style="width:64px"> mm</label>
      <label class="muted">Margin <input id="ds-print-margin" class="input" type="number" min="0" max="50" value="10" style="width:64px"> mm</label>
      <button class="btn btn-primary" id="ds-print-go">Download print PDF</button></div>
      <div id="ds-print-result" style="margin-top:10px"></div>
      <div class="alert" style="margin-top:12px"><strong>Print checklist</strong><ul style="margin:6px 0 0 18px">
      <li>Bleed extends the artwork past the trim edge so nothing white shows after cutting.</li>
      <li>Keep text inside the purple safe-zone rectangle — it is ${''} the margin you set from the trim edge.</li>
      <li>Black crop marks show the printer where to cut.</li>
      <li>Designs render at 150 DPI; photos below 150 DPI will look soft in print.</li></ul></div></div>`;
    c.querySelector('#ds-print-go').addEventListener('click', () => {
      const pid = +c.querySelector('#ds-print-project').value;
      if (!pid) { toast('Pick a project first.', true); return; }
      downloadExport('/api/docs-slides/print/pdf', 'print.pdf');
      async function downloadExport(url, fallback) {
        const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: pid, sizeId: c.querySelector('#ds-print-size').value, bleedMm: +c.querySelector('#ds-print-bleed').value || 0, marginMm: +c.querySelector('#ds-print-margin').value || 0, colorSpace: c.querySelector('#ds-print-colorspace').value || 'rgb' }) });
        if (!res.ok) { const j = await res.json().catch(() => ({})); toast(j.error || 'Print PDF failed.', true); return; }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const cd = res.headers.get('content-disposition') || '';
        const m = cd.match(/filename="?([^"]+)"?/);
        a.download = m ? m[1] : fallback;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
    });
  }

  return { presentations, documents, charts, websites, print };
})();
