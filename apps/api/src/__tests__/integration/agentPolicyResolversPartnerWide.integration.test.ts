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
 * The original fix (#2930) was a matched pair: `policyOwnershipCondition` (the
 * dual-axis join predicate) plus `withPartnerWideVisibility`, a scoped
 * system-context escape around ONLY the policy join.
 *
 * **#4673 W03 replaced the second half.** The escape is deleted. Its job is now
 * done by the database: `<table>_partner_wide_select` (W01) adds a SELECT-ONLY
 * policy `org_id IS NULL AND partner_id = public.breeze_current_partner_id()`
 * across the configuration-policy chain, and W02 populates
 * `breeze.current_partner_id` on agent contexts from the device org's partner.
 * So the agent reads its own MSP's partner-wide config on its OWN connection —
 * no second pooled connection (the #1105 starvation shape) and no RLS bypass
 * (the #2417 cross-tenant shape).
 *
 * This test proves both halves for all four resolvers by invoking them exactly
 * as the agent heartbeat path does: inside a real org-scoped
 * `withDbAccessContext`, against the real breeze_app RLS-forced connection.
 *
 * The `partnerWideBlindContext` cases are what make it a real proof rather than
 * a tautology. They run the same resolvers under a context with
 * `currentPartnerId: null` and require the partner-wide policy to be INVISIBLE.
 * That fails if the system-context escape is ever reintroduced — under an
 * escape the GUC is irrelevant and the row resolves regardless. Together the
 * two halves pin: visible with the GUC, invisible without it, therefore the
 * RLS branch (not an escape) is what is doing the work.
 *
 * If this test file were deleted: a regression that reintroduces a bare
 * `eq(configurationPolicies.orgId, device.orgId)` join, that drops
 * `currentPartnerId` from the agent context, or that reintroduces the escape,
 * would compile fine, pass every unit test (which mock the DB and never
 * exercise RLS), and pass
 * configurationPolicyPartnerResolution.integration.test.ts (which resolves
 * under a SYSTEM-scope AuthContext, where every RLS branch short-circuits
 * true). Partner-wide policies would silently stop reaching agents for
 * event_log, monitoring, PAM, and patch-source config — exactly the bug #2930
 * fixed — or would keep reaching them through a connection-doubling bypass.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
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

// The realistic agent-facing shape, as `agentAuthMiddleware` builds it since
// #4673 W02: an org-scoped request context that carries the DEVICE ORG'S OWN
// partner in `currentPartnerId` while `accessiblePartnerIds` stays [].
//
// The two fields are different axes and must not be conflated.
// `accessiblePartnerIds` gates `breeze_has_partner_access`, which admits
// partner-axis WRITES — an agent never gets it. `currentPartnerId` feeds the
// `breeze.current_partner_id` GUC, which only the SELECT-only
// `<table>_partner_wide_select` policies read. That branch is now the ONLY
// thing making a partner-owned policy legible here: W03 deleted the nested
// system-context escape (`withPartnerWideVisibility`) these resolvers used to
// take. `partnerWideBlindContext` below pins that by omitting the GUC.
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

// The SAME context minus `currentPartnerId` — i.e. what an agent context looked
// like BEFORE W02. Used by the "the RLS branch is load-bearing" cases below: if
// a system-context escape were ever reintroduced (or survived), a partner-owned
// policy would resolve under this context too, and those assertions fail.
function partnerWideBlindContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: null,
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
  describe('partner-owned policy resolves under an ORG-SCOPED context (the *_partner_wide_select RLS branch)', () => {
    it('buildEventLogConfigUpdate resolves a partner-owned policy', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);
      await purgeCaches(device.id);

      const policyId = await seedEventLogPolicy({ orgId: null, partnerId: partner.id }, 555);
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () => buildEventLogConfigUpdate(device.id));

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

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () => buildMonitoringConfigUpdate(device.id));

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

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () => buildPamConfigUpdate(device.id));

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

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () => buildPatchSourceConfigUpdate(device.id));

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

      const eventLogA = await withDbAccessContext(orgContext(orgA!.id, partner.id), () => buildEventLogConfigUpdate(deviceA.id));
      const eventLogB = await withDbAccessContext(orgContext(orgB!.id, partner.id), () => buildEventLogConfigUpdate(deviceB.id));
      const monitoringA = await withDbAccessContext(orgContext(orgA!.id, partner.id), () => buildMonitoringConfigUpdate(deviceA.id));
      const monitoringB = await withDbAccessContext(orgContext(orgB!.id, partner.id), () => buildMonitoringConfigUpdate(deviceB.id));
      const pamA = await withDbAccessContext(orgContext(orgA!.id, partner.id), () => buildPamConfigUpdate(deviceA.id));
      const pamB = await withDbAccessContext(orgContext(orgB!.id, partner.id), () => buildPamConfigUpdate(deviceB.id));
      const patchA = await withDbAccessContext(orgContext(orgA!.id, partner.id), () => buildPatchSourceConfigUpdate(deviceA.id));
      const patchB = await withDbAccessContext(orgContext(orgB!.id, partner.id), () => buildPatchSourceConfigUpdate(deviceB.id));

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

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () => buildEventLogConfigUpdate(device.id));

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

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () => buildPamConfigUpdate(device.id));

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

      const eventLogQ = await withDbAccessContext(orgContext(orgQ!.id, partnerQ.id), () => buildEventLogConfigUpdate(deviceQ.id));
      const monitoringQ = await withDbAccessContext(orgContext(orgQ!.id, partnerQ.id), () => buildMonitoringConfigUpdate(deviceQ.id));
      const pamQ = await withDbAccessContext(orgContext(orgQ!.id, partnerQ.id), () => buildPamConfigUpdate(deviceQ.id));
      const patchQ = await withDbAccessContext(orgContext(orgQ!.id, partnerQ.id), () => buildPatchSourceConfigUpdate(deviceQ.id));

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

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () => buildEventLogConfigUpdate(device.id));

      expect(result.max_events_per_cycle).toBe(EVENT_LOG_DEFAULTS.maxEventsPerCycle);
      expect(result.max_events_per_cycle).not.toBe(DISTINCTIVE_MAX_EVENTS);
    });
  });

  describe('the *_partner_wide_select branch is what makes it work — not a system escape (#4673 W03)', () => {
    // RED-FIRST GATE. Before W03 these four resolvers wrapped their policy join
    // in `withPartnerWideVisibility`, a nested
    // `runOutsideDbContext(() => withSystemDbAccessContext(...))`. Under that
    // escape `breeze.current_partner_id` is irrelevant — the query runs as
    // scope 'system' on a second connection and sees EVERY tenant's rows — so
    // every "INVISIBLE" assertion below would have failed (the partner-wide
    // policy would resolve anyway). They pass only because the read now happens
    // on the caller's own RLS-forced connection, where the SELECT-only branch
    // is the sole grant and a NULL GUC makes `partner_id = NULL` never true.
    //
    // This is also the regression gate for W02: drop `currentPartnerId` from
    // agentAuth's context and the positive cases above go red, instead of
    // silently degrading real agents to defaults with no error.
    it('event_log: a partner-wide policy is INVISIBLE without breeze.current_partner_id', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);
      await purgeCaches(device.id);

      const policyId = await seedEventLogPolicy({ orgId: null, partnerId: partner.id }, 555);
      await assign(policyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        buildEventLogConfigUpdate(device.id),
      );
      expect(blind.max_events_per_cycle).toBe(EVENT_LOG_DEFAULTS.maxEventsPerCycle);
      expect(blind.max_events_per_cycle).not.toBe(555);

      // Same device, same policy, same process — only the GUC differs.
      await purgeCaches(device.id);
      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        buildEventLogConfigUpdate(device.id),
      );
      expect(sighted.max_events_per_cycle).toBe(555);
    });

    it('monitoring: a partner-wide policy is INVISIBLE without breeze.current_partner_id', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);
      await purgeCaches(device.id);

      const policyId = await seedMonitoringPolicy({ orgId: null, partnerId: partner.id }, 999);
      await assign(policyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        buildMonitoringConfigUpdate(device.id),
      );
      expect(blind).toBeNull();

      await purgeCaches(device.id);
      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        buildMonitoringConfigUpdate(device.id),
      );
      // The watches read is a SEPARATE query, chained through settings_id ->
      // feature link -> configuration_policies. It used to share one escape
      // with the policy join; now it needs its own
      // `config_policy_monitoring_watches_partner_wide_select` branch. A
      // non-empty watches array is the proof that branch exists and matches —
      // without it this resolves the settings row and then returns null.
      expect(sighted).not.toBeNull();
      expect(sighted!.check_interval_seconds).toBe(999);
      expect(sighted!.watches).toHaveLength(1);
    });

    it('pam: a partner-wide policy is INVISIBLE without breeze.current_partner_id', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);
      await purgeCaches(device.id);

      const policyId = await seedPamPolicy({ orgId: null, partnerId: partner.id }, true);
      await assign(policyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        buildPamConfigUpdate(device.id),
      );
      expect(blind.uacInterceptionEnabled).toBe(PAM_DEFAULTS.uacInterceptionEnabled);

      await purgeCaches(device.id);
      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        buildPamConfigUpdate(device.id),
      );
      expect(sighted.uacInterceptionEnabled).toBe(true);
    });

    it('patch source: a partner-wide policy is INVISIBLE without breeze.current_partner_id', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const policyId = await seedPatchPolicy({ orgId: null, partnerId: partner.id }, true);
      await assign(policyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        buildPatchSourceConfigUpdate(device.id),
      );
      expect(blind.exclusiveWindowsUpdate).toBe(false);

      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        buildPatchSourceConfigUpdate(device.id),
      );
      expect(sighted.exclusiveWindowsUpdate).toBe(true);
    });

    it('writes stay locked: the org context still cannot UPDATE or DELETE the partner-wide policy', async () => {
      // The branch is FOR SELECT only. Postgres never consults FOR SELECT
      // policies when computing UPDATE/DELETE target rows, so the row stays
      // untargetable — it is HIDDEN from the write, which is a silent 0 rows,
      // not a 42501. Asserting the row count is the only way to see that; an
      // `expect(...).rejects` here would be vacuous.
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const policyId = await seedEventLogPolicy({ orgId: null, partnerId: partner.id }, 555);

      await withDbAccessContext(orgContext(org!.id, partner.id), async () => {
        const updated = await db.execute(
          sql`update configuration_policies set name = 'hijacked' where id = ${policyId}`,
        );
        expect((updated as unknown as { count: number }).count).toBe(0);

        const deleted = await db.execute(
          sql`delete from configuration_policies where id = ${policyId}`,
        );
        expect((deleted as unknown as { count: number }).count).toBe(0);
      });

      // ...and the row is still there, unchanged.
      const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .select({ name: configurationPolicies.name })
          .from(configurationPolicies)
          .where(eq(configurationPolicies.id, policyId)),
      );
      expect(row?.name).not.toBe('hijacked');
    });
  });
});
