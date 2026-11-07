import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  scaleVideoCoords,
  isWebRTCSupported,
  createWebRTCSession,
  WebRTCUnsupportedError,
  RelayRequiredError,
  RELAY_REQUIRED_MESSAGE,
  type AuthenticatedConnectionParams,
} from './webrtc';
import { connectWebRTC, type WebRTCDeps } from './transports/webrtc';

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


// #9182: end to end through createWebRTCSession — a relay candidate the agent
// gathered after its answer (and so after the viewer's 3 s gather window) is
// still added, and the viewer's own late candidate is sent.
describe('createWebRTCSession — trickle ICE', () => {
  const params: AuthenticatedConnectionParams = {
    sessionId: 'sess-9182',
    apiUrl: 'https://api.example.com',
    accessToken: 'viewer-token',
  };
  const RELAY = 'candidate:9 1 udp 16777215 198.51.100.7 3478 typ relay raddr 203.0.113.5 rport 50000';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds a late agent candidate and posts a late local one', async () => {
    vi.useFakeTimers();
    const added: RTCIceCandidateInit[] = [];
    let localListener: ((e: unknown) => void) | null = null;
    vi.stubGlobal('RTCSessionDescription', class { constructor(init: RTCSessionDescriptionInit) { Object.assign(this, init); } });
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        iceGatheringState = 'complete';
        connectionState = 'connecting';
        localDescription = { type: 'offer', sdp: 'v=0 offer' };
        addTransceiver() {}
        createDataChannel() { return { close() {} }; }
        async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
        async setLocalDescription() {}
        async setRemoteDescription() {}
        addEventListener(type: string, fn: (e: unknown) => void) { if (type === 'icecandidate') localListener = fn; }
        removeEventListener() { localListener = null; }
        async addIceCandidate(c: RTCIceCandidateInit) { added.push(c); }
        close() {}
      },
    );

    let sessionPolls = 0;
    const posted: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
      if (url.endsWith('/viewer/ice-servers')) return ok({ iceServers: [] });
      if (url.endsWith('/viewer/offer')) return ok({ status: 'connecting' });
      if (url.endsWith('/viewer/ice')) { posted.push(JSON.parse(String(init?.body))); return ok({ accepted: true, forwarded: true }); }
      sessionPolls++;
      // First poll: the answer, without a=end-of-candidates (the agent's 500 ms
      // early exit). Later polls: the relay candidate the agent got after it.
      return ok({
        status: 'connecting',
        terminationPhase: 'none',
        webrtcAnswer: 'v=0 answer',
        agentIceCandidates: sessionPolls === 1 ? [] : [
          { seq: 0, candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 } },
          { seq: 1, complete: true },
        ],
      });
    }));

    const session = await createWebRTCSession(params, document.createElement('video'));
    expect(localListener).not.toBeNull();
    localListener!({ candidate: { candidate: 'candidate:late-viewer-relay', toJSON: () => ({ candidate: 'candidate:late-viewer-relay', sdpMid: '0', sdpMLineIndex: 0 }) } });

    await vi.advanceTimersByTimeAsync(5000);

    expect(added).toEqual([{ candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 }]);
    expect(posted).toEqual([{ candidate: { candidate: 'candidate:late-viewer-relay', sdpMid: '0', sdpMLineIndex: 0 } }]);
    session.close();
    expect(localListener).toBeNull();
  });
});


describe('createWebRTCSession — isolated device relay policy', () => {
  const params: AuthenticatedConnectionParams = {
    sessionId: 'isolated-session',
    apiUrl: 'https://relay.example.test',
    accessToken: 'viewer-token',
  };
  const relayMessage = 'Remote desktop needs the TURN relay while this device is isolated';
  const turnServers = [{ urls: 'turn:relay.example.test:3478', username: 'viewer', credential: 'secret' }];
  const stunServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const afterConstruction = new Error('stop after peer construction');

  function stubResponse(body: unknown, status = 200): void {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: status === 200, status, headers: new Headers(),
      json: async () => body, text: async () => JSON.stringify(body),
    })));
  }

  function stubPeer(rejectFirst = false): RTCConfiguration[] {
    const configs: RTCConfiguration[] = [];
    vi.stubGlobal('RTCPeerConnection', class {
      constructor(config: RTCConfiguration) {
        configs.push(config);
        if (rejectFirst && configs.length === 1) throw new SyntaxError('Invalid ICE server URL');
      }
      addTransceiver() {}
      createDataChannel() { return { close() {} }; }
      async createOffer() { throw afterConstruction; }
      close() {}
    });
    return configs;
  }

  it('uses the exact relay list with relay transport policy', async () => {
    stubResponse({ relayOnly: true, iceServers: turnServers });
    const configs = stubPeer();
    await expect(createWebRTCSession(params, document.createElement('video'))).rejects.toBe(afterConstruction);
    expect(configs).toEqual([{ iceServers: turnServers, iceTransportPolicy: 'relay' }]);
    expect(RELAY_REQUIRED_MESSAGE).toBe(relayMessage);
  });

  it('never retries STUN when the relay configuration is rejected', async () => {
    stubResponse({ relayOnly: true, iceServers: turnServers });
    const configs = stubPeer(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = await createWebRTCSession(params, document.createElement('video')).catch((err: unknown) => err);
    expect(configs).toHaveLength(1);
    expect(error).toBeInstanceOf(RelayRequiredError);
    expect(error).not.toBeInstanceOf(WebRTCUnsupportedError);
    expect(error).toHaveProperty('message', `${relayMessage} (relay configuration rejected: Invalid ICE server URL)`);
    expect(warn).toHaveBeenCalled();
  });

  it('keeps the STUN fallback for a 409 that is not a relay refusal', async () => {
    stubResponse({ code: 'consent_upgrade_required', error: 'upgrade' }, 409);
    const configs = stubPeer();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(createWebRTCSession(params, document.createElement('video'))).rejects.toBe(afterConstruction);
    expect(configs).toEqual([{ iceServers: stunServers }]);
  });

  it.each([
    ['isolation_relay_unavailable', relayMessage],
    ['isolation_relay_not_permitted', 'Remote desktop over WebRTC is unavailable: this device was isolated without permitting the TURN relay'],
    ['isolation_relay_unavailable', undefined],
  ])('surfaces terminal 409 %s without constructing a peer', async (code, message) => {
    stubResponse({ code, ...(message ? { error: message } : {}) }, 409);
    const configs = stubPeer();
    const error = await createWebRTCSession(params, document.createElement('video')).catch((err: unknown) => err);
    expect(configs).toHaveLength(0);
    expect(error).toBeInstanceOf(RelayRequiredError);
    expect(error).toHaveProperty('message', message ?? relayMessage);
  });

  it.each([[], undefined])('rejects a missing or empty relay list without STUN', async (iceServers) => {
    stubResponse({ relayOnly: true, iceServers });
    const configs = stubPeer();
    const error = await createWebRTCSession(params, document.createElement('video')).catch((err: unknown) => err);
    expect(configs).toHaveLength(0);
    expect(error).toHaveProperty('message', relayMessage);
    expect(error).toBeInstanceOf(RelayRequiredError);
  });

  it('retains all transport policy and the server list outside isolation', async () => {
    const iceServers = [...stunServers, ...turnServers];
    stubResponse({ iceServers });
    const configs = stubPeer();
    await expect(createWebRTCSession(params, document.createElement('video'))).rejects.toBe(afterConstruction);
    expect(configs).toEqual([{ iceServers }]);
  });

  it('still retries STUN after a non-relay constructor rejection', async () => {
    stubResponse({ iceServers: turnServers });
    const configs = stubPeer(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(createWebRTCSession(params, document.createElement('video'))).rejects.toBe(afterConstruction);
    expect(configs).toEqual([
      { iceServers: turnServers },
      { iceServers: stunServers },
    ]);
  });

  it.each(['fetch failure', 'other HTTP failure'])('keeps STUN fallback for %s', async (failure) => {
    if (failure === 'fetch failure') vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    else stubResponse({ error: 'unavailable' }, 503);
    const configs = stubPeer();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(createWebRTCSession(params, document.createElement('video'))).rejects.toBe(afterConstruction);
    expect(configs).toEqual([{ iceServers: stunServers }]);
  });

  it.each(['isolation_relay_unavailable', 'isolation_relay_not_permitted'])(
    'preserves %s if isolation changes before the offer', async (code) => {
      vi.stubGlobal('RTCPeerConnection', class {
        iceGatheringState = 'complete';
        localDescription = { type: 'offer', sdp: 'v=0 offer' };
        addTransceiver() {}
        createDataChannel() { return { close() {} }; }
        async createOffer() { return this.localDescription; }
        async setLocalDescription() {}
        close() {}
      });
      const errorMessage = code === 'isolation_relay_not_permitted'
        ? 'Remote desktop over WebRTC is unavailable: this device was isolated without permitting the TURN relay'
        : relayMessage;
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const offer = String(input).endsWith('/viewer/offer');
        const body = offer ? { code, error: errorMessage } : { iceServers: turnServers };
        return {
          ok: !offer, status: offer ? 409 : 200, headers: new Headers(),
          json: async () => body, text: async () => JSON.stringify(body),
        };
      }));
      const error = await createWebRTCSession(params, document.createElement('video')).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(RelayRequiredError);
      expect(error).toHaveProperty('message', errorMessage);
    },
  );

  it('preserves the relay refusal through the transport caller instead of returning generic failure', async () => {
    stubResponse({ code: 'isolation_relay_unavailable', error: relayMessage }, 409);
    stubPeer();
    const deps: WebRTCDeps = {
      videoElement: document.createElement('video'),
      cursorOverlayRef: { current: null },
      showRemoteCursorRef: { current: false },
      remoteCursorShapeRef: { current: 'default' },
      onConnected: vi.fn(), onDisconnected: vi.fn(), onFailed: vi.fn(), onClosed: vi.fn(),
      onAudioTrack: vi.fn(), onClipboardChannel: vi.fn(), onCursorChannelOpen: vi.fn(), onCursorChannelClose: vi.fn(),
    };
    await expect(connectWebRTC(params, deps)).rejects.toMatchObject({ message: relayMessage });
  });
});
