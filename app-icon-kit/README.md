# App Icon Kit

Lets users switch the app's launcher icon (Android and iOS) in React Native, with one
command to add each new icon. No npm dependencies, no third-party native package, and it
works with the New Architecture.

Requirements: macOS (the scripts use the built-in `sips` and `plutil`), a Kotlin
`MainActivity`/`MainApplication`, and a Swift `AppDelegate` (React Native 0.77+ template).

## Use it in a new project (one time)

1. Copy this `app-icon-kit/` folder into the project root (next to `package.json`).
2. Run:

   ```bash
   node app-icon-kit/setup.js --default /path/to/current-app-icon-1024.png
   ```

   `--default` is the main app icon (square, at least 1024px). It is set on **Android and
   iOS**: the iOS `AppIcon` set is replaced by one generated from this image. You can leave
   it out when `ios/<App>/Images.xcassets/AppIcon.appiconset` already has a 1024px image;
   that image is then used for Android, and the iOS `AppIcon` is left as it is.
   Add `--with-screen` to also get a ready-made picker screen
   (`src/screens/AppIconScreen.tsx`). Use `--dry-run` to see the changes first.

3. Rebuild: `npm run android` / `npm run ios`.

Setup detects the Android package (`namespace` in `android/app/build.gradle`) and the iOS
project name, and saves them in `app-icon-kit.config.json`. If it can't apply a step safely,
it changes nothing and tells you what to fix. Running it again is safe.

## Add an icon (every time)

```bash
npm run icons:add -- ~/Downloads/Ganesh.png
npm run icons:add -- "~/Desktop/My Icons/ganesh chaturthi.jpg" --name Ganesh
npm run icons:add -- ~/Desktop/diwali-v2.png --name Diwali --replace
```

The image must be square and at least 1024×1024 (PNG, JPEG, …). Then rebuild the app.

Change the main icon later (Android and iOS):

```bash
npm run icons:add -- ~/Desktop/new-logo.png --name Default --replace
```

In the app:

```ts
import { getIcon, setIcon, APP_ICONS } from './src/services/appIcon';

await setIcon('Ganesh');
const current = await getIcon(); // 'Default' | 'Ganesh' | ...
```

## Config: `app-icon-kit.config.json` (project root)

```json
{
  "android": { "packageName": "com.myapp" },
  "ios": { "appName": "MyApp", "manageAppIcon": true, "iconBackground": "#000000" },
  "iconsDir": "app-icons",
  "generatedFile": "src/generated/appIcons.ts",
  "serviceFile": "src/services/appIcon.ts"
}
```

| Key | Meaning |
|---|---|
| `android.packageName` | Kotlin package of `MainActivity` (the `namespace` in `android/app/build.gradle`) |
| `ios.appName` | Name of `ios/<appName>.xcodeproj`, the `ios/<appName>/` folder and the app target |
| `ios.manageAppIcon` | `true`: the main iOS `AppIcon` is generated from `Default.png` (setup `--default` sets this). `false`/missing: it is never touched |
| `ios.iconBackground` | Color behind transparent pixels in iOS icons (default `#000000`, how iOS shows transparency) |
| `iconsDir` | Folder with `icons.json` and one 1024px PNG per icon |
| `generatedFile` | Generated icon list and previews for JavaScript |
| `serviceFile` | `getIcon` / `setIcon` wrapper written by setup |

## Other commands

| Command | What it does |
|---|---|
| `npm run icons:generate` | Regenerate everything from `app-icons/` (after editing it by hand) |
| `npm run icons:check` | Fail if generated files are out of date (useful in CI) |
| `node app-icon-kit/generate.js --allow-remove` | Apply a removal after deleting a name from `icons.json` |

Removing or renaming an icon is refused by default: a user who has it selected on Android
would lose the app's launcher entry.

## What setup changes

- **Android**: adds `appicon/AppIconModule.kt`, `AppIconPackage.kt` and
  `AppIconTaskDescription.kt`; registers `AppIconPackage` in `MainApplication`; syncs the
  Recents icon in `MainActivity.onCreate`; moves the launcher `intent-filter` from
  `MainActivity` to generated `<activity-alias>` entries; adds `--main-activity MainActivity`
  to `npm run android` (the React Native CLI can't launch an alias).
- **iOS**: adds `AppIconModule.swift` and `.m` to the app target; sets
  **Include All App Icon Assets = Yes** for Debug and Release. With `--default`, replaces the
  `AppIcon` set with one generated from `Default.png`. Icons work on iPhone and iPad.
- **JS**: adds `src/services/appIcon.ts` and the `icons:*` scripts in `package.json`.

## App Store

App Store Connect rejects icons that have an alpha channel (ITMS-90717). Every generated iOS
icon is written without one; transparent pixels are filled with `ios.iconBackground`.
Android icons keep their transparency.
