import { describe, it, expect, vi, beforeEach } from 'vitest';

const { serviceMocks, timeEntryMocks, ticketConfigMocks } = vi.hoisted(() => ({
  serviceMocks: {
    createTicket: vi.fn(),
    changeTicketStatus: vi.fn(),
    assignTicket: vi.fn(),
    addTicketComment: vi.fn()
  },
  timeEntryMocks: {
    createTimeEntry: vi.fn(),
    startTimer: vi.fn(),
    stopTimer: vi.fn()
  },
  ticketConfigMocks: {
    findStatusByName: vi.fn(),
    listActiveStatusNames: vi.fn()
  }
}));

vi.mock('./ticketService', async () => {
  const actual = await vi.importActual<typeof import('./ticketService')>('./ticketService');
  return { ...actual, ...serviceMocks };
});

vi.mock('./timeEntryService', async () => {
  const actual = await vi.importActual<typeof import('./timeEntryService')>('./timeEntryService');
  return { ...actual, ...timeEntryMocks };
});

vi.mock('./ticketConfigService', async () => {
  const actual = await vi.importActual<typeof import('./ticketConfigService')>('./ticketConfigService');
  return { ...actual, ...ticketConfigMocks };
});

const workTypeMocks = vi.hoisted(() => ({ listWorkTypes: vi.fn() }));
vi.mock('./workTypeService', () => workTypeMocks);

// #5808 W03 — `get` now returns a READ-ONLY checklist summary. Mocked so these
// cases pin exactly WHAT is exposed (labels + progress) and what is not
// (per-step detail, and the completer's id — an attestation, not context).
const checklistMocks = vi.hoisted(() => ({ listChecklist: vi.fn() }));
vi.mock('./ticketChecklistService', async () => {
  const actual = await vi.importActual<typeof import('./ticketChecklistService')>('./ticketChecklistService');
  return { ...actual, ...checklistMocks };
});

// Mutable handle so individual tests can override the limit() return value
// (typed as returning unknown[] so mockResolvedValue(TICKET_ROW) compiles),
// plus shared spies so the site-scope tests can assert on (a) how many
// selects a list call issues (the devices IN-subquery is a second select)
// and (b) the condition the list query hands to .where(). The returned shape
// supports both the list chain (where → orderBy → limit) and the by-id chain
// (where → limit). Hoisted because the vi.mock factory references them.
const { mockLimit, mockWhere, mockSelect } = vi.hoisted(() => {
  const mockLimit = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));
  const mockWhere = vi.fn((..._args: unknown[]) => ({
    orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
    limit: mockLimit
  }));
  const mockSelect = vi.fn(() => ({
    from: vi.fn(() => ({ where: mockWhere }))
  }));
  return { mockLimit, mockWhere, mockSelect };
});

vi.mock('../db', () => ({
  db: { select: mockSelect }
}));

// The REAL routes/tickets/siteScope module is exercised below (the list
// action must route through ticketSiteScopeCondition), but it imports
// siteAccessCheck from middleware/auth at module load. ticketSiteScopeCondition
// never calls it — stub the module so this unit test doesn't drag in the full
// auth middleware dependency tree (jwt/permissions/token revocation).
vi.mock('../middleware/auth', () => ({
  siteAccessCheck: (allowed: string[]) => (siteId?: string | null) =>
    !!siteId && allowed.includes(siteId),
  isAiAgentPrincipal: (auth: { principal?: { kind?: string } }) => auth?.principal?.kind === 'ai_agent'
}));

vi.mock('../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema')>();
  return {
    ...actual,
    tickets: {
      id: 'id',
      orgId: 'orgId',
      status: 'status',
      priority: 'priority',
      assignedTo: 'assignedTo',
      createdAt: 'createdAt',
      internalNumber: 'internalNumber',
      subject: 'subject',
      deviceId: 'deviceId'
    }
  };
});

import { registerTicketingTools } from './aiToolsTicketing';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';

// Default auth: partner scope with access to 'o-1'.
const auth: AuthContext = {
  principal: { kind: 'user_session' },
  user: { id: 'u-1', email: 'tech@example.com', name: 'Tech User', isPlatformAdmin: false },
  token: {} as never,
  partnerId: 'p-1',
  orgId: 'o-1',
  scope: 'partner',
  accessibleOrgIds: ['o-1'],
  orgCondition: vi.fn(() => undefined),
  canAccessOrg: vi.fn(() => true),
};

// Auth with canAccessOrg returning false (simulates a caller without access to a given org).
const authNoOrg: AuthContext = {
  ...auth,
  canAccessOrg: vi.fn(() => false),
};

// Site-restricted org-scope caller (mirrors makeAuth in the sibling
// aiTools*.siteScope.test.ts files).
function makeSiteAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    ...auth,
    scope: 'organization',
    partnerId: null,
    orgId: 'o-1',
    allowedSiteIds,
    canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  };
}

const TICKET_ROW = [{ id: 't-1', orgId: 'o-1', subject: 'Disk full', status: 'open', priority: 'normal' }];

function getTool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerTicketingTools(tools);
  const tool = tools.get('manage_tickets');
  if (!tool) throw new Error('manage_tickets not registered');
  return tool;
}

describe('manage_tickets tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: ticket not found (empty rows).
    mockLimit.mockResolvedValue([]);
    // Default: the ticket has no checklist (#5808 W03).
    checklistMocks.listChecklist.mockResolvedValue({ done: 0, total: 0, items: [] });
    // Default: status name resolution finds nothing.
    ticketConfigMocks.findStatusByName.mockResolvedValue(null);
    ticketConfigMocks.listActiveStatusNames.mockResolvedValue([]);
  });

  it('registers with deviceArgs gating and tier 1 (mutations escalated via TIER2_ACTIONS)', () => {
    const tool = getTool();
    expect(tool.tier).toBe(1);
    expect(tool.deviceArgs).toContain('deviceId');
  });

  // ── create ────────────────────────────────────────────────────────────────

  it('create delegates to ticketService with source ai', async () => {
    serviceMocks.createTicket.mockResolvedValue({ id: 't-1', internalNumber: 'T-2026-0042' });
    const out = await getTool().handler(
      { action: 'create', orgId: 'o-1', subject: 'Disk full' },
      auth
    );
    expect(serviceMocks.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'ai' }),
      expect.objectContaining({ userId: 'u-1' })
    );
    expect(JSON.parse(out)).toHaveProperty('ticket');
  });

  it('create returns error when caller cannot access the target org', async () => {
    const out = await getTool().handler(
      { action: 'create', orgId: 'other-org', subject: 'Sneaky ticket' },
      authNoOrg
    );
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/access.*organization denied/i);
    expect(serviceMocks.createTicket).not.toHaveBeenCalled();
  });

  // #5075 W04 — Service Management 'off' refuses new-ticket creation.
  // ticketService.createTicket rejects with a TicketServiceError(409,
  // 'service_management_off'); the create action must convert that to JSON
  // (like every other mutating action here) rather than let it escape as an
  // unhandled rejection out of the AI tool-call loop.
  it('create returns error JSON (not throws) when TicketServiceError is raised (service_management_off)', async () => {
    const { TicketServiceError: TSE } = await vi.importActual<typeof import('./ticketService')>('./ticketService');
    serviceMocks.createTicket.mockRejectedValue(
      new TSE('Service Management is turned off for this partner', 409, 'service_management_off')
    );

    const out = await getTool().handler(
      { action: 'create', orgId: 'o-1', subject: 'Disk full' },
      auth
    );

    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error', 'Service Management is turned off for this partner');
    expect(parsed).toHaveProperty('code', 'service_management_off');
  });

  // ── list ──────────────────────────────────────────────────────────────────

  it('list returns tickets array', async () => {
    const out = await getTool().handler({ action: 'list' }, auth);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('tickets');
    expect(Array.isArray(parsed.tickets)).toBe(true);
  });

  // ── get ───────────────────────────────────────────────────────────────────

  it('get returns ticket when found in scope', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    const out = await getTool().handler({ action: 'get', ticketId: 't-1' }, auth);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('ticket');
    expect(parsed.ticket.id).toBe('t-1');
  });

  it('get returns error for missing ticket (empty scoped select)', async () => {
    // mockLimit already returns [] by default from beforeEach.
    const out = await getTool().handler({ action: 'get', ticketId: '3f2f1d8e-0000-0000-0000-000000000001' }, auth);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/not found/i);
  });

  it('get always applies the soft-delete filter (excludes deleted tickets)', async () => {
    // Phase 6: findTicketWithAccess must gate on isNull(tickets.deletedAt) so a
    // soft-deleted ticket resolves as not-found even when its id is guessed.
    // Regression guard: dropping that predicate would remove the "is null" clause
    // from the WHERE the scoped by-id select hands to .where().
    mockLimit.mockResolvedValue(TICKET_ROW);
    await getTool().handler({ action: 'get', ticketId: 't-1' }, auth);
    const whereArg = mockWhere.mock.calls.at(-1)?.[0];
    expect(whereArg).toBeDefined();
    expect(JSON.stringify(whereArg)).toContain('is null');
  });

  // ── #5808 W03: read-only checklist exposure ───────────────────────────────

  it('get includes the checklist summary and ordered labels', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    checklistMocks.listChecklist.mockResolvedValue({
      done: 1,
      total: 2,
      items: [
        { id: 'c1', ticketId: 't-1', label: 'A', detail: 'secret runbook step', position: 0, done: true, doneAt: '2026-01-01T00:00:00.000Z', doneByUserId: 'u-9', source: 'deliverable', sourceTemplateItemId: 'ti-1', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'c2', ticketId: 't-1', label: 'B', detail: null, position: 1, done: false, doneAt: null, doneByUserId: null, source: 'deliverable', sourceTemplateItemId: 'ti-2', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    const parsed = JSON.parse(await getTool().handler({ action: 'get', ticketId: 't-1' }, auth));
    expect(parsed.checklist).toEqual({
      done: 1,
      total: 2,
      items: [{ label: 'A', done: true }, { label: 'B', done: false }],
    });
  });

  it('get omits per-step DETAIL and the completer’s id', async () => {
    // The agent needs to know where the ticket stands, not who attested what.
    mockLimit.mockResolvedValue(TICKET_ROW);
    checklistMocks.listChecklist.mockResolvedValue({
      done: 1,
      total: 1,
      items: [{ id: 'c1', ticketId: 't-1', label: 'A', detail: 'secret runbook step', position: 0, done: true, doneAt: '2026-01-01T00:00:00.000Z', doneByUserId: 'u-9', source: 'manual', sourceTemplateItemId: null, createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    const out = await getTool().handler({ action: 'get', ticketId: 't-1' }, auth);
    expect(out).not.toContain('doneByUserId');
    expect(out).not.toContain('u-9');
    expect(out).not.toContain('secret runbook step');
  });

  it('get returns checklist null for a ticket with none', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    checklistMocks.listChecklist.mockResolvedValue({ done: 0, total: 0, items: [] });
    const parsed = JSON.parse(await getTool().handler({ action: 'get', ticketId: 't-1' }, auth));
    expect(parsed.checklist).toBeNull();
  });

  it('there is NO tool or action that ticks a checklist step (OD-7 A)', () => {
    // Pinned so a future "helpful" addition fails HERE and has to argue with
    // the decision rather than slip in. done_by_user_id is a human attestation
    // in a compliance artifact; an agent ticking a box it did not perform is a
    // falsified record. The real control is W01's isInteractiveUserSession gate
    // on the `done` branch — an MCP key carries its creator's real user id, so
    // omitting a tool alone would not make ticking human-only.
    const tools = new Map<string, AiTool>();
    registerTicketingTools(tools);
    const suspicious = [...tools.keys()].filter((n) => /checklist/i.test(n) && !/list|get|read/i.test(n));
    expect(suspicious).toEqual([]);
    const actions = (tools.get('manage_tickets')!.definition.input_schema as {
      properties: { action: { enum: string[] } };
    }).properties.action.enum;
    expect(actions).not.toContain('tick_checklist');
    expect(actions).not.toContain('complete_checklist_item');
    expect(actions).not.toContain('update_checklist');
  });

  // ── comment ───────────────────────────────────────────────────────────────

  it('comment delegates to addTicketComment when ticket is in scope', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    serviceMocks.addTicketComment.mockResolvedValue({ comment: { id: 'c-1', content: 'on it' }, firstResponseStamped: false });
    const out = await getTool().handler(
      { action: 'comment', ticketId: 't-1', content: 'On it', isPublic: true },
      auth
    );
    expect(serviceMocks.addTicketComment).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ content: 'On it', isPublic: true }),
      expect.objectContaining({ userId: 'u-1' })
    );
    expect(JSON.parse(out)).toHaveProperty('comment');
  });

  it('comment returns error without calling service when ticket is outside scope', async () => {
    // mockLimit returns [] (default) — scoped select finds nothing.
    const out = await getTool().handler(
      { action: 'comment', ticketId: 'other-ticket', content: 'sneaky note' },
      auth
    );
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/not found/i);
    expect(serviceMocks.addTicketComment).not.toHaveBeenCalled();
  });

  // ── assign ────────────────────────────────────────────────────────────────

  it('assign delegates to assignTicket when ticket is in scope', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    serviceMocks.assignTicket.mockResolvedValue({ id: 't-1', assignedTo: 'u-2' });
    const out = await getTool().handler(
      { action: 'assign', ticketId: 't-1', assigneeId: 'u-2' },
      auth
    );
    expect(serviceMocks.assignTicket).toHaveBeenCalledWith('t-1', 'u-2', expect.objectContaining({ userId: 'u-1' }));
    expect(JSON.parse(out)).toHaveProperty('ticket');
  });

  it('assign returns error without calling service when ticket is outside scope', async () => {
    const out = await getTool().handler(
      { action: 'assign', ticketId: 'other-ticket', assigneeId: 'u-2' },
      auth
    );
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/not found/i);
    expect(serviceMocks.assignTicket).not.toHaveBeenCalled();
  });

  // ── update_status ─────────────────────────────────────────────────────────

  it('update_status delegates to changeTicketStatus when ticket is in scope', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    serviceMocks.changeTicketStatus.mockResolvedValue({ id: 't-1', status: 'resolved' });
    const out = await getTool().handler(
      { action: 'update_status', ticketId: 't-1', status: 'resolved', resolutionNote: 'Done' },
      auth
    );
    expect(serviceMocks.changeTicketStatus).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ status: 'resolved' }),
      expect.objectContaining({ resolutionNote: 'Done' }),
      expect.objectContaining({ userId: 'u-1' })
    );
    expect(JSON.parse(out)).toHaveProperty('ticket');
  });

  it('update_status returns error without calling service when ticket is outside scope', async () => {
    const out = await getTool().handler(
      { action: 'update_status', ticketId: 'other-ticket', status: 'resolved' },
      auth
    );
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/not found/i);
    expect(serviceMocks.changeTicketStatus).not.toHaveBeenCalled();
  });

  // ── update_status by statusName ───────────────────────────────────────────

  it('update_status with statusName resolves the partner row and calls changeTicketStatus with statusId', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    ticketConfigMocks.findStatusByName.mockResolvedValue({
      id: 'status-uuid-vendor',
      partnerId: 'p-1',
      coreStatus: 'pending',
      name: 'Waiting on vendor',
      isActive: true,
      isSystem: false
    });
    serviceMocks.changeTicketStatus.mockResolvedValue({ id: 't-1', status: 'pending' });
    const out = await getTool().handler(
      { action: 'update_status', ticketId: 't-1', statusName: 'Waiting on vendor' },
      auth
    );
    expect(ticketConfigMocks.findStatusByName).toHaveBeenCalledWith('p-1', 'Waiting on vendor');
    expect(serviceMocks.changeTicketStatus).toHaveBeenCalledWith(
      't-1',
      { statusId: 'status-uuid-vendor' },
      expect.objectContaining({}),
      expect.objectContaining({ userId: 'u-1' })
    );
    expect(JSON.parse(out)).toHaveProperty('ticket');
    expect(serviceMocks.changeTicketStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: expect.anything() }),
      expect.anything(),
      expect.anything()
    );
  });

  it('update_status with unknown statusName returns error listing active names', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    ticketConfigMocks.findStatusByName.mockResolvedValue(null);
    ticketConfigMocks.listActiveStatusNames.mockResolvedValue(['New', 'Open', 'Waiting on vendor']);
    const out = await getTool().handler(
      { action: 'update_status', ticketId: 't-1', statusName: 'Does not exist' },
      auth
    );
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/does not exist/i);
    expect(parsed.error).toMatch(/"New"/);
    expect(parsed.error).toMatch(/"Open"/);
    expect(parsed.error).toMatch(/"Waiting on vendor"/);
    expect(serviceMocks.changeTicketStatus).not.toHaveBeenCalled();
  });

  it('update_status with both status and statusName returns error about providing only one', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    const out = await getTool().handler(
      { action: 'update_status', ticketId: 't-1', status: 'pending', statusName: 'Waiting on vendor' },
      auth
    );
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/only one/i);
    expect(serviceMocks.changeTicketStatus).not.toHaveBeenCalled();
    expect(ticketConfigMocks.findStatusByName).not.toHaveBeenCalled();
  });

  it('update_status with core status value still works (existing path unchanged)', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    serviceMocks.changeTicketStatus.mockResolvedValue({ id: 't-1', status: 'open' });
    const out = await getTool().handler(
      { action: 'update_status', ticketId: 't-1', status: 'open' },
      auth
    );
    expect(serviceMocks.changeTicketStatus).toHaveBeenCalledWith(
      't-1',
      { status: 'open' },
      expect.objectContaining({}),
      expect.objectContaining({ userId: 'u-1' })
    );
    expect(JSON.parse(out)).toHaveProperty('ticket');
    expect(ticketConfigMocks.findStatusByName).not.toHaveBeenCalled();
  });

  // ── unknown action ────────────────────────────────────────────────────────

  it('rejects an unknown action', async () => {
    await expect(getTool().handler({ action: 'explode' }, auth)).rejects.toThrow(/unknown action/i);
  });

  // ── input guards (defense-in-depth for missing required fields) ───────────

  it('create returns error when subject is missing', async () => {
    const out = await getTool().handler({ action: 'create', orgId: 'o-1' }, auth);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/subject is required/i);
    expect(serviceMocks.createTicket).not.toHaveBeenCalled();
  });

  it('comment returns error when content is missing', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    const out = await getTool().handler({ action: 'comment', ticketId: 't-1' }, auth);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/content is required/i);
    expect(serviceMocks.addTicketComment).not.toHaveBeenCalled();
  });

  it('update_status returns error when status is missing', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    const out = await getTool().handler({ action: 'update_status', ticketId: 't-1' }, auth);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/status or statusName is required/i);
    expect(serviceMocks.changeTicketStatus).not.toHaveBeenCalled();
  });

  it('create returns error when orgId is missing', async () => {
    const out = await getTool().handler({ action: 'create', subject: 'No org ticket' }, auth);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/orgId is required/i);
    expect(serviceMocks.createTicket).not.toHaveBeenCalled();
  });
});

// ── list — site-axis scoping ──────────────────────────────────────────────
//
// The list action must mirror the HTTP list route (routes/tickets/tickets.ts)
// and apply ticketSiteScopeCondition, so a site-restricted caller cannot read
// device-bound tickets outside their allowed sites. These tests exercise the
// REAL siteScope module (not a mock) and assert on the condition handed to
// the list query's .where(); the semantic shape of the condition itself is
// pinned by the tri-state contract tests in routes/tickets/tickets.test.ts.
describe('manage_tickets list — site-axis scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue([]);
    // Default: the ticket has no checklist (#5808 W03).
    checklistMocks.listChecklist.mockResolvedValue({ done: 0, total: 0, items: [] });
    ticketConfigMocks.findStatusByName.mockResolvedValue(null);
    ticketConfigMocks.listActiveStatusNames.mockResolvedValue([]);
  });

  it('applies the site condition (devices IN-subquery) for a site-restricted caller', async () => {
    const out = await getTool().handler({ action: 'list' }, makeSiteAuth(['site-1']));
    expect(JSON.parse(out)).toHaveProperty('tickets');
    // The site allowlist builds a devices subquery — plus the list query itself.
    expect(mockSelect).toHaveBeenCalledTimes(2);
    // With no org/status/device filters and orgCondition undefined, the ONLY
    // possible condition is the site-axis one. Pre-fix the list query ran
    // with where(undefined), returning every org ticket to a site-restricted
    // caller.
    const whereArg = mockWhere.mock.calls.at(-1)?.[0];
    expect(whereArg).toBeDefined();
  });

  it('restricts an empty allowlist to deviceless tickets only', async () => {
    await getTool().handler({ action: 'list' }, makeSiteAuth([]));
    // Empty allowlist short-circuits to isNull(tickets.deviceId) — no devices
    // subquery is built, just the list query itself.
    expect(mockSelect).toHaveBeenCalledTimes(1);
    const whereArg = mockWhere.mock.calls.at(-1)?.[0];
    expect(whereArg).toBeDefined();
    expect(JSON.stringify(whereArg)).toContain('is null');
  });

  it("adds no site condition for an unrestricted caller (only the soft-delete filter)", async () => {
    const out = await getTool().handler({ action: 'list' }, auth);
    expect(JSON.parse(out)).toHaveProperty('tickets');
    // One select (no devices subquery) → no site-axis condition was applied.
    expect(mockSelect).toHaveBeenCalledTimes(1);
    // The list still always excludes soft-deleted tickets (Phase 6), so where()
    // now carries the deleted_at IS NULL filter instead of being undefined.
    const whereArg = mockWhere.mock.calls.at(-1)?.[0];
    expect(whereArg).toBeDefined();
    expect(JSON.stringify(whereArg)).toContain('is null');
  });
});

// ── time-tracking actions ─────────────────────────────────────────────────

describe('manage_tickets — log_time_entry / start_timer / stop_timer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue([]);
    // Default: the ticket has no checklist (#5808 W03).
    checklistMocks.listChecklist.mockResolvedValue({ done: 0, total: 0, items: [] });
    ticketConfigMocks.findStatusByName.mockResolvedValue(null);
    ticketConfigMocks.listActiveStatusNames.mockResolvedValue([]);
  });

  it("documents hourlyRate in the ticket organization's currency", () => {
    const properties = getTool().definition.input_schema.properties as Record<string, { description?: string }>;

    expect(properties.hourlyRate?.description).toContain("organization's currency");
  });

  // log_time_entry
  it('log_time_entry delegates to createTimeEntry and labels the result with the entry\'s stamped currency', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW); // ticket scope check passes
    timeEntryMocks.createTimeEntry.mockResolvedValue({ id: 'te-1', orgId: 'o-1', currencyCode: 'EUR', durationMinutes: 30 });
    const out = await getTool().handler(
      {
        action: 'log_time_entry',
        ticketId: 't-1',
        startedAt: '2026-06-11T09:00:00Z',
        endedAt: '2026-06-11T09:30:00Z',
        isBillable: true,
        hourlyRate: 125
      },
      auth
    );
    expect(timeEntryMocks.createTimeEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: 't-1',
        startedAt: expect.any(Date),
        endedAt: expect.any(Date),
        isBillable: true,
        hourlyRate: 125
      }),
      expect.objectContaining({ userId: 'u-1', manageAll: false, partnerId: 'p-1' }),
      // #4177: a human's own tool call keeps the column default provenance.
      { source: 'manual' }
    );
    expect(JSON.parse(out)).toMatchObject({
      timeEntry: { id: 'te-1' },
      currencyCode: 'EUR'
    });
  });

  it('log_time_entry returns error when startedAt is missing', async () => {
    const out = await getTool().handler(
      { action: 'log_time_entry', endedAt: '2026-06-11T09:30:00Z' },
      auth
    );
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/startedAt is required/i);
    expect(timeEntryMocks.createTimeEntry).not.toHaveBeenCalled();
  });

  it('log_time_entry returns error when endedAt is missing', async () => {
    const out = await getTool().handler(
      { action: 'log_time_entry', startedAt: '2026-06-11T09:00:00Z' },
      auth
    );
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/endedAt is required/i);
    expect(timeEntryMocks.createTimeEntry).not.toHaveBeenCalled();
  });

  it('log_time_entry returns error (not throws) when TimeEntryServiceError is raised', async () => {
    mockLimit.mockResolvedValue(TICKET_ROW);
    const { TimeEntryServiceError: TES } = await vi.importActual<typeof import('./timeEntryService')>('./timeEntryService');
    timeEntryMocks.createTimeEntry.mockRejectedValue(new TES('Ticket must belong to the same partner', 400, 'TICKET_WRONG_PARTNER'));
    const out = await getTool().handler(
      { action: 'log_time_entry', ticketId: 't-1', startedAt: '2026-06-11T09:00:00Z', endedAt: '2026-06-11T09:30:00Z' },
      auth
    );
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/partner/i);
  });

  it('log_time_entry blocks out-of-scope ticket (site gate)', async () => {
    // mockLimit returns [] by default — ticket not in caller's scope.
    const out = await getTool().handler(
      { action: 'log_time_entry', ticketId: 'other-ticket', startedAt: '2026-06-11T09:00:00Z', endedAt: '2026-06-11T09:30:00Z' },
      auth
    );
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/not found/i);
    expect(timeEntryMocks.createTimeEntry).not.toHaveBeenCalled();
  });

  it('log_time_entry with a standalone entry returns an explicit null currencyCode without an org query', async () => {
    timeEntryMocks.createTimeEntry.mockResolvedValue({ id: 'te-2', orgId: null, currencyCode: null, durationMinutes: 60 });
    const out = await getTool().handler(
      { action: 'log_time_entry', startedAt: '2026-06-11T09:00:00Z', endedAt: '2026-06-11T10:00:00Z' },
      auth
    );
    // No scope check select = mockSelect never called
    expect(mockSelect).not.toHaveBeenCalled();
    expect(JSON.parse(out)).toMatchObject({
      timeEntry: { id: 'te-2', orgId: null },
      currencyCode: null
    });
  });

  // start_timer
  it('start_timer delegates to startTimer and returns timeEntry', async () => {
    timeEntryMocks.startTimer.mockResolvedValue({ id: 'te-3', endedAt: null });
    const out = await getTool().handler({ action: 'start_timer', description: 'on it' }, auth);
    expect(timeEntryMocks.startTimer).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'on it' }),
      expect.objectContaining({ userId: 'u-1', manageAll: false })
    );
    expect(JSON.parse(out)).toHaveProperty('timeEntry');
  });

  it('start_timer with ticketId blocks out-of-scope ticket', async () => {
    // mockLimit returns [] — out of scope.
    const out = await getTool().handler({ action: 'start_timer', ticketId: 'other-ticket' }, auth);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/not found/i);
    expect(timeEntryMocks.startTimer).not.toHaveBeenCalled();
  });

  // stop_timer
  it('stop_timer delegates to stopTimer and labels the result with the entry\'s stamped currency', async () => {
    timeEntryMocks.stopTimer.mockResolvedValue({ id: 'te-3', orgId: 'o-1', currencyCode: 'EUR', endedAt: new Date(), durationMinutes: 45 });
    const out = await getTool().handler({ action: 'stop_timer' }, auth);
    expect(timeEntryMocks.stopTimer).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.objectContaining({ userId: 'u-1', manageAll: false })
    );
    expect(JSON.parse(out)).toMatchObject({
      timeEntry: { id: 'te-3' },
      currencyCode: 'EUR'
    });
  });

  it('stop_timer surfaces NO_RUNNING_TIMER as an error result (not a thrown exception)', async () => {
    const { TimeEntryServiceError: TES } = await vi.importActual<typeof import('./timeEntryService')>('./timeEntryService');
    timeEntryMocks.stopTimer.mockRejectedValue(new TES('No running timer', 404, 'NO_RUNNING_TIMER'));
    const out = await getTool().handler({ action: 'stop_timer' }, auth);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/no running timer/i);
  });
});

// ── Zod schema registry coverage ──────────────────────────────────────────

describe('manage_tickets — validateToolInput schema registry', () => {
  it('passes for a valid list invocation', () => {
    const result = validateToolInput('manage_tickets', { action: 'list' });
    expect(result.success).toBe(true);
  });

  it('passes for a valid create invocation', () => {
    const result = validateToolInput('manage_tickets', {
      action: 'create',
      orgId: '00000000-0000-0000-0000-000000000001',
      subject: 'Printer offline',
    });
    expect(result.success).toBe(true);
  });

  it('passes for a valid update_status with pendingReason', () => {
    const result = validateToolInput('manage_tickets', {
      action: 'update_status',
      ticketId: '00000000-0000-0000-0000-000000000002',
      status: 'pending',
      pendingReason: 'Waiting on vendor',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown action value', () => {
    const result = validateToolInput('manage_tickets', { action: 'explode' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID ticketId', () => {
    const result = validateToolInput('manage_tickets', { action: 'get', ticketId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects subject exceeding 255 characters', () => {
    const result = validateToolInput('manage_tickets', {
      action: 'create',
      orgId: '00000000-0000-0000-0000-000000000001',
      subject: 'x'.repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown priority value', () => {
    const result = validateToolInput('manage_tickets', { action: 'create', priority: 'extreme' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown status value', () => {
    const result = validateToolInput('manage_tickets', { action: 'update_status', status: 'unknown_status' });
    expect(result.success).toBe(false);
  });

  it('passes for a valid update_status with statusName', () => {
    const result = validateToolInput('manage_tickets', {
      action: 'update_status',
      ticketId: '00000000-0000-0000-0000-000000000002',
      statusName: 'Waiting on vendor',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a statusName exceeding 60 characters', () => {
    const result = validateToolInput('manage_tickets', {
      action: 'update_status',
      ticketId: '00000000-0000-0000-0000-000000000002',
      statusName: 'x'.repeat(61),
    });
    expect(result.success).toBe(false);
  });

  it('passes for a valid log_time_entry invocation', () => {
    const result = validateToolInput('manage_tickets', {
      action: 'log_time_entry',
      startedAt: '2026-06-11T09:00:00Z',
      endedAt: '2026-06-11T09:30:00Z',
      isBillable: true,
      hourlyRate: 125
    });
    expect(result.success).toBe(true);
  });

  it('passes for a valid start_timer invocation', () => {
    const result = validateToolInput('manage_tickets', { action: 'start_timer' });
    expect(result.success).toBe(true);
  });

  it('passes for a valid stop_timer invocation', () => {
    const result = validateToolInput('manage_tickets', { action: 'stop_timer' });
    expect(result.success).toBe(true);
  });

  it('rejects a negative hourlyRate', () => {
    const result = validateToolInput('manage_tickets', {
      action: 'log_time_entry',
      startedAt: '2026-06-11T09:00:00Z',
      endedAt: '2026-06-11T09:30:00Z',
      hourlyRate: -5
    });
    expect(result.success).toBe(false);
  });
});


describe('work types in the ticketing tool', () => {
  const timeInput = {
    ticketId: '00000000-0000-0000-0000-000000000001',
    startedAt: '2026-06-11T09:00:00Z',
    endedAt: '2026-06-11T09:30:00Z',
  };
  const workTypeId = 'aaaaaaaa-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue(TICKET_ROW);
    timeEntryMocks.createTimeEntry.mockResolvedValue({ id: 'te-1' });
    timeEntryMocks.startTimer.mockResolvedValue({ id: 'te-1' });
    workTypeMocks.listWorkTypes.mockResolvedValue([{ id: workTypeId, name: 'On-site', isActive: true }]);
  });

  it.each(['log_time_entry', 'start_timer'])('%s resolves a workType name case-insensitively for the acting partner', async (action) => {
    await getTool().handler({ ...timeInput, action, workType: ' ON-SITE ' }, auth);
    const service = action === 'log_time_entry' ? timeEntryMocks.createTimeEntry : timeEntryMocks.startTimer;
    expect(service.mock.calls[0]?.[0]).toMatchObject({ workTypeId });
    expect(workTypeMocks.listWorkTypes).toHaveBeenCalledWith('p-1', { includeInactive: false });
  });

  it.each(['log_time_entry', 'start_timer'])('%s accepts a UUID that IS in the partner\'s active list', async (action) => {
    await getTool().handler({ ...timeInput, action, workType: workTypeId }, auth);
    expect(workTypeMocks.listWorkTypes).toHaveBeenCalledWith('p-1', { includeInactive: false });
    const service = action === 'log_time_entry' ? timeEntryMocks.createTimeEntry : timeEntryMocks.startTimer;
    expect(service.mock.calls[0]?.[0]).toMatchObject({ workTypeId });
  });

  // A model hallucinates well-formed UUIDs. Passing one through unchecked put it
  // straight into the composite FK, which raises 23503 INSIDE the request
  // transaction -- the tool's own catch can only report a raw 500 by then.
  it.each(['log_time_entry', 'start_timer'])('%s REFUSES a well-formed UUID that is not the partner\'s', async (action) => {
    const hallucinated = 'ffffffff-9999-4999-8999-999999999999';
    const out = JSON.parse(await getTool().handler({ ...timeInput, action, workType: hallucinated }, auth));
    expect(out.error).toMatch(/Unknown work type/);
    expect(out.error).toMatch(/On-site/);
    expect(timeEntryMocks.createTimeEntry).not.toHaveBeenCalled();
    expect(timeEntryMocks.startTimer).not.toHaveBeenCalled();
  });

  it.each(['log_time_entry', 'start_timer'])('%s REFUSES an ARCHIVED work type id (absent from the active list)', async (action) => {
    const archived = 'bbbbbbbb-2222-4222-8222-222222222222';
    const out = JSON.parse(await getTool().handler({ ...timeInput, action, workType: archived }, auth));
    expect(out.error).toMatch(/Unknown work type/);
    expect(timeEntryMocks.createTimeEntry).not.toHaveBeenCalled();
    expect(timeEntryMocks.startTimer).not.toHaveBeenCalled();
  });

  it.each(['log_time_entry', 'start_timer'])('%s rejects unknown work types and names the valid options', async (action) => {
    const out = JSON.parse(await getTool().handler({ ...timeInput, action, workType: 'Teleportation' }, auth));
    expect(out.error).toMatch(/Teleportation/);
    expect(out.error).toMatch(/On-site/);
    expect(timeEntryMocks.createTimeEntry).not.toHaveBeenCalled();
    expect(timeEntryMocks.startTimer).not.toHaveBeenCalled();
  });

  it.each(['log_time_entry', 'start_timer'])('%s preserves undefined when omitted so category defaults apply', async (action) => {
    await getTool().handler({ ...timeInput, action }, auth);
    const service = action === 'log_time_entry' ? timeEntryMocks.createTimeEntry : timeEntryMocks.startTimer;
    expect(service).toHaveBeenCalled();
    expect(service.mock.calls[0]?.[0].workTypeId).toBeUndefined();
    expect(workTypeMocks.listWorkTypes).not.toHaveBeenCalled();
  });

  it('lists active work types as id and name only', async () => {
    const out = JSON.parse(await getTool().handler({ action: 'list_work_types' }, auth));
    expect(out.workTypes).toEqual([{ id: workTypeId, name: 'On-site' }]);
    expect(workTypeMocks.listWorkTypes).toHaveBeenCalledWith('p-1', { includeInactive: false });
  });

  it.each(['On-site', workTypeId, 'Teleportation', ''])('stop_timer rejects workType %j before stopping or looking up types', async (workType) => {
    timeEntryMocks.stopTimer.mockResolvedValue({ id: 'te-1', workTypeId });
    const out = JSON.parse(await getTool().handler({ action: 'stop_timer', workType }, auth));
    expect(out.error).toMatch(/work type.*timer start/i);
    expect(out.error).toMatch(/edit.*entry/i);
    expect(timeEntryMocks.stopTimer).not.toHaveBeenCalled();
    expect(workTypeMocks.listWorkTypes).not.toHaveBeenCalled();
  });

  it('stop_timer without workType preserves the work type stamped at start', async () => {
    timeEntryMocks.stopTimer.mockResolvedValue({ id: 'te-1', workTypeId });
    const out = JSON.parse(await getTool().handler({ action: 'stop_timer', description: 'Completed' }, auth));
    expect(out.timeEntry.workTypeId).toBe(workTypeId);
    expect(timeEntryMocks.stopTimer).toHaveBeenCalledWith(
      { description: 'Completed', isBillable: undefined },
      expect.objectContaining({ partnerId: 'p-1', userId: 'u-1' }),
    );
    expect(workTypeMocks.listWorkTypes).not.toHaveBeenCalled();
  });

  it('returns an empty list when no active work types exist', async () => {
    workTypeMocks.listWorkTypes.mockResolvedValue([]);
    expect(JSON.parse(await getTool().handler({ action: 'list_work_types' }, auth))).toEqual({ workTypes: [] });
  });

  it('explains when an unmatched name has no configured alternatives', async () => {
    workTypeMocks.listWorkTypes.mockResolvedValue([]);
    const out = JSON.parse(await getTool().handler({ ...timeInput, action: 'log_time_entry', workType: 'Remote' }, auth));
    expect(out.error).toMatch(/Unknown work type "Remote".*none configured/);
    expect(timeEntryMocks.createTimeEntry).not.toHaveBeenCalled();
  });

  it.each(['list_work_types', 'log_time_entry', 'start_timer'])('%s refuses organization scope before reading work types', async (action) => {
    const out = JSON.parse(await getTool().handler({ ...timeInput, action, workType: 'On-site' }, makeSiteAuth()));
    expect(out.error).toMatch(/partner/i);
    expect(workTypeMocks.listWorkTypes).not.toHaveBeenCalled();
    expect(timeEntryMocks.createTimeEntry).not.toHaveBeenCalled();
    expect(timeEntryMocks.startTimer).not.toHaveBeenCalled();
  });

  it('registers list_work_types in both tool schemas', () => {
    const properties = getTool().definition.input_schema.properties as Record<string, { enum?: string[]; type?: string }>;
    expect(properties.action?.enum).toContain('list_work_types');
    expect(properties.workType?.type).toBe('string');
    expect(validateToolInput('manage_tickets', { action: 'list_work_types' }).success).toBe(true);
  });

  it('preserves workType through input validation', () => {
    const result = toolInputSchemas.manage_tickets!.safeParse({ ...timeInput, action: 'log_time_entry', workType: 'On-site' });
    expect(result).toMatchObject({ success: true, data: { workType: 'On-site' } });
  });
});
