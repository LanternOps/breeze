import { fetchWithAuth } from '@/stores/auth';
import { extractApiError } from '@/lib/apiError';
import { runAction } from '@/lib/runAction';

// Mirrors apps/api/src/db/schema/fleetFindings.ts — kept as a local literal
// union rather than imported from @breeze/shared so the web bundle doesn't
// depend on the API schema module.
export type FleetFindingKind =
  | 'metric_anomaly_pattern'
  | 'log_correlation'
  | 'reliability_offenders';
export type FleetFindingSeverity = 'info' | 'warning' | 'error' | 'critical';
export type FleetFindingStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved';
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

export interface FleetFindingMember {
  deviceId: string;
  hostname: string;
  displayName: string | null;
  siteId: string;
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
async function readJson<T>(path: string, fallback: string): Promise<T> {
  const res = await fetchWithAuth(path);
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
  return readJson<FleetFindingListResult>(
    `/fleet/findings${buildQuery(filters)}`,
    'Failed to load fleet findings'
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
