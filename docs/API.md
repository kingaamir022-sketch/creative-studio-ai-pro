# API — CreativeStudio AI Pro (v2.0.0)

Base URL: `http://localhost:4820` (or your `PORT`). All API routes live
under `/api`. JSON unless a route says otherwise (multipart for uploads).

## Auth

- Session auth: an `httpOnly` session cookie, set on signup/login, backed
  by DB sessions. **Logout truly invalidates the session.**
- `POST /api/auth/signup` `{ name, email, password }` → `201 { user }` +
  cookie. The first account on an empty system is `OWNER`; later signups
  are `USER`.
- `POST /api/auth/login` `{ email, password }` → `200 { user }` + cookie.
- `POST /api/auth/logout` → session deleted.
- `GET /api/auth/me` → current user or 401.
- `POST /api/auth/change-password` `{ currentPassword, newPassword }`.
- Every other `/api/*` route requires the cookie (401 without it).
- **Roles:** `OWNER` > `ADMIN` > `USER`. Admin routes require OWNER or
  ADMIN; role changes and user deletion are OWNER-only. Suspended users
  get 403 on login and their sessions are deleted immediately.
- All resources are **per-user**: you can only see / edit / delete your
  own projects, media, jobs, and posts (403 otherwise).

## Conventions

- Success: `2xx` with a JSON body. Errors: `{ error: "message" }` with
  an HTTP status (see below). Validation errors are 400 with a plain
  message; unknown ids are 404; unauthenticated 401; forbidden 403.
- Pagination/listing: list routes return arrays (or `{ items }` where
  noted in the route); there is no cursor pagination in this build.
- File uploads are `multipart/form-data` with field name `file`
  (max 200 MB by default, `MAX_UPLOAD_MB`).
- Downloads are streamed (`Content-Disposition: attachment`).
- Job polling: render/AI/bulk/shorts jobs are polled (`GET .../jobs/:id`)
  — there is no WebSocket in this build.

## Error codes you will actually see

| Status | Meaning |
|--------|---------|
| 400 | Validation failed (bad mapping, bad timeline, bad dates, draft-only action, over a platform char limit, duplicate/oversize file, …). The message says what to fix. |
| 401 | Not logged in (or session expired/deleted). |
| 402 | **Credit block** — the action costs credits and the balance is 0 (or the batch costs more than the balance). Top up via Admin or request a plan. Also used for STT without a key (transcription). |
| 403 | Not your resource, or role not allowed (e.g. regular user on an admin route; suspended account). |
| 404 | Unknown id. |
| 409 | `NOT_CONNECTED` — publishing to a platform with no connection; also used for state conflicts (e.g. acting on a finished job). |
| 402 / `PROVIDER_KEY_NEEDED` | AI mode called without a configured provider key. The body carries `code: "PROVIDER_KEY_NEEDED"` — nothing is generated, no fake output. |

## Health & system

| Route | Notes |
|-------|-------|
| `GET /api/health` | `{ ok, version, phase }` — no auth. |
| `GET /api/dashboard` | Real counts, recent projects/media, system status. |
| `GET /api/notifications` | Current user's notifications. |
| `GET /api/jobs` | Current user's jobs across queues. |
| `GET /api/providers` | Provider registry status (`key_needed` / `configured`, never the key). |
| `POST /api/providers/:id/key` | Save a provider key (encrypted). |
| `DELETE /api/providers/:id/key` | Remove a provider key. |
| `POST /api/providers/:id/config` | Base URL / model for a provider. |
| `POST /api/providers/:id/test` | Test connection (real minimal call). |
| `GET /api/subscription` | Plan + credit balance + usage. |
| `POST /api/subscription/plan` | Request a plan change (OWNER approves; no payment). |
| `GET /api/users`, `PATCH /api/users/:id` | Own profile (admin user management is under `/api/admin`). |

## Projects

| Route | Notes |
|-------|-------|
| `GET /api/projects` | Own projects (folders filter supported). |
| `POST /api/projects` | `{ name, type: design\|video, content }` → `201`. |
| `GET /api/projects/:id` | Full project incl. `content` JSON. |
| `PATCH /api/projects/:id` | `{ content, saveVersion }` — autosave + versions. |
| `POST /api/projects/:id/duplicate` | Copy. |
| `POST /api/projects/:id/trash` / `restore` | Trash / restore. |
| `DELETE /api/projects/:id` | Permanent delete (trashed only). |
| `GET /api/projects/:id/versions` | Latest 20 versions. |
| `POST /api/projects/:id/versions/:versionId/restore` | Restore a version. |
| `GET/POST/DELETE /api/projects/folders…` | Project folders. |

## Collaboration (v2.2.4) — share + comments, read-only

| Route | Notes |
|-------|-------|
| `POST /api/collab/projects/:id/link` | Create (201) or return (200, `alreadyExists: true`) the read-only share link `{ link: { token, url, createdAt } }`. Owner only. |
| `POST /api/collab/projects/:id/link/reveal` | Return the full token to the owner (the shares list masks it). |
| `DELETE /api/collab/projects/:id/link` | Revoke the link. |
| `POST /api/collab/projects/:id/share` | Share with a user by email `{ email }` → 201 (or 200, `alreadyShared: true`). 404 if the email is not a user of this install. |
| `GET /api/collab/projects/:id/shares` | Link + per-user shares. |
| `DELETE /api/collab/projects/:id/share/:userId` | Remove a per-user share. |
| `GET /api/collab/shared-with-me` | Projects shared with you (read-only). |
| `GET /api/collab/projects/:id/view` | Read-only view of a shared project. |
| `POST /api/collab/projects/:id/leave` | Stop accessing a shared project. |
| `GET /api/collab/shared/:token` | Public read-only view (no login) — project name/type/content only, no owner details. |
| `GET /api/collab/projects/:id/comments` | Comment threads with replies. |
| `POST /api/collab/projects/:id/comments` | Add a comment (or a reply with `parentId`). |
| `POST /api/collab/projects/:id/comments/:commentId/resolve` | Resolve / reopen (owner or author). |
| `DELETE /api/collab/projects/:id/comments/:commentId` | Delete (owner or author). |

All shares are read-only; there is **no live co-editing** by design.
Non-owner `PATCH /api/projects/:id` returns 404.

## Media Library

| Route | Notes |
|-------|-------|
| `GET /api/media` | Search/tags/folders/favourites. |
| `POST /api/media/upload` | Multipart `file` → `201 { media }` (ffprobe probe + thumbnail). |
| `GET /api/media/:id/file` | Stream the file. |
| `GET /api/media/:id/thumbnail` | Thumbnail. |
| `PATCH /api/media/:id` | Tags/folder/favourite. |
| `DELETE /api/media/:id` | Deletes the DB row **and** the disk file. |
| `GET/POST/DELETE /api/media/folders…` | Media folders. |

## Design (Graphic Editor)

| Route | Notes |
|-------|-------|
| `GET /api/design/sizes`, `GET /api/design/fonts` | Ready-made sizes (12) and fonts (15). |
| `POST /api/design/validate` | Validate a design JSON. |
| `GET /api/design/templates`, `GET /api/design/templates/:id` | 26 built-in templates (20 design + 3 video + 3 deck), all real editable projects. |
| `POST /api/design/templates`, `DELETE /api/design/templates/:id` | Save/delete a template. |
| `GET/POST/PATCH/DELETE /api/design/brands…` | Brand Kit CRUD. |

Designs are stored as project `content` (see Projects); the editor
exports PNG/JPG (transparent PNG supported) via the Export Center.

## Magic Tools

| Route | Notes |
|-------|-------|
| `GET /api/magic/switch/targets` | The 12 size presets + 14 translate languages. |
| `POST /api/magic/switch` | `{ projectId, targetSizeId, translateTo?, name? }` → `201 { project, sourceProjectId, target, language, translated, report }`. Reflows the design to the target size (never-overflow report, `needsAttention` list) and, when `translateTo` is given, translates its text via the LLM (`{{PLACEHOLDER}}` bindings preserved). Always creates a NEW project; the original is untouched. No LLM key → 402 `PROVIDER_KEY_NEEDED`, nothing created. |

## Stock Assets (v2.2.4)

| Route | Notes |
|-------|-------|
| `GET /api/stock/search?type=image\|audio&q=…&licenseType=…&category=…` | Free stock search via Openverse (key-free). Returns `{ results, note }` — each result has `url`, `thumbnail`, `creator`, `license`, `license_url`, `attribution`, width/height (images) or `duration` (audio). |
| `GET /api/stock/item/:type/:id` | One Openverse item. |
| `POST /api/stock/save` | `{ type, id }` → `201 { media }` (new) or `200 { media, duplicate: true }` (already saved — never a second copy). Downloads the file, ffprobe-probes it, stores it in the Media Library with attribution + license recorded. |

**Honest limit:** Openverse has no video search (images + audio only).
`type=video` is refused with 400 `NO_VIDEO_SEARCH`.

## Video Editor & rendering

| Route | Notes |
|-------|-------|
| `GET /api/video/effects` | Only effects that really exist. |
| `POST /api/video/validate` | Validate a timeline JSON. |
| `GET /api/video/jobs`, `GET /api/video/jobs/:id` | Render jobs + status/progress. |
| `POST /api/video/jobs` | `{ projectId, settings: { resolution: 720p\|1080p, fps: 24\|30\|60 } }` → `201`. Costs credits. |
| `POST /api/video/jobs/:id/cancel` / `retry` | Cancel / retry a job. |
| `DELETE /api/video/jobs/:id` | Delete a job record. |
| `GET /api/video/jobs/:id/download` | Stream the finished MP4. |
| `GET /api/video/jobs/:id/log` | Render log. |
| `POST /api/video/jobs/:id/save-to-library` | Save the output to the Media Library. |

Timelines: at most 2 video tracks (main + one overlay/PiP), audio and
text tracks; clip `kind` must match its track kind. Renders are real
FFmpeg encodes (h264 + AAC MP4), progress parsed from ffmpeg `time=`,
every output ffprobe-validated.

## Bulk Video & Bulk Design

| Route | Notes |
|-------|-------|
| `GET /api/bulk` / `POST /api/bulk` | List / create a bulk job `{ name, kind: video\|design, templateProjectId }`. |
| `GET /api/bulk/:id`, `GET /api/bulk/:id/rows` | Job + per-row status. |
| `POST /api/bulk/:id/dataset` | Multipart file (XLSX/CSV/JSON) or `{ text }` or `{ columns, rows }`. Returns `dedupeSummary { total, unique, skipped, skippedRows }`. |
| `PATCH /api/bulk/:id` | Settings: `fieldMapping`, `dedupe { mode: whole-row\|key, keyColumn }`, `background { mode, poolMediaIds, repeatRule }`, `voice`. |
| `PATCH /api/bulk/:id/rows/:rowId` | Per-row override (e.g. `VOICE`). |
| `POST /api/bulk/:id/assign` | Assign backgrounds per the repeat rule. |
| `POST /api/bulk/:id/fit-check` | Per-row fit report + batch-uniform fonts. |
| `POST /api/bulk/:id/sample` | Render one row as a sample. |
| `POST /api/bulk/:id/start` / `cancel` / `retry` / `retry-row/:rowId` | Run / cancel / retry. Skipped duplicates are never retried. |
| `GET /api/bulk/:id/zip` | ZIP of finished outputs. |
| `GET /api/bulk/:id/rows/:rowId/download` | One row's output. |
| `GET /api/bulk/sheets-info` | Google Sheets status (see Integrations). |
| `POST /api/bulk/quiz/fit`, `/quiz/layout`, `/quiz/narration-plan` | Quiz fit-check, research-spec layout, narration plan. |
| `GET /api/bulk/templates/:projectId/fields` | Template `{{FIELD}}` list. |
| `PATCH /api/bulk/templates/:projectId/bindings` | Column → layer bindings. |

**Dedupe (user rule):** whole-row, normalised (trim + case-insensitive)
by default, or a key column. Duplicates are permanently skipped — only
the first copy is ever generated. Preview + job report show
total/unique/skipped and skipped row numbers.

## Music Sync

| Route | Notes |
|-------|-------|
| `GET /api/music/tracks` | Own audio tracks (+ license note). |
| `POST /api/music/tracks/:id/analyze` | Real local DSP: BPM, beat grid, downbeats, energy, drops, waveform, confidence. Flat audio is refused, never guessed. |
| `GET /api/music/tracks/:id/analysis` | Cached analysis. |
| `PATCH /api/music/tracks/:id/license` | License/source note. |
| `POST /api/music/projects/:projectId/apply-sync` | `{ mediaId, options: { syncMode, beatDivisor, transition, pulse, volume, fitMode } }` — rewrites the timeline on real beat times. |
| `GET /api/music/projects/:projectId/sync` | Current sync report. |
| `POST /api/music/projects/:projectId/remove-sync` | Restore the pre-sync version. |

## Voices

| Route | Notes |
|-------|-------|
| `GET /api/voice/profiles`, `GET /api/voice/default` | Voice profiles + the default (applied to all videos). |
| `POST /api/voice/profiles` | Create a profile (`clone` from a recorded sample, or `ai`). |
| `PATCH /api/voice/profiles/:id`, `DELETE /api/voice/profiles/:id` | Edit / delete. |
| `POST /api/voice/profiles/:id/clone` | Build a voice from a sample. |
| `POST /api/voice/synthesise` | TTS via the provider registry — refuses with `key_needed` without a key. |
| `GET /api/voice/tts-status` | TTS availability. |

Recorded narration works now via the `NARRATION_AUDIO` bulk column
(no key needed).

## Long Video to Shorts & Captions

| Route | Notes |
|-------|-------|
| `GET /api/shorts/videos` | Source videos. |
| `POST /api/shorts/jobs` | `{ mediaId, settings: { minClipSeconds, maxClipSeconds, maxClips }, language }` — starts background analysis. |
| `GET /api/shorts/jobs`, `GET /api/shorts/jobs/:id` | Jobs + ranked clips (score + explainable breakdown). |
| `POST /api/shorts/jobs/:id/transcribe` | STT via provider — 402 `key_needed` without a key. |
| `POST /api/shorts/jobs/:id/transcript` | Save a manual transcript `{ format: srt\|vtt\|text, language, text }`. |
| `GET /api/shorts/jobs/:id/captions.srt` / `.vtt` | Export captions. |
| `PATCH /api/shorts/jobs/:id/clips/:clipId` | Approve / reject / trim a clip. |
| `POST /api/shorts/jobs/:id/render` | Render approved clips (9:16, 1080×1920 / 720×1280). |
| `GET /api/shorts/jobs/:id/zip` | ZIP of rendered clips. |
| `GET /api/shorts/jobs/:id/clips/:clipId/download` / `thumbnail` | Per-clip output / thumbnail. |

Ranking: 45% speech density + 30% energy + 15% scene rate + 10%
position. Never a virality claim.

## AI Studio

| Route | Notes |
|-------|-------|
| `GET /api/ai/status` | Mode availability + key status. |
| `GET /api/ai/jobs`, `GET /api/ai/jobs/:id` | AI jobs. |
| `POST /api/ai/jobs` | `{ mode, ...params }` — params at the TOP level (e.g. `{ mode: 'quiz', topic, count, difficulty, language }`), not nested under `input`. Modes: text-to-image, image-to-image, text-to-video, image-to-video, ai-voice, ai-quiz-questions, ai-design-assist, ai-transcribe, music-mood-tags, ai-music, deck. Costs credits. The quiz result records the model that finally succeeded (`result.model`) — see Retry & fallback below. |
| `POST /api/ai/jobs/:id/cancel` / `retry` | Cancel / retry. |
| `DELETE /api/ai/jobs/:id` | Delete. |

Results are saved to the Media Library. Without the right provider key
the job is refused with `PROVIDER_KEY_NEEDED` and creates no output.

**Retry & fallback (v2.2.4):** transient provider errors (429/502/503/504)
are retried automatically — up to 4 attempts with backoff 2s/5s/10s
(`AI_RETRY_DELAYS_MS` env overrides the delays) — and a model that
returns 404 (retired) or stays overloaded falls back to the next
known-good model before the job fails. Failures are reported as one plain
line (what happened + what to do); raw provider detail goes to the server
log only, never to the user. The same retry + friendly treatment applies
to image, video, STT, TTS and music provider calls.

## AI Assistant (v2.2.4)

| Route | Notes |
|-------|-------|
| `GET /api/assistant/actions` | Actions + LLM provider status (is a key configured?). |
| `POST /api/assistant/:action` | `action` = `summarise` \| `suggest` \| `make-professional` \| `five-versions`; body `{ projectId }`. `summarise`/`suggest` work on any project type; `make-professional` on design + deck; `five-versions` on design only. Every action that changes anything creates a NEW project — the original is never edited in place. Needs an LLM key (402 `PROVIDER_KEY_NEEDED` without one). Costs: 1 credit (`ai_write`) for summarise/suggest, 2 (`ai_design`) per created project. Unknown action → 400. |

## Social Media Studio

| Route | Notes |
|-------|-------|
| `GET /api/social/platforms` | Platforms + real char limits. |
| `GET /api/social/connections` | Connected platforms (tokens never returned). |
| `POST /api/social/connections` | Connect a platform `{ platform, token, ... }` (encrypted). |
| `DELETE /api/social/connections/:platform` | Disconnect. |
| `POST /api/social/posts` | Create a draft `{ text, platforms, mediaIds, scheduledAt }`. Over-limit text is refused, never silently cut. |
| `GET /api/social/posts`, `GET /api/social/posts/:id` | List / one post. |
| `PATCH /api/social/posts/:id`, `DELETE /api/social/posts/:id` | Edit / delete a draft. |
| `POST /api/social/posts/:id/publish` | Publish now via the official API — 409 `NOT_CONNECTED` without a connection. |
| `POST /api/social/posts/:id/mark-manual` | Mark as posted manually elsewhere `{ note, link }`. |
| `GET /api/social/calendar` | Scheduled posts by month. |
| `POST /api/social/caption` | AI caption (LLM, 1 credit, `key_needed` without a key). |
| `POST /api/social/caption-local` | Clearly-labelled local template captions. |
| `POST /api/social/hashtags` | Local hashtag suggestions. |
| `POST /api/social/scheduler/run` | Run the scheduler now (also runs every 15 s). |

## Google Sheets (Integrations)

| Route | Notes |
|-------|-------|
| `GET /api/integrations/google/status` | OAuth status. |
| `POST /api/integrations/google/config` | Save Client ID + Secret (secret encrypted). |
| `GET /api/integrations/google/auth-url` | OAuth authorisation URL. |
| `GET /api/integrations/google/callback` | OAuth callback (read-only scopes). |
| `DELETE /api/integrations/google/connection` | Disconnect. |
| `GET /api/integrations/google/spreadsheets` | List spreadsheets. |
| `GET /api/integrations/google/spreadsheets/:id/tabs` | Tabs in a spreadsheet. |
| `GET /api/integrations/google/spreadsheets/:id/values` | Tab values. |
| `POST /api/integrations/google/import` | Import a tab into a bulk job (same dedupe as CSV). |

Sheets access is read-only by design — rows are imported, never written
back.

## Billing & credits

| Route | Notes |
|-------|-------|
| `GET /api/billing/plans` | Plans + credit costs. |
| `GET /api/billing/balance` | Current balance. |
| `GET /api/billing/history` | Transparent credit ledger. |
| `POST /api/billing/requests` | Request a plan change. |
| `GET /api/billing/requests` | Own requests. |
| `GET /api/billing/admin/requests` | All requests (OWNER/ADMIN). |
| `POST /api/billing/admin/requests/:id/approve` / `reject` | Approve (plan + credits applied) / reject. |

Costs: AI generation, renders, and bulk rows deduct credits; a 0
balance blocks with 402. **No payment is taken anywhere.**

## Admin panel (OWNER/ADMIN only)

| Route | Notes |
|-------|-------|
| `GET /api/admin/users` | Users + search. |
| `GET /api/admin/users/:id` | One user. |
| `PATCH /api/admin/users/:id/role` | Change role (OWNER-only). |
| `POST /api/admin/users/:id/suspend` / `unsuspend` | Suspend kills sessions immediately. |
| `POST /api/admin/users/:id/reset-credits` | Set a credit balance. |
| `DELETE /api/admin/users/:id` | Delete a user (OWNER-only). |
| `GET /api/admin/stats` | Platform stats (real DB counts). |
| `GET /api/admin/users/:id/usage` | Per-user usage detail. |
| `GET /api/admin/audit` | Append-only audit log. |
| `GET /api/admin/health` | FFmpeg, disk, DB, uptime. |

## Templates Marketplace

| Route | Notes |
|-------|-------|
| `GET /api/marketplace` | Browse/search published templates. |
| `GET /api/marketplace/builtin` | The 26 built-in templates (search/category/kind filter; `{ templates, categories, counts: { design, video, deck }, note }`). |
| `POST /api/marketplace/builtin/:id/install` | Install a built-in → a real editable project of the matching type. |
| `GET /api/marketplace/:id` | One template. |
| `POST /api/marketplace` | Publish one of your design/video/deck projects (requires `name`). |
| `GET /api/marketplace/mine/all` | Your published templates. |
| `POST /api/marketplace/:id/install` | Install → a real editable project copy. |
| `POST /api/marketplace/:id/rate` | Rate 1–5. |
| `POST /api/marketplace/:id/report` | Report a template. |
| `DELETE /api/marketplace/:id` | Remove your listing. |

In-app only — there is no external store. Bulk-job templates are not
publishable.

## Analytics

| Route | Notes |
|-------|-------|
| `GET /api/analytics` | Renders over time, AI generations by mode, posts by status/platform, storage, top templates, credit burn — DB numbers only. |
