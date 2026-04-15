import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insert, insertValues, withDbAccessContext, captureException } = vi.hoisted(() => {
  const insertValues = vi.fn(() => Promise.resolve());
  const insert = vi.fn(() => ({ values: insertValues }));
  // Capture the context passed to withDbAccessContext so we can assert it
  // matches the org scope of the session being audited.
  const withDbAccessContext = vi.fn(
    async (_ctx: unknown, fn: () => unknown) => fn()
  );
  const captureException = vi.fn();
  return { insert, insertValues, withDbAccessContext, captureException };
});

vi.mock('../../db', () => ({
  db: { insert },
  withDbAccessContext
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
  it('wraps the insert in an org-scoped DB access context', async () => {
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

    expect(withDbAccessContext).toHaveBeenCalledTimes(1);
    const firstCall = withDbAccessContext.mock.calls[0]!;
    expect(firstCall[0]).toEqual({
      scope: 'organization',
      orgId,
      accessibleOrgIds: [orgId]
    });

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
