import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from 'react-native-paper';

import { LoginScreen } from '../screens/auth/LoginScreen';
import { MfaChallengeScreen } from '../screens/auth/MfaChallengeScreen';
import { ServerSelectScreen } from '../screens/auth/ServerSelectScreen';
import { getServerUrl } from '../services/serverConfig';
import { useAppSelector } from '../store';

export type AuthStackParamList = {
  ServerSelect: { initialUrl?: string | null } | undefined;
  Login: undefined;
  MfaChallenge: undefined;
};

const Stack = createNativeStackNavigator<AuthStackParamList>();

export function AuthNavigator() {
  const theme = useTheme();
  const mfaChallenge = useAppSelector((state) => state.auth.mfaChallenge);
  const [initialRoute, setInitialRoute] = useState<keyof AuthStackParamList | null>(null);
  const [initialUrl, setInitialUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const url = await getServerUrl();
      if (cancelled) return;
      setInitialUrl(url);
      setInitialRoute(url ? 'Login' : 'ServerSelect');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!initialRoute) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: theme.colors.background,
        }}
      >
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (mfaChallenge) {
    return (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="MfaChallenge" component={MfaChallengeScreen} />
      </Stack.Navigator>
    );
  }

  return (
    <Stack.Navigator
      initialRouteName={initialRoute}
      screenOptions={{ headerShown: false }}
    >
      <Stack.Screen name="ServerSelect">
        {({ navigation, route }) => (
          <ServerSelectScreen
            initialUrl={route.params?.initialUrl ?? initialUrl}
            onSelected={() => navigation.replace('Login')}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Login" component={LoginScreen} />
    </Stack.Navigator>
  );
}
