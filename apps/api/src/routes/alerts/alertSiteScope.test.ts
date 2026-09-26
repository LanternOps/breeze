import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { alertSiteScopeByDeviceIds, alertSiteScopeCondition, alertTopologySiteGate } from './helpers';

describe('alert site predicate preserves the deviceless policy', () => {
  const dialect = new PgDialect();
  it('leaves unrestricted organization and partner fleet reads unfiltered', () => {
    expect(alertSiteScopeCondition(undefined)).toBeUndefined();
  });
  it('admits only deviceless, non-topology alerts when no sites are allowed', () => {
    const query = dialect.sqlToQuery(alertSiteScopeCondition([])!);
    expect(query.sql).toBe('("alerts"."topology_site_id" is null and "alerts"."device_id" is null)');
    expect(query.params).toEqual([]);
  });
  it('admits deviceless alerts alongside current allowed device sites, and topology alerts by their OWNING site (M3-D6)', () => {
    const site = '4e63ffb4-d8bf-451a-a0d1-26c0cf363583';
    const query = dialect.sqlToQuery(alertSiteScopeCondition([site])!);
    expect(query.sql).toBe('(("alerts"."topology_site_id" is not null and "alerts"."topology_site_id" in ($1)) or ("alerts"."topology_site_id" is null and ("alerts"."device_id" is null or "devices"."site_id" in ($2))))');
    expect(query.params).toEqual([site, site]);
  });
});

describe('join-free alert site predicates (M3-D6, PR #7117 T1)', () => {
  const dialect = new PgDialect();
  const site = '4e63ffb4-d8bf-451a-a0d1-26c0cf363583';
  const device = '9b7c7f0e-8a39-4a9e-9a55-2a3d1f0b7a11';
  it('is unrestricted only when neither axis narrows', () => {
    expect(alertSiteScopeByDeviceIds({ allowedSiteIds: undefined, allowedDeviceIds: null })).toBeUndefined();
  });
  it('gates site-owned alerts by topology site and device alerts by device, never crossing them', () => {
    const query = dialect.sqlToQuery(alertSiteScopeByDeviceIds({ allowedSiteIds: [site], allowedDeviceIds: [device] })!);
    expect(query.sql).toBe('(("alerts"."topology_site_id" is null and "alerts"."device_id" in ($1)) or ("alerts"."topology_site_id" is not null and "alerts"."topology_site_id" in ($2)))');
    expect(query.params).toEqual([device, site]);
  });
  it('also binds a site-owned alert to the allowlisted device for an exact-device caller', () => {
    const query = dialect.sqlToQuery(alertSiteScopeByDeviceIds({ allowedSiteIds: undefined, allowedDeviceIds: [device], deviceAxis: true })!);
    expect(query.sql).toBe('(("alerts"."topology_site_id" is null and "alerts"."device_id" in ($1)) or ("alerts"."topology_site_id" is not null and "alerts"."device_id" in ($2)))');
  });
  it('matches no device alert for an empty device list but keeps owned-site alerts', () => {
    const query = dialect.sqlToQuery(alertSiteScopeByDeviceIds({ allowedSiteIds: [site], allowedDeviceIds: [] })!);
    expect(query.sql).toContain('"alerts"."topology_site_id" in ($1)');
    expect(query.sql).toContain('false');
  });
  it('device-tab gate hides site-owned alerts of sites outside the allowlist', () => {
    expect(alertTopologySiteGate(undefined)).toBeUndefined();
    expect(dialect.sqlToQuery(alertTopologySiteGate([])!).sql).toBe('"alerts"."topology_site_id" is null');
    expect(dialect.sqlToQuery(alertTopologySiteGate([site])!).sql).toBe('("alerts"."topology_site_id" is null or "alerts"."topology_site_id" in ($1))');
  });
});
