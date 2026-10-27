import { NativeModules, Platform } from 'react-native';

export const APP_ICONS = ['Default', 'Holi', 'Utrayan', 'Diwali'] as const;

export type AppIconName = (typeof APP_ICONS)[number];

export type AppIconErrorCode =
  // Raised by the native modules (android/.../appicon/AppIconModule.kt and
  // ios/MustWatch/AppIconModule.swift).
  | 'E_INVALID_ICON'
  | 'E_MISSING_ALIAS'
  | 'E_INVALID_STATE'
  | 'E_READ_FAILED'
  | 'E_SWITCH_FAILED'
  // Raised by this wrapper.
  | 'E_UNSUPPORTED_PLATFORM'
  | 'E_MODULE_UNAVAILABLE'
  | 'E_INVALID_RESPONSE'
  | 'E_UNKNOWN';

export class AppIconError extends Error {
  readonly code: AppIconErrorCode;

  constructor(code: AppIconErrorCode, message: string) {
    super(message);
    this.name = 'AppIconError';
    this.code = code;
  }
}

/** Must match AppIconModule.getName() in Kotlin. */
const MODULE_NAME = 'AppIconModule';

const NATIVE_CODES: ReadonlySet<string> = new Set([
  'E_INVALID_ICON',
  'E_MISSING_ALIAS',
  'E_INVALID_STATE',
  'E_READ_FAILED',
  'E_SWITCH_FAILED',
]);

interface AppIconNativeModule {
  getIcon(): Promise<unknown>;
  setIcon(icon: string): Promise<unknown>;
}

export function isAppIconSwitchingSupported(): boolean {
  return Platform.OS === 'android' || Platform.OS === 'ios';
}

export function isAppIconName(value: unknown): value is AppIconName {
  return (
    typeof value === 'string' &&
    (APP_ICONS as readonly string[]).includes(value)
  );
}

// Resolved lazily so nothing touches the native module on unsupported platforms.
function getNativeModule(): AppIconNativeModule {
  if (!isAppIconSwitchingSupported()) {
    throw new AppIconError(
      'E_UNSUPPORTED_PLATFORM',
      `App icon switching is only supported on Android and iOS (current platform: ${Platform.OS}).`,
    );
  }
  const native = NativeModules[MODULE_NAME] as
    | Partial<AppIconNativeModule>
    | undefined;
  if (
    !native ||
    typeof native.getIcon !== 'function' ||
    typeof native.setIcon !== 'function'
  ) {
    throw new AppIconError(
      'E_MODULE_UNAVAILABLE',
      Platform.OS === 'ios'
        ? `Native module "${MODULE_NAME}" is not registered. Check that AppIconModule.swift and AppIconModule.m are in the MustWatch target and rebuild the iOS app.`
        : `Native module "${MODULE_NAME}" is not registered. Check that AppIconPackage is added in MainApplication.getPackages() and rebuild the Android app.`,
    );
  }
  return native as AppIconNativeModule;
}

function toAppIconError(error: unknown): AppIconError {
  if (error instanceof AppIconError) {
    return error;
  }
  const code = (error as { code?: unknown } | null)?.code;
  const message =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return new AppIconError(
    typeof code === 'string' && NATIVE_CODES.has(code)
      ? (code as AppIconErrorCode)
      : 'E_UNKNOWN',
    message,
  );
}

function validateResponse(value: unknown): AppIconName {
  if (!isAppIconName(value)) {
    throw new AppIconError(
      'E_INVALID_RESPONSE',
      `Native module returned an unexpected icon value: ${JSON.stringify(
        value,
      )}.`,
    );
  }
  return value;
}

/** Reads the launcher alias that is actually enabled on the device. */
export async function getIcon(): Promise<AppIconName> {
  const native = getNativeModule();
  let result: unknown;
  try {
    result = await native.getIcon();
    console.log('native side result got ->', JSON.stringify(result, null, 2))
  } catch (error) {
    throw toAppIconError(error);
  }
  return validateResponse(result);
}

/**
 * Enables the launcher alias for `icon` and disables the others. Resolves once the
 * PackageManager state is applied; the launcher may take longer to redraw.
 */
export async function setIcon(icon: AppIconName): Promise<AppIconName> {
  if (!isAppIconName(icon)) {
    throw new AppIconError(
      'E_INVALID_ICON',
      `Unknown icon ${JSON.stringify(icon)}. Expected one of: ${APP_ICONS.join(
        ', ',
      )}.`,
    );
  }
  const native = getNativeModule();
  let result: unknown;
  try {
    result = await native.setIcon(icon);
  } catch (error) {
    throw toAppIconError(error);
  }
  const applied = validateResponse(result);
  if (applied !== icon) {
    throw new AppIconError(
      'E_INVALID_RESPONSE',
      `Requested "${icon}" but native module reported "${applied}".`,
    );
  }
  return applied;
}
