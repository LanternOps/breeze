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

describe('agent software inventory observation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes authenticated device identity and a validated v2 report to the acceptance service', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1', agentVersion: '0.105.1' });
    vi.mocked(ingestSoftwareInventoryReport).mockResolvedValue({
      observationId: V2_REPORT.observationId,
      acceptedForInventory: true,
      absenceResolutionEligible: true,
      reasonCode: 'accepted_complete',
      visibleItemCount: 1,
    });

    const res = await makeApp().request('/agents/agent-1/software', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(V2_REPORT),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      observationId: V2_REPORT.observationId,
      acceptedForInventory: true,
      absenceResolutionEligible: true,
      reasonCode: 'accepted_complete',
      visibleItemCount: 1,
    });
    expect(ingestSoftwareInventoryReport).toHaveBeenCalledWith(expect.objectContaining({
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '0.105.1' },
      report: V2_REPORT,
    }));
  });

  it('returns 400 for malformed source accounting without calling the service', async () => {
    const res = await makeApp().request('/agents/agent-1/software', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...V2_REPORT, expectedSources: ['a', 'b'], succeededSources: ['a'] }),
    });
    expect(res.status).toBe(400);
    expect(ingestSoftwareInventoryReport).not.toHaveBeenCalled();
  });

  it('returns 404 and does not retain evidence when authenticated agent identity is unknown', async () => {
    mockDeviceLookup(null);
    const res = await makeApp().request('/agents/agent-1/software', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(V2_REPORT),
    });
    expect(res.status).toBe(404);
    expect(ingestSoftwareInventoryReport).not.toHaveBeenCalled();
  });

  it('maps an observation identity collision to a stable 409', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1', agentVersion: '0.105.1' });
    vi.mocked(ingestSoftwareInventoryReport).mockRejectedValue(
      new SoftwareInventoryObservationConflictError(),
    );
    const res = await makeApp().request('/agents/agent-1/software', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(V2_REPORT),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Software inventory observation conflict' });
  });
});

vi.mock('../../services/warrantySync', () => ({
  upsertAgentWarranty: vi.fn(),
}));

vi.mock('../../services/warrantyWorker', () => ({
  queueWarrantySyncForDevice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/softwareInventoryObservations', () => ({
  ingestSoftwareInventoryReport: vi.fn(),
  SoftwareInventoryObservationConflictError: class SoftwareInventoryObservationConflictError extends Error {},
}));

import { db } from '../../db';
import { queueWarrantySyncForDevice } from '../../services/warrantyWorker';
import {
  ingestSoftwareInventoryReport,
  SoftwareInventoryObservationConflictError,
} from '../../services/softwareInventoryObservations';
import { inventoryRoutes } from './inventory';

const V2_REPORT = {
  schemaVersion: 2,
  observationId: '11111111-1111-4111-8111-111111111111',
  collectorVersion: '0.105.1',
  observedAt: '2026-08-24T12:00:00.000Z',
  completeness: 'complete',
  expectedSources: ['windows:registry:hklm64'],
  succeededSources: ['windows:registry:hklm64'],
  failedSources: [],
  truncated: false,
  itemCount: 1,
  items: [{ name: 'Breeze Agent', version: '0.105.1' }],
} as const;

function mockDeviceLookup(device: { id: string; orgId: string; agentVersion?: string | null } | null) {
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
