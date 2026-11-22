import { getMailboxToken } from './mailboxToken';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface GraphSendTarget { tenantId: string; mailbox: string; }

async function gfetch(url: string, token: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    redirect: 'error',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph ${init.method ?? 'GET'} ${url} -> ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

export interface ThreadedReplyOptions {
  /**
   * The only recipient of the reply (email-first replies W1, decision 8). Graph's
   * createReply addresses the draft to the original message's sender, or its
   * Reply-To, and that message may be a follow-up from someone else; the draft's
   * To is replaced with exactly this address and Cc/Bcc are emptied.
   */
  to: string;
  /**
   * Replace Graph's default `RE: <original subject>` on the draft. Only the
   * autoresponse sets this (its rendered template subject carries the ticket
   * token); technician replies leave it unset and keep `RE:`.
   */
  subject?: string;
}

/** The draft's recipients after the PATCH were not exactly `[to]`, no Cc, no Bcc. Never sent. */
export class GraphRecipientMismatchError extends Error {
  constructor(counts: { to: number; cc: number; bcc: number }) {
    // Counts only: the addresses are customer data and this message is logged.
    super(`Graph draft recipient mismatch after PATCH (to=${counts.to}, cc=${counts.cc}, bcc=${counts.bcc}); draft not sent`);
    this.name = 'GraphRecipientMismatchError';
  }
}

type Recipient = { emailAddress?: { address?: unknown } };

function addresses(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null;
  return (list as Recipient[]).map((r) =>
    typeof r?.emailAddress?.address === 'string' ? r.emailAddress.address.trim().toLowerCase() : '');
}

/**
 * Fail closed: the PATCH response is Graph's view of the draft. Anything other
 * than To = [to] and empty Cc/Bcc (including lists Graph did not return) means
 * the replace did not apply as sent.
 */
function assertRecipients(patched: Record<string, unknown>, to: string): void {
  const toList = addresses(patched.toRecipients);
  const cc = addresses(patched.ccRecipients);
  const bcc = addresses(patched.bccRecipients);
  const ok = toList !== null && cc !== null && bcc !== null
    && toList.length === 1 && toList[0] === to.trim().toLowerCase()
    && cc.length === 0 && bcc.length === 0;
  if (!ok) throw new GraphRecipientMismatchError({ to: toList?.length ?? -1, cc: cc?.length ?? -1, bcc: bcc?.length ?? -1 });
}

/**
 * Threaded reply from the support mailbox: createReply -> PATCH recipients, body
 * (and optional subject) in one request -> check the echoed recipients -> send.
 * After createReply, any failure deletes the draft (best effort) and rethrows,
 * so a half-built reply never sits in the mailbox's Drafts.
 */
export async function sendThreadedReply(
  t: GraphSendTarget,
  originalMessageId: string,
  html: string,
  opts: ThreadedReplyOptions,
): Promise<void> {
  const token = await getMailboxToken(t.tenantId);
  const base = `${GRAPH}/users/${encodeURIComponent(t.mailbox)}/messages`;

  const draftRes = await gfetch(`${base}/${encodeURIComponent(originalMessageId)}/createReply`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  const draft = (await draftRes.json()) as { id?: string };
  if (!draft.id) throw new Error('Graph createReply returned no draft id');
  const draftUrl = `${base}/${encodeURIComponent(draft.id)}`;

  try {
    const patchRes = await gfetch(draftUrl, token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toRecipients: [{ emailAddress: { address: opts.to } }],
        ccRecipients: [],
        bccRecipients: [],
        replyTo: [{ emailAddress: { address: t.mailbox } }],
        ...(opts.subject ? { subject: opts.subject } : {}),
        body: { contentType: 'HTML', content: html },
      }),
    });
    const patched = (await patchRes.json().catch(() => ({}))) as Record<string, unknown>;
    assertRecipients(patched ?? {}, opts.to);

    await gfetch(`${draftUrl}/send`, token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
  } catch (err) {
    await gfetch(draftUrl, token, { method: 'DELETE' }).catch((cleanupErr: unknown) => {
      console.warn('[graphReplySender] could not delete the unsent draft',
        cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
    });
    throw err;
  }
}

/** First-contact / autoresponse with no original message to reply to. */
export async function sendNewMail(t: GraphSendTarget, to: string, subject: string, html: string): Promise<void> {
  const token = await getMailboxToken(t.tenantId);
  await gfetch(`${GRAPH}/users/${encodeURIComponent(t.mailbox)}/sendMail`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: to } }],
        replyTo: [{ emailAddress: { address: t.mailbox } }],
      },
      saveToSentItems: true,
    }),
  });
}
