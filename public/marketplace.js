'use strict';
/* Templates Marketplace (Phase 8) — IN-APP only.
   Browse / search / install community templates published by users of
   THIS install. Installed copies are real editable projects or bulk
   jobs, never flattened images. There is no external store. */

async function viewMarketplace(c) {
  const [list, mine, builtins] = await Promise.all([
    api(`/api/marketplace?q=${encodeURIComponent(state.params.q || '')}&kind=${state.params.kind || ''}`),
    api('/api/projects?search=').catch(() => ({ projects: [] })),
    api(`/api/marketplace/builtin?q=${encodeURIComponent(state.params.bq || '')}&kind=${state.params.bkind || ''}`).catch(() => ({ templates: [], counts: {} })),
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
    ${builtins.templates.length ? `<div style="margin-top:12px">${builtins.templates.map((t) => `
      <div class="list-row"><div class="grow">
        <div class="t">${esc(t.name)} <span class="badge">${esc(t.kind)}</span></div>
        <div class="m">${esc(t.category)} · ${t.width}×${t.height} · built-in</div>
      </div>
      <button class="btn btn-sm btn-primary" data-builtin-install="${esc(t.id)}">Install →</button></div>`).join('')}</div>` : '<p class="sub" style="margin-top:8px">No built-in templates match — try different words.</p>'}
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
  document.getElementById('mk-pub-kind').addEventListener('change', fillSources);
  fillSources();
  document.getElementById('mk-search').addEventListener('click', () => go('marketplace', { q: document.getElementById('mk-q').value.trim() || undefined, kind: document.getElementById('mk-kind').value || undefined }));
  document.getElementById('mk-bsearch').addEventListener('click', () => go('marketplace', { bq: document.getElementById('mk-bq').value.trim() || undefined, bkind: document.getElementById('mk-bkind').value || undefined }));
  document.getElementById('mk-bq').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('mk-bsearch').click(); });
  c.querySelectorAll('[data-builtin-install]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api(`/api/marketplace/builtin/${encodeURIComponent(b.dataset.builtinInstall)}/install`, { method: 'POST' });
      toast(`Installed as ${r.installed.kind} “${r.installed.name}”.`);
      go('project', { id: r.installed.id });
    } catch (e) { toast(e.message, true); }
  }));
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
