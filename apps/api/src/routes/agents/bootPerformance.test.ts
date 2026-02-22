import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'id',
    orgId: 'orgId',
    agentId: 'agentId',
  },
  deviceBootMetrics: {
    deviceId: 'device_id',
    bootTimestamp: 'boot_timestamp',
  },
}));

import { db } from '../../db';
import { bootPerformanceRoutes } from './bootPerformance';

describe('agent boot performance route', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/agents', bootPerformanceRoutes);
  });

  it('normalizes startup items and runs single-pass retention cleanup', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'device-1', orgId: 'org-1' }]),
        }),
      }),
    } as never);

    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    vi.mocked(db.insert).mockReturnValue({ values } as never);
    vi.mocked(db.execute).mockResolvedValue({} as never);

    const res = await app.request('/agents/agent-1/boot-performance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bootTimestamp: '2026-02-21T10:00:00.000Z',
        totalBootSeconds: 45.5,
        startupItems: [
          {
            name: 'Updater',
            type: 'service',
            path: '/usr/bin/updater',
            enabled: true,
            cpuTimeMs: 100,
            diskIoBytes: 2048,
            impactScore: 3.2,
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      startupItemCount: 1,
      startupItems: [expect.objectContaining({ itemId: 'service|/usr/bin/updater' })],
    }));
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});

