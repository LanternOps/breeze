/**
 * Portal API Client
 * Handles all API requests for the customer portal
 */

import { navigateTo } from './navigation';
// Invoice-domain enum SSOT lives in @breeze/shared (billing-enums.ts). Imported
// into local scope for the InvoiceSummary/InvoiceDetail types below and re-exported
// (type-only, erased at build) so '@/lib/api' consumers are unaffected.
import type { InvoiceStatus, TicketFormField } from '@breeze/shared';

// Client API base. Empty (the default) → same-origin **relative** requests
// (`/api/v1/...`), which the reverse proxy routes to the API under `/api/*`. This
// is the production + full-stack-dev path and needs no per-origin configuration.
// Set PUBLIC_API_URL to an absolute origin only for a standalone portal dev server
// without a proxy, or a genuinely cross-origin API.
const PUBLIC_API_BASE = import.meta.env.PUBLIC_API_URL || '';
const CSRF_HEADER_NAME = 'x-breeze-csrf';
const CSRF_COOKIE_NAME = 'breeze_portal_csrf_token';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const target = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      const value = trimmed.slice(target.length);
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }

  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function resolveApiBase(): string {
  // Server-side (SSR): there is no window to derive same-origin from. The portal
  // container reaches the API over the internal network (e.g. http://api:3001)
  // via INTERNAL_API_URL. Fall back to PUBLIC_API_URL, then the dev default.
  if (typeof window === 'undefined') {
    const fromEnv =
      (typeof process !== 'undefined' &&
        process.env &&
        (process.env.INTERNAL_API_URL || process.env.PUBLIC_API_URL)) ||
      '';
    return (fromEnv || PUBLIC_API_BASE || 'http://localhost:3001').replace(/\/+$/, '');
  }

  // Client: empty base → same-origin relative requests (return ''). buildPortalApiUrl
  // then produces `/api/v1/...`, which the reverse proxy routes to the API. This
  // avoids the localhost:PORT trap (a loopback rewrite can't fix a port mismatch).
  if (!PUBLIC_API_BASE) {
    return '';
  }

  // Explicit absolute base: normalize, rewriting a loopback host to the current
  // origin for dev convenience.
  try {
    const parsed = new URL(PUBLIC_API_BASE, window.location.origin);
    const windowHostname = window.location.hostname;

    if (isLoopbackHostname(windowHostname) && parsed.hostname !== windowHostname) {
      parsed.hostname = windowHostname;
      return parsed.origin;
    }

    if (isLoopbackHostname(parsed.hostname) && parsed.hostname !== window.location.hostname) {
      parsed.hostname = window.location.hostname;
    }

    return parsed.origin;
  } catch {
    return PUBLIC_API_BASE;
  }
}

function buildQueryString(query?: Record<string, string | number | undefined>): string {
  if (!query) {
    return '';
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }

  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export function buildPortalApiUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const cleanPath = normalizedPath === '/api'
    ? ''
    : normalizedPath.startsWith('/api/')
      ? normalizedPath.slice(4)
      : normalizedPath;

  const apiBase = resolveApiBase();
  return `${apiBase}/api/v1${cleanPath}`;
}

export function buildServerForwardHeaders(request: Request): Headers {
  const headers = new Headers();
  const cookie = request.headers.get('cookie');
  const host = request.headers.get('host');
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto');

  if (cookie) headers.set('cookie', cookie);
  if (host) headers.set('host', host);
  if (forwardedHost) headers.set('x-forwarded-host', forwardedHost);
  if (forwardedProto) headers.set('x-forwarded-proto', forwardedProto);

  return headers;
}

export interface ApiRequestConfig {
  headers?: HeadersInit;
  redirectOnUnauthorized?: boolean;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  /** Machine-readable error code from the API body (e.g. PORTAL_TICKETS_DISABLED). */
  code?: string;
  statusCode?: number;
  headers?: Headers;
}

function clearAuth(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('portal-auth');
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {},
  config: ApiRequestConfig = {}
): Promise<ApiResponse<T>> {
  const url = buildPortalApiUrl(endpoint);
  const method = (options.method ?? 'GET').toUpperCase();

  const headers = new Headers(config.headers);
  const optionHeaders = new Headers(options.headers);
  optionHeaders.forEach((value, key) => headers.set(key, value));

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const csrfToken = readCookie(CSRF_COOKIE_NAME);
    if (csrfToken) {
      headers.set(CSRF_HEADER_NAME, csrfToken);
    }
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include'
    });

    if (response.status === 401) {
      clearAuth();
      if (config.redirectOnUnauthorized !== false && typeof window !== 'undefined') {
        void navigateTo('/login', { replace: true });
      }
      return {
        error: 'Session expired',
        statusCode: response.status,
        headers: response.headers
      };
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        error: body?.error || 'Request failed',
        code: typeof body?.code === 'string' ? body.code : undefined,
        statusCode: response.status,
        headers: response.headers
      };
    }

    return {
      data: body as T,
      statusCode: response.status,
      headers: response.headers
    };
  } catch {
    return { error: 'Network error' };
  }
}

export async function apiGet<T>(
  endpoint: string,
  config: ApiRequestConfig = {}
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, { method: 'GET' }, config);
}

export async function apiPost<T>(
  endpoint: string,
  body?: unknown,
  config: ApiRequestConfig = {}
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined
  }, config);
}

export async function apiPut<T>(
  endpoint: string,
  body?: unknown,
  config: ApiRequestConfig = {}
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, {
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined
  }, config);
}

export async function apiPatch<T>(
  endpoint: string,
  body?: unknown,
  config: ApiRequestConfig = {}
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, {
    method: 'PATCH',
    body: body ? JSON.stringify(body) : undefined
  }, config);
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
}

export interface PaginatedResult<T> extends ApiResponse<T[]> {
  pagination?: Pagination;
}

export interface Device {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string | null;
  osVersion: string | null;
  status: 'online' | 'offline' | 'warning';
  lastSeenAt: string | null;
}

export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TicketSummary {
  id: string;
  ticketNumber: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
}

export interface TicketComment {
  id: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export interface TicketDetails extends TicketSummary {
  description: string;
  comments: TicketComment[];
}

// Slim portal-visible intake form (Phase 2). Mirrors the `GET /portal/tickets/forms`
// payload — no titleTemplate (the server composes the subject) and no showInPortal
// (the route already filtered to portal-visible forms).
export interface PortalTicketForm {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  fields: TicketFormField[];
  defaultPriority: TicketPriority | null;
}

// createTicket accepts EITHER the legacy free-text payload OR an intake-form
// payload. On the form path the subject/description are composed server-side, so
// no `subject` key is sent (an optional free-text `description` may still ride along).
export type CreateTicketInput =
  | { subject: string; description: string; priority: TicketPriority }
  | {
      formId: string;
      formResponses: Record<string, unknown>;
      description?: string;
      priority: TicketPriority;
    };

export interface Asset {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string | null;
  status: 'online' | 'offline' | 'warning';
  lastSeenAt: string | null;
}

// Re-export the shared InvoiceStatus (imported at the top of this file) so portal
// components keep importing it from '@/lib/api' unchanged.
export type { InvoiceStatus };

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string | null;
  status: InvoiceStatus;
  currencyCode: string;
  issueDate: string | null;
  dueDate: string | null;
  total: string;
  amountPaid: string;
  balance: string;
  // Snapshotted deposit due at quote acceptance; null when the invoice has no
  // deposit. Present on both the list select and the detail payload.
  depositDue: string | null;
}

// Intentional duplicate of SellerSnapshot in apps/api/src/services/sellerSnapshot.ts
// and apps/web/src/components/billing/invoiceTypes.ts — api/web/portal can't share a *runtime*
// package; keep in sync. (Type-only `@breeze/shared` imports are fine — erased at build, as above.)
export interface SellerSnapshot {
  name: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  phone: string | null;
  email: string | null;
  website: string | null;
}

export interface InvoiceLine {
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  taxable: boolean;
}

export interface InvoiceDetail {
  invoice: InvoiceSummary & {
    subtotal: string;
    taxTotal: string;
    taxRate: string | null;
    billToName: string | null;
    notes: string | null;
    sellerSnapshot?: SellerSnapshot | null;
    termsAndConditions?: string | null;
  };
  lines: InvoiceLine[];
}

export type QuoteStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'converted';

export interface QuoteSummary {
  id: string;
  quoteNumber: string | null;
  status: string;
  currencyCode: string;
  issueDate: string | null;
  expiryDate: string | null;
  total: string;
}

/** Server-serialized shape of a `contract` quote block's `content`, once the
 *  API has resolved the pinned template version and substituted its variables
 *  (apps/api's contractTemplateRender.ts — renderContractBlocksForClient /
 *  ContractClientBlockContent). Every portal/public quote route builds `content`
 *  from that exact function; only the authenticated admin quote editor (a
 *  different app, apps/web) additionally attaches the raw `authoring` fields
 *  (templateId/templateVersionId/variableValues) via a SEPARATE admin-only
 *  code path (attachContractAuthoring) that the portal never calls. `authoring`
 *  is typed `never` here so a portal component that tried to read it would be
 *  a compile error, not just something the runtime field-by-field narrowing
 *  below happens to skip. */
export interface QuoteContractBlockContent {
  label?: string;
  templateName: string;
  versionNumber: number;
  sourceType: 'authored' | 'uploaded';
  renderedHtml: string | null;
  fileUrl: string | null;
  authoring?: never;
}

export interface QuoteBlock {
  id: string;
  blockType: string;
  content: Record<string, unknown> | null;
  sortOrder: number;
}

export interface QuoteLine {
  id: string;
  blockId?: string | null;
  /** Product/display title; falls back to `description` for legacy lines with no
   *  distinct name (mirrors the web renderer's lineTitle/lineBlurb split). */
  name?: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  taxable?: boolean;
  recurrence: string;
  customerVisible: boolean;
  sortOrder: number;
  /** Server-built relative path to this line's product thumbnail (uploaded image
   *  or its catalog item's), or null when the line has no image. Resolve via
   *  buildPortalApiUrl before use. */
  imageUrl?: string | null;
}

export interface QuoteHeader extends QuoteSummary {
  introNotes?: string | null;
  terms?: string | null;
  subtotal?: string;
  taxRate?: string | null;
  taxTotal?: string;
  oneTimeTotal?: string;
  monthlyRecurringTotal?: string;
  annualRecurringTotal?: string;
  /** Amount invoiced on accept (one-time + one-time tax); derived server-side. */
  dueOnAcceptanceTotal?: string;
  /** Deposit config (persisted); type 'none' or a null amount means no deposit. */
  depositType?: string | null;
  depositAmount?: string | null;
  /** Deposit due at acceptance, or null when no valid deposit is configured. */
  depositDueTotal?: string | null;
  /** Per-category subtotals over customer-visible lines; empty categories omitted. */
  categoryBreakdown?: { category: string; oneTimeTotal: string; monthlyTotal: string; annualTotal: string }[];
  billToName?: string | null;
  sellerSnapshot?: SellerSnapshot | null;
  termsAndConditions?: string | null;
}

export interface QuoteBranding {
  partnerName: string;
  logoUrl: string | null;
  primaryColor: string | null;
}

export interface QuoteDetail {
  quote: QuoteHeader;
  blocks: QuoteBlock[];
  lines: QuoteLine[];
  /** Optional for API responses that predate the branding field. */
  branding?: QuoteBranding;
}

export interface PublicQuoteDetail {
  quote: QuoteHeader;
  blocks: QuoteBlock[];
  lines: QuoteLine[];
  branding: QuoteBranding;
}

export interface Profile {
  id: string;
  orgId: string;
  orgName: string | null;
  organizationId: string;
  organizationName: string;
  email: string;
  name: string | null;
  receiveNotifications: boolean;
  status: string;
}

export interface BrandingConfig {
  id?: string;
  orgId?: string;
  name?: string;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  accentColor?: string | null;
  customDomain?: string | null;
  welcomeMessage?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  footerText?: string | null;
  customCss?: string | null;
  enableTickets?: boolean;
  enableAssetCheckout?: boolean;
  enableSelfService?: boolean;
  enablePasswordReset?: boolean;
}

export interface ListParams {
  page?: number;
  limit?: number;
}

function mapPaginatedData<T>(
  response: ApiResponse<{ data: T[]; pagination?: Pagination }>
): PaginatedResult<T> {
  if (!response.data) {
    return {
      error: response.error,
      code: response.code,
      statusCode: response.statusCode,
      headers: response.headers
    };
  }

  return {
    data: response.data.data,
    pagination: response.data.pagination,
    statusCode: response.statusCode,
    headers: response.headers
  };
}

export const portalApi = {
  getDevices: async (
    params: ListParams = {},
    config: ApiRequestConfig = {}
  ): Promise<PaginatedResult<Device>> => {
    const query = buildQueryString({ page: params.page ?? 1, limit: params.limit ?? 50 });
    const response = await apiGet<{ data: Device[]; pagination: Pagination }>(
      `/portal/devices${query}`,
      config
    );
    return mapPaginatedData(response);
  },

  getTickets: async (
    params: ListParams = {},
    config: ApiRequestConfig = {}
  ): Promise<PaginatedResult<TicketSummary>> => {
    const query = buildQueryString({ page: params.page ?? 1, limit: params.limit ?? 50 });
    const response = await apiGet<{ data: TicketSummary[]; pagination: Pagination }>(
      `/portal/tickets${query}`,
      config
    );
    return mapPaginatedData(response);
  },

  getTicket: async (
    id: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<TicketDetails>> => {
    const response = await apiGet<{ ticket: TicketDetails }>(`/portal/tickets/${id}`, config);
    if (!response.data) {
      return {
        error: response.error,
        code: response.code,
        statusCode: response.statusCode,
        headers: response.headers
      };
    }

    return {
      data: response.data.ticket,
      statusCode: response.statusCode,
      headers: response.headers
    };
  },

  // Portal-visible intake forms for the session org (allowlist + showInPortal
  // resolved server-side). Returns [] on any failure so callers can silently
  // degrade to the legacy free-text form.
  getTicketForms: async (
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<PortalTicketForm[]>> => {
    const response = await apiGet<{ data: PortalTicketForm[] }>('/portal/tickets/forms', config);
    if (!response.data) {
      return {
        error: response.error,
        code: response.code,
        statusCode: response.statusCode,
        headers: response.headers
      };
    }

    return {
      data: response.data.data,
      statusCode: response.statusCode,
      headers: response.headers
    };
  },

  createTicket: async (
    data: CreateTicketInput,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<TicketSummary & { description: string }>> => {
    const response = await apiPost<{ ticket: TicketSummary & { description: string } }>(
      '/portal/tickets',
      data,
      config
    );
    if (!response.data) {
      return {
        error: response.error,
        statusCode: response.statusCode,
        headers: response.headers
      };
    }

    return {
      data: response.data.ticket,
      statusCode: response.statusCode,
      headers: response.headers
    };
  },

  getAssets: async (
    params: ListParams = {},
    config: ApiRequestConfig = {}
  ): Promise<PaginatedResult<Asset>> => {
    const query = buildQueryString({ page: params.page ?? 1, limit: params.limit ?? 50 });
    const response = await apiGet<{ data: Asset[]; pagination: Pagination }>(
      `/portal/assets${query}`,
      config
    );
    return mapPaginatedData(response);
  },

  getInvoices: async (
    params: ListParams = {},
    config: ApiRequestConfig = {}
  ): Promise<PaginatedResult<InvoiceSummary>> => {
    const query = buildQueryString({ page: params.page ?? 1, limit: params.limit ?? 50 });
    const response = await apiGet<{ data: InvoiceSummary[]; pagination: Pagination }>(
      `/portal/invoices${query}`,
      config
    );
    return mapPaginatedData(response);
  },

  getInvoice: async (
    id: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<InvoiceDetail>> => {
    return apiGet<InvoiceDetail>(`/portal/invoices/${id}`, config);
  },

  payInvoice: async (
    id: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<{ url: string }>> => {
    return apiPost<{ url: string }>(`/portal/invoices/${id}/pay`, undefined, config);
  },

  // Verify-on-return: settle the Checkout session server-side after the customer
  // lands back on the invoice (success_url carries the session id). Idempotent — the
  // reconcile sweep is the eventual backstop if this is skipped/fails.
  settleInvoice: async (
    id: string,
    sessionId: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<{ settled: boolean; invoiceId?: string }>> => {
    return apiPost<{ settled: boolean; invoiceId?: string }>(
      `/portal/invoices/${id}/settle`,
      { sessionId },
      config
    );
  },

  getProfile: async (config: ApiRequestConfig = {}): Promise<ApiResponse<Profile>> => {
    const response = await apiGet<{ user: Profile }>('/portal/profile', config);
    if (!response.data) {
      return {
        error: response.error,
        statusCode: response.statusCode,
        headers: response.headers
      };
    }

    return {
      data: response.data.user,
      statusCode: response.statusCode,
      headers: response.headers
    };
  },

  updateProfile: async (
    data: { name?: string; receiveNotifications?: boolean; password?: string; email?: string },
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<Profile>> => {
    const response = await apiPatch<{ user: Profile }>('/portal/profile', data, config);
    if (!response.data) {
      return {
        error: response.error,
        statusCode: response.statusCode,
        headers: response.headers
      };
    }

    return {
      data: response.data.user,
      statusCode: response.statusCode,
      headers: response.headers
    };
  },

  changePassword: (
    data: { currentPassword: string; newPassword: string },
    config: ApiRequestConfig = {}
  ) => apiPost<{ success: boolean; message?: string }>('/portal/profile/password', data, config),

  getBranding: async (config: ApiRequestConfig = {}): Promise<ApiResponse<BrandingConfig>> => {
    const response = await apiGet<{ branding: BrandingConfig }>('/portal/branding', config);
    if (!response.data) {
      return {
        error: response.error,
        statusCode: response.statusCode,
        headers: response.headers
      };
    }

    return {
      data: response.data.branding,
      statusCode: response.statusCode,
      headers: response.headers
    };
  },

  getQuotes: async (
    params: ListParams = {},
    config: ApiRequestConfig = {}
  ): Promise<PaginatedResult<QuoteSummary>> => {
    const query = buildQueryString({ page: params.page ?? 1, limit: params.limit ?? 200 });
    const response = await apiGet<{ data: QuoteSummary[]; pagination: Pagination }>(
      `/portal/quotes${query}`,
      config
    );
    return mapPaginatedData(response);
  },

  getQuote: async (
    id: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<{ data: QuoteDetail }>> => {
    return apiGet<{ data: QuoteDetail }>(`/portal/quotes/${id}`, config);
  },

  acceptQuote: async (
    id: string,
    signerName?: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<{ data: { invoiceId: string; status: string } }>> => {
    return apiPost<{ data: { invoiceId: string; status: string } }>(
      `/portal/quotes/${id}/accept`,
      signerName ? { signerName } : {},
      config
    );
  },

  declineQuote: async (
    id: string,
    reason: string | undefined,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<{ data: { status: string } }>> => {
    return apiPost<{ data: { status: string } }>(
      `/portal/quotes/${id}/decline`,
      { reason },
      config
    );
  },

  // Mint a Stripe checkout link for an accepted (converted) quote's invoice.
  payQuote: async (
    id: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<{ data: { url: string } }>> => {
    return apiPost<{ data: { url: string } }>(`/portal/quotes/${id}/pay`, undefined, config);
  },

  // Public, token-gated proposal access for prospects without a portal account.
  // These hit /quotes/public/* (NOT /portal/*) — no auth cookie required.
  getPublicQuote: async (
    token: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<{ data: PublicQuoteDetail }>> => {
    return apiGet<{ data: PublicQuoteDetail }>(
      `/quotes/public/${encodeURIComponent(token)}`,
      config
    );
  },

  acceptPublicQuote: async (
    token: string,
    signerName: string,
    signerEmail?: string
  ): Promise<ApiResponse<{ data: { status: string; invoiceNumber: string | null; payUrl: string | null; payDeferred?: boolean } }>> => {
    return apiPost<{ data: { status: string; invoiceNumber: string | null; payUrl: string | null; payDeferred?: boolean } }>(
      `/quotes/public/${encodeURIComponent(token)}/accept`,
      { signerName, signerEmail },
      { redirectOnUnauthorized: false }
    );
  },

  declinePublicQuote: async (
    token: string,
    reason?: string
  ): Promise<ApiResponse<{ data: { status: string } }>> => {
    return apiPost<{ data: { status: string } }>(
      `/quotes/public/${encodeURIComponent(token)}/decline`,
      { reason },
      { redirectOnUnauthorized: false }
    );
  }
};
