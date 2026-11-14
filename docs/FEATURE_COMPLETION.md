# CreativeStudio AI Pro — Feature Completion Report (Phase 11, Final QA)

**Version:** 2.6.0 · **Date:** 2026-11-14 · **Suite:** `npm test` — **395/395 pass, 0 fail** (376 baseline in v2.5.0 + 19 new Electron tests; single clean run, exit 0)
(exit 0, single clean run; see [Acceptance verdicts](#acceptance-verdicts-a–d) below).

**Rule of this report:** every feature is exactly one of **Implemented**,
**Needs credentials**, or **Pending** — nothing incomplete is marked complete.
"Needs credentials" means the code is built and tested (against a local mock
provider / mock platform / mock Google server) but it cannot do anything real
until the user supplies a key, token, or OAuth connection. No real provider
key, platform token, or Google credential exists in this build, so **no
real-provider or real-platform call has ever run**.

## 1. The 36 sidebar features (CapCut groups, v2.3.0; Effects/Transitions split in v2.4.0)

| # | Section | Status | Notes |
|---|---------|--------|-------|
| 1 | Dashboard | Implemented | Real DB counts, recent projects/media, system status (FFmpeg, storage vs plan), notifications, quick actions, global search (projects & media). |
| 2 | AI Design Studio | Needs credentials | Prompt → editable design (never a flattened image) works through the Phase 7 LLM layer; without an LLM key it refuses with `key_needed`. A clearly-labelled local rule-based layout helper works with no key. |
| 3 | Graphic Editor | Implemented | Real canvas editor (drag/resize/rotate, layers, undo/redo, snap guides, 12 sizes, 15 fonts, shapes/images/filters/crop, gradient + transparent PNG/JPG export), 26 built-in templates (20 design + 3 video + 3 deck, v2.2.4), Brand Kit. **v2.5.0:** text curvature is built (curve-angle slider + live arc preview + server arc render). |
| 4 | Video Editor | Implemented | Multi-track timeline (drag/trim/split/ripple/group, markers, snapping, undo/redo), speed/volume/fade/filters, text clips, 28 xfade transitions via FFmpeg (apply-to-all, up to 5 s), rotation/volume keyframes with per-key easing, real FFmpeg render queue. **v2.5.0:** chroma key, stabilisation, speed curves (0.1–100×), 4K, N video tracks, effects library (16), masking, reverse/freeze, voice processing, auto reframe, optical flow, compound clips, waveforms, SRT captions, full shortcut map — all built (see §1g). **Pending:** proxy editing (setting stored; preview still renders full quality). |
| 5 | AI Video Generator | Needs credentials | Text-to-video / image-to-video via the Phase 7 provider registry (Runway). Without a video provider key it refuses with `key_needed`. |
| 6 | AI Image Generator | Needs credentials | Text-to-image / image-to-image (OpenAI Images / Stability). Without an image provider key it refuses with `key_needed`. |
| 7 | Bulk Design Studio | Implemented | One template + spreadsheet → PNG/JPG per row, ZIP export, whole-row dedupe (duplicates never generated, never retried). |
| 8 | Bulk Video Studio | Implemented | The flagship: `{{FIELD}}` templates, XLSX/CSV/JSON/Google Sheets import, Dynamic Background Engine (Random Unique / Category / Uploaded Pool real; AI + Prompt-Based live in Phase 7 but need an image key), per-row real MP4 renders, failed-row retry, ZIP export, duplicate-skip, quiz preset to the research spec, overflow-proof fit + batch-uniform fonts, narration + voice. **Pending:** A vs B quiz format. |
| 9 | Smart Template Builder | Implemented | Master-template builder with `{{FIELD}}` bindings, field mapping, background rules, fit-check, sample render. (Lives inside Bulk Video/Design.) |
| 10 | Long Video to Shorts | Implemented | Real local analysis (scene + silence + energy), explainable ranked clips, motion-centroid 9:16 reframe, review gallery, captions. **Pending:** face/subject tracking for the reframe (motion centroid only); a full 60-minute video was not rendered end-to-end (see acceptance C). |
| 11 | AI Music Studio | Implemented | Real local DSP: BPM/beat grid/downbeats/energy curve/drop detection, waveform, confidence; Music Library (own/licensed audio only); Sync Director (cut/transition on beat, divisor, pulse, fade/volume/loop); beat-snap + beat ruler. AI music generation / mood tagging are live in Phase 7 but **need a music / LLM key**. **Pending:** multi-track audio mixing. |
| 12 | Auto Captions | Implemented | Manual transcripts (plain text = estimated timing, SRT/VTT = exact), editable, SRT/VTT export, word-by-word burn-in, Urdu/English/Roman Urdu/Arabic RTL/Hindi. Automatic transcription is live in Phase 7 but **needs an STT key** (refuses with 402 `key_needed` without one — never a fake transcript). |
| 13 | Background Remover | Implemented (v2.2.2) | Free local U-2-Net ONNX model (`onnxruntime-web`, WASM) — no key, nothing uploaded. Model (~168 MB) downloads once on first use into `data/models/u2net.onnx` and is cached; offline → honest 503. Also powers Magic Grab. Live in Magic Tools; the sidebar entry is now the Magic Tools view. |
| 14 | Effects | Implemented | **v2.5.0:** the editor's Effects tab now lists the 16 real FFmpeg effects (Glitch, Retro, Blur, VHS, Film Grain, Light leaks, …) with intensity sliders, plus adjustment layers; chroma key, stabilisation, speed ramping and motion paths/easing are all built. The view still lists object removal and proxy editing as **not built**, never as working. Clip presets apply in one click from the editor's Effects tab (`POST /api/magic/animate` → real keyframes). Fade and Slide are NOT here — they are transitions. |
| 15 | Transitions | Implemented | **v2.5.0:** 28 clip-to-clip xfade transitions rendered with FFmpeg between adjacent clips on the same video track, duration up to 5 s, Apply-to-all; the editor's Transitions tab lists only these. Fade and Slide are transitions, not effects — never mixed with Effects. |
| 16 | Animation Studio | Implemented | Keyframes (position/scale/opacity, linear interpolation) + text fade/slide/pop animations, auto + manual per-element timing. **v2.2.2 — Magic Animate presets:** 10 one-click presets (fade, slide-up, slide-left, pop, zoom, bounce, float, pulse, spin, typewriter); design presets apply to a layer in the Graphic Editor and preview live with CSS; clip presets expand into real video keyframes held to the clip end. **Still pending:** motion paths, easing curves; typewriter and spin are design-only (drawtext cannot render them — never offered for clips). |
| 17 | Brand Kit | Implemented | Brand profiles (logos, colours, fonts), one-click apply to designs. |
| 18 | Media Library | Implemented | Real uploads (image/video/audio, 200 MB default), search/tags/folders/favourites/preview, delete removes the disk file. |
| 19 | Stock Assets | Implemented (v2.2.4, video in v2.5.0) | Free stock images + audio via Openverse (key-free anonymous API, verified live) — search by keyword/license/category, preview, save straight into the Media Library with attribution + license recorded; re-saving the same asset returns the existing row (duplicate skipped, never a second copy). **v2.5.0:** stock video via Pexels (free key in Settings, encrypted) — search + save end to end; without a key the honest `NO_VIDEO_SEARCH` 400 (Openverse has no video search, so the UI says so plainly). |
| 20 | Social Media Creator | Implemented | Compose + attach from library, real per-platform char limits, AI caption/hashtags via Phase 7 LLM (**needs an LLM key**; local template captions are clearly labelled, never "AI"), drafts/scheduling, scheduler. Publishing **only via official platform APIs when connected** — no platform is connected on a fresh install, so Publish refuses with `NOT_CONNECTED`; never a fake publish. **v2.5.0:** TikTok video upload is finished (chunk upload after the working init; ends `published` with a real TikTok video id, or fails honestly — needs a connected TikTok account). |
| 21 | Content Calendar | Implemented | Month view of scheduled posts, schedule/reschedule from the composer, scheduler runs due posts (every 15 s + manual run). |
| 22 | Export Center | Implemented | Render-job list, download, save-to-library, ZIP. Formats actually offered: PNG/JPG designs, MP4 and MOV video at 720p/1080p (MOV = same H.264+AAC, QuickTime container, v2.4.0). **v2.5.0:** 2K/4K, WebM (VP9), HEVC, HDR (10-bit), custom filenames, estimated size, audio-only MP3/WAV, frame PNG, GIF, export queue, per-platform presets. **Pending:** WebP/SVG. |
| 23 | Projects | Implemented | CRUD, duplicate, trash/restore/permanent delete, autosave, version history (latest 20) + restore, per-user ownership. |
| 24 | Templates Marketplace | Implemented | In-app only (no external store): publish design/video/deck templates, browse/search, install = a real editable project, rate, report. **v2.2.4:** built-in library grown 8 → 26 (20 design + 3 video + 3 deck), all validated and installable from the Marketplace view; decks publishable too. **Pending:** bulk-job templates are not publishable. |
| 25 | AI Assistant | Implemented (v2.2.4) | Project-aware assistant: summarise a project, suggest improvements, "make this more professional" (design + deck), "create five versions" (design). Every action creates a NEW project — the original is never edited in place. Needs an LLM key (free Gemini works); without one it refuses 402 `PROVIDER_KEY_NEEDED` and creates nothing. |
| 26 | Analytics | Implemented | DB-only numbers: renders over time, AI generations by mode, posts by status/platform, storage, top templates, credit burn. No invented benchmarks. |
| 27 | Settings | Implemented | Provider keys (AES-256-GCM encrypted, never returned in full), Google Sheets OAuth config, platform connections, profile, preferences. |
| 28 | Subscription & Credits | Implemented | Plans Free/Starter/Pro/Business/Enterprise, transparent credit ledger (charge on success, pre-flight 402 block at 0 balance), usage history. **No payment gateway by design** — plan changes are OWNER-approved requests; no payment is taken in this build. |
| 29 | Presentations (v2.2.3) | Implemented | New `deck` project type: 6 slide layouts (title, text, text-image, chart, quiz, blank), add/move/duplicate/delete slides, speaker notes, per-slide duration, present mode, never-overflow fit check + batch uniform fonts for quiz slides, export to slide images (ZIP), PDF, or MP4 video (render queue). AI deck generation via the LLM (needs a key; free Gemini works). |
| 30 | Documents (v2.2.3) | Implemented | New `doc` project type: headings, paragraphs, lists, quotes, tables, images, charts, dividers; autosave; export to HTML, real .docx (Word Open XML) and PDF (A4 pages rendered with the real font metrics); print-friendly view. |
| 31 | Charts (v2.2.3) | Implemented | Bar/line/pie/doughnut charts from pasted CSV or a manual table; duplicate rows permanently skipped (never doubled); SVG + PNG render (pure-JS rasterizer + FFmpeg text labels); save to Media Library as a real image, embeddable in decks, docs, designs and websites. |
| 32 | Website (v2.2.3) | Implemented | Publish a design, deck or document as a static website (index.html + assets) served locally at /sites/:slug/; unpublish removes it. Local hosting only — no custom domain, no external host. |
| 33 | Print (v2.2.3) | Implemented | Print-ready PDF export: A4 / US Letter / Poster 18×24 in at 150 DPI, configurable bleed (0–10 mm) and margin, crop marks + safe-zone guide drawn as vector lines. RGB PDF — CMYK conversion is not built. |
| 34 | AI Studio | Needs credentials | The 10-mode studio (text, image, video, voice, quiz, transcription, music, deck, captions, design) through the Phase 7 provider registry; every mode refuses `key_needed` without its provider key, never a fake result. |
| 35 | Voices | Implemented | Your own voice from a short sample is the default on all videos; AI voices too; bulk voice picker + per-row override. Real cloning/TTS needs a provider key; recorded narration works now. |
| 36 | Admin Panel | Implemented | OWNER/ADMIN only: users, plan requests, platform stats, audit log, system health. |

**v2.3.0 sidebar groups (CapCut order):** Create (Dashboard, AI Design Studio, Graphic Editor, Presentations, Documents, Charts) · AI Studio (AI Studio, AI Video Generator, AI Image Generator, AI Assistant) · Edit (Video Editor, Effects, Transitions, Animation Studio, Magic Tools, Auto Captions) · Bulk & Automation (Bulk Design Studio, Bulk Video Studio, Smart Template Builder, Long Video to Shorts, Music Sync Director, Voices) · Library (Media Library, Stock Assets, Templates Marketplace, Projects, Brand Kit) · Publish & Grow (Social Media Creator, Content Calendar, Website, Print, Export Center, Analytics) · Account (Admin Panel, Settings, Subscription & Credits). Effects under Effects, Transitions under Transitions, AI under AI, library under Library — nothing mixed.

## 1b. v2.2.3 addendum — Docs & Slides (Release B)

**Version:** 2.2.3 · **Date:** 2026-11-14 · **Suite:** `npm test` — **195/195 pass**
(new `tests/docs-slides.test.js`, 14 tests, port 4845 — ports 4831–4844
were already taken by the other 14 suites).

- **Decks:** `deck` project type, slide ops as pure functions
  (`src/docs-slides.js`), deck → design conversion reusing the Phase 4
  server renderer (real PNGs, real fonts), video export through the real
  render queue (slideshow MP4, ffprobe-validated), PDF via the minimal
  PDF writer (`src/pdf-writer.js`, JPEG pages). AI deck generation is a
  new AI mode (`deck`) on the Phase 7 job queue — without an LLM key the
  job fails `key_needed` and creates no project.
- **Docs:** `doc` project type; DOCX is a real Word file (archiver zip:
  `[Content_Types].xml`, `word/document.xml`, embedded images with
  `word/media`); PDF pages are A4 designs paginated with `fitText` line
  splitting (tables repeat their header across pages).
- **Charts:** `src/chart.js` — CSV/table parsing with the standing
  duplicate-skip rule, SVG output, and a pure-JS PNG rasterizer
  (zlib-deflated, no dependency) with FFmpeg `drawtext` labels.
- **Website:** static bundle builder (`buildWebsite`) + `/sites/:slug/`
  public serving from `data/websites/`; slug + row in the `websites` table.
- **Print:** `designsToPrintPdf` — full-bleed pages, crop marks, safe-zone
  rectangle; A4/Letter/Poster at 150 DPI.
- **Bug fixed along the way (latent since Phase 4):** the server design
  renderer built image-layer filter chains as `[0:v],scale=…` — a comma
  after an input link is an empty filter and FFmpeg refused the whole
  render ("No such filter: ''"). Any design with an image layer could
  never render. Fixed in `src/design-render.js` (link joins the first
  filter with no comma); the deck/chart/print flows exposed it. The video
  renderer (`src/render.js`) was checked and does not have the pattern.
- **Still pending after v2.2.3:** the CapCut design pass (v2.3.0); CMYK
  conversion for print PDFs. Stock Assets, AI Assistant, Magic Switch
  (incl. translate), template-library depth and the updater overlay were
  all built in v2.2.4 — see §1c below. Live co-editing is out of scope by
  design (share + comments only, §1c).

## 1c. v2.2.4 addendum — Library & Assistant (Release D)

**Version:** 2.2.4 · **Date:** 2026-11-14 · **Suite:** `npm test` — **217/217 pass**
(new `tests/library-assistant.test.js`, 22 tests, port 4846 — ports 4831–4845
were already taken by the other 15 suites).

- **Stock Assets:** `src/openverse.js` + `src/routes/stock.js` + `public/stock.js`.
  Search Openverse (images + audio, key-free anonymous access — verified
  live from the build machine: anonymous tier, 20 req/min burst, 200/day,
  page_size max 20). Save downloads the file, ffprobe-probes it, stores it
  in the Media Library with attribution + license in `license_note`, tags
  `stock,openverse`; re-saving the same Openverse id returns the existing
  row (`duplicate: true`) — never a second copy. **Openverse has no video
  endpoint** (verified: `/v1/media/?media_type=video` 404s; images + audio
  only) — the UI and API say so plainly (`NO_VIDEO_SEARCH`, 400) instead
  of pretending video search exists. Bug fixed along the way: Openverse's
  audio path is singular (`/v1/audio/`, not `/v1/audios/`) — the first
  version built `${type}s/` and every audio search/save 404'd.
- **Template library 8 → 26:** `src/design-templates.js` — 20 design, 3 video
  (text-clip timelines, no media needed), 3 deck (fit-checked, uniform quiz
  fonts). Every built-in is validated at build time (design / timeline /
  deck-fit + per-layer fit). The Marketplace gained `GET /api/marketplace/builtin`
  (search/category/kind) and `POST /api/marketplace/builtin/:id/install`
  (installs a real editable project of the matching type); decks can now
  be published too.
- **Magic Switch:** `src/magic-switch.js` + `POST /api/magic/switch` —
  convert a design between the 12 size presets (local reflow, `reflowDesign`,
  never-overflow report with `needsAttention`) and translate its text via
  the LLM (14 languages incl. Urdu + Roman Urdu; `{{PLACEHOLDER}}` bindings
  preserved). Always creates a NEW project; the original is untouched.
  No LLM key → 402 `PROVIDER_KEY_NEEDED`, nothing created.
- **AI Assistant:** `src/assistant.js` + `src/routes/assistant.js` +
  `public/assistant.js` — `summarise`, `suggest`, `make-professional`
  (design + deck; deck quiz/chart slides are kept unchanged),
  `five-versions` (design only, exactly 5). All via the LLM abstraction;
  all changes create NEW projects, never edit in place. Costs: 1 credit
  (`ai_write`) for summarise/suggest, 2 (`ai_design`) per created project.
- **Collaboration:** `src/routes/collab.js` + `public/collab.js` — read-only
  share link (per-project token, revocable) + per-user share by email +
  comments with one level of replies (open/resolved, owner-or-author
  resolve/delete) + "Shared with me" list + public read-only view
  (`GET /api/collab/shared/:token`, no login, name/type/content only, no
  owner details). **No live co-editing** — stated in the UI and here;
  shares are view-only by design.
- **LLM active-provider UI fix (real bug found live):** the Settings →
  AI Providers "Active provider per kind" dropdown only rendered for
  kinds `['image', 'tts']` — there was no way to change the active LLM
  provider, so a configured Gemini key sat unused while every LLM job
  failed against OpenAI (no key). Fixed in `public/app.js`: the kinds
  list is now derived from the providers actually present, so every kind
  with 2+ providers (including `llm`) gets a dropdown. Verified end to
  end: switch to Gemini, run a quiz job, the mock Gemini (not OpenAI)
  is called.
- **Gemini default model gemini-2.0-flash → gemini-3.8-flash:** Google
  retired 2.0-flash (404: "no longer available… use gemini-3.8-flash").
  Default + model list changed in `src/providers.js`; a stored override
  naming a retired model is upgraded at resolve time (`RETIRED_MODELS`
  map); a 404 model-not-found names the working alternative in the
  error instead of a raw dump (`friendlyModelError`).
- **Retry + fallback + friendly errors (user hit live: Gemini 503 on a
  quiz job, failed at 5% with a raw JSON dump):** `src/providers.js`
  `fetchWithRetry` retries transient statuses (429/502/503/504) up to 4
  attempts with backoff 2s/5s/10s (env `AI_RETRY_DELAYS_MS` overrides,
  used by tests); `chatJson` in `src/ai.js` tries each candidate model
  with the full retry budget, then falls back to the next known-good
  model (e.g. gemini-3.8-flash → gemini-2.5-flash) before failing, and
  records the model that finally succeeded in the job result
  (`result.model`, `meta.modelsTried`). `friendlyProviderError` turns
  every provider failure into one plain line (what happened + what to
  do); raw detail goes to the server log only. The same retry + friendly
  treatment was applied to every other provider call site (image, video,
  STT, TTS, music, voice cloning — `src/ai.js`, `src/magic-image.js`,
  `src/voice.js`). 500 is deliberately NOT retried.
- **Bug fixed along the way (real, found by the new tests):**
  `upsertProviderConfig` used `COALESCE(excluded.model, provider_config.model)`,
  so clearing the model field (empty string → NULL) was indistinguishable
  from "don't change" — an emptied field silently kept the old, possibly
  retired, model. The function now computes the next values in JS and
  assigns them outright: empty string clears the override, `undefined`
  keeps the current value. This mattered live: the retired-model error
  message tells users to clear the model field.
- **Updater upgrade (node_modules overlay):** update packages may now
  carry a verified `node_modules` overlay, so a release that adds a
  production dependency installs in-app — `fullReinstall` is no longer
  needed for that. Full design in `docs/UPDATER.md`. This release
  (2.2.4) adds no new production dependency, so its package ships with
  `fullReinstall: false` and no overlay.
- **Still pending after v2.2.4:** the CapCut design pass (v2.3.0); CMYK
  conversion for print PDFs; live co-editing (out of scope by design);
  text curvature; TikTok upload; A vs B quiz format; 4K / 3rd video track.

## 1d. v2.3.0 addendum — "CapCut design pass" (2026-11-14)

Design-only release: no new features, no behaviour changes, no dependency
changes. The CapCut desktop arrangement and one consistent design system
over every feature and every option.

- **Sidebar regrouped, CapCut-style** — 35 items in 7 groups (see §1):
  Create · AI Studio · Edit · Bulk & Automation · Library ·
  Publish & Grow · Account. Group dividers in the sidebar; every item in
  its proper group, nothing mixed. All ids, routes, labels and blurbs
  unchanged — only the NAV array order moved.
- **Video Editor — four-pane CapCut layout** (`public/video-editor.js`,
  `public/video-editor.css`): media top-left, preview right, details far
  right, timeline bottom; full-height wrap (`calc(100vh - 130px)`),
  min 560px. Left rail, 8 icon-over-label tabs in CapCut order:
  **Media** (video only now) · **Audio** (audio files only, adds at
  playhead to the audio track) · **Text** · **Stickers** · **Effects**
  (real Magic Animate clip presets from `/api/magic/animate/presets` +
  text fade/slide guidance + link to Animation Studio) ·
  **Transitions** · **Captions** (real list of text-track clips with
  text + start–end times; click seeks the playhead and selects the clip;
  link to Auto Captions) · **Filters** (real per-clip filters from
  `/api/video/effects` with ranges; selects a clip and jumps to the Clip
  tab). **Magnetic timeline** — clip edges + playhead snap, default ON,
  `🧲 Magnet` toggle in the timeline tools (beat snap keeps its own
  toggle; a beat never overrides a closer edge). **Export top-right** —
  `⬆ Export` jumps to the Export tab (same id `ve-goto-export`).
  Playhead is a 3px line with a triangle handle. Clip colours from
  tokens (`--clip-video/--clip-audio/--clip-text`).
- **Graphic Editor — vertical icon rail** (`public/editor.js`,
  `public/editor.css`): 76px rail (60px ≤1100px), icon + label tabs —
  Canvas · **Elements** (renamed from "Add", `data-tab="add"` kept) ·
  Layers · Templates · Media · Brand. Export PNG/JPG already top-right,
  kept.
- **Tokens + light parity** (`public/tokens.css`): 13 new CapCut editor
  tokens with dark AND light values each (`--editor-rail-w`,
  `--editor-rail-bg`, `--editor-rail-active`, `--timeline-bg`,
  `--timeline-track-bg`, `--timeline-ruler`, `--playhead`,
  `--snap-guide`, `--stage-bg`, `--clip-video`, `--clip-audio`,
  `--clip-text`, `--export-btn`, `--export-btn-hover`). The video stage
  stays black in both themes — it is content, not chrome. Token parity
  is asserted in both themes by the v2.3.0 tests.
- **Light-theme leftovers fixed:** `docs-slides.css` — chart placeholder
  hardcoded `#24304f` → tokens; slide-thumb active background → token
  mix; `.alert.ok/.warn` hardcoded hex → token mix; **removed duplicate
  `.modal-back`/`.modal` rules** that loaded after `styles.css` and
  killed the light backdrop override. `bulk.css` — `.qp-caption` muted
  `var(--text-2)` → `#e8ecf8` (it sits on the dark phone frame).
  Deliberately left as content: quiz phone preview colours, white design
  canvas, transparency checker, black video stage, logo-mark gradient.
- **Version:** 2.3.0 everywhere (`package.json`, `server.js` health +
  startup log, `index.html` title, `src/openverse.js` User-Agent ×2,
  `src/routes/system.js` version string, `updates/version.json`).
  Tests: 5 new v2.3.0 tests in `tests/design.test.js` (sidebar grouping,
  video-editor tabs/magnet/Export, graphic-editor rail, token parity,
  light-theme leftovers); suite **222/222 pass**.
- **Honestly NOT redesigned / left out:**
  - **Stickers tab is an honest empty state**, not a feature — no
    sticker/overlay-image feature exists in the app, so the tab says so
    and links to the Graphic Editor instead of pretending to work.
  - No live-browser click-through or screenshot verification in this
    pass — the build environment has no browser. Verification is the
    full test suite (222/222) plus static token/CSS checks and the
    existing 390px responsive rules. The user should confirm the layout
    on their PC.
  - The topbar has no Export button — Export lives top-right inside
    the editors (CapCut-style), as before.
  - No feature, option, route, API contract or dependency changed.

**Global UI:** global search (projects & media) — Implemented; notification
centre — Implemented (real DB notifications); user profile — Implemented;
recent projects / quick actions — Implemented; system status — Implemented
(FFmpeg, storage, DB). Light theme — **Implemented (v2.3.0)** — every token
has a light value (CapCut tokens included, verified by the v2.3.0
token-parity tests); hardcoded dark chrome removed (docs-slides modal
duplication, chart placeholder, alert colours, quiz caption bar).
Desktop-first timeline with a simplified mobile layout — Implemented as designed.

## 1e. v2.3.1 addendum — "Fix round: full-verification audit gaps C-01–C-27" (2026-11-14)

Fixes-only release: no new features, no design changes, no dependency
changes. Every gap found by the full feature-by-feature verification audit
of v2.3.0 (45 areas checked: 40 PASS, 5 FAIL) is fixed in this one round,
with one regression test per gap in `tests/fix-round-231.test.js` (port
4847). The 222/222 suite passing did not catch these gaps — the tests
covered happy paths; the gaps lived in unmapped defaults, unfitted text,
status bookkeeping and edge cases the suite never exercised.

**Blockers**
- **C-01 — unmapped `{{FIELD}}` blanked the value** (`src/bulk-model.js`
  `substituteText`, `public/bulk.js`): with no explicit field mapping
  (the default) a template field rendered blank with no warning. It now
  falls back to the same-name dataset column (normalised, case/space
  insensitive); an explicit mapping still wins; a field with no column
  anywhere is still reported missing, not faked. The mapping UI
  pre-selects the same-name column. `startBulkJob` (`src/bulk.js`) adds a
  pre-flight check: template fields that resolve nowhere refuse up front,
  naming the unresolved `{{FIELD}}`s.
- **C-02 — quiz score-card CTA overflowed both frame edges**
  (`src/quiz-model.js` `buildQuizTimeline`): the CTA was drawn at a fixed
  48px with no fit check. CTA + sub-line now run through `fitText`
  against the safe-box width (max 48/28px, min 20/16px, max 2 lines), the
  whole block is vertically centred in the safe box, and an un-fittable
  CTA is flagged "Score-card text does not fit" with a shorter-text
  suggestion instead of rendering broken.

**Never-overflow cluster**
- **C-05 — 17 of 107 built-in template text layers overflowed**
  (`src/design-templates.js`): all 21 overflowing layers found by the
  builder's `fitText` re-check (height + width) are fixed — boxes grown
  where they can grow, fonts shrunk where they cannot (e.g. promo-post
  "SUMMER SALE" box 280→360px; food-promo headline 130→108px).
  Re-check after the fix: **107 text layers, 0 overflowing**.
- **C-06 — Graphic Editor had no autofit** (`src/design-render.js`,
  `public/editor.js`): the preview clipped, the export drew past the
  box, and the server renderer ignored `lineHeight`. Server text layers
  now fit via `fitText` before drawing (wrap, then shrink to min 12px;
  `line_spacing` honoured; un-fittable layers warned by name). The editor
  autofits on text/font/size changes, inline-edit commit and box resize
  (shrink only), autofits before save/export, and clips every layer to
  its own box in the canvas preview as a backstop.
- **C-07 — quiz `slide-left` moved only the text, not its panel**
  (`src/render.js`): the old fixed 120px/80px text-only shift clipped
  text at the frame edge. One shared clamped slide offset is now applied
  identically to the text and its panel drawbox (clamped so the panel
  never leaves the frame).

**Broken**
- **C-03 — model status stuck on "downloading" forever**
  (`src/segmentation.js` `ensureModel`): `downloadPromise` was only
  cleared on the error path, so after a successful 168 MB download
  `modelStatus()` reported "downloading" forever. It is now cleared on
  success too, so the status flips to `ready`.
- **C-04 — Magic Eraser returned a raw FFmpeg stderr dump for
  alpha-less masks** (`src/magic-image.js` `meanAlpha`,
  `src/routes/magic.js` `handleMagicError`): `format=rgba` is inserted
  before `alphaextract` (an RGB mask now reads alpha 255, so the friendly
  "Nothing to erase" guard fires), and — found while writing the
  regression test — `signalstats` prints nothing by itself on this FFmpeg
  build, so `meanAlpha` always returned `null` and the guard never fired;
  it now reads the stats via `signalstats,metadata=print`
  (`lavfi.signalstats.YAVG=…`, old `YAVG:` shape kept as a fallback).
  Raw FFmpeg stderr is mapped to one short user-readable line.
- **C-08 — Music Sync refused any project that already had an audio
  clip** (`src/music-sync.js` `applyMusicSync`): the music clip now goes
  to the first audio track whose clips do not overlap `[0, duration)`,
  else a new `Audio N` track is created; re-apply stays idempotent.
- **C-09 — A/V sync drift of 0.5s after transitions** (`src/render.js`
  `collectAudio`): audio-track clips now use `shiftAt(clip.start)` as
  the adelay start instead of the raw timeline start, so they shift with
  the transitions exactly like the video clips.
- **C-10 — DOCX export dropped chart blocks to placeholder text**
  (`src/docs-slides.js` `docToDocx`): chart blocks now render via
  `renderChartPng` (960×540) and embed as real images with the chart
  title as caption (new shared `embedImage()` helper); a render failure
  falls back to a one-line note naming the chart.
- **C-11 — AI Studio listed 11 of 12 backend modes (`deck` missing)**
  (`public/ai-studio.js`): the mode list is now derived from
  `GET /api/ai/status` (full 12-mode table as fallback), with deck fields
  (topic, slide count, style, audience), result rendering and an "Open in
  Presentations" action. The backend `generateDeck` was already complete.

**Rough edges**
- **C-12 — server renderer drops editor features silently**
  (`public/editor.js`): a warning bar under the toolbar lists, live, the
  features the server render drops (ellipse/triangle shapes, rounded
  corners drawn square, shadows, gradient text as solid colour, text
  stroke/underline) — preview and PNG/JPG export keep them.
- **C-13 — AI Design Assist headline never fit** (`src/ai.js`
  `buildDesignFromSuggestions`): headline, subheading, CTA and badge all
  run through `fitText` now; un-fittable layers are recorded in
  `needsAttention`.
- **C-14 — uploaded images never got width/height stored**
  (`src/routes/media.js`): the upload probe branch now includes images
  (ffprobe already returns image dimensions).
- **C-15 — Shorts manual transcript never saved** (`src/routes/shorts.js`):
  the route passed camelCase `transcriptSource` to a DB allow-list that
  only accepts `transcript_source`; it now passes the snake_case name.
- **C-16 — no solid-colour background fallback for quiz/bulk**
  (`src/bulk.js`): a quiz row with no background assigned rendered on
  the solid spec navy `#14213D` with a warning instead of throwing "This
  row has no background assigned". Found while writing the regression
  test: `startBulkJob` and the sample route call
  `assignBackgroundsForJob` first, which threw "No backgrounds selected"
  on an empty pool — so a quiz batch could never reach the fallback. A
  quiz job in random/pool/manual mode with no pool now skips assignment
  entirely (rows stay unassigned → navy fallback). Non-quiz video batches
  still refuse without a pool: a template video needs a background.
- **C-17 — Export Center stale copy** (`public/app.js`): "Batch image
  export and ZIP download arrive with Bulk Design in Phase 4" now says
  batch image export is live in Bulk Design with ZIP download from the
  job.
- **C-18 — republishing minted a second live site** (`src/db.js`,
  `src/routes/docs-slides.js`): publish now reuses the project's existing
  site (same slug/URL, rebuilt in place, `republished: true`); first
  publish still creates it (201).
- **C-19 — published deck/design pages had no viewport scaling**
  (`src/docs-slides.js` `buildWebsite`): a `__fitPages` scaler scales
  each `.page` to the viewport width (runs on load + resize); design
  pages are wrapped in `.page-wrap` so the scaled height is reserved.
- **C-20 — malformed JSON returned 500** (`server.js`): a body-parser
  `entity.parse.failed` now returns 400 "Request body is not valid JSON".
- **C-21 — notification bell dot never evaluated on load**
  (`src/routes/system.js`, `public/app.js`): `GET /api/notifications`
  now returns `unreadCount` (audit rows newer than the per-user
  `notif_seen_at` marker); `POST /api/notifications/seen` sets it; the
  client evaluates the dot on shell render and marks seen on open.
- **C-22 — analytics platform totals visible to any USER**
  (`src/db.js` `userStats`, `src/routes/analytics.js`): OWNER/ADMIN keep
  platform-wide totals; a plain USER now sees only their own rows
  (projects, renders, AI jobs, storage scoped to their folders).
- **C-23 — deleting a user orphaned their files** (`src/routes/admin.js`):
  delete now removes `uploads/<userId>`, `renders/<userId>` and each
  published site dir (websites are listed before the row delete, which
  cascades), and reports `filesRemoved`/`filesFailed`.
- **C-24 — provider Test returned HTTP 200 on failure**
  (`src/routes/system.js`): a failed test now returns **402** with the
  same body.
- **C-25 — dashboard "FFmpeg render engine live" was static text**
  (`public/app.js`): the Render-jobs foot now reads the live
  `d.system.ffmpeg` probe (`FFmpeg <version> live`, or "FFmpeg
  unavailable — renders will fail").
- **C-26 — version list had no content fingerprint** (`src/db.js`):
  `listProjectVersions` now returns `sha256` (SHA-256 of the stored JSON)
  + `bytes` per version; identical contents share a fingerprint.
- **C-27 — a `manual` social post could be deleted** (`src/routes/social.js`,
  `public/social.js`): delete now refuses `manual` records (400) as well
  as `published` ones — a manual record is the only proof that post went
  out; the Delete button is hidden for both.

**Not built, by design (kept honestly labelled):** C-28 TikTok upload
(`NOT_IMPLEMENTED`), C-29 CMYK print (PDFs DeviceRGB only), C-30 Stock
video search (Openverse has none; honest `NO_VIDEO_SEARCH` 400).

## 1f. v2.4.0 addendum — "CapCut Home & Flow" (2026-11-14)

v2.3.0 only restyled the sidebar and editors. The user corrected that on
2026-11-14: "CapCut jaisa" meant the CapCut **app flow** — launch → home
screen → click New Project → editor, all-in-one inside. v2.4.0 builds
that flow; nothing else changes. No new production dependency,
`fullReinstall: false`.

**Home screen — the landing after login** (`public/app.js` `viewHome`,
`public/home.css`, new): the app shell's existing top bar (logo, search,
credits, avatar) stays; below it a CapCut-desktop home — hero greeting
with the big "＋ New Project" button, Recent Projects (REAL projects from
`/api/dashboard`, newest first, type + updated date; clicking one opens
it straight in its editor — design → graphic editor, video → four-pane
timeline, deck → deck editor, doc → document editor, anything else →
project detail), a Templates row (real templates from
`GET /api/marketplace/builtin` — all 26, design/video/deck; "Use" installs
via `POST /api/marketplace/builtin/:id/install` and opens the created
project in its editor), and quick-access cards for all 7 sidebar groups
so all 35 features are one click away (the cards render the same `NAV`
list the sidebar uses, so they cannot drift). The Dashboard stays
reachable from the sidebar; the update-available / pending-restart
banners from the dashboard are shown on Home too. Empty states are
honest ("No projects yet", "No templates available") — no fake data.
Never-overflow: project and template names ellipsize with a full-name
`title` tooltip. Dark default + working light theme (token-based CSS
only, same tokens as the v2.3.0 design pass).

**New Project flow** (`public/app.js` `openNewProjectFlow`,
`createNewProject`): a chooser with 9 tiles — Video, Design,
Presentation, Quiz video, Bulk Video, Bulk Design, Document, Shorts,
Social post. Picking one shows its form (name + aspect/fps for video,
size from live `/api/design/sizes` for design, name only for the rest),
then "Create & open" creates the real project/job in the DB and lands
the user inside the matching editor — no dead ends, no placeholder.
Video uses the existing `window.VideoEditor.blankTimeline` + `POST
/api/projects` → `video-timeline`; Design uses the existing blank-canvas
content → `design-editor`; Deck posts the title-slide seed (same seed
the Presentations "New Deck" button uses) → `presentations` with a
`deckId` deep link (`public/docs-slides.js` auto-opens the deck editor
when `state.params.deckId` is set, then clears it); Document posts the
heading + paragraph seed → `documents` with a `docId` deep link;
Quiz posts `POST /api/bulk` with `templateProjectId: 'quiz'` (the Quiz
Video preset — `settings.quiz.enabled`) → `bulk-video` job detail;
Bulk Video / Bulk Design first create a blank template project (video
16:9 30fps / design 1080×1080, named "<batch> — template", editable
later in its editor) and then the batch → job detail at step 1; Shorts
and Social post create the project and land on its detail page (same as
the old modal did). The three existing "New project" buttons (dashboard
quick action, dashboard empty-state, Projects toolbar) now open this
flow; the old `openProjectModal` is kept but no longer wired to any
button. Errors surface in the modal (and as toasts) — never a silent
no-op.

**Tests:** `tests/home-flow-240.test.js` (port 4848), one test per new
behaviour — dashboard recent-projects data + newest-first order,
26 builtin templates across all kinds, served home files (`/home.css`,
`viewHome` / `openNewProjectFlow` / `createNewProject` in `app.js`,
deck/doc deep links in `docs-slides.js`), per-type project creation
(video timeline, design canvas, deck seed, doc seed), quiz-preset bulk
job, bulk video/design batch creation from a fresh template project,
template install creating a real project of the right type for all
three kinds, and the 7 sidebar groups + dashboard still routed.


**Gap fixes (preview review, same release):** a review of the home-screen
preview found gaps that were fixed in the real build in the same round,
not deferred.

- **Effects vs Transitions, split for real** — the single "Effects &
  Transitions" sidebar item is now two items (`effects` / `transitions`,
  both under Edit; 36 features + Home = 37 sidebar entries). `viewEffects`
  is motion only (keyframes, filters); `viewTransitions` is transitions
  only (Fade, Dissolve, Slide, Wipe, FFmpeg xfade). The editor's Effects
  tab copy says plainly it is *not* transitions, and its preset rows are
  clickable — selecting a clip and clicking a preset calls `POST
  /api/magic/animate` and lands real keyframes on the clip.
- **Stickers are real** — the editor's Stickers tab was an honest empty
  state; it now lists image media (`/api/media?kind=image`), uploads a
  sticker image, and places it on the overlay (PiP) video track as a
  3s image clip (`sticker: true`, bottom-right, keyframe-movable). The
  render-job route now accepts image media on a video track (the
  renderer draws it as a looped still) and the preview shows the sticker
  overlay at the same 30% width and keyframe position the FFmpeg render
  uses. Still a hard limit: max 2 video tracks (main + one overlay).
- **MOV export** — the Export dialog now offers Format MP4 / MOV; the
  render job stores `settings.format`, the renderer writes
  `<jobId>.mov`, download serves `video/quicktime`, save-to-library
  records the right extension/mime. Unknown formats are refused 400.
  MOV is H.264+AAC in a QuickTime container — no WebM, no 4K, no 3rd
  track.
- **Import-first New Project (video)** — the chooser's video step now
  offers library videos + an upload button + a drag-drop zone, and the
  selected media land on the timeline as clips back-to-back from 0:00
  before the editor opens. Aspect/fps are offered for the video and
  bulk-video templates; the quiz preset keeps its fixed 9:16 timing and
  offers no fake choice.
- **Ratio selector in the editor header** — a working aspect selector
  (16:9 / 9:16 / 1:1 / 4:5) with a live dimensions badge; changing it
  updates the timeline width/height, the stage aspect ratio and saves.
- **Drag-drop import in the editor** — dropping video files on the
  Media tab (audio files on the Audio tab) uploads them through
  `/api/media/upload` and refreshes the panel; wrong-kind drops are
  refused with a toast.
- **Home: search, quick nav, durations, View all** — a working home
  search (filters recent projects + templates), a quick-nav row (Home ·
  Templates · Spaces · AI Studio · Collaboration), video durations
  (`⏱ m:ss`, from `GET /api/dashboard` `durationSeconds`) on recent
  cards, a Collaboration card with a live shared-with-me count, and
  "View all" links to the full Projects / Templates lists. The
  Marketplace built-ins are now browsable by category chips (client-side
  filter of the fetched list; all 26 stay reachable).
- **Collaboration view** — `viewCollaboration` (route `collaboration`,
  home-only, not a sidebar item): shared-with-me list with Open/Leave
  plus a how-to-share explainer.
- **Mobile bottom sheet** — at ≤860px `.modal-back` anchors to the
  bottom and `.modal` becomes a bottom sheet (rounded top corners,
  88vh, scrollable). Panels stack on mobile; nothing disappears.
- **Never fake success** — a regression test asserts no "Export Ready"
  string exists in the served frontend files; the bulk "sample row" is a
  real render labelled "sample".
- **Ordering fix** — `listProjects` now orders by `updated_at DESC,
  id DESC` so same-second ties no longer scramble newest-first.
- **Starter clip** — a blank bulk-video template now carries a
  `{{TITLE}}` text clip, because a clip-less timeline is refused at
  batch creation; the batch flow no longer 400s on a fresh template.
- **Render watchdog (found by the tests, real bug)** — a corrupt or
  undecodable image on a video track made FFmpeg loop forever (`-loop 1`
  retries a broken image indefinitely) and, with the single-slot render
  queue, bricked every later render: jobs stayed queued forever. The
  worker now kills FFmpeg after a generous duration-based limit (30x the
  video length, 10-minute floor; `RENDER_WATCHDOG_MS` overrides it) and
  the job fails honestly ("Render timed out … source media may be
  corrupt") instead of hanging the queue. The suite's own sticker test
  used to hit this with a hand-embedded corrupt 1x1 PNG — test images
  are now generated by FFmpeg, and a dedicated test proves a corrupt
  render fails and the very next good render still completes.
- **Mobile is a first-class target (user clarification 2026-11-14)** —
  the app is for phone AND desktop. Verified and fixed: viewport meta
  already correct; no panel is `display: none` at any width (sidebar is
  an off-canvas drawer via transform, hamburger toggles it, tapping a nav
  item closes it; dialogs are bottom sheets at ≤860px); home grids
  collapse to one column at 390px; timeline ruler re-aligned to the 64px
  mobile track heads (was 0, ticks sat 64px left of their clips);
  touch targets are ≥44px on mobile (buttons, nav items, icon buttons,
  editor/graphic tabs, home quick-nav pills and group links, ratio
  select, Export button; clip trim handles widened to 14px); clip and
  canvas dragging already use pointer events, so touch drag works. The
  single deliberate exception: the topbar credits pill hides on mobile —
  it is a redundant chip, and the same balance/plan shows in the profile
  menu one tap away. Deck canvas and graphic-editor stage scale to the
  container (aspect-ratio / overflow-auto), so they fit a phone too.
  A mobile test pins all of it (viewport, drawer, bottom sheet, 44px
  rules, ruler alignment, pointer-event drag, one-column grids).
- **Rotation fix (found live by the complete CapCut analysis, §3.2)** —
  rotation 90°/270° on a clip broke every render: alone the output came
  out transposed (720×1280) and the render validator failed it ("Width
  is 720, expected 1280"); with a fade transition xfade failed outright
  (FFmpeg exit 234) because the rotated segment did not match the other
  input's size; keyframed rotation failed the same way. 180° always
  worked. The fix scales+pads the rotated frame back to the project
  size (W×H) right after the transpose (`src/render.js` `clipFilters`,
  which runs in both the plain and the keyframed chains), so a rotated
  clip renders at the project size alone, with transitions, and with
  keyframes. The overlay (PiP) track had the same defect in reverse —
  the editor preview rotates overlay clips but the render chain never
  applied it, so a rotated sticker exported unrotated; the overlay chain
  now transposes + scales back, with the PiP height estimate aspect-swapped
  for 90°/270°. The same analysis found `POST /api/video/validate`
  silently accepted keyframes carrying `rotation`/`volume` — properties
  the renderer never honours (`keyframeAt` reads x/y/scale/opacity only)
  — so `validateTimeline` now rejects unknown keyframe properties with a
  clear error ("not supported … set rotation/volume on the clip itself").
  The editor never offers rotation/volume keyframes (its keyframe tab
  lists x/y/scale/opacity only), so the rejection cannot break the UI.

**Tests (gap round):** 13 new tests in `tests/home-flow-240.test.js`
(26 total in the file) — dashboard durations, the Effects/Transitions
split, Collaboration view + API, template categories, sticker acceptance
on a video track, MOV end-to-end (render → download → ffprobe container
check, plus 400 on an unknown format), animate-API preset apply, the
no-"Export Ready" static check, the bottom-sheet CSS static check, home
search/quick-nav/durations, editor ratio/drag-drop/format code, the
render watchdog (corrupt image fails honestly, queue recovers), and the
mobile-width check (viewport, drawer, bottom sheet, 44px touch targets,
ruler alignment, pointer-event drag, one-column grids).
Plus 9 tests in `tests/rotation-fix-240.test.js` (port 4849) — validate
rejects rotation/volume keyframes and still accepts normal ones, and
real renders (ffprobe-validated) for 90° alone, 270° alone, 90° + fade
transition, 180° alone (still works), 90° + keyframes, and a rotated
overlay clip — all at the 1280×720 project size.
The quiz aspect/fps is deliberately NOT offered (fixed preset) and the
"Invalid Date" update-history display bug is still pending for a later
round.

## 1g. v2.5.0 addendum — "CapCut parity round" (2026-11-14)

The complete CapCut analysis (`capcut-complete-analysis-v240.md`, 486
inventory rows → 306 unique capabilities: 29 MATCH / 115 DIFFER / 162
MISSING) produced a consolidated 72-item build list (§6). v2.5.0 builds
all 72 in one round, in §6 order (P0 → P1 → P2). P3 items are defers by
design and are NOT built (live co-editing, custom domain, cloud
Spaces/sync, motion tracking, AI stickers, video object removal, eye
contact/lip sync, in-app camera). CapCut's tartib (arrangement) is the
master layout; Canva-only features are merged into it; nothing is mixed
(Effects under Effects, Transitions under Transitions). No new
production dependency, `fullReinstall: false` (update package: 140 app
files, no dependency overlay; SHA verified in both copies against
`updates/version.json` at publish time).

**P0 — CapCut behaviour core (all done).** #1 Stickers: 20-SVG bundled
library + stock images + AI sticker tab, placed on overlay tracks,
draggable in the preview. #2 Video effects library: 16 real FFmpeg
effects (glitch, retro, blur, vhs, grain, lightleak, vintage, noir,
neon, dream, sharpen, pixelate, invert, warm, cool, edge), clip-level
intensity + adjustment-layer effect tracks. #3 Chroma key via
`chromakey` (pixel-verified: green removed, subject kept). #4 Speed
curves: 8 presets (montage, hero, bullet, jumpcut, flashin, flashout,
custom) + 0.1–100× range, exact trapezoid integration. #5 Keyframes:
rotation 0–360 + volume 0–2 + per-key easing; `geq` removed — keyframed
renders 2.8× faster (3.5 s clip: 8.1 s wall vs 22.6 s baseline).
#6 Transitions: 28 real xfade types, up to 5 s, Apply-to-all.
#7 Filter presets (10 slider bundles) + `.CUBE`/`.3DL` LUT import via
`lut3d`. #8 Stabilisation: vidstab two-pass, cached per media+strength.
#9 Masking: 7 types (pixel-verified circle). #10 N video tracks: the
2-track cap is gone (3rd track verified rendering). #31 Rotation
regression: 90°/270° still render at project size alone, with
transitions, and with keyframes — verified again this release; the two
`rotation-fix-240` tests that asserted "validate rejects
rotation/volume keyframes" were flipped to the new contract (they now
assert acceptance, plus out-of-range rejection). #32 Core shortcuts
(Ctrl+B/D, Q/W, M, Ctrl+E/T, frame step, J/K/L shuttle) and #33
copy/cut/paste + multi-select (Ctrl-click, Shift-range, Ctrl+A) — all
wired in the editor with a rebindable map (see #50).

**P1 — important, visible in normal editing (all done).** #11 Stock
music/SFX inside the editor (Openverse audio search + save + add).
#12 In-app voiceover recording (MediaRecorder → upload → audio clip at
playhead). #13 Export: 2K/4K, 25/50 fps, WebM (VP9), HEVC, bitrate /
quality / CRF, HDR flag, cover-frame endpoint. #14 Font fidelity:
Poppins/Montserrat/Inter/Roboto/Open Sans/Lato/Bebas Neue/Oswald/
Playfair Display download as real TTFs on first use into `data/fonts`
(cached like the U-2-Net model); offline falls back to DejaVu honestly.
#15 Text templates (6) + saved styles + curved text (Graphic Editor
curve-angle slider, live arc preview, server arc render). #16 Reverse /
freeze (pixel-verified). #17 Voice processing: denoise, enhance voice,
vocal isolation, loudnorm (verified ≈ −16 LUFS), auto-ducking.
#18 Auto reframe (Shorts centroid pre-pass). #19 Deck transitions +
slide entrance animations (MP4 uses real xfade; per-frame element
animation exists in preview/present only, not in MP4 — honest).
#20 TikTok chunk upload finished (published with a real video id
against a mock API; text-only / failed-chunk fail honestly). #34 Extract
audio (`POST /:projectId/extract-audio` → 201 `{media, clip}`).
#35 Compound clips / nesting (nested timeline rendered to temp file).
#36 Right-click context menus (clip / track / empty lane). #37 Audio
waveforms on the timeline (Ctrl+Shift+H; `GET /api/media/:id/waveform`
canonical + `/api/video/media/:id/waveform` alias, 100–200 peaks,
404 when no audio). #38 Emoji: colour emoji now render — drawtext and
libass provably cannot do colour emoji from Noto Color Emoji on this
box, so emoji text is pre-rendered to a transparent PNG with Python +
Pillow (`FT_LOAD_COLOR`); pixel-verified (6,495 saturated pixels for 🎉
vs 0 control); if Python/Pillow is missing it falls back to the ASS
path with a warning in the job log. #39 TTS → timeline clip handoff
("Add voice to timeline at playhead"). #40 Project background UI
(colour / image / blur-fill) + PiP free positioning (draggable overlay
in the preview). #41 Caption workflow: SRT import/export, batch edit,
caption split (B), caption styles (5 presets). #42 Adjustment layer
(effect tracks, noir verified grayscale). #43 Optical flow / smooth
slow-mo (`minterpolate` below 0.5×). #44 AutoCut (real editable
project). #45 Transcript-based editing + silence removal
(silencedetect). #46 Preview controls (quality dropdown, safe-zones
overlay, fullscreen, loop). #47 Render performance: keyframed 2.8×
faster (see #5); plain 60 s renders at ~parity (19.4 s vs 17.4 s
baseline, reported as noise, not a regression). #48 Volume 0–200% with
dB readout + Ctrl+./Ctrl+, nudge. #49 Caption styles (5 presets).
#50 Full shortcut map: all 27 CapCut bindings + in-app Shortcuts panel
(click to rebind, persisted to `cs-shortcuts`, reset to defaults).

**P2 — Canva gaps + depth (all done except the honest limits below).**
#21 Sheets: new `sheet` project type — real grid, formula evaluator
(=SUM/=AVERAGE/=COUNT/=MIN/=MAX/=IF, refs/ranges, real `#DIV/0!` /
`#REF!` / `#CIRC!` errors), formatting, CSV/XLSX import/export,
`GET /api/sheets/:id/rows` as a bulk-job data source. Wired into the
app shell (sidebar "Sheets", `go('sheets')`, `initSheets`, sheet
projects open the studio). **Bug found during the build:** the
`projects.type` CHECK rejected `'sheet'` — fixed in `src/db.js` (CHECK
+ v2.2.3 rebuild migration, old-format DB verified). #22 CMYK print
(`DeviceCMYK` alongside RGB). #23 DOCX internals (real `numbering.xml`,
`styles.xml` Heading1/2/3 + IntenseQuote, headers/footers, `sectPr`).
#24 Stock video via Pexels (free key in Settings, encrypted; without a
key the honest `NO_VIDEO_SEARCH` 400). #25 Content Planner depth
(campaigns, approval draft→pending→approved, drag-drop reschedule,
series, bulk ≤50, best-time suggestions). #26 Collaboration: edit
shares, @mentions → bell, layer-pinned comments, per-project activity
feed; OWNER untouchable. #27 Print sizes (A5/A4/A3/A6/flyer/
business-card/custom) + print-ready checklist endpoint. #28 Template
library depth (résumé, logo, certificate, menu, invitation,
presentation-set; 32 templates total). #29 Magic Grab: true per-object
segmentation (connected component; background click fails honestly).
#30 Website extras (SEO/meta, local analytics, password protection;
custom domain stays OUT). #51 Export breadth (25/50 fps, filename,
estimated size, audio settings, export queue, audio-only MP3/WAV,
frame PNG, GIF). #52 HDR (HEVC 10-bit, `yuv420p10le` ffprobe-verified).
#53 Export presets per platform (TikTok/Reels/Shorts, YouTube, …).
#54 Project settings dialog (Ctrl+P: name/aspect/resolution/fps,
copy-vs-link, auto-save, proxy — proxy is stored and honestly labelled;
the preview still renders full quality). #55 Settings pages
(Performance, Draft/Cache, project defaults, language, privacy/data).
#56 Templates: trending feed + guided placeholder swap + category rows
(For you / Trending / Commercial / Social). #57 Media depth
(favourites, folders + filter, smart collections; **face
detection/grouping is honestly NOT available** — no local face model
exists in `data/models`; the Settings API reports `available:false`).
#58 Timeline depth (split screen, slip edit Alt+drag, J/L link/unlink,
sync linked). #59 Velocity effects (6 presets over speed curves).
#60 Video AI depth (local FFmpeg denoise/deflicker/enhance/upscale;
expand/remix/relight key-gated). #61 Video translator / AI dubbing
(key-gated). #62 EditPilot (key-gated). #63 Third-party video models
(Kling 3.0, Veo 3.0/3.1, PixVerse, Sora alongside Runway, key-gated).
#64 AI Design Studio / Infinite Canvas (key-gated). #65 Director Mode +
AI avatars (key-gated). #66 Seedance: **PARTIAL — Edit is done
(key-gated); Extend is NOT built locally** (a local-only install has no
publicly reachable source URL, so Seedance cannot fetch the source —
the job fails with that exact honest reason, never faked). #67 Auto
Lyrics + AI Lab + batch edit. #68 Retouch/beauty (frame-level smooth;
heavy ML kinds refuse `NOT_AVAILABLE`). #69 Bilingual captions +
speaker ID (LLM-inferred labels, honestly labelled NOT acoustic
diarization) + curved text (see #15). #70 PWA: real `manifest.json` +
service worker (offline app-shell cache, install prompt), wired into
`public/index.html`. #71 Home depth: project sort (date/name/type) +
rename from Projects view and editor. #72 Text depth in the video
editor (font picker, letter spacing, line height, shadow, stroke,
gradient — gradient text is refused with a clear 400 at job creation,
never silently rendered solid).

**Also fixed this release:** the "Invalid Date" update-history display
bug — `fmtDate` appended `'Z'` to ISO timestamps that already end in
`'Z'` (`'…Z' + 'Z'` = Invalid Date); it now uses ISO input as-is and
only converts space-separated DB timestamps. The canonical waveform
endpoint `GET /api/media/:id/waveform` was added (alias of the
render-side handler). The LUT-upload server crash (`kind:'lut'`
violated the media CHECK), the compound-render `uid is not defined`
crash, and the split-screen validation comparing track kinds instead
of ids were all found and fixed during testing.

**Tests (new, one file per slice, ports 4850–4853):**
`tests/parity-render-250.test.js` 39/39, `tests/parity-ai-250.test.js`
24/24, `tests/parity-editor-250.test.js` 9/9, `tests/parity-planner-250.test.js`
20/20 — 92 new tests, all green in their own runs; the full-suite count
is in the header above (single clean `npm test` run).

## 1h. v2.6.0 addendum — "Desktop app" (2026-11-14)

v2.6.0 turns CreativeStudio into a proper desktop app: an Electron shell
around the same server, so the app gets its own window and icon instead of
a localhost browser tab. The shell is deliberately THIN — the real app is
still `server.js`, run as a CHILD PROCESS (bundled `runtime/node.exe` on
Windows, plain `node` in dev) and never `require()`'d into Electron,
because better-sqlite3 is compiled for Node's ABI and Electron's Node ABI
differs. Health is now `version: '2.6.0', phase: 11`; the dashboard system
string is `'2.6.0 (Desktop App)'`.

**What was added.** `electron/main.js` — single-instance lock (a second
launch focuses the existing window instead of opening another), loading
window while the server starts, crash/restart dialog when the server child
dies, and quit kills the child (SIGTERM, SIGKILL after 5 s — no orphan
node.exe). `electron/app-config.js` — pure logic with no `require('electron')`,
so it is unit-testable in plain Node: port resolution (4820, then 4821…4840,
then a loud error), health polling, window-state save/load with clamping to
a visible area, the server launch spec, and the menu template.
`electron/preload.js` — contextBridge only, intentionally exposing nothing
(the SPA needs only fetch/XHR). `electron/loading.html` and a real
`electron/icon.ico` (9,307 B; 16/32/48/256 px, verified by parsing the ICO
header in the tests). Menu: File / View / Window / Help, every leaf item
with a real `click` handler — File > New Project drives the SPA's real New
Project flow (clicks the in-page button), Help > About shows the version,
Help > Open Data Folder opens the app's data folder. `scripts/package-electron.js`
(`npm run package:win`, `npm run desktop` for dev) stages the portable tree
and runs electron-packager (electron 45.3.1 + electron-packager 17.1.2,
pinned devDependencies); the Windows CI workflow now does a full `npm ci`
(packager is a devDependency, pruned back out of the output), stages
`electron/`, runs the packager step, and uploads the
`CreativeStudio AI Pro-win32-x64/` artifact. The NSIS installer
(`installer-260.nsi`, in the delivery folder) installs
`CreativeStudio AI Pro.exe` with Start Menu + Desktop shortcuts and
migrates a v2.5.0 install's `data/`, `uploads/`, `renders/` and `.env` from
the old install-root layout into `resources\app\`, so no user data is lost
on upgrade; uninstall removes the app files but keeps the user's data.
`fullReinstall: true` for this release — Electron is a new runtime the
in-app updater cannot install, so v2.6.0 is a one-time Setup.exe install;
once installed, later updates arrive in-app again.

**Tests (new, port 4854):** `tests/electron-260.test.js` — 19/19 green in
its own run (`node --test tests/electron-260.test.js`). Port resolution
(free → preferred, busy → next free, all 21 busy → throws), health polling
(resolves against a scratch `{ok:true}` server; rejects inside a 500 ms
timeout against a dead port), window state (missing/corrupt file →
1280×800 defaults, off-screen/oversized clamps, save/load round-trip),
server command (dev shape `node server.js`; packaged shape
`runtime/node.exe` with the app `bin/` first on PATH; packaged without a
bundled node falls back to plain `node`), menu (exactly File/View/Window/
Help; every leaf has a `click` or a `role`), the ICO header (16/32/48/256),
and static guards on `main.js` (single-instance lock, contextIsolation,
preload wired, no `require('./server')`). Existing version assertions were
bumped 2.5.0 → 2.6.0 / phase 10 → 11 (`api`, `design`, `acceptance`,
`home-flow-240`, `music`, `shorts`, `social`, `update` tests); the
`update.test.js` publish-package test still asserts its old 2.1.0 package
untouched, and all v2.5.0 history comments were left as history.

**Honest limits.** The win32 exe icon + version stamp are applied by the
Windows CI build only: electron-packager always runs rcedit for win32, and
Linux packaging fails with "wine64 not found" — wine is NOT installed on
this VM by design, so a Linux-made win32 build would ship without the
custom icon and stamp. Real-Windows behaviour — window restore,
single-instance focus, and the NSIS data migration — is still to be
confirmed on the user's PC; Linux verification of the running shell was
done under Xvfb, and the unit tests above never launch Electron at all
(they import only the pure-logic `app-config.js`).

## 1i. v2.6.1 addendum — "Multi-Owner" (2026-11-14)

v2.6.1 ends the single-OWNER installation: three Gmail accounts are OWNER
on any installation, not just the first account created. Signup grants
OWNER + Lifetime to any of them even when it is not the first account, and
login promotes an existing account with one of these emails back to OWNER
(the pre-v2.6.1 case, or an OWNER demoted by another OWNER). Health is now
`version: '2.6.1', phase: 12`; the dashboard system string is
`'2.6.1 (Desktop App)'` and the index title is `v2.6.1 Desktop App`.

**What was added.** `src/ownerEmails.js` — the allowlist
(`kingaamir022@gmail.com`, `josnking01@gmail.com`, `a030210523@gmail.com`)
with `isOwnerEmail()` (case-insensitive, trims spaces); the `OWNER_EMAILS`
env var (comma-separated) replaces the list when set.
`src/routes/auth.js` — signup makes an allowlisted email OWNER + Lifetime
(first-account rule unchanged for everyone else); login promotes an
allowlisted non-OWNER account to OWNER + Lifetime and audits it
(`owner_promoted`). `src/db.js` — `countOwners()` backs the guards.
`src/routes/admin.js` + `src/routes/system.js` — last-OWNER guards
(defense-in-depth): demoting or deleting the final OWNER is refused
(`'Cannot demote the last OWNER.'` / `'Cannot delete the last OWNER.'`,
403); the existing self-demote / self-delete refusals stay 400 with their
existing messages, and they are checked before the last-OWNER guard.
Granting OWNER stays OWNER-only: an ADMIN gets 403 on both role endpoints
(`PATCH /api/admin/users/:id/role` and `PATCH /api/users/:id`), and no
ADMIN may demote, suspend or delete any OWNER account. `public/app.js` —
the login/network error is friendly now: one shared helper
(`toFriendlyNetworkError`) maps a `fetch()` throw (server unreachable,
e.g. Start.bat not running) to `SERVER_UNREACHABLE_MSG`
('Server se connect nahi ho raha — Start.bat chal raha hai? Page refresh
karke dobara koshish karein.') in both `api()` and `apiForm()`; the login
handler already displays `err.message` and needed no change, and
server-returned messages (wrong password etc.) are shown exactly as the
server sends them. The bare browser message never appears in `app.js`.

**Tests (new, port 4855):** `tests/multi-owner-261.test.js` — 14/14 green
in its own run (`node --test tests/multi-owner-261.test.js`). First signup
→ OWNER + Lifetime, second non-listed signup → USER + Free; both
allowlisted non-first signups → OWNER + Lifetime; `isOwnerEmail()` unit
checks (case, spaces, rejects, non-strings); login promotion end-to-end
(OWNER demotes the allowlisted OWNER to USER, that user logs in and is
OWNER again — the observable form of the promotion, since signup already
auto-promotes); OWNER promotes USER → OWNER on both role endpoints and
ADMIN → OWNER; ADMIN gets 403 granting OWNER (both endpoints) and 403
demoting / suspending / deleting an OWNER; last-OWNER sequence (demote
3 → 1 OWNER, sole OWNER self-demote 400, self-delete 400, ADMIN delete of
the sole OWNER 403, exactly one OWNER left); wrong-password login is 401
with the exact server message; health 2.6.1 / phase 12; static guards on
the guard strings and on the friendly client message. Existing version
assertions were bumped 2.6.0 → 2.6.1 / phase 11 → 12 (`api`,
`acceptance`, `design`, `home-flow-240`, `music`, `shorts`, `social`,
`electron-260`, and `update` — whose test app copy mirrors the real
`package.json`, so its twelve 2.6.0 values move too); `package.json`
`test` now also runs `tests/multi-owner-261.test.js`. The v2.6.0 suite was
395/395; with these 14 new tests the suite is 409 — the coordinator's
final full run confirms the total.

**Honest limits.** The allowlist lives in code, not in a setting: changing
the three OWNER Gmails needs a code change and a release (the env override
is the escape hatch for a custom install). Login promotion only fires on
login, so a demoted allowlisted account stays USER until it signs in
again. The friendly message only covers the unreachable-server case — a
server that answers with an error still shows the server's own text.

## 2. Key modules (from the master prompt)

| Module | Status |
|--------|--------|
| Graphic Design Studio | Implemented (text curvature built in v2.5.0; Magic Resize + Magic Animate presets live in v2.2.2) |
| Video Editor | Implemented (chroma key, stabilisation, speed curves, 4K, N tracks, keyframe easing all built in v2.5.0; proxy editing Pending) |
| Magic Tools (v2.2.2) | Implemented: Magic Resize (local reflow), Magic Animate presets (10), Magic Eraser (needs image key), Magic Expand (AI needs key; solid/blur local), Background Remover + Magic Grab (free local ONNX, no key), Magic Write (LLM, needs key; free Gemini works) |
| Magic Switch (v2.2.4) | Implemented: reflow between the 12 size presets + LLM translate (14 languages incl. Urdu + Roman Urdu); always creates a new project; no key → 402 `PROVIDER_KEY_NEEDED` |
| Stock Assets (v2.2.4, video v2.5.0) | Implemented: Openverse images + audio (key-free), save to Media Library with attribution; stock video via Pexels (free key, else honest `NO_VIDEO_SEARCH`) |
| AI Assistant (v2.2.4) | Implemented: summarise, suggest, make-professional (design + deck), five-versions (design); new projects only, never edits in place; needs an LLM key |
| Collaboration (v2.2.4, depth v2.5.0) | Implemented: read-only share link + per-user share + comments (replies, resolve). v2.5.0: shares can grant `edit`, @mentions notify, comments pin to a layer/slide, per-project activity feed; OWNER untouchable. No live co-editing (out of scope by design). v2.4.0: a real Collaboration view reachable from Home quick-nav (shared-with-me list + how-to-share). |
| Updater overlay (v2.2.4) | Implemented: verified `node_modules` overlay in update packages (SHA-256 per file, backup + rollback cover it, native modules refused) — new production dependencies no longer need fullReinstall. Design: `docs/UPDATER.md` |
| Docs & Slides (v2.2.3, CMYK + deck transitions v2.5.0) | Implemented (AI deck generation needs an LLM key; CMYK print built in v2.5.0; deck transitions + slide entrance animations built in v2.5.0) |
| Bulk Video Studio + Dynamic Background Engine | Implemented (AI/prompt backgrounds need an image key; A vs B quiz Pending) |
| AI Music Sync Director | Implemented (AI generation/mood need keys; multi-track mixing Pending) |
| Long Video to Shorts | Implemented (face tracking Pending; 60-min end-to-end render not run) |
| AI Captions (Urdu/Roman Urdu/Arabic RTL/Hindi) | Implemented (auto-transcription needs an STT key) |
| AI Image/Video generation | Needs credentials (image / video provider key) |
| Effects & asset library | Implemented (Effects and Transitions are separate views since v2.4.0 — never mixed; Stock Assets live in v2.2.4) |
| Brand Kit | Implemented |
| Social Media Studio | Implemented (publishing needs a connected platform; TikTok upload Pending) |
| Export Center | Implemented (WebP/SVG/MOV/WebM/4K Pending) |
| Media Library | Implemented |
| AI Assistant | Implemented (v2.2.4 — see §1c) |
| Project management | Implemented |
| Accounts & subscriptions | Implemented (no payment gateway — OWNER-approved requests) |
| Admin panel | Implemented (OWNER/ADMIN only) |
| Security (auth, RBAC, encrypted secrets, upload validation, ownership checks) | Implemented |

## 3. Tech / delivery checklist (from the master prompt)

| Item | Status |
|------|--------|
| Node + Express backend, REST API | Implemented (Node 24 + Express 5, SQLite via better-sqlite3, vanilla-JS SPA, no build step, port 4820) |
| FFmpeg/FFprobe render pipeline | Implemented (real job queue, progress from `time=`, cancel/retry, ffprobe validation of every output, cleanup, logs) |
| Modular AI providers (LLM/STT/TTS/image/video/music) | Implemented (8 providers, 6 kinds, configurable base URL + model, encrypted keys, Test connection with real result) |
| Never hardcode secret API keys | Implemented (keys only via Settings or `.env`, encrypted at rest) |
| PostgreSQL + Redis + object storage (production) | Pending (SQLite file DB, local-first by Phase 1 design) |
| React/Next.js/TS/Tailwind frontend | Pending (vanilla JS + same-server serving, no build step, per Phase 1 plan) |
| WebSocket progress | Pending (polling is used for job progress) |
| WebCodecs / workers / proxy editing | Pending |
| `.env.example` | Implemented (no real secrets in it) |
| Install + deployment guides | Implemented (`docs/INSTALL.md`, `docs/DEPLOYMENT.md`) |
| API docs | Implemented (`docs/API.md`) |
| Automated tests | Implemented (`npm test`, 222 tests, all passing — v2.3.0) |
| Error handling / honest errors | Implemented (`key_needed`, `NOT_CONNECTED`, 402 credit block, clear messages; never a fake success) |
| Production build | Pending (no build step by design; see `docs/DEPLOYMENT.md` for the production notes) |

## 4. Standing user rules — all live

- **Duplicate skip:** whole-row dedupe (trim + case-insensitive, optional key
  column); duplicates are permanently skipped — never generated, never
  retried, no job entry. Preview + job report show total/unique/skipped
  counts and skipped row numbers. Live in Bulk Video, Bulk Design, Quiz.
- **Never-overflow text:** wrap first, then shrink to a readable minimum
  (question 28px / option 24px @1080×1920); pre-render fit check per row;
  per-video fit report (OK / Adjusted / Needs attention); un-fittable rows
  are flagged, never rendered broken; preview fit logic matches render.
- **Uniform font:** all options in a question share one size (set by the
  longest); batch-level one size for questions and one for options;
  outliers flagged "Needs attention" instead of shrinking the batch.
- **Viewer quality bar:** phone-readable, high contrast, safe zones,
  background never fights text, balanced layout, smooth countdown/reveal.
- **Quiz narration:** question → options staggered A→D → reveal; animations
  auto + manual (fade/slide/pop via real drawtext).
- **Voice — both:** user's own voice from a short sample is the default on
  all videos; AI voices too; bulk voice picker + per-row override. Real
  cloning/TTS needs a provider key; recorded narration works now.
- **Final redesign rule:** after all phases complete, the whole project is
  redesigned to the world's best professional designs, no feature left out.
  **That redesign is the remaining work after this report.**

## 5. Honest limits (carried forward, all still true)

- No real provider key, platform token, or Google credential exists in this
  build — no real AI/provider/platform call has ever run; everything was
  proven against local mock servers.
- TikTok video upload is finished in v2.5.0 (chunk upload; ends `published`
  with a real video id, or fails honestly) — needs a connected TikTok
  account to verify end to end. Instagram needs a public media URL
  (`publicBaseUrl`). YouTube uploads as unlisted by default.
- No payment gateway (OWNER-approved plan requests; no payment is taken).
- AI backgrounds / AI voice / STT / AI music / mood tags need keys.
- A vs B quiz format not built; 5-question quiz video at 3s countdown =
  38s, not 45–60s (60s+ needs 8 questions or a 5–6s countdown).
- v2.5.0 built: N video tracks, 4K, chroma key, stabilisation, speed
  curves, keyframe easing, CMYK print conversion. Still not built: proxy
  editing (setting stored; preview still full quality), face/subject
  tracking, Seedance Extend (local install has no public source URL),
  face detection/grouping (no local model), live co-editing (share +
  comments only, by design).
  Stock Assets, AI Assistant and Magic Switch ARE built (v2.2.4).
  Background remover and Magic Grab ARE built (v2.2.2, free local ONNX model) —
  the "no vision model, no background remover" line is retired. Presentations,
  Documents, Charts, Website and Print ARE built (v2.2.3).
- 60-minute video not rendered end-to-end (same pipeline; proven on the
  30s known-structure video — see acceptance C).
- One music track + video audio; beat detection is weaker on
  ambient/classical/vocal-only audio (low confidence warns, flat audio is
  refused, never a guessed BPM). No virality prediction, ever.
- Bulk-job templates are not publishable in the Marketplace.
- Pricing of third-party providers was not verified — this report says
  nothing about cost.

## 6. Acceptance verdicts (A–D)

### A — Bulk Video: PASS
- **Run:** `node scripts/acceptance-a.js` (2026-11-13, real 100-row
  `.xlsx`, 100 unique rows, 100 distinct solid-colour backgrounds + magenta
  logo, 16:9 template with `{{PRODUCT_NAME}} — {{PRODUCT_PRICE}}` text).
  Full evidence: [`docs/acceptance-a-report.json`](acceptance-a-report.json).
- **Result:** 100/100 videos produced, 0 failed, 0 skipped; all 100
  backgrounds different (no-repeat); all 100 outputs byte-distinct
  (100 unique SHA-256 hashes); **every output ffprobe-valid** (h264,
  1280×720, ~1s, 0 probe failures); logo positioned in spot-checked rows
  (5/5, magenta pixel at the logo centre); row text visible in spot-checked
  rows (5/5); every row substituted its own product name + price.
  Render time 114.1s sequential (1 render at a time), total run 268.5s.
- The suite keeps a 10-row version of the same assertions in
  `tests/acceptance.test.js` (same checks, same template shape).

### B — Music Sync: PASS
- Re-verified in `tests/acceptance.test.js` (and `tests/music.test.js`):
  120 BPM click track analysed at 120 BPM (tolerance ±2); apply-sync cut
  the timeline into 4 clips starting at 0.45/1.45/2.45/3.45s (within 0.06s
  of the beat times) with 4 transitions; a synced render of a silent video
  + looped click track is ffprobe-valid (h264 + audio stream) with audio
  RMS above the silence floor — the music was really mixed in.

### C — Long Video to Shorts: PASS (stated scope)
- Re-verified in `tests/acceptance.test.js` (and `tests/shorts.test.js`):
  a generated 30s video with known cuts (10s/20s) and silence windows
  produces valid, score-ranked, in-bounds clips (8–20s); an approved clip
  renders a real **1080×1920** MP4 with audio + burned-in captions
  (SRT, exact timing), ffprobe-valid.
- **Scope, stated honestly:** a full 60-minute video was NOT rendered
  end-to-end in tests (too long); the pipeline is the same code path and
  analysis of long videos runs asynchronously in the background. Subject
  visibility is via the motion-centroid reframe, not face tracking.

### D — Graphic Design: PASS
- Re-verified in `tests/acceptance.test.js`: a design with a gradient
  background, a grouped text layer (96px, shadow) + shape layer, and an
  image layer (filters, crop, flip) was saved, edited + autosaved (a 4th
  layer added), closed, and reopened — the reopened content is
  **byte-for-byte identical** (`assert.deepEqual` against the saved JSON),
  twice in a row; the edited save also has a version entry.

## 7. Bugs found & fixed during Phase 9 QA

1. **Acceptance template did not validate (test bug):** the logo overlay
   was created as an `image`-kind clip on the audio track. The render
   engine's overlay is the second video track, and the validator only
   allows video/audio/text track kinds. Fixed in `tests/acceptance.test.js`
   and `scripts/acceptance-a.js`: the logo is a `video`-kind clip on a
   second video (PiP) track; the renderer detects image media by the
   media's kind.
2. **Dataset response shape (test bug):** the test read
   `ds.json.unique` / `ds.json.skipped`, but the API returns the counts
   under `ds.json.dedupeSummary.unique` / `.skipped`. Fixed in both files.
3. **White-text pixel check sampled the wrong row (test bug):** drawtext's
   `y` is the TOP of the glyphs, so sampling exactly y=360 found almost no
   white pixels. The check now samples a small band around mid-glyph
   (y=380 ± 12) in both files.
4. **Row downloads failed mid-body (test bug, `UND_ERR_SOCKET`):** raw
   `fetch` downloads reused a pooled keep-alive socket that the server had
   already closed (5s keep-alive timeout vs tens of seconds spent on
   ffprobe/pixel checks between downloads). Fixed by sending
   `connection: close` on download fetches — the same practice the test
   `req()` helper already used. The server never crashed; the failure was
   client-side socket reuse.
5. **Three sidebar blurbs overclaimed (UI honesty bug):** Animation Studio
   claimed "motion paths, easing curves, lower thirds, intro/outro" while
   its own view says motion paths/easing are not built; Brand Kit claimed
   "watermarks, intros — auto-applied" (no such code exists); Export
   Center claimed "WebP/MOV/WebM at 720p–4K" (only PNG/JPG + MP4 at
   720p/1080p exist). All three blurbs in `public/app.js` were corrected
   to match reality.

No production code was changed for a feature in Phase 9 — only the three
blurb corrections above. All fixes were re-verified by the full suite.

## 8. What remains after v2.3.0

1. **Final redesign — v2.3.0 CapCut design pass — DONE (this release).**
   Sidebar regrouped CapCut-style, Video Editor + Graphic Editor in the
   four-pane CapCut layout, one design system with full light-theme
   parity — see §1d.
2. **Fix round — v2.3.1 — DONE.** All 27 gaps from the full v2.3.0
   verification audit (C-01–C-27) fixed in one release, one regression
   test per gap — see §1e. Suite is now 249/249.
3. **CapCut Home & Flow — v2.4.0 — DONE.** Home screen as the landing
   after login (hero + New Project, real recent projects, real
   templates, quick-access cards for all 35 features) and the New
   Project chooser that creates a real project and lands inside its
   editor — see §1f.
4. **CapCut parity round — v2.5.0 — DONE.** All 72 items from the
   complete CapCut analysis (§6: P0 → P1 → P2), except the honest
   limits in §1g (Seedance Extend, face detection/grouping, proxy
   preview, per-frame deck animation in MP4) and the P3 defers (live
   co-editing, custom domain, cloud sync, motion tracking, AI stickers,
   object removal, eye contact/lip sync, in-app camera) — see §1g.
4. Provider keys (Settings → AI Providers, secure entry — never in chat)
   to make AI modes, AI backgrounds, TTS/cloning, and STT run for real.
   (Gemini free key is already configured on the user's PC and tested OK.)
5. Platform connections (Settings → Connections) to publish for real.
6. Google OAuth credentials for Sheets import (Settings → Google Sheets).
