# Auto-Update System (v2.1.0)

CreativeStudio AI Pro updates itself in place — same model as PageCommand
Pro: publish a new version, the app on the PC picks it up and installs it.
No delete/reinstall, no file download by the user.

## How it works

1. **Feed** — a base URL holding two files:
   - `version.json` — the manifest: `{app, version, notes, package,
     packageSha256, publishedAt, fullReinstall?}`
   - `update-<version>.json` — the bundle: `{app, version, notes, files:
     {path: {sha256, content_b64}}, fullReinstall?}`

   Default feed URL:
   `https://raw.githubusercontent.com/kingaamir022-sketch/creative-studio-ai-pro/main/updates`
   A local folder feed is also supported (same two files in a folder).

2. **Check** — the server checks the feed on start and every 6 hours
   (when auto-check is ON, the default). If a newer version is found it is
   recorded and the Dashboard shows a banner **once per version** — it can
   be dismissed and never reappears for that version. Auto-apply is OFF by
   default; with it OFF nothing installs until you click **Update now**.

3. **Apply** — the package is downloaded, its SHA-256 is verified, and
   **every file's SHA-256 is verified**. If anything does not match, the
   package is rejected and nothing changes. Only app-code files are allowed
   (`server.js`, `package.json`, `Start.bat`, `src/`, `public/`, `docs/`,
   `scripts/`, `.github/`) — never `.env`, never `data/`, never
   `uploads/`/`renders/`, never `node_modules/`, never `node.exe`/FFmpeg.
   The current files are backed up first (last 2 backups kept); on any
   failure the backup is restored and the real error is reported.

   - **Windows (installed or portable):** the apply writes
     `data/updates/apply-update.bat`, launches it, and exits. The batch
     waits for the server process to exit, copies the staged files over
     the install (restoring the backup if a copy fails), then relaunches
     `Start.bat`.
   - **Other platforms / dev:** the files are copied in place and the app
     flags `pendingRestart` — restart the server to finish.

4. **Rollback** — Settings → Updates → Roll back restores the latest
   backup (restart to finish).

## Feed status (2026-11-13)

The GitHub repo **kingaamir022-sketch/creative-studio-ai-pro was created
on 2026-11-13** (empty at creation). The remaining step to go live is
pushing the manifest + first update package into the repo's `updates/`
folder (see `docs/RELEASE.md`). Until the feed is reachable the status
says **"Feed not reachable"** honestly — it never reports "up to date"
when the check never ran.

## Settings (Settings → Updates, OWNER/ADMIN only)

- Feed type: URL feed (default) or Local folder.
- Feed URL / folder. **An http(s) value is always treated as a URL feed,
  whatever the stored type says** (PageCommand's lesson: a pasted URL with
  the type dropdown still on Folder was read as a local file).
- Auto-check (ON by default), Auto-apply (OFF by default — ON means a new
  version installs itself as soon as the feed publishes it, and the app
  restarts on its own).
- Check now / Update now / Roll back, last-check time, current version,
  backups kept, update history.

## Full-reinstall updates

If a release changes dependencies, the manifest sets `fullReinstall: true`
and the app **never applies it in place** — it says plainly that the update
needs a fresh download (new portable/source package from Drive). The
publish script takes `--full-reinstall` for this.

## What an update package does NOT contain

`node_modules`, `node.exe`, `bin/` (FFmpeg), `data/`, `uploads/`,
`renders/`, `tests/`, `.env` — those stay from the install. That is why a
dependency change needs a full reinstall instead of an in-place update.

## Files

- `src/updater.js` — core (check / stage / apply / rollback / backup /
  Windows batch / auto-check loop)
- `src/routes/updates.js` — API + auto-apply handler
- `scripts/publish-update.js` — builds the package + manifest
- `src/db.js` — `app_settings` table (feed settings)
- `data/updates/state.json` — runtime state (last check, available,
  staged, history, dismissals); `data/updates/backup-*` — backups
- API: `GET /api/updates/status`, `POST /api/updates/check`,
  `POST /api/updates/apply`, `POST /api/updates/rollback`,
  `POST /api/updates/dismiss`, `GET/POST /api/updates/settings`
- Tests: `tests/update.test.js` (12 tests, mock feed, temp app copy)
