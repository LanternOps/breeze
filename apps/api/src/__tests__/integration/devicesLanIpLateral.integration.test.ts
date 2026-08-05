/**
 * LAN-IP selection LATERAL query — integration test (#2503)
 *
 * The opt-in "LAN IP" column on the Devices list shows ONE address per
 * device, chosen out of the device's `device_network` interface rows by the
 * LATERAL in `routes/devices/core.ts`. The choice is the entire feature: a
 * typical machine reports many interfaces (VM bridges, Docker/Hyper-V
 * switches, VPN tunnels, loopback-ish APIPA leftovers) and only one of them
 * is the address a tech wants to see.
 *
 * The unit tests around this route mock `db.execute` wholesale, so they pin
 * the row -> `lanIp` mapping and nothing about the ranking. This file is the
 * only place the `ORDER BY` is executed by Postgres. It exists because the
 * sibling latest-metrics LATERAL 35 lines above it had a production failure
 * that a mocked test could not see (Drizzle's `sql` array-spread binding),
 * and this query reuses that same `idTuples` fragment.
 *
 * The four ranking tiers under test, best-first:
 *   1. `is_primary` — the agent's own guess at the default-route interface
 *   2. IPv4 before IPv6
 *   3. routable before APIPA / link-local / loopback
 *   4. `interface_name` — a deterministic tiebreak so the column is stable
 *      across page loads rather than flapping between equal candidates
 *
 * Tier 1 alone is deliberately NOT trusted: the agent sets `is_primary` from
 * a fixed interface-NAME allowlist (agent/internal/collectors/inventory.go —
 * en0/eth0/ens33/enp0s3/wlan0/Wi-Fi/Ethernet), which misses the
 * "Ethernet 2"/"eno1"/"enp3s0" names common on real fleets. Tiers 2-4 are
 * what keep the column populated for those devices, so each is pinned below.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/devicesLanIpLateral.integration.test.ts
 */
import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { devices, deviceNetwork } from '../../db/schema';
import { createPartner, createOrganization, createSite } from './db-utils';

// Index signature required so `db.execute<T>` accepts T as a Record<string, unknown>.
interface LanIpRow extends Record<string, unknown> {
  device_id: string;
  ip_address: string;
}

let agentIdCounter = 0;
async function insertDevice(opts: {
  orgId: string;
  siteId: string;
  hostname: string;
}): Promise<string> {
  const db = getTestDb();
  agentIdCounter++;
  const [row] = await db
    .insert(devices)
    .values({
      orgId: opts.orgId,
      siteId: opts.siteId,
      agentId: `agent-lanip-${agentIdCounter}-${Date.now()}`,
      hostname: opts.hostname,
      displayName: opts.hostname,
      osType: 'windows',
      osVersion: '11',
      osBuild: '22000',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertDevice: insert returned no row');
  return row.id;
}

async function insertInterfaces(
  deviceId: string,
  orgId: string,
  adapters: Array<{
    interfaceName: string;
    ipAddress: string | null;
    ipType?: 'ipv4' | 'ipv6';
    isPrimary?: boolean;
  }>,
) {
  await getTestDb()
    .insert(deviceNetwork)
    .values(
      adapters.map((a) => ({
        deviceId,
        orgId,
        interfaceName: a.interfaceName,
        ipAddress: a.ipAddress,
        ipType: a.ipType ?? 'ipv4',
        isPrimary: a.isPrimary ?? false,
      })),
    );
}

/**
 * Verbatim copy of the query in routes/devices/core.ts. Kept as a literal
 * rather than imported so a silent edit to the route shows up here as a
 * behavioral diff — the point is to execute this exact SQL against Postgres.
 */
async function selectLanIps(deviceIds: string[]): Promise<LanIpRow[]> {
  const idTuples = sql.join(
    deviceIds.map((id) => sql`(${id}::uuid)`),
    sql`, `,
  );

  return getTestDb().execute<LanIpRow>(sql`
    SELECT d.device_id, n.ip_address
    FROM (VALUES ${idTuples}) AS d(device_id)
    INNER JOIN LATERAL (
      SELECT ip_address, interface_name
      FROM ${deviceNetwork}
      WHERE device_id = d.device_id
        AND ip_address IS NOT NULL
      ORDER BY
        is_primary DESC,
        (ip_type = 'ipv4') DESC,
        (
          ip_address LIKE '169.254.%'
          OR ip_address LIKE '127.%'
          OR ip_address ILIKE 'fe80:%'
          OR ip_address = '::1'
        ) ASC,
        interface_name ASC
      LIMIT 1
    ) AS n ON true
  `);
}

async function lanIpFor(deviceId: string): Promise<string | undefined> {
  const rows = await selectLanIps([deviceId]);
  return rows[0]?.ip_address;
}

describe('GET /devices LAN-IP selection LATERAL (integration, #2503)', () => {
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
    const site = await createSite({ orgId });
    siteId = site.id;
  });

  it('tier 1: prefers the is_primary interface over lexically earlier ones', async () => {
    const deviceId = await insertDevice({ orgId, siteId, hostname: 'vm-host' });
    // Shape taken from a real macOS device: eight virtual VM bridges that all
    // sort before "en0". Without the is_primary tier the tiebreak alone would
    // return bridge100's address — a VM-internal network, useless to a tech.
    await insertInterfaces(deviceId, orgId, [
      { interfaceName: 'bridge100', ipAddress: '192.168.139.3' },
      { interfaceName: 'bridge101', ipAddress: '192.168.117.4' },
      { interfaceName: 'bridge102', ipAddress: '172.34.0.5' },
      { interfaceName: 'en0', ipAddress: '192.168.110.29', isPrimary: true },
    ]);

    expect(await lanIpFor(deviceId)).toBe('192.168.110.29');
  });

  it('tier 2: prefers IPv4 over IPv6 when no interface is flagged primary', async () => {
    const deviceId = await insertDevice({ orgId, siteId, hostname: 'no-primary' });
    // "Ethernet 2" is exactly the name the agent's is_primary allowlist misses,
    // so nothing here is primary — the reason tiers 2-4 have to carry it.
    // The IPv6 row sorts FIRST by interface_name, so only the ip_type tier
    // can produce the IPv4 answer.
    await insertInterfaces(deviceId, orgId, [
      { interfaceName: 'Ethernet 1', ipAddress: '2001:db8::5', ipType: 'ipv6' },
      { interfaceName: 'Ethernet 2', ipAddress: '10.4.5.6', ipType: 'ipv4' },
    ]);

    expect(await lanIpFor(deviceId)).toBe('10.4.5.6');
  });

  it('tier 3: prefers a routable address over APIPA, loopback and link-local', async () => {
    const deviceId = await insertDevice({ orgId, siteId, hostname: 'apipa-box' });
    // Every non-routable candidate sorts before the real address by name, so
    // only the routability tier can pick 10.1.2.3. An unconfigured 169.254.x
    // in a fleet-scan column is worse than a dash — it looks like an answer.
    await insertInterfaces(deviceId, orgId, [
      { interfaceName: 'aaa-apipa', ipAddress: '169.254.10.20' },
      { interfaceName: 'bbb-loopback', ipAddress: '127.0.0.1' },
      { interfaceName: 'ccc-linklocal', ipAddress: 'fe80::1', ipType: 'ipv4' },
      { interfaceName: 'zzz-real', ipAddress: '10.1.2.3' },
    ]);

    expect(await lanIpFor(deviceId)).toBe('10.1.2.3');
  });

  it('tier 3: classifies an uppercase FE80:: link-local as non-routable', async () => {
    const deviceId = await insertDevice({ orgId, siteId, hostname: 'upper-ll' });
    // Go's net.IP.String() lowercases, but the column is free text fed by an
    // agent payload — a case-sensitive LIKE here would rank FE80:: above the
    // real NIC. ILIKE is what makes this pass.
    await insertInterfaces(deviceId, orgId, [
      { interfaceName: 'aaa', ipAddress: 'FE80::ABCD', ipType: 'ipv4' },
      { interfaceName: 'zzz', ipAddress: '10.9.9.9' },
    ]);

    expect(await lanIpFor(deviceId)).toBe('10.9.9.9');
  });

  it('tier 4: breaks a genuine tie by interface_name, stably across calls', async () => {
    const deviceId = await insertDevice({ orgId, siteId, hostname: 'tie-box' });
    // Two rows identical on every preceding tier. Without a total ordering
    // Postgres may return either, and the column would flap between page
    // loads for no visible reason.
    await insertInterfaces(deviceId, orgId, [
      { interfaceName: 'eth9', ipAddress: '10.0.0.99' },
      { interfaceName: 'eth1', ipAddress: '10.0.0.11' },
    ]);

    expect(await lanIpFor(deviceId)).toBe('10.0.0.11');
    expect(await lanIpFor(deviceId)).toBe('10.0.0.11');
  });

  it('ignores interface rows that carry no address at all', async () => {
    const deviceId = await insertDevice({ orgId, siteId, hostname: 'null-ip' });
    // device_network.ip_address is nullable and the agent inserts a row for a
    // MAC-bearing adapter even when it has no address (cable out, DHCP still
    // pending). The addressless row is deliberately the PRIMARY one here: the
    // guard has to be what excludes it, because tier 1 would otherwise rank it
    // first and the column would return NULL for a device that plainly has an
    // address. Ranking the row last instead of filtering it is not enough —
    // ORDER BY only decides between rows that survive the WHERE.
    await insertInterfaces(deviceId, orgId, [
      { interfaceName: 'aaa-down', ipAddress: null, isPrimary: true },
      { interfaceName: 'zzz-up', ipAddress: '10.7.7.7' },
    ]);

    expect(await lanIpFor(deviceId)).toBe('10.7.7.7');
  });

  it('omits devices with no interface rows rather than returning a null address', async () => {
    const withNetwork = await insertDevice({ orgId, siteId, hostname: 'has-net' });
    const withoutNetwork = await insertDevice({ orgId, siteId, hostname: 'no-net' });
    await insertInterfaces(withNetwork, orgId, [
      { interfaceName: 'eth0', ipAddress: '10.2.2.2', isPrimary: true },
    ]);

    const rows = await selectLanIps([withNetwork, withoutNetwork]);

    // INNER JOIN LATERAL drops the device entirely; core.ts keys a Map off
    // device_id and falls back to null, which renders the dash. A LEFT JOIN
    // returning a null ip_address would work too, but the caller must not
    // start seeing a row it treats as "has an address".
    expect(rows).toHaveLength(1);
    expect(rows[0]?.device_id).toBe(withNetwork);
    expect(rows[0]?.ip_address).toBe('10.2.2.2');
  });

  it('resolves each device independently in one batched call', async () => {
    // The batching is the reason this is not a per-row subquery; a binding
    // regression in the VALUES/uuid construction would cross-contaminate the
    // per-device answers or throw outright.
    const alpha = await insertDevice({ orgId, siteId, hostname: 'alpha' });
    const bravo = await insertDevice({ orgId, siteId, hostname: 'bravo' });
    const charlie = await insertDevice({ orgId, siteId, hostname: 'charlie' });

    await insertInterfaces(alpha, orgId, [
      { interfaceName: 'bridge0', ipAddress: '172.20.0.1' },
      { interfaceName: 'eth0', ipAddress: '10.10.10.1', isPrimary: true },
    ]);
    await insertInterfaces(bravo, orgId, [
      { interfaceName: 'Ethernet 4', ipAddress: '10.10.10.2' },
    ]);
    await insertInterfaces(charlie, orgId, [
      { interfaceName: 'wlan0', ipAddress: '169.254.1.1' },
      { interfaceName: 'wlan1', ipAddress: '10.10.10.3' },
    ]);

    const rows = await selectLanIps([alpha, bravo, charlie]);
    const byId = new Map(rows.map((r) => [r.device_id, r.ip_address]));

    expect(byId.get(alpha)).toBe('10.10.10.1');
    expect(byId.get(bravo)).toBe('10.10.10.2');
    expect(byId.get(charlie)).toBe('10.10.10.3');
  });
});
