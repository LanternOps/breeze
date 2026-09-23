import { describe, it, expect } from 'vitest';
import { normalizeGraphMessage } from './normalizeGraphMessage';
import type { GraphMessage } from './graphMailClient';

const msg: GraphMessage = {
  id: 'AAA-graph-id',
  internetMessageId: '<abc@mail.x.com>',
  subject: 'Printer down [T-2026-0007]',
  from: { emailAddress: { address: 'Cust@X.com', name: 'Cust' } },
  toRecipients: [{ emailAddress: { address: 'support@a.com' } }],
  conversationId: 'conv-1',
  body: { contentType: 'html', content: '<p>help</p>' },
  bodyPreview: 'help',
  hasAttachments: false,
  internetMessageHeaders: [
    { name: 'In-Reply-To', value: '<prev@mail.x.com>' },
    { name: 'References', value: '<root@mail.x.com> <prev@mail.x.com>' },
    // authserv-id 'a.com' matches the support mailbox domain → trusted (EOP stamp).
    { name: 'Authentication-Results', value: 'a.com; spf=pass; dkim=pass; dmarc=pass action=none' },
  ],
};

describe('normalizeGraphMessage', () => {
  it('maps core fields, provider, and pre-resolved partner', () => {
    const n = normalizeGraphMessage(msg, 'partner-9', 'support@a.com');
    expect(n.provider).toBe('m365');
    expect(n.providerMessageId).toBe('AAA-graph-id');
    expect(n.resolvedPartnerId).toBe('partner-9');
    expect(n.to).toBe('support@a.com');
    expect(n.from).toBe('cust@x.com');
    expect(n.subject).toBe('Printer down [T-2026-0007]');
    expect(n.messageId).toBe('<abc@mail.x.com>');
    expect(n.inReplyTo).toBe('<prev@mail.x.com>');
    expect(n.references).toEqual(['<root@mail.x.com>', '<prev@mail.x.com>']);
    expect(n.html).toBe('<p>help</p>');
  });

  it('carries Graph hasAttachments through so the inbound worker knows to fetch them (#6688)', () => {
    expect(normalizeGraphMessage({ ...msg, hasAttachments: true }, 'p', 'support@a.com').hasAttachments).toBe(true);
    expect(normalizeGraphMessage({ ...msg, hasAttachments: false }, 'p', 'support@a.com').hasAttachments).toBe(false);
    // Metadata only across the queue: no bytes are ever put into the BullMQ payload.
    expect(normalizeGraphMessage({ ...msg, hasAttachments: true }, 'p', 'support@a.com').attachments).toEqual([]);
  });

  it('preserves CC participants in the inbound audit metadata', () => {
    const ccRecipients = [{ emailAddress: { address: 'colleague@x.com' } }];
    expect(normalizeGraphMessage({ ...msg, ccRecipients }, 'partner-9', 'support@a.com').raw.ccRecipients).toEqual(ccRecipients);
  });

  it('extracts a full sender-auth verdict (dmarc=pass -> verified)', () => {
    const n = normalizeGraphMessage(msg, 'partner-9', 'support@a.com');
    expect(n.senderAuth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass', verified: true });
  });

  it('fails closed when Authentication-Results is missing (full object, verified=false)', () => {
    const n = normalizeGraphMessage({ ...msg, internetMessageHeaders: [] }, 'partner-9', 'support@a.com');
    expect(n.senderAuth).toBeDefined();
    expect(n.senderAuth?.verified).toBe(false);
    expect(n.senderAuth?.dmarc).toBe('unknown');
  });

  it('does NOT trust a sender-forged Authentication-Results (authserv-id mismatch → verified=false)', () => {
    const forged: GraphMessage = {
      ...msg,
      internetMessageHeaders: [
        // A header the sender injected into their own message; authserv-id is NOT
        // the mailbox domain, so it must be ignored (spoof defense).
        { name: 'Authentication-Results', value: 'attacker.test; spf=pass; dkim=pass; dmarc=pass' },
      ],
    };
    const n = normalizeGraphMessage(forged, 'partner-9', 'support@a.com');
    expect(n.senderAuth?.verified).toBe(false);
    expect(n.senderAuth?.dmarc).toBe('unknown');
  });

  it('trusts the genuine EOP header even when a forged one is also present', () => {
    const both: GraphMessage = {
      ...msg,
      internetMessageHeaders: [
        { name: 'Authentication-Results', value: 'attacker.test; dmarc=pass' },          // forged
        { name: 'Authentication-Results', value: 'a.com; spf=pass; dkim=pass; dmarc=pass' }, // EOP
      ],
    };
    const n = normalizeGraphMessage(both, 'partner-9', 'support@a.com');
    expect(n.senderAuth?.verified).toBe(true);
  });
});
