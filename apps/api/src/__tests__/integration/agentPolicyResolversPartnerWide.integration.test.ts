/**
 * Agent-facing config-policy resolvers honour partner-wide policies (#2930).
 *
 * Configuration policies can be PARTNER-owned (`org_id NULL`, `partner_id`
 * set — the "all orgs" shape from #1724) instead of org-owned. Four
 * agent-facing resolvers in routes/agents/helpers.ts previously joined on a
 * bare `configurationPolicies.orgId = device.orgId` and ran the policy query
 * inside an ORG-SCOPED RLS context. Both halves silently dropped
 * partner-owned policies:
 *
 *   1. The bare org-equality join never matches an `org_id NULL` row, so a
 *      partner-wide policy was never even selected by the SQL.
 *   2. Even with a correct predicate, `breeze_has_partner_access` gates
 *      partner-owned rows, and an org-scoped DbAccessContext (the real shape
 *      of the agent heartbeat/eventlogs request path) carries
 *      `accessiblePartnerIds: []` — so the read silently returns ZERO ROWS,
 *      not an error.
 *
 * The fix (services/configPolicyOwnership.ts) is a matched pair:
 * `policyOwnershipCondition` (dual-axis join predicate) plus
 * `withPartnerWideVisibility` (a scoped system-context escape around ONLY the
 * policy join). This test proves both halves for all four resolvers by
 * invoking them exactly as the agent heartbeat path does: inside a real
 * org-scoped `withDbAccessContext`, against the real breeze_app RLS-forced
 * connection.
 *
 * If this test file were deleted: a regression that reintroduces a bare
 * `eq(configurationPolicies.orgId, device.orgId)` join, or that drops the
 * `withPartnerWideVisibility` escape, would compile fine, pass every unit
 * test (which mock the DB and never exercise RLS), and pass
 * configurationPolicyPartnerResolution.integration.test.ts (which resolves
 * under a SYSTEM-scope AuthContext, so the RLS escape is never exercised).
 * Partner-wide policies would silently stop reaching agents for event_log,
 * monitoring, PAM, and patch-source config — exactly the bug #2930 fixed.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyEventLogSettings,
  configPolicyMonitoringSettings,
  configPolicyMonitoringWatches,
  configPolicyPatchSettings,
  devices,
} from '../../db/schema';
import {
  buildEventLogConfigUpdate,
  buildMonitoringConfigUpdate,
  buildPamConfigUpdate,
  buildPatchSourceConfigUpdate,
  EVENT_LOG_DEFAULTS,
} from '../../routes/agents/helpers';
import { PAM_DEFAULTS } from '../../routes/agents/pamSettings';
import { getRedis } from '../../services/redis';
import { createPartner, createOrganization, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

// The realistic agent-facing shape: an org-scoped request context.
// accessiblePartnerIds: [] is the crux of the bug — an org token never
// carries partner-axis access, so breeze_has_partner_access is false and a
// partner-owned policy is invisible unless the resolver escapes to a system
// context for the policy join (withPartnerWideVisibility).
function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

const createdPolicies: string[] = [];
const createdDevices: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdDevices) {
      await db.delete(devices).where(eq(devices.id, id));
    }
    for (const id of createdPolicies) {
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    }
  });
  createdDevices.length = 0;
  createdPolicies.length = 0;
});

async function seedDevice(orgId: string, siteId: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [d] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        deviceRole: 'workstation',
      })
      .returning();
    createdDevices.push(d!.id);
    return d!;
  });
}

async function assign(configPolicyId: string, level: 'partner' | 'organization', targetId: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    await db.insert(configPolicyAssignments).values({
      configPolicyId,
      level,
      targetId,
      priority: 0,
    });
  });
}

// maxEventsPerCycle is the field the seed varies: it's one of the four
// fields buildEventLogConfigUpdate actually surfaces (max_events_per_cycle),
// so tests can prove "this specific policy resolved" through the builder's
// own return value rather than by reading the settings table directly. The
// default is 100 (EVENT_LOG_DEFAULTS.maxEventsPerCycle) — every seed below
// uses a value that differs from it.
async function seedEventLogPolicy(
  owner: { orgId: string | null; partnerId: string | null },
  maxEventsPerCycle: number,
) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: owner.orgId, partnerId: owner.partnerId, name: `event_log policy ${randomUUID()}`, status: 'active' })
      .returning();
    createdPolicies.push(policy!.id);
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'event_log' })
      .returning();
    await db.insert(configPolicyEventLogSettings).values({
      featureLinkId: link!.id,
      maxEventsPerCycle,
    });
    return policy!.id;
  });
}

async function seedMonitoringPolicy(
  owner: { orgId: string | null; partnerId: string | null },
  checkIntervalSeconds: number,
) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: owner.orgId, partnerId: owner.partnerId, name: `monitoring policy ${randomUUID()}`, status: 'active' })
      .returning();
    createdPolicies.push(policy!.id);
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'monitoring' })
      .returning();
    const [settings] = await db
      .insert(configPolicyMonitoringSettings)
      .values({ featureLinkId: link!.id, checkIntervalSeconds })
      .returning();
    await db.insert(configPolicyMonitoringWatches).values({
      settingsId: settings!.id,
      watchType: 'service',
      name: 'TestService',
      enabled: true,
    });
    return policy!.id;
  });
}

async function seedPamPolicy(
  owner: { orgId: string | null; partnerId: string | null },
  uacInterceptionEnabled: boolean,
) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: owner.orgId, partnerId: owner.partnerId, name: `pam policy ${randomUUID()}`, status: 'active' })
      .returning();
    createdPolicies.push(policy!.id);
    await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id,
      featureType: 'pam',
      inlineSettings: { uacInterceptionEnabled },
    });
    return policy!.id;
  });
}

async function seedPatchPolicy(
  owner: { orgId: string | null; partnerId: string | null },
  exclusiveWindowsUpdate: boolean,
) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: owner.orgId, partnerId: owner.partnerId, name: `patch policy ${randomUUID()}`, status: 'active' })
      .returning();
    createdPolicies.push(policy!.id);
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'patch' })
      .returning();
    await db.insert(configPolicyPatchSettings).values({
      featureLinkId: link!.id,
      exclusiveWindowsUpdate,
    });
    return policy!.id;
  });
}

// Cached resolvers (event_log, monitoring, pam) key on device id with a 120s
// TTL. Every test seeds a FRESH device (fresh uuid -> fresh cache key), which
// alone rules out a cache hit masking a resolution failure. This helper is a
// belt-and-suspenders explicit purge on top of that, so the point is not
// left implicit: a passing assertion below reflects a live DB resolution,
// never a cached artifact.
async function purgeCaches(deviceId: string) {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(
    `eventlog:settings:device:${deviceId}`,
    `monitoring:settings:device:${deviceId}`,
    `pam:settings:device:${deviceId}`,
  );
}

describe('agent-facing config-policy resolvers honour partner-wide policies (#2930)', () => {
  describe('partner-owned policy resolves under an ORG-SCOPED context (the RLS escape)', () => {
    it('buildEventLogConfigUpdate resolves a partner-owned policy', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);
      await purgeCaches(device.id);

      const policyId = await seedEventLogPolicy({ orgId: null, partnerId: partner.id }, 555);
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id), () => buildEventLogConfigUpdate(device.id));

      // 555 is not the default (100) — proves the partner-owned policy
      // resolved rather than a silent fallback to EVENT_LOG_DEFAULTS.
      expect(result.max_events_per_cycle).toBe(555);
      expect(result.max_events_per_cycle).not.toBe(EVENT_LOG_DEFAULTS.maxEventsPerCycle);
    });

    it('buildMonitoringConfigUpdate resolves a partner-owned policy', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);
      await purgeCaches(device.id);

      const policyId = await seedMonitoringPolicy({ orgId: null, partnerId: partner.id }, 999);
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id), () => buildMonitoringConfigUpdate(device.id));

      expect(result).not.toBeNull();
      expect(result!.check_interval_seconds).toBe(999);
      expect(result!.watches).toHaveLength(1);
      expect(result!.watches[0]?.name).toBe('TestService');
    });

    it('buildPamConfigUpdate resolves a partner-owned policy', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);
      await purgeCaches(device.id);

      const policyId = await seedPamPolicy({ orgId: null, partnerId: partner.id }, true);
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id), () => buildPamConfigUpdate(device.id));

      expect(result.uacInterceptionEnabled).toBe(true);
    });

    it('buildPatchSourceConfigUpdate resolves a partner-owned policy', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);
      // Not cached — no purge needed.

      const policyId = await seedPatchPolicy({ orgId: null, partnerId: partner.id }, true);
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id), () => buildPatchSourceConfigUpdate(device.id));

      expect(result.exclusiveWindowsUpdate).toBe(true);
    });
  });

  describe('fan-out: the same partner-owned policy resolves for devices in TWO different orgs of the same partner', () => {
    it('event_log, monitoring, pam, and patch all fan out across sibling orgs', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });
      const siteA = await createSite({ orgId: orgA!.id });
      const siteB = await createSite({ orgId: orgB!.id });
      const deviceA = await seedDevice(orgA!.id, siteA!.id);
      const deviceB = await seedDevice(orgB!.id, siteB!.id);
      await purgeCaches(deviceA.id);
      await purgeCaches(deviceB.id);

      const eventLogPolicyId = await seedEventLogPolicy({ orgId: null, partnerId: partner.id }, 555);
      await assign(eventLogPolicyId, 'partner', partner.id);
      const monitoringPolicyId = await seedMonitoringPolicy({ orgId: null, partnerId: partner.id }, 777);
      await assign(monitoringPolicyId, 'partner', partner.id);
      const pamPolicyId = await seedPamPolicy({ orgId: null, partnerId: partner.id }, true);
      await assign(pamPolicyId, 'partner', partner.id);
      const patchPolicyId = await seedPatchPolicy({ orgId: null, partnerId: partner.id }, true);
      await assign(patchPolicyId, 'partner', partner.id);

      const eventLogA = await withDbAccessContext(orgContext(orgA!.id), () => buildEventLogConfigUpdate(deviceA.id));
      const eventLogB = await withDbAccessContext(orgContext(orgB!.id), () => buildEventLogConfigUpdate(deviceB.id));
      const monitoringA = await withDbAccessContext(orgContext(orgA!.id), () => buildMonitoringConfigUpdate(deviceA.id));
      const monitoringB = await withDbAccessContext(orgContext(orgB!.id), () => buildMonitoringConfigUpdate(deviceB.id));
      const pamA = await withDbAccessContext(orgContext(orgA!.id), () => buildPamConfigUpdate(deviceA.id));
      const pamB = await withDbAccessContext(orgContext(orgB!.id), () => buildPamConfigUpdate(deviceB.id));
      const patchA = await withDbAccessContext(orgContext(orgA!.id), () => buildPatchSourceConfigUpdate(deviceA.id));
      const patchB = await withDbAccessContext(orgContext(orgB!.id), () => buildPatchSourceConfigUpdate(deviceB.id));

      expect(eventLogA.max_events_per_cycle).toBe(555);
      expect(eventLogB.max_events_per_cycle).toBe(555);
      expect(monitoringA?.check_interval_seconds).toBe(777);
      expect(monitoringB?.check_interval_seconds).toBe(777);
      expect(pamA.uacInterceptionEnabled).toBe(true);
      expect(pamB.uacInterceptionEnabled).toBe(true);
      expect(patchA.exclusiveWindowsUpdate).toBe(true);
      expect(patchB.exclusiveWindowsUpdate).toBe(true);
    });
  });

  describe('precedence: an org-level assignment wins over the partner-wide one (partner is the lowest level)', () => {
    it('event_log: org-owned policy wins', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);
      await purgeCaches(device.id);

      const partnerPolicyId = await seedEventLogPolicy({ orgId: null, partnerId: partner.id }, 555);
      await assign(partnerPolicyId, 'partner', partner.id);
      const orgPolicyId = await seedEventLogPolicy({ orgId: org!.id, partnerId: null }, 222);
      await assign(orgPolicyId, 'organization', org!.id);

      const result = await withDbAccessContext(orgContext(org!.id), () => buildEventLogConfigUpdate(device.id));

      expect(result.max_events_per_cycle).toBe(222);
    });

    it('pam: org-owned policy wins over the partner-wide one', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);
      await purgeCaches(device.id);

      // Partner-wide says ON; org-level says OFF. Org must win.
      const partnerPolicyId = await seedPamPolicy({ orgId: null, partnerId: partner.id }, true);
      await assign(partnerPolicyId, 'partner', partner.id);
      const orgPolicyId = await seedPamPolicy({ orgId: org!.id, partnerId: null }, false);
      await assign(orgPolicyId, 'organization', org!.id);

      const result = await withDbAccessContext(orgContext(org!.id), () => buildPamConfigUpdate(device.id));

      expect(result.uacInterceptionEnabled).toBe(false);
    });
  });

  describe('isolation: a device under a DIFFERENT partner never receives the first partner\'s policy', () => {
    it('event_log, monitoring, pam, and patch all fall back to defaults for the foreign-partner device', async () => {
      const partnerP1 = await createPartner();
      const orgP1 = await createOrganization({ partnerId: partnerP1.id });

      const partnerQ = await createPartner();
      const orgQ = await createOrganization({ partnerId: partnerQ.id });
      const siteQ = await createSite({ orgId: orgQ!.id });
      const deviceQ = await seedDevice(orgQ!.id, siteQ!.id);
      await purgeCaches(deviceQ.id);

      // Policies owned by partner P1, assigned partner-wide to P1 — orgP1 is
      // referenced only to establish a plausible partner (never queried).
      void orgP1;
      const eventLogPolicyId = await seedEventLogPolicy({ orgId: null, partnerId: partnerP1.id }, 555);
      await assign(eventLogPolicyId, 'partner', partnerP1.id);
      const monitoringPolicyId = await seedMonitoringPolicy({ orgId: null, partnerId: partnerP1.id }, 999);
      await assign(monitoringPolicyId, 'partner', partnerP1.id);
      const pamPolicyId = await seedPamPolicy({ orgId: null, partnerId: partnerP1.id }, true);
      await assign(pamPolicyId, 'partner', partnerP1.id);
      const patchPolicyId = await seedPatchPolicy({ orgId: null, partnerId: partnerP1.id }, true);
      await assign(patchPolicyId, 'partner', partnerP1.id);

      const eventLogQ = await withDbAccessContext(orgContext(orgQ!.id), () => buildEventLogConfigUpdate(deviceQ.id));
      const monitoringQ = await withDbAccessContext(orgContext(orgQ!.id), () => buildMonitoringConfigUpdate(deviceQ.id));
      const pamQ = await withDbAccessContext(orgContext(orgQ!.id), () => buildPamConfigUpdate(deviceQ.id));
      const patchQ = await withDbAccessContext(orgContext(orgQ!.id), () => buildPatchSourceConfigUpdate(deviceQ.id));

      // No policy of Q's own partner matched -> defaults across the board,
      // NOT partner P1's values (555 / 999 / true / true).
      expect(eventLogQ.max_events_per_cycle).toBe(EVENT_LOG_DEFAULTS.maxEventsPerCycle);
      expect(monitoringQ).toBeNull();
      expect(pamQ.uacInterceptionEnabled).toBe(PAM_DEFAULTS.uacInterceptionEnabled);
      expect(patchQ.exclusiveWindowsUpdate).toBe(false);
    });
  });

  describe('status gating: a partner-owned policy that is not active must not resolve', () => {
    // resolveDeviceEventLogSettings filters on
    // `eq(configurationPolicies.status, 'active')` in the SAME query as the
    // partner-wide join predicate — a regression that widened
    // policyOwnershipCondition without preserving this filter would let a
    // withdrawn/paused partner-wide policy keep reaching agents. The status
    // enum (config_policy_status) has no 'draft' value — 'inactive' is the
    // non-active state a partner uses to pull a policy without deleting it.
    it('buildEventLogConfigUpdate falls back to EVENT_LOG_DEFAULTS for an inactive partner-owned policy', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);
      await purgeCaches(device.id);

      // Distinctive value (not the 100 default) — if this resolved despite
      // being inactive, the assertion below would catch it explicitly rather
      // than passing coincidentally.
      const DISTINCTIVE_MAX_EVENTS = 555;
      const policyId = await withDbAccessContext(SYSTEM_CTX, async () => {
        const [policy] = await db
          .insert(configurationPolicies)
          .values({
            orgId: null,
            partnerId: partner.id,
            name: `event_log inactive policy ${randomUUID()}`,
            status: 'inactive',
          })
          .returning();
        createdPolicies.push(policy!.id);
        const [link] = await db
          .insert(configPolicyFeatureLinks)
          .values({ configPolicyId: policy!.id, featureType: 'event_log' })
          .returning();
        await db.insert(configPolicyEventLogSettings).values({
          featureLinkId: link!.id,
          maxEventsPerCycle: DISTINCTIVE_MAX_EVENTS,
        });
        return policy!.id;
      });
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id), () => buildEventLogConfigUpdate(device.id));

      expect(result.max_events_per_cycle).toBe(EVENT_LOG_DEFAULTS.maxEventsPerCycle);
      expect(result.max_events_per_cycle).not.toBe(DISTINCTIVE_MAX_EVENTS);
    });
  });
});
