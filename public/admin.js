'use strict';
/* Admin panel + Analytics (Phase 8). Admin is OWNER/ADMIN only —
   regular users (role USER) get a 403 from the API and see that here too.
   Analytics shows real numbers counted from this install's own DB. */

async function viewAdmin(c) {
  let stats, users, health, audit, requests;
  try {
    [stats, users, health, audit, requests] = await Promise.all([
      api('/api/admin/stats'),
      api('/api/admin/users'),
      api('/api/admin/health'),
      api('/api/admin/audit?limit=100'),
      api('/api/billing/admin/requests'),
    ]);
  } catch (e) {
    c.innerHTML = `<div class="card"><h3>Admin panel</h3><p class="sub">${esc(e.message)}</p><p class="sub">This panel is for OWNER and ADMIN accounts only.</p></div>`;
    return;
  }
  const s = stats.stats;
  const isOwner = state.user.role === 'OWNER';
  // Super Admin (v2.2.1): ADMIN has full powers like the OWNER, except
  // OWNER accounts are protected and only the OWNER can manage them.
  const isAdmin = isOwner || state.user.role === 'ADMIN';
  c.innerHTML = `
  <div class="card"><h3>Admin panel</h3><p class="sub">Platform-wide numbers, users, plan requests, audit log and system health. Every admin action is written to the audit log.</p></div>
  <div class="grid grid-3" style="margin-top:16px">
    <div class="card"><h3>Users</h3><div style="font-size:28px;font-weight:800">${s.users}</div><p class="sub">${s.suspendedUsers} suspended · ${s.pendingPlanRequests} pending plan requests</p></div>
    <div class="card"><h3>Projects / Media</h3><div style="font-size:28px;font-weight:800">${s.projects} / ${s.media}</div><p class="sub">${s.bulkJobs} bulk jobs · ${s.shortsJobs} Shorts jobs</p></div>
    <div class="card"><h3>Renders / AI jobs</h3><div style="font-size:28px;font-weight:800">${s.renderJobs} / ${s.aiJobs}</div><p class="sub">${s.rendersDone} renders done · ${s.aiJobsDone} AI jobs done</p></div>
    <div class="card"><h3>Social posts</h3><div style="font-size:28px;font-weight:800">${s.socialPosts}</div><p class="sub">${s.socialPublished} published · ${s.marketplaceTemplates} marketplace templates</p></div>
    <div class="card"><h3>Credits</h3><div style="font-size:28px;font-weight:800">${s.creditsOutstanding}</div><p class="sub">outstanding across users · ${s.creditsSpent} spent in total</p></div>
    <div class="card"><h3>System health</h3>
      <p class="sub">FFmpeg: ${health.health.ffmpeg.ok ? '✓ ' + esc(health.health.ffmpeg.version) : '✗ not found'}</p>
      <p class="sub">DB: ${fmtBytes(health.health.db.bytes)} · Uploads: ${fmtBytes(health.health.uploads.bytes)} (${health.health.uploads.files} files) · Renders: ${fmtBytes(health.health.renders.bytes)}</p>
      <p class="sub">Uptime ${Math.round(health.health.uptimeSeconds / 60)} min · Node ${esc(health.health.nodeVersion)}</p>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Plan requests ${requests.requests.filter((r) => r.status === 'pending').length ? `<span class="badge warn">${requests.requests.filter((r) => r.status === 'pending').length} pending</span>` : ''}</h3>
    <p class="sub">No payment is taken in this build — approving a request changes the plan and tops the credits up to the plan's allowance. Rejecting leaves the user on their current plan.</p>
    ${requests.requests.length ? `<table><thead><tr><th>User</th><th>Plan</th><th>Status</th><th>Requested</th><th></th></tr></thead><tbody>
      ${requests.requests.map((r) => `<tr><td>${esc(r.user.email)} (${esc(r.user.plan)}, ${r.user.creditsBalance} cr)</td><td>${esc(r.plan)}</td><td>${esc(r.status)}</td><td>${fmtDate(r.createdAt)}</td>
      <td>${r.status === 'pending' ? `<button class="btn btn-sm btn-primary" data-approve-req="${r.id}">Approve</button> <button class="btn btn-sm" data-reject-req="${r.id}">Reject</button>` : ''}</td></tr>`).join('')}</tbody></table>`
    : '<p class="sub" style="margin-top:8px">No plan requests yet.</p>'}
  </div>
  <div class="card" style="margin-top:16px"><h3>Users</h3>
    <div class="form-row"><input id="ad-q" placeholder="Search by name or email…" value="${esc(state.params.q || '')}" style="flex:1"><button class="btn" id="ad-search">Search</button></div>
    <table style="margin-top:10px"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Plan</th><th>Credits</th><th>Status</th><th></th></tr></thead><tbody>
    ${users.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>
      ${isAdmin && u.id !== state.user.id && !(u.role === 'OWNER' && !isOwner) ? `<select data-role="${u.id}">${(isOwner ? ['OWNER', 'ADMIN', 'USER'] : ['ADMIN', 'USER']).map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>` : esc(u.role) + (u.role === 'OWNER' && !isOwner ? ' <span class="badge">🔒 Protected</span>' : '')}
      </td><td>${esc(u.plan)}</td><td>${u.creditsBalance}</td><td>${u.suspended ? '<span class="badge err">Suspended</span>' : '<span class="badge ok">Active</span>'}</td>
      <td>${u.id !== state.user.id ? `
        <button class="btn btn-sm" data-usage="${u.id}">Usage</button>
        ${u.role === 'OWNER' && !isOwner ? '<span class="badge">🔒 Protected</span>' : `
        ${u.suspended ? `<button class="btn btn-sm" data-unsuspend="${u.id}">Unsuspend</button>` : `<button class="btn btn-sm btn-danger" data-suspend="${u.id}">Suspend</button>`}
        <button class="btn btn-sm" data-reset-credits="${u.id}">Reset credits</button>
        ${isAdmin ? `<button class="btn btn-sm btn-danger" data-del-user="${u.id}">Delete</button>` : ''}`}` : '<span class="badge">you</span>'}</td></tr>`).join('')}
    </tbody></table>
    ${!isOwner ? '<p class="sub" style="margin-top:8px">You are a Super Admin: you can suspend, change roles, reset credits and delete any user — except OWNER accounts, which are protected (🔒) and only the OWNER can manage.</p>' : ''}
  </div>
  <div id="ad-usage" style="margin-top:16px"></div>
  <div class="card" style="margin-top:16px"><h3>Audit log (latest ${audit.entries.length})</h3>
    ${audit.entries.length ? `<table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${audit.entries.map((a) => `<tr><td>${fmtDate(a.created_at)}</td><td>${a.user_id || '—'}</td><td>${esc(a.action)}</td><td>${esc(a.detail || '')}</td></tr>`).join('')}</tbody></table>`
    : '<p class="sub">No audit entries yet.</p>'}
  </div>`;

  document.getElementById('ad-search').addEventListener('click', () => go('admin', { q: document.getElementById('ad-q').value.trim() || undefined }));
  document.getElementById('ad-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('ad-search').click(); });
  c.querySelectorAll('[data-role]').forEach((sel) => sel.addEventListener('change', async () => {
    try { await api(`/api/admin/users/${sel.dataset.role}/role`, { method: 'PATCH', body: JSON.stringify({ role: sel.value }) }); toast('Role updated.'); renderView(); }
    catch (e) { toast(e.message, true); renderView(); }
  }));
  c.querySelectorAll('[data-suspend]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Suspend this user? They will be signed out immediately and cannot log in again until unsuspended.')) return;
    try { await api(`/api/admin/users/${b.dataset.suspend}/suspend`, { method: 'POST' }); toast('User suspended.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-unsuspend]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/admin/users/${b.dataset.unsuspend}/unsuspend`, { method: 'POST' }); toast('User unsuspended.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-reset-credits]').forEach((b) => b.addEventListener('click', async () => {
    const v = prompt('Reset credits to (leave empty for the plan allowance):');
    if (v === null) return;
    try {
      await api(`/api/admin/users/${b.dataset.resetCredits}/reset-credits`, { method: 'POST', body: JSON.stringify(v.trim() === '' ? {} : { credits: Number(v) }) });
      toast('Credits reset.'); renderView();
    } catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-del-user]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this user permanently? This cannot be undone.')) return;
    try { await api(`/api/admin/users/${b.dataset.delUser}`, { method: 'DELETE' }); toast('User deleted.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-usage]').forEach((b) => b.addEventListener('click', async () => {
    const box = document.getElementById('ad-usage');
    try {
      const r = await api(`/api/admin/users/${b.dataset.usage}/usage`);
      const u = r.usage;
      box.innerHTML = `<div class="card"><h3>Usage — ${esc(r.user.email)}</h3>
        <p class="sub">Projects ${u.counts.projects} · Media ${u.counts.media} (${fmtBytes(u.counts.mediaBytes)}) · Renders ${u.counts.renders} · AI jobs ${u.counts.aiJobs} · Social posts ${u.counts.socialPosts} · Bulk jobs ${u.counts.bulkJobs} · Credits ${u.creditsBalance} (${u.plan})</p>
        ${u.recentUsage.length ? `<table><thead><tr><th>When</th><th>Action</th><th>Credits</th><th>Detail</th></tr></thead><tbody>
          ${u.recentUsage.map((x) => `<tr><td>${fmtDate(x.created_at)}</td><td>${esc(x.action)}</td><td>${x.credits}</td><td>${esc(x.detail || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="sub">No usage yet.</p>'}
      </div>`;
      box.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-approve-req]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/billing/admin/requests/${b.dataset.approveReq}/approve`, { method: 'POST' }); toast('Plan request approved.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
  c.querySelectorAll('[data-reject-req]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/billing/admin/requests/${b.dataset.rejectReq}/reject`, { method: 'POST' }); toast('Plan request rejected.'); renderView(); }
    catch (e) { toast(e.message, true); }
  }));
}

/* ---------- Analytics ---------- */
async function viewAnalytics(c) {
  const days = Number(state.params.days || 30);
  const a = await api(`/api/analytics?days=${days}`);
  const rows = (list, cols) => list.length
    ? `<table><thead><tr>${cols.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${list.map((r) => `<tr>${cols.map((x) => `<td>${esc(r[x] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '<p class="sub">No data in this range yet.</p>';
  c.innerHTML = `
  <div class="card"><h3>Analytics — last ${a.range.days} days</h3>
    <p class="sub">${esc(a.note)}</p>
    <div class="form-row" style="margin-top:10px">
      <label>Range <select id="an-days">${[7, 30, 90, 365].map((d) => `<option value="${d}" ${a.range.days === d ? 'selected' : ''}>${d} days</option>`).join('')}</select></label>
    </div>
  </div>
  <div class="grid grid-3" style="margin-top:16px">
    <div class="card"><h3>Renders</h3><div style="font-size:28px;font-weight:800">${a.totals.renders}</div><p class="sub">${a.totals.rendersDone} done</p></div>
    <div class="card"><h3>AI generations</h3><div style="font-size:28px;font-weight:800">${a.totals.aiJobs}</div><p class="sub">across all modes</p></div>
    <div class="card"><h3>Social posts</h3><div style="font-size:28px;font-weight:800">${a.totals.socialPosts}</div><p class="sub">yours, all statuses</p></div>
    <div class="card"><h3>Your credits</h3><div style="font-size:28px;font-weight:800">${a.myCredits}</div><p class="sub">earned ${a.creditEarned} in range</p></div>
    <div class="card"><h3>Storage</h3><div style="font-size:28px;font-weight:800">${fmtBytes(a.storage.uploads.bytes + a.storage.renders.bytes)}</div><p class="sub">uploads ${fmtBytes(a.storage.uploads.bytes)} · renders ${fmtBytes(a.storage.renders.bytes)}</p></div>
    <div class="card"><h3>Marketplace</h3><div style="font-size:28px;font-weight:800">${a.totals.marketplaceTemplates}</div><p class="sub">published templates</p></div>
  </div>
  <div class="grid grid-2" style="margin-top:16px">
    <div class="card"><h3>Renders per day</h3>${rows(a.rendersByDay, ['day', 'count'])}</div>
    <div class="card"><h3>AI generations by mode</h3>${rows(a.aiByMode, ['mode', 'count'])}</div>
    <div class="card"><h3>Your posts by status</h3>${rows(a.postsByStatus, ['status', 'count'])}</div>
    <div class="card"><h3>Your posts by platform</h3>${rows(a.postsByPlatform, ['platform', 'count'])}</div>
    <div class="card"><h3>Your credit burn (by action)</h3>${rows(a.creditBurn, ['action', 'count', 'total'])}</div>
    <div class="card"><h3>Top templates (by installs)</h3>${rows(a.topTemplates, ['name', 'kind', 'downloads'])}</div>
  </div>`;
  document.getElementById('an-days').addEventListener('change', async (e) => {
    state.params.days = e.target.value;
    await viewAnalytics(c);
  });
}
