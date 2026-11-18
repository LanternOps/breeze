import { endDesktopSession, type EndDesktopSessionResult } from './api';
import type { AuthenticatedConnectionParams } from './webrtc';

export type SessionHangUpResult = EndDesktopSessionResult | 'skipped';

/**
 * #11931: send End for the current desktop session at most once.
 *
 * Used by the viewer's own Disconnect (`handleDisconnect`); a repeat call for
 * the same session gets the first call's promise instead of a second request.
 * A transport switch that minted a new session ends the new one. Closing the
 * window ends the session natively instead (#12129, lib/nativeSessionEnd.ts).
 *
 * Skipped when there is no desktop session to end: a VNC tunnel connection
 * carries an empty `sessionId` (its tunnel is closed separately), and a
 * connection that never authenticated has no token.
 *
 * Never rejects: the hang-up sequence awaits it before closing the window.
 */
export function createSessionHangUp(end: typeof endDesktopSession = endDesktopSession) {
  let sent: { sessionId: string; promise: Promise<SessionHangUpResult> } | null = null;
  return (auth: AuthenticatedConnectionParams | null): Promise<SessionHangUpResult> => {
    if (!auth?.sessionId || !auth.accessToken) return Promise.resolve('skipped');
    if (sent?.sessionId === auth.sessionId) return sent.promise;
    // Promise.resolve().then: a synchronous throw from `end` is caught too.
    const promise = Promise.resolve()
      .then(() => end(auth.apiUrl, auth.accessToken, auth.sessionId))
      .catch((): SessionHangUpResult => 'failed');
    sent = { sessionId: auth.sessionId, promise };
    return promise;
  };
}

export interface HangUpThenCloseOptions {
  /** Sends End for the session being hung up. */
  hangUp: () => Promise<unknown>;
  /** The session's transports, closed in order once End has settled. */
  closers: ReadonlyArray<readonly [what: string, close: () => void]>;
  /**
   * Whether the hung-up session is still the one this window shows. False
   * once the window has been reused for a newer session while End was in flight.
   */
  isCurrent: () => boolean;
  /** Closes the window. */
  onDone: () => void;
}

/**
 * #11931 / #12129: the viewer's own hang-up. End goes out BEFORE the peer is
 * closed, so the agent does not report the peer drop first and the row ends as
 * `operator_ended`, not `peer_disconnected`.
 *
 * Once End settles (it is bounded and never rejects), every closer runs, each
 * guarded so one that throws cannot stop the rest or keep the window open.
 * The window is closed only if the session is still current: a late
 * continuation must not close a window that a newer session has reused. The
 * old session's transports are still closed, since nothing else holds them.
 */
export async function hangUpThenClose({ hangUp, closers, isCurrent, onDone }: HangUpThenCloseOptions): Promise<void> {
  try {
    await hangUp();
  } catch (err) {
    // hangUp is not meant to reject; if it does, still tear down.
    console.error('Ending the session failed unexpectedly; closing anyway:', err);
  }
  try {
    for (const [what, close] of closers) {
      try {
        close();
      } catch (err) {
        console.error(`Failed to close the ${what} on disconnect:`, err);
      }
    }
  } finally {
    if (isCurrent()) onDone();
  }
}
