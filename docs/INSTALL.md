# Install — CreativeStudio AI Pro (v2.0.0)

Local-first install. No cloud account, no build step, no database server
needed. Everything runs on your own machine.

## Requirements

- **Node.js ≥ 18** (tested on Node 24) + npm
- **FFmpeg — required** from Phase 3 onward (rendering engine, media
  probing, thumbnails, audio analysis, captions). Check with:

  ```bash
  ffmpeg -version   # tested on FFmpeg 8.1.2 (libx264, drawtext, xfade, geq,
                    # scdet/silencedetect, libass `subtitles` filter)
  ffprobe -version
  ```

  Without FFmpeg the server starts but every render, probe, and analysis
  fails with a clear error.
- **Fonts for rendered text** — DejaVu (`/usr/share/fonts/truetype/dejavu/`)
  for Latin text; Arabic/Urdu captions use Noto Naskh / Noto Kufi Arabic;
  Hindi uses Noto Sans Devanagari. If no usable system font is found,
  renders fail with "No usable system font found" — install
  `fonts-dejavu` (and the Noto fonts for those scripts).
- Disk space: renders and uploads live under the project folder by
  default; a 100-row bulk job of 1s 720p clips is only a few MB, but
  long 1080p renders add up — keep a few GB free.

## Install & run

```bash
cd creative-studio-ai-pro
npm install
cp .env.example .env   # optional; the defaults work out of the box
npm start              # or: npm run dev
```

Open **http://localhost:4820** — sign up. **The first account is the
OWNER** (full access, including the Admin panel). Later signups are regular
users.

## Configuration (`.env`, see `.env.example`)

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `4820` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address — loopback only by default |
| `DB_PATH` | `./data/creative-studio.db` | SQLite file |
| `UPLOADS_DIR` | `./uploads` | Uploaded media on disk |
| `RENDERS_DIR` | `./renders` | Render outputs on disk |
| `MAX_UPLOAD_MB` | `200` | Per-file upload limit |
| `RENDER_CONCURRENCY` | `1` | Simultaneous FFmpeg renders |
| `APP_ENCRYPTION_KEY` | *(generated)* | Hex 32 bytes for AES-256-GCM provider keys. If unset, a random key is generated once and saved to `data/.app-key`. **Do not delete that file** or stored provider keys become unreadable. |
| `OPENAI_API_KEY` etc. | *(blank)* | Optional. Keys can also be saved per-installation from Settings → AI Providers (stored encrypted). **Never put real keys in frontend code, and never share them in chat.** |

## First-run checklist

1. `npm start` prints the URL, DB path, and uploads dir. If FFmpeg is
   missing you will see a warning at startup.
2. Sign up (first account = OWNER).
3. Dashboard → System status should show FFmpeg detected and storage
   usage.
4. Try a render: Video Editor → open the sample flow, or run the test
   suite (`npm test`, ~4 minutes, 132 tests) to prove the whole install.
5. AI features need keys: Settings → AI Providers. Without a key every AI
   mode refuses with `key_needed` — that is the honest state, not an error.
6. Social publishing needs a connected platform: Settings → Connections.
   Without one, Publish refuses with `NOT_CONNECTED`.
7. Google Sheets import needs Google OAuth: Settings → Google Sheets
   (Client ID + Secret, read-only scopes).

## Tests

```bash
npm test          # full suite: 132 tests, all passing (v2.0.0)
```

Each test file spawns the real server on its own scratch port with a temp
DB/uploads dir and cleans up afterwards. **Never run two `npm test` runs
at once** — a stale test server on a port makes other tests fail with
signup 409 errors. If a run is interrupted, check ports 4831–4840 are
clear (`ss -ltn | grep 483`) and kill leftover `node` processes before
re-running.

Acceptance test A at full scale (100-row Excel → 100 videos) is a script,
not part of the suite (100 sequential renders take ~2 minutes):

```bash
node scripts/acceptance-a.js   # writes docs/acceptance-a-report.json
```

## Troubleshooting

- **Port already in use** — another server (or a leftover test server) is
  on 4820. Stop it, or set `PORT` in `.env`.
- **Renders fail with "ffmpeg not found"** — install FFmpeg and restart.
- **"No usable system font found"** — install DejaVu fonts (see above).
- **Login fails after moving `data/`** — sessions live in the DB; moving
  the DB moves the accounts. Deleting `data/.app-key` makes stored
  provider keys unreadable (they stay encrypted with the lost key).
- **Upload rejected** — check the file type (image/video/audio) and the
  200 MB default limit (`MAX_UPLOAD_MB`).
- **AI mode says `key_needed`** — add the provider key in Settings → AI
  Providers. This is expected, not a bug.
- **Publish says `NOT_CONNECTED`** — connect the platform first
  (Settings → Connections). Nothing is ever "published" without a real
  platform API call.
- **0-credit block (402)** — the account's credit balance is empty. An
  OWNER can reset credits in Admin → Users, or approve a plan request.
