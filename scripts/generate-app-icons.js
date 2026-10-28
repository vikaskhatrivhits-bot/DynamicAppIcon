#!/usr/bin/env node
/**
 * Generates every Android, iOS and React Native app-icon artifact from app-icons/.
 *
 *   app-icons/icons.json      ordered icon identifiers, e.g. { "icons": ["Default", "Holi"] }
 *   app-icons/<Id>.png        one 1024x1024 PNG per identifier
 *   app-icons/icons.lock.json identifiers generated so far (written by this script)
 *
 * Usage:
 *   npm run icons:generate                 write outputs (only files whose content changed)
 *   npm run icons:check                    report out-of-date outputs, write nothing (exit 1)
 *   node scripts/generate-app-icons.js --allow-remove   also delete outputs of removed icons
 *
 * Identifiers are persisted on users' devices (Android activity-alias state, iOS alternate icon
 * name), so removing or renaming one is refused unless --allow-remove is passed. The primary iOS
 * AppIcon set is never touched; Default only drives the Android mipmaps and previews.
 *
 * Requires macOS (uses the built-in `sips` for resizing).
 */
'use strict';

const { Buffer } = require('buffer');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const abs = rel => path.join(ROOT, rel);

const ICONS_DIR = 'app-icons';
const CONFIG_FILE = `${ICONS_DIR}/icons.json`;
const LOCK_FILE = `${ICONS_DIR}/icons.lock.json`;
const DEFAULT_ICON = 'Default';
const SOURCE_SIZE = 1024;

const ANDROID_RES = 'android/app/src/main/res';
const ANDROID_DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];
const MANIFEST_FILE = 'android/app/src/main/AndroidManifest.xml';
const PREVIEWS_XML_FILE = `${ANDROID_RES}/values/app_icon_previews.xml`;
const KOTLIN_FILE = 'android/app/src/main/java/com/mustwatch/appicon/AppIconModule.kt';
const XCASSETS_DIR = 'ios/MustWatch/Images.xcassets';
const SWIFT_FILE = 'ios/MustWatch/AppIconModule.swift';
const PBXPROJ_FILE = 'ios/MustWatch.xcodeproj/project.pbxproj';
const TS_FILE = 'src/generated/appIcons.ts';

const MARKER_NOTE = 'npm run icons:generate; do not edit by hand';
const ID_PATTERN = /^[A-Z][A-Za-z0-9]{0,39}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const ALLOW_REMOVE = args.has('--allow-remove');

const errors = [];
const warnings = [];

function fail(messages) {
  for (const m of [].concat(messages)) console.error(`[icons] error: ${m}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Naming

const androidName = id => id.toLowerCase();
const aliasName = id => `Icon${id}`;
const mipmapName = id => `ic_launcher_${androidName(id)}`;
const iosSetName = id => `AppIcon${id}`;
const masterPath = id => `${ICONS_DIR}/${id}.png`;

// ---------------------------------------------------------------------------------------------
// Inputs and validation

function readConfig() {
  if (!fs.existsSync(abs(CONFIG_FILE))) fail(`${CONFIG_FILE} not found.`);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(abs(CONFIG_FILE), 'utf8'));
  } catch (e) {
    fail(`${CONFIG_FILE} is not valid JSON: ${e.message}`);
  }
  const icons = config && config.icons;
  if (!Array.isArray(icons) || icons.length === 0) {
    fail(`${CONFIG_FILE} must contain a non-empty "icons" array.`);
  }
  const seen = new Map();
  icons.forEach((id, index) => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      errors.push(
        `${CONFIG_FILE} icons[${index}] ${JSON.stringify(id)}: identifiers must start with an ` +
          'uppercase letter and contain only letters and digits (max 40 characters).',
      );
      return;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) {
      errors.push(
        `${CONFIG_FILE}: "${id}" duplicates "${seen.get(key)}" (identifiers must be unique ` +
          'ignoring case, because Android resource names are lowercase).',
      );
    }
    seen.set(key, id);
  });
  if (icons[0] !== DEFAULT_ICON) {
    errors.push(`${CONFIG_FILE}: the first icon must be "${DEFAULT_ICON}" (the primary icon).`);
  }
  return icons;
}

function readPngHeader(file) {
  const buf = fs.readFileSync(abs(file));
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

function validateMasters(icons) {
  for (const id of icons) {
    const file = masterPath(id);
    if (!fs.existsSync(abs(file))) {
      errors.push(`Missing source image ${file} for "${id}".`);
      continue;
    }
    const header = readPngHeader(file);
    if (!header) {
      errors.push(`${file} is not a valid PNG file.`);
    } else if (header.width !== SOURCE_SIZE || header.height !== SOURCE_SIZE) {
      errors.push(
        `${file} is ${header.width}x${header.height}; it must be exactly ${SOURCE_SIZE}x${SOURCE_SIZE}.`,
      );
    }
  }
  const listed = new Set(icons.map(id => `${id}.png`));
  for (const f of fs.readdirSync(abs(ICONS_DIR))) {
    if (f.toLowerCase().endsWith('.png') && !listed.has(f)) {
      warnings.push(`${ICONS_DIR}/${f} is not listed in ${CONFIG_FILE} and is ignored.`);
    }
  }
}

/** Identifiers generated before: the lock file plus aliases already in the manifest. */
function previouslyGenerated() {
  const ids = [];
  if (fs.existsSync(abs(LOCK_FILE))) {
    try {
      ids.push(...JSON.parse(fs.readFileSync(abs(LOCK_FILE), 'utf8')).icons);
    } catch (e) {
      fail(`${LOCK_FILE} is not valid JSON: ${e.message}`);
    }
  }
  const manifest = fs.readFileSync(abs(MANIFEST_FILE), 'utf8');
  for (const m of manifest.matchAll(/"\$\{applicationId\}\.Icon([A-Za-z0-9]+)"/g)) ids.push(m[1]);
  return [...new Set(ids)];
}

function checkIosBuildSettings() {
  const pbx = fs.readFileSync(abs(PBXPROJ_FILE), 'utf8');
  const includeAll = (pbx.match(/ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = YES;/g) || []).length;
  if (includeAll < 2 || /ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES/.test(pbx)) {
    errors.push(
      `${PBXPROJ_FILE}: the MustWatch target must use "Include All App Icon Assets = Yes" ` +
        '(ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = YES) for Debug and Release, with no ' +
        'explicit "Alternate App Icon Sets" list, so every generated AppIcon<Id> set is registered.',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering

function resizeWithSips(id, size, tmpDir) {
  const out = path.join(tmpDir, `${androidName(id)}-${size}.png`);
  try {
    execFileSync('sips', ['-z', String(size), String(size), abs(masterPath(id)), '--out', out], {
      stdio: 'pipe',
    });
  } catch (e) {
    fail(`sips could not resize ${masterPath(id)} to ${size}px: ${String(e.stderr || e.message).trim()}`);
  }
  return fs.readFileSync(out);
}

function replaceRegion(file, text, begin, end, body) {
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start === -1 || stop === -1 || stop < start || text.indexOf(begin, start + 1) !== -1) {
    fail(`${file}: generated-region markers are missing or duplicated.\n  Expected one "${begin.trim()}" followed by one "${end.trim()}".`);
  }
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const afterEnd = text.indexOf('\n', stop);
  return `${text.slice(0, lineStart)}${begin}\n${body}${end}${text.slice(afterEnd)}`;
}

function renderManifest(icons) {
  const text = fs.readFileSync(abs(MANIFEST_FILE), 'utf8');
  const blocks = icons.map(
    id => `      <activity-alias
        android:name="\${applicationId}.${aliasName(id)}"
        android:targetActivity=".MainActivity"
        android:label="@string/app_name"
        android:icon="@mipmap/${mipmapName(id)}"
        android:enabled="${id === DEFAULT_ICON}"
        android:exported="true">
        <intent-filter>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent-filter>
      </activity-alias>
`,
  );
  return replaceRegion(
    MANIFEST_FILE,
    text,
    `      <!-- BEGIN GENERATED APP ICON ALIASES (${MARKER_NOTE}) -->`,
    '      <!-- END GENERATED APP ICON ALIASES -->',
    blocks.join('\n'),
  );
}

function renderPreviewsXml(icons) {
  const items = icons
    .map(id => `    <drawable name="app_icon_preview_${androidName(id)}">@mipmap/${mipmapName(id)}</drawable>\n`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  Generated by \`npm run icons:generate\` from app-icons/icons.json. Do not edit by hand.

  Drawable aliases of the launcher mipmaps so the JS icon picker can show
  previews via <Image source={{ uri: 'app_icon_preview_x' }} />. React Native
  only resolves bare-name image URIs against the "drawable" type, and this way
  the artwork exists once, in mipmap-*, for both the launcher and the app.
-->
<resources>
${items}</resources>
`;
}

function renderKotlin(icons) {
  const text = fs.readFileSync(abs(KOTLIN_FILE), 'utf8');
  const aliases = icons.map(id => `            "${id}" to "${aliasName(id)}",\n`).join('');
  const resources = icons.map(id => `            "${id}" to R.mipmap.${mipmapName(id)},\n`).join('');
  const body = `    /** JS icon name -> alias suffix; must match \`\${applicationId}.<suffix>\` in the manifest. */
    private val ALIASES =
        linkedMapOf(
${aliases}        )

    /** Aliases declared with android:enabled="true" in the manifest. */
    private val MANIFEST_ENABLED = setOf("${DEFAULT_ICON}")

    /** JS icon name -> launcher artwork; must match each alias's android:icon. */
    private val ICON_RESOURCES =
        mapOf(
${resources}        )
`;
  return replaceRegion(
    KOTLIN_FILE,
    text,
    `    // BEGIN GENERATED APP ICONS (${MARKER_NOTE})`,
    '    // END GENERATED APP ICONS',
    body,
  );
}

function renderSwift(icons) {
  const text = fs.readFileSync(abs(SWIFT_FILE), 'utf8');
  const sets = icons
    .map(id => `    "${id}": ${id === DEFAULT_ICON ? 'nil' : `"${iosSetName(id)}"`},\n`)
    .join('');
  const body = `  /// JS icon name -> alternate icon set name (\`nil\` = primary AppIcon).
  private static let iconSets: [String: String?] = [
${sets}  ]

  private static let orderedNames = [${icons.map(id => `"${id}"`).join(', ')}]
`;
  return replaceRegion(
    SWIFT_FILE,
    text,
    `  // BEGIN GENERATED APP ICONS (${MARKER_NOTE})`,
    '  // END GENERATED APP ICONS',
    body,
  );
}

function renderIosContentsJson() {
  // Same layout Xcode writes for a single-size iOS app icon set (Dark/Tinted left empty).
  const appearance = value => `    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "${value}"
        }
      ],
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }`;
  return `{
  "images" : [
    {
      "filename" : "1024.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    },
${appearance('dark')},
${appearance('tinted')}
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
`;
}

function renderTypeScript(icons) {
  const mipmap = id => `../../${ANDROID_RES}/mipmap-xxxhdpi/${mipmapName(id)}.png`;
  const source = `// Generated by \`npm run icons:generate\` from app-icons/icons.json. Do not edit by hand.
import { ImageSourcePropType, Platform } from 'react-native';

export const APP_ICONS = [${icons.map(id => `'${id}'`).join(', ')}] as const;

type GeneratedAppIconName = (typeof APP_ICONS)[number];

// Android: drawable aliases of the launcher mipmaps
// (android/app/src/main/res/values/app_icon_previews.xml), so previews use the
// exact artwork bundled for the launcher instead of a separate JS copy.
// iOS: app icon sets cannot be loaded as images, so the same artwork is bundled
// from the 192px Android mipmaps (the iOS 1024px sources are 1-2.5 MB each).
export const PREVIEWS: Record<GeneratedAppIconName, ImageSourcePropType> =
  Platform.OS === 'ios'
    ? {
${icons.map(id => `        ${id}: require('${mipmap(id)}'),`).join('\n')}
      }
    : {
${icons.map(id => `        ${id}: { uri: 'app_icon_preview_${androidName(id)}' },`).join('\n')}
      };
`;
  const prettier = require('prettier');
  const options = prettier.resolveConfig.sync(abs(TS_FILE)) || {};
  return prettier.format(source, { ...options, parser: 'typescript' });
}

// ---------------------------------------------------------------------------------------------
// Plan, compare, write

function ownedFiles(id) {
  const files = ANDROID_DENSITIES.map(([d]) => `${ANDROID_RES}/mipmap-${d}/${mipmapName(id)}.png`);
  if (id !== DEFAULT_ICON) {
    files.push(`${XCASSETS_DIR}/${iosSetName(id)}.appiconset/1024.png`);
    files.push(`${XCASSETS_DIR}/${iosSetName(id)}.appiconset/Contents.json`);
  }
  return files;
}

function buildPlan(icons) {
  const outputs = new Map();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mustwatch-icons-'));
  try {
    for (const id of icons) {
      for (const [density, size] of ANDROID_DENSITIES) {
        outputs.set(`${ANDROID_RES}/mipmap-${density}/${mipmapName(id)}.png`, resizeWithSips(id, size, tmpDir));
      }
      if (id !== DEFAULT_ICON) {
        const dir = `${XCASSETS_DIR}/${iosSetName(id)}.appiconset`;
        // The 1024px master is used as-is: Xcode derives every iOS size from it.
        outputs.set(`${dir}/1024.png`, fs.readFileSync(abs(masterPath(id))));
        outputs.set(`${dir}/Contents.json`, renderIosContentsJson());
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  outputs.set(MANIFEST_FILE, renderManifest(icons));
  outputs.set(PREVIEWS_XML_FILE, renderPreviewsXml(icons));
  outputs.set(KOTLIN_FILE, renderKotlin(icons));
  outputs.set(SWIFT_FILE, renderSwift(icons));
  outputs.set(TS_FILE, renderTypeScript(icons));
  outputs.set(LOCK_FILE, `${JSON.stringify({ icons }, null, 2)}\n`);
  return outputs;
}

function checkUnmanagedIosSets(icons) {
  const expected = new Set(['AppIcon', ...icons.filter(id => id !== DEFAULT_ICON).map(iosSetName)]);
  for (const entry of fs.readdirSync(abs(XCASSETS_DIR))) {
    if (entry.endsWith('.appiconset') && !expected.has(entry.replace(/\.appiconset$/, ''))) {
      errors.push(
        `${XCASSETS_DIR}/${entry} is not generated from ${CONFIG_FILE}, but "Include All App Icon ` +
          'Assets" would ship it as an alternate icon. Add its identifier to icons.json or remove it.',
      );
    }
  }
}

function main() {
  if (process.platform !== 'darwin') fail('This generator uses macOS `sips`; run it on a Mac.');

  const icons = readConfig();
  if (errors.length) fail(errors);
  validateMasters(icons);
  checkIosBuildSettings();

  const removed = previouslyGenerated().filter(id => !icons.includes(id));
  if (removed.length && !ALLOW_REMOVE) {
    errors.push(
      `Refusing to remove previously generated icon(s): ${removed.join(', ')}. Users may have them ` +
        'selected (Android would lose its launcher entry); renaming counts as removing. Restore them ' +
        'in icons.json, or rerun with --allow-remove if this is intended.',
    );
  }
  const deletions = ALLOW_REMOVE ? removed.flatMap(ownedFiles).filter(f => fs.existsSync(abs(f))) : [];
  // Sets of removed icons are either refused above or deleted below, so they are not "unmanaged".
  if (!errors.length) checkUnmanagedIosSets(icons.concat(removed));
  if (errors.length) fail(errors);

  const outputs = buildPlan(icons);
  const changed = [...outputs].filter(([file, content]) => {
    const target = abs(file);
    if (!fs.existsSync(target)) return true;
    const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return !fs.readFileSync(target).equals(next);
  });

  for (const w of warnings) console.warn(`[icons] warning: ${w}`);

  if (CHECK) {
    if (changed.length || deletions.length) {
      for (const [file] of changed) console.error(`[icons] out of date: ${file}`);
      for (const file of deletions) console.error(`[icons] would delete: ${file}`);
      console.error('[icons] Run `npm run icons:generate` and commit the result.');
      process.exit(1);
    }
    console.log(`[icons] Up to date: ${icons.length} icons (${icons.join(', ')}), ${outputs.size} files.`);
    return;
  }

  for (const [file, content] of changed) {
    fs.mkdirSync(path.dirname(abs(file)), { recursive: true });
    fs.writeFileSync(abs(file), content);
    console.log(`[icons] wrote   ${file}`);
  }
  for (const file of deletions) {
    fs.rmSync(abs(file));
    console.log(`[icons] deleted ${file}`);
    const dir = path.dirname(abs(file));
    if (dir.endsWith('.appiconset') && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
  console.log(
    `[icons] ${icons.length} icons (${icons.join(', ')}): ${changed.length} file(s) updated, ` +
      `${outputs.size - changed.length} unchanged${deletions.length ? `, ${deletions.length} deleted` : ''}.`,
  );
}

main();
