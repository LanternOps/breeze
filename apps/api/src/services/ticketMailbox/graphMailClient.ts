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

function graphSignal(init: RequestInit | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined) return init?.signal ?? undefined;
  const deadline = AbortSignal.timeout(timeoutMs);
  return init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
}

/** Graph fetch with one 429 retry honoring Retry-After. Never follows redirects with the bearer token. */
async function graphFetch(url: string, token: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
      redirect: 'error',
      signal: graphSignal(init, timeoutMs),
    });
    if (res.status !== 429) return res;

    const retryAfter = Number(res.headers.get?.('retry-after') ?? '1');
    await sleep(Math.min(Number.isFinite(retryAfter) ? retryAfter : 1, 30) * 1000);
  }

  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    redirect: 'error',
    signal: graphSignal(init, timeoutMs),
  });
}

export async function listInboxDelta(
  token: string,
  mailbox: string,
  deltaLink: string | null,
): Promise<DeltaPage> {
  let url =
    deltaLink ??
    `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages/delta` +
      `?${encodeURIComponent('$select')}=${encodeURIComponent(DELTA_SELECT)}`;
  const messages: GraphMessage[] = [];
  let finalDelta: string | null = null;

  for (let guard = 0; guard < 1000; guard++) {
    const res = await graphFetch(url, token, undefined, GRAPH_POLL_TIMEOUT_MS);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Graph delta ${res.status}: ${body.slice(0, 200)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }

    const data = (await res.json()) as {
      value?: GraphMessage[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };
    if (Array.isArray(data.value)) messages.push(...data.value);
    if (data['@odata.nextLink']) {
      url = data['@odata.nextLink'];
      continue;
    }

    finalDelta = data['@odata.deltaLink'] ?? null;
    break;
  }

  return { messages, deltaLink: finalDelta };
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
    if (!data['@odata.nextLink']) break;
    url = data['@odata.nextLink'];
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

export async function markRead(token: string, mailbox: string, messageId: string): Promise<void> {
  const url = `${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`;
  await graphFetch(url, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isRead: true }),
  }, GRAPH_POLL_TIMEOUT_MS);
}

/**
 * How the Microsoft 365 mailbox poller should react to a failed token or delta
 * request (#8299). The sweep selects only 'connected' mailboxes, so marking one
 * 'error' stops it until someone reconnects it by hand. A momentary Graph or
 * token-endpoint outage must not do that, the same rule the Gmail sweep follows
 * (`classifyGmailError`).
 *
 * - 'reauth': 401/403. The consent or credential is gone; a reconnect is needed.
 * - 'transient': 408, 429, 5xx, or a transport failure (fetch's TypeError, or the
 *   token request's timeout/abort). Stay connected; the next sweep retries.
 * - 'fatal': any other status, or an error with no status that is not a
 *   transport failure (for example the mailbox app is not configured). These do
 *   not fix themselves, so they keep stopping the mailbox as before.
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
  if (err instanceof TypeError) return 'transient';
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'transient';
  return 'fatal';
}
