// apps/api/src/services/workTypeService.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { selectQueue, updateSpy, insertSpy } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  updateSpy: vi.fn(),
  insertSpy: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ orderBy: () => Promise.resolve(selectQueue.shift() ?? []), limit: () => Promise.resolve(selectQueue.shift() ?? []) }) }),
    })),
    insert: vi.fn(() => ({ values: (v: unknown) => { insertSpy(v); return { returning: () => Promise.resolve([{ id: 'wt-1', ...(v as object) }]) }; } })),
    update: vi.fn(() => ({ set: (v: unknown) => { updateSpy(v); return { where: () => ({ returning: () => Promise.resolve([{ id: 'wt-1', ...(v as object) }]) }) }; } })),
    delete: vi.fn(() => { throw new Error('work types are archived, never deleted'); }),
  },
}));

import { archiveWorkType, createWorkType, WorkTypeServiceError } from './workTypeService';

const PARTNER = 'bbbbbbbb-2222-4222-8222-222222222222';

beforeEach(() => { selectQueue.length = 0; updateSpy.mockClear(); insertSpy.mockClear(); vi.clearAllMocks(); });

describe('createWorkType', () => {
  it('rejects an insert that returns no work type instead of reporting success', async () => {
    const { db } = await import('../db');
    (db.insert as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      values: () => ({ returning: () => Promise.resolve([]) }),
    }));
    await expect(createWorkType(PARTNER, { name: 'Remote' })).rejects.toThrow('Failed to create work type');
  });

  it('stamps the acting partner id, never one from the input', async () => {
    await createWorkType(PARTNER, { name: 'Remote' });
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ partnerId: PARTNER, name: 'Remote' }));
  });
});

describe('archiveWorkType', () => {
  it('soft-deletes by setting isActive=false and NEVER issues a DELETE', async () => {
    await archiveWorkType('wt-1', PARTNER);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
    // db.delete is mocked to throw; reaching it would have failed the call above.
  });
});

describe('createWorkType duplicate handling', () => {
  it('maps a 23505 from the partner/lower(name) unique index to a 409 WORK_TYPE_NAME_TAKEN', async () => {
    const { db } = await import('../db');
    (db.insert as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      values: () => ({ returning: () => Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' })) }),
    }));
    await expect(createWorkType(PARTNER, { name: 'Remote' })).rejects.toMatchObject({
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
    await expect(createWorkType(PARTNER, { name: 'Remote' })).rejects.toMatchObject({
      status: 409, code: 'WORK_TYPE_NAME_TAKEN',
    });
  });
});
