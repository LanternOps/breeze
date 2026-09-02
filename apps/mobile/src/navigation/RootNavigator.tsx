import { useCallback, useEffect, useRef, useState } from 'react';
import { NavigationContainer, DefaultTheme as NavDefaultTheme } from '@react-navigation/native';
import { Alert, Pressable, Text, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import * as Sentry from '@sentry/react-native';

import { useAppSelector, useAppDispatch, store } from '../store';
import {
  setCredentials,
  logout,
  logoutAsync,
  setApproverRegistration,
  clearAuthenticatorRegisterGrant,
} from '../store/authSlice';
import { getStoredToken, getStoredUser } from '../services/auth';
import { getCurrentUser, onDeviceBlocked } from '../services/api';
import { resetTruncationTracking } from '../services/truncationReporting';
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
import { PushTapRouter } from './PushTapRouter';
import { flushPendingNavigation, navigationRef } from './navigationRef';
import { OnboardingScreen } from '../screens/onboarding/OnboardingScreen';
import { Spinner } from '../components/Spinner';
import { palette } from '../theme';
import { MfaEnrollmentRequiredScreen } from '../screens/auth/MfaEnrollmentRequiredScreen';

/**
 * Upper bound on how long the native splash may stay up waiting for boot.
 * Boot is local-storage-only now, so exceeding this means something is wrong —
 * better to show the app (and whatever error state it is in) than to sit on a
 * splash that looks like a frozen launch.
 */
const SPLASH_MAX_HOLD_MS = 4000;

export function RootNavigator() {
  const dispatch = useAppDispatch();
  const { token, user, mfaEnrollmentRequired } = useAppSelector((state) => state.auth);
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
      // A blocked device is an INVOLUNTARY invalidation: the unsent
      // time-entry backlog is kept (services/auth.ts).
      void dispatch(logoutAsync({ deliberate: false }));
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
      // Same reason, one layer down: the truncation tracker is module scope and
      // outlives the session, so a previous account's "already reported" state
      // would silently swallow the FIRST report for the next one — and the
      // login screen can point at a different server entirely.
      resetTruncationTracking();
    }
  }, [user]);

  // Once we're authenticated (fresh login or restored session), silently make
  // this phone an approver. Idempotent + fails open — never blocks the UI and
  // never prompts for biometrics here (the first real approval is the first
  // Face ID, which also activates the key server-side).
  //
  // "Fails open" must not mean "fails invisibly": we record the outcome so
  // ApprovalGate can warn when registration failed, otherwise every approval
  // from this phone is silently capped at L1.
  // `active` is not an optimisation: checkAuth dispatches setCredentials twice
  // on a cold start (cached user, then the fresh one from /auth/me), so this
  // effect re-runs with a new `user` identity while the first registration call
  // is still in flight. Without the guard the slower call wins, and worse — a
  // call started for user A can resolve after A signed out and B signed in,
  // writing A's outcome into B's session.
  useEffect(() => {
    if (!token || !user || mfaEnrollmentRequired) return;
    let active = true;
    // #2707 read-and-clear: take the login-minted grant OUT of Redux before the
    // async attempt. The grant is deliberately NOT in this effect's deps — the
    // effect re-fires on every `user` identity change (checkAuth double-fires on
    // cold start), and a replayed single-use grant would 403 and overwrite a
    // successful registration with `failed`.
    const registerGrant = store.getState().auth.authenticatorRegisterGrantId;
    if (registerGrant) dispatch(clearAuthenticatorRegisterGrant());
    void ensureApproverDevice(undefined, registerGrant ?? undefined).then((outcome) => {
      if (!active) return;
      if (outcome.status === 'failed') {
        // Telemetry only, so a silent registration failure is at least visible
        // in Sentry — this is otherwise invisible until the user reports it.
        // NEVER include the grant value here; it's a single-use credential.
        Sentry.captureMessage('approver-device registration failed', {
          level: 'warning',
          tags: { area: 'approver-device-registration', reason: outcome.reason },
        });
      }
      dispatch(
        setApproverRegistration({
          status: outcome.status === 'already_registered' ? 'registered' : outcome.status,
          reason: 'reason' in outcome ? outcome.reason : null,
        })
      );
    });
    return () => {
      active = false;
    };
  }, [token, user, mfaEnrollmentRequired, dispatch]);

  useEffect(() => {
    /**
     * Re-validate a restored session against the server. Deliberately NOT
     * awaited by `checkAuth` — see the comment there.
     */
    async function revalidate(storedToken: string) {
      try {
        const fresh = await getCurrentUser();
        // Refresh the cached user with whatever the server returned
        // (name / email / role may have changed since last login).
        dispatch(setCredentials({ token: storedToken, user: fresh }));
      } catch (err) {
        const status = (err as { statusCode?: number } | null)?.statusCode;
        if (status === 401 || status === 403) {
          // The synchronous logout action advances generation and enqueues the
          // complete secure wipe before publishing signed-out Redux state.
          dispatch(logout());
        }
        // Other failures (network down, 5xx) intentionally leave the
        // cached credentials in place; the user can still operate
        // offline-friendly surfaces (approvals via push, cached state).
      }
    }

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

        // Hydrate from storage and let the UI mount IMMEDIATELY. Validation
        // against /auth/me runs detached in the background: awaiting it here
        // is what made cold start feel like a hang, because the whole tree
        // stayed behind a spinner until a network round-trip completed (and
        // fetches have a timeout but it is still seconds on a bad link).
        // A session that turns out to be revoked flips to AuthNavigator a
        // moment later via the `logout()` in `revalidate`.
        dispatch(setCredentials({ token: storedToken, user: storedUser }));
        void revalidate(storedToken);
      } catch (error) {
        console.error('Error checking auth:', error);
        dispatch(logout());
      } finally {
        setIsCheckingAuth(false);
      }
    }

    checkAuth();
  }, [dispatch]);

  // Boot gate: local storage reads only, so this clears in milliseconds.
  // `auth.isLoading` is deliberately NOT part of it — it is also true during an
  // interactive login, and including it replaced the whole LoginScreen with a
  // full-screen spinner on every sign-in attempt (LoginScreen has its own
  // in-button spinner for that).
  const booting = isCheckingAuth || hasOnboarded === null;

  // Hand off from the native splash only once there is a real frame to show, so
  // the user never sees a bare spinner on a dark screen. The timeout is a
  // safety net: if boot somehow never completes, an app stuck on the splash is
  // indistinguishable from a crash, so uncover it and let the in-app spinner
  // (or an error state) be visible instead.
  useEffect(() => {
    if (!booting) {
      SplashScreen.hideAsync().catch(() => {});
      return;
    }
    const t = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, SPLASH_MAX_HOLD_MS);
    return () => clearTimeout(t);
  }, [booting]);

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

  if (booting) {
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
    <NavigationContainer theme={navigationTheme} ref={navigationRef} onReady={flushPendingNavigation}>
      {/* Mandatory MFA enrollment outranks everything, ticket taps included:
          PushTapRouter is not mounted in that branch, so a buffered tap waits
          rather than navigating past the gate. */}
      {mfaEnrollmentRequired ? (
        <MfaEnrollmentRequiredScreen />
      ) : token ? (
        hasOnboarded ? (
          // PushTapRouter is a SIBLING of ApprovalGate, never a child (#4336).
          // ApprovalGate renders <ApprovalScreen /> INSTEAD of its children
          // while an approval is focused, so nesting the router would tear its
          // notification subscriptions down for the whole approval lifecycle
          // and silently stop routing ticket taps. It stays inside the
          // authenticated + onboarded branch so a tap never navigates a
          // signed-out container.
          <>
            <PushTapRouter />
            <ApprovalGate>
              <MainNavigator />
            </ApprovalGate>
          </>
        ) : (
          <OnboardingScreen onComplete={handleOnboardingComplete} />
        )
      ) : (
        <AuthNavigator />
      )}
    </NavigationContainer>
  );
}
