import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  insert,
  insertValues,
  runOutsideDbContext,
  withSystemDbAccessContext,
  captureException
} = vi.hoisted(() => {
  const insertValues = vi.fn(() => Promise.resolve());
  const insert = vi.fn(() => ({ values: insertValues }));
  // `runOutsideDbContext` is synchronous (wraps AsyncLocalStorage.exit); the
  // real impl just calls its argument outside the current context. The mock
  // passes through so we can assert ordering separately.
  const runOutsideDbContext = vi.fn(<T>(fn: () => T): T => fn());
  const withSystemDbAccessContext = vi.fn(async (fn: () => unknown) => fn());
  const captureException = vi.fn();
  return {
    insert,
    insertValues,
    runOutsideDbContext,
    withSystemDbAccessContext,
    captureException
  };
});

vi.mock('../../db', () => ({
  db: { insert },
  runOutsideDbContext,
  withSystemDbAccessContext
}));

vi.mock('../../db/schema', () => ({
  remoteSessions: {},
  fileTransfers: {},
  devices: {},
  auditLogs: { __table: 'audit_logs' }
}));

vi.mock('../../services/sentry', () => ({
  captureException
}));

import { generateTurnCredentials, getIceServers, getTurnCredentialTtlSeconds, logSessionAudit } from './helpers';

describe('logSessionAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression: the viewer-token desktop WS path has no request-scoped DB
  // context, so the audit insert was hitting `audit_logs` RLS and silently
  // failing. See issue #437.
  //
  // Follow-up: the fix must also isolate the audit write from the caller's
  // request transaction to avoid rolling back real work on audit failure.
  // See `services/auditService.ts` for the same pattern.
  it('runs outside the caller context and under a system DB scope', async () => {
    const orgId = '11111111-1111-1111-1111-111111111111';
    const actorId = '22222222-2222-2222-2222-222222222222';
    const sessionId = '33333333-3333-3333-3333-333333333333';

    await logSessionAudit(
      'session_offer_submitted',
      actorId,
      orgId,
      { sessionId, type: 'desktop', via: 'viewer_token' },
      '10.0.0.1'
    );

    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    // Ordering: runOutsideDbContext must wrap withSystemDbAccessContext so the
    // nested system-scope call actually opens a fresh tx on its own connection.
    const outsideOrder = runOutsideDbContext.mock.invocationCallOrder[0]!;
    const systemOrder = withSystemDbAccessContext.mock.invocationCallOrder[0]!;
    expect(outsideOrder).toBeLessThan(systemOrder);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId,
        actorType: 'user',
        actorId,
        action: 'session_offer_submitted',
        resourceType: 'remote_session',
        resourceId: sessionId,
        ipAddress: '10.0.0.1',
        result: 'success'
      })
    );
  });

  it('swallows insert errors so the request path is not broken, and escalates to Sentry', async () => {
    insertValues.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      logSessionAudit(
        'session_offer_submitted',
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
        { sessionId: '33333333-3333-3333-3333-333333333333' }
      )
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith('Failed to log session audit:', expect.any(Error));
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
    errSpy.mockRestore();
  });
});

describe('TURN credential helpers', () => {
  const originalTurnSecret = process.env.TURN_SECRET;
  const originalTurnHost = process.env.TURN_HOST;
  const originalTurnTtl = process.env.TURN_CREDENTIAL_TTL_SECONDS;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TURN_SECRET = 'test-turn-secret';
    process.env.TURN_HOST = 'turn.example.com';
    delete process.env.TURN_CREDENTIAL_TTL_SECONDS;
  });

  afterEach(() => {
    if (originalTurnSecret === undefined) delete process.env.TURN_SECRET;
    else process.env.TURN_SECRET = originalTurnSecret;
    if (originalTurnHost === undefined) delete process.env.TURN_HOST;
    else process.env.TURN_HOST = originalTurnHost;
    if (originalTurnTtl === undefined) delete process.env.TURN_CREDENTIAL_TTL_SECONDS;
    else process.env.TURN_CREDENTIAL_TTL_SECONDS = originalTurnTtl;
  });

  it('generates short-lived scoped usernames with nonce entropy', () => {
    const scope = {
      sessionId: '33333333-3333-4333-8333-333333333333',
      userId: '22222222-2222-4222-8222-222222222222',
      deviceId: '44444444-4444-4444-8444-444444444444',
    };

    const first = generateTurnCredentials(scope);
    const second = generateTurnCredentials(scope);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.ttlSeconds).toBe(600);
    expect(first!.username).toMatch(/^\d+:breeze:22222222-222\.33333333-333\.44444444-444\./);
    expect(second!.username).not.toBe(first!.username);
  });

  it('clamps configured TURN credential TTL to session-scale bounds', () => {
    process.env.TURN_CREDENTIAL_TTL_SECONDS = '86400';
    expect(getTurnCredentialTtlSeconds()).toBe(900);

    process.env.TURN_CREDENTIAL_TTL_SECONDS = '30';
    expect(getTurnCredentialTtlSeconds()).toBe(60);
  });

  it('only includes TURN credentials when a session scope is supplied', () => {
    expect(getIceServers().some((server) => Boolean(server.username))).toBe(false);

    const scoped = getIceServers({
      sessionId: '33333333-3333-4333-8333-333333333333',
      userId: '22222222-2222-4222-8222-222222222222',
      deviceId: '44444444-4444-4444-8444-444444444444',
    });

    expect(scoped.some((server) => Boolean(server.username && server.credential))).toBe(true);
  });
});
