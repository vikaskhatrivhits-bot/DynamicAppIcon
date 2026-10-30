#!/usr/bin/env node
/**
 * Adds (or replaces) a seasonal app icon in one step, from an image anywhere on disk:
 *
 *   npm run icons:add -- ~/Downloads/Ganesh.png
 *   npm run icons:add -- "~/Desktop/ganesh chaturthi.jpg" --name Ganesh
 *   npm run icons:add -- ~/Desktop/diwali-v2.png --name Diwali --replace
 *   npm run icons:add -- ~/Desktop/new-logo.png --name Default --replace   (main app icon)
 *
 * Steps: validate the image (square, at least 1024px) -> save it as app-icons/<Name>.png
 * (1024x1024 PNG) -> add <Name> to app-icons/icons.json -> run app-icon-kit/generate.js,
 * which regenerates every Android, iOS and React Native artifact. If any step fails, the
 * image and icons.json are restored, so nothing is left half-added.
 *
 * The name defaults to the file name in PascalCase. Rebuild the app afterwards
 * (`npm run android` / `npm run ios`); new icons are native resources.
 *
 * Requires macOS (uses the built-in `sips`).
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { abs, loadPaths } = require('./lib/config');
const { imageInfo, sourceProblem, writeMaster } = require('./lib/image');

const PATHS = loadPaths('icons:add');
const ICONS_DIR = abs(PATHS.iconsDir);
const CONFIG_FILE = abs(PATHS.iconsConfig);
const GENERATOR = path.join(__dirname, 'generate.js');
const ID_PATTERN = /^[A-Z][A-Za-z0-9]{0,39}$/;
const DEFAULT_ICON = 'Default';

function fail(message) {
  console.error(`[icons:add] error: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(
    'Usage: npm run icons:add -- <image path> [--name <Name>] [--replace]\n\n' +
      '  <image path>   square image (PNG/JPEG/...), at least 1024x1024, anywhere on disk\n' +
      '  --name <Name>  icon identifier (default: file name in PascalCase, e.g. Ganesh)\n' +
      '  --replace      update the artwork of an existing icon instead of adding a new one',
  );
}

function parseArgs(argv) {
  const opts = { image: null, name: null, replace: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg === '--replace') {
      opts.replace = true;
    } else if (arg === '--name') {
      opts.name = argv[++i];
      if (!opts.name) fail('--name needs a value, e.g. --name Ganesh');
    } else if (arg.startsWith('--name=')) {
      opts.name = arg.slice('--name='.length);
    } else if (arg.startsWith('-')) {
      fail(`Unknown option ${arg}. Run with --help for usage.`);
    } else if (opts.image) {
      fail(`Only one image path is accepted (got "${opts.image}" and "${arg}"). Quote paths with spaces.`);
    } else {
      opts.image = arg;
    }
  }
  if (!opts.image) {
    usage();
    process.exit(1);
  }
  return opts;
}

/** "ganesh chaturthi-2026.png" -> "GaneshChaturthi2026" */
function nameFromFile(file) {
  const base = path.basename(file, path.extname(file));
  return base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('');
}

function main() {
  if (process.platform !== 'darwin') fail('This command uses macOS `sips`; run it on a Mac.');
  const opts = parseArgs(process.argv.slice(2));

  const source = path.resolve(opts.image.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) fail(`Image not found: ${source}`);

  const name = opts.name || nameFromFile(source);
  if (!ID_PATTERN.test(name)) {
    fail(
      `"${name}" is not a valid icon name. Use letters and digits starting with an uppercase ` +
        'letter (e.g. --name Ganesh).',
    );
  }
  const info = imageInfo(source);
  const problem = sourceProblem(source, info);
  if (problem) fail(problem);

  const configText = fs.readFileSync(CONFIG_FILE, 'utf8');
  const config = JSON.parse(configText);
  const existing = config.icons.find(id => id.toLowerCase() === name.toLowerCase());
  if (existing && existing !== name) {
    fail(`"${name}" clashes with existing icon "${existing}" (names must differ by more than case).`);
  }
  if (existing === DEFAULT_ICON && !opts.replace) {
    fail('"Default" is the main app icon. To change it, add --replace (updates it on Android and iOS).');
  }
  if (existing && !opts.replace) {
    fail(`Icon "${name}" already exists. Use --replace to update its artwork, or --name to pick another name.`);
  }

  const target = path.join(ICONS_DIR, `${name}.png`);
  const previousImage = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (previousImage && !existing) {
    fail(`${PATHS.iconsDir}/${name}.png already exists but is not listed in icons.json. Remove or rename it first.`);
  }

  const rollback = () => {
    fs.writeFileSync(CONFIG_FILE, configText);
    if (previousImage) fs.writeFileSync(target, previousImage);
    else fs.rmSync(target, { force: true });
  };

  try {
    writeMaster(source, target, info);
    if (!existing) {
      config.icons.push(name);
      const eol = configText.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}${eol}`);
    }
    console.log(`[icons:add] ${existing ? 'Replacing' : 'Adding'} "${name}" from ${source}`);
    execFileSync(process.execPath, [GENERATOR], { stdio: 'inherit' });
  } catch (e) {
    rollback();
    fail(`${e.status ? 'Icon generation failed (see above)' : e.message}. ${PATHS.iconsDir} was restored.`);
  }

  if (name === DEFAULT_ICON) {
    console.log(
      PATHS.manageAppIcon
        ? '\n[icons:add] Done. The main app icon was updated on Android and iOS.'
        : '\n[icons:add] Done. The main app icon was updated on Android. iOS keeps its own AppIcon ' +
            'because "ios.manageAppIcon" is not true in app-icon-kit.config.json.',
    );
  } else {
    console.log(`\n[icons:add] Done. "${name}" is available on Android, iOS and in the icon picker.`);
  }
  console.log('[icons:add] Rebuild the app to include it: npm run android / npm run ios');
}

main();
