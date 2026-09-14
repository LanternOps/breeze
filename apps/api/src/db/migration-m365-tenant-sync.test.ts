import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION = '2026-10-16-170200-m365-tenant-sync-foundation.sql';

const TABLES = [
  'm365_sync_state',
  'm365_users',
  'm365_intune_devices',
  'm365_ca_policies',
  'm365_license_skus',
  'm365_secure_score_snapshots',
  'm365_posture_rollups',
] as const;

describe('M365 tenant sync foundation migration', () => {
  const sql = readFileSync(join(__dirname, '../../migrations', MIGRATION), 'utf8');

  it('creates both enums through a duplicate_object-tolerant DO block', () => {
    expect(sql).toMatch(/CREATE TYPE m365_sync_domain AS ENUM \('users','signin_activity','intune_devices','ca_policies','skus','secure_score'\)/);
    expect(sql).toMatch(/CREATE TYPE m365_sync_status AS ENUM \('success','partial','needs_consent','throttled','error'\)/);
    expect(sql.match(/EXCEPTION WHEN duplicate_object THEN NULL/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('creates all seven tables idempotently with a NOT NULL org_id', () => {
    for (const table of TABLES) {
      expect(sql, `${table} missing`).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
    expect(sql.match(/org_id\s+uuid NOT NULL REFERENCES organizations\(id\) ON DELETE CASCADE/g))
      .toHaveLength(TABLES.length);
  });

  it('adds the (id, org_id) unique index on m365_connections as the composite FK target', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS m365_connections_id_org_uniq\s+ON public\.m365_connections \(id, org_id\)/,
    );
  });

  it('declares both composite tenant FKs deferrable, with a column-list SET NULL on the device link', () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT m365_sync_state_connection_org_fk\s+FOREIGN KEY \(connection_id, org_id\) REFERENCES m365_connections\(id, org_id\)\s+ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT m365_intune_devices_breeze_device_org_fk\s+FOREIGN KEY \(breeze_device_id, org_id\) REFERENCES devices\(id, org_id\)\s+ON DELETE SET NULL \(breeze_device_id\) DEFERRABLE INITIALLY IMMEDIATE/,
    );
    // A bare SET NULL on a composite FK nulls org_id too (NOT NULL -> 23502
    // mid-erasure, #4100). The column list is the whole point.
    expect(sql).not.toMatch(/REFERENCES devices\(id, org_id\)\s+ON DELETE SET NULL DEFERRABLE/);
  });

  it('creates the ticker and retention partial indexes', () => {
    expect(sql).toContain('m365_sync_state_due_idx');
    expect(sql).toMatch(/ON m365_sync_state \(next_sync_at\) WHERE next_sync_at IS NOT NULL/);
    for (const table of ['m365_users', 'm365_intune_devices', 'm365_ca_policies', 'm365_license_skus']) {
      expect(sql, `${table} stale partial index missing`)
        .toMatch(new RegExp(`ON ${table} \\(stale_since\\) WHERE is_stale`));
    }
    expect(sql).toMatch(
      /ON m365_secure_score_snapshots \(score_date\) WHERE control_scores IS NOT NULL/,
    );
  });

  it('enables and forces RLS with one org-access policy per table, guarded by pg_policies', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("policyname = t || '_org_access'");
    expect(sql).toMatch(/USING \(public\.breeze_has_org_access\(org_id\)\)/);
    expect(sql).toMatch(/WITH CHECK \(public\.breeze_has_org_access\(org_id\)\)/);
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.%I TO breeze_app');
  });

  it('opens no transaction of its own and elevates no scope (it writes no rows)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN;/m);
    expect(sql).not.toMatch(/^\s*COMMIT;/m);
    expect(sql).not.toContain("set_config('breeze.scope'");
  });
});
