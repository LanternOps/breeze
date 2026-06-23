import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { topologyLayout } from './discovery';

describe('topology_layout schema', () => {
  it('has the locked columns and unique index', () => {
    const cfg = getTableConfig(topologyLayout);
    const cols = cfg.columns.map((c) => c.name).sort();
    expect(cols).toEqual(
      ['id', 'node_id', 'node_type', 'org_id', 'pinned', 'site_id', 'updated_at', 'updated_by', 'x', 'y'].sort(),
    );
    const uniq = cfg.indexes.find((i) => i.config.name === 'topology_layout_site_node_unique');
    expect(uniq?.config.columns.map((c: any) => (c as any).name)).toEqual(['site_id', 'node_type', 'node_id']);
  });
});
