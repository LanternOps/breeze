import { beforeEach, describe, expect, it, vi } from 'vitest';

const TICKET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_TICKET_ID = '00000000-0000-0000-0000-000000000002';
const COMMENT_ID = '00000000-0000-0000-0000-000000000004';
const TARGET_ORG_ID = '00000000-0000-0000-0000-000000000005';

const { serviceMocks, mockLimit, mockSelect, permissionMocks } = vi.hoisted(() => {
  const serviceMocks = {
    createTicket: vi.fn(),
    changeTicketStatus: vi.fn(),
    assignTicket: vi.fn(),
    addTicketComment: vi.fn(),
    updateTicketFields: vi.fn(),
    linkAlertToTicket: vi.fn(),
    unlinkAlertFromTicket: vi.fn(),
    createTicketFromAlert: vi.fn(),
    editTicketComment: vi.fn(),
    deleteTicketComment: vi.fn(),
    moveTicketOrg: vi.fn(),
  };
  const mockLimit = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));
  const mockSelect = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: mockLimit })),
    })),
  }));
  const permissionMocks = {
    getUserPermissions: vi.fn(),
    hasPermission: vi.fn(),
  };
  return { serviceMocks, mockLimit, mockSelect, permissionMocks };
});

vi.mock('../db', () => ({
  db: { select: mockSelect },
}));

vi.mock('../middleware/auth', () => ({
  siteAccessCheck: (allowed: string[]) => (siteId?: string | null) => !!siteId && allowed.includes(siteId),
}));

vi.mock('./permissions', () => ({
  getUserPermissions: permissionMocks.getUserPermissions,
  hasPermission: permissionMocks.hasPermission,
  PERMISSIONS: {
    TICKETS_MANAGE: { resource: 'tickets', action: 'manage' },
  },
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

function getTool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerTicketingTools(tools);
  const tool = tools.get('manage_tickets');
  if (!tool) throw new Error('manage_tickets not registered');
  return tool;
}

function makeAuth(canAccessOrg = true): AuthContext {
  return {
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech User', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: 'partner-1',
    orgId: '00000000-0000-0000-0000-000000000010',
    scope: 'partner',
    accessibleOrgIds: ['00000000-0000-0000-0000-000000000010', TARGET_ORG_ID],
    orgCondition: vi.fn(() => undefined),
    canAccessOrg: vi.fn(() => canAccessOrg),
  };
}

function mockAccessibleTicket(ticketId = TICKET_ID) {
  mockLimit.mockResolvedValueOnce([{ id: ticketId, orgId: '00000000-0000-0000-0000-000000000010', partnerId: 'partner-1', deviceId: null }]);
}

function mockDeniedTicket() {
  mockLimit.mockResolvedValueOnce([]);
}

describe('manage_tickets write-gap actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue([]);
    permissionMocks.getUserPermissions.mockResolvedValue({
      roleId: 'role-1',
      permissions: [],
      partnerId: 'partner-1',
      orgId: null,
      scope: 'partner',
    });
    permissionMocks.hasPermission.mockReturnValue(false);
  });

  it('update_fields calls updateTicketFields only after ticket access passes', async () => {
    mockAccessibleTicket();
    serviceMocks.updateTicketFields.mockResolvedValue({ id: TICKET_ID, subject: 'Updated' });

    const out = await getTool().handler(
      { action: 'update_fields', ticketId: TICKET_ID, fields: { subject: 'Updated' } },
      makeAuth()
    );

    expect(JSON.parse(out)).toEqual({ ticket: { id: TICKET_ID, subject: 'Updated' } });
    expect(serviceMocks.updateTicketFields).toHaveBeenCalledWith(
      TICKET_ID,
      { subject: 'Updated' },
      expect.objectContaining({ userId: 'user-1', name: 'Tech User' })
    );
    expect(mockLimit.mock.invocationCallOrder[0]).toBeLessThan(
      serviceMocks.updateTicketFields.mock.invocationCallOrder[0]!
    );
  });

  it('update_fields returns error JSON and does not call service when ticket access is denied', async () => {
    mockDeniedTicket();

    const out = await getTool().handler(
      { action: 'update_fields', ticketId: TICKET_ID, fields: { subject: 'Blocked' } },
      makeAuth()
    );

    expect(JSON.parse(out)).toEqual({ error: 'Ticket not found' });
    expect(serviceMocks.updateTicketFields).not.toHaveBeenCalled();
  });

  it('move_org requires target org access and does not call moveTicketOrg when denied', async () => {
    mockAccessibleTicket();

    const out = await getTool().handler(
      { action: 'move_org', ticketId: TICKET_ID, targetOrgId: TARGET_ORG_ID },
      makeAuth(false)
    );

    expect(JSON.parse(out)).toEqual({ error: 'Access to target organization denied' });
    expect(serviceMocks.moveTicketOrg).not.toHaveBeenCalled();
  });

  it('edit_comment resolves expectedTicketId and passes it to editTicketComment', async () => {
    mockAccessibleTicket(OTHER_TICKET_ID);
    serviceMocks.editTicketComment.mockResolvedValue({ id: COMMENT_ID, content: 'updated' });

    const out = await getTool().handler(
      { action: 'edit_comment', commentId: COMMENT_ID, expectedTicketId: OTHER_TICKET_ID, content: 'updated' },
      makeAuth()
    );

    expect(JSON.parse(out)).toEqual({ comment: { id: COMMENT_ID, content: 'updated' } });
    expect(serviceMocks.editTicketComment).toHaveBeenCalledWith(
      COMMENT_ID,
      { content: 'updated' },
      expect.objectContaining({ userId: 'user-1' }),
      { canManageAny: false, expectedTicketId: OTHER_TICKET_ID }
    );
  });

  it('delete_comment resolves expectedTicketId and passes it to deleteTicketComment', async () => {
    mockAccessibleTicket(OTHER_TICKET_ID);
    serviceMocks.deleteTicketComment.mockResolvedValue({ id: COMMENT_ID });

    const out = await getTool().handler(
      { action: 'delete_comment', commentId: COMMENT_ID, expectedTicketId: OTHER_TICKET_ID },
      makeAuth()
    );

    expect(JSON.parse(out)).toEqual({ deleted: { id: COMMENT_ID } });
    expect(serviceMocks.deleteTicketComment).toHaveBeenCalledWith(
      COMMENT_ID,
      expect.objectContaining({ userId: 'user-1' }),
      { canManageAny: false, expectedTicketId: OTHER_TICKET_ID }
    );
  });
});
