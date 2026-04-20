import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(async (cb: (tx: any) => Promise<void>) => {
      // Default tx mirrors the top-level db mocks.
      const tx: any = {
        select: (...args: any[]) => (db.select as any)(...args),
        update: (...args: any[]) => (db.update as any)(...args),
      };
      await cb(tx);
    }),
  },
}));

vi.mock('../../db/schema', () => ({
  partners: {
    id: 'partners.id',
    emailVerifiedAt: 'partners.emailVerifiedAt',
    paymentMethodAttachedAt: 'partners.paymentMethodAttachedAt',
    stripeCustomerId: 'partners.stripeCustomerId',
  },
  partnerActivations: {
    id: 'partnerActivations.id',
    partnerId: 'partnerActivations.partnerId',
    tokenHash: 'partnerActivations.tokenHash',
    expiresAt: 'partnerActivations.expiresAt',
    consumedAt: 'partnerActivations.consumedAt',
  },
  apiKeys: {
    id: 'apiKeys.id',
    orgId: 'apiKeys.orgId',
    scopeState: 'apiKeys.scopeState',
  },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partnerUsers: { partnerId: 'partnerUsers.partnerId', userId: 'partnerUsers.userId' },
  users: { id: 'users.id', status: 'users.status' },
}));

vi.mock('../../services/rate-limit', () => ({
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 10, resetAt: new Date() }),
}));

vi.mock('../../services/redis', () => ({
  getRedis: vi.fn().mockReturnValue(null),
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/breezeBillingClient', () => ({
  getBreezeBillingClient: vi.fn().mockReturnValue({
    createSetupIntent: vi
      .fn()
      .mockResolvedValue({ setupUrl: 'https://billing.example/setup/abc', customerId: 'cus_123' }),
  }),
}));

// Stripe mock — expose constructEvent we can control per-test.
const stripeWebhooksConstructEvent = vi.fn();
vi.mock('stripe', () => {
  class Stripe {
    webhooks = { constructEvent: stripeWebhooksConstructEvent };
    constructor(_secret?: string, _opts?: unknown) {}
  }
  return { default: Stripe, Stripe };
});

import { Hono } from 'hono';
import { mountActivationRoutes } from './activationRoutes';
import { db } from '../../db';
import { rateLimiter } from '../../services/rate-limit';
import { writeAuditEvent } from '../../services/auditEvents';
import { getBreezeBillingClient } from '../../services/breezeBillingClient';

/** Queue-based select mock — see verifyTenant.test.ts for the pattern. */
function enqueueSelects(rows: unknown[][]): void {
  const queue = [...rows];
  vi.mocked(db.select).mockImplementation(() => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(function (this: any) {
        // No `.limit()` call → terminal where() resolves as a thenable for
        // `SELECT id FROM organizations WHERE partner_id = ...` style queries.
        this.then = (resolve: any) => resolve(queue.shift() ?? []);
        return this;
      }),
      limit: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? [])),
    };
    return chain as any;
  });
}

function defaultUpdateMock() {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  vi.mocked(db.update).mockReturnValue({ set: setMock } as any);
  return { setMock, whereMock };
}

function buildApp(): Hono {
  const app = new Hono();
  mountActivationRoutes(app);
  return app;
}

const RAW_TOKEN = 'abc123token';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');

describe('GET /activate/:token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 10, resetAt: new Date() });
  });

  it('returns 404 for unknown token', async () => {
    enqueueSelects([[]]);
    defaultUpdateMock();
    const res = await buildApp().request(`/activate/${RAW_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('returns 410 for expired token (not yet consumed)', async () => {
    enqueueSelects([
      [
        {
          id: 'act-1',
          partnerId: 'p1',
          tokenHash: TOKEN_HASH,
          expiresAt: new Date(Date.now() - 10_000),
          consumedAt: null,
        },
      ],
    ]);
    defaultUpdateMock();
    const res = await buildApp().request(`/activate/${RAW_TOKEN}`);
    expect(res.status).toBe(410);
  });

  it('returns 410 for already-consumed token', async () => {
    enqueueSelects([
      [
        {
          id: 'act-1',
          partnerId: 'p1',
          tokenHash: TOKEN_HASH,
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: new Date(),
        },
      ],
    ]);
    defaultUpdateMock();
    const res = await buildApp().request(`/activate/${RAW_TOKEN}`);
    expect(res.status).toBe(410);
  });

  it('returns 429 when per-token rate limit exceeded', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(),
    });
    const res = await buildApp().request(`/activate/${RAW_TOKEN}`);
    expect(res.status).toBe(429);
  });

  it('consumes token, marks partner verified, activates admin user, and redirects', async () => {
    enqueueSelects([
      [
        {
          id: 'act-1',
          partnerId: 'p1',
          tokenHash: TOKEN_HASH,
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
        },
      ],
      [{ userId: 'user-1' }], // partnerUsers lookup inside the transaction
    ]);
    const { setMock } = defaultUpdateMock();

    const res = await buildApp().request(`/activate/${RAW_TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/activate/${RAW_TOKEN}?status=email_verified`);
    // Three updates: activation.consumedAt, partners.emailVerifiedAt, users.status
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ consumedAt: expect.any(Date) }));
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ emailVerifiedAt: expect.any(Date) }),
    );
    expect(setMock).toHaveBeenCalledWith({ status: 'active' });
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'system',
        action: 'partner.activation_completed',
        resourceId: 'p1',
      }),
    );
  });
});

describe('POST /activate/setup-intent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when token is missing', async () => {
    const res = await buildApp().request('/activate/setup-intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_token' });
  });

  it('returns 400 with invalid_state when token unknown', async () => {
    enqueueSelects([[]]);
    const res = await buildApp().request('/activate/setup-intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: RAW_TOKEN }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_state' });
  });

  it('returns 400 with invalid_state when token not yet consumed', async () => {
    enqueueSelects([
      [
        {
          id: 'act-1',
          partnerId: 'p1',
          tokenHash: TOKEN_HASH,
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
        },
      ],
    ]);
    const res = await buildApp().request('/activate/setup-intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: RAW_TOKEN }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_state' });
  });

  it('creates SetupIntent and stores stripe customer id', async () => {
    enqueueSelects([
      [
        {
          id: 'act-1',
          partnerId: 'p1',
          tokenHash: TOKEN_HASH,
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: new Date(),
        },
      ],
    ]);
    const { setMock } = defaultUpdateMock();
    const res = await buildApp().request('/activate/setup-intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: RAW_TOKEN }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ setup_url: 'https://billing.example/setup/abc' });
    const billing = getBreezeBillingClient();
    expect(billing.createSetupIntent).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: 'p1' }),
    );
    expect(setMock).toHaveBeenCalledWith({ stripeCustomerId: 'cus_123' });
  });
});

describe('POST /activate/complete/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    stripeWebhooksConstructEvent.mockReset();
  });

  it('returns 400 when stripe-signature header is missing', async () => {
    const res = await buildApp().request('/activate/complete/webhook', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when signature verification fails', async () => {
    stripeWebhooksConstructEvent.mockImplementation(() => {
      throw new Error('bad sig');
    });
    const res = await buildApp().request('/activate/complete/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_bad' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('bad sig');
  });

  it('returns 404 when customer is unknown', async () => {
    stripeWebhooksConstructEvent.mockReturnValue({
      type: 'setup_intent.succeeded',
      data: { object: { customer: 'cus_unknown' } },
    });
    enqueueSelects([[]]);
    const res = await buildApp().request('/activate/complete/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_ok' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('ignores unrelated event types and returns 200 ok', async () => {
    stripeWebhooksConstructEvent.mockReturnValue({
      type: 'customer.created',
      data: { object: {} },
    });
    const res = await buildApp().request('/activate/complete/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_ok' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('on setup_intent.succeeded marks payment attached and upgrades readonly keys', async () => {
    stripeWebhooksConstructEvent.mockReturnValue({
      type: 'setup_intent.succeeded',
      data: { object: { customer: 'cus_123' } },
    });
    enqueueSelects([
      [{ id: 'p1' }], // partner lookup by stripe_customer_id
      [{ id: 'org-1' }, { id: 'org-2' }], // organizations under the partner
    ]);
    const { setMock } = defaultUpdateMock();

    const res = await buildApp().request('/activate/complete/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_ok' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethodAttachedAt: expect.any(Date) }),
    );
    expect(setMock).toHaveBeenCalledWith({ scopeState: 'full' });
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'partner.payment_method_attached',
        actorType: 'system',
        resourceId: 'p1',
      }),
    );
  });
});

describe('test-mode hooks (MCP_BOOTSTRAP_TEST_MODE)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /test/activate/:partnerId returns 404 when flag is unset', async () => {
    delete process.env.MCP_BOOTSTRAP_TEST_MODE;
    const res = await buildApp().request('/test/activate/partner-xyz', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('POST /test/complete-payment/:partnerId returns 404 when flag is unset', async () => {
    delete process.env.MCP_BOOTSTRAP_TEST_MODE;
    const res = await buildApp().request('/test/complete-payment/partner-xyz', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('POST /test/activate/:partnerId runs activation side-effects when flag is true', async () => {
    process.env.MCP_BOOTSTRAP_TEST_MODE = 'true';
    try {
      enqueueSelects([
        [{ userId: 'user-1' }], // partnerUsers lookup inside the transaction
      ]);
      const { setMock } = defaultUpdateMock();
      const res = await buildApp().request('/test/activate/partner-xyz', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({ emailVerifiedAt: expect.any(Date) }),
      );
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ consumedAt: expect.any(Date) }));
      expect(setMock).toHaveBeenCalledWith({ status: 'active' });
    } finally {
      delete process.env.MCP_BOOTSTRAP_TEST_MODE;
    }
  });

  it('POST /test/complete-payment/:partnerId marks payment + upgrades keys when flag is true', async () => {
    process.env.MCP_BOOTSTRAP_TEST_MODE = 'true';
    try {
      enqueueSelects([
        [{ id: 'org-1' }, { id: 'org-2' }], // organizations under the partner
      ]);
      const { setMock } = defaultUpdateMock();
      const res = await buildApp().request('/test/complete-payment/partner-xyz', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethodAttachedAt: expect.any(Date) }),
      );
      expect(setMock).toHaveBeenCalledWith({ scopeState: 'full' });
    } finally {
      delete process.env.MCP_BOOTSTRAP_TEST_MODE;
    }
  });
});
