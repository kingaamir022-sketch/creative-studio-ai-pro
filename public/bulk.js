'use strict';
/* Bulk Studio frontend (Phase 4) — Bulk Video, Bulk Design, Smart Template Builder.
   All data comes from /api/bulk; every button does its real action. Nothing is
   faked: AI background modes and Google Sheets show their honest reason. */
const BulkUI = (() => {
  let pollTimer = null;
  let detail = null; // { job, rows, dataset, fitSummary, fields, step }
  const stopPolling = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };
  const isQuiz = (job) => job && job.settings && job.settings.quiz && job.settings.quiz.enabled;
  const quizMode = (job) => (job.settings.quiz && job.settings.quiz.mode) || 'single';

  function fitBadge(fr) {
    if (!fr) return '<span class="badge">Not checked</span>';
    if (fr.overall === 'OK') return '<span class="badge ok">Fit: OK</span>';
    if (fr.overall === 'Adjusted') {
      const q = fr.questionFont ? `Q ${fr.questionFont}px` : '';
      const o = fr.optionFont ? `· Options ${fr.optionFont}px` : '';
      return `<span class="badge warn">Fit: Adjusted ${esc(q + o)}</span>`;
    }
    return '<span class="badge err">Fit: Needs attention</span>';
  }
  function fitDetail(fr) {
    if (!fr) return '';
    const parts = [];
    if (fr.questionFont) parts.push(`Question font ${fr.questionFont}px`);
    if (fr.optionFont) parts.push(`Options font ${fr.optionFont}px`);
    if (fr.explanationFont) parts.push(`Explanation ${fr.explanationFont}px`);
    if (fr.suggestedText) parts.push(`Try shorter: “${esc(fr.suggestedText)}”`);
    if (fr.issues && fr.issues.length) parts.push(esc(fr.issues.join(' ')));
    return parts.length ? `<div class="fit-detail">${parts.join(' · ')}</div>` : '';
  }
  const statusBadge = (s) => ({
    draft: '<span class="badge">Draft</span>',
    running: '<span class="badge warn">Running</span>',
    done: '<span class="badge ok">Done</span>',
    partial: '<span class="badge warn">Partial</span>',
    failed: '<span class="badge err">Failed</span>',
    cancelled: '<span class="badge">Cancelled</span>',
    queued: '<span class="badge">Queued</span>',
    rendering: '<span class="badge warn">Rendering</span>',
    skipped: '<span class="badge">Skipped</span>',
  }[s] || `<span class="badge">${esc(s)}</span>`);

  async function loadJob(id) {
    const data = await api(`/api/bulk/${id}`);
    detail = { ...data, step: (detail && detail.job && detail.job.id === id) ? detail.step : 1, fields: null };
    // Quiz jobs store templateProjectId as null — the preset is 'quiz'.
    const tplId = data.job.templateProjectId || (isQuiz(data.job) ? 'quiz' : null);
    if (tplId) {
      try {
        const f = await api(`/api/bulk/templates/${tplId}/fields`);
        detail.fields = f;
      } catch { detail.fields = null; }
    }
    return detail;
  }

  /* ---------- List view ---------- */
  async function viewList(c, kind) {
    stopPolling();
    const [jobsData, projectsData] = await Promise.all([
      api('/api/bulk').catch(() => ({ jobs: [] })),
      api('/api/projects').catch(() => ({ projects: [] })),
    ]);
    const jobs = (jobsData.jobs || []).filter((j) => j.kind === kind);
    const templates = (projectsData.projects || []).filter((p) => p.type === (kind === 'video' ? 'video' : 'design'));
    const title = kind === 'video' ? 'Bulk Video Studio' : 'Bulk Design Studio';
    const quizCard = kind === 'video' ? `
      <div class="bulk-card quiz-card">
        <div class="bulk-card-emoji">🎯</div>
        <h3>Quiz Video (preset)</h3>
        <p>Hook in the first second → countdown → reveal with the correct option in green → score CTA. 9:16, one question per row, or 5 questions per video.</p>
        <button class="btn btn-primary" id="new-quiz">New Quiz batch</button>
      </div>` : '';
    c.innerHTML = `
    <h2>${title}</h2>
    <p class="sub">One template + a spreadsheet = a personalised ${kind === 'video' ? 'video' : 'design'} per row. Duplicate rows are skipped — only the first copy is ever made.</p>
    <div class="bulk-cards">${quizCard}
      <div class="bulk-card">
        <div class="bulk-card-emoji">${kind === 'video' ? '📹' : '📄'}</div>
        <h3>New ${kind === 'video' ? 'bulk video' : 'bulk design'} batch</h3>
        <label for="nb-name">Batch name</label>
        <input id="nb-name" placeholder="e.g. Summer Sale — 40 products">
        <label for="nb-template">Master template</label>
        <select id="nb-template">${templates.map((t) => `<option value="${t.id}">${esc(t.name)} (${esc(t.type)})</option>`).join('') || '<option value="">No template project yet — create one in the Video/Graphic Editor first</option>'}</select>
        <div class="error" id="nb-error"></div>
        <button class="btn btn-primary" id="nb-create">Create batch</button>
      </div>
    </div>
    <h3 style="margin-top:24px">Your batches</h3>
    ${jobs.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Template</th><th>Status</th><th>Rows</th><th>Done</th><th>Failed</th><th>Duplicates skipped</th><th></th></tr></thead><tbody>
      ${jobs.map((j) => `<tr>
        <td>${esc(j.name)}</td><td>${esc(j.settings && j.settings.quiz && j.settings.quiz.enabled ? 'Quiz Video (preset)' : String(j.templateProjectId))}</td>
        <td>${statusBadge(j.status)}</td><td>${j.rowsTotal}</td><td>${j.rowsDone}</td><td>${j.rowsFailed}</td>
        <td>${j.dedupeSummary ? j.dedupeSummary.skipped : 0}</td>
        <td><button class="btn btn-sm" data-open="${j.id}">Open</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="card"><p class="sub">No batches yet. Create one above.</p></div>'}`;
    const open = (id) => go(kind === 'video' ? 'bulk-video' : 'bulk-design', { id });
    c.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => open(b.dataset.open)));
    const create = async (templateProjectId, name) => {
      const err = document.getElementById('nb-error');
      try {
        const r = await api('/api/bulk', { method: 'POST', body: JSON.stringify({ name: name || undefined, kind, templateProjectId }) });
        toast('Batch created.'); open(r.job.id);
      } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
    };
    document.getElementById('nb-create').addEventListener('click', () => {
      create(document.getElementById('nb-template').value, document.getElementById('nb-name').value.trim());
    });
    const qbtn = document.getElementById('new-quiz');
    if (qbtn) qbtn.addEventListener('click', () => create('quiz', 'Quiz batch'));
  }

  /* ---------- Detail view ---------- */
  async function viewDetail(c, kind, id) {
    stopPolling();
    const d = await loadJob(id);
    const { job } = d;
    const step = d.step || 1;
    const steps = ['1 · Template', '2 · Data', '3 · Background', '4 · Generate'];
    const quiz = isQuiz(job);
    c.innerHTML = `
    <div class="bulk-head">
      <div><h2>${esc(job.name)}</h2>
      <p class="sub">${quiz ? `🎯 Quiz Video preset · ${quizMode(job) === 'multi' ? 'multi-question (grouped)' : 'single-question per row'}` : `${kind === 'video' ? 'Bulk video' : 'Bulk design'} · template ${esc(job.templateProjectId || 'Quiz Video (preset)')}`} · ${statusBadge(job.status)}</p></div>
      <div class="bulk-head-actions">
        <button class="btn" id="bk-back">← All batches</button>
        <button class="btn" id="bk-refresh">Refresh</button>
        ${job.status === 'running' ? '<button class="btn" id="bk-cancel">Cancel batch</button>' : ''}
        ${(job.status === 'done' || job.status === 'partial') ? `<a class="btn btn-primary" href="/api/bulk/${job.id}/zip">⬇ Download ZIP</a>` : ''}
        ${job.status !== 'running' ? '<button class="btn" id="bk-delete">Delete batch</button>' : ''}
      </div>
    </div>
    <div class="bulk-steps">${steps.map((s, i) => `<button class="bulk-step ${step === i + 1 ? 'active' : ''}" data-step="${i + 1}">${s}</button>`).join('')}</div>
    <div id="bulk-step-body"></div>`;
    document.getElementById('bk-back').addEventListener('click', () => go(kind === 'video' ? 'bulk-video' : 'bulk-design'));
    document.getElementById('bk-refresh').addEventListener('click', () => renderView());
    c.querySelectorAll('.bulk-step').forEach((b) => b.addEventListener('click', () => { detail.step = parseInt(b.dataset.step, 10); renderView(); }));
    const cancelBtn = document.getElementById('bk-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', async () => { try { await api(`/api/bulk/${job.id}/cancel`, { method: 'POST' }); toast('Batch cancelled.'); renderView(); } catch (e) { toast(e.message, true); } });
    const delBtn = document.getElementById('bk-delete');
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!confirm('Delete this batch? Rendered outputs stay in the Export Center.')) return;
      try { await api(`/api/bulk/${job.id}`, { method: 'DELETE' }); toast('Batch deleted.'); go(kind === 'video' ? 'bulk-video' : 'bulk-design'); } catch (e) { toast(e.message, true); }
    });
    await renderStep(c, kind);
    if (job.status === 'running') {
      pollTimer = setTimeout(() => { if (state.view === 'bulk-video' || state.view === 'bulk-design') renderView(); }, 2500);
    }
  }

  async function renderStep(c, kind) {
    const body = c.querySelector('#bulk-step-body');
    if (!body || !detail) return;
    const step = detail.step || 1;
    if (step === 1) return renderStepTemplate(body, kind);
    if (step === 2) return renderStepData(body, kind);
    if (step === 3) return renderStepBackground(body, kind);
    return renderStepGenerate(body, kind);
  }

  function fieldOptions(columns, selected) {
    return `<option value="">— not mapped —</option>${columns.map((col) => `<option value="${esc(col)}" ${col === selected ? 'selected' : ''}>${esc(col)}</option>`).join('')}`;
  }

  /* ---------- Step 1: Template ---------- */
  async function renderStepTemplate(body, kind) {
    const { job, fields } = detail;
    const quiz = isQuiz(job);
    const s = job.settings || {};
    const qs = s.quiz || {};
    if (quiz) {
      try { const v = await api('/api/voice/profiles'); window.__voiceProfiles = v.profiles || []; }
      catch { window.__voiceProfiles = []; }
    }
    const fieldRows = fields && fields.fields ? fields.fields.map((f) => `
      <tr><td><code>{{${esc(f.name)}}</code></td><td>${esc(f.kind)}</td>
      <td><select data-map-field="${esc(f.name)}">${fieldOptions(detail.dataset.columns, (s.fieldMapping || {})[f.name])}</select></td></tr>`).join('') : '';
    body.innerHTML = `
    <div class="card"><h3>Template &amp; field mapping</h3>
      <p class="sub">${quiz ? 'Quiz Video preset — the columns below are fixed by the quiz format. Map each one to your spreadsheet column.' : 'Each <code>{{FIELD}}</code> in the template is filled from a spreadsheet column. The mapping is saved with the batch.'}</p>
      ${fields ? `<div class="table-wrap"><table class="table"><thead><tr><th>Template field</th><th>Type</th><th>Spreadsheet column</th></tr></thead><tbody>${fieldRows || '<tr><td colspan="3">No dynamic fields found in this template yet. Add {{FIELD}} placeholders in the editor, or bind clips in the Template Builder.</td></tr>'}</tbody></table></div>`
        : '<p class="sub">Could not scan the template fields.</p>'}
      <button class="btn btn-primary" id="save-mapping">Save mapping</button>
      <span class="sub" id="mapping-msg"></span>
    </div>
    ${quiz ? `<div class="card"><h3>Quiz settings</h3>
      <div class="form-row">
        <label>Mode <select id="q-mode"><option value="single" ${qs.mode !== 'multi' ? 'selected' : ''}>One video per question</option><option value="multi" ${qs.mode === 'multi' ? 'selected' : ''}>Group into multi-question videos</option></select></label>
        <label>Questions per video <input id="q-per" type="number" min="2" max="10" value="${qs.questionsPerVideo || 5}"></label>
        <label>Read (seconds) <input id="q-read" type="number" min="1" max="5" value="${qs.readSeconds || 2}"></label>
        <label>Countdown (seconds) <input id="q-timer" type="number" min="3" max="6" value="${qs.timerSeconds || 3}"></label>
        <label>Reveal (seconds) <input id="q-reveal" type="number" min="1" max="5" value="${qs.revealSeconds || 2}"></label>
        <label>Score card (seconds) <input id="q-cta-secs" type="number" min="2" max="5" value="${qs.ctaSeconds || 3}"></label>
      </div>
      <label>Score card text <input id="q-cta" value="${esc(qs.ctaText || 'Kitne sahi hue? Comment mein score likho')}"></label>
      <label>CTA sub-line <input id="q-ctasub" value="${esc(qs.ctaSub || 'Follow for more quizzes')}"></label>
      <button class="btn btn-primary" id="save-quiz">Save quiz settings</button>
      <span class="sub" id="quiz-msg"></span>
      <p class="sub" style="margin-top:10px">Spec defaults (research 2026-11-12): 2s read + 3s countdown (always 3–6s, identical every question) + 2s reveal, 3s score card at the end. 5 questions ≈ 38s at these defaults; 60s+ needs 8 questions or a 5–6s countdown. No AI voiceover and no AI-generated questions — questions come from your spreadsheet (Phase 7 adds TTS/LLM).</p>
    </div>
    <div class="card"><h3>🎙️ Narration &amp; animations — question → options → answer</h3>
      <p class="sub">Every round is spoken in order: first the question, then the options one by one, then the answer reveal. Each element has an animation. <strong>Auto</strong> applies sensible defaults (question fades in, options slide in staggered, answer pops); <strong>Manual</strong> lets you set each element's animation, delay and duration.</p>
      <div class="form-row">
        <label>Mode <select id="n-mode"><option value="auto" ${!qs.animations || qs.animations.mode !== 'manual' ? 'selected' : ''}>Auto (defaults)</option><option value="manual" ${qs.animations && qs.animations.mode === 'manual' ? 'selected' : ''}>Manual (my settings)</option></select></label>
        <label>Option stagger (seconds) <input id="n-stagger" type="number" min="0" max="2" step="0.1" value="${(qs.animations && qs.animations.optionStagger) ?? 0.4}"></label>
      </div>
      <div id="n-manual" style="${qs.animations && qs.animations.mode === 'manual' ? '' : 'display:none'}">
        ${['question', 'option', 'answer', 'explanation', 'chip'].map((el) => {
          const a = (qs.animations && qs.animations.elements && qs.animations.elements[el]) || {};
          return `<div class="form-row"><label style="min-width:110px"><strong>${el[0].toUpperCase() + el.slice(1)}</strong></label>
            <label>Animation <select data-n-el="${el}" data-n-f="type">${['none', 'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'pop'].map((t) => `<option value="${t}" ${a.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
            <label>Duration (s) <input data-n-el="${el}" data-n-f="duration" type="number" min="0.1" max="2" step="0.1" value="${a.duration ?? ''}" placeholder="default"></label>
            <label>Delay (s) <input data-n-el="${el}" data-n-f="delay" type="number" min="0" max="5" step="0.1" value="${a.delay ?? ''}" placeholder="0"></label>
          </div>`;
        }).join('')}
        <p class="sub">“Pop” grows the text from 70% size; “slide” glides it in. Typewriter is not possible with the renderer and is not offered.</p>
      </div>
      <button class="btn btn-primary" id="save-narration">Save narration &amp; animations</button>
      <span class="sub" id="narration-msg"></span>
    </div>
    <div class="card"><h3>🔊 Voice for this batch</h3>
      <p class="sub">One voice for the whole batch. A row's VOICE column can still override it per row; otherwise your default voice applies. Manage voices in the sidebar → Voices.</p>
      <div class="form-row">
        <label>Batch voice <select id="v-profile"><option value="">— your default voice —</option>${(window.__voiceProfiles || []).map((p) => `<option value="${p.id}" ${job.voice && job.voice.profileId === p.id ? 'selected' : ''}>${esc(p.name)}${p.isDefault ? ' (default)' : ''} — ${p.kind === 'clone' ? 'your voice' : 'AI voice'}</option>`).join('')}</select></label>
        <label><input type="checkbox" id="v-tts" ${job.ttsEnabled ? 'checked' : ''}> Speak narration with AI voice (needs a provider key)</label>
      </div>
      <button class="btn btn-primary" id="save-voice">Save voice</button>
      <span class="sub" id="voice-msg"></span>
      <p class="sub">Without the AI-voice checkbox, the batch uses recorded narration audio (NARRATION_AUDIO column) — that works now, with no key. With it on, each segment is spoken by the voice above; without a key the row fails with a clear “key needed” error — no fake voice is ever generated.</p>
    </div>` : ''}
    ${quiz ? '' : `<div class="card"><h3>Template still editable</h3>
      <p class="sub">The master template stays a normal ${kind} project — edit it in the ${kind === 'video' ? 'Video Editor' : 'Graphic Editor'} and the next batch uses the new version. Bindings are stored on the template.</p>
      <button class="btn" id="open-template-builder">Open in Template Builder</button>
    </div>`}`;
    const tbBtn = document.getElementById('open-template-builder');
    if (tbBtn) tbBtn.addEventListener('click', () => go('template-builder', { projectId: job.templateProjectId }));
    document.getElementById('save-mapping').addEventListener('click', async () => {
      const mapping = {};
      body.querySelectorAll('[data-map-field]').forEach((sel) => { if (sel.value) mapping[sel.dataset.mapField] = sel.value; });
      try {
        await api(`/api/bulk/${job.id}`, { method: 'PATCH', body: JSON.stringify({ settings: { fieldMapping: mapping } }) });
        document.getElementById('mapping-msg').textContent = 'Mapping saved.';
        await loadJob(job.id); renderView();
      } catch (e) { toast(e.message, true); }
    });
    const saveQuiz = document.getElementById('save-quiz');
    if (saveQuiz) saveQuiz.addEventListener('click', async () => {
      try {
        await api(`/api/bulk/${job.id}`, { method: 'PATCH', body: JSON.stringify({ settings: { quiz: {
          mode: document.getElementById('q-mode').value,
          questionsPerVideo: parseInt(document.getElementById('q-per').value, 10) || 5,
          readSeconds: parseInt(document.getElementById('q-read').value, 10) || 2,
          timerSeconds: Math.max(3, Math.min(6, parseInt(document.getElementById('q-timer').value, 10) || 3)),
          revealSeconds: parseInt(document.getElementById('q-reveal').value, 10) || 2,
          ctaSeconds: parseInt(document.getElementById('q-cta-secs').value, 10) || 3,
          ctaText: document.getElementById('q-cta').value.trim(),
          ctaSub: document.getElementById('q-ctasub').value.trim(),
        } } }) });
        document.getElementById('quiz-msg').textContent = 'Quiz settings saved.';
        await loadJob(job.id); renderView();
      } catch (e) { toast(e.message, true); }
    });
    const nMode = document.getElementById('n-mode');
    if (nMode) nMode.addEventListener('change', () => {
      document.getElementById('n-manual').style.display = nMode.value === 'manual' ? '' : 'none';
    });
    const saveNarr = document.getElementById('save-narration');
    if (saveNarr) saveNarr.addEventListener('click', async () => {
      const mode = document.getElementById('n-mode').value;
      const elements = {};
      body.querySelectorAll('[data-n-el]').forEach((el) => {
        const name = el.dataset.nEl, field = el.dataset.nF;
        elements[name] = elements[name] || {};
        if (field === 'type') elements[name].type = el.value;
        else if (el.value !== '') elements[name][field] = parseFloat(el.value);
      });
      try {
        await api(`/api/bulk/${job.id}`, { method: 'PATCH', body: JSON.stringify({ settings: { quiz: { animations: { mode, optionStagger: parseFloat(document.getElementById('n-stagger').value) || 0.4, elements } } } }) });
        document.getElementById('narration-msg').textContent = 'Narration & animations saved.';
        await loadJob(job.id); renderView();
      } catch (e) { toast(e.message, true); }
    });
    const saveVoice = document.getElementById('save-voice');
    if (saveVoice) saveVoice.addEventListener('click', async () => {
      const profileId = document.getElementById('v-profile').value;
      try {
        await api(`/api/bulk/${job.id}`, { method: 'PATCH', body: JSON.stringify({ settings: { voice: { profileId: profileId ? parseInt(profileId, 10) : null, tts: document.getElementById('v-tts').checked } } }) });
        document.getElementById('voice-msg').textContent = 'Batch voice saved.';
        await loadJob(job.id); renderView();
      } catch (e) { toast(e.message, true); }
    });
  }

  /* ---------- Step 2: Data ---------- */
  async function renderStepData(body, kind) {
    const { job, dataset, rows } = detail;
    const s = job.settings || {};
    const dd = s.dedupeSummary;
    const skippedRows = (rows || []).filter((r) => r.status === 'skipped');
    const dupText = dd ? `${dd.total} total · ${dd.unique} unique · ${dd.skipped} duplicates skipped${dd.skippedRows && dd.skippedRows.length ? ` — skipped rows: ${dd.skippedRows.map((x) => `row ${x.rowNumber} (duplicate of row ${x.duplicateOfRowNumber})`).join(', ')}` : ''}` : 'No data imported yet.';
    const preview = (rows || []).slice(0, 10);
    body.innerHTML = `
    <div class="card"><h3>Import data</h3>
      <p class="sub">XLSX, CSV or JSON — or paste a table. ${isQuiz(job) ? 'Quiz columns: QUESTION, OPTION_A–D, CORRECT (A–D or option text), EXPLANATION, CATEGORY, DIFFICULTY, TIMER_SECONDS, QUESTION_IMAGE (optional), NARRATION_AUDIO (optional — recorded narration audio id or file name), VOICE (optional — per-row voice profile name or id).' : 'First row = column names.'}</p>
      <div class="form-row">
        <label>Upload file <input type="file" id="data-file" accept=".xlsx,.xls,.csv,.json"></label>
        <button class="btn btn-primary" id="data-upload">Upload &amp; import</button>
      </div>
      <label>Paste CSV / TSV / JSON <textarea id="data-paste" rows="4" placeholder="QUESTION,OPTION_A,OPTION_B,OPTION_C,OPTION_D,CORRECT&#10;What is 2+2?,3,4,5,6,B"></textarea></label>
      <div class="form-row"><button class="btn" id="data-paste-btn">Import pasted table</button>
      <button class="btn" id="data-add-row">+ Add a row manually</button>
      <button class="btn" id="data-sheets">Google Sheets…</button></div>
      <div class="error" id="data-error"></div>
      <div id="sheets-note" class="sub"></div>
    </div>
    <div class="card"><h3>Duplicates — skipped, never generated</h3>
      <p class="sub">${esc(dupText)}</p>
      <p class="sub">Only the first copy of a row is ever made. Skipped rows get no video, no job and no retry — not at the start, not at the end.</p>
      <div class="form-row">
        <label>Dedupe key <select id="dedupe-mode">
          <option value="whole-row" ${!s.dedupe || s.dedupe.mode !== 'key' ? 'selected' : ''}>Whole row (all mapped fields)</option>
          <option value="key" ${s.dedupe && s.dedupe.mode === 'key' ? 'selected' : ''}>One key column</option>
        </select></label>
        <label>Key column <select id="dedupe-key">${fieldOptions(dataset.columns, s.dedupe && s.dedupe.keyColumn)}</select></label>
        <button class="btn" id="dedupe-save">Apply dedupe rule</button>
      </div>
      <span class="sub" id="dedupe-msg"></span>
    </div>
    <div class="card"><h3>Data preview ${rows.length ? `(${rows.length} rows)` : ''}</h3>
      ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th></th><th>#</th>${dataset.columns.map((col) => `<th>${esc(col)}</th>`).join('')}<th>Status</th><th></th></tr></thead><tbody>
        ${preview.map((r) => `<tr class="${r.status === 'skipped' ? 'row-skipped' : ''}">
          <td><input type="checkbox" data-row-sel="${r.id}" ${r.selected ? 'checked' : ''} ${r.status === 'skipped' ? 'disabled' : ''}></td>
          <td>${r.rowNumber}</td>
          ${dataset.columns.map((col) => `<td>${esc(r.data[col] ?? '')}</td>`).join('')}
          <td>${r.status === 'skipped' ? '<span class="badge">Skipped duplicate</span>' : statusBadge(r.status)}</td>
          <td><button class="btn btn-sm" data-row-edit="${r.id}">Edit</button></td></tr>`).join('')}
      </tbody></table></div>
      ${rows.length > 10 ? `<p class="sub">Showing the first 10 of ${rows.length} rows.</p>` : ''}` : '<p class="sub">No rows yet — import a file or paste a table above.</p>'}
    </div>
    ${isQuiz(job) && rows.length ? `<div class="card"><h3>📱 Phone preview — what the viewer sees</h3>
      <p class="sub">The preview uses the same server-side layout as the render. Red outline = needs attention; the suggested shorter text is shown below the frame.</p>
      <div class="form-row"><label>Preview row <select id="quiz-preview-row">${rows.filter((r) => r.status !== 'skipped').map((r) => `<option value="${r.rowIndex}">Row ${r.rowNumber}</option>`).join('')}</select></label>
      <button class="btn" id="quiz-preview-btn">Show preview</button></div>
      <div id="quiz-preview"></div>
    </div>` : ''}`;
    const showErr = (m) => { const e = document.getElementById('data-error'); e.textContent = m; e.style.display = 'block'; };
    document.getElementById('data-upload').addEventListener('click', async () => {
      const f = document.getElementById('data-file').files[0];
      if (!f) return showErr('Choose a file first.');
      const fd = new FormData(); fd.append('file', f);
      try {
        const res = await fetch(`/api/bulk/${job.id}/dataset`, { method: 'POST', credentials: 'same-origin', body: fd });
        const b = await res.json();
        if (!res.ok) throw new Error(b.error || `Upload failed (${res.status})`);
        toast(`Imported ${b.dedupeSummary ? `${b.dedupeSummary.unique} unique rows (${b.dedupeSummary.skipped} duplicates skipped)` : 'rows'}.`);
        await loadJob(job.id); renderView();
      } catch (e) { showErr(e.message); }
    });
    document.getElementById('data-paste-btn').addEventListener('click', async () => {
      const text = document.getElementById('data-paste').value.trim();
      if (!text) return showErr('Paste a table first.');
      try {
        await api(`/api/bulk/${job.id}/dataset`, { method: 'POST', body: JSON.stringify({ text }) });
        toast('Pasted table imported.'); await loadJob(job.id); renderView();
      } catch (e) { showErr(e.message); }
    });
    document.getElementById('data-sheets').addEventListener('click', async () => {
      const note = document.getElementById('sheets-note');
      try {
        const st = await api('/api/integrations/google/status');
        if (!st.configured) {
          note.innerHTML = 'Google Sheets import needs Google OAuth first — an OWNER/ADMIN adds the Client ID + Secret in <b>Settings → Google Sheets</b>. Until then, export the sheet as XLSX/CSV and upload the file here.';
          return;
        }
        if (!st.connected) {
          note.innerHTML = 'Google is not connected yet. <button class="btn btn-sm btn-primary" id="sheets-connect">Connect Google</button> — authorise on Google, then click Google Sheets again.';
          document.getElementById('sheets-connect').addEventListener('click', async () => {
            try { const r = await api('/api/integrations/google/auth-url'); window.open(r.url, '_blank'); toast('Authorise on Google, then come back here.'); }
            catch (e) { showErr(e.message); }
          });
          return;
        }
        note.textContent = 'Loading your spreadsheets…';
        const list = await api('/api/integrations/google/spreadsheets');
        if (!list.spreadsheets.length) { note.textContent = 'No spreadsheets found in your Google Drive.'; return; }
        note.textContent = '';
        openModal(`<h2>Import from Google Sheets</h2>
          <p class="sub">Read-only: the sheet is never modified. Rows import with the same dedupe rule as a file upload.</p>
          <label>Spreadsheet <select id="gs-sheet">${list.spreadsheets.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
          <label>Tab <select id="gs-tab"></select></label>
          <div class="error" id="gs-err"></div>
          <div class="modal-actions"><button class="btn" id="gs-cancel">Cancel</button><button class="btn btn-primary" id="gs-import">Import rows</button></div>`)
          .addEventListener('click', async (ev) => {
            const sheetSel = document.getElementById('gs-sheet');
            const tabSel = document.getElementById('gs-tab');
            if (ev.target.id === 'gs-cancel') ev.currentTarget.remove();
            if (ev.target.id === 'gs-import') {
              try {
                const r = await api('/api/integrations/google/import', { method: 'POST', body: JSON.stringify({ spreadsheetId: sheetSel.value, tab: tabSel.value, bulkJobId: job.id }) });
                toast(`Imported ${r.dedupeSummary.unique} unique rows from Google Sheets (${r.dedupeSummary.skipped} duplicates skipped).`);
                ev.currentTarget.remove(); await loadJob(job.id); renderView();
              } catch (e) { document.getElementById('gs-err').textContent = e.message; document.getElementById('gs-err').style.display = 'block'; }
            }
          });
        // Load tabs for the first spreadsheet right away.
        const firstSheet = document.getElementById('gs-sheet');
        if (firstSheet) {
          try {
            const t = await api(`/api/integrations/google/spreadsheets/${encodeURIComponent(firstSheet.value)}/tabs`);
            document.getElementById('gs-tab').innerHTML = t.tabs.map((x) => `<option>${esc(x)}</option>`).join('');
          } catch (e) { /* shown on import attempt */ }
          firstSheet.addEventListener('change', async () => {
            try {
              const t = await api(`/api/integrations/google/spreadsheets/${encodeURIComponent(firstSheet.value)}/tabs`);
              document.getElementById('gs-tab').innerHTML = t.tabs.map((x) => `<option>${esc(x)}</option>`).join('');
            } catch (err) { toast(err.message, true); }
          });
        }
      } catch (e) { showErr(e.message); }
    });
    document.getElementById('data-add-row').addEventListener('click', () => {
      const cols = dataset.columns;
      if (!cols.length) return showErr('Import data first — a manual row needs the columns from a file or pasted table.');
      openModal(`<h2>Add a row</h2>${cols.map((col) => `<label>${esc(col)}<input data-new-col="${esc(col)}"></label>`).join('')}
        <div class="modal-actions"><button class="btn" id="nr-cancel">Cancel</button><button class="btn btn-primary" id="nr-save">Add row</button></div>`)
        .addEventListener('click', async (ev) => {
          if (ev.target.id === 'nr-cancel') ev.currentTarget.remove();
          if (ev.target.id === 'nr-save') {
            const data = {};
            ev.currentTarget.querySelectorAll('[data-new-col]').forEach((i) => { data[i.dataset.newCol] = i.value.trim(); });
            try { await api(`/api/bulk/${job.id}/dataset`, { method: 'POST', body: JSON.stringify({ rows: [data] }) }); toast('Row added.'); ev.currentTarget.remove(); await loadJob(job.id); renderView(); }
            catch (e) { toast(e.message, true); }
          }
        });
    });
    document.getElementById('dedupe-save').addEventListener('click', async () => {
      const mode = document.getElementById('dedupe-mode').value;
      const keyColumn = document.getElementById('dedupe-key').value || null;
      try {
        await api(`/api/bulk/${job.id}`, { method: 'PATCH', body: JSON.stringify({ settings: { dedupe: { mode, keyColumn } } }) });
        document.getElementById('dedupe-msg').textContent = 'Dedupe rule applied — rows re-checked.';
        await loadJob(job.id); renderView();
      } catch (e) { toast(e.message, true); }
    });
    body.querySelectorAll('[data-row-sel]').forEach((cb) => cb.addEventListener('change', async () => {
      try { await api(`/api/bulk/${job.id}/rows/${cb.dataset.rowSel}`, { method: 'PATCH', body: JSON.stringify({ selected: cb.checked }) }); }
      catch (e) { toast(e.message, true); renderView(); }
    }));
    body.querySelectorAll('[data-row-edit]').forEach((b) => b.addEventListener('click', () => {
      const row = rows.find((r) => r.id === parseInt(b.dataset.rowEdit, 10));
      if (!row) return;
      const back = openModal(`<h2>Edit row ${row.rowNumber}</h2>${dataset.columns.map((col) => `<label>${esc(col)}<input data-edit-col="${esc(col)}" value="${esc(row.data[col] ?? '')}"></label>`).join('')}
        <div class="modal-actions"><button class="btn" id="er-cancel">Cancel</button><button class="btn btn-primary" id="er-save">Save row</button></div>`);
      back.querySelector('#er-cancel').addEventListener('click', () => back.remove());
      back.querySelector('#er-save').addEventListener('click', async () => {
        const data = {};
        back.querySelectorAll('[data-edit-col]').forEach((i) => { data[i.dataset.editCol] = i.value.trim(); });
        try { await api(`/api/bulk/${job.id}/rows/${row.id}`, { method: 'PATCH', body: JSON.stringify({ data }) }); toast('Row saved.'); back.remove(); await loadJob(job.id); renderView(); }
        catch (e) { toast(e.message, true); }
      });
    }));
    const prevBtn = document.getElementById('quiz-preview-btn');
    if (prevBtn) prevBtn.addEventListener('click', async () => {
      const rowIndex = parseInt(document.getElementById('quiz-preview-row').value, 10);
      const row = rows.find((r) => r.rowIndex === rowIndex);
      const box = document.getElementById('quiz-preview');
      box.innerHTML = '<p class="sub">Loading preview…</p>';
      try {
        const { layout } = await api('/api/bulk/quiz/layout', { method: 'POST', body: JSON.stringify({ row: row.data, W: 720, H: 1280 }) });
        const qs = (job.settings && job.settings.quiz) || {};
        const { plan } = await api('/api/bulk/quiz/narration-plan', { method: 'POST', body: JSON.stringify({ row: row.data, animations: qs.animations, readSeconds: qs.readSeconds, revealSeconds: qs.revealSeconds }) });
        box.innerHTML = renderQuizPhone(layout) + renderNarrationStrip(plan);
      } catch (e) { box.innerHTML = `<p class="sub" style="color:#f87171">${esc(e.message)}</p>`; }
    });
  }

  // Narration segment strip (same timing as the render): question → options
  // → answer, with each element's animation. The phone preview and the
  // render both use /api/bulk/quiz/narration-plan, so they can never disagree.
  function renderNarrationStrip(plan) {
    if (!plan || !plan.segments) return '';
    const seg = (s) => `<div class="voice-seg"><b>${esc(s.label)}</b> ${esc(s.start)}s–${esc((s.start + s.duration).toFixed(2))}s · <span class="seg-anim">${esc(s.animation.type)} ${esc(s.animation.duration)}s</span><br>${esc(s.text)}</div>`;
    return `<div class="card" style="margin-top:12px"><h3>🎙️ Narration — spoken in this order</h3>
      <p class="sub">Mode: ${esc(plan.mode)} · options appear staggered every ${esc(plan.optionStagger)}s. The question is spoken during the read phase, the options one per slot during the countdown, the answer during the reveal.</p>
      <div class="voice-segments">${plan.segments.map(seg).join('')}</div></div>`;
  }

  // Phone-frame preview (9:16): the layout the renderer will use, scaled.
  function renderQuizPhone(L) {
    const W = L.W, H = L.H;
    const fw = 270, fh = 480, k = fw / W;
    const px = (v) => Math.round(v * k);
    const fr = L.fitReport || {};
    const attention = fr.overall === 'Needs attention';
    const box = (b, label, cls) => `<div class="qp-box ${cls || ''}" style="left:${px(b.x)}px;top:${px(b.y)}px;width:${px(b.w)}px;height:${px(b.h)}px">${esc(label)}</div>`;
    return `<div class="phone-wrap">
      <div class="phone-frame" style="width:${fw}px;height:${fh}px">
        <div class="phone-notch"></div>
        ${L.safeBox ? `<div class="qp-safebox" style="left:${px(L.safeBox.x)}px;top:${px(L.safeBox.y)}px;width:${px(L.safeBox.w)}px;height:${px(L.safeBox.h)}px"></div>` : ''}
        ${L.chipY !== undefined ? `<div class="qp-chip" style="top:${px(L.chipY)}px">Q1/5 • CATEGORY</div>` : ''}
        ${box(L.qBox, L.qFit.lines.join(' '), attention && fr.question && fr.question.status === 'attention' ? 'qp-attention' : '')}
        <div class="qp-bar" style="left:${px(L.margin)}px;top:${px(L.barY)}px;width:${px(L.boxW)}px;height:${px(L.barH)}px"></div>
        ${L.imageBox ? box(L.imageBox, '🖼 Question image') : ''}
        ${L.optionBoxes.map((b) => box(b, b.fullText, b.fontSize === L.fitReport.optionFont ? '' : 'qp-attention')).join('')}
        ${L.eFit && L.eFit.lines && L.eFit.lines.length ? box(L.explBox, L.eFit.lines.join(' ')) : ''}
        <div class="qp-caption">Caption area — kept clear</div>
      </div>
      <div class="phone-side">
        <p><strong>Fit: ${esc(fr.overall || '?')}</strong>${fr.questionFont ? ` · Question ${fr.questionFont}px` : ''}${fr.optionFont ? ` · Options ${fr.optionFont}px` : ''}</p>
        ${fr.suggestedText ? `<p style="color:#f87171">⚠ Needs attention — try shorter: “${esc(fr.suggestedText)}”</p>` : ''}
        ${fr.caps && fr.caps.exceeded ? `<p style="color:#f87171">⚠ Over the research caps (question ≤80 chars, options ≤22) — shorten it so it reads in 2 seconds.</p>` : ''}
        ${fr.issues && fr.issues.length ? `<p style="color:#f87171">${esc(fr.issues.join(' '))}</p>` : ''}
        <p class="sub">Question in the middle band, options as a full-width stacked list inside the dashed safe box. The score card runs at the end of the video. ${fr.safeZoneOk ? 'All elements are inside the safe zones.' : 'Something is outside a safe zone — check the red boxes.'}</p>
      </div>
    </div>`;
  }

  /* ---------- Step 3: Background ---------- */
  async function renderStepBackground(body, kind) {
    const { job, dataset, rows } = detail;
    const s = job.settings || {};
    const bg = s.background || {};
    const media = await api('/api/media?kind=image').catch(() => ({ media: [] }));
    const videos = await api('/api/media?kind=video').catch(() => ({ media: [] }));
    const pool = [...(media.media || []), ...(videos.media || [])];
    const categories = [...new Set((rows || []).map((r) => r.data[(bg.categoryColumn || 'CATEGORY')]).filter(Boolean))];
    const poolOptions = (selected) => `<option value="">— pick a background —</option>${pool.map((m) => `<option value="${m.id}" ${String(m.id) === String(selected) ? 'selected' : ''}>${esc(m.originalName)} (${m.kind})</option>`).join('')}`;
    body.innerHTML = `
    <div class="card"><h3>Dynamic Background Engine</h3>
      <p class="sub">Every row gets its own background. No repetition is the default.</p>
      <label><input type="radio" name="bg-mode" value="random" ${bg.mode === 'random' ? 'checked' : ''}> <strong>Random unique</strong> — a different background per video from the pool below (shuffled, no repeat)</label>
      <label><input type="radio" name="bg-mode" value="category" ${bg.mode === 'category' ? 'checked' : ''}> <strong>Category-based</strong> — each category has its own pool; assignment rotates so repeats are minimised</label>
      <label><input type="radio" name="bg-mode" value="pool" ${bg.mode === 'pool' ? 'checked' : ''}> <strong>Uploaded pool</strong> — upload backgrounds, one per video</label>
      <label><input type="radio" name="bg-mode" value="column" ${bg.mode === 'column' ? 'checked' : ''}> <strong>From a column</strong> — a column in your data names the background (media id, library file name or URL)</label>
      <label><input type="radio" name="bg-mode" value="manual" ${bg.mode === 'manual' ? 'checked' : ''}> <strong>Manually assign per row</strong></label>
      <label><input type="radio" name="bg-mode" value="ai" ${bg.mode === 'ai' ? 'checked' : ''}> <strong>AI generated</strong> — one unique AI background per row from the image provider (Phase 7, live). Needs an image provider key; without one the batch refuses to start — no silent fallback.</label>
      <label><input type="radio" name="bg-mode" value="prompt" ${bg.mode === 'prompt' ? 'checked' : ''}> <strong>Prompt-based</strong> — each row's prompt comes from a column in your data (Phase 7, live). Needs an image provider key; without one the batch refuses to start.</label>
      <div class="form-row" id="bg-ai-fields">
        <label>AI prompt template (AI mode) — use {{FIELD}} for row data, e.g. “A clean professional background for {{PRODUCT_NAME}}, {{CATEGORY}} theme, no text”<input id="bg-ai-prompt" value="${esc(bg.aiPrompt || '')}" placeholder="Leave blank to auto-build from the row's text"></label>
        <label>Prompt column (Prompt mode) <select id="bg-prompt-col">${fieldOptions(dataset.columns, bg.promptColumn || 'BACKGROUND_PROMPT')}</select></label>
      </div>
      <div class="form-row">
        <label>Repetition rule <select id="bg-repeat">
          <option value="no-repeat" ${bg.repeatRule === 'no-repeat' ? 'selected' : ''}>No repetition (default)</option>
          <option value="after-n" ${bg.repeatRule === 'after-n' ? 'selected' : ''}>Allow repetition after N videos</option>
          <option value="random" ${bg.repeatRule === 'random' ? 'selected' : ''}>Fully random</option>
        </select></label>
        <label>Repeat after N <input id="bg-after-n" type="number" min="1" max="100" value="${bg.repeatAfterN || 5}"></label>
      </div>
      <div class="form-row">
        <label>Background pool — pick from Media Library</label>
      </div>
      <div id="bg-pool-list" class="bg-pool">
        ${(bg.poolMediaIds || []).map((id) => { const m = pool.find((x) => x.id === id); return m ? `<span class="bg-pool-item" data-pool-id="${m.id}">${esc(m.originalName)} <button data-pool-remove="${m.id}" title="Remove">×</button></span>` : ''; }).join('') || '<span class="sub">No backgrounds in the pool yet.</span>'}
      </div>
      <div class="form-row">
        <select id="bg-pool-add">${poolOptions()}</select>
        <button class="btn" id="bg-pool-add-btn">Add to pool</button>
        <label style="flex:1">Upload backgrounds <input type="file" id="bg-upload" accept="image/*,video/*" multiple></label>
        <button class="btn" id="bg-upload-btn">Upload</button>
      </div>
      <div class="form-row">
        <label>Category column <select id="bg-cat-col">${fieldOptions(dataset.columns, bg.categoryColumn || 'CATEGORY')}</select></label>
        <label>Background column <select id="bg-col">${fieldOptions(dataset.columns, bg.column || 'BACKGROUND_IMAGE')}</select></label>
      </div>
      ${categories.length ? `<h4>Category → pool</h4>${categories.map((cat) => {
        const map = bg.categoryMap || {};
        return `<div class="form-row"><label style="min-width:140px">${esc(cat)}</label><select data-cat-pool="${esc(cat)}" multiple size="3" style="min-width:260px">${pool.map((m) => `<option value="${m.id}" ${(map[cat] || []).includes(m.id) ? 'selected' : ''}>${esc(m.originalName)}</option>`).join('')}</select></div>`;
      }).join('')}` : '<p class="sub">No categories in the data yet — import data first, then map categories here.</p>'}
      <h4>Manual assignment</h4>
      <div class="table-wrap"><table class="table"><thead><tr><th>Row</th><th>Background</th></tr></thead><tbody>
        ${(rows || []).filter((r) => r.status !== 'skipped').slice(0, 20).map((r) => `<tr><td>Row ${r.rowNumber}</td><td><select data-manual-row="${r.rowIndex}">${poolOptions((bg.manual || {})[r.rowIndex])}</select></td></tr>`).join('') || '<tr><td colspan="2">No rows yet.</td></tr>'}
      </tbody></table></div>
      <div class="error" id="bg-error"></div>
      <button class="btn btn-primary" id="bg-save">Save background settings</button>
      <span class="sub" id="bg-msg"></span>
    </div>
    <div class="card"><h3>Readability protection</h3>
      <p class="sub">Bright or busy backgrounds get an automatic dark overlay (and a blur when the background is busy) so the text is always readable on a phone. The overlay is a real FFmpeg filter applied per render.</p>
      <div class="form-row">
        <label><input type="checkbox" id="rb-enabled" ${(s.readability || {}).enabled !== false ? 'checked' : ''}> Enable readability overlay</label>
        <label>Overlay strength <input type="range" id="rb-alpha" min="0" max="0.6" step="0.05" value="${(s.readability && s.readability.overlayAlpha) ?? 0.35}"> <span id="rb-alpha-val">${(s.readability && s.readability.overlayAlpha) ?? 0.35}</span></label>
        <label><input type="checkbox" id="rb-tint" ${(s.readability || {}).brandTint ? 'checked' : ''}> Tint the overlay with the brand colour</label>
      </div>
      <button class="btn" id="rb-save">Save readability settings</button>
      <span class="sub" id="rb-msg"></span>
    </div>`;
    document.getElementById('rb-alpha').addEventListener('input', (e) => { document.getElementById('rb-alpha-val').textContent = e.target.value; });
    const saveSettings = async (patch, msgEl) => {
      try { await api(`/api/bulk/${job.id}`, { method: 'PATCH', body: JSON.stringify({ settings: patch }) }); document.getElementById(msgEl).textContent = 'Saved.'; await loadJob(job.id); }
      catch (e) { toast(e.message, true); }
    };
    document.getElementById('bg-pool-add-btn').addEventListener('click', async () => {
      const id = parseInt(document.getElementById('bg-pool-add').value, 10);
      if (!id) return;
      const poolIds = [...(bg.poolMediaIds || [])];
      if (!poolIds.includes(id)) poolIds.push(id);
      await saveSettings({ background: { ...bg, poolMediaIds: poolIds } }, 'bg-msg'); renderView();
    });
    body.querySelectorAll('[data-pool-remove]').forEach((b) => b.addEventListener('click', async () => {
      const poolIds = (bg.poolMediaIds || []).filter((x) => x !== parseInt(b.dataset.poolRemove, 10));
      await saveSettings({ background: { ...bg, poolMediaIds: poolIds } }, 'bg-msg'); renderView();
    }));
    document.getElementById('bg-upload-btn').addEventListener('click', async () => {
      const files = document.getElementById('bg-upload').files;
      if (!files.length) return toast('Choose files to upload first.', true);
      try {
        const ids = [];
        for (const f of files) {
          const fd = new FormData(); fd.append('file', f); fd.append('tags', 'bulk-background');
          const res = await fetch('/api/media/upload', { method: 'POST', credentials: 'same-origin', body: fd });
          const b = await res.json();
          if (!res.ok) throw new Error(b.error || 'Upload failed.');
          ids.push(b.media.id);
        }
        await saveSettings({ background: { ...bg, poolMediaIds: [...(bg.poolMediaIds || []), ...ids] } }, 'bg-msg');
        toast(`${ids.length} background(s) uploaded and added to the pool.`); renderView();
      } catch (e) { toast(e.message, true); }
    });
    document.getElementById('bg-save').addEventListener('click', async () => {
      const mode = body.querySelector('input[name="bg-mode"]:checked').value;
      const categoryMap = {};
      body.querySelectorAll('[data-cat-pool]').forEach((sel) => { categoryMap[sel.dataset.catPool] = [...sel.selectedOptions].map((o) => parseInt(o.value, 10)); });
      const manual = {};
      body.querySelectorAll('[data-manual-row]').forEach((sel) => { if (sel.value) manual[sel.dataset.manualRow] = parseInt(sel.value, 10); });
      try {
        await api(`/api/bulk/${job.id}`, { method: 'PATCH', body: JSON.stringify({ settings: { background: {
          mode, repeatRule: document.getElementById('bg-repeat').value,
          repeatAfterN: parseInt(document.getElementById('bg-after-n').value, 10) || 5,
          categoryColumn: document.getElementById('bg-cat-col').value || null,
          column: document.getElementById('bg-col').value || null,
          aiPrompt: document.getElementById('bg-ai-prompt').value.trim() || null,
          promptColumn: document.getElementById('bg-prompt-col').value || null,
          categoryMap, manual,
        } } }) });
        document.getElementById('bg-msg').textContent = 'Background settings saved.';
        await loadJob(job.id); renderView();
      } catch (e) { toast(e.message, true); }
    });
    document.getElementById('rb-save').addEventListener('click', async () => {
      await saveSettings({ readability: {
        enabled: document.getElementById('rb-enabled').checked,
        overlayAlpha: parseFloat(document.getElementById('rb-alpha').value),
        brandTint: document.getElementById('rb-tint').checked,
      } }, 'rb-msg');
    });
  }

  /* ---------- Step 4: Generate ---------- */
  async function renderStepGenerate(body, kind) {
    const { job, rows, fitSummary } = detail;
    const s = job.settings || {};
    const fs = fitSummary || { ok: 0, adjusted: 0, attention: 0, unchecked: 0 };
    const failedRows = (rows || []).filter((r) => r.status === 'failed');
    body.innerHTML = `
    <div class="card"><h3>Pre-flight fit check</h3>
      <p class="sub">Before any render, every row's text is measured against its box. <strong>Fit: OK ${fs.ok} · Adjusted ${fs.adjusted} · Needs attention ${fs.attention} · Not checked ${fs.unchecked}</strong>${fs.questionFont ? ` · Question font ${fs.questionFont}px · Options font ${fs.optionFont}px (one size across the whole batch)` : ''}</p>
      <div class="form-row">
        <button class="btn btn-primary" id="fit-check">✓ Check fit for all rows</button>
        <button class="btn" id="sample-btn">▶ Render a sample row</button>
        <select id="sample-row">${(rows || []).filter((r) => r.status !== 'skipped' && r.status !== 'done').map((r) => `<option value="${r.rowIndex}">Row ${r.rowNumber}</option>`).join('')}</select>
        <button class="btn btn-primary" id="start-btn" ${job.status === 'running' ? 'disabled' : ''}>▶ Generate all (${(rows || []).filter((r) => r.selected && r.status !== 'skipped').length} unique rows)</button>
      </div>
      <div class="error" id="gen-error"></div>
      <p class="sub">Duplicates skipped: ${s.dedupeSummary ? s.dedupeSummary.skipped : 0} — they are never generated, not at the start and not at the end.</p>
      ${failedRows.length ? `<button class="btn" id="retry-all">↻ Retry all failed (${failedRows.length})</button>` : ''}
    </div>
    <div class="card"><h3>Rows</h3>
      <div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Output</th><th>Background</th><th>Fit</th><th>Status</th><th>Details</th><th></th></tr></thead><tbody>
      ${(rows || []).map((r) => `<tr class="${r.status === 'skipped' ? 'row-skipped' : ''}">
        <td>${r.rowNumber}</td>
        <td>${esc(r.outputName || '—')}</td>
        <td>${r.backgroundMediaId ? `#${r.backgroundMediaId} <span class="sub">(${esc(r.backgroundSource || '')})</span>` : '—'}</td>
        <td>${fitBadge(r.fitReport)}${fitDetail(r.fitReport)}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${r.error ? `<span style="color:#f87171">${esc(r.error)}</span>` : (r.warnings || []).map((w) => `<div class="sub">${esc(w)}</div>`).join('')}</td>
        <td>${r.hasOutput ? `<a class="btn btn-sm" href="/api/bulk/${job.id}/rows/${r.id}/download">Download</a>` : ''}
        ${r.status === 'failed' ? `<button class="btn btn-sm" data-retry-row="${r.id}">Retry</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="7">No rows yet.</td></tr>'}
      </tbody></table></div>
    </div>`;
    const showErr = (m) => { const e = document.getElementById('gen-error'); e.textContent = m; e.style.display = 'block'; };
    document.getElementById('fit-check').addEventListener('click', async () => {
      try {
        const r = await api(`/api/bulk/${job.id}/fit-check`, { method: 'POST' });
        toast(`Fit check done: ${r.counts.ok} OK, ${r.counts.adjusted} adjusted, ${r.counts.attention} need attention.`);
        await loadJob(job.id); renderView();
      } catch (e) { showErr(e.message); }
    });
    document.getElementById('sample-btn').addEventListener('click', async () => {
      const rowIndex = parseInt(document.getElementById('sample-row').value, 10);
      try {
        const r = await api(`/api/bulk/${job.id}/sample`, { method: 'POST', body: JSON.stringify({ rowIndex }) });
        toast(`Sample render started (job #${r.jobId}). Watch it in the Export Center.`);
        await loadJob(job.id); renderView();
      } catch (e) { showErr(e.message); }
    });
    document.getElementById('start-btn').addEventListener('click', async () => {
      try {
        await api(`/api/bulk/${job.id}/start`, { method: 'POST' });
        toast('Batch started — progress updates here.');
        await loadJob(job.id); renderView();
      } catch (e) { showErr(e.message); }
    });
    const retryAll = document.getElementById('retry-all');
    if (retryAll) retryAll.addEventListener('click', async () => {
      try { await api(`/api/bulk/${job.id}/retry`, { method: 'POST', body: JSON.stringify({}) }); toast('Retrying failed rows.'); await loadJob(job.id); renderView(); }
      catch (e) { showErr(e.message); }
    });
    body.querySelectorAll('[data-retry-row]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/bulk/${job.id}/retry-row/${b.dataset.retryRow}`, { method: 'POST' }); toast('Retrying that row.'); await loadJob(job.id); renderView(); }
      catch (e) { showErr(e.message); }
    }));
  }

  /* ---------- Template Builder ---------- */
  async function viewBuilder(c) {
    stopPolling();
    const projectId = state.params.projectId || null;
    const projects = await api('/api/projects').catch(() => ({ projects: [] }));
    const templates = (projects.projects || []).filter((p) => p.type === 'video' || p.type === 'design');
    if (!projectId) {
      c.innerHTML = `<h2>Smart Template Builder</h2>
      <p class="sub">Pick a video or design project and bind its clips/layers to data columns with <code>{{FIELD}}</code> placeholders. The template stays editable in its own editor.</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>Project</th><th>Type</th><th></th></tr></thead><tbody>
      ${templates.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.type)}</td><td><button class="btn btn-sm" data-tpl="${t.id}">Build template</button></td></tr>`).join('') || '<tr><td colspan="3">No video or design projects yet.</td></tr>'}
      </tbody></table></div>`;
      c.querySelectorAll('[data-tpl]').forEach((b) => b.addEventListener('click', () => go('template-builder', { projectId: b.dataset.tpl })));
      return;
    }
    const f = await api(`/api/bulk/templates/${projectId}/fields`);
    const isVideo = f.kind === 'video';
    c.innerHTML = `<h2>Template Builder — ${esc(f.projectName || projectId)}</h2>
    <p class="sub">${isVideo ? 'Set a dynamic media field per clip (e.g. PRODUCT_IMAGE) and mark the background clip. Text clips already use {{FIELD}} placeholders from their text.' : 'Set a dynamic field per image layer (e.g. PRODUCT_IMAGE). Text layers use {{FIELD}} placeholders or a column binding.'}</p>
    <div class="card"><h3>Detected fields</h3>
      ${f.fields.length ? f.fields.map((x) => `<div><code>{{${esc(x.name)}}</code> — ${esc(x.kind)}</div>`).join('') : '<p class="sub">No dynamic fields yet — add bindings below.</p>'}
    </div>
    <div class="card"><h3>Bindings</h3>
      ${isVideo ? `<div class="table-wrap"><table class="table"><thead><tr><th>Clip</th><th>Track</th><th>Dynamic media field</th><th>Background clip</th></tr></thead><tbody>
        ${(f.scan.mediaClips || []).map((mc) => `<tr><td>${esc(mc.clipId)}</td><td>${esc(mc.trackKind)}</td>
        <td><input data-bind-clip="${esc(mc.clipId)}" value="${esc(mc.field || '')}" placeholder="e.g. PRODUCT_IMAGE"></td>
        <td><input type="checkbox" data-bg-clip="${esc(mc.clipId)}" ${f.scan.backgroundClipId === mc.clipId ? 'checked' : ''}></td></tr>`).join('') || '<tr><td colspan="4">No media clips in this template.</td></tr>'}
      </tbody></table></div>
      <p class="sub">Text clips in this template: ${(f.scan.textClips || []).map((t) => esc(t.clipId)).join(', ') || 'none'}. Their {{FIELD}} placeholders come from the clip text itself — edit them in the Video Editor.</p>`
      : `<div class="table-wrap"><table class="table"><thead><tr><th>Layer</th><th>Dynamic field</th></tr></thead><tbody>
        ${(f.scan.imageLayers || []).map((l) => `<tr><td>${esc(l.name || l.layerId)}</td><td><input data-bind-layer="${esc(l.layerId)}" value="${esc(l.dynamicField || '')}" placeholder="e.g. PRODUCT_IMAGE"></td></tr>`).join('') || '<tr><td colspan="2">No image layers in this template.</td></tr>'}
      </tbody></table></div>`}
      <div class="error" id="tb-error"></div>
      <button class="btn btn-primary" id="tb-save">Save bindings</button>
      <button class="btn" id="tb-back">← All templates</button>
    </div>`;
    document.getElementById('tb-back').addEventListener('click', () => go('template-builder'));
    document.getElementById('tb-save').addEventListener('click', async () => {
      try {
        let bindings = [];
        let backgroundClipId = null;
        if (isVideo) {
          c.querySelectorAll('[data-bind-clip]').forEach((i) => { bindings.push({ clipId: i.dataset.bindClip, dynamicMediaField: i.value.trim() || null }); });
          const bg = c.querySelector('[data-bg-clip]:checked');
          if (bg) backgroundClipId = bg.dataset.bgClip;
        } else {
          c.querySelectorAll('[data-bind-layer]').forEach((i) => { bindings.push({ layerId: i.dataset.bindLayer, dynamicField: i.value.trim() || null }); });
        }
        await api(`/api/bulk/templates/${projectId}/bindings`, { method: 'PATCH', body: JSON.stringify({ bindings, backgroundClipId }) });
        toast('Bindings saved.'); renderView();
      } catch (e) { const el = document.getElementById('tb-error'); el.textContent = e.message; el.style.display = 'block'; }
    });
  }

  async function view(c, kind) {
    if (state.params.id) return viewDetail(c, kind, state.params.id);
    return viewList(c, kind);
  }

  return { view, viewBuilder, stopPolling };
})();

async function viewBulkVideo(c) { return BulkUI.view(c, 'video'); }
async function viewBulkDesign(c) { return BulkUI.view(c, 'design'); }
async function viewTemplateBuilder(c) { return BulkUI.viewBuilder(c); }
