import { describe, it, expect, vi, afterEach } from 'vitest';
import { connectWebRTC, type WebRTCDeps } from './webrtc';
import type { AuthenticatedConnectionParams } from '../webrtc';

const globalScope = globalThis as Record<string, unknown>;

/**
 * Remove the global outright rather than stubbing it to `undefined` — only a
 * genuinely absent identifier reproduces the webkit2gtk ReferenceError that
 * issue #3410 is about.
 */
function removeRTCPeerConnection(): void {
  delete globalScope.RTCPeerConnection;
}

afterEach(() => {
  delete globalScope.RTCPeerConnection;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const auth: AuthenticatedConnectionParams = {
  sessionId: 'sess-3410',
  apiUrl: 'https://api.example.com',
  accessToken: 'viewer-token',
  deviceId: 'dev-1',
};

function makeDeps(): WebRTCDeps {
  return {
    videoElement: document.createElement('video'),
    cursorOverlayRef: { current: null },
    showRemoteCursorRef: { current: false },
    remoteCursorShapeRef: { current: 'default' },
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onFailed: vi.fn(),
    onClosed: vi.fn(),
    onAudioTrack: vi.fn(),
    onClipboardChannel: vi.fn(),
    onCursorChannelOpen: vi.fn(),
    onCursorChannelClose: vi.fn(),
  };
}

describe('connectWebRTC — WebView without WebRTC (issue #3410)', () => {
  it('short-circuits before any signalling traffic, and resolves null to fall back', async () => {
    removeRTCPeerConnection();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(connectWebRTC(auth, makeDeps())).resolves.toBeNull();
    // The `toBeNull` half is NOT discriminating on its own — the generic catch
    // also returns null. This assertion is the one that fails if the guard in
    // createWebRTCSession is removed.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs a cause the operator can act on, not a raw ReferenceError dump', async () => {
    removeRTCPeerConnection();
    vi.stubGlobal('fetch', vi.fn());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await connectWebRTC(auth, makeDeps());

    const logged = warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(logged).toMatch(/webrtc/i);
    // The old log was the generic 'WebRTC connection failed:' + the caught
    // ReferenceError, which reads as a transient fault rather than a permanent
    // capability gap in this WebView.
    expect(logged).not.toMatch(/WebRTC connection failed/);
    expect(logged).toMatch(/websocket/i);
  });
});

// NOTE ON LOG-COUPLING: the assertions above match on warning prose, which is
// normally brittle. It is unavoidable here — the unsupported branch and the
// generic catch both `return null`, so the log is the ONLY observable
// difference between them. If you are rewording that warning, update these
// assertions; do not delete them, because they are the only guard on the
// branch existing at all.
//
// Deliberately NOT tested: that onFailed/onConnected stay unfired. Those are
// only ever invoked from a live `pc.onconnectionstatechange` handler, so any
// throw from createWebRTCSession skips them regardless of this PR's changes —
// such a test passes under every mutation and guards nothing.
