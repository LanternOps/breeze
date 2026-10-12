/**
 * #8287 / PR #8443 — the device-facing monitoring views (summary, status,
 * tab-counts) filter `service_process_check_results` to the device's CURRENT
 * watch set. That set is resolved in the CALLER'S OWN request DB context — no
 * system escalation — so a partner-wide monitor is visible only through the
 * SELECT-only partner-wide RLS branch fed by `breeze.current_partner_id`.
 *
 * Pins, against real Postgres + RLS:
 *  - an ORG-scope user and a PARTNER-scope user (contexts built by the real
 *    `buildDbAccessContext`) both resolve the partner-wide monitor's watch;
 *  - a removed watch's stale result is filtered, the live one kept;
 *  - a non-system context WITHOUT `currentPartnerId` fails OPEN (null →
 *    unfiltered). Without the guard the resolver would answer a truncated
 *    `watches: []` and hide every live result; under the old system escalation
 *    it would answer the full set — both are wrong for this case, so this is
 *    the discriminating assertion;
 *  - the display path never writes the agent's settings cache.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyMonitors,
  configurationPolicies,
  devices,
  monitorDefinitions,
  serviceProcessCheckResults,
} from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { getRedis } from '../../services/redis';
import { filterToActiveWatches, loadActiveWatchKeys, watchKey } from '../../services/monitoringActiveWatches';
import { createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const orgUserCtx = (orgId: string, partnerId: string | null) =>
  buildDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], partnerId, userId: null });

const partnerUserCtx = (partnerId: string, orgIds: string[]) =>
  buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, partnerId, userId: null });

const createdPolicies: string[] = [];
const createdDevices: string[] = [];
const createdMonitors: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdDevices) {
      await db.delete(serviceProcessCheckResults).where(eq(serviceProcessCheckResults.deviceId, id));
    }
    for (const id of createdPolicies) {
      await db.delete(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, id));
    }
    for (const id of createdDevices) await db.delete(devices).where(eq(devices.id, id));
    for (const id of createdPolicies) await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    for (const id of createdMonitors) await db.delete(monitorDefinitions).where(eq(monitorDefinitions.id, id));
  });
  createdDevices.length = 0;
  createdPolicies.length = 0;
  createdMonitors.length = 0;
});

const cacheKey = (deviceId: string) => `monitoring:settings:device:${deviceId}`;

async function purgeCache(deviceId: string) {
  const redis = getRedis();
  if (redis) await redis.del(cacheKey(deviceId));
}

async function seedFixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org!.id });

  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [device] = await db.insert(devices).values({
      orgId: org!.id,
      siteId: site!.id,
      agentId: `agent-${randomUUID()}`,
      hostname: `host-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '1.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
      deviceRole: 'workstation',
    }).returning();
    createdDevices.push(device!.id);

    // Partner-wide (org_id NULL) service monitor via a partner-wide policy assigned at partner level.
    const [monitor] = await db.insert(monitorDefinitions).values({
      orgId: null,
      partnerId: partner.id,
      name: 'watch-LiveSpooler',
      kind: 'service',
      condition: { serviceName: 'LiveSpooler' },
      severity: 'high',
    }).returning({ id: monitorDefinitions.id });
    createdMonitors.push(monitor!.id);

    const [policy] = await db.insert(configurationPolicies).values({
      orgId: null,
      partnerId: partner.id,
      name: `policy-${randomUUID().slice(0, 8)}`,
      status: 'active',
    }).returning({ id: configurationPolicies.id });
    createdPolicies.push(policy!.id);

    const [link] = await db.insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'monitors' })
      .returning({ id: configPolicyFeatureLinks.id });
    await db.insert(configPolicyMonitors).values({ featureLinkId: link!.id, monitorId: monitor!.id, enabled: true });
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id, level: 'partner', targetId: partner.id, priority: 0,
    });

    // One live watch's result, and the last result of a watch since removed from the policy.
    await db.insert(serviceProcessCheckResults).values([
      { orgId: org!.id, deviceId: device!.id, watchType: 'service', name: 'LiveSpooler', status: 'stopped' },
      { orgId: org!.id, deviceId: device!.id, watchType: 'service', name: 'RemovedWatch', status: 'not_found' },
    ]);

    return { partnerId: partner.id, orgId: org!.id, deviceId: device!.id };
  });
}

/** Mirrors the route: read results in the caller's context, then filter. */
async function visibleActiveResults(ctx: DbAccessContext, deviceId: string) {
  return withDbAccessContext(ctx, async () => {
    const rows = await db
      .select({ watchType: serviceProcessCheckResults.watchType, name: serviceProcessCheckResults.name })
      .from(serviceProcessCheckResults)
      .where(eq(serviceProcessCheckResults.deviceId, deviceId));
    const keys = await loadActiveWatchKeys(deviceId);
    return { keys, rows, filtered: filterToActiveWatches(rows, keys) };
  });
}

describe('monitoring display watch set resolves in the caller context (#8287)', () => {
  it('ORG-scope user: partner-wide watch resolves; removed watch filtered', async () => {
    const f = await seedFixture();
    await purgeCache(f.deviceId);

    const { keys, rows, filtered } = await visibleActiveResults(orgUserCtx(f.orgId, f.partnerId), f.deviceId);

    expect(rows).toHaveLength(2); // both results are RLS-visible to the org user
    expect(keys).not.toBeNull();
    expect([...keys!]).toEqual([watchKey('service', 'LiveSpooler')]);
    expect(filtered.map((r) => r.name)).toEqual(['LiveSpooler']);
  });

  it('PARTNER-scope user: partner-wide watch resolves; removed watch filtered', async () => {
    const f = await seedFixture();
    await purgeCache(f.deviceId);

    const { keys, rows, filtered } = await visibleActiveResults(partnerUserCtx(f.partnerId, [f.orgId]), f.deviceId);

    expect(rows).toHaveLength(2);
    expect(keys).not.toBeNull();
    expect([...keys!]).toEqual([watchKey('service', 'LiveSpooler')]);
    expect(filtered.map((r) => r.name)).toEqual(['LiveSpooler']);
  });

  it('fails OPEN when the context has no currentPartnerId (partner-wide rows invisible)', async () => {
    const f = await seedFixture();
    await purgeCache(f.deviceId);

    // e.g. an organization-scope SSO session, which mints partnerId: null.
    const { keys, filtered } = await visibleActiveResults(orgUserCtx(f.orgId, null), f.deviceId);

    expect(keys).toBeNull();
    expect(filtered.map((r) => r.name).sort()).toEqual(['LiveSpooler', 'RemovedWatch']);
  });

  it('never writes the agent settings cache', async () => {
    const f = await seedFixture();
    await purgeCache(f.deviceId);
    const redis = getRedis();
    expect(redis).not.toBeNull(); // test-stack provides Redis; a null client would make this vacuous

    const { keys } = await visibleActiveResults(orgUserCtx(f.orgId, f.partnerId), f.deviceId);

    expect(keys).not.toBeNull(); // the resolver actually ran (cache miss → resolved)
    expect(await redis!.get(cacheKey(f.deviceId))).toBeNull();
  });
});
