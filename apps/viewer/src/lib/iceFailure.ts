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
 * The candidates each side offered point at where the block is, so the viewer
 * reads them once the peer fails, retries once, and then stops with a reason.
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
 * - `device_network`: every candidate received from the agent was a local
 *   (host) address: no server-reflexive or relay candidate arrived.
 * - `viewer_network`: the agent sent a non-local candidate, this viewer
 *   gathered none.
 * - `no_path`: both sides had non-local candidates and still no pair worked.
 * - `unknown`: no candidates could be read for a side (or the read failed).
 *
 * These are inferences from what arrived, not proof: an agent candidate lost
 * on the trickle path (#9182) looks the same as one never gathered. That is
 * why no cause stops on the first failure.
 */
export type IceFailureCause = 'device_network' | 'viewer_network' | 'no_path' | 'unknown';

/**
 * Never-connected failures in a row before the viewer stops re-offering. One
 * retry covers a relay that was briefly unreachable or a late candidate lost
 * on the way; a second identical failure will not change on a third.
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

function maxCounts(a: CandidateCounts, b: CandidateCounts): CandidateCounts {
  return {
    host: Math.max(a.host, b.host),
    srflx: Math.max(a.srflx, b.srflx),
    prflx: Math.max(a.prflx, b.prflx),
    relay: Math.max(a.relay, b.relay),
  };
}

/**
 * Count the candidate types on each side of a peer connection.
 *
 * Two sources, per type the larger count wins. getStats includes candidates
 * trickled after the answer (#9182) but may list only candidates that were
 * paired, or nothing once ICE fails. The descriptions' `a=candidate` lines
 * carry whatever was in the offer and answer.
 */
export async function summarizeIcePath(
  pc: RTCPeerConnection,
  statsTimeoutMs = ICE_STATS_TIMEOUT_MS,
): Promise<IcePathSummary> {
  const local = emptyCounts();
  const remote = emptyCounts();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const report = await Promise.race([
      pc.getStats(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`getStats did not settle in ${statsTimeoutMs} ms`)), statsTimeoutMs);
      }),
    ]);
    report.forEach((stat: { type?: string; candidateType?: unknown }) => {
      if (!isCandidateType(stat.candidateType)) return;
      if (stat.type === 'local-candidate') local[stat.candidateType] += 1;
      else if (stat.type === 'remote-candidate') remote[stat.candidateType] += 1;
    });
  } catch (err) {
    console.warn('ICE failure diagnosis: getStats failed; using the SDP candidates only:', err);
  } finally {
    clearTimeout(timer);
  }
  return {
    local: maxCounts(local, countSdpCandidates(pc.localDescription?.sdp)),
    remote: maxCounts(remote, countSdpCandidates(pc.remoteDescription?.sdp)),
  };
}

/**
 * Bound on the stats read. A WebView whose getStats never settles on a failed
 * peer would otherwise leave the viewer with no loop and no error.
 */
export const ICE_STATS_TIMEOUT_MS = 2_000;

export function classifyIceFailure(summary: IcePathSummary): IceFailureCause {
  const { local, remote } = summary;
  // Nothing read for a side is not evidence about that side's network.
  if (total(remote) === 0) return 'unknown';
  // A peer-reflexive remote candidate means the agent's checks reached this
  // viewer, so the agent did get out.
  if (remote.srflx + remote.relay + remote.prflx === 0) return 'device_network';
  if (total(local) === 0) return 'unknown';
  if (local.srflx + local.relay + local.prflx === 0) return 'viewer_network';
  return 'no_path';
}

export function iceFailureMessage(cause: IceFailureCause): string {
  switch (cause) {
    case 'device_network':
      return (
        "Remote desktop could not connect: this device's network appears to block the remote " +
        'desktop transport. The device sent only local network addresses, which usually means ' +
        'it could not reach the STUN server or the TURN relay because its firewall drops ' +
        'outbound UDP and the relay ports. Allow outbound UDP, and TCP to the TURN relay, from ' +
        'this device, then retry.'
      );
    case 'viewer_network':
      return (
        "Remote desktop could not connect: this computer's network appears to block the remote " +
        'desktop transport. The device sent a non-local address, but this viewer gathered only ' +
        'local addresses, which usually means it could not reach the STUN server or the TURN ' +
        'relay. Allow outbound UDP, and TCP to the TURN relay, from this computer, then retry.'
      );
    case 'no_path':
      return (
        'Remote desktop could not connect: no network path between this viewer and the device ' +
        'worked, although both sides found non-local addresses. A firewall between them may be ' +
        'blocking the connection. Retry, and check the firewalls on both networks if it fails again.'
      );
    case 'unknown':
      return (
        'Remote desktop could not connect: no network path between this viewer and the device ' +
        'worked. A firewall may be blocking the connection. Check that both networks allow ' +
        'outbound UDP, and TCP to the TURN relay, then retry.'
      );
  }
}

/**
 * `failures` counts this one. The cause does not change the budget (see
 * {@link IceFailureCause}); it only picks the message.
 */
export function shouldStopAfterIceFailure(_cause: IceFailureCause, failures: number): boolean {
  return failures >= MAX_NEVER_CONNECTED_ICE_FAILURES;
}

export interface NeverConnectedIceDecision {
  stop: boolean;
  cause: IceFailureCause;
  message: string;
  summary: IcePathSummary;
}

/**
 * Decide what follows the `failures`-th consecutive failure of a peer that
 * never connected: stop with `message`, or retry. Never rejects: a failed
 * read leaves the summary empty, which classifies as `unknown`.
 */
export async function decideNeverConnectedIceFailure(
  pc: RTCPeerConnection,
  failures: number,
  statsTimeoutMs = ICE_STATS_TIMEOUT_MS,
): Promise<NeverConnectedIceDecision> {
  let summary: IcePathSummary;
  try {
    summary = await summarizeIcePath(pc, statsTimeoutMs);
  } catch (err) {
    console.warn('ICE failure diagnosis failed; the cause is unknown:', err);
    summary = { local: emptyCounts(), remote: emptyCounts() };
  }
  const cause = classifyIceFailure(summary);
  return {
    stop: shouldStopAfterIceFailure(cause, failures),
    cause,
    message: iceFailureMessage(cause),
    summary,
  };
}
