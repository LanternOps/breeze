import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { delegantM365Connections } from './delegant';

describe('delegantM365Connections schema', () => {
  it('has the expected columns', () => {
    const cfg = getTableConfig(delegantM365Connections);
    const names = cfg.columns.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'id', 'org_id', 'customer_label', 'customer_display_name',
        'delegant_org_id', 'delegant_connection_id', 'm365_tenant_id',
        'status', 'last_verified_at', 'created_at', 'updated_at',
      ].sort(),
    );
  });

  it('is named delegant_m365_connections', () => {
    expect(getTableConfig(delegantM365Connections).name).toBe('delegant_m365_connections');
  });
});
