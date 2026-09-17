import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../db', () => ({ db: {} }));
import {
  topologyDiagnosticPlanSchema,
  type CreateTopologyDiagnosticRequest,
  type TopologyTargetDefinition,
} from '@breeze/shared';
import {
  compileTopologyDiagnosticPlan,
  topologyDiagnosticPlanDigest,
} from './diagnosticPlanner';
import type {
  DiagnosticCandidate,
  DiagnosticPlanningSnapshot,
  DiagnosticTarget,
} from './diagnosticTypes';

const ids = {
  org: '30000000-0000-4000-8000-000000000001',
  site: '30000000-0000-4000-8000-000000000002',
  node: '30000000-0000-4000-8000-000000000003',
  device: '30000000-0000-4000-8000-000000000004',
  otherDevice: '30000000-0000-4000-8000-000000000005',
  binding: '30000000-0000-4000-8000-000000000006',
  source: '30000000-0000-4000-8000-000000000007',
  evidence: '30000000-0000-4000-8000-000000000008',
  interfaceA: '30000000-0000-4000-8000-000000000009',
  interfaceB: '30000000-0000-4000-8000-00000000000a',
  targetHttps: '30000000-0000-4000-8000-00000000000b',
  targetHttpsB: '30000000-0000-4000-8000-00000000000c',
  targetDns: '30000000-0000-4000-8000-00000000000d',
  targetTcp: '30000000-0000-4000-8000-00000000000e',
  resolverEvidence: '30000000-0000-4000-8000-00000000000f',
};
const NOW = new Date('2026-09-15T12:00:00Z');
/** Deterministic identity so a plan digest is reproducible across runs. */
function sequentialIds() {
  let n = 0;
  return () =>
    `40000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;
}

function resolver(
  overrides: Partial<DiagnosticCandidate['resolvers'][number]> = {},
): DiagnosticCandidate['resolvers'][number] {
  return {
    rowKey: 'resolver-1',
    address: '192.0.2.53',
    zone: null,
    interfaceKey: 'if-1',
    isLocalStub: false,
    port: 53,
    transport: 'udp_tcp',
    domains: [{ name: '.', routeOnly: false }],
    mechanism: 'resolv_conf',
    ...overrides,
  };
}

function candidate(
  overrides: Partial<DiagnosticCandidate> = {},
): DiagnosticCandidate {
  const resolvers = overrides.resolvers ?? [resolver()];
  return {
    routes: [],
    gatewayEvidence: [
      {
        address: '192.0.2.1',
        zone: null,
        interfaceId: ids.interfaceA,
        evidenceId: ids.evidence,
      },
    ],
    capabilities: new Set([
      'network_diagnostic',
      'route_lookup',
      'scoped_dns',
    ]),
    ...overrides,
    resolvers,
    resolverEvidence:
      overrides.resolverEvidence ??
      Object.fromEntries(
        resolvers.map((row) => [row.rowKey, ids.resolverEvidence]),
      ),
    eligibility: {
      origin: {
        deviceId: ids.device,
        agentId: 'agent-1',
        nodeId: ids.node,
        bindingId: ids.binding,
        siteId: ids.site,
        contextKey: 'default',
        interfaceId: ids.interfaceA,
        interfaceEpoch: '1',
        interfaceKey: 'if-1',
        sourceId: ids.source,
        producerEpoch: 'epoch-1',
        sequence: '1',
      },
      eligible: true,
      reasons: [],
      families: ['ipv4'],
      rank: 0,
      ...overrides.eligibility,
    },
  };
}

const httpsTarget: TopologyTargetDefinition = {
  kind: 'https',
  label: 'primary',
  enabled: true,
  families: ['ipv4'],
  provider: null,
  independenceLabel: null,
  hostname: 'probe.example.test',
  port: 443,
  path: '/healthz',
  method: 'GET',
  expectedStatus: 200,
  maxRedirects: 0,
  proxyMode: 'direct',
};
function target(
  id: string,
  definition: TopologyTargetDefinition,
): DiagnosticTarget {
  return { id, revision: '1', definition };
}

function snapshot(
  overrides: Partial<DiagnosticPlanningSnapshot> = {},
): DiagnosticPlanningSnapshot {
  return {
    graphRevision: '9',
    settings: {
      binding: { orgId: ids.org } as never,
      layers: {
        partner: null,
        organization: null,
        defaultsVersion: 1,
        resolverVersion: 1,
      } as never,
      resolved: { settings: { outboundEnabled: true } } as never,
      settingsRevision: '4',
      templateRevisions: {},
    },
    targets: [target(ids.targetHttps, httpsTarget)],
    candidates: [candidate()],
    ...overrides,
  };
}

function request(
  overrides: Partial<CreateTopologyDiagnosticRequest> = {},
): CreateTopologyDiagnosticRequest {
  return {
    recipeId: 'gateway_basic',
    recipeVersion: 1,
    subject: { kind: 'node', id: ids.node },
    graphRevision: '9',
    ...overrides,
  };
}

function compile(
  req: CreateTopologyDiagnosticRequest,
  snap: DiagnosticPlanningSnapshot = snapshot(),
) {
  return compileTopologyDiagnosticPlan({
    request: req,
    snapshot: snap,
    now: NOW,
    newId: sequentialIds(),
  });
}
const NETWORK_SIDE_EFFECT = new Set(['icmp', 'dns', 'tcp', 'tls', 'http']);
const sideEffects = (plan: { steps: Array<{ method: string }> }) =>
  plan.steps.filter((step) => NETWORK_SIDE_EFFECT.has(step.method));

describe('diagnostic plan admission', () => {
  it('does not manufacture external checks for an unconfigured site', () => {
    const plan = compile(
      request({ recipeId: 'internet_basic' }),
      snapshot({ targets: [] }),
    );
    expect(plan.reasons).toEqual(['target_not_configured']);
    expect(sideEffects(plan)).toHaveLength(0);
    expect(plan.destinations).toHaveLength(0);
  });

  it('refuses to plan when no origin is eligible', () => {
    expect(() =>
      compile(
        request(),
        snapshot({
          candidates: [
            candidate({
              eligibility: {
                eligible: false,
                reasons: ['trust_denied'],
              } as never,
            }),
          ],
        }),
      ),
    ).toThrow(/no_eligible_collector/);
  });

  it('never falls back to an origin the requester did not choose', () => {
    expect(() =>
      compile(
        request({ originDeviceId: ids.otherDevice }),
        snapshot({ candidates: [candidate()] }),
      ),
    ).toThrow(/no_eligible_collector/);
  });

  it('refuses an origin whose collected context key does not match the request', () => {
    expect(() =>
      compile(request({ contextKey: 'vpn' }), snapshot()),
    ).toThrow(/no_eligible_collector/);
  });

  it('blocks every outbound recipe while outbound is disabled', () => {
    const snap = snapshot();
    snap.settings.resolved = { settings: { outboundEnabled: false } } as never;
    expect(compile(request({ recipeId: 'internet_basic' }), snap).reasons).toEqual([
      'outbound_disabled',
    ]);
    expect(sideEffects(compile(request({ recipeId: 'dns_basic' }), snap))).toHaveLength(0);
  });

  it('blocks a revoked template revision before compiling any step', () => {
    const snap = snapshot();
    snap.settings.templateRevisions = { partner: '3:revoked' };
    const plan = compile(request(), snap);
    expect(plan.reasons).toEqual(['template_revoked']);
    expect(plan.steps).toHaveLength(0);
  });
});

describe('gateway recipe', () => {
  it('sends exactly three one-second ICMP packets to one observed next hop', () => {
    const plan = compile(request());
    expect(plan.steps.map((step) => step.method)).toEqual([
      'route_lookup',
      'neighbor_lookup',
      'icmp',
    ]);
    const icmp = plan.steps.find((step) => step.method === 'icmp')!;
    expect(icmp).toMatchObject({
      packetCount: 3,
      timeoutMs: 1000,
      required: true,
    });
    expect(plan.destinations).toMatchObject([
      { target: { kind: 'observed_gateway', address: '192.0.2.1' } },
    ]);
  });

  it('refuses a schematic gateway with no observed next-hop evidence', () => {
    const plan = compile(
      request(),
      snapshot({ candidates: [candidate({ gatewayEvidence: [] })] }),
    );
    expect(plan.reasons).toEqual(['gateway_not_observed']);
    expect(sideEffects(plan)).toHaveLength(0);
  });

  it('refuses equal-cost next hops instead of guessing one', () => {
    const plan = compile(
      request(),
      snapshot({
        candidates: [
          candidate({
            gatewayEvidence: [
              {
                address: '192.0.2.1',
                zone: null,
                interfaceId: ids.interfaceA,
                evidenceId: ids.evidence,
              },
              {
                address: '192.0.2.2',
                zone: null,
                interfaceId: ids.interfaceA,
                evidenceId: ids.evidence,
              },
            ],
          }),
        ],
      }),
    );
    expect(plan.reasons).toEqual(['ambiguous_route']);
  });

  it('ignores a next hop learned on another interface', () => {
    const plan = compile(
      request(),
      snapshot({
        candidates: [
          candidate({
            gatewayEvidence: [
              {
                address: '192.0.2.1',
                zone: null,
                interfaceId: ids.interfaceB,
                evidenceId: ids.evidence,
              },
            ],
          }),
        ],
      }),
    );
    expect(plan.reasons).toEqual(['gateway_not_observed']);
  });

  it('plans IPv4 and IPv6 independently and keeps the link-local zone', () => {
    const dual = candidate({
      eligibility: { families: ['ipv4', 'ipv6'] } as never,
      gatewayEvidence: [
        {
          address: '192.0.2.1',
          zone: null,
          interfaceId: ids.interfaceA,
          evidenceId: ids.evidence,
        },
        {
          address: 'fe80::1',
          zone: 'if-1',
          interfaceId: ids.interfaceA,
          evidenceId: ids.evidence,
        },
      ],
    });
    const v6 = compile(
      request({ family: 'ipv6' }),
      snapshot({ candidates: [dual] }),
    );
    expect(v6.family).toBe('ipv6');
    expect(v6.destinations[0]!.target).toMatchObject({
      address: 'fe80::1',
      zone: 'if-1',
    });
    const v4 = compile(
      request({ family: 'ipv4' }),
      snapshot({ candidates: [dual] }),
    );
    expect(v4.destinations[0]!.target).toMatchObject({ address: '192.0.2.1' });
  });
});

describe('outbound recipes', () => {
  it('keeps internet_basic inside two endpoints and nine steps', () => {
    const plan = compile(
      request({ recipeId: 'internet_basic' }),
      snapshot({
        targets: [
          target(ids.targetHttps, httpsTarget),
          target(ids.targetHttpsB, {
            ...httpsTarget,
            label: 'secondary',
            hostname: 'probe2.example.test',
          }),
          target(ids.targetTcp, {
            kind: 'tcp',
            label: 'third',
            enabled: true,
            families: ['ipv4'],
            provider: null,
            independenceLabel: null,
            host: '198.51.100.7',
            port: 443,
          }),
        ],
      }),
    );
    expect(plan.reasons).toEqual([]);
    expect(plan.steps).toHaveLength(9);
    expect(
      plan.steps.filter((step) => step.method === 'route_lookup'),
    ).toHaveLength(1);
    expect(plan.steps.filter((step) => step.method === 'dns')).toHaveLength(2);
    expect(
      plan.destinations.filter(
        (destination) => destination.target.kind === 'configured_target',
      ),
    ).toHaveLength(2);
  });

  it('asks exactly one known-answer name through at most two resolvers with one retry', () => {
    const plan = compile(
      request({ recipeId: 'dns_basic' }),
      snapshot({
        targets: [
          target(ids.targetDns, {
            kind: 'dns_name',
            label: 'known',
            enabled: true,
            families: ['ipv4'],
            provider: null,
            independenceLabel: null,
            hostname: 'known.example.test',
            expectedAddresses: ['198.51.100.10'],
            resolver: 'configured_dns',
          }),
        ],
        candidates: [
          candidate({
            resolvers: [
              resolver(),
              resolver({ rowKey: 'resolver-2', address: '192.0.2.54' }),
            ],
          }),
        ],
      }),
    );
    const dns = plan.steps.find((step) => step.method === 'dns')!;
    expect(dns).toMatchObject({ retries: 1, timeoutMs: 2000, queryType: 'A' });
    expect(
      'resolverDestinationIds' in dns ? dns.resolverDestinationIds : [],
    ).toHaveLength(2);
    expect(sideEffects(plan).map((step) => step.method)).toEqual(['dns']);
  });

  it('blocks ambiguous split DNS rather than picking a resolver', () => {
    const plan = compile(
      request({ recipeId: 'internet_basic' }),
      snapshot({
        candidates: [
          candidate({
            resolvers: [
              resolver(),
              resolver({ rowKey: 'resolver-2', address: '192.0.2.54' }),
              resolver({ rowKey: 'resolver-3', address: '192.0.2.55' }),
            ],
          }),
        ],
      }),
    );
    expect(plan.reasons).toEqual(['ambiguous_dns_context']);
    expect(sideEffects(plan)).toHaveLength(0);
  });

  it('requires scoped DNS capability before honouring a route-only domain', () => {
    const plan = compile(
      request({ recipeId: 'internet_basic' }),
      snapshot({
        candidates: [
          candidate({
            capabilities: new Set(['network_diagnostic', 'route_lookup']),
            resolvers: [
              resolver({
                domains: [{ name: 'example.test', routeOnly: true }],
              }),
            ],
          }),
        ],
      }),
    );
    expect(plan.reasons).toEqual(['unsupported_context']);
  });

  it('refuses a proxied HTTPS target instead of probing direct', () => {
    const plan = compile(
      request({ recipeId: 'internet_basic' }),
      snapshot({
        targets: [
          target(ids.targetHttps, {
            ...httpsTarget,
            proxyMode: 'configured',
          }),
        ],
      }),
    );
    expect(plan.reasons).toEqual(['unsupported_proxy']);
  });

  it('refuses a literal target from the other address family', () => {
    const plan = compile(
      request({ recipeId: 'target_connectivity' }),
      snapshot({
        targets: [
          target(ids.targetTcp, {
            kind: 'tcp',
            label: 'literal',
            enabled: true,
            families: ['ipv4'],
            provider: null,
            independenceLabel: null,
            host: '2001:db8::1',
            port: 443,
          }),
        ],
      }),
    );
    expect(plan.reasons).toEqual(['target_family_unavailable']);
    expect(sideEffects(plan)).toHaveLength(0);
  });

  it('skips DNS for a literal address target', () => {
    const plan = compile(
      request({ recipeId: 'target_connectivity' }),
      snapshot({
        targets: [
          target(ids.targetTcp, {
            kind: 'tcp',
            label: 'literal',
            enabled: true,
            families: ['ipv4'],
            provider: null,
            independenceLabel: null,
            host: '198.51.100.7',
            port: 443,
          }),
        ],
      }),
    );
    expect(plan.steps.map((step) => step.method)).toEqual([
      'route_lookup',
      'tcp',
    ]);
  });
});

describe('plan identity and budgets', () => {
  it('stamps the current revisions, not the caller-supplied graph revision', () => {
    const plan = compile(request({ graphRevision: '1' }));
    expect(plan.graphRevision).toBe('9');
    expect(plan.settingsRevision).toBe('4');
    expect(plan.contextRevision).toBe('1');
    expect(plan.scope).toEqual({ orgId: ids.org, siteId: ids.site });
  });

  it('bounds the accepted plan lifetime to its stated limits', () => {
    const plan = compile(request());
    expect(plan.limits).toMatchObject({
      maxConcurrentSteps: 2,
      maxTargetAddresses: 4,
      maxResolvers: 2,
    });
    expect(Date.parse(plan.queueDeadline) - Date.parse(plan.acceptedAt)).toBe(
      plan.limits.queueTimeoutSeconds * 1000,
    );
    expect(Date.parse(plan.deadline) - Date.parse(plan.acceptedAt)).toBe(
      plan.limits.lifetimeSeconds * 1000,
    );
    expect(() => topologyDiagnosticPlanSchema.parse(plan)).not.toThrow();
  });

  it('binds every normalized plan field except the digest itself', () => {
    const plan = compile(request());
    expect(plan.digest).toBe(topologyDiagnosticPlanDigest(plan));
    expect(topologyDiagnosticPlanDigest({ ...plan, digest: '0'.repeat(64) })).toBe(
      plan.digest,
    );
    expect(
      topologyDiagnosticPlanDigest({ ...plan, family: 'ipv6' }),
    ).not.toBe(plan.digest);
  });

  it('agrees with the frozen cross-language digest vectors', () => {
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../packages/shared/src/testing/topology-diagnostic-vectors.json',
    );
    const vectors = JSON.parse(readFileSync(file, 'utf8')) as {
      vectors: Array<{ plan: unknown; sha256: string }>;
    };
    expect(vectors.vectors.length).toBeGreaterThan(0);
    for (const vector of vectors.vectors) {
      const plan = topologyDiagnosticPlanSchema.parse(vector.plan);
      expect(topologyDiagnosticPlanDigest(plan)).toBe(vector.sha256);
      expect(plan.digest).toBe(vector.sha256);
    }
  });
});
