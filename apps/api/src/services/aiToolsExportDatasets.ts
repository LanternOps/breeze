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
import { and, desc, gt, lt, or, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { agentLogs, deviceMetrics, devices } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { searchFleetLogs } from './logSearch';
import { buildAgentLogConditions } from './aiToolsAgentLogs';
import { redactAgentLogRow } from './logRedaction';
import { readCatalog, readDeviceFindings, normStatus } from './aiToolsVulnerability';
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
import type { readCustomFieldDefinitions as ReadCustomFieldDefinitionsFn } from './aiToolsDevice';
import type { verifyDeviceAccess as VerifyDeviceAccessFn } from './aiTools';
import { runWithConcurrency, EXPORT_DEVICE_CONCURRENCY, type ExportPager } from './aiToolsExportWriter';

/**
 * Lazy (call-time) imports of the two hub modules, NOT static ones.
 *
 * `aiToolsDevice.ts` already imports a value from `./aiTools`
 * (`verifyDeviceAccess`), and `aiTools.ts` eagerly calls `registerExportTools`
 * (this file's consumer) at ITS OWN module top level — so a static import here
 * closes a 4-hop cycle (aiToolsDevice → aiTools → aiToolsExport →
 * aiToolsExportDatasets → aiToolsDevice) on top of the pre-existing 2-hop one.
 * Under Vite's SSR module runner that manifested as a real, order-dependent
 * "Cannot access '__vite_ssr_import_N__' before initialization" failure that
 * only reproduced under the full test suite (whichever spec's import graph
 * happened to reach `aiToolsDevice.ts` first). Every real call site below is
 * already inside an async function — never module-eval time — so resolving
 * these via `import()` costs nothing (the module is cached after first load)
 * and removes this file from the synchronous part of the cycle entirely.
 */
async function getVerifyDeviceAccess(): Promise<typeof VerifyDeviceAccessFn> {
  return (await import('./aiTools')).verifyDeviceAccess;
}
async function getReadCustomFieldDefinitions(): Promise<typeof ReadCustomFieldDefinitionsFn> {
  return (await import('./aiToolsDevice')).readCustomFieldDefinitions;
}

export const EXPORT_DATASETS = [
  'event_logs', 'agent_logs', 'device_inventory', 'software_inventory',
  'metrics', 'vulnerabilities', 'custom_fields',
] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

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
 */
async function scopedDeviceIds(req: DatasetRequest): Promise<string[] | null> {
  const siteScoped = await siteScopedDeviceIds(req);
  const frame = req.runTargets && req.runTargets.length > 0 ? req.runTargets : null;
  if (!frame) return siteScoped;
  if (!siteScoped) return [...frame];
  const inSite = new Set(siteScoped);
  return frame.filter((id) => inSite.has(id));
}

/** A pager that yields nothing — the shape a zero-in-scope caller gets. */
const emptyPager: ExportPager = async () => ({ rows: [], nextCursor: null });

/** Agent attribution ids are not human report principals. Keep their export
 * inside the intersection of the authenticated ceiling and frozen run frame. */
async function agentInventoryPager(req: DatasetRequest, software: boolean): Promise<ExportPager> {
  if (req.auth.orgId !== req.orgId || !req.auth.allowedDeviceIds?.length || !req.runTargets?.length) {
    throw new Error('Agent inventory export requires an organization and frozen device scope');
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

    return async (cursor) => {
      const result = await searchFleetLogs(req.auth, {
        allowedDeviceIds,
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
    if (req.auth.principal?.kind === 'ai_agent') return agentInventoryPager(req, false);
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
    if (req.auth.principal?.kind === 'ai_agent') return agentInventoryPager(req, true);
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

/** `analyze_metrics` is single-device by construction (`deviceArgs:
 *  ['deviceId']`). The export fans out across the requested devices, PACED at
 *  EXPORT_DEVICE_CONCURRENCY so one analysis cannot saturate the API (spec
 *  §5.4) — but unlike the other device-scoped adapters (vulnerabilities,
 *  custom_fields), a device's samples are NOT a one-shot bounded read: at
 *  minute granularity, 24h of `hoursBack` is already ~1,440 rows, well past
 *  `req.pageSize` (500). A hard per-device cap would silently drop the rest
 *  (#5775) — the writer's row/wall caps can't see it, because the truncation
 *  would happen one layer below what they observe.
 *
 *  So each device in the CURRENT concurrency batch pages within itself on a
 *  `timestamp` keyset (querying strictly older than the oldest row seen so
 *  far) until a page comes back short of `pageSize`, which is the only signal
 *  that no more rows exist for it in the window — only THEN does the batch
 *  advance to the next slice of devices. `(device_id, timestamp)` is the
 *  table's own primary key, so timestamps are unique per device and the `lt`
 *  cursor can't skip or double-count a row at the boundary. `verifyDeviceAccess`
 *  runs once per device (at batch entry), not once per page.
 *
 *  TWO ACCEPTED TRADEOFFS from running potentially many rounds per device
 *  instead of one:
 *  (1) The site axis (`allowedSiteIds`/`canAccessSite` — RLS does NOT enforce
 *      it, see this file's own header) is checked once at batch entry and NOT
 *      re-verified on later rounds for that same device. A device whose site
 *      access is revoked mid-export keeps paging until exhausted rather than
 *      stopping immediately. Accepted because a re-check per round would add a
 *      DB round trip per page for no observed threat model change, and the
 *      window is still bounded by `hoursBack` (≤168h) and the writer's own
 *      120s wall cap.
 *  (2) A long run of access-denied devices is scanned to the end of
 *      `deviceIds` within ONE `pager()` call (the inner `for(;;)` only returns
 *      once it has rows or has exhausted every device), so the writer's
 *      wall-clock check can't interrupt mid-scan the way it could when every
 *      batch used to return control after one query. Accepted because the
 *      practical device-count bound (`analysisMaxInputDevicesPerRun`) keeps a
 *      denied-only run cheap; a future caller without that bound should
 *      revisit this. */
const metricsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: true,
  async createPager(req) {
    const hoursBack = Math.min(Math.max(1, Number(req.filters.hoursBack) || 24), 168);
    const since = new Date(Date.now() - hoursBack * 3_600_000);
    // W04: an analysis run that names no devices gets its frozen set.
    const deviceIds = req.deviceIds ?? req.runTargets ?? [];

    interface BatchDevice {
      deviceId: string;
      hostname: string | null;
      before: Date | null;
      done: boolean;
    }
    let batchStart = 0;
    let batch: BatchDevice[] = [];
    let batchInitialized = false;

    async function initBatch(): Promise<void> {
      const slice = deviceIds.slice(batchStart, batchStart + EXPORT_DEVICE_CONCURRENCY);
      const next: BatchDevice[] = [];
      await runWithConcurrency(slice, EXPORT_DEVICE_CONCURRENCY, async (deviceId) => {
        // The same per-device gate `analyze_metrics` performs. The central
        // `enforceDeviceArgs` gate already ran over `deviceIds`; this is the
        // builder's own check and is kept so the two paths stay identical.
        const verifyDeviceAccess = await getVerifyDeviceAccess();
        const access = await verifyDeviceAccess(deviceId, req.auth);
        if ('error' in access) return;
        next.push({ deviceId, hostname: access.device.hostname, before: null, done: false });
      });
      batch = next;
      batchInitialized = true;
    }

    return async () => {
      for (;;) {
        if (!batchInitialized) await initBatch();
        const active = batch.filter((d) => !d.done);
        if (active.length === 0) {
          batchStart += EXPORT_DEVICE_CONCURRENCY;
          if (batchStart >= deviceIds.length) return { rows: [], nextCursor: null };
          batchInitialized = false;
          continue;
        }

        const collected: Array<Record<string, unknown>> = [];
        await runWithConcurrency(active, EXPORT_DEVICE_CONCURRENCY, async (entry) => {
          const conditions = [eq(deviceMetrics.deviceId, entry.deviceId), gt(deviceMetrics.timestamp, since)];
          if (entry.before) conditions.push(lt(deviceMetrics.timestamp, entry.before));
          const samples = await db
            .select()
            .from(deviceMetrics)
            .where(and(...conditions))
            .orderBy(desc(deviceMetrics.timestamp))
            .limit(req.pageSize);
          for (const sample of samples) {
            collected.push({
              deviceId: entry.deviceId,
              hostname: entry.hostname,
              timestamp: sample.timestamp instanceof Date ? sample.timestamp.toISOString() : String(sample.timestamp),
              cpuPercent: sample.cpuPercent,
              ramPercent: sample.ramPercent,
              ramUsedMb: sample.ramUsedMb,
              diskPercent: sample.diskPercent,
              diskUsedGb: sample.diskUsedGb,
            });
          }
          const last = samples[samples.length - 1];
          if (samples.length < req.pageSize || !last) {
            entry.done = true;
          } else {
            entry.before = last.timestamp instanceof Date ? last.timestamp : new Date(last.timestamp as unknown as string);
          }
        });

        const moreInBatch = batch.some((d) => !d.done);
        const moreBatches = batchStart + EXPORT_DEVICE_CONCURRENCY < deviceIds.length;
        return { rows: collected, nextCursor: moreInBatch || moreBatches ? 'more' : null };
      }
    };
  },
};

const vulnerabilitiesAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: true,
  async createPager(req) {
    const status = normStatus(req.filters.status);
    // W04: an analysis run that names no devices gets its frozen set.
    const deviceIds = req.deviceIds ?? req.runTargets ?? [];
    let index = 0;

    return async () => {
      if (index >= deviceIds.length) return { rows: [], nextCursor: null };
      const batch = deviceIds.slice(index, index + EXPORT_DEVICE_CONCURRENCY);
      index += batch.length;

      const collected: Array<Record<string, unknown>> = [];
      await runWithConcurrency(batch, EXPORT_DEVICE_CONCURRENCY, async (deviceId) => {
        // Same per-device gate the metrics and custom_fields adapters make. It
        // is arguably redundant — `enforceDeviceArgs` already ran over every id
        // and `readDeviceFindings` is org-scoped — but "arguably redundant" is
        // not a reason for one of three device-scoped adapters to be the odd
        // one out; symmetry is what makes a missing gate visible in review.
        const verifyDeviceAccess = await getVerifyDeviceAccess();
        const access = await verifyDeviceAccess(deviceId, req.auth);
        if ('error' in access) return;
        const findings = await readDeviceFindings(req.orgId, { status, deviceId });
        const catalog = await readCatalog([...new Set(findings.map((f) => f.vulnerabilityId))]);
        const byId = new Map(catalog.map((c) => [c.id, c]));
        for (const finding of findings) {
          const cve = byId.get(finding.vulnerabilityId);
          if (!cve) continue;
          collected.push({
            id: finding.id,
            deviceId,
            cveId: cve.cveId,
            severity: cve.severity,
            cvssScore: cve.cvssScore,
            epssScore: cve.epssScore,
            riskScore: finding.riskScore,
            status: finding.status,
            knownExploited: cve.knownExploited ?? false,
            patchAvailable: cve.patchAvailable ?? false,
          });
        }
      });

      return { rows: collected, nextCursor: index < deviceIds.length ? String(index) : null };
    };
  },
};

/** `query_custom_fields` has two actions; the export produces the JOINED view
 *  (one row per device x definition) because that is the shape an analysis
 *  script wants, and the tool's own two shapes are not joinable downstream. */
const customFieldsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: true,
  async createPager(req) {
    // Task 4's shared reader, NOT a fresh `eq(orgId, req.orgId)` select: custom
    // field definitions are org XOR partner: a partner-wide definition has
    // `org_id IS NULL` and an org filter drops every one of them — which for an
    // MSP that defines its fields once is most of the fields on the device.
    const readCustomFieldDefinitions = await getReadCustomFieldDefinitions();
    const definitions = await readCustomFieldDefinitions(req.auth);

    // W04: an analysis run that names no devices gets its frozen set.
    const deviceIds = req.deviceIds ?? req.runTargets ?? [];
    let index = 0;

    return async () => {
      if (index >= deviceIds.length) return { rows: [], nextCursor: null };
      const batch = deviceIds.slice(index, index + EXPORT_DEVICE_CONCURRENCY);
      index += batch.length;

      const collected: Array<Record<string, unknown>> = [];
      await runWithConcurrency(batch, EXPORT_DEVICE_CONCURRENCY, async (deviceId) => {
        const verifyDeviceAccess = await getVerifyDeviceAccess();
        const access = await verifyDeviceAccess(deviceId, req.auth);
        if ('error' in access) return;
        const values = (access.device.customFields ?? {}) as Record<string, unknown>;
        for (const definition of definitions) {
          collected.push({
            deviceId,
            hostname: access.device.hostname,
            fieldKey: definition.fieldKey,
            fieldName: definition.name,
            fieldType: definition.type,
            value: values[definition.fieldKey] ?? null,
          });
        }
      });

      return { rows: collected, nextCursor: index < deviceIds.length ? String(index) : null };
    };
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
};
