/**
 * #7717 — platform-admin operator surface for stuck platform AI credit debits
 * and dead pending settlements. The money-safety properties (same key, same
 * amount on every re-drive) are proven against real Postgres in
 * aiInvocationSettlement.integration.test.ts; these tests pin the HTTP
 * contract: platform-admin on every verb, MFA on every mutation, validated
 * filters, status codes per outcome, and an audit row per mutation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const svc = vi.hoisted(() => ({
  listFailed: vi.fn(),
  requeue: vi.fn(),
  redrive: vi.fn(),
  replayDead: vi.fn(),
  listDead: vi.fn(),
}));

const { BillingServiceNotConfiguredError } = vi.hoisted(() => ({
  BillingServiceNotConfiguredError: class BillingServiceNotConfiguredError extends Error {},
}));

vi.mock('../../services/aiCreditDebits', () => ({
  BillingServiceNotConfiguredError,
  CREDIT_DEBIT_SOURCES: ['settlement', 'compute', 'invocation'],
  CREDIT_DEBIT_FAILURE_CLASSES: ['auth', 'retries_exhausted', 'org_partner_missing', 'rejected'],
  MAX_FAILED_CREDIT_DEBIT_PAGE: 500,
  listFailedPlatformCreditDebits: svc.listFailed,
  requeueFailedCreditDebits: svc.requeue,
  redriveFailedCreditDebit: svc.redrive,
  replayDeadPendingSettlement: svc.replayDead,
}));

vi.mock('../../services/aiBudgetReservations', () => ({
  listDeadPendingSettlements: svc.listDead,
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: vi.fn(async () => undefined),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth');
  const { HTTPException } = await import('hono/http-exception');
  return {
    ...actual,
    authMiddleware: vi.fn(async (c: any, next: () => Promise<void>) => {
      if (!c.get('auth')) throw new HTTPException(401, { message: 'Not authenticated' });
      await next();
    }),
  };
});

import { Hono } from 'hono';
import { adminRoutes } from './index';
import { createAuditLogAsync } from '../../services/auditService';

type FakeAuth = {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  token: { mfa: boolean };
};

const platformAdmin: FakeAuth = {
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
  token: { mfa: true },
};
const platformAdminNoMfa: FakeAuth = { ...platformAdmin, token: { mfa: false } };
const partnerAdmin: FakeAuth = {
  user: { id: 'pa-1', email: 'partner@x.com', name: 'Partner', isPlatformAdmin: false },
  token: { mfa: true },
};

function buildApp(auth: FakeAuth | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const ORG = '11111111-1111-4111-8111-111111111111';
const ROW_ID = '22222222-2222-4222-8222-222222222222';

function post(app: Hono, path: string, body: unknown) {
  return app.request(`/admin/ai-billing${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function auditActions(): string[] {
  return vi.mocked(createAuditLogAsync).mock.calls.map(([entry]) => (entry as { action: string }).action);
}

beforeEach(() => {
  vi.clearAllMocks();
  svc.listFailed.mockResolvedValue([]);
  svc.listDead.mockResolvedValue([]);
});

describe('authorization', () => {
  it('refuses a non-platform-admin on every verb', async () => {
    const app = buildApp(partnerAdmin);
    expect((await app.request('/admin/ai-billing/failed-debits')).status).toBe(403);
    expect((await app.request('/admin/ai-billing/dead-settlements')).status).toBe(403);
    expect((await post(app, '/failed-debits/redrive', { source: 'compute', id: ROW_ID })).status).toBe(403);
    expect((await post(app, '/failed-debits/requeue', { limit: 10, reason: 'rotated key' })).status).toBe(403);
    expect((await post(app, `/dead-settlements/${ROW_ID}/replay`, {})).status).toBe(403);
    expect(svc.redrive).not.toHaveBeenCalled();
    expect(svc.requeue).not.toHaveBeenCalled();
    expect(svc.replayDead).not.toHaveBeenCalled();
  });

  it('requires MFA on every mutation', async () => {
    const app = buildApp(platformAdminNoMfa);
    expect((await post(app, '/failed-debits/redrive', { source: 'compute', id: ROW_ID })).status).toBe(403);
    expect((await post(app, '/failed-debits/requeue', { limit: 10, reason: 'rotated key' })).status).toBe(403);
    expect((await post(app, `/dead-settlements/${ROW_ID}/replay`, {})).status).toBe(403);
    expect(svc.redrive).not.toHaveBeenCalled();
    expect(svc.requeue).not.toHaveBeenCalled();
    expect(svc.replayDead).not.toHaveBeenCalled();
  });
});

describe('GET /failed-debits', () => {
  it('passes validated filters through, with dates as Date objects', async () => {
    const row = { source: 'compute', id: ROW_ID, orgId: ORG, idempotencyKey: `ai-compute:${ROW_ID}:1`, costCents: 13, error: 'http_401', failureClass: 'auth', attempts: 1, failedAt: '2026-10-20 00:00:00+00' };
    svc.listFailed.mockResolvedValue([row]);
    const res = await buildApp(platformAdmin).request(
      `/admin/ai-billing/failed-debits?orgId=${ORG}&failureClass=auth&failedAfter=2026-10-19T00:00:00Z&failedBefore=2026-10-21T00:00:00Z&limit=50`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [row] });
    expect(svc.listFailed).toHaveBeenCalledWith({
      orgId: ORG,
      failureClass: 'auth',
      failedAfter: new Date('2026-10-19T00:00:00Z'),
      failedBefore: new Date('2026-10-21T00:00:00Z'),
      limit: 50,
    });
  });

  it('rejects an unknown failure class, a bad org id and an oversized page', async () => {
    const app = buildApp(platformAdmin);
    expect((await app.request('/admin/ai-billing/failed-debits?failureClass=nope')).status).toBe(400);
    expect((await app.request('/admin/ai-billing/failed-debits?orgId=not-a-uuid')).status).toBe(400);
    expect((await app.request('/admin/ai-billing/failed-debits?limit=501')).status).toBe(400);
    expect(svc.listFailed).not.toHaveBeenCalled();
  });
});

describe('POST /failed-debits/redrive', () => {
  it('re-drives one row and audits the outcome', async () => {
    svc.redrive.mockResolvedValue({ kind: 'attempted', outcome: 'debited' });
    const res = await post(buildApp(platformAdmin), '/failed-debits/redrive', { source: 'settlement', id: ROW_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { outcome: 'debited' } });
    expect(svc.redrive).toHaveBeenCalledWith({ source: 'settlement', id: ROW_ID });
    expect(auditActions()).toContain('ai_billing.credit_debit_redriven');
  });

  it('404s a row that is not failed (nothing re-driven, nothing audited)', async () => {
    svc.redrive.mockResolvedValue({ kind: 'not_found' });
    const res = await post(buildApp(platformAdmin), '/failed-debits/redrive', { source: 'compute', id: ROW_ID });
    expect(res.status).toBe(404);
    expect(auditActions()).not.toContain('ai_billing.credit_debit_redriven');
  });

  it('409s (nothing cleared) when this deployment has no billing service', async () => {
    svc.redrive.mockRejectedValue(new BillingServiceNotConfiguredError('no billing'));
    const res = await post(buildApp(platformAdmin), '/failed-debits/redrive', { source: 'compute', id: ROW_ID });
    expect(res.status).toBe(409);
    svc.requeue.mockRejectedValue(new BillingServiceNotConfiguredError('no billing'));
    expect((await post(buildApp(platformAdmin), '/failed-debits/requeue', { limit: 10, reason: 'rotated key' })).status).toBe(409);
  });

  it('audits a re-drive the billing service refused again as a failure', async () => {
    svc.redrive.mockResolvedValue({ kind: 'attempted', outcome: 'rejected' });
    const res = await post(buildApp(platformAdmin), '/failed-debits/redrive', { source: 'compute', id: ROW_ID });
    expect(res.status).toBe(200);
    expect(vi.mocked(createAuditLogAsync)).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai_billing.credit_debit_redriven', result: 'failure',
    }));
  });

  it('rejects an unknown source', async () => {
    const res = await post(buildApp(platformAdmin), '/failed-debits/redrive', { source: 'other', id: ROW_ID });
    expect(res.status).toBe(400);
    expect(svc.redrive).not.toHaveBeenCalled();
  });
});

describe('POST /failed-debits/requeue', () => {
  it('requires a reason and a bounded limit', async () => {
    const app = buildApp(platformAdmin);
    expect((await post(app, '/failed-debits/requeue', { limit: 10 })).status).toBe(400);
    expect((await post(app, '/failed-debits/requeue', { limit: 501, reason: 'rotated key' })).status).toBe(400);
    expect(svc.requeue).not.toHaveBeenCalled();
  });

  it('re-queues the matching rows for the sweep and audits the filter and count', async () => {
    svc.requeue.mockResolvedValue([{ source: 'compute', id: ROW_ID }]);
    const res = await post(buildApp(platformAdmin), '/failed-debits/requeue', {
      failureClass: 'auth', failedAfter: '2026-10-19T00:00:00Z', limit: 200, reason: 'billing key rotated',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { requeued: [{ source: 'compute', id: ROW_ID }], count: 1 } });
    expect(svc.requeue).toHaveBeenCalledWith({ failureClass: 'auth', failedAfter: new Date('2026-10-19T00:00:00Z'), limit: 200 });
    const entry = vi.mocked(createAuditLogAsync).mock.calls.map(([e]) => e as { action: string; details: Record<string, unknown> })
      .find((e) => e.action === 'ai_billing.credit_debits_requeued');
    expect(entry?.details).toMatchObject({ count: 1, reason: 'billing key rotated', failureClass: 'auth' });
  });
});

describe('dead pending settlements', () => {
  it('lists them', async () => {
    const row = { reservationId: ROW_ID, orgId: ORG, status: 'indeterminate', attempts: 8, error: 'x', deadAt: '2026-10-20' };
    svc.listDead.mockResolvedValue([row]);
    const res = await buildApp(platformAdmin).request('/admin/ai-billing/dead-settlements?limit=20');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [row] });
    expect(svc.listDead).toHaveBeenCalledWith(20);
  });

  it.each([
    [{ kind: 'replayed', settlement: 'settled', debit: 'debited' }, 200],
    [{ kind: 'not_found' }, 404],
    [{ kind: 'superseded' }, 409],
    [{ kind: 'failed', error: 'boom' }, 502],
  ])('replay %o answers %i', async (result, status) => {
    svc.replayDead.mockResolvedValue(result);
    const res = await post(buildApp(platformAdmin), `/dead-settlements/${ROW_ID}/replay`, {});
    expect(res.status).toBe(status);
    expect(svc.replayDead).toHaveBeenCalledWith(ROW_ID);
    expect(auditActions().includes('ai_billing.dead_settlement_replayed')).toBe(result.kind === 'replayed' || result.kind === 'failed');
  });

  it('a replay whose debit was refused is audited as a failure (the spend itself is recorded)', async () => {
    svc.replayDead.mockResolvedValue({ kind: 'replayed', settlement: 'settled', debit: 'rejected' });
    const res = await post(buildApp(platformAdmin), `/dead-settlements/${ROW_ID}/replay`, {});
    expect(res.status).toBe(200);
    expect(vi.mocked(createAuditLogAsync)).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ai_billing.dead_settlement_replayed', result: 'failure',
    }));
  });

  it('rejects a malformed reservation id', async () => {
    const res = await post(buildApp(platformAdmin), '/dead-settlements/nope/replay', {});
    expect(res.status).toBe(400);
    expect(svc.replayDead).not.toHaveBeenCalled();
  });
});
