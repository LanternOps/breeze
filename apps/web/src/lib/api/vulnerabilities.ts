import {
  VULN_SKIP_REASON_LABELS,
  type BulkActionResult,
  type CveCatalogRecord,
  type DeviceVulnFinding,
  type DeviceVulnSoftwareResponse,
  type DeviceVulnStats,
  type FleetVulnStats,
  type GroupFinding,
  type RemediateResult,
  type SkippedItem,
  type SoftwareGroup,
  type SoftwareGroupDetail,
  type VulnSeverity,
  type VulnSkipReason,
  type VulnStatus,
  type VulnTicketPriority,
  type VulnTicketResult,
} from '@breeze/shared';

import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../runAction';
import { showToast } from '../../components/shared/Toast';

// Re-export the shared fleet-triage domain types so existing web call sites that
// import them from this module keep working (single source of truth is
// @breeze/shared; this module is just the web-side barrel for them).
export type {
  BulkActionResult,
  CveCatalogRecord,
  DeviceVulnFinding,
  DeviceVulnSoftwareResponse,
  DeviceVulnStats,
  FleetVulnStats,
  GroupCve,
  GroupFinding,
  RemediateResult,
  SoftwareGroup,
  SoftwareGroupDetail,
  VulnTicketResult,
} from '@breeze/shared';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** A per-(device, CVE) finding row as returned by GET /api/v1/vulnerabilities/devices/:id. */
export interface DeviceVulnerabilityItem {
  id: string; // device_vulnerabilities id
  deviceId: string;
  vulnerabilityId: string;
  cveId: string;
  cvssScore: number | null;
  cvssVector: string | null;
  severity: VulnSeverity | null;
  knownExploited: boolean;
  epssScore: number | null;
  riskScore: number | null;
  status: VulnStatus;
  detectedAt: string;
  patchAvailable: boolean;
}

/** A CVE aggregated across the fleet (one row per CVE, with affected-device count). Server-side aggregated. */
export interface FleetVulnerability {
  id: string; // vulnerabilityId (stable aggregate key)
  cveId: string;
  cvssScore: number | null;
  severity: VulnSeverity | null;
  knownExploited: boolean;
  epssScore: number | null;
  riskScore: number | null;
  deviceCount: number;
  patchAvailable: boolean;
  statuses: VulnStatus[];
}

export interface VulnerabilityFilters {
  status?: string;
  severity?: string;
  cve?: string;
  kevOnly?: boolean;
  patchAvailable?: boolean;
  /** Only findings whose accepted-risk window expires within N days. */
  expiringWithinDays?: number;
}

/** Fleet dashboard: CVEs across all accessible devices, aggregated + risk-sorted by the server. */
export async function fetchVulnerabilities(
  filters: VulnerabilityFilters = {},
): Promise<{ items: FleetVulnerability[]; hasMore: boolean }> {
  const res = await fetchWithAuth(
    `/vulnerabilities${buildVulnQuery({
      status: filters.status,
      severity: filters.severity,
      cve: filters.cve,
      kevOnly: filters.kevOnly,
      patchAvailable: filters.patchAvailable,
      expiringWithinDays: filters.expiringWithinDays,
    })}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to load vulnerabilities (${res.status})`);
  }
  const body = (await res.json()) as { items?: FleetVulnerability[]; hasMore?: boolean };
  return { items: body.items ?? [], hasMore: body.hasMore ?? false };
}

/** Per-device findings (one row per CVE on the device) for the device tab. */
export async function fetchDeviceVulnerabilities(
  deviceId: string,
  filters: VulnerabilityFilters = {},
): Promise<{ items: DeviceVulnerabilityItem[] }> {
  const res = await fetchWithAuth(
    `/vulnerabilities/devices/${deviceId}${buildVulnQuery({
      status: filters.status,
      severity: filters.severity,
      cve: filters.cve,
      kevOnly: filters.kevOnly,
      patchAvailable: filters.patchAvailable,
    })}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to load device vulnerabilities (${res.status})`);
  }
  const body = (await res.json()) as { items?: DeviceVulnerabilityItem[] };
  return { items: body.items ?? [] };
}

/** Device tab: software-grouped findings + posture stats for one device. */
export async function fetchDeviceSoftwareGroups(
  deviceId: string,
  filters: { status?: string } = {},
): Promise<DeviceVulnSoftwareResponse> {
  const res = await fetchWithAuth(
    `/vulnerabilities/devices/${deviceId}/software${buildVulnQuery({ status: filters.status })}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to load device vulnerabilities (${res.status})`);
  }
  const body = (await res.json()) as Partial<DeviceVulnSoftwareResponse>;
  return {
    groups: body.groups ?? [],
    findings: body.findings ?? [],
    stats: body.stats ?? {
      openTotal: 0, critical: 0, high: 0, medium: 0, low: 0, unscored: 0,
      kevFindingCount: 0, patchReadyFindingCount: 0,
    },
  };
}

// ---- Fleet triage: software groups, stats, CVE detail ----

export interface VulnFleetFilters {
  search: string;
  severity: string; // '' = all
  status: string; // 'open' default
  kevOnly: boolean;
  patchAvailable: boolean;
  /** Only findings whose accepted-risk window expires within N days (set by the
   *  "Accepted, expiring soon" stat card; no visible filter-bar control). */
  expiringWithinDays?: number;
}

/** GET /vulnerabilities/:cveId/devices — the catalog record plus its findings. Web-only wire wrapper. */
export interface CveDevicesPayload {
  cve: CveCatalogRecord;
  findings: GroupFinding[];
}

// ---- Pure helpers (exported for tests) ----

export function buildVulnQuery(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue;
    q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Summarize a `skipped[]` list as distinct reasons with counts, mapping each
 * `VulnSkipReason` CODE to its human label (`VULN_SKIP_REASON_LABELS`). Unknown
 * codes fall back to the 'unknown' label so a new server code never renders raw.
 * e.g. "10 not found, 8 site access denied".
 */
export function summarizeSkipReasons(skipped: SkippedItem[]): string {
  const counts = new Map<string, number>();
  for (const { reason } of skipped) {
    const label = VULN_SKIP_REASON_LABELS[reason as VulnSkipReason] ?? VULN_SKIP_REASON_LABELS.unknown;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(', ');
}

export function bulkSummary(verb: string, succeeded: number, skipped: SkippedItem[]): string {
  const base = `${succeeded} ${verb}`;
  if (skipped.length === 0) return base;
  return `${base}, ${skipped.length} skipped — ${summarizeSkipReasons(skipped)}`;
}

// ---- Reads: fleet triage ----

export async function fetchSoftwareGroups(
  filters: VulnFleetFilters,
): Promise<{ items: SoftwareGroup[]; hasMore: boolean }> {
  const res = await fetchWithAuth(
    `/vulnerabilities/software${buildVulnQuery({
      status: filters.status,
      severity: filters.severity,
      search: filters.search,
      kevOnly: filters.kevOnly,
      patchAvailable: filters.patchAvailable,
      expiringWithinDays: filters.expiringWithinDays,
    })}`,
  );
  if (!res.ok) throw new Error('Failed to load software groups');
  return res.json() as Promise<{ items: SoftwareGroup[]; hasMore: boolean }>;
}

export async function fetchSoftwareGroupDetail(groupKey: string): Promise<SoftwareGroupDetail> {
  const res = await fetchWithAuth(`/vulnerabilities/software/${encodeURIComponent(groupKey)}`);
  if (!res.ok) throw new Error('Failed to load software group');
  return res.json() as Promise<SoftwareGroupDetail>;
}

export async function fetchVulnStats(): Promise<FleetVulnStats> {
  const res = await fetchWithAuth('/vulnerabilities/stats');
  if (!res.ok) throw new Error('Failed to load vulnerability stats');
  return res.json() as Promise<FleetVulnStats>;
}

export async function fetchCveDevices(cveId: string): Promise<CveDevicesPayload> {
  const res = await fetchWithAuth(`/vulnerabilities/${encodeURIComponent(cveId)}/devices`);
  if (!res.ok) throw new Error('Failed to load CVE details');
  return res.json() as Promise<CveDevicesPayload>;
}

// ---- Bulk chunking (#3694) ----

/**
 * Mirrors the server's `deviceVulnerabilityIds` cap (`routes/vulnerabilities.ts`,
 * `.max(200)` on remediate / bulk accept-risk / bulk mitigate / tickets).
 *
 * The cap is a request-size bound, not a product limit: `remediateVulnerabilities`
 * loops per finding doing ~5 queries plus a command enqueue inside ONE synchronous
 * request. Raising it server-side would just move the timeout. So the client
 * batches instead — a 576-finding selection becomes three sequential requests
 * rather than one guaranteed `Too big: expected array to have <=200 items`.
 */
const BULK_ID_LIMIT = 200;

function chunkIds(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += BULK_ID_LIMIT) out.push(ids.slice(i, i + BULK_ID_LIMIT));
  return out;
}

interface ChunkedSpec<T> {
  /** Sends ONE batch. `toast` is false for multi-batch runs so runAction stays
   *  silent and this helper emits a single aggregate toast instead. */
  send: (batch: string[], toast: boolean) => Promise<T>;
  empty: T;
  merge: (acc: T, next: T) => T;
  /** Aggregate success copy, used only on the multi-batch path. */
  summary: (merged: T) => string;
  /** Partial-progress copy when a later batch fails mid-run. Must describe the
   *  merged total as a CONFIRMED LOWER BOUND, never as an exact applied count —
   *  see runChunked. */
  partial: (merged: T, done: number, total: number) => string;
}

/**
 * Runs an id-capped bulk action, batching only when it has to.
 *
 * At or under the cap this is a single request and the behaviour is unchanged —
 * runAction owns the toast exactly as before. Above the cap the batches run
 * SEQUENTIALLY (parallel would multiply the per-finding server work the cap
 * exists to bound) and a single merged toast replaces N per-batch ones.
 *
 * If a later batch fails, the batches that already landed are real work the
 * operator must know about: runAction has toasted the server's reason, and this
 * adds the scope — which is distinct information, not a duplicate.
 *
 * Two things that message must NOT overclaim:
 *
 * 1. The merged total is a CONFIRMED LOWER BOUND, not the applied total. The
 *    failing batch can still have done work before it failed —
 *    `remediateVulnerabilities` queues each command before the awaited event
 *    publication, so a throw there leaves commands queued that no response ever
 *    reported. A lost HTTP response is ambiguous the same way.
 * 2. Retrying the same selection is NOT safe for remediation. Every call creates
 *    a fresh `install_patches` command via `queueCommandForExecution` with no
 *    finding/action idempotency key, so re-sending ids that already succeeded
 *    queues a SECOND install on those devices. Accept/mitigate are state-writes
 *    and tolerate a retry; remediation does not. The copy therefore tells the
 *    operator to reload first rather than inviting a blind retry.
 */
async function runChunked<T>(ids: string[], spec: ChunkedSpec<T>): Promise<T> {
  const batches = chunkIds(ids);
  if (batches.length <= 1) return spec.send(ids, true);

  let merged = spec.empty;
  for (let i = 0; i < batches.length; i++) {
    try {
      merged = spec.merge(merged, await spec.send(batches[i]!, false));
    } catch (err) {
      const done = batches.slice(0, i).reduce((n, b) => n + b.length, 0);
      showToast({ message: spec.partial(merged, done, ids.length), type: 'error' });
      throw err;
    }
  }
  showToast({ message: spec.summary(merged), type: 'success' });
  return merged;
}

// ---- Mutations (all wrapped in runAction so every outcome surfaces a toast) ----

const remediateSummary = (d: RemediateResult): string =>
  bulkSummary(`remediation${d.scheduled === 1 ? '' : 's'} scheduled`, d.scheduled, d.skipped);

export async function remediateVuln(deviceVulnerabilityIds: string[]): Promise<RemediateResult> {
  return runChunked<RemediateResult>(deviceVulnerabilityIds, {
    send: (batch, toast) =>
      runAction<RemediateResult>({
        request: () =>
          fetchWithAuth('/vulnerabilities/remediate', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ deviceVulnerabilityIds: batch }),
          }),
        errorFallback: 'Failed to schedule remediation',
        ...(toast ? { successMessage: remediateSummary } : {}),
        parseSuccess: (data) => {
          const d = data as { scheduled?: number; skipped?: SkippedItem[] };
          return { scheduled: d.scheduled ?? 0, skipped: d.skipped ?? [] };
        },
      }),
    empty: { scheduled: 0, skipped: [] },
    merge: (a, b) => ({ scheduled: a.scheduled + b.scheduled, skipped: [...a.skipped, ...b.skipped] }),
    summary: remediateSummary,
    partial: (d, done, total) =>
      `Stopped after ${done} of ${total} findings. At least ${d.scheduled} scheduled — some in the failed batch may also have `
      + `been scheduled. Reload before retrying: re-sending findings that already succeeded queues duplicate installs.`,
  });
}

export async function acceptVulnRisk(
  id: string,
  body: { reason: string; acceptedUntil: string },
): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth(`/vulnerabilities/${id}/accept-risk`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      }),
    errorFallback: 'Failed to accept risk',
    successMessage: 'Risk accepted',
  });
}

export async function mitigateVuln(id: string, body: { note: string }): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth(`/vulnerabilities/${id}/mitigate`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      }),
    errorFallback: 'Failed to mitigate vulnerability',
    successMessage: 'Marked as mitigated',
  });
}

export async function reopenVuln(id: string): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth(`/vulnerabilities/${id}/reopen`, {
        method: 'POST',
      }),
    errorFallback: 'Failed to reopen finding',
    successMessage: 'Finding reopened',
  });
}

// ---- Mutations: bulk fleet actions ----

/** `success` is AND-ed: one failed batch must not be masked by later successes. */
function mergeBulk(a: BulkActionResult, b: BulkActionResult): BulkActionResult {
  return { success: a.success && b.success, succeeded: a.succeeded + b.succeeded, skipped: [...a.skipped, ...b.skipped] };
}

function parseBulk(data: unknown): BulkActionResult {
  const d = data as Partial<BulkActionResult>;
  return { success: d.success ?? false, succeeded: d.succeeded ?? 0, skipped: d.skipped ?? [] };
}

/** Trailing skip clause for a ticket toast, e.g. ", 18 skipped — 18 access denied". */
function ticketSkipSuffix(skipped: SkippedItem[]): string {
  return skipped.length === 0 ? '' : `, ${skipped.length} skipped — ${summarizeSkipReasons(skipped)}`;
}

export async function bulkAcceptVulnRisk(
  deviceVulnerabilityIds: string[],
  payload: { reason: string; acceptedUntil: string },
): Promise<BulkActionResult> {
  return runChunked<BulkActionResult>(deviceVulnerabilityIds, {
    send: (batch, toast) =>
      runAction<BulkActionResult>({
        request: () =>
          fetchWithAuth('/vulnerabilities/bulk/accept-risk', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ deviceVulnerabilityIds: batch, ...payload }),
          }),
        errorFallback: 'Failed to accept risk',
        ...(toast ? { successMessage: (d: BulkActionResult) => bulkSummary('accepted', d.succeeded, d.skipped) } : {}),
        parseSuccess: parseBulk,
      }),
    empty: { success: true, succeeded: 0, skipped: [] },
    merge: mergeBulk,
    summary: (d) => bulkSummary('accepted', d.succeeded, d.skipped),
    partial: (d, done, total) =>
      `Stopped after ${done} of ${total} findings. At least ${d.succeeded} accepted; the rest were not attempted. `
      + `Reload to see the current state before retrying.`,
  });
}

export async function bulkMitigateVulns(
  deviceVulnerabilityIds: string[],
  payload: { note: string },
): Promise<BulkActionResult> {
  return runChunked<BulkActionResult>(deviceVulnerabilityIds, {
    send: (batch, toast) =>
      runAction<BulkActionResult>({
        request: () =>
          fetchWithAuth('/vulnerabilities/bulk/mitigate', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ deviceVulnerabilityIds: batch, ...payload }),
          }),
        errorFallback: 'Failed to mitigate',
        ...(toast ? { successMessage: (d: BulkActionResult) => bulkSummary('mitigated', d.succeeded, d.skipped) } : {}),
        parseSuccess: parseBulk,
      }),
    empty: { success: true, succeeded: 0, skipped: [] },
    merge: mergeBulk,
    summary: (d) => bulkSummary('mitigated', d.succeeded, d.skipped),
    partial: (d, done, total) =>
      `Stopped after ${done} of ${total} findings. At least ${d.succeeded} mitigated; the rest were not attempted. `
      + `Reload to see the current state before retrying.`,
  });
}

export async function createVulnTicket(
  deviceVulnerabilityIds: string[],
  payload: { title: string; priority: VulnTicketPriority; note?: string },
): Promise<VulnTicketResult> {
  // DELIBERATELY NOT CHUNKED (#3694). The server groups the findings by org and
  // creates ONE ticket per org. Splitting a 576-finding selection into three
  // requests would create THREE tickets per org, which is a different outcome
  // from what the operator asked for, not a transparent fix — so batching here
  // would trade a loud error for silently wrong data. Fail fast with copy that
  // says what to do instead of the raw `Too big: expected array to have <=200
  // items`. Raising the server cap for this one route, or having it accept a
  // batch token and append to an existing ticket, is a maintainer call.
  if (deviceVulnerabilityIds.length > BULK_ID_LIMIT) {
    const msg = `Select at most ${BULK_ID_LIMIT} findings per ticket (${deviceVulnerabilityIds.length} selected). `
      + `A ticket is created per organization, so splitting the request would create duplicates.`;
    showToast({ message: msg, type: 'error' });
    throw new ActionError(msg, 0);
  }

  return runAction<VulnTicketResult>({
    request: () =>
      fetchWithAuth('/vulnerabilities/tickets', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ deviceVulnerabilityIds, ...payload }),
      }),
    errorFallback: 'Failed to create ticket',
    // The server builds each org's device/CVE description itself, one ticket per
    // org. Surface both the created count AND any per-org skips (SF#1) so a
    // partial success (e.g. access denied on some orgs) is never silent. When
    // ALL orgs are skipped the server returns success:false and runAction
    // surfaces its message instead — this only runs on success.
    successMessage: (d) => {
      const base = d.tickets.length === 1 ? 'Ticket created' : `${d.tickets.length} tickets created (one per organization)`;
      return `${base}${ticketSkipSuffix(d.skipped)}`;
    },
    parseSuccess: (data) => {
      const d = data as Partial<VulnTicketResult>;
      return { success: d.success ?? false, tickets: d.tickets ?? [], skipped: d.skipped ?? [] };
    },
  });
}
