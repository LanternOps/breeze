import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Value importer (#3257 W08 Tasks 2 + 3).
 *
 * These tests drive the REAL resolver (`resolveDevice.ts`), the REAL definition
 * lookup (`queries.ts`) and the REAL upsert, with only the database mocked, so
 * they cover the module's whole pipeline rather than its orchestration alone.
 * `db.select` is dispatched on the TABLE being read rather than on call order:
 * the query sequence is conditional (a batch with no external ids issues no
 * link query at all), and a positional queue would silently mis-feed a result
 * to the wrong query the first time a test changed the row shape.
 *
 * `applyWarrantyImport` is stubbed — it has its own suite next door
 * (`warrantyTarget.test.ts`, 16 tests) — but `coerceWarrantyValue` stays real,
 * because it is what preview annotates warranty cells with.
 */

const PARTNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG = '11111111-1111-4111-8111-111111111111';
const D1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const D2 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';
const GONE = 'dddddddd-dddd-4ddd-8ddd-dddddddddd99';
const DEF_TAG = '33333333-3333-4333-8333-333333333331';
const DEF_UNITS = '33333333-3333-4333-8333-333333333332';
const DEF_BITLOCKER = '33333333-3333-4333-8333-333333333333';

const {
  tableQueues,
  whereCalls,
  selectedTables,
  txInserts,
  txCount,
  insertFailures,
  linkReturns,
  applyWarrantyImportMock,
} = vi.hoisted(() => ({
  tableQueues: new Map<string, unknown[][]>(),
  whereCalls: [] as Array<{ table: string; condition: unknown }>,
  selectedTables: [] as string[],
  txInserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  txCount: { current: 0 },
  insertFailures: { current: null as null | ((table: string, values: Record<string, unknown>) => void) },
  linkReturns: { current: [{ id: 'link-1' }] as unknown[] },
  applyWarrantyImportMock: vi.fn(),
}));

function tableName(table: unknown): string {
  // Real drizzle table objects; the Symbol-keyed name is the only stable handle.
  // Matched EXACTLY — `drizzle:OriginalName` and `drizzle:BaseName` also exist
  // and a substring match would pick whichever was defined first.
  const symbol = Object.getOwnPropertySymbols(table as object).find((s) => String(s) === 'Symbol(drizzle:Name)');
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : String(table);
}

/**
 * Per-table FIFO. The LAST queued result is sticky, so a loader called once per
 * organization keeps answering after the queue drains.
 */
function nextFor(table: string): unknown[] {
  const queue = tableQueues.get(table);
  if (!queue || queue.length === 0) return [];
  return queue.length === 1 ? queue[0]! : queue.shift()!;
}

function queueTable(table: string, ...results: unknown[][]): void {
  tableQueues.set(table, results);
}

vi.mock('../../../db', () => {
  const chain = (table: string) => {
    const node: Record<string, unknown> = {};
    const self = () => node;
    node.from = (t: unknown) => {
      const name = tableName(t);
      selectedTables.push(name);
      (node as { __table: string }).__table = name;
      return node;
    };
    node.leftJoin = self;
    node.innerJoin = self;
    node.orderBy = self;
    node.limit = self;
    node.where = (condition: unknown) => {
      whereCalls.push({ table: (node as { __table?: string }).__table ?? table, condition });
      return node;
    };
    node.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(nextFor((node as { __table?: string }).__table ?? table)).then(resolve, reject);
    return node;
  };

  const txInsert = (t: unknown) => {
    const name = tableName(t);
    return {
      values: (values: Record<string, unknown>) => {
        txInserts.push({ table: name, values });
        insertFailures.current?.(name, values);
        const returning = async () =>
          name === 'device_external_links'
            ? linkReturns.current
            : [{ fieldKey: values.fieldKey }];
        return {
          onConflictDoUpdate: () => ({ returning }),
          onConflictDoNothing: () => ({ returning }),
        };
      },
    };
  };

  return {
    db: {
      select: () => chain('?'),
      transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
        txCount.current += 1;
        return cb({ insert: txInsert, select: () => chain('?') });
      },
    },
    runOutsideDbContext: <T,>(fn: () => T) => fn(),
    withSystemDbAccessContext: <T,>(fn: () => T) => fn(),
  };
});

vi.mock('./warrantyTarget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./warrantyTarget')>();
  return { ...actual, applyWarrantyImport: applyWarrantyImportMock };
});

import {
  commitDeviceCustomFieldImport,
  previewDeviceCustomFieldImport,
  type ValueImportContext,
} from './valueImport';
import type { CommitValueRowInput, DeviceCustomFieldImportRow, MappingTarget } from './types';

const ctx: ValueImportContext = { partnerId: PARTNER, accessibleOrgIds: [ORG], allowedSiteIds: null };
const actor = { userId: 'u-1' };

const preview = (rows: readonly DeviceCustomFieldImportRow[], c: ValueImportContext = ctx) =>
  previewDeviceCustomFieldImport(rows, c);
const commit = (
  rows: readonly CommitValueRowInput[],
  c: ValueImportContext = ctx,
  a = actor,
  options?: { mode?: 'skip' | 'update' },
) => commitDeviceCustomFieldImport(rows, c, a, options);

/** A custom-field value assignment. */
const v = (fieldKey: string, value: unknown) => ({ target: { kind: 'customField', fieldKey } as MappingTarget, value });
/** A warranty value assignment. */
const w = (field: 'warrantyEndDate' | 'warrantyStartDate' | 'manufacturer', value: unknown) => ({
  target: { kind: 'warranty', field } as MappingTarget,
  value,
});

interface DeviceSeed {
  deviceId: string;
  hostname?: string | null;
  serialNumber?: string | null;
  osType?: string | null;
  status?: string | null;
}

function device(seed: DeviceSeed) {
  return {
    deviceId: seed.deviceId,
    orgId: ORG,
    hostname: seed.hostname ?? 'wkstn-1',
    displayName: 'WKSTN-1',
    osType: seed.osType ?? 'windows',
    status: seed.status ?? 'online',
    enrolledAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-09-01T00:00:00Z'),
    siteId: null,
    serialNumber: seed.serialNumber ?? 'SN-1',
  };
}

const DEFINITIONS = [
  { id: DEF_TAG, fieldKey: 'asset_tag', name: 'Asset Tag', type: 'text', options: null, deviceTypes: null, required: false, scriptWrite: false, orgId: ORG, partnerId: null },
  { id: DEF_UNITS, fieldKey: 'rack_units', name: 'Rack Units', type: 'number', options: null, deviceTypes: null, required: false, scriptWrite: false, orgId: ORG, partnerId: null },
  { id: DEF_BITLOCKER, fieldKey: 'bitlocker_status', name: 'BitLocker', type: 'text', options: null, deviceTypes: ['windows'], required: false, scriptWrite: false, orgId: ORG, partnerId: null },
];

interface SeedOptions {
  devices?: ReturnType<typeof device>[];
  links?: Array<{ deviceId: string; system: string; externalId: string; sourceInstance: string | null }>;
  storedValues?: Array<{ deviceId: string; definitionId: string; fieldKey: string; valueText: string | null; valueNumber: number | null; valueBool: boolean | null; valueDate: string | null }>;
  warranty?: Array<{ deviceId: string; dataSource: string | null }>;
  definitions?: typeof DEFINITIONS;
}

function seed(options: SeedOptions = {}) {
  tableQueues.clear();
  // `organizations` is read TWICE: the resolver's reachable-org query, then the
  // definition loader's partner lookup. Order is deterministic.
  queueTable('organizations', [{ id: ORG }], [{ partnerId: PARTNER }]);
  queueTable('devices', options.devices ?? [device({ deviceId: D1 })]);
  queueTable('device_external_links', options.links ?? []);
  queueTable('device_custom_field_values', options.storedValues ?? []);
  queueTable('device_warranty', options.warranty ?? []);
  queueTable('custom_field_definitions', options.definitions ?? DEFINITIONS);
}

beforeEach(() => {
  tableQueues.clear();
  whereCalls.length = 0;
  selectedTables.length = 0;
  txInserts.length = 0;
  txCount.current = 0;
  insertFailures.current = null;
  linkReturns.current = [{ id: 'link-1' }];
  applyWarrantyImportMock.mockReset().mockResolvedValue('applied');
});

describe('previewDeviceCustomFieldImport', () => {
  it('annotates a link-resolved row as link-match', async () => {
    seed({ links: [{ deviceId: D1, system: 'datto_rmm', externalId: 'uid-1', sourceInstance: null }] });

    const [row] = await preview([{ externalSystem: 'datto_rmm', externalId: 'uid-1', values: [v('asset_tag', 'AB-1')] }]);

    expect(row).toMatchObject({ outcome: 'link-match', method: 'link', deviceId: D1, organizationId: ORG });
  });

  it('partially annotates one row: applied, no-definition, type-error', async () => {
    seed();

    const [row] = await preview([{
      hostname: 'wkstn-1',
      values: [v('asset_tag', 'AB-1'), v('nope', 'x'), v('rack_units', 'abc')],
    }]);

    expect(row!.outcome).toBe('matched');
    expect(row!.values.map((x) => x.outcome)).toEqual(['applied', 'no-definition', 'type-error']);
    expect(row!.values[2]!.reason).toBe('invalid_type');
  });

  it('marks a value equal to the stored one as skipped-already-set', async () => {
    seed({
      storedValues: [{ deviceId: D1, definitionId: DEF_TAG, fieldKey: 'asset_tag', valueText: 'AB-1', valueNumber: null, valueBool: null, valueDate: null }],
    });

    const [row] = await preview([{ deviceId: D1, values: [v('asset_tag', 'AB-1')] }]);

    expect(row!.values[0]!.outcome).toBe('skipped-already-set');
  });

  it('skips a DIFFERENT stored value in the default skip mode, and applies it in update mode', async () => {
    const stored = [{ deviceId: D1, definitionId: DEF_TAG, fieldKey: 'asset_tag', valueText: 'OLD', valueNumber: null, valueBool: null, valueDate: null }];

    seed({ storedValues: stored });
    const [skipRow] = await preview([{ deviceId: D1, values: [v('asset_tag', 'AB-1')] }]);
    expect(skipRow!.values[0]!.outcome).toBe('skipped-already-set');

    seed({ storedValues: stored });
    const [updateRow] = await preview([{ deviceId: D1, values: [v('asset_tag', 'AB-1')] }], { ...ctx, mode: 'update' });
    expect(updateRow!.values[0]!.outcome).toBe('applied');
  });

  it('warns on a reserved partner-integration identity key without refusing it', async () => {
    seed();

    const [row] = await preview([{ deviceId: D1, values: [v('asset_tag', 'AB-1')] }]);

    expect(row!.values[0]!.outcome).toBe('applied');
    expect(row!.values[0]!.warning).toMatch(/partner integration identity/i);
  });

  it('does not warn on an ordinary key', async () => {
    seed();

    const [row] = await preview([{ deviceId: D1, values: [v('rack_units', 4)] }]);

    expect(row!.values[0]!.warning).toBeUndefined();
  });

  it('marks a value whose definition excludes this device OS as not-applicable-to-device', async () => {
    seed({ devices: [device({ deviceId: D1, osType: 'macos' })] });

    const [row] = await preview([{ deviceId: D1, values: [v('bitlocker_status', 'on')] }]);

    expect(row!.values[0]!.outcome).toBe('not-applicable-to-device');
  });

  it('returns ranked candidates for an ambiguous row and annotates nothing as applied', async () => {
    seed({
      devices: [
        device({ deviceId: D1, hostname: 'shared-name', serialNumber: 'SN-1', status: 'offline' }),
        device({ deviceId: D2, hostname: 'shared-name', serialNumber: 'SN-2', status: 'online' }),
      ],
    });

    const [row] = await preview([{ hostname: 'shared-name', values: [v('asset_tag', 'AB-1')] }]);

    expect(row!.outcome).toBe('ambiguous');
    expect(row!.candidates.length).toBeGreaterThan(1);
    expect(row!.candidates[0]!.deviceId).toBe(D2); // online ranks first
    expect(row!.values.every((x) => x.outcome !== 'applied')).toBe(true);
    expect(row!.values[0]!.outcome).toBe('device-unresolved');
  });

  it('annotates an unreachable organization as org-not-found without disclosing whether it exists', async () => {
    seed();

    const [row] = await preview([{
      organizationId: '99999999-9999-4999-8999-999999999999',
      hostname: 'wkstn-1',
      values: [v('asset_tag', 'AB-1')],
    }]);

    expect(row!.outcome).toBe('org-not-found');
    expect(row!.deviceId).toBeNull();
    expect(row!.candidates).toEqual([]);
  });

  it('annotates a warranty target, and reports an unparseable date as type-error', async () => {
    seed();

    const [row] = await preview([{
      deviceId: D1,
      values: [w('warrantyEndDate', '2027-03-04'), w('warrantyEndDate', 'whenever')],
    }]);

    expect(row!.values[0]!.outcome).toBe('applied');
    expect(row!.values[1]).toMatchObject({ outcome: 'type-error', reason: 'invalid_date' });
  });

  it('annotates a provider-owned warranty row as skipped-already-set unless the operator opted in', async () => {
    seed({ warranty: [{ deviceId: D1, dataSource: 'provider' }] });
    const [guarded] = await preview([{ deviceId: D1, values: [w('warrantyEndDate', '2027-03-04')] }]);
    expect(guarded!.values[0]!.outcome).toBe('skipped-already-set');
    expect(guarded!.values[0]!.warning).toMatch(/manufacturer/i);

    seed({ warranty: [{ deviceId: D1, dataSource: 'provider' }] });
    const [opted] = await preview(
      [{ deviceId: D1, values: [w('warrantyEndDate', '2027-03-04')] }],
      { ...ctx, overrideProviderWarranty: true },
    );
    expect(opted!.values[0]!.outcome).toBe('applied');
  });

  it('writes nothing at all', async () => {
    seed();
    await preview([{ deviceId: D1, values: [v('asset_tag', 'AB-1')] }]);
    expect(txCount.current).toBe(0);
    expect(txInserts).toHaveLength(0);
  });
});

describe('commitDeviceCustomFieldImport', () => {
  it('applies the good values on a mixed row and reports the rest, in ONE transaction', async () => {
    seed();

    const summary = await commit([{
      deviceId: D1,
      values: [v('asset_tag', 'AB-1'), v('nope', 'x'), v('rack_units', 'abc')],
    }], ctx, actor, { mode: 'update' });

    expect(summary.rows[0]).toMatchObject({ index: 0, deviceId: D1, applied: 1, failed: 2 });
    expect(summary.appliedValues).toBe(1);
    expect(summary.failedValues).toBe(2);
    expect(txCount.current).toBe(1);
    expect(txInserts.filter((i) => i.table === 'device_custom_field_values')).toHaveLength(1);
  });

  it('a row that fails to write does not poison its neighbours', async () => {
    seed({ devices: [device({ deviceId: D1, hostname: 'a' }), device({ deviceId: D2, hostname: 'b' })] });
    let call = 0;
    insertFailures.current = (table) => {
      if (table !== 'device_custom_field_values') return;
      call += 1;
      if (call === 2) throw Object.assign(new Error('boom'), { code: '23503' });
    };

    const summary = await commit([
      { deviceId: D1, values: [v('asset_tag', 'A')] },
      { deviceId: D2, values: [v('asset_tag', 'B')] },
      { deviceId: D1, values: [v('asset_tag', 'C')] },
    ], ctx, actor, { mode: 'update' });

    expect(summary.errors.map((e) => e.index)).toEqual([1]);
    expect(summary.errors[0]!.code).toBe('write-failed');
    expect(summary.rows.map((r) => r.index)).toEqual([0, 2]);
    // One nested transaction per row — the mechanism the isolation depends on.
    expect(txCount.current).toBe(3);
  });

  it('never leaks driver text into the error body, but keeps the cause in-process', async () => {
    seed();
    insertFailures.current = (table) => {
      if (table === 'device_custom_field_values') {
        throw Object.assign(new Error('duplicate key value violates unique constraint "x" DETAIL: Key (a)=(secret)'), { code: '23505' });
      }
    };

    const summary = await commit([{ deviceId: D1, values: [v('asset_tag', 'A')] }], ctx, actor, { mode: 'update' });

    expect(summary.errors[0]!.error).not.toMatch(/DETAIL|secret|constraint/);
    expect(summary.errors[0]!.cause).toBeInstanceOf(Error);
    expect(JSON.stringify(summary.errors[0])).not.toMatch(/secret/);
    expect(Object.keys(summary.errors[0]!)).not.toContain('cause');
  });

  it('records a device_external_links row on the first match by hostname', async () => {
    seed();

    const summary = await commit([{
      externalSystem: 'datto_rmm',
      externalId: 'uid-9',
      hostname: 'wkstn-1',
      values: [v('asset_tag', 'AB-1')],
    }], ctx, actor, { mode: 'update' });

    expect(summary.linksCreated).toBe(1);
    expect(summary.rows[0]!.linkCreated).toBe(true);
    const link = txInserts.find((i) => i.table === 'device_external_links');
    expect(link!.values).toMatchObject({
      deviceId: D1, orgId: ORG, partnerId: PARTNER, system: 'datto_rmm', externalId: 'uid-9', createdBy: 'u-1',
    });
  });

  it('does not re-create the link when the row already resolved BY link', async () => {
    seed({ links: [{ deviceId: D1, system: 'datto_rmm', externalId: 'uid-9', sourceInstance: null }] });

    const summary = await commit([{
      externalSystem: 'datto_rmm', externalId: 'uid-9', values: [v('asset_tag', 'AB-1')],
    }], ctx, actor, { mode: 'update' });

    expect(summary.linksCreated).toBe(0);
    expect(txInserts.some((i) => i.table === 'device_external_links')).toBe(false);
    expect(summary.rows[0]!.method).toBe('link');
  });

  it('the SECOND run resolves by link and issues NO hostname predicate', async () => {
    // The durable link is what makes a re-run exact. Proven on the SQL the
    // resolver actually builds: with only an external id supplied, the device
    // query carries no `lower(hostname)` term at all. The control below is the
    // mutation check — the same assertion goes red when a hostname is present.
    seed({ links: [{ deviceId: D1, system: 'datto_rmm', externalId: 'uid-9', sourceInstance: null }] });

    const summary = await commit([{
      externalSystem: 'datto_rmm', externalId: 'uid-9', values: [v('asset_tag', 'AB-1')],
    }], ctx, actor, { mode: 'update' });

    expect(summary.rows[0]).toMatchObject({ deviceId: D1, method: 'link' });
    expect(deviceQuerySql()).not.toMatch(/lower\(/);
  });

  it('CONTROL: a first run that must fall back to the hostname DOES issue the hostname predicate', async () => {
    seed();

    await commit([{
      externalSystem: 'datto_rmm', externalId: 'uid-9', hostname: 'wkstn-1', values: [v('asset_tag', 'AB-1')],
    }], ctx, actor, { mode: 'update' });

    expect(deviceQuerySql()).toMatch(/lower\(/);
  });

  it('re-running an identical file in the default skip mode writes nothing', async () => {
    seed({
      storedValues: [
        { deviceId: D1, definitionId: DEF_TAG, fieldKey: 'asset_tag', valueText: 'AB-1', valueNumber: null, valueBool: null, valueDate: null },
        { deviceId: D1, definitionId: DEF_UNITS, fieldKey: 'rack_units', valueText: null, valueNumber: 4, valueBool: null, valueDate: null },
      ],
    });

    const summary = await commit([{ deviceId: D1, values: [v('asset_tag', 'AB-1'), v('rack_units', 4)] }]);

    expect(summary.appliedValues).toBe(0);
    expect(summary.skippedValues).toBe(2);
    expect(txInserts.filter((i) => i.table === 'device_custom_field_values')).toHaveLength(0);
  });

  it('refuses an ambiguous acknowledgement with no expectedDeviceId', async () => {
    seed({
      devices: [
        device({ deviceId: D1, hostname: 'shared-name', serialNumber: 'SN-1' }),
        device({ deviceId: D2, hostname: 'shared-name', serialNumber: 'SN-2' }),
      ],
    });

    const summary = await commit([{ hostname: 'shared-name', expectedOutcome: 'ambiguous', values: [v('asset_tag', 'x')] }]);

    expect(summary.errors[0]!.code).toBe('match-unconfirmed');
    expect(summary.rows).toHaveLength(0);
    expect(txCount.current).toBe(0);
  });

  it('refuses an acknowledgement pinned to a device the row no longer resolves to', async () => {
    seed({
      devices: [
        device({ deviceId: D1, hostname: 'shared-name', serialNumber: 'SN-1' }),
        device({ deviceId: D2, hostname: 'shared-name', serialNumber: 'SN-2' }),
      ],
    });

    const summary = await commit([{
      hostname: 'shared-name', expectedOutcome: 'ambiguous', expectedDeviceId: GONE, values: [v('asset_tag', 'x')],
    }]);

    expect(summary.errors[0]!.code).toBe('match-changed');
    expect(txCount.current).toBe(0);
  });

  it('honours an ambiguous acknowledgement pinned to a device still in the candidate set', async () => {
    seed({
      devices: [
        device({ deviceId: D1, hostname: 'shared-name', serialNumber: 'SN-1' }),
        device({ deviceId: D2, hostname: 'shared-name', serialNumber: 'SN-2' }),
      ],
    });

    const summary = await commit([{
      hostname: 'shared-name', expectedOutcome: 'ambiguous', expectedDeviceId: D2, values: [v('asset_tag', 'x')],
    }], ctx, actor, { mode: 'update' });

    expect(summary.errors).toHaveLength(0);
    expect(summary.rows[0]).toMatchObject({ deviceId: D2, applied: 1 });
  });

  it('refuses a row whose outcome moved since preview', async () => {
    seed(); // resolves `matched`, not `link-match`

    const summary = await commit([{ deviceId: D1, expectedOutcome: 'link-match', values: [v('asset_tag', 'x')] }]);

    expect(summary.errors[0]!.code).toBe('annotation-changed');
    expect(summary.errors[0]!.error).toMatch(/re-run preview/i);
  });

  it('a link-match needs no acknowledgement — the durable link IS the acknowledgement', async () => {
    seed({ links: [{ deviceId: D1, system: 'datto_rmm', externalId: 'uid-1', sourceInstance: null }] });

    const summary = await commit([{
      externalSystem: 'datto_rmm', externalId: 'uid-1', values: [v('asset_tag', 'AB-1')],
    }], ctx, actor, { mode: 'update' });

    expect(summary.errors).toHaveLength(0);
    expect(summary.rows[0]!.applied).toBe(1);
  });

  it('reports an unresolved row with the resolution code, never a write-failed', async () => {
    seed({ devices: [] });

    const summary = await commit([
      { hostname: 'ghost', values: [v('asset_tag', 'x')] },
      { organizationId: '99999999-9999-4999-8999-999999999999', hostname: 'ghost', values: [v('asset_tag', 'x')] },
    ]);

    expect(summary.errors.map((e) => e.code)).toEqual(['not-found', 'org-not-found']);
  });

  it('refuses a row whose identifiers disagree', async () => {
    seed({
      devices: [device({ deviceId: D1, hostname: 'wkstn-1', serialNumber: 'SN-1' }), device({ deviceId: D2, hostname: 'other', serialNumber: 'SN-2' })],
    });

    const summary = await commit([{ deviceId: D2, hostname: 'wkstn-1', values: [v('asset_tag', 'x')] }]);

    expect(summary.errors[0]!.code).toBe('identity-conflict');
  });

  it('applies the warranty target inside the SAME transaction as the values', async () => {
    seed();

    const summary = await commit([{
      deviceId: D1,
      values: [v('asset_tag', 'AB-1'), w('warrantyEndDate', '2027-03-04'), w('manufacturer', 'Dell')],
    }], ctx, actor, { mode: 'update' });

    expect(txCount.current).toBe(1);
    expect(applyWarrantyImportMock).toHaveBeenCalledTimes(1);
    expect(applyWarrantyImportMock.mock.calls[0]![1]).toMatchObject({
      deviceId: D1, orgId: ORG, warrantyEndDate: '2027-03-04', manufacturer: 'Dell',
    });
    expect(applyWarrantyImportMock.mock.calls[0]![2]).toEqual({ overrideProvider: false });
    expect(summary.rows[0]).toMatchObject({ warranty: 'applied', applied: 3 });
  });

  it('rolls the whole row back when the warranty write throws', async () => {
    seed();
    applyWarrantyImportMock.mockRejectedValue(Object.assign(new Error('nope'), { code: '23503' }));

    const summary = await commit([{
      deviceId: D1, values: [v('asset_tag', 'AB-1'), w('warrantyEndDate', '2027-03-04')],
    }], ctx, actor, { mode: 'update' });

    expect(summary.errors[0]).toMatchObject({ index: 0, code: 'write-failed' });
    expect(summary.rows).toHaveLength(0);
  });

  it('carries the resolution method, external system and applied field keys for the audit', async () => {
    seed();

    const summary = await commit([{
      externalSystem: 'datto_rmm', hostname: 'wkstn-1', values: [v('asset_tag', 'AB-1')],
    }], ctx, actor, { mode: 'update' });

    expect(summary.rows[0]).toMatchObject({
      method: 'hostname',
      externalSystem: 'datto_rmm',
      organizationId: ORG,
      appliedFieldKeys: ['asset_tag'],
    });
  });

  it('RE-DERIVES resolution at commit rather than trusting the client', async () => {
    // The row names a hostname; commit must run the resolver again. A client
    // that posted a deviceId it was never given cannot smuggle one in, because
    // every identifier is re-resolved against a freshly loaded snapshot.
    seed();
    await commit([{ hostname: 'wkstn-1', values: [v('asset_tag', 'A')] }], ctx, actor, { mode: 'update' });
    expect(selectedTables.filter((t) => t === 'devices')).toHaveLength(1);
    expect(selectedTables).toContain('organizations');
  });

  it('reaches nothing when the caller can reach no organization', async () => {
    seed();

    const summary = await commit(
      [{ deviceId: D1, values: [v('asset_tag', 'A')] }],
      { partnerId: PARTNER, accessibleOrgIds: [], allowedSiteIds: null },
    );

    expect(summary.errors.map((e) => e.code)).toEqual(['not-found']);
    expect(txCount.current).toBe(0);
  });
});

/** The SQL text of the `devices` query the resolver built, for shape assertions. */
function deviceQuerySql(): string {
  const call = whereCalls.find((c) => c.table === 'devices');
  return call ? sqlText(call.condition) : '';
}

function sqlText(node: unknown, depth = 0): string {
  if (node === null || node === undefined || depth > 12) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((n) => sqlText(n, depth + 1)).join(' ');
  if (typeof node !== 'object') return '';
  const record = node as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(record.value)) parts.push(record.value.join(''));
  if (record.queryChunks) parts.push(sqlText(record.queryChunks, depth + 1));
  return parts.join(' ');
}
