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

// Walk a drizzle SQL condition's queryChunks to find a `status <op> <literal>`
// constraint, so the tickets-select mock can honor the ne(status,'closed') /
// eq(status,'closed') split introduced by the thread-fork guard. The schema mock
// makes `tickets.status` the plain string 'status', so a status comparison serializes
// as the chunk sequence ["status", { value: [" <> "|" = " ] }, "<literal>"]. Returns
// the operator and literal, or null.
function extractStatusConstraint(cond: unknown): { op: string; value: string } | null {
  const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return null;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c === 'status') {
      const opChunk = chunks[i + 1] as { value?: string[] } | undefined;
      const op = opChunk?.value?.[0];
      const literal = chunks[i + 2];
      if (typeof op === 'string' && typeof literal === 'string') {
        return { op, value: literal };
      }
    }
    const nested = extractStatusConstraint(c);
    if (nested) return nested;
  }
  return null;
}

// Walk a drizzle SQL condition's queryChunks to detect an `isNull(tickets.deletedAt)`
// predicate. The schema mock makes `tickets.deletedAt` the plain string 'deletedAt',
// so isNull serializes as the chunk sequence ["deletedAt", { value: [" is null"] }].
// When present, the tickets-select mock filters out any soft-deleted candidate row
// (deletedAt != null) — so if production ever drops the isNull filter, the mock will
// (correctly) surface the deleted row and the exclusion tests below fail.
function whereExcludesDeleted(cond: unknown): boolean {
  const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return false;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i] === 'deletedAt') {
      const opChunk = chunks[i + 1] as { value?: string[] } | undefined;
      const op = opChunk?.value?.[0];
      if (typeof op === 'string' && op.includes('is null')) return true;
    }
    if (whereExcludesDeleted(chunks[i])) return true;
  }
  return false;
}

vi.mock('../../db', () => {
  // select(cols).from(table).where().limit() and .innerJoin().where().limit()
  function makeSelect() {
    let resolvedTable = 'unknown';
    let statusConstraint: { op: string; value: string } | null = null;
    let excludesDeleted = false;
    const chain: Record<string, unknown> = {
      from(tbl: unknown) {
        resolvedTable = tableName(tbl);
        return chain;
      },
      innerJoin(_tbl: unknown, _on: unknown) {
        return chain;
      },
      where(w: unknown) {
        statusConstraint = extractStatusConstraint(w);
        excludesDeleted = whereExcludesDeleted(w);
        return chain;
      },
      limit(_n: number) {
        let rows = state.selectRows[resolvedTable] ?? [];
        // Honor a tickets `status` constraint so the mock can tell the live-match
        // query (ne status closed) from the closed-original lookup (eq status closed).
        if (resolvedTable === 'tickets' && statusConstraint) {
          const { op, value } = statusConstraint;
          rows = rows.filter((r) => {
            const s = (r as { status?: string }).status;
            return op.includes('<>') ? s !== value : s === value;
          });
        }
        // Honor isNull(tickets.deletedAt): a soft-deleted candidate must never match,
        // so the reply forks a new ticket instead of re-threading onto the deleted one.
        if (resolvedTable === 'tickets' && excludesDeleted) {
          rows = rows.filter((r) => (r as { deletedAt?: unknown }).deletedAt == null);
        }
        return Promise.resolve(rows);
      },
      for(_mode: string) {
        return chain;
      },
    };
    return chain;
  }
  // runOutsideDbContext / withSystemDbAccessContext: just invoke the callback (the
  // durable-failed log path in tests runs against the same in-memory db mock).
  const runOutsideDbContext = <T,>(fn: () => T): T => fn();
  const withSystemDbAccessContext = <T,>(fn: () => Promise<T> | T): Promise<T> | T => fn();
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
    },
    runOutsideDbContext,
    withSystemDbAccessContext
  };
});

vi.mock('../../db/schema', () => ({
  ticketEmailInbound: { __t: 'ticket_email_inbound', id: 'id', partnerId: 'partnerId', providerMessageId: 'providerMessageId' },
  tickets: {
    __t: 'tickets',
    id: 'id', partnerId: 'partnerId', orgId: 'orgId', status: 'status', subject: 'subject',
    emailThreadKey: 'emailThreadKey', emailMessageId: 'emailMessageId',
    internalNumber: 'internalNumber', resolvedAt: 'resolvedAt', updatedAt: 'updatedAt',
    deletedAt: 'deletedAt', submittedBy: 'submittedBy', submitterEmail: 'submitterEmail'
  },
  ticketComments: { __t: 'ticket_comments', ticketId: 'ticketId' },
  portalUsers: { __t: 'portal_users', id: 'id', orgId: 'orgId', email: 'email' },
  organizations: { __t: 'organizations', id: 'id', partnerId: 'partnerId' },
  partners: { __t: 'partners', id: 'id', status: 'status' },
  ticketMailboxConnections: {
    __t: 'ticket_mailbox_connections', id: 'id', partnerId: 'partnerId', tenantId: 'tenantId',
    consentAttemptId: 'consentAttemptId', status: 'status'
  }
}));

const { captureExceptionMock, captureMessageMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  captureMessageMock: vi.fn()
}));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock, captureMessage: captureMessageMock }));

// createFromEmail's stable-anchor fallback reads TICKETS_INBOUND_DOMAIN via getConfig().
vi.mock('../../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));
vi.mock('./resolvePartner', () => ({ resolvePartnerByRecipient: resolveMock }));

// Phase 5: sender-domain routing helpers. Mocked so the dispatch-precedence
// tests don't hit the DB — resolveOrg has its own integration suite.
const { resolveOrgMock, resolveRequesterMock, loadPolicyMock } = vi.hoisted(() => ({
  resolveOrgMock: vi.fn(),
  resolveRequesterMock: vi.fn(),
  loadPolicyMock: vi.fn()
}));
vi.mock('./resolveOrg', () => ({
  resolveOrgBySenderDomain: resolveOrgMock,
  resolveEmailRequester: resolveRequesterMock,
  loadPartnerInboundPolicy: loadPolicyMock
}));

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

// PR3: createFromEmail's known-sender path now calls maybeSendAutoresponse. Stub it
// so these dispatch-service tests don't reach into Redis/emit — the gate has its own
// unit suite (autoresponder.test.ts). The `created`-path assertions here only care
// that a ticket was created + the inbound row logged.
const { maybeSendAutoresponseMock } = vi.hoisted(() => ({ maybeSendAutoresponseMock: vi.fn() }));
vi.mock('./autoresponder', () => ({ maybeSendAutoresponse: maybeSendAutoresponseMock }));

// Task 4: pipeline calls claimMessageLink() to record link rows after a matched
// append and after a create. Mocked as a collaborator (like resolveOrg/ticketService
// above) rather than plumbed through the raw db mock — claimMessageLink has its own
// coverage (ticketEmailLinks.test.ts unit tests + the claim integration suite), and
// these dispatch-precedence tests only care about the pipeline's control flow.
// findTicketIdsByMessageIds is called by threadMatcher.ts (also under this mock,
// since it imports the same module) — stub it to "no link rows" so the existing
// header/subject-token matching tests are unaffected; the widening itself has its
// own coverage in the claim integration suite.
// findLinkByMessageId backs the (2b) cross-channel idempotency consult: it is
// stubbed to "no existing claim" so every pre-existing dispatch-precedence test
// keeps its original path byte-for-byte. The short-circuit it guards has its own
// coverage in the claim integration suite.
const { claimMessageLinkMock, findTicketIdsByMessageIdsMock, findLinkByMessageIdMock } = vi.hoisted(() => ({
  claimMessageLinkMock: vi.fn().mockResolvedValue({ created: true, link: {} }),
  findTicketIdsByMessageIdsMock: vi.fn().mockResolvedValue([]),
  findLinkByMessageIdMock: vi.fn().mockResolvedValue(null)
}));
vi.mock('../ticketEmailLinks', async () => {
  const actual = await vi.importActual<typeof import('../ticketEmailLinks')>('../ticketEmailLinks');
  return {
    normalizeMessageId: actual.normalizeMessageId,
    claimMessageLink: claimMessageLinkMock,
    findTicketIdsByMessageIds: findTicketIdsByMessageIdsMock,
    findLinkByMessageId: findLinkByMessageIdMock
  };
});

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
    // Default to a VERIFIED sender so the existing happy-path assertions (which all
    // predate sender-auth gating) keep exercising the trusted match/create paths.
    senderAuth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', verified: true },
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
  // Default: the resolved partner is active (the partner-status gate passes). Tests
  // exercising the inactive-partner `skipped` path override this.
  state.selectRows['partners'] = [{ status: 'active' }];
  state.inserts = [];
  state.updates = [];
  state.insertedCommentId = 'c-1';
  resolveMock.mockReset();
  createTicketMock.mockReset();
  changeStatusMock.mockReset();
  emitMock.mockReset();
  maybeSendAutoresponseMock.mockReset();
  captureExceptionMock.mockReset();
  captureMessageMock.mockReset();
  createTicketMock.mockResolvedValue({ id: 't-new', internalNumber: 'T-2026-0009' });
  // Phase 5 default: no sender-domain mapping, triage off — so an unmatched
  // unknown sender still quarantines (preserves the pre-Phase-5 behavior).
  resolveOrgMock.mockReset();
  resolveOrgMock.mockResolvedValue(null);
  resolveRequesterMock.mockReset();
  loadPolicyMock.mockReset();
  loadPolicyMock.mockResolvedValue({ enabled: true, unknownSenderMode: 'quarantine', defaultTriageOrgId: null, dropUnverifiedSenders: false });
  // (2b) cross-channel idempotency default: nobody has claimed this message id.
  findLinkByMessageIdMock.mockReset();
  findLinkByMessageIdMock.mockResolvedValue(null);
  claimMessageLinkMock.mockReset();
  claimMessageLinkMock.mockResolvedValue({ created: true, link: {} });
});

describe('processInboundEmail', () => {
  const mailboxGeneration = {
    connectionId: '44444444-4444-4444-8444-444444444444',
    partnerId: '22222222-2222-4222-8222-222222222222',
    tenantId: '11111111-1111-4111-8111-111111111111',
    consentAttemptId: '66666666-6666-4666-8666-666666666666',
  };

  it('discards a stale M365 generation before ticket, comment, or inbound-log writes', async () => {
    state.selectRows['ticket_mailbox_connections'] = [];

    await processInboundEmail(
      email({ provider: 'm365', resolvedPartnerId: mailboxGeneration.partnerId }),
      mailboxGeneration,
    );

    expect(createTicketMock).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it('fails closed for an M365 job with no mailbox generation', async () => {
    await processInboundEmail(email({
      provider: 'm365',
      resolvedPartnerId: mailboxGeneration.partnerId,
    }));

    expect(createTicketMock).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it('ingests an M365 job only after locking its exact active generation', async () => {
    state.selectRows['ticket_mailbox_connections'] = [{ id: mailboxGeneration.connectionId }];
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = [];

    await processInboundEmail(
      email({ provider: 'm365', resolvedPartnerId: 'untrusted-payload-partner' }),
      mailboxGeneration,
    );

    expect(inboundOf()).toEqual([expect.objectContaining({
      partnerId: mailboxGeneration.partnerId,
      parseStatus: 'quarantined',
    })]);
  });

  it('preserves generic inbound processing when no mailbox generation is supplied', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = [];

    await processInboundEmail(email());

    expect(inboundOf()).toEqual([expect.objectContaining({ partnerId: 'p-1' })]);
  });

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

  it('threads a customer self-reply via email_message_id when email_thread_key is the anchor (autoresponder-off)', async () => {
    // FIX 2: for an autoresponder-OFF partner, a ticket created with a platform
    // domain has email_thread_key = <ticket-...@domain> (the anchor) but
    // email_message_id = the customer's OWN original Message-Id. If the customer
    // replies to their own original (In-Reply-To = <cust-orig>, NOT the anchor),
    // the live-match query matches via email_message_id (the OR branch) and threads
    // onto the SAME ticket instead of forking a duplicate. The query carries both
    // keys and matches EITHER column, still partner-scoped.
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = []; // no dup
    state.selectRows['tickets'] = [{
      id: 't-self', partnerId: 'p-1', orgId: 'o-1', status: 'open',
      emailThreadKey: '<ticket-t-self@tickets.example.com>', // the anchor (NOT the cust id)
      emailMessageId: '<cust-orig@customer.com>',            // the customer's own Message-Id
      internalNumber: 'T-2026-0003'
    }];
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1' }];

    // The reply's In-Reply-To is the customer's ORIGINAL Message-Id — NOT the anchor.
    await processInboundEmail(email({ inReplyTo: '<cust-orig@customer.com>' }));

    // Appended a public comment on the matched ticket (header threading via email_message_id).
    const comments = state.inserts.filter((i) => i.table === 'ticket_comments').map((i) => i.values);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.isPublic).toBe(true);

    // Did NOT fork a new ticket.
    expect(createTicketMock).not.toHaveBeenCalled();

    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('matched');
    expect(log[0]!.ticketId).toBe('t-self');
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

    // The known-sender fresh-create path fires the autoresponder gate exactly once,
    // with the resolved partner + the persisted ticket fields.
    expect(maybeSendAutoresponseMock).toHaveBeenCalledTimes(1);
    const [normalized, gatedPartner, gatedTicket] = maybeSendAutoresponseMock.mock.calls[0]!;
    expect((normalized as { from: string }).from).toBe('jane@customer.com');
    expect(gatedPartner).toBe('p-1');
    expect((gatedTicket as { id: string; partnerId: string }).id).toBe('t-created');
    expect((gatedTicket as { partnerId: string }).partnerId).toBe('p-1');
  });

  it('does NOT fire the autoresponder on the closed-continuation path (no submittedBy)', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [{
      id: 't-closed', partnerId: 'p-1', orgId: 'o-1', status: 'closed',
      emailThreadKey: '<thread-key-old>', internalNumber: 'T-2026-0001'
    }];
    state.selectRows['organizations'] = [{ id: 'o-1' }];
    createTicketMock.mockResolvedValue({ id: 't-linked', internalNumber: 'T-2026-0011' });

    await processInboundEmail(email({ subject: 'Re: [T-2026-0001] printer down', inReplyTo: '<thread-key-old>' }));

    expect(createTicketMock).toHaveBeenCalledTimes(1);
    // A reply to a CLOSED ticket spawns a linked ticket but is NOT a fresh acknowledgement.
    expect(maybeSendAutoresponseMock).not.toHaveBeenCalled();
  });

  it('stamps a stable generated anchor on email_thread_key when the inbound email has no Message-Id', async () => {
    // PR1 stamped `n.messageId ?? null`, leaving the no-Message-Id case un-anchored so
    // the customer's NEXT reply could never thread (-> quarantine). The fallback now
    // stamps a deterministic <ticket-${id}@TICKETS_INBOUND_DOMAIN> anchor so future
    // inbound replies + outbound References both resolve to the same key.
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = []; // no thread/token match
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1' }];
    state.selectRows['organizations'] = [{ id: 'o-1' }];
    createTicketMock.mockResolvedValue({ id: 't-anchor', internalNumber: 'T-2026-0012' });

    await processInboundEmail(email({ subject: 'no message id', messageId: undefined }));

    expect(createTicketMock).toHaveBeenCalledTimes(1);
    // The post-create tickets UPDATE stamps the generated anchor (not null).
    const stamp = state.updates.find(
      (u) => u.table === 'tickets' && Object.prototype.hasOwnProperty.call(u.set, 'emailThreadKey')
    );
    expect(stamp).toBeDefined();
    expect(stamp!.set.emailThreadKey).toBe('<ticket-t-anchor@tickets.example.com>');

    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('created');
  });

  it('stamps the deterministic anchor (NOT the inbound Message-Id) when a platform domain is configured', async () => {
    // Review fix: when TICKETS_INBOUND_DOMAIN is set, the generated anchor takes
    // PRECEDENCE over the customer's own Message-Id. The anchor is the value the
    // one-time autoresponse stamps as its Message-ID and every comment reply uses
    // for In-Reply-To/References, so the autoresponse ↔ email_thread_key ↔ outbound
    // headers all unify on ONE key — a reply to the autoresponse threads via header,
    // not just the [T-...] subject token. (The no-domain env keeps n.messageId; that
    // path is covered by integration CASE 4/5.)
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1' }];
    state.selectRows['organizations'] = [{ id: 'o-1' }];
    createTicketMock.mockResolvedValue({ id: 't-mid2', internalNumber: 'T-2026-0013' });

    await processInboundEmail(email({ subject: 'has message id', messageId: '<real-msg@customer.com>' }));

    const stamp = state.updates.find(
      (u) => u.table === 'tickets' && Object.prototype.hasOwnProperty.call(u.set, 'emailThreadKey')
    );
    expect(stamp).toBeDefined();
    // Anchor wins over the inbound Message-Id when a domain is configured.
    expect(stamp!.set.emailThreadKey).toBe('<ticket-t-mid2@tickets.example.com>');
  });

  // #3258 W03 review I1: a portal LOGIN whose contact_id is null files a ticket
  // that nobody can claim in the portal — createTicket derives the person from
  // that column and there is nothing to derive. Recorded as a note (never an
  // error: the ticket is correct, the login's data is incomplete).
  it('notes a portal-login sender whose login carries no contact link', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1', name: 'Jane', contactId: null }];
    state.selectRows['organizations'] = [{ id: 'o-1' }];
    createTicketMock.mockResolvedValue({ id: 't-nc', internalNumber: 'T-2026-0031' });

    await processInboundEmail(email({ subject: 'login without contact' }));

    const row = inboundOf()[0]!;
    expect(row.parseStatus).toBe('created');
    expect(row.error).toMatch(/requester not linked/i);
    expect(row.error).toMatch(/login/i);
  });

  it('adds no note when the portal-login sender IS linked to a contact', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1', name: 'Jane', contactId: 'ct-1' }];
    state.selectRows['organizations'] = [{ id: 'o-1' }];
    createTicketMock.mockResolvedValue({ id: 't-lc', internalNumber: 'T-2026-0032' });

    await processInboundEmail(email({ subject: 'login with contact' }));

    expect(inboundOf()[0]!.error ?? null).toBeNull();
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

  it('records the diagnostic and alerts Sentry when an unverified sender has no usable Mailgun verdict', async () => {
    resolveMock.mockResolvedValue('p-1');
    await processInboundEmail(email({
      senderAuth: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', verified: false },
      senderAuthDiagnostic: 'no-mailgun-authserv'
    }));

    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('quarantined');
    // The quarantine reason carries the WHY so the audit row is self-explaining.
    expect(log[0]!.error).toContain('no-mailgun-authserv');
    // A signature-verified webhook with no usable verdict is anomalous -> Sentry warning.
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock.mock.calls[0]![1]).toMatchObject({
      eventCode: 'inbound_email_sender_auth_unverified',
    });
    // The diagnostic itself is asserted on the audit row above — it used to be
    // asserted inside captureMessage's `extra`, which never reached Sentry.
  });

  it('does NOT alert Sentry for an ordinary unverified sender (genuine DMARC fail, no diagnostic)', async () => {
    resolveMock.mockResolvedValue('p-1');
    await processInboundEmail(email({
      senderAuth: { spf: 'fail', dkim: 'fail', dmarc: 'fail', verified: false }
      // no senderAuthDiagnostic -> a real verdict was read, just not a pass
    }));

    const log = inboundOf();
    expect(log[0]!.parseStatus).toBe('quarantined');
    expect(log[0]!.error).toBe('unverified sender (SPF/DKIM/DMARC)');
    expect(captureMessageMock).not.toHaveBeenCalled();
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

  // SOFT-DELETE EXCLUSION (Phase 6): findTicketInPartner gates the live thread-key /
  // subject-token match on isNull(tickets.deletedAt). A reply whose thread key matches
  // a SOFT-DELETED ticket must NOT re-thread onto it — the deleted row is invisible to
  // the matcher, so the reply forks a brand-new ticket instead.
  it('does NOT thread onto a soft-deleted ticket — forks a new ticket instead (live match)', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = []; // no dup
    // A resolved ticket matches the thread key BUT has been soft-deleted.
    state.selectRows['tickets'] = [{
      id: 't-deleted', partnerId: 'p-1', orgId: 'o-1', status: 'resolved',
      emailThreadKey: '<msg-1@tickets.example.com>', internalNumber: 'T-2026-0001',
      deletedAt: new Date()
    }];
    // Known portal user + org so the fall-through create path succeeds.
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1' }];
    state.selectRows['organizations'] = [{ id: 'o-1' }];
    createTicketMock.mockResolvedValue({ id: 't-fresh', internalNumber: 'T-2026-0050' });

    await processInboundEmail(email({ inReplyTo: '<msg-1@tickets.example.com>' }));

    // The soft-deleted ticket must NOT be appended to or reopened.
    expect(state.inserts.filter((i) => i.table === 'ticket_comments')).toHaveLength(0);
    expect(state.updates.filter((u) => u.table === 'tickets' && u.set.status === 'open')).toHaveLength(0);
    // Instead, a brand-new ticket is created for the reply.
    expect(createTicketMock).toHaveBeenCalledTimes(1);

    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('created');
    expect(log[0]!.ticketId).toBe('t-fresh');
  });

  // findClosedTicketInPartner is likewise gated on isNull(tickets.deletedAt): a reply to
  // a soft-deleted CLOSED original must not spawn a continuation from the deleted row.
  it('does NOT spawn a continuation from a soft-deleted CLOSED original — quarantines instead', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = []; // no dup
    // A CLOSED ticket matches the subject token / thread key BUT is soft-deleted.
    state.selectRows['tickets'] = [{
      id: 't-closed-deleted', partnerId: 'p-1', orgId: 'o-1', status: 'closed',
      emailThreadKey: '<thread-key-old>', internalNumber: 'T-2026-0001',
      deletedAt: new Date()
    }];
    // Unknown sender (no portal user, no domain mapping) so the ONLY path that could
    // create a ticket is the closed-continuation — which must NOT fire for a deleted original.
    state.selectRows['portal_users'] = [];

    await processInboundEmail(email({ subject: 'Re: [T-2026-0001] printer down', inReplyTo: '<thread-key-old>' }));

    // The soft-deleted closed original is excluded → no continuation ticket created.
    expect(createTicketMock).not.toHaveBeenCalled();
    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('quarantined');
    expect(log[0]!.ticketId).toBeNull();
  });

  // TEST 2 — durable failed-log path: when a WORK write throws, logInboundFailedDurable
  // still commits a `failed` row in a fresh transaction (the prior commit's key fix).
  it('durable-fail: when createTicket throws, a failed row is still written, sentry is called, and the function resolves', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = []; // no dup
    state.selectRows['tickets'] = []; // no thread match
    // Known portal user — triggers the create path.
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1' }];
    state.selectRows['organizations'] = [{ id: 'o-1' }]; // org guard passes

    // Simulate a DB-level error during the work write (createTicket throws).
    const dbError = new Error('deadlock detected');
    createTicketMock.mockRejectedValue(dbError);

    // (c) Must NOT rethrow — processInboundEmail resolves even when work throws.
    await expect(processInboundEmail(email({ subject: 'Will fail' }))).resolves.toBeUndefined();

    // (a) A ticket_email_inbound insert with parseStatus: 'failed' was still captured
    // (the durable path ran — logInboundFailedDurable opens a fresh context via the
    // pass-through runOutsideDbContext/withSystemDbAccessContext mocks).
    const failedRows = inboundOf().filter((r) => r.parseStatus === 'failed');
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]!.parseStatus).toBe('failed');
    expect(failedRows[0]!.partnerId).toBe('p-1');
    expect(String(failedRows[0]!.error)).toContain('deadlock');

    // (b) captureException was called with the error.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((captureExceptionMock.mock.calls[0]![0] as Error).message).toContain('deadlock');
  });

  // TEST 3 — org-not-in-partner guard: when the portal-user's org is not in the
  // resolved partner, createFromEmail throws and the outcome is a durable `failed` row.
  it('org-not-in-partner guard: returns failed with "not in partner" error and no ticket created', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    // Portal-user lookup succeeds (sender is known under some org).
    state.selectRows['portal_users'] = [{ id: 'pu-2', orgId: 'o-other' }];
    // The org guard in createFromEmail: organizations select returns [] (org not in partner).
    state.selectRows['organizations'] = [];

    await expect(processInboundEmail(email({ subject: 'Org mismatch test' }))).resolves.toBeUndefined();

    // No ticket was created.
    expect(createTicketMock).not.toHaveBeenCalled();

    // A failed row was written with an error message containing 'not in partner'.
    const failedRows = inboundOf().filter((r) => r.parseStatus === 'failed');
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]!.partnerId).toBe('p-1');
    expect(String(failedRows[0]!.error)).toContain('not in partner');

    // captureException was called.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  // INGEST-TIME SELF-LOOP DROP (spec §5): mail whose sender is on our OWN inbound
  // domain (e.g. our own outbound reply or an autoresponse bounce looping back) must
  // be dropped EARLY — logged `ignored` with a self-loop note — before any
  // match/create/quarantine decision. This is the ingest-time guard; the autoresponse-
  // time `self-domain` rule in loopPrevention.ts is the separate backstop.
  it('drops self-loop mail (sender on our own inbound domain) as ignored, before any create/match', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    // Sender's domain equals the inbound domain (tickets.example.com from the config mock).
    await processInboundEmail(email({ from: 'acme@TICKETS.example.com', subject: 'looped back' }));

    // No ticket, no comment, no quarantine — the dedup SELECT/match never run.
    expect(createTicketMock).not.toHaveBeenCalled();
    expect(state.inserts.filter((i) => i.table === 'ticket_comments')).toHaveLength(0);

    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('ignored');
    expect(log[0]!.partnerId).toBe('p-1');
    expect(log[0]!.ticketId).toBeNull();
    expect(String(log[0]!.error)).toContain('self-loop');
  });

  it('does NOT drop normal mail when the sender domain differs from the inbound domain', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1' }];
    state.selectRows['organizations'] = [{ id: 'o-1' }];
    createTicketMock.mockResolvedValue({ id: 't-normal', internalNumber: 'T-2026-0014' });

    // jane@customer.com — different domain, must flow to the created path.
    await processInboundEmail(email({ subject: 'real new issue' }));

    expect(createTicketMock).toHaveBeenCalledTimes(1);
    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('created');
  });

  // TEST 4 — partner-active gate: a suspended/inactive partner causes a `skipped` log
  // with no ticket creation and no comment append.
  it('partner-active gate: suspended partner yields skipped log, no ticket, no comment', async () => {
    resolveMock.mockResolvedValue('p-suspended');
    state.selectRows['ticket_email_inbound'] = [];
    // Override the default active partners row — partner is suspended.
    state.selectRows['partners'] = [{ status: 'suspended' }];

    await processInboundEmail(email({ subject: 'Suspended partner test' }));

    // No ticket, no comment.
    expect(createTicketMock).not.toHaveBeenCalled();
    expect(state.inserts.filter((i) => i.table === 'ticket_comments')).toHaveLength(0);

    // A single skipped row logged under the partner.
    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('skipped');
    expect(log[0]!.partnerId).toBe('p-suspended');
    // The error note mentions the status.
    expect(String(log[0]!.error)).toContain('suspended');
  });

  // SENDER-AUTH GATE (R4): the From header is spoofable. Before trusting it for any
  // identity/state action — appending a PUBLIC comment, reopening a ticket, or
  // creating a ticket as a trusted portal user — the sender domain MUST be
  // authenticated (aligned SPF+DKIM, or DMARC pass). An UNVERIFIED sender is routed
  // to the existing quarantine/review path instead of auto-acting. Mail is never
  // hard-dropped.
  it('R4: unverified sender with a valid thread match is QUARANTINED, not appended/reopened', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = []; // no dup
    // A real, matchable resolved ticket exists — but the sender is unauthenticated.
    state.selectRows['tickets'] = [{
      id: 't-1', partnerId: 'p-1', orgId: 'o-1', status: 'resolved',
      emailThreadKey: '<msg-1@tickets.example.com>', internalNumber: 'T-2026-0001'
    }];
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1', name: 'Jane Doe' }];

    await processInboundEmail(email({
      inReplyTo: '<msg-1@tickets.example.com>',
      senderAuth: { spf: 'fail', dkim: 'none', dmarc: 'fail', verified: false }
    }));

    // NO public comment appended, NO reopen.
    expect(state.inserts.filter((i) => i.table === 'ticket_comments')).toHaveLength(0);
    expect(state.updates.filter((u) => u.table === 'tickets' && u.set.status === 'open')).toHaveLength(0);
    expect(createTicketMock).not.toHaveBeenCalled();

    // Routed to quarantine for human review.
    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('quarantined');
    expect(log[0]!.partnerId).toBe('p-1');
    expect(log[0]!.ticketId).toBeNull();
  });

  it('R4: unverified known portal-user sender is QUARANTINED, not created-as-trusted', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = []; // no thread/token match
    // Sender email DOES map to a portal user — but the From header is unauthenticated,
    // so it must NOT be trusted to stamp submittedBy / skip quarantine.
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1', name: 'Jane Doe' }];
    state.selectRows['organizations'] = [{ id: 'o-1' }];

    await processInboundEmail(email({
      subject: 'brand new issue',
      senderAuth: { spf: 'fail', dkim: 'fail', dmarc: 'fail', verified: false }
    }));

    expect(createTicketMock).not.toHaveBeenCalled();
    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('quarantined');
    expect(log[0]!.partnerId).toBe('p-1');
    expect(log[0]!.ticketId).toBeNull();
  });

  it('R4: a missing senderAuth verdict is treated as NOT verified (quarantine)', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1', name: 'Jane Doe' }];
    state.selectRows['organizations'] = [{ id: 'o-1' }];

    // No senderAuth field at all (provider omitted verdicts) -> fail closed.
    const e = email({ subject: 'no verdict' });
    delete (e as { senderAuth?: unknown }).senderAuth;
    await processInboundEmail(e);

    expect(createTicketMock).not.toHaveBeenCalled();
    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('quarantined');
  });

  it('R4: dropUnverifiedSenders DROPS an unverified sender instead of quarantining (audit row only)', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = [];
    loadPolicyMock.mockResolvedValue({ enabled: true, unknownSenderMode: 'quarantine', defaultTriageOrgId: null, dropUnverifiedSenders: true });

    await processInboundEmail(email({ senderAuth: { spf: 'fail', dkim: 'fail', dmarc: 'fail', verified: false } }));

    expect(createTicketMock).not.toHaveBeenCalled();
    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('ignored');
    expect(log[0]!.ticketId).toBeNull();
  });

  it('R4: a VERIFIED sender still appends/reopens, and stamps authorName from the stored portal-user name', async () => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [{
      id: 't-1', partnerId: 'p-1', orgId: 'o-1', status: 'resolved',
      emailThreadKey: '<msg-1@tickets.example.com>', internalNumber: 'T-2026-0001'
    }];
    state.selectRows['portal_users'] = [{ id: 'pu-1', orgId: 'o-1', name: 'Jane Stored-Name' }];

    await processInboundEmail(email({
      // Spoofable display name in the header — must NOT win over the stored name.
      fromName: 'Spoofed Name',
      inReplyTo: '<msg-1@tickets.example.com>',
      senderAuth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', verified: true }
    }));

    const comments = state.inserts.filter((i) => i.table === 'ticket_comments').map((i) => i.values);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.isPublic).toBe(true);
    // authorName comes from the verified portal user's stored name, not the raw header.
    expect(comments[0]!.authorName).toBe('Jane Stored-Name');

    const ticketUpdates = state.updates.filter((u) => u.table === 'tickets');
    expect(ticketUpdates.some((u) => u.set.status === 'open')).toBe(true);

    const log = inboundOf();
    expect(log[0]!.parseStatus).toBe('matched');
    expect(log[0]!.ticketId).toBe('t-1');
  });
});

describe('processInboundEmail — Phase 5 sender-domain routing', () => {
  beforeEach(() => {
    // Verified sender, no dup, no thread/closed match, NOT a known portal user
    // -> falls through to the new domain/triage/quarantine precedence.
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = [];
    resolveMock.mockResolvedValue('p-1');
    resolveOrgMock.mockReset();
    resolveRequesterMock.mockReset();
    loadPolicyMock.mockReset();
    // Safe defaults: no domain match, quarantine unknown senders.
    resolveOrgMock.mockResolvedValue(null);
    loadPolicyMock.mockResolvedValue({ enabled: true, unknownSenderMode: 'quarantine', defaultTriageOrgId: null, dropUnverifiedSenders: false });
  });

  it('routes a mapped domain (autoCreateContact true) -> ticket carries the CONTACT, never a portal login', async () => {
    state.selectRows['organizations'] = [{ id: 'o-9' }];
    resolveOrgMock.mockResolvedValue({ orgId: 'o-9', autoCreateContact: true });
    resolveRequesterMock.mockResolvedValue({ kind: 'contact', contactId: 'ct-auto' });
    createTicketMock.mockResolvedValue({ id: 't-d', internalNumber: 'T-2026-0099' });

    await processInboundEmail(email());

    expect(resolveRequesterMock).toHaveBeenCalledWith('o-9', 'jane@customer.com', 'Jane Doe');
    expect(createTicketMock).toHaveBeenCalledTimes(1);
    const input = createTicketMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.orgId).toBe('o-9');
    // #3258 W03: no password-less portal_users row is minted any more.
    expect(input.submittedBy ?? null).toBeNull();
    expect(input.requesterContactId).toBe('ct-auto');
    expect(inboundOf()[0]!.parseStatus).toBe('created');
  });

  it('a shared mailbox still creates the ticket, with NO contact link and the snapshot kept', async () => {
    state.selectRows['organizations'] = [{ id: 'o-9' }];
    resolveOrgMock.mockResolvedValue({ orgId: 'o-9', autoCreateContact: true });
    resolveRequesterMock.mockResolvedValue({ kind: 'none', reason: 'shared-mailbox' });
    createTicketMock.mockResolvedValue({ id: 't-amb', internalNumber: 'T-2026-0098' });

    await processInboundEmail(email());

    const input = createTicketMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.submittedBy ?? null).toBeNull();
    expect(input.requesterContactId ?? null).toBeNull();
    // The snapshot is what the notify worker mails and what threadMatcher
    // binds on — it must survive an unresolvable person.
    expect(input.submitterEmail).toBe('jane@customer.com');
    expect(input.submitterName).toBe('Jane Doe');
    expect(inboundOf()[0]!.parseStatus).toBe('created');
  });

  // ---- #3258 W03 review I1: WHY a ticket came in unattributed is recorded ----
  //
  // `ticket_email_inbound.error` already carries operator notes rather than
  // only exceptions ("lost message-id claim to ticket ..."). Before this, an
  // unresolvable requester was discarded at the call site: the audit row for a
  // shared mailbox and for a malformed From were byte-identical, so the one
  // question an operator asks ("why is this ticket attributed to nobody?") had
  // no answer anywhere in the system.

  it('records the shared-mailbox reason (with the address) on the created audit row', async () => {
    state.selectRows['organizations'] = [{ id: 'o-9' }];
    resolveOrgMock.mockResolvedValue({ orgId: 'o-9', autoCreateContact: true });
    resolveRequesterMock.mockResolvedValue({ kind: 'none', reason: 'shared-mailbox' });
    createTicketMock.mockResolvedValue({ id: 't-amb', internalNumber: 'T-2026-0098' });

    await processInboundEmail(email());

    const row = inboundOf()[0]!;
    expect(row.parseStatus).toBe('created');
    // The ADDRESS is what makes the note actionable — it is the thing the
    // operator has to go and de-duplicate in the contacts list.
    expect(row.error).toMatch(/requester not linked/i);
    expect(row.error).toContain('jane@customer.com');
    expect(row.error).toMatch(/share/i);
  });

  it('records the vanished reason distinctly from the shared-mailbox one', async () => {
    state.selectRows['organizations'] = [{ id: 'o-9' }];
    resolveOrgMock.mockResolvedValue({ orgId: 'o-9', autoCreateContact: true });
    resolveRequesterMock.mockResolvedValue({ kind: 'none', reason: 'vanished' });
    createTicketMock.mockResolvedValue({ id: 't-v', internalNumber: 'T-2026-0097' });

    await processInboundEmail(email());

    const row = inboundOf()[0]!;
    expect(row.parseStatus).toBe('created');
    expect(row.error).toMatch(/requester not linked/i);
    expect(row.error).not.toMatch(/share/i);
  });

  it('leaves the audit note empty when the requester DID resolve', async () => {
    state.selectRows['organizations'] = [{ id: 'o-9' }];
    resolveOrgMock.mockResolvedValue({ orgId: 'o-9', autoCreateContact: true });
    resolveRequesterMock.mockResolvedValue({ kind: 'contact', contactId: 'ct-ok' });
    createTicketMock.mockResolvedValue({ id: 't-ok', internalNumber: 'T-2026-0096' });

    await processInboundEmail(email());

    expect(inboundOf()[0]!.error ?? null).toBeNull();
  });

  it('routes a mapped domain (autoCreateContact false) -> creates ticket, NO contact onboarding', async () => {
    state.selectRows['organizations'] = [{ id: 'o-9' }];
    resolveOrgMock.mockResolvedValue({ orgId: 'o-9', autoCreateContact: false });
    createTicketMock.mockResolvedValue({ id: 't-d', internalNumber: 'T-2026-0099' });

    await processInboundEmail(email());

    expect(resolveRequesterMock).not.toHaveBeenCalled();
    const input = createTicketMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.orgId).toBe('o-9');
    expect(input.submittedBy ?? null).toBeNull();
    expect(inboundOf()[0]!.parseStatus).toBe('created');
  });

  it('falls back to the triage org when enabled and no domain matches (no contact onboarding)', async () => {
    state.selectRows['organizations'] = [{ id: 'o-triage' }];
    resolveOrgMock.mockResolvedValue(null);
    loadPolicyMock.mockResolvedValue({ enabled: true, unknownSenderMode: 'triage', defaultTriageOrgId: 'o-triage', dropUnverifiedSenders: false });
    createTicketMock.mockResolvedValue({ id: 't-t', internalNumber: 'T-2026-0100' });

    await processInboundEmail(email());

    expect(resolveRequesterMock).not.toHaveBeenCalled();
    const input = createTicketMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.orgId).toBe('o-triage');
    expect(inboundOf()[0]!.parseStatus).toBe('created');
  });

  // ---- #3258 W03: the autoresponse truth table, now an EXPLICIT flag ----
  //
  // The one-time acknowledgement used to be gated on `submittedBy && !priorNumber`
  // — i.e. it read the REQUESTER as a proxy for "we accepted a known sender".
  // Repointing attribution at contacts breaks that proxy (a shared mailbox is an
  // accepted known sender with NO resolvable person), so the decision is now a
  // parameter computed at each call site. These cases pin the table that the old
  // proxy produced, so the repoint cannot silently start or stop acknowledging.

  it('fires the autoresponder for a mapped domain with autoCreateContact true', async () => {
    state.selectRows['organizations'] = [{ id: 'o-9' }];
    resolveOrgMock.mockResolvedValue({ orgId: 'o-9', autoCreateContact: true });
    resolveRequesterMock.mockResolvedValue({ kind: 'contact', contactId: 'ct-1' });
    createTicketMock.mockResolvedValue({ id: 't-d', internalNumber: 'T-2026-0099' });

    await processInboundEmail(email());

    expect(maybeSendAutoresponseMock).toHaveBeenCalledTimes(1);
  });

  it('STILL fires the autoresponder when the sender is a shared mailbox', async () => {
    // An unresolvable person is not an unaccepted sender: the domain is mapped
    // and the mail was accepted, so the customer gets their acknowledgement.
    state.selectRows['organizations'] = [{ id: 'o-9' }];
    resolveOrgMock.mockResolvedValue({ orgId: 'o-9', autoCreateContact: true });
    resolveRequesterMock.mockResolvedValue({ kind: 'none', reason: 'shared-mailbox' });
    createTicketMock.mockResolvedValue({ id: 't-amb', internalNumber: 'T-2026-0098' });

    await processInboundEmail(email());

    expect(maybeSendAutoresponseMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire the autoresponder for a mapped domain with autoCreateContact false', async () => {
    state.selectRows['organizations'] = [{ id: 'o-9' }];
    resolveOrgMock.mockResolvedValue({ orgId: 'o-9', autoCreateContact: false });
    createTicketMock.mockResolvedValue({ id: 't-d', internalNumber: 'T-2026-0099' });

    await processInboundEmail(email());

    expect(resolveRequesterMock).not.toHaveBeenCalled();
    expect(maybeSendAutoresponseMock).not.toHaveBeenCalled();
  });

  it('does NOT fire the autoresponder on the triage-org path (the sender is unknown)', async () => {
    state.selectRows['organizations'] = [{ id: 'o-triage' }];
    resolveOrgMock.mockResolvedValue(null);
    loadPolicyMock.mockResolvedValue({ enabled: true, unknownSenderMode: 'triage', defaultTriageOrgId: 'o-triage', dropUnverifiedSenders: false });
    createTicketMock.mockResolvedValue({ id: 't-t', internalNumber: 'T-2026-0100' });

    await processInboundEmail(email());

    expect(maybeSendAutoresponseMock).not.toHaveBeenCalled();
  });

  it('quarantines when nothing matches and mode is quarantine (default)', async () => {
    resolveOrgMock.mockResolvedValue(null);
    loadPolicyMock.mockResolvedValue({ enabled: true, unknownSenderMode: 'quarantine', defaultTriageOrgId: null, dropUnverifiedSenders: false });

    await processInboundEmail(email());

    expect(createTicketMock).not.toHaveBeenCalled();
    expect(inboundOf()[0]!.parseStatus).toBe('quarantined');
  });

  it('triage mode with NO triage org configured falls through to quarantine (never a no-org create)', async () => {
    resolveOrgMock.mockResolvedValue(null);
    loadPolicyMock.mockResolvedValue({ enabled: true, unknownSenderMode: 'triage', defaultTriageOrgId: null, dropUnverifiedSenders: false });

    await processInboundEmail(email());

    expect(createTicketMock).not.toHaveBeenCalled();
    expect(inboundOf()[0]!.parseStatus).toBe('quarantined');
  });

  it("'drop' mode silently ignores an unknown sender — no ticket, no quarantine (audit row only)", async () => {
    resolveOrgMock.mockResolvedValue(null);
    loadPolicyMock.mockResolvedValue({ enabled: true, unknownSenderMode: 'drop', defaultTriageOrgId: null, dropUnverifiedSenders: false });

    await processInboundEmail(email());

    expect(createTicketMock).not.toHaveBeenCalled();
    const rows = inboundOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.parseStatus).toBe('ignored');
    expect(rows[0]!.ticketId).toBeNull();
  });

  it('does NOT reach domain routing for an unverified sender (existing DMARC gate wins)', async () => {
    resolveOrgMock.mockResolvedValue({ orgId: 'o-9', autoCreateContact: true });

    await processInboundEmail(email({ senderAuth: { spf: 'fail', dkim: 'fail', dmarc: 'fail', verified: false } }));

    expect(resolveOrgMock).not.toHaveBeenCalled();
    expect(createTicketMock).not.toHaveBeenCalled();
    expect(inboundOf()[0]!.parseStatus).toBe('quarantined');
  });

  it('a known portal user WINS over a domain mapping (precedence #5 before #6)', async () => {
    // Both signals match: the sender is a known portal user in org o-known AND
    // their domain maps to a different org o-domain. The portal-user branch is
    // most-specific and must win — the domain resolver must not even be consulted.
    state.selectRows['portal_users'] = [{ id: 'pu-known', orgId: 'o-known' }];
    state.selectRows['organizations'] = [{ id: 'o-known' }];
    resolveOrgMock.mockResolvedValue({ orgId: 'o-domain', autoCreateContact: true });
    createTicketMock.mockResolvedValue({ id: 't-k', internalNumber: 'T-2026-0101' });

    await processInboundEmail(email());

    expect(resolveOrgMock).not.toHaveBeenCalled();
    expect(resolveRequesterMock).not.toHaveBeenCalled();
    const input = createTicketMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.orgId).toBe('o-known');
    expect(input.submittedBy).toBe('pu-known');
    // The contact link is DERIVED by createTicket from portal_users.contact_id
    // — the inbound path must not guess a second person for a known login.
    expect(input.requesterContactId ?? null).toBeNull();
  });
});


// #3597 — the 'Enable email-to-ticket' switch was persisted and rendered but never
// read by this pipeline, so turning the feature OFF did nothing. These assert the
// gate is real, that it beats every downstream branch, and that it does not fire on
// its own default (which must stay permissive so an upgrade can't stop ingestion).
describe('processInboundEmail — inbound enabled master switch (#3597)', () => {
  const disabled = {
    enabled: false,
    unknownSenderMode: 'quarantine' as const,
    defaultTriageOrgId: null,
    dropUnverifiedSenders: false,
  };

  beforeEach(() => {
    state.selectRows['ticket_email_inbound'] = [];
    state.selectRows['tickets'] = [];
    state.selectRows['portal_users'] = [];
    resolveMock.mockResolvedValue('p-1');
    resolveOrgMock.mockResolvedValue(null);
  });

  it('ignores mail for a partner with inbound disabled — no ticket, no quarantine row', async () => {
    loadPolicyMock.mockResolvedValue(disabled);

    await processInboundEmail(email());

    expect(createTicketMock).not.toHaveBeenCalled();
    const rows = inboundOf();
    expect(rows).toHaveLength(1);
    // 'ignored', not 'quarantined'/'failed' — those two are REVIEW_STATUSES, and a
    // partner who switched the feature off must not accumulate a review queue.
    expect(rows[0]!.parseStatus).toBe('ignored');
    expect(rows[0]!.partnerId).toBe('p-1');
    expect(rows[0]!.ticketId).toBeNull();
    expect(rows[0]!.error).toBe('inbound disabled for partner');
  });

  it('beats a live thread match — a disabled partner gets no comment append or reopen', async () => {
    loadPolicyMock.mockResolvedValue(disabled);
    // A ticket the message would otherwise match (and reopen, since it's resolved).
    state.selectRows['tickets'] = [{
      id: 't-live', partnerId: 'p-1', orgId: 'o-1', status: 'resolved',
      emailThreadKey: 'k', internalNumber: 'T-2026-0001',
    }];

    await processInboundEmail(email());

    expect(state.updates).toHaveLength(0);
    expect(inboundOf()[0]!.parseStatus).toBe('ignored');
  });

  it('suppresses the autoresponder — nothing downstream of the gate runs', async () => {
    loadPolicyMock.mockResolvedValue(disabled);
    state.selectRows['organizations'] = [{ id: 'o-9' }];
    resolveOrgMock.mockResolvedValue({ orgId: 'o-9', autoCreateContact: true });

    await processInboundEmail(email());

    expect(maybeSendAutoresponseMock).not.toHaveBeenCalled();
    expect(resolveRequesterMock).not.toHaveBeenCalled();
    expect(resolveOrgMock).not.toHaveBeenCalled();
  });

  it('gates the M365 poll path too (the flag is per-partner, not per-transport)', async () => {
    const mailboxGeneration = {
      connectionId: '44444444-4444-4444-8444-444444444444',
      partnerId: '22222222-2222-4222-8222-222222222222',
      tenantId: '11111111-1111-4111-8111-111111111111',
      consentAttemptId: '66666666-6666-4666-8666-666666666666',
    };
    state.selectRows['ticket_mailbox_connections'] = [{ id: mailboxGeneration.connectionId }];
    loadPolicyMock.mockResolvedValue(disabled);

    await processInboundEmail(
      email({ provider: 'm365', resolvedPartnerId: mailboxGeneration.partnerId }),
      mailboxGeneration,
    );

    expect(createTicketMock).not.toHaveBeenCalled();
    expect(inboundOf()).toEqual([expect.objectContaining({
      partnerId: mailboxGeneration.partnerId,
      parseStatus: 'ignored',
    })]);
  });

  it('does not fire for an enabled partner (the gate is not the whole pipeline)', async () => {
    loadPolicyMock.mockResolvedValue({ ...disabled, enabled: true });

    await processInboundEmail(email());

    expect(inboundOf()[0]!.parseStatus).toBe('quarantined');
  });
});

// ---------------------------------------------------------------------------
// Security review 2026-08-16 §1.3 — cross-org ticket comment injection via the
// enumerable subject token.
//
// The subject-token path used to key on partnerId + status + internalNumber ONLY.
// Ticket numbers are sequential, so anyone whose mail passes SPF/DKIM/DMARC (which
// only proves they own THEIR OWN domain) could email the MSP's support address with
// `Re: [T-2026-0123]` and get a PUBLIC comment appended to another customer org's
// ticket — reopening it if it was resolved. The thread-key path is unguessable and
// is deliberately left unbound.
// ---------------------------------------------------------------------------
describe('subject-token matches are bound to the sender (§1.3)', () => {
  const VICTIM_TOKEN = 'T-2026-0123';

  function victimTicket(overrides: Record<string, unknown> = {}) {
    return {
      id: 't-victim',
      partnerId: 'p-1',
      orgId: 'org-b',
      status: 'resolved',
      emailThreadKey: '<anchor-b@tickets.example.com>',
      internalNumber: VICTIM_TOKEN,
      submittedBy: 'pu-victim',
      submitterEmail: 'victim@customer-b.example',
      ...overrides,
    };
  }

  function comments() {
    return state.inserts.filter((i) => i.table === 'ticket_comments').map((i) => i.values);
  }

  function reopened() {
    return state.updates.filter((u) => u.table === 'tickets' && u.set.status === 'open');
  }

  beforeEach(() => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['ticket_email_inbound'] = []; // no duplicate suppression
    state.selectRows['tickets'] = [victimTicket()];
    state.selectRows['portal_users'] = [];
    state.selectRows['organizations'] = [{ id: 'org-a' }, { id: 'org-b' }];
  });

  it('EXPLOIT: an unaffiliated sender guessing the token gets NO comment and NO reopen', async () => {
    // Attacker owns evil.example, so SPF/DKIM/DMARC pass. They know only the number.
    await processInboundEmail(email({
      from: 'attacker@evil.example',
      fromName: 'Totally Legit',
      subject: `Re: [${VICTIM_TOKEN}] please wire the funds`,
    }));

    expect(comments()).toHaveLength(0);
    expect(reopened()).toHaveLength(0);
    expect(emitMock).not.toHaveBeenCalled();
    // No new ticket carrying the victim's org either.
    expect(createTicketMock).not.toHaveBeenCalled();

    // The fallthrough is indistinguishable from a message that carried no token:
    // quarantined, with no ticket id that would confirm T-2026-0123 exists.
    const log = inboundOf();
    expect(log).toHaveLength(1);
    expect(log[0]!.parseStatus).toBe('quarantined');
    expect(log[0]!.ticketId ?? null).toBeNull();
  });

  it('EXPLOIT: a portal user of a DIFFERENT org under the same partner cannot reach the ticket', async () => {
    // The sharpest case: a genuine customer of the same MSP, just not of org-b.
    state.selectRows['portal_users'] = [{ id: 'pu-a', orgId: 'org-a' }];
    createTicketMock.mockResolvedValue({ id: 't-own-org', internalNumber: 'T-2026-0500' });

    await processInboundEmail(email({
      from: 'neighbour@customer-a.example',
      subject: `Re: [${VICTIM_TOKEN}] status?`,
    }));

    expect(comments()).toHaveLength(0);
    expect(reopened()).toHaveLength(0);
    // Falls through to the normal known-sender path: a fresh ticket in THEIR OWN org.
    expect(createTicketMock).toHaveBeenCalledTimes(1);
    expect((createTicketMock.mock.calls[0]![0] as Record<string, unknown>).orgId).toBe('org-a');
    expect(inboundOf()[0]!.ticketId).toBe('t-own-org');
  });

  it('EXPLOIT: the CLOSED-ticket token path is bound too (no linked ticket in the victim org)', async () => {
    state.selectRows['tickets'] = [victimTicket({ id: 't-closed-victim', status: 'closed' })];

    await processInboundEmail(email({
      from: 'attacker@evil.example',
      subject: `Re: [${VICTIM_TOKEN}] reopening this`,
    }));

    expect(createTicketMock).not.toHaveBeenCalled();
    expect(comments()).toHaveLength(0);
    expect(inboundOf()[0]!.parseStatus).toBe('quarantined');
  });

  it('ALLOWED: the ticket requester replying by token still matches (comment + reopen)', async () => {
    await processInboundEmail(email({
      from: 'Victim@Customer-B.example', // case-insensitive match on submitter_email
      subject: `Re: [${VICTIM_TOKEN}] any update?`,
    }));

    expect(comments()).toHaveLength(1);
    expect(comments()[0]!.isPublic).toBe(true);
    expect(reopened()).toHaveLength(1);
    expect(inboundOf()[0]!.parseStatus).toBe('matched');
    expect(inboundOf()[0]!.ticketId).toBe('t-victim');
  });

  it('ALLOWED: a portal user / email contact in the ticket org matches by token', async () => {
    state.selectRows['tickets'] = [victimTicket({ submitterEmail: null, submittedBy: null })];
    state.selectRows['portal_users'] = [{ id: 'pu-b2', orgId: 'org-b' }];

    await processInboundEmail(email({
      from: 'colleague@customer-b.example',
      subject: `Re: [${VICTIM_TOKEN}] adding myself`,
    }));

    expect(comments()).toHaveLength(1);
    expect(comments()[0]!.portalUserId).toBe('pu-b2');
    expect(inboundOf()[0]!.parseStatus).toBe('matched');
  });

  it('ALLOWED: a sender whose domain is mapped to the ticket org matches by token', async () => {
    state.selectRows['tickets'] = [victimTicket({ submitterEmail: null, submittedBy: null })];
    resolveOrgMock.mockResolvedValue({ orgId: 'org-b', autoCreateContact: false });

    await processInboundEmail(email({
      from: 'newperson@customer-b.example',
      subject: `Re: [${VICTIM_TOKEN}] hello`,
    }));

    expect(comments()).toHaveLength(1);
    expect(inboundOf()[0]!.parseStatus).toBe('matched');
  });

  it('UNCHANGED: the unguessable thread-key path still matches without any sender binding', async () => {
    await processInboundEmail(email({
      from: 'stranger@somewhere.example',
      subject: 'no token here at all',
      inReplyTo: '<anchor-b@tickets.example.com>',
    }));

    expect(comments()).toHaveLength(1);
    expect(inboundOf()[0]!.parseStatus).toBe('matched');
    expect(inboundOf()[0]!.ticketId).toBe('t-victim');
  });
});


describe('processInboundEmail — cross-channel claim ledger (spec §4)', () => {
  beforeEach(() => {
    resolveMock.mockResolvedValue('p-1');
    state.selectRows['organizations'] = [{ id: 'o-dom' }];
  });

  it('short-circuits a message the add-in already claimed: no ticket, no comment, matched audit row', async () => {
    findLinkByMessageIdMock.mockResolvedValue({
      id: 'link-1',
      ticketId: 't-addin',
      orgId: 'o-1',
      partnerId: 'p-1',
      messageId: '<msg-1@customer.com>',
      commentId: null,
      origin: 'addin_create',
      visibility: 'public',
      linkedBy: 'u-tech'
    });

    await processInboundEmail(email());

    expect(createTicketMock).not.toHaveBeenCalled();
    expect(claimMessageLinkMock).not.toHaveBeenCalled();
    expect(inboundOf('ticket_comments')).toHaveLength(0);
    const rows = inboundOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.parseStatus).toBe('matched');
    expect(rows[0]!.ticketId).toBe('t-addin');
    expect(String(rows[0]!.error)).toContain('addin_create');
  });

  it('does not consult the ledger when the message carries no Message-ID', async () => {
    await processInboundEmail(email({ messageId: undefined }));
    expect(findLinkByMessageIdMock).not.toHaveBeenCalled();
  });

  it('reports (never swallows) a lost claim on the create path', async () => {
    resolveOrgMock.mockResolvedValue({ orgId: 'o-dom', autoCreateContact: false });
    claimMessageLinkMock.mockResolvedValue({
      created: false,
      existing: { id: 'link-9', ticketId: 't-winner', orgId: 'o-dom', partnerId: 'p-1' }
    });

    await processInboundEmail(email());

    expect(captureMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('lost the message-id claim race'),
      expect.objectContaining({ eventCode: 'inbound_email_claim_race_lost' })
    );
    // Both ticket ids are asserted on the audit row below (rows[0].error), which
    // is the record that actually persists; the `extra` bag they used to be
    // checked in never left the process.
    const rows = inboundOf();
    expect(rows[0]!.parseStatus).toBe('created');
    expect(String(rows[0]!.error)).toContain('t-winner');
  });
});
