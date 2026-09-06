import { describe, it, expect } from 'vitest';
import {
  buildCreateTicketBody,
  canSubmitTicket,
  DEFAULT_TICKET_PRIORITY,
  preselectOrg,
  TICKET_PRIORITY_OPTIONS,
} from './createTicketForm';

describe('buildCreateTicketBody', () => {
  it('trims the subject, omits an empty description and always sends the priority', () => {
    expect(
      buildCreateTicketBody({ orgId: 'o1', subject: '  Printer offline ', description: '   ', priority: 'high' })
    ).toEqual({ ok: true, body: { orgId: 'o1', subject: 'Printer offline', priority: 'high' } });
  });

  it('keeps a trimmed description when present', () => {
    const r = buildCreateTicketBody({ orgId: 'o1', subject: 'x', description: ' Paper jam on tray 2 ', priority: 'normal' });
    expect(r).toEqual({
      ok: true,
      body: { orgId: 'o1', subject: 'x', description: 'Paper jam on tray 2', priority: 'normal' },
    });
  });

  it('refuses without an organisation, before checking the subject', () => {
    expect(buildCreateTicketBody({ orgId: null, subject: '', description: '', priority: 'normal' })).toEqual({
      ok: false,
      reason: 'org',
    });
  });

  it('refuses a blank subject (the API rejects it too, but the form should not round-trip)', () => {
    expect(buildCreateTicketBody({ orgId: 'o1', subject: '   ', description: 'd', priority: 'normal' })).toEqual({
      ok: false,
      reason: 'subject',
    });
  });

  it('caps the subject at the API limit of 255 characters', () => {
    const r = buildCreateTicketBody({ orgId: 'o1', subject: 'a'.repeat(256), description: '', priority: 'low' });
    expect(r).toEqual({ ok: false, reason: 'subject' });
  });
});

describe('canSubmitTicket', () => {
  it('is false while busy even when the form is complete', () => {
    expect(canSubmitTicket({ orgId: 'o1', subject: 'x', busy: true })).toBe(false);
    expect(canSubmitTicket({ orgId: 'o1', subject: 'x', busy: false })).toBe(true);
    expect(canSubmitTicket({ orgId: null, subject: 'x', busy: false })).toBe(false);
    expect(canSubmitTicket({ orgId: 'o1', subject: '  ', busy: false })).toBe(false);
  });
});

describe('preselectOrg', () => {
  const orgs = [
    { id: 'a', name: 'Acme' },
    { id: 'b', name: 'Bolt' },
  ];
  it('prefers the signed-in user\'s own organisation when it is in the list', () => {
    expect(preselectOrg(orgs, 'b')).toBe('b');
  });
  it('picks the only organisation when there is exactly one', () => {
    expect(preselectOrg([orgs[0]], undefined)).toBe('a');
  });
  it('leaves the choice to the user otherwise', () => {
    expect(preselectOrg(orgs, undefined)).toBeNull();
    expect(preselectOrg(orgs, 'zzz')).toBeNull();
    expect(preselectOrg([], undefined)).toBeNull();
  });
});

describe('priority options', () => {
  it('offers every API priority in escalation order and defaults to normal', () => {
    expect(TICKET_PRIORITY_OPTIONS).toEqual(['low', 'normal', 'high', 'urgent']);
    expect(DEFAULT_TICKET_PRIORITY).toBe('normal');
  });
});
