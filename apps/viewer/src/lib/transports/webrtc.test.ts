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
  it('resolves to null so the caller falls back, instead of rejecting', async () => {
    removeRTCPeerConnection();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(connectWebRTC(auth, makeDeps())).resolves.toBeNull();
    // The guard must short-circuit before any signalling traffic.
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

  it('does not fire the failure lifecycle callbacks that drive reconnect', async () => {
    removeRTCPeerConnection();
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps();

    await connectWebRTC(auth, deps);

    // An unsupported WebView is permanent — retrying WebRTC is pure waste.
    expect(deps.onFailed).not.toHaveBeenCalled();
    expect(deps.onConnected).not.toHaveBeenCalled();
  });
});
