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
  beforeEach(() => { dbMocks.rows.length = 0; });

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
});

describe('applyTemplateSet', () => {
  beforeEach(() => { dbMocks.rows.length = 0; createdCalls.length = 0; });
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
});

describe('partner-wide write gate on every mutator (visibility is not permission)', () => {
  beforeEach(() => { dbMocks.rows.length = 0; });
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
  beforeEach(() => { dbMocks.rows.length = 0; });
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

