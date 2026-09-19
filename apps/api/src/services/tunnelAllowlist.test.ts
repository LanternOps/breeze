import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

import { db } from '../db';
import { getActiveAllowlistPatterns, tunnelAllowlistRuleAppliesToSite } from './tunnelAllowlist';

describe('tunnelAllowlistRuleAppliesToSite', () => {
  const siteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const siteB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it.each([
    { ruleSiteId: null, bridgeSiteId: null, expected: true, label: 'global rule on unassigned bridge' },
    { ruleSiteId: null, bridgeSiteId: siteA, expected: true, label: 'global rule on assigned bridge' },
    { ruleSiteId: siteA, bridgeSiteId: siteA, expected: true, label: 'matching site rule' },
    { ruleSiteId: siteA, bridgeSiteId: siteB, expected: false, label: 'other-site rule' },
    { ruleSiteId: siteA, bridgeSiteId: null, expected: false, label: 'site rule on unassigned bridge' },
  ])('$label', ({ ruleSiteId, bridgeSiteId, expected }) => {
    expect(tunnelAllowlistRuleAppliesToSite(ruleSiteId, bridgeSiteId)).toBe(expected);
  });
});

describe('getActiveAllowlistPatterns', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns only global and matching-site rules for agent delivery', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { pattern: '10.0.0.1/32:443', siteId: null },
          { pattern: '10.0.0.2/32:443', siteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          { pattern: '10.0.0.3/32:443', siteId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        ]),
      }),
    } as never);

    await expect(getActiveAllowlistPatterns(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    )).resolves.toEqual([
      '10.0.0.1/32:443',
      '10.0.0.2/32:443',
    ]);
  });
});
