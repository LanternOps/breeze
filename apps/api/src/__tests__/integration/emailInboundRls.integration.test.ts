/**
 * Functional cross-partner forge proof for the Phase 4 email-to-ticket ingest
 * tables (`ticket_email_inbound`, `partner_inbound_domains`).
 *
 * Migration under test: 2026-06-13-d-ticketing-email-inbound.sql
 *
 * Both tables are Shape 3 (partner-axis). Policy (USING + WITH CHECK):
 *   public.breeze_current_scope() = 'system'
 *     OR public.breeze_has_partner_access(partner_id)
 *
 * The rls-coverage contract test only proves *a* policy with the right helper
 * exists — it cannot prove the scoping is actually correct (the dual-axis /
 * FK-child blindspots have bitten us before). This suite is the functional
 * proof: it runs through the REAL postgres.js driver, whose pool connects as
 * the unprivileged `breeze_app` role (rolbypassrls = false — see setup.ts),
 * so RLS is genuinely enforced and these assertions are NOT vacuous.
 *
 * It proves, as the app role:
 *   1. cross-partner INSERT into ticket_email_inbound is rejected (WITH CHECK)
 *   2. null-partner INSERT under partner scope is rejected (only system scope
 *      may write a null-partner row)
 *   3. a partner-B row (seeded via system scope) is invisible to a partner-A
 *      SELECT
 *   4. the same INSERT-rejection + SELECT-invisibility for
 *      partner_inbound_domains
 *
 * postgres.js surfaces the policy error on `.cause` (drizzle wraps the
 * top-level message as "Failed query: ..."), so RLS rejections are matched
 * against the cause message (same convention as ticket-comments-rls).
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { ticketEmailInbound, partnerInboundDomains } from '../../db/schema/emailInbound';
import { organizations, partners } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

/**
 * Partner/org ids seeded here, for afterAll cleanup. beforeEach in setup.ts
 * TRUNCATE-CASCADEs core tenant tables between tests, so usually only the last
 * test's rows survive — deleting everything registered is a harmless superset.
 */
const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

/**
 * Seeds two unrelated partners (each with an org so accessibleOrgIds is
 * non-empty, mirroring a real partner context) as the privileged test role,
 * which bypasses RLS. Partner A is the "attacker"; partner B is the victim.
 */
async function seedTwoPartners() {
  const a = await createPartner();
  const aOrg = await createOrganization({ partnerId: a.id });
  const b = await createPartner();
  const bOrg = await createOrganization({ partnerId: b.id });

  seededPartnerIds.push(a.id, b.id);
  seededOrgIds.push(aOrg.id, bOrg.id);

  // Mirrors authMiddleware for partner scope: accessiblePartnerIds = [own].
  const partnerAContext: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [aOrg.id],
    accessiblePartnerIds: [a.id],
    userId: null,
  };

  return { a, aOrg, b, bOrg, partnerAContext };
}

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Returns the postgres.js cause message for an RLS rejection, or undefined if
 * the call unexpectedly succeeded. drizzle wraps the policy error from
 * postgres.js on `.cause`.
 */
async function captureRlsCause(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined; // no throw = isolation hole
  } catch (err) {
    return (err as { cause?: { message?: string } } | undefined)?.cause?.message;
  }
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);

  // FK order: email-inbound (FK partner_id, ticket_id) → orgs → partners.
  await adminDb
    .delete(ticketEmailInbound)
    .where(sql`${ticketEmailInbound.partnerId} IN (${partnerList})`);
  await adminDb
    .delete(partnerInboundDomains)
    .where(sql`${partnerInboundDomains.partnerId} IN (${partnerList})`);
  if (seededOrgIds.length > 0) {
    const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
    await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  }
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('ticket_email_inbound RLS — cross-partner forge (breeze_app role)', () => {
  it('rejects a cross-partner INSERT (partner A writing a partner-B row)', async () => {
    const { b, partnerAContext } = await seedTwoPartners();

    const cause = await captureRlsCause(() =>
      withDbAccessContext(partnerAContext, () =>
        db.insert(ticketEmailInbound).values({
          partnerId: b.id, // forged: belongs to partner B
          provider: 'postmark',
          providerMessageId: `forge-${uniqueSuffix()}`,
          parseStatus: 'ignored',
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause).toMatch(/row-level security/i);
    expect(cause).toMatch(
      /new row violates row-level security policy for table "ticket_email_inbound"/
    );
  });

  it('rejects a null-partner INSERT under partner scope (only system scope may write null-partner rows)', async () => {
    const { partnerAContext } = await seedTwoPartners();

    const cause = await captureRlsCause(() =>
      withDbAccessContext(partnerAContext, () =>
        db.insert(ticketEmailInbound).values({
          partnerId: null, // unresolved recipient: system-scope-only write
          provider: 'postmark',
          providerMessageId: `forge-null-${uniqueSuffix()}`,
          parseStatus: 'ignored',
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause).toMatch(/row-level security/i);
    expect(cause).toMatch(
      /new row violates row-level security policy for table "ticket_email_inbound"/
    );
  });

  it('hides a partner-B row from a partner-A SELECT (seeded via system scope)', async () => {
    const { b, partnerAContext } = await seedTwoPartners();

    // System scope legitimately bypasses the partner predicate (the inbound
    // worker runs here) — seed partner B's row this way.
    const providerMessageId = `seed-b-${uniqueSuffix()}`;
    const [seeded] = await withSystemDbAccessContext(() =>
      db
        .insert(ticketEmailInbound)
        .values({
          partnerId: b.id,
          provider: 'postmark',
          providerMessageId,
          parseStatus: 'parsed',
        })
        .returning({ id: ticketEmailInbound.id })
    );
    expect(seeded?.id).toBeDefined();

    // Partner A must not see partner B's row.
    const rows = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: ticketEmailInbound.id })
        .from(ticketEmailInbound)
        .where(eq(ticketEmailInbound.providerMessageId, providerMessageId))
    );

    expect(rows).toEqual([]);
  });
});

describe('partner_inbound_domains RLS — cross-partner forge (breeze_app role)', () => {
  it('rejects a cross-partner INSERT (partner A writing a partner-B row)', async () => {
    const { b, partnerAContext } = await seedTwoPartners();

    const cause = await captureRlsCause(() =>
      withDbAccessContext(partnerAContext, () =>
        db.insert(partnerInboundDomains).values({
          partnerId: b.id, // forged: belongs to partner B
          domain: `forge-${uniqueSuffix()}.example.test`,
          provider: 'postmark',
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause).toMatch(/row-level security/i);
    expect(cause).toMatch(
      /new row violates row-level security policy for table "partner_inbound_domains"/
    );
  });

  it('hides a partner-B row from a partner-A SELECT (seeded via system scope)', async () => {
    const { b, partnerAContext } = await seedTwoPartners();

    const domain = `seed-b-${uniqueSuffix()}.example.test`;
    const [seeded] = await withSystemDbAccessContext(() =>
      db
        .insert(partnerInboundDomains)
        .values({
          partnerId: b.id,
          domain,
          provider: 'postmark',
        })
        .returning({ id: partnerInboundDomains.id })
    );
    expect(seeded?.id).toBeDefined();

    const rows = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: partnerInboundDomains.id })
        .from(partnerInboundDomains)
        .where(eq(partnerInboundDomains.domain, domain))
    );

    expect(rows).toEqual([]);
  });
});
