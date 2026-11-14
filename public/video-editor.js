'use strict';
/* CreativeStudio AI Pro — Phase 3 Video Editor.
   DOM timeline + real <video> preview (approximate crossfades — the final
   render is always FFmpeg, see the Export tab) + FFmpeg render jobs.
   Uses the app.js globals: api, esc, toast, go, fmtBytes. */
window.VideoEditor = (function () {
  let ed = null;
  let keyHandler = null;

  // v2.5.0 — real editor fonts (the renderer bundles these server-side;
  // see src/render.js fontFor — the list here must match the fonts the
  // renderer can actually resolve, so the preview is WYSIWYG).
  const TEXT_FONTS = ['Poppins', 'Montserrat', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Bebas Neue', 'Oswald', 'Playfair Display', 'DejaVu Sans', 'DejaVu Serif'];
  // v2.5.0 — built-in text title templates (style bundles, not just text).
  const TEXT_TEMPLATES = [
    { id: 'bold-title', name: 'Bold title', text: 'YOUR TITLE', fontFamily: 'Montserrat', fontSize: 96, fontWeight: 800, color: '#ffffff', align: 'center', x: 50, y: 50, bgColor: '', animIn: 'pop', animOut: 'fade' },
    { id: 'lower-third', name: 'Lower third', text: 'Name — Role', fontFamily: 'Inter', fontSize: 56, fontWeight: 700, color: '#ffffff', align: 'left', x: 8, y: 82, bgColor: '#000000', animIn: 'slide', animOut: 'fade' },
    { id: 'neon', name: 'Neon pop', text: 'WOW', fontFamily: 'Bebas Neue', fontSize: 140, fontWeight: 400, color: '#00e5ff', align: 'center', x: 50, y: 40, bgColor: '', animIn: 'pop', animOut: 'fade' },
    { id: 'elegant', name: 'Elegant serif', text: 'A beautiful story', fontFamily: 'Playfair Display', fontSize: 72, fontWeight: 700, color: '#fde68a', align: 'center', x: 50, y: 30, bgColor: '', animIn: 'fade', animOut: 'fade' },
    { id: 'subtitle', name: 'Subtitle', text: 'Add your subtitle here', fontFamily: 'Open Sans', fontSize: 48, fontWeight: 400, color: '#ffffff', align: 'center', x: 50, y: 88, bgColor: '', animIn: 'fade', animOut: 'fade' },
    { id: 'breaking', name: 'Breaking news', text: 'BREAKING NEWS', fontFamily: 'Oswald', fontSize: 84, fontWeight: 700, color: '#ffffff', align: 'left', x: 6, y: 8, bgColor: '#dc2626', animIn: 'slide', animOut: 'fade' },
  ];
  // v2.5.0 — caption style presets (colour / glow / highlight looks).
  const CAPTION_STYLES = [
    { id: 'plain', name: 'Plain white', color: '#ffffff', glow: '', highlight: '' },
    { id: 'karaoke', name: 'Karaoke yellow', color: '#fde047', glow: '#f59e0b', highlight: '#000000' },
    { id: 'neon-blue', name: 'Neon blue', color: '#67e8f9', glow: '#0891b2', highlight: '' },
    { id: 'bold-black', name: 'Bold on black', color: '#ffffff', glow: '', highlight: '#000000' },
    { id: 'hot-pink', name: 'Hot pink', color: '#f9a8d4', glow: '#db2777', highlight: '' },
  ];
  // v2.5.0 — full CapCut shortcut map. Each entry: {key, label, action}.
  // `key` is the canonical form: 'ctrl+b', 'shift+left', 'j', etc.
  // Users can rebind them in the Shortcuts panel; overrides live in
  // localStorage (per browser) and are applied in the key handler.
  const DEFAULT_SHORTCUTS = [
    { id: 'split', key: 'ctrl+b', label: 'Split at playhead', hint: 'Ctrl+B' },
    { id: 'duplicate', key: 'ctrl+d', label: 'Duplicate clip', hint: 'Ctrl+D' },
    { id: 'delete-left', key: 'q', label: 'Delete left of playhead', hint: 'Q' },
    { id: 'delete-right', key: 'w', label: 'Delete right of playhead', hint: 'W' },
    { id: 'marker', key: 'm', label: 'Add marker', hint: 'M' },
    { id: 'export', key: 'ctrl+e', label: 'Go to Export', hint: 'Ctrl+E' },
    { id: 'add-text', key: 'ctrl+t', label: 'Insert text clip', hint: 'Ctrl+T' },
    { id: 'frame-prev', key: 'left', label: 'Previous frame', hint: '←' },
    { id: 'frame-next', key: 'right', label: 'Next frame', hint: '→' },
    { id: 'jump5-prev', key: 'shift+left', label: 'Back 5 frames', hint: 'Shift+←' },
    { id: 'jump5-next', key: 'shift+right', label: 'Forward 5 frames', hint: 'Shift+→' },
    { id: 'shuttle-rev', key: 'j', label: 'Shuttle reverse', hint: 'J' },
    { id: 'shuttle-stop', key: 'k', label: 'Stop / pause', hint: 'K' },
    { id: 'shuttle-fwd', key: 'l', label: 'Shuttle forward', hint: 'L' },
    { id: 'play', key: 'space', label: 'Play / pause', hint: 'Space' },
    { id: 'undo', key: 'ctrl+z', label: 'Undo', hint: 'Ctrl+Z' },
    { id: 'redo', key: 'ctrl+shift+z', label: 'Redo', hint: 'Ctrl+Shift+Z' },
    { id: 'delete', key: 'delete', label: 'Delete selected clip', hint: 'Del' },
    { id: 'copy', key: 'ctrl+c', label: 'Copy clip', hint: 'Ctrl+C' },
    { id: 'paste', key: 'ctrl+v', label: 'Paste clip', hint: 'Ctrl+V' },
    { id: 'cut', key: 'ctrl+x', label: 'Cut clip', hint: 'Ctrl+X' },
    { id: 'select-all', key: 'ctrl+a', label: 'Select all clips', hint: 'Ctrl+A' },
    { id: 'caption-split', key: 'b', label: 'Split caption at playhead', hint: 'B' },
    { id: 'waveforms', key: 'ctrl+shift+h', label: 'Toggle audio waveforms', hint: 'Ctrl+Shift+H' },
    { id: 'vol-up', key: 'ctrl+.', label: 'Volume up (selected clip)', hint: 'Ctrl+.' },
    { id: 'vol-down', key: 'ctrl+,', label: 'Volume down (selected clip)', hint: 'Ctrl+,' },
    { id: 'fullscreen', key: 'ctrl+shift+p', label: 'Fullscreen preview', hint: 'Ctrl+Shift+P' },
  ];
  function loadShortcuts() {
    try {
      const saved = JSON.parse(localStorage.getItem('cs-shortcuts') || '{}');
      const map = {};
      for (const s of DEFAULT_SHORTCUTS) map[s.id] = saved[s.id] || s.key;
      return map;
    } catch { const m = {}; for (const s of DEFAULT_SHORTCUTS) m[s.id] = s.key; return m; }
  }
  function saveShortcuts(map) { try { localStorage.setItem('cs-shortcuts', JSON.stringify(map)); } catch { /* ignore */ } }
  function keyEventName(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey) parts.push('alt');
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase().replace('arrow', '');
    if (k === ' ') parts.push('space');
    else if (k === 'delete' || k === 'backspace') parts.push('delete');
    else parts.push(k);
    return parts.join('+');
  }
  function loadTextStyles() {
    try { return JSON.parse(localStorage.getItem('cs-text-styles') || '[]'); } catch { return []; }
  }
  function saveTextStyles(list) { try { localStorage.setItem('cs-text-styles', JSON.stringify(list)); } catch { /* ignore */ } }

  // v2.4.0 — aspect list mirrors src/video-model.js ASPECTS exactly (the
  // editor is a static file; the /api/video/effects list is the same set).
  const ASPECTS = [
    { id: '16:9', name: 'Landscape 16:9', width: 1280, height: 720 },
    { id: '9:16', name: 'Vertical 9:16', width: 720, height: 1280 },
    { id: '1:1', name: 'Square 1:1', width: 720, height: 720 },
    { id: '4:5', name: 'Portrait 4:5', width: 720, height: 900 },
  ];

  function uid(p) { return `${p || 'clip'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
  function deep(o) { return JSON.parse(JSON.stringify(o)); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  const fmtT = (t) => {
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  };
  // v2.7.0 — CapCut-style timecode HH:MM:SS:FF for the preview transport
  // (frames from the timeline fps; the ruler and clip labels keep fmtT).
  const fmtTC = (t) => {
    const fps = (ed && ed.timeline && ed.timeline.fps) || 30;
    const totalFrames = Math.max(0, Math.floor(t * fps + 1e-6));
    const ff = totalFrames % fps;
    const s = Math.floor(totalFrames / fps);
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
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
      // v2.5.0 — new clip fields (all optional in the model; defaults here
      // keep old timelines rendering exactly as before).
      effects: [], // [{id, intensity}] — video effects library (#2)
      filterPreset: 'none', lutMediaId: null, // #7
      chroma: { enabled: false, color: '#00ff00', similarity: 0.4, blend: 0.1 }, // #3
      speedCurve: { preset: 'none', points: [] }, // #4
      stabilize: { enabled: false, strength: 0.5 }, // #8
      mask: { type: 'none', x: 50, y: 50, w: 60, h: 60, rotation: 0, feather: 10, invert: false }, // #9
      reverse: false, freeze: { enabled: false, at: 0, duration: 3 }, // #16
      audioFx: { denoise: false, enhanceVoice: false, vocalIsolation: 'off', loudnorm: false, ducking: false }, // #17
      autoReframe: { enabled: false, targetAspect: '9:16' }, // #18 (validator requires a real aspect even when disabled)
      opticalFlow: false, // #43
      overlay: null, // {x,y,w,h} percent — free PiP position (#40); null = default 70/70, 30% wide
      linkedTo: null, splitScreen: { enabled: false, partnerClipId: null }, // #58 J/L cuts + split screen
      text: { text: 'Your text', fontFamily: 'Poppins', fontSize: 64, fontWeight: 700, color: '#ffffff', align: 'center', x: 50, y: 50, bgColor: '', animIn: 'fade', animOut: 'fade', letterSpacing: 0, lineHeight: 1.2, shadow: { enabled: false, color: '#000000', dx: 2, dy: 2 }, stroke: { enabled: false, color: '#000000', width: 2 }, gradient: { enabled: false, colors: ['#ffffff', '#fde047'] }, captionStyle: 'plain' },
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
    // v2.5.0 — overlay tracks (PiP): EVERY video track beyond the first
    // renders its clip under the playhead — video clips as <video>,
    // image/sticker clips as <img> — at the clip's free position
    // (clip.overlay {x,y,w,h} percent) or the default 30% bottom-right.
    // The overlay elements are draggable in the preview: dragging one
    // writes clip.overlay, so preview position == render position.
    const ovHost = document.getElementById('ve-overlays');
    if (ovHost) {
      const stageW = stage.clientWidth || 640;
      const stageH = stage.clientHeight || Math.round(stageW * tl.height / tl.width);
      const seen = new Set();
      tl.tracks.filter((x) => x.kind === 'video').slice(1).forEach((ovTrack) => {
        const ovClip = ovTrack.clips.find((x) => t >= x.start && t < x.start + x.duration);
        if (!ovClip || ovClip.mediaId === null || ovClip.mediaId === undefined) return;
        seen.add(ovClip.id);
        let el = ovHost.querySelector(`[data-ov="${ovClip.id}"]`);
        const isImg = ovClip.sticker || ovClip.kind === 'video' && ovClip.mediaId && ed.mediaKinds && ed.mediaKinds[ovClip.mediaId] === 'image';
        if (!el) {
          el = document.createElement(isImg ? 'img' : 'video');
          el.dataset.ov = ovClip.id;
          el.style.cssText = 'position:absolute;pointer-events:auto;cursor:move;object-fit:contain;background:#000';
          el.setAttribute('data-ovclip', ovClip.id);
          ovHost.appendChild(el);
          el.addEventListener('pointerdown', (ev) => onOverlayDragStart(ev, ovClip));
        }
        const ov = ovClip.overlay || {};
        const wPct = ov.w !== undefined ? ov.w : 30;
        const w = Math.max(40, Math.round(stageW * wPct / 100 * (ovClip.zoom || 1)));
        const pos = ovClip.keyframes && ovClip.keyframes.length ? sampleKeyframe(ovClip, 0) : { x: ov.x !== undefined ? ov.x : 70, y: ov.y !== undefined ? ov.y : 70 };
        const h = Math.round(w * tl.height / tl.width);
        if (el.tagName === 'IMG') {
          if (el.dataset.media !== String(ovClip.mediaId)) { el.dataset.media = String(ovClip.mediaId); el.src = `/api/media/${ovClip.mediaId}/file`; }
        } else {
          const url = `/api/media/${ovClip.mediaId}/file`;
          if (el.dataset.media !== String(ovClip.mediaId)) { el.dataset.media = String(ovClip.mediaId); el.src = url; el.load(); }
          const target = ovClip.srcStart + (t - ovClip.start) / ovClip.speed;
          if (Math.abs((el.currentTime || 0) - target) > 0.35) { try { el.currentTime = Math.max(0, target); } catch { /* ignore */ } }
          try { el.playbackRate = ovClip.speed; } catch { /* ignore */ }
          el.volume = 0; // overlay audio stays muted in the preview (main track carries the sound)
          if (ed.playing) el.play().catch(() => {}); else el.pause();
        }
        el.style.display = 'block';
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.left = `${Math.round((stageW - w) * (pos.x / 100))}px`;
        el.style.top = `${Math.round((stageH - h) * (pos.y / 100))}px`;
        el.style.opacity = String(ovClip.opacity ?? 1);
        el.style.transform = `${ovClip.flip === 'h' ? 'scaleX(-1)' : ovClip.flip === 'v' ? 'scaleY(-1)' : ''} ${ovClip.rotation ? `rotate(${ovClip.rotation}deg)` : ''}`.trim();
        el.style.filter = cssFilter(ovClip);
      });
      ovHost.querySelectorAll('[data-ov]').forEach((el) => {
        if (!seen.has(el.dataset.ov)) el.remove();
      });
    }
    // v2.5.0 — project background: solid colour, image, or blur-fill.
    // A plain '#rrggbb' string still works (backwards compatible).
    const bg = tl.background;
    if (bg && typeof bg === 'object' && bg.type === 'image' && bg.mediaId) {
      stage.style.backgroundImage = `url(/api/media/${bg.mediaId}/file)`;
      stage.style.backgroundSize = 'cover';
      stage.style.backgroundPosition = 'center';
      stage.style.backgroundColor = bg.color || '#000000';
    } else if (bg && typeof bg === 'object' && bg.type === 'blur' && bg.mediaId) {
      stage.style.backgroundImage = `url(/api/media/${bg.mediaId}/file)`;
      stage.style.backgroundSize = 'cover';
      stage.style.filter = 'blur(0px)';
      stage.style.backgroundColor = bg.color || '#000000';
    } else {
      stage.style.backgroundImage = 'none';
      stage.style.backgroundColor = typeof bg === 'string' ? bg : (bg && bg.color) || '#000000';
    }
    // v2.5.0 — safe-zones overlay (action-safe + title-safe guides).
    const sz = document.getElementById('ve-safezones');
    if (sz) sz.style.display = ed.safeZones ? 'block' : 'none';
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
        // v2.5.0 — text depth: letter spacing, line height, shadow,
        // stroke, gradient, caption style (glow / highlight).
        const style = CAPTION_STYLES.find((s) => s.id === (tx.captionStyle || 'plain')) || CAPTION_STYLES[0];
        const color = style.color || tx.color;
        const extra = [];
        if (tx.letterSpacing) extra.push(`letter-spacing:${tx.letterSpacing}px`);
        if (tx.lineHeight) extra.push(`line-height:${tx.lineHeight}`);
        if (tx.shadow && tx.shadow.enabled) extra.push(`text-shadow:${tx.shadow.dx || 2}px ${tx.shadow.dy || 2}px 4px ${tx.shadow.color || '#000000'}`);
        else if (style.glow) extra.push(`text-shadow:0 0 12px ${style.glow},0 0 4px ${style.glow}`);
        if (tx.stroke && tx.stroke.enabled) extra.push(`-webkit-text-stroke:${tx.stroke.width || 2}px ${tx.stroke.color || '#000000'}`);
        if (style.highlight) extra.push(`background:${style.highlight};padding:2px 8px;border-radius:4px`);
        let grad = '';
        if (tx.gradient && tx.gradient.enabled && tx.gradient.colors && tx.gradient.colors.length >= 2) {
          grad = `background:linear-gradient(90deg,${tx.gradient.colors[0]},${tx.gradient.colors[1]});-webkit-background-clip:text;background-clip:text;color:transparent;`;
        }
        return `<div class="ve-textov" style="left:${left};right:${right};top:${tx.y}%;transform:${trX};${slide}opacity:${op.toFixed(2)};` +
          `font-family:${esc(tx.fontFamily)};font-size:${Math.round(tx.fontSize * scale)}px;font-weight:${tx.fontWeight};color:${esc(color)};${grad}` +
          `${tx.bgColor && !style.highlight ? `background:${esc(tx.bgColor)};padding:4px 10px;border-radius:6px;` : ''}${extra.join(';') ? extra.join(';') + ';' : ''}">${esc(tx.text)}</div>`;
      }).join('');
    }
    const timeEl = document.getElementById('ve-time');
    if (timeEl) timeEl.textContent = `${fmtTC(t)} / ${fmtTC(totalDuration(tl))}`;
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
      // v2.5.0 — loop playback: wrap to the start instead of stopping.
      if (ed.loop) { ed.playhead = 0; }
      else {
        ed.playhead = total;
        ed.playing = false;
        const btn = document.getElementById('ve-play');
        if (btn) btn.textContent = '▶ Play';
      }
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
        const sel = ed.selectedClipIds ? ed.selectedClipIds.has(c.id) : ed.selectedClipId === c.id;
        const grouped = c.groupId ? ' grouped' : '';
        const locked = tr.locked ? ' locked' : '';
        const compound = c.kind === 'compound' ? ' compound' : '';
        const isAudio = tr.kind === 'audio';
        const peaks = isAudio && ed.waveformsOn && ed.waveforms && ed.waveforms[c.mediaId];
        const wave = peaks ? waveformBars(peaks, Math.max(8, c.duration * ed.pxPerSec)) : '';
        return `<div class="ve-clip ${tr.kind}${sel ? ' selected' : ''}${grouped}${locked}${compound}" data-clip="${c.id}" ` +
          `style="left:${c.start * ed.pxPerSec}px;width:${Math.max(8, c.duration * ed.pxPerSec)}px" title="${esc(c.name)} — ${fmtT(c.start)} → ${fmtT(c.start + c.duration)}${c.kind === 'compound' ? ' · compound clip (double-click to edit inside)' : ''}">` +
          `${wave}<span class="handle l" data-handle="l"></span><span class="clip-label">${esc(c.name)}</span><span class="handle r" data-handle="r"></span></div>`;
      }).join('');
      return `<div class="ve-track" data-track="${tr.id}">
        <div class="ve-track-head"><span class="nm">${esc(tr.name)} · ${tr.kind}</span>
          <span class="tb">
            <button data-lock="${tr.id}" class="${tr.locked ? 'on' : ''}" title="Lock track">${tr.locked ? '🔒' : '🔓'}</button>
            <button data-mute="${tr.id}" class="${tr.muted ? 'on' : ''}" title="Mute track">${tr.muted ? '🔇' : '🔊'}</button>
            <button data-track-menu="${tr.id}" title="Track menu">⋮</button>
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
    // v2.7.0 — CapCut empty state: shown only when the timeline has no
    // clips at all; it is also a drop target (files upload + land as clips).
    const isEmpty = allClips(tl).length === 0;
    const emptyState = isEmpty ? `<div class="ve-empty" id="ve-empty" title="Drop videos, photos or audio here, or click to open the Media panel"><span class="ve-empty-ico">🎞️</span><span>Drag material here and start to create</span></div>` : '';
    host.innerHTML = `
      <div class="ve-ruler" id="ve-ruler" style="width:${width + 92}px">${ticks.join('')}</div>
      ${beatRuler}
      <div style="position:relative;overflow-x:auto">
        <div style="position:relative;min-width:${width + 92}px">
          ${markers}
          ${tracksHtml}
          ${emptyState}
          <div class="ve-playhead" id="ve-playhead" style="left:calc(92px + ${ed.playhead * ed.pxPerSec}px)"></div>
        </div>
      </div>`;
    host.querySelector('#ve-ruler').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      ed.playhead = clamp((e.clientX - rect.left) / ed.pxPerSec, 0, total);
      updatePreview();
    });
    const emptyEl = host.querySelector('#ve-empty');
    if (emptyEl) {
      emptyEl.addEventListener('click', () => switchLeftTab('media'));
      emptyEl.addEventListener('dragover', (e) => { e.preventDefault(); emptyEl.classList.add('ve-drop'); });
      emptyEl.addEventListener('dragleave', () => emptyEl.classList.remove('ve-drop'));
      emptyEl.addEventListener('drop', async (e) => {
        e.preventDefault(); emptyEl.classList.remove('ve-drop');
        const files = [...(e.dataTransfer.files || [])].filter((f) => /^(video|audio|image)\//.test(f.type));
        if (!files.length) { toast('Drop videos, photos or audio files here.', true); return; }
        for (const f of files) {
          const fd = new FormData(); fd.append('file', f);
          try {
            const up = await apiForm('/api/media/upload', fd);
            const m = up.media || up;
            addMediaClip({ id: m.id, kind: m.kind || (f.type.startsWith('audio') ? 'audio' : 'video'), originalName: m.originalName || f.name, durationSeconds: m.durationSeconds });
          } catch (err) { toast(err.message, true); return; }
        }
        toast('Uploaded and added to the timeline.');
      });
    }
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
    host.querySelectorAll('[data-track-menu]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const tr = ed.timeline.tracks.find((x) => x.id === b.dataset.trackMenu);
      if (tr) showTrackMenu(e.clientX, e.clientY, tr);
    }));
    host.querySelectorAll('.ve-lane').forEach((lane) => {
      lane.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.ve-clip')) return; // clip menu handles itself
        e.preventDefault();
        showEmptyMenu(e.clientX, e.clientY);
      });
      lane.addEventListener('click', (e) => {
        if (e.target === lane) { ed.selectedClipIds = new Set(); ed.selectedClipId = null; renderAll(); }
      });
    });
    host.querySelectorAll('.ve-clip').forEach((el) => {
      el.addEventListener('pointerdown', (e) => onClipPointerDown(e, el));
      el.addEventListener('click', (e) => {
        if (ed.toolMode === 'split') return; // the Split tool already split on pointerdown
        if (e.detail === 1) {
          // v2.5.0 — multi-select: Ctrl/Cmd toggles one clip, Shift selects
          // the range on the same track, plain click selects one clip.
          ed.selectedClipIds = ed.selectedClipIds || new Set();
          const id = el.dataset.clip;
          if (e.ctrlKey || e.metaKey) {
            if (ed.selectedClipIds.has(id)) ed.selectedClipIds.delete(id);
            else ed.selectedClipIds.add(id);
          } else if (e.shiftKey && ed.selectedClipId) {
            const found = findClip(ed.timeline, ed.selectedClipId);
            const cur = findClip(ed.timeline, id);
            if (found && cur && found.track.id === cur.track.id) {
              const sorted = [...found.track.clips].sort((a, b) => a.start - b.start);
              const a = sorted.findIndex((c) => c.id === ed.selectedClipId);
              const b = sorted.findIndex((c) => c.id === id);
              const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
              for (let i = lo; i <= hi; i++) ed.selectedClipIds.add(sorted[i].id);
            } else ed.selectedClipIds.add(id);
          } else {
            ed.selectedClipIds = new Set([id]);
          }
          ed.selectedClipId = id;
          renderAll();
        }
      });
      el.addEventListener('dblclick', (e) => {
        const found = findClip(ed.timeline, el.dataset.clip);
        if (found && found.clip.kind === 'compound') { e.preventDefault(); enterCompound(found.clip); }
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        ed.selectedClipIds = ed.selectedClipIds || new Set();
        if (!ed.selectedClipIds.has(el.dataset.clip)) ed.selectedClipIds = new Set([el.dataset.clip]);
        ed.selectedClipId = el.dataset.clip;
        renderAll();
        showClipMenu(e.clientX, e.clientY, el.dataset.clip);
      });
    });
    // v2.5.0 — waveforms: fetch peaks for visible audio clips once.
    if (ed.waveformsOn) {
      for (const tr of tl.tracks.filter((t) => t.kind === 'audio')) {
        for (const c of tr.clips) {
          if (c.mediaId && (!ed.waveforms || ed.waveforms[c.mediaId] === undefined)) {
            getWaveform(c.mediaId).then(() => { if (ed && ed.waveformsOn) renderTimeline(); });
          }
        }
      }
    }
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

  // v2.5.0 — selection helpers (multi-select, clipboard, compound clips).
  function selectedClips() {
    const ids = ed.selectedClipIds && ed.selectedClipIds.size ? [...ed.selectedClipIds] : (ed.selectedClipId ? [ed.selectedClipId] : []);
    return ids.map((id) => findClip(ed.timeline, id)).filter(Boolean);
  }
  function copySelection() {
    const sel = selectedClips();
    if (!sel.length) { toast('Select a clip first to copy it.', true); return; }
    ed.clipboard = sel.map(({ clip }) => deep(clip));
    try { localStorage.setItem('cs-clipboard', JSON.stringify(ed.clipboard)); } catch { /* ignore */ }
    toast(`Copied ${sel.length} clip(s) — paste with Ctrl+V.`);
  }
  function pasteClipboard() {
    let items = ed.clipboard || [];
    if (!items.length) {
      try { items = JSON.parse(localStorage.getItem('cs-clipboard') || '[]'); } catch { items = []; }
    }
    if (!items.length) { toast('Nothing to paste — copy a clip first (Ctrl+C).', true); return; }
    pushHistory();
    const minStart = Math.min(...items.map((c) => c.start));
    const newIds = [];
    for (const src of items) {
      const found = ed.timeline.tracks.find((t) => t.kind === src.kind);
      if (!found) continue;
      const copy = deep(src);
      copy.id = uid('clip');
      copy.start = Math.max(0, ed.playhead + (src.start - minStart));
      // Avoid overlap on the target track: push after the last clip.
      const sorted = [...found.clips].sort((a, b) => a.start - b.start);
      for (const c of sorted) {
        if (copy.start < c.start + c.duration && copy.start + copy.duration > c.start) copy.start = c.start + c.duration;
      }
      copy.name = `${src.name} (paste)`;
      found.clips.push(copy);
      newIds.push(copy.id);
    }
    ed.selectedClipIds = new Set(newIds);
    ed.selectedClipId = newIds[0] || null;
    saveSoon(); renderAll();
    toast(`Pasted ${newIds.length} clip(s) at the playhead.`);
  }
  function cutSelection() {
    copySelection();
    deleteSelection(false);
  }
  function deleteSelection(ripple) {
    const sel = selectedClips();
    if (!sel.length) { toast('Select a clip first.', true); return; }
    pushHistory();
    for (const { clip, track } of sel) {
      const idx = track.clips.findIndex((c) => c.id === clip.id);
      if (idx > -1) track.clips.splice(idx, 1);
      if (ripple) {
        for (const c of track.clips) {
          if (c.start >= clip.start + clip.duration - 1e-6) c.start -= clip.duration;
        }
      }
    }
    ed.selectedClipIds = new Set();
    ed.selectedClipId = null;
    saveSoon(); renderAll();
    toast(`Deleted ${sel.length} clip(s)${ripple ? ' (ripple)' : ''}.`);
  }
  function duplicateSelection() {
    const sel = selectedClips();
    if (!sel.length) { toast('Select a clip first.', true); return; }
    pushHistory();
    const newIds = [];
    for (const { clip, track } of sel) {
      const copy = deep(clip);
      copy.id = uid('clip');
      copy.start = clip.start + clip.duration;
      copy.name = `${clip.name} (copy)`;
      track.clips.push(copy);
      newIds.push(copy.id);
    }
    ed.selectedClipIds = new Set(newIds);
    ed.selectedClipId = newIds[0] || null;
    saveSoon(); renderAll();
    toast(`Duplicated ${newIds.length} clip(s).`);
  }
  // v2.5.0 — compound clips: selected clips collapse into one nested
  // sequence clip (clip.kind 'compound', clip.nested = timeline).
  function makeCompound() {
    const sel = selectedClips().filter(({ clip }) => clip.kind !== 'compound');
    if (sel.length < 2) { toast('Select at least 2 clips to make a compound clip (Ctrl+click to multi-select).', true); return; }
    const tracks = [...new Set(sel.map(({ track }) => track.id))];
    if (tracks.length !== 1) { toast('Compound clips need clips on one track — select clips on the same track.', true); return; }
    const track = sel[0].track;
    const start = Math.min(...sel.map(({ clip }) => clip.start));
    const end = Math.max(...sel.map(({ clip }) => clip.start + clip.duration));
    pushHistory();
    const nested = {
      version: 1, width: ed.timeline.width, height: ed.timeline.height, fps: ed.timeline.fps,
      background: '#000000',
      tracks: [{ id: uid('track'), kind: track.kind, name: track.name, locked: false, muted: false, clips: sel.map(({ clip }) => { const c = deep(clip); c.start -= start; return c; }) }],
      markers: [],
    };
    for (const { clip } of sel) {
      const idx = track.clips.findIndex((c) => c.id === clip.id);
      if (idx > -1) track.clips.splice(idx, 1);
    }
    const comp = defaultClip('compound', null, start, end - start);
    comp.name = `Compound (${sel.length} clips)`;
    comp.nested = nested;
    comp.kind = 'compound';
    track.clips.push(comp);
    ed.selectedClipIds = new Set([comp.id]);
    ed.selectedClipId = comp.id;
    saveSoon(); renderAll();
    toast('Compound clip created — double-click it to edit inside.');
  }
  function unmakeCompound() {
    const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
    if (!found || found.clip.kind !== 'compound' || !found.clip.nested) { toast('Select a compound clip to ungroup it.', true); return; }
    pushHistory();
    const { clip, track } = found;
    const idx = track.clips.findIndex((c) => c.id === clip.id);
    track.clips.splice(idx, 1);
    const inner = (clip.nested.tracks[0] && clip.nested.tracks[0].clips) || [];
    for (const c of inner) {
      const copy = deep(c);
      copy.id = uid('clip');
      copy.start += clip.start;
      track.clips.push(copy);
    }
    ed.selectedClipIds = new Set();
    ed.selectedClipId = null;
    saveSoon(); renderAll();
    toast('Compound clip expanded back into its clips.');
  }
  // v2.5.0 — edit inside a compound clip: the editor swaps in the nested
  // timeline; a breadcrumb bar returns to the parent timeline.
  function enterCompound(clip) {
    if (!clip.nested) return;
    ed.compoundStack = ed.compoundStack || [];
    ed.compoundStack.push({ timeline: ed.timeline, clipId: clip.id });
    ed.timeline = clip.nested;
    ed.selectedClipIds = new Set();
    ed.selectedClipId = null;
    ed.playhead = 0;
    renderAll();
    const bar = document.getElementById('ve-compound-bar');
    if (bar) bar.style.display = 'flex';
    const sq = document.getElementById('ve-seq-name');
    if (sq) sq.textContent = `Compound — ${clip.name}`;
    toast('Editing inside the compound clip — use ← Back to return.');
  }
  function exitCompound() {
    if (!ed.compoundStack || !ed.compoundStack.length) return;
    const parent = ed.compoundStack.pop();
    const nested = ed.timeline;
    ed.timeline = parent.timeline;
    const found = findClip(ed.timeline, parent.clipId);
    if (found) found.clip.nested = nested;
    ed.selectedClipIds = new Set();
    ed.selectedClipId = null;
    saveSoon(); renderAll();
    const bar = document.getElementById('ve-compound-bar');
    if (bar) bar.style.display = ed.compoundStack.length ? 'flex' : 'none';
    const sq = document.getElementById('ve-seq-name');
    if (sq && !ed.compoundStack.length) sq.textContent = 'Player-Timeline 01';
  }

  // v2.5.0 — right-click context menus (clip / empty area / track head).
  function closeMenus() { document.querySelectorAll('.ve-ctx').forEach((m) => m.remove()); }
  function showMenu(x, y, items) {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 've-ctx card';
    menu.style.cssText = `position:fixed;left:${Math.min(x, window.innerWidth - 220)}px;top:${Math.min(y, window.innerHeight - items.length * 36 - 20)}px;z-index:9999;min-width:200px;padding:6px;`;
    menu.innerHTML = items.map((it, i) => it.sep ? '<hr style="margin:4px 0">' : `<button class="btn btn-sm" data-mi="${i}" style="display:block;width:100%;text-align:left;justify-content:flex-start" ${it.disabled ? 'disabled' : ''}>${it.label}</button>`).join('');
    document.body.appendChild(menu);
    menu.querySelectorAll('[data-mi]').forEach((b) => b.addEventListener('click', () => { closeMenus(); items[parseInt(b.dataset.mi, 10)].fn(); }));
    setTimeout(() => document.addEventListener('pointerdown', function once(e) { if (!menu.contains(e.target)) { closeMenus(); document.removeEventListener('pointerdown', once); } }), 0);
  }
  function showClipMenu(x, y, clipId) {
    const found = findClip(ed.timeline, clipId);
    if (!found) return;
    const { clip, track } = found;
    showMenu(x, y, [
      { label: '✂ Split at playhead', fn: () => document.getElementById('ve-split').click() },
      { label: '⧉ Duplicate', fn: duplicateSelection },
      { label: '📋 Copy / ✂ Cut / 📥 Paste', fn: copySelection },
      { sep: true },
      { label: '⏪ Reverse', fn: () => reverseClip(clip) },
      { label: '❄ Freeze frame (3s still)', fn: () => freezeClip(clip) },
      { label: '🎵 Extract audio', fn: () => extractAudio(clip) },
      { label: '🧩 Make compound clip', fn: makeCompound },
      { label: '🔗 Link / unlink audio-video', fn: () => toggleLink(clip) },
      { label: '◆ Add marker', fn: () => { pushHistory(); ed.timeline.markers = ed.timeline.markers || []; ed.timeline.markers.push({ t: Math.round(ed.playhead * 100) / 100, label: 'Marker' }); saveSoon(); renderAll(); } },
      { sep: true },
      { label: '🗑 Delete', fn: () => deleteSelection(false) },
    ]);
  }
  function showEmptyMenu(x, y) {
    showMenu(x, y, [
      { label: '📥 Paste', fn: pasteClipboard },
      { label: '☑ Select all clips', fn: selectAllClips },
      { label: '＋ Add audio track', fn: () => document.getElementById('ve-add-audio-track').click() },
      { label: '＋ Add text track', fn: () => document.getElementById('ve-add-text-track').click() },
    ]);
  }
  function showTrackMenu(x, y, tr) {
    showMenu(x, y, [
      { label: `✏️ Rename track`, fn: () => { const n = prompt('Track name', tr.name); if (n) { pushHistory(); tr.name = n.trim() || tr.name; saveSoon(); renderAll(); } } },
      { label: tr.locked ? '🔓 Unlock track' : '🔒 Lock track', fn: () => { pushHistory(); tr.locked = !tr.locked; saveSoon(); renderAll(); } },
      { label: tr.muted ? '🔊 Unmute track' : '🔇 Mute track', fn: () => { pushHistory(); tr.muted = !tr.muted; saveSoon(); renderAll(); updatePreview(); } },
      { label: '＋ Add video track', fn: () => addVideoTrack() },
      { label: '🗑 Delete track', fn: () => deleteTrack(tr) },
    ]);
  }
  function selectAllClips() {
    ed.selectedClipIds = new Set(allClips(ed.timeline).map((x) => x.clip.id));
    ed.selectedClipId = [...ed.selectedClipIds][0] || null;
    renderAll();
  }
  function addVideoTrack() {
    pushHistory();
    const n = ed.timeline.tracks.filter((t) => t.kind === 'video').length + 1;
    ed.timeline.tracks.push({ id: uid('track'), kind: 'video', name: `Video ${n}`, locked: false, muted: false, clips: [] });
    saveSoon(); renderAll();
    toast(`Video track ${n} added — its clips render as overlays above the main track.`);
  }
  function deleteTrack(tr) {
    if (ed.timeline.tracks.length <= 1) { toast('A timeline needs at least one track.', true); return; }
    if (!confirm(`Delete track "${tr.name}" and its ${tr.clips.length} clip(s)?`)) return;
    pushHistory();
    ed.timeline.tracks = ed.timeline.tracks.filter((t) => t.id !== tr.id);
    ed.selectedClipIds = new Set(); ed.selectedClipId = null;
    saveSoon(); renderAll();
  }
  // v2.5.0 — clip actions used by menus + toolbar + shortcuts.
  function reverseClip(clip) {
    pushHistory();
    clip.reverse = !clip.reverse;
    saveSoon(); renderAll();
    toast(clip.reverse ? 'Clip will play backwards in the render.' : 'Reverse off — clip plays forwards.');
  }
  function freezeClip(clip) {
    pushHistory();
    clip.freeze = clip.freeze && clip.freeze.enabled ? { enabled: false, at: 0, duration: 3 } : { enabled: true, at: Math.max(0, ed.playhead - clip.start), duration: 3 };
    saveSoon(); renderAll();
    toast(clip.freeze.enabled ? `Freeze frame inserted at ${fmtT(clip.freeze.at)} in the clip (3s still, edge-draggable in the render).` : 'Freeze frame removed.');
  }
  async function extractAudio(clip) {
    if (clip.kind !== 'video') { toast('Extract audio works on a video clip.', true); return; }
    try {
      const r = await api(`/api/video/${ed.project.id}/extract-audio`, { method: 'POST', body: JSON.stringify({ clipId: clip.id }) });
      pushHistory();
      const tr = ed.timeline.tracks.find((t) => t.kind === 'audio' && t.id === (r.trackId || (r.clip && r.clip.trackId))) || ed.timeline.tracks.find((t) => t.kind === 'audio');
      if (tr && r.clip) { tr.clips.push(r.clip); }
      saveSoon(); renderAll();
      toast('Audio extracted to the audio track — it is now a normal editable clip.');
    } catch (e) { toast(e.message, true); }
  }
  function toggleLink(clip) {
    const others = allClips(ed.timeline).filter((x) => x.clip.id !== clip.id && Math.abs(x.clip.start - clip.start) < 0.05);
    const audio = others.find((x) => x.clip.kind === 'audio');
    if (clip.linkedTo) { pushHistory(); clip.linkedTo = null; saveSoon(); renderAll(); toast('Clip unlinked from its audio.'); return; }
    if (!audio) { toast('No audio clip starts at the same time — add one first, then link.', true); return; }
    pushHistory();
    clip.linkedTo = audio.clip.id;
    audio.clip.linkedTo = clip.id;
    saveSoon(); renderAll();
    toast('Video and audio linked — they move together (J/L cut).');
  }

  // v2.5.0 — Q/W: delete everything left/right of the playhead.
  function deleteSide(side) {
    const t = ed.playhead;
    pushHistory();
    let n = 0;
    for (const tr of ed.timeline.tracks) {
      tr.clips = tr.clips.filter((c) => {
        const keep = side === 'left' ? (c.start + c.duration > t) : (c.start < t);
        if (!keep) n++;
        return keep;
      });
      // Trim clips straddling the playhead.
      for (const c of tr.clips) {
        if (side === 'left' && c.start < t && c.start + c.duration > t) {
          c.srcStart += (t - c.start) * c.speed;
          c.duration -= (t - c.start);
          c.start = t;
        } else if (side === 'right' && c.start < t && c.start + c.duration > t) {
          c.duration = t - c.start;
        }
      }
    }
    ed.selectedClipIds = new Set(); ed.selectedClipId = null;
    saveSoon(); renderAll();
    toast(n ? `Deleted ${n} clip(s) ${side} of the playhead.` : `Nothing ${side} of the playhead to delete.`);
  }
  // v2.5.0 — J/K/L shuttle: J steps backwards, L forwards, K stops.
  // Repeated presses speed up (1x → 2x → 4x). Video elements cannot play
  // backwards, so reverse shuttle seeks the playhead — the preview follows.
  function startShuttle(dir) {
    stopShuttle();
    setPlaying(false);
    ed.shuttleRate = dir;
    const step = () => {
      if (!ed || !ed.shuttleTimer) return;
      ed.playhead = clamp(ed.playhead + (ed.shuttleRate * 4) / ed.timeline.fps, 0, totalDuration(ed.timeline));
      updatePreview();
      if (ed.playhead <= 0 || ed.playhead >= totalDuration(ed.timeline)) { stopShuttle(); return; }
      ed.shuttleTimer = setTimeout(step, 100);
    };
    ed.shuttleTimer = setTimeout(step, 100);
    toast(dir < 0 ? 'Shuttle reverse (J again = faster, K = stop).' : 'Shuttle forward (L again = faster, K = stop).');
  }
  function stopShuttle() {
    if (ed && ed.shuttleTimer) { clearTimeout(ed.shuttleTimer); ed.shuttleTimer = null; }
  }
  // v2.5.0 — Ctrl+./Ctrl+, nudge the selected clip's volume ±0.05 (0–2).
  function nudgeVolume(d) {
    const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
    if (!found) { toast('Select a clip first to nudge its volume.', true); return; }
    pushHistory();
    found.clip.volume = clamp((found.clip.volume ?? 1) + d, 0, 2);
    saveSoon(); renderAll();
    const db = found.clip.volume <= 0 ? '−∞ dB' : `${(20 * Math.log10(found.clip.volume)).toFixed(1)} dB`;
    toast(`Volume ${Math.round(found.clip.volume * 100)}% (${db}).`);
  }
  // v2.5.0 — project background dialog (solid colour / image / blur-fill).
  function showBackgroundDialog() {
    const bg = ed.timeline.background;
    const cur = typeof bg === 'string' ? { type: 'color', color: bg } : (bg || { type: 'color', color: '#000000' });
    closeMenus();
    const dlg = document.createElement('div');
    dlg.className = 've-ctx card';
    dlg.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9999;min-width:320px;padding:16px;';
    dlg.innerHTML = `<h3>Project background</h3>
      <p class="sub">The canvas behind the clips — used where no clip covers the frame (gaps, letterbox areas).</p>
      <label>Type</label>
      <select id="ve-bg-type">
        <option value="color" ${cur.type === 'color' ? 'selected' : ''}>Solid colour</option>
        <option value="image" ${cur.type === 'image' ? 'selected' : ''}>Image (cover)</option>
        <option value="blur" ${cur.type === 'blur' ? 'selected' : ''}>Blur-fill image</option>
      </select>
      <div id="ve-bg-color-row"><label>Colour</label><input type="color" id="ve-bg-color" value="${esc(cur.color || '#000000')}"></div>
      <div id="ve-bg-img-row" style="display:${cur.type === 'color' ? 'none' : 'block'}"><label>Image media id</label><input type="number" id="ve-bg-media" value="${cur.mediaId || ''}" placeholder="Media id from your library"></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary" id="ve-bg-apply" style="flex:1">Apply</button>
        <button class="btn" id="ve-bg-close">Close</button>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#ve-bg-type').addEventListener('change', (e) => {
      dlg.querySelector('#ve-bg-img-row').style.display = e.target.value === 'color' ? 'none' : 'block';
    });
    dlg.querySelector('#ve-bg-close').addEventListener('click', () => dlg.remove());
    dlg.querySelector('#ve-bg-apply').addEventListener('click', () => {
      const type = dlg.querySelector('#ve-bg-type').value;
      const color = dlg.querySelector('#ve-bg-color').value;
      const mediaId = parseInt(dlg.querySelector('#ve-bg-media').value, 10);
      pushHistory();
      if (type === 'color') ed.timeline.background = color;
      else ed.timeline.background = { type, color, mediaId: Number.isFinite(mediaId) ? mediaId : null };
      dlg.remove();
      saveSoon(); renderAll();
      toast('Background updated.');
    });
  }
  // v2.5.0 — shortcuts panel: every binding + click-to-rebind.
  function showShortcutsPanel() {
    closeMenus();
    const map = ed.shortcuts || loadShortcuts();
    const dlg = document.createElement('div');
    dlg.className = 've-ctx card';
    dlg.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9999;min-width:340px;max-width:92vw;max-height:80vh;overflow:auto;padding:16px;';
    dlg.innerHTML = `<h3>Keyboard shortcuts</h3>
      <p class="sub">Click a shortcut to rebind it — press the new keys, then Enter to save (Esc cancels). Reset restores CapCut's defaults.</p>
      ${DEFAULT_SHORTCUTS.map((s) => `<div class="ve-media-item" style="cursor:pointer" data-rebind="${s.id}">
        <div><div class="nm">${esc(s.label)}</div><div class="mt">${esc(s.hint)}</div></div>
        <span class="badge" style="margin-left:auto" data-key-label="${s.id}">${esc(map[s.id] || s.key)}</span>
      </div>`).join('')}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-sm" id="ve-sc-reset">Reset to defaults</button>
        <button class="btn btn-sm" id="ve-sc-close">Close</button>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#ve-sc-close').addEventListener('click', () => dlg.remove());
    dlg.querySelector('#ve-sc-reset').addEventListener('click', () => {
      const m = {};
      for (const s of DEFAULT_SHORTCUTS) m[s.id] = s.key;
      ed.shortcuts = m;
      saveShortcuts(m);
      dlg.remove();
      toast('Shortcuts reset to CapCut defaults.');
    });
    dlg.querySelectorAll('[data-rebind]').forEach((row) => row.addEventListener('click', () => {
      const id = row.dataset.rebind;
      const label = row.querySelector(`[data-key-label="${id}"]`);
      label.textContent = 'press keys…';
      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { label.textContent = ed.shortcuts[id]; document.removeEventListener('keydown', handler, true); return; }
        if (e.key === 'Enter') { document.removeEventListener('keydown', handler, true); return; }
        const name = keyEventName(e);
        if (['ctrl', 'shift', 'alt'].includes(name)) return; // modifier alone
        ed.shortcuts[id] = name;
        saveShortcuts(ed.shortcuts);
        label.textContent = name;
        document.removeEventListener('keydown', handler, true);
        toast(`"${DEFAULT_SHORTCUTS.find((s) => s.id === id).label}" is now ${name}.`);
      };
      document.addEventListener('keydown', handler, true);
    }));
  }

  function onClipPointerDown(e, el) {
    if (e.button !== 0) return;
    const found = findClip(ed.timeline, el.dataset.clip);
    if (!found) return;
    const { clip, track } = found;
    if (track.locked) { toast('This track is locked. Unlock it to edit clips.', true); return; }
    e.preventDefault();
    // v2.7.0 — Split tool: clicking a clip splits it at the clicked time
    // instead of starting a drag.
    if (ed.toolMode === 'split') {
      const lane = el.closest('.ve-lane');
      const rect = lane ? lane.getBoundingClientRect() : null;
      const t = rect ? (e.clientX - rect.left) / ed.pxPerSec : ed.playhead;
      if (splitClipAtTime(clip, track, t)) toast('Clip split.');
      return;
    }
    ed.selectedClipId = clip.id;
    if (!ed.selectedClipIds || !ed.selectedClipIds.has(clip.id)) ed.selectedClipIds = new Set([clip.id]);
    renderAll();
    const handle = e.target.dataset.handle || null;
    const startX = e.clientX;
    const orig = deep(clip);
    // v2.5.0 — drag set: the multi-selection when the dragged clip is in
    // it, else the clip's group (groupId), else just the clip.
    const sel = selectedClips().filter((x) => x.track.id === track.id).map((x) => x.clip);
    const group = sel.length > 1 && sel.some((c) => c.id === clip.id) ? sel
      : clip.groupId ? allClips(ed.timeline).filter((x) => x.clip.groupId === clip.groupId).map((x) => x.clip) : [clip];
    const groupOrig = group.map((c) => ({ id: c.id, start: c.start, duration: c.duration, srcStart: c.srcStart }));
    // v2.5.0 — slip edit: Alt+drag changes the source in-point without
    // moving the clip on the timeline (J/L-cut friendly).
    const slip = e.altKey && !handle;
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
      if (slip) {
        clip.srcStart = Math.max(0, orig.srcStart + dxSec * clip.speed);
        renderTimeline();
        updatePreview();
        return;
      }
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
      // v2.7.0 — CapCut "Details" panel: real project facts, shown when no
      // clip is selected. Proxy is honestly off (not built); Arrange layers
      // is a real per-project toggle; Modify opens Project settings.
      const settings = ed.projectSettings || {};
      const proxy = settings.proxy || {};
      const aspectId = ASPECTS.find((x) => x.width === ed.timeline.width && x.height === ed.timeline.height);
      const arrangeOn = ed.timeline.arrangeLayers !== false;
      const proxyOn = proxy.enabled === true;
      host.innerHTML = `<h3 class="ve-details-h">Details</h3>
      <div class="ve-details">
        <div class="ve-drow"><span>Name:</span><b>${esc(ed.project.name)}</b></div>
        <div class="ve-drow"><span>Path:</span><span>Project #${ed.project.id}${ed.project.updatedAt ? `<br><small style="color:var(--muted)">updated ${esc(fmtDate(ed.project.updatedAt))}</small>` : ''}</span></div>
        <div class="ve-drow"><span>Imported media:</span><span>Stay in original location<br><small style="color:var(--muted)">Clips reference your Media Library files in place — nothing is copied into the project.</small></span></div>
        <div class="ve-drow"><span>Arrange layers ⓘ</span><span><button class="btn btn-sm" id="ve-arrange-toggle" title="When on, new clips auto-place in the first free slot at the playhead; when off, they append after the last clip on the track.">${arrangeOn ? 'Turned on' : 'Turned off'}</button></span></div>
        <div class="ve-drow"><span>Proxy: ⓘ</span><span><button class="btn btn-sm" id="ve-proxy-note" title="Proxy media is not built in this app.">${proxyOn ? 'Turned on (stored)' : 'Turned off'}</button><br><small style="color:var(--muted)">Proxy media is not built — the preview renders your original files at full quality.</small></span></div>
        <div class="ve-drow"><span>Aspect ratio:</span><span>Original (${aspectId ? aspectId.id : `${ed.timeline.width}×${ed.timeline.height}`})</span></div>
        <div class="ve-drow"><span>Resolution:</span><span>Adapted (${ed.timeline.width}×${ed.timeline.height})</span></div>
      </div>
      <p class="sub" style="margin-top:10px">Timeline: ${ed.timeline.width}×${ed.timeline.height} @ ${ed.timeline.fps}fps · ${fmtT(totalDuration(ed.timeline))} total · ${(ed.timeline.markers || []).length} marker(s) · ${ed.timeline.tracks.length} track(s)</p>
      <p class="sub">Select a clip on the timeline to edit its properties, filters, transition and keyframes.</p>
      <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn btn-sm" id="ve-details-modify">Modify</button></div>`;
      document.getElementById('ve-arrange-toggle').addEventListener('click', () => {
        pushHistory();
        ed.timeline.arrangeLayers = !arrangeOn;
        saveSoon(); renderAll();
        toast(ed.timeline.arrangeLayers === false ? 'Arrange layers off — new clips append after the last clip on the track.' : 'Arrange layers on — new clips auto-place in the first free slot at the playhead.');
      });
      document.getElementById('ve-proxy-note').addEventListener('click', () => {
        toast('Proxy media is not built in this app — editing uses your original files at full quality. The proxy setting is stored in Project settings.');
      });
      document.getElementById('ve-details-modify').addEventListener('click', () => {
        if (typeof openProjectSettingsDialog === 'function') { openProjectSettingsDialog(ed.project.id); refreshAfterSettingsDialog(); }
        else toast('Project settings are available from the Projects view (Ctrl+P).', true);
      });
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
        <div>${field('Volume (0–200%)', slider('cp-volume', clip.volume, 0, 2, 0.05) + ` <span id="cp-volume-db" style="font-size:11px;color:var(--muted)">${clip.volume <= 0 ? '−∞ dB' : `${(20 * Math.log10(clip.volume)).toFixed(1)} dB`}</span>`)}</div>
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
      ${clip.kind === 'video' ? `
      <h3 style="margin-top:14px">Speed</h3>
      ${field('Speed curve (ramp)', `<select id="cp-speedcurve">${['none', 'montage', 'hero', 'bullet', 'jumpcut', 'flashin', 'flashout', 'custom'].map((v) => `<option value="${v}" ${(clip.speedCurve && clip.speedCurve.preset) === v ? 'selected' : ''}>${v === 'none' ? 'None (constant speed)' : v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select>`)}
      <p class="sub">Montage / Hero / Bullet / Jump Cut / Flash In / Flash Out ramp the speed inside one clip (slow → snap fast). Custom uses the keyframe-style points below — add rows as t (0–1) → speed.</p>
      ${(clip.speedCurve && clip.speedCurve.preset === 'custom') ? `<div id="cp-curve-points">${(clip.speedCurve.points || []).map((p, i) => `
        <div class="ve-row"><div><label>t (0–1)</label><input type="number" data-curve="${i}" data-f="t" value="${p.t}" step="0.05" min="0" max="1"></div>
        <div><label>Speed</label><input type="number" data-curve="${i}" data-f="speed" value="${p.speed}" step="0.1" min="0.1" max="100"></div></div>`).join('')}
        <button class="btn btn-sm" id="cp-curve-add">＋ Add point</button></div>` : ''}
      <div class="ve-row">
        <div><button class="btn btn-sm" id="cp-reverse" style="width:100%">${clip.reverse ? '⏪ Reverse: ON' : '⏪ Reverse'}</button></div>
        <div><button class="btn btn-sm" id="cp-freeze" style="width:100%">${clip.freeze && clip.freeze.enabled ? '❄ Freeze: ON' : '❄ Freeze frame'}</button></div>
      </div>
      <div class="ve-row">
        <div><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cp-optical" ${clip.opticalFlow ? 'checked' : ''}> Smooth slow-mo (optical flow)</label></div>
        <div><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cp-stabilize" ${clip.stabilize && clip.stabilize.enabled ? 'checked' : ''}> Stabilise</label></div>
      </div>
      ${clip.stabilize && clip.stabilize.enabled ? field('Stabilise strength', slider('cp-stab-strength', clip.stabilize.strength ?? 0.5, 0, 1, 0.05)) : ''}
      <h3 style="margin-top:14px">Chroma key (green screen)</h3>
      <div class="ve-row">
        <div><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cp-chroma-on" ${clip.chroma && clip.chroma.enabled ? 'checked' : ''}> Enable</label></div>
        <div>${field('Key colour', `<input type="color" id="cp-chroma-color" value="${esc((clip.chroma && clip.chroma.color) || '#00ff00')}">`)}</div>
      </div>
      ${clip.chroma && clip.chroma.enabled ? `
      <div class="ve-row">
        <div>${field('Similarity', slider('cp-chroma-sim', clip.chroma.similarity ?? 0.4, 0.01, 1, 0.01))}</div>
        <div>${field('Blend (fringe clean-up)', slider('cp-chroma-blend', clip.chroma.blend ?? 0.1, 0, 1, 0.01))}</div>
      </div>
      <p class="sub">Pick the colour with the colour box (eyedropper: click the preview, then type the colour here). The background becomes transparent — put the new background on the track below.</p>` : ''}
      <h3 style="margin-top:14px">Mask</h3>
      <div class="ve-row">
        <div>${field('Shape', `<select id="cp-mask-type">${['none', 'circle', 'rect', 'linear', 'mirror', 'heart', 'star'].map((v) => `<option value="${v}" ${((clip.mask && clip.mask.type) || 'none') === v ? 'selected' : ''}>${v === 'none' ? 'None' : v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select>`)}</div>
        <div>${field('Feather (px)', numInput('cp-mask-feather', (clip.mask && clip.mask.feather) ?? 10, 1, 0, 30))}</div>
      </div>
      ${clip.mask && clip.mask.type !== 'none' ? `
      <div class="ve-row">
        <div>${field('Mask X %', numInput('cp-mask-x', clip.mask.x ?? 50, 1, 0, 100))}</div>
        <div>${field('Mask Y %', numInput('cp-mask-y', clip.mask.y ?? 50, 1, 0, 100))}</div>
      </div>
      <div class="ve-row">
        <div>${field('Mask W %', numInput('cp-mask-w', clip.mask.w ?? 60, 1, 1, 100))}</div>
        <div>${field('Mask H %', numInput('cp-mask-h', clip.mask.h ?? 60, 1, 1, 100))}</div>
      </div>
      <div class="ve-row">
        <div>${field('Mask rotation', numInput('cp-mask-rot', clip.mask.rotation || 0, 1, 0, 360))}</div>
        <div><label style="display:flex;gap:6px;align-items:center;margin-top:18px"><input type="checkbox" id="cp-mask-invert" ${clip.mask.invert ? 'checked' : ''}> Invert mask</label></div>
      </div>` : ''}
      <h3 style="margin-top:14px">Auto reframe</h3>
      <div class="ve-row">
        <div><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cp-reframe" ${clip.autoReframe && clip.autoReframe.enabled ? 'checked' : ''}> Auto reframe</label></div>
        <div>${field('Target aspect', `<select id="cp-reframe-aspect">${['', '9:16', '1:1', '4:5'].map((v) => `<option value="${v}" ${((clip.autoReframe && clip.autoReframe.targetAspect) || '') === v ? 'selected' : ''}>${v || 'Same as project'}</option>`).join('')}</select>`)}</div>
      </div>
      <h3 style="margin-top:14px">Video effects on this clip</h3>
      ${(clip.effects || []).length ? (clip.effects || []).map((ef, i) => `
        <div class="ve-row"><div>${field(esc(ef.id), slider(`cp-fx-${i}`, ef.intensity ?? 0.7, 0, 1, 0.05))}</div>
        <div><label>&nbsp;</label><button class="btn btn-sm btn-danger" data-fx-del="${i}" style="width:100%">Remove</button></div></div>`).join('') : '<p class="sub">No effects yet — add some from the Effects tab (left panel).</p>'}
      ${field('Filter preset (one-tap look)', `<select id="cp-filter-preset">${['none', 'vivid', 'retro', 'bw', 'warm', 'cool', 'noir', 'golden', 'teal', 'faded'].map((v) => `<option value="${v}" ${clip.filterPreset === v ? 'selected' : ''}>${v === 'none' ? 'None' : v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select>`)}
      ${clip.lutMediaId ? `<p class="sub">LUT applied (media #${clip.lutMediaId}). <button class="btn btn-sm" id="cp-lut-clear">Remove LUT</button></p>` : ''}
      ${found.track.kind === 'video' && ed.timeline.tracks.filter((t) => t.kind === 'video').indexOf(found.track) > 0 ? `
      <h3 style="margin-top:14px">Overlay position (PiP)</h3>
      <p class="sub">Drag the overlay in the preview to move it, or set it here (percent of the free space).</p>
      <div class="ve-row">
        <div>${field('X %', numInput('cp-ov-x', (clip.overlay && clip.overlay.x) ?? 70, 1, 0, 100))}</div>
        <div>${field('Y %', numInput('cp-ov-y', (clip.overlay && clip.overlay.y) ?? 70, 1, 0, 100))}</div>
      </div>
      <div class="ve-row">
        <div>${field('Width %', numInput('cp-ov-w', (clip.overlay && clip.overlay.w) ?? 30, 1, 5, 100))}</div>
        <div><label style="display:flex;gap:6px;align-items:center;margin-top:18px"><input type="checkbox" id="cp-ov-reset"> Reset to default</label></div>
      </div>` : ''}
      <div class="ve-row" style="margin-top:10px">
        <div><button class="btn btn-sm" id="cp-link" style="width:100%">${clip.linkedTo ? '🔗 Unlink audio-video' : '🔗 Link audio-video'}</button></div>
        <div><button class="btn btn-sm" id="cp-splitscreen" style="width:100%">${clip.splitScreen && clip.splitScreen.enabled ? '▦ Split screen: ON' : '▦ Split screen'}</button></div>
      </div>` : ''}
      ${clip.kind === 'audio' ? `
      <h3 style="margin-top:14px">Voice processing</h3>
      <div class="ve-row">
        <div><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cp-fx-denoise" ${clip.audioFx && clip.audioFx.denoise ? 'checked' : ''}> Noise reduction</label></div>
        <div><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cp-fx-enhance" ${clip.audioFx && clip.audioFx.enhanceVoice ? 'checked' : ''}> Enhance voice</label></div>
      </div>
      <div class="ve-row">
        <div>${field('Vocal isolation', `<select id="cp-fx-vocal">${['off', 'remove', 'keep'].map((v) => `<option value="${v}" ${((clip.audioFx && clip.audioFx.vocalIsolation) || 'off') === v ? 'selected' : ''}>${v === 'off' ? 'Off' : v === 'remove' ? 'Remove vocals' : 'Keep vocals only'}</option>`).join('')}</select>`)}</div>
        <div><label style="display:flex;gap:6px;align-items:center;margin-top:18px"><input type="checkbox" id="cp-fx-loud" ${clip.audioFx && clip.audioFx.loudnorm ? 'checked' : ''}> Loudness normalise</label></div>
      </div>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cp-fx-duck" ${clip.audioFx && clip.audioFx.ducking ? 'checked' : ''}> Auto-duck music under dialogue</label>
      <p class="sub">Voice processing renders with FFmpeg (afftdn / loudnorm / sidechain ducking) — no provider key needed.</p>` : ''}
      ${isText ? `
      ${field('Text', `<textarea id="cp-text" rows="2">${esc(tx.text)}</textarea>`)}
      <div class="ve-row">
        <div>${field('Font family', `<select id="cp-font">${TEXT_FONTS.map((f) => `<option ${tx.fontFamily === f ? 'selected' : ''}>${f}</option>`).join('')}</select>`)}</div>
        <div>${field('Font size', numInput('cp-fontsize', tx.fontSize, 1, 8, 400))}</div>
      </div>
      <div class="ve-row">
        <div>${field('Colour', `<input type="color" id="cp-color" value="${esc(tx.color || '#ffffff')}">`)}</div>
        <div>${field('Caption style', `<select id="cp-capstyle">${CAPTION_STYLES.map((s) => `<option value="${s.id}" ${(tx.captionStyle || 'plain') === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select>`)}</div>
      </div>
      <div class="ve-row">
        <div>${field('Align', `<select id="cp-align">${['left', 'center', 'right'].map((v) => `<option ${tx.align === v ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
        <div>${field('Weight', `<select id="cp-weight">${[400, 700, 800].map((v) => `<option ${tx.fontWeight === v ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
      </div>
      <div class="ve-row">
        <div>${field('Letter spacing (px)', numInput('cp-lettersp', tx.letterSpacing || 0, 0.5, -5, 30))}</div>
        <div>${field('Line height', numInput('cp-lineh', tx.lineHeight || 1.2, 0.1, 0.8, 3))}</div>
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
      </div>
      <div class="ve-row">
        <div><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cp-shadow-on" ${tx.shadow && tx.shadow.enabled ? 'checked' : ''}> Text shadow</label></div>
        <div><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cp-stroke-on" ${tx.stroke && tx.stroke.enabled ? 'checked' : ''}> Text outline (stroke)</label></div>
      </div>
      ${tx.shadow && tx.shadow.enabled ? `<div class="ve-row">
        <div>${field('Shadow colour', `<input type="color" id="cp-shadow-color" value="${esc((tx.shadow && tx.shadow.color) || '#000000')}">`)}</div>
        <div>${field('Shadow offset', numInput('cp-shadow-dx', (tx.shadow && tx.shadow.dx) ?? 2, 1, -20, 20))}</div>
      </div>` : ''}
      ${tx.stroke && tx.stroke.enabled ? `<div class="ve-row">
        <div>${field('Stroke colour', `<input type="color" id="cp-stroke-color" value="${esc((tx.stroke && tx.stroke.color) || '#000000')}">`)}</div>
        <div>${field('Stroke width', numInput('cp-stroke-w', (tx.stroke && tx.stroke.width) ?? 2, 1, 1, 10))}</div>
      </div>` : ''}
      <div class="ve-row">
        <div><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cp-grad-on" ${tx.gradient && tx.gradient.enabled ? 'checked' : ''}> Gradient text</label></div>
      </div>
      ${tx.gradient && tx.gradient.enabled ? `<div class="ve-row">
        <div>${field('Gradient from', `<input type="color" id="cp-grad-1" value="${esc(((tx.gradient && tx.gradient.colors) || ['#ffffff', '#fde047'])[0])}">`)}</div>
        <div>${field('Gradient to', `<input type="color" id="cp-grad-2" value="${esc(((tx.gradient && tx.gradient.colors) || ['#ffffff', '#fde047'])[1])}">`)}</div>
      </div>` : ''}` : ''}
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
    bind('cp-font', (e) => mutate(() => { clip.text.fontFamily = e.target.value; }));
    bind('cp-capstyle', (e) => mutate(() => { clip.text.captionStyle = e.target.value; }));
    bind('cp-lettersp', (e) => mutate(() => { clip.text.letterSpacing = parseFloat(e.target.value) || 0; }));
    bind('cp-lineh', (e) => mutate(() => { clip.text.lineHeight = clamp(parseFloat(e.target.value) || 1.2, 0.8, 3); }));
    const ensureTextSub = (key, def) => { clip.text[key] = clip.text[key] || deep(def); return clip.text[key]; };
    bind('cp-shadow-on', (e) => mutate(() => { const s = ensureTextSub('shadow', { enabled: false, color: '#000000', dx: 2, dy: 2 }); s.enabled = e.target.checked; }));
    bind('cp-shadow-color', (e) => mutate(() => { ensureTextSub('shadow', { enabled: true, color: '#000000', dx: 2, dy: 2 }).color = e.target.value; }));
    bind('cp-shadow-dx', (e) => mutate(() => { const s = ensureTextSub('shadow', { enabled: true, color: '#000000', dx: 2, dy: 2 }); s.dx = parseFloat(e.target.value) || 0; s.dy = s.dx; }));
    bind('cp-stroke-on', (e) => mutate(() => { const s = ensureTextSub('stroke', { enabled: false, color: '#000000', width: 2 }); s.enabled = e.target.checked; }));
    bind('cp-stroke-color', (e) => mutate(() => { ensureTextSub('stroke', { enabled: true, color: '#000000', width: 2 }).color = e.target.value; }));
    bind('cp-stroke-w', (e) => mutate(() => { ensureTextSub('stroke', { enabled: true, color: '#000000', width: 2 }).width = clamp(parseFloat(e.target.value) || 2, 1, 10); }));
    bind('cp-grad-on', (e) => mutate(() => { const g = ensureTextSub('gradient', { enabled: false, colors: ['#ffffff', '#fde047'] }); g.enabled = e.target.checked; }));
    bind('cp-grad-1', (e) => mutate(() => { const g = ensureTextSub('gradient', { enabled: true, colors: ['#ffffff', '#fde047'] }); g.colors[0] = e.target.value; }));
    bind('cp-grad-2', (e) => mutate(() => { const g = ensureTextSub('gradient', { enabled: true, colors: ['#ffffff', '#fde047'] }); g.colors[1] = e.target.value; }));
    // v2.5.0 — video-clip property bindings.
    const ensureClipSub = (key, def) => { clip[key] = clip[key] || deep(def); return clip[key]; };
    bind('cp-speedcurve', (e) => mutate(() => {
      const sc = ensureClipSub('speedCurve', { preset: 'none', points: [] });
      sc.preset = e.target.value;
      if (sc.preset === 'custom' && !sc.points.length) sc.points = [{ t: 0, speed: 1 }, { t: 0.5, speed: 0.5 }, { t: 1, speed: 2 }];
    }));
    host.querySelectorAll('[data-curve]').forEach((el) => el.addEventListener('change', () => {
      mutate(() => {
        const p = clip.speedCurve.points[parseInt(el.dataset.curve, 10)];
        if (!p) return;
        if (el.dataset.f === 't') p.t = clamp(parseFloat(el.value) || 0, 0, 1);
        else p.speed = clamp(parseFloat(el.value) || 1, 0.1, 100);
        clip.speedCurve.points.sort((a, b) => a.t - b.t);
      });
    }));
    const curveAdd = document.getElementById('cp-curve-add');
    if (curveAdd) curveAdd.addEventListener('click', () => mutate(() => {
      const sc = ensureClipSub('speedCurve', { preset: 'custom', points: [] });
      sc.points.push({ t: 0.5, speed: 1 });
      sc.points.sort((a, b) => a.t - b.t);
    }));
    const revBtn = document.getElementById('cp-reverse');
    if (revBtn) revBtn.addEventListener('click', () => reverseClip(clip));
    const frzBtn = document.getElementById('cp-freeze');
    if (frzBtn) frzBtn.addEventListener('click', () => freezeClip(clip));
    bind('cp-optical', (e) => mutate(() => { clip.opticalFlow = e.target.checked; }));
    bind('cp-stabilize', (e) => mutate(() => { ensureClipSub('stabilize', { enabled: false, strength: 0.5 }).enabled = e.target.checked; }));
    bindLive('cp-stab-strength', (v) => { ensureClipSub('stabilize', { enabled: true, strength: 0.5 }).strength = v; updatePreview(); });
    bind('cp-chroma-on', (e) => mutate(() => { ensureClipSub('chroma', { enabled: false, color: '#00ff00', similarity: 0.4, blend: 0.1 }).enabled = e.target.checked; }));
    bind('cp-chroma-color', (e) => mutate(() => { ensureClipSub('chroma', { enabled: true, color: '#00ff00', similarity: 0.4, blend: 0.1 }).color = e.target.value; }));
    bindLive('cp-chroma-sim', (v) => { ensureClipSub('chroma', { enabled: true, color: '#00ff00', similarity: 0.4, blend: 0.1 }).similarity = v; updatePreview(); });
    bindLive('cp-chroma-blend', (v) => { ensureClipSub('chroma', { enabled: true, color: '#00ff00', similarity: 0.4, blend: 0.1 }).blend = v; updatePreview(); });
    bind('cp-mask-type', (e) => mutate(() => { ensureClipSub('mask', { type: 'none', x: 50, y: 50, w: 60, h: 60, rotation: 0, feather: 10, invert: false }).type = e.target.value; }));
    bind('cp-mask-feather', (e) => mutate(() => { ensureClipSub('mask', { type: 'circle', x: 50, y: 50, w: 60, h: 60, rotation: 0, feather: 10, invert: false }).feather = clamp(parseFloat(e.target.value) || 0, 0, 30); }));
    bind('cp-mask-x', (e) => mutate(() => { ensureClipSub('mask', { type: 'circle', x: 50, y: 50, w: 60, h: 60, rotation: 0, feather: 10, invert: false }).x = clamp(parseFloat(e.target.value) || 50, 0, 100); }));
    bind('cp-mask-y', (e) => mutate(() => { ensureClipSub('mask', { type: 'circle', x: 50, y: 50, w: 60, h: 60, rotation: 0, feather: 10, invert: false }).y = clamp(parseFloat(e.target.value) || 50, 0, 100); }));
    bind('cp-mask-w', (e) => mutate(() => { ensureClipSub('mask', { type: 'circle', x: 50, y: 50, w: 60, h: 60, rotation: 0, feather: 10, invert: false }).w = clamp(parseFloat(e.target.value) || 60, 1, 100); }));
    bind('cp-mask-h', (e) => mutate(() => { ensureClipSub('mask', { type: 'circle', x: 50, y: 50, w: 60, h: 60, rotation: 0, feather: 10, invert: false }).h = clamp(parseFloat(e.target.value) || 60, 1, 100); }));
    bind('cp-mask-rot', (e) => mutate(() => { ensureClipSub('mask', { type: 'circle', x: 50, y: 50, w: 60, h: 60, rotation: 0, feather: 10, invert: false }).rotation = clamp(parseFloat(e.target.value) || 0, 0, 360); }));
    bind('cp-mask-invert', (e) => mutate(() => { ensureClipSub('mask', { type: 'circle', x: 50, y: 50, w: 60, h: 60, rotation: 0, feather: 10, invert: false }).invert = e.target.checked; }));
    bind('cp-reframe', (e) => mutate(() => { ensureClipSub('autoReframe', { enabled: false, targetAspect: '' }).enabled = e.target.checked; }));
    bind('cp-reframe-aspect', (e) => mutate(() => { ensureClipSub('autoReframe', { enabled: true, targetAspect: '' }).targetAspect = e.target.value; }));
    bind('cp-filter-preset', (e) => mutate(() => {
      clip.filterPreset = e.target.value;
      const preset = (ed.fxCache && ed.fxCache.filterPresets || []).find((p) => p.id === e.target.value);
      if (preset && preset.sliders) clip.filters = { ...(clip.filters || {}), ...preset.sliders };
    }));
    const lutClear = document.getElementById('cp-lut-clear');
    if (lutClear) lutClear.addEventListener('click', () => mutate(() => { clip.lutMediaId = null; }));
    host.querySelectorAll('[data-fx-del]').forEach((el) => el.addEventListener('click', () => mutate(() => { (clip.effects || []).splice(parseInt(el.dataset.fxDel, 10), 1); })));
    for (let i = 0; i < (clip.effects || []).length; i++) {
      bindLive(`cp-fx-${i}`, (v) => { if (clip.effects[i]) clip.effects[i].intensity = v; updatePreview(); });
    }
    bind('cp-ov-x', (e) => mutate(() => { clip.overlay = clip.overlay || { x: 70, y: 70, w: 30 }; clip.overlay.x = clamp(parseFloat(e.target.value) || 70, 0, 100); }));
    bind('cp-ov-y', (e) => mutate(() => { clip.overlay = clip.overlay || { x: 70, y: 70, w: 30 }; clip.overlay.y = clamp(parseFloat(e.target.value) || 70, 0, 100); }));
    bind('cp-ov-w', (e) => mutate(() => { clip.overlay = clip.overlay || { x: 70, y: 70, w: 30 }; clip.overlay.w = clamp(parseFloat(e.target.value) || 30, 5, 100); }));
    bind('cp-ov-reset', (e) => mutate(() => { if (e.target.checked) clip.overlay = null; }));
    const linkBtn = document.getElementById('cp-link');
    if (linkBtn) linkBtn.addEventListener('click', () => toggleLink(clip));
    const ssBtn = document.getElementById('cp-splitscreen');
    if (ssBtn) ssBtn.addEventListener('click', () => {
      const sel = selectedClips().filter((x) => x.clip.kind === 'video');
      if (clip.splitScreen && clip.splitScreen.enabled) {
        mutate(() => { clip.splitScreen.enabled = false; });
        toast('Split screen off for this clip.');
        return;
      }
      if (sel.length < 2) { toast('Select a second video clip too (Ctrl+click), then turn split screen on.', true); return; }
      const other = sel.find((x) => x.clip.id !== clip.id);
      mutate(() => {
        clip.splitScreen = { enabled: true, partnerClipId: other.clip.id };
        other.clip.splitScreen = { enabled: true, partnerClipId: clip.id };
      });
      toast('Split screen on — the two clips render side by side.');
    });
    // v2.5.0 — audio FX bindings.
    bind('cp-fx-denoise', (e) => mutate(() => { ensureClipSub('audioFx', { denoise: false, enhanceVoice: false, vocalIsolation: 'off', loudnorm: false, ducking: false }).denoise = e.target.checked; }));
    bind('cp-fx-enhance', (e) => mutate(() => { ensureClipSub('audioFx', { denoise: false, enhanceVoice: false, vocalIsolation: 'off', loudnorm: false, ducking: false }).enhanceVoice = e.target.checked; }));
    bind('cp-fx-vocal', (e) => mutate(() => { ensureClipSub('audioFx', { denoise: false, enhanceVoice: false, vocalIsolation: 'off', loudnorm: false, ducking: false }).vocalIsolation = e.target.value; }));
    bind('cp-fx-loud', (e) => mutate(() => { ensureClipSub('audioFx', { denoise: false, enhanceVoice: false, vocalIsolation: 'off', loudnorm: false, ducking: false }).loudnorm = e.target.checked; }));
    bind('cp-fx-duck', (e) => mutate(() => { ensureClipSub('audioFx', { denoise: false, enhanceVoice: false, vocalIsolation: 'off', loudnorm: false, ducking: false }).ducking = e.target.checked; }));
    // v2.5.0 — volume 0–2 with a live dB readout.
    const volDb = document.getElementById('cp-volume-db');
    const volEl = document.getElementById('cp-volume');
    if (volEl) volEl.addEventListener('input', () => {
      const v = parseFloat(volEl.value);
      clip.volume = v;
      if (volDb) volDb.textContent = v <= 0 ? '−∞ dB' : `${(20 * Math.log10(v)).toFixed(1)} dB`;
      updatePreview();
    });
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
      <p class="sub">Position (%), scale (0.5–3), opacity (0–1), rotation (0–360°) and volume (0–2) interpolate between keyframes; each keyframe's easing shapes the segment to the next one. Rendered with FFmpeg (pan via crop, zoom via sampled segments, opacity via per-frame alpha, rotation + volume interpolated in the render). At least 2 keyframes make a visible animation.</p>
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
            <div><label>Rotation °</label><input type="number" data-kf="${i}" data-f="rotation" value="${k.rotation ?? 0}" step="5" min="0" max="360"></div>
          </div>
          <div class="ve-row">
            <div><label>Volume (0–2)</label><input type="number" data-kf="${i}" data-f="volume" value="${k.volume ?? 1}" step="0.1" min="0" max="2"></div>
            <div><label>Easing → next</label><select data-kf="${i}" data-f="easing">${['linear', 'ease-in', 'ease-out', 'ease-in-out'].map((v) => `<option value="${v}" ${(k.easing || 'linear') === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          </div>
          <div class="ve-row">
            <div><label>&nbsp;</label><button class="btn btn-sm btn-danger" data-kf-del="${i}" style="width:100%">Delete</button></div>
          </div>
        </div>`).join('') : '<p class="sub">No keyframes yet — the clip plays at its base position/scale/opacity.</p>'}`;
    document.getElementById('kf-add').addEventListener('click', () => {
      const rel = clamp(ed.playhead - clip.start, 0, clip.duration);
      pushHistory();
      clip.keyframes = clip.keyframes || [];
      // Sample current interpolated values so the new keyframe holds the pose.
      const cur = sampleKeyframe(clip, rel);
      clip.keyframes.push({ t: Math.round(rel * 100) / 100, x: cur.x, y: cur.y, scale: cur.scale, opacity: cur.opacity, rotation: cur.rotation ?? 0, volume: cur.volume ?? 1, easing: 'linear' });
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
      else if (el.dataset.f === 'rotation') k.rotation = clamp(v || 0, 0, 360);
      else if (el.dataset.f === 'volume') k.volume = clamp(v, 0, 2);
      else if (el.dataset.f === 'easing') k.easing = el.value;
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
    const out = { x: 50, y: 50, scale: 1, opacity: 1, rotation: 0, volume: 1 };
    const kfs = [...(clip.keyframes || [])].sort((a, b) => a.t - b.t);
    if (!kfs.length) return out;
    // v2.5.0 — easing: the starting keyframe's easing shapes the segment
    // to the next keyframe (ease-in/out/in-out, else linear).
    const ease = (f, kind) => {
      if (kind === 'ease-in') return f * f;
      if (kind === 'ease-out') return 1 - (1 - f) * (1 - f);
      if (kind === 'ease-in-out') return f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
      return f;
    };
    for (const p of ['x', 'y', 'scale', 'opacity', 'rotation', 'volume']) {
      const def = kfs.filter((k) => k[p] !== undefined);
      if (!def.length) continue;
      if (time <= def[0].t) { out[p] = def[0][p]; continue; }
      if (time >= def[def.length - 1].t) { out[p] = def[def.length - 1][p]; continue; }
      for (let i = 0; i < def.length - 1; i++) {
        const a = def[i], b = def[i + 1];
        if (time >= a.t && time <= b.t) { out[p] = a[p] + (b[p] - a[p]) * ease((time - a.t) / (b.t - a.t || 1), a.easing); break; }
      }
    }
    return out;
  }

  // v2.5.0 — drag an overlay (PiP) clip inside the preview to move it.
  // Writes clip.overlay {x,y,w,h} percent, so preview == render.
  function onOverlayDragStart(ev, clip) {
    ev.preventDefault();
    ev.stopPropagation();
    const stage = document.getElementById('ve-stage');
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const el = ev.currentTarget;
    const elRect = el.getBoundingClientRect();
    const startX = ev.clientX, startY = ev.clientY;
    const orig = clip.overlay ? { ...clip.overlay } : { x: 70, y: 70, w: 30, h: null };
    if (orig.h === null) orig.h = Math.round(orig.w * (ed.timeline.height / ed.timeline.width) / (stageRect.width / stageRect.height) * 100 / 100);
    let moved = false;
    const onMove = (e2) => {
      const dxPct = ((e2.clientX - startX) / stageRect.width) * 100;
      const dyPct = ((e2.clientY - startY) / stageRect.height) * 100;
      if (!moved && Math.abs(e2.clientX - startX) + Math.abs(e2.clientY - startY) > 3) { pushHistory(); moved = true; }
      if (!moved) return;
      clip.overlay = {
        x: clamp((orig.x ?? 70) + dxPct * (100 / (100 - (orig.w ?? 30))), 0, 100),
        y: clamp((orig.y ?? 70) + dyPct * (100 / (100 - (orig.h ?? 30))), 0, 100),
        w: orig.w ?? 30,
      };
      // Position math: overlay x/y are the fraction of the free space
      // (stageW - w), matching the renderer. Convert pointer delta to
      // that space: delta_px / (stageW - w_px) * 100.
      const wPx = elRect.width;
      const hPx = elRect.height;
      clip.overlay.x = clamp((orig.x ?? 70) + ((e2.clientX - startX) / Math.max(1, stageRect.width - wPx)) * 100, 0, 100);
      clip.overlay.y = clamp((orig.y ?? 70) + ((e2.clientY - startY) / Math.max(1, stageRect.height - hPx)) * 100, 0, 100);
      updatePreview();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (moved) { ed.selectedClipId = clip.id; saveSoon(); renderAll(); toast('Overlay moved — its new position renders exactly like this.'); }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  // v2.5.0 — audio waveforms: fetch peaks once per media id, cache them.
  async function getWaveform(mediaId) {
    if (!ed) return null;
    ed.waveforms = ed.waveforms || {};
    if (ed.waveforms[mediaId] !== undefined) return ed.waveforms[mediaId];
    try {
      const r = await api(`/api/media/${mediaId}/waveform`);
      ed.waveforms[mediaId] = r.peaks || null;
      return ed.waveforms[mediaId];
    } catch { ed.waveforms[mediaId] = null; return null; }
  }
  function waveformBars(peaks, widthPx) {
    if (!peaks || !peaks.length) return '';
    const n = Math.max(8, Math.min(120, Math.floor(widthPx / 4)));
    const step = peaks.length / n;
    let bars = '';
    for (let i = 0; i < n; i++) {
      const v = peaks[Math.floor(i * step)] || 0;
      const h = Math.max(8, Math.round(v * 100));
      bars += `<span style="height:${h}%"></span>`;
    }
    return `<div class="ve-wave">${bars}</div>`;
  }

  /* ---------------- Export tab (real FFmpeg jobs) ---------------- */
  function renderExportTab(host) {
    const job = ed.currentJob;
    const presets = (ed.fxCache && ed.fxCache.exportPresets) || [
      { id: 'tiktok', name: 'TikTok / Reels / Shorts — 1080×1920 · 30fps', resolution: '1080p', fps: 30, format: 'mp4', aspect: '9:16' },
      { id: 'youtube', name: 'YouTube — 1080p · 30fps · 16:9', resolution: '1080p', fps: 30, format: 'mp4', aspect: '16:9' },
      { id: 'youtube4k', name: 'YouTube 4K — 2160p · 30fps', resolution: '4K', fps: 30, format: 'mp4', aspect: '16:9' },
      { id: 'instagram', name: 'Instagram Feed — 1080×1080 · 30fps', resolution: '1080p', fps: 30, format: 'mp4', aspect: '1:1' },
    ];
    host.innerHTML = `<h3>Export — FFmpeg render</h3>
      <p class="sub">Renders the real timeline to a playable file (libx264/libx265 + AAC). Progress comes from FFmpeg itself — no simulated bars.</p>
      <label>Platform preset</label>
      <select id="ex-preset"><option value="">Custom (choose below)</option>${presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
      <label>File name</label>
      <input type="text" id="ex-filename" value="${esc(ed.project.name || 'creative-studio-render')}" placeholder="File name (no extension)">
      <div class="ve-row">
        <div><label>Resolution</label>
        <select id="ex-res"><option value="720p">720p HD</option><option value="1080p">1080p Full HD</option><option value="2K">2K (2560×1440)</option><option value="4K">4K (3840×2160)</option></select></div>
        <div><label>Frame rate</label>
        <select id="ex-fps"><option value="24">24 fps</option><option value="25">25 fps</option><option value="30" selected>30 fps</option><option value="50">50 fps</option><option value="60">60 fps</option></select></div>
      </div>
      <div class="ve-row">
        <div><label>Format</label>
        <select id="ex-format"><option value="mp4">MP4 — plays everywhere</option><option value="mov">MOV — QuickTime container</option><option value="webm">WebM (VP9)</option></select></div>
        <div><label>Codec</label>
        <select id="ex-codec"><option value="h264">H.264</option><option value="hevc">HEVC / H.265</option></select></div>
      </div>
      <div class="ve-row">
        <div><label>Quality</label>
        <select id="ex-quality"><option value="medium">Balanced</option><option value="high">High</option><option value="low">Smaller file</option><option value="custom">Custom bitrate</option></select></div>
        <div><label>Bitrate (kbps, custom)</label><input type="number" id="ex-bitrate" value="8000" step="500" min="500" max="80000"></div>
      </div>
      <div class="ve-row">
        <div><label>Audio bitrate</label>
        <select id="ex-abitrate"><option value="128k">128 kbps</option><option value="192k">192 kbps</option><option value="256k">256 kbps</option><option value="320k">320 kbps</option></select></div>
        <div><label>Audio sample rate</label>
        <select id="ex-arate"><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option></select></div>
      </div>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ex-hdr"> HDR export (10-bit, HEVC only)</label>
      <p class="sub" style="margin-top:8px">Output: ${ed.timeline.width}×${ed.timeline.height} aspect · ${fmtT(totalDuration(ed.timeline))} long (transitions shorten it) · ${ed.timeline.fps}fps timeline</p>
      <p class="sub" id="ex-estimate"></p>
      <div style="margin:12px 0;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="ex-render" style="flex:1;justify-content:center">▶ Render video</button>
        <button class="btn btn-sm" id="ex-est">Estimate size</button>
        <button class="btn btn-sm" id="ex-open-center">📤 Open Export Center</button>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn btn-sm" id="ex-audio-mp3">🎵 Audio only (MP3)</button>
        <button class="btn btn-sm" id="ex-audio-wav">🎵 Audio only (WAV)</button>
        <button class="btn btn-sm" id="ex-frame">🖼 Current frame (PNG)</button>
        <button class="btn btn-sm" id="ex-gif">🎞 GIF (3s from playhead)</button>
      </div>
      <div class="error" id="ex-error"></div>
      <div id="ex-job">${job ? jobHtml(job) : '<p class="sub">No render yet for this session. Finished renders also appear in the Export Center.</p>'}</div>
      <h3 style="margin-top:14px">Export queue</h3>
      <div id="ex-queue"><p class="sub">Loading queue…</p></div>`;
    const presetSel = document.getElementById('ex-preset');
    presetSel.addEventListener('change', () => {
      const p = presets.find((x) => x.id === presetSel.value);
      if (!p) return;
      document.getElementById('ex-res').value = p.resolution;
      document.getElementById('ex-fps').value = String(p.fps);
      document.getElementById('ex-format').value = p.format;
      if (p.aspect) {
        const a = { '16:9': '16:9', '9:16': '9:16', '1:1': '1:1', '4:5': '4:5' }[p.aspect];
        if (a) toast(`Preset "${p.name}" chosen — set the timeline ratio to ${a} in the toolbar if the project is not already ${a}.`);
      }
    });
    const collectSettings = () => ({
      resolution: document.getElementById('ex-res').value,
      fps: parseInt(document.getElementById('ex-fps').value, 10),
      format: document.getElementById('ex-format').value,
      codec: document.getElementById('ex-codec').value,
      quality: document.getElementById('ex-quality').value,
      bitrate: parseInt(document.getElementById('ex-bitrate').value, 10) || undefined,
      audioBitrate: document.getElementById('ex-abitrate').value,
      audioSampleRate: parseInt(document.getElementById('ex-arate').value, 10),
      hdr: document.getElementById('ex-hdr').checked,
      filename: document.getElementById('ex-filename').value.trim() || undefined,
    });
    const startRender = async (extra) => {
      const errBox = document.getElementById('ex-error');
      errBox.style.display = 'none';
      try {
        await saveTimeline(false);
        const r = await api('/api/video/jobs', {
          method: 'POST',
          body: JSON.stringify({ projectId: ed.project.id, settings: { ...collectSettings(), ...(extra || {}) } }),
        });
        ed.currentJob = r.job;
        toast('Render queued — progress shows below and in the Export Center.');
        renderProps();
        pollJob(r.job.id);
      } catch (e) {
        errBox.textContent = e.message;
        errBox.style.display = 'block';
      }
    };
    document.getElementById('ex-render').addEventListener('click', () => startRender());
    document.getElementById('ex-open-center').addEventListener('click', () => go('export'));
    document.getElementById('ex-est').addEventListener('click', async () => {
      const box = document.getElementById('ex-estimate');
      box.textContent = 'Estimating…';
      try {
        const r = await api('/api/video/estimate', { method: 'POST', body: JSON.stringify({ timeline: ed.timeline, settings: collectSettings() }) });
        box.textContent = `Estimated size: ~${fmtBytes(r.bytes)} for ${r.durationSeconds.toFixed(1)}s at ${r.bitrateKbps} kbps. (Estimate from bitrate × duration.)`;
      } catch (e) { box.textContent = `Estimate unavailable: ${e.message}`; }
    });
    document.getElementById('ex-audio-mp3').addEventListener('click', () => startRender({ audioOnly: true, audioFormat: 'mp3' }));
    document.getElementById('ex-audio-wav').addEventListener('click', () => startRender({ audioOnly: true, audioFormat: 'wav' }));
    document.getElementById('ex-gif').addEventListener('click', () => startRender({ gifExport: true, gifStart: Math.round(ed.playhead * 100) / 100, gifDuration: 3 }));
    document.getElementById('ex-frame').addEventListener('click', () => {
      // Current frame as PNG: draw the preview video element to a canvas.
      const v = document.getElementById('ve-va');
      if (!v || v.style.display === 'none' || !v.videoWidth) { toast('No video frame under the playhead to capture.', true); return; }
      try {
        const canvas = document.createElement('canvas');
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        canvas.getContext('2d').drawImage(v, 0, 0);
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = `${(ed.project.name || 'frame').replace(/[^\w\-]+/g, '_')}-${Math.round(ed.playhead * 100) / 100}s.png`;
        a.click();
        toast('Frame saved as PNG.');
      } catch (e) { toast(`Frame capture failed: ${e.message}`, true); }
    });
    const cur = document.getElementById('ex-job');
    if (cur) bindJobButtons(cur);
    // Export queue: all jobs for this project, newest first.
    (async () => {
      const box = document.getElementById('ex-queue');
      if (!box) return;
      try {
        const { jobs } = await api('/api/video/jobs');
        const mine = jobs.filter((j) => j.projectId === ed.project.id);
        if (!mine.length) { box.innerHTML = '<p class="sub">No exports yet for this project.</p>'; return; }
        box.innerHTML = mine.slice(0, 8).map((j) => `<div class="ve-media-item"><div><div class="nm">Job #${j.id} — ${esc(j.status)} · ${j.progress}%</div><div class="mt">${esc(j.settings.resolution || '')} · ${esc(String(j.settings.fps || ''))}fps${j.settings.format ? ` · ${esc(j.settings.format.toUpperCase())}` : ''}${j.error ? ` · ${esc(j.error.slice(0, 80))}` : ''}</div></div></div>`).join('');
      } catch { box.innerHTML = '<p class="sub">Queue could not be loaded.</p>'; }
    })();
  }

  function jobHtml(job) {
    const badge = { queued: 'warn', running: '', done: 'ok', failed: 'err', cancelled: 'err' }[job.status] || '';
    return `<div class="ve-job">
      <div><b>Job #${job.id}</b> <span class="badge ${badge}">${job.status}</span> <span style="float:right">${job.progress}%</span></div>
      <div class="ve-progress"><div style="width:${job.progress}%"></div></div>
      <div class="sub">${esc(job.settings.resolution || '')} · ${esc(String(job.settings.fps || ''))}fps${job.settings.format ? ` · ${esc(job.settings.format.toUpperCase())}` : ''}</div>
      ${job.error ? `<div class="error" style="display:block">${esc(job.error)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        ${job.status === 'done' && job.hasOutput ? `<a class="btn btn-sm btn-primary" href="/api/video/jobs/${job.id}/download">⬇ Download ${job.settings.audioOnly ? (job.settings.audioFormat || 'MP3').toUpperCase() : job.settings.gifExport ? 'GIF' : (job.settings.format || 'mp4').toUpperCase()}</a>` : ''}
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
      let allMedia = { media: [] };
      try { allMedia = await api('/api/media?limit=200'); } catch { /* ignore */ }
      const items = media.media;
      const byId = {};
      for (const m of [...(items || []), ...(allMedia.media || [])]) byId[m.id] = m;
      const aiMedia = (allMedia.media || []).filter((m) => (m.tags || '').includes('ai-generated') || (m.tags || '').includes('ai-processed'));
      const mediaItem = (m, meta) => `
          <div class="ve-media-item" data-add-media="${m.id}">
            ${m.thumbnailUrl ? `<img src="${m.thumbnailUrl}" alt="">` : `<span style="font-size:22px">${m.kind === 'audio' ? '🎵' : m.kind === 'image' ? '🖼️' : '🎬'}</span>`}
            <div><div class="nm">${esc(m.originalName)}</div>
            <div class="mt">${meta}</div></div>
          </div>`;
      const videoItemsHtml = items.length ? items.map((m) => mediaItem(m, `${m.kind}${m.durationSeconds ? ` · ${m.durationSeconds.toFixed(1)}s` : ''}${m.width ? ` · ${m.width}×${m.height}` : ''}${m.fps ? ` · ${m.fps}fps` : ''}`)).join('') : '<p class="sub">No video in your library yet. Upload some first.</p>';
      const allItemsHtml = (allMedia.media || []).length ? (allMedia.media || []).map((m) => mediaItem(m, `${m.kind}${m.durationSeconds ? ` · ${m.durationSeconds.toFixed(1)}s` : ''}${m.width ? ` · ${m.width}×${m.height}` : ''}`)).join('') : '<p class="sub">Your Media Library is empty — upload something first.</p>';
      const aiItemsHtml = aiMedia.length ? aiMedia.map((m) => mediaItem(m, `${m.kind}${m.durationSeconds ? ` · ${m.durationSeconds.toFixed(1)}s` : ''} · AI-generated`)).join('') : '<p class="sub">No AI-generated media yet — create some in AI Studio and it lands here.</p>';
      const timelineClips = allClips(ed.timeline).slice().sort((a, b) => a.clip.start - b.clip.start);
      const timelineClipsHtml = timelineClips.length ? timelineClips.map(({ clip, track }) => `
          <div class="ve-media-item" data-seek-clip="${clip.id}">
            <span style="font-size:22px">🎬</span>
            <div><div class="nm">${esc(clip.name)}</div>
            <div class="mt">${esc(track.name)} · ${fmtT(clip.start)} – ${fmtT(clip.start + clip.duration)}</div></div>
          </div>`).join('') : '<p class="sub">No clips on the timeline yet — add media from the Media tab.</p>';
      const avatarNoteHtml = `<p class="sub" style="margin-top:8px"><b>AI avatars:</b> no visual avatar video exists in this app — avatars are not built. Voices (spoken narration) live in the Voices view.</p><button class="btn btn-sm" id="ve-avatar-open-voices">Open Voices →</button>`;
      const uploadPickedFiles = async (files) => {
        const ok = [...(files || [])].filter((f) => /^(video|audio|image)\//.test(f.type));
        if (!ok.length) { toast('Choose videos, photos or audio files.', true); return; }
        for (const f of ok) {
          const fd = new FormData(); fd.append('file', f);
          try { await apiForm('/api/media/upload', fd); }
          catch (e) { toast(e.message, true); return; }
        }
        toast(`Uploaded ${ok.length} file(s). Probing duration/size…`);
        renderLeftPanel();
      };
      // v2.7.0 — CapCut Media panel: Import menu, Media / Timeline /
      // Subprojects tabs, Import drop zone, "create with these tools",
      // collapsible Yours / Generate / Spaces / Library sections.
      const sub = ed.mediaTab || 'media';
      const mediaHead = `<div class="ve-import-row"><button class="btn btn-sm btn-primary" id="ve-import-btn">Import ▾</button><input type="file" id="ve-import-file" accept="video/*,audio/*,image/*" multiple style="display:none"></div>
        <div class="ve-subtabs" style="margin-top:8px">${[['media', 'Media'], ['timeline', 'Timeline'], ['subprojects', 'Subprojects']].map(([id, label]) => `<button class="btn btn-sm ${sub === id ? 'btn-primary' : ''}" data-mtab="${id}">${label}</button>`).join('')}</div>`;
      const wireMediaHead = () => {
        host.querySelectorAll('[data-mtab]').forEach((b) => b.addEventListener('click', () => { ed.mediaTab = b.dataset.mtab; renderLeftPanel(); }));
        const fi = document.getElementById('ve-import-file');
        if (fi) fi.addEventListener('change', async () => { if (!fi.files.length) return; const files = [...fi.files]; fi.value = ''; await uploadPickedFiles(files); });
        const impBtn = document.getElementById('ve-import-btn');
        if (impBtn) impBtn.addEventListener('click', (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          showMenu(r.left, r.bottom + 6, [
            { label: 'Import files…', fn: () => document.getElementById('ve-import-file').click() },
            { label: 'Import from Media Library', fn: () => { ed.openSection = 'library'; renderLeftPanel().then(() => { const d = document.getElementById('ve-sec-library'); if (d) { d.open = true; d.scrollIntoView({ block: 'nearest' }); } }); } },
          ]);
        });
      };
      if (sub === 'timeline') {
        body = `${mediaHead}<p class="sub">Clips on this timeline, in order. Click one to jump the playhead to it and select it.</p>${timelineClipsHtml}`;
        host.innerHTML = body;
        wireMediaHead();
        host.querySelectorAll('[data-seek-clip]').forEach((el) => el.addEventListener('click', () => {
          const found = findClip(ed.timeline, el.dataset.seekClip);
          if (!found) return;
          ed.selectedClipId = found.clip.id;
          ed.selectedClipIds = new Set([found.clip.id]);
          ed.playhead = found.clip.start;
          setPlaying(false);
          renderAll();
        }));
        return;
      }
      if (sub === 'subprojects') {
        body = `${mediaHead}<p class="sub">Sub-projects don't exist in this app — projects are flat, with no nested sub-project media.</p><p class="sub">To start something new, create a project from Home → New Project.</p><button class="btn btn-sm btn-primary" id="ve-sub-new">＋ New Project</button>`;
        host.innerHTML = body;
        wireMediaHead();
        document.getElementById('ve-sub-new').addEventListener('click', () => { if (typeof openNewProjectFlow === 'function') openNewProjectFlow(); else go('video-editor'); });
        return;
      }
      body = `${mediaHead}
        <div class="ve-dropzone" id="ve-dropzone" role="button" tabindex="0" title="Click to choose files, or drag files here"><span class="ve-dz-plus">＋</span><b>Import</b><span class="ve-dz-sub">Drag and drop videos, photos, and audio files here</span></div>
        <div style="display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;margin:4px 0 2px"><span style="flex:1;border-top:1px solid var(--border)"></span>No media? Create with these tools<span style="flex:1;border-top:1px solid var(--border)"></span></div>
        <div class="ve-create-tools">
          <button class="btn" id="ve-create-generate">✨ Generate</button>
          <button class="btn" id="ve-create-avatars">🪪 AI avatars</button>
          <button class="btn" id="ve-create-record">🎙️ Record</button>
        </div>
        <div id="ve-avatar-note">${ed.avatarNoteShown ? avatarNoteHtml : ''}</div>
        <details class="ve-section" id="ve-sec-yours" ${ed.openSection !== 'library' && ed.openSection !== 'generate' && ed.openSection !== 'spaces' ? 'open' : ''}><summary>Yours</summary><div class="ve-sec-body"><p class="sub">Your videos — click one to add it at the playhead on the video track. Audio lives in the Audio tab.</p>${videoItemsHtml}</div></details>
        <details class="ve-section" id="ve-sec-generate" ${ed.openSection === 'generate' ? 'open' : ''}><summary>Generate <span class="ve-ai-badge">AI</span></summary><div class="ve-sec-body"><p class="sub">Media generated by this app's AI — click one to add it at the playhead.</p>${aiItemsHtml}<button class="btn btn-sm" id="ve-gen-open-ai" style="margin-top:6px">Open AI Studio →</button></div></details>
        <details class="ve-section" id="ve-sec-spaces" ${ed.openSection === 'spaces' ? 'open' : ''}><summary>Spaces</summary><div class="ve-sec-body"><p class="sub">Spaces (cloud projects shared across devices) don't exist in this app — projects live on this machine. The Spaces shortcut on Home opens your local Projects list instead.</p><button class="btn btn-sm" id="ve-spaces-open">Open Projects →</button></div></details>
        <details class="ve-section" id="ve-sec-library" ${ed.openSection === 'library' ? 'open' : ''}><summary>Library</summary><div class="ve-sec-body"><p class="sub">Everything in your Media Library — click to add at the playhead.</p>${allItemsHtml}</div></details>
        <h3 style="margin-top:14px">Stock video (Pexels)</h3>
        <p class="sub">Free stock video — needs a Pexels API key (free at pexels.com/api; add it in Settings → AI Providers → Stock Video). Without a key this search honestly says so.</p>
        <div class="ve-row"><input type="text" id="ve-stock-video-q" placeholder="Search stock video…" value="${esc(ed.stockVideoQ || '')}"><button class="btn btn-sm" id="ve-stock-video-go">Search</button></div>
        <div id="ve-stock-video-results"><p class="sub">Type a search and press Search.</p></div>`;
      host.innerHTML = body;
      wireMediaHead();
      const dz = document.getElementById('ve-dropzone');
      if (dz) {
        const fi = document.getElementById('ve-import-file');
        dz.addEventListener('click', () => fi.click());
        dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
        dz.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('ve-drop'); });
        dz.addEventListener('dragleave', () => dz.classList.remove('ve-drop'));
        dz.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('ve-drop'); uploadPickedFiles(e.dataTransfer.files); });
      }
      const wireAvatarNote = () => {
        const av = document.getElementById('ve-avatar-open-voices');
        if (av) av.addEventListener('click', () => go('voices'));
      };
      wireAvatarNote();
      document.getElementById('ve-create-generate').addEventListener('click', () => go('ai-studio'));
      document.getElementById('ve-create-avatars').addEventListener('click', () => {
        ed.avatarNoteShown = true;
        const box = document.getElementById('ve-avatar-note');
        if (box) { box.innerHTML = avatarNoteHtml; wireAvatarNote(); }
        toast('AI avatars are not built in this app — no visual avatar video exists. Voices live in the Voices view.');
      });
      document.getElementById('ve-create-record').addEventListener('click', () => {
        switchLeftTab('audio', 'voiceover');
        toast('Voiceover — record with your microphone at the playhead.');
      });
      document.getElementById('ve-gen-open-ai').addEventListener('click', () => go('ai-studio'));
      document.getElementById('ve-spaces-open').addEventListener('click', () => go('projects'));
      host.querySelectorAll('[data-add-media]').forEach((el) => el.addEventListener('click', async () => {
        const m = byId[el.dataset.addMedia];
        if (!m) return;
        addMediaClip(m);
      }));
      const doStockVideoSearch = async () => {
        const q = document.getElementById('ve-stock-video-q').value.trim();
        ed.stockVideoQ = q;
        const box = document.getElementById('ve-stock-video-results');
        box.innerHTML = '<p class="sub">Searching…</p>';
        try {
          const r = await api(`/api/stock/search?type=video&q=${encodeURIComponent(q)}`);
          const results = r.results || [];
          if (!results.length) { box.innerHTML = '<p class="sub">No stock videos found for that search.</p>'; return; }
          box.innerHTML = results.map((v) => `
            <div class="ve-media-item" data-stock-video="${esc(String(v.id))}">
              ${v.thumbUrl ? `<img src="${esc(v.thumbUrl)}" alt="">` : `<span style="font-size:22px">🎬</span>`}
              <div><div class="nm">${esc(v.title || v.id)}</div>
              <div class="mt">Pexels${v.durationSeconds ? ` · ${v.durationSeconds.toFixed(0)}s` : ''} — click to save + add</div></div>
            </div>`).join('');
          box.querySelectorAll('[data-stock-video]').forEach((el) => el.addEventListener('click', async () => {
            try {
              const saved = await api('/api/stock/save', { method: 'POST', body: JSON.stringify({ type: 'video', id: el.dataset.stockVideo }) });
              const m = saved.media;
              if (!m) throw new Error('Stock save returned no media.');
              addMediaClip({ ...m, kind: 'video', originalName: m.originalName });
              toast(`Stock video saved to your library and added at the playhead${saved.duplicate ? ' (already in your library — no second copy made)' : ''}.`);
            } catch (e) { toast(e.message, true); }
          }));
        } catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
      };
      document.getElementById('ve-stock-video-go').addEventListener('click', doStockVideoSearch);
      document.getElementById('ve-stock-video-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doStockVideoSearch(); });
    } else if (tab === 'audio') {
      ed.audioSub = ed.audioSub || 'library';
      const subs = [['library', 'Library'], ['stock', 'Stock Music'], ['sfx', 'Sound FX'], ['voiceover', 'Voiceover'], ['tts', 'Narration (TTS)']];
      body = `<div class="ve-subtabs">${subs.map(([id, label]) => `<button class="btn btn-sm ${ed.audioSub === id ? 'btn-primary' : ''}" data-audio-sub="${id}">${label}</button>`).join('')}</div><div id="ve-audio-body">Loading…</div>`;
      host.innerHTML = body;
      host.querySelectorAll('[data-audio-sub]').forEach((b) => b.addEventListener('click', () => { ed.audioSub = b.dataset.audioSub; renderLeftPanel(); }));
      const ab = document.getElementById('ve-audio-body');
      if (ed.audioSub === 'library') {
        let audio = { media: [] };
        try { audio = await api('/api/media?kind=audio'); } catch { /* ignore */ }
        const items = audio.media;
        ab.innerHTML = `<p class="sub">Click an audio file to add it at the playhead on the audio track. Volume and fades are set per clip in the right panel.</p>
          <button class="btn btn-sm" id="ve-upload-audio" style="margin-bottom:10px">⬆ Upload audio</button>
          <input type="file" id="ve-audio-file" accept="audio/*" style="display:none">
          ${items.length ? items.map((m) => `
            <div class="ve-media-item" data-add-media="${m.id}">
              <span style="font-size:22px">🎵</span>
              <div><div class="nm">${esc(m.originalName)}</div>
              <div class="mt">audio${m.durationSeconds ? ` · ${m.durationSeconds.toFixed(1)}s` : ''}</div></div>
            </div>`).join('') : '<p class="sub">No audio in your library yet. Upload some first — your own music or voice recordings.</p>'}`;
        const fi = document.getElementById('ve-audio-file');
        document.getElementById('ve-upload-audio').addEventListener('click', () => fi.click());
        fi.addEventListener('change', async () => {
          if (!fi.files.length) return;
          const fd = new FormData();
          fd.append('file', fi.files[0]);
          try { await apiForm('/api/media/upload', fd); toast('Uploaded. Probing duration…'); renderLeftPanel(); }
          catch (e) { toast(e.message, true); }
        });
        ab.querySelectorAll('[data-add-media]').forEach((el) => el.addEventListener('click', async () => {
          const m = audio.media.find((x) => String(x.id) === el.dataset.addMedia);
          if (!m) return;
          addMediaClip(m);
        }));
      } else if (ed.audioSub === 'stock' || ed.audioSub === 'sfx') {
        // v2.5.0 #11 — stock music / SFX inside the editor (Openverse audio,
        // licensed-only, saved into the library before use).
        const cat = ed.audioSub === 'sfx' ? 'sound-effects' : '';
        ab.innerHTML = `<p class="sub">${ed.audioSub === 'sfx' ? 'Sound effects from Openverse (free, licensed).' : 'Stock music from Openverse (free, licensed).'} Click one to save it to your library and add it at the playhead.</p>
          <div class="ve-row"><input type="text" id="ve-stock-audio-q" placeholder="Search ${ed.audioSub === 'sfx' ? 'sound effects' : 'music'}…" value="${esc(ed.stockAudioQ || '')}"><button class="btn btn-sm" id="ve-stock-audio-go">Search</button></div>
          <div id="ve-stock-audio-results"><p class="sub">Type a search and press Search.</p></div>`;
        const doSearch = async () => {
          const q = document.getElementById('ve-stock-audio-q').value.trim();
          ed.stockAudioQ = q;
          const box = document.getElementById('ve-stock-audio-results');
          box.innerHTML = '<p class="sub">Searching…</p>';
          try {
            const r = await api(`/api/stock/search?type=audio&q=${encodeURIComponent(q)}${cat ? `&category=${cat}` : ''}`);
            const results = r.results || [];
            if (!results.length) { box.innerHTML = '<p class="sub">No results for that search.</p>'; return; }
            box.innerHTML = results.map((v) => `
              <div class="ve-media-item" data-stock-audio="${esc(String(v.id))}">
                <span style="font-size:22px">🎵</span>
                <div><div class="nm">${esc(v.title || v.id)}</div>
                <div class="mt">${esc(v.license || 'licensed')}${v.durationSeconds ? ` · ${v.durationSeconds.toFixed(0)}s` : ''} — click to save + add</div></div>
              </div>`).join('');
            box.querySelectorAll('[data-stock-audio]').forEach((el) => el.addEventListener('click', async () => {
              try {
                const saved = await api('/api/stock/save', { method: 'POST', body: JSON.stringify({ type: 'audio', id: el.dataset.stockAudio }) });
                const m = saved.media;
                if (!m) throw new Error('Stock save returned no media.');
                addMediaClip({ ...m, kind: 'audio', originalName: m.originalName });
                toast(`Saved to your library and added at the playhead${saved.duplicate ? ' (already in your library — no second copy made)' : ''}.`);
              } catch (e) { toast(e.message, true); }
            }));
          } catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
        };
        document.getElementById('ve-stock-audio-go').addEventListener('click', doSearch);
        document.getElementById('ve-stock-audio-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
      } else if (ed.audioSub === 'voiceover') {
        // v2.5.0 #12 — in-app voiceover recording (MediaRecorder).
        ab.innerHTML = `<p class="sub">Record a voiceover with your microphone — it lands as a normal trimmable audio clip at the playhead, in sync with playback. The take is uploaded to your Media Library.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
            <button class="btn btn-primary" id="ve-vo-rec">● Record</button>
            <button class="btn btn-danger" id="ve-vo-stop" disabled>■ Stop</button>
          </div>
          <p class="sub" id="ve-vo-status">Not recording. Your browser will ask for microphone permission.</p>
          <div id="ve-vo-result"></div>`;
        let recorder = null, chunks = [];
        document.getElementById('ve-vo-rec').addEventListener('click', async () => {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            recorder = new MediaRecorder(stream);
            chunks = [];
            recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
            recorder.onstop = async () => {
              stream.getTracks().forEach((t) => t.stop());
              const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
              if (!blob.size) { document.getElementById('ve-vo-status').textContent = 'The recording came back empty — try again.'; return; }
              const fd = new FormData();
              fd.append('file', new File([blob], `voiceover-${Date.now()}.webm`, { type: blob.type }));
              document.getElementById('ve-vo-status').textContent = 'Uploading the take…';
              try {
                const up = await apiForm('/api/media/upload', fd);
                const m = up.media || up;
                document.getElementById('ve-vo-status').textContent = `Take saved (${(blob.size / 1024).toFixed(0)} KB).`;
                document.getElementById('ve-vo-result').innerHTML = `<button class="btn btn-sm btn-primary" id="ve-vo-add">＋ Add take to timeline at playhead</button>`;
                document.getElementById('ve-vo-add').addEventListener('click', () => {
                  addMediaClip({ id: m.id, kind: 'audio', originalName: m.originalName || 'Voiceover take', durationSeconds: m.durationSeconds });
                  toast('Voiceover added at the playhead.');
                });
              } catch (e) { document.getElementById('ve-vo-status').textContent = `Upload failed: ${e.message}`; }
            };
            recorder.start();
            document.getElementById('ve-vo-rec').disabled = true;
            document.getElementById('ve-vo-stop').disabled = false;
            document.getElementById('ve-vo-status').textContent = '● Recording… speak now. Press Stop when done.';
          } catch (e) {
            document.getElementById('ve-vo-status').textContent = `Microphone not available: ${e.message || e}. Allow microphone access and try again.`;
          }
        });
        document.getElementById('ve-vo-stop').addEventListener('click', () => {
          if (recorder && recorder.state !== 'inactive') recorder.stop();
          document.getElementById('ve-vo-rec').disabled = false;
          document.getElementById('ve-vo-stop').disabled = true;
        });
      } else if (ed.audioSub === 'tts') {
        // v2.5.0 #39 — TTS → timeline clip handoff.
        let profiles = [];
        try { const r = await api('/api/voice/profiles'); profiles = r.profiles || []; } catch { /* ignore */ }
        ab.innerHTML = `<p class="sub">Generate a voiceover from text (your own voice or an AI voice), then add it to the timeline at the playhead as a real audio clip.</p>
          ${profiles.length ? `<label>Voice</label><select id="ve-tts-voice">${profiles.map((p) => `<option value="${p.id}">${esc(p.name)}${p.isDefault ? ' (default)' : ''}</option>`).join('')}</select>` : '<p class="sub">No voice profile yet — create one in AI Studio → Voices first (your own voice from a sample, or an AI voice).</p>'}
          <label>Text to speak (max 2000 chars)</label>
          <textarea id="ve-tts-text" rows="3" placeholder="Type the narration…"></textarea>
          <button class="btn btn-primary" id="ve-tts-go" style="margin-top:8px" ${profiles.length ? '' : 'disabled'}>🔊 Generate voice</button>
          <p class="sub" id="ve-tts-status"></p>
          <div id="ve-tts-result"></div>`;
        const goBtn = document.getElementById('ve-tts-go');
        if (goBtn) goBtn.addEventListener('click', async () => {
          const text = document.getElementById('ve-tts-text').value.trim();
          if (!text) { toast('Type some text to speak first.', true); return; }
          const st = document.getElementById('ve-tts-status');
          st.textContent = 'Generating…';
          try {
            const r = await api('/api/voice/synthesise', { method: 'POST', body: JSON.stringify({ text, voiceProfileId: parseInt(document.getElementById('ve-tts-voice').value, 10) }) });
            st.textContent = `Generated with ${esc(r.provider || 'voice')} ${r.cached ? '(cached)' : ''}.`;
            document.getElementById('ve-tts-result').innerHTML = `<button class="btn btn-sm btn-primary" id="ve-tts-add">＋ Add voice to timeline at playhead</button>`;
            document.getElementById('ve-tts-add').addEventListener('click', () => {
              addMediaClip({ id: r.mediaId, kind: 'audio', originalName: `Narration: ${text.slice(0, 40)}`, durationSeconds: null });
              toast('Narration added at the playhead.');
            });
          } catch (e) { st.textContent = e.message; }
        });
      }
    } else if (tab === 'effects') {
      let presets = { presets: [] };
      try { presets = await api('/api/magic/animate/presets'); } catch { /* ignore */ }
      const clipPresets = (presets.presets || []).filter((p) => (p.appliesTo || []).includes('clip'));
      let fx = { effects: [] };
      try { fx = await api('/api/video/effects'); } catch { /* ignore */ }
      const vfx = fx.effects || [];
      body = `<p class="sub"><b>Video effects</b> — click one to apply it to the selected clip (intensity 0.7; fine-tune it in the right panel). Effects render with FFmpeg. These are <b>not</b> transitions: a transition joins two clips and lives in the Transitions tab.</p>
        ${vfx.length ? vfx.map((v) => `
          <div class="ve-media-item" data-apply-vfx="${esc(v.id)}" style="cursor:pointer"><div><div class="nm">${esc(v.name)}</div>
          <div class="mt">${esc(v.description || '')}</div></div></div>`).join('')
        : '<p class="sub">No video effects listed by the server yet.</p>'}
        <button class="btn btn-sm" id="ve-add-adjust" style="margin:10px 0">＋ Add adjustment layer (affects everything beneath)</button>
        <p class="sub"><b>Motion animations</b> — click one to apply it to the selected clip (it expands into real keyframes).</p>
        ${clipPresets.length ? clipPresets.map((p) => `
          <div class="ve-media-item" data-apply-preset="${esc(p.id)}" style="cursor:pointer"><div><div class="nm">${esc(p.name)}</div>
          <div class="mt">${esc(p.description || '')} · ${p.durationMs}ms${p.loop ? ' · loops' : ''}</div></div></div>`).join('')
        : '<p class="sub">No clip presets available.</p>'}
        <p class="sub" style="margin-top:10px">No clip selected? Select one on the timeline first — the effect lands on it. Or add keyframes by hand in the right panel (Keyframes tab).</p>
        <button class="btn btn-sm" id="ve-effects-open" style="margin-top:6px">Open Animation Studio →</button>`;
      host.innerHTML = body;
      document.getElementById('ve-effects-open').addEventListener('click', () => go('animation'));
      document.getElementById('ve-add-adjust').addEventListener('click', () => {
        pushHistory();
        let tr = ed.timeline.tracks.find((t) => t.kind === 'effect');
        if (!tr) {
          tr = { id: uid('track'), kind: 'effect', name: 'Adjustment', locked: false, muted: false, clips: [] };
          ed.timeline.tracks.push(tr);
        }
        const total = totalDuration(ed.timeline) || 5;
        tr.clips.push({ id: uid('clip'), mediaId: null, kind: 'effect', name: 'Adjustment layer', start: 0, duration: total, srcStart: 0, speed: 1, volume: 0, muted: true, fadeIn: 0, fadeOut: 0, rotation: 0, flip: 'none', opacity: 1, scaleMode: 'fit', zoom: 1, filters: {}, transition: { type: 'none', duration: 0 }, groupId: null, effectId: 'vignette', intensity: 0.5, text: null, keyframes: [] });
        saveSoon(); renderAll();
        toast('Adjustment layer added — pick its effect in the right panel (Clip tab).');
      });
      host.querySelectorAll('[data-apply-vfx]').forEach((el) => el.addEventListener('click', () => {
        const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
        if (!found) { toast('Select a clip on the timeline first, then apply an effect.', true); return; }
        pushHistory();
        found.clip.effects = found.clip.effects || [];
        const existing = found.clip.effects.find((x) => x.id === el.dataset.applyVfx);
        if (existing) existing.intensity = 0.7;
        else found.clip.effects.push({ id: el.dataset.applyVfx, intensity: 0.7 });
        saveSoon(); renderAll();
        toast(`Effect applied to "${found.clip.name}".`);
      }));
      host.querySelectorAll('[data-apply-preset]').forEach((el) => el.addEventListener('click', async () => {
        const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
        if (!found) { toast('Select a clip on the timeline first, then apply an effect.', true); return; }
        const preset = clipPresets.find((p) => p.id === el.dataset.applyPreset);
        try {
          const r = await api('/api/magic/animate', { method: 'POST', body: JSON.stringify({ clip: found.clip, presetId: el.dataset.applyPreset }) });
          pushHistory();
          Object.assign(found.clip, r.clip);
          saveSoon(); renderAll();
          toast(`Applied "${preset ? preset.name : el.dataset.applyPreset}" — ${(r.keyframes || []).length} keyframes.`);
        } catch (e) { toast(e.message, true); }
      }));
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
        <button class="btn btn-sm" id="ve-captions-open" style="margin-top:6px">Open Auto Captions →</button>
        <h3 style="margin-top:14px">Caption workflow</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
          <button class="btn btn-sm" id="ve-srt-import">⬆ Import SRT</button>
          <input type="file" id="ve-srt-file" accept=".srt" style="display:none">
          <button class="btn btn-sm" id="ve-srt-export">⬇ Export SRT</button>
          <button class="btn btn-sm" id="ve-txt-export">⬇ Export TXT</button>
          <button class="btn btn-sm" id="ve-cap-split">✂ Split caption at playhead (B)</button>
        </div>
        <p class="sub">Batch edit — one caption per line, in timeline order. Apply writes them back to the clips.</p>
        <textarea id="ve-cap-batch" rows="${Math.max(3, Math.min(10, textClips.length))}" style="width:100%">${esc(textClips.map(({ clip }) => (clip.text && clip.text.text) || '').join('\n'))}</textarea>
        <button class="btn btn-sm btn-primary" id="ve-cap-apply" style="margin-top:6px">Apply batch edit</button>
        <h3 style="margin-top:14px">Caption styles</h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${CAPTION_STYLES.map((s) => `<button class="btn btn-sm" data-cap-style="${s.id}">${esc(s.name)}</button>`).join('')}</div>
        <p class="sub">Applies the style to the selected text clip (colour / glow / highlight).</p>`;
      host.innerHTML = body;
      host.querySelectorAll('[data-seek-clip]').forEach((el) => el.addEventListener('click', () => {
        const found = findClip(ed.timeline, el.dataset.seekClip);
        if (!found) return;
        ed.selectedClipId = found.clip.id;
        ed.selectedClipIds = new Set([found.clip.id]);
        ed.playhead = found.clip.start;
        setPlaying(false);
        renderAll();
      }));
      document.getElementById('ve-captions-open').addEventListener('click', () => go('captions'));
      const srtFile = document.getElementById('ve-srt-file');
      document.getElementById('ve-srt-import').addEventListener('click', () => srtFile.click());
      srtFile.addEventListener('change', async () => {
        if (!srtFile.files.length) return;
        const srt = await srtFile.files[0].text();
        try {
          const r = await api(`/api/video/${ed.project.id}/captions/import`, { method: 'POST', body: JSON.stringify({ srt }) });
          const clips = r.clips || [];
          if (!clips.length) { toast('The SRT file had no usable cues.', true); return; }
          pushHistory();
          let tr = ed.timeline.tracks.find((t) => t.kind === 'text');
          if (!tr) { tr = { id: uid('track'), kind: 'text', name: 'Text 1', locked: false, muted: false, clips: [] }; ed.timeline.tracks.push(tr); }
          for (const c of clips) tr.clips.push(c);
          saveSoon(); renderAll();
          toast(`Imported ${clips.length} caption(s) from the SRT file.`);
        } catch (e) { toast(e.message, true); }
      });
      const downloadText = (filename, text, type) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      };
      document.getElementById('ve-srt-export').addEventListener('click', async () => {
        try {
          const r = await api(`/api/video/${ed.project.id}/captions/export?format=srt`);
          downloadText(`${ed.project.name || 'captions'}.srt`, r.srt || '', 'text/plain');
        } catch (e) { toast(e.message, true); }
      });
      document.getElementById('ve-txt-export').addEventListener('click', async () => {
        try {
          const r = await api(`/api/video/${ed.project.id}/captions/export?format=txt`);
          downloadText(`${ed.project.name || 'captions'}.txt`, r.text || '', 'text/plain');
        } catch (e) { toast(e.message, true); }
      });
      document.getElementById('ve-cap-split').addEventListener('click', () => splitCaptionAtPlayhead());
      document.getElementById('ve-cap-apply').addEventListener('click', () => {
        const lines = document.getElementById('ve-cap-batch').value.split('\n');
        pushHistory();
        textClips.forEach(({ clip }, i) => { if (lines[i] !== undefined) clip.text.text = lines[i]; });
        saveSoon(); renderAll();
        toast('Batch caption edit applied.');
      });
      host.querySelectorAll('[data-cap-style]').forEach((b) => b.addEventListener('click', () => {
        const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
        if (!found || found.clip.kind !== 'text') { toast('Select a text clip first, then pick a caption style.', true); return; }
        pushHistory();
        found.clip.text.captionStyle = b.dataset.capStyle;
        const style = CAPTION_STYLES.find((s) => s.id === b.dataset.capStyle);
        if (style) { found.clip.text.color = style.color || found.clip.text.color; }
        saveSoon(); renderAll();
        toast(`Caption style "${style ? style.name : b.dataset.capStyle}" applied.`);
      }));
    } else if (tab === 'filters') {
      let fx = { filters: [], filterPresets: [] };
      try { fx = await api('/api/video/effects'); } catch { /* ignore */ }
      const presets = fx.filterPresets || [];
      body = `<p class="sub">Colour filters, per clip. Select a clip on the timeline, then move the sliders in the right panel (Clip tab → Colour &amp; filters). Filters apply to the preview and to the FFmpeg render.</p>
        <h3>One-tap looks</h3>
        ${presets.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${presets.map((p) => `<button class="btn btn-sm" data-filter-preset="${esc(p.id)}">${esc(p.name)}</button>`).join('')}</div>` : '<p class="sub">No presets listed by the server yet.</p>'}
        <h3 style="margin-top:12px">Custom LUT (.CUBE / .3DL)</h3>
        <p class="sub">Upload a LUT file and apply it to the selected clip — it renders with FFmpeg lut3d.</p>
        <button class="btn btn-sm" id="ve-lut-upload">⬆ Upload LUT</button>
        <input type="file" id="ve-lut-file" accept=".cube,.3dl" style="display:none">
        <h3 style="margin-top:12px">Sliders</h3>
        ${(fx.filters || []).map((f) => `<div class="ve-media-item"><div><div class="nm">${esc(f.name)}</div><div class="mt">${f.min} to ${f.max}</div></div></div>`).join('') || '<p class="sub">No filters available.</p>'}`;
      host.innerHTML = body;
      host.querySelectorAll('[data-filter-preset]').forEach((b) => b.addEventListener('click', () => {
        const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
        if (!found) { toast('Select a clip first, then pick a look.', true); return; }
        const preset = presets.find((p) => p.id === b.dataset.filterPreset);
        if (!preset) return;
        pushHistory();
        found.clip.filterPreset = preset.id;
        found.clip.filters = { ...(found.clip.filters || {}), ...(preset.sliders || {}) };
        saveSoon(); renderAll();
        toast(`Look "${preset.name}" applied to "${found.clip.name}".`);
      }));
      const lutFile = document.getElementById('ve-lut-file');
      document.getElementById('ve-lut-upload').addEventListener('click', () => lutFile.click());
      lutFile.addEventListener('change', async () => {
        if (!lutFile.files.length) return;
        const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
        if (!found) { toast('Select a clip first, then upload a LUT for it.', true); return; }
        const fd = new FormData();
        fd.append('file', lutFile.files[0]);
        try {
          const up = await apiForm('/api/media/upload', fd);
          const m = up.media || up;
          pushHistory();
          found.clip.lutMediaId = m.id;
          saveSoon(); renderAll();
          toast(`LUT "${lutFile.files[0].name}" applied to "${found.clip.name}".`);
        } catch (e) { toast(e.message, true); }
      });
    } else if (tab === 'stickers') {
      ed.stickerSub = ed.stickerSub || 'library';
      const subs = [['library', 'Library'], ['stock', 'Stock images'], ['ai', 'AI sticker']];
      body = `<div class="ve-subtabs">${subs.map(([id, label]) => `<button class="btn btn-sm ${ed.stickerSub === id ? 'btn-primary' : ''}" data-sticker-sub="${id}">${label}</button>`).join('')}</div><div id="ve-sticker-body">Loading…</div>`;
      host.innerHTML = body;
      host.querySelectorAll('[data-sticker-sub]').forEach((b) => b.addEventListener('click', () => { ed.stickerSub = b.dataset.stickerSub; renderLeftPanel(); }));
      const sb = document.getElementById('ve-sticker-body');
      if (ed.stickerSub === 'library') {
        // v2.5.0 #1 — bundled sticker library (local SVGs, no key needed).
        let list = [];
        try { const r = await fetch('/stickers/index.json'); const j = await r.json(); list = j.stickers || []; } catch { list = []; }
        sb.innerHTML = `<p class="sub">Bundled stickers — click one to place it as a picture-in-picture overlay (3s, bottom-right by default). Drag it in the preview to move it; keyframes move it over time.</p>
          ${list.length ? `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">${list.map((s) => `
            <button class="ve-sticker-cell" data-bundle-sticker="${esc(s.file)}" title="${esc(s.name)}" style="border:1px solid var(--border);border-radius:8px;background:var(--bg2);padding:8px;cursor:pointer">
              <img src="${esc(s.file)}" alt="${esc(s.name)}" style="width:100%;height:auto;display:block">
              <span style="font-size:10px">${esc(s.name)}</span>
            </button>`).join('')}</div>` : '<p class="sub">Bundled sticker library could not be loaded.</p>'}
          <p class="sub" style="margin-top:10px">Your own images also work as stickers — upload a transparent PNG below.</p>
          <button class="btn btn-sm" id="ve-upload-sticker">⬆ Upload sticker image</button>
          <input type="file" id="ve-sticker-file" accept="image/*" style="display:none">`;
        const sfi = document.getElementById('ve-sticker-file');
        document.getElementById('ve-upload-sticker').addEventListener('click', () => sfi.click());
        sfi.addEventListener('change', async () => {
          if (!sfi.files.length) return;
          const fd = new FormData();
          fd.append('file', sfi.files[0]);
          try { await apiForm('/api/media/upload', fd); toast('Uploaded.'); renderLeftPanel(); }
          catch (e) { toast(e.message, true); }
        });
        sb.querySelectorAll('[data-bundle-sticker]').forEach((el) => el.addEventListener('click', async () => {
          try {
            const res = await fetch(el.dataset.bundleSticker);
            const blob = await res.blob();
            const name = el.dataset.bundleSticker.split('/').pop();
            const fd = new FormData();
            fd.append('file', new File([blob], name, { type: 'image/svg+xml' }));
            const up = await apiForm('/api/media/upload', fd);
            const m = up.media || up;
            addSticker({ id: m.id, originalName: name });
          } catch (e) { toast(e.message, true); }
        }));
      } else if (ed.stickerSub === 'stock') {
        sb.innerHTML = `<p class="sub">Stock images from Openverse — click one to save it to your library and place it as a sticker.</p>
          <div class="ve-row"><input type="text" id="ve-stock-img-q" placeholder="Search stock images…" value="${esc(ed.stockImgQ || '')}"><button class="btn btn-sm" id="ve-stock-img-go">Search</button></div>
          <div id="ve-stock-img-results"><p class="sub">Type a search and press Search.</p></div>`;
        const doSearch = async () => {
          const q = document.getElementById('ve-stock-img-q').value.trim();
          ed.stockImgQ = q;
          const box = document.getElementById('ve-stock-img-results');
          box.innerHTML = '<p class="sub">Searching…</p>';
          try {
            const r = await api(`/api/stock/search?type=image&q=${encodeURIComponent(q)}`);
            const results = r.results || [];
            if (!results.length) { box.innerHTML = '<p class="sub">No results for that search.</p>'; return; }
            box.innerHTML = results.map((v) => `
              <div class="ve-media-item" data-stock-img="${esc(String(v.id))}">
                ${v.thumbUrl ? `<img src="${esc(v.thumbUrl)}" alt="">` : `<span style="font-size:22px">🖼️</span>`}
                <div><div class="nm">${esc(v.title || v.id)}</div><div class="mt">${esc(v.license || 'licensed')} — click to save + place</div></div>
              </div>`).join('');
            box.querySelectorAll('[data-stock-img]').forEach((el) => el.addEventListener('click', async () => {
              try {
                const saved = await api('/api/stock/save', { method: 'POST', body: JSON.stringify({ type: 'image', id: el.dataset.stockImg }) });
                const m = saved.media;
                if (!m) throw new Error('Stock save returned no media.');
                addSticker({ id: m.id, originalName: m.originalName });
              } catch (e) { toast(e.message, true); }
            }));
          } catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
        };
        document.getElementById('ve-stock-img-go').addEventListener('click', doSearch);
        document.getElementById('ve-stock-img-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
      } else if (ed.stickerSub === 'ai') {
        sb.innerHTML = `<p class="sub">Describe a sticker — the AI image generator draws it (transparent-background style), then it is placed on the timeline. Needs an image provider key (Settings → AI Providers); without one the job fails honestly.</p>
          <label>Sticker prompt</label>
          <input type="text" id="ve-ai-sticker-prompt" placeholder="e.g. a cute cat wearing sunglasses">
          <button class="btn btn-primary" id="ve-ai-sticker-go" style="margin-top:8px">✨ Generate sticker</button>
          <p class="sub" id="ve-ai-sticker-status"></p>`;
        document.getElementById('ve-ai-sticker-go').addEventListener('click', async () => {
          const prompt = document.getElementById('ve-ai-sticker-prompt').value.trim();
          if (!prompt) { toast('Describe the sticker first.', true); return; }
          const st = document.getElementById('ve-ai-sticker-status');
          st.textContent = 'Generating…';
          try {
            const r = await api('/api/ai/jobs', { method: 'POST', body: JSON.stringify({ mode: 'image', prompt: `sticker, ${prompt}, bold flat vector, transparent background, centred, no text` }) });
            const jobId = r.job.id;
            const poll = async () => {
              const jr = await api(`/api/ai/jobs/${jobId}`);
              if (jr.job.status === 'done' && jr.job.outputMediaId) {
                st.textContent = 'Sticker ready — placing it.';
                addSticker({ id: jr.job.outputMediaId, originalName: `AI sticker: ${prompt.slice(0, 40)}` });
              } else if (jr.job.status === 'failed') {
                st.textContent = `Generation failed: ${jr.job.error || 'see AI Studio'}`;
              } else if (['queued', 'running'].includes(jr.job.status)) {
                setTimeout(poll, 2000);
              }
            };
            poll();
          } catch (e) { st.textContent = e.message; }
        });
      }
    } else if (tab === 'text') {
      const savedStyles = loadTextStyles();
      body = `<p class="sub">Add a text overlay at the playhead, then style it in the right panel (font, colour, position, fade/slide animation).</p>
        <button class="btn btn-primary" id="ve-add-text" style="width:100%;justify-content:center">＋ Add text clip (3s)</button>
        <h3 style="margin-top:14px">Title templates</h3>
        ${TEXT_TEMPLATES.map((t) => `<div class="ve-media-item" data-text-template="${t.id}" style="cursor:pointer"><div><div class="nm">${esc(t.name)}</div><div class="mt">${esc(t.fontFamily)} · ${t.fontSize}px · ${esc(t.animIn)} in</div></div></div>`).join('')}
        <h3 style="margin-top:14px">Your saved styles</h3>
        <p class="sub">Save the selected text clip's style here (kept in this browser), then apply it to any text clip.</p>
        ${savedStyles.length ? savedStyles.map((s, i) => `<div class="ve-media-item" data-apply-style="${i}" style="cursor:pointer"><div><div class="nm">${esc(s.name)}</div><div class="mt">${esc(s.fontFamily)} · ${s.fontSize}px · ${esc(s.color)}</div></div><button class="btn btn-sm btn-danger" data-del-style="${i}" style="margin-left:auto">✕</button></div>`).join('') : '<p class="sub">No saved styles yet.</p>'}
        <button class="btn btn-sm" id="ve-save-style" style="margin-top:6px">💾 Save selected text clip's style</button>
        <p class="sub" style="margin-top:12px">Text renders with FFmpeg drawtext — same font, size, colour and position as the preview.</p>`;
      host.innerHTML = body;
      document.getElementById('ve-add-text').addEventListener('click', () => {
        pushHistory();
        const tr = ed.timeline.tracks.find((t) => t.kind === 'text');
        const c = defaultClip('text', null, ed.playhead, 3);
        tr.clips.push(c);
        ed.selectedClipId = c.id;
        ed.selectedClipIds = new Set([c.id]);
        saveSoon(); renderAll();
      });
      host.querySelectorAll('[data-text-template]').forEach((el) => el.addEventListener('click', () => {
        const t = TEXT_TEMPLATES.find((x) => x.id === el.dataset.textTemplate);
        if (!t) return;
        pushHistory();
        const tr = ed.timeline.tracks.find((x) => x.kind === 'text');
        const c = defaultClip('text', null, ed.playhead, 3);
        c.text = { ...c.text, ...t, text: t.text };
        c.name = `Text: ${t.name}`;
        tr.clips.push(c);
        ed.selectedClipId = c.id;
        ed.selectedClipIds = new Set([c.id]);
        saveSoon(); renderAll();
        toast(`Title template "${t.name}" added at the playhead.`);
      }));
      host.querySelectorAll('[data-apply-style]').forEach((el) => el.addEventListener('click', (e) => {
        if (e.target.dataset.delStyle !== undefined) return;
        const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
        if (!found || found.clip.kind !== 'text') { toast('Select a text clip first, then apply a saved style.', true); return; }
        const s = savedStyles[parseInt(el.dataset.applyStyle, 10)];
        if (!s) return;
        pushHistory();
        Object.assign(found.clip.text, { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, align: s.align, animIn: s.animIn, animOut: s.animOut });
        saveSoon(); renderAll();
        toast(`Style "${s.name}" applied.`);
      }));
      host.querySelectorAll('[data-del-style]').forEach((el) => el.addEventListener('click', (e) => {
        e.stopPropagation();
        const list = loadTextStyles();
        list.splice(parseInt(el.dataset.delStyle, 10), 1);
        saveTextStyles(list);
        renderLeftPanel();
      }));
      document.getElementById('ve-save-style').addEventListener('click', () => {
        const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
        if (!found || found.clip.kind !== 'text') { toast('Select a text clip first, then save its style.', true); return; }
        const name = prompt('Style name', found.clip.text.text.slice(0, 24) || 'My style');
        if (name === null) return;
        const list = loadTextStyles();
        const tx = found.clip.text;
        list.push({ name: name.trim() || 'My style', fontFamily: tx.fontFamily, fontSize: tx.fontSize, fontWeight: tx.fontWeight, color: tx.color, align: tx.align, animIn: tx.animIn, animOut: tx.animOut });
        saveTextStyles(list);
        renderLeftPanel();
        toast('Style saved in this browser.');
      });
    } else if (tab === 'transitions') {
      let fx = { transitions: [] };
      try { fx = await api('/api/video/effects'); } catch { /* ignore */ }
      body = `<p class="sub">Transitions apply between adjacent clips on the same video track — pick a clip, then set its transition in the right panel. Or apply one transition to every join at once:</p>
        <div class="ve-row"><select id="ve-trans-all-type">${(fx.transitions || []).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>
        <input type="number" id="ve-trans-all-dur" value="0.5" step="0.1" min="0.1" max="5" style="width:70px"></div>
        <button class="btn btn-sm btn-primary" id="ve-trans-all-go" style="margin:8px 0">Apply to all joins</button>
        ${(fx.transitions || []).map((t) => `<div class="ve-media-item"><div><div class="nm">${esc(t.name)}</div><div class="mt">up to ${t.maxDuration}s · FFmpeg xfade (${esc(t.xfade)})</div></div></div>`).join('')}
        <p class="sub" style="margin-top:10px">Transitions render with FFmpeg xfade between adjacent clips on the same track. A transition shortens the total by its duration.</p>`;
      host.innerHTML = body;
      document.getElementById('ve-trans-all-go').addEventListener('click', () => {
        const type = document.getElementById('ve-trans-all-type').value;
        const dur = clamp(parseFloat(document.getElementById('ve-trans-all-dur').value) || 0.5, 0.1, 5);
        pushHistory();
        let n = 0;
        for (const tr of ed.timeline.tracks.filter((t) => t.kind === 'video')) {
          const sorted = [...tr.clips].sort((a, b) => a.start - b.start);
          for (let i = 1; i < sorted.length; i++) {
            if (Math.abs(sorted[i - 1].start + sorted[i - 1].duration - sorted[i].start) < 0.01) {
              sorted[i].transition = { type, duration: dur };
              n++;
            }
          }
        }
        saveSoon(); renderAll();
        toast(n ? `Transition applied to ${n} join(s).` : 'No adjacent clip joins found to apply it to.');
      });
    }
  }

  // v2.4.0 — stickers: an image placed on the overlay (PiP) video track.
  // The renderer draws it as a looped still at 30% width, bottom-right by
  // default; keyframes move it. Creates the overlay track when missing.
  // v2.5.0 — N video tracks are allowed now: a sticker goes on the first
  // overlay track with a free slot, or a new overlay track is added.
  function addSticker(m) {
    const tl = ed.timeline;
    const videoTracks = tl.tracks.filter((t) => t.kind === 'video');
    let overlay = null;
    let start = ed.playhead;
    // Find the first overlay track with a free 3s slot at the playhead.
    for (const vt of videoTracks.slice(1)) {
      if (vt.locked) continue;
      const sorted = [...vt.clips].sort((a, b) => a.start - b.start);
      let s = ed.playhead, free = true;
      // v2.7.0 — Arrange layers off: the sticker appends after the last
      // clip on the overlay track instead of filling the first free slot.
      if (ed.timeline.arrangeLayers === false) {
        s = sorted.length ? sorted[sorted.length - 1].start + sorted[sorted.length - 1].duration : 0;
      } else {
        for (const c of sorted) {
          if (s < c.start + c.duration && s + 3 > c.start) { s = c.start + c.duration; }
        }
      }
      overlay = vt; start = s; free = true;
      break;
    }
    if (!overlay) {
      pushHistory();
      overlay = { id: uid('track'), kind: 'video', name: `Overlay ${videoTracks.length}`, locked: false, muted: false, clips: [] };
      tl.tracks.splice(1, 0, overlay);
    }
    if (overlay.locked) { toast('The overlay track is locked.', true); return; }
    pushHistory();
    if (m.id != null) ed.mediaKinds[m.id] = 'image';
    const clip = defaultClip('video', m.id, start, 3);
    clip.name = `Sticker: ${m.originalName}`;
    clip.sticker = true;
    overlay.clips.push(clip);
    ed.selectedClipId = clip.id;
    ed.selectedClipIds = new Set([clip.id]);
    toast(`Sticker "${m.originalName}" placed at ${fmtT(start)} (bottom-right PiP). Drag it in the preview to move it.`);
    saveSoon(); renderAll();
  }

  // v2.5.0 — split the text clip under the playhead into two at the
  // playhead (caption split, B key). Text is divided by words at the split.
  function splitCaptionAtPlayhead() {
    const found = clipAt(ed.timeline, 'text', ed.playhead);
    if (!found) { toast('No caption under the playhead to split.', true); return; }
    const { clip, track } = found;
    const rel = ed.playhead - clip.start;
    if (rel <= 0.05 || rel >= clip.duration - 0.05) { toast('Move the playhead inside the caption to split it.', true); return; }
    pushHistory();
    const words = String((clip.text && clip.text.text) || '').split(/\s+/).filter(Boolean);
    const splitAt = Math.max(1, Math.round(words.length * (rel / clip.duration)));
    const right = deep(clip);
    right.id = uid('clip');
    right.start = ed.playhead;
    right.duration = clip.duration - rel;
    right.text = { ...deep(clip.text), text: words.slice(splitAt).join(' ') || '…' };
    clip.duration = rel;
    clip.text.text = words.slice(0, splitAt).join(' ') || '…';
    track.clips.push(right);
    ed.selectedClipId = right.id;
    ed.selectedClipIds = new Set([right.id]);
    saveSoon(); renderAll();
    toast('Caption split at the playhead.');
  }

  function addMediaClip(m) {
    const tl = ed.timeline;
    // v2.5.0 — video AND image media both live on a video track; only
    // audio goes on an audio track. Record the media kind so the preview
    // can tell an image clip (rendered as <img>) from a video clip.
    const kind = m.kind === 'audio' ? 'audio' : 'video';
    if (m.id != null) ed.mediaKinds[m.id] = m.kind;
    const tr = tl.tracks.find((t) => t.kind === kind);
    if (!tr) { toast(`No ${kind} track in this timeline.`, true); return; }
    if (tr.locked) { toast('This track is locked.', true); return; }
    const dur = m.durationSeconds ? Math.min(m.durationSeconds, 600) : 5;
    // v2.7.0 — Arrange layers (Details panel): ON = a new clip auto-places
    // in the first free slot at/after the playhead; OFF = it appends after
    // the last clip on the track (never overlapping).
    let start = ed.playhead;
    const sorted = [...tr.clips].sort((a, b) => a.start - b.start);
    if (ed.timeline.arrangeLayers === false) {
      start = sorted.length ? sorted[sorted.length - 1].start + sorted[sorted.length - 1].duration : 0;
    } else {
      for (const c of sorted) {
        if (start < c.start + c.duration && start + dur > c.start) start = c.start + c.duration;
      }
    }
    pushHistory();
    const clip = defaultClip(kind, m.id, start, dur);
    clip.name = m.originalName;
    if (kind === 'video' && m.durationSeconds) clip.duration = m.durationSeconds;
    tr.clips.push(clip);
    ed.selectedClipId = clip.id;
    ed.selectedClipIds = new Set([clip.id]);
    toast(`Added "${m.originalName}" at ${fmtT(start)}.`);
    saveSoon(); renderAll();
  }

  // v2.7.0 — split one clip at an absolute timeline time (the playhead,
  // or a click in Split tool mode). Shared by the toolbar, the Split tool
  // and the Ctrl+B shortcut path (via toolbarActions.split).
  function splitClipAtTime(clip, track, t) {
    if (track.locked) { toast('This track is locked.', true); return false; }
    const rel = t - clip.start;
    if (rel <= 0.05 || rel >= clip.duration - 0.05) { toast('Split point must be inside the clip.', true); return false; }
    pushHistory();
    const right = deep(clip);
    right.id = uid('clip');
    right.start = t;
    right.duration = clip.duration - rel;
    right.srcStart = clip.srcStart + rel * clip.speed;
    right.transition = { type: 'none', duration: 0.5 };
    right.keyframes = (clip.keyframes || []).filter((k) => k.t >= rel).map((k) => ({ ...k, t: k.t - rel }));
    clip.duration = rel;
    clip.keyframes = (clip.keyframes || []).filter((k) => k.t < rel);
    track.clips.push(right);
    ed.selectedClipId = right.id;
    ed.selectedClipIds = new Set([right.id]);
    saveSoon(); renderAll();
    return true;
  }

  // v2.7.0 — after the Project settings dialog (Modify / Ctrl+P) closes,
  // pull the saved name / aspect / fps / settings into the editor shell
  // without touching the in-memory clips (the dialog only edits those).
  function refreshAfterSettingsDialog() {
    const check = setInterval(async () => {
      if (!ed) { clearInterval(check); return; }
      if (document.querySelector('.modal-back')) return; // still open
      clearInterval(check);
      if (!ed) return;
      try {
        const { project } = await api(`/api/projects/${ed.project.id}`);
        const content = JSON.parse(project.content || '{}');
        ed.project = project;
        ed.projectSettings = content.settings || {};
        const nameInput = document.getElementById('ve-proj-name');
        if (nameInput) nameInput.value = project.name;
        const tl = content.timeline;
        if (tl && tl.width && tl.height) {
          ed.timeline.width = tl.width; ed.timeline.height = tl.height; ed.timeline.fps = tl.fps || ed.timeline.fps;
          const dims = document.getElementById('ve-dims');
          if (dims) dims.textContent = `${tl.width}×${tl.height} @ ${ed.timeline.fps}fps`;
          const ratio = document.getElementById('ve-ratio');
          if (ratio) ratio.value = (ASPECTS.find((x) => x.width === tl.width && x.height === tl.height) || ASPECTS[0]).id;
          const stage = document.getElementById('ve-stage');
          if (stage) stage.style.aspectRatio = `${tl.width}/${tl.height}`;
        }
        renderAll();
      } catch { /* keep the editor as-is if the refresh fails */ }
    }, 800);
  }

  // v2.7.0 — switch the left rail tab from anywhere (rail buttons, the
  // voiceover mic in the timeline toolbar, the Media panel's Record).
  function switchLeftTab(tab, audioSub) {
    if (!ed) return;
    ed.leftTab = tab;
    if (audioSub) ed.audioSub = audioSub;
    document.querySelectorAll('[data-ltab]').forEach((x) => x.classList.toggle('active', x.dataset.ltab === tab));
    renderLeftPanel();
  }

  /* ---------------- Editor shell ---------------- */
  function toolbarActions() {
    const split = async () => {
      const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
      if (!found) { toast('Select a clip first, then split at the playhead.', true); return; }
      if (splitClipAtTime(found.clip, found.track, ed.playhead)) toast('Clip split at the playhead.');
    };
    const duplicate = () => duplicateSelection();
    const remove = (ripple) => deleteSelection(ripple);
    // v2.5.0 — split screen: two selected video clips play side by side.
    const splitScreen = () => {
      const sel = selectedClips().filter((x) => x.clip.kind === 'video');
      if (sel.length < 2) { toast('Select 2 video clips (Ctrl+click) for split screen.', true); return; }
      pushHistory();
      const [a, b] = sel;
      a.clip.splitScreen = { enabled: true, partnerClipId: b.clip.id };
      b.clip.splitScreen = { enabled: true, partnerClipId: a.clip.id };
      saveSoon(); renderAll();
      toast('Split screen on — the two clips render side by side.');
    };
    // v2.5.0 — sync: pull a linked audio clip to its video clip's start.
    const syncLinked = () => {
      const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
      if (!found || !found.clip.linkedTo) { toast('Select a clip linked to audio first (right-click → Link).', true); return; }
      const other = findClip(ed.timeline, found.clip.linkedTo);
      if (!other) { toast('The linked clip is gone.', true); return; }
      pushHistory();
      other.clip.start = found.clip.start;
      saveSoon(); renderAll();
      toast('Linked audio synced to the video clip.');
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
    return { split, duplicate, remove, groupSel, ungroupSel, splitScreen, syncLinked, makeCompound, unmakeCompound, copySelection, pasteClipboard, cutSelection, selectAllClips };
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
      selectedClipId: null, selectedClipIds: new Set(), clipboard: [],
      playhead: 0, playing: false, lastTick: 0,
      pxPerSec: 14, leftTab: 'media', propsTab: 'props',
      undoStack: [], redoStack: [], saveTimer: null, pollTimer: null,
      currentJob: null, beatSnap: true, magnet: true,
      // v2.7.0 — CapCut shell state: Select/Split tool, project settings
      // (for the Details panel), Media sub-tab + open section.
      toolMode: 'select', projectSettings: content.settings || {},
      mediaTab: 'media', openSection: 'yours', avatarNoteShown: false,
      // v2.5.0
      waveformsOn: false, waveforms: {}, safeZones: false, loop: false,
      previewQuality: 'full', compoundStack: [], fxCache: null,
      mediaKinds: {}, shortcuts: loadShortcuts(), shuttleTimer: null, shuttleRate: 0,
    };
    ed.pushHistory = pushHistory;
    ed.saveSoon = saveSoon;
    container.style.maxWidth = 'none';
    container.style.padding = '16px';
    container.innerHTML = `
    <div class="ve-wrap">
      <div class="ve-topbar">
        <button class="ve-logo" id="ve-home" title="CreativeStudio AI Pro — back to Home">✂ <b>CreativeStudio</b></button>
        <button class="btn btn-sm" id="ve-menu-btn" title="Project menu">Menu ▾</button>
        <span class="ve-tb-spacer"></span>
        <input id="ve-proj-name" value="${esc(project.name)}" title="Project name — click to rename" spellcheck="false">
        <span class="badge" id="ve-save-state" title="Autosave status">Saved</span>
        ${timeline.musicSync ? `<span class="badge info" title="Synced to ${esc(timeline.musicSync.trackName || '')}">♪ ${timeline.musicSync.bpm} BPM · ${timeline.musicSync.beats.length} beats</span>` : ''}
        <span class="ve-tb-spacer"></span>
        <button class="btn btn-sm ve-layout-toggle" id="ve-toggle-left" title="Show / hide the left panel" aria-pressed="true"><span class="ve-lico"><i class="on"></i><i></i></span><span class="ve-lico-lbl">Left</span></button>
        <button class="btn btn-sm ve-layout-toggle" id="ve-toggle-right" title="Show / hide the right panel" aria-pressed="true"><span class="ve-lico"><i></i><i class="on"></i></span><span class="ve-lico-lbl">Right</span></button>
        <button class="btn btn-sm ve-pro-badge" id="ve-pro-badge" title="Your plan — opens Subscription & Credits. No payment is taken in this app.">◆ Plan</button>
        <button class="btn btn-sm" id="ve-share-btn" title="Share this project">↗ Share</button>
        <button class="btn btn-sm btn-primary ve-export" id="ve-goto-export">⬆ Export</button>
      </div>
      <div class="ve-compound-bar card" id="ve-compound-bar" style="display:none;padding:8px 14px;align-items:center;gap:10px">
        <button class="btn btn-sm" id="ve-compound-back">← Back to parent timeline</button>
        <span class="sub">Editing inside a compound clip — changes here are part of the compound clip.</span>
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
          <div class="ve-player-head">
            <b id="ve-seq-name">Player-Timeline 01</b>
            <span class="sub" id="ve-dims">${ed.timeline.width}×${ed.timeline.height} @ ${ed.timeline.fps}fps</span>
            <span class="spacer"></span>
            <button class="btn btn-sm" id="ve-player-menu" title="Preview options">☰</button>
          </div>
          <div class="ve-stage" id="ve-stage" style="aspect-ratio:${ed.timeline.width}/${ed.timeline.height};width:100%;max-width:760px;max-height:430px">
            <video id="ve-va" playsinline preload="auto" style="display:none"></video>
            <video id="ve-vb" playsinline preload="auto" style="display:none"></video>
            <img id="ve-stickerov" alt="" style="position:absolute;display:none;pointer-events:none">
            <div id="ve-overlays" style="position:absolute;inset:0;pointer-events:none"></div>
            <div id="ve-textov" style="position:absolute;inset:0;pointer-events:none"></div>
            <div id="ve-safezones" style="position:absolute;inset:0;pointer-events:none;display:none">
              <div style="position:absolute;inset:5%;border:1px dashed rgba(255,255,255,.7)"></div>
              <div style="position:absolute;inset:10%;border:1px dashed rgba(255,255,255,.45)"></div>
            </div>
            <div class="ve-noclip" id="ve-noclip">No video clip under the playhead — add media from the left panel.</div>
            <audio id="ve-audio" preload="auto" style="display:none"></audio>
          </div>
          <div class="ve-transport">
            <span class="time" id="ve-time">00:00:00:00 / 00:00:00:00</span>
            <button class="btn btn-sm" id="ve-prev-frame" title="Previous frame">⏮ −1f</button>
            <button class="btn btn-primary btn-sm" id="ve-play">▶ Play</button>
            <button class="btn btn-sm" id="ve-next-frame" title="Next frame">＋1f ⏭</button>
            <span class="spacer"></span>
            <button class="btn btn-sm" id="ve-quality-toggle" title="Preview quality — Full or Performance (the export is always full quality)">Full</button>
            <label class="ve-ratio" title="Change the timeline aspect ratio (clip timing is unchanged; text positions are percentages)">Ratio <select id="ve-ratio">${['16:9', '9:16', '1:1', '4:5'].map((a) => `<option value="${a}" ${(ASPECTS.find((x) => x.width === ed.timeline.width && x.height === ed.timeline.height) || ASPECTS[0]).id === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
            <button class="btn btn-sm" id="ve-fullscreen" title="Fullscreen preview (Ctrl+Shift+P)">⛶ Fullscreen</button>
          </div>
          <div class="ve-preview-ctl">
            <label title="Preview quality">Quality <select id="ve-pq"><option value="full">Full quality</option><option value="perf">Performance</option></select></label>
            <label title="Show action-safe (5%) and title-safe (10%) guides"><input type="checkbox" id="ve-safe"> Safe zones</label>
            <label title="Play again from the start when the timeline ends"><input type="checkbox" id="ve-loop"> Loop</label>
            <button class="btn btn-sm" id="ve-bg-btn" title="Project background: solid colour, image or blur-fill">🎨 Background</button>
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
        <div class="ve-tl-tools ve-tl-primary">
          <button class="btn btn-sm" id="ve-add-track-btn" title="Add a track">＋</button>
          <select id="ve-tool" title="Tool: Select (move/trim clips) or Split (click a clip to split it there)">
            <option value="select">➤ Select</option>
            <option value="split">✂ Split</option>
          </select>
          <button class="btn btn-sm" id="ve-undo" title="Undo (Ctrl+Z)">↩</button>
          <button class="btn btn-sm" id="ve-redo" title="Redo (Ctrl+Shift+Z)">↪</button>
          <button class="btn btn-sm" id="ve-split" title="Split at playhead (Ctrl+B)">✂</button>
          <button class="btn btn-sm btn-danger" id="ve-del" title="Delete selected clip (Del)">🗑</button>
          <button class="btn btn-sm" id="ve-vo-btn" title="Voiceover — record with your microphone">🎙️</button>
          <button class="btn btn-sm on" id="ve-magnet" title="Magnetic timeline: clip edges snap to the playhead and to other clips. Click to turn snapping off for free placement.">🧲 Snap</button>
          <label class="ve-zoom-lbl" title="Timeline zoom">🔍 <input type="range" id="ve-zoom" min="4" max="40" step="1" value="14"></label>
          <button class="btn btn-sm" id="ve-zoom-out" title="Zoom timeline out">−</button>
          <button class="btn btn-sm" id="ve-zoom-in" title="Zoom timeline in">＋</button>
          <button class="btn btn-sm" id="ve-more-toggle" title="More timeline tools" aria-expanded="false">⋯</button>
        </div>
        <div class="ve-tl-tools ve-tl-more" id="ve-more-tools" style="display:none">
          <button class="btn btn-sm" id="ve-dup">Duplicate</button>
          <button class="btn btn-sm" id="ve-ripple">Ripple delete</button>
          <button class="btn btn-sm" id="ve-group">Group overlapping</button>
          <button class="btn btn-sm" id="ve-ungroup">Ungroup</button>
          <button class="btn btn-sm" id="ve-marker">◆ Add marker</button>
          <button class="btn btn-sm" id="ve-extract-audio">🎵 Extract audio</button>
          <button class="btn btn-sm" id="ve-reverse">⏪ Reverse</button>
          <button class="btn btn-sm" id="ve-freeze">❄ Freeze</button>
          <button class="btn btn-sm" id="ve-compound">🧩 Compound</button>
          <button class="btn btn-sm" id="ve-splitscreen">▦ Split screen</button>
          <button class="btn btn-sm" id="ve-sync">🔗 Sync linked</button>
          ${timeline.musicSync ? `<label style="font-size:12px" title="Snap clip edges to the nearest beat (within 0.12 s)"><input type="checkbox" id="ve-beatsnap" checked> ♪ Beat snap</label>` : ''}
          <button class="btn btn-sm" id="ve-waveforms" title="Show audio waveforms on audio clips (Ctrl+Shift+H)">〰 Waveforms</button>
          <button class="btn btn-sm" id="ve-add-audio-track">＋ Audio track</button>
          <button class="btn btn-sm" id="ve-add-text-track">＋ Text track</button>
          <button class="btn btn-sm" id="ve-add-overlay">＋ Overlay video track</button>
        </div>
        <div id="ve-timeline"></div>
      </div>
    </div>`;
    const actions = toolbarActions();
    // v2.7.0 — CapCut top bar: Menu, editable project name, layout
    // toggles, real plan badge, Share, Export.
    document.getElementById('ve-home').addEventListener('click', () => go('home'));
    document.getElementById('ve-menu-btn').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left, r.bottom + 6, [
        { label: '＋ New project', fn: () => { if (typeof openNewProjectFlow === 'function') openNewProjectFlow(); else go('video-editor'); } },
        { label: '📂 Open project', fn: () => go('video-editor') },
        { label: '💾 Save', fn: async () => { await saveTimeline(false); toast('Saved.'); } },
        { label: '💾 Save version', fn: async () => { await saveTimeline(true); toast('Version saved.'); } },
        { label: '⚙️ Project settings', fn: () => { if (typeof openProjectSettingsDialog === 'function') { openProjectSettingsDialog(ed.project.id); refreshAfterSettingsDialog(); } else toast('Project settings are available from the Projects view (Ctrl+P).', true); } },
        { label: '⌨ Keyboard shortcuts', fn: showShortcutsPanel },
        { sep: true },
        { label: '⚙️ Settings', fn: () => go('settings') },
      ]);
    });
    const nameInput = document.getElementById('ve-proj-name');
    nameInput.addEventListener('change', async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.value = ed.project.name; toast('Project name cannot be empty.', true); return; }
      if (name === ed.project.name) return;
      try {
        await api(`/api/projects/${ed.project.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
        ed.project.name = name;
        renderProps();
        toast('Project renamed.');
      } catch (e) { nameInput.value = ed.project.name; toast(e.message, true); }
    });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } });
    // Layout toggles: real show/hide of the left and right panels.
    const togglePanel = (side) => {
      const main = document.querySelector('.ve-main');
      if (!main) return;
      const btn = document.getElementById(side === 'left' ? 've-toggle-left' : 've-toggle-right');
      const hidden = main.classList.toggle(side === 'left' ? 've-hide-left' : 've-hide-right');
      btn.setAttribute('aria-pressed', String(!hidden));
      btn.classList.toggle('off', hidden);
    };
    document.getElementById('ve-toggle-left').addEventListener('click', () => togglePanel('left'));
    document.getElementById('ve-toggle-right').addEventListener('click', () => togglePanel('right'));
    // Plan badge: the real plan from the subscription API (never a fake
    // payment state — OWNER is Lifetime Free, no gateway exists).
    api('/api/subscription').then((s) => {
      const badge = document.getElementById('ve-pro-badge');
      if (badge && s && s.currentPlan) badge.textContent = `◆ ${s.currentPlan}`;
    }).catch(() => { /* badge keeps its neutral "◆ Plan" label */ });
    document.getElementById('ve-pro-badge').addEventListener('click', () => go('subscription'));
    document.getElementById('ve-share-btn').addEventListener('click', () => {
      if (typeof openModal !== 'function' || typeof collabPanelHTML !== 'function' || typeof initCollabPanel !== 'function') { go('collaboration'); return; }
      const back = openModal(`<h2>↗ Share — ${esc(ed.project.name)}</h2>${collabPanelHTML()}`);
      back.querySelector('.modal').style.maxWidth = '640px';
      initCollabPanel(ed.project.id);
    });
    document.getElementById('ve-undo').addEventListener('click', doUndo);
    document.getElementById('ve-redo').addEventListener('click', doRedo);
    document.getElementById('ve-goto-export').addEventListener('click', () => { ed.propsTab = 'export'; document.querySelectorAll('[data-ptab]').forEach((b) => b.classList.toggle('active', b.dataset.ptab === 'export')); renderProps(); });
    document.getElementById('ve-ratio').addEventListener('change', (e) => {
      const a = ASPECTS.find((x) => x.id === e.target.value) || ASPECTS[0];
      pushHistory();
      ed.timeline.width = a.width; ed.timeline.height = a.height;
      document.getElementById('ve-dims').textContent = `${a.width}×${a.height} @ ${ed.timeline.fps}fps`;
      const stage = document.getElementById('ve-stage');
      if (stage) stage.style.aspectRatio = `${a.width}/${a.height}`;
      saveSoon(); renderAll();
      toast(`Aspect ratio changed to ${a.id} (${a.width}×${a.height}). Clip timing is unchanged; text positions are percentages.`);
    });
    // v2.7.0 — preview header menu: the same real preview controls that
    // live at the preview bottom (quality, ratio, fullscreen, safe zones,
    // loop, background) — nothing here is a dead entry.
    document.getElementById('ve-player-menu').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const setSelect = (id, value) => { const el = document.getElementById(id); if (!el) return; el.value = value; el.dispatchEvent(new Event('change')); };
      const toggleCheck = (id) => { const el = document.getElementById(id); if (!el) return; el.checked = !el.checked; el.dispatchEvent(new Event('change')); };
      showMenu(Math.min(r.left, window.innerWidth - 240), r.bottom + 6, [
        { label: 'Full quality preview', fn: () => setSelect('ve-pq', 'full') },
        { label: 'Performance preview', fn: () => setSelect('ve-pq', 'perf') },
        { label: 'Aspect ratio 16:9', fn: () => setSelect('ve-ratio', '16:9') },
        { label: 'Aspect ratio 9:16', fn: () => setSelect('ve-ratio', '9:16') },
        { label: 'Aspect ratio 1:1', fn: () => setSelect('ve-ratio', '1:1') },
        { label: 'Aspect ratio 4:5', fn: () => setSelect('ve-ratio', '4:5') },
        { label: '⛶ Fullscreen preview', fn: () => document.getElementById('ve-fullscreen').click() },
        { label: 'Toggle safe zones', fn: () => toggleCheck('ve-safe') },
        { label: 'Toggle loop playback', fn: () => toggleCheck('ve-loop') },
        { label: '🎨 Project background…', fn: () => showBackgroundDialog() },
      ]);
    });
    // v2.7.0 — "Full" toggle mirrors the Quality select below the stage.
    document.getElementById('ve-quality-toggle').addEventListener('click', () => {
      const pq = document.getElementById('ve-pq');
      pq.value = ed.previewQuality === 'perf' ? 'full' : 'perf';
      pq.dispatchEvent(new Event('change'));
    });
    // v2.7.0 — Select / Split tool dropdown (real tool mode).
    document.getElementById('ve-tool').addEventListener('change', (e) => {
      ed.toolMode = e.target.value;
      const host = document.getElementById('ve-timeline');
      if (host) host.classList.toggle('ve-tool-split', ed.toolMode === 'split');
      toast(ed.toolMode === 'split' ? 'Split tool — click a clip to split it where you click.' : 'Select tool — click clips to select, drag to move or trim.');
    });
    // v2.7.0 — "＋" add-track menu (each entry runs the real add-track action).
    document.getElementById('ve-add-track-btn').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left, r.bottom + 6, [
        { label: '＋ Video track', fn: () => addVideoTrack() },
        { label: '＋ Overlay video track', fn: () => document.getElementById('ve-add-overlay').click() },
        { label: '＋ Audio track', fn: () => document.getElementById('ve-add-audio-track').click() },
        { label: '＋ Text track', fn: () => document.getElementById('ve-add-text-track').click() },
      ]);
    });
    document.getElementById('ve-vo-btn').addEventListener('click', () => {
      switchLeftTab('audio', 'voiceover');
      toast('Voiceover — record with your microphone at the playhead.');
    });
    document.getElementById('ve-more-toggle').addEventListener('click', (e) => {
      const row = document.getElementById('ve-more-tools');
      const open = row.style.display === 'none';
      row.style.display = open ? 'flex' : 'none';
      e.currentTarget.setAttribute('aria-expanded', String(open));
    });
    const setZoom = (v) => {
      ed.pxPerSec = clamp(v, 4, 40);
      const z = document.getElementById('ve-zoom');
      if (z) z.value = String(ed.pxPerSec);
      renderTimeline(); updatePreview();
    };
    document.getElementById('ve-zoom-in').addEventListener('click', () => setZoom(ed.pxPerSec + 4));
    document.getElementById('ve-zoom-out').addEventListener('click', () => setZoom(ed.pxPerSec - 4));
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
      pushHistory();
      addVideoTrack();
      toast('Overlay track added — its clips render picture-in-picture above the main track.');
    });
    // v2.5.0 — new timeline toolbar actions.
    document.getElementById('ve-extract-audio').addEventListener('click', () => {
      const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
      if (!found) { toast('Select a video clip first.', true); return; }
      extractAudio(found.clip);
    });
    document.getElementById('ve-reverse').addEventListener('click', () => {
      const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
      if (!found) { toast('Select a clip first.', true); return; }
      reverseClip(found.clip);
    });
    document.getElementById('ve-freeze').addEventListener('click', () => {
      const found = ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null;
      if (!found) { toast('Select a clip first.', true); return; }
      freezeClip(found.clip);
    });
    document.getElementById('ve-compound').addEventListener('click', makeCompound);
    document.getElementById('ve-splitscreen').addEventListener('click', actions.splitScreen);
    document.getElementById('ve-sync').addEventListener('click', actions.syncLinked);
    document.getElementById('ve-waveforms').addEventListener('click', (e) => {
      ed.waveformsOn = !ed.waveformsOn;
      e.currentTarget.classList.toggle('on', ed.waveformsOn);
      renderTimeline();
      toast(ed.waveformsOn ? 'Waveforms on — audio clips show their waveform.' : 'Waveforms off.');
    });
    document.getElementById('ve-compound-back').addEventListener('click', exitCompound);
    // (Shortcuts now live in the top-bar Menu — see the Menu wiring above.)
    // v2.5.0 — preview controls: quality, safe zones, loop, fullscreen, background.
    document.getElementById('ve-pq').addEventListener('change', (e) => {
      ed.previewQuality = e.target.value;
      const vA = document.getElementById('ve-va'), vB = document.getElementById('ve-vb');
      const low = ed.previewQuality === 'perf';
      [vA, vB].forEach((v) => { if (v) v.style.imageRendering = low ? 'pixelated' : 'auto'; });
      const qt = document.getElementById('ve-quality-toggle');
      if (qt) qt.textContent = low ? 'Performance' : 'Full';
      toast(low ? 'Performance preview — the stage renders at lower fidelity; the export is unaffected.' : 'Full-quality preview.');
    });
    document.getElementById('ve-safe').addEventListener('change', (e) => {
      ed.safeZones = e.target.checked;
      updatePreview();
    });
    document.getElementById('ve-loop').addEventListener('change', (e) => { ed.loop = e.target.checked; });
    document.getElementById('ve-fullscreen').addEventListener('click', () => {
      const stage = document.getElementById('ve-stage');
      if (!stage) return;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else stage.requestFullscreen().catch(() => toast('Fullscreen is not available in this browser.', true));
    });
    document.getElementById('ve-bg-btn').addEventListener('click', () => showBackgroundDialog());
    // v2.5.0 — load the server capability lists once (effects, presets,
    // transitions, export presets) so the props/export panels can use them.
    api('/api/video/effects').then((r) => { ed.fxCache = r; }).catch(() => { ed.fxCache = { transitions: [], filters: [], effects: [], filterPresets: [], exportPresets: [] }; });
    // Media kinds (image vs video) for overlay preview rendering.
    api('/api/media?limit=500').then((r) => {
      ed.mediaKinds = {};
      for (const m of (r.media || [])) ed.mediaKinds[m.id] = m.kind;
    }).catch(() => {});
    container.querySelectorAll('[data-ltab]').forEach((b) => b.addEventListener('click', () => switchLeftTab(b.dataset.ltab)));
    // v2.4.0 — drag-drop import: drop video/audio files on the left panel.
    const leftHost = document.getElementById('ve-left');
    leftHost.addEventListener('dragover', (e) => {
      if (!ed || (ed.leftTab !== 'media' && ed.leftTab !== 'audio')) return;
      e.preventDefault(); leftHost.classList.add('ve-drop');
    });
    leftHost.addEventListener('dragleave', () => leftHost.classList.remove('ve-drop'));
    leftHost.addEventListener('drop', async (e) => {
      if (!ed || (ed.leftTab !== 'media' && ed.leftTab !== 'audio')) return;
      e.preventDefault(); leftHost.classList.remove('ve-drop');
      const want = ed.leftTab === 'media' ? 'video/' : 'audio/';
      const files = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith(want));
      if (!files.length) { toast(`Drop ${ed.leftTab === 'media' ? 'video' : 'audio'} files here.`, true); return; }
      for (const f of files) {
        const fd = new FormData(); fd.append('file', f);
        try { await apiForm('/api/media/upload', fd); }
        catch (err) { toast(err.message, true); return; }
      }
      toast('Uploaded.'); renderLeftPanel();
    });
    container.querySelectorAll('[data-ptab]').forEach((b) => b.addEventListener('click', () => {
      ed.propsTab = b.dataset.ptab;
      container.querySelectorAll('[data-ptab]').forEach((x) => x.classList.toggle('active', x === b));
      renderProps();
    }));
    // v2.5.0 — full CapCut shortcut map (customisable in the Shortcuts
    // panel; overrides live in localStorage). Single letters act only
    // when focus is not in an input/textarea/select.
    keyHandler = (e) => {
      if (!ed) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const name = keyEventName(e);
      const map = ed.shortcuts || {};
      const idFor = (k) => Object.keys(map).find((id) => map[id] === k);
      const id = idFor(name);
      const sel = () => (ed.selectedClipId ? findClip(ed.timeline, ed.selectedClipId) : null);
      const stepFrame = (n) => { setPlaying(false); stopShuttle(); ed.playhead = clamp(ed.playhead + (n / ed.timeline.fps), 0, totalDuration(ed.timeline)); updatePreview(); };
      const actionsById = {
        split: () => actions.split(),
        duplicate: () => actions.duplicate(),
        'delete-left': () => deleteSide('left'),
        'delete-right': () => deleteSide('right'),
        marker: () => document.getElementById('ve-marker').click(),
        export: () => { ed.propsTab = 'export'; document.querySelectorAll('[data-ptab]').forEach((b) => b.classList.toggle('active', b.dataset.ptab === 'export')); renderProps(); },
        'add-text': () => { document.querySelector('[data-ltab="text"]').click(); document.getElementById('ve-add-text').click(); },
        'frame-prev': () => stepFrame(-1),
        'frame-next': () => stepFrame(1),
        'jump5-prev': () => stepFrame(-5),
        'jump5-next': () => stepFrame(5),
        'shuttle-rev': () => startShuttle(-1),
        'shuttle-stop': () => { stopShuttle(); setPlaying(false); },
        'shuttle-fwd': () => startShuttle(1),
        play: () => { stopShuttle(); setPlaying(!ed.playing); },
        undo: () => doUndo(),
        redo: () => doRedo(),
        delete: () => actions.remove(false),
        copy: () => copySelection(),
        paste: () => pasteClipboard(),
        cut: () => cutSelection(),
        'select-all': () => selectAllClips(),
        'caption-split': () => splitCaptionAtPlayhead(),
        waveforms: () => document.getElementById('ve-waveforms').click(),
        'vol-up': () => nudgeVolume(0.05),
        'vol-down': () => nudgeVolume(-0.05),
        fullscreen: () => document.getElementById('ve-fullscreen').click(),
      };
      if (id && actionsById[id]) {
        // Single-letter shortcuts (j/k/l/q/w/m/b) must not fire while the
        // user is typing in a prompt() dialog or a contenteditable — the
        // tag check above covers inputs; prompt() blocks the event loop.
        e.preventDefault();
        actionsById[id]();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { actions.remove(false); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
      else if (e.key === '?') { showShortcutsPanel(); }
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
