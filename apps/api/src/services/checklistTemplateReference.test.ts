import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The checklist-template REFERENCE rules (#5808 W03, spec §4.4).
 *
 * These rules are what stands in for the foreign key. The two
 * `checklist_template_id` FKs are deliberately SINGLE-column — a composite
 * `(checklist_template_id, org_id)` FK can never match a partner-wide template
 * (its `org_id` is NULL, `service_deliverables.org_id` is NOT NULL) — so the
 * owner-axis constraint has to live in the app layer, and this suite is the
 * thing that proves it exists.
 */

/** Rows the mocked `db.select(...)` chain resolves to, per call, in order. */
const selectResults: unknown[][] = [];

vi.mock('../db', () => {
  const chain = () => {
    const thenable = {
      from: () => thenable,
      where: () => thenable,
      limit: () => Promise.resolve(selectResults.shift() ?? []),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(selectResults.shift() ?? []).then(resolve),
    };
    return thenable;
  };
  return { db: { select: chain } };
});

const {
  assertChecklistTemplateUsableByOrg,
  assertChecklistTemplateUsableByTemplateItemOwner,
  assertChecklistTemplateNotInUse,
  findChecklistTemplateReferences,
  ChecklistReferenceError,
} = await import('./checklistTemplateReference');

/** Queue the single row (or nothing) the next template lookup should see. */
function templateRow(row: { orgId: string | null; partnerId: string | null } | null): void {
  selectResults.push(row ? [row] : []);
}

beforeEach(() => {
  selectResults.length = 0;
});

describe('assertChecklistTemplateUsableByOrg', () => {
  it('accepts a template owned by the same org', async () => {
    templateRow({ orgId: 'o-1', partnerId: null });
    await expect(assertChecklistTemplateUsableByOrg('t-1', 'o-1', 'p-1')).resolves.toBeUndefined();
  });

  it('accepts a PARTNER-WIDE template owned by the org’s partner', async () => {
    // This is the case the single-column FK exists for. A composite FK would
    // reject it at the database and the whole Partner-Wide First design with it.
    templateRow({ orgId: null, partnerId: 'p-1' });
    await expect(assertChecklistTemplateUsableByOrg('t-1', 'o-1', 'p-1')).resolves.toBeUndefined();
  });

  it('404s on another ORG’s template', async () => {
    templateRow({ orgId: 'o-OTHER', partnerId: null });
    await expect(assertChecklistTemplateUsableByOrg('t-1', 'o-1', 'p-1'))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('404s on another PARTNER’s partner-wide template', async () => {
    templateRow({ orgId: null, partnerId: 'p-OTHER' });
    await expect(assertChecklistTemplateUsableByOrg('t-1', 'o-1', 'p-1'))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('404s on a partner-wide template when the caller carries no partner', async () => {
    templateRow({ orgId: null, partnerId: 'p-1' });
    await expect(assertChecklistTemplateUsableByOrg('t-1', 'o-1', null))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('404s — never 403 — on a template that does not exist', async () => {
    // A template of another tenant and a non-existent one must be
    // indistinguishable, or the status code itself becomes an existence oracle.
    templateRow(null);
    await expect(assertChecklistTemplateUsableByOrg('nope', 'o-1', 'p-1'))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('assertChecklistTemplateUsableByTemplateItemOwner', () => {
  it('a PARTNER-WIDE item may reference a partner-wide template of the same partner', async () => {
    templateRow({ orgId: null, partnerId: 'p-1' });
    await expect(assertChecklistTemplateUsableByTemplateItemOwner('t-1', { orgId: null, partnerId: 'p-1' }))
      .resolves.toBeUndefined();
  });

  it('a PARTNER-WIDE item may NOT reference an ORG-OWNED template', async () => {
    // The owner axis must not narrow. An org-owned template would be invisible
    // to every other org the set is applied to, and the apply would silently
    // produce an empty checklist — the worst available outcome.
    templateRow({ orgId: 'o-1', partnerId: null });
    await expect(assertChecklistTemplateUsableByTemplateItemOwner('t-1', { orgId: null, partnerId: 'p-1' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('a PARTNER-WIDE item may NOT reference ANOTHER partner’s partner-wide template', async () => {
    templateRow({ orgId: null, partnerId: 'p-OTHER' });
    await expect(assertChecklistTemplateUsableByTemplateItemOwner('t-1', { orgId: null, partnerId: 'p-1' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('an ORG-OWNED item may reference its own org’s template', async () => {
    templateRow({ orgId: 'o-1', partnerId: null });
    await expect(assertChecklistTemplateUsableByTemplateItemOwner('t-1', { orgId: 'o-1', partnerId: 'p-1' }))
      .resolves.toBeUndefined();
  });

  it('an ORG-OWNED item may reference its partner’s partner-wide template', async () => {
    templateRow({ orgId: null, partnerId: 'p-1' });
    await expect(assertChecklistTemplateUsableByTemplateItemOwner('t-1', { orgId: 'o-1', partnerId: 'p-1' }))
      .resolves.toBeUndefined();
  });

  it('404s on a template that does not exist, for a partner-wide item too', async () => {
    templateRow(null);
    await expect(assertChecklistTemplateUsableByTemplateItemOwner('nope', { orgId: null, partnerId: 'p-1' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('assertChecklistTemplateNotInUse', () => {
  it('409s when a deliverable references the template, listing it', async () => {
    selectResults.push([{ id: 'd-1', name: 'Monthly review' }]); // deliverables
    selectResults.push([]); // template items
    await expect(assertChecklistTemplateNotInUse('t-1')).rejects.toMatchObject({
      status: 409,
      code: 'CHECKLIST_TEMPLATE_IN_USE',
      details: { deliverables: [{ id: 'd-1', name: 'Monthly review' }], templateItems: [] },
    });
  });

  it('409s when a deliverable TEMPLATE ITEM references it', async () => {
    selectResults.push([]);
    selectResults.push([{ id: 'ti-1', name: 'Quarterly audit' }]);
    await expect(assertChecklistTemplateNotInUse('t-1')).rejects.toMatchObject({
      status: 409,
      code: 'CHECKLIST_TEMPLATE_IN_USE',
      details: { deliverables: [], templateItems: [{ id: 'ti-1', name: 'Quarterly audit' }] },
    });
  });

  it('resolves when nothing references it', async () => {
    selectResults.push([]);
    selectResults.push([]);
    await expect(assertChecklistTemplateNotInUse('t-1')).resolves.toBeUndefined();
  });
});

describe('findChecklistTemplateReferences', () => {
  it('returns both reference lists', async () => {
    selectResults.push([{ id: 'd-1', name: 'D' }]);
    selectResults.push([{ id: 'ti-1', name: 'T' }]);
    await expect(findChecklistTemplateReferences('t-1')).resolves.toEqual({
      deliverables: [{ id: 'd-1', name: 'D' }],
      templateItems: [{ id: 'ti-1', name: 'T' }],
    });
  });
});

describe('ChecklistReferenceError', () => {
  it('carries status and code structurally, so every route’s error mapper handles it', async () => {
    // All three route mappers (serviceDeliverables, deliverableTemplates,
    // ticketChecklistTemplates) match on `status: number` + `code: string`
    // rather than instanceof, so this module needs no class registration.
    const err = new ChecklistReferenceError('x', 409, 'CODE', { a: 1 });
    expect(typeof err.status).toBe('number');
    expect(typeof err.code).toBe('string');
    expect(err.details).toEqual({ a: 1 });
  });
});
