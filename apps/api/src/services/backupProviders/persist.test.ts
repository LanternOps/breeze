import { describe, expect, it, vi, beforeEach } from 'vitest';
// Package ROOT, never '@breeze/shared/utils/backupHealth' — see the Step 1
// trap note: deep subpaths are absent from packages/shared's `exports` map and
// a VALUE import through one dies at module load under the integration config.
import {
  EXTERNAL_BACKUP_STATUSES,
  EXTERNAL_BACKUP_STATUS_SEVERITY,
  worstBackupStatus,
  type ExternalBackupStatus,
} from '@breeze/shared';

vi.mock('./mapping', () => ({ autoMapCustomers: vi.fn(async () => 1) }));
vi.mock('./deviceMatching', () => ({ matchProviderDevices: vi.fn(async () => ({ linked: 1, ambiguous: 0 })) }));

import { autoMapCustomers } from './mapping';
import { matchProviderDevices } from './deviceMatching';
import { LEDGER_STATUS_SEVERITY, LEDGER_RETENTION_DAYS, persistVendorSnapshot } from './persist';

const CONNECTION = {
  id: '00000000-0000-4000-8000-0000000000c1',
  partnerId: '00000000-0000-4000-8000-0000000000p1'.replace('p', 'a'),
  provider: 'cove',
  showProviderNameInPortal: false,
};
const ORG = '11111111-1111-4111-8111-111111111111';

type Recorded = { kind: 'select' | 'insert' | 'update' | 'delete' | 'execute'; payload?: unknown };

/**
 * Minimal drizzle stand-in. `selectQueue` feeds the SELECTs in call order and
 * `insertQueue` the `.returning()` results; everything issued is recorded so a
 * test can assert what ran and in which order.
 */
function makeTx(selectQueue: unknown[][], insertQueue: unknown[][]) {
  const calls: Recorded[] = [];
  const executed: string[] = [];

  const thenable = (result: unknown) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'values', 'onConflictDoUpdate', 'set', 'returning', 'limit']) {
      chain[m] = vi.fn((payload?: unknown) => {
        if (m === 'values') calls.push({ kind: 'insert', payload });
        if (m === 'set') calls.push({ kind: 'update', payload });
        return chain;
      });
    }
    (chain as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return chain;
  };

  const tx = {
    select: vi.fn(() => {
      calls.push({ kind: 'select' });
      return thenable(selectQueue.shift() ?? []);
    }),
    insert: vi.fn(() => thenable(insertQueue.shift() ?? [])),
    update: vi.fn(() => thenable([])),
    delete: vi.fn((table?: unknown) => {
      calls.push({ kind: 'delete', payload: table });
      return thenable([]);
    }),
    execute: vi.fn((statement: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(statement?.queryChunks ?? statement);
      executed.push(text);
      calls.push({ kind: 'execute', payload: text });
      return Promise.resolve([]);
    }),
    transaction: vi.fn(async (fn: (inner: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { tx, calls, executed };
}

const vendorDevice = (over: Partial<Record<string, unknown>> = {}) => ({
  vendorDeviceId: 'v1',
  vendorCustomerId: 'vc1',
  name: 'SRV-01',
  computerName: 'srv-01',
  osType: 'server' as const,
  osVersion: 'Windows Server 2022',
  clientVersion: '24.3',
  macAddresses: ['aa:bb:cc:dd:ee:ff'],
  accountType: 'backup_manager' as const,
  dataSources: ['files'],
  status: 'completed' as ExternalBackupStatus,
  vendorStatusCode: 5,
  lastSessionAt: new Date('2026-09-15T02:00:00Z'),
  lastSuccessAt: new Date('2026-09-15T02:00:00Z'),
  lastCompletedAt: new Date('2026-09-15T02:00:00Z'),
  selectedBytes: 100,
  usedBytes: 90,
  errorsCount: 0,
  vendorCreatedAt: null,
  vendorExpiresAt: null,
  raw: {},
  ...over,
});

const vendorCustomer = (over: Partial<Record<string, unknown>> = {}) => ({
  vendorCustomerId: 'vc1',
  name: 'Acme Ltd',
  parentId: null,
  level: 'EndCustomer',
  externalCode: null,
  ...over,
});

describe('LEDGER_STATUS_SEVERITY', () => {
  it('covers every status in the shared enum tuple', () => {
    expect(LEDGER_STATUS_SEVERITY.map(([s]) => s).sort()).toEqual([...EXTERNAL_BACKUP_STATUSES].sort());
  });

  it('carries exactly the shared severities (the SQL CASE is generated from them)', () => {
    for (const [status, severity] of LEDGER_STATUS_SEVERITY) {
      expect(severity).toBe(EXTERNAL_BACKUP_STATUS_SEVERITY[status]);
    }
  });

  it('agrees with worstBackupStatus for every ordered pair', () => {
    const sev = Object.fromEntries(LEDGER_STATUS_SEVERITY) as Record<ExternalBackupStatus, number>;
    for (const a of EXTERNAL_BACKUP_STATUSES) {
      for (const b of EXTERNAL_BACKUP_STATUSES) {
        const expected = sev[a] >= sev[b] ? a : b;
        expect(worstBackupStatus(a, b), `worst(${a}, ${b})`).toBe(expected);
      }
    }
  });

  it('ranks failed worst and completed best (spec severity order)', () => {
    const sev = Object.fromEntries(LEDGER_STATUS_SEVERITY) as Record<ExternalBackupStatus, number>;
    const ordered = [...EXTERNAL_BACKUP_STATUSES].sort((a, b) => sev[b] - sev[a]);
    expect(ordered).toEqual([
      'failed', 'over_quota', 'no_selection', 'no_backups', 'interrupted',
      'completed_with_errors', 'not_started', 'unknown', 'in_progress', 'completed',
    ]);
  });
});

describe('persistVendorSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defers the deferrable FKs before touching any row', async () => {
    const { tx, executed } = makeTx(
      [[], [], []],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], []],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, { customers: [vendorCustomer()], devices: [] });
    expect(executed[0]).toContain('SET CONSTRAINTS ALL DEFERRED');
  });

  it('runs auto-mapping after the customer upsert and before the device upsert', async () => {
    const order: string[] = [];
    (autoMapCustomers as unknown as { mockImplementation: (f: () => Promise<number>) => void })
      .mockImplementation(async () => { order.push('automap'); return 0; });
    (matchProviderDevices as unknown as { mockImplementation: (f: () => Promise<unknown>) => void })
      .mockImplementation(async () => { order.push('match'); return { linked: 0, ambiguous: 0 }; });

    const { tx } = makeTx(
      [
        [],                                              // existing customers
        [{ id: 'c1', vendorCustomerId: 'vc1', orgId: ORG }], // mappings after auto-map
        [],                                              // existing device rows
      ],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p1', orgId: ORG }]],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    expect(order).toEqual(['automap', 'match']);
  });

  it('skips devices whose customer is unmapped and counts them', async () => {
    const { tx } = makeTx(
      [
        [],
        [{ id: 'c1', vendorCustomerId: 'vc1', orgId: null }], // customer NOT mapped
        [],
      ],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], []],
    );
    const counters = await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice(), vendorDevice({ vendorDeviceId: 'v2' })],
    });
    expect(counters.devices).toBe(0);
    expect(counters.unmappedDevices).toBe(2);
    expect(counters.unmappedCustomers).toBe(1);
  });

  it('deletes the device rows of a customer that is no longer mapped', async () => {
    const { tx, calls } = makeTx(
      [
        [],
        [{ id: 'c1', vendorCustomerId: 'vc1', orgId: null }],
        [{ id: 'p-old', vendorDeviceId: 'v1', customerId: 'c1' }],
      ],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], []],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    expect(calls.some((c) => c.kind === 'delete')).toBe(true);
  });

  it('deletes a device row whose vendor device vanished from a complete snapshot', async () => {
    const { tx, calls } = makeTx(
      [
        [],
        [{ id: 'c1', vendorCustomerId: 'vc1', orgId: ORG }],
        [
          { id: 'p-keep', vendorDeviceId: 'v1', customerId: 'c1' },
          { id: 'p-gone', vendorDeviceId: 'v-removed', customerId: 'c1' },
        ],
      ],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p-keep', orgId: ORG }]],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    expect(calls.filter((c) => c.kind === 'delete').length).toBeGreaterThan(0);
  });

  it('upserts one ledger row per persisted device with observations = 1 and today as the day', async () => {
    const { tx, calls } = makeTx(
      [
        [],
        [{ id: 'c1', vendorCustomerId: 'vc1', orgId: ORG }],
        [],
      ],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p1', orgId: ORG }]],
    );
    await persistVendorSnapshot(
      tx as never,
      CONNECTION,
      { customers: [vendorCustomer()], devices: [vendorDevice()] },
      { now: new Date('2026-09-15T23:30:00Z') },
    );
    const ledger = calls
      .filter((c) => c.kind === 'insert')
      .map((c) => c.payload as Array<Record<string, unknown>>)
      .find((rows) => Array.isArray(rows) && rows[0] && 'day' in rows[0]);
    expect(ledger).toBeDefined();
    expect(ledger![0]).toMatchObject({
      providerDeviceId: 'p1',
      orgId: ORG,
      day: '2026-09-15',
      status: 'completed',
      errorsCount: 0,
      observations: 1,
    });
  });

  it('prunes ledger rows older than the retention window for this connection only', async () => {
    const { tx, executed } = makeTx(
      [[], [{ id: 'c1', vendorCustomerId: 'vc1', orgId: ORG }], []],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p1', orgId: ORG }]],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    const prune = executed.find((s) => s.includes('backup_provider_device_history') && s.includes('DELETE'));
    expect(prune).toBeDefined();
    expect(prune).toContain(String(LEDGER_RETENTION_DAYS));
    expect(prune).toContain('connection_id');
  });

  it('re-homes a device row to the mapping org present in THIS transaction', async () => {
    const NEW_ORG = '33333333-3333-4333-8333-333333333333';
    const { tx, calls } = makeTx(
      [[], [{ id: 'c1', vendorCustomerId: 'vc1', orgId: NEW_ORG }], []],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p1', orgId: NEW_ORG }]],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    const deviceRows = calls
      .filter((c) => c.kind === 'insert')
      .map((c) => c.payload as Array<Record<string, unknown>>)
      .find((rows) => Array.isArray(rows) && rows[0] && 'vendorDeviceId' in rows[0]);
    expect(deviceRows![0]).toMatchObject({ orgId: NEW_ORG, provider: 'cove', portalShowProviderName: false });
  });

  it('re-stamps history rows left behind by a device that changed org, scoped to this connection', async () => {
    const { tx, executed } = makeTx(
      [[], [{ id: 'c1', vendorCustomerId: 'vc1', orgId: ORG }], []],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p1', orgId: ORG }]],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    // This is the statement that makes the deferred composite FK legal again
    // at COMMIT (CLAUDE.md, org-merge contract) — it must join on the
    // device's CURRENT org_id, filter to this connection, and only touch rows
    // that actually disagree, or a re-mapped customer's ledger keeps pointing
    // at the OLD org forever.
    const restamp = executed.find((s) =>
      s.includes('backup_provider_device_history') && s.includes('UPDATE'));
    expect(restamp).toBeDefined();
    expect(restamp).toContain('backup_provider_devices');
    expect(restamp).toContain(CONNECTION.id);
    expect(restamp).toContain('org_id');
  });

  it('returns the counters the connection card shows', async () => {
    (matchProviderDevices as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue({ linked: 3, ambiguous: 2 });
    const { tx } = makeTx(
      [[], [{ id: 'c1', vendorCustomerId: 'vc1', orgId: ORG }], []],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p1', orgId: ORG }]],
    );
    const counters = await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    expect(counters).toEqual({
      customers: 1,
      unmappedCustomers: 0,
      devices: 1,
      unmappedDevices: 0,
      linked: 3,
      ambiguous: 2,
    });
  });
});
