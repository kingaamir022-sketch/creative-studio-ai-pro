'use strict';
// Build an update package + feed manifest for CreativeStudio AI Pro.
// Usage:
//   node scripts/publish-update.js [--version X.Y.Z] [--notes "..."]
//     [--out ./updates-out] [--full-reinstall]
//
// Output in <out>/:
//   version.json          {app, version, notes, package, packageSha256,
//                          publishedAt, fullReinstall?}
//   update-<version>.json {app, version, notes, files:
//                          {path: {sha256, content_b64}}, fullReinstall?}
//
// Included (app files only — the updater allow-lists these): server.js,
// package.json, Start.bat, src/**, public/**, docs/**, scripts/**,
// .github/**. Never included: node_modules, node.exe, bin/, runtime/,
// data/, uploads/, renders/, tests/, .env, .git.
//
// Release flow (see docs/RELEASE.md): bump the version in package.json →
// npm test → run this script → copy the two files into the feed repo's
// updates/ folder → commit + push → rotate the Drive copies. If the release
// changes dependencies (package.json dependencies/devDependencies), re-run
// with --full-reinstall: that update will NOT be applied in place — the app
// tells the user to download the fresh portable/source package instead.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function parseArgs(argv) {
  const out = { version: null, notes: '', outDir: path.join(root, 'updates-out'), fullReinstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') out.version = argv[++i];
    else if (a === '--notes') out.notes = argv[++i] || '';
    else if (a === '--out') out.outDir = path.resolve(argv[++i]);
    else if (a === '--full-reinstall') out.fullReinstall = true;
    else if (a === '--help') { console.log('Usage: node scripts/publish-update.js [--version X.Y.Z] [--notes "..."] [--out ./updates-out] [--full-reinstall]'); process.exit(0); }
    else throw new Error('Unknown argument: ' + a);
  }
  return out;
}

function collectFiles() {
  const files = [];
  const includeFile = (rel) => rel === 'server.js' || rel === 'package.json' || rel === 'Start.bat';
  const includeDir = (rel) => ['src', 'public', 'docs', 'scripts', '.github'].some((d) => rel === d || rel.startsWith(d + '/'));
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
  const files = collectFiles();
  if (!files.length) throw new Error('No files collected — refusing to publish an empty update.');
  const bundleFiles = {};
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(root, rel));
    bundleFiles[rel] = { sha256: sha256(buf), content_b64: buf.toString('base64') };
  }
  const bundle = { app: 'CreativeStudio AI Pro', version, notes: args.notes, files: bundleFiles };
  if (args.fullReinstall) bundle.fullReinstall = true;
  const bundleJson = JSON.stringify(bundle);
  const packageName = `update-${version}.json`;
  const manifest = {
    app: 'CreativeStudio AI Pro', version, notes: args.notes,
    package: packageName, packageSha256: sha256(Buffer.from(bundleJson)),
    publishedAt: new Date().toISOString(),
  };
  if (args.fullReinstall) manifest.fullReinstall = true;
  fs.mkdirSync(args.outDir, { recursive: true });
  fs.writeFileSync(path.join(args.outDir, packageName), bundleJson);
  fs.writeFileSync(path.join(args.outDir, 'version.json'), JSON.stringify(manifest, null, 1));
  console.log(`Update package built for v${version}:`);
  console.log(`  files:   ${files.length} app files (${bundleJson.length} bytes in package)`);
  console.log(`  package: ${path.join(args.outDir, packageName)}`);
  console.log(`  sha256:  ${manifest.packageSha256}`);
  console.log(`  manifest: ${path.join(args.outDir, 'version.json')}`);
  if (args.fullReinstall) {
    console.log('  fullReinstall: TRUE — this update will NOT auto-apply; users must download the fresh package.');
  } else {
    console.log('  Reminder: if this release changed dependencies, re-run with --full-reinstall (otherwise the app would break after applying).');
  }
  console.log('  Next: copy version.json + ' + packageName + ' into the feed repo updates/ folder, commit, push, then rotate Drive copies (docs/RELEASE.md).');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('publish-update failed: ' + (e.message || e)); process.exit(1); }
}
module.exports = { collectFiles, sha256 };
