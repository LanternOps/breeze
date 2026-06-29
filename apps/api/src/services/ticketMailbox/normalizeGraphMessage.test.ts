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
    { name: 'Authentication-Results', value: 'spf=pass; dkim=pass; dmarc=pass action=none' },
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
});
