import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/** Records every table a statement touches, and resolves queued results in order. */
const mocks = vi.hoisted(() => ({
  results: [] as unknown[][], touched: [] as string[], writes: [] as { op: string; table: string; values?: unknown }[],
  flags: vi.fn(), write: vi.fn(), bump: vi.fn(), audit: vi.fn(), authority: vi.fn(),
}));
vi.mock('../../db', () => {
  const chain = (op: string) => {
    let table = '';
    const self: Record<string, unknown> = {};
    for (const name of ['select', 'from', 'where', 'for', 'limit', 'orderBy', 'innerJoin', 'set', 'values', 'onConflictDoNothing', 'returning']) {
      self[name] = (arg?: unknown) => {
        if ((name === 'from' || name === 'insert' || name === 'update') && arg) table = String((arg as Record<symbol, string>)[Symbol.for('drizzle:Name')] ?? '');
        if (name === 'set' || name === 'values') mocks.writes.push({ op, table, values: arg });
        return self;
      };
    }
    self.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      mocks.touched.push(`${op}:${table}`);
      return Promise.resolve(mocks.results.shift() ?? []).then(resolve, reject);
    };
    return { self, setTable: (t: unknown) => { table = String((t as Record<symbol, string>)[Symbol.for('drizzle:Name')] ?? ''); } };
  };
  const start = (op: string) => (arg?: unknown) => { const c = chain(op); if (arg) c.setTable(arg); return c.self; };
  return { db: { select: start('select'), insert: start('insert'), update: start('update'), delete: start('delete'), execute: vi.fn(async () => { mocks.touched.push('execute'); return mocks.results.shift() ?? []; }) } };
});
vi.mock('./flags', () => ({ loadTopologyFlags: mocks.flags }));
vi.mock('./graphCursor', async (original) => ({ ...await original<object>(), graphAuthority: mocks.authority }));
vi.mock('./writes', async (original) => ({ ...await original<object>(),
  withTopologyWrite: mocks.write, bumpStructuralRevision: mocks.bump, auditTopologyWrite: mocks.audit }));

import { createViewExclusion, revokeViewExclusion, listViewExclusions, loadActiveExclusions, createViewExclusionSchema, issueExclusionCursor, verifyExclusionCursor } from './exclusions';
import type { TopologyRequestContext } from './access';

const ORG = '10000000-0000-4000-8000-000000000001'; const SITE = '20000000-0000-4000-8000-000000000001';
const REL = '40000000-0000-4000-8000-000000000001'; const EXC = '50000000-0000-4000-8000-000000000001'; const USER = '60000000-0000-4000-8000-000000000001';
const ctx = { scope: { orgId: ORG, siteId: SITE }, auth: { user: { id: USER, email: 'u@example.com' } } } as unknown as TopologyRequestContext;
const on = { materialization: true, ui: true, physical: true, interfaceHealth: false, diagnostics: false, ai: false };
const exclusion = (over: Record<string, unknown> = {}) => ({ id: EXC, orgId: ORG, siteId: SITE, relationshipId: REL, view: 'physical', reason: 'Awaiting port check', createdBy: USER, revokedAt: null, revokedBy: null, createdAt: new Date('2026-09-26T00:00:00Z'), updatedAt: new Date('2026-09-26T00:00:00Z'), ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.results = []; mocks.touched = []; mocks.writes = [];
  mocks.flags.mockResolvedValue(on);
  mocks.write.mockImplementation(async (_ctx: unknown, _ready: boolean, work: () => Promise<unknown>) => work());
  mocks.bump.mockResolvedValue(12n);
  mocks.authority.mockResolvedValue({ digest: 'a'.repeat(64), canEdit: true });
});

const noSideEffects = () => {
  // Exclusions are presentation state: never evidence, support, alert, monitor or command rows.
  for (const entry of [...mocks.touched, ...mocks.writes.map(w => `${w.op}:${w.table}`)]) {
    expect(entry).not.toMatch(/support|observation|alert|monitor|command|collection|outbox|network_topology/);
  }
};

describe('view exclusion input', () => {
  it('bounds the reason and view', () => {
    expect(createViewExclusionSchema.parse({ view: 'physical', reason: '  Awaiting port check ' })).toEqual({ view: 'physical', reason: 'Awaiting port check' });
    for (const bad of [{ view: 'physical', reason: '' }, { view: 'physical', reason: '   ' }, { view: 'physical', reason: 'x'.repeat(501) }, { view: 'schematic', reason: 'x' }, { view: 'physical', reason: 'x', orgId: ORG }]) {
      expect(createViewExclusionSchema.safeParse(bad).success).toBe(false);
    }
    expect(createViewExclusionSchema.safeParse({ view: 'logical', reason: 'x'.repeat(500) }).success).toBe(true);
  });
});

describe('createViewExclusion', () => {
  it('hides one scoped relationship in one view, bumps the graph revision and audits', async () => {
    mocks.results = [[{ id: REL }], [exclusion()]];
    const result = await createViewExclusion(ctx, REL, { view: 'physical', reason: 'Awaiting port check' });
    expect(result).toMatchObject({ id: EXC, relationshipId: REL, view: 'physical', reason: 'Awaiting port check', active: true, graphRevision: '12' });
    expect(mocks.write).toHaveBeenCalledWith(ctx, true, expect.any(Function));
    expect(mocks.bump).toHaveBeenCalledWith(ctx.scope);
    expect(mocks.audit).toHaveBeenCalledWith(ctx, 'exclusion.created', EXC, expect.objectContaining({ relationshipId: REL, view: 'physical' }));
    expect(mocks.writes.find(w => w.op === 'insert')!.values).toMatchObject({ orgId: ORG, siteId: SITE, relationshipId: REL, view: 'physical', createdBy: USER });
    noSideEffects();
  });
  it('returns 404 for a relationship outside the site', async () => {
    mocks.results = [[]];
    await expect(createViewExclusion(ctx, REL, { view: 'overview', reason: 'x' })).rejects.toMatchObject({ status: 404, code: 'topology_entity_not_found' });
    expect(mocks.bump).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('returns 409 when the relationship is already hidden in that view', async () => {
    mocks.results = [[{ id: REL }], []];
    await expect(createViewExclusion(ctx, REL, { view: 'overview', reason: 'x' })).rejects.toMatchObject({ status: 409, code: 'topology_exclusion_exists' });
    expect(mocks.bump).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('rejects invalid ids and bodies before any SQL', async () => {
    await expect(createViewExclusion(ctx, 'presentation:edge', { view: 'overview', reason: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(createViewExclusion(ctx, REL, { view: 'overview', reason: '' })).rejects.toMatchObject({ status: 400 });
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.touched).toEqual([]);
  });
  it('refuses a physical exclusion while the physical view is not deployed', async () => {
    mocks.flags.mockResolvedValue({ ...on, physical: false });
    await expect(createViewExclusion(ctx, REL, { view: 'physical', reason: 'x' })).rejects.toMatchObject({ status: 409, code: 'topology_physical_disabled' });
    expect(mocks.write).not.toHaveBeenCalled();
  });
});

describe('revokeViewExclusion', () => {
  it('revokes only the selected exclusion as reversible history', async () => {
    mocks.results = [[exclusion()], [exclusion({ revokedAt: new Date('2026-09-26T01:00:00Z'), revokedBy: USER })]];
    const result = await revokeViewExclusion(ctx, REL, EXC);
    expect(result).toMatchObject({ id: EXC, active: false, graphRevision: '12' });
    const update = mocks.writes.find(w => w.op === 'update')!;
    expect(update.table).toBe('topology_view_exclusions');
    expect(update.values).toMatchObject({ revokedBy: USER });
    expect(mocks.touched.some(t => t.startsWith('delete'))).toBe(false);
    expect(mocks.audit).toHaveBeenCalledWith(ctx, 'exclusion.revoked', EXC, expect.objectContaining({ relationshipId: REL, view: 'physical' }));
    noSideEffects();
  });
  it('returns 404 for a missing or foreign exclusion and 409 when it is already restored', async () => {
    mocks.results = [[]];
    await expect(revokeViewExclusion(ctx, REL, EXC)).rejects.toMatchObject({ status: 404 });
    mocks.results = [[exclusion({ revokedAt: new Date() })]];
    await expect(revokeViewExclusion(ctx, REL, EXC)).rejects.toMatchObject({ status: 409, code: 'topology_exclusion_not_active' });
    expect(mocks.bump).not.toHaveBeenCalled();
  });
});

describe('exclusion listing cursor', () => {
  const claims = { orgId: ORG, siteId: SITE, authority: 'a'.repeat(64), graphRevision: '12', view: 'physical' as const, after: EXC };
  it('round-trips and binds authority, scope and view', () => {
    const token = issueExclusionCursor(claims);
    expect(verifyExclusionCursor(token, 'a'.repeat(64), { orgId: ORG, siteId: SITE })).toMatchObject({ after: EXC, view: 'physical', graphRevision: '12' });
    expect(() => verifyExclusionCursor(token, 'b'.repeat(64), { orgId: ORG, siteId: SITE })).toThrow();
    expect(() => verifyExclusionCursor(token, 'a'.repeat(64), { orgId: ORG, siteId: REL })).toThrow();
    expect(() => verifyExclusionCursor(`${token.slice(0, -2)}xx`, 'a'.repeat(64), { orgId: ORG, siteId: SITE })).toThrow();
  });
  it('pages by id with a revision-bound cursor', async () => {
    const row = (id: string) => ({ ...exclusion({ id }), relationship: { id: REL, kind: 'physical_link', sourceNodeId: REL, targetNodeId: REL, sourceInterfaceId: null, targetInterfaceId: null, evidenceClass: 'observed', lifecycle: 'active' } });
    const ids = ['50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002'];
    mocks.results = [[{ graph: '12' }], ids.map(row)];
    const page = await listViewExclusions(ctx, { view: 'physical', limit: 1 });
    expect(page.items.map(i => i.id)).toEqual([ids[0]]);
    expect(page).toMatchObject({ view: 'physical', graphRevision: '12' });
    expect(page.nextCursor).toEqual(expect.any(String));
    mocks.results = [[{ graph: '13' }]];
    await expect(listViewExclusions(ctx, { view: 'physical', limit: 1, cursor: page.nextCursor! })).rejects.toMatchObject({ status: 409, code: 'graph_revision_changed' });
    mocks.results = [[{ graph: '12' }]];
    await expect(listViewExclusions(ctx, { view: 'overview', limit: 1, cursor: page.nextCursor! })).rejects.toMatchObject({ status: 400 });
    noSideEffects();
  });
  it('rejects unbounded limits and unknown views', async () => {
    await expect(listViewExclusions(ctx, { view: 'physical', limit: 201 })).rejects.toMatchObject({ status: 400 });
    await expect(listViewExclusions(ctx, { view: 'schematic' as 'physical' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('loadActiveExclusions', () => {
  it('returns the active relationship ids of one view in one scoped, read-only statement', async () => {
    mocks.results = [[{ relationshipId: REL }, { relationshipId: EXC }]];
    expect(await loadActiveExclusions({ orgId: ORG, siteId: SITE }, 'overview')).toEqual(new Set([REL, EXC]));
    expect(mocks.touched).toEqual(['execute']);
  });
  it('reads through the caller transaction when one is passed (graph FOR SHARE snapshot)', async () => {
    const execute = vi.fn().mockResolvedValue([{ relationshipId: REL }]);
    expect(await loadActiveExclusions({ orgId: ORG, siteId: SITE }, 'physical', { execute })).toEqual(new Set([REL]));
    expect(mocks.touched).toEqual([]);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toMatch(/topology_view_exclusions/);
    expect(query.sql).toMatch(/revoked_at IS NULL/i);
    expect(query.sql).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(query.params).toEqual(expect.arrayContaining([ORG, SITE, 'physical']));
  });
  it('fails closed rather than silently dropping exclusions past its bound', async () => {
    const execute = vi.fn().mockResolvedValue(Array.from({ length: 10_001 }, (_, i) => ({ relationshipId: `${i}` })));
    await expect(loadActiveExclusions({ orgId: ORG, siteId: SITE }, 'overview', { execute })).rejects.toMatchObject({ status: 503, code: 'topology_exclusion_limit' });
  });
});

// Keep drizzle's table naming honest in this mock (a renamed table would silently pass noSideEffects).
it('mock resolves drizzle table names', async () => {
  const { topologyViewExclusions } = await import('../../db/schema');
  expect(getTableName(topologyViewExclusions)).toBe('topology_view_exclusions');
});
