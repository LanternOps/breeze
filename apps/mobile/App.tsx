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

Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.EXPO_PUBLIC_SENTRY_DSN && !__DEV__,
  tracesSampleRate: 0.1,
  enableNative: true,
});

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

import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as Font from 'expo-font';
import { Provider as ReduxProvider, useDispatch, useSelector } from 'react-redux';
import { Provider as PaperProvider, MD3DarkTheme, MD3LightTheme } from 'react-native-paper';
import { ActivityIndicator, useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { store, type AppDispatch, type RootState } from './src/store';
import { RootNavigator } from './src/navigation/RootNavigator';
import { registerForPushNotifications } from './src/services/notifications';
import { setPushRegistration } from './src/store/authSlice';
import { palette } from './src/theme';

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
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    Font.loadAsync({
      'Geist-Regular':     require('./assets/fonts/Geist-Regular.otf'),
      'Geist-Medium':      require('./assets/fonts/Geist-Medium.otf'),
      'Geist-SemiBold':    require('./assets/fonts/Geist-SemiBold.otf'),
      'GeistMono-Regular': require('./assets/fonts/GeistMono-Regular.otf'),
      'GeistMono-Medium':  require('./assets/fonts/GeistMono-Medium.otf'),
    })
      .catch((err) => console.warn('Font load failed:', err))
      .finally(() => setFontsReady(true));
  }, []);

  if (!fontsReady) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: palette.dark.bg0 }}>
        <ActivityIndicator color={palette.brand.base} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ReduxProvider store={store}>
        <PaperProvider theme={theme}>
          <SafeAreaProvider>
            <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
            <PushRegistrationGate />
            <RootNavigator />
          </SafeAreaProvider>
        </PaperProvider>
      </ReduxProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(App);
