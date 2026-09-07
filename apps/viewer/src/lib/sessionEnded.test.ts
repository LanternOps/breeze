import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ANSWER_POLL_INITIAL_INTERVAL_MS,
  ANSWER_POLL_MAX_INTERVAL_MS,
  createWebRTCSession,
  isSessionEndedResponse,
  isUnretryableViewerStatus,
  nextAnswerPollInterval,
  parseRetryAfterMs,
  SessionEndedError,
  AgentSessionError,
  type AuthenticatedConnectionParams,
} from './webrtc';

// ── isSessionEndedResponse ────────────────────────────────────────────────

describe('isSessionEndedResponse', () => {
  it('treats every 401 as session-ended, whatever the body says', () => {
    expect(isSessionEndedResponse(401)).toBe(true);
  });

  it('does not flag non-401 statuses', () => {
    expect(isSessionEndedResponse(403)).toBe(false);
    expect(isSessionEndedResponse(500)).toBe(false);
    expect(isSessionEndedResponse(200)).toBe(false);
    expect(isSessionEndedResponse(429)).toBe(false);
  });
});

// ── isUnretryableViewerStatus ─────────────────────────────────────────────

describe('isUnretryableViewerStatus', () => {
  it('flags the terminal 4xx the viewer endpoints actually return', () => {
    // apps/api/src/routes/desktopWs.ts validateViewerSessionAccess
    expect(isUnretryableViewerStatus(400)).toBe(true); // not a desktop session
    expect(isUnretryableViewerStatus(403)).toBe(true); // policy / owner mismatch
    expect(isUnretryableViewerStatus(404)).toBe(true); // session not found
  });

  it('does not flag the retry-inviting statuses', () => {
    expect(isUnretryableViewerStatus(408)).toBe(false);
    expect(isUnretryableViewerStatus(429)).toBe(false);
    expect(isUnretryableViewerStatus(500)).toBe(false);
    expect(isUnretryableViewerStatus(503)).toBe(false);
    expect(isUnretryableViewerStatus(200)).toBe(false);
  });
});

// ── parseRetryAfterMs ─────────────────────────────────────────────────────

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('60')).toBe(60_000);
    expect(parseRetryAfterMs(' 5 ')).toBe(5_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('returns null when absent or unparseable', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
    expect(parseRetryAfterMs('-1')).toBeNull();
  });
});

// ── answer-poll pacing (issue #3041) ──────────────────────────────────────

describe('answer poll backoff', () => {
  it('backs off geometrically up to the cap', () => {
    expect(nextAnswerPollInterval(ANSWER_POLL_INITIAL_INTERVAL_MS)).toBe(75);
    expect(nextAnswerPollInterval(75)).toBe(113);
    expect(nextAnswerPollInterval(ANSWER_POLL_MAX_INTERVAL_MS)).toBe(
      ANSWER_POLL_MAX_INTERVAL_MS,
    );
  });

  it('keeps a full 15s wait far below the 300-request per-IP budget', () => {
    // The reported incident was 213 x 401 in ~26s from a flat 50ms poll, which
    // alone exhausts the default 300/60s bucket. Walk the real schedule.
    let elapsed = 0;
    let interval = ANSWER_POLL_INITIAL_INTERVAL_MS;
    let requests = 0;
    while (elapsed < 15_000) {
      requests += 1;
      elapsed += interval;
      interval = nextAnswerPollInterval(interval);
    }

    expect(requests).toBeLessThan(40);
    // A flat 50ms poll would have issued 300 over the same window.
    expect(requests).toBeLessThan(15_000 / ANSWER_POLL_INITIAL_INTERVAL_MS / 5);
  });

  it('still polls quickly at the start so a healthy agent is picked up fast', () => {
    // Time to the 3rd poll must stay well under half a second.
    const first = ANSWER_POLL_INITIAL_INTERVAL_MS;
    const second = nextAnswerPollInterval(first);
    expect(first + second).toBeLessThan(200);
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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
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

  it.each([null, 'v=0 stale-answer'])('surfaces no-display failures once, even with answer %s', async (webrtcAnswer) => {
    const message = 'no display attached — open the lid or attach an external display';
    let sessionPolls = 0;
    const close = vi.spyOn(FakeRTCPeerConnection.prototype, 'close');
    const setRemoteDescription = vi.spyOn(FakeRTCPeerConnection.prototype, 'setRemoteDescription');
    stubFetch((url) => {
      if (url.includes('/ice-servers')) return jsonResponse({ iceServers: [] });
      if (url.includes('/viewer/offer')) return jsonResponse({ ok: true });
      if (url.includes('/viewer/session')) {
        sessionPolls += 1;
        return jsonResponse({ status: 'failed', errorMessage: message, webrtcAnswer });
      }
      return jsonResponse({}, 404);
    });

    const error = await createWebRTCSession(baseParams, videoEl).catch((err) => err);
    expect(error).toBeInstanceOf(AgentSessionError);
    expect(error.message).toBe(message);
    expect(sessionPolls).toBe(1);
    expect(setRemoteDescription).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
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

  // Issue #3041: these are the 401 bodies the API actually returns from
  // validateViewerSessionAccess. The old body-matching regex recognised none of
  // them, so the poll kept firing every 50ms until the 15s timeout and burned
  // the caller's per-IP rate-limit budget.
  it.each([
    'Session closed',
    'Missing viewer token',
    'Invalid or expired viewer token',
    'Viewer token revoked',
    '{"error":"Session closed"}',
  ])('stops the answer poll on the first 401 (%s)', async (body) => {
    let sessionPolls = 0;
    stubFetch((url) => {
      if (url.includes('/ice-servers')) return jsonResponse({ iceServers: [] });
      if (url.includes('/viewer/offer')) return jsonResponse({ ok: true });
      if (url.includes('/viewer/session')) {
        sessionPolls += 1;
        return jsonResponse(body, 401);
      }
      return jsonResponse({}, 404);
    });

    await expect(createWebRTCSession(baseParams, videoEl)).rejects.toBeInstanceOf(
      SessionEndedError,
    );
    // The whole point: exactly one poll, not hundreds.
    expect(sessionPolls).toBe(1);
  });

  // 400 not-a-desktop-session, 403 policy-denied/owner-mismatch, 404
  // session-not-found — all terminal, all previously polled to timeout.
  it.each([400, 403, 404])(
    'stops the answer poll on a terminal %i instead of polling to timeout',
    async (status) => {
      let sessionPolls = 0;
      stubFetch((url) => {
        if (url.includes('/ice-servers')) return jsonResponse({ iceServers: [] });
        if (url.includes('/viewer/offer')) return jsonResponse({ ok: true });
        if (url.includes('/viewer/session')) {
          sessionPolls += 1;
          return jsonResponse('Remote desktop is disabled by policy', status);
        }
        return jsonResponse({}, 404);
      });

      const err = await createWebRTCSession(baseParams, videoEl).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      // A policy denial is not a dead session, so it must not masquerade as one.
      expect(err).not.toBeInstanceOf(SessionEndedError);
      expect((err as Error).message).toContain(String(status));
      expect(sessionPolls).toBe(1);
    },
  );

  it('gives up rather than polling through a 429 it has been told to wait out', async () => {
    let sessionPolls = 0;
    stubFetch((url) => {
      if (url.includes('/ice-servers')) return jsonResponse({ iceServers: [] });
      if (url.includes('/viewer/offer')) return jsonResponse({ ok: true });
      if (url.includes('/viewer/session')) {
        sessionPolls += 1;
        // Retry-After (60s) outlasts the 15s answer window.
        return jsonResponse({ error: 'Too many requests' }, 429, { 'Retry-After': '60' });
      }
      return jsonResponse({}, 404);
    });

    const err = await createWebRTCSession(baseParams, videoEl).catch((e) => e);
    expect((err as Error).message).toContain('rate limited');
    expect(sessionPolls).toBe(1);
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

  // The tests above all settle on the first poll. These drive the real
  // multi-iteration loop (fake timers) to prove that *recoverable* statuses
  // still retry — the fix must not turn "stop hammering" into "give up".
  describe('multi-iteration polling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function stubSessionPolls(responses: (n: number) => Response) {
      let sessionPolls = 0;
      stubFetch((url) => {
        if (url.includes('/ice-servers')) return jsonResponse({ iceServers: [] });
        if (url.includes('/viewer/offer')) return jsonResponse({ ok: true });
        if (url.includes('/viewer/session')) {
          sessionPolls += 1;
          return responses(sessionPolls);
        }
        return jsonResponse({}, 404);
      });
      return () => sessionPolls;
    }

    it('keeps polling through a transient 5xx and still succeeds', async () => {
      const polls = stubSessionPolls((n) =>
        n <= 2
          ? jsonResponse({ error: 'bad gateway' }, 503)
          : jsonResponse({ webrtcAnswer: 'v=0 answer-sdp' }),
      );

      const pending = createWebRTCSession(baseParams, videoEl);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toMatchObject({ pc: expect.anything() });
      // Two 503s were ridden out, the third poll got the answer.
      expect(polls()).toBe(3);
    });

    it('honours a short Retry-After and resumes polling', async () => {
      const polls = stubSessionPolls((n) =>
        n === 1
          ? jsonResponse({ error: 'Too many requests' }, 429, { 'Retry-After': '1' })
          : jsonResponse({ webrtcAnswer: 'v=0 answer-sdp' }),
      );

      const pending = createWebRTCSession(baseParams, videoEl);
      // Nothing should happen before the server's 1s Retry-After elapses.
      await vi.advanceTimersByTimeAsync(500);
      expect(polls()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ pc: expect.anything() });
      expect(polls()).toBe(2);
    });

    it('stays bounded on a 429 that carries no Retry-After', async () => {
      // No header means no give-up signal, so the loop runs to the timeout —
      // it must do so at the backed-off cadence, not the old 50ms hot spin.
      const polls = stubSessionPolls(() => jsonResponse({ error: 'Too many requests' }, 429));

      const pending = createWebRTCSession(baseParams, videoEl);
      const settled = pending.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(16_000);

      const message = (await settled as Error).message;
      expect(message).toContain('Timed out');
      // The timeout must say what it last saw, or a throttled server looks
      // identical to an agent that simply never answered.
      expect(message).toContain('429');
      expect(polls()).toBeGreaterThan(1);
      // A flat 50ms poll would have issued ~300 here.
      expect(polls()).toBeLessThan(40);
    });
  });
});
