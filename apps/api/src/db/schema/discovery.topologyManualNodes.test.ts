import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { topologyManualNodes } from './discovery';

describe('topology_manual_nodes schema (#1728 phase 4)', () => {
  it('exposes the locked columns', () => {
    const cols = Object.keys(getTableColumns(topologyManualNodes)).sort();
    expect(cols).toEqual(
      ['createdAt', 'createdBy', 'id', 'label', 'notes', 'orgId', 'role', 'siteId', 'updatedAt'].sort(),
    );
  });
});
