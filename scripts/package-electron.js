'use strict';
// Package the ALREADY-STAGED portable folder into a real desktop app with
// electron-packager.
//
//   node scripts/package-electron.js [--platform win32|linux] [--arch x64]
//     [--src <staged-dir>] [--out <output-dir>]
//
// Defaults:
//   --src  ~/workspace/creative-studio-delivery/CreativeStudio-AI-Pro-Windows
//          (on CI: the Actions staging dir passed in explicitly)
//   --out  ~/workspace/creative-studio-delivery/electron-dist
//
// What it does:
//   1. Copies the staged dir to a temp staging copy (the source is never
//      touched) and patches package.json `main` to electron/main.js IN THE
//      STAGED COPY ONLY — the repo tree keeps "main": "server.js".
//   2. Runs electron-packager (Node API) for the requested platform.
//      --executable-name "CreativeStudio AI Pro", app version from
//      package.json, prune:true (devDependencies — electron itself included
//      — are stripped from the packaged app; the CI install is a full
//      `npm ci` so packager is available, then pruned out of the output).
//   3. Prints the exact output layout.
//
// Icons + version metadata: the .ico and the exe version resource are
// embedded ONLY when packaging win32 ON Windows (rcedit is Windows-only;
// wine is NOT installed on this VM by design). A win32 build made on Linux
// ships the exe WITHOUT the custom icon and version stamp — the Windows CI
// build is the one that applies electron/icon.ico + appVersion. Linux
// builds skip icon embedding entirely.
//
// Output layout (win32-x64):
//   <out>/CreativeStudio AI Pro-win32-x64/
//     CreativeStudio AI Pro.exe
//     resources/app/            <- server.js, package.json (main=electron/main.js),
//                                  src/, public/, docs/, scripts/, electron/,
//                                  node_modules/ (production only), data/,
//                                  uploads/, renders/
//     resources/electron.asar   <- Electron framework (not the app code)
//     ... plus the usual Electron runtime files (dlls, locales, etc.)
// Output layout (linux-x64): same shape, binary named "CreativeStudio AI Pro"
// (no .exe), icon not embedded.
//
// The repo tree is kept clean: no build output is written under the project
// — temp staging lives in os.tmpdir(), final output under --out.
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function parseArgs(argv) {
  const out = {
    platform: 'win32', arch: 'x64',
    src: path.join(os.homedir(), 'workspace', 'creative-studio-delivery', 'CreativeStudio-AI-Pro-Windows'),
    outDir: path.join(os.homedir(), 'workspace', 'creative-studio-delivery', 'electron-dist'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform') out.platform = argv[++i];
    else if (a === '--arch') out.arch = argv[++i];
    else if (a === '--src') out.src = path.resolve(argv[++i]);
    else if (a === '--out') out.outDir = path.resolve(argv[++i]);
    else if (a === '--help') {
      console.log('Usage: node scripts/package-electron.js [--platform win32|linux] [--arch x64] [--src <staged-dir>] [--out <output-dir>]');
      process.exit(0);
    } else throw new Error('Unknown argument: ' + a);
  }
  return out;
}

function printTree(dir, prefix = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules') { console.log(`${prefix}${e.name}/  (production deps)`); continue; }
    console.log(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
    if (e.isDirectory() && prefix.length < 6) printTree(path.join(dir, e.name), prefix + '  ');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!['win32', 'linux', 'darwin'].includes(args.platform)) throw new Error('Unsupported --platform: ' + args.platform);
  if (!fs.existsSync(args.src)) throw new Error(`Staged dir not found: ${args.src} — run the portable staging step first.`);
  if (!fs.existsSync(path.join(args.src, 'server.js'))) throw new Error(`Staged dir has no server.js: ${args.src}`);
  if (!fs.existsSync(path.join(args.src, 'electron', 'main.js'))) {
    // The workflow copies electron/ into the staging dir; tolerate a
    // hand-staged dir that forgot it by copying from the repo tree.
    const repoElectron = path.join(root, 'electron');
    if (fs.existsSync(path.join(repoElectron, 'main.js'))) {
      console.log('NOTE: electron/ missing from staged dir — copying it from the repo tree.');
      fs.cpSync(repoElectron, path.join(args.src, 'electron'), { recursive: true });
    } else {
      throw new Error('electron/main.js missing from staged dir and from the repo tree — cannot package.');
    }
  }

  // Temp staging lives next to the output dir (home disk), NOT os.tmpdir():
  // /tmp is a small tmpfs on the build VM and a ~550 MB staging copy does
  // not fit there. The same TMPDIR is also handed to electron-packager,
  // which extracts the ~300 MB Electron template under os.tmpdir().
  const tmpRoot = fs.mkdtempSync(path.join(path.dirname(args.outDir), '.cs-tmp-'));
  process.env.TMPDIR = tmpRoot;
  const tmpStage = fs.mkdtempSync(path.join(tmpRoot, 'stage-'));
  try {
    console.log(`Staging copy: ${args.src} -> ${tmpStage}`);
    fs.cpSync(args.src, tmpStage, { recursive: true });

    // Patch main IN THE STAGED COPY ONLY — never the source tree.
    const stagedPkgPath = path.join(tmpStage, 'package.json');
    const stagedPkg = JSON.parse(fs.readFileSync(stagedPkgPath, 'utf8'));
    stagedPkg.main = 'electron/main.js';
    fs.writeFileSync(stagedPkgPath, JSON.stringify(stagedPkg, null, 2) + '\n');
    console.log('Patched staged package.json: main = electron/main.js');

    const packager = require('electron-packager');
    const iconPath = path.join(root, 'electron', 'icon.ico');
    // Windows-only exe metadata (version info + icon) needs wine/rcedit and
    // can only be applied when packaging win32 ON Windows. NOTE: even
    // without these options, electron-packager 17.1.2 ALWAYS runs rcedit
    // for win32 — it infers appVersion from the staged package.json — so
    // a win32 build on Linux fails with "wine64 not found" regardless.
    // That is expected here (wine is NOT installed by design); the
    // Windows CI build is the real win32 path.
    const isWindowsBuild = args.platform === 'win32' && process.platform === 'win32';
    if (args.platform === 'win32' && !isWindowsBuild) {
      console.log('NOTE: win32 packaging on Linux needs wine (electron-packager always runs rcedit for win32) — this attempt is expected to fail here; the Windows CI build produces the real win32 exe with version + icon.');
    }
    console.log(`Packaging ${pkg.name} v${pkg.version} for ${args.platform}-${args.arch} ...`);
    const outPaths = await packager({
      dir: tmpStage,
      out: args.outDir,
      platform: args.platform,
      arch: args.arch,
      name: 'CreativeStudio AI Pro',
      executableName: 'CreativeStudio AI Pro',
      overwrite: true,
      prune: true, // strip devDependencies (incl. electron) from the packaged app
      ...(isWindowsBuild ? { appVersion: pkg.version, appCopyright: 'CreativeStudio AI Pro', icon: iconPath } : {}),
    });
    console.log('\nPackaged to:');
    for (const p of outPaths) {
      console.log(`  ${p}`);
      console.log(`  layout:`);
      printTree(p, '    ');
    }
    const exeName = args.platform === 'win32' ? 'CreativeStudio AI Pro.exe' : 'CreativeStudio AI Pro';
    const exePath = path.join(outPaths[0], exeName);
    console.log(`\nLaunch binary: ${exePath} (exists: ${fs.existsSync(exePath)})`);
    console.log(`App code lives in: ${path.join(outPaths[0], 'resources', 'app')}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('package-electron failed: ' + (e.message || e)); process.exit(1); });
}
module.exports = { parseArgs };
