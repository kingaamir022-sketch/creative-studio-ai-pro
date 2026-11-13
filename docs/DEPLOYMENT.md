# Deployment — CreativeStudio AI Pro (v2.0.0)

This app is a single Node.js process (Express + SQLite) with no build
step. There is no separate "production build" — the same source runs in
development and in production. These notes cover running it as a real
service.

## What runs in production

- **One process:** `npm start` → `server.js` (Express 5, serves the API
  and the static frontend on one port).
- **One SQLite file** (`DB_PATH`, default `./data/creative-studio.db`).
  SQLite is fine for a single-server install; for multi-user / high
  concurrency, migrating to PostgreSQL is still pending (see
  `docs/FEATURE_COMPLETION.md`).
- **Disk folders:** `UPLOADS_DIR` (user media) and `RENDERS_DIR` (render
  outputs). Both must be writable by the process user and backed up
  together with the DB — a render output referenced in the DB is useless
  if its file is gone.
- **FFmpeg** must be installed on the host (same requirement as local
  install). Renders are CPU-bound; `RENDER_CONCURRENCY` (default 1)
  caps simultaneous FFmpeg jobs. Raise it only if the host has spare
  CPU — each render is a full FFmpeg encode.

## Environment

Copy `.env.example` to `.env` and set at minimum:

- `PORT` (default 4820), `HOST` — bind `127.0.0.1` and put a reverse
  proxy in front (below); do not expose the Node process directly.
- `APP_ENCRYPTION_KEY` — set a fixed hex 32-byte key in production.
  If it changes, every stored provider key becomes unreadable. Keep it
  in the environment / secret manager, **never in the repo, never in
  chat**.
- `DB_PATH`, `UPLOADS_DIR`, `RENDERS_DIR` — point them at persistent
  volumes, not at the release folder, so redeploys do not wipe data.
- `MAX_UPLOAD_MB`, `RENDER_CONCURRENCY` — tune to the host.

No provider keys, platform tokens, or Google OAuth secrets belong in
`.env` on a shared host unless that host's secret handling is trusted —
prefer entering them in Settings → AI Providers / Connections, where
they are stored AES-256-GCM encrypted in the DB.

## Reverse proxy (recommended)

Run behind nginx/Caddy on the same host:

- Proxy `http://127.0.0.1:4820` (or your `PORT`).
- Allow large request bodies (uploads up to `MAX_UPLOAD_MB`, default
  200 MB) and long timeouts — a bulk ZIP download or a big upload can
  take minutes; the default 60s proxy timeout will cut it off.
- Serve over **HTTPS**. HTTPS is required for: PWA install, social
  platform OAuth callbacks, and Google OAuth (Google rejects plain-HTTP
  redirect URIs except loopback). The app itself does not terminate TLS —
  the proxy does.

## Backups

Back up together, while the process is stopped or with SQLite's backup
API — never copy the live `.db` file while a render is writing to it:

1. `data/creative-studio.db` (and `data/.app-key` — without it, stored
   provider keys are unrecoverable).
2. `uploads/` and `renders/` (or your configured dirs).

Restore = put the three back in place and start the server. Accounts,
projects, media records, jobs, credits, and audit logs all live in the
DB; the files on disk are referenced by path.

## Process management

- Run under a supervisor (`systemd`, `pm2`, or similar) with
  `restart: always`. The server logs to stdout/stderr; keep those logs —
  render failures and provider errors are reported there and in each
  job's log (`GET /api/video/jobs/:id/log`).
- Health check: `GET /api/health` returns `{ ok, version, phase }`.
  Admin → System health also reports FFmpeg, disk, and DB status.
- Updates: stop the process, replace the source, `npm install`,
  restart. The SQLite schema is created/migrated by the app on start;
  there is no separate migration step. **Back up before updating.**

## Security notes

- First signup = OWNER. Create that account yourself before opening
  signups to anyone else; later signups are regular users, and role
  elevation is OWNER-only.
- Suspended users cannot log in and their sessions die immediately
  (Admin → Users).
- Uploads are validated by type and size; files are stored outside the
  web root and served only through authenticated routes with ownership
  checks.
- Provider keys and platform tokens are encrypted at rest and never
  returned in full by any API.
- Do not run the process as root. Do not expose the DB file, `.env`, or
  `data/.app-key` over HTTP — the static server only serves `public/`.

## Known production limits

- Single process, single SQLite file — no horizontal scaling in this
  build (no Redis, no object storage, no WebSocket progress — polling).
- Renders are local FFmpeg encodes; there is no render farm or queue
  worker pool beyond `RENDER_CONCURRENCY`.
- No payment gateway: plan changes are OWNER-approved requests.
- Social publishing needs real platform OAuth connections; Google Sheets
  needs real Google OAuth credentials. None are configured by default.
