'use strict';
/* Stock Assets (v2.2.4) — browse/search/download free stock photos and
   audio via Openverse (no key needed). Saving an asset downloads it into
   the Media Library with its attribution stored on the row. Saving the
   same asset twice returns the existing file — never a second copy.
   Video search is NOT available: Openverse v1 has no video endpoint, and
   the view says so plainly. */

async function viewStock(c) {
  const type = state.params.type === 'audio' ? 'audio' : 'image';
  const q = state.params.q || '';
  const licenseType = state.params.licenseType || 'all';
  const category = state.params.category || '';
  let data = null;
  let error = null;
  if (q) {
    try {
      data = await api(`/api/stock/search?type=${type}&q=${encodeURIComponent(q)}&licenseType=${encodeURIComponent(licenseType)}${category ? `&category=${encodeURIComponent(category)}` : ''}`);
    } catch (e) { error = e.message; }
  }
  const cats = type === 'image'
    ? [['photograph', 'Photograph'], ['illustration', 'Illustration'], ['digitized_artwork', 'Digitised artwork']]
    : [['music', 'Music'], ['sound_effect', 'Sound effect'], ['podcast', 'Podcast']];
  c.innerHTML = `
  <div class="card"><h3>📚 Stock Assets</h3>
    <p class="sub">Free stock photos and audio from Openverse (openly licensed — CC0, CC BY, CC BY-SA and more). No key, no account. Every asset shows its license and attribution; saving one downloads it into your Media Library with the attribution stored on the file.</p>
    <p class="sub" style="margin-top:6px">⚠️ <b>Video search is not available here:</b> the Openverse API covers images and audio only (video is not exposed by its v1 API). For video, upload your own files in the Media Library.</p>
    <p class="sub">Anonymous Openverse limits: 20 requests/min, 200/day, 20 results per page.</p>
    <div class="form-row" style="margin-top:10px">
      <button class="btn ${type === 'image' ? 'btn-primary' : ''}" id="st-tab-image">🖼️ Images</button>
      <button class="btn ${type === 'audio' ? 'btn-primary' : ''}" id="st-tab-audio">🎵 Audio</button>
      <input id="st-q" placeholder="Search stock ${type === 'image' ? 'photos' : 'audio'}…" value="${esc(q)}" style="flex:2">
      <select id="st-license" title="License filter">
        <option value="all" ${licenseType === 'all' ? 'selected' : ''}>Any licence</option>
        <option value="commercial" ${licenseType === 'commercial' ? 'selected' : ''}>Commercial use</option>
        <option value="modification" ${licenseType === 'modification' ? 'selected' : ''}>Can modify</option>
      </select>
      <select id="st-cat" title="Category">
        <option value="">All categories</option>
        ${cats.map(([v, l]) => `<option value="${v}" ${category === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="st-search">Search</button>
    </div>
  </div>
  ${error ? `<div class="card" style="margin-top:16px"><p style="color:var(--danger)">⚠️ ${esc(error)}</p></div>` : ''}
  ${data ? `
  <div class="card" style="margin-top:16px"><h3>Results (${data.resultCount.toLocaleString()} found${data.pageCount > 1 ? ` · page ${data.page} of ${data.pageCount}` : ''})</h3>
    ${data.results.length ? `<div class="media-grid" style="margin-top:12px">${data.results.map((r) => `
      <div class="media-card">
        <div class="thumb">${type === 'image'
          ? (r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="${esc(r.title)}" loading="lazy">` : '<span class="file-ico">🖼️</span>')
          : `<audio controls preload="none" src="${esc(r.url)}" style="width:100%"></audio>`}</div>
        <div class="body">
          <div class="nm">${esc(r.title)}</div>
          <div class="mt">${esc(r.creator || 'Unknown creator')} · ${esc((r.license || 'unknown').toUpperCase())}${r.licenseVersion ? ' ' + esc(r.licenseVersion) : ''}${r.width ? ` · ${r.width}×${r.height}` : ''}${r.durationSeconds ? ` · ${Math.floor(r.durationSeconds / 60)}:${String(r.durationSeconds % 60).padStart(2, '0')}` : ''}</div>
          ${r.attribution ? `<div class="mt" style="font-size:11px">📝 ${esc(r.attribution)}</div>` : ''}
          <div style="margin-top:8px;display:flex;gap:6px">
            <button class="btn btn-sm btn-primary" data-save-stock="${esc(r.id)}">⬇ Save to Library</button>
            ${r.landingUrl ? `<a class="btn btn-sm" href="${esc(r.landingUrl)}" target="_blank" rel="noopener">Source ↗</a>` : ''}
          </div>
        </div>
      </div>`).join('')}</div>`
    : '<p class="sub" style="margin-top:8px">No results — try different words.</p>'}
  </div>` : (q ? '' : '<div class="card" style="margin-top:16px"><p class="sub">Type a word above and press Search — e.g. “mountain”, “piano”, “city night”.</p></div>')}
  <div id="st-status" style="margin-top:12px"></div>`;

  const doSearch = () => go('stock', {
    type,
    q: document.getElementById('st-q').value.trim() || undefined,
    licenseType: document.getElementById('st-license').value !== 'all' ? document.getElementById('st-license').value : undefined,
    category: document.getElementById('st-cat').value || undefined,
  });
  document.getElementById('st-tab-image').addEventListener('click', () => go('stock', { type: 'image', q: q || undefined }));
  document.getElementById('st-tab-audio').addEventListener('click', () => go('stock', { type: 'audio', q: q || undefined }));
  document.getElementById('st-search').addEventListener('click', doSearch);
  document.getElementById('st-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  c.querySelectorAll('[data-save-stock]').forEach((b) => b.addEventListener('click', async () => {
    const status = document.getElementById('st-status');
    b.disabled = true; b.textContent = 'Saving…';
    try {
      const r = await api('/api/stock/save', { method: 'POST', body: JSON.stringify({ type, id: b.dataset.saveStock }) });
      status.innerHTML = `<div class="card"><p>${r.duplicate ? 'ℹ️ Already in your Media Library — the existing file was returned, no second copy was made.' : '✅ Saved to your Media Library.'} ${esc(r.attribution || '')}</p><div style="margin-top:8px"><button class="btn btn-sm" id="st-open-media">Open Media Library →</button></div></div>`;
      document.getElementById('st-open-media').addEventListener('click', () => go('media'));
      toast(r.duplicate ? 'Already in your library.' : 'Saved to your Media Library.');
    } catch (e) {
      status.innerHTML = `<div class="card"><p style="color:var(--danger)">⚠️ ${esc(e.message)}</p></div>`;
    } finally {
      b.disabled = false; b.textContent = '⬇ Save to Library';
    }
  }));
}
