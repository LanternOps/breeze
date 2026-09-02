/**
 * W07 (#3901): the ONE assertion that must not be vacuous — the compiled SQL of
 * the 'any'-SLA subscriber query. This file deliberately does NOT mock ../db, so
 * the real Drizzle builder produces real SQL; a `where` built against a mocked
 * table object would compile to something that asserts nothing (memory: vacuous
 * Drizzle where-clause assertions).
 *
 * The partner filter here IS the tenant boundary: the worker runs under a
 * system DB context with RLS bypassed, so nothing else stops a cross-partner
 * subscriber from being enumerated.
 */
import { describe, it, expect } from 'vitest';
import { anySlaSubscribersQuery, ANY_SUBSCRIBER_CAP, userPushTargetsQuery } from './ticketPush';

describe("anySlaSubscribersQuery — compiled SQL (vacuous-Drizzle trap)", () => {
  it('filters on sla_scope = any, users.partner_id = $partner, status = active, ordered, capped', () => {
    const { sql, params } = anySlaSubscribersQuery('p-1').toSQL();
    expect(sql).toMatch(/"ticket_push_preferences"\."sla_scope" = \$\d/);
    expect(sql).toMatch(/"users"\."partner_id" = \$\d/);
    expect(sql).toMatch(/"users"\."status" = \$\d/);
    expect(sql).toMatch(/order by "users"\."id"/i);
    expect(sql).toMatch(/limit \$\d/i);
    expect(params).toEqual(expect.arrayContaining(['any', 'p-1', 'active', ANY_SUBSCRIBER_CAP + 1]));
  });
});

/**
 * REGRESSION (#4281 review): the device filter had NO guard of any kind — the
 * unit suite's chainable `../db` mock ignores the WHERE, and every fixture in
 * the fan-out integration test took the column defaults
 * (notifications_enabled = true, status = 'active'), so deleting either clause
 * left the whole wave green. `mobile_devices.status` is the lost-phone /
 * admin-revocation lifecycle column and `notifications_enabled` is the ONLY
 * guard for a technician who turned notifications off in the app (the opt-out
 * route does not clear tokens), so both are security-relevant.
 */
describe('userPushTargetsQuery — compiled SQL (vacuous-Drizzle trap)', () => {
  it('filters on user_id IN, notifications_enabled = true and status = active', () => {
    const { sql, params } = userPushTargetsQuery(['u-1', 'u-2']).toSQL();
    expect(sql).toMatch(/"mobile_devices"\."user_id" in \(/i);
    expect(sql).toMatch(/"mobile_devices"\."notifications_enabled" = \$\d/);
    expect(sql).toMatch(/"mobile_devices"\."status" = \$\d/);
    expect(params).toEqual(expect.arrayContaining(['u-1', 'u-2', true, 'active']));
  });
});
