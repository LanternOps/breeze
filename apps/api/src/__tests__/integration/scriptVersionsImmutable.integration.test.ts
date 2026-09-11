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
import { createOrganization, createPartner } from './db-utils';

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
