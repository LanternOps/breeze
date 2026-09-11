---
tracking_issue: LanternOps/breeze#5573
---
# Service Deliverables W03: Org Documents Library, Blob Storage Extraction, Document Evidence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every organization a real document library — bytes, versions, portal flag, soft delete, GDPR erasure — extract the ticket-attachment byte helper into a generic one so both surfaces share it, and let a service-deliverable occurrence take an uploaded or linked document as evidence.

**Architecture:** One idempotent DDL migration creates `org_documents` (RLS shape 1, direct `org_id`) plus the composite FK that lets `service_deliverable_evidence.document_id` point at it; a second migration seeds the new `documents` permission and grants it to the existing admin/technician roles. `services/ticketAttachmentStorage.ts` is split: the backend-selection, put/get/delete primitives move into a generic `services/blobStorage.ts` that takes the key prefix as a parameter, and the ticket module becomes a thin re-exporting wrapper so its existing tests keep pinning the same behaviour. `services/orgDocumentService.ts` is the only writer; `routes/orgDocuments.ts` is thin and multipart-aware. The org-erasure S3 pre-clear in `tenantCascade.ts` widens from one table to both, in a single read, so no customer bytes are ever orphaned. The web gains an org-record Documents tab and a file-upload evidence option on the W01 occurrence drawer; the AI gains metadata-only document tools.

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Hono + Zod (`@breeze/shared` validators), S3-compatible object storage (DigitalOcean Spaces) with a `bytea` fallback, Vitest (API unit with Drizzle mocks; API integration on real Postgres), Astro + React islands, react-i18next, Testing Library.

**Spec:** `docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md` (approved 2026-09-10). This wave is spec §4.4, the `document` arm of §4.3, the §4.9 registrations including the S3 erasure pre-clear, §7 upload-on-deliver, §9 org-record Documents tab, §10 documents REST + `documents` permission + document MCP tools, §12 upload errors, §13 document tests. Wave table row W03.

**Depends on:** W01 (`docs/superpowers/plans/billing/2026-09-10-service-deliverables-w01-schema-core.md`). W03 reuses its names verbatim: `DeliverableActor`, `DeliverableServiceError`, `EvidenceRef`, `evidenceRefSchema`, `addEvidence`, `deliverOccurrence`, `OccurrenceView`, `Fetcher`, the `deliverables` i18n namespace, `orgRecordTabs.ts`. Do not rename any of them.

## Global Constraints

- **Tenancy shape 1.** `org_documents` carries a direct `org_id`; RLS enabled + forced + the four `breeze_has_org_access(org_id)` policies in the creating migration, copied verbatim from `apps/api/migrations/2026-06-21-contracts-auto-renew.sql:16-30` (its `contract_renewal_notices` block). Never deferred to a later migration.
- **Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`** — the org-merge contract (`SET CONSTRAINTS ALL DEFERRED`). That is both `org_documents`' self-FK and `sd_evidence_document_org_fk`.
- **Migrations are idempotent** (`CREATE TABLE IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`), carry no inner `BEGIN;`/`COMMIT;`, and any file that writes rows starts with `SELECT set_config('breeze.scope', 'system', true);`. `2026-10-15-170300-org-documents.sql` is DDL only and needs no scope election; `2026-10-15-170400-documents-permissions.sql` writes rows and MUST have it as its first statement.
- **Migration filenames sort after the newest committed migration.** As of 2026-09-10 that is `2026-10-15-160010-backup-snapshots-layout-manifest.sql`; W01 claims `-170000-`, `-170100-`, `-170200-`; W03 claims `-170300-` and `-170400-`. W02 and W05 must not claim those two slots. Re-check with `ls apps/api/migrations | sort | tail -1` before every commit and rename upward if a sibling branch landed something later.
- **Registration is part of the same PR, not a follow-up.** `org_documents` has an `org_id` column, so it goes into `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts:228`), `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts:41`) and `REPOINT_TABLES` (`apps/api/src/services/orgMergeRegistry.ts:517`). It has no `device_id`, so no device cascade list applies.
- **Org access in services: `actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)` ⇒ 404 `NOT_FOUND`, never 403** (spec §12: "Evidence link to a document or report run of another org → 404, never 403"). Note that `apps/api/src/services/contractService.ts:56` throws 403 `ORG_DENIED`; do **not** copy that literally — W01's Global Constraints already override it for this feature.
- **Two schema-import facts W01's plan gets wrong; use these.** `organizations` is exported from `apps/api/src/db/schema/orgs.ts` (not `./organizations`), and the `bytea` custom column type from `apps/api/src/db/schema/users.ts:9`. Both confirmed against `apps/api/src/db/schema/ticketAttachments.ts:1-5`.
- **No presigned URLs, ever.** Document bytes stream through the API under RLS, with `Content-Disposition` built by `contentDispositionFor` (`apps/api/src/routes/tickets/attachments.ts:262`). Precedent for importing that helper across routers: `apps/api/src/routes/portal/tickets.ts:32`.
- **Size cap and MIME allowlist are the ticket-attachment ones.** `TICKET_ATTACHMENT_LIMITS.maxBytes` = 10 MiB (`packages/shared/src/constants/ticketAttachments.ts:7-12`) and `sniffAttachmentMime` (`apps/api/src/services/attachmentSniff.ts:13`), which magic-byte sniffs JPEG/PNG/WebP/PDF and NEVER consults the client's `Content-Type`. Broadening the allowlist for CSV/JSON/ZIP exports is a follow-up issue, not this wave.
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`). Org-record requests use the record's branded `orgFetch` (`apps/web/src/components/organizations/record/orgRecordFetch.ts:22-30`), never ambient `fetchWithAuth`.
- **i18n in all 8 locales with real translations**: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`. `apps/web/src/lib/i18n/translationCoverage.test.ts` caps exact-English duplicates; consult `apps/web/src/locales/TERMINOLOGY.md`.
- **Run one test file as `cd apps/api && npx vitest run <path>`** (never `pnpm … test -- --run <path>` — pnpm forwards the `--` and vitest runs the whole suite in watch mode).
- Branch: `feature/<parent#>-service-deliverables/wave-<W03 sub-issue#>`; PR body carries `Closes #<W03 sub-issue>`.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-15-170300-org-documents.sql` | `org_document_category` enum, `org_documents` table, RLS, evidence→document composite FK |
| `apps/api/migrations/2026-10-15-170400-documents-permissions.sql` | seed `documents:read` / `documents:write` rows and grant them to existing system roles |
| `apps/api/src/db/schema/orgDocuments.ts` | Drizzle table + enum + `ORG_DOCUMENT_META_COLUMNS` |
| `apps/api/src/db/schema/index.ts` | export the new module |
| `apps/api/src/services/blobStorage.ts` (+ `.test.ts`) | generic, prefix-parameterised byte lifecycle |
| `apps/api/src/services/ticketAttachmentStorage.ts` | thin wrapper over `blobStorage`, prefix `ticket-attachments` |
| `apps/api/src/services/tenantCascade.ts` | erasure object pre-clear widened to `org_documents`; cascade registration |
| `apps/api/src/services/tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts` | registrations |
| `apps/api/src/services/orgDocumentService.ts` (+ `.test.ts`) | the only writer for `org_documents` |
| `apps/api/src/services/serviceDeliverableService.ts` | `document` arm in `addEvidence` / `deliverOccurrence` |
| `apps/api/src/services/aiToolsDeliverables.ts` | `list_org_documents`, `manage_org_documents` |
| `packages/shared/src/constants/permissions.ts` | `DOCUMENTS_READ`, `DOCUMENTS_WRITE` |
| `packages/shared/src/validators/serviceDeliverables.ts` | widen `evidenceRefSchema` with the `document` arm |
| `packages/shared/src/validators/orgDocuments.ts` (+ `.test.ts`) | Zod schemas for the documents API |
| `apps/api/src/routes/orgDocuments.ts` (+ `.test.ts`) | `/orgs/:orgId/documents…` |
| `apps/api/src/routes/serviceDeliverables.ts` | `POST …/occurrences/:oId/evidence/upload` |
| `apps/api/src/index.ts` | mount `orgDocumentRoutes` |
| `apps/api/src/db/seed.ts` | `documents` permission rows + role grants |
| `apps/api/src/__tests__/integration/orgDocumentsRls.integration.test.ts` | cross-org forge, chain integrity, evidence FK |
| `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` | S3-backed document proves object-before-row |
| `apps/web/src/lib/api/orgDocuments.ts` | typed fetch wrappers |
| `apps/web/src/components/organizations/record/OrgDocumentsTab.tsx` (+ test) | the library UI |
| `apps/web/src/components/organizations/record/orgRecordTabs.ts`, `OrganizationRecordPage.tsx` | wire the tab |
| `apps/web/src/components/deliverables/OccurrenceDrawer.tsx` | file-upload evidence option |
| `apps/web/src/locales/*/organizations.json`, `*/deliverables.json` | i18n |

---

### Task 1: Migration — `org_documents` and the evidence document FK

**Files:**
- Create: `apps/api/migrations/2026-10-15-170300-org-documents.sql`

**Interfaces:**
- Consumes: `service_deliverable_evidence` and its `document_id` column (W01 Task 1); `organizations`, `users`.
- Produces: enum `org_document_category`; table `org_documents` with unique keys `org_documents_id_org_uq (id, org_id)` and `org_documents_supersedes_uq (supersedes_document_id)`; constraint `sd_evidence_document_org_fk` on `service_deliverable_evidence`.

- [ ] **Step 1: Confirm the filename still sorts last**

Run: `ls apps/api/migrations | sort | tail -1`
Expected: a name that sorts BEFORE `2026-10-15-170300-org-documents.sql`. If W02 or W05 landed something at or after `-170300-`, bump this file (and Task 2's) to the next free slot and update every reference in this plan.

- [ ] **Step 2: Write the migration**

```sql
-- org_documents — the organization document library (spec §4.4, D5/D7).
-- Shape 1 (direct org_id). DDL only: no rows written, so no breeze.scope election.
-- Bytes live in ONE of two places, chosen once at upload and never re-derived:
-- an S3 object or inline bytea. Keys carry NO tenant identifier — the row is the
-- authority, so an org merge re-stamps org_id on rows only and objects never move.
-- Versioning is a backwards linked list: the NEW document points at the one it
-- replaces. UNIQUE (supersedes_document_id) forbids branching and the service
-- refuses to replace a non-head; together those make a cycle unconstructible.

DO $$ BEGIN
  CREATE TYPE org_document_category AS ENUM
    ('baseline','runbook','policy','evidence','report','export','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS org_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  category org_document_category NOT NULL DEFAULT 'other',
  storage_backend TEXT NOT NULL,
  storage_key TEXT,
  data BYTEA,
  content_type VARCHAR(255) NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 CHAR(64) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  portal_visible BOOLEAN NOT NULL DEFAULT FALSE,
  supersedes_document_id UUID,
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE org_documents ADD CONSTRAINT org_documents_backend_chk
    CHECK (storage_backend IN ('s3','db'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A LIVE row carries its bytes in exactly one place. A soft-deleted row is
-- exempt: deleteDocument removes the object FIRST, then clears both pointers, so
-- the tombstone keeps its metadata while the customer bytes are genuinely gone.
DO $$ BEGIN
  ALTER TABLE org_documents ADD CONSTRAINT org_documents_bytes_chk CHECK (
    deleted_at IS NOT NULL
    OR (storage_backend = 's3' AND storage_key IS NOT NULL AND data IS NULL)
    OR (storage_backend = 'db' AND data IS NOT NULL AND storage_key IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE org_documents ADD CONSTRAINT org_documents_byte_size_chk
    CHECK (byte_size > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE org_documents ADD CONSTRAINT org_documents_no_self_supersede_chk
    CHECK (supersedes_document_id IS NULL OR supersedes_document_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Composite self-FK: a document may only supersede one of the SAME org.
-- DEFERRABLE INITIALLY IMMEDIATE — it references an org_id column, and the org
-- merge re-points parent and child in separate statements (CLAUDE.md contract).
CREATE UNIQUE INDEX IF NOT EXISTS org_documents_id_org_uq ON org_documents (id, org_id);
DO $$ BEGIN
  ALTER TABLE org_documents ADD CONSTRAINT org_documents_supersedes_org_fk
    FOREIGN KEY (supersedes_document_id, org_id) REFERENCES org_documents(id, org_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One successor per document: the chain is a list, never a tree.
CREATE UNIQUE INDEX IF NOT EXISTS org_documents_supersedes_uq
  ON org_documents (supersedes_document_id) WHERE supersedes_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS org_documents_org_category_idx ON org_documents (org_id, category);
CREATE INDEX IF NOT EXISTS org_documents_org_created_idx ON org_documents (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS org_documents_org_portal_idx
  ON org_documents (org_id) WHERE portal_visible AND deleted_at IS NULL;

ALTER TABLE org_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON org_documents;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON org_documents;
DROP POLICY IF EXISTS breeze_org_isolation_update ON org_documents;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON org_documents;
CREATE POLICY breeze_org_isolation_select ON org_documents
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON org_documents
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON org_documents
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON org_documents
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- W01 created service_deliverable_evidence.document_id without an FK because
-- org_documents did not exist yet (spec §4.3). Close it now.
DO $$ BEGIN
  ALTER TABLE service_deliverable_evidence ADD CONSTRAINT sd_evidence_document_org_fk
    FOREIGN KEY (document_id, org_id) REFERENCES org_documents(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

- [ ] **Step 3: Run the naming and RLS-scope guards**

Run: `scripts/check-migration-naming.sh --against-ref origin/main && cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: both PASS. `migrationRlsScope.test.ts` must not flag the new file — it writes no rows. If it does, you added DML; move it to Task 2's file.

- [ ] **Step 4: Apply against the worktree test stack, twice**

Run: `pnpm test-stack up` (once for the wave), then
`cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate`
Expected: the second run is a clean no-op — no errors, no duplicate-object noise.

- [ ] **Step 5: Forge a cross-tenant insert as `breeze_app`**

Run: `docker exec -it $(docker ps --format '{{.Names}}' | grep postgres | head -1) psql -U breeze_app -d breeze -c "SELECT set_config('breeze.scope','organization',false); INSERT INTO org_documents (org_id,title,category,storage_backend,data,content_type,byte_size,sha256,original_filename) VALUES (gen_random_uuid(),'forge','other','db','\\x00','application/pdf',1,repeat('a',64),'f.pdf');"`
Expected: `ERROR: new row violates row-level security policy for table "org_documents"`. A success here means the policies did not take; stop and fix before continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-10-15-170300-org-documents.sql
git commit -m "feat(documents): org_documents table with shape-1 RLS and evidence FK (W03)"
```

---

### Task 2: `documents` permission — registry, seed, migration

**Files:**
- Create: `apps/api/migrations/2026-10-15-170400-documents-permissions.sql`
- Modify: `packages/shared/src/constants/permissions.ts:82` (after `CONTRACTS_MANAGE`)
- Modify: `apps/api/src/db/seed.ts:179` (permission catalogue) and `SYSTEM_ROLES` at `:280`

**Interfaces:**
- Produces: `PERMISSION_GRANTS.DOCUMENTS_READ = { resource: 'documents', action: 'read' }`, `DOCUMENTS_WRITE = { resource: 'documents', action: 'write' }`, re-exported to the API as `PERMISSIONS.DOCUMENTS_*` by `apps/api/src/services/permissions.ts:280` and to the web as `PermissionResource`/`PermissionAction` literals.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/constants/permissions.test.ts` (create the file if absent):

```ts
import { describe, expect, it } from 'vitest';
import { PERMISSION_GRANTS } from './permissions';

describe('documents permission (service deliverables W03)', () => {
  it('declares read and write on the documents resource', () => {
    expect(PERMISSION_GRANTS.DOCUMENTS_READ).toEqual({ resource: 'documents', action: 'read' });
    expect(PERMISSION_GRANTS.DOCUMENTS_WRITE).toEqual({ resource: 'documents', action: 'write' });
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `cd packages/shared && npx vitest run src/constants/permissions.test.ts`
Expected: FAIL — `PERMISSION_GRANTS.DOCUMENTS_READ` is undefined.

- [ ] **Step 3: Add the grants**

In `packages/shared/src/constants/permissions.ts`, directly after the `CONTRACTS_MANAGE` line:

```ts
  // Organization document library + key dates (service deliverables, spec §10).
  // Deliberately NOT folded into `contracts`: a runbook or an onboarding
  // baseline is org-record content that outlives any contract, and a partner
  // may want a technician who can file documents without touching billing.
  DOCUMENTS_READ: { resource: 'documents', action: 'read' },
  DOCUMENTS_WRITE: { resource: 'documents', action: 'write' },
```

In `apps/api/src/db/seed.ts`, after the three `contracts` entries:

```ts
  // Organization documents (service deliverables W03)
  { resource: 'documents', action: 'read', description: 'View the organization document library and download documents' },
  { resource: 'documents', action: 'write', description: 'Upload, replace, edit, and delete organization documents' },
```

and add `'documents:read', 'documents:write'` to the `permissions` array of the `Partner Technician`, `Org Admin` and `Org Technician` entries of `SYSTEM_ROLES`. `Partner Admin` already holds `'*:*'`.

- [ ] **Step 4: Write the seeding migration**

```sql
-- documents:read / documents:write (service deliverables W03, spec §10).
--
-- Grant predicate copies 2026-10-15-150500-accounting-dedicated-permissions.sql
-- exactly: `is_system = TRUE` is the anti-forgery filter (roles created through
-- routes/roles.ts are always is_system = FALSE), and there is NO `partner_id IS
-- NULL` clause because system roles are cloned per partner, so a template-only
-- grant would reach nobody on upgrade. Partner Admin holds '*:*' and needs no
-- row; NO custom role gains either permission automatically.
--
-- permissions has NO UNIQUE constraint on (resource, action) — only a PK on id —
-- so ON CONFLICT DO NOTHING has nothing to conflict against and would duplicate
-- on every re-apply. Explicit existence checks instead.
--
-- Every write runs under system scope: unscoped, an INSERT either matches zero
-- rows silently or aborts with 42501 (#4518).
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'documents' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('documents', 'read', 'View the organization document library and download documents');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE WARNING 'seeded documents:read permission row'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'documents' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('documents', 'write', 'Upload, replace, edit, and delete organization documents');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE WARNING 'seeded documents:write permission row'; END IF;
  END IF;
END $$;

DO $$
DECLARE
  n integer;
  v_perm uuid;
  v_action text;
  v_role text;
BEGIN
  FOREACH v_action IN ARRAY ARRAY['read','write'] LOOP
    SELECT id INTO v_perm FROM permissions
    WHERE resource = 'documents' AND action = v_action ORDER BY id LIMIT 1;

    FOREACH v_role IN ARRAY ARRAY['Partner Technician','Org Admin','Org Technician'] LOOP
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, v_perm
      FROM roles r
      WHERE r.name = v_role
        AND r.is_system = TRUE
        AND v_perm IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM role_permissions rp
          WHERE rp.role_id = r.id AND rp.permission_id = v_perm
        );
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN
        RAISE WARNING 'granted documents:% to % existing % role(s)', v_action, n, v_role;
      END IF;
    END LOOP;
  END LOOP;
END $$;
```

- [ ] **Step 5: Run the tests and guards**

Run: `cd packages/shared && npx vitest run src/constants/permissions.test.ts` → PASS.
Run: `cd apps/api && npx vitest run src/db/seed.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts` → PASS. `migrationRlsScope.test.ts` must accept the new file because `set_config` is its first statement; if it fails, the `SELECT set_config(...)` line is missing or below a write.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/constants/permissions.ts packages/shared/src/constants/permissions.test.ts apps/api/src/db/seed.ts apps/api/migrations/2026-10-15-170400-documents-permissions.sql
git commit -m "feat(documents): documents:read/write permission, seeded and granted to admin and technician roles (W03)"
```

---

### Task 3: Drizzle schema for `org_documents`

**Files:**
- Create: `apps/api/src/db/schema/orgDocuments.ts`
- Modify: `apps/api/src/db/schema/index.ts:128` area (next to the contracts export)

**Interfaces:**
- Produces (exact export names used by Tasks 5–16): `orgDocumentCategoryEnum`, `orgDocuments`, `OrgDocumentRow`, `ORG_DOCUMENT_META_COLUMNS`.

- [ ] **Step 1: Write the schema module**

```ts
import { sql } from 'drizzle-orm';
import { pgTable, pgEnum, uuid, varchar, text, integer, char, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users, bytea } from './users';

export const orgDocumentCategoryEnum = pgEnum('org_document_category', [
  'baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other',
]);

/**
 * Organization document library (spec §4.4). Shape 1 (direct org_id).
 *
 * NEVER select `data` outside the content path — use ORG_DOCUMENT_META_COLUMNS.
 * The composite self-FK on (supersedes_document_id, org_id) is declared in SQL
 * only; Drizzle cannot express DEFERRABLE, so the single-column reference here
 * exists for typing and for readers.
 */
export const orgDocuments = pgTable('org_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  category: orgDocumentCategoryEnum('category').notNull().default('other'),
  storageBackend: text('storage_backend').$type<'s3' | 'db'>().notNull(),
  storageKey: text('storage_key'),
  data: bytea('data'),
  contentType: varchar('content_type', { length: 255 }).notNull(),
  byteSize: integer('byte_size').notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  originalFilename: varchar('original_filename', { length: 255 }).notNull(),
  uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  portalVisible: boolean('portal_visible').notNull().default(false),
  supersedesDocumentId: uuid('supersedes_document_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('org_documents_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('org_documents_supersedes_uq').on(t.supersedesDocumentId)
    .where(sql`${t.supersedesDocumentId} IS NOT NULL`),
  index('org_documents_org_category_idx').on(t.orgId, t.category),
  index('org_documents_org_created_idx').on(t.orgId, t.createdAt),
]);

export type OrgDocumentRow = typeof orgDocuments.$inferSelect;
/** Structurally identical to the `OrgDocumentCategory` in
 *  packages/shared/src/validators/orgDocuments.ts (Task 7). API code imports the
 *  SHARED one so the API and the web agree on a single definition; this alias
 *  exists for schema-local typing. Keep the two enum member lists in step. */
export type OrgDocumentCategory = (typeof orgDocumentCategoryEnum.enumValues)[number];

/** Client-safe column subset. `data` and `storageKey` are server-only. */
export const ORG_DOCUMENT_META_COLUMNS = {
  id: orgDocuments.id,
  orgId: orgDocuments.orgId,
  title: orgDocuments.title,
  description: orgDocuments.description,
  category: orgDocuments.category,
  contentType: orgDocuments.contentType,
  byteSize: orgDocuments.byteSize,
  sha256: orgDocuments.sha256,
  originalFilename: orgDocuments.originalFilename,
  uploadedByUserId: orgDocuments.uploadedByUserId,
  portalVisible: orgDocuments.portalVisible,
  supersedesDocumentId: orgDocuments.supersedesDocumentId,
  createdAt: orgDocuments.createdAt,
} as const;
```

- [ ] **Step 2: Export it**

Add `export * from './orgDocuments';` to `apps/api/src/db/schema/index.ts` next to the `export * from './contracts';` line.

- [ ] **Step 3: Typecheck and drift-check**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:check-drift`
Expected: no type errors; the drift check reports no differences for `org_documents`. (Note `db:check-drift` compares the Drizzle schema to the MIGRATIONS, not to the live DB — the partial-index `.where()` clauses are declared for readers and are not what the check enforces.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/orgDocuments.ts apps/api/src/db/schema/index.ts
git commit -m "feat(documents): drizzle schema for org_documents (W03)"
```

---

### Task 4: Tenancy registrations — cascade, export policy, org merge

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, the `'onedrive_device_state'` / `'org_ticket_settings'` neighbours at :503)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:329-330` area
- Modify: `apps/api/src/services/orgMergeRegistry.ts:701-702` (`REPOINT_TABLES`)

**Interfaces:**
- Consumes: the table from Task 1 and the column names from Task 3.
- Produces: `org_documents` present in all three registries; `getOrgCascadeDeleteOrder()` still alphabetised.

- [ ] **Step 1: Cascade list**

Insert `'org_documents',` between `'onedrive_device_state',` and `'org_ticket_settings',` in `CORE_ORG_CASCADE_DELETE_ORDER`, with this comment:

```ts
  // org_documents (service deliverables W03). Alphabetical slot only: the list
  // is STATIC and alphabetised (the contract test asserts exactly that), while
  // the real delete order comes from topologicalCascadeOrder(), which reads FK
  // edges from pg_catalog at run time. service_deliverable_evidence is an FK
  // CHILD of org_documents (sd_evidence_document_org_fk), so the topological
  // pass necessarily emits it FIRST — verified by the "topological order has all
  // FK children appearing before their parents" case in
  // tenantCascade.integration.test.ts. The self-FK on supersedes_document_id is
  // ignored by that sort by design (one DELETE clears the whole org's rows).
  'org_documents',
```

Verified with `node --eval "console.log('org_documents'.localeCompare('org_ticket_settings'))"` → `-1`, and `'onedrive_device_state'.localeCompare('org_documents')` → `-1`.

- [ ] **Step 2: Export policy**

Insert into `CORE_TENANT_EXPORT_POLICY` just before the `"org_ticket_settings"` entry:

```ts
  // org_documents (W03): `data` is bytea -> excludedOpen by the open-container
  // rule. storage_key is an opaque `org-documents/<id>` path with no tenant
  // identifier (precedent: ticket_attachments.storage_key, included). sha256 is
  // a content digest — classified reviewedIncluded rather than included so the
  // integrity value is explicitly signed off rather than passing on the
  // technicality that "sha256" misses SUSPICIOUS_NAME_PARTS.
  "org_documents": tablePolicy("org_id", {
    included: ["id", "org_id", "title", "description", "category", "storage_backend", "storage_key", "content_type", "byte_size", "original_filename", "uploaded_by_user_id", "portal_visible", "supersedes_document_id", "deleted_at", "deleted_by", "created_at"],
    reviewedIncluded: ["sha256"],
    excludedSensitive: [],
    excludedOpen: ["data"],
  }),
```

Every column of the table must appear exactly once across the four arrays — `tablePolicy` throws on a duplicate, and `tenant-export-policy.integration.test.ts` throws on a column that is present in the live table but missing here.

- [ ] **Step 3: Org merge registry**

Insert `"org_documents",` between `"onedrive_device_state",` and `"organization_external_links",` in `REPOINT_TABLES` with:

```ts
  // Plain repoint, NOT repoint-dedupe: org_documents has no org-scoped unique
  // key (two orgs may both hold "Firewall baseline"), so after a merge the
  // survivor simply holds both libraries and there is nothing to drop. The
  // supersedes chain is intra-org and its composite FK is deferrable, so it
  // survives the re-point unchanged.
  "org_documents",
```

- [ ] **Step 4: Run the standing contract suites**

Run (test-stack up):
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: all PASS. `rls-coverage` needs no allowlist entry — shape-1 tables are auto-discovered. A failure names the missing table or column; fix the registration, never the test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "chore(tenancy): register org_documents in cascade, export policy and merge registry (W03)"
```

---

### Task 5: Extract `services/blobStorage.ts`

**Files:**
- Create: `apps/api/src/services/blobStorage.ts`
- Create: `apps/api/src/services/blobStorage.test.ts`
- Modify: `apps/api/src/services/ticketAttachmentStorage.ts` (whole file → thin wrapper)

**Interfaces:**
- Consumes: `deleteObjects`, `getObjectStream`, `isS3Configured`, `putObjectBuffer` from `./s3Storage`.
- Produces:

```ts
export class BlobStorageError extends Error { readonly code: 'STORAGE_UNAVAILABLE'; readonly status: 503 }
export type BlobBackend = 's3' | 'db';
export interface BlobBytesRow { storageBackend: BlobBackend; storageKey: string | null; data: Buffer | null }
export function selectBackend(): BlobBackend;
export function objectKeyFor(prefix: string, id: string): string;                     // `${prefix}/${id}`
export function putBlob(args: { prefix: string; id: string; buffer: Buffer; contentType: string; sha256: string })
  : Promise<{ backend: BlobBackend; storageKey: string | null; data: Buffer | null }>;
export function getBlobStream(row: BlobBytesRow): Promise<{ body: Readable | Buffer | null; contentLength: number | null }>;
export function deleteBlob(row: BlobBytesRow): Promise<void>;
export function deleteBlobKeys(keys: readonly string[]): Promise<void>;
```
- Still produces, unchanged, from `ticketAttachmentStorage.ts`: `AttachmentStorageError`, `AttachmentBackend`, `AttachmentBytesRow`, `selectBackend`, `objectKeyFor`, `putBytes`, `openBytes`, `deleteBytes`, `deleteObjectKeys`.

- [ ] **Step 1: Write the failing test for the generic helper**

`apps/api/src/services/blobStorage.test.ts` is `ticketAttachmentStorage.test.ts:1-32` verbatim for the harness (the same `vi.mock('./s3Storage')` stub, the same `ORIGINAL_ENV` / `withS3()` helpers, the same `beforeEach`/`afterEach` env reset) with `describe('blobStorage (service deliverables W03)')`. Both files sit in `apps/api/src/services/`, so `'./s3Storage'` resolves to the same module id and the stub behaves identically. The cases:

```ts
  it('the key prefix is a parameter and the key carries no tenant identifier', async () => {
    const { objectKeyFor } = await import('./blobStorage');
    expect(objectKeyFor('org-documents', 'd-1')).toBe('org-documents/d-1');
    expect(objectKeyFor('ticket-attachments', 'a-1')).toBe('ticket-attachments/a-1');
  });

  it('putBlob writes the object under the caller prefix on the s3 backend', async () => {
    withS3();
    const { putBlob } = await import('./blobStorage');
    const res = await putBlob({ prefix: 'org-documents', id: 'd-2', buffer: Buffer.from('hi'), contentType: 'application/pdf', sha256: 'b'.repeat(64) });
    expect(putObjectBuffer).toHaveBeenCalledWith('org-documents/d-2', expect.any(Buffer), 'application/pdf', 'b'.repeat(64));
    expect(res).toEqual({ backend: 's3', storageKey: 'org-documents/d-2', data: null });
  });

  // THE headline assertion, carried over from the ticket module.
  it('putBlob NEVER falls back to db when the s3 put fails — it throws STORAGE_UNAVAILABLE', async () => {
    withS3();
    putObjectBuffer.mockRejectedValueOnce(new Error('s3 down') as never);
    const { putBlob, BlobStorageError } = await import('./blobStorage');
    let thrown: unknown; let returned: unknown;
    try {
      returned = await putBlob({ prefix: 'org-documents', id: 'd-4', buffer: Buffer.from('hi'), contentType: 'application/pdf', sha256: 'd'.repeat(64) });
    } catch (e) { thrown = e; }
    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(BlobStorageError);
    expect((thrown as InstanceType<typeof BlobStorageError>).status).toBe(503);
    expect((thrown as InstanceType<typeof BlobStorageError>).code).toBe('STORAGE_UNAVAILABLE');
  });

  it('getBlobStream routes by row.storageBackend, never by whether storageKey happens to be set', async () => {
    withS3();
    const { getBlobStream } = await import('./blobStorage');
    const res = await getBlobStream({ storageBackend: 'db', storageKey: 'org-documents/oops', data: Buffer.from('inline') });
    expect(getObjectStream).not.toHaveBeenCalled();
    expect(res.body).toBeInstanceOf(Buffer);
    await getBlobStream({ storageBackend: 's3', storageKey: 'org-documents/k', data: null });
    expect(getObjectStream).toHaveBeenCalledWith('org-documents/k');
  });
```

Plus three cases ported unchanged except for the prefix argument, from `ticketAttachmentStorage.test.ts:34-41`, `:49-55` and `:101-117`: `selectBackend` is `s3` only when all three S3 env vars are set; `putBlob` on the `db` backend returns the buffer inline and never calls `putObjectBuffer`; `deleteBlob` is a no-op for a `db` row and `deleteBlobKeys` skips an empty list and forwards a non-empty one to `deleteObjects`.

- [ ] **Step 2: Run it to watch it fail**

Run: `cd apps/api && npx vitest run src/services/blobStorage.test.ts`
Expected: FAIL — `Cannot find module './blobStorage'`.

- [ ] **Step 3: Write `blobStorage.ts`**

This is a MOVE, not a rewrite. Take `apps/api/src/services/ticketAttachmentStorage.ts:1-110` whole and apply exactly these edits; nothing else changes, so the behaviour the five existing test files pin cannot drift:

1. Rename `AttachmentStorageError` → `BlobStorageError` (keep `readonly code = 'STORAGE_UNAVAILABLE' as const`, `readonly status = 503 as const`, and set `this.name = 'BlobStorageError'`), `AttachmentBackend` → `BlobBackend`, `AttachmentBytesRow` → `BlobBytesRow`.
2. Rename `openBytes` → `getBlobStream`, `deleteBytes` → `deleteBlob`, `deleteObjectKeys` → `deleteBlobKeys`. Their bodies are unchanged.
3. Change the two error messages from `'Attachment storage is unavailable'` to `'Blob storage is unavailable'`.
4. Replace `objectKeyFor` and `putBytes` with the prefix-parameterised forms below. `putBlob` takes an args object rather than five positionals because the prefix would otherwise be a sixth unnamed string next to `contentType` and `sha256`.

```ts
/** Opaque object key — surface prefix plus row id, never an org/ticket id. */
export function objectKeyFor(prefix: string, id: string): string {
  return `${prefix}/${id}`;
}

/**
 * Write the bytes for a not-yet-inserted row.
 *
 * Put-before-insert: a put failure leaves no row at all; the caller compensates
 * an INSERT failure with `deleteBlob`. Throws `BlobStorageError` (503) when the
 * S3 backend is selected and the put fails — it NEVER degrades to `db`.
 */
export async function putBlob(args: {
  prefix: string; id: string; buffer: Buffer; contentType: string; sha256: string;
}): Promise<{ backend: BlobBackend; storageKey: string | null; data: Buffer | null }> {
  const backend = selectBackend();
  if (backend === 'db') return { backend, storageKey: null, data: args.buffer };
  const storageKey = objectKeyFor(args.prefix, args.id);
  try {
    await putObjectBuffer(storageKey, args.buffer, args.contentType, args.sha256);
  } catch (err) {
    throw new BlobStorageError('Blob storage is unavailable', { cause: err });
  }
  return { backend, storageKey, data: null };
}
```

5. Keep the module docstring from `ticketAttachmentStorage.ts:4-18` word for word — its three invariants (backend chosen once; never falls back from `s3` to `db`; keys carry no tenant identifier) are the reason the module exists — with one added sentence: "The `prefix` is the SURFACE (`ticket-attachments`, `org-documents`), never a tenant."

- [ ] **Step 4: Rewrite `ticketAttachmentStorage.ts` as the wrapper**

The whole file becomes bindings. Keep the module docstring, replacing its invariants with a pointer to `blobStorage.ts` and this note:

> `AttachmentStorageError` is an ALIAS of `BlobStorageError`, not a subclass: one 503 fault type means `putBytes` can delegate without a rewrap, and every existing `instanceof AttachmentStorageError` check keeps matching. The only observable change is `err.name`, now `'BlobStorageError'`; which surface faulted is already carried by the route's own error code and Sentry breadcrumb.

```ts
import type { Readable } from 'node:stream';
import {
  deleteBlob, deleteBlobKeys, getBlobStream, objectKeyFor as blobObjectKeyFor, putBlob,
  selectBackend as selectBlobBackend, type BlobBackend, type BlobBytesRow,
} from './blobStorage';

export { BlobStorageError as AttachmentStorageError, deleteBlobKeys as deleteObjectKeys } from './blobStorage';

export type AttachmentBackend = BlobBackend;
export type AttachmentBytesRow = BlobBytesRow;

/** Ticket attachments' object-key namespace (spec D8). */
export const TICKET_ATTACHMENT_PREFIX = 'ticket-attachments';

export function selectBackend(): AttachmentBackend { return selectBlobBackend(); }

export function objectKeyFor(attachmentId: string): string {
  return blobObjectKeyFor(TICKET_ATTACHMENT_PREFIX, attachmentId);
}

export function putBytes(attachmentId: string, buf: Buffer, contentType: string, sha256: string) {
  return putBlob({ prefix: TICKET_ATTACHMENT_PREFIX, id: attachmentId, buffer: buf, contentType, sha256 });
}

export function openBytes(row: AttachmentBytesRow): Promise<{ body: Readable | Buffer | null; contentLength: number | null }> {
  return getBlobStream(row);
}

export function deleteBytes(row: AttachmentBytesRow): Promise<void> { return deleteBlob(row); }
```

- [ ] **Step 5: Prove the extraction changed no ticket behaviour**

Run:
```bash
cd apps/api && npx vitest run \
  src/services/blobStorage.test.ts \
  src/services/ticketAttachmentStorage.test.ts \
  src/routes/tickets/attachments.test.ts \
  src/routes/portal/tickets.test.ts \
  src/jobs/ticketAttachmentReaper.test.ts \
  src/services/tenantCascade.test.ts
```
Expected: all PASS with **no edits to any of those five existing test files**. They are the contract: upload compensation, object-before-row deletion, 503 `STORAGE_UNAVAILABLE`, no presigned URLs, the reaper's `deleteObjectKeys` mock and `tenantCascade`'s `vi.mock('./ticketAttachmentStorage')`. If any of them needs a change here, the wrapper is not thin enough — fix the wrapper, not the test.

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/blobStorage.ts apps/api/src/services/blobStorage.test.ts apps/api/src/services/ticketAttachmentStorage.ts
git commit -m "refactor(storage): extract generic blobStorage from ticketAttachmentStorage (W03)"
```

---

### Task 6: Widen the erasure S3 pre-clear to `org_documents`

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts:1111-1150` (the `1a.` block)
- Modify: `apps/api/src/services/tenantCascade.test.ts:451-515` (two named assertions)

**Interfaces:**
- Consumes: `deleteObjectKeys` from `./ticketAttachmentStorage` (line 50 — keep that import path: `tenantCascade.test.ts:92` mocks exactly that module).
- Produces: a single pre-clear read covering both byte tables; failure step name `tenant_object_preclear`.

- [ ] **Step 1: Update the failing assertions in the existing unit test first**

In `apps/api/src/services/tenantCascade.test.ts`, in `'scopes the key read to this org and to s3-backed rows only'`, add after `expect(keyQuery).toContain('ticket_attachments');`:

```ts
    // W03: the pre-clear is ONE read over BOTH byte tables. A second query
    // would double the deleteObjectKeys call and break the ordering assertion
    // in the sibling test, so this is a union, not a second statement.
    expect(keyQuery).toContain('org_documents');
```

and in `'ABORTS rerunnably on an object-store fault, leaving the rows and writing the failed audit'`, change the expected `failedTable` from `'ticket_attachments_objects'` to `'tenant_object_preclear'` — the step now covers two tables, so the old label would name only half of what failed.

- [ ] **Step 2: Run to watch both fail**

Run: `cd apps/api && npx vitest run src/services/tenantCascade.test.ts`
Expected: exactly two failures — the missing `org_documents` substring and the `failedTable` mismatch. Any other failure means something else moved; stop and investigate.

- [ ] **Step 3: Widen the pre-clear**

Replace the body of the `1a.` block's `try` in `cascadeDeleteOrg` (the comment above it keeps its reasoning; extend it to name both tables):

```ts
  // 1a. Clear customer OBJECTS before ANY row is deleted anywhere (W08 #3902
  //     spec D9; widened to org_documents by service deliverables W03 spec §4.9).
  //     The rows are the ONLY index to the object keys — deleting them first
  //     would leave customer bytes in the bucket with nothing left to find them
  //     by, which is exactly the GDPR failure erasure exists to prevent. A
  //     storage fault therefore ABORTS the erasure before anything is removed,
  //     so the operator can re-run it once the bucket is back.
  //
  //     ONE read over both byte tables, not two: a second statement would mean a
  //     second deleteObjectKeys batch and a second abort path, and the
  //     object-deletes-before-first-DELETE ordering would stop being a single
  //     observable step. db-backed rows carry their bytes in the row and need no
  //     pre-clear; a soft-deleted org_documents row has already had its object
  //     removed and its storage_key cleared, so it is excluded by the NOT NULL.
  try {
    const keys = await dbModule.withSystemDbAccessContext(async () => {
      const result = await dbModule.db.execute(sql`
        SELECT storage_key
        FROM ticket_attachments
        WHERE org_id = ${orgId}::uuid
          AND storage_backend = 's3'
          AND storage_key IS NOT NULL
        UNION ALL
        SELECT storage_key
        FROM org_documents
        WHERE org_id = ${orgId}::uuid
          AND storage_backend = 's3'
          AND storage_key IS NOT NULL
      `);
      const rows = (result as unknown as { rows?: Array<{ storage_key: string }> }).rows
        ?? (result as unknown as Array<{ storage_key: string }>);
      return Array.isArray(rows) ? rows.map((r) => r.storage_key).filter(Boolean) : [];
    });
    if (keys.length > 0) {
      await deleteObjectKeys(keys);
    }
  } catch (err) {
    if (!isUndefinedTable(err)) {
      await writeErasureFailedAudit(
        orgId, performedBy, performedByEmail, 'tenant_object_preclear', stats, err,
      );
      throw new Error(
        `[tenantCascade] object pre-clear failed for org=${orgId}; erasure aborted before any row was deleted and is rerunnable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
```

The `isUndefinedTable` tolerance now covers both tables at once — acceptable because both ship in the same product and the guard exists only for partial-schema fixtures.

- [ ] **Step 4: Run to watch them pass**

Run: `cd apps/api && npx vitest run src/services/tenantCascade.test.ts src/services/tenantCascade.partner.test.ts`
Expected: PASS, including the untouched `'reads the s3 keys and deletes the objects BEFORE the first cascade DELETE'` ordering case (still one select, one object-delete batch, then only deletes).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantCascade.test.ts
git commit -m "fix(tenancy): erasure object pre-clear covers org_documents as well as ticket attachments (W03)"
```

---

### Task 7: `services/orgDocumentService.ts`

**Files:**
- Create: `apps/api/src/services/orgDocumentService.ts`
- Create: `apps/api/src/services/orgDocumentService.test.ts`
- Create: `packages/shared/src/validators/orgDocuments.ts` + `.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (export the new module)

**Interfaces:**
- Consumes: `DeliverableActor`, `DeliverableServiceError` from `./serviceDeliverableService` (W01 Task 8); `orgDocuments`, `ORG_DOCUMENT_META_COLUMNS` from Task 3; `putBlob`/`getBlobStream`/`deleteBlob`/`BlobStorageError` from `./blobStorage`; `sniffAttachmentMime` from `./attachmentSniff`; `TICKET_ATTACHMENT_LIMITS` from `@breeze/shared`.
- Produces (Tasks 8–16 import these verbatim):

```ts
export const ORG_DOCUMENT_PREFIX = 'org-documents';
export interface UploadFile { buffer: Buffer; contentType: string; filename: string }
export interface OrgDocumentView {
  id: string; orgId: string; title: string; description: string | null;
  category: OrgDocumentCategory; contentType: string; byteSize: number; sha256: string;
  originalFilename: string; uploadedByUserId: string | null; portalVisible: boolean;
  supersedesDocumentId: string | null; supersededByDocumentId: string | null; createdAt: string;
}
export function listDocuments(orgId: string, q: { category?: OrgDocumentCategory; includeSuperseded?: boolean }, actor: DeliverableActor): Promise<OrgDocumentView[]>;
export function getDocument(orgId: string, id: string, actor: DeliverableActor): Promise<OrgDocumentView>;
export function uploadDocument(orgId: string, input: { title: string; description?: string | null; category: OrgDocumentCategory; portalVisible?: boolean; file: UploadFile }, actor: DeliverableActor): Promise<OrgDocumentView>;
export function replaceDocument(orgId: string, id: string, input: { title?: string; description?: string | null; category?: OrgDocumentCategory; portalVisible?: boolean; file: UploadFile }, actor: DeliverableActor): Promise<OrgDocumentView>;
export function updateDocument(orgId: string, id: string, patch: { title?: string; description?: string | null; category?: OrgDocumentCategory; portalVisible?: boolean }, actor: DeliverableActor): Promise<OrgDocumentView>;
export function supersedeDocument(orgId: string, id: string, supersedesDocumentId: string, actor: DeliverableActor): Promise<OrgDocumentView>;
export function deleteDocument(orgId: string, id: string, actor: DeliverableActor): Promise<void>;
export function streamDocument(orgId: string, id: string, actor: DeliverableActor): Promise<{ view: OrgDocumentView; contentType: string; originalFilename: string; sha256: string; body: Readable | Buffer | null; contentLength: number | null }>;
```

Rules the service enforces (each has a test):

- `requireOrgAccess(actor, orgId)` and every "row not in this org / soft-deleted" path → 404 `NOT_FOUND`, never 403.
- Empty buffer → 400 `EMPTY_FILE`. Over `TICKET_ATTACHMENT_LIMITS.maxBytes` → 413 `FILE_TOO_LARGE`. `sniffAttachmentMime(buf)` returns null → 415 `UNSUPPORTED_DOCUMENT_TYPE`. The stored `content_type` is the SNIFFED one; the client's is never consulted.
- `BlobStorageError` from `putBlob` → 503 `STORAGE_UNAVAILABLE` and **no row written**. An INSERT failure after a successful put compensates with `deleteBlob` in a `try/catch` that never masks the original error.
- `replaceDocument` / `supersedeDocument`: the target must exist in the org, must not be soft-deleted, and must be a chain HEAD (no row already has `supersedes_document_id = target`) → otherwise 409 `NOT_HEAD`. The unique index is the DB backstop: a `23505` on insert also maps to 409 `NOT_HEAD`.
- `supersedeDocument` additionally rejects `id === supersedesDocumentId` (400 `INVALID_SUPERSEDE`) and a document that already supersedes something (409 `ALREADY_SUPERSEDES`).
- `listDocuments` returns chain HEADS only unless `includeSuperseded`, and never soft-deleted rows; ordered `createdAt DESC`.
- `deleteDocument` is a soft delete that removes the bytes FIRST (`deleteBlob`, or clearing `data` for a `db` row), then stamps `deleted_at`/`deleted_by` and nulls `storage_key` and `data` in one UPDATE. A storage fault → 503 and nothing is stamped, so the delete is retryable.
- `streamDocument` never selects `data` for an `s3` row and never returns a URL.

- [ ] **Step 1: Write the shared validators**

`packages/shared/src/validators/orgDocuments.ts`:

```ts
import { z } from 'zod';

export const orgDocumentCategorySchema = z.enum([
  'baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other',
]);

/** Multipart text parts arrive as strings, so booleans are coerced from 'true'/'false'. */
const boolFromForm = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

export const uploadDocumentMetaSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
  category: orgDocumentCategorySchema.default('other'),
  portalVisible: boolFromForm.default(false),
});

/** Replace reuses the upload metadata, but every field is optional: omitted
 *  fields are inherited from the document being replaced. */
export const replaceDocumentMetaSchema = uploadDocumentMetaSchema.partial();

export const updateDocumentSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  category: orgDocumentCategorySchema.optional(),
  portalVisible: z.boolean().optional(),
}).strict().refine((p) => Object.keys(p).length > 0, { message: 'at least one field must be provided' });

export const listDocumentsQuerySchema = z.object({
  category: orgDocumentCategorySchema.optional(),
  includeSuperseded: z.coerce.boolean().optional(),
});

export type OrgDocumentCategory = z.infer<typeof orgDocumentCategorySchema>;
export type UploadDocumentMeta = z.infer<typeof uploadDocumentMetaSchema>;
export type ReplaceDocumentMeta = z.infer<typeof replaceDocumentMetaSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
```

Its test asserts: `portalVisible` defaults to `false` (fail closed), `'true'` coerces to `true`, a 201-character title fails, `updateDocumentSchema` rejects `{}` and rejects an unknown key.

- [ ] **Step 2: Write the failing service tests**

`apps/api/src/services/orgDocumentService.test.ts`, using the Drizzle mock pattern from the `breeze-testing` skill — the same `vi.hoisted` chainable `select/from/where/limit` stub W01 Task 8 uses for `serviceDeliverableService.test.ts`, plus:

```ts
const putBlob = vi.hoisted(() => vi.fn());
const deleteBlob = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./blobStorage', async () => {
  const actual = await vi.importActual<typeof import('./blobStorage')>('./blobStorage');
  return { ...actual, putBlob, deleteBlob };   // BlobStorageError stays real, so instanceof works
});

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
const pdf = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(64, 1)]);
const file = { buffer: pdf, contentType: 'text/html', filename: 'runbook.pdf' };   // lying client type
```

The discriminating cases, in full:

```ts
  it('stores the SNIFFED content type, never the client-supplied one', async () => {
    state.rows.push([{ id: 'd1', orgId: 'org1', contentType: 'application/pdf' }]);
    await uploadDocument('org1', { title: 'Runbook', category: 'runbook', file }, actor);
    expect(putBlob).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'org-documents', contentType: 'application/pdf' }));
  });

  it('rejects an unsniffable payload with 415 and never puts an object', async () => {
    await expect(uploadDocument('org1', { title: 'x', category: 'other', file: { ...file, buffer: Buffer.from('<html>') } }, actor))
      .rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_DOCUMENT_TYPE' });
    expect(putBlob).not.toHaveBeenCalled();
  });

  it('maps a storage fault to 503 and writes no row', async () => {
    putBlob.mockRejectedValueOnce(new BlobStorageError('down'));
    await expect(uploadDocument('org1', { title: 'x', category: 'other', file }, actor))
      .rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
  });

  it('refuses to replace a document that already has a successor (409 NOT_HEAD)', async () => {
    state.rows.push([{ id: 'd1', orgId: 'org1', deletedAt: null }]);   // target load
    state.rows.push([{ id: 'd2' }]);                                    // successor exists
    await expect(replaceDocument('org1', 'd1', { file }, actor))
      .rejects.toMatchObject({ status: 409, code: 'NOT_HEAD' });
    expect(putBlob).not.toHaveBeenCalled();
  });

  it('deletes the object BEFORE stamping the tombstone', async () => {
    const order: string[] = [];
    deleteBlob.mockImplementation(async () => { order.push('object'); });
    state.rows.push([{ id: 'd1', orgId: 'org1', deletedAt: null, storageBackend: 's3', storageKey: 'org-documents/d1', data: null }]);
    state.rows.push([{ id: 'd1' }]);
    await deleteDocument('org1', 'd1', actor);
    expect(order).toEqual(['object']);   // the UPDATE only runs after the object is gone
  });
```

Add one case per remaining rule: a foreign org on every exported function → `{ status: 404, code: 'NOT_FOUND' }` (never 403); a 10 MiB + 1 byte payload → 413 `FILE_TOO_LARGE` with `putBlob` untouched; an empty buffer → 400 `EMPTY_FILE`; `listDocuments` omitting superseded and soft-deleted rows by default and including superseded ones under the flag; `updateDocument` on a soft-deleted row → 404; `supersedeDocument` with `id === supersedesDocumentId` → 400 `INVALID_SUPERSEDE`; a document that already supersedes something → 409 `ALREADY_SUPERSEDES`; and a `23505` raised by the insert mapping to 409 `NOT_HEAD` (the DB backstop for a lost race on the head check).

- [ ] **Step 3: Run to watch them fail**

Run: `cd apps/api && npx vitest run src/services/orgDocumentService.test.ts`
Expected: FAIL — `Cannot find module './orgDocumentService'`.

- [ ] **Step 4: Implement the service**

Skeleton (fill every function; `requireOrgAccess` and the error class come from W01):

```ts
import { randomUUID, createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TICKET_ATTACHMENT_LIMITS, type OrgDocumentCategory } from '@breeze/shared';
import { db } from '../db';
import { orgDocuments, ORG_DOCUMENT_META_COLUMNS, type OrgDocumentRow } from '../db/schema/orgDocuments';
import { BlobStorageError, deleteBlob, getBlobStream, putBlob } from './blobStorage';
import { sniffAttachmentMime } from './attachmentSniff';
import { sanitizeAttachmentFilename } from '../routes/tickets/attachments';
import { DeliverableServiceError, type DeliverableActor } from './serviceDeliverableService';
import { pgErrorCode } from '../utils/pgErrors';

export const ORG_DOCUMENT_PREFIX = 'org-documents';

function requireOrgAccess(actor: DeliverableActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new DeliverableServiceError('Not found', 404, 'NOT_FOUND');
  }
}

/** Validate bytes and return the sniffed type. The client's Content-Type is
 *  NEVER consulted — magic bytes only, same rule as ticket attachments (D4). */
function validateFile(file: UploadFile): { contentType: string; sha256: string } {
  if (file.buffer.length === 0) throw new DeliverableServiceError('Document is empty', 400, 'EMPTY_FILE');
  if (file.buffer.length > TICKET_ATTACHMENT_LIMITS.maxBytes) {
    throw new DeliverableServiceError('Document too large (max 10 MB)', 413, 'FILE_TOO_LARGE');
  }
  const contentType = sniffAttachmentMime(file.buffer);
  if (!contentType) {
    throw new DeliverableServiceError('Only JPEG, PNG, WebP images and PDFs can be stored', 415, 'UNSUPPORTED_DOCUMENT_TYPE');
  }
  return { contentType, sha256: createHash('sha256').update(file.buffer).digest('hex') };
}

/** Put-then-insert with a compensating delete that never masks the insert fault. */
async function insertWithBytes(row: {/* … */}, file: UploadFile): Promise<OrgDocumentRow> { /* … */ }
```

`listDocuments` builds the head filter as a correlated `NOT EXISTS` so one query answers both the list and each row's `supersededByDocumentId`:

```ts
const successor = db.$with('successor');   // or a leftJoin alias over orgDocuments
// heads only:  NOT EXISTS (SELECT 1 FROM org_documents s WHERE s.supersedes_document_id = org_documents.id)
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd apps/api && npx vitest run src/services/orgDocumentService.test.ts && npx tsc --noEmit -p tsconfig.json`
Run: `cd packages/shared && npx vitest run src/validators/orgDocuments.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/orgDocumentService.ts apps/api/src/services/orgDocumentService.test.ts packages/shared/src/validators/orgDocuments.ts packages/shared/src/validators/orgDocuments.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(documents): org document service with upload, replace, supersede and soft delete (W03)"
```

---

### Task 8: `document` evidence kind

**Files:**
- Modify: `packages/shared/src/validators/serviceDeliverables.ts` (the `evidenceRefSchema` block from W01 Task 7)
- Modify: `packages/shared/src/validators/serviceDeliverables.test.ts` (flip the W01 negative case)
- Modify: `apps/api/src/services/serviceDeliverableService.ts` (`addEvidence`, `deliverOccurrence`)
- Modify: `apps/api/src/services/serviceDeliverableService.test.ts`

**Interfaces:**
- Consumes: `EvidenceRef`, `addEvidence`, `deliverOccurrence`, `getDeliverable`, `OccurrenceView`, `DeliverableSummary` from W01.
- Produces: `documentEvidenceRefSchema`; `evidenceRefSchema` now a two-arm discriminated union; `addEvidence` accepting `{ kind: 'document', documentId }`; and one new export on `serviceDeliverableService.ts` that Task 10 needs — W01 has no single-occurrence getter:

```ts
/** Load one occurrence by id, 404 NOT_FOUND on a foreign org or a missing row. */
export function getOccurrenceOr404(orgId: string, occurrenceId: string, actor: DeliverableActor): Promise<OccurrenceView>;
```

> **This task deliberately changes two W01 tests.** W01 Task 7 asserts `deliverOccurrenceSchema.safeParse({ evidence: [{ kind: 'document', documentId }] }).success === false`, and W01 Task 10 asserts the deliver route answers 400 for a `document` evidence kind. Both encoded "W03 has not landed yet". Flip them here — do not delete them.

- [ ] **Step 1: Flip the W01 validator assertion to the new expectation**

In `packages/shared/src/validators/serviceDeliverables.test.ts`, replace the negative case with:

```ts
  it('accepts a document evidence ref now that W03 has landed', () => {
    const parsed = deliverOccurrenceSchema.parse({ evidence: [{ kind: 'document', documentId: '11111111-1111-4111-8111-111111111111' }] });
    expect(parsed.evidence).toEqual([{ kind: 'document', documentId: '11111111-1111-4111-8111-111111111111' }]);
  });
  it('still rejects a document ref with no documentId', () => {
    expect(deliverOccurrenceSchema.safeParse({ evidence: [{ kind: 'document' }] }).success).toBe(false);
  });
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd packages/shared && npx vitest run src/validators/serviceDeliverables.test.ts`
Expected: FAIL — `Invalid discriminator value. Expected 'report_run'`.

- [ ] **Step 3: Widen the union**

```ts
export const reportRunEvidenceRefSchema = z.object({ kind: z.literal('report_run'), reportRunId: z.string().guid() });
export const documentEvidenceRefSchema = z.object({ kind: z.literal('document'), documentId: z.string().guid() });
// W03: both arms of deliverable_evidence_kind are now reachable from the API.
export const evidenceRefSchema = z.discriminatedUnion('kind', [reportRunEvidenceRefSchema, documentEvidenceRefSchema]);
```

- [ ] **Step 4: Teach the service the document arm**

In `addEvidence`, add the branch beside the existing `report_run` one:

```ts
  if (ref.kind === 'document') {
    // 404 not 403 (spec §12): a document of another org must be indistinguishable
    // from one that does not exist. The composite FK (document_id, org_id) is the
    // DB backstop, but the check is here so the caller gets a clean 404 instead
    // of a 23503.
    const [doc] = await db
      .select({ id: orgDocuments.id })
      .from(orgDocuments)
      .where(and(eq(orgDocuments.id, ref.documentId), eq(orgDocuments.orgId, orgId), isNull(orgDocuments.deletedAt)))
      .limit(1);
    if (!doc) throw new DeliverableServiceError('Not found', 404, 'NOT_FOUND');
    await db.insert(serviceDeliverableEvidence).values({
      orgId, occurrenceId, kind: 'document', documentId: doc.id,
      reportId: null, reportRunId: null, createdByUserId: actor.userId,
    });
  }
```

`deliverOccurrence` needs no new code — it already loops `input.evidence` through `addEvidence` before running `transition(...)` — but add a test proving a document ref satisfies `artifactRequired`. Extract the occurrence load that `deliverOccurrence` / `waiveOccurrence` already perform into the exported `getOccurrenceOr404` above (same `requireOrgAccess` + 404 rules, no behaviour change) and add a test that it answers 404 — never 403 — for an occurrence of another org.

- [ ] **Step 5: Run the affected tests**

Run: `cd packages/shared && npx vitest run src/validators/serviceDeliverables.test.ts`
Run: `cd apps/api && npx vitest run src/services/serviceDeliverableService.test.ts`
Expected: PASS, including a new case "delivering with a document evidence ref satisfies artifactRequired" and "a document of another org is 404, not 403".

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/serviceDeliverables.ts packages/shared/src/validators/serviceDeliverables.test.ts apps/api/src/services/serviceDeliverableService.ts apps/api/src/services/serviceDeliverableService.test.ts
git commit -m "feat(deliverables): document evidence kind on occurrences (W03)"
```

---

### Task 9: REST — `routes/orgDocuments.ts`

**Files:**
- Create: `apps/api/src/routes/orgDocuments.ts`, `apps/api/src/routes/orgDocuments.test.ts`
- Modify: `apps/api/src/index.ts:837` (after `api.route('/orgs', orgSummaryRoutes);`)

**Interfaces:**
- Produces:

```
GET    /orgs/:orgId/documents?category&includeSuperseded    documents:read
POST   /orgs/:orgId/documents                               documents:write   (multipart)
GET    /orgs/:orgId/documents/:id/content                   documents:read    (streams bytes)
PATCH  /orgs/:orgId/documents/:id                           documents:write
POST   /orgs/:orgId/documents/:id/replace                   documents:write   (multipart)
DELETE /orgs/:orgId/documents/:id                           documents:write
```

Every response is a `{ data }` envelope except `/content` (raw bytes) and DELETE (204).

Scope: `requireScope('organization', 'partner', 'system')`. This deliberately widens W01's `requireScope('partner', 'system')` — `documents:read`/`write` are granted to `Org Admin` and `Org Technician`, which are organization-scope roles, so a partner-only gate would hand them a permission they could never exercise. Org-scope tokens are still narrowed by `actor.accessibleOrgIds` and by RLS.

- [ ] **Step 1: Write the failing route tests**

Follow `apps/api/src/routes/contracts/periods.test.ts` (mock `../middleware/auth`, hoist service mocks). Minimum cases:

```ts
it('401 without auth', …);
it('403 without documents:read', …);
it('404 — not 403 — for an org the caller cannot access', …);   // service throws 404 NOT_FOUND
it('200 { data: [...] } lists heads only by default', …);
it('400 INVALID_MULTIPART when the body has no file part', …);
it('413 FILE_TOO_LARGE surfaces the service status verbatim', …);
it('415 UNSUPPORTED_DOCUMENT_TYPE surfaces the service status verbatim', …);
it('503 STORAGE_UNAVAILABLE surfaces the service status verbatim', …);
it('409 NOT_HEAD when replacing a document that already has a successor', …);
it('content sets Content-Type, ETag and Content-Disposition and never a Location/redirect', …);
it('204 on delete', …);
```

- [ ] **Step 2: Run to watch them fail**

Run: `cd apps/api && npx vitest run src/routes/orgDocuments.test.ts`
Expected: FAIL — `Cannot find module './orgDocuments'`.

- [ ] **Step 3: Implement the router**

```ts
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { zValidator } from '../lib/validation';
import { listDocumentsQuerySchema, replaceDocumentMetaSchema, updateDocumentSchema, uploadDocumentMetaSchema } from '@breeze/shared';
import { PERMISSIONS } from '../services/permissions';
import { requirePermission, requireScope } from '../middleware/auth';
import { userRateLimit } from '../middleware/userRateLimit';
import { captureException } from '../services/sentry';
import { createAuditLogAsync } from '../services/auditService';
import { contentDispositionFor } from './tickets/attachments';
import {
  deleteDocument, getDocument, listDocuments, replaceDocument, streamDocument, updateDocument,
  uploadDocument, type UploadFile,
} from '../services/orgDocumentService';
import { DeliverableServiceError, type DeliverableActor } from '../services/serviceDeliverableService';

export const orgDocumentRoutes = new Hono();

const orgParam = z.object({ orgId: z.string().guid() });
const docParam = z.object({ orgId: z.string().guid(), id: z.string().guid() });

/** Same actor shape W01's routers build (routes/serviceDeliverables.ts). */
export function documentActorFrom(c: Context): DeliverableActor {
  const auth = c.get('auth');
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds };
}

export function handleDocumentError(c: Context, err: unknown): Response {
  if (err instanceof DeliverableServiceError) {
    if (err.status >= 500) captureException(err);
    return c.json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status as 400);
  }
  throw err;
}

/** Exactly one file part, under any key, plus the text fields beside it.
 *  `collectFiles` is routes/tickets/attachments.ts:67-75 verbatim. */
export async function parseUpload(c: Context): Promise<{ file: UploadFile; fields: Record<string, unknown> } | { error: 'INVALID_MULTIPART' }> {
  let parsed: Record<string, unknown>;
  try { parsed = (await c.req.parseBody({ all: true })) as Record<string, unknown>; }
  catch { return { error: 'INVALID_MULTIPART' }; }
  const files = collectFiles(parsed);
  if (files.length !== 1) return { error: 'INVALID_MULTIPART' };
  const f = files[0]!;
  const fields = Object.fromEntries(Object.entries(parsed).filter(([, v]) => !(v instanceof File)));
  return { file: { buffer: Buffer.from(await f.arrayBuffer()), contentType: f.type || 'application/octet-stream', filename: f.name ?? '' }, fields };
}
```

Every handler is `try { return c.json({ data: await svc(...) }) } catch (err) { return handleDocumentError(c, err) }`, behind `requireScope('organization','partner','system')` and `requirePermission(PERMISSIONS.DOCUMENTS_READ…)` / `DOCUMENTS_WRITE`, with `zValidator('param', …)` and `zValidator('query', listDocumentsQuerySchema)` / `zValidator('json', updateDocumentSchema)` where the body is JSON. The two multipart handlers validate their text fields with `uploadDocumentMetaSchema` / `replaceDocumentMetaSchema` against `parsed.fields`, carry `userRateLimit('org-document-upload', 30, 60)`, and write `createAuditLogAsync` events (`organization.document.upload` / `.replace` / `.delete`) whose `details` **omit the filename** — it can carry customer PII, exactly as `attachments.ts:196` notes.

The content handler mirrors `routes/tickets/attachments.ts:315-352` step for step: ETag `"<sha256>"`; an `If-None-Match` match returns 304 **before** opening the bytes (a 304 that still fetched from the bucket is a silent egress bill); headers `Cache-Control: private, max-age=300`, `X-Content-Type-Options: nosniff`, `Content-Type` from the STORED sniffed type, `Content-Disposition: contentDispositionFor(contentType, originalFilename)`, `Content-Length`; then `c.body(new Uint8Array(body), 200, headers)` for a Buffer or `c.body(Readable.toWeb(body) as ReadableStream, 200, headers)` for a stream. A null body is a 404 with a `console.error` naming the id and backend — never a redirect, never a presigned URL.

Mount it in `apps/api/src/index.ts` directly after `api.route('/orgs', orgSummaryRoutes);`:

```ts
api.route('/orgs', orgDocumentRoutes);
```

- [ ] **Step 4: Run the tests and boot a smoke request**

Run: `cd apps/api && npx vitest run src/routes/orgDocuments.test.ts && npx tsc --noEmit -p tsconfig.json` → PASS.
Run the API against the test stack and `curl -sf -H "Authorization: Bearer <partner token>" localhost:3001/api/v1/orgs/<orgId>/documents` → `{"data":[]}`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/orgDocuments.ts apps/api/src/routes/orgDocuments.test.ts apps/api/src/index.ts
git commit -m "feat(documents): REST routes for the org document library (W03)"
```

---

### Task 10: Upload-on-deliver — `POST …/occurrences/:oId/evidence/upload`

**Files:**
- Modify: `apps/api/src/routes/serviceDeliverables.ts` (W01 Task 10)
- Modify: `apps/api/src/routes/serviceDeliverables.test.ts`
- Modify: `apps/api/src/services/orgDocumentService.ts` (no new export; `uploadDocument` is reused)

**Interfaces:**
- Produces: `POST /orgs/:orgId/deliverables/occurrences/:oId/evidence/upload` (multipart), `contracts:write`, returning `{ data: OccurrenceView }`.

Spec §7: "Uploaded evidence creates an `org_documents` row with `category='evidence'` and `portal_visible` copied from the deliverable."

- [ ] **Step 1: Write the failing route test**

```ts
it('uploading evidence creates an evidence-category document that inherits the deliverable portal flag, then links it', async () => {
  uploadDocumentMock.mockResolvedValue({ id: 'doc-1', portalVisible: true });
  addEvidenceMock.mockResolvedValue({ id: 'occ-1', evidence: [{ id: 'e1', kind: 'document', documentId: 'doc-1' }] });
  const form = new FormData();
  form.append('file', new File([pdfBytes], 'findings.pdf', { type: 'application/pdf' }));
  const res = await app.request('/orgs/org1/deliverables/occurrences/occ-1/evidence/upload', { method: 'POST', body: form }, env);
  expect(res.status).toBe(200);
  expect(uploadDocumentMock).toHaveBeenCalledWith('org1', expect.objectContaining({ category: 'evidence', portalVisible: true }), expect.anything());
  expect(addEvidenceMock).toHaveBeenCalledWith('org1', 'occ-1', { kind: 'document', documentId: 'doc-1' }, expect.anything());
});

it('returns 415 from the document service without creating an evidence row', async () => { /* … */ });
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd apps/api && npx vitest run src/routes/serviceDeliverables.test.ts`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Implement the route**

```ts
// Spec §7 upload-on-deliver. Two writes, ordered: the document must exist
// before it can be evidence. If the link fails the document survives as an
// ordinary library row rather than a dangling upload — deliberately NOT
// compensated, because a technician's uploaded artifact is customer data we
// would rather keep and re-link than silently discard.
serviceDeliverableRoutes.post(
  '/:orgId/deliverables/occurrences/:oId/evidence/upload',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action),
  zValidator('param', z.object({ orgId: z.string().guid(), oId: z.string().guid() })),
  userRateLimit('deliverable-evidence-upload', 30, 60),
  async (c) => {
    const { orgId, oId } = c.req.valid('param');
    const actor = deliverableActorFrom(c);
    const parsed = await parseUpload(c);
    if ('error' in parsed) return c.json({ error: 'Expected exactly one file part named "file"', code: 'INVALID_MULTIPART' }, 400);
    try {
      const occ = await getOccurrenceOr404(orgId, oId, actor);
      const deliverable = await getDeliverable(orgId, occ.deliverableId, actor);
      const doc = await uploadDocument(orgId, {
        title: String(parsed.fields.title ?? parsed.file.filename ?? 'Evidence'),
        description: typeof parsed.fields.description === 'string' ? parsed.fields.description : null,
        category: 'evidence',
        portalVisible: deliverable.portalVisible,
        file: parsed.file,
      }, actor);
      return c.json({ data: await addEvidence(orgId, oId, { kind: 'document', documentId: doc.id }, actor) });
    } catch (err) {
      return handleDeliverableError(c, err);
    }
  },
);
```

`parseUpload` is Task 9's exported helper — import it from `./orgDocuments` rather than duplicating the multipart parsing. `handleDeliverableError`, `deliverableActorFrom`, `getOccurrenceOr404` and `getDeliverable` are W01's, already in this file.

- [ ] **Step 4: Run**

Run: `cd apps/api && npx vitest run src/routes/serviceDeliverables.test.ts src/routes/orgDocuments.test.ts && npx tsc --noEmit -p tsconfig.json` → PASS.
Also fix the W01 route test that asserted a `document` evidence kind yields 400 on `…/deliver` — it must now assert 200 and a linked document (see Task 8's note).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/serviceDeliverables.ts apps/api/src/routes/serviceDeliverables.test.ts apps/api/src/routes/orgDocuments.ts
git commit -m "feat(deliverables): upload evidence on an occurrence as an org document (W03)"
```

---

### Task 11: Integration suite — `orgDocumentsRls.integration.test.ts`

**Files:**
- Create: `apps/api/src/__tests__/integration/orgDocumentsRls.integration.test.ts`

Follow the header pattern of the sibling `*Rls.integration.test.ts` files (`import './setup'`, `getTestDb()` for RLS-bypassing seeding, `withDbAccessContext(orgContext(orgId), …)` for the code under test).

- [ ] **Step 1: Write the tests**

1. **Cross-org forge**: in org A's context, `INSERT INTO org_documents (org_id, …) VALUES (<org B>, …)` → rejects with SQLSTATE `42501`.
2. **Positive control**: in org A's context, insert and read back org A's own row → exactly 1 row. Without this the forge test can pass vacuously (a broken fixture rejects everything).
3. **Cross-org read**: org B's document inserted under system context is invisible to org A's context (`SELECT count(*)` → 0).
4. **Chain integrity**: insert D1, then D2 with `supersedes_document_id = D1` (succeeds), then D3 with `supersedes_document_id = D1` → rejects with `23505` (`org_documents_supersedes_uq`). Assert the SQLSTATE, not the message.
5. **Cross-org supersede**: a document of org A superseding a document of org B → rejects with `23503` (`org_documents_supersedes_org_fk`).
6. **Evidence FK to a foreign org's document**: with an org-A occurrence and an org-B document, a system-context `INSERT INTO service_deliverable_evidence (org_id=A, occurrence_id=<A>, kind='document', document_id=<B's doc>)` → rejects with `23503` (`sd_evidence_document_org_fk`).
7. **Deferrable re-point**: in one system-context transaction, `SET CONSTRAINTS ALL DEFERRED`, move a document and its predecessor to another org in separate statements, commit → succeeds. Mirror the shape `orgLifecycleFoundations.integration.test.ts` uses for one FK.
8. **Evidence cascade**: deleting an `org_documents` row removes its evidence rows (`ON DELETE CASCADE`) and leaves the occurrence.

- [ ] **Step 2: Run**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgDocumentsRls.integration.test.ts`
Expected: PASS, and the output must report **8 tests ran**. A `0 tests` line is a stall, not green.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/orgDocumentsRls.integration.test.ts
git commit -m "test(documents): RLS, chain integrity and evidence-ownership integration suite (W03)"
```

---

### Task 12: Prove object-before-row in the erasure round-trip

**Files:**
- Modify: `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`

**Interfaces:**
- Consumes: `seedTwoOrgs()`, `rowCount(db, table, orgId)` (`:388`), `cascadeDeleteOrg` — all already in the file.

The suite runs with no S3 configured, so `deleteObjects` → `requireBucket()` throws. That is the lever: an S3-backed document makes the pre-clear fault, and a faulting pre-clear must abort **before any row is deleted**.

- [ ] **Step 1: Write the failing test**

Add a new `it` at the end of the describe block (do NOT touch the existing `'cascade erases the target org and leaves the other org intact'` case — its orgs must stay object-free so its assertions keep passing):

```ts
  it('aborts erasure before any row when an S3-backed org document cannot be cleared, then completes once the object is gone (W03)', async () => {
    const db = getTestDb();
    const { orgA } = await seedTwoOrgs();
    const docId = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO org_documents (id, org_id, title, category, storage_backend, storage_key,
                                 content_type, byte_size, sha256, original_filename)
      VALUES (${docId}, ${orgA}, 'Onboarding baseline', 'baseline', 's3', ${`org-documents/${docId}`},
              'application/pdf', 1024, ${'a'.repeat(64)}, 'baseline.pdf')
    `);
    expect(await rowCount(db, 'org_documents', orgA)).toBe(1);

    // No S3 bucket is configured in the integration environment, so the object
    // pre-clear faults. The contract is that it faults BEFORE the first row
    // delete and is rerunnable — nothing may be missing afterwards.
    await expect(cascadeDeleteOrg(orgA, PERFORMED_BY, PERFORMED_EMAIL)).rejects.toThrow(/rerunnable/i);
    expect(await rowCount(db, 'org_documents', orgA)).toBe(1);
    expect(await rowCount(db, 'sites', orgA)).toBe(2);
    expect(await rowCount(db, 'tickets', orgA)).toBe(1);

    // Operator clears the object out of band (or it was a db-backed row all
    // along); the same erasure now runs to completion — proving the pre-clear is
    // a gate, not a one-way failure.
    await db.execute(sql`
      UPDATE org_documents SET storage_backend = 'db', storage_key = NULL, data = '\\x00'::bytea
      WHERE id = ${docId}
    `);
    const stats = await cascadeDeleteOrg(orgA, PERFORMED_BY, PERFORMED_EMAIL);
    expect(await rowCount(db, 'org_documents', orgA)).toBe(0);
    expect(stats.tablesDeleted['org_documents']).toBe(1);
  });
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`
Expected: FAIL before Task 6 lands (the erasure succeeds, ignoring the document's object). With Tasks 4 and 6 in place it PASSES. Run it both ways if you are executing tasks out of order — a test that has never been red proves nothing.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
git commit -m "test(tenancy): erasure round-trip proves object-before-row for an S3-backed org document (W03)"
```

---

### Task 13: Web API client and i18n

**Files:**
- Create: `apps/web/src/lib/api/orgDocuments.ts`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/organizations.json`
- Modify: `apps/web/src/locales/*/deliverables.json` (W01's namespace)

**Interfaces:**
- Consumes: `type Fetcher` from `apps/web/src/lib/api/serviceDeliverables.ts` (W01 Task 12), `ActionError` from `apps/web/src/lib/runAction.ts`.
- Produces:

```ts
export interface OrgDocument {
  id: string; orgId: string; title: string; description: string | null;
  category: 'baseline' | 'runbook' | 'policy' | 'evidence' | 'report' | 'export' | 'other';
  contentType: string; byteSize: number; sha256: string; originalFilename: string;
  uploadedByUserId: string | null; portalVisible: boolean;
  supersedesDocumentId: string | null; supersededByDocumentId: string | null; createdAt: string;
}
export function listOrgDocuments(f: Fetcher, orgId: string, q?: { category?: string; includeSuperseded?: boolean }): Promise<OrgDocument[]>;
export function uploadOrgDocument(f: Fetcher, orgId: string, form: FormData): Promise<Response>;
export function replaceOrgDocument(f: Fetcher, orgId: string, id: string, form: FormData): Promise<Response>;
export function updateOrgDocument(f: Fetcher, orgId: string, id: string, body: { title?: string; description?: string | null; category?: string; portalVisible?: boolean }): Promise<Response>;
export function deleteOrgDocument(f: Fetcher, orgId: string, id: string): Promise<Response>;
export function orgDocumentContentPath(orgId: string, id: string): string;   // `/orgs/${orgId}/documents/${id}/content`
```

Mutation wrappers return the raw `Response` so the component owns the `runAction` call (the `contractDocuments.ts` idiom, `apps/web/src/lib/api/contractDocuments.ts:47`). `listOrgDocuments` parses and throws `ActionError` on `!res.ok`.

- [ ] **Step 1: Write the client**

FormData bodies must NOT set `Content-Type` — the browser supplies the multipart boundary (see `apps/web/src/components/tickets/TicketWorkbench.tsx:834-843`).

- [ ] **Step 2: Add the English keys**

`organizations.json` gains `orgRecord.tabs.documents` and an `orgRecord.documents.*` block: `title`, `empty`, `upload`, `replace`, `download`, `delete`, `deleteConfirm`, `edit`, `save`, `cancel`, `form.title`, `form.description`, `form.category`, `form.portalVisible`, `form.file`, `filter.all`, `category.baseline|runbook|policy|evidence|report|export|other`, `column.title|category|size|uploaded|portal`, `badge.superseded`, `badge.portal`, `errors.tooLarge`, `errors.unsupportedType`, `errors.storageUnavailable`, `errors.notHead`, `toast.uploaded|replaced|updated|deleted`.

`deliverables.json` gains `drawer.uploadEvidence`, `drawer.uploadEvidenceHint`, `drawer.evidenceDocument`, `toast.evidenceUploaded`, `errors.uploadFailed`.

- [ ] **Step 3: Translate into the seven other locales**

Real translations, not English copies — `translationCoverage.test.ts` caps exact-English duplicates per namespace. Keep product nouns (`Breeze`) untranslated and consult `apps/web/src/locales/TERMINOLOGY.md` for fixed terms.

- [ ] **Step 4: Run the i18n suites**

Run: `cd apps/web && npx vitest run src/lib/i18n`
Expected: PASS (key parity across all 8 locales + the duplicate cap).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api/orgDocuments.ts apps/web/src/locales
git commit -m "feat(web): org documents API client and i18n keys in all locales (W03)"
```

---

### Task 14: Org record Documents tab

**Files:**
- Create: `apps/web/src/components/organizations/record/OrgDocumentsTab.tsx`, `OrgDocumentsTab.test.tsx`
- Modify: `apps/web/src/components/organizations/record/orgRecordTabs.ts:13-21` and `:48-60`
- Modify: `apps/web/src/components/organizations/record/orgRecordTabs.test.ts`
- Modify: `apps/web/src/components/organizations/record/OrganizationRecordPage.tsx:305` area

**Interfaces:**
- `OrgDocumentsTab({ orgId, orgFetch })` — category filter, upload form, table (title, category, size, uploaded, portal toggle), row actions Download / Replace / Edit / Delete. Every mutation via `runAction`.

- [ ] **Step 1: Write the failing registry test**

In `orgRecordTabs.test.ts`:

```ts
it('declares Documents after Service and before Activity', () => {
  expect([...ORG_RECORD_TABS]).toEqual([
    'overview', 'contacts', 'sites', 'devices', 'tickets', 'billing', 'service', 'documents', 'activity',
  ]);
});

it('gates Documents on documents:read', () => {
  expect(TAB_PERMISSION.documents).toEqual([{ resource: 'documents', action: 'read' }]);
  expect(visibleTabs(grants(['documents', 'read']), 'native')).toContain('documents');
  expect(visibleTabs(grants(['organizations', 'read']), 'native')).not.toContain('documents');
});
```

- [ ] **Step 2: Write the failing component tests**

```ts
it('lists documents through orgFetch, not ambient fetchWithAuth', …);
it('filters by category', …);
it('uploading posts multipart and toasts on success', …);
it('replace posts to /replace and shows the 409 NOT_HEAD message from the response body, not a generic error', …);
it('toggling the portal switch PATCHes portalVisible', …);
it('delete asks for confirmation first', …);
```

- [ ] **Step 3: Run to watch them fail**

Run: `cd apps/web && npx vitest run src/components/organizations/record`
Expected: FAIL on the tab order, `TAB_PERMISSION.documents`, and the missing component module.

- [ ] **Step 4: Implement**

In `orgRecordTabs.ts` add `'documents'` to `ORG_RECORD_TABS` immediately after `'service'` (W01 inserts `'service'` after `'billing'`), and:

```ts
  // Documents is NOT part of SERVICE_MANAGEMENT_TABS: the library holds
  // runbooks, baselines and exports that stay relevant when a partner runs
  // ticketing in an external PSA, so `off` and `external` must not hide it.
  documents: [{ resource: 'documents', action: 'read' }],
```

In `OrganizationRecordPage.tsx`, beside the other tab renders:

```tsx
      {effectiveTab === 'documents' && <OrgDocumentsTab orgId={orgId} orgFetch={orgFetch} />}
```

Build the component with the repo's Tailwind conventions (`rounded-lg border bg-card`), `data-testid` on the root (`org-documents-tab`), the table (`org-documents-table`), the upload input (`org-document-file`) and every action button. Download fetches through `orgFetch(orgDocumentContentPath(orgId, id))`, turns the response into a blob URL and opens it, revoking after 60s — the pattern at `apps/web/src/components/tickets/TicketAttachments.tsx:101-117`. Never link the content path directly: it needs the auth header.

- [ ] **Step 5: Run**

Run: `cd apps/web && npx vitest run src/components/organizations/record src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n && pnpm --filter @breeze/web typecheck`
Expected: PASS. If `no-silent-mutations` flags the new handlers, wrap them in `runAction` — do not add them to `runActionAllowlist.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/organizations/record
git commit -m "feat(web): org record Documents tab (W03)"
```

---

### Task 15: File-upload evidence in the occurrence drawer

**Files:**
- Modify: `apps/web/src/components/deliverables/OccurrenceDrawer.tsx` (W01 Task 13)
- Modify: `apps/web/src/components/deliverables/OccurrenceDrawer.test.tsx`

**Interfaces:**
- Consumes: `Fetcher`, `listOccurrences`, `addEvidence` from `apps/web/src/lib/api/serviceDeliverables.ts`; the new `POST /orgs/:orgId/deliverables/occurrences/:oId/evidence/upload` from Task 10.

- [ ] **Step 1: Write the failing test**

```ts
it('uploads a file as evidence and refreshes the occurrence', async () => {
  render(<OccurrenceDrawer fetcher={fetcher} orgId="org1" deliverable={deliverable} onClose={vi.fn()} />);
  await userEvent.upload(await screen.findByTestId('occurrence-evidence-file'), new File(['%PDF-'], 'findings.pdf', { type: 'application/pdf' }));
  await userEvent.click(screen.getByTestId('occurrence-evidence-upload'));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
    '/orgs/org1/deliverables/occurrences/occ-1/evidence/upload',
    expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
  ));
});

it('surfaces a 415 from the upload as the translated unsupported-type message', async () => { /* … */ });
```

- [ ] **Step 2: Run to watch it fail**

Run: `cd apps/web && npx vitest run src/components/deliverables/OccurrenceDrawer.test.tsx`
Expected: FAIL — no `occurrence-evidence-file` element.

- [ ] **Step 3: Implement**

Add a third evidence option next to W01's "link report run" control: a file input plus an Upload button whose handler builds a `FormData` (`file`, optional `title`) and goes through `runAction` with `errorFallback: t('errors.uploadFailed')` and a `friendly` map for `FILE_TOO_LARGE` → `errors.tooLarge`, `UNSUPPORTED_DOCUMENT_TYPE` → `errors.unsupportedType`, `STORAGE_UNAVAILABLE` → `errors.storageUnavailable`. Document evidence chips render the document title and download through `orgDocumentContentPath`.

- [ ] **Step 4: Run**

Run: `cd apps/web && npx vitest run src/components/deliverables src/lib/__tests__/no-silent-mutations.test.ts && pnpm --filter @breeze/web typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/deliverables
git commit -m "feat(web): upload a file as occurrence evidence from the drawer (W03)"
```

---

### Task 16: MCP tools — `list_org_documents`, `manage_org_documents`

**Files:**
- Modify (or create): `apps/api/src/services/aiToolsDeliverables.ts`
- Create/modify: `apps/api/src/services/aiToolsDeliverables.test.ts`
- Modify: `apps/api/src/services/aiTools.ts:80` (import) and `:294` area (call)

**Interfaces:**
- Produces: `registerDeliverableTools(aiTools: Map<string, AiTool>): void`, registering `list_org_documents` and `manage_org_documents`.

> **If W02 has already created `aiToolsDeliverables.ts`, add to it.** If not, create it with exactly the `aiToolsContracts.ts` shape: a single exported `registerDeliverableTools`, `actorFromAuth(auth): DeliverableActor`, a `serviceErrorToJson(err)` that unwraps `DeliverableServiceError` including `details`, `MANAGE_*_REQUIRED` presence checks before any `String(...)` coercion, and `missingParamsJson` / `zodErrorToJson` from `./aiToolValidation`. Then add `import { registerDeliverableTools } from './aiToolsDeliverables';` beside line 80 and `registerDeliverableTools(aiTools);` beside line 294 of `aiTools.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
it('list_org_documents returns heads only and reports the count', async () => { /* … */ });
it('manage_org_documents has NO byte-upload action', () => {
  const tool = tools.get('manage_org_documents')!;
  const actions = (tool.definition.input_schema.properties.action as { enum: string[] }).enum;
  expect(actions).toEqual(['update_metadata', 'set_portal_visibility', 'supersede']);
  expect(JSON.stringify(tool.definition)).not.toMatch(/base64|upload|file/i);
});
it('manage_org_documents rejects a missing documentId before coercing it to the string "undefined"', async () => { /* … */ });
it('a document of another org answers a 404 JSON error, never a throw', async () => { /* … */ });
```

- [ ] **Step 2: Run to watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiToolsDeliverables.test.ts`
Expected: FAIL — the tools are not registered.

- [ ] **Step 3: Implement**

```ts
const MANAGE_ORG_DOCUMENTS_REQUIRED: Record<string, readonly string[]> = {
  update_metadata: ['documentId', 'patch'],
  set_portal_visibility: ['documentId', 'portalVisible'],
  supersede: ['documentId', 'supersedesDocumentId'],
};

aiTools.set('list_org_documents', {
  tier: 2 as AiToolTier,
  deviceArgs: [],
  definition: {
    name: 'list_org_documents',
    description:
      'List the current version of every document in an organization\'s library (runbooks, baselines, policies, exports, delivery evidence). '
      + 'Returns metadata only — titles, categories, sizes and portal visibility — never the file bytes. Read-only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        orgId: { type: 'string', description: 'Organization id (UUID)' },
        category: { type: 'string', enum: ['baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other'] },
        includeSuperseded: { type: 'boolean', description: 'Include older versions (default false)' },
      },
      required: ['orgId'],
    },
  },
  handler: async (input, auth) => {
    try {
      const rows = await listDocuments(String(input.orgId), {
        category: input.category ? (String(input.category) as OrgDocumentCategory) : undefined,
        includeSuperseded: input.includeSuperseded === true,
      }, actorFromAuth(auth));
      return JSON.stringify({ documents: rows, showing: rows.length });
    } catch (err) {
      const json = serviceErrorToJson(err);
      if (json) return json;
      throw err;
    }
  },
});
```

`manage_org_documents` dispatches to `updateDocument` (validated by `updateDocumentSchema` wrapped as `z.object({ patch: updateDocumentSchema })` so ZodError paths read `patch.title: …`), `updateDocument` with just `{ portalVisible }`, and `supersedeDocument`. It is **not** approval-gated (spec §10: only `apply_template` is). Byte upload stays out of MCP by design (spec §3 "Out (v1)").

- [ ] **Step 4: Run**

Run: `cd apps/api && npx vitest run src/services/aiToolsDeliverables.test.ts src/routes/mcpServer.test.ts && npx tsc --noEmit -p tsconfig.json` → PASS. `mcpServer.test.ts` pins the tool inventory; if it fails on a count, update that expectation deliberately.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsDeliverables.ts apps/api/src/services/aiToolsDeliverables.test.ts apps/api/src/services/aiTools.ts
git commit -m "feat(ai): list_org_documents and manage_org_documents MCP tools (W03)"
```

---

### Task 17: Wave verification and PR

- [ ] **Step 1: Full API unit run**

Run: `cd apps/api && npx vitest run`
Expected: green. Pay attention to the five files Task 5 must not have needed to change.

- [ ] **Step 2: Shared and web**

Run: `cd packages/shared && npx vitest run` → green.
Run: `cd apps/web && npx vitest run && pnpm --filter @breeze/web typecheck` → green.

- [ ] **Step 3: Integration contract suites**

Run (test-stack up):
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgDocumentsRls.integration.test.ts \
  src/__tests__/integration/serviceDeliverablesRls.integration.test.ts \
  src/__tests__/integration/ticketAttachmentsRls.integration.test.ts
```
Expected: all green, and each file reports a non-zero test count.

- [ ] **Step 4: Lint and migration guards**

Run: `pnpm lint` at the repo root → clean.
Run: `scripts/check-migration-naming.sh --against-ref origin/main` → PASS. If `origin/main` gained a migration that sorts after `-170400-` while this branch was open, rename both files upward and sweep every reference (this plan, and any integration suite that replays a migration by path).

- [ ] **Step 5: Manual smoke on a worktree stack**

Run: `pnpm wt-stack up`, then in the browser: open an org record → Documents tab → upload a PDF → toggle Portal → Replace it with a second PDF (the first shows as superseded, a second replace of the first is refused with the `NOT_HEAD` message) → Download → Delete. Then open a deliverable's occurrence drawer and upload a file as evidence; confirm the document appears in the library with category `evidence`.

- [ ] **Step 6: Tear down**

Run: `pnpm test-stack down && pnpm wt-stack down`. Confirm nothing is left: `docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'`.

- [ ] **Step 7: Open the PR**

Body carries `Closes #<W03 sub-issue>`, a link to the spec, and a **Tenancy** section listing: the shape-1 RLS policies, the three registrations (cascade / export policy / merge), the widened erasure pre-clear, and the integration suites that prove them. Call out the three deliberate changes to existing tests (two assertions in `tenantCascade.test.ts`, the W01 validator negative case, the W01 deliver-route 400 case) so a reviewer does not read them as collateral damage. Run `/pr-review-toolkit:review-pr`; act on confirmed findings only. Enqueue with `gh pr merge <N>` on green — never `--admin`.

---

## Self-review

**Spec coverage for this wave.** §4.4 `org_documents` → Tasks 1, 3. The `document` arm of §4.3 (FK + evidence kind) → Tasks 1, 8. §4.9 registrations incl. the S3 erasure pre-clear → Tasks 4, 6, 12. §7 upload-on-deliver with `category='evidence'` and inherited `portal_visible` → Task 10. §9 org-record Documents tab → Task 14; drawer evidence upload → Task 15. §10 `documents` permission resource → Task 2; REST → Task 9; `list_org_documents` / `manage_org_documents` → Task 16. §12 upload errors 413 / 415 / 503 / 409 `NOT_HEAD` / 404-not-403 → Tasks 7, 9. §13 unit + route + `orgDocumentsRls` + the standing suites incl. `tenantExportErasureRoundtrip` with an S3-backed document → Tasks 5, 7, 9, 11, 12, 17. Portal `/documents` (§8) is W04 by design; template sets (§4.6) are W05.

**Placeholders.** None. Every step names files, exact line anchors that were read, and real code. The one conditional is Task 16's "if W02 already created `aiToolsDeliverables.ts`", which is a genuine wave-ordering fork with both arms spelled out.

**Type consistency.** `DeliverableActor`, `DeliverableServiceError`, `EvidenceRef`, `OccurrenceView`, `DeliverableSummary`, `addEvidence`, `deliverOccurrence`, `getDeliverable` and `Fetcher` are W01's names, spelled identically here. The review caught one gap and fixed it inline: Task 10 needed a single-occurrence getter that W01 does not export, so Task 8 now declares and implements `getOccurrenceOr404` rather than Task 10 inventing an undeclared name. New names — `BlobStorageError`, `BlobBackend`, `BlobBytesRow`, `putBlob`, `getBlobStream`, `deleteBlob`, `deleteBlobKeys`, `ORG_DOCUMENT_PREFIX`, `OrgDocumentView`, `OrgDocumentRow`, `ORG_DOCUMENT_META_COLUMNS`, `orgDocumentCategoryEnum`, `OrgDocumentCategory`, `UploadFile`, `orgDocumentRoutes`, `registerDeliverableTools` — are spelled identically in every task that mentions them. `AttachmentStorageError`, `AttachmentBackend`, `AttachmentBytesRow`, `putBytes`, `openBytes`, `deleteBytes`, `deleteObjectKeys`, `selectBackend`, `objectKeyFor` all survive Task 5's extraction under their original names, which is the only reason the five existing ticket test files need no edits.

**Known ordering hazards.**
- The static cascade list is alphabetised; the runtime delete order is topological. `org_documents` sits alphabetically ahead of `service_deliverable_evidence`, and that is correct — `topologicalCascadeOrder()` reads the FK edge and emits the child first. Do not "fix" the list to put it later; `tenantCascade.integration.test.ts`'s alphabetisation assertion would go red.
- Task 12's test only proves something if it is run against a tree WITHOUT Task 6. If tasks are executed out of order, go back and watch it fail.
