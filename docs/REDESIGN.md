# Final Redesign — CreativeStudio AI Pro v2.0.0

## Step 1 — Research notes (read 2026-11-13, before any CSS change)

Sources are the public design-system / brand pages found by web search. Nothing
below is a quote invented from memory; values are taken from the search
results listed with their source URLs.

### Figma
- **What we take:** three-tier tokens (primitive → semantic → component);
  semantic tokens only in components, never raw hex; spacing scale on a
  4px grid (0.25 / 0.5 / 0.75 / 1 / 1.5 / 2 / 2.5rem…); type scale as named
  roles (Display / Heading / Body / Mono) with tight negative tracking on
  large sizes; dark mode as a token-mode swap on `:root`, not a second set
  of hardcoded colors; hairline borders instead of heavy shadows; focus
  ring as a visible 2px outline offset from the element.
- **What we do NOT copy:** Figma's pure monochrome chrome. Our brand is
  deep navy/charcoal with purple + blue accents (per the master prompt);
  the accent stays, but it is used sparingly — one accent family for
  interactive/focal elements only.
- Sources: https://www.didot.design/extract/examples/figma,
  https://thefrontkit.com/blogs/figma-design-tokens-guide,
  https://www.design-extractor.com/gallery/figma,
  https://www.mpgmarketingagency.com/blog/figma-design-tokens-architecture-b2b-saas/

### Linear
- **What we take:** dark-mode-native, near-black canvas (`#08090a` /
  `#0f1011` panels) with ONE indigo-violet accent (`#5e6ad2` /
  `#7170ff`) doing all the work; Inter as the single UI face with tight
  letter-spacing (-0.011em body, -0.022em display); compact density —
  4px base unit, 8px element gap, 24px section gap; 240px sidebar with
  13px muted nav items, 6px radius, active = subtle fill; buttons
  28–32px tall, 6px radius, primary = solid accent, secondary =
  transparent + 1px border; hierarchy through scale and weight, never
  through color; dense rows (32px) with hover-only backgrounds, no
  separators; light theme exists but is secondary.
- **What we do NOT copy:** Linear's near-total monochrome (we keep our
  purple/blue/cyan accent family and semantic green/amber/red for status
  only); Linear's 510/590 custom variable weights (system Inter
  fallbacks here — no webfont dependency in this offline-first build).
- Sources: https://github.com/dimabraven/design-md/blob/main/examples/linear.md,
  https://open-design.ai/plugins/design-system-linear-app/,
  https://github.com/corniog/open-codesign/blob/HEAD/apps/desktop/resources/templates/brand-refs/linear/DESIGN.md

### Canva (editor)
- **What we take:** the editor pattern — neutral artboard backdrop with
  the canvas centred, top bar + left tool rail + right inspector, bottom
  tool rail on mobile; heavy colour lives in the *content*, restrained
  neutral chrome around it; contextual toolbars appear only when an
  element is selected (progressive disclosure); panels narrow
  (320px preview cards, 408–480px dialogs); compact 8px spacing;
  rounded controls, 40px circular icon buttons; purple `#8b3dff` /
  blue `#3d8bff` accents; one friendly rounded UI face for chrome,
  content fonts are data, not chrome.
- **What we do NOT copy:** Canva's light-first default and gradient
  FABs; our dark theme stays primary. No gradient text/buttons except
  the existing brand logo mark.
- Sources: https://github.com/lintendo/axhub-make/blob/HEAD/client/src/themes/canva-mobile/DESIGN.md,
  https://github.com/yiben633/fe_skill/blob/HEAD/ai/skills/design-systems/canva-editor-ui-system/SKILL.md

### CapCut / DaVinci Resolve (video editors)
- **What we take:** the four-pane editor — media top-left, preview
  top-right, details/adjustment far right, timeline spanning the
  bottom; dark theme as the native medium for video work (Resolve's
  dark UI with restrained green/blue accents); magnetic/snap timeline
  with a clearly visible playhead; track headers narrow and labelled
  (V1/A1…); timeline clips colour-coded by track kind, never by
  decoration.
- **What we do NOT copy:** CapCut's cloud-first asset rails and
  Resolve's button-dense pro density — our timeline stays the simpler
  two-track model the product actually ships (max 2 video tracks, no
  4K), with the same density as the rest of the app.
- Sources: https://www.redoyou.com.au/reviews/capcut-desktop-w1h8h
  (four-pane layout, dark theme, magnetic timeline).

### Notion / Stripe / Vercel (dashboards)
- **What we take:** sidebar-first navigation (240–280px, collapses to
  64px / hidden on mobile); KPI strip of 4 cards above the fold;
  12-column grid with 24px gutters; tiered surfaces, not shadow spam
  (cards = 1px border, shadows only for floating modals/dropdowns);
  radius scale (inputs/badges 6px, cards 8–12px, modals 12–16px);
  `tabular-nums` on all data; one accent + semantic-only hues (red /
  amber / emerald for status only); every state designed — loading =
  skeleton shaped like the content (not a spinner), empty = icon +
  one sentence + one CTA, error = message + retry; forms with clearly
  defined default/focus/filled/error/disabled states; Light / System /
  Dark theme control in one place (Vercel Geist guidance); progressive
  disclosure (overview first, detail on demand).
- **What we do NOT copy:** Stripe's deep-navy `#0A2540` brand and
  Notion's warm off-white light-first look; our palette stays deep
  navy/charcoal + purple/blue. We also do NOT copy the "purple/indigo
  accent everywhere" anti-pattern — accent is reserved for
  interactive/focal elements.
- Sources: https://artofstyleframe.com/blog/dashboard-design-patterns-web-apps/,
  https://github.com/devamshah/velora-tprm/blob/HEAD/docs/design/premium-ux-research.md,
  https://www.saasui.design/blog/how-to-use-saas-ui-patterns-building-design-system,
  https://github.com/vanszs/anti-ai-ui/blob/HEAD/component-reference-design/references/dashboards.md

## Design decisions for this redesign (from the research above)

- **Tokens:** one file `public/tokens.css` — primitive palette, semantic
  tokens (`--bg`, `--surface`, `--surface-raised`, `--text`, `--text-2`,
  `--text-3`, `--border`, `--border-strong`, `--accent`, `--accent-2`,
  `--cyan`, `--success`, `--warning`, `--danger`, `--info`), type scale
  (12/13/14/16/18/20/24/30px + display), spacing scale (4/8/12/16/24/
  32/48px), radii (6/8/12/16px), shadows (only sm/md/lg for floating).
  Dark theme is the default; light theme is a `[data-theme="light"]`
  token swap, same names.
- **Type:** Inter/system stack everywhere in chrome; tight tracking on
  headings (-0.01em to -0.02em); body 14px/1.5; hierarchy by size and
  weight, never by colour alone.
- **Density:** compact like Linear — 8px element gaps, 24px section
  gaps, 32–40px buttons, 6–8px radii on controls, 12px on cards.
- **Chrome recedes, content shines:** sidebar and panels muted, canvas
  / preview / data get the contrast. Status is never colour-only —
  labels and ✓/✗ stay.
- **States:** skeleton loading, honest empty states with one CTA,
  error + retry — everywhere, including the "not yet built" views,
  which keep their honest copy under the new styling.

## Per-view redesign checklist

(Filled in as the redesign landed — every view ticked, v2.0.0, 2026-11-13.)

- [x] Design tokens (`public/tokens.css`) + theme switch (dark default, light parity) — three-tier tokens, 99 tokens defined, 74 `var()` uses across the 11 stylesheets with zero undefined (static check); theme toggle in the topbar, `localStorage` `cs-theme`, `prefers-color-scheme` on first load, applied before first paint; both themes screenshot-verified.
- [x] App shell: sidebar (all 27 items), topbar, global search, notifications, profile menu — sidebar keeps all 27 items + Live/P-phase pills, now with a subtle accent fill for active (was a gradient); topbar gains ☀️/🌙 theme toggle, hamburger (≤860px), and a profile menu (name/email/role/plan/credits, Settings, Subscription & Credits, Sign out — sign-out moved out of the sidebar foot); search + notifications unchanged in behaviour, re-skinned; logo no longer wraps in the sidebar (15px, nowrap).
- [x] Dashboard (KPI strip, recents, system status, quick actions) — 4 stat cards on tokens with tabular-nums; empty recents now has a "Create your first project" CTA; system status version row fixed to `2.0.0 (Final Redesign)` (was stale `1.2.0`); credits card copy fixed (was "no charges in Phase 1"). Screenshot-verified light + dark.
- [x] Auth screens (login / signup) — card, toggle, inputs, error/success states on tokens; version line now v2.0.0. Screenshot-verified (light).
- [x] Graphic Design Studio (canvas, layers, properties) — chrome tokenised (panels, tabs, layer rows, swatches, status bar); canvas white + transparency checker + guides deliberately unchanged (content); panels stack ≤860px. Picker view screenshot-verified (light); canvas editor itself reuses the same chrome classes.
- [x] Video Editor (timeline, tracks, keyframes, beat ruler) — panels/tabs/props on tokens; clips now solid track-kind colours (accent / accent-2 / warning) instead of gradients; playhead/markers keep danger/warning (semantic); beat ruler ticks on tokens; timeline stacks ≤860px (track heads narrow, ruler full-width). List view screenshot-verified (dark).
- [x] Bulk Video + Bulk Design (template builder, import, jobs, fit reports) — cards/steps/pool chips/badges on tokens; fit-report text on `--text-2`; phone-frame preview + quiz brand colours (navy `#14213D`, amber `#FCA311`, red attention outline) deliberately kept as content. Screenshot-verified (dark + light).
- [x] Quiz (preset + narration + voice) — quiz card + phone preview via bulk.css tokens above; voice segments (`.voice-seg`) tokenised; narration plan strip inherits shared card/badge styling. Preview rendering unchanged.
- [x] AI Music Sync Director (waveform, beat grid) — track cards, form, limits box, waveform frame on tokens; beat/downbeat/drop ticks keep cyan/amber semantics. View screenshot-verified (dark).
- [x] Long Video to Shorts (clip gallery, captions) — clip cards, score bars, trim inputs, transcript area on tokens; clips stack ≤860px. View screenshot-verified (dark, shot 30).
- [x] AI Studio (10 modes, jobs) — mode pills, progress bar (solid accent now, was gradient on light-grey track), job table on tokens.
- [x] Social Media Studio + calendar — calendar days/chips already token-based, verified unchanged; status chips keep label + colour.
- [x] Admin panel — stat numbers now use the `--fs-30` token (`.ad-stat`); tables/badges shared. Screenshot-verified (dark, shot 10).
- [x] Templates Marketplace — grid/cards shared tokens; no marketplace-specific chrome needed.
- [x] Analytics — stat cards + tables shared tokens (same `.ad-stat` token size).
- [x] Subscription & Credits — cards, ledger table, badges shared tokens.
- [x] Settings (incl. AI Providers, Google Sheets) — profile/password/provider/Google Sheets cards, inputs, provider badges on tokens; provider-test result colour now uses `--success`/`--danger` (was an undefined `--ok` var with fallback). Screenshot-verified light + dark.
- [x] Media Library — grid cards, toolbar, empty state (now with "Upload your first files" CTA wired to the file picker). Screenshot-verified (dark, shot 04).
- [x] Projects — list rows, toolbar, trash toggle, empty state on tokens; project detail JSON editor inherits shared input/card styling.
- [x] Export Center — job cards, progress bars (solid accent), log well on `--surface-sunken`.
- [x] "Not yet built" views (honest copy kept, new styling) — placeholder hero on tokens, badge "Phase N — not yet built" kept verbatim. Screenshot-verified (Background Remover, light).
- [x] Empty / loading / error states everywhere — skeleton loading (shimmer shaped like the content) shown while any view loads; view-level error state now has "Try again" (re-renders the view) + "Reload page"; empty states carry one CTA where an action exists (dashboard, media).
- [x] Responsive ≤860px (sidebar collapses, panels stack, no overflow) — sidebar is now an off-canvas drawer behind a hamburger with backdrop (was a 64px icon rail); grids collapse to 1 column; editors/bulk/shorts stack; measured 0px horizontal overflow at 390px and at desktop width. Screenshot-verified (mobile dashboard + open drawer).
- [x] Accessibility pass (contrast, visible focus, no colour-only meaning) — `:focus-visible` 2px accent ring on all interactive elements; light-theme tokens checked for contrast in screenshots (dark text on white cards, warning/danger darkened in light so pills stay readable); status keeps ✓/labels, badges keep label + icon.

## Deliberately left as-is

- No behaviour, copy, feature, or honest "not yet built" state changes
  in this pass — design only. (Two exceptions, both blurbs that had
  become untrue: dashboard version `1.2.0 (Phase 3 — Video Editor)` →
  `2.0.0 (Final Redesign)`, and the AI-credits card "no charges in
  Phase 1" → ledger pointer.)
- No webfont download: the font stack stays Inter/system-ui fallbacks.
  NOTE: the Google Fonts `<link>` in `public/index.html` was KEPT, not
  removed — `tests/design.test.js` asserts it is loaded, and the design
  fonts (Poppins/Montserrat/etc.) are the *content* fonts users pick for
  their designs, not chrome. Chrome itself uses Inter/system-ui only.
- No new dependencies. (Playwright + headless Chromium were used only
  for the verification screenshots in /tmp; nothing was installed into
  the project.)
- Content colours deliberately not tokenised: white design canvas,
  transparency checker, black video stage, phone-frame quiz preview
  (navy/amber quiz brand + red attention outline), editor selection
  handles, and the logo-mark gradient (the one place the brand gradient
  remains).
- The `renders/` directory was already empty; test DB/uploads were kept
  in /tmp and removed after verification.

---

## v2.3.0 — CapCut design pass (2026-11-14)

Design-only release on top of v2.2.4: no new features, no behaviour changes,
no dependency changes. Full detail in `docs/FEATURE_COMPLETION.md` §1d.

- Sidebar regrouped CapCut-style: 35 items in 7 groups — Create · AI Studio ·
  Edit · Bulk & Automation · Library · Publish & Grow · Account. Group
  dividers; every feature under its proper heading, nothing mixed. Only the
  NAV array order changed; all ids, routes, labels and blurbs unchanged.
- Video Editor — CapCut four-pane layout (media top-left, preview right,
  details far right, timeline bottom), full-height wrap, 8-tab left rail in
  CapCut order: Media / Audio / Text / Stickers / Effects / Transitions /
  Captions / Filters. Magnetic timeline (default ON, `🧲 Magnet` toggle);
  Export top-right (`⬆ Export`); 3px playhead with triangle handle.
- Graphic Editor — vertical icon rail (Canvas / Elements / Layers /
  Templates / Media / Brand); Export PNG/JPG already top-right, kept.
- `public/tokens.css` — 13 new CapCut editor tokens, each with dark AND
  light values. Video stage stays black in both themes (content).
- Light-theme parity finished: removed the duplicate `.modal-back`/`.modal`
  rules in `docs-slides.css` that broke the light backdrop, token-based
  chart placeholder, slide-thumb active state and alert colours, and the
  quiz caption contrast fix in `bulk.css`.
- Responsive: rail becomes a horizontal strip ≤860px; timeline and panels
  keep the existing 390px rules; nav items never overflow (ellipsis).
- Honest limits: the Stickers tab is an empty state, not a feature — no
  sticker feature exists. No live-browser screenshot verification in this
  pass (build environment has no browser); verified by the full suite.
- Tests: 5 new v2.3.0 tests in `tests/design.test.js`; full suite 222/222 pass.
