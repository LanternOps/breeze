import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { selectDistinct, where, limit, innerJoin, orderBy } = vi.hoisted(() => ({
  selectDistinct: vi.fn(), where: vi.fn(), limit: vi.fn(), innerJoin: vi.fn(), orderBy: vi.fn(),
}));
vi.mock('../db', () => ({ db: { selectDistinct } }));
import { loadPolicyApplicationProviders } from './eventLogPolicyProviders';
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const chain = { from: vi.fn(), innerJoin, where, limit, orderBy };
  chain.from.mockReturnValue(chain);
  innerJoin.mockReturnValue(chain);
  where.mockReturnValue(chain);
  orderBy.mockReturnValue(chain);
  limit.mockResolvedValue([]);
  selectDistinct.mockReturnValue(chain);
});
afterEach(() => vi.restoreAllMocks());
const predicate = () => new PgDialect().sqlToQuery(where.mock.calls[0]![0] as SQL);

describe('loadPolicyApplicationProviders', () => {
  it('returns no providers without an owner and never queries', async () => {
    expect(await loadPolicyApplicationProviders({ orgId: null, partnerId: null })).toEqual([]);
    expect(selectDistinct).not.toHaveBeenCalled();
  });
  it('restricts org monitors to active policies of that org or its own partner', async () => {
    await loadPolicyApplicationProviders({ orgId: ORG, partnerId: null });
    const query = predicate();
    expect(query.params).toContain(ORG);
    expect(query.params).toContain('active');
    expect(query.params).toContain('event_log');
    expect(query.sql).toMatch(/"configuration_policies"\."org_id" = \$/);
    expect(query.sql).toMatch(/select "partner_id" from "organizations" where "id" = \$/);
    expect(query.sql).not.toContain('in (select "id"');
    expect(innerJoin.mock.calls[0]![0]).toBeDefined();
  });
  it('restricts partner monitors to that partner and its organizations', async () => {
    await loadPolicyApplicationProviders({ orgId: null, partnerId: PARTNER });
    const query = predicate();
    expect(query.params.filter(p => p === PARTNER)).toHaveLength(2);
    expect(query.sql).toContain('in (select "id" from "organizations" where "partner_id" =');
  });
  it('ignores a supplied partner for org monitors and derives ownership from the org', async () => {
    await loadPolicyApplicationProviders({ orgId: ORG, partnerId: PARTNER });
    expect(predicate().params).not.toContain(PARTNER);
  });
  it('only includes policies assigned somewhere', async () => {
    await loadPolicyApplicationProviders({ orgId: ORG, partnerId: null });
    expect(predicate().sql).toContain('exists (select 1 from "config_policy_assignments" where "config_policy_assignments"."config_policy_id" = "configuration_policies"."id")');
  });
  it('orders unnested names before limiting for deterministic truncation', async () => {
    await loadPolicyApplicationProviders({ orgId: ORG, partnerId: null });
    expect(orderBy).toHaveBeenCalledOnce();
    const ordering = new PgDialect().sqlToQuery(orderBy.mock.calls[0]![0] as SQL);
    expect(ordering.sql).toBe('unnest("config_policy_event_log_settings"."application_providers")');
    expect(orderBy.mock.invocationCallOrder[0]).toBeLessThan(limit.mock.invocationCallOrder[0]!);
    expect(console.warn).not.toHaveBeenCalled();
  });
  it('deduplicates names case-insensitively and caps advisory output at 200', async () => {
    limit.mockResolvedValue([{ name: 'Dell UPS' }, { name: 'dell ups' }, ...Array.from({ length: 210 }, (_, i) => ({ name: `Provider${i}` }))]);
    const names = await loadPolicyApplicationProviders({ orgId: ORG, partnerId: null });
    expect(names).toHaveLength(200);
    expect(names.slice(0, 2)).toEqual(['Dell UPS', 'Provider0']);
    expect(limit).toHaveBeenCalledWith(4000);
    expect(console.warn).toHaveBeenCalledOnce();
  });
  it.each([
    ['the 4000-row limit', Array.from({ length: 4000 }, () => ({ name: 'UPS' })), 1],
    ['the 200-name cap', Array.from({ length: 200 }, (_, i) => ({ name: `Provider${i}` })), 200],
    ['both limits', Array.from({ length: 4000 }, (_, i) => ({ name: `Provider${i}` })), 200],
  ])('warns once when hitting %s', async (_label, rows, count) => {
    limit.mockResolvedValue(rows);
    expect(await loadPolicyApplicationProviders({ orgId: ORG, partnerId: null })).toHaveLength(count);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(console.warn).mock.calls[0]![0]).toMatch(/application providers.*(?:limit|cap)/i);
  });
});
