import { beforeEach, describe, expect, it, vi } from 'vitest';

const TICKET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_TICKET_ID = '00000000-0000-0000-0000-000000000002';
const ALERT_ID = '00000000-0000-0000-0000-000000000003';
const COMMENT_ID = '00000000-0000-0000-0000-000000000004';
const TARGET_ORG_ID = '00000000-0000-0000-0000-000000000005';
const DEVICE_ID = '00000000-0000-0000-0000-000000000006';

const { serviceMocks, mockLimit, mockSelect, mockUpdateSet, mockUpdateWhere, mockUpdate, permissionMocks, siteScopeMocks } = vi.hoisted(() => {
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
  // P2-4 (#4191): the move_org executor's action_intents tombstone UPDATE.
  const mockUpdateWhere = vi.fn(() => Promise.resolve(undefined));
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  const permissionMocks = {
    getUserPermissions: vi.fn(),
    hasPermission: vi.fn(),
  };
  const siteScopeMocks = {
    deviceInSiteScope: vi.fn(),
    ticketSiteScopeCondition: vi.fn(),
  };
  return { serviceMocks, mockLimit, mockSelect, mockUpdateSet, mockUpdateWhere, mockUpdate, permissionMocks, siteScopeMocks };
});

vi.mock('../db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}));

vi.mock('../middleware/auth', () => ({
  siteAccessCheck: (allowed: string[]) => (siteId?: string | null) => !!siteId && allowed.includes(siteId),
  isAiAgentPrincipal: (auth: { principal?: { kind?: string } }) => auth?.principal?.kind === 'ai_agent',
}));

vi.mock('../routes/tickets/siteScope', () => ({
  deviceInSiteScope: siteScopeMocks.deviceInSiteScope,
  ticketSiteScopeCondition: siteScopeMocks.ticketSiteScopeCondition,
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
import { TicketServiceError } from './ticketService';
import { TicketMoveCurrencyBlockedError } from './ticketMoveCurrencyGuard';

function getTool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerTicketingTools(tools);
  const tool = tools.get('manage_tickets');
  if (!tool) throw new Error('manage_tickets not registered');
  return tool;
}

function makeAuth(canAccessOrg = true): AuthContext {
  return {
    principal: { kind: 'user_session' },
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

function mockDeniedAlert() {
  mockLimit.mockResolvedValueOnce([]);
}

describe('manage_tickets write-gap actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue([]);
    siteScopeMocks.deviceInSiteScope.mockResolvedValue(true);
    siteScopeMocks.ticketSiteScopeCondition.mockReturnValue(undefined);
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

  it('update_fields rejects a nested deviceId outside site scope before calling the service', async () => {
    mockAccessibleTicket();
    siteScopeMocks.deviceInSiteScope.mockResolvedValueOnce(false);

    const out = await getTool().handler(
      { action: 'update_fields', ticketId: TICKET_ID, fields: { deviceId: DEVICE_ID } },
      makeAuth()
    );

    expect(JSON.parse(out)).toEqual({ error: 'Device not found or access denied' });
    expect(siteScopeMocks.deviceInSiteScope).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ id: 'user-1' }) }), DEVICE_ID);
    expect(serviceMocks.updateTicketFields).not.toHaveBeenCalled();
  });

  it('update_fields rejects present wrong-typed fields before calling the service', async () => {
    const out = await getTool().handler(
      { action: 'update_fields', ticketId: TICKET_ID, fields: { priority: 123 } },
      makeAuth()
    );

    expect(JSON.parse(out)).toEqual({ error: 'fields.priority must be one of low, normal, high, urgent' });
    expect(mockLimit).not.toHaveBeenCalled();
    expect(serviceMocks.updateTicketFields).not.toHaveBeenCalled();
  });

  it('update_fields maps TicketServiceError to error JSON with code', async () => {
    mockAccessibleTicket();
    serviceMocks.updateTicketFields.mockRejectedValue(
      new TicketServiceError('Invalid ticket update', 400, 'INVALID_INPUT')
    );

    const out = await getTool().handler(
      { action: 'update_fields', ticketId: TICKET_ID, fields: { subject: 'Updated' } },
      makeAuth()
    );

    expect(JSON.parse(out)).toEqual({ error: 'Invalid ticket update', code: 'INVALID_INPUT' });
  });

  it('update_fields re-throws non-service errors', async () => {
    mockAccessibleTicket();
    const err = new Error('database unavailable');
    serviceMocks.updateTicketFields.mockRejectedValue(err);

    await expect(
      getTool().handler(
        { action: 'update_fields', ticketId: TICKET_ID, fields: { subject: 'Updated' } },
        makeAuth()
      )
    ).rejects.toBe(err);
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

  it('move_org never passes acceptCurrencyMismatch and surfaces a currency block as JSON with code + details (#3776)', async () => {
    mockAccessibleTicket();
    const details = { sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 1, unbilledParts: 0, accepted: false, blockedByCurrency: [{ currencyCode: 'USD', timeEntries: 1, parts: 0 }] };
    serviceMocks.moveTicketOrg.mockRejectedValueOnce(new TicketMoveCurrencyBlockedError('Cannot move: stranded money', details));

    const out = await getTool().handler(
      { action: 'move_org', ticketId: TICKET_ID, targetOrgId: TARGET_ORG_ID },
      makeAuth()
    );

    expect(JSON.parse(out)).toEqual({ error: 'Cannot move: stranded money', code: 'TICKET_MOVE_CURRENCY_BLOCKED', details });
    // Three positional args only — the AI has no way to accept a mismatch.
    expect(serviceMocks.moveTicketOrg).toHaveBeenCalledTimes(1);
    expect(serviceMocks.moveTicketOrg.mock.calls[0]).toHaveLength(3);
  });

  // C1 (final review #4191): the scope_ticket_id tombstone AND the
  // ticket_drafts cleanup now live INSIDE moveTicketOrg's own transaction
  // (ticketService.ts) — the one path this AI-tool executor and the HTTP
  // route (routes/tickets/moveOrg.ts, which calls moveTicketOrg directly and
  // never ran the OLD tombstone that used to live here) both go through.
  // This executor no longer touches action_intents/ticket_drafts at all;
  // these tests now pin that (mockUpdate is never called from here) rather
  // than the old tombstone-ordering assertion, which described dead code
  // after this fix.
  describe('move_org no longer tombstones from the AI-tool executor (C1, final review #4191)', () => {
    it('calls moveTicketOrg without touching action_intents/ticket_drafts directly — that is moveTicketOrg\'s own responsibility now', async () => {
      mockAccessibleTicket();
      serviceMocks.moveTicketOrg.mockResolvedValueOnce({ id: TICKET_ID, orgId: TARGET_ORG_ID });

      const out = await getTool().handler(
        { action: 'move_org', ticketId: TICKET_ID, targetOrgId: TARGET_ORG_ID },
        makeAuth()
      );

      expect(JSON.parse(out)).toEqual({ ticket: { id: TICKET_ID, orgId: TARGET_ORG_ID } });
      expect(serviceMocks.moveTicketOrg).toHaveBeenCalledWith(TICKET_ID, TARGET_ORG_ID, expect.anything());
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockUpdateWhere).not.toHaveBeenCalled();
    });

    it('a denied move (no target-org access) never calls moveTicketOrg or db.update', async () => {
      mockAccessibleTicket();

      await getTool().handler(
        { action: 'move_org', ticketId: TICKET_ID, targetOrgId: TARGET_ORG_ID },
        makeAuth(false)
      );

      expect(mockUpdate).not.toHaveBeenCalled();
      expect(serviceMocks.moveTicketOrg).not.toHaveBeenCalled();
    });
  });

  it('link_alert returns error and does not call service when ticket access is denied', async () => {
    mockDeniedTicket();

    const out = await getTool().handler(
      { action: 'link_alert', ticketId: TICKET_ID, alertId: ALERT_ID },
      makeAuth()
    );

    expect(JSON.parse(out)).toEqual({ error: 'Ticket not found' });
    expect(serviceMocks.linkAlertToTicket).not.toHaveBeenCalled();
  });

  it('link_alert returns error and does not call service when alert access is denied', async () => {
    mockAccessibleTicket();
    mockDeniedAlert();

    const out = await getTool().handler(
      { action: 'link_alert', ticketId: TICKET_ID, alertId: ALERT_ID },
      makeAuth()
    );

    expect(JSON.parse(out)).toEqual({ error: 'Alert not found' });
    expect(serviceMocks.linkAlertToTicket).not.toHaveBeenCalled();
  });

  it('create_from_alert returns error and does not call service when alert access is denied', async () => {
    mockDeniedAlert();

    const out = await getTool().handler(
      { action: 'create_from_alert', alertId: ALERT_ID },
      makeAuth()
    );

    expect(JSON.parse(out)).toEqual({ error: 'Alert not found' });
    expect(serviceMocks.createTicketFromAlert).not.toHaveBeenCalled();
  });

  it('unlink_alert returns error and does not call service when ticket access is denied', async () => {
    mockDeniedTicket();

    const out = await getTool().handler(
      { action: 'unlink_alert', ticketId: TICKET_ID, alertId: ALERT_ID },
      makeAuth()
    );

    expect(JSON.parse(out)).toEqual({ error: 'Ticket not found' });
    expect(serviceMocks.unlinkAlertFromTicket).not.toHaveBeenCalled();
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
