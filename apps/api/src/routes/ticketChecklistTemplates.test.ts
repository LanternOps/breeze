import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const authState = vi.hoisted(() => ({
  scope: 'partner' as string,
  partnerOrgAccess: 'all' as string | null,
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      user: { id: 'u1' },
      partnerId: 'p1',
      accessibleOrgIds: ['org1'],
      scope: authState.scope,
      partnerOrgAccess: authState.partnerOrgAccess,
    });
    c.set('permissions', { permissions: [{ resource: 'tickets', action: 'read' }] });
    return next();
  },
  requireScope:
    (...allowed: string[]) =>
    async (c: any, next: any) =>
      allowed.includes(c.get('auth')?.scope) ? next() : c.json({ error: 'Forbidden' }, 403),
  requirePermission: () => async (c: any, next: any) =>
    c.req.header('x-allow') === 'true' ? next() : c.json({ error: 'Forbidden' }, 403),
}));

const serviceMocks = vi.hoisted(() => ({
  listChecklistTemplates: vi.fn(),
  getChecklistTemplate: vi.fn(),
  createChecklistTemplate: vi.fn(),
  updateChecklistTemplate: vi.fn(),
  deleteChecklistTemplate: vi.fn(),
  addChecklistTemplateItem: vi.fn(),
  updateChecklistTemplateItem: vi.fn(),
  removeChecklistTemplateItem: vi.fn(),
  reorderChecklistTemplateItems: vi.fn(),
  applyChecklistTemplateToTicket: vi.fn(),
}));
vi.mock('../services/ticketChecklistTemplateService', () => ({
  ...serviceMocks,
  ChecklistTemplateServiceError: class ChecklistTemplateServiceError extends Error {
    constructor(
      msg: string,
      public status = 400,
      public code = 'ERR',
      public details?: unknown,
    ) {
      super(msg);
    }
  },
}));

import { authMiddleware } from '../middleware/auth';
import { ticketChecklistTemplateRoutes } from './ticketChecklistTemplates';
import { ChecklistTemplateServiceError } from '../services/ticketChecklistTemplateService';
import {
  PartnerWideWriteDeniedError,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../services/partnerWideAccess';

const {
  listChecklistTemplates,
  createChecklistTemplate,
  updateChecklistTemplate,
  deleteChecklistTemplate,
  addChecklistTemplateItem,
  updateChecklistTemplateItem,
} = serviceMocks;

const TEMPLATE = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const NO_PERM = { authorization: 'Bearer token' };
const AUTH = { authorization: 'Bearer token', 'x-allow': 'true' };
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };

const app = new Hono();
app.use('*', authMiddleware);
app.route('/ticket-checklist-templates', ticketChecklistTemplateRoutes);

const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: JSON_AUTH, body: JSON.stringify(body) });
const patch = (path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: JSON_AUTH, body: JSON.stringify(body) });

describe('ticket checklist template routes (#5783 W02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.scope = 'partner';
    authState.partnerOrgAccess = 'all';
  });

  it('401 without auth', async () => {
    expect((await app.request('/ticket-checklist-templates')).status).toBe(401);
  });

  it('403 when the role lacks tickets:write on POST', async () => {
    const res = await app.request('/ticket-checklist-templates', {
      method: 'POST',
      headers: { ...NO_PERM, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Device onboarding' }),
    });
    expect(res.status).toBe(403);
    expect(createChecklistTemplate).not.toHaveBeenCalled();
  });

  it('refuses an ORG-scoped token outright (requireScope partner|system)', async () => {
    // Checklist templates are internal MSP procedure — no org token and no
    // portal surface ever reaches them (spec §2).
    authState.scope = 'organization';
    authState.partnerOrgAccess = null;
    const res = await app.request('/ticket-checklist-templates', { headers: AUTH });
    expect(res.status).toBe(403);
    expect(listChecklistTemplates).not.toHaveBeenCalled();
  });

  it('404s a template outside the caller’s org and partner, never 403', async () => {
    updateChecklistTemplate.mockRejectedValueOnce(
      new ChecklistTemplateServiceError('Not found', 404, 'NOT_FOUND'),
    );
    const res = await patch(`/ticket-checklist-templates/${TEMPLATE}`, { name: 'Y' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps PartnerWideWriteDeniedError to 403 PARTNER_WIDE_WRITE_DENIED', async () => {
    createChecklistTemplate.mockRejectedValueOnce(new PartnerWideWriteDeniedError());
    const res = await post('/ticket-checklist-templates', {
      name: 'Shared runbook',
      ownerScope: 'partner',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: PARTNER_WIDE_WRITE_DENIED_MESSAGE,
      code: 'PARTNER_WIDE_WRITE_DENIED',
    });
  });

  it('POST accepts ownerScope partner and passes it through', async () => {
    createChecklistTemplate.mockResolvedValueOnce({ id: TEMPLATE, ownerScope: 'partner' });
    const res = await post('/ticket-checklist-templates', {
      name: 'Shared runbook',
      ownerScope: 'partner',
    });
    expect(res.status).toBe(200);
    expect(createChecklistTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Shared runbook', ownerScope: 'partner' }),
      expect.objectContaining({ userId: 'u1', scope: 'partner', partnerOrgAccess: 'all' }),
    );
  });

  it('PATCH REJECTS ownerScope with a 400 — ownership is create-only', async () => {
    const res = await patch(`/ticket-checklist-templates/${TEMPLATE}`, { ownerScope: 'partner' });
    expect(res.status).toBe(400);
    expect(updateChecklistTemplate).not.toHaveBeenCalled();
  });

  it('PATCH REJECTS orgId for the same reason', async () => {
    const res = await patch(`/ticket-checklist-templates/${TEMPLATE}`, { orgId: TEMPLATE });
    expect(res.status).toBe(400);
    expect(updateChecklistTemplate).not.toHaveBeenCalled();
  });

  it('PATCH accepts an isActive-only patch', async () => {
    updateChecklistTemplate.mockResolvedValueOnce({ id: TEMPLATE, isActive: false });
    const res = await patch(`/ticket-checklist-templates/${TEMPLATE}`, { isActive: false });
    expect(res.status).toBe(200);
    expect(updateChecklistTemplate).toHaveBeenCalledWith(
      TEMPLATE,
      { isActive: false },
      expect.anything(),
    );
  });

  it('DELETE returns ok', async () => {
    deleteChecklistTemplate.mockResolvedValueOnce(undefined);
    const res = await app.request(`/ticket-checklist-templates/${TEMPLATE}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(deleteChecklistTemplate).toHaveBeenCalledWith(TEMPLATE, expect.anything());
  });

  it('DELETE maps the in-use guard onto a 409 carrying the referencing rows', async () => {
    // #5808 W03: the delete guard's whole point is telling the user WHAT is in
    // the way, so `details` has to survive the route's error envelope.
    deleteChecklistTemplate.mockRejectedValueOnce(
      Object.assign(new Error('This checklist template is still used by a deliverable'), {
        status: 409,
        code: 'CHECKLIST_TEMPLATE_IN_USE',
        details: { deliverables: [{ id: 'd-1', name: 'Monthly review' }], templateItems: [] },
      }),
    );
    const res = await app.request(`/ticket-checklist-templates/${TEMPLATE}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('CHECKLIST_TEMPLATE_IN_USE');
    expect(body.details).toEqual({
      deliverables: [{ id: 'd-1', name: 'Monthly review' }],
      templateItems: [],
    });
  });

  it('GET passes includeInactive through', async () => {
    listChecklistTemplates.mockResolvedValueOnce([]);
    const res = await app.request('/ticket-checklist-templates?includeInactive=true', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(listChecklistTemplates).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeInactive: true }),
    );
  });

  it('GET ?includeInactive=false does NOT read as true', async () => {
    // optionalQueryBoolean, not z.coerce.boolean() — the latter makes every
    // non-empty string truthy.
    listChecklistTemplates.mockResolvedValueOnce([]);
    await app.request('/ticket-checklist-templates?includeInactive=false', { headers: AUTH });
    expect(listChecklistTemplates).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeInactive: false }),
    );
  });

  it('routes /items/:itemId to the ITEM handler, not the /:id template handler', async () => {
    // Literal-path routes must be registered before param routes; otherwise
    // `/items/<uuid>` would be parsed as a template id.
    updateChecklistTemplateItem.mockResolvedValueOnce({ id: ITEM, label: 'Renamed' });
    const res = await patch(`/ticket-checklist-templates/items/${ITEM}`, { label: 'Renamed' });
    expect(res.status).toBe(200);
    expect(updateChecklistTemplateItem).toHaveBeenCalledWith(
      ITEM,
      { label: 'Renamed' },
      expect.anything(),
    );
    expect(updateChecklistTemplate).not.toHaveBeenCalled();
  });

  it('POST /:id/items adds an item', async () => {
    addChecklistTemplateItem.mockResolvedValueOnce({ id: ITEM, label: 'Step' });
    const res = await post(`/ticket-checklist-templates/${TEMPLATE}/items`, { label: 'Step' });
    expect(res.status).toBe(200);
    expect(addChecklistTemplateItem).toHaveBeenCalledWith(
      TEMPLATE,
      expect.objectContaining({ label: 'Step', sortOrder: 0 }),
      expect.anything(),
    );
  });

  it('400 on a non-uuid template id', async () => {
    const res = await app.request('/ticket-checklist-templates/not-a-uuid', { headers: AUTH });
    expect(res.status).toBe(400);
  });

  it('GET /:id returns one template', async () => {
    serviceMocks.getChecklistTemplate.mockResolvedValueOnce({ id: TEMPLATE, name: 'X' });
    const res = await app.request(`/ticket-checklist-templates/${TEMPLATE}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(serviceMocks.getChecklistTemplate).toHaveBeenCalledWith(TEMPLATE, expect.anything());
  });

  it('DELETE /items/:itemId removes one item', async () => {
    serviceMocks.removeChecklistTemplateItem.mockResolvedValueOnce(undefined);
    const res = await app.request(`/ticket-checklist-templates/items/${ITEM}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(serviceMocks.removeChecklistTemplateItem).toHaveBeenCalledWith(ITEM, expect.anything());
    // The literal /items path must not be swallowed by the /:id template route.
    expect(deleteChecklistTemplate).not.toHaveBeenCalled();
  });

  it('POST /:id/items/reorder passes the whole id list through', async () => {
    serviceMocks.reorderChecklistTemplateItems.mockResolvedValueOnce([]);
    const res = await post(`/ticket-checklist-templates/${TEMPLATE}/items/reorder`, {
      itemIds: [ITEM],
    });
    expect(res.status).toBe(200);
    expect(serviceMocks.reorderChecklistTemplateItems).toHaveBeenCalledWith(
      TEMPLATE,
      [ITEM],
      expect.anything(),
    );
  });

  it('reorder 400s an empty id list without calling the service', async () => {
    const res = await post(`/ticket-checklist-templates/${TEMPLATE}/items/reorder`, {
      itemIds: [],
    });
    expect(res.status).toBe(400);
    expect(serviceMocks.reorderChecklistTemplateItems).not.toHaveBeenCalled();
  });

  it('maps a 409 duplicate-name service error onto the envelope', async () => {
    createChecklistTemplate.mockRejectedValueOnce(
      new ChecklistTemplateServiceError(
        'A checklist template with this name already exists',
        409,
        'DUPLICATE_CHECKLIST_TEMPLATE_NAME',
      ),
    );
    const res = await post('/ticket-checklist-templates', { name: 'Dupe' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'DUPLICATE_CHECKLIST_TEMPLATE_NAME' });
  });
});
