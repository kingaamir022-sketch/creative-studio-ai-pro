'use strict';
/* Global entry point used by app.js routing (same pattern as viewBulkVideo). */
async function viewMusicSync(c) { return MusicUI.view(c); }
const MusicUI = (() => {
  let tracks = [];
  let projects = [];
  let selectedTrack = null;
  let selectedProject = null;
  let analysis = null;

  const fmtT = (t) => {
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
  };
  const confBadge = (a) => {
    if (!a) return '<span class="badge">Not analysed</span>';
    const cls = a.confidence >= 0.7 ? 'ok' : a.confidence >= 0.45 ? 'warn' : 'err';
    return `<span class="badge ${cls}">Confidence ${a.confidence}${a.lowConfidence ? ' — low' : ''}</span>`;
  };

  async function loadAll() {
    const t = await api('/api/music/tracks');
    tracks = t.tracks;
    const p = await api('/api/projects?type=video');
    projects = p.projects || [];
  }

  function drawWaveform() {
    const cv = document.getElementById('mu-wave');
    if (!cv || !analysis) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);
    const dur = analysis.durationSeconds || 1;
    const x = (t) => (t / dur) * W;
    // Energy curve (background).
    const ec = analysis.energyCurve || [];
    if (ec.length) {
      ctx.fillStyle = 'rgba(124,92,255,0.25)';
      ec.forEach((v, i) => {
        const bx = (i / ec.length) * W;
        const bh = v * H * 0.5;
        ctx.fillRect(bx, H - bh, Math.max(1, W / ec.length - 1), bh);
      });
    }
    // Waveform peaks.
    const peaks = analysis.waveformPeaks || [];
    ctx.fillStyle = '#7c5cff';
    peaks.forEach((v, i) => {
      const bx = (i / peaks.length) * W;
      const bh = Math.max(1, v * H * 0.9);
      ctx.fillRect(bx, (H - bh) / 2, Math.max(1, W / peaks.length - 1), bh);
    });
    // Drops (amber bands).
    (analysis.drops || []).forEach((d) => {
      ctx.fillStyle = 'rgba(252,163,17,0.35)';
      ctx.fillRect(x(d.t), 0, Math.max(3, W * 0.01), H);
      ctx.fillStyle = '#fca311';
      ctx.font = '11px Inter, sans-serif';
      ctx.fillText('DROP', x(d.t) + 4, 14);
    });
    // Beat grid (white ticks; downbeats taller).
    const downs = new Set((analysis.downbeats || []).map((b) => b.toFixed(2)));
    (analysis.beats || []).forEach((b) => {
      const isDown = downs.has(b.toFixed(2));
      ctx.strokeStyle = isDown ? '#22d3ee' : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = isDown ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x(b), isDown ? 0 : H * 0.25);
      ctx.lineTo(x(b), H);
      ctx.stroke();
    });
    // Time labels.
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px Inter, sans-serif';
    for (let s = 0; s <= dur; s += Math.max(1, Math.round(dur / 8))) {
      ctx.fillText(fmtT(s), x(s) + 2, H - 4);
    }
  }

  function trackRow(t) {
    const sel = selectedTrack && selectedTrack.id === t.id;
    return `<div class="mu-track ${sel ? 'selected' : ''}" data-track="${t.id}">
      <div class="mu-track-main">
        <div class="nm">🎵 ${esc(t.originalName)}</div>
        <div class="mt">${t.durationSeconds ? fmtT(t.durationSeconds) + ' · ' : ''}${(t.sizeBytes / 1024).toFixed(0)} KB · ${esc(t.mimeType)}</div>
        ${t.analysed
          ? `<div class="mt"><b>${t.bpm} BPM</b> · ${t.beats} beats · ${t.drops} drop(s) ${confBadge({ confidence: t.confidence, lowConfidence: t.lowConfidence })}</div>`
          : '<div class="mt">Not analysed yet — click Analyse to detect BPM and beats (local DSP, no key needed).</div>'}
        ${t.licenseNote ? `<div class="mt">📜 ${esc(t.licenseNote)}</div>` : '<div class="mt" style="color:#f59e0b">No license/source note yet — add one so you always know where this track came from.</div>'}
      </div>
      <div class="mu-track-btns">
        <button class="btn btn-sm ${t.analysed ? '' : 'btn-primary'}" data-analyse="${t.id}">${t.analysed ? 'Re-analyse' : 'Analyse'}</button>
      </div>
    </div>`;
  }

  async function view(c) {
    await loadAll();
    c.innerHTML = `
    <div class="card">
      <h2>🎵 Music Sync Director <span class="badge ok">Phase 5</span></h2>
      <p class="sub">Real beat/BPM analysis (local DSP — FFmpeg decode + onset detection, no API key) that cuts scenes, transitions and effects to the music. <b>Licensed or user-provided music only</b> — CreativeStudio never downloads stock or copyrighted music and never generates music.</p>
      <div class="mu-limits">
        <b>Honest limits:</b> no AI music generation · no auto "mood" tagging (Phase 7) · beat detection is energy/onset-based, so it is less reliable on ambient, classical or vocal-only audio — a low confidence score warns you instead of promising "perfect" sync · one music track + the video's own audio only (no multi-track mixing) · a transition overlaps the previous clip, so it shortens the rendered video slightly.
      </div>
    </div>

    <div class="mu-grid">
      <div class="card">
        <h3>1 · Pick a music track</h3>
        <p class="sub">Audio from your Media Library (MP3 / WAV / M4A / OGG / FLAC, up to 200 MB). Upload more in the Media Library.</p>
        <div id="mu-tracks">${tracks.length ? tracks.map(trackRow).join('') : '<p class="sub">No audio in your library yet. Upload an MP3 or WAV in the Media Library first.</p>'}</div>
        <div id="mu-license" style="margin-top:12px"></div>
      </div>

      <div class="card">
        <h3>2 · Pick a video project</h3>
        <p class="sub">The project must have video clips on its timeline already.</p>
        <div id="mu-projects">${projects.length ? projects.map((p) => `
          <div class="mu-track ${selectedProject && selectedProject.id === p.id ? 'selected' : ''}" data-project="${p.id}">
            <div class="mu-track-main"><div class="nm">🎬 ${esc(p.name)}</div><div class="mt">Updated ${esc((p.updatedAt || '').slice(0, 10))}</div></div>
          </div>`).join('') : '<p class="sub">No video projects yet. Create one in the Video Editor first.</p>'}</div>
      </div>
    </div>

    <div class="card" id="mu-analysis-card" style="display:none">
      <h3>3 · Beat grid <span id="mu-bpm"></span> <span id="mu-conf"></span></h3>
      <canvas id="mu-wave" width="960" height="180" style="width:100%;height:180px"></canvas>
      <p class="sub">White ticks = beats · cyan tall ticks = downbeats (estimated) · amber = detected drops · purple = energy curve. The grid below is what "Apply sync" cuts to.</p>
      <div id="mu-lowwarn"></div>
    </div>

    <div class="card" id="mu-sync-card" style="display:none">
      <h3>4 · Sync settings &amp; apply</h3>
      <div class="mu-form">
        <div><label>Sync mode</label><select id="mu-mode">
          <option value="both">Cut on beat + transition on beat</option>
          <option value="cut">Cut on beat only (sample-exact)</option>
          <option value="transition">Transition on beat only (no cuts)</option>
        </select></div>
        <div><label>Cut on</label><select id="mu-divisor">
          <option value="1">Every beat</option>
          <option value="2">Every 2nd beat</option>
          <option value="4">Every 4th beat</option>
        </select></div>
        <div><label>Transition</label><select id="mu-trans">
          <option value="fade">Fade</option><option value="dissolve">Dissolve</option>
          <option value="slide">Slide</option><option value="wipe">Wipe</option>
        </select></div>
        <div><label>Transition (s)</label><input type="number" id="mu-transdur" value="0.5" min="0.1" max="2" step="0.1"></div>
        <div><label><input type="checkbox" id="mu-pulse" checked> Beat pulse on text</label>
          <label style="margin-top:6px">Pulse strength <input type="range" id="mu-pulsestr" min="0" max="1" step="0.1" value="0.6"> <span id="mu-pulsestr-v">0.6</span></label></div>
        <div><label>Music trim / offset (s)</label><input type="number" id="mu-offset" value="0" min="0" step="0.1"></div>
        <div><label>Fade in (s)</label><input type="number" id="mu-fadein" value="0" min="0" max="5" step="0.1"></div>
        <div><label>Fade out (s)</label><input type="number" id="mu-fadeout" value="0" min="0" max="5" step="0.1"></div>
        <div><label>Music volume</label><input type="range" id="mu-volume" min="0" max="1" step="0.05" value="0.8"> <span id="mu-volume-v">0.8</span></div>
        <div><label>If the music is shorter than the video</label><select id="mu-fit">
          <option value="loop">Loop the track</option><option value="trim">Let it end (last part silent)</option>
        </select></div>
      </div>
      <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-primary" id="mu-apply">♪ Apply sync to project</button>
        <button class="btn" id="mu-remove" style="display:none">Remove sync</button>
      </div>
      <div class="error" id="mu-error"></div>
      <div id="mu-report"></div>
    </div>`;

    // --- Track selection + analysis ---
    c.querySelectorAll('[data-track]').forEach((el) => el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-analyse]')) return;
      selectedTrack = tracks.find((t) => String(t.id) === el.dataset.track);
      analysis = null;
      renderSelection();
      if (selectedTrack.analysed) {
        try {
          const r = await api(`/api/music/tracks/${selectedTrack.id}/analysis`);
          analysis = r.analysis;
          showAnalysis();
        } catch (err) { toast(err.message, true); }
      }
    }));
    c.querySelectorAll('[data-analyse]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const t = tracks.find((x) => String(x.id) === b.dataset.analyse);
      b.disabled = true;
      b.textContent = 'Analysing…';
      try {
        const r = await api(`/api/music/tracks/${t.id}/analyze`, { method: 'POST' });
        analysis = r.analysis;
        selectedTrack = t;
        await loadAll();
        selectedTrack = tracks.find((x) => x.id === t.id);
        renderSelection();
        showAnalysis();
        toast(`Analysed: ${r.analysis.bpm} BPM, ${r.analysis.beats.length} beats, confidence ${r.analysis.confidence}${r.cached ? ' (cached)' : ''}.`);
      } catch (err) { toast(err.message, true); }
      b.disabled = false;
      b.textContent = t.analysed ? 'Re-analyse' : 'Analyse';
    }));
    c.querySelectorAll('[data-project]').forEach((el) => el.addEventListener('click', () => {
      selectedProject = projects.find((p) => String(p.id) === el.dataset.project);
      renderSelection();
    }));

    const ps = document.getElementById('mu-pulsestr');
    if (ps) ps.addEventListener('input', () => { document.getElementById('mu-pulsestr-v').textContent = ps.value; });
    const vol = document.getElementById('mu-volume');
    if (vol) vol.addEventListener('input', () => { document.getElementById('mu-volume-v').textContent = vol.value; });
    document.getElementById('mu-apply').addEventListener('click', applySync);
    document.getElementById('mu-remove').addEventListener('click', removeSync);

    function renderSelection() {
      c.querySelectorAll('[data-track]').forEach((el) => el.classList.toggle('selected', selectedTrack && String(selectedTrack.id) === el.dataset.track));
      c.querySelectorAll('[data-project]').forEach((el) => el.classList.toggle('selected', selectedProject && String(selectedProject.id) === el.dataset.project));
      const lic = document.getElementById('mu-license');
      if (selectedTrack) {
        lic.innerHTML = `<label>License / source note for “${esc(selectedTrack.originalName)}”</label>
          <div style="display:flex;gap:8px"><input type="text" id="mu-lic-input" maxlength="300" placeholder="e.g. Licensed from Artlist, 2026 · or: my own recording" value="${esc(selectedTrack.licenseNote || '')}" style="flex:1">
          <button class="btn btn-sm" id="mu-lic-save">Save note</button></div>
          <p class="sub">Only music you own or are licensed to use. This note travels with the track so the source is never a mystery later.</p>`;
        document.getElementById('mu-lic-save').addEventListener('click', async () => {
          const note = document.getElementById('mu-lic-input').value.trim();
          try {
            await api(`/api/music/tracks/${selectedTrack.id}/license`, { method: 'PATCH', body: JSON.stringify({ licenseNote: note }) });
            selectedTrack.licenseNote = note;
            toast('License note saved.');
          } catch (err) { toast(err.message, true); }
        });
      } else lic.innerHTML = '';
      const showSync = selectedTrack && selectedProject;
      document.getElementById('mu-sync-card').style.display = showSync ? 'block' : 'none';
      if (selectedTrack && !selectedTrack.analysed) {
        document.getElementById('mu-analysis-card').style.display = 'none';
      }
    }

    function showAnalysis() {
      if (!analysis) return;
      document.getElementById('mu-analysis-card').style.display = 'block';
      document.getElementById('mu-bpm').innerHTML = `<span class="badge info">${analysis.bpm} BPM</span>`;
      document.getElementById('mu-conf').innerHTML = confBadge(analysis);
      document.getElementById('mu-lowwarn').innerHTML = analysis.lowConfidence
        ? `<div class="error" style="display:block">⚠ Low beat confidence (${analysis.confidence}). This track's rhythm is hard to detect — check the beat grid above: if the ticks do not sit on the audible beats, the cuts will be off. Try a track with a clearer beat, or use a larger beat divisor (every 2nd/4th beat).</div>`
        : `<p class="sub">Confidence ${analysis.confidence} — beats look reliable. ${analysis.truncated ? esc(analysis.truncationNote) : ''}</p>`;
      drawWaveform();
    }

    async function applySync() {
      const errBox = document.getElementById('mu-error');
      const repBox = document.getElementById('mu-report');
      errBox.style.display = 'none';
      repBox.innerHTML = '';
      if (!selectedTrack || !selectedProject) { errBox.textContent = 'Pick a music track and a video project first.'; errBox.style.display = 'block'; return; }
      const body = {
        mediaId: selectedTrack.id,
        options: {
          syncMode: document.getElementById('mu-mode').value,
          beatDivisor: parseInt(document.getElementById('mu-divisor').value, 10),
          transition: { type: document.getElementById('mu-trans').value, duration: parseFloat(document.getElementById('mu-transdur').value) || 0.5 },
          pulse: { enabled: document.getElementById('mu-pulse').checked, target: 'text', strength: parseFloat(document.getElementById('mu-pulsestr').value) || 0.6 },
          offset: parseFloat(document.getElementById('mu-offset').value) || 0,
          fadeIn: parseFloat(document.getElementById('mu-fadein').value) || 0,
          fadeOut: parseFloat(document.getElementById('mu-fadeout').value) || 0,
          volume: parseFloat(document.getElementById('mu-volume').value),
          fitMode: document.getElementById('mu-fit').value,
        },
      };
      try {
        const r = await api(`/api/music/projects/${selectedProject.id}/apply-sync`, { method: 'POST', body: JSON.stringify(body) });
        const rp = r.report;
        repBox.innerHTML = `<div class="card" style="margin-top:12px">
          <h3>Sync applied ✓ — ${rp.bpm} BPM · confidence ${rp.confidence}</h3>
          <p class="sub">${rp.cuts} cut(s) on the beat · ${rp.transitions} transition(s) · ${rp.beatsUsed} beat(s) used · ${rp.pulseKeyframes} pulse keyframe(s) · ${rp.markersAdded} marker(s) (incl. ${rp.dropMarkers} drop) · music ends at ${rp.audioEndsAt}s of a ${rp.videoDuration}s video.</p>
          ${rp.warnings.length ? `<div class="error" style="display:block">${rp.warnings.map((w) => esc(w)).join('<br><br>')}</div>` : ''}
          <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
            <button class="btn btn-primary" id="mu-open-editor">Open in Video Editor</button>
            <button class="btn" id="mu-open-export">Render in Export Center</button>
          </div>
          <p class="sub" style="margin-top:8px">The pre-sync timeline was saved as a project version — Undo in the editor, or Remove sync above, to go back.</p>
        </div>`;
        document.getElementById('mu-remove').style.display = 'inline-block';
        document.getElementById('mu-open-editor').addEventListener('click', () => go('video-timeline', { projectId: selectedProject.id }));
        document.getElementById('mu-open-export').addEventListener('click', () => go('export'));
        toast('Music sync applied — cuts, transitions and markers now follow the beat grid.');
      } catch (err) {
        errBox.textContent = err.message;
        errBox.style.display = 'block';
      }
    }

    async function removeSync() {
      try {
        await api(`/api/music/projects/${selectedProject.id}/remove-sync`, { method: 'POST' });
        document.getElementById('mu-report').innerHTML = '<p class="sub">Sync removed (music clip, beat/drop markers and sync data stripped). The cuts stay — restore the saved pre-sync version from the project to undo them.</p>';
        document.getElementById('mu-remove').style.display = 'none';
        toast('Music sync removed.');
      } catch (err) { toast(err.message, true); }
    }
  }

  return { view };
})();
