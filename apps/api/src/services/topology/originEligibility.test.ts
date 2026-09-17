import { describe, expect, it, vi } from 'vitest';
vi.mock('../../db', () => ({ db: {} }));
import {
  collectorEligibilityReasons,
  expectedCollectorConfigurationRevision,
  selectTopologyOrigins,
} from './originEligibility';
import { topologyConfigurationRevision } from './collectionAuthority';
import type {
  DiagnosticCandidate,
  DiagnosticPlanningRepository,
} from './diagnosticTypes';
import type { CreateTopologyDiagnosticRequest } from '@breeze/shared';

const ids = {
  org: '20000000-0000-4000-8000-000000000001',
  site: '20000000-0000-4000-8000-000000000002',
  node: '20000000-0000-4000-8000-000000000003',
  device: '20000000-0000-4000-8000-000000000004',
  other: '20000000-0000-4000-8000-000000000005',
  binding: '20000000-0000-4000-8000-000000000006',
  source: '20000000-0000-4000-8000-000000000007',
};
const NOW = Date.parse('2026-09-15T12:00:00Z');
const SETTINGS_REVISION = '7';
const TOKEN_HASH = 'token-hash';

function permissions(grants: Array<{ resource: string; action: string }>) {
  return {
    permissions: grants,
    partnerId: null,
    orgId: ids.org,
    roleId: 'role',
    scope: 'organization' as const,
  };
}

function eligibleInput() {
  return {
    now: NOW,
    settingsRevision: SETTINGS_REVISION,
    capabilities: new Set(['network_diagnostic', 'route_lookup']),
    permissions: permissions([
      { resource: 'topology', action: 'execute' },
      { resource: 'devices', action: 'execute' },
    ]),
    device: {
      status: 'online',
      lastSeenAt: new Date(NOW - 1000),
      agentTokenHash: TOKEN_HASH,
      agentTokenSuspendedAt: null,
    },
    source: {
      revokedAt: null,
      freshUntil: new Date(NOW + 60_000),
      producerEpoch: 'epoch-1',
    },
    root: {
      revokedAt: null,
      lastReceivedAt: new Date(NOW - 1000),
      producerEpoch: 'epoch-1',
      configurationRevision: expectedCollectorConfigurationRevision(
        TOKEN_HASH,
        SETTINGS_REVISION,
      ),
    },
  };
}

function candidate(
  overrides: Partial<DiagnosticCandidate['eligibility']> = {},
  originOverrides: Partial<DiagnosticCandidate['eligibility']['origin']> = {},
): DiagnosticCandidate {
  return {
    eligibility: {
      origin: {
        deviceId: ids.device,
        agentId: 'agent-1',
        nodeId: ids.node,
        bindingId: ids.binding,
        siteId: ids.site,
        contextKey: 'default',
        interfaceId: null,
        interfaceEpoch: null,
        interfaceKey: null,
        sourceId: ids.source,
        producerEpoch: 'epoch-1',
        sequence: '1',
        ...originOverrides,
      },
      eligible: true,
      reasons: [],
      families: ['ipv4'],
      rank: 0,
      ...overrides,
    },
    routes: [],
    resolvers: [],
    gatewayEvidence: [],
    resolverEvidence: {},
    capabilities: new Set(),
  };
}

function repository(
  candidates: DiagnosticCandidate[],
): DiagnosticPlanningRepository & { calls: number } {
  const stub = {
    calls: 0,
    async load() {
      stub.calls += 1;
      return {
        graphRevision: '1',
        settings: {} as never,
        targets: [],
        candidates,
      };
    },
  };
  return stub;
}

const request: CreateTopologyDiagnosticRequest = {
  recipeId: 'gateway_basic',
  recipeVersion: 1,
  subject: { kind: 'node', id: ids.node },
  graphRevision: '1',
};

describe('collector eligibility reasons', () => {
  it('accepts a current, trusted, diagnostics-capable origin', () => {
    expect(collectorEligibilityReasons(eligibleInput())).toEqual([]);
  });

  it('reports a forbidden but otherwise online origin instead of hiding it', () => {
    const input = eligibleInput();
    input.permissions = permissions([
      { resource: 'topology', action: 'read' },
      { resource: 'devices', action: 'execute' },
    ]);
    expect(collectorEligibilityReasons(input)).toEqual([
      'origin_permission_denied',
    ]);
  });

  it('rejects a roaming agent whose collected context no longer matches', () => {
    const input = eligibleInput();
    input.source.producerEpoch = 'epoch-2';
    expect(collectorEligibilityReasons(input)).toContain('context_changed');
  });

  it('rejects an origin whose configuration revision drifted from the site', () => {
    const input = eligibleInput();
    input.root.configurationRevision =
      expectedCollectorConfigurationRevision(TOKEN_HASH, '8');
    expect(collectorEligibilityReasons(input)).toEqual(['context_changed']);
  });

  it('separates stale evidence from an offline or unenrolled agent', () => {
    const stale = eligibleInput();
    stale.source.freshUntil = new Date(NOW - 1);
    expect(collectorEligibilityReasons(stale)).toEqual(['context_stale']);
    const offline = eligibleInput();
    offline.device.status = 'offline';
    offline.device.agentTokenHash = '';
    expect(collectorEligibilityReasons(offline)).toEqual([
      'origin_offline',
      'origin_not_enrolled',
      'context_changed',
    ]);
  });

  it('separates a missing diagnostic capability from an unsupported context', () => {
    const input = eligibleInput();
    input.capabilities = new Set(['route_lookup']);
    expect(collectorEligibilityReasons(input)).toEqual([
      'diagnostics_unavailable',
    ]);
    const unsupported = eligibleInput();
    unsupported.capabilities = new Set(['network_diagnostic']);
    expect(collectorEligibilityReasons(unsupported)).toEqual([
      'unsupported_context',
    ]);
  });

  it('reuses the negotiation writer definition of configuration authority', () => {
    expect(expectedCollectorConfigurationRevision(TOKEN_HASH, '1')).toBe(
      topologyConfigurationRevision(TOKEN_HASH, 1n),
    );
    expect(expectedCollectorConfigurationRevision(TOKEN_HASH, '1')).not.toBe(
      expectedCollectorConfigurationRevision(TOKEN_HASH, '2'),
    );
    expect(expectedCollectorConfigurationRevision(null, '1')).not.toBe(
      expectedCollectorConfigurationRevision(TOKEN_HASH, '1'),
    );
  });
});

describe('origin selection', () => {
  it('surfaces ineligible origins with their reasons rather than dropping them', async () => {
    const repo = repository([
      candidate({ eligible: false, reasons: ['trust_denied'], rank: 1 }),
    ]);
    const origins = await selectTopologyOrigins(
      {} as never,
      request,
      repo,
    );
    expect(origins).toMatchObject([
      { eligible: false, reasons: ['trust_denied'] },
    ]);
    expect(repo.calls).toBe(1);
  });

  it('never exposes anything beyond the typed eligibility projection', async () => {
    const origins = await selectTopologyOrigins(
      {} as never,
      request,
      repository([candidate()]),
    );
    expect(Object.keys(origins[0]!).sort()).toEqual([
      'eligible',
      'families',
      'origin',
      'reasons',
      'rank',
    ].sort());
  });

  it('validates the request before reaching the repository', async () => {
    const repo = repository([candidate()]);
    await expect(
      selectTopologyOrigins(
        {} as never,
        { ...request, subject: { kind: 'node', id: 'not-a-uuid' } } as never,
        repo,
      ),
    ).rejects.toThrow();
    expect(repo.calls).toBe(0);
  });
});
