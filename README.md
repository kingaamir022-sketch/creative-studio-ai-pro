# CreativeStudio AI Pro — v2.1.0: Auto-Update

All-in-one AI graphic design, video editing, bulk video automation & social
media content platform. **v2.1.0 = Auto-Update (PageCommand-Pro-style):**
the app checks the update feed on start and every 6 hours, shows a
Dashboard banner once per available version, and applies verified updates
in place (SHA-256 checked, backed up first, rollback included) — see
[Updates](#updates-auto-update) below. On top of the Phase 1 foundation
(auth, dashboard, media library, projects), the Phase 2 Graphic Design
Studio, the Phase 3 Video Editor + FFmpeg render engine, the Phase 4 Bulk
Studio, Phase 5 Music Sync, the Quiz Narration + Voice upgrade, Phase 6
Shorts + Captions, Phase 7 AI Creative Studio, and Phase 8 Social &
Business Tools, plus the v2.0.0 Final Redesign. See
[`docs/MASTER_PROMPT.md`](docs/MASTER_PROMPT.md) for the full 27-section
specification and [`docs/FEATURE_COMPLETION.md`](docs/FEATURE_COMPLETION.md)
for the honest implemented / needs-credentials / pending list.

> Local build only. Not pushed to GitHub, not uploaded to Drive, not published.

## Updates (auto-update)

New versions arrive in the app itself — no delete/reinstall, no file
download. Full detail: [`docs/UPDATE_SYSTEM.md`](docs/UPDATE_SYSTEM.md);
release flow: [`docs/RELEASE.md`](docs/RELEASE.md).

**How it works:** the app checks the update feed
(`https://raw.githubusercontent.com/kingaamir022-sketch/creative-studio-ai-pro/main/updates`)
on start and every 6 hours. When a newer version is published, the
Dashboard shows a banner once for that version (dismissible, never
reappears for it). With auto-apply OFF (the default) nothing installs until
you click **Update now**; with it ON the update installs itself and the app
restarts. Every update package is SHA-256 verified file by file, the
current version is backed up first (last 2 kept), and **Roll back** in
Settings → Updates restores the previous version.

**One-time setup:** none needed in the app — the feed URL is already the
default. The feed repo `kingaamir022-sketch/creative-studio-ai-pro` was
created on 2026-11-13; the feed goes live once the first manifest +
package are pushed into its `updates/` folder. Until then the status says
"Feed not reachable" honestly (never "up to date" when the check never ran).

**On update day:** open the app → Dashboard banner → Update now → the app
restarts itself (Windows) or asks for a server restart. If the update
changes dependencies, the app says so plainly and does NOT apply it — that
one needs a fresh download from Drive.

## What changed in v2.1.0 — Auto-Update ✅

PageCommand-Pro-style self-update, built 2026-11-13 (tests 144/144):

- **Updater core — `src/updater.js`.** URL feed (`version.json` manifest +
  `update-<version>.json` bundle) or local folder feed; package SHA-256 and
  every file's SHA-256 verified; app-code paths allow-listed only; backup
  before apply (last 2 kept), rollback on failure and on demand. An http(s)
  feed value is always treated as a URL feed, whatever the stored type says.
- **Windows apply — `apply-update.bat`.** On win32 the apply writes the
  batch, launches it and exits; the batch waits for the server to stop,
  copies the staged files (restoring the backup if a copy fails), then
  relaunches `Start.bat`. Elsewhere the files are copied in place and a
  restart is requested.
- **API + UI — `src/routes/updates.js`.** `GET /api/updates/status`,
  `POST /api/updates/check|apply|rollback|dismiss`, `GET/POST
  /api/updates/settings` (OWNER/ADMIN for settings + apply; everyone can
  see status). Settings → Updates card; Dashboard banner once per version
  (dismissible, never reappears for it) + applied-update note. Auto-check
  on start + every 6 h; auto-apply OFF by default.
- **Publish — `scripts/publish-update.js`.** Builds the bundle + manifest
  from the current tree with SHA-256; `--full-reinstall` for dependency
  changes (never applied in place — the app says fresh download instead).
- **Docs — `docs/UPDATE_SYSTEM.md`, `docs/RELEASE.md`.** Feed format,
  safety, release flow. Feed repo `kingaamir022-sketch/creative-studio-ai-pro`
  created 2026-11-13; feed goes live once the manifest + first package are
  pushed to its `updates/` folder.

## What changed in v2.0.0 — Final Redesign ✅ (design only, no new features)

The whole app was re-skinned on one design system (research: Figma, Linear,
Canva, CapCut/DaVinci, Notion/Stripe/Vercel — see
[`docs/REDESIGN.md`](docs/REDESIGN.md)):

- **Design tokens — `public/tokens.css` (new, loaded first).** Three tiers:
  primitives (navy/slate/violet/blue/cyan + semantic hues) → semantic tokens
  (`--bg`, `--surface`, `--surface-raised`, `--text`, `--text-2`, `--text-3`,
  `--border`, `--border-strong`, `--accent`, `--accent-2`, `--cyan`,
  `--success`, `--warning`, `--danger`, `--info`) → component tokens (type
  scale 12/13/14/16/18/20/24/30px + display with tight tracking, spacing
  4/8/12/16/24/32/48px, radii 6/8/12/16px, shadows sm/md/lg for floating
  elements only). All 11 stylesheets use tokens; no raw hex is left in the
  chrome — the only literal colours left are *content* (white design canvas,
  black video stage, phone-frame/quiz-brand colours). The brand gradient
  lives only on the logo mark.
- **Light / Dark themes.** Dark (deep navy/charcoal + purple/blue) is the
  default; Light is a `[data-theme="light"]` token swap with the same token
  names, so every view has real parity. Switch with the ☀️/🌙 button in the
  topbar — it persists in `localStorage` (`cs-theme`), respects
  `prefers-color-scheme` on first load, and is applied before first paint
  (no flash). Both themes were screenshot-verified (dashboard, settings,
  bulk, video editor, graphic editor, music, shorts, social, admin,
  placeholder views, auth) plus a 390px mobile pass.
- **App shell.** Sidebar with all 27 items, topbar with global search,
  notification centre and a new profile menu (name/email/role/plan/credits,
  Settings, Subscription & Credits, Sign out); dashboard KPI strip of 4
  cards, recent projects/media, system status, quick actions.
- **Shared components, consistent everywhere:** buttons
  (primary/secondary/ghost/danger, sm/md — primary is now solid accent, no
  gradient), inputs/selects/textareas (default/hover/focus/filled/error/
  disabled), cards (1px border, shadow only when floating), tables
  (`tabular-nums` on all data), badges/status pills (label + icon, never
  colour-only), modals, toasts, progress bars, tabs, toggles, skeleton
  loading states (shaped like the content — shown while any view loads),
  error states with Try again, and empty states with one CTA (e.g. "Create
  your first project").
- **Responsive ≤860px:** the sidebar becomes an off-canvas drawer behind a
  hamburger (with backdrop), panels stack, editors stack, no horizontal
  overflow on desktop or mobile (verified 0px at 390px).
- **Accessibility:** visible 2px focus ring everywhere, text never fights
  its background in either theme, status is never colour-only (✓/✗ + labels
  kept).
- **Two stale-copy fixes only** (blurbs that had become untrue): the
  dashboard System status version was still `1.2.0 (Phase 3 — Video Editor)`
  → now `2.0.0 (Final Redesign)`, and the AI-credits card still said
  "no charges in Phase 1" → now points at the Subscription & Credits
  ledger. No features, behaviour, or honest "not yet built" states changed.
- **Version:** `package.json`, server health (`/api/health`) and the
  dashboard version row all report **2.0.0** (phase stays 9 — the redesign
  is not a new feature phase). Tests: **132/132 pass, 0 fail** (the six
  health-endpoint version assertions were updated 1.9.0 → 2.0.0 as part of
  the bump).

## What works in Phase 3 ✅

- **Video Editor** (`Video Editor` in the sidebar, or open any `video`
  project → “Open in Video Editor”) — professional layout: left panel
  (Media / Text / Transitions), centre video preview (real `<video>`
  playback), right panel (Clip / Keyframes / Export), bottom multi-track
  timeline.
  - **Timeline** — video track(s) + audio track(s) + text track(s). Drag
    clips to move/reorder (magnetic snapping to clip edges + playhead),
    drag edges to trim (in/out points), split at the playhead (real split
    into two clips with correct `srcStart` and keyframe redistribution),
    delete, duplicate, ripple delete (gap closes), clip grouping (overlapping
    clips move together), track lock/mute, timeline zoom, frame-by-frame step
    (±1 frame), markers (add/jump), playhead scrubbing, time display,
    undo/redo for timeline edits (Ctrl+Z / Ctrl+Shift+Z).
  - **Clip controls** — speed (0.25×–4×, audio pitch-corrected with
    `atempo`), volume, fade in/out (video + audio), rotation (0/90/180/270),
    flip, fit/fill + zoom, opacity, brightness/contrast/saturation/
    temperature/sharpness/blur/vignette — every control affects both the
    preview and the render.
  - **Text clips** — real text with font/size/colour/position, fade/slide
    in/out animation, optional background box; rendered with FFmpeg
    `drawtext` (same placement as the preview).
  - **Transitions** — Fade, Dissolve, Slide, Wipe between adjacent clips on
    the same track (adjustable duration, up to 2s), rendered with FFmpeg
    `xfade`; the preview crossfades in the browser and is labelled as an
    approximation.
  - **Keyframes** — position (X/Y %), scale (0.5–3) and opacity (0–1),
    linear interpolation between points; rendered with FFmpeg (smooth pan
    via crop expressions, zoom via sampled sub-segments, opacity via
    per-frame alpha). Add a keyframe at the playhead — it samples the
    current interpolated pose.
  - **Save/load** — video projects store the timeline JSON; autosave
    (debounced), manual Save version, version history + restore; reopening
    restores every clip, trim, transition and keyframe exactly (tested).
- **Rendering engine (real, FFmpeg)** — `src/render.js` + `src/routes/video.js`:
  - Job queue (one active render by default, `RENDER_CONCURRENCY` env),
    background processing (non-blocking child process), **real progress**
    parsed from FFmpeg's `time=` output, cancel (kills FFmpeg, deletes the
    partial file), retry for failed/cancelled jobs, error reporting with the
    real FFmpeg stderr tail, per-job render logs, temp-file cleanup.
  - **Export validation** — every finished render is ffprobe-checked:
    duration (±0.75s), resolution, frame rate and h264 codec must match the
    request, otherwise the job fails with the reason. Transitions shift
    later clips earlier, and audio + text are shifted by the same amount so
    A/V sync and caption timing stay correct.
  - Output: real playable MP4 (libx264 + AAC, `yuv420p`, `+faststart`),
    720p/1080p, 24/30/60 fps, aspect ratios 16:9 / 9:16 / 1:1 / 4:5
    (scale/crop/pad via FFmpeg). Audio: clip audio + music tracks mixed
    with `amix`, trimmed to the rendered duration.
- **Export Center** — lists all render jobs (queued/running/done/failed/
  cancelled) with progress bars, MP4 download, cancel/retry/delete, job log
  viewer, and “Save to Media Library” (the finished MP4 becomes a real
  library file with probe data).
- **Effects & Transitions + Animation Studio** — the sidebar views now list
  exactly what is supported (transitions, filters, keyframe properties) and
  honestly list what is not (chroma key, stabilization, proxy editing,
  motion paths/easing curves).
- **Media Library probing (Phase 3)** — video/audio uploads are probed with
  ffprobe in the background: real duration, resolution, fps and codec are
  stored in the DB and shown in the library and in the editor; videos get a
  real JPEG thumbnail (FFmpeg screenshot).
- **Phase 1 + 2, preserved** — auth, dashboard, Media Library, projects,
  Graphic Editor (layers, templates, Brand Kit, PNG/JPG export), AI Design
  Studio (live AI now works with an LLM key, Phase 7).

## What works in Phase 4 ✅

- **Bulk Video Studio** (sidebar → **Bulk Video**) — a 4-step wizard:
  1. **Template** — pick a saved video project as the master template;
     every `{{FIELD}}` in it (text, image, background, music, price, CTA)
     maps to a spreadsheet column. The template stays a normal video
     project — edit it in the Video Editor and the next batch uses the new
     version. Bindings are stored on the template (Template Builder view).
  2. **Data** — upload a real XLSX or CSV file (parsed with SheetJS),
     paste CSV/TSV/JSON text, import JSON, or add rows by hand. Columns are
     auto-detected, the field mapping is editable, rows are editable and
     selectable, and the preview table shows the dedupe summary.
  3. **Background** — the Dynamic Background Engine (see below).
  4. **Generate** — Check fit, render a sample row (a real render),
     Generate All (background batch job on the Phase 3 queue, per-row
     progress queued/rendering/done/failed), retry failed rows (single +
     all), cancel, per-row download, and **Export ZIP** (real ZIP with
     every output). Outputs are independent real MP4s (ffprobe-validated),
     named from a column (e.g. product name), in the template's aspect
     (9:16 / 16:9 / 1:1 / 4:5). Max 100 rows per batch by default (hard
     cap 1000); progress polls so the UI never freezes.
- **Dynamic Background Engine** — one background per row, five modes:
  Random Unique (shuffled pool, no repeat by default), AI Generated,
  Prompt-Based (`BACKGROUND_PROMPT` column), Category-Based (category →
  pool mapping, rotation minimises repeats), Uploaded Pool. Repeat rules:
  No repetition (default) / allow repetition after N videos / fully
  random / manual assignment per row. Readability protection is real
  FFmpeg work per render: the background's brightness/busyness is measured
  (luminance + edge density) and a bright/busy background gets an auto
  dark overlay and/or blur so the text stays readable; smart crop to the
  output aspect is a real scale/crop. Text/logos/prices keep their template
  positions unless adaptive layout is enabled.
- **Duplicate skip (user rule)** — on import, duplicate rows are
  **skipped permanently**: only the first row's video/design is ever made.
  Duplicate = the whole row's normalised content over all mapped fields
  (trim + case-insensitive; empty == empty), or — if the user picks one —
  a key column (e.g. `PRODUCT_NAME`). Import/preview shows total rows,
  unique rows, skipped duplicates and which row numbers were skipped (and
  which first row they duplicate). Skipped rows get no video, no job, no
  retry entry and no credit/usage count; the job report says
  “X duplicates skipped”. Applies to Bulk Video, Bulk Design and Quiz.
- **Bulk Design** (sidebar → **Bulk Design**) — the same import/dedupe/
  background rules drive a Phase 2 graphic template with `{{fields}}`:
  one PNG/JPG per row (real FFmpeg render of the design) + ZIP export.
- **Quiz Video preset** (a card in Bulk Video, template id `quiz`) — the
  built-in quiz format; see the spec section below.
- **Jobs & history** — every bulk job lists per-row status, duration,
  output file, the real FFmpeg error tail for failed rows, and the fit
  report; cancel a running batch, retry failed rows, delete a batch
  (render outputs stay in the Export Center).

### Quiz Video preset — research spec

The quiz template follows the **Best Quiz Video Design Spec** (research
2026-11-12, `~/workspace/research_notes/best-quiz-video-editors-research-20261112-1159/report.md`,
synthesised from Videotto, Velosofy, GhostShorts, Versely, Clippie,
MakeViral and the bundle.social safe-zone checker). **Caveat from that
research: the top channels' exact fonts/px/colours were NOT measured
frame-by-frame — the numbers below are guide/template defaults, and every
one is changeable in the quiz settings.**

- **Format:** 1080×1920, 9:16, 30fps, 5 questions per video.
  Hook = the first question in frame 1 (0–1s), no title card.
- **Timing (defaults):** ~2s read + 3s countdown (identical every
  question, never <3s or >6s) + 2s reveal, then a 3s score card
  (“Kitne sahi hue? Comment mein score likho”). Single-question video =
  10s; 5-question video = **38s** at these defaults.
- **The 45–60s note (honest arithmetic):** the research report says
  5 questions ≈ 45–60s, but that assumes 5s countdowns (5×(2+5+2)+3 =
  48s). At the 3s-countdown default the total is 38s. For TikTok
  Creator Rewards (60s+) use **8 questions** (8×7+3 = 59s) or a 5–6s
  countdown — both are settings, not faked totals.
- **Layout:** question centred in the middle band; 4 options as a
  **full-width stacked A/B/C/D list** (2×2 grid only for image tiles);
  one timer style per video — the load-bar (top channels' default).
  **Safe box x48–888, y288–1248** (strict intersection of TikTok/Reels/
  Shorts safe zones) — nothing essential outside it.
- **Typography:** heavy bold sans; question max ~96px @720w (≈144px
  @1080w, cap height ~100px — spec 90–130px), options max ~54px @720w
  (≈81px @1080w, cap height ~57px — spec ≥54–60px), max 2 lines,
  contrast ≥4.5:1.
- **Colours:** deep navy `#14213D` + white bold text + one amber accent
  `#FCA311` (countdown bar, chip, score card). **Correct = GREEN
  `#16a34a` highlight + ✓** (the user's rule wins over the research
  amber-for-correct); wrong = dim + ✗. Never colour alone — always
  tick/cross + label too.
- **Difficulty ramp:** easiest first, hardest last (easy/easy/medium/
  hard/hardest; `hardest` is a supported difficulty value).
- **Text caps (research recommendation):** question ≤80 characters /
  <12 words, options ≤22 characters (1–3 words). Over-cap text gets a
  **“Needs attention” warning FIRST**, then the uniform-shrink safety
  net (all options one size, never below the readable minimum). No text
  ever leaves its box.
- **RTL/non-Latin:** mirrored layout (labels on the right, right-aligned
  text), linear bar, Arabic → Noto Kufi Arabic / Noto Sans Arabic,
  line-height 1.5, zero letter-spacing.
- **Data columns:** `QUESTION, OPTION_A, OPTION_B, OPTION_C, OPTION_D,
  CORRECT` (A/B/C/D or the option text), `EXPLANATION, CATEGORY,
  DIFFICULTY, TIMER_SECONDS` (default 3, clamped 3–6), `QUESTION_IMAGE`
  (optional). One row = one question. Bulk modes: (a) each row → its own
  single-question video; (b) rows grouped into one multi-question video
  (5 per video by default). Formats: Multiple Choice (4 options) +
  True/False (2 options); A vs B is not built yet.

### Overflow-proof fit + uniform fonts (the Canva rule)

The user ruined quiz videos in Canva when a long question/option
overflowed its box — this software must never do that. The guarantee
applies to **every `{{field}}` text element** in bulk video/design,
not just quiz:

1. **Pre-flight fit check** (before render, per row): server-side text
   measurement for every text element (question + each option + CTA +
   explanation + product name/price/description). **Wrap first, then
   shrink** the font step by step to the readable minimum:
   **question 28px @1080×1920 (19px @720×1280), option 24px (16px),
   explanation 21px (14px)**. Never below the minimum.
2. If text still does not fit at the minimum: the row is **not failed
   and no bad video is made** — it is flagged **“Needs attention”** with
   a red warning in preview + a suggested shorter text, and the auto-fix
   wraps to more than 2 lines and grows the box height **within the
   grid** (grid intact, safe zone respected). Text never renders outside
   its box, in any case.
3. **Per-row FIT REPORT in every bulk job:** “Fit: OK / Adjusted
   (font X→Y) / Needs attention”, with the question font size and the
   options font size, so the user can check they are all the same.
4. **Editor preview uses the same fit logic as render** — the phone-frame
   (9:16) preview shows exactly what the viewer will see, with a red
   outline on any overflowing element and the dashed safe box drawn in.
   Preview and render cannot disagree.
5. **Uniform font (layered on the fit rule):** all four options in a
   question share **one font size** — the size that fits the longest
   option applies to the other three too, even if their text is short.
   Shrinking each option separately is forbidden. The same size holds
   **across the batch** (one question size + one options size for the
   whole batch, set by the longest row). If one outlier row would drag
   the whole batch below the readable minimum, that row is flagged
   “Needs attention” and the rest of the batch keeps its correct size.
6. **Viewer quality bar:** phone-readable (big clear text, strong
   contrast, dark overlay/blur over bright/busy backgrounds, no clutter),
   balanced layout (question top, options centred, timer/reveal clear,
   nothing essential in the safe zones), consistent colours (brand
   colours, green correct, dim wrong — same look every video), smooth
   motion (fade-in reveal, shrinking bar — no sudden jumps), background
   never fights the text. The test suite extracts a thumbnail from a
   sample quiz render and checks readable text, contrast, safe zones and
   balance.

### Try a bulk batch (exact clicks)

1. Start the app (`npm start`), sign up (first account = OWNER).
2. **Media Library** → upload 2–3 images or short videos (these become
   the background pool). Note their names.
3. **Bulk Video** → **New bulk job** → name it, pick **Video**, pick a
   template — first create one: **Video Editor** → Create video (16:9)
   → add a video clip + a text clip `{{PRODUCT_NAME}} — {{PRODUCT_PRICE}}`
   → Save. Back in Bulk Video, pick that project.
4. **Step 2 Data** → **Upload file** → choose
   [`docs/sample-bulk.csv`](docs/sample-bulk.csv) (6 rows, 1 duplicate).
   The preview shows **6 total, 5 unique, 1 skipped** (row 4, duplicate
   of row 1).
5. **Step 3 Background** → mode **Random Unique**, pick your uploaded
   media as the pool → **Assign backgrounds**.
6. **Step 4 Generate** → **Check fit** (all rows OK/Adjusted) → **Sample**
   (renders row 1 for real) → **Generate All**. Watch per-row progress;
   when done, **Download ZIP** — 5 MP4s (row 4 has no video, ever).
7. **Quiz:** Bulk Video → **🎯 Quiz Video (preset)** → upload
   [`docs/sample-quiz.csv`](docs/sample-quiz.csv) (5 questions, the last
   one deliberately over the caps to show the Needs-attention warning) →
   Background → Generate All. Single mode gives 5 videos of 10s each;
   switch to multi mode (5 per video) for one 38s video.

## What works in Phase 5 ✅

- **Real audio analysis, no API key (local DSP)** — sidebar →
  **Music Sync Director**. FFmpeg decodes the track to 22050 Hz mono PCM;
  a pure-Node FFT + spectral-flux onset envelope finds the tempo
  (autocorrelation over 60–200 BPM with fractional lags and a grid-coverage
  octave check — a 120 BPM click track reads 120.41 BPM, a 90 BPM track
  89.28, a 60 BPM track stays 60.2), then a phase search builds the beat
  grid (each beat refined to its nearest onset peak), downbeats are
  estimated from 4-beat bars, per-second energy is measured, sustained
  energy jumps are flagged as drops, and a 200-bucket waveform is stored
  for display. Analysis is cached per (user, track, file hash) in the
  `audio_tracks` table — re-analysis is instant, and a replaced file is
  never served a stale analysis. A confidence score (0–1, from
  autocorrelation strength + beat/onset alignment) is shown with every
  result; a flat drone is **refused** with a clear error instead of a
  guessed BPM.
- **Music Library / track picker** — the audio already in your Media
  Library (MP3/WAV/M4A/OGG/FLAC, ≤200 MB). Every track is labelled
  **"Licensed or user-provided music only"**; the app never downloads
  stock or copyrighted music and never generates music itself (generation
  is Phase 7, live with a music provider key). Each track can carry a license/source note ("Licensed from
  Artlist, 2026" / "my own recording").
- **Music Sync Director UI** — pick a video project + an analysed track →
  waveform with beat grid (white ticks), downbeats (cyan), drops (amber)
  and the energy curve (purple); controls for sync mode (Cut on beat /
  Transition on beat / Both), beat divisor (every beat / 2nd / 4th),
  transition type (Fade/Dissolve/Slide/Wipe from Phase 3), beat pulse on
  text (scale/opacity swell at each beat, on/off + strength), audio
  trim/offset, fade in/out, volume, loop-or-trim. **Apply sync** rewrites
  the timeline: cuts the main video track at beat times, inserts the
  chosen transition at beat cuts, adds beat/drop markers and the music
  clip — and saves the pre-sync timeline as a project version, so Undo in
  the editor (or Remove sync) goes back. Then render through the existing
  Phase 3 queue: a real MP4 with the music mixed in (atempo/volume/afade
  via FFmpeg), ffprobe-validated.
- **Beat-snap in the Video Editor** — a synced project shows a beat ruler
  under the timeline (cyan ticks, amber downbeats, orange drops) and a
  "♪ Beat snap" toggle (default ON): clip edges snap to the nearest beat
  within 0.12 s. A "♪ 120 BPM · 16 beats" badge shows the sync in the
  toolbar.
- **How the analysis works (for the curious)** — 1024-point FFT, hop 512,
  spectral flux → onset envelope → fractional-lag autocorrelation for BPM
  → phase search for the beat grid. No machine learning, no provider, no
  key. Octave errors (60 vs 120 BPM) are resolved by grid coverage: the
  fraction of grid points that land on a real onset. Known limit: music
  with off-beat eighth notes as loud as the kick can read one octave fast
  — the UI shows the BPM and the grid so you can see it.
- **Acceptance test B: ✅ PASS** — scene changes/transitions follow
  detected beats: `tests/music.test.js` proves cuts and transitions land
  on real beat times and a synced render carries the mixed music.

### Try Music Sync (exact clicks)

1. `npm start`, open http://localhost:4820, sign up (first account = OWNER).
2. Media Library → upload an MP3 or WAV (any track you own or are licensed to use).
3. Sidebar → **Music Sync Director** → pick the track → **Analyse** (shows BPM, beats, confidence, waveform + beat grid).
4. Pick a video project (make one first in the Video Editor: a 4 s clip + a text clip).
5. Set sync mode (try "Cut on beat + transition"), beat divisor, transition — then **♪ Apply sync to project**.
6. **Open in Video Editor** — the beat ruler is under the timeline, clip edges snap to beats. **Render** in the Export tab or Export Center — the MP4 has the music mixed in.

## What works in the Quiz Narration + Voice upgrade ✅ (v1.5.0, after Phase 5)

- **Narration sequencing — question → options → answer.** Every quiz round is
  spoken in that order: the question during the 2s read phase, the options
  one per slot during the countdown (the voice reads them while the timer
  ticks, like a real quiz video), the answer + explanation during the 2s
  reveal. Visually the same order: the question appears first, the options
  slide in one by one (staggered, default 0.4s apart, all visible before the
  countdown starts), then the answer pops + highlights. One timed plan
  (`buildNarrationPlan` in `src/quiz-model.js`) drives the timeline, the
  phone-frame preview (`POST /api/bulk/quiz/narration-plan`) and the
  narration placement — preview and render can never disagree.
- **Animations, Auto + Manual.** Auto defaults: question fades in, options
  slide in from the left, answer pops, explanation fades. Manual mode
  (Bulk Video → quiz job → Narration & animations) sets each element's
  animation type, delay and duration: `none`, `fade`, `slide-left`,
  `slide-right`, `slide-up`, `slide-down`, `pop` — all real in the FFmpeg
  render (drawtext alpha/x/y/fontsize expressions; pop was verified live on
  FFmpeg 8). Typewriter is NOT possible with drawtext and is never offered.
- **Voices — your own voice + AI voices.** Sidebar → **Voices**. Record a
  few words, upload the audio in the Media Library, create your voice
  profile — it becomes the **default voice on ALL videos**. AI voices
  (OpenAI TTS voices) are also available to pick. One default voice per
  user; switch it any time.
- **Bulk voice option.** When creating a bulk job, pick ONE voice for the
  whole batch (Bulk Video → quiz job → Voice for this batch). A row's
  `VOICE` column (profile name or id) overrides it for that row; otherwise
  the job voice applies, otherwise your default voice. The job report
  (`GET /api/bulk/:id`) shows the batch voice, and the sample response
  reports which voice spoke each row.
- **Recorded narration — works NOW, no key.** Add a `NARRATION_AUDIO`
  column to your quiz sheet with the audio's Media Library id or file name:
  that recording plays from the round start, in the order it was recorded
  (question → options → answer). Proven end-to-end: a quiz row with a
  recorded WAV renders a real MP4 with an audio stream (`tests/narration.test.js`).
- **AI/cloned speech — honest key handling.** Synthesis goes through
  `src/voice.js`: a cloned voice needs an ElevenLabs key, generic AI voices
  need an OpenAI key. With NO key the API refuses with `503 /
  PROVIDER_KEY_NEEDED` and creates no audio file — never a fake voice,
  never a robotic local fallback. With a key, each narration segment is
  synthesised (ElevenLabs multilingual v2 / OpenAI tts-1), cached by
  (provider, voice, text hash) as a Media Library audio row, and mixed into
  the render at its segment time. Cloning uploads the sample to
  ElevenLabs `voices/add` and stores the returned voice id. Honest limit:
  cloning quality depends on the sample — a few words give a rough match,
  a minute of clean speech is much better; the key-configured synthesis
  path is implemented but **not live-verified** (no provider key exists
  yet — it will be verified the day a key is added).

### Try narration + voice (exact clicks)

1. `npm start`, open http://localhost:4820, sign up (first account = OWNER).
2. Media Library → upload a short recording of your voice (MP3/WAV, a few words) + a background image.
3. Sidebar → **Voices** → create "My voice" from your recording → it becomes the default voice.
4. Bulk Video → 🎯 Quiz Video → upload `docs/sample-quiz.csv` → Step 1 Template → **Narration & animations** (try Manual: answer = slide-up) → **Voice for this batch** (pick your voice) → save.
5. Step 2 Data → phone preview → the narration strip shows the spoken order (question → options → answer) with times and animations.
6. Recorded narration: add a `NARRATION_AUDIO` column to your sheet with the recording's media id, then Sample — the MP4 has your voice in it.

## What works in Phase 6 ✅ (v1.6.0 — Long Video to Shorts + Captions)

- **Shorts Studio** — sidebar → **Long Video to Shorts**. Pick a long
  video from the Media Library → set min/max clip length, max clips,
  caption language and render size → **Analyse video & find Shorts**.
  Analysis runs in the background (a 60-minute video takes a few
  minutes); the job polls to `ready`, then the ranked clip gallery
  appears.
- **Real local analysis, no key** — three FFmpeg signals measured from
  the actual file: scene changes (`select='gt(scene,…)'` + metadata
  print), silence (`silencedetect`, speech = "not silent"), and an
  audio-energy curve (file decoded to 8 kHz mono PCM, RMS per 0.5 s in
  Node). Clip candidates are scene-bounded segments merged to the
  requested length (default 15–60 s, configurable) and ranked by an
  **explainable score = 45% speech density + 30% audio energy + 15%
  scene-change rate + 10% position** (earlier is slightly better). Every
  clip shows its score breakdown in the gallery. It measures how much is
  happening in a segment — **it never claims to predict views or
  virality**.
- **Auto-reframe to 9:16** — the crop follows the centre of motion in
  each clip (frame-difference energy sampled at 2 fps), so the active
  region stays visible. Honest limit: no face/subject tracking without
  a vision model (Phase 7) — the UI says so. Outputs 1080×1920 or
  720×1280, h264 + AAC, ffprobe-validated by the render queue.
- **Captions — two honest paths.** (a) **Automatic transcription via a
  provider: live in Phase 7** — with a speech-to-text key configured, the
  Transcribe button calls real Whisper (verbose_json word timestamps) and
  saves the transcript on the job; without a key it refuses with
  `key_needed` (402) and never fakes
  a transcript. (b) **Manual transcript, which works now:** paste plain
  text (lines are spread across the video by character count and
  labelled **estimated timing**), or paste SRT/VTT for **exact timing**.
  The transcript is editable, exportable as SRT/VTT, and burned into
  every render word-by-word (karaoke highlight) via an ASS file + the
  libass `subtitles` filter — so Arabic/Urdu/Hindi shape correctly
  (drawtext cannot shape them). Languages: English, Urdu, Roman Urdu,
  Arabic (proper RTL) and Hindi, with Noto Naskh/Kufi Arabic and Noto
  Sans Devanagari fonts.
- **Clip review gallery** — every candidate shows a midpoint thumbnail,
  timestamps, duration, score + breakdown, and caption status (none /
  ready / no-cues / burned). Approve, reject, or trim start/end before
  rendering; rejected clips are never rendered. Approved clips render
  through the Phase 3 job queue (progress, cancel, retry, Export
  Center), with per-clip MP4 download and a ZIP of all finished Shorts.
- **Acceptance test C: ✅ PASS (with a stated scope)** — a generated
  30 s video with known cuts/silence produces valid, ranked, in-bounds
  clips and a real 1080×1920 render with audio + burned-in captions
  (`tests/shorts.test.js`). A full 60-minute video was not rendered
  end-to-end in tests (that would take very long); the pipeline is the
  same code path, and analysis of long videos runs asynchronously in
  the background.

### Try Shorts (exact clicks)

1. `npm start`, open http://localhost:4820, sign up (first account = OWNER).
2. Media Library → upload a video (any MP4; a 1–2 minute clip is enough to try).
3. Sidebar → **Long Video to Shorts** → pick the video → min 15 s / max 60 s / max 10 clips → **Analyse video & find Shorts** (job polls to ready).
4. Review the gallery: check the score breakdowns, approve 1–2 clips, reject the rest.
5. **Captions:** in the transcript panel pick a language, paste plain text (or SRT/VTT) → **Save transcript** → clips show "Captions ready".
6. **Render** (720p is faster; 1080p for the final) → wait for Done → **Download MP4** or **Download all as ZIP**.
7. Sidebar → **Auto Captions** shows the same jobs with their transcripts and SRT/VTT export.

## What works in Phase 7 ✅ (v1.7.0 — AI Creative Studio)

- **Provider registry** (`src/providers.js`) — one registry for six AI
  kinds: `image` (OpenAI Images + Stability SD3), `video` (Runway Gen-4),
  `llm` (OpenAI Chat), `tts` (OpenAI TTS + ElevenLabs cloning), `stt`
  (OpenAI Whisper), `music` (Replicate MusicGen). Each provider has a
  configurable base URL + model (Settings → AI Providers, or env keys);
  keys are stored encrypted (AES-256-GCM) and never sent to the frontend.
  Status reports per-provider `configured` / `key_needed`; **Test
  connection** makes a minimal real call (list models / balance / account)
  and reports the provider's actual answer — never a fake success. When a
  kind has several providers (image, tts) the active one is selectable.
- **AI Studio** (sidebar → AI Studio) — ten modes: Text to Image, Image to
  Image, Text to Video, Image to Video, AI Voice (TTS with your voice
  profiles), AI Quiz Questions (validated 4-option questions + quiz CSV
  download), AI Design Assist (LLM picks headline/palette/fonts → a NEW
  editable design project, never destructive), AI Transcribe, Music Mood
  Tags, AI Music. Every mode runs as an **async job** (queue, progress,
  cancel, retry, per-job log) and every result is saved to the Media
  Library. Usage is logged per generation (transparent, no payment).
- **Honest key rule, everywhere** — without a configured key every AI mode
  refuses with `key_needed` and creates **no output file**. Nothing is
  faked: no stock/random image is ever called AI-generated.
- **Stubs unlocked through the same provider layer:**
  - **Bulk AI + Prompt-Based backgrounds (Phase 4)** are live: per-row AI
    backgrounds via the image provider, cached by prompt hash (the same
    prompt is never generated — or billed — twice). An AI prompt template
    with `{{FIELD}}` substitution, or a `BACKGROUND_PROMPT` column per row.
    Without a key the batch refuses to start (error names Phase 7).
  - **Narration TTS (v1.5.0)** now calls the real TTS/cloning APIs through
    the registry (base URL configurable — `voice.js` no longer hardcodes
    the provider URLs). Recorded narration still works with no key.
  - **Shorts Transcribe (Phase 6)** now calls real Whisper: word-timed
    cues saved on the job, SRT/VTT export works from them. Without a key
    it still refuses with 402 `PROVIDER_KEY_NEEDED`.
  - **AI Design Studio (Phase 2)** — Generate with AI now works with an
    LLM key (the local rule-based layout helper stays as an alternative).
  - **AI quiz questions** — LLM-generated, validated, CSV-exportable.
  - **AI music generation + mood tagging (Phase 5 limits lifted)** — Replicate
    MusicGen for generation; mood tags use local DSP analysis + the LLM.
- **Tests** — `tests/ai-studio.test.js` (14 tests, port 4838) spins up a
  **local mock provider server** implementing the real provider APIs
  (OpenAI Images/Chat/Whisper/TTS, Runway task polling, Replicate
  prediction polling) and proves end-to-end against it: real PNG/MP4/WAV
  outputs, ffprobe-valid media, quiz validation, design project creation,
  STT → captions, bulk AI backgrounds with cache, cancel + retry,
  per-user isolation, anonymous 401, and the no-key refusal for all ten
  modes. **All 111 tests pass (97 earlier + 14 new).**

### Try AI Studio (exact clicks)

1. `npm start`, open http://localhost:4820, sign up (first account = OWNER).
2. **Add a key:** Settings → AI Providers → pick a provider (e.g. LLM —
   OpenAI Chat) → **Add key** → paste the key (stored encrypted). Press
   **Test connection** — it must say "Connection OK".
3. Sidebar → **AI Studio** → **Text to Image** → prompt
   "A golden retriever puppy in a sunflower field at sunset" → **Generate**
   → the image appears in the Result panel and in the Media Library.
4. **AI Quiz Questions** → topic "Pakistan geography", 5 questions →
   Generate → the questions table appears → **Download quiz CSV** → import
   it into a Bulk Video job.
5. **AI Voice** → pick a voice profile (create one in Voices first) → text
   → Generate → the audio plays in the Result panel.
6. **Without a key:** remove the key (Settings → Remove) and Generate in
   any mode — the job fails with "no API key" and no file is created.
   (The full no-key path is covered by the mock-provider tests; no real
   key is ever needed to verify the wiring.)

## What works in Phase 8 ✅ (v1.8.0 — Social & Business Tools)

- **Social Media Studio** (sidebar → Social Media Creator) — compose posts
  (text + attach designs/videos from the Media Library), per-platform
  character guidance with the real limits (X 280, Facebook 63,206,
  Instagram 2,200, TikTok 2,200, YouTube 5,000, LinkedIn 3,000 — over-limit
  text is refused, never silently cut), save as draft, schedule, content
  calendar (sidebar → Content Calendar, month view with per-day posts).
  **AI caption + hashtags** via the Phase 7 LLM provider (1 credit; honest
  402 `PROVIDER_KEY_NEEDED` without an LLM key) plus a clearly-labelled
  **local template caption helper** (never presented as AI) and local
  hashtag extraction from the post text.
- **Publishing — official APIs only, never faked.** A post is published
  only through the platform's real API (Facebook Graph `/me/feed`, X API v2
  `/tweets`, LinkedIn `ugcPosts`, Instagram Graph media container +
  publish, YouTube multipart upload) and only when that platform is
  connected (OAuth access token stored encrypted, AES-256-GCM, never
  returned). No platform is connected on a fresh install, so Publish
  refuses with honest `NOT_CONNECTED`. A scheduled post that cannot publish
  (not connected, provider rejection, video-only platform given text-only)
  becomes `failed` with the real error — never silently "published". A post
  can also be marked **posted manually elsewhere** with a note + link; that
  status is `manual` and carries no provider id. A background scheduler
  (server-side, every 15 s, plus a manual "Run scheduler now" button)
  publishes due posts.
- **Google Sheets import** (Bulk Video → Data → Google Sheets…) — real
  Google OAuth (Client ID + Secret in Settings → Google Sheets, secret
  encrypted; read-only scopes `spreadsheets.readonly` + `drive.readonly`),
  list spreadsheets → pick a tab → import rows into a bulk job with the
  SAME dedupe/mapping/validation as a CSV upload. Without OAuth configured
  the UI says so honestly and the old "export as XLSX/CSV" path still works.
- **Billing & credits** (sidebar → Subscription & Credits) — plans
  Free/Starter/Pro/Business/Enterprise with a transparent per-user ledger:
  every AI generation / render / bulk row deducts credits (see the Credit
  costs table in the app) and every charge is a usage-log entry; balance 0
  blocks the action up front with a clear message. **No payment gateway
  exists: no payment is taken in this build.** Plan upgrades are requests
  the OWNER approves in Admin — the plan changes and credits top up only
  then. The UI says this plainly everywhere.
- **Admin panel** (sidebar → Admin, OWNER/ADMIN only; regular users get
  403) — user list with search, role change (OWNER-only), suspend /
  unsuspend (a suspended user is signed out immediately and cannot log in),
  credit reset, delete (OWNER-only, with confirmation), platform stats
  (real DB counts), per-user usage detail, plan-request approval, audit log
  view, system health (FFmpeg version, disk, DB size, uptime). Every admin
  action is written to the audit log.
- **Templates Marketplace** (sidebar → Templates Marketplace) — **in-app
  only** (no external store): publish a design/video project as a template
  (content snapshotted, so it stays installable even if the original is
  deleted), browse/search, install (creates a real editable project, never
  a flattened image), rate 1–5, report. The UI says plainly that this is
  the local marketplace of this install.
- **Analytics** (sidebar → Analytics) — real numbers counted from this
  install's own DB only: renders over time, AI generations by mode, posts
  by status/platform, storage used, top templates, credit burn. No invented
  benchmarks, no "industry average" comparisons.
- **Tests** — `tests/social.test.js` (16 tests, port 4839) spins up a local
  **mock server** speaking the real shapes of the Facebook Graph API, X
  API v2, OpenAI Chat and the Google OAuth/Drive/Sheets APIs, and proves
  end-to-end against it: post CRUD + char limits, publish refusal when
  unconnected, scheduler publishing via the mock (real provider ids),
  mark-manual, AI caption refusal + charged caption, credit ledger
  (charge, history, zero-balance block), bulk start credit gate, Google
  Sheets import with dedupe, plan request + OWNER approval, admin RBAC +
  suspend/unsuspend, marketplace publish/install/rate, analytics numbers
  matching seeded rows. **All 127 tests pass (111 earlier + 16 new).**

### Try Phase 8 (exact clicks)

1. `npm start`, open http://localhost:4820, sign up (first account = OWNER).
2. **Social Studio:** sidebar → Social Media Creator → type a post →
   **AI caption** (needs an LLM key in Settings → AI Providers; without one
   it refuses with "no API key") or **Local caption ideas** → **Save draft**
   → the post appears in the list below.
3. **Connect a platform:** in the Connections card → **Connect** → paste an
   access token (stored encrypted) → **Publish now** on a draft — with a
   real token the post goes live through the platform's API; without a
   connection it refuses with "not connected".
4. **Schedule:** set a date/time → **Schedule** → sidebar → Content
   Calendar → the post sits on its day; **Run scheduler now** publishes due
   posts (or wait — the server runs it every 15 s).
5. **Google Sheets:** Settings → Google Sheets → save Client ID + Secret
   (OWNER/ADMIN) → **Connect Google** → authorise → Bulk Video → open a
   job → Data → **Google Sheets…** → pick spreadsheet + tab → rows import
   with dedupe.
6. **Billing:** sidebar → Subscription & Credits → **Request Pro** → as
   OWNER, sidebar → Admin → Plan requests → **Approve** → the user is on
   Pro with 5,000 credits. Note the "No payment is taken in this build"
   line — there is no checkout anywhere.
7. **Marketplace:** create a design (Graphic Editor) → Templates
   Marketplace → Publish a template → pick your project → **Publish** →
   **Install** → a real editable copy opens as a new project.

## What honestly does NOT work yet ❌

- **No live AI without a key.** All providers report `key_needed` until a
  key is added in Settings → AI Providers. With a key, live AI calls work
  as described in Phase 7 above — verified end-to-end against a local mock
  provider in tests, not against the real providers (no real key exists in
  this build, so a real-provider call has not been run yet). The app never
  fakes AI output. Text curvature is not implemented — no fake curve
  control is shown.
- **AI background modes need a key.** AI Generated and Prompt-Based
  backgrounds are live (Phase 7) but refuse to start a batch without an
  image provider key — the app never generates a fake/stock image and calls
  it AI. Without a key there is no silent fallback.
- **No Google Sheets writing.** The Sheets integration is read-only by
  design (read-only OAuth scopes) — rows are imported, never written back.
- **TikTok video upload is not finished.** The upload is initialised
  against TikTok's API (publish id received) but chunk upload is not
  implemented yet, so a TikTok video post fails honestly with that reason
  instead of being marked published. Instagram publishing needs a public
  media URL (`publicBaseUrl` on the connection) because Instagram fetches
  the media itself. YouTube uploads as unlisted by default.
- **A vs B quiz format is not built yet** (Multiple Choice + True/False
  only). AI voiceover needs a provider key and has not been live-verified
  against a real provider yet (mock-verified only) — without a key it
  refuses honestly.
- **No face/subject tracking for the 9:16 reframe** (motion-centroid crop
  only; a vision model would be needed). Social publishing works only for
  connected platforms through their official APIs (see Phase 8); there is
  no auto-posting to unconnected platforms and no payment gateway.
- **No chroma key / green screen, stabilization, AI object removal, proxy
  editing, speed-ramping curves or motion paths** — the Effects view lists
  these as not yet built. Only one overlay (PiP) video track is supported
  in Phase 3 (main + one overlay); a third video track is rejected with a
  clear error. 4K output is not offered (720p/1080p only).
- Beat detection is energy/onset-based, so it is less reliable on ambient,
  classical or vocal-only audio: a low confidence score shows a warning,
  and a track with no detectable beats is refused rather than given a
  guessed BPM. No virality prediction, no "perfect sync" claim. One music
  track + the video's own audio only — multi-track audio mixing is out of
  scope.
- Templates Marketplace is in-app only (design/video project templates;
  bulk-job templates are not publishable yet) — there is no external store.
- Plan changes are requests approved by the OWNER in Admin; **no payment
  is taken in this build** — there is no payment gateway and no checkout.

## Requirements

- Node.js ≥ 18 (tested on Node 24), npm
- FFmpeg **required** from Phase 3 (rendering engine + media probing) —
  check with `ffmpeg -version` (tested on FFmpeg 8.1.2 with libx264,
  drawtext, xfade, geq, scdet/silencedetect and the libass `subtitles`
  filter for caption burn-in). DejaVu fonts are used for rendered text
  (`/usr/share/fonts/truetype/dejavu/`); Arabic/Urdu captions use Noto
  Naskh/Kufi Arabic and Hindi uses Noto Sans Devanagari.

## Install & run

```bash
cd creative-studio-ai-pro
npm install
cp .env.example .env   # optional; defaults work out of the box
npm start              # or: npm run dev
```

Open **http://localhost:4820** — sign up; the first account is the OWNER.

Configuration (`.env`, see `.env.example`): `PORT` (default 4820),
`HOST` (default 127.0.0.1), `DB_PATH`, `UPLOADS_DIR`, `MAX_UPLOAD_MB`
(default 200), `RENDER_CONCURRENCY` (default 1 — simultaneous FFmpeg
renders), `APP_ENCRYPTION_KEY` (hex 32 bytes; if unset, a key is
generated once and saved to `data/.app-key` — do not delete it or stored
provider keys become unreadable), provider keys (`OPENAI_API_KEY`, etc. —
leave blank until Phase 7; keys can also be saved from Settings).

## Try the Video Editor (quick test)

1. Start the app and sign up (first account = OWNER).
2. **Media Library** → upload a video (any MP4). Wait a few seconds — its
   duration, resolution, fps and thumbnail appear (ffprobe).
3. **Video Editor** → pick an aspect ratio → **Create video**.
4. Left panel → click the video to add it at the playhead. Add a second
   clip, select it and set a **Transition → Fade** in the right panel.
   Add a **Text** clip for a title.
5. Right panel → **Export** tab → pick 720p / 30fps → **Render video**.
   Progress is real (from FFmpeg). When done, **Download MP4** — it plays
   in any player. Finished renders also appear in the **Export Center**.

## Tests

```bash
npm test
```

Runs the Node test suite: `tests/api.test.js` (Phase 1: signup/login, RBAC,
project CRUD + versions + trash, per-user isolation, media upload/search/
favourite/delete, upload rejection, provider key handling, subscription,
notifications and logout), `tests/design.test.js` (Phase 2: design-model
validation, built-in templates as real editable designs, template save/get/
delete + isolation, Brand Kit CRUD + validation + logo ownership, design
project round-trip — save, reopen, byte-identical layers — and editor
frontend assets), `tests/video.test.js` (Phase 3: timeline-model
validation, split/trim/ripple math, keyframe interpolation, video API auth
+ effects list, media probe + thumbnail, a **real end-to-end FFmpeg render**
of generated test videos — 2 clips + fade transition + keyframed clip +
text overlay — validated with ffprobe for duration/resolution/fps/codec/
audio, render cancel + retry, per-user job isolation, Export Center list
and save-to-library) and `tests/bulk.test.js` (Phase 4: whole-row +
key-column dedupe — 6 rows with 2 duplicates → 4 unique outputs, skipped
rows never rendered or retried; real XLSX + CSV parsing; mapping
validation; background no-repeat + pool exhaustion + after-N + honest AI
refusal; template substitution + fit; quiz auto-fit + uniform fonts +
overflow proof (200+ char question, 80+ char options); research-spec
layout (stacked options, safe box, caps, RTL, score card); end-to-end
small batches — 4 real MP4s via FFmpeg, ffprobe-validated, different
backgrounds, hashes differ — plus ZIP contents, failed-row retry, bulk
design PNGs, per-user isolation, and the viewer quality gate on a real
render thumbnail) and `tests/music.test.js` (Phase 5: pure sync-engine
tests — cuts/transitions/pulse/markers/strip + option validation; **real
DSP analysis on FFmpeg-generated audio with known tempos** — 120 BPM MP3
click track (±2 BPM, beats ±60 ms), 90 BPM WAV click track (±2 BPM, beats
±60 ms), music-like 100 BPM tone bursts (±3 BPM), a flat drone that is
refused instead of guessed; analysis caching; per-user isolation +
anonymous 401; license notes; apply-sync cuts/transitions on real beat
times; and a real end-to-end render of a cut-synced timeline with a 3 s
track looped over a 4 s silent video — ffprobe-validated, audio stream
present, RMS above the silence floor) and `tests/narration.test.js`
(post-Phase-5 quiz upgrade: narration plan timing — question → options →
answer, staggered; auto defaults vs manual animation overrides on the real
timeline; voice profile CRUD + default switching + per-user isolation;
TTS refusing honestly without a key (no audio file created); bulk voice —
job voice on all rows, per-row VOICE override wins; and an end-to-end
recorded-narration render — a quiz row with a recorded WAV renders a real
MP4 with an audio stream, ffprobe-validated) and `tests/shorts.test.js`
(Phase 6: **real local analysis on an FFmpeg-generated video with known
structure** — scene cuts at 10s/20s found within ±0.6 s, silence windows
8–12s/20–24s within ±0.7 s, energy curve high on tone and ~zero in
silence; deterministic, explainable ranking — breakdown sums to the
score; motion centroid lands on the moving half of a split-motion
video; caption SRT parse + export round-trip, plain-text estimated
timing, word timing, ASS karaoke + Arabic font; STT refusing honestly
without a key (402, no transcript created); manual transcript save +
SRT/VTT export; per-user isolation + anonymous 401; and an end-to-end
approved clip rendering a real **1080×1920** MP4 with audio + burned-in
captions — ffprobe-validated — plus clip download, thumbnail and ZIP) and
`tests/ai-studio.test.js` (Phase 7: provider registry, 10 AI modes against
a local mock provider, honest `key_needed` without a key) and
`tests/social.test.js` (Phase 8: social posts + calendar + scheduler,
publishing only via official APIs with `NOT_CONNECTED` when unconnected,
Google Sheets import via a mock Google server, credit ledger, admin RBAC,
marketplace publish/install, analytics) and `tests/acceptance.test.js`
(Phase 9: acceptance A–D — a 10-row bulk run with real MP4s, music-sync
proof, Shorts proof, and a byte-identical design round-trip).
**127 earlier tests + 5 acceptance tests = 132 tests, all passing** (see
below). The full 100-row acceptance run lives outside the suite as
`node scripts/acceptance-a.js` (100 sequential 1s renders take ~2 minutes;
it writes `docs/acceptance-a-report.json`).

## Project layout

```
server.js                 Entry point (Express, serves API + frontend)
src/
  config.js               .env loading + central config
  db.js                   SQLite schema + all data access
  auth.js                 scrypt hashing, sessions, RBAC middleware
  crypto-util.js          AES-256-GCM for provider keys at rest
  ffmpeg.js               FFmpeg detection + ffprobe probing, thumbnails,
                          output validation (Phase 3)
  providers.js            Provider registry: 8 providers across 6 AI kinds
                          (image/video/llm/tts/stt/music) with configurable
                          base URL + model, encrypted keys, Test connection
                          (Phase 7, live)
  video-model.js          Timeline JSON schema, validation, split/trim/
                          ripple/keyframe math, aspects, transitions (Phase 3)
  render.js               FFmpeg render engine: filter-graph builder, job
                          queue/worker, real progress, cancel/retry,
                          ffprobe validation, cleanup (Phase 3)
  bulk-model.js           Bulk pure functions: placeholder scan/substitution,
                          background assignment, dedupe, fit (Phase 4)
  bulk.js                 Bulk runner: job advance, quiz build, batch
                          uniform fonts, fit-check, ZIP, retry (Phase 4)
  quiz-model.js           Quiz Video preset: parse/fit/layout/timeline,
                          research-spec defaults, caps, RTL (Phase 4)
  design-render.js        Server-side design → PNG/JPG via FFmpeg (Phase 4)
  design-model.js         Design JSON schema, sizes, fonts, validation (Phase 2)
  design-templates.js     8 built-in starter templates as editable designs (Phase 2)
  ai.js                   AI clients (image/video/LLM/STT/music), AI job
                          runner (queue, cancel, retry), AI backgrounds
                          with prompt-hash cache (Phase 7)
  routes/
    ai.js                 AI Studio API: provider status, AI jobs
                          create/poll/cancel/retry/delete (Phase 7)
    auth.js               signup/login/logout/me/change-password
    projects.js           projects + folders + versions
    media.js              uploads, streaming, tags, folders, probe + thumbnails (Phase 3)
    design.js             sizes/fonts, design validation, templates, Brand Kit (Phase 2)
    video.js              effects list, timeline validation, render jobs:
                          create/cancel/retry/delete/download/log/save-to-library (Phase 3)
    bulk.js               bulk jobs: dataset import, mapping, backgrounds,
                          fit-check, sample/start/cancel/retry, ZIP,
                          template bindings, quiz fit/layout (Phase 4)
    system.js             dashboard, notifications, jobs, settings,
                          providers, subscription, admin users
    plans.js              plan definitions (single source of truth)
public/
  index.html  styles.css  app.js    Vanilla-JS SPA, dark premium theme
  editor.js   editor.css  Graphic Editor: DOM editing + canvas export renderer (Phase 2)
  video-editor.js  video-editor.css  Video Editor: timeline, preview player,
                          clip properties, keyframes, export (Phase 3)
  bulk.js  bulk.css       Bulk Video / Bulk Design / Template Builder UI:
                          4-step wizard, phone-frame quiz preview (Phase 4)
tests/api.test.js         End-to-end API tests (Phase 1, node:test)
tests/ai-studio.test.js   Mock-provider AI tests: all 10 modes, no-key
                          refusal, cancel/retry, isolation (Phase 7)
tests/design.test.js      Design model, templates, Brand Kit, round-trip, editor assets (Phase 2)
tests/video.test.js       Timeline model, video API, probe/thumbnail, real FFmpeg
                          render + cancel/retry/isolation (Phase 3)
tests/bulk.test.js        Dedupe, XLSX/CSV, backgrounds, substitution, fit,
                          quiz spec + e2e batches + ZIP + quality gate (Phase 4)
tests/music.test.js       Real DSP BPM/beat analysis, caching, isolation,
                          apply-sync + e2e render with mixed music (Phase 5)
docs/MASTER_PROMPT.md     Full-spec summary
docs/sample-bulk.csv      Try-it bulk data: 6 rows, 1 duplicate → 5 videos (Phase 4)
docs/sample-quiz.csv      Try-it quiz data: 5 questions, last one over the caps (Phase 4)
data/                     SQLite DB + generated app key (gitignored)
uploads/                  User media files (gitignored)
renders/                  Finished MP4s + render logs, per user (gitignored)
```

## Tech notes (Phase 1 choices)

- **SQLite via `better-sqlite3`** (native module — builds cleanly on Node 24)
  instead of PostgreSQL/Redis: local-first, zero setup; the data layer in
  `src/db.js` is isolated so it can be swapped in a later phase. Phase 2 adds
  `brands` and `design_templates` tables.
- **Vanilla JS frontend, no build step**, served by the same Express server;
  Tailwind CDN was considered but plain CSS keeps Phase 1 deterministic and
  offline-friendly. A React/Next.js migration is a Phase 2+ decision.
- Sessions are opaque tokens in the DB (not JWT) so logout truly invalidates.
- **Timeline model is validated on the server** (`src/video-model.js`:
  dimensions, fps, track/clip kinds, no overlaps on one track, speed/volume/
  opacity/zoom ranges, transition durations, keyframe bounds). The render
  engine (`src/render.js`) builds the FFmpeg filter graph from the same
  validated timeline: per-clip trim/speed/scale/rotate/flip/eq/unsharp/blur/
  vignette/fade, keyframes (pan via per-frame crop expressions, zoom via
  sampled sub-segments, opacity via per-frame `geq` alpha — verified against
  FFmpeg 8.1.2 before writing, since `crop` w/h and `colorchannelmixer` do
  NOT accept time expressions), `xfade` transitions, `drawtext` overlays
  (via text files, so no escaping bugs), audio `atempo`/`afade`/`adelay` +
  `amix`. Rendered duration accounts for transition overlaps, so audio and
  text stay in sync with the video.

## What works in Phase 9 ✅ (v1.9.0 — Final QA)

- **Acceptance tests A–D, run for real** — see
  [`docs/FEATURE_COMPLETION.md`](docs/FEATURE_COMPLETION.md) §6 for the
  verdicts and evidence:
  - **A — Bulk Video: PASS.** `node scripts/acceptance-a.js` — a real
    100-row `.xlsx` (100 unique rows, 100 distinct backgrounds + logo)
    produced **100/100 videos, 0 failed, 0 skipped**, all backgrounds
    different (no-repeat), all 100 outputs byte-distinct and
    **ffprobe-valid** (h264, 1280×720, ~1s); logo positioned (5/5
    spot-checked) and row text visible (5/5). Report:
    [`docs/acceptance-a-report.json`](docs/acceptance-a-report.json).
    The suite keeps a 10-row version of the same checks in
    `tests/acceptance.test.js`.
  - **B — Music Sync: PASS.** 120 BPM click track analysed at 120 BPM;
    apply-sync cut the timeline at real beat times (0.45/1.45/2.45/3.45s)
    with 4 transitions; a synced render carries audible mixed music
    (audio stream present, RMS above the silence floor).
  - **C — Shorts: PASS (stated scope).** Known-structure 30s video →
    valid ranked in-bounds clips; an approved clip renders a real
    1080×1920 MP4 with audio + burned-in captions, ffprobe-valid. A full
    60-minute video was **not** rendered end-to-end (same pipeline; too
    long for tests) — stated honestly, not claimed.
  - **D — Design round-trip: PASS.** Save → edit → close → reopen is
    byte-for-byte identical (deep-equal against the saved JSON), twice.
- **Feature completion report** —
  [`docs/FEATURE_COMPLETION.md`](docs/FEATURE_COMPLETION.md): every one
  of the 27 sidebar sections and every key module as Implemented / Needs
  credentials / Pending. Not built: Background Remover, Stock Assets, AI
  Assistant (sidebar shows an honest "not yet built" state for each).
- **Docs** — [`docs/INSTALL.md`](docs/INSTALL.md) (fresh install),
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (production notes),
  [`docs/API.md`](docs/API.md) (every route, auth, error codes).
- **QA fixes:** three sidebar blurbs that overclaimed were corrected
  (Animation Studio, Brand Kit, Export Center — see the completion
  report §7), plus test bugs fixed in the acceptance template, dataset
  counts, pixel sampling, and download socket reuse.

## What's next (final redesign)

All 9 phases are complete and verified. The remaining work is the user's
**final redesign rule**: redesign the whole project to the world's best
professional designs — every feature, nothing left out. Provider keys
(Settings → AI Providers), platform connections (Settings → Connections),
and Google OAuth (Settings → Google Sheets) are still needed to make the
AI, publishing, and Sheets features run for real.
