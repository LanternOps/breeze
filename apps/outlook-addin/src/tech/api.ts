/**
 * Typed wrappers over the shared `apiFetch` (Bearer token + 401 re-exchange,
 * `@breeze/office-addin-core`) for the tech-persona `/office-addin/*` surface.
 * Request/response types mirror `apps/api/src/routes/officeAddin/schemas.ts`
 * and the service result types (`emailContext.ts`, `ticketService.ts`,
 * `threadMatcher.ts`) exactly — keep them in sync when those change.
 */
import { apiFetch, getApiBaseUrl } from '@breeze/office-addin-core';

type FetchLike = typeof fetch;

export class TechApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    /** The parsed JSON error body, when present — e.g. the `ticket` payload on
     *  the from-email/link-email 409 responses (`ticket_closed`,
     *  `message_linked_elsewhere`). null when the body wasn't JSON or empty. */
    public body: unknown = null,
  ) {
    super(`office-addin tech request failed: ${status} ${code}`);
    this.name = 'TechApiError';
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function expectOk(res: Response): Promise<unknown> {
  const body = await readJson(res);
  if (!res.ok) {
    const code =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `http_${res.status}`;
    throw new TechApiError(res.status, code, body);
  }
  return body;
}

async function post(
  path: string,
  body: unknown,
  init: RequestInit = {},
  fetchImpl?: FetchLike,
): Promise<unknown> {
  return expectOk(
    await apiFetch(path, { ...init, method: 'POST', body: JSON.stringify(body) }, fetchImpl),
  );
}

// ---------------------------------------------------------------------------
// POST /office-addin/email-context (schemas.ts emailContextSchema)
// ---------------------------------------------------------------------------

export interface EmailContextRequest {
  from: { email: string; name?: string | null };
  sender?: { email: string; name?: string | null } | null;
  internetMessageId?: string | null;
  references?: string[] | null;
  inReplyTo?: string | null;
  subject: string;
  conversationId?: string | null;
  itemGeneration: number;
}

export type ContactCandidateKind = 'portal_user' | 'contact';
export type ContactCandidateProvenance = 'address_match' | 'domain_org';

export interface ContactCandidate {
  kind: ContactCandidateKind;
  id: string;
  name: string | null;
  email: string;
  orgId: string;
  provenance: ContactCandidateProvenance;
}

export interface MatchedTicket {
  id: string;
  partnerId: string;
  orgId: string;
  status: string;
  emailThreadKey: string | null;
  internalNumber: string | null;
}

export interface AddinTicketSummary {
  id: string;
  internalNumber: string | null;
  subject: string;
  status: string;
  priority: string | null;
  updatedAt: string;
  submitterEmail: string | null;
  matchesSubmitter: boolean;
}

export interface OrgSummary {
  name: string;
  siteCount: number;
  deviceCount: number;
  openTicketCount: number;
}

export interface EmailContextResponse {
  itemGeneration: number;
  org: { id: string; name: string } | null;
  contacts: ContactCandidate[];
  threadMatchedTicket: MatchedTicket | null;
  openTickets: AddinTicketSummary[];
  recentTickets: AddinTicketSummary[];
  orgSummary: OrgSummary | null;
  inboundPathConfigured: boolean;
}

/** POST /office-addin/email-context — resolves org/contacts/tickets for the open message. */
export async function fetchEmailContext(
  body: EmailContextRequest,
  init?: RequestInit,
  fetchImpl?: FetchLike,
): Promise<EmailContextResponse> {
  return (await post('/office-addin/email-context', body, init, fetchImpl)) as EmailContextResponse;
}

// ---------------------------------------------------------------------------
// POST /office-addin/orgs/search (schemas.ts orgSearchSchema)
// ---------------------------------------------------------------------------

export interface OrgSearchResponse {
  orgs: Array<{ id: string; name: string }>;
}

/** POST /office-addin/orgs/search — manual org lookup for the "no match" typeahead. */
export async function searchOrgs(query: string, fetchImpl?: FetchLike): Promise<OrgSearchResponse> {
  return (await post('/office-addin/orgs/search', { query }, {}, fetchImpl)) as OrgSearchResponse;
}

// ---------------------------------------------------------------------------
// POST /office-addin/tickets/from-email (schemas.ts fromEmailSchema) — Task 23
// ---------------------------------------------------------------------------

export type FromEmailRequester =
  | { kind: 'portal_user'; id: string }
  | { kind: 'create_contact'; email: string; name?: string | null }
  | { kind: 'raw' };

export interface FromEmailRequest {
  orgId: string;
  subject: string;
  description: string;
  from: { email: string; name?: string | null };
  internetMessageId?: string | null;
  requester: FromEmailRequester;
  followUpOf?: { ticketId: string } | null;
}

export interface FromEmailResponse {
  ticket: AddinTicketSummary;
  /** True when an existing message-id link resolved this idempotently instead of creating a new ticket. */
  alreadyExisted: boolean;
}

/** POST /office-addin/tickets/from-email — create a ticket from the open message. */
export async function createTicketFromEmail(
  body: FromEmailRequest,
  fetchImpl?: FetchLike,
): Promise<FromEmailResponse> {
  return (await post('/office-addin/tickets/from-email', body, {}, fetchImpl)) as FromEmailResponse;
}

// ---------------------------------------------------------------------------
// POST /office-addin/tickets/:id/link-email (schemas.ts linkEmailSchema) — Task 23
// ---------------------------------------------------------------------------

export interface LinkEmailRequest {
  visibility: 'public' | 'internal';
  from: { email: string; name?: string | null };
  internetMessageId?: string | null;
  subject: string;
  bodyText: string;
}

export interface LinkEmailResponse {
  linked: boolean;
  /** True when this exact message-id was already linked to this ticket (idempotent replay). */
  alreadyLinked: boolean;
  commentId: string | null;
}

/** POST /office-addin/tickets/:id/link-email — attach the open message to an existing ticket. */
export async function linkEmail(
  ticketId: string,
  body: LinkEmailRequest,
  fetchImpl?: FetchLike,
): Promise<LinkEmailResponse> {
  return (await post(
    `/office-addin/tickets/${encodeURIComponent(ticketId)}/link-email`,
    body,
    {},
    fetchImpl,
  )) as LinkEmailResponse;
}

// ---------------------------------------------------------------------------
// POST /office-addin/tickets/draft (schemas.ts draftSchema) — Task 23
// ---------------------------------------------------------------------------

export interface DraftRequest {
  orgId: string;
  subject: string;
  bodyText: string;
}

export interface DraftResponse {
  draft: {
    subject: string;
    summary: string;
    suggestedTimeMinutes: number;
    inputTokens: number;
    outputTokens: number;
  };
}

/** POST /office-addin/tickets/draft — AI email-to-ticket prefill. */
export async function fetchDraft(body: DraftRequest, fetchImpl?: FetchLike): Promise<DraftResponse> {
  return (await post('/office-addin/tickets/draft', body, {}, fetchImpl)) as DraftResponse;
}

// ---------------------------------------------------------------------------
// Time tracking (schemas.ts addinStartTimerSchema / addinStopTimerSchema /
// addinLogTimeSchema) — Task 24. Field shapes mirror `entrySelection()` /
// `toRunningTimerResponse()` in `routes/officeAddin/time.ts`.
// ---------------------------------------------------------------------------

export interface RunningTimerEntry {
  id: string;
  ticketId: string | null;
  ticketInternalNumber: string | null;
  startedAt: string;
  description: string | null;
}

export interface TimeEntry {
  id: string;
  partnerId: string;
  orgId: string | null;
  ticketId: string | null;
  userId: string;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
  description: string | null;
  isBillable: boolean;
  hourlyRate: string | null;
  billingStatus: string;
  isApproved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  ticketNumber: string | null;
  ticketSubject: string | null;
  userName: string | null;
}

export interface RunningTimerResponse {
  running: RunningTimerEntry | null;
}

/** GET /office-addin/time/running — the technician's currently-running timer, if any. */
export async function fetchRunningTimer(fetchImpl?: FetchLike): Promise<RunningTimerResponse> {
  return (await expectOk(
    await apiFetch('/office-addin/time/running', {}, fetchImpl),
  )) as RunningTimerResponse;
}

export interface StartTimerRequest {
  ticketId: string;
  description?: string;
}

export interface StartTimerResponse {
  entry: TimeEntry;
  /** The prior running timer that got auto-stopped by starting this one, if any. */
  autoStopped: RunningTimerEntry | null;
}

/** POST /office-addin/time/start — start a timer against a ticket (auto-stops any prior running timer). */
export async function startTimer(
  body: StartTimerRequest,
  fetchImpl?: FetchLike,
): Promise<StartTimerResponse> {
  return (await post('/office-addin/time/start', body, {}, fetchImpl)) as StartTimerResponse;
}

export interface StopTimerRequest {
  description?: string;
  isBillable?: boolean;
}

export interface StopTimerResponse {
  entry: TimeEntry;
}

/** POST /office-addin/time/stop — stop the running timer and log the entry. */
export async function stopTimer(
  body: StopTimerRequest,
  fetchImpl?: FetchLike,
): Promise<StopTimerResponse> {
  return (await post('/office-addin/time/stop', body, {}, fetchImpl)) as StopTimerResponse;
}

export interface LogTimeRequest {
  ticketId: string;
  startedAt: string;
  endedAt: string;
  description: string;
  isBillable?: boolean;
}

export interface LogTimeResponse {
  entry: TimeEntry;
}

/** POST /office-addin/time/log — log a completed time entry directly (no running timer). */
export async function logTime(body: LogTimeRequest, fetchImpl?: FetchLike): Promise<LogTimeResponse> {
  return (await post('/office-addin/time/log', body, {}, fetchImpl)) as LogTimeResponse;
}

// ---------------------------------------------------------------------------
// POST /office-addin/auth/bind (schemas.ts bindSchema) — Task 25
// ---------------------------------------------------------------------------

export interface BindTechnicianRequest {
  accessToken: string;
  email: string;
  password: string;
  mfaCode: string;
}

export interface BindTechnicianResponse {
  bound: boolean;
}

/**
 * POST /office-addin/auth/bind — bind the signed-in Entra identity to a
 * technician account. Deliberately bypasses `apiFetch`: binding establishes
 * the FIRST session for this identity, so there is no Breeze bearer token yet
 * to attach (mirrors `signIn`'s raw-fetch exchange call in
 * `office-addin-core/src/auth/session.ts`).
 */
export async function bindTechnician(
  body: BindTechnicianRequest,
  fetchImpl: FetchLike = fetch,
): Promise<BindTechnicianResponse> {
  const res = await fetchImpl(`${getApiBaseUrl()}/office-addin/auth/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await expectOk(res)) as BindTechnicianResponse;
}
