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

  describe('body text (#6687)', () => {
    const longPara = 'The printer on the second floor has been jamming since Monday morning. '.repeat(6).trim();

    it('derives the FULL text from an HTML body, not the 255-char bodyPreview, keeping line breaks', () => {
      const html = `<html><head><title>ignored title</title><style>p { color: red; }</style></head><body>`
        + `<p>Hi   team,</p>\n<p>${longPara}</p><div>Line one<br>Line two<br/>Line&nbsp;three</div>`
        + `<ul><li>first &amp; foremost</li><li>a &lt;b&gt; tag</li></ul><p>Thanks</p></body></html>`;
      const n = normalizeGraphMessage(
        { ...msg, body: { contentType: 'html', content: html }, bodyPreview: longPara.slice(0, 255) },
        'partner-9', 'support@a.com',
      );
      expect(n.text).toBe(
        `Hi team,\n\n${longPara}\n\nLine one\nLine two\nLine three\n\nfirst & foremost\na <b> tag\n\nThanks`,
      );
      expect(n.text.length).toBeGreaterThan(255);
      // html is carried through untouched.
      expect(n.html).toBe(html);
    });

    it('renders Gmail-style div-per-line and Outlook MsoNormal paragraphs readably', () => {
      const gmail = '<div dir="ltr"><div>Hello</div><div>The VPN is down.</div><div><br></div><div>Bob</div></div>';
      expect(normalizeGraphMessage({ ...msg, body: { contentType: 'html', content: gmail } }, 'p', 'support@a.com').text)
        .toBe('Hello\nThe VPN is down.\nBob');
      const outlook = '<div class="WordSection1"><p class="MsoNormal">Hi,<o:p></o:p></p>'
        + '<p class="MsoNormal"><o:p>&nbsp;</o:p></p><p class="MsoNormal">Outlook crashes.<o:p></o:p></p></div>';
      expect(normalizeGraphMessage({ ...msg, body: { contentType: 'html', content: outlook } }, 'p', 'support@a.com').text)
        .toBe('Hi,\n\nOutlook crashes.');
    });

    const toText = (content: string) =>
      normalizeGraphMessage({ ...msg, body: { contentType: 'html', content } }, 'p', 'support@a.com').text;

    it('separates table cells and drops script contents', () => {
      expect(toText('<table><tr><td>Server</td><td>PROD01</td></tr><tr><th>Age</th><td>30</td></tr></table>'))
        .toBe('Server PROD01\nAge 30');
      expect(toText('<p>before</p><script>alert("x")</script><p>after</p>')).toBe('before\n\nafter');
    });

    it('does not treat entity-encoded U+0001/U+0002 in the body as break markers', () => {
      expect(toText('<p>Hello&#x2;World&#1;!</p><p>after</p>')).toBe('HelloWorld!\n\nafter');
    });

    it('stays fast on unclosed-tag soup (no regex backtracking across the body)', () => {
      const start = Date.now();
      toText('<p '.repeat(80_000));
      toText(`<div class="x ${'<p '.repeat(80_000)}`);
      expect(Date.now() - start).toBeLessThan(3_000);
    });

    it('falls back to bodyPreview only when the HTML strips to empty', () => {
      const n = normalizeGraphMessage(
        { ...msg, body: { contentType: 'html', content: '<p> </p><img src="x.png">' }, bodyPreview: 'preview text' },
        'partner-9', 'support@a.com',
      );
      expect(n.text).toBe('preview text');
    });

    it('does not use bodyPreview when the HTML has real text', () => {
      const n = normalizeGraphMessage(
        { ...msg, body: { contentType: 'html', content: '<p>full body</p>' }, bodyPreview: 'preview' },
        'partner-9', 'support@a.com',
      );
      expect(n.text).toBe('full body');
    });

    it('leaves a text/plain body unchanged', () => {
      const content = '  Line one\n\n\n<not a tag>  &amp; raw\n';
      const n = normalizeGraphMessage(
        { ...msg, body: { contentType: 'text', content }, bodyPreview: 'preview' },
        'partner-9', 'support@a.com',
      );
      expect(n.text).toBe(content);
      expect(n.html).toBeUndefined();
    });

    it('clamps pathologically large HTML-derived text to the ticket description limit', () => {
      const html = `<p>${'x'.repeat(60_000)}</p>`;
      const n = normalizeGraphMessage(
        { ...msg, body: { contentType: 'html', content: html } }, 'partner-9', 'support@a.com',
      );
      expect(n.text.length).toBe(50_000);
    });
  });
});
