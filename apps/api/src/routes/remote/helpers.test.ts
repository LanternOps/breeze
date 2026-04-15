import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { logSessionAudit } from './helpers';

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
