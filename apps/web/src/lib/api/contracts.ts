// Typed fetch wrappers for the Recurring Contracts API.
//
// Mirrors the invoice web layer: there is no generic `apiFetch`/`apiClient`
// helper in this app — list/detail/mutation calls go through `fetchWithAuth`
// (apps/web/src/stores/auth.ts), which auto-injects the active orgId, refreshes
// tokens, and returns a raw `Response`. Each wrapper here returns that
// `Response` so callers keep full control over 401 handling and `runAction`
// (the same pattern InvoicesPage.tsx uses). Every contracts route responds with
// a `{ data: ... }` envelope.
//
// Money / quantity fields arrive from the API as numeric(12,2) strings
// (e.g. '150.00'), matching the invoice client's string-money convention.

import { fetchWithAuth } from '../../stores/auth';

export type ContractStatus = 'draft' | 'active' | 'paused' | 'cancelled' | 'expired';
export type ContractBillingTiming = 'advance' | 'arrears';
export type ContractLineType = 'flat' | 'per_device' | 'per_seat' | 'manual';

/** A row from `GET /contracts` (the full `contracts` table row). */
export interface ContractSummary {
  id: string;
  partnerId: string;
  orgId: string;
  name: string;
  status: ContractStatus;
  billingTiming: ContractBillingTiming;
  intervalMonths: number;
  startDate: string;
  endDate: string | null;
  nextBillingAt: string | null;
  autoIssue: boolean;
  currencyCode: string;
  notes: string | null;
  terms: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Resolved period value (live per_device/per_seat counts), added by GET /contracts. */
  estimatedPeriodValue?: string;
}

/** One line's resolved estimate from GET /contracts/:id/estimate. */
export interface ContractEstimateLine {
  lineId: string;
  lineType: ContractLineType;
  quantity: number;
  value: string;
  live: boolean;
}
export interface ContractEstimate {
  currencyCode: string;
  periodTotal: string;
  lines: ContractEstimateLine[];
}

export interface ContractLine {
  id: string;
  contractId: string;
  orgId: string;
  lineType: ContractLineType;
  description: string;
  catalogItemId: string | null;
  unitPrice: string;
  manualQuantity: string | null;
  siteId: string | null;
  taxable: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface ContractBillingPeriod {
  id: string;
  contractId: string;
  orgId: string;
  periodStart: string;
  periodEnd: string;
  invoiceId: string | null;
  generatedAt: string;
}

/** Shape of `GET /contracts/:id` — `{ data: { contract, lines, periods } }`. */
export interface ContractDetail {
  contract: ContractSummary;
  lines: ContractLine[];
  periods: ContractBillingPeriod[];
}

export interface ListContractsQuery {
  orgId?: string;
  status?: ContractStatus | '';
  limit?: number;
}

function buildQuery(q: ListContractsQuery): string {
  const params = new URLSearchParams();
  if (q.orgId) params.set('orgId', q.orgId);
  if (q.status) params.set('status', q.status);
  if (q.limit != null) params.set('limit', String(q.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function listContracts(query: ListContractsQuery = {}): Promise<Response> {
  return fetchWithAuth(`/contracts${buildQuery(query)}`);
}

export function getContract(id: string): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}`);
}

export function getContractEstimate(id: string): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}/estimate`);
}

export function createContract(body: unknown): Promise<Response> {
  return fetchWithAuth('/contracts', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function updateContract(id: string, body: unknown): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function deleteContract(id: string): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}`, { method: 'DELETE' });
}

export function addContractLine(id: string, body: unknown): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}/lines`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function removeContractLine(id: string, lineId: string): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}/lines/${lineId}`, { method: 'DELETE' });
}

export type ContractTransition = 'activate' | 'pause' | 'resume' | 'cancel';

export function contractTransition(id: string, verb: ContractTransition): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}/${verb}`, { method: 'POST' });
}

export function generateContractInvoice(id: string): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}/generate`, { method: 'POST' });
}

// ---- presentation helpers -------------------------------------------------

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

// Tailwind badge classes per status (mirrors the invoice STATUS_COLORS style).
export const CONTRACT_STATUS_COLORS: Record<ContractStatus, string> = {
  draft: 'border-border bg-muted text-muted-foreground',
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  paused: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  cancelled: 'border-border bg-muted text-muted-foreground line-through',
  expired: 'border-border bg-muted text-muted-foreground',
};

/** Human cadence from intervalMonths: 1→Monthly, 3→Quarterly, 12→Annual, else "Every N months". */
export function formatCadence(intervalMonths: number): string {
  switch (intervalMonths) {
    case 1:
      return 'Monthly';
    case 3:
      return 'Quarterly';
    case 12:
      return 'Annual';
    default:
      return `Every ${intervalMonths} months`;
  }
}

/** Normalize a per-period value to an estimated monthly figure (annual ÷ 12,
 *  quarterly ÷ 3) for an "Est. monthly recurring" rollup. */
export function monthlyValue(periodValue: string | number | null | undefined, intervalMonths: number): number {
  const v = Number(periodValue);
  if (!Number.isFinite(v) || intervalMonths <= 0) return 0;
  return v / intervalMonths;
}
