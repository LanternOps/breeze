/**
 * Partner-LEVEL config-policy assignments reach the warranty evaluator and the
 * event-log retention worker (#3963).
 *
 * Two axes decide whether an MSP's "all organizations" policy actually applies
 * to a device or an org, and they are routinely confused:
 *
 *   1. OWNERSHIP — `configuration_policies` is org-owned (`org_id` set,
 *      `partner_id NULL`) or partner-owned (`org_id NULL`, `partner_id` set),
 *      the XOR from #1724. `policyOwnershipCondition` (#2930) is what admits the
 *      second shape; a bare `org_id = <device org>` never matches it.
 *   2. ASSIGNMENT — `config_policy_assignments.target_id` is POLYMORPHIC: its
 *      referent depends on `level` ('device' → devices.id … 'partner' →
 *      **partners.id**). A reader that only ever compares `target_id` against
 *      org/site/device ids can never match a `level='partner'` row.
 *
 * Both readers under test were broken on axis 2 (and warranty on axis 1 as
 * well), so a partner-wide policy saved fine in the UI and then silently did
 * nothing — no error, no log line, because an org-axis-only predicate returns
 * ZERO ROWS rather than failing. Same shape as #3954 (update-ring device count,
 * fixed in #3962); these are instances three and four.
 *
 * Why this file is real-Postgres and not a unit test: both bugs lived entirely
 * inside a `.where()` clause. Every mocked Drizzle suite in this repo uses a
 * chainable stub that ignores `.where()` arguments and returns whatever rows it
 * was handed, so a mocked test passes identically before and after the fix. The
 * only thing that can discriminate is Postgres actually evaluating the
 * predicate.
 *
 * Contexts under test mirror production exactly (verified, not assumed):
 *   - `getOrgEventLogRetentionDays` runs SYSTEM-scoped — `jobs/eventLogRetention.ts`
 *     wraps each per-org call in `runOutsideDbContext(withSystemDbAccessContext(...))`.
 *   - `evaluateWarrantyAlerts` runs BOTH ways: SYSTEM-scoped from the BullMQ
 *     warranty worker (`services/warrantyWorker.ts` → `warrantySync.ts`), and
 *     ORG-scoped from the agent inventory route (`PUT /agents/:id/warranty-info`
 *     → `upsertAgentWarranty`), which inherits `agentAuthMiddleware`'s
 *     organization context. Only the second is RLS-gated, so it gets its own
 *     case plus a negative control.
 *
 * The `agentBlindContext` case is what makes the org-scoped half a proof rather
 * than a tautology: it runs the same reader with `currentPartnerId: null` and
 * requires the partner-wide policy to be INVISIBLE. That pins the
 * `<table>_partner_wide_select` RLS branch (#4673 W01/W02) as the thing doing
 * the work — if a system-context escape were ever reintroduced, the row would
 * resolve under that context too and the assertion would fail.
 */
import './setup';

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  alerts,
  configPolicyAssignments,
  configPolicyEventLogSettings,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceWarranty,
  devices,
} from '../../db/schema';
import { evaluateWarrantyAlerts } from '../../services/warrantyAlertEvaluator';
import { EVENT_LOG_DEFAULTS, getOrgEventLogRetentionDays } from '../../routes/agents/helpers';
import { createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

/**
 * The real agent-request shape, as `middleware/agentAuth.ts` builds it: an
 * org-scoped context that carries the DEVICE ORG'S partner in `currentPartnerId`
 * while `accessiblePartnerIds` stays empty. The two are different axes —
 * `accessiblePartnerIds` gates `breeze_has_partner_access` (partner-axis WRITES,
 * which an agent never gets); `currentPartnerId` feeds the `breeze.current_partner_id`
 * GUC that the SELECT-only `*_partner_wide_select` policies read.
 */
function agentContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/** The same context minus the GUC — the negative control described in the header. */
function agentBlindContext(orgId: string): DbAccessContext {
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
      await db.delete(alerts).where(eq(alerts.deviceId, id));
      await db.delete(deviceWarranty).where(eq(deviceWarranty.deviceId, id));
      await db.delete(devices).where(eq(devices.id, id));
    }
    for (const id of createdPolicies) {
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    }
  });
  createdDevices.length = 0;
  createdPolicies.length = 0;
});

type PolicyOwner = { orgId: string | null; partnerId: string | null };
type AssignmentLevel = 'partner' | 'organization';

/** ISO `YYYY-MM-DD` date `days` from now. */
function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

// db-utils writes on the privileged test connection, not the RLS-forced app
// pool, so these need no DbAccessContext of their own.
async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });
  return { partner: partner!, org: org!, site: site! };
}

/** A device with a warranty expiring inside the default 30-day critical window. */
async function seedDeviceWithExpiringWarranty(orgId: string, siteId: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const unique = randomUUID().slice(0, 8);
    const [device] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `pl-agent-${unique}`,
        hostname: `pl-host-${unique}`,
        osType: 'macos',
        osVersion: '14',
        architecture: 'arm64',
        agentVersion: '0.0.0-test',
        status: 'offline',
        deviceRole: 'workstation',
      })
      .returning();
    createdDevices.push(device!.id);

    await db.insert(deviceWarranty).values({
      deviceId: device!.id,
      orgId,
      manufacturer: 'apple',
      serialNumber: `SN-${unique}`,
      status: 'expiring',
      warrantyEndDate: inDays(10),
      isSubscription: false,
    });

    return device!;
  });
}

/**
 * A warranty policy whose feature link carries inline settings. `enabled` is the
 * discriminator: an enabled policy that resolves produces an alert, a disabled
 * one produces null, so precedence is observable through the return value.
 */
async function seedWarrantyPolicy(owner: PolicyOwner, enabled: boolean) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: `warranty policy ${randomUUID()}`,
        status: 'active',
      })
      .returning();
    createdPolicies.push(policy!.id);
    await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id,
      featureType: 'warranty',
      inlineSettings: { enabled, warnDays: 90, criticalDays: 30 },
    });
    return policy!.id;
  });
}

/** An event_log policy whose retentionDays is the discriminator. */
async function seedEventLogPolicy(owner: PolicyOwner, retentionDays: number) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: `event_log policy ${randomUUID()}`,
        status: 'active',
      })
      .returning();
    createdPolicies.push(policy!.id);
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'event_log' })
      .returning();
    await db.insert(configPolicyEventLogSettings).values({
      featureLinkId: link!.id,
      retentionDays,
    });
    return policy!.id;
  });
}

async function assign(configPolicyId: string, level: AssignmentLevel, targetId: string, priority = 0) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    await db.insert(configPolicyAssignments).values({ configPolicyId, level, targetId, priority });
  });
}

describe('warranty evaluator honours partner-level assignments (#3963)', () => {
  it('applies a partner-wide warranty policy from the SYSTEM-scoped warranty worker', async () => {
    const { partner, org, site } = await seedTenant();
    const device = await seedDeviceWithExpiringWarranty(org.id, site.id);
    const policyId = await seedWarrantyPolicy({ orgId: null, partnerId: partner.id }, true);
    await assign(policyId, 'partner', partner.id);

    // Before the fix `targetIds` held no partner id at all, so this resolved to
    // DISABLED_SETTINGS and returned null — a partner-wide warranty policy
    // could never fire an alert for anyone.
    const alertId = await withDbAccessContext(SYSTEM_CTX, () => evaluateWarrantyAlerts(device.id));

    expect(alertId).not.toBeNull();
  });

  it('applies a partner-wide warranty policy on the ORG-scoped agent inventory path', async () => {
    const { partner, org, site } = await seedTenant();
    const device = await seedDeviceWithExpiringWarranty(org.id, site.id);
    const policyId = await seedWarrantyPolicy({ orgId: null, partnerId: partner.id }, true);
    await assign(policyId, 'partner', partner.id);

    // `PUT /agents/:id/warranty-info` reaches this evaluator inside
    // agentAuthMiddleware's organization context, so the read is RLS-gated and
    // only the `*_partner_wide_select` branch makes an org_id NULL policy legible.
    const alertId = await withDbAccessContext(agentContext(org.id, partner.id), () =>
      evaluateWarrantyAlerts(device.id)
    );

    expect(alertId).not.toBeNull();
  });

  it('does NOT see the partner-wide policy without currentPartnerId — the RLS branch is load-bearing', async () => {
    const { partner, org, site } = await seedTenant();
    const device = await seedDeviceWithExpiringWarranty(org.id, site.id);
    const policyId = await seedWarrantyPolicy({ orgId: null, partnerId: partner.id }, true);
    await assign(policyId, 'partner', partner.id);

    // Same reader, same fixture, GUC omitted. If this ever passes, something has
    // reintroduced a system-context escape (or a bypass) around the policy read.
    const alertId = await withDbAccessContext(agentBlindContext(org.id), () =>
      evaluateWarrantyAlerts(device.id)
    );

    expect(alertId).toBeNull();
  });

  it('keeps partner as the LOWEST precedence — an org-level policy still wins', async () => {
    const { partner, org, site } = await seedTenant();
    const device = await seedDeviceWithExpiringWarranty(org.id, site.id);

    const partnerPolicyId = await seedWarrantyPolicy({ orgId: null, partnerId: partner.id }, true);
    await assign(partnerPolicyId, 'partner', partner.id);
    const orgPolicyId = await seedWarrantyPolicy({ orgId: org.id, partnerId: null }, false);
    await assign(orgPolicyId, 'organization', org.id);

    // The org-level link is explicitly disabled. If partner were allowed to
    // outrank organization, this would create an alert.
    const alertId = await withDbAccessContext(SYSTEM_CTX, () => evaluateWarrantyAlerts(device.id));

    expect(alertId).toBeNull();
  });

  it('still applies a partner-OWNED policy assigned at ORGANIZATION level', async () => {
    const { partner, org, site } = await seedTenant();
    const device = await seedDeviceWithExpiringWarranty(org.id, site.id);
    const policyId = await seedWarrantyPolicy({ orgId: null, partnerId: partner.id }, true);
    await assign(policyId, 'organization', org.id);

    // Guards the OTHER half of this fix. The warranty query previously had no
    // ownership predicate at all, so an `org_id NULL` policy scoped to one org
    // resolved by accident. Adding `policyOwnershipCondition` must not narrow
    // that working case away — it admits the partner-owned shape explicitly.
    const alertId = await withDbAccessContext(SYSTEM_CTX, () => evaluateWarrantyAlerts(device.id));

    expect(alertId).not.toBeNull();
  });

  it('does not apply another partner’s partner-wide warranty policy', async () => {
    const { org, site } = await seedTenant();
    const device = await seedDeviceWithExpiringWarranty(org.id, site.id);

    const otherPartner = await createPartner();
    const policyId = await seedWarrantyPolicy({ orgId: null, partnerId: otherPartner!.id }, true);
    await assign(policyId, 'partner', otherPartner!.id);

    // System scope bypasses RLS entirely, so the app-layer predicate is the only
    // thing standing between this device and a foreign MSP's policy.
    const alertId = await withDbAccessContext(SYSTEM_CTX, () => evaluateWarrantyAlerts(device.id));

    expect(alertId).toBeNull();
  });
});

describe('event-log retention honours partner-level assignments (#3963)', () => {
  const NON_DEFAULT_PARTNER_DAYS = 7;
  const NON_DEFAULT_ORG_DAYS = 14;

  it('resolves a partner-wide retention policy instead of silently defaulting to 30 days', async () => {
    const { partner, org } = await seedTenant();
    const policyId = await seedEventLogPolicy({ orgId: null, partnerId: partner.id }, NON_DEFAULT_PARTNER_DAYS);
    await assign(policyId, 'partner', partner.id);

    // Before the fix this filtered on level='organization' only, so the
    // partner-level row matched nothing and `?? 30` took over — an MSP that set
    // fleet-wide retention got 30 days on every org, silently.
    const days = await withDbAccessContext(SYSTEM_CTX, () => getOrgEventLogRetentionDays(org.id));

    expect(days).toBe(NON_DEFAULT_PARTNER_DAYS);
    expect(days).not.toBe(EVENT_LOG_DEFAULTS.retentionDays);
  });

  it('lets an org-level assignment outrank the partner-wide one', async () => {
    const { partner, org } = await seedTenant();
    const partnerPolicyId = await seedEventLogPolicy({ orgId: null, partnerId: partner.id }, NON_DEFAULT_PARTNER_DAYS);
    await assign(partnerPolicyId, 'partner', partner.id);
    const orgPolicyId = await seedEventLogPolicy({ orgId: org.id, partnerId: null }, NON_DEFAULT_ORG_DAYS);
    await assign(orgPolicyId, 'organization', org.id);

    const days = await withDbAccessContext(SYSTEM_CTX, () => getOrgEventLogRetentionDays(org.id));

    expect(days).toBe(NON_DEFAULT_ORG_DAYS);
  });

  it('breaks an org-level tie on assignment priority ASC, unchanged from before', async () => {
    const { org } = await seedTenant();
    const winnerId = await seedEventLogPolicy({ orgId: org.id, partnerId: null }, NON_DEFAULT_ORG_DAYS);
    await assign(winnerId, 'organization', org.id, 0);
    const loserId = await seedEventLogPolicy({ orgId: org.id, partnerId: null }, 99);
    await assign(loserId, 'organization', org.id, 5);

    const days = await withDbAccessContext(SYSTEM_CTX, () => getOrgEventLogRetentionDays(org.id));

    expect(days).toBe(NON_DEFAULT_ORG_DAYS);
  });

  it('does not apply another partner’s partner-wide retention policy', async () => {
    const { org } = await seedTenant();
    const otherPartner = await createPartner();
    const policyId = await seedEventLogPolicy({ orgId: null, partnerId: otherPartner!.id }, NON_DEFAULT_PARTNER_DAYS);
    await assign(policyId, 'partner', otherPartner!.id);

    const days = await withDbAccessContext(SYSTEM_CTX, () => getOrgEventLogRetentionDays(org.id));

    expect(days).toBe(EVENT_LOG_DEFAULTS.retentionDays);
  });

  it('still falls back to the default when no event_log policy applies', async () => {
    const { org } = await seedTenant();

    const days = await withDbAccessContext(SYSTEM_CTX, () => getOrgEventLogRetentionDays(org.id));

    expect(days).toBe(EVENT_LOG_DEFAULTS.retentionDays);
  });
});
