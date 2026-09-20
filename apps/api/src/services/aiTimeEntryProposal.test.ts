import { AsyncLocalStorage } from 'node:async_hooks';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #4177 (W04) — the AI time-entry PROPOSAL lane.
 *
 * `resolveAiTimeEntryDefaults` and `proposeTimeEntryForAiAssistedWork` are
 * unit-tested against a per-table select queue (the aiExecutors.test pattern)
 * so the two reads this module owns — the ticket→category duration default
 * and the run→agent→org lineage — are pinned by shape. `createActionIntent`
 * and `getTicketTimeEntryDefaults` are collaborators with their own suites
 * and are mocked wholesale.
 */

const { dbState, mocks } = vi.hoisted(() => ({
  dbState: { selectQueues: new Map<unknown, unknown[][]>() },
  mocks: {
    getTicketTimeEntryDefaults: vi.fn(),
    loadCardsForOrg: vi.fn(),
    createActionIntent: vi.fn(),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  },
}));

vi.mock('../db', () => ({
  getCurrentDbAccessContext: () => undefined,
  runOutsideDbContext: (fn: () => unknown) => mocks.runOutsideDbContext(fn),
  withSystemDbAccessContext: (fn: () => unknown) => mocks.withSystemDbAccessContext(fn),
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const next = () => Promise.resolve((dbState.selectQueues.get(table) ?? []).shift() ?? []);
        return {
          leftJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(next) })) })),
          where: vi.fn(() => ({ limit: vi.fn(next) })),
        };
      }),
    })),
  },
}));
vi.mock('./billingProfileService', () => ({ loadCardsForOrg: mocks.loadCardsForOrg }));
vi.mock('./aiAgents/runService', () => ({ createAndEnqueueAgentRun: vi.fn() }));
vi.mock('./timeEntryService', () => ({
  getTicketTimeEntryDefaults: mocks.getTicketTimeEntryDefaults,
}));
vi.mock('./actionIntents/intentService', () => ({
  createActionIntent: mocks.createActionIntent,
  ActionIntentError: class ActionIntentError extends Error {
    constructor(message: string, public code: string) { super(message); this.name = 'ActionIntentError'; }
  },
}));
import { handleTicketStatusChangedEvent } from './aiAgents/ticketHelpdeskSubscriber';
import type { BreezeEvent } from './eventBus';
import { ActionIntentError } from './actionIntents/intentService';

import { aiAgentRuns, aiAgents, devices, organizations, ticketDrafts, tickets } from '../db/schema';
import {
  AI_TIME_ENTRY_DEFAULT_MINUTES,
  proposeTimeEntryForAiAssistedWork,
  proposeTimeEntryFromOutboxClaim,
  resolveAiTimeEntryDefaults,
} from './aiTimeEntryProposal';

const TICKET_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const AGENT_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '66666666-6666-4666-8666-666666666666';

function queueSelect(table: unknown, rows: unknown[]) {
  const q = dbState.selectQueues.get(table) ?? [];
  q.push(rows);
  dbState.selectQueues.set(table, q);
}

function mockCategory(row: { defaultTimeEntryMinutes: number | null } | null) {
  // The ticket→category join projects the category columns; a ticket with no
  // category yields a row whose joined columns are all null.
  queueSelect(tickets, [row ?? { defaultTimeEntryMinutes: null }]);
}

function mockTicketDefaults(d: { isBillable: boolean }) {
  mocks.getTicketTimeEntryDefaults.mockResolvedValueOnce({ hourlyRate: null, currencyCode: 'USD', isBillable: d.isBillable });
}

function mockRunLineage(overrides: { deviceId?: string | null; runOrgId?: string } = {}) {
  queueSelect(aiAgentRuns, [{ id: RUN_ID, agentId: AGENT_ID, orgId: overrides.runOrgId ?? ORG_ID, deviceId: overrides.deviceId ?? null, sessionId: null }]);
  queueSelect(aiAgents, [{ id: AGENT_ID, orgId: null, partnerId: PARTNER_ID, name: 'Helpdesk', kind: 'helpdesk' }]);
  queueSelect(organizations, [{ id: ORG_ID, partnerId: PARTNER_ID }]);
  if (overrides.deviceId) queueSelect(devices, [{ siteId: 'site-1' }]);
  // The lineage read also projects the ticket number for the approval label;
  // it runs BEFORE resolveAiTimeEntryDefaults' join read on the same table.
  queueSelect(tickets, [{ internalNumber: 42 }]);
}

function captureCreateActionIntent(): Array<{ auth: unknown; input: Record<string, unknown> }> {
  const created: Array<{ auth: unknown; input: Record<string, unknown> }> = [];
  mocks.createActionIntent.mockImplementation(async (auth: unknown, input: Record<string, unknown>) => {
    created.push({ auth, input });
    return { id: `intent-${created.length}`, status: 'pending_approval' };
  });
  return created;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectQueues.clear();
  mocks.runOutsideDbContext.mockImplementation((fn: () => unknown) => fn());
  mocks.withSystemDbAccessContext.mockImplementation((fn: () => unknown) => fn());
});

describe('resolveAiTimeEntryDefaults (#4177)', () => {
  it('uses the category duration default when set', async () => {
    mockCategory({ defaultTimeEntryMinutes: 30 });
    mockTicketDefaults({ isBillable: true });
    expect(await resolveAiTimeEntryDefaults(TICKET_ID)).toEqual({ durationMinutes: 30, isBillable: true });
  });

  it('falls back to AI_TIME_ENTRY_DEFAULT_MINUTES when the category has none', async () => {
    mockCategory({ defaultTimeEntryMinutes: null });
    mockTicketDefaults({ isBillable: false });
    expect(AI_TIME_ENTRY_DEFAULT_MINUTES).toBe(15);
    expect(await resolveAiTimeEntryDefaults(TICKET_ID)).toEqual({ durationMinutes: 15, isBillable: false });
  });

  it('takes the billable flag from getTicketTimeEntryDefaults, never from the category directly', async () => {
    mockCategory({ defaultTimeEntryMinutes: null });
    mockTicketDefaults({ isBillable: false }); // org override wins
    expect((await resolveAiTimeEntryDefaults(TICKET_ID)).isBillable).toBe(false);
  });

  it('falls back to non-billable and the constant when the ticket has no category', async () => {
    mockCategory(null);
    mockTicketDefaults({ isBillable: false });
    expect(await resolveAiTimeEntryDefaults(TICKET_ID)).toEqual({ durationMinutes: 15, isBillable: false });
  });

  it('reads the ticket→category join under a system context, escaped from any ambient request context', async () => {
    mockCategory({ defaultTimeEntryMinutes: 20 });
    mockTicketDefaults({ isBillable: false });
    await resolveAiTimeEntryDefaults(TICKET_ID);
    expect(mocks.runOutsideDbContext).toHaveBeenCalled();
    expect(mocks.withSystemDbAccessContext).toHaveBeenCalled();
  });
});

describe('proposeTimeEntryForAiAssistedWork (#4177)', () => {
  const args = { ticketId: TICKET_ID, orgId: ORG_ID, agentRunId: RUN_ID, trigger: 'draft_sent' as const, technicianUserId: USER_ID };

  it('creates a Tier-2 supervised, ticket-scoped, human-required intent under the run\'s agent principal', async () => {
    const created = captureCreateActionIntent();
    mockRunLineage();
    mockCategory({ defaultTimeEntryMinutes: null });
    mockTicketDefaults({ isBillable: false });

    const result = await proposeTimeEntryForAiAssistedWork(args);

    expect(result).toEqual({ intentId: 'intent-1' });
    expect(created).toHaveLength(1);
    const { auth, input } = created[0]!;
    expect(auth).toMatchObject({ principal: { kind: 'ai_agent', agentId: AGENT_ID, runId: RUN_ID }, orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(input).toMatchObject({
      toolName: 'manage_tickets',
      source: 'ai_agent',
      orgId: ORG_ID,
      scope: { ticketId: TICKET_ID },
      idempotencyKey: `ai-time-entry:${RUN_ID}:draft_sent`,
      input: expect.objectContaining({ action: 'log_time_entry', ticketId: TICKET_ID, durationMinutes: 15, isBillable: false, proposedForUserId: USER_ID }),
    });
    // Never an autonomy request — this lane is human-reviewed by construction.
    expect(input).not.toHaveProperty('autonomy');
    expect(input.actionLabel).toBe('Log 15 min on ticket #42');
    // A concrete time block the existing log_time_entry handler can execute,
    // spanning exactly the proposed duration.
    const block = input.input as Record<string, unknown>;
    const started = new Date(String(block.startedAt)).getTime();
    const ended = new Date(String(block.endedAt)).getTime();
    expect(ended - started).toBe(15 * 60_000);
  });

  it('is idempotent per (run, trigger)', async () => {
    const created = captureCreateActionIntent();
    mockRunLineage(); mockCategory({ defaultTimeEntryMinutes: null }); mockTicketDefaults({ isBillable: false });
    await proposeTimeEntryForAiAssistedWork(args);
    mockRunLineage(); mockCategory({ defaultTimeEntryMinutes: null }); mockTicketDefaults({ isBillable: false });
    await proposeTimeEntryForAiAssistedWork(args);
    expect(new Set(created.map((c) => c.input.idempotencyKey)).size).toBe(1);
  });

  it('uses a distinct key per trigger', async () => {
    const created = captureCreateActionIntent();
    mockRunLineage(); mockCategory({ defaultTimeEntryMinutes: null }); mockTicketDefaults({ isBillable: false });
    await proposeTimeEntryForAiAssistedWork({ ...args, trigger: 'resolved_with_ai_note' });
    expect(created[0]!.input.idempotencyKey).toBe(`ai-time-entry:${RUN_ID}:resolved_with_ai_note`);
  });

  it('returns null (no throw) when the intent service REFUSES — a permanent business no', async () => {
    mocks.createActionIntent.mockRejectedValueOnce(new ActionIntentError('denied', 'agent_policy_denied'));
    mockRunLineage(); mockCategory({ defaultTimeEntryMinutes: null }); mockTicketDefaults({ isBillable: false });
    await expect(proposeTimeEntryForAiAssistedWork(args)).resolves.toBeNull();
  });

  it('propagates an infrastructure error so the subscriber\'s retry fires (never masks a DB blip as a business no)', async () => {
    mocks.createActionIntent.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    mockRunLineage(); mockCategory({ defaultTimeEntryMinutes: null }); mockTicketDefaults({ isBillable: false });
    await expect(proposeTimeEntryForAiAssistedWork(args)).rejects.toThrow('connection terminated unexpectedly');
  });

  it('returns null without minting when the run does not belong to the ticket\'s org', async () => {
    const created = captureCreateActionIntent();
    mockRunLineage({ runOrgId: '99999999-9999-4999-8999-999999999999' });
    await expect(proposeTimeEntryForAiAssistedWork(args)).resolves.toBeNull();
    expect(created).toHaveLength(0);
  });

  it('returns null without minting when the run is missing', async () => {
    const created = captureCreateActionIntent();
    queueSelect(aiAgentRuns, []);
    await expect(proposeTimeEntryForAiAssistedWork(args)).resolves.toBeNull();
    expect(created).toHaveLength(0);
  });
});

describe('proposeTimeEntryFromOutboxClaim (#4177) — the outbox claim is a pointer, the draft row is the fact', () => {
  const DRAFT_ID = '77777777-7777-4777-8777-777777777777';
  const claim = { draftId: DRAFT_ID, runId: RUN_ID, trigger: 'draft_sent' };
  const consumedDraft = { id: DRAFT_ID, ticketId: TICKET_ID, orgId: ORG_ID, kind: 'reply', state: 'consumed', runId: RUN_ID, consumedBy: USER_ID };

  function primeMint() {
    mockRunLineage(); mockCategory({ defaultTimeEntryMinutes: null }); mockTicketDefaults({ isBillable: false });
  }

  it('the event-bus handler reads a non_billable card in system scope and proposes non-billable time', async () => {
    const scope = new AsyncLocalStorage<string>();
    mocks.runOutsideDbContext.mockImplementation((fn) => scope.run('none', fn));
    mocks.withSystemDbAccessContext.mockImplementation((fn) => scope.run('system', fn));
    const { getTicketTimeEntryDefaults } = await vi.importActual<typeof import('./timeEntryService')>('./timeEntryService');
    mocks.getTicketTimeEntryDefaults.mockImplementationOnce(getTicketTimeEntryDefaults);
    // Exercise the real defaults and rule resolvers; model FORCE RLS at the
    // card loader, which hides the org's card outside a system context.
    mocks.loadCardsForOrg.mockImplementationOnce(async () => ({
      assignedCard: scope.getStore() === 'system' ? {
        id: 'non-billable-card', currencyCode: 'USD', baseCoverage: 'non_billable',
        baseHourlyRate: null, baseMinimumMinutes: null, roundingIncrementMinutes: null, rules: [],
      } : null,
      partnerDefaultCard: null,
    }));
    const created = captureCreateActionIntent();
    queueSelect(ticketDrafts, [{ ...consumedDraft, kind: 'resolution_note' }]);
    mockRunLineage();
    mockCategory({ defaultTimeEntryMinutes: 20 });
    queueSelect(tickets, [{ id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID, categoryId: null }]);
    queueSelect(organizations, [{ partnerId: PARTNER_ID, currencyCode: 'USD' }]);
    queueSelect(tickets, [{ status: 'resolved', resolutionNote: 'Fixed' }]);

    await scope.run('none', () => handleTicketStatusChangedEvent({
      id: 'event-1', type: 'ticket.status_changed', orgId: ORG_ID,
      source: 'ticket-outbox-publisher', priority: 'normal',
      payload: { ticketId: TICKET_ID, to: 'resolved', aiDraft: { ...claim, trigger: 'resolved_with_ai_note' } },
      metadata: { timestamp: new Date().toISOString() },
    } as BreezeEvent));

    expect(mocks.loadCardsForOrg).toHaveBeenCalledWith(ORG_ID, PARTNER_ID, 'USD');
    expect(created).toHaveLength(1);
    expect(created[0]!.input.input).toMatchObject({ isBillable: false, durationMinutes: 20 });
  });

  it('mints for a verified consumed draft, with the technician taken from consumed_by (never the payload)', async () => {
    const created = captureCreateActionIntent();
    queueSelect(ticketDrafts, [consumedDraft]);
    primeMint();

    const result = await proposeTimeEntryFromOutboxClaim({ orgId: ORG_ID, ticketId: TICKET_ID, claim: { ...claim, technicianUserId: 'forged' } });

    expect(result).toEqual({ intentId: 'intent-1' });
    expect((created[0]!.input.input as Record<string, unknown>).proposedForUserId).toBe(USER_ID);
    expect(created[0]!.input.idempotencyKey).toBe(`ai-time-entry:${RUN_ID}:draft_sent`);
  });

  it.each([
    ['missing draft', []],
    ['wrong ticket', [{ ...consumedDraft, ticketId: '99999999-9999-4999-8999-999999999999' }]],
    ['wrong org', [{ ...consumedDraft, orgId: '99999999-9999-4999-8999-999999999999' }]],
    ['not consumed', [{ ...consumedDraft, state: 'active' }]],
    ['run mismatch', [{ ...consumedDraft, runId: '99999999-9999-4999-8999-999999999999' }]],
    ['kind/trigger mismatch (resolution note claimed as draft_sent)', [{ ...consumedDraft, kind: 'resolution_note' }]],
    ['no consumer', [{ ...consumedDraft, consumedBy: null }]],
  ])('drops the claim without minting when the draft row disagrees: %s', async (_label, rows) => {
    const created = captureCreateActionIntent();
    queueSelect(ticketDrafts, rows as unknown[]);
    await expect(proposeTimeEntryFromOutboxClaim({ orgId: ORG_ID, ticketId: TICKET_ID, claim })).resolves.toBeNull();
    expect(created).toHaveLength(0);
  });

  it('a resolution-note draft mints under the resolved_with_ai_note trigger', async () => {
    const created = captureCreateActionIntent();
    queueSelect(ticketDrafts, [{ ...consumedDraft, kind: 'resolution_note' }]);
    primeMint();
    await expect(proposeTimeEntryFromOutboxClaim({ orgId: ORG_ID, ticketId: TICKET_ID, claim: { ...claim, trigger: 'resolved_with_ai_note' } })).resolves.toEqual({ intentId: 'intent-1' });
    expect(created[0]!.input.idempotencyKey).toBe(`ai-time-entry:${RUN_ID}:resolved_with_ai_note`);
  });

  it('propagates a DB error during draft verification (retry-worthy)', async () => {
    mocks.withSystemDbAccessContext.mockImplementationOnce(async () => { throw new Error('pool timeout'); });
    await expect(proposeTimeEntryFromOutboxClaim({ orgId: ORG_ID, ticketId: TICKET_ID, claim })).rejects.toThrow('pool timeout');
  });

  it.each([
    ['not an object', 'x'],
    ['missing runId', { draftId: DRAFT_ID, trigger: 'draft_sent' }],
    ['unknown trigger', { draftId: DRAFT_ID, runId: RUN_ID, trigger: 'bogus' }],
  ])('drops a malformed claim before any read: %s', async (_label, bad) => {
    const created = captureCreateActionIntent();
    await expect(proposeTimeEntryFromOutboxClaim({ orgId: ORG_ID, ticketId: TICKET_ID, claim: bad })).resolves.toBeNull();
    expect(created).toHaveLength(0);
    expect(mocks.withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});
