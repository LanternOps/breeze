import { describe, it, expect, vi, beforeEach } from 'vitest';

const { serviceMocks } = vi.hoisted(() => ({
  serviceMocks: {
    createTicket: vi.fn(),
    changeTicketStatus: vi.fn(),
    assignTicket: vi.fn(),
    addTicketComment: vi.fn()
  }
}));

vi.mock('./ticketService', async () => {
  const actual = await vi.importActual<typeof import('./ticketService')>('./ticketService');
  return { ...actual, ...serviceMocks };
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
    !!siteId && allowed.includes(siteId)
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
import { validateToolInput } from './aiToolSchemas';

// Default auth: partner scope with access to 'o-1'.
const auth: AuthContext = {
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
      'resolved',
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
    expect(parsed.error).toMatch(/status is required/i);
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

  it("leaves an unrestricted caller's list unchanged (no site condition)", async () => {
    const out = await getTool().handler({ action: 'list' }, auth);
    expect(JSON.parse(out)).toHaveProperty('tickets');
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockWhere.mock.calls.at(-1)?.[0]).toBeUndefined();
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
});
