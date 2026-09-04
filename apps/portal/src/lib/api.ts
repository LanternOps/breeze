/**
 * Portal API Client
 * Handles all API requests for the customer portal
 */

import { navigateTo } from './navigation';
// Invoice-domain enum SSOT lives in @breeze/shared (billing-enums.ts). Imported
// into local scope for the InvoiceSummary/InvoiceDetail types below and re-exported
// (type-only, erased at build) so '@/lib/api' consumers are unaffected.
import type { BackupDevicesDto, BackupOverviewDto, DashboardDto, DocumentPageSize, DocumentThemeId, EnrichedPortalDevice, InvoiceStatus, PublicQuoteHeader, QuotePresentation, SecurityDevicesDto, SecurityOverviewDto, SlaDto, SupportUsageDto, TicketFormField } from '@breeze/shared';
import type { PortalRunDto, PortalRunsDto } from '@breeze/shared';

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

/**
 * Browser-facing API path for hrefs, image `src`, and download links that end
 * up IN the rendered HTML. Always same-origin relative (`/api/v1/...`), so the
 * reverse proxy routes it. `buildPortalApiUrl` below resolves the SSR-internal
 * base (e.g. http://api:3001) for server-side fetches — rendering THAT into an
 * href leaked the internal hostname into customer HTML and tripped a hydration
 * mismatch on every document page.
 */
export type PublicApiPath = string & { readonly __brand: 'PublicApiPath' };

function stripApiPrefix(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return normalizedPath === '/api'
    ? ''
    : normalizedPath.startsWith('/api/')
      ? normalizedPath.slice(4)
      : normalizedPath;
}

export function publicApiPath(path: string): PublicApiPath {
  return `/api/v1${stripApiPrefix(path)}` as PublicApiPath;
}

export function buildPortalApiUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  const apiBase = resolveApiBase();
  return `${apiBase}/api/v1${stripApiPrefix(path)}`;
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
  /** Abort the request after this many ms, falling into the existing
   *  network-error catch path below (so callers that already fail closed on
   *  a network error — e.g. loadPortalBranding — also fail closed on a
   *  hang, not just a hard error). Undefined = no bound, matching prior
   *  behavior for every other call site. */
  timeoutMs?: number;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  /** Machine-readable error code from the API body (e.g. PORTAL_TICKETS_DISABLED). */
  code?: string;
  /** The `data` payload carried BY AN ERROR body, kept separate from `data` so
   *  presence of `data` still means "the request succeeded". Some errors are
   *  renderable rather than fatal — a 410 QUOTE_SUPERSEDED carries the partner's
   *  branding so a replaced proposal can show a branded notice instead of a bare
   *  failure. */
  errorData?: unknown;
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
      credentials: 'include',
      signal: config.timeoutMs !== undefined ? AbortSignal.timeout(config.timeoutMs) : options.signal
    });

    if (response.status === 401) {
      // Callers that opt out of the login redirect (the public token-gated
      // quote routes, SSR forwarding) are NOT session-authed: a 401 there is
      // about the request's own credential (e.g. a consumed/replayed quote
      // link, #2875), not the portal session. Don't wipe a logged-in user's
      // auth state over it, and surface the API's real error body instead of
      // the hardcoded session message.
      if (config.redirectOnUnauthorized === false) {
        const body = await response.json().catch(() => ({}));
        return {
          error: body?.error || 'Session expired',
          code: typeof body?.code === 'string' ? body.code : undefined,
          statusCode: response.status,
          headers: response.headers
        };
      }
      clearAuth();
      if (typeof window !== 'undefined') {
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
        error: body?.error || 'That didn\'t go through. Nothing was lost — try again in a moment.',
        code: typeof body?.code === 'string' ? body.code : undefined,
        errorData: body?.data,
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

export interface PortalRunsResult extends PaginatedResult<PortalRunDto> {
  timezone?: string;
}

export type Device = EnrichedPortalDevice;

/** Mirrors the API's ticket_status enum. A freshly submitted ticket is 'new'
 *  (it becomes 'open' when a technician picks it up); 'pending' is waiting on
 *  the customer, 'on_hold' on something else. Keep in sync with
 *  apps/api/src/db/schema/portal.ts ticketStatusEnum. */
export type TicketStatus = 'new' | 'open' | 'pending' | 'on_hold' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TicketSummary {
  id: string;
  ticketNumber: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
  sla: SlaDto;
}

export type CreatedPortalTicket = Omit<TicketSummary, 'sla'> & {
  description: string;
};

/**
 * Attachment metadata on a PUBLIC ticket comment (W08 #3902). Render-only in
 * v1 — the portal cannot upload. Never carries the storage key, backend,
 * digest or bytes; those are server-only.
 */
export interface TicketCommentAttachment {
  id: string;
  commentId: string | null;
  contentType: string;
  byteSize: number;
  originalFilename: string;
  createdAt: string;
}

export interface TicketComment {
  id: string;
  authorName: string;
  /** 'portal' is the customer's own reply; anything else came from the IT team. */
  authorType: string | null;
  content: string;
  createdAt: string;
  /** Absent on a reply the customer just posted locally. */
  attachments?: TicketCommentAttachment[];
}

/**
 * Browser-facing path for an attachment's bytes. Same-origin and relative so
 * the reverse proxy routes it and the SSR-internal API host never reaches
 * customer HTML (see `publicApiPath`). The portal session cookie authenticates
 * the request; the API 404s anything not on a public comment of a ticket this
 * session submitted.
 */
export function portalAttachmentContentPath(ticketId: string, attachmentId: string): PublicApiPath {
  return publicApiPath(`/portal/tickets/${ticketId}/attachments/${attachmentId}/content`);
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
export type { InvoiceStatus, PublicQuoteHeader };

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string | null;
  /** Derived human handle: the accepted proposal's title, else the first
   *  customer-visible line's name. Always present on list rows; null for a
   *  bare invoice. */
  title: string | null;
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
  ticketNumber: string | null;
  /** Line title; NULL on legacy lines where `description` holds the title (#3319). */
  name: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  taxable: boolean;
}

export interface InvoiceDetail {
  // The detail header is a separate serialization boundary on the API and
  // does not carry the list's derived `title`.
  invoice: Omit<InvoiceSummary, 'title'> & {
    subtotal: string;
    taxTotal: string;
    taxRate: string | null;
    billToName: string | null;
    notes: string | null;
    sellerSnapshot?: SellerSnapshot | null;
    termsAndConditions?: string | null;
  };
  lines: InvoiceLine[];
  /** Partner branding for the document shell, matching QuoteDetail. Optional:
   *  older API responses and fixtures predate it, in which case the view falls
   *  back to GET /portal/branding. */
  branding?: QuoteBranding;
}

export type QuoteStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'converted'
  // The portal list returns every non-draft quote, so it will receive this the
  // moment quotes can be superseded. Declared here to keep the union honest;
  // the dedicated "replaced" rendering lands with the rest of the portal work.
  | 'superseded';

export interface QuoteSummary {
  id: string;
  quoteNumber: string | null;
  /** The proposal's own title (quotes.title); null when the MSP gave it none. */
  title: string | null;
  status: QuoteStatus;
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

/** Server-serialized shape of a `table` quote block's `content` (mirrors
 *  `quoteTableContentSchema` in @breeze/shared/validators/quotes.ts). Column
 *  labels and cell values are sanitized server-side with the inline-only
 *  profile before ever reaching the portal, same precedent as rich_text. */
export interface QuoteTableContent {
  columns: Array<{ label: string; align?: 'left' | 'center' | 'right' }>;
  rows: Array<{ cells: string[] }>;
  caption?: string;
  zebra?: boolean;
  headerStyle?: 'accent' | 'plain';
}

/** Server-serialized shape of a `callout` quote block's `content` (mirrors
 *  `quoteCalloutContentSchema` in @breeze/shared/validators/quotes.ts). `html`
 *  is sanitized server-side, same precedent as rich_text. */
export interface QuoteCalloutContent {
  variant: 'info' | 'accent' | 'warn';
  title?: string;
  html: string;
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
  contractLineType?: 'per_device' | 'per_device_role' | 'per_device_group' | 'per_seat' | null;
  deviceRoles?: string[] | null;
  deviceGroupId?: string | null;
  deviceGroupName?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  includedQuantity?: string | null;
  overageMode?: 'bill' | 'flag' | null;
  overageUnitPrice?: string | null;
  descriptorUnresolved?: boolean;
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
  /** The MSP's published support contact, so the PUBLIC proposal page can offer
   *  a prospect a way to reach the company asking them to sign. Optional: older
   *  API responses and fixtures predate these fields. */
  supportEmail?: string | null;
  supportPhone?: string | null;
}

export interface QuoteDetail {
  quote: QuoteHeader & {
    /** Set when a NON-DRAFT revision has replaced this quote. The API withholds
     *  draft successors on purpose — a customer must not learn a revision is
     *  being prepared for them. */
    supersededByQuoteId?: string | null;
  };
  blocks: QuoteBlock[];
  lines: QuoteLine[];
  /** Optional for API responses that predate the branding field. */
  branding?: QuoteBranding;
  /** Resolved document theme/pageSize (Task 12). Optional: fixtures/older
   *  payloads omit it, which must read as 'classic' (documentShell's fallback). */
  presentation?: QuotePresentation;
}

export interface PublicQuoteDetail {
  quote: PublicQuoteHeader;
  blocks: QuoteBlock[];
  lines: QuoteLine[];
  branding: QuoteBranding;
  /** Resolved document theme/pageSize (Task 12). Optional: fixtures/older
   *  payloads omit it, which must read as 'classic' (documentShell's fallback). */
  presentation?: QuotePresentation;
}

/** The public (token-gated) invoice payload — /invoices/public/:token. A VOID
 *  invoice deliberately carries only identity fields (no amounts), so most
 *  money fields are optional here. */
export interface PublicInvoiceDetail {
  invoice: {
    id: string;
    invoiceNumber: string | null;
    status: InvoiceStatus;
    /** Present only on the void payload: an updated invoice exists. */
    replaced?: boolean;
    currencyCode?: string;
    issueDate?: string | null;
    dueDate?: string | null;
    subtotal?: string;
    taxRate?: string | null;
    taxTotal?: string;
    total?: string;
    amountPaid?: string;
    balance?: string;
    depositDue?: string | null;
    billToName?: string | null;
    notes?: string | null;
    sellerSnapshot?: SellerSnapshot | null;
    termsAndConditions?: string | null;
    paidAt?: string | null;
  };
  lines: InvoiceLine[];
  chargeNow: { amount: string; isDeposit: boolean } | null;
  payable: boolean;
  branding: {
    partnerName: string;
    contactEmail: string | null;
    logoUrl: string | null;
    primaryColor: string | null;
    theme: DocumentThemeId;
    pageSize: DocumentPageSize;
  };
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
  enableDashboard?: boolean;
  enableSecurity?: boolean;
  enableBackups?: boolean;
  enableReports?: boolean;
  enableSupportUsage?: boolean;
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
  ): Promise<PaginatedResult<EnrichedPortalDevice>> => {
    const query = buildQueryString({ page: params.page ?? 1, limit: params.limit ?? 50 });
    return mapPaginatedData(
      await apiGet<{
        data: EnrichedPortalDevice[];
        pagination: Pagination;
      }>(`/portal/devices${query}`, config)
    );
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
  ): Promise<ApiResponse<CreatedPortalTicket>> => {
    const response = await apiPost<{ ticket: CreatedPortalTicket }>(
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

  /** Customer reply on their own ticket. The API (POST /portal/tickets/:id/comments)
   *  only accepts comments on tickets the session's portal user submitted, caps
   *  content at 5,000 chars, and returns the created public comment. */
  addTicketComment: async (
    ticketId: string,
    content: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<TicketComment>> => {
    const response = await apiPost<{ comment: TicketComment }>(
      `/portal/tickets/${ticketId}/comments`,
      { content },
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
      data: response.data.comment,
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

  // Public (unauthenticated) branding lookup by custom domain / forwarded host —
  // used for the anonymous landing/redirect path before a portal session exists.
  getBrandingByDomain: async (
    domain: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<BrandingConfig>> => {
    const response = await apiGet<{ branding: BrandingConfig }>(
      `/portal/branding/${encodeURIComponent(domain)}`,
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
  ): Promise<ApiResponse<{ data: { status: string; invoiceNumber: string | null; invoiceUrl: string | null; payDeferred?: boolean } }>> => {
    return apiPost<{ data: { status: string; invoiceNumber: string | null; invoiceUrl: string | null; payDeferred?: boolean } }>(
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
  },

  // Public, token-gated invoice access — the durable no-login view-and-pay link.
  // These hit /invoices/public/* (NOT /portal/*): no auth cookie, and a 401 must
  // never bounce an anonymous customer to the portal login.
  getPublicInvoice: async (
    token: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<{ data: PublicInvoiceDetail }>> => {
    return apiGet<{ data: PublicInvoiceDetail }>(
      `/invoices/public/${encodeURIComponent(token)}`,
      config
    );
  },

  payPublicInvoice: async (
    token: string
  ): Promise<ApiResponse<{ data: { url: string } }>> => {
    return apiPost<{ data: { url: string } }>(
      `/invoices/public/${encodeURIComponent(token)}/pay`,
      {},
      { redirectOnUnauthorized: false }
    );
  },

  // Checkout verify-on-return WITHOUT the invoice token: exchanges the Stripe
  // session id for settlement + the canonical public page url (the return urls
  // deliberately carry no bearer token — see the API route).
  settlePublicReturn: async (
    sessionId: string
  ): Promise<ApiResponse<{ data: { settled: boolean; publicUrl: string | null } }>> => {
    return apiPost<{ data: { settled: boolean; publicUrl: string | null } }>(
      '/invoices/public/settle-return',
      { sessionId },
      { redirectOnUnauthorized: false }
    );
  },

  // W04 — portal dashboard
  getDashboard: (
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<DashboardDto>> =>
    apiGet<DashboardDto>('/portal/dashboard', config),

  // ---- W05 — security ----
  getSecurityOverview: (
    days = 30,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<SecurityOverviewDto>> =>
    apiGet<SecurityOverviewDto>(
      `/portal/security/overview${buildQueryString({ days })}`,
      config
    ),

  getSecurityDevices: (
    params: ListParams = {},
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<SecurityDevicesDto>> =>
    apiGet<SecurityDevicesDto>(
      `/portal/security/devices${buildQueryString({
        page: params.page ?? 1,
        limit: params.limit ?? 50
      })}`,
      config
    ),

  // W06 — backups
  getBackupOverview: (
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<BackupOverviewDto>> =>
    apiGet<BackupOverviewDto>('/portal/backups/overview', config),

  getBackupDevices: (
    params: ListParams = {},
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<BackupDevicesDto>> =>
    apiGet<BackupDevicesDto>(
      `/portal/backups/devices${buildQueryString({
        page: params.page ?? 1,
        limit: params.limit ?? 50,
      })}`,
      config
    ),

  // ---------------------------------------------------------------------------
  // W08 — support usage
  // ---------------------------------------------------------------------------
  getSupportUsage: (
    month?: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<SupportUsageDto>> =>
    apiGet<SupportUsageDto>(
      `/portal/tickets/usage${buildQueryString({ month })}`,
      config
    ),

  // W10 — customer reports
  getReportRuns: async (
    params: ListParams = {},
    config: ApiRequestConfig = {},
  ): Promise<PortalRunsResult> => {
    const query = buildQueryString({
      page: params.page ?? 1,
      limit: params.limit ?? 20,
    });
    const response = await apiGet<PortalRunsDto>(
      `/portal/reports/runs${query}`,
      config,
    );
    return {
      ...mapPaginatedData(response),
      timezone: response.data?.timezone,
    };
  },

  generateReport: async (
    type: 'security_compliance_posture' | 'executive_summary',
    config: ApiRequestConfig = {},
  ): Promise<ApiResponse<PortalRunDto>> => {
    const response = await apiPost<{ data: PortalRunDto }>(
      '/portal/reports/generate',
      { type },
      config,
    );
    if (!response.data) {
      return {
        error: response.error,
        code: response.code,
        errorData: response.errorData,
        statusCode: response.statusCode,
        headers: response.headers,
      };
    }
    return {
      data: response.data.data,
      statusCode: response.statusCode,
      headers: response.headers,
    };
  },

  reportArtifactUrl: (
    runId: string,
    format: 'pdf' | 'csv',
  ): PublicApiPath =>
    publicApiPath(`/portal/reports/runs/${runId}/${format}`),
};
