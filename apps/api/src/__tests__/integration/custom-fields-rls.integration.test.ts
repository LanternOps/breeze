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
  // Clean up rows the breeze_app inserts leave behind. Use the partner/org
  // context they were created under is overkill; system scope reaches all.
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
});
