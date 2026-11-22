/**
 * #9692 — GET /devices/network reports whether each asset has active SNMP and
 * network monitoring. Written as correlated subqueries in a single-table select,
 * the flags rendered `"asset_id" = "id"` against the inner table in Postgres and
 * read false for every asset. Only real Postgres shows that.
 */
import './setup';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { discoveredAssets, networkMonitors, snmpDevices } from '../../db/schema';
import { networkRoutes } from '../../routes/devices/network';
import { createIntegrationTestClient } from './db-utils';
import { getTestDb } from './setup';

const admin = () => getTestDb() as any;

type Row = { id: string; snmpMonitoringEnabled: boolean; networkMonitoringEnabled: boolean };

describe('GET /devices/network monitoring flags', () => {
  it('reflects each asset\'s own active SNMP device and network monitor', async () => {
    const app = new Hono();
    app.route('/devices', networkRoutes);
    const client = await createIntegrationTestClient(app);
    const orgId = client.env.organization.id;
    const siteId = client.env.site.id;

    const asset = (octet: number, hostname: string) => ({
      orgId, siteId, ipAddress: `10.20.30.${octet}`, hostname, approvalStatus: 'approved',
    });
    const [snmpOnly, monitorOnly, both, inactive, neither] = await admin()
      .insert(discoveredAssets)
      .values([
        asset(1, 'snmp-only'),
        asset(2, 'monitor-only'),
        asset(3, 'both'),
        asset(4, 'inactive'),
        asset(5, 'neither'),
      ])
      .returning({ id: discoveredAssets.id });

    const snmp = (assetId: string, isActive: boolean) => ({
      orgId, assetId, name: 'snmp', ipAddress: '10.20.30.1', snmpVersion: 'v2c', isActive,
    });
    await admin().insert(snmpDevices).values([
      snmp(snmpOnly.id, true),
      snmp(both.id, true),
      snmp(inactive.id, false),
    ]);

    const monitor = (assetId: string, isActive: boolean) => ({
      orgId, assetId, name: 'ping', monitorType: 'icmp_ping', target: '10.20.30.1', isActive,
    });
    await admin().insert(networkMonitors).values([
      monitor(monitorOnly.id, true),
      monitor(both.id, true),
      monitor(inactive.id, false),
    ]);

    const res = await client.get('/devices/network');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Row[] };
    const flags = new Map(data.map((r) => [r.id, [r.snmpMonitoringEnabled, r.networkMonitoringEnabled]]));

    expect(flags.get(snmpOnly.id)).toEqual([true, false]);
    expect(flags.get(monitorOnly.id)).toEqual([false, true]);
    expect(flags.get(both.id)).toEqual([true, true]);
    expect(flags.get(inactive.id)).toEqual([false, false]);
    expect(flags.get(neither.id)).toEqual([false, false]);
  });
});
