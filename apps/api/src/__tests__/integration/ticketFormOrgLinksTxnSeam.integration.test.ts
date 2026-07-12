/**
 * ticket_forms org-links transaction seam (Critical — Phase 2 whole-branch review).
 *
 * POST /ticket-forms creates the parent ticket_forms row on the request's
 * withDbAccessContext transaction (C1, uncommitted), then syncs the org
 * allowlist. If syncTicketFormOrgLinks escapes to a FRESH system transaction
 * on another pooled connection (C2), C2's READ COMMITTED snapshot cannot see
 * C1's uncommitted parent, so the link policy's WITH CHECK `EXISTS (...
 * ticket_forms ...)` rejects the row (42501; were the policy absent, the
 * non-deferrable FK `ticket_form_org_links.form_id -> ticket_forms(id)`
 * would fail with 23503 at end of statement) and the whole request 500s. This suite mirrors that exact route seam: it inserts a
 * partner-wide parent inside a partner-scoped request context and then — STILL
 * inside that context — calls syncTicketFormOrgLinks with a non-empty
 * allowlist. It must land parent + links together, committed atomically.
 *
 * Partner-scoped tokens with orgAccess='all' are what reaches this path in
 * practice (POST partner-wide + canManagePartnerWidePolicies gate — which
 * system scope would also clear), so the ambient context is a partner context
 * whose accessiblePartnerIds covers the owning partner — which is what makes
 * the link WITH CHECK (breeze_has_partner_access on the parent) pass on the
 * ambient connection.
 *
 * The org-belongs-to-partner validation read, by contrast, runs under a
 * SYSTEM context (#2357): a request context's accessibleOrgIds only covers
 * active/trial, non-soft-deleted orgs, so validating on the ambient
 * connection made every save of a form that allowlisted a later-suspended/
 * churned/soft-deleted org fail with a false cross-partner 400. This suite
 * also pins the #2357 contract: owned-but-inactive and owned-but-soft-deleted
 * orgs are accepted; cross-partner ids still 400 (unknown-id rejection is
 * pinned in the unit suite, ticketFormService.test.ts).
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { ticketForms, ticketFormOrgLinks } from '../../db/schema';
import { syncTicketFormOrgLinks, TicketFormError } from '../../services/ticketFormService';
import { createOrganization, createPartner } from './db-utils';

const created: string[] = [];

function systemContext(): DbAccessContext {
  return { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
}

// Mirrors an orgAccess='all' partner token: accessibleOrgIds covers every org
// under the partner (buildDbAccessContext / computeAccessibleOrgIds), which is
// the only shape that clears canManagePartnerWidePolicies and thus the only one
// that reaches syncTicketFormOrgLinks.
function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId
  };
}

const baseForm = { name: 'Onboarding', fields: [], defaultTags: [] };

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(systemContext(), async () => {
    for (const id of created) {
      await db.delete(ticketForms).where(eq(ticketForms.id, id));
    }
  });
  created.length = 0;
});

describe('ticket_forms org-links transaction seam (POST with visibleOrgIds)', () => {
  it('creates parent + links on the SAME request transaction (no cross-connection FK 23503)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });

    // The whole seam runs inside ONE partner-scoped request transaction, exactly
    // like the POST route: insert the partner-wide parent (uncommitted here),
    // then sync the org allowlist against that not-yet-committed parent.
    const formId = await withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id]), async () => {
      const [row] = await db
        .insert(ticketForms)
        .values({ ...baseForm, partnerId: partner.id, orgId: null })
        .returning();
      if (!row) throw new Error('parent insert returned no row');
      await syncTicketFormOrgLinks(row.id, [orgA.id, orgB.id], partner.id);
      return row.id;
    });
    created.push(formId);

    // Committed together: both the parent and its two link rows are visible now.
    const [form] = await withDbAccessContext(systemContext(), () =>
      db.select().from(ticketForms).where(eq(ticketForms.id, formId))
    );
    expect(form).toBeTruthy();

    const links = await withDbAccessContext(systemContext(), () =>
      db.select().from(ticketFormOrgLinks).where(eq(ticketFormOrgLinks.formId, formId))
    );
    expect(links.map((l) => l.orgId).sort()).toEqual([orgA.id, orgB.id].sort());
  });

  // #2357 — an org that was validly allowlisted and later became suspended (or
  // churned/trial-expired) drops out of the caller's accessibleOrgIds
  // (auth.ts filters status IN ('active','trial')), so the OLD ambient-context
  // validation read couldn't see it and every subsequent save of the form
  // 400ed. The ownership check must accept any org of the owning partner
  // regardless of status.
  it('accepts an owned org that is SUSPENDED and thus invisible to the caller-shaped request context (#2357)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const suspendedOrg = await createOrganization({ partnerId: partner.id, status: 'suspended' });

    // Mirror a real token: the suspended org is NOT in accessibleOrgIds.
    const formId = await withDbAccessContext(partnerContext(partner.id, [orgA.id]), async () => {
      const [row] = await db
        .insert(ticketForms)
        .values({ ...baseForm, partnerId: partner.id, orgId: null })
        .returning();
      if (!row) throw new Error('parent insert returned no row');
      await syncTicketFormOrgLinks(row.id, [orgA.id, suspendedOrg.id], partner.id);
      return row.id;
    });
    created.push(formId);

    const links = await withDbAccessContext(systemContext(), () =>
      db.select().from(ticketFormOrgLinks).where(eq(ticketFormOrgLinks.formId, formId))
    );
    expect(links.map((l) => l.orgId).sort()).toEqual([orgA.id, suspendedOrg.id].sort());
  });

  // #2357 documented behavior: a SOFT-DELETED (deleted_at set) org of the
  // owning partner is also accepted — the link row is inert while the org is
  // deleted, and retaining it means a restored org rejoins the allowlist
  // instead of silently falling off it on some unrelated form edit. Only
  // hard-deleted (row gone) and cross-partner ids reject.
  it('accepts an owned org that is SOFT-DELETED (#2357 — link retained, inert until restore)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const softDeletedOrg = await createOrganization({ partnerId: partner.id, deletedAt: new Date() });

    const formId = await withDbAccessContext(partnerContext(partner.id, [orgA.id]), async () => {
      const [row] = await db
        .insert(ticketForms)
        .values({ ...baseForm, partnerId: partner.id, orgId: null })
        .returning();
      if (!row) throw new Error('parent insert returned no row');
      await syncTicketFormOrgLinks(row.id, [orgA.id, softDeletedOrg.id], partner.id);
      return row.id;
    });
    created.push(formId);

    const links = await withDbAccessContext(systemContext(), () =>
      db.select().from(ticketFormOrgLinks).where(eq(ticketFormOrgLinks.formId, formId))
    );
    expect(links.map((l) => l.orgId).sort()).toEqual([orgA.id, softDeletedOrg.id].sort());
  });

  it('rejects a cross-partner org id and persists NOTHING (rollback contract for the route)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const otherPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: otherPartner.id });

    // Same request-transaction seam, but one visibleOrgId belongs to a DIFFERENT
    // partner. The org-belongs-to-partner validation read must reject it with a
    // TicketFormError (400) BEFORE any link write, and — because the route wraps
    // this in try/catch and deletes the parent on failure — nothing must persist.
    await expect(
      withDbAccessContext(partnerContext(partner.id, [orgA.id]), async () => {
        const [row] = await db
          .insert(ticketForms)
          .values({ ...baseForm, partnerId: partner.id, orgId: null })
          .returning();
        if (!row) throw new Error('parent insert returned no row');
        try {
          await syncTicketFormOrgLinks(row.id, [orgA.id, foreignOrg.id], partner.id);
        } catch (err) {
          // Emulate the route's rollback-on-sync-failure.
          await db.delete(ticketForms).where(eq(ticketForms.id, row.id));
          throw err;
        }
      })
    ).rejects.toBeInstanceOf(TicketFormError);

    // No form and no links survived the rolled-back request.
    const forms = await withDbAccessContext(systemContext(), () =>
      db.select().from(ticketForms).where(eq(ticketForms.partnerId, partner.id))
    );
    expect(forms).toEqual([]);
    const links = await withDbAccessContext(systemContext(), () =>
      db.select().from(ticketFormOrgLinks).where(eq(ticketFormOrgLinks.orgId, foreignOrg.id))
    );
    expect(links).toEqual([]);
  });
});
