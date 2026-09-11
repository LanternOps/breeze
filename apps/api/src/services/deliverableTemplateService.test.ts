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

import {
  createTemplateSet,
  listTemplateSets,
  addTemplateItem,
  TemplateServiceError,
} from './deliverableTemplateService';
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
