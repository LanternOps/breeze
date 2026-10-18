import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Model-visible device listings never include a device parked in a holding
 * org, even for a system-scope session (whose org condition is empty).
 */

const recorded = vi.hoisted(() => ({ where: [] as unknown[] }));

vi.mock('../db', () => {
  // Chainable query stub: records every where() argument, resolves to [].
  const chain = (): unknown => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve([]);
      if (prop === 'where') return (cond: unknown) => { recorded.where.push(cond); return chain(); };
      return () => chain();
    },
    apply() { return chain(); },
  });
  return {
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    hasDbAccessContext: vi.fn(() => true),
    db: { select: vi.fn(() => chain()), selectDistinct: vi.fn(() => chain()), execute: vi.fn(async (q: unknown) => { recorded.where.push(q); return []; }) },
  };
});

import { aiTools } from './aiToolNames';
import './aiTools';

const dialect = new PgDialect();
const systemAuth = () => ({
  scope: 'system', partnerId: null, orgId: null, accessibleOrgIds: null,
  orgCondition: () => undefined, canAccessOrg: () => true, allowedSiteIds: null,
  user: { id: 'u1', email: 'u@example.com', name: 'U' },
}) as never;

function renderedWheres(): string[] {
  return recorded.where.filter(Boolean).map((c) => dialect.sqlToQuery(c as SQL).sql);
}

beforeEach(() => { recorded.where.length = 0; });

describe('AI device listings exclude parked devices', () => {
  it('query_devices', async () => {
    await aiTools.get('query_devices')!.handler({}, systemAuth());
    const wheres = renderedWheres();
    expect(wheres.length).toBeGreaterThan(0);
    for (const w of wheres) expect(w).toContain("parked_org.type = 'unassigned_pool'");
  });

  it('manage_tags list', async () => {
    await aiTools.get('manage_tags')!.handler({ action: 'list' }, systemAuth());
    expect(renderedWheres().some((w) => w.includes("parked_org.type = 'unassigned_pool'"))).toBe(true);
  });
});

describe('query_devices tags filter (#9122)', () => {
  it('requires ALL tags via containment, for both the page and count queries', async () => {
    await aiTools.get('query_devices')!.handler({ tags: ['prod', 'db'] }, systemAuth());
    const queries = recorded.where.filter(Boolean).map((c) => dialect.sqlToQuery(c as SQL));
    expect(queries.length).toBe(2);
    for (const q of queries) {
      expect(q.sql).toContain('"devices"."tags" @> ARRAY[');
      expect(q.params).toEqual(expect.arrayContaining(['prod', 'db']));
    }
  });

  it('adds no tag predicate when tags is omitted, empty, or non-string', async () => {
    for (const tags of [undefined, [], [1, null]]) {
      recorded.where.length = 0;
      await aiTools.get('query_devices')!.handler({ tags }, systemAuth());
      for (const w of renderedWheres()) expect(w).not.toContain('@>');
    }
  });
});
