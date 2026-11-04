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
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { DeploymentTargetConfig, LegacyCondition } from '@breeze/shared';
import { db, runOutsideDbContext, withDbAccessContext } from '../../../db';
import { devices } from '../../../db/schema';
import { resolveAutomationTargetsDetailed } from '../../automationRuntime';
import { flowDbAccessContext } from '../flowAuthContext';

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
