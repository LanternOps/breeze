/**
 * Warranty Alert Evaluator
 *
 * Evaluates warranty expiry against config policy thresholds
 * and creates alerts when warranties are nearing expiration.
 */

import { db } from '../db';
import {
  deviceWarranty,
  devices,
  alerts,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configurationPolicies,
  deviceGroupMemberships,
  organizations,
} from '../db/schema';
import { eq, and, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { buildResolveAlertCas } from './alertService';
import { policyOwnershipCondition } from './configPolicyOwnership';
import { publishEvent } from './eventBus';
import { captureException } from './sentry';

interface WarrantyAlertSettings {
  enabled: boolean;
  warnDays: number;
  criticalDays: number;
}

// Threshold defaults applied ONLY when an active warranty feature link exists but
// omits a specific field. The `enabled` value here is the per-link default used
// when a link is present without an explicit `enabled` flag — it is NOT the
// no-policy default. Warranty alerting is opt-in: with no assigned/active warranty
// config policy, settings resolve to DISABLED_SETTINGS so no alert fires (#1320).
const DEFAULT_SETTINGS: WarrantyAlertSettings = {
  enabled: true,
  warnDays: 90,
  criticalDays: 30,
};

// Returned whenever there is no warranty policy in effect for a device, so the
// `if (!settings.enabled) return null` gate trips and no alert is created.
const DISABLED_SETTINGS: WarrantyAlertSettings = {
  enabled: false,
  warnDays: DEFAULT_SETTINGS.warnDays,
  criticalDays: DEFAULT_SETTINGS.criticalDays,
};

/**
 * Resolve warranty inline settings for a device from configuration policies.
 * Uses a simplified resolution (closest-wins) without requiring auth context.
 *
 * Warranty alerting is opt-in: if no active warranty config policy is assigned to
 * the device (directly or via group/site/org/partner), this returns
 * DISABLED_SETTINGS so no alert fires (#1320).
 */
async function resolveWarrantySettings(deviceId: string): Promise<WarrantyAlertSettings> {
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return DISABLED_SETTINGS;

  // The device org's partner. Needed twice below: a `level='partner'` assignment
  // targets `partners.id`, and a partner-wide policy carries `org_id NULL`.
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // Not reachable by the schema: `devices.org_id` is NOT NULL with an FK to
  // `organizations.id`, and `organizations.partner_id` is itself NOT NULL. So an
  // empty result means the invariant broke (org deleted mid-evaluation, or a
  // caller whose context cannot see its own device's org). Say it out loud —
  // falling through quietly would resolve in exactly the org-only way #3963
  // exists to fix, just one join upstream, and be indistinguishable from
  // "correctly found no policy". Resolution continues so warranty alerting
  // degrades rather than throwing.
  if (!org) {
    console.error(
      `[warranty] org ${device.orgId} for device ${deviceId} did not resolve; partner-wide warranty policies cannot apply to this evaluation`
    );
    captureException(
      new Error(`warranty: organizations row missing for device org ${device.orgId}`)
    );
  }

  // Get device group IDs
  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  // Find warranty feature links from active policies assigned to this device.
  // Priority: device > device_group > site > organization > partner (closest wins).
  //
  // `config_policy_assignments.targetId` is POLYMORPHIC — its referent depends on
  // `level` ('device' → devices.id, 'device_group' → device_groups.id, 'site' →
  // sites.id, 'organization' → organizations.id, 'partner' → **partners.id**).
  // So every id is matched against its OWN level rather than thrown into one
  // `inArray` bag; that bag had no partner id in it at all, which is why a
  // partner-level warranty assignment could never match (#3963, same shape as
  // #3954/#3962). This mirrors `resolveDeviceEventLogSettings` in
  // routes/agents/helpers.ts, the canonical hierarchy resolver.
  const targetConditions: SQL[] = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId))!,
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId))!,
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!
    );
  }
  if (device.siteId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId))!
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!
    );
  }

  const rows = await db
    .select({
      inlineSettings: configPolicyFeatureLinks.inlineSettings,
      level: configPolicyAssignments.level,
      priority: configPolicyAssignments.priority,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(
      configurationPolicies,
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id)
    )
    .innerJoin(
      configPolicyAssignments,
      eq(configPolicyAssignments.configPolicyId, configurationPolicies.id)
    )
    .where(
      and(
        eq(configPolicyFeatureLinks.featureType, 'warranty'),
        eq(configurationPolicies.status, 'active'),
        // Ownership axis, distinct from the assignment axis above: a
        // partner-wide policy is `org_id NULL` + `partner_id` set (#1724), so a
        // resolver must admit both shapes. Warranty was the one hierarchy
        // resolver that never got the #2930 predicate.
        policyOwnershipCondition({ orgId: device.orgId, partnerId: org?.partnerId ?? null }),
        or(...targetConditions)
      )
    );

  // No active warranty policy assigned to this device → alerting is opt-in, so
  // resolve to disabled rather than the enabled-by-default thresholds (#1320).
  if (rows.length === 0) return DISABLED_SETTINGS;

  // Sort by level priority (device=5, device_group=4, site=3, org=2, partner=1)
  const levelPriority: Record<string, number> = {
    device: 5,
    device_group: 4,
    site: 3,
    organization: 2,
    partner: 1,
  };

  rows.sort((a, b) => {
    const la = levelPriority[a.level] ?? 0;
    const lb = levelPriority[b.level] ?? 0;
    if (la !== lb) return lb - la; // higher level priority wins
    return b.priority - a.priority; // higher priority number wins
  });

  const inline = rows[0]!.inlineSettings as Partial<WarrantyAlertSettings> | null;
  if (!inline) return DEFAULT_SETTINGS;

  return {
    enabled: inline.enabled ?? DEFAULT_SETTINGS.enabled,
    warnDays: inline.warnDays ?? DEFAULT_SETTINGS.warnDays,
    criticalDays: inline.criticalDays ?? DEFAULT_SETTINGS.criticalDays,
  };
}

/**
 * Evaluate warranty expiry alerts for a device.
 * Called after warranty data is synced.
 */
export async function evaluateWarrantyAlerts(deviceId: string): Promise<string | null> {
  // Load warranty data
  const [warranty] = await db
    .select()
    .from(deviceWarranty)
    .where(eq(deviceWarranty.deviceId, deviceId))
    .limit(1);

  if (!warranty || warranty.status === 'unknown' || !warranty.warrantyEndDate) {
    return null;
  }

  // Active AppleCare subscription: the reported end date is the next renewal/billing
  // date, not a true expiry, so it perpetually rolls ~30 days forward. A renewing
  // subscription is the opposite of expiring — never alert, and clear any stale
  // expiry alert left over from before the subscription was detected (#1320).
  if (warranty.isSubscription || warranty.status === 'subscription_active') {
    await autoResolveWarrantyAlerts(deviceId);
    return null;
  }

  // Load device info
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return null;

  // Quick Support exclusion: ephemeral devices live in the hidden per-partner
  // 'quick_support' org and are a stranger's personal machine borrowed for one
  // ~20-minute session. That org stays inside technicians' accessibleOrgIds for
  // RLS reasons, so nothing upstream filters them. Raising a warranty-expiry
  // alert about someone's home laptop pages a technician over a machine the MSP
  // does not own and cannot service.
  if (device.isEphemeral) return null;

  // Resolve warranty config policy settings
  const settings = await resolveWarrantySettings(deviceId);

  if (!settings.enabled) {
    // Warranty alerting is opt-in (#1320). When it resolves to disabled (no/inactive
    // policy, or an explicitly-disabled link) we must still clear any existing open
    // warranty alert — otherwise a device that had an alert created under the old
    // enabled-by-default behavior keeps it stranded active/acknowledged/suppressed
    // forever, because no later evaluation reaches the auto-resolve paths below.
    await autoResolveWarrantyAlerts(deviceId);
    return null;
  }

  // Calculate days remaining
  const endDate = new Date(warranty.warrantyEndDate);
  const now = new Date();
  const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  // Determine severity
  let severity: 'critical' | 'high' | null = null;
  let title = '';
  let message = '';
  const deviceName = device.displayName || device.hostname;

  if (daysRemaining <= 0) {
    severity = 'critical';
    title = `Warranty expired: ${deviceName}`;
    message = `The warranty for ${deviceName} (${warranty.manufacturer?.toUpperCase()}, S/N: ${warranty.serialNumber}) expired on ${warranty.warrantyEndDate}.`;
  } else if (daysRemaining <= settings.criticalDays) {
    severity = 'critical';
    title = `Warranty expires in ${daysRemaining} days: ${deviceName}`;
    message = `The warranty for ${deviceName} (${warranty.manufacturer?.toUpperCase()}, S/N: ${warranty.serialNumber}) expires on ${warranty.warrantyEndDate} (${daysRemaining} days remaining).`;
  } else if (daysRemaining <= settings.warnDays) {
    severity = 'high';
    title = `Warranty expires in ${daysRemaining} days: ${deviceName}`;
    message = `The warranty for ${deviceName} (${warranty.manufacturer?.toUpperCase()}, S/N: ${warranty.serialNumber}) expires on ${warranty.warrantyEndDate} (${daysRemaining} days remaining).`;
  }

  if (!severity) {
    // Warranty is not expiring soon — auto-resolve any existing warranty alerts
    await autoResolveWarrantyAlerts(deviceId);
    return null;
  }

  // Check for existing open warranty alert for this device
  const [existingAlert] = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.deviceId, deviceId),
        eq(alerts.configItemName, 'warranty_expiry'),
        inArray(alerts.status, ['active', 'acknowledged', 'suppressed'])
      )
    )
    .limit(1);

  if (existingAlert) {
    return null;
  }

  // A user-dismissed warranty alert is a durable opt-out for THIS warranty end
  // date — never re-create it (that was the whole point of dismissing). Scoped
  // to the recorded end date so a warranty that is later RENEWED and then
  // approaches its new expiry alerts again; legacy dismissed rows with no
  // recorded end date block re-creation unconditionally.
  const [dismissedAlert] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.deviceId, deviceId),
        eq(alerts.configItemName, 'warranty_expiry'),
        eq(alerts.status, 'dismissed'),
        sql`((${alerts.context} ->> 'warrantyEndDate') IS NULL OR (${alerts.context} ->> 'warrantyEndDate') = ${warranty.warrantyEndDate})`
      )
    )
    .limit(1);

  if (dismissedAlert) {
    return null;
  }

  // Create alert
  const [newAlert] = await db
    .insert(alerts)
    .values({
      ruleId: null,
      deviceId,
      orgId: device.orgId,
      configPolicyId: null,
      configItemName: 'warranty_expiry',
      severity,
      title,
      message,
      context: {
        warrantyEndDate: warranty.warrantyEndDate,
        daysRemaining,
        manufacturer: warranty.manufacturer,
        serialNumber: warranty.serialNumber,
        source: 'warranty_evaluator',
      },
      status: 'active',
      triggeredAt: new Date(),
    })
    .returning();

  if (newAlert) {
    await publishEvent(
      'alert.triggered',
      device.orgId,
      {
        alertId: newAlert.id,
        deviceId,
        severity,
        title,
        message,
        source: 'warranty_evaluator',
      },
      'warranty-alert-evaluator'
    );

    console.log(`[WarrantyAlertEvaluator] Created warranty alert ${newAlert.id} for device ${deviceId}`);
    return newAlert.id;
  }

  return null;
}

/**
 * Auto-resolve existing warranty alerts for a device
 */
async function autoResolveWarrantyAlerts(deviceId: string): Promise<void> {
  // Resolve every non-terminal state the dedupe gate (line ~207) considers
  // "open" — otherwise a stale expiry alert on a now-subscription/no-longer-
  // expiring device would never clear yet still block a fresh alert from being
  // created (#1320). Two deliberate exclusions:
  //   - 'dismissed' is terminal: it stays dismissed forever.
  //   - indefinitely-suppressed rows (status 'suppressed' with NULL
  //     suppressedUntil, i.e. the user chose "Forever" in #2110) survive
  //     transient exits from the alert window (AppleCare flaps, refreshed end
  //     dates). Auto-resolving them destroyed the user's mute: the next time
  //     the device re-entered the window, a brand-new ACTIVE alert was created.
  //     Leaving the row suppressed keeps the dedupe gate blocking re-creation,
  //     which is exactly what "Forever" promised. Timed suppressions still
  //     auto-resolve — their mute was never meant to outlive the condition.
  const openAlerts = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.deviceId, deviceId),
        eq(alerts.configItemName, 'warranty_expiry'),
        or(
          inArray(alerts.status, ['active', 'acknowledged']),
          and(eq(alerts.status, 'suppressed'), isNotNull(alerts.suppressedUntil))
        )
      )
    );

  let lost = 0;

  for (const alert of openAlerts) {
    // Winner-takes-all (#4094): the status predicate, not the read above, decides
    // whether this evaluator performed the transition. Updating by id alone let a
    // technician's resolve and this sweep both publish `alert.resolved` for one
    // real transition.
    const resolvedAt = new Date();
    const written = await db
      .update(alerts)
      .set({
        status: 'resolved',
        resolvedAt,
        resolutionNote: 'Auto-resolved: warranty no longer expiring within threshold',
      })
      .where(buildResolveAlertCas(alert.id))
      .returning({ id: alerts.id });

    if (written.length === 0) {
      lost += 1;
      continue;
    }

    await publishEvent(
      'alert.resolved',
      alert.orgId,
      {
        alertId: alert.id,
        deviceId,
        resolutionNote: 'Auto-resolved: warranty no longer expiring within threshold',
        resolvedAt: resolvedAt.toISOString(),
        resolvedBy: null,
        triggeredAt: alert.triggeredAt.toISOString(),
      },
      'warranty-alert-evaluator'
    );
  }

  // Losing an individual CAS is normal — a technician got there first — so this
  // deliberately does NOT log per loss. Losing EVERY candidate is different: this
  // sweep is the only routine resolver of warranty_expiry alerts, so a total
  // shortfall is the shape an RLS write-policy divergence would take, and under
  // `breeze_app` such a write raises no error at all. One aggregate line per
  // invocation gives that failure somewhere to show up instead of looking
  // identical to "nothing needed resolving".
  if (lost > 0 && lost === openAlerts.length) {
    console.warn(
      `[WarrantyAlertEvaluator] auto-resolve transitioned 0 of ${openAlerts.length} open ` +
      `warranty alert(s) for device ${deviceId}; every compare-and-swap matched no rows.`
    );
  }
}
