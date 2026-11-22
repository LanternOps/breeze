/**
 * Learned networks W03b (#12369, spec §8.3): saved SNMP credentials follow the gateway fingerprints they were
 * entered for, on real Postgres.
 *
 * Every credential assertion drives `evaluateDiscoveryGate` for the profile (the decision dispatch makes) and
 * asserts what it allows: `unrestricted`, `guarded` with an exact fingerprint set, or `credentials_need_reentry`.
 * A grants-table assertion alone is never the proof.
 *
 * Fixtures are written with the superuser handle. Nothing in this wave can gate a site through a route (W03c), so a
 * test gates one by writing rows: the site flag first, then `learned_networks.site_id` (the A6 trigger refuses the
 * other order). Profile saves go through the real router (`breeze_app`, forced RLS, one request transaction).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';

import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { discoveryProfiles } from '../../db/schema';
import { discoveryRoutes } from '../../routes/discovery';
import { evaluateDiscoveryGate, gateProfileFromRow, type GateDecision } from '../../services/learnedNetworks/gate';
import { lockSitesForNetworkGate } from '../../services/learnedNetworks/siteLock';
import { bindUnrestrictedProfilesOnGating } from '../../services/learnedNetworks/snmpGrants';
import { decryptSnmpCommunities, encryptSnmpCommunities } from '../../services/snmpSecrets';
import { createAccessToken } from '../../services/jwt';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { orgContext } from './topology-fixtures';

// ---------------------------------------------------------------------------------------------------------
// Fixtures (synthetic values only: plan index "Public repository")
// ---------------------------------------------------------------------------------------------------------

const MASK = '********';
const V3_A = { version: 'v3', username: 'poller', authPassphrase: 'auth-a', privacyPassphrase: 'priv-a' };
const V3_MASKED = { version: 'v3', username: 'poller', authPassphrase: MASK, privacyPassphrase: MASK };

type Client = { post: (path: string, body: unknown) => Promise<Response>; patch: (path: string, body: unknown) => Promise<Response> };

type Fixture = {
  client: Client;
  orgId: string; actorUserId: string;
  siteA: string; siteB: string; siteC: string; siteD: string; siteE: string;
  N_A: string; N_A2: string; N_B: string; N_C: string; otherOrgNetwork: string;
  G_A: string; G_A2: string; G_B: string; G_C: string;
};

let fx: Fixture;

const admin = <T = Record<string, unknown>>(query: SQL) => getTestDb().execute(query) as unknown as Promise<T[]>;

async function insertNetwork(
  orgId: string, siteId: string | null, prefix: string, gateway: { address: string; mac: string },
): Promise<{ networkId: string; gatewayId: string }> {
  const [n] = await admin<{ id: string }>(sql`
    INSERT INTO learned_networks (org_id, site_id, prefix) VALUES (${orgId}::uuid, ${siteId}::uuid, ${prefix}::cidr)
    RETURNING id`);
  const [g] = await admin<{ id: string }>(sql`
    INSERT INTO learned_network_gateways (org_id, network_id, gateway_address, gateway_mac)
    VALUES (${orgId}::uuid, ${n!.id}::uuid, ${gateway.address}::inet, ${gateway.mac}::macaddr) RETURNING id`);
  return { networkId: n!.id, gatewayId: g!.id };
}

async function setGated(siteId: string): Promise<void> {
  await admin(sql`UPDATE sites SET discovery_network_required = true WHERE id = ${siteId}::uuid`);
}

/** Flag first, then `site_id`, in one transaction (the A6 trigger order). */
async function gateSiteAndAssign(siteId: string, networkId: string): Promise<void> {
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`UPDATE sites SET discovery_network_required = true WHERE id = ${siteId}::uuid`);
    await tx.execute(sql`UPDATE learned_networks SET site_id = ${siteId}::uuid WHERE id = ${networkId}::uuid`);
  });
}

async function buildFixture(): Promise<Fixture> {
  const app = new Hono();
  app.route('/discovery', discoveryRoutes);
  const env = await setupTestEnvironment();
  // Both profile routes are behind requireMfa: the fixture session has satisfied it.
  const token = await createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: env.organization.id, partnerId: env.partner.id,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const send = (method: string) => (path: string, body: unknown) => app.request(path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const client: Client = { post: send('POST'), patch: send('PATCH') };
  const orgId = env.organization.id;
  const siteA = env.site.id;
  const [siteB, siteC, siteD, siteE] = await Promise.all([1, 2, 3, 4].map(async () => (await createSite({ orgId })).id));

  await setGated(siteA);
  const a = await insertNetwork(orgId, siteA, '192.168.1.0/24', { address: '192.168.1.1', mac: 'a4:2b:b0:11:22:9c' });
  const a2 = await insertNetwork(orgId, siteA, '10.1.2.0/24', { address: '10.1.2.100', mac: '00:1a:8c:00:00:01' });
  await setGated(siteB!);
  const b = await insertNetwork(orgId, siteB!, '192.168.1.0/24', { address: '192.168.1.1', mac: '3c:37:86:aa:bb:10' });
  const c = await insertNetwork(orgId, null, '192.168.1.0/24', { address: '192.168.1.1', mac: '00:1a:8c:00:00:01' });
  await setGated(siteE!);

  const otherOrg = await createOrganization({ partnerId: env.partner.id });
  const other = await insertNetwork(otherOrg.id, null, '192.168.1.0/24', { address: '192.168.1.1', mac: 'a4:2b:b0:11:22:9c' });

  return {
    client, orgId, actorUserId: env.user.id,
    siteA, siteB: siteB!, siteC: siteC!, siteD: siteD!, siteE: siteE!,
    N_A: a.networkId, N_A2: a2.networkId, N_B: b.networkId, N_C: c.networkId, otherOrgNetwork: other.networkId,
    G_A: a.gatewayId, G_A2: a2.gatewayId, G_B: b.gatewayId, G_C: c.gatewayId,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

const inSystemTx = <T>(fn: () => Promise<T>): Promise<T> => runOutsideDbContext(() => withSystemDbAccessContext(fn));

async function profileRow(profileId: string): Promise<typeof discoveryProfiles.$inferSelect> {
  const [row] = await (getTestDb() as any).select().from(discoveryProfiles).where(eq(discoveryProfiles.id, profileId));
  if (!row) throw new Error(`profile ${profileId} not found`);
  return row;
}

/** The live profile under the shared site lock in the org's RLS context, evaluated as dispatch evaluates it. */
async function gateFor(profileId: string): Promise<GateDecision> {
  return runOutsideDbContext(() => withDbAccessContext(orgContext(fx.orgId), async () => {
    const [row] = await db.select().from(discoveryProfiles).where(eq(discoveryProfiles.id, profileId)).limit(1);
    if (!row) throw new Error(`profile ${profileId} not visible`);
    await lockSitesForNetworkGate([row.siteId], 'shared');
    return evaluateDiscoveryGate({ orgId: row.orgId, siteId: row.siteId, profile: gateProfileFromRow(row) });
  }));
}

/** guarded: the allowed gateway ids, sorted; fail: the error code; unrestricted: 'unrestricted'. */
const allowed = (d: GateDecision): string[] | string =>
  d.kind === 'guarded' ? d.allowed.map((g) => g.gatewayId).sort() : d.kind === 'fail' ? d.error.code : d.kind;

async function grantRows(profileId: string): Promise<string[]> {
  const rows = await admin<{ gateway_id: string }>(sql`
    SELECT gateway_id FROM discovery_profile_snmp_grants WHERE profile_id = ${profileId}::uuid`);
  return rows.map((r) => r.gateway_id).sort();
}

async function storedCommunities(profileId: string): Promise<string[]> {
  return decryptSnmpCommunities((await profileRow(profileId)).snmpCommunities);
}

async function createProfile(o: {
  siteId: string; snmpCommunities?: string[]; snmpCredentials?: unknown; networkId?: string | null;
}): Promise<string> {
  const res = await fx.client.post('/discovery/profiles', {
    siteId: o.siteId, name: `p-${Math.random().toString(36).slice(2, 8)}`,
    subnets: ['192.168.1.0/24'], methods: ['ping', 'snmp'], schedule: { type: 'manual' },
    ...(o.snmpCommunities !== undefined ? { snmpCommunities: o.snmpCommunities } : {}),
    ...(o.snmpCredentials !== undefined ? { snmpCredentials: o.snmpCredentials } : {}),
    ...(o.networkId !== undefined ? { networkId: o.networkId } : {}),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

/** A profile written directly (no route): for states a route cannot produce in this wave. */
async function insertProfileDirect(o: {
  siteId: string; communities?: string[]; mode?: 'unrestricted' | 'bound'; networkId?: string | null;
}): Promise<string> {
  const [row] = await (getTestDb() as any).insert(discoveryProfiles).values({
    orgId: fx.orgId, siteId: o.siteId, name: `direct-${Math.random().toString(36).slice(2, 8)}`,
    subnets: ['192.168.1.0/24'], methods: ['ping'],
    snmpCommunities: encryptSnmpCommunities(o.communities ?? []) ?? [],
    snmpGrantMode: o.mode ?? 'unrestricted', networkId: o.networkId ?? null,
  }).returning({ id: discoveryProfiles.id });
  return row.id;
}

beforeEach(async () => {
  fx = await buildFixture();
});

// ---------------------------------------------------------------------------------------------------------
// Service level: rule 2, and rule 1 on create
// ---------------------------------------------------------------------------------------------------------

describe('W03b grant rules', () => {
  it('runs the code under test as breeze_app (forced RLS is real here)', async () => {
    const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.execute<{ current_user: string }>(sql`SELECT current_user`)));
    expect(row!.current_user).toBe('breeze_app');
  });

  it('rule 2 binds unrestricted credentialed profiles to the gating network', async () => {
    const P1 = await insertProfileDirect({ siteId: fx.siteC, communities: ['public-a'] });
    const P2 = await insertProfileDirect({ siteId: fx.siteC });
    const P3 = await insertProfileDirect({ siteId: fx.siteC, communities: ['public-a'], mode: 'bound' });
    expect(allowed(await gateFor(P1))).toBe('unrestricted');

    await gateSiteAndAssign(fx.siteC, fx.N_C);
    const n = await inSystemTx(async () => {
      await lockSitesForNetworkGate([fx.siteC], 'exclusive');
      return bindUnrestrictedProfilesOnGating({ orgId: fx.orgId, siteId: fx.siteC, networkId: fx.N_C, actorUserId: fx.actorUserId });
    });

    expect(n).toBe(1);
    expect(allowed(await gateFor(P1))).toEqual([fx.G_C]);
    expect(allowed(await gateFor(P3))).toBe('credentials_need_reentry');
    expect((await profileRow(P2)).snmpGrantMode).toBe('unrestricted');
    expect(await grantRows(P2)).toEqual([]);
  });

  it('rule 2 gives a profile pointed at another network bound with no grants', async () => {
    // A profile on C narrowed to a network that is not the one being assigned (admin write: no route can do it).
    const other = await insertNetwork(fx.orgId, null, '10.1.2.0/24', { address: '10.1.2.100', mac: '3c:37:86:aa:bb:10' });
    await gateSiteAndAssign(fx.siteC, other.networkId);
    const P = await insertProfileDirect({ siteId: fx.siteC, communities: ['public-a'], networkId: other.networkId });
    await admin(sql`UPDATE learned_networks SET site_id = ${fx.siteC}::uuid WHERE id = ${fx.N_C}::uuid`);

    const n = await inSystemTx(async () => {
      await lockSitesForNetworkGate([fx.siteC], 'exclusive');
      return bindUnrestrictedProfilesOnGating({ orgId: fx.orgId, siteId: fx.siteC, networkId: fx.N_C, actorUserId: fx.actorUserId });
    });

    expect(n).toBe(1);
    expect((await profileRow(P)).snmpGrantMode).toBe('bound');
    expect(await grantRows(P)).toEqual([]);
    expect(allowed(await gateFor(P))).toBe('credentials_need_reentry');
  });

  it('rule 1 on a site that is not gated leaves the profile unrestricted with no grants', async () => {
    const id = await createProfile({ siteId: fx.siteD, snmpCommunities: ['public-a'] });
    expect((await profileRow(id)).snmpGrantMode).toBe('unrestricted');
    expect(await grantRows(id)).toEqual([]);
    expect(allowed(await gateFor(id))).toBe('unrestricted');
  });

  it('a profile created with secrets on a gated site with no network is bound with no grants', async () => {
    const id = await createProfile({ siteId: fx.siteE, snmpCommunities: ['public-a'] });
    expect((await profileRow(id)).snmpGrantMode).toBe('bound');
    expect(allowed(await gateFor(id))).toBe('credentials_need_reentry');
  });

  it('a profile created with secrets on a gated site is bound to every assigned fingerprint', async () => {
    const id = await createProfile({ siteId: fx.siteA, snmpCommunities: ['public-a'], snmpCredentials: V3_A });
    expect((await profileRow(id)).snmpGrantMode).toBe('bound');
    expect(allowed(await gateFor(id))).toEqual([fx.G_A, fx.G_A2].sort());
  });

  it('a profile created without secrets is unaffected', async () => {
    const id = await createProfile({ siteId: fx.siteD });
    expect((await profileRow(id)).snmpGrantMode).toBe('unrestricted');
    expect(await grantRows(id)).toEqual([]);
    expect(allowed(await gateFor(id))).toBe('unrestricted');
  });
});

// ---------------------------------------------------------------------------------------------------------
// Credential sequences through the real router (spec 15 credential rows)
// ---------------------------------------------------------------------------------------------------------

/** P on site A with communities and v3 secrets, created through POST: bound with grants on G_A and G_A2. */
async function credentialedProfileOnA(): Promise<string> {
  const id = await createProfile({ siteId: fx.siteA, snmpCommunities: ['public-a'], snmpCredentials: V3_A });
  expect(allowed(await gateFor(id))).toEqual([fx.G_A, fx.G_A2].sort());
  return id;
}

async function setNetworkIdDirect(profileId: string, networkId: string | null): Promise<void> {
  await admin(sql`UPDATE discovery_profiles SET network_id = ${networkId}::uuid WHERE id = ${profileId}::uuid`);
}

async function shrinkGrantsDirect(profileId: string, keep: string[]): Promise<void> {
  for (const gatewayId of (await grantRows(profileId)).filter((g) => !keep.includes(g))) {
    await admin(sql`DELETE FROM discovery_profile_snmp_grants WHERE profile_id = ${profileId}::uuid AND gateway_id = ${gatewayId}::uuid`);
  }
}

const patchProfile = (profileId: string, body: unknown) => fx.client.patch(`/discovery/profiles/${profileId}`, body);

describe('W03b credential sequences', () => {
  it('S3 partial entry grants nothing', async () => {
    const P = await credentialedProfileOnA();
    await setNetworkIdDirect(P, fx.N_A);                      // P narrowed, grants already {G_A}
    await shrinkGrantsDirect(P, [fx.G_A]);

    const res = await patchProfile(P, {
      snmpCommunities: ['public-b'],
      snmpCredentials: V3_MASKED,
      networkId: null,                                         // widen the narrowing in the same save
    });

    expect(res.status).toBe(200);
    expect(allowed(await gateFor(P))).toEqual([fx.G_A]);      // never G_A2
    expect(await storedCommunities(P)).toEqual(['public-b']);
    expect((await profileRow(P)).networkId).toBeNull();
  });

  it('S5 grants come from the profile as saved', async () => {
    const P = await credentialedProfileOnA();
    const narrowed = await patchProfile(P, { networkId: fx.N_A, snmpCommunities: [MASK] });   // shrink to G_A
    expect(narrowed.status).toBe(200);
    expect(allowed(await gateFor(P))).toEqual([fx.G_A]);

    const res = await patchProfile(P, { networkId: fx.N_A2, snmpCommunities: ['public-b'], snmpCredentials: null }); // full re-entry
    expect(res.status).toBe(200);
    expect(allowed(await gateFor(P))).toEqual([fx.G_A2]);     // not G_A, not both
    // Widening the narrowing without a re-entry adds nothing, so a grant left over from before the re-entry would
    // surface here; the gate's network filter above cannot show it.
    const widened = await patchProfile(P, { networkId: null, snmpCommunities: [MASK] });
    expect(widened.status).toBe(200);
    expect(allowed(await gateFor(P))).toEqual([fx.G_A2]);

    const moved = await patchProfile(P, {
      siteId: fx.siteB, networkId: null, snmpCommunities: ['public-a'], snmpCredentials: null,
    });
    expect(moved.status).toBe(200);
    expect((await profileRow(P)).siteId).toBe(fx.siteB);
    expect(allowed(await gateFor(P))).toEqual([fx.G_B]);
  });

  it('T1 partial rotation shrinks grants', async () => {
    const P = await credentialedProfileOnA();
    const narrowed = await patchProfile(P, {
      networkId: fx.N_A, snmpCommunities: ['public-b'], snmpCredentials: V3_MASKED,
    });
    expect(narrowed.status).toBe(200);
    expect(allowed(await gateFor(P))).toEqual([fx.G_A]);

    const widened = await patchProfile(P, { networkId: null, snmpCommunities: ['public-a'], snmpCredentials: V3_MASKED });
    expect(widened.status).toBe(200);
    expect(allowed(await gateFor(P))).toEqual([fx.G_A]);      // the secret supplied while narrowed never reaches N_A2
    expect((await profileRow(P)).snmpGrantMode).toBe('bound');
  });

  it("T2a save rejects a network not assigned to the profile's site", async () => {
    const P = await credentialedProfileOnA();
    for (const networkId of [fx.N_B, fx.N_C, fx.otherOrgNetwork]) {
      const res = await patchProfile(P, { networkId, snmpCommunities: ['public-b'], snmpCredentials: null });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Choose a network that is assigned to this profile's site.", code: 'NETWORK_NOT_ASSIGNABLE',
      });
    }
    expect(await storedCommunities(P)).toEqual(['public-a']);
    expect(allowed(await gateFor(P))).toEqual([fx.G_A, fx.G_A2].sort());

    const narrowed = await patchProfile(P, { networkId: fx.N_A, snmpCommunities: [MASK] });
    expect(narrowed.status).toBe(200);
    const leftBehind = await patchProfile(P, { siteId: fx.siteB, snmpCommunities: ['public-b'], snmpCredentials: null });
    expect(leftBehind.status).toBe(400);
    expect((await leftBehind.json()).code).toBe('NETWORK_NOT_ASSIGNABLE');
    expect((await profileRow(P)).siteId).toBe(fx.siteA);
    expect(await storedCommunities(P)).toEqual(['public-a']);
    expect(allowed(await gateFor(P))).toEqual([fx.G_A]);       // G_B never allowed
  });

  it('T2a create rejects a network not assigned to the site', async () => {
    const res = await fx.client.post('/discovery/profiles', {
      siteId: fx.siteA, name: 'refused', subnets: ['192.168.1.0/24'], methods: ['ping'], schedule: { type: 'manual' },
      snmpCommunities: ['public-a'], networkId: fx.N_B,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NETWORK_NOT_ASSIGNABLE');
    const [row] = await admin<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM discovery_profiles WHERE org_id = ${fx.orgId}::uuid`);
    expect(row!.count).toBe(0);
  });

  it('a bound profile with secrets on a site that is not gated fails until a full re-entry unbinds it', async () => {
    // W03a contract note 1: an assigned network cannot exist on a site whose flag is false.
    const P = await insertProfileDirect({ siteId: fx.siteD, communities: ['public-a'], mode: 'bound' });
    expect(allowed(await gateFor(P))).toBe('credentials_need_reentry');
    const res = await patchProfile(P, { snmpCommunities: ['public-b'] });   // rule 1 on a site that is not gated
    expect(res.status).toBe(200);
    expect((await profileRow(P)).snmpGrantMode).toBe('unrestricted');
    expect(allowed(await gateFor(P))).toBe('unrestricted');
  });

  it('an unrestricted profile on a site that is not gated saves and runs as before', async () => {
    const P = await createProfile({ siteId: fx.siteD, snmpCommunities: ['public-a'] });
    const res = await patchProfile(P, { name: 'renamed', snmpCommunities: [MASK] });
    expect(res.status).toBe(200);
    expect((await profileRow(P)).snmpGrantMode).toBe('unrestricted');
    expect(await grantRows(P)).toEqual([]);
    expect(await storedCommunities(P)).toEqual(['public-a']);
    expect(allowed(await gateFor(P))).toBe('unrestricted');
  });
});

