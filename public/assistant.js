'use strict';
/* AI Assistant (v2.2.4) — project-aware help: summarise, suggest
   improvements, make a professional version, create five versions.
   Everything runs through the LLM abstraction: without an LLM key the
   actions refuse with key_needed and create nothing. Actions that change
   a project always create a NEW project — the original is never edited. */

async function viewAssistant(c) {
  const [actions, projects] = await Promise.all([
    api('/api/assistant/actions').catch((e) => ({ error: e.message })),
    api('/api/projects').catch(() => ({ projects: [] })),
  ]);
  const list = (projects.projects || []);
  const selectedId = state.params.projectId ? Number(state.params.projectId) : (list[0] ? list[0].id : null);
  const selected = list.find((p) => p.id === selectedId) || null;
  const llm = actions.llm || { configured: false, providers: [] };
  c.innerHTML = `
  <div class="card"><h3>🤖 AI Assistant</h3>
    <p class="sub">Pick a project and ask the assistant. It reads the real project — its layers, slides, clips and text — and answers from that, never from invented content.</p>
    ${llm.configured
      ? `<p class="sub">✅ LLM ready — active provider: <b>${esc((llm.providers.find((p) => p.active) || {}).label || llm.active || 'unknown')}</b>. Change it in Settings → AI Providers.</p>`
      : `<p class="sub" style="color:var(--warning)">⚠️ No LLM key configured — every action below will refuse with “key needed” until you add one. Free path: a Google Gemini key from AI Studio (no card), added in Settings → AI Providers and set as the active LLM provider.</p>`}
    <div class="form-row" style="margin-top:10px">
      <label style="flex:2">Project <select id="as-project">${list.map((p) => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)} (${esc(p.type)})</option>`).join('') || '<option value="">No projects yet</option>'}</select></label>
    </div>
    ${selected ? `<p class="sub">Selected: <b>${esc(selected.name)}</b> · ${esc(selected.type)} · updated ${fmtDate(selected.updatedAt)}</p>` : ''}
  </div>
  <div class="grid grid-2" style="margin-top:16px">
    <div class="card"><h3>What should the assistant do?</h3>
      ${(actions.actions || []).map((a) => `
        <div class="list-row"><div class="grow">
          <div class="t">${esc(a.name)}</div>
          <div class="m">${esc(a.description)} · Works on: ${a.types.join(', ')} · ${a.cost === 'ai_design' ? '2 credits' + (a.id === 'five-versions' ? ' × 5' : '') : '1 credit'}</div>
        </div>
        <button class="btn btn-sm btn-primary" data-action="${a.id}" ${selected && a.types.includes(selected.type) ? '' : 'disabled'}>${a.id === 'five-versions' ? 'Create 5' : a.id === 'make-professional' ? 'Make professional' : a.id === 'summarise' ? 'Summarise' : 'Suggest'}</button>
        </div>`).join('')}
      <p class="sub" style="margin-top:10px">Disabled buttons mean the action does not support the selected project type. “Make this more professional” works on design + deck; “Create five versions” on design only; Summarise and Suggest work on any project.</p>
    </div>
    <div class="card"><h3>Result</h3><div id="as-result"><p class="sub">Nothing asked yet — pick an action on the left.</p></div></div>
  </div>
  <div class="error" id="as-error" style="display:none;margin-top:16px"></div>`;

  document.getElementById('as-project').addEventListener('change', (e) => go('assistant', { projectId: e.target.value }));
  const resultBox = document.getElementById('as-result');
  const errBox = document.getElementById('as-error');
  const showError = (msg) => { errBox.textContent = msg; errBox.style.display = 'block'; };
  c.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', async () => {
    if (!selected) return;
    const action = b.dataset.action;
    errBox.style.display = 'none';
    resultBox.innerHTML = '<p class="sub">Working — asking the LLM about your project…</p>';
    b.disabled = true;
    try {
      const r = await api(`/api/assistant/${action}`, { method: 'POST', body: JSON.stringify({ projectId: selected.id }) });
      if (action === 'summarise') {
        resultBox.innerHTML = `
          <h4>Summary — ${esc(r.project.name)}</h4>
          <p>${esc(r.summary)}</p>
          ${r.keyPoints.length ? `<h4 style="margin-top:12px">Key points</h4><ul>${r.keyPoints.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
          <div class="kv"><span>Audience</span><span>${esc(r.audience || '—')}</span></div>
          <div class="kv"><span>Tone</span><span>${esc(r.tone || '—')}</span></div>`;
      } else if (action === 'suggest') {
        resultBox.innerHTML = `
          <h4>Suggestions — ${esc(r.project.name)}</h4>
          <p class="sub">Suggestions only — nothing was changed.</p>
          ${r.suggestions.map((s) => `<div class="list-row"><div class="grow"><div class="t">${esc(s.suggestion)}</div><div class="m">${esc(s.area)}</div></div><span class="badge ${s.priority === 'high' ? 'err' : s.priority === 'medium' ? 'warn' : ''}">${esc(s.priority)}</span></div>`).join('')}`;
      } else if (action === 'make-professional') {
        resultBox.innerHTML = `
          <h4>Professional version created</h4>
          <p>New project: <b>${esc(r.newProject.name)}</b> — the original was not changed.</p>
          ${r.preview.headline ? `<div class="kv"><span>New headline</span><span>${esc(r.preview.headline)}</span></div>` : ''}
          ${r.preview.subheading ? `<div class="kv"><span>New subheading</span><span>${esc(r.preview.subheading)}</span></div>` : ''}
          ${r.preview.slides ? `<p class="sub">${esc(r.preview.note || '')}</p>` : ''}
          <div style="margin-top:10px"><button class="btn btn-primary" id="as-open-new">Open the new project →</button></div>`;
        document.getElementById('as-open-new').addEventListener('click', () => go('project', { id: r.newProject.id }));
      } else if (action === 'five-versions') {
        resultBox.innerHTML = `
          <h4>Five versions created</h4>
          <p class="sub">Five NEW projects — the original was not changed.</p>
          ${r.versions.map((v, i) => `<div class="list-row"><div class="grow"><div class="t">Version ${i + 1} — ${esc(v.headline)}</div><div class="m">${esc(v.name)}</div></div><button class="btn btn-sm" data-open-ver="${v.id}">Open →</button></div>`).join('')}`;
        resultBox.querySelectorAll('[data-open-ver]').forEach((x) => x.addEventListener('click', () => go('project', { id: x.dataset.openVer })));
      }
      toast('Assistant finished.');
    } catch (e) {
      resultBox.innerHTML = '<p class="sub">The assistant could not finish — see the error below.</p>';
      showError(e.message);
    } finally {
      b.disabled = false;
    }
  }));
}
