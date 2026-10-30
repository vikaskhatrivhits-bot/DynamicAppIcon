#!/usr/bin/env node
/**
 * Installs the kit into a React Native project, so nothing has to be copied by hand.
 * Run it from the project root:
 *
 *   npx <kit> init --default ~/Desktop/AppIcon.png    copy app-icon-kit/ into this project + setup
 *   npx <kit> update                                  refresh this project's app-icon-kit/ files
 *
 * <kit> is wherever this kit lives: a folder on this Mac, a Git repository or an npm package.
 * The kit is copied into the project (not run from a cache), so `npm run icons:add` keeps working
 * for teammates and CI without this command.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SOURCE = path.dirname(fs.realpathSync(path.join(__dirname, 'cli.js')));
const PROJECT = process.cwd();
const TARGET = path.join(PROJECT, 'app-icon-kit');
const { version, files } = require('./package.json');

function fail(message) {
  console.error(`[app-icon-kit] error: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(
    'Usage (from the React Native project root):\n' +
      '  npx <kit> init [--default <image>] [--with-screen] [--dry-run]\n' +
      '      copy app-icon-kit/ into this project and run the one-time setup\n' +
      '  npx <kit> update\n' +
      '      replace this project\'s app-icon-kit/ files with this version\n\n' +
      'Then add icons with: npm run icons:add -- /path/to/Icon.png',
  );
}

function checkProject() {
  const pkgFile = path.join(PROJECT, 'package.json');
  if (!fs.existsSync(pkgFile)) fail(`No package.json in ${PROJECT}. Run this from the React Native project root.`);
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps['react-native']) fail(`${PROJECT} is not a React Native project (no react-native dependency).`);
  if (path.resolve(SOURCE) === path.resolve(TARGET)) {
    fail('This project already holds the kit\'s source; run `node app-icon-kit/setup.js` directly.');
  }
}

/** Copies the kit's published files into <project>/app-icon-kit, replacing older kit files. */
function copyKit() {
  const entries = ['package.json', ...files];
  for (const entry of entries) {
    const from = path.join(SOURCE, entry);
    if (!fs.existsSync(from)) fail(`Kit file missing: ${from}`);
    const to = path.join(TARGET, entry);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, filter: src => path.basename(src) !== '.DS_Store' });
  }
}

function installedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(TARGET, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(command ? 0 : 1);
  }
  if (command !== 'init' && command !== 'update') fail(`Unknown command "${command}". Use init or update.`);
  checkProject();

  const current = installedVersion();
  if (command === 'update') {
    if (!fs.existsSync(TARGET)) fail('app-icon-kit/ is not in this project yet. Run `init` first.');
    copyKit();
    console.log(`[app-icon-kit] Updated app-icon-kit/ ${current || '?'} -> ${version}.`);
    execFileSync(process.execPath, [path.join(TARGET, 'generate.js')], { cwd: PROJECT, stdio: 'inherit' });
    return;
  }

  const added = !fs.existsSync(TARGET);
  if (added) {
    copyKit();
  } else {
    console.log(
      `[app-icon-kit] app-icon-kit/ ${current || ''} is already in this project; keeping it ` +
        '(use `update` to replace it with this version).',
    );
  }
  const dryRun = args.includes('--dry-run');
  let ok = true;
  try {
    execFileSync(process.execPath, [path.join(TARGET, 'setup.js'), ...args], { cwd: PROJECT, stdio: 'inherit' });
  } catch {
    ok = false;
  }
  // Setup changes nothing when it fails or in a dry run, so a freshly copied kit goes too.
  if (added && (!ok || dryRun)) {
    fs.rmSync(TARGET, { recursive: true, force: true });
  } else if (added) {
    console.log(`[app-icon-kit] Added app-icon-kit/ ${version} to this project.`);
  }
  if (!ok) process.exit(1);
}

main();
