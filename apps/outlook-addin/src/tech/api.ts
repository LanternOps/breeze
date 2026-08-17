/**
 * Typed wrappers over the shared `apiFetch` (Bearer token + 401 re-exchange,
 * `@breeze/office-addin-core`) for the tech-persona `/office-addin/*` surface.
 * Request types mirror `apps/api/src/routes/officeAddin/schemas.ts`; the
 * response/domain shapes live in `@breeze/shared` (`types/officeAddin.ts`),
 * shared with the producing services, and are re-exported here under the
 * names the tech components consume.
 */
import { apiFetch, getApiBaseUrl } from '@breeze/office-addin-core';
import type {
  AddinOrgSummary,
  AddinRunningTimerEntry,
  AddinTicketSummary,
  AddinTimeEntry,
  ContactCandidate,
  ContactCandidateKind,
  ContactCandidateProvenance,
  EmailContextResult,
  MatchedTicket,
} from '@breeze/shared';

export type {
  AddinTicketSummary,
  ContactCandidate,
  ContactCandidateKind,
  ContactCandidateProvenance,
  MatchedTicket,
};
export type OrgSummary = AddinOrgSummary;
export type EmailContextResponse = EmailContextResult;
export type RunningTimerEntry = AddinRunningTimerEntry;
export type TimeEntry = AddinTimeEntry;

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
  /** Present ONLY on the idempotent-replay 200 (`true` — this exact message-id
   *  was already linked to this ticket). The fresh-link 201 body omits the
   *  field entirely, so check truthiness, never `=== false`. */
  alreadyLinked?: boolean;
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
// addinLogTimeSchema) — Task 24. Field shapes mirror `entrySelection()`
// (`services/timeEntryService.ts`) and `toRunningTimerResponse()`
// (`routes/officeAddin/time.ts`); see the shared `AddinTimeEntry` /
// `AddinRunningTimerEntry` types re-exported above.
// ---------------------------------------------------------------------------

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
