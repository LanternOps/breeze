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

/** Clone a quote into a new draft. Optional body retargets it to another
 *  organization (same partner) and/or renames it — omitted fields fall back to
 *  the source quote (matches `cloneQuoteSchema` in shared). */
export function cloneQuote(id: string, body?: { orgId?: string; title?: string }): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/clone`, {
    method: 'POST',
    ...(body ? { headers: JSON_HEADERS, body: JSON.stringify(body) } : {}),
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

/** Update a block's content in place (PATCH /quotes/:id/blocks/:blockId). The
 *  body restates the (immutable) blockType so content is validated by shape. */
export function updateBlock(id: string, blockId: string, body: QuoteBlockInput): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/blocks/${blockId}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Delete a block and its lines (DELETE /quotes/:id/blocks/:blockId). */
export function deleteBlock(id: string, blockId: string): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/blocks/${blockId}`, { method: 'DELETE' });
}

export function addManualLine(
  id: string,
  body: QuoteLineInput & { unitCost?: number | null; sku?: string | null; partNumber?: string | null },
): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/lines`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Body shape matches `catalogQuoteLineSchema` (catalogItemId + quantity, optional blockId + partNumber). */
export function addCatalogLine(
  id: string,
  body: { catalogItemId: string; quantity: number; blockId?: string; partNumber?: string },
): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/lines/catalog`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function updateLine(
  id: string,
  lineId: string,
  body: { unitCost?: number | null; sku?: string | null; partNumber?: string | null } & Record<string, unknown>,
): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/lines/${lineId}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function removeLine(id: string, lineId: string): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/lines/${lineId}`, { method: 'DELETE' });
}

/** Reorder a quote's blocks. Body is the full ordered id list; the server
 *  renumbers sortOrder 0..n-1 (PATCH /quotes/:id/blocks/reorder). */
export function reorderBlocks(id: string, body: { blockIds: string[] }): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/blocks/reorder`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Reorder the lines within a pricing-table block. Full ordered id list; the
 *  server renumbers sortOrder 0..n-1 (PATCH /quotes/:id/blocks/:blockId/lines/reorder). */
export function reorderLines(id: string, blockId: string, body: { lineIds: string[] }): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/blocks/${blockId}/lines/reorder`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Move a line to a different pricing-table block
 *  (PATCH /quotes/:id/lines/:lineId/move). The server appends it to the end of
 *  the target block's sort order; bundle children follow their parent. */
export function moveLine(id: string, lineId: string, body: { blockId: string }): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/lines/${lineId}/move`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Absolute API path for the quote PDF (`GET /api/v1/quotes/:id/pdf`). The route
 *  streams `application/pdf` inline; callers fetch it via `fetchWithAuth` (to
 *  attach the auth header) the same way InvoiceDetail downloads its PDF. */
export function quotePdfUrl(id: string): string {
  return `/api/v1/quotes/${id}/pdf`;
}

// ---- Phase 2 lifecycle / image upload -------------------------------------

/** Composer fields for `POST /quotes/:id/send`. Everything is optional — the
 *  server's `.strict()` schema treats an absent field as "use the default". */
export interface SendQuoteOptions {
  /** Explicit recipients (1-10) — override the org billing-contact fallback. */
  to?: string[];
  /** Extra recipients (0-10). */
  cc?: string[];
  /** Overrides the server default "Proposal <number> from <partner>". */
  subject?: string;
  /** Personal note shown in the customer email above the accept link. */
  message?: string;
  /** false skips the PDF attachment; the server defaults to attaching it. */
  includePdf?: boolean;
}

/** Why the best-effort email step did NOT deliver after a send committed
 *  (`data.emailed === false`). Kept in sync with the API's send route:
 *  - `no_billing_contact` — the org has no billing-contact email to fall back to
 *  - `no_email_service`   — email isn't configured on this server
 *  - `pdf_render_failed`  — the PDF attachment couldn't be generated
 *  - `send_failed`        — the transport itself rejected/failed the message */
export type QuoteSendEmailReason =
  | 'no_billing_contact'
  | 'no_email_service'
  | 'pdf_render_failed'
  | 'send_failed';

/** Issue + send a draft quote (POST /quotes/:id/send). Gated server-side on
 *  quotes:send. Only non-empty / non-default fields are POSTed, so a bare
 *  `sendQuote(id)` reproduces the classic body-less send. Responds with
 *  `{ data: { quote, emailed, emailReason?, acceptUrl } }` (emailReason is a
 *  `QuoteSendEmailReason` when emailed is false). */
export function sendQuote(id: string, opts: SendQuoteOptions = {}): Promise<Response> {
  const body: Record<string, unknown> = {};
  if (opts.to && opts.to.length > 0) body.to = opts.to;
  if (opts.cc && opts.cc.length > 0) body.cc = opts.cc;
  const subject = opts.subject?.trim();
  if (subject) body.subject = subject;
  const note = opts.message?.trim();
  if (note) body.message = note;
  if (opts.includePdf === false) body.includePdf = false;
  return fetchWithAuth(`/quotes/${id}/send`, {
    method: 'POST',
    ...(Object.keys(body).length > 0 ? { headers: JSON_HEADERS, body: JSON.stringify(body) } : {}),
  });
}

/** Upload an image for a quote (POST /quotes/:id/images). The body is multipart
 *  FormData — `fetchWithAuth` deliberately does NOT set a JSON Content-Type for
 *  FormData so the browser appends the multipart boundary itself. Responds with
 *  `{ data: { imageId, mime, byteSize } }`. Gated server-side on quotes:write. */
export function uploadQuoteImage(id: string, file: File): Promise<Response> {
  const form = new FormData();
  form.append('file', file);
  return fetchWithAuth(`/quotes/${id}/images`, { method: 'POST', body: form });
}

/** Copy an image into a quote from a URL (POST /quotes/:id/images with a JSON
 *  body). The server fetches + stores the bytes — not a hotlink. Responds with
 *  the same `{ data: { imageId, mime, byteSize } }` as the multipart upload.
 *  Gated server-side on quotes:write. */
export function addQuoteImageFromUrl(id: string, url: string): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/images`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ url }),
  });
}

/** Absolute API path for a quote image (`GET /api/v1/quotes/:id/images/:imageId`).
 *  The route serves the raw bytes; used as an `<img src>` for the editor preview. */
export function quoteImageUrl(id: string, imageId: string): string {
  return `/api/v1/quotes/${id}/images/${imageId}`;
}
