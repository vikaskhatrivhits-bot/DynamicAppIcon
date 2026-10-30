import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  APP_ICONS,
  AppIconError,
  AppIconName,
  getIcon,
  isAppIconSwitchingSupported,
  setIcon,
} from '__SERVICE_IMPORT__';
import { PREVIEWS } from '__GENERATED_IMPORT__';

type Status = 'loading' | 'ready' | 'switching';

interface ScreenError {
  kind: 'read' | 'switch';
  code: string;
  message: string;
}

function toScreenError(kind: ScreenError['kind'], error: unknown): ScreenError {
  if (error instanceof AppIconError) {
    return { kind, code: error.code, message: error.message };
  }
  return {
    kind,
    code: 'E_UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
  };
}

export default function AppIconScreen() {
  if (!isAppIconSwitchingSupported()) {
    return <UnsupportedPlatform />;
  }
  return <AppIconPicker />;
}

function UnsupportedPlatform() {
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Choose App Icon
        </Text>
        <Text style={styles.subtitle}>
          Seasonal app icons are currently available on Android and iOS only.
        </Text>
      </View>
    </SafeAreaView>
  );
}

function AppIconPicker() {
  const [status, setStatus] = useState<Status>('loading');
  // null means "unknown": never pretend Default is active when a read failed.
  const [current, setCurrent] = useState<AppIconName | null>(null);
  const [pending, setPending] = useState<AppIconName | null>(null);
  const [error, setError] = useState<ScreenError | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const currentRef = useRef<AppIconName | null>(null);
  // Every native call goes through this chain, so a read can never finish
  // after (and overwrite) a switch that completed later.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueue = useCallback((task: () => Promise<void>) => {
    const next = queueRef.current.then(task, task);
    queueRef.current = next.catch(() => { });
    return next;
  }, []);

  const applyCurrent = useCallback((icon: AppIconName | null) => {
    currentRef.current = icon;
    setCurrent(icon);
  }, []);

  const refresh = useCallback(
    (showLoading: boolean) =>
      enqueue(async () => {
        if (showLoading && mountedRef.current) {
          setStatus('loading');
        }
        try {
          const icon = await getIcon();
          if (!mountedRef.current) {
            return;
          }
          applyCurrent(icon);
          // A read success clears stale read errors but keeps a switch failure visible.
          setError(prev => (prev?.kind === 'read' ? null : prev));
        } catch (e) {
          if (!mountedRef.current) {
            return;
          }
          applyCurrent(null);
          setError(toScreenError('read', e));
        } finally {
          if (showLoading && mountedRef.current) {
            setStatus(busyRef.current ? 'switching' : 'ready');
          }
        }
      }),
    [applyCurrent, enqueue],
  );

  const select = useCallback(
    (icon: AppIconName) => {
      if (busyRef.current) {
        return;
      }
      // currentRef is only set from successful reads, i.e. a valid single-alias state.
      if (currentRef.current === icon) {
        return;
      }
      busyRef.current = true;
      setPending(icon);
      setStatus('switching');
      setError(null);

      enqueue(async () => {
        let switchError: ScreenError | null = null;
        try {
          await setIcon(icon);
        } catch (e) {
          switchError = toScreenError('switch', e);
        }
        // Re-read the real state whether or not the switch succeeded.
        let readError: ScreenError | null = null;
        let actual: AppIconName | null = null;
        try {
          actual = await getIcon();
        } catch (e) {
          readError = toScreenError('read', e);
        }
        if (!mountedRef.current) {
          return;
        }
        applyCurrent(actual);
        setError(switchError ?? readError);
      }).finally(() => {
        busyRef.current = false;
        if (mountedRef.current) {
          setPending(null);
          setStatus('ready');
        }
      });
    },
    [applyCurrent, enqueue],
  );

  useEffect(() => {
    mountedRef.current = true;
    refresh(true);
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active') {
        refresh(false);
      }
    });
    return () => {
      mountedRef.current = false;
      subscription.remove();
    };
  }, [refresh]);

  const busy = status !== 'ready';

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.background} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Choose App Icon
        </Text>
        <Text style={styles.subtitle}>
          Pick the icon __APP_DISPLAY_NAME__ shows in your{' '}
          {Platform.OS === 'ios' ? 'Home Screen' : 'Android launcher'}. Your choice is
          saved on this device and works offline.
        </Text>

        <View style={styles.currentRow} accessibilityLiveRegion="polite">
          {status === 'loading' ? (
            <>
              <ActivityIndicator color={COLORS.accent} />
              <Text style={styles.currentText}>Reading current icon…</Text>
            </>
          ) : status === 'switching' ? (
            <>
              <ActivityIndicator color={COLORS.accent} />
              <Text style={styles.currentText}>
                Switching to {pending ?? 'icon'}…
              </Text>
            </>
          ) : (
            <Text style={styles.currentText} testID="current-icon">
              Current icon:{' '}
              <Text style={styles.currentValue}>{current ?? 'Unknown'}</Text>
            </Text>
          )}
        </View>

        {error ? (
          <View style={styles.errorBox} accessibilityRole="alert">
            <Text style={styles.errorTitle}>
              {error.kind === 'switch'
                ? 'Could not change the icon'
                : 'Could not read the current icon'}
            </Text>
            <Text style={styles.errorText}>{error.message}</Text>
            <Text style={styles.errorCode}>{error.code}</Text>
            <View style={styles.errorActions}>
              <ActionButton
                label="Retry"
                disabled={busy}
                onPress={() => refresh(true)}
              />
              {error.code === 'E_INVALID_STATE' ? (
                <ActionButton
                  label="Restore Default"
                  disabled={busy}
                  onPress={() => select('Default')}
                />
              ) : null}
            </View>
          </View>
        ) : null}

        <View style={styles.grid}>
          {APP_ICONS.map(icon => {
            const selected = current === icon;
            return (
              <Pressable
                key={icon}
                testID={`icon-option-${icon}`}
                accessibilityRole="button"
                accessibilityLabel={`${icon} icon`}
                accessibilityHint={
                  selected ? 'Currently selected' : 'Sets this as the app icon'
                }
                accessibilityState={{ selected, disabled: busy, busy: pending === icon }}
                disabled={busy}
                onPress={() => select(icon)}
                style={({ pressed }) => [
                  styles.card,
                  selected && styles.cardSelected,
                  busy && !selected && styles.cardDisabled,
                  pressed && styles.cardPressed,
                ]}>
                <Image
                  source={PREVIEWS[icon]}
                  style={styles.preview}
                  accessibilityIgnoresInvertColors
                />
                <Text style={styles.cardLabel}>{icon}</Text>
                <Text
                  style={[styles.cardBadge, selected && styles.cardBadgeSelected]}>
                  {selected ? '✓ Selected' : pending === icon ? 'Applying…' : 'Tap to use'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.note}>
          Return to your home screen to see the updated icon. Some launchers may
          take a moment to refresh.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function ActionButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        disabled && styles.cardDisabled,
        pressed && styles.cardPressed,
      ]}>
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

const COLORS = {
  background: '#F6F4EF',
  surface: '#FFFFFF',
  text: '#1B1B1F',
  muted: '#4A4A55',
  border: '#DDD8CC',
  accent: '#0F5C4C',
  accentSoft: '#E3F1EC',
  error: '#8A1C1C',
  errorSoft: '#FCEBEB',
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    paddingHorizontal: 20,
    // Android draws under the status bar (edge-to-edge); iOS uses SafeAreaView.
    paddingTop: (Platform.OS === 'android' ? StatusBar.currentHeight ?? 24 : 0) + 24,
    paddingBottom: 48,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: COLORS.text,
  },
  subtitle: {
    marginTop: 8,
    fontSize: 16,
    lineHeight: 22,
    color: COLORS.muted,
  },
  currentRow: {
    marginTop: 20,
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  currentText: {
    fontSize: 16,
    color: COLORS.text,
  },
  currentValue: {
    fontWeight: '700',
    color: COLORS.accent,
  },
  errorBox: {
    marginTop: 16,
    padding: 14,
    borderRadius: 12,
    backgroundColor: COLORS.errorSoft,
    borderWidth: 1,
    borderColor: COLORS.error,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.error,
  },
  errorText: {
    marginTop: 4,
    fontSize: 14,
    lineHeight: 20,
    color: COLORS.text,
  },
  errorCode: {
    marginTop: 4,
    fontSize: 12,
    color: COLORS.muted,
  },
  errorActions: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  actionButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.error,
  },
  actionLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.error,
  },
  grid: {
    marginTop: 20,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 14,
  },
  card: {
    width: '48%',
    minHeight: 160,
    padding: 14,
    alignItems: 'center',
    borderRadius: 16,
    backgroundColor: COLORS.surface,
    borderWidth: 2,
    borderColor: COLORS.border,
  },
  cardSelected: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentSoft,
  },
  cardDisabled: {
    opacity: 0.55,
  },
  cardPressed: {
    opacity: 0.8,
  },
  preview: {
    width: 72,
    height: 72,
    borderRadius: 16,
  },
  cardLabel: {
    marginTop: 10,
    fontSize: 17,
    fontWeight: '600',
    color: COLORS.text,
  },
  cardBadge: {
    marginTop: 4,
    fontSize: 13,
    color: COLORS.muted,
  },
  cardBadgeSelected: {
    color: COLORS.accent,
    fontWeight: '700',
  },
  note: {
    marginTop: 24,
    fontSize: 14,
    lineHeight: 20,
    color: COLORS.muted,
  },
});
