import { describe, it, expect } from 'vitest';
import {
  normalizeSendingDomain,
  senderLocalPartSchema,
  senderDisplayNameSchema,
  createSendingDomainSchema,
  upsertSenderIdentitySchema,
  PARTNER_MAIL_STREAMS,
  SENDING_DOMAIN_STATUSES,
  SENDING_DOMAIN_STATUS_REASONS,
  RESERVED_SENDER_LOCAL_PARTS,
  type SendingDomainRejection
} from './sendingDomains';
import type { SendingDomainDto, SenderIdentityDto } from '../types/sendingDomains';

describe('normalizeSendingDomain — accepted', () => {
  const cases: Array<[string, string]> = [
    ['acme.com', 'acme.com'],
    ['  ACME.com  ', 'acme.com'],
    ['Mail.Acme.Com', 'mail.acme.com'],
    ['acme.com.', 'acme.com'],
    ['acme.com...', 'acme.com'],
    ['a.co', 'a.co'],
    ['deep.sub.domain.acme.co.uk', 'deep.sub.domain.acme.co.uk'],
    ['xn--exmple-cua.com', 'xn--exmple-cua.com'],
    ['exämple.com', 'xn--exmple-cua.com'],
    ['ACME-mail.com', 'acme-mail.com'],
    ['a1.b2.example', 'a1.b2.example'],
    [`${'a'.repeat(63)}.com`, `${'a'.repeat(63)}.com`]
  ];
  it.each(cases)('normalizes %s -> %s', (input, expected) => {
    expect(normalizeSendingDomain(input)).toEqual({ ok: true, domain: expected });
  });
});

describe('normalizeSendingDomain — rejected', () => {
  const cases: Array<[string, SendingDomainRejection]> = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['.', 'empty'],
    ['https://acme.com', 'scheme'],
    ['http://acme.com', 'scheme'],
    ['//acme.com', 'scheme'],
    ['acme.com/mail', 'path'],
    ['acme.com?x=1', 'path'],
    ['acme.com#frag', 'path'],
    ['acme.com:587', 'port'],
    ['user@acme.com', 'at_sign'],
    ['*.acme.com', 'wildcard'],
    ['192.0.2.10', 'ip_literal'],
    ['255.255.255.255', 'ip_literal'],
    // A bracketed IPv6 literal is an ADDRESS, not a port mistake — classified
    // before the colon rule so the message names the real problem.
    ['[2001:db8::1]', 'ip_literal'],
    ['[::1]', 'ip_literal'],
    ['localhost', 'too_few_labels'],
    ['acme', 'too_few_labels'],
    ['acme..com', 'label_length'],
    ['.acme.com', 'label_length'],
    [`${'a'.repeat(64)}.com`, 'label_length'],
    ['-acme.com', 'label_charset'],
    ['acme-.com', 'label_charset'],
    ['ac me.com', 'label_charset'],
    ['acme_mail.com', 'label_charset'],
    [`${Array.from({ length: 5 }, () => 'a'.repeat(50)).join('.')}.com`, 'too_long'],
    ['acme.123', 'numeric_tld'],
    ['acme.0', 'numeric_tld'],
    // Malformed punycode: `xn--` with an undecodable payload. The WHATWG host
    // parser applies UTS-46 and throws, which is the one path that yields
    // idn_invalid — previously the only reason with no case covering it.
    ['xn--a.com', 'idn_invalid'],
    ['xn--0.com', 'idn_invalid']
  ];
  it.each(cases)('rejects %s with %s', (input, reason) => {
    expect(normalizeSendingDomain(input)).toEqual({ ok: false, reason });
  });

  it('classifies an IPv6 literal as ip_literal, never as a port problem', () => {
    // The bracket test runs before the colon test precisely so these do not
    // report `port`, which would send the operator hunting for a ":587".
    for (const literal of ['[::]', '[2001:db8::1]', '[fe80::1%25eth0]']) {
      expect(normalizeSendingDomain(literal), literal).toEqual({ ok: false, reason: 'ip_literal' });
    }
    // A real host:port is still a port problem.
    expect(normalizeSendingDomain('acme.com:587')).toEqual({ ok: false, reason: 'port' });
  });
});

describe('senderLocalPartSchema', () => {
  const accepted = ['support', 'billing', 'notifications', 'help-desk', 'a', 'a.b', 'a+b', 'a_b', 'x1', 'a'.repeat(64)];
  it.each(accepted)('accepts %s', (v) => {
    expect(senderLocalPartSchema.parse(v)).toBe(v.toLowerCase());
  });
  it('lowercases and trims', () => {
    expect(senderLocalPartSchema.parse('  Support  ')).toBe('support');
  });
  const rejected = ['', '.support', 'support.', '-support', 'support-', 'sup..port', 'sup port', 'sup@port', 'a'.repeat(65), 'ü'];
  it.each(rejected)('rejects %s', (v) => {
    expect(senderLocalPartSchema.safeParse(v).success).toBe(false);
  });
  it.each(RESERVED_SENDER_LOCAL_PARTS)('refuses the reserved local part %s', (v) => {
    expect(senderLocalPartSchema.safeParse(v).success).toBe(false);
  });
});

describe('senderDisplayNameSchema', () => {
  it('strips header-breaking characters', () => {
    expect(senderDisplayNameSchema.parse('Acme\r\nBcc: evil')).toBe('Acme Bcc: evil');
  });
  it('still refuses a CRLF-injected header that carries an address — the strip runs BEFORE the @ check', () => {
    expect(senderDisplayNameSchema.safeParse('Acme\r\nBcc: evil@x.com').success).toBe(false);
  });
  it('collapses whitespace and trims', () => {
    expect(senderDisplayNameSchema.parse('  Acme   MSP  ')).toBe('Acme MSP');
  });
  it('accepts a plain name', () => {
    expect(senderDisplayNameSchema.parse('Acme MSP Support')).toBe('Acme MSP Support');
  });
  const rejected = [
    '',
    '   ',
    '"<>\\',
    'billing@acme.com',
    'Acme <billing@acme.com>',
    'Click https://evil.example',
    'a'.repeat(79)
  ];
  it.each(rejected)('rejects %s', (v) => {
    expect(senderDisplayNameSchema.safeParse(v).success).toBe(false);
  });
});

describe('createSendingDomainSchema', () => {
  it('normalizes on parse', () => {
    expect(createSendingDomainSchema.parse({ domain: '  ACME.com. ' })).toEqual({ domain: 'acme.com' });
  });
  it('rejects a structurally invalid domain', () => {
    expect(createSendingDomainSchema.safeParse({ domain: 'https://acme.com' }).success).toBe(false);
  });
  it('is strict', () => {
    expect(createSendingDomainSchema.safeParse({ domain: 'acme.com', partnerId: 'x' }).success).toBe(false);
  });
});

describe('upsertSenderIdentitySchema', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';
  it('accepts the minimal body', () => {
    expect(upsertSenderIdentitySchema.parse({ sendingDomainId: uuid, localPart: 'Support' }))
      .toEqual({ sendingDomainId: uuid, localPart: 'support' });
  });
  it('accepts an explicit null displayName and replyTo', () => {
    expect(upsertSenderIdentitySchema.parse({ sendingDomainId: uuid, localPart: 'billing', displayName: null, replyTo: null }))
      .toEqual({ sendingDomainId: uuid, localPart: 'billing', displayName: null, replyTo: null });
  });
  it('rejects a non-uuid domain id', () => {
    expect(upsertSenderIdentitySchema.safeParse({ sendingDomainId: 'nope', localPart: 'support' }).success).toBe(false);
  });
  it('rejects a non-email replyTo', () => {
    expect(upsertSenderIdentitySchema.safeParse({ sendingDomainId: uuid, localPart: 'support', replyTo: 'nope' }).success).toBe(false);
  });
  it('rejects a stream field — the stream comes from the route path, never the body', () => {
    expect(upsertSenderIdentitySchema.safeParse({ sendingDomainId: uuid, localPart: 'support', stream: 'support' }).success).toBe(false);
  });
});

describe('constant sets', () => {
  it('pins the status set the migration CHECK allows', () => {
    expect([...SENDING_DOMAIN_STATUSES]).toEqual([
      'provisioning', 'pending', 'verified', 'at_risk', 'failed', 'suspended', 'removing'
    ]);
  });
  it('pins the status reason set the migration CHECK allows', () => {
    expect([...SENDING_DOMAIN_STATUS_REASONS]).toEqual([
      'provider_conflict', 'provider_rejected', 'quota_exhausted', 'dns_not_detected',
      'dns_removed', 'platform_suspended', 'abuse_auto', 'failed_expired', 'user_removed',
      'partner_released'
    ]);
  });
  it('pins the stream set W01 PartnerMailStream declares', () => {
    expect([...PARTNER_MAIL_STREAMS]).toEqual(['support', 'billing', 'general']);
  });
});

describe('DTO shape W05 is built against', () => {
  // A runtime fixture typed as the DTO: an omitted or wrongly-nullable field is
  // a compile error, and the assertions below keep the fields W05 depends on
  // from quietly becoming optional later.
  const domainDto: SendingDomainDto = {
    id: '11111111-2222-4333-8444-555555555555',
    domain: 'acme.com',
    provider: 'resend',
    status: 'failed',
    statusReason: 'dns_not_detected',
    statusChangedAt: '2026-09-17T10:00:00.000Z',
    dnsRecords: [],
    verifiedAt: null,
    lastCheckedAt: '2026-09-17T09:00:00.000Z',
    lastTestAt: null,
    lastTestStatus: null,
    lastTestError: null,
    lastSendError: null,
    lastSendErrorAt: null,
    providerManaged: true,
    createdAt: '2026-09-15T10:00:00.000Z'
  };

  const identityDto: SenderIdentityDto = {
    id: '66666666-7777-8888-9999-000000000000',
    stream: 'support',
    sendingDomainId: domainDto.id,
    domain: 'acme.com',
    localPart: 'support',
    displayName: 'Acme MSP Support',
    replyTo: null,
    fromAddress: 'support@acme.com',
    updatedAt: '2026-09-17T10:00:00.000Z'
  };

  it('statusChangedAt is a REQUIRED ISO string — W05 computes the 72 h retry window on a failed row from it', () => {
    expect(typeof domainDto.statusChangedAt).toBe('string');
    expect(Number.isNaN(Date.parse(domainDto.statusChangedAt))).toBe(false);
    // Required, so it cannot be narrowed to include null/undefined.
    const required: string = domainDto.statusChangedAt;
    expect(required).toBe('2026-09-17T10:00:00.000Z');
  });

  it('SenderIdentityDto.domain and .fromAddress are REQUIRED — the identity card renders the From without re-joining', () => {
    const domain: string = identityDto.domain;
    const fromAddress: string = identityDto.fromAddress;
    expect(domain).toBe('acme.com');
    expect(fromAddress).toBe(`${identityDto.localPart}@${identityDto.domain}`);
  });
});
