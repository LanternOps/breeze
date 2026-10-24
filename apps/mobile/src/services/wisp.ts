import { coreRequest } from './api';

/**
 * Wisp (W06c). Client for the Wisp thread, concern, activity and grant routes.
 *
 * Types are declared locally: the mobile app has no dependency on
 * `@breeze/shared` (see `ticketPushPrefs.ts`). The server routes are the wire
 * oracle; everything here is normalised defensively so a truncated or newer
 * body degrades to something safe instead of throwing in a render path.
 *
 * `coreRequest` returns the RAW parsed body (no `data` unwrapping), and the
 * routes disagree on envelopes — each function below documents its own.
 */
export type WispConcernStatus = 'open' | 'snoozed' | 'resolved' | 'dismissed';
export type WispConcernSeverity = 'info' | 'low' | 'medium' | 'high';
export type WispConcernFeedback = 'useful' | 'not_useful';

export interface WispConcernRecipient {
  nudgeCount: number;
  snoozedUntil: string | null;
  feedback: WispConcernFeedback | null;
}

export interface WispConcern {
  id: string;
  orgId: string | null;
  subject: { kind: string; id: string };
  summary: string;
  severity: WispConcernSeverity;
  status: WispConcernStatus;
  snoozedUntil: string | null;
  approvalIntentId: string | null;
  updatedAt: string;
  recipient: WispConcernRecipient | null;
}

export type WispGrantStatus = 'active' | 'paused' | 'revoked' | 'expired';

export interface WispThreadGrant {
  id: string;
  status: WispGrantStatus;
  orgId: string | null;
  expiresAt: string;
  pausedReason: string | null;
  budgetCentsPerDay: number | null;
  spentTodayCents: number | null;
  budgetResetsAt: string | null;
}

export interface WispThread {
  id: string;
  grantId: string;
  summary: string;
  summaryUpdatedAt: string | null;
  grant: WispThreadGrant;
}

export type WispActivityKind =
  | 'assessment'
  | 'concern'
  | 'specialist'
  | 'approval'
  | 'memory'
  | 'nudge'
  | 'brief';

export interface WispActivityItem {
  at: string;
  kind: WispActivityKind;
  orgId: string | null;
  title: string;
  detail: string | null;
  href: string | null;
  costCents: number | null;
}

export interface WispCurrentActivity {
  orgId: string | null;
  orgName: string | null;
  startedAt: string;
}

export interface WispActivityPage {
  items: WispActivityItem[];
  nextCursor: string | null;
  current: WispCurrentActivity | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const SEVERITIES: readonly WispConcernSeverity[] = ['info', 'low', 'medium', 'high'];
const CONCERN_STATUSES: readonly WispConcernStatus[] = ['open', 'snoozed', 'resolved', 'dismissed'];
const GRANT_STATUSES: readonly WispGrantStatus[] = ['active', 'paused', 'revoked', 'expired'];
const ACTIVITY_KINDS: readonly WispActivityKind[] = [
  'assessment', 'concern', 'specialist', 'approval', 'memory', 'nudge', 'brief',
];

/**
 * Fail closed: the reply box disables on any non-active grant, so a status
 * this build does not know must never read as 'active'.
 */
function grantStatus(v: unknown): WispGrantStatus {
  return GRANT_STATUSES.includes(v as WispGrantStatus) ? (v as WispGrantStatus) : 'expired';
}

function normalizeRecipient(raw: unknown): WispConcernRecipient | null {
  if (!isObj(raw)) return null;
  const count = finite(raw.nudgeCount);
  return {
    nudgeCount: count !== null && count >= 0 ? count : 0,
    snoozedUntil: str(raw.snoozedUntil),
    feedback: raw.feedback === 'useful' || raw.feedback === 'not_useful' ? raw.feedback : null,
  };
}

/** Total: never throws; null when the row is unusable. */
export function normalizeConcern(raw: unknown): WispConcern | null {
  if (!isObj(raw) || !nonEmpty(raw.id) || !nonEmpty(raw.summary)) return null;
  const subject = raw.subject;
  const recipient = normalizeRecipient(raw.recipient);
  return {
    id: raw.id,
    orgId: str(raw.orgId),
    subject:
      isObj(subject) && typeof subject.kind === 'string' && typeof subject.id === 'string'
        ? { kind: subject.kind, id: subject.id }
        : { kind: 'unknown', id: '' },
    summary: raw.summary,
    severity: SEVERITIES.includes(raw.severity as WispConcernSeverity)
      ? (raw.severity as WispConcernSeverity)
      : 'info',
    status: CONCERN_STATUSES.includes(raw.status as WispConcernStatus)
      ? (raw.status as WispConcernStatus)
      : 'open',
    // W05 nests per-person state under `recipient`; the top level is a fallback.
    snoozedUntil: recipient?.snoozedUntil ?? str(raw.snoozedUntil),
    approvalIntentId: str(raw.approvalIntentId),
    updatedAt: str(raw.updatedAt) ?? '',
    recipient,
  };
}

/** `GET /wisp/thread/:id` -> `{ data: { thread, grant } }`. */
export async function getWispThread(threadId: string): Promise<WispThread> {
  const res = await coreRequest<{ data?: { thread?: unknown; grant?: unknown } }>(
    `/wisp/thread/${encodeURIComponent(threadId)}`
  );
  const thread = res?.data?.thread;
  const grant = res?.data?.grant;
  if (!isObj(thread) || !nonEmpty(thread.id) || !isObj(grant) || !nonEmpty(grant.id)) {
    throw new Error('wisp thread payload malformed');
  }
  return {
    id: thread.id,
    grantId: str(thread.grantId) ?? grant.id,
    summary: str(thread.summary) ?? '',
    summaryUpdatedAt: str(thread.summaryUpdatedAt),
    grant: {
      id: grant.id,
      status: grantStatus(grant.status),
      orgId: str(grant.orgId),
      expiresAt: str(grant.expiresAt) ?? '',
      pausedReason: str(grant.pausedReason),
      budgetCentsPerDay: finite(grant.budgetCentsPerDay),
      spentTodayCents: finite(grant.spentTodayCents),
      budgetResetsAt: str(grant.budgetResetsAt),
    },
  };
}

/** `GET /wisp/concerns` -> `{ concerns }` (NOT wrapped in `data`). */
export async function listWispConcerns(grantId: string): Promise<WispConcern[]> {
  const res = await coreRequest<{ concerns?: unknown }>(
    '/wisp/concerns?grantId=' +
      encodeURIComponent(grantId) +
      '&status=open,snoozed,resolved,dismissed'
  );
  if (!Array.isArray(res?.concerns)) return [];
  return res.concerns
    .map(normalizeConcern)
    .filter((c): c is WispConcern => c !== null);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function snoozeWispConcern(id: string, grantId: string, until: string): Promise<void> {
  await coreRequest(`/wisp/concerns/${encodeURIComponent(id)}/snooze`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ grantId, until }),
  });
}

export async function dismissWispConcern(id: string, grantId: string): Promise<void> {
  await coreRequest(`/wisp/concerns/${encodeURIComponent(id)}/dismiss`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ grantId }),
  });
}

/** `POST /wisp/concerns/:id/feedback` -> `{ data: { recipient } }`. */
export async function sendWispConcernFeedback(
  id: string,
  grantId: string,
  input: { useful: boolean; note?: string }
): Promise<WispConcernRecipient | null> {
  const res = await coreRequest<{ data?: { recipient?: unknown } }>(
    `/wisp/concerns/${encodeURIComponent(id)}/feedback`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        grantId,
        useful: input.useful,
        ...(input.note ? { note: input.note } : {}),
      }),
    }
  );
  return normalizeRecipient(res?.data?.recipient);
}

function normalizeActivityItem(raw: unknown): WispActivityItem | null {
  if (!isObj(raw) || typeof raw.at !== 'string' || typeof raw.title !== 'string') return null;
  if (!ACTIVITY_KINDS.includes(raw.kind as WispActivityKind)) return null;
  return {
    at: raw.at,
    kind: raw.kind as WispActivityKind,
    orgId: str(raw.orgId),
    title: raw.title,
    detail: str(raw.detail),
    href: str(raw.href),
    costCents: finite(raw.costCents),
  };
}

/** `GET /wisp/thread/:id/activity` -> `{ data: { items, nextCursor, current? } }`. */
export async function getWispActivity(
  threadId: string,
  opts: { limit?: number; cursor?: string } = {}
): Promise<WispActivityPage> {
  const qs = `limit=${opts.limit ?? 20}${
    opts.cursor ? `&cursor=${encodeURIComponent(opts.cursor)}` : ''
  }`;
  const res = await coreRequest<{ data?: Obj }>(
    `/wisp/thread/${encodeURIComponent(threadId)}/activity?${qs}`
  );
  const data = res?.data;
  const current = data?.current;
  return {
    items: Array.isArray(data?.items)
      ? data.items.map(normalizeActivityItem).filter((i): i is WispActivityItem => i !== null)
      : [],
    nextCursor: str(data?.nextCursor),
    current:
      isObj(current) && typeof current.startedAt === 'string'
        ? { orgId: str(current.orgId), orgName: str(current.orgName), startedAt: current.startedAt }
        : null,
  };
}

/** Pause/resume return the top-level grant DTO (NOT wrapped). */
async function grantTransition(
  grantId: string,
  verb: 'pause' | 'resume'
): Promise<{ status: WispGrantStatus; pausedReason: string | null }> {
  const res = await coreRequest<Obj>(`/wisp/grants/${encodeURIComponent(grantId)}/${verb}`, {
    method: 'POST',
  });
  return { status: grantStatus(res?.status), pausedReason: str(res?.pausedReason) };
}

export const pauseWispGrant = (grantId: string) => grantTransition(grantId, 'pause');
export const resumeWispGrant = (grantId: string) => grantTransition(grantId, 'resume');
