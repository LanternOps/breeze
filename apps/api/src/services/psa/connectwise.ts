import {
  PSACompanyList,
  PSACompanyListOptions,
  PSAConnectionTest,
  PSAProvider,
  PSATicket,
  PSATicketCreate,
  PSATicketUpdate,
  PSA_COMPANY_LIST_CAP,
  PsaAdapterError,
  type PSAAlertTicketCreate,
  type PSAAlertTicketLimits,
  type PSAAlertTicketRef,
  type PSAAlertTicketing,
  type PSAPickerList,
  type PSAPickerOption,
  type PSAStatusOption,
  type PsaAdapterErrorClass,
  type PsaRecordId
} from './types';
import { psaFetch } from './http';
import { PSA_COMPANY_PAGE_SIZE, collectPaginated, companyPage, toCompanyList, type RawCompanyRecord } from './pagination';
import { SsrfBlockedError } from '../urlSafety';

export interface ConnectWiseCredentials {
  baseUrl: string;
  companyId: string;
  publicKey: string;
  privateKey: string;
  clientId?: string;
}

/**
 * Non-credential adapter settings. Empty since W2-A (#10499): the board a
 * ticket goes to used to be `defaultBoardId` here (API-only, read by a
 * `createTicket` nothing called). It now lives in
 * `psa_connections.alert_ticketing.boardId`; the W2-A migration moved it.
 */
export type ConnectWiseSettings = Record<string, never>;

// ---------------------------------------------------------------------------
// LAB pending (#10534). The values below are placeholders chosen from the
// ConnectWise Manage REST documentation, NOT from a run against a real
// instance. The developer-instance lab (#10534 / #10499 "## LAB") records:
// the summary limit, whether `externalXRef` is writable + searchable (and how
// fast), the status/priority endpoints, the close patch shape, whether an
// internal note emails the customer, and the Manage UI ticket URL. Replace
// each value with the lab result and cite the lab date here before W2-B
// creates any ticket.
// ---------------------------------------------------------------------------

/** LAB pending (#10534): maximum `summary` length, in code points. */
export const CW_SUMMARY_MAX = 100;

/**
 * LAB pending (#10534): how a created ticket is found again after an unknown
 * outcome. `external_xref` writes `externalXRef = breeze-alert:<uuid>` and
 * searches it; `summary_tag` (the fallback if the lab finds the field is not
 * searchable) appends `[breeze-alert:<first 8>]` to the summary and searches
 * `summary contains`.
 */
export const CW_ALERT_MARKER_STRATEGY: 'external_xref' | 'summary_tag' = 'external_xref';

/** LAB pending (#10534): the full-UUID marker written to `externalXRef`. */
export function cwAlertExternalXRef(alertId: string): string {
  return `breeze-alert:${alertId}`;
}

/** LAB pending (#10534): the fallback summary marker. */
export function cwAlertSummaryMarker(alertId: string): string {
  return `[breeze-alert:${alertId.slice(0, 8)}]`;
}

/**
 * LAB pending (#10534): the Manage UI link for a ticket. Assumes the cloud
 * layout (UI host = API host without its `api-` prefix) and the classic
 * service-ticket screen; the lab decides whether this comes from the
 * connection's base URL or a separate setting.
 */
export function connectwiseTicketUiUrl(baseUrl: string, companyId: string, ticketId: number | string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = url.host.replace(/^api-/i, '');
  const query = new URLSearchParams({ service_recid: String(ticketId), companyName: companyId });
  // Built without a literal "//" inside the template: the report-visibility
  // template scanner strips "//" as a comment (partnerOwnedVisibility.scan.test.ts).
  const origin = [url.protocol, host].join("//");
  return `${origin}/v4_6_release/services/system_io/Service/fv_sr100_request.rails?${query.toString()}`;
}

/** One listing page for the pickers; a full page is reported as truncated. */
const CW_PICKER_PAGE_SIZE = 1000;
/**
 * Marker search page size. One ticket per alert is expected; more than one
 * match is a duplicate for W2-B to surface.
 */
const CW_MARKER_SEARCH_PAGE_SIZE = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID_RE = /^[1-9][0-9]{0,9}$/;

/** Node error codes raised before any request bytes reached the PSA. */
const PRE_SEND_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

type ConnectWiseCompany = { id: number; name: string };

type ConnectWiseTicket = {
  id: number;
  summary?: string;
  status?: { name?: string };
  priority?: { name?: string };
  company?: { id?: number; name?: string };
  owner?: { identifier?: string };
  dateEntered?: string;
  lastUpdated?: string;
};

type RequestOptions = {
  contentType?: string;
  /**
   * False for calls that must never be blindly repeated (ticket create, note).
   * Their post-send failures are `unknown_outcome`, not `transient`.
   */
  idempotent: boolean;
};

const PROVIDER = 'connectwise';

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

function adapterError(
  errorClass: PsaAdapterErrorClass,
  message: string,
  extra: { httpStatus?: number | null; retryAfterMs?: number | null; bodySnippet?: string } = {}
): PsaAdapterError {
  return new PsaAdapterError({
    provider: PROVIDER,
    errorClass,
    httpStatus: extra.httpStatus ?? null,
    retryAfterMs: extra.retryAfterMs ?? null,
    bodySnippet: extra.bodySnippet,
    message
  });
}

function toPickerOption(row: { id?: unknown; name?: unknown }): PSAPickerOption | null {
  if (typeof row?.id !== 'number' || !Number.isInteger(row.id) || row.id <= 0) return null;
  if (typeof row.name !== 'string' || row.name.length === 0) return null;
  return { id: row.id, name: row.name };
}

export class ConnectWiseProvider implements PSAProvider, PSAAlertTicketing {
  private credentials: ConnectWiseCredentials;

  readonly alertTicketLimits: PSAAlertTicketLimits = {
    summaryMaxCodePoints: CW_SUMMARY_MAX,
    summaryMarkerSuffix: (alertId: string) =>
      CW_ALERT_MARKER_STRATEGY === 'summary_tag' ? ` ${cwAlertSummaryMarker(alertId)}` : null
  };

  // `settings` is accepted for createPSAProvider's uniform signature; no
  // ConnectWise setting is read any more (see ConnectWiseSettings).
  constructor(credentials: ConnectWiseCredentials, _settings: ConnectWiseSettings = {}) {
    this.credentials = credentials;
  }

  private get baseUrl(): string {
    return this.credentials.baseUrl.replace(/\/$/, '');
  }

  private getAuthHeader(): string {
    const auth = Buffer.from(
      `${this.credentials.companyId}+${this.credentials.publicKey}:${this.credentials.privateKey}`
    ).toString('base64');
    return `Basic ${auth}`;
  }

  /** Strip anything credential-shaped from PSA-supplied text before it is kept. */
  private scrub(text: string): string {
    let out = text;
    const literals = [
      this.getAuthHeader(),
      this.getAuthHeader().slice('Basic '.length),
      this.credentials.privateKey,
      this.credentials.publicKey,
      this.credentials.clientId
    ];
    for (const literal of literals) {
      if (literal && literal.length >= 4) out = out.split(literal).join('[redacted]');
    }
    return out
      .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
      .slice(0, 500);
  }

  private async request<T>(method: string, path: string, body: unknown, options: RequestOptions): Promise<T> {
    let response: Response;
    try {
      response = await psaFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Authorization': this.getAuthHeader(),
          ...(this.credentials.clientId ? { 'clientId': this.credentials.clientId } : {}),
          'Accept': 'application/json',
          'Content-Type': options.contentType ?? 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        throw adapterError('rejected', 'ConnectWise request blocked: the connection URL is not allowed');
      }
      // Node puts the socket error code on the error itself or, when wrapped
      // (`fetch failed`), on its cause.
      const err = error as { code?: unknown; cause?: { code?: unknown } } | null;
      const code = typeof err?.code === 'string' ? err.code : err?.cause?.code;
      const preSend = typeof code === 'string' && PRE_SEND_NETWORK_CODES.has(code);
      const errorClass: PsaAdapterErrorClass = preSend || options.idempotent ? 'transient' : 'unknown_outcome';
      throw adapterError(errorClass, `ConnectWise request failed (${typeof code === 'string' ? code : 'network error'})`);
    }

    if (!response.ok) {
      const status = response.status;
      const bodySnippet = this.scrub(await response.text().catch(() => ''));
      let errorClass: PsaAdapterErrorClass;
      if (status === 401 || status === 403) errorClass = 'auth';
      else if (status === 429) errorClass = 'rate_limited';
      // A non-idempotent call that got past the PSA's front door may have been
      // committed (a 500 after insert, a gateway timing out on a live backend).
      // 503 is the PSA refusing the request outright, so it stays retryable.
      else if (!options.idempotent && (status === 500 || status === 502 || status === 504)) errorClass = 'unknown_outcome';
      else if (status >= 500) errorClass = 'transient';
      else errorClass = 'rejected';
      throw adapterError(errorClass, `ConnectWise API error (${status})`, {
        httpStatus: status,
        retryAfterMs: status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : null,
        bodySnippet
      });
    }

    if (response.status === 204) {
      return undefined as T;
    }

    try {
      return (await response.json()) as T;
    } catch {
      // The PSA accepted the call but the body is unreadable. For a create the
      // ticket may well exist, so this must not read as a clean failure.
      throw adapterError(options.idempotent ? 'transient' : 'unknown_outcome',
        `ConnectWise returned an unreadable ${response.status} response`, { httpStatus: response.status });
    }
  }

  private toTicket(ticket: ConnectWiseTicket): PSATicket {
    return {
      id: ticket.id.toString(),
      externalId: ticket.id.toString(),
      externalUrl: `${this.baseUrl}/service/tickets/${ticket.id}`,
      title: ticket.summary || '',
      description: undefined,
      status: ticket.status?.name || 'unknown',
      priority: ticket.priority?.name,
      assignee: ticket.owner?.identifier,
      companyId: ticket.company?.id ? ticket.company.id.toString() : undefined,
      createdAt: ticket.dateEntered,
      updatedAt: ticket.lastUpdated,
      raw: ticket as Record<string, unknown>
    };
  }

  private toAlertTicketRef(ticket: { id?: unknown; dateEntered?: unknown }): PSAAlertTicketRef | null {
    if (typeof ticket?.id !== 'number' || !Number.isInteger(ticket.id) || ticket.id <= 0) return null;
    return {
      ticketId: String(ticket.id),
      // ConnectWise shows the record id as the ticket number.
      ticketNumber: String(ticket.id),
      externalUrl: connectwiseTicketUiUrl(this.baseUrl, this.credentials.companyId, ticket.id),
      createdAt: typeof ticket.dateEntered === 'string' ? ticket.dateEntered : null
    };
  }

  async testConnection(): Promise<PSAConnectionTest> {
    try {
      await this.request('GET', '/system/info', undefined, { idempotent: true });
      return { success: true, message: 'Connected to ConnectWise' };
    } catch (error) {
      if (error instanceof PsaAdapterError) {
        // Shown to the admin who ran the test; the snippet is scrubbed.
        const detail = error.bodySnippet ? `: ${error.bodySnippet}` : '';
        return { success: false, message: `${error.message}${detail}` };
      }
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed'
      };
    }
  }

  /**
   * ConnectWise Manage paginates with a 1-based `page=` alongside `pageSize=`.
   * It returns a bare array with no total, so "another page exists" is inferred
   * from a full page — one extra request on an exact multiple, which is the
   * correct trade against under-reading an MSP's company list.
   */
  async getCompanies(options: PSACompanyListOptions = {}): Promise<PSACompanyList> {
    const limit = options.limit ?? PSA_COMPANY_LIST_CAP;

    // `conditions=deletedFlag=false` drops soft-deleted companies server-side;
    // without it an MSP's archived customers arrive pre-selected and provision
    // dead organizations. `orderBy=id asc` makes the page walk deterministic —
    // page/offset paging over an unordered result set can skip or repeat rows
    // while still looking like a complete list.
    const query =
      `/company/companies?fields=id,name&conditions=${encodeURIComponent('deletedFlag=false')}` +
      `&orderBy=${encodeURIComponent('id asc')}&pageSize=${PSA_COMPANY_PAGE_SIZE}`;

    const result = await collectPaginated<RawCompanyRecord>(limit, async (cursor) => {
      const page = cursor ? Number(cursor) : 1;
      const response = await this.request<ConnectWiseCompany[]>('GET', `${query}&page=${page}`, undefined, { idempotent: true });
      const rows = response || [];

      // Never infer end-of-list from a SHORT page — ConnectWise may return
      // fewer than pageSize. Only an empty RAW page ends the walk.
      return companyPage(
        rows.map((company) => ({ id: company?.id, name: company?.name })),
        String(page + 1),
        options.skipExternalIds
      );
    });

    return toCompanyList(result);
  }

  async createTicket(input: PSATicketCreate): Promise<PSATicket> {
    const body: Record<string, unknown> = {
      summary: input.title,
      initialDescription: input.description || '',
      company: input.companyId ? { id: Number(input.companyId) } : undefined,
      priority: input.priority ? { name: input.priority } : undefined,
      status: input.status ? { name: input.status } : undefined
    };

    const response = await this.request<ConnectWiseTicket>('POST', '/service/tickets', body, { idempotent: false });
    return this.toTicket(response);
  }

  async updateTicket(ticketId: string, updates: PSATicketUpdate): Promise<PSATicket> {
    const operations: Array<{ op: string; path: string; value: unknown }> = [];

    if (updates.title !== undefined) {
      operations.push({ op: 'replace', path: '/summary', value: updates.title });
    }
    if (updates.description !== undefined) {
      operations.push({ op: 'replace', path: '/initialDescription', value: updates.description });
    }
    if (updates.priority !== undefined) {
      operations.push({ op: 'replace', path: '/priority/name', value: updates.priority });
    }
    if (updates.status !== undefined) {
      operations.push({ op: 'replace', path: '/status/name', value: updates.status });
    }
    if (updates.companyId !== undefined) {
      operations.push({ op: 'replace', path: '/company/id', value: Number(updates.companyId) });
    }

    if (operations.length === 0) {
      return this.getTicket(ticketId);
    }

    await this.request(
      'PATCH',
      `/service/tickets/${ticketId}`,
      operations,
      { contentType: 'application/json-patch+json', idempotent: true }
    );

    return this.getTicket(ticketId);
  }

  async getTicket(ticketId: string): Promise<PSATicket> {
    const response = await this.request<ConnectWiseTicket>(
      'GET',
      `/service/tickets/${ticketId}`,
      undefined,
      { idempotent: true }
    );

    return this.toTicket(response);
  }

  async syncTickets(): Promise<PSATicket[]> {
    const response = await this.request<ConnectWiseTicket[]>(
      'GET',
      '/service/tickets?orderBy=lastUpdated desc&pageSize=50',
      undefined,
      { idempotent: true }
    );

    return (response || []).map((ticket) => this.toTicket(ticket));
  }

  // -------------------------------------------------------------------------
  // PSAAlertTicketing (#10499 W2-A). Ids, never names. Nothing calls these
  // until W2-B; the W2-A config API only uses the pickers.
  // -------------------------------------------------------------------------

  private assertAlertId(alertId: string): void {
    // The id is interpolated into a `conditions=` expression; only a UUID may.
    if (!UUID_RE.test(alertId)) throw adapterError('rejected', 'Alert id must be a UUID');
  }

  private assertTicketId(ticketId: string): void {
    if (!NUMERIC_ID_RE.test(ticketId)) throw adapterError('rejected', 'ConnectWise ticket id must be numeric');
  }

  async createAlertTicket(input: PSAAlertTicketCreate): Promise<PSAAlertTicketRef> {
    this.assertAlertId(input.alertId);
    if (!NUMERIC_ID_RE.test(input.companyId)) {
      throw adapterError('rejected', 'ConnectWise company id must be numeric');
    }
    if (Array.from(input.summary).length > this.alertTicketLimits.summaryMaxCodePoints) {
      throw adapterError('rejected', `Ticket summary exceeds ${this.alertTicketLimits.summaryMaxCodePoints} characters`);
    }
    // Under the summary_tag strategy the marker IS the lookup key: a summary
    // built without it would make an unknown-outcome create unfindable.
    const requiredSuffix = this.alertTicketLimits.summaryMarkerSuffix(input.alertId);
    if (requiredSuffix !== null && !input.summary.endsWith(requiredSuffix)) {
      throw adapterError('rejected', 'Ticket summary is missing the alert marker');
    }

    const body: Record<string, unknown> = {
      summary: input.summary,
      initialDescription: input.description,
      board: { id: input.boardId },
      status: { id: input.statusId },
      ...(input.priorityId !== undefined ? { priority: { id: input.priorityId } } : {}),
      ...(input.typeId !== undefined ? { type: { id: input.typeId } } : {}),
      company: { id: Number(input.companyId) },
      ...(CW_ALERT_MARKER_STRATEGY === 'external_xref' ? { externalXRef: cwAlertExternalXRef(input.alertId) } : {})
    };

    const created = await this.request<{ id?: unknown; dateEntered?: unknown }>(
      'POST', '/service/tickets', body, { idempotent: false }
    );
    const ref = this.toAlertTicketRef(created);
    if (!ref) {
      throw adapterError('unknown_outcome', 'ConnectWise accepted the ticket but returned no ticket id');
    }
    return ref;
  }

  async closeTicket(ticketId: string, statusId: PsaRecordId): Promise<void> {
    this.assertTicketId(ticketId);
    // LAB pending (#10534): patch shape for a status change by id.
    await this.request(
      'PATCH',
      `/service/tickets/${ticketId}`,
      [{ op: 'replace', path: 'status', value: { id: statusId } }],
      { contentType: 'application/json-patch+json', idempotent: true }
    );
  }

  async addNote(ticketId: string, text: string): Promise<void> {
    this.assertTicketId(ticketId);
    // LAB pending (#10534): confirm an internal-analysis note sends no customer email.
    await this.request('POST', `/service/tickets/${ticketId}/notes`, {
      text,
      detailDescriptionFlag: false,
      internalAnalysisFlag: true,
      resolutionFlag: false,
      customerUpdatedFlag: false
    }, { idempotent: false });
  }

  async findTicketsByMarker(alertId: string): Promise<PSAAlertTicketRef[]> {
    this.assertAlertId(alertId);
    const condition = CW_ALERT_MARKER_STRATEGY === 'external_xref'
      ? `externalXRef="${cwAlertExternalXRef(alertId)}"`
      : `summary contains "${cwAlertSummaryMarker(alertId)}"`;
    const query = new URLSearchParams({
      conditions: condition,
      fields: 'id,dateEntered',
      orderBy: 'id asc',
      pageSize: String(CW_MARKER_SEARCH_PAGE_SIZE)
    });
    const rows = await this.request<unknown>(
      'GET', `/service/tickets?${query.toString()}`, undefined, { idempotent: true }
    );
    // "No ticket exists" may lead the caller to create one, so only a real,
    // empty array may mean it. Anything else is an error, never a miss.
    if (!Array.isArray(rows)) {
      throw adapterError('rejected', 'ConnectWise returned an unexpected ticket search response');
    }
    const refs = rows
      .map((row) => this.toAlertTicketRef(row as { id?: unknown; dateEntered?: unknown }))
      .filter((ref): ref is PSAAlertTicketRef => ref !== null);
    if (rows.length > 0 && refs.length === 0) {
      throw adapterError('rejected', 'ConnectWise returned ticket matches without usable ids');
    }
    return refs.sort((a, b) => Number(a.ticketId) - Number(b.ticketId));
  }

  private async listPicker<T>(path: string, params: Record<string, string>): Promise<{ rows: T[]; truncated: boolean }> {
    const query = new URLSearchParams({ ...params, pageSize: String(CW_PICKER_PAGE_SIZE), page: '1' });
    const rows = await this.request<unknown>('GET', `${path}?${query.toString()}`, undefined, { idempotent: true });
    if (!Array.isArray(rows)) {
      throw adapterError('rejected', 'ConnectWise returned an unexpected listing response');
    }
    return { rows: rows as T[], truncated: rows.length >= CW_PICKER_PAGE_SIZE };
  }

  async listBoards(): Promise<PSAPickerList> {
    const { rows, truncated } = await this.listPicker<{ id?: unknown; name?: unknown }>('/service/boards', {
      fields: 'id,name',
      conditions: 'inactiveFlag=false',
      orderBy: 'name asc'
    });
    return { options: rows.map(toPickerOption).filter((o): o is PSAPickerOption => o !== null), truncated };
  }

  async listStatuses(boardId: PsaRecordId): Promise<PSAPickerList<PSAStatusOption>> {
    if (!Number.isInteger(boardId) || boardId <= 0) throw adapterError('rejected', 'Board id must be a positive integer');
    // LAB pending (#10534): confirm `closedStatus` is the closed flag on this endpoint.
    const { rows, truncated } = await this.listPicker<{ id?: unknown; name?: unknown; closedStatus?: unknown }>(
      `/service/boards/${boardId}/statuses`,
      { fields: 'id,name,closedStatus', conditions: 'inactive=false', orderBy: 'sortOrder asc' }
    );
    const options: PSAStatusOption[] = [];
    for (const row of rows) {
      const option = toPickerOption(row);
      if (option) options.push({ ...option, closed: typeof row.closedStatus === 'boolean' ? row.closedStatus : null });
    }
    return { options, truncated };
  }

  async listPriorities(): Promise<PSAPickerList> {
    // LAB pending (#10534): confirm the priority endpoint on the instance.
    const { rows, truncated } = await this.listPicker<{ id?: unknown; name?: unknown }>('/service/priorities', {
      fields: 'id,name',
      orderBy: 'sortOrder asc'
    });
    return { options: rows.map(toPickerOption).filter((o): o is PSAPickerOption => o !== null), truncated };
  }
}
