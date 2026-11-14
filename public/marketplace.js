'use strict';
/* Templates Marketplace (Phase 8) — IN-APP only.
   Browse / search / install community templates published by users of
   THIS install. Installed copies are real editable projects or bulk
   jobs, never flattened images. There is no external store. */

async function viewMarketplace(c) {
  const [list, mine, builtins, trending] = await Promise.all([
    api(`/api/marketplace?q=${encodeURIComponent(state.params.q || '')}&kind=${state.params.kind || ''}`),
    api('/api/projects?search=').catch(() => ({ projects: [] })),
    api(`/api/marketplace/builtin?q=${encodeURIComponent(state.params.bq || '')}&kind=${state.params.bkind || ''}`).catch(() => ({ templates: [], counts: {} })),
    api('/api/marketplace/trending').catch(() => null),
  ]);
  const myProjects = (mine.projects || []).filter((p) => ['design', 'video', 'deck'].includes(p.type));
  c.innerHTML = `
  <div class="card"><h3>Templates Marketplace</h3>
    <p class="sub">${esc(list.note)}</p>
    <p class="sub" style="margin-top:6px">Installing a template creates a real editable copy — a design/video project you can open in the editor, or a bulk job you can run with your own data.</p>
    <div class="form-row" style="margin-top:10px">
      <input id="mk-q" placeholder="Search templates…" value="${esc(state.params.q || '')}" style="flex:2">
      <select id="mk-kind">
        <option value="">All kinds</option>
        ${['design', 'video', 'deck'].map((k) => `<option value="${k}" ${state.params.kind === k ? 'selected' : ''}>${k}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="mk-search">Search</button>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h3>🔥 Trending</h3>
    <p class="sub">${esc(trending ? trending.note : 'Trending templates, ranked by installs on this install.')}</p>
    <div id="mk-trending" style="margin-top:12px">${(trending && trending.trending && trending.trending.length ? trending.trending : (trending ? trending.starters : [])).map((t) => `
      <div class="list-row"><div class="grow">
        <div class="t">${esc(t.name)} <span class="badge">${esc(t.kind)}</span>${t.downloads ? ` <span class="badge">⬇ ${t.downloads} installs</span>` : ''}</div>
        <div class="m">${esc(t.category)}${t.width ? ` · ${t.width}×${t.height}` : ''}${t.builtin ? ' · built-in starter' : ` · by ${esc(t.authorName || 'user')}`}</div>
      </div>
      <button class="btn btn-sm btn-primary" data-trending-install="${esc(t.id)}" data-trending-builtin="${t.builtin ? '1' : ''}">Install →</button></div>`).join('') || '<p class="sub">Nothing trending yet.</p>'}
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Built-in templates (${builtins.templates.length}${builtins.counts.design ? ` · ${builtins.counts.design} design · ${builtins.counts.video} video · ${builtins.counts.deck} deck` : ''})</h3>
    <p class="sub">Starter templates that ship with the app — installing one creates a real editable project (design, video timeline or deck), never a flattened image.</p>
    <div class="form-row" style="margin-top:10px">
      <input id="mk-bq" placeholder="Search built-in templates…" value="${esc(state.params.bq || '')}" style="flex:2">
      <select id="mk-bkind">
        <option value="">All kinds</option>
        ${['design', 'video', 'deck'].map((k) => `<option value="${k}" ${state.params.bkind === k ? 'selected' : ''}>${k}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="mk-bsearch">Search</button>
    </div>
    <div id="mk-builtin-cats" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px"></div>
    <div id="mk-builtin-list" style="margin-top:12px"></div>
  </div>
  <div class="grid grid-2" style="margin-top:16px">
    <div class="card"><h3>Browse (${list.templates.length})</h3>
      ${list.templates.length ? list.templates.map((t) => `
      <div class="list-row"><div class="grow">
        <div class="t">${esc(t.name)} <span class="badge">${esc(t.kind)}</span></div>
        <div class="m">${esc(t.description || 'No description')} — by ${esc(t.authorName || 'user')} · ⬇ ${t.downloads} installs${t.avgRating ? ` · ★ ${t.avgRating.toFixed(1)} (${t.ratingCount})` : ''}</div>
        <div class="m">${(t.tags || []).map((tag) => `<span class="badge">${esc(tag)}</span>`).join(' ')}</div>
      </div>
      <span style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-sm btn-primary" data-install="${t.id}">Install →</button>
        <select data-rate="${t.id}" title="Rate this template">
          <option value="">Rate…</option>${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n} ★</option>`).join('')}
        </select>
        <button class="btn btn-sm" data-report="${t.id}">Report</button>
      </span></div>`).join('') : '<p class="sub" style="margin-top:8px">No templates yet — publish the first one on the right.</p>'}
    </div>
    <div class="card"><h3>Publish a template</h3>
      <p class="sub">Share one of your own designs or videos with everyone on this install. The template's content is snapshotted, so it stays installable even if you delete the original project.</p>
      <label>Kind <select id="mk-pub-kind">
        <option value="design">Design project</option>
        <option value="video">Video project</option>
        <option value="deck">Deck project</option>
      </select></label>
      <label>Source <select id="mk-pub-src"></select></label>
      <label>Name <input id="mk-pub-name" placeholder="Template name"></label>
      <label>Description <textarea id="mk-pub-desc" rows="2" placeholder="What is it for?"></textarea></label>
      <label>Tags (comma separated) <input id="mk-pub-tags" placeholder="quiz, sale, intro"></label>
      <div style="margin-top:12px"><button class="btn btn-primary" id="mk-publish">Publish to marketplace</button></div>
      <div class="error" id="mk-err"></div>
      <p class="sub" style="margin-top:10px">Published templates are visible to every user of this install. You can unpublish your own at any time (Admin can remove any template).</p>
    </div>
  </div>`;

  const fillSources = () => {
    const kind = document.getElementById('mk-pub-kind').value;
    const sel = document.getElementById('mk-pub-src');
    sel.innerHTML = myProjects.filter((p) => p.type === kind).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || `<option value="">No ${kind} projects yet</option>`;
  };
  // v2.5.0 #56 — guided placeholder swap: installing a template with
  // placeholders first offers each one (your picture / your text) and
  // installs with the swaps applied, so the new project already carries
  // your own content. Templates without placeholders install directly.
  async function installBuiltin(id) {
    let placeholders = [];
    try {
      const r = await api(`/api/marketplace/builtin/${encodeURIComponent(id)}/placeholders`);
      placeholders = r.placeholders || [];
    } catch { placeholders = []; }
    if (!placeholders.length) {
      try {
        const r = await api(`/api/marketplace/builtin/${encodeURIComponent(id)}/install`, { method: 'POST' });
        toast(`Installed as ${r.installed.kind} “${r.installed.name}”.`);
        go('project', { id: r.installed.id });
      } catch (e) { toast(e.message, true); }
      return;
    }
    let images = [];
    if (placeholders.some((p) => p.kind === 'image')) {
      try { images = (await api('/api/media?kind=image')).media || []; } catch { images = []; }
    }
    const back = openModal(`<h2>Make it yours — swap the placeholders</h2>
      <p class="sub">This template has ${placeholders.length} placeholder(s). Swap each one now, or install as-is and edit later in the editor.</p>
      ${placeholders.map((p) => p.kind === 'image'
        ? `<label>${esc(p.name)} (photo) <select id="swap-${p.layerId}" class="input"><option value="">Keep the placeholder</option>${images.map((m) => `<option value="${m.id}">${esc(m.originalName)}</option>`).join('')}</select></label>`
        : `<label>${esc(p.name)} (text) <input id="swap-${p.layerId}" class="input" value="${esc(p.currentText || '')}"></label>`).join('')}
      <div class="error" id="swap-err"></div>
      <div class="modal-actions"><button class="btn" id="swap-skip">Install as-is</button><button class="btn btn-primary" id="swap-install">Install with my swaps</button></div>`);
    back.querySelector('#swap-skip').addEventListener('click', async () => {
      try {
        const r = await api(`/api/marketplace/builtin/${encodeURIComponent(id)}/install`, { method: 'POST' });
        back.remove(); toast(`Installed as ${r.installed.kind} “${r.installed.name}”.`);
        go('project', { id: r.installed.id });
      } catch (e) { const eb = back.querySelector('#swap-err'); eb.textContent = e.message; eb.style.display = 'block'; }
    });
    back.querySelector('#swap-install').addEventListener('click', async () => {
      const swaps = [];
      for (const p of placeholders) {
        const el = back.querySelector(`#swap-${CSS.escape(p.layerId)}`);
        if (!el) continue;
        if (p.kind === 'image' && el.value) swaps.push({ layerId: p.layerId, mediaId: Number(el.value) });
        if (p.kind === 'text' && el.value.trim() && el.value.trim() !== (p.currentText || '')) swaps.push({ layerId: p.layerId, text: el.value.trim() });
      }
      try {
        const r = await api(`/api/marketplace/builtin/${encodeURIComponent(id)}/install`, { method: 'POST', body: JSON.stringify({ swaps }) });
        back.remove(); toast(`Installed with ${r.swapsApplied} swap(s).`);
        go('project', { id: r.installed.id });
      } catch (e) { const eb = back.querySelector('#swap-err'); eb.textContent = e.message; eb.style.display = 'block'; }
    });
  }
  const builtinCats = [...new Set((builtins.templates || []).map((t) => t.category))].sort();
  let activeCat = '';
  const renderBuiltinList = () => {
    const host = document.getElementById('mk-builtin-list');
    const list = activeCat ? builtins.templates.filter((t) => t.category === activeCat) : builtins.templates;
    host.innerHTML = list.length ? list.map((t) => `
      <div class="list-row"><div class="grow">
        <div class="t">${esc(t.name)} <span class="badge">${esc(t.kind)}</span></div>
        <div class="m">${esc(t.category)} · ${t.width}×${t.height} · built-in</div>
      </div>
      <button class="btn btn-sm btn-primary" data-builtin-install="${esc(t.id)}">Install →</button></div>`).join('')
      : '<p class="sub" style="margin-top:8px">No built-in templates match — try different words.</p>';
    host.querySelectorAll('[data-builtin-install]').forEach((b) => b.addEventListener('click', () => installBuiltin(b.dataset.builtinInstall)));
  };
  const renderBuiltinCats = () => {
    const host = document.getElementById('mk-builtin-cats');
    host.innerHTML = [`<button class="btn btn-sm ${activeCat === '' ? 'btn-primary' : ''}" data-cat="">All (${builtins.templates.length})</button>`]
      .concat(builtinCats.map((cat) => {
        const n = builtins.templates.filter((t) => t.category === cat).length;
        return `<button class="btn btn-sm ${activeCat === cat ? 'btn-primary' : ''}" data-cat="${esc(cat)}">${esc(cat)} (${n})</button>`;
      })).join('');
    host.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
      activeCat = b.dataset.cat;
      renderBuiltinCats(); renderBuiltinList();
    }));
  };
  renderBuiltinCats();
  renderBuiltinList();
  c.querySelectorAll('[data-trending-install]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.trendingBuiltin === '1') { installBuiltin(b.dataset.trendingInstall); return; }
    try {
      const r = await api(`/api/marketplace/${b.dataset.trendingInstall}/install`, { method: 'POST' });
      toast(`Installed as ${r.installed.type} “${r.installed.name}”.`);
      if (r.installed.type === 'project') go('project', { id: r.installed.id });
    } catch (e) { toast(e.message, true); }
  }));
  document.getElementById('mk-pub-kind').addEventListener('change', fillSources);
  fillSources();
  document.getElementById('mk-search').addEventListener('click', () => go('marketplace', { q: document.getElementById('mk-q').value.trim() || undefined, kind: document.getElementById('mk-kind').value || undefined }));
  document.getElementById('mk-bsearch').addEventListener('click', () => go('marketplace', { bq: document.getElementById('mk-bq').value.trim() || undefined, bkind: document.getElementById('mk-bkind').value || undefined }));
  document.getElementById('mk-bq').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('mk-bsearch').click(); });
  document.getElementById('mk-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('mk-search').click(); });
  document.getElementById('mk-publish').addEventListener('click', async () => {
    const kind = document.getElementById('mk-pub-kind').value;
    const body = {
      kind,
      name: document.getElementById('mk-pub-name').value.trim(),
      description: document.getElementById('mk-pub-desc').value.trim(),
      tags: document.getElementById('mk-pub-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
      sourceProjectId: Number(document.getElementById('mk-pub-src').value),
    };
    try {
      await api('/api/marketplace', { method: 'POST', body: JSON.stringify(body) });
      toast('Template published to the in-app marketplace.'); renderView();
    } catch (e) {
      const err = document.getElementById('mk-err'); err.textContent = e.message; err.style.display = 'block';
    }
  });
  c.querySelectorAll('[data-install]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api(`/api/marketplace/${b.dataset.install}/install`, { method: 'POST' });
      toast(`Installed as ${r.installed.type} “${r.installed.name}”.`);
      if (r.installed.type === 'project') go('project', { id: r.installed.id });
      else go('bulk-video');
    } catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-rate]').forEach((sel) => sel.addEventListener('change', async () => {
    if (!sel.value) return;
    try {
      await api(`/api/marketplace/${sel.dataset.rate}/rate`, { method: 'POST', body: JSON.stringify({ rating: Number(sel.value) }) });
      toast('Thanks for rating.'); renderView();
    } catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-report]').forEach((b) => b.addEventListener('click', async () => {
    const reason = prompt('Why are you reporting this template?');
    if (!reason || !reason.trim()) return;
    try { await api(`/api/marketplace/${b.dataset.report}/report`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }); toast('Reported. An admin will review it.'); }
    catch (e) { toast(e.message, true); }
  }));
}
