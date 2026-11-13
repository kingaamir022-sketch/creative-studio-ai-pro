'use strict';
/* Global entry points used by app.js routing (same pattern as viewMusicSync). */
async function viewShorts(c) { return ShortsUI.view(c); }
async function viewCaptions(c) { return ShortsUI.viewCaptions(c); }
const ShortsUI = (() => {
  let videos = [];
  let jobs = [];
  let selectedVideoId = null;
  let selectedJobId = null;
  let detail = null; // { job, clips, ... }
  let pollTimer = null;
  let languages = [];

  const fmtT = (t) => {
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
  };
  const fmtDur = (t) => {
    if (t == null) return '—';
    const m = Math.floor(t / 60), s = Math.round(t % 60);
    return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  };

  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function loadAll() {
    const v = await api('/api/shorts/videos');
    videos = v.videos || [];
    const j = await api('/api/shorts/jobs');
    jobs = j.jobs || [];
    languages = j.supportedLanguages || [];
  }
  async function loadDetail(id) {
    detail = await api(`/api/shorts/jobs/${id}`);
    selectedJobId = id;
  }

  function scoreBar(label, value) {
    const pct = Math.round((value || 0) * 100);
    return `<div class="sh-score-row"><span>${label}</span><div class="sh-score-track"><div class="sh-score-fill" style="width:${pct}%"></div></div><b>${pct}%</b></div>`;
  }

  function clipCard(clip) {
    const b = clip.breakdown || {};
    const statusBadge = {
      candidate: '<span class="badge">Candidate</span>',
      approved: '<span class="badge ok">Approved ✓</span>',
      rejected: '<span class="badge err">Rejected</span>',
      rendering: '<span class="badge warn">Rendering…</span>',
      done: '<span class="badge ok">Done ✓</span>',
      failed: '<span class="badge err">Failed</span>',
    }[clip.status] || '';
    const capBadge = {
      none: '<span class="badge">No captions yet</span>',
      ready: '<span class="badge ok">Captions ready</span>',
      'no-cues': '<span class="badge warn">No captions in this range</span>',
      burned: '<span class="badge ok">Captions burned in</span>',
    }[clip.captionStatus] || '';
    const thumb = `/api/shorts/jobs/${detail.job.id}/clips/${clip.id}/thumbnail`;
    return `<div class="sh-clip ${clip.status === 'rejected' ? 'rejected' : ''}">
      <img class="sh-thumb" src="${thumb}" alt="Clip thumbnail" onerror="this.style.display='none'">
      <div class="sh-clip-body">
        <div class="sh-clip-head">
          <b>${fmtT(clip.start)} – ${fmtT(clip.end)}</b> · ${clip.duration}s
          <span class="sh-score-badge">${clip.score} / 100</span>
          ${statusBadge} ${capBadge}
        </div>
        <div class="sh-scores">
          ${scoreBar('Speech', b.speechDensity)}
          ${scoreBar('Energy', b.energy)}
          ${scoreBar('Scene rate', b.sceneRate)}
          ${scoreBar('Position', b.position)}
        </div>
        ${clip.error ? `<p class="sh-err">${esc(clip.error)}</p>` : ''}
        <div class="sh-clip-actions">
          ${clip.status === 'candidate' || clip.status === 'rejected' ? `<button class="btn btn-sm btn-primary" data-approve="${clip.id}">Approve</button>` : ''}
          ${clip.status === 'approved' ? `<button class="btn btn-sm" data-unapprove="${clip.id}">Back to candidate</button>` : ''}
          ${clip.status === 'candidate' || clip.status === 'approved' ? `<button class="btn btn-sm" data-reject="${clip.id}">Reject</button>` : ''}
          ${clip.status === 'done' ? `<a class="btn btn-sm btn-primary" href="/api/shorts/jobs/${detail.job.id}/clips/${clip.id}/download">Download MP4</a>` : ''}
          <span class="sh-trim">
            <input type="number" step="0.1" min="0" value="${clip.start}" data-trim-start="${clip.id}" title="Start (s)"> –
            <input type="number" step="0.1" min="0" value="${clip.end}" data-trim-end="${clip.id}" title="End (s)">
            <button class="btn btn-sm" data-trim="${clip.id}">Trim</button>
          </span>
        </div>
      </div>
    </div>`;
  }

  function transcriptPanel() {
    if (!detail) return '';
    const t = detail.job.transcript;
    return `<div class="card">
      <h3>💬 Captions &amp; transcript</h3>
      <p class="sub">Two honest paths: <b>automatic transcription needs a speech-to-text key</b> (none is configured — the button below will tell you so, it never fakes a transcript). <b>Manual transcript works now:</b> paste plain text (timing is estimated by character count), or paste SRT/VTT for exact timing. Word-by-word captions are burned into the render; Arabic/Urdu/Hindi shape correctly via libass.</p>
      ${t ? `<p><span class="badge ok">Transcript saved</span> ${t.cues} cues · ${t.timing === 'exact' ? 'exact timing' : 'estimated timing'} · ${esc(t.language)} · ${esc(t.source || '')}
        &nbsp;<a class="btn btn-sm" href="/api/shorts/jobs/${detail.job.id}/captions.srt">Download .srt</a>
        <a class="btn btn-sm" href="/api/shorts/jobs/${detail.job.id}/captions.vtt">Download .vtt</a></p>` : '<p class="sub">No transcript yet — clips will render without captions until you add one.</p>'}
      <div class="sh-form-row">
        <label>Language
          <select id="sh-lang">${languages.map((l) => `<option value="${l.id}" ${detail.job.language === l.id ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}</select>
        </label>
        <label>Format
          <select id="sh-tr-format">
            <option value="text">Plain text (estimated timing)</option>
            <option value="srt">SRT (exact timing)</option>
            <option value="vtt">VTT (exact timing)</option>
          </select>
        </label>
        <button class="btn" id="sh-stt">🎙️ Transcribe automatically (STT)</button>
      </div>
      <textarea id="sh-transcript" rows="6" placeholder="Paste your transcript here — plain text, or full SRT / VTT with timestamps."></textarea>
      <div style="margin-top:8px"><button class="btn btn-primary" id="sh-save-transcript">Save transcript</button></div>
      <div id="sh-tr-msg" class="sub" style="margin-top:6px"></div>
    </div>`;
  }

  async function view(c) {
    stopPolling();
    await loadAll();
    if (selectedJobId) {
      try { await loadDetail(selectedJobId); } catch { selectedJobId = null; detail = null; }
    }
    c.innerHTML = `
    <div class="card">
      <h2>✂️ Long Video to Shorts <span class="badge ok">Phase 6</span></h2>
      <p class="sub">Upload a long video; the studio finds the best moments with real local FFmpeg analysis (scene changes, silence, audio energy), ranks them with an <b>explainable</b> score, reframes them to 9:16 and burns in captions. The score measures how much is happening in a segment — <b>it does not predict views or virality</b>.</p>
      <div class="mu-limits">
        <b>Honest limits:</b> no face/subject tracking — the 9:16 crop follows the centre of motion in each clip (a vision model would be needed for tracking, Phase 7) · automatic transcription needs a speech-to-text key (none configured) — manual transcripts work now · plain-text transcripts get estimated timing; paste SRT/VTT for exact timing.
      </div>
    </div>

    <div class="sh-grid">
      <div class="card">
        <h3>1 · Pick a long video</h3>
        <p class="sub">Videos from your Media Library. Upload a long video there first (MP4, up to 200 MB).</p>
        <div id="sh-videos">${videos.length ? videos.map((v) => `
          <div class="sh-video ${selectedVideoId === v.id ? 'selected' : ''}" data-video="${v.id}">
            <div class="nm">🎬 ${esc(v.originalName)}</div>
            <div class="mt">${v.durationSeconds ? fmtDur(v.durationSeconds) + ' · ' : ''}${v.width}×${v.height} · ${(v.sizeBytes / 1048576).toFixed(1)} MB</div>
            ${v.shortsJob ? `<div class="mt">Shorts job: <b>${esc(v.shortsJob.status)}</b> (job #${v.shortsJob.id})</div>` : ''}
          </div>`).join('') : '<p class="sub">No videos in your library yet.</p>'}</div>
        <div class="sh-form-row" style="margin-top:12px">
          <label>Min clip (s)<input type="number" id="sh-min" value="15" min="3" max="120"></label>
          <label>Max clip (s)<input type="number" id="sh-max" value="60" min="5" max="180"></label>
          <label>Max clips<input type="number" id="sh-maxclips" value="10" min="1" max="25"></label>
          <label>Render size
            <select id="sh-res"><option value="720p">720×1280 (faster)</option><option value="1080p">1080×1920</option></select>
          </label>
          <label>Caption language
            <select id="sh-lang2">${languages.map((l) => `<option value="${l.id}">${esc(l.label)}</option>`).join('')}</select>
          </label>
        </div>
        <button class="btn btn-primary" id="sh-analyse" style="margin-top:10px">🔍 Analyse video &amp; find Shorts</button>
        <div id="sh-analyse-msg" class="sub" style="margin-top:6px"></div>
      </div>

      <div class="card">
        <h3>2 · Your Shorts jobs</h3>
        <div id="sh-jobs">${jobs.length ? jobs.map((j) => `
          <div class="sh-video ${selectedJobId === j.id ? 'selected' : ''}" data-job="${j.id}">
            <div class="nm">✂️ ${esc(j.name)}</div>
            <div class="mt">Status: <b>${esc(j.status)}</b> · ${j.clips} clips · ${j.approved} approved · ${j.done} rendered</div>
            ${j.error ? `<div class="mt" style="color:#f87171">${esc(j.error)}</div>` : ''}
          </div>`).join('') : '<p class="sub">No Shorts jobs yet.</p>'}</div>
      </div>
    </div>

    <div id="sh-detail"></div>`;

    const detailEl = c.querySelector('#sh-detail');
    const renderDetail = () => {
      if (!detail) { detailEl.innerHTML = ''; return; }
      const j = detail.job;
      const approved = detail.clips.filter((x) => x.status === 'approved').length;
      const done = detail.clips.filter((x) => x.status === 'done').length;
      detailEl.innerHTML = `
      <div class="card">
        <h3>✂️ ${esc(j.name)} <span class="badge ${j.status === 'ready' ? 'ok' : j.status === 'failed' ? 'err' : 'warn'}">${esc(j.status)}</span></h3>
        <p class="sub">${j.analysis.durationSeconds ? fmtDur(j.analysis.durationSeconds) + ' · ' : ''}${j.analysis.width}×${j.analysis.height} · ${j.analysis.scenes} scene changes · ${j.analysis.silences} silences · audio: ${j.analysis.hasAudio ? 'yes' : 'no'} · analysed locally (FFmpeg, no key).</p>
        <p class="sub">${esc(detail.scoreExplained || '')}</p>
        <p class="sub">${esc(detail.reframeNote || '')}</p>
        ${j.error ? `<p class="sh-err">${esc(j.error)}</p>` : ''}
        <div class="sh-detail-actions">
          <button class="btn btn-primary" id="sh-render" ${approved ? '' : 'disabled'}>🎬 Render ${approved} approved clip(s)</button>
          ${done ? `<a class="btn" href="/api/shorts/jobs/${j.id}/zip">Download all as ZIP</a>` : ''}
          <button class="btn" id="sh-refresh">Refresh</button>
          <button class="btn" id="sh-delete-job" style="color:#f87171">Delete job</button>
        </div>
      </div>
      ${transcriptPanel()}
      <div class="card">
        <h3>3 · Clip candidates — review &amp; approve</h3>
        <p class="sub">Approve the clips you want. Rejected clips are never rendered. You can trim a clip's start/end before approving.</p>
        <div id="sh-clips">${detail.clips.length ? detail.clips.map(clipCard).join('') : '<p class="sub">No clips yet — analysis may still be running. Press Refresh.</p>'}</div>
      </div>`;
      bindDetail(detailEl);
    };

    const refresh = async () => {
      try {
        await loadDetail(selectedJobId);
        renderDetail();
        const busy = detail.job.status === 'analysing' || detail.clips.some((x) => x.status === 'rendering');
        if (!busy) stopPolling();
      } catch (e) { toast(e.message, true); }
    };

    function bindDetail(el) {
      const r = el.querySelector('#sh-refresh');
      if (r) r.onclick = refresh;
      const del = el.querySelector('#sh-delete-job');
      if (del) del.onclick = async () => {
        if (!confirm('Delete this Shorts job and its clips? Rendered files stay in the Export Center.')) return;
        try { await api(`/api/shorts/jobs/${detail.job.id}`, { method: 'DELETE' }); selectedJobId = null; detail = null; stopPolling(); await view(c); } catch (e) { toast(e.message, true); }
      };
      const renderBtn = el.querySelector('#sh-render');
      if (renderBtn) renderBtn.onclick = async () => {
        try {
          const res = document.getElementById('sh-res');
          const out = await api(`/api/shorts/jobs/${detail.job.id}/render`, { method: 'POST', body: JSON.stringify({ resolution: res ? res.value : '720p' }) });
          toast(`Rendering ${out.jobs.length} clip(s)…`);
          await refresh();
          if (!pollTimer) pollTimer = setInterval(refresh, 3000);
        } catch (e) { toast(e.message, true); }
      };
      el.querySelectorAll('[data-approve]').forEach((b) => b.onclick = async () => {
        try { await api(`/api/shorts/jobs/${detail.job.id}/clips/${b.dataset.approve}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) }); await refresh(); } catch (e) { toast(e.message, true); }
      });
      el.querySelectorAll('[data-unapprove]').forEach((b) => b.onclick = async () => {
        try { await api(`/api/shorts/jobs/${detail.job.id}/clips/${b.dataset.unapprove}`, { method: 'PATCH', body: JSON.stringify({ status: 'candidate' }) }); await refresh(); } catch (e) { toast(e.message, true); }
      });
      el.querySelectorAll('[data-reject]').forEach((b) => b.onclick = async () => {
        try { await api(`/api/shorts/jobs/${detail.job.id}/clips/${b.dataset.reject}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected' }) }); await refresh(); } catch (e) { toast(e.message, true); }
      });
      el.querySelectorAll('[data-trim]').forEach((b) => b.onclick = async () => {
        const id = b.dataset.trim;
        const s = el.querySelector(`[data-trim-start="${id}"]`);
        const e2 = el.querySelector(`[data-trim-end="${id}"]`);
        try {
          await api(`/api/shorts/jobs/${detail.job.id}/clips/${id}`, { method: 'PATCH', body: JSON.stringify({ start: parseFloat(s.value), end: parseFloat(e2.value) }) });
          toast('Clip trimmed.');
          await refresh();
        } catch (e) { toast(e.message, true); }
      });
      const saveTr = el.querySelector('#sh-save-transcript');
      if (saveTr) saveTr.onclick = async () => {
        const msg = el.querySelector('#sh-tr-msg');
        try {
          const format = el.querySelector('#sh-tr-format').value;
          const lang = el.querySelector('#sh-lang').value;
          const text = el.querySelector('#sh-transcript').value;
          const out = await api(`/api/shorts/jobs/${detail.job.id}/transcript`, { method: 'POST', body: JSON.stringify({ format, text, language: lang }) });
          msg.textContent = `Saved ${out.cues} cues (${out.timing} timing).${out.warnings && out.warnings.length ? ' ' + out.warnings.join(' ') : ''}`;
          await refresh();
        } catch (e) { msg.textContent = e.message; toast(e.message, true); }
      };
      const stt = el.querySelector('#sh-stt');
      if (stt) stt.onclick = async () => {
        const msg = el.querySelector('#sh-tr-msg');
        try {
          await api(`/api/shorts/jobs/${detail.job.id}/transcribe`, { method: 'POST', body: JSON.stringify({}) });
          msg.textContent = 'Transcription started.';
        } catch (e) {
          msg.textContent = e.message + ' Use a manual transcript instead — paste text or SRT/VTT below.';
          toast(e.message, true);
        }
      };
    }

    c.querySelectorAll('[data-video]').forEach((el) => el.onclick = () => {
      selectedVideoId = Number(el.dataset.video);
      c.querySelectorAll('[data-video]').forEach((x) => x.classList.toggle('selected', Number(x.dataset.video) === selectedVideoId));
    });
    c.querySelectorAll('[data-job]').forEach((el) => el.onclick = async () => {
      selectedJobId = Number(el.dataset.job);
      await refresh();
      if (detail && detail.job.status === 'analysing') {
        if (!pollTimer) pollTimer = setInterval(refresh, 3000);
      }
      c.querySelectorAll('[data-job]').forEach((x) => x.classList.toggle('selected', Number(x.dataset.job) === selectedJobId));
      renderDetail();
    });

    const analyseBtn = c.querySelector('#sh-analyse');
    analyseBtn.onclick = async () => {
      const msg = c.querySelector('#sh-analyse-msg');
      if (!selectedVideoId) { msg.textContent = 'Pick a video first.'; return; }
      try {
        msg.textContent = 'Analysis started — this runs in the background; the job will appear below.';
        const lang2 = document.getElementById('sh-lang2');
        const out = await api('/api/shorts/jobs', { method: 'POST', body: JSON.stringify({
          mediaId: selectedVideoId,
          language: lang2 ? lang2.value : 'en',
          settings: {
            minClipSeconds: Number(document.getElementById('sh-min').value) || 15,
            maxClipSeconds: Number(document.getElementById('sh-max').value) || 60,
            maxClips: Number(document.getElementById('sh-maxclips').value) || 10,
            resolution: document.getElementById('sh-res').value,
          },
        }) });
        selectedJobId = out.job.id;
        await loadAll();
        await refresh();
        if (!pollTimer) pollTimer = setInterval(refresh, 3000);
        msg.textContent = `Job #${out.job.id} created — analysis running…`;
      } catch (e) { msg.textContent = e.message; toast(e.message, true); }
    };

    if (detail) {
      renderDetail();
      if (detail.job.status === 'analysing' || detail.clips.some((x) => x.status === 'rendering')) {
        if (!pollTimer) pollTimer = setInterval(refresh, 3000);
      }
    }
  }

  async function viewCaptions(c) {
    stopPolling();
    await loadAll();
    c.innerHTML = `
    <div class="card">
      <h2>💬 Auto Captions <span class="badge ok">Phase 6</span></h2>
      <p class="sub">Captions live on Shorts jobs: pick a job, add a transcript, and every approved clip renders with word-by-word captions burned in. Languages: English, Urdu, Roman Urdu, Arabic (proper RTL shaping) and Hindi. SRT/VTT export included.</p>
      <p class="sub"><b>Honest note:</b> automatic speech-to-text needs a provider key (none configured) — the transcribe button refuses instead of faking a transcript. Manual transcripts (plain text with estimated timing, or SRT/VTT with exact timing) work now.</p>
    </div>
    <div class="card">
      <h3>Shorts jobs with captions</h3>
      ${jobs.length ? jobs.map((j) => `
        <div class="sh-video" data-job="${j.id}">
          <div class="nm">✂️ ${esc(j.name)}</div>
          <div class="mt">${j.transcript ? `${j.transcript.cues} caption cues · ${j.transcript.timing} timing · ${esc(j.transcript.language)}` : 'No transcript yet'} · ${j.clips} clips · ${j.done} rendered</div>
        </div>`).join('') : '<p class="sub">No Shorts jobs yet — create one in Shorts Studio first.</p>'}
    </div>
    <div id="sh-detail"></div>`;
    const detailEl = c.querySelector('#sh-detail');
    c.querySelectorAll('[data-job]').forEach((el) => el.onclick = async () => {
      selectedJobId = Number(el.dataset.job);
      await loadDetail(selectedJobId);
      detailEl.innerHTML = `<div class="card"><h3>✂️ ${esc(detail.job.name)}</h3></div>` + transcriptPanel();
      const saveTr = detailEl.querySelector('#sh-save-transcript');
      if (saveTr) saveTr.onclick = async () => {
        const msg = detailEl.querySelector('#sh-tr-msg');
        try {
          const out = await api(`/api/shorts/jobs/${detail.job.id}/transcript`, {
            method: 'POST',
            body: JSON.stringify({
              format: detailEl.querySelector('#sh-tr-format').value,
              text: detailEl.querySelector('#sh-transcript').value,
              language: detailEl.querySelector('#sh-lang').value,
            }),
          });
          msg.textContent = `Saved ${out.cues} cues (${out.timing} timing).`;
          await viewCaptions(c);
        } catch (e) { msg.textContent = e.message; toast(e.message, true); }
      };
      const stt = detailEl.querySelector('#sh-stt');
      if (stt) stt.onclick = async () => {
        const msg = detailEl.querySelector('#sh-tr-msg');
        try { await api(`/api/shorts/jobs/${detail.job.id}/transcribe`, { method: 'POST', body: JSON.stringify({}) }); }
        catch (e) { msg.textContent = e.message + ' Use a manual transcript instead.'; toast(e.message, true); }
      };
    });
  }

  return { view, viewCaptions };
})();
