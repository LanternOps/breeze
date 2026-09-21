import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Table-keyed stub for the loader's plain `db.select().from(t)…` chains. Rows
 * are registered per Drizzle table object; anything unregistered reads empty.
 */
const dbRows = vi.hoisted(() => new Map<unknown, unknown[]>());
vi.mock('../../db', () => {
  const chain = () => {
    let table: unknown;
    const self: Record<string, unknown> = {
      from(t: unknown) { table = t; return self; },
      where() { return self; },
      orderBy() { return self; },
      limit() { return self; },
      then(onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) {
        return Promise.resolve(dbRows.get(table) ?? []).then(onFulfilled, onRejected);
      },
    };
    return self;
  };
  return { db: { select: chain } };
});
const trust = vi.hoisted(() => ({
  evaluateCapability: vi.fn(async () => ({
    allow: false,
    code: 'TRUST_PROBATION',
    capability: 'device_execute',
    reason: 'probation_default_deny',
  })),
}));
vi.mock('../partnerTrust', () => ({
  evaluateCapability: trust.evaluateCapability,
  partnerIdForDevice: async () => 'partner-1',
  partnerIdForOrg: async () => 'partner-1',
  isLifecycleCommand: () => false,
  unresolvedPartnerDecision: async () => ({
    allow: false,
    code: 'TRUST_RESTRICTED',
    capability: 'device_execute',
    reason: 'partner_unresolved',
  }),
}));
vi.mock('../../config/partnerTrustMode', () => ({ partnerTrustMode: () => 'enforce' }));
vi.mock('./access', () => ({
  requireTopologySiteAccess: async (
    _auth: unknown,
    _permissions: unknown,
    siteId: string,
  ) => ({ scope: { orgId: ids.org, siteId } }),
}));
vi.mock('./siteConfiguration', () => ({
  loadTopologyConfiguration: async () => ({
    settingsRevision: SETTINGS_REVISION,
    binding: { orgId: ids.org },
    layers: {},
    resolved: { settings: { outboundEnabled: true } },
    templateRevisions: {},
  }),
}));

import {
  collectorEligibilityReasons,
  expectedCollectorConfigurationRevision,
  selectTopologyOrigins,
  topologyDiagnosticRepository,
  TOPOLOGY_COLLECTOR_PAGE_LIMIT,
} from './originEligibility';
import {
  devices as devicesTable,
  topologyCollectionSources,
  topologyNodeBindings,
  topologyNodes,
  topologySiteState,
} from '../../db/schema';
import { topologyConfigurationRevision } from './collectionAuthority';
import type {
  DiagnosticCandidate,
  DiagnosticPlanningRepository,
} from './diagnosticTypes';
import {
  topologyCollectorsResponseSchema,
  type CreateTopologyDiagnosticRequest,
} from '@breeze/shared';

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

  it('caps the page at the promised ceiling, eligible origins first', async () => {
    const total = 150;
    const eligibleAt = new Set([0, 149]);
    const origins = await selectTopologyOrigins(
      {} as never,
      request,
      repository(
        Array.from({ length: total }, (_, index) =>
          candidate({ eligible: eligibleAt.has(index), rank: index }, {
            deviceId: `20000000-0000-4000-8000-4000${index
              .toString()
              .padStart(8, '0')}`,
          }),
        ),
      ),
    );
    expect(origins).toHaveLength(TOPOLOGY_COLLECTOR_PAGE_LIMIT);
    // Both eligible collectors survive the cut even though one of them sorted
    // last, and the schema the route advertises accepts the page.
    expect(origins.filter((origin) => origin.eligible)).toHaveLength(2);
    expect(origins.slice(0, 2).every((origin) => origin.eligible)).toBe(true);
    expect(() =>
      topologyCollectorsResponseSchema.parse({ items: origins, nextCursor: null }),
    ).not.toThrow();
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

describe('collector trust evaluation', () => {
  const COLLECTORS = 5;
  const deviceId = (n: number) =>
    `20000000-0000-4000-8000-1000000000${n.toString().padStart(2, '0')}`;

  function routesSection() {
    return {
      kind: 'routes',
      contextKey: 'default',
      contentDigest: 'a'.repeat(64),
      outcome: 'complete',
      rowCount: 0,
      rows: [],
    };
  }

  beforeEach(() => {
    trust.evaluateCapability.mockClear();
    dbRows.clear();
    dbRows.set(topologySiteState, [{ graphRevision: 5n }]);
    dbRows.set(topologyNodes, [{ id: ids.node }]);
    dbRows.set(
      devicesTable,
      Array.from({ length: COLLECTORS }, (_, index) => ({
        id: deviceId(index),
        agentId: `agent-${index}`,
        status: 'online',
        lastSeenAt: new Date(),
        agentTokenHash: TOKEN_HASH,
        agentTokenSuspendedAt: null,
        isEphemeral: false,
      })),
    );
    dbRows.set(
      topologyNodeBindings,
      Array.from({ length: COLLECTORS }, (_, index) => ({
        id: `20000000-0000-4000-8000-2000000000${index.toString().padStart(2, '0')}`,
        nodeId: ids.node,
        deviceId: deviceId(index),
      })),
    );
    dbRows.set(
      topologyCollectionSources,
      Array.from({ length: COLLECTORS }, (_, index) => ({
        id: `20000000-0000-4000-8000-3000000000${index.toString().padStart(2, '0')}`,
        producerId: deviceId(index),
        protocol: 'routes',
        contextKey: 'default',
        addressFamily: 'ipv4',
        producerEpoch: 'epoch-1',
        materializedSequence: '1',
        revokedAt: null,
        freshUntil: new Date(Date.now() + 60_000),
        currentBaseline: {},
        publishedBaseline: { section: routesSection() },
        baseSnapshotId: null,
      })),
    );
  });

  const ctx = {
    auth: { user: { id: '20000000-0000-4000-8000-00000000000a' } },
    permissions: permissions([]),
    scope: { orgId: ids.org, siteId: ids.site },
  } as never;

  it('evaluates partner trust once for a whole site, not once per collector', async () => {
    const snapshot = await topologyDiagnosticRepository.load(ctx, request);
    expect(snapshot.candidates).toHaveLength(COLLECTORS);
    // Every candidate belongs to the same org and therefore the same partner:
    // one verdict, applied to all of them, and at most one denial audit row.
    expect(trust.evaluateCapability).toHaveBeenCalledTimes(1);
    expect(
      snapshot.candidates.every((candidate) =>
        candidate.eligibility.reasons.includes('trust_denied'),
      ),
    ).toBe(true);
  });
});
