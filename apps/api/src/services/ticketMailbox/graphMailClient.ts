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

/** Graph fetch with one 429 retry honoring Retry-After. Never follows redirects with the bearer token. */
async function graphFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
      redirect: 'error',
    });
    if (res.status !== 429) return res;

    const retryAfter = Number(res.headers.get?.('retry-after') ?? '1');
    await sleep(Math.min(Number.isFinite(retryAfter) ? retryAfter : 1, 30) * 1000);
  }

  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    redirect: 'error',
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
    const res = await graphFetch(url, token);
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
  });
}
