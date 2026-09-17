import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { AiAgentTriggers } from '@breeze/shared';

const state = vi.hoisted(() => ({ rows: [] as unknown[][], conditions: [] as SQL[] }));
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: { select: () => ({ from: () => ({ where: (condition: SQL) => {
    state.conditions.push(condition);
    const rows = state.rows.shift() ?? [];
    return { limit: async () => rows, then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
  } }) }) },
}));
import { agentRunMatchesResourceScope } from './runResourceScope';
const triggers = (over: Partial<AiAgentTriggers> = {}): AiAgentTriggers => ({
  alertSeverities: ['critical'], respectMaintenanceWindows: true, ...over,
});
beforeEach(() => { state.rows = []; state.conditions = []; });

describe('agent run resource scope', () => {
  it('preserves explicitly unrestricted org runs', async () => {
    expect(await agentRunMatchesResourceScope(triggers(), 'org-a', null)).toBe(true);
    expect(state.conditions).toEqual([]);
  });
  it.each(['siteIds', 'deviceTags', 'deviceGroupIds'] as const)('refuses device-less %s scope', async (key) => {
    expect(await agentRunMatchesResourceScope(triggers({ [key]: ['a'] }), 'org-a', null)).toBe(false);
    expect(state.conditions).toEqual([]);
  });
  it.each(['siteIds', 'deviceTags', 'deviceGroupIds'] as const)('empty merged %s scope denies without reads', async (key) => {
    expect(await agentRunMatchesResourceScope(triggers({ [key]: [] }), 'org-a', 'device-a')).toBe(false);
    expect(state.conditions).toEqual([]);
  });
  it('requires all configured restrictions and pins both reads to the org/device', async () => {
    state.rows = [[{ siteId: 'site-a', tags: ['prod'] }], [{ groupId: 'group-a' }]];
    expect(await agentRunMatchesResourceScope(triggers({ siteIds: ['site-a'], deviceTags: ['prod'], deviceGroupIds: ['group-a'] }), 'org-a', 'device-a')).toBe(true);
    for (const condition of state.conditions) {
      const sql = new PgDialect().sqlToQuery(condition);
      expect(sql.params).toEqual(['device-a', 'org-a']);
    }
    expect(state.conditions).toHaveLength(2);
  });
  it('refuses a moved device even when both sites are in policy, because auth is pinned to the old site', async () => {
    state.rows = [[{ siteId: 'site-b', tags: [] }]];
    expect(await agentRunMatchesResourceScope(triggers({ siteIds: ['site-a', 'site-b'] }), 'org-a', 'device-a', 'site-a')).toBe(false);
  });
  it.each<[string, Array<{ siteId: string; tags: string[] }>, Partial<AiAgentTriggers>]>([
    ['missing or cross-org device', [], { siteIds: ['site-a'] }],
    ['moved site', [{ siteId: 'site-b', tags: ['prod'] }], { siteIds: ['site-a'] }],
    ['removed tag', [{ siteId: 'site-a', tags: [] }], { deviceTags: ['prod'] }],
    ['removed group', [{ siteId: 'site-a', tags: ['prod'] }], { deviceGroupIds: ['group-a'] }],
  ])('denies %s', async (_name, rows, filter) => {
    state.rows = [[...rows], []];
    expect(await agentRunMatchesResourceScope(triggers(filter), 'org-a', 'device-a')).toBe(false);
  });
});
