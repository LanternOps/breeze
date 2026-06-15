import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, from, where, limit };
});
vi.mock('../db', () => ({ db: { select: dbMock.select } }));
vi.mock('../db/schema', () => ({ authenticatorPolicies: { partnerId: 'partner_id' } }));

import { loadPartnerPolicy, isEnforcing, validateRaiseOnly } from './authenticatorPolicy';

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

describe('isEnforcing', () => {
  const now = new Date('2026-06-14T12:00:00Z');
  it('false when policy is null', () => {
    expect(isEnforcing(null, now)).toBe(false);
  });
  it('false when enrollment not required', () => {
    expect(isEnforcing({ requireEnrollment: false, enforceFrom: null }, now)).toBe(false);
  });
  it('false during the grace window (enforceFrom in the future)', () => {
    expect(isEnforcing({ requireEnrollment: true, enforceFrom: new Date('2026-07-01T00:00:00Z') }, now)).toBe(false);
  });
  it('true when required and enforceFrom is null', () => {
    expect(isEnforcing({ requireEnrollment: true, enforceFrom: null }, now)).toBe(true);
  });
  it('true when required and enforceFrom has passed', () => {
    expect(isEnforcing({ requireEnrollment: true, enforceFrom: new Date('2026-06-01T00:00:00Z') }, now)).toBe(true);
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
