import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { LoginScreen } from '../screens/auth/LoginScreen';
import { MfaChallengeScreen } from '../screens/auth/MfaChallengeScreen';
import { ServerSelectScreen } from '../screens/auth/ServerSelectScreen';
import { getServerUrl } from '../services/serverConfig';
import { useAppSelector } from '../store';
import { Spinner } from '../components/Spinner';
import { palette, fontFamily } from '../theme';

export type AuthStackParamList = {
  ServerSelect: { initialUrl?: string | null } | undefined;
  Login: undefined;
  MfaChallenge: undefined;
};

const Stack = createNativeStackNavigator<AuthStackParamList>();

export function AuthNavigator() {
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
          backgroundColor: palette.dark.bg0,
        }}
      >
        <Spinner size={28} color={palette.brand.base} />
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
      screenOptions={{
        headerStyle: { backgroundColor: palette.dark.bg0 },
        headerShadowVisible: false,
        headerTintColor: palette.dark.textHi,
        headerTitleStyle: {
          fontFamily: fontFamily.sansSemiBold,
          fontSize: 17,
          color: palette.dark.textHi,
        },
        contentStyle: { backgroundColor: palette.dark.bg0 },
        headerShown: false,
      }}
    >
      <Stack.Screen
        name="ServerSelect"
        options={{ headerShown: true, title: 'Server' }}
      >
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
