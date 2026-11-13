'use strict';
/* Global entry point used by app.js routing (same pattern as viewMusicSync). */
async function viewVoices(c) { return VoiceUI.view(c); }
const VoiceUI = (() => {
  let profiles = [];
  let tts = null;
  let audioMedia = [];

  async function loadAll() {
    const data = await api('/api/voice/profiles');
    profiles = data.profiles || [];
    tts = data.tts || null;
    const m = await api('/api/media?kind=audio').catch(() => ({ media: [] }));
    audioMedia = m.media || [];
  }

  function statusLine() {
    if (!tts) return '';
    const vc = tts.voiceClone || {};
    const t = tts.tts || {};
    return `<div class="card"><h3>AI speech status — honest</h3>
      <p class="sub">Recorded narration works now, with no key: upload your own recorded audio and it plays in the video. AI/cloned speech needs a provider key.</p>
      <ul>
        <li>🎙️ Voice cloning + TTS (ElevenLabs): <strong>${vc.configured ? 'configured ✓' : 'key needed'}</strong> — ${esc(vc.note || '')}</li>
        <li>🤖 Generic AI voices (OpenAI TTS): <strong>${t.configured ? 'configured ✓' : 'key needed'}</strong> — ${esc(t.note || '')}</li>
      </ul>
      <p class="sub">Keys are added in Settings → AI Providers (stored encrypted, never shown in full). A short sample gives a rough voice match — a minute of clean speech clones much better.</p>
    </div>`;
  }

  function profileCard(p) {
    const sample = p.sampleMediaId ? (audioMedia.find((m) => m.id === p.sampleMediaId) || {}).originalName : '';
    return `<div class="card">
      <h3>${esc(p.name)} ${p.isDefault ? '<span class="badge ok">Default voice — on all videos</span>' : ''}</h3>
      <p class="sub">${p.kind === 'clone' ? '🎙️ Your own voice (from a sample)' : '🤖 AI voice'} · Language ${esc(p.language)} · ${p.ready ? 'Ready to speak' : 'Sample saved — not cloned yet'}</p>
      ${p.kind === 'clone' ? `<p class="sub">Sample: ${sample ? esc(sample) : '—'}${p.providerVoiceId ? ' · Cloned to provider ✓' : ' · Not cloned to a provider yet'}</p>` : `<p class="sub">AI voice: ${esc(p.aiVoice || '—')}</p>`}
      <div class="form-row">
        <button class="btn btn-sm" data-make-default="${p.id}" ${p.isDefault ? 'disabled' : ''}>Set as default voice</button>
        ${p.kind === 'clone' && !p.providerVoiceId ? `<button class="btn btn-sm" data-clone="${p.id}">Clone to provider</button>` : ''}
        <button class="btn btn-sm" data-test="${p.id}">Test speak</button>
        <button class="btn btn-sm" data-del="${p.id}">Delete</button>
      </div>
      <div class="sub" id="voice-msg-${p.id}"></div>
      <div id="voice-audio-${p.id}"></div>
    </div>`;
  }

  async function view(c) {
    await loadAll();
    const aiOpts = (tts && tts.tts && tts.tts.voices ? tts.tts.voices : []).map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    c.innerHTML = `
      <div class="card"><h3>🎙️ Voices — narration for quizzes &amp; bulk videos</h3>
        <p class="sub">Your voice: record a few words, upload the audio in the Media Library, and create your voice profile — it becomes the <strong>default voice on ALL videos</strong>. AI voices are also available. In a bulk job you pick one voice for the whole batch (a row's VOICE column can still override it).</p>
      </div>
      ${statusLine()}
      <div class="card"><h3>New voice profile</h3>
        <div class="form-row">
          <label>Name <input id="vp-name" placeholder="e.g. My voice"></label>
          <label>Language <input id="vp-lang" value="en" style="width:70px"></label>
          <label>Type <select id="vp-kind"><option value="clone">My own voice (from a sample)</option><option value="ai">AI voice</option></select></label>
        </div>
        <div class="form-row" id="vp-sample-row">
          <label>Voice sample (audio from Media Library) <select id="vp-sample"><option value="">— pick a recording —</option>${audioMedia.map((m) => `<option value="${m.id}">${esc(m.originalName)} (${Math.round(m.durationSeconds || 0)}s)</option>`).join('')}</select></label>
        </div>
        <div class="form-row" id="vp-ai-row" style="display:none">
          <label>AI voice <select id="vp-ai">${aiOpts}</select></label>
        </div>
        <button class="btn btn-primary" id="vp-create">Create voice profile</button>
        <span class="sub" id="vp-msg"></span>
        <p class="sub">No audio to upload here? Go to Media Library → upload a recording (MP3/WAV), then come back and pick it. A short sample works, but a minute of clean speech clones much better.</p>
      </div>
      <div id="voice-list">${profiles.length ? profiles.map(profileCard).join('') : '<div class="card"><p class="sub">No voices yet — create your first voice above. It becomes the default voice for all videos.</p></div>'}</div>`;

    document.getElementById('vp-kind').addEventListener('change', (ev) => {
      const clone = ev.target.value === 'clone';
      document.getElementById('vp-sample-row').style.display = clone ? '' : 'none';
      document.getElementById('vp-ai-row').style.display = clone ? 'none' : '';
    });
    document.getElementById('vp-create').addEventListener('click', async () => {
      const kind = document.getElementById('vp-kind').value;
      const body = {
        name: document.getElementById('vp-name').value.trim(),
        language: document.getElementById('vp-lang').value.trim() || 'en',
        kind,
        sampleMediaId: kind === 'clone' ? (parseInt(document.getElementById('vp-sample').value, 10) || null) : null,
        aiVoice: kind === 'ai' ? document.getElementById('vp-ai').value : null,
      };
      try {
        await api('/api/voice/profiles', { method: 'POST', body: JSON.stringify(body) });
        toast('Voice profile created.');
        await view(c);
      } catch (e) { document.getElementById('vp-msg').textContent = e.message; }
    });
    c.querySelectorAll('[data-make-default]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/voice/profiles/${b.dataset.makeDefault}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) }); toast('Default voice set — it will speak on all videos.'); await view(c); }
      catch (e) { toast(e.message, true); }
    }));
    c.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this voice profile? Its sample audio stays in the Media Library.')) return;
      try { await api(`/api/voice/profiles/${b.dataset.del}`, { method: 'DELETE' }); toast('Voice deleted.'); await view(c); }
      catch (e) { toast(e.message, true); }
    }));
    c.querySelectorAll('[data-clone]').forEach((b) => b.addEventListener('click', async () => {
      const msg = document.getElementById(`voice-msg-${b.dataset.clone}`);
      msg.textContent = 'Cloning to the provider…';
      try {
        const r = await api(`/api/voice/profiles/${b.dataset.clone}/clone`, { method: 'POST' });
        msg.textContent = r.alreadyCloned ? 'Already cloned.' : 'Cloned ✓ — this voice can now speak.';
        await view(c);
      } catch (e) { msg.textContent = e.message; }
    }));
    c.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
      const msg = document.getElementById(`voice-msg-${b.dataset.test}`);
      const box = document.getElementById(`voice-audio-${b.dataset.test}`);
      msg.textContent = 'Speaking a test line…';
      try {
        const r = await api('/api/voice/synthesise', { method: 'POST', body: JSON.stringify({ text: 'What is two plus two? The correct answer is four.', voiceProfileId: parseInt(b.dataset.test, 10) }) });
        msg.textContent = r.cached ? 'Spoken (cached audio).' : 'Spoken.';
        box.innerHTML = `<audio controls autoplay src="/api/media/${r.mediaId}/file"></audio>`;
      } catch (e) { msg.textContent = e.message; }
    }));
  }

  return { view };
})();
