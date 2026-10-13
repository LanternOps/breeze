import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// ticketSiteScopeCondition builds a devices subquery off `db` only when the
// caller has a non-empty site allowlist; these cases never reach it.
vi.mock('../../db', () => ({ db: {} }));

import { ticketCounterpartScopeCondition } from './siteScope';
import type { AuthContext } from '../../middleware/auth';

const dialect = new PgDialect();
const compile = (cond: SQL | undefined) => (cond ? dialect.sqlToQuery(cond) : undefined);
const auth = (over: Partial<AuthContext>) => over as AuthContext;

/**
 * The link-counterpart visibility rule shared by GET /tickets/:id/links and the
 * manage_tickets list_links action (#8596): the site axis plus the exact-device
 * axis of a device-bound run, with deviceless tickets visible on both.
 */
describe('ticketCounterpartScopeCondition', () => {
  it('is unrestricted for a caller with neither a site nor a device allowlist', () => {
    expect(ticketCounterpartScopeCondition(auth({}))).toBeUndefined();
  });

  it('an empty site allowlist leaves only deviceless counterparts', () => {
    expect(compile(ticketCounterpartScopeCondition(auth({ allowedSiteIds: [] })))!.sql)
      .toBe('"tickets"."device_id" is null');
  });

  it('a device-bound caller sees deviceless counterparts and its own devices only', () => {
    const q = compile(ticketCounterpartScopeCondition(auth({ allowedDeviceIds: ['dev-1', 'dev-2'] })))!;
    expect(q.sql).toBe('("tickets"."device_id" is null or "tickets"."device_id" in ($1, $2))');
    expect(q.params).toEqual(['dev-1', 'dev-2']);
  });

  it('an empty device allowlist leaves only deviceless counterparts', () => {
    expect(compile(ticketCounterpartScopeCondition(auth({ allowedDeviceIds: [] })))!.sql)
      .toBe('"tickets"."device_id" is null');
  });

  it('ANDs the device axis onto the site axis when both are present', () => {
    const q = compile(ticketCounterpartScopeCondition(auth({ allowedSiteIds: [], allowedDeviceIds: ['dev-1'] })))!;
    expect(q.sql).toBe('("tickets"."device_id" is null and ("tickets"."device_id" is null or "tickets"."device_id" in ($1)))');
  });
});
