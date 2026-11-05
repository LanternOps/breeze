import { beforeEach, describe, expect, it, vi } from 'vitest';

const FORM = '00000000-0000-4000-8000-0000000000f1';
const ORG = '00000000-0000-4000-8000-0000000000b1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000b2';
const PARTNER = '00000000-0000-4000-8000-0000000000a1';
const CAT = '00000000-0000-4000-8000-0000000000c1';

const { m } = vi.hoisted(() => {
  const queue: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  for (const k of ['from', 'where', 'orderBy', 'limit', 'values', 'set']) chain[k] = vi.fn(() => chain);
  chain.returning = vi.fn(async () => queue.shift() ?? []);
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(queue.shift() ?? []).then(res, rej);
  return {
    m: {
      queue, chain, insert: vi.fn(), update: vi.fn(), del: vi.fn(),
      links: { getTicketFormOrgLinkMap: vi.fn(), listTicketFormsForOrg: vi.fn(), syncTicketFormOrgLinks: vi.fn() },
      assertCategoryInPartner: vi.fn(),
    },
  };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => m.chain),
    insert: vi.fn((...a: unknown[]) => { m.insert(...a); return m.chain; }),
    update: vi.fn((...a: unknown[]) => { m.update(...a); return m.chain; }),
    delete: vi.fn((...a: unknown[]) => { m.del(...a); return m.chain; }),
  },
}));
vi.mock('../db/schema', () => ({
  organizations: new Proxy({}, { get: (_t, p) => `o.${String(p)}` }),
  ticketForms: new Proxy({}, { get: (_t, p) => `f.${String(p)}` }),
}));
vi.mock('./ticketFormService', () => m.links);
vi.mock('./ticketService', () => ({ assertCategoryInPartner: m.assertCategoryInPartner }));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerTicketFormTools } from './aiToolsTicketForms';

const tool = (() => {
  const tools = new Map<string, AiTool>();
  registerTicketFormTools(tools);
  return tools.get('manage_ticket_forms')!;
})();

function makeAuth(over: Record<string, unknown> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' }, user: { id: 'user-1', name: 'Tech', isPlatformAdmin: false }, token: {},
    partnerId: PARTNER, orgId: null, scope: 'partner', partnerOrgAccess: 'all', accessibleOrgIds: [ORG],
    orgCondition: vi.fn(() => undefined), canAccessOrg: vi.fn((id: string) => id === ORG),
    ...over,
  } as unknown as AuthContext;
}
const run = async (input: Record<string, unknown>, auth = makeAuth(), context?: unknown) =>
  JSON.parse(await tool.handler(input, auth, context as never)) as Record<string, unknown>;

const formRow = (over: Record<string, unknown> = {}) => ({
  id: FORM, orgId: ORG, partnerId: null, name: 'Onboarding', version: 3, fields: [], ...over,
});
const baseCreate = { name: 'New hire', fields: [{ key: 'full_name', label: 'Full name', type: 'text', required: true }] };

beforeEach(() => {
  vi.clearAllMocks();
  m.queue.length = 0;
  m.assertCategoryInPartner.mockResolvedValue(undefined);
  m.links.syncTicketFormOrgLinks.mockResolvedValue(undefined);
  m.links.getTicketFormOrgLinkMap.mockResolvedValue(new Map());
});

describe('manage_ticket_forms (W06)', () => {
  it('names every action in a description inside the budget', () => {
    const d = tool.definition.description ?? '';
    expect(d.length).toBeLessThanOrEqual(300);
    for (const a of ['list', 'available', 'create', 'update', 'delete']) expect(d).toContain(a);
  });

  it.each(['create', 'update', 'delete'])('%s refuses an ai_agent principal; list and available do not', async (action) => {
    const agent = makeAuth({ principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' } });
    expect(await run({ action, id: FORM, data: baseCreate }, agent)).toEqual({ error: 'agent_principal_unsupported_action', action });
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.del).not.toHaveBeenCalled();
  });

  describe('reads', () => {
    it('list pages the forms and attaches each form\'s visibleOrgIds allowlist', async () => {
      m.queue.push([formRow(), formRow({ id: 'f2' })]);
      m.links.getTicketFormOrgLinkMap.mockResolvedValue(new Map([[FORM, [ORG]]]));
      const res = await run({ action: 'list' });
      expect(res).toMatchObject({ showing: 2, total: 2, hasMore: false });
      expect((res.forms as Array<Record<string, unknown>>).map((f) => f.visibleOrgIds)).toEqual([[ORG], null]);
    });

    it('available checks access BEFORE any fetch, and reports an unknown org', async () => {
      expect(await run({ action: 'available', orgId: OTHER_ORG })).toMatchObject({ code: 'ACCESS_DENIED' });
      expect(m.links.listTicketFormsForOrg).not.toHaveBeenCalled();
      m.queue.push([]);
      expect(await run({ action: 'available', orgId: ORG })).toMatchObject({ code: 'NOT_FOUND' });
      m.queue.push([{ id: ORG, partnerId: PARTNER }]);
      m.links.listTicketFormsForOrg.mockResolvedValue([{ id: FORM }]);
      expect(await run({ action: 'available', orgId: ORG })).toEqual({ forms: [{ id: FORM }] });
      expect(m.links.listTicketFormsForOrg).toHaveBeenCalledWith({ id: ORG, partnerId: PARTNER });
    });
  });

  describe('create', () => {
    it('validates with the route schema (a select field needs options)', async () => {
      const bad = { ...baseCreate, fields: [{ key: 'pick', label: 'Pick', type: 'select', required: false }] };
      expect(await run({ action: 'create', data: bad, orgId: ORG })).toMatchObject({ code: 'VALIDATION_ERROR', error: expect.stringContaining('options') });
      expect(m.insert).not.toHaveBeenCalled();
    });

    it('creates an org-owned form owned by the caller org, stamped with the caller and version 1', async () => {
      m.queue.push([formRow({ name: 'New hire' })]);
      const res = await run({ action: 'create', orgId: ORG, data: baseCreate });
      expect(res).toMatchObject({ form: { id: FORM, visibleOrgIds: null } });
      expect(m.chain.values).toHaveBeenCalledWith(expect.objectContaining({
        orgId: ORG, partnerId: null, createdBy: 'user-1', version: 1, showInPortal: true, isActive: true, name: 'New hire',
      }));
      expect(m.links.syncTicketFormOrgLinks).not.toHaveBeenCalled();
    });

    it('an org the caller cannot reach, or no org at all, is refused', async () => {
      expect(await run({ action: 'create', orgId: OTHER_ORG, data: baseCreate })).toMatchObject({ error: expect.stringContaining('orgId is required and must be accessible') });
      expect(await run({ action: 'create', data: baseCreate })).toMatchObject({ error: expect.stringContaining('orgId is required') });
      expect(m.insert).not.toHaveBeenCalled();
    });

    it('an organization token can only create in its own org', async () => {
      const orgTok = makeAuth({ scope: 'organization', orgId: ORG, partnerId: PARTNER, partnerOrgAccess: undefined });
      expect(await run({ action: 'create', orgId: OTHER_ORG, data: baseCreate }, orgTok)).toMatchObject({ code: 'ACCESS_DENIED' });
      m.queue.push([formRow()]);
      expect(await run({ action: 'create', data: baseCreate }, orgTok)).toMatchObject({ form: { id: FORM } });
      expect(m.chain.values).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: ORG, partnerId: null }));
    });

    it('a partner-wide form needs full partner access and takes the partner from the token, not input', async () => {
      const limited = makeAuth({ partnerOrgAccess: 'selected' });
      expect(await run({ action: 'create', data: { ...baseCreate, ownerScope: 'partner' } }, limited)).toMatchObject({ code: 'ACCESS_DENIED' });
      m.queue.push([formRow({ orgId: null, partnerId: PARTNER })]);
      const res = await run({ action: 'create', data: { ...baseCreate, ownerScope: 'partner', orgId: OTHER_ORG, visibleOrgIds: [ORG] } });
      expect(res).toMatchObject({ form: { visibleOrgIds: [ORG] } });
      expect(m.chain.values).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, partnerId: PARTNER }));
      expect(m.links.syncTicketFormOrgLinks).toHaveBeenCalledWith(FORM, [ORG], PARTNER);
    });

    it('visibleOrgIds on an org-owned form is refused before any write', async () => {
      expect(await run({ action: 'create', orgId: ORG, data: { ...baseCreate, visibleOrgIds: [ORG] } })).toMatchObject({ error: 'visibleOrgIds is only valid on partner-wide forms' });
      expect(m.insert).not.toHaveBeenCalled();
    });

    it('an empty allowlist normalises to "visible to all" (null)', async () => {
      m.queue.push([formRow({ orgId: null, partnerId: PARTNER })]);
      await run({ action: 'create', data: { ...baseCreate, ownerScope: 'partner', visibleOrgIds: [] } });
      expect(m.links.syncTicketFormOrgLinks).toHaveBeenCalledWith(FORM, null, PARTNER);
    });

    it('rolls the half-created partner-wide form back when the allowlist sync is rejected, and surfaces the original error', async () => {
      m.queue.push([formRow({ orgId: null, partnerId: PARTNER })]);
      const err = Object.assign(new Error('Organization not in your partner'), { name: 'TicketFormError', status: 400 });
      m.links.syncTicketFormOrgLinks.mockRejectedValue(err);
      expect(await run({ action: 'create', data: { ...baseCreate, ownerScope: 'partner', visibleOrgIds: [OTHER_ORG] } })).toEqual({ error: 'Organization not in your partner' });
      expect(m.del).toHaveBeenCalledTimes(1);
    });

    it('guards the category against the effective partner', async () => {
      m.queue.push([{ partnerId: PARTNER }]); // org → partner lookup
      m.queue.push([formRow()]);
      await run({ action: 'create', orgId: ORG, data: { ...baseCreate, categoryId: CAT } });
      expect(m.assertCategoryInPartner).toHaveBeenCalledWith(CAT, PARTNER);
      const notFound = Object.assign(new Error('Category not found'), { name: 'TicketServiceError', status: 400, code: 'CATEGORY_NOT_FOUND' });
      m.assertCategoryInPartner.mockRejectedValue(notFound);
      m.queue.push([{ partnerId: PARTNER }]);
      expect(await run({ action: 'create', orgId: ORG, data: { ...baseCreate, categoryId: CAT } })).toMatchObject({ error: 'Category not found' });
    });

    it('refuses when the released auth is not the approver (USER_OWNED release guard)', async () => {
      const res = await run({ action: 'create', orgId: ORG, data: baseCreate }, makeAuth(), { approverRelease: { approverUserId: 'someone-else' } });
      expect(res).toMatchObject({ code: 'APPROVER_RELEASE_MISMATCH' });
      expect(m.insert).not.toHaveBeenCalled();
    });
  });

  describe('update / delete', () => {
    it('a form outside the caller\'s tenancy is not found (never reaches the write)', async () => {
      m.queue.push([]);
      expect(await run({ action: 'update', id: FORM, data: { name: 'x' } })).toMatchObject({ code: 'NOT_FOUND' });
      m.queue.push([]);
      expect(await run({ action: 'delete', id: FORM })).toMatchObject({ code: 'NOT_FOUND' });
      expect(m.update).not.toHaveBeenCalled();
      expect(m.del).not.toHaveBeenCalled();
    });

    it('a partner-wide row is read-only without full partner access, for update and delete', async () => {
      const limited = makeAuth({ partnerOrgAccess: 'selected' });
      m.queue.push([formRow({ orgId: null, partnerId: PARTNER })]);
      expect(await run({ action: 'update', id: FORM, data: { name: 'x' } }, limited)).toMatchObject({ code: 'ACCESS_DENIED' });
      m.queue.push([formRow({ orgId: null, partnerId: PARTNER })]);
      expect(await run({ action: 'delete', id: FORM }, limited)).toMatchObject({ code: 'ACCESS_DENIED' });
      expect(m.update).not.toHaveBeenCalled();
      expect(m.del).not.toHaveBeenCalled();
    });

    it('update bumps the version only when fields or titleTemplate change', async () => {
      m.queue.push([formRow()], [formRow({ name: 'Renamed' })]);
      await run({ action: 'update', id: FORM, data: { name: 'Renamed' } });
      expect((m.chain.set as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).not.toHaveProperty('version');
      m.queue.push([formRow()], [formRow({ version: 4 })]);
      await run({ action: 'update', id: FORM, data: { titleTemplate: 'Hello {{full_name}}' } });
      expect((m.chain.set as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatchObject({ version: 4 });
    });

    it('update strips visibleOrgIds from the columns, refuses it on an org-owned form, syncs it on a partner-wide one', async () => {
      m.queue.push([formRow()]);
      expect(await run({ action: 'update', id: FORM, data: { visibleOrgIds: [ORG] } })).toMatchObject({ error: 'visibleOrgIds is only valid on partner-wide forms' });
      m.queue.push([formRow({ orgId: null, partnerId: PARTNER })], [formRow({ orgId: null, partnerId: PARTNER })]);
      await run({ action: 'update', id: FORM, data: { visibleOrgIds: [ORG] } });
      expect(m.links.syncTicketFormOrgLinks).toHaveBeenCalledWith(FORM, [ORG], PARTNER);
      expect((m.chain.set as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).not.toHaveProperty('visibleOrgIds');
    });

    it('delete is a hard delete of the accessible form', async () => {
      m.queue.push([formRow()]);
      expect(await run({ action: 'delete', id: FORM })).toEqual({ deleted: true, id: FORM });
      expect(m.del).toHaveBeenCalledTimes(1);
    });

    it('id must be a UUID', async () => {
      expect(await run({ action: 'delete', id: 'nope' })).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });
});
