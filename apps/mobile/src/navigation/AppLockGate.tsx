import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

import { useAppDispatch, useAppSelector } from '../store';
import { logoutAsync } from '../store/authSlice';
import {
  authenticateWithBiometrics,
  getBiometricTypeName,
  getSecurityLevel,
} from '../services/biometrics';
import { LOCK_GRACE_MS } from '../services/appLockState';
import { readAppLockState, writeAppLockState } from '../services/appLockStore';
import {
  initialLockState,
  reduceLock,
  type AppLifecycle,
  type LockEvent,
} from '../services/appLockMachine';
import { reportInternalError } from '../lib/errorReporting';
import { palette, radii, spacing, type } from '../theme';

/**
 * App lock + app-switcher privacy cover.
 *
 * This app approves privileged PAM/UAC elevation requests and shows customer
 * fleet data, so leaving it readable after the technician switches away is a
 * real exposure. Two distinct protections live here, and they are NOT the same
 * mechanism:
 *
 *  1. **Privacy cover** — rendered whenever the app is not `active`, and while
 *     the cold-launch check is still running. iOS snapshots the UI on the way
 *     out to `inactive` to build the app-switcher card, and writes that
 *     snapshot to disk. Covering on `inactive` (not just `background`) is what
 *     keeps fleet data and pending approvals out of both the switcher and that
 *     on-disk image.
 *
 *  2. **Lock** — requires device authentication to get back in. Within one
 *     process that means after {@link LOCK_GRACE_MS} in the `background`;
 *     locking on bare `inactive` would be unusable, since the Face ID sheet,
 *     Control Centre and incoming-call banners all flip the app to `inactive`
 *     and the biometric prompt doing so would make the unlock re-trigger a
 *     lock. Across a cold launch the same grace window applies, plus
 *     fail-secure defaults a resume does not need — most importantly, no
 *     persisted record at all locks.
 *
 * **This component holds no decisions.** Every rule lives in the pure
 * `services/appLockMachine.ts`, because `vitest.config.ts` includes only `.ts`
 * and so nothing in a `.tsx` file can be reached by a test. What remains here
 * is wiring: subscribe to `AppState`, run the biometric prompt, perform the
 * writes the machine asks for, render. Put logic back in this file and it
 * becomes untestable again — which is how the background-launch bypass that
 * `bootResolved` now closes went unnoticed in the first place.
 */
interface Props {
  children: React.ReactNode;
}

export function AppLockGate({ children }: Props) {
  const dispatch = useAppDispatch();
  const token = useAppSelector((s) => s.auth.token);

  const [lock, setLock] = useState(initialLockState);
  const [unlocking, setUnlocking] = useState(false);
  const [biometricName, setBiometricName] = useState('Face ID');

  // The machine's state is mirrored in a ref so `send` can stay referentially
  // stable: the AppState listener is registered once and would otherwise close
  // over a stale snapshot. Written only from event handlers, never during
  // render, so a discarded concurrent render cannot leave it lying.
  const machine = useRef(initialLockState);
  const lifecycle = useRef<AppLifecycle>((AppState.currentState ?? 'unknown') as AppLifecycle);
  const bootStarted = useRef(false);
  // Mirrored so the always-on AppState listener below can consult the live
  // session without re-subscribing (and missing transitions) on every change.
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const send = useCallback((event: LockEvent) => {
    const { state, persist } = reduceLock(machine.current, event, LOCK_GRACE_MS);
    machine.current = state;
    setLock(state);
    if (persist) void writeAppLockState(persist);
  }, []);

  useEffect(() => {
    getBiometricTypeName().then(setBiometricName).catch(() => {});
  }, []);

  // No session, nothing to protect — and covering the login screen would just
  // make sign-in flicker. This also releases the lock the sign-out path holds
  // until the session is actually gone; both logoutAsync outcomes clear the
  // token, so it always arrives.
  useEffect(() => {
    if (token) return;
    send({ type: 'signedOut' });
  }, [token, send]);

  // Cold-launch check, at most once per process. Runs the first time this
  // process sees a session, which is either a restore from the keychain (lock
  // per the persisted record) or an interactive sign-in, where
  // `markAppLockUnlocked` has just stamped a fresh unlocked record.
  useEffect(() => {
    if (!token || bootStarted.current) return;
    bootStarted.current = true;

    let cancelled = false;
    void (async () => {
      const record = await readAppLockState();
      // Dropping the result when the session vanished mid-read is what keeps a
      // late verdict from locking the login screen; the `signedOut` effect above
      // has already cleared the cover by then.
      if (cancelled) return;
      // Ask React Native for the lifecycle NOW rather than trusting the value
      // captured at mount. On iOS the JS bundle evaluates while the process is
      // still `inactive` (before `applicationDidBecomeActive`), and any
      // transition that fires before our own listener attaches — or during an
      // interactive sign-in, when the login screen's autofill / Face ID sheet
      // bounces the app through `inactive` — is missed by the ref. A stale
      // non-`active` value here raised the privacy cover with no later event to
      // lower it, which is the "stuck on the Breeze wordmark after login" bug.
      // `AppState.currentState` is maintained by RN from the same event stream
      // and is never stale in that way.
      const current = (AppState.currentState ?? lifecycle.current) as AppLifecycle;
      lifecycle.current = current;
      send({
        type: 'bootResolved',
        record,
        lifecycle: current,
        now: Date.now(),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [token, send]);

  // Subscribed for the life of the component, NOT only while signed in: the
  // `lifecycle` ref must track every transition, including the ones that happen
  // on the login screen, or the cold-launch check reads a stale value (see the
  // boot effect above). Only the *machine* is gated on the session — a
  // signed-out app must never stamp the record, since an unlocked stamp written
  // after sign-out would outlive the session it describes.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const prev = lifecycle.current;
      lifecycle.current = next as AppLifecycle;
      if (!tokenRef.current) return;
      send({ type: 'lifecycle', prev, next: next as AppLifecycle, now: Date.now() });
    });
    return () => sub.remove();
  }, [send]);

  const attemptUnlock = useCallback(async () => {
    setUnlocking(true);
    try {
      const ok = await authenticateWithBiometrics('Unlock Breeze');
      send(ok ? { type: 'unlockSucceeded', now: Date.now() } : { type: 'unlockRejected' });
    } catch (error) {
      // `authenticateWithBiometrics` swallows internally today, so this is
      // defensive — but without it a throw would leave the button dead: no
      // failure copy, no telemetry, and an unhandled rejection.
      reportInternalError(error, 'app-lock-unlock');
      send({ type: 'unlockRejected' });
    } finally {
      setUnlocking(false);
    }
  }, [send]);

  // Prompt as soon as the lock screen appears, so the common case is a single
  // glance rather than "tap Unlock, then look". Neither a rejected unlock nor an
  // unavailable authenticator changes `phase`, so this cannot re-fire into a
  // prompt loop — the user drives retries from the button.
  useEffect(() => {
    if (lock.phase !== 'locked' || lock.signingOut || lock.authUnavailable) return;
    let cancelled = false;

    void (async () => {
      let level: LocalAuthentication.SecurityLevel;
      try {
        level = await getSecurityLevel();
      } catch (error) {
        // "I could not find out" is not "there is no authenticator". Fail
        // closed; the Sign out button remains the way forward.
        if (cancelled) return;
        reportInternalError(error, 'app-lock-security-level');
        send({ type: 'authenticatorUnavailable' });
        return;
      }
      if (cancelled) return;

      if (level === LocalAuthentication.SecurityLevel.NONE) {
        send({ type: 'noAuthenticator' });
        return;
      }
      await attemptUnlock();
    })();

    return () => {
      cancelled = true;
    };
  }, [lock.phase, lock.signingOut, lock.authUnavailable, attemptUnlock, send]);

  return (
    <View style={{ flex: 1 }}>
      {children}
      {lock.phase === 'locked' ? (
        <LockScreen
          biometricName={biometricName}
          busy={unlocking || lock.signingOut}
          failed={lock.unlockFailed}
          authUnavailable={lock.authUnavailable}
          signingOut={lock.signingOut}
          onUnlock={attemptUnlock}
          onSignOut={() => {
            send({ type: 'signOutRequested', now: Date.now() });
            void dispatch(logoutAsync({ deliberate: true }));
          }}
        />
      ) : lock.obscured || (lock.phase === 'booting' && Boolean(token)) ? (
        <PrivacyCover />
      ) : null}
    </View>
  );
}

/**
 * Opaque brand-coloured cover; deliberately shows no account or fleet data.
 *
 * Caveat worth knowing before trusting this for a threat model: it is driven
 * from JS via `AppState`, so covering happens on the next React render after
 * iOS reports `inactive`. That is ordinarily well before the system grabs its
 * app-switcher snapshot, but it is not a guarantee — closing the race properly
 * needs a native `applicationWillResignActive` hook that adds a UIView, which
 * this JS-only approach cannot do.
 */
function PrivacyCover() {
  return (
    <View
      style={{
        ...StyleSheetAbsoluteFill,
        backgroundColor: palette.dark.bg0,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={[type.display, { color: palette.dark.textHi }]}>Breeze</Text>
    </View>
  );
}

function lockScreenCopy({
  biometricName,
  authUnavailable,
  signingOut,
  failed,
}: {
  biometricName: string;
  authUnavailable: boolean;
  signingOut: boolean;
  failed: boolean;
}): string {
  if (signingOut) return 'Signing out…';
  if (authUnavailable) {
    return "Couldn't check this device's security settings. Try again, or sign out.";
  }
  if (failed) return `${biometricName} didn't verify. Try again, or sign out.`;
  return `Locked. Unlock with ${biometricName} to continue.`;
}

function LockScreen({
  biometricName,
  busy,
  failed,
  authUnavailable,
  signingOut,
  onUnlock,
  onSignOut,
}: {
  biometricName: string;
  busy: boolean;
  failed: boolean;
  authUnavailable: boolean;
  signingOut: boolean;
  onUnlock: () => void;
  onSignOut: () => void;
}) {
  return (
    <View
      style={{
        ...StyleSheetAbsoluteFill,
        backgroundColor: palette.dark.bg0,
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacing[6],
      }}
    >
      <Text style={[type.display, { color: palette.dark.textHi }]}>Breeze</Text>
      <Text
        style={[
          type.bodyMd,
          { color: palette.dark.textMd, marginTop: spacing[3], textAlign: 'center' },
        ]}
      >
        {lockScreenCopy({ biometricName, authUnavailable, signingOut, failed })}
      </Text>

      <Pressable
        onPress={onUnlock}
        disabled={busy}
        accessibilityRole="button"
        style={({ pressed }) => ({
          marginTop: spacing[6],
          paddingHorizontal: spacing[6],
          paddingVertical: spacing[4],
          borderRadius: radii.lg,
          backgroundColor: palette.brand.base,
          opacity: busy ? 0.5 : pressed ? 0.85 : 1,
        })}
      >
        <Text style={[type.bodyMd, { color: palette.dark.textHi }]}>
          {busy ? 'Unlocking…' : `Unlock with ${biometricName}`}
        </Text>
      </Pressable>

      <Pressable
        onPress={onSignOut}
        disabled={signingOut}
        accessibilityRole="button"
        hitSlop={8}
        style={({ pressed }) => ({
          marginTop: spacing[5],
          opacity: signingOut ? 0.5 : pressed ? 0.7 : 1,
        })}
      >
        <Text style={[type.meta, { color: palette.dark.textLo }]}>Sign out</Text>
      </Pressable>
    </View>
  );
}

// Inlined rather than StyleSheet.absoluteFillObject so both overlays share one
// definition without a StyleSheet import in a file that is otherwise all logic.
const StyleSheetAbsoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;
