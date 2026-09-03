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
import type { StatusPillRole } from '../../components/billing/shared/statusPillRoles';
import type { ContractLineType } from '@breeze/shared';

export type { ContractLineType };

export type ContractStatus = 'draft' | 'active' | 'paused' | 'cancelled' | 'expired';
export type ContractBillingTiming = 'advance' | 'arrears';

/** #3205 W04 (#4607): what happens to the units above includedQuantity. */
export type OverageMode = 'bill' | 'flag';

/** One allowance line that is OVER this period, in either mode. `bill` is on the
 *  invoice; `flag` is not — the UI branches on `mode`. */
export interface OverageSummary {
  contractLineId: string;
  /** The materialized overage invoice line ('bill' mode) or null ('flag' mode). W07
   *  attaches device evidence to it. */
  invoiceLineId: string | null;
  description: string;
  counted: number;
  included: number;
  overage: number;
  mode: OverageMode;
}

/** Devices no device-counted line on the contract bills (#3205). null = not applicable. */
export interface UncoveredDevices {
  total: number;
  byRole: Record<string, number>;
}

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
  autoRenew: boolean;
  renewalTermMonths: number | null;
  renewalNoticeDays: number | null;
  currencyCode: string;
  notes: string | null;
  terms: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Resolved period value (live per_device/per_seat counts), added by GET /contracts. */
  estimatedPeriodValue?: string | null;
  estimateError?: 'GROUP_EVALUATION_FAILED';
}

/** One line's resolved estimate from GET /contracts/:id/estimate. */
export interface ContractEstimateLine {
  lineId: string;
  lineType: ContractLineType;
  /** BASE quantity billed by the contract line; overage is separate. */
  quantity: number;
  /** BASE value only. `overageValue` is never folded into this value. */
  value: string;
  live: boolean;
  counted: number;
  included: number | null;
  overage: number;
  overageMode: OverageMode | null;
  overageValue: string;
  unresolved?: 'group_deleted';
}
export interface ContractEstimate {
  currencyCode: string;
  periodTotal: string;
  lines: ContractEstimateLine[];
  uncoveredDevices: UncoveredDevices | null;
  overages: OverageSummary[];
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
  deviceRoles: string[] | null;
  /** #3205 W03: resolved server-side so the detail page needs no site lookup. */
  site: { id: string; name: string } | null;
  deviceGroupId: string | null;
  deviceGroupName: string | null;
  deviceGroup: { id: string; name: string; type: 'static' | 'dynamic' } | null;
  includedQuantity: string | null;
  overageMode: OverageMode | null;
  overageUnitPrice: string | null;
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
  snapshotDeviceTotal: number | null;
  uncoveredTotal: number | null;
  flaggedTotal: number | null;
  billedOverageTotal: number | null;
}

export interface PeriodOutcome {
  contractBillingPeriodId: string;
  invoiceId: string | null;
  snapshotDeviceTotal: number;
  uncoveredTotal: number;
  flaggedTotal: number;
  billedOverageTotal: number;
  uncoveredByRole: Record<string, number>;
  overages: OverageSummary[];
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

/**
 * One row of GET /contracts/currency-mismatches — the read-only wave-6 (#3778)
 * anomaly inventory of contracts whose stamped currency no longer matches their
 * organization's. `activeChangeEligible` is the server's verdict from the SAME
 * helper the restamp mutation gates on; it is advisory (the mutation re-checks
 * under the contract's row lock) and there is deliberately NO bulk action.
 */
export type ContractCurrencyIneligibleReason =
  | 'STATUS_NOT_ACTIVE'
  | 'ORPHANED_CONTRACT_SOURCE'
  | 'ORPHANED_BILLING_PERIOD'
  | 'BROKEN_CONTRACT_LINEAGE'
  | 'UNBILLED_MONETARY_ROWS';

export interface ContractCurrencyMismatch {
  contractId: string;
  contractName: string;
  orgId: string;
  orgName: string;
  status: ContractStatus;
  contractCurrencyCode: string;
  orgCurrencyCode: string;
  nextBillingAt: string | null;
  draftMonetaryInvoiceCount: number;
  blockingDraftInvoiceIds: string[];
  orphanedBillingPeriodCount: number;
  activeChangeEligible: boolean;
  ineligibleReason: ContractCurrencyIneligibleReason | null;
}

export interface ContractCurrencyMismatchReport {
  items: ContractCurrencyMismatch[];
  nextCursor: string | null;
}

export function listContractCurrencyMismatches(
  query: { orgId?: string; status?: ContractStatus | ''; limit?: number; cursor?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams();
  if (query.orgId) params.set('orgId', query.orgId);
  if (query.status) params.set('status', query.status);
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  return fetchWithAuth(`/contracts/currency-mismatches${qs ? `?${qs}` : ''}`);
}

export function getContract(id: string): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}`);
}

export async function fetchPeriodOutcome(
  contractId: string,
  periodId: string,
): Promise<{ recorded: boolean; outcome: PeriodOutcome | null }> {
  const res = await fetchWithAuth(`/contracts/${contractId}/periods/${periodId}/outcome`);
  if (!res.ok) throw new Error(`Contract period outcome request failed (${res.status})`);
  const body = (await res.json()) as { data: { recorded: boolean; outcome: PeriodOutcome | null } };
  return body.data;
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

/** Body of PATCH /contracts/:id/lines/:lineId (#3205 W03). Omitted keys are
 *  unchanged; `catalogItemId: null` unlinks (and then unitPrice + taxable are
 *  required in the same patch); the same id re-sent is a no-op — use
 *  `refreshCatalogPrice` to re-price an unchanged link. `lineType` is rejected. */
export interface UpdateContractLinePatch {
  description?: string;
  unitPrice?: string;
  taxable?: boolean;
  catalogItemId?: string | null;
  refreshCatalogPrice?: boolean;
  manualQuantity?: string;
  siteId?: string | null;
  deviceRoles?: string[];
  deviceGroupId?: string;
  sortOrder?: number;
  includedQuantity?: string | null;
  overageMode?: OverageMode | null;
  overageUnitPrice?: string | null;
}

export function updateContractLine(id: string, lineId: string, body: UpdateContractLinePatch): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}/lines/${lineId}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body),
  });
}

/** Body of `POST /contracts/:id/currency`. The stamped currency is only ever
 *  changed through this op (#3774); on an ACTIVE contract it is the wave-6
 *  owner-approved escape hatch (#3778) and the server additionally requires
 *  `contracts:manage`, `confirmActiveChange`, and eligibility re-checked under
 *  the contract's row lock. `clearLines` and `reprice` are mutually exclusive. */
export interface ChangeContractCurrencyBody {
  currencyCode: string;
  clearLines?: boolean;
  reprice?: boolean;
  confirmActiveChange?: boolean;
}

/** The `details` payload carried by a 409 from the change-currency op — the
 *  exact rows that block the restamp, keyed by the error `code`. */
export interface ContractCurrencyBlockerDetails {
  draftInvoiceIds?: string[];
  billingPeriodIds?: string[];
  lineIds?: string[];
  invoiceIds?: string[];
}

export function changeContractCurrency(id: string, body: ChangeContractCurrencyBody): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}/currency`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export type ContractTransition = 'activate' | 'pause' | 'resume' | 'cancel';

export function contractTransition(id: string, verb: ContractTransition): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}/${verb}`, { method: 'POST' });
}

/** One catalog line `POST /contracts/:id/generate` billed at the contract's
 *  stamped snapshot because the item has no price in the contract's currency
 *  (multi-currency wave 3, #3775). Always present on the response (`[]` when none). */
export interface PriceBookGap {
  contractLineId: string;
  catalogItemId: string;
  itemName: string;
  currencyCode: string;
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

// Contracts share the invoice/quote semantic pill vocabulary (STATUS_PILL roles)
// instead of raw emerald/amber palette hues, so a contract's "Active" green
// matches an invoice's "Paid" green. Rendered via the shared <StatusPill role>.
// active→success, draft→neutral, paused/expired→warning (lapsing),
// cancelled→neutral with the historical line-through preserved as className.
export const CONTRACT_STATUS_ROLES: Record<ContractStatus, { role: StatusPillRole; label: string; className?: string }> = {
  draft: { role: 'neutral', label: CONTRACT_STATUS_LABELS.draft },
  active: { role: 'success', label: CONTRACT_STATUS_LABELS.active },
  paused: { role: 'warning', label: CONTRACT_STATUS_LABELS.paused },
  cancelled: { role: 'neutral', label: CONTRACT_STATUS_LABELS.cancelled, className: 'line-through' },
  expired: { role: 'warning', label: CONTRACT_STATUS_LABELS.expired },
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
