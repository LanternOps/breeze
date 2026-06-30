import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { HonoRequest } from 'hono';
import { getConfig } from '../../config/validate';
import type {
  InboundEmailProvider,
  NormalizedInboundEmail,
  SenderAuth,
  SenderAuthVerdict
} from './types';

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
      senderAuth: extractSenderAuth(b),
      attachments: [],
      raw: b
    };
  }
}

// Mailgun stamps its receiving MX host as the authserv-id (the leading token before the
// first ';') of the Authentication-Results header it adds. Those hosts are `mxa.mailgun.org`
// / `mxb.mailgun.org` (US) and `mxa.eu.mailgun.org` / `mxb.eu.mailgun.org` (EU) — NOT the
// bare apex `mx.mailgun.org` (the earlier hardcoded value, which matched no real inbound
// host and quarantined every DMARC-pass message). An external sender can put an
// `Authentication-Results: anything; dmarc=pass` header into their OWN message, so we only
// trust a header whose authserv-id host is `mailgun.org` or a subdomain of it. The match is
// on a LABEL boundary (apex, or `.mailgun.org` suffix) so lookalikes like `evilmailgun.org`
// or `mailgun.org.attacker.com` are rejected.
//
// Forgery model: RFC 8601 §5 has the receiving ADMD strip inbound Authentication-Results
// headers bearing the RECEIVING INSTANCE's own authserv-id before stamping its genuine one.
// That guarantee is per-exact-authserv-id, NOT fleet-wide — a message relayed through
// `mxa.mailgun.org` is only guaranteed to have forged `mxa.mailgun.org` headers stripped, so
// an attacker could embed a sibling-host `mxb.mailgun.org; dmarc=pass` header that survives.
// Because we trust the whole `*.mailgun.org` family, we therefore do NOT trust the first
// matching header blindly: `extractSenderAuth` requires every trusted header's DMARC verdict
// to agree on pass and fails closed on any disagreement (see mechanismVerdict).
const MAILGUN_AUTHSERV_DOMAIN = 'mailgun.org';

function isMailgunAuthservId(authservId: string): boolean {
  const host = authservId.toLowerCase();
  return host === MAILGUN_AUTHSERV_DOMAIN || host.endsWith(`.${MAILGUN_AUTHSERV_DOMAIN}`);
}

// Read Mailgun's already-computed sender-authentication verdicts (R4). Mailgun
// evaluates SPF/DKIM/DMARC at its MX boundary and surfaces them via:
//   - X-Mailgun-Spf               top-level form field ('Pass'/'Neutral'/'Fail'/...)
//   - X-Mailgun-Dkim-Check-Result top-level form field (Mailgun's own DKIM verdict)
//   - Authentication-Results      header carrying dkim= / dmarc=, ONLY trusted when its
//                                 authserv-id is Mailgun's own MX host
// We do NOT re-run DNS auth here; we only normalize what the provider authoritatively
// reported. Prefer Mailgun's own namespaced fields over the generic header. DMARC is the
// only true From-domain alignment signal we have, and it has no Mailgun-namespaced field,
// so we read it solely from a Mailgun-authoritative Authentication-Results header; a
// foreign/absent authserv-id yields no DMARC pass. `verified` requires that authserv-id-
// asserted DMARC pass — we do NOT trust a bare SPF+DKIM pass, because neither verdict on
// its own proves alignment to the (spoofable) From domain. Any absent/foreign verdict is
// NOT a pass (fail closed).
function extractSenderAuth(b: Record<string, string>): SenderAuth {
  // Every Authentication-Results header stamped with a Mailgun-family authserv-id. Normally
  // exactly one (the receiving instance's); more than one means either benign duplication or a
  // surviving forged sibling-host header — mechanismVerdict resolves that by requiring agreement.
  const trusted = mailgunAuthResults(b['message-headers']);
  // Mailgun's own namespaced fields are authoritative and take precedence; fall back to the
  // trusted header(s) only when the field is absent (`?? undefined` preserves the prior
  // "present-but-empty stays as-is" semantics).
  const spf = normalizeVerdict(b['X-Mailgun-Spf'] ?? mechanismVerdict(trusted, 'spf'));
  const dkim = normalizeVerdict(b['X-Mailgun-Dkim-Check-Result'] ?? mechanismVerdict(trusted, 'dkim'));
  const dmarc = normalizeVerdict(mechanismVerdict(trusted, 'dmarc'));
  // DMARC pass (asserted via Mailgun's authserv-id) is the only From-domain-aligned
  // trust signal; a standalone SPF+DKIM pass is NOT treated as verified.
  const verified = dmarc === 'pass';
  return { spf, dkim, dmarc, verified };
}

// Return EVERY Authentication-Results header value carrying a Mailgun-family authserv-id (the
// token before the first ';'). A relay chain (e.g. M365 → Mailgun) carries multiple
// Authentication-Results headers — M365's own plus Mailgun's — so we scan ALL of them rather
// than only the first, which may be the foreign-authserv-id one. authserv-id comparison is
// case-insensitive and tolerant of an optional trailing version digit (e.g. "mxa.mailgun.org 1").
function mailgunAuthResults(headersJson: string | undefined): string[] {
  const trusted: string[] = [];
  for (const raw of parseHeaderAll(headersJson, 'Authentication-Results')) {
    const authservId = (raw.split(';')[0] ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (isMailgunAuthservId(authservId)) trusted.push(raw);
  }
  return trusted;
}

// Collapse a mechanism's verdict across all trusted Mailgun A-R headers into a single raw
// token, failing closed on disagreement. Returns 'pass' ONLY when at least one trusted header
// asserts the mechanism and every header that asserts it says pass; returns 'fail' if any
// trusted header reports a non-pass verdict for it (so a forged sibling-host pass cannot
// override a genuine fail); returns undefined when no trusted header mentions the mechanism.
function mechanismVerdict(trusted: string[], mechanism: string): string | undefined {
  const verdicts = trusted
    .map((h) => extractMechanism(h, mechanism))
    .filter((v): v is string => v !== undefined)
    .map((v) => v.toLowerCase());
  if (verdicts.length === 0) return undefined;
  return verdicts.every((v) => v === 'pass') ? 'pass' : 'fail';
}

// Pull `<mechanism>=<result>` out of an Authentication-Results header value, e.g.
// "mxa.mailgun.org; dkim=pass header.d=x.com; dmarc=fail" -> for 'dkim' returns 'pass'.
function extractMechanism(authResults: string, mechanism: string): string | undefined {
  const m = new RegExp(`\\b${mechanism}\\s*=\\s*([a-zA-Z]+)`, 'i').exec(authResults);
  return m?.[1];
}

// Normalize a raw verdict token to the SenderAuthVerdict union. Anything we don't
// recognize (or undefined) collapses to 'unknown', which is never a pass.
function normalizeVerdict(raw: string | undefined): SenderAuthVerdict {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'pass': return 'pass';
    case 'fail':
    case 'softfail':
    case 'permerror':
    case 'temperror':
      return 'fail';
    case 'neutral': return 'neutral';
    case 'none': return 'none';
    default: return 'unknown';
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

// Like parseHeader but returns EVERY value for a header name (in array order). Needed for
// Authentication-Results, which legitimately appears multiple times on a relayed message.
function parseHeaderAll(headersJson: string | undefined, name: string): string[] {
  if (!headersJson) return [];
  try {
    const arr = JSON.parse(headersJson) as [string, string][];
    return arr.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
  } catch { return []; }
}
