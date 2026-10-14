const GRAPH = 'https://graph.microsoft.com/v1.0';
const DELTA_SELECT = [
  'id',
  'internetMessageId',
  'subject',
  'from',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'conversationId',
  'body',
  'bodyPreview',
  'hasAttachments',
  'internetMessageHeaders',
].join(',');

export interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}

export interface GraphHeader {
  name: string;
  value: string;
}

export interface GraphMessage {
  id: string;
  internetMessageId?: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  conversationId?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  hasAttachments?: boolean;
  internetMessageHeaders?: GraphHeader[];
}

export interface DeltaPage {
  messages: GraphMessage[];
  deltaLink: string | null;
  /**
   * Set when the round did not finish in this sweep (budget spent after at least
   * one page, or GRAPH_DELTA_MAX_PAGES_PER_SWEEP reached): the nextLink to continue from. The caller
   * processes `messages` and stores this as the cursor, so a long round, such as
   * a large mailbox's first sync, advances across sweeps (#8400).
   */
  resumeLink?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-request deadline for the Graph calls the mailbox poll sweep makes (the
 * delta read and mark-read), response body included. The sweep processes
 * mailboxes one at a time on a concurrency-1 worker, so a request Graph accepts
 * but never answers would otherwise hold the sweep forever and stop ingestion for
 * every mailbox (#8299). On expiry fetch rejects with a TimeoutError, which
 * classifyGraphPollError treats as transient. Attachment listing and download run
 * in the inbound-email worker, not the sweep, and keep their previous behavior.
 */
export const GRAPH_POLL_TIMEOUT_MS = 60_000;

/**
 * Total time one mailbox's Graph work may take in one sweep: the delta read
 * across every page, 429 Retry-After sleep and retry, then the mark-read calls
 * (#8308). GRAPH_POLL_TIMEOUT_MS only bounds a single request, so a slow but
 * responsive Graph could otherwise hold the concurrency-1 sweep for many minutes.
 * The sweep computes one deadline from this and passes it to listInboxDelta and
 * markRead. When it is spent during the delta read after at least one page,
 * listInboxDelta returns the pages it read with a resumeLink (the next page's
 * URL); the caller processes them and stores the resumeLink as the cursor, so the
 * next sweep continues the round. A large first sync therefore finishes over
 * several sweeps instead of restarting each time. When it is spent before the
 * first page, listInboxDelta throws GraphSweepBudgetError (transient) and the
 * stored cursor stays put. No mail is skipped either way.
 */
export const GRAPH_POLL_SWEEP_BUDGET_MS = 120_000;

/**
 * Requested page size for the delta read. Graph's default page for message delta
 * is small, so a large inbox takes many round trips; Graph may still return fewer
 * per page, and the nextLink loop handles that.
 */
export const GRAPH_DELTA_PAGE_SIZE = 200;

/**
 * Most delta pages one sweep reads before handing back a resumeLink (#8400).
 * The sweep budget bounds Graph time only; enqueue and the generation rechecks
 * run per message afterwards. This cap bounds that local work, and what one
 * sweep holds in memory (bodies and headers are selected), to at most
 * 10 x GRAPH_DELTA_PAGE_SIZE = 2,000 messages per mailbox per sweep.
 */
export const GRAPH_DELTA_MAX_PAGES_PER_SWEEP = 10;

const GRAPH_ORIGIN = new URL(GRAPH).origin;

/**
 * A stored delta cursor or any nextLink (delta or attachments) is only followed
 * on the Graph origin: the bearer token goes with every request, so a poisoned
 * or malformed continuation URL must never be fetched. Fatal, so the mailbox shows the error instead of
 * retrying (as microsoftIdentity does for its own pagination).
 */
function assertGraphContinuationUrl(url: string): void {
  if (!url.startsWith(`${GRAPH_ORIGIN}/`)) {
    throw new Error('Graph continuation URL is not on the Graph origin');
  }
}
const DELTA_PREFER = { Prefer: `odata.maxpagesize=${GRAPH_DELTA_PAGE_SIZE}` };

/** One delta page. Throws GraphSweepBudgetError when the budget ends the request or its body read. */
async function readDeltaPage(
  url: string,
  token: string,
  deadlineAt: number,
): Promise<{ value?: GraphMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }> {
  const res = await graphFetch(url, token, { headers: DELTA_PREFER }, GRAPH_POLL_TIMEOUT_MS, deadlineAt);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Graph delta ${res.status}: ${body.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  try {
    return (await res.json()) as Awaited<ReturnType<typeof readDeltaPage>>;
  } catch (err) {
    // The body read shares the request's signal, so the budget can end it too.
    if (Date.now() >= deadlineAt) throw new GraphSweepBudgetError('Graph sweep budget spent', { cause: err });
    throw err;
  }
}

/** The sweep budget for one mailbox's delta read ran out (#8308). Transient. */
export class GraphSweepBudgetError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GraphSweepBudgetError';
  }
}

function graphSignal(init: RequestInit | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined) return init?.signal ?? undefined;
  const deadline = AbortSignal.timeout(timeoutMs);
  return init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
}

/** One request's timeout: the per-request deadline, cut down to what is left of
 * the sweep budget when there is one. Throws once the budget is spent. */
function requestTimeout(timeoutMs: number | undefined, deadlineAt: number | undefined): number | undefined {
  if (deadlineAt === undefined) return timeoutMs;
  const left = deadlineAt - Date.now();
  if (left <= 0) throw new GraphSweepBudgetError('Graph sweep budget spent');
  return timeoutMs === undefined ? left : Math.min(timeoutMs, left);
}

async function graphFetchOnce(
  url: string,
  token: string,
  init: RequestInit | undefined,
  timeoutMs: number | undefined,
  deadlineAt: number | undefined,
): Promise<Response> {
  const timeout = requestTimeout(timeoutMs, deadlineAt);
  try {
    return await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
      redirect: 'error',
      signal: graphSignal(init, timeout),
    });
  } catch (err) {
    // A request cut short by the sweep budget (rather than by its own deadline)
    // reports as the budget, so the log says which limit was hit.
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw new GraphSweepBudgetError('Graph sweep budget spent', { cause: err });
    }
    throw err;
  }
}

/** Graph fetch with one 429 retry honoring Retry-After. Never follows redirects with the bearer token. */
async function graphFetch(
  url: string,
  token: string,
  init?: RequestInit,
  timeoutMs?: number,
  deadlineAt?: number,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await graphFetchOnce(url, token, init, timeoutMs, deadlineAt);
    if (res.status !== 429) return res;

    const retryAfter = Number(res.headers.get?.('retry-after') ?? '1');
    const waitMs = Math.min(Number.isFinite(retryAfter) ? retryAfter : 1, 30) * 1000;
    // Sleeping past the budget would only end in GraphSweepBudgetError; stop now.
    if (deadlineAt !== undefined && Date.now() + waitMs >= deadlineAt) {
      throw new GraphSweepBudgetError('Graph sweep budget spent waiting out a 429');
    }
    await sleep(waitMs);
  }

  return graphFetchOnce(url, token, init, timeoutMs, deadlineAt);
}

export async function listInboxDelta(
  token: string,
  mailbox: string,
  deltaLink: string | null,
  options: { deadlineAt?: number } = {},
): Promise<DeltaPage> {
  const deadlineAt = options.deadlineAt ?? Date.now() + GRAPH_POLL_SWEEP_BUDGET_MS;
  let url =
    deltaLink ??
    `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages/delta` +
      `?${encodeURIComponent('$select')}=${encodeURIComponent(DELTA_SELECT)}`;
  const messages: GraphMessage[] = [];
  // A continuation URL seen twice in one sweep (including the stored cursor it
  // started from) means Graph is not advancing; resuming would replay the same
  // pages every sweep while looking healthy, so it fails instead.
  assertGraphContinuationUrl(url);
  const seen = new Set<string>([url]);

  for (let pageNo = 0; pageNo < GRAPH_DELTA_MAX_PAGES_PER_SWEEP; pageNo++) {
    let data: Awaited<ReturnType<typeof readDeltaPage>>;
    try {
      data = await readDeltaPage(url, token, deadlineAt);
    } catch (err) {
      // Budget spent after at least one page: hand back what was read and where
      // to continue (#8400). Before the first page there is nothing to keep.
      if (err instanceof GraphSweepBudgetError && pageNo > 0) {
        return { messages, deltaLink: null, resumeLink: url };
      }
      throw err;
    }
    if (Array.isArray(data.value)) messages.push(...data.value);
    const next = data['@odata.nextLink'];
    if (next) {
      assertGraphContinuationUrl(next);
      if (seen.has(next)) throw new Error('Graph delta nextLink repeated; the round is not advancing');
      seen.add(next);
      url = next;
      continue;
    }

    return { messages, deltaLink: data['@odata.deltaLink'] ?? null };
  }

  // Per-sweep page cap reached: continue the round next sweep, like a spent budget.
  return { messages, deltaLink: null, resumeLink: url };
}

/**
 * Attachment METADATA for one message (#6688). `contentBytes` is deliberately
 * not selected: bytes are fetched per attachment, only for the ones we keep,
 * so an oversized file is never downloaded. `@odata.type` is not selectable —
 * Graph always returns it on this polymorphic collection.
 */
const ATTACHMENT_SELECT = 'id,name,contentType,size,isInline';

export interface GraphAttachmentMeta {
  id: string;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  isInline?: boolean | null;
  /** '#microsoft.graph.fileAttachment' | '#microsoft.graph.itemAttachment' | '#microsoft.graph.referenceAttachment' */
  '@odata.type'?: string;
}

function messageUrl(mailbox: string, messageId: string): string {
  return `${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`;
}

async function graphJsonOrThrow<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Graph ${what} ${res.status}: ${body.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export async function listMessageAttachments(
  token: string,
  mailbox: string,
  messageId: string,
): Promise<GraphAttachmentMeta[]> {
  let url =
    `${messageUrl(mailbox, messageId)}/attachments` +
    `?${encodeURIComponent('$select')}=${encodeURIComponent(ATTACHMENT_SELECT)}`;
  const out: GraphAttachmentMeta[] = [];
  for (let guard = 0; guard < 50; guard++) {
    const data = await graphJsonOrThrow<{ value?: GraphAttachmentMeta[]; '@odata.nextLink'?: string }>(
      await graphFetch(url, token),
      'attachments',
    );
    if (Array.isArray(data.value)) out.push(...data.value);
    const next = data['@odata.nextLink'];
    if (!next) break;
    assertGraphContinuationUrl(next);
    url = next;
  }
  return out;
}

/** Bytes of one fileAttachment, decoded from its `contentBytes`. */
export async function getFileAttachmentBytes(
  token: string,
  mailbox: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const url = `${messageUrl(mailbox, messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
  const data = await graphJsonOrThrow<{ contentBytes?: string }>(await graphFetch(url, token), 'attachment');
  if (typeof data.contentBytes !== 'string') {
    throw new Error('Graph attachment response carried no contentBytes');
  }
  return Buffer.from(data.contentBytes, 'base64');
}

/** `deadlineAt` is the sweep's shared deadline (#8308); past it the call throws GraphSweepBudgetError. */
export async function markRead(token: string, mailbox: string, messageId: string, deadlineAt?: number): Promise<void> {
  const url = `${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`;
  const res = await graphFetch(url, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isRead: true }),
  }, GRAPH_POLL_TIMEOUT_MS, deadlineAt);
  // A rejected PATCH is a failure, so the caller's best-effort handler logs it.
  if (!res.ok) {
    const err = new Error(`Graph mark-read ${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
}

/**
 * How the Microsoft 365 mailbox poller should react to a failed token or delta
 * request (#8299). The sweep selects only 'connected' mailboxes, so marking one
 * 'error' stops it until someone reconnects it by hand. A momentary Graph or
 * token-endpoint outage must not do that, the same rule the Gmail sweep follows
 * (`classifyGmailError`).
 *
 * - 'reauth': 401/403. The consent or credential is gone; a reconnect is needed.
 * - 'transient': 408, 429, 5xx, a network failure (fetch's TypeError carrying a
 *   socket/DNS error code), the token request's timeout/abort, or a spent sweep
 *   budget. Stay connected; the next sweep retries.
 * - 'fatal': any other status, or an error with no status that is not a
 *   transport failure (for example the mailbox app is not configured, or Graph
 *   answered with a redirect, which `redirect: 'error'` refuses as a TypeError
 *   with no error code). These do not fix themselves, so they keep stopping the
 *   mailbox as before.
 *
 * 410 (expired delta token) is handled by the caller before this is consulted.
 */
export type GraphPollErrorKind = 'reauth' | 'transient' | 'fatal';

export function classifyGraphPollError(err: unknown): GraphPollErrorKind {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'reauth';
    if (status === 408 || status === 429 || status >= 500) return 'transient';
    return 'fatal';
  }
  if (err instanceof GraphSweepBudgetError) return 'transient';
  if (err instanceof TypeError) return isNetworkFailure(err) ? 'transient' : 'fatal';
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'transient';
  return 'fatal';
}

/**
 * Socket, DNS and connect failures Node's fetch (undici) reports in a TypeError's
 * `cause.code` (#8308). An allowlist, not "any code": fetch also rejects with a
 * coded TypeError for problems that never fix themselves, such as
 * ERR_INVALID_URL for a malformed stored deltaLink.
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Whether a fetch TypeError is a network failure (#8308). Node's fetch rejects
 * every failure as `TypeError: fetch failed` and puts the reason in `cause`. A
 * refused redirect is a plain Error('unexpected redirect') with no code, an
 * invalid URL carries ERR_INVALID_URL, and a coding bug has no cause at all:
 * none of those is a blip, so they surface as mailbox state instead of retrying
 * forever.
 */
function isNetworkFailure(err: TypeError): boolean {
  let cause: unknown = err.cause;
  for (let depth = 0; depth < 3 && cause && typeof cause === 'object'; depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}
