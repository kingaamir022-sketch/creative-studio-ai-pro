'use strict';
/* Global entry point used by app.js routing (same pattern as viewVoices). */
async function viewAIStudio(c, presetMode) { return AIStudio.view(c, presetMode); }
const AIStudio = (() => {
  let status = null;
  let jobs = [];
  let images = [];
  let audio = [];
  let voices = [];
  let designs = [];
  let mode = 'image';
  let pollTimer = null;
  let currentJob = null;

  const MODES = [
    { id: 'image', label: 'Text to Image', kind: 'image', icon: '🖼️' },
    { id: 'image-edit', label: 'Image to Image', kind: 'image', icon: '🎨' },
    { id: 'video', label: 'Text to Video', kind: 'video', icon: '🎥' },
    { id: 'video-image', label: 'Image to Video', kind: 'video', icon: '📽️' },
    { id: 'voice', label: 'AI Voice', kind: 'tts', icon: '🎙️' },
    { id: 'quiz', label: 'AI Quiz Questions', kind: 'llm', icon: '❓' },
    { id: 'design', label: 'AI Design Assist', kind: 'llm', icon: '✨' },
    { id: 'transcribe', label: 'AI Transcribe', kind: 'stt', icon: '📝' },
    { id: 'music-mood', label: 'Music Mood Tags', kind: 'llm', icon: '🎵' },
    { id: 'music-generate', label: 'AI Music', kind: 'music', icon: '🎼' },
  ];

  async function loadAll() {
    const [st, js, im, au, vp, pr] = await Promise.all([
      api('/api/ai/status').catch(() => null),
      api('/api/ai/jobs').catch(() => ({ jobs: [] })),
      api('/api/media?kind=image&limit=100').catch(() => ({ media: [] })),
      api('/api/media?kind=audio&limit=100').catch(() => ({ media: [] })),
      api('/api/voice/profiles').catch(() => ({ profiles: [] })),
      api('/api/projects?type=design&limit=100').catch(() => ({ projects: [] })),
    ]);
    status = st; jobs = js.jobs || [];
    images = (im.media || []).filter((m) => m.kind === 'image');
    audio = (au.media || []).filter((m) => m.kind === 'audio');
    voices = vp.profiles || [];
    designs = pr.projects || [];
  }

  function kindState(kind) {
    if (!status || !status.kinds || !status.kinds[kind]) return { configured: false, providers: [] };
    return status.kinds[kind];
  }

  function modeDef(id) { return MODES.find((m) => m.id === id) || MODES[0]; }

  function fieldsFor(m) {
    switch (m) {
      case 'image': return `
        <div class="ed-field"><label>Prompt</label><textarea id="ai-f-prompt" rows="3" placeholder="e.g. A golden retriever puppy in a sunflower field at sunset, photographic"></textarea></div>
        <div class="ed-field"><label>Aspect / size</label><select id="ai-f-size"><option value="1:1">Square 1:1</option><option value="9:16">Portrait 9:16 (Stories / Reels)</option><option value="16:9">Landscape 16:9</option></select></div>
        <div class="ed-field"><label>Style (optional)</label><select id="ai-f-style"><option value="">Default</option><option value="vivid">Vivid</option><option value="natural">Natural</option></select></div>`;
      case 'image-edit': return `
        <div class="ed-field"><label>Source image (from your Media Library)</label><select id="ai-f-source">${images.map((x) => `<option value="${x.id}">${esc(x.original_name)}</option>`).join('') || '<option value="">No images in your library yet</option>'}</select></div>
        <div class="ed-field"><label>Edit prompt</label><textarea id="ai-f-prompt" rows="3" placeholder="e.g. Turn the sky into a purple sunset and add warm light"></textarea></div>
        <div class="ed-field"><label>Aspect / size</label><select id="ai-f-size"><option value="1:1">Square 1:1</option><option value="9:16">Portrait 9:16</option><option value="16:9">Landscape 16:9</option></select></div>`;
      case 'video': return `
        <div class="ed-field"><label>Prompt</label><textarea id="ai-f-prompt" rows="3" placeholder="e.g. A drone shot flying over a mountain lake at dawn, cinematic"></textarea></div>
        <div class="ed-field"><label>Duration (seconds, 2–16)</label><input id="ai-f-duration" type="number" min="2" max="16" value="5"></div>
        <div class="ed-field"><label>Aspect</label><select id="ai-f-aspect"><option value="16:9">Landscape 16:9</option><option value="9:16">Portrait 9:16</option></select></div>`;
      case 'video-image': return `
        <div class="ed-field"><label>Source image (first frame)</label><select id="ai-f-source">${images.map((x) => `<option value="${x.id}">${esc(x.original_name)}</option>`).join('') || '<option value="">No images in your library yet</option>'}</select></div>
        <div class="ed-field"><label>Motion prompt</label><textarea id="ai-f-prompt" rows="3" placeholder="e.g. The camera slowly zooms in and clouds drift across the sky"></textarea></div>
        <div class="ed-field"><label>Duration (seconds, 2–16)</label><input id="ai-f-duration" type="number" min="2" max="16" value="5"></div>
        <div class="ed-field"><label>Aspect</label><select id="ai-f-aspect"><option value="16:9">Landscape 16:9</option><option value="9:16">Portrait 9:16</option></select></div>`;
      case 'voice': return `
        <div class="ed-field"><label>Voice</label><select id="ai-f-voice">${voices.map((v) => `<option value="${v.id}">${esc(v.name)} — ${esc(v.kind === 'clone' ? 'your voice' : v.kind)}</option>`).join('') || '<option value="">No voice profile yet — create one in Voices</option>'}</select></div>
        <div class="ed-field"><label>Text to speak (max 2000 characters)</label><textarea id="ai-f-text" rows="4" placeholder="e.g. Welcome to today's quiz! How many can you answer?"></textarea></div>`;
      case 'quiz': return `
        <div class="ed-field"><label>Topic</label><input id="ai-f-topic" placeholder="e.g. Pakistan geography, science, cricket"></div>
        <div class="ed-field"><label>Number of questions (1–10)</label><input id="ai-f-count" type="number" min="1" max="10" value="5"></div>
        <div class="ed-field"><label>Difficulty</label><select id="ai-f-difficulty"><option value="mixed">Mixed (recommended)</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option><option value="hardest">Hardest</option></select></div>
        <div class="ed-field"><label>Language</label><input id="ai-f-language" value="en" placeholder="en, ur, roman-ur"></div>`;
      case 'design': return `
        <div class="ed-field"><label>Design brief</label><textarea id="ai-f-prompt" rows="3" placeholder="e.g. Summer sale poster for a shoe store, bold and energetic"></textarea></div>
        <div class="ed-field"><label>Design name</label><input id="ai-f-name" value="AI Design"></div>
        <div class="ed-field"><label>Base on an existing design (optional — the original is never changed)</label><select id="ai-f-project"><option value="">None — fresh design</option>${designs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>`;
      case 'transcribe': return `
        <div class="ed-field"><label>Audio or video file</label><select id="ai-f-media">${audio.map((x) => `<option value="${x.id}">${esc(x.original_name)} (audio)</option>`).join('')}${images.length ? '' : ''}<option value="">— pick an audio file above, or upload one in the Media Library first —</option></select></div>
        <div class="ed-field"><label>Language (optional, e.g. en, ur)</label><input id="ai-f-language" placeholder="leave blank to auto-detect"></div>
        <p class="sub">The transcript is saved with word timestamps and can be used as captions in Shorts Studio.</p>`;
      case 'music-mood': return `
        <div class="ed-field"><label>Audio file</label><select id="ai-f-media">${audio.map((x) => `<option value="${x.id}">${esc(x.original_name)}</option>`).join('') || '<option value="">No audio in your library yet</option>'}</select></div>
        <p class="sub">Uses the real local beat analysis (Phase 5) plus the LLM to tag mood, energy, genres and tags. No music-generation key is needed for this.</p>`;
      case 'music-generate': return `
        <div class="ed-field"><label>Music prompt</label><textarea id="ai-f-prompt" rows="3" placeholder="e.g. Upbeat pop dance track, 120 BPM, energetic drums and synth"></textarea></div>
        <div class="ed-field"><label>Duration (seconds, 2–30)</label><input id="ai-f-duration" type="number" min="2" max="30" value="8"></div>`;
      default: return '';
    }
  }

  function collectParams(m) {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
    const out = {};
    const prompt = val('ai-f-prompt'); if (prompt !== undefined) out.prompt = prompt;
    const size = val('ai-f-size'); if (size) out.size = size;
    const style = val('ai-f-style'); if (style) out.style = style;
    const src = val('ai-f-source'); if (src) out.sourceMediaId = Number(src);
    const dur = val('ai-f-duration'); if (dur !== undefined && dur !== '') out.duration = Number(dur);
    const aspect = val('ai-f-aspect'); if (aspect) out.aspect = aspect;
    const text = val('ai-f-text'); if (text !== undefined) out.text = text;
    const voice = val('ai-f-voice'); if (voice) out.voiceProfileId = Number(voice);
    const topic = val('ai-f-topic'); if (topic !== undefined) out.topic = topic;
    const count = val('ai-f-count'); if (count !== undefined && count !== '') out.count = Number(count);
    const diff = val('ai-f-difficulty'); if (diff) out.difficulty = diff;
    const lang = val('ai-f-language'); if (lang) out.language = lang;
    const name = val('ai-f-name'); if (name !== undefined) out.name = name;
    const proj = val('ai-f-project'); if (proj) out.projectId = Number(proj);
    const media = val('ai-f-media'); if (media) out.mediaId = Number(media);
    return out;
  }

  async function pollJob(id, onTick) {
    for (let i = 0; i < 360; i++) {
      const { job } = await api(`/api/ai/jobs/${id}`);
      if (onTick) onTick(job);
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const { job } = await api(`/api/ai/jobs/${id}`);
    return job;
  }

  function jobStatusHtml(j) {
    const pct = j.progress || 0;
    return `<div class="ai-progress"><div class="ai-progress-bar" style="width:${pct}%"></div></div>
      <p class="sub">Status: <b>${esc(j.status)}</b> — ${pct}%${j.error ? `<br><span style="color:var(--danger, #dc2626)">${esc(j.error)}</span>` : ''}</p>`;
  }

  function resultHtml(j) {
    const r = j.result || {};
    switch (j.mode) {
      case 'image':
      case 'image-edit':
        return r.url ? `<img src="${esc(r.url)}" alt="AI generated image" style="max-width:100%;border-radius:12px">
          <p class="sub">Provider: ${esc(r.provider || '')} · Saved to your Media Library.</p>` : '';
      case 'video':
      case 'video-image':
        return r.url ? `<video src="${esc(r.url)}" controls autoplay loop style="max-width:100%;border-radius:12px"></video>
          <p class="sub">Provider: ${esc(r.provider || '')} · Saved to your Media Library.</p>` : '';
      case 'voice':
        return r.url ? `<audio src="${esc(r.url)}" controls style="width:100%"></audio>
          <p class="sub">Provider: ${esc(r.provider || '')}${r.cached ? ' · served from cache (same text + voice)' : ''} · Saved to your Media Library as narration audio.</p>` : '';
      case 'quiz': {
        const qs = r.questions || [];
        return `<p class="sub">Topic: ${esc(r.topic || '')} — ${qs.length} questions, validated (4 options each, A–D answer).</p>
          <table><thead><tr><th>#</th><th>Question</th><th>Options</th><th>Answer</th></tr></thead><tbody>
          ${qs.map((q, i) => `<tr><td>${i + 1}</td><td>${esc(q.question)}<br><small style="color:var(--muted)">${esc(q.explanation || '')}</small></td><td>${q.options.map((o) => `<span class="badge">${esc(o)}</span>`).join(' ')}</td><td><b>${esc(q.correct)}</b></td></tr>`).join('')}
          </tbody></table>
          <div class="ed-btnrow"><button class="btn" id="ai-dl-csv">Download quiz CSV</button><button class="btn" id="ai-copy-csv">Copy CSV</button><button class="btn" id="ai-to-bulk">Use in Bulk Video</button></div>
          <p class="sub">The CSV uses the quiz columns (QUESTION, OPTION_A–D, CORRECT, EXPLANATION, CATEGORY, DIFFICULTY, TIMER_SECONDS) — import it straight into a Bulk Video job.</p>`;
      }
      case 'design': {
        const s = r.suggestions || {};
        return `<p class="sub">The LLM picked: <b>${esc(s.headline || '')}</b> — ${esc(s.subheading || '')}</p>
          <div class="kv"><span>Palette</span><span>${(s.palette ? [s.palette.primary, s.palette.secondary, s.palette.accent].filter(Boolean).map((col) => `<span style="display:inline-block;width:22px;height:22px;border-radius:6px;background:${esc(col)};border:1px solid #ccc"></span>`).join(' ') : '')}</span></div>
          <div class="kv"><span>Fonts</span><span>${esc(s.fonts ? `${s.fonts.heading || ''} / ${s.fonts.body || ''}` : '')}</span></div>
          <p class="sub">A NEW editable design project was created — nothing existing was changed.</p>
          <div class="ed-btnrow"><button class="btn btn-primary" id="ai-open-design">Open in Graphic Editor</button></div>`;
      }
      case 'transcribe':
        return `<p class="sub">${(r.cues || []).length} cues · ${esc(r.provider || '')}</p>
          <div class="ed-field"><label>Transcript</label><textarea rows="6" readonly>${esc(r.text || '')}</textarea></div>
          <table><thead><tr><th>Start</th><th>End</th><th>Text</th></tr></thead><tbody>
          ${(r.cues || []).map((cue) => `<tr><td>${cue.start}s</td><td>${cue.end}s</td><td>${esc(cue.text)}</td></tr>`).join('')}
          </tbody></table>`;
      case 'music-mood': {
        return `<div class="kv"><span>Mood</span><span><b>${esc(r.mood || 'Unknown')}</b></span></div>
          <div class="kv"><span>Energy</span><span>${r.energy ?? '—'} / 10${r.bpm ? ` · ${r.bpm} BPM` : ''}</span></div>
          <div class="kv"><span>Tempo feel</span><span>${esc(r.tempoFeel || '—')}</span></div>
          <div class="kv"><span>Genres</span><span>${(r.genres || []).map((g) => `<span class="badge">${esc(g)}</span>`).join(' ')}</span></div>
          <div class="kv"><span>Tags</span><span>${(r.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join(' ')}</span></div>`;
      }
      case 'music-generate':
        return r.url ? `<audio src="${esc(r.url)}" controls style="width:100%"></audio>
          <p class="sub">Provider: ${esc(r.provider || '')} · Saved to your Media Library.</p>` : '';
      default: return '';
    }
  }

  function wireResultActions(j) {
    const r = j.result || {};
    const dl = document.getElementById('ai-dl-csv');
    if (dl) dl.addEventListener('click', () => {
      const blob = new Blob([r.csv || ''], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'ai-quiz-questions.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    const cp = document.getElementById('ai-copy-csv');
    if (cp) cp.addEventListener('click', async () => { await navigator.clipboard.writeText(r.csv || ''); toast('Quiz CSV copied.'); });
    const bulk = document.getElementById('ai-to-bulk');
    if (bulk) bulk.addEventListener('click', () => go('bulk-video'));
    const open = document.getElementById('ai-open-design');
    if (open) open.addEventListener('click', () => go('design-editor', { projectId: r.projectId }));
  }

  async function view(c, presetMode) {
    if (presetMode && MODES.some((m) => m.id === presetMode)) mode = presetMode;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    await loadAll();
    const def = modeDef(mode);
    const ks = kindState(def.kind);
    const activeProv = (ks.providers || []).find((p) => p.active);
    c.innerHTML = `
    <div class="card"><h3>✨ AI Studio</h3>
      <p class="sub">Real AI generation through configurable providers. Every result is saved to your Media Library. Without a key, a mode refuses honestly with “key needed” — nothing is faked.</p>
      <div class="ai-modes">${MODES.map((m) => {
        const kst = kindState(m.kind);
        return `<button class="ai-mode-btn ${m.id === mode ? 'active' : ''}" data-mode="${m.id}">${m.icon} ${m.label} ${kst.configured ? '' : '<span class="badge warn">key needed</span>'}</button>`;
      }).join('')}</div>
    </div>
    <div class="grid grid-2">
      <div class="card"><h3>${def.icon} ${def.label}</h3>
        ${ks.configured
          ? `<p class="sub">Provider: <b>${esc(activeProv ? activeProv.label : def.kind)}</b> — configured ✓${activeProv && activeProv.model ? ` · model ${esc(activeProv.model)}` : ''}</p>`
          : `<div class="ed-note"><b>No ${esc(def.kind)} provider key yet.</b> This mode will refuse with “key needed” until a key is added in <a href="#" id="ai-goto-settings">Settings → AI Providers</a>. Nothing will be generated or faked.</div>`}
        <div id="ai-form">${fieldsFor(mode)}</div>
        <div class="ed-btnrow"><button class="btn btn-primary" id="ai-generate">Generate</button>
        <button class="btn" id="ai-clear-result">Clear result</button></div>
        <div class="error" id="ai-error"></div>
        <div id="ai-job-box"></div>
      </div>
      <div class="card"><h3>Result</h3><div id="ai-result"><p class="sub">Nothing generated yet. Pick a mode, write a prompt and press Generate.</p></div></div>
    </div>
    <div class="card" style="margin-top:16px"><h3>AI jobs</h3>
      <p class="sub">Every generation is logged here (and in usage logs) — transparent, no hidden charges.</p>
      <div id="ai-jobs">${jobsListHtml()}</div>
    </div>`;
    c.querySelectorAll('.ai-mode-btn').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; view(c); }));
    const gs = document.getElementById('ai-goto-settings');
    if (gs) gs.addEventListener('click', (e) => { e.preventDefault(); go('settings'); });
    document.getElementById('ai-clear-result').addEventListener('click', () => {
      document.getElementById('ai-result').innerHTML = '<p class="sub">Nothing generated yet.</p>';
      document.getElementById('ai-job-box').innerHTML = '';
      currentJob = null;
    });
    document.getElementById('ai-generate').addEventListener('click', () => generate());
    wireJobButtons();
  }

  function jobsListHtml() {
    if (!jobs.length) return '<p class="sub">No AI jobs yet.</p>';
    return `<table><thead><tr><th>ID</th><th>Mode</th><th>Name</th><th>Status</th><th>Progress</th><th></th></tr></thead><tbody>
      ${jobs.map((j) => `<tr><td>${j.id}</td><td>${esc(j.mode)}</td><td>${esc(j.name || '')}</td>
        <td><span class="badge ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'danger' : j.status === 'cancelled' ? '' : 'warn'}">${esc(j.status)}</span>${j.error ? `<br><small style="color:var(--danger, #dc2626)">${esc(String(j.error).slice(0, 120))}</small>` : ''}</td>
        <td>${j.progress || 0}%</td>
        <td style="white-space:nowrap">
          ${j.outputUrl ? `<a class="btn btn-sm" href="${esc(j.outputUrl)}" download>Download</a>` : ''}
          ${(j.status === 'queued' || j.status === 'running') ? `<button class="btn btn-sm" data-ai-cancel="${j.id}">Cancel</button>` : ''}
          ${(j.status === 'failed' || j.status === 'cancelled') ? `<button class="btn btn-sm" data-ai-retry="${j.id}">Retry</button>` : ''}
          <button class="btn btn-sm btn-danger" data-ai-del="${j.id}">Delete</button>
        </td></tr>`).join('')}
    </tbody></table>`;
  }

  function wireJobButtons() {
    document.querySelectorAll('[data-ai-cancel]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/ai/jobs/${b.dataset.aiCancel}/cancel`, { method: 'POST' }); toast('AI job cancelled.'); view(document.getElementById('content'));
    }));
    document.querySelectorAll('[data-ai-retry]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/ai/jobs/${b.dataset.aiRetry}/retry`, { method: 'POST' }); toast('AI job re-queued.'); view(document.getElementById('content'));
    }));
    document.querySelectorAll('[data-ai-del]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/ai/jobs/${b.dataset.aiDel}`, { method: 'DELETE' }); toast('AI job deleted.'); view(document.getElementById('content'));
    }));
  }

  async function generate() {
    const errBox = document.getElementById('ai-error');
    const jobBox = document.getElementById('ai-job-box');
    const resultBox = document.getElementById('ai-result');
    errBox.style.display = 'none';
    const params = collectParams(mode);
    const def = modeDef(mode);
    try {
      const { job } = await api('/api/ai/jobs', { method: 'POST', body: JSON.stringify({ mode, name: def.label, ...params }) });
      currentJob = job;
      jobBox.innerHTML = jobStatusHtml(job);
      resultBox.innerHTML = '<p class="sub">Generating… the job runs in the background; you can leave this page and come back.</p>';
      const finalJob = await pollJob(job.id, (j) => { jobBox.innerHTML = jobStatusHtml(j); });
      if (finalJob.status === 'done') {
        jobBox.innerHTML = jobStatusHtml(finalJob);
        resultBox.innerHTML = resultHtml(finalJob);
        wireResultActions(finalJob);
        toast('AI generation finished — saved to your Media Library.');
      } else if (finalJob.status === 'cancelled') {
        jobBox.innerHTML = jobStatusHtml(finalJob);
        resultBox.innerHTML = '<p class="sub">Job cancelled — no output was created.</p>';
      } else {
        errBox.textContent = finalJob.error || 'AI generation failed.';
        errBox.style.display = 'block';
        resultBox.innerHTML = '<p class="sub">Generation failed. Check the error above, add or fix the provider key, then press Retry.</p>';
      }
      const js = await api('/api/ai/jobs').catch(() => ({ jobs: [] }));
      jobs = js.jobs || [];
      const list = document.getElementById('ai-jobs');
      if (list) { list.innerHTML = jobsListHtml(); wireJobButtons(); }
    } catch (e) {
      errBox.textContent = e.message;
      errBox.style.display = 'block';
    }
  }

  return { view, pollJob };
})();
