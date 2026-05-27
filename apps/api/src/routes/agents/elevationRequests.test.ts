import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'id',
    orgId: 'orgId',
    siteId: 'siteId',
    agentId: 'agentId',
  },
  elevationRequests: {
    id: 'id',
    status: 'status',
  },
}));

const mocks = vi.hoisted(() => ({
  rateLimiter: vi.fn(),
}));
vi.mock('../../services/rate-limit', () => ({
  rateLimiter: mocks.rateLimiter,
}));

vi.mock('../../services/redis', () => ({
  getRedis: () => ({}),
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: () => '203.0.113.7',
}));

import { db } from '../../db';
import { elevationRequestsRoutes } from './elevationRequests';
import { writeAuditEvent } from '../../services/auditEvents';

const goodPayload = {
  subject_username: 'alice',
  target_executable_path: 'C:\\Windows\\System32\\mmc.exe',
  target_executable_hash: 'deadbeef'.repeat(8),
  pid: 4321,
  parent_image: 'C:\\Windows\\explorer.exe',
  command_line: 'mmc.exe compmgmt.msc',
};

function buildApp(opts: { skipAuth?: boolean } = {}): Hono {
  const app = new Hono();
  if (!opts.skipAuth) {
    app.use('/agents/*', async (c, next) => {
      c.set('agent', {
        deviceId: 'device-1',
        orgId: 'org-1',
        agentId: 'agent-123',
        siteId: 'site-1',
        role: 'agent',
      });
      await next();
    });
  }
  app.route('/agents', elevationRequestsRoutes);
  return app;
}

function happyPathInsert(returningRows: Array<{ id: string; status: string }>) {
  const returning = vi.fn().mockResolvedValue(returningRows);
  const values = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.insert).mockReturnValue({ values } as any);
  return { returning, values };
}

describe('agent elevation-requests ingestion route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimiter.mockResolvedValue({
      allowed: true,
      remaining: 599,
      resetAt: new Date(Date.now() + 60_000),
    });
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([
            { id: 'device-1', orgId: 'org-1', siteId: 'site-1' },
          ]),
        })),
      })),
    } as any);
  });

  it('inserts an elevation request and returns id + status', async () => {
    const { values } = happyPathInsert([{ id: 'req-uuid', status: 'pending' }]);

    const app = buildApp();
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodPayload),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ id: 'req-uuid', status: 'pending' });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        orgId: 'org-1',
        flowType: 'uac_intercept',
        subjectUsername: 'alice',
        targetExecutablePath: 'C:\\Windows\\System32\\mmc.exe',
        status: 'pending',
        clientIp: '203.0.113.7',
      }),
    );
    expect(vi.mocked(writeAuditEvent)).toHaveBeenCalledOnce();
  });

  it('returns 404 when the agent_id does not match any device', async () => {
    happyPathInsert([{ id: 'req-uuid', status: 'pending' }]);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    } as any);

    const app = buildApp();
    const response = await app.request('/agents/agent-unknown/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodPayload),
    });

    expect(response.status).toBe(404);
  });

  it('returns 429 when the per-device rate limit is exceeded', async () => {
    mocks.rateLimiter.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });

    const app = buildApp();
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodPayload),
    });

    expect(response.status).toBe(429);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('returns 413 when Content-Length exceeds the 32 KB body cap', async () => {
    const app = buildApp();
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(64 * 1024),
      },
      body: JSON.stringify(goodPayload),
    });

    expect(response.status).toBe(413);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('rejects payloads missing required fields with 400', async () => {
    const app = buildApp();
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No subject_username
      body: JSON.stringify({
        target_executable_path: 'C:\\foo.exe',
      }),
    });

    expect(response.status).toBe(400);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('rejects target_executable_path that exceeds 4096 chars', async () => {
    const app = buildApp();
    const huge = 'C:\\' + 'a'.repeat(4100);
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...goodPayload, target_executable_path: huge }),
    });
    expect(response.status).toBe(400);
  });

  it('accepts minimal payload (only required fields)', async () => {
    happyPathInsert([{ id: 'req-min', status: 'pending' }]);

    const app = buildApp();
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject_username: 'svc_acct',
        target_executable_path: '/usr/local/bin/foo',
      }),
    });

    expect(response.status).toBe(201);
  });

  it('uses observed_at from the payload when present', async () => {
    const { values } = happyPathInsert([{ id: 'req-uuid', status: 'pending' }]);

    const observedAt = '2026-05-20T12:00:00.000Z';
    const app = buildApp();
    const response = await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...goodPayload, observed_at: observedAt }),
    });

    expect(response.status).toBe(201);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedAt: new Date(observedAt),
      }),
    );
  });

  it('rate-limit key is scoped per device, not per agentId in URL', async () => {
    happyPathInsert([{ id: 'req-uuid', status: 'pending' }]);

    const app = buildApp();
    await app.request('/agents/agent-123/elevation-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodPayload),
    });

    expect(mocks.rateLimiter).toHaveBeenCalledWith(
      expect.anything(),
      'elevation:rate:device:device-1',
      600,
      60,
    );
  });
});
