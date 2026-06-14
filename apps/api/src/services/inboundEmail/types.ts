import type { HonoRequest } from 'hono';

// Terminal audit status written to ticket_email_inbound.parse_status. There is NO
// DB CHECK behind this column, so this union is the only thing guarding the field
// (same idiom as the TicketStatus/TicketSource derived unions). `skipped` is a
// terminal status for inbound from a non-active partner (logged, never actioned).
export type InboundParseStatus = 'matched' | 'created' | 'quarantined' | 'failed' | 'ignored' | 'skipped';

// Inbound provider identity. The mailgun impl reports 'mailgun'; 'resend' is
// reserved for the planned second provider.
export type InboundProviderName = 'mailgun' | 'resend';

export interface NormalizedInboundEmail {
  provider: InboundProviderName;
  providerMessageId: string;
  to: string;            // recipient → partner resolution
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
  attachments: { filename: string; contentType: string; size: number }[]; // metadata only
  raw: Record<string, unknown>;
}

export interface InboundEmailProvider {
  readonly name: InboundProviderName;
  verify(req: HonoRequest): Promise<boolean>;
  parse(req: HonoRequest): Promise<NormalizedInboundEmail>;
}
