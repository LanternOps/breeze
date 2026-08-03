// Initialize Sentry as early as possible — must run before any other imports
// that might throw, so crashes during startup are still captured.
// `enabled` guards on (a) DSN being set and (b) not running in dev, so shipping
// without a configured DSN is a no-op.
//
// TODO(release): wire EAS Build + sentry-cli source-map upload before App
// Store release. Without source maps, native/JS stack traces in Sentry will
// reference minified bundle positions. See:
// https://docs.sentry.io/platforms/react-native/sourcemaps/uploading/expo/
import * as Sentry from '@sentry/react-native';

const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn: SENTRY_DSN,
  enabled: !!SENTRY_DSN && !__DEV__,
  tracesSampleRate: 0.1,
  enableNative: true,
});

// A release build with no DSN reports nothing, and does so silently — which is
// how a TestFlight build ended up with zero telemetry while code all over the
// app was dutifully calling `Sentry.captureMessage` for failures that are
// invisible in the UI. There is no console to read in TestFlight, so the only
// place this can be caught is at build time: `scripts/preflight.mjs` (pnpm
// preflight) fails a DSN-less release build. This warning covers the dev loop.
if (!SENTRY_DSN && __DEV__) {
  console.warn(
    '[breeze] EXPO_PUBLIC_SENTRY_DSN is not set — crash and error reporting is disabled. ' +
      'Fine for local dev; a release build without it ships blind. See .env.example.'
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
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { store, type AppDispatch, type RootState } from './src/store';
import { RootNavigator } from './src/navigation/RootNavigator';
import { AppLockGate } from './src/navigation/AppLockGate';
import { registerForPushNotifications } from './src/services/notifications';
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

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      const outcome = await registerForPushNotifications();
      if (cancelled) return;
      dispatch(setPushRegistration({ status: outcome.status, reason: outcome.status === 'ok' ? null : outcome.reason }));
    })();
    return () => { cancelled = true; };
  }, [token, dispatch]);

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
