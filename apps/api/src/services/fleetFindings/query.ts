/**
 * Query builders for the fleet findings feed (list / detail / lifecycle).
 *
 * Kept separate from routes/fleetFindings.ts (a thin HTTP layer over these
 * functions) so Task 8's `get_fleet_findings` AI tool can reuse the exact
 * same scoping/filtering logic instead of re-deriving it — see CLAUDE.md's
 * warning about AI-tool/route dual-map drift.
 *
 * Org isolation: RLS on the request's db context, same as every other
 * request-path table. Site axis is app-layer only (RLS does not cover
 * sites): a site-restricted caller (`auth.allowedSiteIds` set) gets
 * `deviceCount` recomputed from live membership joined to
 * `devices.siteId ∈ allowedSiteIds`, and any finding with zero in-site
 * members is omitted entirely (list) or hidden (detail, 404-equivalent
 * `null`) — fail closed, never expose an org-wide finding's existence to a
 * caller who cannot see any of its member devices.
 *
 * Volume assumption: fleet hygiene findings are deduplicated, aggregate rows
 * (one per semantic episode, not per event), so a full per-org fetch +
 * JS-side site-filter/paginate is the same trade-off already made by
 * `services/vulnerabilityFleetQueries.ts` — it keeps the site-filter +
 * "omit zero-member" + "total reflects the post-filter set" semantics
 * trivially consistent, which a SQL-level LIMIT/OFFSET combined with a
 * post-hoc JS filter would not (the count and the page could disagree).
 */
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { db } from '../../db';
import { devices, organizations } from '../../db/schema';
import {
  fleetFindingDevices,
  fleetFindings,
  fleetRemediationRunTargets,
  fleetRemediationRuns,
  type FleetFindingKind,
  type FleetFindingSeverity,
  type FleetFindingStatus,
  type FleetRunStatus,
  type FleetTargetStatus,
} from '../../db/schema/fleetFindings';
import type { AuthContext } from '../../middleware/auth';

export interface FleetFindingRow {
  id: string;
  orgId: string;
  orgName: string | null;
  kind: FleetFindingKind;
  semanticKey: string;
  algorithmVersion: number;
  status: FleetFindingStatus;
  severity: FleetFindingSeverity;
  title: string;
  summary: string | null;
  evidence: Record<string, unknown>;
  deviceCount: number;
  revision: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastReconciledAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  dismissedAt: string | null;
  dismissedBy: string | null;
  dismissNotes: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors `devices.osType` (`db/schema/devices.ts`'s `osTypeEnum`). Local
 *  literal union rather than an import so this module doesn't pull in the
 *  full devices schema module surface just for one enum — same precedent as
 *  `routes/scriptLibrary.ts`'s local `OsType`. */
export type DeviceOsType = 'windows' | 'macos' | 'linux';

export interface FleetFindingMember {
  deviceId: string;
  hostname: string;
  displayName: string | null;
  siteId: string;
  /** Lets remediation UIs (fix picker) cross-reference a chosen script's
   *  `os_types` against each member device BEFORE dispatch, rather than
   *  discovering the mismatch per-device at agent execution time. */
  osType: DeviceOsType;
  sourceKind: string;
  sourceRowId: string | null;
  memberEvidence: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface FleetFindingRun {
  id: string;
  actionKind: 'script' | 'command';
  scriptId: string | null;
  /**
   * Operator-chosen run context (#4888). NULL = the script's saved default,
   * which is what the dispatcher resolves it to.
   */
  runAs: 'system' | 'user' | 'elevated' | null;
  commandType: string | null;
  status: FleetRunStatus;
  targetCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface FleetFindingDetail extends FleetFindingRow {
  members: FleetFindingMember[];
  runs: FleetFindingRun[];
}

type RunCountProjection = Pick<
  FleetFindingRun,
  'targetCount' | 'succeededCount' | 'failedCount' | 'skippedCount'
>;

function countVisibleRunTargets(targets: Array<{ status: FleetTargetStatus }>): RunCountProjection {
  let succeededCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  for (const target of targets) {
    if (target.status === 'succeeded') succeededCount += 1;
    else if (target.status === 'failed') failedCount += 1;
    else if (target.status === 'skipped') skippedCount += 1;
  }
  return { targetCount: targets.length, succeededCount, failedCount, skippedCount };
}

const RUN_LIST_METADATA_COLUMNS = {
  id: fleetRemediationRuns.id,
  actionKind: fleetRemediationRuns.actionKind,
  scriptId: fleetRemediationRuns.scriptId,
  runAs: fleetRemediationRuns.runAs,
  commandType: fleetRemediationRuns.commandType,
  status: fleetRemediationRuns.status,
  createdBy: fleetRemediationRuns.createdBy,
  createdAt: fleetRemediationRuns.createdAt,
  startedAt: fleetRemediationRuns.startedAt,
  completedAt: fleetRemediationRuns.completedAt,
};

type RunListRow = RunCountProjection & {
  id: string;
  actionKind: 'script' | 'command';
  scriptId: string | null;
  runAs: 'system' | 'user' | 'elevated' | null;
  commandType: string | null;
  status: FleetRunStatus;
  createdBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

export interface FleetFindingListFilters {
  /** Already access-checked by the caller (route or AI tool) — trusted as-is. */
  orgId?: string;
  kind?: FleetFindingKind;
  severity?: FleetFindingSeverity;
  statuses: FleetFindingStatus[];
  limit: number;
  offset: number;
}

export interface FleetFindingListResult {
  findings: FleetFindingRow[];
  total: number;
}

type RawFindingRow = {
  id: string;
  orgId: string;
  orgName: string | null;
  kind: string;
  semanticKey: string;
  algorithmVersion: number;
  status: string;
  severity: string;
  title: string;
  summary: string | null;
  evidence: unknown;
  deviceCount: number;
  revision: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastReconciledAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  dismissedAt: Date | null;
  dismissedBy: string | null;
  dismissNotes: string | null;
  resolvedAt: Date | null;
  resolutionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const FINDING_COLUMNS = {
  id: fleetFindings.id,
  orgId: fleetFindings.orgId,
  kind: fleetFindings.kind,
  semanticKey: fleetFindings.semanticKey,
  algorithmVersion: fleetFindings.algorithmVersion,
  status: fleetFindings.status,
  severity: fleetFindings.severity,
  title: fleetFindings.title,
  summary: fleetFindings.summary,
  evidence: fleetFindings.evidence,
  deviceCount: fleetFindings.deviceCount,
  revision: fleetFindings.revision,
  firstSeenAt: fleetFindings.firstSeenAt,
  lastSeenAt: fleetFindings.lastSeenAt,
  lastReconciledAt: fleetFindings.lastReconciledAt,
  acknowledgedAt: fleetFindings.acknowledgedAt,
  acknowledgedBy: fleetFindings.acknowledgedBy,
  dismissedAt: fleetFindings.dismissedAt,
  dismissedBy: fleetFindings.dismissedBy,
  dismissNotes: fleetFindings.dismissNotes,
  resolvedAt: fleetFindings.resolvedAt,
  resolutionReason: fleetFindings.resolutionReason,
  createdAt: fleetFindings.createdAt,
  updatedAt: fleetFindings.updatedAt,
};

function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function serializeFinding(row: RawFindingRow): FleetFindingRow {
  return {
    id: row.id,
    orgId: row.orgId,
    orgName: row.orgName ?? null,
    kind: row.kind as FleetFindingKind,
    semanticKey: row.semanticKey,
    algorithmVersion: row.algorithmVersion,
    status: row.status as FleetFindingStatus,
    severity: row.severity as FleetFindingSeverity,
    title: row.title,
    summary: row.summary ?? null,
    evidence: (row.evidence ?? {}) as Record<string, unknown>,
    deviceCount: row.deviceCount,
    revision: row.revision,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    lastReconciledAt: isoOrNull(row.lastReconciledAt),
    acknowledgedAt: isoOrNull(row.acknowledgedAt),
    acknowledgedBy: row.acknowledgedBy ?? null,
    dismissedAt: isoOrNull(row.dismissedAt),
    dismissedBy: row.dismissedBy ?? null,
    dismissNotes: row.dismissNotes ?? null,
    resolvedAt: isoOrNull(row.resolvedAt),
    resolutionReason: row.resolutionReason ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const FINDING_KIND_LABELS: Record<string, string> = {
  metric_anomaly_pattern: 'Metric anomaly pattern',
  log_correlation: 'Log pattern',
  reliability_offenders: 'Low reliability',
};

/**
 * Project a finding's cached producer metadata onto the member devices the
 * caller can actually see.
 *
 * `title`, `summary` and `evidence` are an org-wide cache written by the
 * producer: they embed totals and a bounded sample of individual devices (ids
 * and hostnames). They cannot be recomputed accurately from the samples after
 * filtering, so whenever the caller is scope-restricted, or the cache no
 * longer matches current membership, they are replaced with a neutral title
 * built from the visible member count. Per-device detail stays available
 * through the (scoped) member list.
 */
function projectFindingMetadata(
  row: RawFindingRow,
  visibleDeviceIds: ReadonlySet<string>,
  scopeRestricted: boolean
): RawFindingRow {
  const cachedSamples = (row.evidence as { samples?: unknown } | null)?.samples;
  const hasNonMemberSample = Array.isArray(cachedSamples) && cachedSamples.some(
    (sample) => !sample || typeof sample !== 'object'
      || !visibleDeviceIds.has((sample as { deviceId?: unknown }).deviceId as string)
  );
  if (!scopeRestricted && row.deviceCount === visibleDeviceIds.size && !hasNonMemberSample) return row;

  const count = visibleDeviceIds.size;
  return {
    ...row,
    deviceCount: count,
    title: `${FINDING_KIND_LABELS[row.kind] ?? 'Fleet finding'}: ${count} ${count === 1 ? 'device' : 'devices'}`,
    summary: null,
    evidence: { totalDevices: count },
  };
}

/**
 * Fetch the CURRENT member deviceIds visible to `auth`, per finding — shared by
 * `listFleetFindings` and `getFleetFindingCounts` so the two don't drift (see
 * the module doc's warning about dual-map drift between call sites).
 *
 * Applies to every caller, not only scope-restricted ones: a member counts only
 * while its device is still in the finding's own org (a membership row can
 * outlive a device's move to another org that a partner can also read). On top
 * of that, the site axis and the exact-device axis each narrow independently —
 * a device-less analysis run carries `allowedDeviceIds` with no
 * `allowedSiteIds`, so a site-keyed guard alone would be a silent no-op for it.
 *
 * Returns `null` — with NO query issued — when there is nothing to check
 * (either allowlist empty, or no candidate findings): callers must treat that
 * as "nothing visible" and return their own empty result, matching the
 * existing fail-closed contract (an empty allowlist can never match).
 */
async function findingDeviceIdsForCaller(
  candidateFindingIds: readonly string[],
  auth: AuthContext
): Promise<Map<string, Set<string>> | null> {
  const { allowedSiteIds, allowedDeviceIds } = auth;
  if (candidateFindingIds.length === 0) return null;
  // An empty allowlist on EITHER axis can never match — fail closed with no query.
  if (allowedSiteIds?.length === 0 || allowedDeviceIds?.length === 0) return null;

  const memberConditions: SQL[] = [inArray(fleetFindingDevices.findingId, candidateFindingIds)];
  if (allowedSiteIds) memberConditions.push(inArray(devices.siteId, allowedSiteIds));
  if (allowedDeviceIds) memberConditions.push(inArray(fleetFindingDevices.deviceId, [...allowedDeviceIds]));

  const memberRows = await db
    .select({ findingId: fleetFindingDevices.findingId, deviceId: fleetFindingDevices.deviceId })
    .from(fleetFindingDevices)
    .innerJoin(fleetFindings, eq(fleetFindingDevices.findingId, fleetFindings.id))
    .innerJoin(
      devices,
      and(eq(fleetFindingDevices.deviceId, devices.id), eq(devices.orgId, fleetFindings.orgId))
    )
    .where(and(...memberConditions));

  const deviceIdsByFinding = new Map<string, Set<string>>();
  for (const m of memberRows) {
    const set = deviceIdsByFinding.get(m.findingId) ?? new Set<string>();
    set.add(m.deviceId);
    deviceIdsByFinding.set(m.findingId, set);
  }
  return deviceIdsByFinding;
}

/**
 * True when the caller is narrowed on EITHER app-layer device axis. The two are
 * independent: a site-restricted human carries only `allowedSiteIds`, a
 * device-bound/device-less agent run only `allowedDeviceIds`, and a guard that
 * tests one is a silent no-op for the other shape.
 */
function callerIsScopeRestricted(auth: AuthContext): boolean {
  return auth.allowedSiteIds !== undefined || auth.allowedDeviceIds !== undefined;
}

function buildOrgCondition(auth: AuthContext, requestedOrgId: string | undefined): SQL | undefined {
  if (requestedOrgId) {
    return eq(fleetFindings.orgId, requestedOrgId);
  }
  return auth.orgCondition(fleetFindings.orgId);
}

// The "fetch everything, filter/paginate in JS" trade-off below only holds
// for LIVE findings: `fleet_findings_live_episode_uq` (WHERE resolved_at IS
// NULL) caps the live set at one row per org/kind/semanticKey, so a full
// per-org fetch is always small. Resolved findings carry no such bound —
// they accumulate forever — so a `status` filter that includes `resolved`
// would otherwise pull an org's entire resolved-finding history before ever
// touching the JS slice. When `resolved` is requested, cap the SQL fetch
// itself (ordered by `lastSeenAt DESC`, same ordering the feed index
// supports) instead. This makes resolved-history browsing a *windowed* view:
// paging past `RESOLVED_HISTORY_FETCH_CAP` rows returns an empty page rather
// than the true tail of history. Acceptable for a hygiene-findings audit
// trail; the live-status path's exact site-filter-then-count consistency is
// untouched (no SQL limit applied there).
const RESOLVED_HISTORY_FETCH_CAP = 500;

/**
 * List findings visible to `auth`, with site-axis narrowing applied.
 *
 * `filters.orgId` MUST already be access-checked by the caller
 * (`auth.canAccessOrg`) — this function trusts it as-is, matching the
 * `resolveOrgId`/`resolveSingleOrgId` convention used by `routes/logs.ts` and
 * `routes/networkChanges.ts` (access-check is an HTTP/caller concern; this is
 * the query layer).
 */
export async function listFleetFindings(
  auth: AuthContext,
  filters: FleetFindingListFilters
): Promise<FleetFindingListResult> {
  const conditions: SQL[] = [];
  const orgCondition = buildOrgCondition(auth, filters.orgId);
  if (orgCondition) conditions.push(orgCondition);
  if (filters.kind) conditions.push(eq(fleetFindings.kind, filters.kind));
  if (filters.severity) conditions.push(eq(fleetFindings.severity, filters.severity));
  conditions.push(inArray(fleetFindings.status, filters.statuses));

  const baseQuery = db
    .select({ ...FINDING_COLUMNS, orgName: organizations.name })
    .from(fleetFindings)
    .leftJoin(organizations, eq(fleetFindings.orgId, organizations.id))
    .where(and(...conditions))
    .orderBy(desc(fleetFindings.lastSeenAt));

  const includesResolvedHistory = filters.statuses.includes('resolved');
  // Fetch the whole window, not `offset + limit`. `total` below is derived from
  // this result set, so capping at the page boundary would report
  // `total === limit` on every page and make the pager conclude there is only
  // one — the resolved history would be unreachable past page 1. The cap that
  // matters is the 500-row window documented above; within it, `total` is exact.
  const rows = (includesResolvedHistory
    ? await baseQuery.limit(RESOLVED_HISTORY_FETCH_CAP)
    : await baseQuery) as RawFindingRow[];

  const deviceIdsByFinding = await findingDeviceIdsForCaller(rows.map((r) => r.id), auth);
  if (deviceIdsByFinding === null) {
    return { findings: [], total: 0 };
  }

  const restricted = callerIsScopeRestricted(auth);
  const scoped = rows
    .filter((r) => (deviceIdsByFinding.get(r.id)?.size ?? 0) > 0)
    .map((r) => projectFindingMetadata(r, deviceIdsByFinding.get(r.id)!, restricted));

  const total = scoped.length;
  const page = scoped.slice(filters.offset, filters.offset + filters.limit);

  return { findings: page.map(serializeFinding), total };
}

export interface FleetFindingCounts {
  total: number;
  byOrg: Record<string, number>;
}

/**
 * Open-finding counts per org (+ fleet total), for the mobile Systems tab
 * (#5139 / #5117 decision 1): folds fleet-hygiene findings into the same
 * "issue count" the AI's `get_fleet_findings` tool already reports, so a
 * technician opening Systems sees the same picture.
 *
 * Only `status = 'open'` counts — acknowledged/dismissed/resolved findings
 * are already being worked or closed out and must not inflate the count a
 * technician is triaging against.
 *
 * Scoping mirrors `listFleetFindings`: `auth.orgCondition` narrows the SQL
 * fetch, and a site-restricted caller (`auth.allowedSiteIds` set) gets the
 * result narrowed further to findings with at least one member device in an
 * allowed site — same fail-closed semantics (a finding with zero in-scope
 * members must not inflate a count the caller cannot otherwise see).
 */
export async function getFleetFindingCounts(auth: AuthContext): Promise<FleetFindingCounts> {
  const conditions: SQL[] = [eq(fleetFindings.status, 'open')];
  const orgCondition = auth.orgCondition(fleetFindings.orgId);
  if (orgCondition) conditions.push(orgCondition);

  const rows = (await db
    .select({ id: fleetFindings.id, orgId: fleetFindings.orgId })
    .from(fleetFindings)
    .where(and(...conditions))) as Array<{ id: string; orgId: string }>;

  const deviceIdsByFinding = await findingDeviceIdsForCaller(rows.map((r) => r.id), auth);
  if (deviceIdsByFinding === null) {
    return { total: 0, byOrg: {} };
  }

  const scoped = rows.filter((r) => (deviceIdsByFinding.get(r.id)?.size ?? 0) > 0);

  const byOrg: Record<string, number> = {};
  for (const r of scoped) {
    byOrg[r.orgId] = (byOrg[r.orgId] ?? 0) + 1;
  }

  return { total: scoped.length, byOrg };
}

/**
 * Fetch a single finding + live member devices + last 10 runs, scoped to
 * `auth`. Returns `null` when the finding doesn't exist, isn't in an
 * accessible org, or (for a site-restricted caller) has zero members in an
 * allowed site — the last case fails closed rather than revealing the
 * finding's existence/metadata to a caller who cannot see any of its devices.
 */
export async function getFleetFinding(auth: AuthContext, id: string): Promise<FleetFindingDetail | null> {
  const conditions: SQL[] = [eq(fleetFindings.id, id)];
  const orgCondition = auth.orgCondition(fleetFindings.orgId);
  if (orgCondition) conditions.push(orgCondition);

  const [row] = (await db
    .select({ ...FINDING_COLUMNS, orgName: organizations.name })
    .from(fleetFindings)
    .leftJoin(organizations, eq(fleetFindings.orgId, organizations.id))
    .where(and(...conditions))
    .limit(1)) as RawFindingRow[];

  if (!row) return null;

  const { allowedSiteIds, allowedDeviceIds } = auth;
  if (allowedSiteIds?.length === 0 || allowedDeviceIds?.length === 0) return null;

  // Current members only: the device must still be in the finding's own org,
  // and inside the caller's site/device scope. Applied in SQL so nothing
  // outside scope is ever read, and re-checked below on the returned rows.
  const memberConditions: SQL[] = [
    eq(fleetFindingDevices.findingId, id),
    eq(devices.orgId, row.orgId),
  ];
  if (allowedSiteIds) memberConditions.push(inArray(devices.siteId, allowedSiteIds));
  if (allowedDeviceIds) memberConditions.push(inArray(fleetFindingDevices.deviceId, [...allowedDeviceIds]));

  const memberRows = await db
    .select({
      deviceId: fleetFindingDevices.deviceId,
      sourceKind: fleetFindingDevices.sourceKind,
      sourceRowId: fleetFindingDevices.sourceRowId,
      memberEvidence: fleetFindingDevices.memberEvidence,
      firstSeenAt: fleetFindingDevices.firstSeenAt,
      lastSeenAt: fleetFindingDevices.lastSeenAt,
      hostname: devices.hostname,
      displayName: devices.displayName,
      siteId: devices.siteId,
      osType: devices.osType,
    })
    .from(fleetFindingDevices)
    .innerJoin(devices, eq(fleetFindingDevices.deviceId, devices.id))
    .where(and(...memberConditions))
    .orderBy(desc(fleetFindingDevices.lastSeenAt));

  const filteredMembers = memberRows.filter((m) => (
    (!allowedSiteIds || allowedSiteIds.includes(m.siteId))
    && (!allowedDeviceIds || allowedDeviceIds.includes(m.deviceId))
  ));

  // No current member in scope — omit, mirroring the list endpoint.
  if (filteredMembers.length === 0) return null;

  const restricted = callerIsScopeRestricted(auth);

  // Recent run history. For a scope-restricted caller the per-run counts are
  // recomputed from the targets whose device is CURRENTLY in scope (and in the
  // run's org); the stored totals would reveal activity on hidden devices.
  // Runs with no visible target drop out. Visibility is applied in SQL before
  // the 10-row cap so hidden-only runs cannot crowd out visible ones.
  let runRows: RunListRow[];
  if (!restricted) {
    runRows = await db
      .select({
        ...RUN_LIST_METADATA_COLUMNS,
        targetCount: fleetRemediationRuns.targetCount,
        succeededCount: fleetRemediationRuns.succeededCount,
        failedCount: fleetRemediationRuns.failedCount,
        skippedCount: fleetRemediationRuns.skippedCount,
      })
      .from(fleetRemediationRuns)
      .where(eq(fleetRemediationRuns.findingId, id))
      .orderBy(desc(fleetRemediationRuns.createdAt))
      .limit(10);
  } else {
    const targetConditions: SQL[] = [eq(fleetRemediationRuns.findingId, id)];
    if (allowedSiteIds) targetConditions.push(inArray(devices.siteId, allowedSiteIds));
    if (allowedDeviceIds) targetConditions.push(inArray(fleetRemediationRunTargets.targetDeviceUuid, [...allowedDeviceIds]));
    runRows = await db
      .select({
        ...RUN_LIST_METADATA_COLUMNS,
        targetCount: sql<number>`count(*)::int`,
        succeededCount: sql<number>`(count(*) filter (where ${fleetRemediationRunTargets.status} = 'succeeded'))::int`,
        failedCount: sql<number>`(count(*) filter (where ${fleetRemediationRunTargets.status} = 'failed'))::int`,
        skippedCount: sql<number>`(count(*) filter (where ${fleetRemediationRunTargets.status} = 'skipped'))::int`,
      })
      .from(fleetRemediationRuns)
      .innerJoin(fleetRemediationRunTargets, eq(fleetRemediationRunTargets.runId, fleetRemediationRuns.id))
      .innerJoin(
        devices,
        and(
          eq(devices.id, fleetRemediationRunTargets.targetDeviceUuid),
          eq(devices.orgId, fleetRemediationRuns.orgId)
        )
      )
      .where(and(...targetConditions))
      .groupBy(...Object.values(RUN_LIST_METADATA_COLUMNS))
      .orderBy(desc(fleetRemediationRuns.createdAt))
      .limit(10);
  }

  return {
    ...serializeFinding(projectFindingMetadata(
      row,
      new Set(filteredMembers.map((m) => m.deviceId)),
      restricted
    )),
    members: filteredMembers.map((m) => ({
      deviceId: m.deviceId,
      hostname: m.hostname,
      displayName: m.displayName ?? null,
      siteId: m.siteId,
      osType: m.osType as DeviceOsType,
      sourceKind: m.sourceKind,
      sourceRowId: m.sourceRowId ?? null,
      // Some producers capture the hostname at detection time; report the
      // device's current one instead.
      memberEvidence: m.memberEvidence && typeof m.memberEvidence === 'object' && 'hostname' in m.memberEvidence
        ? { ...(m.memberEvidence as Record<string, unknown>), hostname: m.hostname }
        : (m.memberEvidence ?? {}) as Record<string, unknown>,
      firstSeenAt: m.firstSeenAt.toISOString(),
      lastSeenAt: m.lastSeenAt.toISOString(),
    })),
    runs: runRows.map((r) => ({
      id: r.id,
      actionKind: r.actionKind,
      scriptId: r.scriptId ?? null,
      runAs: r.runAs ?? null,
      commandType: r.commandType ?? null,
      status: r.status,
      targetCount: r.targetCount,
      succeededCount: r.succeededCount,
      failedCount: r.failedCount,
      skippedCount: r.skippedCount,
      createdBy: r.createdBy ?? null,
      createdAt: r.createdAt.toISOString(),
      startedAt: isoOrNull(r.startedAt),
      completedAt: isoOrNull(r.completedAt),
    })),
  };
}

export interface FleetRemediationRunTargetRow {
  deviceId: string;
  hostname: string | null;
  siteId: string | null;
  status: FleetTargetStatus;
  skipReason: string | null;
  deviceCommandId: string | null;
  resultSummary: string | null;
  queuedAt: string | null;
  completedAt: string | null;
}

export interface FleetRemediationRunDetail extends FleetFindingRun {
  orgId: string;
  findingId: string;
  findingRevision: number;
  parameterSnapshot: Record<string, unknown>;
  targets: FleetRemediationRunTargetRow[];
}

/**
 * Fetch a single remediation run by id (used by `GET /fleet/findings/runs/:runId`),
 * scoped to `auth` the same way `getFleetFinding` scopes a finding: RLS/org
 * condition on the run's own `orgId` column, then — for a scope-restricted
 * caller — a join from each target to its device's CURRENT org and site. A
 * device can move after a run was created, so the site/hostname snapshots are
 * never trusted for authorization, and the run's counts are recomputed from
 * the visible targets rather than returned as stored global totals.
 *
 * Returns `null` when the run doesn't exist, isn't in an accessible org, or
 * (for a site-restricted caller) has zero targets in an allowed site —
 * including the `allowedSiteIds: []` case. That last branch fails closed for
 * the same reason `getFleetFinding` does: a run's own metadata (which finding,
 * which script/command, how many devices, when, by whom) is a description of
 * activity on devices the caller cannot see, so returning it with an empty
 * `targets` array would leak exactly the thing the site axis exists to hide.
 */
export async function getRemediationRun(auth: AuthContext, runId: string): Promise<FleetRemediationRunDetail | null> {
  const conditions: SQL[] = [eq(fleetRemediationRuns.id, runId)];
  const orgCondition = auth.orgCondition(fleetRemediationRuns.orgId);
  if (orgCondition) conditions.push(orgCondition);

  const [run] = await db
    .select()
    .from(fleetRemediationRuns)
    .where(and(...conditions))
    .limit(1);

  if (!run) return null;

  const { allowedSiteIds, allowedDeviceIds } = auth;
  const restricted = callerIsScopeRestricted(auth);
  if (allowedSiteIds?.length === 0 || allowedDeviceIds?.length === 0) return null;

  let targetRows: Array<{
    targetDeviceUuid: string;
    hostnameSnapshot: string | null;
    siteIdSnapshot: string | null;
    status: FleetTargetStatus;
    skipReason: string | null;
    deviceCommandId: string | null;
    resultSummary: string | null;
    queuedAt: Date | null;
    completedAt: Date | null;
  }>;
  if (!restricted) {
    targetRows = await db
      .select()
      .from(fleetRemediationRunTargets)
      .where(eq(fleetRemediationRunTargets.runId, runId));
  } else {
    const targetConditions: SQL[] = [eq(fleetRemediationRunTargets.runId, runId)];
    if (allowedSiteIds) targetConditions.push(inArray(devices.siteId, allowedSiteIds));
    if (allowedDeviceIds) targetConditions.push(inArray(fleetRemediationRunTargets.targetDeviceUuid, [...allowedDeviceIds]));
    targetRows = await db
      .select({
        targetDeviceUuid: fleetRemediationRunTargets.targetDeviceUuid,
        // Authorization is on the device's CURRENT site, so report the
        // matching current values rather than a historical snapshot from a
        // site the caller may never have been allowed to see.
        hostnameSnapshot: devices.hostname,
        siteIdSnapshot: devices.siteId,
        status: fleetRemediationRunTargets.status,
        skipReason: fleetRemediationRunTargets.skipReason,
        deviceCommandId: fleetRemediationRunTargets.deviceCommandId,
        resultSummary: fleetRemediationRunTargets.resultSummary,
        queuedAt: fleetRemediationRunTargets.queuedAt,
        completedAt: fleetRemediationRunTargets.completedAt,
      })
      .from(fleetRemediationRunTargets)
      .innerJoin(
        devices,
        and(eq(devices.id, fleetRemediationRunTargets.targetDeviceUuid), eq(devices.orgId, run.orgId))
      )
      .where(and(...targetConditions));
  }

  const visibleTargets = targetRows.filter((t) => (
    (!allowedSiteIds || (!!t.siteIdSnapshot && allowedSiteIds.includes(t.siteIdSnapshot)))
    && (!allowedDeviceIds || allowedDeviceIds.includes(t.targetDeviceUuid))
  ));

  if (restricted && visibleTargets.length === 0) return null;

  const counts: RunCountProjection = restricted
    ? countVisibleRunTargets(visibleTargets)
    : {
        targetCount: run.targetCount,
        succeededCount: run.succeededCount,
        failedCount: run.failedCount,
        skippedCount: run.skippedCount,
      };

  return {
    id: run.id,
    orgId: run.orgId,
    findingId: run.findingId,
    findingRevision: run.findingRevision,
    actionKind: run.actionKind,
    scriptId: run.scriptId ?? null,
    runAs: run.runAs ?? null,
    commandType: run.commandType ?? null,
    parameterSnapshot: (run.parameterSnapshot ?? {}) as Record<string, unknown>,
    status: run.status,
    ...counts,
    createdBy: run.createdBy ?? null,
    createdAt: run.createdAt.toISOString(),
    startedAt: isoOrNull(run.startedAt),
    completedAt: isoOrNull(run.completedAt),
    targets: visibleTargets.map((t) => ({
      deviceId: t.targetDeviceUuid,
      hostname: t.hostnameSnapshot ?? null,
      siteId: t.siteIdSnapshot ?? null,
      status: t.status,
      skipReason: t.skipReason ?? null,
      deviceCommandId: t.deviceCommandId ?? null,
      resultSummary: t.resultSummary ?? null,
      queuedAt: isoOrNull(t.queuedAt),
      completedAt: isoOrNull(t.completedAt),
    })),
  };
}

export type FleetFindingLifecycleAction = 'acknowledge' | 'dismiss' | 'reopen';

export type FleetFindingLifecycleResult =
  | { ok: true; finding: FleetFindingRow }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 403; error: string }
  | { ok: false; status: 400; error: string };

// reopen deliberately excludes 'open' (nothing to reopen) and 'resolved'
// (only the reconciler moves a finding to/from resolved, by opening a fresh
// live episode — never via this lifecycle API).
const ALLOWED_SOURCE_STATUSES: Record<FleetFindingLifecycleAction, FleetFindingStatus[]> = {
  acknowledge: ['open'],
  dismiss: ['open', 'acknowledged'],
  reopen: ['acknowledged', 'dismissed'],
};

const TARGET_STATUS: Record<FleetFindingLifecycleAction, FleetFindingStatus> = {
  acknowledge: 'acknowledged',
  dismiss: 'dismissed',
  reopen: 'open',
};

/**
 * Apply an acknowledge/dismiss/reopen transition, stamping the acting user
 * and timestamp columns. Returns a discriminated result so the route can map
 * it straight to an HTTP status — no exceptions for expected outcomes
 * (not-found, partial access, invalid transition).
 *
 * A finding is ONE row shared by all of its member devices, so a transition
 * applies to every member at once. The caller must therefore be able to see
 * every current member:
 * - no visible member at all -> 404, exactly like the read paths (the finding
 *   does not exist for this caller);
 * - some members outside the caller's site/device scope -> 403, and nothing
 *   is written.
 *
 * The finding row is locked FOR UPDATE and the member devices FOR SHARE for
 * the whole check-then-write, so a concurrent device site/org move cannot
 * change the visibility answer between the check and the update.
 */
export async function applyFleetFindingLifecycle(
  auth: AuthContext,
  id: string,
  action: FleetFindingLifecycleAction,
  notes: string | undefined,
  actorUserId: string
): Promise<FleetFindingLifecycleResult> {
  return db.transaction(async (tx) => {
    const conditions: SQL[] = [eq(fleetFindings.id, id)];
    const orgCondition = auth.orgCondition(fleetFindings.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const [existing] = (await tx
      .select({ ...FINDING_COLUMNS, orgName: organizations.name })
      .from(fleetFindings)
      .leftJoin(organizations, eq(fleetFindings.orgId, organizations.id))
      .where(and(...conditions))
      .limit(1)
      .for('update', { of: fleetFindings })) as RawFindingRow[];

    if (!existing) {
      return { ok: false, status: 404, error: 'Finding not found' };
    }

    const { allowedSiteIds, allowedDeviceIds } = auth;
    // An empty allowlist on either axis can never match — fail closed with no
    // membership query, mirroring the read paths.
    if (allowedSiteIds?.length === 0 || allowedDeviceIds?.length === 0) {
      return { ok: false, status: 404, error: 'Finding not found' };
    }

    const memberRows = await tx
      .select({
        deviceId: fleetFindingDevices.deviceId,
        orgId: devices.orgId,
        siteId: devices.siteId,
      })
      .from(fleetFindingDevices)
      .innerJoin(devices, eq(fleetFindingDevices.deviceId, devices.id))
      .where(eq(fleetFindingDevices.findingId, id))
      .orderBy(fleetFindingDevices.deviceId)
      .for('share', { of: devices });

    // A member counts only while its device is still in the finding's own
    // org: a membership row can briefly outlive a device's move to another
    // org that a partner-scoped caller may also be able to read.
    const currentMembers = memberRows.filter((m) => m.orgId === existing.orgId);
    const visibleMembers = currentMembers.filter((m) => (
      (!allowedSiteIds || allowedSiteIds.includes(m.siteId))
      && (!allowedDeviceIds || allowedDeviceIds.includes(m.deviceId))
    ));

    if (visibleMembers.length === 0) {
      return { ok: false, status: 404, error: 'Finding not found' };
    }
    if (callerIsScopeRestricted(auth) && visibleMembers.length !== memberRows.length) {
      return {
        ok: false,
        status: 403,
        error: 'This finding includes devices outside your access; only a user who can access all of its devices can change its status',
      };
    }

    const allowedSources = ALLOWED_SOURCE_STATUSES[action];
    if (!allowedSources.includes(existing.status as FleetFindingStatus)) {
      return {
        ok: false,
        status: 400,
        error: `Cannot ${action} a finding with status '${existing.status}'`,
      };
    }

    const now = new Date();
    const updateValues: Partial<typeof fleetFindings.$inferInsert> = {
      status: TARGET_STATUS[action],
      updatedAt: now,
    };

    if (action === 'acknowledge') {
      updateValues.acknowledgedAt = now;
      updateValues.acknowledgedBy = actorUserId;
    } else if (action === 'dismiss') {
      updateValues.dismissedAt = now;
      updateValues.dismissedBy = actorUserId;
      updateValues.dismissNotes = notes ?? null;
    } else {
      // reopen: clear prior lifecycle stamps so a fresh ack/dismiss cycle starts clean.
      updateValues.acknowledgedAt = null;
      updateValues.acknowledgedBy = null;
      updateValues.dismissedAt = null;
      updateValues.dismissedBy = null;
      updateValues.dismissNotes = null;
    }

    // The status guard makes the write a no-op if a concurrent transition
    // already moved the row (the FOR UPDATE above makes that unreachable in
    // practice; this keeps the update honest on its own).
    const [updated] = await tx
      .update(fleetFindings)
      .set(updateValues)
      .where(and(...conditions, eq(fleetFindings.status, existing.status as FleetFindingStatus)))
      .returning();

    if (!updated) {
      return { ok: false, status: 404, error: 'Finding not found' };
    }

    return {
      ok: true,
      finding: serializeFinding(projectFindingMetadata(
        { ...updated, orgName: existing.orgName } as RawFindingRow,
        new Set(visibleMembers.map((m) => m.deviceId)),
        callerIsScopeRestricted(auth)
      )),
    };
  });
}
