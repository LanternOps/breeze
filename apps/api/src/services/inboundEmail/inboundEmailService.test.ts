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

vi.mock('../../db', () => {
  // select(cols).from(table).where().limit() and .innerJoin().where().limit()
  function makeSelect() {
    let resolvedTable = 'unknown';
    let statusConstraint: { op: string; value: string } | null = null;
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
        return Promise.resolve(rows);
      }
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
    internalNumber: 'internalNumber', resolvedAt: 'resolvedAt', updatedAt: 'updatedAt'
  },
  ticketComments: { __t: 'ticket_comments', ticketId: 'ticketId' },
  portalUsers: { __t: 'portal_users', id: 'id', orgId: 'orgId', email: 'email' },
  organizations: { __t: 'organizations', id: 'id', partnerId: 'partnerId' },
  partners: { __t: 'partners', id: 'id', status: 'status' }
}));

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));

// createFromEmail's stable-anchor fallback reads TICKETS_INBOUND_DOMAIN via getConfig().
vi.mock('../../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));

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

// PR3: createFromEmail's known-sender path now calls maybeSendAutoresponse. Stub it
// so these dispatch-service tests don't reach into Redis/emit — the gate has its own
// unit suite (autoresponder.test.ts). The `created`-path assertions here only care
// that a ticket was created + the inbound row logged.
const { maybeSendAutoresponseMock } = vi.hoisted(() => ({ maybeSendAutoresponseMock: vi.fn() }));
vi.mock('./autoresponder', () => ({ maybeSendAutoresponse: maybeSendAutoresponseMock }));

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
