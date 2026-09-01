import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  scaleVideoCoords,
  isWebRTCSupported,
  createWebRTCSession,
  WebRTCUnsupportedError,
  type AuthenticatedConnectionParams,
} from './webrtc';

function setVideoSize(video: HTMLVideoElement, w: number, h: number) {
  Object.defineProperty(video, 'videoWidth', { value: w, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: h, configurable: true });
}

describe('scaleVideoCoords', () => {
  it('maps coordinates with top/bottom letterboxing (object-contain)', () => {
    const video = document.createElement('video');
    setVideoSize(video, 1920, 1080);
    video.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 1000,
      right: 1000,
      bottom: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

    expect(scaleVideoCoords(500, 500, video)).toEqual({ x: 960, y: 540 });
    expect(scaleVideoCoords(500, 10, video).y).toBe(0);
  });

  it('maps coordinates with left/right letterboxing (object-contain)', () => {
    const video = document.createElement('video');
    setVideoSize(video, 1920, 1080);
    video.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 2000,
      height: 500,
      right: 2000,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

    expect(scaleVideoCoords(1000, 250, video)).toEqual({ x: 960, y: 540 });
    expect(scaleVideoCoords(0, 250, video).x).toBe(0);
  });
});

// ── WebRTC feature detection (issue #3410) ────────────────────────────────
//
// The Linux Viewer is a Tauri app rendering in webkit2gtk. Depending on how the
// distro built webkit2gtk/GStreamer, `RTCPeerConnection` can be absent as a
// global entirely, so `new RTCPeerConnection(...)` threw a bare ReferenceError
// ("Can't find variable: RTCPeerConnection" — JavaScriptCore's phrasing) from
// deep inside createWebRTCSession.

/** Minimal stand-in so the "supported" branch can be exercised under jsdom. */
class FakeRTCPeerConnection {
  close() {}
}

const globalScope = globalThis as Record<string, unknown>;

/**
 * Remove the global outright rather than stubbing it to `undefined`.
 *
 * The distinction matters: an assigned-but-undefined global makes
 * `new RTCPeerConnection()` a TypeError, whereas the identifier being genuinely
 * absent — the real webkit2gtk case — makes it a ReferenceError. Only the
 * latter reproduces issue #3410, so the guard has to be proven against it.
 */
function removeRTCPeerConnection(): void {
  delete globalScope.RTCPeerConnection;
}

afterEach(() => {
  delete globalScope.RTCPeerConnection;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isWebRTCSupported', () => {
  it('is false when the RTCPeerConnection global is missing (webkit2gtk)', () => {
    removeRTCPeerConnection();
    expect(isWebRTCSupported()).toBe(false);
  });

  it('is true when the RTCPeerConnection global is present', () => {
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
    expect(isWebRTCSupported()).toBe(true);
  });
});

describe('createWebRTCSession — missing RTCPeerConnection', () => {
  const params: AuthenticatedConnectionParams = {
    sessionId: 'sess-3410',
    apiUrl: 'https://api.example.com',
    accessToken: 'viewer-token',
    deviceId: 'dev-1',
  };

  it('rejects with WebRTCUnsupportedError instead of a bare ReferenceError', async () => {
    removeRTCPeerConnection();
    const videoEl = document.createElement('video');

    const err = await createWebRTCSession(params, videoEl).catch((e) => e);

    expect(err).toBeInstanceOf(WebRTCUnsupportedError);
    // Before the guard this was `ReferenceError: RTCPeerConnection is not
    // defined` (JavaScriptCore words it "Can't find variable: …"), thrown from
    // the unguarded constructor. A ReferenceError here means the guard is gone.
    expect(err).not.toBeInstanceOf(ReferenceError);
    expect(String(err.message)).toMatch(/webrtc/i);
  });

  it('bails out before spending a request on the ICE-servers endpoint', async () => {
    removeRTCPeerConnection();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const videoEl = document.createElement('video');

    await createWebRTCSession(params, videoEl).catch(() => {});

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// A webkit2gtk build missing its GStreamer WebRTC plugins is the case the issue
// actually describes, and there the global usually EXISTS while construction
// fails. A `typeof` probe alone would call that supported and let the failure
// resurface as a generic "connection failed", so construction is guarded too.
describe('createWebRTCSession — RTCPeerConnection present but unusable', () => {
  const params: AuthenticatedConnectionParams = {
    sessionId: 'sess-3410',
    apiUrl: 'https://api.example.com',
    accessToken: 'viewer-token',
  };

  function stubIceFetch(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ iceServers: [] }),
        text: async () => '{}',
      })),
    );
  }

  it('maps a throwing constructor to WebRTCUnsupportedError', async () => {
    stubIceFetch();
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        constructor() {
          throw new TypeError('WebRTC is not supported in this build');
        }
      },
    );

    const err = await createWebRTCSession(params, document.createElement('video')).catch((e) => e);

    expect(err).toBeInstanceOf(WebRTCUnsupportedError);
    // The underlying cause must survive — it is the only clue about which
    // part of the WebView stack is missing.
    expect(String(err.message)).toContain('WebRTC is not supported in this build');
  });

  it('maps a throwing createDataChannel to WebRTCUnsupportedError and closes the connection', async () => {
    stubIceFetch();
    const close = vi.fn();
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        close = close;
        addTransceiver() {}
        createDataChannel(): never {
          throw new DOMException('Not implemented', 'NotSupportedError');
        }
      },
    );

    const err = await createWebRTCSession(params, document.createElement('video')).catch((e) => e);

    expect(err).toBeInstanceOf(WebRTCUnsupportedError);
    // Without this the half-built peer connection leaks — `close` is only
    // defined further down, after the channels are created.
    expect(close).toHaveBeenCalled();
  });
});

