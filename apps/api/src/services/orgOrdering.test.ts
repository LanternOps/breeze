import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectMock, updateMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: selectMock, update: updateMock },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  partners: { id: 'partners.id', settings: 'partners.settings' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((l: unknown, r: unknown) => ({ eq: [l, r] })),
}));

vi.mock('./encryptedColumnRegistry', () => ({
  encryptColumnValueForWrite: vi.fn((_table: string, _column: string, value: unknown) => value),
}));

import { removeOrgFromPartnerOrder, sanitizeOrganizationOrder } from './orgOrdering';

describe('sanitizeOrganizationOrder', () => {
  it('keeps only ids that are in the valid set', () => {
    expect(sanitizeOrganizationOrder(['a', 'stale', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  it('preserves the caller order', () => {
    expect(sanitizeOrganizationOrder(['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
  });

  it('drops duplicates while preserving first occurrence', () => {
    expect(sanitizeOrganizationOrder(['a', 'b', 'a', 'c', 'b'], ['a', 'b', 'c'])).toEqual([
      'a', 'b', 'c',
    ]);
  });

  it('returns empty array when nothing valid', () => {
    expect(sanitizeOrganizationOrder(['x', 'y'], ['a', 'b'])).toEqual([]);
  });

  it('returns empty array on empty input', () => {
    expect(sanitizeOrganizationOrder([], ['a', 'b'])).toEqual([]);
  });
});

describe('removeOrgFromPartnerOrder', () => {
  beforeEach(() => {
    selectMock.mockReset();
    updateMock.mockReset();
  });

  function queueSelect(rows: unknown[]) {
    selectMock.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    });
  }

  function captureUpdates(): Array<{ values: Record<string, unknown> }> {
    const log: Array<{ values: Record<string, unknown> }> = [];
    updateMock.mockImplementation(() => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          log.push({ values });
          return Promise.resolve();
        },
      }),
    }));
    return log;
  }

  it('removes the org id and writes back the filtered order', async () => {
    queueSelect([{ settings: { organizationOrder: ['a', 'b', 'c'] } }]);
    const updates = captureUpdates();

    await removeOrgFromPartnerOrder('partner-1', 'b');

    expect(updates).toHaveLength(1);
    expect(updates[0]!.values).toMatchObject({ settings: { organizationOrder: ['a', 'c'] } });
  });

  it('does nothing when the partner has no saved order', async () => {
    queueSelect([{ settings: {} }]);
    const updates = captureUpdates();

    await removeOrgFromPartnerOrder('partner-1', 'b');

    expect(updates).toHaveLength(0);
  });

  it('does nothing when the id is not present in the saved order', async () => {
    queueSelect([{ settings: { organizationOrder: ['x', 'y'] } }]);
    const updates = captureUpdates();

    await removeOrgFromPartnerOrder('partner-1', 'b');

    expect(updates).toHaveLength(0);
  });

  it('does nothing when the partner is not found', async () => {
    queueSelect([]);
    const updates = captureUpdates();

    await removeOrgFromPartnerOrder('partner-1', 'b');

    expect(updates).toHaveLength(0);
  });
});
