/**
 * Auth phase machine (spec §3 + §11):
 *   loading → silent Office SSO → ready
 *                              ↘ blocked (not_provisioned / disabled / no-access / inactive / retryable)
 *                              ↘ signin (silent failed; button triggers SSO→MSAL-popup chain)
 * A stored unexpired session short-circuits straight to ready.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AuthBlockedError,
  getStoredSession,
  signIn,
  type AuthBlockKind,
  type ClientSession,
} from './auth/session';
import { BlockedScreen } from './components/BlockedScreen';
import { SignInScreen } from './components/SignInScreen';
import { ChatPane } from './components/ChatPane';

type Phase =
  | { name: 'loading' }
  | { name: 'signin'; failed: boolean }
  | { name: 'blocked'; kind: AuthBlockKind }
  | { name: 'ready'; session: ClientSession };

export function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  useEffect(() => {
    const restored = getStoredSession();
    if (restored) {
      setPhase({ name: 'ready', session: restored });
      return;
    }
    let cancelled = false;
    // Silent path only — popups are blocked outside user gestures.
    signIn({ interactive: false })
      .then((session) => {
        if (!cancelled) setPhase({ name: 'ready', session });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof AuthBlockedError) setPhase({ name: 'blocked', kind: err.kind });
        else setPhase({ name: 'signin', failed: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const interactiveSignIn = useCallback(() => {
    setPhase({ name: 'loading' });
    signIn({ interactive: true })
      .then((session) => setPhase({ name: 'ready', session }))
      .catch((err: unknown) => {
        if (err instanceof AuthBlockedError) setPhase({ name: 'blocked', kind: err.kind });
        else setPhase({ name: 'signin', failed: true });
      });
  }, []);

  switch (phase.name) {
    case 'loading':
      return (
        <div className="flex h-screen items-center justify-center text-sm text-gray-400">
          Connecting to Breeze…
        </div>
      );
    case 'signin':
      return <SignInScreen failed={phase.failed} onSignIn={interactiveSignIn} />;
    case 'blocked':
      return (
        <BlockedScreen
          kind={phase.kind}
          onRetry={phase.kind === 'retryable' ? interactiveSignIn : undefined}
        />
      );
    case 'ready':
      return <ChatPane session={phase.session} />;
  }
}
