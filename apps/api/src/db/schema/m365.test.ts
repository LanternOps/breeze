import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { m365Connections, m365ConsentSessions } from './m365';

describe('m365Connections schema', () => {
  it('has canonical metadata columns and only one deprecated secret column', () => {
    const cfg = getTableConfig(m365Connections);
    expect(cfg.columns.map((c) => c.name).sort()).toEqual([
      'client_id', 'client_secret', 'consented_at', 'created_at', 'created_by',
      'consent_attempt_id',
      'credential_domain', 'credential_version', 'display_name', 'expires_at',
      'grants_verified_at', 'id', 'last_error_code', 'last_verified_at', 'observed_grants', 'org_id',
      'permission_manifest_version', 'profile', 'revoked_at', 'status',
      'tenant_id', 'updated_at', 'user_id', 'vault_ref', 'auth_mode',
    ].sort());
    expect(cfg.columns.find((c) => c.name === 'client_secret')?.notNull).toBe(false);
    expect(cfg.columns.find((c) => c.name === 'vault_ref')?.notNull).toBe(false);
    expect(cfg.columns.find((c) => c.name === 'tenant_id')?.notNull).toBe(false);
  });

  it('requires callers to choose profile, auth mode, and credential domain', () => {
    const columns = getTableConfig(m365Connections).columns;
    expect(columns.find((c) => c.name === 'profile')?.default).toBeUndefined();
    expect(columns.find((c) => c.name === 'auth_mode')?.default).toBeUndefined();
    expect(columns.find((c) => c.name === 'credential_domain')?.default).toBeUndefined();
    expect(columns.find((c) => c.name === 'permission_manifest_version')?.default).toBe(0);
  });

  it('keeps owner/profile uniqueness and adds verified and attempt identity indexes', () => {
    const names = getTableConfig(m365Connections).indexes.map((i) => i.config.name).sort();
    expect(names).toEqual([
      'm365_connections_id_org_profile_attempt_uniq',
      'm365_connections_org_profile_uniq',
      'm365_connections_user_profile_uniq',
      'm365_connections_verified_tenant_profile_uniq',
    ]);
  });

  it('types observed grants as canonical assignment records', () => {
    type Grants = NonNullable<typeof m365Connections.$inferSelect.observedGrants>;
    const grants: Grants = [{
      resourceApplicationId: '00000003-0000-0000-c000-000000000000',
      appRoleId: 'df021288-bdef-4463-88db-98f22de89214',
      value: 'User.Read.All',
    }];
    expect(grants[0]?.appRoleId).toBe('df021288-bdef-4463-88db-98f22de89214');
  });
});

describe('m365ConsentSessions schema', () => {
  it('models the exact system-only consent lifecycle row', () => {
    const cfg = getTableConfig(m365ConsentSessions);
    expect(cfg.columns.map((c) => c.name).sort()).toEqual([
      'code_verifier', 'connection_id', 'consent_attempt_id', 'created_at',
      'expires_at', 'id', 'nonce', 'org_id', 'phase', 'profile', 'state_hash',
      'tenant_hint_hash', 'user_id',
    ].sort());
    expect(cfg.columns.find((c) => c.name === 'state_hash')?.notNull).toBe(true);
    expect(cfg.columns.find((c) => c.name === 'profile')?.notNull).toBe(true);
  });

  it('names its unique, expiry, attempt, foreign-key, and phase constraints', () => {
    const cfg = getTableConfig(m365ConsentSessions);
    expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual([
      'm365_consent_sessions_connection_attempt_idx',
      'm365_consent_sessions_expires_at_idx',
      'm365_consent_sessions_state_hash_uniq',
    ]);
    expect(cfg.foreignKeys.map((fk) => fk.getName())).toContain(
      'm365_consent_sessions_connection_identity_fkey',
    );
    expect(cfg.checks.map((check) => check.name).sort()).toEqual([
      'm365_consent_sessions_phase_check',
      'm365_consent_sessions_phase_fields_check',
      'm365_consent_sessions_profile_check',
    ]);
  });
});
