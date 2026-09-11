/**
 * #4596 W1 — a `time_entries` row cannot carry an `org_id` from another partner.
 *
 * `time_entries` is RLS Shape 3 (partner-axis): `time_entries_partner_access`
 * checks `breeze_has_partner_access(partner_id)` and says nothing at all about
 * `org_id`, whose FK pointed at `organizations(id)` alone. A caller authorised
 * for partner A could therefore write a row attributing billable labour to
 * partner B's customer: RLS passed (the partner matched), the FK passed (the
 * org existed), and every org-keyed reader downstream (invoiceAssembly.ts, the
 * #4547 block-hours drawdown) would have counted it against the victim's org.
 *
 * Every application writer already refuses this (three INSERT sites, all in
 * timeEntryService, all behind resolveTicketLink / resolveAndLockOrgLink).
 * This suite is about what the DATABASE refuses, which is what makes those
 * checks a nicety rather than the boundary — so the forge writes go through
 * the unprivileged `breeze_app` handle under a real RLS context, not the
 * admin pool.
 *
 * Teardown: delete only what this file seeds (partner-keyed cascade), matching
 * the idiom in time-entries-rls.integration.test.ts.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { timeEntries, users, organizations, partners } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const seededPartnerIds: string[] = [];

// Shape copied verbatim from the proven fixture in
// time-entries-rls.integration.test.ts — `accessibleOrgIds` is a real
// allowlist, not null (null means system-wide in the service layer and would
// weaken what these tests demonstrate).
function partnerCtx(partnerId: string, orgIds: string[], userId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId,
  };
}

async function seed() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  seededPartnerIds.push(partnerA.id, partnerB.id);
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const techA = await createUser({ partnerId: partnerA.id, orgId: null });
  return { partnerA, partnerB, orgA, orgB, techA };
}

function entryValues(partnerId: string, orgId: string | null, userId: string, offsetMs = 0) {
  return {
    partnerId,
    orgId,
    userId,
    startedAt: new Date(Date.now() - 120_000 - offsetMs),
    endedAt: new Date(Date.now() - 60_000 - offsetMs),
    durationMinutes: 1,
    // Required by time_entries_currency_required_when_org_chk whenever org_id
    // is non-NULL; harmless on the standalone (NULL org) row.
    currencyCode: 'USD' as const,
  };
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);
  // FK order: time_entries → users → organizations → partners.
  await adminDb.delete(timeEntries).where(sql`${timeEntries.partnerId} IN (${partnerList})`);
  await adminDb.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
  await adminDb.delete(organizations).where(sql`${organizations.partnerId} IN (${partnerList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('time_entries org/partner composite FK (#4596 W1)', () => {
  it('rejects an INSERT whose org_id belongs to another partner', async () => {
    const { partnerA, orgA, orgB, techA } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partnerA.id, [orgA.id, orgB.id], techA.id), () =>
        db.insert(timeEntries).values(
          // RLS passes: partner_id IS the caller's partner. The org, however,
          // belongs to partner B — which nothing in the policy ever checks.
          entryValues(partnerA.id, orgB.id, techA.id),
        ),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23503', constraint_name: 'time_entries_org_partner_fk' },
    });
  });

  it("rejects an UPDATE that moves a row onto another partner's org", async () => {
    const { partnerA, orgA, orgB, techA } = await seed();
    const ctx = partnerCtx(partnerA.id, [orgA.id, orgB.id], techA.id);
    const [row] = await withDbAccessContext(ctx, () =>
      db.insert(timeEntries).values(entryValues(partnerA.id, orgA.id, techA.id)).returning(),
    );
    await expect(
      withDbAccessContext(ctx, () =>
        db.update(timeEntries).set({ orgId: orgB.id }).where(eq(timeEntries.id, row!.id)),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23503', constraint_name: 'time_entries_org_partner_fk' },
    });
  });

  it("refuses another partner's partner_id outright, via RLS (42501)", async () => {
    // Discriminating control: the partner AXIS was always closed — RLS refuses
    // a foreign partner_id with 42501. What was open is the ORG axis on a row
    // whose partner_id is legitimately the caller's, which the two forge tests
    // above cover. Without this control a reader cannot tell which of the two
    // this suite actually proves.
    const { partnerA, partnerB, orgA, orgB, techA } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partnerA.id, [orgA.id, orgB.id], techA.id), () =>
        db.insert(timeEntries).values(entryValues(partnerB.id, orgB.id, techA.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('still accepts a same-partner org and a NULL org (standalone entry)', async () => {
    const { partnerA, orgA, techA } = await seed();
    const inserted = await withDbAccessContext(
      partnerCtx(partnerA.id, [orgA.id], techA.id),
      async () => {
        const [linked] = await db
          .insert(timeEntries)
          .values(entryValues(partnerA.id, orgA.id, techA.id))
          .returning();
        // MATCH SIMPLE: a NULL org_id row is exempt from the composite FK by
        // design — a standalone timer is attributed to no organization.
        const [standalone] = await db
          .insert(timeEntries)
          .values({ ...entryValues(partnerA.id, null, techA.id, 300_000), currencyCode: null })
          .returning();
        return { linked, standalone };
      },
    );
    expect(inserted.linked!.orgId).toBe(orgA.id);
    expect(inserted.standalone!.orgId).toBeNull();
  });

  it('declares the constraint DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const rows = (await (getTestDb() as any).execute(sql`
      SELECT condeferrable, condeferred FROM pg_constraint
      WHERE conname = 'time_entries_org_partner_fk'
        AND conrelid = 'time_entries'::regclass
    `)) as unknown as Array<{ condeferrable: boolean; condeferred: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.condeferrable).toBe(true);
    expect(rows[0]!.condeferred).toBe(false);
  });
});
