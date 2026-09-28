import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, from, where, limit };
});
vi.mock('../db', () => ({
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()), db: { select: dbMock.select } }));
vi.mock('../db/schema', () => ({ authenticatorPolicies: { partnerId: 'partner_id' } }));

import {
  loadPartnerPolicy,
  isEnforcing,
  resolveEffectivePolicy,
  describeEffectivePolicy,
  validateRaiseOnly,
} from './authenticatorPolicy';

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReturnValue({ from: dbMock.from });
  dbMock.from.mockReturnValue({ where: dbMock.where });
  dbMock.where.mockReturnValue({ limit: dbMock.limit });
});

describe('loadPartnerPolicy', () => {
  it('returns null when partnerId is null (no DB hit)', async () => {
    expect(await loadPartnerPolicy(null)).toBeNull();
    expect(dbMock.select).not.toHaveBeenCalled();
  });
  it('returns the row when present', async () => {
    const row = { partnerId: 'p1', requireEnrollment: true };
    dbMock.limit.mockResolvedValueOnce([row]);
    expect(await loadPartnerPolicy('p1')).toBe(row);
  });
  it('returns null when no row', async () => {
    dbMock.limit.mockResolvedValueOnce([]);
    expect(await loadPartnerPolicy('p1')).toBeNull();
  });
});

describe('isEnforcing (explicit policy row)', () => {
  const now = new Date('2026-06-14T12:00:00Z');
  const defaultFrom = new Date('2026-11-05T00:00:00Z');
  const row = (requireEnrollment: boolean | null, enforceFrom: Date | null = null) =>
    ({ requireEnrollment, enforceFrom, floorOverrides: {} });
  it('false when enrollment explicitly not required — at every tier, even after the platform date', () => {
    const later = new Date('2027-01-01T00:00:00Z');
    for (const tier of ['low', 'medium', 'high', 'critical'] as const) {
      expect(isEnforcing(row(false), later, tier, defaultFrom)).toBe(false);
    }
  });
  it('false during the grace window (enforceFrom in the future)', () => {
    expect(isEnforcing(row(true, new Date('2026-07-01T00:00:00Z')), now, 'high', defaultFrom)).toBe(false);
  });
  it('true when required and enforceFrom is null', () => {
    expect(isEnforcing(row(true), now, 'high', defaultFrom)).toBe(true);
  });
  it('true when required and enforceFrom has passed', () => {
    expect(isEnforcing(row(true, new Date('2026-06-01T00:00:00Z')), now, 'high', defaultFrom)).toBe(true);
  });
  it('an explicit Required policy covers every tier, including medium', () => {
    expect(isEnforcing(row(true), now, 'medium', defaultFrom)).toBe(true);
    expect(isEnforcing(row(true), now, 'low', defaultFrom)).toBe(true);
  });
});

describe('isEnforcing (no explicit choice → platform default)', () => {
  const defaultFrom = new Date('2026-11-05T00:00:00Z');
  const before = new Date('2026-11-04T23:59:59Z');
  const after = new Date('2026-11-05T00:00:00Z');
  const inherit = { requireEnrollment: null, enforceFrom: null, floorOverrides: { medium: 3 as const } };

  it('no row: not enforcing before the platform date', () => {
    expect(isEnforcing(null, before, 'high', defaultFrom)).toBe(false);
    expect(isEnforcing(null, before, 'critical', defaultFrom)).toBe(false);
  });
  it('no row: enforcing for high and critical from the platform date', () => {
    expect(isEnforcing(null, after, 'high', defaultFrom)).toBe(true);
    expect(isEnforcing(null, after, 'critical', defaultFrom)).toBe(true);
  });
  it('no row: low and medium are never enforced by the platform default', () => {
    expect(isEnforcing(null, after, 'low', defaultFrom)).toBe(false);
    expect(isEnforcing(null, after, 'medium', defaultFrom)).toBe(false);
  });
  it('a row that leaves the enforcement choice blank inherits the platform default', () => {
    expect(isEnforcing(inherit, before, 'high', defaultFrom)).toBe(false);
    expect(isEnforcing(inherit, after, 'high', defaultFrom)).toBe(true);
    // A raised medium floor does not by itself make medium enforcing.
    expect(isEnforcing(inherit, after, 'medium', defaultFrom)).toBe(false);
  });
  it('reads the platform date from the environment when not passed', () => {
    const original = process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM;
    try {
      process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = '2030-01-01';
      expect(isEnforcing(null, after, 'high')).toBe(false);
      process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = '2026-01-01';
      expect(isEnforcing(null, after, 'high')).toBe(true);
    } finally {
      if (original === undefined) delete process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM;
      else process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = original;
    }
  });
});

describe('resolveEffectivePolicy / describeEffectivePolicy', () => {
  const defaultFrom = new Date('2026-11-05T00:00:00Z');
  const before = new Date('2026-10-20T00:00:00Z');
  const after = new Date('2026-11-06T00:00:00Z');

  it('no row → platform default, keeps no overrides', () => {
    expect(resolveEffectivePolicy(null, defaultFrom)).toEqual({
      source: 'platform_default',
      requireEnrollment: true,
      enforceFrom: defaultFrom,
      floorOverrides: {},
      enforcedTiers: ['high', 'critical'],
    });
  });
  it('blank enforcement choice → platform default, keeps the row floor overrides', () => {
    const eff = resolveEffectivePolicy(
      { requireEnrollment: null, enforceFrom: new Date('2020-01-01T00:00:00Z'), floorOverrides: { high: 4 } },
      defaultFrom,
    );
    expect(eff.source).toBe('platform_default');
    expect(eff.enforceFrom).toEqual(defaultFrom); // a stored date is ignored while inheriting
    expect(eff.floorOverrides).toEqual({ high: 4 });
  });
  it('explicit off is respected', () => {
    const eff = resolveEffectivePolicy({ requireEnrollment: false, enforceFrom: null, floorOverrides: {} }, defaultFrom);
    expect(eff).toMatchObject({ source: 'explicit', requireEnrollment: false, enforcedTiers: ['low', 'medium', 'high', 'critical'] });
  });

  it('no row before the date → grace with an upcoming notice', () => {
    expect(describeEffectivePolicy(null, before, defaultFrom)).toEqual({
      source: 'platform_default',
      mode: 'grace',
      requireEnrollment: true,
      enforceFrom: '2026-11-05T00:00:00.000Z',
      enforcedTiers: ['high', 'critical'],
      defaultNotice: 'upcoming',
    });
  });
  it('no row after the date → enforcing with an active notice', () => {
    expect(describeEffectivePolicy(null, after, defaultFrom)).toMatchObject({
      source: 'platform_default',
      mode: 'enforcing',
      defaultNotice: 'active',
    });
  });
  it('explicit rows never carry a platform-default notice', () => {
    expect(describeEffectivePolicy({ requireEnrollment: false, enforceFrom: null, floorOverrides: {} }, after, defaultFrom))
      .toMatchObject({ source: 'explicit', mode: 'off', defaultNotice: null, enforceFrom: null });
    expect(describeEffectivePolicy({ requireEnrollment: true, enforceFrom: new Date('2027-01-01T00:00:00Z'), floorOverrides: {} }, after, defaultFrom))
      .toMatchObject({ source: 'explicit', mode: 'grace', defaultNotice: null, enforceFrom: '2027-01-01T00:00:00.000Z' });
    expect(describeEffectivePolicy({ requireEnrollment: true, enforceFrom: null, floorOverrides: {} }, after, defaultFrom))
      .toMatchObject({ source: 'explicit', mode: 'enforcing', defaultNotice: null });
  });
});

describe('validateRaiseOnly', () => {
  it('passes when overrides equal or exceed the Breeze floor', () => {
    expect(() => validateRaiseOnly({ low: 2, medium: 3, high: 3, critical: 4 })).not.toThrow();
  });
  it('throws when an override weakens a tier below the floor', () => {
    expect(() => validateRaiseOnly({ high: 1 })).toThrow(/below the Breeze floor/i);
    expect(() => validateRaiseOnly({ critical: 2 })).toThrow(/below the Breeze floor/i);
  });
  it('passes for an empty override map', () => {
    expect(() => validateRaiseOnly({})).not.toThrow();
  });
});
