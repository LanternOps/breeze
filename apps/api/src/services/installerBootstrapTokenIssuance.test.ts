import { describe, it, expect, vi, beforeEach } from 'vitest';

// This service has never had a direct test — its cap logic has only ever run
// under `vi.mock` from the route tests, which is precisely why #2775 shipped.
//
// Mocked the same way apps/api/src/routes/enrollmentKeys_installer.test.ts
// does: the service calls `db.select().from(enrollmentKeys).where(...).limit(1)`
// for the parent lookup (not `db.query.enrollmentKeys.findFirst`), so the
// mock shape has to match that chain.
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

import { db } from '../db';
import { issueBootstrapTokenForKey } from './installerBootstrapTokenIssuance';

function mockParent(overrides: Record<string, unknown> = {}) {
  const parent = {
    id: 'parent-1',
    name: 'Add device installer',
    orgId: 'org-1',
    siteId: 'site-1',
    maxUsage: null,
    usageCount: 0,
    // deliberately near-dead: the transient 60-min parent, 59 min in
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([parent]),
      }),
    }),
  } as any);
  return parent;
}

function mockInsert() {
  vi.mocked(db.insert).mockReturnValueOnce({
    values: (v: Record<string, unknown>) => ({
      returning: async () => [{ id: 'tok-1', ...v }],
    }),
  } as any);
}

describe('issueBootstrapTokenForKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('honours ttlMinutes even when the parent expires sooner (#2775)', async () => {
    mockParent();
    mockInsert();

    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
      maxUsage: 5,
      ttlMinutes: 10080, // 7 days
    });

    const ttlMs = result.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(10080 * 60 * 1000 - 60_000);
  });

  it('falls back to the 24h base TTL when ttlMinutes is omitted', async () => {
    mockParent();
    mockInsert();

    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
    });

    const ttlMs = result.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000);
  });
});
