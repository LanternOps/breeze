// apps/helper/src/windows/ConsentWindow.tsx
//
// The Assist side of the remote-session consent prompt. The agent's request
// arrives through the Rust IPC loop (src-tauri/src/ipc/consent.rs):
//   - v2 (the request carries a nonce): once the prompt has painted and the
//     window is visible, confirm it (`consent_presented`) — the agent starts
//     the countdown from there. Then report exactly one answer: Allow, Deny,
//     or that the countdown ran out ("expired"). An expired countdown is
//     never turned into a decision here.
//   - v1 (no nonce, older agent): report a click; stay silent on expiry, as
//     before — that agent applies its own timeout.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ConsentDialog } from './ConsentDialog';
import type { ConsentRequest } from './ConsentDialog';

export interface ConsentWindowApi {
  /** The request currently on screen (pulled on mount; the event may have fired before we listened). */
  getRequest(): Promise<ConsentRequest | null>;
  /** Subscribe to requests pushed after mount. */
  listen(cb: (req: ConsentRequest) => void): Promise<() => void>;
  /** v2 presentation acknowledgement. */
  presented(nonce: string): Promise<void>;
  submit(sessionId: string, decision: 'allow' | 'deny' | 'expired', nonce: string | null): Promise<void>;
  close(): Promise<void>;
  isVisible(): boolean;
}

export const tauriConsentApi: ConsentWindowApi = {
  getRequest: () => invoke<ConsentRequest | null>('get_consent_request'),
  listen: (cb) => listen<ConsentRequest>('consent-request', (e) => cb(e.payload)),
  presented: (nonce) => invoke('consent_presented', { nonce }),
  submit: (sessionId, decision, nonce) => invoke('submit_consent', { sessionId, decision, nonce }),
  close: () => getCurrentWindow().close(),
  isVisible: () => document.visibilityState === 'visible',
};

export function ConsentWindow({ api = tauriConsentApi }: { api?: ConsentWindowApi }) {
  const [req, setReq] = useState<ConsentRequest | null>(null);
  const [presentedNonce, setPresentedNonce] = useState<string | null>(null);
  const acked = useRef<string | null>(null);
  const decided = useRef<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    api.listen((next) => setReq(next)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch((err) => console.warn('[consent] failed to listen for consent requests', err));
    api.getRequest().then((current) => {
      if (!cancelled && current) setReq((prev) => prev ?? current);
    }).catch((err) => console.warn('[consent] failed to read the pending consent request', err));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [api]);

  // v2: confirm the prompt once it has painted and the window is visible.
  useEffect(() => {
    const nonce = req?.nonce;
    if (!nonce || acked.current === nonce) return;
    let done = false;
    const tryAck = () => {
      if (done || acked.current === nonce || !api.isVisible()) return;
      done = true;
      acked.current = nonce;
      setPresentedNonce(nonce);
      api.presented(nonce).catch((err) => console.warn('[consent] failed to confirm the prompt is on screen', err));
    };
    requestAnimationFrame(tryAck);
    document.addEventListener('visibilitychange', tryAck);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', tryAck);
    };
  }, [req, api]);

  const handleDecision = useCallback((allow: boolean, reason: 'user' | 'timeout') => {
    if (!req) return;
    const key = req.nonce ?? req.sessionId;
    if (decided.current === key) return;
    decided.current = key;
    const logSubmitFailure = (err: unknown) => console.warn('[consent] failed to report the answer', err);
    if (reason === 'user') {
      api.submit(req.sessionId, allow ? 'allow' : 'deny', req.nonce ?? null).catch(logSubmitFailure);
    } else if (req.nonce) {
      // v2: say the countdown ran out. The agent decides what that means.
      api.submit(req.sessionId, 'expired', req.nonce).catch(logSubmitFailure);
    }
    // v1 timeout: submit nothing — the older agent runs its own timeout.
    api.close().catch((err) => console.warn('[consent] failed to close the consent window', err));
  }, [req, api]);

  if (!req) return null;
  // v2: the countdown runs from the moment the prompt is confirmed on
  // screen, the same moment the agent starts waiting for the answer.
  const countdownRunning = !req.nonce || presentedNonce === req.nonce;
  return <ConsentDialog req={req} onDecision={handleDecision} countdownRunning={countdownRunning} />;
}
