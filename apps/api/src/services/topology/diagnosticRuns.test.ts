import { describe, expect, it } from 'vitest';

import {
  TOPOLOGY_DIAGNOSTIC_QUOTAS,
  exceededTopologyDiagnosticQuota,
  topologyDiagnosticBodyHash,
  type TopologyDiagnosticUsage,
} from './diagnosticRuns';

const idle: TopologyDiagnosticUsage = {
  activeForAgent: 0,
  activeForSite: 0,
  activeForOrg: 0,
  startsForUser: 0,
  startsForSite: 0,
  startsForOrg: 0,
};

const request = {
  recipeId: 'gateway_basic' as const,
  recipeVersion: 1 as const,
  subject: { kind: 'node' as const, id: '00000000-0000-4000-8000-000000000001' },
  graphRevision: '7',
};

describe('topology diagnostic quotas', () => {
  it('admits a request while every counter is below its ceiling', () => {
    const atCeilingMinusOne: TopologyDiagnosticUsage = {
      activeForAgent: TOPOLOGY_DIAGNOSTIC_QUOTAS.activeRunsPerAgent - 1,
      activeForSite: TOPOLOGY_DIAGNOSTIC_QUOTAS.activeRunsPerSite - 1,
      activeForOrg: TOPOLOGY_DIAGNOSTIC_QUOTAS.activeRunsPerOrg - 1,
      startsForUser: TOPOLOGY_DIAGNOSTIC_QUOTAS.startsPerUserPerMinute - 1,
      startsForSite: TOPOLOGY_DIAGNOSTIC_QUOTAS.startsPerSitePerMinute - 1,
      startsForOrg: TOPOLOGY_DIAGNOSTIC_QUOTAS.startsPerOrgPerMinute - 1,
    };
    expect(exceededTopologyDiagnosticQuota(atCeilingMinusOne)).toBeNull();
  });

  it.each([
    ['activeForAgent', TOPOLOGY_DIAGNOSTIC_QUOTAS.activeRunsPerAgent, 'agent_concurrency', 120],
    ['activeForSite', TOPOLOGY_DIAGNOSTIC_QUOTAS.activeRunsPerSite, 'site_concurrency', 120],
    ['activeForOrg', TOPOLOGY_DIAGNOSTIC_QUOTAS.activeRunsPerOrg, 'organization_concurrency', 120],
    ['startsForUser', TOPOLOGY_DIAGNOSTIC_QUOTAS.startsPerUserPerMinute, 'user_start_rate', 60],
    ['startsForSite', TOPOLOGY_DIAGNOSTIC_QUOTAS.startsPerSitePerMinute, 'site_start_rate', 60],
    ['startsForOrg', TOPOLOGY_DIAGNOSTIC_QUOTAS.startsPerOrgPerMinute, 'organization_start_rate', 60],
  ] as const)('refuses once %s reaches its ceiling', (field, ceiling, reason, retryAfterSeconds) => {
    expect(exceededTopologyDiagnosticQuota({ ...idle, [field]: ceiling })).toEqual({
      reason,
      retryAfterSeconds,
    });
  });

  it('reports the narrowest exhausted budget first', () => {
    const everything: TopologyDiagnosticUsage = {
      activeForAgent: TOPOLOGY_DIAGNOSTIC_QUOTAS.activeRunsPerAgent,
      activeForSite: TOPOLOGY_DIAGNOSTIC_QUOTAS.activeRunsPerSite,
      activeForOrg: TOPOLOGY_DIAGNOSTIC_QUOTAS.activeRunsPerOrg,
      startsForUser: TOPOLOGY_DIAGNOSTIC_QUOTAS.startsPerUserPerMinute,
      startsForSite: TOPOLOGY_DIAGNOSTIC_QUOTAS.startsPerSitePerMinute,
      startsForOrg: TOPOLOGY_DIAGNOSTIC_QUOTAS.startsPerOrgPerMinute,
    };
    expect(exceededTopologyDiagnosticQuota(everything)?.reason).toBe('agent_concurrency');
  });
});

describe('topology diagnostic idempotency body hash', () => {
  it('is stable across key order and undefined optional fields', () => {
    const a = topologyDiagnosticBodyHash({ ...request, family: 'ipv4' });
    const b = topologyDiagnosticBodyHash({
      family: 'ipv4',
      graphRevision: request.graphRevision,
      subject: { id: request.subject.id, kind: 'node' },
      recipeVersion: 1,
      recipeId: 'gateway_basic',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when any meaningful field changes', () => {
    const base = topologyDiagnosticBodyHash(request);
    expect(topologyDiagnosticBodyHash({ ...request, graphRevision: '8' })).not.toBe(base);
    expect(topologyDiagnosticBodyHash({ ...request, family: 'ipv6' })).not.toBe(base);
    expect(
      topologyDiagnosticBodyHash({
        ...request,
        subject: { kind: 'node', id: '00000000-0000-4000-8000-000000000002' },
      }),
    ).not.toBe(base);
    expect(
      topologyDiagnosticBodyHash({
        ...request,
        originDeviceId: '00000000-0000-4000-8000-000000000003',
      }),
    ).not.toBe(base);
  });
});
