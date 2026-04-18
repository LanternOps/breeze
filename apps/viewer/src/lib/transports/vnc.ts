import { RFB } from '../novnc';
import type { TransportSession } from './types';
import { capabilitiesFor } from './types';
import type { VncTunnelInfo } from '../tunnel';

export type { VncTunnelInfo };

export interface VncDeps {
  container: HTMLDivElement | HTMLElement;
  onStatus: (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void;
  onError: (message: string) => void;
  /**
   * Fires when noVNC needs credentials. `requiresUsername=true` indicates ARD
   * (type 30) auth; the submit function routes to `rfb.sendCredentials()`.
   */
  onCredentialsRequired: (
    requiresUsername: boolean,
    submit: (creds: { username?: string; password: string }) => void,
  ) => void;
}

export interface VncSessionWrapper extends TransportSession {
  kind: 'vnc';
  vncContainer: HTMLDivElement;
}

/**
 * Opens a noVNC session against the tunnel WS. Wraps the RFB lifecycle into
 * a TransportSession so DesktopViewer can treat it uniformly alongside
 * WebRTC and the JPEG WebSocket fallback.
 */
export async function connectVnc(
  info: VncTunnelInfo,
  deps: VncDeps,
): Promise<VncSessionWrapper> {
  deps.onStatus('connecting');

  const rfb: any = new (RFB as any)(deps.container, info.wsUrl, { wsProtocols: ['binary'] });
  rfb.scaleViewport = true;
  // Ask the server to resize its framebuffer to match our viewport. Without
  // this a Retina Mac sends raw 2940x1912 frames (~22 MB each) that WKWebView's
  // message pump can't keep up with — the rect never completes before the next
  // update arrives, and the canvas stays dark.
  rfb.resizeSession = true;
  rfb.showDotCursor = true;

  rfb.addEventListener('connect', () => deps.onStatus('connected'));

  rfb.addEventListener('disconnect', (e: CustomEvent) => {
    const clean = e.detail?.clean === true;
    if (clean) {
      deps.onStatus('disconnected');
    } else {
      deps.onStatus('error');
      deps.onError('Connection lost unexpectedly');
    }
  });

  rfb.addEventListener('credentialsrequired', (e: CustomEvent) => {
    const types = (e.detail?.types ?? ['password']) as string[];
    const requiresUsername = types.includes('username');
    deps.onCredentialsRequired(requiresUsername, (creds) => {
      rfb.sendCredentials(creds);
    });
  });

  rfb.addEventListener('securityfailure', (e: CustomEvent) => {
    const status = e.detail?.status;
    const reason = e.detail?.reason ?? 'Authentication failed';
    const msg =
      status === 1
        ? `Authentication failed: ${reason}. Check your macOS username and password.`
        : status === 2
        ? `Security type not supported: ${reason}`
        : `Security failure: ${reason}`;
    deps.onError(msg);
    deps.onStatus('error');
  });

  // When the container resizes (first layout pass, fullscreen toggle, window
  // resize), nudge noVNC to recompute its scaled viewport. Without this the
  // canvas stays at whatever size it cached at construction — often 0x0 if the
  // container was display:none when RFB was created — and frames never render.
  // Toggling scaleViewport forces the viewport math to re-run.
  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        if (rfb.scaleViewport) {
          rfb.scaleViewport = false;
          rfb.scaleViewport = true;
        }
      })
    : null;
  resizeObserver?.observe(deps.container);

  let disposed = false;

  // WKWebView batches WebSocket message delivery, so noVNC's _handleMessage
  // fires in bursts rather than incrementally. Between bursts the RFB decoder
  // sits with a partially-read rect while the receive queue fills to its 4 MB
  // cap. Poking _handleMessage on a short interval keeps the decoder draining
  // continuously. Cheap: when there's nothing to do the handler returns
  // immediately. No-op in jsdom (test mocks don't have _handleMessage).
  const pumpInterval = typeof rfb._handleMessage === 'function'
    ? setInterval(() => {
        if (disposed) return;
        const sock = rfb._sock;
        if (!sock || (sock._rQlen ?? 0) - (sock._rQi ?? 0) <= 0) return;
        try {
          rfb._handleMessage();
        } catch (err) {
          console.warn('[VNC] pump _handleMessage threw:', err);
        }
      }, 16)
    : null;
  const cleanupPump = () => { if (pumpInterval !== null) clearInterval(pumpInterval); };
  rfb.addEventListener('disconnect', cleanupPump);

  // macOS screensharingd sometimes stops emitting framebuffer updates while
  // the TCP pipe stays open — the client sits forever waiting on its
  // FramebufferUpdateRequest(incremental=1). Input still flows (bytesSent
  // climbs on the agent) but bytesRecv goes flat. To recover without
  // flooding the pipe with full-screen refreshes, use a tiered watchdog:
  //   * 1.5s silent → send another incremental request (near-zero cost, just
  //     nudges the server to send whatever it has been holding back)
  //   * 5s silent → fall back to a non-incremental refresh (whole framebuffer)
  //   * after a non-incremental fires, cool down for 10s before another full
  //     refresh — incremental nudges are still allowed during cooldown
  const INCREMENTAL_STALE_MS = 1500;
  const FULL_STALE_MS = 5000;
  const FULL_COOLDOWN_MS = 10_000;
  let lastMessageAt = Date.now();
  let lastIncrementalNudgeAt = 0;
  let lastFullRefreshAt = 0;

  // noVNC's Websock stores exactly one handler per event in `_eventHandlers`.
  // RFB's constructor set `message` to its own `_handleMessage`, which drives
  // the decoder. We wrap it (not replace) so our arrival marker runs after
  // every incoming batch without starving noVNC's pipeline.
  if (rfb._sock && rfb._sock._eventHandlers) {
    const origMessage = rfb._sock._eventHandlers.message;
    rfb._sock.on('message', () => {
      if (typeof origMessage === 'function') origMessage();
      lastMessageAt = Date.now();
    });
  }

  const watchdogInterval = setInterval(() => {
    if (disposed) return;
    if (rfb._rfbConnectionState !== 'connected') return;
    const fbW = rfb._fbWidth | 0;
    const fbH = rfb._fbHeight | 0;
    if (fbW <= 0 || fbH <= 0) return;

    const now = Date.now();
    const silentFor = now - lastMessageAt;

    if (silentFor >= FULL_STALE_MS && now - lastFullRefreshAt >= FULL_COOLDOWN_MS) {
      try {
        (RFB as any).messages.fbUpdateRequest(rfb._sock, false, 0, 0, fbW, fbH);
        lastFullRefreshAt = now;
        lastIncrementalNudgeAt = now;
      } catch (err) {
        console.warn('[VNC] full refresh failed:', err);
      }
      return;
    }

    if (silentFor >= INCREMENTAL_STALE_MS && now - lastIncrementalNudgeAt >= INCREMENTAL_STALE_MS) {
      try {
        (RFB as any).messages.fbUpdateRequest(rfb._sock, true, 0, 0, fbW, fbH);
        lastIncrementalNudgeAt = now;
      } catch (err) {
        console.warn('[VNC] incremental nudge failed:', err);
      }
    }
  }, 500);
  const cleanupWatchdog = () => clearInterval(watchdogInterval);
  rfb.addEventListener('disconnect', cleanupWatchdog);

  return {
    kind: 'vnc',
    capabilities: capabilitiesFor('vnc'),
    vncContainer: deps.container as HTMLDivElement,
    close: () => {
      if (disposed) return;
      disposed = true;
      cleanupPump();
      cleanupWatchdog();
      resizeObserver?.disconnect();
      try {
        rfb.disconnect();
      } catch {
        /* idempotent */
      }
    },
  };
}
