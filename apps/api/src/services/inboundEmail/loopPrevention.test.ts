import { describe, it, expect } from 'vitest';
import { autoresponseSuppressionReason } from './loopPrevention';
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
