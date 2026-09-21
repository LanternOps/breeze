/**
 * Deliverable -> checklist wiring (#5808 W03), end to end on real Postgres.
 *
 * Migration under test: 2026-10-16-192300-deliverable-checklist-wiring.sql.
 * Code under test: services/checklistTemplateReference.ts,
 * services/deliverableTemplateService.ts (applyTemplateSet), and
 * services/serviceDeliverableService.ts (openOneOccurrence, the sweep-shaped
 * per-occurrence seeding step).
 *
 * Every case here proves something a mocked suite cannot: that a
 * PARTNER-WIDE checklist template fans out into ORG-scoped rows in each
 * customer's own tenant, that the checklist/comment seeding happens inside
 * the SAME per-occurrence system transaction as the ticket claim (so a
 * failure strands nothing), that already-opened occurrences keep real rows a
 * later template edit cannot touch, and that the single-column FK's app-layer
 * guard (checklistTemplateReference.ts) is what actually stands in for the
 * composite FK the partner-wide shape cannot express.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  deliverableTemplateItems,
  deliverableTemplateSets,
  partners,
  serviceDeliverables,
  serviceDeliverableOccurrences,
  ticketChecklistItems,
  ticketChecklistTemplateItems,
  ticketChecklistTemplates,
  ticketComments,
  tickets,
} from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { applyTemplateSet, type TemplateActor } from '../../services/deliverableTemplateService';
import { createDeliverable, type DeliverableActor } from '../../services/serviceDeliverableService';
import {
  deleteChecklistTemplate,
  updateChecklistTemplate,
  type ChecklistTemplateActor,
} from '../../services/ticketChecklistTemplateService';
import { runDeliverableSweep } from '../../jobs/deliverableWorker';
import { createTicket } from '../../services/ticketService';

// Lets ONE test (the transaction-rollback case) force openOneOccurrence's
// mocked "ticket creation" to hand back a REAL ticket that belongs to the
// WRONG org, so the checklist-item insert's composite FK
// (ticket_id, org_id) -> tickets(id, org_id) genuinely fails with 23503 —
// see that test's comment for why this is the mechanism used instead of
// spying on `db.insert` directly.
const { forcedTicketId } = vi.hoisted(() => ({ forcedTicketId: { value: null as string | null } }));
vi.mock('../../services/plannedWorkTicket', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/plannedWorkTicket')>();
  return {
    ...actual,
    createPlannedWorkTicket: async (...args: Parameters<typeof actual.createPlannedWorkTicket>) => {
      if (forcedTicketId.value) return { kind: 'created' as const, ticketId: forcedTicketId.value };
      return actual.createPlannedWorkTicket(...args);
    },
  };
});

const AS_OF = new Date('2026-10-25T05:18:00Z');

const system = <T>(fn: () => Promise<T>, label = 'ticketChecklistDeliverableSeeding.integration'): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

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

/** An org-scoped session. `currentPartnerId` is populated the same way the
 *  real token-derived context is (buildDbAccessContext), which is what the
 *  partner-wide SELECT branch on ticket_checklist_templates keys on. */
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

const uniqueName = (prefix: string) => `${prefix} ${randomUUID()}`;

/** Seed under the privileged test connection, bypassing RLS — same pattern as
 *  deliverableSweep.integration.test.ts's fixture helpers. */
async function seedTemplate(values: { orgId?: string | null; partnerId?: string | null; name: string }): Promise<string> {
  const [row] = await getTestDb()
    .insert(ticketChecklistTemplates)
    .values({ orgId: values.orgId ?? null, partnerId: values.partnerId ?? null, name: values.name })
    .returning({ id: ticketChecklistTemplates.id });
  return row!.id;
}

async function seedTemplateItem(
  templateId: string,
  owner: { orgId?: string | null; partnerId?: string | null },
  label: string,
  sortOrder = 0,
): Promise<string> {
  const [row] = await getTestDb()
    .insert(ticketChecklistTemplateItems)
    .values({ templateId, orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null, label, sortOrder })
    .returning({ id: ticketChecklistTemplateItems.id });
  return row!.id;
}

async function seedSet(values: { orgId?: string | null; partnerId?: string | null; name: string }): Promise<string> {
  const [row] = await getTestDb()
    .insert(deliverableTemplateSets)
    .values({ orgId: values.orgId ?? null, partnerId: values.partnerId ?? null, name: values.name })
    .returning({ id: deliverableTemplateSets.id });
  return row!.id;
}

async function seedSetItem(
  setId: string,
  owner: { orgId?: string | null; partnerId?: string | null },
  over: Partial<typeof deliverableTemplateItems.$inferInsert>,
): Promise<string> {
  const [row] = await getTestDb()
    .insert(deliverableTemplateItems)
    .values({
      setId,
      orgId: owner.orgId ?? null,
      partnerId: owner.partnerId ?? null,
      name: 'Sign-in log review',
      cadence: 'monthly',
      ...over,
    })
    .returning({ id: deliverableTemplateItems.id });
  return row!.id;
}

const occurrencesOf = (deliverableId: string) =>
  getTestDb()
    .select()
    .from(serviceDeliverableOccurrences)
    .where(eq(serviceDeliverableOccurrences.deliverableId, deliverableId))
    .orderBy(serviceDeliverableOccurrences.dueAt);

const checklistItemsOf = (ticketId: string) =>
  getTestDb()
    .select()
    .from(ticketChecklistItems)
    .where(eq(ticketChecklistItems.ticketId, ticketId))
    .orderBy(asc(ticketChecklistItems.position));

const commentsOf = (ticketId: string) =>
  getTestDb().select().from(ticketComments).where(eq(ticketComments.ticketId, ticketId));

const ticketsOf = (orgId: string) => getTestDb().select().from(tickets).where(eq(tickets.orgId, orgId));

describe('deliverable -> checklist seeding (#5808 W03)', () => {
  it('end to end: applyTemplateSet copies instructions + pointer, the sweep seeds the checklist and posts the instructions comment', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });

    const templateId = await seedTemplate({ partnerId: partner.id, name: uniqueName('Onboarding runbook') });
    await seedTemplateItem(templateId, { partnerId: partner.id }, 'Step A', 0);
    await seedTemplateItem(templateId, { partnerId: partner.id }, 'Step B', 1);
    await seedTemplateItem(templateId, { partnerId: partner.id }, 'Step C', 2);

    const setId = await seedSet({ partnerId: partner.id, name: uniqueName('Onboarding set') });
    await seedSetItem(setId, { partnerId: partner.id }, {
      name: 'Sign-in log review',
      cadence: 'monthly',
      instructions: 'Runbook prose',
      checklistTemplateId: templateId,
    });

    const actor: TemplateActor = {
      userId: null, scope: 'partner', partnerId: partner.id, partnerOrgAccess: 'all', accessibleOrgIds: [orgA.id],
    };
    const applied = await withDbAccessContext(partnerContext(partner.id, [orgA.id]), () =>
      applyTemplateSet(orgA.id, setId, { effectiveFrom: '2026-10-01' }, actor));
    expect(applied.created).toHaveLength(1);
    const deliverableId = applied.created[0]!.id;

    const [deliverableRow] = await getTestDb().select().from(serviceDeliverables).where(eq(serviceDeliverables.id, deliverableId));
    expect(deliverableRow).toMatchObject({ instructions: 'Runbook prose', checklistTemplateId: templateId });

    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ materialized: 1, opened: 1, failed: 0 });

    const [occ] = await occurrencesOf(deliverableId);
    expect(occ!.ticketId).not.toBeNull();
    const ticketId = occ!.ticketId!;

    const items = await checklistItemsOf(ticketId);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.label)).toEqual(['Step A', 'Step B', 'Step C']);
    expect(items.every((i) => i.orgId === orgA.id)).toBe(true); // the DELIVERABLE's org, never the template's NULL owner
    expect(items.every((i) => i.source === 'deliverable')).toBe(true);
    expect(items.every((i) => i.createdBy === null)).toBe(true);

    const templateItems = await getTestDb()
      .select({ id: ticketChecklistTemplateItems.id, label: ticketChecklistTemplateItems.label })
      .from(ticketChecklistTemplateItems)
      .where(eq(ticketChecklistTemplateItems.templateId, templateId));
    const idByLabel = new Map(templateItems.map((t) => [t.label, t.id]));
    for (const item of items) expect(item.sourceTemplateItemId).toBe(idByLabel.get(item.label));

    const comments = await commentsOf(ticketId);
    const instructionsComment = comments.find((c) => c.content.includes('Runbook prose'));
    expect(instructionsComment).toBeDefined();
    expect(instructionsComment).toMatchObject({ isPublic: false, commentType: 'internal', originPrincipalKind: 'system' });
  });

  it('fans a partner-wide template out to EACH org independently, with disjoint checklist rows stamped in each org', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });

    const templateId = await seedTemplate({ partnerId: partner.id, name: uniqueName('Fan-out runbook') });
    await seedTemplateItem(templateId, { partnerId: partner.id }, 'Firewall check', 0);

    const setId = await seedSet({ partnerId: partner.id, name: uniqueName('Fan-out set') });
    await seedSetItem(setId, { partnerId: partner.id }, {
      name: 'Firewall rule review', cadence: 'monthly', checklistTemplateId: templateId,
    });

    const actor: TemplateActor = {
      userId: null, scope: 'partner', partnerId: partner.id, partnerOrgAccess: 'all',
      accessibleOrgIds: [orgA.id, orgB.id],
    };
    await withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id]), () =>
      applyTemplateSet(orgA.id, setId, { effectiveFrom: '2026-10-01' }, actor));
    await withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id]), () =>
      applyTemplateSet(orgB.id, setId, { effectiveFrom: '2026-10-01' }, actor));

    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ materialized: 2, opened: 2, failed: 0 });

    const [dA] = await getTestDb().select({ id: serviceDeliverables.id }).from(serviceDeliverables).where(eq(serviceDeliverables.orgId, orgA.id));
    const [dB] = await getTestDb().select({ id: serviceDeliverables.id }).from(serviceDeliverables).where(eq(serviceDeliverables.orgId, orgB.id));
    const [occA] = await occurrencesOf(dA!.id);
    const [occB] = await occurrencesOf(dB!.id);
    expect(occA!.ticketId).not.toBeNull();
    expect(occB!.ticketId).not.toBeNull();

    const itemsA = await checklistItemsOf(occA!.ticketId!);
    const itemsB = await checklistItemsOf(occB!.ticketId!);
    expect(itemsA).toHaveLength(1);
    expect(itemsB).toHaveLength(1);
    expect(itemsA[0]).toMatchObject({ orgId: orgA.id, label: 'Firewall check' });
    expect(itemsB[0]).toMatchObject({ orgId: orgB.id, label: 'Firewall check' });

    // Disjoint id sets: each org got its OWN rows, not a shared/cross-tenant one.
    const idsA = new Set(itemsA.map((i) => i.id));
    const idsB = new Set(itemsB.map((i) => i.id));
    expect([...idsA].some((id) => idsB.has(id))).toBe(false);
  });

  it('a checklist-seeding failure rolls back the WHOLE per-occurrence transaction: no stranded open+ticketed occurrence', async () => {
    // Mechanism: createPlannedWorkTicket is mocked (see the module mock above)
    // to hand back a REAL ticket belonging to a DIFFERENT org than the
    // deliverable's. openOneOccurrence then tries to insert a checklist item
    // stamped with the deliverable's org but the WRONG-org ticket's id, which
    // the composite FK ticket_checklist_items_ticket_org_fk
    // (ticket_id, org_id) -> tickets(id, org_id) genuinely refuses with a real
    // 23503 — a fault that happens AFTER the ticket "creation" step, inside
    // the SAME system transaction as the occurrence claim.
    //
    // This is the cleanest fault achievable from outside
    // serviceDeliverableService.ts: `db` there is a context-bound Proxy
    // (db/index.ts) that re-resolves to the ambient transaction handle on
    // every property access, so spying on `db.insert` from a test can only
    // ever redefine the property on the PROXY'S TARGET (`baseDb`), never on
    // the per-call transaction object `getCurrentDb()` actually returns —
    // it would silently not intercept anything.
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const tech = await createUser({ partnerId: partner.id, orgId: null, email: `tech-${randomUUID()}@example.test`, name: 'Tess Tech' });

    const baitTicket = await system(() =>
      createTicket({ orgId: otherOrg.id, source: 'api', subject: 'Bait (wrong org)', workKind: 'deliverable' }, { userId: tech.id, name: tech.name }));
    forcedTicketId.value = baitTicket.id;

    const templateId = await seedTemplate({ orgId: orgA.id, name: uniqueName('Rollback runbook') });
    await seedTemplateItem(templateId, { orgId: orgA.id }, 'Step', 0);

    const [d] = await getTestDb().insert(serviceDeliverables).values({
      orgId: orgA.id, name: uniqueName('Rollback deliverable'), cadence: 'monthly',
      anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01', checklistTemplateId: templateId,
    }).returning({ id: serviceDeliverables.id });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let res;
    try {
      res = await runDeliverableSweep(AS_OF);
    } finally {
      errSpy.mockRestore();
      forcedTicketId.value = null;
    }
    // materialized commits on its own (a separate system transaction per
    // deliverable, spec §5.3 step 1); opened does NOT, because its own
    // transaction rolled back.
    expect(res).toMatchObject({ materialized: 1, opened: 0 });

    const [occ] = await occurrencesOf(d!.id);
    expect(occ).toMatchObject({ status: 'scheduled', ticketId: null });
    expect(await ticketsOf(orgA.id)).toHaveLength(0); // no orphan ticket left behind in orgA
  });

  it('Service Management off: the occurrence opens ticketless, seeding nothing and never throwing', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await getTestDb().update(partners).set({ serviceManagementMode: 'off' }).where(eq(partners.id, partner.id));

    const templateId = await seedTemplate({ orgId: org.id, name: uniqueName('Off runbook') });
    await seedTemplateItem(templateId, { orgId: org.id }, 'Step', 0);
    const [d] = await getTestDb().insert(serviceDeliverables).values({
      orgId: org.id, name: uniqueName('Off deliverable'), cadence: 'monthly',
      anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01',
      checklistTemplateId: templateId, instructions: 'Do the thing',
    }).returning({ id: serviceDeliverables.id });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let res;
    try {
      res = await runDeliverableSweep(AS_OF);
    } finally {
      warnSpy.mockRestore();
    }
    expect(res).toMatchObject({ opened: 1, failed: 0 });

    const [occ] = await occurrencesOf(d!.id);
    expect(occ).toMatchObject({ status: 'open', ticketId: null });
    expect(await ticketsOf(org.id)).toHaveLength(0);
  });

  it('history is frozen: renaming a template item after an occurrence opened does not alter its already-copied labels', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const templateId = await seedTemplate({ orgId: org.id, name: uniqueName('Frozen runbook') });
    const itemId = await seedTemplateItem(templateId, { orgId: org.id }, 'Original label', 0);
    const [d] = await getTestDb().insert(serviceDeliverables).values({
      orgId: org.id, name: uniqueName('Frozen deliverable'), cadence: 'monthly',
      anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01', checklistTemplateId: templateId,
    }).returning({ id: serviceDeliverables.id });

    await runDeliverableSweep(AS_OF);
    const [occ] = await occurrencesOf(d!.id);
    const ticketId = occ!.ticketId!;
    expect((await checklistItemsOf(ticketId)).map((i) => i.label)).toEqual(['Original label']);

    await getTestDb().update(ticketChecklistTemplateItems).set({ label: 'Renamed later' }).where(eq(ticketChecklistTemplateItems.id, itemId));

    const after = await checklistItemsOf(ticketId);
    expect(after.map((i) => i.label)).toEqual(['Original label']); // the pointer is live for FUTURE occurrences only
  });

  it('refuses a cross-partner org-owned checklist template with 404 (never 403), but accepts a partner-wide template of the SAME partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const foreignTemplate = await seedTemplate({ orgId: orgB.id, name: uniqueName('Foreign org template') });
    const partnerWideTemplate = await seedTemplate({ partnerId: partnerA.id, name: uniqueName('Own partner-wide template') });

    const actor: DeliverableActor = { userId: null, partnerId: partnerA.id, accessibleOrgIds: [orgA.id] };
    const baseInput = {
      cadence: 'monthly' as const, anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01',
      leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve' as const,
      portalVisible: true, sortOrder: 0,
    };

    await expect(
      withDbAccessContext(orgContext(orgA.id, partnerA.id), () =>
        createDeliverable(orgA.id, { ...baseInput, name: uniqueName('Cross-tenant'), checklistTemplateId: foreignTemplate }, actor)),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

    // The FK exists precisely for this case: a partner-wide template of the
    // CALLER's OWN partner, referenced from one of that partner's orgs.
    const ok = await withDbAccessContext(orgContext(orgA.id, partnerA.id), () =>
      createDeliverable(orgA.id, { ...baseInput, name: uniqueName('Partner-wide OK'), checklistTemplateId: partnerWideTemplate }, actor));
    expect(ok.checklistTemplateId).toBe(partnerWideTemplate);
  });

  describe('applyTemplateSet cross-org guard on real Postgres', () => {
    // The mocked unit tests cover this too, but this rule IS the app-layer
    // substitute for a composite FK that structurally cannot exist here — and
    // CLAUDE.md's own lesson is that this class of contract is exactly what
    // mocked tests miss (cascade lists: contract tests 5/5, review 0/5). So it
    // gets a real-database proof as well.
    async function seedSetReferencing(
      partnerId: string,
      checklistTemplateId: string,
    ): Promise<string> {
      const setId = await seedSet({ partnerId, name: uniqueName('Cross-org set') });
      await seedSetItem(setId, { partnerId }, {
        name: uniqueName('Cross-org deliverable'), cadence: 'monthly', checklistTemplateId,
      });
      return setId;
    }

    it('409s CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG when org A’s PRIVATE template is applied to org B, writing nothing', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });

      const privateToA = await seedTemplate({ orgId: orgA.id, name: uniqueName('Org A private') });
      await seedTemplateItem(privateToA, { orgId: orgA.id }, 'A-only step', 0);
      const setId = await seedSetReferencing(partner.id, privateToA);

      const actor: TemplateActor = {
        userId: null, scope: 'partner', partnerId: partner.id, partnerOrgAccess: 'all',
        accessibleOrgIds: [orgA.id, orgB.id],
      };
      await expect(
        withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id]), () =>
          applyTemplateSet(orgB.id, setId, { effectiveFrom: '2026-10-01' }, actor)),
      ).rejects.toMatchObject({ status: 409, code: 'CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG' });

      // The refusal runs before the transaction: org B gained no deliverable.
      const orgBDeliverables = await getTestDb()
        .select({ id: serviceDeliverables.id })
        .from(serviceDeliverables)
        .where(eq(serviceDeliverables.orgId, orgB.id));
      expect(orgBDeliverables).toHaveLength(0);
    });

    it('ALLOWS the same set when its checklist template is PARTNER-WIDE, across both orgs', async () => {
      // The positive half. Without it the case above could pass because apply
      // is broken outright rather than because the guard discriminates.
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });

      const shared = await seedTemplate({ partnerId: partner.id, name: uniqueName('Shared runbook') });
      await seedTemplateItem(shared, { partnerId: partner.id }, 'Shared step', 0);
      const setId = await seedSetReferencing(partner.id, shared);

      const actor: TemplateActor = {
        userId: null, scope: 'partner', partnerId: partner.id, partnerOrgAccess: 'all',
        accessibleOrgIds: [orgA.id, orgB.id],
      };
      for (const org of [orgA, orgB]) {
        const applied = await withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id]), () =>
          applyTemplateSet(org.id, setId, { effectiveFrom: '2026-10-01' }, actor));
        expect(applied.created).toHaveLength(1);
      }

      const rows = await getTestDb()
        .select({ orgId: serviceDeliverables.orgId, checklistTemplateId: serviceDeliverables.checklistTemplateId })
        .from(serviceDeliverables);
      expect(rows.filter((r) => r.checklistTemplateId === shared).map((r) => r.orgId).sort())
        .toEqual([orgA.id, orgB.id].sort());
    });

    it('409s a partner-wide template belonging to a DIFFERENT partner', async () => {
      // Partner-wide is only "visible to both by construction" when it is the
      // TARGET org's own partner's template.
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const orgA = await createOrganization({ partnerId: partnerA.id });

      const foreignShared = await seedTemplate({ partnerId: partnerB.id, name: uniqueName('Other MSP shared') });
      await seedTemplateItem(foreignShared, { partnerId: partnerB.id }, 'Foreign step', 0);
      const setId = await seedSetReferencing(partnerA.id, foreignShared);

      const actor: TemplateActor = {
        userId: null, scope: 'partner', partnerId: partnerA.id, partnerOrgAccess: 'all',
        accessibleOrgIds: [orgA.id],
      };
      await expect(
        withDbAccessContext(partnerContext(partnerA.id, [orgA.id]), () =>
          applyTemplateSet(orgA.id, setId, { effectiveFrom: '2026-10-01' }, actor)),
      ).rejects.toMatchObject({ status: 409, code: 'CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG' });
    });
  });

  describe('delete guard', () => {
    it('refuses to delete a checklist template a deliverable still references (409), but deactivating it succeeds and the reference keeps working', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const templateId = await seedTemplate({ orgId: org.id, name: uniqueName('In-use runbook') });

      const deliverableActor: DeliverableActor = { userId: null, partnerId: partner.id, accessibleOrgIds: [org.id] };
      const deliverable = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        createDeliverable(org.id, {
          name: uniqueName('Referencing deliverable'), cadence: 'monthly', anchorDueDate: '2026-10-31',
          effectiveFrom: '2026-10-01', leadDays: 7, graceDays: 14, artifactRequired: true,
          completionMode: 'on_ticket_resolve', portalVisible: true, sortOrder: 0, checklistTemplateId: templateId,
        }, deliverableActor));

      const templateActor: ChecklistTemplateActor = {
        userId: null, partnerId: partner.id, accessibleOrgIds: [org.id], scope: 'organization',
      };
      await expect(
        withDbAccessContext(orgContext(org.id, partner.id), () => deleteChecklistTemplate(templateId, templateActor)),
      ).rejects.toMatchObject({
        status: 409,
        code: 'CHECKLIST_TEMPLATE_IN_USE',
        details: { deliverables: [{ id: deliverable.id, name: deliverable.name }] },
      });

      await withDbAccessContext(orgContext(org.id, partner.id), () =>
        updateChecklistTemplate(templateId, { isActive: false }, templateActor));

      const [row] = await getTestDb().select().from(ticketChecklistTemplates).where(eq(ticketChecklistTemplates.id, templateId));
      expect(row).toMatchObject({ isActive: false });

      const [stillReferencing] = await getTestDb()
        .select({ checklistTemplateId: serviceDeliverables.checklistTemplateId })
        .from(serviceDeliverables)
        .where(eq(serviceDeliverables.id, deliverable.id));
      expect(stillReferencing!.checklistTemplateId).toBe(templateId);
    });
  });
});
