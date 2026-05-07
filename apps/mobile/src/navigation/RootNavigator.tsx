import { useEffect, useState } from 'react';
import { NavigationContainer, DefaultTheme as NavDefaultTheme } from '@react-navigation/native';
import { View } from 'react-native';

import { useAppSelector, useAppDispatch } from '../store';
import { setCredentials, logout } from '../store/authSlice';
import { getStoredToken, getStoredUser, clearAuthData } from '../services/auth';
import { getCurrentUser } from '../services/api';
import { AuthNavigator } from './AuthNavigator';
import { MainNavigator } from './MainNavigator';
import { ApprovalGate } from './ApprovalGate';
import { Spinner } from '../components/Spinner';
import { palette } from '../theme';

export function RootNavigator() {
  const dispatch = useAppDispatch();
  const { token, isLoading } = useAppSelector((state) => state.auth);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      try {
        const storedToken = await getStoredToken();
        const storedUser = await getStoredUser();

        if (!storedToken || !storedUser) {
          dispatch(logout());
          return;
        }

        // Optimistically hydrate from storage so the UI mounts behind the
        // ActivityIndicator while we verify, then validate the token by
        // pinging /auth/me. If the server rejects (401, expired, revoked)
        // we clear the cached credentials and fall back to AuthNavigator.
        dispatch(setCredentials({ token: storedToken, user: storedUser }));

        try {
          const fresh = await getCurrentUser();
          // Refresh the cached user with whatever the server returned
          // (name / email / role may have changed since last login).
          dispatch(setCredentials({ token: storedToken, user: fresh }));
        } catch (err) {
          const status = (err as { statusCode?: number } | null)?.statusCode;
          if (status === 401 || status === 403) {
            await clearAuthData();
            dispatch(logout());
          }
          // Other failures (network down, 5xx) intentionally leave the
          // cached credentials in place; the user can still operate
          // offline-friendly surfaces (approvals via push, cached state).
        }
      } catch (error) {
        console.error('Error checking auth:', error);
        await clearAuthData();
        dispatch(logout());
      } finally {
        setIsCheckingAuth(false);
      }
    }

    checkAuth();
  }, [dispatch]);

  const navigationTheme = {
    ...NavDefaultTheme,
    dark: true,
    colors: {
      ...NavDefaultTheme.colors,
      primary: palette.brand.base,
      background: palette.dark.bg0,
      card: palette.dark.bg1,
      text: palette.dark.textHi,
      border: palette.dark.border,
      notification: palette.deny.base,
    },
  };

  if (isCheckingAuth || isLoading) {
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

  return (
    <NavigationContainer theme={navigationTheme}>
      {token ? (
        <ApprovalGate>
          <MainNavigator />
        </ApprovalGate>
      ) : (
        <AuthNavigator />
      )}
    </NavigationContainer>
  );
}
