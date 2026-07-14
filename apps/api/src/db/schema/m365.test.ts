import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { m365Connections } from './m365';

describe('m365Connections schema', () => {
  it('has canonical metadata columns and only one deprecated secret column', () => {
    const cfg = getTableConfig(m365Connections);
    expect(cfg.columns.map((c) => c.name).sort()).toEqual([
      'client_id', 'client_secret', 'consented_at', 'created_at', 'created_by',
      'credential_domain', 'credential_version', 'display_name', 'expires_at',
      'id', 'last_error_code', 'last_verified_at', 'observed_grants', 'org_id',
      'permission_manifest_version', 'profile', 'revoked_at', 'status',
      'tenant_id', 'updated_at', 'user_id', 'vault_ref', 'auth_mode',
    ].sort());
    expect(cfg.columns.find((c) => c.name === 'client_secret')?.notNull).toBe(false);
    expect(cfg.columns.find((c) => c.name === 'vault_ref')?.notNull).toBe(false);
  });

  it('declares per-owner/profile uniqueness instead of one-row-per-org', () => {
    const names = getTableConfig(m365Connections).indexes.map((i) => i.config.name).sort();
    expect(names).toEqual([
      'm365_connections_org_profile_uniq',
      'm365_connections_user_profile_uniq',
    ]);
  });
});
