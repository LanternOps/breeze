/**
 * Built-in default monitors — CPU, memory and disk usage.
 *
 * Every partner is provisioned three PARTNER-WIDE monitor_definitions rows
 * (tagged `builtin_key`) plus one partner-wide configuration policy, "Breeze
 * built-in monitors", assigned at PARTNER level so the resolver
 * (monitorResolver.ts) reaches every device in every org of that partner.
 *
 * The rows are ordinary partner-owned monitors: the MSP can retune, disable
 * (per policy or globally), detach, or delete them. Provisioning is a ONE-TIME
 * event per partner recorded in partners.settings.builtInMonitors, so a
 * deleted built-in never resurrects on the next boot. Threshold changes we
 * make later are explicit upgrades of DEFAULTS (new partners only) — they never
 * rewrite a partner's existing rows.
 *
 * Runs in three places: createPartner() (inside its transaction), the
 * system-scope POST /orgs/partners route, and a detached post-listen backfill
 * at API boot (ensureBuiltInMonitorsForAllPartners, opt-out via
 * BREEZE_BUILTIN_MONITORS_AUTOSEED=false).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyMonitors,
  configurationPolicies,
  monitorDefinitions,
  partners,
} from '../../db/schema';
import { compileMonitorInTx } from './monitorCompiler';
import { getMonitorKindSpec } from './kinds';
import type { MonitorKind } from '@breeze/shared';

export const BUILT_IN_MONITORS_VERSION = 1;
export const BUILT_IN_MONITORS_POLICY_NAME = 'Breeze built-in monitors';

export interface BuiltInMonitorDefault {
  key: 'cpu_high' | 'memory_high' | 'disk_full';
  name: string;
  description: string;
  kind: MonitorKind;
  condition: { operator: 'gt' | 'gte'; value: number; durationMinutes: number };
  severity: 'critical' | 'high';
  cooldownMinutes: number;
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
  },
  {
    key: 'memory_high',
    name: 'High memory usage',
    description: 'Memory above 90% for 15 minutes. Built-in default — edit thresholds to suit your fleet.',
    kind: 'memory',
    condition: { operator: 'gt', value: 90, durationMinutes: 15 },
    severity: 'high',
    cooldownMinutes: 60,
  },
  {
    key: 'disk_full',
    name: 'Disk almost full',
    description: 'System disk 90% used or more for 30 minutes. Built-in default — edit thresholds to suit your fleet.',
    kind: 'disk',
    condition: { operator: 'gte', value: 90, durationMinutes: 30 },
    severity: 'critical',
    cooldownMinutes: 240,
  },
];

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = DbTx | typeof db;

export interface EnsureBuiltInMonitorsResult {
  provisioned: boolean;
  monitorIds: string[];
  policyId: string | null;
}

function autoseedEnabled(): boolean {
  return (process.env.BREEZE_BUILTIN_MONITORS_AUTOSEED ?? 'true').trim().toLowerCase() !== 'false';
}

async function isProvisioned(exec: Executor, partnerId: string): Promise<boolean> {
  const [row] = await exec
    .select({ marker: sql<unknown>`${partners.settings} -> 'builtInMonitors'` })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  return !!row && row.marker !== null && row.marker !== undefined;
}

/**
 * Provision the built-in monitors and their policy for ONE partner. Idempotent
 * via the partners.settings marker; a partner that was ever provisioned is
 * left alone even if it since deleted every built-in row.
 *
 * Must run under a DB access context that can write partner-axis rows
 * (system context, or createPartner's own transaction).
 */
export async function ensureBuiltInMonitorsForPartner(
  partnerId: string,
  opts: { createdBy?: string | null; exec?: Executor } = {},
): Promise<EnsureBuiltInMonitorsResult> {
  const run = async (tx: DbTx): Promise<EnsureBuiltInMonitorsResult> => {
    if (await isProvisioned(tx, partnerId)) {
      return { provisioned: false, monitorIds: [], policyId: null };
    }

    const monitorIds: string[] = [];
    for (const def of BUILT_IN_MONITOR_DEFAULTS) {
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

    let policyId: string | null = null;
    if (monitorIds.length > 0) {
      const [policy] = await tx
        .insert(configurationPolicies)
        .values({
          orgId: null,
          partnerId,
          name: BUILT_IN_MONITORS_POLICY_NAME,
          description:
            'Applies the built-in CPU, memory and disk monitors to every device. Detach a monitor here to stop it fleet-wide, or override thresholds per policy.',
          status: 'active',
          createdBy: opts.createdBy ?? null,
        })
        .returning({ id: configurationPolicies.id });
      policyId = policy!.id;

      const items = monitorIds.map((monitorId, idx) => ({ monitorId, enabled: true, overrides: null, sortOrder: idx }));
      // inline_settings mirrors what addFeatureLink() stores for a 'monitors'
      // link ({ items }); config_policy_monitors is the normalized copy readers use.
      const [link] = await tx
        .insert(configPolicyFeatureLinks)
        .values({ configPolicyId: policyId, featureType: 'monitors', inlineSettings: { items } })
        .returning({ id: configPolicyFeatureLinks.id });
      await tx.insert(configPolicyMonitors).values(
        items.map((item) => ({
          featureLinkId: link!.id,
          monitorId: item.monitorId,
          enabled: item.enabled,
          overrides: item.overrides,
          sortOrder: item.sortOrder,
        })),
      );
      await tx
        .insert(configPolicyAssignments)
        .values({
          configPolicyId: policyId,
          level: 'partner',
          targetId: partnerId,
          priority: 0,
          assignedBy: opts.createdBy ?? null,
        })
        .onConflictDoNothing();
    }

    await tx
      .update(partners)
      .set({
        settings: sql`COALESCE(${partners.settings}, '{}'::jsonb) || jsonb_build_object('builtInMonitors', jsonb_build_object('version', ${BUILT_IN_MONITORS_VERSION}::int, 'provisionedAt', ${new Date().toISOString()}::text, 'policyId', ${policyId}::text))`,
      })
      .where(eq(partners.id, partnerId));

    return { provisioned: true, monitorIds, policyId };
  };

  if (opts.exec && opts.exec !== db) return run(opts.exec as DbTx);
  return db.transaction(run);
}

/**
 * Boot-time backfill: provision every live partner that has never been
 * provisioned. Each partner runs in its OWN system context and therefore its
 * own top-level transaction (runOutsideDbContext + withSystemDbAccessContext),
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
        .where(and(isNull(partners.deletedAt), sql`${partners.settings} -> 'builtInMonitors' IS NULL`)),
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
