# W01a — Script Versions Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** rebuild `script_versions` into immutable, content-addressed execution definitions that every script writer cuts through one shared helper, so a later wave can hang AI provenance on them.

**Architecture:** one idempotent migration adds the definition + provenance columns, repairs and uniquifies `(script_id, version)`, gives the child FK `ON DELETE CASCADE`, reduces RLS to INSERT + SELECT, installs an UPDATE-refusing trigger, and backfills a head row for every script. A new `services/scriptVersions.ts` owns the only INSERT into the table (`cutScriptVersion`), and each of the seven existing script writers is converted, one task at a time, under a grep contract test whose allowlist shrinks with each conversion.

**Tech Stack:** PostgreSQL 16 (RLS FORCE, `sha256()`, `normalize(… , NFC)`), Drizzle ORM, Hono, Vitest (unit + integration configs), TypeScript.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-11-ai-script-authoring-and-review-design.md` (§3 script_versions/writers rows, §4.1 "script_versions (existing, rebuilt…)", §5, §7, §8 W01)

**Roadmap (cross-wave contracts):** `docs/superpowers/plans/ai-mcp/2026-09-11-ai-script-authoring-roadmap.md` §3.2. This wave **produces** `cutScriptVersion`, `headScriptVersion`, `sha256Content`, `ScriptVersionProvenance` under exactly those names. Later waves consume them — do not rename.

---

## Global Constraints

Every task inherits these. They are copied from the roadmap §2 and CLAUDE.md.

- **Migration slot:** exactly one new file, `apps/api/migrations/2026-10-16-100000-script-versions-immutable.sql`. It must sort after the newest shipped migration (`2026-10-15-170200-organization-key-dates.sql` as of 2026-09-11). Before pushing, re-verify with `./scripts/check-migration-naming.sh --against-ref origin/main`; if `main` gained a later file, rename and sweep every `readFileSync('../../../migrations/<file>.sql')` reference.
- **Migration rules:** idempotent (`IF NOT EXISTS` / `DROP … IF EXISTS` then re-add / `DO $$ … EXCEPTION`); **no inner `BEGIN;`/`COMMIT;`** (autoMigrate wraps each file); the file's first statement is `SELECT set_config('breeze.scope', 'system', true);` because it performs DML; every `UPDATE`/`INSERT` cleanup reports its count with `GET DIAGNOSTICS` + `RAISE WARNING`, including zero.
- **Never edit a shipped migration.** `2026-10-01-100000-script-children-rls.sql` is shipped: its UPDATE/DELETE policies are dropped by the *new* file, never by editing it.
- **Tenancy:** `script_versions` has **no `org_id`** and reaches its tenant through `scripts`. It therefore needs **no** entry in `CORE_ORG_CASCADE_DELETE_ORDER`, **no** entry in `CORE_TENANT_EXPORT_POLICY`, and **no** entry in `AUDIT_ADMIN_REQUIRED_TABLES`. Task 15 verifies this by reading the registries rather than assuming it.
- **`scripts` gains NO new columns in this wave.** `scripts.origin` / `scripts.origin_proposal_id` land in W01b's `2026-10-16-100300-scripts-origin.sql`. Adding a column to `scripts` here would additionally require a `CORE_TENANT_EXPORT_POLICY` reclassification, which is W01b's job.
- **Feature flag:** none. Nothing in this wave is user-visible behaviour behind `BREEZE_AI_SCRIPT_AUTHORING_ENABLED`; the version rebuild is unconditional.
- **No agent-facing payload changes.** The Go agent is untouched.
- **Tests sit beside source.** Run one API file with `cd apps/api && npx vitest run <path>`. Never write `pnpm --filter <pkg> test -- --run <path>` (the `--` makes vitest run the whole suite in watch mode).
- **Integration suites need a live database.** `pnpm test-stack up` before, `pnpm test-stack down` after. Run with `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`.
- **Canonicalisation is one definition in two languages.** TypeScript: `content.normalize('NFC').replace(/\r\n/g, '\n')` then sha256 hex. SQL: `encode(sha256(convert_to(normalize(replace(content, E'\r\n', E'\n'), NFC), 'UTF8')), 'hex')`. No trimming on either side. If one changes, both change.

### Design decisions taken in this plan (flagged, not asked)

1. **`cutScriptVersion` always increments.** To keep one contract ("lock, increment, snapshot the after-image"), a freshly-inserted script row is written with `version: 0` inside the same transaction and `cutScriptVersion` moves it to `1`. `version = 0` is never observable outside the creating transaction. This is what keeps the roadmap's fixed signature `{ scriptId, provenance }` usable on both the create and the update path.
2. **Org-clone of a system script and `scriptClone` cut `origin: 'human'`**, not `'imported'`. `'imported'` is reserved for the bundle importer (spec §4.1 writers row); a clone is a person copying a script in the UI.
3. **`ScriptOrigin` and `ScriptApprovalMethod` are created in this wave**, not W01b — see "Roadmap contradiction" below.

### Roadmap contradiction to be aware of

Roadmap §3.1 assigns `packages/shared/src/types/scriptProposals.ts` (containing `ScriptOrigin` and `ScriptApprovalMethod`) to **W01b**, but §3.2 has **W01a**'s `ScriptVersionProvenance` referencing both types, and W01a ships first. Task 1 resolves this by creating that file in W01a with exactly those two types; W01b extends the same file with `ScriptProposal`, `ScriptProposalReview`, and `ScriptProposalStatus`. No name changes.

---

### Task 1: Shared `ScriptOrigin` / `ScriptApprovalMethod` types

**Files:**
- Create: `packages/shared/src/types/scriptProposals.ts`
- Create: `packages/shared/src/types/scriptProposals.test.ts`
- Modify: `packages/shared/src/types/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ScriptOrigin = 'human' | 'ai_proposal' | 'imported' | 'system'`, `SCRIPT_ORIGINS` (readonly tuple), `ScriptApprovalMethod = 'supervised_self' | 'four_eyes' | 'unattended_reviewer_gated' | 'direct_ui' | 'automation'`, `SCRIPT_APPROVAL_METHODS`. Consumed by Task 5 (Drizzle `$type`), Task 7 (`ScriptVersionProvenance`), and every writer task.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/types/scriptProposals.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  SCRIPT_ORIGINS,
  SCRIPT_APPROVAL_METHODS,
  type ScriptOrigin,
  type ScriptApprovalMethod,
} from './scriptProposals';

describe('script proposal enums', () => {
  it('lists the four script origins in the order the pg enum declares them', () => {
    expect(SCRIPT_ORIGINS).toEqual(['human', 'ai_proposal', 'imported', 'system']);
  });

  it('lists the five approval methods', () => {
    expect(SCRIPT_APPROVAL_METHODS).toEqual([
      'supervised_self',
      'four_eyes',
      'unattended_reviewer_gated',
      'direct_ui',
      'automation',
    ]);
  });

  it('narrows the union types to the tuple members', () => {
    const origin: ScriptOrigin = 'ai_proposal';
    const method: ScriptApprovalMethod = 'four_eyes';
    expect(SCRIPT_ORIGINS).toContain(origin);
    expect(SCRIPT_APPROVAL_METHODS).toContain(method);
  });
});

describe('shared barrel', () => {
  it('re-exports the origin tuple from the package root', async () => {
    const barrel = await import('../index');
    expect((barrel as { SCRIPT_ORIGINS: readonly string[] }).SCRIPT_ORIGINS).toEqual(SCRIPT_ORIGINS);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/shared && npx vitest run src/types/scriptProposals.test.ts`
Expected: FAIL — `Failed to resolve import "./scriptProposals"`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/types/scriptProposals.ts`:

```ts
/**
 * Shared vocabulary for AI-authored scripts (spec
 * docs/superpowers/specs/ai-mcp/2026-09-11-ai-script-authoring-and-review-design.md).
 *
 * W01a creates this file with the two enums `script_versions` needs. W01b
 * extends it with the proposal DTOs (`ScriptProposal`, `ScriptProposalReview`,
 * `ScriptProposalStatus`) — do not move these two out when that lands.
 */

/** Birth record of a script version row. Mirrors the `script_origin` pg enum. */
export const SCRIPT_ORIGINS = ['human', 'ai_proposal', 'imported', 'system'] as const;
export type ScriptOrigin = (typeof SCRIPT_ORIGINS)[number];

/** How a run of this content was authorised. Stored as text, not a pg enum,
 *  because W03/W04 add values and a text column avoids an enum migration. */
export const SCRIPT_APPROVAL_METHODS = [
  'supervised_self',
  'four_eyes',
  'unattended_reviewer_gated',
  'direct_ui',
  'automation',
] as const;
export type ScriptApprovalMethod = (typeof SCRIPT_APPROVAL_METHODS)[number];
```

Append to `packages/shared/src/types/index.ts`, next to the other `export * from './…'` lines at the top of the file:

```ts
export * from './scriptProposals';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/shared && npx vitest run src/types/scriptProposals.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/scriptProposals.ts \
        packages/shared/src/types/scriptProposals.test.ts \
        packages/shared/src/types/index.ts
git commit -m "feat(shared): script origin and approval-method vocabulary"
```

---

### Task 2: Failing live-DB contract for immutable `script_versions`

**Files:**
- Create: `apps/api/src/__tests__/integration/scriptVersionsImmutable.integration.test.ts`

**Interfaces:**
- Consumes: `createPartner`, `createOrganization` from `apps/api/src/__tests__/integration/db-utils.ts`; `db`, `withDbAccessContext`, `withSystemDbAccessContext`, `DbAccessContext` from `apps/api/src/db`.
- Produces: the red that Task 3's migration turns green. No source exports.

This task writes only the test. It is expected to stay red until Task 3.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/integration/scriptVersionsImmutable.integration.test.ts`:

```ts
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
import { and, eq, sql } from 'drizzle-orm';
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptVersionsImmutable.integration.test.ts
```
Expected: FAIL. The first failure is a TypeScript/driver error on the unknown columns `language` / `timeout_seconds` / `run_as` / `content_digest` / `origin` in the seed insert (`column "language" of relation "script_versions" does not exist`). Leave the stack up.

- [ ] **Step 3: Commit the red test**

```bash
git add apps/api/src/__tests__/integration/scriptVersionsImmutable.integration.test.ts
git commit -m "test(api): red contract for immutable script_versions"
```

---

### Task 3: The migration

**Files:**
- Create: `apps/api/migrations/2026-10-16-100000-script-versions-immutable.sql`
- Test: `apps/api/src/__tests__/integration/scriptVersionsImmutable.integration.test.ts` (from Task 2), plus `apps/api/src/db/migrationRlsScope.test.ts` and `apps/api/src/db/autoMigrate.test.ts` (existing guards, unchanged)

**Interfaces:**
- Consumes: the `script_language` and `script_run_as` pg enums (`apps/api/src/db/schema/scripts.ts:8-9`), `public.users(id)`, `public.scripts(id)`.
- Produces: pg enum `script_origin`; `script_versions` columns `language`, `timeout_seconds`, `run_as`, `parameters`, `content_digest`, `origin`, `proposal_id`, `review_id`, `reviewed_at`, `approved_by`, `approved_at`, `approval_method`; constraint `script_versions_script_id_version_key`; FK `script_versions_script_id_scripts_id_fk` with `ON DELETE CASCADE`; function `public.breeze_script_versions_immutable()`; trigger `script_versions_immutable`.

Source columns copied by the backfill were verified present on `scripts` in `apps/api/src/db/schema/scripts.ts`: `content` (:37), `language` (:34), `timeout_seconds` (:42), `run_as` (:43), `parameters` (:41), `version` (:45), `is_system` (:44), `created_by` (:69), `created_at` (:70).

- [ ] **Step 1: Write the enum, columns, and the `approved_by` FK**

Create `apps/api/migrations/2026-10-16-100000-script-versions-immutable.sql` starting with:

```sql
-- 2026-10-16-100000: script_versions become immutable execution definitions.
--
-- Today script_versions holds (id, script_id, version, content, changelog,
-- created_by, created_at) and is written by exactly one caller — the bundle
-- importer, as a BEFORE-image (services/scriptBundle/index.ts:780). Nothing
-- can say what language/timeout/run_as a past body ran under, (script_id,
-- version) is only a non-unique index, the FK to scripts has no ON DELETE
-- (so a GDPR org erasure of `scripts` would abort with 23503 the moment any
-- version row existed), and the 2026-10-01 RLS set permits UPDATE and DELETE,
-- so history is rewritable by any org that owns the script.
--
-- This migration makes a version row the complete, content-addressed
-- definition of one execution, and makes it append-only. See spec
-- docs/superpowers/specs/ai-mcp/2026-09-11-ai-script-authoring-and-review-design.md §4.1.
--
-- Order inside the file matters:
--   enum -> columns -> approved_by FK -> duplicate repair -> column backfill
--   -> NOT NULL -> head backfill -> unique -> parent FK swap -> policy drop
--   -> immutability trigger (LAST: it would abort the backfill UPDATEs above).
--
-- Writes rows, so breeze.scope is elected first: breeze_current_scope()
-- defaults to 'none' and script_versions is FORCE ROW LEVEL SECURITY, which
-- binds the owner too — without this the UPDATEs below match zero rows in
-- silence on managed Postgres and the INSERT aborts with 42501.
-- is_local = true scopes it to autoMigrate's per-file transaction.
-- autoMigrate wraps each file in a transaction — no inner BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

DO $$
BEGIN
  CREATE TYPE public.script_origin AS ENUM ('human', 'ai_proposal', 'imported', 'system');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

ALTER TABLE public.script_versions
  ADD COLUMN IF NOT EXISTS language         public.script_language,
  ADD COLUMN IF NOT EXISTS timeout_seconds  integer,
  ADD COLUMN IF NOT EXISTS run_as           public.script_run_as,
  ADD COLUMN IF NOT EXISTS parameters       jsonb,
  ADD COLUMN IF NOT EXISTS content_digest   char(64),
  ADD COLUMN IF NOT EXISTS origin           public.script_origin NOT NULL DEFAULT 'human',
  ADD COLUMN IF NOT EXISTS proposal_id      uuid,
  ADD COLUMN IF NOT EXISTS review_id        uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at      timestamp,
  ADD COLUMN IF NOT EXISTS approved_by      uuid,
  ADD COLUMN IF NOT EXISTS approved_at      timestamp,
  ADD COLUMN IF NOT EXISTS approval_method  text;

-- proposal_id / review_id are deliberately BARE uuids, not FKs: the referenced
-- rows are org-scoped and left for erasure on a merge (spec §5), so a hard FK
-- would either block erasure or drag version history with it.
DO $$
BEGIN
  ALTER TABLE public.script_versions
    ADD CONSTRAINT script_versions_approved_by_users_id_fk
    FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
```

- [ ] **Step 2: Append the duplicate repair, reported**

```sql
-- Repair before UNIQUE. Keep the oldest row in each (script_id, version)
-- group at its number and renumber the rest above the script's current max,
-- preserving history rather than deleting it. Counts are RAISEd even at zero:
-- a 0 here is the evidence that production had no duplicates, which the plan
-- (spec §10) explicitly asks to record.
DO $$
DECLARE
  dup_groups bigint;
  renumbered bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT count(*) INTO dup_groups
  FROM (
    SELECT script_id, version
    FROM public.script_versions
    GROUP BY script_id, version
    HAVING count(*) > 1
  ) d;
  RAISE WARNING 'script_versions: % duplicate (script_id, version) group(s) found', dup_groups;

  WITH ranked AS (
    SELECT id, script_id,
           row_number() OVER (PARTITION BY script_id, version ORDER BY created_at, id) AS rn
    FROM public.script_versions
  ),
  maxv AS (
    SELECT script_id, max(version) AS mv
    FROM public.script_versions
    GROUP BY script_id
  ),
  targets AS (
    SELECT r.id,
           m.mv + (row_number() OVER (PARTITION BY r.script_id ORDER BY r.id))::integer AS new_version
    FROM ranked r
    JOIN maxv m ON m.script_id = r.script_id
    WHERE r.rn > 1
  )
  UPDATE public.script_versions v
  SET version = t.new_version
  FROM targets t
  WHERE v.id = t.id;
  GET DIAGNOSTICS renumbered = ROW_COUNT;
  RAISE WARNING 'script_versions: renumbered % duplicate row(s)', renumbered;
END $$;
```

- [ ] **Step 3: Append the existing-row column backfill and `SET NOT NULL`**

```sql
-- Existing rows predate the definition columns. Their language/timeout/run_as
-- are unrecoverable for the body they hold, so they inherit the parent
-- script's CURRENT values — the honest best available, and the only rows this
-- ever applies to are bundle before-images. content_digest is derived from the
-- row's own content under the canonical form the TS helper uses
-- (services/scriptVersions.ts sha256Content): NFC, CRLF -> LF, no trimming.
DO $$
DECLARE
  filled bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE public.script_versions v
  SET language        = COALESCE(v.language, s.language),
      timeout_seconds = COALESCE(v.timeout_seconds, s.timeout_seconds),
      run_as          = COALESCE(v.run_as, s.run_as),
      parameters      = COALESCE(v.parameters, s.parameters),
      content_digest  = COALESCE(
        v.content_digest,
        encode(sha256(convert_to(normalize(replace(v.content, E'\r\n', E'\n'), NFC), 'UTF8')), 'hex')
      ),
      origin          = CASE WHEN s.is_system THEN 'system' ELSE 'human' END::public.script_origin
  FROM public.scripts s
  WHERE s.id = v.script_id
    AND (v.language IS NULL
      OR v.timeout_seconds IS NULL
      OR v.run_as IS NULL
      OR v.content_digest IS NULL);
  GET DIAGNOSTICS filled = ROW_COUNT;
  RAISE WARNING 'script_versions: backfilled definition columns on % pre-existing row(s)', filled;
END $$;

ALTER TABLE public.script_versions ALTER COLUMN language        SET NOT NULL;
ALTER TABLE public.script_versions ALTER COLUMN timeout_seconds SET NOT NULL;
ALTER TABLE public.script_versions ALTER COLUMN run_as          SET NOT NULL;
ALTER TABLE public.script_versions ALTER COLUMN content_digest  SET NOT NULL;
```

`parameters` stays nullable because `scripts.parameters` is nullable (`apps/api/src/db/schema/scripts.ts:41`).

- [ ] **Step 4: Append the head backfill, the UNIQUE constraint, and the parent-FK swap**

```sql
-- One version row per script whose CURRENT scripts.version has no row. Every
-- script predating this migration has none, so this is the row that makes
-- headScriptVersion() answerable for the whole existing library.
DO $$
DECLARE
  inserted bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO public.script_versions
    (script_id, version, content, language, timeout_seconds, run_as, parameters,
     content_digest, origin, changelog, created_by, created_at)
  SELECT s.id, s.version, s.content, s.language, s.timeout_seconds, s.run_as, s.parameters,
         encode(sha256(convert_to(normalize(replace(s.content, E'\r\n', E'\n'), NFC), 'UTF8')), 'hex'),
         CASE WHEN s.is_system THEN 'system' ELSE 'human' END::public.script_origin,
         'Backfilled head version (2026-10-16-100000)',
         s.created_by,
         s.created_at
  FROM public.scripts s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.script_versions v
    WHERE v.script_id = s.id AND v.version = s.version
  );
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RAISE WARNING 'script_versions: backfilled % head version row(s)', inserted;
END $$;

-- UNIQUE replaces the non-unique index (0001-baseline.sql:14337). Drop the
-- index first: the constraint's own index covers the same (script_id, version)
-- lookups, so keeping both would only duplicate write cost.
DROP INDEX IF EXISTS public.script_versions_script_id_version_idx;

DO $$
BEGIN
  ALTER TABLE public.script_versions
    ADD CONSTRAINT script_versions_script_id_version_key UNIQUE (script_id, version);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN
  NULL;
END $$;

-- The baseline FK has no ON DELETE, so it defaults to NO ACTION and a
-- `DELETE FROM scripts WHERE org_id = $1` during org erasure aborts with 23503
-- as soon as any version row exists. CASCADE is how a table with no org_id of
-- its own erases with its tenant (spec §5). Referential actions run with
-- force-RLS disabled, so the cascade still fires under the INSERT+SELECT-only
-- policy set installed below.
ALTER TABLE public.script_versions
  DROP CONSTRAINT IF EXISTS script_versions_script_id_scripts_id_fk;

DO $$
BEGIN
  ALTER TABLE public.script_versions
    ADD CONSTRAINT script_versions_script_id_scripts_id_fk
    FOREIGN KEY (script_id) REFERENCES public.scripts(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
```

- [ ] **Step 5: Append the policy reduction and the immutability trigger**

```sql
-- Reduce RLS to INSERT + SELECT. The SELECT and INSERT policies installed by
-- 2026-10-01-100000-script-children-rls.sql:73-90 are correct and are LEFT AS
-- THEY ARE; only the UPDATE (:91-103) and DELETE (:104-110) policies go. With
-- no policy for a command, FORCE ROW LEVEL SECURITY denies it for every role
-- including the owner and system scope — which is the point: version history
-- is append-only, and rows die only through the parent FK above.
--
-- IF EXISTS makes this idempotent, which is the pg_policies existence check in
-- statement form; a second run drops nothing and raises nothing.
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.script_versions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.script_versions;

-- Backstop for the paths RLS does not bind: a future migration, a replication
-- apply, or anyone connecting as a BYPASSRLS/superuser role. Fires on UPDATE
-- only — DELETE must stay possible for the FK cascade.
CREATE OR REPLACE FUNCTION public.breeze_script_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'script_versions rows are immutable (id=%); cut a new version instead', OLD.id
    USING ERRCODE = '42501';
END;
$fn$;

DROP TRIGGER IF EXISTS script_versions_immutable ON public.script_versions;
CREATE TRIGGER script_versions_immutable
  BEFORE UPDATE ON public.script_versions
  FOR EACH ROW EXECUTE FUNCTION public.breeze_script_versions_immutable();
```

- [ ] **Step 6: Apply the migration and run the Task 2 contract**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptVersionsImmutable.integration.test.ts
```
Expected: PASS (10 tests). The integration setup applies pending migrations before the suite.

- [ ] **Step 7: Run the migration guard suites**

```bash
cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
```
Expected: PASS. `migrationRlsScope.test.ts` must NOT report `2026-10-16-100000-script-versions-immutable.sql` as a new offender — the file's first statement is `SELECT set_config('breeze.scope', 'system', true);` and each `DO` block re-elects with `PERFORM set_config(...)` as its first statement. Never add this file to `UNSCOPED_DML_BASELINE`.

- [ ] **Step 8: Check the migration name still sorts last**

Run: `./scripts/check-migration-naming.sh --against-ref origin/main`
Expected: PASS. If it fails because `origin/main` gained a later migration, rename the file to sort after that one and update every reference to the old path before continuing.

- [ ] **Step 9: Commit**

```bash
git add apps/api/migrations/2026-10-16-100000-script-versions-immutable.sql
git commit -m "feat(db): script_versions become immutable execution definitions"
```

---

### Task 4: Teach `rls-coverage` that `script_versions` is append-only

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (the assertion at `:1748`, the fixture teardown at `:4598`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `APPEND_ONLY_PARENT_FK_TABLES` (a `ReadonlySet<string>` local to that file), consumed by the parent-FK coverage assertion.

Task 3 drops two policies that `rls-coverage.integration.test.ts:1748` currently demands. Its assertion ("all four DML commands covered by a parent-join org-access policy") is exactly right for ordinary FK children and exactly wrong for an append-only one, so the exemption is narrow, named, and justified in place rather than the assertion being loosened.

- [ ] **Step 1: Run the suite to see the expected red**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: FAIL with `Parent-FK join-policy tables missing RLS coverage: [{ "table": "script_versions", "rls_on": true, "missing_cmds": ["UPDATE", "DELETE"] }]`, plus a failure in the `script_versions / script_to_tags` describe's teardown/fixtures.

- [ ] **Step 2: Add the append-only allowlist next to `REQUIRED_CMDS`**

Insert immediately after the `const REQUIRED_CMDS = [...] as const;` declaration at `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:953`:

```ts
/**
 * Parent-FK children that are APPEND-ONLY by design and therefore carry only
 * SELECT + INSERT policies. With no policy for a command, FORCE ROW LEVEL
 * SECURITY denies it for every role including the owner — that absence is the
 * control, so demanding four commands here would demand the bug back.
 *
 * script_versions (2026-10-16-100000-script-versions-immutable.sql): a version
 * row is the immutable definition of an execution (spec §4.1). It is never
 * updated, and it dies only through `script_id ... ON DELETE CASCADE`, which
 * Postgres runs with force-RLS disabled.
 *
 * Adding a table here requires the absence of UPDATE/DELETE policies to be
 * PROVEN behaviourally, not merely declared — see
 * scriptVersionsImmutable.integration.test.ts.
 */
const APPEND_ONLY_PARENT_FK_TABLES: ReadonlySet<string> = new Set<string>(['script_versions']);

/** Commands a parent-FK child must cover, given whether it is append-only. */
function requiredCmdsFor(table: string): readonly string[] {
  return APPEND_ONLY_PARENT_FK_TABLES.has(table)
    ? (['SELECT', 'INSERT'] as const)
    : REQUIRED_CMDS;
}
```

- [ ] **Step 3: Use it in the parent-FK coverage assertion**

In the `it('every parent-FK join-policy table has RLS on and all four DML commands covered by a parent-join org-access policy', ...)` block, replace the line at `:1795`:

```ts
      const missing = REQUIRED_CMDS.filter((cmd) => !covered.has(cmd));
```

with:

```ts
      const missing = requiredCmdsFor(table).filter((cmd) => !covered.has(cmd));
```

and additionally assert the exemption is not silently over-granted — append it inside the same `for` loop, right after the `missing` computation:

```ts
      // An append-only table must have NO update/delete policy at all. If one
      // reappears, the exemption is stale and must be removed, not honoured.
      if (APPEND_ONLY_PARENT_FK_TABLES.has(table)) {
        const surplus = ['UPDATE', 'DELETE'].filter((cmd) => covered.has(cmd));
        if (surplus.length > 0) {
          offenders.push({ table, rls_on: Boolean(row?.rls_on), missing_cmds: surplus.map((c) => `unexpected:${c}`) });
        }
      }
```

- [ ] **Step 4: Fix the fixture teardown, which can no longer delete versions**

In the `script_versions / script_to_tags` describe's `afterAll`, delete the now-impossible statement at `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:4599`:

```ts
      await db.delete(scriptVersions).where(inArray(scriptVersions.scriptId, scriptIds));
```

and replace it with a comment where it stood:

```ts
      // script_versions rows are append-only as of
      // 2026-10-16-100000-script-versions-immutable.sql — there is no DELETE
      // policy, so an explicit delete matches zero rows even under system
      // scope. The `delete(scripts)` below reaps them through
      // script_versions_script_id_scripts_id_fk ON DELETE CASCADE.
```

Confirm the `scripts` delete still runs after `script_to_tags`; if `inArray` becomes unused in the file, remove it from the drizzle import.

- [ ] **Step 5: Re-run the suite**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS, with the `script_versions` forge tests (`:4642`, `:4672`, `:4691`) still green — the cross-org UPDATE/DELETE at `:4691` still returns zero rows, now because no policy exists rather than because the policy excluded org B1.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(api): register script_versions as an append-only parent-FK child"
```

---

### Task 5: Drizzle schema and drift check

**Files:**
- Modify: `apps/api/src/db/schema/scripts.ts:104-115`
- Test: `apps/api/src/db/schema/scripts.scriptVersions.test.ts` (create)

**Interfaces:**
- Consumes: `ScriptOrigin`, `ScriptApprovalMethod` from `@breeze/shared` (Task 1).
- Produces: `scriptOriginEnum`, the widened `scriptVersions` table object. Tasks 7–14 read `typeof scriptVersions.$inferSelect`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/schema/scripts.scriptVersions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scriptVersions, scriptOriginEnum } from './scripts';

describe('scriptVersions schema', () => {
  const config = getTableConfig(scriptVersions);
  const byName = new Map(config.columns.map((c) => [c.name, c]));

  it('declares the script_origin enum values in pg order', () => {
    expect(scriptOriginEnum.enumValues).toEqual(['human', 'ai_proposal', 'imported', 'system']);
  });

  it('carries the execution-definition columns as NOT NULL', () => {
    for (const name of ['language', 'timeout_seconds', 'run_as', 'content_digest', 'origin']) {
      expect(byName.get(name), `missing column ${name}`).toBeDefined();
      expect(byName.get(name)!.notNull, `${name} must be NOT NULL`).toBe(true);
    }
  });

  it('carries the nullable provenance columns', () => {
    for (const name of ['proposal_id', 'review_id', 'reviewed_at', 'approved_by', 'approved_at', 'approval_method', 'parameters']) {
      expect(byName.get(name), `missing column ${name}`).toBeDefined();
      expect(byName.get(name)!.notNull, `${name} must be nullable`).toBe(false);
    }
  });

  it('declares the unique (script_id, version) constraint', () => {
    const uniqueNames = config.uniqueConstraints.map((u) => u.name);
    expect(uniqueNames).toContain('script_versions_script_id_version_key');
  });

  it('cascades from the parent script', () => {
    const fk = config.foreignKeys.find((f) => f.reference().foreignTable === undefined ? false : true);
    const scriptFk = config.foreignKeys.find((f) => f.reference().columns.some((c) => c.name === 'script_id'));
    expect(fk).toBeDefined();
    expect(scriptFk?.onDelete).toBe('cascade');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/scripts.scriptVersions.test.ts`
Expected: FAIL — `scriptOriginEnum` is not exported and `language` is missing from the column map.

- [ ] **Step 3: Update the schema**

In `apps/api/src/db/schema/scripts.ts`, add `char` and `unique` to the `drizzle-orm/pg-core` import on line 2, and `ScriptApprovalMethod`/`ScriptOrigin` to the `@breeze/shared` type import on line 3:

```ts
import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, numeric, index, unique, char, primaryKey, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { ScriptApprovalMethod, ScriptOrigin, ScriptParameterDefinition } from '@breeze/shared';
```

Add the enum beside the others (after line 9):

```ts
// 2026-10-16-100000-script-versions-immutable.sql. The birth record of a
// version row: who or what produced this exact body.
export const scriptOriginEnum = pgEnum('script_origin', ['human', 'ai_proposal', 'imported', 'system']);
```

Replace the whole `scriptVersions` table (lines 104-115) with:

```ts
/**
 * An IMMUTABLE, content-addressed definition of one script execution.
 *
 * Append-only by construction: the table carries SELECT + INSERT RLS policies
 * only, plus a BEFORE UPDATE trigger, and rows die solely through the parent's
 * ON DELETE CASCADE (2026-10-16-100000-script-versions-immutable.sql). The one
 * writer is services/scriptVersions.ts `cutScriptVersion` — enforced by
 * services/scriptVersions.writers.contract.test.ts. Do not insert here directly.
 */
export const scriptVersions = pgTable('script_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  scriptId: uuid('script_id').notNull().references(() => scripts.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  content: text('content').notNull(),
  // The full run definition, snapshotted at cut time, so readers never have to
  // join `scripts` to learn what a past body actually ran as.
  language: scriptLanguageEnum('language').notNull(),
  timeoutSeconds: integer('timeout_seconds').notNull(),
  runAs: scriptRunAsEnum('run_as').notNull(),
  // Parameter DEFINITIONS, same contract as `scripts.parameters` above.
  parameters: jsonb('parameters').$type<ScriptParameterDefinition[]>(),
  // sha256 of the canonical content (NFC, CRLF -> LF, no trimming). The SQL
  // twin of services/scriptVersions.ts `sha256Content` — change both or
  // neither.
  contentDigest: char('content_digest', { length: 64 }).notNull(),
  origin: scriptOriginEnum('origin').notNull().default('human'),
  // Provenance. Bare uuids, not FKs: proposals and reviews are org-scoped and
  // left for erasure on a merge (spec §5), so a hard FK would either block
  // erasure or drag history with it. A stale id simply matches nothing and the
  // UI renders "review evidence erased".
  proposalId: uuid('proposal_id'),
  reviewId: uuid('review_id'),
  reviewedAt: timestamp('reviewed_at'),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at'),
  approvalMethod: text('approval_method').$type<ScriptApprovalMethod>(),
  changelog: text('changelog'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  scriptIdIdx: index('script_versions_script_id_idx').on(table.scriptId),
  scriptIdVersionKey: unique('script_versions_script_id_version_key').on(table.scriptId, table.version)
}));

export type ScriptVersionRow = typeof scriptVersions.$inferSelect;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/db/schema/scripts.scriptVersions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify no drift between schema and migrations**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"   # or the test-stack URL from .env.test
pnpm db:check-drift
```
Expected: no drift reported. A `char` vs `varchar` or a missing `unique` is the usual first complaint — fix the schema, not the shipped migration.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/scripts.ts apps/api/src/db/schema/scripts.scriptVersions.test.ts
git commit -m "feat(db): drizzle schema for immutable script_versions"
```

---

### Task 6: `sha256Content`

**Files:**
- Create: `apps/api/src/services/scriptVersions.ts`
- Create: `apps/api/src/services/scriptVersions.test.ts`

**Interfaces:**
- Consumes: `node:crypto`.
- Produces: `sha256Content(content: string): string` — roadmap §3.2. Consumed by Task 7 and by W01b's proposal digest.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/scriptVersions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Content } from './scriptVersions';

function rawSha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('sha256Content', () => {
  it('returns a 64-char lowercase hex digest', () => {
    expect(sha256Content('Write-Host "hi"')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats CRLF and LF line endings as the same content', () => {
    expect(sha256Content('a\r\nb\r\nc')).toBe(sha256Content('a\nb\nc'));
  });

  it('treats NFD and NFC forms of the same text as identical', () => {
    // "é" as U+00E9 vs "e" + U+0301
    expect(sha256Content('café')).toBe(sha256Content('café'));
  });

  it('does NOT trim — trailing whitespace is part of the content', () => {
    expect(sha256Content('echo hi')).not.toBe(sha256Content('echo hi  '));
  });

  it('agrees with a plain sha256 of the already-canonical form', () => {
    expect(sha256Content('a\nb')).toBe(rawSha('a\nb'));
  });

  it('distinguishes a lone CR from a newline (only CRLF is folded)', () => {
    expect(sha256Content('a\rb')).not.toBe(sha256Content('a\nb'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/scriptVersions.test.ts`
Expected: FAIL — `Failed to resolve import "./scriptVersions"`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/scriptVersions.ts`:

```ts
/**
 * The ONE writer of `script_versions` (spec §4.1, roadmap §3.2).
 *
 * A version row is an immutable, content-addressed definition of one
 * execution: content plus language, timeout, run context, parameter
 * definitions and a digest, so nothing downstream has to join `scripts` to
 * learn what a past body ran as. Every material change to a script cuts one.
 *
 * Enforced by scriptVersions.writers.contract.test.ts — no other file in
 * apps/api may INSERT into scriptVersions.
 */
import { createHash } from 'node:crypto';

/**
 * Canonical form for hashing: Unicode NFC, CRLF folded to LF, nothing trimmed.
 *
 * The SQL twin lives in 2026-10-16-100000-script-versions-immutable.sql as
 * `encode(sha256(convert_to(normalize(replace(content, E'\r\n', E'\n'), NFC),
 * 'UTF8')), 'hex')`. Trailing whitespace is deliberately significant — in
 * PowerShell a trailing backtick is a line continuation, so trimming would
 * make two materially different scripts hash the same.
 */
export function sha256Content(content: string): string {
  const canonical = content.normalize('NFC').replace(/\r\n/g, '\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/scriptVersions.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/scriptVersions.ts apps/api/src/services/scriptVersions.test.ts
git commit -m "feat(api): canonical script content digest"
```

---

### Task 7: `cutScriptVersion` and `headScriptVersion`

**Files:**
- Modify: `apps/api/src/services/scriptVersions.ts`
- Modify: `apps/api/src/services/scriptVersions.test.ts`

**Interfaces:**
- Consumes: `sha256Content` (Task 6); `scripts`, `scriptVersions`, `ScriptVersionRow` from `../db/schema` (Task 5); `ScriptOrigin`, `ScriptApprovalMethod` from `@breeze/shared` (Task 1).
- Produces, exactly as roadmap §3.2 names them:
  - `export type ScriptVersionTx = Parameters<Parameters<typeof db.transaction>[0]>[0]`
  - `export interface ScriptVersionProvenance { origin: ScriptOrigin; proposalId?: string | null; reviewId?: string | null; reviewedAt?: Date | null; approvedBy?: string | null; approvedAt?: Date | null; approvalMethod?: ScriptApprovalMethod | null; changelog?: string | null; createdBy: string | null }`
  - `export function cutScriptVersion(tx: ScriptVersionTx, args: { scriptId: string; provenance: ScriptVersionProvenance }): Promise<ScriptVersionRow>`
  - `export function headScriptVersion(executor: ScriptVersionExecutor, scriptId: string): Promise<ScriptVersionRow | null>`
  - `export class ScriptVersionCutError extends Error`

  Tasks 9–14 call `cutScriptVersion`; W01b/W03 call all four.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/scriptVersions.test.ts`. Put the `vi.mock` and the imports it needs at the TOP of the file, above the existing `sha256Content` import:

```ts
import { vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  scriptRow: null as Record<string, unknown> | null,
  forUpdateCalled: false,
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('../db', () => ({
  db: {
    transaction: vi.fn(),
    select: vi.fn(),
  },
}));

function buildTx() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          for: vi.fn((mode: string) => {
            h.forUpdateCalled = mode === 'update';
            return { limit: vi.fn(() => Promise.resolve(h.scriptRow ? [h.scriptRow] : [])) };
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        h.updates.push(values);
        return { where: vi.fn(() => Promise.resolve(undefined)) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        h.inserts.push(values);
        return { returning: vi.fn(() => Promise.resolve([{ id: 'version-row', ...values }])) };
      }),
    })),
  };
}
```

Then append these tests at the end of the file:

```ts
import { cutScriptVersion, ScriptVersionCutError } from './scriptVersions';

const SCRIPT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  h.scriptRow = {
    id: SCRIPT_ID,
    version: 4,
    content: 'Write-Host "after"\r\n',
    language: 'powershell',
    timeoutSeconds: 600,
    runAs: 'elevated',
    parameters: [{ name: 'Target', type: 'string' }],
  };
  h.forUpdateCalled = false;
  h.updates = [];
  h.inserts = [];
});

describe('cutScriptVersion', () => {
  it('locks the script row FOR UPDATE before reading it', async () => {
    await cutScriptVersion(buildTx() as never, {
      scriptId: SCRIPT_ID,
      provenance: { origin: 'human', createdBy: USER_ID },
    });
    expect(h.forUpdateCalled).toBe(true);
  });

  it('increments scripts.version and snapshots the AFTER image at the new number', async () => {
    const row = await cutScriptVersion(buildTx() as never, {
      scriptId: SCRIPT_ID,
      provenance: { origin: 'human', createdBy: USER_ID },
    });
    expect(h.updates[0]).toMatchObject({ version: 5 });
    expect(h.inserts[0]).toMatchObject({
      scriptId: SCRIPT_ID,
      version: 5,
      content: 'Write-Host "after"\r\n',
      language: 'powershell',
      timeoutSeconds: 600,
      runAs: 'elevated',
    });
    expect(row.version).toBe(5);
  });

  it('stores the canonical digest of the content it snapshotted', async () => {
    await cutScriptVersion(buildTx() as never, {
      scriptId: SCRIPT_ID,
      provenance: { origin: 'human', createdBy: USER_ID },
    });
    expect(h.inserts[0]!.contentDigest).toBe(sha256Content('Write-Host "after"\r\n'));
  });

  it('carries the full provenance onto the row', async () => {
    const reviewedAt = new Date('2026-09-11T10:00:00Z');
    const approvedAt = new Date('2026-09-11T10:05:00Z');
    await cutScriptVersion(buildTx() as never, {
      scriptId: SCRIPT_ID,
      provenance: {
        origin: 'ai_proposal',
        proposalId: '33333333-3333-4333-8333-333333333333',
        reviewId: '44444444-4444-4444-8444-444444444444',
        reviewedAt,
        approvedBy: USER_ID,
        approvedAt,
        approvalMethod: 'four_eyes',
        changelog: 'Approved proposal',
        createdBy: USER_ID,
      },
    });
    expect(h.inserts[0]).toMatchObject({
      origin: 'ai_proposal',
      proposalId: '33333333-3333-4333-8333-333333333333',
      reviewId: '44444444-4444-4444-8444-444444444444',
      reviewedAt,
      approvedBy: USER_ID,
      approvedAt,
      approvalMethod: 'four_eyes',
      changelog: 'Approved proposal',
      createdBy: USER_ID,
    });
  });

  it('defaults every optional provenance field to null rather than undefined', async () => {
    await cutScriptVersion(buildTx() as never, {
      scriptId: SCRIPT_ID,
      provenance: { origin: 'system', createdBy: null },
    });
    expect(h.inserts[0]).toMatchObject({
      proposalId: null,
      reviewId: null,
      reviewedAt: null,
      approvedBy: null,
      approvedAt: null,
      approvalMethod: null,
      changelog: null,
      createdBy: null,
    });
  });

  it('throws ScriptVersionCutError when the script row is not visible', async () => {
    h.scriptRow = null;
    await expect(
      cutScriptVersion(buildTx() as never, {
        scriptId: SCRIPT_ID,
        provenance: { origin: 'human', createdBy: USER_ID },
      })
    ).rejects.toBeInstanceOf(ScriptVersionCutError);
  });

  it('takes a freshly-created script from version 0 to version 1', async () => {
    h.scriptRow = { ...h.scriptRow, version: 0 };
    const row = await cutScriptVersion(buildTx() as never, {
      scriptId: SCRIPT_ID,
      provenance: { origin: 'human', createdBy: USER_ID },
    });
    expect(row.version).toBe(1);
    expect(h.updates[0]).toMatchObject({ version: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/scriptVersions.test.ts`
Expected: FAIL — `cutScriptVersion is not a function` / no export `ScriptVersionCutError`.

- [ ] **Step 3: Write the implementation**

Append to `apps/api/src/services/scriptVersions.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import type { ScriptApprovalMethod, ScriptOrigin } from '@breeze/shared';
import { db } from '../db';
import { scripts, scriptVersions, type ScriptVersionRow } from '../db/schema';

export type { ScriptVersionRow };

/** The Drizzle transaction handle every writer already has in hand. */
export type ScriptVersionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Read-side executor: the pooled db or a transaction. */
export type ScriptVersionExecutor = typeof db | ScriptVersionTx;

export interface ScriptVersionProvenance {
  origin: ScriptOrigin;
  proposalId?: string | null;
  reviewId?: string | null;
  reviewedAt?: Date | null;
  approvedBy?: string | null;
  approvedAt?: Date | null;
  approvalMethod?: ScriptApprovalMethod | null;
  changelog?: string | null;
  createdBy: string | null;
}

/** Raised when the script row is gone, soft-deleted out of view, or invisible
 *  under RLS, so there is nothing to cut a version from. Callers surface it as
 *  a 404, never as a silent skip. */
export class ScriptVersionCutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptVersionCutError';
  }
}

/**
 * Cut the next immutable version of a script.
 *
 * Contract: the caller has ALREADY written whatever it is changing onto the
 * `scripts` row inside `tx` and has NOT touched `scripts.version`. This helper
 * then locks the row `FOR UPDATE`, increments `version`, and snapshots the
 * AFTER image at the new number. Two concurrent saves serialise on the lock
 * rather than racing to the same version number (which `UNIQUE (script_id,
 * version)` would otherwise turn into a 23505 for the loser).
 *
 * On the create path the caller inserts the script with `version: 0` inside
 * the same transaction; this call moves it to 1 and cuts v1. Version 0 is
 * therefore never observable outside the creating transaction.
 *
 * Must run inside the caller's transaction: a failure after the `scripts`
 * update must not leave a bumped version with no row behind it.
 */
export async function cutScriptVersion(
  tx: ScriptVersionTx,
  args: { scriptId: string; provenance: ScriptVersionProvenance }
): Promise<ScriptVersionRow> {
  const [locked] = await tx
    .select({
      id: scripts.id,
      version: scripts.version,
      content: scripts.content,
      language: scripts.language,
      timeoutSeconds: scripts.timeoutSeconds,
      runAs: scripts.runAs,
      parameters: scripts.parameters,
    })
    .from(scripts)
    .where(eq(scripts.id, args.scriptId))
    .for('update')
    .limit(1);

  if (!locked) {
    throw new ScriptVersionCutError(`script ${args.scriptId} not found or not writable`);
  }

  const nextVersion = locked.version + 1;
  const p = args.provenance;

  await tx
    .update(scripts)
    .set({ version: nextVersion, updatedAt: new Date() })
    .where(eq(scripts.id, args.scriptId));

  const [row] = await tx
    .insert(scriptVersions)
    .values({
      scriptId: args.scriptId,
      version: nextVersion,
      content: locked.content,
      language: locked.language,
      timeoutSeconds: locked.timeoutSeconds,
      runAs: locked.runAs,
      parameters: locked.parameters ?? null,
      contentDigest: sha256Content(locked.content),
      origin: p.origin,
      // Explicit nulls, not undefined: an undefined would let Drizzle omit the
      // column and silently inherit a default that does not exist here.
      proposalId: p.proposalId ?? null,
      reviewId: p.reviewId ?? null,
      reviewedAt: p.reviewedAt ?? null,
      approvedBy: p.approvedBy ?? null,
      approvedAt: p.approvedAt ?? null,
      approvalMethod: p.approvalMethod ?? null,
      changelog: p.changelog ?? null,
      createdBy: p.createdBy ?? null,
    })
    .returning();

  if (!row) {
    throw new ScriptVersionCutError(`failed to insert version ${nextVersion} for script ${args.scriptId}`);
  }
  return row;
}

/** The version row matching the script's CURRENT `scripts.version`. There is
 *  deliberately no `scripts.head_version_id` column — it would close a
 *  scripts <-> script_versions FK cycle that `tenantCascade` rejects. */
export async function headScriptVersion(
  executor: ScriptVersionExecutor,
  scriptId: string
): Promise<ScriptVersionRow | null> {
  const rows = await executor
    .select({ version: scriptVersions })
    .from(scriptVersions)
    .innerJoin(scripts, eq(scripts.id, scriptVersions.scriptId))
    .where(and(eq(scriptVersions.scriptId, scriptId), eq(scriptVersions.version, scripts.version)))
    .limit(1);
  return rows[0]?.version ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/scriptVersions.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors in `src/services/scriptVersions.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/scriptVersions.ts apps/api/src/services/scriptVersions.test.ts
git commit -m "feat(api): cutScriptVersion and headScriptVersion"
```

---

### Task 8: Single-writer contract test with a shrinking allowlist

**Files:**
- Create: `apps/api/src/services/scriptVersions.writers.contract.test.ts`

**Interfaces:**
- Consumes: nothing at runtime — it reads source text, in the style of `apps/api/src/services/aiGuardrails.imports.contract.test.ts`.
- Produces: `PENDING_CONVERSION` — the allowlist Tasks 9–14 each shrink by exactly one entry. When it is empty, the last conversion is done.

- [ ] **Step 1: Write the test with the allowlist at full size**

Create `apps/api/src/services/scriptVersions.writers.contract.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * services/scriptVersions.ts is the ONLY writer of `script_versions` (spec
 * §4.1, roadmap §3.2). A second insert path is how a version row lands without
 * a digest, without a provenance record, or at a number that races the head —
 * and the table is append-only, so a bad row cannot be repaired afterwards.
 *
 * Style follows aiGuardrails.imports.contract.test.ts: read the source, assert
 * on the text. No import graph is loaded, so a partial db/schema mock in some
 * other suite cannot make this vacuous.
 *
 * PENDING_CONVERSION is a RATCHET, not a permanent exemption. It lists the
 * legacy writers W01a converts one task at a time. Entries are only ever
 * REMOVED. If you are adding one, you are adding a second writer — don't.
 */
const API_SRC = fileURLToPath(new URL('..', import.meta.url));

const SOLE_WRITER = 'services/scriptVersions.ts';

const PENDING_CONVERSION: ReadonlySet<string> = new Set<string>([
  'services/scriptBundle/index.ts',
]);

/** Files that may legitimately reference the table without inserting into it:
 *  tests, and the schema module that defines it. */
function isExempt(rel: string): boolean {
  return (
    rel.endsWith('.test.ts') ||
    rel.startsWith('__tests__' + sep) ||
    rel === 'db/schema/scripts.ts' ||
    rel === SOLE_WRITER
  );
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('script_versions has exactly one writer', () => {
  const offenders = listTsFiles(API_SRC)
    .map((full) => ({ rel: relative(API_SRC, full).split(sep).join('/'), full }))
    .filter(({ rel }) => !isExempt(rel.split('/').join(sep)))
    .filter(({ full }) => /\.insert\(\s*scriptVersions\s*\)/.test(readFileSync(full, 'utf8')))
    .map(({ rel }) => rel);

  it('no file outside services/scriptVersions.ts inserts into scriptVersions', () => {
    const unexpected = offenders.filter((rel) => !PENDING_CONVERSION.has(rel));
    expect(
      unexpected,
      `These files insert into script_versions directly. Call cutScriptVersion(tx, { scriptId, provenance }) ` +
        `from services/scriptVersions.ts instead:\n${JSON.stringify(unexpected, null, 2)}`
    ).toEqual([]);
  });

  it('the conversion ratchet has no stale entries', () => {
    const stale = [...PENDING_CONVERSION].filter((rel) => !offenders.includes(rel));
    expect(
      stale,
      `PENDING_CONVERSION lists files that no longer insert into script_versions. ` +
        `Remove them — the list only ever shrinks:\n${JSON.stringify(stale, null, 2)}`
    ).toEqual([]);
  });

  it('services/scriptVersions.ts really does insert (guards against a vacuous scan)', () => {
    const src = readFileSync(join(API_SRC, SOLE_WRITER), 'utf8');
    expect(src).toMatch(/\.insert\(\s*scriptVersions\s*\)/);
  });
});
```

Note the allowlist starts with only `services/scriptBundle/index.ts`: it is the *only* file that inserts into `scriptVersions` today (verified by `grep -rn "insert(scriptVersions)" apps/api/src` → `services/scriptBundle/index.ts:780`). The other six writers create or update `scripts` without ever touching versions; Tasks 9–14 add their `cutScriptVersion` calls, and their own per-writer tests are what prove those conversions.

- [ ] **Step 2: Run the test to verify it passes and is NOT vacuous**

Run: `cd apps/api && npx vitest run src/services/scriptVersions.writers.contract.test.ts`
Expected: PASS (3 tests).

Now prove the control actually discriminates. Temporarily add this line inside `apps/api/src/services/scriptClone.ts` (anywhere in the module body), re-run, and confirm it goes RED naming `services/scriptClone.ts`:

```ts
const _contractProbe = () => db.insert(scriptVersions);
```

Then **remove the probe line** and re-run to confirm green again. Do not commit the probe.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/scriptVersions.writers.contract.test.ts
git commit -m "test(api): contract — scriptVersions.ts is the sole writer of script_versions"
```

---

### Task 9: `scriptWrite.insertScriptRow` cuts v1

**Files:**
- Modify: `apps/api/src/services/scriptWrite.ts:201-245`
- Test: `apps/api/src/services/scriptWrite.test.ts`

**Interfaces:**
- Consumes: `cutScriptVersion`, `ScriptVersionTx` (Task 7); `ScriptOrigin` (Task 1).
- Produces: `ScriptInsertOptions = { requestedIsSystem?: boolean; origin?: ScriptOrigin }` — the third parameter of `insertScriptRow`, used by Task 13's bundle importer to pass `origin: 'imported'`. `insertScriptRow` still returns the `scripts` row, now with `version: 1`.

- [ ] **Step 1: Write the failing test**

Replace the `vi.mock('../db', …)` factory at the top of `apps/api/src/services/scriptWrite.test.ts` (lines 11-20) with one that also exposes a transaction, and record cut calls:

```ts
const h = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  cuts: [] as Array<{ scriptId: string; provenance: Record<string, unknown> }>
}));

vi.mock('../db', () => {
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        h.inserts.push(values);
        return { returning: vi.fn(() => Promise.resolve([{ id: 'new-script', ...values }])) };
      })
    }))
  };
  return {
    db: {
      insert: tx.insert,
      transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx))
    }
  };
});

vi.mock('./scriptVersions', () => ({
  cutScriptVersion: vi.fn((_tx: unknown, args: { scriptId: string; provenance: Record<string, unknown> }) => {
    h.cuts.push(args);
    return Promise.resolve({ id: 'version-row', scriptId: args.scriptId, version: 1 });
  })
}));
```

Update the `beforeEach` to reset `h.cuts = []` as well, and append these tests:

```ts
describe('insertScriptRow cuts version 1', () => {
  it('inserts the script at version 0 so cutScriptVersion moves it to 1', async () => {
    await insertScriptRow(
      { scope: 'organization', user: { id: '55555555-5555-4555-8555-555555555555' } } as never,
      { orgId: ORG_ID, partnerId: PARTNER_ID },
      input
    );
    expect(h.inserts[0]).toMatchObject({ version: 0 });
  });

  it('cuts exactly one version for the new script', async () => {
    const created = await insertScriptRow(
      { scope: 'organization', user: { id: '55555555-5555-4555-8555-555555555555' } } as never,
      { orgId: ORG_ID, partnerId: PARTNER_ID },
      input
    );
    expect(h.cuts).toHaveLength(1);
    expect(h.cuts[0]!.scriptId).toBe(created.id);
    expect(h.cuts[0]!.provenance).toMatchObject({
      origin: 'human',
      createdBy: '55555555-5555-4555-8555-555555555555'
    });
  });

  it('returns the script at version 1, not the raw version-0 insert', async () => {
    const created = await insertScriptRow(
      { scope: 'organization', user: { id: '55555555-5555-4555-8555-555555555555' } } as never,
      { orgId: ORG_ID, partnerId: PARTNER_ID },
      input
    );
    expect(created.version).toBe(1);
  });

  it('stamps origin=system for a system-scope isSystem insert', async () => {
    await insertScriptRow(
      { scope: 'system', user: { id: '55555555-5555-4555-8555-555555555555' } } as never,
      { orgId: null, partnerId: null },
      input,
      { requestedIsSystem: true }
    );
    expect(h.cuts[0]!.provenance).toMatchObject({ origin: 'system' });
  });

  it('honours an explicit origin override from the bundle importer', async () => {
    await insertScriptRow(
      { scope: 'organization', user: { id: '55555555-5555-4555-8555-555555555555' } } as never,
      { orgId: ORG_ID, partnerId: PARTNER_ID },
      input,
      { origin: 'imported' }
    );
    expect(h.cuts[0]!.provenance).toMatchObject({ origin: 'imported' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/scriptWrite.test.ts`
Expected: FAIL — the new tests report `version: 1` on the insert (not 0) and `h.cuts` is empty.

- [ ] **Step 3: Write the implementation**

In `apps/api/src/services/scriptWrite.ts`, add to the imports:

```ts
import type { ScriptOrigin } from '@breeze/shared';
import { cutScriptVersion } from './scriptVersions';
```

Replace the `insertScriptRow` signature and body (`:201-245`) with:

```ts
export type ScriptInsertOptions = {
  requestedIsSystem?: boolean;
  /** Birth record for the version row this insert cuts. Defaults to 'system'
   *  for a clamped system script and 'human' otherwise; the bundle importer
   *  passes 'imported'. */
  origin?: ScriptOrigin;
};

export async function insertScriptRow(
  auth: Pick<AuthContext, 'scope' | 'user'>,
  scope: ScriptCreateScope,
  input: ScriptInsertInput,
  opts: ScriptInsertOptions = {}
) {
  const isSystem = auth.scope === 'system' ? (opts.requestedIsSystem ?? false) : false;

  const acknowledgement = resolveScriptSecurityAcknowledgement({
    content: input.content,
    submitted: input.acknowledgedSecurityPatterns,
  });

  // The row and its v1 version are one unit of work: a create that left no
  // version behind would make headScriptVersion() null for a live script, and
  // script_versions is append-only so it could not be repaired afterwards.
  //
  // `version: 0` is transient — cutScriptVersion locks the row, moves it to 1,
  // and snapshots it. Nothing outside this transaction ever sees 0.
  return db.transaction(async (tx) => {
    const [script] = await tx
      .insert(scripts)
      .values({
        orgId: isSystem && !scope.orgId ? null : scope.orgId,
        partnerId: scope.partnerId,
        name: input.name,
        description: input.description ?? undefined,
        category: input.category ?? undefined,
        osTypes: input.osTypes,
        language: input.language,
        content: input.content,
        parameters: input.parameters,
        timeoutSeconds: input.timeoutSeconds,
        runAs: input.runAs,
        isSystem,
        version: 0,
        exitCodeSeverityMapping: input.exitCodeSeverityMapping ?? null,
        acknowledgedSecurityPatterns: acknowledgement.acknowledged,
        securityAcknowledgedBy: acknowledgement.acknowledged.length > 0 ? auth.user.id : null,
        securityAcknowledgedAt: acknowledgement.acknowledged.length > 0 ? new Date() : null,
        createdBy: auth.user.id
      })
      .returning();

    if (!script) {
      throw new Error('Script insert returned no row');
    }

    const cut = await cutScriptVersion(tx, {
      scriptId: script.id,
      provenance: {
        origin: opts.origin ?? (isSystem ? 'system' : 'human'),
        changelog: 'Initial version',
        createdBy: auth.user.id
      }
    });

    return { ...script, version: cut.version };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/scriptWrite.test.ts`
Expected: PASS, including the pre-existing scope-resolution tests.

- [ ] **Step 5: Run the suites that consume `insertScriptRow`**

Run: `cd apps/api && npx vitest run src/routes/scripts.test.ts src/services/scriptBundle`
Expected: PASS. If a `scriptBundle` unit test mocks `db` without `transaction`, add `transaction: vi.fn((fn) => fn(txMock))` to its mock factory — do not weaken the implementation.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/scriptWrite.ts apps/api/src/services/scriptWrite.test.ts
git commit -m "feat(api): insertScriptRow cuts version 1"
```

---

### Task 10: `PUT /scripts/:id` cuts a version on every material change

**Files:**
- Modify: `apps/api/src/routes/scripts.ts:730` (the `scriptRoutes.put` handler), specifically `:864-914` and `:950-963`
- Test: `apps/api/src/routes/scripts.test.ts`

**Interfaces:**
- Consumes: `cutScriptVersion` (Task 7).
- Produces: no new exports. Behavioural contract for later waves: a PUT that changes `content`, `parameters`, `language`, `timeoutSeconds`, **or** `runAs` bumps `scripts.version` by exactly one and cuts one version row with `origin: 'human'`; a metadata-only PUT bumps nothing.

Today the version bump covers content and parameters only (`:873-914`); the spec's as-built row records that "language/timeout/runAs changes do not bump", which is the gap this task closes — those three are part of what a run consumes.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/scripts.test.ts` (match the file's existing mock/helper conventions — read the first 80 lines before writing):

```ts
describe('PUT /scripts/:id version cutting', () => {
  it.each([
    ['content', { content: 'Write-Host "changed"' }],
    ['parameters', { parameters: [{ name: 'Target', type: 'string', required: false, source: 'manual' }] }],
    ['language', { language: 'bash' }],
    ['timeoutSeconds', { timeoutSeconds: 900 }],
    ['runAs', { runAs: 'user' }]
  ])('cuts exactly one version when %s changes', async (_field, body) => {
    h.cuts = [];
    const res = await app.request(`/scripts/${SCRIPT_ID}`, {
      method: 'PUT',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(body)
    });
    expect(res.status).toBe(200);
    expect(h.cuts).toHaveLength(1);
    expect(h.cuts[0]!.provenance).toMatchObject({ origin: 'human' });
  });

  it('does not cut a version for a metadata-only edit', async () => {
    h.cuts = [];
    const res = await app.request(`/scripts/${SCRIPT_ID}`, {
      method: 'PUT',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ description: 'new description' })
    });
    expect(res.status).toBe(200);
    expect(h.cuts).toEqual([]);
  });

  it('never sets scripts.version itself — cutScriptVersion owns the bump', async () => {
    h.updates = [];
    await app.request(`/scripts/${SCRIPT_ID}`, {
      method: 'PUT',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ content: 'Write-Host "changed"' })
    });
    expect(h.updates.some((u) => 'version' in u)).toBe(false);
  });

  it('returns the post-cut version number in the response body', async () => {
    const res = await app.request(`/scripts/${SCRIPT_ID}`, {
      method: 'PUT',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ content: 'Write-Host "changed"' })
    });
    const body = (await res.json()) as { version: number };
    expect(body.version).toBe(EXISTING_VERSION + 1);
  });
});
```

Add to the file's `vi.mock` block:

```ts
vi.mock('../services/scriptVersions', () => ({
  cutScriptVersion: vi.fn((_tx: unknown, args: { scriptId: string; provenance: Record<string, unknown> }) => {
    h.cuts.push(args);
    return Promise.resolve({ id: 'version-row', scriptId: args.scriptId, version: EXISTING_VERSION + 1 });
  })
}));
```

and ensure the `db` mock exposes `transaction: vi.fn((fn) => fn(txMock))` where `txMock` records `update().set()` payloads into `h.updates`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/scripts.test.ts`
Expected: FAIL — `language`, `timeoutSeconds`, and `runAs` cases see zero cuts, and the "never sets version itself" case sees `version` in the update payload.

- [ ] **Step 3: Widen the change detection**

In `apps/api/src/routes/scripts.ts`, replace the three plain assignments at `:866-868` so they also mark the version dirty. Keep `let versionChanged = false;` where it is (`:875`) but **move it above** these lines, then write:

```ts
    // The version bump covers EVERYTHING a run consumes. It used to track
    // content and parameters only (#3409 PR3), which left language, timeout
    // and run context able to change under a pinned version — and under a
    // pinned effect digest. A version row is the definition of an execution
    // (spec §4.1), so all five fields move it.
    let versionChanged = false;

    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.category !== undefined) updates.category = data.category;
    if (data.osTypes !== undefined) updates.osTypes = data.osTypes;
    if (data.language !== undefined) {
      updates.language = data.language;
      if (data.language !== script.language) versionChanged = true;
    }
    if (data.timeoutSeconds !== undefined) {
      updates.timeoutSeconds = data.timeoutSeconds;
      if (data.timeoutSeconds !== script.timeoutSeconds) versionChanged = true;
    }
    if (data.runAs !== undefined) {
      updates.runAs = data.runAs;
      if (data.runAs !== script.runAs) versionChanged = true;
    }
    if (data.exitCodeSeverityMapping !== undefined) updates.exitCodeSeverityMapping = data.exitCodeSeverityMapping;
```

Delete the now-duplicated `let versionChanged = false;` that stood at `:875` and the four lines it replaced at `:866-868`.

- [ ] **Step 4: Hand the bump to `cutScriptVersion` inside a transaction**

Delete the bump at `:913-915`:

```ts
    if (versionChanged) {
      updates.version = script.version + 1;
    }
```

Replace the bare update at `:950-954` with a transaction:

```ts
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(scripts)
        .set(updates)
        .where(eq(scripts.id, scriptId))
        .returning();

      if (!row) return null;

      // Cut AFTER the update so the version snapshots the after-image.
      // cutScriptVersion owns scripts.version — `updates` must never carry it.
      const cut = versionChanged
        ? await cutScriptVersion(tx, {
            scriptId,
            provenance: {
              origin: 'human',
              changelog: null,
              createdBy: auth.user.id
            }
          })
        : null;

      return { ...row, version: cut?.version ?? row.version };
    });

    const updated = result;
```

Leave the existing `if (!updated) { return c.json({ error: 'Script not found or no longer writable' }, 404); }` guard at `:956-958` exactly as it is — it now also covers a rolled-back transaction. Add the import at the top of the file:

```ts
import { cutScriptVersion } from '../services/scriptVersions';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/scripts.test.ts src/routes/scripts.execute-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/scripts.ts apps/api/src/routes/scripts.test.ts
git commit -m "feat(api): PUT /scripts cuts a version for every run-consumed field"
```

---

### Task 11: Org-clone of a system script cuts v1

**Files:**
- Modify: `apps/api/src/routes/scripts.ts:563-591`
- Test: `apps/api/src/routes/scripts.test.ts`

**Interfaces:**
- Consumes: `cutScriptVersion` (Task 7).
- Produces: no new exports. Contract: the cloned row lands at `version: 1` with one version row, `origin: 'human'`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/scripts.test.ts`:

```ts
describe('POST /scripts/:id/import (org clone of a system script)', () => {
  it('cuts version 1 for the cloned script with a human origin', async () => {
    h.cuts = [];
    const res = await app.request(`/scripts/${SYSTEM_SCRIPT_ID}/import`, {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ orgId: ORG_ID })
    });
    expect(res.status).toBe(200);
    expect(h.cuts).toHaveLength(1);
    expect(h.cuts[0]!.provenance).toMatchObject({ origin: 'human', changelog: 'Imported from the system library' });
  });

  it('inserts the clone at version 0 so the cut produces version 1', async () => {
    h.inserts = [];
    await app.request(`/scripts/${SYSTEM_SCRIPT_ID}/import`, {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ orgId: ORG_ID })
    });
    expect(h.inserts.find((v) => v.name !== undefined)).toMatchObject({ version: 0 });
  });
});
```

Adjust the route path and request body to match the handler's real shape — read `apps/api/src/routes/scripts.ts` around `:500-563` for the route declaration and its Zod body before writing the test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/scripts.test.ts`
Expected: FAIL — `h.cuts` is empty and the insert carries `version: 1`.

- [ ] **Step 3: Write the implementation**

In `apps/api/src/routes/scripts.ts`, replace the clone insert at `:564-591`:

```ts
    // Clone into the org — row and v1 in one transaction, same reason as
    // insertScriptRow: a clone with no version row would be headless, and
    // script_versions is append-only so it could not be repaired later.
    const cloned = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(scripts)
        .values({
          orgId,
          name: source.name,
          description: source.description,
          category: source.category,
          osTypes: source.osTypes,
          language: source.language,
          content: source.content,
          parameters: source.parameters,
          timeoutSeconds: source.timeoutSeconds,
          runAs: source.runAs,
          isSystem: false,
          version: 0,
          // #5129 — `acknowledgedSecurityPatterns` is DELIBERATELY not copied.
          // The column defaults to '{}', so the imported copy starts
          // unacknowledged and its first Strict match is refused until someone
          // signs off on it in this org. An acknowledgement is one named human
          // accepting one risk on one script; importing a library script is not
          // that person making that decision. Same reasoning as scriptClone.ts —
          // do not "complete" this copy list by adding it.
          createdBy: auth.user.id,
        })
        .returning();

      if (!row) return null;

      // origin 'human', not 'imported': a technician copying a shipped script
      // into their org is a person acting, not a bundle landing. 'imported' is
      // reserved for services/scriptBundle (spec §4.1 writers row).
      const cut = await cutScriptVersion(tx, {
        scriptId: row.id,
        provenance: {
          origin: 'human',
          changelog: 'Imported from the system library',
          createdBy: auth.user.id,
        },
      });

      return { ...row, version: cut.version };
    });

    if (!cloned) {
      return c.json({ error: 'Script could not be imported' }, 404);
    }
```

Then update the audit call below it: `resourceId: cloned?.id` becomes `resourceId: cloned.id` and `resourceName: cloned?.name` becomes `resourceName: cloned.name`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/scripts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/scripts.ts apps/api/src/routes/scripts.test.ts
git commit -m "feat(api): system-script org clone cuts version 1"
```

---

### Task 12: `scriptClone.ts` cuts v1

**Files:**
- Modify: `apps/api/src/services/scriptClone.ts:116-135`
- Test: `apps/api/src/services/scriptClone.test.ts` (create)

**Interfaces:**
- Consumes: `cutScriptVersion` (Task 7).
- Produces: no new exports. Contract: the duplicate lands at `version: 1` with one version row, `origin: 'human'`, inside the SAME transaction that copies the tags.

This writer already runs inside `db.transaction` (`:116`), so only the insert value and the cut call change.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/scriptClone.test.ts`. Read `apps/api/src/services/scriptWrite.test.ts` first and reuse its mock shape:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  cuts: [] as Array<{ scriptId: string; provenance: Record<string, unknown> }>,
}));

vi.mock('../db', () => {
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        h.inserts.push(values);
        return { returning: vi.fn(() => Promise.resolve([{ id: 'clone-id', ...values }])) };
      })
    })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })),
  };
  return {
    db: {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])), innerJoin: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })) })),
      transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    }
  };
});

vi.mock('./scriptVersions', () => ({
  cutScriptVersion: vi.fn((_tx: unknown, args: { scriptId: string; provenance: Record<string, unknown> }) => {
    h.cuts.push(args);
    return Promise.resolve({ id: 'version-row', scriptId: args.scriptId, version: 1 });
  })
}));

beforeEach(() => {
  h.inserts = [];
  h.cuts = [];
});
```

Then add the behavioural assertions, calling the module's exported clone function with a stubbed source script (read `apps/api/src/services/scriptClone.ts:1-115` for the exact exported name and signature):

```ts
describe('script duplicate', () => {
  it('inserts the duplicate at version 0', async () => {
    await cloneScript(/* auth, scriptId, input per the real signature */);
    expect(h.inserts[0]).toMatchObject({ version: 0 });
  });

  it('cuts exactly one human-origin version inside the same transaction', async () => {
    await cloneScript(/* … */);
    expect(h.cuts).toHaveLength(1);
    expect(h.cuts[0]!.provenance).toMatchObject({ origin: 'human', changelog: 'Duplicated from another script' });
  });

  it('returns the duplicate at version 1', async () => {
    const created = await cloneScript(/* … */);
    expect(created.version).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/scriptClone.test.ts`
Expected: FAIL — insert carries `version: 1` and `h.cuts` is empty.

- [ ] **Step 3: Write the implementation**

In `apps/api/src/services/scriptClone.ts`, change `version: 1,` in the insert values (`:131`) to:

```ts
        version: 0,
```

and immediately after the `.returning()` that produces `row`, inside the same `db.transaction` callback, add:

```ts
    if (!row) {
      throw new Error('Script duplicate insert returned no row');
    }

    // Same transaction as the tag copy, so "failed" keeps meaning "nothing was
    // created" — including no half-cut version.
    const cut = await cutScriptVersion(tx, {
      scriptId: row.id,
      provenance: {
        origin: 'human',
        changelog: 'Duplicated from another script',
        createdBy: auth.user.id,
      },
    });
```

and make the transaction's return value carry the cut version — wherever the callback currently returns the row (or a `{ script, … }` shape), substitute `{ ...row, version: cut.version }` for `row`. Add the import:

```ts
import { cutScriptVersion } from './scriptVersions';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/scriptClone.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/scriptClone.ts apps/api/src/services/scriptClone.test.ts
git commit -m "feat(api): script duplicate cuts version 1"
```

---

### Task 13: Bundle importer switches to the after-image

**Files:**
- Modify: `apps/api/src/services/scriptBundle/index.ts:777-800` and the `insertScriptRow` call at `:840`
- Modify: `apps/api/src/services/scriptVersions.writers.contract.test.ts` (empty the ratchet)
- Modify: `apps/api/src/__tests__/integration/scriptBundleRls.integration.test.ts:93-97`
- Test: `apps/api/src/services/scriptBundle/` unit suite

**Interfaces:**
- Consumes: `cutScriptVersion` (Task 7); `ScriptInsertOptions.origin` (Task 9).
- Produces: no new exports. Contract change: after a `new-version` import, the script has version rows for **both** the pre-import body (v1, from the head backfill or an earlier cut) **and** the imported body (v2) — where today it only has the before-image.

This is the one behavioural change visible to an existing integration assertion.

- [ ] **Step 1: Update the integration expectation to the after-image contract**

In `apps/api/src/__tests__/integration/scriptBundleRls.integration.test.ts`, replace the comment and the two assertions at `:93-97`:

```ts
  // One version per import: v1 is the script's own creation cut
  // (insertScriptRow), v2 is the after-image of the bundle's replacement body.
  // Before 2026-10-16-100000 the importer wrote a BEFORE-image and creation cut
  // nothing, so a script that had been imported once had exactly one row
  // holding the OLD content — which meant the current body was never in the
  // history at all.
  const oneVersions = versions.filter((v) => v.scriptId === one!.id).sort((a, b) => a.version - b.version);
  const twoVersions = versions.filter((v) => v.scriptId === two!.id).sort((a, b) => a.version - b.version);
  expect(oneVersions.map((v) => [v.version, v.content])).toEqual([[1, 'echo v1'], [2, 'echo v2']]);
  expect(twoVersions.map((v) => [v.version, v.content])).toEqual([[1, 'echo v1'], [2, 'echo v2']]);
  expect(oneVersions.map((v) => v.origin)).toEqual(['imported', 'imported']);
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptBundleRls.integration.test.ts
```
Expected: FAIL — actual is `[[1, 'echo v1']]` (the before-image only), and `origin` is `human` because Task 9's default has not been overridden yet.

- [ ] **Step 3: Write the implementation**

In `apps/api/src/services/scriptBundle/index.ts`, add the import:

```ts
import { cutScriptVersion } from '../scriptVersions';
```

Pass the origin through on the create path at `:840`:

```ts
      const created = await insertScriptRow(auth, scope, { /* …unchanged… */ }, { origin: 'imported' });
```

Replace the before-image snapshot + update at `:777-800` with an after-image cut. Delete the whole `await db.insert(scriptVersions).values({ … })` block and wrap the `db.update(scripts)` that follows it:

```ts
      if (existing && options.mode === 'new-version') {
        // AFTER-image, not before. A version row is the definition of an
        // execution (spec §4.1), so the row that matters is the one holding
        // the body that will actually run. The previous body already has its
        // own row — cut at creation or by the 2026-10-16-100000 head backfill.
        // cutScriptVersion owns scripts.version, so this SET must not carry it.
        await db.transaction(async (tx) => {
          await tx
            .update(scripts)
            .set({
              description: entry.description ?? existing.description,
              category: entry.category ?? existing.category,
              osTypes: entry.osTypes,
              language: entry.language,
              content: entry.content,
              parameters: entry.parameters ?? existing.parameters,
              timeoutSeconds: entry.timeoutSeconds,
              runAs: entry.runAs,
              exitCodeSeverityMapping: entry.exitCodeSeverityMapping ?? existing.exitCodeSeverityMapping,
              // …keep every remaining key of the existing SET verbatim,
              // including the #5129 acknowledgement clearing, but REMOVE any
              // `version:` key if one is present.
            })
            .where(eq(scripts.id, existing.id));

          await cutScriptVersion(tx, {
            scriptId: existing.id,
            provenance: {
              origin: 'imported',
              changelog: `Imported from bundle "${entry.name}"`,
              createdBy: auth.user.id,
            },
          });
        });
```

Before editing, read `:786-840` in full and carry every key of the existing `.set({ … })` across unchanged except `version`. Remove the now-unused `scriptVersions` import from the file if nothing else in it references the table.

- [ ] **Step 4: Empty the conversion ratchet**

In `apps/api/src/services/scriptVersions.writers.contract.test.ts`, replace the allowlist with an empty set and update its comment:

```ts
/** Empty as of W01a Task 13 — every legacy writer now goes through
 *  cutScriptVersion. This set exists so the ratchet's shape is obvious; adding
 *  an entry means adding a second writer, which the spec forbids. */
const PENDING_CONVERSION: ReadonlySet<string> = new Set<string>([]);
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/scriptBundle src/services/scriptVersions.writers.contract.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptBundleRls.integration.test.ts
```
Expected: PASS on all three.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/scriptBundle/index.ts \
        apps/api/src/services/scriptVersions.writers.contract.test.ts \
        apps/api/src/__tests__/integration/scriptBundleRls.integration.test.ts
git commit -m "feat(api): bundle importer cuts an after-image version"
```

---

### Task 14: `systemScriptLibrary` cuts on create and on sync

**Files:**
- Modify: `apps/api/src/services/systemScriptLibrary.ts:307-320` (create) and `:353-379` (update)
- Test: `apps/api/src/services/systemScriptLibrary.test.ts`

**Interfaces:**
- Consumes: `cutScriptVersion` (Task 7).
- Produces: no new exports. Contract: boot-time library sync cuts `origin: 'system'`, `createdBy: null` (there is no user on the startup path — `apps/api/src/index.ts:1633` wraps it in `runWithSystemDbAccess`).

Both halves of this writer need converting: the insert at `:307` creates a script at `version: 1` with no version row, and the update at `:353` bumps `version` itself at `:376`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/systemScriptLibrary.test.ts` (read its existing mock factory first and extend it with `transaction` and the `scriptVersions` mock, in the Task 12 style):

```ts
describe('ensureSystemLibraryScripts cuts versions', () => {
  it('cuts a system-origin version for a newly created library script', async () => {
    h.existingScript = null;
    h.cuts = [];
    await ensureSystemLibraryScripts();
    expect(h.cuts.length).toBeGreaterThan(0);
    expect(h.cuts[0]!.provenance).toMatchObject({ origin: 'system', createdBy: null });
  });

  it('inserts a new library script at version 0', async () => {
    h.existingScript = null;
    h.inserts = [];
    await ensureSystemLibraryScripts();
    expect(h.inserts[0]).toMatchObject({ version: 0, isSystem: true });
  });

  it('cuts a version when a shipped definition changed, and never sets version itself', async () => {
    h.existingScript = { id: SYSTEM_SCRIPT_ID, content: 'old body', version: 3, /* …other fields per the real select… */ };
    h.cuts = [];
    h.updates = [];
    await ensureSystemLibraryScripts();
    expect(h.cuts).toHaveLength(1);
    expect(h.cuts[0]!.provenance).toMatchObject({ origin: 'system' });
    expect(h.updates.some((u) => 'version' in u)).toBe(false);
  });

  it('cuts nothing when every shipped definition is unchanged', async () => {
    h.existingScript = { id: SYSTEM_SCRIPT_ID, /* …fields identical to the shipped definition… */ };
    h.cuts = [];
    await ensureSystemLibraryScripts();
    expect(h.cuts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/systemScriptLibrary.test.ts`
Expected: FAIL — `h.cuts` is empty on both paths and `version` appears in the update payload.

- [ ] **Step 3: Convert the create path**

In `apps/api/src/services/systemScriptLibrary.ts`, add the import:

```ts
import { cutScriptVersion } from './scriptVersions';
```

Replace the insert at `:307-320`:

```ts
    if (!existing) {
      await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(scripts)
          .values({
            orgId: null,
            partnerId: null,
            name: def.name,
            description: def.description,
            category: def.category,
            osTypes: def.osTypes,
            language: def.language,
            content: def.content,
            parameters,
            timeoutSeconds: def.timeoutSeconds,
            runAs: def.runAs,
            isSystem: true,
            // cutScriptVersion moves it to 1 below.
            version: 0,
          })
          .returning({ id: scripts.id });

        if (!created) {
          throw new Error(`system library script "${def.name}" insert returned no row`);
        }

        // No user on the boot path — index.ts wraps this in
        // runWithSystemDbAccess, so createdBy is honestly null.
        await cutScriptVersion(tx, {
          scriptId: created.id,
          provenance: { origin: 'system', changelog: 'Shipped system library definition', createdBy: null },
        });
      });
```

Keep whatever follows the original insert (the `result.created += 1;` and the `continue`) exactly as it is.

- [ ] **Step 4: Convert the update path**

Replace the update at `:353-379`. Delete the `version: existing.version + 1,` line from the `.set({ … })` and wrap:

```ts
    await db.transaction(async (tx) => {
      await tx
        .update(scripts)
        .set({
          description: def.description,
          category: def.category,
          osTypes: def.osTypes,
          language: def.language,
          content: def.content,
          parameters,
          timeoutSeconds: def.timeoutSeconds,
          runAs: def.runAs,
          // #5129 — when the library sync replaces `content` from a shipped
          // definition there is no human in the loop, so any acknowledgement the
          // row carried is revoked rather than inherited by the new body.
          // Gated on `contentChanged`, NOT on reaching this branch: the branch
          // also fires for a metadata-only diff (a timeout or description tweak)
          // where the reviewed body is untouched and the approval must stand.
          ...(contentChanged ? clearedScriptSecurityAcknowledgementColumns() : {}),
          // `version` is NOT set here — cutScriptVersion owns the bump, and a
          // second bump would skip a number and break UNIQUE-backed history.
          updatedAt: new Date(),
        })
        .where(eq(scripts.id, existing.id));

      await cutScriptVersion(tx, {
        scriptId: existing.id,
        provenance: {
          origin: 'system',
          changelog: 'Shipped system library definition updated',
          createdBy: null,
        },
      });
    });
    result.updated += 1;
```

The `unchanged` early-`continue` above (`:347-351`) is what keeps a no-op boot from cutting a version every restart — leave it untouched.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/systemScriptLibrary.test.ts src/services/scriptVersions.writers.contract.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/systemScriptLibrary.ts apps/api/src/services/systemScriptLibrary.test.ts
git commit -m "feat(api): system script library sync cuts versions"
```

---

### Task 15: Registry verification and full suite sweep

**Files:**
- Read-only: `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/services/tenantCascade.ts`, `apps/api/src/routes/devices/core.ts`
- Modify: `docs/superpowers/plans/ai-mcp/2026-09-11-ai-script-authoring-w01a-script-versions.md` (tick the boxes) — no source changes expected

**Interfaces:**
- Consumes: everything produced by Tasks 1–14.
- Produces: the PR.

- [ ] **Step 1: Prove `script_versions` needs no cascade or export registration**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-field-0316
grep -n "script_versions" apps/api/src/services/tenantCascade.ts
grep -n "script_versions" apps/api/src/services/tenantExportPolicyRegistry.ts
grep -n "script_versions" apps/api/src/routes/devices/core.ts
grep -n "org_id" apps/api/src/db/schema/scripts.ts | sed -n '1,40p'
```
Expected: all three greps return **nothing**, and `script_versions` has no `orgId` column in the schema. That is the CLAUDE.md rule ("a table with no `org_id` needs no entry") confirmed by reading, not assumed. `script_versions` also has no `device_id`, so neither device list applies, and it is not append-only *in the erasure sense* (it has no DELETE revoke; it dies by cascade), so `AUDIT_ADMIN_REQUIRED_TABLES` does not apply either.

If any grep DOES return a hit, stop: the table is registered somewhere and every new column must be classified in `CORE_TENANT_EXPORT_POLICY` in this PR.

- [ ] **Step 2: Confirm `scripts` gained no columns in this wave**

```bash
git diff origin/main -- apps/api/src/db/schema/scripts.ts | grep '^+' | grep -n "scripts = pgTable" -A 60
git diff origin/main -- apps/api/migrations/ | grep -n "ALTER TABLE public.scripts"
```
Expected: no `ALTER TABLE public.scripts ADD COLUMN` anywhere in this wave's migration, and no new key inside the `scripts` table object. `scripts.origin` is W01b's `2026-10-16-100300-scripts-origin.sql`.

- [ ] **Step 3: Run the API unit suite**

```bash
cd apps/api && npx vitest run src/services/scriptVersions.test.ts \
  src/services/scriptVersions.writers.contract.test.ts \
  src/services/scriptWrite.test.ts \
  src/services/scriptClone.test.ts \
  src/services/systemScriptLibrary.test.ts \
  src/services/scriptBundle \
  src/routes/scripts.test.ts \
  src/db/schema/scripts.scriptVersions.test.ts \
  src/db/migrationRlsScope.test.ts \
  src/db/autoMigrate.test.ts
cd packages/shared && npx vitest run src/types/scriptProposals.test.ts
```
Expected: all PASS.

- [ ] **Step 4: Typecheck and lint**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-field-0316 && pnpm lint
```
Expected: clean.

- [ ] **Step 5: Run the contract suites that tenancy work must not redden**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/scriptVersionsImmutable.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/scriptBundleRls.integration.test.ts
```
Expected: all PASS. `tenantCascade.integration.test.ts` is the suite that proves the new `ON DELETE CASCADE` actually lets an org erasure through — it was a latent 23503 before this wave.

- [ ] **Step 6: Verify against a fresh database, not just an incrementally migrated one**

```bash
pnpm test-stack down
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptVersionsImmutable.integration.test.ts
```
Expected: PASS. This is what catches an ordering bug inside the migration file (for example the immutability trigger being created before the backfill UPDATEs).

- [ ] **Step 7: Manual forge as `breeze_app`, per CLAUDE.md step 6**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
```
```sql
SELECT set_config('breeze.scope', 'system', true);
UPDATE script_versions SET changelog = 'forged' WHERE true;   -- expect: UPDATE 0
DELETE FROM script_versions WHERE true;                        -- expect: DELETE 0
```
Expected: both report `0`. Record the two outputs in the PR body.

- [ ] **Step 8: Re-check the migration name against the remote and tear down**

```bash
git fetch origin main
./scripts/check-migration-naming.sh --against-ref origin/main
pnpm test-stack down
```

- [ ] **Step 9: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(api): W01a — script_versions become immutable execution definitions" --body "$(cat <<'EOF'
Rebuilds `script_versions` into immutable, content-addressed execution
definitions and routes every script writer through one helper.

- Migration `2026-10-16-100000-script-versions-immutable.sql`: definition +
  provenance columns, duplicate `(script_id, version)` repair with reported
  counts, `UNIQUE (script_id, version)`, parent FK `ON DELETE CASCADE` (closes
  a latent 23503 on GDPR org erasure), RLS reduced to SELECT + INSERT, an
  UPDATE-refusing trigger, and a head-version backfill under
  `breeze.scope = system`.
- `services/scriptVersions.ts`: `cutScriptVersion`, `headScriptVersion`,
  `sha256Content` — the sole writer, enforced by a grep contract test.
- All seven writers converted: `insertScriptRow`, `PUT /scripts/:id` (now
  bumping on language/timeout/runAs too), the system-script org clone,
  `scriptClone`, the bundle importer (before-image → after-image,
  `origin: 'imported'`), and both halves of the system library sync.
- `script_versions` has no `org_id`, so no cascade or export-policy entry is
  required — verified by reading `tenantCascade.ts` and
  `tenantExportPolicyRegistry.ts`, not assumed.

No web changes. No agent changes. No new columns on `scripts` (that is W01b).

Spec: `docs/superpowers/specs/ai-mcp/2026-09-11-ai-script-authoring-and-review-design.md` §4.1
Plan: `docs/superpowers/plans/ai-mcp/2026-09-11-ai-script-authoring-w01a-script-versions.md`

Closes #<wave sub-issue>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 10: Commit any plan checkbox updates**

```bash
git add docs/superpowers/plans/ai-mcp/2026-09-11-ai-script-authoring-w01a-script-versions.md
git commit -m "docs(plans): tick W01a completion"
git push
```

---

## Self-review record

**Spec coverage (§4.1 `script_versions` row, §5, §7, §8 W01):**

| Spec requirement | Task |
|---|---|
| Columns added: language, timeout_seconds, run_as, parameters, origin, proposal_id, review_id, reviewed_at, approved_by, approved_at, approval_method, content_digest | 3 (migration), 5 (Drizzle) |
| `UNIQUE (script_id, version)` replaces the non-unique index; repair reports duplicates first | 3 steps 2 and 4 |
| Immutability trigger; policies reduced to INSERT + SELECT; 2026-10-01 UPDATE/DELETE dropped | 3 step 5; proven in 2 |
| Parent FK `ON DELETE CASCADE` re-added | 3 step 4; proven in 2 and 15 step 5 |
| Head = row where `version = scripts.version`; no `head_version_id` on `scripts` | 7 (`headScriptVersion`), and the plan adds no column to `scripts` |
| Every writer cuts under `SELECT … FOR UPDATE`; one shared `cutScriptVersion` is the only writer | 7, 8, 9, 10, 11, 12, 13, 14 |
| PUT bumps on content, parameters, **and now** language, timeout, runAs | 10 |
| Bundle importer switches from before-image to after-image, `origin: 'imported'` | 13 |
| Backfill one version row per script under `breeze.scope = system`, count reported, `origin = system` for `is_system` | 3 step 4 |
| Export policy: no entry (no `org_id`) | 15 step 1, verified by reading the registry |
| Spec §7 tests: "every script writer cuts a version (one test per writer)"; `script_versions` UPDATE/DELETE refused as `breeze_app`; migration naming and RLS-scope guards | 9–14 (one per writer), 2, 3 steps 7–8 |
| `scripts` gains no columns in this wave | 15 step 2 |

No spec requirement in this wave's scope is unclaimed.

**Placeholder scan:** no "TBD", no "add error handling", no "similar to Task N", no "write tests for the above". Three tasks (11, 12, 14) instruct the implementer to read a specific line range before writing the test because the exported symbol name or route body must be matched exactly; the assertions themselves are written out. Two code blocks (13 step 3, 14 step 4) say "keep every remaining key verbatim" about a `.set({ … })` the implementer is editing in place — the keys that must change are named individually.

**Type consistency:** `cutScriptVersion`, `headScriptVersion`, `sha256Content`, `ScriptVersionProvenance` are spelled identically in Tasks 6, 7, 8, 9, 10, 11, 12, 13, 14 and match roadmap §3.2 exactly. `ScriptOrigin` / `ScriptApprovalMethod` are produced in Task 1 and consumed under those names in Tasks 5 and 7. `ScriptVersionRow` is defined once (Task 5, `typeof scriptVersions.$inferSelect`) and re-exported from `services/scriptVersions.ts` in Task 7, so the roadmap's unqualified use of the name resolves. `ScriptVersionTx` is introduced in Task 7 and is the roadmap's `DbTransaction`, aliased to the repo's established `Parameters<Parameters<typeof db.transaction>[0]>[0]` idiom (`apps/api/src/services/commandQueue.ts:99`, `apps/api/src/services/ticketConfigService.ts:42`). `ScriptInsertOptions` (Task 9) is consumed only by Task 13.

**Open questions for the reviewer (not blocking):**

1. `version: 0` as the transient create-path value keeps `cutScriptVersion`'s single contract. The alternative is a `mode: 'create' | 'bump'` argument, which deviates from the roadmap's fixed signature. Flagging, not asking.
2. Org-clone and `scriptClone` cut `origin: 'human'`. The spec names `'imported'` only for the bundle importer; if a reviewer wants clones marked `'imported'`, it is a one-word change in Tasks 11 and 12.
3. The immutability trigger's raise is not reachable from `breeze_app` (the missing UPDATE policy stops it first), so Task 2 asserts the trigger's installation rather than fabricating a raise. Proving the raise would need a superuser connection the integration harness does not expose.

## Amendments after cross-wave reconciliation (2026-09-11)

- `insertScriptRow(opts)` accepts `opts.provenance?: ScriptVersionProvenance` and forwards it to `cutScriptVersion` for the v1 row (default `{ origin: 'human', createdBy }`). W03's promote passes proposal provenance here instead of cutting a second version. Add this parameter in the task that converts `insertScriptRow`, with one extra assertion in its test.
- `packages/shared/src/types/scriptProposals.ts` created here with `ScriptOrigin` and `ScriptApprovalMethod` is extended (not recreated) by W01b; keep both types byte-identical to roadmap §3.1.

