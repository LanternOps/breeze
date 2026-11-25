import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { metricsRegistry } from './metricsRegistry';
import { affectedRowCount, noteToolCall, noteToolSearch } from './aiToolDiscoveryMetrics';

beforeEach(() => {
  metricsRegistry.resetMetrics();
});

async function series(name: string): Promise<Array<{ labels: Record<string, string | number>; value: number }>> {
  const metric = metricsRegistry.getSingleMetric(name);
  if (!metric) return [];
  return (await metric.get()).values.map((v) => ({ labels: v.labels as Record<string, string | number>, value: v.value }));
}

describe('tool-discovery counters (#12421 spec §3.5)', () => {
  it('breeze_ai_tool_search_total counts by outcome', async () => {
    noteToolSearch('hit');
    noteToolSearch('hit');
    noteToolSearch('empty');
    expect(await series('breeze_ai_tool_search_total')).toEqual(expect.arrayContaining([
      { labels: { outcome: 'hit' }, value: 2 },
      { labels: { outcome: 'empty' }, value: 1 },
    ]));
  });

  it('breeze_ai_tool_call_total counts by status', async () => {
    noteToolCall('completed');
    noteToolCall('refused');
    noteToolCall('completed');
    expect(await series('breeze_ai_tool_call_total')).toEqual(expect.arrayContaining([
      { labels: { status: 'completed' }, value: 2 },
      { labels: { status: 'refused' }, value: 1 },
    ]));
  });

  it('carries no tool label on either series (cardinality)', async () => {
    noteToolSearch('hit');
    noteToolCall('failed');
    for (const name of ['breeze_ai_tool_search_total', 'breeze_ai_tool_call_total']) {
      for (const { labels } of await series(name)) {
        expect(Object.keys(labels).every((k) => k === 'outcome' || k === 'status')).toBe(true);
      }
    }
  });

  it('is a leaf module: imports prom-client and the registry only', () => {
    const src = readFileSync(join(__dirname, 'aiToolDiscoveryMetrics.ts'), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['./metricsRegistry', 'prom-client']);
  });
});

describe('affectedRowCount', () => {
  it('reads postgres.js RowList.count and treats anything else as 0', () => {
    expect(affectedRowCount(Object.assign([], { count: 1 }))).toBe(1);
    expect(affectedRowCount({ count: 0 })).toBe(0);
    expect(affectedRowCount([{ id: 'a' }, { id: 'b' }])).toBe(2);
    expect(affectedRowCount(undefined)).toBe(0);
    expect(affectedRowCount(null)).toBe(0);
    expect(affectedRowCount({ count: '3' })).toBe(0);
  });
});
