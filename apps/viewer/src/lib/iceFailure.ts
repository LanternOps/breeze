/**
 * What to do when a WebRTC peer connection fails before it ever connected
 * (#11838).
 *
 * The answer arriving is not the connection: ICE still has to find a working
 * candidate pair. When it cannot (the device's firewall drops outbound UDP and
 * no TURN path it can reach exists), the peer goes `failed` ~20 s after the
 * offer. The reconnect loop used to treat every such failure like a dropped
 * live session: re-offer, get an answer (which ended that attempt's 30 s
 * window as a "success"), fail ICE again, start a fresh window. A site whose
 * network blocks the transport re-offered forever and the operator was never
 * told why.
 *
 * The candidates each side offered say where the block is, so the viewer reads
 * them once the peer fails and either retries or stops with a reason.
 */

export type IceCandidateType = 'host' | 'srflx' | 'prflx' | 'relay';

export type CandidateCounts = Record<IceCandidateType, number>;

export interface IcePathSummary {
  /** Candidates this viewer gathered. */
  local: CandidateCounts;
  /** Candidates the agent offered, in its answer or trickled after it. */
  remote: CandidateCounts;
}

/**
 * - `device_network`: the agent offered only addresses on its own network. It
 *   reached neither the STUN server nor the TURN relay, so nothing outside its
 *   network can reach it.
 * - `viewer_network`: the agent got out but this viewer did not.
 * - `no_path`: both sides reached a server and still no pair worked.
 */
export type IceFailureCause = 'device_network' | 'viewer_network' | 'no_path';

/**
 * Never-connected failures in a row before the viewer stops re-offering, when
 * the candidates leave the cause open. One retry covers a relay that was
 * briefly unreachable; a second identical failure will not change on a third.
 */
export const MAX_NEVER_CONNECTED_ICE_FAILURES = 2;

const CANDIDATE_TYPES: readonly IceCandidateType[] = ['host', 'srflx', 'prflx', 'relay'];

function emptyCounts(): CandidateCounts {
  return { host: 0, srflx: 0, prflx: 0, relay: 0 };
}

function isCandidateType(value: unknown): value is IceCandidateType {
  return typeof value === 'string' && (CANDIDATE_TYPES as readonly string[]).includes(value);
}

function total(counts: CandidateCounts): number {
  return counts.host + counts.srflx + counts.prflx + counts.relay;
}

function countSdpCandidates(sdp: string | undefined): CandidateCounts {
  const counts = emptyCounts();
  if (!sdp) return counts;
  for (const match of sdp.matchAll(/^a=candidate:.*\btyp (\w+)/gm)) {
    if (isCandidateType(match[1])) counts[match[1]] += 1;
  }
  return counts;
}

/**
 * Count the candidate types on each side of a peer connection.
 *
 * getStats is the source of truth: it includes candidates trickled after the
 * answer (#9182). When it has nothing to say (an engine that drops candidate
 * stats once ICE fails) or throws, the descriptions' `a=candidate` lines are
 * the fallback.
 */
export async function summarizeIcePath(pc: RTCPeerConnection): Promise<IcePathSummary> {
  const local = emptyCounts();
  const remote = emptyCounts();
  try {
    const report = await pc.getStats();
    report.forEach((stat: { type?: string; candidateType?: unknown }) => {
      if (!isCandidateType(stat.candidateType)) return;
      if (stat.type === 'local-candidate') local[stat.candidateType] += 1;
      else if (stat.type === 'remote-candidate') remote[stat.candidateType] += 1;
    });
  } catch (err) {
    console.debug('ICE failure diagnosis: getStats failed; reading the SDP instead:', err);
  }
  return {
    local: total(local) > 0 ? local : countSdpCandidates(pc.localDescription?.sdp),
    remote: total(remote) > 0 ? remote : countSdpCandidates(pc.remoteDescription?.sdp),
  };
}

export function classifyIceFailure(summary: IcePathSummary): IceFailureCause {
  const { local, remote } = summary;
  // A peer-reflexive remote candidate means the agent's checks reached this
  // viewer, so the agent did get out.
  if (remote.srflx + remote.relay + remote.prflx === 0) return 'device_network';
  if (local.srflx + local.relay + local.prflx === 0) return 'viewer_network';
  return 'no_path';
}

export function iceFailureMessage(cause: IceFailureCause): string {
  switch (cause) {
    case 'device_network':
      return (
        "Remote desktop could not connect: this device's network blocks the remote desktop " +
        'transport. The device could not reach the STUN server or the TURN relay, so it ' +
        'offered only local network addresses. Its firewall most likely drops outbound UDP ' +
        'and the relay ports. Allow outbound UDP, and TCP to the TURN relay, from this device, then retry.'
      );
    case 'viewer_network':
      return (
        "Remote desktop could not connect: this computer's network blocks the remote desktop " +
        'transport. The device offered a reachable address, but this viewer could not reach the ' +
        'STUN server or the TURN relay. Allow outbound UDP, and TCP to the TURN relay, from this ' +
        'computer, then retry.'
      );
    case 'no_path':
      return (
        'Remote desktop could not connect: no network path between this viewer and the device ' +
        'worked, although both reached the relay servers. A firewall between them may be ' +
        'blocking the connection. Retry, and check the firewalls on both networks if it fails again.'
      );
  }
}

/**
 * `failures` counts this one. A device that reached no server stops at once:
 * re-offering cannot change what its firewall lets out.
 */
export function shouldStopAfterIceFailure(cause: IceFailureCause, failures: number): boolean {
  return cause === 'device_network' || failures >= MAX_NEVER_CONNECTED_ICE_FAILURES;
}

export interface NeverConnectedIceDecision {
  stop: boolean;
  cause: IceFailureCause;
  message: string;
  summary: IcePathSummary;
}

/**
 * Decide what follows the `failures`-th consecutive failure of a peer that
 * never connected: stop with `message`, or retry.
 */
export async function decideNeverConnectedIceFailure(
  pc: RTCPeerConnection,
  failures: number,
): Promise<NeverConnectedIceDecision> {
  const summary = await summarizeIcePath(pc);
  const cause = classifyIceFailure(summary);
  return {
    stop: shouldStopAfterIceFailure(cause, failures),
    cause,
    message: iceFailureMessage(cause),
    summary,
  };
}
