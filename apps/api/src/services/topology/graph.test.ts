import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { graphResponseSchema } from '@breeze/shared';
import type { TopologyRequestContext } from './access';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), version: vi.fn(), access: vi.fn(), permissions: vi.fn(), flags: vi.fn(), exclusions: vi.fn(), coverage: vi.fn() }));
vi.mock('../../db', () => ({ db: { execute: mocks.execute, transaction: mocks.transaction } }));
vi.mock('../permissions', async (original) => ({ ...await original<object>(), getPermissionAuthorityVersion: mocks.version, getUserPermissions: mocks.permissions }));
vi.mock('./access', async (original) => ({ ...await original<object>(), requireTopologySiteAccess: mocks.access }));
vi.mock('./flags', async (original) => ({ ...await original<object>(), loadTopologyFlags: mocks.flags }));
vi.mock('./exclusions', async (original) => ({ ...await original<object>(), loadActiveExclusions: mocks.exclusions }));
vi.mock('./physicalCoverage', async (original) => ({ ...await original<object>(), readGraphCoverage: mocks.coverage }));
vi.mock('../secretCrypto', () => ({ getSecretDerivedKeyMaterials: () => ({ active: { key: Buffer.alloc(32, 7) }, retained: [{ key: Buffer.alloc(32, 7) }] }) }));
import { getTopologyGraph, listTopologyNodes, expandTopologyGraph, getTopologyRelationship, getTopologyRelationshipEvidence, getTopologyHealth, getTopologyLinkHealth, getTopologyNode, getTopologyGroupMembers } from './graph';
import { relationshipDetailResponseSchema, relationshipEvidenceResponseSchema, topologyLinkHealthResponseSchema } from '@breeze/shared';
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
const flagsOn = { materialization: true, ui: true, physical: true, interfaceHealth: false, diagnostics: false, ai: false };
const dialect = new PgDialect();
function sqlText(call: unknown[]) { return dialect.sqlToQuery(call[0] as Parameters<PgDialect['sqlToQuery']>[0]); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockReset();
  mocks.transaction.mockImplementation((fn) => fn({ execute: mocks.execute }));
  mocks.version.mockResolvedValue('0:0');
  mocks.permissions.mockResolvedValue(ctx.permissions);
  mocks.access.mockResolvedValue(ctx);
  mocks.flags.mockResolvedValue(flagsOn);
  mocks.exclusions.mockResolvedValue(new Set());
  mocks.coverage.mockResolvedValue({ state: 'limited', reasons: [{ code: 'legacy_evidence_only', message: 'Legacy only' }] });
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
    mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([{ id: NODE }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]); // bindings, policy health

    const health = await getTopologyHealth(ctx, { nodeIds: [NODE], relationshipIds: [] });

    expect(health.nodes[0]!.health).toMatchObject({ status: 'unknown', coverage: 'unmonitored', resultId: null });
    expect(health.nodes[0]!.health.reasons[0]!.code).toBe('no_monitor_binding');
  });

  describe('interface measurement health (M3 Task 6)', () => {
    const IF = 'b0000000-0000-4000-8000-000000000001';
    const SOURCE = 'c0000000-0000-4000-8000-000000000001';
    const physicalRel = { id: REL, kind: 'physical_link', evidenceClass: 'observed', sourceInterfaceId: IF, targetInterfaceId: null };
    const measurement = (operStatus: string, secondsAgo = 10) => ({ interface_id: IF, epoch: 'gen:1', retired: false, source_id: SOURCE, producer_kind: 'snmp',
      producer_epoch: 'p1', revoked: false, last_received_at: new Date(Date.now() - secondsAgo * 1000 + 500).toISOString(),
      sampled_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
      readings: { v: 1, expectedIntervalSeconds: 60, adminStatus: 'up', operStatus, counterWidth: 64, inOctets: '0', outOctets: '0' } });

    it('folds a fresh port-down into relationship health and exposes freshUntil, with zero writes or dispatch', async () => {
      mocks.flags.mockResolvedValue({ ...flagsOn, interfaceHealth: true });
      mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([{ id: REL }])
        .mockResolvedValueOnce([]) // monitor bindings
        .mockResolvedValueOnce([physicalRel]).mockResolvedValueOnce([measurement('down')])
        .mockResolvedValueOnce([]); // policy health
      const health = await getTopologyHealth(ctx, { nodeIds: [], relationshipIds: [REL] });
      expect(health.relationships[0]!.health).toMatchObject({ status: 'failed_check', freshness: 'fresh' });
      expect(health.relationships[0]!.health.reasons.map((r) => r.code)).toContain('interface_link_down');
      expect(Date.parse(health.freshUntil!)).toBeGreaterThan(Date.now());
      for (const call of mocks.execute.mock.calls) {
        const statement = sqlText(call).sql;
        expect(statement).not.toMatch(/\b(insert|update|delete)\b/i);
        expect(statement).not.toMatch(/device_commands/i);
      }
    });

    it('reads no interface measurement when the capability is off', async () => {
      mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([{ id: REL }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]); // bindings, policy health
      const health = await getTopologyHealth(ctx, { nodeIds: [], relationshipIds: [REL] });
      expect(health.relationships[0]!.health.status).toBe('unknown');
      expect(health.freshUntil).toBeNull();
      expect(mocks.execute.mock.calls.some((call) => /topology_interface_samples/.test(sqlText(call).sql))).toBe(false);
    });

    it('serves link health with each endpoint as its own view and never a summed rate', async () => {
      mocks.flags.mockResolvedValue({ ...flagsOn, interfaceHealth: true });
      const row = { id: REL, kind: 'physical_link', sourceNodeId: NODE, targetNodeId: OTHER, directness: 'direct', confidence: 'high', evidenceClass: 'observed',
        lifecycle: 'active', lastSupportedAt: null, supportCount: '1', legacy: false, sourceInterfaceId: IF, targetInterfaceId: null, method: 'lldp' };
      mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([row])
        .mockResolvedValueOnce([measurement('up'), measurement('up', 70)])
        .mockResolvedValueOnce([]) // monitor bindings
        .mockResolvedValueOnce([]); // policy health
      const link = await getTopologyLinkHealth(ctx, REL);
      expect(topologyLinkHealthResponseSchema.safeParse(link).success).toBe(true);
      expect(link).toMatchObject({ relationshipId: REL, interfaceEvidence: { applies: true, reason: null }, endpoints: { target: null } });
      expect(link.endpoints.source).toMatchObject({ interfaceId: IF, operStatus: 'up', sourceKind: 'snmp' });
      expect(link.health.scope).toBe('relationship');
    });

    it('hides link health for a gated physical relationship', async () => {
      mocks.flags.mockResolvedValue({ ...flagsOn, physical: false });
      mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([]);
      await expect(getTopologyLinkHealth(ctx, REL)).rejects.toMatchObject({ status: 404 });
    });
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

describe('M2 physical exposure, exclusions and detail (D9, D11, D17)', () => {
  const graphRows = () => mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ count: '2' }]).mockResolvedValueOnce([{ count: '0' }])
    .mockResolvedValueOnce([node]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  const relRow = { id: REL, kind: 'attachment', sourceNodeId: NODE, targetNodeId: OTHER, directness: 'unknown', confidence: 'low', evidenceClass: 'inferred',
    lifecycle: 'active', lastSupportedAt: null, supportCount: '1', legacy: false, method: 'fdb', sourceInterfaceId: null, targetInterfaceId: null, physical: null };

  it('gates collected physical rows and this view\'s exclusions in counts, rows and neighborhoods', async () => {
    mocks.flags.mockResolvedValue({ ...flagsOn, physical: false });
    mocks.exclusions.mockResolvedValue(new Set([REL]));
    graphRows();
    const graph = await getTopologyGraph(ctx, { ...query, view: 'overview' });
    expect(graphResponseSchema.safeParse(graph).success).toBe(true);
    // Read inside the graph's own FOR SHARE transaction, not the ambient db.
    expect(mocks.exclusions).toHaveBeenCalledWith(ctx.scope, 'overview', expect.objectContaining({ execute: mocks.execute }));
    expect(mocks.coverage).toHaveBeenCalledWith(expect.anything(), ctx.scope, 'overview', false);
    const relationshipCount = mocks.execute.mock.calls.map(sqlText).find((q) => /count\(\*\)::text AS count FROM topology_relationships r/i.test(q.sql))!;
    expect(relationshipCount.sql).toMatch(/->>'method'/);
    expect(relationshipCount.params).toContain(`{${REL}}`);
    const nodeCount = sqlText(mocks.execute.mock.calls[2]!);
    expect(nodeCount.sql).toMatch(/identity_material/);
  });

  it('does not gate or exclude anything when physical is exposed and nothing is hidden', async () => {
    graphRows();
    await getTopologyGraph(ctx, query);
    for (const call of mocks.execute.mock.calls) expect(sqlText(call).sql).not.toMatch(/->>'method'\), ''\) IN/);
  });

  it('folds the physical capability into cursor authority, so a toggle invalidates frontiers', async () => {
    graphRows();
    const first = await getTopologyGraph(ctx, query);
    expect(first.frontier.length).toBeGreaterThan(0);
    mocks.flags.mockResolvedValue({ ...flagsOn, physical: false });
    mocks.execute.mockReset();
    await expect(expandTopologyGraph(ctx, first.frontier[0]!.token)).rejects.toMatchObject({ code: 'invalid_topology_cursor', status: 400 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('returns 404 for a gated relationship detail, evidence and health', async () => {
    mocks.flags.mockResolvedValue({ ...flagsOn, physical: false });
    mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([]);
    await expect(getTopologyRelationship(ctx, REL)).rejects.toMatchObject({ status: 404 });
    expect(sqlText(mocks.execute.mock.calls[1]!).sql).toMatch(/->>'method'/);
    mocks.execute.mockReset().mockResolvedValueOnce(state).mockResolvedValueOnce([]);
    await expect(getTopologyRelationshipEvidence(ctx, REL, { limit: 50 })).rejects.toMatchObject({ status: 404 });
    expect(sqlText(mocks.execute.mock.calls[1]!).sql).toMatch(/->>'method'/);
    mocks.execute.mockReset().mockResolvedValueOnce(state).mockResolvedValueOnce([]);
    await expect(getTopologyHealth(ctx, { nodeIds: [], relationshipIds: [REL] })).rejects.toMatchObject({ status: 404 });
    expect(sqlText(mocks.execute.mock.calls[1]!).sql).toMatch(/->>'method'/);
  });

  it('serves relationship detail with exclusion state even when the view hides it', async () => {
    mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([relRow])
      .mockResolvedValueOnce([{ id: '90000000-0000-4000-8000-000000000001', view: 'overview', reason: 'Not a real cable', createdAt: '2026-09-26T10:00:00.000Z' }])
      .mockResolvedValueOnce([{ id: NODE, label: 'Switch' }, { id: OTHER, label: 'Desk' }])
      .mockResolvedValueOnce([]) // monitor bindings for the detail's health
      .mockResolvedValueOnce([]); // policy health
    const detail = await getTopologyRelationship(ctx, REL);
    expect(relationshipDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(detail.relationship.excluded).toBe(true);
    expect(detail.exclusions.map((e) => e.view)).toEqual(['overview']);
    expect(mocks.exclusions).not.toHaveBeenCalled();
  });

  it('pages evidence through a signed cursor bound to the relationship and graph revision', async () => {
    const obs = (n: number) => ({ id: `a0000000-0000-4000-8000-00000000000${n}`, method: 'fdb', evidenceClass: 'inferred', producerKind: 'discovery', protocol: 'fdb',
      observedAt: '2026-09-26T10:00:00.000Z', effectiveAt: '2026-09-26T10:00:00.000Z', receivedAt: `2026-09-26T10:0${n}:00.000Z`, freshUntil: '2999-01-01T00:00:00.000Z', withdrawnAt: null });
    mocks.execute.mockResolvedValueOnce(state).mockResolvedValueOnce([relRow]).mockResolvedValueOnce([obs(2), obs(1)]).mockResolvedValueOnce([]);
    const first = await getTopologyRelationshipEvidence(ctx, REL, { limit: 1 });
    expect(relationshipEvidenceResponseSchema.safeParse(first).success).toBe(true);
    expect(first.observations).toHaveLength(1);
    expect(first.cursor).toEqual(expect.any(String));
    mocks.execute.mockReset().mockResolvedValueOnce(state).mockResolvedValueOnce([relRow]).mockResolvedValueOnce([obs(1)]);
    const second = await getTopologyRelationshipEvidence(ctx, REL, { limit: 1, cursor: first.cursor! });
    expect(second.observations.map((o) => o.id)).toEqual([obs(1).id]);
    expect(second.cursor).toBeNull();
    await expect(getTopologyRelationshipEvidence(ctx, OTHER, { limit: 1, cursor: first.cursor! })).rejects.toMatchObject({ code: 'invalid_topology_cursor' });
    mocks.execute.mockReset().mockResolvedValueOnce([{ graph: '9007199254740994', health: '4' }]);
    await expect(getTopologyRelationshipEvidence(ctx, REL, { limit: 1, cursor: first.cursor! })).rejects.toMatchObject({ code: 'graph_revision_changed', status: 409 });
  });
});
