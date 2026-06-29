import type { GraphMessage } from './graphMailClient';
import type { NormalizedInboundEmail, SenderAuth, SenderAuthVerdict } from '../inboundEmail/types';

function header(headers: GraphMessage['internetMessageHeaders'], name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

// Mirror mailgun.ts normalizeVerdict: map a raw mechanism token -> SenderAuthVerdict.
function normalizeVerdict(raw: string | undefined): SenderAuthVerdict {
  const v = raw?.trim().toLowerCase();
  if (v === 'pass') return 'pass';
  if (v === 'fail' || v === 'softfail' || v === 'permerror' || v === 'temperror') return 'fail';
  if (v === 'neutral') return 'neutral';
  if (v === 'none') return 'none';
  return 'unknown';
}

function mechanism(authResults: string | undefined, name: string): string | undefined {
  if (!authResults) return undefined;
  return new RegExp(`\\b${name}=(\\w+)`, 'i').exec(authResults)?.[1];
}

/** Always returns a full SenderAuth (fail-closed). verified iff DMARC passed. */
function buildSenderAuth(authResults: string | undefined): SenderAuth {
  const spf = normalizeVerdict(mechanism(authResults, 'spf'));
  const dkim = normalizeVerdict(mechanism(authResults, 'dkim'));
  const dmarc = normalizeVerdict(mechanism(authResults, 'dmarc'));
  return { spf, dkim, dmarc, verified: dmarc === 'pass' };
}

/** Pure mapping: Graph message -> the pipeline's NormalizedInboundEmail. */
export function normalizeGraphMessage(
  msg: GraphMessage,
  partnerId: string,
  mailboxAddress: string,
): NormalizedInboundEmail {
  const fromAddr = msg.from?.emailAddress?.address?.trim().toLowerCase() ?? '';
  const references = header(msg.internetMessageHeaders, 'References')?.trim().split(/\s+/).filter(Boolean);
  const contentType = msg.body?.contentType?.toLowerCase();
  const html = contentType === 'html' ? msg.body?.content : undefined;
  const text = contentType === 'text' ? (msg.body?.content ?? '') : (msg.bodyPreview ?? '');

  return {
    provider: 'm365',
    providerMessageId: msg.id,
    resolvedPartnerId: partnerId,
    to: mailboxAddress.trim().toLowerCase(),
    from: fromAddr,
    fromName: msg.from?.emailAddress?.name,
    subject: msg.subject ?? '',
    text,
    html,
    messageId: msg.internetMessageId,
    inReplyTo: header(msg.internetMessageHeaders, 'In-Reply-To'),
    references,
    autoSubmitted: header(msg.internetMessageHeaders, 'Auto-Submitted'),
    precedence: header(msg.internetMessageHeaders, 'Precedence'),
    senderAuth: buildSenderAuth(header(msg.internetMessageHeaders, 'Authentication-Results')),
    // Phase-1 parity: attachment bodies deferred; metadata not fetched yet.
    attachments: [],
    raw: {
      graphConversationId: msg.conversationId,
      receivedDateTime: msg.receivedDateTime,
    },
  };
}
