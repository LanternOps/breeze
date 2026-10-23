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
  state.executeRows = [{ c0: 1, c1: 0, c2: 1 }];
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

  it('maps positional counts back to fields, null overrides for secret fields', async () => {
    state.partnerRows = [{ settings: {}, orgCount: 4 }];
    state.executeRows = [Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, 2]))];
    const dto = await aggregateTab('notifications', { partnerId: 'p1', accessibleOrgIds: orgIds(4) });
    expect(dto.orgCount).toBe(4);
    const token = dto.fields.find((f) => f.id === 'notifications.pushoverAppToken')!;
    expect(token.counts).toEqual({ ownValue: 2, overrides: null, shadowed: 2 });
    const unclassified = dto.fields.find((f) => f.id === 'notifications.fromAddress')!;
    expect(unclassified.counts).toEqual({ ownValue: 0, overrides: 0, shadowed: 0 });
  });

  it('reports clamped only for cap fields', async () => {
    state.executeRows = [Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, 1]))];
    const dto = await aggregateTab('defaults', { partnerId: 'p1', accessibleOrgIds: orgIds(2) });
    for (const field of dto.fields) {
      expect('clamped' in field.counts, field.id).toBe(field.qualifier === 'cap');
    }
  });

  it('empty accessible ids still answer, with a predicate that matches nothing', async () => {
    await aggregateTab('security', { partnerId: 'p1', accessibleOrgIds: [] });
    for (const query of state.executeCalls) expect(compile(query).sql).toContain('false');
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
