/**
 * Functional forge proof for the Phase 5 sender-domain routing table
 * (`customer_email_domains`).
 *
 * Migration under test: 2026-06-20-a-customer-email-domains.sql
 *
 * Shape 3 (partner-axis) + denormalized org_id. Two independent guards:
 *   1. RLS policy (USING + WITH CHECK):
 *        public.breeze_current_scope() = 'system'
 *          OR public.breeze_has_partner_access(partner_id)
 *   2. Composite FK (org_id, partner_id) -> organizations(id, partner_id):
 *        the mapped org MUST belong to the row's partner.
 *
 * The rls-coverage contract test only proves *a* partner policy exists; it
 * cannot prove the org_id can't be pointed at another partner's org (the
 * dual-axis blindspot, #1594/custom_field_definitions). This suite is the
 * functional proof, run through the real postgres.js driver as the
 * unprivileged `breeze_app` role (rolbypassrls = false; see setup.ts), so the
 * assertions are NOT vacuous.
 *
 * It proves, as the app role:
 *   1. a legitimate partner-A row (partner A, org A) INSERTs successfully
 *   2. cross-partner INSERT (partner A writing a partner-B row) is rejected by RLS
 *   3. cross-org INSERT (partner A, but org belonging to partner B) is rejected
 *      by the composite FK — the dual-axis proof
 *   4. a partner-B row (seeded via system scope) is invisible to a partner-A SELECT
 *
 * postgres.js surfaces the policy/constraint error on `.cause` (drizzle wraps
 * the top-level message), so rejections are matched against the cause message
 * (same convention as emailInboundRls).
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { customerEmailDomains } from '../../db/schema/emailInbound';
import { organizations, partners } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

/**
 * Seeds two unrelated partners, each with an org, as the privileged test role
 * (which bypasses RLS). Partner A is the "attacker"; partner B is the victim.
 */
async function seedTwoPartners() {
  const a = await createPartner();
  const aOrg = await createOrganization({ partnerId: a.id });
  const b = await createPartner();
  const bOrg = await createOrganization({ partnerId: b.id });

  seededPartnerIds.push(a.id, b.id);
  seededOrgIds.push(aOrg.id, bOrg.id);

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

  // FK order: customer_email_domains (FK partner_id, org_id) → orgs → partners.
  await adminDb
    .delete(customerEmailDomains)
    .where(sql`${customerEmailDomains.partnerId} IN (${partnerList})`);
  if (seededOrgIds.length > 0) {
    const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
    await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  }
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('customer_email_domains RLS — partner + org forge (breeze_app role)', () => {
  it('allows a legitimate partner-A row (partner A, org A)', async () => {
    const { a, aOrg, partnerAContext } = await seedTwoPartners();

    const domain = `legit-${uniqueSuffix()}.example.test`;
    const [row] = await withDbAccessContext(partnerAContext, () =>
      db
        .insert(customerEmailDomains)
        .values({ partnerId: a.id, orgId: aOrg.id, domain })
        .returning({ id: customerEmailDomains.id })
    );

    expect(row?.id).toBeDefined();
  });

  it('rejects a cross-partner INSERT (partner A writing a partner-B row) via RLS', async () => {
    const { b, bOrg, partnerAContext } = await seedTwoPartners();

    const cause = await captureRlsCause(() =>
      withDbAccessContext(partnerAContext, () =>
        db.insert(customerEmailDomains).values({
          partnerId: b.id, // forged: belongs to partner B
          orgId: bOrg.id,
          domain: `forge-${uniqueSuffix()}.example.test`,
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause).toMatch(/row-level security/i);
    expect(cause).toMatch(
      /new row violates row-level security policy for table "customer_email_domains"/
    );
  });

  it('rejects a cross-org INSERT (partner A, but org belonging to partner B) via the composite FK', async () => {
    const { a, b, bOrg, partnerAContext } = await seedTwoPartners();
    expect(b.id).toBeDefined();

    const cause = await captureRlsCause(() =>
      withDbAccessContext(partnerAContext, () =>
        db.insert(customerEmailDomains).values({
          partnerId: a.id, // passes the partner RLS predicate...
          orgId: bOrg.id, // ...but this org is not in partner A
          domain: `forge-org-${uniqueSuffix()}.example.test`,
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause).toMatch(/violates foreign key constraint/i);
    expect(cause).toMatch(/customer_email_domains_org_partner_fk/);
  });

  it('hides a partner-B row from a partner-A SELECT (seeded via system scope)', async () => {
    const { b, bOrg, partnerAContext } = await seedTwoPartners();

    const domain = `seed-b-${uniqueSuffix()}.example.test`;
    const [seeded] = await withSystemDbAccessContext(() =>
      db
        .insert(customerEmailDomains)
        .values({ partnerId: b.id, orgId: bOrg.id, domain })
        .returning({ id: customerEmailDomains.id })
    );
    expect(seeded?.id).toBeDefined();

    const rows = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: customerEmailDomains.id })
        .from(customerEmailDomains)
        .where(eq(customerEmailDomains.domain, domain))
    );

    expect(rows).toEqual([]);
  });
});
