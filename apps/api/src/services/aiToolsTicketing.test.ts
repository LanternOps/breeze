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

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    }))
  }
}));

vi.mock('../db/schema', () => ({
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
}));

import { registerTicketingTools } from './aiToolsTicketing';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

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

function getTool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerTicketingTools(tools);
  const tool = tools.get('manage_tickets');
  if (!tool) throw new Error('manage_tickets not registered');
  return tool;
}

describe('manage_tickets tool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers with deviceArgs gating and tier 2', () => {
    const tool = getTool();
    expect(tool.tier).toBe(2);
    expect(tool.deviceArgs).toContain('deviceId');
  });

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

  it('list returns tickets array', async () => {
    const out = await getTool().handler({ action: 'list' }, auth);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('tickets');
    expect(Array.isArray(parsed.tickets)).toBe(true);
  });

  it('get returns error for missing ticket', async () => {
    const out = await getTool().handler({ action: 'get', ticketId: '3f2f1d8e-0000-0000-0000-000000000001' }, auth);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/not found/i);
  });

  it('comment delegates to addTicketComment', async () => {
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

  it('assign delegates to assignTicket', async () => {
    serviceMocks.assignTicket.mockResolvedValue({ id: 't-1', assignedTo: 'u-2' });
    const out = await getTool().handler(
      { action: 'assign', ticketId: 't-1', assigneeId: 'u-2' },
      auth
    );
    expect(serviceMocks.assignTicket).toHaveBeenCalledWith('t-1', 'u-2', expect.objectContaining({ userId: 'u-1' }));
    expect(JSON.parse(out)).toHaveProperty('ticket');
  });

  it('update_status delegates to changeTicketStatus', async () => {
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

  it('rejects an unknown action', async () => {
    await expect(getTool().handler({ action: 'explode' }, auth)).rejects.toThrow(/unknown action/i);
  });
});
