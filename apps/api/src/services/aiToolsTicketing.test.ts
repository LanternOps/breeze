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

// Mutable handle so individual tests can override the limit() return value.
// Typed as returning unknown[] so mockResolvedValue(TICKET_ROW) compiles.
const mockLimit = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
          limit: mockLimit
        }))
      }))
    }))
  }
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
