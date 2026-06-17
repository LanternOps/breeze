// Typed fetch wrappers for the Quotes / Proposals API.
//
// Mirrors the invoice / contracts / catalog web layer: there is no generic
// `apiFetch`/`apiClient` helper in this app — list/detail/mutation calls go
// through `fetchWithAuth` (apps/web/src/stores/auth.ts), which auto-injects the
// active orgId + auth header, refreshes tokens, prepends the `/api/v1` prefix,
// and returns a raw `Response`. Each wrapper here returns that `Response` so the
// CALLING COMPONENT keeps full control over 401 handling and wraps the request
// in `runAction` (apps/web/src/lib/runAction.ts) — exactly the pattern
// InvoiceEditor.tsx uses (`runAction({ request: () => fetchWithAuth(...) })`).
// The CLAUDE.md "mutations must go through runAction" rule is therefore
// satisfied at the component layer, not inside these thin wrappers; that is the
// established convention for invoices/contracts/catalog rather than the
// approximate `runAction(() => apiFetch(...))` shape sketched in the plan.
//
// Every quotes route responds with a `{ data: ... }` envelope. Money / quantity
// fields arrive from the API as numeric(12,2) strings (e.g. '150.00'), matching
// the invoice client's string-money convention.

import { fetchWithAuth } from '../../stores/auth';
import type {
  CreateQuoteInput,
  UpdateQuoteInput,
  QuoteLineInput,
  QuoteBlockInput,
} from '@breeze/shared';

/** Query params for `GET /quotes`. Mirrors `listQuotesQuerySchema` in shared. */
export interface ListQuotesParams {
  orgId?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

function buildQuery(params: ListQuotesParams): string {
  const qs = new URLSearchParams();
  if (params.orgId) qs.set('orgId', params.orgId);
  if (params.status) qs.set('status', params.status);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.cursor) qs.set('cursor', params.cursor);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ---- reads ----------------------------------------------------------------

export function listQuotes(params: ListQuotesParams = {}): Promise<Response> {
  return fetchWithAuth(`/quotes${buildQuery(params)}`);
}

export function getQuote(id: string): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}`);
}

// ---- mutations (callers wrap these in runAction) --------------------------

export function createQuote(body: CreateQuoteInput): Promise<Response> {
  return fetchWithAuth('/quotes', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function updateQuote(id: string, body: UpdateQuoteInput): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function deleteQuote(id: string): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}`, { method: 'DELETE' });
}

export function addBlock(id: string, body: QuoteBlockInput): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/blocks`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Delete a block and its lines (DELETE /quotes/:id/blocks/:blockId). */
export function deleteBlock(id: string, blockId: string): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/blocks/${blockId}`, { method: 'DELETE' });
}

export function addManualLine(id: string, body: QuoteLineInput): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/lines`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Body shape matches `catalogQuoteLineSchema` (catalogItemId + quantity, optional blockId). */
export function addCatalogLine(
  id: string,
  body: { catalogItemId: string; quantity: number; blockId?: string },
): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/lines/catalog`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function updateLine(id: string, lineId: string, body: unknown): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/lines/${lineId}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function removeLine(id: string, lineId: string): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/lines/${lineId}`, { method: 'DELETE' });
}

/** Absolute API path for the quote PDF (`GET /api/v1/quotes/:id/pdf`). The route
 *  streams `application/pdf` inline; callers fetch it via `fetchWithAuth` (to
 *  attach the auth header) the same way InvoiceDetail downloads its PDF. */
export function quotePdfUrl(id: string): string {
  return `/api/v1/quotes/${id}/pdf`;
}
