import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Use the real schema (cheap table-definition objects) so the transitive
// service import graph (warranty -> configuration/discovery policies) resolves
// without enumerating every export. The db client itself is fully mocked above.
vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

vi.mock('../../services/warrantySync', () => ({
  upsertAgentWarranty: vi.fn(),
}));

vi.mock('../../services/warrantyWorker', () => ({
  queueWarrantySyncForDevice: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '../../db';
import { queueWarrantySyncForDevice } from '../../services/warrantyWorker';
import { inventoryRoutes } from './inventory';

function mockDeviceLookup(device: { id: string; orgId: string } | null) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(device ? [device] : []),
      }),
    }),
  } as any);
}

function mockPriorHardware(row: { manufacturer?: string | null; serialNumber?: string | null } | null) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  } as any);
}

function mockHardwareUpsert() {
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  } as any);
}

function makeApp() {
  const app = new Hono();
  app.use('*', async (c: any, next: any) => {
    c.set('agent', { orgId: 'org-1', agentId: 'agent-1', role: 'agent' });
    await next();
  });
  app.route('/agents', inventoryRoutes);
  return app;
}

async function postHardware(app: Hono, body: Record<string, unknown>) {
  return app.request('/agents/agent-1/hardware', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const DELL = { manufacturer: 'Dell Inc.', serialNumber: '3S0HXB4', model: 'Dell Pro Slim QCS1250' };

describe('agent hardware inventory — warranty sync re-trigger (#1732)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues warranty sync when identity transitions empty -> populated (no prior row)', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    mockPriorHardware(null); // first hardware report — no existing row
    mockHardwareUpsert();

    const res = await postHardware(makeApp(), DELL);

    expect(res.status).toBe(200);
    expect(queueWarrantySyncForDevice).toHaveBeenCalledTimes(1);
    expect(queueWarrantySyncForDevice).toHaveBeenCalledWith('device-1');
  });

  it('enqueues warranty sync when prior row lacked manufacturer/serial', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    mockPriorHardware({ manufacturer: null, serialNumber: null });
    mockHardwareUpsert();

    const res = await postHardware(makeApp(), DELL);

    expect(res.status).toBe(200);
    expect(queueWarrantySyncForDevice).toHaveBeenCalledTimes(1);
  });

  it('enqueues when prior row had manufacturer but no serial (partial -> full)', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    mockPriorHardware({ manufacturer: 'Dell Inc.', serialNumber: null });
    mockHardwareUpsert();

    const res = await postHardware(makeApp(), DELL);

    expect(res.status).toBe(200);
    expect(queueWarrantySyncForDevice).toHaveBeenCalledTimes(1);
  });

  it('enqueues when prior row had serial but no manufacturer (partial -> full)', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    mockPriorHardware({ manufacturer: null, serialNumber: '3S0HXB4' });
    mockHardwareUpsert();

    const res = await postHardware(makeApp(), DELL);

    expect(res.status).toBe(200);
    expect(queueWarrantySyncForDevice).toHaveBeenCalledTimes(1);
  });

  it('does NOT enqueue on a routine re-report when identity was already known', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    mockPriorHardware({ manufacturer: 'Dell Inc.', serialNumber: '3S0HXB4' });
    mockHardwareUpsert();

    const res = await postHardware(makeApp(), DELL);

    expect(res.status).toBe(200);
    expect(queueWarrantySyncForDevice).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when the new report has manufacturer but no serial', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    mockPriorHardware(null);
    mockHardwareUpsert();

    const res = await postHardware(makeApp(), { manufacturer: 'Dell Inc.', model: 'X' });

    expect(res.status).toBe(200);
    expect(queueWarrantySyncForDevice).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when the new report has serial but no manufacturer', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    mockPriorHardware(null);
    mockHardwareUpsert();

    const res = await postHardware(makeApp(), { serialNumber: '3S0HXB4', model: 'X' });

    expect(res.status).toBe(200);
    expect(queueWarrantySyncForDevice).not.toHaveBeenCalled();
  });

  it('returns 404 and does not enqueue when device is not found', async () => {
    mockDeviceLookup(null);

    const res = await postHardware(makeApp(), DELL);

    expect(res.status).toBe(404);
    expect(db.insert).not.toHaveBeenCalled();
    expect(queueWarrantySyncForDevice).not.toHaveBeenCalled();
  });

  it('still returns 200 when warranty enqueue rejects (fire-and-forget)', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    mockPriorHardware(null);
    mockHardwareUpsert();
    vi.mocked(queueWarrantySyncForDevice).mockRejectedValueOnce(new Error('redis down'));

    const res = await postHardware(makeApp(), DELL);

    expect(res.status).toBe(200);
    expect(queueWarrantySyncForDevice).toHaveBeenCalledTimes(1);
  });
});

// The software report wipes and reinserts software_inventory rows. Vuln
// findings reference those rows (FK now ON DELETE SET NULL — BREEZE-3), and
// the fleet aggregation layer displays a NULL-linked finding as an OS finding,
// so the route must re-point each finding at the replacement row for the same
// (name, vendor).
describe('agent software inventory — vuln finding re-link (BREEZE-3)', () => {
  type TxUpdateCall = { set?: Record<string, unknown>; where?: unknown };

  function mockSoftwareTx(opts: {
    linkedFindings: Array<{ findingId: string; name: string; vendor: string | null }>;
    replacementRows: Array<{ id: string; name: string; vendor: string | null }>;
  }) {
    const updateCalls: TxUpdateCall[] = [];
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const tx = {
      // Two select shapes: the linked-findings join
      // (select().from().innerJoin().where()) and the post-insert replacement
      // row lookup (select().from().where()).
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(opts.linkedFindings),
          }),
          where: vi.fn().mockResolvedValue(opts.replacementRows),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: deleteWhere }),
      insert: vi.fn().mockReturnValue({ values: insertValues }),
      update: vi.fn(() => {
        const call: TxUpdateCall = {};
        updateCalls.push(call);
        return {
          set: vi.fn((set: Record<string, unknown>) => {
            call.set = set;
            return {
              where: vi.fn((where: unknown) => {
                call.where = where;
                return Promise.resolve(undefined);
              }),
            };
          }),
        };
      }),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
    return { tx, updateCalls, deleteWhere, insertValues };
  }

  async function putSoftware(app: Hono, software: Array<Record<string, unknown>>) {
    return app.request('/agents/agent-1/software', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ software }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-links findings to the replacement rows matching (name, vendor)', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    const { tx, updateCalls } = mockSoftwareTx({
      linkedFindings: [
        { findingId: 'finding-1', name: 'Google Chrome', vendor: 'Google LLC' },
        { findingId: 'finding-2', name: 'Google Chrome', vendor: 'Google LLC' },
        { findingId: 'finding-3', name: '7-Zip', vendor: null },
      ],
      replacementRows: [
        { id: 'sw-new-1', name: 'Google Chrome', vendor: 'Google LLC' },
        { id: 'sw-new-2', name: '7-Zip', vendor: null },
      ],
    });

    const res = await putSoftware(makeApp(), [
      { name: 'Google Chrome', version: '127.0', vendor: 'Google LLC' },
      { name: '7-Zip', version: '24.06' },
    ]);

    expect(res.status).toBe(200);
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    // One UPDATE per replacement row; both Chrome findings batched together.
    expect(updateCalls).toHaveLength(2);
    const sets = updateCalls.map((c) => c.set?.softwareInventoryId).sort();
    expect(sets).toEqual(['sw-new-1', 'sw-new-2']);
  });

  it('re-links across casing/whitespace changes in name and vendor (correlation-normalized matching)', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    const { updateCalls } = mockSoftwareTx({
      linkedFindings: [
        { findingId: 'finding-1', name: 'GOOGLE Chrome ', vendor: 'GOOGLE LLC' },
      ],
      replacementRows: [
        { id: 'sw-new-1', name: 'Google Chrome', vendor: ' Google LLC' },
      ],
    });

    const res = await putSoftware(makeApp(), [
      { name: 'Google Chrome', vendor: ' Google LLC' },
    ]);

    expect(res.status).toBe(200);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.set?.softwareInventoryId).toBe('sw-new-1');
  });

  it('does not match on name alone when the vendor differs', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    const { updateCalls } = mockSoftwareTx({
      linkedFindings: [
        { findingId: 'finding-1', name: 'Agent', vendor: 'Vendor A' },
      ],
      replacementRows: [
        { id: 'sw-new-1', name: 'Agent', vendor: 'Vendor B' },
      ],
    });

    const res = await putSoftware(makeApp(), [{ name: 'Agent', vendor: 'Vendor B' }]);

    expect(res.status).toBe(200);
    expect(updateCalls).toHaveLength(0);
  });

  it('leaves findings for uninstalled software unlinked (resolved by next correlation pass)', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    const { updateCalls } = mockSoftwareTx({
      linkedFindings: [
        { findingId: 'finding-1', name: 'Old App', vendor: 'Gone Inc.' },
      ],
      replacementRows: [
        { id: 'sw-new-1', name: 'Google Chrome', vendor: 'Google LLC' },
      ],
    });

    const res = await putSoftware(makeApp(), [
      { name: 'Google Chrome', vendor: 'Google LLC' },
    ]);

    expect(res.status).toBe(200);
    expect(updateCalls).toHaveLength(0);
  });

  it('skips re-linking entirely when the device has no linked findings', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    const { tx, updateCalls } = mockSoftwareTx({
      linkedFindings: [],
      replacementRows: [{ id: 'sw-new-1', name: 'Google Chrome', vendor: 'Google LLC' }],
    });

    const res = await putSoftware(makeApp(), [
      { name: 'Google Chrome', vendor: 'Google LLC' },
    ]);

    expect(res.status).toBe(200);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(updateCalls).toHaveLength(0);
  });

  it('handles an empty software list: wipes rows, inserts nothing, re-links nothing', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    const { tx, updateCalls } = mockSoftwareTx({
      linkedFindings: [
        { findingId: 'finding-1', name: 'Google Chrome', vendor: 'Google LLC' },
      ],
      replacementRows: [],
    });

    const res = await putSoftware(makeApp(), []);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, count: 0 });
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it('returns 404 without opening a transaction when the device is unknown', async () => {
    mockDeviceLookup(null);

    const res = await putSoftware(makeApp(), [{ name: 'Google Chrome' }]);

    expect(res.status).toBe(404);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
