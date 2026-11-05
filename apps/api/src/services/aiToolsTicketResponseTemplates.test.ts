import { beforeEach, describe, expect, it, vi } from 'vitest';

const TPL = '00000000-0000-4000-8000-0000000000d1';
const PARTNER = '00000000-0000-4000-8000-0000000000a1';

const { m } = vi.hoisted(() => {
  const queue: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  for (const k of ['from', 'where', 'orderBy', 'values', 'set']) chain[k] = vi.fn(() => chain);
  chain.returning = vi.fn(async () => queue.shift() ?? []);
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(queue.shift() ?? []).then(res, rej);
  return { m: { queue, chain } };
});

vi.mock('../db', () => ({
  db: { select: vi.fn(() => m.chain), insert: vi.fn(() => m.chain), update: vi.fn(() => m.chain), delete: vi.fn(() => m.chain) },
}));
vi.mock('../db/schema', () => ({ ticketResponseTemplates: new Proxy({}, { get: (_t, p) => `t.${String(p)}` }) }));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerTicketResponseTemplateTools } from './aiToolsTicketResponseTemplates';

const tool = (() => {
  const tools = new Map<string, AiTool>();
  registerTicketResponseTemplateTools(tools);
  return tools.get('manage_ticket_response_templates')!;
})();

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' }, user: { id: 'user-1', name: 'Tech', isPlatformAdmin: false }, token: {},
  partnerId: PARTNER, orgId: null, scope: 'partner', partnerOrgAccess: 'all', accessibleOrgIds: [], ...over,
}) as unknown as AuthContext;
const run = async (input: Record<string, unknown>, auth = makeAuth()) =>
  JSON.parse(await tool.handler(input, auth)) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  m.queue.length = 0;
});

describe('manage_ticket_response_templates (W06)', () => {
  it('names every action in a description inside the budget', () => {
    const d = tool.definition.description ?? '';
    expect(d.length).toBeLessThanOrEqual(300);
    for (const a of ['list', 'create', 'update', 'delete']) expect(d).toContain(a);
  });

  it('every action (reads too) needs partner/system scope AND full partner access, like the route', async () => {
    for (const action of ['list', 'create', 'update', 'delete']) {
      const input = { action, id: TPL, data: { name: 'x', body: 'y' } };
      expect(await run(input, makeAuth({ scope: 'organization', orgId: 'o', partnerOrgAccess: undefined }))).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
      expect(await run(input, makeAuth({ partnerOrgAccess: 'selected' }))).toMatchObject({ code: 'ACCESS_DENIED' });
    }
    expect(m.chain.values).not.toHaveBeenCalled();
    expect(m.chain.set).not.toHaveBeenCalled();
  });

  it('a partner token without a partner id is refused', async () => {
    expect(await run({ action: 'list' }, makeAuth({ partnerId: null }))).toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it.each(['create', 'update', 'delete'])('%s refuses an ai_agent principal', async (action) => {
    const agent = makeAuth({ principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' } });
    expect(await run({ action, id: TPL, data: { name: 'x', body: 'y' } }, agent)).toEqual({ error: 'agent_principal_unsupported_action', action });
    expect(m.chain.values).not.toHaveBeenCalled();
  });

  it('list pages the active templates', async () => {
    m.queue.push(Array.from({ length: 3 }, (_, i) => ({ id: `t${i}` })));
    expect(await run({ action: 'list', limit: 2 })).toMatchObject({ showing: 2, total: 3, hasMore: true });
  });

  describe('create', () => {
    it('trims the name, defaults, and stamps the partner from the token and the caller as creator', async () => {
      m.queue.push([{ id: TPL, name: 'Welcome' }]);
      const res = await run({ action: 'create', data: { name: '  Welcome  ', body: 'Hi there', partnerId: 'evil' } });
      expect(res).toEqual({ template: { id: TPL, name: 'Welcome' } });
      expect(m.chain.values).toHaveBeenCalledWith({
        partnerId: PARTNER, name: 'Welcome', body: 'Hi there', category: null, sortOrder: 0, isActive: true, createdBy: 'user-1',
      });
    });

    it('applies the route bounds', async () => {
      expect(await run({ action: 'create', data: { name: '', body: 'x' } })).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await run({ action: 'create', data: { name: 'x', body: 'y'.repeat(5001) } })).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await run({ action: 'create', data: { name: 'x' } })).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(m.chain.values).not.toHaveBeenCalled();
    });
  });

  describe('update / delete', () => {
    it('update sends only the changed fields (plus updatedAt), scoped to the caller partner', async () => {
      m.queue.push([{ id: TPL }]);
      await run({ action: 'update', id: TPL, data: { isActive: false, name: ' New ' } });
      const patch = (m.chain.set as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as Record<string, unknown>;
      expect(Object.keys(patch).sort()).toEqual(['isActive', 'name', 'updatedAt']);
      expect(patch.name).toBe('New');
    });

    it('update needs at least one field; a template of another partner is not found', async () => {
      expect(await run({ action: 'update', id: TPL, data: {} })).toMatchObject({ code: 'VALIDATION_ERROR' });
      m.queue.push([]);
      expect(await run({ action: 'update', id: TPL, data: { name: 'x' } })).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('delete removes the caller-partner template, and reports not found otherwise', async () => {
      m.queue.push([{ id: TPL }]);
      expect(await run({ action: 'delete', id: TPL })).toEqual({ deleted: true, id: TPL });
      m.queue.push([]);
      expect(await run({ action: 'delete', id: TPL })).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('id must be a UUID', async () => {
      expect(await run({ action: 'delete', id: 'nope' })).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await run({ action: 'update', data: { name: 'x' } })).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });
});
