import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => {
  const calls: { limit?: number; offset?: number; projection?: Record<string, unknown> }[] = [];
  const chain = (result: unknown, rec: { limit?: number; offset?: number; projection?: Record<string, unknown> }) => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = () => c;
    c.orderBy = () => c;
    c.limit = (n: number) => { rec.limit = n; return c; };
    c.offset = (n: number) => { rec.offset = n; return c; };
    (c as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
    return c;
  };
  return {
    calls,
    rows: [] as unknown[],
    total: 0,
    db: {
      select: (projection?: Record<string, unknown>) => {
        const rec = { projection };
        calls.push(rec);
        return chain(projection && 'n' in projection ? [{ n: h.total }] : h.rows, rec);
      },
    },
  };
});
vi.mock('../../db', () => ({ db: h.db }));

import type { AuthContext } from '../../middleware/auth';
import { EdrReadError, type EdrReadScope } from './read';
import { buildEdrActionConditions, EDR_ACTIONS_MAX_LIMIT, listEdrActions, toEdrActionDto } from './actionsRead';

const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER = '99999999-9999-4999-8999-999999999999';
const orgAuth = { scope: 'organization', orgId: ORG, canAccessOrg: (id: string) => id === ORG } as unknown as AuthContext;
const scope = (over: Partial<EdrReadScope> = {}): EdrReadScope => ({ auth: orgAuth, allowedDeviceIds: null, allowedSiteIds: null, ...over });
const render = (s: EdrReadScope, q: Parameters<typeof buildEdrActionConditions>[1]) =>
  new PgDialect().sqlToQuery(and(...buildEdrActionConditions(s, q))!);

beforeEach(() => {
  h.calls.length = 0;
  h.rows = [];
  h.total = 0;
});

describe('edr action ledger read model', () => {
  it('an org token is pinned to its own org; another orgId is a 403', () => {
    expect(render(scope(), { limit: 10, offset: 0 }).params).toContain(ORG);
    expect(() => buildEdrActionConditions(scope(), { orgId: OTHER, limit: 10, offset: 0 })).toThrow(EdrReadError);
  });

  it('site-restricted callers see only rows linked to an allowed device; unlinked rows are hidden', () => {
    const q = render(scope({ allowedDeviceIds: ['d1', 'd2'], allowedSiteIds: ['s1'] }), { limit: 10, offset: 0 });
    expect(q.sql).toMatch(/"breeze_device_id" in \(\$\d+, \$\d+\)/);
    expect(q.sql).not.toMatch(/is null/i);
    expect(q.params).toEqual(expect.arrayContaining(['d1', 'd2']));
    const empty = render(scope({ allowedDeviceIds: [], allowedSiteIds: ['s1'] }), { limit: 10, offset: 0 });
    expect(empty.sql).toContain('false');
  });

  it("status 'open' is queued + submitted; a concrete status is exact", () => {
    expect(render(scope(), { status: 'open', limit: 10, offset: 0 }).params).toEqual(expect.arrayContaining(['queued', 'submitted']));
    const failed = render(scope(), { status: 'failed', limit: 10, offset: 0 });
    expect(failed.params).toContain('failed');
    expect(failed.params).not.toContain('queued');
  });

  it('device and endpoint filters', () => {
    const q = render(scope(), { deviceId: 'dev-x', endpointId: 'ep-x', limit: 10, offset: 0 });
    expect(q.params).toEqual(expect.arrayContaining(['dev-x', 'ep-x']));
  });

  it('never projects payload; limit is clamped to 200', async () => {
    h.total = 3;
    await listEdrActions(scope(), { limit: 10_000, offset: 5 });
    const rowsCall = h.calls[0]!;
    expect(Object.keys(rowsCall.projection!)).not.toContain('payload');
    expect(rowsCall.limit).toBe(EDR_ACTIONS_MAX_LIMIT);
    expect(rowsCall.offset).toBe(5);
  });

  it('DTO: outcomeUnknown only for queued + dispatch_outcome_unknown; dates are ISO', async () => {
    const base = {
      id: 'a', orgId: ORG, provider: 'bitdefender', action: 'isolate', requestedVia: 'ui', requestedBy: 'u',
      aiSessionId: null, approvalId: null, endpointId: 'e', detectionId: null, breezeDeviceId: 'd',
      requestedAt: new Date('2026-10-13T00:00:00Z'), submittedAt: null, completedAt: null,
    };
    expect(toEdrActionDto({ ...base, status: 'queued', error: 'dispatch_outcome_unknown' })).toMatchObject({
      outcomeUnknown: true, requestedAt: '2026-10-13T00:00:00.000Z',
    });
    expect(toEdrActionDto({ ...base, status: 'failed', error: 'dispatch_outcome_unknown' }).outcomeUnknown).toBe(false);
    expect(toEdrActionDto({ ...base, status: 'queued', error: null }).outcomeUnknown).toBe(false);
    expect(toEdrActionDto({ ...base, status: 'queued', error: null })).not.toHaveProperty('payload');
  });
});
