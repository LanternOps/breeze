import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildClaimDueDomainsSql, buildReconcileEligibleSql } from './claim';

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

  it('seeds every contracted domain', () => {
    const { params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(params).toContain('users');
    expect(params).toContain('intune_devices');
    expect(params).toContain('ca_policies');
    expect(params).toContain('skus');
    // W05 inverted these two: both domains now have persisters, so seeding them
    // gives the ticker work to do rather than a row it can only re-claim.
    expect(params).toContain('signin_activity');
    expect(params).toContain('secure_score');
  });

  it('seeds each domain with its own default interval', () => {
    const { params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(params).toContain(6 * 3600);   // users, intune_devices
    expect(params).toContain(24 * 3600);  // ca_policies, skus, secure_score, signin_activity
  });
});

describe('claimDueDomains (compiled SQL) — spec §5.2 step 3', () => {
  const dialect = new PgDialect();
  const NOW = new Date('2026-09-08T12:00:00.000Z');
  const compile = (over = {}) => dialect.sqlToQuery(buildClaimDueDomainsSql({ limit: 200, now: NOW, ...over }));

  it('locks ONLY the state row and skips rows another ticker already holds', () => {
    const { sql } = compile();
    // `OF s` matters: locking m365_connections too would serialise every domain
    // of one org behind its connection row for the whole tick.
    expect(sql).toContain('for update of s skip locked');
    expect(sql.toLowerCase()).not.toContain('for update of s, c');
  });

  it('joins the connection on BOTH id and org_id, so a claim can never cross a tenant', () => {
    const { sql } = compile();
    expect(sql).toContain('c."id" = s."connection_id"');
    expect(sql).toContain('c."org_id" = s."org_id"');
  });

  it('selects only due, unleased rows on an executable connection', () => {
    const { sql, params } = compile();
    expect(sql).toContain('s."next_sync_at" is not null');
    expect(sql).toContain('s."next_sync_at" <=');
    expect(sql).toContain('s."lease_until" is null or s."lease_until" <');
    expect(params).toContain('active');
    expect(params).toContain('degraded');
  });

  it('orders by next_sync_at and honours the batch limit', () => {
    const { sql, params } = compile({ limit: 25 });
    expect(sql).toContain('order by s."next_sync_at" asc');
    expect(params).toContain(25);
  });

  it('takes a 20-minute lease and INCREMENTS the generation', () => {
    const { sql } = compile();
    expect(sql).toContain(`interval '20 minutes'`);
    expect(sql).toContain('"run_generation" = t."run_generation" + 1');
  });

  it('does NOT touch next_sync_at — cadence advances only on completion (spec §5.2)', () => {
    const { sql } = compile();
    const update = sql.slice(sql.toLowerCase().indexOf('update "m365_sync_state"'));
    expect(update).not.toContain('"next_sync_at" =');
  });

  it('keys the UPDATE on the unique (org_id, domain), not on an unstated surrogate id', () => {
    const { sql } = compile();
    expect(sql).toContain('t."org_id" = due."org_id"');
    expect(sql).toContain('t."domain" = due."domain"');
  });

  it('returns everything the job payload needs, including the NEW generation', () => {
    const { sql } = compile();
    for (const fragment of [
      't."org_id"', 't."domain"', 't."run_generation"',
      'due."connection_id"', 'due."tenant_id"', 'due."consent_generation"',
    ]) expect(sql).toContain(fragment);
  });

  it('narrows to one org and an explicit domain list when asked (the priority-1 lane)', () => {
    const { sql, params } = compile({ orgId: 'org-1', domains: ['users', 'skus'] });
    expect(sql).toContain('s."org_id" =');
    expect(params).toContain('org-1');
    expect(params).toContain('users');
    expect(params).toContain('skus');
  });

  it('binds every timestamp as an ISO string, never a Date', () => {
    const { params } = compile();
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });
});
