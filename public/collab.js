'use strict';
/* Collaboration (v2.2.4) — share a project (read-only link + per-user
   share) and comment threads on it. NO live co-editing: shared users can
   view and comment, never edit. */

function collabPanelHTML() {
  return `<div class="card" style="margin-top:16px"><h3>Share &amp; comments</h3>
  <p class="sub">Per-user shares can be <b>view</b> or <b>edit</b> — an edit share can save name/content changes (no live co-editing: last write wins). Share links are always view-only. Nobody gains admin or role powers from a share.</p>
  <div id="collab-shares"><p class="sub">Loading shares…</p></div>
  <h3 style="margin-top:16px">Comments</h3>
  <p class="sub">Type @Name to mention someone on this install — they get a bell notification. Pin a comment to a layer or slide with the “Pinned to” field.</p>
  <div id="collab-comments"><p class="sub">Loading comments…</p></div>
  <div class="form-row" style="margin-top:10px">
    <input id="collab-new-comment" placeholder="Write a comment… (@Name to mention)" style="flex:2">
    <input id="collab-new-layer" placeholder="Pinned to… (e.g. Slide 3)" style="flex:1">
    <button class="btn btn-primary" id="collab-add-comment">Comment</button>
  </div>
  <div class="error" id="collab-error" style="display:none"></div>
  <h3 style="margin-top:16px">Activity</h3>
  <div id="collab-activity"><p class="sub">Loading activity…</p></div>
</div>`;
}

async function initCollabPanel(projectId) {
  const sharesBox = document.getElementById('collab-shares');
  const commentsBox = document.getElementById('collab-comments');
  const errBox = document.getElementById('collab-error');
  if (!sharesBox || !commentsBox) return;
  const showError = (msg) => { errBox.textContent = msg; errBox.style.display = 'block'; };
  const clearError = () => { errBox.style.display = 'none'; };

  let isOwner = false;
  try {
    const s = await api(`/api/collab/projects/${projectId}/shares`);
    isOwner = true;
    const link = s.shares.find((x) => x.kind === 'link');
    const users = s.shares.filter((x) => x.kind === 'user');
    sharesBox.innerHTML = `
      <div class="kv"><span>Read-only link</span><span>${link
        ? `<span class="badge ok">● Active</span> <button class="btn btn-sm" id="collab-copy-link">Copy link</button> <button class="btn btn-sm btn-danger" id="collab-revoke-link">Revoke</button>`
        : '<span class="badge">○ No link</span>'} ${!link ? '<button class="btn btn-sm btn-primary" id="collab-make-link">Create link</button>' : ''}</span></div>
      ${link ? '<p class="sub">Anyone with the link can VIEW this project (no sign-in needed). Revoking the link stops access immediately.</p>' : ''}
      <div style="margin-top:10px"><b>Shared with</b>
      ${users.length ? users.map((u) => `<div class="kv"><span>${esc(u.sharedWithName || u.sharedWithEmail)} <small style="color:var(--muted)">${esc(u.sharedWithEmail || '')}</small></span><span><span class="badge ${u.permission === 'edit' ? 'ok' : ''}">${u.permission === 'edit' ? '✏️ edit' : '👁 view only'}</span> <select data-perm-for="${u.id}" title="Change permission">
        <option value="view" ${u.permission === 'view' ? 'selected' : ''}>View</option>
        <option value="edit" ${u.permission === 'edit' ? 'selected' : ''}>Edit</option></select> <button class="btn btn-sm btn-danger" data-unshare="${u.id}">Remove</button></span></div>`).join('') : '<p class="sub">Not shared with anyone yet.</p>'}
      </div>
      <div class="form-row" style="margin-top:10px">
        <input id="collab-share-email" type="email" placeholder="Share with an email on this install…" style="flex:2">
        <select id="collab-share-perm" title="Permission"><option value="view">View only</option><option value="edit">Can edit</option></select>
        <button class="btn" id="collab-share-btn">Share</button>
      </div>
      <p class="sub">Edit shares can save name/content changes — they never gain admin powers and can never change roles or make anyone OWNER.</p>`;
    const makeLink = document.getElementById('collab-make-link');
    if (makeLink) makeLink.addEventListener('click', async () => {
      try {
        const r = await api(`/api/collab/projects/${projectId}/link`, { method: 'POST' });
        const full = `${location.origin}${r.link.url}`;
        try { await navigator.clipboard.writeText(full); toast('Share link created and copied.'); } catch { toast('Share link created.'); }
        initCollabPanel(projectId);
      } catch (e) { showError(e.message); }
    });
    const copyLink = document.getElementById('collab-copy-link');
    if (copyLink) copyLink.addEventListener('click', async () => {
      try {
        const r = await api(`/api/collab/projects/${projectId}/link/reveal`, { method: 'POST' });
        try { await navigator.clipboard.writeText(`${location.origin}${r.link.url}`); toast('Share link copied.'); }
        catch { toast(`Share link: ${location.origin}${r.link.url}`); }
      } catch (e) { showError(e.message); }
    });
    const revoke = document.getElementById('collab-revoke-link');
    if (revoke) revoke.addEventListener('click', async () => {
      if (!confirm('Revoke the share link? Anyone using it will lose access.')) return;
      try { await api(`/api/collab/projects/${projectId}/link`, { method: 'DELETE' }); toast('Share link revoked.'); initCollabPanel(projectId); }
      catch (e) { showError(e.message); }
    });
    const shareBtn = document.getElementById('collab-share-btn');
    if (shareBtn) shareBtn.addEventListener('click', async () => {
      const email = document.getElementById('collab-share-email').value.trim();
      const permission = document.getElementById('collab-share-perm').value;
      if (!email) { showError('Enter an email address.'); return; }
      clearError();
      try {
        const r = await api(`/api/collab/projects/${projectId}/share`, { method: 'POST', body: JSON.stringify({ email, permission }) });
        toast(r.alreadyShared ? 'Already shared with that user — permission updated.' : `Shared (${permission}) with ${email}.`);
        initCollabPanel(projectId);
      } catch (e) { showError(e.message); }
    });
    sharesBox.querySelectorAll('[data-perm-for]').forEach((sel) => sel.addEventListener('change', async () => {
      const shareId = sel.closest('.kv').querySelector('[data-unshare]').dataset.unshare;
      try {
        await api(`/api/collab/projects/${projectId}/shares/${shareId}`, { method: 'PATCH', body: JSON.stringify({ permission: sel.value }) });
        toast(`Permission changed to ${sel.value}.`); initCollabPanel(projectId);
      } catch (e) { showError(e.message); initCollabPanel(projectId); }
    }));
    sharesBox.querySelectorAll('[data-unshare]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/collab/projects/${projectId}/shares/${b.dataset.unshare}`, { method: 'DELETE' }); toast('Share removed.'); initCollabPanel(projectId); }
      catch (e) { showError(e.message); }
    }));
  } catch (e) {
    // Not the owner (or no access): no share management, comments only.
    sharesBox.innerHTML = '<p class="sub">Shared with you — read-only. You can view and comment, never edit.</p>';
  }

  const loadComments = async () => {
    try {
      const data = await api(`/api/collab/projects/${projectId}/comments`);
      const list = data.comments || [];
      commentsBox.innerHTML = list.length ? list.map((t) => `
        <div class="list-row" style="align-items:flex-start"><div class="grow">
          <div class="t">${esc(t.body)} ${t.status === 'resolved' ? '<span class="badge ok">✓ resolved</span>' : ''}</div>
          <div class="m">by ${esc(t.authorName || 'user')} · ${fmtDate(t.createdAt)}${t.layerRef ? ` · 📌 pinned to ${esc(t.layerRef)}` : ''}${(t.mentions || []).length ? ` · @${esc((t.mentions || []).map((m) => m.name).join(', @'))}` : ''}</div>
          ${t.replies.map((r) => `<div style="margin:6px 0 0 16px;padding-left:10px;border-left:2px solid var(--border)"><div class="t" style="font-size:13px">${esc(r.body)}</div><div class="m">by ${esc(r.authorName || 'user')} · ${fmtDate(r.createdAt)}${(r.mentions || []).length ? ` · @${esc((r.mentions || []).map((m) => m.name).join(', @'))}` : ''}</div></div>`).join('')}
          <div style="margin-top:6px;display:flex;gap:6px">
            <input data-reply-for="${t.id}" placeholder="Reply…" style="flex:1;padding:6px 8px">
            <button class="btn btn-sm" data-reply-btn="${t.id}">Reply</button>
            <button class="btn btn-sm" data-resolve="${t.id}">${t.status === 'resolved' ? 'Reopen' : 'Resolve'}</button>
            <button class="btn btn-sm btn-danger" data-del-comment="${t.id}">Delete</button>
          </div>
        </div></div>`).join('') : '<p class="sub">No comments yet — start the discussion.</p>';
      commentsBox.querySelectorAll('[data-reply-btn]').forEach((b) => b.addEventListener('click', async () => {
        const input = commentsBox.querySelector(`[data-reply-for="${b.dataset.replyBtn}"]`);
        const body = input.value.trim();
        if (!body) return;
        try { await api(`/api/collab/projects/${projectId}/comments`, { method: 'POST', body: JSON.stringify({ body, parentId: Number(b.dataset.replyBtn) }) }); loadComments(); }
        catch (e) { showError(e.message); }
      }));
      commentsBox.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
        try { await api(`/api/collab/projects/${projectId}/comments/${b.dataset.resolve}/resolve`, { method: 'POST', body: JSON.stringify({}) }); loadComments(); }
        catch (e) { showError(e.message); }
      }));
      commentsBox.querySelectorAll('[data-del-comment]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this comment thread?')) return;
        try { await api(`/api/collab/projects/${projectId}/comments/${b.dataset.delComment}`, { method: 'DELETE' }); loadComments(); }
        catch (e) { showError(e.message); }
      }));
    } catch (e) {
      commentsBox.innerHTML = `<p style="color:var(--danger)">Could not load comments: ${esc(e.message)}</p>`;
    }
  };
  await loadComments();
  const addBtn = document.getElementById('collab-add-comment');
  if (addBtn) addBtn.addEventListener('click', async () => {
    const input = document.getElementById('collab-new-comment');
    const layerInput = document.getElementById('collab-new-layer');
    const body = input.value.trim();
    if (!body) return;
    clearError();
    try {
      await api(`/api/collab/projects/${projectId}/comments`, { method: 'POST', body: JSON.stringify({ body, layerRef: layerInput ? layerInput.value.trim() || null : null }) });
      input.value = '';
      if (layerInput) layerInput.value = '';
      loadComments();
      loadActivity();
    } catch (e) { showError(e.message); }
  });
  const loadActivity = async () => {
    const box = document.getElementById('collab-activity');
    if (!box) return;
    try {
      const data = await api(`/api/collab/projects/${projectId}/activity`);
      const list = data.activity || [];
      box.innerHTML = list.length ? list.map((a) => `<div class="kv"><span>${esc(a.detail)}</span><span>${fmtDate(a.createdAt)}</span></div>`).join('')
        : '<p class="sub">No activity yet — shares, comments and edits will show up here.</p>';
    } catch (e) { box.innerHTML = `<p class="sub">Could not load activity: ${esc(e.message)}</p>`; }
  };
  await loadActivity();
  return { isOwner };
}

/* Read-only view of a project shared with me (no editing controls). */
async function viewSharedProject(c) {
  const id = state.params.id;
  let data;
  try {
    data = await api(`/api/collab/shared-with-me/${id}`);
  } catch (e) {
    c.innerHTML = `<div class="empty"><div class="big">🔒</div><h3>Not shared with you</h3><p>${esc(e.message)}</p><button class="btn btn-primary" id="sp-back">← Back to Projects</button></div>`;
    document.getElementById('sp-back').addEventListener('click', () => go('projects'));
    return;
  }
  const p = data.project;
  const canEdit = Boolean(data.canEdit);
  const permLabel = data.permission === 'owner' ? 'Owner' : data.permission === 'edit' ? '✏️ Edit access' : '👁 View only';
  c.innerHTML = `
  <div class="toolbar" style="margin-top:0">
    <button class="btn" id="sp-back">← Projects</button>
    <span class="badge info">${esc(p.type)}</span>
    <span class="badge ${canEdit ? 'ok' : ''}">${esc(permLabel)}</span>
  </div>
  <div class="card"><h3>${esc(p.name)}</h3>
    <p class="sub">${canEdit ? 'Shared with you with edit access — you can rename it and save content changes below. No live co-editing: last write wins.' : 'Shared with you. You can view and comment, never edit — there is no live co-editing.'}</p>
    <div class="kv"><span>Created</span><span>${fmtDate(p.createdAt)}</span></div>
    <div class="kv"><span>Last updated</span><span>${fmtDate(p.updatedAt)}</span></div>
  </div>
  ${canEdit ? `
  <div class="card" style="margin-top:16px"><h3>Edit shared project</h3>
    <label for="sp-name">Name</label>
    <input id="sp-name" value="${esc(p.name)}">
    <div style="margin-top:10px"><button class="btn btn-primary" id="sp-save-name">Save name</button></div>
    <div class="error" id="sp-err" style="display:none"></div>
  </div>` : ''}
  <div class="card" style="margin-top:16px">
    <h3>Project content ${canEdit ? '(editable)' : '(read-only)'}</h3>
    <textarea id="sp-content" class="code" spellcheck="false" ${canEdit ? '' : 'readonly'}>${esc(JSON.stringify(p.content, null, 2))}</textarea>
    ${canEdit ? '<div style="margin-top:10px"><button class="btn btn-primary" id="sp-save-content">Save content</button></div><p class="sub">Invalid JSON is rejected, never saved.</p>' : ''}
  </div>
  ${collabPanelHTML()}`;
  document.getElementById('sp-back').addEventListener('click', () => go('projects'));
  const showSpErr = (m) => { const e = document.getElementById('sp-err'); if (e) { e.textContent = m; e.style.display = 'block'; } };
  const saveNameBtn = document.getElementById('sp-save-name');
  if (saveNameBtn) saveNameBtn.addEventListener('click', async () => {
    try {
      await api(`/api/collab/shared-with-me/${id}`, { method: 'PATCH', body: JSON.stringify({ name: document.getElementById('sp-name').value.trim() }) });
      toast('Name saved.'); renderView();
    } catch (e) { showSpErr(e.message); }
  });
  const saveContentBtn = document.getElementById('sp-save-content');
  if (saveContentBtn) saveContentBtn.addEventListener('click', async () => {
    let content;
    try { content = JSON.parse(document.getElementById('sp-content').value); } catch { showSpErr('Invalid JSON — fix the content before it can be saved.'); return; }
    try {
      await api(`/api/collab/shared-with-me/${id}`, { method: 'PATCH', body: JSON.stringify({ content }) });
      toast('Content saved.'); renderView();
    } catch (e) { showSpErr(e.message); }
  });
  await initCollabPanel(p.id);
}
