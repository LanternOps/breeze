/**
 * Functional cross-tenant RLS forge tests for the quote engine (Task 10).
 *
 * SECURITY-CRITICAL. The rls-coverage contract test (Task 6) only proves the
 * policies EXIST in pg_catalog; it does NOT prove a real cross-tenant insert is
 * rejected at runtime, and it cannot catch a missing axis (the
 * custom_field_definitions / #1016 dual-axis blindspot in repo memory). This
 * file is the behavioral guard: it runs code-under-test as the unprivileged
 * `breeze_app` role (rolbypassrls=f) so RLS is actually enforced, and asserts
 * that a forged write for another org is denied and that another org's rows are
 * invisible.
 *
 * Runs under vitest.integration.config.ts. Code-under-test connects through the
 * `db` proxy, which inside a `withDbAccessContext(...)` call uses the
 * `breeze_app` pool (DATABASE_URL_APP). If the `.env.test` symlink that pins
 * this to breeze_app were missing, these forge assertions would pass vacuously
 * on a BYPASSRLS admin connection (see memory: worktree_env_test_rls_vacuous) —
 * so case (0) asserts rolbypassrls=f under the app context before trusting the
 * rest.
 *
 * Fixture topology (seeded fresh per test under system scope, which bypasses
 * RLS so the seed can write the partner/org/quote rows):
 *   partnerA → orgA   (the caller's tenant)
 *   partnerB → orgB   (the foreign tenant)
 *   quoteB            = a quotes row under orgB, used by the hidden-SELECT case
 *
 * Why NO memoization: integration/setup.ts runs cleanupDatabase() in a
 * beforeEach that TRUNCATE ... CASCADEs partners/organizations before every
 * test, cascading through the quote FKs. A module-level fixture cache would
 * hand later tests rows that no longer exist, making the cross-tenant
 * assertions vacuous (a 0-row SELECT passes even with RLS off; a forged INSERT
 * can surface an incidental FK 23503 instead of the RLS 42501). Each it()
 * re-seeds fresh — matching every sibling *-rls.integration.test.ts.
 *
 * The quotes/quote_lines/quote_blocks tables use shape-1 org-axis RLS
 * (breeze_has_org_access(org_id), INSERT WITH CHECK + SELECT/UPDATE/DELETE
 * USING) per the 2026-06-16-quotes.sql migration.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { quotes, quoteLines, quoteImages, quoteAcceptances } from '../../db/schema/quotes';
import { createOrganization, createPartner } from './db-utils';
import { createQuote } from '../../services/quoteService';
import { type QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  partnerB: { id: string };
  orgB: { id: string };
  /** A quotes row owned by orgB (seeded under system scope). */
  quoteB: { id: string };
  /** breeze_app context scoped to org A (mirrors authMiddleware org scope). */
  orgAContext: DbAccessContext;
  /** A partner-A actor whose app-layer reach is limited to org A only. */
  actorA: QuoteActor;
}

// Re-seeds fresh on every call. Intentionally NOT memoized: setup.ts's
// beforeEach cleanupDatabase() TRUNCATEs partners/organizations CASCADE before
// each test, so any cached rows would already be deleted by the time an
// assertion runs — which would silently make every cross-tenant case vacuous.
async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    // A quote owned by orgB, written under system scope (bypasses RLS for the
    // seed). The hidden-SELECT case proves an orgA caller cannot see it.
    const [quoteB] = await db
      .insert(quotes)
      .values({
        partnerId: partnerB.id,
        orgId: orgB.id,
        currencyCode: 'USD',
      })
      .returning({ id: quotes.id });
    if (!quoteB) throw new Error('failed to seed orgB quote');

    // Org-scoped breeze_app context for org A. quotes is org-axis RLS, so the
    // accessible-org axis must list orgA for the breeze_app insert/select to
    // pass — this mirrors how request middleware populates an org-scoped ctx.
    const orgAContext: DbAccessContext = {
      scope: 'organization',
      orgId: orgA.id,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [partnerA.id],
      userId: null,
    };

    // App-layer actor limited to org A (accessibleOrgIds = [orgA] — NOT null,
    // so the service guard can deny an orgB target). userId null: createdBy is
    // nullable, no real user row needed.
    const actorA: QuoteActor = {
      userId: null,
      partnerId: partnerA.id,
      accessibleOrgIds: [orgA.id],
    };

    return {
      partnerA: { id: partnerA.id },
      orgA: { id: orgA.id },
      partnerB: { id: partnerB.id },
      orgB: { id: orgB.id },
      quoteB: { id: quoteB.id },
      orgAContext,
      actorA,
    };
  });
}

describe('quotes RLS isolation (breeze_app)', () => {
  // (0) Non-vacuity guard: the pool that code-under-test runs on inside
  // withDbAccessContext must be the unprivileged breeze_app role with
  // rolbypassrls=f. If this is ever a BYPASSRLS connection, every assertion
  // below would pass even with broken policies — so fail loudly here first.
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.orgAContext, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls
                     FROM pg_roles WHERE rolname = current_user`)
    );
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  // (1) Cross-tenant INSERT denied (raw). Under an orgA-scoped breeze_app
  // context, a raw insert of a quote for orgB/partnerB is rejected by the
  // INSERT WITH CHECK policy. Drizzle wraps the driver error: the wrapper
  // message becomes "Failed query: insert into ...", and the original Postgres
  // error ("new row violates row-level security policy for table \"quotes\"",
  // code 42501 = insufficient_privilege) is carried on `cause`. We assert on
  // cause.code to match the verified sibling pattern (catalog-rls). A 42501
  // (not a 23503 FK error) is what proves the RLS WITH CHECK is the gate — and
  // partnerB/orgB are real seeded rows, so their FKs resolve.
  runDb('blocks a forged cross-tenant quotes INSERT for another org (42501)', async () => {
    const fx = await seedFixture();
    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(quotes).values({
          partnerId: fx.partnerB.id, // foreign partner
          orgId: fx.orgB.id, // foreign org — RLS WITH CHECK must reject
          currencyCode: 'USD',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (2) Cross-tenant SELECT hidden. orgB's quote is invisible to an orgA
  // caller. The system-scope probe first confirms the row really exists (so a
  // 0-row read under orgA is meaningfully "RLS hid it", not "it was never
  // created") — this is the guard against a vacuous hidden-row test.
  runDb('hides another org quote from SELECT (system probe confirms it exists)', async () => {
    const fx = await seedFixture();

    // Probe: under system scope (RLS-bypassing) the orgB quote is present.
    const existsUnderSystem = await withSystemDbAccessContext(() =>
      db.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, fx.quoteB.id))
    );
    expect(existsUnderSystem).toHaveLength(1);

    // Under orgA breeze_app context the same id returns 0 rows — RLS hides it.
    const visibleToA = await withDbAccessContext(fx.orgAContext, () =>
      db.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, fx.quoteB.id))
    );
    expect(visibleToA).toHaveLength(0);
  });

  // (3) Same-tenant happy path. Under orgA context, inserting + selecting
  // orgA's own quote succeeds. This proves the policy is not simply
  // deny-everything (which would make cases 1/2 pass for the wrong reason).
  runDb('allows inserting + selecting a quote within the caller org', async () => {
    const fx = await seedFixture();

    const [inserted] = await withDbAccessContext(fx.orgAContext, () =>
      db
        .insert(quotes)
        .values({ partnerId: fx.partnerA.id, orgId: fx.orgA.id, currencyCode: 'USD' })
        .returning({ id: quotes.id, orgId: quotes.orgId })
    );
    expect(inserted?.orgId).toBe(fx.orgA.id);

    const fetched = await withDbAccessContext(fx.orgAContext, () =>
      db.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, inserted!.id))
    );
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.id).toBe(inserted!.id);
  });

  // (4) Child table (quote_lines) forge denial. The line carries its own
  // denormalized org_id and an org-axis WITH CHECK policy; a forged insert for
  // orgB is rejected even when it references orgB's real quote (FK resolves, so
  // the failure is the RLS 42501, not a 23503). Proves the child-table policy
  // holds, not just the parent.
  runDb('blocks a forged cross-tenant quote_lines INSERT for another org (42501)', async () => {
    const fx = await seedFixture();
    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(quoteLines).values({
          quoteId: fx.quoteB.id, // orgB's real quote (FK resolves)
          orgId: fx.orgB.id, // foreign org — RLS WITH CHECK must reject
          sourceType: 'manual',
          description: 'forged line',
          quantity: '1',
          unitPrice: '10.00',
          lineTotal: '10.00',
          recurrence: 'one_time',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (5) App-layer guard complements RLS. createQuote for orgB with an actor
  // whose accessibleOrgIds is limited to orgA throws ORG_DENIED (403) BEFORE a
  // DB write is even attempted — defense-in-depth above the RLS floor.
  runDb('createQuote for a foreign org throws ORG_DENIED (403) at the service layer', async () => {
    const fx = await seedFixture();
    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        createQuote({ orgId: fx.orgB.id, currencyCode: 'USD' }, fx.actorA)
      )
    ).rejects.toMatchObject({ status: 403, code: 'ORG_DENIED' });
  });

  // (6) quote_images forge denial. quote_images is the byte source for the
  // rendered/served PDF (and the route comment claims cross-tenant reads are
  // blocked by RLS) — so a leak here would hand one tenant another tenant's
  // quote PDF bytes. It carries a denormalized org_id with an org-axis WITH
  // CHECK policy; a forged insert for orgB is rejected (42501) even when it
  // references orgB's real quote (FK resolves, so the failure is the RLS gate,
  // not a 23503). Mirrors the quote_lines child-table forge case.
  runDb('blocks a forged cross-tenant quote_images INSERT for another org (42501)', async () => {
    const fx = await seedFixture();
    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(quoteImages).values({
          quoteId: fx.quoteB.id, // orgB's real quote (FK resolves)
          orgId: fx.orgB.id, // foreign org — RLS WITH CHECK must reject
          imageData: Buffer.from('x'),
          mime: 'image/png',
          byteSize: 1,
          sha256: 'a'.repeat(64),
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (7) quote_images SELECT hidden. An orgB image row (seeded under system
  // scope) is invisible to an orgA caller. The system-scope probe first
  // confirms the row exists, so the 0-row read under orgA is meaningfully "RLS
  // hid the PDF bytes", not "the row was never written".
  runDb('hides another org quote_images from SELECT (system probe confirms it exists)', async () => {
    const fx = await seedFixture();

    // Seed an orgB image under system scope (RLS-bypassing seed).
    const seededId = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(quoteImages)
        .values({
          quoteId: fx.quoteB.id,
          orgId: fx.orgB.id,
          imageData: Buffer.from('x'),
          mime: 'image/png',
          byteSize: 1,
          sha256: 'b'.repeat(64),
        })
        .returning({ id: quoteImages.id });
      return row!.id;
    });

    // Probe: under system scope the row really exists.
    const existsUnderSystem = await withSystemDbAccessContext(() =>
      db.select({ id: quoteImages.id }).from(quoteImages).where(eq(quoteImages.id, seededId))
    );
    expect(existsUnderSystem).toHaveLength(1);

    // Under orgA breeze_app context the same id returns 0 rows — RLS hides it.
    const visibleToA = await withDbAccessContext(fx.orgAContext, () =>
      db.select({ id: quoteImages.id }).from(quoteImages).where(eq(quoteImages.id, seededId))
    );
    expect(visibleToA).toHaveLength(0);
  });

  // (8) quote_acceptances forge denial. This table records a signer's acceptance
  // of a quote (name/email/IP/UA + the signed quote_sha256) — a cross-tenant
  // write would let one tenant forge an acceptance against another tenant's
  // quote, or read a foreign customer's PII. Org-axis WITH CHECK; a forged
  // insert for orgB referencing orgB's real quote is rejected with 42501 (RLS
  // gate, not a 23503 FK error).
  runDb('blocks a forged cross-tenant quote_acceptances INSERT for another org (42501)', async () => {
    const fx = await seedFixture();
    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(quoteAcceptances).values({
          quoteId: fx.quoteB.id, // orgB's real quote (FK resolves)
          orgId: fx.orgB.id, // foreign org — RLS WITH CHECK must reject
          signerName: 'Mallory Forger',
          quoteSha256: 'c'.repeat(64),
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (9) quote_acceptances SELECT hidden. An orgB acceptance row (with its
  // signer PII) is invisible to an orgA caller; the system probe confirms it
  // exists so the 0-row read is a real RLS hide, not a vacuous miss.
  runDb('hides another org quote_acceptances from SELECT (system probe confirms it exists)', async () => {
    const fx = await seedFixture();

    const seededId = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(quoteAcceptances)
        .values({
          quoteId: fx.quoteB.id,
          orgId: fx.orgB.id,
          signerName: 'Bob (orgB customer)',
          signerEmail: 'bob@orgb.example.com',
          quoteSha256: 'd'.repeat(64),
        })
        .returning({ id: quoteAcceptances.id });
      return row!.id;
    });

    const existsUnderSystem = await withSystemDbAccessContext(() =>
      db.select({ id: quoteAcceptances.id }).from(quoteAcceptances).where(eq(quoteAcceptances.id, seededId))
    );
    expect(existsUnderSystem).toHaveLength(1);

    const visibleToA = await withDbAccessContext(fx.orgAContext, () =>
      db.select({ id: quoteAcceptances.id }).from(quoteAcceptances).where(eq(quoteAcceptances.id, seededId))
    );
    expect(visibleToA).toHaveLength(0);
  });
});
