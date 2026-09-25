import { describe, expect, it } from 'vitest';

import {
  FIXTURE_TABLE_TEMPLATES,
  buildFixtureTenants,
  createMigrationReplayTenantFixture,
} from './migrationReplayTenantFixture';

const isAscending = (ids: string[]) => ids.every((id, i) => i === 0 || ids[i - 1]!.localeCompare(id) <= 0);

describe('migration replay tenant fixture (#5361)', () => {
  it('spans 2 partners x 2 orgs, in an insertion order that is NOT ascending by UUID', () => {
    const tenants = buildFixtureTenants();

    expect(new Set(tenants.map((t) => t.partnerId)).size).toBe(2);
    expect(new Set(tenants.map((t) => t.orgId)).size).toBe(4);
    for (const partnerId of new Set(tenants.map((t) => t.partnerId))) {
      expect(tenants.filter((t) => t.partnerId === partnerId)).toHaveLength(2);
    }
    // Insertion order is the array order. An ascending order would let the
    // per-row paths accidentally satisfy the lock helpers' sorted-order check.
    expect(isAscending(tenants.map((t) => t.orgId))).toBe(false);
    expect(isAscending([...new Set(tenants.map((t) => t.partnerId))])).toBe(false);
  });

  it('has a one-row-per-org template for every partner-export material trigger table', () => {
    // The shipped material/site-child trigger set (2026-07-20). A table that
    // gains one of these triggers later must get a template: the hook refuses
    // to continue without one (see the next test).
    expect(Object.keys(FIXTURE_TABLE_TEMPLATES).sort()).toEqual([
      'device_disks',
      'device_hardware',
      'device_ip_history',
      'device_network',
      'device_warranty',
      'discovered_assets',
      'hyperv_vms',
      'network_baselines',
      'network_topology',
      'software_inventory',
    ]);
    const tenants = buildFixtureTenants();
    for (const [table, template] of Object.entries(FIXTURE_TABLE_TEMPLATES)) {
      const statement = template(tenants)[0]!;
      expect(statement, table).toMatch(new RegExp(`^INSERT INTO public\\.${table} `));
      // One statement, one VALUES tuple per org, orgs in fixture order.
      for (const tenant of tenants) expect(statement, table).toContain(tenant.orgId);
      const positions = tenants.map((t) => statement.indexOf(t.orgId));
      expect(positions, table).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it('is heterogeneous across tenants: only tenant 0 owns a UniFi-linked discovered asset', () => {
    // With four identical rows every WHERE clause selects all orgs or none, so
    // no statement ever locks a strict partner subset and the hierarchy guard
    // cannot fire (a uniform fixture let the #5239 migration replay green).
    // The outage data had UniFi-managed switches in SOME orgs only.
    const tenants = buildFixtureTenants();
    const [assets, ...followOn] = FIXTURE_TABLE_TEMPLATES.discovered_assets!(tenants);
    expect(assets).toContain('detected_asset_type');
    expect(followOn.map((s) => s.match(/^INSERT INTO public\.(\w+)/)?.[1])).toEqual([
      'unifi_integrations',
      'unifi_site_mappings',
      'unifi_devices',
    ]);
    const link = followOn[2]!;
    expect(link).toContain(tenants[0]!.assetId);
    for (const other of tenants.slice(1)) {
      expect(link).not.toContain(other.assetId);
      expect(link).not.toContain(other.orgId);
    }
  });

  it('seeds each trigger table once, on the first migration where the trigger exists', async () => {
    const executed: string[] = [];
    let triggerTables: string[] = [];
    const fixture = createMigrationReplayTenantFixture({
      listTriggerTables: async () => triggerTables,
      execute: async (statement) => {
        executed.push(statement);
      },
    });

    await fixture.afterMigration('0001-baseline.sql');
    expect(executed).toEqual([]);

    triggerTables = ['discovered_assets', 'device_disks'];
    await fixture.afterMigration('2026-07-20-partner-export-reconstruction-material-state.sql');
    const tenantRows = executed.filter((s) => /INSERT INTO public\.(partners|organizations|sites|devices) /.test(s));
    expect(tenantRows).toHaveLength(4);
    expect(executed.some((s) => s.startsWith('INSERT INTO public.discovered_assets '))).toBe(true);
    expect(executed.some((s) => s.startsWith('INSERT INTO public.device_disks '))).toBe(true);

    const before = executed.length;
    await fixture.afterMigration('2026-07-21-anything.sql');
    expect(executed).toHaveLength(before);
    expect(fixture.seededTables()).toEqual(['device_disks', 'discovered_assets']);
  });

  it('fails loud when a trigger table has no fixture template', async () => {
    const fixture = createMigrationReplayTenantFixture({
      listTriggerTables: async () => ['brand_new_device_child'],
      execute: async () => {},
    });

    await expect(fixture.afterMigration('2026-12-01-new.sql')).rejects.toThrow(
      /brand_new_device_child.*no fixture template/,
    );
  });
});
