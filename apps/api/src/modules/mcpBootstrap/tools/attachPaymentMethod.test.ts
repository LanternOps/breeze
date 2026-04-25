import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));

vi.mock('../../../db/schema', () => ({
  partners: {
    id: 'partners.id',
    emailVerifiedAt: 'partners.emailVerifiedAt',
    paymentMethodAttachedAt: 'partners.paymentMethodAttachedAt',
    stripeCustomerId: 'partners.stripeCustomerId',
    settings: 'partners.settings',
  },
}));

vi.mock('../../../services/breezeBillingClient', () => {
  class BillingError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  }
  return {
    getBreezeBillingClient: vi.fn(),
    BillingError,
  };
});

vi.mock('../../../services/rate-limit', () => ({
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 10, resetAt: new Date() }),
}));

vi.mock('../../../services/redis', () => ({
  getRedis: vi.fn(() => ({})),
}));

import { attachPaymentMethodTool } from './attachPaymentMethod';
import { db } from '../../../db';
import { BillingError, getBreezeBillingClient } from '../../../services/breezeBillingClient';
import { rateLimiter } from '../../../services/rate-limit';
import { hashBootstrapSecret } from '../bootstrapSecret';

const BOOTSTRAP_SECRET = 'a'.repeat(64);
const bootstrapSettings = () => ({
  mcp_bootstrap_secret_hash: hashBootstrapSecret(BOOTSTRAP_SECRET),
});
const input = (tenantId = 'p1') => ({
  tenant_id: tenantId,
  bootstrap_secret: BOOTSTRAP_SECRET,
});

function enqueueSelects(rows: unknown[][]): void {
  const queue = [...rows];
  vi.mocked(db.select).mockImplementation(() => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? [])),
    };
    return chain as any;
  });
}

describe('attach_payment_method', () => {
  const createSetupIntent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    createSetupIntent.mockReset();
    vi.mocked(getBreezeBillingClient).mockReturnValue({ createSetupIntent } as any);
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 10, resetAt: new Date() });
    process.env.PUBLIC_ACTIVATION_BASE_URL = 'https://us.2breeze.app';

    // Default update() mock — resolves successfully.
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
  });

  it('enforces per-IP rate limit before DB and billing work', async () => {
    const resetAt = new Date('2026-04-24T12:00:00.000Z');
    // First rateLimiter call is the IP check.
    vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt });

    await expect(
      attachPaymentMethodTool.handler(input('p1'), { ip: '9.9.9.9' } as any),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('Per-IP'),
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(createSetupIntent).not.toHaveBeenCalled();
  });

  it('enforces per-tenant rate limit after secret validation succeeds', async () => {
    enqueueSelects([
      [{ id: 'p1', settings: bootstrapSettings(), emailVerifiedAt: new Date(), paymentMethodAttachedAt: null }],
    ]);
    const resetAt = new Date('2026-04-24T12:00:00.000Z');
    // 1st call (IP) allowed; 2nd call (tenant) denied.
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 30, resetAt: new Date() })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt });

    await expect(
      attachPaymentMethodTool.handler(input('p1'), { ip: '9.9.9.9' } as any),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining(resetAt.toISOString()),
    });
    expect(createSetupIntent).not.toHaveBeenCalled();
  });

  it('does NOT increment tenant rate-limit counter when secret is wrong; IP RL still fires', async () => {
    enqueueSelects([
      [{ id: 'p1', settings: bootstrapSettings(), emailVerifiedAt: new Date(), paymentMethodAttachedAt: null }],
    ]);

    await expect(
      attachPaymentMethodTool.handler(
        { tenant_id: 'p1', bootstrap_secret: 'b'.repeat(64) },
        { ip: '9.9.9.9' } as any,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_BOOTSTRAP_SECRET' });

    // Exactly one rateLimiter call — the IP-keyed one.
    expect(rateLimiter).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rateLimiter).mock.calls[0]![1]).toBe('mcp:attach_payment:ip:9.9.9.9');
    // Tenant key was NOT touched.
    const tenantCallArgs = vi.mocked(rateLimiter).mock.calls.map((c) => c[1]);
    expect(tenantCallArgs).not.toContain('mcp:attach_payment:tenant:p1');
  });

  it('throws UNKNOWN_TENANT when partner row missing', async () => {
    enqueueSelects([[]]);
    await expect(
      attachPaymentMethodTool.handler(
        input('00000000-0000-0000-0000-000000000000'),
        {} as any,
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_TENANT' });
    expect(createSetupIntent).not.toHaveBeenCalled();
  });

  it('throws EMAIL_NOT_VERIFIED when emailVerifiedAt is null', async () => {
    enqueueSelects([
      [{ id: 'p1', settings: bootstrapSettings(), emailVerifiedAt: null, paymentMethodAttachedAt: null }],
    ]);
    await expect(
      attachPaymentMethodTool.handler(input('p1'), {} as any),
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect(createSetupIntent).not.toHaveBeenCalled();
  });

  it('is idempotent when payment method already attached', async () => {
    enqueueSelects([
      [{
        id: 'p1',
        settings: bootstrapSettings(),
        emailVerifiedAt: new Date(),
        paymentMethodAttachedAt: new Date(),
      }],
    ]);
    const r = await attachPaymentMethodTool.handler(input('p1'), {} as any);
    expect(r).toMatchObject({ setup_url: null, already_attached: true });
    expect(r.next_steps).toContain('Payment method already attached');
    expect(createSetupIntent).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('throws INVALID_BOOTSTRAP_SECRET when the secret does not match', async () => {
    enqueueSelects([
      [{ id: 'p1', settings: bootstrapSettings(), emailVerifiedAt: new Date(), paymentMethodAttachedAt: null }],
    ]);

    await expect(
      attachPaymentMethodTool.handler({ tenant_id: 'p1', bootstrap_secret: 'b'.repeat(64) }, {} as any),
    ).rejects.toMatchObject({ code: 'INVALID_BOOTSTRAP_SECRET' });
    expect(createSetupIntent).not.toHaveBeenCalled();
  });

  it('calls billing client, stores customer id, returns setup_url on happy path', async () => {
    enqueueSelects([
      [{ id: 'p1', settings: bootstrapSettings(), emailVerifiedAt: new Date(), paymentMethodAttachedAt: null }],
    ]);
    createSetupIntent.mockResolvedValue({
      setupUrl: 'https://stripe.example/setup/abc',
      customerId: 'cus_123',
    });
    const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const r = await attachPaymentMethodTool.handler(input('p1'), {} as any);

    expect(r).toMatchObject({
      setup_url: 'https://stripe.example/setup/abc',
      already_attached: false,
    });
    expect(r.next_steps).toContain('https://stripe.example/setup/abc');
    expect(createSetupIntent).toHaveBeenCalledWith({
      partnerId: 'p1',
      returnUrl: 'https://us.2breeze.app/activate/complete?partner=p1',
    });
    expect(setMock).toHaveBeenCalledWith({ stripeCustomerId: 'cus_123' });
  });

  it('translates BillingError to BILLING_UNAVAILABLE BootstrapError', async () => {
    enqueueSelects([
      [{ id: 'p1', settings: bootstrapSettings(), emailVerifiedAt: new Date(), paymentMethodAttachedAt: null }],
    ]);
    createSetupIntent.mockRejectedValue(
      new BillingError('BILLING_UNAVAILABLE', 'Billing service returned 503: down'),
    );
    await expect(
      attachPaymentMethodTool.handler(input('p1'), {} as any),
    ).rejects.toMatchObject({
      code: 'BILLING_UNAVAILABLE',
      remediation: { retryAfter: '30s' },
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('translates network/TypeError to BILLING_UNAVAILABLE BootstrapError', async () => {
    enqueueSelects([
      [{ id: 'p1', settings: bootstrapSettings(), emailVerifiedAt: new Date(), paymentMethodAttachedAt: null }],
    ]);
    createSetupIntent.mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      attachPaymentMethodTool.handler(input('p1'), {} as any),
    ).rejects.toMatchObject({
      code: 'BILLING_UNAVAILABLE',
      message: expect.stringContaining('Billing service unreachable'),
      remediation: { retryAfter: '30s' },
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('throws PARTIAL_BILLING_STATE when DB update fails after SetupIntent success', async () => {
    enqueueSelects([
      [{ id: 'p1', settings: bootstrapSettings(), emailVerifiedAt: new Date(), paymentMethodAttachedAt: null }],
    ]);
    createSetupIntent.mockResolvedValue({
      setupUrl: 'https://stripe.example/setup/abc',
      customerId: 'cus_123',
    });
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('db down')),
      }),
    } as any);

    await expect(
      attachPaymentMethodTool.handler(input('p1'), {} as any),
    ).rejects.toMatchObject({
      code: 'PARTIAL_BILLING_STATE',
      message: expect.stringContaining('SetupIntent created'),
    });
  });
});
