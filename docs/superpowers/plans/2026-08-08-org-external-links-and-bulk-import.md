# Organization External Links + Bulk Org/Site Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP migrating off another RMM rebuild their whole tenancy tree in one pass, and make re-import idempotent for every import source — CSV today, PSA and accounting next.

**Architecture:** New `organization_external_links` table (one-to-many, replacing the single-valued `organizations.accounting_*` pair), plus a shared `orgImport` preview→commit service with a source seam. CSV is parsed client-side; the API takes JSON only.

**Tech Stack:** PostgreSQL + hand-written SQL migration, Drizzle ORM, Hono routes, Zod, React (web), Vitest.

**Spec:** `docs/superpowers/specs/onboarding-signup/2026-08-08-bulk-org-site-import-design.md`
**Issue:** #3242 · **Epic:** #3249 · **Unblocks:** #3246

> **✅ SHIPPED** — merged to main as `1d1880817` (PR #3273): migration + RLS + cascade/export registrations, `orgImport` preview→commit service with the source seam, `POST /orgs/import{,/preview}`, QuickBooks dual-write + union read (Task 4), and the `BulkOrgImport` web UI. **Phase 2 (by design, not this PR):** the PSA-backed source (#3246) plugs into the `OrgImportSource` seam, and moving QuickBooks fully onto the seam / dropping the legacy `accounting_*` columns is a later contract-phase PR. A live end-to-end CSV round-trip wasn't separately run; the service/route/integration suites cover idempotent re-import.

---

## Critical implementation note — read before starting

The QuickBooks importer currently writes `accountingProvider` / `accountingExternalId`
(`services/accounting/quickbooksCustomerImport.ts:213-214`) and nothing else.

**If the reader moves to the link table while that writer does not, every org QuickBooks creates after this PR gets no link row, the next QuickBooks import fails to match it, and it creates a duplicate organization** — the exact failure this table exists to prevent. Task 4 is therefore not optional and cannot be deferred.

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-08-08-organization-external-links.sql` | Table, indexes, RLS policies, backfill |
| `apps/api/src/db/schema/orgExternalLinks.ts` | Drizzle schema |
| `apps/api/src/services/orgImport/index.ts` | `previewOrgImport` / `commitOrgImport` |
| `apps/api/src/services/orgImport/types.ts` | `ImportRow`, `AnnotatedRow`, `OrgImportSource` |
| `apps/api/src/services/orgImport/slug.ts` | `slugify` / `generateUniqueSlug` moved here |
| `apps/web/src/components/organizations/BulkOrgImport.tsx` | Upload → map → preview → commit |
| `apps/api/src/__tests__/integration/orgExternalLinksRls.integration.test.ts` | Forge tests |

### Modified files
| File | Change |
|---|---|
| `apps/api/src/routes/orgs.ts` | `POST /orgs/import/preview`, `POST /orgs/import` |
| `apps/api/src/services/tenantCascade.ts` | Register in `CORE_ORG_CASCADE_DELETE_ORDER` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Register in `CORE_TENANT_EXPORT_POLICY` |
| `apps/api/src/services/accounting/quickbooksCustomerImport.ts` | **Dual-write + union read** |
| `apps/api/src/db/schema/index.ts` | Export the new schema |

---

## Task 1: Migration + schema

- [x] Write `apps/api/migrations/2026-08-08-organization-external-links.sql`, idempotent, no inner `BEGIN`/`COMMIT`:
  ```sql
  CREATE TABLE IF NOT EXISTS organization_external_links (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL,
    partner_id   uuid NOT NULL,
    system       text NOT NULL,
    external_id  text NOT NULL,
    label        text,
    created_by   uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT organization_external_links_org_partner_fk
      FOREIGN KEY (org_id, partner_id)
      REFERENCES organizations (id, partner_id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS organization_external_links_uniq
    ON organization_external_links (partner_id, system, external_id);
  CREATE INDEX IF NOT EXISTS organization_external_links_org_idx
    ON organization_external_links (org_id);
  ```
  Prior art for the composite FK: `deployment_invites_org_partner_fk` in `apps/api/migrations/2026-05-03-tenant-rls-force-and-invites.sql:10-21`.
- [x] Enable **and force** RLS; add the org-axis policy (`breeze_has_org_access(org_id)` plus the system branch), guarded by a `pg_policies` existence check.
- [x] Add **no** `json`/`jsonb`/`bytea` column — any open container is classified `excludedOpen` and would be dropped from tenant export.
- [x] Backfill from the shipped columns, reporting the row count:
  ```sql
  DO $$
  DECLARE n integer;
  BEGIN
    INSERT INTO organization_external_links (org_id, partner_id, system, external_id)
    SELECT id, partner_id, accounting_provider, accounting_external_id
    FROM organizations
    WHERE accounting_external_id IS NOT NULL AND accounting_provider IS NOT NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'backfilled % accounting external links', n;
  END $$;
  ```
- [x] Add the Drizzle schema and export it.
- [x] `pnpm db:migrate && pnpm db:check-drift` — no drift.

## Task 2: Register the contracts (do not defer to a follow-up PR)

- [x] `CORE_ORG_CASCADE_DELETE_ORDER` in `services/tenantCascade.ts` — insert `'organization_external_links'` alphabetically (before `'organizations'`, which stays last). Note the list is a lint, not the delete order: `tenantCascade.ts:14-17` computes children-first topologically from `pg_constraint` at delete time.
- [x] `CORE_TENANT_EXPORT_POLICY` in `services/tenantExportPolicyRegistry.ts`:
  ```ts
  "organization_external_links": tablePolicy("org_id", {
    included: ["id","org_id","partner_id","system","external_id","label","created_by","created_at","updated_at"],
    reviewedIncluded: [], excludedSensitive: [], excludedOpen: []
  }),
  ```
- [x] No device-cascade entry (no `device_id`), no `AUDIT_ADMIN_REQUIRED_TABLES` entry (rows are mutable), no `PARTNER_TENANT_TABLES` / `DUAL_AXIS_TENANT_TABLES` entry (RLS auto-discovery keys on the `org_id` column; the extra `partner_id` column does not reclassify it).
- [x] Partner erasure needs no registration — `cascadeDeletePartner` (`tenantCascade.ts:744, 847-862`) sweeps `information_schema` for `partner_id` columns dynamically.

## Task 3: RLS + contract verification

- [x] Run the contract suites against a live DB: `rls-coverage`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`. None of these fail in the `Test API` unit job.
- [x] As `breeze_app` (`docker exec -it breeze-postgres psql -U breeze_app -d breeze`), forge a cross-tenant insert — must fail with `new row violates row-level security policy`.
- [x] Add `orgExternalLinksRls.integration.test.ts`: cross-partner forge → 42501; composite-FK violation (link row whose `partner_id` disagrees with the org's) → rejected; org isolation on read.
- [x] Dispatch CI on the branch: `gh workflow run CI --ref <branch>`.

## Task 4: QuickBooks dual-write + union read — REQUIRED IN THIS PR

- [x] In `quickbooksCustomerImport.ts`, on org create, insert the link row **in addition to** the existing `accountingProvider` / `accountingExternalId` columns, inside the same `runOutsideDbContext(() => withSystemDbAccessContext(...))` block.
- [x] Change `loadExistingOrgs` to build `byExternalId` from the **union** of the link table and the legacy columns, so an org linked by either mechanism matches.
- [x] Sweep for other writers before calling this done:
  `grep -rn "accountingExternalId\|accounting_external_id" apps/api/src`
- [x] Test: an org created by the QuickBooks importer after this change has both a link row and the legacy columns, and a second import of the same customer is a **skip**, not a duplicate.

## Task 5: Import service (`services/orgImport/`)

- [x] Move `slugify` / `generateUniqueSlug` out of `quickbooksCustomerImport.ts` into `orgImport/slug.ts`; re-export from the old location for back-compat.
- [x] Define the source seam:
  ```ts
  interface OrgImportSource { system: string; list(ctx): Promise<ImportRow[]>; }
  ```
- [x] `previewOrgImport(rows, partnerId)` annotating each row `create` | `link-match` | `name-match` | `matched-soft-deleted` | `conflict`, with resolved slug and existing `organizationId`.
- [x] `commitOrgImport(rows, partnerId, actor, mode)`:
  - resolve by `(partner_id, system, external_id)`, else normalised name within partner;
  - `mode: 'skip'` leaves matches untouched; `'update'` patches only fields present in the row;
  - create org + sites + link row inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`, following `orgs.ts:1037`;
  - `writeRouteAudit` for every org, site, and link created;
  - per-row failure recorded, remaining rows proceed.
- [x] **Soft-delete handling:** a match against an org with `deletedAt IS NOT NULL` annotates `matched-soft-deleted` and commit **refuses** it unless the caller explicitly opts to reactivate. Never silently attach sites to a dead tenant, never silently mint a duplicate beside it.
- [x] Multiple rows sharing an `organization` value create one org with many sites.

## Task 6: Routes

- [x] `POST /orgs/import/preview` and `POST /orgs/import` in `routes/orgs.ts`, gated `requireScope('partner','system')` + `requireOrgWrite` + `requireMfa()` — matching the write routes they compose.
- [x] Zod: max 1000 rows; `timezone` validated with the existing `isValidIanaTimezone`; `mode: 'skip' | 'update'`.
- [x] Commit **re-derives** each row's annotation and rejects any row whose annotation changed since preview (preview is advisory; the unique index is authority).
- [x] Return `{ imported, updated, skipped, errors }` with per-row detail.

## Task 7: Web UI

- [x] `BulkOrgImport.tsx` on the Organizations settings area, modelled on `components/integrations/QuickbooksCustomerImport.tsx`.
- [x] Client-side CSV parse (new dependency in `apps/web` only — the API never sees CSV), column mapping, preview table with per-row status badges.
- [x] `name-match` rows unchecked by default; `matched-soft-deleted` rows call out the reactivate choice explicitly.
- [x] Commit through `runAction` so partial success surfaces ("54 imported, 4 skipped, 2 failed").

## Task 8: Tests

- [x] Service: externalId dedupe; name-match flagged not auto-applied; slug collision suffixing; multi-site grouping; `skip` vs `update`; partial success; soft-deleted match refused.
- [x] Routes: scope + MFA gating; row cap; annotation-changed-since-preview rejection.
- [x] Backfill: existing QuickBooks-linked orgs appear exactly once; re-running the migration is a no-op.
- [x] Web: preview rendering, name-match default-unchecked, `runAction` partial-success.

---

## Verification

- [x] `pnpm --filter @breeze/api test` and `pnpm --filter @breeze/web test` green.
- [x] All four contract suites green against a live DB (Task 3).
- [ ] End-to-end: export a `organization,site` CSV per the migration docs, import it, confirm the tree matches and a second import of the same file is a full skip.

## Out of scope

- Device import, contacts, custom-field backfill (#3257, #3258).
- PSA source (#3246) — this plan only lands the seam it plugs into.
- Dropping the `accounting_*` columns — separate contract-phase PR once every writer is migrated.
