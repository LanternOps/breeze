import { beforeEach, describe, expect, it, vi } from 'vitest';

const TPL = '00000000-0000-4000-8000-0000000000a1';
const ITEM = '00000000-0000-4000-8000-0000000000a2';
const ORG = '00000000-0000-4000-8000-0000000000b1';

const { svc } = vi.hoisted(() => ({
  svc: {
    addChecklistTemplateItem: vi.fn(), createChecklistTemplate: vi.fn(), deleteChecklistTemplate: vi.fn(),
    getChecklistTemplate: vi.fn(), listChecklistTemplates: vi.fn(), removeChecklistTemplateItem: vi.fn(),
    reorderChecklistTemplateItems: vi.fn(), updateChecklistTemplate: vi.fn(), updateChecklistTemplateItem: vi.fn(),
  },
}));
vi.mock('./ticketChecklistTemplateService', () => svc);

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerTicketChecklistTemplateTools } from './aiToolsTicketChecklistTemplates';

const tool = (() => {
  const tools = new Map<string, AiTool>();
  registerTicketChecklistTemplateTools(tools);
  return tools.get('manage_ticket_checklist_templates')!;
})();

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' }, user: { id: 'user-1', name: 'Tech', isPlatformAdmin: false }, token: {},
  partnerId: 'p1', orgId: null, scope: 'partner', partnerOrgAccess: 'selected', accessibleOrgIds: [ORG], ...over,
}) as unknown as AuthContext;
const run = async (input: Record<string, unknown>, auth = makeAuth()) =>
  JSON.parse(await tool.handler(input, auth)) as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe('manage_ticket_checklist_templates (W06)', () => {
  it('names every action in a description inside the budget', () => {
    const d = tool.definition.description ?? '';
    expect(d.length).toBeLessThanOrEqual(300);
    const actions = (tool.definition.input_schema as { properties: { action: { enum: string[] } } }).properties.action.enum;
    for (const a of actions) expect(d).toContain(a);
  });

  it('passes the service the full actor: scope AND partnerOrgAccess (partner-wide writes gate on both)', async () => {
    svc.listChecklistTemplates.mockResolvedValue([]);
    await run({ action: 'list', orgId: ORG, includeInactive: true });
    expect(svc.listChecklistTemplates).toHaveBeenCalledWith(
      { userId: 'user-1', scope: 'partner', partnerId: 'p1', partnerOrgAccess: 'selected', accessibleOrgIds: [ORG] },
      { orgId: ORG, includeInactive: true },
    );
  });

  it('is partner/system only', async () => {
    expect(await run({ action: 'list' }, makeAuth({ scope: 'organization', orgId: ORG }))).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
    expect(svc.listChecklistTemplates).not.toHaveBeenCalled();
  });

  it.each(['create', 'update', 'delete', 'add_item', 'update_item', 'remove_item', 'reorder_items'])(
    '%s refuses an ai_agent principal before any service call', async (action) => {
      const agent = makeAuth({ principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' } });
      expect(await run({ action, id: TPL, itemId: ITEM, itemIds: [ITEM], data: { name: 'x' } }, agent)).toEqual({ error: 'agent_principal_unsupported_action', action });
      for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it('pages the list', async () => {
    svc.listChecklistTemplates.mockResolvedValue(Array.from({ length: 4 }, (_, i) => ({ id: `t${i}` })));
    const res = await run({ action: 'list', limit: 3 });
    expect(res).toMatchObject({ showing: 3, total: 4, hasMore: true });
  });

  it('get returns one template; id must be a UUID', async () => {
    svc.getChecklistTemplate.mockResolvedValue({ id: TPL, name: 'Onboarding' });
    expect(await run({ action: 'get', id: TPL })).toEqual({ template: { id: TPL, name: 'Onboarding' } });
    expect(await run({ action: 'get', id: 'nope' })).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  describe('create', () => {
    it('validates with the route schema (strict: an unknown key and a missing name are refused)', async () => {
      expect(await run({ action: 'create', data: { name: 'x', surprise: 1 } })).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await run({ action: 'create', data: {} })).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(svc.createChecklistTemplate).not.toHaveBeenCalled();
    });

    it('defaults ownerScope to organization and passes items through', async () => {
      svc.createChecklistTemplate.mockResolvedValue({ id: TPL });
      await run({ action: 'create', data: { name: 'Onboarding', orgId: ORG, items: [{ label: 'Create account' }] } });
      expect(svc.createChecklistTemplate).toHaveBeenCalledWith(
        { name: 'Onboarding', orgId: ORG, ownerScope: 'organization', items: [{ label: 'Create account', sortOrder: 0 }] },
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('a partner-wide create reaches the service, which owns the 403 gate; the denial becomes a tool error', async () => {
      const denied = Object.assign(new Error('Managing partner-wide state requires full partner org access'), { name: 'PartnerWideWriteDeniedError' });
      svc.createChecklistTemplate.mockRejectedValue(denied);
      expect(await run({ action: 'create', data: { name: 'x', ownerScope: 'partner' } })).toMatchObject({ code: 'ACCESS_DENIED' });
    });
  });

  describe('update / delete / items', () => {
    it('update validates (ownerScope is create-only and rejected) and calls the service', async () => {
      expect(await run({ action: 'update', id: TPL, data: { ownerScope: 'partner' } })).toMatchObject({ code: 'VALIDATION_ERROR' });
      svc.updateChecklistTemplate.mockResolvedValue({ id: TPL, isActive: false });
      await run({ action: 'update', id: TPL, data: { isActive: false } });
      expect(svc.updateChecklistTemplate).toHaveBeenCalledWith(TPL, { isActive: false }, expect.any(Object));
    });

    it('delete: maps the in-use refusal (409) to a coded error', async () => {
      svc.deleteChecklistTemplate.mockResolvedValue(undefined);
      expect(await run({ action: 'delete', id: TPL })).toEqual({ deleted: true, id: TPL });
      const inUse = Object.assign(new Error('Template is used by a deliverable'), { name: 'ChecklistTemplateServiceError', status: 409, code: 'CHECKLIST_TEMPLATE_IN_USE' });
      svc.deleteChecklistTemplate.mockRejectedValue(inUse);
      expect(await run({ action: 'delete', id: TPL })).toMatchObject({ code: 'CHECKLIST_TEMPLATE_IN_USE' });
    });

    it('add_item / update_item / remove_item / reorder_items call the item services with the parsed payload', async () => {
      svc.addChecklistTemplateItem.mockResolvedValue({ id: ITEM });
      svc.updateChecklistTemplateItem.mockResolvedValue({ id: ITEM });
      svc.removeChecklistTemplateItem.mockResolvedValue(undefined);
      svc.reorderChecklistTemplateItems.mockResolvedValue([]);
      await run({ action: 'add_item', id: TPL, data: { label: 'Step' } });
      expect(svc.addChecklistTemplateItem).toHaveBeenCalledWith(TPL, { label: 'Step', sortOrder: 0 }, expect.any(Object));
      await run({ action: 'update_item', itemId: ITEM, data: { detail: null } });
      expect(svc.updateChecklistTemplateItem).toHaveBeenCalledWith(ITEM, { detail: null }, expect.any(Object));
      expect(await run({ action: 'remove_item', itemId: ITEM })).toEqual({ removed: true, itemId: ITEM });
      await run({ action: 'reorder_items', id: TPL, itemIds: [ITEM] });
      expect(svc.reorderChecklistTemplateItems).toHaveBeenCalledWith(TPL, [ITEM], expect.any(Object));
    });

    it('each action demands its id (template id, or item id for update_item/remove_item)', async () => {
      expect(await run({ action: 'add_item', data: { label: 'x' } })).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await run({ action: 'update_item', data: { label: 'x' } })).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await run({ action: 'remove_item' })).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await run({ action: 'reorder_items', id: TPL })).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rethrows an unexpected error', async () => {
      svc.deleteChecklistTemplate.mockRejectedValue(new Error('boom'));
      await expect(run({ action: 'delete', id: TPL })).rejects.toThrow('boom');
    });
  });
});
