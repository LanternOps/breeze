import type { GraphResponse, TopologyAiExplanation, TopologyAiSelection } from '@breeze/shared';
import { SITE, topologyGraphFixture } from './topologyFixtures';

/** M4 Task 5 test fixtures: a two-node graph with one connection, and a cited explanation over it. */
export const AI = {
  site: SITE,
  gateway: '22222222-2222-4222-8222-222222222222',
  switch: '44444444-4444-4444-8444-444444444444',
  link: '55555555-5555-4555-8555-555555555555',
  device: '66666666-6666-4666-8666-666666666666',
  session: '77777777-7777-4777-8777-777777777777',
  run: '88888888-8888-4888-8888-888888888888',
  foreignNode: '99999999-9999-4999-8999-999999999999',
  switchAlias: 'host-0a1b2c3d',
  foreignAlias: 'host-deadbeef',
} as const;

export function aiGraphFixture(): GraphResponse {
  const base = topologyGraphFixture();
  const gateway = base.nodes[0]!;
  return {
    ...base,
    nodes: [gateway, { ...gateway, id: AI.switch, kind: 'network', role: 'switch', label: 'Core switch', bindings: [{ id: AI.device, type: 'device', referenceId: AI.device }] }],
    relationships: [{
      id: AI.link, kind: 'physical_link', sourceNodeId: AI.switch, targetNodeId: AI.gateway, directness: 'direct', confidence: 'high',
      directionality: 'undirected', sourceInterfaceId: null, targetInterfaceId: null, lifecycle: 'active', freshness: 'fresh',
      evidence: { classes: ['observed'], methods: ['lldp'], count: '1', lastObservedAt: '2026-09-16T12:00:00Z' },
      health: { status: 'unknown', coverage: 'unmonitored', scope: 'relationship', originNodeId: null, resultId: null, reasons: [], freshness: 'unknown' },
      availableActions: [],
    } as unknown as GraphResponse['relationships'][number]],
  };
}

export const aiSelection = (over: Partial<TopologyAiSelection> = {}): TopologyAiSelection => ({
  siteId: AI.site, subject: { kind: 'relationship', id: AI.link }, view: 'overview', graphRevision: '1', ...over,
});

export function aiExplanationFixture(over: Partial<TopologyAiExplanation> = {}): TopologyAiExplanation {
  return {
    schemaVersion: 1, status: 'complete', reasons: [],
    findings: [
      { kind: 'finding', claim: 'health', text: `The uplink of ${AI.switchAlias} reports failed checks.`, citationIds: [AI.link] },
      { kind: 'hypothesis', claim: 'cause', text: `A loop behind ${AI.foreignAlias} may flood the link.`, citationIds: [] },
    ],
    missingData: [`No LLDP from ${AI.switchAlias}.`],
    nextChecks: [{ recipeId: 'gateway_basic', rationale: 'Check the gateway from the switch.', citationIds: [AI.switch] }],
    citationIds: [AI.link, AI.switch],
    citations: [
      { id: AI.link, resourceType: 'relationship', resourceId: AI.link, observedAt: '2026-09-16T12:00:00Z', inspectorTarget: { kind: 'relationship', id: AI.link } },
      { id: AI.switch, resourceType: 'node', resourceId: AI.switch, observedAt: null, inspectorTarget: { kind: 'node', id: AI.switch } },
    ],
    hostAliases: [{ alias: AI.switchAlias, nodeId: AI.switch }, { alias: AI.foreignAlias, nodeId: AI.foreignNode }],
    ...over,
  };
}

/** A streamed SSE `Response` for `fetchWithAuth` (one chunk, or held until `release()`). */
export function sseResponse(events: unknown[], hold?: Promise<void>): Response {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n`).join(''));
  let sent = false;
  return {
    ok: true, status: 200,
    body: { getReader: () => ({
      read: async () => {
        if (sent) return { done: true, value: undefined };
        if (hold) await hold;
        sent = true;
        return { done: false, value: bytes };
      },
      cancel: async () => undefined,
    }) },
  } as unknown as Response;
}

export const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
