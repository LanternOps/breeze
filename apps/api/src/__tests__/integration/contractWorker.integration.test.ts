/**
 * Integration tests for runContractBillingSweep.
 *
 * Runs under vitest.integration.config.ts — tests run against a real Postgres
 * with the breeze_app role so RLS and the contract_billing_periods unique
 * constraint are exercised end-to-end.
 *
 * Why NO fixture memoization: integration/setup.ts runs cleanupDatabase() in a
 * beforeEach that TRUNCATE ... CASCADEs partners/organizations before every test.
 * Each test re-seeds fresh to avoid the vacuous-test trap (re: rls-forge-test-
 * memoized-fixture-vacuous.md memory entry).
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, contracts, contractLines, contractBillingPeriods } from '../../db/schema';
import { runContractBillingSweep } from '../../jobs/contractWorker';

describe('runContractBillingSweep', () => {
  it.runIf(!!process.env.DATABASE_URL)(
    'bills every active contract due on/before asOf, idempotently',
    async () => {
      const sfx = Math.random().toString(36).slice(2, 8);
      let contractId = '';

      // Seed partner, org, one active contract with a flat line.
      await withSystemDbAccessContext(async () => {
        const [p] = await db.insert(partners).values({
          name: `SW ${sfx}`, slug: `sw-${sfx}`, type: 'msp', plan: 'pro', status: 'active'
        }).returning({ id: partners.id });

        const [o] = await db.insert(organizations).values({
          partnerId: p!.id, name: 'O', slug: `o-${sfx}`
        }).returning({ id: organizations.id });

        const [ctr] = await db.insert(contracts).values({
          partnerId: p!.id,
          orgId: o!.id,
          name: 'C',
          status: 'active',
          billingTiming: 'advance',
          intervalMonths: 1,
          startDate: '2026-07-01',
          nextBillingAt: '2026-07-01'
        }).returning({ id: contracts.id });
        contractId = ctr!.id;

        await db.insert(contractLines).values({
          contractId,
          orgId: o!.id,
          lineType: 'flat',
          description: 'm',
          unitPrice: '500.00',
          taxable: false
        });
      });

      // First sweep at 06:00 on billing day — should bill 1.
      const first = await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(first.billed).toBe(1);
      expect(first.failed).toBe(0);

      // Second sweep 5 minutes later — nextBillingAt advanced to Aug 1, nothing due.
      const second = await runContractBillingSweep(new Date('2026-07-01T06:05:00Z'));
      expect(second.billed).toBe(0);
      expect(second.failed).toBe(0);

      // Exactly one billing period row created for the contract.
      const periods = await withSystemDbAccessContext(() =>
        db.select().from(contractBillingPeriods).where(
          eq(contractBillingPeriods.contractId, contractId)
        )
      );
      expect(periods).toHaveLength(1);
    }
  );
});
