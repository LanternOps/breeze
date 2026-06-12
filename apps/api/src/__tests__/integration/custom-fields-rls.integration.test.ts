/**
 * custom_field_definitions RLS — dual-axis (org OR partner) enforcement.
 *
 * Migration under test: 2026-06-11-i-custom-fields-dual-axis-rls.sql
 *
 * The squashed baseline shipped org-only Shape-1 policies
 * (breeze_org_isolation_*, all keyed on breeze_has_org_access(org_id)). But
 * routes/customFields.ts inserts a PARTNER-WIDE field (org_id=NULL,
 * partner_id set) whenever a partner-scoped user supplies no orgId — and
 * breeze_has_org_access(NULL) = FALSE, so that INSERT was rejected with
 *   PostgresError: new row violates row-level security policy
 * surfacing as a 500 "Internal Server Error" on "add custom field" for every
 * partner/MSP user. The partner-scoped rows were also invisible to SELECT.
 *
 * These tests run through the REAL postgres.js driver (the db pool connects
 * as the unprivileged breeze_app role) inside withDbAccessContext, so they
 * exercise actual RLS enforcement — not the contract-level policy metadata
 * check in rls-coverage.integration.test.ts (which the org-only policies
 * already satisfied, since it accepts org OR partner coverage).
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { customFieldDefinitions } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const created: string[] = [];

afterEach(async () => {
  // Clean up rows the test leaves behind. Reusing each row's original
  // partner/org context would be overkill: under system scope
  // breeze_has_org_access / breeze_has_partner_access short-circuit to TRUE,
  // so one system-context pass deletes every tracked row.
  if (created.length === 0) return;
  await withDbAccessContext(
    { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null },
    async () => {
      for (const id of created) {
        await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, id));
      }
    },
  );
  created.length = 0;
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

/**
 * Seed a partner-wide field (org_id NULL) as that partner, returning its id.
 * Tracked for cleanup unless `track` is false (the DELETE test removes the
 * row itself, so tracking it would double-delete — harmless, but misleading).
 */
async function seedPartnerField(partnerId: string, track = true): Promise<string> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(customFieldDefinitions)
      .values({
        orgId: null,
        partnerId,
        name: 'Seed',
        fieldKey: `seed_${unique}`,
        type: 'text',
      })
      .returning(),
  );
  const id = rows[0]!.id;
  if (track) created.push(id);
  return id;
}

describe('custom_field_definitions RLS — dual-axis (2026-06-11 migration)', () => {
  it('partner scope can INSERT a partner-wide field (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(customFieldDefinitions)
        .values({
          orgId: null,
          partnerId: partner.id,
          name: 'Asset Tag',
          fieldKey: `asset_tag_${unique}`,
          type: 'text',
        })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partner.id);
    if (rows[0]) created.push(rows[0].id);
  });

  it('partner scope can SELECT back its own partner-wide field', async () => {
    const partner = await createPartner();
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const inserted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(customFieldDefinitions)
        .values({
          orgId: null,
          partnerId: partner.id,
          name: 'Warranty',
          fieldKey: `warranty_${unique}`,
          type: 'date',
        })
        .returning(),
    );
    if (inserted[0]) created.push(inserted[0].id);

    const visible = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .select({ id: customFieldDefinitions.id })
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.partnerId, partner.id)),
    );

    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('a different partner can neither see nor INSERT into the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const inserted = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      db
        .insert(customFieldDefinitions)
        .values({
          orgId: null,
          partnerId: partnerA.id,
          name: 'Location',
          fieldKey: `location_${unique}`,
          type: 'text',
        })
        .returning(),
    );
    if (inserted[0]) created.push(inserted[0].id);

    // partnerB cannot see partnerA's field
    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .select({ id: customFieldDefinitions.id })
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.id, inserted[0]!.id)),
    );
    expect(visibleToB).toEqual([]);

    // partnerB cannot forge a row attributed to partnerA (WITH CHECK denies
    // it). Drizzle wraps the driver error, so the RLS signal is the Postgres
    // code 42501 (insufficient_privilege) on the underlying cause, not the
    // wrapper's top-level message.
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(customFieldDefinitions)
          .values({
            orgId: null,
            partnerId: partnerA.id,
            name: 'Forged',
            fieldKey: `forged_${unique}`,
            type: 'text',
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('org scope can still INSERT and SELECT an org-scoped field (regression guard)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(customFieldDefinitions)
        .values({
          orgId: org.id,
          partnerId: null,
          name: 'Department',
          fieldKey: `department_${unique}`,
          type: 'text',
        })
        .returning(),
    );
    if (inserted[0]) created.push(inserted[0].id);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(org.id);

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: customFieldDefinitions.id })
        .from(customFieldDefinitions)
        .where(
          and(
            eq(customFieldDefinitions.id, inserted[0]!.id),
            eq(customFieldDefinitions.orgId, org.id),
          ),
        ),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  // The migration rewrites all four DML policies. UPDATE (USING + WITH CHECK)
  // and DELETE (USING) are the silent-failure paths: pre-migration a partner
  // mutation of a partner-wide row matched zero rows (USING breeze_has_org_
  // access(NULL) = FALSE) with no error, so the route's PATCH/DELETE silently
  // no-op'd. These guard against a regression reintroducing that.
  it('partner scope can UPDATE its own partner-wide field', async () => {
    const partner = await createPartner();
    const id = await seedPartnerField(partner.id);

    const updated = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(customFieldDefinitions)
        .set({ name: 'Renamed' })
        .where(eq(customFieldDefinitions.id, id))
        .returning(),
    );

    // A USING-blocked update returns [] (no error); a real match returns the row.
    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe('Renamed');
  });

  it('partner scope can DELETE its own partner-wide field', async () => {
    const partner = await createPartner();
    const id = await seedPartnerField(partner.id, false); // this test removes it

    const deleted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .delete(customFieldDefinitions)
        .where(eq(customFieldDefinitions.id, id))
        .returning(),
    );

    // A USING-blocked delete returns [] (no error); a real match returns the row.
    expect(deleted).toHaveLength(1);
  });

  it('a different partner can neither UPDATE nor DELETE the first partner\'s field', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerField(partnerA.id);

    // partnerB's UPDATE matches no rows — partnerA's row is hidden by USING.
    const updatedByB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .update(customFieldDefinitions)
        .set({ name: 'Hijacked' })
        .where(eq(customFieldDefinitions.id, id))
        .returning(),
    );
    expect(updatedByB).toEqual([]);

    // partnerB's DELETE likewise affects nothing.
    const deletedByB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .delete(customFieldDefinitions)
        .where(eq(customFieldDefinitions.id, id))
        .returning(),
    );
    expect(deletedByB).toEqual([]);

    // The row still exists and is unchanged — confirm via the owning partner.
    const stillThere = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      db
        .select({ id: customFieldDefinitions.id, name: customFieldDefinitions.name })
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.id, id)),
    );
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0]?.name).toBe('Seed');
  });

  it('stays fail-closed without a DB access context (scope "none")', async () => {
    // Mirrors ticket-comments-rls: with no withDbAccessContext, breeze.scope is
    // unset (breeze_current_scope() = 'none'), so both helpers return FALSE and
    // a partner-wide row must be invisible on the bare pool.
    const partner = await createPartner();
    const id = await seedPartnerField(partner.id);

    const rows = await db
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(eq(customFieldDefinitions.id, id));

    expect(rows).toEqual([]);
  });
});
