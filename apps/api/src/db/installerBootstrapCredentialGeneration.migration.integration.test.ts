/**
 * Credential-generation migration cutover proof in a disposable database.
 *
 * Existing rows have no historical epoch, so a default-1/default-1 migration
 * would preserve potentially pre-rotation authority. This test executes the
 * actual migration against minimal legacy tables, verifies the fail-closed
 * cutover and forensic counts, then reapplies it to prove post-migration epoch
 * 1 data is not invalidated by an idempotent replay.
 */
import '../__tests__/integration/setup';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const migrationPath = fileURLToPath(
  new URL('../../migrations/2026-10-15-141001-installer-bootstrap-credential-generation.sql', import.meta.url),
);

describe('credential-generation migration cutover', () => {
  runDb('invalidates legacy authority once and is a no-op on replay', async () => {
    const sourceUrl = new URL(process.env.DATABASE_URL!);
    const databaseName = `bootstrap_epoch_${randomUUID().replaceAll('-', '')}`;
    const admin = postgres(sourceUrl.toString(), { max: 1 });
    let isolated: Sql | null = null;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      sourceUrl.pathname = `/${databaseName}`;
      const notices: string[] = [];
      isolated = postgres(sourceUrl.toString(), {
        max: 1,
        onnotice: (notice) => notices.push(notice.message ?? ''),
      });

      await isolated.unsafe(`
        CREATE TABLE enrollment_keys (
          id uuid PRIMARY KEY,
          usage_count integer NOT NULL DEFAULT 0,
          bootstrap_token_id uuid
        );
        CREATE TABLE installer_bootstrap_tokens (
          id uuid PRIMARY KEY,
          parent_enrollment_key_id uuid NOT NULL
        );
      `);

      const legacyParent = randomUUID();
      const untouchedParent = randomUUID();
      const legacyToken = randomUUID();
      const unusedChild = randomUUID();
      const usedChild = randomUUID();
      const orphanedTokenId = randomUUID();
      const orphanedUnusedChild = randomUUID();
      const orphanedUsedChild = randomUUID();
      await isolated`
        INSERT INTO enrollment_keys (id, usage_count, bootstrap_token_id)
        VALUES
          (${legacyParent}, 0, NULL),
          (${untouchedParent}, 0, NULL),
          (${unusedChild}, 0, ${legacyToken}),
          (${usedChild}, 1, ${legacyToken}),
          (${orphanedUnusedChild}, 0, ${orphanedTokenId}),
          (${orphanedUsedChild}, 1, ${orphanedTokenId})
      `;
      await isolated`
        INSERT INTO installer_bootstrap_tokens (id, parent_enrollment_key_id)
        VALUES (${legacyToken}, ${legacyParent})
      `;

      const migrationSql = await readFile(migrationPath, 'utf8');
      await isolated.unsafe(migrationSql);

      const afterCutover = await isolated<{
        id: string;
        credential_generation: number;
      }[]>`
        SELECT id, credential_generation
        FROM enrollment_keys
        ORDER BY id
      `;
      const generationById = new Map(
        afterCutover.map((row) => [row.id, row.credential_generation]),
      );
      expect(generationById.get(legacyParent)).toBe(2);
      expect(generationById.get(untouchedParent)).toBe(1);
      expect(generationById.has(unusedChild)).toBe(false);
      expect(generationById.get(usedChild)).toBe(1);
      expect(generationById.has(orphanedUnusedChild)).toBe(false);
      expect(generationById.get(orphanedUsedChild)).toBe(1);

      const [legacyTokenRow] = await isolated<{
        parent_credential_generation: number;
      }[]>`
        SELECT parent_credential_generation
        FROM installer_bootstrap_tokens
        WHERE id = ${legacyToken}
      `;
      expect(legacyTokenRow?.parent_credential_generation).toBe(1);
      expect(notices).toEqual(
        expect.arrayContaining([
          expect.stringContaining('invalidated legacy tokens for 1 parent enrollment key(s)'),
          expect.stringContaining('deleted 2 unused legacy derived enrollment key(s)'),
        ]),
      );

      const postMigrationParent = randomUUID();
      const postMigrationToken = randomUUID();
      const postMigrationChild = randomUUID();
      await isolated`
        INSERT INTO enrollment_keys (id, usage_count, bootstrap_token_id)
        VALUES
          (${postMigrationParent}, 0, NULL),
          (${postMigrationChild}, 0, ${postMigrationToken})
      `;
      await isolated`
        INSERT INTO installer_bootstrap_tokens (id, parent_enrollment_key_id)
        VALUES (${postMigrationToken}, ${postMigrationParent})
      `;

      notices.length = 0;
      await isolated.unsafe(migrationSql);
      const replayRows = await isolated<{
        id: string;
        credential_generation: number;
      }[]>`
        SELECT id, credential_generation
        FROM enrollment_keys
        WHERE id IN (${postMigrationParent}, ${postMigrationChild})
      `;
      expect(replayRows).toHaveLength(2);
      expect(replayRows.every((row) => row.credential_generation === 1)).toBe(true);
      expect(notices).toEqual([]);
    } finally {
      if (isolated) await isolated.end({ timeout: 1 });
      await admin.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}'`,
      );
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end({ timeout: 1 });
    }
  });
});
