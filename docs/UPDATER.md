# In-App Updater — node_modules overlay (v2.2.4)

A release that adds a **new production dependency** used to need
`fullReinstall: true` — the user had to download a fresh Setup.exe and
install it by hand, because an update package never carried `node_modules`.
Since v2.2.4 the updater can install such a release **in-app**, from a
verified `node_modules` overlay inside the update package. The rule stays
the same as before: **refuse honestly rather than break an install** —
anything the overlay cannot carry safely falls back to `fullReinstall`.

## What a package carries now

The bundle (`update-<version>.json`) gains three fields; the manifest
(`version.json`) gains two:

| Field | Where | Meaning |
|-------|-------|---------|
| `nodeModules` | bundle | `{ "node_modules/<pkg>/…": { sha256, content_b64 } }` — the new dependency files only (not the whole `node_modules`). |
| `depsChanged` | bundle + manifest | Sorted list of dependency names that changed vs the previous release (the full transitive closure, not just the direct dep). |
| `hasNativeModules` | bundle + manifest | `true` if the overlay contains a native file (`.node` binary or `binding.gyp`). A package with this flag is **never** applied in place. |
| `hasNodeModules` | manifest | `true` when the bundle carries an overlay (so the UI can say "includes new dependencies"). |

A release with no dependency change ships exactly like before: no overlay,
`depsChanged: []`, `hasNativeModules: false`, `fullReinstall: false`.

## Safety rules (all enforced before anything is staged)

1. **Path allow-list** — every overlay path must start with
   `node_modules/` and contain no `..`, no absolute path, no backslash,
   no trailing slash (`ALLOWED_OVERLAY` in `src/updater.js`). Anything
   else rejects the whole package.
2. **SHA-256 per file** — every overlay file's hash is verified against
   the bundle manifest **before staging**, exactly like app files. One
   mismatch rejects the whole package and nothing changes.
3. **Native modules are refused** — `.node` files and `binding.gyp`
   cannot be carried in an overlay (they are compiled for a specific
   Node/platform and a wrong binary would break the install at runtime).
   The updater treats `hasNativeModules` exactly like `fullReinstall`:
   `check()` reports `fullReinstall: true`, and the apply route refuses
   with 409. The user is told to download the fresh package instead.
4. **Caps** — at most **50,000 files** and **250 MB** of overlay data
   (`MAX_OVERLAY_FILES`, `MAX_OVERLAY_BYTES`). Over the cap → rejected
   with a plain message, nothing staged.
5. **Symlinks are refused at publish time** — `collectPackageFiles`
   refuses to follow a symlink into the overlay (a link could point
   outside the package).

## Backup + rollback cover the overlay too

- `makeBackup(files, nodeModules, from, to)` backs up the app files **and**
  every overlay file that already exists in the install. It returns
  `{ dir, addedNodeModules }` — the overlay files the update **adds**
  (files that did not exist before).
- The backup directory carries `BACKUP-META.json` (with `nodeModules` and
  `addedNodeModules`) and `ADDED-FILES.txt` (Windows-style paths, one per
  line) so both the Node apply path and the Windows batch know exactly
  what is new.
- On any apply failure, rollback restores the backed-up app files **and**
  the backed-up overlay files, and **deletes** the files the update added
  (`restoreOne` / the batch's `ADDED-FILES.txt` loop) — so a failed update
  leaves no half-installed dependency behind.
- `rollback()` (Settings → Updates → Roll back) restores the latest backup
  the same way: app files + overlay files + removal of added files.

## Apply flow (Windows vs other platforms)

- **Windows (installed or portable):** the apply writes
  `data/updates/apply-update.bat` (built by `buildApplyBatch`, which now
  takes `addedFiles`), launches it, and exits. The batch waits for the
  server process to exit, copies the staged app files **and** the staged
  overlay files over the install (restoring the backup if a copy fails),
  then relaunches `Start.bat`. On failure it deletes the added files
  listed in `ADDED-FILES.txt`.
- **Other platforms / dev:** the files are copied in place by
  `applyStaged()` and the app flags `pendingRestart` — restart the server
  to finish. The same backup/rollback rules apply.

## Publish flow (`scripts/publish-update.js`)

- `--with-deps` — diff `package.json` against the **previous update
  bundle** in `updates-out/` or `updates/` (`previousReleaseDeps`) and
  build the overlay for every changed dependency (the package directory
  plus its transitive `dependencies` closure, via `computeDepsOverlay`).
- `--deps pkg1,pkg2` — explicit list, same collection.
- If dependencies changed and **neither** flag nor `--full-reinstall` was
  given, publish **refuses**: "Dependencies changed since \<prev\> …
  re-run with --with-deps (pure-JS deps) or --full-reinstall (native
  deps)." A package that would break installs is never published by
  accident.
- If the overlay contains native modules, publish refuses with the same
  message — re-run with `--full-reinstall` instead.
- `--full-reinstall` still exists for exactly that case (native deps, or
  any release the publisher judges unsafe to overlay).

## What the overlay can never do

- Replace `node.exe`, FFmpeg, or anything outside `node_modules/` — the
  allow-list forbids it.
- Touch `data/`, `uploads/`, `renders/`, `.env`, or `tests/` — those are
  never in a package (app files or overlay).
- Upgrade a native dependency in place (better-sqlite3, onnxruntime
  native bits, …) — those releases stay `fullReinstall: true` and the
  app says so plainly.
- Hide a failure: a rejected package, a failed apply, and a rollback all
  report the real reason in the UI and the update history.

## Files

- `src/updater.js` — overlay verification, staging, backup, apply,
  rollback, Windows batch (`ALLOWED_OVERLAY`, `isNativeFile`,
  `MAX_OVERLAY_BYTES`, `MAX_OVERLAY_FILES`)
- `src/routes/updates.js` — apply route refuses
  `manifest.fullReinstall || manifest.hasNativeModules` (409)
- `scripts/publish-update.js` — `--with-deps` / `--deps` /
  `--full-reinstall`, `computeDepsOverlay`, `previousReleaseDeps`
- Tests: `tests/library-assistant.test.js` — overlay apply + rollback
  end to end (simulated release adding a new dependency), tampered-hash
  / traversal / native refusal, publish-time dep diff; plus the existing
  `tests/update.test.js` (12 tests, mock feed, temp app copy)

## History

- v2.1.0 — updater shipped; any dependency change needed `fullReinstall`.
- v2.2.2 — first `fullReinstall: true` release in practice (new
  `onnxruntime-web` dependency); the user had to install Setup.exe once
  by hand.
- v2.2.4 — overlay shipped. A pure-JS dependency change now updates
  in-app; native changes still need a fresh install, by design.
