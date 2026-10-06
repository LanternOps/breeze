import { describe, it, expect } from 'vitest';
import { extractForwardedSender, domainOf } from './forwardParse';

describe('extractForwardedSender', () => {
  it('parses a Gmail forwarded block', () => {
    const body = [
      'Can you look at this?',
      '',
      '---------- Forwarded message ---------',
      'From: Jane Client <jane@clientco.example>',
      'Date: Sun, Sep 20, 2026 at 1:00 PM',
      'Subject: Printer down',
      'To: Tech Person <tech@msp.example>',
      '',
      'Our printer stopped working.',
    ].join('\n');
    expect(extractForwardedSender(body)).toBe('jane@clientco.example');
  });

  it('does not treat an Apple Mail "Begin forwarded message" line as a marker (Gmail and Outlook markers only)', () => {
    const body = [
      'FYI',
      '',
      'Begin forwarded message:',
      '',
      'From: bob@othercustomer.example',
      'Subject: VPN issue',
      'Date: September 20, 2026',
      'To: help@msp.example',
    ].join('\n');
    expect(extractForwardedSender(body)).toBeNull();
  });

  it('parses an Outlook "-----Original Message-----" block', () => {
    const body = [
      'See below.',
      '',
      '-----Original Message-----',
      'From: "Sam Ops" <sam@vendor.example>',
      'Sent: Sunday, September 20, 2026 12:30 PM',
      'To: Tech Person',
      'Subject: Server reboot',
    ].join('\n');
    expect(extractForwardedSender(body)).toBe('sam@vendor.example');
  });

  it('ignores a marker-less Outlook-style header block (no forward marker line)', () => {
    const body = [
      'Please handle.',
      '',
      'From: Kim <kim@homebuilder.example>',
      'Sent: Sunday, September 20, 2026 11:00 AM',
      'To: Tech',
      'Subject: New laptop setup',
      '',
      'Need a laptop configured.',
    ].join('\n');
    expect(extractForwardedSender(body)).toBeNull();
  });

  it('treats a typed exact marker line plus header block like a forward (recognition is textual)', () => {
    const typed = [
      'Please file this for them.',
      '-----Original Message-----',
      'From: billing@customer-b.example',
      'Subject: invoice 1234',
    ].join('\n');
    expect(extractForwardedSender(typed)).toBe('billing@customer-b.example');
  });

  it('ignores From:/Sent:/Subject: lines typed or quoted in ordinary staff mail', () => {
    const typed = [
      'Hi team, the customer says their invoice came from this address:',
      'From: billing@customer-b.example',
      'Sent: yesterday',
      'Subject: invoice 1234',
      'Can someone check it?',
    ].join('\n');
    expect(extractForwardedSender(typed)).toBeNull();
    const quoted = [
      'Agreed, see their note below.',
      '',
      '> From: billing@customer-b.example',
      '> Sent: Monday, September 21, 2026 9:00 AM',
      '> Subject: Re: invoice',
      '> Please resend.',
    ].join('\n');
    expect(extractForwardedSender(quoted)).toBeNull();
  });

  it('requires the From: header block to start on the line right after the marker', () => {
    const body = [
      '---------- Forwarded message ---------',
      'Note from me: this is unrelated.',
      'From: billing@customer-b.example',
      'Date: today',
      'Subject: invoice',
    ].join('\n');
    expect(extractForwardedSender(body)).toBeNull();
  });

  it('returns null for a normal (non-forwarded) email', () => {
    expect(extractForwardedSender('Hey, can you call me about the invoice? Thanks.')).toBeNull();
  });

  it('returns null when a From: line has no corroborating Sent/Subject (not a forward)', () => {
    // A signature line mentioning "from" must not be treated as a forward header.
    expect(extractForwardedSender('Regards,\nfrom the team\nsomeone@example.com')).toBeNull();
  });

  it('ignores prose that merely mentions the original message (no header block)', () => {
    expect(extractForwardedSender('Please locate the original message\nFrom: billing@customer-b.example\nThanks')).toBeNull();
    expect(extractForwardedSender('See the forwarded message below.\n\nFrom: billing@customer-b.example')).toBeNull();
  });

  it('requires a Date/Sent or Subject header next to the From after a marker', () => {
    const body = ['---------- Forwarded message ---------', 'From: someone@customer-b.example', '', 'body'].join('\n');
    expect(extractForwardedSender(body)).toBeNull();
  });

  it('accepts only the exact Gmail and Outlook marker lines', () => {
    const block = (marker: string) => [marker, 'From: billing@customer-b.example', 'Date: today', 'Subject: invoice'].join('\n');
    expect(extractForwardedSender(block('---------- Forwarded message ---------'))).toBe('billing@customer-b.example');
    expect(extractForwardedSender(block('-----Original Message-----'))).toBe('billing@customer-b.example');
    for (const near of ['-- forwarded message --', '-- original message --', '----- Forwarded Message -----', '---Original Message---', '> -----Original Message-----', '  -----Original Message-----', '-----Original Message-----  ', ' ---------- Forwarded message ---------']) {
      expect(extractForwardedSender(block(near))).toBeNull();
    }
  });

  it('accepts only English From/Date/Sent/Subject headers in the block', () => {
    expect(extractForwardedSender(['-----Original Message-----', 'Von: client@mapped.example', 'Betreff: x'].join('\n'))).toBeNull();
    expect(extractForwardedSender(['-----Original Message-----', 'De: client@mapped.example', 'Objet: x'].join('\n'))).toBeNull();
    expect(extractForwardedSender(['-----Original Message-----', 'From: client@mapped.example', 'Gesendet: heute'].join('\n'))).toBeNull();
  });

  it('returns null for empty/undefined bodies', () => {
    expect(extractForwardedSender('')).toBeNull();
    expect(extractForwardedSender(null)).toBeNull();
    expect(extractForwardedSender(undefined)).toBeNull();
  });

  it('prefers the angle-bracket address over a bare one on the same line', () => {
    const body = [
      '---------- Forwarded message ---------',
      'From: reply-to-me@wrong.example Jane <jane@right.example>',
      'Date: today',
      'Subject: x',
    ].join('\n');
    // angle-bracket wins
    expect(extractForwardedSender(body)).toBe('jane@right.example');
  });
  it('picks the real mailbox (last angle) past a quoted display name', () => {
    const body = [
      '---------- Forwarded message ---------',
      'From: "Contact <wrong@clientb.example>" <real@clienta.example>',
      'Date: today',
      'Subject: x',
    ].join('\n');
    expect(extractForwardedSender(body)).toBe('real@clienta.example');
  });

  it('picks the real mailbox past a trailing parenthesized comment', () => {
    const body = [
      '---------- Forwarded message ---------',
      'From: Name <real@clienta.example> (backup <other@clientb.example>)',
      'Date: today',
      'Subject: x',
    ].join('\n');
    expect(extractForwardedSender(body)).toBe('real@clienta.example');
  });

  it('handles NESTED parenthesized comments', () => {
    const body = [
      '---------- Forwarded message ---------',
      'From: Name (team (old) <other@clientb.example>) <real@clienta.example>',
      'Date: today', 'Subject: x',
    ].join('\n');
    expect(extractForwardedSender(body)).toBe('real@clienta.example');
  });

  it('handles ESCAPED quotes inside a quoted display name', () => {
    const body = [
      '---------- Forwarded message ---------',
      'From: "Contact \\"<wrong@clientb.example>\\"" <real@clienta.example>',
      'Date: today', 'Subject: x',
    ].join('\n');
    expect(extractForwardedSender(body)).toBe('real@clienta.example');
  });

});

describe('domainOf', () => {
  it('extracts the domain', () => {
    expect(domainOf('jane@clientco.example')).toBe('clientco.example');
    expect(domainOf('Jane@Sub.Example.COM')).toBe('sub.example.com');
  });
  it('handles bad input', () => {
    expect(domainOf(null)).toBeNull();
    expect(domainOf('nope')).toBeNull();
    expect(domainOf('trailing@')).toBeNull();
  });
});
