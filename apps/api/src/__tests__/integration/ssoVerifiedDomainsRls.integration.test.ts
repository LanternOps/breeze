/**
 * Cross-org RLS forge tests for sso_verified_domains (security review #2, H-2).
 *
 * Migration under test: 2026-06-26-sso-verified-domains.sql.
 * RLS shape 1: direct org_id, USING + WITH CHECK on breeze_has_org_access(org_id).
 *
 * The rls-coverage contract test only proves the policies exist in pg_catalog; it
 * does NOT prove a real cross-tenant insert is rejected at runtime. This file is
 * the behavioral guard: it runs code-under-test as the unprivileged `breeze_app`
 * role (rolbypassrls=f) so RLS is actually enforced, and asserts that a forged
 * write for another org is denied (42501) and that another org's rows are invisible.
 *
 * Fixture topology (seeded fresh per test under system scope):
 *   partnerA → orgA   (the caller's tenant)
 *   partnerB → orgB   (the foreign tenant)
 *   domainB           = a sso_verified_domains row under orgB (hidden-SELECT case)
 *
 * No memoization: setup.ts's beforeEach cleanupDatabase() TRUNCATEs
 * partners/organizations CASCADE before every test, cascading through the FKs.
 * A module-level fixture cache would hand later tests rows that no longer exist,
 * making cross-tenant assertions vacuous (matching the pattern of quotes-rls and
 * catalog-rls integration tests).
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
import { ssoVerifiedDomains } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  partnerB: { id: string };
  orgB: { id: string };
  /** A sso_verified_domains row owned by orgB (seeded under system scope). */
  domainB: { id: string };
  /** breeze_app context scoped to org A (mirrors authMiddleware org scope). */
  orgAContext: DbAccessContext;
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

    // A verified domain row owned by orgB, written under system scope (bypasses
    // RLS for the seed). The hidden-SELECT case proves an orgA caller cannot see it.
    const [domainB] = await db
      .insert(ssoVerifiedDomains)
      .values({
        orgId: orgB.id,
        domain: 'orgb-example.com',
        verificationToken: 'seed-token-for-orgb-domain',
      })
      .returning({ id: ssoVerifiedDomains.id });
    if (!domainB) throw new Error('failed to seed orgB verified domain');

    // Org-scoped breeze_app context for org A. sso_verified_domains is org-axis
    // RLS, so the accessible-org axis must list orgA for the breeze_app
    // insert/select to pass — this mirrors how request middleware populates an
    // org-scoped ctx.
    const orgAContext: DbAccessContext = {
      scope: 'organization',
      orgId: orgA.id,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [partnerA.id],
      userId: null,
    };

    return {
      partnerA: { id: partnerA.id },
      orgA: { id: orgA.id },
      partnerB: { id: partnerB.id },
      orgB: { id: orgB.id },
      domainB: { id: domainB.id },
      orgAContext,
    };
  });
}

describe('sso_verified_domains RLS isolation (breeze_app)', () => {
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

  // (1) Cross-tenant INSERT denied. Under an orgA-scoped breeze_app context, a
  // raw insert of a domain row for orgB is rejected by the INSERT WITH CHECK
  // policy (42501). Drizzle wraps the driver error; the original Postgres error
  // is carried on `cause`. We assert cause.code=42501 (not a FK 23503) to prove
  // RLS WITH CHECK is the gate — orgB is a real seeded org, so its FK resolves.
  runDb('blocks a forged cross-tenant sso_verified_domains INSERT for another org (42501)', async () => {
    const fx = await seedFixture();
    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(ssoVerifiedDomains).values({
          orgId: fx.orgB.id, // foreign org — RLS WITH CHECK must reject
          domain: 'forged-domain.example.com',
          verificationToken: 'forged-token',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (2) Cross-tenant SELECT hidden. orgB's domain row is invisible to an orgA
  // caller. The system-scope probe first confirms the row really exists (so a
  // 0-row read under orgA is meaningfully "RLS hid it", not "it was never
  // created") — this guards against a vacuous hidden-row test.
  runDb('hides another org domain row from SELECT (system probe confirms it exists)', async () => {
    const fx = await seedFixture();

    // Probe: under system scope (RLS-bypassing) the orgB domain row is present.
    const existsUnderSystem = await withSystemDbAccessContext(() =>
      db
        .select({ id: ssoVerifiedDomains.id })
        .from(ssoVerifiedDomains)
        .where(eq(ssoVerifiedDomains.id, fx.domainB.id))
    );
    expect(existsUnderSystem).toHaveLength(1);

    // Under orgA breeze_app context the same id returns 0 rows — RLS hides it.
    const visibleToA = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ id: ssoVerifiedDomains.id })
        .from(ssoVerifiedDomains)
        .where(eq(ssoVerifiedDomains.id, fx.domainB.id))
    );
    expect(visibleToA).toHaveLength(0);
  });

  // (3) Same-tenant happy path. Under orgA context, inserting + selecting orgA's
  // own domain row succeeds. This proves the policy is not simply deny-everything
  // (which would make cases 1/2 pass for the wrong reason).
  runDb('allows inserting + selecting a verified domain within the caller org', async () => {
    const fx = await seedFixture();

    const [inserted] = await withDbAccessContext(fx.orgAContext, () =>
      db
        .insert(ssoVerifiedDomains)
        .values({
          orgId: fx.orgA.id,
          domain: 'orga-example.com',
          verificationToken: 'valid-token-for-orga',
        })
        .returning({ id: ssoVerifiedDomains.id, orgId: ssoVerifiedDomains.orgId })
    );
    expect(inserted?.orgId).toBe(fx.orgA.id);

    const fetched = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ id: ssoVerifiedDomains.id })
        .from(ssoVerifiedDomains)
        .where(eq(ssoVerifiedDomains.id, inserted!.id))
    );
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.id).toBe(inserted!.id);
  });
});
