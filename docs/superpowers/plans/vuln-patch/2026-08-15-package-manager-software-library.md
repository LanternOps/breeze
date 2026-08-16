# Package-Manager Software Library (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let techs add winget/Homebrew packages to the Software Library (search or paste-ID), deploy them via the package manager, with an opt-in Homebrew bootstrap.

**Architecture:** New `software_install_methods` child table of `software_catalog` (EXISTS-join RLS, mirroring `software_versions`). The deploy pipeline gains a manager branch: `software_deployments` can reference an install method instead of a version; the agent's `software_install` command gains an `installMethod` payload mode that shells to winget/brew with install-only semantics (never upgrade). Discovery = a synced winget-pkgs ID index (global table + BullMQ job) plus a cached formulae.brew.sh proxy.

**Tech Stack:** Drizzle + hand-written SQL migrations, Hono + zod, BullMQ, Go agent, Astro/React + Vitest.

**Spec:** `docs/superpowers/specs/vuln-patch/2026-08-15-package-manager-software-library-design.md`

## Global Constraints

- Migrations: `YYYY-MM-DD-<slug>.sql`, idempotent, no inner `BEGIN`/`COMMIT`, RLS enabled+forced in the same migration. Never touch the closed `2026-08-06` block.
- RLS: `software_install_methods` uses EXISTS-join policies to `software_catalog` and registers in `PARENT_FK_JOIN_POLICY_TABLES` (`rls-coverage.integration.test.ts:498`). No `org_id` column → no cascade-order or export-policy entry. But any NEW COLUMN on `software_deployments` (already in the cascade order) MUST be classified in `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`).
- winget package IDs validate against `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`, max 256 (matches `agent/internal/remote/tools/software.go:89`). brew names against `^[A-Za-z0-9][A-Za-z0-9+._/@-]{0,255}$` plus no leading `-`/`/`, no `..` (matches `agent/internal/patching/command_limits.go:27`).
- Install-only semantics everywhere: never call the patch providers' `Install()` (it upgrades). winget: `--exact --scope machine --silent --accept-package-agreements --accept-source-agreements --source winget --disable-interactivity`, no `--force`, no hash-bypass. brew: `brew install [--cask]`, never `brew upgrade`.
- Exact-version miss = per-device failure; never fall back to latest. Homebrew is latest-only in phase 1.
- Web mutations via `runAction`. i18n keys for all new copy (follow `policies:software.*` namespace).
- Agent Go tests: `cd agent && go test -race ./internal/...`. API unit: `pnpm --filter @breeze/api test`. Web: `pnpm --filter @breeze/web test`. RLS/integration suites are separate configs — run when told.
- Commit after every task (checkpoint commits).
- Known plan-level narrowing vs spec (approved): the deploy-wizard "manager unavailable on N devices" preview is OS-based only in phase 1 (devices whose `osType` has no enabled method). Per-device winget-presence telemetry is a follow-up; agent-side `manager_unavailable:` errors keep post-run results honest.

---

### Task 1: Migration + Drizzle schema for `software_install_methods`

**Files:**
- Create: `apps/api/migrations/2026-08-16-a-software-install-methods.sql`
- Modify: `apps/api/src/db/schema/software.ts` (append table + types)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:498` (`PARENT_FK_JOIN_POLICY_TABLES`)

**Interfaces:**
- Produces: `softwareInstallMethods` Drizzle table (import from `../db/schema`); type `SoftwareInstallMethod = typeof softwareInstallMethods.$inferSelect`; enums `installMethodPlatformEnum` (`'windows'|'macos'`), `installMethodKindEnum` (`'winget'|'homebrew_cask'|'homebrew_formula'`).

- [ ] **Step 1: Write the migration**

```sql
-- Package-manager install methods for software_catalog items (spec:
-- docs/superpowers/specs/vuln-patch/2026-08-15-package-manager-software-library-design.md).
--
-- One row per (catalog item, platform, kind): a winget package ID or a
-- Homebrew formula/cask name that can install this library item. Version
-- intent (latest vs exact) lives on the deployment, not here.
--
-- Tenancy: parent-FK join shape — no org_id/partner_id; RLS policies
-- EXISTS-join to software_catalog (template: software_versions policies in
-- 2026-07-02-builtin-catalog-partner-read-rls.sql). Registered in
-- PARENT_FK_JOIN_POLICY_TABLES; NOT in the org cascade order (FK CASCADE +
-- topologicalCascadeOrder handle deletion), so no export-policy entry.
--
-- Idempotent: IF NOT EXISTS + guarded DO blocks + DROP POLICY IF EXISTS.

CREATE TABLE IF NOT EXISTS software_install_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id uuid NOT NULL REFERENCES software_catalog(id) ON DELETE CASCADE,
  platform varchar(10) NOT NULL,
  kind varchar(20) NOT NULL,
  package_id varchar(256) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE software_install_methods
    ADD CONSTRAINT software_install_methods_platform_chk
    CHECK (platform IN ('windows', 'macos'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE software_install_methods
    ADD CONSTRAINT software_install_methods_kind_chk
    CHECK (kind IN ('winget', 'homebrew_cask', 'homebrew_formula'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Platform/kind coherence: winget is Windows-only, homebrew is macOS-only.
DO $$ BEGIN
  ALTER TABLE software_install_methods
    ADD CONSTRAINT software_install_methods_platform_kind_chk
    CHECK (
      (kind = 'winget' AND platform = 'windows')
      OR (kind IN ('homebrew_cask', 'homebrew_formula') AND platform = 'macos')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS software_install_methods_catalog_platform_kind_uq
  ON software_install_methods (catalog_id, platform, kind);
CREATE INDEX IF NOT EXISTS software_install_methods_catalog_id_idx
  ON software_install_methods (catalog_id);

ALTER TABLE software_install_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_install_methods FORCE ROW LEVEL SECURITY;

-- SELECT carries the built-in third branch mirroring software_versions
-- (2026-07-02); writes carry only org + partner branches. v1 never creates
-- methods on built-in rows (app-layer guard), but read parity keeps the two
-- child tables' policies interchangeable.
DROP POLICY IF EXISTS breeze_org_isolation_select ON software_install_methods;
CREATE POLICY breeze_org_isolation_select ON software_install_methods FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_install_methods.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
        OR (
          sc.integration_provider IS NOT NULL
          AND sc.partner_id IN (
            SELECT o.partner_id FROM organizations o
            WHERE o.id = ANY(public.breeze_accessible_org_ids())
          )
        )
      )
  )
);
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_install_methods;
CREATE POLICY breeze_org_isolation_insert ON software_install_methods FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_install_methods.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
      )
  )
);
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_install_methods;
CREATE POLICY breeze_org_isolation_update ON software_install_methods FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_install_methods.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
      )
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_install_methods.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
      )
  )
);
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_install_methods;
CREATE POLICY breeze_org_isolation_delete ON software_install_methods FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM software_catalog sc
    WHERE sc.id = software_install_methods.catalog_id
      AND (
        public.breeze_has_org_access(sc.org_id)
        OR (sc.partner_id IS NOT NULL AND public.breeze_has_partner_access(sc.partner_id))
      )
  )
);
```

- [ ] **Step 2: Append the Drizzle table to `apps/api/src/db/schema/software.ts`**

```ts
// Package-manager install methods (one per catalog item × platform × kind).
// Parent-FK join tenancy: no org_id — RLS EXISTS-joins to software_catalog
// (migration 2026-08-16-a-software-install-methods.sql). Version intent
// (latest/exact) lives on the deployment, not here.
export const softwareInstallMethods = pgTable('software_install_methods', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogId: uuid('catalog_id').notNull().references(() => softwareCatalog.id, { onDelete: 'cascade' }),
  platform: varchar('platform', { length: 10 }).notNull(),   // 'windows' | 'macos'
  kind: varchar('kind', { length: 20 }).notNull(),           // 'winget' | 'homebrew_cask' | 'homebrew_formula'
  packageId: varchar('package_id', { length: 256 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  catalogPlatformKindUq: uniqueIndex('software_install_methods_catalog_platform_kind_uq').on(table.catalogId, table.platform, table.kind),
  catalogIdx: index('software_install_methods_catalog_id_idx').on(table.catalogId)
}));

export type SoftwareInstallMethod = typeof softwareInstallMethods.$inferSelect;
export type InstallMethodPlatform = 'windows' | 'macos';
export type InstallMethodKind = 'winget' | 'homebrew_cask' | 'homebrew_formula';
```

(Add `uniqueIndex` to the existing `drizzle-orm/pg-core` import if not present.)

- [ ] **Step 3: Register in the RLS coverage allowlist**

In `rls-coverage.integration.test.ts`, add to `PARENT_FK_JOIN_POLICY_TABLES` (keep map order consistent with its neighbors):

```ts
  ['software_install_methods', ['software_catalog']],
```

- [ ] **Step 4: Verify migration naming + drift**

Run: `./scripts/check-migration-naming.sh && pnpm --filter @breeze/api test -- autoMigrate`
Expected: PASS (naming OK, ordering test green).
Then (needs local DB): `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:migrate && pnpm db:check-drift`
Expected: migration applies; no drift.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-08-16-a-software-install-methods.sql apps/api/src/db/schema/software.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(api): software_install_methods table with parent-FK RLS"
```

---

### Task 2: Install-method CRUD routes

**Files:**
- Create: `apps/api/src/routes/softwareInstallMethods.ts`
- Create: `apps/api/src/routes/softwareInstallMethods.test.ts`
- Modify: `apps/api/src/routes/software.ts` (mount the sub-router)

**Interfaces:**
- Consumes: `softwareInstallMethods`, `softwareCatalog` from `../db/schema`; `resolveScopedOrgId` from `../services/softwareVersionShared`; `requireScope`, `requirePermission`, `requireMfa` middleware; `writeRouteAudit` from `../services/auditEvents`; `PERMISSIONS` from `../services/permissions`.
- Produces: `softwareInstallMethodRoutes` (Hono router with paths `/catalog/:id/install-methods` GET+POST, `/catalog/:id/install-methods/:methodId` PATCH+DELETE); exported zod pieces `installMethodBodySchema`, `WINGET_PACKAGE_ID_RE`, `BREW_PACKAGE_NAME_RE`, and helper `validatePackageIdForKind(kind, packageId): string | null` (returns error message or null) reused by Tasks 3 and 4.

- [ ] **Step 1: Write failing route tests**

Follow the Drizzle chain-mock pattern used by `software.test.ts` in the same directory (read its top ~80 lines first and mirror its `vi.mock('../db', ...)` setup exactly — chain mocks can't yield `insert().values().returning()` rows implicitly; mock explicitly). Cases:

```ts
describe('POST /software/catalog/:id/install-methods', () => {
  it('creates a winget method on an owned catalog item', ...);       // 201, insert called with catalogId/platform/kind/packageId
  it('rejects kind/platform mismatch (winget + macos)', ...);        // 400 from zod refine
  it('rejects malformed winget packageId ("bad id;rm")', ...);       // 400
  it('rejects malformed brew name ("../evil")', ...);                // 400
  it('404s when the catalog item is not visible/owned', ...);        // catalog select returns []
  it('rejects methods on built-in items (integrationProvider set)', ...); // 400
  it('maps unique-violation to 409', ...);                           // insert throws {code:'23505'}
});
describe('PATCH /software/catalog/:id/install-methods/:methodId', () => {
  it('updates enabled/packageId', ...);
  it('validates packageId against the method kind on update', ...);
});
describe('DELETE ...', () => { it('deletes and audits', ...); });
describe('GET ...', () => { it('lists methods for the item', ...); });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @breeze/api test -- softwareInstallMethods`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the router**

Core shapes (write the file with these exact definitions):

```ts
export const WINGET_PACKAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const BREW_PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+._/@-]{0,255}$/;

export function validatePackageIdForKind(kind: string, packageId: string): string | null {
  if (packageId.length > 256) return 'packageId exceeds 256 characters';
  if (kind === 'winget') {
    return WINGET_PACKAGE_ID_RE.test(packageId) ? null : 'Invalid winget package ID';
  }
  if (
    !BREW_PACKAGE_NAME_RE.test(packageId) ||
    packageId.startsWith('-') || packageId.startsWith('/') || packageId.includes('..')
  ) {
    return 'Invalid Homebrew package name';
  }
  return null;
}

export const installMethodBodySchema = z.object({
  platform: z.enum(['windows', 'macos']),
  kind: z.enum(['winget', 'homebrew_cask', 'homebrew_formula']),
  packageId: z.string().min(1).max(256),
  enabled: z.boolean().optional(),
}).superRefine((data, ctx) => {
  const platformOk =
    (data.kind === 'winget' && data.platform === 'windows') ||
    (data.kind !== 'winget' && data.platform === 'macos');
  if (!platformOk) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: 'kind does not match platform' });
  }
  const err = validatePackageIdForKind(data.kind, data.packageId);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['packageId'], message: err });
});
```

Handler skeleton (org resolution + ownership guard copied from the deploy handlers' inline pattern at `software.ts:1293-1298`):

```ts
export const softwareInstallMethodRoutes = new Hono();
const requireWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

async function loadOwnedCatalogItem(auth: AuthContext, catalogId: string, orgId: string) {
  const [item] = await db.select().from(softwareCatalog).where(eq(softwareCatalog.id, catalogId)).limit(1);
  // RLS restricts visibility; extra guard mirrors software.ts deploy handlers.
  if (!item || (item.orgId !== null && item.orgId !== orgId)) return null;
  return item;
}

softwareInstallMethodRoutes.post(
  '/catalog/:id/install-methods',
  requireScope('organization', 'partner', 'system'),
  requireWrite,
  requireMfa(),
  zValidator('json', installMethodBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const item = await loadOwnedCatalogItem(auth, c.req.param('id'), orgResult.orgId);
    if (!item) return c.json({ error: 'Catalog item not found or access denied' }, 404);
    if (item.integrationProvider !== null) {
      return c.json({ error: 'Built-in packages cannot carry install methods' }, 400);
    }
    const payload = c.req.valid('json');
    try {
      const [method] = await db.insert(softwareInstallMethods).values({
        catalogId: item.id,
        platform: payload.platform,
        kind: payload.kind,
        packageId: payload.packageId,
        enabled: payload.enabled ?? true,
      }).returning();
      writeRouteAudit(c, {
        orgId: orgResult.orgId,
        action: 'software.install_method.create',
        resourceType: 'software_install_method',
        resourceId: method!.id,
        resourceName: `${item.name} (${payload.kind}:${payload.packageId})`,
      });
      return c.json({ data: method }, 201);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        return c.json({ error: 'An install method for this platform and kind already exists' }, 409);
      }
      throw err;
    }
  },
);
```

GET lists `where(eq(softwareInstallMethods.catalogId, item.id))` (read perm = `DEVICES_READ`, no MFA). PATCH accepts `installMethodBodySchema.partial()` minus platform/kind changes that would break coherence — simplest: allow only `{ packageId?, enabled? }` and re-validate `packageId` against the stored `kind`. DELETE removes by `and(eq(id), eq(catalogId))` and audits `software.install_method.delete`.

Mount in `software.ts` (after the other route registrations): `softwareRoutes.route('/', softwareInstallMethodRoutes);` with the import at top.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/api test -- softwareInstallMethods`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/softwareInstallMethods.ts apps/api/src/routes/softwareInstallMethods.test.ts apps/api/src/routes/software.ts
git commit -m "feat(api): install-method CRUD under /software/catalog/:id/install-methods"
```

---

### Task 3: Import endpoint (`POST /software/catalog/import-package`)

**Files:**
- Modify: `apps/api/src/routes/softwareInstallMethods.ts` (add the route + schema)
- Modify: `apps/api/src/routes/softwareInstallMethods.test.ts`

**Interfaces:**
- Consumes: `installMethodBodySchema` internals from Task 2.
- Produces: `POST /software/catalog/import-package` accepting `{ name, vendor?, category?, description?, homepageUrl?, iconUrl?, orgId?, methods: [{platform, kind, packageId}] (1..4) }`, returning `{ data: { catalogItem, methods } }` 201. The web modal (Task 9) calls this.

- [ ] **Step 1: Write failing tests** — creates catalog row + N method rows in one `db.transaction`; duplicate platform+kind pairs in the body → 400; empty methods array → 400; method validation reuses `validatePackageIdForKind`.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test -- softwareInstallMethods` → FAIL on new cases.

- [ ] **Step 3: Implement**

```ts
const importPackageSchema = z.object({
  name: z.string().min(1).max(200),
  vendor: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  homepageUrl: z.string().url().optional(),
  iconUrl: z.string().url().optional(),
  orgId: z.string().guid().optional(),
  methods: z.array(
    z.object({
      platform: z.enum(['windows', 'macos']),
      kind: z.enum(['winget', 'homebrew_cask', 'homebrew_formula']),
      packageId: z.string().min(1).max(256),
    })
  ).min(1).max(4),
}).superRefine((data, ctx) => {
  const seen = new Set<string>();
  data.methods.forEach((m, i) => {
    const key = `${m.platform}:${m.kind}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['methods', i], message: 'Duplicate platform+kind' });
    }
    seen.add(key);
    const platformOk = (m.kind === 'winget') === (m.platform === 'windows');
    if (!platformOk) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['methods', i, 'kind'], message: 'kind does not match platform' });
    const err = validatePackageIdForKind(m.kind, m.packageId);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['methods', i, 'packageId'], message: err });
  });
});
```

Handler: resolve org via `resolveScopedOrgId` (same as Task 2), then one `db.transaction(async (tx) => { insert catalog row (orgId, name, vendor, category ?? 'application', description, iconUrl, websiteUrl: homepageUrl); insert all method rows; })`, audit `software.catalog.import`, return both. Same middleware stack as Task 2 POST.

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): one-shot package import endpoint"`

---

### Task 4: Manager-deploy plumbing (schema + service + route)

**Files:**
- Create: `apps/api/migrations/2026-08-16-b-software-deployments-install-method.sql` (NOTE: `-b-` only if this lands the same day as Task 1's file AND depends on it — it does: FK to the new table. Name Task 1's file `2026-08-16-a-software-install-methods.sql` and this one `-b-` from the start.)
- Modify: `apps/api/src/db/schema/software.ts` (`softwareDeployments` + column)
- Modify: `apps/api/src/services/softwareDeployment.ts`
- Modify: `apps/api/src/routes/software.ts` (`createDeploymentSchema`, POST /deployments handler)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`software_deployments` entry gains `install_method_id`)
- Test: `apps/api/src/services/softwareDeployment.test.ts` (extend), `apps/api/src/routes/software.test.ts` (extend)

**Interfaces:**
- Consumes: `softwareInstallMethods` table (Task 1); `validatePackageIdForKind` (Task 2).
- Produces:
  - `software_deployments.install_method_id` (nullable uuid FK) + `software_version_id` now nullable + CHECK exactly-one.
  - `CreateSoftwareDeploymentInput` union extension: `softwareVersionId?: string; installMethodCatalogId?: string; versionMode?: 'latest' | 'exact'; requestedVersion?: string;` (exactly one of `softwareVersionId` / `installMethodCatalogId`).
  - Agent command payload manager shape (consumed by Tasks 5–6):
    `{ deploymentId, retryCount, installMethod: { kind: 'winget'|'homebrew_cask'|'homebrew_formula', packageId: string }, versionMode: 'latest'|'exact', requestedVersion?: string, softwareName: string, forceReinstall?: boolean }` — NO `downloadUrl`.

- [ ] **Step 1: Migration**

```sql
-- Manager-linked deployments: a software_deployment now targets EITHER an
-- uploaded/URL version (software_version_id) OR a package-manager install
-- method (install_method_id). Exactly one is set.
-- Export policy: install_method_id classified 'included' (tenant identifier)
-- in CORE_TENANT_EXPORT_POLICY in the same PR.

ALTER TABLE software_deployments
  ADD COLUMN IF NOT EXISTS install_method_id uuid REFERENCES software_install_methods(id);

ALTER TABLE software_deployments
  ALTER COLUMN software_version_id DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE software_deployments
    ADD CONSTRAINT software_deployments_one_target_chk
    CHECK ((software_version_id IS NULL) <> (install_method_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS software_deployments_install_method_idx
  ON software_deployments (install_method_id);
```

Drizzle side: `softwareVersionId` loses `.notNull()`; add `installMethodId: uuid('install_method_id').references(() => softwareInstallMethods.id),` + index. Registry: add `"install_method_id"` to the `included` list of the existing `"software_deployments"` `tablePolicy(...)` entry.

- [ ] **Step 2: Write failing service tests**

In `softwareDeployment.test.ts` (mirror existing mock style):
- manager deploy builds payload with `installMethod`/`versionMode` and WITHOUT `downloadUrl`;
- device with `osType: 'linux'` (no matching method) → its `deploymentResults` row UPDATEd to `failed` with `errorMessage` containing `No install method for this device OS`, not dispatched;
- `versionMode: 'exact'` includes `requestedVersion` in payload; `'exact'` without `requestedVersion` rejected upstream (route test);
- all-devices-unresolvable → result `{ status: 'failed' }` (mirrors the existing all-variables-failed branch).

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @breeze/api test -- softwareDeployment` → FAIL.

- [ ] **Step 4: Implement service branch**

In `createSoftwareDeployment` / `buildAndDispatchSoftwareInstalls`:
- Accept the new input fields; when `installMethodCatalogId` set: load the catalog item (same org guard as versions path) + its enabled methods; insert the deployment with `installMethodId` = the *primary* method row… **No** — a deployment references ONE method row, but a cross-platform item has two. Resolution: the deployment stores `install_method_id` of the method matching the FIRST resolved device platform is wrong too. Correct shape: deployment stores the CATALOG-level intent — set `install_method_id` to NULL-per-platform is impossible with one column, so: the route resolves methods per device at dispatch; the deployment row's `install_method_id` records the method used for name/reporting when only one exists, and when the item has methods for both platforms the route creates ONE deployment per platform present in the target set (name suffixed ` (Windows)` / ` (macOS)`), each with its own `install_method_id`. This keeps the 1:1 column honest and result rows unambiguous. Implement `splitTargetsByPlatform(deviceRows)` in the route handler.
- Add `osType: devices.osType` to the device select in the dispatch loop.
- Per device: pick the deployment's method; if `device.osType !== method.platform` → UPDATE that result row `failed` / `No install method for this device OS (<osType>)` and `continue` (exact copy of the unresolved-variable UPDATE shape at `softwareDeployment.ts:415-431`).
- Payload build (replacing the downloadUrl block for manager deploys):

```ts
const payload: AgentCommand['payload'] = {
  deploymentId,
  retryCount,
  installMethod: { kind: method.kind, packageId: method.packageId },
  versionMode,
  ...(versionMode === 'exact' ? { requestedVersion } : {}),
  softwareName: catalogItem.name,
  forceReinstall,
};
```

- Skip the download-policy / checksum / variable-resolution blocks for manager deploys (they are URL-path concerns).

- [ ] **Step 5: Route changes**

`createDeploymentSchema`: make `softwareVersionId` optional, add `catalogId: z.string().guid().optional()`, `versionMode: z.enum(['latest','exact']).optional()`, `requestedVersion: z.string().min(1).max(64).optional()`; superRefine: exactly one of `softwareVersionId`/`catalogId`; `versionMode: 'exact'` requires `requestedVersion` AND is only valid when the resolved item has a winget method (validated in the handler, 400 otherwise); `requestedVersion` without `exact` → 400. Handler: on `catalogId` path, load item + enabled methods (404 on the same ownership guard), split targets by platform, call `createSoftwareDeployment` per platform group. Route tests for each rejection.

- [ ] **Step 6: Run all touched suites** — `pnpm --filter @breeze/api test -- softwareDeployment software` → PASS. Also `pnpm --filter @breeze/api test -- tenant-export-policy` is integration-only; note for the pre-PR integration run.

- [ ] **Step 7: Commit** — `git commit -m "feat(api): manager-linked deployments (install_method_id, per-platform dispatch)"`

---

### Task 5: Agent — winget ensure-present

**Files:**
- Create: `agent/internal/remote/tools/software_install_manager.go`
- Create: `agent/internal/remote/tools/software_install_manager_test.go`
- Modify: `agent/internal/remote/tools/software_install.go` (branch before the `downloadUrl` requirement)
- Modify: `agent/internal/patching/winget_system.go` (add `IsInstalled`)

**Interfaces:**
- Consumes: payload shape from Task 4; `patching.LocateSystemWinget`, `patching.NewSystemWingetProvider`, `cmdRunner`, `patching.DefaultRunner`; `validateSoftwarePackageID` (`software.go:91`); `CommandResult`/`NewSuccessResult`/`NewErrorResult` (`types.go`).
- Produces:
  - `InstallSoftware` handles `installMethod` payloads (no `downloadUrl`).
  - Error convention consumed by Task 7: when the manager binary is absent, `CommandResult.Error` starts with `manager_unavailable: `.
  - `patching.(*SystemWingetProvider).IsInstalled(id string) (bool, error)` using `winget list --exact --id <id> --scope machine --source winget --accept-source-agreements --disable-interactivity` (exit 0 + id present in output → true; winget exits non-zero on no-match → false, nil).

- [ ] **Step 1: Write failing tests**

`software_install_manager_test.go` — inject a `runner func(name string, args []string, timeout time.Duration) (string, string, int, error)` via the new `installViaManager(payload map[string]any, deps managerDeps) CommandResult` seam so no real process spawns:

```go
type managerDeps struct {
	goos         string
	locateWinget func() (string, string, error)
	run          patching.CmdRunner // exported alias of cmdRunner (add `type CmdRunner = cmdRunner` in patching)
	brewEnsure   func(kind, name, softwareName string) (string, bool, error) // wired in Task 6
}
```

Table cases:
- `installMethod.kind=winget`, `IsInstalled` output contains the id → success JSON with `"alreadyInstalled": true`, no install exec;
- absent → install args exactly `[]string{"install","--exact","--id","Google.Chrome","--scope","machine","--silent","--accept-package-agreements","--accept-source-agreements","--source","winget","--disable-interactivity"}`;
- `versionMode=exact, requestedVersion=1.2.3` → args additionally contain `"--version","1.2.3"`; install exit code 0 but output contains "No package found matching input criteria" → `Status: "failed"` (exact miss never falls back);
- `locateWinget` errors AND not on PATH → `Status: "failed"`, `Error` prefix `manager_unavailable: `;
- invalid packageId (`"bad id"`) → failed, no exec;
- `forceReinstall=true` skips the IsInstalled short-circuit.
Also `winget_system_test.go` additions for `IsInstalled` (match/no-match/exit-1).

- [ ] **Step 2: Run to verify failure** — `cd agent && go test -race ./internal/remote/tools/ ./internal/patching/` → FAIL (undefined symbols).

- [ ] **Step 3: Implement**

In `software_install.go`, immediately before `RequirePayloadString(payload, "downloadUrl")`:

```go
	if _, ok := payload["installMethod"].(map[string]any); ok {
		return installViaManager(payload, defaultManagerDeps())
	}
```

`software_install_manager.go`: parse `installMethod.kind` / `installMethod.packageId` / `versionMode` / `requestedVersion` / `softwareName` / `forceReinstall`; validate packageId per kind (winget → `validateSoftwarePackageID` non-empty variant; brew → mirror `patching` name validation via a small exported helper `patching.ValidateBrewPackageName`); dispatch on kind: winget path requires `deps.goos == "windows"` else `manager_unavailable: winget is Windows-only`; resolve winget path (PATH then `LocateSystemWinget`, mirroring `resolveWingetCommand` at `software_update.go:112`); build provider `patching.NewSystemWingetProvider(path, deps.run)`; `IsInstalled` → success `{"action":"install","success":true,"alreadyInstalled":true,"packageId":id}`; else install (with `--version` appended when exact) via a new provider method `InstallExact(id, version string)` that reuses `systemInstallArgs(id)` + optional version pair — success JSON `{"action":"install","success":true,"packageId":id,"output":<truncated combined>}` through `NewSuccessResult`. Exact-miss detection: winget returns exit code `0x8A150014`/non-zero or the "No package found matching input criteria" string — treat either as failure. All timeouts: `systemWingetInstallTimeout` (600s).

- [ ] **Step 4: Run tests** — `cd agent && go test -race ./internal/remote/tools/ ./internal/patching/` → PASS. Also `go vet ./...`.

- [ ] **Step 5: Commit** — `git commit -m "feat(agent): winget ensure-present install path for software_install"`

---

### Task 6: Agent — Homebrew ensure-present

**Files:**
- Modify: `agent/internal/patching/homebrew.go` (+ `EnsureInstalled` method), `agent/internal/patching/command_limits.go` (export `ValidateBrewPackageName` wrapper)
- Modify: `agent/internal/remote/tools/software_install_manager.go` (wire `brewEnsure`)
- Test: `agent/internal/patching/homebrew_test.go`, `agent/internal/remote/tools/software_install_manager_test.go` (extend)

**Interfaces:**
- Consumes: `brewBinaryPath`, `brewCommand`, `parseBrewID`, `validateBrewPackageName` (all `homebrew.go` / `command_limits.go`).
- Produces: `patching.EnsureBrewInstalled(kind, name string) (output string, alreadyInstalled bool, err error)` — darwin-only (`//go:build darwin`); non-darwin stub returns `manager unavailable` error. `kind` is `'homebrew_cask'|'homebrew_formula'`.

- [ ] **Step 1: Write failing tests** — pure-logic tests in `homebrew_test.go` for the new arg construction (`ensureBrewArgs("homebrew_cask","firefox")` → `["install","--cask","firefox"]`; formula → `["install","firefox"]`) and for `brew list` presence-check arg building (`["list","--cask","--versions","firefox"]` / `["list","--versions","firefox"]`); manager-test additions: brew kind on `goos != "darwin"` → `manager_unavailable: `; brew binary missing (stub `brewEnsure` returning the sentinel error) → `manager_unavailable: `.

- [ ] **Step 2: Run to verify failure** — `cd agent && go test -race ./internal/patching/ ./internal/remote/tools/` → FAIL.

- [ ] **Step 3: Implement**

`EnsureBrewInstalled`: validate name; presence check via `brewCommand("list", maybe "--cask", "--versions", name)` + `runCmdCombinedOutputWithTimeout(cmd, patchListTimeout)` — exit 0 → `(output, true, nil)`, never touch it; absent → `brewCommand("install", maybe "--cask", name)` with `patchMutateTimeout`, `brew install` no-ops safely if racing. Distinguish "brew missing" (`brewBinaryPath` error) by returning a wrapped sentinel `ErrBrewUnavailable = errors.New("homebrew not installed")`; the tools layer maps `errors.Is(err, patching.ErrBrewUnavailable)` → `manager_unavailable: ` prefix. Root handling comes free via `brewCommand` (sudo-as-console-user); surface its `cannot execute brew as root: no active non-root console user` error verbatim (that is a real, actionable failure, not unavailability).

- [ ] **Step 4: Run tests** — PASS; `cd agent && go build ./...` cross-check (darwin + windows files guarded by build tags).

- [ ] **Step 5: Commit** — `git commit -m "feat(agent): homebrew ensure-present (install-only, console-user aware)"`

---

### Task 7: Server-side result honesty (`manager_unavailable`)

**Files:**
- Modify: `apps/api/src/services/softwareDeploymentResult.ts`
- Test: co-located `softwareDeploymentResult.test.ts` (create if absent)

**Interfaces:**
- Consumes: agent `Error` prefix `manager_unavailable: ` (Tasks 5–6).
- Produces: `deployment_results.error_message` normalized to `Package manager unavailable on this device: <rest>` so the web results table can string-match `Package manager unavailable` for badge styling (Task 10 consumes this exact prefix).

- [ ] **Step 1: Failing test** — `applySoftwareInstallResult` with `input.error = 'manager_unavailable: winget.exe not found under WindowsApps'` writes `errorMessage` starting `Package manager unavailable on this device: `; a plain error passes through unchanged; status stays `failed` (no enum change — `deployment_status` enum untouched).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — small transform before the redact call:

```ts
const MANAGER_UNAVAILABLE_PREFIX = 'manager_unavailable: ';
function normalizeInstallError(error: string | null | undefined): string | null | undefined {
  if (error?.startsWith(MANAGER_UNAVAILABLE_PREFIX)) {
    return `Package manager unavailable on this device: ${error.slice(MANAGER_UNAVAILABLE_PREFIX.length)}`;
  }
  return error;
}
```
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): normalize manager_unavailable install errors"`

---

### Task 8: winget index sync + package search endpoint

**Files:**
- Create: `apps/api/migrations/2026-08-16-c-winget-package-index.sql`
- Create: `apps/api/src/db/schema/wingetIndex.ts` (+ barrel export in `schema/index.ts`)
- Create: `apps/api/src/jobs/wingetIndexSyncWorker.ts`
- Create: `apps/api/src/services/packageSearch.ts`
- Create: `apps/api/src/routes/packageSearch.ts` (mounted as `GET /software/package-search` from `software.ts`)
- Modify: `apps/api/src/index.ts` (worker init/shutdown tuple entries, mirroring `cveEnrichmentWorker` at `index.ts:1474` / `:1651`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — add `winget_package_index` to the same global-table allowlist that holds `third_party_package_catalog` (grep for it in the file; it is a platform-global, no-tenant table).
- Tests: `apps/api/src/services/packageSearch.test.ts`, `apps/api/src/jobs/wingetIndexSyncWorker.test.ts`, `apps/api/src/routes/packageSearch.test.ts`

**Interfaces:**
- Produces:
  - Table `winget_package_index`: `id uuid PK`, `package_id varchar(256) UNIQUE NOT NULL`, `vendor_segment varchar(200) NOT NULL`, `name_segment varchar(200) NOT NULL`, `latest_version varchar(128)`, `synced_commit_sha varchar(64) NOT NULL`, `updated_at timestamptz NOT NULL`. RLS enabled+forced with a read-only permissive SELECT policy `USING (true)` and NO insert/update/delete policies (writes happen in system context only) — copy whatever policy shape `third_party_package_catalog`'s migration used (check `2026-05-13-b-third-party-package-catalog.sql` and mirror it).
  - `GET /software/package-search?platform=windows|macos&q=<str>` → `{ results: [{ platform, kind, packageId, name, vendor, latestVersion?, description?, homepageUrl?, breezeTested?: { version: string, testedAt: string } }] }` (Task 9 consumes this exact shape).
  - `searchWingetIndex(q, limit)` and `searchHomebrew(q, limit)` from `services/packageSearch.ts`.

- [ ] **Step 1: Sync job design (implement as written)**

Index from repo *paths*, not manifest contents (IDs are `Vendor.Product`, human-searchable; per-package detail is fetched lazily at import): the GitHub Git Trees API on `microsoft/winget-pkgs` truncates at repo scale, so fetch **26 letter subtrees**: for each letter `l` of `a-z0-9`, `GET https://api.github.com/repos/microsoft/winget-pkgs/git/trees/HEAD:manifests/<l>?recursive=1` (unauthenticated = 60 req/h rate limit → run the 27 fetches once per 24h job with 2s spacing; honor 403 rate-limit responses with the OSV-style typed error + skip-run). Path shape `manifests/g/Google/Chrome/126.0.6478.127/Google.Chrome.installer.yaml` → `package_id = Google.Chrome`, `vendor_segment = Google`, `name_segment = Chrome`, versions = the directory names (compare with a lenient numeric-segment sort; store max as `latest_version`). Upsert by `package_id`; delete rows whose `synced_commit_sha` predates the run only after ALL letters succeeded (generation semantics without a second table). BullMQ worker copied structurally from `cveEnrichmentWorker.ts` (queue `winget-index-sync`, job `sync`, repeat 24h, `runWithSystemDbAccess` guard idiom, `attachWorkerObservability`). Unit tests feed fixture tree JSON into the exported pure function `parseWingetTreePaths(entries: {path: string}[]): Map<string, {vendor, name, versions[]}>`.

- [ ] **Step 2: Homebrew search**

`searchHomebrew(q, limit)`: fetch `https://formulae.brew.sh/api/formula.json` and `https://formulae.brew.sh/api/cask.json` (OSV-style: `AbortSignal.timeout(15_000)`, typed errors), cache each raw body in Redis via the pax8 pattern (`getRedis()`, best-effort try/catch, `setex('pkgsearch:brew:formula', 21600, body)` — 6h TTL) plus the `thirdPartyEnrichment.ts`-style in-process single-flight. Filter client-side on `token`/`name`/`desc` contains-q (case-insensitive), map to `{ platform:'macos', kind: cask? 'homebrew_cask':'homebrew_formula', packageId: token, name, vendor: '', description: desc, homepageUrl: homepage, latestVersion: versions.stable ?? version }`. If the fetch fails and no cache: return `[]` with a `degraded: true` flag in the route response (UI shows manual-entry hint).

- [ ] **Step 3: Route + annotation**

`GET /software/package-search` (auth + `requireScope('organization','partner','system')` + DEVICES_READ, no MFA): `platform=windows` → `searchWingetIndex` (SQL `ILIKE '%q%'` on `package_id`/`name_segment`/`vendor_segment`, limit 25, ordered by `name_segment`); `platform=macos` → `searchHomebrew`. Annotate winget results by joining `third_party_package_catalog` on `package_id` where `breeze_tested = true` → `breezeTested: { version: lastTestedVersion, testedAt: lastTestedAt }` (version-specific evidence, per spec). Route test: query validation (`q` min 2 max 100), shape, annotation join mocked.

- [ ] **Step 4: Run all new tests** — `pnpm --filter @breeze/api test -- packageSearch wingetIndexSync` → PASS. `./scripts/check-migration-naming.sh` → OK.

- [ ] **Step 5: Commit** — `git commit -m "feat(api): winget index sync + /software/package-search"`

Deliberately deferred from this task (recorded in the plan, not silently dropped): shipping a bundled index snapshot for egress-less self-hosted installs — follow-up issue after phase 1; manual ID entry (Task 9) is the degraded path.

---

### Task 9: Web — package-manager source in AddPackageModal

**Files:**
- Modify: `apps/web/src/components/software/AddPackageModal.tsx`
- Create: `apps/web/src/components/software/PackageManagerPicker.tsx`
- Test: `apps/web/src/components/software/PackageManagerPicker.test.tsx`, extend `AddPackageModal.test.tsx`
- Modify: web i18n message files for the `policies:software.addPackageModal.*` namespace (find them by grepping an existing key like `downloadURL`)

**Interfaces:**
- Consumes: `GET /software/package-search` shape (Task 8), `POST /software/catalog/import-package` (Task 3), `fetchWithAuth`, `runAction`.
- Produces: `PackageManagerPicker` props:

```tsx
export interface SelectedPackageMethod {
  platform: 'windows' | 'macos';
  kind: 'winget' | 'homebrew_cask' | 'homebrew_formula';
  packageId: string;
  name?: string; vendor?: string; homepageUrl?: string;
  breezeTested?: { version: string; testedAt: string };
}
interface PackageManagerPickerProps {
  methods: SelectedPackageMethod[];
  onChange: (methods: SelectedPackageMethod[]) => void;
}
```

- [ ] **Step 1: Failing picker tests** — debounced search (mock `fetchWithAuth` route `/software/package-search`), result click adds a method chip, platform tab switch (Windows/macOS), manual-entry fields (kind select + packageId input) validate with the same regexes (duplicate them in a small `apps/web/src/lib/packageIdValidation.ts` with unit tests — do NOT import from the API package), remove chip, `degraded: true` response shows the manual-entry hint.
- [ ] **Step 2: Run** — `pnpm --filter @breeze/web test -- PackageManagerPicker` → FAIL.
- [ ] **Step 3: Implement picker** — search input + per-platform tabs + result rows (name, packageId, vendor, "Breeze tested v{version}" pill when present) + selected-method chips + manual-entry disclosure. All fetches read-only (no runAction needed for GET; use plain `fetchWithAuth` + local error state).
- [ ] **Step 4: Wire into AddPackageModal**

Extend `type Source = "url" | "file" | "manager"` and add a third tablist tuple `["manager", i18n.t("policies:software.addPackageModal.packageManager"), PackageSearch]` at the seam (`AddPackageModal.tsx:551-595`). When `form.source === "manager"`: render `<PackageManagerPicker methods={form.managerMethods} onChange={(m) => update("managerMethods", m)} />`; hide the Version/Architecture row and the Advanced silent-args block (manager installs don't take them); picking a first result prefills `form.name`/`form.vendor` if empty. `handleSubmit` branches: manager source → single `runAction` POST to `/software/catalog/import-package` with `{ name, vendor, category, description, methods: form.managerMethods.map(({platform,kind,packageId}) => ({platform,kind,packageId})) }` (replaces the two-step catalog→version flow; no `createdCatalogId` retry ref needed on this path); validation: at least one method else inline error. Modal test additions: manager flow POSTs import-package once, success closes + `onCreated` fires.

- [ ] **Step 5: Run** — `pnpm --filter @breeze/web test -- AddPackageModal PackageManagerPicker` → PASS; `pnpm --filter @breeze/web exec astro check` (or the repo's web typecheck path) clean.
- [ ] **Step 6: Commit** — `git commit -m "feat(web): package-manager source with in-product search in AddPackageModal"`

---

### Task 10: Web — DeploymentWizard manager deploys

**Files:**
- Modify: `apps/web/src/components/software/DeploymentWizard.tsx`
- Modify: `apps/web/src/components/software/SoftwareCatalog.tsx` (manager badges on cards; items with methods count as deployable)
- Test: extend `DeploymentWizard.preselect.test.tsx` + new `DeploymentWizard.manager.test.tsx`

**Interfaces:**
- Consumes: `GET /software/catalog/:id/install-methods` (Task 2), extended `POST /software/deployments` body (Task 4): `{ name, catalogId, versionMode, requestedVersion?, deploymentType:'install', targetType, targetIds, scheduleType, ... }`; error-message prefix `Package manager unavailable` (Task 7) for results styling.

- [ ] **Step 1: Failing tests** — wizard load also fetches `/software/catalog/:id/install-methods` per item (parallel with the existing versions fetch at `DeploymentWizard.tsx:271`); an item with 0 versions but ≥1 enabled method is selectable; selecting it swaps the version `<select>` for: mode radio `Latest (recommended)` / `Exact version` (exact only rendered when a winget method exists) + version text input when exact; deploy POST body carries `catalogId`/`versionMode`(/`requestedVersion`) and NO `softwareVersionId`; targets step renders the OS-coverage callout (`data-testid="manager-os-coverage"`) when any selected device's `osType` has no enabled method — text like "3 selected Linux devices have no install method and will fail".
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — normalize catalog items to carry `installMethods: {platform, kind, packageId, enabled}[]`; `firstDeployable` predicate becomes `item.versions.length > 0 || item.installMethods.some(m => m.enabled)`; insert the callout immediately after `targetModeToggle` (before the branch at `DeploymentWizard.tsx:885`) computing coverage from `selectedDevices`' `osType` against the selected item's method platforms; payload branch in the deploy submit (`:516-578`). SoftwareCatalog cards: small `winget` / `brew` inline badges when methods exist (fetch piggybacks on the wizard normalization — if the list endpoint doesn't include method info, add a `methodCount`/`methodKinds` aggregation to `GET /software/catalog` in this task, with a route test).
- [ ] **Step 4: Run** — web suite PASS + typecheck clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): deploy manager-linked packages (version mode, OS coverage callout)"`

---

### Task 11: Opt-in Homebrew bootstrap

**Files:**
- Agent: create `agent/internal/remote/tools/homebrew_bootstrap.go` (+`_test.go`), modify `agent/internal/heartbeat/` handler registration (new file `handlers_homebrew_bootstrap.go` mirroring `handlers_software_install.go`), add `CmdHomebrewBootstrap = "homebrew_bootstrap"` to `agent/internal/remote/tools/types.go` next to the other command constants.
- API: create `apps/api/src/routes/devices/homebrewBootstrap.ts` (+test) — `POST /devices/:id/homebrew-bootstrap`, mounted where the other device action routes mount (find the mount point in `apps/api/src/routes/devices/core.ts` or `index.ts`); dispatch via the same command-send path other device actions use (grep for an existing simple action, e.g. how `software_update` or a reboot command is dispatched, and mirror it).
- Web: add a "Install Homebrew" action to the macOS device-detail actions area (locate the actions menu in `apps/web/src/components/DeviceDetails.tsx`), gated to `osType === 'macos'`, confirm-dialog explaining it runs as the signed-in console user, via `runAction`.

**Interfaces:**
- Consumes: `activeConsoleUser`, `brewBinaryPath` (`agent/internal/patching/homebrew.go`), command plumbing.
- Produces: command `homebrew_bootstrap` with payload `{ installerSha256: string, installerUrl: string }` — both come from server constants in `apps/api/src/services/homebrewBootstrap.ts`:

```ts
// Pinned Homebrew installer: a specific tagged release of Homebrew/install,
// fetched from raw.githubusercontent.com at that tag, verified by sha256.
// Update BOTH together, deliberately, in a reviewed PR — never point at a
// moving branch.
export const HOMEBREW_INSTALLER_URL =
  'https://raw.githubusercontent.com/Homebrew/install/<PINNED_TAG>/install.sh';
export const HOMEBREW_INSTALLER_SHA256 = '<sha256-of-that-exact-file>';
```

The implementer MUST resolve `<PINNED_TAG>` to the latest Homebrew/install release tag at build time, download that `install.sh` once, compute its sha256, and hard-code both — with a unit test asserting the constant matches `/^[0-9a-f]{64}$/` and the URL contains a tag path segment (not `HEAD`/`master`).

- [ ] **Step 1: Failing agent tests** — payload missing sha → error; checksum mismatch after download → error, script never executed; brew already present (`brewBinaryPath` succeeds) → success `{"alreadyInstalled": true}` without downloading; no console user → error containing `no active non-root console user`. Structure the function as `BootstrapHomebrew(payload map[string]any, deps bootstrapDeps)` with injectable `download func(url string) ([]byte, error)`, `brewPath func() (string, error)`, `consoleUser func() (*user.User, error)`, `runScript func(scriptPath string, u *user.User) (string, int, error)` so tests never touch the network.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement agent side** — download to a temp file (0700 dir), verify sha256 (reuse the checksum-verify approach from `software_install.go`), then execute `/bin/bash <script>` as the console user with `NONINTERACTIVE=1` env, via the sudo construction mirroring `brewCommand` (`sudo -n -H -u <user> NONINTERACTIVE=1 /bin/bash <path>`), generous timeout (20 min), stream/truncate output with `truncatePatchOutput`-style caps. Success result includes brew's resolved path post-install.
- [ ] **Step 4: API route + web action** — route: device must exist, be in scope, `osType === 'macos'` (400 otherwise), `requireMfa()` + DEVICES_EXECUTE + `writeRouteAudit(action: 'device.homebrew_bootstrap')`; sends the command with the pinned constants. Route test covers the 400 and the dispatch payload. Web: confirm dialog copy — "Installs Homebrew as the currently signed-in user using a pinned, checksum-verified copy of the official installer. Requires an admin console session." Button state disabled for non-macOS.
- [ ] **Step 5: Run all three test surfaces** — agent `go test -race ./internal/...`, `pnpm --filter @breeze/api test -- homebrewBootstrap`, `pnpm --filter @breeze/web test -- DeviceDetails` → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat: opt-in pinned Homebrew bootstrap (agent+api+web)"`

---

### Task 12: Integration tests, contract-suite run, pre-PR sweep

**Files:**
- Create: `apps/api/src/__tests__/integration/softwareInstallMethods.integration.test.ts`
- Modify: none expected (fix whatever this task surfaces)

- [ ] **Step 1: Write the integration suite** (needs real Postgres, follows the existing `*PartnerRls.integration.test.ts` structure — copy the setup from a recent one):
  - cross-tenant forge as `breeze_app`: insert a method under another org's catalog item → `42501` RLS violation;
  - org A cannot SELECT org B's methods;
  - platform/kind CHECK violation → `23514`;
  - unique (catalog, platform, kind) → `23505`;
  - deployment one-target CHECK: both/neither of `software_version_id`/`install_method_id` → `23514`;
  - migration replay: applying `2026-08-16-a`/`-b-`/`-c-` twice is a no-op.
- [ ] **Step 2: Run the contract suites locally** (needs DB; remember the fsync=off tmpfs setup if it looks hung):
  `pnpm --filter @breeze/api test:integration -- softwareInstallMethods tenantCascade tenant-export-policy rls-coverage` (use the actual script names from `apps/api/package.json`).
  Expected: all green — in particular `tenant-export-policy` proves the `software_deployments.install_method_id` classification landed.
- [ ] **Step 3: Full local sweep** — `pnpm --filter @breeze/api test && pnpm --filter @breeze/web test && cd agent && go test -race ./... && cd .. && pnpm lint`.
- [ ] **Step 4: Manual verification against the worktree stack** (worktree-stack skill): import `Google.Chrome` via the modal search, deploy latest to the Windows test VM, confirm `deployment_results` completes and inventory picks it up; deploy to a Linux device and confirm the pre-failed result row.
- [ ] **Step 5: Commit + push branch, open PR** — PR body lists the spec path, the OS-preview narrowing, and the deferred snapshot-for-self-hosted item. Remember: if CI doesn't trigger (stacked/stale base), `gh workflow run CI --ref <branch>`.

---

## Self-review notes (already applied)

- Spec coverage: data model (T1), CRUD+import (T2–3), deploy pipeline + version semantics + per-platform split (T4), agent winget/brew ensure-present with `manager_unavailable` honesty (T5–7), discovery incl. breeze-tested annotation (T8), UI (T9–10), brew bootstrap middle-path (T11), testing (throughout + T12). Spec items consciously narrowed: device-level winget-availability preview (OS-only in v1) and the self-hosted index snapshot (follow-up) — both flagged in Global Constraints / Task 8.
- The per-platform deployment split (one deployment per platform when an item has methods for both) is a plan-level refinement of the spec's "per-device resolution": it keeps `install_method_id` 1:1 and result rows unambiguous.
- Type consistency: payload field names (`installMethod.kind/packageId`, `versionMode`, `requestedVersion`) identical across T4 (producer), T5/T6 (consumer); error prefix `manager_unavailable: ` identical across T5/T6/T7.
