import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../../db/schema', () => ({
  partners: {
    id: 'partners.id',
    paymentMethodAttachedAt: 'partners.paymentMethodAttachedAt',
  },
}));

import { requirePaymentMethod, PaymentRequiredError } from './paymentGate';
import { db } from '../../db';

function mockPartnerPaid(paid: Date | null): void {
  vi.mocked(db.select).mockImplementation(() => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ paid }]),
    };
    return chain as any;
  });
}

function mockPartnerMissing(): void {
  vi.mocked(db.select).mockImplementation(() => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    return chain as any;
  });
}

describe('requirePaymentMethod', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws PaymentRequiredError when payment_method_attached_at is null', async () => {
    mockPartnerPaid(null);
    const wrapped = requirePaymentMethod(async () => 'ok');
    await expect(
      wrapped({}, { apiKey: { partnerId: 'p1' } } as any),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it('includes remediation pointing at attach_payment_method', async () => {
    mockPartnerPaid(null);
    const wrapped = requirePaymentMethod(async () => 'ok');
    try {
      await wrapped({}, { apiKey: { partnerId: 'p1' } } as any);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PaymentRequiredError);
      expect((e as PaymentRequiredError).code).toBe('PAYMENT_REQUIRED');
      expect((e as PaymentRequiredError).remediation).toEqual({
        tool: 'attach_payment_method',
        args: {
          tenant_id: 'p1',
          bootstrap_secret: '<bootstrap_secret returned by create_tenant>',
        },
      });
    }
  });

  it('also throws PaymentRequiredError when partner row missing', async () => {
    mockPartnerMissing();
    const wrapped = requirePaymentMethod(async () => 'ok');
    await expect(
      wrapped({}, { apiKey: { partnerId: 'p1' } } as any),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it('passes through when payment attached', async () => {
    mockPartnerPaid(new Date());
    const wrapped = requirePaymentMethod(
      async (_input: any, ctx: any) => `ok ${ctx.apiKey.partnerId}`,
    );
    await expect(
      wrapped({ x: 1 }, { apiKey: { partnerId: 'p1' } } as any),
    ).resolves.toBe('ok p1');
  });

  it('throws when no partnerId in context (programmer error)', async () => {
    const wrapped = requirePaymentMethod(async () => 'ok');
    await expect(wrapped({}, {} as any)).rejects.toThrow(/partner/i);
  });
});
