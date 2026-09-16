/**
 * ticket_checklist_templates / ticket_checklist_template_items RLS — dual-axis
 * (org XOR partner) enforcement, branch-FK owner integrity, and the apply
 * fan-out (#5783 W02, CLAUDE.md "Partner-Wide First" step 6).
 *
 * The shipped policies (2026-10-16-191300-ticket-checklist-templates.sql) are:
 *   <table>_isolation            FOR ALL  system OR breeze_has_org_access(org_id)
 *                                        OR breeze_has_partner_access(partner_id)
 *   <table>_partner_wide_select  FOR SELECT  org_id IS NULL
 *                                        AND partner_id = breeze_current_partner_id()
 *
 * The SELECT branch is a separate permissive policy, never an edit to the FOR
 * ALL one: Postgres does not consult FOR SELECT policies when computing
 * UPDATE/DELETE target rows, so it ORs into reads and grants no write.
 *
 * `rls-coverage.integration.test.ts` proves the policies EXIST by reading
 * pg_catalog; it cannot prove either branch enforces anything. This suite
 * drives the real postgres.js driver as `breeze_app` under FORCE RLS, which is
 * the only thing that does.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  tickets,
  ticketChecklistItems,
  ticketChecklistTemplates,
  ticketChecklistTemplateItems,
} from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';
import { applyChecklistTemplateToTicket } from '../../services/ticketChecklistTemplateService';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdTemplateNames: string[] = [];
const createdTicketIds: string[] = [];

afterEach(async () => {
  const names = [...new Set(createdTemplateNames)];
  const ticketIds = [...new Set(createdTicketIds)];
  createdTemplateNames.length = 0;
  createdTicketIds.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (ticketIds.length > 0) {
      await db.delete(ticketChecklistItems).where(inArray(ticketChecklistItems.ticketId, ticketIds));
      await db.delete(tickets).where(inArray(tickets.id, ticketIds));
    }
    if (names.length > 0) {
      await db.delete(ticketChecklistTemplates).where(inArray(ticketChecklistTemplates.name, names));
    }
  });
});

/** A partner-scoped session: passes breeze_has_partner_access for its own partner. */
function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/**
 * An org-scoped session. `currentPartnerId` is populated from the token's
 * partnerId for org scope too (buildDbAccessContext) — exactly what the
 * partner-wide SELECT branch keys on. `null` is the degenerate "no partner GUC"
 * caller, kept so the `=` vs `IS NOT DISTINCT FROM` choice stays pinned.
 */
function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

function uniqueName(prefix: string): string {
  const name = `${prefix} ${Math.random().toString(36).slice(2, 10)}`;
  createdTemplateNames.push(name);
  return name;
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

/** Seed under SYSTEM scope, bypassing the policy under test. */
async function seedTemplate(values: {
  orgId?: string | null;
  partnerId?: string | null;
  name: string;
}): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(ticketChecklistTemplates)
      .values({
        orgId: values.orgId ?? null,
        partnerId: values.partnerId ?? null,
        name: values.name,
      })
      .returning({ id: ticketChecklistTemplates.id }),
  );
  return rows[0]!.id;
}

async function seedTemplateItem(
  templateId: string,
  owner: { orgId?: string | null; partnerId?: string | null },
  label: string,
  sortOrder = 0,
): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(ticketChecklistTemplateItems)
      .values({
        templateId,
        orgId: owner.orgId ?? null,
        partnerId: owner.partnerId ?? null,
        label,
        sortOrder,
      })
      .returning({ id: ticketChecklistTemplateItems.id }),
  );
  return rows[0]!.id;
}

async function seedTicket(orgId: string, partnerId: string): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(tickets)
      .values({
        orgId,
        partnerId,
        ticketNumber: `TPL-${Math.random().toString(36).slice(2, 10)}`,
        subject: 'checklist template apply',
        source: 'manual',
      })
      .returning({ id: tickets.id }),
  );
  const id = rows[0]!.id;
  createdTicketIds.push(id);
  return id;
}

const countTemplates = async (ctx: DbAccessContext, templateId: string): Promise<number> =>
  withDbAccessContext(ctx, async () => {
    const rows = await db
      .select({ id: ticketChecklistTemplates.id })
      .from(ticketChecklistTemplates)
      .where(eq(ticketChecklistTemplates.id, templateId));
    return rows.length;
  });

describe('ticket checklist template RLS (#5783 W02)', () => {
  describe('write policy', () => {
    it('partner scope can INSERT a partner-wide template (org_id NULL, partner_id set)', async () => {
      const partner = await createPartner();
      const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
        db
          .insert(ticketChecklistTemplates)
          .values({ orgId: null, partnerId: partner.id, name: uniqueName('Device onboarding') })
          .returning(),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.orgId).toBeNull();
      expect(rows[0]?.partnerId).toBe(partner.id);
    });

    it('refuses a cross-partner forge with 42501', async () => {
      const attacker = await createPartner();
      const victim = await createPartner();
      await expectSqlState(
        () =>
          withDbAccessContext(partnerContext(attacker.id, []), () =>
            db
              .insert(ticketChecklistTemplates)
              .values({ orgId: null, partnerId: victim.id, name: uniqueName('Forged') })
              .returning(),
          ),
        '42501',
      );
    });

    it('refuses a template claiming BOTH owners with 23514 (the XOR check)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      // Both axes set satisfies the RLS WITH CHECK on the org branch, so the
      // statement REACHES the CHECK — this proves the XOR does work RLS does not.
      await expectSqlState(
        () =>
          withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
            db
              .insert(ticketChecklistTemplates)
              .values({ orgId: org.id, partnerId: partner.id, name: uniqueName('Both axes') })
              .returning(),
          ),
        '23514',
      );
    });

    it('refuses a template claiming NEITHER owner with 23514 under system scope', async () => {
      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(ticketChecklistTemplates)
              .values({ orgId: null, partnerId: null, name: uniqueName('Orphan') })
              .returning(),
          ),
        '23514',
      );
    });

    it('refuses an ITEM claiming BOTH owners with 23514', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const templateId = await seedTemplate({ orgId: org.id, name: uniqueName('Org template') });
      await expectSqlState(
        () =>
          withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
            db
              .insert(ticketChecklistTemplateItems)
              .values({ templateId, orgId: org.id, partnerId: partner.id, label: 'x' })
              .returning(),
          ),
        '23514',
      );
    });

    it('refuses an item whose owner axis differs from its template (branch FK, 23503)', async () => {
      // The branch-FK pair is the ONLY thing preventing an org-owned item under
      // a partner-wide template. A single three-column MATCH SIMPLE FK would
      // pass this silently — which is why the design uses two.
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const templateId = await seedTemplate({
        partnerId: partner.id,
        name: uniqueName('Partner-wide'),
      });
      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(ticketChecklistTemplateItems)
              .values({ templateId, orgId: org.id, partnerId: null, label: 'Cross-owner' })
              .returning(),
          ),
        '23503',
      );
    });

    it('accepts a same-axis item under the same partner-wide template (positive control)', async () => {
      const partner = await createPartner();
      const templateId = await seedTemplate({
        partnerId: partner.id,
        name: uniqueName('Partner-wide ok'),
      });
      const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
        db
          .insert(ticketChecklistTemplateItems)
          .values({ templateId, orgId: null, partnerId: partner.id, label: 'Same owner' })
          .returning(),
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('read policy', () => {
    it('org A cannot see org B’s private template', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });
      const mine = await seedTemplate({ orgId: orgA.id, name: uniqueName('A private') });
      const theirs = await seedTemplate({ orgId: orgB.id, name: uniqueName('B private') });

      expect(await countTemplates(orgContext(orgA.id, partner.id), mine)).toBe(1);
      expect(await countTemplates(orgContext(orgA.id, partner.id), theirs)).toBe(0);
    });

    it('an ORG token reads its OWN partner’s partner-wide template through the SELECT branch', async () => {
      // THE load-bearing case. Without the branch an org context is silently
      // blind to every partner-wide template — no error, just nothing — and the
      // whole Partner-Wide First point of the feature evaporates.
      const partner = await createPartner();
      const other = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const mine = await seedTemplate({ partnerId: partner.id, name: uniqueName('Mine') });
      const theirs = await seedTemplate({ partnerId: other.id, name: uniqueName('Theirs') });

      expect(await countTemplates(orgContext(org.id, partner.id), mine)).toBe(1);
      expect(await countTemplates(orgContext(org.id, partner.id), theirs)).toBe(0);
      // NULL GUC: pins `=` over `IS NOT DISTINCT FROM` in the policy.
      expect(await countTemplates(orgContext(org.id, null), mine)).toBe(0);
    });

    it('an org context can READ a partner-wide template but cannot DELETE it', async () => {
      // Proves the SELECT-only branch was NOT folded into the FOR ALL policy. If
      // it had been, an org admin could delete their MSP's shared template.
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const shared = await seedTemplate({ partnerId: partner.id, name: uniqueName('Shared') });
      expect(await countTemplates(orgContext(org.id, partner.id), shared)).toBe(1);

      const deleted = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        db
          .delete(ticketChecklistTemplates)
          .where(eq(ticketChecklistTemplates.id, shared))
          .returning({ id: ticketChecklistTemplates.id }),
      );
      expect(deleted).toEqual([]);
      expect(await countTemplates(SYSTEM_CTX, shared)).toBe(1); // still there
    });

    it('an org context can READ a partner-wide template but cannot UPDATE it', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const shared = await seedTemplate({ partnerId: partner.id, name: uniqueName('Shared edit') });

      const updated = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        db
          .update(ticketChecklistTemplates)
          .set({ isActive: false })
          .where(eq(ticketChecklistTemplates.id, shared))
          .returning({ id: ticketChecklistTemplates.id }),
      );
      expect(updated).toEqual([]);
    });
  });

  describe('apply fan-out', () => {
    it('applying a PARTNER-WIDE template to an org ticket creates ORG-scoped rows in that org', async () => {
      // The fan-out proof. Copied rows must carry the TICKET's org, never the
      // template's NULL owner — otherwise a partner-wide template would either
      // fail the NOT NULL or create a row no tenant can see.
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const ticketId = await seedTicket(orgA.id, partner.id);
      const shared = await seedTemplate({ partnerId: partner.id, name: uniqueName('Onboarding') });
      await seedTemplateItem(shared, { partnerId: partner.id }, 'Step A', 0);
      await seedTemplateItem(shared, { partnerId: partner.id }, 'Step B', 1);

      await withDbAccessContext(partnerContext(partner.id, [orgA.id]), () =>
        applyChecklistTemplateToTicket(
          { id: ticketId, orgId: orgA.id },
          { templateId: shared, mode: 'append' },
          {
            userId: null,
            partnerId: partner.id,
            accessibleOrgIds: [orgA.id],
            scope: 'partner',
            // A TECH, not an admin: apply is deliberately not partner-wide
            // administration (spec §6.2).
            partnerOrgAccess: 'selected',
          },
        ),
      );

      const rows = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .select()
          .from(ticketChecklistItems)
          .where(eq(ticketChecklistItems.ticketId, ticketId)),
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.orgId === orgA.id)).toBe(true);
      expect(rows.every((r) => r.source === 'checklist_template')).toBe(true);
      expect(rows.every((r) => r.sourceTemplateItemId !== null)).toBe(true);
      expect(rows.sort((a, b) => a.position - b.position).map((r) => r.label)).toEqual([
        'Step A',
        'Step B',
      ]);
    });

    it('replace_unticked keeps ticked rows and drops only unticked ones', async () => {
      // Real Postgres, because the predicate (done_at IS NULL) is what the
      // mocked unit test can only assert the SHAPE of.
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const ticketId = await seedTicket(org.id, partner.id);
      // A SECOND ticket in the same org, with its own unticked row. The delete
      // predicate must be scoped by ticket_id as well as done_at — without the
      // ticket_id arm this row would be destroyed too, fleet-wide.
      const bystanderId = await seedTicket(org.id, partner.id);
      const template = await seedTemplate({ orgId: org.id, name: uniqueName('Replace') });
      await seedTemplateItem(template, { orgId: org.id }, 'From template', 0);

      await withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(ticketChecklistItems).values([
          {
            orgId: org.id,
            ticketId,
            label: 'Already done',
            position: 0,
            doneAt: new Date(),
          },
          { orgId: org.id, ticketId, label: 'Not done yet', position: 1 },
          { orgId: org.id, ticketId: bystanderId, label: 'Other ticket unticked', position: 0 },
        ]),
      );

      await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
        applyChecklistTemplateToTicket(
          { id: ticketId, orgId: org.id },
          { templateId: template, mode: 'replace_unticked' },
          {
            userId: null,
            partnerId: partner.id,
            accessibleOrgIds: [org.id],
            scope: 'partner',
            partnerOrgAccess: 'all',
          },
        ),
      );

      const remaining = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .select()
          .from(ticketChecklistItems)
          .where(eq(ticketChecklistItems.ticketId, ticketId)),
      );
      const labels = remaining.map((r) => r.label);
      expect(labels).toContain('Already done');
      expect(labels).not.toContain('Not done yet');
      expect(labels).toContain('From template');

      // The bystander ticket is untouched.
      const bystanderRows = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .select()
          .from(ticketChecklistItems)
          .where(eq(ticketChecklistItems.ticketId, bystanderId)),
      );
      expect(bystanderRows.map((r) => r.label)).toEqual(['Other ticket unticked']);
    });
  });

  describe('cascade', () => {
    it('deleting a template takes its items with it (branch FK ON DELETE CASCADE)', async () => {
      const partner = await createPartner();
      const template = await seedTemplate({
        partnerId: partner.id,
        name: uniqueName('Cascade'),
      });
      await seedTemplateItem(template, { partnerId: partner.id }, 'Step');

      await withDbAccessContext(SYSTEM_CTX, () =>
        db.delete(ticketChecklistTemplates).where(eq(ticketChecklistTemplates.id, template)),
      );

      const items = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .select({ id: ticketChecklistTemplateItems.id })
          .from(ticketChecklistTemplateItems)
          .where(eq(ticketChecklistTemplateItems.templateId, template)),
      );
      expect(items).toEqual([]);
    });
  });
});
