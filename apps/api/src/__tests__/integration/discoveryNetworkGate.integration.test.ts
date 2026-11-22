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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';

// Seams (plan "Integration proofs"): the relay is replaced, so "no command sent" means dispatchCommandToAgent was
// not called; the topology snapshot is skipped; the builder and the decrypt helpers are pass-through spies.
const relay = vi.hoisted(() => ({
  isAgentConnectedAnywhere: vi.fn(async (_agentId: string) => true),
  dispatchCommandToAgent: vi.fn(async (_agentId: string, _command: { id: string; type: string; payload: Record<string, unknown> }) =>
    ({ status: 'sent' as const, via: 'local' as const })),
}));
const spies = vi.hoisted(() => ({ build: vi.fn(), decryptCommunities: vi.fn(), decryptCredentials: vi.fn() }));
vi.mock('../../services/agentCommandRelay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/agentCommandRelay')>()),
  isAgentConnectedAnywhere: relay.isAgentConnectedAnywhere,
  dispatchCommandToAgent: relay.dispatchCommandToAgent,
}));
vi.mock('../../services/topology/discoveryDispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/topology/discoveryDispatch')>()),
  prepareDiscoveryTopologyDispatch: vi.fn(async () => null),
}));
vi.mock('../../services/learnedNetworks/scanCommand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/learnedNetworks/scanCommand')>();
  spies.build.mockImplementation(actual.buildDiscoveryScanCommand);
  return { ...actual, buildDiscoveryScanCommand: spies.build };
});
vi.mock('../../services/snmpSecrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/snmpSecrets')>();
  spies.decryptCommunities.mockImplementation(actual.decryptSnmpCommunities);
  spies.decryptCredentials.mockImplementation(actual.decryptSnmpCredentials);
  return { ...actual, decryptSnmpCommunities: spies.decryptCommunities, decryptSnmpCredentials: spies.decryptCredentials };
});

import { db, withSystemDbAccessContext } from '../../db';
import { __testables, processResults } from '../../jobs/discoveryWorker';
import { lockSitesForNetworkGate } from '../../services/learnedNetworks/siteLock';
import {
  explainGuardedAgent, explainNoEligibleAgent, loadEligibleGuardedAgents,
} from '../../services/learnedNetworks/eligibility';
import { loadNetworkGateways } from '../../services/learnedNetworks/siteNetworks';
import { loadUsableGrantGateways } from '../../services/learnedNetworks/snmpGrants';
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

type JobRow = { status: string; agentId: string | null; errors: Record<string, unknown> | null; networkDispatch: Record<string, unknown> | null;
  networkId: string | null; crossNetworkAssetUpdates: number | null };
async function job(jobId: string): Promise<JobRow> {
  const [row] = await admin<{ status: string; agent_id: string | null; errors: Record<string, unknown> | null;
    network_dispatch: Record<string, unknown> | null; network_id: string | null; cross_network_asset_updates: number | null }>(sql`
    SELECT status, agent_id, errors, network_dispatch, network_id, cross_network_asset_updates
      FROM discovery_jobs WHERE id = ${jobId}::uuid`);
  return { status: row!.status, agentId: row!.agent_id, errors: row!.errors, networkDispatch: row!.network_dispatch,
    networkId: row!.network_id, crossNetworkAssetUpdates: row!.cross_network_asset_updates };
}

const dispatchData = (t: Scope, profileId: string, jobId: string) =>
  ({ type: 'dispatch-scan' as const, jobId, profileId, orgId: t.orgId, siteId: t.siteId });

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

// ---------------------------------------------------------------------------------------------------------
// E5 / E11: the gate's reads
// ---------------------------------------------------------------------------------------------------------

describe('gate reads', () => {
  it('loadNetworkGateways returns host addresses and lower-case MACs, by network then gateway', async () => {
    const t = await seedSite();
    const { networkIds, gatewayIds } = await gateSite(t.orgId, t.siteId, [[G1, G3]]);
    const out = await sys(() => loadNetworkGateways(t.orgId, networkIds));
    expect(out).toEqual([
      { networkId: networkIds[0], gatewayId: gatewayIds[0]![0], address: G1.address, mac: G1.mac },
      { networkId: networkIds[0], gatewayId: gatewayIds[0]![1], address: G3.address, mac: G3.mac },
    ].sort((a, b) => (a.gatewayId! < b.gatewayId! ? -1 : 1)));
    expect(out.every((g) => !g.address.includes('/'))).toBe(true);
  });

  it('loadUsableGrantGateways returns only grants whose network is assigned to the site, and with networkId only its own', async () => {
    const t = await seedSite();
    const { networkIds, gatewayIds } = await gateSite(t.orgId, t.siteId, [[G1], [G3]]);
    const loose = await unassignedNetwork(t.orgId, [G2]);
    const profileId = await seedProfile({
      orgId: t.orgId, siteId: t.siteId, withSecrets: true, grantMode: 'bound',
      grantGatewayIds: [gatewayIds[0]![0]!, gatewayIds[1]![0]!, loose.gatewayIds[0]!],
    });
    const all = await sys(() => loadUsableGrantGateways({ orgId: t.orgId, profileId, siteId: t.siteId, networkId: null }));
    expect(all.map((g) => g.gatewayId).sort()).toEqual([gatewayIds[0]![0]!, gatewayIds[1]![0]!].sort());
    const narrowed = await sys(() => loadUsableGrantGateways({ orgId: t.orgId, profileId, siteId: t.siteId, networkId: networkIds[1]! }));
    expect(narrowed).toEqual([{ networkId: networkIds[1], gatewayId: gatewayIds[1]![0], address: G3.address, mac: G3.mac }]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Dispatch and results (E8, E9, E10)
// ---------------------------------------------------------------------------------------------------------

describe('dispatch and results', () => {
  beforeEach(() => {
    relay.dispatchCommandToAgent.mockClear();
    relay.dispatchCommandToAgent.mockImplementation(async () => ({ status: 'sent', via: 'local' }));
    relay.isAgentConnectedAnywhere.mockClear();
    spies.build.mockClear(); spies.decryptCommunities.mockClear(); spies.decryptCredentials.mockClear();
  });

  // Task 7
  it('gated site with no eligible agent sends no command', async () => {
    const t = await seedSite();
    const { gatewayIds } = await gateSite(t.orgId, t.siteId, [[G1]]);
    const g2 = (await unassignedNetwork(t.orgId, [G2])).gatewayIds[0]!;
    await seedAgent({ ...t, hostname: 'LAPTOP-JS', behind: [g2] });
    await seedAgent({ ...t, hostname: 'DESKTOP-01', version: '0.128.0', behind: [gatewayIds[0]![0]!] });
    const profileId = await seedProfile(t);
    const jobId = await seedJob(t.orgId, t.siteId, profileId);

    const r = await __testables.processDispatchScan(dispatchData(t, profileId, jobId));

    expect(r.dispatched).toBe(false);
    expect(relay.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(await job(jobId)).toMatchObject({ status: 'failed', networkDispatch: null,
      errors: { code: 'no_agent_on_network', reason: 'agents_need_update' } });
  });

  // Task 7
  it('ungated site: worker scan unchanged', async () => {
    for (const version of ['0.128.0', 'dev']) {
      const t = await seedSite();
      const { agentId } = await seedAgent({ ...t, hostname: 'DESKTOP-01', version });
      const profileId = await seedProfile({ ...t, withSecrets: true });
      const jobId = await seedJob(t.orgId, t.siteId, profileId);

      await __testables.processDispatchScan(dispatchData(t, profileId, jobId));

      const [sentTo, cmd] = relay.dispatchCommandToAgent.mock.calls.at(-1)!;
      expect(sentTo).toBe(agentId);
      expect(cmd.type).toBe('network_discovery');
      expect(Object.keys(cmd.payload).sort()).toEqual(['concurrency', 'deepScan', 'excludeIps', 'identifyOS', 'jobId', 'methods',
        'portRanges', 'resolveHostnames', 'snmpCommunities', 'snmpCredentials', 'subnets', 'timeout']);
      expect(cmd.payload.snmpCommunities).toEqual(['public-fixture']);
      expect(await job(jobId)).toMatchObject({ status: 'running', agentId,
        networkDispatch: { version: 1, mode: 'unrestricted', agentId, allowedGatewayIds: [], allowedNetworkIds: [] } });
    }
  });

  // Task 7
  it('a bound credentialed profile is sent only guarded, behind a granted fingerprint', async () => {
    // (a) site not gated; a grant on G1 of a network that is not assigned to the site: fails closed (contract note 1).
    const a = await seedSite();
    const loose = await unassignedNetwork(a.orgId, [G1]);
    await seedAgent({ ...a, hostname: 'LAPTOP-JS', behind: [loose.gatewayIds[0]!] });
    const profileA = await seedProfile({ ...a, withSecrets: true, grantMode: 'bound', grantGatewayIds: [loose.gatewayIds[0]!] });
    const jobA = await seedJob(a.orgId, a.siteId, profileA);

    expect((await __testables.processDispatchScan(dispatchData(a, profileA, jobA))).dispatched).toBe(false);
    expect(await job(jobA)).toMatchObject({ status: 'failed', errors: { code: 'credentials_need_reentry' } });
    expect(spies.build).not.toHaveBeenCalled();
    expect(spies.decryptCommunities).not.toHaveBeenCalled();
    expect(spies.decryptCredentials).not.toHaveBeenCalled();
    expect(relay.dispatchCommandToAgent).not.toHaveBeenCalled();

    // (b) gated with N1 = {G1, G3}; the grant is on G1 only. DESKTOP-01 (behind G3) would rank first by id.
    const b = await seedSite();
    const { networkIds, gatewayIds } = await gateSite(b.orgId, b.siteId, [[G1, G3]]);
    const [g1, g3] = gatewayIds[0]!;
    const laptop = await seedAgent({ ...b, hostname: 'LAPTOP-JS', behind: [g1!] });
    await seedAgent({ ...b, hostname: 'DESKTOP-01', behind: [g3!], deviceId: lowDeviceId() });
    const profileB = await seedProfile({ ...b, withSecrets: true, grantMode: 'bound', grantGatewayIds: [g1!] });
    const jobB = await seedJob(b.orgId, b.siteId, profileB);

    expect((await __testables.processDispatchScan(dispatchData(b, profileB, jobB))).dispatched).toBe(true);
    expect(relay.dispatchCommandToAgent).toHaveBeenCalledTimes(1);
    const [sentTo, cmd] = relay.dispatchCommandToAgent.mock.calls[0]!;
    expect(sentTo).toBe(laptop.agentId);
    expect(cmd.type).toBe('network_discovery_guarded');
    expect((cmd.payload.expectedNetwork as { gateways: Array<{ gatewayId: string }> }).gateways.map((g) => g.gatewayId)).toEqual([g1]);
    expect(await job(jobB)).toMatchObject({ status: 'running', agentId: laptop.agentId,
      networkDispatch: { mode: 'guarded', deviceId: laptop.deviceId, allowedGatewayIds: [g1], allowedNetworkIds: networkIds } });
  });

  // Task 7
  it('a guarded pinned agent that is not eligible fails naming it, with no fallback', async () => {
    const t = await seedSite();
    const { gatewayIds } = await gateSite(t.orgId, t.siteId, [[G1]]);
    const g1 = gatewayIds[0]![0]!;
    const desktop = await seedAgent({ ...t, hostname: 'DESKTOP-01', status: 'offline', behind: [g1] });
    await seedAgent({ ...t, hostname: 'LAPTOP-JS', behind: [g1] });
    const profileId = await seedProfile({ ...t, pinnedDeviceId: desktop.deviceId });
    const jobId = await seedJob(t.orgId, t.siteId, profileId);

    expect((await __testables.processDispatchScan(dispatchData(t, profileId, jobId))).dispatched).toBe(false);
    expect(relay.dispatchCommandToAgent).not.toHaveBeenCalled();
    const row = await job(jobId);
    expect(row).toMatchObject({ status: 'failed', errors: { code: 'agent_not_eligible', reason: 'offline' } });
    expect(String(row.errors?.message)).toContain('"DESKTOP-01"');
  });
});

// ---------------------------------------------------------------------------------------------------------
// processResults: verify in the storing transaction, stamp the network (Task 11)
// ---------------------------------------------------------------------------------------------------------

/** A running job with this attempt record, as recordDispatchAttempt writes it. */
async function runningJob(t: Scope, profileId: string, record: Record<string, unknown> | null): Promise<string> {
  const jobId = await seedJob(t.orgId, t.siteId, profileId);
  await admin(sql`UPDATE discovery_jobs SET status = 'running', started_at = now(),
    network_dispatch = ${record === null ? null : JSON.stringify(record)}::jsonb WHERE id = ${jobId}::uuid`);
  return jobId;
}

const guardedRecord = (agentId: string, deviceId: string, networkIds: string[], gatewayIds: string[]) => ({
  version: 1, mode: 'guarded', agentId, deviceId, allowedNetworkIds: networkIds, allowedGatewayIds: gatewayIds,
  decidedAt: new Date().toISOString(),
});

const verifiedFor = (networkId: string, gatewayId: string, g: { address: string; mac: string }) => ({
  networkId, gatewayId, gatewayAddress: g.address, gatewayMac: g.mac, interfaceName: 'Ethernet',
});

const host = (ip: string) => ({ ip, assetType: 'printer', methods: ['ping'] });

async function assets(orgId: string) {
  return admin<{ ip: string; last_network_id: string | null }>(sql`
    SELECT host(ip_address) AS ip, last_network_id FROM discovered_assets WHERE org_id = ${orgId}::uuid ORDER BY ip_address`);
}

async function seedAsset(t: Scope, ip: string, lastNetworkId: string | null, seenDaysAgo: number) {
  await admin(sql`INSERT INTO discovered_assets (org_id, site_id, ip_address, asset_type, last_network_id, last_seen_at)
    VALUES (${t.orgId}::uuid, ${t.siteId}::uuid, ${ip}::inet, 'printer', ${lastNetworkId}::uuid,
            now() - make_interval(days => ${seenDaysAgo}))`);
}

describe('process results', () => {
  async function guardedScene() {
    const t = await seedSite();
    const { networkIds, gatewayIds } = await gateSite(t.orgId, t.siteId, [[G1]]);
    const agent = await seedAgent({ ...t, hostname: 'LAPTOP-JS', behind: [gatewayIds[0]![0]!] });
    const profileId = await seedProfile(t);
    const n1 = networkIds[0]!; const g1 = gatewayIds[0]![0]!;
    const jobId = await runningJob(t, profileId, guardedRecord(agent.agentId, agent.deviceId, [n1], [g1]));
    return { t, n1, g1, profileId, jobId };
  }
  const resultsFor = (t: Scope, profileId: string, jobId: string, hosts: ReturnType<typeof host>[], verifiedNetwork?: unknown) =>
    ({ type: 'process-results' as const, jobId, profileId, ...t, hosts, hostsScanned: hosts.length, hostsDiscovered: hosts.length,
      ...(verifiedNetwork ? { verifiedNetwork: verifiedNetwork as ReturnType<typeof verifiedFor> } : {}) });

  it('a guarded result admitted earlier stores nothing when its fingerprint was unassigned before storing', async () => {
    const { t, n1, g1, profileId, jobId } = await guardedScene();
    await admin(sql`UPDATE learned_networks SET site_id = NULL WHERE id = ${n1}::uuid`);

    const out = await sys(() => processResults(resultsFor(t, profileId, jobId, [host('192.168.1.20')], verifiedFor(n1, g1, G1))));

    expect(out).toMatchObject({ newAssets: 0, updatedAssets: 0 });
    expect(await assets(t.orgId)).toEqual([]);
    expect(await job(jobId)).toMatchObject({ status: 'failed', errors: { code: 'network_unverified' } });
  });

  it('a verified guarded result sets the job network and stamps every asset it writes', async () => {
    const { t, n1, g1, profileId, jobId } = await guardedScene();
    await seedAsset(t, '192.168.1.21', null, 1);

    const out = await sys(() => processResults(resultsFor(t, profileId, jobId,
      [host('192.168.1.20'), host('192.168.1.21')], verifiedFor(n1, g1, G1))));

    expect(out).toMatchObject({ newAssets: 1, updatedAssets: 1 });
    expect(await assets(t.orgId)).toEqual([
      { ip: '192.168.1.20', last_network_id: n1 },
      { ip: '192.168.1.21', last_network_id: n1 },
    ]);
    expect(await job(jobId)).toMatchObject({ status: 'completed', networkId: n1, crossNetworkAssetUpdates: 0 });
  });

  it('counts updated assets a guarded scan last saw on another network within 30 days', async () => {
    const { t, n1, g1, profileId, jobId } = await guardedScene();
    const n2 = (await unassignedNetwork(t.orgId, [G3])).networkId;
    await seedAsset(t, '192.168.1.31', n2, 3);
    await seedAsset(t, '192.168.1.32', n2, 40);
    await seedAsset(t, '192.168.1.33', n1, 3);
    await seedAsset(t, '192.168.1.34', null, 3);

    await sys(() => processResults(resultsFor(t, profileId, jobId,
      ['192.168.1.31', '192.168.1.32', '192.168.1.33', '192.168.1.34'].map(host), verifiedFor(n1, g1, G1))));

    expect(await job(jobId)).toMatchObject({ status: 'completed', networkId: n1, crossNetworkAssetUpdates: 1 });
    expect((await assets(t.orgId)).every((a) => a.last_network_id === n1)).toBe(true);
  });

  it('an unrestricted result leaves last_network_id and the job network null', async () => {
    const t = await seedSite();
    const agent = await seedAgent({ ...t, hostname: 'DESKTOP-01' });
    const profileId = await seedProfile(t);
    const jobId = await runningJob(t, profileId, {
      version: 1, mode: 'unrestricted', agentId: agent.agentId, deviceId: agent.deviceId,
      allowedNetworkIds: [], allowedGatewayIds: [], decidedAt: new Date().toISOString(),
    });
    await seedAsset(t, '192.168.1.21', null, 1);

    await sys(() => processResults(resultsFor(t, profileId, jobId, [host('192.168.1.20'), host('192.168.1.21')])));

    expect(await assets(t.orgId)).toEqual([
      { ip: '192.168.1.20', last_network_id: null },
      { ip: '192.168.1.21', last_network_id: null },
    ]);
    expect(await job(jobId)).toMatchObject({ status: 'completed', networkId: null, crossNetworkAssetUpdates: null });
  });

  it('an unrestricted result that reaches storage after the site became gated stores nothing', async () => {
    const t = await seedSite();
    const agent = await seedAgent({ ...t, hostname: 'DESKTOP-01' });
    const profileId = await seedProfile(t);
    const jobId = await runningJob(t, profileId, null);
    await gateSite(t.orgId, t.siteId, [[G1]]);

    await sys(() => processResults(resultsFor(t, profileId, jobId, [host('192.168.1.20')])));

    expect(await assets(t.orgId)).toEqual([]);
    expect(await job(jobId)).toMatchObject({ status: 'failed', errors: { code: 'network_unverified' } });
    void agent;
  });
});
