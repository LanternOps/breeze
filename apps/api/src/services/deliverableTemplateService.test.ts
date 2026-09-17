import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const dbMocks = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../db', () => {
  const chain = () => {
    const c: any = {};
    for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'innerJoin', 'leftJoin', 'insert', 'values', 'update', 'set', 'delete', 'returning']) {
      c[m] = vi.fn(() => c);
    }
    c.then = (res: (v: unknown) => void) => res(dbMocks.rows.shift() ?? []);
    c.transaction = async (fn: (tx: unknown) => unknown) => fn(c);
    return c;
  };
  return { db: chain() };
});

// #5808 W03 — the owner-axis RULES have their own suite
// (checklistTemplateReference.test.ts). Mocked here so these cases assert WHICH
// owner axis this service hands over, which is the thing that goes wrong.
const refMocks = vi.hoisted(() => ({
  assertChecklistTemplateUsableByTemplateItemOwner: vi.fn(),
  assertChecklistTemplateUsableByOrg: vi.fn(),
}));
vi.mock('./checklistTemplateReference', () => refMocks);

// The db chain mock cannot feed W01's real createDeliverable (it would read an
// empty queue and throw INSERT_FAILED), so the collaborator is mocked here and
// the REAL create path is proven against Postgres in
// deliverableTemplatesPartnerRls.integration.test.ts ("apply fan-out").
const createdCalls = vi.hoisted(() => [] as Array<{ orgId: string; input: Record<string, unknown>; hasTx: boolean }>);
vi.mock('./serviceDeliverableService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./serviceDeliverableService')>();
  return {
    ...actual,
    createDeliverable: vi.fn(async (orgId: string, input: Record<string, unknown>, _actor: unknown, tx?: unknown) => {
      createdCalls.push({ orgId, input, hasTx: tx !== undefined });
      return { id: `d${createdCalls.length}`, name: input.name, cadence: input.cadence };
    }),
  };
});

// #5784 W01: apply-time resolution of a template item's evidence TYPE to the
// target org's managed definition. Mocked here (the chain mock cannot feed a
// real insert-then-reread); the real path is proven on Postgres in
// managedEvidenceFoundations.integration.test.ts.
const resolveMock = vi.hoisted(() => vi.fn());
vi.mock('./managedEvidenceDefinitions', () => ({ resolveManagedEvidenceDefinition: resolveMock }));

import {
  applyTemplateSet,
  createTemplateSet,
  listTemplateSets,
  addTemplateItem,
  updateTemplateSet,
  deleteTemplateSet,
  updateTemplateItem,
  removeTemplateItem,
  TemplateServiceError,
} from './deliverableTemplateService';
import { firstAnchorAfter } from './recurrence';
import { PartnerWideWriteDeniedError } from './partnerWideAccess';

const partnerAdmin = { userId: 'u1', scope: 'partner' as const, partnerId: 'p1', partnerOrgAccess: 'all' as const, accessibleOrgIds: ['org1'] };
const partnerTech = { ...partnerAdmin, partnerOrgAccess: 'selected' as const };
const orgUser = { userId: 'u2', scope: 'organization' as const, partnerId: 'p1', partnerOrgAccess: null, accessibleOrgIds: ['org1'] };

/** Compile a drizzle SQL fragment to its literal text + bound params. */
function compile(fragment: unknown): { sql: string; params: unknown[] } {
  const { sql, params } = new PgDialect().sqlToQuery(fragment as SQL);
  return { sql, params };
}

describe('deliverableTemplateService', () => {
  beforeEach(() => {
    dbMocks.rows.length = 0;
    refMocks.assertChecklistTemplateUsableByTemplateItemOwner.mockReset().mockResolvedValue(undefined);
    refMocks.assertChecklistTemplateUsableByOrg.mockReset().mockResolvedValue(undefined);
  });

  it('a partner tech without full org access cannot create a partner-wide set', async () => {
    await expect(createTemplateSet({ name: 'Best plan', ownerScope: 'partner', items: [] }, partnerTech))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });

  it('an org-scope user cannot create a partner-wide set either', async () => {
    await expect(createTemplateSet({ name: 'Best plan', ownerScope: 'partner', items: [] }, orgUser))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });

  it('404s an org the actor cannot access, without touching the db', async () => {
    await expect(createTemplateSet({ name: 'Best plan', ownerScope: 'organization', orgId: 'org2', items: [] }, partnerAdmin))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('maps a set name unique violation to 409 DUPLICATE_TEMPLATE_SET_NAME', async () => {
    const { db } = await import('../db');
    // Restored below: a permanent stub here would make every later test in this
    // file throw 23505 from the same chain object (they share one mock).
    const original = (db as any).returning;
    (db as any).returning = vi.fn(() => { throw Object.assign(new Error('dup'), { code: '23505', constraint_name: 'deliverable_template_sets_partner_name_uq' }); });
    try {
      await expect(createTemplateSet({ name: 'Best plan', ownerScope: 'partner', items: [] }, partnerAdmin))
        .rejects.toMatchObject({ status: 409, code: 'DUPLICATE_TEMPLATE_SET_NAME' });
    } finally {
      (db as any).returning = original;
    }
  });

  it('an org-scope reader never gets the partner-wide arm in its query', async () => {
    dbMocks.rows.push([]);
    await listTemplateSets(orgUser, {});
    const { db } = await import('../db');
    const whereArg = (db as any).where.mock.calls.at(-1)?.[0];
    // Compile rather than inspect: a drizzle SQL is circular, and only the
    // compiled params show what the query actually binds.
    const { sql, params } = compile(whereArg);
    // Positive control first: the org arm IS bound, so the negative assertion
    // below cannot pass merely because nothing was inspected.
    expect(params).toContain('org1');
    expect(params).not.toContain('p1');
    expect(sql).not.toContain('partner_id');
  });

  it('a pinned orgId still lists partner-wide sets for a partner-scope reader (#5675)', async () => {
    dbMocks.rows.push([]);
    await listTemplateSets(partnerAdmin, { orgId: 'org1' });
    const { db } = await import('../db');
    const { sql, params } = compile((db as any).where.mock.calls.at(-1)?.[0]);
    // The web fetch wrapper pins orgId on every request once an org is open, so
    // this filter is the one that decides whether a partner-wide set is
    // reachable at all. It must be a disjunction that admits org_id IS NULL —
    // a bare `org_id = $n` conjunct filters every partner-wide row out no
    // matter what the visibility clause already allowed.
    expect(sql).toMatch(
      /and \("deliverable_template_sets"\."org_id" = \$\d+ or \("deliverable_template_sets"\."org_id" is null and "deliverable_template_sets"\."partner_id" = \$\d+\)\)/,
    );
    // Positive control: the pinned org is still bound, so the assertion above
    // cannot pass by the filter having been dropped altogether.
    expect(params).toContain('org1');
  });

  it('a pinned orgId keeps an org-scope reader on the org-only filter (#5675)', async () => {
    dbMocks.rows.push([]);
    await listTemplateSets(orgUser, { orgId: 'org1' });
    const { db } = await import('../db');
    const { sql, params } = compile((db as any).where.mock.calls.at(-1)?.[0]);
    expect(params).toContain('org1');
    expect(params).not.toContain('p1');
    expect(sql).not.toContain('partner_id');
  });

  it('an item copies the set owner columns and never trusts input', async () => {
    dbMocks.rows.push([{ id: 's1', orgId: null, partnerId: 'p1', name: 'Best plan' }]); // loaded set
    dbMocks.rows.push([{ id: 'i1', setId: 's1', orgId: null, partnerId: 'p1', name: 'Sign-in log review' }]);
    await addTemplateItem('s1', { name: 'Sign-in log review', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0 }, partnerAdmin);
    const { db } = await import('../db');
    const values = (db as any).values.mock.calls.at(-1)?.[0];
    expect(values).toMatchObject({ setId: 's1', orgId: null, partnerId: 'p1' });
  });

  it('a partner tech cannot add an item to a partner-wide set', async () => {
    dbMocks.rows.push([{ id: 's1', orgId: null, partnerId: 'p1', name: 'Best plan' }]);
    await expect(addTemplateItem('s1', { name: 'x', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0 }, partnerTech))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });

  it('a set the actor cannot see is 404, not 403', async () => {
    dbMocks.rows.push([]);
    await expect(addTemplateItem('s9', { name: 'x', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0 }, partnerAdmin))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  // ── #5808 W03: instructions + the checklist-template pointer on an item ───
  it('an item writes instructions and checklistTemplateId', async () => {
    dbMocks.rows.push([{ id: 's1', orgId: null, partnerId: 'p1', name: 'Best plan' }]);
    dbMocks.rows.push([{ id: 'i1', setId: 's1' }]);
    await addTemplateItem('s1', { ...{ name: 'x', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0 }, instructions: 'Runbook prose', checklistTemplateId: 'tcl-1' }, partnerAdmin);
    const { db } = await import('../db');
    expect((db as any).values.mock.calls.at(-1)?.[0]).toMatchObject({
      instructions: 'Runbook prose',
      checklistTemplateId: 'tcl-1',
    });
  });

  it('validates the reference against the SET’S owner axis, not the caller’s org', async () => {
    // The caller is a partner admin with accessibleOrgIds ['org1'], but the SET
    // is partner-wide. Validating against the caller's org would let a
    // partner-wide item point at an org-owned template that is invisible to
    // every other org the set is applied to.
    dbMocks.rows.push([{ id: 's1', orgId: null, partnerId: 'p1', name: 'Best plan' }]);
    dbMocks.rows.push([{ id: 'i1', setId: 's1' }]);
    await addTemplateItem('s1', { ...{ name: 'x', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0 }, checklistTemplateId: 'tcl-1' }, partnerAdmin);
    expect(refMocks.assertChecklistTemplateUsableByTemplateItemOwner)
      .toHaveBeenCalledWith('tcl-1', { orgId: null, partnerId: 'p1' });
  });

  it('refuses the write when the reference is not usable, before inserting', async () => {
    dbMocks.rows.push([{ id: 's1', orgId: null, partnerId: 'p1', name: 'Best plan' }]);
    refMocks.assertChecklistTemplateUsableByTemplateItemOwner.mockRejectedValueOnce(
      Object.assign(new Error('nf'), { status: 404, code: 'NOT_FOUND' }),
    );
    const { db } = await import('../db');
    (db as any).values.mockClear();
    await expect(addTemplateItem('s1', { ...{ name: 'x', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0 }, checklistTemplateId: 'FOREIGN' }, partnerAdmin))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect((db as any).values).not.toHaveBeenCalled();
  });

  it('skips validation entirely when no checklistTemplateId is supplied', async () => {
    dbMocks.rows.push([{ id: 's1', orgId: 'org1', partnerId: null, name: 'Org set' }]);
    dbMocks.rows.push([{ id: 'i1', setId: 's1' }]);
    await addTemplateItem('s1', { name: 'x', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0 }, partnerAdmin);
    expect(refMocks.assertChecklistTemplateUsableByTemplateItemOwner).not.toHaveBeenCalled();
  });

  it('updateTemplateItem validates and writes both fields, and a null clears without a lookup', async () => {
    dbMocks.rows.push([{ id: 's1', orgId: 'org1', partnerId: null, name: 'Org set' }]);
    dbMocks.rows.push([{ id: 'i1', setId: 's1' }]);
    await updateTemplateItem('s1', 'i1', { instructions: null, checklistTemplateId: null }, partnerAdmin);
    const { db } = await import('../db');
    expect((db as any).set.mock.calls.at(-1)?.[0]).toMatchObject({
      instructions: null,
      checklistTemplateId: null,
    });
    expect(refMocks.assertChecklistTemplateUsableByTemplateItemOwner).not.toHaveBeenCalled();
  });

  it('updateTemplateItem validates a NON-null pointer against the set owner, resolving the org\'s partnerId', async () => {
    dbMocks.rows.push([{ id: 's1', orgId: 'org1', partnerId: null, name: 'Org set' }]); // loadSetOr404
    dbMocks.rows.push([{ partnerId: 'p1' }]); // organizations lookup for org1's partner
    dbMocks.rows.push([{ id: 'i1', setId: 's1' }]); // update returning
    await updateTemplateItem('s1', 'i1', { checklistTemplateId: 'tcl-1' }, partnerAdmin);
    expect(refMocks.assertChecklistTemplateUsableByTemplateItemOwner)
      .toHaveBeenCalledWith('tcl-1', { orgId: 'org1', partnerId: 'p1' });
  });

  // #5921 follow-up: an org-owned set's own partner_id column is ALWAYS null
  // (one-owner XOR constraint), so passing it straight through rejected every
  // partner-wide checklist template on every org-owned set. The correct owner
  // axis is the ORGANIZATION's own partnerId (same lookup as
  // serviceDeliverableService.validateReferences), not the set's partner_id
  // column.
  it('an org-owned set resolves the ORGANIZATION\'s partnerId, not the set\'s own null partner_id, so a partner-wide template is usable', async () => {
    dbMocks.rows.push([{ id: 's1', orgId: 'org1', partnerId: null, name: 'Org set' }]); // loadSetOr404
    dbMocks.rows.push([{ partnerId: 'p1' }]); // organizations lookup for org1's partner
    dbMocks.rows.push([{ id: 'i1', setId: 's1' }]); // insert returning
    await addTemplateItem('s1', {
      name: 'x', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true,
      completionMode: 'on_ticket_resolve', sortOrder: 0, checklistTemplateId: 'tcl-partner-wide',
    }, partnerAdmin);
    expect(refMocks.assertChecklistTemplateUsableByTemplateItemOwner)
      .toHaveBeenCalledWith('tcl-partner-wide', { orgId: 'org1', partnerId: 'p1' });
  });
});

describe('applyTemplateSet', () => {
  beforeEach(() => {
    dbMocks.rows.length = 0;
    createdCalls.length = 0;
    refMocks.assertChecklistTemplateUsableByTemplateItemOwner.mockReset().mockResolvedValue(undefined);
    refMocks.assertChecklistTemplateUsableByOrg.mockReset().mockResolvedValue(undefined);
  });
  const set = { id: 's1', orgId: null, partnerId: 'p1', name: 'Best plan' };
  const items = [
    { id: 'i1', setId: 's1', name: 'Sign-in log review', cadence: 'monthly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0, description: null },
    { id: 'i2', setId: 's1', name: 'Firewall rule review', cadence: 'quarterly', leadDays: 14, graceDays: 21, artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 1, description: null },
  ];

  it('409s with every colliding name and writes nothing', async () => {
    dbMocks.rows.push([set]);                                   // loadSetOr404
    dbMocks.rows.push(items);                                   // items
    dbMocks.rows.push([{ name: 'Sign-in log review' }]);        // existing deliverables
    await expect(applyTemplateSet('org1', 's1', { effectiveFrom: '2026-10-01' }, partnerAdmin))
      .rejects.toMatchObject({ status: 409, code: 'TEMPLATE_NAME_COLLISION', details: { collisions: ['Sign-in log review'] } });
    expect(createdCalls).toEqual([]);
  });

  it('onCollision skip reports the skipped names and still creates the rest', async () => {
    dbMocks.rows.push([set], items, [{ name: 'Sign-in log review' }]);
    const result = await applyTemplateSet('org1', 's1', { effectiveFrom: '2026-10-01', onCollision: 'skip' }, partnerAdmin);
    expect(result.skipped).toEqual(['Sign-in log review']);
    expect(result.created.map((c) => c.name)).toEqual(['Firewall rule review']);
  });

  it('computes each anchor from the item cadence (spec §4.6)', async () => {
    dbMocks.rows.push([set], items, []);
    const result = await applyTemplateSet('org1', 's1', { effectiveFrom: '2026-10-01' }, partnerAdmin);
    expect(result.created.map((c) => c.anchorDueDate)).toEqual(['2026-10-31', '2026-12-31']);
    expect(result.created[0]!.anchorDueDate).toBe(firstAnchorAfter('2026-10-01', 'monthly'));
    // Every create runs on the SHARED transaction handle — that is what makes
    // the apply all-or-nothing.
    expect(createdCalls.every((c) => c.hasTx)).toBe(true);
  });

  it('404s an org the actor cannot access before reading the set', async () => {
    const { db } = await import('../db');
    (db as any).select.mockClear();
    await expect(applyTemplateSet('org2', 's1', {}, partnerAdmin)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect((db as any).select).not.toHaveBeenCalled();
  });

  it('rejects a contract belonging to another org', async () => {
    dbMocks.rows.push([set], items, []);                        // set, items, contract lookup empty
    await expect(applyTemplateSet('org1', 's1', { contractId: '11111111-1111-4111-8111-111111111111' }, partnerAdmin))
      .rejects.toMatchObject({ status: 400, code: 'CONTRACT_NOT_IN_ORG' });
  });

  // ── #5808 W03: the checklist wiring is copied, and cross-org is refused ───
  //
  // The hole this closes: loadSetOr404 authorizes the SOURCE set and
  // requireOrgAccess the TARGET org, independently — so an actor holding both
  // may apply org A's set to org B. Copying org A's PRIVATE checklist template
  // into an org-B deliverable would create a cross-org pointer that RLS hides
  // from org B while the system-context sweep still reads and acts on it.
  const withChecklist = (checklistTemplateId: string | null) => [
    { ...items[0]!, instructions: 'Runbook prose', checklistTemplateId },
  ];

  it('copies instructions and checklistTemplateId onto the new deliverable', async () => {
    dbMocks.rows.push([set], withChecklist('tcl-shared'), [{ partnerId: 'p1' }], [{ id: 'tcl-shared', orgId: null, partnerId: 'p1' }], []);
    await applyTemplateSet('org2', 's1', {}, { ...partnerAdmin, accessibleOrgIds: ['org1', 'org2'] });
    expect(createdCalls[0]!.input).toMatchObject({
      instructions: 'Runbook prose',
      checklistTemplateId: 'tcl-shared',
    });
  });

  it('409s CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG for org A’s PRIVATE template applied to org B', async () => {
    dbMocks.rows.push([set], withChecklist('tcl-A'), [{ partnerId: 'p1' }], [{ id: 'tcl-A', orgId: 'org1', partnerId: null }]);
    await expect(applyTemplateSet('org2', 's1', {}, { ...partnerAdmin, accessibleOrgIds: ['org1', 'org2'] }))
      .rejects.toMatchObject({ status: 409, code: 'CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG', details: { templateIds: ['tcl-A'] } });
    // Nothing is written: the check runs BEFORE the transaction.
    expect(createdCalls).toEqual([]);
  });

  it('ALLOWS a PARTNER-WIDE checklist template across orgs of the same partner', async () => {
    // This is the whole point of partner-wide: one procedure, every customer.
    dbMocks.rows.push([set], withChecklist('tcl-shared'), [{ partnerId: 'p1' }], [{ id: 'tcl-shared', orgId: null, partnerId: 'p1' }], []);
    await expect(applyTemplateSet('org2', 's1', {}, { ...partnerAdmin, accessibleOrgIds: ['org1', 'org2'] }))
      .resolves.toBeDefined();
  });

  it('ALLOWS an org-owned checklist template when the target IS that org', async () => {
    dbMocks.rows.push([set], withChecklist('tcl-A'), [{ partnerId: 'p1' }], [{ id: 'tcl-A', orgId: 'org1', partnerId: null }], []);
    await expect(applyTemplateSet('org1', 's1', {}, partnerAdmin)).resolves.toBeDefined();
  });

  it('409s a DANGLING pointer rather than applying it silently', async () => {
    dbMocks.rows.push([set], withChecklist('tcl-GONE'), [{ partnerId: 'p1' }], []);   // owner lookup resolves nothing
    await expect(applyTemplateSet('org1', 's1', {}, partnerAdmin))
      .rejects.toMatchObject({ status: 409, code: 'CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG', details: { templateIds: ['tcl-GONE'] } });
  });

  it('409s a FOREIGN partner’s partner-wide template too, not just a foreign org’s', async () => {
    // A partner-wide template is only "visible to both orgs by construction"
    // when it belongs to the TARGET ORG'S OWN partner. One owned by a different
    // MSP is exactly as unreachable as a foreign org's private template, so the
    // guard must reject it here rather than leaning on createDeliverable's
    // second-layer 404 mid-transaction.
    dbMocks.rows.push([set], withChecklist('tcl-FOREIGN'), [{ partnerId: 'p-TARGET' }], [{ id: 'tcl-FOREIGN', orgId: null, partnerId: 'p-OTHER' }]);
    await expect(applyTemplateSet('org1', 's1', {}, partnerAdmin))
      .rejects.toMatchObject({ status: 409, code: 'CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG', details: { templateIds: ['tcl-FOREIGN'] } });
    expect(createdCalls).toEqual([]);
  });

  it('does not query template owners at all when no item carries one', async () => {
    dbMocks.rows.push([set], withChecklist(null), []);
    await expect(applyTemplateSet('org1', 's1', {}, partnerAdmin)).resolves.toBeDefined();
    expect(createdCalls[0]!.input).toMatchObject({ checklistTemplateId: undefined });
  });

  describe('auto-evidence type resolution at apply time (#5784 OD-6 = A)', () => {
    beforeEach(() => { resolveMock.mockReset(); });
    const typed = [{ ...items[0]!, autoEvidenceReportType: 'threat_detection_review' }, { ...items[1]!, autoEvidenceReportType: null }];

    it('resolves the item type to that org’s managed definition on the SAME tx handle', async () => {
      resolveMock.mockResolvedValue({ id: 'r1', type: 'threat_detection_review', config: {}, adopted: false });
      dbMocks.rows.push([set], typed, []);
      await applyTemplateSet('org1', 's1', { effectiveFrom: '2026-10-01', ownerUserId: 'owner-1' }, partnerAdmin);
      const { db } = await import('../db');
      // The executor the service passed must be the transaction handle (the
      // chain mock passes itself as tx), not the module-level db proxy: the
      // ambient proxy resolves to the request transaction and would escape
      // the all-or-nothing rollback.
      expect(resolveMock).toHaveBeenCalledTimes(1);
      expect(resolveMock).toHaveBeenCalledWith('org1', 'threat_detection_review', 'owner-1', db);
      expect(createdCalls[0]!.input).toMatchObject({ name: 'Sign-in log review', autoEvidenceReportId: 'r1' });
      expect(createdCalls[1]!.input.autoEvidenceReportId).toBeUndefined();
    });

    it('falls back to the acting user as the definition owner when no ownerUserId is given', async () => {
      resolveMock.mockResolvedValue({ id: 'r1', type: 'threat_detection_review', config: {}, adopted: true });
      dbMocks.rows.push([set], typed, []);
      await applyTemplateSet('org1', 's1', { effectiveFrom: '2026-10-01' }, partnerAdmin);
      expect(resolveMock).toHaveBeenCalledWith('org1', 'threat_detection_review', partnerAdmin.userId, expect.anything());
    });

    it('400s EVIDENCE_OWNER_REQUIRED when neither ownerUserId nor an acting user exists', async () => {
      dbMocks.rows.push([set], typed, []);
      await expect(applyTemplateSet('org1', 's1', { effectiveFrom: '2026-10-01' }, { ...partnerAdmin, userId: null }))
        .rejects.toMatchObject({ status: 400, code: 'EVIDENCE_OWNER_REQUIRED' });
      expect(resolveMock).not.toHaveBeenCalled();
      expect(createdCalls).toEqual([]);
    });

    it('fails the whole apply when provisioning fails — nothing half-written', async () => {
      resolveMock.mockRejectedValue(new Error('boom'));
      dbMocks.rows.push([set], typed, []);
      await expect(applyTemplateSet('org1', 's1', { effectiveFrom: '2026-10-01' }, partnerAdmin)).rejects.toThrow();
      expect(createdCalls).toEqual([]);
    });

    it('leaves autoEvidenceReportId unset and never resolves for a set with no typed item', async () => {
      dbMocks.rows.push([set], items, []);
      await applyTemplateSet('org1', 's1', { effectiveFrom: '2026-10-01' }, partnerAdmin);
      expect(resolveMock).not.toHaveBeenCalled();
      expect(createdCalls.every((c) => c.input.autoEvidenceReportId === undefined)).toBe(true);
    });
  });
});

describe('autoEvidenceReportType is carried by every item write (#5784)', () => {
  beforeEach(() => { dbMocks.rows.length = 0; });
  const orgSet = { id: 's1', orgId: 'org1', partnerId: null, name: 'Org plan' };
  const item = { name: 'x', cadence: 'monthly' as const, leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve' as const, sortOrder: 0 };

  it('createTemplateSet copies the type onto the item row', async () => {
    const { db } = await import('../db');
    const values = vi.spyOn(db as any, 'values');
    dbMocks.rows.push([{ ...orgSet }], [{ id: 'i1', setId: 's1', ...item, autoEvidenceReportType: 'threat_detection_review' }]);
    await createTemplateSet({ ownerScope: 'organization', orgId: 'org1', name: 'Org plan', items: [{ ...item, autoEvidenceReportType: 'threat_detection_review' }] }, partnerAdmin);
    expect(values.mock.calls.some(([v]) => (v as { autoEvidenceReportType?: string }).autoEvidenceReportType === 'threat_detection_review')).toBe(true);
    values.mockRestore();
  });

  it('addTemplateItem copies the type; updateTemplateItem patches it, including back to null', async () => {
    const { db } = await import('../db');
    const values = vi.spyOn(db as any, 'values');
    const setSpy = vi.spyOn(db as any, 'set');
    dbMocks.rows.push([orgSet], [{ id: 'i1', setId: 's1', ...item, autoEvidenceReportType: 'threat_detection_review' }]);
    await addTemplateItem('s1', { ...item, autoEvidenceReportType: 'threat_detection_review' }, partnerAdmin);
    expect(values.mock.calls.at(-1)![0]).toMatchObject({ autoEvidenceReportType: 'threat_detection_review' });

    dbMocks.rows.push([orgSet], [{ id: 'i1', setId: 's1', ...item, autoEvidenceReportType: null }]);
    await updateTemplateItem('s1', 'i1', { autoEvidenceReportType: null }, partnerAdmin);
    expect(setSpy.mock.calls.at(-1)![0]).toMatchObject({ autoEvidenceReportType: null });

    dbMocks.rows.push([orgSet], [{ id: 'i1', setId: 's1', ...item }]);
    await updateTemplateItem('s1', 'i1', { graceDays: 21 }, partnerAdmin);
    expect(setSpy.mock.calls.at(-1)![0]).not.toHaveProperty('autoEvidenceReportType');
    values.mockRestore(); setSpy.mockRestore();
  });
});

describe('partner-wide write gate on every mutator (visibility is not permission)', () => {
  beforeEach(() => {
    dbMocks.rows.length = 0;
    refMocks.assertChecklistTemplateUsableByTemplateItemOwner.mockReset().mockResolvedValue(undefined);
    refMocks.assertChecklistTemplateUsableByOrg.mockReset().mockResolvedValue(undefined);
  });
  const partnerWideSet = { id: 's1', orgId: null, partnerId: 'p1', name: 'Best plan' };
  const item = { name: 'x', cadence: 'monthly' as const, leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve' as const, sortOrder: 0 };

  it('updateTemplateSet refuses a partner tech', async () => {
    dbMocks.rows.push([partnerWideSet]);
    await expect(updateTemplateSet('s1', { name: 'renamed' }, partnerTech)).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });

  it('deleteTemplateSet refuses a partner tech and writes nothing', async () => {
    dbMocks.rows.push([partnerWideSet]);
    const { db } = await import('../db');
    (db as any).delete.mockClear();
    await expect(deleteTemplateSet('s1', partnerTech)).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect((db as any).delete).not.toHaveBeenCalled();
  });

  it('updateTemplateItem refuses a partner tech', async () => {
    dbMocks.rows.push([partnerWideSet]);
    await expect(updateTemplateItem('s1', 'i1', { graceDays: 21 }, partnerTech)).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });

  it('removeTemplateItem refuses a partner tech', async () => {
    dbMocks.rows.push([partnerWideSet]);
    await expect(removeTemplateItem('s1', 'i1', partnerTech)).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });

  it('a full partner admin passes the gate on update (positive control)', async () => {
    dbMocks.rows.push([partnerWideSet]);                 // loadSetOr404
    dbMocks.rows.push([{ ...partnerWideSet, name: 'renamed' }]); // update returning
    dbMocks.rows.push([]);                               // hydrate items
    const out = await updateTemplateSet('s1', { name: 'renamed' }, partnerAdmin);
    expect(out.name).toBe('renamed');
    expect(out.ownerScope).toBe('partner');
  });
});

describe('item writes are scoped to the set in the path', () => {
  beforeEach(() => {
    dbMocks.rows.length = 0;
    refMocks.assertChecklistTemplateUsableByTemplateItemOwner.mockReset().mockResolvedValue(undefined);
    refMocks.assertChecklistTemplateUsableByOrg.mockReset().mockResolvedValue(undefined);
  });
  const orgSet = { id: 's1', orgId: 'org1', partnerId: null, name: 'Org set' };

  it('updateTemplateItem binds BOTH the item id and the set id, and 404s on zero rows', async () => {
    dbMocks.rows.push([orgSet]);   // loadSetOr404
    dbMocks.rows.push([]);         // update returning: item belongs to another set
    await expect(updateTemplateItem('s1', 'i-foreign', { graceDays: 21 }, partnerAdmin))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const { db } = await import('../db');
    const { sql, params } = compile((db as any).where.mock.calls.at(-1)?.[0]);
    expect(params).toEqual(expect.arrayContaining(['i-foreign', 's1']));
    expect(sql).toContain('"set_id"');
  });

  it('removeTemplateItem binds BOTH ids and 404s on zero rows', async () => {
    dbMocks.rows.push([orgSet]);
    dbMocks.rows.push([]);
    await expect(removeTemplateItem('s1', 'i-foreign', partnerAdmin)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const { db } = await import('../db');
    const { sql, params } = compile((db as any).where.mock.calls.at(-1)?.[0]);
    expect(params).toEqual(expect.arrayContaining(['i-foreign', 's1']));
    expect(sql).toContain('"set_id"');
  });
});

