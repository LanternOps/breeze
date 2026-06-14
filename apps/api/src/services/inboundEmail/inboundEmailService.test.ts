import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock harness. The db mock captures inserts/updates and serves canned select
// rows, keyed per-table via a `__t` marker on each schema mock. Query builders
// are chainable thenables so any of insert().values().returning(),
// update().set().where(), select().from().where().limit(),
// select().from().innerJoin().where().limit() resolve to the configured rows.
// ---------------------------------------------------------------------------
const { state } = vi.hoisted(() => ({
  state: {
    // canned select results, keyed by table marker
    selectRows: {} as Record<string, unknown[]>,
    // captured writes
    inserts: [] as { table: string; values: Record<string, unknown> }[],
    updates: [] as { table: string; set: Record<string, unknown> }[],
    // id to hand back from comment insert .returning()
    insertedCommentId: 'c-1' as string
  }
}));

function tableName(tbl: unknown): string {
  return (tbl as { __t?: string })?.__t ?? 'unknown';
}

vi.mock('../../db', () => {
  // select(cols).from(table).where().limit() and .innerJoin().where().limit()
  function makeSelect() {
    let resolvedTable = 'unknown';
    const chain: Record<string, unknown> = {
      from(tbl: unknown) {
        resolvedTable = tableName(tbl);
        return chain;
      },
      innerJoin(_tbl: unknown, _on: unknown) {
        return chain;
      },
      where(_w: unknown) {
        return chain;
      },
      limit(_n: number) {
        return Promise.resolve(state.selectRows[resolvedTable] ?? []);
      }
    };
    return chain;
  }
  function makeInsert(tbl: unknown) {
    const table = tableName(tbl);
    return {
      values(values: Record<string, unknown>) {
        state.inserts.push({ table, values });
        return {
          returning() {
            return Promise.resolve([{ id: state.insertedCommentId }]);
          }
        };
      }
    };
  }
  function makeUpdate(tbl: unknown) {
    const table = tableName(tbl);
    let captured: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      set(values: Record<string, unknown>) {
        captured = values;
        state.updates.push({ table, set: captured });
        return chain;
      },
      where(_w: unknown) {
        // resolve to empty array; reopen/stamp don't read the result
        return Promise.resolve([]);
      }
    };
    return chain;
  }
  return {
    db: {
      select: vi.fn(() => makeSelect()),
      insert: vi.fn((tbl: unknown) => makeInsert(tbl)),
      update: vi.fn((tbl: unknown) => makeUpdate(tbl))
    }
  };
});

vi.mock('../../db/schema', () => ({
  ticketEmailInbound: { __t: 'ticket_email_inbound', id: 'id', partnerId: 'partnerId', providerMessageId: 'providerMessageId' },
  tickets: {
    __t: 'tickets',
    id: 'id', partnerId: 'partnerId', orgId: 'orgId', status: 'status',
    emailThreadKey: 'emailThreadKey', internalNumber: 'internalNumber', resolvedAt: 'resolvedAt', updatedAt: 'updatedAt'
  },
  ticketComments: { __t: 'ticket_comments', ticketId: 'ticketId' },
  portalUsers: { __t: 'portal_users', id: 'id', orgId: 'orgId', email: 'email' },
  organizations: { __t: 'organizations', id: 'id', partnerId: 'partnerId' }
}));

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));
vi.mock('./resolvePartner', () => ({ resolvePartnerByRecipient: resolveMock }));

const { createTicketMock, changeStatusMock } = vi.hoisted(() => ({
  createTicketMock: vi.fn(),
  changeStatusMock: vi.fn()
}));
vi.mock('../ticketService', () => ({
  createTicket: createTicketMock,
  changeTicketStatus: changeStatusMock
}));

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }));
vi.mock('../ticketEvents', () => ({ emitTicketEvent: emitMock }));

import { processInboundEmail } from './inboundEmailService';
import type { NormalizedInboundEmail } from './types';

function email(overrides: Partial<NormalizedInboundEmail> = {}): NormalizedInboundEmail {
  return {
    provider: 'mailgun',
    providerMessageId: '<msg-1@customer.com>',
    to: 'acme@tickets.example.com',
    from: 'jane@customer.com',
    fromName: 'Jane Doe',
    subject: 'printer is down',
    text: 'It is broken.',
    messageId: '<msg-1@customer.com>',
    attachments: [],
    raw: { recipient: 'acme@tickets.example.com' },
    ...overrides
  };
}

function inboundOf(table = 'ticket_email_inbound') {
  return state.inserts.filter((i) => i.table === table).map((i) => i.values);
}

beforeEach(() => {
  state.selectRows = {};
  state.inserts = [];
  state.updates = [];
  state.insertedCommentId = 'c-1';
  resolveMock.mockReset();
  createTicketMock.mockReset();
  changeStatusMock.mockReset();
  emitMock.mockReset();
  createTicketMock.mockResolvedValue({ id: 't-new', internalNumber: 'T-2026-0009' });
});

describe('processInboundEmail', () => {
  it('logs ignored (partnerId null) when the recipient resolves to no partner', async () => {
    resolveMock.mockResolvedValue(null);

    await processInboundEmail(email());

    const rows = inboundOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.parseStatus).toBe('ignored');
    expect(rows[0]!.partnerId).toBeNull(); // NOT an all-zero sentinel
    expect(rows[0]!.ticketId).toBeNull();
    expect(createTicketMock).not.toHaveBeenCalled();
  });

  it('is idempotent on a duplicate provider_message_id (no create/append)', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [{ id: 'existing' }];

    await processInboundEmail(email());

    expect(inboundOf()).toHaveLength(0); // no new log row written
    expect(createTicketMock).not.toHaveBeenCalled();
    expect(state.inserts.filter((i) => i.table === 'ticket_comments')).toHaveLength(0);
  });

  it('appends a public comment + reopens a resolved ticket on a threaded reply', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = []; // no dup
    state.selectRows['tickets'] = [{
      id: 't-1', partnerId: 'p-1', orgId: 'o-1', status: 'resolved',
      emailThreadKey: '<msg-1@tickets.example.com>', internalNumber: 'T-2026-0001'
    }];
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1' }];

    await processInboundEmail(email({ inReplyTo: '<msg-1@tickets.example.com>' }));

    // public inbound comment inserted directly into ticket_comments
    const comments = state.inserts.filter((i) => i.table === 'ticket_comments').map((i) => i.values);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.isPublic).toBe(true);
    expect(comments[0]!.commentType).toBe('comment');
    expect(comments[0]!.authorType).toBe('email');
    expect(comments[0]!.userId).toBeNull();
    expect(comments[0]!.portalUserId).toBe('pu-1');
    expect(comments[0]!.content).toBe('It is broken.');

    // reopen resolved -> open (direct partner-scoped tickets UPDATE — FK-safe)
    const ticketUpdates = state.updates.filter((u) => u.table === 'tickets');
    expect(ticketUpdates.some((u) => u.set.status === 'open')).toBe(true);

    // event emitted with inbound:true (no echo to sender)
    expect(emitMock).toHaveBeenCalledTimes(1);
    const ev = emitMock.mock.calls[0]![0] as { type: string; payload: { isPublic: boolean; inbound?: boolean } };
    expect(ev.type).toBe('ticket.commented');
    expect(ev.payload.isPublic).toBe(true);
    expect(ev.payload.inbound).toBe(true);

    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('matched');
    expect(log[0]!.ticketId).toBe('t-1');
  });

  it('matches on a thread key in the MIDDLE of references (not just In-Reply-To / last)', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = []; // no dup
    // The matching key sits in the middle of the References chain. The query now
    // searches ALL candidate keys via inArray, so it must still match.
    state.selectRows['tickets'] = [{
      id: 't-mid', partnerId: 'p-1', orgId: 'o-1', status: 'open',
      emailThreadKey: '<msg-mid@tickets.example.com>', internalNumber: 'T-2026-0002'
    }];
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1' }];

    await processInboundEmail(email({
      inReplyTo: undefined,
      references: ['<msg-0@x>', '<msg-mid@tickets.example.com>', '<msg-last@x>']
    }));

    // appended a public comment on the matched ticket (no reopen — status open)
    const comments = state.inserts.filter((i) => i.table === 'ticket_comments').map((i) => i.values);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.isPublic).toBe(true);

    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('matched');
    expect(log[0]!.ticketId).toBe('t-mid');
  });

  it('GUARD: refuses to touch a matched ticket from another partner (-> failed, no write)', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    // matched ticket belongs to partner B, not the resolved partner A
    state.selectRows['tickets'] = [{
      id: 't-B', partnerId: 'p-2', orgId: 'o-2', status: 'open',
      emailThreadKey: '<msg-1@tickets.example.com>', internalNumber: 'T-2026-0001'
    }];

    await processInboundEmail(email({ inReplyTo: '<msg-1@tickets.example.com>' }));

    // NO comment appended, NO reopen
    expect(state.inserts.filter((i) => i.table === 'ticket_comments')).toHaveLength(0);
    expect(state.updates.filter((u) => u.table === 'tickets' && u.set.status === 'open')).toHaveLength(0);
    expect(createTicketMock).not.toHaveBeenCalled();

    // logged failed, under the RESOLVED partner (A), never matched against B
    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('failed');
    expect(log[0]!.partnerId).toBe('p-1');
    expect(log[0]!.ticketId).toBeNull();
    expect(String(log[0]!.error)).toContain('cross-partner');
  });

  it('creates a source:email ticket for an unmatched known portal-user sender', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = []; // no thread/token match
    // portal-user lookup (scoped to partner) hits; org guard in createFromEmail also hits
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1' }];
    state.selectRows['organizations'] = [{ id: 'o-1' }];
    createTicketMock.mockResolvedValue({ id: 't-created', internalNumber: 'T-2026-0010' });

    await processInboundEmail(email({ subject: 'brand new issue' }));

    expect(createTicketMock).toHaveBeenCalledTimes(1);
    const input = createTicketMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.source).toBe('email');
    expect(input.submitterEmail).toBe('jane@customer.com');
    expect(input.orgId).toBe('o-1');
    expect(input.submittedBy).toBe('pu-1');

    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('created');
    expect(log[0]!.ticketId).toBe('t-created');
  });

  it('quarantines an unmatched unknown sender (no ticket)', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = []; // unknown sender

    await processInboundEmail(email({ subject: 'who are you' }));

    expect(createTicketMock).not.toHaveBeenCalled();
    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('quarantined');
    expect(log[0]!.partnerId).toBe('p-1');
    expect(log[0]!.ticketId).toBeNull();
  });

  it('creates a NEW linked ticket when the matched ticket is closed', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [{
      id: 't-closed', partnerId: 'p-1', orgId: 'o-1', status: 'closed',
      emailThreadKey: '<thread-key-old>', internalNumber: 'T-2026-0001'
    }];
    state.selectRows['organizations'] = [{ id: 'o-1' }]; // org guard passes
    createTicketMock.mockResolvedValue({ id: 't-linked', internalNumber: 'T-2026-0011' });

    await processInboundEmail(email({ subject: 'Re: [T-2026-0001] printer down', inReplyTo: '<thread-key-old>' }));

    expect(createTicketMock).toHaveBeenCalledTimes(1);
    const input = createTicketMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.source).toBe('email');
    expect(input.orgId).toBe('o-1');
    // continuation reference prepended to description
    expect(String(input.description)).toContain('T-2026-0001');

    // NO comment appended on the closed ticket
    expect(state.inserts.filter((i) => i.table === 'ticket_comments')).toHaveLength(0);

    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('created');
    expect(log[0]!.ticketId).toBe('t-linked');
  });
});
