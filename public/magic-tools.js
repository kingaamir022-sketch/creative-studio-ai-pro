'use strict';
/* Global entry point used by app.js routing (same pattern as viewVoices). */
async function viewMagicTools(c, presetTool) { return MagicTools.view(c, presetTool); }
const MagicTools = (() => {
  let images = [];
  let designs = [];
  let sizes = [];
  let presets = [];
  let switchTargets = [];
  let switchLanguages = [];
  let model = null;
  let tool = 'remove-background';
  let selectedImageId = null;
  let selectedDesignId = null;
  let selectedLayerId = null;
  let lastMaskByImage = {}; // imageId -> maskMediaId from the last bg-remover run
  let result = null; // { title, media, note, extraHtml }
  let pollTimer = null;

  const TOOLS = [
    { id: 'remove-background', label: 'Background Remover', icon: '🪄' },
    { id: 'grab', label: 'Magic Grab', icon: '✋' },
    { id: 'erase', label: 'Magic Eraser', icon: '🧽' },
    { id: 'expand', label: 'Magic Expand', icon: '↔️' },
    { id: 'resize', label: 'Magic Resize', icon: '📐' },
    { id: 'switch', label: 'Magic Switch', icon: '🔀' },
    { id: 'animate', label: 'Magic Animate', icon: '🎞️' },
  ];

  async function loadAll() {
    const [im, pr, ms, ps, sz, sw] = await Promise.all([
      api('/api/media?kind=image&limit=100').catch(() => ({ media: [] })),
      api('/api/projects?type=design&limit=100').catch(() => ({ projects: [] })),
      api('/api/magic/model/status').catch(() => null),
      api('/api/magic/animate/presets').catch(() => ({ presets: [] })),
      api('/api/design/sizes').catch(() => ({ sizes: [] })),
      api('/api/magic/switch/targets').catch(() => ({ targets: [], languages: [] })),
    ]);
    images = (im.media || []).filter((m) => m.kind === 'image');
    designs = pr.projects || [];
    model = ms;
    presets = (ps.presets || []);
    sizes = (sz.sizes || []);
    switchTargets = (sw.targets || []);
    switchLanguages = (sw.languages || []);
    if (!selectedImageId && images.length) selectedImageId = images[0].id;
    if (!selectedDesignId && designs.length) selectedDesignId = designs[0].id;
  }

  function imgOptions() {
    return images.map((x) => `<option value="${x.id}">${esc(x.original_name)}${x.width ? ` — ${x.width}×${x.height}` : ''}</option>`).join('')
      || '<option value="">No images in your library yet — upload one in the Media Library first</option>';
  }
  function designOptions() {
    return designs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')
      || '<option value="">No design projects yet — create one in the Graphic Editor first</option>';
  }
  function selectedImage() { return images.find((x) => x.id === Number(selectedImageId)) || null; }
  function selectedDesign() { return designs.find((d) => d.id === Number(selectedDesignId)) || null; }

  function modelCardHtml() {
    if (!model) return '<p class="sub">Model status unavailable.</p>';
    const pct = model.totalBytes ? Math.round((100 * (model.downloadedBytes || 0)) / model.totalBytes) : 0;
    let line = '';
    if (model.status === 'ready') {
      line = `<p class="sub">✅ Model ready — ${esc(model.model)} (${model.sizeMB} MB, ${esc(model.license)}). Runs fully on this computer, no key, no upload.</p>`;
    } else if (model.status === 'downloading') {
      line = `<p class="sub">⬇️ Downloading the free model… ${pct}% (${((model.downloadedBytes || 0) / 1048576).toFixed(1)} / ${model.sizeMB} MB). First use only — it is cached afterwards.</p>
        <div class="ai-progress"><div class="ai-progress-bar" style="width:${pct}%"></div></div>`;
    } else if (model.status === 'error') {
      line = `<p class="sub" style="color:var(--danger, #dc2626)">Download failed: ${esc(model.error || 'unknown error')}</p>`;
    } else {
      line = `<p class="sub">The free background-removal model (${model.sizeMB} MB, ${esc(model.model)}, ${esc(model.license)}) downloads once, on first use, and is then cached on this computer. No key, no account, nothing is uploaded.</p>`;
    }
    return `${line}
      <div class="ed-btnrow">
        ${model.status === 'ready' ? '' : `<button class="btn btn-primary" id="mg-model-dl">Download model (${model.sizeMB} MB)</button>`}
        <button class="btn" id="mg-model-refresh">Refresh status</button>
      </div>
      ${model.mock ? '<p class="sub">Test mode: the model is mocked (CS_SEGMENTATION_MOCK=1) — no real download happens.</p>' : ''}`;
  }

  function toolPanelHtml() {
    const img = selectedImage();
    switch (tool) {
      case 'remove-background': return `
        <p class="sub">One click removes the background with the free local U-2-Net model. The result is a transparent PNG in your Media Library, plus a mask image (white = subject) that Magic Grab reuses.</p>
        <div class="ed-field"><label>Image</label><select id="mg-image">${imgOptions()}</select></div>
        <div class="ed-btnrow"><button class="btn btn-primary" id="mg-run-bg">Remove background</button></div>
        <p class="sub">First run downloads the model (~168 MB) — after that it is instant. If you are offline, it refuses honestly instead of faking a result.</p>`;
      case 'grab': {
        const maskId = lastMaskByImage[selectedImageId];
        return `
        <p class="sub">Click the subject in the photo and it is lifted out as its own transparent layer, ready to move around in the Graphic Editor. Uses the same local mask as Background Remover — run that first for this image.</p>
        <div class="ed-field"><label>Image</label><select id="mg-image">${imgOptions()}</select></div>
        ${img ? `<canvas id="mg-grab-canvas" style="max-width:100%;border:1px solid var(--border, #ddd);border-radius:12px;cursor:crosshair"></canvas>
        <p class="sub" id="mg-grab-hint">${maskId ? 'Mask ready ✓ — click the subject.' : 'No mask for this image yet — press “Remove background” first (or run it in the Background Remover tab), then come back and click.'}</p>` : ''}
        <div class="ed-btnrow"><button class="btn" id="mg-run-bg-first">Remove background first</button></div>`;
      }
      case 'erase': return `
        <p class="sub">Paint over the object to remove — the model fills in the background naturally. Needs an image provider key (OpenAI Images); without one it refuses with “key needed” and creates nothing.</p>
        <div class="ed-field"><label>Image</label><select id="mg-image">${imgOptions()}</select></div>
        <div class="ed-field"><label>Brush size</label><input type="range" id="mg-brush" min="8" max="120" value="40"> <span id="mg-brush-val">40px</span></div>
        ${img ? `<canvas id="mg-erase-canvas" style="max-width:100%;border:1px solid var(--border, #ddd);border-radius:12px;cursor:crosshair"></canvas>
        <p class="sub">Paint the thing to remove. The painted area becomes a hole in the mask — that is the region the AI repaints.</p>` : ''}
        <div class="ed-btnrow"><button class="btn" id="mg-erase-clear">Clear mask</button><button class="btn btn-primary" id="mg-run-erase">Erase painted region</button></div>`;
      case 'expand': return `
        <p class="sub">Grow the canvas beyond the image's edges. <b>AI outpainting</b> paints a seamless continuation (needs an image provider key). <b>Solid</b> pads with a colour and <b>Blurred edge</b> extends a blurred copy — both work locally with no key.</p>
        <div class="ed-field"><label>Image</label><select id="mg-image">${imgOptions()}</select></div>
        <div class="ed-row">
          <div class="ed-field"><label>New width (px)</label><input type="number" id="mg-ex-w" value="${img && img.width ? img.width + 400 : 1400}" min="10" max="8000"></div>
          <div class="ed-field"><label>New height (px)</label><input type="number" id="mg-ex-h" value="${img && img.height ? img.height + 400 : 1000}" min="10" max="8000"></div>
        </div>
        <div class="ed-field"><label>Mode</label><select id="mg-ex-mode">
          <option value="ai">AI outpainting (needs image key)</option>
          <option value="blur">Blurred edge (local, no key)</option>
          <option value="solid">Solid colour (local, no key)</option>
        </select></div>
        <div class="ed-field"><label>Fill colour (solid mode)</label><input type="color" id="mg-ex-fill" value="#000000"></div>
        <div class="ed-btnrow"><button class="btn btn-primary" id="mg-run-expand">Expand canvas</button></div>`;
      case 'resize': {
        const d = selectedDesign();
        return `
        <p class="sub">Resize a whole design to another format — every layer is scaled and repositioned, text re-wraps and shrinks to fit (never overflows), and anything that still cannot fit is listed as “Needs attention”. A NEW design project is created; the original is never changed.</p>
        <div class="ed-field"><label>Design</label><select id="mg-design">${designOptions()}</select></div>
        <div class="ed-field"><label>Target size</label><select id="mg-size">${sizes.map((s) => `<option value="${s.id}">${esc(s.name)} — ${s.width}×${s.height}</option>`).join('')}</select></div>
        ${d && d.content ? `<p class="sub">Current size: ${d.content.width}×${d.content.height}px · ${(d.content.layers || []).length} layers.</p>` : ''}
        <div class="ed-btnrow"><button class="btn btn-primary" id="mg-run-resize">Magic Resize → new design</button></div>`;
      }
      case 'switch': {
        const d = selectedDesign();
        return `
        <p class="sub">Switch a design to another platform format AND translate its text — in one step. Resize is local and free; translation uses your LLM key (free Gemini works) and costs 1 credit. Without a key the request refuses honestly and creates nothing. A NEW design project is created; the original is never changed.</p>
        <div class="ed-field"><label>Design</label><select id="mg-design">${designOptions()}</select></div>
        <div class="ed-field"><label>Target format</label><select id="mg-switch-size">
          <option value="">Keep the same size (translate only)</option>
          ${switchTargets.map((s) => `<option value="${s.id}">${esc(s.name)} — ${s.width}×${s.height}</option>`).join('')}
        </select></div>
        <div class="ed-field"><label>Translate text to</label><select id="mg-switch-lang">
          <option value="">No translation (resize only)</option>
          ${switchLanguages.map((l) => `<option value="${l.code}">${esc(l.name)}</option>`).join('')}
        </select></div>
        ${d && d.content ? `<p class="sub">Current size: ${d.content.width}×${d.content.height}px · ${(d.content.layers || []).length} layers · ${(d.content.layers || []).filter((l) => l.type === 'text').length} text layers.</p>` : ''}
        <div class="ed-btnrow"><button class="btn btn-primary" id="mg-run-switch">Magic Switch → new design</button></div>`;
      }
      case 'animate': {
        const d = selectedDesign();
        const layers = (d && d.content && d.content.layers) || [];
        const designPresets = presets.filter((p) => p.appliesTo.includes('design'));
        return `
        <p class="sub">Apply a one-click animation preset to a layer of a design. The design is updated in place and the animation previews live in the Graphic Editor.</p>
        <div class="ed-field"><label>Design</label><select id="mg-design">${designOptions()}</select></div>
        <div class="ed-field"><label>Layer</label><select id="mg-layer">${layers.map((l) => `<option value="${l.id}">${esc(l.name || l.type)} (${l.type})</option>`).join('') || '<option value="">No layers in this design</option>'}</select></div>
        <div class="ed-field"><label>Preset</label><select id="mg-preset">${designPresets.map((p) => `<option value="${p.id}">${esc(p.name)} — ${esc(p.description)}</option>`).join('')}</select></div>
        <div class="ed-btnrow"><button class="btn btn-primary" id="mg-run-animate">Apply preset</button></div>`;
      }
      default: return '';
    }
  }

  function resultHtml() {
    if (!result) return '<p class="sub">Nothing done yet. Pick a tool above.</p>';
    const m = result.media;
    return `
      <h4>${esc(result.title)}</h4>
      ${m && m.url ? `<img src="${esc(m.url)}" alt="Magic Tools result" style="max-width:100%;border-radius:12px">` : ''}
      ${result.note ? `<p class="sub">${result.note}</p>` : ''}
      ${result.extraHtml || ''}
      ${m ? `<div class="ed-btnrow"><a class="btn" href="${esc(m.url)}" download>Download</a><button class="btn" id="mg-open-media">Open in Media Library →</button></div>` : ''}`;
  }

  function showError(msg) {
    const el = document.getElementById('mg-error');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
  }
  function clearError() {
    const el = document.getElementById('mg-error');
    if (el) { el.textContent = ''; el.style.display = 'none'; }
  }
  function setBusy(btn, busy, label) {
    if (!btn) return;
    btn.disabled = busy;
    if (label) btn.textContent = busy ? 'Working…' : label;
  }

  // --- Mask painter (Erase) ---
  let paintCanvas = null;
  let paintCtx = null;
  let painting = false;
  function setupEraseCanvas() {
    const img = selectedImage();
    const cv = document.getElementById('mg-erase-canvas');
    if (!cv || !img) return;
    const scale = Math.min(1, 1024 / Math.max(img.width || 1024, img.height || 1024));
    const w = Math.max(1, Math.round((img.width || 1024) * scale));
    const h = Math.max(1, Math.round((img.height || 1024) * scale));
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => { ctx.drawImage(im, 0, 0, w, h); redrawPaintOverlay(ctx, w, h); };
    im.src = img.url;
    paintCanvas = document.createElement('canvas');
    paintCanvas.width = w; paintCanvas.height = h;
    paintCtx = paintCanvas.getContext('2d');
    const brush = document.getElementById('mg-brush');
    const brushVal = document.getElementById('mg-brush-val');
    if (brush) brush.addEventListener('input', () => { if (brushVal) brushVal.textContent = `${brush.value}px`; });
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (w / r.width), y: (e.clientY - r.top) * (h / r.height) };
    };
    cv.addEventListener('pointerdown', (e) => {
      painting = true;
      cv.setPointerCapture(e.pointerId);
      const p = pos(e);
      paintCtx.beginPath();
      paintCtx.moveTo(p.x, p.y);
      paintCtx.lineCap = 'round';
      paintCtx.strokeStyle = 'rgba(255,0,120,0.85)';
      paintCtx.lineWidth = brush ? Number(brush.value) : 40;
      paintCtx.lineTo(p.x + 0.1, p.y + 0.1);
      paintCtx.stroke();
      redrawPaintOverlay(ctx, w, h);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!painting) return;
      const p = pos(e);
      paintCtx.lineTo(p.x, p.y);
      paintCtx.stroke();
      redrawPaintOverlay(ctx, w, h);
    });
    const stop = () => { painting = false; };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);
  }
  function redrawPaintOverlay(ctx, w, h) {
    // Re-draw the image, then the pink paint strokes on top.
    const img = selectedImage();
    if (!img) return;
    const im = new Image();
    im.onload = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(im, 0, 0, w, h);
      if (paintCanvas) ctx.drawImage(paintCanvas, 0, 0);
    };
    im.src = img.url;
  }
  function exportMaskDataUrl() {
    if (!paintCanvas) return null;
    const out = document.createElement('canvas');
    out.width = paintCanvas.width;
    out.height = paintCanvas.height;
    const octx = out.getContext('2d');
    // OpenAI mask format: opaque white everywhere, transparent where the
    // user painted (the region to erase).
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.globalCompositeOperation = 'destination-out';
    octx.drawImage(paintCanvas, 0, 0);
    return out.toDataURL('image/png');
  }

  // --- Grab click ---
  function setupGrabCanvas() {
    const img = selectedImage();
    const cv = document.getElementById('mg-grab-canvas');
    if (!cv || !img) return;
    const scale = Math.min(1, 1024 / Math.max(img.width || 1024, img.height || 1024));
    const w = Math.max(1, Math.round((img.width || 1024) * scale));
    const h = Math.max(1, Math.round((img.height || 1024) * scale));
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const im = new Image();
    im.onload = () => ctx.drawImage(im, 0, 0, w, h);
    im.src = img.url;
    cv.addEventListener('click', async (e) => {
      const maskId = lastMaskByImage[selectedImageId];
      if (!maskId) { showError('No mask for this image yet — press “Remove background first” and then click the subject.'); return; }
      const r = cv.getBoundingClientRect();
      const px = Math.round((e.clientX - r.left) * ((img.width || w) / r.width));
      const py = Math.round((e.clientY - r.top) * ((img.height || h) / r.height));
      clearError();
      try {
        const res = await api('/api/magic/grab', { method: 'POST', body: JSON.stringify({ mediaId: Number(selectedImageId), maskMediaId: maskId, x: px, y: py }) });
        result = { title: '✋ Magic Grab — subject lifted out', media: res.media, note: `Subject at (${res.bbox.x}, ${res.bbox.y}) — ${res.bbox.w}×${res.bbox.h}px. Saved as a transparent PNG — add it as an image layer in the Graphic Editor.` };
        view(document.getElementById('content'));
        toast('Subject grabbed — saved to your Media Library.');
      } catch (err) {
        showError(err.message);
      }
    });
  }

  async function view(c, presetTool) {
    // v2.7.0 — deep link: the home "AI remove" tile lands here with the
    // Eraser already selected (same view, same tools, no second list).
    if (presetTool && TOOLS.some((t) => t.id === presetTool)) tool = presetTool;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    await loadAll();
    const img = selectedImage();
    c.innerHTML = `
    <div class="card"><h3>🪄 Magic Tools</h3>
      <p class="sub">One-click magic, built on the real tools: Background Remover and Grab run a free local AI model on this computer (no key, nothing uploaded). Eraser and AI Expand use your image provider key — without one they refuse honestly. Magic Resize and Animate are pure local transforms. Magic Switch resizes AND translates (translation needs an LLM key; free Gemini works).</p>
      <div class="ai-modes">${TOOLS.map((t) => `<button class="ai-mode-btn ${t.id === tool ? 'active' : ''}" data-tool="${t.id}">${t.icon} ${t.label}</button>`).join('')}</div>
    </div>
    <div class="grid grid-2">
      <div class="card"><h3>${esc(TOOLS.find((t) => t.id === tool).label)}</h3>
        <div id="mg-panel">${toolPanelHtml()}</div>
        <div class="error" id="mg-error" style="display:none"></div>
      </div>
      <div class="card"><h3>Result</h3><div id="mg-result">${resultHtml()}</div></div>
    </div>
    <div class="card" style="margin-top:16px"><h3>Local AI model — Background Remover &amp; Grab</h3>
      <div id="mg-model">${modelCardHtml()}</div>
    </div>`;
    c.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => { tool = b.dataset.tool; view(c); }));
    const imgSel = document.getElementById('mg-image');
    if (imgSel) imgSel.addEventListener('change', () => { selectedImageId = imgSel.value; view(c); });
    const dSel = document.getElementById('mg-design');
    if (dSel) dSel.addEventListener('change', () => { selectedDesignId = dSel.value; selectedLayerId = null; view(c); });
    const dlBtn = document.getElementById('mg-model-dl');
    if (dlBtn) dlBtn.addEventListener('click', async () => {
      try {
        await api('/api/magic/model/download', { method: 'POST' });
        toast('Model download started — watch the progress here.');
        pollTimer = setInterval(async () => {
          model = await api('/api/magic/model/status').catch(() => model);
          const box = document.getElementById('mg-model');
          if (box) box.innerHTML = modelCardHtml();
          if (model && model.status === 'ready') { clearInterval(pollTimer); pollTimer = null; view(c); }
        }, 3000);
        view(c);
      } catch (err) { showError(err.message); }
    });
    const rfBtn = document.getElementById('mg-model-refresh');
    if (rfBtn) rfBtn.addEventListener('click', async () => { model = await api('/api/magic/model/status').catch(() => model); view(c); });

    if (tool === 'erase') setupEraseCanvas();
    if (tool === 'grab') setupGrabCanvas();

    const openMedia = document.getElementById('mg-open-media');
    if (openMedia) openMedia.addEventListener('click', () => go('media'));

    const runBg = document.getElementById('mg-run-bg');
    if (runBg) runBg.addEventListener('click', async () => {
      if (!selectedImageId) { showError('Pick an image first.'); return; }
      clearError();
      setBusy(runBg, true, 'Remove background');
      try {
        const res = await api('/api/magic/remove-background', { method: 'POST', body: JSON.stringify({ mediaId: Number(selectedImageId) }) });
        lastMaskByImage[selectedImageId] = res.maskMedia.id;
        result = { title: '🪄 Background removed', media: res.media, note: `Transparent PNG saved (${res.width}×${res.height}, foreground ${Math.round(res.foregroundFraction * 100)}% of the frame). The mask was saved too — Magic Grab can now lift the subject out.` };
        view(c);
        toast('Background removed — saved to your Media Library.');
      } catch (err) {
        setBusy(runBg, false, 'Remove background');
        showError(err.message);
      }
    });
    const bgFirst = document.getElementById('mg-run-bg-first');
    if (bgFirst) bgFirst.addEventListener('click', async () => {
      if (!selectedImageId) { showError('Pick an image first.'); return; }
      clearError();
      try {
        const res = await api('/api/magic/remove-background', { method: 'POST', body: JSON.stringify({ mediaId: Number(selectedImageId) }) });
        lastMaskByImage[selectedImageId] = res.maskMedia.id;
        result = { title: '🪄 Background removed', media: res.media, note: 'Mask ready — now click the subject in the photo above.' };
        view(c);
        toast('Mask ready — click the subject.');
      } catch (err) { showError(err.message); }
    });
    const eraseClear = document.getElementById('mg-erase-clear');
    if (eraseClear) eraseClear.addEventListener('click', () => {
      if (paintCtx && paintCanvas) { paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height); }
      const cv = document.getElementById('mg-erase-canvas');
      if (cv) setupEraseCanvas();
    });
    const runErase = document.getElementById('mg-run-erase');
    if (runErase) runErase.addEventListener('click', async () => {
      if (!selectedImageId) { showError('Pick an image first.'); return; }
      const mask = exportMaskDataUrl();
      if (!mask) { showError('Paint the region to remove first.'); return; }
      clearError();
      setBusy(runErase, true, 'Erase painted region');
      try {
        const res = await api('/api/magic/erase', { method: 'POST', body: JSON.stringify({ mediaId: Number(selectedImageId), mask }) });
        result = { title: '🧽 Magic Eraser — region removed', media: res.media, note: `Repainted by ${esc(res.provider)} and saved to your Media Library.` };
        view(c);
        toast('Erased — saved to your Media Library.');
      } catch (err) {
        setBusy(runErase, false, 'Erase painted region');
        showError(err.message);
      }
    });
    const runExpand = document.getElementById('mg-run-expand');
    if (runExpand) runExpand.addEventListener('click', async () => {
      if (!selectedImageId) { showError('Pick an image first.'); return; }
      const w = Number(document.getElementById('mg-ex-w').value);
      const h = Number(document.getElementById('mg-ex-h').value);
      const mode = document.getElementById('mg-ex-mode').value;
      const fill = document.getElementById('mg-ex-fill').value;
      clearError();
      setBusy(runExpand, true, 'Expand canvas');
      try {
        const res = await api('/api/magic/expand', { method: 'POST', body: JSON.stringify({ mediaId: Number(selectedImageId), targetWidth: w, targetHeight: h, mode, fill }) });
        result = { title: `↔️ Magic Expand — ${res.width}×${res.height}`, media: res.media, note: `Mode: ${esc(res.mode)} (${esc(res.provider)}). Saved to your Media Library.` };
        view(c);
        toast('Canvas expanded — saved to your Media Library.');
      } catch (err) {
        setBusy(runExpand, false, 'Expand canvas');
        showError(err.message);
      }
    });
    const runResize = document.getElementById('mg-run-resize');
    if (runResize) runResize.addEventListener('click', async () => {
      const d = selectedDesign();
      if (!d) { showError('Pick a design first.'); return; }
      const sizeId = document.getElementById('mg-size').value;
      clearError();
      setBusy(runResize, true, 'Magic Resize → new design');
      try {
        const content = d.content || {};
        const res = await api('/api/magic/resize', { method: 'POST', body: JSON.stringify({ design: content, targetSizeId: sizeId }) });
        const size = sizes.find((s) => s.id === sizeId);
        const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `${d.name} — ${size ? size.name : 'resized'}`, type: 'design', content: res.design }) });
        const attention = res.report.needsAttention || [];
        result = {
          title: `📐 Magic Resize — ${res.report.from.width}×${res.report.from.height} → ${res.report.to.width}×${res.report.to.height}`,
          media: null,
          note: `New design “${esc(created.project.name)}” created (${(res.design.layers || []).length} layers reflowed). Original untouched.`,
          extraHtml: attention.length
            ? `<div class="ed-note" style="margin-top:10px"><b>⚠️ Needs attention (${attention.length}):</b><ul>${attention.map((a) => `<li>${esc(a.name)} — ${esc(a.reason)}${a.suggestedText ? ` Try: “${esc(a.suggestedText)}”` : ''}</li>`).join('')}</ul></div>`
            : '<p class="sub">✅ Every layer fit — no attention needed.</p>',
        };
        // Refresh the design list so the new project shows up.
        designs = (await api('/api/projects?type=design&limit=100').catch(() => ({ projects: [] }))).projects || designs;
        view(c);
        toast('Resized design created.');
      } catch (err) {
        setBusy(runResize, false, 'Magic Resize → new design');
        showError(err.message);
      }
    });
    const runSwitch = document.getElementById('mg-run-switch');
    if (runSwitch) runSwitch.addEventListener('click', async () => {
      const d = selectedDesign();
      if (!d) { showError('Pick a design first.'); return; }
      const targetSizeId = document.getElementById('mg-switch-size').value || undefined;
      const translateTo = document.getElementById('mg-switch-lang').value || undefined;
      if (!targetSizeId && !translateTo) { showError('Pick a target format, a language, or both.'); return; }
      clearError();
      setBusy(runSwitch, true, 'Magic Switch → new design');
      try {
        const res = await api('/api/magic/switch', { method: 'POST', body: JSON.stringify({ projectId: d.id, targetSizeId, translateTo }) });
        const attention = (res.report && res.report.needsAttention) || [];
        result = {
          title: `🔀 Magic Switch — “${esc(res.project.name)}”`,
          media: null,
          note: `${res.target ? `Now ${res.target.width}×${res.target.height} (${esc(res.target.name)}). ` : ''}${res.translated ? `Text translated to ${esc(res.language.name)}. ` : ''}New design project created — the original was not changed.`,
          extraHtml: `${attention.length
            ? `<div class="ed-note" style="margin-top:10px"><b>⚠️ Needs attention (${attention.length}):</b><ul>${attention.map((a) => `<li>${esc(a.name)} — ${esc(a.reason)}${a.suggestedText ? ` Try: “${esc(a.suggestedText)}”` : ''}</li>`).join('')}</ul></div>`
            : '<p class="sub">✅ Every layer fit — no attention needed.</p>'}
            <div class="ed-btnrow" style="margin-top:10px"><button class="btn btn-primary" id="mg-open-switched">Open the new design →</button></div>`,
        };
        designs = (await api('/api/projects?type=design&limit=100').catch(() => ({ projects: [] }))).projects || designs;
        view(c);
        document.getElementById('mg-open-switched').addEventListener('click', () => go('design-editor', { projectId: res.project.id }));
        toast('Switched design created.');
      } catch (err) {
        setBusy(runSwitch, false, 'Magic Switch → new design');
        showError(err.message);
      }
    });
    const runAnimate = document.getElementById('mg-run-animate');
    if (runAnimate) runAnimate.addEventListener('click', async () => {
      const d = selectedDesign();
      const layerId = document.getElementById('mg-layer').value;
      const presetId = document.getElementById('mg-preset').value;
      if (!d || !layerId || !presetId) { showError('Pick a design, a layer and a preset.'); return; }
      clearError();
      setBusy(runAnimate, true, 'Apply preset');
      try {
        const res = await api('/api/magic/animate', { method: 'POST', body: JSON.stringify({ design: d.content, layerId, presetId }) });
        await api(`/api/projects/${d.id}`, { method: 'PATCH', body: JSON.stringify({ content: res.design }) });
        const preset = presets.find((p) => p.id === presetId);
        result = { title: `🎞️ Animation applied — ${esc(preset ? preset.name : presetId)}`, media: null, note: `Layer “${esc(res.layer.name || layerId)}” in “${esc(d.name)}” now animates (${res.animation.durationMs}ms${res.animation.loop ? ', loops' : ''}). Open the design in the Graphic Editor to preview it.` };
        view(c);
        toast('Animation preset applied.');
      } catch (err) {
        setBusy(runAnimate, false, 'Apply preset');
        showError(err.message);
      }
    });
  }

  return { view };
})();
