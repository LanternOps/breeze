import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMocks } = vi.hoisted(() => ({
  dbMocks: {
    selectResult: [] as unknown[],
    insertResult: [] as unknown[],
    insertedValues: [] as Record<string, unknown>[],
    conflictArgs: [] as Record<string, unknown>[],
    whereArgs: [] as unknown[],
  },
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((predicate: unknown) => {
          dbMocks.whereArgs.push(predicate);
          return { limit: vi.fn(() => Promise.resolve(dbMocks.selectResult)) };
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        dbMocks.insertedValues.push(vals);
        return {
          onConflictDoUpdate: vi.fn((arg: Record<string, unknown>) => {
            dbMocks.conflictArgs.push(arg);
            return { returning: vi.fn(() => Promise.resolve(dbMocks.insertResult)) };
          }),
        };
      }),
    })),
  },
}));

// Real eq() would build a SQL fragment we don't need to introspect precisely —
// swap in a plain sentinel so assertions on `whereArgs` are simple equality
// checks (mirrors ticketConfigService.test.ts).
vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((column: unknown, value: unknown) => ({ __op: 'eq', column, value })),
  };
});

vi.mock('../db/schema', () => ({
  auditRetentionPolicies: {
    id: 'id',
    orgId: 'orgId',
    retentionDays: 'retentionDays',
    lastCleanupAt: 'lastCleanupAt',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
}));

import { getOrgAuditRetentionPolicy, upsertOrgAuditRetentionPolicy } from './auditRetentionPolicyService';

const ORG_ID = '7c0a1f7e-4444-4666-9777-888899990000';

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.selectResult = [];
  dbMocks.insertResult = [];
  dbMocks.insertedValues = [];
  dbMocks.conflictArgs = [];
  dbMocks.whereArgs = [];
});

describe('getOrgAuditRetentionPolicy', () => {
  it('returns configured: false with the 365-day default when no row exists', async () => {
    dbMocks.selectResult = [];
    const result = await getOrgAuditRetentionPolicy(ORG_ID);
    expect(result).toEqual({ orgId: ORG_ID, configured: false, retentionDays: 365, lastCleanupAt: null });
  });

  it('returns the saved row when one exists, with lastCleanupAt serialized to ISO', async () => {
    const lastCleanupAt = new Date('2026-09-01T03:30:00.000Z');
    dbMocks.selectResult = [{ retentionDays: 90, lastCleanupAt }];
    const result = await getOrgAuditRetentionPolicy(ORG_ID);
    expect(result).toEqual({
      orgId: ORG_ID,
      configured: true,
      retentionDays: 90,
      lastCleanupAt: '2026-09-01T03:30:00.000Z',
    });
  });

  it('returns lastCleanupAt: null when the row has never been cleaned up', async () => {
    dbMocks.selectResult = [{ retentionDays: 90, lastCleanupAt: null }];
    const result = await getOrgAuditRetentionPolicy(ORG_ID);
    expect(result.lastCleanupAt).toBeNull();
  });

  it('filters on the caller\'s orgId', async () => {
    dbMocks.selectResult = [{ retentionDays: 90, lastCleanupAt: null }];
    await getOrgAuditRetentionPolicy(ORG_ID);
    expect(dbMocks.whereArgs).toEqual([{ __op: 'eq', column: 'orgId', value: ORG_ID }]);
  });
});

describe('upsertOrgAuditRetentionPolicy', () => {
  it('inserts with the given orgId and retentionDays', async () => {
    dbMocks.insertResult = [{ retentionDays: 180, lastCleanupAt: null }];
    await upsertOrgAuditRetentionPolicy(ORG_ID, 180);
    expect(dbMocks.insertedValues).toEqual([{ orgId: ORG_ID, retentionDays: 180 }]);
  });

  // #4633 review finding: an earlier version used SELECT...FOR UPDATE, which
  // only locks EXISTING rows — for an org with no row yet, two concurrent
  // calls both saw "no row" and both INSERTed, producing duplicates (nothing
  // in that approach could have caught it in a mocked unit test, since the
  // mock doesn't model Postgres locking). ON CONFLICT is a single atomic
  // statement instead, so there is no such window regardless of whether a
  // row already exists — this asserts the conflict target is the real
  // uniqueness guarantee (org_id), not a client-side existence check.
  it('upserts via ON CONFLICT on orgId — no separate existence check', async () => {
    dbMocks.insertResult = [{ retentionDays: 180, lastCleanupAt: null }];
    await upsertOrgAuditRetentionPolicy(ORG_ID, 180);
    expect(dbMocks.conflictArgs).toEqual([
      { target: 'orgId', set: expect.objectContaining({ retentionDays: 180 }) },
    ]);
    // No db.select() call at all — nothing to race between "check" and "act".
    expect(dbMocks.whereArgs).toEqual([]);
  });

  it('sets updatedAt on the conflict branch', async () => {
    dbMocks.insertResult = [{ retentionDays: 180, lastCleanupAt: null }];
    await upsertOrgAuditRetentionPolicy(ORG_ID, 180);
    expect(dbMocks.conflictArgs[0]!.set).toMatchObject({ retentionDays: 180 });
    expect((dbMocks.conflictArgs[0]!.set as Record<string, unknown>).updatedAt).toBeInstanceOf(Date);
  });

  it('returns configured: true with the saved row', async () => {
    dbMocks.insertResult = [{ retentionDays: 30, lastCleanupAt: null }];
    const result = await upsertOrgAuditRetentionPolicy(ORG_ID, 30);
    expect(result).toEqual({ orgId: ORG_ID, configured: true, retentionDays: 30, lastCleanupAt: null });
  });
});
