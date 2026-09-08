---
tracking_issue: LanternOps/breeze#4622
---
# Manual Asset Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan wave-by-wave. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a technician hand-enter a non-networked asset (spare laptop, desk phone, non-networked printer) as a first-class third class in the unified Devices list, with warranty lookup, report inclusion, and reversible linking to an agent device or a discovered asset.

**Architecture:** A new org-scoped `manual_assets` table (spec Decision 1 = option B) surfaced as a third arm of the unified list, alongside agent `devices` and `discovered_assets`. It deliberately carries **no** network identity columns — anything with an IP/hostname/URL is a `discovered_assets` row and belongs to **#5213**, not here. `device_warranty` gains an XOR subject (`device_id` XOR `manual_asset_id`) so the existing subject-agnostic provider layer can serve manual assets. The web list generalises its binary `agent | network` split into a three-way class dispatch rather than special-casing.

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM (types/queries only), Hono routes, Vitest (unit / RLS / integration configs), Astro + React islands, Playwright for E2E.

**Spec:** `docs/superpowers/specs/device-lifecycle/2026-09-07-manual-asset-entry-spec.md` (APPROVED 2026-09-07, all seven Open Decisions resolved). Read it alongside this plan — every design argument lives there and is not repeated here.

---

## Global Constraints

Copied verbatim from the spec and from `CLAUDE.md`. Every wave's requirements implicitly include this section.

- **Tenancy shape 1** — direct `org_id` column, policies reference `breeze_has_org_access(org_id)`. `org_id NOT NULL`; the CLAUDE.md-required justification is: *manual assets are customer inventory records, not config/policy; there is no coherent partner-wide manual asset, so the Partner-Wide First default does not apply.*
- **RLS is `ENABLE` + `FORCE` with all four DML policies in the same migration that creates the table.** Never deferred to a later file.
- **Every composite FK that references an `org_id` column must be `DEFERRABLE INITIALLY IMMEDIATE`** — org merge runs `SET CONSTRAINTS ALL DEFERRED`; a non-deferrable one aborts the merge with 23503. Enforced by `orgLifecycleFoundations.integration.test.ts` ("merge contract"), Integration Tests shard 2 only.
- **Migrations are idempotent** (`IF NOT EXISTS` / `DO $$ … EXCEPTION` / `pg_policies` existence checks), carry **no inner `BEGIN;`/`COMMIT;`** (autoMigrate wraps each file), and are **never edited once shipped** — fix forward.
- **Migration naming:** the runner applies files in `localeCompare` order and shipped names run *ahead of real time*. **Do not name a migration for today's date.** Slots are pinned per wave below; re-verify with `ls apps/api/migrations | grep -E '^2026' | sort | tail -3` before committing, and let the pre-push hook re-check against `origin/main`.
- **Any migration that writes rows must first `SELECT set_config('breeze.scope','system',true);`.** Neither migration in this plan writes rows, so neither needs it — but confirm `migrationRlsScope.test.ts` agrees rather than assuming, and **never add a file to that suite's frozen baseline**.
- **Permissions reuse existing names only:** `devices:read` (list/read), `devices:write` (create/edit/link/unlink), `devices:delete` (delete). No new permission. **No MFA step-up** — manual asset writes are ordinary inventory edits, matching device edit, not the discovery mutators.
- **`site_id` is NOT NULL** (Decision 3). Site-scoped technicians are constrained through `permissions.allowedSiteIds` exactly as the network arm does (`apps/api/src/routes/devices/network.ts:90-118`).
- **No jsonb/bytea column on `manual_assets`, ever** — `tags` is `text[]`. Any open container is forced into the `excludedOpen` export bucket and would silently vanish from a tenant export.
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`); `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` guards the adopted set. UI state lives in `window.location.hash`, never query params.
- **Manual assets are not billable** (Decision 2) — do not touch `billableDeviceConds` (`apps/api/src/services/contractQuantities.ts:9-19`).
- **No feature flag.** The Manual segment is independent of `PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST`.
- **Every wave PR targets `main`.** A stacked PR (base ≠ main) runs *no* CI at all — `ci.yml` triggers on `pull_request: branches: [main]` — and `gh pr checks` will read as green while nothing ran.
- **`pnpm test` does NOT run the RLS or integration contract suites.** Local green ≠ CI green. Waves touching tenancy must run `vitest.integration.config.ts` suites against a real database before opening the PR.
- **Red-first per wave.** Write the assertion, watch it fail, then implement. Test files sit alongside their source. Follow the `breeze-testing` skill for Drizzle mock patterns.

---

## Corrections to the spec (verified against the code on this branch)

The spec explicitly asked the plan to *check, not assume* on two registration lists. Both checks came back the opposite of the spec's guess, and one of them exposes a third issue the spec did not consider. **Implement what this section says, not the spec's registration table.**

**C1 — `manual_assets` does NOT go in `CORE_DEVICE_CASCADE_DELETE_TABLES`. It goes in `DEVICE_LINKED_DEVICE_ID_TABLES` (`apps/api/src/routes/devices/core.ts:94`).**
The coverage contract at `apps/api/src/routes/devices/cascadeDelete.test.ts:139` keys on a **`device_id`** column; `manual_assets` has none, so that assertion never sees the table. The one that does see it is `cascadeDelete.test.ts:193` — *"includes every table whose `linked_device_id` FK references `devices.id`"* — which fails for any schema table carrying a `linked_device_id` column that is absent from `DEVICE_LINKED_DEVICE_ID_TABLES`. `discovered_assets` is the precedent: it is in that list and nowhere else. Registration is all that is needed; `apps/api/src/services/deviceDeletion.ts:247-253` already loops the list generically and issues the `SET linked_device_id = NULL` update. No entry in `DEVICE_LINK_DEPENDENT_COLUMNS` (`core.ts:144`) — that registry exists for link-conditional CHECK constraints, and `manual_assets` deliberately declares none.

**C2 — `manual_assets` must NOT be added to `CORE_DEVICE_ORG_DENORMALIZED_TABLES`. Adding it fails CI.**
`apps/api/src/routes/devices/moveOrg.coverage.test.ts:148` (*"all listed tables are also device-managed (cascade-deleted or detached)"*) builds `managedSet` from `getDeviceCascadeDeleteTables() ∪ DEVICE_DETACH_DEVICE_ID_TABLES` **only** — the linked set is excluded. A `CORE_DEVICE_ORG_DENORMALIZED_TABLES` entry for a linked-only table is reported as an orphan and the test goes red in **Test API**. `discovered_assets` again is the precedent: it appears in `core.ts` exactly once, at line 96, and is absent from the denormalized list. The spec's claim that "`moveOrg.coverage.test.ts` will fail if it is omitted" is inverted — it fails if it is *included*.

**C3 — the consequence C2 exposes: the composite `(linked_device_id, org_id) → devices(id, org_id)` FK breaks `POST /devices/:id/move-org` with 23503.**
`discovered_assets.linked_device_id` is a **single-column** FK (`apps/api/src/db/schema/discovery.ts:150`), which is why a cross-org device move has never tripped over it — it silently leaves a stale cross-org link instead. The spec's composite form closes that hole but has nothing restamping or detaching the row, and `manual_assets` cannot join the generic restamp loop (it has no `device_id` column, and C2 forbids the list entry).

**Resolution: keep the composite FK and add an explicit detach**, mirroring the `device_group_memberships` cross-org detach precedent (#3182, `moveOrg.coverage.test.ts:1132-1205`). A manual asset is org-scoped inventory; once the device it points at leaves the org, the link is not merely stale but wrong, so nulling it is the honest outcome. Concretely, W01 adds one hand-written statement to `apps/api/src/routes/devices/moveOrg.ts` **before** the generic restamp loop, and mirrors it in `breeze_cascade_device_org_id()`:

```sql
UPDATE manual_assets SET linked_device_id = NULL WHERE linked_device_id = ${deviceId}::uuid
```

The alternative — a single-column FK matching `discovered_assets` — was rejected: it re-opens the cross-org-link hole the composite FK exists to close, and this table is new, so there is no shipped behaviour to preserve.

**C4 — the spec omits the `ON DELETE` action for `device_warranty.manual_asset_id`.** Use `ON DELETE CASCADE`, mirroring `device_warranty.device_id` (`apps/api/src/db/schema/warranty.ts:29`): a warranty row describes exactly one subject and has no meaning once that subject is gone.

**C5 — web file paths.** `mergedListFilter.ts`, `deviceClassFilter.ts`, `DeviceClassSegment.tsx`, `DeviceList.tsx` and `DevicesPage.tsx` all live in **`apps/web/src/components/devices/`**, not `apps/web/src/lib/`. Every line number the spec cites for those files was verified correct.

**C6 — migration slot.** The newest committed migration on this branch is `2026-10-13-110000-scripts-security-acknowledgement.sql` (the spec is right; a stale note elsewhere said `2026-10-13-100300-…`). Slots pinned below sort after it.

**Not a correction, but worth stating:** `discovered_assets_id_org_id_uniq` genuinely does not exist yet — the spec is correct that W01's migration must create it. `autoMigrate` wraps each file in a transaction, so `CONCURRENTLY` is impossible; this is a plain `CREATE UNIQUE INDEX IF NOT EXISTS` taking a brief `SHARE` lock on `discovered_assets`. Call it out in the PR body as a short write-stall on the discovery hot table during deploy.

---

## Wave graph

```
W01 (schema + migration + RLS + registrations)
      |
      +---------------------+
      |                     |
     W02 (API routes)      W03 (warranty XOR + report union)
      |                     |
      +---------- W04 (web + e2e + docs) --------+
```

W02 and W03 are independent of each other and can run in parallel once W01 has merged. They share exactly one file, `apps/api/src/services/tenantExportPolicyRegistry.ts` (W01 adds the `manual_assets` entry; W03 edits the `device_warranty` entry) — W03 must rebase on merged `main` after W01 lands, not branch off W01.

| Wave | Title | Model tier | Depends on |
|---|---|---|---|
| W01 | Table, migration, RLS, every registration list | **opus** | — |
| W02 | `routes/devices/manual.ts` CRUD + link/unlink | sonnet | W01 |
| W03 | Warranty XOR subject + report union | **opus** | W01 |
| W04 | Web third class, add/edit modal, E2E, docs | sonnet | W02 |

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-14-100000-manual-assets.sql` | enum, table, composite FKs, indexes, RLS enable+force+4 policies, `discovered_assets_id_org_id_uniq` |
| `apps/api/src/db/schema/manualAssets.ts` | Drizzle table + enum definition |
| `apps/api/src/__tests__/integration/manualAssetsRls.integration.test.ts` | cross-tenant forge (42501) + positive control |
| `apps/api/src/routes/devices/manual.ts` | the manual arm: list / create / update / delete / link / unlink |
| `apps/api/src/routes/devices/manual.test.ts` | route unit tests |
| `apps/api/migrations/2026-10-14-100100-device-warranty-manual-asset-subject.sql` | `device_warranty` XOR subject |
| `apps/api/src/services/warrantySync.manualAsset.test.ts` | subject-generalised sync tests |
| `apps/web/src/components/devices/ManualAssetModal.tsx` | add/edit modal |
| `apps/web/src/components/devices/ManualAssetModal.test.tsx` | modal tests |
| `e2e-tests/tests/manual-assets.spec.ts` | add → see → edit → delete |

**Modified**

| File | Change |
|---|---|
| `apps/api/src/db/schema/index.ts` | export the new table (the static contract tests enumerate `Object.values(schema)`) |
| `apps/api/src/db/schema/warranty.ts` | `manualAssetId`, `deviceId` nullable, two partial unique indexes |
| `apps/api/src/services/tenantCascade.ts:303-304` | insert `'manual_assets'` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | new `manual_assets` policy; edit the `device_warranty` policy (`:210`) |
| `apps/api/src/services/orgMergeRegistry.ts:645` | insert `'manual_assets'` into `REPOINT_TABLES` |
| `apps/api/src/routes/devices/core.ts:94` | add `'manual_assets'` to `DEVICE_LINKED_DEVICE_ID_TABLES` |
| `apps/api/src/routes/devices/moveOrg.ts` | detach `manual_assets.linked_device_id` (C3) |
| `apps/api/src/routes/devices/schemas.ts` | `listManualAssetsSchema`, `createManualAssetSchema`, `updateManualAssetSchema`, `linkManualAssetSchema` |
| `apps/api/src/routes/devices/index.ts` | mount `manualRoutes` before `coreRoutes` |
| `apps/api/src/services/warrantySync.ts` | extract `syncWarrantyForSubject`; extend `getDevicesNeedingWarrantySync` |
| `apps/api/src/services/reportGenerationService.ts` | second select over `manual_assets` in `generateDeviceInventoryReport` |
| `apps/web/src/components/devices/DeviceList.tsx` | `DeviceClass` union, per-class column availability, three-way sort, per-class bulk tally, manual row actions |
| `apps/web/src/components/devices/deviceClassFilter.ts` | `'manual'` in the union, `VALID`, `countDevicesByClass` |
| `apps/web/src/components/devices/DeviceClassSegment.tsx` | fourth chip |
| `apps/web/src/components/devices/mergedListFilter.ts` | class dispatch, `manualFieldValue`, `summarizeHiddenNonAgentDevices` |
| `apps/web/src/components/devices/DevicesPage.tsx` | third fetch arm, transform, split Add button, bulk allowlist |
| `apps/web/src/lib/devicesFetch.ts` | `fetchAllManualAssets` |
| `apps/web/src/locales/*/devices.json` (8 locales) | new keys — parity is enforced |
| `apps/docs/src/content/docs/features/devices.mdx` | asset classes + discovery-vs-inventory |

---

# Wave W01 — Table, migration, RLS, and every registration list

**Model tier: opus.** Migration + RLS + six registration surfaces; historically the highest-blast-radius wave in this repo and the one whose omissions ship as latent GDPR erasure bugs.

**Goal:** `manual_assets` exists with forced RLS, is registered in every cascade/export/merge list that applies, and every contract suite is green. No routes, no UI. Lands and ships on its own.

**Interfaces produced (later waves depend on these exact names):**
- Table `manual_assets`; enum `manual_asset_source` (`'manual' | 'import'`).
- Drizzle export `manualAssets` from `apps/api/src/db/schema/manualAssets.ts`, re-exported from `apps/api/src/db/schema/index.ts`. Column properties: `id, orgId, siteId, name, assetType, manufacturer, model, serialNumber, assetTag, location, assignedContactId, source, linkedDeviceId, linkedDiscoveredAssetId, notes, tags, retiredAt, createdBy, updatedBy, createdAt, updatedAt`.
- Unique index `discovered_assets_id_org_id_uniq` on `discovered_assets (id, org_id)`, available for any future composite FK.

### Task 1.1 — Pin the migration slot

- [ ] **Step 1: Read the current tail**

```bash
ls apps/api/migrations | grep -E '^2026' | sort | tail -3
```

Expected on this branch: the last line is `2026-10-13-110000-scripts-security-acknowledgement.sql`.

- [ ] **Step 2: Choose the slot**

Use `2026-10-14-100000-manual-assets.sql`. If the tail shows anything sorting after `2026-10-14-100000-`, pick the next `HHMMSS` past the newest file instead — **do not** name it for today's date, and **do not** reach for a `-a-`/`-b-` infix on a date that already has shipped files.

### Task 1.2 — Write the migration (red first: `autoMigrate.test.ts`)

**Files:** Create `apps/api/migrations/2026-10-14-100000-manual-assets.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Manual asset entry (#4622) — non-networked inventory records.
-- Anything with a network identity (IP/hostname/URL) is a discovered_assets
-- row and belongs to #5213; this table deliberately has no address columns.
-- Tenancy shape 1: direct org_id, breeze_has_org_access(org_id).
-- org_id NOT NULL justification: customer inventory data, not config/policy —
-- there is no coherent partner-wide manual asset.
-- Writes no rows, so no breeze.scope elevation is required.

DO $$ BEGIN
  CREATE TYPE manual_asset_source AS ENUM ('manual','import');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Referenced side for the composite link FK below. discovered_assets had no
-- (id, org_id) unique index; without it a cross-org link is representable.
CREATE UNIQUE INDEX IF NOT EXISTS discovered_assets_id_org_id_uniq
  ON public.discovered_assets (id, org_id);

CREATE TABLE IF NOT EXISTS manual_assets (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id                    uuid NOT NULL,
  name                       varchar(255) NOT NULL,
  asset_type                 discovered_asset_type NOT NULL DEFAULT 'unknown',
  manufacturer               varchar(255),
  model                      varchar(255),
  serial_number              varchar(255),
  asset_tag                  varchar(128),
  location                   varchar(255),
  assigned_contact_id        uuid,
  source                     manual_asset_source NOT NULL DEFAULT 'manual',
  linked_device_id           uuid,
  linked_discovered_asset_id uuid,
  notes                      text,
  tags                       text[] NOT NULL DEFAULT '{}',
  retired_at                 timestamptz,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Composite tenant FKs. Every one is DEFERRABLE INITIALLY IMMEDIATE: org merge
-- runs SET CONSTRAINTS ALL DEFERRED and re-points parent and child org_id in
-- separate statements; a non-deferrable constraint aborts the merge with 23503.
DO $$ BEGIN
  ALTER TABLE manual_assets
    ADD CONSTRAINT manual_assets_site_org_fk
    FOREIGN KEY (site_id, org_id) REFERENCES sites(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE manual_assets
    ADD CONSTRAINT manual_assets_linked_device_org_fk
    FOREIGN KEY (linked_device_id, org_id) REFERENCES devices(id, org_id)
    ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE manual_assets
    ADD CONSTRAINT manual_assets_linked_discovered_asset_org_fk
    FOREIGN KEY (linked_discovered_asset_id, org_id) REFERENCES discovered_assets(id, org_id)
    ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE manual_assets
    ADD CONSTRAINT manual_assets_assigned_contact_org_fk
    FOREIGN KEY (assigned_contact_id, org_id) REFERENCES contacts(id, org_id)
    ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS manual_assets_org_idx ON manual_assets(org_id);
CREATE INDEX IF NOT EXISTS manual_assets_org_site_idx ON manual_assets(org_id, site_id);
-- Duplicate-serial hint and the warranty sweep. NOT unique: serials are not
-- globally unique across manufacturers and a hard constraint would block
-- legitimate re-entry (spec, Data model).
CREATE INDEX IF NOT EXISTS manual_assets_org_serial_idx
  ON manual_assets(org_id, upper(serial_number)) WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS manual_assets_linked_device_idx
  ON manual_assets(linked_device_id) WHERE linked_device_id IS NOT NULL;

ALTER TABLE manual_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_assets FORCE ROW LEVEL SECURITY;

DO $$
DECLARE cmd text;
BEGIN
  FOREACH cmd IN ARRAY ARRAY['select','insert','update','delete'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'manual_assets'
        AND policyname = 'manual_assets_' || cmd
    ) THEN
      IF cmd = 'insert' THEN
        EXECUTE format(
          'CREATE POLICY manual_assets_%s ON manual_assets FOR %s '
          || 'WITH CHECK (breeze_current_scope() = ''system'' OR breeze_has_org_access(org_id))',
          cmd, cmd);
      ELSIF cmd = 'update' THEN
        EXECUTE format(
          'CREATE POLICY manual_assets_%s ON manual_assets FOR %s '
          || 'USING (breeze_current_scope() = ''system'' OR breeze_has_org_access(org_id)) '
          || 'WITH CHECK (breeze_current_scope() = ''system'' OR breeze_has_org_access(org_id))',
          cmd, cmd);
      ELSE
        EXECUTE format(
          'CREATE POLICY manual_assets_%s ON manual_assets FOR %s '
          || 'USING (breeze_current_scope() = ''system'' OR breeze_has_org_access(org_id))',
          cmd, cmd);
      END IF;
    END IF;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON manual_assets TO breeze_app;
```

- [ ] **Step 2: Apply it against a local database**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
```

Expected: applies cleanly. Run it a **second** time — expected: a no-op (this is the idempotency check the guard cannot make for you).

- [ ] **Step 3: Run the migration guards**

```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```

Expected: PASS. `migrationRlsScope.test.ts` must pass **without** adding this file to its frozen baseline. If it demands a `breeze.scope` elevation, the migration has grown a DML statement it should not have — remove the write, do not add the baseline entry.

### Task 1.3 — Drizzle schema

**Files:** Create `apps/api/src/db/schema/manualAssets.ts`; Modify `apps/api/src/db/schema/index.ts`

- [ ] **Step 1: Write the schema module**

```ts
import { pgTable, uuid, varchar, text, timestamp, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { discoveredAssetTypeEnum } from './discovery';

export const manualAssetSourceEnum = pgEnum('manual_asset_source', ['manual', 'import']);

// Manual asset entry (#4622). Non-networked inventory only — an asset with a
// network identity is a discovered_assets row (#5213). Tenancy shape 1.
export const manualAssets = pgTable('manual_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  siteId: uuid('site_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  assetType: discoveredAssetTypeEnum('asset_type').notNull().default('unknown'),
  manufacturer: varchar('manufacturer', { length: 255 }),
  model: varchar('model', { length: 255 }),
  serialNumber: varchar('serial_number', { length: 255 }),
  assetTag: varchar('asset_tag', { length: 128 }),
  location: varchar('location', { length: 255 }),
  assignedContactId: uuid('assigned_contact_id'),
  source: manualAssetSourceEnum('source').notNull().default('manual'),
  linkedDeviceId: uuid('linked_device_id'),
  linkedDiscoveredAssetId: uuid('linked_discovered_asset_id'),
  notes: text('notes'),
  tags: text('tags').array().notNull().default([]),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgIdx: index('manual_assets_org_idx').on(table.orgId),
  orgSiteIdx: index('manual_assets_org_site_idx').on(table.orgId, table.siteId),
}));
```

Composite FKs are declared in SQL only — Drizzle cannot express a multi-column FK on a table definition, and the static contract tests read column *names*, which are present. This matches the shape every other composite-tenant-FK table in the repo uses.

- [ ] **Step 2: Export it**

Add `export * from './manualAssets';` to `apps/api/src/db/schema/index.ts` in the file's existing alphabetical position. **This export is load-bearing:** `cascadeDelete.test.ts` and `moveOrg.coverage.test.ts` enumerate `Object.values(schema)`, so an unexported table is invisible to every static contract.

- [ ] **Step 3: Confirm no schema drift**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
```

Expected: no drift reported.

### Task 1.4 — Register in `DEVICE_LINKED_DEVICE_ID_TABLES` (red first)

**Files:** Modify `apps/api/src/routes/devices/core.ts:94`

- [ ] **Step 1: Watch the contract fail**

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts
```

Expected: FAIL on *"includes every table whose linked_device_id FK references devices.id"*, naming `manual_assets`. **This red is the proof C1 is right** — if it passes here, stop and re-derive before editing anything.

- [ ] **Step 2: Add the entry**

```ts
export const DEVICE_LINKED_DEVICE_ID_TABLES = [
  'network_change_events',
  'discovered_assets',
  // #4622 — a manual asset points at the device an agent was later installed
  // on. DETACHED, never deleted: the row is hand-entered inventory (serial,
  // asset tag, assigned contact, notes) that must outlive the device row.
  // No DEVICE_LINK_DEPENDENT_COLUMNS entry: manual_assets declares no
  // link-conditional CHECK constraint, so nothing else needs clearing.
  'manual_assets',
] as const;
```

- [ ] **Step 3: Re-run**

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
```

Expected: both PASS. `moveOrg.coverage.test.ts` must be green **without** a `CORE_DEVICE_ORG_DENORMALIZED_TABLES` entry (C2). If someone adds one, the *"all listed tables are also device-managed"* assertion goes red.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/devices/core.ts apps/api/src/db/schema apps/api/migrations
git commit -m "feat(devices): manual_assets table, RLS and device-link registration (#4622)"
```

### Task 1.5 — Detach `linked_device_id` on cross-org device move (C3)

**Files:** Modify `apps/api/src/routes/devices/moveOrg.ts`

- [ ] **Step 1: Write the failing assertion**

Add to `apps/api/src/routes/devices/moveOrg.coverage.test.ts`, in the style of the `device_group_memberships` block at `:1132-1205`:

```ts
describe('manual_assets cross-org detach coverage (#4622)', () => {
  it('moveOrg.ts nulls manual_assets.linked_device_id for the moved device', () => {
    const src = readFileSync(join(__dirname, 'moveOrg.ts'), 'utf8');
    expect(src).toMatch(
      /UPDATE manual_assets SET linked_device_id = NULL\s+WHERE linked_device_id = \$\{deviceId\}::uuid/,
    );
  });

  it('places the detach BEFORE the generic denormalized re-stamp loop', () => {
    const src = readFileSync(join(__dirname, 'moveOrg.ts'), 'utf8');
    expect(src.indexOf('UPDATE manual_assets SET linked_device_id = NULL'))
      .toBeLessThan(src.indexOf('getDeviceOrgDenormalizedTables()'));
  });

  it('is not registered as an org-denormalized table (it is link-only, not device-managed)', () => {
    expect(DEVICE_ORG_DENORMALIZED_TABLES).not.toContain('manual_assets');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```bash
cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts
```

Expected: the first two assertions FAIL (no such statement); the third PASSES.

- [ ] **Step 3: Add the detach**

In `moveOrg.ts`, immediately before the generic denormalized re-stamp loop, inside the same transaction:

```ts
// #4622 — a manual asset is org-scoped inventory bound to the device by the
// composite FK (linked_device_id, org_id) -> devices(id, org_id). Once the
// device leaves the org that link is not merely stale but unrepresentable,
// and the deferred constraint would abort the move with 23503. Null it.
// manual_assets has no device_id column, so the generic loop cannot reach it,
// and it is deliberately absent from DEVICE_ORG_DENORMALIZED_TABLES (a
// link-only table is not device-managed — moveOrg.coverage.test.ts:148).
await tx.execute(sql`UPDATE manual_assets SET linked_device_id = NULL WHERE linked_device_id = ${deviceId}::uuid`);
```

Mirror the same statement in `breeze_cascade_device_org_id()` if the move path for that device class routes through the SECURITY DEFINER function — grep the function body in `apps/api/migrations` and follow whichever precedent `device_group_memberships` set.

- [ ] **Step 4: Re-run — expect PASS**, then commit.

### Task 1.6 — The four org-lifecycle registration lists

**Files:** Modify `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/services/orgMergeRegistry.ts`

- [ ] **Step 1: `CORE_ORG_CASCADE_DELETE_ORDER`**

`apps/api/src/services/tenantCascade.ts`, between `'maintenance_windows'` (`:303`) and `'metric_anomalies'` (`:304`):

```ts
  'maintenance_windows',
  'manual_assets',
  'metric_anomalies',
```

Alphabetical by `localeCompare`; `organizations` stays last. FK direction is satisfied: `device_warranty` (`'d' < 'm'`) is deleted before `manual_assets`, and it is the referencing side once W03 lands. **No `AUDIT_ADMIN_REQUIRED_TABLES` entry** (`tenantCascade.ts:773`) — `manual_assets` is not append-only and has no immutability trigger.

- [ ] **Step 2: `CORE_TENANT_EXPORT_POLICY`**

`apps/api/src/services/tenantExportPolicyRegistry.ts`, in the existing key order:

```ts
  "manual_assets": tablePolicy("org_id", {"included":["id","org_id","site_id","name","asset_type","manufacturer","model","serial_number","asset_tag","location","assigned_contact_id","source","linked_device_id","linked_discovered_asset_id","notes","tags","retired_at","created_by","updated_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

Every column is classified — the contract fires on any unclassified one. `excludedOpen` is empty **by design**: the table has no `json`/`jsonb`/`bytea` column, and `tags` is `text[]`, which survives export (same reason `contacts.roles` is `text[]`). `serial_number` does not hit `SUSPICIOUS_NAME_PARTS` (`apps/api/src/services/tenantExportPolicy.ts:35`) and is already plain `included` on `device_hardware` (`:195`) and `device_warranty` (`:210`).

- [ ] **Step 3: `orgMergeRegistry`**

`apps/api/src/services/orgMergeRegistry.ts`, into `REPOINT_TABLES` (`:500`) between `'maintenance_windows'` (`:645`) and `'metric_anomalies'` (`:646`):

```ts
  "maintenance_windows",
  // #4622 — plain repoint, NOT repoint-dedupe: there is no org-unique key on
  // manual_assets by design (serial is deliberately non-unique), so merging
  // two orgs that each hold the same physical asset yields two rows. That is
  // the honest outcome and is resolvable by hand.
  "manual_assets",
  "metric_anomalies",
```

Must be in exactly one policy — `SPECIAL` and `REPOINT_TABLES` are asserted disjoint (`orgMergeRegistry.ts:786-792`).

- [ ] **Step 4: Run the unit-visible guards**

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```

Expected: PASS.

### Task 1.7 — RLS forge test with a positive control

**Files:** Create `apps/api/src/__tests__/integration/manualAssetsRls.integration.test.ts`

- [ ] **Step 1: Write it**

Two assertions, and the second is not optional — *a red without a positive control proves nothing*:

1. Connected as `breeze_app` with `breeze.scope` set to org A, `INSERT INTO manual_assets (org_id, ...) VALUES ('<org B>', ...)` must fail with SQLSTATE **42501** (`new row violates row-level security policy`). Assert on the SQLSTATE, not the message text.
2. The **same** insert with `org_id = '<org A>'` must succeed and be selectable back. If it does not, the red above was proving the fixture broken, not the policy working.

Add a third: reading org B's row from an org A context returns zero rows.

- [ ] **Step 2: Run the integration suites against a real database**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/manualAssetsRls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```

Expected: all PASS. `rls-coverage` auto-discovers `manual_assets` (shape 1 needs no allowlist entry) and asserts all four policies reference `breeze_has_org_access`. `orgLifecycleFoundations` ("merge contract") is where a non-deferrable composite FK shows up as 23503 — **it only runs in Integration Tests shard 2, so a unit-green PR still goes red there.**

- [ ] **Step 3: Manual forge as `breeze_app`**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
```

Attempt a cross-tenant insert by hand. Expected: `new row violates row-level security policy`.

- [ ] **Step 4: Commit and open the W01 PR against `main`.**

**Contract suites gating W01:** `cascadeDelete.test.ts`, `moveOrg.coverage.test.ts`, `autoMigrate.test.ts`, `migrationRlsScope.test.ts` (**Test API**); `rls-coverage`, `manualAssetsRls`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry`, `orgLifecycleFoundations` (**Integration Tests**).

**Done when:** the migration applies twice as a no-op, `pnpm db:check-drift` is clean, all four unit contract suites and all seven integration suites are green, a hand-forged cross-tenant insert is refused as `breeze_app`, and the PR targets `main`.

---

# Wave W02 — `routes/devices/manual.ts`

**Model tier: sonnet.** Mechanical CRUD against an established route pattern (`routes/devices/network.ts` is the model).

**Goal:** the six routes from the spec's API table, with audit events, site-scope enforcement, and the soft duplicate-serial warning. No UI.

**Interfaces consumed:** `manualAssets` from W01.
**Interfaces produced:** `GET /devices/manual` returns `{ data: ManualAssetRow[], pagination: { page, limit, total? } }` where `ManualAssetRow` is the null-padded unified `Device` shape with `deviceClass: 'manual'` plus `serialNumber`, `assetTag`, `location`, `assignedContactId`. W04 consumes exactly this.

### Task 2.1 — Zod schemas

**Files:** Modify `apps/api/src/routes/devices/schemas.ts`

- [ ] **Step 1: Add the schemas**

```ts
// GET /devices/manual — the manual arm of the unified Devices list (#4622).
// Mirrors listNetworkDevicesSchema (:83-97) exactly so the three arms share
// one query vocabulary.
export const listManualAssetsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  includeTotal: boolStr,
  orgId: z.string().guid().optional(),
  siteId: z.string().guid().optional(),
  orgIds: csvUuidList,
  siteIds: csvUuidList,
  assetType: z.enum(DISCOVERED_ASSET_TYPES).optional(),
  search: z.string().optional(),
});

// Written array-friendly on purpose: the CSV import path (Decision 6, deferred)
// reuses this element schema verbatim rather than re-deriving validation.
export const createManualAssetSchema = z.object({
  orgId: z.string().guid(),
  siteId: z.string().guid(),
  name: z.string().min(1).max(255),
  assetType: z.enum(DISCOVERED_ASSET_TYPES).optional(),
  manufacturer: z.string().max(255).nullish(),
  model: z.string().max(255).nullish(),
  serialNumber: z.string().max(255).nullish(),
  assetTag: z.string().max(128).nullish(),
  location: z.string().max(255).nullish(),
  assignedContactId: z.string().guid().nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).optional(),
});

export const updateManualAssetSchema = createManualAssetSchema
  .partial()
  .omit({ orgId: true })
  .extend({ retiredAt: z.union([z.null(), z.string().datetime()]).optional() });

// Link is an XOR: exactly one subject.
export const linkManualAssetSchema = z.object({
  deviceId: z.string().guid().optional(),
  discoveredAssetId: z.string().guid().optional(),
}).refine(
  (v) => (v.deviceId == null) !== (v.discoveredAssetId == null),
  { message: 'Provide exactly one of deviceId or discoveredAssetId' },
);
```

`limit` parsing (1-1000, default 500) reuses whatever `network.ts` does — copy that helper call, do not invent a second clamp.

### Task 2.2 — Route tests first

**Files:** Create `apps/api/src/routes/devices/manual.test.ts`

- [ ] **Step 1: Write the failing tests** (Drizzle mock patterns per the `breeze-testing` skill; mirror `apps/api/src/routes/devices/core.permissions.test.ts` for the auth mock shape)

Cases, one `it` each:

1. `POST` happy path → 201, row inserted with `source: 'manual'`, `manual_asset.create` audit written.
2. `POST` with an `orgId` outside `accessibleOrgIds` → **403**.
3. `POST` with a `siteId` belonging to a different org → **400/403** (the composite FK would reject it anyway; the route must not rely on a constraint violation to produce a clean error).
4. `POST` under a site-scoped technician whose `permissions.allowedSiteIds` excludes the site → **403**, using the same check `apps/api/src/routes/devices/network.ts:90-118` applies.
5. `POST` with an `assetType` outside the enum → **400**.
6. `POST` where `org_id + upper(serial_number)` already has a row → still **201**, and the body carries a non-blocking `warnings: [{ code: 'DUPLICATE_SERIAL', ... }]`. Assert the row **was** created — this is a warning, not a conflict.
7. `GET` excludes rows with `retired_at IS NOT NULL`, `linked_device_id IS NOT NULL`, or `linked_discovered_asset_id IS NOT NULL`. Assert on the bound parameters/conditions, **not** on an enum-value match — a deep-search Drizzle stub will happily match a pg enum's `enumValues` and give you a vacuous green.
8. `GET` DTO shape: `deviceClass === 'manual'`, `status === 'unknown'`, `ipAddress === null`, `macAddress === null`, `agentId === null`, `enrolledAt === created_at`.
9. `POST /:id/link` with **both** `deviceId` and `discoveredAssetId` → **400**.
10. `POST /:id/link` with a `deviceId` in another org → **403/404** (never leak existence).
11. `POST /:id/link` with a device in the same org but a different site → **400** (mirrors `apps/api/src/routes/discovery.ts:1485,1489`).
12. `DELETE /:id/link` clears **both** columns.
13. `DELETE /:id` → hard delete, `manual_asset.delete` audit written.
14. Every mutator asserts **no** `requireMfa()` in its middleware chain — the absence is a deliberate decision (spec, Users & scope), so it gets an assertion rather than a silent omission.

- [ ] **Step 2: Run — expect FAIL** (module not found)

```bash
cd apps/api && npx vitest run src/routes/devices/manual.test.ts
```

### Task 2.3 — Implement the routes

**Files:** Create `apps/api/src/routes/devices/manual.ts`; Modify `apps/api/src/routes/devices/index.ts`

- [ ] **Step 1: Write the route module**, copying `apps/api/src/routes/devices/network.ts` for the guard chain, org/site condition building, `addAllowedSiteCondition`-equivalent handling, and the null-padded DTO. The GET projection:

```ts
const data = rows.map((r) => ({
  id: r.id,
  deviceClass: 'manual' as const,
  assetType: r.assetType,
  orgId: r.orgId,
  siteId: r.siteId,
  hostname: r.name,
  displayName: r.name,
  // A manual asset has no reachability. 'unknown', never 'offline' — claiming
  // a printer that was never online is "offline" is the kind of small lie that
  // makes an inventory list untrustworthy (spec, Status column).
  status: 'unknown' as const,
  enrolledAt: r.createdAt,
  lastSeenAt: null,
  tags: r.tags ?? [],
  manufacturer: r.manufacturer ?? null,
  model: r.model ?? null,
  // Manual-only fields.
  serialNumber: r.serialNumber ?? null,
  assetTag: r.assetTag ?? null,
  location: r.location ?? null,
  assignedContactId: r.assignedContactId ?? null,
  // Everything an agent or a scanner supplies is null here.
  ipAddress: null, macAddress: null, agentId: null, agentVersion: null,
  watchdogVersion: null, osType: null, osVersion: null, osBuild: null,
  architecture: null, cpuPercent: null, ramPercent: null, hardware: null,
  metrics: null, responseTimeMs: null, openPorts: null,
  monitoringEnabled: false, snmpMonitoringEnabled: false, networkMonitoringEnabled: false,
}));
```

Guards: `devices:read` on GET, `devices:write` on POST/PATCH/link/unlink, `devices:delete` on DELETE. Every write emits `manual_asset.create` / `.update` / `.delete` / `.link` / `.unlink` via `writeRouteAudit`, matching `discovery.asset.update` / `.unlink`.

- [ ] **Step 2: Mount it**

In `apps/api/src/routes/devices/index.ts`, beside the network arm:

```ts
// Mount the manual arm of the unified Devices list (#4622) BEFORE core routes
// — `GET /manual` is a static path that must not be eaten by the `/:id`
// matcher in coreRoutes.
deviceRoutes.route('/', manualRoutes);
```

- [ ] **Step 3: Run — expect PASS**

```bash
cd apps/api && npx vitest run src/routes/devices/manual.test.ts
```

- [ ] **Step 4: Typecheck, lint, commit**

```bash
pnpm --filter @breeze/api build && pnpm lint
git add apps/api/src/routes/devices
git commit -m "feat(devices): manual asset CRUD and link routes (#4622)"
```

**Contract suites gating W02:** `manual.test.ts` (**Test API**). Re-run `cascadeDelete.test.ts` and `moveOrg.coverage.test.ts` before the PR — they read the schema and must stay green on the merge commit.

**Done when:** all fourteen route cases pass, the API builds, lint is clean, and the PR targets `main`.

---

# Wave W03 — Warranty XOR subject + report union

**Model tier: opus.** A second migration that relaxes `NOT NULL` and swaps a unique index on a shipped table, plus an XOR CHECK — high blast radius.

**Goal:** a manual asset with manufacturer + serial is eligible for the existing warranty lookup (acceptance criterion 3), and `device_inventory` reports include manual rows.

**Interfaces consumed:** `manualAssets` from W01.
**Interfaces produced:** `syncWarrantyForSubject({ orgId, manufacturer, serialNumber, subject })` where `subject` is `{ kind: 'device'; deviceId: string } | { kind: 'manualAsset'; manualAssetId: string }`. `syncWarrantyForDevice(deviceId, options)` keeps its existing signature as a thin wrapper.

### Task 3.1 — The `device_warranty` migration

**Files:** Create `apps/api/migrations/2026-10-14-100100-device-warranty-manual-asset-subject.sql`

- [ ] **Step 1: Re-pin the slot**

```bash
ls apps/api/migrations | grep -E '^2026' | sort | tail -3
```

W01 may already have landed `2026-10-14-100000-manual-assets.sql`, and `origin/main` may have gained newer files while W03 was in flight. The name must sort after **everything committed**, not after today's date. The pre-push hook re-checks against `origin/main` — if it fails, rename (this file is unmerged, so renaming is legal; a shipped migration is never renamed).

- [ ] **Step 2: Write it**

```sql
-- #4622 — device_warranty gains an XOR subject so a manual asset can carry
-- warranty data. The provider layer is already subject-agnostic; only the
-- subject binding was device-shaped. Writes no rows: no breeze.scope needed.

ALTER TABLE device_warranty ADD COLUMN IF NOT EXISTS manual_asset_id uuid;

DO $$ BEGIN
  ALTER TABLE device_warranty
    ADD CONSTRAINT device_warranty_manual_asset_fk
    FOREIGN KEY (manual_asset_id) REFERENCES manual_assets(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE device_warranty ALTER COLUMN device_id DROP NOT NULL;

-- XOR owner, the pattern custom_field_definitions_one_owner_chk already uses.
ALTER TABLE device_warranty DROP CONSTRAINT IF EXISTS device_warranty_one_subject_chk;
ALTER TABLE device_warranty
  ADD CONSTRAINT device_warranty_one_subject_chk
  CHECK ((device_id IS NULL) <> (manual_asset_id IS NULL));

-- Both upsert conflict targets must stay valid, so the single unique index
-- becomes two partial ones.
DROP INDEX IF EXISTS device_warranty_device_id_idx;
CREATE UNIQUE INDEX IF NOT EXISTS device_warranty_device_id_idx
  ON device_warranty(device_id) WHERE device_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS device_warranty_manual_asset_id_idx
  ON device_warranty(manual_asset_id) WHERE manual_asset_id IS NOT NULL;
```

The XOR CHECK is added **without** a cleanup pass because every existing row has `device_id NOT NULL` and `manual_asset_id NULL`, which satisfies it. If the constraint fails to validate on any environment, that is real data to investigate — do **not** add a silent `UPDATE`; if a cleanup ever becomes necessary it must report its row count via `GET DIAGNOSTICS` + `RAISE WARNING`.

- [ ] **Step 3: Apply twice; run `autoMigrate.test.ts` and `migrationRlsScope.test.ts`. Expected: PASS.**

### Task 3.2 — Drizzle + export policy

**Files:** Modify `apps/api/src/db/schema/warranty.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts:210`

- [ ] **Step 1: Watch the export contract fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```

After adding `manualAssetId` to the Drizzle table and before touching the registry. Expected: FAIL — an unclassified column on `device_warranty`. **This is the export-policy row that fires on a new COLUMN, not just a new table**, and it is the one that gets missed.

- [ ] **Step 2: Update the schema**

```ts
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
  // #4622 — XOR subject with device_id, enforced by
  // device_warranty_one_subject_chk. FK declared in SQL to avoid a circular
  // import between warranty.ts and manualAssets.ts.
  manualAssetId: uuid('manual_asset_id'),
```

and replace `deviceIdIdx: uniqueIndex(...)` with the two partial unique indexes.

- [ ] **Step 3: Add `"manual_asset_id"` to the `included` array of the `device_warranty` policy at `:210`** (a tenant identifier). Leave `entitlements` in `excludedOpen`.

- [ ] **Step 4: Re-run both export suites — expect PASS.**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```

### Task 3.3 — `syncWarrantyForSubject`

**Files:** Modify `apps/api/src/services/warrantySync.ts`; Create `apps/api/src/services/warrantySync.manualAsset.test.ts`

- [ ] **Step 1: Write the failing tests**

1. A manual-asset subject with `manufacturer: 'Dell'` resolves the Dell provider and upserts against the **`manual_asset_id`** conflict target (assert the conflict target, not just that an insert happened).
2. A row carrying **both** `device_id` and `manual_asset_id` is rejected by `device_warranty_one_subject_chk` (integration-level; assert SQLSTATE **23514**).
3. `syncWarrantyForDevice` still applies the `isEphemeral` and `isVirtual` guards — these are device-only ownership/efficiency rules and must **not** migrate into the shared tail.
4. `getDevicesNeedingWarrantySync` returns manual assets with non-null manufacturer **and** serial, and excludes those with either null.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Refactor**

Extract the pure tail of `syncWarrantyForDevice` (from `getProviderForManufacturer(...)` onward — `warrantySync.ts:105` and below; everything above it is the device-coupled head) into:

```ts
type WarrantySubject =
  | { kind: 'device'; deviceId: string }
  | { kind: 'manualAsset'; manualAssetId: string };

export async function syncWarrantyForSubject(input: {
  orgId: string;
  manufacturer: string;
  serialNumber: string;
  subject: WarrantySubject;
  force?: boolean;
}): Promise<void> { /* provider resolution, lookup, computeWarrantyStatus, upsert */ }
```

The upsert picks its conflict target from `subject.kind`. `syncWarrantyForDevice` keeps its signature and becomes the thin wrapper that does the hardware lookup, the ephemeral/virtual guards, and then delegates.

Extend `getDevicesNeedingWarrantySync` (`:330-361`) with a `UNION ALL` arm over `manual_assets WHERE manufacturer IS NOT NULL AND serial_number IS NOT NULL AND retired_at IS NULL`, tagging each row with its subject kind.

**`evaluateWarrantyAlerts(deviceId)` (`:161`, `:314`) stays device-only.** Manual-asset warranty is displayed, never alerted on, in v1 — a stated decision, not an oversight. Add a one-line comment saying so at the function head so the next reader does not "fix" it.

- [ ] **Step 4: Run — expect PASS. Commit.**

### Task 3.4 — Report union

**Files:** Modify `apps/api/src/services/reportGenerationService.ts`

- [ ] **Step 1: Write the failing tests** in the existing `reportGenerationService` test file:

1. `device_inventory` includes manual rows, projecting the same twelve aliases (`hostname` ← `name`, `displayName` ← `name`, `serialNumber` ← `serial_number`, `enrolledAt` ← `created_at`, `status` ← `'unknown'`, `osType`/`osVersion`/`agentVersion`/`cpuModel`/`ramTotalMb`/`diskTotalGb`/`lastSeenAt` NULL).
2. `filters.includeManualAssets: false` returns exactly the old agent-only shape.
3. `addAllowedSiteCondition(conditions, authority)` is applied to **each branch independently** — a site-restricted authority must not leak manual rows from sites it cannot see. Test with an authority allowed one site and manual assets in two.
4. `zeroSafeReport`'s `device_inventory` case (`:722`) stays shape-compatible.

Note the existing early return: `if (addAllowedSiteCondition(conditions, authority)) return emptyRowsReport();` (`:268`) short-circuits the whole function for a restricted-empty authority. Keep that behaviour for the merged report — a restricted authority with no allowed sites sees nothing from either branch.

- [ ] **Step 2: Run — expect FAIL. Step 3: Implement. Step 4: Run — expect PASS. Commit.**

**Contract suites gating W03:** `warrantySync.manualAsset.test.ts`, the `reportGenerationService` tests, `autoMigrate.test.ts`, `migrationRlsScope.test.ts` (**Test API**); `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `tenantCascade.integration.test.ts` (**Integration Tests** — the last one because `device_warranty` must still be deleted before `manual_assets`).

**Done when:** both migrations apply twice as no-ops, the XOR check rejects a two-subject row with 23514, warranty sync upserts against the right conflict target for each subject kind, `device_inventory` includes manual rows and respects site restriction per branch, and the export suites are green.

---

# Wave W04 — Web third class, modal, E2E, docs

**Model tier: sonnet.** Broad but mechanical: extend an existing binary split to three-way and add one modal.

**Goal:** manual assets are a first-class class in the unified Devices list, addable and editable from a modal, with honest filter/segment/bulk-bar behaviour.

**Interfaces consumed:** `GET/POST/PATCH/DELETE /devices/manual` and `/devices/manual/:id/link` from W02.

### Task 4.1 — `mergedListFilter.ts` class dispatch (red first)

**Files:** Modify `apps/web/src/components/devices/mergedListFilter.ts`, `mergedListFilter.test.ts`

- [ ] **Step 1: Write the failing tests**

1. A manual row hidden by an agent-only filter (e.g. `agentVersion`) is counted **and named** by the hidden-rows summary — never silently dropped.
2. A manual row matches on `hostname` (← `name`), `tags`, `deviceRole` (← `asset_type`), `orgId`, `siteId`, `hardware.manufacturer`, `hardware.model`, `hardware.serialNumber`.
3. A manual row is **inapplicable** for `status`, `network.ipAddress`, `network.macAddress`, `daysSinceLastSeen`, `lastSeenAt`, `osType`, `agentVersion` and every metric field — `{ applicable: false }`, blamed in the notice.
4. `matchesVpnFacet` returns `false` for a manual row on any non-`all` VPN facet, same as network.
5. `matchesSearchQuery` matches on `serialNumber` and `assetTag` in addition to today's fields.
6. Segment counts equal the post-filter row count per class (the #5090 contract — counts are computed over `fleetFilteredDevices`, `DevicesPage.tsx:385-389`, *before* segment narrowing).

- [ ] **Step 2: Run — expect FAIL.**

```bash
cd apps/web && npx vitest run src/components/devices/mergedListFilter.test.ts
```

- [ ] **Step 3: Implement**

Replace `const isNetwork = (d: Device) => …` (`:24`) with a class accessor, add `manualFieldValue(field, d)` beside `networkFieldValue` (`:31-69`), generalise the dispatch at `:284-295`, widen `matchesVpnFacet` (`:265-270`) to "any non-agent class", extend `matchesSearchQuery` (`:272-280`), and rename `summarizeHiddenNetworkDevices` → `summarizeHiddenNonAgentDevices` (`:302-324`) carrying a per-class label so the notice can say *"3 manual assets hidden"* rather than mislabelling them as network devices. **Sweep every call site of the old name** — a rename that compiles but leaves a caller on a stale import is exactly how a notice silently stops firing.

`manualFieldValue`:

```ts
function manualFieldValue(field: string, d: Device): { applicable: boolean; value: Scalar | string[] } {
  switch (field) {
    case 'hostname':                return { applicable: true, value: d.hostname };
    case 'displayName':             return { applicable: true, value: d.displayName ?? null };
    case 'tags':                    return { applicable: true, value: d.tags ?? [] };
    case 'deviceRole':              return { applicable: true, value: d.assetType ?? 'unknown' };
    case 'orgId':                   return { applicable: true, value: d.orgId };
    case 'siteId':                  return { applicable: true, value: d.siteId };
    case 'hardware.manufacturer':   return { applicable: true, value: d.manufacturer ?? null };
    case 'hardware.model':          return { applicable: true, value: d.model ?? null };
    case 'hardware.serialNumber':   return { applicable: true, value: d.serialNumber ?? null };
    // status, network.*, daysSinceLastSeen, lastSeenAt, os*, agentVersion and
    // every metric are agent/network concepts a hand-entered row cannot answer.
    default:                        return { applicable: false, value: undefined };
  }
}
```

Note `status` is deliberately **inapplicable** for manual (unlike network, where it is applicable): a manual asset has no reachability, so a `status` condition must blame the field rather than reject the row on a fabricated `'unknown'`.

- [ ] **Step 4: Run — expect PASS.**

### Task 4.2 — Class union, segment, and columns

**Files:** Modify `deviceClassFilter.ts`, `deviceClassFilter.test.ts`, `DeviceClassSegment.tsx`, `DeviceClassSegment.test.tsx`, `DeviceList.tsx`, `DeviceList.test.tsx`, `apps/web/src/locales/*/devices.json`

- [ ] **Step 1: Failing tests first** — `countDevicesByClass` returns a `manual` key; `DeviceClassFilter`'s `VALID` set accepts `'manual'`; the hash round-trips `deviceClass=manual`; the segment renders four chips; the bulk bar offers **Delete only** for a manual-only selection and *"N of M eligible"* on a mixed one; agent-only columns collapse when the visible set is manual-only.

- [ ] **Step 2: Implement**

- `DeviceClass` (`DeviceList.tsx:126`) → `"agent" | "network" | "manual"`.
- `DeviceClassFilter` and `VALID` (`deviceClassFilter.ts:9-11`) gain `'manual'`; `countDevicesByClass` (`:27-37`) gains the key; update the type-only exhaustive array at the foot of `deviceClassFilter.test.ts`.
- `DeviceClassSegment.tsx`: fourth entry with the `Package` icon from `lucide-react`, `counts` prop widened.
- `NETWORK_ONLY_COLUMNS` (`DeviceList.tsx:320-323`) → a per-class availability map. Three new opt-in columns: `serial` (manual **and** agent, the latter via `device_hardware`), `assetTag`, `location` (manual only).
- The `agentOnly(...)` dash helper (`:1314-1318`) must treat manual like network.
- The class-aware `sortValue` ternaries (`:561-598`) become three-way — check each one; a two-branch ternary silently folds manual into whichever branch is the `else`.
- Row Actions cell (`:2560`): manual rows get **Edit** and **Delete** instead of **View** (no detail route in v1).
- `selectedNetworkCount` (`:1055`) → a per-class tally so the composition line at `:2263-2266` stays honest; `agentOnlyDisabled` / `agentOnlySuffix` (`:1060-1071`) are unchanged in behaviour.

- [ ] **Step 3: Locale keys**

Add `deviceClassSegment.segments.manual` and any new `deviceList.*` / `manualAsset.*` keys to **all eight** locales under `apps/web/src/locales/*/devices.json` (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`). `apps/web/src/lib/i18n/localeParity.test.ts` fails on any missing key. Never compare a rendered string against `i18n.t(...)` in a test — that assertion is vacuous outside `en`.

- [ ] **Step 4: Run the web suites — expect PASS.**

```bash
cd apps/web && npx vitest run src/components/devices src/lib/i18n/localeParity.test.ts
```

### Task 4.3 — Fetch arm, page wiring, and the split Add button

**Files:** Modify `apps/web/src/lib/devicesFetch.ts`, `DevicesPage.tsx`

- [ ] **Step 1: `fetchAllManualAssets`** in `devicesFetch.ts`, mirroring `fetchAllNetworkDevices` including its degrade-to-empty-on-404 behaviour.

- [ ] **Step 2: Third arm** in the `Promise.all` at `DevicesPage.tsx:462-495`, with the same *degrade to empty on non-401* semantics as the network arm at `:489`. **Do not invent a new pagination contract** — the page already fetches every arm in full and merges client-side (`:488-495`, `:639`); that is known debt owned by #1424 and this wave must not deepen it.

- [ ] **Step 3: Transform block** beside the network transform (`:601-637`), producing `deviceClass: 'manual'` rows.

- [ ] **Step 4: Split the Add button.** `DevicesPage.tsx:1765-1771` becomes a two-item menu: *Install agent…* (today's `AddDeviceModal` flow, which creates no row) and *Add asset manually…*. Give `DevicesPage.tsx:1834-1841` (the empty-state duplicate) the same treatment. Hash state `#add-manual-asset`, via the existing `useHashState` helper (`:190`).

- [ ] **Step 5: `handleSelectDevice`** (`:815-822`) opens the edit modal for a manual row.

- [ ] **Step 6: Bulk allowlist.** `handleBulkAction`'s `filter(d => (d.deviceClass ?? 'agent') === 'agent')` (`:1187`) becomes an **explicit agent-only allowlist** so manual rows are skipped with the same *"N of M eligible"* toast — skipped visibly, never silently. Delete is the one bulk action manual rows are eligible for in v1.

### Task 4.4 — The add/edit modal

**Files:** Create `apps/web/src/components/devices/ManualAssetModal.tsx`, `ManualAssetModal.test.tsx`

- [ ] **Step 1: Failing tests** — submit calls `runAction`; a `DUPLICATE_SERIAL` warning renders non-blockingly and does **not** prevent submission; Site defaults to the org's only site when there is exactly one; Name is required; the link control is present on the modal's primary surface (**not** buried in a tab — #3451 records that as today's mistake on `/devices/network/:id`).

- [ ] **Step 2: Implement.** Fields: Org (pre-filled from page context), Site (required), Name, Asset type (the `discovered_asset_type` enum with the same icons the Type column uses), Manufacturer, Model, Serial, Asset tag, Location, Assigned contact (typeahead over `contacts` for the selected org — the route lives at `apps/api/src/routes/orgContacts.ts`), Tags, Notes.

**Every mutation goes through `runAction`** (`apps/web/src/lib/runAction.ts`). Caller catch pattern:

```ts
if (err instanceof ActionError && err.status === 401) return; // let auth redirect handle it
if (!(err instanceof ActionError)) showToast({ type: 'error', ... });
```

- [ ] **Step 3: Run `no-silent-mutations`**

```bash
cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts
```

Expected: PASS with no new entry in `apps/web/src/lib/runActionAllowlist.ts` — a modal form is not one of the recorded exceptions.

### Task 4.5 — E2E and docs

**Files:** Create `e2e-tests/tests/manual-assets.spec.ts`; Modify `apps/docs/src/content/docs/features/devices.mdx`

- [ ] **Step 1: E2E spec** — add a manual asset from the Devices page, see it in the list under the Manual segment, edit it, delete it. **`data-testid` selectors only** (per `e2e-tests/README.md`) — never text, role, or CSS. Add the `data-testid` attributes to the modal and segment as you go. Wait for Astro island hydration before filling the form; a `fill` before hydration submits an empty form and produces a first-test `waitForURL` timeout that looks like a slow app.

- [ ] **Step 2: Docs** — update the device-list / asset-classes section for the third class and extend the discovery-vs-inventory explanation: *has a network identity → a discovered asset; does not → a manual asset*. Flag it as a user-visible feature for release notes.

- [ ] **Step 3: Full web + e2e run, then commit and open the PR against `main`.**

**Contract suites gating W04:** `mergedListFilter.test.ts`, `deviceClassFilter.test.ts`, `DeviceClassSegment.test.tsx`, `DeviceList.test.tsx`, `ManualAssetModal.test.tsx`, `no-silent-mutations.test.ts`, `localeParity.test.ts` (**Test Web**); `manual-assets.spec.ts` (**E2E**).

**Done when:** the Manual segment shows an accurate post-filter count, an agent-only filter hides manual rows *and names them* in the notice, the bulk bar offers Delete only, the modal round-trips through `runAction`, all eight locales carry the new keys, and the E2E spec is green.

---

## Follow-up issues to file when W04 lands

List only — do **not** create these during implementation; file them from the final wave's PR.

1. **CSV / bulk import for manual assets** (spec Decision 6). Needs a preview/dry-run, per-row error reporting, duplicate resolution and a stable idempotency key. The `manual_asset_source` enum already ships with `'import'` and `createManualAssetSchema` is written array-friendly, so the route work is additive. Onboarding a 40-printer fleet by hand is genuinely painful — this is an immediate follow-up, not a someday.
2. **Custom fields on manual assets** (spec Decision 4, option b). Generalise `custom_field_definitions` with an `entity_type` and add a `manual_asset_custom_field_values` table. The work is the two couplings the spec verified: `device_custom_field_values` carries a composite FK `(device_id, org_id) → devices(id, org_id)` **and** a trigger projecting into `devices.custom_fields` (`apps/api/src/db/schema/deviceCustomFieldValues.ts:26-57`, `schema/customFields.ts:29-32`). A jsonb `attributes` bag is disqualified outright — it lands in `excludedOpen` and silently vanishes from tenant export.
3. **Per-asset detail page for manual assets**, blocked on **#1424** (unified list phase 2 owns routing and pagination unification, including where link/unlink lives — #3451). v1 edits in a modal. This plan keeps a stable `id` and a class discriminator on every DTO so #1424 is not blocked.

Also worth noting in the W04 PR body, not as issues: warranty **alerting** stays device-only (`evaluateWarrantyAlerts`); manual assets are not billable and deliberately absent from `billableDeviceConds`; and the three-arm client-side merge in `DevicesPage.tsx` remains #1424's debt to pay.
