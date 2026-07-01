import type { HonoRequest } from 'hono';

// Terminal audit status written to ticket_email_inbound.parse_status. There is NO
// DB CHECK behind this column, so this union is the only thing guarding the field
// (same idiom as the TicketStatus/TicketSource derived unions). `skipped` is a
// terminal status for inbound from a non-active partner (logged, never actioned).
export type InboundParseStatus = 'matched' | 'created' | 'quarantined' | 'failed' | 'ignored' | 'skipped';

// Inbound provider identity. The mailgun impl reports 'mailgun'; 'resend' is
// reserved for the planned second provider.
export type InboundProviderName = 'mailgun' | 'resend' | 'm365';

// A single sender-authentication verdict, normalized to lowercase. 'pass'/'fail'
// are the meaningful states; 'none'/'neutral'/'unknown' are all treated as NOT a
// pass. The provider reports these from SPF / DKIM / DMARC evaluation it already
// performed at the MX boundary — the API never re-runs DNS auth.
export type SenderAuthVerdict = 'pass' | 'fail' | 'neutral' | 'none' | 'unknown';

// Sender-authentication summary for the From domain (R4). The From header is
// spoofable, so identity/state actions (treating a sender as a known portal user,
// or threading a reply by ticket token) must gate on `verified`. `verified` is the
// derived trust decision: aligned SPF+DKIM pass, OR a DMARC pass. When the provider
// omits all verdicts, `verified` is false (fail closed) — mail is quarantined for
// human review, never auto-trusted and never hard-dropped.
export interface SenderAuth {
  spf: SenderAuthVerdict;
  dkim: SenderAuthVerdict;
  dmarc: SenderAuthVerdict;
  verified: boolean;
}

// Why a message ended up WITHOUT a usable provider sender-auth verdict, as opposed to a
// genuine DMARC fail. These are the SILENT mass-quarantine failure modes (a provider MX/host
// or payload-format change makes every inbound look unauthenticated). Set only when no real
// verdict could be read; absent on a normal pass/fail. Used by the dispatcher to enrich the
// quarantine audit reason and raise a Sentry warning, so the next recurrence of the apex-host
// bug is observable on day one instead of after users report missing tickets.
//   - 'headers-unparseable'  : a message-headers payload was present but not valid JSON array
//   - 'no-mailgun-authserv'  : no Mailgun-authoritative Authentication-Results header at all
export type SenderAuthDiagnostic = 'headers-unparseable' | 'no-mailgun-authserv';

export interface NormalizedInboundEmail {
  provider: InboundProviderName;
  providerMessageId: string;
  to: string;            // recipient → partner resolution
  /** When the feeder already knows the partner (e.g. it polled THAT partner's
   *  mailbox), skip recipient-based resolution. This is feeder-trusted, not
   *  derived from untrusted message content. */
  resolvedPartnerId?: string;
  from: string;          // sender (untrusted)
  fromName?: string;
  subject: string;
  text: string;          // plain body
  html?: string;         // retained raw, not rendered in v1
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  autoSubmitted?: string; // for loop-prevention (used in PR3)
  precedence?: string;
  // Sender-authentication verdicts for the From domain (R4). Absent => caller must
  // treat the sender as NOT verified (fail closed).
  senderAuth?: SenderAuth;
  // Set ONLY when the sender could not be authenticated because no usable verdict was
  // obtained (vs a genuine DMARC fail) — observability for the silent-quarantine failure
  // modes. Absent on a normal pass/fail. See SenderAuthDiagnostic.
  senderAuthDiagnostic?: SenderAuthDiagnostic;
  attachments: { filename: string; contentType: string; size: number }[]; // metadata only
  raw: Record<string, unknown>;
}

export interface InboundEmailProvider {
  readonly name: InboundProviderName;
  verify(req: HonoRequest): Promise<boolean>;
  parse(req: HonoRequest): Promise<NormalizedInboundEmail>;
}
