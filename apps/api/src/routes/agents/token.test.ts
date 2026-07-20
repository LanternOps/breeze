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
    pendingTokenHash: 'pendingTokenHash',
    pendingWatchdogTokenHash: 'pendingWatchdogTokenHash',
    pendingHelperTokenHash: 'pendingHelperTokenHash',
    pendingTokenExpiresAt: 'pendingTokenExpiresAt',
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

function buildApp(opts?: {
  rotationRequired?: boolean;
  /** Issue #2621 — caller authenticated with a staged (pending) credential. */
  pendingTokenPresented?: boolean;
  authTokenHash?: string;
  // Force the middleware to set an agent context with NO authTokenHash, so the
  // fail-closed `if (!authTokenHash) return 401` guard becomes reachable. The
  // default `?? CURRENT_AGENT_TOKEN_HASH` fallback would otherwise always
  // supply a truthy hash and mask that branch.
  omitAuthTokenHash?: boolean;
}): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent', {
      deviceId: 'device-1',
      orgId: 'org-1',
      agentId: 'agent-123',
      siteId: 'site-1',
      role: 'agent',
      authTokenHash: opts?.omitAuthTokenHash
        ? undefined
        : (opts?.authTokenHash ?? CURRENT_AGENT_TOKEN_HASH),
    });
    c.set('agentTokenRotationRequired', opts?.rotationRequired ?? false);
    c.set('agentPendingTokenPresented', opts?.pendingTokenPresented ?? false);
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

  // Issue #2621 — rotation STAGES the new credentials. It must not touch the
  // current agent/watchdog/helper hashes: those stay authoritative until the
  // agent proves it durably persisted the replacements. Committing here is what
  // stranded agents whose config.Save failed.
  it('stages the new credentials without committing them as current', async () => {
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
      confirmationRequired: true,
      pendingExpiresAt: '2026-03-31T19:45:00.000Z',
    });

    // The UPDATE is compare-and-swapped against the hash that authenticated
    // this request — devices.agentTokenHash = <authenticating current hash>.
    expect(eq).toHaveBeenCalledWith('agentTokenHash', CURRENT_AGENT_TOKEN_HASH);
    expect(where).toHaveBeenCalledTimes(1);

    expect(generateApiKey).toHaveBeenCalledTimes(3);
    expect(set).toHaveBeenCalledWith({
      pendingTokenHash: createHash('sha256').update('brz_rotated_agent_token').digest('hex'),
      pendingWatchdogTokenHash: createHash('sha256').update('brz_rotated_watchdog_token').digest('hex'),
      pendingHelperTokenHash: createHash('sha256').update('brz_rotated_helper_token').digest('hex'),
      pendingTokenExpiresAt: new Date('2026-03-31T19:45:00.000Z'),
      updatedAt: new Date('2026-03-31T18:45:00.000Z'),
    });

    // Explicitly assert the fields that MUST NOT move during staging. If any of
    // these ever reappear here, the persist-before-commit ordering is broken and
    // #2621 is back.
    const staged = (set.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
    for (const forbidden of [
      'agentTokenHash',
      'watchdogTokenHash',
      'helperTokenHash',
      'previousTokenHash',
      'tokenIssuedAt',
    ]) {
      expect(staged).not.toHaveProperty(forbidden);
    }

    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-1',
        actorType: 'agent',
        actorId: 'agent-123',
        action: 'agent.token.rotate.staged',
        resourceType: 'device',
        resourceId: 'device-1',
        resourceName: 'host-1',
        details: {
          stagedAt: '2026-03-31T18:45:00.000Z',
          pendingExpiresAt: '2026-03-31T19:45:00.000Z',
        },
      })
    );
  });

  it('refuses to start a new rotation while one is staged but unconfirmed', async () => {
    const response = await buildApp({ pendingTokenPresented: true }).request(
      '/agents/agent-123/rotate-token',
      { method: 'POST' }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Confirm the pending rotation before starting a new one',
      code: 'pending_rotation_unconfirmed',
    });
    expect(db.update).not.toHaveBeenCalled();
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

  it('returns 401 and mints nothing when the authenticating token hash is absent', async () => {
    // Fail-closed guard: without the middleware-supplied authTokenHash the
    // compare-and-swap has nothing to bind to, so rotation must be refused
    // BEFORE any credential mint, DB read/write, or audit — never run an
    // UPDATE that isn't bound to the caller's token.
    const response = await buildApp({ omitAuthTokenHash: true }).request(
      '/agents/agent-123/rotate-token',
      { method: 'POST' }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Missing authenticated token binding',
    });

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

// Issue #2621 — phase two. Promotion is gated on the agent presenting the
// STAGED token, which is the endpoint's proof that it durably persisted the
// credential. Without that gate the server would again be committing hashes on
// faith, which is the original bug.
describe('agent token rotation confirm route', () => {
  const PENDING_HASH = 'pending-agent-token-hash';

  function mockDevice(overrides: Record<string, unknown> = {}) {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([
            {
              id: 'device-1',
              hostname: 'host-1',
              agentTokenHash: 'old-token-hash',
              watchdogTokenHash: 'old-watchdog-token-hash',
              helperTokenHash: 'old-helper-token-hash',
              pendingTokenHash: PENDING_HASH,
              pendingWatchdogTokenHash: 'pending-watchdog-token-hash',
              pendingHelperTokenHash: 'pending-helper-token-hash',
              pendingTokenExpiresAt: new Date('2026-03-31T19:45:00.000Z'),
              ...overrides,
            },
          ]),
        })),
      })),
    } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T18:45:00.000Z'));
    mockDevice();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('promotes the staged credentials when the caller presents the staged token', async () => {
    const where = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: 'device-1' }]),
    }));
    const set = vi.fn(() => ({ where }));
    vi.mocked(db.update).mockReturnValue({ set } as any);

    const response = await buildApp({ authTokenHash: PENDING_HASH }).request(
      '/agents/agent-123/rotate-token/confirm',
      { method: 'POST' }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      confirmed: true,
      confirmedAt: '2026-03-31T18:45:00.000Z',
    });

    expect(set).toHaveBeenCalledWith({
      previousTokenHash: 'old-token-hash',
      previousTokenExpiresAt: new Date('2026-03-31T18:50:00.000Z'),
      agentTokenHash: PENDING_HASH,
      tokenIssuedAt: new Date('2026-03-31T18:45:00.000Z'),
      previousWatchdogTokenHash: 'old-watchdog-token-hash',
      previousWatchdogTokenExpiresAt: new Date('2026-03-31T18:50:00.000Z'),
      watchdogTokenHash: 'pending-watchdog-token-hash',
      watchdogTokenIssuedAt: new Date('2026-03-31T18:45:00.000Z'),
      previousHelperTokenHash: 'old-helper-token-hash',
      previousHelperTokenExpiresAt: new Date('2026-03-31T18:50:00.000Z'),
      helperTokenHash: 'pending-helper-token-hash',
      helperTokenIssuedAt: new Date('2026-03-31T18:45:00.000Z'),
      pendingTokenHash: null,
      pendingWatchdogTokenHash: null,
      pendingHelperTokenHash: null,
      pendingTokenExpiresAt: null,
      updatedAt: new Date('2026-03-31T18:45:00.000Z'),
    });

    // The promotion CAS binds to the staged hash so a stale confirm cannot
    // promote a credential set that has since been re-staged.
    expect(eq).toHaveBeenCalledWith('pendingTokenHash', PENDING_HASH);

    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'agent.token.rotate.confirmed' })
    );
  });

  // A confirm arriving on the OLD token proves nothing about what the endpoint
  // wrote to disk. Promoting on it would recreate #2621 exactly.
  it('refuses to promote when the caller presents the current (not staged) token', async () => {
    const response = await buildApp({ authTokenHash: 'old-token-hash' }).request(
      '/agents/agent-123/rotate-token/confirm',
      { method: 'POST' }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Confirm must be sent with the pending rotation token',
      code: 'pending_token_required',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses to promote an expired staged set', async () => {
    mockDevice({ pendingTokenExpiresAt: new Date('2026-03-31T18:00:00.000Z') });

    const response = await buildApp({ authTokenHash: PENDING_HASH }).request(
      '/agents/agent-123/rotate-token/confirm',
      { method: 'POST' }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Pending rotation has expired; request a new rotation',
      code: 'pending_rotation_expired',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  // The agent retries confirmation until it succeeds. A retry whose predecessor
  // actually landed must read as success, or a healthy device retries forever.
  it('is idempotent when the rotation was already promoted', async () => {
    mockDevice({
      agentTokenHash: PENDING_HASH,
      pendingTokenHash: null,
      pendingWatchdogTokenHash: null,
      pendingHelperTokenHash: null,
      pendingTokenExpiresAt: null,
    });

    const response = await buildApp({ authTokenHash: PENDING_HASH }).request(
      '/agents/agent-123/rotate-token/confirm',
      { method: 'POST' }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      confirmed: true,
      alreadyCurrent: true,
    });
    expect(db.update).not.toHaveBeenCalled();
  });
});
