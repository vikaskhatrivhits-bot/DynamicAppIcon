#!/usr/bin/env node
/**
 * One-time setup of dynamic app icons in a React Native project (Android + iOS):
 *
 *   node app-icon-kit/setup.js [--default <image>] [--with-screen] [--dry-run]
 *
 *   --default <image>  the main app icon (square, at least 1024px), set on Android AND iOS.
 *                      Optional when ios/<App>/Images.xcassets/AppIcon.appiconset already has a
 *                      1024px image: that image is then used for Android and iOS is left as is.
 *   --with-screen      also add src/screens/AppIconScreen.tsx, a ready-made icon picker.
 *   --dry-run          print what would change, write nothing.
 *
 * What it does (each step is skipped when already done, so re-running is safe):
 *   - app-icon-kit.config.json   created from the project (Android namespace, iOS project name)
 *   - app-icons/                 icons.json with "Default" + Default.png
 *   - iOS AppIcon                with --default, generated from Default.png from now on
 *                                ("ios.manageAppIcon": true); the old images in the set are replaced
 *   - Android                    appicon/ native module, AppIconPackage in MainApplication,
 *                                Recents sync in MainActivity, launcher moved from MainActivity to
 *                                generated <activity-alias> entries in AndroidManifest.xml
 *   - iOS                        AppIconModule.swift/.m added to the app target, and
 *                                "Include All App Icon Assets = Yes" for Debug and Release
 *   - JS                         src/services/appIcon.ts (getIcon / setIcon)
 *   - package.json               icons:add / icons:generate / icons:check scripts, and
 *                                `--main-activity MainActivity` for `npm run android`
 *   - runs the generator
 *
 * Nothing is written when any step cannot be applied safely; if the final generation fails,
 * every file is restored. Afterwards: npm run icons:add -- /path/to/Icon.png
 *
 * Requires macOS (uses the built-in `sips` and `plutil`).
 */
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CONFIG_NAME, CONFIG_FILE, abs, detectConfig, resolveConfig } = require('./lib/config');
const { imageInfo, sourceProblem, writeMaster } = require('./lib/image');

const KIT = path.relative(abs('.'), __dirname).split(path.sep).join('/');
const TEMPLATES = path.join(__dirname, 'templates');
const GENERATOR = path.join(__dirname, 'generate.js');
const ALIAS_BEGIN = '      <!-- BEGIN GENERATED APP ICON ALIASES (npm run icons:generate; do not edit by hand) -->';
const ALIAS_END = '      <!-- END GENERATED APP ICON ALIASES -->';

function fail(messages) {
  for (const m of [].concat(messages)) console.error(`[icons:setup] error: ${m}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { defaultImage: null, withScreen: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node app-icon-kit/setup.js [--default <image>] [--with-screen] [--dry-run]');
      process.exit(0);
    } else if (arg === '--default') {
      opts.defaultImage = argv[++i];
      if (!opts.defaultImage) fail('--default needs an image path.');
    } else if (arg.startsWith('--default=')) {
      opts.defaultImage = arg.slice('--default='.length);
    } else if (arg === '--with-screen') {
      opts.withScreen = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else {
      fail(`Unknown argument ${arg}. Run with --help for usage.`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------
// Planning: every step reads the current (or already planned) content and records new content.

const plan = new Map(); // project-relative path -> string | { copyFrom } ; insertion-ordered
const notes = [];
const problems = [];

const read = rel => {
  const planned = plan.get(rel);
  if (typeof planned === 'string') return planned;
  return fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), 'utf8') : null;
};
const write = (rel, content) => {
  if (read(rel) !== content) plan.set(rel, content);
};
const done = message => notes.push(`ok      ${message}`);

function template(rel, vars) {
  let text = fs.readFileSync(path.join(TEMPLATES, `${rel}.tpl`), 'utf8');
  for (const [key, value] of Object.entries(vars)) text = text.split(key).join(value);
  return text;
}

/** Relative module specifier from one project file to another, without extension. */
function importPath(fromFile, toFile) {
  const rel = path
    .relative(path.dirname(fromFile), toFile.replace(/\.(ts|tsx|js)$/, ''))
    .split(path.sep)
    .join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Adds Kotlin imports to the file's single contiguous import block, keeping it sorted. */
function addKotlinImports(text, file, imports) {
  const lines = text.split('\n');
  const first = lines.findIndex(l => l.startsWith('import '));
  if (first === -1) {
    problems.push(`${file}: no import block found.`);
    return text;
  }
  let last = first;
  while (last + 1 < lines.length && (lines[last + 1].startsWith('import ') || lines[last + 1].trim() === '')) last++;
  while (lines[last].trim() === '') last--;
  const block = lines.slice(first, last + 1);
  if (block.some(l => l.trim() === '')) {
    // Keep grouped imports untouched; just append ours after the block.
    const missing = imports.map(i => `import ${i}`).filter(i => !block.includes(i));
    lines.splice(last + 1, 0, ...missing);
    return lines.join('\n');
  }
  const merged = [...new Set([...block, ...imports.map(i => `import ${i}`)])].sort();
  lines.splice(first, block.length, ...merged);
  return lines.join('\n');
}

function planConfig(opts) {
  let config;
  const existing = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;
  if (existing !== null) {
    try {
      config = JSON.parse(existing);
    } catch (e) {
      fail(`${CONFIG_NAME} is not valid JSON: ${e.message}`);
    }
  } else {
    config = detectConfig();
  }
  // --default is the main icon on both platforms, so iOS's AppIcon is generated from it too.
  if (opts.defaultImage && config.ios && typeof config.ios === 'object') config.ios.manageAppIcon = true;
  const text = `${JSON.stringify(config, null, 2)}\n`;
  if (existing === text) done(`${CONFIG_NAME} (existing)`);
  else write(CONFIG_NAME, text);
  const { paths, problems: configProblems } = resolveConfig(config);
  if (configProblems) {
    fail([
      ...configProblems.map(p => `${CONFIG_NAME}: ${p}`),
      `Create ${CONFIG_NAME} in the project root with the right values and run setup again:\n` +
        JSON.stringify({ ...config, android: { packageName: 'com.myapp' }, ios: { appName: 'MyApp' } }, null, 2),
    ]);
  }
  return paths;
}

function checkProject(p) {
  const required = [p.manifest, p.mainActivity, p.mainApplication, p.pbxproj, p.xcassets, 'package.json'];
  const missing = required.filter(f => !fs.existsSync(abs(f)));
  if (fs.existsSync(abs(`${p.androidSourceDir}/MainApplication.java`))) {
    problems.push(`${p.androidSourceDir}/MainApplication.java: only Kotlin MainApplication/MainActivity are supported.`);
  }
  if (missing.length) {
    fail([
      `Expected project files are missing: ${missing.join(', ')}.`,
      `Check android.packageName ("${p.packageName}") and ios.appName ("${p.appName}") in ${CONFIG_NAME}.`,
    ]);
  }
}

function planIcons(p, opts) {
  const iconsJson = p.iconsConfig;
  if (read(iconsJson) === null) {
    write(iconsJson, `${JSON.stringify({ icons: ['Default'] }, null, 2)}\n`);
  } else {
    let icons;
    try {
      icons = JSON.parse(read(iconsJson)).icons;
    } catch (e) {
      fail(`${iconsJson} is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(icons) || icons[0] !== 'Default') problems.push(`${iconsJson}: the first icon must be "Default".`);
    done(`${iconsJson} (existing)`);
  }

  const defaultPng = `${p.iconsDir}/Default.png`;
  if (opts.defaultImage) {
    const source = path.resolve(opts.defaultImage.replace(/^~(?=$|\/)/, os.homedir()));
    const problem = fs.existsSync(source) ? sourceProblem(source, imageInfo(source)) : `Image not found: ${source}`;
    if (problem) problems.push(`--default: ${problem}`);
    else plan.set(defaultPng, { image: source });
    return;
  }
  if (fs.existsSync(abs(defaultPng))) {
    done(`${defaultPng} (existing)`);
    return;
  }
  // Fall back to the 1024px image of the primary iOS icon, the same artwork the app ships today.
  const setDir = `${p.xcassets}/AppIcon.appiconset`;
  let found = null;
  try {
    const images = JSON.parse(fs.readFileSync(abs(`${setDir}/Contents.json`), 'utf8')).images || [];
    for (const img of images) {
      if (!img.filename || img.appearances) continue;
      const file = abs(`${setDir}/${img.filename}`);
      const info = fs.existsSync(file) ? imageInfo(file) : null;
      if (info && !sourceProblem(file, info)) {
        found = file;
        break;
      }
    }
  } catch {
    // no readable primary icon set
  }
  if (found) {
    plan.set(defaultPng, { image: found });
    notes.push(`info    Default icon taken from ${path.relative(abs('.'), found)}`);
  } else {
    problems.push(
      `${defaultPng} is missing and ${setDir} has no 1024x1024 image to use. Pass your current app ` +
        'icon: node app-icon-kit/setup.js --default /path/to/AppIcon-1024.png',
    );
  }
}

function planAndroid(p) {
  const vars = { __ANDROID_PACKAGE__: p.packageName };
  for (const name of ['AppIconModule', 'AppIconPackage', 'AppIconTaskDescription']) {
    const file = `${p.kotlinDir}/${name}.kt`;
    if (read(file) === null) write(file, template(`android/${name}.kt`, vars));
    else done(`${file} (existing)`);
  }

  // MainApplication: register the package.
  let app = read(p.mainApplication);
  if (app.includes('AppIconPackage()')) {
    done(`${p.mainApplication} registers AppIconPackage`);
  } else {
    const m = /^([ \t]*)PackageList\(this\)\.packages\.apply \{[^\n]*\n/m.exec(app);
    if (!m) {
      problems.push(
        `${p.mainApplication}: could not find "PackageList(this).packages.apply {". Add ` +
          '`add(AppIconPackage())` to getPackages() by hand and run setup again.',
      );
    } else {
      const at = m.index + m[0].length;
      app = `${app.slice(0, at)}${m[1]}  add(AppIconPackage())\n${app.slice(at)}`;
      write(p.mainApplication, addKotlinImports(app, p.mainApplication, [`${p.packageName}.appicon.AppIconPackage`]));
    }
  }

  // MainActivity: keep the Recents icon in sync with the selected icon.
  let activity = read(p.mainActivity);
  if (activity.includes('AppIconModule.syncTaskIcon')) {
    done(`${p.mainActivity} syncs the Recents icon`);
  } else {
    const superCall = /^([ \t]*)super\.onCreate\([^)]*\)[^\n]*\n/m.exec(activity);
    if (/override fun onCreate\(/.test(activity) && superCall) {
      const at = superCall.index + superCall[0].length;
      activity = `${activity.slice(0, at)}${superCall[1]}AppIconModule.syncTaskIcon(this)\n${activity.slice(at)}`;
    } else if (/override fun onCreate\(/.test(activity)) {
      problems.push(`${p.mainActivity}: onCreate has no super.onCreate(...) call; add AppIconModule.syncTaskIcon(this) by hand.`);
    } else {
      const anchor =
        /^[ \t]*override fun getMainComponentName\(\)[^\n{]*=[^\n]*\n/m.exec(activity) ||
        /^class MainActivity\b[^\n]*\{[ \t]*\n/m.exec(activity);
      if (!anchor) {
        problems.push(`${p.mainActivity}: could not find class MainActivity.`);
      } else {
        const at = anchor.index + anchor[0].length;
        activity =
          `${activity.slice(0, at)}\n  override fun onCreate(savedInstanceState: Bundle?) {\n` +
          '    super.onCreate(savedInstanceState)\n' +
          '    // Show the selected app icon for this task in Recents.\n' +
          `    AppIconModule.syncTaskIcon(this)\n  }\n${activity.slice(at)}`;
      }
    }
    write(
      p.mainActivity,
      addKotlinImports(activity, p.mainActivity, ['android.os.Bundle', `${p.packageName}.appicon.AppIconModule`]),
    );
  }

  // AndroidManifest: the launcher entry moves from MainActivity to the generated aliases.
  let manifest = read(p.manifest);
  if (manifest.includes(ALIAS_BEGIN.trim())) {
    done(`${p.manifest} has the generated alias region`);
    return;
  }
  const names = ['.MainActivity', `${p.packageName}.MainActivity`];
  const open = [...manifest.matchAll(/<activity\b[^>]*>/g)].find(o =>
    names.some(n => o[0].includes(`android:name="${n}"`)),
  );
  if (!open || open[0].endsWith('/>')) {
    problems.push(`${p.manifest}: could not find the <activity android:name=".MainActivity"> element.`);
    return;
  }
  const close = manifest.indexOf('</activity>', open.index);
  const body = manifest.slice(open.index, close);
  const launcher = [...body.matchAll(/\n?[ \t]*<intent-filter\b[^>]*>[\s\S]*?<\/intent-filter>/g)].find(
    f => f[0].includes('android.intent.action.MAIN') && f[0].includes('android.intent.category.LAUNCHER'),
  );
  if (!launcher) {
    problems.push(`${p.manifest}: MainActivity has no MAIN/LAUNCHER intent-filter.`);
    return;
  }
  const leftover = launcher[0]
    .replace(/<\/?intent-filter\b[^>]*>/g, '')
    .replace(/<action android:name="android\.intent\.action\.MAIN"\s*\/>/, '')
    .replace(/<category android:name="android\.intent\.category\.LAUNCHER"\s*\/>/, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  if (leftover.trim()) {
    problems.push(
      `${p.manifest}: MainActivity's launcher intent-filter also declares other entries; move them to ` +
        'a separate <intent-filter> and run setup again.',
    );
    return;
  }
  const activityStart = open.index;
  const activityEnd = close + '</activity>'.length;
  const newActivity = manifest.slice(activityStart, activityEnd).replace(launcher[0], '');
  const lineStart = manifest.lastIndexOf('\n', activityStart) + 1;
  const indent = /^[ \t]*/.exec(manifest.slice(lineStart))[0];
  const comment =
    `${indent}<!--\n` +
    `${indent}  MainActivity has no MAIN/LAUNCHER filter: the launcher entry comes from exactly one\n` +
    `${indent}  of the generated IconX aliases below, toggled by AppIconModule. Alias names are\n` +
    `${indent}  persisted in users' component state, so keep them stable across releases.\n` +
    `${indent}-->\n`;
  manifest =
    `${manifest.slice(0, lineStart)}${comment}${manifest.slice(lineStart, activityStart)}${newActivity}` +
    `\n\n${ALIAS_BEGIN}\n${ALIAS_END}${manifest.slice(activityEnd)}`;
  write(p.manifest, manifest);
}

function newPbxId(text, taken) {
  for (;;) {
    const id = crypto.randomBytes(12).toString('hex').toUpperCase();
    if (!text.includes(id) && !taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

function planIos(p) {
  const vars = { __IOS_APP_NAME__: p.appName };
  for (const name of ['AppIconModule.swift', 'AppIconModule.m']) {
    const file = `${p.iosAppDir}/${name}`;
    if (read(file) === null) write(file, template(`ios/${name}`, vars));
    else done(`${file} (existing)`);
  }

  let pbx = read(p.pbxproj);

  // "Include All App Icon Assets = Yes" for every configuration of the app target.
  if (/ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES/.test(pbx)) {
    problems.push(
      `${p.pbxproj}: the target has an explicit "Alternate App Icon Sets" list. Clear it in Xcode ` +
        '(Build Settings > Alternate App Icon Sets) and run setup again; the kit uses ' +
        '"Include All App Icon Assets" instead.',
    );
  } else {
    const before = pbx;
    pbx = pbx.replace(/ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = NO;/g, 'ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = YES;');
    pbx = pbx.replace(
      /^([ \t]*)ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;\n(?![ \t]*ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS)/gm,
      (line, indent) => `${line}${indent}ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = YES;\n`,
    );
    if ((pbx.match(/ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = YES;/g) || []).length < 2) {
      problems.push(
        `${p.pbxproj}: could not enable "Include All App Icon Assets" (no ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon ` +
          'in Debug and Release). Set it to Yes in Xcode and run setup again.',
      );
    } else if (pbx === before) {
      done(`${p.pbxproj} includes all app icon assets`);
    }
  }

  // Add the Swift and Objective-C files to the app target, next to AppDelegate.swift.
  if (pbx.includes('AppIconModule.swift in Sources')) {
    done(`${p.pbxproj} compiles AppIconModule.swift/.m`);
  } else {
    const ref = /^[ \t]*([0-9A-F]{24}) \/\* AppDelegate\.swift \*\/ = \{isa = PBXFileReference;([^\n]*)\};$/m.exec(pbx);
    const build = ref && new RegExp(`^[ \\t]*([0-9A-F]{24}) /\\* AppDelegate\\.swift in Sources \\*/ = \\{isa = PBXBuildFile; fileRef = ${ref[1]}\\b`, 'm').exec(pbx);
    if (!ref || !build) {
      problems.push(
        `${p.pbxproj}: AppDelegate.swift was not found in the app target. The kit needs a Swift ` +
          'AppDelegate (React Native 0.77+ template); otherwise add AppIconModule.swift and ' +
          'AppIconModule.m to the target in Xcode and run setup again.',
      );
    } else {
      const refPath = (/\bpath = ([^;]+);/.exec(ref[2]) || [])[1] || 'AppDelegate.swift';
      const dir = refPath.includes('/') ? refPath.slice(0, refPath.lastIndexOf('/') + 1) : '';
      const taken = new Set();
      const files = [
        ['AppIconModule.swift', 'sourcecode.swift'],
        ['AppIconModule.m', 'sourcecode.c.objc'],
      ].map(([name, type]) => ({ name, type, ref: newPbxId(pbx, taken), build: newPbxId(pbx, taken) }));

      const insertAfterLine = (text, marker, lines) => {
        const at = text.indexOf(marker);
        if (at === -1) return null;
        const eol = text.indexOf('\n', at) + 1;
        return text.slice(0, eol) + lines.join('') + text.slice(eol);
      };
      const nameAttr = f => (dir ? `name = ${f.name}; ` : '');
      let next = insertAfterLine(
        pbx,
        '/* Begin PBXBuildFile section */',
        files.map(f => `\t\t${f.build} /* ${f.name} in Sources */ = {isa = PBXBuildFile; fileRef = ${f.ref} /* ${f.name} */; };\n`),
      );
      next =
        next &&
        insertAfterLine(
          next,
          '/* Begin PBXFileReference section */',
          files.map(
            f =>
              `\t\t${f.ref} /* ${f.name} */ = {isa = PBXFileReference; lastKnownFileType = ${f.type}; ` +
              `${nameAttr(f)}path = ${dir}${f.name}; sourceTree = "<group>"; };\n`,
          ),
        );
      const childLine = next && new RegExp(`^([ \\t]*)${ref[1]} /\\* AppDelegate\\.swift \\*/,\\n`, 'm').exec(next);
      if (childLine) {
        const at = childLine.index + childLine[0].length;
        next = next.slice(0, at) + files.map(f => `${childLine[1]}${f.ref} /* ${f.name} */,\n`).join('') + next.slice(at);
      }
      const sourceLine = childLine && new RegExp(`^([ \\t]*)${build[1]} /\\* AppDelegate\\.swift in Sources \\*/,\\n`, 'm').exec(next);
      if (sourceLine) {
        const at = sourceLine.index + sourceLine[0].length;
        next =
          next.slice(0, at) +
          files.map(f => `${sourceLine[1]}${f.build} /* ${f.name} in Sources */,\n`).join('') +
          next.slice(at);
      }
      if (!next || !childLine || !sourceLine) {
        problems.push(
          `${p.pbxproj}: unexpected project layout; add AppIconModule.swift and AppIconModule.m to the ` +
            `${p.appName} target in Xcode and run setup again.`,
        );
      } else {
        pbx = next;
      }
    }
  }
  write(p.pbxproj, pbx);
}

function planJs(p, opts) {
  const service = p.serviceFile;
  if (read(service) === null) {
    write(service, template('js/appIcon.ts', { __IOS_APP_NAME__: p.appName, __GENERATED_IMPORT__: importPath(service, p.generatedFile) }));
  } else {
    done(`${service} (existing)`);
  }
  if (!opts.withScreen) return;
  const screen = 'src/screens/AppIconScreen.tsx';
  if (read(screen) !== null) {
    done(`${screen} (existing)`);
    return;
  }
  let displayName = p.appName;
  try {
    displayName = JSON.parse(read('app.json')).displayName || displayName;
  } catch {
    // keep the iOS app name
  }
  write(
    screen,
    template('js/AppIconScreen.tsx', {
      __APP_DISPLAY_NAME__: displayName,
      __SERVICE_IMPORT__: importPath(screen, service),
      __GENERATED_IMPORT__: importPath(screen, p.generatedFile),
    }),
  );
}

function planPackageJson() {
  const text = read('package.json');
  const pkg = JSON.parse(text);
  const scripts = pkg.scripts || {};
  const wanted = {
    'icons:add': `node ${KIT}/add.js`,
    'icons:generate': `node ${KIT}/generate.js`,
    'icons:check': `node ${KIT}/generate.js --check`,
  };
  const next = {};
  const place = () => Object.assign(next, wanted);
  for (const [key, value] of Object.entries(scripts)) {
    if (key in wanted) continue;
    next[key] = value;
    if (key === 'ios') place();
  }
  if (!('ios' in scripts)) place();

  // The React Native CLI launches the manifest's launcher activity, which is now an alias.
  const android = next.android;
  if (typeof android === 'string' && !android.includes('--main-activity')) {
    if (/^(npx )?react-native run-android\b/.test(android)) next.android = `${android} --main-activity MainActivity`;
    else notes.push(`warning Add --main-activity MainActivity to your Android run command ("${android}").`);
  }
  pkg.scripts = next;
  const indent = (/\n([ \t]+)"/.exec(text) || [])[1] || '  ';
  const updated = `${JSON.stringify(pkg, null, indent)}${text.endsWith('\n') ? '\n' : ''}`;
  if (updated === text) done('package.json scripts');
  else write('package.json', updated);
}

/** plutil parses the planned project file, so a broken pbxproj is never written. */
function lintPbxproj(p) {
  const planned = plan.get(p.pbxproj);
  if (typeof planned !== 'string') return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-icon-kit-'));
  try {
    fs.writeFileSync(path.join(tmp, 'project.pbxproj'), planned);
    execFileSync('plutil', ['-lint', path.join(tmp, 'project.pbxproj')], { stdio: 'pipe' });
  } catch (e) {
    problems.push(`${p.pbxproj}: the updated project file would not parse (${String(e.stdout || e.message).trim()}).`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------

function main() {
  if (process.platform !== 'darwin') fail('Setup uses macOS `sips` and `plutil`; run it on a Mac.');
  const opts = parseArgs(process.argv.slice(2));

  const p = planConfig(opts);
  checkProject(p);
  planIcons(p, opts);
  planAndroid(p);
  planIos(p);
  planJs(p, opts);
  planPackageJson();
  lintPbxproj(p);

  for (const n of notes) console.log(`[icons:setup] ${n}`);
  if (problems.length) {
    fail([...problems, 'Nothing was changed.']);
  }
  for (const file of plan.keys()) {
    console.log(`[icons:setup] ${opts.dryRun ? 'would write' : 'write  '} ${file}`);
  }
  if (opts.dryRun) {
    console.log('[icons:setup] Dry run: nothing was changed.');
    return;
  }

  // Remember every original so a failed generation leaves the project exactly as it was. The
  // generator may replace the primary iOS AppIcon images, so those are kept as well.
  const keep = [...plan.keys()];
  const primarySet = `${p.xcassets}/AppIcon.appiconset`;
  if (fs.existsSync(abs(primarySet))) keep.push(...fs.readdirSync(abs(primarySet)).map(f => `${primarySet}/${f}`));
  keep.push(`${primarySet}/1024.png`, `${primarySet}/Contents.json`);
  const originals = new Map(keep.map(f => [f, fs.existsSync(abs(f)) ? fs.readFileSync(abs(f)) : null]));
  const createdDirs = [];
  const restore = () => {
    for (const [file, content] of originals) {
      if (content) fs.writeFileSync(abs(file), content);
      else fs.rmSync(abs(file), { force: true });
    }
    for (const dir of createdDirs.reverse()) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
  };
  try {
    for (const [file, content] of plan) {
      let dir = path.dirname(abs(file));
      const missing = [];
      while (!fs.existsSync(dir)) {
        missing.push(dir);
        dir = path.dirname(dir);
      }
      createdDirs.push(...missing.reverse());
      fs.mkdirSync(path.dirname(abs(file)), { recursive: true });
      if (typeof content === 'string') {
        fs.writeFileSync(abs(file), content);
      } else {
        writeMaster(content.image, abs(file), imageInfo(content.image));
      }
    }
    console.log('[icons:setup] Generating icons...');
    execFileSync(process.execPath, [GENERATOR], { stdio: 'inherit' });
  } catch (e) {
    restore();
    fail(`${e.status ? 'Icon generation failed (see above)' : e.message}. All changes were undone.`);
  }

  console.log(
    '\n[icons:setup] Done. Add icons with one command:\n' +
      '  npm run icons:add -- /path/to/Icon.png\n' +
      'Then rebuild the app: npm run android / npm run ios',
  );
}

main();
