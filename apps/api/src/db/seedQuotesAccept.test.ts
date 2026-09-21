import { describe, it, expect } from 'vitest';
import { DEFAULT_PERMISSIONS, SYSTEM_ROLES } from './seed';

/**
 * The no-regression rule from the 2026-09-21 accept-on-behalf spec §7: every
 * seeded role that may SEND a quote may also RECORD an acceptance for it.
 * A fresh install seeds from SYSTEM_ROLES; an upgrade back-fills from
 * 2026-10-27-100100-quotes-accept-permission.sql. If these two disagree, two
 * databases disagree about who can convert a quote.
 */
describe('quotes:accept seeding', () => {
  it('registers the permission with the description the migration also uses', () => {
    const row = DEFAULT_PERMISSIONS.find((p) => p.resource === 'quotes' && p.action === 'accept');
    expect(row).toBeDefined();
    expect(row!.description).toBe(
      'Record a customer acceptance on their behalf and convert the quote to an invoice',
    );
  });

  it('grants quotes:accept to every seeded role holding quotes:send', () => {
    const senders = SYSTEM_ROLES.filter((r) => r.permissions.includes('quotes:send'));
    expect(senders.length).toBeGreaterThan(0); // the test is vacuous otherwise
    for (const role of senders) {
      expect(role.permissions, `${role.name} sends quotes but cannot accept them`)
        .toContain('quotes:accept');
    }
  });
});
