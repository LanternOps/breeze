import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { ActivityIndicator, View } from 'react-native';
import { useTheme } from 'react-native-paper';

import { useAppSelector, useAppDispatch } from '../store';
import { setCredentials, logout } from '../store/authSlice';
import { getStoredToken, getStoredUser } from '../services/auth';
import { AuthNavigator } from './AuthNavigator';
import { MainNavigator } from './MainNavigator';

export function RootNavigator() {
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const { token, isLoading } = useAppSelector((state) => state.auth);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      try {
        const storedToken = await getStoredToken();
        const storedUser = await getStoredUser();

        if (storedToken && storedUser) {
          dispatch(setCredentials({ token: storedToken, user: storedUser }));
        } else {
          dispatch(logout());
        }
      } catch (error) {
        console.error('Error checking auth:', error);
        dispatch(logout());
      } finally {
        setIsCheckingAuth(false);
      }
    }

    checkAuth();
  }, [dispatch]);

  const navigationTheme = {
    dark: theme.dark,
    colors: {
      primary: theme.colors.primary,
      background: theme.colors.background,
      card: theme.colors.surface,
      text: theme.colors.onSurface,
      border: theme.colors.outline,
      notification: theme.colors.error,
    },
  };

  if (isCheckingAuth || isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.background }}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer theme={navigationTheme}>
      {token ? <MainNavigator /> : <AuthNavigator />}
    </NavigationContainer>
  );
}
