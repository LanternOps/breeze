// Initialize Sentry as early as possible — must run before any other imports
// that might throw, so crashes during startup are still captured.
// `enabled` guards on (a) DSN being resolvable and (b) not running in dev, so a
// dev build without a configured DSN is a no-op. A RELEASE build without one is
// no longer possible: `app.config.js` refuses to produce a config for it (see
// src/config/sentryDsn.js for why that location cannot be skipped).
//
// Source maps and dSYMs are uploaded by the `@sentry/react-native/expo` config
// plugin, wired through the `organization` / `project` options in `app.json`.
// It installs two Xcode build phases (JS source maps via `sentry-xcode.sh`,
// native dSYMs via "Upload Debug Symbols to Sentry"), both of which need
// SENTRY_AUTH_TOKEN in `.env.sentry-build-plugin` and both of which FAIL the
// archive when it is missing. `metro.config.js` uses `getSentryExpoConfig` so
// the bundle and its map carry matching debug IDs. See STORE_SUBMISSION.md.
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

// Two delivery paths on purpose. `EXPO_PUBLIC_SENTRY_DSN` is inlined by the
// Metro transform; `extra.sentryDsn` is written by `app.config.js`, which runs
// in a different build phase (the expo-constants one) and is where the
// release-build assertion lives. Reading both means the value the guard
// verified is the value the app uses, even if the two phases saw different
// environments.
//
// Both are type-checked rather than just truthiness-checked: Expo's config
// serialisation rewrites a null/undefined `extra` value into `{}`, which is
// truthy and would be passed straight to `Sentry.init` as a DSN.
const asDsn = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const SENTRY_DSN =
  asDsn(process.env.EXPO_PUBLIC_SENTRY_DSN) ?? asDsn(Constants.expoConfig?.extra?.sentryDsn);

Sentry.init({
  dsn: SENTRY_DSN,
  enabled: !!SENTRY_DSN && !__DEV__,
  tracesSampleRate: 0.1,
  enableNative: true,
});

// Deliberately NOT gated on __DEV__. It used to be, which made it unreachable
// in the only build where it mattered: a release build with no DSN reports
// nothing and said nothing, which is how this app went 90 days without
// recording a single Sentry event while code all over it dutifully called
// `captureException` for failures that have no UI.
//
// A release build should now be unable to reach this line at all — app.config.js
// fails the build first — so if it ever fires in TestFlight it means the DSN
// reached the config phase but not the bundle, which is worth seeing in
// Console.app / `xcrun devicectl` output rather than not seeing at all.
if (!SENTRY_DSN) {
  console.warn(
    '[breeze] EXPO_PUBLIC_SENTRY_DSN is not set — crash and error reporting is disabled. ' +
      'Expected in local dev; in a release build this means telemetry is dead. See .env.example.'
  );
}

// Initialize PostHog after Sentry so any throw inside analytics setup is
// captured by Sentry. The analytics module gates itself on
// EXPO_PUBLIC_POSTHOG_KEY + !__DEV__, so this is a no-op without config.
//
// PostHog identifies the user with their userId + traits (email, name).
// App Store Connect privacy form must declare:
//   - Email Address: linked to identity, App Functionality + Analytics
//   - Crash Data: already declared (Sentry)
//   - Diagnostics: already declared (Sentry)
//   - Product Interaction: linked to identity, Analytics
// PostHog does not use IDFA → App Tracking Transparency NOT required.
import { initAnalytics, track } from './src/lib/analytics';
initAnalytics();
track('app_opened');

import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { Provider as ReduxProvider, useDispatch, useSelector } from 'react-redux';
import { Provider as PaperProvider, MD3DarkTheme, MD3LightTheme } from 'react-native-paper';
import { AppState, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { store, type AppDispatch, type RootState } from './src/store';
import { RootNavigator } from './src/navigation/RootNavigator';
import { AppLockGate } from './src/navigation/AppLockGate';
import {
  registerForPushNotifications,
  reconcilePushRegistration,
} from './src/services/notifications';
import { setPushRegistration } from './src/store/authSlice';

// Hold the native splash until the first real screen is ready to paint.
// Without this the splash vanishes the instant React Native mounts, leaving the
// user on a bare spinner for the whole auth bootstrap — which reads as a hang.
// `RootNavigator` calls `hideAsync()` once its first frame is renderable; the
// catch here is required because the call rejects (harmlessly) if the splash has
// already auto-hidden, e.g. on a fast reload.
SplashScreen.preventAutoHideAsync().catch(() => {});

// The Geist faces are embedded natively by the `expo-font` config plugin (see
// app.json), so they are registered by the time the first frame paints. Their
// PostScript names are exactly the family names in `theme/typography.ts`
// (`Geist-Regular`, `GeistMono-Medium`, …), so no runtime `Font.loadAsync` — and
// no font-blocking spinner — is needed. Changing a font FILE without checking
// its PostScript name would silently fall back to San Francisco.

const customLightTheme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: '#2563eb',
    primaryContainer: '#dbeafe',
    secondary: '#64748b',
    secondaryContainer: '#f1f5f9',
    error: '#dc2626',
    errorContainer: '#fee2e2',
    background: '#ffffff',
    surface: '#ffffff',
    surfaceVariant: '#f8fafc',
  },
};

const customDarkTheme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: '#60a5fa',
    primaryContainer: '#1e3a5f',
    secondary: '#94a3b8',
    secondaryContainer: '#334155',
    error: '#f87171',
    errorContainer: '#7f1d1d',
    background: '#0f172a',
    surface: '#1e293b',
    surfaceVariant: '#334155',
  },
};

function PushRegistrationGate() {
  const dispatch = useDispatch<AppDispatch>();
  const token = useSelector((s: RootState) => s.auth.token);
  const pushRegistration = useSelector((s: RootState) => s.auth.pushRegistration);
  const pushRegistrationReason = useSelector((s: RootState) => s.auth.pushRegistrationReason);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const outcome = await registerForPushNotifications();
        if (cancelled) return;
        dispatch(setPushRegistration({ status: outcome.status, reason: outcome.status === 'ok' ? null : outcome.reason }));
      } catch (err) {
        // registerForPushNotifications is total by contract, but if anything
        // still rejects the store must not stay at 'idle' — Settings would
        // read "Checking push registration…" forever. #3143
        if (cancelled) return;
        console.warn('[push] registration threw', err);
        dispatch(setPushRegistration({
          status: 'failed',
          reason: err instanceof Error ? err.message : 'unknown',
        }));
      }
    })();
    return () => { cancelled = true; };
  }, [token, dispatch]);

  // iOS keeps the app alive when the user flips the notification permission in
  // Settings (which the Settings sheet's Notifications row now deep-links to),
  // so re-check on every foreground and correct the stored status — otherwise
  // the row and ApprovalGate's banner keep asserting a stale 'ok'. #3143
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void (async () => {
        try {
          const outcome = await reconcilePushRegistration(pushRegistration, pushRegistrationReason);
          if (cancelled || !outcome) return;
          dispatch(setPushRegistration({ status: outcome.status, reason: outcome.status === 'ok' ? null : outcome.reason }));
        } catch (err) {
          console.warn('[push] foreground permission re-check failed', err);
        }
      })();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [token, pushRegistration, pushRegistrationReason, dispatch]);

  return null;
}

function App() {
  const colorScheme = useColorScheme();
  const theme = colorScheme === 'dark' ? customDarkTheme : customLightTheme;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ReduxProvider store={store}>
        <PaperProvider theme={theme}>
          <SafeAreaProvider>
            <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
            <PushRegistrationGate />
            {/* AppLockGate wraps the navigator so the privacy overlay and the
                locked screen cover EVERY authenticated surface, including the
                ApprovalScreen takeover that ApprovalGate renders. */}
            <AppLockGate>
              <RootNavigator />
            </AppLockGate>
          </SafeAreaProvider>
        </PaperProvider>
      </ReduxProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(App);
