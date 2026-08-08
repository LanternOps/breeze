# Bulk Organization + Site Import — Design

**Date:** 2026-08-08
**Status:** Ready for review — all decisions settled (see §0)
**Issue:** #3242 (epic #3249)
**Related:** #3246 (PSA `getCompanies()` import) consumes the seam defined here

## Summary

Add bulk import of organizations and sites from a client-parsed CSV/JSON payload,
so an MSP migrating off Datto RMM / NinjaOne / ConnectWise Automate / Kaseya VSA /
N-central / Atera / Syncro can rebuild their tenancy tree in one pass instead of
one form at a time.

Introduces `organization_external_links` — a one-to-many external-system linkage
that makes re-import idempotent for **any** source, replacing the single-valued
`organizations.accounting_provider` / `accounting_external_id` pair that shipped
with the QuickBooks importer.

The import service is built as a shared **org import pipeline** (preview → commit)
with a source seam, so #3246 becomes a second source rather than a second importer.

## Context

- **The only working org importer** is QuickBooks:
  `apps/api/src/services/accounting/quickbooksCustomerImport.ts`, design at
  `docs/superpowers/specs/billing/2026-06-29-quickbooks-customer-import-design.md`.
  It already solves preview/annotate, slug collision, partial success, and the
  tenant-create RLS escape. This design generalises it rather than competing with it.
- **What it shipped** (`db/schema/orgs.ts:124-137`): `accounting_provider` +
  `accounting_external_id` on `organizations`, partial-unique on
  `(partner_id, accounting_provider, accounting_external_id)`. **Single-valued.**
- **Tenant-create RLS escape:** org/site inserts run inside
  `runOutsideDbContext(() => withSystemDbAccessContext(...))` (`orgs.ts:1037`,
  and `quickbooksCustomerImport.ts:192`).
- **`organizations.slug` is not DB-unique.** Only `(id, partner_id)` is unique —
  which is what makes the composite FK in §1 possible.
- **No CSV parser exists anywhere in the repo.** Every `parseCsv*` hit is an env-var
  splitter. CSV is currently export-only.
- **Write routes** `POST /orgs/organizations` (`orgs.ts:1267`) and `POST /orgs/sites`
  (`orgs.ts:1832`) are `requireScope('partner'|'system')` + `requireMfa()`-gated.
  Import inherits both. Unattended use is blocked until #3243 lands; that is
  deliberate and out of scope here.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| v1 scope | **Orgs + sites only** | Matches what every vendor export produces. Contacts are JSONB blobs, not a table; device custom fields need devices to exist first. |
| UI placement | **Settings utility under Organizations** | Reusable for every future onboarding batch, not just first run. Mirrors where `QuickbooksCustomerImport.tsx` lives. |
| CSV parsing | **Client-side; server takes JSON** | Keeps the API a clean JSON contract the migration toolkit scripts can call, keeps column-mapping UX in the UI, and avoids adding a parser + multipart to the API surface. |
| External linkage | **New `organization_external_links` table** | See §0 — the one open call. |
| Dedupe key | **`externalId` preferred; normalised-name fallback, flagged in preview** | Vendor exports all carry a stable UID; name matching is only safe with a human in the loop. |
| Re-import behaviour | **Skip by default; explicit per-row `update` opt-in** | Silent overwrite of edited customer records is worse than a no-op. |
| Preview statefulness | **Stateless** | The unique index is the real idempotency guard, so preview can be advisory. No import-batch table in v1. |

## 0. Decision — linkage model

**Settled: a one-to-many link table (option B).** Decided without an independent
advisor leg (Codex auth unavailable and the review was skipped by choice). There was
no live disagreement to resolve, so what is missing is a second check rather than a
tiebreak — but this is the highest-consequence call in the document, so it is the one
to re-examine first if the design ever feels wrong.

- **A — generalise the shipped columns** (`accounting_*` → `source_*`). Keeps a
  one-external-link-per-org ceiling.
- **B — `organization_external_links`.** One-to-many. Costs a new table plus its
  RLS/cascade/export contracts.

**Why B.**

*A is not actually the cheap option.* Renaming shipped columns still requires a
migration, a repo-wide sweep of readers, and an update to the `organizations` entry
in `CORE_TENANT_EXPORT_POLICY` — because removing or renaming a column on a
registered table breaks the export-policy test exactly as adding one does. A pays
most of B's cost and still buys a ceiling.

*The ceiling breaks realistically, not theoretically.* A migrating MSP legitimately
has one organization sourced from a *Datto CSV*, linked to *ConnectWise* for
ticketing, and linked to *QuickBooks* for billing, simultaneously. Under A the second
importer overwrites the first's link and the failure is **silent**: the first
importer's idempotency stops working and re-import begins creating duplicate
organizations. Silent duplicate-tenant creation is close to the worst available
failure mode in a multi-tenant system, and it would surface as a support ticket long
after the cause.

*This is the documented trap.* "Works now, retrofit later" on org-shaped data is what
CLAUDE.md calls out via #1724 and #2126–#2129. Choosing A here would be choosing it
with the counter-evidence already in hand.

**Reversal cost:** B is harder to undo once rows exist (a new table with four contract
registrations). That asymmetry is accepted deliberately — the failure mode A risks is
silent and data-corrupting, while B's cost is visible, upfront, and bounded.

## 1. Data Model

New table. Migration `apps/api/migrations/2026-08-08-organization-external-links.sql`
— hand-written, idempotent, no inner `BEGIN`/`COMMIT`, policies in the same file.

```sql
CREATE TABLE IF NOT EXISTS organization_external_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  partner_id   uuid NOT NULL,
  system       text NOT NULL,   -- 'quickbooks' | 'connectwise' | 'datto_rmm' | 'csv' | ...
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

Two deliberate choices:

- **`partner_id` is denormalised and held honest by a composite FK.** Uniqueness must
  be scoped per partner (two MSPs can both import a Datto site UID `12345`), which
  needs `partner_id` on the row. The composite FK to `organizations (id, partner_id)`
  makes a mismatched pair unrepresentable.

  This is not novel: the identical FK already ships as
  `deployment_invites_org_partner_fk` in
  `apps/api/migrations/2026-05-03-tenant-rls-force-and-invites.sql:10-21`, against the
  non-partial unique index `organizations_id_partner_id_unique` created in the same
  migration (lines 7-8, mirrored at `db/schema/orgs.ts:134`). `organizations.partner_id`
  is `NOT NULL` (`orgs.ts:104`) and both link columns are NOT NULL, so MATCH SIMPLE
  never softens the check and drift is genuinely unrepresentable.
- **No `json`/`jsonb`/`bytea` column.** Any open container must be classified
  `excludedOpen` and would therefore be dropped from tenant export. `label` is plain
  text so the whole row survives an export. Do not add a `metadata` jsonb later
  without accepting that cost.

### Contract registration — all four, same PR

| Contract | Action | Enforced by |
|---|---|---|
| RLS | Shape **1** (direct `org_id`) → policy `breeze_has_org_access(org_id)`, enabled + forced, in the same migration. Auto-discovery keys purely on the presence of an `org_id` column, so the `partner_id` column does not reclassify it and **no allowlist entry is needed**. | `rls-coverage.integration.test.ts` |
| Org cascade | Add `'organization_external_links'` to `CORE_ORG_CASCADE_DELETE_ORDER` in `services/tenantCascade.ts`, alphabetically (before `'organizations'`, which stays last). | `tenantCascade.integration.test.ts` |
| Export policy | Add to `CORE_TENANT_EXPORT_POLICY` in `services/tenantExportPolicyRegistry.ts` as `tablePolicy("org_id", { included: ["id","org_id","partner_id","system","external_id","label","created_by","created_at","updated_at"], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] })`. No column name matches `SUSPICIOUS_NAME_PARTS`. | `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts` |
| Device cascade | **N/A** — no `device_id` column. | — |
| Append-only | **N/A** — rows are mutable and deletable. | — |

Two clarifications, because it is easy to reason about these wrongly:

- **Alphabetical order is a lint, not the delete order.** `tenantCascade.ts:14-17` is
  explicit that the hand-maintained list is *not* trusted as a topological order —
  at delete time it queries `pg_constraint` and topologically sorts children-first.
  So list position does not "satisfy" the FK direction; the computed order does, and
  the FK here additionally carries `ON DELETE CASCADE`. Register alphabetically
  because the test asserts it, not because ordering is load-bearing.
- **Partner erasure needs no registration.** `cascadeDeletePartner`
  (`tenantCascade.ts:744, 847-862`) sweeps `information_schema` dynamically for every
  table with a `partner_id` column, so the new table is picked up automatically.

Both the cascade and export-policy suites need a live database and therefore
**cannot fail in the `Test API` unit job**. Run them locally before opening the PR,
and dispatch CI on the branch (`gh workflow run CI --ref <branch>`).

**Policy-shape note.** The two existing tables with this composite FK — `users` and
`deployment_invites` — both carry *dual-axis* policies, and `deployment_invites` is
registered in `DUAL_AXIS_TENANT_TABLES`. This table deliberately does not: all import
writes run in system context, and partner-scoped readers already satisfy
`breeze_has_org_access` for their accessible orgs, so an org-axis policy is sufficient
and strictly tighter. Called out because it diverges from every prior instance of the
pattern — if a future reader needs partner-wide visibility of links for orgs the caller
cannot otherwise reach, revisit this rather than widening the policy ad hoc.

### Backfill and deprecation

Same migration, backfilling the shipped QuickBooks links with a reported row count:

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

`accounting_provider` / `accounting_external_id` stay in place and keep working.

### The QuickBooks importer must DUAL-WRITE in this PR

**This is the single most important implementation note in the document.** An earlier
draft said only that `quickbooksCustomerImport.ts` switches its `loadExistingOrgs`
*read* to the link table, deferring the writer to a later phase. That is a bug, and
precisely the one §0 exists to prevent.

`quickbooksCustomerImport.ts:213-214` writes `accountingProvider` /
`accountingExternalId` on org insert and nothing else. If the reader moves to the link
table while the writer does not, then:

1. The migration backfills links for orgs that exist **today**.
2. Every org QuickBooks creates **after** this PR gets `accounting_*` set and **no
   link row**.
3. The next QuickBooks import reads the link table, does not find that org, and
   **creates a duplicate organization**.

Silent duplicate-tenant creation — exactly the failure mode §0 rejects option A for.

Therefore, in this PR:

- The QuickBooks importer **writes both** the link row and the `accounting_*` columns
  on every create, for as long as the columns exist.
- Its `loadExistingOrgs` reads the **union** of the link table and the legacy columns,
  so an org linked by either mechanism matches.
- Only once the importer is migrated onto the shared seam (Phase 2) and every writer
  is confirmed does the drop become safe.

Sweep for other writers before calling this done — `grep -rn "accountingExternalId\|accounting_external_id" apps/api/src`. This is CLAUDE.md's Partner-Wide playbook step 7 ("sweep ALL call sites repo-wide") applied to a different contract; the mechanical registry checks do not catch a missing second writer.

The columns and their partial unique index are dropped in a **later contract-phase
migration** (pattern: #3151 `patch_policies.sources`). That drop must also update the
`organizations` entry in `CORE_TENANT_EXPORT_POLICY`, since removing a column from a
registered table breaks the export-policy test just as adding one does.

### Soft-deleted organizations hold the unique slot

`organizations` has a soft delete (`deletedAt`, `orgs.ts:132`) and product-level org
deletion is usually soft, not a hard cascade. A soft-deleted org's link rows survive
and keep `(partner_id, system, external_id)` occupied, so re-importing an offboarded
customer either silently matches the dead org or fails the unique insert.

Resolution: preview annotates such rows as a distinct **`matched-soft-deleted`** state
rather than `link-match`, and commit refuses them unless the caller explicitly chooses
to reactivate the existing org. Never silently attach new sites to a soft-deleted
tenant, and never silently mint a duplicate alongside it.

## 2. Routes

Both under `orgRoutes`, matching the gating on the write routes they compose —
`requireScope('partner','system')` + `requireOrgWrite` + `requireMfa()`.

- `POST /orgs/import/preview` — body `{ rows: ImportRow[] }` (max 1000).
  Returns each row annotated `create | link-match | name-match | conflict`, plus the
  resolved slug and the existing `organizationId` where matched. No writes.
- `POST /orgs/import` — body `{ rows: ImportRow[], mode?: 'skip' | 'update' }`.
  Returns `{ imported, updated, skipped, errors }` with per-row detail.

```ts
interface ImportRow {
  organization: string;
  site?: string;              // repeat `organization` across rows for multiple sites
  externalId?: string;        // the source vendor's stable UID
  externalSystem?: string;    // 'datto_rmm' | 'ninjaone' | ... ; defaults to 'csv'
  timezone?: string;          // IANA, validated by isValidIanaTimezone
  address?: unknown;
  contact?: { name?: string; email?: string; phone?: string };
}
```

`name-match` rows are **never committed as matches without an explicit client
acknowledgement** — commit re-derives the annotation and rejects a row whose
annotation changed since preview. Preview is advisory; the unique index is authority.

Failures are per-row: one bad timezone on row 43 must not roll back rows 1–42.
Responses are consumed from web through `runAction`.

## 3. Import Service — the shared seam

New `apps/api/src/services/orgImport/`, with the source seam that #3246 plugs into:

```ts
interface OrgImportSource {
  system: string;                              // value written to external_links.system
  list(ctx: OrgImportContext): Promise<ImportRow[]>;
}

previewOrgImport(rows, partnerId): Promise<AnnotatedRow[]>
commitOrgImport(rows, partnerId, actor, mode): Promise<OrgImportSummary>
```

- **CSV source** is a pass-through of client-parsed rows.
- **PSA source (#3246)** wraps the existing, currently-uncalled
  `getCompanies()` (`services/psa/types.ts:62`).
- **QuickBooks** migrates onto this seam once the link table lands.

Commit, per row group (one organization + its sites):

1. Resolve against `organization_external_links` by `(partner_id, system, external_id)`,
   else by normalised name within the partner.
2. Matched + `mode: 'skip'` → record skipped. Matched + `mode: 'update'` → patch only
   the fields present in the row.
3. Unmatched → create org (`slugify` + `generateUniqueSlug`, both already exported
   from `quickbooksCustomerImport.ts` and moved into a shared module), create sites,
   insert the link row — inside
   `runOutsideDbContext(() => withSystemDbAccessContext(...))`.
4. `writeRouteAudit` for every org-create, site-create and link-create.
5. On per-row failure, record and continue.

Creation must go through the same permission-checked path as the single-record routes,
not raw DB writes.

## 4. Web UI

A "Bulk import" utility on the Organizations settings area, reusing the layout of
`apps/web/src/components/integrations/QuickbooksCustomerImport.tsx`:

drag-and-drop CSV → client-side parse → column mapping → preview table with
per-row status badges (`New`, `Already linked`, `Name match — confirm`, `Conflict`)
→ Import. Name-match rows are unchecked by default and must be ticked deliberately.
Result surfaces through `runAction` including partial success ("54 imported, 4 skipped,
2 failed").

The client-side parser is the one new dependency, and it lands in `apps/web` only.

## 5. Testing

- **Service**: externalId dedupe; name-match flagged not auto-applied; slug collision
  suffixing; multi-site grouping; `skip` vs `update`; partial success.
- **Routes**: scope + MFA gating; row cap; annotation-changed-since-preview rejection.
- **Migration/contracts**: cascade ordering (child before `organizations`), export-policy
  classification, RLS coverage. Forge a cross-partner insert as `breeze_app` and confirm
  `new row violates row-level security policy`.
- **Composite FK**: attempt a link row whose `partner_id` disagrees with the org's —
  must fail, proving the denormalised column cannot drift.
- **Backfill**: existing QuickBooks-linked orgs appear exactly once in the link table
  and re-running the migration is a no-op.
- **Web**: preview rendering, name-match default-unchecked, `runAction` partial-success.

## Deferred — Later Phases

Nothing here is "won't do". Each item is sequenced behind something this phase
establishes, and each is listed so it does not get lost between PRs.

### Phase 2 — directly unblocked by this work

| Item | Depends on | Tracked by |
|---|---|---|
| **PSA-sourced org import** — wire `getCompanies()` as an `OrgImportSource`. Should be small once the seam exists. | The §3 seam | #3246 |
| **Migrate QuickBooks onto the shared seam** — `quickbooksCustomerImport.ts` keeps its provider client but delegates preview/commit to `orgImport/`. Removes the second, divergent importer. | Link table + seam | Follow-up to #3242 |
| **Unattended import** — the routes are `requireMfa()`-gated by inheritance, so scripted/scheduled import is impossible until a non-human principal can satisfy them. | Auth decision | #3243 |
| **Drop `accounting_provider` / `accounting_external_id`** and their partial unique index. Contract phase, after all readers move to the link table. Must also update the `organizations` entry in `CORE_TENANT_EXPORT_POLICY` — removing a column from a registered table breaks the export-policy test exactly as adding one does. | All readers migrated | Follow-up to #3242 |

### Phase 3 — the rest of the migration data model

| Item | Why it is not now | Tracked by |
|---|---|---|
| **Device custom-field backfill** — Datto `udf1`–`udf30`, Automate EDFs, Ninja/N-central custom properties, joined to devices on hostname. This is the largest remaining chunk of real customer data that a migration currently loses. | Devices must be enrolled first, so it is inherently a second pass — it cannot share this import's transaction or UI flow. | #3257 |
| **Organization contacts as a first-class concept** — there is no `contacts` table; contacts are `billingContact` / `contact` JSONB blobs, and `aiToolsOrgs.ts:473` `add_contact` is unimplemented (returns guidance). Import cannot create what the model does not have. | Needs a data-model decision before any importer can target it. | #3258 |
| **Scheduled/background re-sync** from PSA or accounting — keep org lists in step after the initial import, rather than a one-shot. Note `POST /psa/connections/:id/sync` is currently a stub with no worker. | Needs #3246 plus a worker, and an update-conflict policy stronger than v1's per-row opt-in. | #3246 |
| **Import-batch persistence** — a stored batch with TTL, giving resumable large imports and per-batch rollback. | Only worth it above roughly a thousand rows; v1's stateless preview plus the DB unique index covers the real cases. | Not filed — revisit if row caps bite |

### Explicitly not planned

- **Device import by upload.** Devices arrive by enrollment. A CSV of hostnames
  creates rows nothing will ever attach to.
- **Two-way push** (Breeze org → PSA/accounting company). Separate seam, separate
  consent model.
