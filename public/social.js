'use strict';
/* Social Media Studio + Content Calendar (Phase 8).
   Compose posts, connect platforms (OAuth tokens stored encrypted),
   AI captions via the Phase 7 LLM (honest key_needed without a key),
   local template captions (clearly labelled, never "AI"), per-platform
   character limits, calendar scheduling, and publishing ONLY through
   official platform APIs when connected. */

const SOCIAL_STATUS_BADGE = { draft: '', scheduled: 'info', published: 'ok', failed: 'err', manual: 'ok' };

async function viewSocial(c) {
  const [plats, posts, media] = await Promise.all([
    api('/api/social/platforms'),
    api('/api/social/posts'),
    api('/api/media?limit=200').catch(() => ({ media: [] })),
  ]);
  const editId = state.params.postId ? Number(state.params.postId) : null;
  const editing = editId ? posts.posts.find((p) => p.id === editId) : null;
  const lib = (media.media || []).filter((m) => ['image', 'video'].includes(m.kind));
  const selectedPlatform = state.params.platform || (editing && editing.platform) || 'facebook';
  const plat = plats.platforms.find((p) => p.id === selectedPlatform) || plats.platforms[0];

  c.innerHTML = `
  <div class="card"><h3>Social Media Studio</h3>
    <p class="sub">${esc(plats.note)}</p>
    <p class="sub" style="margin-top:6px">No platform is connected on a fresh install — connect one below to publish. A post is only marked published when the platform's API really accepts it; if you posted it yourself elsewhere, use “Mark posted manually” with a link.</p>
  </div>
  <div class="grid grid-2" style="margin-top:16px">
    <div class="card"><h3>${editing ? 'Edit post' : 'Compose a post'}</h3>
      <label>Platform <select id="sp-platform">
        ${plats.platforms.map((p) => `<option value="${p.id}" ${p.id === plat.id ? 'selected' : ''}>${esc(p.label)} — ${p.charLimit} chars max${p.videoOnly ? ' · video-only' : ''}${p.needsMedia ? ' · needs media' : ''}</option>`).join('')}
      </select></label>
      <label>Title (for video posts) <input id="sp-title" value="${esc(editing ? editing.title || '' : '')}" placeholder="Optional title"></label>
      <label>Post text <textarea id="sp-text" rows="5" placeholder="Write your post…">${esc(editing ? editing.text : '')}</textarea></label>
      <div class="sub" id="sp-count"></div>
      <label>Attach from Media Library <select id="sp-media" multiple size="4">
        ${lib.map((m) => `<option value="${m.id}" ${editing && editing.mediaIds.includes(m.id) ? 'selected' : ''}>${esc(m.original_name)} (${m.kind})</option>`).join('')}
      </select></label>
      <p class="sub">Hold Ctrl/Cmd to attach several files. Instagram needs media + a public media URL on its connection; TikTok and YouTube are video-only.</p>
      <div class="form-row" style="margin-top:10px">
        <button class="btn" id="sp-ai-caption">✨ AI caption (1 credit)</button>
        <button class="btn" id="sp-local-caption">💡 Local caption ideas</button>
        <button class="btn" id="sp-hashtags">＃ Hashtags</button>
      </div>
      <div id="sp-ai-out" class="sub" style="margin-top:8px"></div>
      <div class="form-row" style="margin-top:14px;align-items:flex-end">
        <label style="flex:1">Schedule for <input type="datetime-local" id="sp-when" value="${editing && editing.scheduledAt ? editing.scheduledAt.slice(0, 16) : ''}"></label>
        <button class="btn btn-primary" id="sp-save">Save draft</button>
        <button class="btn" id="sp-schedule">Schedule</button>
        <button class="btn" id="sp-publish">Publish now</button>
      </div>
      <div class="error" id="sp-error"></div>
    </div>
    <div class="card"><h3>Connections</h3>
      ${plats.platforms.map((p) => `
      <div class="kv" style="align-items:flex-start"><span><b>${esc(p.label)}</b><br><small style="color:var(--muted)">${esc(p.about)}</small><br>
        ${p.connected ? `<small>Connected as <b>${esc(p.connection.accountName)}</b> · token stored encrypted</small>` : '<small style="color:var(--amber)">Not connected — publishing refuses until you connect it.</small>'}
      </span><span style="text-align:right;min-width:150px">
        <span class="badge ${p.connected ? 'ok' : 'warn'}">${p.connected ? '● Connected' : '○ Not connected'}</span><br>
        <button class="btn btn-sm" data-conn="${p.id}">${p.connected ? 'Reconnect' : 'Connect'}</button>
        ${p.connected ? `<button class="btn btn-sm btn-danger" data-disconn="${p.id}">Disconnect</button>` : ''}
      </span></div>`).join('')}
      <p class="sub" style="margin-top:10px">Connect with the platform's OAuth flow and paste the access token here — it is stored encrypted (AES-256-GCM) and never shown again. For Facebook, also add the Page ID in the extra field; for LinkedIn, your member URN; for Instagram, your IG user ID + publicBaseUrl.</p>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Your posts <span class="badge">${posts.posts.length}</span></h3>
    <div class="form-row" style="margin-top:10px">
      <label>Filter <select id="sp-filter">
        <option value="">All statuses</option>
        ${['draft', 'scheduled', 'published', 'failed', 'manual'].map((s) => `<option ${state.params.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select></label>
      <button class="btn btn-sm" id="sp-run-scheduler">▶ Run scheduler now</button>
      <span class="sub">The scheduler also runs automatically every 15 s on the server.</span>
    </div>
    ${posts.posts.length ? posts.posts.filter((p) => !state.params.status || p.status === state.params.status).map((p) => `
    <div class="list-row"><div class="grow">
      <div class="t">${esc(p.text.slice(0, 90))}${p.text.length > 90 ? '…' : ''}</div>
      <div class="m">${esc(p.platform)} · <span class="badge ${SOCIAL_STATUS_BADGE[p.status] || ''}">${p.status}</span>
        ${p.scheduledAt ? ` · scheduled ${fmtDate(p.scheduledAt)}` : ''}${p.publishedAt ? ` · published ${fmtDate(p.publishedAt)}` : ''}
        ${p.providerPostId ? ` · provider id ${esc(p.providerPostId)}` : ''}${p.manualUrl ? ` · <a href="${esc(p.manualUrl)}" target="_blank" rel="noopener">posted link</a>` : ''}
        ${p.error ? `<br><span style="color:var(--red)">✗ ${esc(p.error)}</span>` : ''}</div>
    </div>
    <span style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-sm" data-edit-post="${p.id}">Edit</button>
      ${['draft', 'scheduled', 'failed'].includes(p.status) ? `<button class="btn btn-sm btn-primary" data-pub-post="${p.id}">Publish now</button>` : ''}
      ${['draft', 'scheduled', 'failed'].includes(p.status) ? `<button class="btn btn-sm" data-manual-post="${p.id}">Mark posted manually</button>` : ''}
      ${p.status !== 'published' ? `<button class="btn btn-sm btn-danger" data-del-post="${p.id}">Delete</button>` : ''}
    </span></div>`).join('') : '<p class="sub" style="margin-top:8px">No posts yet — compose your first one above.</p>'}
  </div>`;

  const platformSel = document.getElementById('sp-platform');
  const textEl = document.getElementById('sp-text');
  const countEl = document.getElementById('sp-count');
  const showErr = (m) => { const e = document.getElementById('sp-error'); e.textContent = m; e.style.display = 'block'; };
  const updateCount = () => {
    const p = plats.platforms.find((x) => x.id === platformSel.value);
    const n = textEl.value.length;
    countEl.innerHTML = `${n} / ${p.charLimit} characters for ${esc(p.label)}${n > p.charLimit ? ' — <b style="color:var(--red)">over the limit, shorten it</b>' : ''}`;
    countEl.style.color = n > p.charLimit ? 'var(--red)' : '';
  };
  platformSel.addEventListener('change', () => { updateCount(); });
  textEl.addEventListener('input', updateCount);
  updateCount();

  const collect = () => ({
    platform: platformSel.value,
    title: document.getElementById('sp-title').value.trim(),
    text: textEl.value,
    mediaIds: [...document.getElementById('sp-media').selectedOptions].map((o) => Number(o.value)),
  });
  const saveDraft = async (asScheduled) => {
    const body = collect();
    const when = document.getElementById('sp-when').value;
    try {
      let r;
      if (editing) {
        r = await api(`/api/social/posts/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, status: asScheduled ? 'scheduled' : 'draft', scheduledAt: asScheduled ? when : undefined }) });
        toast('Post updated.');
      } else {
        r = await api('/api/social/posts', { method: 'POST', body: JSON.stringify({ ...body, status: asScheduled ? 'scheduled' : 'draft', scheduledAt: asScheduled ? when : undefined }) });
        toast(asScheduled ? 'Post scheduled.' : 'Draft saved.');
      }
      go('social');
    } catch (e) { showErr(e.message); }
  };
  document.getElementById('sp-save').addEventListener('click', () => saveDraft(false));
  document.getElementById('sp-schedule').addEventListener('click', () => {
    if (!document.getElementById('sp-when').value) return showErr('Pick a date and time to schedule for.');
    saveDraft(true);
  });
  document.getElementById('sp-publish').addEventListener('click', async () => {
    try {
      let id = editing ? editing.id : null;
      if (!id) {
        const r = await api('/api/social/posts', { method: 'POST', body: JSON.stringify({ ...collect(), status: 'draft' }) });
        id = r.post.id;
      }
      const r = await api(`/api/social/posts/${id}/publish`, { method: 'POST' });
      toast(`Published to ${r.post.platform} (provider id ${r.post.providerPostId}).`);
      go('social');
    } catch (e) { showErr(e.message); }
  });
  document.getElementById('sp-ai-caption').addEventListener('click', async () => {
    const out = document.getElementById('sp-ai-out');
    const topic = textEl.value.trim() || 'my latest work';
    out.textContent = 'Asking the LLM… (1 credit)';
    try {
      const r = await api('/api/social/caption', { method: 'POST', body: JSON.stringify({ text: topic, platform: platformSel.value }) });
      out.innerHTML = `AI caption (LLM, ${r.charged} credit): <b>${esc(r.caption)}</b>${r.hashtags.length ? `<br>Hashtags: ${esc(r.hashtags.join(' '))}` : ''}<br><button class="btn btn-sm" id="sp-use-caption">Use this caption</button>`;
      document.getElementById('sp-use-caption').addEventListener('click', () => {
        textEl.value = r.caption + (r.hashtags.length ? '\n' + r.hashtags.join(' ') : '');
        updateCount();
      });
    } catch (e) { out.textContent = `AI caption failed: ${e.message}`; }
  });
  document.getElementById('sp-local-caption').addEventListener('click', async () => {
    const out = document.getElementById('sp-ai-out');
    const topic = textEl.value.trim() || 'my latest work';
    try {
      const r = await api('/api/social/caption-local', { method: 'POST', body: JSON.stringify({ text: topic }) });
      out.innerHTML = `<b>Local template ideas</b> (not AI — fill-in templates):<br>${r.captions.map((x, i) => `<div style="margin-top:6px">${i + 1}. ${esc(x)} <button class="btn btn-sm" data-use-local="${i}">Use</button></div>`).join('')}`;
      out.querySelectorAll('[data-use-local]').forEach((b) => b.addEventListener('click', () => { textEl.value = r.captions[Number(b.dataset.useLocal)]; updateCount(); }));
    } catch (e) { out.textContent = `Failed: ${e.message}`; }
  });
  document.getElementById('sp-hashtags').addEventListener('click', async () => {
    const out = document.getElementById('sp-ai-out');
    try {
      const r = await api('/api/social/hashtags', { method: 'POST', body: JSON.stringify({ text: textEl.value }) });
      out.innerHTML = r.hashtags.length ? `Suggested hashtags (from your text): <b>${esc(r.hashtags.join(' '))}</b> <button class="btn btn-sm" id="sp-add-tags">Add to post</button>` : 'No hashtags found in the text — add some keywords first.';
      const b = document.getElementById('sp-add-tags');
      if (b) b.addEventListener('click', () => { textEl.value = (textEl.value + '\n' + r.hashtags.join(' ')).trim(); updateCount(); });
    } catch (e) { out.textContent = `Failed: ${e.message}`; }
  });
  c.querySelectorAll('[data-conn]').forEach((b) => b.addEventListener('click', () => {
    const platform = b.dataset.conn;
    openModal(`<h2>Connect ${esc(platform)}</h2>
      <p class="sub">Paste the platform's OAuth access token. It is stored encrypted and never shown again. Extra fields (JSON): pageId for Facebook, authorUrn for LinkedIn, igUserId + publicBaseUrl for Instagram.</p>
      <label>Account name <input id="cn-name" placeholder="e.g. My Page"></label>
      <label>Access token <input id="cn-token" type="password" autocomplete="off"></label>
      <label>Extra (JSON, optional) <input id="cn-extra" placeholder='{"pageId":"123"}'></label>
      <label>API base URL override (optional, for testing) <input id="cn-base" placeholder="https://graph.facebook.com/v21.0"></label>
      <div class="error" id="cn-err"></div>
      <div class="modal-actions"><button class="btn" id="cn-cancel">Cancel</button><button class="btn btn-primary" id="cn-save">Connect</button></div>`)
      .addEventListener('click', async (ev) => {
        if (ev.target.id === 'cn-cancel') ev.currentTarget.remove();
        if (ev.target.id === 'cn-save') {
          let extra = {};
          try { extra = JSON.parse(document.getElementById('cn-extra').value.trim() || '{}'); } catch { document.getElementById('cn-err').textContent = 'Extra must be valid JSON.'; document.getElementById('cn-err').style.display = 'block'; return; }
          try {
            await api('/api/social/connections', { method: 'POST', body: JSON.stringify({ platform, accountName: document.getElementById('cn-name').value.trim(), accessToken: document.getElementById('cn-token').value, extra, baseUrl: document.getElementById('cn-base').value.trim() || undefined }) });
            toast('Platform connected.'); ev.currentTarget.remove(); renderView();
          } catch (e) { document.getElementById('cn-err').textContent = e.message; document.getElementById('cn-err').style.display = 'block'; }
        }
      });
  }));
  c.querySelectorAll('[data-disconn]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Disconnect ${b.dataset.disconn}? Scheduled posts for it will fail until you reconnect.`)) return;
    try { await api(`/api/social/connections/${b.dataset.disconn}`, { method: 'DELETE' }); toast('Disconnected.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
  document.getElementById('sp-filter').addEventListener('change', (e) => go('social', { status: e.target.value || undefined }));
  document.getElementById('sp-run-scheduler').addEventListener('click', async () => {
    try {
      const r = await api('/api/social/scheduler/run', { method: 'POST' });
      toast(`Scheduler ran: ${r.processed} due post(s) processed.`);
      renderView();
    } catch (e) { toast(e.message, true); }
  });
  c.querySelectorAll('[data-edit-post]').forEach((b) => b.addEventListener('click', () => go('social', { postId: b.dataset.editPost })));
  c.querySelectorAll('[data-pub-post]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api(`/api/social/posts/${b.dataset.pubPost}/publish`, { method: 'POST' });
      toast(`Published (provider id ${r.post.providerPostId}).`); renderView();
    } catch (e) { toast(e.message, true); renderView(); }
  }));
  c.querySelectorAll('[data-manual-post]').forEach((b) => b.addEventListener('click', () => {
    openModal(`<h2>Mark as posted manually</h2>
      <p class="sub">Use this when you posted it yourself on the platform (not through this app). The post is recorded as manually posted — never as an API publish.</p>
      <label>Note <input id="mm-note" placeholder="e.g. Posted from the Facebook app"></label>
      <label>Link to the live post <input id="mm-url" placeholder="https://…"></label>
      <div class="modal-actions"><button class="btn" id="mm-cancel">Cancel</button><button class="btn btn-primary" id="mm-save">Mark posted</button></div>`)
      .addEventListener('click', async (ev) => {
        if (ev.target.id === 'mm-cancel') ev.currentTarget.remove();
        if (ev.target.id === 'mm-save') {
          try {
            await api(`/api/social/posts/${b.dataset.manualPost}/mark-manual`, { method: 'POST', body: JSON.stringify({ note: document.getElementById('mm-note').value.trim(), url: document.getElementById('mm-url').value.trim() }) });
            toast('Marked as posted manually.'); ev.currentTarget.remove(); renderView();
          } catch (e) { toast(e.message, true); }
        }
      });
  }));
  c.querySelectorAll('[data-del-post]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this post?')) return;
    try { await api(`/api/social/posts/${b.dataset.delPost}`, { method: 'DELETE' }); toast('Post deleted.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
}

/* ---------- Content Calendar ---------- */
async function viewCalendar(c) {
  const month = state.params.month || new Date().toISOString().slice(0, 7);
  const cal = await api(`/api/social/calendar?month=${month}`);
  const [y, m] = month.split('-').map(Number);
  const firstDow = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const prevMonth = new Date(y, m - 2, 1).toISOString().slice(0, 7);
  const nextMonth = new Date(y, m, 1).toISOString().slice(0, 7);
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<div class="cal-day empty"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${month}-${String(d).padStart(2, '0')}`;
    const dayPosts = cal.byDay[key] || [];
    cells.push(`<div class="cal-day" data-day="${key}">
      <div class="cal-num">${d}</div>
      ${dayPosts.map((p) => `<div class="cal-chip st-${p.status}" data-post="${p.id}">${esc(p.platform)} · ${esc(p.text.slice(0, 28))}${p.text.length > 28 ? '…' : ''}</div>`).join('')}
    </div>`);
  }
  c.innerHTML = `
  <div class="card"><h3>Content Calendar — ${esc(month)}</h3>
    <p class="sub">Scheduled posts appear on their date. Click a post to see it and act on it. To schedule, compose in Social Studio and pick a date, or click a day below and create a post for it.</p>
    <div class="form-row" style="margin-top:10px">
      <button class="btn" id="cal-prev">← ${esc(prevMonth)}</button>
      <button class="btn" id="cal-next">${esc(nextMonth)} →</button>
      <button class="btn" id="cal-today">This month</button>
      <span class="sub">${cal.total} post(s) this month</span>
    </div>
  </div>
  <div class="cal-grid" style="margin-top:16px">
    ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-head">${d}</div>`).join('')}
    ${cells.join('')}
  </div>
  <div id="cal-detail" style="margin-top:16px"></div>`;
  document.getElementById('cal-prev').addEventListener('click', () => go('calendar', { month: prevMonth }));
  document.getElementById('cal-next').addEventListener('click', () => go('calendar', { month: nextMonth }));
  document.getElementById('cal-today').addEventListener('click', () => go('calendar', { month: undefined }));
  c.querySelectorAll('.cal-day[data-day]').forEach((el) => el.addEventListener('click', (ev) => {
    if (ev.target.dataset.post) return;
    go('social', { platform: 'facebook' });
    toast(`Compose a post, then set its schedule date to ${el.dataset.day}.`);
  }));
  c.querySelectorAll('[data-post]').forEach((el) => el.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const detail = document.getElementById('cal-detail');
    try {
      const r = await api(`/api/social/posts/${el.dataset.post}`);
      const p = r.post;
      detail.innerHTML = `<div class="card"><h3>${esc(p.platform)} — ${p.status}</h3>
        <p>${esc(p.text)}</p>
        <p class="sub">${p.scheduledAt ? `Scheduled ${fmtDate(p.scheduledAt)}` : ''}${p.publishedAt ? ` · Published ${fmtDate(p.publishedAt)}` : ''}${p.providerPostId ? ` · Provider id ${esc(p.providerPostId)}` : ''}${p.error ? `<br><span style="color:var(--red)">✗ ${esc(p.error)}</span>` : ''}</p>
        <div class="form-row">
          <button class="btn" id="cd-edit">Edit in Social Studio</button>
          ${['draft', 'scheduled', 'failed'].includes(p.status) ? `<button class="btn btn-primary" id="cd-pub">Publish now</button>` : ''}
        </div></div>`;
      document.getElementById('cd-edit').addEventListener('click', () => go('social', { postId: p.id }));
      const pub = document.getElementById('cd-pub');
      if (pub) pub.addEventListener('click', async () => {
        try { const r2 = await api(`/api/social/posts/${p.id}/publish`, { method: 'POST' }); toast(`Published (provider id ${r2.post.providerPostId}).`); renderView(); }
        catch (e) { toast(e.message, true); renderView(); }
      });
    } catch (e) { detail.innerHTML = `<div class="card"><p class="sub">${esc(e.message)}</p></div>`; }
  }));
}
