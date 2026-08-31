import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// P2-4 (#4191): link_device and draft, plus the ai_agent-principal routing
// of update_fields/comment. Real drizzle-orm + REAL schema (not the flat-
// string `../db/schema` mock aiToolsTicketing.writeGaps.test.ts uses) — the
// draft executor's serialization is security/correctness-critical (it is
// what keeps two concurrent drafts of the same kind from both landing
// 'active'), so it is asserted on COMPILED SQL via
// `new PgDialect().sqlToQuery(...)` rather than a mock-echo, matching the
// vacuous-Drizzle-assertion rule (CLAUDE.md) and ticketService.aiExecutors.test.ts's
// precedent in this same PR.
const dialect = new PgDialect();
function sqlOf(fragment: unknown) {
  return dialect.sqlToQuery(fragment as never);
}

const TICKET_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '66666666-6666-6666-6666-666666666666';
const RUN_ID = '77777777-7777-7777-7777-777777777777';

const { serviceMocks, dbState } = vi.hoisted(() => ({
  serviceMocks: {
    createTicket: vi.fn(),
    changeTicketStatus: vi.fn(),
    assignTicket: vi.fn(),
    addTicketComment: vi.fn(),
    addAiTriageNote: vi.fn(),
    applyAiFieldUpdates: vi.fn(),
    updateTicketFields: vi.fn(),
    linkAlertToTicket: vi.fn(),
    unlinkAlertFromTicket: vi.fn(),
    createTicketFromAlert: vi.fn(),
    editTicketComment: vi.fn(),
    deleteTicketComment: vi.fn(),
    moveTicketOrg: vi.fn(),
  },
  dbState: {
    selectQueues: new Map<unknown, unknown[][]>(),
    txSelectQueues: new Map<unknown, unknown[][]>(),
    updateReturningQueue: [] as unknown[][],
    txInsertReturningQueue: [] as Array<unknown[] | Error>,
  },
}));

const topUpdateSetMock = vi.fn();
const topUpdateWhereMock = vi.fn();
const txSelectWhereMock = vi.fn();
const txSelectForMock = vi.fn();
const txInsertValuesMock = vi.fn();
const txUpdateSetMock = vi.fn();
const txUpdateWhereMock = vi.fn();
const deviceSelectWhereMock = vi.fn();

function awaitable(rows: unknown[], extra: Record<string, unknown> = {}) {
  return Object.assign(Promise.resolve(rows), extra);
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn((w: unknown) => {
            deviceSelectWhereMock(w);
            return {
              limit: vi.fn(() => Promise.resolve((dbState.selectQueues.get(table) ?? []).shift() ?? [])),
            };
          }),
        })),
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve((dbState.selectQueues.get(table) ?? []).shift() ?? [])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: unknown) => {
        topUpdateSetMock(v);
        return {
          where: vi.fn((w: unknown) => {
            topUpdateWhereMock(w);
            return { returning: vi.fn(() => Promise.resolve(dbState.updateReturningQueue.shift() ?? [])) };
          }),
        };
      }),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn((table: unknown) => ({
            where: vi.fn((w: unknown) => {
              txSelectWhereMock(w);
              return {
                limit: vi.fn(() => {
                  const rows = (dbState.txSelectQueues.get(table) ?? []).shift() ?? [];
                  return awaitable(rows, {
                    for: vi.fn((mode: string) => { txSelectForMock(mode); return Promise.resolve(rows); }),
                  });
                }),
              };
            }),
          })),
        })),
        insert: vi.fn(() => ({
          values: vi.fn((v: unknown) => {
            txInsertValuesMock(v);
            return {
              returning: vi.fn(() => {
                const next = dbState.txInsertReturningQueue.shift();
                if (next instanceof Error) return Promise.reject(next);
                if (next) return Promise.resolve(next);
                // No canned value queued: echo back the id actually passed to
                // .values() — this is what lets a test prove the new row's id
                // (client-generated) really is what got written as the old
                // row's supersededBy, rather than a coincidentally-matching
                // fixture value.
                const insertedId = (v as { id?: string }).id;
                return Promise.resolve(insertedId ? [{ id: insertedId }] : []);
              }),
            };
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn((v: unknown) => {
            txUpdateSetMock(v);
            return { where: vi.fn((w: unknown) => { txUpdateWhereMock(w); return Promise.resolve(undefined); }) };
          }),
        })),
      };
      return fn(tx);
    }),
  },
}));

vi.mock('../middleware/auth', () => ({
  siteAccessCheck: (allowed: string[]) => (siteId?: string | null) => !!siteId && allowed.includes(siteId),
  isAiAgentPrincipal: (auth: { principal?: { kind?: string } }) => auth?.principal?.kind === 'ai_agent',
}));

vi.mock('../routes/tickets/siteScope', () => ({
  deviceInSiteScope: vi.fn().mockResolvedValue(true),
  ticketSiteScopeCondition: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./permissions', () => ({
  getUserPermissions: vi.fn(),
  hasPermission: vi.fn(),
  PERMISSIONS: { TICKETS_MANAGE: { resource: 'tickets', action: 'manage' } },
}));

vi.mock('./ticketService', async () => {
  const actual = await vi.importActual<typeof import('./ticketService')>('./ticketService');
  return { ...actual, ...serviceMocks };
});

vi.mock('./timeEntryService', () => ({
  createTimeEntry: vi.fn(),
  startTimer: vi.fn(),
  stopTimer: vi.fn(),
  TimeEntryServiceError: class TimeEntryServiceError extends Error {},
}));

vi.mock('./ticketConfigService', () => ({
  findStatusByName: vi.fn(),
  listActiveStatusNames: vi.fn(),
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerTicketingTools } from './aiToolsTicketing';
import { tickets, devices, deviceHardware, ticketDrafts } from '../db/schema';

function getTool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerTicketingTools(tools);
  const tool = tools.get('manage_tickets');
  if (!tool) throw new Error('manage_tickets not registered');
  return tool;
}

function queueSelect(table: unknown, rows: unknown[]) {
  if (!dbState.selectQueues.has(table)) dbState.selectQueues.set(table, []);
  dbState.selectQueues.get(table)!.push(rows);
}

function queueTxSelect(table: unknown, rows: unknown[]) {
  if (!dbState.txSelectQueues.has(table)) dbState.txSelectQueues.set(table, []);
  dbState.txSelectQueues.get(table)!.push(rows);
}

function makeAgentAuth(): AuthContext {
  return {
    principal: { kind: 'ai_agent', agentId: 'agent-1', runId: RUN_ID },
    user: { id: 'agent-1', email: 'agent+agent-1@breeze.internal', name: 'Triage Agent', isPlatformAdmin: false },
    token: null,
    partnerId: 'partner-1',
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: vi.fn(() => undefined),
    canAccessOrg: vi.fn(() => true),
  } as unknown as AuthContext;
}

function makeHumanAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech User', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: 'partner-1',
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: vi.fn(() => undefined),
    canAccessOrg: vi.fn(() => true),
  } as unknown as AuthContext;
}

function accessibleTicket(overrides: Record<string, unknown> = {}) {
  return { id: TICKET_ID, orgId: ORG_ID, partnerId: 'partner-1', deviceId: null, categoryId: null, priority: 'normal', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectQueues.clear();
  dbState.txSelectQueues.clear();
  dbState.updateReturningQueue.length = 0;
  dbState.txInsertReturningQueue.length = 0;
});

describe('link_device (P2-4, #4191)', () => {
  it('links when exactly one device matches by hostname and the ticket is currently unlinked', async () => {
    queueSelect(tickets, [accessibleTicket()]);
    queueSelect(devices, [{ id: DEVICE_ID }]);
    dbState.updateReturningQueue.push([{ id: TICKET_ID }]);

    const out = await getTool().handler(
      { action: 'link_device', ticketId: TICKET_ID, hostname: 'WKS-042' },
      makeAgentAuth(),
    );

    expect(JSON.parse(out)).toEqual({ linked: true, deviceId: DEVICE_ID });
    const setArg = topUpdateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.deviceId).toBe(DEVICE_ID);
    const provenanceSql = sqlOf(setArg.fieldProvenance);
    expect(provenanceSql.sql.toLowerCase()).toContain('||');
    const whereSql = sqlOf(topUpdateWhereMock.mock.calls[0]![0]);
    expect(whereSql.sql.toLowerCase()).toContain('"device_id" is null');

    // The device-matching query itself excludes ephemeral AND decommissioned
    // devices — never a sane link target (Minor fix, review round). Booleans
    // are parameterized by drizzle too, so this asserts column + params, not
    // a literal `= false` substring.
    const deviceWhereSql = sqlOf(deviceSelectWhereMock.mock.calls[0]![0]);
    expect(deviceWhereSql.sql.toLowerCase()).toContain('"is_ephemeral" = $');
    expect(deviceWhereSql.sql.toLowerCase()).toContain('"status" <> $');
    expect(deviceWhereSql.params).toEqual(expect.arrayContaining([false, 'decommissioned']));
  });

  it('is a no-op with reason "no_match" when zero devices match', async () => {
    queueSelect(tickets, [accessibleTicket()]);
    queueSelect(devices, []);

    const out = await getTool().handler(
      { action: 'link_device', ticketId: TICKET_ID, hostname: 'GHOST-1' },
      makeAgentAuth(),
    );

    expect(JSON.parse(out)).toEqual({ linked: false, reason: 'no_match' });
    expect(topUpdateSetMock).not.toHaveBeenCalled();
  });

  it('is a no-op with reason "multiple_matches" when more than one device matches', async () => {
    queueSelect(tickets, [accessibleTicket()]);
    queueSelect(devices, [{ id: 'dev-a' }, { id: 'dev-b' }]);

    const out = await getTool().handler(
      { action: 'link_device', ticketId: TICKET_ID, hostname: 'AMBIGUOUS' },
      makeAgentAuth(),
    );

    expect(JSON.parse(out)).toEqual({ linked: false, reason: 'multiple_matches' });
    expect(topUpdateSetMock).not.toHaveBeenCalled();
  });

  it('is a no-op with reason "already_linked" when the ticket already has a device', async () => {
    queueSelect(tickets, [accessibleTicket({ deviceId: 'existing-device' })]);
    queueSelect(devices, [{ id: DEVICE_ID }]);

    const out = await getTool().handler(
      { action: 'link_device', ticketId: TICKET_ID, hostname: 'WKS-042' },
      makeAgentAuth(),
    );

    expect(JSON.parse(out)).toEqual({ linked: false, reason: 'already_linked' });
    expect(topUpdateSetMock).not.toHaveBeenCalled();
  });

  it('loses the race (CAS WHERE device_id IS NULL matches zero rows) => already_linked, never an error', async () => {
    queueSelect(tickets, [accessibleTicket()]);
    queueSelect(devices, [{ id: DEVICE_ID }]);
    dbState.updateReturningQueue.push([]); // lost the race

    const out = await getTool().handler(
      { action: 'link_device', ticketId: TICKET_ID, hostname: 'WKS-042' },
      makeAgentAuth(),
    );

    expect(JSON.parse(out)).toEqual({ linked: false, reason: 'already_linked' });
  });

  it('requires hostname or serial', async () => {
    const out = await getTool().handler({ action: 'link_device', ticketId: TICKET_ID }, makeAgentAuth());
    expect(JSON.parse(out)).toEqual({ error: 'hostname or serial is required for link_device action' });
  });
});

describe('draft (P2-4, #4191)', () => {
  it('inserts a new active draft when there is no existing one, org_id pinned and run_id from the agent principal', async () => {
    queueSelect(tickets, [accessibleTicket()]);
    queueTxSelect(ticketDrafts, []); // no existing active draft
    dbState.txInsertReturningQueue.push([{ id: 'draft-1' }]);

    const out = await getTool().handler(
      { action: 'draft', ticketId: TICKET_ID, kind: 'reply', content: 'Have you tried rebooting?' },
      makeAgentAuth(),
    );

    expect(JSON.parse(out)).toEqual({ draft: { id: 'draft-1' } });
    const insertArg = txInsertValuesMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertArg).toMatchObject({ orgId: ORG_ID, ticketId: TICKET_ID, runId: RUN_ID, kind: 'reply' });
    expect(txUpdateSetMock).not.toHaveBeenCalled(); // nothing to supersede
  });

  it('supersedes an existing active draft of the same kind — serialized via SELECT ... FOR UPDATE', async () => {
    queueSelect(tickets, [accessibleTicket()]);
    queueTxSelect(ticketDrafts, [{ id: 'old-draft' }]);
    // Deliberately NOT queuing a canned insert-returning value here: letting
    // the mock's default echo-the-inserted-id behavior fire is what proves
    // the id flowing into supersededBy is the REAL client-generated id, not
    // a fixture value that only coincidentally matches (review round fix —
    // the bug this catches: superseding AFTER insert instead of before).

    const out = await getTool().handler(
      { action: 'draft', ticketId: TICKET_ID, kind: 'resolution_note', content: 'Root cause: disk full.' },
      makeAgentAuth(),
    );

    // The lock must be a real FOR UPDATE, not a plain read — never a
    // vacuous mock-echo (CLAUDE.md): assert the code actually calls
    // `.for('update')` on the select chain AND, on compiled SQL, that the
    // WHERE clause names ticket_id/kind/state='active' (not some other
    // column, which would make the lock meaningless).
    expect(txSelectForMock).toHaveBeenCalledWith('update');
    expect(txSelectWhereMock).toHaveBeenCalledTimes(1);
    const whereSql = sqlOf(txSelectWhereMock.mock.calls[0]![0]);
    expect(whereSql.sql.toLowerCase()).toContain('"ticket_id" = $');
    expect(whereSql.sql.toLowerCase()).toContain('"kind" = $');
    expect(whereSql.sql.toLowerCase()).toContain("\"state\" = $");
    expect(whereSql.params).toEqual([TICKET_ID, 'resolution_note', 'active']);

    // ORDERING (the actual bug): the old row must be superseded BEFORE the
    // new row is inserted, never the reverse — inserting first collides
    // with ticket_drafts_active_uq (a plain, non-deferrable partial unique
    // index) on every normal supersession, not just a genuine concurrent
    // race.
    expect(txUpdateSetMock).toHaveBeenCalledTimes(1);
    expect(txInsertValuesMock).toHaveBeenCalledTimes(1);
    const updateOrder = txUpdateSetMock.mock.invocationCallOrder[0]!;
    const insertOrder = txInsertValuesMock.mock.invocationCallOrder[0]!;
    expect(updateOrder).toBeLessThan(insertOrder);

    // The old draft is superseded, pointing at the new one — and that new
    // id is EXACTLY the id the INSERT actually wrote (not merely a fixture
    // that happens to match), and exactly what the caller gets back.
    const updateSetArg = txUpdateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    const insertValuesArg = txInsertValuesMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(updateSetArg.state).toBe('superseded');
    expect(updateSetArg.supersededBy).toBe(insertValuesArg.id);
    expect(JSON.parse(out)).toEqual({ draft: { id: insertValuesArg.id } });

    const updateWhereSql = sqlOf(txUpdateWhereMock.mock.calls[0]![0]);
    expect(updateWhereSql.sql.toLowerCase()).toContain('"id" = $');
    expect(updateWhereSql.params).toContain('old-draft');
  });

  it('retries once on a partial-unique race (23505) and returns the winning row after a fresh read', async () => {
    queueSelect(tickets, [accessibleTicket()]);
    // First attempt: no existing active draft observed, but the INSERT itself
    // loses the race against a concurrent writer (23505).
    queueTxSelect(ticketDrafts, []);
    dbState.txInsertReturningQueue.push(Object.assign(new Error('duplicate key'), { code: '23505' }));
    // Retry: now sees the concurrent winner as the existing active draft and supersedes it.
    queueTxSelect(ticketDrafts, [{ id: 'concurrent-winner' }]);
    dbState.txInsertReturningQueue.push([{ id: 'our-draft-after-retry' }]);

    const out = await getTool().handler(
      { action: 'draft', ticketId: TICKET_ID, kind: 'reply', content: 'retry content' },
      makeAgentAuth(),
    );

    expect(JSON.parse(out)).toEqual({ draft: { id: 'our-draft-after-retry' } });
  });

  it('requires kind and content', async () => {
    const noKind = await getTool().handler({ action: 'draft', ticketId: TICKET_ID, content: 'x' }, makeAgentAuth());
    expect(JSON.parse(noKind)).toEqual({ error: 'kind (reply or resolution_note) is required for draft action' });

    const noContent = await getTool().handler({ action: 'draft', ticketId: TICKET_ID, kind: 'reply' }, makeAgentAuth());
    expect(JSON.parse(noContent)).toEqual({ error: 'content is required for draft action' });
  });
});

describe('update_fields routes ai_agent-principal calls to applyAiFieldUpdates, human calls unaffected (P2-4, #4191)', () => {
  it('ai_agent principal routes to applyAiFieldUpdates with expectedCurrent from the freshly-read ticket', async () => {
    queueSelect(tickets, [accessibleTicket({ categoryId: 'old-cat', priority: 'normal' })]);
    serviceMocks.applyAiFieldUpdates.mockResolvedValue({ priority: { applied: true } });

    const out = await getTool().handler(
      { action: 'update_fields', ticketId: TICKET_ID, fields: { priority: 'high' } },
      makeAgentAuth(),
    );

    expect(JSON.parse(out)).toEqual({ fields: { priority: { applied: true } } });
    expect(serviceMocks.applyAiFieldUpdates).toHaveBeenCalledWith(
      TICKET_ID,
      ORG_ID,
      { priority: { value: 'high', expectedCurrent: 'normal' } },
      RUN_ID,
    );
    expect(serviceMocks.updateTicketFields).not.toHaveBeenCalled();
  });

  it('attended-chat (human user_session) is unaffected — still calls updateTicketFields', async () => {
    queueSelect(tickets, [accessibleTicket()]);
    serviceMocks.updateTicketFields.mockResolvedValue({ id: TICKET_ID, subject: 'Updated' });

    const out = await getTool().handler(
      { action: 'update_fields', ticketId: TICKET_ID, fields: { subject: 'Updated' } },
      makeHumanAuth(),
    );

    expect(JSON.parse(out)).toEqual({ ticket: { id: TICKET_ID, subject: 'Updated' } });
    expect(serviceMocks.applyAiFieldUpdates).not.toHaveBeenCalled();
  });

  it('rejects an ai_agent update_fields call naming only unsupported fields', async () => {
    queueSelect(tickets, [accessibleTicket()]);

    const out = await getTool().handler(
      { action: 'update_fields', ticketId: TICKET_ID, fields: { subject: 'New subject' } },
      makeAgentAuth(),
    );

    expect(JSON.parse(out)).toEqual({ error: 'An AI agent may only update categoryId and priority via update_fields' });
  });
});

describe('comment routes ai_agent-principal calls to addAiTriageNote (P2-4, #4191)', () => {
  it('ai_agent principal routes to addAiTriageNote, never addTicketComment', async () => {
    queueSelect(tickets, [accessibleTicket()]);
    serviceMocks.addAiTriageNote.mockResolvedValue({ comment: { id: 'note-1' } });

    const out = await getTool().handler(
      { action: 'comment', ticketId: TICKET_ID, content: 'Investigating disk usage.' },
      makeAgentAuth(),
    );

    expect(JSON.parse(out)).toEqual({ comment: { id: 'note-1' } });
    expect(serviceMocks.addAiTriageNote).toHaveBeenCalledWith(TICKET_ID, RUN_ID, 'Investigating disk usage.', ORG_ID);
    expect(serviceMocks.addTicketComment).not.toHaveBeenCalled();
  });

  it('attended-chat (human user_session) is unaffected — still calls addTicketComment', async () => {
    queueSelect(tickets, [accessibleTicket()]);
    serviceMocks.addTicketComment.mockResolvedValue({ comment: { id: 'c-1' }, firstResponseStamped: false });

    const out = await getTool().handler(
      { action: 'comment', ticketId: TICKET_ID, content: 'Human note' },
      makeHumanAuth(),
    );

    expect(JSON.parse(out)).toEqual({ comment: { id: 'c-1' } });
    expect(serviceMocks.addAiTriageNote).not.toHaveBeenCalled();
  });
});
