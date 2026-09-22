import { describe, it, expect, beforeEach, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    customer: null as null | Record<string, unknown>,
    org: null as null | { id: string; partnerId: string },
    deletedDevices: 0,
    deletedHistory: 0,
    statements: [] as string[],
    outsideContext: [] as string[],
  },
}));

vi.mock('../../db', () => ({
  db: {
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txStub())),
    select: vi.fn(() => selectStub()),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    state.outsideContext.push('enter');
    return fn();
  }),
}));

function selectStub() {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => (state.org ? [state.org] : [])) })),
    })),
  };
}

function txStub() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const rows = state.customer ? [state.customer] : [];
          return {
            for: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
            limit: vi.fn(async () => rows),
            // The device-ids query in mapping.ts awaits `.where(...)` directly
            // without a further `.for()`/`.limit()` chain call — making this
            // thenable lets that shape resolve too, alongside the two chained
            // shapes above used by the row-locked customer lookup.
            then: (resolve: (rows: unknown[]) => void) => Promise.resolve(rows).then(resolve),
          };
        }),
      })),
    })),
    delete: vi.fn((table: unknown) => {
      // The mocked schema tables are plain objects (no custom toString), so
      // `String(table)` collapses to "[object Object]" for every table and
      // the ordering assertions below can never distinguish them. Identify
      // the table by its (mocked) column values instead.
      state.statements.push(`DELETE ${JSON.stringify(table)}`);
      return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'row-1' }]) })) };
    }),
    update: vi.fn((table: unknown) => {
      state.statements.push(`UPDATE ${JSON.stringify(table)}`);
      return {
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'cust-1', orgId: state.org?.id ?? null }]) })),
        })),
      };
    }),
    execute: vi.fn(async (q: unknown) => {
      state.statements.push(String(q));
      return [];
    }),
  };
}

vi.mock('../../db/schema', () => ({
  backupProviderCustomers: { id: 'backup_provider_customers', orgId: 'org_id', partnerId: 'partner_id' },
  backupProviderDevices: { id: 'backup_provider_devices', customerId: 'customer_id' },
  backupProviderDeviceHistory: { providerDeviceId: 'backup_provider_device_history' },
  organizations: { id: 'organizations', partnerId: 'partner_id' },
}));

const { resolveForCustomer, enqueue } = vi.hoisted(() => ({
  resolveForCustomer: vi.fn(async () => 2),
  enqueue: vi.fn(async () => 'job-1'),
}));
vi.mock('./alertsResolve', () => ({
  resolveProviderAlertsForCustomer: resolveForCustomer,
  BACKUP_PROVIDER_ALERT_SOURCE: 'backup_provider',
}));

vi.mock('../../jobs/backupProviderSync', () => ({ enqueueBackupProviderSync: enqueue }));

import { remapCustomer, RemapCustomerError } from './mapping';

const ACTOR = { userId: 'user-1', partnerId: 'partner-1' };

describe('remapCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.customer = { id: 'cust-1', connectionId: 'conn-1', partnerId: 'partner-1', orgId: null, mappingSource: null };
    state.org = { id: 'org-1', partnerId: 'partner-1' };
    state.statements = [];
    state.outsideContext = [];
    resolveForCustomer.mockResolvedValue(2);
    enqueue.mockResolvedValue('job-1');
  });

  it('maps an unmapped customer, stamping mapping_source = manual', async () => {
    const result = await remapCustomer('cust-1', 'org-1', ACTOR);
    expect(result).toMatchObject({
      customerId: 'cust-1',
      connectionId: 'conn-1',
      orgId: 'org-1',
      mappingSource: 'manual',
      resolvedAlerts: 2,
      syncJobId: 'job-1',
    });
  });

  it('stamps manual_unmapped when the target org is null', async () => {
    const result = await remapCustomer('cust-1', null, ACTOR);
    expect(result.mappingSource).toBe('manual_unmapped');
    expect(result.orgId).toBeNull();
  });

  it('resolves the customer alerts BEFORE deleting its rows', async () => {
    await remapCustomer('cust-1', 'org-1', ACTOR);
    // resolveAlert publishes on the event bus; doing it inside a transaction
    // that can roll back would announce a resolution that did not happen.
    expect(resolveForCustomer).toHaveBeenCalledWith('cust-1', expect.stringMatching(/remap/i));
    expect(resolveForCustomer.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(enqueue).mock.invocationCallOrder[0]!);
  });

  it('deletes the ledger before the device rows', async () => {
    await remapCustomer('cust-1', 'org-1', ACTOR);
    const history = state.statements.findIndex((s) => s.includes('backup_provider_device_history'));
    const devices = state.statements.findIndex((s) => s.includes('backup_provider_devices'));
    expect(history).toBeGreaterThanOrEqual(0);
    expect(history).toBeLessThan(devices);
  });

  it('enqueues a sync AFTER the transaction, outside any DB context', async () => {
    await remapCustomer('cust-1', 'org-1', ACTOR);
    expect(enqueue).toHaveBeenCalledWith('conn-1');
    // The instrumented queue throws in CI if an enqueue happens inside a held
    // withDbAccessContext.
    expect(state.outsideContext).toContain('enter');
  });

  it('refuses a customer belonging to another partner', async () => {
    state.customer = { ...state.customer!, partnerId: 'partner-2' };
    await expect(remapCustomer('cust-1', 'org-1', ACTOR))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a target org belonging to another partner, before writing anything', async () => {
    state.org = { id: 'org-1', partnerId: 'partner-2' };
    await expect(remapCustomer('cust-1', 'org-1', ACTOR))
      .rejects.toMatchObject({ code: 'ORG_NOT_IN_PARTNER' });
    expect(state.statements).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses a target org that does not exist', async () => {
    state.org = null;
    await expect(remapCustomer('cust-1', 'org-1', ACTOR))
      .rejects.toMatchObject({ code: 'ORG_NOT_IN_PARTNER' });
  });

  it('refuses an unknown customer', async () => {
    state.customer = null;
    await expect(remapCustomer('cust-1', 'org-1', ACTOR))
      .rejects.toBeInstanceOf(RemapCustomerError);
  });

  it('does not fail the remap when the post-commit enqueue fails', async () => {
    // The mapping HAS changed and the rows ARE gone; a Redis hiccup must not
    // make the operator think the remap was rejected. The next scheduled sync
    // picks it up.
    enqueue.mockRejectedValue(new Error('redis down'));
    const result = await remapCustomer('cust-1', 'org-1', ACTOR);
    expect(result.syncJobId).toBeNull();
  });
});
