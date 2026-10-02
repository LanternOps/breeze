import { describe, expect, expectTypeOf, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type Stripe from 'stripe';
import type { MiddlewareHandler } from 'hono';
import type { Tx } from './types';
import type { BillingLinkPurpose } from '@breeze/shared';
import type { billingLinkTokens } from '../../db/schema';

describe('W1 public foundation contract', () => {
  it('preserves the link and gate signatures used by later waves', () => {
    expectTypeOf<typeof import('./linkTokens').mintBillingLinkToken>().toEqualTypeOf<(
      tx: Tx, input: { orgId: string; purpose: BillingLinkPurpose; enrollmentId?: string; invoiceId?: string; generation?: number; ttlDays: number }
    ) => Promise<{ token: string; id: string }>>();
    expectTypeOf<typeof import('./linkTokens').resolveBillingLinkToken>().toEqualTypeOf<(
      db: Tx, token: string, purpose: BillingLinkPurpose
    ) => Promise<typeof billingLinkTokens.$inferSelect | null>>();
    expectTypeOf<typeof import('./autopayGate').requireAutopayEnabled>().toEqualTypeOf<() => MiddlewareHandler>();
    expectTypeOf<typeof import('../stripeSettle').settlePaymentIntent>().toEqualTypeOf<(
      partnerId: string, paymentIntentId: string
    ) => Promise<{ settled: boolean; status: Stripe.PaymentIntent.Status; invoiceId: string | null }>>();
  });
  it('has all six ordered migration slots and no migration-level transaction wrapper', () => {
    const names = [
      '2026-12-03-110000-autopay-enums.sql',
      '2026-12-03-110100-billing-payment-settings.sql',
      '2026-12-03-110200-org-autopay-enrollments-methods-consents.sql',
      '2026-12-03-110300-invoice-autopay-schedules-attempts.sql',
      '2026-12-03-110400-billing-notice-outbox-link-tokens.sql',
      '2026-12-03-110500-autopay-column-additions.sql',
    ];
    for (const name of names) {
      const file = new URL(`../../../migrations/${name}`, import.meta.url);
      expect(existsSync(file)).toBe(true);
      const sql = readFileSync(file, 'utf8');
      expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/m);
      expect(sql).toMatch(/set_config\('breeze.scope',\s*'system',\s*true\)/);
    }
  });
});

it('keeps autopay integration matching out of coverage include/exclude lists', () => {
  for (const name of ['vitest.config.ts', 'vitest.integration.config.ts']) {
    const config = readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8');
    expect(config.slice(config.indexOf('coverage:'))).not.toContain('src/services/autopay/**/*.integration.test.ts');
  }
});
