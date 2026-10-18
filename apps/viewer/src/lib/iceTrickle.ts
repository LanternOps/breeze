/**
 * Trickle ICE between the viewer and the agent (#9182).
 *
 * The viewer waits a few seconds for ICE gathering before it sends its offer,
 * and the agent answers a short window after its first candidate so a LAN
 * session connects fast. Candidates either side gathers later — above all a
 * TURN relay candidate, whose Allocate round trip often outlasts both waits —
 * used to be dropped, which is exactly the off-LAN case TURN exists for.
 *
 * Outbound: a local candidate gathered after the offer was read is queued
 * until the answer is applied, then POSTed to `/viewer/ice`; the API relays it
 * to the agent.
 * Inbound: unless the answer already carries `a=end-of-candidates`, the
 * session is polled for the agent's late candidates (`agentIceCandidates`),
 * each added once. Entries carry contiguous `seq` numbers and the agent ends
 * with a completion marker; polling stops once every entry below the marker
 * has arrived, on a terminal response, when the peer connection closes or
 * fails, or after {@link TRICKLE_MAX_DURATION_MS}.
 */

import { apiFetch } from './api';

/** Pace of the post-answer poll for the agent's late candidates. */
export const TRICKLE_POLL_INTERVAL_MS = 1000;
/**
 * How long the viewer keeps asking. Covers a slow TURN Allocate (pion retries
 * for several seconds) with room to spare, and is bounded so an older agent
 * that never sends a completion marker costs at most ~30 requests.
 */
export const TRICKLE_MAX_DURATION_MS = 30_000;

export interface IceTrickleParams {
  sessionId: string;
  apiUrl: string;
  accessToken: string;
}

export interface IceTrickle {
  /** The offer SDP has been read: local candidates from now on are trickled. */
  markOfferSent(): void;
  /** The answer has been applied: flush queued candidates and fetch the agent's. */
  start(answerSdp: string): void;
  /** Stop everything and detach from the peer connection. Idempotent. */
  stop(): void;
}

interface AgentIceEntry {
  seq: number;
  candidate?: RTCIceCandidateInit;
  complete?: boolean;
}

function parseAgentEntries(raw: unknown): AgentIceEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentIceEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.seq !== 'number' || !Number.isInteger(e.seq) || e.seq < 0) continue;
    if (e.complete === true) {
      out.push({ seq: e.seq, complete: true });
      continue;
    }
    const c = e.candidate as Record<string, unknown> | undefined;
    if (!c || typeof c.candidate !== 'string' || c.candidate.length === 0) continue;
    const init: RTCIceCandidateInit = { candidate: c.candidate };
    if (typeof c.sdpMid === 'string') init.sdpMid = c.sdpMid;
    if (typeof c.sdpMLineIndex === 'number') init.sdpMLineIndex = c.sdpMLineIndex;
    if (typeof c.usernameFragment === 'string') init.usernameFragment = c.usernameFragment;
    out.push({ seq: e.seq, candidate: init });
  }
  return out;
}

export function createIceTrickle(pc: RTCPeerConnection, params: IceTrickleParams): IceTrickle {
  let offerSent = false;
  let started = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let deadline = 0;
  const queued: RTCIceCandidateInit[] = [];
  const seenSeqs = new Set<number>();
  let completeSeq: number | null = null;
  let postFailureLogged = false;

  const canListen = typeof (pc as Partial<RTCPeerConnection>).addEventListener === 'function';

  const post = (candidate: RTCIceCandidateInit) => {
    void apiFetch(
      params.apiUrl,
      `/api/v1/desktop-ws/${params.sessionId}/viewer/ice`,
      params.accessToken,
      { method: 'POST', body: JSON.stringify({ candidate }) },
    ).then((resp) => {
      if (!resp.ok && !postFailureLogged) {
        postFailureLogged = true;
        console.warn(`Trickle ICE: the API refused a late local candidate (HTTP ${resp.status})`);
      }
    }).catch((err) => {
      if (!postFailureLogged) {
        postFailureLogged = true;
        console.warn('Trickle ICE: failed to send a late local candidate:', err);
      }
    });
  };

  const onLocalCandidate = (event: Event) => {
    if (stopped || !offerSent) return; // before the offer: already in its SDP
    const candidate = (event as RTCPeerConnectionIceEvent).candidate;
    // null / empty candidate is the end-of-candidates signal, not a candidate.
    if (!candidate || !candidate.candidate) return;
    const init = candidate.toJSON();
    if (started) post(init);
    else queued.push(init);
  };

  if (canListen) pc.addEventListener('icecandidate', onLocalCandidate);

  const finished = () =>
    completeSeq !== null && Array.from({ length: completeSeq }, (_, i) => i).every((i) => seenSeqs.has(i));

  const poll = async () => {
    pollTimer = null;
    if (stopped) return;
    if (Date.now() > deadline || pc.connectionState === 'closed' || pc.connectionState === 'failed') return;
    try {
      const resp = await apiFetch(
        params.apiUrl,
        `/api/v1/desktop-ws/${params.sessionId}/viewer/session`,
        params.accessToken,
      );
      if (stopped) return;
      if (resp.ok) {
        const data = await resp.json();
        if (stopped) return;
        for (const entry of parseAgentEntries(data?.agentIceCandidates)) {
          if (seenSeqs.has(entry.seq)) continue;
          seenSeqs.add(entry.seq);
          if (entry.complete) {
            completeSeq = entry.seq;
            continue;
          }
          if (entry.candidate) {
            pc.addIceCandidate(entry.candidate).catch((err) => {
              console.warn('Trickle ICE: failed to add a late agent candidate:', err);
            });
          }
        }
        if (finished()) return;
      } else if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
        // The session, token or policy rules this out; the connection path
        // owns surfacing that. Nothing more to fetch.
        return;
      }
    } catch {
      // Transient: try again on the next tick until the deadline.
    }
    if (!stopped) pollTimer = setTimeout(() => void poll(), TRICKLE_POLL_INTERVAL_MS);
  };

  return {
    markOfferSent() {
      offerSent = true;
    },
    start(answerSdp: string) {
      if (stopped || started) return;
      started = true;
      for (const c of queued.splice(0)) post(c);
      if (/^a=end-of-candidates/m.test(answerSdp)) return;
      deadline = Date.now() + TRICKLE_MAX_DURATION_MS;
      void poll();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      queued.length = 0;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      if (canListen) pc.removeEventListener('icecandidate', onLocalCandidate);
    },
  };
}
