import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
}));

import { closingReason, resolveWritesPerHour, validateWindowSpan } from './migrationWindows';
import { migrationWindowLimits } from './migrationWindowLimits';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const DAY = 86_400_000;

const healthy = {
  id: 'w-1',
  endsAt: new Date(NOW.getTime() + DAY),
  principalStatus: 'active',
  principalExpiresAt: null as Date | null,
  principalScopes: ['tickets:read', 'tickets:write'],
  openerStatus: 'active',
  openerCredentialEpoch: 7,
  openerMfaEpoch: 2,
  snapshotCredentialEpoch: 7,
  snapshotMfaEpoch: 2,
  openerIsPartnerWideAdmin: true,
};

describe('closingReason — every condition that ends a window (spec §3.1)', () => {
  it('keeps a healthy window open', () => {
    expect(closingReason(healthy, NOW)).toBeNull();
  });

  it('expires at ends_at, inclusive', () => {
    expect(closingReason({ ...healthy, endsAt: NOW }, NOW)).toBe('expired');
    expect(closingReason({ ...healthy, endsAt: new Date(NOW.getTime() - 1) }, NOW)).toBe('expired');
  });

  it.each([
    ['disabled', { principalStatus: 'disabled' }],
    ['deleted (no principal row)', { principalStatus: null, principalScopes: null }],
    ['expired', { principalExpiresAt: new Date(NOW.getTime() - 1) }],
    ['without tickets:write', { principalScopes: ['tickets:read'] }],
  ])('closes when the principal is %s', (_label, patch) => {
    expect(closingReason({ ...healthy, ...patch }, NOW)).toBe('principal_inactive');
  });

  it.each([
    ['no longer active', { openerStatus: 'disabled' }],
    ['deleted (no user row)', { openerStatus: null, openerCredentialEpoch: null, openerMfaEpoch: null }],
    ['no longer a partner-wide admin', { openerIsPartnerWideAdmin: false }],
    ['past a password change (credential_epoch moved)', { openerCredentialEpoch: 8 }],
    ['past an MFA change (mfa_epoch moved)', { openerMfaEpoch: 3 }],
  ])('closes when the opener is %s', (_label, patch) => {
    expect(closingReason({ ...healthy, ...patch }, NOW)).toBe('opener_inactive');
  });

  it('reports expiry first when several conditions hold', () => {
    expect(closingReason({ ...healthy, endsAt: NOW, principalStatus: 'disabled', openerStatus: 'disabled' }, NOW)).toBe('expired');
  });
});

describe('window span and throughput (spec §3.2)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a window that ends in the future within the cap', () => {
    expect(() => validateWindowSpan(new Date(NOW.getTime() + 14 * DAY), NOW, 14)).not.toThrow();
  });

  it('refuses a window that has already ended or outlasts the cap', () => {
    expect(() => validateWindowSpan(NOW, NOW, 14)).toThrow(expect.objectContaining({ code: 'MIGRATION_WINDOW_INVALID_SPAN', status: 400 }));
    expect(() => validateWindowSpan(new Date(NOW.getTime() + 14 * DAY + 1), NOW, 14))
      .toThrow(expect.objectContaining({ code: 'MIGRATION_WINDOW_INVALID_SPAN' }));
    expect(() => validateWindowSpan(new Date('not a date'), NOW, 14)).toThrow(expect.objectContaining({ code: 'MIGRATION_WINDOW_INVALID_SPAN' }));
  });

  it('defaults the throughput and bounds it to [600, ceiling]', () => {
    expect(resolveWritesPerHour(undefined)).toBe(6000);
    expect(resolveWritesPerHour(600)).toBe(600);
    expect(resolveWritesPerHour(20000)).toBe(20000);
    for (const bad of [599, 20001, 1.5]) {
      expect(() => resolveWritesPerHour(bad)).toThrow(expect.objectContaining({ code: 'MIGRATION_WINDOW_INVALID_WRITES_PER_HOUR', status: 400 }));
    }
  });

  it('reads the limits from env and clamps them into what the table accepts', () => {
    expect(migrationWindowLimits()).toEqual({ maxDays: 14, defaultWritesPerHour: 6000, maxWritesPerHour: 20000 });
    vi.stubEnv('MIGRATION_WINDOW_MAX_DAYS', '7');
    vi.stubEnv('MIGRATION_WINDOW_MAX_WRITES_PER_HOUR', '500000');
    vi.stubEnv('MIGRATION_WINDOW_DEFAULT_WRITES_PER_HOUR', '100');
    expect(migrationWindowLimits()).toEqual({ maxDays: 7, defaultWritesPerHour: 600, maxWritesPerHour: 100000 });
    vi.stubEnv('MIGRATION_WINDOW_MAX_WRITES_PER_HOUR', '1000');
    vi.stubEnv('MIGRATION_WINDOW_DEFAULT_WRITES_PER_HOUR', '6000');
    expect(migrationWindowLimits().defaultWritesPerHour).toBe(1000);
    vi.stubEnv('MIGRATION_WINDOW_MAX_DAYS', 'zero');
    expect(migrationWindowLimits().maxDays).toBe(14);
  });
});
