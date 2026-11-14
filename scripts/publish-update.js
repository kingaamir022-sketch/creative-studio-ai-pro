'use strict';
// Build an update package + feed manifest for CreativeStudio AI Pro.
// Usage:
//   node scripts/publish-update.js [--version X.Y.Z] [--notes "..."]
//     [--out ./updates-out] [--full-reinstall] [--with-deps | --deps pkg1,pkg2]
//
// Output in <out>/:
//   version.json          {app, version, notes, package, packageSha256,
//                          publishedAt, fullReinstall?, depsChanged?,
//                          hasNativeModules?}
//   update-<version>.json {app, version, notes, files:
//                          {path: {sha256, content_b64}}, fullReinstall?,
//                          nodeModules?: {path: {sha256, content_b64}},
//                          depsChanged?: [...], hasNativeModules?: bool}
//
// Included (app files only — the updater allow-lists these): server.js,
// package.json, Start.bat, src/**, public/**, docs/**, scripts/**,
// .github/**. Never included: node_modules, node.exe, bin/, runtime/,
// data/, uploads/, renders/, tests/, .env, .git.
//
// Dependencies (v2.2.4): when a release adds or changes a production
// dependency, the update must carry the changed packages or the app would
// break after applying (new code, old node_modules). Two ways:
//   --with-deps   diff package.json against the previous update bundle and
//                 carry every added/changed package (+ its transitive deps)
//                 as a verified node_modules overlay. Pure-JS only.
//   --deps a,b    carry exactly these packages (explicit list).
// A release with a NATIVE dependency (any .node binary / binding.gyp in
// the overlay) is refused here — re-run with --full-reinstall instead.
// If dependencies changed and neither flag nor --full-reinstall is given,
// the script refuses to publish (a package that would break installs).
// See docs/UPDATER.md for the full design.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function cmpVer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); }
  return 0;
}

function parseArgs(argv) {
  const out = { version: null, notes: '', outDir: path.join(root, 'updates-out'), fullReinstall: false, withDeps: false, depsList: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') out.version = argv[++i];
    else if (a === '--notes') out.notes = argv[++i] || '';
    else if (a === '--out') out.outDir = path.resolve(argv[++i]);
    else if (a === '--full-reinstall') out.fullReinstall = true;
    else if (a === '--with-deps') out.withDeps = true;
    else if (a === '--deps') out.depsList = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help') { console.log('Usage: node scripts/publish-update.js [--version X.Y.Z] [--notes "..."] [--out ./updates-out] [--full-reinstall] [--with-deps | --deps pkg1,pkg2]'); process.exit(0); }
    else throw new Error('Unknown argument: ' + a);
  }
  return out;
}

// Find the previous release's package.json inside the newest previous
// update bundle in updates-out/ or updates/. Returns { version, deps }
// or null when no previous bundle exists.
function previousReleaseDeps(version) {
  const dirs = [path.join(root, 'updates-out'), path.join(root, 'updates')];
  let best = null;
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const m = e.match(/^update-(\d+\.\d+\.\d+)\.json$/);
      if (!m || cmpVer(m[1], version) >= 0) continue;
      if (best && cmpVer(m[1], best.version) <= 0) continue;
      try {
        const bundle = JSON.parse(fs.readFileSync(path.join(dir, e), 'utf8'));
        const pkgEntry = bundle.files && bundle.files['package.json'];
        if (!pkgEntry) continue;
        const pkg = JSON.parse(Buffer.from(pkgEntry.content_b64, 'base64').toString('utf8'));
        best = { version: m[1], deps: pkg.dependencies || {} };
      } catch { /* unreadable bundle — ignore it */ }
    }
  }
  return best;
}

// Collect every file of one installed package (node_modules/<name>/...).
// Symlinks are refused: the overlay format can only carry regular files.
function collectPackageFiles(pkgDir, relBase, out) {
  for (const e of fs.readdirSync(pkgDir, { withFileTypes: true })) {
    const full = path.join(pkgDir, e.name);
    const rel = `${relBase}/${e.name}`;
    if (e.isSymbolicLink()) throw new Error(`Refusing to publish: node_modules contains a symlink (${rel}) — the update overlay can only carry regular files.`);
    if (e.isDirectory()) { collectPackageFiles(full, rel, out); continue; }
    if (!e.isFile()) continue;
    out.push(rel);
  }
  return out;
}

// Build the node_modules overlay for the given direct dependencies:
// each package dir + its transitive `dependencies` closure. Returns
// { overlay: {rel: {sha256, content_b64}}, depsChanged: [names],
//   hasNativeModules: bool }.
function computeDepsOverlay(directDeps) {
  const overlay = {};
  const seen = new Set();
  const queue = [...directDeps];
  const changed = [];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const pkgDir = path.join(root, 'node_modules', ...name.split('/'));
    let pkgJson;
    try {
      pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    } catch {
      throw new Error(`Dependency "${name}" is not installed under node_modules/ — run npm install first, or drop it from the overlay list.`);
    }
    if (!changed.includes(name)) changed.push(name);
    const files = collectPackageFiles(pkgDir, `node_modules/${name}`, []);
    for (const rel of files) {
      const buf = fs.readFileSync(path.join(root, ...rel.split('/')));
      overlay[rel] = { sha256: sha256(buf), content_b64: buf.toString('base64') };
    }
    const transitive = Object.keys(pkgJson.dependencies || {});
    for (const dep of transitive) if (!seen.has(dep)) queue.push(dep);
  }
  const hasNativeModules = Object.keys(overlay).some((p) => p.toLowerCase().endsWith('.node') || p.endsWith('binding.gyp'));
  return { overlay, depsChanged: changed.sort(), hasNativeModules };
}

function collectFiles() {
  const files = [];
  const includeFile = (rel) => rel === 'server.js' || rel === 'package.json' || rel === 'Start.bat';
  const includeDir = (rel) => ['src', 'public', 'docs', 'scripts', '.github', 'electron'].some((d) => rel === d || rel.startsWith(d + '/'));
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) { if (includeDir(rel)) walk(full); continue; }
      if (includeFile(rel) || includeDir(rel)) files.push(rel);
    }
  }
  walk(root);
  files.sort();
  return files;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = args.version || pkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Bad version: ' + version);
  if (version !== pkg.version) {
    console.log(`NOTE: package.json still says ${pkg.version} — bump it to ${version} first (the package carries the tree's package.json).`);
  }
  if (args.withDeps && args.depsList) throw new Error('Use either --with-deps or --deps, not both.');
  const files = collectFiles();
  if (!files.length) throw new Error('No files collected — refusing to publish an empty update.');
  const bundleFiles = {};
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(root, rel));
    bundleFiles[rel] = { sha256: sha256(buf), content_b64: buf.toString('base64') };
  }
  // --- Dependencies (v2.2.4) -----------------------------------------------
  // Diff the current dependencies against the previous release. When they
  // changed, the package must carry the overlay (or be fullReinstall) —
  // publishing without either would break installs.
  const curDeps = pkg.dependencies || {};
  const prev = previousReleaseDeps(version);
  let changedDeps = [];
  if (prev) {
    for (const [name, ver] of Object.entries(curDeps)) {
      if (prev.deps[name] !== ver) changedDeps.push(name);
    }
  }
  let overlayResult = null;
  if (args.depsList) {
    const unknown = args.depsList.filter((n) => !curDeps[n]);
    if (unknown.length) throw new Error(`--deps lists packages that are not in package.json dependencies: ${unknown.join(', ')}`);
    overlayResult = computeDepsOverlay(args.depsList);
  } else if (args.withDeps) {
    if (!prev) throw new Error('No previous update bundle found to diff against — use --deps pkg1,pkg2 (explicit list) or --full-reinstall instead.');
    if (!changedDeps.length) console.log('NOTE: --with-deps given but no dependency changed since ' + prev.version + ' — no overlay will be added.');
    else overlayResult = computeDepsOverlay(changedDeps);
  } else if (changedDeps.length && !args.fullReinstall) {
    throw new Error(`Dependencies changed since ${prev.version} (${changedDeps.join(', ')}) but no --with-deps / --deps / --full-reinstall was given. Refusing to publish a package that would break installs — re-run with --with-deps (pure-JS deps) or --full-reinstall (native deps).`);
  }
  if (overlayResult && overlayResult.hasNativeModules) {
    throw new Error(`The dependency overlay contains native modules (.node binaries / binding.gyp) in: ${overlayResult.depsChanged.join(', ')}. An overlay cannot carry native builds — re-run with --full-reinstall instead.`);
  }
  const bundle = { app: 'CreativeStudio AI Pro', version, notes: args.notes, files: bundleFiles };
  if (args.fullReinstall) bundle.fullReinstall = true;
  if (overlayResult) {
    bundle.nodeModules = overlayResult.overlay;
    bundle.depsChanged = overlayResult.depsChanged;
    bundle.hasNativeModules = false;
  }
  const bundleJson = JSON.stringify(bundle);
  const packageName = `update-${version}.json`;
  const manifest = {
    app: 'CreativeStudio AI Pro', version, notes: args.notes,
    package: packageName, packageSha256: sha256(Buffer.from(bundleJson)),
    publishedAt: new Date().toISOString(),
  };
  if (args.fullReinstall) manifest.fullReinstall = true;
  if (overlayResult) {
    manifest.depsChanged = overlayResult.depsChanged;
    manifest.hasNodeModules = true;
  }
  fs.mkdirSync(args.outDir, { recursive: true });
  fs.writeFileSync(path.join(args.outDir, packageName), bundleJson);
  fs.writeFileSync(path.join(args.outDir, 'version.json'), JSON.stringify(manifest, null, 1));
  console.log(`Update package built for v${version}:`);
  console.log(`  files:   ${files.length} app files (${bundleJson.length} bytes in package)`);
  if (overlayResult) console.log(`  overlay: ${Object.keys(overlayResult.overlay).length} node_modules files for ${overlayResult.depsChanged.join(', ')}`);
  console.log(`  package: ${path.join(args.outDir, packageName)}`);
  console.log(`  sha256:  ${manifest.packageSha256}`);
  console.log(`  manifest: ${path.join(args.outDir, 'version.json')}`);
  if (args.fullReinstall) {
    console.log('  fullReinstall: TRUE — this update will NOT auto-apply; users must download the fresh package.');
  } else if (changedDeps.length && !overlayResult) {
    console.log('  Reminder: dependencies changed but no previous bundle was found to diff against — verify the overlay decision before publishing.');
  } else if (!changedDeps.length && prev) {
    console.log(`  Dependencies unchanged since ${prev.version} — no overlay needed.`);
  }
  console.log('  Next: copy version.json + ' + packageName + ' into the feed repo updates/ folder, commit, push, then rotate Drive copies (docs/RELEASE.md).');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('publish-update failed: ' + (e.message || e)); process.exit(1); }
}
module.exports = { collectFiles, sha256, computeDepsOverlay, previousReleaseDeps, cmpVer };
