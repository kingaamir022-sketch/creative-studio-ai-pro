# Release Flow (v2.1.0+)

How a new version of CreativeStudio AI Pro goes from this machine to the
user's PC — in place, via the auto-update feed (see `docs/UPDATE_SYSTEM.md`).

## 1. Bump the version

- `package.json` → `"version": "X.Y.Z"`
- `server.js` health endpoint (`version: 'X.Y.Z'`) and its startup log line
- `src/routes/system.js` dashboard version string (`'X.Y.Z (…)'`)
- `public/app.js` footer version line
- Tests that assert the health version (`tests/*.test.js`) — keep them in
  sync or the suite fails.

## 2. Test

```bash
npm test
```

One clean run, nothing else running on the test ports (4831–4841). A stale
test server on a test port makes other tests fail with signup 409 — kill
leftover `node server.js` processes first.

## 3. Build the update package

```bash
node scripts/publish-update.js --notes "What changed in this release" [--full-reinstall]
```

Output goes to `./updates-out/`:
- `version.json` — feed manifest (version, notes, package name + SHA-256)
- `update-<version>.json` — the bundle (84 app files, each SHA-256 hashed)

**`--full-reinstall` when the release changes `package.json`
dependencies/devDependencies.** That update will NOT be applied in place —
the app tells the user to download the fresh portable/source package
instead. If you forget, the app would break after applying (new dependency
missing), so check the dependency diff before publishing.

## 4. Publish to the feed

The feed repo is **kingaamir022-sketch/creative-studio-ai-pro** (created
2026-11-13). Copy the two files into its `updates/` folder, commit, push:

```
creative-studio-ai-pro/
  updates/
    version.json
    update-<version>.json
```

The live feed URL is
`https://raw.githubusercontent.com/kingaamir022-sketch/creative-studio-ai-pro/main/updates`
(raw.githubusercontent can lag ~1–2 min after a push — re-check before
concluding a failure). Apps check on start + every 6 h; with auto-apply OFF
the user sees a Dashboard banner and clicks Update now.

## 5. Rotate the Drive copies

Google Drive → `All softwares / CreativeStudio AI Pro`:
- Upload the new source zip and/or Windows portable.
- Move the old copy to `Old Versions` — **never delete old versions**
  (they are the rollback for a bad release).
- If the release was `--full-reinstall`, the Drive package IS the update
  path — say so in the release note to the user.

## 6. Tell the user

Short note: version, what changed, whether it installs itself (in-place)
or needs a fresh download (full-reinstall), and one try-it step
(Settings → Updates → Check now, or open the app and look for the banner).
