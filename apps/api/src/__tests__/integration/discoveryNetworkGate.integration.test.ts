/**
 * Learned networks W03a (#12369, spec §8.2-8.4): the discovery network gate on real Postgres.
 *
 * Fixtures are written with the superuser handle. The code under test runs through the `breeze_app` pool
 * (forced RLS) inside `withSystemDbAccessContext`, as the worker does. Nothing in this wave can gate a site
 * through a route (W03c), so a test gates one by writing rows: the site flag first, then `learned_networks`
 * with `site_id` (the A6 trigger refuses the other order).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { lockSitesForNetworkGate } from '../../services/learnedNetworks/siteLock';
import { encryptSnmpCommunities } from '../../services/snmpSecrets';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

// ---------------------------------------------------------------------------------------------------------
// Fixtures (synthetic values only: index "Public repository")
// ---------------------------------------------------------------------------------------------------------

/** G1, G2: same address, different router. G3: the second fingerprint of a two-gateway network. */
const G1 = { address: '192.168.1.1', mac: 'a4:2b:b0:11:22:9c' } as const;
const G2 = { address: '192.168.1.1', mac: '3c:37:86:aa:bb:10' } as const;
const G3 = { address: '10.1.2.100', mac: '00:1a:8c:00:00:01' } as const;

const admin = <T = Record<string, unknown>>(query: SQL) => getTestDb().execute(query) as unknown as Promise<T[]>;
const sys = <T>(fn: () => Promise<T>): Promise<T> => withSystemDbAccessContext(fn);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

async function seedSite(): Promise<{ partnerId: string; orgId: string; siteId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id };
}

async function insertNetwork(orgId: string, siteId: string | null, gateways: ReadonlyArray<{ address: string; mac: string }>) {
  const [n] = await admin<{ id: string }>(sql`
    INSERT INTO learned_networks (org_id, site_id, prefix) VALUES (${orgId}::uuid, ${siteId}::uuid, '192.168.1.0/24')
    RETURNING id`);
  const gatewayIds: string[] = [];
  for (const g of gateways) {
    const [row] = await admin<{ id: string }>(sql`
      INSERT INTO learned_network_gateways (org_id, network_id, gateway_address, gateway_mac)
      VALUES (${orgId}::uuid, ${n!.id}::uuid, ${g.address}::inet, ${g.mac}::macaddr) RETURNING id`);
    gatewayIds.push(row!.id);
  }
  return { networkId: n!.id, gatewayIds };
}

/** Gate a site: the flag first, then each network with `site_id`, then its gateways. */
async function gateSite(
  orgId: string, siteId: string, networks: Array<Array<{ address: string; mac: string }>>,
): Promise<{ networkIds: string[]; gatewayIds: string[][] }> {
  await admin(sql`UPDATE sites SET discovery_network_required = true WHERE id = ${siteId}::uuid`);
  const networkIds: string[] = [];
  const gatewayIds: string[][] = [];
  for (const gateways of networks) {
    const n = await insertNetwork(orgId, siteId, gateways);
    networkIds.push(n.networkId);
    gatewayIds.push(n.gatewayIds);
  }
  return { networkIds, gatewayIds };
}

/** An unassigned network of the org (not on any site). */
async function unassignedNetwork(orgId: string, gateways: Array<{ address: string; mac: string }>) {
  return insertNetwork(orgId, null, gateways);
}

async function seedAgent(o: {
  orgId: string; siteId: string; hostname: string; version?: string; status?: 'online' | 'offline';
  isEphemeral?: boolean; tokenSuspended?: boolean; behind?: string[]; isCurrent?: boolean; confirmedAgoMs?: number;
  deviceId?: string;
}): Promise<{ deviceId: string; agentId: string }> {
  const deviceId = o.deviceId ?? randomUUID();
  const agentId = `agent-${randomUUID()}`;
  const confirmedAt = new Date(Date.now() - (o.confirmedAgoMs ?? 0)).toISOString();
  await admin(sql`
    INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version,
                         status, is_ephemeral, agent_token_suspended_at, network_attachments_confirmed_at)
    VALUES (${deviceId}::uuid, ${o.orgId}::uuid, ${o.siteId}::uuid, ${agentId}, ${o.hostname}, 'windows', '11', 'amd64',
            ${o.version ?? '999.0.0'}, ${o.status ?? 'online'}, ${o.isEphemeral ?? false},
            ${o.tokenSuspended ? sql`now()` : sql`NULL`}, ${confirmedAt}::timestamptz)`);
  for (const gatewayId of o.behind ?? []) {
    await admin(sql`
      INSERT INTO learned_network_devices (org_id, device_id, gateway_id, interface_name, local_address, is_primary, is_current)
      VALUES (${o.orgId}::uuid, ${deviceId}::uuid, ${gatewayId}::uuid, 'Ethernet', '192.168.1.57', true, ${o.isCurrent ?? true})`);
  }
  return { deviceId, agentId };
}

async function seedProfile(o: {
  orgId: string; siteId: string; withSecrets?: boolean; grantMode?: 'unrestricted' | 'bound';
  grantGatewayIds?: string[]; pinnedDeviceId?: string; networkId?: string;
}): Promise<string> {
  const communities = o.withSecrets ? encryptSnmpCommunities(['public-fixture']) ?? [] : [];
  const [p] = await admin<{ id: string }>(sql`
    INSERT INTO discovery_profiles (org_id, site_id, name, subnets, methods, snmp_communities, snmp_grant_mode,
                                    pinned_device_id, network_id)
    VALUES (${o.orgId}::uuid, ${o.siteId}::uuid, ${`profile-${randomUUID().slice(0, 8)}`}, ARRAY['192.168.1.0/24']::text[],
            ARRAY['ping']::discovery_method[], ARRAY[${sql.join(communities.map((c) => sql`${c}`), sql`, `)}]::text[],
            ${o.grantMode ?? 'unrestricted'}, ${o.pinnedDeviceId ?? null}::uuid, ${o.networkId ?? null}::uuid)
    RETURNING id`);
  for (const gatewayId of o.grantGatewayIds ?? []) {
    await admin(sql`INSERT INTO discovery_profile_snmp_grants (org_id, profile_id, gateway_id)
      VALUES (${o.orgId}::uuid, ${p!.id}::uuid, ${gatewayId}::uuid)`);
  }
  return p!.id;
}

async function seedJob(orgId: string, siteId: string, profileId: string): Promise<string> {
  const [j] = await admin<{ id: string }>(sql`
    INSERT INTO discovery_jobs (org_id, site_id, profile_id, status, scheduled_at)
    VALUES (${orgId}::uuid, ${siteId}::uuid, ${profileId}::uuid, 'scheduled', now()) RETURNING id`);
  return j!.id;
}

// Referenced by later describes; kept in one place so every test reads the same fixtures.
void G1; void G2; void G3; void gateSite; void unassignedNetwork; void seedAgent; void seedProfile; void seedJob;

// ---------------------------------------------------------------------------------------------------------
// E1: the site lock
// ---------------------------------------------------------------------------------------------------------

describe('site lock', () => {
  it('an exclusive holder blocks a shared taker', async () => {
    const { siteId } = await seedSite();
    const held = deferred(); const release = deferred();
    const holder = sys(async () => {
      await lockSitesForNetworkGate([siteId], 'exclusive'); held.resolve(); await release.promise;
    });
    await held.promise;
    const err = await sys(async () => {
      await db.execute(sql`set local lock_timeout = '200ms'`);
      await lockSitesForNetworkGate([siteId], 'shared');
    }).catch((e) => e);
    expect(pgErrorCode(err)).toBe('55P03');
    release.resolve(); await holder;
  });

  it('two shared takers do not block each other', async () => {
    const { siteId } = await seedSite();
    const held = deferred(); const release = deferred();
    const holder = sys(async () => {
      await lockSitesForNetworkGate([siteId], 'shared'); held.resolve(); await release.promise;
    });
    await held.promise;
    await expect(sys(async () => {
      await db.execute(sql`set local lock_timeout = '200ms'`);
      await lockSitesForNetworkGate([siteId], 'shared');
      return 'taken';
    })).resolves.toBe('taken');
    release.resolve(); await holder;
  });

  it('refuses to run outside a transaction', async () => {
    await expect(lockSitesForNetworkGate([randomUUID()], 'shared')).rejects.toThrow(/lockSitesForNetworkGate must run inside/);
  });
});
