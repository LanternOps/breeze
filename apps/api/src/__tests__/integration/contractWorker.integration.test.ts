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
import { eq, and } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, users, contracts, contractLines, contractBillingPeriods, invoices } from '../../db/schema';
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

  // Case 4: autoIssue post-commit — the sweep must issue the invoice after billing.
  // Email is unconfigured in test DB so sendInvoiceEmail no-ops; the key assertion is
  // that the invoice transitions from 'draft' to a non-draft status post-sweep, and
  // the ledger still has exactly one row (no double-billing regardless of issue/send outcome).
  it.runIf(!!process.env.DATABASE_URL)(
    'autoIssue: sweep issues the invoice post-commit; no double-billing on re-sweep',
    async () => {
      const sfx = Math.random().toString(36).slice(2, 8);
      let contractId = '';
      let invoiceId = '';

      await withSystemDbAccessContext(async () => {
        const [p] = await db.insert(partners).values({
          name: `AI ${sfx}`, slug: `ai-${sfx}`, type: 'msp', plan: 'pro', status: 'active'
        }).returning({ id: partners.id });
        const partnerId = p!.id;

        const [o] = await db.insert(organizations).values({
          partnerId, name: 'AIOrg', slug: `aio-${sfx}`
        }).returning({ id: organizations.id });
        const orgId = o!.id;

        // A real user row is needed because generated invoices reference created_by FK.
        const [u] = await db.insert(users).values({
          partnerId, orgId, email: `ai-${sfx}@x.io`, name: 'AI User', status: 'active'
        }).returning({ id: users.id });

        const [ctr] = await db.insert(contracts).values({
          partnerId,
          orgId,
          name: 'AutoIssue',
          status: 'active',
          billingTiming: 'advance',
          intervalMonths: 1,
          startDate: '2026-07-01',
          nextBillingAt: '2026-07-01',
          autoIssue: true,   // ← the flag under test
          currencyCode: 'USD',
          createdBy: u!.id
        }).returning({ id: contracts.id });
        contractId = ctr!.id;

        await db.insert(contractLines).values({
          contractId,
          orgId,
          lineType: 'flat',
          description: 'AutoIssue fee',
          unitPrice: '300.00',
          taxable: false
        });
      });

      // Sweep at the billing day — should bill 1 and issue the invoice.
      const result = await runContractBillingSweep(new Date('2026-07-01T05:00:00Z'));
      expect(result.billed).toBe(1);
      expect(result.failed).toBe(0);

      // Find the generated invoice via the billing period ledger row.
      const periods = await withSystemDbAccessContext(() =>
        db.select({ invoiceId: contractBillingPeriods.invoiceId })
          .from(contractBillingPeriods)
          .where(eq(contractBillingPeriods.contractId, contractId))
      );
      expect(periods).toHaveLength(1); // exactly one row — no double-billing
      invoiceId = periods[0]!.invoiceId!;

      // The invoice must have been issued (non-draft) by the post-commit auto-issue step.
      // Acceptable statuses after issue: 'sent' (if email is configured) or any non-draft
      // status set by issueInvoice. In the test environment without SMTP, the invoice
      // transitions to 'sent' via issueInvoice (the send step is best-effort and no-ops).
      const [inv] = await withSystemDbAccessContext(() =>
        db.select({ status: invoices.status }).from(invoices)
          .where(eq(invoices.id, invoiceId)).limit(1)
      );
      expect(inv).toBeTruthy();
      expect(inv!.status).not.toBe('draft'); // autoIssue ran post-commit

      // A second sweep must not re-bill (pointer advanced, nothing due).
      const second = await runContractBillingSweep(new Date('2026-07-01T05:05:00Z'));
      expect(second.billed).toBe(0);
      expect(second.failed).toBe(0);

      // Still exactly one ledger row.
      const periodsAfter = await withSystemDbAccessContext(() =>
        db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, contractId))
      );
      expect(periodsAfter).toHaveLength(1);
    }
  );
});
