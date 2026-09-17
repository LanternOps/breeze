import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { graphResponseSchema } from '@breeze/shared';
import type { TopologyRequestContext } from './access';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), version: vi.fn(), access: vi.fn(), permissions: vi.fn() }));
vi.mock('../../db', () => ({ db: { execute: mocks.execute, transaction: mocks.transaction } }));
vi.mock('../permissions', async (original) => ({ ...await original<object>(), getPermissionAuthorityVersion: mocks.version, getUserPermissions: mocks.permissions }));
vi.mock('./access', async (original) => ({ ...await original<object>(), requireTopologySiteAccess: mocks.access }));
vi.mock('../secretCrypto', () => ({ getSecretDerivedKeyMaterials: () => ({ active: { key: Buffer.alloc(32, 7) }, retained: [{ key: Buffer.alloc(32, 7) }] }) }));
import { getTopologyGraph, listTopologyNodes, expandTopologyGraph, getTopologyRelationshipEvidence, getTopologyHealth, getTopologyNode, getTopologyGroupMembers } from './graph';
import { issueGraphToken, verifyGraphToken, GraphReadError } from './graphCursor';

const ORG = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const NODE = '30000000-0000-4000-8000-000000000001';
const OTHER = '30000000-0000-4000-8000-000000000002';
const REL = '40000000-0000-4000-8000-000000000001';
const ctx = { auth: { user: { id: '50000000-0000-4000-8000-000000000001' }, scope: 'organization', orgId: ORG, canAccessOrg: () => true }, permissions: { scope: 'organization', orgId: ORG, permissions: [{ resource: 'topology', action: 'read' }, { resource: 'devices', action: 'read' }] }, scope: { orgId: ORG, siteId: SITE } } as unknown as TopologyRequestContext;
const query = { view: 'overview', hops: 1, includeHealth: false, limit: 1 } as const;
const state = [{ graph: '9007199254740993', health: '4' }];
const node = { id: NODE, kind: 'endpoint', role: null, label: 'Visible endpoint', lifecycle: 'active', lastObservedAt: null, legacy: true, bindings: [] };
const dialect = new PgDialect();
function sqlText(call: unknown[]) { return dialect.sqlToQuery(call[0] as Parameters<PgDialect['sqlToQuery']>[0]); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockReset();
  mocks.transaction.mockImplementation((fn) => fn({ execute: mocks.execute }));
  mocks.version.mockResolvedValue('0:0');
  mocks.permissions.mockResolvedValue(ctx.permissions);
  mocks.access.mockResolvedValue(ctx);
});

it('starts with a nonempty bounded graph and reports omitted entities and boundary provenance', async () => {
  mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ count: '2' }]).mockResolvedValueOnce([{ count: '1' }])
    .mockResolvedValueOnce([node]).mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: REL, sourceNodeId: NODE, targetNodeId: OTHER }])
    .mockResolvedValueOnce([]);
  const graph = await getTopologyGraph(ctx, query);
  expect(graphResponseSchema.safeParse(graph).success).toBe(true);
  expect(graph.nodes).toHaveLength(1);
  expect(graph.counts).toEqual({ totalNodes: 2, visibleNodes: 1, omittedNodes: 1, totalRelationships: 1, visibleRelationships: 0, omittedRelationships: 1 });
  expect(graph.presentation.edges).toHaveLength(1);
  expect(graph.presentation.edges[0]).toMatchObject({ presentationOnly: true, relationshipKind: null, contributingRelationshipIds: [REL] });
  expect(graph.revisions.graph).toBe('9007199254740993');
  for (const call of mocks.execute.mock.calls) expect(sqlText(call).sql).not.toMatch(/\b(insert|update|delete)\b/i);
  const nodeQuery = mocks.execute.mock.calls.map(sqlText).find((q) => q.sql.includes('as "bindings"'))!;
  expect(nodeQuery.params).toContain(ORG); expect(nodeQuery.params).toContain(SITE);
  expect(nodeQuery.sql).toMatch(/limit/i); expect(nodeQuery.params).toContain(1);
});

describe('attributed health overlay', () => {
  const RESULT = '70000000-0000-4000-8000-000000000001';
  const MONITOR = '60000000-0000-4000-8000-000000000001';
  const DEVICE = '80000000-0000-4000-8000-000000000001';
  const healthQuery = { ...query, includeHealth: true } as const;
  const binding = {
    bindingId: '90000000-0000-4000-8000-000000000001', nodeId: NODE, relationshipId: null,
    contextKey: 'default', family: 'ipv4', metricRole: 'connectivity',
    originDeviceId: DEVICE, originNodeId: OTHER, originSiteId: SITE,
    monitorId: MONITOR, monitorName: 'Gateway ping', monitorType: 'icmp_ping', monitorTarget: '192.0.2.1',
    monitorActive: true, pollingInterval: 60,
    resultId: RESULT, resultStatus: 'online', resultDeviceId: DEVICE, resultAt: new Date().toISOString(),
  };

  it('carries the reused monitor result into node health without issuing any command', async () => {
    mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: '1' }]).mockResolvedValueOnce([{ count: '0' }])
      .mockResolvedValueOnce([node]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([binding]).mockResolvedValueOnce([{ monitorId: MONITOR, count: '1' }]);

    const graph = await getTopologyGraph(ctx, healthQuery);

    expect(graphResponseSchema.safeParse(graph).success).toBe(true);
    expect(graph.nodes[0]!.health).toMatchObject({
      status: 'healthy', coverage: 'monitored', freshness: 'fresh', scope: 'node',
      originNodeId: OTHER, resultId: RESULT,
    });
    // A read never dispatches work: no writes at all, and nothing touches the
    // command queue the agents poll.
    for (const call of mocks.execute.mock.calls) {
      const statement = sqlText(call).sql;
      expect(statement).not.toMatch(/\b(insert|update|delete)\b/i);
      expect(statement).not.toMatch(/device_commands/i);
    }
  });

  it('leaves health unmeasured with a reason when the projection does not ask for it', async () => {
    mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: '1' }]).mockResolvedValueOnce([{ count: '0' }])
      .mockResolvedValueOnce([node]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const graph = await getTopologyGraph(ctx, query);

    expect(graph.nodes[0]!.health).toMatchObject({ status: 'unknown', coverage: 'unmonitored' });
    expect(graph.nodes[0]!.health.reasons.length).toBeGreaterThan(0);
    expect(mocks.execute.mock.calls.some((call) => sqlText(call).sql.includes('topology_monitor_bindings'))).toBe(false);
  });

  it('answers the health endpoint from the same attributed overlays', async () => {
    mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([{ id: NODE }])
      .mockResolvedValueOnce([binding]).mockResolvedValueOnce([{ monitorId: MONITOR, count: '0' }]);

    const health = await getTopologyHealth(ctx, { nodeIds: [NODE], relationshipIds: [] });

    expect(health.healthRevision).toBe('4');
    expect(health.graphRevision).toBe('9007199254740993');
    expect(health.nodes[0]).toMatchObject({ id: NODE, health: { status: 'healthy', resultId: RESULT } });
  });

  it('reports a canonical entity with no bound monitor as unmonitored, not healthy', async () => {
    mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([{ id: NODE }]).mockResolvedValueOnce([]);

    const health = await getTopologyHealth(ctx, { nodeIds: [NODE], relationshipIds: [] });

    expect(health.nodes[0]!.health).toMatchObject({ status: 'unknown', coverage: 'unmonitored', resultId: null });
    expect(health.nodes[0]!.health.reasons[0]!.code).toBe('no_monitor_binding');
  });
});

it('returns a passive empty baseline if state has never been created', async () => {
  mocks.execute.mockResolvedValueOnce([]);
  const graph = await getTopologyGraph(ctx, query);
  expect(graph.nodes).toEqual([]); expect(graph.revisions.graph).toBe('0');
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});

it('fails closed before graph SQL when permission version is unavailable', async () => {
  mocks.version.mockResolvedValue(null);
  await expect(getTopologyGraph(ctx, query)).rejects.toMatchObject({ code: 'topology_authority_unavailable', status: 503 });
  expect(mocks.execute).not.toHaveBeenCalled();
});

it('escapes search wildcards and counts under the identical filter', async () => {
  mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([{ count: '1' }]).mockResolvedValueOnce([node]);
  const result = await listTopologyNodes(ctx, { q: 'host_%\\', limit: 100, lifecycle: 'active' });
  expect(result.total).toBe(1);
  const calls = mocks.execute.mock.calls.map(sqlText);
  expect(calls[1]?.params).toContain('%host\\_\\%\\\\%');
  expect(calls[2]?.params).toContain('%host\\_\\%\\\\%');
});

it('rejects a graph cursor after publication and never reads graph rows', async () => {
  mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: '2' }]).mockResolvedValueOnce([{ count: '0' }]).mockResolvedValueOnce([node]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  const first = await getTopologyGraph(ctx, query);
  mocks.execute.mockReset().mockResolvedValueOnce([{ graph: '9007199254740994', health: '4' }]);
  await expect(expandTopologyGraph(ctx, first.frontier[0]!.token)).rejects.toMatchObject({ code: 'graph_revision_changed', status: 409 });
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});

it('hides evidence from a relationship outside the authorized scope', async () => {
  mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([]);
  await expect(getTopologyRelationshipEvidence(ctx, REL, { limit: 50 })).rejects.toMatchObject({ status: 404 });
  const statement = sqlText(mocks.execute.mock.calls[1]!);
  expect(statement.params).toContain(ORG); expect(statement.params).toContain(SITE); expect(statement.params).toContain(REL);
});

it('bounds health requests before database access', async () => {
  await expect(getTopologyHealth(ctx, { nodeIds: Array(1001).fill(NODE), relationshipIds: [] })).rejects.toMatchObject({ status: 400 });
  expect(mocks.execute).not.toHaveBeenCalled();
});

describe('signed graph cursor authority', () => {
  const claims = { kind: 'graph', authority: 'a'.repeat(64), orgId: ORG, siteId: SITE, graphRevision: '4', filter: query } as const;
  it('round trips and rejects signature tampering, expiry, and another authority', () => {
    const token = issueGraphToken(claims, 100);
    expect(verifyGraphToken(token, claims.authority, ctx.scope, 101).graphRevision).toBe('4');
    expect(() => verifyGraphToken(`${token.slice(0, -2)}aa`, claims.authority, ctx.scope, 101)).toThrow(GraphReadError);
    expect(() => verifyGraphToken(token, claims.authority, ctx.scope, 701)).toThrow(GraphReadError);
    expect(() => verifyGraphToken(token, 'b'.repeat(64), ctx.scope, 101)).toThrow(GraphReadError);
    expect(() => verifyGraphToken(token, claims.authority, { ...ctx.scope, siteId: OTHER }, 101)).toThrow(GraphReadError);
  });
});


it('rejects malformed canonical IDs before authorization or SQL', async () => {
  await expect(getTopologyNode(ctx, 'presentation:overview:scope:group')).rejects.toMatchObject({ status: 400 });
  expect(mocks.permissions).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
});

it('revalidates live site ceilings before using a previously issued frontier', async () => {
  mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: '2' }]).mockResolvedValueOnce([{ count: '0' }]).mockResolvedValueOnce([node]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  const first = await getTopologyGraph(ctx, query);
  mocks.access.mockRejectedValueOnce(new GraphReadError('topology_site_not_found', 404, 'Not found'));
  mocks.execute.mockClear();
  await expect(expandTopologyGraph(ctx, first.frontier[0]!.token)).rejects.toMatchObject({ status: 404 });
  expect(mocks.execute).not.toHaveBeenCalled();
});

it('rejects a non-group canonical node and scopes the validation query', async () => {
  mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: NODE, kind: 'endpoint', role: null }]);
  await expect(getTopologyGroupMembers(ctx, NODE, query)).rejects.toMatchObject({ code: 'invalid_topology_group', status: 400 });
  const statement = sqlText(mocks.execute.mock.calls[2]!); expect(statement.params).toContain(ORG); expect(statement.params).toContain(SITE);
});

it('fails closed if authority generation changes during the live permission read', async () => {
  mocks.version.mockResolvedValueOnce('0:0').mockResolvedValueOnce('0:1');
  await expect(getTopologyGraph(ctx, query)).rejects.toMatchObject({ code: 'topology_authority_unavailable' });
  expect(mocks.execute).not.toHaveBeenCalled();
});

it('keeps canonical plus boundary edges within one cap and pages omitted boundary edges', async () => {
  const edges = ['1', '2', '3'].map((suffix) => ({ id: `40000000-0000-4000-8000-00000000000${suffix}`, sourceNodeId: NODE, targetNodeId: OTHER, remaining: '3' }));
  mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: '2' }]).mockResolvedValueOnce([{ count: '3' }]).mockResolvedValueOnce([node]).mockResolvedValueOnce([]).mockResolvedValueOnce(edges);
  const first = await getTopologyGraph(ctx, query);
  expect(first.relationships.length + first.presentation.edges.length).toBe(2);
  const cursor = first.frontier.find((item) => item.label === 'More boundary connections')!;
  expect(cursor.memberCount).toBe(1);
  mocks.execute.mockReset().mockResolvedValueOnce(state).mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: '2' }]).mockResolvedValueOnce([{ count: '3' }]).mockResolvedValueOnce([node]).mockResolvedValueOnce([{ ...edges[2], remaining: '1' }]);
  const next = await expandTopologyGraph(ctx, cursor.token);
  expect(next.presentation.edges).toHaveLength(1);
  expect(next.presentation.edges[0]!.contributingRelationshipIds).toEqual([edges[2]!.id]);
  expect(next.frontier.some((item) => item.label === 'More boundary connections')).toBe(false);
});
