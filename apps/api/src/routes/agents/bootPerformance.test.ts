import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
  discoveredAssetTypeEnum: { enumValues: ['workstation', 'server', 'printer', 'unknown'] },
}));

import { db } from '../../db';
import { bootPerformanceRoutes } from './bootPerformance';

describe('agent boot performance route', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    // Simulate agentAuthMiddleware setting the main-agent credential so the
    // requireAgentRole guard on bootPerformanceRoutes lets ingest tests through.
    app.use('*', async (c, next) => {
      c.set('agent', { deviceId: 'dev-1', agentId: 'agent-1', orgId: 'org-1', siteId: 'site-1', role: 'agent' } as never);
      return next();
    });
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


describe('boot-performance ingest — requireAgentRole gate (F8)', () => {
  it('rejects a watchdog-role token with 403', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', { deviceId: 'dev-1', agentId: 'agent-1', orgId: 'org-1', siteId: 'site-1', role: 'watchdog' } as never);
      return next();
    });
    app.route('/agents', bootPerformanceRoutes);
    const res = await app.request('/agents/dev-1/boot-performance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});
