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
} from '../db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { publishEvent } from './eventBus';

interface WarrantyAlertSettings {
  enabled: boolean;
  warnDays: number;
  criticalDays: number;
}

const DEFAULT_SETTINGS: WarrantyAlertSettings = {
  enabled: true,
  warnDays: 90,
  criticalDays: 30,
};

/**
 * Resolve warranty inline settings for a device from configuration policies.
 * Uses a simplified resolution (closest-wins) without requiring auth context.
 */
async function resolveWarrantySettings(deviceId: string): Promise<WarrantyAlertSettings> {
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return DEFAULT_SETTINGS;

  // Get device group IDs
  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  // Find warranty feature links from active policies assigned to this device
  // Priority: device > device_group > site > organization > partner (closest wins)
  const targetIds = [deviceId, ...groupIds, device.siteId, device.orgId].filter(Boolean) as string[];

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
        inArray(configPolicyAssignments.targetId, targetIds)
      )
    );

  if (rows.length === 0) return DEFAULT_SETTINGS;

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

  // Load device info
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return null;

  // Resolve warranty config policy settings
  const settings = await resolveWarrantySettings(deviceId);

  if (!settings.enabled) {
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
  const openAlerts = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.deviceId, deviceId),
        eq(alerts.configItemName, 'warranty_expiry'),
        inArray(alerts.status, ['active', 'acknowledged'])
      )
    );

  for (const alert of openAlerts) {
    await db
      .update(alerts)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        resolutionNote: 'Auto-resolved: warranty no longer expiring within threshold',
      })
      .where(eq(alerts.id, alert.id));

    await publishEvent(
      'alert.resolved',
      alert.orgId,
      {
        alertId: alert.id,
        deviceId,
        resolutionNote: 'Auto-resolved: warranty no longer expiring within threshold',
      },
      'warranty-alert-evaluator'
    );
  }
}
