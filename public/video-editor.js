'use strict';
/* CreativeStudio AI Pro — Phase 3 Video Editor.
   DOM timeline + real <video> preview (approximate crossfades — the final
   render is always FFmpeg, see the Export tab) + FFmpeg render jobs.
   Uses the app.js globals: api, esc, toast, go, fmtBytes. */
window.VideoEditor = (function () {
  let ed = null;
  let keyHandler = null;

  function uid(p) { return `${p || 'clip'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
  function deep(o) { return JSON.parse(JSON.stringify(o)); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  const fmtT = (t) => {
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  };

  function blankTimeline(aspectId, fps) {
    const aspects = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [720, 720], '4:5': [720, 900] };
    const [w, h] = aspects[aspectId] || aspects['16:9'];
    return {
      version: 1, width: w, height: h, fps: fps || 30, background: '#000000',
      tracks: [
        { id: uid('track'), kind: 'video', name: 'Video 1', locked: false, muted: false, clips: [] },
        { id: uid('track'), kind: 'audio', name: 'Audio 1', locked: false, muted: false, clips: [] },
        { id: uid('track'), kind: 'text', name: 'Text 1', locked: false, muted: false, clips: [] },
      ],
      markers: [],
    };
  }

  function totalDuration(tl) {
    let d = 0;
    for (const tr of tl.tracks) for (const c of tr.clips) d = Math.max(d, c.start + c.duration);
    return d;
  }
  function allClips(tl) {
    return tl.tracks.flatMap((tr) => tr.clips.map((c) => ({ clip: c, track: tr })));
  }
  function findClip(tl, id) {
    for (const tr of tl.tracks) {
      const c = tr.clips.find((x) => x.id === id);
      if (c) return { clip: c, track: tr };
    }
    return null;
  }
  function videoTrack(tl) { return tl.tracks.find((t) => t.kind === 'video'); }
  function clipAt(tl, trackKind, t) {
    const tr = tl.tracks.find((x) => x.kind === trackKind);
    if (!tr) return null;
    const c = tr.clips.find((x) => t >= x.start && t < x.start + x.duration);
    return c ? { clip: c, track: tr } : null;
  }

  function defaultClip(kind, mediaId, start, duration) {
    return {
      id: uid('clip'), mediaId: mediaId || null, kind,
      name: kind === 'text' ? 'Text clip' : kind === 'audio' ? 'Audio clip' : 'Video clip',
      start: start || 0, duration: duration || 3, srcStart: 0,
      speed: 1, volume: 1, muted: false,
      fadeIn: 0, fadeOut: 0, rotation: 0, flip: 'none',
      opacity: 1, scaleMode: 'fit', zoom: 1,
      filters: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, blur: 0, vignette: 0 },
      transition: { type: 'none', duration: 0.5 },
      groupId: null,
      text: { text: 'Your text', fontFamily: 'Poppins', fontSize: 64, fontWeight: 700, color: '#ffffff', align: 'center', x: 50, y: 50, bgColor: '', animIn: 'fade', animOut: 'fade' },
      keyframes: [],
    };
  }

  /* ---------------- Preview player (approximate; FFmpeg is the truth) ---------------- */
  function cssFilter(clip) {
    const f = clip.filters || {};
    const parts = [];
    if (f.brightness) parts.push(`brightness(${1 + f.brightness})`);
    if (f.contrast) parts.push(`contrast(${1 + f.contrast})`);
    if (f.saturation) parts.push(`saturate(${1 + f.saturation})`);
    if (f.blur) parts.push(`blur(${f.blur}px)`);
    return parts.join(' ');
  }
  function cssTransform(clip) {
    const parts = [];
    if (clip.flip === 'h') parts.push('scaleX(-1)');
    else if (clip.flip === 'v') parts.push('scaleY(-1)');
    if (clip.rotation) parts.push(`rotate(${clip.rotation}deg)`);
    if (clip.zoom && clip.zoom !== 1) parts.push(`scale(${clip.zoom})`);
    return parts.join(' ');
  }

  function setVideoEl(el, clip, t, muted) {
    if (!el || !clip) return;
    const url = `/api/media/${clip.mediaId}/file`;
    const local = (t - clip.start) / clip.speed;
    const target = clip.srcStart + local;
    if (el.dataset.media !== String(clip.mediaId)) {
      el.dataset.media = String(clip.mediaId);
      el.src = url;
      el.load();
      el.addEventListener('loadedmetadata', function once() {
        el.removeEventListener('loadedmetadata', once);
        try { el.currentTime = Math.max(0, Math.min(target, (el.duration || target) - 0.05)); } catch { /* ignore */ }
      });
    } else if (Math.abs(el.currentTime - target) > 0.35) {
      try { el.currentTime = Math.max(0, target); } catch { /* ignore */ }
    }
    try { el.playbackRate = clip.speed; } catch { /* ignore */ }
    el.volume = muted ? 0 : clip.volume;
    el.style.filter = cssFilter(clip);
    el.style.transform = cssTransform(clip);
    el.style.opacity = String(clip.opacity);
  }

  function updatePreview() {
    if (!ed) return;
    const tl = ed.timeline, t = ed.playhead;
    const stage = document.getElementById('ve-stage');
    if (!stage) return;
    const vA = document.getElementById('ve-va');
    const vB = document.getElementById('ve-vb');
    const audioEl = document.getElementById('ve-audio');
    const noclip = document.getElementById('ve-noclip');
    const vt = videoTrack(tl);
    const cur = clipAt(tl, 'video', t);
    const inTransition = cur && cur.clip.transition && cur.clip.transition.type !== 'none' &&
      t < cur.clip.start + cur.clip.transition.duration;
    let prev = null;
    if (inTransition && vt) {
      const sorted = [...vt.clips].sort((a, b) => a.start - b.start);
      const idx = sorted.findIndex((c) => c.id === cur.clip.id);
      if (idx > 0 && Math.abs(sorted[idx - 1].start + sorted[idx - 1].duration - cur.clip.start) < 0.01) prev = sorted[idx - 1];
    }
    if (cur) {
      noclip.style.display = 'none';
      vA.style.display = 'block';
      setVideoEl(vA, prev || cur.clip, t, vt.muted || (prev || cur.clip).muted);
      if (prev) {
        // Crossfade preview: A = outgoing clip, B = incoming clip fading in.
        setVideoEl(vB, cur.clip, t, vt.muted || cur.clip.muted);
        vB.style.display = 'block';
        vB.style.opacity = String(clamp((t - cur.clip.start) / cur.clip.transition.duration, 0, 1));
        vA.style.opacity = String(1 - clamp((t - cur.clip.start) / cur.clip.transition.duration, 0, 1));
      } else {
        vB.style.display = 'none';
      }
      if (ed.playing) { vA.play().catch(() => {}); if (prev) vB.play().catch(() => {}); }
      else { vA.pause(); vB.pause(); }
    } else {
      vA.style.display = 'none'; vB.style.display = 'none';
      noclip.style.display = 'flex';
    }
    // Audio-only playback when no video clip is under the playhead.
    const ac = clipAt(tl, 'audio', t);
    if (audioEl) {
      if (!cur && ac && !ac.track.muted && !ac.clip.muted) {
        const url = `/api/media/${ac.clip.mediaId}/file`;
        if (audioEl.dataset.media !== String(ac.clip.mediaId)) { audioEl.dataset.media = String(ac.clip.mediaId); audioEl.src = url; }
        const target = ac.clip.srcStart + (t - ac.clip.start) / ac.clip.speed;
        if (Math.abs(audioEl.currentTime - target) > 0.4) { try { audioEl.currentTime = Math.max(0, target); } catch { /* ignore */ } }
        audioEl.volume = ac.clip.volume;
        if (ed.playing) audioEl.play().catch(() => {}); else audioEl.pause();
      } else audioEl.pause();
    }
    // Text overlays.
    const ov = document.getElementById('ve-textov');
    if (ov) {
      const stageW = stage.clientWidth || 640;
      const scale = stageW / tl.width;
      const active = [];
      for (const tr of tl.tracks.filter((x) => x.kind === 'text')) {
        for (const c of tr.clips) {
          if (t >= c.start && t < c.start + c.duration) active.push(c);
        }
      }
      ov.innerHTML = active.map((c) => {
        const tx = c.text || {};
        let op = 1;
        const rel = t - c.start;
        if (tx.animIn === 'fade' && rel < 0.4) op = Math.min(op, rel / 0.4);
        if (tx.animOut === 'fade' && c.duration - rel < 0.4) op = Math.min(op, (c.duration - rel) / 0.4);
        let slide = '';
        if (tx.animIn === 'slide' && rel < 0.4) slide = `transform:translateX(${Math.round(-120 * (1 - rel / 0.4))}px);`;
        const left = tx.align === 'center' ? '50%' : tx.align === 'right' ? 'auto' : `${tx.x}%`;
        const right = tx.align === 'right' ? `${100 - tx.x}%` : 'auto';
        const trX = tx.align === 'center' ? 'translateX(-50%)' : 'none';
        return `<div class="ve-textov" style="left:${left};right:${right};top:${tx.y}%;transform:${trX};${slide}opacity:${op.toFixed(2)};` +
          `font-family:${esc(tx.fontFamily)};font-size:${Math.round(tx.fontSize * scale)}px;font-weight:${tx.fontWeight};color:${esc(tx.color)};` +
          `${tx.bgColor ? `background:${esc(tx.bgColor)};padding:4px 10px;border-radius:6px;` : ''}">${esc(tx.text)}</div>`;
      }).join('');
    }
    const timeEl = document.getElementById('ve-time');
    if (timeEl) timeEl.textContent = `${fmtT(t)} / ${fmtT(totalDuration(tl))}`;
    const ph = document.getElementById('ve-playhead');
    if (ph) ph.style.left = `calc(92px + ${t * ed.pxPerSec}px)`;
  }

  function tickLoop() {
    if (!ed || !ed.playing) return;
    const now = performance.now();
    const dt = (now - ed.lastTick) / 1000;
    ed.lastTick = now;
    ed.playhead += dt;
    const total = totalDuration(ed.timeline);
    if (ed.playhead >= total) {
      ed.playhead = total;
      ed.playing = false;
      const btn = document.getElementById('ve-play');
      if (btn) btn.textContent = '▶ Play';
    }
    updatePreview();
    if (ed.playing) requestAnimationFrame(tickLoop);
  }
  function setPlaying(on) {
    if (!ed) return;
    if (on && ed.playhead >= totalDuration(ed.timeline) - 0.01) ed.playhead = 0;
    ed.playing = on;
    ed.lastTick = performance.now();
    const btn = document.getElementById('ve-play');
    if (btn) btn.textContent = on ? '⏸ Pause' : '▶ Play';
    if (on) requestAnimationFrame(tickLoop);
    updatePreview();
  }

  /* ---------------- Timeline rendering + interaction ---------------- */
  function renderTimeline() {
    if (!ed) return;
    const tl = ed.timeline;
    const host = document.getElementById('ve-timeline');
    if (!host) return;
    const total = Math.max(5, totalDuration(tl));
    const width = Math.ceil(total * ed.pxPerSec) + 40;
    const ticks = [];
    for (let s = 0; s <= total; s += 1) {
      ticks.push(`<div class="ve-tick" style="left:${s * ed.pxPerSec}px">${fmtT(s)}</div>`);
    }
    const tracksHtml = tl.tracks.map((tr) => {
      const clips = [...tr.clips].sort((a, b) => a.start - b.start).map((c) => {
        const sel = ed.selectedClipId === c.id;
        const grouped = c.groupId ? ' grouped' : '';
        const locked = tr.locked ? ' locked' : '';
        return `<div class="ve-clip ${tr.kind}${sel ? ' selected' : ''}${grouped}${locked}" data-clip="${c.id}" ` +
          `style="left:${c.start * ed.pxPerSec}px;width:${Math.max(8, c.duration * ed.pxPerSec)}px" title="${esc(c.name)} — ${fmtT(c.start)} → ${fmtT(c.start + c.duration)}">` +
          `<span class="handle l" data-handle="l"></span><span class="clip-label">${esc(c.name)}</span><span class="handle r" data-handle="r"></span></div>`;
      }).join('');
      return `<div class="ve-track" data-track="${tr.id}">
        <div class="ve-track-head"><span class="nm">${esc(tr.name)} · ${tr.kind}</span>
          <span class="tb">
            <button data-lock="${tr.id}" class="${tr.locked ? 'on' : ''}" title="Lock track">${tr.locked ? '🔒' : '🔓'}</button>
            <button data-mute="${tr.id}" class="${tr.muted ? 'on' : ''}" title="Mute track">${tr.muted ? '🔇' : '🔊'}</button>
          </span></div>
        <div class="ve-lane" data-lane="${tr.id}" style="width:${width}px">${clips}</div>
      </div>`;
    }).join('');
    const markers = (tl.markers || []).map((m, i) =>
      `<div class="ve-marker" data-marker="${i}" style="left:calc(92px + ${m.t * ed.pxPerSec}px)" title="${esc(m.label || '')} — ${fmtT(m.t)}">◆ ${esc(m.label || '')}</div>`).join('');
    // Phase 5: beat ruler — cyan ticks on the beat grid, amber on downbeats,
    // orange on drops. Only shown when the project has a music sync.
    const ms = tl.musicSync;
    let beatRuler = '';
    if (ms && Array.isArray(ms.beats) && ms.beats.length) {
      const downs = new Set((ms.downbeats || []).map((b) => Number(b).toFixed(2)));
      const drops = new Set(((tl.markers || []).filter((m) => m.label === 'Drop')).map((m) => Number(m.t).toFixed(2)));
      const ticks = ms.beats.map((b) => {
        const key = Number(b).toFixed(2);
        const cls = drops.has(key) ? 'drop' : downs.has(key) ? 'down' : '';
        return `<div class="ve-beat-tick ${cls}" style="left:${b * ed.pxPerSec}px" title="Beat ${fmtT(b)}${drops.has(key) ? ' — DROP' : downs.has(key) ? ' — downbeat' : ''}"></div>`;
      }).join('');
      beatRuler = `<div class="ve-beat-ruler" title="Beat grid — ${ms.bpm} BPM, ${esc(ms.trackName || '')}" style="width:${width}px">${ticks}</div>`;
    }
    host.innerHTML = `
      <div class="ve-ruler" id="ve-ruler" style="width:${width + 92}px">${ticks.join('')}</div>
      ${beatRuler}
      <div style="position:relative;overflow-x:auto">
        <div style="position:relative;min-width:${width + 92}px">
          ${markers}
          ${tracksHtml}
          <div class="ve-playhead" id="ve-playhead" style="left:calc(92px + ${ed.playhead * ed.pxPerSec}px)"></div>
        </div>
      </div>`;
    host.querySelector('#ve-ruler').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      ed.playhead = clamp((e.clientX - rect.left) / ed.pxPerSec, 0, total);
      updatePreview();
    });
    host.querySelectorAll('[data-lock]').forEach((b) => b.addEventListener('click', () => {
      const tr = ed.timeline.tracks.find((x) => x.id === b.dataset.lock);
      if (tr) { ed.pushHistory(); tr.locked = !tr.locked; ed.saveSoon(); renderAll(); }
    }));
    host.querySelectorAll('[data-mute]').forEach((b) => b.addEventListener('click', () => {
      const tr = ed.timeline.tracks.find((x) => x.id === b.dataset.mute);
      if (tr) { ed.pushHistory(); tr.muted = !tr.muted; ed.saveSoon(); renderAll(); updatePreview(); }
    }));
    host.querySelectorAll('[data-marker]').forEach((m) => m.addEventListener('click', () => {
      ed.playhead = ed.timeline.markers[parseInt(m.dataset.marker, 10)].t;
      updatePreview();
    }));
    host.querySelectorAll('.ve-clip').forEach((el) => {
      el.addEventListener('pointerdown', (e) => onClipPointerDown(e, el));
      el.addEventListener('click', (e) => {
        if (e.detail === 1) { ed.selectedClipId = el.dataset.clip; renderAll(); }
      });
    });
  }

  function snapTime(t, track, excludeId) {
    let best = t, bestD = 8 / ed.pxPerSec;
    // v2.3.0 — magnetic timeline: when the Magnet toggle is off, clip
    // edges do NOT snap (free placement); beat snap keeps its own toggle.
    if (ed.magnet !== false) {
      const candidates = [ed.playhead];
      for (const tr of ed.timeline.tracks) {
        if (tr.id !== track.id) continue;
        for (const c of tr.clips) {
          if (c.id === excludeId) continue;
          candidates.push(c.start, c.start + c.duration);
        }
      }
      for (const cand of candidates) {
        const d = Math.abs(cand - t);
        if (d < bestD) { best = cand; bestD = d; }
      }
    }
    // Phase 5: beat-snap — when a synced track is attached and the toggle
    // is on, clip edges also snap to the nearest beat (within 0.12 s).
    // Beats never override a closer clip edge or the playhead.
    if (ed.beatSnap !== false && ed.timeline.musicSync && Array.isArray(ed.timeline.musicSync.beats)) {
      for (const b of ed.timeline.musicSync.beats) {
        const d = Math.abs(b - t);
        if (d <= 0.12 && d < bestD) { best = b; bestD = d; }
      }
    }
    return best;
  }

  function overlaps(track, clip, start, duration) {
    return track.clips.some((c) => c.id !== clip.id &&
      start < c.start + c.duration - 1e-6 && start + duration > c.start + 1e-6);
  }

  function onClipPointerDown(e, el) {
    if (e.button !== 0) return;
    const found = findClip(ed.timeline, el.dataset.clip);
    if (!found) return;
    const { clip, track } = found;
    if (track.locked) { toast('This track is locked. Unlock it to edit clips.', true); return; }
    e.preventDefault();
    ed.selectedClipId = clip.id;
    renderAll();
    const handle = e.target.dataset.handle || null;
    const startX = e.clientX;
    const orig = deep(clip);
    const group = clip.groupId ? allClips(ed.timeline).filter((x) => x.clip.groupId === clip.groupId).map((x) => x.clip) : [clip];
    const groupOrig = group.map((c) => ({ id: c.id, start: c.start, duration: c.duration, srcStart: c.srcStart }));
    let moved = false;
    const onMove = (ev) => {
      const dxSec = (ev.clientX - startX) / ed.pxPerSec;
      if (!moved && Math.abs(ev.clientX - startX) > 2) {
        // Snapshot the pre-drag timeline once, before the first mutation,
        // so Undo restores the position before the drag.
        pushHistory();
        moved = true;
      }
      if (!moved) return;
      if (handle === 'l') {
        const ns = clamp(orig.start + dxSec, 0, orig.start + orig.duration - 0.05);
        const d = ns - orig.start;
        clip.start = ns;
        clip.srcStart = Math.max(0, orig.srcStart + d * clip.speed);
        clip.duration = orig.duration - d;
      } else if (handle === 'r') {
        clip.duration = Math.max(0.05, orig.duration + dxSec);
      } else {
        const ns = snapTime(Math.max(0, orig.start + dxSec), track, clip.id);
        const delta = ns - orig.start;
        for (const g of group) {
          const o = groupOrig.find((x) => x.id === g.id);
          g.start = Math.max(0, o.start + delta);
        }
      }
      renderTimeline();
      updatePreview();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (!moved) return;
      // Validate: no overlaps on the same track; otherwise revert.
      let bad = false;
      for (const g of group) {
        const tr = ed.timeline.tracks.find((t) => t.clips.some((c) => c.id === g.id));
        if (tr && overlaps(tr, g, g.start, g.duration)) bad = true;
      }
      if (bad) {
        for (const o of groupOrig) {
          const f = findClip(ed.timeline, o.id);
          if (f) { f.clip.start = o.start; f.clip.duration = o.duration; f.clip.srcStart = o.srcStart; }
        }
        toast('Clips on one track cannot overlap — change reverted.', true);
        renderAll();
        return;
      }
      ed.saveSoon();
      renderAll();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  /* ---------------- History / save ---------------- */
  function pushHistory() {
    ed.undoStack.push(JSON.stringify(ed.timeline));
    if (ed.undoStack.length > 50) ed.undoStack.shift();
    ed.redoStack = [];
  }
  function doUndo() {
    if (!ed.undoStack.length) return;
    ed.redoStack.push(JSON.stringify(ed.timeline));
    ed.timeline = JSON.parse(ed.undoStack.pop());
    ed.selectedClipId = null;
    ed.saveSoon();
    renderAll();
  }
  function doRedo() {
    if (!ed.redoStack.length) return;
    ed.undoStack.push(JSON.stringify(ed.timeline));
    ed.timeline = JSON.parse(ed.redoStack.pop());
    ed.selectedClipId = null;
    ed.saveSoon();
    renderAll();
  }
  function saveTimeline(saveVersion) {
    if (!ed) return;
    const body = { content: { timeline: ed.timeline } };
    if (saveVersion) body.saveVersion = true;
    return api(`/api/projects/${ed.project.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      .then(() => { const s = document.getElementById('ve-save-state'); if (s) { s.textContent = 'Saved ✓'; s.className = 'badge ok'; } })
      .catch((e) => { const s = document.getElementById('ve-save-state'); if (s) { s.textContent = 'Save failed'; s.className = 'badge err'; } toast(e.message, true); });
  }
  function saveSoon() {
    const s = document.getElementById('ve-save-state');
    if (s) { s.textContent = 'Unsaved changes…'; s.className = 'badge warn'; }
    clearTimeout(ed.saveTimer);
    ed.saveTimer = setTimeout(() => saveTimeline(false), 800);
  }

  function renderAll() {
    renderTimeline();
    renderProps();
    updatePreview();
  }

  /* ---------------- Right panel: clip properties / keyframes / export ---------------- */
  function field(label, inner) {
    return `<label>${label}</label>${inner}`;
  }
  function numInput(id, val, step, min, max) {
    return `<input type="number" id="${id}" value="${val}" step="${step || 0.1}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''}>`;
  }
  function slider(id, val, min, max, step) {
    return `<input type="range" id="${id}" value="${val}" min="${min}" max="${max}" step="${step}"> <span id="${id}-v">${val}</span>`;
  }

  function renderProps() {
    if (!ed) return;
    const host = document.getElementById('ve-props');
    if (!host) return;
    const tab = ed.propsTab;
    if (tab === 'export') return renderExportTab(host);
    const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
    if (tab === 'keyframes') return renderKeyframesTab(host, found);
    if (!found) {
      host.innerHTML = `<h3>Clip properties</h3><p class="sub">Select a clip on the timeline to edit its properties, filters, transition and keyframes.</p>
        <p class="sub" style="margin-top:10px">Timeline: ${ed.timeline.width}×${ed.timeline.height} @ ${ed.timeline.fps}fps · ${fmtT(totalDuration(ed.timeline))} total · ${(ed.timeline.markers || []).length} marker(s)</p>`;
      return;
    }
    const { clip } = found;
    const f = clip.filters || {};
    const isText = clip.kind === 'text';
    const tx = clip.text || {};
    host.innerHTML = `<h3>Clip properties</h3>
      <div class="ve-props">
      ${field('Name', `<input type="text" id="cp-name" value="${esc(clip.name)}">`)}
      <div class="ve-row">
        <div>${field('Start (s)', numInput('cp-start', clip.start, 0.05, 0))}</div>
        <div>${field('Duration (s)', numInput('cp-duration', clip.duration, 0.05, 0.05))}</div>
      </div>
      ${clip.kind !== 'text' ? `<div class="ve-row">
        <div>${field('Source in-point (s)', numInput('cp-src', clip.srcStart, 0.05, 0))}</div>
        <div>${field('Speed', numInput('cp-speed', clip.speed, 0.05, 0.25, 4))}</div>
      </div>` : ''}
      <div class="ve-row">
        <div>${field('Volume', slider('cp-volume', clip.volume, 0, 1, 0.05))}</div>
        <div>${field('Opacity', slider('cp-opacity', clip.opacity, 0, 1, 0.05))}</div>
      </div>
      <div class="ve-row">
        <div>${field('Fade in (s)', numInput('cp-fadein', clip.fadeIn, 0.1, 0, 5))}</div>
        <div>${field('Fade out (s)', numInput('cp-fadeout', clip.fadeOut, 0.1, 0, 5))}</div>
      </div>
      ${clip.kind === 'video' ? `
      <div class="ve-row">
        <div>${field('Rotation', `<select id="cp-rotation">${[0, 90, 180, 270].map((r) => `<option value="${r}" ${clip.rotation === r ? 'selected' : ''}>${r}°</option>`).join('')}</select>`)}</div>
        <div>${field('Flip', `<select id="cp-flip">${['none', 'h', 'v'].map((v) => `<option ${clip.flip === v ? 'selected' : ''}>${v === 'none' ? 'None' : v === 'h' ? 'Horizontal' : 'Vertical'}</option>`).join('')}</select>`)}</div>
      </div>
      <div class="ve-row">
        <div>${field('Scale mode', `<select id="cp-scale">${['fit', 'fill'].map((v) => `<option ${clip.scaleMode === v ? 'selected' : ''}>${v === 'fit' ? 'Fit (letterbox)' : 'Fill (crop)'}</option>`).join('')}</select>`)}</div>
        <div>${field('Zoom', slider('cp-zoom', clip.zoom, 0.5, 3, 0.1))}</div>
      </div>
      <div class="ve-row">
        <div>${field('Transition into this clip', `<select id="cp-trans">${['none', 'fade', 'dissolve', 'slide', 'wipe'].map((v) => `<option value="${v}" ${clip.transition.type === v ? 'selected' : ''}>${v === 'none' ? 'None (hard cut)' : v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select>`)}</div>
        <div>${field('Transition (s)', numInput('cp-transdur', clip.transition.duration, 0.1, 0.1, 2))}</div>
      </div>
      <p class="sub">Transitions render with FFmpeg xfade between adjacent clips on the same track. A transition shortens the total by its duration.</p>` : ''}
      ${isText ? `
      ${field('Text', `<textarea id="cp-text" rows="2">${esc(tx.text)}</textarea>`)}
      <div class="ve-row">
        <div>${field('Font size', numInput('cp-fontsize', tx.fontSize, 1, 8, 400))}</div>
        <div>${field('Colour', `<input type="color" id="cp-color" value="${esc(tx.color || '#ffffff')}">`)}</div>
      </div>
      <div class="ve-row">
        <div>${field('Align', `<select id="cp-align">${['left', 'center', 'right'].map((v) => `<option ${tx.align === v ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
        <div>${field('Weight', `<select id="cp-weight">${[400, 700, 800].map((v) => `<option ${tx.fontWeight === v ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
      </div>
      <div class="ve-row">
        <div>${field('X (%)', numInput('cp-x', tx.x, 1, 0, 100))}</div>
        <div>${field('Y (%)', numInput('cp-y', tx.y, 1, 0, 100))}</div>
      </div>
      <div class="ve-row">
        <div>${field('Animate in', `<select id="cp-animin">${['none', 'fade', 'slide'].map((v) => `<option ${tx.animIn === v ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
        <div>${field('Animate out', `<select id="cp-animout">${['none', 'fade', 'slide'].map((v) => `<option ${tx.animOut === v ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
      </div>
      <div class="ve-row">
        <div>${field('Background', `<input type="color" id="cp-bg" value="${esc(tx.bgColor || '#000000')}"> <label style="display:inline"><input type="checkbox" id="cp-bg-on" ${tx.bgColor ? 'checked' : ''}> show</label>`)}</div>
      </div>` : ''}
      <h3 style="margin-top:14px">Colour &amp; filters</h3>
      ${['brightness', 'contrast', 'saturation', 'temperature', 'sharpness', 'blur', 'vignette'].map((k) => {
        const def = { brightness: [-1, 1, 0.05], contrast: [-1, 1, 0.05], saturation: [-1, 2, 0.05], temperature: [-1, 1, 0.05], sharpness: [0, 1, 0.05], blur: [0, 10, 0.5], vignette: [0, 1, 0.05] }[k];
        return field(k[0].toUpperCase() + k.slice(1), slider(`cp-f-${k}`, f[k] ?? 0, def[0], def[1], def[2]));
      }).join('')}
      <p class="sub" style="margin-top:8px">Filters apply to the preview and to the FFmpeg render.</p>
      </div>`;
    const $ = (id) => document.getElementById(id);
    const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('change', fn); };
    const bindLive = (id, fn) => {
      const el = $(id);
      if (!el) return;
      // Snapshot before the drag starts so Undo restores the old value.
      el.addEventListener('focus', () => pushHistory());
      el.addEventListener('input', () => { const v = document.getElementById(id + '-v'); if (v) v.textContent = el.value; fn(parseFloat(el.value)); });
      el.addEventListener('change', () => { saveSoon(); renderTimeline(); updatePreview(); });
    };
    const mutate = (fn) => { pushHistory(); fn(); saveSoon(); renderTimeline(); updatePreview(); };
    bind('cp-name', (e) => mutate(() => { clip.name = e.target.value; }));
    bind('cp-start', (e) => mutate(() => { clip.start = Math.max(0, parseFloat(e.target.value) || 0); }));
    bind('cp-duration', (e) => mutate(() => { clip.duration = Math.max(0.05, parseFloat(e.target.value) || clip.duration); }));
    bind('cp-src', (e) => mutate(() => { clip.srcStart = Math.max(0, parseFloat(e.target.value) || 0); }));
    bind('cp-speed', (e) => mutate(() => { clip.speed = clamp(parseFloat(e.target.value) || 1, 0.25, 4); }));
    bindLive('cp-volume', (v) => { clip.volume = v; updatePreview(); });
    bindLive('cp-opacity', (v) => { clip.opacity = v; updatePreview(); });
    bind('cp-fadein', (e) => mutate(() => { clip.fadeIn = Math.max(0, parseFloat(e.target.value) || 0); }));
    bind('cp-fadeout', (e) => mutate(() => { clip.fadeOut = Math.max(0, parseFloat(e.target.value) || 0); }));
    bind('cp-rotation', (e) => mutate(() => { clip.rotation = parseInt(e.target.value, 10); }));
    bind('cp-flip', (e) => mutate(() => { clip.flip = e.target.value; }));
    bind('cp-scale', (e) => mutate(() => { clip.scaleMode = e.target.value; }));
    bindLive('cp-zoom', (v) => { clip.zoom = v; updatePreview(); });
    bind('cp-trans', (e) => mutate(() => { clip.transition.type = e.target.value; }));
    bind('cp-transdur', (e) => mutate(() => { clip.transition.duration = clamp(parseFloat(e.target.value) || 0.5, 0.1, 2); }));
    bind('cp-text', (e) => mutate(() => { clip.text.text = e.target.value; }));
    bind('cp-fontsize', (e) => mutate(() => { clip.text.fontSize = clamp(parseInt(e.target.value, 10) || 64, 8, 400); }));
    bind('cp-color', (e) => mutate(() => { clip.text.color = e.target.value; }));
    bind('cp-align', (e) => mutate(() => { clip.text.align = e.target.value; }));
    bind('cp-weight', (e) => mutate(() => { clip.text.fontWeight = parseInt(e.target.value, 10); }));
    bind('cp-x', (e) => mutate(() => { clip.text.x = clamp(parseFloat(e.target.value) || 50, 0, 100); }));
    bind('cp-y', (e) => mutate(() => { clip.text.y = clamp(parseFloat(e.target.value) || 50, 0, 100); }));
    bind('cp-animin', (e) => mutate(() => { clip.text.animIn = e.target.value; }));
    bind('cp-animout', (e) => mutate(() => { clip.text.animOut = e.target.value; }));
    bind('cp-bg', (e) => mutate(() => { clip.text.bgColor = document.getElementById('cp-bg-on').checked ? e.target.value : ''; }));
    bind('cp-bg-on', (e) => mutate(() => { clip.text.bgColor = e.target.checked ? document.getElementById('cp-bg').value : ''; }));
    for (const k of ['brightness', 'contrast', 'saturation', 'temperature', 'sharpness', 'blur', 'vignette']) {
      bindLive(`cp-f-${k}`, (v) => { clip.filters[k] = v; updatePreview(); });
    }
  }

  function renderKeyframesTab(host, found) {
    if (!found || found.clip.kind === 'audio') {
      host.innerHTML = `<h3>Keyframes</h3><p class="sub">Select a video or text clip to animate it. Keyframes interpolate position, scale and opacity linearly between points.</p>`;
      return;
    }
    const { clip } = found;
    const kfs = [...(clip.keyframes || [])].sort((a, b) => a.t - b.t);
    host.innerHTML = `<h3>Keyframes — ${esc(clip.name)}</h3>
      <p class="sub">Position (%), scale (0.5–3) and opacity (0–1) interpolate linearly between keyframes. Rendered with FFmpeg (pan via crop, zoom via sampled segments, opacity via per-frame alpha). At least 2 keyframes make a visible animation.</p>
      <div style="margin:10px 0"><button class="btn btn-sm btn-primary" id="kf-add">＋ Add keyframe at playhead (${fmtT(Math.max(0, ed.playhead - clip.start))} in clip)</button></div>
      ${kfs.length ? kfs.map((k, i) => `
        <div class="ve-kf">
          <div class="ve-row">
            <div><label>Time (s)</label><input type="number" data-kf="${i}" data-f="t" value="${k.t}" step="0.1" min="0" max="${clip.duration}"></div>
            <div><label>X %</label><input type="number" data-kf="${i}" data-f="x" value="${k.x ?? 50}" step="1" min="0" max="100"></div>
          </div>
          <div class="ve-row">
            <div><label>Y %</label><input type="number" data-kf="${i}" data-f="y" value="${k.y ?? 50}" step="1" min="0" max="100"></div>
            <div><label>Scale</label><input type="number" data-kf="${i}" data-f="scale" value="${k.scale ?? 1}" step="0.1" min="0.5" max="3"></div>
          </div>
          <div class="ve-row">
            <div><label>Opacity</label><input type="number" data-kf="${i}" data-f="opacity" value="${k.opacity ?? 1}" step="0.05" min="0" max="1"></div>
            <div><label>&nbsp;</label><button class="btn btn-sm btn-danger" data-kf-del="${i}" style="width:100%">Delete</button></div>
          </div>
        </div>`).join('') : '<p class="sub">No keyframes yet — the clip plays at its base position/scale/opacity.</p>'}`;
    document.getElementById('kf-add').addEventListener('click', () => {
      const rel = clamp(ed.playhead - clip.start, 0, clip.duration);
      pushHistory();
      clip.keyframes = clip.keyframes || [];
      // Sample current interpolated values so the new keyframe holds the pose.
      const cur = sampleKeyframe(clip, rel);
      clip.keyframes.push({ t: Math.round(rel * 100) / 100, x: cur.x, y: cur.y, scale: cur.scale, opacity: cur.opacity });
      clip.keyframes.sort((a, b) => a.t - b.t);
      saveSoon(); renderAll();
    });
    host.querySelectorAll('[data-kf]').forEach((el) => el.addEventListener('change', () => {
      pushHistory();
      const k = clip.keyframes[parseInt(el.dataset.kf, 10)];
      const v = parseFloat(el.value);
      if (el.dataset.f === 't') k.t = clamp(v || 0, 0, clip.duration);
      else if (el.dataset.f === 'x' || el.dataset.f === 'y') k[el.dataset.f] = clamp(v, 0, 100);
      else if (el.dataset.f === 'scale') k.scale = clamp(v || 1, 0.5, 3);
      else if (el.dataset.f === 'opacity') k.opacity = clamp(v, 0, 1);
      clip.keyframes.sort((a, b) => a.t - b.t);
      saveSoon(); renderAll();
    }));
    host.querySelectorAll('[data-kf-del]').forEach((el) => el.addEventListener('click', () => {
      pushHistory();
      clip.keyframes.splice(parseInt(el.dataset.kfDel, 10), 1);
      saveSoon(); renderAll();
    }));
  }

  function sampleKeyframe(clip, time) {
    const out = { x: 50, y: 50, scale: 1, opacity: 1 };
    const kfs = [...(clip.keyframes || [])].sort((a, b) => a.t - b.t);
    if (!kfs.length) return out;
    for (const p of ['x', 'y', 'scale', 'opacity']) {
      const def = kfs.filter((k) => k[p] !== undefined);
      if (!def.length) continue;
      if (time <= def[0].t) { out[p] = def[0][p]; continue; }
      if (time >= def[def.length - 1].t) { out[p] = def[def.length - 1][p]; continue; }
      for (let i = 0; i < def.length - 1; i++) {
        const a = def[i], b = def[i + 1];
        if (time >= a.t && time <= b.t) { out[p] = a[p] + (b[p] - a[p]) * ((time - a.t) / (b.t - a.t || 1)); break; }
      }
    }
    return out;
  }

  /* ---------------- Export tab (real FFmpeg jobs) ---------------- */
  function renderExportTab(host) {
    const job = ed.currentJob;
    host.innerHTML = `<h3>Export — FFmpeg render</h3>
      <p class="sub">Renders the real timeline to a playable MP4 (libx264 + AAC). Progress comes from FFmpeg itself — no simulated bars.</p>
      <label>Resolution</label>
      <select id="ex-res"><option value="720p">720p HD</option><option value="1080p">1080p Full HD</option></select>
      <label>Frame rate</label>
      <select id="ex-fps"><option value="24">24 fps</option><option value="30" selected>30 fps</option><option value="60">60 fps</option></select>
      <p class="sub" style="margin-top:8px">Output: ${ed.timeline.width}×${ed.timeline.height} aspect · ${fmtT(totalDuration(ed.timeline))} long (transitions shorten it) · ${ed.timeline.fps}fps timeline</p>
      <div style="margin:12px 0"><button class="btn btn-primary" id="ex-render" style="width:100%;justify-content:center">▶ Render video</button></div>
      <div class="error" id="ex-error"></div>
      <div id="ex-job">${job ? jobHtml(job) : '<p class="sub">No render yet for this session. Finished renders also appear in the Export Center.</p>'}</div>`;
    document.getElementById('ex-render').addEventListener('click', async () => {
      const errBox = document.getElementById('ex-error');
      errBox.style.display = 'none';
      try {
        await saveTimeline(false);
        const r = await api('/api/video/jobs', {
          method: 'POST',
          body: JSON.stringify({
            projectId: ed.project.id,
            settings: {
              resolution: document.getElementById('ex-res').value,
              fps: parseInt(document.getElementById('ex-fps').value, 10),
            },
          }),
        });
        ed.currentJob = r.job;
        toast('Render queued — progress shows below and in the Export Center.');
        renderProps();
        pollJob(r.job.id);
      } catch (e) {
        errBox.textContent = e.message;
        errBox.style.display = 'block';
      }
    });
    const cur = document.getElementById('ex-job');
    if (cur) bindJobButtons(cur);
  }

  function jobHtml(job) {
    const badge = { queued: 'warn', running: '', done: 'ok', failed: 'err', cancelled: 'err' }[job.status] || '';
    return `<div class="ve-job">
      <div><b>Job #${job.id}</b> <span class="badge ${badge}">${job.status}</span> <span style="float:right">${job.progress}%</span></div>
      <div class="ve-progress"><div style="width:${job.progress}%"></div></div>
      <div class="sub">${esc(job.settings.resolution || '')} · ${esc(String(job.settings.fps || ''))}fps</div>
      ${job.error ? `<div class="error" style="display:block">${esc(job.error)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        ${job.status === 'done' && job.hasOutput ? `<a class="btn btn-sm btn-primary" href="/api/video/jobs/${job.id}/download">⬇ Download MP4</a>` : ''}
        ${['queued', 'running'].includes(job.status) ? `<button class="btn btn-sm btn-danger" data-cancel-job="${job.id}">Cancel</button>` : ''}
        ${['failed', 'cancelled'].includes(job.status) ? `<button class="btn btn-sm" data-retry-job="${job.id}">Retry</button>` : ''}
        ${job.status === 'done' ? `<button class="btn btn-sm" data-save-lib="${job.id}">Save to Media Library</button>` : ''}
        <button class="btn btn-sm btn-ghost" data-job-log="${job.id}">View log</button>
      </div>
      <div id="job-log-${job.id}"></div>
    </div>`;
  }

  function bindJobButtons(scope) {
    scope.querySelectorAll('[data-cancel-job]').forEach((b) => b.addEventListener('click', async () => {
      try { const r = await api(`/api/video/jobs/${b.dataset.cancelJob}/cancel`, { method: 'POST' }); ed.currentJob = r.job; toast('Cancel requested.'); renderProps(); }
      catch (e) { toast(e.message, true); }
    }));
    scope.querySelectorAll('[data-retry-job]').forEach((b) => b.addEventListener('click', async () => {
      try { const r = await api(`/api/video/jobs/${b.dataset.retryJob}/retry`, { method: 'POST' }); ed.currentJob = r.job; toast('Render re-queued.'); renderProps(); pollJob(r.job.id); }
      catch (e) { toast(e.message, true); }
    }));
    scope.querySelectorAll('[data-save-lib]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/video/jobs/${b.dataset.saveLib}/save-to-library`, { method: 'POST' }); toast('Saved to Media Library.'); }
      catch (e) { toast(e.message, true); }
    }));
    scope.querySelectorAll('[data-job-log]').forEach((b) => b.addEventListener('click', async () => {
      const box = document.getElementById(`job-log-${b.dataset.jobLog}`);
      if (!box) return;
      if (box.innerHTML) { box.innerHTML = ''; return; }
      try {
        const r = await api(`/api/video/jobs/${b.dataset.jobLog}/log`);
        box.innerHTML = `<div class="ve-log">${esc((r.log || '(log is empty)') + (r.error ? `\nERROR: ${r.error}` : ''))}</div>`;
      } catch (e) { box.innerHTML = `<div class="error" style="display:block">${esc(e.message)}</div>`; }
    }));
  }

  async function pollJob(jobId) {
    if (!ed) return;
    clearTimeout(ed.pollTimer);
    try {
      const { job } = await api(`/api/video/jobs/${jobId}`);
      ed.currentJob = job;
      if (ed.propsTab === 'export') renderProps();
      if (job.status === 'queued' || job.status === 'running') {
        ed.pollTimer = setTimeout(() => pollJob(jobId), 1500);
      } else if (job.status === 'done') {
        toast('Render finished — download it from the Export tab or Export Center.');
      } else if (job.status === 'failed') {
        toast(`Render failed: ${job.error || 'see the job log'}`, true);
      }
    } catch (e) { /* job may have been deleted; stop polling */ }
  }

  /* ---------------- Left panel ---------------- */
  async function renderLeftPanel() {
    const host = document.getElementById('ve-left');
    if (!host) return;
    const tab = ed.leftTab;
    let body = '';
    if (tab === 'media') {
      let media = { media: [] };
      try { media = await api('/api/media?kind=video'); } catch { /* ignore */ }
      const items = media.media;
      body = `<p class="sub">Click a video to add it at the playhead on the video track. Audio lives in the Audio tab.</p>
        <button class="btn btn-sm" id="ve-upload-media" style="margin-bottom:10px">⬆ Upload media</button>
        <input type="file" id="ve-media-file" accept="video/*" style="display:none">
        ${items.length ? items.map((m) => `
          <div class="ve-media-item" data-add-media="${m.id}">
            ${m.thumbnailUrl ? `<img src="${m.thumbnailUrl}" alt="">` : `<span style="font-size:22px">🎬</span>`}
            <div><div class="nm">${esc(m.originalName)}</div>
            <div class="mt">${m.kind}${m.durationSeconds ? ` · ${m.durationSeconds.toFixed(1)}s` : ''}${m.width ? ` · ${m.width}×${m.height}` : ''}${m.fps ? ` · ${m.fps}fps` : ''}</div></div>
          </div>`).join('') : '<p class="sub">No video in your library yet. Upload some first.</p>'}`;
      host.innerHTML = body;
      const fi = document.getElementById('ve-media-file');
      document.getElementById('ve-upload-media').addEventListener('click', () => fi.click());
      fi.addEventListener('change', async () => {
        if (!fi.files.length) return;
        const fd = new FormData();
        fd.append('file', fi.files[0]);
        try {
          await apiForm('/api/media/upload', fd);
          toast('Uploaded. Probing duration/size…');
          renderLeftPanel();
        } catch (e) { toast(e.message, true); }
      });
      host.querySelectorAll('[data-add-media]').forEach((el) => el.addEventListener('click', async () => {
        const m = media.media.find((x) => String(x.id) === el.dataset.addMedia);
        if (!m) return;
        addMediaClip(m);
      }));
    } else if (tab === 'audio') {
      let audio = { media: [] };
      try { audio = await api('/api/media?kind=audio'); } catch { /* ignore */ }
      const items = audio.media;
      body = `<p class="sub">Click an audio file to add it at the playhead on the audio track. Volume and fades are set per clip in the right panel.</p>
        <button class="btn btn-sm" id="ve-upload-audio" style="margin-bottom:10px">⬆ Upload audio</button>
        <input type="file" id="ve-audio-file" accept="audio/*" style="display:none">
        ${items.length ? items.map((m) => `
          <div class="ve-media-item" data-add-media="${m.id}">
            <span style="font-size:22px">🎵</span>
            <div><div class="nm">${esc(m.originalName)}</div>
            <div class="mt">audio${m.durationSeconds ? ` · ${m.durationSeconds.toFixed(1)}s` : ''}</div></div>
          </div>`).join('') : '<p class="sub">No audio in your library yet. Upload some first — your own music or voice recordings.</p>'}`;
      host.innerHTML = body;
      const fi = document.getElementById('ve-audio-file');
      document.getElementById('ve-upload-audio').addEventListener('click', () => fi.click());
      fi.addEventListener('change', async () => {
        if (!fi.files.length) return;
        const fd = new FormData();
        fd.append('file', fi.files[0]);
        try {
          await apiForm('/api/media/upload', fd);
          toast('Uploaded. Probing duration…');
          renderLeftPanel();
        } catch (e) { toast(e.message, true); }
      });
      host.querySelectorAll('[data-add-media]').forEach((el) => el.addEventListener('click', async () => {
        const m = audio.media.find((x) => String(x.id) === el.dataset.addMedia);
        if (!m) return;
        addMediaClip(m);
      }));
    } else if (tab === 'effects') {
      let presets = { presets: [] };
      try { presets = await api('/api/magic/animate/presets'); } catch { /* ignore */ }
      const clipPresets = (presets.presets || []).filter((p) => (p.appliesTo || []).includes('clip'));
      body = `<p class="sub">Motion effects for clips. Text clips also get fade/slide in &amp; out — set those per text clip in the right panel (Clip tab).</p>
        ${clipPresets.length ? clipPresets.map((p) => `
          <div class="ve-media-item"><div><div class="nm">${esc(p.name)}</div>
          <div class="mt">${esc(p.description || '')} · ${p.durationMs}ms${p.loop ? ' · loops' : ''}</div></div></div>`).join('')
        : '<p class="sub">No clip presets available.</p>'}
        <p class="sub" style="margin-top:10px">Clip presets expand into real keyframes. Apply them from the Animation Studio, or add keyframes by hand in the right panel (Keyframes tab).</p>
        <button class="btn btn-sm" id="ve-effects-open" style="margin-top:6px">Open Animation Studio →</button>`;
      host.innerHTML = body;
      document.getElementById('ve-effects-open').addEventListener('click', () => go('animation'));
    } else if (tab === 'captions') {
      const textClips = [];
      for (const tr of ed.timeline.tracks.filter((t) => t.kind === 'text')) {
        for (const c of tr.clips) textClips.push({ clip: c, track: tr });
      }
      textClips.sort((a, b) => a.clip.start - b.clip.start);
      body = `<p class="sub">Text overlays on this timeline, in order. Click one to jump the playhead to it. Captions are text clips — style them in the right panel (Clip tab).</p>
        ${textClips.length ? textClips.map(({ clip }) => `
          <div class="ve-media-item" data-seek-clip="${clip.id}">
            <span style="font-size:22px">💬</span>
            <div><div class="nm">${esc((clip.text && clip.text.text) || clip.name || 'Text clip')}</div>
            <div class="mt">${fmtT(clip.start)} – ${fmtT(clip.start + clip.duration)} · ${(clip.text && clip.text.animIn) || 'fade'} in</div></div>
          </div>`).join('') : '<p class="sub">No text clips yet — add one from the Text tab.</p>'}
        <button class="btn btn-sm" id="ve-captions-open" style="margin-top:6px">Open Auto Captions →</button>`;
      host.innerHTML = body;
      host.querySelectorAll('[data-seek-clip]').forEach((el) => el.addEventListener('click', () => {
        const found = findClip(ed.timeline, el.dataset.seekClip);
        if (!found) return;
        ed.selectedClipId = found.clip.id;
        ed.playhead = found.clip.start;
        setPlaying(false);
        renderAll();
      }));
      document.getElementById('ve-captions-open').addEventListener('click', () => go('captions'));
    } else if (tab === 'filters') {
      let fx = { filters: [] };
      try { fx = await api('/api/video/effects'); } catch { /* ignore */ }
      body = `<p class="sub">Colour filters, per clip. Select a clip on the timeline, then move the sliders in the right panel (Clip tab → Colour &amp; filters). Filters apply to the preview and to the FFmpeg render.</p>
        ${(fx.filters || []).map((f) => `<div class="ve-media-item"><div><div class="nm">${esc(f.name)}</div><div class="mt">${f.min} to ${f.max}</div></div></div>`).join('') || '<p class="sub">No filters available.</p>'}`;
      host.innerHTML = body;
    } else if (tab === 'stickers') {
      body = `<div class="empty" style="margin-top:8px"><div class="big">🖼️</div>
        <p><b>Stickers are not in this editor yet.</b></p>
        <p style="margin-top:6px">Image overlays on video (stickers) are not built — the timeline takes video, audio and text clips. Add images, shapes and stickers to designs in the Graphic Editor instead.</p>
        <button class="btn btn-primary" id="ve-stickers-editor" style="margin-top:12px">Open Graphic Editor →</button></div>`;
      host.innerHTML = body;
      document.getElementById('ve-stickers-editor').addEventListener('click', () => go('graphic-editor'));
    } else if (tab === 'text') {
      body = `<p class="sub">Add a text overlay at the playhead, then style it in the right panel (font, colour, position, fade/slide animation).</p>
        <button class="btn btn-primary" id="ve-add-text" style="width:100%;justify-content:center">＋ Add text clip (3s)</button>
        <p class="sub" style="margin-top:12px">Text renders with FFmpeg drawtext — same font, size, colour and position as the preview.</p>`;
      host.innerHTML = body;
      document.getElementById('ve-add-text').addEventListener('click', () => {
        pushHistory();
        const tr = ed.timeline.tracks.find((t) => t.kind === 'text');
        const c = defaultClip('text', null, ed.playhead, 3);
        tr.clips.push(c);
        ed.selectedClipId = c.id;
        saveSoon(); renderAll();
      });
    } else if (tab === 'transitions') {
      let fx = { transitions: [] };
      try { fx = await api('/api/video/effects'); } catch { /* ignore */ }
      body = `<p class="sub">Transitions apply between adjacent clips on the same video track — pick a clip, then set its transition in the right panel.</p>
        ${fx.transitions.map((t) => `<div class="ve-media-item"><div><div class="nm">${esc(t.name)}</div><div class="mt">up to ${t.maxDuration}s · FFmpeg xfade (${esc(t.xfade)})</div></div></div>`).join('')}
        <p class="sub" style="margin-top:10px">Not in Phase 3: chroma key, stabilization, proxy editing — see Effects &amp; Transitions for the honest list.</p>`;
      host.innerHTML = body;
    }
  }

  function addMediaClip(m) {
    const tl = ed.timeline;
    const kind = m.kind === 'video' ? 'video' : 'audio';
    const tr = tl.tracks.find((t) => t.kind === kind);
    if (!tr) { toast(`No ${kind} track in this timeline.`, true); return; }
    if (tr.locked) { toast('This track is locked.', true); return; }
    const dur = m.durationSeconds ? Math.min(m.durationSeconds, 600) : 5;
    // Find the first free slot at/after the playhead on this track.
    let start = ed.playhead;
    const sorted = [...tr.clips].sort((a, b) => a.start - b.start);
    for (const c of sorted) {
      if (start < c.start + c.duration && start + dur > c.start) start = c.start + c.duration;
    }
    pushHistory();
    const clip = defaultClip(kind, m.id, start, dur);
    clip.name = m.originalName;
    if (kind === 'video' && m.durationSeconds) clip.duration = m.durationSeconds;
    tr.clips.push(clip);
    ed.selectedClipId = clip.id;
    toast(`Added "${m.originalName}" at ${fmtT(start)}.`);
    saveSoon(); renderAll();
  }

  /* ---------------- Editor shell ---------------- */
  function toolbarActions() {
    const split = async () => {
      const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
      if (!found) { toast('Select a clip first, then split at the playhead.', true); return; }
      const { clip, track } = found;
      if (track.locked) { toast('This track is locked.', true); return; }
      const rel = ed.playhead - clip.start;
      if (rel <= 0.05 || rel >= clip.duration - 0.05) { toast('Move the playhead inside the clip to split it.', true); return; }
      pushHistory();
      const right = deep(clip);
      right.id = uid('clip');
      right.start = ed.playhead;
      right.duration = clip.duration - rel;
      right.srcStart = clip.srcStart + rel * clip.speed;
      right.transition = { type: 'none', duration: 0.5 };
      right.keyframes = (clip.keyframes || []).filter((k) => k.t >= rel).map((k) => ({ ...k, t: k.t - rel }));
      clip.duration = rel;
      clip.keyframes = (clip.keyframes || []).filter((k) => k.t < rel);
      track.clips.push(right);
      ed.selectedClipId = right.id;
      saveSoon(); renderAll();
      toast('Clip split at the playhead.');
    };
    const duplicate = () => {
      const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
      if (!found) { toast('Select a clip first.', true); return; }
      pushHistory();
      const copy = deep(found.clip);
      copy.id = uid('clip');
      copy.start = found.clip.start + found.clip.duration;
      copy.name = `${found.clip.name} (copy)`;
      found.track.clips.push(copy);
      ed.selectedClipId = copy.id;
      saveSoon(); renderAll();
    };
    const remove = (ripple) => {
      const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
      if (!found) { toast('Select a clip first.', true); return; }
      pushHistory();
      const { clip, track } = found;
      const idx = track.clips.findIndex((c) => c.id === clip.id);
      track.clips.splice(idx, 1);
      if (ripple) {
        for (const c of track.clips) {
          if (c.start >= clip.start + clip.duration - 1e-6) c.start -= clip.duration;
        }
        toast('Clip deleted — later clips pulled earlier (ripple).');
      } else toast('Clip deleted.');
      ed.selectedClipId = null;
      saveSoon(); renderAll();
    };
    const groupSel = () => {
      const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
      if (!found) { toast('Select a clip first.', true); return; }
      pushHistory();
      const gid = uid('group');
      const { clip } = found;
      let n = 0;
      for (const tr of ed.timeline.tracks) {
        for (const c of tr.clips) {
          if (c.start < clip.start + clip.duration && c.start + c.duration > clip.start) { c.groupId = gid; n++; }
        }
      }
      saveSoon(); renderAll();
      toast(`${n} overlapping clip(s) grouped — they move together.`);
    };
    const ungroupSel = () => {
      const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
      if (!found || !found.clip.groupId) { toast('Selected clip is not in a group.', true); return; }
      pushHistory();
      const gid = found.clip.groupId;
      for (const tr of ed.timeline.tracks) for (const c of tr.clips) if (c.groupId === gid) c.groupId = null;
      saveSoon(); renderAll();
      toast('Group removed.');
    };
    return { split, duplicate, remove, groupSel, ungroupSel };
  }

  async function open(container, { project }) {
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    clearTimeout(ed && ed.pollTimer);
    let content = {};
    try { content = JSON.parse(project.content || '{}'); } catch { content = {}; }
    const timeline = content.timeline && content.timeline.tracks ? content.timeline
      : (content.tracks ? content : blankTimeline('16:9', 30));
    ed = {
      project, timeline,
      selectedClipId: null, playhead: 0, playing: false, lastTick: 0,
      pxPerSec: 14, leftTab: 'media', propsTab: 'props',
      undoStack: [], redoStack: [], saveTimer: null, pollTimer: null,
      currentJob: null, beatSnap: true, magnet: true,
    };
    ed.pushHistory = pushHistory;
    ed.saveSoon = saveSoon;
    container.style.maxWidth = 'none';
    container.style.padding = '16px';
    container.innerHTML = `
    <div class="ve-wrap">
      <div class="ve-toolbar card" style="padding:10px 14px">
        <button class="btn" id="ve-back">← Projects</button>
        <b>${esc(project.name)}</b>
        <span class="badge info">${ed.timeline.width}×${ed.timeline.height} @ ${ed.timeline.fps}fps</span>
        <span class="badge" id="ve-save-state">Saved</span>
        ${timeline.musicSync ? `<span class="badge info" title="Synced to ${esc(timeline.musicSync.trackName || '')}">♪ ${timeline.musicSync.bpm} BPM · ${timeline.musicSync.beats.length} beats</span>` : ''}
        <span class="spacer"></span>
        <button class="btn btn-sm" id="ve-undo" title="Ctrl+Z">↩ Undo</button>
        <button class="btn btn-sm" id="ve-redo" title="Ctrl+Shift+Z">↪ Redo</button>
        <button class="btn btn-sm" id="ve-save-ver">💾 Save version</button>
        <button class="btn btn-sm btn-primary ve-export" id="ve-goto-export">⬆ Export</button>
      </div>
      <div class="ve-main">
        <div class="ve-panel ve-left-rail" id="ve-left-panel">
          <div class="ve-tabs" role="tablist" aria-label="Editor panels">
            <button data-ltab="media" class="active" role="tab"><span class="ti">🎬</span><span class="tl">Media</span></button>
            <button data-ltab="audio" role="tab"><span class="ti">🎵</span><span class="tl">Audio</span></button>
            <button data-ltab="text" role="tab"><span class="ti">🔤</span><span class="tl">Text</span></button>
            <button data-ltab="stickers" role="tab"><span class="ti">🖼️</span><span class="tl">Stickers</span></button>
            <button data-ltab="effects" role="tab"><span class="ti">✨</span><span class="tl">Effects</span></button>
            <button data-ltab="transitions" role="tab"><span class="ti">🔀</span><span class="tl">Transitions</span></button>
            <button data-ltab="captions" role="tab"><span class="ti">💬</span><span class="tl">Captions</span></button>
            <button data-ltab="filters" role="tab"><span class="ti">🎛️</span><span class="tl">Filters</span></button>
          </div>
          <div id="ve-left">Loading…</div>
        </div>
        <div class="ve-preview">
          <div class="ve-stage" id="ve-stage" style="aspect-ratio:${ed.timeline.width}/${ed.timeline.height};width:100%;max-width:760px;max-height:430px">
            <video id="ve-va" playsinline preload="auto" style="display:none"></video>
            <video id="ve-vb" playsinline preload="auto" style="display:none"></video>
            <div id="ve-textov" style="position:absolute;inset:0;pointer-events:none"></div>
            <div class="ve-noclip" id="ve-noclip">No video clip under the playhead — add media from the left panel.</div>
            <audio id="ve-audio" preload="auto" style="display:none"></audio>
          </div>
          <div class="ve-transport">
            <button class="btn btn-sm" id="ve-prev-frame" title="Previous frame">⏮ −1f</button>
            <button class="btn btn-primary btn-sm" id="ve-play">▶ Play</button>
            <button class="btn btn-sm" id="ve-next-frame" title="Next frame">＋1f ⏭</button>
            <span class="time" id="ve-time">00:00.00 / 00:00.00</span>
            <span class="sub">Preview is approximate — transitions are crossfaded in the browser; the FFmpeg render is exact.</span>
          </div>
        </div>
        <div class="ve-panel" id="ve-right-panel">
          <div class="ve-tabs">
            <button data-ptab="props" class="active">Clip</button>
            <button data-ptab="keyframes">Keyframes</button>
            <button data-ptab="export">Export</button>
          </div>
          <div id="ve-props"></div>
        </div>
      </div>
      <div class="ve-timeline">
        <div class="ve-tl-tools">
          <button class="btn btn-sm" id="ve-split">✂ Split at playhead</button>
          <button class="btn btn-sm" id="ve-dup">Duplicate</button>
          <button class="btn btn-sm btn-danger" id="ve-del">Delete</button>
          <button class="btn btn-sm" id="ve-ripple">Ripple delete</button>
          <button class="btn btn-sm" id="ve-group">Group overlapping</button>
          <button class="btn btn-sm" id="ve-ungroup">Ungroup</button>
          <button class="btn btn-sm" id="ve-marker">◆ Add marker</button>
          ${timeline.musicSync ? `<label style="font-size:12px" title="Snap clip edges to the nearest beat (within 0.12 s)"><input type="checkbox" id="ve-beatsnap" checked> ♪ Beat snap</label>` : ''}
          <button class="btn btn-sm on" id="ve-magnet" title="Magnetic timeline: clip edges snap to the playhead and to other clips. Click to turn snapping off for free placement.">🧲 Magnet</button>
          <label style="font-size:12px">Zoom <input type="range" id="ve-zoom" min="4" max="40" step="1" value="14"></label>
          <button class="btn btn-sm" id="ve-add-audio-track">＋ Audio track</button>
          <button class="btn btn-sm" id="ve-add-text-track">＋ Text track</button>
          <button class="btn btn-sm" id="ve-add-overlay">＋ Overlay video track</button>
        </div>
        <div id="ve-timeline"></div>
      </div>
    </div>`;
    const actions = toolbarActions();
    document.getElementById('ve-back').addEventListener('click', () => go('projects'));
    document.getElementById('ve-undo').addEventListener('click', doUndo);
    document.getElementById('ve-redo').addEventListener('click', doRedo);
    document.getElementById('ve-save-ver').addEventListener('click', async () => { await saveTimeline(true); toast('Version saved.'); });
    document.getElementById('ve-goto-export').addEventListener('click', () => { ed.propsTab = 'export'; document.querySelectorAll('[data-ptab]').forEach((b) => b.classList.toggle('active', b.dataset.ptab === 'export')); renderProps(); });
    document.getElementById('ve-play').addEventListener('click', () => setPlaying(!ed.playing));
    document.getElementById('ve-prev-frame').addEventListener('click', () => { setPlaying(false); ed.playhead = Math.max(0, ed.playhead - 1 / ed.timeline.fps); updatePreview(); });
    document.getElementById('ve-next-frame').addEventListener('click', () => { setPlaying(false); ed.playhead = Math.min(totalDuration(ed.timeline), ed.playhead + 1 / ed.timeline.fps); updatePreview(); });
    document.getElementById('ve-split').addEventListener('click', actions.split);
    document.getElementById('ve-dup').addEventListener('click', actions.duplicate);
    document.getElementById('ve-del').addEventListener('click', () => actions.remove(false));
    document.getElementById('ve-ripple').addEventListener('click', () => actions.remove(true));
    document.getElementById('ve-group').addEventListener('click', actions.groupSel);
    document.getElementById('ve-ungroup').addEventListener('click', actions.ungroupSel);
    document.getElementById('ve-marker').addEventListener('click', () => {
      const label = prompt('Marker label', 'Note');
      if (label === null) return;
      pushHistory();
      ed.timeline.markers = ed.timeline.markers || [];
      ed.timeline.markers.push({ t: Math.round(ed.playhead * 100) / 100, label: label.trim() || 'Marker' });
      saveSoon(); renderAll();
    });
    document.getElementById('ve-zoom').addEventListener('input', (e) => { ed.pxPerSec = parseInt(e.target.value, 10); renderTimeline(); updatePreview(); });
    const beatSnapEl = document.getElementById('ve-beatsnap');
    if (beatSnapEl) beatSnapEl.addEventListener('change', (e) => { ed.beatSnap = e.target.checked; toast(ed.beatSnap ? 'Beat snap on — clip edges snap to the nearest beat.' : 'Beat snap off.'); });
    document.getElementById('ve-magnet').addEventListener('click', (e) => {
      ed.magnet = !ed.magnet;
      e.currentTarget.classList.toggle('on', ed.magnet);
      toast(ed.magnet ? 'Magnet on — clip edges snap to the playhead and other clips.' : 'Magnet off — clips move freely without snapping.');
    });
    document.getElementById('ve-add-audio-track').addEventListener('click', () => {
      pushHistory();
      ed.timeline.tracks.push({ id: uid('track'), kind: 'audio', name: `Audio ${ed.timeline.tracks.filter((t) => t.kind === 'audio').length + 1}`, locked: false, muted: false, clips: [] });
      saveSoon(); renderAll();
    });
    document.getElementById('ve-add-text-track').addEventListener('click', () => {
      pushHistory();
      ed.timeline.tracks.push({ id: uid('track'), kind: 'text', name: `Text ${ed.timeline.tracks.filter((t) => t.kind === 'text').length + 1}`, locked: false, muted: false, clips: [] });
      saveSoon(); renderAll();
    });
    document.getElementById('ve-add-overlay').addEventListener('click', () => {
      if (ed.timeline.tracks.filter((t) => t.kind === 'video').length >= 2) { toast('Phase 3 supports at most 2 video tracks (main + one overlay/PiP).', true); return; }
      pushHistory();
      ed.timeline.tracks.splice(1, 0, { id: uid('track'), kind: 'video', name: 'Overlay (PiP)', locked: false, muted: false, clips: [] });
      saveSoon(); renderAll();
      toast('Overlay track added — its clips render picture-in-picture at 30% width.');
    });
    container.querySelectorAll('[data-ltab]').forEach((b) => b.addEventListener('click', () => {
      ed.leftTab = b.dataset.ltab;
      container.querySelectorAll('[data-ltab]').forEach((x) => x.classList.toggle('active', x === b));
      renderLeftPanel();
    }));
    container.querySelectorAll('[data-ptab]').forEach((b) => b.addEventListener('click', () => {
      ed.propsTab = b.dataset.ptab;
      container.querySelectorAll('[data-ptab]').forEach((x) => x.classList.toggle('active', x === b));
      renderProps();
    }));
    keyHandler = (e) => {
      if (!ed) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === ' ' ) { e.preventDefault(); setPlaying(!ed.playing); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { actions.remove(false); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
    };
    document.addEventListener('keydown', keyHandler);
    renderLeftPanel();
    renderAll();
    // Resume polling for a job started earlier in this session.
    try {
      const { jobs } = await api('/api/video/jobs');
      const active = jobs.find((j) => j.projectId === project.id && (j.status === 'queued' || j.status === 'running'));
      if (active) { ed.currentJob = active; pollJob(active.id); }
    } catch { /* ignore */ }
  }

  return { open, blankTimeline, defaultClip };
})();
