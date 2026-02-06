/**
 * Alert Service
 *
 * Core alert lifecycle management:
 * - Create alerts with deduplication and cooldown
 * - Find applicable rules for devices
 * - Auto-resolve alerts when conditions clear
 * - Interpolate template strings
 */

import { db } from '../db';
import {
  alerts,
  alertRules,
  alertTemplates,
  devices,
  deviceGroups,
  deviceGroupMemberships,
  sites
} from '../db/schema';
import { eq, and, inArray, isNull, or } from 'drizzle-orm';
import { evaluateConditions, evaluateAutoResolveConditions, interpolateTemplate } from './alertConditions';
import { isCooldownActive, setCooldown, clearCooldown } from './alertCooldown';
import { publishEvent } from './eventBus';

// Types for alert creation
export interface CreateAlertParams {
  ruleId: string;
  deviceId: string;
  orgId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  message: string;
  context?: Record<string, unknown>;
}

// Rule with template info for evaluation
export interface RuleWithTemplate {
  rule: typeof alertRules.$inferSelect;
  template: typeof alertTemplates.$inferSelect;
  effectiveConditions: unknown;
  effectiveSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  effectiveCooldownMinutes: number;
  notificationChannelIds: string[];
  escalationPolicyId?: string;
}

/**
 * Create a new alert
 * - Checks cooldown to prevent duplicates
 * - Deduplicates against existing active alerts
 * - Publishes alert.triggered event
 *
 * @returns Created alert ID, or null if blocked by cooldown/dedupe
 */
export async function createAlert(params: CreateAlertParams): Promise<string | null> {
  const { ruleId, deviceId, orgId, severity, title, message, context } = params;

  // Get the rule to check cooldown settings
  const [rule] = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.id, ruleId))
    .limit(1);

  if (!rule) {
    console.warn(`[AlertService] Rule ${ruleId} not found`);
    return null;
  }

  // Get template for cooldown setting
  const [template] = await db
    .select()
    .from(alertTemplates)
    .where(eq(alertTemplates.id, rule.templateId))
    .limit(1);

  // Check override or template cooldown
  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  const cooldownMinutes = (overrides?.cooldownMinutes as number) ??
    template?.cooldownMinutes ?? 5;

  // Check cooldown
  const cooldownActive = await isCooldownActive(ruleId, deviceId);
  if (cooldownActive) {
    console.log(`[AlertService] Cooldown active for rule=${ruleId} device=${deviceId}`);
    return null;
  }

  // Check for existing active alert (dedupe)
  const [existingAlert] = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.ruleId, ruleId),
        eq(alerts.deviceId, deviceId),
        eq(alerts.status, 'active')
      )
    )
    .limit(1);

  if (existingAlert) {
    console.log(`[AlertService] Active alert already exists for rule=${ruleId} device=${deviceId}`);
    return null;
  }

  // Create the alert
  const [newAlert] = await db
    .insert(alerts)
    .values({
      ruleId,
      deviceId,
      orgId,
      severity,
      title,
      message,
      context: context ?? {},
      status: 'active',
      triggeredAt: new Date()
    })
    .returning();

  if (!newAlert) {
    console.error('[AlertService] Failed to create alert');
    return null;
  }

  // Set cooldown
  await setCooldown(ruleId, deviceId, cooldownMinutes);

  // Publish event
  await publishEvent(
    'alert.triggered',
    orgId,
    {
      alertId: newAlert.id,
      ruleId,
      deviceId,
      severity,
      title,
      message
    },
    'alert-service'
  );

  console.log(`[AlertService] Created alert ${newAlert.id} for rule=${ruleId} device=${deviceId}`);

  return newAlert.id;
}

/**
 * Check if an alert should be auto-resolved
 * Evaluates auto-resolve conditions and resolves if met
 *
 * @returns true if alert was auto-resolved
 */
export async function checkAutoResolve(alertId: string): Promise<boolean> {
  // Get the alert
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert || alert.status !== 'active') {
    return false;
  }

  // Get rule and template
  const [rule] = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.id, alert.ruleId))
    .limit(1);

  if (!rule) {
    return false;
  }

  const [template] = await db
    .select()
    .from(alertTemplates)
    .where(eq(alertTemplates.id, rule.templateId))
    .limit(1);

  if (!template) {
    return false;
  }

  // Check if auto-resolve is enabled
  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  const autoResolve = (overrides?.autoResolve as boolean) ?? template.autoResolve;

  if (!autoResolve) {
    return false;
  }

  // Get auto-resolve conditions (inverse conditions)
  const autoResolveConditions = (overrides?.autoResolveConditions as unknown) ??
    template.autoResolveConditions;

  if (!autoResolveConditions) {
    // If no specific auto-resolve conditions, use inverse of trigger conditions
    const triggerConditions = (overrides?.conditions as unknown) ?? template.conditions;
    const result = await evaluateConditions(triggerConditions, alert.deviceId);

    // Auto-resolve if trigger conditions are NO LONGER met
    if (!result.triggered) {
      await resolveAlert(alertId, 'Auto-resolved: conditions cleared');
      return true;
    }
  } else {
    // Evaluate specific auto-resolve conditions
    const result = await evaluateAutoResolveConditions(autoResolveConditions, alert.deviceId);

    if (result.shouldResolve) {
      await resolveAlert(alertId, `Auto-resolved: ${result.reason}`);
      return true;
    }
  }

  return false;
}

/**
 * Resolve an alert
 */
export async function resolveAlert(
  alertId: string,
  resolutionNote?: string,
  resolvedBy?: string
): Promise<void> {
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return;

  await db
    .update(alerts)
    .set({
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: resolvedBy ?? null,
      resolutionNote: resolutionNote ?? null
    })
    .where(eq(alerts.id, alertId));

  // Clear cooldown so alert can trigger again if needed
  await clearCooldown(alert.ruleId, alert.deviceId);

  // Publish event
  await publishEvent(
    'alert.resolved',
    alert.orgId,
    {
      alertId,
      ruleId: alert.ruleId,
      deviceId: alert.deviceId,
      resolutionNote
    },
    'alert-service'
  );

  console.log(`[AlertService] Resolved alert ${alertId}`);
}

/**
 * Get all applicable rules for a device
 * Rules can target: all, org, site, group, or specific device
 */
export async function getApplicableRules(deviceId: string): Promise<RuleWithTemplate[]> {
  // Get device info
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return [];
  }

  // Get device's group memberships
  const groupMemberships = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));

  const groupIds = groupMemberships.map(g => g.groupId);

  // Build conditions for rule matching
  const targetConditions = [
    eq(alertRules.targetType, 'all'),
    and(eq(alertRules.targetType, 'org'), eq(alertRules.targetId, device.orgId)),
    and(eq(alertRules.targetType, 'site'), eq(alertRules.targetId, device.siteId)),
    and(eq(alertRules.targetType, 'device'), eq(alertRules.targetId, deviceId))
  ];

  // Add group conditions if device is in any groups
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(alertRules.targetType, 'group'), inArray(alertRules.targetId, groupIds))
    );
  }

  // Get all active rules that apply to this device
  const rules = await db
    .select()
    .from(alertRules)
    .where(
      and(
        eq(alertRules.orgId, device.orgId),
        eq(alertRules.isActive, true),
        or(...targetConditions)
      )
    );

  if (rules.length === 0) {
    return [];
  }

  // Get templates for all rules
  const templateIds = [...new Set(rules.map(r => r.templateId))];
  const templates = await db
    .select()
    .from(alertTemplates)
    .where(inArray(alertTemplates.id, templateIds));

  const templateMap = new Map(templates.map(t => [t.id, t]));

  // Build rule-with-template objects
  const result: RuleWithTemplate[] = [];

  for (const rule of rules) {
    const template = templateMap.get(rule.templateId);
    if (!template) continue;

    const overrides = rule.overrideSettings as Record<string, unknown> | null;

    result.push({
      rule,
      template,
      effectiveConditions: (overrides?.conditions as unknown) ?? template.conditions,
      effectiveSeverity: (overrides?.severity as 'critical' | 'high' | 'medium' | 'low' | 'info') ?? template.severity,
      effectiveCooldownMinutes: (overrides?.cooldownMinutes as number) ?? template.cooldownMinutes,
      notificationChannelIds: (overrides?.notificationChannelIds as string[]) ?? [],
      escalationPolicyId: overrides?.escalationPolicyId as string | undefined
    });
  }

  return result;
}

/**
 * Evaluate all rules for a device and create alerts as needed
 * Returns list of created alert IDs
 */
export async function evaluateDeviceAlerts(deviceId: string): Promise<string[]> {
  const applicableRules = await getApplicableRules(deviceId);

  if (applicableRules.length === 0) {
    return [];
  }

  // Get device info for template interpolation
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return [];
  }

  const createdAlerts: string[] = [];

  for (const { rule, template, effectiveConditions, effectiveSeverity, effectiveCooldownMinutes } of applicableRules) {
    try {
      // Evaluate conditions
      const result = await evaluateConditions(effectiveConditions, deviceId);

      if (result.triggered) {
        // Build template context
        const templateContext: Record<string, unknown> = {
          deviceName: device.displayName || device.hostname,
          hostname: device.hostname,
          osType: device.osType,
          osVersion: device.osVersion,
          ruleName: rule.name,
          severity: effectiveSeverity,
          ...result.context
        };

        // Interpolate title and message
        const title = interpolateTemplate(template.titleTemplate, templateContext);
        const message = interpolateTemplate(template.messageTemplate, templateContext);

        // Create alert
        const alertId = await createAlert({
          ruleId: rule.id,
          deviceId,
          orgId: rule.orgId,
          severity: effectiveSeverity,
          title,
          message,
          context: {
            ...result.context,
            conditionsMet: result.conditionsMet,
            conditionsNotMet: result.conditionsNotMet,
            templateId: template.id,
            cooldownMinutes: effectiveCooldownMinutes
          }
        });

        if (alertId) {
          createdAlerts.push(alertId);
        }
      }
    } catch (error) {
      console.error(`[AlertService] Error evaluating rule ${rule.id} for device ${deviceId}:`, error);
    }
  }

  return createdAlerts;
}

/**
 * Check all active alerts for auto-resolution
 * Returns count of resolved alerts
 */
export async function checkAllAutoResolve(orgId?: string): Promise<number> {
  // Get active alerts (optionally filtered by org)
  const conditions = [eq(alerts.status, 'active')];
  if (orgId) {
    conditions.push(eq(alerts.orgId, orgId));
  }

  const activeAlerts = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(...conditions));

  let resolvedCount = 0;

  for (const alert of activeAlerts) {
    try {
      const resolved = await checkAutoResolve(alert.id);
      if (resolved) {
        resolvedCount++;
      }
    } catch (error) {
      console.error(`[AlertService] Error checking auto-resolve for alert ${alert.id}:`, error);
    }
  }

  return resolvedCount;
}

/**
 * Get alert statistics for an organization
 */
export async function getAlertStats(orgId: string): Promise<{
  active: number;
  acknowledged: number;
  resolved: number;
  suppressed: number;
  bySeverity: Record<string, number>;
}> {
  const allAlerts = await db
    .select({
      status: alerts.status,
      severity: alerts.severity
    })
    .from(alerts)
    .where(eq(alerts.orgId, orgId));

  const stats = {
    active: 0,
    acknowledged: 0,
    resolved: 0,
    suppressed: 0,
    bySeverity: {} as Record<string, number>
  };

  for (const alert of allAlerts) {
    // Count by status
    if (alert.status === 'active') stats.active++;
    else if (alert.status === 'acknowledged') stats.acknowledged++;
    else if (alert.status === 'resolved') stats.resolved++;
    else if (alert.status === 'suppressed') stats.suppressed++;

    // Count by severity (only for active/acknowledged)
    if (alert.status === 'active' || alert.status === 'acknowledged') {
      stats.bySeverity[alert.severity] = (stats.bySeverity[alert.severity] || 0) + 1;
    }
  }

  return stats;
}
