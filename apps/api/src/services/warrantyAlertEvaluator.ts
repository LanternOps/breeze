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
} from '../db/schema';
import { eq, and, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { buildResolveAlertCas, createSourcedAlert } from './alertService';
import { publishEvent } from './eventBus';
import { resolveEffectiveWarrantyInlineSettings } from './warrantyPolicyResolution';

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
 * Resolve warranty ALERT thresholds for a device from configuration policies.
 *
 * The hierarchy resolution itself lives in warrantyPolicyResolution.ts and is
 * shared with the heartbeat's HP CMSL delivery (#5511 W02, D6) — a second copy
 * would drift from this one's #3963 and #2930 fixes.
 *
 * Warranty alerting is opt-in: if no active warranty config policy is assigned
 * to the device (directly or via group/site/org/partner), this returns
 * DISABLED_SETTINGS so no alert fires (#1320). A policy that resolves with a
 * null blob is a different case and keeps the per-link DEFAULT_SETTINGS.
 */
async function resolveWarrantySettings(deviceId: string): Promise<WarrantyAlertSettings> {
  const inlineSettings = await resolveEffectiveWarrantyInlineSettings(deviceId);
  if (inlineSettings === undefined) return DISABLED_SETTINGS;

  const inline = inlineSettings as Partial<WarrantyAlertSettings> | null;
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

  // Create alert. Routed through createSourcedAlert so a failed publish rolls
  // the row back instead of leaving a silent alert the dedupe above would then
  // treat as "already open" forever (#5325).
  const alertId = await createSourcedAlert({
    deviceId,
    orgId: device.orgId,
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
    configItemName: 'warranty_expiry',
    publisher: 'warranty-alert-evaluator',
  });

  if (alertId) {
    console.log(`[WarrantyAlertEvaluator] Created warranty alert ${alertId} for device ${deviceId}`);
    return alertId;
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
