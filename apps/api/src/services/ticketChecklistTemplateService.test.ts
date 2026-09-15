import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const dbMocks = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../db', () => {
  const chain = () => {
    const c: any = {};
    for (const m of [
      'select',
      'from',
      'where',
      'limit',
      'orderBy',
      'innerJoin',
      'leftJoin',
      'insert',
      'values',
      'update',
      'set',
      'delete',
      'returning',
      'groupBy',
      'execute',
    ]) {
      c[m] = vi.fn(() => c);
    }
    c.then = (res: (v: unknown) => void) => res(dbMocks.rows.shift() ?? []);
    c.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(c));
    return c;
  };
  return { db: chain() };
});

import { db as mockedDb } from '../db';
import {
  applyChecklistTemplateToTicket,
  createChecklistTemplate,
  deleteChecklistTemplate,
  listChecklistTemplates,
  updateChecklistTemplate,
  visibleChecklistTemplateCondition,
  ChecklistTemplateServiceError,
} from './ticketChecklistTemplateService';
import { PartnerWideWriteDeniedError } from './partnerWideAccess';

const PARTNER_ADMIN = {
  userId: 'u-1',
  partnerId: 'p-1',
  accessibleOrgIds: ['o-1', 'o-2'],
  scope: 'partner' as const,
  partnerOrgAccess: 'all' as const,
};
const PARTNER_TECH = { ...PARTNER_ADMIN, userId: 'u-2', partnerOrgAccess: 'selected' as const };
const ORG_USER = {
  userId: 'u-3',
  partnerId: 'p-1',
  accessibleOrgIds: ['o-1'],
  scope: 'organization' as const,
  partnerOrgAccess: null,
};

/** Compile a drizzle SQL fragment to its literal text + bound params. */
function compile(fragment: unknown): { sql: string; params: unknown[] } {
  const { sql, params } = new PgDialect().sqlToQuery(fragment as SQL);
  return { sql, params };
}

/**
 * The chain mock carries a `then`, so it is THENABLE: returning it from an
 * async function (or awaiting it) resolves it THROUGH that `then` and hands
 * back the next queued row set instead of the chain. So it is imported
 * statically here — `vi.mock` is hoisted above imports — and never crosses an
 * await boundary.
 */
const dbMock = mockedDb as unknown as Record<string, ReturnType<typeof vi.fn>>;

/**
 * Clear CALL HISTORY only. `vi.clearAllMocks()` would strip the chain methods'
 * `() => c` implementations, which turns every later `db.insert(...).values(...)`
 * into a TypeError — the whole mock is one shared object.
 */
function resetDbCalls() {
  for (const value of Object.values(dbMock)) {
    if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
  }
}

describe('visibility', () => {
  it('adds the partner-wide arm for a PARTNER-scoped actor', () => {
    const { sql, params } = compile(visibleChecklistTemplateCondition(PARTNER_TECH));
    // Positive control: the org arm is bound too, so neither assertion can pass
    // merely because nothing was inspected.
    expect(params).toContain('o-1');
    expect(params).toContain('p-1');
    expect(sql).toContain('partner_id');
  });

  it('does NOT add the partner-wide arm for an ORG-scoped actor', () => {
    // An org token carries a partnerId but never passes
    // breeze_has_partner_access. Adding the arm app-side would promise a read
    // the database then refuses — and would claim a parity that does not exist.
    const { sql, params } = compile(visibleChecklistTemplateCondition(ORG_USER));
    expect(params).toContain('o-1');
    expect(params).not.toContain('p-1');
    expect(sql).not.toContain('partner_id');
  });

  it('returns undefined (everything) for a system actor', () => {
    expect(
      visibleChecklistTemplateCondition({
        userId: null,
        partnerId: null,
        accessibleOrgIds: null,
        scope: 'system',
        partnerOrgAccess: null,
      }),
    ).toBeUndefined();
  });
});

describe('partner-wide write gating', () => {
  beforeEach(() => {
    dbMocks.rows.length = 0;
    resetDbCalls();
  });

  it('a partner admin may create a partner-wide template', async () => {
    const db = dbMock;
    dbMocks.rows.push([{ id: 't-1', orgId: null, partnerId: 'p-1', name: 'X', isActive: true }]);
    await createChecklistTemplate({ ownerScope: 'partner', name: 'X', items: [] }, PARTNER_ADMIN);
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: null, partnerId: 'p-1' }),
    );
  });

  it('a partner tech with orgAccess=selected may NOT create a partner-wide template', async () => {
    const db = dbMock;
    await expect(
      createChecklistTemplate({ ownerScope: 'partner', name: 'X', items: [] }, PARTNER_TECH),
    ).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(db.values).not.toHaveBeenCalled();
  });

  it('an org-scope user may NOT create a partner-wide template either', async () => {
    await expect(
      createChecklistTemplate({ ownerScope: 'partner', name: 'X', items: [] }, ORG_USER),
    ).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });

  it('404s an org the actor cannot access, without touching the db', async () => {
    const db = dbMock;
    await expect(
      createChecklistTemplate(
        { ownerScope: 'organization', orgId: 'o-9', name: 'X', items: [] },
        PARTNER_ADMIN,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(db.values).not.toHaveBeenCalled();
  });

  it('a partner tech may NOT update a partner-wide template', async () => {
    dbMocks.rows.push([{ id: 't-1', orgId: null, partnerId: 'p-1' }]);
    await expect(
      updateChecklistTemplate('t-1', { name: 'Y' }, PARTNER_TECH),
    ).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });

  it('a partner tech may NOT delete a partner-wide template', async () => {
    dbMocks.rows.push([{ id: 't-1', orgId: null, partnerId: 'p-1' }]);
    await expect(deleteChecklistTemplate('t-1', PARTNER_TECH)).rejects.toBeInstanceOf(
      PartnerWideWriteDeniedError,
    );
  });

  it('a partner tech MAY update an ORG-owned template they can reach', async () => {
    dbMocks.rows.push([{ id: 't-2', orgId: 'o-1', partnerId: null }]);
    dbMocks.rows.push([{ id: 't-2', orgId: 'o-1', partnerId: null, name: 'Y', isActive: true }]);
    dbMocks.rows.push([]); // items hydrate
    await expect(updateChecklistTemplate('t-2', { name: 'Y' }, PARTNER_TECH)).resolves.toBeDefined();
  });

  it('404s a template outside the caller’s org and partner', async () => {
    dbMocks.rows.push([]);
    await expect(updateChecklistTemplate('FOREIGN', { name: 'Y' }, PARTNER_TECH)).rejects.toMatchObject(
      { status: 404, code: 'NOT_FOUND' },
    );
  });
});

describe('listChecklistTemplates', () => {
  beforeEach(() => {
    dbMocks.rows.length = 0;
    resetDbCalls();
  });

  it('a pinned orgId still lists partner-wide templates for a partner-scope reader', async () => {
    // The web fetchWithAuth wrapper pins orgId on EVERY request once an org is
    // open, so a bare `org_id = $1` would hide every partner-wide template the
    // moment a technician opens a ticket (#5675).
    const db = dbMock;
    dbMocks.rows.push([]);
    await listChecklistTemplates(PARTNER_ADMIN, { orgId: 'o-1' });
    const { sql, params } = compile(db.where.mock.calls.at(-1)?.[0]);
    expect(params).toContain('o-1');
    expect(params).toContain('p-1');
    expect(sql).toContain('partner_id');
  });

  it('hides inactive templates unless includeInactive is set', async () => {
    const db = dbMock;
    dbMocks.rows.push([]);
    await listChecklistTemplates(PARTNER_ADMIN, {});
    const activeOnly = compile(db.where.mock.calls.at(-1)?.[0]);
    expect(activeOnly.sql).toContain('is_active');

    resetDbCalls();
    dbMocks.rows.push([]);
    await listChecklistTemplates(PARTNER_ADMIN, { includeInactive: true });
    const withInactive = compile(db.where.mock.calls.at(-1)?.[0]);
    expect(withInactive.sql).not.toContain('is_active');
  });
});

describe('applyChecklistTemplateToTicket', () => {
  beforeEach(() => {
    dbMocks.rows.length = 0;
    resetDbCalls();
  });

  /** load template -> load its items -> (tx) max position -> (tx) insert. */
  function queueApply(
    template: Record<string, unknown> | null,
    items: Array<Record<string, unknown>>,
    maxPosition: number | null = null,
  ) {
    dbMocks.rows.push(template ? [template] : []);
    if (!template) return;
    dbMocks.rows.push(items);
    dbMocks.rows.push([{ maxPosition }]);
    dbMocks.rows.push([]); // the insert's own await
    dbMocks.rows.push([]); // listChecklist re-read
  }

  it('stamps copied rows with the TICKET’s org even for a partner-wide template', async () => {
    const db = dbMock;
    queueApply({ id: 't-1', orgId: null, partnerId: 'p-1' }, [
      { id: 'ti-1', label: 'Step A', detail: null, sortOrder: 0 },
      { id: 'ti-2', label: 'Step B', detail: 'note', sortOrder: 1 },
    ]);
    await applyChecklistTemplateToTicket(
      { id: 'tk-1', orgId: 'o-1' },
      { templateId: 't-1', mode: 'append' },
      PARTNER_TECH,
    );

    const rows = db.values.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
    // The TICKET's org, never the template's nullable owner. This is what keeps
    // a partner-wide template from creating a cross-tenant row.
    expect(rows.every((r) => r.orgId === 'o-1')).toBe(true);
    expect(rows.map((r) => r.source)).toEqual(['checklist_template', 'checklist_template']);
    expect(rows.map((r) => r.sourceTemplateItemId)).toEqual(['ti-1', 'ti-2']);
  });

  it('preserves the template order and appends after the existing items', async () => {
    const db = dbMock;
    // Ordering is Postgres's job (ORDER BY sort_order, label) and the chain
    // mock cannot model it, so the queued rows arrive already ordered as the
    // database would return them. The ORDER BY itself is asserted below, and
    // the real ordering is proven against Postgres in
    // ticketChecklistTemplatesPartnerRls.integration.test.ts.
    queueApply(
      { id: 't-1', orgId: 'o-1', partnerId: null },
      [
        { id: 'ti-1', label: 'A', detail: null, sortOrder: 0 },
        { id: 'ti-2', label: 'B', detail: null, sortOrder: 1 },
      ],
      2,
    );
    await applyChecklistTemplateToTicket(
      { id: 'tk-1', orgId: 'o-1' },
      { templateId: 't-1', mode: 'append' },
      PARTNER_TECH,
    );
    const orderClauses = db.orderBy.mock.calls.map((c) => compile(c[0]).sql);
    expect(orderClauses.some((s) => s.includes('sort_order'))).toBe(true);

    const rows = db.values.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.label)).toEqual(['A', 'B']);
    // max(position) was 2, so the copy starts at 3 rather than colliding with
    // the steps already on the ticket.
    expect(rows.map((r) => r.position)).toEqual([3, 4]);
  });

  it('replace_unticked deletes only unticked rows, in the SAME transaction', async () => {
    const db = dbMock;
    queueApply({ id: 't-1', orgId: 'o-1', partnerId: null }, [
      { id: 'ti-1', label: 'A', detail: null, sortOrder: 0 },
    ]);
    await applyChecklistTemplateToTicket(
      { id: 'tk-1', orgId: 'o-1' },
      { templateId: 't-1', mode: 'replace_unticked' },
      PARTNER_TECH,
    );
    expect(db.delete).toHaveBeenCalled();
    // A ticked item is a human attestation. Applying a template must never
    // destroy one (spec §3.3), so the predicate carries done_at IS NULL.
    const { sql } = compile(db.where.mock.calls.find((c) => {
      try {
        return compile(c[0]).sql.includes('done_at');
      } catch {
        return false;
      }
    })?.[0]);
    expect(sql).toContain('done_at');
    // replace + insert must be atomic, or a failure halfway leaves the ticket
    // with its old steps deleted and no new ones.
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('append does NOT delete anything', async () => {
    const db = dbMock;
    queueApply({ id: 't-1', orgId: 'o-1', partnerId: null }, [
      { id: 'ti-1', label: 'A', detail: null, sortOrder: 0 },
    ]);
    await applyChecklistTemplateToTicket(
      { id: 'tk-1', orgId: 'o-1' },
      { templateId: 't-1', mode: 'append' },
      PARTNER_TECH,
    );
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('404s on a template outside the caller’s org and partner', async () => {
    queueApply(null, []);
    await expect(
      applyChecklistTemplateToTicket(
        { id: 'tk-1', orgId: 'o-1' },
        { templateId: 'FOREIGN', mode: 'append' },
        PARTNER_TECH,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('a partner TECH may apply a partner-wide template (apply is not partner-wide administration)', async () => {
    // Spec §6.2: applying is a READ of the source plus a WRITE to the target,
    // not an edit of partner-wide state. Requiring partnerOrgAccess === 'all'
    // to *use* a shared checklist would make partner-wide templates useless to
    // the technicians they exist for.
    queueApply({ id: 't-1', orgId: null, partnerId: 'p-1' }, [
      { id: 'ti-1', label: 'A', detail: null, sortOrder: 0 },
    ]);
    await expect(
      applyChecklistTemplateToTicket(
        { id: 'tk-1', orgId: 'o-1' },
        { templateId: 't-1', mode: 'append' },
        PARTNER_TECH,
      ),
    ).resolves.toBeDefined();
  });

  it('refuses an INACTIVE template with 409', async () => {
    queueApply({ id: 't-1', orgId: 'o-1', partnerId: null, isActive: false }, []);
    await expect(
      applyChecklistTemplateToTicket(
        { id: 'tk-1', orgId: 'o-1' },
        { templateId: 't-1', mode: 'append' },
        PARTNER_TECH,
      ),
    ).rejects.toBeInstanceOf(ChecklistTemplateServiceError);
  });

  it('inserts nothing when the template has no items', async () => {
    const db = dbMock;
    queueApply({ id: 't-1', orgId: 'o-1', partnerId: null }, []);
    await applyChecklistTemplateToTicket(
      { id: 'tk-1', orgId: 'o-1' },
      { templateId: 't-1', mode: 'append' },
      PARTNER_TECH,
    );
    expect(db.insert).not.toHaveBeenCalled();
  });
});
