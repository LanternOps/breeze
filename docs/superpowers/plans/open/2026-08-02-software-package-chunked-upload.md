# Software Package Chunked Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's single-request software-package upload with a chunked, resumable upload so upload duration is decoupled from the 15-minute access-token TTL, fixing issue #2951 (`"signal is aborted without reason"` on a ~222MB MSI).

**Architecture:** A new `software_upload_sessions` table (tenancy shape 1, direct `org_id`, forced RLS) tracks per-upload state; five new endpoints under `/software/catalog/:id/versions/uploads` (create session → PUT raw octet-stream chunks with an offset CAS → complete, which reuses the existing `uploadBinary` → `insertLatestSoftwareVersion` → `writeRouteAudit` tail verbatim, including the #2794 S3 error mapping). A new web module `softwarePackageUpload.ts` drives the chunk loop with byte-accurate progress, per-chunk retry via a 409-resync contract, and returns a plain `Response` so both `runAction` (AddPackageModal) and inline-error UI (SoftwareVersionManager) keep their existing surfacing contracts. The old `POST .../versions/upload` multipart route stays untouched for API/script consumers — the dashboard just stops calling it.

**Tech Stack:** Hono + Zod (API routes), Drizzle ORM + hand-written idempotent SQL migration (PostgreSQL, forced RLS), BullMQ (orphan-session reaper), Node `fs`/`crypto` streams (chunk assembly + sha256), React + `fetchWithAuth` (web), Vitest everywhere.

## Global Constraints

- **Single-API-instance assumption (explicit design constraint, actively guarded):** chunks append to one temp file on the local filesystem (`join(tmpdir(), 'breeze-uploads')`), so all chunks of one upload MUST hit the same API process. True for Breeze's per-region single-droplet deployment. This is not merely documented — every session row records `owner_instance_id` (a per-process boot id) at create; the chunk and complete routes fail fast with a NON-RETRYABLE `409 { error: 'upload_instance_mismatch' }` when another process receives a request, and the client aborts immediately with an operator-actionable message naming load-balancer session affinity as the fix (Tasks 1, 5-7, 10). A multi-replica deployment needs sticky sessions (or shared partial storage — out of scope).
- **Session caps (DoS guard, enforced at create before the row insert):** without caps, any software-write user could open unlimited sessions, each pinning up to 500MB of API-host temp disk. Exported constants in `softwareUploads.ts`: `MAX_ACTIVE_UPLOAD_SESSIONS_PER_ORG = 5`, `MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER = 2`, `MAX_ACTIVE_UPLOAD_BYTES_PER_ORG = 2.5 * 1024 * 1024 * 1024` (2.5GB of summed declared `file_size` across an org's `status='active'` sessions). Each limit answers `429` with its own distinct `error` string (Task 5).
- **Checksum strategy (decided):** sha256 is computed by streaming the completed temp file once at `complete` (option b). One sequential read of ≤500MB (~1–2s) buys full restart-safety and zero cross-request in-process state — no `Map<uploadId, Hash>` to invalidate.
- **Rejected alternative (recorded for reviewers):** S3/MinIO multipart-upload parts — the API proxying each chunk straight into a storage multipart upload, no local disk — was considered and rejected: `uploadBinary` stores the sha256 as object metadata and agents use it to verify downloads, so storage-side assembly would force streaming the completed 500MB object back OUT of storage purely to compute that hash, whereas local assembly hashes from local disk. It is the natural future path if multi-replica API deployments ever need first-class support.
- **Reaper policy (two independent ceilings, both env-tunable):** sessions are reaped at **2h idle** (`last_activity_at`, `SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS`) OR **24h absolute lifetime** (`created_at`, `SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS`) — the absolute ceiling exists so a client that keeps a session warm forever cannot pin disk indefinitely (Task 8).
- Chunk size: client sends 8MB chunks (`UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024`); server accepts `chunkSize` between 256KB and 8MB; body-limit carve-out is 9MB (1MB headroom over the max chunk).
- Existing limits preserved exactly: `ALLOWED_EXTENSIONS` = `.msi .exe .dmg .deb .pkg`, `MAX_UPLOAD_SIZE` = 500MB (`apps/api/src/routes/software.ts:138-139`, moved to a shared module in Task 4). Both are validated at session **create** so a doomed upload fails in the first second.
- RLS: the new table gets `ENABLE` + `FORCE` ROW LEVEL SECURITY and all four `breeze_has_org_access(org_id)` policies **in the same migration that creates it**. Shape 1 is auto-discovered by `rls-coverage.integration.test.ts` — no allowlist entry needed.
- Cascade contracts (both required, CI-enforced on live DB only): register in `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts`) and `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`). The table has **no `device_id` column**, so `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` in `routes/devices/core.ts` do NOT apply (considered, deliberately skipped).
- FK direction (deliberate): `catalog_id REFERENCES software_catalog(id) ON DELETE CASCADE`, `org_id` likewise, `created_by` → `users(id) ON DELETE SET NULL`.
  **Corrected 2026-08-02 (was wrong in the first draft — do not restore the old rationale):** the raw alphabetical position of an entry in `CORE_ORG_CASCADE_DELETE_ORDER` does NOT determine deletion order at runtime. `deleteOrgCascade` calls `topologicalCascadeOrder()` (`services/tenantCascade.ts:439`, invoked at `:568`), which recomputes an FK-safe order from the live `pg_constraint` catalog, and `tenantCascade.integration.test.ts:115` asserts FK-children-before-parents against **that topological order**, not against the literal list. So `software_upload_sessions` is deleted BEFORE `software_catalog` regardless of alphabetical position, and no FK violation was ever possible here. `ON DELETE CASCADE` is still the right choice — it protects a direct `DELETE FROM software_catalog` outside the cascade path — just not for the reason originally stated.
- Migration rules: file `apps/api/migrations/2026-08-11-software-upload-sessions.sql` — the date prefix must sort AFTER the newest shipped migration (`2026-08-10-installer-bootstrap-tokens-parent-index.sql`), not match today's calendar date; migration dates in this repo run ahead of the calendar. If newer migrations land before this ships, bump the prefix again. Idempotent (`IF NOT EXISTS` / guarded `DO $$` / `DROP POLICY IF EXISTS`); NO inner `BEGIN;`/`COMMIT;`; never edit after ship; `pnpm db:check-drift` must pass after the Drizzle schema edit.
- `pnpm --filter @breeze/api test` does NOT run the RLS/integration contract suites — run `pnpm --filter @breeze/api test:integration` explicitly (needs a live DB, e.g. `pnpm --filter @breeze/api test:docker:up` first).
- Web mutation surfacing: AddPackageModal keeps its `runAction` wrapping — `uploadPackageVersion` resolves with a `Response` (the `/complete` response on success, or the first unrecoverable failing response) and rejects only on network failure/abort, so `runAction`'s body parsing and toasts work unchanged. `apps/web/src/lib/softwarePackageUpload.ts` gets a `RUN_ACTION_ALLOWLIST` entry (typed multi-request driver; surfacing owned by callers).
- Backward compatibility: `POST /software/catalog/:id/versions/upload` (multipart, single request) remains fully functional and untouched.
- Commits: one per task, conventional-commit style (`feat(api): …`, `fix(web): …`).
- Files stay under ~500 lines: new routes live in `apps/api/src/routes/softwareUploads.ts` (not appended to the 2168-line `software.ts`); shared helpers are extracted to `apps/api/src/services/softwareVersionShared.ts` to avoid an import cycle (`software.ts` mounts the uploads router; the uploads router must never import `software.ts`).

---

## File Structure

```
apps/api/
  migrations/2026-08-11-software-upload-sessions.sql        [create]  table + constraints + indexes + forced RLS + grants
  src/db/schema/software.ts                                 [modify]  add softwareUploadSessions Drizzle table
  src/services/softwareVersionShared.ts                     [create]  ALLOWED_EXTENSIONS, MAX_UPLOAD_SIZE, getFileExtension,
                                                                      resolveScopedOrgId, setLatestSoftwareVersion,
                                                                      insertLatestSoftwareVersion (moved out of software.ts)
  src/services/softwareVersionShared.test.ts                [create]  unit tests for the shared helpers
  src/routes/software.ts                                    [modify]  import shared helpers (delete local copies); mount uploads router
  src/routes/softwareUploads.ts                             [create]  5 upload-session endpoints + session lock + temp-file append
  src/routes/softwareUploads.test.ts                        [create]  route unit tests (mocked db/auth/s3, real fs in tmpdir)
  src/middleware/bodyLimit.ts                               [modify]  9MB carve-out for the chunk path
  src/middleware/bodyLimit.test.ts                          [modify]  carve-out tests
  src/services/tenantCascade.ts                             [modify]  register software_upload_sessions in CORE_ORG_CASCADE_DELETE_ORDER
  src/services/tenantExportPolicyRegistry.ts                [modify]  classify every column in CORE_TENANT_EXPORT_POLICY
  src/jobs/softwareUploadSessionCleanup.ts                  [create]  BullMQ reaper: stale sessions → unlink temp + delete row
  src/jobs/softwareUploadSessionCleanup.test.ts             [create]  reaper unit tests
  src/index.ts                                              [modify]  wire reaper init/shutdown
  src/__tests__/integration/softwareUploadSessionsRls.integration.test.ts  [create]  cross-org isolation + 42501 forge

apps/web/
  src/stores/auth.ts                                        [modify]  fetchWithAuth: readable timeout abort, 401-retry signal,
                                                                      don't clobber caller Content-Type
  src/stores/auth.test.ts                                   [modify]  tests for the three fixes
  src/lib/softwarePackageUpload.ts                          [create]  chunked uploader: create → chunk loop → complete, progress,
                                                                      retry + 409 resync
  src/lib/softwarePackageUpload.test.ts                     [create]  uploader unit tests (mocked fetchWithAuth)
  src/lib/runActionAllowlist.ts                             [modify]  allowlist entry for softwarePackageUpload.ts
  src/components/software/SoftwareVersionManager.tsx        [modify]  use uploader; real progress; delete fake 10/90/100
  src/components/software/SoftwareVersionManager.upload.test.tsx  [create]  upload-path component test
  src/components/software/AddPackageModal.tsx               [modify]  file branch of buildVersionRequest uses uploader; progress %
  src/components/software/AddPackageModal.test.tsx          [modify]  file-upload path test
```

---

### Task 1: `software_upload_sessions` table (schema + migration + RLS)

**Files:**
- Test: `apps/api/src/__tests__/integration/softwareUploadSessionsRls.integration.test.ts`
- Modify: `apps/api/src/db/schema/software.ts` (append after `softwareInventory`, line 146)
- Create: `apps/api/migrations/2026-08-11-software-upload-sessions.sql`

**Interfaces:**
- Produces: Drizzle table export `softwareUploadSessions` with columns `id, orgId, catalogId, fileName, fileSize, chunkSize, bytesReceived, status, tempPath, ownerInstanceId, versionMetadata, createdBy, createdAt, lastActivityAt` (exported from `apps/api/src/db/schema/software.ts`, re-exported by `../db/schema` via the existing `export * from './software'` in `schema/index.ts`).
- Consumes: `organizations`, `partners`, `users`, `softwareCatalog` (already imported in that schema file).

- [ ] **Step 1: Write the failing RLS integration test**

Create `apps/api/src/__tests__/integration/softwareUploadSessionsRls.integration.test.ts`. Mirrors `catalog-rls.integration.test.ts` (same file: fixture-per-test, no memoization — `setup.ts`'s `beforeEach` TRUNCATEs tenants CASCADE, so cached rows would be gone and assertions vacuous):

```ts
/**
 * Real-driver cross-tenant forge tests for software_upload_sessions
 * (chunked package upload, issue #2951). Runs under
 * vitest.integration.config.ts — code-under-test connects as the
 * unprivileged `breeze_app` role, so RLS is actually enforced.
 *
 * Coverage:
 *   (a) org B context reading org A's upload session → 0 rows
 *   (b) org B context UPDATE/DELETE on org A's session → 0 rows, row survives
 *   (c) a forged cross-org INSERT (org B context, org_id = orgA) → 42501
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { softwareCatalog, softwareUploadSessions } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  orgA: { id: string };
  orgB: { id: string };
  catalogA: { id: string };
  sessionA: { id: string };
  orgBContext: DbAccessContext;
}

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const [catalogA] = await db
      .insert(softwareCatalog)
      .values({ orgId: orgA.id, name: 'A-only package' })
      .returning({ id: softwareCatalog.id });
    if (!catalogA) throw new Error('failed to seed catalog item A');

    const [sessionA] = await db
      .insert(softwareUploadSessions)
      .values({
        orgId: orgA.id,
        catalogId: catalogA.id,
        fileName: 'installer.msi',
        fileSize: 1024,
        chunkSize: 512,
        tempPath: '/tmp/breeze-uploads/session-test-a.part',
        ownerInstanceId: 'itest-instance',
        versionMetadata: { version: '1.0.0' },
      })
      .returning({ id: softwareUploadSessions.id });
    if (!sessionA) throw new Error('failed to seed upload session A');

    const orgBContext: DbAccessContext = {
      scope: 'organization',
      orgId: orgB.id,
      accessibleOrgIds: [orgB.id],
      accessiblePartnerIds: [],
      userId: null,
    };

    return {
      orgA: { id: orgA.id },
      orgB: { id: orgB.id },
      catalogA: { id: catalogA.id },
      sessionA: { id: sessionA.id },
      orgBContext,
    };
  });
}

describe('software_upload_sessions RLS isolation (breeze_app)', () => {
  runDb('org B context cannot read an org-A upload session', async () => {
    const { sessionA, orgBContext } = await seedFixture();
    const rows = await withDbAccessContext(orgBContext, () =>
      db
        .select({ id: softwareUploadSessions.id })
        .from(softwareUploadSessions)
        .where(eq(softwareUploadSessions.id, sessionA.id))
    );
    expect(rows).toHaveLength(0);
  });

  runDb('org B UPDATE/DELETE on an org-A session affects 0 rows; row survives', async () => {
    const { sessionA, orgBContext } = await seedFixture();

    const updated = await withDbAccessContext(orgBContext, () =>
      db
        .update(softwareUploadSessions)
        .set({ bytesReceived: 999 })
        .where(eq(softwareUploadSessions.id, sessionA.id))
        .returning({ id: softwareUploadSessions.id })
    );
    expect(updated).toHaveLength(0);

    const deleted = await withDbAccessContext(orgBContext, () =>
      db
        .delete(softwareUploadSessions)
        .where(eq(softwareUploadSessions.id, sessionA.id))
        .returning({ id: softwareUploadSessions.id })
    );
    expect(deleted).toHaveLength(0);

    const survivor = await withSystemDbAccessContext(() =>
      db
        .select({ id: softwareUploadSessions.id, bytesReceived: softwareUploadSessions.bytesReceived })
        .from(softwareUploadSessions)
        .where(eq(softwareUploadSessions.id, sessionA.id))
    );
    expect(survivor).toHaveLength(1);
    expect(survivor[0]?.bytesReceived).toBe(0);
  });

  // Drizzle wraps the driver error; Postgres 42501 (insufficient_privilege /
  // "new row violates row-level security policy") rides on `cause.code` —
  // same assertion pattern as catalog-rls.integration.test.ts case (c).
  runDb('a forged cross-org software_upload_sessions insert is rejected by RLS', async () => {
    const { orgA, catalogA, orgBContext } = await seedFixture();

    let caught: unknown;
    try {
      await withDbAccessContext(orgBContext, () =>
        db.insert(softwareUploadSessions).values({
          orgId: orgA.id, // forged: org B context writing an org A row
          catalogId: catalogA.id,
          fileName: 'forged.msi',
          fileSize: 1024,
          chunkSize: 512,
          tempPath: '/tmp/breeze-uploads/session-forged.part',
          ownerInstanceId: 'itest-instance',
          versionMetadata: { version: '6.6.6' },
        })
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    const cause = (caught as { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe('42501');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test:docker:up && pnpm --filter @breeze/api test:integration softwareUploadSessionsRls`
Expected: FAIL — TypeScript/import error: `softwareUploadSessions` is not exported from `../../db/schema` (table does not exist yet).

- [ ] **Step 3: Add the Drizzle table**

Append to `apps/api/src/db/schema/software.ts` (after `softwareInventory`, end of file). `users` and `organizations` are already imported at the top of this file:

```ts
// Chunked-upload sessions for software package installers (issue #2951).
// One row per in-flight browser upload; chunks append to temp_path on the API
// host's local disk (single-instance assumption — see routes/softwareUploads.ts).
// Rows are deleted on complete/abort; the softwareUploadSessionCleanup job
// reaps sessions idle for SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS (2h) or older
// than SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS (24h) regardless of activity.
// Tenancy shape 1 (direct org_id, forced RLS — see
// migrations/2026-08-11-software-upload-sessions.sql).
export const softwareUploadSessions = pgTable('software_upload_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  // ON DELETE CASCADE so a direct `DELETE FROM software_catalog` outside the
  // org-erasure path cannot strand sessions. It is NOT needed for the org
  // cascade itself: deleteOrgCascade runs topologicalCascadeOrder(), which
  // recomputes an FK-safe order from pg_constraint, so sessions are always
  // deleted before the catalog regardless of alphabetical list position.
  catalogId: uuid('catalog_id').notNull().references(() => softwareCatalog.id, { onDelete: 'cascade' }),
  fileName: varchar('file_name', { length: 500 }).notNull(),
  fileSize: bigint('file_size', { mode: 'number' }).notNull(),
  chunkSize: integer('chunk_size').notNull(),
  bytesReceived: bigint('bytes_received', { mode: 'number' }).notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  tempPath: text('temp_path').notNull(),
  // Per-process boot id of the API instance that owns the temp file (stamped
  // at create from PROCESS_INSTANCE_ID in routes/softwareUploads.ts). Chunk
  // and complete requests landing on a different process fail fast with a
  // non-retryable 409 'upload_instance_mismatch' instead of an opaque resync
  // loop — the multi-replica-without-sticky-sessions tripwire.
  ownerInstanceId: varchar('owner_instance_id', { length: 64 }).notNull(),
  // Version metadata captured at session create (version, architecture,
  // releaseNotes, downloadUrl, supportedOs, silent args, pre/post scripts,
  // detectionRules) — validated by uploadVersionMetadataSchema before insert.
  versionMetadata: jsonb('version_metadata').notNull().default({}),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index('software_upload_sessions_org_id_idx').on(table.orgId),
  catalogIdx: index('software_upload_sessions_catalog_id_idx').on(table.catalogId),
  lastActivityIdx: index('software_upload_sessions_last_activity_idx').on(table.lastActivityAt),
}));
```

- [ ] **Step 4: Write the migration**

Create `apps/api/migrations/2026-08-11-software-upload-sessions.sql`. Pattern copied from `2026-08-06-d-device-mtls-certificate-history.sql` (the shape-1 reference). Idempotent throughout; no inner BEGIN/COMMIT (autoMigrate wraps the file in one transaction):

```sql
-- Chunked software-package upload sessions (issue #2951).
--
-- One row per in-flight dashboard upload. Chunks are appended to temp_path on
-- the API host's local filesystem; the row tracks bytes_received so an
-- interrupted upload can resume and duplicate chunks are idempotent. Rows are
-- deleted at complete/abort; the softwareUploadSessionCleanup BullMQ job reaps
-- sessions idle >2h OR older than 24h absolute (both env-tunable).
--
-- owner_instance_id pins each session to the API process that owns its temp
-- file: chunk/complete requests reaching a different process answer a
-- non-retryable 409 'upload_instance_mismatch' (multi-replica tripwire).
--
-- Tenancy: Shape 1 (direct org_id), auto-discovered by the RLS coverage
-- contract test — no allowlist entry. RLS is enabled AND forced with all four
-- breeze_has_org_access(org_id) policies in this same migration (never
-- deferred).
--
-- FK direction (deliberate): catalog_id -> software_catalog ON DELETE CASCADE,
-- org_id -> organizations ON DELETE CASCADE. These guard a direct DELETE on
-- either parent outside the org-erasure path. They are NOT required by the org
-- cascade itself: deleteOrgCascade calls topologicalCascadeOrder(), which
-- recomputes an FK-safe order from the live pg_constraint catalog, so this
-- table is always deleted before both parents no matter where it sits
-- alphabetically in CORE_ORG_CASCADE_DELETE_ORDER.
-- created_by -> users ON DELETE SET NULL: a
-- deleted user must not strand an in-flight upload row behind an FK error.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, guarded DO block for constraints,
-- CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before each CREATE POLICY.

CREATE TABLE IF NOT EXISTS software_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  catalog_id uuid NOT NULL REFERENCES software_catalog(id) ON DELETE CASCADE,
  file_name varchar(500) NOT NULL,
  file_size bigint NOT NULL,
  chunk_size integer NOT NULL,
  bytes_received bigint NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'active',
  temp_path text NOT NULL,
  owner_instance_id varchar(64) NOT NULL,
  version_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'software_upload_sessions_status_chk') THEN
    ALTER TABLE software_upload_sessions
      ADD CONSTRAINT software_upload_sessions_status_chk
      CHECK (status IN ('active', 'completed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'software_upload_sessions_size_chk') THEN
    ALTER TABLE software_upload_sessions
      ADD CONSTRAINT software_upload_sessions_size_chk
      CHECK (file_size > 0 AND bytes_received >= 0 AND bytes_received <= file_size);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS software_upload_sessions_org_id_idx
  ON software_upload_sessions(org_id);
CREATE INDEX IF NOT EXISTS software_upload_sessions_catalog_id_idx
  ON software_upload_sessions(catalog_id);
-- Reaper scan: stale-session sweep filters on last_activity_at.
CREATE INDEX IF NOT EXISTS software_upload_sessions_last_activity_idx
  ON software_upload_sessions(last_activity_at);

-- RLS: direct org_id (Shape 1) — standard org isolation, enabled AND forced.
ALTER TABLE software_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_upload_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON software_upload_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_upload_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_upload_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_upload_sessions;

CREATE POLICY breeze_org_isolation_select ON software_upload_sessions FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON software_upload_sessions FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON software_upload_sessions FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON software_upload_sessions FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON software_upload_sessions TO breeze_app;
```

- [ ] **Step 5: Apply the migration and check drift**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:migrate && pnpm db:check-drift`
Expected: migration applies cleanly; drift check reports no drift. Re-run `pnpm db:migrate` once more — must be a no-op (idempotency).

- [ ] **Step 6: Run the RLS test to verify it passes**

Run: `pnpm --filter @breeze/api test:integration softwareUploadSessionsRls`
Expected: PASS (3 tests). If it passes vacuously without `DATABASE_URL`, the `runDb` guard skipped — make sure the test DB env is up.

- [ ] **Step 7: Manual forge check as breeze_app**

Run: `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "INSERT INTO software_upload_sessions (org_id, catalog_id, file_name, file_size, chunk_size, temp_path, owner_instance_id) VALUES (gen_random_uuid(), gen_random_uuid(), 'x.msi', 10, 5, '/tmp/x', 'forge');"`
Expected: `ERROR:  new row violates row-level security policy` (no tenant context set).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/db/schema/software.ts apps/api/migrations/2026-08-11-software-upload-sessions.sql apps/api/src/__tests__/integration/softwareUploadSessionsRls.integration.test.ts
git commit -m "feat(api): software_upload_sessions table with forced RLS (#2951)"
```

---

### Task 2: Cascade + export-policy registration

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (insert into `CORE_ORG_CASCADE_DELETE_ORDER`, after `'software_policy_audit'` at line ~312)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (insert into `CORE_TENANT_EXPORT_POLICY`, after the `"software_policy_audit"` entry at line ~276)
- Test: existing contract suites (`tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`) — live DB required.

**Interfaces:**
- Consumes: the `software_upload_sessions` table from Task 1 (must be migrated into the test DB).
- Produces: nothing new — contract-list membership only.

- [ ] **Step 1: Run the contract tests to verify they fail**

Run: `pnpm --filter @breeze/api test:integration tenantCascade`
Expected: FAIL — "every org_id table present" assertion reports `software_upload_sessions` missing from `CORE_ORG_CASCADE_DELETE_ORDER`.

Run: `pnpm --filter @breeze/api test:integration tenant-export-policy`
Expected: FAIL — unclassified table/columns for `software_upload_sessions`.

- [ ] **Step 2: Register in the org cascade list**

In `apps/api/src/services/tenantCascade.ts`, insert one line into `CORE_ORG_CASCADE_DELETE_ORDER` between `'software_policy_audit'` and `'sql_instances'` (localeCompare order: `software_upload_sessions` < `sql_instances` because `'o' < 'q'` at position 2):

```ts
  'software_policy_audit',
  'software_upload_sessions',
  'sql_instances',
```

FK-direction note (verified, not assumed): the runtime DELETE order is computed topologically from the FK graph, and both FKs out of `software_upload_sessions` (`software_catalog`, `organizations`) carry `ON DELETE CASCADE`, so parent-first deletion cannot raise an FK violation. No other table references `software_upload_sessions` (it has no children).

- [ ] **Step 3: Classify every column in the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, insert into `CORE_TENANT_EXPORT_POLICY` between the `"software_policy_audit"` and `"sql_instances"` entries. `version_metadata` is jsonb → MUST be `excludedOpen` (open container; may embed pre/post-install scripts and detection rules). All other columns are ordinary tenant data/identifiers → `included`:

```ts
  "software_upload_sessions": tablePolicy("org_id", {"included":["id","org_id","catalog_id","file_name","file_size","chunk_size","bytes_received","status","temp_path","owner_instance_id","created_by","created_at","last_activity_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["version_metadata"]}),
```

- [ ] **Step 4: Run the contract tests to verify they pass**

Run: `pnpm --filter @breeze/api test:integration tenantCascade tenant-export-policy tenantExportErasureRoundtrip`
Expected: PASS (all three suites).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(api): register software_upload_sessions in org cascade + export policy"
```

---

### Task 3: Body-limit carve-out for the chunk path

**Files:**
- Modify: `apps/api/src/middleware/bodyLimit.ts` (add regex branch before the existing software upload carve-out at line 27)
- Test: `apps/api/src/middleware/bodyLimit.test.ts`

**Interfaces:**
- Produces: `bodyLimitForPath('/api/v1/software/catalog/<id>/versions/uploads/<uploadId>/chunks')` → `{ maxSize: 9 * 1024 * 1024, error: 'Chunk too large (max 8MB)' }`.

- [ ] **Step 1: Write the failing test**

Append to the existing `describe('bodyLimitForPath', ...)` in `apps/api/src/middleware/bodyLimit.test.ts`:

```ts
  // Chunked package uploads (#2951): each chunk is a raw octet-stream request
  // of at most 8MB (the client's UPLOAD_CHUNK_SIZE); 9MB gives the route's own
  // per-chunk size check headroom to answer with its specific message.
  it('carves out software upload-session chunks at 9MB', () => {
    expect(
      bodyLimitForPath(
        '/api/v1/software/catalog/11111111-1111-4111-8111-111111111111/versions/uploads/22222222-2222-4222-8222-222222222222/chunks',
      ),
    ).toEqual({
      maxSize: 9 * MB,
      error: 'Chunk too large (max 8MB)',
    });
    // Session create/status/complete/abort stay on the tight default.
    expect(
      bodyLimitForPath(
        '/api/v1/software/catalog/11111111-1111-4111-8111-111111111111/versions/uploads',
      ).maxSize,
    ).toBe(1 * MB);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/middleware/bodyLimit.test.ts`
Expected: FAIL — chunk path currently gets the 1MB default `{ maxSize: 1048576, error: 'Request body too large' }`.

- [ ] **Step 3: Add the carve-out**

In `apps/api/src/middleware/bodyLimit.ts`, insert immediately BEFORE the existing `/versions/upload` branch (line 24-29):

```ts
  // Chunked software package uploads (#2951): each chunk is a raw
  // application/octet-stream body of at most 8MB (client UPLOAD_CHUNK_SIZE,
  // server-validated chunk_size cap). 9MB headroom lets the route's own
  // per-chunk limit answer with its specific message instead of this one.
  if (path.match(/^\/api\/v1\/software\/catalog\/[^/]+\/versions\/uploads\/[^/]+\/chunks$/)) {
    return { maxSize: 9 * 1024 * 1024, error: 'Chunk too large (max 8MB)' };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/middleware/bodyLimit.test.ts`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/bodyLimit.ts apps/api/src/middleware/bodyLimit.test.ts
git commit -m "feat(api): body-limit carve-out for software upload chunks"
```

---

### Task 4: Extract shared upload helpers to `services/softwareVersionShared.ts`

Why: `software.ts` will mount the uploads router (Task 5), so the uploads router must NOT import from `software.ts` (import cycle). The five symbols both files need move to a service module; `software.ts` keeps identical behavior by importing them.

**Files:**
- Create: `apps/api/src/services/softwareVersionShared.ts`
- Test: `apps/api/src/services/softwareVersionShared.test.ts`
- Modify: `apps/api/src/routes/software.ts` (delete local definitions at lines 56-93 [`ResolveScopedOrgIdResult`, `AuthScopeContext`, `resolveScopedOrgId`], 138-139 [`ALLOWED_EXTENSIONS`, `MAX_UPLOAD_SIZE`], 151-174 [`getFileExtension`, `setLatestSoftwareVersion`], 360-373 [`insertLatestSoftwareVersion`]; add one import)

**Interfaces:**
- Produces (exact exports of `softwareVersionShared.ts`):
  - `export const ALLOWED_EXTENSIONS: Set<string>` — `.msi .exe .dmg .deb .pkg`
  - `export const MAX_UPLOAD_SIZE: number` — `500 * 1024 * 1024`
  - `export function getFileExtension(filename: string): string`
  - `export type AuthScopeContext = { scope: 'system' | 'partner' | 'organization'; orgId?: string | null; accessibleOrgIds?: string[] | null }`
  - `export type ResolveScopedOrgIdResult = { orgId: string } | { error: string; status: 400 | 403 }`
  - `export function resolveScopedOrgId(auth: AuthScopeContext, requestedOrgId?: string): ResolveScopedOrgIdResult`
  - `export type SoftwareVersionInsert = Omit<typeof softwareVersions.$inferInsert, 'catalogId' | 'isLatest'>`
  - `export async function setLatestSoftwareVersion(tx: DbTransaction, catalogId: string, versionId: string)`
  - `export async function insertLatestSoftwareVersion(catalogId: string, values: SoftwareVersionInsert)`
- Consumed by: `software.ts` (this task) and `softwareUploads.ts` (Tasks 5-7).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/softwareVersionShared.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { transaction: vi.fn() },
}));

import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_SIZE,
  getFileExtension,
  resolveScopedOrgId,
} from './softwareVersionShared';

describe('softwareVersionShared', () => {
  it('keeps the historical installer extension allowlist and 500MB cap', () => {
    expect([...ALLOWED_EXTENSIONS].sort()).toEqual(['.deb', '.dmg', '.exe', '.msi', '.pkg']);
    expect(MAX_UPLOAD_SIZE).toBe(500 * 1024 * 1024);
  });

  it('extracts lowercase extensions and empty string when there is none', () => {
    expect(getFileExtension('Setup.MSI')).toBe('.msi');
    expect(getFileExtension('archive.tar.gz')).toBe('.gz');
    expect(getFileExtension('no-extension')).toBe('');
  });

  it('resolveScopedOrgId: org scope is pinned to its own org', () => {
    expect(resolveScopedOrgId({ scope: 'organization', orgId: 'org-1' })).toEqual({ orgId: 'org-1' });
    expect(resolveScopedOrgId({ scope: 'organization', orgId: 'org-1' }, 'org-2')).toEqual({
      error: 'Access to this organization denied',
      status: 403,
    });
  });

  it('resolveScopedOrgId: partner scope needs an accessible requested org or a single accessible org', () => {
    expect(
      resolveScopedOrgId({ scope: 'partner', orgId: null, accessibleOrgIds: ['org-9'] }, 'org-9'),
    ).toEqual({ orgId: 'org-9' });
    expect(
      resolveScopedOrgId({ scope: 'partner', orgId: null, accessibleOrgIds: ['org-9'] }, 'org-2'),
    ).toEqual({ error: 'Access to this organization denied', status: 403 });
    expect(resolveScopedOrgId({ scope: 'partner', orgId: null, accessibleOrgIds: ['org-9'] })).toEqual({
      orgId: 'org-9',
    });
    expect(
      resolveScopedOrgId({ scope: 'partner', orgId: null, accessibleOrgIds: ['a', 'b'] }),
    ).toEqual({ error: 'orgId is required for this scope', status: 400 });
  });

  it('resolveScopedOrgId: system scope passes any requested org through', () => {
    expect(resolveScopedOrgId({ scope: 'system', orgId: null }, 'org-x')).toEqual({ orgId: 'org-x' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/softwareVersionShared.test.ts`
Expected: FAIL — `Cannot find module './softwareVersionShared'`.

- [ ] **Step 3: Create the shared module and rewire software.ts**

Create `apps/api/src/services/softwareVersionShared.ts` by MOVING (cut, not copy) the following from `apps/api/src/routes/software.ts`, unchanged except for imports:

```ts
/**
 * Helpers shared by the software catalog routes (routes/software.ts) and the
 * chunked upload-session routes (routes/softwareUploads.ts). Extracted so the
 * uploads router never imports routes/software.ts (which mounts it — cycle).
 * Behavior is identical to the pre-extraction definitions.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { softwareVersions } from '../db/schema';

export const ALLOWED_EXTENSIONS = new Set(['.msi', '.exe', '.dmg', '.deb', '.pkg']);
export const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB

export type SoftwareVersionInsert = Omit<typeof softwareVersions.$inferInsert, 'catalogId' | 'isLatest'>;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ResolveScopedOrgIdResult =
  | { orgId: string }
  | { error: string; status: 400 | 403 };

export type AuthScopeContext = {
  scope: 'system' | 'partner' | 'organization';
  orgId?: string | null;
  accessibleOrgIds?: string[] | null;
};

export function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

export function resolveScopedOrgId(
  auth: AuthScopeContext,
  requestedOrgId?: string,
): ResolveScopedOrgIdResult {
  // ...MOVE the body verbatim from routes/software.ts lines 66-93...
}

export async function setLatestSoftwareVersion(
  tx: DbTransaction,
  catalogId: string,
  versionId: string,
) {
  // ...MOVE the body verbatim from routes/software.ts lines 156-174...
}

export async function insertLatestSoftwareVersion(
  catalogId: string,
  values: SoftwareVersionInsert,
) {
  // ...MOVE the body verbatim from routes/software.ts lines 360-373...
}
```

(The three `...MOVE...` markers mean: paste the exact existing function bodies from `software.ts` — they compile unchanged against the imports above.)

Then in `apps/api/src/routes/software.ts`:
1. Delete the moved definitions (lines 56-93, 138-139, 151-154, 156-174, 360-373 in the pre-edit file).
2. Add to the imports block:

```ts
import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_SIZE,
  getFileExtension,
  resolveScopedOrgId,
  setLatestSoftwareVersion,
  insertLatestSoftwareVersion,
} from '../services/softwareVersionShared';
```

`resolveCatalogListScope` (lines 100-122) stays in `software.ts` — it depends on `softwareCatalog` and is only used there.

- [ ] **Step 4: Run tests to verify everything passes**

Run: `pnpm --filter @breeze/api exec vitest run src/services/softwareVersionShared.test.ts src/routes/software.test.ts`
Expected: PASS — the new suite AND the untouched `software.test.ts` (proves the extraction changed nothing). Note: `software.test.ts` has `vi.mock('../services', () => ({}))` for the services barrel only, not per-module mocks, so the real shared module loads — no test edits needed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/softwareVersionShared.ts apps/api/src/services/softwareVersionShared.test.ts apps/api/src/routes/software.ts
git commit -m "refactor(api): extract shared software version/upload helpers to a service module"
```

---

### Task 5: Upload-session create/status/abort routes

**Files:**
- Create: `apps/api/src/routes/softwareUploads.ts`
- Test: `apps/api/src/routes/softwareUploads.test.ts`
- Modify: `apps/api/src/routes/software.ts` (mount the uploads router at the very bottom of the file)

**Interfaces:**
- Consumes: Task 4 exports (`resolveScopedOrgId`, `getFileExtension`, `ALLOWED_EXTENSIONS`, `MAX_UPLOAD_SIZE`); `softwareUploadSessions`, `softwareCatalog` from `../db/schema`; `detectionRulesSchema` from `@breeze/shared`.
- Produces (HTTP contract used by all later tasks):
  - `POST /software/catalog/:id/versions/uploads` → 201 `{ data: { uploadId: string, bytesReceived: 0, chunkSize: number } }`; 400 bad extension / size / body; 404 unknown catalog item; 429 with a distinct `error` string per exceeded session cap (org-count / user-count / org-byte-budget — see the constants below).
  - `GET /software/catalog/:id/versions/uploads/:uploadId` → 200 `{ data: { uploadId, bytesReceived, fileSize, status } }`; 404.
  - `DELETE /software/catalog/:id/versions/uploads/:uploadId` → 200 `{ success: true }`; 404.
- Produces (module internals used by Tasks 6-7): `uploadSessionTempPath(uploadId): string`, `withSessionLock(uploadId, fn): Promise<T>`, `uploadVersionMetadataSchema`, `MIN_CHUNK_SIZE = 256 * 1024`, `MAX_CHUNK_SIZE = 8 * 1024 * 1024`, and the exported router `softwareUploadRoutes`.
- Produces (guard exports, used by Tasks 6-7 and 10): `PROCESS_INSTANCE_ID: string` (per-process boot id stamped into `owner_instance_id`); session caps `MAX_ACTIVE_UPLOAD_SESSIONS_PER_ORG = 5`, `MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER = 2`, `MAX_ACTIVE_UPLOAD_BYTES_PER_ORG = 2.5 * 1024 * 1024 * 1024`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/softwareUploads.test.ts`. The harness mirrors `software.test.ts` (chainMock proxy, mocked auth middleware with live gates, real classes for S3 errors). Real `node:fs` is used on purpose — the routes write only under `os.tmpdir()`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// ---- db mock (chain-friendly, per-test overridable) -----------------------
function chainMock(terminalValue: any) {
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      return (..._args: any[]) => new Proxy(
        () => Promise.resolve(terminalValue),
        {
          get(_t, p) {
            if (p === 'then') return (resolve: any) => resolve(terminalValue);
            return (..._a: any[]) => new Proxy(() => Promise.resolve(terminalValue), handler);
          },
          apply() {
            return Promise.resolve(terminalValue);
          },
        },
      );
    },
  };
  return new Proxy({}, handler);
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => chainMock([])),
    insert: vi.fn(() => chainMock([])),
    update: vi.fn(() => chainMock([])),
    delete: vi.fn(() => chainMock(undefined)),
    transaction: vi.fn(async (fn: any) => fn({
      update: vi.fn(() => chainMock([])),
      insert: vi.fn(() => chainMock([])),
    })),
  },
}));

vi.mock('../db/schema', () => ({
  softwareCatalog: { id: 'id', orgId: 'org_id', name: 'name' },
  softwareVersions: { id: 'id', catalogId: 'catalog_id', isLatest: 'is_latest' },
  softwareUploadSessions: {
    id: 'sus_id', orgId: 'sus_org_id', catalogId: 'sus_catalog_id',
    fileName: 'file_name', fileSize: 'file_size', chunkSize: 'chunk_size',
    bytesReceived: 'bytes_received', status: 'sus_status', tempPath: 'temp_path',
    ownerInstanceId: 'owner_instance_id',
    versionMetadata: 'version_metadata', createdBy: 'created_by',
    createdAt: 'sus_created_at', lastActivityAt: 'last_activity_at',
  },
}));

const { permissionGate, mfaGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      userId: 'user-123',
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

vi.mock('../services/s3Storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/s3Storage')>();
  return {
    uploadBinary: vi.fn(),
    getPresignedUrl: vi.fn(),
    isS3Configured: vi.fn(() => true),
    S3ConfigError: actual.S3ConfigError,
    S3OperationError: actual.S3OperationError,
  };
});

vi.mock('../services/softwareVersionShared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/softwareVersionShared')>();
  return { ...actual, insertLatestSoftwareVersion: vi.fn() };
});

import {
  softwareUploadRoutes,
  uploadSessionTempPath,
  PROCESS_INSTANCE_ID,
  MAX_ACTIVE_UPLOAD_SESSIONS_PER_ORG,
  MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER,
  MAX_ACTIVE_UPLOAD_BYTES_PER_ORG,
} from './softwareUploads';
import { db } from '../db';
import { insertLatestSoftwareVersion } from '../services/softwareVersionShared';
import { uploadBinary, isS3Configured, S3OperationError } from '../services/s3Storage';
import { writeRouteAudit } from '../services/auditEvents';

const CATALOG_ID = '11111111-1111-4111-8111-111111111111';
const UPLOAD_ID = '22222222-2222-4222-8222-222222222222';

const catalogRow = { id: CATALOG_ID, orgId: 'org-123', name: 'Big Installer' };

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: UPLOAD_ID,
    orgId: 'org-123',
    catalogId: CATALOG_ID,
    fileName: 'big.msi',
    fileSize: 10,
    chunkSize: 5,
    bytesReceived: 0,
    status: 'active',
    tempPath: uploadSessionTempPath(UPLOAD_ID),
    ownerInstanceId: PROCESS_INSTANCE_ID,
    versionMetadata: { version: '1.2.3' },
    ...overrides,
  };
}

/** Usage row returned by the create route's session-cap aggregate query. */
function makeUsage(overrides: Partial<{ orgActive: number; userActive: number; orgBytes: number }> = {}) {
  return { orgActive: 0, userActive: 0, orgBytes: 0, ...overrides };
}

/** Queue db.select() results in call order. */
function selectQueue(...results: unknown[][]) {
  for (const rows of results) {
    vi.mocked(db.select).mockReturnValueOnce(chainMock(rows) as any);
  }
}

describe('software upload-session routes', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    vi.mocked(isS3Configured).mockReturnValue(true);
    app = new Hono();
    app.route('/software', softwareUploadRoutes);
    await rm(uploadSessionTempPath(UPLOAD_ID), { force: true });
  });

  describe('POST /software/catalog/:id/versions/uploads (create)', () => {
    const validBody = {
      fileName: 'big.msi',
      fileSize: 10,
      chunkSize: 5 * 1024 * 1024,
      version: '1.2.3',
      architecture: 'x64',
    };

    it('creates a session and returns uploadId + bytesReceived 0', async () => {
      selectQueue([catalogRow], [makeUsage()]); // catalog lookup, then cap usage
      vi.mocked(db.insert).mockReturnValueOnce(
        chainMock([{ id: UPLOAD_ID, chunkSize: validBody.chunkSize }]) as any,
      );

      const res = await app.request(`/software/catalog/${CATALOG_ID}/versions/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, chunkSize: 5 * 1024 * 1024 }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.uploadId).toBeTruthy();
      expect(body.data.bytesReceived).toBe(0);
      expect(body.data.chunkSize).toBe(5 * 1024 * 1024);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    describe('session caps (local-disk DoS guard)', () => {
      const createReq = (fileSize = validBody.fileSize) =>
        app.request(`/software/catalog/${CATALOG_ID}/versions/uploads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...validBody, fileSize }),
        });

      it('allows a create AT every limit boundary', async () => {
        selectQueue(
          [catalogRow],
          [makeUsage({
            orgActive: MAX_ACTIVE_UPLOAD_SESSIONS_PER_ORG - 1,
            userActive: MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER - 1,
            // Declared bytes land exactly ON the budget: allowed.
            orgBytes: MAX_ACTIVE_UPLOAD_BYTES_PER_ORG - validBody.fileSize,
          })],
        );
        vi.mocked(db.insert).mockReturnValueOnce(chainMock([{ id: UPLOAD_ID }]) as any);

        const res = await createReq();
        expect(res.status).toBe(201);
      });

      it('429s the 6th concurrent session for an org', async () => {
        selectQueue([catalogRow], [makeUsage({ orgActive: MAX_ACTIVE_UPLOAD_SESSIONS_PER_ORG })]);
        const res = await createReq();
        expect(res.status).toBe(429);
        expect((await res.json()).error).toBe(
          'Too many concurrent package uploads for this organization',
        );
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('429s the 3rd concurrent session for a user', async () => {
        selectQueue(
          [catalogRow],
          [makeUsage({ orgActive: 2, userActive: MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER })],
        );
        const res = await createReq();
        expect(res.status).toBe(429);
        expect((await res.json()).error).toBe(
          'Too many concurrent package uploads for this user',
        );
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('429s when declared bytes would exceed the org upload budget', async () => {
        selectQueue(
          [catalogRow],
          [makeUsage({ orgActive: 1, orgBytes: MAX_ACTIVE_UPLOAD_BYTES_PER_ORG - validBody.fileSize + 1 })],
        );
        const res = await createReq();
        expect(res.status).toBe(429);
        expect((await res.json()).error).toBe(
          'Concurrent package uploads exceed the organization upload size budget',
        );
        expect(db.insert).not.toHaveBeenCalled();
      });
    });

    it('rejects a disallowed extension up front (before any bytes move)', async () => {
      const res = await app.request(`/software/catalog/${CATALOG_ID}/versions/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, fileName: 'evil.zip' }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Unsupported file type');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects fileSize over MAX_UPLOAD_SIZE up front', async () => {
      const res = await app.request(`/software/catalog/${CATALOG_ID}/versions/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, fileSize: 500 * 1024 * 1024 + 1 }),
      });
      expect(res.status).toBe(400);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('404s for a catalog item outside the caller org', async () => {
      selectQueue([]); // catalog lookup finds nothing
      const res = await app.request(`/software/catalog/${CATALOG_ID}/versions/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /software/catalog/:id/versions/uploads/:uploadId (status)', () => {
    it('returns bytesReceived/fileSize/status', async () => {
      selectQueue([makeSession({ bytesReceived: 5 })]);
      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}`,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({
        uploadId: UPLOAD_ID,
        bytesReceived: 5,
        fileSize: 10,
        status: 'active',
      });
    });

    it('404s for an unknown session', async () => {
      selectQueue([]);
      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /software/catalog/:id/versions/uploads/:uploadId (abort)', () => {
    it('removes the temp file and the session row', async () => {
      const tempPath = uploadSessionTempPath(UPLOAD_ID);
      await mkdir(dirname(tempPath), { recursive: true });
      await writeFile(tempPath, 'partial');
      selectQueue([makeSession()]);

      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(db.delete).toHaveBeenCalledTimes(1);
      await expect(readFile(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/softwareUploads.test.ts`
Expected: FAIL — `Cannot find module './softwareUploads'`.

- [ ] **Step 3: Write the route module (create/status/abort)**

Create `apps/api/src/routes/softwareUploads.ts`:

```ts
/**
 * Chunked, resumable software package uploads (issue #2951).
 *
 * Replaces the dashboard's single multipart request (which held one
 * Authorization header across a possibly >15min transfer, expiring the
 * access token mid-upload behind body-buffering reverse proxies) with:
 *
 *   POST   /catalog/:id/versions/uploads                   create session
 *   PUT    /catalog/:id/versions/uploads/:uploadId/chunks  append one chunk
 *   GET    /catalog/:id/versions/uploads/:uploadId         resume status
 *   POST   /catalog/:id/versions/uploads/:uploadId/complete finalize
 *   DELETE /catalog/:id/versions/uploads/:uploadId         abort + cleanup
 *
 * Each chunk is its own short request carrying a fresh token, so the 15m
 * TTL is never the binding constraint regardless of file size/link speed.
 *
 * DESIGN CONSTRAINT — single API instance per deployment: chunks append to
 * ONE temp file on the local filesystem (join(tmpdir(), 'breeze-uploads')),
 * exactly where the legacy multipart route stages its uploads. All chunks of
 * an upload must reach the same process. True for Breeze's per-region
 * droplet; a horizontally-scaled deployment would need shared partial
 * storage (out of scope). The sha256 is computed by streaming the completed
 * temp file once at /complete — no in-process hash state survives between
 * requests, so an API restart mid-upload only costs a resume, never a
 * corrupt checksum.
 *
 * The legacy POST /catalog/:id/versions/upload multipart route is untouched
 * and remains supported for scripts/API consumers.
 *
 * Mounted from routes/software.ts (softwareRoutes.route('/', ...)) AFTER its
 * `use('*', authMiddleware)`, so every handler runs behind auth. This module
 * must never import routes/software.ts (cycle) — shared helpers live in
 * services/softwareVersionShared.ts.
 */
import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, truncate, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from '../db';
import { softwareCatalog, softwareUploadSessions } from '../db/schema';
import { requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { captureException } from '../services/sentry';
import {
  uploadBinary,
  isS3Configured,
  S3ConfigError,
  S3OperationError,
} from '../services/s3Storage';
import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_SIZE,
  getFileExtension,
  insertLatestSoftwareVersion,
  resolveScopedOrgId,
} from '../services/softwareVersionShared';
import { detectionRulesSchema } from '@breeze/shared';

export const softwareUploadRoutes = new Hono();

const requireSoftwareWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);

export const MIN_CHUNK_SIZE = 256 * 1024; // 256 KB
export const MAX_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB — bodyLimit carve-out is 9MB

// Session caps — local-disk-exhaustion DoS guard. Each active session can pin
// up to MAX_UPLOAD_SIZE (500MB) of API-host temp disk, so concurrency must be
// bounded per tenant AND per user. Checked at create, before the row insert;
// each limit answers 429 with its own error string so the cause is diagnosable.
export const MAX_ACTIVE_UPLOAD_SESSIONS_PER_ORG = 5;
export const MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER = 2;
export const MAX_ACTIVE_UPLOAD_BYTES_PER_ORG = 2.5 * 1024 * 1024 * 1024; // 2.5 GB declared file_size, summed

// Per-process boot identity stamped into software_upload_sessions.owner_instance_id.
// The repo precedent is remoteWsSharedLease.ts's `remoteWsProcessInstanceId`
// (a module-level randomUUID() representing "this process boot"), but that
// constant is deliberately module-private to the remote-WS lease system — so we
// mirror the pattern here rather than import across subsystems. randomUUID()
// (not hostname) because two replicas on one host, or a restarted process whose
// tmp was cleared, must both read as "different owner".
export const PROCESS_INSTANCE_ID = randomUUID();

export function uploadSessionTempPath(uploadId: string): string {
  // Same staging dir as the legacy multipart route; distinct naming scheme
  // (`session-<uuid>.part` vs `<uuid>.upload`) so the reaper can never touch
  // the legacy route's in-flight files.
  return join(tmpdir(), 'breeze-uploads', `session-${uploadId}.part`);
}

// ---------------------------------------------------------------------------
// Per-session in-process write lock. The dashboard sends chunks sequentially,
// but a retried request racing its "lost" predecessor must never interleave
// appends to the same fd. Single-instance assumption makes this sufficient.
// ---------------------------------------------------------------------------
const sessionLocks = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(uploadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(uploadId) ?? Promise.resolve();
  const current = prev.then(
    () => fn(),
    () => fn(),
  );
  const tail = current.then(() => undefined, () => undefined);
  sessionLocks.set(uploadId, tail);
  try {
    return await current;
  } finally {
    if (sessionLocks.get(uploadId) === tail) sessionLocks.delete(uploadId);
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// Version metadata captured at session create and persisted (validated) into
// software_upload_sessions.version_metadata; /complete re-parses it before
// insert. Mirrors what the legacy multipart route accepts. supportedOs stays a
// free string array (the legacy upload route JSON.parses it unvalidated and
// the UI sends capitalized values like "Windows").
export const uploadVersionMetadataSchema = z.object({
  version: z.string().min(1).max(100),
  architecture: z.string().max(20).optional(),
  releaseNotes: z.string().max(5000).optional(),
  downloadUrl: z.string().url().optional(),
  supportedOs: z.array(z.string().max(50)).max(10).optional(),
  silentInstallArgs: z.string().max(2000).optional(),
  silentUninstallArgs: z.string().max(2000).optional(),
  preInstallScript: z.string().optional(),
  postInstallScript: z.string().optional(),
  detectionRules: detectionRulesSchema.optional(),
});

const createUploadSessionSchema = uploadVersionMetadataSchema.extend({
  fileName: z.string().min(1).max(500),
  fileSize: z.number().int().min(1).max(MAX_UPLOAD_SIZE),
  chunkSize: z.number().int().min(MIN_CHUNK_SIZE).max(MAX_CHUNK_SIZE),
});

const uploadParamSchema = z.object({
  id: z.string().guid(),
  uploadId: z.string().guid(),
});

// ---------------------------------------------------------------------------
// POST /catalog/:id/versions/uploads — create an upload session
// ---------------------------------------------------------------------------
softwareUploadRoutes.post(
  '/catalog/:id/versions/uploads',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('json', createUploadSessionSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const payload = c.req.valid('json');

    // Fail a doomed upload in the first second, not after 400MB.
    const ext = getFileExtension(payload.fileName);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return c.json(
        { error: `Unsupported file type: ${ext}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` },
        400,
      );
    }
    if (!isS3Configured()) {
      return c.json({ error: 'S3 storage is not configured' }, 503);
    }

    const catalogId = c.req.param('id')!;
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, catalogId), eq(softwareCatalog.orgId, orgId)));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

    const {
      fileName, fileSize, chunkSize,
      ...metadata
    } = payload;

    // Session caps: each active session can pin up to 500MB of API-host temp
    // disk for hours, so concurrency is bounded before the row is inserted.
    // One aggregate over the org's active sessions; pg returns count()/sum()
    // as strings, hence the Number() coercions.
    const [usage] = await db
      .select({
        orgActive: sql<number>`count(*)`,
        userActive: sql<number>`count(*) filter (where ${softwareUploadSessions.createdBy} = ${auth.userId ?? null})`,
        orgBytes: sql<number>`coalesce(sum(${softwareUploadSessions.fileSize}), 0)`,
      })
      .from(softwareUploadSessions)
      .where(and(
        eq(softwareUploadSessions.orgId, orgId),
        eq(softwareUploadSessions.status, 'active'),
      ));
    if (Number(usage?.orgActive ?? 0) >= MAX_ACTIVE_UPLOAD_SESSIONS_PER_ORG) {
      return c.json({ error: 'Too many concurrent package uploads for this organization' }, 429);
    }
    if (Number(usage?.userActive ?? 0) >= MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER) {
      return c.json({ error: 'Too many concurrent package uploads for this user' }, 429);
    }
    if (Number(usage?.orgBytes ?? 0) + fileSize > MAX_ACTIVE_UPLOAD_BYTES_PER_ORG) {
      return c.json({ error: 'Concurrent package uploads exceed the organization upload size budget' }, 429);
    }

    const uploadId = randomUUID();

    const [session] = await db.insert(softwareUploadSessions)
      .values({
        id: uploadId,
        orgId,
        catalogId,
        fileName,
        fileSize,
        chunkSize,
        bytesReceived: 0,
        status: 'active',
        tempPath: uploadSessionTempPath(uploadId),
        ownerInstanceId: PROCESS_INSTANCE_ID,
        versionMetadata: metadata,
        createdBy: auth.userId ?? null,
      })
      .returning();
    if (!session) return c.json({ error: 'Failed to create upload session' }, 500);

    return c.json({ data: { uploadId, bytesReceived: 0, chunkSize } }, 201);
  },
);

// ---------------------------------------------------------------------------
// GET /catalog/:id/versions/uploads/:uploadId — resume status
// ---------------------------------------------------------------------------
softwareUploadRoutes.get(
  '/catalog/:id/versions/uploads/:uploadId',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', uploadParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const { id: catalogId, uploadId } = c.req.valid('param');
    const [session] = await db.select().from(softwareUploadSessions).where(and(
      eq(softwareUploadSessions.id, uploadId),
      eq(softwareUploadSessions.orgId, orgResult.orgId),
      eq(softwareUploadSessions.catalogId, catalogId),
    ));
    if (!session) return c.json({ error: 'Upload session not found' }, 404);

    return c.json({
      data: {
        uploadId: session.id,
        bytesReceived: session.bytesReceived,
        fileSize: session.fileSize,
        status: session.status,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// DELETE /catalog/:id/versions/uploads/:uploadId — abort + cleanup
// ---------------------------------------------------------------------------
softwareUploadRoutes.delete(
  '/catalog/:id/versions/uploads/:uploadId',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', uploadParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const { id: catalogId, uploadId } = c.req.valid('param');
    return withSessionLock(uploadId, async () => {
      const [session] = await db.select().from(softwareUploadSessions).where(and(
        eq(softwareUploadSessions.id, uploadId),
        eq(softwareUploadSessions.orgId, orgResult.orgId),
        eq(softwareUploadSessions.catalogId, catalogId),
      ));
      if (!session) return c.json({ error: 'Upload session not found' }, 404);

      await unlink(session.tempPath).catch(() => {});
      await db.delete(softwareUploadSessions)
        .where(eq(softwareUploadSessions.id, uploadId));
      return c.json({ success: true });
    });
  },
);
```

Then at the very bottom of `apps/api/src/routes/software.ts` (after the last route registration), add:

```ts
// ---------------------------------------------------------------------------
// Chunked upload sessions (issue #2951). Mounted after `use('*',
// authMiddleware)` above, so the sub-router's handlers run behind auth.
// ---------------------------------------------------------------------------
import { softwareUploadRoutes } from './softwareUploads';
softwareRoutes.route('/', softwareUploadRoutes);
```

(Move the `import` up into the top import block — shown here inline only to indicate what to add.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/softwareUploads.test.ts src/routes/software.test.ts`
Expected: PASS — new suite green (chunk/complete describes come in Tasks 6-7); `software.test.ts` still green (mounting the sub-router must not disturb existing routes).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/softwareUploads.ts apps/api/src/routes/softwareUploads.test.ts apps/api/src/routes/software.ts
git commit -m "feat(api): software upload-session create/status/abort routes (#2951)"
```

---

### Task 6: Chunk append route (PUT …/chunks)

**Files:**
- Modify: `apps/api/src/routes/softwareUploads.ts` (add the PUT route between the create and GET routes)
- Test: `apps/api/src/routes/softwareUploads.test.ts` (new describe block)

**Interfaces:**
- Consumes: `withSessionLock`, `uploadSessionTempPath`, session row shape from Task 5.
- Produces: `PUT /software/catalog/:id/versions/uploads/:uploadId/chunks?offset=N` with raw `application/octet-stream` body →
  - 200 `{ data: { bytesReceived } }` on append **and** on duplicate (offset < bytesReceived, idempotent no-op);
  - 409 `{ error, bytesReceived }` when offset > bytesReceived (client must resync to `bytesReceived`), when the session is not active, or when upload state was lost (bytesReceived reset to 0);
  - 409 `{ error: 'upload_instance_mismatch', message, bytesReceived }` when the session's `owner_instance_id` is not this process — checked BEFORE the lock and before any filesystem work; the `error` token is the client's NON-RETRYABLE signal (Task 10);
  - 400 missing/invalid offset or empty body; 404 unknown session; 413 chunk exceeds allowed size.
- Produces (module internal shared with Task 7): `INSTANCE_MISMATCH_MESSAGE` (operator-actionable text naming API restart / load-balancer session affinity).

- [ ] **Step 1: Write the failing tests**

Add to `softwareUploads.test.ts` (inside the top-level describe; uses the existing `makeSession`/`selectQueue` helpers). The chunk route re-reads the session INSIDE the lock, so each request consumes exactly one `db.select` result:

```ts
  describe('PUT /software/catalog/:id/versions/uploads/:uploadId/chunks', () => {
    const chunkUrl = (offset: number) =>
      `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}/chunks?offset=${offset}`;

    const putChunk = (offset: number, body: string) =>
      app.request(chunkUrl(offset), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });

    // NB: every request that passes the pre-lock instance-ownership guard
    // consumes TWO db.select results — the guard's pre-read, then the
    // authoritative re-read inside the session lock.

    it('appends a first chunk at offset 0 and advances bytesReceived', async () => {
      selectQueue([makeSession()], [makeSession()]);
      vi.mocked(db.update).mockReturnValueOnce(chainMock([{ bytesReceived: 5 }]) as any);

      const res = await putChunk(0, 'hello');
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({ bytesReceived: 5 });

      const written = await readFile(uploadSessionTempPath(UPLOAD_ID), 'utf8');
      expect(written).toBe('hello');
    });

    it('appends a follow-up chunk at the recorded offset', async () => {
      await mkdir(dirname(uploadSessionTempPath(UPLOAD_ID)), { recursive: true });
      await writeFile(uploadSessionTempPath(UPLOAD_ID), 'hello');
      selectQueue([makeSession({ bytesReceived: 5 })], [makeSession({ bytesReceived: 5 })]);
      vi.mocked(db.update).mockReturnValueOnce(chainMock([{ bytesReceived: 10 }]) as any);

      const res = await putChunk(5, 'world');
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({ bytesReceived: 10 });
      expect(await readFile(uploadSessionTempPath(UPLOAD_ID), 'utf8')).toBe('helloworld');
    });

    it('treats a duplicate chunk at an already-consumed offset as an idempotent no-op', async () => {
      await mkdir(dirname(uploadSessionTempPath(UPLOAD_ID)), { recursive: true });
      await writeFile(uploadSessionTempPath(UPLOAD_ID), 'hello');
      selectQueue([makeSession({ bytesReceived: 5 })], [makeSession({ bytesReceived: 5 })]);

      const res = await putChunk(0, 'hello');
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({ bytesReceived: 5 });
      // Nothing was written and no CAS update ran.
      expect(await readFile(uploadSessionTempPath(UPLOAD_ID), 'utf8')).toBe('hello');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('409s with the authoritative bytesReceived on an offset gap', async () => {
      selectQueue([makeSession({ bytesReceived: 5 })], [makeSession({ bytesReceived: 5 })]);

      const res = await putChunk(9, 'x');
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.bytesReceived).toBe(5);
    });

    it('discards a garbage tail beyond bytesReceived before appending (truncate)', async () => {
      // A previous append died after writing 3 extra bytes past the recorded 5.
      await mkdir(dirname(uploadSessionTempPath(UPLOAD_ID)), { recursive: true });
      await writeFile(uploadSessionTempPath(UPLOAD_ID), 'helloGAR');
      selectQueue([makeSession({ bytesReceived: 5 })], [makeSession({ bytesReceived: 5 })]);
      vi.mocked(db.update).mockReturnValueOnce(chainMock([{ bytesReceived: 10 }]) as any);

      const res = await putChunk(5, 'world');
      expect(res.status).toBe(200);
      expect(await readFile(uploadSessionTempPath(UPLOAD_ID), 'utf8')).toBe('helloworld');
    });

    it('409s and resets to 0 when the temp file vanished but the DB says bytes exist', async () => {
      // No temp file on disk (tmp cleaned under a live process), bytesReceived = 5.
      selectQueue([makeSession({ bytesReceived: 5 })], [makeSession({ bytesReceived: 5 })]);
      vi.mocked(db.update).mockReturnValueOnce(chainMock([]) as any); // reset update

      const res = await putChunk(5, 'world');
      expect(res.status).toBe(409);
      expect((await res.json()).bytesReceived).toBe(0);
    });

    it('413s a chunk that exceeds the allowed size and rolls the file back', async () => {
      // chunkSize 5, so a 6-byte body at offset 0 overruns.
      selectQueue([makeSession()], [makeSession()]);

      const res = await putChunk(0, 'toobig'); // 6 bytes > chunkSize 5
      expect(res.status).toBe(413);
      // File rolled back to the offset (empty).
      const content = await readFile(uploadSessionTempPath(UPLOAD_ID), 'utf8').catch(() => '');
      expect(content).toBe('');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('400s a missing offset', async () => {
      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}/chunks`,
        { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' },
      );
      expect(res.status).toBe(400);
    });

    it('409s upload_instance_mismatch for a session owned by another process — before any write', async () => {
      // Pre-lock guard fires on the FIRST read; no second read, no fs work.
      selectQueue([makeSession({ ownerInstanceId: 'some-other-process' })]);

      const res = await putChunk(0, 'hello');
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('upload_instance_mismatch');
      expect(body.message).toMatch(/session affinity|single API/i);
      // Non-retryable signal: nothing was written or updated.
      expect(db.update).not.toHaveBeenCalled();
      await expect(readFile(uploadSessionTempPath(UPLOAD_ID))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/softwareUploads.test.ts`
Expected: FAIL — all new chunk tests 404 (route not registered).

- [ ] **Step 3: Implement the chunk route**

Add to `apps/api/src/routes/softwareUploads.ts` (after the create route). Note `zValidator('param', ...)` is not used here — the offset needs a custom error carrying `bytesReceived` semantics, and param UUIDs are already constrained by the session lookup:

```ts
class ChunkTooLargeError extends Error {}

// Non-retryable instance-ownership failure text (also used by /complete).
// Covers BOTH causes of a new PROCESS_INSTANCE_ID: an API restart (in-flight
// sessions cannot survive it — the temp file's ownership is process-scoped)
// and a second replica behind a non-sticky load balancer.
const INSTANCE_MISMATCH_MESSAGE =
  'This upload belongs to a different API process (the API restarted, or the request reached another replica). ' +
  'Start the upload again; if this recurs behind a load balancer, enable session affinity (sticky sessions) ' +
  'for /api/v1/software or run a single API replica.';

// ---------------------------------------------------------------------------
// PUT /catalog/:id/versions/uploads/:uploadId/chunks?offset=N — append chunk
//
// Contract (what makes per-chunk retry safe):
//   offset === bytesReceived  -> truncate any garbage tail, append, CAS-advance
//   offset  <  bytesReceived  -> duplicate delivery: idempotent no-op, 200
//   offset  >  bytesReceived  -> gap: 409 carrying authoritative bytesReceived
//   owner_instance_id !== PROCESS_INSTANCE_ID -> 409 upload_instance_mismatch,
//     checked BEFORE the lock/filesystem — terminal for the client (Task 10).
// ---------------------------------------------------------------------------
softwareUploadRoutes.put(
  '/catalog/:id/versions/uploads/:uploadId/chunks',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;
    const catalogId = c.req.param('id')!;
    const uploadId = c.req.param('uploadId')!;

    const offsetRaw = c.req.query('offset');
    const offset = Number(offsetRaw);
    if (offsetRaw === undefined || !Number.isSafeInteger(offset) || offset < 0) {
      return c.json({ error: 'offset query parameter must be a non-negative integer' }, 400);
    }
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'Chunk body is empty' }, 400);

    // Instance-ownership guard — BEFORE the lock and any filesystem work.
    // The temp file lives on the process that created the session; another
    // process can never append to it. Fail fast and non-retryably instead of
    // letting the client burn its 409-resync budget on an unwinnable loop.
    const [owned] = await db.select().from(softwareUploadSessions).where(and(
      eq(softwareUploadSessions.id, uploadId),
      eq(softwareUploadSessions.orgId, orgId),
      eq(softwareUploadSessions.catalogId, catalogId),
    ));
    if (!owned) return c.json({ error: 'Upload session not found' }, 404);
    if (owned.ownerInstanceId !== PROCESS_INSTANCE_ID) {
      return c.json(
        {
          error: 'upload_instance_mismatch',
          message: INSTANCE_MISMATCH_MESSAGE,
          bytesReceived: owned.bytesReceived,
        },
        409,
      );
    }

    return withSessionLock(uploadId, async () => {
      // Re-read INSIDE the lock so bytesReceived reflects the previous append.
      const [session] = await db.select().from(softwareUploadSessions).where(and(
        eq(softwareUploadSessions.id, uploadId),
        eq(softwareUploadSessions.orgId, orgId),
        eq(softwareUploadSessions.catalogId, catalogId),
      ));
      if (!session) return c.json({ error: 'Upload session not found' }, 404);
      if (session.status !== 'active') {
        return c.json(
          { error: 'Upload session is not active', bytesReceived: session.bytesReceived },
          409,
        );
      }

      if (offset < session.bytesReceived) {
        // Duplicate of an already-consumed chunk (the client retried after a
        // lost response). Idempotent no-op — report authoritative state.
        return c.json({ data: { bytesReceived: session.bytesReceived } });
      }
      if (offset > session.bytesReceived) {
        return c.json(
          { error: 'Chunk offset does not match received bytes', bytesReceived: session.bytesReceived },
          409,
        );
      }

      await mkdir(dirname(session.tempPath), { recursive: true });
      // Discard any garbage tail a previously-failed append left past the
      // recorded offset — the CAS below only ever advances from clean state.
      try {
        await truncate(session.tempPath, offset);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        if (offset > 0) {
          // DB says bytes exist but the temp file is gone — a tmp cleaner
          // (e.g. systemd-tmpfiles) removed it under a LIVE process. (A
          // restarted process never reaches here: its new PROCESS_INSTANCE_ID
          // trips the pre-lock instance guard first.) Reset so the client
          // restarts from 0.
          await db.update(softwareUploadSessions)
            .set({ bytesReceived: 0, lastActivityAt: new Date() })
            .where(eq(softwareUploadSessions.id, uploadId));
          return c.json({ error: 'Upload state lost; restart from offset 0', bytesReceived: 0 }, 409);
        }
        // offset 0 with no file yet: normal first chunk.
      }

      const maxChunkBytes = Math.min(session.chunkSize, session.fileSize - offset);
      let written = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          if (written > maxChunkBytes) {
            cb(new ChunkTooLargeError());
            return;
          }
          cb(null, chunk);
        },
      });

      try {
        await pipeline(
          Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
          counter,
          createWriteStream(session.tempPath, { flags: 'a' }),
        );
      } catch (err) {
        // Roll the file back so disk and DB agree on bytesReceived.
        await truncate(session.tempPath, offset).catch(() => {});
        if (err instanceof ChunkTooLargeError) {
          return c.json({ error: `Chunk exceeds allowed size (max ${maxChunkBytes} bytes)` }, 413);
        }
        captureException(err, c);
        return c.json({ error: 'Failed to store chunk' }, 500);
      }
      if (written === 0) return c.json({ error: 'Chunk body is empty' }, 400);

      const newBytesReceived = offset + written;
      // CAS: only advance from the offset we validated against. Under the
      // in-process lock this can only lose to an out-of-band write (should
      // never happen single-instance) — roll back the file and resync.
      const [updated] = await db.update(softwareUploadSessions)
        .set({ bytesReceived: newBytesReceived, lastActivityAt: new Date() })
        .where(and(
          eq(softwareUploadSessions.id, uploadId),
          eq(softwareUploadSessions.bytesReceived, offset),
        ))
        .returning({ bytesReceived: softwareUploadSessions.bytesReceived });
      if (!updated) {
        await truncate(session.tempPath, offset).catch(() => {});
        const [fresh] = await db
          .select({ bytesReceived: softwareUploadSessions.bytesReceived })
          .from(softwareUploadSessions)
          .where(eq(softwareUploadSessions.id, uploadId));
        return c.json(
          { error: 'Concurrent write detected', bytesReceived: fresh?.bytesReceived ?? 0 },
          409,
        );
      }

      return c.json({ data: { bytesReceived: updated.bytesReceived } });
    });
  },
);
```

Note for the "temp file vanished" test: that path performs the reset `db.update` and never reaches the CAS — the queued empty-array update mock covers it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/softwareUploads.test.ts`
Expected: PASS (all describes so far).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/softwareUploads.ts apps/api/src/routes/softwareUploads.test.ts
git commit -m "feat(api): chunk append route with offset CAS + idempotent duplicates (#2951)"
```

---

### Task 7: Complete route (finalize → S3 → version row → audit)

**Files:**
- Modify: `apps/api/src/routes/softwareUploads.ts` (add the complete route after the chunk route)
- Test: `apps/api/src/routes/softwareUploads.test.ts` (new describe block)

**Interfaces:**
- Consumes: Task 4's `insertLatestSoftwareVersion(catalogId, values)` and `getFileExtension`; `uploadBinary(tempPath, s3Key, checksum)`, `isS3Configured`, `S3ConfigError` (→503, `.clientMessage`), `S3OperationError` (→502, `.message` + `.failureCode`) from `../services/s3Storage` — this is the `software.ts:1023-1096` contract preserved verbatim, including the #2794 error mapping.
- Produces: `POST /software/catalog/:id/versions/uploads/:uploadId/complete` → 201 `{ data: versionRecord }`; 409 `{ error, bytesReceived, fileSize }` when incomplete; 409 `{ error: 'upload_instance_mismatch', message }` when `owner_instance_id` is not this process (pre-lock guard, same as Task 6, reusing `INSTANCE_MISMATCH_MESSAGE`); 503/502 storage mapping; 404 unknown session/catalog; deletes the session row + temp file on success.

- [ ] **Step 1: Write the failing tests**

Add to `softwareUploads.test.ts`:

```ts
  describe('POST /software/catalog/:id/versions/uploads/:uploadId/complete', () => {
    const completeUrl = `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}/complete`;

    async function seedTempFile(content: string) {
      const p = uploadSessionTempPath(UPLOAD_ID);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content);
      return p;
    }

    it('uploads to S3, inserts the version, audits, and cleans up', async () => {
      const tempPath = await seedTempFile('helloworld'); // 10 bytes
      // select #1: instance-guard pre-read; #2: session (inside lock); #3: catalog item.
      selectQueue(
        [makeSession({ bytesReceived: 10 })],
        [makeSession({ bytesReceived: 10 })],
        [catalogRow],
      );
      const versionRow = { id: 'ver-1', version: '1.2.3', isLatest: true };
      vi.mocked(insertLatestSoftwareVersion).mockResolvedValueOnce(versionRow as any);

      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(201);
      expect((await res.json()).data).toEqual(versionRow);

      // sha256('helloworld')
      expect(uploadBinary).toHaveBeenCalledWith(
        tempPath,
        expect.stringMatching(new RegExp(`^software/org-123/${CATALOG_ID}/[0-9a-f-]{36}/big\\.msi$`)),
        '936a185caaa266bb9cbe981e9e05cb78cd732b0b3280eb944412bb6f8f8f07af',
      );
      const insertArgs = vi.mocked(insertLatestSoftwareVersion).mock.calls[0];
      expect(insertArgs[0]).toBe(CATALOG_ID);
      expect(insertArgs[1]).toMatchObject({
        version: '1.2.3',
        fileType: 'msi',
        originalFileName: 'big.msi',
        fileSize: 10,
        // MSI defaults applied server-side, same as the legacy route:
        silentInstallArgs: 'msiexec /i "{file}" /qn /norestart',
        silentUninstallArgs: 'msiexec /x "{file}" /qn /norestart',
      });
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'software.catalog.version.upload',
        orgId: 'org-123',
      }));
      expect(db.delete).toHaveBeenCalledTimes(1); // session row removed
      await expect(readFile(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('409s when bytesReceived !== fileSize', async () => {
      selectQueue([makeSession({ bytesReceived: 4 })], [makeSession({ bytesReceived: 4 })]);
      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.bytesReceived).toBe(4);
      expect(body.fileSize).toBe(10);
      expect(uploadBinary).not.toHaveBeenCalled();
    });

    it('maps S3OperationError to 502 with the curated message (contract from #2794)', async () => {
      await seedTempFile('helloworld');
      selectQueue(
        [makeSession({ bytesReceived: 10 })],
        [makeSession({ bytesReceived: 10 })],
        [catalogRow],
      );
      vi.mocked(uploadBinary).mockRejectedValueOnce(
        new S3OperationError('Object storage rejected the upload', 'access_denied'),
      );

      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe('Object storage rejected the upload');
      expect(body.storageFailure).toBe('access_denied');
      // Session survives so the client may retry complete.
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('503s when S3 is not configured', async () => {
      selectQueue([makeSession({ bytesReceived: 10 })], [makeSession({ bytesReceived: 10 })]);
      vi.mocked(isS3Configured).mockReturnValue(false);
      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(503);
    });

    it('409s upload_instance_mismatch for a session owned by another process — before any S3/db work', async () => {
      selectQueue([makeSession({ bytesReceived: 10, ownerInstanceId: 'some-other-process' })]);

      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('upload_instance_mismatch');
      expect(body.message).toMatch(/session affinity|single API/i);
      expect(uploadBinary).not.toHaveBeenCalled();
      expect(insertLatestSoftwareVersion).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
    });
  });
```

Note: if `S3OperationError`'s constructor signature differs (check `apps/api/src/services/s3Storage.ts:38`), construct it exactly as `software.test.ts`'s "object storage failure mapping" describe (line ~456) does and assert the same fields.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/softwareUploads.test.ts`
Expected: FAIL — complete tests 404 (route not registered).

- [ ] **Step 3: Implement the complete route**

Add to `apps/api/src/routes/softwareUploads.ts`:

```ts
// ---------------------------------------------------------------------------
// POST /catalog/:id/versions/uploads/:uploadId/complete — finalize
//
// Preserves the legacy multipart route's tail verbatim (software.ts
// ~1023-1096): uploadBinary -> insertLatestSoftwareVersion -> writeRouteAudit
// -> temp cleanup, including the #2794 S3ConfigError→503 / S3OperationError→502
// mapping. sha256 is computed by streaming the assembled temp file once here
// (design choice: no in-process hash state; an API restart mid-upload can
// never yield a checksum over the wrong bytes).
// ---------------------------------------------------------------------------
softwareUploadRoutes.post(
  '/catalog/:id/versions/uploads/:uploadId/complete',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', uploadParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;
    const { id: catalogId, uploadId } = c.req.valid('param');

    // Instance-ownership guard — BEFORE the lock and before any S3/db work
    // (same contract as the chunk route; complete reads the temp file, which
    // only exists on the owning process).
    const [owned] = await db.select().from(softwareUploadSessions).where(and(
      eq(softwareUploadSessions.id, uploadId),
      eq(softwareUploadSessions.orgId, orgId),
      eq(softwareUploadSessions.catalogId, catalogId),
    ));
    if (!owned) return c.json({ error: 'Upload session not found' }, 404);
    if (owned.ownerInstanceId !== PROCESS_INSTANCE_ID) {
      return c.json(
        { error: 'upload_instance_mismatch', message: INSTANCE_MISMATCH_MESSAGE },
        409,
      );
    }

    return withSessionLock(uploadId, async () => {
      const [session] = await db.select().from(softwareUploadSessions).where(and(
        eq(softwareUploadSessions.id, uploadId),
        eq(softwareUploadSessions.orgId, orgId),
        eq(softwareUploadSessions.catalogId, catalogId),
      ));
      if (!session) return c.json({ error: 'Upload session not found' }, 404);
      if (session.status !== 'active') {
        return c.json({ error: 'Upload session is not active' }, 409);
      }
      if (session.bytesReceived !== session.fileSize) {
        return c.json(
          {
            error: 'Upload is incomplete',
            bytesReceived: session.bytesReceived,
            fileSize: session.fileSize,
          },
          409,
        );
      }
      if (!isS3Configured()) {
        return c.json({ error: 'S3 storage is not configured' }, 503);
      }

      const [catalogItem] = await db.select().from(softwareCatalog)
        .where(and(eq(softwareCatalog.id, catalogId), eq(softwareCatalog.orgId, orgId)));
      if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

      let checksum: string;
      try {
        const hash = createHash('sha256');
        await pipeline(createReadStream(session.tempPath), hash);
        checksum = hash.digest('hex');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          await db.update(softwareUploadSessions)
            .set({ bytesReceived: 0, lastActivityAt: new Date() })
            .where(eq(softwareUploadSessions.id, uploadId));
          return c.json({ error: 'Upload state lost; restart from offset 0', bytesReceived: 0 }, 409);
        }
        captureException(err, c);
        return c.json({ error: 'Failed to read uploaded package' }, 500);
      }

      // version_metadata was validated at create; re-parse defensively so a
      // hand-edited row can't smuggle unvalidated data into the version insert.
      const parsedMeta = uploadVersionMetadataSchema.safeParse(session.versionMetadata);
      if (!parsedMeta.success) {
        return c.json({ error: 'Stored version metadata is invalid' }, 500);
      }
      const meta = parsedMeta.data;

      const fileType = getFileExtension(session.fileName).slice(1);
      // Auto-detect MSI silent args (parity with the legacy multipart route).
      let silentInstallArgs = meta.silentInstallArgs ?? null;
      let silentUninstallArgs = meta.silentUninstallArgs ?? null;
      if (fileType === 'msi' && !silentInstallArgs) {
        silentInstallArgs = 'msiexec /i "{file}" /qn /norestart';
      }
      if (fileType === 'msi' && !silentUninstallArgs) {
        silentUninstallArgs = 'msiexec /x "{file}" /qn /norestart';
      }

      const versionId = randomUUID();
      const s3Key = `software/${orgId}/${catalogId}/${versionId}/${session.fileName}`;

      try {
        await uploadBinary(session.tempPath, s3Key, checksum);
      } catch (err) {
        captureException(err, c);
        if (err instanceof S3ConfigError) {
          return c.json({ error: err.clientMessage }, 503);
        }
        if (err instanceof S3OperationError) {
          return c.json({ error: err.message, storageFailure: err.failureCode }, 502);
        }
        return c.json(
          {
            error:
              'Upload to object storage failed before the request was sent. Check the API server logs for details.',
          },
          502,
        );
      }

      const versionRecord = await insertLatestSoftwareVersion(catalogId, {
        id: versionId,
        version: meta.version,
        releaseDate: new Date(),
        releaseNotes: meta.releaseNotes ?? null,
        downloadUrl: meta.downloadUrl ?? null,
        s3Key,
        fileType,
        originalFileName: session.fileName,
        checksum,
        fileSize: session.fileSize,
        supportedOs: meta.supportedOs ?? null,
        architecture: meta.architecture ?? null,
        silentInstallArgs,
        silentUninstallArgs,
        preInstallScript: meta.preInstallScript ?? null,
        postInstallScript: meta.postInstallScript ?? null,
        detectionRules: meta.detectionRules ?? null,
      });
      if (!versionRecord) {
        return c.json({ error: 'Failed to create uploaded software version' }, 500);
      }

      writeRouteAudit(c, {
        orgId,
        action: 'software.catalog.version.upload',
        resourceType: 'software_version',
        resourceId: versionRecord.id,
        resourceName: catalogItem.name,
        details: {
          version: meta.version,
          fileType,
          fileSize: session.fileSize,
          checksum,
          uploadId,
        },
      });

      await db.delete(softwareUploadSessions)
        .where(eq(softwareUploadSessions.id, uploadId));
      await unlink(session.tempPath).catch(() => {});

      return c.json({ data: versionRecord }, 201);
    });
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/softwareUploads.test.ts`
Expected: PASS (all four describes).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/softwareUploads.ts apps/api/src/routes/softwareUploads.test.ts
git commit -m "feat(api): upload-session complete route reusing S3 + version insert tail (#2951)"
```

---

### Task 8: Orphaned-session reaper (BullMQ)

**Files:**
- Create: `apps/api/src/jobs/softwareUploadSessionCleanup.ts`
- Test: `apps/api/src/jobs/softwareUploadSessionCleanup.test.ts`
- Modify: `apps/api/src/index.ts` (worker init list ~line 1291-1302; shutdown list ~line 1508-1513)

**Interfaces:**
- Consumes: `softwareUploadSessions` schema; `withSystemDbAccessContext` from `../db`; `getBullMQConnection` from `../services/redis`.
- Produces: `initializeSoftwareUploadSessionCleanupWorker(): Promise<void>`, `shutdownSoftwareUploadSessionCleanupWorker(): Promise<void>` (wired into `index.ts`).
- Pattern source: copy `apps/api/src/jobs/enrollmentKeyCleanup.ts` structurally (queue/worker/schedule/env-gate/`__testOnly`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/jobs/softwareUploadSessionCleanup.test.ts`, mirroring `enrollmentKeyCleanup.test.ts`'s harness (hoisted mocks for bullmq Queue/Worker capturing the processor; `../db` mock with `withSystemDbAccessContext` passthrough). Additionally mock `node:fs/promises` to observe unlinks:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock, getRepeatableJobsMock, removeRepeatableByKeyMock,
  selectMock, deleteMock, unlinkMock,
  withSystemDbAccessContextMock, capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(async () => []),
  removeRepeatableByKeyMock: vi.fn(),
  selectMock: vi.fn(),
  deleteMock: vi.fn(),
  unlinkMock: vi.fn(async () => undefined),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  capturedWorkerProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public name: string) {}
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = vi.fn();
  },
  Worker: class {
    constructor(public name: string, processor: (job: unknown) => Promise<unknown>) {
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));

vi.mock('node:fs/promises', () => ({ unlink: unlinkMock }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

// Wrap the condition builders in spies (behavior preserved, same pattern as
// software.test.ts) so tests can assert BOTH reap conditions — idle and
// absolute age — are built, independently, with the right cutoffs.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, lt: vi.fn(actual.lt), or: vi.fn(actual.or) };
});
import { lt, or } from 'drizzle-orm';

vi.mock('../db', () => ({
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => withSystemDbAccessContextMock(fn),
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  },
}));

vi.mock('../db/schema', () => ({
  softwareUploadSessions: {
    id: 'id', tempPath: 'temp_path',
    lastActivityAt: 'last_activity_at', createdAt: 'created_at',
  },
}));

import {
  initializeSoftwareUploadSessionCleanupWorker,
  __testOnly,
} from './softwareUploadSessionCleanup';

describe('softwareUploadSessionCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    getRepeatableJobsMock.mockResolvedValue([]);
    delete process.env.SOFTWARE_UPLOAD_SESSION_CLEANUP_ENABLED;
    delete process.env.SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS;
    delete process.env.SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS;
  });

  it('registers an hourly repeatable job with a fixed jobId', async () => {
    await initializeSoftwareUploadSessionCleanupWorker();
    expect(addMock).toHaveBeenCalledWith(
      __testOnly.JOB_NAME,
      {},
      expect.objectContaining({
        jobId: __testOnly.REPEAT_JOB_ID,
        repeat: { pattern: __testOnly.HOURLY_CRON },
      }),
    );
  });

  it('skips scheduling when disabled via env', async () => {
    process.env.SOFTWARE_UPLOAD_SESSION_CLEANUP_ENABLED = 'false';
    await initializeSoftwareUploadSessionCleanupWorker();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('unlinks each stale temp file then deletes the rows, at system scope', async () => {
    await initializeSoftwareUploadSessionCleanupWorker();
    const stale = [
      { id: 's-1', tempPath: '/tmp/breeze-uploads/session-s-1.part' },
      { id: 's-2', tempPath: '/tmp/breeze-uploads/session-s-2.part' },
    ];
    selectMock.mockReturnValueOnce({
      from: () => ({ where: () => Promise.resolve(stale) }),
    });
    deleteMock.mockReturnValueOnce({
      where: () => Promise.resolve(undefined),
    });

    const result = await capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME });
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledTimes(2);
    expect(unlinkMock).toHaveBeenCalledWith('/tmp/breeze-uploads/session-s-1.part');
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ deletedCount: 2 });
  });

  it('reaps on BOTH ceilings independently: idle (2h, last_activity_at) OR absolute age (24h, created_at)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    await initializeSoftwareUploadSessionCleanupWorker();
    selectMock.mockReturnValueOnce({
      from: () => ({ where: () => Promise.resolve([]) }),
    });

    await capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME });

    // Idle condition: last_activity_at < now - 2h.
    expect(lt).toHaveBeenCalledWith(
      'last_activity_at',
      new Date('2026-08-02T10:00:00.000Z'),
    );
    // Absolute-lifetime condition: created_at < now - 24h — fires even for a
    // session that keeps itself warm forever.
    expect(lt).toHaveBeenCalledWith(
      'created_at',
      new Date('2026-08-01T12:00:00.000Z'),
    );
    // The two conditions are OR'd — either alone is sufficient to reap.
    expect(or).toHaveBeenCalledTimes(1);
  });

  it('honors both env knobs independently', async () => {
    process.env.SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS = '6';
    process.env.SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS = '48';
    expect(__testOnly.getIdleTtlHours()).toBe(6);
    expect(__testOnly.getMaxAgeHours()).toBe(48);

    process.env.SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS = 'garbage';
    process.env.SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS = '-1';
    expect(__testOnly.getIdleTtlHours()).toBe(__testOnly.DEFAULT_IDLE_TTL_HOURS);
    expect(__testOnly.getMaxAgeHours()).toBe(__testOnly.DEFAULT_MAX_AGE_HOURS);
  });

  it('is a no-op when nothing is stale', async () => {
    await initializeSoftwareUploadSessionCleanupWorker();
    selectMock.mockReturnValueOnce({
      from: () => ({ where: () => Promise.resolve([]) }),
    });
    const result = await capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME });
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deletedCount: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/jobs/softwareUploadSessionCleanup.test.ts`
Expected: FAIL — `Cannot find module './softwareUploadSessionCleanup'`.

- [ ] **Step 3: Implement the reaper**

Create `apps/api/src/jobs/softwareUploadSessionCleanup.ts` (structure copied from `enrollmentKeyCleanup.ts` — read it first; only the domain logic differs):

```ts
/**
 * Software Upload Session Cleanup Worker (issue #2951).
 *
 * Chunked package uploads stage bytes in a temp file under
 * join(tmpdir(), 'breeze-uploads') with one software_upload_sessions row per
 * upload. Abandoned uploads (browser closed, tab killed, network gone) leave
 * both behind. This sweep hard-deletes sessions that trip EITHER ceiling:
 *   - idle: last_activity_at older than SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS
 *     (default 2 — each session can pin up to 500MB of temp disk, so idle
 *     sessions must not linger for a day);
 *   - absolute lifetime: created_at older than
 *     SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS (default 24) REGARDLESS of
 *     activity, so a client that keeps a session warm forever cannot pin
 *     disk indefinitely.
 * Each session's temp file is unlinked first (best-effort: ENOENT after a
 * restart that cleared tmp is fine).
 *
 * Only files named by the sessions' own temp_path are ever touched — the
 * legacy multipart route's `<uuid>.upload` staging files are invisible here.
 *
 * Scheduling: hourly cron ('15 * * * *'), jobId-deduped across replicas.
 * RLS: runs inside withSystemDbAccessContext (background job, all tenants).
 * Idempotent: re-running finds zero stale rows.
 * Env: SOFTWARE_UPLOAD_SESSION_CLEANUP_ENABLED (default on),
 *      SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS (default 2),
 *      SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS (default 24).
 */
import { Queue, Worker, Job } from 'bullmq';
import { inArray, lt, or } from 'drizzle-orm';
import { unlink } from 'node:fs/promises';
import { db, withSystemDbAccessContext } from '../db';
import { softwareUploadSessions } from '../db/schema';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';

const QUEUE_NAME = 'software-upload-session-cleanup';
const JOB_NAME = 'software-upload-session-cleanup';
const REPEAT_JOB_ID = 'software-upload-session-cleanup';
// Hourly at :15 — staggered from the 02:00/03:00/04:00 daily jobs.
const HOURLY_CRON = '15 * * * *';
const DEFAULT_IDLE_TTL_HOURS = 2;
const DEFAULT_MAX_AGE_HOURS = 24;

function isCleanupEnabled(): boolean {
  const raw = process.env.SOFTWARE_UPLOAD_SESSION_CLEANUP_ENABLED;
  if (raw === undefined || raw === '') return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getIdleTtlHours(): number {
  return readPositiveIntEnv('SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS', DEFAULT_IDLE_TTL_HOURS);
}

function getMaxAgeHours(): number {
  return readPositiveIntEnv('SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS', DEFAULT_MAX_AGE_HOURS);
}

let cleanupQueue: Queue | null = null;
let cleanupWorker: Worker | null = null;

export function getSoftwareUploadSessionCleanupQueue(): Queue {
  if (!cleanupQueue) {
    cleanupQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return cleanupQueue;
}

export function createSoftwareUploadSessionCleanupWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[SoftwareUploadSessionCleanup] Ignoring unknown job name: ${job.name}`);
        return { deletedCount: 0, skipped: true };
      }
      return withSystemDbAccessContext(async () => {
        const startedAt = Date.now();
        const idleTtlHours = getIdleTtlHours();
        const maxAgeHours = getMaxAgeHours();
        const idleCutoff = new Date(Date.now() - idleTtlHours * 3_600_000);
        const maxAgeCutoff = new Date(Date.now() - maxAgeHours * 3_600_000);

        // Two independent ceilings, OR'd: idle (no chunk activity) and
        // absolute lifetime (created too long ago, however warm).
        const stale = await db
          .select({
            id: softwareUploadSessions.id,
            tempPath: softwareUploadSessions.tempPath,
          })
          .from(softwareUploadSessions)
          .where(or(
            lt(softwareUploadSessions.lastActivityAt, idleCutoff),
            lt(softwareUploadSessions.createdAt, maxAgeCutoff),
          ));

        if (stale.length === 0) {
          return { deletedCount: 0, durationMs: Date.now() - startedAt };
        }

        // Unlink first: once the row is gone the path is unrecoverable, so a
        // failed unlink would strand the file forever. ENOENT is fine.
        for (const session of stale) {
          await unlink(session.tempPath).catch(() => {});
        }
        await db
          .delete(softwareUploadSessions)
          .where(inArray(softwareUploadSessions.id, stale.map((s) => s.id)));

        const durationMs = Date.now() - startedAt;
        console.log(
          `[SoftwareUploadSessionCleanup] Deleted ${stale.length} stale upload session(s) (idle>${idleTtlHours}h or age>${maxAgeHours}h) in ${durationMs}ms`,
        );
        return { deletedCount: stale.length, durationMs };
      });
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function scheduleSoftwareUploadSessionCleanup(
  queue: Queue = getSoftwareUploadSessionCleanupQueue(),
): Promise<void> {
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  if (!isCleanupEnabled()) {
    console.log(
      '[SoftwareUploadSessionCleanup] SOFTWARE_UPLOAD_SESSION_CLEANUP_ENABLED=false — skipping schedule registration',
    );
    return;
  }
  await queue.add(
    JOB_NAME,
    {},
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern: HOURLY_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );
}

export async function initializeSoftwareUploadSessionCleanupWorker(): Promise<void> {
  try {
    cleanupWorker = createSoftwareUploadSessionCleanupWorker();
    cleanupWorker.on('error', (error) => {
      console.error('[SoftwareUploadSessionCleanup] Worker error:', error);
      captureException(error);
    });
    cleanupWorker.on('failed', (job, error) => {
      console.error(`[SoftwareUploadSessionCleanup] Job ${job?.id} failed:`, error);
      captureException(error);
    });
    await scheduleSoftwareUploadSessionCleanup();
    console.log('[SoftwareUploadSessionCleanup] Worker initialized');
  } catch (error) {
    console.error('[SoftwareUploadSessionCleanup] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownSoftwareUploadSessionCleanupWorker(): Promise<void> {
  if (cleanupWorker) {
    await cleanupWorker.close();
    cleanupWorker = null;
  }
  if (cleanupQueue) {
    await cleanupQueue.close();
    cleanupQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  HOURLY_CRON,
  DEFAULT_IDLE_TTL_HOURS,
  DEFAULT_MAX_AGE_HOURS,
  isCleanupEnabled,
  getIdleTtlHours,
  getMaxAgeHours,
};
```

Wire into `apps/api/src/index.ts`:
1. Add next to the `enrollmentKeyCleanup` import (~line 215):
```ts
import {
  initializeSoftwareUploadSessionCleanupWorker,
  shutdownSoftwareUploadSessionCleanupWorker,
} from './jobs/softwareUploadSessionCleanup';
```
2. Add `['softwareUploadSessionCleanup', initializeSoftwareUploadSessionCleanupWorker],` to the worker-init tuple list (next to `['enrollmentKeyCleanup', ...]` at ~line 1302).
3. Add `shutdownSoftwareUploadSessionCleanupWorker,` to the shutdown list (next to `shutdownEnrollmentKeyCleanupWorker` at ~line 1513).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/jobs/softwareUploadSessionCleanup.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/softwareUploadSessionCleanup.ts apps/api/src/jobs/softwareUploadSessionCleanup.test.ts apps/api/src/index.ts
git commit -m "feat(api): reaper for abandoned software upload sessions (#2951)"
```

---

### Task 9: fetchWithAuth fixes (readable abort, 401-retry signal, Content-Type)

**Files:**
- Modify: `apps/web/src/stores/auth.ts` (lines ~571-625 in the pre-edit file)
- Test: `apps/web/src/stores/auth.test.ts` (append to the existing `describe('auth store fetchWithAuth')`)

**Interfaces:**
- Produces (behavior contract the uploader in Task 10 relies on):
  1. The internal timeout abort carries a reason: callers see `Error`/`DOMException` whose message matches `/timed out after \d+s/` — never the bare `"signal is aborted without reason"`.
  2. Both 401 retry fetches carry the same `signal` as the original request (no more unabortable retries that replay a whole body forever).
  3. A caller-provided `Content-Type` header is preserved; the JSON default is only applied when the caller set none (required for `application/octet-stream` chunk PUTs).

- [ ] **Step 1: Write the failing tests**

Append inside `describe('auth store fetchWithAuth', ...)` in `apps/web/src/stores/auth.test.ts` (reuse the file's existing `baseUser`/`baseTokens`/`makeResponse` helpers):

```ts
  it('preserves a caller-provided Content-Type instead of forcing JSON', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithAuth('/software/catalog/c1/versions/uploads/u1/chunks?offset=0', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'raw-bytes',
    });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Headers).get('Content-Type')).toBe('application/octet-stream');
  });

  it('rejects a timed-out request with a readable error, not "signal is aborted without reason"', async () => {
    vi.useFakeTimers();
    try {
      useAuthStore.getState().login(baseUser, baseTokens);
      // fetch that only settles when its signal aborts, rejecting with the
      // signal's reason — exactly what real fetch does.
      const fetchMock = vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () =>
              reject(options.signal?.reason ?? new DOMException('signal is aborted without reason', 'AbortError')),
            );
          }),
      );
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const pending = fetchWithAuth('/devices');
      const assertion = expect(pending).rejects.toThrow(/timed out after 30s/);
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the abort signal through to the 401 retry request', async () => {
    useAuthStore.getState().login(baseUser, baseTokens);
    const fetchMock = vi.fn()
      // 1st: original request → 401
      .mockResolvedValueOnce(makeResponse({ error: 'expired' }, false, 401))
      // 2nd: /auth/refresh → new tokens
      .mockResolvedValueOnce(
        makeResponse({ success: true, tokens: { accessToken: 'access-new', expiresInSeconds: 900 } }),
      )
      // 3rd: replayed original request → 200
      .mockResolvedValueOnce(makeResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithAuth('/devices', { method: 'POST', body: JSON.stringify({}) });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retryOptions = fetchMock.mock.calls[2][1] as RequestInit;
    expect(retryOptions.signal).toBeInstanceOf(AbortSignal);
  });
```

Note: if the second test's refresh-response shape doesn't match how `requestTokenRefreshShared` parses `/auth/refresh` (check the existing 401-refresh tests around lines 288-346 of `auth.test.ts`), copy the refresh mock shape from those tests verbatim.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @breeze/web exec vitest run src/stores/auth.test.ts`
Expected: FAIL —
- Content-Type test: header comes back `application/json` (clobbered).
- Timeout test: rejection is the reasonless `AbortError`, not `/timed out after 30s/`.
- Retry-signal test: `retryOptions.signal` is `undefined`.

- [ ] **Step 3: Implement the three fixes**

In `apps/web/src/stores/auth.ts`:

1. Content-Type (line ~580): only default when the caller didn't set one —
```ts
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
```

2. Readable timeout abort (line ~592): pass a reason so the DOMException text is diagnosable —
```ts
  const controller = !externalSignal ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(
        () =>
          controller.abort(
            new DOMException(
              `Request timed out after ${Math.round(timeoutMs / 1000)}s`,
              'TimeoutError',
            ),
          ),
        timeoutMs,
      )
    : null;
```

3. 401 retry signal (lines ~613 and ~619): both replay fetches gain `signal` —
```ts
      response = await fetch(buildApiUrl(url), { ...options, headers, credentials: 'include', signal });
```
(apply identically to the `newTokens` branch and the `latestToken` branch).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/web exec vitest run src/stores/auth.test.ts src/stores/auth.passkeys.test.ts`
Expected: PASS — the 3 new tests AND every pre-existing test (in particular the existing "does not force a JSON content-type on FormData bodies" and upload-timeout tests still pass).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/stores/auth.ts apps/web/src/stores/auth.test.ts
git commit -m "fix(web): readable upload timeouts, abortable 401 retries, caller Content-Type (#2951)"
```

---

### Task 10: Client uploader module `softwarePackageUpload.ts`

**Files:**
- Create: `apps/web/src/lib/softwarePackageUpload.ts`
- Test: `apps/web/src/lib/softwarePackageUpload.test.ts`
- Modify: `apps/web/src/lib/runActionAllowlist.ts` (add allowlist entry)

**Interfaces:**
- Consumes: `fetchWithAuth` from `../stores/auth` (Task 9 behavior); server contract from Tasks 5-7.
- Produces (exact exports used by Tasks 11-12):
```ts
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export interface PackageVersionMetadata {
  version: string;
  architecture?: string;
  releaseNotes?: string;
  silentInstallArgs?: string;
  silentUninstallArgs?: string;
  downloadUrl?: string;
  supportedOs?: string[];
  detectionRules?: DetectionRule[];
}
export interface UploadPackageVersionOptions {
  catalogId: string;
  file: File;
  metadata: PackageVersionMetadata;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}
export function uploadPackageVersion(opts: UploadPackageVersionOptions): Promise<Response>;
```
Resolution contract: resolves with the `/complete` `Response` (status 201) on success, or with the FIRST unrecoverable failing `Response` (its JSON body carries `{ error }`, so `runAction` and `response.ok` checks work unchanged). Rejects ONLY on network failure after retries, or on abort.
Terminal server signal: a 409 whose body `error` is `'upload_instance_mismatch'` (Tasks 6-7) aborts the upload IMMEDIATELY — no retries, no resync — resolving with a synthetic 409 `Response` whose `error` text is operator-actionable (names load-balancer session affinity / single-replica as the fix) and whose `code` is `'upload_instance_mismatch'`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/softwarePackageUpload.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '../stores/auth';
import { uploadPackageVersion, UPLOAD_CHUNK_SIZE } from './softwarePackageUpload';

const fetchMock = vi.mocked(fetchWithAuth);

// clone() returns the same object: sendChunk inspects 409 bodies via
// response.clone().json() before deciding resync vs terminal.
const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response => {
  const res = {
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload),
    clone: () => res,
  };
  return res as unknown as Response;
};

// UPLOAD_CHUNK_SIZE is fixed at 8MB, so use small files (< one chunk); the
// chunk-loop mechanics (offsets, resync, retry) are fully exercised anyway.
function makeFile(bytes: number, name = 'big.msi'): File {
  const blob = new Uint8Array(bytes);
  return new File([blob], name, { type: 'application/octet-stream' });
}

const CATALOG_ID = 'cat-1';
const baseMeta = { version: '1.2.3', architecture: 'x64' };

describe('uploadPackageVersion', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('drives create → chunk → complete and reports byte-accurate progress', async () => {
    const file = makeFile(10);
    const progress: Array<[number, number]> = [];
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { bytesReceived: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ver-1' } }, true, 201));

    const res = await uploadPackageVersion({
      catalogId: CATALOG_ID,
      file,
      metadata: baseMeta,
      onProgress: (sent, total) => progress.push([sent, total]),
    });

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [createUrl, createOpts] = fetchMock.mock.calls[0];
    expect(createUrl).toBe(`/software/catalog/${CATALOG_ID}/versions/uploads`);
    expect(JSON.parse(createOpts!.body as string)).toMatchObject({
      fileName: 'big.msi',
      fileSize: 10,
      chunkSize: UPLOAD_CHUNK_SIZE,
      version: '1.2.3',
    });

    const [chunkUrl, chunkOpts] = fetchMock.mock.calls[1];
    expect(chunkUrl).toBe(`/software/catalog/${CATALOG_ID}/versions/uploads/u-1/chunks?offset=0`);
    expect(chunkOpts!.method).toBe('PUT');
    expect((chunkOpts!.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');

    const [completeUrl, completeOpts] = fetchMock.mock.calls[2];
    expect(completeUrl).toBe(`/software/catalog/${CATALOG_ID}/versions/uploads/u-1/complete`);
    expect(completeOpts!.method).toBe('POST');

    expect(progress).toEqual([[0, 10], [10, 10]]);
  });

  it('resyncs to the server-reported offset on a 409', async () => {
    const file = makeFile(10);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      // chunk at offset 0 → 409, server already has 4 bytes
      .mockResolvedValueOnce(jsonResponse({ error: 'offset mismatch', bytesReceived: 4 }, false, 409))
      // resynced chunk at offset 4 → done
      .mockResolvedValueOnce(jsonResponse({ data: { bytesReceived: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ver-1' } }, true, 201));

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(201);
    expect(fetchMock.mock.calls[2][0]).toBe(
      `/software/catalog/${CATALOG_ID}/versions/uploads/u-1/chunks?offset=4`,
    );
  });

  it('retries a chunk on a transient 5xx, then succeeds', async () => {
    const file = makeFile(10);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, false, 502))
      .mockResolvedValueOnce(jsonResponse({ data: { bytesReceived: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'ver-1' } }, true, 201));

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  }, 15_000);

  it('resolves with the failing response when the create call is rejected (runAction parses it)', async () => {
    const file = makeFile(10, 'bad.zip');
    const failing = jsonResponse({ error: 'Unsupported file type: .zip' }, false, 400);
    fetchMock.mockResolvedValueOnce(failing);

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res).toBe(failing);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves with the failing response when a chunk 4xx is unrecoverable', async () => {
    const file = makeFile(10);
    const failing = jsonResponse({ error: 'Upload session not found' }, false, 404);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(failing);

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res).toBe(failing);
  });

  it('treats upload_instance_mismatch as terminal: one attempt, no retries, actionable message', async () => {
    const file = makeFile(10);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'upload_instance_mismatch', message: 'other instance', bytesReceived: 0 },
          false,
          409,
        ),
      );

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('upload_instance_mismatch');
    expect(body.error).toMatch(/session affinity|sticky|single/i);
    // Exactly create + ONE chunk attempt — no retry burn, no resync loop,
    // and /complete was never called.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after repeated 409s that do not advance (stall guard)', async () => {
    const file = makeFile(10);
    const stuck = () => jsonResponse({ error: 'offset mismatch', bytesReceived: 0 }, false, 409);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { uploadId: 'u-1', bytesReceived: 0, chunkSize: UPLOAD_CHUNK_SIZE } }, true, 201))
      .mockResolvedValueOnce(stuck())
      .mockResolvedValueOnce(stuck())
      .mockResolvedValueOnce(stuck())
      .mockResolvedValueOnce(stuck());

    const res = await uploadPackageVersion({ catalogId: CATALOG_ID, file, metadata: baseMeta });
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/softwarePackageUpload.test.ts`
Expected: FAIL — `Cannot find module './softwarePackageUpload'`.

- [ ] **Step 3: Implement the uploader**

Create `apps/web/src/lib/softwarePackageUpload.ts`:

```ts
/**
 * Chunked software package uploader (issue #2951).
 *
 * Drives the upload-session API: create session → PUT 8MB chunks (each its
 * own short request carrying a fresh access token, so the 15-minute token TTL
 * never binds the total upload time) → complete.
 *
 * Resolution contract (lets callers keep their existing Response handling):
 *  - resolves with the /complete Response (201) on success;
 *  - resolves with the FIRST unrecoverable failing Response (body carries
 *    `{ error }`, so runAction / `response.ok` checks surface the real server
 *    message);
 *  - rejects only on network failure (after per-chunk retries) or abort.
 *
 * Recovery:
 *  - transient failures (network error, 429/5xx) retry a chunk up to
 *    MAX_CHUNK_ATTEMPTS with linear backoff;
 *  - a 409 carries the server's authoritative bytesReceived — the loop
 *    resyncs and re-slices from there (duplicate chunks are idempotent
 *    server-side); repeated 409s with no forward progress bail out;
 *  - a 409 with error 'upload_instance_mismatch' is TERMINAL: the upload
 *    aborts immediately (no retries) with an operator-actionable message —
 *    the API restarted, or a load balancer without session affinity is
 *    spraying chunks across replicas.
 */
import { fetchWithAuth } from '../stores/auth';
import type { DetectionRule } from '@breeze/shared';

export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // keep in sync with API MAX_CHUNK_SIZE
const CHUNK_TIMEOUT_MS = 5 * 60_000; // generous floor: 8MB in 5min ≈ 0.2 Mbps uplink
const MAX_CHUNK_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1_000;
const MAX_STALLED_RESYNCS = 3;

export interface PackageVersionMetadata {
  version: string;
  architecture?: string;
  releaseNotes?: string;
  silentInstallArgs?: string;
  silentUninstallArgs?: string;
  downloadUrl?: string;
  supportedOs?: string[];
  detectionRules?: DetectionRule[];
}

export interface UploadPackageVersionOptions {
  catalogId: string;
  file: File;
  metadata: PackageVersionMetadata;
  /** Called after every acknowledged chunk with cumulative bytes on the server. */
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const controller = new AbortController();
  const forward = (s: AbortSignal) => () => controller.abort(s.reason);
  if (a.aborted) controller.abort(a.reason);
  else a.addEventListener('abort', forward(a), { once: true });
  if (b.aborted) controller.abort(b.reason);
  else b.addEventListener('abort', forward(b), { once: true });
  return controller.signal;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ChunkOutcome =
  | { kind: 'advanced'; bytesReceived: number }
  | { kind: 'failed'; response: Response };

async function sendChunk(
  catalogId: string,
  uploadId: string,
  chunk: Blob,
  offset: number,
  signal: AbortSignal | undefined,
): Promise<ChunkOutcome> {
  let lastNetworkError: unknown;
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetchWithAuth(
        `/software/catalog/${catalogId}/versions/uploads/${uploadId}/chunks?offset=${offset}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunk,
          signal: combineSignals(signal, AbortSignal.timeout(CHUNK_TIMEOUT_MS)),
        },
      );
    } catch (err) {
      if (signal?.aborted) throw err; // user abort — never retry
      lastNetworkError = err;
      if (attempt === MAX_CHUNK_ATTEMPTS) throw err;
      await sleep(RETRY_BASE_DELAY_MS * attempt);
      continue;
    }

    if (response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { data?: { bytesReceived?: number } }
        | null;
      const bytesReceived = body?.data?.bytesReceived;
      if (typeof bytesReceived !== 'number') return { kind: 'failed', response };
      return { kind: 'advanced', bytesReceived };
    }
    if (response.status === 409) {
      const body = (await response.clone().json().catch(() => null)) as
        | { error?: string; bytesReceived?: number }
        | null;
      if (body?.error === 'upload_instance_mismatch') {
        // TERMINAL (Tasks 6-7 contract): another API process owns this
        // upload's temp file — the API restarted, or requests are being
        // load-balanced across replicas without session affinity. Retrying
        // or resyncing can never succeed; fail immediately with an
        // operator-actionable message.
        return {
          kind: 'failed',
          response: new Response(
            JSON.stringify({
              error:
                'Upload cannot continue: it was started on a different API server instance ' +
                '(the API restarted, or requests are load-balanced across replicas without ' +
                'session affinity). Enable sticky sessions for the API — or run a single ' +
                'replica — then start the upload again.',
              code: 'upload_instance_mismatch',
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          ),
        };
      }
      if (typeof body?.bytesReceived === 'number') {
        // Resync: the outer loop re-slices from the authoritative offset.
        return { kind: 'advanced', bytesReceived: body.bytesReceived };
      }
      return { kind: 'failed', response };
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_CHUNK_ATTEMPTS) return { kind: 'failed', response };
      await sleep(RETRY_BASE_DELAY_MS * attempt);
      continue;
    }
    // Other 4xx: unrecoverable (401 refresh/replay already happened inside
    // fetchWithAuth; 404 session gone; 413 size bug).
    return { kind: 'failed', response };
  }
  throw lastNetworkError instanceof Error
    ? lastNetworkError
    : new Error('Chunk upload failed after retries');
}

export async function uploadPackageVersion(
  opts: UploadPackageVersionOptions,
): Promise<Response> {
  const { catalogId, file, metadata, onProgress, signal } = opts;

  const createResponse = await fetchWithAuth(
    `/software/catalog/${catalogId}/versions/uploads`,
    {
      method: 'POST',
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        chunkSize: UPLOAD_CHUNK_SIZE,
        ...metadata,
      }),
      signal,
    },
  );
  if (!createResponse.ok) return createResponse;

  const created = (await createResponse.json().catch(() => null)) as
    | { data?: { uploadId?: string; bytesReceived?: number } }
    | null;
  const uploadId = created?.data?.uploadId;
  if (!uploadId) throw new Error('Upload session did not return an uploadId');

  let offset = created?.data?.bytesReceived ?? 0;
  onProgress?.(offset, file.size);

  let stalledResyncs = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + UPLOAD_CHUNK_SIZE, file.size));
    const outcome = await sendChunk(catalogId, uploadId, chunk, offset, signal);
    if (outcome.kind === 'failed') return outcome.response;

    if (outcome.bytesReceived <= offset) {
      // 409 resync that moved us backwards/nowhere. A few of these are normal
      // after a lost response; endless ones mean the server can never accept
      // our offset — bail out with a synthetic 409 the caller can surface.
      stalledResyncs += 1;
      if (stalledResyncs > MAX_STALLED_RESYNCS) {
        return new Response(
          JSON.stringify({ error: 'Upload could not make progress; please retry' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
    } else {
      stalledResyncs = 0;
    }
    offset = outcome.bytesReceived;
    onProgress?.(offset, file.size);
  }

  return fetchWithAuth(
    `/software/catalog/${catalogId}/versions/uploads/${uploadId}/complete`,
    { method: 'POST', body: JSON.stringify({}), signal },
  );
}
```

Wait — the stall-guard test expects a 409 pass-through after 4 stuck responses; the synthetic-Response fallback also answers 409, so the assertion (`res.status === 409`) holds either way. Keep the synthetic response: it guarantees a JSON body even if the stuck 409's body was already consumed.

Also add to `RUN_ACTION_ALLOWLIST` in `apps/web/src/lib/runActionAllowlist.ts`:

```ts
  { file: 'apps/web/src/lib/softwarePackageUpload.ts', reason: 'typed multi-request chunked-upload driver — outcome surfacing owned by callers (runAction in AddPackageModal, inline error UI in SoftwareVersionManager)' },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/softwarePackageUpload.test.ts src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS — uploader suite green; `no-silent-mutations` still green with the allowlist entry.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/softwarePackageUpload.ts apps/web/src/lib/softwarePackageUpload.test.ts apps/web/src/lib/runActionAllowlist.ts
git commit -m "feat(web): chunked package uploader with progress, retry and 409 resync (#2951)"
```

---

### Task 11: Wire SoftwareVersionManager to the chunked uploader

**Files:**
- Modify: `apps/web/src/components/software/SoftwareVersionManager.tsx` (handleSubmit file branch, lines ~272-323 pre-edit; delete the fake `setUploadProgress(10/90/100)` calls at lines 292, 301, 323)
- Test: `apps/web/src/components/software/SoftwareVersionManager.upload.test.tsx` (create)

**Interfaces:**
- Consumes: `uploadPackageVersion`, `PackageVersionMetadata` from `../../lib/softwarePackageUpload` (Task 10 contract: resolves with a `Response`; progress callback `(sentBytes, totalBytes)`).
- Produces: no new exports — the existing progress bar (component lines ~672-682, driven by `uploadProgress` state) now shows real byte progress.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/software/SoftwareVersionManager.upload.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SoftwareVersionManager from './SoftwareVersionManager';
import { fetchWithAuth } from '../../stores/auth';
import { uploadPackageVersion } from '../../lib/softwarePackageUpload';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/softwarePackageUpload', () => ({ uploadPackageVersion: vi.fn() }));
vi.mock('./DetectionRulesEditor', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);
const uploadMock = vi.mocked(uploadPackageVersion);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('SoftwareVersionManager chunked upload path', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    uploadMock.mockReset();
    // Version list + custom-field fetches resolve empty.
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/custom-fields')) return Promise.resolve(jsonResponse({ data: [] }));
      return Promise.resolve(jsonResponse({ data: [] }));
    });
  });

  it('routes a file submission through uploadPackageVersion with the form metadata', async () => {
    uploadMock.mockResolvedValueOnce(
      jsonResponse({ data: { id: 'ver-9', version: '2.0.0', isLatest: true } }, true, 201),
    );

    render(<SoftwareVersionManager catalogId="cat-1" embedded />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    // Open the add-version form.
    fireEvent.click(screen.getByRole('button', { name: /add version/i }));
    fireEvent.change(screen.getByLabelText(/version/i), { target: { value: '2.0.0' } });

    const file = new File([new Uint8Array(16)], 'installer.msi');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    fireEvent.submit(fileInput.closest('form')!);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: 'cat-1',
        file,
        metadata: expect.objectContaining({ version: '2.0.0' }),
        onProgress: expect.any(Function),
      }),
    );
    // The legacy single-request multipart endpoint is no longer called.
    const legacyCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes('/versions/upload'),
    );
    expect(legacyCall).toBeUndefined();
  });

  it('surfaces a failing upload Response as the inline error', async () => {
    uploadMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Object storage rejected the upload' }, false, 502),
    );

    render(<SoftwareVersionManager catalogId="cat-1" embedded />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /add version/i }));
    fireEvent.change(screen.getByLabelText(/version/i), { target: { value: '2.0.0' } });
    const file = new File([new Uint8Array(16)], 'installer.msi');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.submit(fileInput.closest('form')!);

    await waitFor(() =>
      expect(screen.getByText(/Object storage rejected the upload/)).toBeInTheDocument(),
    );
  });
});
```

Adjust the two locator lines to the component's actual DOM if they miss (e.g. the add-version button label comes from i18n — read the rendered output; the i18n keys resolve to English in jsdom, matching the sibling tests' approach in `SoftwareCatalog.test.tsx`). Do NOT weaken the two behavioral assertions: `uploadPackageVersion` called with `{catalogId, file, metadata, onProgress}`, and no `/versions/upload` fetch.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/software/SoftwareVersionManager.upload.test.tsx`
Expected: FAIL — `uploadPackageVersion` never called (component still posts multipart to `/versions/upload`).

- [ ] **Step 3: Rewire the component**

In `apps/web/src/components/software/SoftwareVersionManager.tsx`:

1. Add import: `import { uploadPackageVersion } from "../../lib/softwarePackageUpload";`
2. Replace the file-upload branch of `handleSubmit` (the whole `if (formState.file) { ... }` block, pre-edit lines 272-323) with:

```tsx
      if (formState.file) {
        // Chunked upload (#2951): each chunk is its own short request with a
        // fresh token, so a slow multi-hundred-MB upload can never outlive the
        // access-token TTL. Progress is real bytes acknowledged by the server.
        const response = await uploadPackageVersion({
          catalogId,
          file: formState.file,
          metadata: {
            version: formState.version.trim(),
            architecture: formState.architecture,
            releaseNotes: formState.notes || undefined,
            silentInstallArgs: formState.silentInstallArgs || undefined,
            silentUninstallArgs: formState.silentUninstallArgs || undefined,
            downloadUrl: formState.downloadUrl || undefined,
            supportedOs:
              formState.supportedOs.length > 0 ? formState.supportedOs : undefined,
            detectionRules:
              formState.detectionRules.length > 0
                ? formState.detectionRules
                : undefined,
          },
          onProgress: (sent, total) =>
            setUploadProgress(total > 0 ? Math.round((sent / total) * 100) : 0),
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          // Always show the status (#2794): a non-JSON body means a reverse
          // proxy or truncated connection, distinguishable at a glance.
          const detail =
            typeof errData.error === "string"
              ? errData.error
              : "Failed to upload version";
          throw new Error(`${detail} (HTTP ${response.status})`);
        }
        const newVersionData = await response.json();
        const newVersion = normalizeVersion(
          newVersionData.data ?? newVersionData,
          versions.length,
        );
        setVersions((prev) => [newVersion, ...prev]);
        setLatestId(newVersion.id);
        setSelectedVersionId(newVersion.id);
      } else {
```

This removes all three fake progress writes (`setUploadProgress(10)`, `(90)`, `(100)`); the `finally` block's `setUploadProgress(0)` reset stays. The existing progress bar (lines ~672-682) is unchanged — it now renders real numbers.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/software/SoftwareVersionManager.upload.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/software/SoftwareVersionManager.tsx apps/web/src/components/software/SoftwareVersionManager.upload.test.tsx
git commit -m "fix(web): SoftwareVersionManager uses chunked upload with real progress (#2951)"
```

---

### Task 12: Wire AddPackageModal to the chunked uploader (runAction preserved)

**Files:**
- Modify: `apps/web/src/components/software/AddPackageModal.tsx` (file branch of `buildVersionRequest`, pre-edit lines 176-198; add a progress state + indicator)
- Test: `apps/web/src/components/software/AddPackageModal.test.tsx` (extend)

**Interfaces:**
- Consumes: `uploadPackageVersion` (Task 10). Because it resolves with a `Response`, it slots directly into `runAction`'s `request: () => Promise<Response>` — error toasts, success toast, and the modal's retry-from-version-step behavior all keep working unchanged.

- [ ] **Step 1: Write the failing test**

Extend `apps/web/src/components/software/AddPackageModal.test.tsx`. Add the mock at the top (next to the existing `vi.mock` calls):

```tsx
vi.mock('../../lib/softwarePackageUpload', () => ({ uploadPackageVersion: vi.fn() }));
import { uploadPackageVersion } from '../../lib/softwarePackageUpload';
const uploadMock = vi.mocked(uploadPackageVersion);
```

Reset it in the existing `beforeEach` (`uploadMock.mockReset();`), then add:

```tsx
  it('routes the file source through the chunked uploader inside runAction', async () => {
    const onCreated = vi.fn();
    routeMock({});
    uploadMock.mockResolvedValueOnce(
      jsonResponse({ data: { id: 'ver-1' } }, true, 201),
    );

    render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Big App' } });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '3.1.4' } });

    // Switch the source to file and pick one.
    fireEvent.click(screen.getByRole('tab', { name: /upload file/i }));
    const file = new File([new Uint8Array(32)], 'bigapp.msi');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    fireEvent.click(await screen.findByRole('button', { name: 'Create package' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(uploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: 'cat-1',
        file,
        metadata: expect.objectContaining({ version: '3.1.4', architecture: 'x64' }),
        onProgress: expect.any(Function),
      }),
    );
    // The legacy multipart endpoint is not used by the dashboard anymore.
    const legacyCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes('/versions/upload'),
    );
    expect(legacyCall).toBeUndefined();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('keeps the catalog id for retry when the chunked upload fails (runAction error path)', async () => {
    routeMock({});
    uploadMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Upload is incomplete' }, false, 409),
    );

    render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Big App' } });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '3.1.4' } });
    fireEvent.click(screen.getByRole('tab', { name: /upload file/i }));
    const file = new File([new Uint8Array(32)], 'bigapp.msi');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Create package' }));

    // runAction toasts the server error; catalog item was created exactly once.
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
    );
    const catalogCreates = fetchMock.mock.calls.filter(
      ([u, o]) => u === '/software/catalog' && (o as RequestInit)?.method === 'POST',
    );
    expect(catalogCreates).toHaveLength(1);
  });
```

(If the tab's accessible name differs, use the rendered i18n string — the existing tests in this file resolve English strings.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/software/AddPackageModal.test.tsx`
Expected: FAIL — `uploadPackageVersion` never called (file branch still builds `FormData` and posts `/versions/upload`).

- [ ] **Step 3: Rewire the modal**

In `apps/web/src/components/software/AddPackageModal.tsx`:

1. Add import: `import { uploadPackageVersion } from "../../lib/softwarePackageUpload";`
2. Add progress state next to `saving`: `const [uploadProgress, setUploadProgress] = useState<number | null>(null);`
3. Replace the file branch of `buildVersionRequest` (pre-edit lines 176-198) with:

```tsx
    if (form.source === "file" && form.file) {
      const file = form.file;
      // Chunked upload (#2951). uploadPackageVersion resolves with a Response
      // (the /complete response, or the first unrecoverable failure), so it
      // drops straight into runAction's request slot — toasts keep working.
      return () =>
        uploadPackageVersion({
          catalogId,
          file,
          metadata: {
            ...shared,
            downloadUrl: form.downloadUrl.trim() || undefined,
          },
          onProgress: (sent, total) =>
            setUploadProgress(total > 0 ? Math.round((sent / total) * 100) : 0),
        });
    }
```
4. In `handleSubmit`, reset progress: add `setUploadProgress(null);` right after `setSaving(true);` and in the `finally` block.
5. Show progress while saving a file upload — add next to the submit button (find the footer button row):

```tsx
            {saving && form.source === "file" && uploadProgress !== null && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                {uploadProgress}%
              </div>
            )}
```

The `shared` object already contains `version, architecture, releaseNotes, silentInstallArgs, silentUninstallArgs, supportedOs, detectionRules` — exactly `PackageVersionMetadata` minus `downloadUrl`, which is added explicitly. The URL-only branch of `buildVersionRequest` is untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/software/AddPackageModal.test.tsx`
Expected: PASS — the 2 new tests AND all 5 pre-existing tests (URL path, retry semantics, cancel-after-failure).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/software/AddPackageModal.tsx apps/web/src/components/software/AddPackageModal.test.tsx
git commit -m "fix(web): AddPackageModal uploads packages via chunked sessions (#2951)"
```

---

### Task 13: Full verification sweep

**Files:** none new — verification only.

- [ ] **Step 1: API unit suite**
Run: `pnpm --filter @breeze/api exec vitest run`
Expected: PASS (includes `software.test.ts`, `softwareUploads.test.ts`, `softwareVersionShared.test.ts`, `bodyLimit.test.ts`, `softwareUploadSessionCleanup.test.ts`, `autoMigrate.test.ts` migration-ordering guard, `composeBindMounts.test.ts`).

- [ ] **Step 2: Web unit suite**
Run: `pnpm --filter @breeze/web exec vitest run`
Expected: PASS (includes `auth.test.ts`, `softwarePackageUpload.test.ts`, both component suites, `no-silent-mutations.test.ts`).

- [ ] **Step 3: Contract suites against a live DB** (`pnpm test` does NOT run these)
Run: `pnpm --filter @breeze/api test:docker:up && pnpm --filter @breeze/api test:integration && pnpm --filter @breeze/api test:rls`
Expected: PASS — specifically `softwareUploadSessionsRls`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `rls-coverage` (which auto-discovers `software_upload_sessions` as shape 1).

- [ ] **Step 4: Drift + lint + build**
Run: `pnpm db:check-drift && pnpm lint && pnpm build`
Expected: all clean.

- [ ] **Step 5: Manual end-to-end smoke (optional but recommended)**
Bring up the worktree stack (`worktree-stack` skill), open Software Library → Add Package → upload a >100MB file, and verify: progress advances smoothly (not 10%→stall), the version appears, `software_upload_sessions` is empty afterwards, and the temp dir has no leftover `session-*.part` files. Kill the tab mid-upload, re-open, and confirm the reaper TTL/abort story (row present until DELETE or TTL).

- [ ] **Step 6: Commit any stragglers and finish**

```bash
git status   # should be clean except the plan file
```

---

## Self-review (performed while writing)

1. **Requirement → task map:** fake progress bar (T11/T12 delete + real progress); 10-min `UPLOAD_TIMEOUT_MS`/abort readability + 401-retry defects (T9 — note the FormData path itself remains, since the legacy route stays for compat, but its abort is now readable); token-TTL decoupling via per-chunk requests (T5-T7, T10); up-front extension/size validation (T5 create); 409/duplicate idempotency (T6); complete reuses `uploadBinary`→`insertLatestSoftwareVersion`→`writeRouteAudit`→`unlink` incl. #2794 mapping (T7); GET resume + DELETE abort (T5); RLS shape 1 same-migration policies (T1); cascade FK direction + both registrations + explicit "no device lists apply" (T2, Global Constraints); jsonb → `excludedOpen` (T2); RLS forge suite (T1); reaper on the repo's BullMQ pattern with TTL (T8); bodyLimit carve-out (T3); runAction contract + allowlist (T10/T12); legacy route untouched (Global Constraints); single-instance + hash choice stated with failure modes (Global Constraints, T7 header).
2. **Placeholder scan:** the only intentional non-literal blocks are the three "MOVE verbatim from software.ts lines X-Y" markers in Task 4 — they reference exact existing code by line range, which is stricter than restating it (restating risks drift from the real file).
3. **Name consistency check:** `uploadPackageVersion` / `UPLOAD_CHUNK_SIZE` / `PackageVersionMetadata` (T10→T11/T12); `uploadSessionTempPath` / `withSessionLock` / `softwareUploadRoutes` (T5→T6/T7 and tests); `softwareUploadSessions` (T1→T2/T5-T8); `insertLatestSoftwareVersion` / `resolveScopedOrgId` / `getFileExtension` / `ALLOWED_EXTENSIONS` / `MAX_UPLOAD_SIZE` (T4→T5/T7); reaper init/shutdown names (T8→index.ts). Response envelopes (`{data:{uploadId,bytesReceived,chunkSize}}`, `{data:{bytesReceived}}`, 409 `{error,bytesReceived}`) match between route code (T5-T7), route tests, and the client (T10).

## Amendment self-review (2026-08-02 design-review round)

1. **Coverage:** session caps — constants + 429s in T5 (code, tests, Interfaces) and Global Constraints; instance guard — `owner_instance_id` in T1 (schema, migration, both fixture inserts, forge command), `included` classification in T2, `PROCESS_INSTANCE_ID` + stamp in T5, pre-lock guard + `INSTANCE_MISMATCH_MESSAGE` in T6, reused in T7, terminal client handling + test in T10; reaper — 2h idle + 24h absolute in T8 (both env knobs, both conditions asserted independently via `lt`/`or` spies) and Global Constraints; S3-multipart rejected alternative recorded in Global Constraints; migration renamed to `2026-08-11-*` (prefix must outsort the newest shipped migration).
2. **Interaction found and resolved during amendment:** `PROCESS_INSTANCE_ID` is a boot-scoped `randomUUID()`, so an API **restart** now terminates in-flight sessions via `upload_instance_mismatch` — the chunk route's ENOENT-reset path no longer covers restarts (it remains for tmp-cleaner deletion under a live process; comments in T6 updated to say so). All mismatch messages name both causes (restart, non-sticky LB).
3. **Consistency:** every chunk/complete request that passes the guard consumes an extra queued `db.select` in the T5-T7 tests (annotated); `makeSession` defaults `ownerInstanceId: PROCESS_INSTANCE_ID`; `makeUsage` field names (`orgActive`/`userActive`/`orgBytes`) match the create route's aggregate select; T10's `jsonResponse` gained `clone()` (the pre-existing resync tests already needed it — latent inconsistency fixed); `__testOnly` exports match the new reaper helpers (`getIdleTtlHours`/`getMaxAgeHours`, `DEFAULT_IDLE_TTL_HOURS`/`DEFAULT_MAX_AGE_HOURS`).
