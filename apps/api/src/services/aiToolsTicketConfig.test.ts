import { beforeEach, describe, expect, it, vi } from 'vitest';

const PARTNER = '00000000-0000-4000-8000-0000000000a1';
const ORG = '00000000-0000-4000-8000-0000000000b1';
const ID = '00000000-0000-4000-8000-0000000000c1';

const { cfg, cats, perms, mockLimit } = vi.hoisted(() => ({
  cfg: {
    getTicketConfig: vi.fn(), createTicketStatus: vi.fn(), updateTicketStatus: vi.fn(), reorderTicketStatuses: vi.fn(),
    upsertPrioritySettings: vi.fn(), getOrgTicketSettings: vi.fn(), upsertOrgTicketSettings: vi.fn(),
    listCustomerEmailDomains: vi.fn(), createCustomerEmailDomain: vi.fn(), updateCustomerEmailDomain: vi.fn(),
    deleteCustomerEmailDomain: vi.fn(),
  },
  cats: { listCategoryRows: vi.fn(), createCategory: vi.fn(), updateCategory: vi.fn(), deleteCategory: vi.fn(), reorderCategories: vi.fn() },
  perms: { getUserPermissions: vi.fn(), hasPermission: vi.fn() },
  mockLimit: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([{ id: '00000000-0000-4000-8000-0000000000b1' }])),
}));

vi.mock('../db', () => ({ db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockLimit })) })) })) } }));
vi.mock('../db/schema', () => ({ organizations: { id: 'organizations.id', deletedAt: 'organizations.deleted_at' } }));
vi.mock('./ticketConfigService', () => cfg);
vi.mock('./aiToolsTicketCategories', () => cats);
vi.mock('./permissions', () => perms);

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerTicketConfigTools } from './aiToolsTicketConfig';

const tool = (() => {
  const tools = new Map<string, AiTool>();
  registerTicketConfigTools(tools);
  return tools.get('manage_ticket_config')!;
})();

function makeAuth(over: Partial<AuthContext> & { admin?: boolean; full?: boolean } = {}): AuthContext {
  const { admin = true, full = true, ...rest } = over;
  return {
    principal: { kind: 'user_session' },
    user: { id: 'user-1', email: 't@example.com', name: 'Tech', isPlatformAdmin: admin },
    token: {} as AuthContext['token'],
    partnerId: PARTNER,
    orgId: null,
    scope: 'partner',
    partnerOrgAccess: full ? 'all' : 'selected',
    accessibleOrgIds: [ORG],
    orgCondition: vi.fn(() => undefined),
    canAccessOrg: vi.fn(() => true),
    ...rest,
  } as unknown as AuthContext;
}

const run = async (input: Record<string, unknown>, auth = makeAuth()) =>
  JSON.parse(await tool.handler(input, auth)) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mockLimit.mockResolvedValue([{ id: ORG }]);
  perms.getUserPermissions.mockResolvedValue(null);
  perms.hasPermission.mockReturnValue(false);
});

describe('manage_ticket_config (W06)', () => {
  it('describes every action and stays inside the description budget', () => {
    const d = tool.definition.description ?? '';
    expect(d.length).toBeLessThanOrEqual(300);
    const actions = (tool.definition.input_schema as { properties: { action: { enum: string[] } } }).properties.action.enum;
    for (const a of actions) expect(d).toContain(a);
  });

  describe('scope and agent gates', () => {
    it('refuses an organization token for everything except list_categories', async () => {
      const org = makeAuth({ scope: 'organization', orgId: ORG, partnerOrgAccess: undefined });
      for (const action of ['get_config', 'create_status', 'create_category', 'list_domains']) {
        expect(await run({ action }, org)).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
      }
      cats.listCategoryRows.mockResolvedValue({ rows: [{ id: ID, name: 'Hardware' }] });
      expect(await run({ action: 'list_categories' }, org)).toMatchObject({ categories: [{ id: ID }] });
    });

    it.each([
      'update_org_settings', 'create_category', 'update_category', 'delete_category', 'reorder_categories',
      'create_status', 'update_status', 'reorder_statuses', 'set_priorities', 'create_domain', 'update_domain', 'delete_domain',
    ])('%s refuses an ai_agent principal before any service call', async (action) => {
      const agent = makeAuth({ principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' } as AuthContext['principal'] });
      expect(await run({ action, id: ID, ids: [ID], orgId: ORG, data: { name: 'x' } }, agent)).toEqual({ error: 'agent_principal_unsupported_action', action });
      for (const fn of [...Object.values(cfg), ...Object.values(cats)]) expect(fn).not.toHaveBeenCalled();
    });

    it('an unknown action is a tool error, not a throw', async () => {
      expect(await run({ action: 'nope' })).toMatchObject({ error: expect.stringContaining('Unknown action') });
    });
  });

  describe('admin predicate (routes/ticketConfig.ts adminMiddleware)', () => {
    it('get_config needs full partner access but no admin role', async () => {
      cfg.getTicketConfig.mockResolvedValue({ statuses: [], priorities: {} });
      expect(await run({ action: 'get_config' }, makeAuth({ admin: false }))).toEqual({ statuses: [], priorities: {} });
      expect(await run({ action: 'get_config' }, makeAuth({ full: false }))).toMatchObject({ code: 'ACCESS_DENIED' });
      expect(cfg.getTicketConfig).toHaveBeenCalledTimes(1);
      expect(cfg.getTicketConfig).toHaveBeenCalledWith(PARTNER);
    });

    it.each(['list_domains', 'create_status', 'update_status', 'reorder_statuses', 'set_priorities', 'create_domain', 'update_domain', 'delete_domain'])(
      '%s is denied to a non-admin with full partner access, and to an admin without it',
      async (action) => {
        const input = { action, id: ID, ids: [ID], data: {} };
        expect(await run(input, makeAuth({ admin: false }))).toMatchObject({ code: 'ACCESS_DENIED', error: expect.stringContaining('admin role') });
        expect(await run(input, makeAuth({ full: false }))).toMatchObject({ code: 'ACCESS_DENIED' });
        for (const fn of Object.values(cfg)) expect(fn).not.toHaveBeenCalled();
      },
    );

    it('a wildcard *:* grant passes the admin check', async () => {
      perms.getUserPermissions.mockResolvedValue({ permissions: [{ resource: '*', action: '*' }] });
      perms.hasPermission.mockImplementation((_p: unknown, r: string, a: string) => r === '*' && a === '*');
      cfg.listCustomerEmailDomains.mockResolvedValue([]);
      expect(await run({ action: 'list_domains' }, makeAuth({ admin: false }))).toMatchObject({ domains: [] });
    });
  });

  describe('writes validate with the route schema and use the caller partner, never input', () => {
    it('create_status: ignores a partnerId in data, rejects a bad coreStatus with the field path', async () => {
      cfg.createTicketStatus.mockResolvedValue({ id: ID, name: 'Waiting on vendor' });
      const ok = await run({ action: 'create_status', data: { name: 'Waiting on vendor', coreStatus: 'pending', partnerId: 'evil' } });
      expect(ok).toEqual({ status: { id: ID, name: 'Waiting on vendor' } });
      expect(cfg.createTicketStatus).toHaveBeenCalledWith(PARTNER, { name: 'Waiting on vendor', coreStatus: 'pending' });
      const bad = await run({ action: 'create_status', data: { name: 'x', coreStatus: 'not-a-status' } });
      expect(bad).toMatchObject({ code: 'VALIDATION_ERROR', error: expect.stringContaining('coreStatus') });
      expect(cfg.createTicketStatus).toHaveBeenCalledTimes(1);
    });

    it('update_status needs a status UUID and at least one field', async () => {
      expect(await run({ action: 'update_status', data: { name: 'x' } })).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await run({ action: 'update_status', id: ID, data: {} })).toMatchObject({ code: 'VALIDATION_ERROR' });
      cfg.updateTicketStatus.mockResolvedValue({ id: ID });
      await run({ action: 'update_status', id: ID, data: { isActive: false } });
      expect(cfg.updateTicketStatus).toHaveBeenCalledWith(PARTNER, ID, { isActive: false });
    });

    it('reorder_statuses refuses duplicate ids', async () => {
      expect(await run({ action: 'reorder_statuses', ids: [ID, ID] })).toMatchObject({ code: 'VALIDATION_ERROR' });
      cfg.reorderTicketStatuses.mockResolvedValue({ updated: 1 });
      expect(await run({ action: 'reorder_statuses', ids: [ID] })).toEqual({ updated: 1 });
    });

    it('set_priorities validates SLA minutes', async () => {
      expect(await run({ action: 'set_priorities', data: { priorities: { high: { responseSlaMinutes: -5 } } } })).toMatchObject({ code: 'VALIDATION_ERROR' });
      cfg.upsertPrioritySettings.mockResolvedValue({ high: { responseSlaMinutes: 30 } });
      await run({ action: 'set_priorities', data: { priorities: { high: { responseSlaMinutes: 30 } } } });
      expect(cfg.upsertPrioritySettings).toHaveBeenCalledWith(PARTNER, { priorities: { high: { responseSlaMinutes: 30 } } });
    });

    it('create_domain rejects free-mail domains and stamps the caller as creator', async () => {
      expect(await run({ action: 'create_domain', data: { domain: 'gmail.com', orgId: ORG } })).toMatchObject({ code: 'VALIDATION_ERROR' });
      cfg.createCustomerEmailDomain.mockResolvedValue({ id: ID, domain: 'acme.com' });
      await run({ action: 'create_domain', data: { domain: 'Acme.com', orgId: ORG } });
      expect(cfg.createCustomerEmailDomain).toHaveBeenCalledWith(PARTNER, { domain: 'acme.com', orgId: ORG, autoCreateContact: true }, { userId: 'user-1' });
    });

    it('delete_domain deletes by id within the partner', async () => {
      cfg.deleteCustomerEmailDomain.mockResolvedValue(undefined);
      expect(await run({ action: 'delete_domain', id: ID })).toEqual({ deleted: true, id: ID });
      expect(cfg.deleteCustomerEmailDomain).toHaveBeenCalledWith(PARTNER, ID);
    });

    it('maps a service refusal (status name taken) to a coded tool error', async () => {
      const err = Object.assign(new Error('A status with that name already exists'), { name: 'TicketConfigServiceError', status: 409, code: 'STATUS_NAME_TAKEN' });
      cfg.createTicketStatus.mockRejectedValue(err);
      expect(await run({ action: 'create_status', data: { name: 'Open', coreStatus: 'open' } })).toEqual({
        error: 'A status with that name already exists', code: 'STATUS_NAME_TAKEN',
      });
    });

    it('rethrows an unexpected error', async () => {
      cfg.createTicketStatus.mockRejectedValue(new Error('boom'));
      await expect(run({ action: 'create_status', data: { name: 'x', coreStatus: 'open' } })).rejects.toThrow('boom');
    });
  });

  describe('org ticket settings', () => {
    it('reads for an accessible org and refuses an inaccessible or missing one', async () => {
      cfg.getOrgTicketSettings.mockResolvedValue({ slaOverrides: {} });
      expect(await run({ action: 'get_org_settings', orgId: ORG })).toEqual({ settings: { slaOverrides: {} } });
      expect(await run({ action: 'get_org_settings', orgId: ORG }, makeAuth({ canAccessOrg: vi.fn(() => false) }))).toMatchObject({ code: 'NOT_FOUND' });
      mockLimit.mockResolvedValueOnce([]);
      expect(await run({ action: 'get_org_settings', orgId: ORG })).toMatchObject({ code: 'NOT_FOUND' });
      expect(await run({ action: 'get_org_settings' })).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('update_org_settings replaces the SLA override map via the route schema', async () => {
      cfg.upsertOrgTicketSettings.mockResolvedValue({ slaOverrides: { urgent: { responseMinutes: 15 } } });
      await run({ action: 'update_org_settings', orgId: ORG, data: { slaOverrides: { urgent: { responseMinutes: 15 } } } });
      expect(cfg.upsertOrgTicketSettings).toHaveBeenCalledWith(ORG, { slaOverrides: { urgent: { responseMinutes: 15 } } });
      expect(await run({ action: 'update_org_settings', orgId: ORG, data: {} })).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('update_org_settings never reaches the service for an org the caller cannot access', async () => {
      const auth = makeAuth({ canAccessOrg: vi.fn(() => false) });
      expect(await run({ action: 'update_org_settings', orgId: ORG, data: { slaOverrides: {} } }, auth)).toMatchObject({ code: 'NOT_FOUND' });
      expect(cfg.upsertOrgTicketSettings).not.toHaveBeenCalled();
    });
  });

  describe('categories and paging', () => {
    it('list_categories pages the rows the helper returns', async () => {
      cats.listCategoryRows.mockResolvedValue({ rows: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}` })) });
      const res = await run({ action: 'list_categories', limit: 2 });
      expect(res).toMatchObject({ showing: 2, total: 5, hasMore: true });
      expect((res.categories as unknown[]).length).toBe(2);
      expect(typeof res.nextCursor).toBe('string');
    });

    it('list_categories passes a helper refusal straight through', async () => {
      cats.listCategoryRows.mockResolvedValue({ error: JSON.stringify({ error: 'denied', code: 'ACCESS_DENIED' }) });
      expect(await run({ action: 'list_categories' })).toEqual({ error: 'denied', code: 'ACCESS_DENIED' });
    });

    it('category writes delegate to the helper with the caller auth and raw payload', async () => {
      cats.createCategory.mockResolvedValue(JSON.stringify({ category: { id: ID } }));
      cats.updateCategory.mockResolvedValue(JSON.stringify({ category: { id: ID } }));
      cats.deleteCategory.mockResolvedValue(JSON.stringify({ deactivated: true }));
      cats.reorderCategories.mockResolvedValue(JSON.stringify({ reordered: 1 }));
      const auth = makeAuth();
      await run({ action: 'create_category', data: { name: 'x' } }, auth);
      await run({ action: 'update_category', id: ID, data: { name: 'y' } }, auth);
      await run({ action: 'delete_category', id: ID }, auth);
      await run({ action: 'reorder_categories', ids: [ID] }, auth);
      expect(cats.createCategory).toHaveBeenCalledWith(auth, { name: 'x' });
      expect(cats.updateCategory).toHaveBeenCalledWith(auth, ID, { name: 'y' });
      expect(cats.deleteCategory).toHaveBeenCalledWith(auth, ID);
      expect(cats.reorderCategories).toHaveBeenCalledWith(auth, [ID]);
    });
  });
});
