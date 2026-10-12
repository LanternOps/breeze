/**
 * 2026-12-12-120100-security-quarantine-execution-authority.sql on a database
 * that HAS security feature links.
 *
 * config_policy_feature_links carries a DEFERRABLE INITIALLY DEFERRED
 * constraint trigger (backup-settings parity, 2026-07-27-c). The migration's
 * grandfathering UPDATE queues one deferred event per marked link, and any
 * later ALTER TABLE on the same table in the same transaction fails with
 * "cannot ALTER TABLE ... because it has pending trigger events" unless the
 * events are fired first. A fresh or empty table never queues an event, which
 * is why CI passed and the v0.122.0 EU deploy crash-looped. This test runs the
 * real file the way autoMigrate does (one transaction) against minimal tables
 * that reproduce that shape.
 */
import '../__tests__/integration/setup';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const migrationPath = fileURLToPath(
  new URL('../../migrations/2026-12-12-120100-security-quarantine-execution-authority.sql', import.meta.url),
);

async function withIsolatedDb(fn: (db: Sql) => Promise<void>): Promise<void> {
  const sourceUrl = new URL(process.env.DATABASE_URL!);
  const databaseName = `quarantine_authority_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(sourceUrl.toString(), { max: 1 });
  let isolated: Sql | null = null;
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    sourceUrl.pathname = `/${databaseName}`;
    isolated = postgres(sourceUrl.toString(), { max: 1, onnotice: () => {} });
    await fn(isolated);
  } finally {
    await isolated?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
}

// The tables and helpers the migration touches, as they stand before it runs,
// with the same deferred constraint trigger shape as production.
const PRE_MIGRATION_SCHEMA = `
  CREATE TABLE organizations (id uuid PRIMARY KEY, partner_id uuid NOT NULL);
  CREATE TABLE configuration_policies (
    id uuid PRIMARY KEY,
    org_id uuid,
    partner_id uuid
  );
  CREATE TABLE config_policy_feature_links (
    id uuid PRIMARY KEY,
    config_policy_id uuid NOT NULL,
    feature_type varchar(32) NOT NULL,
    inline_settings jsonb
  );
  CREATE TABLE security_scans (id uuid PRIMARY KEY);

  CREATE FUNCTION public.breeze_partner_export_lock_partners_exclusive(uuid[])
    RETURNS void LANGUAGE sql AS $$ SELECT $$;
  CREATE FUNCTION public.breeze_partner_export_lock_orgs_under_exclusive_partners(uuid[], uuid[])
    RETURNS void LANGUAGE sql AS $$ SELECT $$;

  CREATE FUNCTION public.test_deferred_parity() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RETURN NULL; END $$;
  CREATE CONSTRAINT TRIGGER config_policy_feature_links_backup_settings_parity
    AFTER INSERT OR UPDATE OR DELETE ON public.config_policy_feature_links
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.test_deferred_parity();
`;

async function seedSecurityLinks(db: Sql): Promise<{ grandfatheredId: string; offId: string }> {
  const partnerId = randomUUID();
  const orgId = randomUUID();
  const policyId = randomUUID();
  const grandfatheredId = randomUUID();
  const offId = randomUUID();
  await db`INSERT INTO organizations (id, partner_id) VALUES (${orgId}, ${partnerId})`;
  await db`INSERT INTO configuration_policies (id, org_id) VALUES (${policyId}, ${orgId})`;
  // Auto-quarantine absent (the shared default, on) → grandfathered; explicitly
  // off → left alone.
  await db`
    INSERT INTO config_policy_feature_links (id, config_policy_id, feature_type, inline_settings)
    VALUES
      (${grandfatheredId}, ${policyId}, 'security', '{}'::jsonb),
      (${offId}, ${policyId}, 'security', '{"autoQuarantine": false}'::jsonb)
  `;
  return { grandfatheredId, offId };
}

describe('security quarantine execution-authority migration', () => {
  runDb('applies in one transaction on a table with security links, and replays as a no-op', async () => {
    await withIsolatedDb(async (db) => {
      await db.unsafe(PRE_MIGRATION_SCHEMA);
      const { grandfatheredId, offId } = await seedSecurityLinks(db);
      const migrationSql = await readFile(migrationPath, 'utf8');

      // autoMigrate applies each file inside client.begin().
      await db.begin(async (tx) => {
        await tx.unsafe(migrationSql);
      });

      const rows = await db<{ id: string; execution_authority_legacy: string | null }[]>`
        SELECT id, execution_authority_legacy FROM config_policy_feature_links
      `;
      const byId = new Map(rows.map((r) => [r.id, r.execution_authority_legacy]));
      expect(byId.get(grandfatheredId)).toBe('grandfathered');
      expect(byId.get(offId)).toBeNull();

      const constraints = await db<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'public.config_policy_feature_links'::regclass AND contype = 'c'
         ORDER BY conname
      `;
      expect(constraints.map((c) => c.conname)).toEqual([
        'config_policy_feature_links_execution_authority_legacy_chk',
        'config_policy_feature_links_execution_authority_shape_chk',
        'config_policy_feature_links_execution_authority_status_chk',
      ]);

      // Replay: the column exists, so the UPDATE branch is skipped and the
      // marker is never re-written.
      await db`UPDATE config_policy_feature_links SET execution_authority_legacy = NULL WHERE id = ${grandfatheredId}`;
      await db.begin(async (tx) => {
        await tx.unsafe(migrationSql);
      });
      const [replayed] = await db<{ execution_authority_legacy: string | null }[]>`
        SELECT execution_authority_legacy FROM config_policy_feature_links WHERE id = ${grandfatheredId}
      `;
      expect(replayed?.execution_authority_legacy).toBeNull();
    });
  });
});
