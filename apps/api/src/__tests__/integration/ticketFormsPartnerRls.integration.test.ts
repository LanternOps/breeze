/**
 * ticket_forms RLS — dual-axis (org OR partner) enforcement (spec 2026-07-10).
 *
 * Migration under test: 2026-07-10-ticket-forms.sql.
 *
 * A ticket_forms row is owned by EITHER an org (org_id set, partner_id NULL —
 * a customer-specific intake form) OR a partner (partner_id set, org_id
 * NULL — a partner-wide form applied across all the MSP's orgs). The
 * dual-axis policy is:
 *   system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *          OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *
 * Modeled line-for-line on ssoProvidersPartnerRls.integration.test.ts. Same
 * blindspot as configuration_policies / software_policies / sso_providers:
 * the rls-coverage contract test's org-tenant auto-discovery already asserts
 * the breeze_has_org_access branch (ticket_forms has an org_id column), but
 * it does NOT prove the partner branch or the XOR CHECK — that requires a
 * functional test through the REAL postgres.js driver (breeze_app role),
 * which is what this suite is. See memory: rls_dual_axis_contract_test_blindspot.
 *
 * NOTE (Task 3 of the ticket-intake-forms plan): `listTicketFormsForOrg` is
 * implemented in Task 4, which lands after this suite is written. The last
 * test in this file ("fan-out equivalent") therefore stays RED until Task 4
 * ships the service — this is expected/intentional TDD sequencing, not a
 * bug. The first three tests (forge rejection, XOR check, org/partner
 * visibility isolation) must pass now.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { ticketForms, ticketFormOrgLinks } from '../../db/schema';
import { listTicketFormsForOrg } from '../../services/ticketFormService';
import { createOrganization, createPartner } from './db-utils';

const created: string[] = [];

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(
    { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null },
    async () => {
      for (const id of created) {
        await db.delete(ticketForms).where(eq(ticketForms.id, id));
      }
    }
  );
  created.length = 0;
});

function systemContext(): DbAccessContext {
  return { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
}

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null };
}

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

const baseForm = { name: 'Onboarding', fields: [], defaultTags: [] };

describe('ticket_forms partner RLS', () => {
  it('partner B forging partner A partner_id is rejected (42501)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db.insert(ticketForms).values({ ...baseForm, partnerId: partnerA.id, orgId: null }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('XOR owner check: both or neither owner violates 23514', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(ticketForms).values({ ...baseForm, partnerId: partner.id, orgId: org.id }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(ticketForms).values({ ...baseForm, partnerId: null, orgId: null }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('org B cannot read org A forms; org tokens cannot read partner-wide forms', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });

    const [orgForm] = await withDbAccessContext(systemContext(), () =>
      db.insert(ticketForms).values({ ...baseForm, orgId: orgA.id, partnerId: null }).returning()
    );
    const [partnerForm] = await withDbAccessContext(systemContext(), () =>
      db.insert(ticketForms).values({ ...baseForm, name: 'Partner-wide', partnerId: partner.id, orgId: null }).returning()
    );
    if (!orgForm || !partnerForm) throw new Error('insert returned no row');
    created.push(orgForm.id, partnerForm.id);

    const visibleToOrgB = await withDbAccessContext(orgContext(orgB.id), () =>
      db.select().from(ticketForms).where(eq(ticketForms.id, orgForm.id))
    );
    expect(visibleToOrgB).toEqual([]);

    // Org-scoped RLS context: partner-wide rows are invisible even though the
    // org belongs to that partner — this is WHY listTicketFormsForOrg reads
    // under a system context (heartbeat/#1105 pattern).
    const partnerRowsFromOrgCtx = await withDbAccessContext(orgContext(orgA.id), () =>
      db.select().from(ticketForms).where(eq(ticketForms.id, partnerForm.id))
    );
    expect(partnerRowsFromOrgCtx).toEqual([]);
  });

  it('fan-out equivalent: listTicketFormsForOrg resolves org-owned + partner-wide, never cross-partner', async () => {
    const partner = await createPartner();
    const otherPartner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });

    const rows = await withDbAccessContext(systemContext(), () =>
      db
        .insert(ticketForms)
        .values([
          { ...baseForm, name: 'Org-owned', orgId: org.id, partnerId: null },
          { ...baseForm, name: 'Partner-wide', partnerId: partner.id, orgId: null },
          { ...baseForm, name: 'Other partner', partnerId: otherPartner.id, orgId: null },
          { ...baseForm, name: 'Inactive', partnerId: partner.id, orgId: null, isActive: false }
        ])
        .returning()
    );
    created.push(...rows.map((r) => r.id));

    // Service manages its own system context — call it from OUTSIDE any request context.
    const forOrg = await listTicketFormsForOrg({ id: org.id, partnerId: partner.id });
    expect(forOrg.map((f) => f.name).sort()).toEqual(['Org-owned', 'Partner-wide']);

    const forOtherOrg = await listTicketFormsForOrg({ id: otherOrg.id, partnerId: otherPartner.id });
    expect(forOtherOrg.map((f) => f.name)).toEqual(['Other partner']);
  });

  it('org link rows are invisible cross-partner and writable only by the owning partner (42501)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgA2 = await createOrganization({ partnerId: partnerA.id });

    const [form] = await withDbAccessContext(systemContext(), () =>
      db.insert(ticketForms).values({ ...baseForm, partnerId: partnerA.id, orgId: null }).returning()
    );
    if (!form) throw new Error('insert returned no row');
    created.push(form.id);

    const [link] = await withDbAccessContext(systemContext(), () =>
      db.insert(ticketFormOrgLinks).values({ formId: form.id, orgId: orgA.id }).returning()
    );
    if (!link) throw new Error('insert returned no row');

    // Partner B cannot see partner A's link row (parent-join predicate denies).
    const visibleToPartnerB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select().from(ticketFormOrgLinks).where(eq(ticketFormOrgLinks.id, link.id))
    );
    expect(visibleToPartnerB).toEqual([]);

    // Partner B forging a link onto partner A's (invisible) form is rejected
    // at the DB layer — a distinct org so this doesn't collide with the
    // unique constraint instead of RLS.
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db.insert(ticketFormOrgLinks).values({ formId: form.id, orgId: orgA2.id }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    // The owning partner CAN see + would be permitted to write its own link row.
    const visibleToPartnerA = await withDbAccessContext(partnerContext(partnerA.id, [orgA.id, orgA2.id]), () =>
      db.select().from(ticketFormOrgLinks).where(eq(ticketFormOrgLinks.id, link.id))
    );
    expect(visibleToPartnerA).toEqual([link]);
  });

  it('link unique constraint rejects duplicates (23505)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const [form] = await withDbAccessContext(systemContext(), () =>
      db.insert(ticketForms).values({ ...baseForm, partnerId: partner.id, orgId: null }).returning()
    );
    if (!form) throw new Error('insert returned no row');
    created.push(form.id);

    await withDbAccessContext(systemContext(), () =>
      db.insert(ticketFormOrgLinks).values({ formId: form.id, orgId: org.id }).returning()
    );

    await expect(
      withDbAccessContext(systemContext(), () =>
        db.insert(ticketFormOrgLinks).values({ formId: form.id, orgId: org.id }).returning()
      )
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  // Deferred from Task 1's review: the two existing link-write assertions only
  // prove the DENY side (cross-partner forge → 42501). This proves the ALLOW
  // side of the same WITH CHECK clause — the owning partner's own context can
  // actually insert a link on its own form, exercising the
  // breeze_has_partner_access(tf.partner_id) branch positively, not just its
  // negation.
  it('the owning partner context can insert a link on its own partner-wide form', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const [form] = await withDbAccessContext(systemContext(), () =>
      db.insert(ticketForms).values({ ...baseForm, partnerId: partner.id, orgId: null }).returning()
    );
    if (!form) throw new Error('insert returned no row');
    created.push(form.id);

    const [link] = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db.insert(ticketFormOrgLinks).values({ formId: form.id, orgId: org.id }).returning()
    );
    expect(link).toMatchObject({ formId: form.id, orgId: org.id });
  });

  describe('allowlist resolution (Task 2: listTicketFormsForOrg)', () => {
    it('allowlist: partner-wide form with links is visible ONLY to linked orgs; an unlinked partner-wide form stays visible to all', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });

      const [formP] = await withDbAccessContext(systemContext(), () =>
        db.insert(ticketForms).values({ ...baseForm, name: 'P — allowlisted', partnerId: partner.id, orgId: null }).returning()
      );
      const [formQ] = await withDbAccessContext(systemContext(), () =>
        db.insert(ticketForms).values({ ...baseForm, name: 'Q — unlinked', partnerId: partner.id, orgId: null }).returning()
      );
      if (!formP || !formQ) throw new Error('insert returned no row');
      created.push(formP.id, formQ.id);

      await withDbAccessContext(systemContext(), () =>
        db.insert(ticketFormOrgLinks).values({ formId: formP.id, orgId: orgA.id }).returning()
      );

      const forOrgA = await listTicketFormsForOrg({ id: orgA.id, partnerId: partner.id });
      expect(forOrgA.map((f) => f.name).sort()).toEqual(['P — allowlisted', 'Q — unlinked']);

      const forOrgB = await listTicketFormsForOrg({ id: orgB.id, partnerId: partner.id });
      expect(forOrgB.map((f) => f.name)).toEqual(['Q — unlinked']);
    });

    it('portalOnly filters out showInPortal=false rows', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const rows = await withDbAccessContext(systemContext(), () =>
        db
          .insert(ticketForms)
          .values([
            { ...baseForm, name: 'Visible in portal', orgId: org.id, partnerId: null, showInPortal: true },
            { ...baseForm, name: 'Internal only', orgId: org.id, partnerId: null, showInPortal: false }
          ])
          .returning()
      );
      created.push(...rows.map((r) => r.id));

      const all = await listTicketFormsForOrg({ id: org.id, partnerId: partner.id });
      expect(all.map((f) => f.name).sort()).toEqual(['Internal only', 'Visible in portal']);

      const portalOnly = await listTicketFormsForOrg({ id: org.id, partnerId: partner.id }, { portalOnly: true });
      expect(portalOnly.map((f) => f.name)).toEqual(['Visible in portal']);
    });

    it('orders by sortOrder then name — exact order, no .sort() masking', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const rows = await withDbAccessContext(systemContext(), () =>
        db
          .insert(ticketForms)
          .values([
            { ...baseForm, name: 'Zebra', orgId: org.id, partnerId: null, sortOrder: 1 },
            { ...baseForm, name: 'Alpha', orgId: org.id, partnerId: null, sortOrder: 1 },
            { ...baseForm, name: 'Middle', orgId: org.id, partnerId: null, sortOrder: 2 }
          ])
          .returning()
      );
      created.push(...rows.map((r) => r.id));

      const forOrg = await listTicketFormsForOrg({ id: org.id, partnerId: partner.id });
      // sortOrder 1 group ordered by name (Alpha before Zebra), then sortOrder 2.
      expect(forOrg.map((f) => f.name)).toEqual(['Alpha', 'Zebra', 'Middle']);
    });
  });
});
