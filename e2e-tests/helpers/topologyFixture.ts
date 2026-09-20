import type { Page, Request, Route } from '@playwright/test';

/**
 * Deterministic `baseline-no-management` fixture for the production-browser
 * acceptance gate.
 *
 * One enrolled agent (one interface, one prefix, one default route, reported
 * resolvers) and two inventory peers. Zero LLDP/SNMP/FDB/controller reports, so
 * the site has no physical evidence at all: every relationship it publishes is
 * logical, and the segment beyond the reported gateway is a presentation-only
 * schematic connector.
 *
 * This helper is the CONTROLLED SERVER for the browser gate — it serves the same
 * dataset the API integration test (`topologyBaselineAcceptance.integration.test.ts`)
 * materializes through the normalized collection seam against real Postgres.
 * Server-side invariants (origin attribution, cascade, RLS, zero external calls)
 * are proven there; this file proves the production bundle renders them
 * faithfully and stays passive. It never contacts a real destination, resolver or
 * production host: every diagnostic response below is a canned, controlled reply.
 */

const uuid = (seed: string) => {
  // Deterministic, well-formed v4-shaped identifiers so hash navigation and the
  // shared zod schemas accept them without a random seed per run.
  let hash = 0x811c9dc5;
  const hex: string[] = [];
  for (let index = 0; index < 32; index += 1) {
    hash ^= seed.charCodeAt(index % seed.length) + index * 131;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hex.push(((hash >>> (index % 8) * 4) & 0xf).toString(16));
  }
  const raw = hex.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
};

const digest = (seed: string) => {
  let value = 0x811c9dc5;
  let out = '';
  while (out.length < 64) {
    value ^= seed.charCodeAt(out.length % seed.length) + out.length;
    value = Math.imul(value, 0x01000193) >>> 0;
    out += value.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
};

export const BASELINE = {
  orgId: uuid('baseline-org'),
  siteId: uuid('baseline-site'),
  deviceId: uuid('baseline-device'),
  networkDeviceId: uuid('baseline-asset'),
  otherSiteId: uuid('baseline-site-b'),
  interfaceId: uuid('baseline-interface'),
  sourceId: uuid('baseline-source'),
  bindingId: uuid('baseline-binding'),
  endpointNodeId: uuid('baseline-node-endpoint'),
  gatewayNodeId: uuid('baseline-node-gateway'),
  networkNodeId: uuid('baseline-node-network'),
  internetNodeId: uuid('baseline-node-internet'),
  peerANodeId: uuid('baseline-node-peer-a'),
  peerBNodeId: uuid('baseline-node-peer-b'),
  peerAAssetId: uuid('baseline-asset-peer-a'),
  peerBAssetId: uuid('baseline-asset-peer-b'),
  defaultRouteEdgeId: uuid('baseline-edge-default-route'),
  egressEdgeId: uuid('baseline-edge-egress'),
  memberSelfEdgeId: uuid('baseline-edge-member-self'),
  memberPeerAEdgeId: uuid('baseline-edge-member-peer-a'),
  memberPeerBEdgeId: uuid('baseline-edge-member-peer-b'),
  schematicNodeId: 'presentation:overview:unknown-segment:beyond-gateway',
  schematicEdgeId: 'presentation:overview:unknown-segment:gateway-link',
  agentId: 'baseline-agent-01',
  contextKey: 'default/eth0',
  gatewayAddress: '192.0.2.1',
  resolverAddress: '192.0.2.53',
  prefix: '192.0.2.0/24',
} as const;

const NOW = '2026-09-16T12:00:00Z';

const evidence = (methods: string[], count = '1') => ({
  classes: ['observed'], methods, count, lastObservedAt: NOW,
});

const unknownHealth = (scope: 'node' | 'relationship', message = 'Not measured') => ({
  status: 'unknown', coverage: 'unmonitored', scope, originNodeId: null, resultId: null,
  reasons: [{ code: 'not_measured', message }], freshness: 'unknown',
});

const node = (id: string, kind: string, role: string, label: string, methods: string[], bindings: unknown[] = []) => ({
  id, kind, role, label, bindings, lifecycle: 'active', freshness: 'fresh',
  evidence: evidence(methods), health: unknownHealth('node'), availableActions: ['diagnose'],
});

const relationship = (
  id: string, kind: string, sourceNodeId: string, targetNodeId: string, meaning: string,
  methods: string[], extra: Record<string, unknown> = {},
) => ({
  id, kind, directionality: kind === 'network_member' ? 'undirected' : 'directed',
  sourceNodeId, targetNodeId, sourceInterfaceId: null, targetInterfaceId: null, meaning,
  directness: 'direct', evidence: evidence(methods), confidence: 'high', lifecycle: 'active',
  freshness: 'fresh', health: unknownHealth('relationship'), excluded: false,
  availableActions: ['diagnose'], ...extra,
});

/** The published `baseline-no-management` projection. Zero `physical_link` rows. */
export function baselineGraph() {
  return {
    schemaVersion: 1, siteId: BASELINE.siteId, view: 'overview', asOf: NOW,
    revisions: { graph: '4', health: '1', layout: '2' },
    nodes: [
      node(BASELINE.endpointNodeId, 'endpoint', 'endpoint', 'baseline-agent-01', ['os_interface'],
        [{ id: BASELINE.bindingId, type: 'device', referenceId: BASELINE.deviceId }]),
      node(BASELINE.networkNodeId, 'network', 'network', '192.0.2.0/24', ['os_interface']),
      node(BASELINE.gatewayNodeId, 'gateway', 'gateway', 'Reported gateway 192.0.2.1', ['os_route'],
        [{ id: uuid('binding-gateway'), type: 'discovered_asset', referenceId: BASELINE.networkDeviceId }]),
      node(BASELINE.internetNodeId, 'internet', 'internet', 'Internet', ['os_route']),
      node(BASELINE.peerANodeId, 'endpoint', 'inventory peer', 'inventory-peer-a', ['neighbor_cache'],
        [{ id: uuid('binding-peer-a'), type: 'discovered_asset', referenceId: BASELINE.peerAAssetId }]),
      node(BASELINE.peerBNodeId, 'endpoint', 'inventory peer', 'inventory-peer-b', ['neighbor_cache'],
        [{ id: uuid('binding-peer-b'), type: 'discovered_asset', referenceId: BASELINE.peerBAssetId }]),
    ],
    relationships: [
      // The default route's origin is the REPORTING endpoint and its interface —
      // never the gateway, and never a synthesized physical link.
      relationship(BASELINE.defaultRouteEdgeId, 'default_route', BASELINE.endpointNodeId, BASELINE.gatewayNodeId,
        'default route', ['os_route'], { sourceInterfaceId: BASELINE.interfaceId }),
      relationship(BASELINE.egressEdgeId, 'egress_path', BASELINE.gatewayNodeId, BASELINE.internetNodeId,
        'egress path', ['os_route'], { directness: 'unknown', confidence: 'low' }),
      relationship(BASELINE.memberSelfEdgeId, 'network_member', BASELINE.endpointNodeId, BASELINE.networkNodeId,
        'network member', ['os_interface'], { sourceInterfaceId: BASELINE.interfaceId }),
      // The two inventory peers carry membership ONLY: no default route, no
      // egress path, and nothing physical.
      relationship(BASELINE.memberPeerAEdgeId, 'network_member', BASELINE.peerANodeId, BASELINE.networkNodeId,
        'network member', ['neighbor_cache'], { confidence: 'medium' }),
      relationship(BASELINE.memberPeerBEdgeId, 'network_member', BASELINE.peerBNodeId, BASELINE.networkNodeId,
        'network member', ['neighbor_cache'], { confidence: 'medium' }),
    ],
    presentation: {
      nodes: [{
        id: BASELINE.schematicNodeId, view: 'overview', role: 'unknown segment',
        label: 'Unidentified segment', memberCount: 0, frontierToken: 'baseline-unknown-segment', authority: false,
      }],
      edges: [{
        id: BASELINE.schematicEdgeId, sourceNodeId: BASELINE.gatewayNodeId, targetNodeId: BASELINE.schematicNodeId,
        relationshipKind: null, presentationOnly: true, authority: false,
        meaning: 'schematic', contributingRelationshipIds: [],
      }],
    },
    layout: {
      algorithm: 'none', version: 0,
      positions: [{ nodeId: BASELINE.gatewayNodeId, x: 320, y: 180, pinned: true, source: 'user', rowRevision: '2' }],
    },
    counts: {
      totalNodes: 6, totalRelationships: 5, visibleNodes: 6, visibleRelationships: 5,
      omittedNodes: 0, omittedRelationships: 0,
    },
    coverage: { state: 'limited', reasons: [{ code: 'no_managed_switch', message: 'No managed switch or controller reports' }] },
    frontier: [], permissions: { canEdit: true, canDiagnose: true, canConfigureMonitoring: true },
  };
}

export function baselineSettings(siteId = BASELINE.siteId) {
  const yes = { available: true, reason: null }, no = { available: false, reason: 'capability_unavailable' };
  return {
    siteId, settingsRevision: '3',
    flags: { materialization: true, ui: true, physical: false, interfaceHealth: false, diagnostics: true, ai: false },
    capabilities: {
      materialization: yes, ui: yes, collection: yes, physical: no, interfaceHealth: no,
      diagnostics: yes, ai: no, recurringMonitoring: no,
    },
    permissions: { canEdit: true, canDiagnose: true, canConfigureMonitoring: true },
    resolved: { settings: { targets: {}, policies: {} }, digest: digest('resolved'), provenance: {}, validationEffects: [] },
    binding: {
      partnerVersionId: null, orgVersionId: null, bindingRevision: '1', defaultsVersion: 1,
      schemaVersion: 1, resolverVersion: 1, overrides: { targets: {}, policies: {} },
    },
  };
}

const origin = () => ({
  deviceId: BASELINE.deviceId, agentId: BASELINE.agentId, nodeId: BASELINE.endpointNodeId,
  bindingId: BASELINE.bindingId, siteId: BASELINE.siteId, contextKey: BASELINE.contextKey,
  interfaceId: BASELINE.interfaceId, interfaceEpoch: 'epoch-1', interfaceKey: 'eth0',
  sourceId: BASELINE.sourceId, producerEpoch: 'epoch-1', sequence: '12',
});

const LIMITS = {
  maxConcurrentSteps: 1, maxTargetAddresses: 4, maxResolvers: 2,
  queueTimeoutSeconds: 30, executionTimeoutSeconds: 60, lifetimeSeconds: 90,
};

const attribution = (requestedMethod: string, actualMethod: string | null, over: Record<string, unknown> = {}) => ({
  originDeviceId: BASELINE.deviceId, originAgentId: BASELINE.agentId, requestedMethod, actualMethod,
  destinationId: null, resolvedIp: null, family: 'ipv4', port: null, interfaceId: BASELINE.interfaceId,
  localAddress: '192.0.2.10', contextKey: BASELINE.contextKey, tableKey: 'main', nextHop: BASELINE.gatewayAddress,
  proxyUsed: false, quality: 'observed', routeChanged: false, evidenceRefs: [], ...over,
});

const step = (id: string, state: string, reason: string | null, attr: Record<string, unknown>, details: Record<string, unknown> = {}) => ({
  id, state, reason, attribution: attr,
  startedAt: '2026-09-16T12:00:01Z', finishedAt: '2026-09-16T12:00:03Z', receivedAt: '2026-09-16T12:00:04Z',
  truncated: false, details,
});

type PlanInput = {
  recipeId: string; family: string; subject: { kind: string; id: string };
  destinations: { id: string; target: Record<string, unknown> }[];
  steps: Record<string, unknown>[];
  reasons?: string[];
};

const plan = (input: PlanInput) => ({
  version: 1, recipeId: input.recipeId, recipeVersion: 1,
  scope: { orgId: BASELINE.orgId, siteId: BASELINE.siteId }, subject: input.subject,
  origin: origin(), family: input.family, graphRevision: '4', settingsRevision: '3', contextRevision: '2',
  templateVersions: { partner: null, org: null, defaults: 1, resolver: 1 },
  destinations: input.destinations, steps: input.steps, limits: LIMITS,
  acceptedAt: '2026-09-16T12:00:00Z', queueDeadline: '2026-09-16T12:00:20Z', deadline: '2026-09-16T12:01:10Z',
  digest: digest(`plan-${input.recipeId}-${input.family}`), reasons: input.reasons ?? [],
});

const GATEWAY_DESTINATION = {
  id: uuid('destination-gateway'),
  target: {
    kind: 'observed_gateway', address: BASELINE.gatewayAddress, zone: null,
    interfaceId: BASELINE.interfaceId, evidenceId: uuid('evidence-gateway'),
  },
};
const RESOLVER_DESTINATION = {
  id: uuid('destination-resolver'),
  target: {
    kind: 'observed_resolver', address: BASELINE.resolverAddress, zone: null, port: 53,
    localStub: false, evidenceId: uuid('evidence-resolver'),
  },
};
const dnsTargetDefinition = {
  kind: 'dns_name', label: 'controlled-dns', enabled: true, families: ['ipv4'], provider: null,
  independenceLabel: null, hostname: 'baseline.invalid', expectedAddresses: ['198.51.100.10'], resolver: 'configured_dns',
};
const httpsTargetDefinition = (label: string, hostname: string) => ({
  kind: 'https', label, enabled: true, families: ['ipv4'], provider: null, independenceLabel: null,
  hostname, port: 443, path: '/healthz', method: 'HEAD', expectedStatus: 200, maxRedirects: 0, proxyMode: 'direct',
});
const DNS_TARGET_DESTINATION = {
  id: uuid('destination-dns-target'),
  target: { kind: 'configured_target', targetId: uuid('target-dns'), targetRevision: '1', definition: dnsTargetDefinition },
};
const HTTPS_A_DESTINATION = {
  id: uuid('destination-https-a'),
  target: { kind: 'configured_target', targetId: uuid('target-https-a'), targetRevision: '1', definition: httpsTargetDefinition('controlled-a', 'a.baseline.invalid') },
};
const HTTPS_B_DESTINATION = {
  id: uuid('destination-https-b'),
  target: { kind: 'configured_target', targetId: uuid('target-https-b'), targetRevision: '1', definition: httpsTargetDefinition('controlled-b', 'b.baseline.invalid') },
};

export type BaselineEffects = {
  /** Diagnostic runs for which the server actually registered an agent command. */
  commands: number;
  /** Recurring-monitoring / policy activations. M1 must never arm one. */
  schedules: number;
  /** AI or model-backed calls. */
  modelCalls: number;
  /** Shared layout writes (`PATCH …/layouts/:view`). */
  layoutWrites: number;
};

export type BaselineFixture = {
  readonly ids: typeof BASELINE;
  /** Scoped server-side effect counters observed since the page opened. */
  effects(): Promise<BaselineEffects>;
  /** Every request the browser attempted against an origin other than the app. */
  externalRequests(): string[];
  /** Every request the page made to the controlled API, in order. */
  apiRequests(): { method: string; path: string }[];
  /** The position batch of every layout PATCH the server accepted, in order. */
  layoutPatches(): { nodeId: string; x: number; y: number; pinned: boolean }[][];
  /** Publish the controlled DNS + two controlled HTTPS targets. */
  configureTargets(): void;
  /** Make the next layout PATCH answer 409 with the current revision. */
  failNextLayoutSave(): void;
  /** Serve a second site so a site switch is observable. */
  sites: { id: string; name: string }[];
};

export async function seedBaselineTopology(page: Page): Promise<BaselineFixture> {
  const user = {
    id: uuid('baseline-user'), email: 'baseline@example.test', name: 'Baseline reviewer', scope: 'organization',
    orgId: BASELINE.orgId, orgName: 'Baseline organization', partnerId: null, mfaEnabled: true,
    permissions: [{ resource: '*', action: '*' }],
  };

  await page.addInitScript(({ user: seeded, orgId }) => {
    localStorage.setItem('breeze-auth', JSON.stringify({ state: { user: seeded, isAuthenticated: true }, version: 2 }));
    // The org scope gate renders nothing until an organization is selected.
    localStorage.setItem('breeze-org', JSON.stringify({ state: { currentPartnerId: null, currentOrgId: orgId, allOrgs: false, lastOrgId: orgId, serviceManagementMode: false } }));
    const capture = { requests: [] as unknown[], results: [] as unknown[], violations: [] as string[], workers: [] as unknown[] };
    Object.assign(window, { topologyWorkerCapture: capture });
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        capture.workers.push(this);
        this.addEventListener('message', (event) => capture.results.push(event.data));
      }
      postMessage(message: unknown) { capture.requests.push(message); super.postMessage(message); }
    } as typeof Worker;
    document.addEventListener('securitypolicyviolation', (event) => capture.violations.push(
      `${event.violatedDirective}: ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`));
  }, { user, orgId: BASELINE.orgId });

  const effects: BaselineEffects = { commands: 0, schedules: 0, modelCalls: 0, layoutWrites: 0 };
  const apiRequests: { method: string; path: string }[] = [];
  const externalRequests: string[] = [];
  const layoutPatches: { nodeId: string; x: number; y: number; pinned: boolean }[][] = [];
  let targetsConfigured = false;
  let layoutConflict = false;
  let layoutRevision = 2;
  const sites = [
    { id: BASELINE.siteId, orgId: BASELINE.orgId, name: 'Baseline site' },
    { id: BASELINE.otherSiteId, orgId: BASELINE.orgId, name: 'Second site' },
  ];

  const runFor = (body: Record<string, string>) => {
    const recipeId = body.recipeId, family = body.family ?? 'ipv4';
    const subject = { kind: 'node', id: String((body as Record<string, unknown>).subject
      ? (body as unknown as { subject: { id: string } }).subject.id : BASELINE.gatewayNodeId) };
    const runId = uuid(`run-${recipeId}-${family}-${effects.commands}-${targetsConfigured}`);
    const attemptId = uuid(`attempt-${runId}`);

    if ((recipeId === 'dns_basic' || recipeId === 'internet_basic' || recipeId === 'target_connectivity') && !targetsConfigured) {
      // No configured target: the run is refused before any command is
      // registered, so nothing is dispatched and nothing leaves the agent.
      return {
        id: runId, attemptId, commandId: null, state: 'completed',
        plan: plan({ recipeId, family, subject, destinations: [], steps: [], reasons: ['target_not_configured'] }),
        assessment: 'unknown', coverage: 'none', reasons: ['target_not_configured'], steps: [],
        queuedAt: NOW, startedAt: null, deadline: '2026-09-16T12:01:10Z', finishedAt: '2026-09-16T12:00:00Z',
        cancelRequestedAt: null, failureReason: null,
      };
    }

    effects.commands += 1;
    const commandId = uuid(`command-${runId}`);

    if (recipeId === 'gateway_basic') {
      const routeStepId = uuid(`step-route-${runId}`), icmpStepId = uuid(`step-icmp-${runId}`);
      return {
        id: runId, attemptId, commandId, state: 'completed',
        plan: plan({
          recipeId, family, subject, destinations: [GATEWAY_DESTINATION],
          steps: [
            { id: routeStepId, required: true, destinationId: null, method: 'route_lookup' },
            { id: icmpStepId, required: true, destinationId: GATEWAY_DESTINATION.id, method: 'icmp', packetCount: 3, timeoutMs: 1000, payloadBytes: 32 },
          ],
        }),
        assessment: 'unknown', coverage: 'partial', reasons: [],
        steps: [
          step(routeStepId, 'succeeded', null, attribution('route_lookup', 'route_lookup', { destinationId: null })),
          // A silent gateway is NOT a failure verdict: it stays "No ICMP response".
          step(icmpStepId, 'timeout', 'icmp_no_response',
            attribution('icmp', 'icmp', { destinationId: GATEWAY_DESTINATION.id, resolvedIp: BASELINE.gatewayAddress }),
            { packetsSent: 3, packetsReceived: 0 }),
        ],
        queuedAt: NOW, startedAt: '2026-09-16T12:00:01Z', deadline: '2026-09-16T12:01:10Z',
        finishedAt: '2026-09-16T12:00:05Z', cancelRequestedAt: null, failureReason: null,
      };
    }

    if (recipeId === 'dns_basic') {
      const dnsStepId = uuid(`step-dns-${runId}`);
      return {
        id: runId, attemptId, commandId, state: 'completed',
        plan: plan({
          recipeId, family, subject, destinations: [RESOLVER_DESTINATION, DNS_TARGET_DESTINATION],
          steps: [{ id: dnsStepId, required: true, destinationId: DNS_TARGET_DESTINATION.id, method: 'dns', timeoutMs: 1500, retries: 1, queryType: 'A', resolverDestinationIds: [RESOLVER_DESTINATION.id] }],
        }),
        assessment: 'healthy', coverage: 'complete', reasons: [],
        steps: [step(dnsStepId, 'succeeded', null,
          attribution('dns', 'dns', { destinationId: DNS_TARGET_DESTINATION.id, resolvedIp: '198.51.100.10', port: 53 }),
          { latencyMs: 4, resolvedAddresses: ['198.51.100.10'] })],
        queuedAt: NOW, startedAt: '2026-09-16T12:00:01Z', deadline: '2026-09-16T12:01:10Z',
        finishedAt: '2026-09-16T12:00:05Z', cancelRequestedAt: null, failureReason: null,
      };
    }

    // target_connectivity / internet_basic against the two controlled HTTPS
    // targets: one full DNS→TCP→TLS→HTTP chain succeeds, the other fails at TCP.
    const ids = {
      dns: uuid(`step-dns-${runId}`), tcpA: uuid(`step-tcp-a-${runId}`), tlsA: uuid(`step-tls-a-${runId}`),
      httpA: uuid(`step-http-a-${runId}`), tcpB: uuid(`step-tcp-b-${runId}`),
    };
    return {
      id: runId, attemptId, commandId, state: 'completed',
      plan: plan({
        recipeId, family, subject,
        destinations: [RESOLVER_DESTINATION, HTTPS_A_DESTINATION, HTTPS_B_DESTINATION],
        steps: [
          { id: ids.dns, required: true, destinationId: HTTPS_A_DESTINATION.id, method: 'dns', timeoutMs: 1500, retries: 1, queryType: 'A', resolverDestinationIds: [RESOLVER_DESTINATION.id] },
          { id: ids.tcpA, required: true, destinationId: HTTPS_A_DESTINATION.id, method: 'tcp', timeoutMs: 3000 },
          { id: ids.tlsA, required: true, destinationId: HTTPS_A_DESTINATION.id, method: 'tls', timeoutMs: 3000 },
          { id: ids.httpA, required: true, destinationId: HTTPS_A_DESTINATION.id, method: 'http', timeoutMs: 3000, responseLimitBytes: 4096 },
          { id: ids.tcpB, required: false, destinationId: HTTPS_B_DESTINATION.id, method: 'tcp', timeoutMs: 3000 },
        ],
      }),
      assessment: 'degraded', coverage: 'partial', reasons: [],
      steps: [
        step(ids.dns, 'succeeded', null, attribution('dns', 'dns', { destinationId: HTTPS_A_DESTINATION.id, resolvedIp: '198.51.100.10', port: 53 }), { resolvedAddresses: ['198.51.100.10'], latencyMs: 3 }),
        step(ids.tcpA, 'succeeded', null, attribution('tcp', 'tcp', { destinationId: HTTPS_A_DESTINATION.id, resolvedIp: '198.51.100.10', port: 443 }), { latencyMs: 11 }),
        step(ids.tlsA, 'succeeded', null, attribution('tls', 'tls', { destinationId: HTTPS_A_DESTINATION.id, resolvedIp: '198.51.100.10', port: 443 }), { latencyMs: 21 }),
        step(ids.httpA, 'succeeded', null, attribution('http', 'http', { destinationId: HTTPS_A_DESTINATION.id, resolvedIp: '198.51.100.10', port: 443 }), { statusCode: 200, latencyMs: 33 }),
        // Partial failure: the second controlled target never completes TCP.
        step(ids.tcpB, 'failed_check', 'tcp_refused', attribution('tcp', 'tcp', { destinationId: HTTPS_B_DESTINATION.id, resolvedIp: '198.51.100.20', port: 443, quality: 'observed' }), { errorCode: 'tcp_refused' }),
      ],
      queuedAt: NOW, startedAt: '2026-09-16T12:00:01Z', deadline: '2026-09-16T12:01:10Z',
      finishedAt: '2026-09-16T12:00:09Z', cancelRequestedAt: null, failureReason: null,
    };
  };

  const collectors = () => ({
    items: [{ origin: origin(), eligible: true, reasons: [], families: ['ipv4', 'ipv6'], rank: 0 }],
    nextCursor: null,
  });

  const asset = (id: string, hostname: string, label: string, ip: string) => ({
    id, orgId: BASELINE.orgId, siteId: BASELINE.siteId, siteName: 'Baseline site', assetType: 'router',
    approvalStatus: 'approved', isOnline: true, hostname, label, ipAddress: ip, openPorts: [],
    linkedDeviceId: null, snmpData: {}, discoveryMethods: ['arp'], tags: [],
  });

  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    apiRequests.push({ method, path });

    if (/^\/(ai|ai-agents?|chat|llm|assistant)(\/|$)/.test(path)) effects.modelCalls += 1;
    if (method !== 'GET') {
      if (/\/topology\/sites\/[^/]+\/layouts\//.test(path)) {
        if (layoutConflict) {
          layoutConflict = false;
          await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Layout revision changed', code: 'layout_conflict', layoutRevision: String(layoutRevision) }) });
          return;
        }
        effects.layoutWrites += 1;
        const body = request.postDataJSON() as { positions: { nodeId: string; x: number; y: number; pinned: boolean }[] };
        layoutPatches.push(body.positions);
        layoutRevision += 1;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          siteId: BASELINE.siteId, view: 'overview', layoutRevision: String(layoutRevision),
          positions: body.positions.map((position) => ({ ...position, source: 'user', rowRevision: String(layoutRevision) })),
          rejected: [],
        }) });
        return;
      }
      if (path.includes('/policies') || path.includes('/monitors') || path.includes('/schedules')) effects.schedules += 1;
      if (/\/topology\/sites\/[^/]+\/diagnostic-runs$/.test(path)) {
        const body = request.postDataJSON() as Record<string, string>;
        await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(runFor(body)) });
        return;
      }
    }

    let body: unknown = { data: [] };
    if (path === '/auth/refresh') body = { tokens: { accessToken: 'baseline-token', expiresInSeconds: 3600 } };
    else if (path === '/users/me') body = user;
    else if (path === '/orgs/organizations') body = { data: [{ id: BASELINE.orgId, name: 'Baseline organization', status: 'active' }] };
    else if (path === '/orgs/sites') body = { data: sites };
    else if (path === `/discovery/assets/${BASELINE.networkDeviceId}`) body = { data: asset(BASELINE.networkDeviceId, 'baseline-gateway', 'Reported gateway 192.0.2.1', BASELINE.gatewayAddress) };
    // `/devices/:id` is read UNWRAPPED by DeviceDetailPage — no `data` envelope.
    else if (path === `/devices/${BASELINE.deviceId}`) body = { id: BASELINE.deviceId, orgId: BASELINE.orgId, siteId: BASELINE.siteId, siteName: 'Baseline site', hostname: BASELINE.agentId, displayName: BASELINE.agentId, status: 'online', osType: 'linux', osVersion: '24.04', agentVersion: '0.113.0', ipAddress: '192.0.2.10', tags: [], recentMetrics: [], lastSeen: NOW };
    else if (path.endsWith('/collectors')) body = collectors();
    else if (/\/topology\/sites\/[^/]+\/settings$/.test(path)) body = baselineSettings(url.pathname.split('/sites/')[1]?.split('/')[0]);
    else if (path.endsWith('/nodes')) {
      const graph = baselineGraph();
      const assetFilter = url.searchParams.get('assetId'), deviceFilter = url.searchParams.get('deviceId');
      const query = url.searchParams.get('q')?.toLocaleLowerCase();
      let nodes = graph.nodes;
      if (assetFilter) nodes = nodes.filter((item) => item.bindings.some((binding) => (binding as { referenceId: string }).referenceId === assetFilter));
      else if (deviceFilter) nodes = nodes.filter((item) => item.bindings.some((binding) => (binding as { referenceId: string }).referenceId === deviceFilter));
      else if (query) nodes = nodes.filter((item) => item.label.toLocaleLowerCase().includes(query));
      body = { siteId: BASELINE.siteId, graphRevision: '4', total: nodes.length, nodes, cursor: null };
    } else if (path.endsWith('/graph')) body = baselineGraph();
    else if (path.endsWith('/health')) {
      const graph = baselineGraph();
      body = { siteId: BASELINE.siteId, graphRevision: '4', healthRevision: '1', nodes: graph.nodes.map((item) => ({ id: item.id, health: item.health })), relationships: [] };
    } else if (path.includes('/sites')) body = { data: sites };
    else if (path.includes('/targets') || path.includes('/configuration')) body = { data: targetsConfigured ? [dnsTargetDefinition, httpsTargetDefinition('controlled-a', 'a.baseline.invalid'), httpsTargetDefinition('controlled-b', 'b.baseline.invalid')] : [] };

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  // Anything the page attempts outside its own origin is a defect for this
  // feature: no CDN worker, no model endpoint, no real destination.
  page.on('request', (outgoing: Request) => {
    const target = new URL(outgoing.url());
    if (target.protocol === 'data:' || target.protocol === 'blob:') return;
    const base = new URL(page.url() || 'http://127.0.0.1');
    if (target.origin !== base.origin && base.origin !== 'null') externalRequests.push(outgoing.url());
  });

  return {
    ids: BASELINE,
    effects: async () => ({ ...effects }),
    externalRequests: () => [...externalRequests],
    apiRequests: () => [...apiRequests],
    layoutPatches: () => layoutPatches.map((batch) => [...batch]),
    configureTargets: () => { targetsConfigured = true; },
    failNextLayoutSave: () => { layoutConflict = true; },
    sites: sites.map(({ id, name }) => ({ id, name })),
  };
}
