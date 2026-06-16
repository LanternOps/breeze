/**
 * Real-driver cross-tenant forge tests for the Stripe payments tables.
 *
 * Runs under vitest.integration.config.ts — code-under-test connects as the
 * unprivileged `breeze_app` role (rolbypassrls=f), so RLS is actually
 * enforced. If `.env.test` is missing the symlink that pins this to the
 * breeze_app role, these tests would pass vacuously on a BYPASSRLS admin
 * connection (see memory: worktree_env_test_rls_vacuous) — the forged-insert
 * assertions are the guard that catches that.
 *
 * Fixture topology (seeded fresh per test under system scope, which bypasses
 * RLS — see "why no memoization" below):
 *   partnerA → orgA → invoiceA
 *   partnerB → orgB
 *   acctA = stripe_connect_accounts row under partnerA
 *
 * Coverage:
 *   - stripe_connect_accounts (partner-axis, RLS shape 3):
 *       partner B context reading partner A's account → 0 rows
 *       a forged cross-partner INSERT (partner B context, partnerId=partnerA)
 *         is rejected with an RLS violation (42501)
 *       system scope CAN read the seeded account (existence probe — proves the
 *         0-row read above is genuine isolation, not an empty table)
 *   - invoice_stripe_payments (org-axis, RLS shape 1):
 *       a forged cross-org INSERT (org B context, orgId=orgA referencing org
 *         A's invoice) is rejected with an RLS violation (42501). The referenced
 *         invoice belongs to org A so its FK resolves — the ONLY reason the
 *         insert fails is the RLS WITH CHECK, which surfaces as 42501
 *         (insufficient_privilege), not an incidental 23503 FK violation.
 *
 * Drizzle wraps the driver error: the top-level message becomes
 * "Failed query: insert into ...", and the original Postgres error
 * ("new row violates row-level security policy for table ...", code 42501 =
 * insufficient_privilege) is carried on the wrapper's `cause`. We assert on
 * `cause.code` to match the verified sibling pattern (catalog-rls /
 * time-entries-rls) rather than the wrapper message, which does not contain
 * the RLS phrase.
 *
 * Why NO memoization: setup.ts runs cleanupDatabase() in a beforeEach that
 * TRUNCATE ... CASCADEs partners/organizations before every test, which
 * cascades through these FKs and wipes every seeded row. A module-level
 * fixture cache would therefore hand later cases rows that no longer exist,
 * making the RLS assertions vacuous. Each it() re-seeds fresh — matching every
 * sibling *-rls.integration.test.ts.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  runOutsideDbContext,
  type DbAccessContext,
} from '../../db';
import {
  stripeConnectAccounts,
  invoiceStripePayments,
  invoices,
} from '../../db/schema';
import { getConnection } from '../../services/stripeConnectService';
import { createPartner, createOrganization } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerCtx(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: null,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

// Re-seeds fresh on every call. Intentionally NOT memoized (see file header).
async function seed() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    // A connected Stripe account under partner A (partner-axis row).
    const [acctA] = await db
      .insert(stripeConnectAccounts)
      .values({
        partnerId: partnerA.id,
        stripeAccountId: `acct_${partnerA.id.slice(0, 8)}`,
        livemode: false,
      })
      .returning();
    if (!acctA) throw new Error('failed to seed stripe connect account A');

    // A real invoice under org A so the forged org_id insert's invoice_id FK
    // resolves — isolating the RLS WITH CHECK as the only reason the insert can
    // fail (a 42501, never an incidental 23503 FK error).
    const [invoiceA] = await db
      .insert(invoices)
      .values({ partnerId: partnerA.id, orgId: orgA.id, status: 'draft' })
      .returning({ id: invoices.id });
    if (!invoiceA) throw new Error('failed to seed invoice A');

    return { partnerA, orgA, partnerB, orgB, acctA, invoiceA };
  });
}

describe('stripe_connect_accounts RLS (breeze_app)', () => {
  runDb('partner B cannot read partner A connected account', async () => {
    const { acctA, partnerB } = await seed();
    const rows = await withDbAccessContext(partnerCtx(partnerB.id), () =>
      db
        .select()
        .from(stripeConnectAccounts)
        .where(eq(stripeConnectAccounts.id, acctA.id))
    );
    expect(rows).toHaveLength(0);
  });

  runDb('forged cross-partner insert is rejected', async () => {
    const { partnerA, partnerB } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partnerB.id), () =>
        db.insert(stripeConnectAccounts).values({
          partnerId: partnerA.id, // forged — RLS must reject
          stripeAccountId: 'acct_forge',
          livemode: false,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('system scope can seed (existence probe — not vacuous)', async () => {
    const { acctA } = await seed();
    const rows = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(stripeConnectAccounts)
        .where(eq(stripeConnectAccounts.id, acctA.id))
    );
    expect(rows).toHaveLength(1);
  });

  // The portal pay route (routes/portal/invoices.ts) runs under the portal user's
  // ORGANIZATION scope but must read the *partner's* connected account. A bare
  // org-scope getConnection() is silently RLS-filtered to null with no error
  // (the #1375 class) — which would make the pay route always 409 even for a
  // fully connected partner. These two cases pin the bug + its fix.
  runDb('getConnection under ORG scope is silently filtered to null (the pay-route trap)', async () => {
    const { partnerA, orgA } = await seed();
    // Sanity: a connected account genuinely exists for partner A (seeded above).
    const conn = await withDbAccessContext(orgCtx(orgA.id), () => getConnection(partnerA.id));
    expect(conn).toBeNull();
  });

  runDb('getConnection in a system sub-context (the pay-route fix) reads the connected account', async () => {
    const { partnerA, orgA } = await seed();
    // Mirror the pay route exactly: from inside the portal org transaction, escape
    // to a system sub-context to read the partner-axis row.
    const conn = await withDbAccessContext(orgCtx(orgA.id), () =>
      runOutsideDbContext(() => withSystemDbAccessContext(() => getConnection(partnerA.id)))
    );
    expect(conn).not.toBeNull();
    expect(conn?.partnerId).toBe(partnerA.id);
    expect(conn?.status).toBe('connected');
  });
});

describe('invoice_stripe_payments RLS (breeze_app)', () => {
  runDb('forged cross-org insert is rejected', async () => {
    const { orgA, orgB, invoiceA } = await seed();
    await expect(
      withDbAccessContext(orgCtx(orgB.id), () =>
        db.insert(invoiceStripePayments).values({
          orgId: orgA.id, // forged — RLS must reject
          invoiceId: invoiceA.id, // real org-A invoice so the FK resolves
          stripeAccountId: 'acct_x',
          stripeObjectType: 'payment_intent',
          stripeObjectId: 'pi_forge',
          amount: '1.00',
          currency: 'USD',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // The reconcile layer's idempotency guard (mapping.invoice_payment_id) is the
  // first line of defense against a Stripe redelivery, but it races a concurrent
  // delivery. The unique index invoice_stripe_payments_object_uq on
  // stripe_object_id is the DB-level backstop: two rows for the same Stripe object
  // can never coexist, so a redelivery that loses the race surfaces a unique
  // violation (23505) rather than a duplicate payment mapping. This pins that index.
  runDb('the stripe_object_id unique index backstops the app idempotency guard', async () => {
    const { orgA, invoiceA } = await seed();
    const sameObjectId = `cs_idem_${invoiceA.id.slice(0, 8)}`;

    const insertOnce = () =>
      withDbAccessContext(orgCtx(orgA.id), () =>
        db.insert(invoiceStripePayments).values({
          orgId: orgA.id,
          invoiceId: invoiceA.id,
          stripeAccountId: 'acct_idem',
          stripeObjectType: 'checkout_session',
          stripeObjectId: sameObjectId, // SAME object id both times
          amount: '1.00',
          currency: 'USD',
          status: 'pending',
        })
      );

    // First insert succeeds (legitimate org-A write).
    await expect(insertOnce()).resolves.toBeDefined();
    // Second insert of the SAME stripe_object_id is rejected by the unique index.
    await expect(insertOnce()).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});
