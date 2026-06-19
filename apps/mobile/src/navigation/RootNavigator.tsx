import { useCallback, useEffect, useRef, useState } from 'react';
import { NavigationContainer, DefaultTheme as NavDefaultTheme } from '@react-navigation/native';
import { Alert, Pressable, Text, View } from 'react-native';
import * as Sentry from '@sentry/react-native';

import { useAppSelector, useAppDispatch } from '../store';
import { setCredentials, logout, logoutAsync } from '../store/authSlice';
import { getStoredToken, getStoredUser, clearAuthData, SecureWipeError } from '../services/auth';
import { getCurrentUser, onDeviceBlocked } from '../services/api';
import { spacing, type } from '../theme';
import { identify as analyticsIdentify, reset as analyticsReset } from '../lib/analytics';
import {
  getOnboardingCompleted,
  setOnboardingCompleted,
} from '../services/onboarding';
import { ensureApproverDevice } from '../services/approverDevice';
import { AuthNavigator } from './AuthNavigator';
import { MainNavigator } from './MainNavigator';
import { ApprovalGate } from './ApprovalGate';
import { OnboardingScreen } from '../screens/onboarding/OnboardingScreen';
import { Spinner } from '../components/Spinner';
import { palette } from '../theme';

/**
 * Clear local auth state, tolerating a partial secure-wipe failure.
 *
 * A `SecureWipeError` is already reported to Sentry inside `clearAuthData`, so
 * we swallow only that specific error here — it must not abort the redux logout
 * that follows. Any *other* throw (a genuinely novel failure) is re-reported and
 * re-thrown rather than silently dropped, so we don't reintroduce a silent
 * failure of an unrelated kind (the exact trap #1625 fixed).
 */
async function clearAuthDataTolerant(): Promise<void> {
  try {
    await clearAuthData();
  } catch (err) {
    if (err instanceof SecureWipeError || (err as { name?: string } | null)?.name === 'SecureWipeError') {
      return; // already reported to Sentry inside clearAuthData
    }
    Sentry.captureException(err, { tags: { area: 'auth-teardown-nav' } });
    throw err;
  }
}

export function RootNavigator() {
  const dispatch = useAppDispatch();
  const { token, isLoading, user } = useAppSelector((state) => state.auth);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const blockedHandledRef = useRef(false);

  useEffect(() => {
    // Single global listener: any API call that comes back with the
    // device_blocked code flips us into the lockout screen. We also clear
    // local credentials so a remount doesn't keep re-attempting requests.
    const off = onDeviceBlocked((reason) => {
      if (blockedHandledRef.current) return;
      blockedHandledRef.current = true;
      setBlockedReason(reason);
      void dispatch(logoutAsync());
    });
    return off;
  }, [dispatch]);
  // null while we're still reading the persisted flag. Defaults to "completed"
  // (true) on read errors so a corrupted AsyncStorage never traps users.
  const [hasOnboarded, setHasOnboarded] = useState<boolean | null>(null);

  // Attribute Sentry events to the signed-in user. Cleared on sign-out so
  // crashes after logout are not falsely attributed to the previous account.
  // PostHog identify/reset mirror this so analytics events join the right
  // person on the server side.
  useEffect(() => {
    if (user) {
      Sentry.setUser({ id: user.id, email: user.email });
      analyticsIdentify(user.id, { email: user.email, name: user.name });
    } else {
      Sentry.setUser(null);
      analyticsReset();
    }
  }, [user]);

  // Once we're authenticated (fresh login or restored session), silently make
  // this phone an approver. Idempotent + fails open — never blocks the UI and
  // never prompts for biometrics here (the first real approval is the first
  // Face ID, which also activates the key server-side).
  useEffect(() => {
    if (token && user) {
      void ensureApproverDevice();
    }
  }, [token, user]);

  useEffect(() => {
    async function checkAuth() {
      try {
        const [storedToken, storedUser, onboardingDone] = await Promise.all([
          getStoredToken(),
          getStoredUser(),
          getOnboardingCompleted(),
        ]);
        setHasOnboarded(onboardingDone);

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
            // A failed secure wipe (SecureWipeError) is already reported to
            // Sentry inside clearAuthData; clearAuthDataTolerant swallows only
            // that so it can't abort the redux logout or fall through to the
            // outer catch and double-wipe. Other failures still surface.
            await clearAuthDataTolerant();
            dispatch(logout());
          }
          // Other failures (network down, 5xx) intentionally leave the
          // cached credentials in place; the user can still operate
          // offline-friendly surfaces (approvals via push, cached state).
        }
      } catch (error) {
        console.error('Error checking auth:', error);
        await clearAuthDataTolerant();
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

  const handleOnboardingComplete = useCallback(() => {
    // Persist first so a quick second mount doesn't replay the flow, then
    // flip the in-memory flag to advance into MainNavigator.
    setOnboardingCompleted().catch(() => {
      // Best-effort; the in-memory transition still happens below.
    });
    setHasOnboarded(true);
  }, []);

  if (blockedReason !== null) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          padding: spacing[6],
          backgroundColor: palette.dark.bg0,
        }}
      >
        <Text style={[type.title, { color: palette.dark.textHi, textAlign: 'center' }]}>
          This device has been deactivated
        </Text>
        <Text
          style={[
            type.bodyMd,
            {
              color: palette.dark.textMd,
              textAlign: 'center',
              marginTop: spacing[3],
            },
          ]}
        >
          {blockedReason ??
            'An administrator or one of your other devices revoked access. Sign in again on a fresh install to re-pair.'}
        </Text>
        <Pressable
          onPress={() => {
            Alert.alert(
              'Sign back in',
              'You will need to re-pair this device after signing in.',
              [{ text: 'OK' }],
            );
            blockedHandledRef.current = false;
            setBlockedReason(null);
          }}
          style={({ pressed }) => ({
            marginTop: spacing[6],
            paddingHorizontal: spacing[5],
            paddingVertical: spacing[3],
            borderRadius: 12,
            backgroundColor: pressed ? palette.brand.deep : palette.brand.base,
          })}
        >
          <Text style={[type.bodyMd, { color: '#fff' }]}>Sign in</Text>
        </Pressable>
      </View>
    );
  }

  if (isCheckingAuth || isLoading || hasOnboarded === null) {
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
        hasOnboarded ? (
          <ApprovalGate>
            <MainNavigator />
          </ApprovalGate>
        ) : (
          <OnboardingScreen onComplete={handleOnboardingComplete} />
        )
      ) : (
        <AuthNavigator />
      )}
    </NavigationContainer>
  );
}
