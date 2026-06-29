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

/** Threaded reply from the support mailbox: createReply -> set body -> send. */
export async function sendThreadedReply(t: GraphSendTarget, originalMessageId: string, html: string): Promise<void> {
  const token = await getMailboxToken(t.tenantId);
  const base = `${GRAPH}/users/${encodeURIComponent(t.mailbox)}/messages`;

  const draftRes = await gfetch(`${base}/${encodeURIComponent(originalMessageId)}/createReply`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
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
      },
      saveToSentItems: true,
    }),
  });
}
