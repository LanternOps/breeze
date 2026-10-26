import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * The warranty-info handler's explicit field selection (`inventory.ts:331-339`)
 * is a SECOND, independent drop point for anything the zod schema accepts: it
 * is a hand-written object literal, so a field can pass validation and still
 * never reach the service. #5511 W01 (D10).
 */
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

// Real schema objects (cheap table definitions) so the transitive service
// import graph resolves; the client itself is mocked above. Same rationale as
// `inventory.test.ts:15-21`.
vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

const upsertAgentWarrantyMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/warrantySync', () => ({
  upsertAgentWarranty: (...args: unknown[]) => upsertAgentWarrantyMock(...args),
}));

import { db } from '../../db';
import { inventoryRoutes } from './inventory';

function makeApp() {
  const app = new Hono();
  app.use('*', async (c: any, next: any) => {
    c.set('agent', { orgId: 'org-1', agentId: 'agent-1', role: 'agent' });
    await next();
  });
  app.route('/agents', inventoryRoutes);
  return app;
}

/** Two reads in order: the device row, then the hardware row for the serial. */
function rigReads(device: unknown[], hardware: unknown[]) {
  const queue = [device, hardware];
  vi.mocked(db.select).mockImplementation((() => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(queue.shift() ?? []) }) }),
  })) as never);
}

describe('PUT /agents/:id/warranty-info entitlements pass-through (#5511 W01, D10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertAgentWarrantyMock.mockResolvedValue(undefined);
  });

  it('forwards the entitlements array to the service', async () => {
    rigReads([{ id: 'device-1', orgId: 'org-1' }], [{ serialNumber: 'HP-SERIAL-1' }]);

    const res = await makeApp().request('/agents/agent-1/warranty-info', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'agent_cmsl',
        manufacturer: 'HP',
        coverageStartDate: '2024-03-01',
        coverageEndDate: '2027-02-28',
        entitlements: [
          { serviceLevelDescription: 'HP 3y NBD Onsite', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2027-02-28' },
          { serviceLevelDescription: 'HP Pickup and Return', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2026-02-28' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(upsertAgentWarrantyMock).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({
        source: 'agent_cmsl',
        // The serial always comes from device_hardware, never the payload.
        serialNumber: 'HP-SERIAL-1',
        entitlements: [
          { serviceLevelDescription: 'HP 3y NBD Onsite', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2027-02-28' },
          { serviceLevelDescription: 'HP Pickup and Return', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2026-02-28' },
        ],
      }),
    );
  });

  it('passes null when the collector reports none (macOS plist)', async () => {
    rigReads([{ id: 'device-1', orgId: 'org-1' }], [{ serialNumber: 'APPLE-1' }]);

    const res = await makeApp().request('/agents/agent-1/warranty-info', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'agent_plist', manufacturer: 'Apple', coverageType: 'AppleCare+' }),
    });

    expect(res.status).toBe(200);
    expect(upsertAgentWarrantyMock).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({ entitlements: null }),
    );
  });
});
