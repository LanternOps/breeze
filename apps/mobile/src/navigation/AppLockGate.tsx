import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, Pressable, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

import { useAppDispatch, useAppSelector } from '../store';
import { logoutAsync } from '../store/authSlice';
import {
  authenticateWithBiometrics,
  getBiometricTypeName,
  getSecurityLevel,
} from '../services/biometrics';
import { palette, radii, spacing, type } from '../theme';

/**
 * App lock + app-switcher privacy cover.
 *
 * This app approves privileged PAM/UAC elevation requests and shows customer
 * fleet data, so leaving it readable after the technician switches away is a
 * real exposure. Two distinct protections live here, and they are NOT the same
 * mechanism:
 *
 *  1. **Privacy cover** — rendered whenever the app is not `active`. iOS
 *     snapshots the UI on the way out to `inactive` to build the app-switcher
 *     card, and writes that snapshot to disk. Covering on `inactive` (not just
 *     `background`) is what keeps fleet data and pending approvals out of both
 *     the switcher and that on-disk image.
 *
 *  2. **Lock** — requires device authentication to get back in, but only after
 *     the app has actually been in the `background` for {@link LOCK_GRACE_MS}.
 *     Locking on bare `inactive` would be unusable: the Face ID sheet, Control
 *     Centre, and incoming-call banners all flip the app to `inactive`, and the
 *     biometric prompt doing so would make the unlock itself re-trigger a lock.
 *
 * Scope boundary: this covers background → foreground within one process
 * lifetime. A cold launch is deliberately NOT gated on biometrics — that is a
 * separate product decision, and the session restore already re-validates
 * against the server.
 */

/**
 * How long the app may sit in the background before it locks. Short enough that
 * a phone left on a desk locks, long enough that hopping to the authenticator
 * app or a password manager and straight back does not demand Face ID.
 */
export const LOCK_GRACE_MS = 60_000;

interface Props {
  children: React.ReactNode;
}

export function AppLockGate({ children }: Props) {
  const dispatch = useAppDispatch();
  const token = useAppSelector((s) => s.auth.token);

  const [obscured, setObscured] = useState(false);
  const [locked, setLocked] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockFailed, setUnlockFailed] = useState(false);
  const [biometricName, setBiometricName] = useState('Face ID');

  const backgroundedAt = useRef<number | null>(null);
  const appState = useRef<AppStateStatus>((AppState.currentState ?? 'unknown') as AppStateStatus);

  useEffect(() => {
    getBiometricTypeName().then(setBiometricName).catch(() => {});
  }, []);

  useEffect(() => {
    // No session, nothing to protect — and covering the login screen would just
    // make sign-in flicker. Reset so a later sign-in starts from a clean slate.
    if (!token) {
      setObscured(false);
      setLocked(false);
      backgroundedAt.current = null;
      return;
    }

    const sub = AppState.addEventListener('change', (next) => {
      const prev = appState.current;
      appState.current = next;

      if (next === 'active') {
        setObscured(false);
        const since = backgroundedAt.current;
        backgroundedAt.current = null;
        if (since !== null && Date.now() - since >= LOCK_GRACE_MS) {
          setUnlockFailed(false);
          setLocked(true);
        }
        return;
      }

      setObscured(true);
      // Only a real background starts the lock clock. `inactive` is transient
      // (Face ID sheet, Control Centre, call banner) and must not — in
      // particular the unlock prompt itself flips us to `inactive`, so treating
      // that as a lock trigger would make unlocking re-arm the lock.
      if (next === 'background' && prev !== 'background') {
        backgroundedAt.current = Date.now();
      }
    });

    return () => sub.remove();
  }, [token]);

  const attemptUnlock = useCallback(async () => {
    setUnlocking(true);
    try {
      const ok = await authenticateWithBiometrics('Unlock Breeze');
      if (ok) {
        setLocked(false);
        setUnlockFailed(false);
      } else {
        setUnlockFailed(true);
      }
    } finally {
      setUnlocking(false);
    }
  }, []);

  // Prompt as soon as the lock screen appears, so the common case is a single
  // glance rather than "tap Unlock, then look".
  useEffect(() => {
    if (!locked) return;
    let cancelled = false;
    (async () => {
      // A device with neither biometrics nor a passcode cannot satisfy the
      // prompt, and locking against an authenticator that does not exist would
      // strand the user with no way back in. The device itself is unprotected
      // in that case, so an app lock adds nothing anyway.
      const level = await getSecurityLevel().catch(() => LocalAuthentication.SecurityLevel.NONE);
      if (cancelled) return;
      if (level === LocalAuthentication.SecurityLevel.NONE) {
        setLocked(false);
        return;
      }
      await attemptUnlock();
    })();
    return () => {
      cancelled = true;
    };
  }, [locked, attemptUnlock]);

  return (
    <View style={{ flex: 1 }}>
      {children}
      {locked ? (
        <LockScreen
          biometricName={biometricName}
          busy={unlocking}
          failed={unlockFailed}
          onUnlock={attemptUnlock}
          onSignOut={() => {
            setLocked(false);
            void dispatch(logoutAsync());
          }}
        />
      ) : obscured ? (
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

function LockScreen({
  biometricName,
  busy,
  failed,
  onUnlock,
  onSignOut,
}: {
  biometricName: string;
  busy: boolean;
  failed: boolean;
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
        {failed
          ? `${biometricName} didn't verify. Try again, or sign out.`
          : `Locked. Unlock with ${biometricName} to continue.`}
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
        accessibilityRole="button"
        hitSlop={8}
        style={({ pressed }) => ({ marginTop: spacing[5], opacity: pressed ? 0.7 : 1 })}
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
