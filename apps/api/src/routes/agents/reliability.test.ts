import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  }
}));

vi.mock('../../db/schema', () => ({
  deviceReliabilityHistory: {},
  devices: {
    id: 'id',
    orgId: 'orgId',
    agentId: 'agentId',
  },
}));

vi.mock('../../jobs/reliabilityWorker', () => ({
  enqueueDeviceReliabilityComputation: vi.fn(),
}));

vi.mock('../../services/reliabilityScoring', () => ({
  computeAndPersistDeviceReliability: vi.fn(),
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

import { db } from '../../db';
import { reliabilityRoutes } from './reliability';
import { enqueueDeviceReliabilityComputation } from '../../jobs/reliabilityWorker';
import { computeAndPersistDeviceReliability } from '../../services/reliabilityScoring';
import { captureException } from '../../services/sentry';

const payload = {
  uptimeSeconds: 3600,
  bootTime: '2026-02-20T10:00:00.000Z',
  crashEvents: [] as Array<unknown>,
  appHangs: [] as Array<unknown>,
  serviceFailures: [] as Array<unknown>,
  hardwareErrors: [] as Array<unknown>,
};

function buildApp(): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent', {
      orgId: 'org-1',
      agentId: 'agent-123',
    });
    await next();
  });
  app.route('/agents', reliabilityRoutes);
  return app;
}

describe('agent reliability ingestion route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ id: 'device-1', orgId: 'org-1' }]),
        })),
      })),
    } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  it('falls back to inline compute when queue enqueue fails', async () => {
    vi.mocked(enqueueDeviceReliabilityComputation).mockRejectedValue(new Error('queue unavailable'));
    vi.mocked(computeAndPersistDeviceReliability).mockResolvedValue(true);

    const app = buildApp();
    const response = await app.request('/agents/agent-123/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(enqueueDeviceReliabilityComputation)).toHaveBeenCalledWith('device-1');
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(expect.any(Error));
    expect(vi.mocked(computeAndPersistDeviceReliability)).toHaveBeenCalledWith('device-1');
  });

  it('does not use inline fallback when queue enqueue succeeds', async () => {
    vi.mocked(enqueueDeviceReliabilityComputation).mockResolvedValue('job-1');
    vi.mocked(computeAndPersistDeviceReliability).mockResolvedValue(true);

    const app = buildApp();
    const response = await app.request('/agents/agent-123/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(enqueueDeviceReliabilityComputation)).toHaveBeenCalledWith('device-1');
    expect(vi.mocked(computeAndPersistDeviceReliability)).not.toHaveBeenCalled();
  });

  it('returns 404 when device is not found by agentId', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    } as any);

    const app = buildApp();
    const response = await app.request('/agents/agent-unknown/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(404);
  });

  it('inserts reliability history with the correct device and org ids', async () => {
    vi.mocked(enqueueDeviceReliabilityComputation).mockResolvedValue('job-1');
    const insertValues = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const app = buildApp();
    await app.request('/agents/agent-123/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        orgId: 'org-1',
        uptimeSeconds: payload.uptimeSeconds,
      })
    );
  });

  it('returns success response body with expected shape', async () => {
    vi.mocked(enqueueDeviceReliabilityComputation).mockResolvedValue('job-1');

    const app = buildApp();
    const response = await app.request('/agents/agent-123/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, status: 'received' });
  });
});
