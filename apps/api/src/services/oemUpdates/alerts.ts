/**
 * Vendor update alerts (#11065 W03), written through the shared alert machinery
 * (`createAlert`: cooldown, dedupe on an open alert, notifications, automations),
 * never a bare insert into `alerts` (#5241).
 *
 * Same shape as `patchAlerts.ts`: GLOBAL built-in templates, an org-owned rule
 * created lazily on first fire under the `oem-updates` built-in source. W09 adds
 * overdue alerts by adding a rule name here; the source needs no new migration.
 */
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { PATCH_ALERT_CATEGORY } from '@breeze/shared';
import * as dbModule from '../../db';
import { alertRules, alertTemplates, alerts, devices } from '../../db/schema';
import { createAlert, resolveAlert, RESOLVABLE_ALERT_STATUSES } from '../alertService';
import { insertBuiltInAlertRule } from '../builtInAlertRules';
import { checkDeviceMaintenanceWindow } from '../featureConfigResolver';
import { captureException } from '../sentry';

const { db } = dbModule;

export const OEM_UPDATES_ALERT_SOURCE = 'oem-updates';

const NOT_RETURNED_RULE_NAME = 'Vendor update: device did not come back';
const PROTECTION_SUSPENDED_RULE_NAME = 'Vendor update: BitLocker still suspended';

type TemplateConfig = {
  name: string;
  severity: 'critical' | 'high';
  cooldownMinutes: number;
  titleTemplate: string;
  messageTemplate: string;
};

const NOT_RETURNED_TEMPLATE: TemplateConfig = {
  name: NOT_RETURNED_RULE_NAME,
  severity: 'critical',
  cooldownMinutes: 1440,
  titleTemplate: '{{hostname}} did not come back after a vendor update',
  messageTemplate:
    '{{hostname}} has not checked in since a BIOS or firmware update started. It may be at a BitLocker recovery prompt or a failed flash.',
};

const PROTECTION_SUSPENDED_TEMPLATE: TemplateConfig = {
  name: PROTECTION_SUSPENDED_RULE_NAME,
  severity: 'high',
  cooldownMinutes: 1440,
  titleTemplate: 'BitLocker still suspended on {{hostname}} after a vendor update',
  messageTemplate: 'BitLocker protection did not come back on {{hostname}} after a vendor update and its reboot.',
};

/**
 * The template is global and the rule org-owned, and the alert must land
 * whatever context the caller holds, so this runs under system scope. Already
 * system-scoped (the monitor tick) means run in place, not a second connection.
 */
async function runWithSystemDbAccess<T>(fn: () => Promise<T>): Promise<T> {
  if (dbModule.getCurrentDbAccessContext()?.scope === 'system') return fn();
  return dbModule.runOutsideDbContext(() => dbModule.withSystemDbAccessContext(fn));
}

async function ensureGlobalTemplate(config: TemplateConfig): Promise<string> {
  const [existing] = await db
    .select({ id: alertTemplates.id })
    .from(alertTemplates)
    .where(and(isNull(alertTemplates.orgId), isNull(alertTemplates.partnerId), eq(alertTemplates.name, config.name)))
    .orderBy(asc(alertTemplates.createdAt))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(alertTemplates)
    .values({
      orgId: null,
      partnerId: null,
      name: config.name,
      description: `Auto-generated template for ${config.name}`,
      category: PATCH_ALERT_CATEGORY,
      conditions: { source: OEM_UPDATES_ALERT_SOURCE },
      severity: config.severity,
      titleTemplate: config.titleTemplate,
      messageTemplate: config.messageTemplate,
      autoResolve: false,
      isBuiltIn: true,
      cooldownMinutes: config.cooldownMinutes,
    })
    .returning({ id: alertTemplates.id });
  if (!created) throw new Error(`[oemUpdates/alerts] failed to create template "${config.name}"`);
  return created.id;
}

async function ensureRule(orgId: string, config: TemplateConfig): Promise<string> {
  const [existing] = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .where(and(eq(alertRules.orgId, orgId), eq(alertRules.name, config.name), isNull(alertRules.retiredAt)))
    .limit(1);
  if (existing) return existing.id;

  const templateId = await ensureGlobalTemplate(config);
  return insertBuiltInAlertRule({
    orgId,
    templateId,
    name: config.name,
    overrideSettings: { source: OEM_UPDATES_ALERT_SOURCE },
  });
}

async function loadHostLabel(deviceId: string, orgId: string): Promise<string> {
  const [row] = await db
    .select({ hostname: devices.hostname })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  return row?.hostname ?? deviceId;
}

/**
 * Null when nothing was raised: a maintenance window suppresses alerts, the rule
 * is switched off, or createAlert's dedupe or cooldown held it back. A failure
 * throws: the monitor leaves its marker unset and tries again on the next tick.
 */
export async function emitDeviceNotReturnedAlert(input: {
  deviceId: string;
  orgId: string;
  commandId: string;
  startedAt: Date;
}): Promise<string | null> {
  const { deviceId, orgId, commandId, startedAt } = input;
  const maintenance = await checkDeviceMaintenanceWindow(deviceId);
  if (maintenance.active && maintenance.suppressAlerts) return null;

  return runWithSystemDbAccess(async () => {
    const label = await loadHostLabel(deviceId, orgId);
    const ruleId = await ensureRule(orgId, NOT_RETURNED_TEMPLATE);
    return createAlert({
      ruleId,
      deviceId,
      orgId,
      severity: NOT_RETURNED_TEMPLATE.severity,
      title: `${label} did not come back after a vendor update`,
      message:
        `${label} has not checked in since a BIOS or firmware update started at ${startedAt.toISOString()}. `
        + 'It may be at a BitLocker recovery prompt or a failed flash.',
      context: {
        source: OEM_UPDATES_ALERT_SOURCE,
        commandId,
        startedAt: startedAt.toISOString(),
        category: PATCH_ALERT_CATEGORY,
      },
    });
  });
}

/** Decision 8: report and alert in v1. No write of protection state from here. */
export async function emitProtectionStillSuspendedAlert(input: {
  deviceId: string;
  orgId: string;
  commandId: string;
}): Promise<string | null> {
  const { deviceId, orgId, commandId } = input;
  const maintenance = await checkDeviceMaintenanceWindow(deviceId);
  if (maintenance.active && maintenance.suppressAlerts) return null;

  return runWithSystemDbAccess(async () => {
    const label = await loadHostLabel(deviceId, orgId);
    const ruleId = await ensureRule(orgId, PROTECTION_SUSPENDED_TEMPLATE);
    return createAlert({
      ruleId,
      deviceId,
      orgId,
      severity: PROTECTION_SUSPENDED_TEMPLATE.severity,
      title: `BitLocker still suspended on ${label} after a vendor update`,
      message: `BitLocker protection did not come back on ${label} after a vendor update and its reboot.`,
      context: { source: OEM_UPDATES_ALERT_SOURCE, commandId, category: PATCH_ALERT_CATEGORY },
    });
  });
}

const RESOLVE_BATCH = 500;

async function resolveOpenAlerts(deviceIds: string[], ruleName: string, note: string): Promise<number> {
  if (deviceIds.length === 0) return 0;
  return runWithSystemDbAccess(async () => {
    // Same status rule as resolveClearedRebootPendingAlerts: an indefinite
    // ("Forever") suppression survives, `dismissed` is terminal.
    const rows = await db
      .select({ id: alerts.id })
      .from(alerts)
      .innerJoin(alertRules, eq(alertRules.id, alerts.ruleId))
      .where(and(
        inArray(alerts.deviceId, deviceIds),
        eq(alertRules.name, ruleName),
        sql`${alerts.context}->>'source' = ${OEM_UPDATES_ALERT_SOURCE}`,
        inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES]),
        or(ne(alerts.status, 'suppressed'), isNotNull(alerts.suppressedUntil)),
      ))
      .orderBy(alerts.createdAt)
      .limit(RESOLVE_BATCH);

    let resolved = 0;
    for (const row of rows) {
      // Isolate each row: one bad alert must not strand the rest of the batch.
      try {
        if (await resolveAlert(row.id, note, undefined, false, 'condition_cleared')) resolved++;
      } catch (error) {
        console.error(`[oemUpdates/alerts] failed to resolve alert ${row.id}:`, error);
        captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
          errorId: 'oem-updates-alert-resolve-failed',
          alertId: row.id,
        });
      }
    }
    return resolved;
  });
}

export function resolveReturnedDeviceAlerts(deviceIds: string[]): Promise<number> {
  return resolveOpenAlerts(deviceIds, NOT_RETURNED_RULE_NAME, 'Auto-resolved: the device checked in after the vendor update');
}

export function resolveProtectionRestoredAlerts(deviceId: string): Promise<number> {
  return resolveOpenAlerts([deviceId], PROTECTION_SUSPENDED_RULE_NAME, 'Auto-resolved: BitLocker protection is back on');
}
