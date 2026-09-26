import { describe, expect, it } from 'vitest';
import {
  nextTopologyPolicyDueAt,
  topologyContinuityKey,
  topologyOccurrenceKey,
  topologyOccurrenceSlot,
  topologyPolicyJitterMs,
} from './monitoringSlots';

const policyId = '11111111-1111-4111-8111-111111111111';
const scope = { orgId: '22222222-2222-4222-8222-222222222222', siteId: '33333333-3333-4333-8333-333333333333' };

describe('monitoring slots', () => {
  it('aligns slots to the UTC epoch so every replica agrees', () => {
    expect(topologyOccurrenceSlot(300, new Date('2026-09-15T00:07:59.999Z')).toISOString()).toBe('2026-09-15T00:05:00.000Z');
    expect(topologyOccurrenceSlot(300, new Date('2026-09-15T00:10:00.000Z')).toISOString()).toBe('2026-09-15T00:10:00.000Z');
  });

  it('derives a reproducible jitter inside 10% of the interval', () => {
    const slot = new Date('2026-09-15T00:05:00Z');
    const a = topologyPolicyJitterMs(policyId, slot, 300);
    expect(topologyPolicyJitterMs(policyId, slot, 300)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(30_000);
    const spread = new Set(Array.from({ length: 20 }, (_, i) => topologyPolicyJitterMs(policyId, new Date(slot.getTime() + i * 300_000), 300)));
    expect(spread.size).toBeGreaterThan(1);
  });

  it('never schedules the next due time in the past', () => {
    for (const at of ['2026-09-15T00:00:00Z', '2026-09-15T00:04:59Z', '2026-09-15T03:00:00Z']) {
      const now = new Date(at);
      const due = nextTopologyPolicyDueAt(policyId, 300, now);
      expect(due.getTime()).toBeGreaterThan(now.getTime());
      expect(due.getTime() - now.getTime()).toBeLessThanOrEqual(330_000);
    }
  });

  it('keys an occurrence by scope/policy/context/family/slot only', () => {
    const base = { scope, policyId, contextKey: 'default', family: 'ipv4' as const, scheduledFor: new Date('2026-09-15T00:05:00Z') };
    const key = topologyOccurrenceKey(base);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(topologyOccurrenceKey({ ...base })).toBe(key);
    expect(topologyOccurrenceKey({ ...base, contextKey: 'vpn' })).not.toBe(key);
    expect(topologyOccurrenceKey({ ...base, family: 'ipv6' })).not.toBe(key);
    expect(topologyOccurrenceKey({ ...base, scheduledFor: new Date('2026-09-15T00:10:00Z') })).not.toBe(key);
  });

  it('starts a fresh continuity series for a new origin or policy revision', () => {
    const base = { policyId, policyRevision: '4', contextKey: 'default', family: 'ipv4' as const, originDeviceId: policyId, originAgentId: 'agent-a' };
    const key = topologyContinuityKey(base);
    expect(topologyContinuityKey({ ...base, originAgentId: 'agent-b' })).not.toBe(key);
    expect(topologyContinuityKey({ ...base, policyRevision: '5' })).not.toBe(key);
  });
});
