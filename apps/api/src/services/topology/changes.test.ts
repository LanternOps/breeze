import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { topologyChangePageSchema } from '@breeze/shared';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), authority: vi.fn(), insert: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock('../../db', () => ({ db: { transaction: mocks.transaction, insert: mocks.insert, update: mocks.update, delete: mocks.remove } }));
vi.mock('./graphCursor', async (original) => ({ ...await original<object>(), graphAuthority: mocks.authority }));
vi.mock('../secretCrypto', () => ({ getSecretDerivedKeyMaterials: () => ({ active: { key: Buffer.alloc(32, 7) }, retained: [{ key: Buffer.alloc(32, 7) }] }) }));
import { getRecentTopologyChanges, presentTopologyChange, type ChangeRow } from './changes';
import { GraphReadError } from './graphCursor';

const ORG = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const REL = '40000000-0000-4000-8000-000000000001';
const SRC = '60000000-0000-4000-8000-000000000001';
const ctx = { scope: { orgId: ORG, siteId: SITE }, auth: { user: { id: 'u' } }, permissions: {} } as never;
const dialect = new PgDialect();
const text = (query: SQL) => dialect.sqlToQuery(query);
const now = Date.now();
const since = new Date(now - 3_600_000).toISOString();
const until = new Date(now).toISOString();

function row(n: number): ChangeRow {
  const at = new Date(now - n * 1000);
  return { atKey: `${at.toISOString().slice(0, 23)}123Z`, at, id: `relationship_observed:${REL}:${SRC}:${n}`, kind: 'relationship_observed', category: 'attachment',
    subjectKind: 'relationship', subjectId: REL, evidenceIds: [REL, SRC], detail: n % 2 ? 'expired' : 'available',
    attrs: { relationshipKind: 'attachment', method: 'fdb', evidenceClass: 'inferred', producerKind: 'discovery', protocol: 'fdb', payload: { secret: 'x' } } };
}
let graphRevision = '7';
let rows: ChangeRow[] = [];
const statements: { sql: string; params: unknown[] }[] = [];

beforeEach(() => {
  vi.clearAllMocks(); statements.length = 0; graphRevision = '7'; rows = [];
  mocks.authority.mockResolvedValue({ digest: 'a'.repeat(64), physical: true, interfaceHealth: true, canEdit: false });
  mocks.execute.mockImplementation(async (query: SQL) => {
    const compiled = text(query); statements.push(compiled);
    return /topology_site_state/.test(compiled.sql) ? [{ graph: graphRevision }] : rows;
  });
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ execute: mocks.execute }));
});

describe('getRecentTopologyChanges', () => {
  it.each([
    ['a window over 24 hours', { since: new Date(now - 25 * 3_600_000).toISOString(), until }],
    ['an inverted window', { since: until, until: since }],
    ['a limit over 200', { since, until, limit: 201 }],
    ['a malformed time', { since: 'yesterday', until }],
  ])('rejects %s before reading', async (_label, query) => {
    await expect(getRecentTopologyChanges(ctx, query as never)).rejects.toMatchObject({ status: 400 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('serves a typed, bounded page with a signed continuation, and only reads', async () => {
    rows = [row(1), row(2), row(3)];
    const page = await getRecentTopologyChanges(ctx, { since, until, limit: 2 });
    expect(topologyChangePageSchema.parse(page)).toBeTruthy();
    expect(page.changes).toHaveLength(2);
    expect(page.changes[1]).toMatchObject({ detail: 'available', attributes: { relationshipKind: 'attachment', method: 'fdb' } });
    expect(page.changes[0]!.attributes).not.toHaveProperty('payload');
    expect(page.cursor).toEqual(expect.any(String));
    for (const statement of statements) {
      expect(statement.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
      // Change history is canonical: per-view exclusions never filter it.
      expect(statement.sql).not.toMatch(/topology_view_exclusions/);
    }
    expect([mocks.insert, mocks.update, mocks.remove].every((fn) => fn.mock.calls.length === 0)).toBe(true);

    rows = [row(3)];
    statements.length = 0;
    const next = await getRecentTopologyChanges(ctx, { since, until, limit: 2, cursor: page.cursor! });
    expect(next.cursor).toBeNull();
    // The keyset continues strictly after the last row served, at full timestamp precision.
    expect(statements.some((s) => s.params.includes(row(2).atKey) && s.params.includes(row(2).id))).toBe(true);
  });

  it('binds the cursor to the window, limit, authority and graph revision', async () => {
    rows = [row(1), row(2)];
    const { cursor } = await getRecentTopologyChanges(ctx, { since, until, limit: 1 });
    await expect(getRecentTopologyChanges(ctx, { since, until: new Date(now - 1000).toISOString(), limit: 1, cursor: cursor! })).rejects.toMatchObject({ status: 400, code: 'invalid_topology_cursor' });
    await expect(getRecentTopologyChanges(ctx, { since, until, limit: 2, cursor: cursor! })).rejects.toMatchObject({ status: 400 });
    await expect(getRecentTopologyChanges(ctx, { since, until, limit: 1, cursor: `${cursor!.slice(0, -2)}xx` })).rejects.toBeInstanceOf(GraphReadError);
    mocks.authority.mockResolvedValue({ digest: 'b'.repeat(64), physical: true, interfaceHealth: true, canEdit: false });
    await expect(getRecentTopologyChanges(ctx, { since, until, limit: 1, cursor: cursor! })).rejects.toMatchObject({ status: 400 });
    mocks.authority.mockResolvedValue({ digest: 'a'.repeat(64), physical: true, interfaceHealth: true, canEdit: false });
    graphRevision = '8';
    await expect(getRecentTopologyChanges(ctx, { since, until, limit: 1, cursor: cursor! })).rejects.toMatchObject({ status: 409, code: 'graph_revision_changed' });
  });

  it('labels windows whose detail has aged out of retention', async () => {
    const old = { since: new Date(now - 40 * 86_400_000).toISOString(), until: new Date(now - 39 * 86_400_000).toISOString() };
    const page = await getRecentTopologyChanges(ctx, old);
    expect(page.reasons).toEqual(expect.arrayContaining(['observation_detail_expired', 'change_outbox_detail_expired']));
  });

  it('hides physical-collector and telemetry sources when those capabilities are off', async () => {
    mocks.authority.mockResolvedValue({ digest: 'a'.repeat(64), physical: false, interfaceHealth: false, canEdit: false });
    await getRecentTopologyChanges(ctx, { since, until });
    const changesSql = statements.find((s) => /UNION ALL/.test(s.sql))!.sql;
    expect(changesSql).toMatch(/producer_kind = 'agent'/);
    expect(changesSql).toMatch(/protocol <> 'if_metrics'/);
  });
});

describe('presentTopologyChange', () => {
  it('keeps only typed attributes and bounds strings', () => {
    const change = presentTopologyChange({ ...row(1), attrs: { method: 'x'.repeat(100), unknown: 1, observedRoutedPath: true, sourceNodeId: 'not-a-uuid' } });
    expect(change.attributes).toEqual({ method: 'x'.repeat(32), observedRoutedPath: true });
  });
});
