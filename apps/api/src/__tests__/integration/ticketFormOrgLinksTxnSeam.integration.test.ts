/**
 * ticket_forms org-links transaction seam (Critical — Phase 2 whole-branch review).
 *
 * POST /ticket-forms creates the parent ticket_forms row on the request's
 * withDbAccessContext transaction (C1, uncommitted), then syncs the org
 * allowlist. If syncTicketFormOrgLinks escapes to a FRESH system transaction
 * on another pooled connection (C2), C2's READ COMMITTED snapshot cannot see
 * C1's uncommitted parent, so the non-deferrable FK
 * `ticket_form_org_links.form_id -> ticket_forms(id)` fails with 23503 and the
 * whole request 500s. This suite mirrors that exact route seam: it inserts a
 * partner-wide parent inside a partner-scoped request context and then — STILL
 * inside that context — calls syncTicketFormOrgLinks with a non-empty
 * allowlist. It must land parent + links together, committed atomically.
 *
 * Only partner-scoped tokens with orgAccess='all' reach this path (POST
 * partner-wide + canManagePartnerWidePolicies gate), so the ambient context is
 * always a partner context whose accessibleOrgIds covers every org under the
 * partner — which is what makes both the link WITH CHECK
 * (breeze_has_partner_access on the parent) and the org-belongs-to-partner
 * validation read (breeze_has_org_access on organizations) pass on the ambient
 * connection.
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
