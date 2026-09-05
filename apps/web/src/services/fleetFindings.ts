import { fetchWithAuth } from '@/stores/auth';
import { extractApiError } from '@/lib/apiError';
import { ActionError, runAction } from '@/lib/runAction';

// Mirrors apps/api/src/db/schema/fleetFindings.ts — kept as a local literal
// union rather than imported from @breeze/shared so the web bundle doesn't
// depend on the API schema module.
export type FleetFindingKind =
  | 'metric_anomaly_pattern'
  | 'log_correlation'
  | 'reliability_offenders';
export type FleetFindingSeverity = 'info' | 'warning' | 'error' | 'critical';
export type FleetFindingStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved';
// `cancelled` is RESERVED for a future "cancel this run" affordance — no API
// path writes it today. Kept so adding cancellation is a behaviour change, not
// a type + i18n + chip migration.
export type FleetRunStatus =
  | 'queued'
  | 'running'
  | 'partial'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type FleetFindingLifecycleAction = 'acknowledge' | 'dismiss' | 'reopen';

export const FLEET_FINDING_KINDS: readonly FleetFindingKind[] = [
  'metric_anomaly_pattern',
  'log_correlation',
  'reliability_offenders',
];
export const FLEET_FINDING_SEVERITIES: readonly FleetFindingSeverity[] = [
  'critical',
  'error',
  'warning',
  'info',
];

export interface FleetFinding {
  id: string;
  orgId: string;
  orgName: string | null;
  kind: FleetFindingKind;
  semanticKey: string;
  status: FleetFindingStatus;
  severity: FleetFindingSeverity;
  title: string;
  summary: string | null;
  evidence: Record<string, unknown>;
  deviceCount: number;
  revision: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  dismissedAt: string | null;
  dismissedBy: string | null;
  dismissNotes: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
}

// Mirrors `devices.osType` (API's `db/schema/devices.ts` `osTypeEnum`) via
// `FleetFindingMember.osType` in apps/api/src/services/fleetFindings/query.ts.
// Kept as a local literal union for the same reason as the other API-mirrored
// unions above — no cross-bundle schema import.
export type DeviceOsType = 'windows' | 'macos' | 'linux';

export interface FleetFindingMember {
  deviceId: string;
  hostname: string;
  displayName: string | null;
  siteId: string;
  /** Lets the fix picker warn/exclude devices incompatible with a chosen
   *  script's `os_types` before dispatch, instead of the run failing per
   *  device at execution time. */
  osType: DeviceOsType;
  sourceKind: string;
  memberEvidence: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface FleetFindingRun {
  id: string;
  actionKind: 'script' | 'command';
  scriptId: string | null;
  commandType: string | null;
  status: FleetRunStatus;
  targetCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface FleetFindingDetail extends FleetFinding {
  members: FleetFindingMember[];
  runs: FleetFindingRun[];
}

// ─── Remediation ────────────────────────────────────────────────────────

/** Mirrors `REMEDIATION_COMMAND_TYPE_ALLOWLIST` in
 *  apps/api/src/services/fleetFindings/dispatch.ts. There is deliberately no
 *  `clear_temp_files` — it was cut in Task 7 for want of a single-command
 *  primitive; that cleanup is a script, not a command preset. */
export type RemediationCommandType = 'restart_service' | 'reboot';

/** Mirrors `RemediationSkipReason` (dispatch.ts). */
export type RemediationSkipReason = 'site_denied' | 'not_member' | 'decommissioned';

export type FleetTargetStatus = 'pending' | 'queued' | 'succeeded' | 'failed' | 'skipped';

interface RemediateRequestBase {
  parameters: Record<string, unknown>;
  /** Omitted = every current member. `[]` is rejected by the API with a 400 —
   *  never send one; callers must gate confirm on a non-empty selection. */
  deviceIds?: string[];
}

/** Discriminated on `actionKind`, mirroring `RemediateRequest` in
 *  apps/api/src/services/fleetFindings/dispatch.ts. The API's zod schema is a
 *  `discriminatedUnion` of `.strict()` branches, so a body carrying BOTH
 *  `scriptId` and `commandType` is a 400 — this type makes that unbuildable
 *  rather than a runtime surprise. */
export type RemediateRequest =
  | (RemediateRequestBase & {
      actionKind: 'script';
      scriptId: string;
      /** Operator's launch-time override (#4888). Omitted = the script's own
       *  saved default. `'elevated'` is save-time only and not a valid choice
       *  here — the API 400s on it (see fleetFindings.ts's `.strict()` schema). */
      runAs?: 'system' | 'user';
    })
  | (RemediateRequestBase & { actionKind: 'command'; commandType: RemediationCommandType });

export interface RemediationSkippedTarget {
  deviceId: string;
  reason: RemediationSkipReason;
}

export interface RemediateResponse {
  runId: string;
  targetCount: number;
  skipped: RemediationSkippedTarget[];
}

export interface FleetRemediationRunTarget {
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
  targets: FleetRemediationRunTarget[];
}

/** Positive list, identical to `isTerminalRunStatus` in the API's dispatch
 *  service. A negative list ("anything that isn't queued or running") silently
 *  classifies any status added later as terminal — which for the polling panel
 *  means it stops refreshing a run that is still in flight. */
export function isTerminalRunStatus(status: FleetRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'partial' || status === 'cancelled';
}

/** Reads the runId the API attaches to its 502 body ("the run was created but
 *  dispatch could not be enqueued — it is marked failed"). Without this the UI
 *  would treat a 502 as "nothing happened", when in fact a real, failed run
 *  exists and the user needs to see it. */
export function runIdFromFailure(err: unknown): string | null {
  if (!(err instanceof ActionError)) return null;
  const body = err.body;
  if (!body || typeof body !== 'object') return null;
  const runId = (body as Record<string, unknown>).runId;
  return typeof runId === 'string' && runId.length > 0 ? runId : null;
}

export interface FleetFindingListResult {
  findings: FleetFinding[];
  total: number;
}

export interface FleetFindingFilters {
  orgId?: string;
  kind?: FleetFindingKind;
  severity?: FleetFindingSeverity;
  /** Sent as the `status` CSV. Omitted -> the API default (open,acknowledged). */
  statuses?: FleetFindingStatus[];
  limit?: number;
  offset?: number;
}

function buildQuery(filters: FleetFindingFilters): string {
  const params = new URLSearchParams();
  if (filters.orgId) params.set('orgId', filters.orgId);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.statuses && filters.statuses.length > 0) {
    params.set('status', filters.statuses.join(','));
  }
  if (filters.limit != null) params.set('limit', String(filters.limit));
  if (filters.offset != null) params.set('offset', String(filters.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Reads throw on failure so callers render an explicit error state — never an
 *  empty list that reads as "the fleet is clean". */
async function readJson<T>(
  path: string,
  fallback: string,
  init?: Parameters<typeof fetchWithAuth>[1]
): Promise<T> {
  // runaction-exempt: read-only helper — callers pass no method (always GET);
  // `init` only ever carries skipOrgIdInjection for the all-orgs feed query.
  const res = await fetchWithAuth(path, init);
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw new Error(extractApiError(body, fallback));
  }
  return (await res.json()) as T;
}

export async function listFindings(
  filters: FleetFindingFilters = {}
): Promise<FleetFindingListResult> {
  // No org filter means "all accessible orgs" — the API already implements
  // that when orgId is absent, but fetchWithAuth would re-inject the active
  // org and silently narrow the feed to it (the org dropdown could then never
  // offer any other org, since its options are built from the rows returned).
  return readJson<FleetFindingListResult>(
    `/fleet/findings${buildQuery(filters)}`,
    'Failed to load fleet findings',
    filters.orgId ? undefined : { skipOrgIdInjection: true }
  );
}

export async function getFinding(id: string): Promise<FleetFindingDetail> {
  return readJson<FleetFindingDetail>(
    `/fleet/findings/${encodeURIComponent(id)}`,
    'Failed to load finding'
  );
}

const LIFECYCLE_SUCCESS: Record<FleetFindingLifecycleAction, string> = {
  acknowledge: 'Finding acknowledged',
  dismiss: 'Finding dismissed',
  reopen: 'Finding reopened',
};

const LIFECYCLE_FAILURE: Record<FleetFindingLifecycleAction, string> = {
  acknowledge: 'Failed to acknowledge finding',
  dismiss: 'Failed to dismiss finding',
  reopen: 'Failed to reopen finding',
};

/**
 * `POST /fleet/findings/:id/remediate`.
 *
 * There is no "global MFA challenge flow" that owns the 401/403 handshake — an
 * earlier version of this comment claimed there was, and the missing
 * `onUnauthorized` below was justified by it. runAction deliberately does not
 * toast on 401 (it expects the caller's `onUnauthorized` to navigate), so
 * without one an expired session made the confirm button silently re-enable
 * with no toast and no redirect. It redirects like its `patchFinding` sibling.
 *
 * The route is `requireMfa()`-gated, so `MFA_REQUIRED` is an expected 403 and
 * gets a message that says what to do rather than the API's bare "MFA required".
 *
 * Answers 202 on success (not 200) — `isApiFailure` keys off `status >= 400`,
 * so runAction treats it correctly without special-casing.
 */
export async function remediateFinding(
  id: string,
  req: RemediateRequest
): Promise<RemediateResponse> {
  return runAction<RemediateResponse>({
    request: () =>
      fetchWithAuth(`/fleet/findings/${encodeURIComponent(id)}/remediate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      }),
    errorFallback: 'Failed to start remediation',
    friendly: (code) =>
      code === 'MFA_REQUIRED'
        ? 'Remediation requires multi-factor authentication. Enable MFA in your profile security settings, then try again.'
        : undefined,
    onUnauthorized: () => {
      window.location.href = '/login';
    },
  });
}

/** `GET /fleet/findings/runs/:runId`. Throws on failure so the progress panel
 *  renders an explicit error rather than a stale/empty run. */
export async function getRun(runId: string): Promise<FleetRemediationRunDetail> {
  return readJson<FleetRemediationRunDetail>(
    `/fleet/findings/runs/${encodeURIComponent(runId)}`,
    'Failed to load remediation run'
  );
}

export async function patchFinding(
  id: string,
  action: FleetFindingLifecycleAction,
  notes?: string
): Promise<FleetFinding> {
  return runAction<FleetFinding>({
    request: () =>
      fetchWithAuth(`/fleet/findings/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notes ? { action, notes } : { action }),
      }),
    errorFallback: LIFECYCLE_FAILURE[action],
    successMessage: LIFECYCLE_SUCCESS[action],
    onUnauthorized: () => {
      window.location.href = '/login';
    },
  });
}
