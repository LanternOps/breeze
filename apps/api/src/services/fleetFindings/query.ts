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
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';

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

  let scoped = rows;

  if (auth.allowedSiteIds !== undefined) {
    const allowedSiteIds = auth.allowedSiteIds;
    const candidateIds = rows.map((r) => r.id);

    if (allowedSiteIds.length === 0 || candidateIds.length === 0) {
      return { findings: [], total: 0 };
    }

    const memberRows = await db
      .select({ findingId: fleetFindingDevices.findingId, deviceId: fleetFindingDevices.deviceId })
      .from(fleetFindingDevices)
      .innerJoin(devices, eq(fleetFindingDevices.deviceId, devices.id))
      .where(and(inArray(fleetFindingDevices.findingId, candidateIds), inArray(devices.siteId, allowedSiteIds)));

    const deviceIdsByFinding = new Map<string, Set<string>>();
    for (const m of memberRows) {
      const set = deviceIdsByFinding.get(m.findingId) ?? new Set<string>();
      set.add(m.deviceId);
      deviceIdsByFinding.set(m.findingId, set);
    }

    scoped = rows
      .filter((r) => (deviceIdsByFinding.get(r.id)?.size ?? 0) > 0)
      .map((r) => ({ ...r, deviceCount: deviceIdsByFinding.get(r.id)!.size }));
  }

  const total = scoped.length;
  const page = scoped.slice(filters.offset, filters.offset + filters.limit);

  return { findings: page.map(serializeFinding), total };
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
    .where(eq(fleetFindingDevices.findingId, id))
    .orderBy(desc(fleetFindingDevices.lastSeenAt));

  const allowedSiteIds = auth.allowedSiteIds;
  const filteredMembers = allowedSiteIds === undefined
    ? memberRows
    : memberRows.filter((m) => allowedSiteIds.includes(m.siteId));

  if (allowedSiteIds !== undefined && filteredMembers.length === 0) {
    // Zero-member-in-scope — omit, mirroring the list endpoint.
    return null;
  }

  const runRows = await db
    .select({
      id: fleetRemediationRuns.id,
      actionKind: fleetRemediationRuns.actionKind,
      scriptId: fleetRemediationRuns.scriptId,
      runAs: fleetRemediationRuns.runAs,
      commandType: fleetRemediationRuns.commandType,
      status: fleetRemediationRuns.status,
      targetCount: fleetRemediationRuns.targetCount,
      succeededCount: fleetRemediationRuns.succeededCount,
      failedCount: fleetRemediationRuns.failedCount,
      skippedCount: fleetRemediationRuns.skippedCount,
      createdBy: fleetRemediationRuns.createdBy,
      createdAt: fleetRemediationRuns.createdAt,
      startedAt: fleetRemediationRuns.startedAt,
      completedAt: fleetRemediationRuns.completedAt,
    })
    .from(fleetRemediationRuns)
    .where(eq(fleetRemediationRuns.findingId, id))
    .orderBy(desc(fleetRemediationRuns.createdAt))
    .limit(10);

  return {
    ...serializeFinding({ ...row, deviceCount: filteredMembers.length }),
    members: filteredMembers.map((m) => ({
      deviceId: m.deviceId,
      hostname: m.hostname,
      displayName: m.displayName ?? null,
      siteId: m.siteId,
      osType: m.osType as DeviceOsType,
      sourceKind: m.sourceKind,
      sourceRowId: m.sourceRowId ?? null,
      memberEvidence: (m.memberEvidence ?? {}) as Record<string, unknown>,
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
 * condition on the run's own `orgId` column, then an app-layer site filter on
 * its target rows (a caller's site grant can shrink after a run was created,
 * so this is re-applied on every read rather than trusted from creation
 * time).
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

  const targetRows = await db
    .select()
    .from(fleetRemediationRunTargets)
    .where(eq(fleetRemediationRunTargets.runId, runId));

  const allowedSiteIds = auth.allowedSiteIds;
  const visibleTargets =
    allowedSiteIds === undefined
      ? targetRows
      : targetRows.filter((t) => t.siteIdSnapshot && allowedSiteIds.includes(t.siteIdSnapshot));

  if (allowedSiteIds !== undefined && visibleTargets.length === 0) return null;

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
    targetCount: run.targetCount,
    succeededCount: run.succeededCount,
    failedCount: run.failedCount,
    skippedCount: run.skippedCount,
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
 * (not-found, invalid transition).
 */
export async function applyFleetFindingLifecycle(
  auth: AuthContext,
  id: string,
  action: FleetFindingLifecycleAction,
  notes: string | undefined,
  actorUserId: string
): Promise<FleetFindingLifecycleResult> {
  const conditions: SQL[] = [eq(fleetFindings.id, id)];
  const orgCondition = auth.orgCondition(fleetFindings.orgId);
  if (orgCondition) conditions.push(orgCondition);

  const [existing] = (await db
    .select({ ...FINDING_COLUMNS, orgName: organizations.name })
    .from(fleetFindings)
    .leftJoin(organizations, eq(fleetFindings.orgId, organizations.id))
    .where(and(...conditions))
    .limit(1)) as RawFindingRow[];

  if (!existing) {
    return { ok: false, status: 404, error: 'Finding not found' };
  }

  // Site-axis scoping. The org condition above is not sufficient: a
  // site-restricted tech shares an org with findings whose members all sit in
  // sites they cannot see. `getFleetFinding` and `listFleetFindings` both omit
  // those, so the write path must fail closed identically — otherwise a
  // finding that is invisible on read is still acknowledgeable, and the 200
  // response body leaks its evidence.
  const allowedSiteIds = auth.allowedSiteIds;
  if (allowedSiteIds !== undefined) {
    const [inScopeMember] = allowedSiteIds.length === 0
      ? []
      : await db
          .select({ deviceId: fleetFindingDevices.deviceId })
          .from(fleetFindingDevices)
          .innerJoin(devices, eq(fleetFindingDevices.deviceId, devices.id))
          .where(
            and(
              eq(fleetFindingDevices.findingId, id),
              inArray(devices.siteId, allowedSiteIds)
            )
          )
          .limit(1);

    if (!inScopeMember) {
      return { ok: false, status: 404, error: 'Finding not found' };
    }
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

  const [updated] = await db
    .update(fleetFindings)
    .set(updateValues)
    .where(eq(fleetFindings.id, id))
    .returning();

  if (!updated) {
    return { ok: false, status: 404, error: 'Finding not found' };
  }

  return {
    ok: true,
    finding: serializeFinding({ ...updated, orgName: existing.orgName } as RawFindingRow),
  };
}
