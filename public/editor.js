'use strict';
/* CreativeStudio AI Pro — Phase 2 Graphic Editor.
   DOM-based editing (drag / resize / rotate / layers) with a real HTML5
   Canvas renderer for export (renderToCanvas). Designs are stored as
   project content (type 'design') via the Phase 1 projects API.
   Uses the app.js globals: api, apiForm, esc, toast, go, fmtBytes. */
window.DesignEditor = (function () {
  const FALLBACK_SIZES = [
    { id: 'instagram-post', name: 'Instagram Post', width: 1080, height: 1080 },
    { id: 'instagram-story', name: 'Instagram Story', width: 1080, height: 1920 },
    { id: 'facebook-post', name: 'Facebook Post', width: 1200, height: 630 },
    { id: 'facebook-cover', name: 'Facebook Cover', width: 820, height: 312 },
    { id: 'youtube-thumbnail', name: 'YouTube Thumbnail', width: 1280, height: 720 },
    { id: 'youtube-banner', name: 'YouTube Channel Banner', width: 2560, height: 1440 },
    { id: 'tiktok-cover', name: 'TikTok Cover', width: 1080, height: 1920 },
    { id: 'pinterest', name: 'Pinterest Graphic', width: 1000, height: 1500 },
    { id: 'business-card', name: 'Business Card', width: 1050, height: 600 },
    { id: 'flyer-a4', name: 'Flyer (A4)', width: 1240, height: 1754 },
    { id: 'poster', name: 'Poster', width: 1080, height: 1350 },
    { id: 'presentation', name: 'Presentation Slide', width: 1920, height: 1080 },
  ];
  const FALLBACK_FONTS = ['Inter', 'Poppins', 'Montserrat', 'Roboto', 'Lato', 'Raleway', 'Oswald', 'Playfair Display', 'Bebas Neue', 'Dancing Script', 'Arial', 'Georgia', 'Times New Roman', 'Verdana', 'Courier New'];

  let ed = null;
  let keyHandler = null;

  function uid(prefix) {
    return `${prefix || 'layer'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
  function deep(o) { return JSON.parse(JSON.stringify(o)); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function blankDesign(w, h) {
    return {
      version: 1, width: w || 1080, height: h || 1080,
      background: { type: 'color', color: '#151d3a', gradient: { from: '#7c5cff', to: '#3b82f6', angle: 135 } },
      layers: [],
    };
  }
  function isDesignContent(c) {
    return c && typeof c === 'object' && c.version === 1 && Array.isArray(c.layers)
      && typeof c.width === 'number' && typeof c.height === 'number';
  }
  function textLayer(x, y, text, opts) {
    opts = opts || {};
    return {
      id: uid(), type: 'text', name: opts.name || 'Text', x, y, w: opts.w || 600, h: opts.h || 90,
      rotation: 0, opacity: 1, locked: false, hidden: false, groupId: null,
      text: {
        text, fontFamily: opts.fontFamily || 'Poppins', fontSize: opts.fontSize || 64,
        fontWeight: opts.fontWeight || 700, fontStyle: 'normal', underline: false,
        align: opts.align || 'center', color: opts.color || '#ffffff',
        letterSpacing: 0, lineHeight: 1.2, shadow: null, stroke: null, gradient: null,
      },
    };
  }
  function shapeLayer(kind, x, y, w, h, opts) {
    opts = opts || {};
    return {
      id: uid(), type: 'shape', name: opts.name || (kind === 'ellipse' ? 'Circle' : kind === 'line' ? 'Line' : 'Rectangle'),
      x, y, w, h, rotation: opts.rotation || 0, opacity: 1, locked: false, hidden: false, groupId: null,
      shape: {
        kind, fill: opts.fill || '#7c5cff', stroke: opts.stroke || '', strokeWidth: opts.strokeWidth || 0,
        radius: opts.radius !== undefined ? opts.radius : 12, shadow: null,
      },
    };
  }
  function imageLayer(x, y, w, h, src, mediaId) {
    return {
      id: uid(), type: 'image', name: 'Image', x, y, w, h, rotation: 0, opacity: 1,
      locked: false, hidden: false, groupId: null,
      image: {
        mediaId: mediaId || null, src,
        filters: { grayscale: 0, sepia: 0, brightness: 100, contrast: 100, saturate: 100 },
        flipH: false, flipV: false, crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    };
  }

  /* ---------- Open / close ---------- */
  async function open(container, opts) {
    close();
    const project = opts.project;
    const design = isDesignContent(project.content) ? deep(project.content) : blankDesign(1080, 1080);
    ed = {
      container, projectId: project.id, projectName: project.name, design,
      selection: [], undoStack: [], redoStack: [], clipboard: null,
      zoom: 'fit', zoomVal: 1, grid: false, rulers: false, leftTab: 'canvas',
      sizes: FALLBACK_SIZES, fonts: FALLBACK_FONTS, templates: [], brands: [], media: [], animPresets: [],
      saveTimer: null, saveState: 'Saved', drag: null, historyArmed: false,
    };
    try {
      const [s, f, t, b, m, ap] = await Promise.all([
        api('/api/design/sizes').catch(() => ({ sizes: FALLBACK_SIZES })),
        api('/api/design/fonts').catch(() => ({ fonts: FALLBACK_FONTS })),
        api('/api/design/templates').catch(() => ({ templates: [] })),
        api('/api/design/brands').catch(() => ({ brands: [] })),
        api('/api/media?kind=image').catch(() => ({ media: [] })),
        api('/api/magic/animate/presets?target=design').catch(() => ({ presets: [] })),
      ]);
      ed.sizes = s.sizes || FALLBACK_SIZES;
      ed.fonts = f.fonts || FALLBACK_FONTS;
      ed.templates = t.templates || [];
      ed.brands = b.brands || [];
      ed.media = m.media || [];
      ed.animPresets = (ap.presets || []).filter((p) => p.appliesTo.includes('design'));
    } catch (e) { toast('Could not load editor data: ' + e.message, true); }
    renderShell();
    computeZoom();
    renderAll();
    attachKeys();
    return ed;
  }

  function close() {
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    if (ed && ed.saveTimer) { clearTimeout(ed.saveTimer); ed.saveTimer = null; }
    ed = null;
  }

  /* ---------- History ---------- */
  function pushHistory() {
    if (!ed) return;
    ed.undoStack.push(JSON.stringify(ed.design));
    if (ed.undoStack.length > 50) ed.undoStack.shift();
    ed.redoStack = [];
  }
  function undo() {
    if (!ed || !ed.undoStack.length) { toast('Nothing to undo.'); return; }
    ed.redoStack.push(JSON.stringify(ed.design));
    ed.design = JSON.parse(ed.undoStack.pop());
    ed.selection = [];
    renderAll(); scheduleSave();
  }
  function redo() {
    if (!ed || !ed.redoStack.length) { toast('Nothing to redo.'); return; }
    ed.undoStack.push(JSON.stringify(ed.design));
    ed.design = JSON.parse(ed.redoStack.pop());
    ed.selection = [];
    renderAll(); scheduleSave();
  }

  /* ---------- Saving ---------- */
  function setSaveState(s) {
    ed.saveState = s;
    const el = document.getElementById('ed-save-state');
    if (el) el.textContent = s;
  }
  function scheduleSave() {
    if (!ed) return;
    setSaveState('Unsaved…');
    clearTimeout(ed.saveTimer);
    ed.saveTimer = setTimeout(() => saveDesign(false), 800);
  }
  async function saveDesign(saveVersion) {
    if (!ed) return false;
    setSaveState('Saving…');
    try {
      await api(`/api/projects/${ed.projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: ed.design, saveVersion: !!saveVersion }),
      });
      setSaveState('Saved ✓');
      if (saveVersion) toast('Version saved.');
      return true;
    } catch (e) {
      setSaveState('Save failed');
      toast('Save failed: ' + e.message, true);
      return false;
    }
  }
  async function renameProject(name) {
    if (!ed || !name.trim()) return;
    try {
      await api(`/api/projects/${ed.projectId}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
      ed.projectName = name.trim();
      toast('Design renamed.');
    } catch (e) { toast(e.message, true); }
  }

  /* ---------- Selection ---------- */
  function layerById(id) { return ed.design.layers.find((l) => l.id === id); }
  function selectedLayers() { return ed.selection.map(layerById).filter(Boolean); }
  function expandGroup(id) {
    const l = layerById(id);
    if (!l || !l.groupId) return [id];
    return ed.design.layers.filter((x) => x.groupId === l.groupId).map((x) => x.id);
  }
  function select(ids, add) {
    let next = [];
    if (add) next = [...ed.selection];
    for (const id of ids) {
      for (const gid of expandGroup(id)) {
        if (!next.includes(gid)) next.push(gid);
      }
    }
    if (!add) next = [...new Set(next)];
    ed.selection = next;
    updateSelectionUI();
    renderProps();
    renderLayersPanelIfActive();
    renderStatus();
  }
  function selectAll() { select(ed.design.layers.filter((l) => !l.hidden).map((l) => l.id)); }

  /* ---------- Shell ---------- */
  function renderShell() {
    ed.container.innerHTML = `
    <div class="ed-wrap">
      <div class="ed-toolbar">
        <button class="btn btn-sm" id="ed-back">← Projects</button>
        <input class="title-input" id="ed-name" value="${esc(ed.projectName)}" title="Design name — click to rename">
        <span class="badge" id="ed-save-state">Saved</span>
        <span class="sep"></span>
        <button class="btn btn-sm" id="ed-undo" title="Undo (Ctrl+Z)">↶ Undo</button>
        <button class="btn btn-sm" id="ed-redo" title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
        <span class="sep"></span>
        <button class="btn btn-sm" id="ed-copy" title="Copy (Ctrl+C)">Copy</button>
        <button class="btn btn-sm" id="ed-paste" title="Paste (Ctrl+V)">Paste</button>
        <button class="btn btn-sm" id="ed-duplicate" title="Duplicate (Ctrl+D)">Duplicate</button>
        <button class="btn btn-sm" id="ed-delete" title="Delete (Del)">Delete</button>
        <span class="sep"></span>
        <button class="btn btn-sm" id="ed-group" title="Group selected layers">Group</button>
        <button class="btn btn-sm" id="ed-ungroup" title="Ungroup selected layers">Ungroup</button>
        <span class="spacer"></span>
        <select id="ed-zoom" title="Zoom" style="width:96px">
          <option value="fit">Fit</option><option value="0.25">25%</option><option value="0.5">50%</option>
          <option value="0.75">75%</option><option value="1">100%</option><option value="1.5">150%</option>
        </select>
        <select id="ed-export-scale" title="Export resolution" style="width:76px">
          <option value="1">1×</option><option value="2">2×</option>
        </select>
        <button class="btn btn-sm" id="ed-save">💾 Save</button>
        <button class="btn btn-sm" id="ed-export-png">Export PNG</button>
        <button class="btn btn-sm" id="ed-export-jpg">Export JPG</button>
        <button class="btn btn-sm btn-primary" id="ed-save-library">Save to Library</button>
      </div>
      <div class="ed-body">
        <div class="ed-left">
          <div class="ed-tabs" id="ed-tabs">
            <button class="ed-tab" data-tab="canvas"><span class="ti">◻️</span><span class="tl">Canvas</span></button>
            <button class="ed-tab" data-tab="add"><span class="ti">➕</span><span class="tl">Elements</span></button>
            <button class="ed-tab" data-tab="layers"><span class="ti">🗂️</span><span class="tl">Layers</span></button>
            <button class="ed-tab" data-tab="templates"><span class="ti">📐</span><span class="tl">Templates</span></button>
            <button class="ed-tab" data-tab="media"><span class="ti">🖼️</span><span class="tl">Media</span></button>
            <button class="ed-tab" data-tab="brand"><span class="ti">🏷️</span><span class="tl">Brand</span></button>
          </div>
          <div class="ed-panel" id="ed-left-panel"></div>
        </div>
        <div class="ed-center">
          <div class="ed-stage-scroll" id="ed-scroll">
            <div class="ed-stage-box" id="ed-stage-box">
              <div class="ed-ruler-h" id="ed-ruler-h" style="display:none"></div>
              <div style="display:flex">
                <div class="ed-ruler-v" id="ed-ruler-v" style="display:none"></div>
                <div class="ed-stage" id="ed-stage"><div class="ed-canvas" id="ed-canvas"></div></div>
              </div>
            </div>
          </div>
        </div>
        <div class="ed-right" id="ed-right"></div>
      </div>
      <div class="ed-statusbar">
        <span id="ed-status-size"></span><span id="ed-status-layers"></span>
        <span id="ed-status-sel"></span><span class="spacer"></span>
        <span>Drag to move · corners to resize · top handle to rotate · double-click text to edit</span>
      </div>
    </div>`;
    document.getElementById('ed-back').addEventListener('click', async () => { await saveDesign(false); close(); go('projects'); });
    document.getElementById('ed-name').addEventListener('change', (e) => renameProject(e.target.value));
    document.getElementById('ed-undo').addEventListener('click', undo);
    document.getElementById('ed-redo').addEventListener('click', redo);
    document.getElementById('ed-copy').addEventListener('click', copySelection);
    document.getElementById('ed-paste').addEventListener('click', pasteClipboard);
    document.getElementById('ed-duplicate').addEventListener('click', duplicateSelection);
    document.getElementById('ed-delete').addEventListener('click', deleteSelection);
    document.getElementById('ed-group').addEventListener('click', groupSelection);
    document.getElementById('ed-ungroup').addEventListener('click', ungroupSelection);
    document.getElementById('ed-zoom').addEventListener('change', (e) => { ed.zoom = e.target.value; computeZoom(); renderStage(); });
    document.getElementById('ed-save').addEventListener('click', () => saveDesign(true));
    document.getElementById('ed-export-png').addEventListener('click', () => exportDesign('png'));
    document.getElementById('ed-export-jpg').addEventListener('click', () => exportDesign('jpg'));
    document.getElementById('ed-save-library').addEventListener('click', saveExportToLibrary);
    document.querySelectorAll('#ed-tabs .ed-tab').forEach((b) => b.addEventListener('click', () => {
      ed.leftTab = b.dataset.tab;
      renderLeftPanel();
    }));
  }

  function computeZoom() {
    const scroll = document.getElementById('ed-scroll');
    if (!scroll) return;
    if (ed.zoom === 'fit') {
      const availW = scroll.clientWidth - 60;
      const availH = scroll.clientHeight - 60;
      ed.zoomVal = clamp(Math.min(availW / ed.design.width, availH / ed.design.height), 0.05, 1);
    } else {
      ed.zoomVal = parseFloat(ed.zoom);
    }
    const sel = document.getElementById('ed-zoom');
    if (sel) sel.value = ed.zoom;
  }

  function renderAll() {
    renderStage();
    renderLeftPanel();
    renderLayersPanelIfActive();
    renderProps();
    renderStatus();
    document.querySelectorAll('#ed-tabs .ed-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === ed.leftTab));
  }

  function renderStatus() {
    const d = ed.design;
    const sizeEl = document.getElementById('ed-status-size');
    if (sizeEl) sizeEl.textContent = `${d.width} × ${d.height}px`;
    const lEl = document.getElementById('ed-status-layers');
    if (lEl) lEl.textContent = `${d.layers.length} layer${d.layers.length === 1 ? '' : 's'}`;
    const sEl = document.getElementById('ed-status-sel');
    if (sEl) sEl.textContent = ed.selection.length ? `${ed.selection.length} selected` : 'Nothing selected';
    setSaveState(ed.saveState);
  }

  /* ---------- Stage rendering ---------- */
  function filterCss(f) {
    return `grayscale(${f.grayscale}%) sepia(${f.sepia}%) brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturate}%)`;
  }
  function textStyle(t) {
    const s = {
      fontFamily: `'${t.fontFamily}', sans-serif`,
      fontSize: `${t.fontSize}px`,
      fontWeight: String(t.fontWeight),
      fontStyle: t.fontStyle,
      textAlign: t.align,
      letterSpacing: `${t.letterSpacing}px`,
      lineHeight: String(t.lineHeight),
      textDecoration: t.underline ? 'underline' : 'none',
    };
    if (t.gradient) {
      s.backgroundImage = `linear-gradient(90deg, ${t.gradient.from}, ${t.gradient.to})`;
      s.WebkitBackgroundClip = 'text';
      s.backgroundClip = 'text';
      s.color = 'transparent';
    } else {
      s.color = t.color;
    }
    if (t.shadow) s.textShadow = `${t.shadow.offsetX}px ${t.shadow.offsetY}px ${t.shadow.blur}px ${t.shadow.color}`;
    if (t.stroke) s.WebkitTextStroke = `${t.stroke.width}px ${t.stroke.color}`;
    return s;
  }
  function applyStyles(el, styles) {
    for (const [k, v] of Object.entries(styles)) el.style[k] = v;
  }

  function createLayerEl(layer) {
    const el = document.createElement('div');
    el.className = 'ed-layer' + (layer.locked ? ' locked' : '');
    el.dataset.id = layer.id;
    el.style.left = `${layer.x}px`;
    el.style.top = `${layer.y}px`;
    el.style.width = `${layer.w}px`;
    el.style.height = `${layer.h}px`;
    el.style.opacity = String(layer.opacity);
    el.style.transform = `rotate(${layer.rotation || 0}deg)`;
    el.style.zIndex = String(ed.design.layers.indexOf(layer) + 1);
    if (layer.type === 'text') {
      const inner = document.createElement('div');
      inner.className = 'ed-text';
      inner.textContent = layer.text.text;
      applyStyles(inner, textStyle(layer.text));
      el.appendChild(inner);
    } else if (layer.type === 'shape') {
      const s = layer.shape;
      const inner = document.createElement('div');
      inner.style.width = '100%';
      inner.style.height = '100%';
      if (s.kind === 'line') {
        inner.style.background = s.stroke || s.fill || '#ffffff';
        inner.style.height = `${Math.max(2, s.strokeWidth || 4)}px`;
        inner.style.position = 'relative';
        inner.style.top = '50%';
        inner.style.transform = 'translateY(-50%)';
      } else {
        inner.style.background = s.fill || 'transparent';
        if (s.stroke) inner.style.border = `${s.strokeWidth || 2}px solid ${s.stroke}`;
        if (s.kind === 'ellipse') inner.style.borderRadius = '50%';
        else if (s.kind === 'triangle') inner.style.clipPath = 'polygon(50% 0, 100% 100%, 0 100%)';
        else inner.style.borderRadius = `${s.radius || 0}px`;
        if (s.shadow) inner.style.boxShadow = `${s.shadow.offsetX}px ${s.shadow.offsetY}px ${s.shadow.blur}px ${s.shadow.color}`;
      }
      el.appendChild(inner);
    } else if (layer.type === 'image') {
      const im = layer.image;
      const wrap = document.createElement('div');
      wrap.className = 'ed-imgwrap';
      const c = im.crop;
      if (c.left || c.top || c.right || c.bottom) {
        wrap.style.clipPath = `inset(${c.top}% ${c.right}% ${c.bottom}% ${c.left}%)`;
      }
      const img = document.createElement('img');
      img.src = im.src;
      img.alt = '';
      img.draggable = false;
      img.style.filter = filterCss(im.filters);
      const flips = [];
      if (im.flipH) flips.push('scaleX(-1)');
      if (im.flipV) flips.push('scaleY(-1)');
      if (flips.length) img.style.transform = flips.join(' ');
      wrap.appendChild(img);
      el.appendChild(wrap);
    }
    el.addEventListener('pointerdown', (e) => onLayerPointerDown(e, layer));
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); onLayerDblClick(layer); });
    if (layer.animation && layer.animation.keyframes && layer.animation.keyframes.length) {
      const inner = el.firstChild;
      if (inner) {
        const animName = `ed-anim-${String(layer.id).replace(/[^a-zA-Z0-9]/g, '')}`;
        inner.style.animation = `${animName} ${layer.animation.durationMs}ms ease ${layer.animation.delayMs || 0}ms ${layer.animation.loop ? 'infinite' : 'forwards'}`;
      }
    }
    return el;
  }

  function renderStage() {
    const stage = document.getElementById('ed-stage');
    const canvas = document.getElementById('ed-canvas');
    if (!stage || !canvas) return;
    const d = ed.design;
    const z = ed.zoomVal;
    stage.style.width = `${d.width * z}px`;
    stage.style.height = `${d.height * z}px`;
    canvas.style.width = `${d.width}px`;
    canvas.style.height = `${d.height}px`;
    canvas.style.transform = `scale(${z})`;
    canvas.classList.toggle('transparent', d.background.type === 'transparent');
    canvas.innerHTML = '';
    // CSS @keyframes for layers with an animation preset (live preview).
    const animCss = d.layers.filter((l) => l.animation && l.animation.keyframes && l.animation.keyframes.length).map((l) => {
      const name = `ed-anim-${String(l.id).replace(/[^a-zA-Z0-9]/g, '')}`;
      const frames = l.animation.keyframes.map((k) => {
        const pct = Math.round((k.offset || 0) * 100);
        if (l.animation.presetId === 'typewriter') {
          // Letter-by-letter reveal approximated as a left-to-right wipe.
          return `${pct}% { clip-path: inset(0 ${100 - pct}% 0 0); opacity: 1; }`;
        }
        const parts = [];
        if (k.translateX !== undefined || k.translateY !== undefined) parts.push(`translate(${k.translateX || 0}px, ${k.translateY || 0}px)`);
        if (k.scale !== undefined) parts.push(`scale(${k.scale})`);
        if (k.rotate !== undefined) parts.push(`rotate(${k.rotate}deg)`);
        return `${pct}% { ${parts.length ? `transform: ${parts.join(' ')};` : ''} opacity: ${k.opacity !== undefined ? k.opacity : 1}; }`;
      }).join(' ');
      return `@keyframes ${name} { ${frames} }`;
    }).join('\n');
    if (animCss) {
      const style = document.createElement('style');
      style.textContent = animCss;
      canvas.appendChild(style);
    }
    const bg = document.createElement('div');
    bg.className = 'ed-bg';
    if (d.background.type === 'color') bg.style.background = d.background.color;
    else if (d.background.type === 'gradient') {
      bg.style.background = `linear-gradient(${d.background.gradient.angle}deg, ${d.background.gradient.from}, ${d.background.gradient.to})`;
    } else bg.style.background = 'transparent';
    canvas.appendChild(bg);
    if (ed.grid) {
      const grid = document.createElement('div');
      grid.className = 'ed-grid';
      grid.style.backgroundSize = `${20 * z}px ${20 * z}px`;
      canvas.appendChild(grid);
    }
    for (const layer of d.layers) {
      if (layer.hidden) continue;
      canvas.appendChild(createLayerEl(layer));
    }
    const gv = document.createElement('div');
    gv.className = 'ed-guide-v'; gv.id = 'ed-guide-v'; gv.style.display = 'none';
    canvas.appendChild(gv);
    const gh = document.createElement('div');
    gh.className = 'ed-guide-h'; gh.id = 'ed-guide-h'; gh.style.display = 'none';
    canvas.appendChild(gh);
    renderRulers();
    updateSelectionUI();
  }

  function renderRulers() {
    const rh = document.getElementById('ed-ruler-h');
    const rv = document.getElementById('ed-ruler-v');
    const show = ed.rulers;
    if (rh) {
      rh.style.display = show ? 'block' : 'none';
      if (show) {
        rh.style.width = `${ed.design.width * ed.zoomVal + 22}px`;
        rh.style.paddingLeft = '22px';
        rh.style.boxSizing = 'border-box';
        let html = '';
        for (let x = 0; x <= ed.design.width; x += 100) {
          html += `<span style="left:${22 + x * ed.zoomVal}px">${x}</span>`;
        }
        rh.innerHTML = html;
      }
    }
    if (rv) {
      rv.style.display = show ? 'block' : 'none';
      if (show) {
        rv.style.width = '22px';
        rv.style.height = `${ed.design.height * ed.zoomVal}px`;
        rv.style.position = 'relative';
        rv.style.flexShrink = '0';
        let html = '';
        for (let y = 0; y <= ed.design.height; y += 100) {
          html += `<span style="position:absolute;top:${y * ed.zoomVal}px;right:2px;font-size:10px;color:var(--muted2)">${y}</span>`;
        }
        rv.innerHTML = html;
      }
    }
  }

  function updateSelectionUI() {
    if (!ed) return;
    document.querySelectorAll('#ed-canvas .ed-layer').forEach((el) => {
      el.classList.toggle('selected', ed.selection.includes(el.dataset.id));
      el.querySelectorAll('.ed-handle').forEach((h) => h.remove());
    });
    if (ed.selection.length === 1) {
      const layer = layerById(ed.selection[0]);
      const el = document.querySelector(`#ed-canvas .ed-layer[data-id="${CSS.escape(layer ? layer.id : '')}"]`);
      if (el && layer && !layer.locked) {
        const hs = Math.max(8, Math.round(12 / ed.zoomVal));
        for (const pos of ['nw', 'ne', 'sw', 'se', 'rot']) {
          const h = document.createElement('div');
          h.className = `ed-handle ${pos}`;
          h.style.width = `${hs}px`;
          h.style.height = `${hs}px`;
          h.dataset.handle = pos;
          h.addEventListener('pointerdown', (e) => onHandlePointerDown(e, layer, pos));
          el.appendChild(h);
        }
      }
    }
  }

  /* ---------- Pointer interaction: move / resize / rotate ---------- */
  function hideGuides() {
    const gv = document.getElementById('ed-guide-v');
    const gh = document.getElementById('ed-guide-h');
    if (gv) gv.style.display = 'none';
    if (gh) gh.style.display = 'none';
  }
  function snapDelta(orig, dx, dy) {
    const d = ed.design;
    const thresh = 6 / ed.zoomVal;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const o of orig) {
      minX = Math.min(minX, o.x); maxX = Math.max(maxX, o.x + o.w);
      minY = Math.min(minY, o.y); maxY = Math.max(maxY, o.y + o.h);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const selIds = new Set(orig.map((o) => o.id));
    const candX = [0, d.width / 2, d.width];
    const candY = [0, d.height / 2, d.height];
    for (const l of d.layers) {
      if (selIds.has(l.id) || l.hidden) continue;
      candX.push(l.x, l.x + l.w / 2, l.x + l.w);
      candY.push(l.y, l.y + l.h / 2, l.y + l.h);
    }
    let outX = dx, outY = dy, guideX = null, guideY = null;
    for (const edge of [minX, cx, maxX]) {
      for (const c of candX) {
        if (Math.abs(edge + dx - c) <= thresh) { outX = c - edge; guideX = c; break; }
      }
      if (guideX !== null) break;
    }
    for (const edge of [minY, cy, maxY]) {
      for (const c of candY) {
        if (Math.abs(edge + dy - c) <= thresh) { outY = c - edge; guideY = c; break; }
      }
      if (guideY !== null) break;
    }
    const gv = document.getElementById('ed-guide-v');
    const gh = document.getElementById('ed-guide-h');
    if (gv) { gv.style.display = guideX === null ? 'none' : 'block'; if (guideX !== null) gv.style.left = `${guideX}px`; }
    if (gh) { gh.style.display = guideY === null ? 'none' : 'block'; if (guideY !== null) gh.style.top = `${guideY}px`; }
    return { dx: outX, dy: outY };
  }

  function onLayerPointerDown(e, layer) {
    if (e.button !== 0 || !ed) return;
    e.stopPropagation();
    if (layer.locked) {
      select([layer.id]);
      toast('This layer is locked — unlock it in the properties panel to move it.');
      return;
    }
    const add = e.shiftKey || e.metaKey || e.ctrlKey;
    if (!ed.selection.includes(layer.id) || add) select([layer.id], add);
    const startX = e.clientX, startY = e.clientY;
    const sel = selectedLayers();
    const orig = sel.map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h }));
    let moved = false;
    function onMove(ev) {
      const dx = (ev.clientX - startX) / ed.zoomVal;
      const dy = (ev.clientY - startY) / ed.zoomVal;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      if (!moved) { pushHistory(); moved = true; }
      const s = snapDelta(orig, dx, dy);
      for (const o of orig) {
        const l = layerById(o.id);
        if (!l) continue;
        l.x = Math.round(o.x + s.dx);
        l.y = Math.round(o.y + s.dy);
        const el = document.querySelector(`#ed-canvas .ed-layer[data-id="${CSS.escape(l.id)}"]`);
        if (el) { el.style.left = `${l.x}px`; el.style.top = `${l.y}px`; }
      }
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      hideGuides();
      if (moved) { renderProps(); renderStatus(); scheduleSave(); }
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function onHandlePointerDown(e, layer, pos) {
    if (e.button !== 0 || !ed) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const orig = { x: layer.x, y: layer.y, w: layer.w, h: layer.h, rotation: layer.rotation || 0, fontSize: layer.type === 'text' ? layer.text.fontSize : 0 };
    let changed = false;
    const canvas = document.getElementById('ed-canvas');
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.left + (layer.x + layer.w / 2) * ed.zoomVal;
    const centerY = rect.top + (layer.y + layer.h / 2) * ed.zoomVal;
    function onMove(ev) {
      if (!changed) { pushHistory(); changed = true; }
      if (pos === 'rot') {
        const ang = Math.atan2(ev.clientY - centerY, ev.clientX - centerX) * 180 / Math.PI + 90;
        layer.rotation = Math.round(((ang + 180) % 360 + 360) % 360 - 180);
        const el = document.querySelector(`#ed-canvas .ed-layer[data-id="${CSS.escape(layer.id)}"]`);
        if (el) el.style.transform = `rotate(${layer.rotation}deg)`;
        return;
      }
      const dw = (ev.clientX - startX) / ed.zoomVal;
      const dh = (ev.clientY - startY) / ed.zoomVal;
      let { x, y, w, h } = orig;
      if (pos.includes('e')) w = orig.w + dw;
      if (pos.includes('s')) h = orig.h + dh;
      if (pos.includes('w')) { w = orig.w - dw; x = orig.x + dw; }
      if (pos.includes('n')) { h = orig.h - dh; y = orig.y + dh; }
      if (e.shiftKey) {
        const ratio = orig.w / orig.h;
        if (Math.abs(dw) > Math.abs(dh)) { h = w / ratio; if (pos.includes('n')) y = orig.y + orig.h - h; }
        else { w = h * ratio; if (pos.includes('w')) x = orig.x + orig.w - w; }
      }
      w = Math.max(10, Math.round(w));
      h = Math.max(10, Math.round(h));
      layer.w = w; layer.h = h; layer.x = Math.round(x); layer.y = Math.round(y);
      if (layer.type === 'text' && orig.fontSize) {
        layer.text.fontSize = clamp(Math.round(orig.fontSize * (h / orig.h)), 6, 1000);
      }
      const el = document.querySelector(`#ed-canvas .ed-layer[data-id="${CSS.escape(layer.id)}"]`);
      if (el) {
        el.style.left = `${layer.x}px`; el.style.top = `${layer.y}px`;
        el.style.width = `${layer.w}px`; el.style.height = `${layer.h}px`;
        const inner = el.querySelector('.ed-text');
        if (inner) inner.style.fontSize = `${layer.text.fontSize}px`;
      }
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (changed) { renderStage(); renderProps(); scheduleSave(); }
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function onLayerDblClick(layer) {
    if (layer.type !== 'text' || layer.locked || !ed) return;
    const canvas = document.getElementById('ed-canvas');
    const old = document.getElementById('ed-inline-edit');
    if (old) old.remove();
    const ta = document.createElement('textarea');
    ta.id = 'ed-inline-edit';
    ta.value = layer.text.text;
    ta.style.position = 'absolute';
    ta.style.left = `${layer.x}px`;
    ta.style.top = `${layer.y}px`;
    ta.style.width = `${layer.w}px`;
    ta.style.height = `${Math.max(layer.h, 60)}px`;
    ta.style.zIndex = '80';
    ta.style.background = 'rgba(255,255,255,0.95)';
    ta.style.color = '#111';
    ta.style.border = '2px solid var(--cyan)';
    ta.style.resize = 'none';
    ta.style.fontFamily = `'${layer.text.fontFamily}', sans-serif`;
    ta.style.fontSize = `${layer.text.fontSize}px`;
    ta.style.fontWeight = String(layer.text.fontWeight);
    ta.style.textAlign = layer.text.align;
    ta.style.lineHeight = String(layer.text.lineHeight);
    canvas.appendChild(ta);
    ta.focus();
    ta.select();
    let done = false;
    const commit = (cancel) => {
      if (done) return;
      done = true;
      const val = ta.value;
      ta.remove();
      if (!cancel && val !== layer.text.text) {
        pushHistory();
        layer.text.text = val;
        renderStage();
        renderProps();
        scheduleSave();
      } else renderStage();
    };
    ta.addEventListener('blur', () => commit(false));
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') commit(true);
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit(false);
    });
  }

  /* ---------- Layer operations ---------- */
  function copySelection() {
    const sel = selectedLayers();
    if (!sel.length) { toast('Select a layer first.'); return; }
    ed.clipboard = deep(sel);
    toast(`Copied ${sel.length} layer${sel.length === 1 ? '' : 's'}.`);
  }
  function pasteClipboard() {
    if (!ed.clipboard || !ed.clipboard.length) { toast('Nothing to paste — copy a layer first.'); return; }
    pushHistory();
    const fresh = ed.clipboard.map((l) => {
      const c = deep(l);
      c.id = uid();
      c.x += 24; c.y += 24;
      c.name = `${c.name} copy`;
      return c;
    });
    ed.design.layers.push(...fresh);
    select(fresh.map((l) => l.id));
    renderStage();
    scheduleSave();
  }
  function duplicateSelection() {
    const sel = selectedLayers();
    if (!sel.length) { toast('Select a layer first.'); return; }
    ed.clipboard = deep(sel);
    pasteClipboard();
  }
  function deleteSelection() {
    const sel = selectedLayers();
    if (!sel.length) { toast('Select a layer first.'); return; }
    pushHistory();
    const ids = new Set(sel.map((l) => l.id));
    ed.design.layers = ed.design.layers.filter((l) => !ids.has(l.id));
    ed.selection = [];
    renderAll();
    scheduleSave();
    toast(`Deleted ${sel.length} layer${sel.length === 1 ? '' : 's'}.`);
  }
  function groupSelection() {
    if (ed.selection.length < 2) { toast('Select at least 2 layers to group.'); return; }
    pushHistory();
    const gid = uid('grp');
    for (const l of selectedLayers()) l.groupId = gid;
    renderAll();
    scheduleSave();
    toast('Layers grouped — clicking any of them selects the whole group.');
  }
  function ungroupSelection() {
    const sel = selectedLayers();
    if (!sel.length) { toast('Select a grouped layer first.'); return; }
    const gids = new Set(sel.map((l) => l.groupId).filter(Boolean));
    if (!gids.size) { toast('Selected layers are not in a group.'); return; }
    pushHistory();
    for (const l of ed.design.layers) if (gids.has(l.groupId)) l.groupId = null;
    renderAll();
    scheduleSave();
    toast('Group removed.');
  }
  function alignSelection(mode) {
    const sel = selectedLayers();
    if (!sel.length) { toast('Select a layer first.'); return; }
    pushHistory();
    const d = ed.design;
    let box;
    if (sel.length > 1) {
      const xs = sel.map((l) => l.x), ys = sel.map((l) => l.y);
      const xe = sel.map((l) => l.x + l.w), ye = sel.map((l) => l.y + l.h);
      box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xe) - Math.min(...xs), h: Math.max(...ye) - Math.min(...ys) };
    } else box = { x: 0, y: 0, w: d.width, h: d.height };
    for (const l of sel) {
      if (mode === 'left') l.x = Math.round(box.x);
      if (mode === 'center') l.x = Math.round(box.x + (box.w - l.w) / 2);
      if (mode === 'right') l.x = Math.round(box.x + box.w - l.w);
      if (mode === 'top') l.y = Math.round(box.y);
      if (mode === 'middle') l.y = Math.round(box.y + (box.h - l.h) / 2);
      if (mode === 'bottom') l.y = Math.round(box.y + box.h - l.h);
    }
    renderStage(); renderProps(); scheduleSave();
  }
  function distributeSelection(axis) {
    const sel = selectedLayers();
    if (sel.length < 3) { toast('Select at least 3 layers to distribute.'); return; }
    pushHistory();
    const sorted = [...sel].sort((a, b) => axis === 'h' ? (a.x + a.w / 2) - (b.x + b.w / 2) : (a.y + a.h / 2) - (b.y + b.h / 2));
    const first = axis === 'h' ? sorted[0].x + sorted[0].w / 2 : sorted[0].y + sorted[0].h / 2;
    const last = axis === 'h' ? sorted[sorted.length - 1].x + sorted[sorted.length - 1].w / 2 : sorted[sorted.length - 1].y + sorted[sorted.length - 1].h / 2;
    const step = (last - first) / (sorted.length - 1);
    sorted.forEach((l, i) => {
      if (axis === 'h') l.x = Math.round(first + step * i - l.w / 2);
      else l.y = Math.round(first + step * i - l.h / 2);
    });
    renderStage(); renderProps(); scheduleSave();
  }
  function moveLayer(id, dir) {
    const idx = ed.design.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const to = idx + dir;
    if (to < 0 || to >= ed.design.layers.length) return;
    pushHistory();
    const [l] = ed.design.layers.splice(idx, 1);
    ed.design.layers.splice(to, 0, l);
    renderStage(); renderLayersPanelIfActive(); scheduleSave();
  }
  function toggleLock(id) {
    const l = layerById(id);
    if (!l) return;
    pushHistory();
    l.locked = !l.locked;
    renderStage(); renderProps(); renderLayersPanelIfActive(); scheduleSave();
  }
  function toggleHide(id) {
    const l = layerById(id);
    if (!l) return;
    pushHistory();
    l.hidden = !l.hidden;
    if (l.hidden) ed.selection = ed.selection.filter((x) => x !== id);
    renderAll(); scheduleSave();
  }
  function renameLayer(id) {
    const l = layerById(id);
    if (!l) return;
    const name = prompt('Layer name', l.name);
    if (name && name.trim()) {
      pushHistory();
      l.name = name.trim();
      renderLayersPanelIfActive(); scheduleSave();
    }
  }

  /* ---------- Keyboard ---------- */
  function attachKeys() {
    keyHandler = (e) => {
      if (!ed) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); }
      else if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); }
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); }
      else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
      else if (mod && e.key.toLowerCase() === 'g' && !e.shiftKey) { e.preventDefault(); groupSelection(); }
      else if (mod && e.key.toLowerCase() === 'g' && e.shiftKey) { e.preventDefault(); ungroupSelection(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
    };
    document.addEventListener('keydown', keyHandler);
  }

  /* ---------- Left panel ---------- */
  function renderLeftPanel() {
    const panel = document.getElementById('ed-left-panel');
    if (!panel || !ed) return;
    document.querySelectorAll('#ed-tabs .ed-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === ed.leftTab));
    if (ed.leftTab === 'canvas') { panel.innerHTML = canvasTabHtml(); bindCanvasTab(panel); }
    else if (ed.leftTab === 'add') { panel.innerHTML = addTabHtml(); bindAddTab(panel); }
    else if (ed.leftTab === 'layers') renderLayersPanel();
    else if (ed.leftTab === 'templates') { panel.innerHTML = templatesTabHtml(); bindTemplatesTab(panel); }
    else if (ed.leftTab === 'media') { panel.innerHTML = mediaTabHtml(); bindMediaTab(panel); }
    else if (ed.leftTab === 'brand') { panel.innerHTML = brandTabHtml(); bindBrandTab(panel); }
  }
  function renderLayersPanelIfActive() { if (ed && ed.leftTab === 'layers') renderLayersPanel(); }

  function canvasTabHtml() {
    const d = ed.design;
    const preset = ed.sizes.find((s) => s.width === d.width && s.height === d.height);
    return `
    <h4>Canvas size</h4>
    <div class="ed-field"><label>Preset</label>
      <select id="ed-size-preset">${ed.sizes.map((s) => `<option value="${s.id}" ${preset && preset.id === s.id ? 'selected' : ''}>${esc(s.name)} — ${s.width}×${s.height}</option>`).join('')}<option value="custom" ${preset ? '' : 'selected'}>Custom</option></select>
    </div>
    <div class="ed-row">
      <div class="ed-field"><label>Width (px)</label><input type="number" id="ed-cw" value="${d.width}" min="10" max="8000"></div>
      <div class="ed-field"><label>Height (px)</label><input type="number" id="ed-ch" value="${d.height}" min="10" max="8000"></div>
    </div>
    <div class="ed-btnrow"><button class="btn btn-sm btn-primary" id="ed-apply-size">Apply size</button></div>
    <h4>🪄 Magic Resize</h4>
    <p class="ed-note">Reflow the whole design to a new format — layers scale and reposition, text re-wraps and shrinks to fit (never overflows). Anything that still cannot fit is listed as “Needs attention”.</p>
    <div class="ed-row">
      <div class="ed-field"><label>Target size</label><select id="ed-magic-size">${ed.sizes.map((s) => `<option value="${s.id}">${esc(s.name)} — ${s.width}×${s.height}</option>`).join('')}</select></div>
      <button class="btn btn-sm" id="ed-magic-resize" style="align-self:end">🪄 Magic Resize</button>
    </div>
    <div id="ed-magic-report"></div>
    <h4>Background</h4>
    <div class="ed-field"><label>Type</label>
      <select id="ed-bg-type">
        <option value="color" ${d.background.type === 'color' ? 'selected' : ''}>Solid colour</option>
        <option value="gradient" ${d.background.type === 'gradient' ? 'selected' : ''}>Gradient</option>
        <option value="transparent" ${d.background.type === 'transparent' ? 'selected' : ''}>Transparent</option>
      </select>
    </div>
    <div id="ed-bg-controls">${bgControlsHtml()}</div>
    <h4>View</h4>
    <div class="ed-field"><label><input type="checkbox" id="ed-grid" ${ed.grid ? 'checked' : ''} style="width:auto"> Show grid (20px)</label></div>
    <div class="ed-field"><label><input type="checkbox" id="ed-rulers" ${ed.rulers ? 'checked' : ''} style="width:auto"> Show rulers (top + left)</label></div>
    <div class="ed-note"><b>Tip:</b> drag a layer to move it — pink guides appear when it snaps to the canvas centre, edges or another layer.</div>`;
  }
  function bgControlsHtml() {
    const d = ed.design;
    if (d.background.type === 'color') return `<div class="ed-field"><label>Colour</label><input type="color" id="ed-bg-color" value="${esc(d.background.color || '#151d3a')}"></div>`;
    if (d.background.type === 'gradient') return `
      <div class="ed-row">
        <div class="ed-field"><label>From</label><input type="color" id="ed-bg-from" value="${esc(d.background.gradient.from)}"></div>
        <div class="ed-field"><label>To</label><input type="color" id="ed-bg-to" value="${esc(d.background.gradient.to)}"></div>
      </div>
      <div class="ed-field"><label>Angle: <span id="ed-bg-angle-val">${d.background.gradient.angle}°</span></label>
      <input type="range" id="ed-bg-angle" min="0" max="360" value="${d.background.gradient.angle}"></div>`;
    return `<p class="sub" style="font-size:12px;color:var(--muted)">Transparent background — PNG exports keep transparency (shown as a checkerboard). JPG exports flatten onto white.</p>`;
  }
  function bindCanvasTab(panel) {
    panel.querySelector('#ed-size-preset').addEventListener('change', (e) => {
      const s = ed.sizes.find((x) => x.id === e.target.value);
      if (!s) return;
      panel.querySelector('#ed-cw').value = s.width;
      panel.querySelector('#ed-ch').value = s.height;
    });
    panel.querySelector('#ed-apply-size').addEventListener('click', () => {
      const w = clamp(parseInt(panel.querySelector('#ed-cw').value, 10) || ed.design.width, 10, 8000);
      const h = clamp(parseInt(panel.querySelector('#ed-ch').value, 10) || ed.design.height, 10, 8000);
      pushHistory();
      ed.design.width = w; ed.design.height = h;
      computeZoom(); renderAll(); scheduleSave();
      toast(`Canvas resized to ${w}×${h}px.`);
    });
    panel.querySelector('#ed-magic-resize').addEventListener('click', async () => {
      const btn = panel.querySelector('#ed-magic-resize');
      const targetId = panel.querySelector('#ed-magic-size').value;
      btn.disabled = true;
      btn.textContent = 'Resizing…';
      try {
        const res = await api('/api/magic/resize', { method: 'POST', body: JSON.stringify({ design: ed.design, targetSizeId: targetId }) });
        pushHistory();
        ed.design = res.design;
        computeZoom();
        renderAll();
        scheduleSave();
        const report = panel.querySelector('#ed-magic-report');
        const attention = res.report.needsAttention || [];
        if (report) {
          report.innerHTML = `<p class="ed-note">✅ Reflowed to ${res.report.to.width}×${res.report.to.height}px (${(res.design.layers || []).length} layers).</p>`
            + (attention.length ? `<p class="ed-note" style="color:var(--danger, #dc2626)">⚠️ Needs attention: ${attention.map((a) => `${esc(a.name)} — ${esc(a.reason)}${a.suggestedText ? ` (try: “${esc(a.suggestedText)}”)` : ''}`).join('; ')}</p>` : '');
        }
        toast('Magic Resize done.');
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '🪄 Magic Resize';
      }
    });
    panel.querySelector('#ed-bg-type').addEventListener('change', (e) => {
      pushHistory();
      ed.design.background.type = e.target.value;
      renderStage(); renderLeftPanel(); scheduleSave();
    });
    const col = panel.querySelector('#ed-bg-color');
    if (col) col.addEventListener('input', () => { ed.design.background.color = col.value; renderStage(); scheduleSave(); });
    const from = panel.querySelector('#ed-bg-from');
    if (from) from.addEventListener('input', () => { ed.design.background.gradient.from = from.value; renderStage(); scheduleSave(); });
    const to = panel.querySelector('#ed-bg-to');
    if (to) to.addEventListener('input', () => { ed.design.background.gradient.to = to.value; renderStage(); scheduleSave(); });
    const ang = panel.querySelector('#ed-bg-angle');
    if (ang) ang.addEventListener('input', () => {
      ed.design.background.gradient.angle = parseInt(ang.value, 10);
      panel.querySelector('#ed-bg-angle-val').textContent = `${ang.value}°`;
      renderStage(); scheduleSave();
    });
    panel.querySelector('#ed-grid').addEventListener('change', (e) => { ed.grid = e.target.checked; renderStage(); });
    panel.querySelector('#ed-rulers').addEventListener('change', (e) => { ed.rulers = e.target.checked; renderStage(); });
  }

  function addTabHtml() {
    return `
    <h4>Text</h4>
    <div class="ed-btnrow">
      <button class="btn btn-sm" data-add="heading">Heading</button>
      <button class="btn btn-sm" data-add="subheading">Subheading</button>
      <button class="btn btn-sm" data-add="text">Text box</button>
    </div>
    <h4>Shapes</h4>
    <div class="ed-btnrow">
      <button class="btn btn-sm" data-add="rect">▭ Rectangle</button>
      <button class="btn btn-sm" data-add="ellipse">◯ Circle</button>
      <button class="btn btn-sm" data-add="triangle">△ Triangle</button>
      <button class="btn btn-sm" data-add="line">― Line</button>
    </div>
    <h4>Images</h4>
    <p class="sub" style="font-size:12px;color:var(--muted)">Add photos from your Media Library.</p>
    <div class="ed-btnrow"><button class="btn btn-sm btn-primary" id="ed-goto-media">Open Media Library →</button></div>
    <div class="ed-note"><b>Tip:</b> new layers appear in the centre of the canvas and are selected, so you can style them in the right panel right away.</div>`;
  }
  function bindAddTab(panel) {
    panel.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      const d = ed.design;
      const cx = d.width / 2, cy = d.height / 2;
      if (b.dataset.add === 'heading') addLayer(textLayer(cx - 300, cy - 60, 'Your headline', { fontSize: 96, w: 600, h: 120 }));
      else if (b.dataset.add === 'subheading') addLayer(textLayer(cx - 300, cy - 30, 'Your subheading', { fontSize: 40, fontWeight: 500, w: 600, h: 60 }));
      else if (b.dataset.add === 'text') addLayer(textLayer(cx - 250, cy - 30, 'Add your text here', { fontSize: 32, fontWeight: 400, w: 500, h: 50 }));
      else if (b.dataset.add === 'rect') addLayer(shapeLayer('rect', cx - 150, cy - 100, 300, 200, {}));
      else if (b.dataset.add === 'ellipse') addLayer(shapeLayer('ellipse', cx - 150, cy - 150, 300, 300, { fill: '#22d3ee' }));
      else if (b.dataset.add === 'triangle') addLayer(shapeLayer('triangle', cx - 150, cy - 130, 300, 260, { fill: '#f59e0b' }));
      else if (b.dataset.add === 'line') addLayer(shapeLayer('line', cx - 200, cy - 4, 400, 8, { fill: '#ffffff', stroke: '#ffffff', strokeWidth: 6 }));
    }));
    panel.querySelector('#ed-goto-media').addEventListener('click', () => { ed.leftTab = 'media'; renderLeftPanel(); });
  }

  function addLayer(layer) {
    pushHistory();
    ed.design.layers.push(layer);
    select([layer.id]);
    renderStage();
    renderLayersPanelIfActive();
    scheduleSave();
  }

  function renderLayersPanel() {
    const panel = document.getElementById('ed-left-panel');
    if (!panel || !ed) return;
    const layers = [...ed.design.layers].reverse();
    panel.innerHTML = `
    <h4>Layers (${ed.design.layers.length}) — top is front</h4>
    ${layers.length ? `<div class="ed-layers-list">${layers.map((l) => `
      <div class="ed-layer-row ${ed.selection.includes(l.id) ? 'sel' : ''}" data-layer="${l.id}">
        <span>${l.type === 'text' ? 'T' : l.type === 'image' ? '🖼' : l.shape && l.shape.kind === 'ellipse' ? '◯' : l.shape && l.shape.kind === 'triangle' ? '△' : '▭'}</span>
        <span class="nm" title="${esc(l.name)}${l.groupId ? ' · grouped' : ''}">${esc(l.name)}${l.groupId ? ' ◈' : ''}</span>
        <button class="mini" data-act="up" title="Bring forward">↑</button>
        <button class="mini" data-act="down" title="Send backward">↓</button>
        <button class="mini" data-act="eye" title="${l.hidden ? 'Show' : 'Hide'}">${l.hidden ? '—' : '👁'}</button>
        <button class="mini" data-act="lock" title="${l.locked ? 'Unlock' : 'Lock'}">${l.locked ? '🔒' : '🔓'}</button>
        <button class="mini" data-act="del" title="Delete">✕</button>
      </div>`).join('')}</div>
      <div class="ed-note">Double-click a layer name to rename it. Shift-click selects several layers; grouped layers (◈) move together.</div>`
    : '<div class="empty" style="padding:20px"><p>No layers yet.</p><p style="margin-top:6px">Use the Add tab to add text, shapes or images.</p></div>'}`;
    panel.querySelectorAll('.ed-layer-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-act]')) return;
        select([row.dataset.layer], e.shiftKey || e.metaKey || e.ctrlKey);
      });
      row.addEventListener('dblclick', () => renameLayer(row.dataset.layer));
      row.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = row.dataset.layer;
        const act = btn.dataset.act;
        if (act === 'up') moveLayer(id, 1);
        else if (act === 'down') moveLayer(id, -1);
        else if (act === 'eye') toggleHide(id);
        else if (act === 'lock') toggleLock(id);
        else if (act === 'del') { select([id]); deleteSelection(); }
      }));
    });
  }

  function templatesTabHtml() {
    return `
    <h4>Starter templates</h4>
    <p class="sub" style="font-size:12px;color:var(--muted);margin-bottom:10px">Click a template to load it as editable layers into this design.</p>
    ${ed.templates.map((t) => `
      <button class="ed-template-card" data-template="${esc(t.id)}">
        <span class="thumb">${t.width}×${t.height}</span>
        <span><span class="t">${esc(t.name)}</span><br><span class="m">${esc(t.category)} · ${esc(t.size || '')}${t.builtin ? '' : ' · yours'}</span></span>
      </button>`).join('') || '<p class="sub">No templates available.</p>'}
    <div class="ed-btnrow"><button class="btn btn-sm btn-primary" id="ed-save-template">Save current design as template</button></div>
    <div class="ed-note">Templates from the <b>Templates Marketplace</b> (remote/community templates) are not built yet — that is a Phase 8 feature. These built-in and saved templates are local and fully editable.</div>`;
  }
  function bindTemplatesTab(panel) {
    panel.querySelectorAll('[data-template]').forEach((b) => b.addEventListener('click', () => loadTemplate(b.dataset.template)));
    panel.querySelector('#ed-save-template').addEventListener('click', async () => {
      const name = prompt('Template name', ed.projectName);
      if (!name || !name.trim()) return;
      try {
        const r = await api('/api/design/templates', { method: 'POST', body: JSON.stringify({ name: name.trim(), content: ed.design }) });
        ed.templates.push({ ...r.template, design: ed.design });
        toast(`Template "${name.trim()}" saved.`);
        renderLeftPanel();
      } catch (e) { toast(e.message, true); }
    });
  }
  async function loadTemplate(id) {
    try {
      const r = await api(`/api/design/templates/${encodeURIComponent(id)}`);
      const t = r.template;
      if (ed.design.layers.length && !confirm(`Load "${t.name}"? This replaces the current design (it is autosaved as a version first).`)) return;
      await saveDesign(true);
      pushHistory();
      ed.design = deep(t.design);
      ed.selection = [];
      computeZoom();
      renderAll();
      scheduleSave();
      toast(`Template "${t.name}" loaded — every layer is editable.`);
    } catch (e) { toast(e.message, true); }
  }

  function mediaTabHtml() {
    return `
    <h4>Your images</h4>
    <div class="ed-btnrow" style="margin-bottom:10px">
      <button class="btn btn-sm btn-primary" id="ed-upload-media">⬆ Upload image</button>
      <input type="file" id="ed-media-file" accept="image/*" style="display:none">
    </div>
    ${ed.media.length ? `<div class="ed-thumb-grid">${ed.media.slice(0, 60).map((m) => `
      <button class="ed-thumb" data-media="${m.id}" title="${esc(m.originalName)}">
        <img src="${m.url}" alt="" loading="lazy"><span class="cap">${esc(m.originalName)}</span>
      </button>`).join('')}</div>`
    : '<div class="empty" style="padding:20px"><p>No images in your library yet.</p><p style="margin-top:6px">Upload one to use it in a design.</p></div>'}`;
  }
  function bindMediaTab(panel) {
    const input = panel.querySelector('#ed-media-file');
    panel.querySelector('#ed-upload-media').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('file', f);
      try {
        const r = await apiForm('/api/media/upload', fd);
        ed.media.unshift(r.media);
        toast('Image uploaded to your Media Library.');
        renderLeftPanel();
      } catch (e) { toast(e.message, true); }
    });
    panel.querySelectorAll('[data-media]').forEach((b) => b.addEventListener('click', () => {
      const m = ed.media.find((x) => String(x.id) === b.dataset.media);
      if (m) addImageFromMedia(m);
    }));
  }
  async function addImageFromMedia(m) {
    try {
      const img = await loadImageEl(m.url);
      const maxSide = 600;
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const d = ed.design;
      addLayer(imageLayer(Math.round((d.width - w) / 2), Math.round((d.height - h) / 2), w, h, m.url, m.id));
      toast('Image added — drag to move, use the right panel for filters and crop.');
    } catch (e) {
      toast('Could not load that image: ' + e.message, true);
    }
  }

  function brandTabHtml() {
    return `
    <h4>Your brands</h4>
    ${ed.brands.length ? ed.brands.map((b) => `
      <div class="ed-brand-card">
        <div class="t">${esc(b.name)}</div>
        <div class="ed-swatches">
          <span class="ed-swatch" style="background:${esc(b.primaryColor)}" title="Primary ${esc(b.primaryColor)}"></span>
          <span class="ed-swatch" style="background:${esc(b.secondaryColor)}" title="Secondary ${esc(b.secondaryColor)}"></span>
          <span class="ed-swatch" style="background:${esc(b.accentColor)}" title="Accent ${esc(b.accentColor)}"></span>
        </div>
        <div class="m" style="font-size:11px;color:var(--muted);margin-top:6px">${esc(b.fontHeading)} / ${esc(b.fontBody)}</div>
        <div class="ed-btnrow">
          <button class="btn btn-sm" data-apply-design="${b.id}">Apply to design</button>
          <button class="btn btn-sm" data-apply-sel="${b.id}">Apply to selected</button>
        </div>
      </div>`).join('') : '<p class="sub" style="font-size:12px;color:var(--muted)">No brands yet. Create one in Brand Kit and it will appear here.</p>'}
    <div class="ed-btnrow"><button class="btn btn-sm" id="ed-open-brandkit">Open Brand Kit →</button></div>
    <div class="ed-note"><b>Apply to design</b> sets the background to the brand primary colour and all text to the brand heading font. <b>Apply to selected</b> sets the selected text/shape to the brand fonts and colours. Click a swatch below a selected layer's properties to recolour it.</div>`;
  }
  function bindBrandTab(panel) {
    panel.querySelectorAll('[data-apply-design]').forEach((b) => b.addEventListener('click', () => {
      const brand = ed.brands.find((x) => String(x.id) === b.dataset.applyDesign);
      if (!brand) return;
      pushHistory();
      ed.design.background = { type: 'color', color: brand.primaryColor, gradient: { from: brand.primaryColor, to: brand.secondaryColor, angle: 135 } };
      for (const l of ed.design.layers) if (l.type === 'text') l.text.fontFamily = brand.fontHeading;
      renderAll(); scheduleSave();
      toast(`Brand "${brand.name}" applied to this design.`);
    }));
    panel.querySelectorAll('[data-apply-sel]').forEach((b) => b.addEventListener('click', () => {
      const brand = ed.brands.find((x) => String(x.id) === b.dataset.applySel);
      const sel = selectedLayers();
      if (!brand) return;
      if (!sel.length) { toast('Select a layer first.'); return; }
      pushHistory();
      for (const l of sel) {
        if (l.type === 'text') { l.text.fontFamily = brand.fontHeading; l.text.color = brand.accentColor; }
        if (l.type === 'shape') l.shape.fill = brand.primaryColor;
      }
      renderStage(); renderProps(); scheduleSave();
      toast(`Brand "${brand.name}" applied to ${sel.length} layer${sel.length === 1 ? '' : 's'}.`);
    }));
    panel.querySelector('#ed-open-brandkit').addEventListener('click', async () => { await saveDesign(false); close(); go('brand-kit'); });
  }

  /* ---------- Properties panel ---------- */
  function setPathValue(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = value;
  }
  function getPathValue(obj, path) {
    return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
  }
  function beginEdit() {
    if (!ed.historyArmed) { pushHistory(); ed.historyArmed = true; }
  }
  function updateLayerEl(layer) {
    const old = document.querySelector(`#ed-canvas .ed-layer[data-id="${CSS.escape(layer.id)}"]`);
    if (!old) { renderStage(); return; }
    old.replaceWith(createLayerEl(layer));
    updateSelectionUI();
  }
  function bindPropInputs(root, layer) {
    root.querySelectorAll('[data-prop]').forEach((el) => {
      const isRangeOrColor = el.type === 'range' || el.type === 'color';
      el.addEventListener('input', () => {
        let v = el.value;
        if (el.type === 'number') {
          v = parseFloat(v);
          if (!Number.isFinite(v)) return; // empty while typing — wait for a valid number
        }
        beginEdit();
        if (el.dataset.prop === 'opacity') v = clamp(parseFloat(el.value) || 0, 0, 100) / 100;
        setPathValue(layer, el.dataset.prop, v);
        updateLayerEl(layer);
        scheduleSave();
      });
      el.addEventListener('change', () => {
        if (!ed.historyArmed) pushHistory();
        ed.historyArmed = false;
        let v = el.value;
        if (el.type === 'number') {
          v = parseFloat(v);
          if (!Number.isFinite(v)) { toast('Enter a valid number.'); renderProps(); return; }
        }
        if (el.dataset.prop === 'opacity') v = clamp(parseFloat(el.value) || 0, 0, 100) / 100;
        setPathValue(layer, el.dataset.prop, v);
        renderStage();
        renderProps();
        scheduleSave();
      });
    });
    root.querySelectorAll('[data-prop-check]').forEach((el) => {
      el.addEventListener('change', () => {
        pushHistory();
        setPathValue(layer, el.dataset.propCheck, el.checked);
        renderStage(); renderProps(); scheduleSave();
      });
    });
  }

  /* ---------- Magic Animate (v2.2.2) ---------- */
  function animateSectionHtml(l) {
    const a = l.animation;
    const options = (ed.animPresets || []).map((p) => `<option value="${p.id}" ${a && a.presetId === p.id ? 'selected' : ''}>${esc(p.name)} — ${esc(p.description)}</option>`).join('');
    return `
      <h4>🪄 Animate</h4>
      <div class="ed-field"><label>Preset</label><select id="ed-anim-preset">${options || '<option value="">No presets loaded</option>'}</select></div>
      ${a ? `<div class="kv"><span>Current</span><span>${esc(a.presetId)} · ${a.durationMs}ms${a.loop ? ' · loops' : ''}</span></div>` : '<p class="ed-note">No animation on this layer yet.</p>'}
      <div class="ed-btnrow">
        <button class="btn btn-sm" id="ed-anim-apply">Apply preset</button>
        ${a ? '<button class="btn btn-sm" id="ed-anim-preview">▶ Preview</button><button class="btn btn-sm" id="ed-anim-remove">Remove</button>' : ''}
      </div>
      <p class="ed-note">The animation previews live on the canvas with CSS. In video, clip presets become real keyframes.</p>`;
  }

  function bindAnimateSection(right, l) {
    const apply = right.querySelector('#ed-anim-apply');
    if (apply) apply.addEventListener('click', async () => {
      const presetId = right.querySelector('#ed-anim-preset').value;
      if (!presetId) { toast('No preset selected.'); return; }
      apply.disabled = true;
      apply.textContent = 'Applying…';
      try {
        const res = await api('/api/magic/animate', { method: 'POST', body: JSON.stringify({ design: ed.design, layerId: l.id, presetId }) });
        pushHistory();
        ed.design = res.design;
        renderStage();
        renderProps();
        scheduleSave();
        toast('Animation applied — previewing on the canvas.');
      } catch (err) {
        toast(err.message);
      } finally {
        apply.disabled = false;
        apply.textContent = 'Apply preset';
      }
    });
    const preview = right.querySelector('#ed-anim-preview');
    if (preview) preview.addEventListener('click', () => {
      const el = document.querySelector(`#ed-canvas .ed-layer[data-id="${l.id}"]`);
      if (el && el.firstChild) {
        // Restart the CSS animation by re-applying it.
        const anim = el.firstChild.style.animation;
        el.firstChild.style.animation = 'none';
        void el.firstChild.offsetWidth; // reflow
        el.firstChild.style.animation = anim;
      }
    });
    const remove = right.querySelector('#ed-anim-remove');
    if (remove) remove.addEventListener('click', () => {
      pushHistory();
      l.animation = null;
      renderStage();
      renderProps();
      scheduleSave();
      toast('Animation removed.');
    });
  }

  function renderProps() {
    const right = document.getElementById('ed-right');
    if (!right || !ed) return;
    const sel = selectedLayers();
    if (sel.length === 0) {
      right.innerHTML = `
      <h4>Design</h4>
      <div class="kv"><span>Canvas</span><span>${ed.design.width} × ${ed.design.height}px</span></div>
      <div class="kv"><span>Layers</span><span>${ed.design.layers.length}</span></div>
      <div class="kv"><span>Background</span><span>${esc(ed.design.background.type)}</span></div>
      <p class="sub" style="font-size:12px;color:var(--muted);margin-top:10px">Click a layer on the canvas (or in the Layers tab) to edit it. Use the Canvas tab on the left to change the size and background.</p>
      <div class="ed-btnrow"><button class="btn btn-sm" id="ed-props-add-text">＋ Add text</button>
      <button class="btn btn-sm" id="ed-props-add-shape">＋ Add shape</button></div>`;
      right.querySelector('#ed-props-add-text').addEventListener('click', () => { ed.leftTab = 'add'; renderLeftPanel(); });
      right.querySelector('#ed-props-add-shape').addEventListener('click', () => { ed.leftTab = 'add'; renderLeftPanel(); });
      return;
    }
    if (sel.length > 1) {
      right.innerHTML = `
      <h4>${sel.length} layers selected</h4>
      <div class="ed-btnrow">
        <button class="btn btn-sm" data-align="left">⇤ Left</button>
        <button class="btn btn-sm" data-align="center">↔ Centre</button>
        <button class="btn btn-sm" data-align="right">⇥ Right</button>
      </div>
      <div class="ed-btnrow">
        <button class="btn btn-sm" data-align="top">⇪ Top</button>
        <button class="btn btn-sm" data-align="middle">↕ Middle</button>
        <button class="btn btn-sm" data-align="bottom">⇫ Bottom</button>
      </div>
      <div class="ed-btnrow">
        <button class="btn btn-sm" data-dist="h">Distribute ↔</button>
        <button class="btn btn-sm" data-dist="v">Distribute ↕</button>
      </div>
      <div class="ed-btnrow">
        <button class="btn btn-sm" id="ed-multi-group">Group</button>
        <button class="btn btn-sm" id="ed-multi-ungroup">Ungroup</button>
        <button class="btn btn-sm btn-danger" id="ed-multi-del">Delete all</button>
      </div>
      <div class="ed-note">Alignment uses the bounding box of the selected layers. With a single layer selected, alignment is relative to the whole canvas.</div>`;
      right.querySelectorAll('[data-align]').forEach((b) => b.addEventListener('click', () => alignSelection(b.dataset.align)));
      right.querySelectorAll('[data-dist]').forEach((b) => b.addEventListener('click', () => distributeSelection(b.dataset.dist)));
      right.querySelector('#ed-multi-group').addEventListener('click', groupSelection);
      right.querySelector('#ed-multi-ungroup').addEventListener('click', ungroupSelection);
      right.querySelector('#ed-multi-del').addEventListener('click', deleteSelection);
      return;
    }
    const l = sel[0];
    const common = `
      <h4>${esc(l.name)} · ${l.type}${l.groupId ? ' · grouped ◈' : ''}</h4>
      <div class="ed-row">
        <div class="ed-field"><label>X</label><input type="number" data-prop="x" value="${Math.round(l.x)}"></div>
        <div class="ed-field"><label>Y</label><input type="number" data-prop="y" value="${Math.round(l.y)}"></div>
      </div>
      <div class="ed-row">
        <div class="ed-field"><label>Width</label><input type="number" data-prop="w" value="${Math.round(l.w)}" min="1"></div>
        <div class="ed-field"><label>Height</label><input type="number" data-prop="h" value="${Math.round(l.h)}" min="1"></div>
      </div>
      <div class="ed-row">
        <div class="ed-field"><label>Rotation°</label><input type="number" data-prop="rotation" value="${Math.round(l.rotation || 0)}" min="-360" max="360"></div>
        <div class="ed-field"><label>Opacity %</label><input type="range" data-prop="opacity" value="${Math.round(l.opacity * 100)}" min="0" max="100"></div>
      </div>
      <div class="ed-btnrow">
        <button class="btn btn-sm" data-align="left">⇤</button>
        <button class="btn btn-sm" data-align="center">↔</button>
        <button class="btn btn-sm" data-align="right">⇥</button>
        <button class="btn btn-sm" data-align="top">⇪</button>
        <button class="btn btn-sm" data-align="middle">↕</button>
        <button class="btn btn-sm" data-align="bottom">⇫</button>
      </div>
      <div class="ed-btnrow">
        <button class="btn btn-sm" id="ed-p-lock">${l.locked ? '🔓 Unlock' : '🔒 Lock'}</button>
        <button class="btn btn-sm" id="ed-p-hide">${l.hidden ? '👁 Show' : '— Hide'}</button>
        <button class="btn btn-sm" id="ed-p-dup">Duplicate</button>
        <button class="btn btn-sm btn-danger" id="ed-p-del">Delete</button>
      </div>
      <div class="ed-btnrow">
        <button class="btn btn-sm" id="ed-p-fwd">Bring forward</button>
        <button class="btn btn-sm" id="ed-p-back">Send backward</button>
      </div>`;
    let specific = '';
    if (l.type === 'text') {
      const t = l.text;
      specific = `
      <h4>Text</h4>
      <div class="ed-field"><label>Content</label><textarea data-prop="text.text" rows="3">${esc(t.text)}</textarea></div>
      <div class="ed-row">
        <div class="ed-field"><label>Font</label><select data-prop="text.fontFamily">${ed.fonts.map((f) => `<option ${f === t.fontFamily ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div>
        <div class="ed-field"><label>Size</label><input type="number" data-prop="text.fontSize" value="${t.fontSize}" min="6" max="1000"></div>
      </div>
      <div class="ed-row">
        <div class="ed-field"><label>Weight</label><select data-prop="text.fontWeight">${[400, 500, 700, 800, 900].map((w) => `<option value="${w}" ${t.fontWeight === w ? 'selected' : ''}>${w}</option>`).join('')}</select></div>
        <div class="ed-field"><label>Style</label><select data-prop="text.fontStyle"><option value="normal" ${t.fontStyle === 'normal' ? 'selected' : ''}>Normal</option><option value="italic" ${t.fontStyle === 'italic' ? 'selected' : ''}>Italic</option></select></div>
      </div>
      <div class="ed-row">
        <div class="ed-field"><label>Align</label><select data-prop="text.align">${['left', 'center', 'right'].map((a) => `<option ${t.align === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
        <div class="ed-field"><label>Colour</label><input type="color" data-prop="text.color" value="${esc(t.color)}"></div>
      </div>
      <div class="ed-row">
        <div class="ed-field"><label>Letter spacing: <span id="ed-ls-val">${t.letterSpacing}px</span></label><input type="range" data-prop="text.letterSpacing" value="${t.letterSpacing}" min="-5" max="20"></div>
        <div class="ed-field"><label>Line height: <span id="ed-lh-val">${t.lineHeight}</span></label><input type="range" data-prop="text.lineHeight" value="${t.lineHeight}" min="0.8" max="2" step="0.1"></div>
      </div>
      <div class="ed-field"><label><input type="checkbox" data-prop-check="text.underline" ${t.underline ? 'checked' : ''} style="width:auto"> Underline</label></div>
      <div class="ed-field"><label><input type="checkbox" id="ed-t-shadow" ${t.shadow ? 'checked' : ''} style="width:auto"> Text shadow</label></div>
      ${t.shadow ? `<div class="ed-row">
        <div class="ed-field"><label>Shadow colour</label><input type="color" id="ed-t-shadow-color" value="${esc(t.shadow.color)}"></div>
        <div class="ed-field"><label>Blur: <span id="ed-t-shadow-blur-val">${t.shadow.blur}px</span></label><input type="range" id="ed-t-shadow-blur" value="${t.shadow.blur}" min="0" max="40"></div>
      </div>` : ''}
      <div class="ed-field"><label><input type="checkbox" id="ed-t-stroke" ${t.stroke ? 'checked' : ''} style="width:auto"> Text outline</label></div>
      ${t.stroke ? `<div class="ed-row">
        <div class="ed-field"><label>Outline colour</label><input type="color" id="ed-t-stroke-color" value="${esc(t.stroke.color)}"></div>
        <div class="ed-field"><label>Width: <span id="ed-t-stroke-w-val">${t.stroke.width}px</span></label><input type="range" id="ed-t-stroke-w" value="${t.stroke.width}" min="1" max="20"></div>
      </div>` : ''}
      <div class="ed-field"><label><input type="checkbox" id="ed-t-grad" ${t.gradient ? 'checked' : ''} style="width:auto"> Gradient text</label></div>
      ${t.gradient ? `<div class="ed-row">
        <div class="ed-field"><label>From</label><input type="color" id="ed-t-grad-from" value="${esc(t.gradient.from)}"></div>
        <div class="ed-field"><label>To</label><input type="color" id="ed-t-grad-to" value="${esc(t.gradient.to)}"></div>
      </div>` : ''}
      <div class="ed-field"><label>Brand colours</label><div class="ed-swatches">
        ${ed.brands.flatMap((b) => [b.primaryColor, b.secondaryColor, b.accentColor]).map((c) => `<button class="ed-swatch" data-swatch="${esc(c)}" style="background:${esc(c)}" title="${esc(c)}"></button>`).join('') || '<span style="font-size:12px;color:var(--muted)">No brands yet — create one in Brand Kit.</span>'}
      </div></div>`;
    } else if (l.type === 'shape') {
      const s = l.shape;
      specific = `
      <h4>Shape</h4>
      <div class="ed-field"><label>Kind</label><select data-prop="shape.kind">${['rect', 'ellipse', 'triangle', 'line'].map((k) => `<option ${s.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="ed-row">
        <div class="ed-field"><label>Fill</label><input type="color" data-prop="shape.fill" value="${esc(s.fill || '#7c5cff')}"></div>
        <div class="ed-field"><label>Stroke</label><input type="color" data-prop="shape.stroke" value="${esc(s.stroke || '#000000')}"></div>
      </div>
      <div class="ed-row">
        <div class="ed-field"><label>Stroke width: <span id="ed-sw-val">${s.strokeWidth}px</span></label><input type="range" data-prop="shape.strokeWidth" value="${s.strokeWidth}" min="0" max="40"></div>
        ${s.kind === 'rect' ? `<div class="ed-field"><label>Corner radius: <span id="ed-rad-val">${s.radius}px</span></label><input type="range" data-prop="shape.radius" value="${s.radius}" min="0" max="200"></div>` : ''}
      </div>
      <div class="ed-field"><label><input type="checkbox" id="ed-s-shadow" ${s.shadow ? 'checked' : ''} style="width:auto"> Drop shadow</label></div>
      ${s.shadow ? `<div class="ed-row">
        <div class="ed-field"><label>Shadow colour</label><input type="color" id="ed-s-shadow-color" value="${esc(s.shadow.color)}"></div>
        <div class="ed-field"><label>Blur: <span id="ed-s-shadow-blur-val">${s.shadow.blur}px</span></label><input type="range" id="ed-s-shadow-blur" value="${s.shadow.blur}" min="0" max="40"></div>
      </div>` : ''}
      <div class="ed-field"><label>Brand colours</label><div class="ed-swatches">
        ${ed.brands.flatMap((b) => [b.primaryColor, b.secondaryColor, b.accentColor]).map((c) => `<button class="ed-swatch" data-swatch-fill="${esc(c)}" style="background:${esc(c)}" title="${esc(c)}"></button>`).join('') || '<span style="font-size:12px;color:var(--muted)">No brands yet — create one in Brand Kit.</span>'}
      </div></div>`;
    } else if (l.type === 'image') {
      const im = l.image;
      const f = im.filters;
      specific = `
      <h4>Image</h4>
      <div class="kv"><span>Source</span><span>${im.mediaId ? 'Media Library #' + im.mediaId : 'External URL'}</span></div>
      <h4>Filters</h4>
      ${[['Grayscale', 'image.filters.grayscale', f.grayscale, '%'], ['Sepia', 'image.filters.sepia', f.sepia, '%'], ['Brightness', 'image.filters.brightness', f.brightness, '%'], ['Contrast', 'image.filters.contrast', f.contrast, '%'], ['Saturation', 'image.filters.saturate', f.saturate, '%']].map(([label, path, val, unit]) => `
        <div class="ed-field"><label>${label}: <span>${val}${unit}</span></label><input type="range" data-prop="${path}" value="${val}" min="0" max="${label === 'Brightness' || label === 'Contrast' || label === 'Saturation' ? 200 : 100}"></div>`).join('')}
      <h4>Flip</h4>
      <div class="ed-btnrow">
        <button class="btn btn-sm" id="ed-flip-h">${im.flipH ? '✓ ' : ''}Flip horizontal</button>
        <button class="btn btn-sm" id="ed-flip-v">${im.flipV ? '✓ ' : ''}Flip vertical</button>
      </div>
      <h4>Crop (%)</h4>
      ${[['Left', 'image.crop.left', im.crop.left], ['Top', 'image.crop.top', im.crop.top], ['Right', 'image.crop.right', im.crop.right], ['Bottom', 'image.crop.bottom', im.crop.bottom]].map(([label, path, val]) => `
        <div class="ed-field"><label>${label}: <span>${val}%</span></label><input type="range" data-prop="${path}" value="${val}" min="0" max="40"></div>`).join('')}
      <div class="ed-note">Filters and crop are applied to the real image and are included in PNG/JPG exports.</div>`;
    }
    right.innerHTML = common + specific + animateSectionHtml(l);
    bindPropInputs(right, l);
    bindAnimateSection(right, l);
    right.querySelectorAll('[data-align]').forEach((b) => b.addEventListener('click', () => alignSelection(b.dataset.align)));
    right.querySelector('#ed-p-lock').addEventListener('click', () => toggleLock(l.id));
    right.querySelector('#ed-p-hide').addEventListener('click', () => toggleHide(l.id));
    right.querySelector('#ed-p-dup').addEventListener('click', () => { select([l.id]); duplicateSelection(); });
    right.querySelector('#ed-p-del').addEventListener('click', () => { select([l.id]); deleteSelection(); });
    right.querySelector('#ed-p-fwd').addEventListener('click', () => moveLayer(l.id, 1));
    right.querySelector('#ed-p-back').addEventListener('click', () => moveLayer(l.id, -1));
    right.querySelectorAll('[data-swatch]').forEach((b) => b.addEventListener('click', () => {
      pushHistory();
      l.text.color = b.dataset.swatch;
      l.text.gradient = null;
      renderStage(); renderProps(); scheduleSave();
    }));
    right.querySelectorAll('[data-swatch-fill]').forEach((b) => b.addEventListener('click', () => {
      pushHistory();
      l.shape.fill = b.dataset.swatchFill;
      renderStage(); renderProps(); scheduleSave();
    }));
    if (l.type === 'text') {
      const t = l.text;
      const shadowBox = right.querySelector('#ed-t-shadow');
      if (shadowBox) shadowBox.addEventListener('change', () => {
        pushHistory();
        t.shadow = shadowBox.checked ? { color: '#000000', blur: 8, offsetX: 2, offsetY: 2 } : null;
        renderStage(); renderProps(); scheduleSave();
      });
      const sc = right.querySelector('#ed-t-shadow-color');
      if (sc) sc.addEventListener('input', () => { t.shadow.color = sc.value; updateLayerEl(l); scheduleSave(); });
      const sb = right.querySelector('#ed-t-shadow-blur');
      if (sb) sb.addEventListener('input', () => { t.shadow.blur = parseInt(sb.value, 10); right.querySelector('#ed-t-shadow-blur-val').textContent = `${sb.value}px`; updateLayerEl(l); scheduleSave(); });
      const strokeBox = right.querySelector('#ed-t-stroke');
      if (strokeBox) strokeBox.addEventListener('change', () => {
        pushHistory();
        t.stroke = strokeBox.checked ? { color: '#000000', width: 2 } : null;
        renderStage(); renderProps(); scheduleSave();
      });
      const stc = right.querySelector('#ed-t-stroke-color');
      if (stc) stc.addEventListener('input', () => { t.stroke.color = stc.value; updateLayerEl(l); scheduleSave(); });
      const stw = right.querySelector('#ed-t-stroke-w');
      if (stw) stw.addEventListener('input', () => { t.stroke.width = parseInt(stw.value, 10); right.querySelector('#ed-t-stroke-w-val').textContent = `${stw.value}px`; updateLayerEl(l); scheduleSave(); });
      const gradBox = right.querySelector('#ed-t-grad');
      if (gradBox) gradBox.addEventListener('change', () => {
        pushHistory();
        t.gradient = gradBox.checked ? { from: '#ffffff', to: '#22d3ee' } : null;
        renderStage(); renderProps(); scheduleSave();
      });
      const gf = right.querySelector('#ed-t-grad-from');
      if (gf) gf.addEventListener('input', () => { t.gradient.from = gf.value; updateLayerEl(l); scheduleSave(); });
      const gt = right.querySelector('#ed-t-grad-to');
      if (gt) gt.addEventListener('input', () => { t.gradient.to = gt.value; updateLayerEl(l); scheduleSave(); });
    }
    if (l.type === 'shape') {
      const s = l.shape;
      const shadowBox = right.querySelector('#ed-s-shadow');
      if (shadowBox) shadowBox.addEventListener('change', () => {
        pushHistory();
        s.shadow = shadowBox.checked ? { color: '#000000', blur: 12, offsetX: 0, offsetY: 6 } : null;
        renderStage(); renderProps(); scheduleSave();
      });
      const sc = right.querySelector('#ed-s-shadow-color');
      if (sc) sc.addEventListener('input', () => { s.shadow.color = sc.value; updateLayerEl(l); scheduleSave(); });
      const sb = right.querySelector('#ed-s-shadow-blur');
      if (sb) sb.addEventListener('input', () => { s.shadow.blur = parseInt(sb.value, 10); right.querySelector('#ed-s-shadow-blur-val').textContent = `${sb.value}px`; updateLayerEl(l); scheduleSave(); });
    }
    if (l.type === 'image') {
      const im = l.image;
      right.querySelector('#ed-flip-h').addEventListener('click', () => { pushHistory(); im.flipH = !im.flipH; renderStage(); renderProps(); scheduleSave(); });
      right.querySelector('#ed-flip-v').addEventListener('click', () => { pushHistory(); im.flipV = !im.flipV; renderStage(); renderProps(); scheduleSave(); });
    }
  }

  /* ---------- Canvas export renderer (real pixels) ---------- */
  function loadImageEl(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Could not load image ' + src));
      im.src = src;
    });
  }
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function wrapText(ctx, text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      const words = para.split(/\s+/).filter((w) => w.length);
      if (!words.length) { out.push(''); continue; }
      let line = '';
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxW && line) { out.push(line); line = word; }
        else line = test;
      }
      if (line) out.push(line);
    }
    return out.length ? out : [''];
  }
  function drawTextLayer(ctx, layer) {
    const t = layer.text;
    const { x, y, w } = layer;
    ctx.font = `${t.fontStyle} ${t.fontWeight} ${t.fontSize}px "${t.fontFamily}", sans-serif`;
    try { ctx.letterSpacing = `${t.letterSpacing}px`; } catch { /* older browsers */ }
    ctx.textAlign = t.align;
    ctx.textBaseline = 'top';
    const lineH = t.fontSize * t.lineHeight;
    const lines = wrapText(ctx, t.text, w);
    if (t.shadow) {
      ctx.shadowColor = t.shadow.color;
      ctx.shadowBlur = t.shadow.blur;
      ctx.shadowOffsetX = t.shadow.offsetX;
      ctx.shadowOffsetY = t.shadow.offsetY;
    }
    let fill;
    if (t.gradient) {
      const g = ctx.createLinearGradient(x, y, x + w, y);
      g.addColorStop(0, t.gradient.from);
      g.addColorStop(1, t.gradient.to);
      fill = g;
    } else fill = t.color;
    lines.forEach((line, i) => {
      const ly = y + i * lineH;
      const lx = t.align === 'left' ? x : t.align === 'center' ? x + w / 2 : x + w;
      if (t.stroke) {
        ctx.lineWidth = t.stroke.width;
        ctx.strokeStyle = t.stroke.color;
        ctx.strokeText(line, lx, ly);
      }
      ctx.fillStyle = fill;
      ctx.fillText(line, lx, ly);
      if (t.underline) {
        const lw = ctx.measureText(line).width;
        const ux = t.align === 'left' ? x : t.align === 'center' ? x + w / 2 - lw / 2 : x + w - lw;
        ctx.fillRect(ux, ly + t.fontSize * 1.08, lw, Math.max(2, t.fontSize * 0.06));
      }
    });
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    try { ctx.letterSpacing = '0px'; } catch { /* ignore */ }
  }
  function drawShapeLayer(ctx, layer) {
    const s = layer.shape;
    const { x, y, w, h } = layer;
    if (s.shadow) {
      ctx.shadowColor = s.shadow.color;
      ctx.shadowBlur = s.shadow.blur;
      ctx.shadowOffsetX = s.shadow.offsetX;
      ctx.shadowOffsetY = s.shadow.offsetY;
    }
    if (s.kind === 'line') {
      ctx.fillStyle = s.stroke || s.fill || '#ffffff';
      const sw = Math.max(2, s.strokeWidth || 4);
      ctx.fillRect(x, y + h / 2 - sw / 2, w, sw);
    } else if (s.kind === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
      if (s.stroke && s.strokeWidth) { ctx.lineWidth = s.strokeWidth; ctx.strokeStyle = s.stroke; ctx.stroke(); }
    } else if (s.kind === 'triangle') {
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
      if (s.stroke && s.strokeWidth) { ctx.lineWidth = s.strokeWidth; ctx.strokeStyle = s.stroke; ctx.stroke(); }
    } else {
      roundRectPath(ctx, x, y, w, h, s.radius || 0);
      if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
      if (s.stroke && s.strokeWidth) { ctx.lineWidth = s.strokeWidth; ctx.strokeStyle = s.stroke; ctx.stroke(); }
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  async function drawImageLayer(ctx, layer) {
    const im = layer.image;
    const img = await loadImageEl(im.src);
    const { x, y, w, h } = layer;
    const c = im.crop || { left: 0, top: 0, right: 0, bottom: 0 };
    const sx = img.naturalWidth * (c.left / 100);
    const sy = img.naturalHeight * (c.top / 100);
    const sw = img.naturalWidth * (1 - (c.left + c.right) / 100);
    const sh = img.naturalHeight * (1 - (c.top + c.bottom) / 100);
    const f = im.filters;
    ctx.filter = `grayscale(${f.grayscale}%) sepia(${f.sepia}%) brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturate}%)`;
    if (im.flipH || im.flipV) {
      ctx.save();
      ctx.translate(x + (im.flipH ? w : 0), y + (im.flipV ? h : 0));
      ctx.scale(im.flipH ? -1 : 1, im.flipV ? -1 : 1);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    }
    ctx.filter = 'none';
  }

  async function renderToCanvas(design, scale) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(design.width * scale);
    canvas.height = Math.round(design.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    const failed = [];
    if (design.background.type === 'color') {
      ctx.fillStyle = design.background.color;
      ctx.fillRect(0, 0, design.width, design.height);
    } else if (design.background.type === 'gradient') {
      const g = design.background.gradient;
      const ang = ((g.angle || 135) * Math.PI) / 180;
      const cx = design.width / 2, cy = design.height / 2;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const len = Math.hypot(design.width, design.height) / 2;
      const grad = ctx.createLinearGradient(cx - dx * len, cy - dy * len, cx + dx * len, cy + dy * len);
      grad.addColorStop(0, g.from);
      grad.addColorStop(1, g.to);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, design.width, design.height);
    }
    for (const layer of design.layers) {
      if (layer.hidden) continue;
      ctx.save();
      ctx.translate(layer.x + layer.w / 2, layer.y + layer.h / 2);
      ctx.rotate(((layer.rotation || 0) * Math.PI) / 180);
      ctx.translate(-(layer.x + layer.w / 2), -(layer.y + layer.h / 2));
      ctx.globalAlpha = layer.opacity;
      try {
        if (layer.type === 'text') drawTextLayer(ctx, layer);
        else if (layer.type === 'shape') drawShapeLayer(ctx, layer);
        else if (layer.type === 'image') await drawImageLayer(ctx, layer);
      } catch (e) {
        failed.push(layer.name || layer.type);
        ctx.fillStyle = '#26305a';
        ctx.fillRect(layer.x, layer.y, layer.w, layer.h);
        ctx.fillStyle = '#93a0c4';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Image unavailable', layer.x + layer.w / 2, layer.y + layer.h / 2);
      }
      ctx.restore();
    }
    return { canvas, failed };
  }

  async function exportDesign(format) {
    if (!ed) return;
    const scale = parseFloat((document.getElementById('ed-export-scale') || {}).value || '1');
    try {
      const v = await api('/api/design/validate', { method: 'POST', body: JSON.stringify({ design: ed.design }) });
      if (!v.ok) { toast('Cannot export: ' + v.errors.join(' '), true); return; }
    } catch (e) { toast('Export validation failed: ' + e.message, true); return; }
    toast('Rendering export…');
    let out;
    let failed = [];
    try {
      const r = await renderToCanvas(ed.design, scale);
      out = r.canvas;
      failed = r.failed;
    } catch (e) {
      toast('Export failed: ' + e.message, true);
      return;
    }
    if (format === 'jpg') {
      const flat = document.createElement('canvas');
      flat.width = out.width;
      flat.height = out.height;
      const fctx = flat.getContext('2d');
      fctx.fillStyle = '#ffffff';
      fctx.fillRect(0, 0, flat.width, flat.height);
      fctx.drawImage(out, 0, 0);
      out = flat;
    }
    out.toBlob((blob) => {
      if (!blob) { toast('Export failed: the browser could not create the image.', true); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(ed.projectName || 'design').replace(/[^\w\-]+/g, '_')}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Exported ${format.toUpperCase()} ${out.width}×${out.height}px${failed.length ? ` — ${failed.length} image(s) could not be loaded and were drawn as placeholders` : ''}.`, failed.length > 0);
    }, format === 'jpg' ? 'image/jpeg' : 'image/png', 0.92);
  }

  async function saveExportToLibrary() {
    if (!ed) return;
    toast('Rendering and saving to Media Library…');
    try {
      const { canvas, failed } = await renderToCanvas(ed.design, 1);
      canvas.toBlob(async (blob) => {
        if (!blob) { toast('Could not render the design.', true); return; }
        const fd = new FormData();
        fd.append('file', blob, `${(ed.projectName || 'design').replace(/[^\w\-]+/g, '_')}.png`);
        fd.append('tags', 'design-export');
        try {
          const r = await apiForm('/api/media/upload', fd);
          toast(`Saved to Media Library as "${r.media.originalName}"${failed.length ? ` (${failed.length} image(s) were placeholders)` : ''}.`, failed.length > 0);
        } catch (e) { toast(e.message, true); }
      }, 'image/png');
    } catch (e) { toast('Save to library failed: ' + e.message, true); }
  }

  return { open, close, renderToCanvas, exportDesign };
})();
