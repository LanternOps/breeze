/**
 * Target liveness at confirm (#8318 spec §6.5, decision 5).
 *
 * The target is live if ANY of its credentials was used recently. The
 * signals, newest wins:
 *   - devices.last_seen_at — agent heartbeats;
 *   - devices.watchdog_last_seen — watchdog beats;
 *   - the agent WS presence lease (`agent-presence:<agentId>`, 90 s TTL): a
 *     lease that exists means a socket is connected NOW;
 *   - the credential-use marker `agent-cred-use:<deviceId>` (wave 1b-1),
 *     written by every successful agent, helper and WS authentication — it
 *     covers the REST command poll, which claims work without touching
 *     last_seen_at.
 * The target counts as silent only when the newest signal is older than
 * `min(intent.requested_at, now − 10 min)`. When Redis cannot answer either
 * read, the answer is `unknown` and confirm refuses with `liveness_unknown`
 * (fail closed).
 */
import { readAgentCredentialUse } from '../agentCredentialUse';
import { probeAgentPresence } from '../agentPresence';
import { REATTACH_TARGET_QUIET_PERIOD_MS } from './protocol';

export type TargetLivenessSignal = 'heartbeat' | 'watchdog' | 'credential_use' | 'ws_presence';

export type TargetLiveness =
  | { state: 'silent' }
  | { state: 'alive'; signal: TargetLivenessSignal; at: Date }
  | { state: 'unknown' };

/** The instant every signal must be older than for the target to count as silent. */
export function targetSilenceThreshold(requestedAt: Date, now: Date): Date {
  return new Date(Math.min(requestedAt.getTime(), now.getTime() - REATTACH_TARGET_QUIET_PERIOD_MS));
}

export async function readTargetLiveness(
  target: { id: string; agentId: string; lastSeenAt: Date | null; watchdogLastSeen: Date | null },
  requestedAt: Date,
  now: Date,
): Promise<TargetLiveness> {
  const [credentialUse, presence] = await Promise.all([
    readAgentCredentialUse(target.id),
    probeAgentPresence(target.agentId),
  ]);
  if ('unavailable' in credentialUse || 'unavailable' in presence) return { state: 'unknown' };
  if (presence.present) return { state: 'alive', signal: 'ws_presence', at: now };

  const threshold = targetSilenceThreshold(requestedAt, now).getTime();
  const signals: Array<[TargetLivenessSignal, Date | null]> = [
    ['heartbeat', target.lastSeenAt],
    ['watchdog', target.watchdogLastSeen],
    ['credential_use', credentialUse.at],
  ];
  let newest: { signal: TargetLivenessSignal; at: Date } | null = null;
  for (const [signal, at] of signals) {
    if (at && !Number.isNaN(at.getTime()) && (!newest || at.getTime() > newest.at.getTime())) {
      newest = { signal, at };
    }
  }
  if (newest && newest.at.getTime() >= threshold) return { state: 'alive', ...newest };
  return { state: 'silent' };
}
