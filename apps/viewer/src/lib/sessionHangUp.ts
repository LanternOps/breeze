import { endDesktopSession, type EndDesktopSessionResult } from './api';
import type { AuthenticatedConnectionParams } from './webrtc';

export type SessionHangUpResult = EndDesktopSessionResult | 'skipped';

/**
 * #11931: send End for the current desktop session at most once.
 *
 * Two paths hang up: the viewer's own disconnect (`handleDisconnect`), and the
 * window close (the title-bar close button, Close Window, and the close that
 * `handleDisconnect` itself ends with). Both call this, and the second call
 * for the same session gets the first call's promise instead of a second
 * request. A transport switch that minted a new session ends the new one.
 *
 * Skipped when there is no desktop session to end: a VNC tunnel connection
 * carries an empty `sessionId` (its tunnel is closed separately), and a
 * connection that never authenticated has no token.
 *
 * Never rejects: the window close awaits it, and Tauri only destroys the
 * window once that handler settles.
 */
export function createSessionHangUp(end: typeof endDesktopSession = endDesktopSession) {
  let sent: { sessionId: string; promise: Promise<SessionHangUpResult> } | null = null;
  return (auth: AuthenticatedConnectionParams | null): Promise<SessionHangUpResult> => {
    if (!auth?.sessionId || !auth.accessToken) return Promise.resolve('skipped');
    if (sent?.sessionId === auth.sessionId) return sent.promise;
    const promise = end(auth.apiUrl, auth.accessToken, auth.sessionId)
      .catch((): SessionHangUpResult => 'failed');
    sent = { sessionId: auth.sessionId, promise };
    return promise;
  };
}
