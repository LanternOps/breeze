import type { HonoRequest } from 'hono';

export interface NormalizedInboundEmail {
  provider: string;
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
  readonly name: string;
  verify(req: HonoRequest): Promise<boolean>;
  parse(req: HonoRequest): Promise<NormalizedInboundEmail>;
}
