import { createHash } from 'crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'id',
    orgId: 'orgId',
    hostname: 'hostname',
    agentId: 'agentId',
    agentTokenHash: 'agentTokenHash',
    previousTokenHash: 'previousTokenHash',
    previousTokenExpiresAt: 'previousTokenExpiresAt',
    tokenIssuedAt: 'tokenIssuedAt',
    updatedAt: 'updatedAt',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('./helpers', () => ({
  generateApiKey: vi.fn(() => 'brz_rotated_token'),
}));

import { db } from '../../db';
import { writeAuditEvent } from '../../services/auditEvents';
import { generateApiKey } from './helpers';
import { tokenRoutes } from './token';

function buildApp(): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent', {
      deviceId: 'device-1',
      orgId: 'org-1',
      agentId: 'agent-123',
      siteId: 'site-1',
    });
    await next();
  });
  app.route('/agents', tokenRoutes);
  return app;
}

describe('agent token rotation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T18:45:00.000Z'));

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([
            {
              id: 'device-1',
              orgId: 'org-1',
              hostname: 'host-1',
              agentTokenHash: 'old-token-hash',
            },
          ]),
        })),
      })),
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rotates the token and returns the new plaintext token', async () => {
    const set = vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    }));
    vi.mocked(db.update).mockReturnValue({ set } as any);

    const response = await buildApp().request('/agents/agent-123/rotate-token', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authToken: 'brz_rotated_token',
      rotatedAt: '2026-03-31T18:45:00.000Z',
    });

    expect(generateApiKey).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      previousTokenHash: 'old-token-hash',
      previousTokenExpiresAt: new Date('2026-03-31T18:50:00.000Z'),
      agentTokenHash: createHash('sha256').update('brz_rotated_token').digest('hex'),
      tokenIssuedAt: new Date('2026-03-31T18:45:00.000Z'),
      updatedAt: new Date('2026-03-31T18:45:00.000Z'),
    });

    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-1',
        actorType: 'agent',
        actorId: 'agent-123',
        action: 'agent.token.rotate',
        resourceType: 'device',
        resourceId: 'device-1',
        resourceName: 'host-1',
        details: {
          rotatedAt: '2026-03-31T18:45:00.000Z',
          previousTokenGracePeriodSeconds: 300,
        },
      })
    );
  });

  it('returns 404 when the authenticated device record is not found', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    } as any);

    const response = await buildApp().request('/agents/agent-123/rotate-token', {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Device not found' });
    expect(db.update).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('returns 500 when the token update fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn().mockRejectedValue(new Error('db unavailable')),
      })),
    } as any);

    const response = await buildApp().request('/agents/agent-123/rotate-token', {
      method: 'POST',
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to rotate agent token' });
    expect(writeAuditEvent).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
