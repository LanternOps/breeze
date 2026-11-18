import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { CATALOG_TAB_KEYS, catalogForTab } from '@breeze/shared';

const { dbMock, state } = vi.hoisted(() => {
  const state = {
    executeCalls: [] as unknown[],
    selectCalls: [] as unknown[],
    partnerRows: [{ settings: {}, orgCount: 0 }] as unknown[],
    executeRows: [] as unknown[],
  };
  const dbMock = {
    select: vi.fn((fields: unknown) => {
      state.selectCalls.push(fields);
      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve(state.partnerRows)),
      };
      return chain;
    }),
    execute: vi.fn((query: unknown) => {
      state.executeCalls.push(query);
      return Promise.resolve(state.executeRows);
    }),
  };
  return { dbMock, state };
});

vi.mock('../../db', () => ({ db: dbMock }));

import { aggregateTab, InheritanceNotFound } from './aggregate';
import { BINDINGS } from './bindings';

const dialect = new PgDialect();
const compile = (query: unknown) => dialect.sqlToQuery(query as SQL);

function orgIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
}

function kindsFor(tab: (typeof CATALOG_TAB_KEYS)[number]): number {
  return new Set(catalogForTab(tab).map((e) => BINDINGS[e.id]!.orgSource?.kind).filter(Boolean)).size;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.executeCalls = [];
  state.selectCalls = [];
  state.partnerRows = [{ settings: { security: { requireMfa: true } }, orgCount: 3 }];
  state.executeRows = [Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`c${i}`, 1]))];
});

describe('aggregateTab', () => {
  for (const tab of CATALOG_TAB_KEYS) {
    it(`issues ≤ 1 + distinct orgSource kinds queries for ${tab}, independent of org count`, async () => {
      for (const n of [1, 500]) {
        state.executeCalls = [];
        state.selectCalls = [];
        await aggregateTab(tab, { partnerId: 'p1', accessibleOrgIds: orgIds(n) });
        const queries = state.executeCalls.length + state.selectCalls.length;
        expect(queries, `${tab} with ${n} orgs`).toBe(1 + kindsFor(tab));
      }
    });
  }

  it('never selects organizations.settings whole', async () => {
    for (const tab of CATALOG_TAB_KEYS) await aggregateTab(tab, { partnerId: 'p1', accessibleOrgIds: orgIds(2) });
    expect(state.executeCalls.length).toBeGreaterThan(0);
    for (const query of state.executeCalls) {
      const { sql: text } = compile(query);
      expect(text).not.toMatch(/"organizations"\."settings"(?!\s*#>)/);
    }
  });

  it('aliases are positional and no catalog id reaches SQL text', async () => {
    await aggregateTab('aiBudgets', { partnerId: 'p1', accessibleOrgIds: orgIds(2) });
    const { sql: text } = compile(state.executeCalls[0]);
    expect(text).toMatch(/AS "c0"/);
    for (const entry of catalogForTab('aiBudgets')) expect(text).not.toContain(entry.id);
  });

  it('maps each positional alias back to its own (field, bucket)', async () => {
    state.partnerRows = [{ settings: {}, orgCount: 4 }];
    // Distinct value per alias: a swapped or off-by-one mapping changes the result.
    state.executeRows = [Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, 100 + i]))];
    const dto = await aggregateTab('notifications', { partnerId: 'p1', accessibleOrgIds: orgIds(4) });
    expect(dto.orgCount).toBe(4);
    // Recover the alias order from the compiled SQL: `bool_or(...) AS "cN"` in field, bucket order.
    const { sql: text } = compile(state.executeCalls[0]);
    const aliases = [...text.matchAll(/AS "(c\d+)"/g)].map((m) => m[1]!);
    const expected: Record<string, unknown> = {};
    let i = 0;
    for (const entry of catalogForTab('notifications')) {
      const binding = BINDINGS[entry.id]!;
      if (!binding.orgSource) continue;
      const counts: Record<string, number | null> = { ownValue: 0, overrides: entry.secret ? null : 0, shadowed: 0 };
      for (const bucket of ['ownValue', 'overrides', 'shadowed', 'clamped'] as const) {
        if (!binding.bucketSql(bucket, {})) continue;
        counts[bucket] = 100 + Number(aliases[i++]!.slice(1));
      }
      expected[entry.id] = counts;
    }
    for (const [id, counts] of Object.entries(expected)) {
      expect(dto.fields.find((f) => f.id === id)!.counts, id).toEqual(counts);
    }
    const token = dto.fields.find((f) => f.id === 'notifications.pushoverAppToken')!;
    expect(token.counts!.overrides).toBeNull();
    expect(token.sealed).toBe(true);
  });

  it('fields without an org source report counts: null, not zeros', async () => {
    const dto = await aggregateTab('notifications', { partnerId: 'p1', accessibleOrgIds: orgIds(4) });
    const unclassified = dto.fields.find((f) => f.id === 'notifications.fromAddress')!;
    expect(unclassified.counts).toBeNull();
    const regional = await aggregateTab('regional', { partnerId: 'p1', accessibleOrgIds: orgIds(4) });
    for (const field of regional.fields) expect(field.counts, field.id).toBeNull();
  });

  it('a missing aggregate row or alias is an error, not a zero', async () => {
    state.executeRows = [];
    await expect(aggregateTab('security', { partnerId: 'p1', accessibleOrgIds: orgIds(2) })).rejects.toThrow(/aggregate/);
    state.executeRows = [{ c0: 1 }];
    await expect(aggregateTab('security', { partnerId: 'p1', accessibleOrgIds: orgIds(2) })).rejects.toThrow(/aggregate/);
  });

  it('reports clamped only for cap fields', async () => {
    state.executeRows = [Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, 1]))];
    const dto = await aggregateTab('defaults', { partnerId: 'p1', accessibleOrgIds: orgIds(2) });
    for (const field of dto.fields) {
      if (field.counts) expect('clamped' in field.counts, field.id).toBe(field.qualifier === 'cap');
    }
  });

  it('empty accessible ids still answer, with a predicate that matches nothing', async () => {
    await aggregateTab('security', { partnerId: 'p1', accessibleOrgIds: [] });
    expect(state.executeCalls.length).toBeGreaterThan(0);
    for (const query of state.executeCalls) expect(compile(query).sql).toMatch(/WHERE\s+false\s*$/);
  });

  it('a null accessibleOrgIds throws instead of meaning "all orgs"', async () => {
    await expect(aggregateTab('security', { partnerId: 'p1', accessibleOrgIds: null })).rejects.toThrow();
    expect(state.executeCalls).toHaveLength(0);
  });

  it('an unreadable partner row is InheritanceNotFound', async () => {
    state.partnerRows = [];
    await expect(aggregateTab('security', { partnerId: 'p1', accessibleOrgIds: orgIds(1) })).rejects.toBeInstanceOf(InheritanceNotFound);
  });
});
