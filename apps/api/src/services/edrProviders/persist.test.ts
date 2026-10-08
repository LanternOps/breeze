import { describe, expect, it, vi } from 'vitest';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('./registry', () => ({
  getEdrProvider: () => ({ hostAllowlist: ['.gravityzone.bitdefender.com'] }),
}));

import {
  isDeadlockError,
  persistDetections,
  persistInventory,
  pruneMissingTenantEndpoints,
  refreshDetectionDeviceLinks,
  upsertTenants,
  type TenantFetch,
} from './persist';
import type { EdrDetectionPage, VendorEdrDetection, VendorEdrEndpoint } from './types';

const CONN = { id: '00000000-0000-4000-8000-0000000000c1', partnerId: '00000000-0000-4000-8000-0000000000a1', provider: 'bitdefender' };
const ORG = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222221';
const T2 = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-12-16T12:00:00Z');
const dialect = new PgDialect();

const render = (value: unknown): string => {
  if (value && typeof value === 'object' && 'queryChunks' in (value as object)) {
    const q = dialect.sqlToQuery(value as SQL);
    return `${q.sql} ${JSON.stringify(q.params)}`;
  }
  return JSON.stringify(value);
};

type Op = {
  kind: 'select' | 'insert' | 'update' | 'delete' | 'execute';
  table?: string;
  values?: unknown;
  conflict?: { target?: unknown; targetWhere?: unknown; set?: Record<string, unknown>; setWhere?: unknown };
  set?: Record<string, unknown>;
  where?: unknown;
  sql?: string;
};

/** Recording drizzle stand-in: selects/returning/execute are fed from queues. */
function makeTx(opts: { selects?: unknown[][]; returning?: unknown[][]; executes?: unknown[][] } = {}) {
  const selects = [...(opts.selects ?? [])];
  const returning = [...(opts.returning ?? [])];
  const executes = [...(opts.executes ?? [])];
  const ops: Op[] = [];
  const thenable = (op: Op, result: () => unknown) => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn((w: unknown) => { op.where = w; return chain; });
    chain.limit = vi.fn(() => chain);
    chain.values = vi.fn((v: unknown) => { op.values = v; return chain; });
    chain.set = vi.fn((s: Record<string, unknown>) => { op.set = s; return chain; });
    chain.onConflictDoUpdate = vi.fn((c: Op['conflict']) => { op.conflict = c; return chain; });
    chain.returning = vi.fn(() => chain);
    (chain as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(res, rej);
    return chain;
  };
  const tx = {
    select: vi.fn(() => { const op: Op = { kind: 'select' }; ops.push(op); return thenable(op, () => selects.shift() ?? []); }),
    insert: vi.fn((t: never) => { const op: Op = { kind: 'insert', table: getTableName(t) }; ops.push(op); return thenable(op, () => returning.shift() ?? []); }),
    update: vi.fn((t: never) => { const op: Op = { kind: 'update', table: getTableName(t) }; ops.push(op); return thenable(op, () => []); }),
    delete: vi.fn((t: never) => { const op: Op = { kind: 'delete', table: getTableName(t) }; ops.push(op); return thenable(op, () => []); }),
    execute: vi.fn((s: SQL) => { ops.push({ kind: 'execute', sql: render(s) }); return Promise.resolve(executes.shift() ?? []); }),
    transaction: vi.fn(async (fn: (inner: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { tx: tx as never, ops };
}

const endpoint = (id: string, over: Partial<VendorEdrEndpoint> = {}): VendorEdrEndpoint => ({
  vendorEndpointId: id, vendorTenantId: 'co1', hostname: 'WS-01', fqdn: 'ws-01.corp', serialNumber: null,
  macAddresses: [], ipAddresses: [], osPlatform: 'windows', osName: 'Windows 11', endpointType: 'workstation',
  agentVersion: '7.0', health: 'healthy', online: true, isolationState: 'not_isolated', tamperProtection: true,
  policyName: null, lastSeenAt: NOW, raw: {}, ...over,
});

const detection = (id: string, over: Partial<VendorEdrDetection> = {}): VendorEdrDetection => ({
  vendorDetectionId: id, vendorKind: 'incident', vendorTenantId: 'co1', vendorEndpointId: 'ep1',
  severity: 'high', vendorSeverity: 'high', status: 'open', vendorStatus: 'open', title: 't', category: null,
  threatName: null, filePath: null, processName: null, mitreTechniques: [], detectedAt: NOW, resolvedAt: null,
  lastVendorUpdateAt: NOW, details: {}, ...over,
});
const page = (detections: VendorEdrDetection[], over: Partial<EdrDetectionPage> = {}): EdrDetectionPage =>
  ({ detections, cursor: '2026-12-16T12:00:00.000Z', warnings: [], ...over });

describe('isDeadlockError', () => {
  it('matches SQLSTATE 40P01 directly and through err.cause', () => {
    expect(isDeadlockError({ code: '40P01' })).toBe(true);
    expect(isDeadlockError(new Error('wrapped', { cause: { code: '40P01' } }))).toBe(true);
    expect(isDeadlockError(new Error('a', { cause: new Error('b', { cause: { code: '40P01' } }) }))).toBe(true);
  });
  it('rejects other codes, plain errors and non-objects', () => {
    expect(isDeadlockError({ code: '23505' })).toBe(false);
    expect(isDeadlockError(new Error('boom'))).toBe(false);
    expect(isDeadlockError(null)).toBe(false);
    expect(isDeadlockError('40P01')).toBe(false);
    expect(isDeadlockError(undefined)).toBe(false);
  });
  it('terminates on a cyclic cause chain', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(isDeadlockError(a)).toBe(false);
  });
});

describe('upsertTenants', () => {
  const vt = (id: string, apiHost: string | null = null) => ({
    vendorTenantId: id, name: `Co ${id}`, parentId: 'root', tenantType: 'company', externalCode: null, apiHost,
  });

  it('upserts on (connection_id, vendor_tenant_id), clears the missing marker, and never touches the mapping', async () => {
    const { tx, ops } = makeTx({ selects: [[], [{ n: 0 }]] });
    await upsertTenants(tx, CONN, [vt('co1')], NOW);
    const insert = ops.find((o) => o.kind === 'insert')!;
    expect(insert.table).toBe('edr_tenants');
    expect(Object.keys(insert.conflict!.set!)).toEqual(expect.arrayContaining(['vendorTenantName', 'lastSeenAt', 'vendorMissingSince']));
    expect(Object.keys(insert.conflict!.set!)).not.toContain('orgId');
    expect(Object.keys(insert.conflict!.set!)).not.toContain('mappingSource');
    expect(render(insert.conflict!.set!.vendorMissingSince)).toContain('NULL');
  });

  it('tombstones tenants absent from the list (coalesce, never delete) and counts only newly missing ones', async () => {
    const { tx, ops } = makeTx({
      selects: [
        [
          { id: 'row-a', vendorTenantId: 'gone-new', vendorMissingSince: null },
          { id: 'row-b', vendorTenantId: 'gone-old', vendorMissingSince: new Date('2026-12-01T00:00:00Z') },
          { id: 'row-c', vendorTenantId: 'co1', vendorMissingSince: null },
        ],
        [{ n: 2 }],
      ],
    });
    const out = await upsertTenants(tx, CONN, [vt('co1')], NOW);
    expect(out).toEqual({ total: 1, unmapped: 2, newlyMissing: 1 });
    expect(ops.some((o) => o.kind === 'delete')).toBe(false);
    const tombstone = ops.find((o) => o.kind === 'update')!;
    expect(render(tombstone.set!.vendorMissingSince)).toContain('coalesce');
    expect(render(tombstone.where)).toContain('row-a');
    expect(render(tombstone.where)).toContain('row-b');
    expect(render(tombstone.where)).not.toContain('row-c');
  });

  it('stores an allowlisted api_host and refuses (NULL + error) one outside the allowlist or over http', async () => {
    const { tx, ops } = makeTx({ selects: [[], [{ n: 0 }]] });
    await upsertTenants(tx, CONN, [
      vt('ok', 'https://cloud.gravityzone.bitdefender.com'),
      vt('evil', 'https://cloud.gravityzone.bitdefender.com.evil.example'),
      vt('plain', 'http://cloud.gravityzone.bitdefender.com'),
    ], NOW);
    const rows = (ops.find((o) => o.kind === 'insert')!.values as Array<{ vendorTenantId: string; apiHost: string | null }>);
    expect(rows.find((r) => r.vendorTenantId === 'ok')!.apiHost).toBe('https://cloud.gravityzone.bitdefender.com');
    expect(rows.find((r) => r.vendorTenantId === 'evil')!.apiHost).toBeNull();
    expect(rows.find((r) => r.vendorTenantId === 'plain')!.apiHost).toBeNull();
    const errs = ops.filter((o) => o.kind === 'update');
    expect(errs).toHaveLength(2);
    for (const e of errs) {
      expect(String(e.set!.lastInventorySyncError)).toMatch(/api_host rejected/);
      expect(e.set!.lastInventorySyncStatus).toBe('error');
    }
  });
});

describe('persistInventory', () => {
  const tenantRows = [
    { id: T1, vendorTenantId: 'co1', orgId: ORG },
    { id: T2, vendorTenantId: 'co2', orgId: null },
  ];

  it('a FAILED tenant gets a status/error write only: no delete, no insert (Review Focus 1)', async () => {
    const { tx, ops } = makeTx({ selects: [tenantRows] });
    const out = await persistInventory(tx, CONN, [
      { vendorTenantId: 'co1', ok: false, error: 'page 2 failed', scope: 'tenant' },
    ], NOW);
    expect(out).toEqual({ endpoints: 0, failedTenants: 1 });
    expect(ops.filter((o) => o.kind === 'delete' || o.kind === 'insert')).toEqual([]);
    const update = ops.find((o) => o.kind === 'update')!;
    expect(update.set).toMatchObject({ lastInventorySyncStatus: 'error', lastInventorySyncError: 'page 2 failed' });
    expect(Object.keys(update.set!)).not.toContain('endpointCount');
  });

  it('an ok UNMAPPED tenant records the count only: endpoints are never stored (D5)', async () => {
    const { tx, ops } = makeTx({ selects: [tenantRows] });
    await persistInventory(tx, CONN, [
      { vendorTenantId: 'co2', ok: true, value: { endpoints: [endpoint('e1')], details: [], count: 42 } },
    ], NOW);
    expect(ops.filter((o) => o.kind === 'insert' || o.kind === 'delete')).toEqual([]);
    expect(ops.find((o) => o.kind === 'update')!.set).toMatchObject({ endpointCount: 42, lastInventorySyncStatus: 'success' });
  });

  it('an ok MAPPED tenant: org from the tenant row, cross-org rows deleted first, no org/tenant in DO UPDATE, stale ones pruned', async () => {
    const { tx, ops } = makeTx({
      selects: [tenantRows, [{ id: 'row-keep', vendorEndpointId: 'e1' }, { id: 'row-stale', vendorEndpointId: 'e-gone' }]],
    });
    const out = await persistInventory(tx, CONN, [
      { vendorTenantId: 'co1', ok: true, value: { endpoints: [endpoint('e1')], details: [{ vendorEndpointId: 'e1', health: 'degraded' }] } },
    ], NOW);
    expect(out).toEqual({ endpoints: 1, failedTenants: 0 });

    const kinds = ops.filter((o) => o.kind !== 'select').map((o) => `${o.kind}:${o.table ?? 'sql'}`);
    // cross-org delete -> upsert -> detail -> stale delete -> tenant counters -> detection backfill
    expect(kinds).toEqual([
      'delete:edr_endpoints', 'insert:edr_endpoints', 'update:edr_endpoints',
      'delete:edr_endpoints', 'update:edr_tenants', 'execute:sql',
    ]);
    const crossOrgDelete = ops.filter((o) => o.kind === 'delete')[0]!;
    expect(render(crossOrgDelete.where)).toContain('<>');

    const insert = ops.find((o) => o.kind === 'insert')!;
    const [row] = insert.values as Array<{ orgId: string; tenantId: string }>;
    expect(row).toMatchObject({ orgId: ORG, tenantId: T1 });
    expect(Object.keys(insert.conflict!.set!)).not.toContain('orgId');
    expect(Object.keys(insert.conflict!.set!)).not.toContain('tenantId');
    expect(Object.keys(insert.conflict!.set!)).not.toContain('breezeDeviceId');
    expect(render(insert.conflict!.setWhere)).toContain('org_id');

    const detail = ops.find((o) => o.kind === 'update' && o.table === 'edr_endpoints')!;
    expect(detail.set).toMatchObject({ health: 'degraded', vendorDetailSyncedAt: NOW });

    const staleDelete = ops.filter((o) => o.kind === 'delete')[1]!;
    expect(render(staleDelete.where)).toContain('row-stale');
    expect(render(staleDelete.where)).not.toContain('row-keep');

    expect(ops.find((o) => o.kind === 'execute')!.sql).toMatch(/SET endpoint_id = e\.id/);
  });

  it('a successful ZERO-endpoint fetch deletes the tenant\'s held endpoints (only a complete fetch can say "gone")', async () => {
    const { tx, ops } = makeTx({ selects: [tenantRows, [{ id: 'row-1', vendorEndpointId: 'e1' }]] });
    await persistInventory(tx, CONN, [{ vendorTenantId: 'co1', ok: true, value: { endpoints: [], details: [] } }], NOW);
    expect(render(ops.filter((o) => o.kind === 'delete').at(-1)!.where)).toContain('row-1');
  });
});

describe('persistDetections', () => {
  const tenantRows = [
    { id: T1, vendorTenantId: 'co1', orgId: ORG },
    { id: T2, vendorTenantId: 'co2', orgId: null },
  ];

  it('names the partial-index predicate in ON CONFLICT and never updates org_id/tenant_id', async () => {
    const { tx, ops } = makeTx({
      selects: [tenantRows, [{ id: 'ep-row', vendorEndpointId: 'ep1', breezeDeviceId: 'dev-1' }]],
      returning: [[{ id: 'd1' }, { id: 'd2' }]],
    });
    const out = await persistDetections(tx, CONN, [
      { vendorTenantId: 'co1', ok: true, value: page([detection('x1'), detection('x2')]) },
    ], NOW);
    expect(out).toEqual({ upserted: 2, failedTenants: 0, skipped: 0 });

    const insert = ops.find((o) => o.kind === 'insert')!;
    expect(insert.table).toBe('edr_detections');
    expect(render(insert.conflict!.targetWhere)).toContain('"detached_at" IS NULL');
    const setKeys = Object.keys(insert.conflict!.set!);
    for (const forbidden of ['orgId', 'tenantId', 'detachedAt', 'notifiedSeverity', 'lastSiteId']) {
      expect(setKeys).not.toContain(forbidden);
    }
    expect(render(insert.conflict!.setWhere)).toMatch(/tenant_id.*excluded\.tenant_id/);
    const [first] = insert.values as Array<Record<string, unknown>>;
    expect(first).toMatchObject({ orgId: ORG, tenantId: T1, endpointId: 'ep-row', breezeDeviceId: 'dev-1', provider: 'bitdefender' });
  });

  it('counts a conflict row owned by another tenant (filtered by the DO UPDATE WHERE) as skipped', async () => {
    const { tx } = makeTx({ selects: [tenantRows, []], returning: [[{ id: 'd1' }]] });
    const out = await persistDetections(tx, CONN, [
      { vendorTenantId: 'co1', ok: true, value: page([detection('x1'), detection('x2', { vendorEndpointId: null })]) },
    ], NOW);
    expect(out.upserted).toBe(1);
    expect(out.skipped).toBe(1);
  });

  it('advances only the ok tenant\'s cursor and recomputes its open count', async () => {
    const { tx, ops } = makeTx({ selects: [tenantRows, []], returning: [[{ id: 'd1' }]] });
    await persistDetections(tx, CONN, [{ vendorTenantId: 'co1', ok: true, value: page([detection('x1', { vendorEndpointId: null })]) }], NOW);
    const update = ops.find((o) => o.kind === 'update')!;
    expect(update.set).toMatchObject({ detectionCursor: '2026-12-16T12:00:00.000Z', lastDetectionSyncStatus: 'success', lastDetectionSyncError: null });
    expect(render(update.set!.openDetectionCount)).toContain('detached_at IS NULL');
    expect(render(update.where)).toContain(T1);
  });

  it('warnings mark the tenant partial', async () => {
    const { tx, ops } = makeTx({ selects: [tenantRows, []], returning: [[]] });
    await persistDetections(tx, CONN, [
      { vendorTenantId: 'co1', ok: true, value: page([detection('x1', { vendorEndpointId: null })], { warnings: ['incidents: API not enabled on key'] }) },
    ], NOW);
    expect(ops.find((o) => o.kind === 'update')!.set).toMatchObject({
      lastDetectionSyncStatus: 'partial', lastDetectionSyncError: 'incidents: API not enabled on key',
    });
  });

  it('a failed tenant writes status/error only: cursor untouched, no insert, no delete', async () => {
    const { tx, ops } = makeTx({ selects: [tenantRows] });
    const out = await persistDetections(tx, CONN, [
      { vendorTenantId: 'co1', ok: false, error: 'boom', scope: 'tenant' } satisfies TenantFetch<EdrDetectionPage>,
    ], NOW);
    expect(out.failedTenants).toBe(1);
    expect(ops.filter((o) => o.kind === 'insert' || o.kind === 'delete')).toEqual([]);
    const update = ops.find((o) => o.kind === 'update')!;
    expect(update.set).toMatchObject({ lastDetectionSyncStatus: 'error', lastDetectionSyncError: 'boom' });
    expect(Object.keys(update.set!)).not.toContain('detectionCursor');
  });

  it('drops a page for an unmapped tenant (detections never stored under no org)', async () => {
    const { tx, ops } = makeTx({ selects: [tenantRows] });
    await persistDetections(tx, CONN, [{ vendorTenantId: 'co2', ok: true, value: page([detection('x1')]) }], NOW);
    expect(ops.filter((o) => o.kind !== 'select')).toEqual([]);
  });

  it('never issues a DELETE against detections', async () => {
    const { tx, ops } = makeTx({ selects: [tenantRows, []], returning: [[{ id: 'd1' }]] });
    await persistDetections(tx, CONN, [{ vendorTenantId: 'co1', ok: true, value: page([detection('x1', { vendorEndpointId: null })]) }], NOW);
    expect(ops.some((o) => o.kind === 'delete')).toBe(false);
  });
});

describe('maintenance statements', () => {
  it('pruneMissingTenantEndpoints deletes only endpoints of tenants missing > 7 days and returns the count', async () => {
    const { tx, ops } = makeTx({ executes: [[{ id: 'a' }, { id: 'b' }]] });
    expect(await pruneMissingTenantEndpoints(tx, CONN.id, NOW)).toBe(2);
    const del = ops[0]!.sql!;
    expect(del).toMatch(/DELETE FROM edr_endpoints/);
    expect(del).toMatch(/vendor_missing_since < /);
    expect(del).toContain('2026-12-09T12:00:00.000Z');
  });

  it('pruneMissingTenantEndpoints with nothing to delete issues no counter reset', async () => {
    const { tx, ops } = makeTx();
    expect(await pruneMissingTenantEndpoints(tx, CONN.id, NOW)).toBe(0);
    expect(ops).toHaveLength(1);
  });

  it('refreshDetectionDeviceLinks re-points only live, open detections', async () => {
    const { tx, ops } = makeTx();
    await refreshDetectionDeviceLinks(tx, CONN.id);
    const s = ops[0]!.sql!;
    expect(s).toMatch(/d\.detached_at IS NULL/);
    expect(s).toMatch(/d\.status IN \('open', 'in_progress', 'unknown'\)/);
    expect(s).toMatch(/IS DISTINCT FROM e\.breeze_device_id/);
  });
});
