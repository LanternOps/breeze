import { invoke } from '@tauri-apps/api/core';
import type { AuthenticatedConnectionParams } from '@breeze/remote-desktop-ui';

type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** The longest the hang-up waits for Rust to acknowledge a disarm. */
export const DISARM_TIMEOUT_MS = 500;

/**
 * #12129: keeps the native close hook (src-tauri/src/session_end.rs) told
 * which desktop session this window shows. Rust owns the window close: it
 * holds the close, sends End for the armed session, then destroys the window,
 * so the hang-up is recorded even when this page is hung or has crashed.
 *
 * `track` is called with every value assigned to the viewer's auth: a desktop
 * session arms (and replaces) the native target; anything else (no session
 * yet, a VNC tunnel with an empty sessionId) disarms the previous one. Once
 * the page has sent End itself, `disarm` stops Rust from sending it again on
 * the close that follows.
 *
 * Never throws or rejects: a failed call only means the close falls back to
 * ending the session as a dropped connection.
 */
export function createNativeSessionEnd(call: Invoke = invoke) {
  let armed: string | null = null;

  const send = (cmd: string, args: Record<string, unknown>): Promise<void> =>
    Promise.resolve()
      .then(() => call(cmd, args))
      .then(
        () => undefined,
        (err) => {
          console.warn(`Could not ${cmd === 'arm_session_end' ? 'arm' : 'disarm'} the native session end; closing the window may end the session as a dropped connection:`, err);
        },
      );

  // Bounded: the hang-up awaits it before closing the window, and a disarm
  // that is lost only costs the close one redundant End.
  const disarm = (sessionId: string | null | undefined): Promise<void> => {
    if (!sessionId) return Promise.resolve();
    if (armed === sessionId) armed = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, DISARM_TIMEOUT_MS); });
    return Promise.race([send('disarm_session_end', { sessionId }), timeout]).finally(() => clearTimeout(timer));
  };

  const track = <T extends AuthenticatedConnectionParams | null>(auth: T): T => {
    if (auth?.sessionId && auth.accessToken) {
      armed = auth.sessionId;
      void send('arm_session_end', {
        apiUrl: auth.apiUrl,
        accessToken: auth.accessToken,
        sessionId: auth.sessionId,
      });
    } else if (armed) {
      void disarm(armed);
    }
    return auth;
  };

  return { track, disarm };
}

export type NativeSessionEnd = ReturnType<typeof createNativeSessionEnd>;
