/**
 * W10 (#7608): the daily chargeback sweep against real Postgres. The candidate
 * query (not runOrgChargePeriod's already_run fallback) decides which orgs are
 * closed: an org already run for the month, and an org with only shadow,
 * non-chargeable or beyond-lookback rows, are never selected. Sentry is not
 * initialised in tests, so its capture calls are inert; nothing is mocked.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';
import { seedAiCard, seedChargeableInvocation } from './aiChargebackFixtures';
import { runChargebackSweep } from '../../jobs/aiChargebackWorker';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const NOW = new Date('2026-12-02T06:00:00Z'); // the sweep closes November 2026

async function runsOf(orgId: string) {
  return fixtureSql`SELECT period_start::text AS period_start, invocation_count FROM ai_usage_charge_runs WHERE org_id = ${orgId}`;
}
async function claimsOf(orgId: string) {
  const [r] = await fixtureSql`SELECT count(*)::int AS n FROM ai_usage_charge_claims WHERE org_id = ${orgId}`;
  return r!.n as number;
}

describe.runIf(RUN)('runChargebackSweep against Postgres (#7608)', () => {
  it('closes only the eligible org; a second sweep is a no-op', async () => {
    const p = await createPartner();
    const card = await seedAiCard(p.id);

    // Eligible: chargeable, authoritative, unclaimed November usage.
    const eligible = await createOrganization({ partnerId: p.id });
    await seedChargeableInvocation({ orgId: eligible.id, cardId: card, createdAt: '2026-11-05T12:00:00Z', amount: '2.500000' });

    // Already run for November: unclaimed usage, but the (org, month) slot is taken.
    const alreadyRun = await createOrganization({ partnerId: p.id });
    await seedChargeableInvocation({ orgId: alreadyRun.id, cardId: card, createdAt: '2026-11-06T12:00:00Z' });
    await fixtureSql`INSERT INTO ai_usage_charge_runs (org_id, partner_id, period_start, period_end, completed_at)
      VALUES (${alreadyRun.id}, ${p.id}, '2026-11-01', '2026-12-01', now())`;

    // Nothing billable in the window: a shadow row, a non-chargeable
    // authoritative row, and a chargeable row older than the 92-day lookback.
    const nothing = await createOrganization({ partnerId: p.id });
    await fixtureSql`INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, ledger_mode, rate_snapshot, cost_cents, created_at)
      VALUES (${nothing.id}, 'chat', 'platform', 'w10-test-model', 'w10-test-model', 'shadow', '{}'::jsonb, 1, '2026-11-05T00:00:00Z'),
             (${nothing.id}, 'chat', 'platform', 'w10-test-model', 'w10-test-model', 'authoritative', '{}'::jsonb, 1, '2026-11-05T00:00:00Z')`;
    await seedChargeableInvocation({ orgId: nothing.id, cardId: card, createdAt: '2026-07-15T00:00:00Z' });

    expect(await runChargebackSweep(NOW)).toEqual({ periodStart: '2026-11-01', charged: 1, skipped: 0, failed: 0, expired: 0 });

    expect(await runsOf(eligible.id)).toEqual([{ period_start: '2026-11-01', invocation_count: 1 }]);
    expect(await claimsOf(eligible.id)).toBe(1);
    const [charge] = await fixtureSql`SELECT amount::text AS amount, billing_status FROM ai_usage_charges WHERE org_id = ${eligible.id}`;
    expect(charge).toEqual({ amount: '2.50', billing_status: 'not_billed' });
    // Untouched: the pre-existing run stays the only one and claims nothing.
    expect(await runsOf(alreadyRun.id)).toEqual([{ period_start: '2026-11-01', invocation_count: 0 }]);
    expect(await claimsOf(alreadyRun.id)).toBe(0);
    expect(await runsOf(nothing.id)).toEqual([]);
    expect(await claimsOf(nothing.id)).toBe(0);

    expect(await runChargebackSweep(NOW)).toEqual({ periodStart: '2026-11-01', charged: 0, skipped: 0, failed: 0, expired: 0 });
    expect(await runsOf(eligible.id)).toHaveLength(1);
    expect(await claimsOf(eligible.id)).toBe(1);
  }, 30_000);
});
