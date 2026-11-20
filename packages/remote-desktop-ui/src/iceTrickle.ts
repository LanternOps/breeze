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
 * has arrived (or a few polls after the marker if one never does), shortly
 * after the connection is up, on a terminal response, when the peer
 * connection closes or fails, or after {@link TRICKLE_MAX_DURATION_MS}.
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
/**
 * Once the peer connection is up, keep collecting the agent's late candidates
 * this much longer (a relay arriving now is the fallback path if the direct
 * pair later drops), then stop paying for polls.
 */
export const TRICKLE_CONNECTED_GRACE_MS = 5_000;
/**
 * Polls to spend waiting for entries still missing below the completion
 * marker. A frame the agent could not send leaves a permanent gap; this keeps
 * that from costing the whole window.
 */
export const TRICKLE_POLLS_AFTER_COMPLETE = 3;

export interface IceTrickleParams {
  sessionId: string;
  apiUrl: string;
  accessToken: string;
}

export interface IceTrickle {
  /**
   * The offer SDP has been read: local candidates from now on are trickled,
   * except any already in `offerSdp`.
   */
  markOfferSent(offerSdp?: string): void;
  /** The answer has been applied: flush queued candidates and fetch the agent's. */
  start(answerSdp: string): void;
  /** Stop everything and detach from the peer connection. Idempotent. */
  stop(): void;
}

interface AgentIceEntry {
  seq: number;
  /** Absent for the completion marker and for an entry this viewer cannot use. */
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
    if (!c || typeof c.candidate !== 'string' || c.candidate.length === 0) {
      // Still counts toward completion, or the viewer would wait for an
      // entry it already has.
      out.push({ seq: e.seq });
      continue;
    }
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
  let offerSdp = '';
  let started = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let deadline = 0;
  const queued: RTCIceCandidateInit[] = [];
  const seenSeqs = new Set<number>();
  let completeSeq: number | null = null;
  let pollsSinceComplete = 0;
  let connectedAt: number | null = null;
  let postFailureLogged = false;
  let notForwardedLogged = false;
  let pollFailureLogged = false;
  let added = 0;

  const endPolling = (reason: string) => {
    console.debug(
      `Trickle ICE: stopped fetching agent candidates (${reason}); ` +
        `added ${added}, completion marker ${completeSeq === null ? 'not seen' : 'seen'}`,
    );
  };

  const canListen = typeof (pc as Partial<RTCPeerConnection>).addEventListener === 'function';

  const post = (candidate: RTCIceCandidateInit) => {
    void apiFetch(
      params.apiUrl,
      `/api/v1/desktop-ws/${params.sessionId}/viewer/ice`,
      params.accessToken,
      { method: 'POST', body: JSON.stringify({ candidate }) },
    ).then(async (resp) => {
      if (!resp.ok) {
        if (!postFailureLogged) {
          postFailureLogged = true;
          console.warn(`Trickle ICE: the API refused a late local candidate (HTTP ${resp.status})`);
        }
        return;
      }
      const body = await resp.json().catch(() => null);
      if (body?.forwarded === false && !notForwardedLogged) {
        notForwardedLogged = true;
        console.warn('Trickle ICE: a late local candidate was stored but did not reach the agent (agent not reachable from this API instance)');
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
    // Its event can fire after the offer was read even though the candidate
    // made it into the offer SDP; don't spend a slot sending it again.
    const line = candidate.candidate.replace(/^candidate:/, '');
    if (offerSdp && offerSdp.includes(`a=candidate:${line}`)) return;
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
    const now = Date.now();
    if (now > deadline) return endPolling('time limit');
    if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
      return endPolling(`connection ${pc.connectionState}`);
    }
    if (pc.connectionState === 'connected') {
      connectedAt ??= now;
      if (now - connectedAt >= TRICKLE_CONNECTED_GRACE_MS) return endPolling('connected');
    }
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
            added++;
            pc.addIceCandidate(entry.candidate).catch((err) => {
              console.warn('Trickle ICE: failed to add a late agent candidate:', err);
            });
          }
        }
        if (finished()) return endPolling('all candidates received');
        if (completeSeq !== null && ++pollsSinceComplete > TRICKLE_POLLS_AFTER_COMPLETE) {
          return endPolling('entries below the completion marker never arrived');
        }
      } else if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
        // The session, token or policy rules this out; the connection path
        // owns surfacing that. Nothing more to fetch.
        return endPolling(`HTTP ${resp.status}`);
      } else if (!pollFailureLogged) {
        pollFailureLogged = true;
        console.warn(`Trickle ICE: fetching agent candidates got HTTP ${resp.status}; retrying`);
      }
    } catch (err) {
      // Transient: try again on the next tick until the deadline.
      if (!pollFailureLogged) {
        pollFailureLogged = true;
        console.warn('Trickle ICE: fetching agent candidates failed; retrying:', err);
      }
    }
    if (!stopped) pollTimer = setTimeout(() => void poll(), TRICKLE_POLL_INTERVAL_MS);
  };

  return {
    markOfferSent(sdp?: string) {
      offerSent = true;
      offerSdp = sdp ?? '';
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
