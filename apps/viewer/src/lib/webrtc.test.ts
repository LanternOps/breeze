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

  it('retries STUN-only before blaming the WebView, so a bad TURN config is not misdiagnosed', async () => {
    // iceServers come from the API unvalidated. A malformed `urls` or a TURN
    // entry missing credentials makes the constructor throw — which must not be
    // reported as "this WebView has no WebRTC", or one bad server row would
    // permanently disable WebRTC for every viewer.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ iceServers: [{ urls: 'not-a-valid-url' }] }),
        text: async () => '{}',
      })),
    );
    const configs: RTCConfiguration[] = [];
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        iceGatheringState = 'complete';
        localDescription = null;
        constructor(config: RTCConfiguration) {
          configs.push(config);
          if (configs.length === 1) throw new SyntaxError('Invalid ICE server URL');
        }
        addTransceiver() {}
        createDataChannel() {
          return { close() {}, bufferedAmountLowThreshold: 0 };
        }
        async createOffer() {
          return { sdp: 'v=0', type: 'offer' };
        }
        async setLocalDescription() {}
        close() {}
      },
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = await createWebRTCSession(params, document.createElement('video')).catch((e) => e);

    expect(configs).toHaveLength(2);
    // Second attempt drops the server-supplied list for the built-in STUN default.
    expect(configs[1].iceServers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    // It got past construction, so it must NOT be classed as an unusable WebView.
    expect(err).not.toBeInstanceOf(WebRTCUnsupportedError);
    // The retry must not be silent: it drops the configured TURN relay, so a
    // session that later fails at ICE would otherwise surface as a generic
    // "WebRTC connection failed" with the real cause never named.
    const logged = warn.mock.calls.map((a) => a.map(String).join(' ')).join('\n');
    expect(logged).toMatch(/ice/i);
    expect(logged).toMatch(/turn/i);
    expect(logged).toContain('Invalid ICE server URL');
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

