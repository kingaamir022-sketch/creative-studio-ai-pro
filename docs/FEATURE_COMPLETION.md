# CreativeStudio AI Pro — Feature Completion Report (Phase 9, Final QA)

**Version:** 2.3.0 · **Date:** 2026-11-14 · **Suite:** `npm test` — **222/222 pass, 0 fail**
(exit 0, single clean run; see [Acceptance verdicts](#acceptance-verdicts-a–d) below).

**Rule of this report:** every feature is exactly one of **Implemented**,
**Needs credentials**, or **Pending** — nothing incomplete is marked complete.
"Needs credentials" means the code is built and tested (against a local mock
provider / mock platform / mock Google server) but it cannot do anything real
until the user supplies a key, token, or OAuth connection. No real provider
key, platform token, or Google credential exists in this build, so **no
real-provider or real-platform call has ever run**.

## 1. The 35 sidebar sections (CapCut groups, v2.3.0)

| # | Section | Status | Notes |
|---|---------|--------|-------|
| 1 | Dashboard | Implemented | Real DB counts, recent projects/media, system status (FFmpeg, storage vs plan), notifications, quick actions, global search (projects & media). |
| 2 | AI Design Studio | Needs credentials | Prompt → editable design (never a flattened image) works through the Phase 7 LLM layer; without an LLM key it refuses with `key_needed`. A clearly-labelled local rule-based layout helper works with no key. |
| 3 | Graphic Editor | Implemented | Real canvas editor (drag/resize/rotate, layers, undo/redo, snap guides, 12 sizes, 15 fonts, shapes/images/filters/crop, gradient + transparent PNG/JPG export), 26 built-in templates (20 design + 3 video + 3 deck, v2.2.4), Brand Kit. **Pending:** text curvature (no fake control shown). |
| 4 | Video Editor | Implemented | Multi-track timeline (drag/trim/split/ripple/group, markers, snapping, undo/redo), speed/volume/fade/filters, text clips, Fade/Dissolve/Slide/Wipe via FFmpeg xfade, position/scale/opacity keyframes, real FFmpeg render queue. **Pending:** chroma key, stabilisation, proxy editing, speed-ramping curves, motion paths/easing (keyframes interpolate linearly), 4K, a 3rd video track (max 2: main + one overlay/PiP). |
| 5 | AI Video Generator | Needs credentials | Text-to-video / image-to-video via the Phase 7 provider registry (Runway). Without a video provider key it refuses with `key_needed`. |
| 6 | AI Image Generator | Needs credentials | Text-to-image / image-to-image (OpenAI Images / Stability). Without an image provider key it refuses with `key_needed`. |
| 7 | Bulk Design Studio | Implemented | One template + spreadsheet → PNG/JPG per row, ZIP export, whole-row dedupe (duplicates never generated, never retried). |
| 8 | Bulk Video Studio | Implemented | The flagship: `{{FIELD}}` templates, XLSX/CSV/JSON/Google Sheets import, Dynamic Background Engine (Random Unique / Category / Uploaded Pool real; AI + Prompt-Based live in Phase 7 but need an image key), per-row real MP4 renders, failed-row retry, ZIP export, duplicate-skip, quiz preset to the research spec, overflow-proof fit + batch-uniform fonts, narration + voice. **Pending:** A vs B quiz format. |
| 9 | Smart Template Builder | Implemented | Master-template builder with `{{FIELD}}` bindings, field mapping, background rules, fit-check, sample render. (Lives inside Bulk Video/Design.) |
| 10 | Long Video to Shorts | Implemented | Real local analysis (scene + silence + energy), explainable ranked clips, motion-centroid 9:16 reframe, review gallery, captions. **Pending:** face/subject tracking for the reframe (motion centroid only); a full 60-minute video was not rendered end-to-end (see acceptance C). |
| 11 | AI Music Studio | Implemented | Real local DSP: BPM/beat grid/downbeats/energy curve/drop detection, waveform, confidence; Music Library (own/licensed audio only); Sync Director (cut/transition on beat, divisor, pulse, fade/volume/loop); beat-snap + beat ruler. AI music generation / mood tagging are live in Phase 7 but **need a music / LLM key**. **Pending:** multi-track audio mixing. |
| 12 | Auto Captions | Implemented | Manual transcripts (plain text = estimated timing, SRT/VTT = exact), editable, SRT/VTT export, word-by-word burn-in, Urdu/English/Roman Urdu/Arabic RTL/Hindi. Automatic transcription is live in Phase 7 but **needs an STT key** (refuses with 402 `key_needed` without one — never a fake transcript). |
| 13 | Background Remover | Implemented (v2.2.2) | Free local U-2-Net ONNX model (`onnxruntime-web`, WASM) — no key, nothing uploaded. Model (~168 MB) downloads once on first use into `data/models/u2net.onnx` and is cached; offline → honest 503. Also powers Magic Grab. Live in Magic Tools; the sidebar entry is now the Magic Tools view. |
| 14 | Effects & Transitions | Implemented | Searchable library of the effects that really exist (filters, transitions, text animations); the view lists chroma key, stabilisation, object removal, proxy editing, speed ramping and motion paths as **not built**, never as working. |
| 15 | Animation Studio | Implemented | Keyframes (position/scale/opacity, linear interpolation) + text fade/slide/pop animations, auto + manual per-element timing. **v2.2.2 — Magic Animate presets:** 10 one-click presets (fade, slide-up, slide-left, pop, zoom, bounce, float, pulse, spin, typewriter); design presets apply to a layer in the Graphic Editor and preview live with CSS; clip presets expand into real video keyframes held to the clip end. **Still pending:** motion paths, easing curves; typewriter and spin are design-only (drawtext cannot render them — never offered for clips). |
| 16 | Brand Kit | Implemented | Brand profiles (logos, colours, fonts), one-click apply to designs. |
| 17 | Media Library | Implemented | Real uploads (image/video/audio, 200 MB default), search/tags/folders/favourites/preview, delete removes the disk file. |
| 18 | Stock Assets | Implemented (v2.2.4) | Free stock images + audio via Openverse (key-free anonymous API, verified live) — search by keyword/license/category, preview, save straight into the Media Library with attribution + license recorded; re-saving the same asset returns the existing row (duplicate skipped, never a second copy). **Honest limit:** Openverse has no video search (images + audio only) — the UI says so plainly; stock video stays an upload-your-own-file flow. |
| 19 | Social Media Creator | Implemented | Compose + attach from library, real per-platform char limits, AI caption/hashtags via Phase 7 LLM (**needs an LLM key**; local template captions are clearly labelled, never "AI"), drafts/scheduling, scheduler. Publishing **only via official platform APIs when connected** — no platform is connected on a fresh install, so Publish refuses with `NOT_CONNECTED`; never a fake publish. **Pending:** TikTok video upload (initialises, chunk upload unimplemented — fails honestly). |
| 20 | Content Calendar | Implemented | Month view of scheduled posts, schedule/reschedule from the composer, scheduler runs due posts (every 15 s + manual run). |
| 21 | Export Center | Implemented | Render-job list, download, save-to-library, ZIP. Formats actually offered: PNG/JPG designs, MP4 video at 720p/1080p. **Pending:** WebP/SVG, MOV/WebM, 4K, custom naming. |
| 22 | Projects | Implemented | CRUD, duplicate, trash/restore/permanent delete, autosave, version history (latest 20) + restore, per-user ownership. |
| 23 | Templates Marketplace | Implemented | In-app only (no external store): publish design/video/deck templates, browse/search, install = a real editable project, rate, report. **v2.2.4:** built-in library grown 8 → 26 (20 design + 3 video + 3 deck), all validated and installable from the Marketplace view; decks publishable too. **Pending:** bulk-job templates are not publishable. |
| 24 | AI Assistant | Implemented (v2.2.4) | Project-aware assistant: summarise a project, suggest improvements, "make this more professional" (design + deck), "create five versions" (design). Every action creates a NEW project — the original is never edited in place. Needs an LLM key (free Gemini works); without one it refuses 402 `PROVIDER_KEY_NEEDED` and creates nothing. |
| 25 | Analytics | Implemented | DB-only numbers: renders over time, AI generations by mode, posts by status/platform, storage, top templates, credit burn. No invented benchmarks. |
| 26 | Settings | Implemented | Provider keys (AES-256-GCM encrypted, never returned in full), Google Sheets OAuth config, platform connections, profile, preferences. |
| 27 | Subscription & Credits | Implemented | Plans Free/Starter/Pro/Business/Enterprise, transparent credit ledger (charge on success, pre-flight 402 block at 0 balance), usage history. **No payment gateway by design** — plan changes are OWNER-approved requests; no payment is taken in this build. |
| 28 | Presentations (v2.2.3) | Implemented | New `deck` project type: 6 slide layouts (title, text, text-image, chart, quiz, blank), add/move/duplicate/delete slides, speaker notes, per-slide duration, present mode, never-overflow fit check + batch uniform fonts for quiz slides, export to slide images (ZIP), PDF, or MP4 video (render queue). AI deck generation via the LLM (needs a key; free Gemini works). |
| 29 | Documents (v2.2.3) | Implemented | New `doc` project type: headings, paragraphs, lists, quotes, tables, images, charts, dividers; autosave; export to HTML, real .docx (Word Open XML) and PDF (A4 pages rendered with the real font metrics); print-friendly view. |
| 30 | Charts (v2.2.3) | Implemented | Bar/line/pie/doughnut charts from pasted CSV or a manual table; duplicate rows permanently skipped (never doubled); SVG + PNG render (pure-JS rasterizer + FFmpeg text labels); save to Media Library as a real image, embeddable in decks, docs, designs and websites. |
| 31 | Website (v2.2.3) | Implemented | Publish a design, deck or document as a static website (index.html + assets) served locally at /sites/:slug/; unpublish removes it. Local hosting only — no custom domain, no external host. |
| 32 | Print (v2.2.3) | Implemented | Print-ready PDF export: A4 / US Letter / Poster 18×24 in at 150 DPI, configurable bleed (0–10 mm) and margin, crop marks + safe-zone guide drawn as vector lines. RGB PDF — CMYK conversion is not built. |
| 33 | AI Studio | Needs credentials | The 10-mode studio (text, image, video, voice, quiz, transcription, music, deck, captions, design) through the Phase 7 provider registry; every mode refuses `key_needed` without its provider key, never a fake result. |
| 34 | Voices | Implemented | Your own voice from a short sample is the default on all videos; AI voices too; bulk voice picker + per-row override. Real cloning/TTS needs a provider key; recorded narration works now. |
| 35 | Admin Panel | Implemented | OWNER/ADMIN only: users, plan requests, platform stats, audit log, system health. |

**v2.3.0 sidebar groups (CapCut order):** Create (Dashboard, AI Design Studio, Graphic Editor, Presentations, Documents, Charts) · AI Studio (AI Studio, AI Video Generator, AI Image Generator, AI Assistant) · Edit (Video Editor, Effects & Transitions, Animation Studio, Magic Tools, Auto Captions) · Bulk & Automation (Bulk Design Studio, Bulk Video Studio, Smart Template Builder, Long Video to Shorts, Music Sync Director, Voices) · Library (Media Library, Stock Assets, Templates Marketplace, Projects, Brand Kit) · Publish & Grow (Social Media Creator, Content Calendar, Website, Print, Export Center, Analytics) · Account (Admin Panel, Settings, Subscription & Credits). Effects under Effects, Transitions under Transitions, AI under AI, library under Library — nothing mixed.

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

## 2. Key modules (from the master prompt)

| Module | Status |
|--------|--------|
| Graphic Design Studio | Implemented (text curvature Pending; Magic Resize + Magic Animate presets live in v2.2.2) |
| Video Editor | Implemented (chroma key, stabilisation, speed ramping, proxy editing, 4K, 3rd track Pending) |
| Magic Tools (v2.2.2) | Implemented: Magic Resize (local reflow), Magic Animate presets (10), Magic Eraser (needs image key), Magic Expand (AI needs key; solid/blur local), Background Remover + Magic Grab (free local ONNX, no key), Magic Write (LLM, needs key; free Gemini works) |
| Magic Switch (v2.2.4) | Implemented: reflow between the 12 size presets + LLM translate (14 languages incl. Urdu + Roman Urdu); always creates a new project; no key → 402 `PROVIDER_KEY_NEEDED` |
| Stock Assets (v2.2.4) | Implemented: Openverse images + audio (key-free), save to Media Library with attribution; no video search (Openverse has none) |
| AI Assistant (v2.2.4) | Implemented: summarise, suggest, make-professional (design + deck), five-versions (design); new projects only, never edits in place; needs an LLM key |
| Collaboration (v2.2.4) | Implemented: read-only share link + per-user share + comments (replies, resolve). No live co-editing (out of scope by design) |
| Updater overlay (v2.2.4) | Implemented: verified `node_modules` overlay in update packages (SHA-256 per file, backup + rollback cover it, native modules refused) — new production dependencies no longer need fullReinstall. Design: `docs/UPDATER.md` |
| Docs & Slides (v2.2.3) | Implemented (AI deck generation needs an LLM key; CMYK print Pending) |
| Bulk Video Studio + Dynamic Background Engine | Implemented (AI/prompt backgrounds need an image key; A vs B quiz Pending) |
| AI Music Sync Director | Implemented (AI generation/mood need keys; multi-track mixing Pending) |
| Long Video to Shorts | Implemented (face tracking Pending; 60-min end-to-end render not run) |
| AI Captions (Urdu/Roman Urdu/Arabic RTL/Hindi) | Implemented (auto-transcription needs an STT key) |
| AI Image/Video generation | Needs credentials (image / video provider key) |
| Effects & asset library | Implemented (Effects list is honest about what is not built; Stock Assets live in v2.2.4) |
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
- TikTok video upload is unfinished (chunk upload unimplemented — fails
  honestly, never marked published). Instagram needs a public media URL
  (`publicBaseUrl`). YouTube uploads as unlisted by default.
- No payment gateway (OWNER-approved plan requests; no payment is taken).
- AI backgrounds / AI voice / STT / AI music / mood tags need keys.
- A vs B quiz format not built; 5-question quiz video at 3s countdown =
  38s, not 45–60s (60s+ needs 8 questions or a 5–6s countdown).
- Max 2 video tracks, no 4K, no chroma key/stabilisation/proxy editing,
  no motion paths/easing, no face/subject tracking, no CMYK print
  conversion, no live co-editing (share + comments only, by design).
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
2. Provider keys (Settings → AI Providers, secure entry — never in chat)
   to make AI modes, AI backgrounds, TTS/cloning, and STT run for real.
   (Gemini free key is already configured on the user's PC and tested OK.)
3. Platform connections (Settings → Connections) to publish for real.
4. Google OAuth credentials for Sheets import (Settings → Google Sheets).
