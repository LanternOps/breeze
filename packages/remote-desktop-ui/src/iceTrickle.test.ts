import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createIceTrickle,
  TRICKLE_POLL_INTERVAL_MS,
  TRICKLE_MAX_DURATION_MS,
  TRICKLE_CONNECTED_GRACE_MS,
  TRICKLE_POLLS_AFTER_COMPLETE,
} from './iceTrickle';

// #9182: the viewer capped its own gathering at 3 s and never sent another
// candidate after its offer, and never asked for the agent's late ones — so a
// TURN relay candidate allocated on either side after the offer/answer was
// silently dropped.

const params = { sessionId: 'sess-9182', apiUrl: 'https://api.example.com', accessToken: 'viewer-token' };
const RELAY = 'candidate:9 1 udp 16777215 198.51.100.7 3478 typ relay raddr 203.0.113.5 rport 50000';
const ANSWER_PARTIAL = 'v=0\r\na=candidate:1 1 udp 2130706431 192.0.2.10 1000 typ host\r\n';
const ANSWER_COMPLETE = `${ANSWER_PARTIAL}a=end-of-candidates\r\n`;

class FakePC {
  connectionState: RTCPeerConnectionState = 'connecting';
  added: RTCIceCandidateInit[] = [];
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    this.added.push(c);
  }
  emitLocal(candidate: string | null) {
    const event = {
      candidate: candidate === null ? null : {
        candidate,
        toJSON: () => ({ candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'vfrag' }),
      },
    };
    for (const fn of this.listeners.get('icecandidate') ?? []) fn(event);
  }
}

interface FetchCall { url: string; init?: RequestInit }

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Routes session polls through `pollBodies` (last one repeats) and records every call. */
function stubFetch(pollBodies: Array<{ status?: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  let pollIndex = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/viewer/session')) {
      const next = pollBodies[Math.min(pollIndex, pollBodies.length - 1)]!;
      pollIndex++;
      return jsonResponse(next.body, next.status ?? 200);
    }
    return jsonResponse({ accepted: true, forwarded: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    polls: () => calls.filter((c) => c.url.endsWith('/viewer/session')).length,
    posts: () => calls.filter((c) => c.url.endsWith('/viewer/ice')),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('inbound: the agent\'s late candidates', () => {
  it('adds a remote candidate that arrives after the answer was applied', async () => {
    const pc = new FakePC();
    const net = stubFetch([
      { body: { agentIceCandidates: [] } },
      { body: { agentIceCandidates: [{ seq: 0, candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 } }] } },
    ]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    trickle.start(ANSWER_PARTIAL);

    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS * 3);

    expect(pc.added).toEqual([{ candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 }]);
    expect(net.polls()).toBeGreaterThanOrEqual(2);
    trickle.stop();
  });

  it('stops polling once every entry up to the completion marker has arrived', async () => {
    const pc = new FakePC();
    const net = stubFetch([
      { body: { agentIceCandidates: [{ seq: 0, candidate: { candidate: RELAY } }, { seq: 1, complete: true }] } },
    ]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    trickle.start(ANSWER_PARTIAL);

    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS * 5);

    expect(net.polls()).toBe(1);
    expect(pc.added).toHaveLength(1);
  });

  it('keeps polling through a gap below the completion marker', async () => {
    const pc = new FakePC();
    const net = stubFetch([
      { body: { agentIceCandidates: [{ seq: 1, complete: true }] } },
      { body: { agentIceCandidates: [{ seq: 0, candidate: { candidate: RELAY } }, { seq: 1, complete: true }] } },
    ]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    trickle.start(ANSWER_PARTIAL);

    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS * 5);

    expect(pc.added).toEqual([{ candidate: RELAY }]);
    expect(net.polls()).toBe(2);
  });

  it('applies each entry once even though every poll returns the full list', async () => {
    const pc = new FakePC();
    stubFetch([{ body: { agentIceCandidates: [{ seq: 0, candidate: { candidate: RELAY } }] } }]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    trickle.start(ANSWER_PARTIAL);

    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS * 4);

    expect(pc.added).toHaveLength(1);
    trickle.stop();
  });

  it('does not poll when the answer already ends the candidates', async () => {
    const pc = new FakePC();
    const net = stubFetch([{ body: { agentIceCandidates: [] } }]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    trickle.start(ANSWER_COMPLETE);

    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS * 5);

    expect(net.polls()).toBe(0);
    trickle.stop();
  });

  it('gives up after the trickle window (an older agent never sends a marker)', async () => {
    const pc = new FakePC();
    const net = stubFetch([{ body: { webrtcAnswer: 'v=0' } }]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    trickle.start(ANSWER_PARTIAL);

    await vi.advanceTimersByTimeAsync(TRICKLE_MAX_DURATION_MS + TRICKLE_POLL_INTERVAL_MS * 3);
    const pollsAtDeadline = net.polls();
    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS * 10);

    expect(net.polls()).toBe(pollsAtDeadline);
    expect(pollsAtDeadline).toBeLessThanOrEqual(Math.ceil(TRICKLE_MAX_DURATION_MS / TRICKLE_POLL_INTERVAL_MS) + 1);
    trickle.stop();
  });

  it('stops on a terminal response', async () => {
    const pc = new FakePC();
    const net = stubFetch([{ status: 401, body: { error: 'Session closed' } }]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    trickle.start(ANSWER_PARTIAL);

    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS * 5);

    expect(net.polls()).toBe(1);
  });

  it('stops once the peer connection is closed', async () => {
    const pc = new FakePC();
    const net = stubFetch([{ body: { agentIceCandidates: [] } }]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    trickle.start(ANSWER_PARTIAL);
    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS);
    pc.connectionState = 'closed';
    const before = net.polls();
    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS * 5);

    expect(net.polls()).toBeLessThanOrEqual(before + 1);
    trickle.stop();
  });
});

describe('inbound: bounded polling (#9182 review)', () => {
  it('stops shortly after the connection is up', async () => {
    const pc = new FakePC();
    const net = stubFetch([{ body: { agentIceCandidates: [] } }]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    trickle.start(ANSWER_PARTIAL);
    pc.connectionState = 'connected';

    await vi.advanceTimersByTimeAsync(TRICKLE_CONNECTED_GRACE_MS + TRICKLE_POLL_INTERVAL_MS * 2);
    const settled = net.polls();
    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS * 10);

    expect(net.polls()).toBe(settled);
    expect(settled).toBeLessThanOrEqual(Math.ceil(TRICKLE_CONNECTED_GRACE_MS / TRICKLE_POLL_INTERVAL_MS) + 2);
    trickle.stop();
  });

  it('stops a few polls after the completion marker even if an entry never arrives', async () => {
    const pc = new FakePC();
    const net = stubFetch([{ body: { agentIceCandidates: [{ seq: 1, complete: true }] } }]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    trickle.start(ANSWER_PARTIAL);

    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS * 12);

    expect(net.polls()).toBe(1 + TRICKLE_POLLS_AFTER_COMPLETE);
    trickle.stop();
  });

  it('counts an entry it cannot use toward completion', async () => {
    const pc = new FakePC();
    const net = stubFetch([{ body: { agentIceCandidates: [{ seq: 0, candidate: { candidate: '' } }, { seq: 1, complete: true }] } }]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    trickle.start(ANSWER_PARTIAL);

    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS * 5);

    expect(net.polls()).toBe(1);
    expect(pc.added).toHaveLength(0);
  });
});

describe('outbound: the viewer\'s late candidates', () => {
  it('does not resend a candidate already in the offer SDP', async () => {
    const pc = new FakePC();
    const net = stubFetch([{ body: { agentIceCandidates: [] } }]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent('v=0\r\na=candidate:host-in-offer\r\n');
    pc.emitLocal('candidate:host-in-offer');
    pc.emitLocal(RELAY);
    trickle.start(ANSWER_COMPLETE);
    await vi.advanceTimersByTimeAsync(0);

    expect(net.posts().map((p) => JSON.parse(String(p.init?.body)).candidate.candidate)).toEqual([RELAY]);
    trickle.stop();
  });

  it('warns when the API could not relay a candidate to the agent', async () => {
    const pc = new FakePC();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ accepted: true, forwarded: false })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    trickle.start(ANSWER_COMPLETE);
    pc.emitLocal(RELAY);
    await vi.advanceTimersByTimeAsync(0);

    expect(warn.mock.calls.some((c) => String(c[0]).includes('did not reach the agent'))).toBe(true);
    trickle.stop();
  });

  it('sends only candidates gathered after the offer, and only once the answer is applied', async () => {
    const pc = new FakePC();
    const net = stubFetch([{ body: { agentIceCandidates: [] } }]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);

    pc.emitLocal('candidate:host-in-offer'); // in the offer SDP already
    trickle.markOfferSent();
    pc.emitLocal(RELAY); // after the offer, before the answer
    pc.emitLocal(''); // end-of-candidates marker — never sent
    pc.emitLocal(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(net.posts()).toHaveLength(0);

    trickle.start(ANSWER_COMPLETE);
    await vi.advanceTimersByTimeAsync(0);
    pc.emitLocal('candidate:late-after-answer');
    await vi.advanceTimersByTimeAsync(0);

    const posts = net.posts();
    expect(posts.map((p) => JSON.parse(String(p.init?.body)).candidate.candidate)).toEqual([
      RELAY,
      'candidate:late-after-answer',
    ]);
    expect(posts[0]!.url).toBe('https://api.example.com/api/v1/desktop-ws/sess-9182/viewer/ice');
    expect(posts[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(posts[0]!.init?.body))).toEqual({
      candidate: { candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'vfrag' },
    });
    trickle.stop();
  });

  it('stop() detaches from the peer connection and drops queued candidates', async () => {
    const pc = new FakePC();
    const net = stubFetch([{ body: { agentIceCandidates: [] } }]);
    const trickle = createIceTrickle(pc as unknown as RTCPeerConnection, params);
    trickle.markOfferSent();
    pc.emitLocal(RELAY);
    trickle.stop();
    trickle.start(ANSWER_PARTIAL);
    await vi.advanceTimersByTimeAsync(TRICKLE_POLL_INTERVAL_MS * 3);

    expect(pc.listenerCount('icecandidate')).toBe(0);
    expect(net.calls).toHaveLength(0);
  });

  it('tolerates a peer connection without event listeners', () => {
    const trickle = createIceTrickle({} as RTCPeerConnection, params);
    expect(() => {
      trickle.markOfferSent();
      trickle.stop();
    }).not.toThrow();
  });
});
