import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { m365Connections } from './m365';

describe('m365Connections schema', () => {
  it('has the expected columns', () => {
    const cfg = getTableConfig(m365Connections);
    const cols = cfg.columns.map((c) => c.name).sort();
    expect(cols).toEqual(
      [
        'id', 'org_id', 'tenant_id', 'client_id', 'client_secret', 'display_name',
        'status', 'created_by', 'last_verified_at', 'created_at', 'updated_at',
      ].sort()
    );
  });

  it('is named m365_connections', () => {
    expect(getTableConfig(m365Connections).name).toBe('m365_connections');
  });

  it('stores the client secret as the encrypted-at-rest column', () => {
    const cfg = getTableConfig(m365Connections);
    const secret = cfg.columns.find((c) => c.name === 'client_secret');
    expect(secret?.notNull).toBe(true);
  });
});
