import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// ticketSiteScopeCondition builds a devices subquery off `db` when the caller
// has a non-empty site allowlist. A real (connection-less) drizzle builder
// compiles it without a database.
vi.mock('../../db', async () => {
  const { drizzle } = await import('drizzle-orm/node-postgres');
  return { db: drizzle.mock() };
});

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

  it('a site allowlist keeps deviceless counterparts and those on devices in the allowed sites', () => {
    const q = compile(ticketCounterpartScopeCondition(auth({ allowedSiteIds: ['site-1'] })))!;
    expect(q.sql).toMatch(/^\("tickets"\."device_id" is null or "tickets"\."device_id" in \(select "id" from "devices" where "devices"\."site_id" in \(\$1\)\)\)$/);
    expect(q.params).toEqual(['site-1']);
  });

  it('site and device allowlists together carry both clauses', () => {
    const q = compile(ticketCounterpartScopeCondition(auth({ allowedSiteIds: ['site-1'], allowedDeviceIds: ['dev-1'] })))!;
    expect(q.sql).toMatch(/"devices"\."site_id" in \(\$1\)/);
    expect(q.sql).toMatch(/\) and \("tickets"\."device_id" is null or "tickets"\."device_id" in \(\$2\)\)/);
    expect(q.params).toEqual(['site-1', 'dev-1']);
  });

  it('ANDs the device axis onto the site axis when both are present', () => {
    const q = compile(ticketCounterpartScopeCondition(auth({ allowedSiteIds: [], allowedDeviceIds: ['dev-1'] })))!;
    expect(q.sql).toBe('("tickets"."device_id" is null and ("tickets"."device_id" is null or "tickets"."device_id" in ($1)))');
  });
});
