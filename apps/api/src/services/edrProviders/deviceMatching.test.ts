import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../externalDeviceMatching', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../externalDeviceMatching')>()),
  loadCandidateDevices: vi.fn(),
}));

import { loadCandidateDevices } from '../externalDeviceMatching';
import { endpointMatchName, matchEdrEndpoints, strictMatchingFor } from './deviceMatching';
import { bitdefenderAdapter } from './bitdefender/adapter';
import { emsisoftAdapter } from './emsisoft/adapter';

const CONN = '00000000-0000-4000-8000-0000000000c1';
const ORG = '11111111-1111-4111-8111-111111111111';
const dialect = new PgDialect();
const render = (value: unknown): string => {
  const q = dialect.sqlToQuery(value as SQL);
  return `${q.sql} ${JSON.stringify(q.params)}`;
};

type Op = { kind: string; table?: string; set?: Record<string, unknown>; where?: unknown; sql?: string };

function makeTx(opts: { selects: unknown[][]; executeError?: unknown }) {
  const selects = [...opts.selects];
  const ops: Op[] = [];
  const chainFor = (op: Op, result: () => unknown) => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn((w: unknown) => { op.where = w; return chain; });
    chain.set = vi.fn((s: Record<string, unknown>) => { op.set = s; return chain; });
    (chain as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(res, rej);
    return chain;
  };
  const tx = {
    select: vi.fn(() => { const op: Op = { kind: 'select' }; ops.push(op); return chainFor(op, () => selects.shift() ?? []); }),
    update: vi.fn((t: never) => { const op: Op = { kind: 'update', table: getTableName(t) }; ops.push(op); return chainFor(op, () => []); }),
    execute: vi.fn((s: SQL) => {
      ops.push({ kind: 'execute', sql: render(s) });
      return opts.executeError ? Promise.reject(opts.executeError) : Promise.resolve([]);
    }),
    transaction: vi.fn(async (fn: (inner: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { tx: tx as never, ops };
}

beforeEach(() => {
  vi.mocked(loadCandidateDevices).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('endpointMatchName', () => {
  it('uses the first label of the hostname, falling back to the fqdn', () => {
    expect(endpointMatchName('WS-01.Corp.Example.com', null)).toBe('ws-01');
    expect(endpointMatchName('  ', 'srv-02.corp')).toBe('srv-02');
    expect(endpointMatchName(null, null)).toBeNull();
    expect(endpointMatchName('', '')).toBeNull();
  });
});

describe('matchEdrEndpoints', () => {
  it('drops stale auto links with the parked-device guard and FQDN-shortened name comparison', async () => {
    const { tx, ops } = makeTx({ selects: [[], [{ n: 0 }]] });
    await matchEdrEndpoints(tx, CONN);
    const stale = ops.find((o) => o.kind === 'update')!;
    expect(stale.table).toBe('edr_endpoints');
    expect(stale.set).toMatchObject({ breezeDeviceId: null, deviceMatchSource: null });
    const text = render(stale.where);
    expect(text).toContain('parked_org');
    expect(text).toContain("'unassigned_pool'");
    expect(text).toContain("split_part(lower(btrim(");
    expect(text).toContain('"devices"."org_id" = "edr_endpoints"."org_id"');
    expect(text).toContain("<> 'decommissioned'");
    expect(text).toContain('auto_hostname');
    expect(text).not.toContain('manual');
  });

  it('clears the orphaned source marker of a manual row whose device is gone', async () => {
    const { tx, ops } = makeTx({ selects: [[], [{ n: 0 }]] });
    await matchEdrEndpoints(tx, CONN);
    const manual = ops.filter((o) => o.kind === 'update')[1]!;
    expect(manual.set).toMatchObject({ deviceMatchSource: null });
    expect(render(manual.where)).toContain('manual');
  });

  it('claimed is scoped to THIS connection', async () => {
    vi.mocked(loadCandidateDevices).mockResolvedValue([]);
    const { tx } = makeTx({
      selects: [[{ id: 'e1', orgId: ORG, hostname: 'WS-01.corp', fqdn: null, macAddresses: [] }], [{ n: 0 }]],
    });
    await matchEdrEndpoints(tx, CONN);
    const [, orgIds, names, claimed, opts] = vi.mocked(loadCandidateDevices).mock.calls[0]!;
    expect(orgIds).toEqual([ORG]);
    expect(names).toEqual(['ws-01']);
    expect(opts).toEqual({ shortenFqdn: true });
    const text = render(claimed(sql`d.id`));
    expect(text).toContain('x.connection_id =');
    expect(text).toContain(CONN);
    expect(text).toContain('edr_endpoints');
  });

  it('writes unique matches in one savepointed UPDATE ... FROM VALUES and reports the counters', async () => {
    vi.mocked(loadCandidateDevices).mockResolvedValue([
      { deviceId: '33333333-3333-4333-8333-333333333333', matchName: 'ws-01', orgId: ORG, macAddresses: [], claimed: false },
    ]);
    const { tx, ops } = makeTx({
      selects: [
        [
          { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orgId: ORG, hostname: 'WS-01', fqdn: null, macAddresses: [] },
          { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', orgId: ORG, hostname: 'no-such', fqdn: null, macAddresses: [] },
        ],
        [{ n: 1 }],
      ],
    });
    const out = await matchEdrEndpoints(tx, CONN);
    expect(out).toEqual({ linked: 1, ambiguous: 0 });
    expect((tx as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction).toHaveBeenCalledTimes(1);
    const write = ops.find((o) => o.kind === 'execute')!.sql!;
    expect(write).toMatch(/UPDATE edr_endpoints AS e/);
    expect(write).toMatch(/e\.breeze_device_id IS NULL/);
    expect(write).toMatch(/IS DISTINCT FROM 'manual'/);
    expect(write).toContain('auto_hostname');
  });

  it('skips manual rows and rows with no usable name', async () => {
    const { tx, ops } = makeTx({
      selects: [[{ id: 'e1', orgId: ORG, hostname: null, fqdn: null, macAddresses: [] }], [{ n: 0 }]],
    });
    expect(await matchEdrEndpoints(tx, CONN)).toEqual({ linked: 0, ambiguous: 0 });
    expect(loadCandidateDevices).not.toHaveBeenCalled();
    const targetsWhere = render(ops.filter((o) => o.kind === 'select')[0]!.where);
    expect(targetsWhere).toContain("IS DISTINCT FROM 'manual'");
  });

  it('counts a lost uniqueness race (23505) as ambiguous instead of failing Phase 3', async () => {
    vi.mocked(loadCandidateDevices).mockResolvedValue([
      { deviceId: '33333333-3333-4333-8333-333333333333', matchName: 'ws-01', orgId: ORG, macAddresses: [], claimed: false },
    ]);
    const { tx } = makeTx({
      selects: [[{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orgId: ORG, hostname: 'WS-01', fqdn: null, macAddresses: [] }], [{ n: 0 }]],
      executeError: Object.assign(new Error('duplicate key'), { code: '23505' }),
    });
    expect(await matchEdrEndpoints(tx, CONN)).toEqual({ linked: 0, ambiguous: 1 });
  });

  it('re-throws anything that is not a link race', async () => {
    vi.mocked(loadCandidateDevices).mockResolvedValue([
      { deviceId: '33333333-3333-4333-8333-333333333333', matchName: 'ws-01', orgId: ORG, macAddresses: [], claimed: false },
    ]);
    const { tx } = makeTx({
      selects: [[{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orgId: ORG, hostname: 'WS-01', fqdn: null, macAddresses: [] }]],
      executeError: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    });
    await expect(matchEdrEndpoints(tx, CONN)).rejects.toThrow(/deadlock/);
  });
});

describe('strict-unique matching for identifier-poor vendors (A3)', () => {
  const DEV = (id: string, claimed = false) => ({ deviceId: id, matchName: 'pc04', orgId: ORG, macAddresses: [], claimed });
  const EP = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, orgId: ORG, hostname: 'PC04', fqdn: null, macAddresses: [], breezeDeviceId: null, deviceMatchSource: null, ...extra });

  it('strictMatchingFor: strict exactly when the vendor offers neither mac nor serial', () => {
    expect(strictMatchingFor(emsisoftAdapter.capabilities.endpointIdentifiers)).toBe(true);
    expect(strictMatchingFor(bitdefenderAdapter.capabilities.endpointIdentifiers)).toBe(false);
    expect(strictMatchingFor(['hostname', 'serial'])).toBe(false);
  });

  it('twins in Breeze (two devices named PC04): the row stays unlinked and counts ambiguous', async () => {
    vi.mocked(loadCandidateDevices).mockResolvedValue([DEV('d1'), DEV('d2')]);
    const { tx, ops } = makeTx({ selects: [[EP('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')], [{ n: 0 }]] });
    expect(await matchEdrEndpoints(tx, CONN, { strictUnique: true })).toEqual({ linked: 0, ambiguous: 1 });
    expect(ops.some((o) => o.kind === 'execute')).toBe(false);
  });

  it('a manual link on one twin never auto-links the other by elimination (rule b counts linked rows)', async () => {
    // d1 is claimed by the manually linked endpoint; d2 is free. Today's resolver would hand d2 to the second row.
    vi.mocked(loadCandidateDevices).mockResolvedValue([DEV('d1', true), DEV('d2')]);
    const { tx, ops } = makeTx({
      selects: [[
        EP('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { breezeDeviceId: 'd1', deviceMatchSource: 'manual' }),
        EP('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      ], [{ n: 1 }]],
    });
    const out = await matchEdrEndpoints(tx, CONN, { strictUnique: true });
    expect(out.ambiguous).toBe(1);
    expect(ops.some((o) => o.kind === 'execute')).toBe(false);
  });

  it('one machine listed twice in the vendor console (2 rows, 1 device) -> neither links', async () => {
    vi.mocked(loadCandidateDevices).mockResolvedValue([DEV('d1')]);
    const { tx, ops } = makeTx({ selects: [[EP('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), EP('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')], [{ n: 0 }]] });
    expect(await matchEdrEndpoints(tx, CONN, { strictUnique: true })).toEqual({ linked: 0, ambiguous: 2 });
    expect(ops.some((o) => o.kind === 'execute')).toBe(false);
  });

  it('a unique row/device pair still links, and an already-linked unique row is not re-reported', async () => {
    vi.mocked(loadCandidateDevices).mockResolvedValue([DEV('d1'), { ...DEV('d3', true), matchName: 'pc07' }]);
    const { tx, ops } = makeTx({
      selects: [[
        EP('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        EP('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { hostname: 'PC07', breezeDeviceId: 'd3', deviceMatchSource: 'auto_hostname' }),
      ], [{ n: 2 }]],
    });
    expect(await matchEdrEndpoints(tx, CONN, { strictUnique: true })).toEqual({ linked: 2, ambiguous: 0 });
    expect(ops.find((o) => o.kind === 'execute')!.sql).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('default (non-strict) behaviour is unchanged: the free twin links', async () => {
    vi.mocked(loadCandidateDevices).mockResolvedValue([DEV('33333333-3333-4333-8333-333333333333', true), DEV('44444444-4444-4444-8444-444444444444')]);
    const { tx } = makeTx({ selects: [[EP('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')], [{ n: 1 }]] });
    expect(await matchEdrEndpoints(tx, CONN)).toEqual({ linked: 1, ambiguous: 0 });
  });
});
