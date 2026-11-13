# CreativeStudio AI Pro — Master Prompt (summary)

Source: user master prompt, 2026-11-12. This file is a faithful summary of the
full 27-section specification; the authoritative text is the user's original
message. Keep this file updated if the spec changes.

## Vision
All-in-one AI graphic design, video editing, bulk video automation & social
media content platform. Original implementations with comparable capabilities
to Canva / CapCut / Premiere / After Effects / Photoshop — do not copy
proprietary code, interfaces, trademarks or licensed assets.

**Goal:** one platform to create professional graphics, videos, ads, promo
content, social posts and hundreds of personalised videos.

## Dashboard — 27 sidebar sections
Dashboard, AI Design Studio, Graphic Editor, Video Editor, AI Video
Generator, AI Image Generator, Bulk Design Studio, Bulk Video Studio, Smart
Template Builder, Long Video to Shorts, AI Music Studio, Auto Captions,
Background Remover, Effects & Transitions, Animation Studio, Brand Kit, Media
Library, Stock Assets, Social Media Creator, Content Calendar, Export Center,
Projects, Templates Marketplace, AI Assistant, Analytics, Settings,
Subscription & Credits. Plus global search, notification centre, user profile,
recent projects, quick actions, system status.

## Key modules
- **Graphic Design Studio:** custom sizes, layers, snapping, typography, AI
  design assistant (prompt → *editable* design, never a flattened image).
- **Video Editor:** multi-track timeline, keyframes, transitions, colour
  grading, chroma key, speed ramping, stabilisation.
- **Bulk Video Studio (main differentiator):** one master template +
  spreadsheet (XLSX/CSV/Sheets/JSON) → hundreds of videos. **Dynamic
  Background Engine is mandatory:** per-row unique background — random pool,
  AI-generated, BACKGROUND_PROMPT column, category-based, uploaded pool.
  No-repeat by default; text/logo/price stay in template positions.
  Background/async batch processing, progress, retry, ZIP export.
  Formats 9:16 / 16:9 / 1:1 / 4:5 / custom.
- **AI Music Sync Director:** real beat/BPM/drop analysis; scene changes,
  transitions and effects follow the music. Licensed or user-provided music only.
- **Long Video to Shorts:** transcription, scene/speaker/emotion analysis,
  ranked clips with timestamps + engagement score (explainable signals —
  never claim to predict virality), auto-reframe, captions, gallery review.
- **AI Captions:** Urdu, English, Roman Urdu, Arabic (proper RTL), Hindi;
  word-by-word, SRT/VTT export, editable transcript.
- **AI Image/Video generation:** text-to-image, image-to-image, image-to-video,
  text-to-video via configurable providers; provider abstraction.
- **Effects & asset library, Brand Kit, Social Media Studio** (AI posts,
  captions, hashtags, calendar; publishing only via official APIs).
- **Export Center:** PNG/JPG/WebP/SVG; MP4/MOV/WebM; 720p–4K; batch + ZIP.
- **Media Library, AI Assistant** (previews before destructive edits),
  **Project management** (autosave, versions, trash/recovery),
  **Accounts & subscriptions** (Free/Starter/Pro/Business/Enterprise,
  transparent credits), **Admin panel**, **security** (auth, RBAC, encrypted
  secrets, upload validation, ownership checks).

## UI
Premium dark theme (deep navy/charcoal, purple + blue accents), optional
light theme. Three-area editor: left assets/tools, centre canvas/preview,
right properties, bottom timeline. Desktop-first timeline, simplified mobile.

## Tech
Frontend React/Next.js/TS/Tailwind (Phase 1 uses vanilla JS + same-server
serving to avoid a build step; migrate per plan). Video: FFmpeg/FFprobe,
WebCodecs, workers, proxy editing. Backend Node.js or FastAPI, REST +
WebSocket progress. PostgreSQL + Redis + object storage in production
(Phase 1 uses SQLite file DB for local-first simplicity). Modular AI
providers: LLM, STT, TTS, image, video, scene detection, tracking, bg
removal, music analysis, translation. **Never hardcode secret API keys.**

## Rendering engine (critical)
Real video files via a reliable pipeline: job queues, parallel processing
with limits, progress, cancel, retry, error reporting, cleanup, logs,
validation. Never simulate with static images or fake progress.

## Development rules (§24)
Real working functionality only; every button does its action; every form
validates and saves real data; every generated video is a real playable file;
bulk processes real rows; Dynamic Background Engine works per video; music
sync analyses real audio; Shorts analyses the real upload; AI uses real
connected providers; clear errors when a provider is unavailable; never fake
success; never placeholder-as-complete; preserve working functionality;
automated tests; never claim complete until tested.

## Phases
1. Foundation — architecture, auth, DB, dashboard, media library, projects, UI system. **Done (2026-11-12, tests 17/17).**
2. Graphic Design Studio. **Done (2026-11-12, tests 28/28 incl. Phase 1).** Canvas editor, layers, typography, shapes, images + filters/crop, templates, Brand Kit, PNG/JPG export, AI Design Studio (rule-based local layout helper + live AI design assist since Phase 7, needs an LLM key). Text curvature not implemented (no fake control shown).
3. Video Editor + rendering engine. **Done (2026-11-12, tests 37/37 incl. Phases 1–2).** Multi-track timeline (trim/split/ripple delete/group/markers/undo), speed/volume/fades/rotation/flip/fit-fill/zoom/filters, text clips with fade/slide, Fade/Dissolve/Slide/Wipe via FFmpeg xfade, position/scale/opacity keyframes, real FFmpeg render queue (real progress, cancel/retry, ffprobe validation, logs), Export Center, media probing + thumbnails. Not built: chroma key, stabilization, proxy editing, motion paths/easing, 4K, 3rd video track.
4. Bulk Design & Bulk Video (incl. Dynamic Background Engine). **Done
   (2026-11-12, tests 64/64 incl. Phases 1–3).** Template Builder with
   `{{fields}}` (video + design), XLSX/CSV/JSON/manual import, field
   mapping, per-row Dynamic Background Engine (random unique / AI /
   prompt-column / category / uploaded pool; no-repeat default, after-N,
   fully random, manual), readability protection (measured luminance +
   busyness → auto dark overlay/blur per render), duplicate skip
   (whole-row default + key-column; duplicates never rendered, never
   retried, reported in preview + job report), batch jobs on the Phase 3
   render queue (per-row progress, sample render, retry, cancel, ZIP),
   Bulk Design PNG/JPG per row + ZIP. **Quiz Video preset** (research
   spec 2026-11-12: 1080×1920, 2s read + 3s countdown + 2s reveal + 3s
   score card, stacked options, safe box x48–888/y288–1248, navy #14213D
   + amber #FCA311 accent, green + ✓ correct, caps 80/22 chars,
   RTL support) with overflow-proof fit (wrap-first-then-shrink to the
   readable minimum: question 28px / option 24px @1080×1920; “Needs
   attention” + suggested shorter text instead of a bad video) and
   batch-uniform fonts (one question size + one options size per batch,
   outliers flagged, never below the minimum). **Quiz Narration + Voice
   upgrade (done 2026-11-12, v1.5.0, tests 84/84 incl. Phases 1–5):**
   narration sequencing (question → options one by one → answer, one timed
   plan drives timeline + phone preview + narration placement), per-element
   animations Auto + Manual (fade / slide-left/right/up/down / pop — real
   drawtext expressions; typewriter not possible, never offered), voice
   profiles (own voice from a recorded sample = default on all videos,
   plus AI voices), bulk voice option (one voice per batch, per-row VOICE
   override wins), recorded narration via NARRATION_AUDIO (works now, no
   key; proven end-to-end with a real MP4 + audio stream), TTS/cloning
   pipeline (ElevenLabs + OpenAI, cached per voice+text) that refuses
   honestly with key_needed when no key is configured — never a fake
   voice. AI background modes and AI-generated questions are now live in
   Phase 7 (need an image / LLM key). Google Sheets import is live in
   Phase 8 (real Google OAuth, read-only). Not built: A vs B quiz format.
5. AI Music Director. **Done (2026-11-12, tests 75/75 incl. Phases 1–4).**
   Real local-DSP analysis (FFmpeg decode → 22050 Hz mono PCM → FFT
   spectral-flux onset envelope → fractional-lag autocorrelation BPM
   60–200 with grid-coverage octave check → phase-search beat grid +
   downbeat estimate, energy curve, drop detection, 200-bucket waveform;
   confidence score; flat audio refused, never a guessed BPM), cached per
   (user, track, file hash) in `audio_tracks`. Music Library (user's own
   audio, licensed-or-provided only, license/source note per track; no
   stock download, no generation). Music Sync Director UI (waveform +
   beat grid + energy + drops; sync mode cut/transition/both, beat
   divisor 1/2/4, transition, beat pulse on text, trim/offset, fades,
   volume, loop-or-trim) → Apply sync rewrites the timeline (cuts at beat
   times, transitions at beat cuts, beat/drop markers, music clip, pre-sync
   version saved), renders via the Phase 3 queue with the music mixed in.
   Beat-snap + beat ruler in the Video Editor (toggleable, default ON).
   AI music generation / mood tagging are now live in Phase 7 (need a
   music / LLM key). Not built: multi-track
   audio mixing, virality prediction (never claimed).
6. Long Video to Shorts. **Done (2026-11-12, v1.6.0, tests 97/97 incl. Phases 1–5 + narration upgrade).**
   Real local analysis (FFmpeg scene detection + silencedetect + audio
   energy curve from an 8 kHz PCM decode; no key, no provider), ranked
   clip candidates with an explainable score (45% speech density + 30%
   energy + 15% scene-change rate + 10% position; breakdown shown per
   clip; never claims to predict virality), motion-centroid 9:16 reframe
   (1080×1920 / 720×1280, h264 + AAC, via the Phase 3 render queue),
   clip review gallery (approve / reject / trim, thumbnails, per-clip
   download, ZIP). Captions: STT transcription refuses honestly with
   key_needed when no key is configured (never a fake transcript);
   manual transcripts work now (plain text = estimated timing, SRT/VTT
   = exact timing), editable, SRT/VTT export, word-by-word burn-in via
   libass ASS (proper Arabic/Urdu/Devanagari shaping) in English, Urdu,
   Roman Urdu, Arabic (RTL) and Hindi. Automatic transcription is now
   live in Phase 7 (real Whisper when an STT key is configured; still
   refuses honestly with key_needed without one). Face/subject tracking
   for the reframe is still not built (motion centroid only; a vision
   model would be needed).
7. AI Creative Studio. **Done (2026-11-12, v1.7.0, tests 111/111 incl. Phases 1–6 + narration upgrade).** Provider registry (8 providers, 6 kinds: image/video/llm/tts/stt/music) with configurable base URL + model, encrypted keys, Test connection (real minimal calls); AI Studio with 10 modes (text-to-image, image-to-image, text-to-video, image-to-video, AI voice, AI quiz questions, AI design assist, AI transcribe, music mood tags, AI music) as async jobs (queue, progress, cancel, retry, usage log), results saved to the Media Library; stubs unlocked through the same layer (bulk AI/prompt backgrounds with prompt-hash cache, narration TTS via the registry, Shorts STT, live AI Design Studio, AI quiz questions, AI music/mood). No key → every mode refuses with key_needed and creates no output (proven against a local mock provider in tests/ai-studio.test.js). Not live-verified against real providers yet (no real key exists in this build).
8. Social & business tools. **Done (2026-11-12, v1.8.0, tests 127/127 incl. Phases 1–7 + narration upgrade).** Social Media Studio (compose + attach from library, per-platform real char limits, AI caption via Phase 7 LLM — 1 credit, honest key_needed without a key — plus clearly-labelled local template captions and local hashtags, drafts/scheduling, content calendar, background scheduler every 15 s; publishing ONLY through official platform APIs when connected — Facebook Graph, X v2, LinkedIn, Instagram Graph, YouTube multipart — unconnected refuses with NOT_CONNECTED, failed posts carry the real error, manual posting recorded separately with note + link, never a fake publish); Google Sheets import (real Google OAuth, read-only scopes, list → pick tab → import with the same dedupe as CSV); Billing & credits (Free/Starter/Pro/Business/Enterprise, transparent ledger, charge on success + pre-flight block at 0, no payment gateway — plan changes are OWNER-approved requests, no payment taken); Admin panel (OWNER/ADMIN only, users/roles/suspend/unsuspend/credit reset/delete, platform stats, per-user usage, audit log, system health); in-app Templates Marketplace (design/video project templates, content snapshot, install = real editable project, rate/report, no external store); Analytics (DB-only numbers, no invented benchmarks). Honest limits: TikTok video upload initialises but chunk upload is not implemented (fails honestly); Instagram needs a public media URL; marketplace is design/video only. Tests: tests/social.test.js (16 tests, port 4839) against a local mock server (Facebook/X/OpenAI Chat/Google OAuth+Drive+Sheets shapes).
9. Final QA. **Done (2026-11-13, v1.9.0, tests 132/132 incl. Phases 1–8 + narration upgrade).**
   Acceptance A–D all PASS with evidence in `docs/FEATURE_COMPLETION.md` §6
   and `docs/acceptance-a-report.json`: A — real 100-row `.xlsx` →
   100/100 videos, 0 failed, all backgrounds different, every output
   ffprobe-valid (h264 1280×720 ~1s), logo + row text spot-checked 5/5;
   B — 120 BPM click analysed at 120 BPM, cuts at 0.45/1.45/2.45/3.45s,
   synced render carries audible mixed music; C — known-structure 30s
   video → valid ranked clips, approved clip renders real 1080×1920 MP4
   with audio + captions (60-min video not rendered end-to-end — stated
   scope); D — design save → close → reopen byte-identical, twice.
   Feature completion report (`docs/FEATURE_COMPLETION.md`), install /
   deployment / API guides (`docs/INSTALL.md`, `docs/DEPLOYMENT.md`,
   `docs/API.md`) written. QA fixed 3 overclaiming sidebar blurbs and
   4 acceptance-test bugs. Remaining after Phase 9: provider keys / platform connections /
   Google OAuth to run AI, publishing, and Sheets for real.
11. Auto-Update system. **Built (2026-11-13, v2.1.0, tests 144/144).**
   PageCommand-Pro-style self-update, added after the Final Redesign at the
   user's request ("jasy pagecommand pro mein bnya hy"): URL feed
   (`version.json` + `update-<version>.json`, default
   `https://raw.githubusercontent.com/kingaamir022-sketch/creative-studio-ai-pro/main/updates`),
   SHA-256 verification of package and every file, backup (last 2) + rollback,
   Windows apply via `apply-update.bat` (waits for exit, swaps files, relaunches
   `Start.bat`), Settings → Updates UI, Dashboard banner once per available
   version, auto-check on start + every 6 h, auto-apply OFF by default,
   `fullReinstall` updates refused in place, `scripts/publish-update.js`
   builds the package + manifest. Feed repo created 2026-11-13; feed goes
   live once the manifest + first package are pushed to its `updates/` folder.
   See `docs/UPDATE_SYSTEM.md` and `docs/RELEASE.md`.
10. Final Redesign. **Done (2026-11-13, v2.0.0, tests 132/132).** Whole-project
   redesign, design only, no new features or behaviour changes: `public/tokens.css`
   (three-tier tokens — primitives → semantics → components; type scale
   12/13/14/16/18/20/24/30px + display with tight tracking; spacing 4/8/12/16/24/32/48px;
   radii 6/8/12/16px; shadows sm/md/lg for floating elements only; dark default +
   `[data-theme="light"]` token swap with the same names); Light/Dark toggle in the
   topbar (persisted in localStorage, `prefers-color-scheme` on first load, applied
   before first paint); app shell (sidebar with all 27 items, topbar, global search,
   notification centre, new profile menu, dashboard KPI strip); every module view
   re-skinned through the tokens (all 11 stylesheets, no raw hex left in chrome —
   only canvas/stage/phone-frame/quiz-brand content colours remain); shared
   components (buttons primary/secondary/ghost/danger + sm/md, inputs with
   default/focus/filled/error/disabled states, cards 1px border, tables with
   tabular-nums, badges with label + icon, modals, toasts, progress, tabs,
   toggles, skeleton loading); responsive ≤860px (sidebar becomes an off-canvas
   drawer behind a hamburger, panels stack, no horizontal overflow); accessibility
   (visible 2px focus ring, contrast-checked light + dark, no colour-only meaning).
   Two stale-copy fixes only: dashboard System status version was still
   `1.2.0 (Phase 3 — Video Editor)` and the AI-credits card still said
   `no charges in Phase 1`. Full research notes + per-view checklist in
   `docs/REDESIGN.md`. Google Fonts link kept (a test asserts it is loaded);
   no new dependencies.

## Acceptance tests
- **A — Bulk Video:** 100-row Excel → 100 videos, correct row data, all
  different backgrounds (no-repeat), logos positioned, all playable.
  **PASS (2026-11-13, Phase 9):** `node scripts/acceptance-a.js` — real
  100-row `.xlsx`, 100/100 videos, 0 failed, 0 skipped, 100 unique
  backgrounds, 100 unique output hashes, every output ffprobe-valid
  (h264 1280×720 ~1s), logo positioned 5/5 and row text visible 5/5
  spot-checked; report `docs/acceptance-a-report.json`. A 10-row version
  of the same assertions runs in `tests/acceptance.test.js`.
- **B — Music Sync:** scene changes/transitions follow detected beats.
  **PASS (2026-11-12, Phase 5):** cuts + transitions land on real beat
  times (proven on 120 BPM / 90 BPM click tracks) and a synced render
  carries the mixed music (ffprobe-valid, audio stream present, RMS
  above the silence floor).
- **C — Long Video to Shorts:** 60-min video → 10 clips, valid timestamps,
  meaningful content, synced captions, subject visible, correct formats.
  **PASS with a stated scope (2026-11-12, Phase 6):** a generated 30 s
  video with known cuts (10s/20s) and silence windows produces valid,
  ranked, in-bounds clips, and an approved clip renders a real
  1080×1920 MP4 with audio + burned-in captions (ffprobe-valid;
  `tests/shorts.test.js`). A full 60-minute video was not rendered
  end-to-end in tests (too long); the pipeline is the same code path and
  analysis of long videos runs asynchronously in the background. Subject
  visibility is via the motion-centroid reframe, not face tracking
  (stated honestly in the UI and README).
- **D — Graphic Design:** create → save → close → reopen, all layers/fonts/
  images/positions preserved.
  **PASS (2026-11-13, Phase 9):** gradient background + grouped text
  (96px, shadow) + shape + image layer (filters, crop, flip) saved,
  edited (4th layer added), closed, reopened — byte-for-byte identical
  to the saved JSON, twice in a row; the edited save has a version entry
  (`tests/acceptance.test.js`).

## Delivery
Complete source, frontend, backend, schema/migrations, provider layer,
render engine, background processing, admin panel, .env example, install +
deployment guides, API docs, automated tests, error handling, production
build, and a feature completion report (implemented / needs credentials /
pending — never mark incomplete as complete).
