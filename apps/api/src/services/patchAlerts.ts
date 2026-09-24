/**
 * AI patch agent W04 (#5750) — server-side patch alert sources.
 *
 * Two producers, both writing through the shared alert machinery
 * (`createAlert` — cooldown, dedupe-on-open-alert, `alert.triggered`
 * publish), never a bare insert into `alerts` (that path skips every
 * consumer: notifications, escalation, automations, the AI verdict — #5241):
 *
 *   - `emitPatchJobFailureAlert` — one alert per (device, patch job) when a
 *     patch job's device terminalises as a genuine install failure
 *     (`patchJobFinalizer.ts`).
 *   - `emitRebootPendingAlert` — one alert per device whose reboot has been
 *     pending longer than `REBOOT_PENDING_ALERT_THRESHOLD_DAYS`, raised from
 *     the 10-minute maintenance-reboot sweep (`maintenanceRebootWorker.ts`).
 *
 * Both templates are GLOBAL rows (org_id IS NULL AND partner_id IS NULL —
 * legal per `alert_templates_one_owner_chk`, see `db/schema/alerts.ts`), and
 * every rule that fires off them is org-owned, created lazily the same way
 * `policyAlertBridge.ts` creates its policy-violation rule — this module
 * copies that shape.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { alertRules, alertTemplates, devices, patchJobResults, patchJobs } from '../db/schema';
import { createAlert } from './alertService';
import { checkDeviceMaintenanceWindow } from './featureConfigResolver';
import { captureException } from './sentry';
import { sqlTimestamp } from './portal/sqlTimestamp';
import { PATCH_ALERT_CATEGORY } from '@breeze/shared';

export { PATCH_ALERT_CATEGORY };

const { db } = dbModule;

/**
 * Same guard-pattern as `policyAlertBridge.ts` / `maintenanceRebootWorker.ts`
 * (so a unit test can mock `../db` without providing every export), extended
 * with `runOutsideDbContext` because this module's writes (a global template
 * row with no org/partner axis, an org-owned rule, the alert itself) must
 * succeed regardless of the ambient request/job context the emitter is
 * called from.
 *
 * Maintenance suppression reads the config-policy window through
 * `checkDeviceMaintenanceWindow` (the same read `alertService` uses for
 * config-policy alerts and `processRebootCandidate` uses in the sweep) —
 * never `maintenanceService.isDeviceInMaintenance`, whose own
 * `runOutsideDbContext(withSystemDbAccessContext(…))` would hold a second
 * pooled connection under the caller's open system context (the sweep, the
 * finalizer).
 */
async function runWithSystemDbAccess<T>(fn: () => Promise<T>): Promise<T> {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') return fn();
  // Already system-scoped (the reboot sweep, a worker) → run in place rather
  // than holding a second pooled connection for nothing.
  const current = dbModule.getCurrentDbAccessContext;
  if (typeof current === 'function' && current()?.scope === 'system') return fn();
  const outside = dbModule.runOutsideDbContext;
  return typeof outside === 'function' ? outside(() => withSystem(fn)) : withSystem(fn);
}

const PATCH_JOB_FAILURE_TEMPLATE_NAME = 'Patch job failure';
const REBOOT_PENDING_TEMPLATE_NAME = 'Reboot pending too long';

const PATCH_JOB_FAILURE_RULE_NAME = 'Patch job failures';
const REBOOT_PENDING_RULE_NAME = 'Reboot pending too long';

export const REBOOT_PENDING_ALERT_THRESHOLD_DAYS = 7;

type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

type PatchAlertTemplateConfig = {
  name: string;
  severity: AlertSeverity;
  cooldownMinutes: number;
  conditions: { source: string };
  titleTemplate: string;
  messageTemplate: string;
};

const PATCH_JOB_FAILURE_TEMPLATE: PatchAlertTemplateConfig = {
  name: PATCH_JOB_FAILURE_TEMPLATE_NAME,
  severity: 'high',
  cooldownMinutes: 240,
  conditions: { source: 'patch-job-finalizer' },
  titleTemplate: 'Patch job failed on {{hostname}}',
  messageTemplate: '{{failedCount}} patch(es) failed to install on {{hostname}}.',
};

const REBOOT_PENDING_TEMPLATE: PatchAlertTemplateConfig = {
  name: REBOOT_PENDING_TEMPLATE_NAME,
  severity: 'medium',
  cooldownMinutes: 1440,
  conditions: { source: 'maintenance-reboot-sweep' },
  titleTemplate: 'Reboot pending on {{hostname}}',
  messageTemplate: '{{hostname}} has needed a restart for {{days}} day(s).',
};

// ---------------------------------------------------------------------------
// Template + rule provisioning (idempotent-by-name, like policyAlertBridge)
// ---------------------------------------------------------------------------

/**
 * Finds or creates the GLOBAL (org_id IS NULL AND partner_id IS NULL)
 * template for a patch alert source. There is no unique index on name, so a
 * race can legally produce two rows; resolution always takes the first by
 * `createdAt asc`, matching `policyAlertBridge.ensureTemplate`'s ordering
 * rationale.
 */
async function ensureGlobalTemplate(config: PatchAlertTemplateConfig): Promise<string> {
  const [existing] = await db
    .select({ id: alertTemplates.id })
    .from(alertTemplates)
    .where(
      and(
        isNull(alertTemplates.orgId),
        isNull(alertTemplates.partnerId),
        eq(alertTemplates.name, config.name),
      ),
    )
    .orderBy(asc(alertTemplates.createdAt))
    .limit(1);

  if (existing) {
    return existing.id;
  }

  const [created] = await db
    .insert(alertTemplates)
    .values({
      orgId: null,
      partnerId: null,
      name: config.name,
      description: `Auto-generated template for ${config.name}`,
      category: PATCH_ALERT_CATEGORY,
      conditions: config.conditions,
      severity: config.severity,
      titleTemplate: config.titleTemplate,
      messageTemplate: config.messageTemplate,
      autoResolve: false,
      isBuiltIn: true,
      cooldownMinutes: config.cooldownMinutes,
    })
    .returning({ id: alertTemplates.id });

  if (!created) {
    throw new Error(`[patchAlerts] failed to create template "${config.name}"`);
  }

  return created.id;
}

async function ensurePatchAlertRule(
  orgId: string,
  ruleName: string,
  config: PatchAlertTemplateConfig,
): Promise<string> {
  const [existing] = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .where(and(eq(alertRules.orgId, orgId), eq(alertRules.name, ruleName), isNull(alertRules.retiredAt)))
    .limit(1);

  if (existing) {
    return existing.id;
  }

  const templateId = await ensureGlobalTemplate(config);

  const [created] = await db
    .insert(alertRules)
    .values({
      orgId,
      templateId,
      name: ruleName,
      targetType: 'org',
      targetId: orgId,
      isActive: true,
      overrideSettings: { source: config.conditions.source },
    })
    .returning({ id: alertRules.id });

  if (!created) {
    throw new Error(`[patchAlerts] failed to create rule "${ruleName}" for org ${orgId}`);
  }

  return created.id;
}

/** Exported for testing / reuse; the emitters call this themselves. */
export async function ensurePatchJobFailureRule(orgId: string): Promise<string> {
  return ensurePatchAlertRule(orgId, PATCH_JOB_FAILURE_RULE_NAME, PATCH_JOB_FAILURE_TEMPLATE);
}

/** Exported for testing / reuse; the emitters call this themselves. */
export async function ensureRebootPendingRule(orgId: string): Promise<string> {
  return ensurePatchAlertRule(orgId, REBOOT_PENDING_RULE_NAME, REBOOT_PENDING_TEMPLATE);
}

// ---------------------------------------------------------------------------
// Patch job failure
// ---------------------------------------------------------------------------

export type EmitPatchJobFailureAlertInput = {
  orgId: string;
  deviceId: string;
  patchJobId: string;
  /** Omit to have the emitter read `devices.hostname` itself. */
  hostname?: string | null;
  failedCount: number;
  errorExcerpt: string | null;
};

async function loadHostname(deviceId: string, orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ hostname: devices.hostname })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  return row?.hostname ?? null;
}

/**
 * One alert per (device, patch job) when the device's install terminalised
 * as a genuine failure. Called by `patchJobFinalizer.ts` after its write
 * commits — see the `isGenuineFailure` classification there for which
 * terminals qualify (never `expired`/`cancelled`/`superseded`, never a
 * reboot-required successful install).
 *
 * Never throws: alerting must not break job finalisation.
 */
export async function emitPatchJobFailureAlert(
  input: EmitPatchJobFailureAlertInput,
): Promise<string | null> {
  const { orgId, deviceId, patchJobId, failedCount, errorExcerpt } = input;
  try {
    const maintenance = await checkDeviceMaintenanceWindow(deviceId);
    if (maintenance.active && maintenance.suppressAlerts) {
      console.log(
        `[patchAlerts] skipping patch job failure alert for device ${deviceId}: `
        + 'active maintenance window suppresses alerts',
      );
      return null;
    }

    return await runWithSystemDbAccess(async () => {
      const hostname = input.hostname !== undefined ? input.hostname : await loadHostname(deviceId, orgId);
      const label = hostname ?? deviceId;

      const ruleId = await ensurePatchJobFailureRule(orgId);

      const message =
        `${failedCount} patch(es) failed to install on ${label}.`
        + (errorExcerpt ? ` ${errorExcerpt}` : '');

      return createAlert({
        ruleId,
        deviceId,
        orgId,
        severity: 'high',
        title: `Patch job failed on ${label}`,
        message,
        context: {
          source: 'patch-job-finalizer',
          patchJobId,
          failedCount,
          category: PATCH_ALERT_CATEGORY,
        },
      });
    });
  } catch (error) {
    console.error(
      `[patchAlerts] failed to emit patch job failure alert (device=${deviceId} job=${patchJobId}):`,
      error,
    );
    captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
      errorId: 'patch-job-failure-alert-failed',
      orgId,
      deviceId,
      patchJobId,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reboot pending too long
// ---------------------------------------------------------------------------

/**
 * PURE. Computes the lower bound of "since when has this device needed a
 * reboot": last boot (`now - uptimeSeconds`), or the oldest patch result that
 * flagged `reboot_required` when that is AFTER last boot (a reboot flag from
 * before the last boot is stale — the device already restarted since).
 *
 * Returns null when uptime is unknown — we never alert on an unknown boot
 * time.
 */
export function rebootPendingSince(input: {
  uptimeSeconds: number | null;
  oldestRebootRequiredSince: Date | null;
  now: Date;
}): Date | null {
  const { uptimeSeconds, oldestRebootRequiredSince, now } = input;
  if (uptimeSeconds === null || uptimeSeconds === undefined) return null;

  const lastBoot = new Date(now.getTime() - uptimeSeconds * 1000);

  if (oldestRebootRequiredSince && oldestRebootRequiredSince.getTime() > lastBoot.getTime()) {
    return oldestRebootRequiredSince;
  }

  return lastBoot;
}

/** Whole days between `since` and `now`, floored. */
export function rebootPendingDays(since: Date, now: Date): number {
  const ms = now.getTime() - since.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * The oldest `patch_job_results` row for this device (within this org's
 * jobs) that completed with `reboot_required = true`. A lower bound only:
 * `rebooted_at` is not consulted here (the caller reads live device state,
 * `devices.pending_reboot`, to decide whether to call this at all).
 */
export async function loadOldestRebootRequiredSince(
  deviceId: string,
  orgId: string,
): Promise<Date | null> {
  const [row] = await db
    .select({ oldest: sql<Date | string | null>`MIN(${patchJobResults.completedAt})` })
    .from(patchJobResults)
    .innerJoin(patchJobs, and(eq(patchJobs.id, patchJobResults.jobId), eq(patchJobs.orgId, orgId)))
    .where(
      and(
        eq(patchJobResults.deviceId, deviceId),
        eq(patchJobResults.status, 'completed'),
        eq(patchJobResults.rebootRequired, true),
      ),
    );

  // `sql<Date | null>` is a type annotation only: postgres-js hands a raw
  // aggregate back as text (#6835), and `completed_at` is `timestamp` WITHOUT
  // time zone, so the text carries no offset. `sqlTimestamp` reads it as UTC
  // and throws on junk (the sweep catches and reports per device).
  return sqlTimestamp(row?.oldest);
}

export type EmitRebootPendingAlertInput = {
  orgId: string;
  deviceId: string;
  hostname: string | null;
  uptimeSeconds: number | null;
  oldestRebootRequiredSince: Date | null;
  now?: Date;
};

/**
 * One alert per device whose reboot has been pending at least
 * `REBOOT_PENDING_ALERT_THRESHOLD_DAYS`. Called from the maintenance-reboot
 * sweep for a candidate the sweep did NOT just reboot.
 *
 * Never throws: alerting must not break the sweep.
 */
export async function emitRebootPendingAlert(
  input: EmitRebootPendingAlertInput,
): Promise<string | null> {
  const { orgId, deviceId, hostname, uptimeSeconds, oldestRebootRequiredSince } = input;
  const now = input.now ?? new Date();

  try {
    const since = rebootPendingSince({ uptimeSeconds, oldestRebootRequiredSince, now });
    if (!since) return null;

    const days = rebootPendingDays(since, now);
    if (days < REBOOT_PENDING_ALERT_THRESHOLD_DAYS) return null;

    const maintenance = await checkDeviceMaintenanceWindow(deviceId);
    if (maintenance.active && maintenance.suppressAlerts) {
      console.log(
        `[patchAlerts] skipping reboot pending alert for device ${deviceId}: `
        + 'active maintenance window suppresses alerts',
      );
      return null;
    }

    const label = hostname ?? deviceId;

    return await runWithSystemDbAccess(async () => {
      const ruleId = await ensureRebootPendingRule(orgId);

      return createAlert({
        ruleId,
        deviceId,
        orgId,
        severity: 'medium',
        title: `Reboot pending on ${label}`,
        message: `${label} has needed a restart for ${days} day(s).`,
        context: {
          source: 'maintenance-reboot-sweep',
          pendingSince: since.toISOString(),
          pendingDays: days,
          category: PATCH_ALERT_CATEGORY,
        },
      });
    });
  } catch (error) {
    console.error(`[patchAlerts] failed to emit reboot pending alert (device=${deviceId}):`, error);
    captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
      errorId: 'reboot-pending-alert-failed',
      orgId,
      deviceId,
    });
    return null;
  }
}
