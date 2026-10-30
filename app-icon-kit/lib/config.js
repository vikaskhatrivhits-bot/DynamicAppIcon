'use strict';
/**
 * Project settings for the app icon kit, read from <project>/app-icon-kit.config.json:
 *
 *   {
 *     "android": { "packageName": "com.myapp" },   Kotlin package of MainActivity (namespace)
 *     "ios": {
 *       "appName": "MyApp",                        ios/<appName>/ and ios/<appName>.xcodeproj
 *       "manageAppIcon": true,                     also generate the primary iOS AppIcon from
 *                                                  Default.png (set by setup --default)
 *       "iconBackground": "#000000"                fills transparent pixels of iOS icons (App
 *     },                                           Store icons must not have an alpha channel)
 *     "iconsDir": "app-icons",                     icons.json + one 1024px PNG per icon
 *     "generatedFile": "src/generated/appIcons.ts",
 *     "serviceFile": "src/services/appIcon.ts"
 *   }
 *
 * `node app-icon-kit/setup.js` creates it from the project (android/app/build.gradle namespace and
 * the ios/*.xcodeproj name); edit it if detection picks the wrong values.
 */

const fs = require('fs');
const path = require('path');

/** The kit folder sits directly inside the React Native project. */
const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_NAME = 'app-icon-kit.config.json';
const CONFIG_FILE = path.join(ROOT, CONFIG_NAME);

const DEFAULTS = {
  iconsDir: 'app-icons',
  generatedFile: 'src/generated/appIcons.ts',
  serviceFile: 'src/services/appIcon.ts',
};

const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const PACKAGE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

const abs = rel => path.join(ROOT, rel);

/** Best guess of the config for this project; fields that cannot be detected are null. */
function detectConfig() {
  let packageName = null;
  for (const file of ['android/app/build.gradle', 'android/app/build.gradle.kts']) {
    if (!fs.existsSync(abs(file))) continue;
    const m = /^\s*namespace\s*=?\s*["']([\w.]+)["']/m.exec(fs.readFileSync(abs(file), 'utf8'));
    if (m) {
      packageName = m[1];
      break;
    }
  }
  if (!packageName && fs.existsSync(abs('android/app/src/main/AndroidManifest.xml'))) {
    const m = /<manifest[^>]*\spackage="([\w.]+)"/.exec(
      fs.readFileSync(abs('android/app/src/main/AndroidManifest.xml'), 'utf8'),
    );
    if (m) packageName = m[1];
  }

  let appName = null;
  if (fs.existsSync(abs('ios'))) {
    const projects = fs
      .readdirSync(abs('ios'))
      .filter(f => f.endsWith('.xcodeproj') && f !== 'Pods.xcodeproj');
    if (projects.length === 1) appName = projects[0].replace(/\.xcodeproj$/, '');
  }

  return { android: { packageName }, ios: { appName }, ...DEFAULTS };
}

/** Validates the config and returns every project path the kit reads or writes. */
function resolveConfig(config) {
  const problems = [];
  const packageName = config && config.android && config.android.packageName;
  const appName = config && config.ios && config.ios.appName;
  if (typeof packageName !== 'string' || !PACKAGE_PATTERN.test(packageName)) {
    problems.push(`android.packageName must be a Kotlin package such as "com.myapp" (got ${JSON.stringify(packageName)}).`);
  }
  if (typeof appName !== 'string' || !appName || /[/\\]/.test(appName)) {
    problems.push(`ios.appName must be the name of ios/<appName>.xcodeproj (got ${JSON.stringify(appName)}).`);
  }
  const manageAppIcon = config.ios.manageAppIcon === undefined ? false : config.ios.manageAppIcon;
  if (typeof manageAppIcon !== 'boolean') {
    problems.push(`ios.manageAppIcon must be true or false (got ${JSON.stringify(manageAppIcon)}).`);
  }
  const background = config.ios.iconBackground === undefined ? '#000000' : config.ios.iconBackground;
  if (typeof background !== 'string' || !COLOR_PATTERN.test(background)) {
    problems.push(`ios.iconBackground must be a color like "#000000" (got ${JSON.stringify(background)}).`);
  }
  if (problems.length) return { problems };

  const settings = { ...DEFAULTS, ...config };
  const pkgPath = packageName.replace(/\./g, '/');
  // Kotlin sources may live under src/main/java (RN template) or src/main/kotlin.
  const sourceDir =
    ['java', 'kotlin']
      .map(dir => `android/app/src/main/${dir}/${pkgPath}`)
      .find(dir => fs.existsSync(abs(`${dir}/MainActivity.kt`))) || `android/app/src/main/java/${pkgPath}`;

  const paths = {
    packageName,
    appName,
    iconsDir: settings.iconsDir,
    iconsConfig: `${settings.iconsDir}/icons.json`,
    iconsLock: `${settings.iconsDir}/icons.lock.json`,
    androidRes: 'android/app/src/main/res',
    manifest: 'android/app/src/main/AndroidManifest.xml',
    androidSourceDir: sourceDir,
    mainActivity: `${sourceDir}/MainActivity.kt`,
    mainApplication: `${sourceDir}/MainApplication.kt`,
    kotlinDir: `${sourceDir}/appicon`,
    kotlinFile: `${sourceDir}/appicon/AppIconModule.kt`,
    manageAppIcon,
    iosIconBackground: [1, 3, 5].map(i => parseInt(background.slice(i, i + 2), 16)),
    iosAppDir: `ios/${appName}`,
    xcassets: `ios/${appName}/Images.xcassets`,
    swiftFile: `ios/${appName}/AppIconModule.swift`,
    objcFile: `ios/${appName}/AppIconModule.m`,
    pbxproj: `ios/${appName}.xcodeproj/project.pbxproj`,
    generatedFile: settings.generatedFile,
    serviceFile: settings.serviceFile,
  };
  return { paths };
}

/** Loads and resolves the config, or exits with instructions when it is missing or invalid. */
function loadPaths(tag) {
  const fail = message => {
    console.error(`[${tag}] error: ${message}`);
    process.exit(1);
  };
  if (!fs.existsSync(CONFIG_FILE)) {
    fail(`${CONFIG_NAME} not found. Run \`node app-icon-kit/setup.js\` once to set up this project.`);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    fail(`${CONFIG_NAME} is not valid JSON: ${e.message}`);
  }
  const { paths, problems } = resolveConfig(config);
  if (problems) fail(problems.map(p => `${CONFIG_NAME}: ${p}`).join('\n'));
  return paths;
}

module.exports = { ROOT, CONFIG_NAME, CONFIG_FILE, abs, detectConfig, resolveConfig, loadPaths };
