/**
 * Built-in default monitors — CPU, memory, disk usage, patch compliance, and
 * hardware/RAID health.
 *
 * Every partner is provisioned eight PARTNER-WIDE monitor_definitions rows
 * (tagged `builtin_key`). They are NOT attached to any policy: nothing is
 * evaluated until the MSP attaches them to a configuration policy (owner
 * decision 2026-09-13 — no monitoring assigned by default).
 *
 * The rows are ordinary partner-owned monitors: the MSP can retune, disable,
 * or delete them. Provisioning is recorded per-partner in
 * partners.settings.builtInMonitors as a VERSION marker (`version`), not a
 * one-shot boolean: `BUILT_IN_MONITORS_VERSION` bumps whenever a NEW default
 * is added, and `defaultsToProvision` inserts only the defaults introduced
 * since the partner's stored version. Threshold changes to an EXISTING
 * default are still one-time — they reach new partners only and never
 * rewrite a partner's existing rows. A default a partner deleted never
 * resurrects: `sinceVersion <= storedVersion` is skipped even if the row is
 * gone.
 *
 * Runs in three places: createPartner() (inside its transaction), the
 * system-scope POST /orgs/partners route, and a detached post-listen backfill
 * at API boot (ensureBuiltInMonitorsForAllPartners, opt-out via
 * BREEZE_BUILTIN_MONITORS_AUTOSEED=false).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { monitorDefinitions, partners } from '../../db/schema';
import { compileMonitorInTx } from './monitorCompiler';
import { getMonitorKindSpec } from './kinds';
import type { MonitorKind } from '@breeze/shared';
import type { HardwareHealthCondition } from '../alertConditions/types';

/**
 * Bump this whenever a new entry is added to `BUILT_IN_MONITOR_DEFAULTS` (and
 * give that entry the new `sinceVersion`). Existing partners are upgraded
 * lazily — the next `ensureBuiltInMonitorsForPartner` call (route, boot
 * backfill) inserts only the defaults newer than their stored marker.
 */
export const BUILT_IN_MONITORS_VERSION = 3;

export interface ThresholdDefaultCondition {
  operator: 'gt' | 'gte' | 'lt' | 'lte';
  value: number;
  durationMinutes?: number;
}

export type HardwareHealthDefaultCondition = Omit<HardwareHealthCondition, 'type'>;

export interface BuiltInMonitorDefault {
  key:
    | 'cpu_high'
    | 'memory_high'
    | 'disk_full'
    | 'patch_compliance_low'
    | 'raid_array_degraded'
    | 'physical_disk_failed'
    | 'cache_battery_problem'
    | 'hardware_collector_failing';
  name: string;
  description: string;
  kind: MonitorKind;
  condition: ThresholdDefaultCondition | HardwareHealthDefaultCondition;
  severity: 'critical' | 'high' | 'medium' | 'low';
  cooldownMinutes: number;
  /** The `BUILT_IN_MONITORS_VERSION` that introduced this default. */
  sinceVersion: number;
}

/**
 * Initial values only. `durationMinutes` is evaluated by the threshold handler
 * as the average of available samples inside the window, so a sustained spike
 * can alert before the full window elapses. `autoResolve` is always on so the
 * alert closes itself when the metric recovers.
 */
export const BUILT_IN_MONITOR_DEFAULTS: readonly BuiltInMonitorDefault[] = [
  {
    key: 'cpu_high',
    name: 'High CPU usage',
    description: 'CPU above 90% for 15 minutes. Built-in default — edit thresholds to suit your fleet.',
    kind: 'cpu',
    condition: { operator: 'gt', value: 90, durationMinutes: 15 },
    severity: 'high',
    cooldownMinutes: 60,
    sinceVersion: 1,
  },
  {
    key: 'memory_high',
    name: 'High memory usage',
    description: 'Memory above 90% for 15 minutes. Built-in default — edit thresholds to suit your fleet.',
    kind: 'memory',
    condition: { operator: 'gt', value: 90, durationMinutes: 15 },
    severity: 'high',
    cooldownMinutes: 60,
    sinceVersion: 1,
  },
  {
    key: 'disk_full',
    name: 'Disk almost full',
    description: 'System disk 90% used or more for 30 minutes. Built-in default — edit thresholds to suit your fleet.',
    kind: 'disk',
    condition: { operator: 'gte', value: 90, durationMinutes: 30 },
    severity: 'critical',
    cooldownMinutes: 240,
    sinceVersion: 1,
  },
  {
    key: 'patch_compliance_low',
    name: 'Low patch compliance',
    description: 'Patch compliance below 80%. Built-in default — edit the threshold to suit your fleet.',
    kind: 'patch_compliance',
    condition: { operator: 'lt', value: 80 },
    severity: 'medium',
    cooldownMinutes: 1440,
    sinceVersion: 2,
  },
  {
    key: 'raid_array_degraded',
    name: 'RAID array degraded or failed',
    description: 'Alerts after two critical array or controller snapshots.',
    kind: 'hardware_health',
    condition: {
      componentTypes: ['virtual_disk', 'controller'],
      minHealth: 'critical',
      includePredictiveFailure: false,
      consecutiveSnapshots: 2,
    },
    severity: 'critical',
    cooldownMinutes: 60,
    sinceVersion: 3,
  },
  {
    key: 'physical_disk_failed',
    name: 'Physical disk failed or predicted to fail',
    description: 'Alerts after two critical or predictive-failure disk snapshots.',
    kind: 'hardware_health',
    condition: {
      componentTypes: ['physical_disk'],
      minHealth: 'critical',
      includePredictiveFailure: true,
      consecutiveSnapshots: 2,
    },
    severity: 'high',
    cooldownMinutes: 60,
    sinceVersion: 3,
  },
  {
    key: 'cache_battery_problem',
    name: 'Controller cache battery problem',
    description: 'Alerts after three unhealthy controller cache battery snapshots.',
    kind: 'hardware_health',
    condition: {
      componentTypes: ['cache_battery'],
      minHealth: 'warning',
      includePredictiveFailure: false,
      consecutiveSnapshots: 3,
    },
    severity: 'medium',
    cooldownMinutes: 240,
    sinceVersion: 3,
  },
  {
    key: 'hardware_collector_failing',
    name: 'Hardware monitoring tool failing',
    description: 'Alerts after three failed or backing-off collector snapshots.',
    kind: 'hardware_health',
    condition: {
      componentTypes: ['collector'],
      minHealth: 'warning',
      includePredictiveFailure: false,
      consecutiveSnapshots: 3,
    },
    severity: 'low',
    cooldownMinutes: 1440,
    sinceVersion: 3,
  },
];

/**
 * Pure helper: which defaults still need provisioning for a partner whose
 * `partners.settings.builtInMonitors.version` marker reads `storedVersion`
 * (`null` when the partner was never provisioned at all).
 */
export function defaultsToProvision(storedVersion: number | null): BuiltInMonitorDefault[] {
  const baseline = storedVersion ?? 0;
  return BUILT_IN_MONITOR_DEFAULTS.filter((def) => def.sinceVersion > baseline);
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = DbTx | typeof db;

export interface EnsureBuiltInMonitorsResult {
  provisioned: boolean;
  monitorIds: string[];
}

function autoseedEnabled(): boolean {
  return (process.env.BREEZE_BUILTIN_MONITORS_AUTOSEED ?? 'true').trim().toLowerCase() !== 'false';
}

/** Reads the stored `builtInMonitors.version` marker; `null` when the partner was never provisioned. */
async function readProvisionedVersion(exec: Executor, partnerId: string): Promise<number | null> {
  const [row] = await exec
    .select({ version: sql<number | null>`(${partners.settings} -> 'builtInMonitors' ->> 'version')::int` })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  return row?.version ?? null;
}

/**
 * Provision the built-in monitors for ONE partner, VERSION-AWARE: only
 * defaults newer than the partner's stored marker (`defaultsToProvision`) are
 * inserted. A partner already at `BUILT_IN_MONITORS_VERSION` is left
 * untouched. A default a partner deleted never resurrects, because its
 * `sinceVersion` is already covered by the stored marker.
 *
 * Must run under a DB access context that can write partner-axis rows
 * (system context, or createPartner's own transaction).
 */
export async function ensureBuiltInMonitorsForPartner(
  partnerId: string,
  opts: { createdBy?: string | null; exec?: Executor } = {},
): Promise<EnsureBuiltInMonitorsResult> {
  const run = async (tx: DbTx): Promise<EnsureBuiltInMonitorsResult> => {
    const storedVersion = await readProvisionedVersion(tx, partnerId);
    if (storedVersion !== null && storedVersion >= BUILT_IN_MONITORS_VERSION) {
      return { provisioned: false, monitorIds: [] };
    }

    const toProvision = defaultsToProvision(storedVersion);
    const monitorIds: string[] = [];
    for (const def of toProvision) {
      // Fail loudly at provisioning time if a default ever drifts from its kind.
      const parsed = getMonitorKindSpec(def.kind).conditionSchema.safeParse(def.condition);
      if (!parsed.success) {
        throw new Error(`built-in monitor ${def.key}: condition does not match kind ${def.kind}`);
      }
      const [created] = await tx
        .insert(monitorDefinitions)
        .values({
          orgId: null,
          partnerId,
          name: def.name,
          description: def.description,
          kind: def.kind,
          enabled: true,
          condition: parsed.data as Record<string, unknown>,
          severity: def.severity,
          cooldownMinutes: def.cooldownMinutes,
          autoResolve: true,
          responses: [],
          deliveryMode: 'inherit',
          deliveryChannelIds: [],
          recurrenceActions: [],
          pauseResponsesOnEscalation: true,
          createdBy: opts.createdBy ?? null,
          builtinKey: def.key,
        })
        // The partial unique index (partner_id, builtin_key) makes a concurrent
        // double-provision a no-op instead of a duplicate. Targeted, so any
        // future unique constraint on the table still surfaces as an error.
        .onConflictDoNothing({
          target: [monitorDefinitions.partnerId, monitorDefinitions.builtinKey],
          where: sql`${monitorDefinitions.builtinKey} IS NOT NULL`,
        })
        .returning();
      if (!created) continue;
      await compileMonitorInTx(tx, created);
      monitorIds.push(created.id);
    }

    // Preserve `provisionedAt` across an upgrade: only set it when the marker
    // was absent, always bump `version`, and record `upgradedAt` on a
    // version-only revisit so the history of when each wave landed survives.
    await tx
      .update(partners)
      .set({
        settings: sql`COALESCE(${partners.settings}, '{}'::jsonb) || jsonb_build_object('builtInMonitors', jsonb_build_object(
          'version', ${BUILT_IN_MONITORS_VERSION}::int,
          'provisionedAt', COALESCE(${partners.settings} -> 'builtInMonitors' ->> 'provisionedAt', ${new Date().toISOString()}::text),
          'upgradedAt', ${new Date().toISOString()}::text
        ))`,
      })
      .where(eq(partners.id, partnerId));

    return { provisioned: toProvision.length > 0, monitorIds };
  };

  if (opts.exec && opts.exec !== db) return run(opts.exec as DbTx);
  return db.transaction(run);
}

/**
 * Boot-time backfill: provision every live partner that is behind the
 * current `BUILT_IN_MONITORS_VERSION` — never provisioned at all (marker
 * NULL), or provisioned at an older version (a new default shipped since).
 * Each partner runs in its OWN system context and therefore its own
 * top-level transaction (runOutsideDbContext + withSystemDbAccessContext),
 * so nothing here piggybacks on an ambient transaction: one failure never
 * blocks the rest, and a crash mid-loop keeps every partner already done.
 * Call it WITHOUT an enclosing DB context, after the HTTP listener is up.
 */
export async function ensureBuiltInMonitorsForAllPartners(): Promise<{
  provisioned: number;
  skipped: number;
  failed: number;
}> {
  if (!autoseedEnabled()) return { provisioned: 0, skipped: 0, failed: 0 };

  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: partners.id })
        .from(partners)
        .where(
          and(
            isNull(partners.deletedAt),
            sql`(
              ${partners.settings} -> 'builtInMonitors' IS NULL
              OR (${partners.settings} -> 'builtInMonitors' ->> 'version')::int < ${BUILT_IN_MONITORS_VERSION}
            )`,
          ),
        ),
    ),
  );

  let provisioned = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() => ensureBuiltInMonitorsForPartner(row.id)),
      );
      if (result.provisioned) provisioned += 1;
    } catch (err) {
      failed += 1;
      console.error(`[builtInMonitors] failed to provision partner ${row.id}:`, err);
    }
  }
  return { provisioned, skipped: rows.length - provisioned - failed, failed };
}
