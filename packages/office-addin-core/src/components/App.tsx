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
import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import {
  AuthBlockedError,
  getStoredSession,
  signIn,
  type AuthBlockKind,
  type PersonaSession,
  type TechPersonaSession,
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
  | { name: 'ready'; session: PersonaSession };

export interface AppProps {
  host: HostAdapter;
  clientHost: ClientHost;
  /** Which exchange endpoint signIn hits. Defaults to '/client-ai/auth/exchange' (Word/Excel/PowerPoint unchanged). */
  exchangePath?: string;
  /** Renders a 'tech'-persona session instead of ChatPane. Omitted for Word/Excel/PowerPoint, which never see persona 'tech'. */
  techPane?: ComponentType<{ session: TechPersonaSession }>;
  /**
   * Outlook-only technician bind/re-link affordance (Task 25) — a "Technician
   * sign-in" control that opens BindFlow, supplied by Outlook's main.tsx so App
   * stays host-neutral. Rendered on the sign-in screen, on the client-resolution
   * blocked screen (`not_provisioned` — a technician hitting the client-AI 404
   * before ever binding), and on the `relink_required` blocked screen (a
   * previously-bound technician whose binding needs to be re-established).
   * Omitted entirely for Word/Excel/PowerPoint.
   */
  signInExtra?: ReactNode;
}

export function App({ host, clientHost, exchangePath, techPane, signInExtra }: AppProps) {
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
    signIn({ interactive: false, exchangePath })
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
  }, [exchangePath]);

  const interactiveSignIn = useCallback(() => {
    setPhase({ name: 'loading' });
    signIn({ interactive: true, exchangePath })
      .then((session) => setPhase({ name: 'ready', session }))
      .catch((err: unknown) => {
        if (err instanceof AuthBlockedError) setPhase({ name: 'blocked', kind: err.kind });
        else setPhase({ name: 'signin', failed: true });
      });
  }, [exchangePath]);

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
        return <SignInScreen failed={phase.failed} onSignIn={interactiveSignIn} extra={signInExtra} />;
      case 'blocked':
        return (
          <BlockedScreen
            kind={phase.kind}
            onRetry={phase.kind === 'retryable' ? interactiveSignIn : undefined}
            extra={
              phase.kind === 'not_provisioned' || phase.kind === 'relink_required'
                ? signInExtra
                : undefined
            }
          />
        );
      case 'ready':
        if (phase.session.persona === 'tech') {
          const TechPane = techPane;
          // Defensive: a tech session must never fall into the client chat, even
          // if a host that never sets `techPane` (Word/Excel/PowerPoint) somehow
          // gets one back from the exchange.
          if (!TechPane) return <BlockedScreen kind="unsupported_persona" />;
          return <TechPane session={phase.session} />;
        }
        return <ChatPane session={phase.session} host={host} clientHost={clientHost} />;
    }
  }
}
