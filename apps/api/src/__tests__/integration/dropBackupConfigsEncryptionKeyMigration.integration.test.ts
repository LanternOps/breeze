/**
 * Live-Postgres proof for 2026-12-10-100000-drop-backup-configs-encryption-key.sql.
 *
 * setup.ts has already applied the migration, so each case restores the
 * pre-migration column inside a transaction, seeds a row, replays the real
 * migration file and rolls everything back afterwards.
 *
 * Prerequisites:
 *   pnpm test-stack up
 *
 * Run:
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/dropBackupConfigsEncryptionKeyMigration.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';

const MIGRATION_SQL = readFileSync(
  new URL('../../../migrations/2026-12-10-100000-drop-backup-configs-encryption-key.sql', import.meta.url),
  'utf8',
);

const runDb = it.runIf(!!process.env.DATABASE_URL);

class Rollback extends Error {}

async function columnExists(tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'backup_configs' AND column_name = 'encryption_key'
  `)) as unknown as unknown[];
  return rows.length > 0;
}

async function seedOrg(): Promise<string> {
  const partner = await createPartner({});
  const org = await createOrganization({ partnerId: partner!.id });
  return org!.id as string;
}

describe('drop backup_configs.encryption_key migration', () => {
  runDb('is applied on a fresh database (column absent)', async () => {
    await getTestDb().transaction(async (tx) => {
      expect(await columnExists(tx)).toBe(false);
    });
  });

  runDb('refuses to drop, reporting the count, when a row still holds a value', async () => {
    const orgId = await seedOrg();
    const attempt = getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
      await tx.execute(sql`ALTER TABLE backup_configs ADD COLUMN IF NOT EXISTS encryption_key text`);
      await tx.execute(sql`
        INSERT INTO backup_configs (org_id, name, type, provider, provider_config, encryption_key)
        VALUES (${orgId}, 'with value', 'file', 'local', '{}'::jsonb, 'not-empty'),
               (${orgId}, 'empty', 'file', 'local', '{}'::jsonb, NULL)
      `);
      // Reset to the default scope and drop to a role RLS binds (the test
      // connection is a superuser, which bypasses RLS) so the migration has
      // to elect system scope itself. Without that election the count reads
      // zero and the migration proceeds to the DROP, which breeze_app cannot
      // run ("must be owner") — a different error than the one asserted.
      await tx.execute(sql`SELECT set_config('breeze.scope', 'none', true)`);
      await tx.execute(sql`SET LOCAL ROLE breeze_app`);
      await tx.execute(sql.raw(MIGRATION_SQL));
    });
    const error = await attempt.then(() => null, (e: unknown) => e as Error & { cause?: Error });
    expect(error).not.toBeNull();
    // Drizzle wraps the Postgres error ("Failed query: ..."); the RAISE text is on the cause.
    expect(error!.cause?.message ?? error!.message).toMatch(
      /refusing to drop backup_configs\.encryption_key: 1 row\(s\)/,
    );
  });

  runDb('drops the column when every row is NULL, keeping the rows, and is a no-op on re-run', async () => {
    const orgId = await seedOrg();
    await expect(
      getTestDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
        await tx.execute(sql`ALTER TABLE backup_configs ADD COLUMN IF NOT EXISTS encryption_key text`);
        await tx.execute(sql`
          INSERT INTO backup_configs (org_id, name, type, provider, provider_config, encryption_key)
          VALUES (${orgId}, 'all null', 'file', 'local', '{}'::jsonb, NULL)
        `);
        expect(await columnExists(tx)).toBe(true);
        await tx.execute(sql`SELECT set_config('breeze.scope', 'none', true)`);

        await tx.execute(sql.raw(MIGRATION_SQL));
        expect(await columnExists(tx)).toBe(false);

        await tx.execute(sql.raw(MIGRATION_SQL));
        expect(await columnExists(tx)).toBe(false);

        await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
        const rows = (await tx.execute(
          sql`SELECT name FROM backup_configs WHERE org_id = ${orgId}`,
        )) as unknown as Array<{ name: string }>;
        expect(rows.map((r) => r.name)).toEqual(['all null']);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});
