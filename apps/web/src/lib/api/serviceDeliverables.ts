// Typed fetch wrappers for the Service Deliverables API (feature #5573 W01),
// mounted under the org router at /orgs/:orgId/deliverables.
//
// Same idiom as contractDocuments.ts: no generic apiClient, every route
// responds with a `{ data: ... }` envelope, and callers wrap mutations in
// runAction. Unlike contractDocuments.ts the fetcher is a PARAMETER rather
// than an ambient `fetchWithAuth` import: the org record pins every request to
// the org in the URL (`makeOrgFetch`, orgRecordFetch.ts) while the contract
// page uses the ambient `fetchWithAuth`, and both must share one client. The
// org is also part of the path, so `orgIdOverride` is never needed here.

import type {
  AddEvidenceInput,
  CreateDeliverableInput,
  DeliverOccurrenceInput,
  RescheduleOccurrenceInput,
  UpdateDeliverableInput,
  WaiveOccurrenceInput,
} from '@breeze/shared';

import { extractApiError } from '../apiError';
import { ActionError } from '../runAction';

/** Any `fetchWithAuth`-shaped function — the ambient one or an org-pinned
 *  `OrgFetch`. `orgIdOverride` is optional so an `OrgFetch` (which omits it)
 *  is assignable. */
export type Fetcher = (
  path: string,
  init?: RequestInit & { orgIdOverride?: string },
) => Promise<Response>;

export type DeliverableCadence = 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'one_time';
export type DeliverableCompletionMode = 'explicit' | 'on_ticket_resolve';
export type DeliverableStatus = 'on_track' | 'due_soon' | 'late' | 'missed' | 'inactive';
export type OccurrenceStatus =
  | 'scheduled'
  | 'open'
  | 'awaiting_evidence'
  | 'delivered'
  | 'missed'
  | 'waived';

/** A `service_deliverables` row plus the derived summary fields the API joins
 *  in (`DeliverableSummary`). Dates are ISO `YYYY-MM-DD`; timestamps ISO 8601. */
export interface Deliverable {
  id: string;
  orgId: string;
  contractId: string | null;
  name: string;
  description: string | null;
  cadence: DeliverableCadence;
  anchorDueDate: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  leadDays: number;
  graceDays: number;
  artifactRequired: boolean;
  completionMode: DeliverableCompletionMode;
  autoEvidenceReportId: string | null;
  ownerUserId: string | null;
  ticketCategoryId: string | null;
  portalVisible: boolean;
  active: boolean;
  sortOrder: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  contractName: string | null;
  nextDue: string | null;
  lastDelivered: { at: string; late: boolean; note: string | null } | null;
  openCount: number;
  status: DeliverableStatus;
}

export interface OccurrenceEvidence {
  id: string;
  kind: 'document' | 'report_run';
  documentId: string | null;
  reportId: string | null;
  reportRunId: string | null;
  createdAt: string;
}

/** A `service_deliverable_occurrences` row with its evidence (`OccurrenceView`). */
export interface Occurrence {
  id: string;
  orgId: string;
  deliverableId: string;
  nameSnapshot: string;
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  originalDueAt: string;
  status: OccurrenceStatus;
  ticketId: string | null;
  deliveredAt: string | null;
  deliveredByUserId: string | null;
  deliveredVia: 'explicit' | 'ticket' | null;
  deliveryNote: string | null;
  waivedAt: string | null;
  waivedByUserId: string | null;
  waivedReason: string | null;
  createdAt: string;
  updatedAt: string;
  late: boolean;
  evidence: OccurrenceEvidence[];
}

export interface ListDeliverablesQuery {
  contractId?: string;
  includeInactive?: boolean;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function base(orgId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/deliverables`;
}

function occurrencePath(orgId: string, occurrenceId: string): string {
  return `${base(orgId)}/occurrences/${encodeURIComponent(occurrenceId)}`;
}

/** Unwrap the `{ data }` envelope, or throw an `ActionError` carrying the
 *  API's flat `{ error, code? }` message so `runAction` can toast it. */
export async function unwrapData<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const code =
      body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string'
        ? (body as { code: string }).code
        : undefined;
    throw new ActionError(extractApiError(body, `Request failed (${res.status})`), res.status, code, body);
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json()) as { data: T };
  return json.data;
}

function jsonInit(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export async function listDeliverables(
  f: Fetcher,
  orgId: string,
  q: ListDeliverablesQuery = {},
): Promise<Deliverable[]> {
  const params = new URLSearchParams();
  if (q.contractId) params.set('contractId', q.contractId);
  if (q.includeInactive) params.set('includeInactive', 'true');
  const qs = params.toString();
  return unwrapData<Deliverable[]>(await f(`${base(orgId)}${qs ? `?${qs}` : ''}`));
}

export async function createDeliverable(
  f: Fetcher,
  orgId: string,
  body: CreateDeliverableInput,
): Promise<Deliverable> {
  return unwrapData<Deliverable>(await f(base(orgId), jsonInit('POST', body)));
}

export async function updateDeliverable(
  f: Fetcher,
  orgId: string,
  id: string,
  body: UpdateDeliverableInput,
): Promise<Deliverable> {
  return unwrapData<Deliverable>(
    await f(`${base(orgId)}/${encodeURIComponent(id)}`, jsonInit('PATCH', body)),
  );
}

/** Soft-delete: the row stays for history, `active` flips to false. */
export async function deactivateDeliverable(f: Fetcher, orgId: string, id: string): Promise<void> {
  await unwrapData<unknown>(await f(`${base(orgId)}/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function listOccurrences(
  f: Fetcher,
  orgId: string,
  deliverableId: string,
  limit?: number,
): Promise<Occurrence[]> {
  const qs = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return unwrapData<Occurrence[]>(
    await f(`${base(orgId)}/${encodeURIComponent(deliverableId)}/occurrences${qs}`),
  );
}

export async function deliverOccurrence(
  f: Fetcher,
  orgId: string,
  occurrenceId: string,
  body: DeliverOccurrenceInput,
): Promise<Occurrence> {
  return unwrapData<Occurrence>(
    await f(`${occurrencePath(orgId, occurrenceId)}/deliver`, jsonInit('POST', body)),
  );
}

export async function waiveOccurrence(
  f: Fetcher,
  orgId: string,
  occurrenceId: string,
  body: WaiveOccurrenceInput,
): Promise<Occurrence> {
  return unwrapData<Occurrence>(
    await f(`${occurrencePath(orgId, occurrenceId)}/waive`, jsonInit('POST', body)),
  );
}

export async function reopenOccurrence(
  f: Fetcher,
  orgId: string,
  occurrenceId: string,
): Promise<Occurrence> {
  return unwrapData<Occurrence>(
    await f(`${occurrencePath(orgId, occurrenceId)}/reopen`, { method: 'POST' }),
  );
}

export async function rescheduleOccurrence(
  f: Fetcher,
  orgId: string,
  occurrenceId: string,
  body: RescheduleOccurrenceInput,
): Promise<Occurrence> {
  return unwrapData<Occurrence>(
    await f(`${occurrencePath(orgId, occurrenceId)}/reschedule`, jsonInit('POST', body)),
  );
}

export async function addEvidence(
  f: Fetcher,
  orgId: string,
  occurrenceId: string,
  body: AddEvidenceInput,
): Promise<Occurrence> {
  return unwrapData<Occurrence>(
    await f(`${occurrencePath(orgId, occurrenceId)}/evidence`, jsonInit('POST', body)),
  );
}

export async function removeEvidence(
  f: Fetcher,
  orgId: string,
  occurrenceId: string,
  evidenceId: string,
): Promise<Occurrence> {
  return unwrapData<Occurrence>(
    await f(`${occurrencePath(orgId, occurrenceId)}/evidence/${encodeURIComponent(evidenceId)}`, {
      method: 'DELETE',
    }),
  );
}
