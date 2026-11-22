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
import {
  explainGuardedAgent, explainNoEligibleAgent, loadEligibleGuardedAgents,
} from '../../services/learnedNetworks/eligibility';
import type { IneligibleReason } from '@breeze/shared';
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
  // The admission flag lets the holding-org case seed a parked device (the guard trigger allows only enrollment).
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
    await tx.execute(sql`
      INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version,
                           status, is_ephemeral, agent_token_suspended_at, network_attachments_confirmed_at)
      VALUES (${deviceId}::uuid, ${o.orgId}::uuid, ${o.siteId}::uuid, ${agentId}, ${o.hostname}, 'windows', '11', 'amd64',
              ${o.version ?? '999.0.0'}, ${o.status ?? 'online'}, ${o.isEphemeral ?? false},
              ${o.tokenSuspended ? sql`now()` : sql`NULL`}, ${confirmedAt}::timestamptz)`);
  });
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
void seedProfile; void seedJob;

/** A device id that sorts before any random v4 id: lets a test pin which agent would rank first. */
const lowDeviceId = () => `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;

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

// ---------------------------------------------------------------------------------------------------------
// E6: eligibility
// ---------------------------------------------------------------------------------------------------------

type Scope = { orgId: string; siteId: string };
type Ctx = Scope & {
  site: Scope; otherOrg: Scope; holdingOrg: Scope; otherSite: Scope; g1: string; g2: string; g3: string; n1: string;
};

/** One gated site with N1 = {G1, G3}; G2 on an unassigned network; plus another site, another org and a holding org. */
async function ctx(): Promise<Ctx> {
  const t = await seedSite();
  const { networkIds, gatewayIds } = await gateSite(t.orgId, t.siteId, [[G1, G3]]);
  const g2Net = await unassignedNetwork(t.orgId, [G2]);
  const otherSite = await createSite({ orgId: t.orgId });
  const other = await seedSite();
  const holding = await createOrganization({ partnerId: t.partnerId, type: 'unassigned_pool' });
  const holdingSite = await createSite({ orgId: holding.id });
  return {
    orgId: t.orgId, siteId: t.siteId, site: { orgId: t.orgId, siteId: t.siteId },
    otherOrg: { orgId: other.orgId, siteId: other.siteId }, holdingOrg: { orgId: holding.id, siteId: holdingSite.id },
    otherSite: { orgId: t.orgId, siteId: otherSite.id },
    g1: gatewayIds[0]![0]!, g3: gatewayIds[0]![1]!, g2: g2Net.gatewayIds[0]!, n1: networkIds[0]!,
  };
}

describe('eligibility', () => {
  const cases: Array<[string, (c: Ctx) => Promise<{ deviceId?: string; agentId?: string }>, IneligibleReason]> = [
    ['unknown device', async () => ({ deviceId: randomUUID() }), 'not_found'],
    ['device of another org', async (c) => ({ deviceId: (await seedAgent({ ...c.otherOrg, hostname: 'DESKTOP-01' })).deviceId }), 'not_found'],
    ['device in a holding org', async (c) => ({ deviceId: (await seedAgent({ ...c.holdingOrg, hostname: 'DESKTOP-01' })).deviceId }), 'parked'],
    ['Quick Support device', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'DESKTOP-01', isEphemeral: true, behind: [c.g1] })).deviceId }), 'ephemeral'],
    ['device of another site', async (c) => ({ deviceId: (await seedAgent({ ...c.otherSite, hostname: 'DESKTOP-01', behind: [c.g1] })).deviceId }), 'other_site'],
    ['offline device', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'DESKTOP-01', status: 'offline', behind: [c.g1] })).deviceId }), 'offline'],
    ['online, suspended agent token', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'DESKTOP-01', tokenSuspended: true, behind: [c.g1] })).deviceId }), 'offline'],
    ['old agent behind G1', async (c) => ({ agentId: (await seedAgent({ ...c.site, hostname: 'DESKTOP-01', version: '0.128.0', behind: [c.g1] })).agentId }), 'needs_update'],
    ['unknown version behind G1', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'DESKTOP-01', version: 'dev', behind: [c.g1] })).deviceId }), 'needs_update'],
    ['behind G2 only', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', behind: [c.g2] })).deviceId }), 'not_on_network'],
    ['G1 row not current', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', behind: [c.g1], isCurrent: false })).deviceId }), 'not_on_network'],
    ['G1 confirmed 11 minutes ago', async (c) => ({ deviceId: (await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', behind: [c.g1], confirmedAgoMs: 11 * 60_000 })).deviceId }), 'not_on_network'],
  ];

  it.each(cases)('explainGuardedAgent: %s is %s', async (_n, make, reason) => {
    const c = await ctx(); const target = await make(c);
    const out = await sys(() => explainGuardedAgent({
      orgId: c.orgId, siteId: c.siteId, allowedGatewayIds: [c.g1], commandType: 'network_discovery', ...target,
    }));
    expect(out).toMatchObject({ eligible: false, reason });
  });

  it('explainGuardedAgent never echoes another org\'s device name', async () => {
    const c = await ctx();
    const { deviceId } = await seedAgent({ ...c.otherOrg, hostname: 'DESKTOP-01' });
    const out = await sys(() => explainGuardedAgent({
      orgId: c.orgId, siteId: c.siteId, allowedGatewayIds: [c.g1], commandType: 'network_discovery', deviceId,
    }));
    expect(out).toEqual({ eligible: false, reason: 'not_found', label: deviceId });
  });

  it('explainGuardedAgent: a fresh 999.0.0 agent behind G1 is eligible with its fingerprints', async () => {
    const c = await ctx();
    const a = await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', behind: [c.g1, c.g2] });
    const out = await sys(() => explainGuardedAgent({
      orgId: c.orgId, siteId: c.siteId, allowedGatewayIds: [c.g1, c.g3], commandType: 'network_discovery', agentId: a.agentId,
    }));
    expect(out).toEqual({ eligible: true, agent: {
      deviceId: a.deviceId, agentId: a.agentId, hostname: 'LAPTOP-JS', displayName: null, gatewayIds: [c.g1],
    } });
  });

  it('loadEligibleGuardedAgents returns only eligible agents, by device id, within the limit', async () => {
    const c = await ctx();
    const eligible = [
      await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', behind: [c.g1] }),
      await seedAgent({ ...c.site, hostname: 'DESKTOP-01', behind: [c.g3, c.g1] }),
      await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', version: '999.0.0-rc.1', behind: [c.g3] }),
    ];
    // every ineligible shape of the table above that lives in this site
    await seedAgent({ ...c.site, hostname: 'DESKTOP-01', isEphemeral: true, behind: [c.g1] });
    await seedAgent({ ...c.site, hostname: 'DESKTOP-01', status: 'offline', behind: [c.g1] });
    await seedAgent({ ...c.site, hostname: 'DESKTOP-01', tokenSuspended: true, behind: [c.g1] });
    await seedAgent({ ...c.site, hostname: 'DESKTOP-01', version: '0.128.0', behind: [c.g1] });
    await seedAgent({ ...c.site, hostname: 'DESKTOP-01', version: 'dev', behind: [c.g1] });
    await seedAgent({ ...c.site, hostname: 'DESKTOP-01', version: '1.2.3.4', behind: [c.g1] });
    await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', behind: [c.g2] });
    await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', behind: [c.g1], isCurrent: false });
    await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', behind: [c.g1], confirmedAgoMs: 11 * 60_000 });
    await seedAgent({ ...c.otherSite, hostname: 'LAPTOP-JS', behind: [c.g1] });
    const input = { orgId: c.orgId, siteId: c.siteId, allowedGatewayIds: [c.g1, c.g3], commandType: 'network_discovery' as const };

    const all = await sys(() => loadEligibleGuardedAgents(input));
    const byId = [...eligible].sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
    expect(all.map((a) => a.deviceId)).toEqual(byId.map((a) => a.deviceId));
    const desktop = all.find((a) => a.deviceId === eligible[1]!.deviceId)!;
    expect(desktop.gatewayIds).toEqual([c.g1, c.g3].sort());

    const one = await sys(() => loadEligibleGuardedAgents({ ...input, limit: 1 }));
    expect(one.map((a) => a.deviceId)).toEqual([byId[0]!.deviceId]);
    expect(await sys(() => loadEligibleGuardedAgents({ ...input, allowedGatewayIds: [] }))).toEqual([]);
  });

  it('explainNoEligibleAgent distinguishes none online, none on the network and agents that need updating', async () => {
    const explain = (c: Ctx) => sys(() => explainNoEligibleAgent({
      orgId: c.orgId, siteId: c.siteId, allowedGatewayIds: [c.g1], commandType: 'network_discovery',
    }));
    const empty = await ctx();
    await seedAgent({ ...empty.site, hostname: 'DESKTOP-01', status: 'offline', behind: [empty.g1] });
    expect(await explain(empty)).toBe('none_online');

    const suspended = await ctx();
    await seedAgent({ ...suspended.site, hostname: 'DESKTOP-01', tokenSuspended: true, behind: [suspended.g1] });
    expect(await explain(suspended)).toBe('none_online');

    const elsewhere = await ctx();
    await seedAgent({ ...elsewhere.site, hostname: 'LAPTOP-JS', behind: [elsewhere.g2] });
    await seedAgent({ ...elsewhere.site, hostname: 'DESKTOP-01', behind: [elsewhere.g2] });
    expect(await explain(elsewhere)).toBe('none_on_network');

    const old = await ctx();
    await seedAgent({ ...old.site, hostname: 'LAPTOP-JS', behind: [old.g2] });
    await seedAgent({ ...old.site, hostname: 'DESKTOP-01', version: '0.128.0', behind: [old.g1] });
    expect(await explain(old)).toBe('agents_need_update');

    const unknown = await ctx();
    await seedAgent({ ...unknown.site, hostname: 'LAPTOP-JS', version: 'dev', behind: [unknown.g2] });
    await seedAgent({ ...unknown.site, hostname: 'DESKTOP-01', version: 'dev' });
    expect(await explain(unknown)).toBe('agents_need_update');
  });

  it('S6 eligibility matches the fingerprint', async () => {
    const c = await ctx();
    const desktop = await seedAgent({ ...c.site, hostname: 'DESKTOP-01', behind: [c.g3], deviceId: lowDeviceId() });
    await seedAgent({ ...c.site, hostname: 'LAPTOP-JS', behind: [c.g1] });
    const eligible = await sys(() => loadEligibleGuardedAgents({
      orgId: c.orgId, siteId: c.siteId, allowedGatewayIds: [c.g1], commandType: 'network_discovery',
    }));
    expect(eligible.map((a) => a.hostname)).toEqual(['LAPTOP-JS']);
    expect(await sys(() => explainGuardedAgent({
      orgId: c.orgId, siteId: c.siteId, allowedGatewayIds: [c.g1], commandType: 'network_discovery', deviceId: desktop.deviceId,
    }))).toMatchObject({ eligible: false, reason: 'not_on_network' });
  });
});
