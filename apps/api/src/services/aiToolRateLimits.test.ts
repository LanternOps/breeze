import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/schema/orgs', () => ({
  partners: { id: 'partners.id', settings: 'partners.settings' },
}));

vi.mock('./effectiveSettings', () => ({
  getEffectiveAiBudget: vi.fn(),
}));

import { db } from '../db';
import { getEffectiveAiBudget } from './effectiveSettings';
import {
  normalizeToolRateLimitMultiplier,
  resolveToolRateLimitMultiplier,
  scaleToolRateLimit,
} from './aiToolRateLimits';

function primePartnerSettings(settings: unknown) {
  vi.mocked(db.select).mockImplementation((() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(settings === undefined ? [] : [{ settings }])),
    })),
  })) as never);
}

describe('normalizeToolRateLimitMultiplier', () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([1, 2, 5, 10])('passes %d through', (m) => {
    expect(normalizeToolRateLimitMultiplier(m)).toBe(m);
  });

  it('treats missing as 1 without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeToolRateLimitMultiplier(undefined)).toBe(1);
    expect(normalizeToolRateLimitMultiplier(null)).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([0, -3, 11, 1000, 2.5, '3', Number.NaN, Number.POSITIVE_INFINITY, {}])(
    'treats invalid %s as 1 and warns',
    (m) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(normalizeToolRateLimitMultiplier(m, 'test')).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});

describe('scaleToolRateLimit', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('multiplier 1 leaves the shipped limit unchanged', () => {
    expect(scaleToolRateLimit(5, 1)).toBe(5);
    expect(scaleToolRateLimit(2, 1)).toBe(2);
  });

  it('scales by ceil(limit × multiplier)', () => {
    expect(scaleToolRateLimit(5, 3)).toBe(15);
    expect(scaleToolRateLimit(2, 10)).toBe(20);
  });

  it('can never go below the shipped limit, even for a bogus multiplier', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(scaleToolRateLimit(5, 0)).toBe(5);
    expect(scaleToolRateLimit(5, -2)).toBe(5);
    expect(scaleToolRateLimit(5, 0.5)).toBe(5);
    // Above the cap is ignored too, rather than effectively removing the limit.
    expect(scaleToolRateLimit(5, 1_000_000)).toBe(5);
  });
});

describe('resolveToolRateLimitMultiplier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('reads the effective (partner-merged) AI budget of the call org', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue({ toolRateLimitMultiplier: 4 } as never);
    await expect(resolveToolRateLimitMultiplier({ orgId: 'org-1', partnerId: 'p-1' })).resolves.toBe(4);
    expect(getEffectiveAiBudget).toHaveBeenCalledWith('org-1');
    // The org path never needs the partner fallback read.
    expect(db.select).not.toHaveBeenCalled();
  });

  it('normalizes an out-of-range effective value to 1', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getEffectiveAiBudget).mockResolvedValue({ toolRateLimitMultiplier: 50 } as never);
    await expect(resolveToolRateLimitMultiplier({ orgId: 'org-1' })).resolves.toBe(1);
  });

  it('falls back to the partner aiBudgets value when there is no org', async () => {
    primePartnerSettings({ aiBudgets: { toolRateLimitMultiplier: 3 } });
    await expect(resolveToolRateLimitMultiplier({ orgId: null, partnerId: 'p-1' })).resolves.toBe(3);
    expect(getEffectiveAiBudget).not.toHaveBeenCalled();
  });

  it('is 1 for a partner that never set it', async () => {
    primePartnerSettings({ aiBudgets: {} });
    await expect(resolveToolRateLimitMultiplier({ orgId: null, partnerId: 'p-1' })).resolves.toBe(1);
  });

  it('is 1 with neither org nor partner', async () => {
    await expect(resolveToolRateLimitMultiplier({ orgId: null, partnerId: null })).resolves.toBe(1);
  });

  it('enforces the shipped limits (1) when the lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getEffectiveAiBudget).mockRejectedValue(new Error('db down'));
    await expect(resolveToolRateLimitMultiplier({ orgId: 'org-1' })).resolves.toBe(1);
    expect(warn).toHaveBeenCalled();
  });
});
