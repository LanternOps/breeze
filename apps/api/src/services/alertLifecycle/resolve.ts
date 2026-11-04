/**
 * Alert lifecycle — the ONE runtime reader of cooldown / auto-resolve / re-arm
 * (settings rule 5; spec 2026-10-29-alert-rearm-lifecycle §6.3). Enforced by
 * `singleReader.contract.test.ts`.
 *
 * - Monitor-managed rule: monitor override → the DEVICE's org override → that
 *   org's partner default → built-in. Resolved per alert at evaluation time,
 *   never at compile time: a partner-wide monitor compiles to ONE shared
 *   template, so its compiled copy is org-agnostic.
 * - Legacy rule (no monitor): rule override → template → built-in for
 *   auto-resolve and cooldown; re-arm is the built-in (OD8 — they do not
 *   inherit partner/org defaults).
 */
import {
  resolveAlertLifecycle,
  BUILTIN_ALERT_LIFECYCLE,
  REARM_MODES,
  type PartialLifecycle,
  type RearmMode,
  type ResolvedAlertLifecycle,
} from '@breeze/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { alertRules, alertTemplates, monitorDefinitions, organizations, partners } from '../../db/schema';

type AlertRuleRow = typeof alertRules.$inferSelect;
type AlertTemplateRow = typeof alertTemplates.$inferSelect;
type MonitorDefinitionRow = typeof monitorDefinitions.$inferSelect;

export type LifecycleRule = Pick<AlertRuleRow, 'managedByMonitorId' | 'overrideSettings'>;
export type LifecycleTemplate = Pick<AlertTemplateRow, 'autoResolve' | 'cooldownMinutes'>;
export type LifecycleMonitor = Pick<MonitorDefinitionRow, 'autoResolve' | 'cooldownMinutes' | 'rearmMode' | 'rearmDelayMinutes'>;

export interface LoadAlertLifecycleArgs {
  rule: LifecycleRule;
  template: LifecycleTemplate | null | undefined;
  /**
   * The monitor behind a managed rule, when the caller already read it. Omit
   * (`undefined`) to have the loader read it; `null` means it is gone, and the
   * rule then inherits org → partner.
   */
  monitor?: LifecycleMonitor | null;
  /** The org of the DEVICE the alert is about — never the monitor owner's. */
  deviceOrgId: string;
}

export type AlertLifecycleLoader = (args: LoadAlertLifecycleArgs) => Promise<ResolvedAlertLifecycle>;

const asRearmMode = (value: unknown): RearmMode | null =>
  (REARM_MODES as readonly unknown[]).includes(value) ? value as RearmMode : null;

/**
 * Legacy (non-monitor) values: rule override ?? template ?? built-in. `??`,
 * never `||`: 0 minutes and `false` are real settings. An override of the
 * wrong type is ignored rather than trusted through a cast.
 */
export function legacyLifecycleValues(
  rule: Pick<AlertRuleRow, 'overrideSettings'>,
  template: LifecycleTemplate | null | undefined,
): { autoResolve: boolean; cooldownMinutes: number } {
  const overrides = (rule.overrideSettings ?? null) as Record<string, unknown> | null;
  const overrideCooldown = overrides?.cooldownMinutes;
  const overrideAutoResolve = overrides?.autoResolve;
  return {
    autoResolve: (typeof overrideAutoResolve === 'boolean' ? overrideAutoResolve : null)
      ?? template?.autoResolve ?? BUILTIN_ALERT_LIFECYCLE.autoResolve,
    cooldownMinutes: (typeof overrideCooldown === 'number' && Number.isFinite(overrideCooldown) ? overrideCooldown : null)
      ?? template?.cooldownMinutes ?? BUILTIN_ALERT_LIFECYCLE.cooldownMinutes,
  };
}

/** A monitor row's own settings, each `null` = inherit. */
export function monitorLifecycleOverride(monitor: LifecycleMonitor): PartialLifecycle {
  return {
    autoResolve: monitor.autoResolve,
    cooldownMinutes: monitor.cooldownMinutes,
    rearmMode: asRearmMode(monitor.rearmMode),
    rearmDelayMinutes: monitor.rearmDelayMinutes,
  };
}

export interface OrgLifecycleRow {
  partnerId: string | null;
  values: PartialLifecycle;
}

async function readMonitor(monitorId: string): Promise<LifecycleMonitor | null> {
  const [row] = await db
    .select({
      autoResolve: monitorDefinitions.autoResolve,
      cooldownMinutes: monitorDefinitions.cooldownMinutes,
      rearmMode: monitorDefinitions.rearmMode,
      rearmDelayMinutes: monitorDefinitions.rearmDelayMinutes,
    })
    .from(monitorDefinitions)
    .where(eq(monitorDefinitions.id, monitorId))
    .limit(1);
  return row ?? null;
}

/** The org override, read in the caller's own RLS context (the caller can see its own org). */
export async function readOrgLifecycleOverride(orgId: string): Promise<OrgLifecycleRow | null> {
  const [row] = await db
    .select({
      partnerId: organizations.partnerId,
      alertAutoResolve: organizations.alertAutoResolve,
      alertRearmMode: organizations.alertRearmMode,
      alertRearmDelayMinutes: organizations.alertRearmDelayMinutes,
      alertCooldownMinutes: organizations.alertCooldownMinutes,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row) return null;
  return {
    partnerId: row.partnerId,
    values: {
      autoResolve: row.alertAutoResolve,
      rearmMode: asRearmMode(row.alertRearmMode),
      rearmDelayMinutes: row.alertRearmDelayMinutes,
      cooldownMinutes: row.alertCooldownMinutes,
    },
  };
}

/**
 * The partner default. `partners` RLS hides the row from org-scoped callers
 * (manual resolve from an org user, mobile), which would silently collapse
 * every inherited value to the built-in, so the read takes the partner-axis
 * escape (a no-op under the sweep's system scope). The id comes from the org
 * row the caller's own context resolved, never from client input.
 */
export async function readPartnerLifecycleDefaults(partnerId: string): Promise<PartialLifecycle | null> {
  const [row] = await readWithPartnerAxisVisibility(() => db
    .select({
      alertAutoResolve: partners.alertAutoResolve,
      alertRearmMode: partners.alertRearmMode,
      alertRearmDelayMinutes: partners.alertRearmDelayMinutes,
      alertCooldownMinutes: partners.alertCooldownMinutes,
    })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1));
  if (!row) return null;
  return {
    autoResolve: row.alertAutoResolve,
    rearmMode: asRearmMode(row.alertRearmMode),
    rearmDelayMinutes: row.alertRearmDelayMinutes,
    cooldownMinutes: row.alertCooldownMinutes,
  };
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let hit = cache.get(key);
  if (!hit) {
    hit = read();
    cache.set(key, hit);
  }
  return hit;
}

/**
 * A loader that reads each org, partner and monitor row at most once. Create
 * one per sweep (one device evaluation): many rules on a device share its org
 * and partner.
 */
export function createLifecycleLoader(): AlertLifecycleLoader {
  const orgs = new Map<string, Promise<OrgLifecycleRow | null>>();
  const partnerDefaults = new Map<string, Promise<PartialLifecycle | null>>();
  const monitors = new Map<string, Promise<LifecycleMonitor | null>>();

  return async ({ rule, template, monitor, deviceOrgId }) => {
    const monitorId = rule.managedByMonitorId;
    if (!monitorId) {
      return resolveAlertLifecycle({ legacy: legacyLifecycleValues(rule, template) });
    }
    const def = monitor !== undefined ? monitor : await memo(monitors, monitorId, () => readMonitor(monitorId));
    const org = await memo(orgs, deviceOrgId, () => readOrgLifecycleOverride(deviceOrgId));
    if (!org) {
      console.warn('[AlertLifecycle] Device org not visible; org/partner defaults skipped', { deviceOrgId, monitorId });
    }
    const partnerId = org?.partnerId ?? null;
    const partner = partnerId
      ? await memo(partnerDefaults, partnerId, () => readPartnerLifecycleDefaults(partnerId))
      : null;
    return resolveAlertLifecycle({
      monitor: def ? monitorLifecycleOverride(def) : null,
      org: org?.values ?? null,
      partner,
    });
  };
}

/** One-shot resolution (no memo across calls). Prefer {@link createLifecycleLoader} in loops. */
export const loadAlertLifecycle: AlertLifecycleLoader = (args) => createLifecycleLoader()(args);

/**
 * What `createAlert` writes to `alerts.context.lifecycle` beside the evidence
 * cursor (settings rule 6): the episode keeps the lifecycle it opened with, so
 * a later settings change affects the next episode, not an open one.
 * `monitorCompiledHash` records which monitor definition opened it; the
 * recovery condition itself is evaluated as currently defined (OD11).
 */
export function lifecycleSnapshot(
  lifecycle: ResolvedAlertLifecycle,
  monitorCompiledHash: string | null,
): ResolvedAlertLifecycle & { monitorCompiledHash: string | null } {
  return {
    autoResolve: lifecycle.autoResolve,
    rearmMode: lifecycle.rearmMode,
    rearmDelayMinutes: lifecycle.rearmDelayMinutes,
    cooldownMinutes: lifecycle.cooldownMinutes,
    sources: lifecycle.sources,
    monitorCompiledHash,
  };
}

/**
 * The snapshot on an alert's context, or null when it has none (opened before
 * W2, or a W1 context holding only the cursor) or the stored shape is not
 * usable, in which case the caller resolves the current settings instead.
 */
export function readLifecycleSnapshot(context: unknown): ResolvedAlertLifecycle | null {
  if (context === null || typeof context !== 'object') return null;
  const lifecycle = (context as { lifecycle?: unknown }).lifecycle;
  if (lifecycle === null || typeof lifecycle !== 'object') return null;
  const { autoResolve, rearmMode, rearmDelayMinutes, cooldownMinutes, sources } = lifecycle as Record<string, unknown>;
  if (typeof autoResolve !== 'boolean') return null;
  if (typeof cooldownMinutes !== 'number' || !Number.isFinite(cooldownMinutes) || cooldownMinutes < 0) return null;
  const mode = asRearmMode(rearmMode);
  if (!mode) return null;
  if (rearmDelayMinutes !== null && typeof rearmDelayMinutes !== 'number') return null;
  if (sources === null || typeof sources !== 'object') return null;
  return {
    autoResolve,
    rearmMode: mode,
    rearmDelayMinutes: rearmDelayMinutes as number | null,
    cooldownMinutes,
    sources: sources as ResolvedAlertLifecycle['sources'],
  };
}

/**
 * `after_delay`: consumed evidence may re-open once this many minutes have
 * passed since the close (the cursor is then dropped from the evaluation, so
 * the rolling window alone decides, as before W1). `new_evidence` never does.
 */
export function rearmDelayElapsed(
  closedAt: Date,
  lifecycle: Pick<ResolvedAlertLifecycle, 'rearmMode' | 'rearmDelayMinutes'>,
  now: number = Date.now(),
): boolean {
  return lifecycle.rearmMode === 'after_delay'
    && lifecycle.rearmDelayMinutes !== null
    && now - closedAt.getTime() >= lifecycle.rearmDelayMinutes * 60_000;
}

/**
 * The lifecycle governing an EXISTING alert, for the paths that act on one
 * (close-time cooldown, auto-resolve): its snapshot, else the current
 * resolution. `alerts.org_id` is always the device's org (createAlert stamps
 * `device.orgId`). Pass `loaded` when the caller already read the
 * rule/template. Null when the alert has no rule or the rule is gone with no
 * snapshot — a rule-less alert has no lifecycle settings.
 */
export async function lifecycleForAlert(
  alert: { ruleId: string | null; orgId: string; context?: unknown },
  loaded?: { rule: AlertRuleRow; template: AlertTemplateRow | null | undefined },
): Promise<ResolvedAlertLifecycle | null> {
  if (!alert.ruleId) return null;
  const snapshot = readLifecycleSnapshot(alert.context);
  if (snapshot) return snapshot;
  let rule = loaded?.rule;
  let template = loaded?.template;
  if (!rule) {
    [rule] = await db.select().from(alertRules).where(eq(alertRules.id, alert.ruleId)).limit(1);
    if (!rule) return null;
    [template] = await db.select().from(alertTemplates).where(eq(alertTemplates.id, rule.templateId)).limit(1);
  }
  return loadAlertLifecycle({ rule, template: template ?? null, deviceOrgId: alert.orgId });
}
