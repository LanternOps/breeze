/**
 * Vendor update alerts (#11065 W03), written through the shared alert machinery
 * (`createAlert`: cooldown, dedupe on an open alert, notifications, automations),
 * never a bare insert into `alerts` (#5241).
 *
 * Same shape as `patchAlerts.ts`: GLOBAL built-in templates, an org-owned rule
 * created lazily on first fire under the `oem-updates` built-in source. A new alert
 * is a new rule name here; the source needs no new migration.
 *
 * Who raises the overdue rules, and when, is in `overdueSweep.ts`.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { PATCH_ALERT_CATEGORY, type OemOutcome } from '@breeze/shared';
import * as dbModule from '../../db';
import { alertRules, alertTemplates, alerts, devices } from '../../db/schema';
import { createAlert, resolveAlert, RESOLVABLE_ALERT_STATUSES } from '../alertService';
import { insertBuiltInAlertRule } from '../builtInAlertRules';
import { checkDeviceMaintenanceWindow } from '../featureConfigResolver';

const { db } = dbModule;

export const OEM_UPDATES_ALERT_SOURCE = 'oem-updates';

const NOT_RETURNED_RULE_NAME = 'Vendor update: device did not come back';
const PROTECTION_SUSPENDED_RULE_NAME = 'Vendor update: BitLocker still suspended';
export const OEM_NOT_RETURNED_RULE_NAME = NOT_RETURNED_RULE_NAME;
export const OEM_OVERDUE_RULE_NAME = 'Vendor update: device overdue';
export const OEM_REBOOT_OVERDUE_RULE_NAME = 'Vendor update: restart overdue';
export const OEM_SCHEDULE_NOT_HANDED_BACK_RULE_NAME = 'Vendor update: schedule not handed back';
export const OEM_RUN_FAILING_RULE_NAME = 'Vendor update: run failing';

type TemplateConfig = {
  name: string;
  severity: 'critical' | 'high' | 'medium';
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

const OVERDUE_TEMPLATE: TemplateConfig = {
  name: OEM_OVERDUE_RULE_NAME,
  severity: 'medium',
  cooldownMinutes: 1440,
  titleTemplate: '{{hostname}} is overdue for vendor updates',
  messageTemplate:
    "{{hostname}} did not finish a vendor update run on any night of this month's schedule. It may have been off or asleep every night. Use Run vendor updates to run it now.",
};

const REBOOT_OVERDUE_TEMPLATE: TemplateConfig = {
  name: OEM_REBOOT_OVERDUE_RULE_NAME,
  severity: 'medium',
  cooldownMinutes: 1440,
  titleTemplate: '{{hostname}} is overdue for a restart after a vendor update',
  messageTemplate:
    '{{hostname}} has held a restart from a vendor update for 3 nights or more. Breeze never forces it. The update is not finished until the device restarts.',
};

const SCHEDULE_NOT_HANDED_BACK_TEMPLATE: TemplateConfig = {
  name: OEM_SCHEDULE_NOT_HANDED_BACK_RULE_NAME,
  severity: 'medium',
  cooldownMinutes: 1440,
  titleTemplate: "Breeze could not hand the vendor tool's schedule back on {{hostname}}",
  messageTemplate:
    "No policy runs vendor updates on {{hostname}} any more, and handing the vendor tool's own schedule back failed 3 times, so Breeze stopped trying. Check the tool's settings on the device.",
};

const RUN_FAILING_TEMPLATE: TemplateConfig = {
  name: OEM_RUN_FAILING_RULE_NAME,
  severity: 'medium',
  cooldownMinutes: 1440,
  titleTemplate: '{{hostname}} is still failing vendor updates',
  messageTemplate:
    "The last scheduled vendor update run on {{hostname}} failed, and this month's schedule has no nights left to retry. Check its run history, then use Run vendor updates to run it now.",
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
 * throws: the caller leaves its state alone and tries again on the next tick.
 *
 * The maintenance read is inside the system context with the rest. A worker has no
 * context of its own, and under forced RLS the read would find no window at all.
 */
async function raiseDeviceAlert(
  config: TemplateConfig,
  device: { deviceId: string; orgId: string },
  build: (label: string) => { title: string; message: string; context: Record<string, unknown> },
): Promise<string | null> {
  const { deviceId, orgId } = device;
  return runWithSystemDbAccess(async () => {
    const maintenance = await checkDeviceMaintenanceWindow(deviceId);
    if (maintenance.active && maintenance.suppressAlerts) return null;

    const label = await loadHostLabel(deviceId, orgId);
    const ruleId = await ensureRule(orgId, config);
    const { title, message, context } = build(label);
    return createAlert({
      ruleId,
      deviceId,
      orgId,
      severity: config.severity,
      title,
      message,
      context: { source: OEM_UPDATES_ALERT_SOURCE, category: PATCH_ALERT_CATEGORY, ...context },
    });
  });
}

export function emitDeviceNotReturnedAlert(input: {
  deviceId: string;
  orgId: string;
  commandId: string;
  startedAt: Date;
}): Promise<string | null> {
  const { commandId, startedAt } = input;
  return raiseDeviceAlert(NOT_RETURNED_TEMPLATE, input, (label) => ({
    title: `${label} did not come back after a vendor update`,
    message:
      `${label} has not checked in since a BIOS or firmware update started at ${startedAt.toISOString()}. `
      + 'It may be at a BitLocker recovery prompt or a failed flash.',
    context: { commandId, startedAt: startedAt.toISOString() },
  }));
}

/** Decision 8: report and alert in v1. No write of protection state from here. */
export function emitProtectionStillSuspendedAlert(input: {
  deviceId: string;
  orgId: string;
  commandId: string;
}): Promise<string | null> {
  return raiseDeviceAlert(PROTECTION_SUSPENDED_TEMPLATE, input, (label) => ({
    title: `BitLocker still suspended on ${label} after a vendor update`,
    message: `BitLocker protection did not come back on ${label} after a vendor update and its reboot.`,
    context: { commandId: input.commandId },
  }));
}

export function emitOverdueAlert(input: { deviceId: string; orgId: string; occurrenceKey: string }): Promise<string | null> {
  const { occurrenceKey } = input;
  return raiseDeviceAlert(OVERDUE_TEMPLATE, input, (label) => ({
    title: `${label} is overdue for vendor updates`,
    message:
      `${label} did not finish a vendor update run on any night of the ${occurrenceKey} schedule. `
      + 'It may have been off or asleep every night. Use Run vendor updates to run it now.',
    context: { occurrenceKey, dedupeKey: occurrenceKey },
  }));
}

export function emitRebootOverdueAlert(input: { deviceId: string; orgId: string; pendingSince: string }): Promise<string | null> {
  const { pendingSince } = input;
  return raiseDeviceAlert(REBOOT_OVERDUE_TEMPLATE, input, (label) => ({
    title: `${label} is overdue for a restart after a vendor update`,
    message:
      `${label} has held a restart from a vendor update since ${pendingSince}. Breeze never forces it. `
      + 'The update is not finished until the device restarts.',
    context: { pendingSince, dedupeKey: pendingSince },
  }));
}

export function emitScheduleNotHandedBackAlert(input: {
  deviceId: string;
  orgId: string;
  lane: string | null;
  takeoverKey: string;
}): Promise<string | null> {
  return raiseDeviceAlert(SCHEDULE_NOT_HANDED_BACK_TEMPLATE, input, (label) => ({
    title: `Breeze could not hand the vendor tool's schedule back on ${label}`,
    message:
      `No policy runs vendor updates on ${label} any more, and handing the vendor tool's own schedule back failed 3 times, `
      + "so Breeze stopped trying. Check the tool's settings on the device.",
    context: { lane: input.lane, dedupeKey: input.takeoverKey },
  }));
}

/** The outcomes that read Failing, in the alert's words. Any other reads "failed". */
const RUN_FAILING_WORDS: Partial<Record<OemOutcome, string>> = {
  partial: 'finished only in part',
  tool_unavailable: 'could not get its tool',
  interrupted: 'was interrupted',
  blocked_no_recovery_key: 'had no recovery key',
};

export function emitRunFailingAlert(input: {
  deviceId: string;
  orgId: string;
  occurrenceKey: string;
  lastOutcome: OemOutcome | null;
  commandId: string | null;
}): Promise<string | null> {
  const { occurrenceKey, lastOutcome, commandId } = input;
  const words = (lastOutcome && RUN_FAILING_WORDS[lastOutcome]) ?? 'failed';
  return raiseDeviceAlert(RUN_FAILING_TEMPLATE, input, (label) => ({
    title: `${label} is still failing vendor updates`,
    message:
      `The last scheduled vendor update run on ${label} for the ${occurrenceKey} schedule ${words}, `
      + 'and that schedule has no nights left to retry. Check its run history, then use Run vendor updates to run it now.',
    context: { occurrenceKey, dedupeKey: occurrenceKey, lastOutcome, commandId },
  }));
}

export type OpenOemAlert = { alertId: string; deviceId: string; orgId: string; dedupeKey: string | null; createdAt: Date };

/** Open alerts of one rule, by id. Same status rule as a resolve: "Forever" stays. */
export function listOpenOemAlerts(ruleName: string, afterId: string | null, limit: number): Promise<OpenOemAlert[]> {
  return runWithSystemDbAccess(() => db
    .select({
      alertId: alerts.id,
      deviceId: alerts.deviceId,
      orgId: alerts.orgId,
      dedupeKey: sql<string | null>`${alerts.context}->>'dedupeKey'`,
      createdAt: alerts.createdAt,
    })
    .from(alerts)
    .innerJoin(alertRules, eq(alertRules.id, alerts.ruleId))
    .where(and(
      eq(alertRules.name, ruleName),
      sql`${alerts.context}->>'source' = ${OEM_UPDATES_ALERT_SOURCE}`,
      inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES]),
      or(ne(alerts.status, 'suppressed'), isNotNull(alerts.suppressedUntil)),
      isNotNull(alerts.deviceId),
      afterId ? gt(alerts.id, afterId) : undefined,
    ))
    .orderBy(alerts.id)
    .limit(limit)) as Promise<OpenOemAlert[]>;
}

/** Every alert of one rule these devices have had, in any status, for "once per ...". */
export async function priorOemAlerts(
  ruleName: string,
  deviceIds: string[],
): Promise<Array<{ deviceId: string; dedupeKey: string | null; open: boolean }>> {
  const rows = await runWithSystemDbAccess(() => db
    .select({
      deviceId: alerts.deviceId,
      dedupeKey: sql<string | null>`${alerts.context}->>'dedupeKey'`,
      status: alerts.status,
    })
    .from(alerts)
    .innerJoin(alertRules, eq(alertRules.id, alerts.ruleId))
    .where(and(
      inArray(alerts.deviceId, deviceIds),
      eq(alertRules.name, ruleName),
      sql`${alerts.context}->>'source' = ${OEM_UPDATES_ALERT_SOURCE}`,
    )));
  const open: ReadonlySet<string> = new Set(RESOLVABLE_ALERT_STATUSES);
  return rows.map((row) => ({ deviceId: row.deviceId!, dedupeKey: row.dedupeKey, open: open.has(row.status) }));
}

/** True when the org has this rule and turned it off. A rule not yet created is on. */
export async function oemRuleSwitchedOff(orgId: string, ruleName: string): Promise<boolean> {
  const [rule] = await runWithSystemDbAccess(() => db
    .select({ isActive: alertRules.isActive })
    .from(alertRules)
    .where(and(eq(alertRules.orgId, orgId), eq(alertRules.name, ruleName), isNull(alertRules.retiredAt)))
    .limit(1));
  return rule?.isActive === false;
}

export function resolveOemAlert(alertId: string, note: string): Promise<boolean> {
  return runWithSystemDbAccess(() => resolveAlert(alertId, note, undefined, false, 'condition_cleared'));
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
    let failed = 0;
    for (const row of rows) {
      // Isolate each row: one bad alert must not strand the rest of the batch.
      try {
        if (await resolveAlert(row.id, note, undefined, false, 'condition_cleared')) resolved++;
      } catch (error) {
        failed++;
        console.error(`[oemUpdates/alerts] failed to resolve alert ${row.id}:`, error);
      }
    }
    // Surfaced, not swallowed: the caller keeps its state so the resolve is retried,
    // or a critical alert stays open on a healthy machine with nothing coming back to it.
    if (failed > 0) throw new Error(`[oemUpdates/alerts] failed to resolve ${failed} of ${rows.length} alert(s)`);
    return resolved;
  });
}

export function resolveReturnedDeviceAlerts(deviceIds: string[]): Promise<number> {
  return resolveOpenAlerts(deviceIds, NOT_RETURNED_RULE_NAME, 'Auto-resolved: the device checked in after the vendor update');
}

export function resolveProtectionRestoredAlerts(deviceId: string): Promise<number> {
  return resolveOpenAlerts([deviceId], PROTECTION_SUSPENDED_RULE_NAME, 'Auto-resolved: BitLocker protection is back on');
}
