import { describe, it, expect, vi, beforeEach } from 'vitest';

const coreRequest = vi.fn();
vi.mock('./api', () => ({ coreRequest: (...args: unknown[]) => coreRequest(...args) }));

import {
  addTicketComment,
  createTicket,
  allowedQuickStatuses,
  buildTicketListQuery,
  canTransition,
  changeTicketStatus,
  getTicket,
  getTickets,
  statusRequiresResolutionNote,
  SYSTEM_COMMENT_TYPES,
  TICKET_STATUS_TRANSITIONS,
} from './tickets';

beforeEach(() => {
  coreRequest.mockReset();
});

describe('buildTicketListQuery', () => {
  it('defaults to page 1 and does not send an assignee for "all"', () => {
    const q = new URLSearchParams(buildTicketListQuery({ assignee: 'all' }));
    expect(q.get('page')).toBe('1');
    expect(q.get('limit')).toBe('50');
    // The API treats any non-me/non-unassigned value as a user id, so sending
    // the literal "all" would filter to a nonexistent assignee and return [].
    expect(q.has('assignee')).toBe(false);
  });

  it('sends assignee=me only for the mine filter', () => {
    const q = new URLSearchParams(buildTicketListQuery({ assignee: 'me' }));
    expect(q.get('assignee')).toBe('me');
  });

  it('passes statusGroup through when present and omits it otherwise', () => {
    expect(new URLSearchParams(buildTicketListQuery({ statusGroup: 'closed' })).get('statusGroup'))
      .toBe('closed');
    expect(new URLSearchParams(buildTicketListQuery({})).has('statusGroup')).toBe(false);
  });
});

describe('getTickets', () => {
  it('returns pagination totals from the envelope', async () => {
    coreRequest.mockResolvedValue({
      data: [{ id: 't1' }],
      pagination: { page: 2, limit: 25, total: 87 },
    });
    const page = await getTickets({ page: 2, limit: 25 });
    expect(page.tickets).toHaveLength(1);
    expect(page.total).toBe(87);
    expect(page.page).toBe(2);
    expect(page.limit).toBe(25);
  });

  it('tolerates a missing pagination block and a non-array data field', async () => {
    coreRequest.mockResolvedValue({ data: undefined });
    const page = await getTickets({});
    expect(page.tickets).toEqual([]);
    expect(page.total).toBe(0);
  });
});

describe('getTicket', () => {
  it('always yields an array for comments even when the field is absent', async () => {
    coreRequest.mockResolvedValue({ data: { id: 't1', subject: 'x' } });
    const ticket = await getTicket('t1');
    expect(ticket.comments).toEqual([]);
  });
});

describe('addTicketComment', () => {
  it('posts content and isPublic to the comments endpoint', async () => {
    coreRequest.mockResolvedValue({ data: { id: 'c1' } });
    await addTicketComment('t1', 'hello', false);
    const [path, options] = coreRequest.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/tickets/t1/comments');
    expect(options.method).toBe('POST');
    expect(JSON.parse(String(options.body))).toEqual({ content: 'hello', isPublic: false });
  });

  it('omits attachmentIds entirely when there are none', async () => {
    coreRequest.mockResolvedValue({ data: { id: 'c1' } });
    await addTicketComment('t1', 'hello', true, []);
    const [, options] = coreRequest.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body))).not.toHaveProperty('attachmentIds');
  });

  it('sends attachmentIds when the comment carries attachments', async () => {
    coreRequest.mockResolvedValue({ data: { id: 'c1' } });
    await addTicketComment('t1', 'see photo', true, ['att-1', 'att-2']);
    const [, options] = coreRequest.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toEqual({
      content: 'see photo', isPublic: true, attachmentIds: ['att-1', 'att-2'],
    });
  });

  it('allows an empty body when attachments carry the comment', async () => {
    // addTicketCommentSchema refines content-or-attachments, so a photo-only
    // comment is legal server-side and the client must not block it.
    coreRequest.mockResolvedValue({ data: { id: 'c1' } });
    await addTicketComment('t1', '', true, ['att-1']);
    const [, options] = coreRequest.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toEqual({
      content: '', isPublic: true, attachmentIds: ['att-1'],
    });
  });

  it('returns the attachments the server claimed onto the comment', async () => {
    coreRequest.mockResolvedValue({
      data: { id: 'c1', attachments: [{ id: 'att-1', contentType: 'image/jpeg' }] },
    });
    const created = await addTicketComment('t1', 'see photo', true, ['att-1']);
    expect(created.attachments).toEqual([{ id: 'att-1', contentType: 'image/jpeg' }]);
  });
});

describe('changeTicketStatus', () => {
  it('returns the ticket the server responds with, not the requested status', async () => {
    // Custom-status mapping can make the applied status differ from the ask,
    // so callers must use the returned row rather than echoing their request.
    coreRequest.mockResolvedValue({ data: { id: 't1', status: 'closed' } });
    const updated = await changeTicketStatus('t1', 'resolved', 'note');
    expect(updated.status).toBe('closed');
  });

  it('includes resolutionNote when resolving', async () => {
    coreRequest.mockResolvedValue({ data: {} });
    await changeTicketStatus('t1', 'resolved', 'fixed the thing');
    const [path, options] = coreRequest.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/tickets/t1/status');
    expect(JSON.parse(String(options.body))).toEqual({
      status: 'resolved',
      resolutionNote: 'fixed the thing',
    });
  });

  it('omits resolutionNote on non-resolving transitions', async () => {
    coreRequest.mockResolvedValue({ data: {} });
    await changeTicketStatus('t1', 'pending', 'ignored');
    const [, options] = coreRequest.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toEqual({ status: 'pending' });
  });
});

describe('statusRequiresResolutionNote', () => {
  it('is true only for resolved — the one transition the API rejects without a note', () => {
    expect(statusRequiresResolutionNote('resolved')).toBe(true);
    for (const s of ['new', 'open', 'pending', 'on_hold', 'closed'] as const) {
      expect(statusRequiresResolutionNote(s)).toBe(false);
    }
  });
});

describe('TICKET_STATUS_TRANSITIONS / allowedQuickStatuses', () => {
  it('matches the server table exactly (ticketService.ts TICKET_STATUS_TRANSITIONS)', () => {
    expect(TICKET_STATUS_TRANSITIONS).toEqual({
      new: ['open', 'pending', 'on_hold', 'resolved', 'closed'],
      open: ['pending', 'on_hold', 'resolved', 'closed'],
      pending: ['open', 'on_hold', 'resolved', 'closed'],
      on_hold: ['open', 'pending', 'resolved', 'closed'],
      resolved: ['open', 'closed'],
      closed: ['open'],
    });
  });

  it('never offers a transition the API would reject with 409', () => {
    const candidates = ['open', 'pending', 'resolved'] as const;
    // A resolved ticket may reopen to open or go to closed — never to pending.
    expect(allowedQuickStatuses('resolved', candidates)).toEqual(['open']);
    // A closed ticket may only reopen.
    expect(allowedQuickStatuses('closed', candidates)).toEqual(['open']);
  });

  it('excludes the ticket current status so a no-op chip is never rendered', () => {
    expect(allowedQuickStatuses('open', ['open', 'pending', 'resolved'])).toEqual([
      'pending',
      'resolved',
    ]);
  });

  it('canTransition agrees with the table in both directions', () => {
    expect(canTransition('closed', 'open')).toBe(true);
    expect(canTransition('closed', 'resolved')).toBe(false);
    expect(canTransition('resolved', 'pending')).toBe(false);
    expect(canTransition('new', 'closed')).toBe(true);
  });
});

describe('SYSTEM_COMMENT_TYPES', () => {
  it('covers exactly the activity kinds the web feed treats as system entries', () => {
    expect([...SYSTEM_COMMENT_TYPES].sort()).toEqual(
      ['assignment', 'status_change', 'system', 'time_entry'].sort()
    );
    expect(SYSTEM_COMMENT_TYPES.has('comment')).toBe(false);
    expect(SYSTEM_COMMENT_TYPES.has('internal')).toBe(false);
  });
});

describe('createTicket', () => {
  it('posts the body to /tickets and returns the created ticket', async () => {
    coreRequest.mockResolvedValue({ data: { id: 'new-1', internalNumber: 'T-2026-0004', subject: 'x' } });
    const created = await createTicket({ orgId: 'o1', subject: 'x', priority: 'normal' });
    expect(coreRequest).toHaveBeenCalledWith('/tickets', {
      method: 'POST',
      body: JSON.stringify({ orgId: 'o1', subject: 'x', priority: 'normal' }),
    });
    expect(created).toMatchObject({ id: 'new-1', internalNumber: 'T-2026-0004' });
  });
});
