import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authRef, getScopedTicketOr404Mock, checklistMocks, templateMocks } = vi.hoisted(() => ({
  templateMocks: {
    applyChecklistTemplateToTicket: vi.fn(),
  },
  authRef: {
    current: {
      scope: 'partner' as string,
      principal: { kind: 'user_session' } as Record<string, unknown>,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  getScopedTicketOr404Mock: vi.fn(),
  checklistMocks: {
    listChecklist: vi.fn(),
    addChecklistItem: vi.fn(),
    patchChecklistItem: vi.fn(),
    reorderChecklist: vi.fn(),
    deleteChecklistItem: vi.fn(),
    getChecklistItemOr404: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth');
  return {
    authMiddleware: vi.fn(async (c: any, next: any) => {
      if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
      c.set('auth', authRef.current);
      await next();
    }),
    requireScope: () => async (c: any, next: any) => {
      if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
      await next();
    },
    requirePermission: () => async (_c: any, next: any) => next(),
    requireMfa: () => async (_c: any, next: any) => next(),
    siteAccessCheck: actual.siteAccessCheck,
    // NOT stubbed: the `done` gate is the control under test, so it must be the
    // real implementation reading the real principal kind.
    isInteractiveUserSession: actual.isInteractiveUserSession,
  };
});

vi.mock('../../services/aiTicketProposal', () => ({
  getLatestTicketProposal: vi.fn(),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => []),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve),
        })),
      })),
    })),
  },
}));

vi.mock('../../db/schema', () => ({
  tickets: {
    id: 'id', orgId: 'orgId', partnerId: 'partnerId', status: 'status',
    priority: 'priority', assignedTo: 'assignedTo', categoryId: 'categoryId',
    internalNumber: 'internalNumber', subject: 'subject', createdAt: 'createdAt',
    updatedAt: 'updatedAt', dueDate: 'dueDate', deviceId: 'deviceId',
    source: 'source', slaBreachedAt: 'sla_breached_at', firstResponseAt: 'first_response_at',
    responseSlaMinutes: 'response_sla_minutes', resolutionSlaMinutes: 'resolution_sla_minutes',
    slaPausedAt: 'sla_paused_at', slaPausedMinutes: 'sla_paused_minutes',
    slaBreachReason: 'sla_breach_reason',
  },
  ticketComments: { ticketId: 'ticketId', deletedAt: 'deletedAt', createdAt: 'createdAt' },
  ticketCategories: {},
  ticketAlertLinks: { ticketId: 'ticketId', alertId: 'alertId', id: 'id', linkType: 'linkType' },
  alerts: { id: 'id', title: 'title', severity: 'severity', status: 'status', deviceId: 'deviceId' },
  devices: { id: 'id', hostname: 'hostname', orgId: 'orgId', siteId: 'siteId' },
  organizations: { id: 'id', name: 'name', currencyCode: 'currencyCode' },
  users: { id: 'id', name: 'name' },
  timeEntries: { id: 'id', ticketId: 'ticketId', orgId: 'orgId' },
  ticketParts: { id: 'id', ticketId: 'ticketId', orgId: 'orgId' },
  ticketChecklistItems: {
    id: 'id', orgId: 'orgId', ticketId: 'ticketId', label: 'label', detail: 'detail',
    position: 'position', doneAt: 'doneAt', doneByUserId: 'doneByUserId', source: 'source',
    sourceTemplateItemId: 'sourceTemplateItemId', createdBy: 'createdBy',
    createdAt: 'createdAt', updatedAt: 'updatedAt',
  },
}));

vi.mock('./tickets', async () => {
  const actual = await vi.importActual<typeof import('./tickets')>('./tickets');
  return { ...actual, getScopedTicketOr404: getScopedTicketOr404Mock };
});

vi.mock('../../services/ticketChecklistService', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketChecklistService')>(
    '../../services/ticketChecklistService',
  );
  return { ...actual, ...checklistMocks };
});

vi.mock('../../services/ticketChecklistTemplateService', async () => {
  const actual = await vi.importActual<
    typeof import('../../services/ticketChecklistTemplateService')
  >('../../services/ticketChecklistTemplateService');
  return { ...actual, ...templateMocks };
});

vi.mock('../../services/sensitiveReadAudit', () => ({
  auditSensitiveRead: vi.fn(),
}));

import { ticketsRoutes } from './index';
import { ChecklistServiceError } from '../../services/ticketChecklistService';

const TICKET_ID = '3f2f1d8e-1111-4222-8333-444455556666';
const ITEM_ID = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function resetMocks() {
  vi.clearAllMocks();
  authRef.current = {
    scope: 'partner',
    principal: { kind: 'user_session' },
    user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
    partnerId: 'p-1',
    orgId: null,
    accessibleOrgIds: null,
    orgCondition: () => undefined,
    canAccessOrg: (_id: string) => true,
  };
}

describe('checklist routes', () => {
  beforeEach(resetMocks);

  it('404s when the ticket is out of scope', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist`);
    expect(res.status).toBe(404);
    expect(checklistMocks.listChecklist).not.toHaveBeenCalled();
  });

  it('404s for a SOFT-DELETED ticket (rows survive, access does not)', async () => {
    // getScopedTicketOr404 filters deletedAt itself; this pins that the route
    // does not pass includeDeleted and so never serves a deleted ticket.
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist`);
    expect(res.status).toBe(404);
    expect(getScopedTicketOr404Mock).toHaveBeenCalledWith(expect.anything(), TICKET_ID);
  });

  it('GET returns items with done and total', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    checklistMocks.listChecklist.mockResolvedValue({ items: [{ id: ITEM_ID }], done: 0, total: 1 });
    const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { items: [{ id: ITEM_ID }], done: 0, total: 1 } });
  });

  it('POST creates an item and answers 201, stamping the TICKET org', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    checklistMocks.addChecklistItem.mockResolvedValue({ id: ITEM_ID, label: 'Step' });
    const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ label: 'Step' }),
    });
    expect(res.status).toBe(201);
    expect(checklistMocks.addChecklistItem).toHaveBeenCalledWith(
      { id: TICKET_ID, orgId: 'o-1' },
      { label: 'Step' },
      { userId: 'u-1' },
    );
  });

  it('POST 404s an out-of-scope ticket without writing', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ label: 'Step' }),
    });
    expect(res.status).toBe(404);
    expect(checklistMocks.addChecklistItem).not.toHaveBeenCalled();
  });

  it('PATCH re-checks scope through the item’s OWN ticket', async () => {
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue(null); // the item's ticket is foreign
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ label: 'New' }),
    });
    expect(res.status).toBe(404);
    expect(checklistMocks.patchChecklistItem).not.toHaveBeenCalled();
  });

  it('PATCH succeeds for an in-scope item', async () => {
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    checklistMocks.patchChecklistItem.mockResolvedValue({ id: ITEM_ID, done: true });
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(200);
    expect(checklistMocks.patchChecklistItem).toHaveBeenCalledWith(
      ITEM_ID, { done: true }, { userId: 'u-1' },
    );
  });

  it('403 CHECKLIST_TICK_REQUIRES_USER when an API-key principal ticks', async () => {
    // An MCP API key carries its CREATOR's real user id, so identity alone
    // cannot answer "is a human doing this". This gate is the actual control
    // that keeps a compliance attestation human — not the absence of an AI tool.
    authRef.current.principal = { kind: 'api_key', apiKeyId: 'k-1' };
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CHECKLIST_TICK_REQUIRES_USER');
    expect(checklistMocks.patchChecklistItem).not.toHaveBeenCalled();
  });

  it('an API-key principal MAY still edit a label (only `done` is gated)', async () => {
    authRef.current.principal = { kind: 'api_key', apiKeyId: 'k-1' };
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    checklistMocks.patchChecklistItem.mockResolvedValue({ id: ITEM_ID, label: 'New' });
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ label: 'New' }),
    });
    expect(res.status).toBe(200);
  });

  it('403 also covers done: false — an agent must not UNTICK a human attestation', async () => {
    authRef.current.principal = { kind: 'api_key', apiKeyId: 'k-1' };
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ done: false }),
    });
    expect(res.status).toBe(403);
    expect(checklistMocks.patchChecklistItem).not.toHaveBeenCalled();
  });

  it('reorder maps CHECKLIST_REORDER_MISMATCH to 400', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    checklistMocks.reorderChecklist.mockRejectedValue(
      new ChecklistServiceError('mismatch', 400, 'CHECKLIST_REORDER_MISMATCH'),
    );
    const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist/reorder`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ itemIds: [ITEM_ID] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('CHECKLIST_REORDER_MISMATCH');
  });

  it('reorder succeeds and returns the refreshed summary', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    checklistMocks.reorderChecklist.mockResolvedValue({ items: [], done: 0, total: 0 });
    const res = await ticketsRoutes.request(`/${TICKET_ID}/checklist/reorder`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ itemIds: [ITEM_ID] }),
    });
    expect(res.status).toBe(200);
    expect(checklistMocks.reorderChecklist).toHaveBeenCalledWith(TICKET_ID, [ITEM_ID]);
  });

  it('rejects doneAt in the body with a 400 before reaching the service', async () => {
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ doneAt: '2026-01-01T00:00:00.000Z' }),
    });
    expect(res.status).toBe(400);
    expect(checklistMocks.patchChecklistItem).not.toHaveBeenCalled();
  });

  it('DELETE 404s an item whose ticket is out of scope, without deleting', async () => {
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(checklistMocks.deleteChecklistItem).not.toHaveBeenCalled();
  });

  it('DELETE removes an in-scope item', async () => {
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    checklistMocks.deleteChecklistItem.mockResolvedValue(undefined);
    const res = await ticketsRoutes.request(`/checklist/${ITEM_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(checklistMocks.deleteChecklistItem).toHaveBeenCalledWith(ITEM_ID);
  });

  // ── apply-template (#5783 W02) ────────────────────────────────────────────

  const TEMPLATE_ID = '55556666-7777-4888-9999-aaaabbbbcccc';
  const applyTemplate = (body: unknown) =>
    ticketsRoutes.request(`/${TICKET_ID}/checklist/apply-template`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  it('apply-template 404s a ticket out of scope, without touching the service', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await applyTemplate({ templateId: TEMPLATE_ID });
    expect(res.status).toBe(404);
    expect(templateMocks.applyChecklistTemplateToTicket).not.toHaveBeenCalled();
  });

  it('apply-template 404s a template the caller cannot see', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    templateMocks.applyChecklistTemplateToTicket.mockRejectedValue(
      new ChecklistServiceError('Not found', 404, 'NOT_FOUND'),
    );
    const res = await applyTemplate({ templateId: TEMPLATE_ID });
    expect(res.status).toBe(404);
  });

  it('apply-template passes the TICKET through to the service, not just its id', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    templateMocks.applyChecklistTemplateToTicket.mockResolvedValue({ items: [], done: 0, total: 0 });
    await applyTemplate({ templateId: TEMPLATE_ID, mode: 'replace_unticked' });
    expect(templateMocks.applyChecklistTemplateToTicket).toHaveBeenCalledWith(
      { id: TICKET_ID, orgId: 'o-1' },
      { templateId: TEMPLATE_ID, mode: 'replace_unticked' },
      expect.objectContaining({ userId: 'u-1' }),
    );
  });

  it('apply-template defaults the mode to append', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    templateMocks.applyChecklistTemplateToTicket.mockResolvedValue({ items: [], done: 0, total: 0 });
    await applyTemplate({ templateId: TEMPLATE_ID });
    expect(templateMocks.applyChecklistTemplateToTicket).toHaveBeenCalledWith(
      expect.anything(),
      { templateId: TEMPLATE_ID, mode: 'append' },
      expect.anything(),
    );
  });

  it('apply-template 400s an unknown mode', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    const res = await applyTemplate({ templateId: TEMPLATE_ID, mode: 'replace_all' });
    expect(res.status).toBe(400);
    expect(templateMocks.applyChecklistTemplateToTicket).not.toHaveBeenCalled();
  });

  it('apply-template is NOT gated on an interactive session — only ticking is', async () => {
    // Applying a template creates UNTICKED steps. It asserts nothing about work
    // performed, so an automation may legitimately do it.
    authRef.current.principal = { kind: 'api_key', apiKeyId: 'k-1' };
    getScopedTicketOr404Mock.mockResolvedValue({ id: TICKET_ID, orgId: 'o-1' });
    templateMocks.applyChecklistTemplateToTicket.mockResolvedValue({ items: [], done: 0, total: 0 });
    const res = await applyTemplate({ templateId: TEMPLATE_ID });
    expect(res.status).toBe(200);
  });
});
