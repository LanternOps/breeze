import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
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
