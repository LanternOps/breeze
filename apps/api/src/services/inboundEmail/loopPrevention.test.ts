import { describe, it, expect } from 'vitest';
import { autoresponseSuppressionReason, outboundMessageIdPattern, ownOutboundReason } from './loopPrevention';
import type { NormalizedInboundEmail } from './types';

function email(over: Partial<NormalizedInboundEmail>): NormalizedInboundEmail {
  return {
    provider: 'mailgun', providerMessageId: 'm', to: 'acme@tickets.example.com',
    from: 'jane@customer.com', subject: 's', text: 't', attachments: [], raw: {},
    ...over,
  };
}

describe('autoresponseSuppressionReason', () => {
  it('allows a normal human sender (returns null)', () => {
    expect(autoresponseSuppressionReason(email({}), 'tickets.example.com')).toBeNull();
  });

  it('suppresses when Auto-Submitted is present and not "no"', () => {
    expect(autoresponseSuppressionReason(email({ autoSubmitted: 'auto-replied' }), 'tickets.example.com')).toBe('auto-submitted');
    expect(autoresponseSuppressionReason(email({ autoSubmitted: 'no' }), 'tickets.example.com')).toBeNull();
  });

  it('suppresses on Precedence bulk/list/junk', () => {
    for (const p of ['bulk', 'list', 'junk', 'Bulk']) {
      expect(autoresponseSuppressionReason(email({ precedence: p }), 'tickets.example.com')).toBe('precedence');
    }
  });

  it('suppresses no-reply / mailer-daemon / postmaster local-parts', () => {
    expect(autoresponseSuppressionReason(email({ from: 'no-reply@x.com' }), 'tickets.example.com')).toBe('system-sender');
    expect(autoresponseSuppressionReason(email({ from: 'noreply@x.com' }), 'tickets.example.com')).toBe('system-sender');
    expect(autoresponseSuppressionReason(email({ from: 'MAILER-DAEMON@x.com' }), 'tickets.example.com')).toBe('system-sender');
    expect(autoresponseSuppressionReason(email({ from: 'postmaster@x.com' }), 'tickets.example.com')).toBe('system-sender');
  });

  it('suppresses self-loop (sender on our own inbound domain)', () => {
    expect(autoresponseSuppressionReason(email({ from: 'acme@tickets.example.com' }), 'tickets.example.com')).toBe('self-domain');
  });

  it('does not suppress when inbound domain is unconfigured', () => {
    expect(autoresponseSuppressionReason(email({ from: 'acme@tickets.example.com' }), undefined)).toBeNull();
  });
});

const INBOUND_DOMAIN = 'tickets.example.com';

describe('outboundMessageIdPattern (derived from outboundThreading.ts)', () => {
  // The generator emits exactly two shapes (services/inboundEmail/outboundThreading.ts):
  //   ticketThreadAnchor:  `<ticket-${ticketId}@${d}>`
  //   commentMessageId:    `<ticket-${ticketId}-${commentId}@${d}>`
  // so the pattern is `<ticket-` + anything that is not @ / < / > / space,
  // then the inbound domain.
  const pattern = outboundMessageIdPattern(INBOUND_DOMAIN);

  it('matches both generator shapes', () => {
    expect(pattern.test('<ticket-11111111-1111-4111-8111-111111111111@tickets.example.com>')).toBe(true);
    expect(pattern.test('<ticket-11111111-1111-4111-8111-111111111111-c0ffee00-0000-4000-8000-000000000001@tickets.example.com>')).toBe(true);
  });

  it('is case-insensitive on the domain, as Message-IDs are in practice', () => {
    expect(pattern.test('<TICKET-abc@TICKETS.EXAMPLE.COM>')).toBe(true);
  });

  it('does not match another domain, another prefix, or a lookalike suffix', () => {
    expect(pattern.test('<ticket-abc@tickets.evil.example>')).toBe(false);
    expect(pattern.test('<quote-abc@tickets.example.com>')).toBe(false);
    expect(pattern.test('<ticket-abc@x.tickets.example.com>')).toBe(false);
    expect(pattern.test('<abc@tickets.example.com>')).toBe(false);
  });

  it('escapes the dots in the domain so they are not wildcards', () => {
    expect(outboundMessageIdPattern('tickets.example.com').test('<ticket-a@ticketsXexampleXcom>')).toBe(false);
  });
});

describe('ownOutboundReason (spec §8.5)', () => {
  it('recognises the outbound marker', () => {
    expect(ownOutboundReason(email({ outboundMarker: '1' }), INBOUND_DOMAIN)).toBe('outbound-marker');
    // Any non-empty value counts: forging it only gets the forger's own mail
    // ignored, so there is nothing to gain by being strict about the value.
    expect(ownOutboundReason(email({ outboundMarker: 'yes' }), INBOUND_DOMAIN)).toBe('outbound-marker');
    expect(ownOutboundReason(email({ outboundMarker: '  ' }), INBOUND_DOMAIN)).toBeNull();
  });

  it('recognises our own Message-ID', () => {
    expect(ownOutboundReason(
      email({ messageId: '<ticket-t1-c1@tickets.example.com>' }), INBOUND_DOMAIN,
    )).toBe('own-message-id');
  });

  it('leaves a customer reply alone — its In-Reply-To is ours, its Message-ID is not', () => {
    expect(ownOutboundReason(email({
      messageId: '<CAF=abc@mail.example.com>',
      inReplyTo: '<ticket-t1@tickets.example.com>',
      references: ['<ticket-t1@tickets.example.com>'],
    }), INBOUND_DOMAIN)).toBeNull();
  });

  // Spec §8.5, explicitly: inbound mail is NOT suppressed by sending domain or
  // identity address. With a root sending domain every technician's address is
  // on it, and a technician may legitimately write from the shared mailbox.
  it('processes a technician writing FROM the partner identity address', () => {
    expect(ownOutboundReason(
      email({ from: 'support@mail.acme.test', messageId: '<abc@mail.acme.test>' }), INBOUND_DOMAIN,
    )).toBeNull();
  });

  it('is inert when no inbound domain is configured, except for the marker', () => {
    expect(ownOutboundReason(email({ messageId: '<ticket-t1@tickets.example.com>' }), null)).toBeNull();
    expect(ownOutboundReason(email({ outboundMarker: '1' }), null)).toBe('outbound-marker');
  });

  it('returns null for ordinary inbound mail', () => {
    expect(ownOutboundReason(email({}), INBOUND_DOMAIN)).toBeNull();
  });
});
