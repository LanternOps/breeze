import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { topologyRelationships } from './topology';

// Endpoint lookups (physical view counts, neighbourhoods, node-delete cascades)
// otherwise seq-scan the table until the planner has statistics.
describe('topology_relationships endpoint indexes', () => {
  const indexes = getTableConfig(topologyRelationships).indexes.map(index => ({
    name: index.config.name,
    columns: index.config.columns.map(column => ('name' in column ? column.name : '')),
  }));

  it.each([
    ['topology_relationships_source_node_idx', ['org_id', 'site_id', 'source_node_id']],
    ['topology_relationships_target_node_idx', ['org_id', 'site_id', 'target_node_id']],
  ])('%s covers %j', (name, columns) => {
    expect(indexes).toContainEqual({ name, columns });
  });
});
