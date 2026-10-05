import type { BrowserContext, Page, Route } from '@playwright/test';
import {
  TOPOLOGY_FIXTURE_SEED, topologyGraphFixture, type TopologyGraphFixtureName,
} from '../../packages/shared/src/testing/topologyFleet';

/**
 * Browser performance harness for the topology explorer (design spec §9, M1
 * Task 25). It measures the BUILT production bundle — the same server, module
 * layout worker, ELK engine worker and CSP the `topology-worker` gate uses — and
 * serves the visible projections V200/V500/V1000 through a controlled in-page
 * API, exactly like the other topology browser gates.
 *
 * Why the graph response is served rather than read from a seeded API: every
 * §9 browser target is timed from "after graph response". The API read budget
 * (p95 < 500 ms for a 10,000-node site) is a separate gate. Serving the
 * projection keeps the measured interval free of API/DB variance and makes the
 * payload byte-identical on every host (seed `topology-v1`).
 */

export type ProjectionName = Extract<TopologyGraphFixtureName, 'V200' | 'V500' | 'V1000'>;

/** Normative projection sizes (§9). Asserted before any timing starts. */
export const PROJECTION_SPEC: Record<ProjectionName, { nodes: number; edges: number }> = {
  V200: { nodes: 200, edges: 350 },
  V500: { nodes: 500, edges: 1_000 },
  V1000: { nodes: 1_000, edges: 2_000 },
};
/** The collapsed/expanded projections are views of the G10K site. */
const G10K_TOTAL = { nodes: 10_000, edges: 20_000 };

const ORG = '5e7f0a10-0000-4000-8000-000000000001';
const SITE = '5e7f0a10-0000-4000-8000-000000000002';
const USER = '5e7f0a10-0000-4000-8000-000000000003';
const AS_OF = '2026-09-16T12:00:00Z';

const METHOD_BY_KIND: Record<string, string> = {
  network_member: 'os_interface', default_route: 'os_route', attachment: 'fdb', physical_link: 'lldp',
};
const unknownHealth = (scope: 'node' | 'relationship') => ({
  status: 'unknown', coverage: 'unmonitored', scope, originNodeId: null, resultId: null,
  reasons: [{ code: 'not_measured', message: 'Not measured' }], freshness: 'unknown',
});

/**
 * The published graph response for one visible projection, built from the
 * shared deterministic generator. Pinned fixture nodes arrive as saved user
 * positions on a widely spaced row so they never overlap each other (a
 * `pinned_overlap` warning would be a fixture artefact, not a product result).
 */
export function projectionGraph(name: ProjectionName, seed = TOPOLOGY_FIXTURE_SEED) {
  const fixture = topologyGraphFixture(name, seed);
  const expected = PROJECTION_SPEC[name];
  if (fixture.nodes.length !== expected.nodes || fixture.edges.length !== expected.edges) {
    throw new Error(`${name} fixture has ${fixture.nodes.length}/${fixture.edges.length} nodes/edges; §9 requires ${expected.nodes}/${expected.edges}`);
  }
  const stale = new Set(fixture.nodes.filter((node) => node.stale).map((node) => node.id));
  const graph = {
    schemaVersion: 1, siteId: SITE, view: 'overview', asOf: AS_OF,
    revisions: { graph: '1', health: '1', layout: '1' },
    nodes: fixture.nodes.map((node) => ({
      id: node.id, kind: node.kind, role: node.kind, label: node.label, bindings: [],
      lifecycle: 'active', freshness: node.stale ? 'stale' : 'fresh',
      evidence: { classes: ['observed'], methods: [node.kind === 'gateway' ? 'os_route' : 'os_interface'], count: '4', lastObservedAt: AS_OF },
      health: unknownHealth('node'), availableActions: ['diagnose'],
    })),
    relationships: fixture.edges.map((edge) => ({
      id: edge.id, kind: edge.kind, directionality: edge.kind === 'network_member' ? 'undirected' : 'directed',
      sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, sourceInterfaceId: null, targetInterfaceId: null,
      meaning: edge.kind.replace('_', ' '), directness: 'direct',
      evidence: { classes: ['observed'], methods: [METHOD_BY_KIND[edge.kind]!], count: String(edge.sourceCount), lastObservedAt: AS_OF },
      confidence: 'high', lifecycle: 'active',
      freshness: stale.has(edge.sourceNodeId) || stale.has(edge.targetNodeId) ? 'stale' : 'fresh',
      health: unknownHealth('relationship'), excluded: false, availableActions: ['diagnose'],
    })),
    presentation: { nodes: [], edges: [] },
    layout: {
      algorithm: 'elk-layered', version: 1,
      positions: fixture.nodes.filter((node) => node.pinned).map((node, index) => ({
        nodeId: node.id, x: 600 * index, y: -600, pinned: true, source: 'user', rowRevision: '1',
      })),
    },
    counts: {
      totalNodes: G10K_TOTAL.nodes, totalRelationships: G10K_TOTAL.edges,
      visibleNodes: expected.nodes, visibleRelationships: expected.edges,
      omittedNodes: G10K_TOTAL.nodes - expected.nodes, omittedRelationships: G10K_TOTAL.edges - expected.edges,
    },
    coverage: { state: 'limited', reasons: [{ code: 'projection', message: 'Collapsed projection of a 10,000-node site' }] },
    frontier: [], permissions: { canEdit: true, canDiagnose: true, canConfigureMonitoring: true },
  };
  return { graph, body: JSON.stringify(graph), pinned: graph.layout.positions.length };
}

function settings() {
  const yes = { available: true, reason: null }, no = { available: false, reason: 'capability_unavailable' };
  return {
    siteId: SITE, settingsRevision: '1',
    flags: { materialization: true, ui: true, physical: false, interfaceHealth: false, diagnostics: true, ai: false },
    capabilities: { materialization: yes, ui: yes, collection: yes, physical: no, interfaceHealth: no, diagnostics: yes, ai: no, recurringMonitoring: no },
    permissions: { canEdit: true, canDiagnose: true, canConfigureMonitoring: true },
    resolved: { settings: { targets: {}, policies: {} }, digest: 'a'.repeat(64), provenance: {}, validationEffects: [] },
    binding: { partnerVersionId: null, orgVersionId: null, bindingRevision: '1', defaultsVersion: 1, schemaVersion: 1, resolverVersion: 1, overrides: { targets: {}, policies: {} } },
  };
}

/**
 * Serve one projection to every page of `context`. Also counts writes: a
 * performance open must stay passive, so any non-GET topology request is a
 * defect the spec asserts on.
 */
export async function serveProjection(context: BrowserContext, name: ProjectionName) {
  const { graph, body } = projectionGraph(name);
  const writes: string[] = [];
  const user = {
    id: USER, email: 'perf@example.test', name: 'Topology performance', scope: 'organization',
    orgId: ORG, orgName: 'Performance organization', partnerId: null, mfaEnabled: true,
    permissions: [{ resource: '*', action: '*' }],
  };
  await context.addInitScript(({ user: seeded, orgId }) => {
    localStorage.setItem('breeze-auth', JSON.stringify({ state: { user: seeded, isAuthenticated: true }, version: 2 }));
    localStorage.setItem('breeze-org', JSON.stringify({ state: { currentPartnerId: null, currentOrgId: orgId, allOrgs: false, lastOrgId: orgId, serviceManagementMode: false } }));
  }, { user, orgId: ORG });
  await context.route('**/api/v1/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (request.method() !== 'GET' && path.startsWith('/topology')) writes.push(`${request.method()} ${path}`);
    let payload: unknown = { data: [] };
    if (path === '/auth/refresh') payload = { tokens: { accessToken: 'perf-token', expiresInSeconds: 3600 } };
    else if (path === '/users/me') payload = user;
    else if (path === '/orgs/organizations') payload = { data: [{ id: ORG, name: 'Performance organization', status: 'active' }] };
    else if (path === '/orgs/sites' || path.endsWith('/sites')) payload = { data: [{ id: SITE, orgId: ORG, name: 'Performance site' }] };
    else if (/\/topology\/sites\/[^/]+\/settings$/.test(path)) payload = settings();
    else if (/\/topology\/sites\/[^/]+\/graph$/.test(path)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body });
      return;
    } else if (/\/topology\/sites\/[^/]+\/health$/.test(path)) {
      payload = { siteId: SITE, graphRevision: '1', healthRevision: '1', nodes: [], relationships: [] };
    } else if (/\/topology\/sites\/[^/]+\/nodes$/.test(path)) {
      payload = { siteId: SITE, graphRevision: '1', total: 0, nodes: [], cursor: null };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  return { siteId: SITE, graphBytes: Buffer.byteLength(body), nodeCount: graph.nodes.length, edgeCount: graph.relationships.length, writes };
}

/**
 * In-page probes, installed before any application script runs. Nothing here
 * changes application behaviour: the Worker subclass only timestamps the
 * messages the layout controller already sends and receives.
 */
export async function installProbes(context: BrowserContext) {
  await context.addInitScript(() => {
    const probe = {
      longTasks: [] as [number, number][],
      graph: null as null | { responseEnd: number; source: 'resource-timing' | 'fetch'; encodedBodySize?: number },
      graphFetchAt: null as null | number,
      requests: [] as { requestId: string; at: number; nodes: number; edges: number; mode: string }[],
      results: [] as { requestId: string; at: number; warning: string | null; positions: number }[],
      workerErrors: [] as { at: number; message: string }[],
      workers: [] as string[],
      violations: [] as string[],
      appliedAt: null as null | number,
      warningAtApply: false,
      paintedAt: null as null | number,
    };
    Object.assign(window, { topologyPerfProbe: probe });
    try { performance.setResourceTimingBufferSize(5000); } catch { /* optional */ }
    const graphUrl = /\/topology\/sites\/[^/?]+\/graph(\?|$)/;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push([entry.startTime, entry.duration]);
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        if (!probe.graph && graphUrl.test(entry.name)) {
          probe.graph = { responseEnd: entry.responseEnd, source: 'resource-timing', encodedBodySize: entry.encodedBodySize };
        }
      }
    }).observe({ type: 'resource', buffered: true });
    const nativeFetch = window.fetch;
    window.fetch = async function (this: typeof globalThis, input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const response = await nativeFetch.call(this, input, init);
      if (graphUrl.test(url) && probe.graphFetchAt === null) probe.graphFetchAt = performance.now();
      return response;
    } as typeof fetch;
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        probe.workers.push(String(url));
        this.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as { requestId?: string; warning?: string; positions?: unknown[] } | null;
          probe.results.push({ requestId: String(data?.requestId), at: performance.now(), warning: data?.warning ?? null, positions: data?.positions?.length ?? 0 });
        });
        this.addEventListener('error', (event: ErrorEvent) => probe.workerErrors.push({ at: performance.now(), message: event.message ?? 'worker error' }));
      }
      postMessage(message: unknown, transfer?: unknown) {
        const request = message as { requestId?: string; nodes?: unknown[]; edges?: unknown[]; mode?: string } | null;
        probe.requests.push({ requestId: String(request?.requestId), at: performance.now(), nodes: request?.nodes?.length ?? 0, edges: request?.edges?.length ?? 0, mode: String(request?.mode) });
        return (super.postMessage as (m: unknown, t?: unknown) => void)(message, transfer);
      }
    } as typeof Worker;
    document.addEventListener('securitypolicyviolation', (event) => probe.violations.push(`${event.violatedDirective}: ${event.blockedURI}`));
    // The layout is applied when the explorer marks `data-layout-applied` (the
    // result reached React state and the canvas). Two frames later it painted.
    // Not the unsaved indicator: the automatic arrangement on load is no longer
    // an unsaved change (#7880).
    const applied = '[data-testid="topology-explorer"][data-layout-applied]';
    const observer = new MutationObserver(() => {
      if (probe.appliedAt !== null || !document.querySelector(applied)) return;
      probe.appliedAt = performance.now();
      probe.warningAtApply = !!document.querySelector('[data-testid="topology-layout-warning"]');
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => { probe.paintedAt = performance.now(); }));
    });
    const start = () => observer.observe(document.documentElement, { childList: true, subtree: true });
    if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
  });
}

export type Probe = {
  longTasks: [number, number][];
  graph: null | { responseEnd: number; source: string; encodedBodySize?: number };
  graphFetchAt: null | number;
  requests: { requestId: string; at: number; nodes: number; edges: number; mode: string }[];
  results: { requestId: string; at: number; warning: string | null; positions: number }[];
  workerErrors: { at: number; message: string }[];
  workers: string[];
  violations: string[];
  appliedAt: null | number;
  warningAtApply: boolean;
  paintedAt: null | number;
};

export type ThrottleProfile = { cpuRate: number; latencyMs: number; downloadBps: number; uploadBps: number };
/** §9 reference browser profile: 4x CPU, 100 ms RTT, 10 Mbps. */
export const REFERENCE_THROTTLE: ThrottleProfile = { cpuRate: 4, latencyMs: 100, downloadBps: 10_000_000 / 8, uploadBps: 10_000_000 / 8 };

/** Apply the §9 CPU/network emulation to a page before it navigates. */
export async function throttle(page: Page, profile: ThrottleProfile) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuRate });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: profile.latencyMs, downloadThroughput: profile.downloadBps, uploadThroughput: profile.uploadBps,
  });
  return cdp;
}

/**
 * A fixed amount of busy work, timed in the page and in a dedicated worker.
 * Recorded per projection so the artifact proves the CPU throttle was really
 * in effect on both threads (throttled ≈ rate × unthrottled on the same host).
 */
export async function calibrate(page: Page) {
  return page.evaluate(async () => {
    const work = () => { let x = 0; for (let i = 0; i < 20_000_000; i += 1) x = (x + i * 7) % 1_000_003; return x; };
    const t0 = performance.now(); work(); const mainMs = performance.now() - t0;
    const source = `onmessage=()=>{const t=performance.now();let x=0;for(let i=0;i<20000000;i+=1)x=(x+i*7)%1000003;postMessage([performance.now()-t,x]);}`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      const worker = new Worker(url);
      const workerMs = await new Promise<number>((resolve, reject) => {
        worker.onmessage = (event) => { resolve((event.data as [number])[0]); worker.terminate(); };
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage(null);
      });
      return { mainMs, workerMs };
    } catch (error) {
      return { mainMs, workerMs: null as number | null, workerError: String(error) };
    } finally { URL.revokeObjectURL(url); }
  });
}
