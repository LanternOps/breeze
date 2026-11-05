import { describe, it, expect } from 'vitest';
import { normalizeGraphMessage } from './normalizeGraphMessage';
import { MAX_BODY_BYTES } from './normalizeGmailMessage';
import type { GraphMessage } from './graphMailClient';
import type { ArcEvaluation } from './arcSeal';

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

  it('never exposes forwardScanText (staff-forward routing is Gmail-mailbox only)', () => {
    expect(normalizeGraphMessage(msg, 'p', 'support@a.com').forwardScanText).toBeUndefined();
    expect(normalizeGraphMessage({ ...msg, body: { contentType: 'text', content: 'help' } }, 'p', 'support@a.com').forwardScanText).toBeUndefined();
  });

  it('carries Graph hasAttachments through so the inbound worker knows to fetch them (#6688)', () => {
    expect(normalizeGraphMessage({ ...msg, hasAttachments: true }, 'p', 'support@a.com').hasAttachments).toBe(true);
    expect(normalizeGraphMessage({ ...msg, hasAttachments: false }, 'p', 'support@a.com').hasAttachments).toBe(false);
    // Metadata only across the queue: no bytes are ever put into the BullMQ payload.
    expect(normalizeGraphMessage({ ...msg, hasAttachments: true }, 'p', 'support@a.com').attachments).toEqual([]);
  });

  // #8299: the review queue's Convert rebuilds the ticket from `raw`, so the
  // Graph row must carry the body and sender name under the neutral keys.
  it('persists the body text and sender name on raw for the review-queue Convert', () => {
    const raw = normalizeGraphMessage(msg, 'partner-9', 'support@a.com').raw;
    expect(raw.bodyText).toBe('help');
    expect(raw.fromName).toBe('Cust');
  });

  it('stores a null fromName when Graph gives no display name', () => {
    const raw = normalizeGraphMessage({ ...msg, from: { emailAddress: { address: 'cust@x.com' } } }, 'partner-9', 'support@a.com').raw;
    expect(raw.fromName).toBeNull();
  });

  it('drops U+0000 from the persisted body and name (jsonb rejects it)', () => {
    const raw = normalizeGraphMessage({
      ...msg,
      from: { emailAddress: { address: 'cust@x.com', name: 'Cu\u0000st' } },
      body: { contentType: 'text', content: 'printer\u0000 down' },
    }, 'partner-9', 'support@a.com').raw;
    expect(raw.bodyText).toBe('printer down');
    expect(raw.fromName).toBe('Cust');
    expect(JSON.stringify(raw)).not.toContain('\\u0000');
  });

  it('caps the persisted body at MAX_BODY_BYTES of UTF-8, like the Gmail path', () => {
    const big = 'é'.repeat(MAX_BODY_BYTES); // 2 bytes each: twice the limit
    const raw = normalizeGraphMessage({ ...msg, body: { contentType: 'text', content: big } }, 'partner-9', 'support@a.com').raw;
    const stored = raw.bodyText as string;
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(stored.length).toBe(MAX_BODY_BYTES / 2);
    expect(stored.endsWith('\uFFFD')).toBe(false);
  });

  it('cuts a multi-byte character at the limit without leaving a replacement character', () => {
    const odd = 'a' + '€'.repeat(Math.ceil(MAX_BODY_BYTES / 3)); // 1 + 3n bytes, boundary mid-character
    const raw = normalizeGraphMessage({ ...msg, body: { contentType: 'text', content: odd } }, 'partner-9', 'support@a.com').raw;
    const stored = raw.bodyText as string;
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(stored.includes('\uFFFD')).toBe(false);
    expect(stored.startsWith('a€')).toBe(true);
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

  it('ignores a verdict hidden in an RFC comment (shared parser strips comments first)', () => {
    const smuggled: GraphMessage = {
      ...msg,
      internetMessageHeaders: [
        // The genuine header says dmarc=fail; a comment in the spf clause carries a fake pass.
        { name: 'Authentication-Results', value: 'a.com; spf=pass (dmarc=pass); dkim=pass; dmarc=fail' },
      ],
    };
    const n = normalizeGraphMessage(smuggled, 'partner-9', 'support@a.com');
    expect(n.senderAuth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'fail', verified: false });
  });

  // #8299 item 1: mail a user sends from inside the connected tenant to its own
  // support mailbox carries no DMARC pass the mailbox can trust (EOP stamps
  // `mx.microsoft.com`, DKIM/DMARC are `none`). Exchange's own organization
  // headers are the intra-tenant signal. Header shape is from the reporter's
  // Graph read of five real intra-tenant messages (issue comment, 2026-10-09).
  describe('Exchange intra-tenant sender auth (#8299)', () => {
    const INTERNAL_HEADERS: GraphMessage['internetMessageHeaders'] = [
      { name: 'Authentication-Results', value: 'mx.microsoft.com 1; dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=a.com;' },
      { name: 'X-MS-Exchange-Organization-AuthAs', value: 'Internal' },
      { name: 'X-MS-Exchange-Organization-AuthMechanism', value: '04' },
      { name: 'X-MS-Exchange-Organization-AuthSource', value: 'SJ0P221MB0722.NAMP221.PROD.OUTLOOK.COM' },
      { name: 'X-MS-Exchange-Organization-MessageDirectionality', value: 'Originating' },
      { name: 'X-MS-Exchange-Organization-SCL', value: '1' },
      { name: 'X-MS-Exchange-CrossTenant-AuthAs', value: 'Internal' },
      { name: 'X-MS-Exchange-CrossTenant-FromEntityHeader', value: 'Hosted' },
      { name: 'X-Forefront-Antispam-Report', value: 'CIP:255.255.255.255;CTRY:;LANG:en;SCL:1;SRV:;IPV:NLI;SFV:NSPM;H:x;PTR:;CAT:NONE;SFS:;DIR:INT;' },
    ];
    const internal = (headers: GraphMessage['internetMessageHeaders']): GraphMessage => ({
      ...msg,
      from: { emailAddress: { address: 'staff@a.com', name: 'Staff' } },
      internetMessageHeaders: headers,
    });
    const without = (name: string) => INTERNAL_HEADERS!.filter((h) => h.name !== name);

    it('verifies intra-tenant mail when AuthAs=Internal and MessageDirectionality=Originating', () => {
      const n = normalizeGraphMessage(internal(INTERNAL_HEADERS), 'partner-9', 'support@a.com');
      expect(n.senderAuth).toEqual({
        spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', verified: true, source: 'exchange-internal',
      });
      // Recorded on the inbound audit row so this path is distinguishable from DMARC.
      expect(n.raw.senderAuthSource).toBe('exchange-internal');
    });

    it('does not mark DMARC-verified or unverified mail with an audit source', () => {
      expect(normalizeGraphMessage(msg, 'partner-9', 'support@a.com').raw).not.toHaveProperty('senderAuthSource');
      expect(normalizeGraphMessage(internal([]), 'partner-9', 'support@a.com').raw).not.toHaveProperty('senderAuthSource');
    });

    it('tolerates surrounding whitespace on the header values', () => {
      const n = normalizeGraphMessage(internal([
        { name: 'X-MS-Exchange-Organization-AuthAs', value: ' Internal ' },
        { name: 'X-MS-Exchange-Organization-MessageDirectionality', value: 'Originating\t' },
      ]), 'partner-9', 'support@a.com');
      expect(n.senderAuth?.verified).toBe(true);
    });

    it('verifies over a trusted dmarc=none verdict, keeping the real verdicts', () => {
      const n = normalizeGraphMessage(internal([
        { name: 'Authentication-Results', value: 'a.com; spf=none; dkim=none; dmarc=none' },
        { name: 'X-MS-Exchange-Organization-AuthAs', value: 'Internal' },
        { name: 'X-MS-Exchange-Organization-MessageDirectionality', value: 'Originating' },
      ]), 'partner-9', 'support@a.com');
      expect(n.senderAuth).toEqual({
        spf: 'none', dkim: 'none', dmarc: 'none', verified: true, source: 'exchange-internal',
      });
    });

    it('stays unverified when Graph returns no headers at all', () => {
      const n = normalizeGraphMessage({ ...msg, internetMessageHeaders: undefined }, 'partner-9', 'support@a.com');
      expect(n.senderAuth?.verified).toBe(false);
    });

    it('matches the header names case-insensitively, as Graph may return any casing', () => {
      const n = normalizeGraphMessage(internal([
        { name: 'x-ms-exchange-organization-authas', value: 'Internal' },
        { name: 'X-MS-EXCHANGE-ORGANIZATION-MESSAGEDIRECTIONALITY', value: 'Originating' },
      ]), 'partner-9', 'support@a.com');
      expect(n.senderAuth?.verified).toBe(true);
      expect(n.senderAuth?.source).toBe('exchange-internal');
    });

    it('stays unverified when AuthAs is missing', () => {
      const n = normalizeGraphMessage(internal(without('X-MS-Exchange-Organization-AuthAs')), 'partner-9', 'support@a.com');
      expect(n.senderAuth?.verified).toBe(false);
      expect(n.senderAuth?.source).toBeUndefined();
    });

    it('stays unverified when MessageDirectionality is missing', () => {
      const n = normalizeGraphMessage(internal(without('X-MS-Exchange-Organization-MessageDirectionality')), 'partner-9', 'support@a.com');
      expect(n.senderAuth?.verified).toBe(false);
      expect(n.senderAuth?.source).toBeUndefined();
    });

    it('stays unverified for external mail (AuthAs=Anonymous, MessageDirectionality=Incoming)', () => {
      const n = normalizeGraphMessage(internal([
        { name: 'X-MS-Exchange-Organization-AuthAs', value: 'Anonymous' },
        { name: 'X-MS-Exchange-Organization-MessageDirectionality', value: 'Incoming' },
        // The SENDER's tenant stamps CrossTenant-AuthAs from its own point of view,
        // so another Microsoft 365 tenant's mail can say Internal here. Not trusted.
        { name: 'X-MS-Exchange-CrossTenant-AuthAs', value: 'Internal' },
      ]), 'partner-9', 'support@a.com');
      expect(n.senderAuth?.verified).toBe(false);
    });

    it('does not trust the CrossTenant-AuthAs header alone', () => {
      const n = normalizeGraphMessage(internal([
        { name: 'X-MS-Exchange-CrossTenant-AuthAs', value: 'Internal' },
        { name: 'X-MS-Exchange-Organization-MessageDirectionality', value: 'Originating' },
      ]), 'partner-9', 'support@a.com');
      expect(n.senderAuth?.verified).toBe(false);
    });

    it('requires the exact values (no prefix, substring, or case variants)', () => {
      for (const [authAs, dir] of [
        ['internal', 'Originating'],
        ['Internal', 'originating'],
        ['InternalX', 'Originating'],
        ['Internal', 'Originating, Incoming'],
        ['', 'Originating'],
      ]) {
        const n = normalizeGraphMessage(internal([
          { name: 'X-MS-Exchange-Organization-AuthAs', value: authAs! },
          { name: 'X-MS-Exchange-Organization-MessageDirectionality', value: dir! },
        ]), 'partner-9', 'support@a.com');
        expect(n.senderAuth?.verified, `${authAs} / ${dir}`).toBe(false);
      }
    });

    it('stays unverified when a header appears twice with conflicting values', () => {
      const n = normalizeGraphMessage(internal([
        { name: 'X-MS-Exchange-Organization-AuthAs', value: 'Anonymous' },
        { name: 'X-MS-Exchange-Organization-AuthAs', value: 'Internal' },
        { name: 'X-MS-Exchange-Organization-MessageDirectionality', value: 'Originating' },
      ]), 'partner-9', 'support@a.com');
      expect(n.senderAuth?.verified).toBe(false);
    });

    it('does not override a trusted DMARC fail', () => {
      const n = normalizeGraphMessage(internal([
        { name: 'Authentication-Results', value: 'a.com; spf=fail; dkim=fail; dmarc=fail' },
        { name: 'X-MS-Exchange-Organization-AuthAs', value: 'Internal' },
        { name: 'X-MS-Exchange-Organization-MessageDirectionality', value: 'Originating' },
      ]), 'partner-9', 'support@a.com');
      expect(n.senderAuth).toEqual({ spf: 'fail', dkim: 'fail', dmarc: 'fail', verified: false });
    });

    it('keeps a trusted DMARC pass as the source of truth (no exchange-internal source)', () => {
      const n = normalizeGraphMessage(internal([
        { name: 'Authentication-Results', value: 'a.com; spf=pass; dkim=pass; dmarc=pass' },
        { name: 'X-MS-Exchange-Organization-AuthAs', value: 'Internal' },
        { name: 'X-MS-Exchange-Organization-MessageDirectionality', value: 'Originating' },
      ]), 'partner-9', 'support@a.com');
      expect(n.senderAuth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass', verified: true });
    });
  });

  describe('external sender auth: Exchange stamp and trusted ARC sealers (#10862)', () => {
    const AUTH_AS = 'X-MS-Exchange-Organization-AuthAs';
    const DIRECTION = 'X-MS-Exchange-Organization-MessageDirectionality';
    const external = [
      { name: AUTH_AS, value: 'Anonymous' },
      { name: DIRECTION, value: 'Incoming' },
    ];
    const partnerConnector = [
      { name: AUTH_AS, value: 'Partner' },
      { name: DIRECTION, value: 'Incoming' },
    ];
    const stamp = (value: string) => ({ name: 'Authentication-Results', value });
    const eopPass = stamp('mx.microsoft.com 1; spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=x.com; dkim=pass (signature was verified) header.d=x.com; dmarc=pass action=none header.from=x.com; compauth=pass reason=100');
    // The issue's real shape: Exchange judging mail relayed by an inline gateway.
    const eopFail = stamp('mx.microsoft.com 1; spf=softfail (sender IP is 192.0.2.1) smtp.mailfrom=mg.x.com; dkim=fail (body hash did not verify) header.d=mg.x.com; dmarc=fail action=none header.from=x.com');
    const avananResults = 'mx.avanan.net; arc=none; dkim=pass header.d=mg.x.com; spf=pass smtp.mailfrom=mg.x.com';
    const originalResults = { name: 'Authentication-Results-Original', value: avananResults };
    const verifiedArc = (authResults = avananResults): ArcEvaluation => ({ status: 'verified', sealer: 'avanan.net', instance: 1, authResults });

    const run = (headers: { name: string; value: string }[], arc?: ArcEvaluation, from = 'Cust@X.com') =>
      normalizeGraphMessage(
        { ...msg, from: { emailAddress: { address: from } }, internetMessageHeaders: headers },
        'partner-9', 'support@a.com', arc ? { arc } : undefined,
      );

    describe('Exchange Online stamp', () => {
      it('verifies external mail on the tenant-proven mx.microsoft.com stamp', () => {
        const n = run([...external, eopPass]);
        expect(n.senderAuth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass', verified: true, source: 'exchange-online' });
        expect(n.raw).toMatchObject({ senderAuthSource: 'exchange-online' });
        expect(n.senderAuthConsulted).toBeUndefined();
      });

      it('accepts the tenant *.mail.protection.outlook.com authserv-id', () => {
        const n = run([...external, stamp('contoso-com.mail.protection.outlook.com; dmarc=pass action=none header.from=x.com')]);
        expect(n.senderAuth?.verified).toBe(true);
      });

      it('does not accept a look-alike of the protection host', () => {
        for (const id of ['a.b.mail.protection.outlook.com', 'mail.protection.outlook.com', 'contoso.mail.protection.outlook.com.evil.test', 'mx.microsoft.com.evil.test']) {
          expect(run([...external, stamp(`${id}; dmarc=pass header.from=x.com`)]).senderAuth?.verified).toBe(false);
        }
      });

      it('keeps the issue fixture quarantined: softfail/fail stays unverified and names the source', () => {
        const n = run([...external, eopFail]);
        expect(n.senderAuth).toEqual({ spf: 'fail', dkim: 'fail', dmarc: 'fail', verified: false });
        expect(n.senderAuthConsulted).toBe('Exchange Online stamp: dmarc=fail');
      });

      it('does not verify dmarc=none or a stamp with no DMARC verdict (compauth alone is not enough)', () => {
        expect(run([...external, stamp('mx.microsoft.com 1; spf=pass smtp.mailfrom=x.com; dmarc=none action=none header.from=x.com; compauth=pass reason=109')]).senderAuth?.verified).toBe(false);
        expect(run([...external, stamp('mx.microsoft.com 1; spf=pass smtp.mailfrom=x.com; compauth=pass reason=100')]).senderAuth?.verified).toBe(false);
      });

      it('FORGED: mx.microsoft.com dmarc=pass with no tenant org headers stays unverified', () => {
        const n = run([eopPass]);
        expect(n.senderAuth?.verified).toBe(false);
        expect(n.senderAuth?.source).toBeUndefined();
        expect(n.senderAuthConsulted).toBe('no Exchange tenant proof on this message');
      });

      it('FORGED: org headers that conflict or are partial are not proof', () => {
        expect(run([...external, { name: AUTH_AS, value: 'Internal' }, eopPass]).senderAuth?.verified).toBe(false);
        expect(run([{ name: AUTH_AS, value: 'Anonymous' }, eopPass]).senderAuth?.verified).toBe(false);
        expect(run([{ name: DIRECTION, value: 'Incoming' }, eopPass]).senderAuth?.verified).toBe(false);
      });

      it('FORGED: a sender line beside the genuine stamp makes it ambiguous, in either order', () => {
        const forged = stamp('mx.microsoft.com 1; dmarc=pass header.from=x.com');
        for (const headers of [[...external, forged, eopFail], [...external, eopFail, forged]]) {
          const n = run(headers);
          expect(n.senderAuth?.verified).toBe(false);
          // Neither line is echoed as the verdict: we cannot tell which is genuine.
          expect(n.senderAuth?.dmarc).toBe('unknown');
          expect(n.senderAuthConsulted).toBe('Exchange Online stamp ambiguous: 2 Authentication-Results headers');
        }
      });

      it('FORGED: a pass for another domain does not verify this From (header.from binding)', () => {
        const n = run([...external, stamp('mx.microsoft.com 1; dmarc=pass action=none header.from=attacker.test')]);
        expect(n.senderAuth?.verified).toBe(false);
        expect(n.senderAuthConsulted).toBe('Exchange Online stamp: DMARC verdict is not for the From domain');
      });

      it('FORGED: a conflicting duplicate header.from never matches, in either order', () => {
        for (const props of ['header.from=x.com header.from=attacker.test', 'header.from=attacker.test header.from=x.com']) {
          expect(run([...external, stamp(`mx.microsoft.com 1; dmarc=pass ${props}`)]).senderAuth?.verified).toBe(false);
        }
      });

      it('needs every DMARC clause to pass', () => {
        expect(run([...external, stamp('mx.microsoft.com 1; dmarc=pass header.from=x.com; dmarc=fail header.from=x.com')]).senderAuth?.verified).toBe(false);
      });

      it('does not read an authserv-id hidden in a comment', () => {
        expect(run([...external, stamp('evil.test (mx.microsoft.com); dmarc=pass header.from=x.com')]).senderAuth?.verified).toBe(false);
      });

      it('fails closed on an unparseable From address', () => {
        for (const from of ['nobody', 'a@b@x.com']) {
          expect(run([...external, stamp('mx.microsoft.com 1; dmarc=pass header.from=x.com')], undefined, from).senderAuth?.verified).toBe(false);
        }
      });

      it('FORGED: a conflicting duplicate header.from never matches, in either order', () => {
        for (const props of ['header.from=x.com header.from=attacker.test', 'header.from=attacker.test header.from=x.com']) {
          expect(run([...external, stamp(`mx.microsoft.com 1; dmarc=pass ${props}`)]).senderAuth?.verified).toBe(false);
        }
      });

      it('needs every DMARC clause to pass', () => {
        expect(run([...external, stamp('mx.microsoft.com 1; dmarc=pass header.from=x.com; dmarc=fail header.from=x.com')]).senderAuth?.verified).toBe(false);
      });

      it('does not read an authserv-id hidden in a comment', () => {
        expect(run([...external, stamp('evil.test (mx.microsoft.com); dmarc=pass header.from=x.com')]).senderAuth?.verified).toBe(false);
      });

      it('fails closed on an unparseable From address', () => {
        for (const from of ['nobody', 'a@b@x.com']) {
          expect(run([...external, stamp('mx.microsoft.com 1; dmarc=pass header.from=x.com')], undefined, from).senderAuth?.verified).toBe(false);
        }
      });

      it('requires header.from on the DMARC clause', () => {
        expect(run([...external, stamp('mx.microsoft.com 1; dmarc=pass action=none')]).senderAuth?.verified).toBe(false);
      });

      it('ignores header.from inside a comment', () => {
        expect(run([...external, stamp('mx.microsoft.com 1; dmarc=pass (header.from=x.com) header.from=attacker.test')]).senderAuth?.verified).toBe(false);
      });

      it('does not read the stamp on connector mail (the documented external shape is Anonymous)', () => {
        expect(run([...partnerConnector, eopPass]).senderAuth?.verified).toBe(false);
      });

      it('leaves intra-tenant mail on the #8299 path', () => {
        const internal = [{ name: AUTH_AS, value: 'Internal' }, { name: DIRECTION, value: 'Originating' }];
        const n = run([...internal, stamp('mx.microsoft.com 1; dmarc=pass header.from=x.com')]);
        expect(n.senderAuth?.source).toBe('exchange-internal');
      });
    });

    describe('mailbox-domain stamp on mail Exchange marks as external', () => {
      it('is not read: a mailbox-domain pass stays unverified', () => {
        const n = run([...external, stamp('a.com; spf=pass; dkim=pass; dmarc=pass')]);
        expect(n.senderAuth?.verified).toBe(false);
        expect(n.senderAuth?.dmarc).toBe('unknown');
        expect(n.senderAuthConsulted).toBe('Authentication-Results from an untrusted authserv-id ignored');
      });

      it('cannot override a genuine Exchange fail', () => {
        expect(run([...external, stamp('a.com; dmarc=pass'), eopFail]).senderAuth?.verified).toBe(false);
      });
    });

    describe('trusted ARC sealer', () => {
      it('verifies gateway-relayed mail on the sealed result even though Exchange failed it', () => {
        const n = run([...external, eopFail, originalResults], verifiedArc());
        expect(n.senderAuth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'unknown', verified: true, source: 'trusted-arc-sealer' });
        expect(n.raw).toMatchObject({ senderAuthSource: 'trusted-arc-sealer' });
      });

      it('works on connector-attributed mail too, since the seal is the proof', () => {
        expect(run([...partnerConnector, eopFail], verifiedArc()).senderAuth?.verified).toBe(true);
      });

      it('verifies a sealed dmarc=pass bound to the From domain', () => {
        const n = run([...external, eopFail], verifiedArc('mx.gw.test; dmarc=pass header.from=x.com'));
        expect(n.senderAuth).toMatchObject({ dmarc: 'pass', verified: true, source: 'trusted-arc-sealer' });
      });

      it('a sealed dmarc=fail vetoes, even with aligned DKIM and a passing Exchange stamp', () => {
        const n = run([...external, eopPass], verifiedArc('mx.gw.test; dkim=pass header.d=x.com; dmarc=fail header.from=x.com'));
        expect(n.senderAuth?.verified).toBe(false);
        expect(n.senderAuthConsulted).toBe('trusted ARC sealer avanan.net: dmarc=fail');
      });

      it('REPLAY: a genuine sealed verdict for another domain does not verify this From', () => {
        for (const results of [
          'mx.gw.test; dmarc=pass header.from=attacker.test',
          'mx.gw.test; dkim=pass header.d=attacker.test; spf=pass smtp.mailfrom=attacker.test',
          'mx.gw.test; dkim=pass header.d=com',
        ]) {
          const n = run([...external, eopFail], verifiedArc(results));
          expect(n.senderAuth?.verified).toBe(false);
          expect(n.senderAuthConsulted).toContain('trusted ARC sealer avanan.net: verdict is not for the From domain');
        }
      });

      it('a bare sealed dmarc=pass, with no domain to bind, does not verify', () => {
        for (const results of ['mx.gw.test; dmarc=pass', 'mx.gw.test; dmarc=pass; dkim=pass header.d=attacker.test']) {
          const n = run([...external, eopFail], verifiedArc(results));
          expect(n.senderAuth?.verified).toBe(false);
          expect(n.senderAuthConsulted).toContain('trusted ARC sealer avanan.net: verdict is not for the From domain');
        }
      });

      it('FORGED: a conflicting duplicate header.from in the sealed verdict never matches', () => {
        for (const props of ['header.from=x.com header.from=attacker.test', 'header.from=attacker.test header.from=x.com']) {
          expect(run([...external, eopFail], verifiedArc(`mx.gw.test; dmarc=pass ${props}`)).senderAuth?.verified).toBe(false);
        }
      });

      it('does not align anything when the From address is unparseable', () => {
        for (const from of ['nobody', 'a@b@x.com']) {
          expect(run([...external], verifiedArc('mx.gw.test; dkim=pass header.d=localhost; spf=pass smtp.mailfrom=b@x.com'), from).senderAuth?.verified).toBe(false);
        }
      });

      it('a bare sealed dmarc=pass, with no domain to bind, does not verify', () => {
        for (const results of ['mx.gw.test; dmarc=pass', 'mx.gw.test; dmarc=pass; dkim=pass header.d=attacker.test']) {
          const n = run([...external, eopFail], verifiedArc(results));
          expect(n.senderAuth?.verified).toBe(false);
          expect(n.senderAuthConsulted).toContain('trusted ARC sealer avanan.net: verdict is not for the From domain');
        }
      });

      it('FORGED: a conflicting duplicate header.from in the sealed verdict never matches', () => {
        for (const props of ['header.from=x.com header.from=attacker.test', 'header.from=attacker.test header.from=x.com']) {
          expect(run([...external, eopFail], verifiedArc(`mx.gw.test; dmarc=pass ${props}`)).senderAuth?.verified).toBe(false);
        }
      });

      it('does not align anything when the From address is unparseable', () => {
        for (const from of ['nobody', 'a@b@x.com']) {
          expect(run([...external], verifiedArc('mx.gw.test; dkim=pass header.d=localhost; spf=pass smtp.mailfrom=b@x.com'), from).senderAuth?.verified).toBe(false);
        }
      });

      it('a sealed dmarc=pass naming another domain is not rescued by aligned DKIM', () => {
        expect(run([...external, eopFail], verifiedArc('mx.gw.test; dkim=pass header.d=x.com; dmarc=pass header.from=attacker.test')).senderAuth?.verified).toBe(false);
      });

      it('aligns on the organizational domain, so a different name under a public suffix does not count', () => {
        const at = (domain: string) => `a@${domain}`;
        expect(run([...external], verifiedArc('mx.gw.test; dkim=pass header.d=mail.x.co.uk'), at('y.x.co.uk')).senderAuth?.verified).toBe(true);
        expect(run([...external], verifiedArc('mx.gw.test; dkim=pass header.d=attacker.co.uk'), at('x.co.uk')).senderAuth?.verified).toBe(false);
      });

      it('reads spf smtp.mailfrom in address form', () => {
        expect(run([...external], verifiedArc('mx.gw.test; spf=pass smtp.mailfrom=bounce@mail.x.com')).senderAuth?.verified).toBe(true);
      });

      it('ignores a verified seal when the message has no tenant proof', () => {
        expect(run([eopFail], verifiedArc()).senderAuth?.verified).toBe(false);
      });

      it('falls back to a passing Exchange stamp when the sealed result is inconclusive', () => {
        const n = run([...external, eopPass], verifiedArc('mx.gw.test; arc=none'));
        expect(n.senderAuth).toMatchObject({ verified: true, source: 'exchange-online' });
      });

      it('FORGED: an invalid seal is not a pass and the reason names the sealer', () => {
        const n = run([...external, eopFail], { status: 'invalid', sealer: 'avanan.net', reason: 'signature' });
        expect(n.senderAuth?.verified).toBe(false);
        expect(n.senderAuthConsulted).toBe('trusted ARC sealer avanan.net: seal did not verify (signature); Exchange Online stamp: dmarc=fail');
      });

      it('names a DNS outage and the no-trusted-seal case', () => {
        expect(run([...external, eopFail], { status: 'dns-unavailable', sealer: 'avanan.net', retryable: true }).senderAuthConsulted)
          .toBe('trusted ARC sealer avanan.net: key lookup failed; Exchange Online stamp: dmarc=fail');
        expect(run([...external, eopFail], { status: 'no-trusted-seal' }).senderAuthConsulted)
          .toBe('no seal from a trusted ARC sealer; Exchange Online stamp: dmarc=fail');
      });
    });

    describe('Authentication-Results-Original', () => {
      it('is never a pass by itself, because a sender can write it', () => {
        expect(run([...external, originalResults]).senderAuth?.verified).toBe(false);
        expect(run([...partnerConnector, originalResults]).senderAuth?.verified).toBe(false);
        expect(run([...external, { name: 'Authentication-Results-Original', value: 'mx.avanan.net; dmarc=pass header.from=x.com' }]).senderAuth?.verified).toBe(false);
      });
    });

    it('with no sealer configured a gateway-relayed message stays quarantined on the Exchange verdict', () => {
      const n = run([...external, eopFail, originalResults]);
      expect(n.senderAuth?.verified).toBe(false);
      expect(n.senderAuthConsulted).toBe('Exchange Online stamp: dmarc=fail');
    });

    it('names a missing stamp', () => {
      expect(run([...external]).senderAuthConsulted).toBe('no Exchange Online stamp');
    });
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
