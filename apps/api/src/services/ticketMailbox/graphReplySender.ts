import { getMailboxToken } from './mailboxToken';
import { BREEZE_OUTBOUND_HEADER, BREEZE_OUTBOUND_HEADER_VALUE } from '../emailDomains/outboundMarker';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface GraphSendTarget { tenantId: string; mailbox: string; }

// Mark our own Graph-sent mail so it is recognized if it loops back into the
// monitored mailbox (a contact/forward rule can round-trip a notification). The
// ingest side already reads this header (normalizeGraphMessage -> outboundMarker
// -> loopPrevention.ownOutboundReason); the send side must stamp it. Graph only
// accepts custom internet headers at message CREATION and requires an `x-` prefix
// ("Add custom headers only when creating a message, and name them starting with
// 'x-'. After the message is sent, you cannot modify the headers." —
// learn.microsoft.com/graph/api/resources/message), so this goes in the sendMail
// message object and the createReply POST body (both create the message), never a
// post-send PATCH, which Graph rejects. The round-trip (this exact header shape is
// what the ingest normalizer reads and ownOutboundReason suppresses on) is covered
// by a seam test in normalizeGraphMessage.test.ts.
const OUTBOUND_INTERNET_HEADERS = [{ name: BREEZE_OUTBOUND_HEADER, value: BREEZE_OUTBOUND_HEADER_VALUE }];

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

/** Threaded reply from the support mailbox: createReply -> set body -> send. */
export async function sendThreadedReply(t: GraphSendTarget, originalMessageId: string, html: string): Promise<void> {
  const token = await getMailboxToken(t.tenantId);
  const base = `${GRAPH}/users/${encodeURIComponent(t.mailbox)}/messages`;

  // Stamp the outbound marker at draft creation (Graph rejects custom headers set
  // after creation, so it cannot be added in the body PATCH below).
  const draftRes = await gfetch(`${base}/${encodeURIComponent(originalMessageId)}/createReply`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { internetMessageHeaders: OUTBOUND_INTERNET_HEADERS } }),
  });
  const draft = (await draftRes.json()) as { id?: string };
  if (!draft.id) throw new Error('Graph createReply returned no draft id');

  await gfetch(`${base}/${encodeURIComponent(draft.id)}`, token, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { contentType: 'HTML', content: html } }),
  });

  await gfetch(`${base}/${encodeURIComponent(draft.id)}/send`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
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
        internetMessageHeaders: OUTBOUND_INTERNET_HEADERS,
      },
      saveToSentItems: true,
    }),
  });
}
