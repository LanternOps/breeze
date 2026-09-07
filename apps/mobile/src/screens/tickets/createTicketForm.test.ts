import { describe, it, expect } from 'vitest';
import {
  assigneeDisplayName,
  assigneeOptions,
  buildCreateTicketBody,
  canSubmitTicket,
  defaultAssigneeId,
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

  it('includes assigneeId when set', () => {
    const r = buildCreateTicketBody({
      orgId: 'o1',
      subject: 'x',
      description: '',
      priority: 'normal',
      assigneeId: 'u1',
    });
    expect(r).toEqual({ ok: true, body: { orgId: 'o1', subject: 'x', priority: 'normal', assigneeId: 'u1' } });
  });

  it('omits assigneeId when null or absent (Unassigned)', () => {
    const withNull = buildCreateTicketBody({
      orgId: 'o1',
      subject: 'x',
      description: '',
      priority: 'normal',
      assigneeId: null,
    });
    expect(withNull).toEqual({ ok: true, body: { orgId: 'o1', subject: 'x', priority: 'normal' } });

    const withoutField = buildCreateTicketBody({ orgId: 'o1', subject: 'x', description: '', priority: 'normal' });
    expect(withoutField).toEqual({ ok: true, body: { orgId: 'o1', subject: 'x', priority: 'normal' } });
  });

  it('keeps a trimmed description when present', () => {
    const r = buildCreateTicketBody({ orgId: 'o1', subject: 'x', description: ' Paper jam on tray 2 ', priority: 'normal' });
    expect(r).toEqual({
      ok: true,
      body: { orgId: 'o1', subject: 'x', description: 'Paper jam on tray 2', priority: 'normal' },
    });
  });

  it('refuses without an organization, before checking the subject', () => {
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
  it('prefers the signed-in user\'s own organization when it is in the list', () => {
    expect(preselectOrg(orgs, 'b')).toBe('b');
  });
  it('picks the only organization when there is exactly one', () => {
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

describe('assigneeDisplayName', () => {
  it('uses the name when present', () => {
    expect(assigneeDisplayName({ name: 'Casey Tech', email: 'casey@example.com' })).toBe('Casey Tech');
  });

  it('falls back to email when name is blank or missing', () => {
    expect(assigneeDisplayName({ name: '  ', email: 'casey@example.com' })).toBe('casey@example.com');
    expect(assigneeDisplayName({ name: null, email: 'casey@example.com' })).toBe('casey@example.com');
  });
});

describe('defaultAssigneeId', () => {
  it('defaults to the signed-in user', () => {
    expect(defaultAssigneeId({ id: 'me-1' })).toBe('me-1');
  });

  it('is null when signed out', () => {
    expect(defaultAssigneeId(null)).toBeNull();
    expect(defaultAssigneeId(undefined)).toBeNull();
  });
});

describe('assigneeOptions', () => {
  const me = { id: 'me-1', name: 'Casey Tech', email: 'casey@example.com' };
  const staff = [
    { id: 'u2', name: 'Bailey Ops', email: 'bailey@example.com' },
    { id: 'u3', name: null, email: 'alex@example.com' },
  ];

  it('leads with Unassigned, then the signed-in user labeled "(you)", then staff sorted by display name', () => {
    expect(assigneeOptions(staff, me)).toEqual([
      { id: null, label: 'Unassigned' },
      { id: 'me-1', label: 'Casey Tech (you)' },
      { id: 'u3', label: 'alex@example.com' },
      { id: 'u2', label: 'Bailey Ops' },
    ]);
  });

  it('dedupes the signed-in user out of the fetched staff list', () => {
    const withMeDuplicated = [...staff, { id: 'me-1', name: 'Casey Tech', email: 'casey@example.com' }];
    const options = assigneeOptions(withMeDuplicated, me);
    expect(options.filter((o) => o.id === 'me-1')).toHaveLength(1);
  });

  it('degrades to Unassigned + you when the staff fetch failed (empty list)', () => {
    expect(assigneeOptions([], me)).toEqual([
      { id: null, label: 'Unassigned' },
      { id: 'me-1', label: 'Casey Tech (you)' },
    ]);
  });

  it('offers only Unassigned when signed out', () => {
    expect(assigneeOptions(staff, null)).toEqual([
      { id: null, label: 'Unassigned' },
      { id: 'u3', label: 'alex@example.com' },
      { id: 'u2', label: 'Bailey Ops' },
    ]);
  });
});
