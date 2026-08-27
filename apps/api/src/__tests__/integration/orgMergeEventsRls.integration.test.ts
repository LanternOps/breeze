/**
 * org_merge_events RLS — cross-partner forge proof (breeze_app role).
 *
 * Migration under test: 2026-09-12-100001-org-lifecycle-foundations.sql (Section 3)
 *
 * Shape 3 (partner-axis, flat breeze_has_partner_access(partner_id), no
 * org_id column — the table's own tenant column is partner_id; loser_org_id
 * and survivor_org_id are FK-scoped identifiers, not the tenancy axis).
 * Policy (USING + WITH CHECK):
 *   public.breeze_current_scope() = 'system'
 *     OR public.breeze_has_partner_access(partner_id)
 *
 * Runs through the REAL postgres.js driver (breeze_app role, rolbypassrls =
 * false — see setup.ts), so RLS is genuinely enforced. Proves:
 *   1. a partner-A caller cannot INSERT a merge event for partner B (WITH
 *      CHECK on partner_id fails).
 *   2. a partner-A caller's SELECT sees only partner A's own merge events.
 *   3. the merge worker's system context (withSystemDbAccessContext) can
 *      insert rows regardless of partner — RLS bypass by design.
 *   4. deleting the survivor organization cascades the merge-event row
 *      (survivor_org_id FK ON DELETE CASCADE) — the row does NOT persist
 *      as an orphan.
 *   5. an UPDATE on a seeded row is refused by the
 *      org_merge_events_block_update trigger (Section 3 of the migration) —
 *      RLS/system-scope bypass does not defeat the append-only invariant.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { orgMergeEvents, organizations, partners } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

interface SeededTenant {
  partnerId: string;
  orgId: string;
}

/**
 * Seeds two unrelated partners, each with one organization (the "survivor"
 * org for that partner's merge events), as the privileged test role (which
 * bypasses RLS). Partner A is the "attacker"; partner B is the victim.
 * Re-seeded PER TEST (called from each `it`) — NOT hoisted to module scope,
 * because setup.ts's beforeEach TRUNCATE CASCADE would wipe a hoisted
 * fixture and silently make later cases vacuous.
 */
async function seedTwoTenants(): Promise<{
  a: SeededTenant;
  b: SeededTenant;
  partnerAContext: DbAccessContext;
}> {
  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });

  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });

  seededPartnerIds.push(partnerA.id, partnerB.id);
  seededOrgIds.push(orgA.id, orgB.id);

  // Mirrors authMiddleware for a partner-scope user: they can access their
  // own partner + org.
  const partnerAContext: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [orgA.id],
    accessiblePartnerIds: [partnerA.id],
  };

  return {
    a: { partnerId: partnerA.id, orgId: orgA.id },
    b: { partnerId: partnerB.id, orgId: orgB.id },
    partnerAContext,
  };
}

/**
 * Returns the postgres.js cause on an RLS/constraint rejection, or undefined
 * if the call unexpectedly succeeded. drizzle wraps the top-level message as
 * "Failed query: ..." — the real policy error lands on `.cause`.
 */
async function captureRlsCause(
  fn: () => Promise<unknown>
): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await fn();
    return undefined; // no throw = isolation hole
  } catch (err) {
    return (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  }
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);

  // org_merge_events FKs both partner_id and survivor_org_id; delete first
  // (loser_org_id has no FK by design, so it's not a cleanup concern).
  await adminDb.delete(orgMergeEvents).where(sql`${orgMergeEvents.partnerId} IN (${partnerList})`);
  if (seededOrgIds.length > 0) {
    const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
    await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  }
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('org_merge_events RLS — cross-partner forge (breeze_app role)', () => {
  it("rejects a cross-partner INSERT (partner A forging a merge event for partner B's own survivor org)", async () => {
    const { b, partnerAContext } = await seedTwoTenants();

    // The forged row is internally consistent (survivor org B really does
    // belong to partner B) — the only thing wrong with it is that partner
    // A's context is inserting it.
    const cause = await captureRlsCause(() =>
      withDbAccessContext(partnerAContext, () =>
        db.insert(orgMergeEvents).values({
          partnerId: b.partnerId, // forged: belongs to partner B
          loserOrgId: randomUUID(),
          loserOrgName: 'Forged Loser Org',
          survivorOrgId: b.orgId, // forged: belongs to partner B
          summary: { devices: { moved: 3, dropped: 0 } },
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "org_merge_events"/
    );
  });

  it('hides a partner-B merge event from a partner-A SELECT (seeded via system scope)', async () => {
    const { a, b, partnerAContext } = await seedTwoTenants();

    // System scope legitimately bypasses the partner predicate — seed
    // partner B's merge event this way (mirrors the org-merge worker's
    // write path, which runs under withSystemDbAccessContext).
    const [seededB] = await withSystemDbAccessContext(() =>
      db
        .insert(orgMergeEvents)
        .values({
          partnerId: b.partnerId,
          loserOrgId: randomUUID(),
          loserOrgName: 'Partner B Loser Org',
          survivorOrgId: b.orgId,
          summary: { devices: { moved: 5, dropped: 1 } },
        })
        .returning({ id: orgMergeEvents.id })
    );
    expect(seededB?.id).toBeDefined();

    // Sanity: partner A's own legitimate merge event remains visible to itself.
    const [seededA] = await withSystemDbAccessContext(() =>
      db
        .insert(orgMergeEvents)
        .values({
          partnerId: a.partnerId,
          loserOrgId: randomUUID(),
          loserOrgName: 'Partner A Loser Org',
          survivorOrgId: a.orgId,
          summary: { devices: { moved: 2, dropped: 0 } },
        })
        .returning({ id: orgMergeEvents.id })
    );
    expect(seededA?.id).toBeDefined();

    const ownRows = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: orgMergeEvents.id })
        .from(orgMergeEvents)
        .where(eq(orgMergeEvents.id, seededA!.id))
    );
    expect(ownRows).toHaveLength(1);

    // Partner A must not see partner B's merge event.
    const crossRows = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: orgMergeEvents.id })
        .from(orgMergeEvents)
        .where(eq(orgMergeEvents.id, seededB!.id))
    );
    expect(crossRows).toEqual([]);
  });

  it('allows the system context (merge worker) to insert regardless of partner', async () => {
    const { a } = await seedTwoTenants();

    const [seeded] = await withSystemDbAccessContext(() =>
      db
        .insert(orgMergeEvents)
        .values({
          partnerId: a.partnerId,
          loserOrgId: randomUUID(),
          loserOrgName: 'System-Inserted Loser Org',
          survivorOrgId: a.orgId,
          summary: { devices: { moved: 10, dropped: 2 } },
        })
        .returning({ id: orgMergeEvents.id })
    );
    expect(seeded?.id).toBeDefined();

    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(orgMergeEvents).where(eq(orgMergeEvents.id, seeded!.id))
    );
    expect(row?.partnerId).toBe(a.partnerId);
  });

  it('cascades the merge-event row when the survivor organization is deleted', async () => {
    const { a } = await seedTwoTenants();

    const [seeded] = await withSystemDbAccessContext(() =>
      db
        .insert(orgMergeEvents)
        .values({
          partnerId: a.partnerId,
          loserOrgId: randomUUID(),
          loserOrgName: 'Cascade Test Loser Org',
          survivorOrgId: a.orgId,
          summary: { devices: { moved: 1, dropped: 0 } },
        })
        .returning({ id: orgMergeEvents.id })
    );
    expect(seeded?.id).toBeDefined();

    // Delete the survivor org directly (as the privileged test role) —
    // the FK's ON DELETE CASCADE must remove the merge-event row too.
    const adminDb = getTestDb() as any;
    await adminDb.delete(organizations).where(eq(organizations.id, a.orgId));
    // Remove from the cleanup list — already gone.
    const idx = seededOrgIds.indexOf(a.orgId);
    if (idx !== -1) seededOrgIds.splice(idx, 1);

    const survivors = await withSystemDbAccessContext(() =>
      db.select({ id: orgMergeEvents.id }).from(orgMergeEvents).where(eq(orgMergeEvents.id, seeded!.id))
    );
    expect(survivors).toEqual([]);
  });

  it('refuses an UPDATE on a seeded row (org_merge_events_block_update trigger)', async () => {
    const { a } = await seedTwoTenants();

    const [seeded] = await withSystemDbAccessContext(() =>
      db
        .insert(orgMergeEvents)
        .values({
          partnerId: a.partnerId,
          loserOrgId: randomUUID(),
          loserOrgName: 'Immutability Test Loser Org',
          survivorOrgId: a.orgId,
          summary: { devices: { moved: 1, dropped: 0 } },
        })
        .returning({ id: orgMergeEvents.id })
    );
    expect(seeded?.id).toBeDefined();

    // System context bypasses RLS but not the append-only trigger — the
    // migration's GRANT list omits UPDATE as intent-only (ensureAppRole's
    // blanket GRANT re-permits it), so the trigger is the real enforcement.
    const cause = await captureRlsCause(() =>
      withSystemDbAccessContext(() =>
        db
          .update(orgMergeEvents)
          .set({ loserOrgName: 'Tampered' })
          .where(eq(orgMergeEvents.id, seeded!.id))
      )
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('P0001');
    expect(cause?.message).toMatch(/org_merge_events is append-only/);
  });
});
