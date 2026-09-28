import { describe, expect, it, vi } from 'vitest';
import { graphRelationshipSchema } from '@breeze/shared';
import { overlayHealthSummary, type TopologyMonitorOverlay } from './monitorOverlays';
import {
  aggregateTopologySubjectHealth, monitorOverlayContribution, readTopologySubjectHealth,
  type TopologyHealthContribution, type TopologyHealthContributor,
} from './subjectHealth';

const REL = '33333333-3333-4333-8333-333333333333';
const NODE = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-02T12:00:00Z');
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000).toISOString();

function contribution(over: Partial<TopologyHealthContribution>): TopologyHealthContribution {
  return {
    subject: { kind: 'relationship', id: REL }, source: 'monitor', key: 'k1', contextKey: 'ctx-a',
    status: 'healthy', coverage: 'monitored', freshness: 'fresh', reasons: [], originNodeId: null, resultId: null, freshUntil: later(60), ...over,
  };
}
const valid = (health: unknown) => expect(graphRelationshipSchema.shape.health.safeParse(health).success, JSON.stringify(health)).toBe(true);

describe('aggregateTopologySubjectHealth', () => {
  it('keeps the M1 single-overlay projection byte-identical', () => {
    const overlay: TopologyMonitorOverlay = {
      subject: { kind: 'node', id: NODE }, bindingId: 'b1', contextKey: 'default', family: 'ipv4', metricRole: 'connectivity',
      status: 'failed_check', coverage: 'monitored', freshness: 'fresh', reasons: ['family_unverified'], activeAlertCount: 1, freshUntil: later(30),
      provenance: { monitorId: 'm', monitorName: null, monitorType: null, destination: null, runId: null, resultId: '55555555-5555-4555-8555-555555555555',
        originDeviceId: null, originNodeId: NODE, observedAt: NOW.toISOString() },
    };
    const aggregated = aggregateTopologySubjectHealth('node', [monitorOverlayContribution(overlay)], NOW);
    expect(aggregated.health).toEqual(overlayHealthSummary('node', overlay));
    expect(aggregated.freshUntil).toBe(later(30));
    expect(aggregateTopologySubjectHealth('relationship', [], NOW)).toEqual({ health: overlayHealthSummary('relationship', undefined), freshUntil: null });
  });

  it('defines multi-context aggregation instead of letting the last overlay overwrite the rest', () => {
    // Two contexts that agree: the worse fresh status is reported, not the last one read.
    const agree = aggregateTopologySubjectHealth('relationship', [
      contribution({ key: 'a', status: 'degraded', reasons: ['x_degraded'] }), contribution({ key: 'b', contextKey: 'ctx-b', status: 'healthy' }),
    ], NOW);
    expect(agree.health.status).toBe('degraded');
    // A failure seen from one context and success from another is location-specific, never averaged green nor a global outage.
    const mixed = aggregateTopologySubjectHealth('relationship', [
      contribution({ key: 'a', status: 'failed_check', resultId: '66666666-6666-4666-8666-666666666666' }), contribution({ key: 'b', contextKey: 'ctx-b', status: 'healthy' }),
    ], NOW);
    expect(mixed.health.status).toBe('degraded');
    expect(mixed.health.reasons.map(r => r.code)).toContain('mixed_context_results');
    expect(mixed.health.resultId).toBe('66666666-6666-4666-8666-666666666666');
    valid(mixed.health);
    // Within one context (both endpoints of one link) the worst view wins.
    const sameContext = aggregateTopologySubjectHealth('relationship', [
      contribution({ key: 'interface:source', contextKey: 'interface', source: 'interface', status: 'failed_check', reasons: ['interface_link_down'] }),
      contribution({ key: 'interface:target', contextKey: 'interface', source: 'interface', status: 'healthy' }),
    ], NOW);
    expect(sameContext.health.status).toBe('failed_check');
    expect(sameContext.health.reasons.map(r => r.code)).toEqual(['interface_link_down']);
  });

  it('never lets stale or unmonitored evidence decide status, and reports coverage honestly', () => {
    const result = aggregateTopologySubjectHealth('relationship', [
      contribution({ key: 'a', status: 'unknown', freshness: 'stale', coverage: 'partial', reasons: ['stale_monitor_result'], freshUntil: null }),
      contribution({ key: 'b', contextKey: 'ctx-b', status: 'healthy' }),
    ], NOW);
    expect(result.health).toMatchObject({ status: 'healthy', coverage: 'partial', freshness: 'fresh' });
    const none = aggregateTopologySubjectHealth('relationship', [
      contribution({ key: 'a', status: 'unknown', freshness: 'unknown', coverage: 'unmonitored', reasons: ['interface_unmeasured'], freshUntil: null }),
      contribution({ key: 'b', contextKey: 'ctx-b', status: 'unknown', freshness: 'stale', coverage: 'partial', reasons: ['stale_monitor_result'], freshUntil: null }),
    ], NOW);
    expect(none.health).toMatchObject({ status: 'unknown', coverage: 'partial', freshness: 'stale' });
    valid(none.health);
  });

  it('exposes the earliest future freshness expiry so validators refresh when the projection would change', () => {
    const result = aggregateTopologySubjectHealth('relationship', [
      contribution({ key: 'a', freshUntil: later(90) }), contribution({ key: 'b', contextKey: 'ctx-b', freshUntil: later(15) }),
      contribution({ key: 'c', contextKey: 'ctx-c', freshUntil: later(-5) }),
    ], NOW);
    expect(result.freshUntil).toBe(later(15));
  });
});

describe('readTopologySubjectHealth', () => {
  it('collects every registered contributor per subject (the run/policy branch plugs in here)', async () => {
    const policy: TopologyHealthContributor = { source: 'policy', read: vi.fn(async () => [contribution({ key: 'p', source: 'policy', contextKey: 'policy:1' })]) };
    const monitor: TopologyHealthContributor = { source: 'monitor', read: vi.fn(async () => [contribution({ key: 'm' })]) };
    const map = await readTopologySubjectHealth({ executor: { execute: vi.fn() } as never, ctx: {} as never, subjects: [{ kind: 'relationship', id: REL }], now: NOW,
      exposure: { interfaceHealth: false } }, [monitor, policy]);
    expect(map.get(`relationship:${REL}`)?.map(c => c.key)).toEqual(['m', 'p']);
    expect(policy.read).toHaveBeenCalledWith(expect.objectContaining({ now: NOW, exposure: { interfaceHealth: false } }));
  });
});
