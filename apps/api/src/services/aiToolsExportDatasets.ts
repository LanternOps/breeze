/**
 * Dataset adapters for `export_dataset` (spec §5.7).
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: every adapter delegates to the query
 * builder that already backs the corresponding tool. Not "a query that looks
 * like it"; the same function. Each of those builders carries tenant narrowing
 * that RLS does NOT enforce — the site axis — and a second hand-written query
 * is a second place to forget it. If a dataset here ever needs a shape the
 * source builder cannot produce, widen the builder and let BOTH callers get it.
 *
 * Row projections below are the tool's own response projection, one object per
 * row, flattened: the sandbox reads these with pandas/jq, so nested objects and
 * a `logs: [...]` envelope would both be hostile.
 */
import { and, desc, lt, or, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { agentLogs, devices } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiRunExportGrants } from '../db/schema/aiAgents';
import { isAutomationPrincipal } from '../middleware/principalKind';
import { searchFleetLogs } from './logSearch';
import { buildAgentLogConditions } from './aiToolsAgentLogs';
import { redactAgentLogRow } from './logRedaction';
import {
  generateDeviceInventoryReport,
  generateSoftwareInventoryReport,
  readDeviceInventoryRows,
  readSoftwareInventoryRows,
} from './reportGenerationService';
// `aiLiveReportAuthority` lives in aiToolsFleet.ts (exported by Task 4), NOT in
// siteScope.ts — importing it from the latter is a module-not-found at runtime.
import { aiLiveReportAuthority } from './aiToolsFleet';
import { resolveSiteAllowedDeviceIds } from './aiToolsSiteScope';
import type { ExportPager } from './aiToolsExportWriter';
import type { ExportDataset } from './aiToolsExportDatasetNames';
import { bootPerformanceAdapter } from './aiToolsExportDatasets/boot';
// W05 carry-over: the three datasets that predate the run frame, set-based.
import { metricsAdapter } from './aiToolsExportDatasets/metrics';
import { vulnerabilitiesAdapter } from './aiToolsExportDatasets/vulnerabilities';
import { customFieldsAdapter } from './aiToolsExportDatasets/customFields';
import { hardwareEventsAdapter } from './aiToolsExportDatasets/hardware';
import { serviceChecksAdapter } from './aiToolsExportDatasets/serviceChecks';
import { reliabilityScoresAdapter, reliabilityHistoryAdapter, reliabilityEventsAdapter } from './aiToolsExportDatasets/reliability';

// The names live in a zero-import leaf so the Zod enums can derive from them
// without an import cycle (see that file). Re-exported unchanged.
export { EXPORT_DATASETS, type ExportDataset } from './aiToolsExportDatasetNames';

export interface DatasetRequest {
  auth: AuthContext;
  orgId: string;
  filters: Record<string, unknown>;
  deviceIds: string[] | null;
  /** Devices frozen at admission, or null outside a run frame. Only the
   *  inventory adapters read it directly (as a `deviceIds` fallback into their
   *  generator); every other adapter is already narrowed by `deviceIds` + its
   *  builder. */
  runTargets: string[] | null;
  siteId: string | null;
  pageSize: number;
  /**
   * Wisp analysis sessions W02 — the run's frozen export grants: always the
   * effective set, never absent (`LEGACY_EXPORT_GRANTS` for a run admitted
   * before W02). The handler has already refused a dataset outside
   * `datasets`; an adapter reads `sensitiveGates` to decide which rows a
   * sensitive gate withholds.
   */
  exportGrants: AiRunExportGrants;
  /**
   * Plain sentences an adapter appends for the run's model (rows withheld by a
   * gate, a filter it could not apply). Created empty by the handler for each
   * call and copied into the tool result as `notes` when non-empty.
   */
  notes: string[];
}

export interface DatasetAdapter {
  tier: 1 | 2;
  deviceScoped: boolean;
  createPager(req: DatasetRequest): Promise<ExportPager>;
}

/** The site-axis narrowing `search_logs` does at `aiToolsEventLogs.ts:84`,
 *  reproduced because that call site is module-private. `null` = unrestricted
 *  caller; `[]` = restricted caller with ZERO in-scope devices, which must
 *  yield an empty export rather than an org-wide one. */
async function siteScopedDeviceIds(req: DatasetRequest): Promise<string[] | null> {
  if (!req.auth.allowedSiteIds || !req.auth.canAccessSite) return null;
  return resolveSiteAllowedDeviceIds(req.orgId, req.auth);
}

/**
 * The full narrowing set for a request: the site axis AND — execution plane
 * W04 (#5715) — the run's FROZEN device set.
 *
 * Why the run frame has to be applied here and not only in `aiToolsExport.ts`:
 * that file refuses a model-supplied `deviceIds` list that strays outside
 * `runTargets`, which bounds the export only when the model bothers to supply
 * one. An `analysis` run whose whole point is a device set frozen at admission
 * (spec §8 "Data minimisation") could otherwise call
 * `export_dataset({ dataset: 'event_logs' })` with NO filter and page the
 * entire org's logs into its sandbox — the admission cap
 * (`analysisMaxInputDevicesPerRun`), the frozen `staged_inputs.deviceIds` and
 * `workspace_stage`'s handle allowlist would all still be satisfied, because
 * the leak happens one layer earlier, when the artifact is created.
 *
 * An absent/empty `runTargets` means "no run frame" (direct chat/MCP), not "no
 * devices" — see `ToolExecutionContext.runTargets`.
 *
 * Wisp analysis sessions W02: the caller's EXACT-DEVICE axis
 * (`auth.allowedDeviceIds`) narrows too, whenever it is an array. An empty one
 * means "no devices", never "no frame": an analysis run admitted before W02
 * with no devices (W02 now refuses that launch as `frame_empty`) carries
 * `allowedDeviceIds: []` and no run frame, and without this
 * the `event_logs` adapter read that as unrestricted and exported the whole
 * org's non-security logs. It is intersected here directly rather than through
 * `resolveSiteAllowedDeviceIds`, which only answers the site axis.
 *
 * Result: exact-device ∩ run frame ∩ site axis. `[]` = export nothing; `null`
 * is reserved for a caller restricted on no axis at all.
 */
async function scopedDeviceIds(req: DatasetRequest): Promise<string[] | null> {
  const frame = req.runTargets && req.runTargets.length > 0 ? req.runTargets : null;
  const exact = Array.isArray(req.auth.allowedDeviceIds) ? req.auth.allowedDeviceIds : null;
  const site = await siteScopedDeviceIds(req);
  // The result keeps the order of the most specific axis present.
  const base = frame ?? exact ?? site;
  if (!base) return null;
  const axes: Array<readonly string[] | null> = [frame, exact, site];
  const others: Set<string>[] = [];
  for (const axis of axes) if (axis !== null && axis !== base) others.push(new Set(axis));
  return base.filter((id) => others.every((axis) => axis.has(id)));
}

/** A pager that yields nothing — the shape a zero-in-scope caller gets. */
const emptyPager: ExportPager = async () => ({ rows: [], nextCursor: null });

/** Agent attribution ids are not human report principals. Keep their export
 * inside the intersection of the authenticated ceiling and frozen run frame.
 *
 * A missing allowlist or frozen run frame is NOT an error case — `runTargets`
 * is only ever populated inside an `analysis` run frame (spec §8). A
 * ticket/anomaly/design ai_agent principal never carries one, and that is an
 * ordinary device-less call, not a caller bug: it must resolve to an empty
 * export exactly like the other zero-in-scope branches below, never a thrown
 * error that would surface as a tool failure on every such run.
 *
 * A principal org that disagrees with the REQUEST org is the opposite: it can
 * only come from a caller wiring the wrong org into the request, and reporting
 * it as an empty export would dress a caller bug up as "no data". Throw (like
 * `export_requires_run`) so it is visible (#6096 D4). */
async function agentInventoryPager(req: DatasetRequest, software: boolean): Promise<ExportPager> {
  if (req.auth.orgId !== req.orgId) {
    throw new Error(
      'export_dataset: the agent principal\'s organization does not match the requested organization',
    );
  }
  if (!req.auth.allowedDeviceIds?.length || !req.runTargets?.length) {
    return emptyPager;
  }
  const frame = new Set(req.runTargets);
  const requested = req.deviceIds === null ? null : new Set(req.deviceIds);
  const ids = req.auth.allowedDeviceIds.filter((id) => frame.has(id) && (!requested || requested.has(id)));
  if (!ids.length) return emptyPager;
  const conditions: SQL[] = [inArray(devices.id, ids)];
  if (req.auth.allowedSiteIds) {
    if (!req.auth.allowedSiteIds.length) return emptyPager;
    conditions.push(inArray(devices.siteId, req.auth.allowedSiteIds));
  }
  if (req.siteId) {
    if (req.auth.canAccessSite && !req.auth.canAccessSite(req.siteId)) return emptyPager;
    conditions.push(eq(devices.siteId, req.siteId));
  }
  if (!software && Array.isArray(req.filters.osTypes) && req.filters.osTypes.length) {
    conditions.push(inArray(devices.osType, req.filters.osTypes as Array<'windows' | 'macos' | 'linux'>));
  }
  return singlePagePager(() => software
    ? readSoftwareInventoryRows(req.orgId, conditions)
    : readDeviceInventoryRows(req.orgId, conditions));
}

/** A source that produces its whole result in one builder call. Wrapped as a
 *  one-page pager so the writer's cap/preview machinery is identical for all
 *  seven datasets. */
function singlePagePager(load: () => Promise<Array<Record<string, unknown>>>): ExportPager {
  let done = false;
  return async () => {
    if (done) return { rows: [], nextCursor: null };
    done = true;
    return { rows: await load(), nextCursor: null };
  };
}

const eventLogsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  async createPager(req) {
    const f = req.filters;
    // Same two lines `search_logs` runs before it queries (aiToolsEventLogs.ts:84).
    // `allowedDeviceIds` is the site axis, which RLS does NOT enforce; dropping
    // it would let a site-restricted tech export the whole org's logs.
    const allowedDeviceIds = await scopedDeviceIds(req);
    if (allowedDeviceIds != null && allowedDeviceIds.length === 0) return emptyPager;
    // W02: the security category reads the run's FROZEN `security_events`
    // gate. `export_dataset` runs only under an `ai_agent` run principal, which
    // has no role, so the RBAC check this replaces always answered false.
    const canReadSensitiveCategory = req.exportGrants.sensitiveGates.includes('security_events');
    if (!canReadSensitiveCategory) {
      req.notes.push('Security-category event logs are not in this export: this run does not hold the security_events gate (devices:execute).');
    }

    return async (cursor) => {
      const result = await searchFleetLogs(req.auth, {
        allowedDeviceIds,
        canReadSensitiveCategory,
        query: typeof f.query === 'string' ? f.query : undefined,
        timeRange: typeof f.timeRange === 'object' && f.timeRange !== null
          ? f.timeRange as { start?: string; end?: string }
          : undefined,
        level: Array.isArray(f.level) ? f.level as Array<'info' | 'warning' | 'error' | 'critical'> : undefined,
        category: Array.isArray(f.category) ? f.category as Array<'security' | 'hardware' | 'application' | 'system'> : undefined,
        source: typeof f.source === 'string' ? f.source : undefined,
        deviceIds: req.deviceIds ?? undefined,
        siteIds: req.siteId ? [req.siteId] : undefined,
        limit: req.pageSize,
        cursor: cursor ?? undefined,
        // `none`: a COUNT(*) per page over a multi-hundred-thousand-row range
        // is the export's whole cost again, and nothing consumes the total.
        countMode: 'none',
        sortBy: 'timestamp',
        sortOrder: 'desc',
      });
      return {
        rows: result.results.map((row) => ({
          id: row.log.id,
          timestamp: row.log.timestamp.toISOString(),
          level: row.log.level,
          category: row.log.category,
          source: row.log.source,
          eventId: row.log.eventId,
          message: row.log.message,
          deviceId: row.log.deviceId,
          hostname: row.device?.hostname ?? null,
          siteId: row.device?.siteId ?? null,
          siteName: row.site?.name ?? null,
        })),
        nextCursor: result.nextCursor,
      };
    };
  },
};

const agentLogsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  async createPager(req) {
    const f = req.filters;
    // W04: fall back to the run's frozen device set when the model supplied no
    // explicit list — `buildAgentLogConditions` narrows by the site axis only,
    // so without this an analysis run exports every agent log in the org.
    const agentLogDeviceIds = req.deviceIds
      ?? (req.runTargets && req.runTargets.length > 0 ? req.runTargets : null);
    const conditions = await buildAgentLogConditions(req.orgId, req.auth, {
      deviceIds: agentLogDeviceIds ?? undefined,
      level: typeof f.level === 'string' ? f.level : undefined,
      component: typeof f.component === 'string' ? f.component : undefined,
      startTime: typeof f.startTime === 'string' ? f.startTime : undefined,
      endTime: typeof f.endTime === 'string' ? f.endTime : undefined,
      message: typeof f.message === 'string' ? f.message : undefined,
    });
    // `null` = a site-restricted caller with zero in-scope devices.
    if (conditions === null) return async () => ({ rows: [], nextCursor: null });

    return async (cursor) => {
      // `search_agent_logs` orders by (created_at, timestamp, id) desc —
      // RECEIPT time dominates, not the agent-reported event `timestamp`,
      // because ingest writes up to 100 rows in one INSERT sharing the same
      // created_at, and the agent's own event time is unreliable across
      // receipts (aiToolsAgentLogs.ts's own comment on this exact ordering).
      // Paging on (timestamp, id) instead of (created_at, id) would both
      // diverge from the tool this adapter claims to mirror AND miss the
      // `agent_logs_org_created_at_idx` index (org_id, created_at desc, id
      // desc) — an unindexed sort over a fleet's whole log history. The
      // keyset here is (created_at, id) desc, matching both.
      const decoded = cursor
        ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t: string; id: string }
        : null;
      const keyset = decoded
        ? or(
            lt(agentLogs.createdAt, new Date(decoded.t)),
            and(eq(agentLogs.createdAt, new Date(decoded.t)), lt(agentLogs.id, decoded.id)),
          )!
        : undefined;

      const rows = await db
        .select()
        .from(agentLogs)
        .where(keyset ? and(...conditions, keyset) : and(...conditions))
        .orderBy(desc(agentLogs.createdAt), desc(agentLogs.id))
        .limit(req.pageSize);

      const last = rows[rows.length - 1];
      return {
        rows: rows.map((r) => {
          const redacted = redactAgentLogRow(r);
          return {
            id: r.id,
            deviceId: r.deviceId,
            timestamp: r.timestamp.toISOString(),
            receivedAt: r.createdAt.toISOString(),
            level: r.level,
            component: r.component,
            message: redacted.message,
            fields: redacted.fields,
            agentVersion: r.agentVersion,
          };
        }),
        nextCursor: rows.length === req.pageSize && last
          ? Buffer.from(JSON.stringify({ t: last.createdAt.toISOString(), id: last.id })).toString('base64url')
          : null,
      };
    };
  },
};

/** `generate_report` action `data` has no `software_inventory` branch and caps
 *  `device_inventory` at 100 rows — the REPORT GENERATORS are the complete
 *  builders behind both, and the ones `generate_report action: 'generate'`
 *  itself calls. Each returns its full result in one call, so one page. The
 *  writer's row/byte caps still apply to what that page yields. */
const deviceInventoryAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  async createPager(req) {
    if (isAutomationPrincipal(req.auth)) return agentInventoryPager(req, false);
    const authority = await aiLiveReportAuthority(req.auth, req.orgId, 'read');
    if (!authority) return emptyPager;
    // #5776: `generateDeviceInventoryReport` now honours `filters.deviceIds`
    // (same as `generateSoftwareInventoryReport`), so the run-target
    // restriction goes straight into the query instead of a hostname-based
    // post-filter — hostnames are not unique within an org, so filtering rows
    // by hostname could admit a device outside the run's frozen target set.
    const restrictTo = req.deviceIds ?? req.runTargets;
    return singlePagePager(async () => {
      const result = await generateDeviceInventoryReport(req.orgId, {
        filters: {
          ...(restrictTo && restrictTo.length > 0 ? { deviceIds: restrictTo } : {}),
          ...(req.siteId ? { siteIds: [req.siteId] } : {}),
          ...(Array.isArray(req.filters.osTypes) ? { osTypes: req.filters.osTypes } : {}),
        },
      }, authority);
      return (result.rows ?? []) as Array<Record<string, unknown>>;
    });
  },
};

const softwareInventoryAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  async createPager(req) {
    if (isAutomationPrincipal(req.auth)) return agentInventoryPager(req, true);
    const authority = await aiLiveReportAuthority(req.auth, req.orgId, 'read');
    if (!authority) return emptyPager;
    // This generator DOES honour filters.deviceIds, so the restriction goes
    // into the query rather than a post-filter.
    const restrictTo = req.deviceIds ?? req.runTargets;
    return singlePagePager(async () => {
      const result = await generateSoftwareInventoryReport(req.orgId, {
        filters: {
          ...(restrictTo && restrictTo.length > 0 ? { deviceIds: restrictTo } : {}),
          ...(req.siteId ? { siteIds: [req.siteId] } : {}),
        },
      }, authority);
      return (result.rows ?? []) as Array<Record<string, unknown>>;
    });
  },
};

export const DATASET_ADAPTERS: Readonly<Record<ExportDataset, DatasetAdapter>> = {
  event_logs: eventLogsAdapter,
  agent_logs: agentLogsAdapter,
  device_inventory: deviceInventoryAdapter,
  software_inventory: softwareInventoryAdapter,
  metrics: metricsAdapter,
  vulnerabilities: vulnerabilitiesAdapter,
  custom_fields: customFieldsAdapter,
  reliability_scores: reliabilityScoresAdapter,
  reliability_history: reliabilityHistoryAdapter,
  reliability_events: reliabilityEventsAdapter,
  boot_performance: bootPerformanceAdapter,
  hardware_events: hardwareEventsAdapter,
  service_checks: serviceChecksAdapter,
};
