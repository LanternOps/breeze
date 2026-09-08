import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { alertSiteScopeCondition } from './helpers';

describe('alert site predicate preserves the deviceless policy', () => {
  const dialect = new PgDialect();
  it('leaves unrestricted organization and partner fleet reads unfiltered', () => {
    expect(alertSiteScopeCondition(undefined)).toBeUndefined();
  });
  it('admits only deviceless alerts when no sites are allowed', () => {
    const query = dialect.sqlToQuery(alertSiteScopeCondition([])!);
    expect(query.sql).toBe('"alerts"."device_id" is null');
    expect(query.params).toEqual([]);
  });
  it('admits deviceless alerts alongside current allowed device sites', () => {
    const site = '4e63ffb4-d8bf-451a-a0d1-26c0cf363583';
    const query = dialect.sqlToQuery(alertSiteScopeCondition([site])!);
    expect(query.sql).toBe('("alerts"."device_id" is null or "devices"."site_id" in ($1))');
    expect(query.params).toEqual([site]);
  });
});
