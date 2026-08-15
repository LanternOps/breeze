/**
 * Replays 2026-08-23-software-version-url-file-type.sql against seeded rows in
 * the shapes production actually has.
 *
 * CI databases are migrated schema-fresh in globalSetup, so this backfill has
 * only ever run against ZERO rows there — the CI log reads "0 row(s)
 * classified, 0 row(s) still unclassified". A green migration therefore says
 * nothing about whether the derivation is correct, and the derivation is the
 * whole point: it decides whether an MSI reaches the agent as `fileType: 'msi'`
 * (msiexec) or `fileType: 'exe'` (exec the file directly → ERROR_BAD_EXE_FORMAT
 * on Windows, `unsupported file type` on macOS/Linux).
 *
 * It also pins the two things the SQL does that a reader would not assume:
 *   - original_file_name takes PRECEDENCE over download_url, because
 *     softwareDeployment.ts sends that filename verbatim and the agent's
 *     validateInstallFileName rejects the command unless its extension matches
 *     file_type. Deriving from a contradicting URL would convert a working
 *     install into a hard validation failure;
 *   - the stored value is lower-cased. software_install.go compares
 *     `fileType == "msi"` case-SENSITIVELY while isSupportedInstallFileType is
 *     case-INsensitive, so an uppercase 'MSI' would pass validation and then
 *     fall through to "unsupported file type" — a silent, differently-shaped
 *     failure.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/softwareVersionFileTypeMigration.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-08-23-software-version-url-file-type.sql',
);

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function replayMigration() {
  await getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));
}

/** Inserts a version with file_type NULL, bypassing every route-level guard. */
async function seedVersion(
  catalogId: string,
  version: string,
  downloadUrl: string | null,
  originalFileName: string | null,
  fileType: string | null = null,
): Promise<string> {
  const rows = await getTestDb().execute<{ id: string }>(sql`
    INSERT INTO software_versions
      (catalog_id, version, download_url, original_file_name, file_type, is_latest)
    VALUES (${catalogId}, ${version}, ${downloadUrl}, ${originalFileName}, ${fileType}, false)
    RETURNING id
  `);
  return (rows as unknown as { id: string }[])[0]!.id;
}

async function fileTypeOf(id: string): Promise<string | null> {
  const rows = await getTestDb().execute<{ file_type: string | null }>(
    sql`SELECT file_type FROM software_versions WHERE id = ${id}`,
  );
  return (rows as unknown as { file_type: string | null }[])[0]!.file_type;
}

describe('2026-08-23 software_versions.file_type backfill', () => {
  runDb('classifies, skips and lower-cases exactly as the derivation intends', async () => {
    const partner = await createPartner({});
    const org = await createOrganization({ partnerId: partner.id });
    const catalogRows = await getTestDb().execute<{ id: string }>(sql`
      INSERT INTO software_catalog (org_id, name, category)
      VALUES (${org.id}, 'Migration Probe', 'utility')
      RETURNING id
    `);
    const catalogId = (catalogRows as unknown as { id: string }[])[0]!.id;

    const ids = {
      urlMsi: await seedVersion(catalogId, 'url-msi', 'https://cdn.example/acme.msi', null),
      // The double split_part in the SQL exists for exactly this shape.
      presigned: await seedVersion(
        catalogId,
        'presigned',
        'https://cdn.example/acme.msi?X-Amz-Signature=deadbeef&e=1',
        null,
      ),
      fragment: await seedVersion(catalogId, 'fragment', 'https://cdn.example/acme.msi#sha256', null),
      uppercase: await seedVersion(catalogId, 'uppercase', 'https://cdn.example/Acme.MSI', null),
      // Deploy-time tokens survive in stored URLs; they must not defeat the regex.
      tokenized: await seedVersion(
        catalogId,
        'tokenized',
        'https://cdn.example/{{org.name}}/acme.msi',
        null,
      ),
      urlExe: await seedVersion(catalogId, 'url-exe', 'https://cdn.example/setup.exe', null),
      urlDeb: await seedVersion(catalogId, 'url-deb', 'https://cdn.example/agent.deb', null),
      // Unusable: left NULL rather than guessed at.
      noExtension: await seedVersion(catalogId, 'no-ext', 'https://vendor.example/latest', null),
      scriptUrl: await seedVersion(
        catalogId,
        'script-url',
        'https://vendor.example/download.php?product=acme',
        null,
      ),
      unsupportedExt: await seedVersion(catalogId, 'zip', 'https://cdn.example/bundle.zip', null),
      // Filename is authoritative: the URL here is an extensionless storage key.
      legacyName: await seedVersion(catalogId, 'legacy', 'https://s3.example/key/abc123', 'agent.msi'),
      // Filename CONTRADICTS the URL — the filename must still win.
      nameWins: await seedVersion(
        catalogId,
        'name-wins',
        'https://cdn.example/redirect.exe',
        'real-agent.msi',
      ),
      // Already classified: must not be rewritten even though the URL says msi.
      alreadySet: await seedVersion(catalogId, 'already', 'https://cdn.example/x.msi', null, 'exe'),
      noSource: await seedVersion(catalogId, 'no-source', null, null),
    };

    await replayMigration();

    expect(await fileTypeOf(ids.urlMsi)).toBe('msi');
    expect(await fileTypeOf(ids.presigned)).toBe('msi');
    expect(await fileTypeOf(ids.fragment)).toBe('msi');
    expect(await fileTypeOf(ids.uppercase)).toBe('msi'); // lower-cased, not 'MSI'
    expect(await fileTypeOf(ids.tokenized)).toBe('msi');
    expect(await fileTypeOf(ids.urlExe)).toBe('exe');
    expect(await fileTypeOf(ids.urlDeb)).toBe('deb');

    expect(await fileTypeOf(ids.noExtension)).toBeNull();
    expect(await fileTypeOf(ids.scriptUrl)).toBeNull();
    expect(await fileTypeOf(ids.unsupportedExt)).toBeNull();
    expect(await fileTypeOf(ids.noSource)).toBeNull();

    expect(await fileTypeOf(ids.legacyName)).toBe('msi');
    expect(await fileTypeOf(ids.nameWins)).toBe('msi');
    expect(await fileTypeOf(ids.alreadySet)).toBe('exe');

    // Replay is a true no-op — `WHERE file_type IS NULL` is the only thing
    // making this idempotent, and nothing else proves it.
    await replayMigration();
    expect(await fileTypeOf(ids.urlMsi)).toBe('msi');
    expect(await fileTypeOf(ids.alreadySet)).toBe('exe');
    expect(await fileTypeOf(ids.scriptUrl)).toBeNull();
  });
});
