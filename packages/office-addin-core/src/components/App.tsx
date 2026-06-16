/**
 * Auth phase machine (spec §3 + §11):
 *   loading → silent Office SSO → ready
 *                              ↘ blocked (not_provisioned / disabled / no-access / inactive / retryable)
 *                              ↘ signin (silent failed; button triggers SSO→MSAL-popup chain)
 * A stored unexpired session short-circuits straight to ready.
 *
 * Host-NEUTRAL: App owns only auth + phase routing. It forwards the injected
 * `host` (object-model seam) and `clientHost` (wire discriminant) straight to
 * ChatPane once a session exists, and never touches a concrete host itself.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AuthBlockedError,
  getStoredSession,
  signIn,
  type AuthBlockKind,
  type ClientSession,
} from '../auth/session';
import { BlockedScreen } from './BlockedScreen';
import { SignInScreen } from './SignInScreen';
import { ChatPane } from './ChatPane';
import { ErrorBoundary } from './ErrorBoundary';
import type { ClientHost } from '../api/types';
import type { HostAdapter } from '../host/types';

type Phase =
  | { name: 'loading' }
  | { name: 'signin'; failed: boolean }
  | { name: 'blocked'; kind: AuthBlockKind }
  | { name: 'ready'; session: ClientSession };

export function App({ host, clientHost }: { host: HostAdapter; clientHost: ClientHost }) {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  // Item-changed rebinding (the mail-model behavior) needs NO App-level effect:
  // ChatController reads the context + workbook/document/message name FRESH at
  // send time (ensureSession → captureName, send → capture), so the next turn
  // always binds the CURRENT mailbox item — even in a pinned Outlook pane that
  // survives item switches. The live context chip is refreshed independently by
  // the Composer's useSelectionAddress subscription. (A prior App effect re-read
  // captureName() and discarded the result — inert; removed to avoid a redundant
  // second subscriber on the shared seam.)

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

  // ErrorBoundary wraps every phase so an uncaught render error (a host adapter
  // throwing, a malformed payload) surfaces a readable message instead of
  // silently blanking the Office task pane.
  return <ErrorBoundary>{renderPhase()}</ErrorBoundary>;

  function renderPhase() {
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
        return <ChatPane session={phase.session} host={host} clientHost={clientHost} />;
    }
  }
}
