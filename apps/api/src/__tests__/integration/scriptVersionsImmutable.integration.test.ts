/**
 * script_versions as immutable execution definitions (spec §4.1).
 *
 * Proves, through the real driver as the unprivileged `breeze_app` role:
 *   - INSERT and SELECT still work for the owning org;
 *   - UPDATE and DELETE affect zero rows for EVERY scope, including system,
 *     because the 2026-10-01 UPDATE/DELETE policies are gone;
 *   - duplicate (script_id, version) is refused with 23505;
 *   - deleting the parent script removes its versions (ON DELETE CASCADE);
 *   - the UPDATE-refusing trigger is installed (the owner-facing backstop; it
 *     is not reachable from breeze_app, which the missing policy already stops,
 *     so this asserts installation, not a raise).
 *
 * Fixtures are re-seeded per test: the integration setup truncates tenant data
 * between tests, so a memoized fixture would be stale and vacuous.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { scripts, scriptVersions } from '../../db/schema';
import { cutScriptVersion, headScriptVersion, sha256Content } from '../../services/scriptVersions';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';
import { replayMigration } from './replayMigration';

const MIGRATION = '2026-10-16-100000-script-versions-immutable.sql';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null };
}

async function seedScriptWithVersion() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [script] = await db
      .insert(scripts)
      .values({
        orgId: org.id,
        partnerId: partner.id,
        name: `immutable-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        osTypes: ['windows'],
        language: 'powershell',
        content: 'Write-Host "v1"',
        timeoutSeconds: 300,
        runAs: 'system',
        version: 1,
      })
      .returning();
    const [version] = await db
      .insert(scriptVersions)
      .values({
        scriptId: script!.id,
        version: 1,
        content: 'Write-Host "v1"',
        language: 'powershell',
        timeoutSeconds: 300,
        runAs: 'system',
        parameters: null,
        contentDigest: 'a'.repeat(64),
        origin: 'human',
        changelog: 'seed',
        createdBy: null,
      })
      .returning();
    return { partner, org, script: script!, version: version! };
  });
}

describe('script_versions immutability contract (breeze_app role)', () => {
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const { org, partner } = await seedScriptWithVersion();
    const rows = await withDbAccessContext(orgCtx(org.id, partner.id), () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`)
    );
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  runDb('the owning org can still INSERT and SELECT a version row', async () => {
    const { org, partner, script } = await seedScriptWithVersion();
    const inserted = await withDbAccessContext(orgCtx(org.id, partner.id), () =>
      db
        .insert(scriptVersions)
        .values({
          scriptId: script.id,
          version: 2,
          content: 'Write-Host "v2"',
          language: 'powershell',
          timeoutSeconds: 300,
          runAs: 'system',
          parameters: null,
          contentDigest: 'b'.repeat(64),
          origin: 'human',
          changelog: null,
          createdBy: null,
        })
        .returning({ id: scriptVersions.id })
    );
    expect(inserted).toHaveLength(1);

    const read = await withDbAccessContext(orgCtx(org.id, partner.id), () =>
      db.select({ version: scriptVersions.version }).from(scriptVersions).where(eq(scriptVersions.scriptId, script.id))
    );
    expect(read.map((r) => r.version).sort()).toEqual([1, 2]);
  });

  runDb('UPDATE affects zero rows for the owning org AND for system scope, and the row is intact', async () => {
    const { org, partner, version } = await seedScriptWithVersion();

    const byOrg = await withDbAccessContext(orgCtx(org.id, partner.id), () =>
      db.update(scriptVersions).set({ changelog: 'tampered' }).where(eq(scriptVersions.id, version.id)).returning({ id: scriptVersions.id })
    );
    const bySystem = await withSystemDbAccessContext(() =>
      db.update(scriptVersions).set({ changelog: 'tampered' }).where(eq(scriptVersions.id, version.id)).returning({ id: scriptVersions.id })
    );
    expect(byOrg).toEqual([]);
    expect(bySystem).toEqual([]);

    const intact = await withSystemDbAccessContext(() =>
      db.select({ changelog: scriptVersions.changelog }).from(scriptVersions).where(eq(scriptVersions.id, version.id))
    );
    expect(intact).toEqual([{ changelog: 'seed' }]);
  });

  runDb('DELETE affects zero rows for the owning org AND for system scope', async () => {
    const { org, partner, version } = await seedScriptWithVersion();
    const byOrg = await withDbAccessContext(orgCtx(org.id, partner.id), () =>
      db.delete(scriptVersions).where(eq(scriptVersions.id, version.id)).returning({ id: scriptVersions.id })
    );
    const bySystem = await withSystemDbAccessContext(() =>
      db.delete(scriptVersions).where(eq(scriptVersions.id, version.id)).returning({ id: scriptVersions.id })
    );
    expect(byOrg).toEqual([]);
    expect(bySystem).toEqual([]);
  });

  runDb('a duplicate (script_id, version) is refused with 23505', async () => {
    const { org, partner, script } = await seedScriptWithVersion();
    let code: string | undefined;
    try {
      await withDbAccessContext(orgCtx(org.id, partner.id), () =>
        db.insert(scriptVersions).values({
          scriptId: script.id,
          version: 1,
          content: 'duplicate',
          language: 'powershell',
          timeoutSeconds: 300,
          runAs: 'system',
          parameters: null,
          contentDigest: 'c'.repeat(64),
          origin: 'human',
          changelog: null,
          createdBy: null,
        })
      );
    } catch (err) {
      code = (err as { cause?: { code?: string } }).cause?.code;
    }
    expect(code).toBe('23505');
  });

  runDb('deleting the parent script cascades the version rows away', async () => {
    const { script, version } = await seedScriptWithVersion();
    await withSystemDbAccessContext(() => db.delete(scripts).where(eq(scripts.id, script.id)));
    const left = await withSystemDbAccessContext(() =>
      db.select({ id: scriptVersions.id }).from(scriptVersions).where(eq(scriptVersions.id, version.id))
    );
    expect(left).toEqual([]);
  });

  runDb('exactly two RLS policies remain — SELECT and INSERT', async () => {
    const rows = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT policyname, cmd FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'script_versions'
                     ORDER BY cmd, policyname`)
    )) as unknown as Array<{ policyname: string; cmd: string }>;
    expect(rows.map((r) => r.cmd).sort()).toEqual(['INSERT', 'SELECT']);
  });

  runDb('the owner-facing immutability trigger is installed on UPDATE', async () => {
    const rows = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT t.tgname, p.proname
                     FROM pg_trigger t
                     JOIN pg_class c ON c.oid = t.tgrelid
                     JOIN pg_proc p ON p.oid = t.tgfoid
                     WHERE c.relname = 'script_versions' AND NOT t.tgisinternal`)
    )) as unknown as Array<{ tgname: string; proname: string }>;
    expect(rows.map((r) => r.tgname)).toContain('script_versions_immutable');
    expect(rows.map((r) => r.proname)).toContain('breeze_script_versions_immutable');
  });

  runDb('the FK to scripts carries ON DELETE CASCADE', async () => {
    const rows = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT confdeltype FROM pg_constraint
                     WHERE conname = 'script_versions_script_id_scripts_id_fk'`)
    )) as unknown as Array<{ confdeltype: string }>;
    expect(rows[0]?.confdeltype).toBe('c');
  });

  runDb('every existing row carries the definition columns', async () => {
    const rows = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT count(*) AS bad FROM script_versions
                     WHERE language IS NULL OR timeout_seconds IS NULL
                        OR run_as IS NULL OR content_digest IS NULL`)
    )) as unknown as Array<{ bad: string }>;
    expect(Number(rows[0]?.bad ?? -1)).toBe(0);
  });
});

/**
 * The claims cutScriptVersion's docblock makes that only real Postgres can
 * settle: the FOR UPDATE lock serialises concurrent cuts, and the SQL twin of
 * sha256Content agrees with the TypeScript one.
 */
describe('cutScriptVersion against real Postgres', () => {
  runDb('two concurrent cuts serialise on the lock instead of colliding on UNIQUE', async () => {
    const { script } = await seedScriptWithVersion();

    // Independent contexts => independent pooled connections => two real
    // concurrent transactions. Without `FOR UPDATE` both would read
    // scripts.version = 1, both would target version 2, and the loser would
    // reject with 23505 rather than producing version 3.
    const cut = () =>
      withSystemDbAccessContext(() =>
        db.transaction((tx) =>
          cutScriptVersion(tx, { scriptId: script.id, provenance: { origin: 'human', createdBy: null } })
        )
      );
    const [a, b] = await Promise.all([cut(), cut()]);

    expect([a.version, b.version].sort()).toEqual([2, 3]);

    const rows = await withSystemDbAccessContext(() =>
      db.select({ version: scriptVersions.version }).from(scriptVersions).where(eq(scriptVersions.scriptId, script.id))
    );
    expect(rows.map((r) => r.version).sort()).toEqual([1, 2, 3]);

    const [parent] = await withSystemDbAccessContext(() =>
      db.select({ version: scripts.version }).from(scripts).where(eq(scripts.id, script.id))
    );
    expect(parent?.version).toBe(3);
  });

  runDb('snapshots the AFTER image with a digest the SQL twin agrees with', async () => {
    const { script } = await seedScriptWithVersion();
    const after = 'Write-Host "after"\r\n';

    const cut = await withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        await tx.update(scripts).set({ content: after }).where(eq(scripts.id, script.id));
        return cutScriptVersion(tx, { scriptId: script.id, provenance: { origin: 'human', createdBy: null } });
      })
    );

    expect(cut.content).toBe(after);
    expect(cut.contentDigest).toBe(sha256Content(after));

    // The SQL twin (used by the migration's backfill) must agree with the
    // TypeScript one, or a backfilled row and a cut row would carry different
    // digests for identical content.
    const rows = (await withSystemDbAccessContext(() =>
      db.execute(
        sql`SELECT encode(sha256(convert_to(normalize(replace(${after}, E'\r\n', E'\n'), NFC), 'UTF8')), 'hex') AS digest`
      )
    )) as unknown as Array<{ digest: string }>;
    expect(rows[0]?.digest).toBe(sha256Content(after));
  });
});

describe('headScriptVersion', () => {
  runDb('returns the row whose version equals scripts.version, not merely the newest', async () => {
    const { script } = await seedScriptWithVersion();

    const head1 = await withSystemDbAccessContext(() => headScriptVersion(db, script.id));
    expect(head1?.version).toBe(1);
    expect(head1?.content).toBe('Write-Host "v1"');

    // A version row ABOVE scripts.version (which the parent never advanced to)
    // must not be mistaken for the head.
    await withSystemDbAccessContext(() =>
      db.insert(scriptVersions).values({
        scriptId: script.id,
        version: 9,
        content: 'not the head',
        language: 'powershell',
        timeoutSeconds: 300,
        runAs: 'system',
        parameters: null,
        contentDigest: sha256Content('not the head'),
        origin: 'human',
        changelog: null,
        createdBy: null,
      })
    );

    const head2 = await withSystemDbAccessContext(() => headScriptVersion(db, script.id));
    expect(head2?.version).toBe(1);
    expect(head2?.content).toBe('Write-Host "v1"');
  });

  runDb('returns null for a script with no matching version row', async () => {
    const head = await withSystemDbAccessContext(() =>
      headScriptVersion(db, '00000000-0000-4000-8000-000000000000')
    );
    expect(head).toBeNull();
  });
});

/**
 * The migration's duplicate-repair CTE only executes when the table already
 * holds duplicate (script_id, version) pairs — which, once the UNIQUE
 * constraint exists, can never happen again. A shipped migration cannot be
 * edited, so the repair has exactly one chance to be correct: this is it.
 */
describe(`${MIGRATION} duplicate repair`, () => {
  runDb('renumbers duplicates above the script max, keeping the oldest row at its number', async () => {
    const { script } = await seedScriptWithVersion();
    const testDb = getTestDb();

    // Drop the constraint the migration installs so duplicates can exist,
    // exactly as they did before this migration shipped.
    await testDb.execute(
      sql`ALTER TABLE public.script_versions DROP CONSTRAINT IF EXISTS script_versions_script_id_version_key`
    );

    const dupe = (content: string, createdAt: string) =>
      withSystemDbAccessContext(() =>
        db.insert(scriptVersions).values({
          scriptId: script.id,
          version: 1,
          content,
          language: 'powershell',
          timeoutSeconds: 300,
          runAs: 'system',
          parameters: null,
          contentDigest: sha256Content(content),
          origin: 'human',
          changelog: content,
          createdAt: new Date(createdAt),
          createdBy: null,
        })
      );
    // The seeded row is created now; give the duplicates LATER timestamps so
    // the repair's `ORDER BY created_at, id` keeps the seed at version 1.
    await dupe('dupe-a', '2030-01-01T00:00:00Z');
    await dupe('dupe-b', '2030-01-02T00:00:00Z');

    const before = await withSystemDbAccessContext(() =>
      db.select({ version: scriptVersions.version }).from(scriptVersions).where(eq(scriptVersions.scriptId, script.id))
    );
    // Guards the guard: the duplicates really are duplicates, so a green
    // result below describes a repair rather than a table that never had any.
    expect(before.map((r) => r.version)).toEqual([1, 1, 1]);

    await replayMigration(MIGRATION);

    const after = await withSystemDbAccessContext(() =>
      db
        .select({ version: scriptVersions.version, changelog: scriptVersions.changelog })
        .from(scriptVersions)
        .where(eq(scriptVersions.scriptId, script.id))
    );
    const versions = after.map((r) => r.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(after.find((r) => r.changelog === 'seed')?.version).toBe(1);
    for (const changelog of ['dupe-a', 'dupe-b']) {
      expect(after.find((r) => r.changelog === changelog)!.version).toBeGreaterThan(1);
    }

    // And the constraint is back, so the repaired state cannot re-degrade.
    const conRows = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT 1 AS ok FROM pg_constraint WHERE conname = 'script_versions_script_id_version_key'`)
    )) as unknown as Array<{ ok: number }>;
    expect(conRows).toHaveLength(1);
  });
});
