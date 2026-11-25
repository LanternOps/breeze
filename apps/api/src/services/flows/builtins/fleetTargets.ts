/**
 * Tool Catalog W06 (#5221) Task A4 — resolve a fleet selector to the RUN
 * org's devices, once per execution. Shared by `resolve_targets` and
 * `run_script_on_targets`.
 *
 * The legacy resolver (`resolveAutomationTargetsDetailed`) runs with the run
 * org as the owner, so a target / legacy condition array resolves exactly as a
 * standalone Job's did (group diagnostics, tag substring matching, parked and
 * Quick Support exclusion) — but never across orgs: a partner-wide flow runs
 * once per org. Reads run under the flow principal's run-org DB context
 * (`flowDbAccessContext`), never system scope, so RLS bounds them too.
 *
 * The result is deduplicated, sorted and re-read in the run org (a device
 * moved or deleted between resolution and the read drops out). It is never
 * truncated: the caller refuses an over-cap set.
 *
 * A `fleetFilter` selector (#12418 W02) does not go through the legacy
 * resolver: it reads the condition list `get_fleet_device_stats` counts
 * (`fleetConditions`), so the set a flow freezes is the set the count named.
 * A filter or a dynamic group that matches on a field a device reports about
 * itself is refused here, whatever save allowed.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DeploymentTargetConfig, FleetFilter, LegacyCondition } from '@breeze/shared';
import { db, runOutsideDbContext, withDbAccessContext } from '../../../db';
import { deviceGroups, devices } from '../../../db/schema';
import { resolveAutomationTargetsDetailed } from '../../automationRuntime';
import { fleetConditions } from '../../deviceStats';
import { FilterQueryTimeoutError, withFilterStatementTimeout } from '../../filterEngine';
import { reportFilterPreviewTimeout } from '../../filterPreviewTimeout';
import { fleetFilterExecutionRefusedFields } from '../../fleetFilter';
import { notParkedDeviceCondition } from '../../unassignedPool/selectorPredicate';
import { flowDbAccessContext } from '../flowAuthContext';
import { classifyFleetFilterGroup } from '../fleetFilterGroupGate';

export interface FleetRunOrg {
  orgId: string;
  partnerId: string;
}

export type FleetSelector =
  | { target: DeploymentTargetConfig; conditions?: undefined }
  | { conditions: readonly LegacyCondition[]; target?: undefined };

export interface FleetDevice {
  id: string;
  hostname: string;
  /** Display name, else hostname — the legacy `{{device}}` value. */
  name: string;
  /** `resolve_targets` over a fleet step's FAILED set only: why the device failed (#10705). */
  failureReason?: string;
}

export interface FleetTargetResolution {
  deviceIds: string[];
  devices: FleetDevice[];
  warnings: string[];
  problems: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run org's devices among `ids` (sorted by id); everything else drops out. Call inside a run-org context. */
async function loadRunOrgDevices(orgId: string, ids: readonly string[]): Promise<FleetDevice[]> {
  const wanted = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  if (wanted.length === 0) return [];
  const rows = await db
    .select({ id: devices.id, hostname: devices.hostname, displayName: devices.displayName })
    .from(devices)
    // App-layer org predicate on top of RLS: a fleet step never crosses orgs.
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, wanted)));
  return rows
    .map((r) => ({ id: r.id, hostname: r.hostname, name: r.displayName || r.hostname }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function inRunOrg<T>(run: FleetRunOrg, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(flowDbAccessContext(run.orgId, run.partnerId), fn));
}

export async function resolveTargetsOnce(run: FleetRunOrg, selector: FleetSelector): Promise<FleetTargetResolution> {
  return inRunOrg(run, async () => {
    const resolved = await resolveAutomationTargetsDetailed({
      orgId: run.orgId,
      partnerId: null,
      conditions: (selector.target ?? selector.conditions) as never,
      trigger: {},
    });
    if (resolved.problems.length > 0) {
      return { deviceIds: [], devices: [], warnings: resolved.warnings, problems: resolved.problems };
    }
    const found = await loadRunOrgDevices(run.orgId, resolved.deviceIds);
    return { deviceIds: found.map((d) => d.id), devices: found, warnings: resolved.warnings, problems: [] };
  });
}

/** An explicit device list (a `fromStep` set or `deviceIds`), kept to the run org's devices. */
export async function resolveDeviceIdsInRunOrg(run: FleetRunOrg, ids: readonly string[]): Promise<FleetDevice[]> {
  return inRunOrg(run, () => loadRunOrgDevices(run.orgId, ids));
}

/**
 * The devices of one org a `fleetFilter` matches, sorted by id, with the exact
 * count. ONE statement: the window count is taken before LIMIT, so count and
 * ids come from the same snapshot. Filter SQL may have come from a model, so
 * it runs under the filter engine's statement bound; a cancellation throws
 * `FilterQueryTimeoutError`, to be caught outside this call. Call inside a
 * run-org context.
 */
export async function listFleetFilterDeviceIds(p: { orgId: string; filter: FleetFilter; limit: number }): Promise<{ total: number; ids: string[] }> {
  const rows = await withFilterStatementTimeout((tx) => tx
    .select({ id: devices.id, total: sql<string | number>`count(*) over ()` })
    .from(devices)
    // `fleetConditions` already leaves parked devices out; the explicit guard
    // keeps this target selection covered whatever that list becomes.
    .where(and(...fleetConditions(eq(devices.orgId, p.orgId), p.filter), notParkedDeviceCondition()))
    .orderBy(asc(devices.id))
    .limit(p.limit + 1));
  return { total: Number(rows[0]?.total ?? 0), ids: rows.slice(0, p.limit).map((r) => r.id) };
}

export interface FleetFilterResolution {
  /** Exact, even above the limit. */
  count: number;
  /** Every matching device, sorted; empty when `count` is above the limit (never a truncated set). */
  deviceIds: string[];
  /** Non-empty ⇒ nothing was resolved and nothing may run. */
  problems: string[];
}

export const FLEET_FILTER_TIMEOUT_PROBLEM = 'The device filter took too long to evaluate. Narrow the filter or name the devices. Nothing was run.';

const unresolvedFilter = (problem: string): FleetFilterResolution => ({ count: 0, deviceIds: [], problems: [problem] });

/**
 * Null when `groupId` may select script targets in the run org. A group the
 * run org does not hold (another org's, a partner-wide group, deleted) is
 * refused, because its rules cannot be checked. Call inside a run-org context.
 */
async function fleetFilterGroupProblem(orgId: string, groupId: string): Promise<string | null> {
  const verdict = await classifyFleetFilterGroup(groupId, (ids) => db
    .select({ id: deviceGroups.id, type: deviceGroups.type, filterFieldsUsed: deviceGroups.filterFieldsUsed, filterConditions: deviceGroups.filterConditions })
    .from(deviceGroups)
    .where(and(inArray(deviceGroups.id, ids), eq(deviceGroups.orgId, orgId))));
  if (verdict === 'missing') return 'The device group this filter names is not available to this flow run.';
  return verdict === 'ok'
    ? null
    : 'The device group this filter names is defined by field(s) a device reports about itself, or by rules that cannot be checked; a script cannot be targeted by it.';
}

/** A typed `fleetFilter`, resolved once in the run org (#12418 W02, Decisions 4, 10 and 11). */
export async function resolveFleetFilterOnce(run: FleetRunOrg, filter: FleetFilter, limit: number): Promise<FleetFilterResolution> {
  const refused = fleetFilterExecutionRefusedFields(filter);
  if (refused.length > 0) {
    return unresolvedFilter(`fleetFilter matches on field(s) a device reports about itself (${refused.join(', ')}); a script cannot be targeted by them.`);
  }
  try {
    return await inRunOrg(run, async () => {
      if (filter.groupId !== undefined) {
        const problem = await fleetFilterGroupProblem(run.orgId, filter.groupId);
        if (problem) return unresolvedFilter(problem);
      }
      const { total, ids } = await listFleetFilterDeviceIds({ orgId: run.orgId, filter, limit });
      return { count: total, deviceIds: total <= limit ? ids : [], problems: [] };
    });
  } catch (error) {
    // Outside the bounded transaction AND the run-org one: both are over. A
    // cancelled filter is a refusal, never an empty or partial set.
    if (!(error instanceof FilterQueryTimeoutError)) throw error;
    reportFilterPreviewTimeout(run.orgId);
    return unresolvedFilter(FLEET_FILTER_TIMEOUT_PROBLEM);
  }
}
