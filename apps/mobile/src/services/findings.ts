import { ApiError, coreRequest } from './api';

/**
 * Mobile client for the fleet-findings surface (#5365), mirroring
 * `apps/web/src/services/fleetFindings.ts` so both clients speak the same
 * contract. These routes live outside the `/mobile` surface, so they go
 * through the core `/api/v1` prefix via `coreRequest` — the same reason
 * `getFleetFindingCounts` in `api.ts` uses `requestWithPrefix` rather than the
 * `/mobile`-prefixed helper.
 *
 * Remediation (`POST /fleet/findings/:id/remediate`) is deliberately not
 * wired here: it needs an MFA'd session and a script picker, which is its own
 * piece of work.
 */

export type FleetFindingKind =
  | 'metric_anomaly_pattern'
  | 'log_correlation'
  | 'reliability_offenders';
export type FleetFindingSeverity = 'info' | 'warning' | 'error' | 'critical';
export type FleetFindingStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved';
export type FleetFindingLifecycleAction = 'acknowledge' | 'dismiss' | 'reopen';

export interface FleetFinding {
  id: string;
  orgId: string;
  orgName: string | null;
  kind: FleetFindingKind;
  status: FleetFindingStatus;
  severity: FleetFindingSeverity;
  title: string;
  summary: string | null;
  deviceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  dismissedAt: string | null;
  dismissNotes: string | null;
  resolvedAt: string | null;
}

export interface FleetFindingMember {
  deviceId: string;
  hostname: string;
  displayName: string | null;
  siteId: string;
  osType: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface FleetFindingDetail extends FleetFinding {
  members: FleetFindingMember[];
}

export interface FleetFindingListResult {
  findings: FleetFinding[];
  total: number;
}

export interface FleetFindingFilters {
  orgId?: string;
  kind?: FleetFindingKind;
  severity?: FleetFindingSeverity;
  /**
   * Omit to use the mobile default (`open,acknowledged`). Pass an empty array
   * to send no `status` at all and take the server's own default.
   */
  statuses?: FleetFindingStatus[];
  limit?: number;
  offset?: number;
}

/** What a tech can still act on — the same pair the API defaults to. */
const DEFAULT_STATUSES: FleetFindingStatus[] = ['open', 'acknowledged'];

/** The server caps `limit` at 100; one screenful of findings is plenty. */
const DEFAULT_LIMIT = 50;

function buildQuery(filters: FleetFindingFilters): string {
  const params = new URLSearchParams();
  if (filters.orgId) params.set('orgId', filters.orgId);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.severity) params.set('severity', filters.severity);
  const statuses = filters.statuses ?? DEFAULT_STATUSES;
  // An empty CSV would be a 400 ("Invalid status filter"), so send nothing
  // and let the server apply its own default instead.
  if (statuses.length > 0) params.set('status', statuses.join(','));
  params.set('limit', String(filters.limit ?? DEFAULT_LIMIT));
  if (filters.offset !== undefined) params.set('offset', String(filters.offset));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export async function listFindings(
  filters: FleetFindingFilters = {},
): Promise<FleetFindingListResult> {
  const response = await coreRequest<Partial<FleetFindingListResult>>(
    `/fleet/findings${buildQuery(filters)}`,
  );
  const findings = response.findings ?? [];
  return { findings, total: response.total ?? findings.length };
}

export async function getFinding(id: string): Promise<FleetFindingDetail> {
  const response = await coreRequest<FleetFindingDetail>(
    `/fleet/findings/${encodeURIComponent(id)}`,
  );
  // `members` drives the device list; a missing array would crash the screen
  // on `.map`, so normalise it here rather than at every read site.
  return { ...response, members: response.members ?? [] };
}

export async function patchFinding(
  id: string,
  action: FleetFindingLifecycleAction,
  notes?: string,
): Promise<FleetFinding> {
  const trimmed = notes?.trim();
  return coreRequest<FleetFinding>(`/fleet/findings/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(trimmed ? { action, notes: trimmed } : { action }),
  });
}

/**
 * The API answers 404 for a finding that was resolved, deleted, or belongs to
 * an org/site the caller cannot see — it deliberately does not distinguish
 * those. Screens turn this into an empty state, not an error.
 */
export function isFindingNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.statusCode === 404;
}
