import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  inspectDesktopFinalizationMock,
  reconcileDesktopFinalizationFenceMock,
  runOutsideDbContextMock,
} = vi.hoisted(() => ({
  inspectDesktopFinalizationMock: vi.fn(),
  reconcileDesktopFinalizationFenceMock: vi.fn(),
  runOutsideDbContextMock: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: runOutsideDbContextMock,
}));

vi.mock('../../services/desktopSessionFinalization', () => ({
  inspectDesktopFinalization: inspectDesktopFinalizationMock,
  reconcileDesktopFinalizationFence: reconcileDesktopFinalizationFenceMock,
}));

vi.mock('../../middleware/auth', () => ({
  requireMfa: vi.fn(() => async (c: any, next: () => Promise<void>) => {
    if (c.get('auth')?.token?.mfa !== true) {
      return c.json({ error: 'MFA required' }, 403);
    }
    await next();
  }),
}));

import { desktopFinalizationRoutes } from './desktopFinalization';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const FINALIZATION_ID = '22222222-2222-4222-8222-222222222222';

function appFor(auth: {
  user: { id: string; email: string; isPlatformAdmin: boolean };
  token: { mfa: boolean };
}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth as any);
    await next();
  });
  app.route('/desktop-finalizations', desktopFinalizationRoutes);
  return app;
}

describe('desktop finalization operator routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspectDesktopFinalizationMock.mockResolvedValue({
      state: 'none',
      sessionId: SESSION_ID,
      sessionStatus: 'disconnected',
    });
    reconcileDesktopFinalizationFenceMock.mockResolvedValue('retained');
  });

  it('requires MFA before inspect and performs no service call on denial', async () => {
    const app = appFor({
      user: { id: 'admin', email: 'admin@example.com', isPlatformAdmin: true },
      token: { mfa: false },
    });
    const response = await app.request(`/desktop-finalizations/${SESSION_ID}`);
    expect(response.status).toBe(403);
    expect(inspectDesktopFinalizationMock).not.toHaveBeenCalled();
  });

  it('returns a bounded inspection for the requested session', async () => {
    const serviceInspection = {
      state: 'persisted',
      intent: {
        input: {
          finalizationId: FINALIZATION_ID,
          version: 1,
          sessionId: SESSION_ID,
          orgId: '44444444-4444-4444-8444-444444444444',
          userId: '55555555-5555-4555-8555-555555555555',
          deviceId: '66666666-6666-4666-8666-666666666666',
          reason: 'socket_error',
          terminalStatus: 'failed',
          endedAt: '2026-07-25T12:00:10.000Z',
          startedAt: '2026-07-25T12:00:00.000Z',
          inputEvents: 7,
          frameBytes: 1024,
          connection: {
            connectionId: '77777777-7777-4777-8777-777777777777',
            generation: 9,
            instanceId: '88888888-8888-4888-8888-888888888888',
            leaseToken: '99999999-9999-4999-8999-999999999999',
          },
        },
        payloadSha256: 'a'.repeat(64),
      },
      jobState: 'failed',
      sessionStatus: 'active',
      stopState: 'confirmed',
    };
    inspectDesktopFinalizationMock.mockResolvedValue(serviceInspection);
    const app = appFor({
      user: { id: 'admin', email: 'admin@example.com', isPlatformAdmin: true },
      token: { mfa: true },
    });
    const response = await app.request(`/desktop-finalizations/${SESSION_ID}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: 'persisted',
      finalizationId: FINALIZATION_ID,
      payloadSha256: 'a'.repeat(64),
      payload: {
        version: 1,
        sessionId: SESSION_ID,
        orgId: '44444444-4444-4444-8444-444444444444',
        userId: '55555555-5555-4555-8555-555555555555',
        deviceId: '66666666-6666-4666-8666-666666666666',
        reason: 'socket_error',
        terminalStatus: 'failed',
        endedAt: '2026-07-25T12:00:10.000Z',
        startedAt: '2026-07-25T12:00:00.000Z',
        inputEvents: 7,
        frameBytes: 1024,
      },
      jobState: 'failed',
      sessionStatus: 'active',
      stopState: 'confirmed',
    });
    expect(inspectDesktopFinalizationMock).toHaveBeenCalledWith(SESSION_ID);
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
  });

  it('rejects missing change ticket and never reconciles', async () => {
    const app = appFor({
      user: { id: 'admin', email: 'admin@example.com', isPlatformAdmin: true },
      token: { mfa: true },
    });
    const response = await app.request(
      `/desktop-finalizations/${SESSION_ID}/reconcile`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedFinalizationId: FINALIZATION_ID }),
      },
    );
    expect(response.status).toBe(400);
    expect(reconcileDesktopFinalizationFenceMock).not.toHaveBeenCalled();
  });

  it('derives the operator from auth and never accepts caller-supplied actor identity', async () => {
    reconcileDesktopFinalizationFenceMock.mockResolvedValue('released');
    const app = appFor({
      user: {
        id: '33333333-3333-4333-8333-333333333333',
        email: 'admin@example.com',
        isPlatformAdmin: true,
      },
      token: { mfa: true },
    });
    const response = await app.request(
      `/desktop-finalizations/${SESSION_ID}/reconcile`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedFinalizationId: FINALIZATION_ID,
          changeTicket: 'SEC-1234',
          operatorUserId: 'attacker',
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(reconcileDesktopFinalizationFenceMock).not.toHaveBeenCalled();

    const accepted = await app.request(
      `/desktop-finalizations/${SESSION_ID}/reconcile`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedFinalizationId: FINALIZATION_ID,
          changeTicket: 'SEC:1234',
        }),
      },
    );
    expect(accepted.status).toBe(200);
    expect(reconcileDesktopFinalizationFenceMock).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      expectedFinalizationId: FINALIZATION_ID,
      operatorUserId: '33333333-3333-4333-8333-333333333333',
      operatorEmail: 'admin@example.com',
      changeTicket: 'SEC:1234',
    });
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
  });
});
