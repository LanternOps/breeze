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
    watchdogTokenHash: 'watchdogTokenHash',
    watchdogTokenIssuedAt: 'watchdogTokenIssuedAt',
    previousWatchdogTokenHash: 'previousWatchdogTokenHash',
    previousWatchdogTokenExpiresAt: 'previousWatchdogTokenExpiresAt',
    helperTokenHash: 'helperTokenHash',
    helperTokenIssuedAt: 'helperTokenIssuedAt',
    previousHelperTokenHash: 'previousHelperTokenHash',
    previousHelperTokenExpiresAt: 'previousHelperTokenExpiresAt',
    updatedAt: 'updatedAt',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('./helpers', () => ({
  generateApiKey: vi.fn(() => 'brz_rotated_token'),
}));

// Capture the drizzle condition builders so we can assert the rotate-token
// UPDATE is compare-and-swapped against the authenticating token hash.
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ __and: args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ __eq: [col, val] })),
}));

import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { writeAuditEvent } from '../../services/auditEvents';
import { generateApiKey } from './helpers';
import { tokenRoutes } from './token';

// Default hash the mocked middleware reports as the current-token hash.
const CURRENT_AGENT_TOKEN_HASH = 'current-agent-token-hash';

function buildApp(opts?: { rotationRequired?: boolean; authTokenHash?: string }): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent', {
      deviceId: 'device-1',
      orgId: 'org-1',
      agentId: 'agent-123',
      siteId: 'site-1',
      role: 'agent',
      authTokenHash: opts?.authTokenHash ?? CURRENT_AGENT_TOKEN_HASH,
    });
    c.set('agentTokenRotationRequired', opts?.rotationRequired ?? false);
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
              watchdogTokenHash: 'old-watchdog-token-hash',
              helperTokenHash: 'old-helper-token-hash',
            },
          ]),
        })),
      })),
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: 'device-1' }]),
        })),
      })),
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rotates the token and returns the new plaintext token', async () => {
    vi.mocked(generateApiKey)
      .mockReturnValueOnce('brz_rotated_agent_token')
      .mockReturnValueOnce('brz_rotated_watchdog_token')
      .mockReturnValueOnce('brz_rotated_helper_token');

    const where = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: 'device-1' }]),
    }));
    const set = vi.fn(() => ({ where }));
    vi.mocked(db.update).mockReturnValue({ set } as any);

    const response = await buildApp().request('/agents/agent-123/rotate-token', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authToken: 'brz_rotated_agent_token',
      watchdogAuthToken: 'brz_rotated_watchdog_token',
      helperAuthToken: 'brz_rotated_helper_token',
      rotatedAt: '2026-03-31T18:45:00.000Z',
    });

    // The UPDATE is compare-and-swapped against the hash that authenticated
    // this request — devices.agentTokenHash = <authenticating current hash>.
    expect(eq).toHaveBeenCalledWith('agentTokenHash', CURRENT_AGENT_TOKEN_HASH);
    expect(where).toHaveBeenCalledTimes(1);

    expect(generateApiKey).toHaveBeenCalledTimes(3);
    expect(set).toHaveBeenCalledWith({
      // previousTokenHash snapshots the authenticating (current-at-rotation) hash.
      previousTokenHash: CURRENT_AGENT_TOKEN_HASH,
      previousTokenExpiresAt: new Date('2026-03-31T18:50:00.000Z'),
      agentTokenHash: createHash('sha256').update('brz_rotated_agent_token').digest('hex'),
      tokenIssuedAt: new Date('2026-03-31T18:45:00.000Z'),
      previousWatchdogTokenHash: 'old-watchdog-token-hash',
      previousWatchdogTokenExpiresAt: new Date('2026-03-31T18:50:00.000Z'),
      watchdogTokenHash: createHash('sha256').update('brz_rotated_watchdog_token').digest('hex'),
      watchdogTokenIssuedAt: new Date('2026-03-31T18:45:00.000Z'),
      previousHelperTokenHash: 'old-helper-token-hash',
      previousHelperTokenExpiresAt: new Date('2026-03-31T18:50:00.000Z'),
      helperTokenHash: createHash('sha256').update('brz_rotated_helper_token').digest('hex'),
      helperTokenIssuedAt: new Date('2026-03-31T18:45:00.000Z'),
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
        where: vi.fn(() => ({
          returning: vi.fn().mockRejectedValue(new Error('db unavailable')),
        })),
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

  it('rejects a superseded (previous-token) caller and mints no tokens', async () => {
    // agentAuthMiddleware matched the PREVIOUS token during the grace window
    // and set agentTokenRotationRequired=true. A stolen superseded token must
    // not be able to renew itself into durable credentials.
    const response = await buildApp({ rotationRequired: true }).request(
      '/agents/agent-123/rotate-token',
      { method: 'POST' }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Rotate using the current token; superseded tokens cannot rotate',
    });

    // No credential mint, no DB read/write, no audit — rejected before any work.
    expect(generateApiKey).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('rejects with 409 and mints no tokens when the compare-and-swap matches zero rows', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Someone else rotated first (or the authenticating hash no longer matches
    // the stored current hash): the CAS UPDATE touches zero rows.
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
    } as any);

    const response = await buildApp().request('/agents/agent-123/rotate-token', {
      method: 'POST',
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: 'Token rotation conflict; re-authenticate with the current token',
    });

    // The freshly-minted plaintext tokens were never persisted, so they must
    // not be returned to the caller.
    expect(body.authToken).toBeUndefined();
    expect(body.watchdogAuthToken).toBeUndefined();
    expect(body.helperAuthToken).toBeUndefined();
    expect(writeAuditEvent).not.toHaveBeenCalled();

    consoleWarn.mockRestore();
  });
});
