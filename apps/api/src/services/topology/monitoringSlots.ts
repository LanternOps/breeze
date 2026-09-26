import { createHash } from 'node:crypto';
import { canonicalizeArguments } from '@breeze/shared/canonicalize';
import type { TopologyScope } from '@breeze/shared';

/**
 * Deterministic recurrence arithmetic (M3 Task 7). Slots are aligned to the
 * UTC epoch in whole intervals, so every replica computes the same slot for
 * the same instant; the per-slot jitter (0 to +10% of the interval) is derived
 * from a hash of the policy and slot — never fresh randomness on a retry — so
 * it spreads load without ever moving a slot's identity.
 */
const sha256 = (value: Record<string, unknown>) => createHash('sha256').update(canonicalizeArguments(value)).digest('hex');

/** Start of the slot containing `now`. */
export function topologyOccurrenceSlot(intervalSeconds: number, now: Date): Date {
  const intervalMs = intervalSeconds * 1000;
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
}

/** Stable jitter in [0, 10% of the interval) for one policy slot. */
export function topologyPolicyJitterMs(policyId: string, slot: Date, intervalSeconds: number): number {
  const window = Math.floor(intervalSeconds * 1000 * 0.1);
  if (window <= 0) return 0;
  const hash = createHash('sha256').update(`${policyId}:${slot.toISOString()}`).digest();
  return hash.readUInt32BE(0) % window;
}

/** The earliest future due time: this slot's jittered start if still ahead, else the next slot's. */
export function nextTopologyPolicyDueAt(policyId: string, intervalSeconds: number, now: Date): Date {
  const slot = topologyOccurrenceSlot(intervalSeconds, now);
  const due = new Date(slot.getTime() + topologyPolicyJitterMs(policyId, slot, intervalSeconds));
  if (due.getTime() > now.getTime()) return due;
  const next = new Date(slot.getTime() + intervalSeconds * 1000);
  return new Date(next.getTime() + topologyPolicyJitterMs(policyId, next, intervalSeconds));
}

/** Identity of one scheduled slot for one context/family; independent of authority or origin. */
export function topologyOccurrenceKey(input: { scope: TopologyScope; policyId: string; contextKey: string; family: 'ipv4' | 'ipv6'; scheduledFor: Date }): string {
  return sha256({
    kind: 'topology-occurrence-v1',
    orgId: input.scope.orgId,
    siteId: input.scope.siteId,
    policyId: input.policyId,
    contextKey: input.contextKey,
    family: input.family,
    scheduledFor: input.scheduledFor.toISOString(),
  });
}

/** A measurement series: a new policy revision or a different origin starts a fresh series (no pre/post mixing). */
export function topologyContinuityKey(input: { policyId: string; policyRevision: string; contextKey: string; family: 'ipv4' | 'ipv6'; originDeviceId: string; originAgentId: string }): string {
  return sha256({ kind: 'topology-continuity-v1', ...input });
}
