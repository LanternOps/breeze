import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { webhooks } from '../db/schema/integrations';
const mocks = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), enqueue: vi.fn(), values: vi.fn() }));
vi.mock('../db', () => ({ db: { select: mocks.select, insert: mocks.insert }, runAfterDbContextCommit: (_label: string, fn: () => unknown) => fn() }));
vi.mock('../jobs/webhookDeliveryQueue', () => ({ enqueueWebhookAttempt: mocks.enqueue }));
vi.mock('./secretCrypto', () => ({ decryptForColumn: (_t: string, _c: string, v: string) => v }));
import { registerIntegrationTools } from './aiToolsIntegrations';
const P = '11111111-1111-4111-8111-111111111111';
const O = '22222222-2222-4222-8222-222222222222';
const W = '33333333-3333-4333-8333-333333333333';
const hook = { id: W, orgId: null, partnerId: P, name: 'Partner', url: 'https://example.test', payloadVersion: 2, approvalGeneration: 1 };
function auth(scope: AuthContext['scope'], partnerOrgAccess: 'all' | 'selected'): AuthContext {
  return { principal: { kind: 'user_session' }, user: { id: W, email: 'admin@example.test', name: 'Admin', isPlatformAdmin: scope === 'system' }, token: null, accessibleOrgIds: [O], scope, partnerId: P, partnerOrgAccess, orgId: O, orgCondition: () => eq(webhooks.orgId, O), canAccessOrg: (id: string) => id === O };
}
function handler(name: string) { const map = new Map<string, AiTool>(); registerIntegrationTools(map); return map.get(name)!.handler; }
let conditions: SQL[];
beforeEach(() => {
  vi.clearAllMocks(); conditions = [];
  const chain = { from: () => chain, where: (sql: SQL) => { conditions.push(sql); return chain; }, orderBy: () => chain, limit: async () => [hook] };
  mocks.select.mockReturnValue(chain);
  mocks.values.mockReturnValue({ returning: async () => [{ id: 'delivery-1', createdAt: new Date() }] });
  mocks.insert.mockReturnValue({ values: mocks.values }); mocks.enqueue.mockResolvedValue(undefined);
});
describe('AI partner webhook ownership', () => {
  it.each(['query_webhooks', 'test_webhook'])('adds a partner branch only for full partner admins in %s', async tool => {
    await handler(tool)({ webhookId: W }, auth('partner', 'all'));
    const query = new PgDialect().sqlToQuery(conditions[0]!);
    expect(query.sql).toContain('"webhooks"."partner_id" =');
    expect(query.sql).toContain('"webhooks"."org_id" is null');
    expect(query.params).toContain(P);
  });
  it.each([['organization', 'all'], ['partner', 'selected']] as const)('hides partner rows from %s/%s on both surfaces', async (scope, access) => {
    const identity = auth(scope, access);
    const query = JSON.parse(await handler('query_webhooks')({}, identity));
    expect(query.webhooks).toEqual([]);
    const test = JSON.parse(await handler('test_webhook')({ webhookId: W }, identity));
    expect(test.error).toBe('Webhook not found or access denied');
    expect(mocks.insert).not.toHaveBeenCalled();
    for (const condition of conditions) expect(new PgDialect().sqlToQuery(condition).sql).not.toContain('"webhooks"."partner_id" =');
  });
  it('records a partner test with a NULL org and random UUID test marker', async () => {
    expect(JSON.parse(await handler('test_webhook')({ webhookId: W }, auth('partner', 'all'))).success).toBe(true);
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, eventId: expect.stringMatching(/^test-[0-9a-f-]{36}$/) }));
  });
  it('system scope can read partner webhooks', async () => {
    expect(JSON.parse(await handler('query_webhooks')({}, auth('system', 'selected'))).webhooks).toHaveLength(1);
  });
});
