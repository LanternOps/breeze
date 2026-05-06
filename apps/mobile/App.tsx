import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as Font from 'expo-font';
import { Provider as ReduxProvider } from 'react-redux';
import { Provider as PaperProvider, MD3DarkTheme, MD3LightTheme } from 'react-native-paper';
import { ActivityIndicator, useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { store } from './src/store';
import { RootNavigator } from './src/navigation/RootNavigator';
import { registerForPushNotifications } from './src/services/notifications';
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

export default function App() {
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

  useEffect(() => {
    // Register for push notifications on app start
    registerForPushNotifications();
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
            <RootNavigator />
          </SafeAreaProvider>
        </PaperProvider>
      </ReduxProvider>
    </GestureHandlerRootView>
  );
}
