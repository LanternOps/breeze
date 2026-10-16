import type { ConnectionParams } from './protocol';

/**
 * Identity of a deep link: what it connects to and with which single-use code.
 * Two deliveries with the same key are the same link.
 */
export function deepLinkKey(parsed: ConnectionParams): string {
  return parsed.mode === 'desktop'
    ? `${parsed.sessionId}|${parsed.connectCode}|${parsed.apiUrl}`
    : `${parsed.tunnelId}|${parsed.code}|${parsed.apiUrl}`;
}

export interface DeepLinkGate {
  /**
   * True when the link should be applied, which makes it the current link.
   * False when it is already the current link.
   */
  admit(key: string): boolean;
  /** Forget the current link. Call it when the viewer errors or disconnects. */
  release(): void;
}

/**
 * Decides whether a session window applies a delivered deep link (#8947).
 *
 * One link reaches a window several times: the Rust shell emits it at +0.5 s
 * and +2.0 s, and the window also polls for it. Re-applying it replaces the
 * viewer's params, which restarts the connect flow while the first attempt is
 * still in flight and posts a second offer for the same session.
 *
 * The check is by key only, never by time. A window that is stalled for
 * seconds (WebKit throttles an occluded window) gets the retries late, and a
 * time window would let those through. Blocking the current key costs nothing:
 * its connect code is single-use, so applying it a second time cannot work.
 *
 * `release()` clears the current link, so a viewer that errored or
 * disconnected accepts the same link again.
 */
export function createDeepLinkGate(): DeepLinkGate {
  let current: string | null = null;
  return {
    admit(key) {
      if (current === key) return false;
      current = key;
      return true;
    },
    release() {
      current = null;
    },
  };
}
