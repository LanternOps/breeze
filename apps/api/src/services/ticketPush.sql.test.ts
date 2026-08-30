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
import { anySlaSubscribersQuery, ANY_SUBSCRIBER_CAP } from './ticketPush';

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
