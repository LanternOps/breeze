import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { HonoRequest } from 'hono';
import { getConfig } from '../../config/validate';
import type { InboundEmailProvider, NormalizedInboundEmail } from './types';

export class MailgunInboundProvider implements InboundEmailProvider {
  readonly name = 'mailgun';

  async verify(req: HonoRequest): Promise<boolean> {
    const body = (await req.parseBody()) as Record<string, string>;
    const { timestamp, token, signature } = body;
    if (!timestamp || !token || !signature) return false;
    const key = getConfig().MAILGUN_INBOUND_SIGNING_KEY;
    if (!key) return false;
    const expected = createHmac('sha256', key).update(timestamp + token).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (!(a.length === b.length && timingSafeEqual(a, b))) return false;

    // Replay/staleness guard: reject signatures whose timestamp is outside a
    // 15-minute tolerance (a non-numeric timestamp is treated as invalid).
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > 900) return false;

    return true;
  }

  async parse(req: HonoRequest): Promise<NormalizedInboundEmail> {
    const b = (await req.parseBody()) as Record<string, string>;
    const from = extractEmail(b.sender || b.from || '');
    const fromName = extractName(b.from || '');
    const refs = (b['References'] || '').trim();
    // When no Message-Id is present, fall back to a content hash that is STABLE
    // across provider retries — the signing `timestamp` differs each retry, so
    // hashing it (the old fallback) defeated dedup. Hash the immutable envelope.
    const messageId = b['Message-Id'] || b['message-id'];
    const fallbackId = `sha256:${createHash('sha256')
      .update(`${from}\n${b.subject ?? ''}\n${b['stripped-text'] ?? b['body-plain'] ?? ''}`)
      .digest('hex')}`;
    return {
      provider: this.name,
      providerMessageId: messageId || fallbackId,
      to: extractEmail(b.recipient || ''),
      from,
      fromName: fromName || undefined,
      subject: b.subject || '',
      text: b['stripped-text'] || b['body-plain'] || '',
      html: b['body-html'] || undefined,
      messageId: b['Message-Id'] || undefined,
      inReplyTo: b['In-Reply-To'] || undefined,
      references: refs ? refs.split(/\s+/) : undefined,
      autoSubmitted: parseHeader(b['message-headers'], 'Auto-Submitted'),
      precedence: parseHeader(b['message-headers'], 'Precedence'),
      attachments: [],
      raw: b
    };
  }
}

// `Jane Doe <jane@x.com>` → `jane@x.com`; bare address passes through.
function extractEmail(s: string): string {
  const m = s.match(/<([^>]+)>/);
  return (m ? (m[1] ?? s) : s).trim().toLowerCase();
}

function extractName(s: string): string {
  const m = s.match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? (m[1] ?? '').trim() : '';
}

function parseHeader(headersJson: string | undefined, name: string): string | undefined {
  if (!headersJson) return undefined;
  try {
    const arr = JSON.parse(headersJson) as [string, string][];
    const hit = arr.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return hit?.[1];
  } catch { return undefined; }
}
