import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createWebRTCSession,
  isSessionEndedResponse,
  SessionEndedError,
  AgentSessionError,
  type AuthenticatedConnectionParams,
} from './webrtc';

// ── isSessionEndedResponse ────────────────────────────────────────────────

describe('isSessionEndedResponse', () => {
  it('treats a bare 401 (no body) as session-ended', () => {
    expect(isSessionEndedResponse(401, null)).toBe(true);
    expect(isSessionEndedResponse(401, undefined)).toBe(true);
    expect(isSessionEndedResponse(401, '')).toBe(true);
  });

  it('treats a 401 with a "Session ended" body as session-ended', () => {
    expect(isSessionEndedResponse(401, 'Session ended')).toBe(true);
    expect(isSessionEndedResponse(401, '{"error":"session ended"}')).toBe(true);
    expect(isSessionEndedResponse(401, 'token revoked')).toBe(true);
    expect(isSessionEndedResponse(401, 'session no longer active')).toBe(true);
  });

  it('does not flag non-401 statuses', () => {
    expect(isSessionEndedResponse(403, 'Session ended')).toBe(false);
    expect(isSessionEndedResponse(500, null)).toBe(false);
    expect(isSessionEndedResponse(200, '')).toBe(false);
  });
});

// ── createWebRTCSession 401 handling ──────────────────────────────────────

// jsdom doesn't implement WebRTC; provide minimal stubs so createWebRTCSession
// can reach the fetch calls we care about.
class FakeDataChannel {
  bufferedAmountLowThreshold = 0;
  close() {}
}

class FakeRTCPeerConnection {
  iceGatheringState = 'complete';
  localDescription = { sdp: 'v=0 fake-sdp', type: 'offer' };
  ontrack: unknown = null;
  onicegatheringstatechange: unknown = null;
  addTransceiver() {}
  createDataChannel() {
    return new FakeDataChannel();
  }
  async createOffer() {
    return { sdp: 'v=0 fake-sdp', type: 'offer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
}

const baseParams: AuthenticatedConnectionParams = {
  sessionId: 'sess-123',
  apiUrl: 'https://api.example.com',
  accessToken: 'viewer-token',
  deviceId: 'dev-1',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function stubFetch(handler: (url: string) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
}

describe('createWebRTCSession — session-ended (401) handling', () => {
  let videoEl: HTMLVideoElement;

  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
    vi.stubGlobal(
      'RTCSessionDescription',
      class {
        constructor(public init: unknown) {}
      },
    );
    videoEl = {} as HTMLVideoElement;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws SessionEndedError when the offer POST returns 401 "Session ended"', async () => {
    stubFetch((url) => {
      if (url.includes('/ice-servers')) return jsonResponse({ iceServers: [] });
      // Server rejects the reconnect: session already ended (Finding #5).
      if (url.includes('/viewer/offer')) return jsonResponse('Session ended', 401);
      return jsonResponse({}, 404);
    });

    await expect(createWebRTCSession(baseParams, videoEl)).rejects.toBeInstanceOf(
      SessionEndedError,
    );
  });

  it('throws SessionEndedError when the answer poll returns 401', async () => {
    stubFetch((url) => {
      if (url.includes('/ice-servers')) return jsonResponse({ iceServers: [] });
      if (url.includes('/viewer/offer')) return jsonResponse({ ok: true });
      if (url.includes('/viewer/session')) return jsonResponse('Session ended', 401);
      return jsonResponse({}, 404);
    });

    await expect(createWebRTCSession(baseParams, videoEl)).rejects.toBeInstanceOf(
      SessionEndedError,
    );
  });

  it('still throws a generic (retryable) error for non-401 offer failures', async () => {
    stubFetch((url) => {
      if (url.includes('/ice-servers')) return jsonResponse({ iceServers: [] });
      if (url.includes('/viewer/offer')) return jsonResponse('boom', 503);
      return jsonResponse({}, 404);
    });

    const err = await createWebRTCSession(baseParams, videoEl).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SessionEndedError);
    expect(err).not.toBeInstanceOf(AgentSessionError);
  });
});
