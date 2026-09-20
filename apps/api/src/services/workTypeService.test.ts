// apps/api/src/services/workTypeService.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { selectQueue, updateSpy, insertSpy, txUpdates } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  updateSpy: vi.fn(),
  insertSpy: vi.fn(),
  // One entry per tx.update(...) issued by archiveWorkType, in order:
  // { table, set, returning }. `returning` is the queued result for that call.
  txUpdates: [] as Array<{ set: unknown; returning: unknown[] }>,
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ orderBy: () => Promise.resolve(selectQueue.shift() ?? []), limit: () => Promise.resolve(selectQueue.shift() ?? []) }) }),
    })),
    insert: vi.fn(() => ({ values: (v: unknown) => { insertSpy(v); return { returning: () => Promise.resolve([{ id: 'wt-1', ...(v as object) }]) }; } })),
    update: vi.fn(() => ({ set: (v: unknown) => { updateSpy(v); return { where: () => ({ returning: () => Promise.resolve([{ id: 'wt-1', ...(v as object) }]) }) }; } })),
    delete: vi.fn(() => { throw new Error('work types are archived, never deleted'); }),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      update: () => ({
        set: (set: unknown) => {
          const entry = txUpdates[txUpdateCursor.i++] ?? { set: undefined, returning: [] };
          entry.set = set;
          return { where: () => ({ returning: () => Promise.resolve(entry.returning) }) };
        },
      }),
    })),
  },
}));

import { archiveWorkType, createWorkType, getActiveWorkType, updateWorkType, WorkTypeServiceError } from './workTypeService';
import { PartnerWideWriteDeniedError } from './partnerWideAccess';

const PARTNER = 'bbbbbbbb-2222-4222-8222-222222222222';
// Every mutator takes the caller so the partner-wide gate lives in the service
// too (the walk in partner-wide-write-coverage.test.ts requires it there).
const ADMIN = { scope: 'partner', partnerOrgAccess: 'all' } as const;
const SELECTED = { scope: 'partner', partnerOrgAccess: 'selected' } as const;
const txUpdateCursor = { i: 0 };

beforeEach(() => { selectQueue.length = 0; txUpdates.length = 0; txUpdateCursor.i = 0; updateSpy.mockClear(); insertSpy.mockClear(); vi.clearAllMocks(); });

describe('createWorkType', () => {
  it('rejects an insert that returns no work type instead of reporting success', async () => {
    const { db } = await import('../db');
    (db.insert as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      values: () => ({ returning: () => Promise.resolve([]) }),
    }));
    await expect(createWorkType(ADMIN, PARTNER, { name: 'Remote' })).rejects.toThrow('Failed to create work type');
  });

  it('stamps the acting partner id, never one from the input', async () => {
    await createWorkType(ADMIN, PARTNER, { name: 'Remote' });
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ partnerId: PARTNER, name: 'Remote' }));
  });
});

describe('archiveWorkType', () => {
  const archivedRow = { id: 'wt-1', partnerId: PARTNER, name: 'Remote', isActive: false };

  it('soft-deletes by setting isActive=false and NEVER issues a DELETE', async () => {
    txUpdates.push({ set: undefined, returning: [archivedRow] }, { set: undefined, returning: [] });
    const result = await archiveWorkType(ADMIN, 'wt-1', PARTNER);
    expect(txUpdates[0]?.set).toMatchObject({ isActive: false });
    expect(result.workType).toMatchObject({ isActive: false });
    // db.delete is mocked to throw; reaching it would have failed the call above.
  });

  // Without this, ticket_categories keeps pointing at the archived row and the
  // server-side default goes on STAMPING it on every new entry -- the picker
  // stops offering it while the API keeps applying it.
  it('clears default_work_type_id on the partner\'s categories and reports the count', async () => {
    txUpdates.push(
      { set: undefined, returning: [archivedRow] },
      { set: undefined, returning: [{ id: 'cat-1' }, { id: 'cat-2' }] },
    );
    const result = await archiveWorkType(ADMIN, 'wt-1', PARTNER);
    expect(txUpdates[1]?.set).toMatchObject({ defaultWorkTypeId: null });
    expect(result.clearedCategoryCount).toBe(2);
  });

  it('reports zero cleared categories when none referenced it', async () => {
    txUpdates.push({ set: undefined, returning: [archivedRow] }, { set: undefined, returning: [] });
    await expect(archiveWorkType(ADMIN, 'wt-1', PARTNER)).resolves.toMatchObject({ clearedCategoryCount: 0 });
  });

  it('404s without touching categories when the id is not this partner\'s', async () => {
    txUpdates.push({ set: undefined, returning: [] }, { set: undefined, returning: [{ id: 'cat-1' }] });
    await expect(archiveWorkType(ADMIN, 'wt-1', PARTNER)).rejects.toMatchObject({ status: 404, code: 'WORK_TYPE_NOT_FOUND' });
    // The second update must never have run: its `set` is still undefined.
    expect(txUpdates[1]?.set).toBeUndefined();
  });
});

describe('createWorkType duplicate handling', () => {
  it('maps a 23505 from the partner/lower(name) unique index to a 409 WORK_TYPE_NAME_TAKEN', async () => {
    const { db } = await import('../db');
    (db.insert as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      values: () => ({ returning: () => Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' })) }),
    }));
    await expect(createWorkType(ADMIN, PARTNER, { name: 'Remote' })).rejects.toMatchObject({
      status: 409, code: 'WORK_TYPE_NAME_TAKEN',
    });
  });

  // Drizzle wraps the postgres.js PostgresError in a DrizzleQueryError whose
  // OWN `.code` is undefined -- the SQLSTATE lives on `.cause`. Every real
  // insert this service issues goes through Drizzle, so a top-level `.code`
  // check maps nothing and leaks a raw 500 on a duplicate name.
  it('maps a DRIZZLE-WRAPPED 23505 (SQLSTATE on .cause) to a 409, not a 500', async () => {
    const { db } = await import('../db');
    (db.insert as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      values: () => ({
        returning: () => Promise.reject(Object.assign(new Error('Failed query'), {
          cause: Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
            constraint_name: 'work_types_partner_name_lower_idx',
          }),
        })),
      }),
    }));
    await expect(createWorkType(ADMIN, PARTNER, { name: 'Remote' })).rejects.toMatchObject({
      status: 409, code: 'WORK_TYPE_NAME_TAKEN',
    });
  });
});

describe('getActiveWorkType', () => {
  it('returns the ACTIVE row for the acting partner', async () => {
    selectQueue.push([{ id: 'wt-1', partnerId: PARTNER, name: 'Remote', isActive: true }]);
    await expect(getActiveWorkType('wt-1', PARTNER)).resolves.toMatchObject({ id: 'wt-1' });
  });

  // The composite FK (work_type_id, partner_id) raises 23503 INSIDE the request
  // transaction, which aborts it -- a caught-after-the-fact mapping can only
  // ever produce a raw 500. This lookup is the pre-write gate, so a miss must
  // be null and never throw.
  it('returns null when no row matches (unknown id, archived, or another partner)', async () => {
    selectQueue.push([]);
    await expect(getActiveWorkType('wt-missing', PARTNER)).resolves.toBeNull();
  });
});

describe('updateWorkType', () => {
  it('raises a 404 WORK_TYPE_NOT_FOUND when the id belongs to another partner', async () => {
    const { db } = await import('../db');
    (db.update as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    }));
    const err = await updateWorkType(ADMIN, 'wt-1', PARTNER, { name: 'Renamed' }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkTypeServiceError);
    expect(err).toMatchObject({ status: 404, code: 'WORK_TYPE_NOT_FOUND' });
  });
});

describe('partner-wide write gate (service)', () => {
  it('createWorkType refuses a selected-org caller before touching the db', async () => {
    await expect(createWorkType(SELECTED, PARTNER, { name: 'Remote' })).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(insertSpy).not.toHaveBeenCalled();
  });
  it('updateWorkType refuses a selected-org caller', async () => {
    await expect(updateWorkType(SELECTED, 'wt-1', PARTNER, { name: 'x' })).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(updateSpy).not.toHaveBeenCalled();
  });
  it('archiveWorkType refuses a selected-org caller', async () => {
    await expect(archiveWorkType(SELECTED, 'wt-1', PARTNER)).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(txUpdates).toHaveLength(0);
  });
});
