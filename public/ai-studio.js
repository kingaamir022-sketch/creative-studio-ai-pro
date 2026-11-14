'use strict';
/* Global entry point used by app.js routing (same pattern as viewVoices). */
async function viewAIStudio(c, presetMode) { return AIStudio.view(c, presetMode); }
const AIStudio = (() => {
  let status = null;
  let jobs = [];
  let images = [];
  let audio = [];
  let videos = [];
  let voices = [];
  let designs = [];
  let videoProjects = [];
  let mode = 'image';
  let pollTimer = null;
  let currentJob = null;

  // C-11: the mode list is derived from the backend's /api/ai/status
  // `modes` (the single source of truth) — the old hardcoded MODES list
  // silently dropped the backend's 12th mode ('deck'). MODE_META only
  // carries the display label/icon/kind per mode id; if the status call
  // fails, the full table is used as a fallback.
  const MODE_META = {
    'image': { id: 'image', label: 'Text to Image', kind: 'image', icon: '🖼️' },
    'image-edit': { id: 'image-edit', label: 'Image to Image', kind: 'image', icon: '🎨' },
    'video': { id: 'video', label: 'Text to Video', kind: 'video', icon: '🎥' },
    'video-image': { id: 'video-image', label: 'Image to Video', kind: 'video', icon: '📽️' },
    'voice': { id: 'voice', label: 'AI Voice', kind: 'tts', icon: '🎙️' },
    'quiz': { id: 'quiz', label: 'AI Quiz Questions', kind: 'llm', icon: '❓' },
    'design': { id: 'design', label: 'AI Design Assist', kind: 'llm', icon: '✨' },
    'write': { id: 'write', label: 'Magic Write', kind: 'llm', icon: '✍️' },
    'transcribe': { id: 'transcribe', label: 'AI Transcribe', kind: 'stt', icon: '📝' },
    'music-mood': { id: 'music-mood', label: 'Music Mood Tags', kind: 'llm', icon: '🎵' },
    'music-generate': { id: 'music-generate', label: 'AI Music', kind: 'music', icon: '🎼' },
    'deck': { id: 'deck', label: 'AI Deck (Presentation)', kind: 'llm', icon: '📊' },
    // v2.5.0 new modes (items #44, #45, #60–#69, #29, #63, #64, #66).
    'autocut': { id: 'autocut', label: 'AutoCut', kind: 'video', icon: '✂️' },
    'editpilot': { id: 'editpilot', label: 'EditPilot', kind: 'llm', icon: '🧭' },
    'seedance': { id: 'seedance', label: 'Seedance (Edit / Extend)', kind: 'video', icon: '🌱' },
    'video-enhance': { id: 'video-enhance', label: 'Video Enhance / Denoise', kind: 'video', icon: '✨' },
    'video-translate': { id: 'video-translate', label: 'Video Translator / Dubbing', kind: 'stt', icon: '🌍' },
    'director': { id: 'director', label: 'Director Mode', kind: 'llm', icon: '🎬' },
    'avatar': { id: 'avatar', label: 'AI Avatar (photo + script)', kind: 'tts', icon: '🗣️' },
    'infinite-canvas': { id: 'infinite-canvas', label: 'AI Design Studio (Infinite Canvas)', kind: 'llm', icon: '♾️' },
    'lyrics': { id: 'lyrics', label: 'Auto Lyrics', kind: 'stt', icon: '🎤' },
    'ai-lab': { id: 'ai-lab', label: 'AI Lab (brainstorm)', kind: 'llm', icon: '💡' },
    'batch-edit': { id: 'batch-edit', label: 'Batch Edit (many clips)', kind: 'video', icon: '📦' },
    'retouch': { id: 'retouch', label: 'Retouch / Beauty', kind: 'video', icon: '💄' },
    'bilingual': { id: 'bilingual', label: 'Bilingual Captions + Speaker ID', kind: 'stt', icon: '💬' },
    'transcript-edit': { id: 'transcript-edit', label: 'Transcript Editing', kind: 'stt', icon: '📝' },
    'silence-remove': { id: 'silence-remove', label: 'Silence Removal', kind: 'video', icon: '🔇' },
    'magic-grab': { id: 'magic-grab', label: 'Magic Grab (per-object)', kind: 'image', icon: '🎯' },
  };
  function modes() {
    if (status && Array.isArray(status.modes) && status.modes.length) {
      return status.modes.map((id) => MODE_META[id]).filter(Boolean);
    }
    return Object.values(MODE_META);
  }
  const MODES = Object.values(MODE_META);

  async function loadAll() {
    const [st, js, im, au, vp, pr, vi, vpr] = await Promise.all([
      api('/api/ai/status').catch(() => null),
      api('/api/ai/jobs').catch(() => ({ jobs: [] })),
      api('/api/media?kind=image&limit=100').catch(() => ({ media: [] })),
      api('/api/media?kind=audio&limit=100').catch(() => ({ media: [] })),
      api('/api/voice/profiles').catch(() => ({ profiles: [] })),
      api('/api/projects?type=design&limit=100').catch(() => ({ projects: [] })),
      api('/api/media?kind=video&limit=100').catch(() => ({ media: [] })),
      api('/api/projects?type=video&limit=100').catch(() => ({ projects: [] })),
    ]);
    status = st; jobs = js.jobs || [];
    images = (im.media || []).filter((m) => m.kind === 'image');
    audio = (au.media || []).filter((m) => m.kind === 'audio');
    videos = (vi.media || []).filter((m) => m.kind === 'video');
    voices = vp.profiles || [];
    designs = pr.projects || [];
    videoProjects = vpr.projects || [];
  }

  function kindState(kind) {
    if (!status || !status.kinds || !status.kinds[kind]) return { configured: false, providers: [] };
    return status.kinds[kind];
  }

  function modeDef(id) { return modes().find((m) => m.id === id) || modes()[0]; }

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
      case 'write': return `
        <div class="ed-field"><label>What to write</label><select id="ai-f-task"><option value="headline">Headline</option><option value="post">Social media post</option><option value="script">Video script</option><option value="blog">Blog paragraph</option><option value="rewrite">Rewrite my text</option><option value="shorten">Shorten my text</option><option value="tone">Change the tone</option></select></div>
        <div class="ed-field"><label>Topic / text</label><textarea id="ai-f-prompt" rows="3" placeholder="e.g. A summer sale for a shoe store, 50% off sneakers"></textarea></div>
        <div class="ed-row">
          <div class="ed-field"><label>Tone</label><select id="ai-f-tone"><option value="professional">Professional</option><option value="friendly">Friendly</option><option value="playful">Playful</option><option value="urgent">Urgent</option><option value="inspiring">Inspiring</option></select></div>
          <div class="ed-field"><label>Length</label><select id="ai-f-length"><option value="short">Short</option><option value="medium">Medium</option><option value="long">Long</option></select></div>
        </div>
        <p class="sub">Magic Write uses your LLM provider (OpenAI or free Gemini). No key configured → it refuses with “key needed” instead of inventing text.</p>`;
      case 'deck': return `
        <div class="ed-field"><label>Topic</label><input id="ai-f-topic" placeholder="e.g. How photosynthesis works, our Q3 sales results"></div>
        <div class="ed-field"><label>Number of slides (2–20)</label><input id="ai-f-slide-count" type="number" min="2" max="20" value="6"></div>
        <div class="ed-field"><label>Style</label><select id="ai-f-style"><option value="professional">Professional</option><option value="creative">Creative</option><option value="minimal">Minimal</option><option value="bold">Bold</option></select></div>
        <div class="ed-field"><label>Audience (optional)</label><input id="ai-f-audience" placeholder="e.g. school students, investors, new customers"></div>
        <p class="sub">Creates a NEW presentation project (title slide first, then text slides, at most one quiz and one chart slide) — nothing existing is changed. Uses your LLM provider.</p>`;
      case 'autocut': return `
        <div class="ed-field"><label>Clips / photos (tick 2 or more, in order)</label><div id="ai-f-clips" class="ai-checklist">${[...videos, ...images].map((x) => `<label class="ai-check"><input type="checkbox" value="${x.id}"> ${esc(x.original_name)} <span class="muted">(${x.kind})</span></label>`).join('') || '<p class="sub">No clips yet — upload videos or photos first.</p>'}</div></div>
        <div class="ed-field"><label>Template</label><select id="ai-f-template"><option value="cinematic">Cinematic (3s clips, fades)</option><option value="energetic">Energetic (1.5s clips, slides)</option><option value="calm">Calm (4s clips, long fades)</option></select></div>
        <div class="ed-field"><label>Music (optional)</label><select id="ai-f-music"><option value="">No music</option>${audio.map((x) => `<option value="${x.id}">${esc(x.original_name)}</option>`).join('')}</select></div>
        <div class="ed-field"><label>Edit name</label><input id="ai-f-name" value="AutoCut"></div>
        <p class="sub">AutoCut assembles a real, editable video project — you can trim, reorder and re-render it in the Video Editor afterwards.</p>`;
      case 'editpilot': return `
        <div class="ed-field"><label>Video project</label><select id="ai-f-project">${videoProjects.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('') || '<option value="">No video projects yet</option>'}</select></div>
        <div class="ed-field"><label>Edit prompt</label><textarea id="ai-f-prompt" rows="3" placeholder="e.g. Trim the slow intro, remove pauses, make it punchier, add fades between scenes"></textarea></div>
        <div class="ed-field"><label><input type="checkbox" id="ai-f-alternate"> Save as an alternate version (keep the original untouched)</label></div>
        <p class="sub">The LLM plans timeline ops; only ops that match real clips are applied. Anything it cannot map is listed as skipped, never invented.</p>`;
      case 'seedance': return `
        <div class="ed-field"><label>Mode</label><select id="ai-f-seedance-mode"><option value="generate">AI Video (generate)</option><option value="edit">AI Edit (refine existing footage)</option><option value="extend">AI Extend (lengthen a clip)</option></select></div>
        <div class="ed-field"><label>Prompt</label><textarea id="ai-f-prompt" rows="3" placeholder="e.g. A golden-hour street scene, cinematic camera move"></textarea></div>
        <div class="ed-field"><label>Edit instruction (AI Edit mode)</label><input id="ai-f-edit-prompt" placeholder="e.g. Make the sky stormy, sharpen the subject"></div>
        <div class="ed-field"><label>Reference image (optional)</label><select id="ai-f-source"><option value="">None</option>${images.map((x) => `<option value="${x.id}">${esc(x.original_name)}</option>`).join('')}</select></div>
        <div class="ed-field"><label>Duration (seconds, 2–16)</label><input id="ai-f-duration" type="number" min="2" max="16" value="5"></div>
        <p class="sub">Needs the Seedance provider key (AI Studio → Providers). Extend needs a publicly reachable source video — a local-only file cannot be extended by Seedance; use Silence Removal / Video Enhance for local edits instead.</p>`;
      case 'video-enhance': return `
        <div class="ed-field"><label>Video</label><select id="ai-f-media">${videos.map((x) => `<option value="${x.id}">${esc(x.original_name)}</option>`).join('') || '<option value="">No videos yet</option>'}</select></div>
        <div class="ed-field"><label>Enhancement</label><select id="ai-f-kind"><option value="denoise">Denoise (hqdn3d, local)</option><option value="deflicker">Remove flickers (local)</option><option value="enhance">Enhance quality — contrast/colour/sharpness (local)</option><option value="upscale">Upscale ×2 (Lanczos, local — not AI)</option><option value="expand">AI Expand (needs video provider key)</option><option value="remix">AI Remix (needs video provider key)</option><option value="relight">AI Relight (needs video provider key)</option></select></div>
        <div class="ed-field"><label>Strength (1–10)</label><input id="ai-f-strength" type="number" min="1" max="10" value="3"></div>`;
      case 'video-translate': return `
        <div class="ed-field"><label>Video</label><select id="ai-f-media">${videos.map((x) => `<option value="${x.id}">${esc(x.original_name)}</option>`).join('') || '<option value="">No videos yet</option>'}</select></div>
        <div class="ed-field"><label>Translate to</label><select id="ai-f-to-language"><option value="en">English</option><option value="ur">Urdu</option><option value="roman-ur">Roman Urdu</option><option value="ar">Arabic</option><option value="hi">Hindi</option></select></div>
        <div class="ed-field"><label>Source language (optional)</label><input id="ai-f-language" placeholder="leave blank to auto-detect"></div>
        <div class="ed-field"><label>Dub voice</label><select id="ai-f-voice"><option value="">Default voice</option>${voices.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></div>
        <p class="sub">Transcribes → translates with the LLM → dubs with TTS → mixes the dub over the original audio (original lowered to 20%). Needs STT + LLM + TTS keys.</p>`;
      case 'director': return `
        <div class="ed-field"><label>Drama title</label><input id="ai-f-name" placeholder="e.g. The Last Rickshaw"></div>
        <div class="ed-field"><label>Premise</label><textarea id="ai-f-prompt" rows="3" placeholder="e.g. A rickshaw driver in Lahore discovers a lost briefcase that changes his family's fate"></textarea></div>
        <div class="ed-field"><label>Episodes (1–10)</label><input id="ai-f-count" type="number" min="1" max="10" value="3"></div>
        <p class="sub">Creates a Director Bible document: recurring characters (same look every episode), scenes, props and episode scripts — continuity by design.</p>`;
      case 'avatar': return `
        <div class="ed-field"><label>Photo</label><select id="ai-f-source">${images.map((x) => `<option value="${x.id}">${esc(x.original_name)}</option>`).join('') || '<option value="">No photos yet</option>'}</select></div>
        <div class="ed-field"><label>Script</label><textarea id="ai-f-text" rows="4" placeholder="e.g. Hello! Welcome to our channel — today we talk about healthy breakfasts."></textarea></div>
        <div class="ed-field"><label>Voice</label><select id="ai-f-voice"><option value="">Default voice</option>${voices.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></div>
        <p class="sub">Photo avatar: your photo with the spoken script. Lip-sync (mouth moving to the words) is not available in this build — the photo stays still while the voice speaks.</p>`;
      case 'infinite-canvas': return `
        <div class="ed-field"><label>Canvas brief</label><textarea id="ai-f-prompt" rows="3" placeholder="e.g. A brand board for a coffee shop — warm, minimal, premium"></textarea></div>
        <div class="ed-field"><label>Skill</label><select id="ai-f-skill"><option value="brand-board">Brand board</option><option value="moodboard">Moodboard</option><option value="storyboard">Storyboard (6 panels)</option><option value="social-kit">Social kit</option><option value="ad-set">Ad set</option></select></div>
        <p class="sub">The AI agent plans a 3840×2160 canvas (nodes = real editable layers) using the chosen Skill. Open the result in the Graphic Editor to pan, zoom and edit.</p>`;
      case 'lyrics': return `
        <div class="ed-field"><label>Song (audio or video)</label><select id="ai-f-media">${[...audio, ...videos].map((x) => `<option value="${x.id}">${esc(x.original_name)} (${x.kind})</option>`).join('') || '<option value="">No audio yet</option>'}</select></div>
        <div class="ed-field"><label>Language (optional)</label><input id="ai-f-language" placeholder="e.g. en, ur"></div>
        <p class="sub">Transcribes the song, then the LLM formats timed lyric lines. Returns SRT + VTT. Labelled as lyrics captioning from speech transcription — no dedicated lyrics model.</p>`;
      case 'ai-lab': return `
        <div class="ed-field"><label>Topic</label><input id="ai-f-topic" placeholder="e.g. Ramadan recipes for busy families"></div>
        <div class="ed-field"><label>What to brainstorm</label><select id="ai-f-kind"><option value="ideas">Content ideas</option><option value="hooks">Opening hooks</option><option value="angles">Fresh angles</option><option value="titles">Titles</option><option value="scripts">Short video scripts</option></select></div>
        <div class="ed-field"><label>How many (1–10)</label><input id="ai-f-count" type="number" min="1" max="10" value="5"></div>`;
      case 'batch-edit': return `
        <div class="ed-field"><label>Video projects (tick several)</label><div class="ai-checklist">${videoProjects.map((d) => `<label class="ai-check"><input type="checkbox" class="ai-batch-proj" value="${d.id}"> ${esc(d.name)}</label>`).join('') || '<p class="sub">No video projects yet.</p>'}</div></div>
        <div class="ed-field"><label>Operation</label><select id="ai-f-batch-op"><option value="transition-all">Set transition on all clips</option><option value="volume-all">Set volume on all clips</option><option value="rename-prefix">Rename with a prefix</option></select></div>
        <div class="ed-field"><label>Transition / prefix</label><input id="ai-f-batch-arg" placeholder="fade / 0.8 / New — "></div>
        <p class="sub">Applies one op to many projects at once. Each project reports ok / failed individually — a failure in one never blocks the rest.</p>`;
      case 'retouch': return `
        <div class="ed-field"><label>Video or photo</label><select id="ai-f-media">${[...videos, ...images].map((x) => `<option value="${x.id}">${esc(x.original_name)} (${x.kind})</option>`).join('') || '<option value="">No media yet</option>'}</select></div>
        <div class="ed-field"><label>Effect</label><select id="ai-f-kind"><option value="smooth">Face smooth (frame-level smartblur)</option><option value="skin">Skin tone even-out (frame-level)</option><option value="blemish">Blemish fix — not available (needs face ML)</option><option value="makeup">Makeup — not available (needs face ML)</option><option value="slim">Slim — not available (needs body ML)</option><option value="mosaic">Face mosaic — not available (needs face detection)</option><option value="halo">Halo — not available (needs body ML)</option></select></div>
        <div class="ed-field"><label>Intensity (0–100)</label><input id="ai-f-strength" type="range" min="0" max="100" value="50" style="width:100%"></div>
        <p class="sub">Smooth / skin tone work locally on the whole frame (no face tracking). Face/body ML effects are honestly labelled as not available — they are never faked.</p>`;
      case 'bilingual': return `
        <div class="ed-field"><label>Video</label><select id="ai-f-media">${videos.map((x) => `<option value="${x.id}">${esc(x.original_name)}</option>`).join('') || '<option value="">No videos yet</option>'}</select></div>
        <div class="ed-field"><label>Second language</label><select id="ai-f-to-language"><option value="ur">Urdu</option><option value="en">English</option><option value="roman-ur">Roman Urdu</option><option value="ar">Arabic</option><option value="hi">Hindi</option></select></div>
        <div class="ed-field"><label>Source language (optional)</label><input id="ai-f-language" placeholder="leave blank to auto-detect"></div>
        <div class="ed-field"><label>Speakers (max)</label><input id="ai-f-count" type="number" min="1" max="6" value="2"></div>
        <p class="sub">One pass: original + translated subtitles with speaker labels. Speaker labels are inferred by the LLM from the dialogue text, not from acoustic diarization.</p>`;
      case 'transcript-edit': return `
        <div class="ed-field"><label>Video</label><select id="ai-f-media">${videos.map((x) => `<option value="${x.id}">${esc(x.original_name)}</option>`).join('') || '<option value="">No videos yet</option>'}</select></div>
        <div class="ed-field"><label>Transcript cues (JSON: [{start,end,text}])</label><textarea id="ai-f-cues" rows="4" placeholder='[{"start":0,"end":3,"text":"Hello everyone"}]'></textarea></div>
        <div class="ed-field"><label>Edited transcript — keep only what should stay</label><textarea id="ai-f-keep" rows="4" placeholder="Paste the edited transcript here. Lines whose words are all gone are cut from the video."></textarea></div>
        <p class="sub">Tip: transcribe the video first (AI Transcribe mode), copy its text, delete the lines you do not want, and paste the result here.</p>`;
      case 'silence-remove': return `
        <div class="ed-field"><label>Video or audio</label><select id="ai-f-media">${[...videos, ...audio].map((x) => `<option value="${x.id}">${esc(x.original_name)} (${x.kind})</option>`).join('') || '<option value="">No media yet</option>'}</select></div>
        <div class="ed-field"><label>Silence threshold (dB, e.g. -35)</label><input id="ai-f-threshold" type="number" min="-60" max="-10" value="-35"></div>
        <div class="ed-field"><label>Minimum silence length (seconds)</label><input id="ai-f-duration" type="number" min="0.1" max="5" step="0.1" value="0.5"></div>
        <div class="ed-field"><label><button class="btn" id="ai-detect-silence" type="button">Detect silence first</button></label><div id="ai-silence-preview" class="sub"></div></div>
        <p class="sub">Uses FFmpeg silencedetect — silent parts are cut out, the rest is joined into a new video. Nothing is faked: the preview shows the real silence list before you cut.</p>`;
      case 'magic-grab': return `
        <div class="ed-field"><label>Image</label><select id="ai-f-media">${images.map((x) => `<option value="${x.id}">${esc(x.original_name)}</option>`).join('') || '<option value="">No images yet</option>'}</select></div>
        <div class="ed-field"><label>Click point — X (px)</label><input id="ai-f-x" type="number" min="0" value="160"></div>
        <div class="ed-field"><label>Click point — Y (px)</label><input id="ai-f-y" type="number" min="0" value="160"></div>
        <p class="sub">Clicks extract the SINGLE object at that point (connected-component segmentation on the local U-2-Net mask) — not the whole foreground. No prior Background-Remover run is needed. A click on background fails honestly.</p>`;
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
    const slides = val('ai-f-slide-count'); if (slides !== undefined && slides !== '') out.slideCount = Number(slides);
    const audience = val('ai-f-audience'); if (audience !== undefined) out.audience = audience;
    const diff = val('ai-f-difficulty'); if (diff) out.difficulty = diff;
    const lang = val('ai-f-language'); if (lang) out.language = lang;
    const name = val('ai-f-name'); if (name !== undefined) out.name = name;
    const proj = val('ai-f-project'); if (proj) out.projectId = Number(proj);
    const media = val('ai-f-media'); if (media) out.mediaId = Number(media);
    const task = val('ai-f-task'); if (task) out.task = task;
    const tone = val('ai-f-tone'); if (tone) out.tone = tone;
    const length = val('ai-f-length'); if (length) out.length = length;
    // v2.5.0 new-mode params.
    const template = val('ai-f-template'); if (template) out.template = template;
    const music = val('ai-f-music'); if (music) out.musicMediaId = Number(music);
    const alt = document.getElementById('ai-f-alternate'); if (alt) out.alternate = alt.checked;
    const seedMode = val('ai-f-seedance-mode'); if (seedMode) out.seedanceMode = seedMode;
    const editPrompt = val('ai-f-edit-prompt'); if (editPrompt) out.editPrompt = editPrompt;
    const kind = val('ai-f-kind'); if (kind) out.kind = kind;
    const strength = val('ai-f-strength'); if (strength !== undefined && strength !== '') out.strength = Number(strength);
    const toLang = val('ai-f-to-language'); if (toLang) out.toLanguage = toLang;
    const skill = val('ai-f-skill'); if (skill) out.skill = skill;
    const threshold = val('ai-f-threshold'); if (threshold !== undefined && threshold !== '') out.thresholdDb = Number(threshold);
    const x = val('ai-f-x'); if (x !== undefined && x !== '') out.x = Number(x);
    const y = val('ai-f-y'); if (y !== undefined && y !== '') out.y = Number(y);
    const cues = val('ai-f-cues'); if (cues) { try { out.cues = JSON.parse(cues); } catch { out.cues = []; } }
    const keep = val('ai-f-keep'); if (keep !== undefined) out.keepText = keep;
    const speakers = val('ai-f-count');
    if (mode === 'bilingual' && speakers !== undefined && speakers !== '') out.speakers = Number(speakers);
    if (mode === 'director' && speakers !== undefined && speakers !== '') out.episodes = Number(speakers);
    const clips = [...document.querySelectorAll('#ai-f-clips input[type=checkbox]:checked')].map((c) => Number(c.value));
    if (clips.length) out.mediaIds = clips;
    const batchProjs = [...document.querySelectorAll('.ai-batch-proj:checked')].map((c) => Number(c.value));
    if (batchProjs.length) out.projectIds = batchProjs;
    if (mode === 'batch-edit') {
      const bop = val('ai-f-batch-op');
      const barg = val('ai-f-batch-arg');
      if (bop === 'transition-all') out.op = { op: 'transition-all', type: (barg || 'fade').trim(), duration: 0.5 };
      else if (bop === 'volume-all') out.op = { op: 'volume-all', volume: Number(barg) || 0.8 };
      else if (bop === 'rename-prefix') out.op = { op: 'rename-prefix', prefix: barg || '' };
    }
    if (mode === 'seedance') out.providerId = 'seedance';
    if (mode === 'video-enhance' || mode === 'retouch') { const k = val('ai-f-kind'); if (k) out.kind = k; }
    if (mode === 'avatar') { const s = val('ai-f-source'); if (s) out.photoMediaId = Number(s); }
    if (mode === 'magic-grab') { const s = val('ai-f-media'); if (s) out.mediaId = Number(s); }
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
      case 'write':
        return `<p class="sub">Task: <b>${esc(r.task || '')}</b> · Provider: ${esc(r.provider || '')}</p>
          <div class="ed-field"><label>Result</label><textarea id="ai-write-text" rows="8" readonly>${esc(r.text || '')}</textarea></div>
          ${(r.alternatives || []).length ? `<div class="ed-field"><label>Alternatives</label>${(r.alternatives || []).map((a) => `<div class="kv"><span>${esc(a)}</span><button class="btn btn-sm" data-copy-alt="${esc(a)}">Copy</button></div>`).join('')}</div>` : ''}
          <div class="ed-btnrow"><button class="btn" id="ai-copy-write">Copy result</button></div>`;
      case 'deck':
        return `<p class="sub">Deck: <b>${esc(r.projectName || '')}</b> — ${r.slideCount || 0} slides.</p>
          ${(r.needsAttention || []).length ? `<p class="sub" style="color:var(--warning, #d97706)">Needs attention: ${esc(r.needsAttention.join('; '))}</p>` : ''}
          <p class="sub">A NEW presentation project was created — nothing existing was changed.</p>
          <div class="ed-btnrow"><button class="btn btn-primary" id="ai-open-deck">Open in Presentations</button></div>`;
      case 'seedance':
      case 'video-enhance':
      case 'retouch':
      case 'video-translate':
      case 'avatar':
      case 'silence-remove':
      case 'transcript-edit':
      case 'magic-grab':
        return r.url ? `${r.mediaId && (j.mode === 'video-translate' || j.mode === 'avatar' || j.mode === 'silence-remove' || j.mode === 'transcript-edit' || j.mode === 'video-enhance') ? `<video src="${esc(r.url)}" controls style="max-width:100%;border-radius:12px"></video>` : `<img src="${esc(r.url)}" alt="result" style="max-width:100%;border-radius:12px">`}
          <p class="sub">${esc(r.method || r.provider || '')}${r.note ? ` — ${esc(r.note)}` : ''}${r.removedSeconds !== undefined ? ` · Removed ${r.removedSeconds.toFixed(1)}s of silence.` : ''}${r.cutCues !== undefined ? ` · Cut ${r.cutCues} cue(s), kept ${r.keptCues}.` : ''} Saved to your Media Library.</p>` : '';
      case 'autocut':
      case 'editpilot':
      case 'director':
      case 'infinite-canvas':
        return `<p class="sub">Project: <b>${esc(r.projectName || '')}</b>${r.clips ? ` — ${r.clips} clips, ${r.durationSeconds || 0}s, template ${esc(r.template || '')}.` : ''}${r.applied ? ` Applied: ${r.applied.length} op(s)${r.skipped && r.skipped.length ? `; skipped: ${esc(r.skipped.join('; '))}` : ''}.` : ''}${r.nodes ? ` — ${r.nodes} canvas nodes, skill ${esc(r.skill || '')}.` : ''}${r.episodes ? ` — ${r.episodes} episode(s) planned.` : ''}</p>
          <p class="sub">A ${j.mode === 'editpilot' && !r.alternate ? 'real timeline edit on your project' : 'NEW editable project'} — open it in the editor to keep working.</p>
          <div class="ed-btnrow"><button class="btn btn-primary" id="ai-open-project">Open project</button></div>`;
      case 'lyrics':
        return `<p class="sub">${(r.lines || []).length} lyric lines · ${esc(r.note || '')}</p>
          <div class="ed-field"><label>SRT</label><textarea rows="8" readonly>${esc(r.srt || '')}</textarea></div>
          <div class="ed-btnrow"><button class="btn" id="ai-dl-srt">Download SRT</button></div>`;
      case 'ai-lab':
        return `<p class="sub">Topic: <b>${esc(r.topic || '')}</b> — ${esc(r.kind || '')}</p>
          ${(r.items || []).map((it, i) => `<div class="kv"><span><b>${i + 1}. ${esc(it.title || '')}</b><br><small>${esc(it.detail || '')}</small></span><button class="btn btn-sm" data-copy-alt="${esc(it.title || '')}">Copy</button></div>`).join('')}`;
      case 'batch-edit':
        return `<p class="sub">Batch edit: ${r.okCount}/${r.total} projects updated.</p>
          <table><thead><tr><th>Project</th><th>Result</th></tr></thead><tbody>${(r.results || []).map((x) => `<tr><td>${x.projectId}</td><td>${x.ok ? `✓ ${x.changed ?? 0} clip(s) changed` : `✗ ${esc(x.error || '')}`}</td></tr>`).join('')}</tbody></table>`;
      case 'bilingual':
        return `<p class="sub">Bilingual captions (${esc(r.secondLanguage || '')}) · ${esc(r.note || '')}</p>
          <div class="ed-field"><label>SRT (bilingual)</label><textarea rows="8" readonly>${esc(r.srt || '')}</textarea></div>
          <div class="ed-btnrow"><button class="btn" id="ai-dl-srt">Download SRT</button></div>`;
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
    const openDeck = document.getElementById('ai-open-deck');
    if (openDeck) openDeck.addEventListener('click', () => go('presentations'));
    const cw = document.getElementById('ai-copy-write');
    if (cw) cw.addEventListener('click', async () => { await navigator.clipboard.writeText(r.text || ''); toast('Text copied.'); });
    document.querySelectorAll('[data-copy-alt]').forEach((b) => b.addEventListener('click', async () => { await navigator.clipboard.writeText(b.dataset.copyAlt); toast('Alternative copied.'); }));
  }

  async function view(c, presetMode) {
    if (presetMode && modes().some((m) => m.id === presetMode)) mode = presetMode;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    await loadAll();
    const def = modeDef(mode);
    const ks = kindState(def.kind);
    const activeProv = (ks.providers || []).find((p) => p.active);
    c.innerHTML = `
    <div class="card"><h3>✨ AI Studio</h3>
      <p class="sub">Real AI generation through configurable providers. Every result is saved to your Media Library. Without a key, a mode refuses honestly with “key needed” — nothing is faked.</p>
      <div class="ai-modes">${modes().map((m) => {
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
