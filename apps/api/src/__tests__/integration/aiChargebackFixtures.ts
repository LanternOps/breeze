/**
 * Shared seeds for the AI chargeback (#7608) integration suites. Superuser
 * client (bypasses RLS); code under test goes through the breeze_app pool.
 * Not a test file.
 */
import { randomUUID } from 'node:crypto';
import type { AiCoverage } from '@breeze/shared';
import { fixtureSql } from './aiModelRegistryFixtures';

export async function seedAiCard(partnerId: string, opts: {
  currencyCode?: string; aiCoverage?: AiCoverage; aiMarkupPercent?: string | null; isDefault?: boolean;
  rates?: Array<{ modelId: string; input: string; output: string; cacheRead: string; cacheWrite: string }>;
} = {}): Promise<string> {
  const currency = opts.currencyCode ?? 'USD';
  if (opts.isDefault ?? true) {
    await fixtureSql`UPDATE billing_profiles SET is_default = false
      WHERE partner_id = ${partnerId} AND currency_code = ${currency} AND is_default`;
  }
  const [row] = await fixtureSql`
    INSERT INTO billing_profiles (partner_id, name, currency_code, base_coverage, is_default, ai_coverage, ai_markup_percent)
    VALUES (${partnerId}, ${'W10 card ' + randomUUID()}, ${currency}, 'billable', ${opts.isDefault ?? true},
            ${opts.aiCoverage ?? 'billable'}, ${opts.aiMarkupPercent === undefined ? '25.00' : opts.aiMarkupPercent})
    RETURNING id`;
  const id = String(row!.id);
  for (const r of opts.rates ?? []) {
    await fixtureSql`
      INSERT INTO billing_profile_ai_rates (partner_id, billing_profile_id, model_id,
        input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m)
      VALUES (${partnerId}, ${id}, ${r.modelId}, ${r.input}, ${r.output}, ${r.cacheRead}, ${r.cacheWrite})`;
  }
  return id;
}

export async function assignCard(orgId: string, partnerId: string, cardId: string): Promise<void> {
  await fixtureSql`
    INSERT INTO org_billing_profile_assignments (org_id, partner_id, billing_profile_id)
    VALUES (${orgId}, ${partnerId}, ${cardId})
    ON CONFLICT (org_id) DO UPDATE SET billing_profile_id = EXCLUDED.billing_profile_id`;
}

/** A stamped, authoritative, chargeable ledger row at an explicit created_at (UTC ISO). */
export async function seedChargeableInvocation(input: {
  orgId: string; createdAt: string; cardId: string; servedModel?: string; currency?: string;
  amount?: string | null; tokens?: number; surface?: string;
}): Promise<string> {
  const amount = input.amount === undefined ? '1.000000' : input.amount;
  const [row] = await fixtureSql`
    INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, ledger_mode,
      input_tokens, output_tokens, rate_snapshot, cost_cents, chargeable,
      charge_billing_profile_id, charge_coverage, charge_basis, charge_currency, charge_amount, created_at)
    VALUES (${input.orgId}, ${input.surface ?? 'chat'}, 'platform', ${input.servedModel ?? 'w10-test-model'},
      ${input.servedModel ?? 'w10-test-model'}, 'authoritative', ${input.tokens ?? 1000}, ${input.tokens ?? 1000},
      '{}'::jsonb, 1, true, ${input.cardId}, 'billable', ${amount === null ? 'unpriced' : 'markup'},
      ${input.currency ?? 'USD'}, ${amount}, ${input.createdAt}::timestamptz)
    RETURNING id`;
  return String(row!.id);
}
