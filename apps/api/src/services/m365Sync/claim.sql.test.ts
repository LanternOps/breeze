import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildReconcileEligibleSql } from './claim';

/**
 * COMPILED-SQL assertions in their own file. The sibling claim.test.ts mocks the
 * db module to exercise the call shapes; its assertions substring-match and are
 * blind to the mutations that actually matter here — a dropped
 * `ON CONFLICT DO NOTHING` (every tick would raise a unique violation and the
 * whole tick would abort), a dropped status filter (revoked connections would
 * be scheduled forever), or a lost stagger (every seeded org would fire in the
 * same second the flag is turned on).
 */
describe('reconcile eligibility (compiled SQL)', () => {
  const dialect = new PgDialect();
  const NOW = new Date('2026-09-08T12:00:00.000Z');

  it('inserts one row per (executable read connection x implemented domain), doing nothing on conflict', () => {
    const { sql, params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(sql).toContain('insert into "m365_sync_state"');
    expect(sql).toContain('on conflict ("org_id", "domain") do nothing');
    expect(sql).toContain('from "m365_connections"');
    expect(params).toContain('customer-graph-read');
    expect(params).toContain(NOW.toISOString());
  });

  it('binds `now` as an ISO STRING cast to timestamptz, never a Date object', () => {
    const { sql, params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    // postgres.js throws Buffer.byteLength at bind time on a Date in a raw
    // fragment, and compiled-SQL tests do not catch it — pin the string form.
    expect(params.some((p) => p instanceof Date)).toBe(false);
    expect(sql).toContain('::timestamptz');
  });

  it('restricts to active|degraded connections that have a verified tenant and an org', () => {
    const { sql, params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(params).toContain('active');
    expect(params).toContain('degraded');
    expect(sql).toContain('"tenant_id" is not null');
    expect(sql).toContain('"org_id" is not null');
  });

  it('staggers next_sync_at over the first hour rather than firing every org at once', () => {
    const { sql } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(sql).toContain('random()');
    expect(sql).toContain('3600');
  });

  it('seeds ONLY the domains this wave can persist', () => {
    const { params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(params).toContain('users');
    expect(params).toContain('intune_devices');
    expect(params).toContain('ca_policies');
    expect(params).toContain('skus');
    // W05 inverts this: when M365_SYNC_IMPLEMENTED_DOMAINS becomes
    // M365_SYNC_DOMAINS these two flip to `toContain`. They are the only two
    // assertions in the wave that W05 must edit rather than extend.
    expect(params).not.toContain('signin_activity');   // W05 inverts this
    expect(params).not.toContain('secure_score');      // W05 inverts this
  });

  it('seeds each domain with its own default interval', () => {
    const { params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(params).toContain(6 * 3600);   // users, intune_devices
    expect(params).toContain(24 * 3600);  // ca_policies, skus
  });
});
