import { describe, expect, it, vi } from 'vitest';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  autoMapEdrTenants,
  listNameSuggestions,
  remapEdrTenant,
  RemapEdrTenantError,
} from './mapping';

const PARTNER = '00000000-0000-4000-8000-0000000000a1';
const OTHER_PARTNER = '00000000-0000-4000-8000-0000000000a2';
const CONN = { id: '00000000-0000-4000-8000-0000000000c1', partnerId: PARTNER, provider: 'bitdefender' };
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const actor = { partnerId: PARTNER, userId: null };
const dialect = new PgDialect();
const render = (value: unknown): string => {
  const q = dialect.sqlToQuery(value as SQL);
  return `${q.sql} ${JSON.stringify(q.params)}`;
};

type Op = { kind: string; table?: string; set?: Record<string, unknown>; where?: unknown; locked?: boolean; sql?: string };

function makeTx(opts: { selects?: unknown[][]; updates?: unknown[][]; deletes?: unknown[][]; executes?: unknown[][] } = {}) {
  const selects = [...(opts.selects ?? [])];
  const updates = [...(opts.updates ?? [])];
  const deletes = [...(opts.deletes ?? [])];
  const executes = [...(opts.executes ?? [])];
  const ops: Op[] = [];
  const chainFor = (op: Op, result: () => unknown) => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn((w: unknown) => { op.where = w; return chain; });
    chain.set = vi.fn((s: Record<string, unknown>) => { op.set = s; return chain; });
    chain.for = vi.fn(() => { op.locked = true; return chain; });
    chain.limit = vi.fn(() => chain);
    chain.returning = vi.fn(() => chain);
    (chain as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(res, rej);
    return chain;
  };
  const tx = {
    select: vi.fn(() => { const op: Op = { kind: 'select' }; ops.push(op); return chainFor(op, () => selects.shift() ?? []); }),
    update: vi.fn((t: never) => { const op: Op = { kind: 'update', table: getTableName(t) }; ops.push(op); return chainFor(op, () => updates.shift() ?? []); }),
    delete: vi.fn((t: never) => { const op: Op = { kind: 'delete', table: getTableName(t) }; ops.push(op); return chainFor(op, () => deletes.shift() ?? []); }),
    execute: vi.fn((s: SQL) => { ops.push({ kind: 'execute', sql: render(s) }); return Promise.resolve(executes.shift() ?? []); }),
    transaction: vi.fn(),
  };
  return { tx: tx as never, ops };
}

describe('remapEdrTenant', () => {
  const tenantRow = (over: Record<string, unknown> = {}) => ({ id: TENANT, partnerId: PARTNER, orgId: ORG_A, ...over });
  const orgRow = (over: Record<string, unknown> = {}) => ({ id: ORG_B, partnerId: PARTNER, type: 'customer', ...over });

  it('detaches detections and actions, deletes endpoints, THEN moves the tenant (statement order)', async () => {
    const { tx, ops } = makeTx({
      selects: [[tenantRow()], [orgRow()]],
      updates: [[{ id: 'd1' }, { id: 'd2' }], [{ id: 'a1' }], []],
      deletes: [[{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]],
    });
    const out = await remapEdrTenant(tx, actor, TENANT, ORG_B);
    expect(out).toEqual({
      tenantId: TENANT, previousOrgId: ORG_A, orgId: ORG_B,
      endpointsDeleted: 3, detectionsDetached: 2, actionsDetached: 1,
    });

    expect(ops.filter((o) => o.kind !== 'select').map((o) => `${o.kind}:${o.table}`)).toEqual([
      'update:edr_detections', 'update:edr_actions', 'delete:edr_endpoints', 'update:edr_tenants',
    ]);

    const [detections, actions, , tenant] = ops.filter((o) => o.kind !== 'select');
    for (const op of [detections!, actions!]) {
      expect(op.set).toMatchObject({ tenantId: null, endpointId: null });
      expect(op.set!.detachedAt).toBeInstanceOf(Date);
      expect(render(op.where)).toContain('"detached_at" is null');
    }
    expect(tenant!.set).toMatchObject({
      orgId: ORG_B, mappingSource: 'manual', detectionCursor: null, openDetectionCount: 0, endpointCount: 0,
    });
  });

  it('locks the tenant row FOR UPDATE', async () => {
    const { tx, ops } = makeTx({ selects: [[tenantRow()], [orgRow()]] });
    await remapEdrTenant(tx, actor, TENANT, ORG_B);
    expect(ops[0]!.locked).toBe(true);
  });

  it('un-mapping (org -> NULL) also tombstones, and records manual_unmapped', async () => {
    const { tx, ops } = makeTx({ selects: [[tenantRow()]], updates: [[{ id: 'd1' }], [], []] });
    const out = await remapEdrTenant(tx, actor, TENANT, null);
    expect(out.orgId).toBeNull();
    expect(out.detectionsDetached).toBe(1);
    expect(ops.at(-1)!.set).toMatchObject({ orgId: null, mappingSource: 'manual_unmapped' });
    expect(ops.filter((o) => o.kind === 'select')).toHaveLength(1); // no org lookup for NULL
  });

  it('same org is a no-op except confirming the mapping source (no detach, no delete)', async () => {
    const { tx, ops } = makeTx({ selects: [[tenantRow()], [orgRow({ id: ORG_A })]] });
    const out = await remapEdrTenant(tx, actor, TENANT, ORG_A);
    expect(out).toMatchObject({ endpointsDeleted: 0, detectionsDetached: 0, actionsDetached: 0 });
    const writes = ops.filter((o) => o.kind !== 'select');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: 'update', table: 'edr_tenants' });
    expect(Object.keys(writes[0]!.set!).sort()).toEqual(['mappingSource', 'updatedAt']);
    expect(writes[0]!.set!.mappingSource).toBe('manual');
  });

  it('refuses the holding org and writes nothing', async () => {
    const { tx, ops } = makeTx({ selects: [[tenantRow()], [orgRow({ type: 'unassigned_pool' })]] });
    await expect(remapEdrTenant(tx, actor, TENANT, ORG_B)).rejects.toMatchObject({ code: 'HOLDING_ORG' });
    expect(ops.filter((o) => o.kind !== 'select')).toEqual([]);
  });

  it('refuses an org of another partner', async () => {
    const { tx, ops } = makeTx({ selects: [[tenantRow()], [orgRow({ partnerId: OTHER_PARTNER })]] });
    await expect(remapEdrTenant(tx, actor, TENANT, ORG_B)).rejects.toMatchObject({ code: 'ORG_NOT_IN_PARTNER' });
    expect(ops.filter((o) => o.kind !== 'select')).toEqual([]);
  });

  it('refuses a nonexistent org', async () => {
    const { tx } = makeTx({ selects: [[tenantRow()], []] });
    await expect(remapEdrTenant(tx, actor, TENANT, ORG_B)).rejects.toMatchObject({ code: 'ORG_NOT_IN_PARTNER' });
  });

  it('a tenant of another partner reads as NOT_FOUND (even when RLS did not hide it)', async () => {
    const { tx, ops } = makeTx({ selects: [[tenantRow({ partnerId: OTHER_PARTNER })]] });
    const err = await remapEdrTenant(tx, actor, TENANT, ORG_B).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemapEdrTenantError);
    expect(err).toMatchObject({ code: 'NOT_FOUND' });
    expect(ops.filter((o) => o.kind !== 'select')).toEqual([]);
  });

  it('a missing tenant is NOT_FOUND', async () => {
    const { tx } = makeTx({ selects: [[]] });
    await expect(remapEdrTenant(tx, actor, TENANT, ORG_B)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('autoMapEdrTenants', () => {
  const tenants = [
    { id: 't-code', vendorName: 'Acme', vendorExternalCode: ORG_A },
    { id: 't-name', vendorName: 'Beta Corp', vendorExternalCode: null },
  ];
  const orgs = [{ id: ORG_A, name: 'Acme Ltd' }, { id: ORG_B, name: 'beta corp' }];

  it('maps by external code only, in one guarded UPDATE, and returns name matches as suggestions', async () => {
    const { tx, ops } = makeTx({ selects: [tenants, orgs], executes: [[{ id: 't-code' }]] });
    const out = await autoMapEdrTenants(tx, CONN);
    expect(out.mapped).toBe(1);
    expect(out.suggestions).toEqual([{ tenantId: 't-name', orgId: ORG_B }]);

    const update = ops.find((o) => o.kind === 'execute')!.sql!;
    expect(update).toContain('auto_external_code');
    expect(update).toMatch(/t\.mapping_source IS NULL/);
    expect(update).toContain(ORG_A);
    expect(update).not.toContain(ORG_B); // the name match is never written
  });

  it('eligibility is mapping_source IS NULL and the org candidates exclude hidden and holding orgs', async () => {
    const { tx, ops } = makeTx({ selects: [tenants, orgs], executes: [[]] });
    await autoMapEdrTenants(tx, CONN);
    const [tenantQuery, orgQuery] = ops.filter((o) => o.kind === 'select');
    expect(render(tenantQuery!.where)).toContain('"mapping_source" is null');
    const orgText = render(orgQuery!.where);
    expect(orgText).toContain('"partner_id"');
    expect(orgText).toContain('"type" not in');
    expect(orgText).toContain("<> 'unassigned_pool'");
  });

  it('does nothing (no org query, no write) when every tenant is already decided', async () => {
    const { tx, ops } = makeTx({ selects: [[]] });
    expect(await autoMapEdrTenants(tx, CONN)).toEqual({ mapped: 0, suggestions: [] });
    expect(ops.filter((o) => o.kind === 'select')).toHaveLength(1);
    expect(ops.some((o) => o.kind === 'execute')).toBe(false);
  });

  it('with only name matches it writes nothing', async () => {
    const { tx, ops } = makeTx({ selects: [[tenants[1]], orgs] });
    const out = await autoMapEdrTenants(tx, CONN);
    expect(out.mapped).toBe(0);
    expect(out.suggestions).toHaveLength(1);
    expect(ops.some((o) => o.kind === 'execute')).toBe(false);
  });
});

describe('listNameSuggestions', () => {
  it('returns [] for a connection without tenants', async () => {
    const { tx } = makeTx({ selects: [[]] });
    expect(await listNameSuggestions(tx, CONN.id)).toEqual([]);
  });

  it('suggests name matches but not for an org an external code already claims', async () => {
    const { tx } = makeTx({
      selects: [
        [{ partnerId: PARTNER }],
        [
          { id: 't-code', vendorName: 'Acme', vendorExternalCode: ORG_A },
          { id: 't-name', vendorName: 'acme ltd', vendorExternalCode: null },
        ],
        [{ id: ORG_A, name: 'Acme Ltd' }],
      ],
    });
    expect(await listNameSuggestions(tx, CONN.id)).toEqual([]);
  });
});
