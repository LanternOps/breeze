import type { PsaProviderId } from '@breeze/shared';

// Derived from the single-source provider list in @breeze/shared
// (packages/shared/src/validators/psa.ts) so API, web, and service layer
// can never drift.
export type PSAProviderType = PsaProviderId;

/**
 * Providers whose adapter can enumerate companies for organization import.
 *
 * Defined in @breeze/shared (packages/shared/src/validators/psa.ts) and merely
 * re-exported here: the WEB UI needs the same list to decide which connections
 * may be offered the import action, and a second hand-maintained copy is the
 * drift the shared package exists to prevent. Every existing importer of
 * `./types` keeps working unchanged.
 */
export {
  ORG_IMPORT_CAPABLE_PSA_PROVIDERS,
  isOrgImportCapableProvider,
  type OrgImportCapablePsaProvider
} from '@breeze/shared';

/**
 * Raised when a capability is asked of a provider that cannot serve it.
 *
 * Exists so "this provider does not support company import" can never be
 * confused with "this provider returned zero companies" — the pre-#3246 Jira
 * adapter returned `[]` for `getCompanies()`, which would have rendered as a
 * successful import preview of an empty PSA. Routes map this to 400.
 */
export class PsaCapabilityError extends Error {
  readonly provider: string;
  readonly capability: string;

  constructor(provider: string, capability: string) {
    super(`PSA provider "${provider}" does not support ${capability}`);
    this.name = 'PsaCapabilityError';
    this.provider = provider;
    this.capability = capability;
  }
}

/**
 * Default ceiling on companies pulled from one PSA in one import.
 *
 * Defined in @breeze/shared alongside the capability list — the web UI quotes
 * this number in its truncation warning, so it must be the same constant the
 * server enforces, not a copy.
 */
export { PSA_COMPANY_LIST_CAP } from '@breeze/shared';

export interface PSAConnectionTest {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface PSACompany {
  id: string;
  name: string;
  externalId?: string;
}

export interface PSATicket {
  id: string;
  externalId?: string;
  externalUrl?: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  assignee?: string;
  companyId?: string;
  createdAt?: string;
  updatedAt?: string;
  raw?: Record<string, unknown>;
}

export interface PSATicketCreate {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  companyId?: string;
  dueDate?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface PSATicketUpdate {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  companyId?: string;
  dueDate?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface PSACompanyListOptions {
  /** Max companies to return. Defaults to `PSA_COMPANY_LIST_CAP`. */
  limit?: number;
  /**
   * External ids to drop DURING the walk, so they never consume the cap.
   *
   * The caller passes the ids already linked to this provider; without this an
   * MSP with more companies than the cap could never reach the ones past it,
   * because every walk restarts at page 1 and refills the cap with companies
   * that are already imported.
   */
  skipExternalIds?: ReadonlySet<string>;
}

export interface PSACompanyList {
  companies: PSACompany[];
  /**
   * True when the cap, the wall-clock budget, or the page guard stopped the
   * walk with companies still unread upstream. MUST be surfaced to the user:
   * importing the first 1000 of 1500 companies creates exactly the
   * partial-tenant state the external link table exists to prevent.
   */
  truncated: boolean;
  /** Set iff `truncated` — the UI wording differs per cause. */
  truncationReason?: 'cap' | 'time-budget' | 'page-guard';
  /** Records dropped during the walk because `skipExternalIds` matched. */
  alreadyLinked: number;
  /**
   * Records the PSA returned that had no usable id or name and were skipped.
   * Surfaced rather than silently dropped so a tech can tell "my PSA has 300
   * companies" from "297 imported, 3 were unreadable".
   */
  malformed: number;
}

/**
 * How an adapter call failed, at the adapter boundary (#10499 W2-A). The alert
 * ticketing worker (W2-B) decides retry, pause and give-up from `errorClass`
 * alone:
 *
 * - `auth`            401/403 — pause ticketing for the connection.
 * - `rate_limited`    429 — back off, honouring `retryAfterMs`.
 * - `transient`       5xx, or a network failure that cannot have reached the PSA,
 *                     or any failure of an idempotent call — retry with backoff.
 * - `rejected`        any other 4xx, or a URL the SSRF guard refused — terminal.
 * - `unknown_outcome` a non-idempotent call (create, note) whose request may have
 *                     been processed: a timeout or reset after sending, a 502/504,
 *                     or an unreadable success body. Never re-POST; look up by
 *                     marker instead.
 *
 * `message` never contains the PSA response body (it reaches logs and Sentry);
 * `bodySnippet` is scrubbed of credential material and capped at 500 chars, for
 * display to a partner admin only.
 */
export type PsaAdapterErrorClass = 'auth' | 'rate_limited' | 'transient' | 'rejected' | 'unknown_outcome';

export const PSA_ADAPTER_ERROR_BODY_MAX = 500;

export class PsaAdapterError extends Error {
  readonly provider: string;
  readonly errorClass: PsaAdapterErrorClass;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  readonly bodySnippet: string;

  constructor(input: {
    provider: string;
    errorClass: PsaAdapterErrorClass;
    httpStatus: number | null;
    retryAfterMs?: number | null;
    bodySnippet?: string;
    message: string;
  }) {
    super(input.message);
    this.name = 'PsaAdapterError';
    this.provider = input.provider;
    this.errorClass = input.errorClass;
    this.httpStatus = input.httpStatus;
    this.retryAfterMs = input.retryAfterMs ?? null;
    this.bodySnippet = (input.bodySnippet ?? '').slice(0, PSA_ADAPTER_ERROR_BODY_MAX);
  }
}

/** A PSA record id (board, status, priority, type). ConnectWise ids are integers. */
export type PsaRecordId = number;

export interface PSAPickerOption {
  id: PsaRecordId;
  name: string;
}

export interface PSAStatusOption extends PSAPickerOption {
  /** True when the PSA marks this status as closing the ticket; null when it does not say. */
  closed: boolean | null;
}

export interface PSAPickerList<T extends PSAPickerOption = PSAPickerOption> {
  options: T[];
  /** True when the PSA had more records than one listing returns. */
  truncated: boolean;
}

export interface PSAAlertTicketCreate {
  /** Breeze alert id; the adapter derives the lookup marker from it. */
  alertId: string;
  /** Already built and truncated with `alertTicketLimits` (`psaAlertTicketing/summary.ts`). */
  summary: string;
  description: string;
  /** The org's external company id (`organization_external_links.external_id`). */
  companyId: string;
  boardId: PsaRecordId;
  statusId: PsaRecordId;
  priorityId?: PsaRecordId;
  typeId?: PsaRecordId;
}

export interface PSAAlertTicketRef {
  ticketId: string;
  ticketNumber: string | null;
  /** The PSA's own UI link for the ticket, when the adapter can build one. */
  externalUrl: string | null;
  createdAt: string | null;
}

export interface PSAAlertTicketLimits {
  /** Maximum ticket summary length, in Unicode code points. */
  summaryMaxCodePoints: number;
  /**
   * Text the summary must end with so `findTicketsByMarker` can find the ticket,
   * or null when the adapter marks tickets some other way (a reference field).
   */
  summaryMarkerSuffix(alertId: string): string | null;
}

/**
 * Optional capability: the provider can create, close and annotate tickets for
 * Breeze alerts with ids (never names), and find a ticket it may have created
 * when a create's outcome is unknown. Only ConnectWise implements it in W2;
 * the Alert tickets card is shown only for a capable provider.
 */
export interface PSAAlertTicketing {
  readonly alertTicketLimits: PSAAlertTicketLimits;
  createAlertTicket(input: PSAAlertTicketCreate): Promise<PSAAlertTicketRef>;
  closeTicket(ticketId: string, statusId: PsaRecordId): Promise<void>;
  /** Posts an internal note (never a customer-visible update). */
  addNote(ticketId: string, text: string): Promise<void>;
  /** Tickets carrying this alert's marker, oldest first. */
  findTicketsByMarker(alertId: string): Promise<PSAAlertTicketRef[]>;
  listBoards(): Promise<PSAPickerList>;
  listStatuses(boardId: PsaRecordId): Promise<PSAPickerList<PSAStatusOption>>;
  listPriorities(): Promise<PSAPickerList>;
}

export function supportsAlertTicketing(provider: PSAProvider): provider is PSAProvider & PSAAlertTicketing {
  const candidate = provider as Partial<PSAAlertTicketing>;
  return typeof candidate.createAlertTicket === 'function'
    && typeof candidate.closeTicket === 'function'
    && typeof candidate.addNote === 'function'
    && typeof candidate.findTicketsByMarker === 'function'
    && typeof candidate.listBoards === 'function'
    && typeof candidate.listStatuses === 'function'
    && typeof candidate.listPriorities === 'function'
    && typeof candidate.alertTicketLimits === 'object' && candidate.alertTicketLimits !== null;
}

export interface PSAProvider {
  testConnection(): Promise<PSAConnectionTest>;
  /**
   * Enumerate companies/accounts/organizations, walking the provider's native
   * pagination until `limit` is reached. Adapters that cannot enumerate
   * companies at all throw `PsaCapabilityError` rather than returning empty.
   */
  getCompanies(options?: PSACompanyListOptions): Promise<PSACompanyList>;
  createTicket(input: PSATicketCreate): Promise<PSATicket>;
  updateTicket(ticketId: string, updates: PSATicketUpdate): Promise<PSATicket>;
  getTicket(ticketId: string): Promise<PSATicket>;
  syncTickets(): Promise<PSATicket[]>;
}
