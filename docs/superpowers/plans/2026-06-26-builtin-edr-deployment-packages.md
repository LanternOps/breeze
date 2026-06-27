# Built-in Huntress & SentinelOne Deployment Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-provision partner-scoped built-in Huntress and SentinelOne agent packages into the software deployment library when the integration connects, and inject the correct per-org enrollment key (Huntress org key / S1 site token) into the installer command at deploy-time dispatch.

**Architecture:** `software_catalog` gains a partner axis (nullable `partner_id` + `integration_provider`, dual-axis RLS) so a built-in package is defined once per partner. A code-defined registry describes each built-in; an auto-provision service upserts the catalog/version row on integration connect. At deploy time, a key-resolver service (running in a **system DB context** so it can read the partner-scoped integration secret) substitutes `{huntress_acct_key}`/`{huntress_org_key}`/`{s1_site_token}` placeholders for the deployment's org, or fails the results cleanly when the org is unmapped/disconnected. Deployments stay org-scoped.

**Tech Stack:** Hono + Drizzle (apps/api), PostgreSQL + RLS, BullMQ sync jobs, Astro + React (apps/web), Vitest.

## Global Constraints

- **Windows-only v1.** All built-in versions set `supportedOs: ['windows']`. macOS/Linux are out of scope.
- **Migrations:** hand-written SQL in `apps/api/migrations/`, named `YYYY-MM-DD-<slug>.sql`, idempotent (`IF NOT EXISTS` / `DO $$` / `pg_policies` checks), no inner `BEGIN;`/`COMMIT;`, never edit a shipped migration. RLS policies ship in the **same migration** that adds the columns.
- **RLS:** API runs as unprivileged `breeze_app`. Every tenant-scoped table needs RLS enabled + forced + policies. New/changed tenancy shape must be reflected in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` in the same PR.
- **Secrets:** encrypt with `encryptSecret(value, { aad })` / `decryptForColumn(table, column, value)` from `apps/api/src/services/secretCrypto.ts` (AAD = `table.column`). Never log or return decrypted keys to the web client.
- **DB context:** request paths use `withDbAccessContext`; cross-scope/background reads use `withSystemDbAccessContext` and must call `runOutsideDbContext` first when already inside a request context. Bare pool forbidden in request code.
- **Web mutations:** wrap POST/PUT/PATCH/DELETE in `runAction` (`apps/web/src/lib/runAction.ts`).
- **Provider string values:** `'huntress'` and `'sentinelone'` (exact, lowercase) everywhere — DB column, registry keys, resolver switch, web badge logic.
- **Deploy scope:** each `software_deployments` row is single-org (the resolved `orgId`). Multi-org batch deploy is a non-goal; a partner deploys per-org.

---

## File Structure

**Create:**
- `apps/api/migrations/2026-06-26-a-software-catalog-partner-axis.sql` — partner_id/integration_provider columns + dual-axis RLS.
- `apps/api/migrations/2026-06-26-b-s1-org-mappings-registration-token.sql` — encrypted registration_token column.
- `apps/api/src/services/builtinDeploymentPackages.ts` — code-defined registry + auto-provision upsert.
- `apps/api/src/services/builtinDeploymentPackages.test.ts`
- `apps/api/src/services/edrInstallerResolver.ts` — deploy-time key/URL resolver.
- `apps/api/src/services/edrInstallerResolver.test.ts`

**Modify:**
- `apps/api/src/db/schema/software.ts` — `softwareCatalog` columns.
- `apps/api/src/db/schema/sentinelOne.ts` — `s1OrgMappings.registrationToken`.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — allowlist.
- `apps/api/src/routes/huntress.ts` — call auto-provision after integration upsert.
- `apps/api/src/routes/sentinelOne.ts` — call auto-provision after integration upsert.
- `apps/api/src/routes/software.ts` — resolver wired into both deploy handlers.
- `apps/api/src/routes/software.ts` (GET /catalog) — return `partnerId` + `integrationProvider`.
- `apps/api/src/services/sentinelOneClient.ts` (or `huntressClient.ts` sibling) — `listSites()` with `registrationToken`.
- `apps/api/src/jobs/s1Sync.ts` — capture registration token into mapping upsert.
- `apps/web/src/components/software/SoftwareCatalog.tsx` — badge, read-only, deploy-disabled.
- `apps/web/src/components/software/DeploymentWizard.tsx` — wrap deploy POST in `runAction` (consistency).

---

## Phase 1 — Catalog partner axis foundation

### Task 1: Migrate `software_catalog` to dual-axis + update Drizzle schema

**Files:**
- Create: `apps/api/migrations/2026-06-26-a-software-catalog-partner-axis.sql`
- Modify: `apps/api/src/db/schema/software.ts:22-38`

**Interfaces:**
- Produces: `software_catalog.partner_id uuid NULL`, `software_catalog.integration_provider varchar(20) NULL`; `org_id` now nullable; dual-axis RLS policies `software_catalog_dual_isolation_{select,insert,update,delete}`.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-26-a-software-catalog-partner-axis.sql`:

```sql
-- Software catalog: add a partner axis so built-in (integration) packages are
-- defined once per partner, while existing custom packages stay org-scoped.
-- Exactly one of (org_id, partner_id) is set. Dual-axis RLS like users/configuration_policies.

ALTER TABLE software_catalog
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE software_catalog
  ADD COLUMN IF NOT EXISTS integration_provider varchar(20);

-- org_id was NOT NULL; partner-scoped built-ins must allow NULL org_id.
ALTER TABLE software_catalog
  ALTER COLUMN org_id DROP NOT NULL;

-- Exactly one ownership axis must be set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'software_catalog_one_owner_chk'
      AND conrelid = 'software_catalog'::regclass
  ) THEN
    ALTER TABLE software_catalog
      ADD CONSTRAINT software_catalog_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS software_catalog_partner_id_idx
  ON software_catalog(partner_id);
CREATE INDEX IF NOT EXISTS software_catalog_partner_provider_idx
  ON software_catalog(partner_id, integration_provider);

-- One built-in package per (partner, provider).
CREATE UNIQUE INDEX IF NOT EXISTS software_catalog_partner_provider_unique_idx
  ON software_catalog(partner_id, integration_provider)
  WHERE integration_provider IS NOT NULL;

-- Dual-axis RLS: org members see org packages; partner admins see partner built-ins.
-- Drop the baseline org-only policies (from 0001-baseline.sql) so they don't linger
-- alongside the new dual-axis policies.
DROP POLICY IF EXISTS breeze_org_isolation_select ON software_catalog;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON software_catalog;
DROP POLICY IF EXISTS breeze_org_isolation_update ON software_catalog;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON software_catalog;

DROP POLICY IF EXISTS software_catalog_dual_isolation_select ON software_catalog;
DROP POLICY IF EXISTS software_catalog_dual_isolation_insert ON software_catalog;
DROP POLICY IF EXISTS software_catalog_dual_isolation_update ON software_catalog;
DROP POLICY IF EXISTS software_catalog_dual_isolation_delete ON software_catalog;

ALTER TABLE software_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE software_catalog FORCE ROW LEVEL SECURITY;

CREATE POLICY software_catalog_dual_isolation_select ON software_catalog
  FOR SELECT USING (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
CREATE POLICY software_catalog_dual_isolation_insert ON software_catalog
  FOR INSERT WITH CHECK (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
CREATE POLICY software_catalog_dual_isolation_update ON software_catalog
  FOR UPDATE USING (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
CREATE POLICY software_catalog_dual_isolation_delete ON software_catalog
  FOR DELETE USING (
    (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );
```

> NOTE (resolved in pre-flight): `software_catalog` already has baseline org-only policies named `breeze_org_isolation_{select,insert,update,delete}` (from `0001-baseline.sql`). The migration above drops them explicitly so only the dual-axis policies remain. No other policy names exist on this table.

- [ ] **Step 2: Update the Drizzle schema**

In `apps/api/src/db/schema/software.ts`, change the `softwareCatalog` definition (lines 22-38). Make `orgId` nullable and add the two columns + indexes:

```typescript
import { partners } from './orgs'; // add partners to the existing orgs import

export const softwareCatalog = pgTable('software_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  integrationProvider: varchar('integration_provider', { length: 20 }),
  name: varchar('name', { length: 200 }).notNull(),
  vendor: varchar('vendor', { length: 200 }),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  iconUrl: text('icon_url'),
  websiteUrl: text('website_url'),
  isManaged: boolean('is_managed').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdx: index('software_catalog_org_id_idx').on(table.orgId),
  partnerIdx: index('software_catalog_partner_id_idx').on(table.partnerId),
  partnerProviderIdx: index('software_catalog_partner_provider_idx').on(table.partnerId, table.integrationProvider),
  nameIdx: index('software_catalog_name_idx').on(table.name),
  vendorIdx: index('software_catalog_vendor_idx').on(table.vendor),
  categoryIdx: index('software_catalog_category_idx').on(table.category)
}));
```

(`organizations` is already imported at line 16; add `partners` to that same import line.)

- [ ] **Step 3: Apply migration locally and verify drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && npx vitest run src/db/autoMigrate.test.ts
pnpm --filter @breeze/api exec drizzle-kit check
```
Expected: migration ordering test passes; `drizzle-kit check` reports no drift between schema and migrations.

- [ ] **Step 4: Verify isolation as `breeze_app`**

Run:
```bash
docker exec -i breeze-postgres psql -U breeze_app -d breeze -c \
  "INSERT INTO software_catalog (org_id, partner_id, name) VALUES (NULL, NULL, 'bad');"
```
Expected: FAILS with check constraint violation (`software_catalog_one_owner_chk`). A both-null and a both-set insert must both fail.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-26-a-software-catalog-partner-axis.sql apps/api/src/db/schema/software.ts
git commit -m "feat(software): add partner axis + dual-axis RLS to software_catalog"
```

---

### Task 2: Register `software_catalog` as dual-axis in the RLS contract test

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:195-222`

**Interfaces:**
- Consumes: `DUAL_AXIS_TENANT_TABLES` set from Task 1's table.

- [ ] **Step 1: Add the table to the dual-axis allowlist**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, add `software_catalog` to the `DUAL_AXIS_TENANT_TABLES` set (after `'configuration_policies',`):

```typescript
const DUAL_AXIS_TENANT_TABLES: ReadonlySet<string> = new Set<string>([
  'users',
  'deployment_invites',
  'access_reviews',
  'custom_field_definitions',
  'client_ai_prompt_templates',
  'configuration_policies',
  'software_catalog',
]);
```

- [ ] **Step 2: Run the RLS coverage contract test**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS. `software_catalog` is recognized as dual-axis; no "table missing RLS policy / not in allowlist" failure.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(rls): register software_catalog as dual-axis tenant table"
```

---

## Phase 2 — Built-in registry + Huntress (reference path)

### Task 3: Built-in deployment package registry

**Files:**
- Create: `apps/api/src/services/builtinDeploymentPackages.ts`
- Test: `apps/api/src/services/builtinDeploymentPackages.test.ts`

**Interfaces:**
- Produces:
  - `type BuiltinProvider = 'huntress' | 'sentinelone'`
  - `interface BuiltinPackageDef { provider: BuiltinProvider; name: string; vendor: string; category: string; iconUrl?: string; websiteUrl?: string; fileType: string; supportedOs: string[]; downloadUrlTemplate?: string; silentInstallArgsTemplate: string; requiresBinaryUpload: boolean; }`
  - `const BUILTIN_PACKAGES: Record<BuiltinProvider, BuiltinPackageDef>`
  - `function getBuiltinPackage(provider: BuiltinProvider): BuiltinPackageDef`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/builtinDeploymentPackages.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BUILTIN_PACKAGES, getBuiltinPackage } from './builtinDeploymentPackages';

describe('builtin deployment packages', () => {
  it('defines a Windows-only Huntress package with derivable URL + keys', () => {
    const pkg = getBuiltinPackage('huntress');
    expect(pkg.vendor).toBe('Huntress');
    expect(pkg.fileType).toBe('exe');
    expect(pkg.supportedOs).toEqual(['windows']);
    expect(pkg.requiresBinaryUpload).toBe(false);
    expect(pkg.downloadUrlTemplate).toContain('{huntress_acct_key}');
    expect(pkg.silentInstallArgsTemplate).toContain('{huntress_acct_key}');
    expect(pkg.silentInstallArgsTemplate).toContain('{huntress_org_key}');
  });

  it('defines a SentinelOne package that needs a binary upload and a site token', () => {
    const pkg = getBuiltinPackage('sentinelone');
    expect(pkg.vendor).toBe('SentinelOne');
    expect(pkg.fileType).toBe('msi');
    expect(pkg.supportedOs).toEqual(['windows']);
    expect(pkg.requiresBinaryUpload).toBe(true);
    expect(pkg.silentInstallArgsTemplate).toContain('{s1_site_token}');
  });

  it('exposes both providers', () => {
    expect(Object.keys(BUILTIN_PACKAGES).sort()).toEqual(['huntress', 'sentinelone']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/builtinDeploymentPackages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

Create `apps/api/src/services/builtinDeploymentPackages.ts`:

```typescript
export type BuiltinProvider = 'huntress' | 'sentinelone';

export interface BuiltinPackageDef {
  provider: BuiltinProvider;
  name: string;
  vendor: string;
  category: string;
  iconUrl?: string;
  websiteUrl?: string;
  fileType: string;
  supportedOs: string[];
  /** Templated download URL; undefined when the binary must be uploaded. */
  downloadUrlTemplate?: string;
  silentInstallArgsTemplate: string;
  requiresBinaryUpload: boolean;
}

export const BUILTIN_PACKAGES: Record<BuiltinProvider, BuiltinPackageDef> = {
  huntress: {
    provider: 'huntress',
    name: 'Huntress EDR Agent',
    vendor: 'Huntress',
    category: 'security',
    websiteUrl: 'https://www.huntress.com',
    fileType: 'exe',
    supportedOs: ['windows'],
    downloadUrlTemplate:
      'https://update.huntress.io/download/{huntress_acct_key}/HuntressInstaller.exe',
    silentInstallArgsTemplate:
      '/ACCT_KEY="{huntress_acct_key}" /ORG_KEY="{huntress_org_key}" /S',
    requiresBinaryUpload: false,
  },
  sentinelone: {
    provider: 'sentinelone',
    name: 'SentinelOne Agent',
    vendor: 'SentinelOne',
    category: 'security',
    websiteUrl: 'https://www.sentinelone.com',
    fileType: 'msi',
    supportedOs: ['windows'],
    silentInstallArgsTemplate: 'SITE_TOKEN={s1_site_token} /q /NORESTART',
    requiresBinaryUpload: true,
  },
};

export function getBuiltinPackage(provider: BuiltinProvider): BuiltinPackageDef {
  return BUILTIN_PACKAGES[provider];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/builtinDeploymentPackages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/builtinDeploymentPackages.ts apps/api/src/services/builtinDeploymentPackages.test.ts
git commit -m "feat(software): code-defined built-in EDR package registry"
```

---

### Task 4: Auto-provision service + hook into Huntress connect

**Files:**
- Modify: `apps/api/src/services/builtinDeploymentPackages.ts`
- Modify: `apps/api/src/services/builtinDeploymentPackages.test.ts`
- Modify: `apps/api/src/routes/huntress.ts` (after the integration upsert, ~line 461)

**Interfaces:**
- Produces: `async function ensureBuiltinPackage(params: { provider: BuiltinProvider; partnerId: string }): Promise<{ catalogId: string }>` — idempotent upsert of the partner-scoped `software_catalog` row, and (when `!requiresBinaryUpload`) a single `software_versions` row carrying the templated `downloadUrl` + `silentInstallArgs`. Runs in a system DB context.
- Consumes: `getBuiltinPackage` (Task 3); `softwareCatalog`, `softwareVersions` schema; `withSystemDbAccessContext`, `runOutsideDbContext` from `../db`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/builtinDeploymentPackages.test.ts`:

```typescript
import { ensureBuiltinPackage } from './builtinDeploymentPackages';
import { db } from '../db';
import { softwareCatalog, softwareVersions } from '../db/schema';
import { and, eq } from 'drizzle-orm';

// Integration-style test: requires the test DB. Uses a seeded partner id.
describe('ensureBuiltinPackage (db)', () => {
  const partnerId = '00000000-0000-0000-0000-0000000000aa'; // seeded in test fixtures

  it('is idempotent: two calls yield one catalog row + one version for huntress', async () => {
    const first = await ensureBuiltinPackage({ provider: 'huntress', partnerId });
    const second = await ensureBuiltinPackage({ provider: 'huntress', partnerId });
    expect(second.catalogId).toBe(first.catalogId);

    const rows = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.partnerId, partnerId), eq(softwareCatalog.integrationProvider, 'huntress')));
    expect(rows).toHaveLength(1);

    const versions = await db.select().from(softwareVersions)
      .where(eq(softwareVersions.catalogId, first.catalogId));
    expect(versions).toHaveLength(1);
    expect(versions[0].downloadUrl).toContain('{huntress_acct_key}');
    expect(versions[0].silentInstallArgs).toContain('{huntress_org_key}');
  });

  it('creates a catalog row but NO version for sentinelone (needs upload)', async () => {
    const { catalogId } = await ensureBuiltinPackage({ provider: 'sentinelone', partnerId });
    const versions = await db.select().from(softwareVersions)
      .where(eq(softwareVersions.catalogId, catalogId));
    expect(versions).toHaveLength(0);
  });
});
```

> This test hits the DB. Place run instructions in Step 2; if the repo's unit `vitest.config.ts` excludes DB tests, move this `describe` to a `*.integration.test.ts` sibling and run via `vitest.integration.config.ts`. Follow the existing convention used by `s1Sync` tests.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/builtinDeploymentPackages.test.ts`
Expected: FAIL — `ensureBuiltinPackage` is not exported.

- [ ] **Step 3: Implement `ensureBuiltinPackage`**

Append to `apps/api/src/services/builtinDeploymentPackages.ts`:

```typescript
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { softwareCatalog, softwareVersions } from '../db/schema';

/**
 * Idempotently upsert the partner-scoped built-in package (and its templated
 * version, when the binary URL is derivable). Safe to call on every integration
 * connect. Runs in a system DB context because the caller's request scope is
 * partner-level and we are writing a partner-axis row.
 */
export async function ensureBuiltinPackage(params: {
  provider: BuiltinProvider;
  partnerId: string;
}): Promise<{ catalogId: string }> {
  const def = getBuiltinPackage(params.provider);

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const existing = await db
        .select({ id: softwareCatalog.id })
        .from(softwareCatalog)
        .where(and(
          eq(softwareCatalog.partnerId, params.partnerId),
          eq(softwareCatalog.integrationProvider, params.provider),
        ))
        .limit(1);

      let catalogId = existing[0]?.id;
      if (!catalogId) {
        const [row] = await db.insert(softwareCatalog).values({
          orgId: null,
          partnerId: params.partnerId,
          integrationProvider: params.provider,
          name: def.name,
          vendor: def.vendor,
          category: def.category,
          iconUrl: def.iconUrl ?? null,
          websiteUrl: def.websiteUrl ?? null,
          isManaged: true,
        }).returning({ id: softwareCatalog.id });
        catalogId = row.id;
      }

      // Templated version only when the binary URL is derivable (Huntress).
      if (!def.requiresBinaryUpload && def.downloadUrlTemplate) {
        const versions = await db
          .select({ id: softwareVersions.id })
          .from(softwareVersions)
          .where(eq(softwareVersions.catalogId, catalogId))
          .limit(1);
        if (versions.length === 0) {
          await db.insert(softwareVersions).values({
            catalogId,
            version: 'latest',
            downloadUrl: def.downloadUrlTemplate,
            fileType: def.fileType,
            originalFileName: 'HuntressInstaller.exe',
            supportedOs: def.supportedOs,
            silentInstallArgs: def.silentInstallArgsTemplate,
            isLatest: true,
          });
        }
      }

      return { catalogId };
    })
  );
}
```

> If `withSystemDbAccessContext` / `runOutsideDbContext` are not both exported from `../db`, import them from their actual module (`../db/index`). Confirm exact export names before implementing.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/builtinDeploymentPackages.test.ts`
Expected: PASS.

- [ ] **Step 5: Hook into the Huntress connect handler**

In `apps/api/src/routes/huntress.ts`, add the import near the other service imports:

```typescript
import { ensureBuiltinPackage } from '../services/builtinDeploymentPackages';
```

In `POST /integration`, after `if (!integration) { return ...; }` and before the sync-scheduling block (~line 432), add:

```typescript
// Provision (or reveal) the built-in Huntress deployment package for this partner.
try {
  await ensureBuiltinPackage({ provider: 'huntress', partnerId: integration.partnerId });
} catch (error) {
  console.error('[huntress] failed to provision built-in deployment package:', error);
  captureException(error instanceof Error ? error : new Error(String(error)));
  // Non-fatal: integration is saved; the package can be re-provisioned on next connect.
}
```

- [ ] **Step 6: Run the Huntress route tests**

Run: `cd apps/api && npx vitest run src/routes/huntress.test.ts`
Expected: PASS (existing tests unaffected; provisioning is best-effort).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/builtinDeploymentPackages.ts apps/api/src/services/builtinDeploymentPackages.test.ts apps/api/src/routes/huntress.ts
git commit -m "feat(software): auto-provision built-in Huntress package on connect"
```

---

### Task 5: Deploy-time key resolver (Huntress)

**Files:**
- Create: `apps/api/src/services/edrInstallerResolver.ts`
- Test: `apps/api/src/services/edrInstallerResolver.test.ts`

**Interfaces:**
- Produces:
  - `interface ResolvedInstaller { downloadUrl: string | null; silentInstallArgs: string | null; }`
  - `type EdrResolveError = { error: string }`
  - `async function resolveEdrInstaller(params: { provider: BuiltinProvider; orgId: string; downloadUrlTemplate: string | null; silentInstallArgsTemplate: string | null; }): Promise<ResolvedInstaller | EdrResolveError>` — reads the partner integration + org mapping in a **system DB context**, substitutes placeholders for the given org. Returns `{ error }` (no throw) when the org is unmapped, the integration is inactive, or a required key is missing.
- Consumes: `huntressIntegrations`, `huntressOrgMappings` schema; `decryptForColumn`; `withSystemDbAccessContext`, `runOutsideDbContext`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/edrInstallerResolver.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer so this is a pure unit test of the substitution + guard logic.
const mockMapping = vi.fn();
const mockIntegration = vi.fn();
vi.mock('../db', () => ({
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  db: {},
}));
vi.mock('./edrInstallerResolver.queries', () => ({
  loadHuntressContext: (...args: unknown[]) => mockMapping(...args),
}));

import { substituteHuntress } from './edrInstallerResolver';

describe('substituteHuntress', () => {
  it('replaces account + org key placeholders', () => {
    const out = substituteHuntress(
      { downloadUrlTemplate: 'https://u/{huntress_acct_key}/x.exe',
        silentInstallArgsTemplate: '/ACCT_KEY="{huntress_acct_key}" /ORG_KEY="{huntress_org_key}" /S' },
      { acctKey: 'ACCT123', orgKey: 'org-abc' },
    );
    expect(out.downloadUrl).toBe('https://u/ACCT123/x.exe');
    expect(out.silentInstallArgs).toBe('/ACCT_KEY="ACCT123" /ORG_KEY="org-abc" /S');
  });
});
```

> The full `resolveEdrInstaller` DB path is exercised by an integration test added in Task 6's wiring; here we unit-test the pure substitution helper `substituteHuntress`, which keeps the secret-injection logic independently testable.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/edrInstallerResolver.test.ts`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Implement the resolver**

Create `apps/api/src/services/edrInstallerResolver.ts`:

```typescript
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { huntressIntegrations, huntressOrgMappings } from '../db/schema';
import { decryptForColumn } from './secretCrypto';
import type { BuiltinProvider } from './builtinDeploymentPackages';

export interface ResolvedInstaller {
  downloadUrl: string | null;
  silentInstallArgs: string | null;
}
export type EdrResolveError = { error: string };

/** Pure substitution — kept separate so it is unit-testable without a DB. */
export function substituteHuntress(
  templates: { downloadUrlTemplate: string | null; silentInstallArgsTemplate: string | null },
  keys: { acctKey: string; orgKey: string },
): ResolvedInstaller {
  const apply = (s: string | null) =>
    s == null ? null : s
      .replaceAll('{huntress_acct_key}', keys.acctKey)
      .replaceAll('{huntress_org_key}', keys.orgKey);
  return {
    downloadUrl: apply(templates.downloadUrlTemplate),
    silentInstallArgs: apply(templates.silentInstallArgsTemplate),
  };
}

export async function resolveEdrInstaller(params: {
  provider: BuiltinProvider;
  orgId: string;
  downloadUrlTemplate: string | null;
  silentInstallArgsTemplate: string | null;
}): Promise<ResolvedInstaller | EdrResolveError> {
  if (params.provider === 'huntress') return resolveHuntress(params);
  return resolveSentinelOne(params); // implemented in Task 11
}

async function resolveHuntress(params: {
  orgId: string;
  downloadUrlTemplate: string | null;
  silentInstallArgsTemplate: string | null;
}): Promise<ResolvedInstaller | EdrResolveError> {
  // System context: the integration row is partner-axis and unreadable under
  // an org-scoped request context (partner read needs system context).
  const ctx = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [mapping] = await db
        .select({
          orgKey: huntressOrgMappings.huntressOrgKey,
          integrationId: huntressOrgMappings.integrationId,
        })
        .from(huntressOrgMappings)
        .where(eq(huntressOrgMappings.orgId, params.orgId))
        .limit(1);
      if (!mapping) return { kind: 'unmapped' as const };

      const [integration] = await db
        .select({
          accountId: huntressIntegrations.accountId,
          apiKeyEncrypted: huntressIntegrations.apiKeyEncrypted,
          isActive: huntressIntegrations.isActive,
        })
        .from(huntressIntegrations)
        .where(eq(huntressIntegrations.id, mapping.integrationId))
        .limit(1);
      if (!integration || !integration.isActive) return { kind: 'inactive' as const };

      return { kind: 'ok' as const, mapping, integration };
    })
  );

  if (ctx.kind === 'unmapped') return { error: 'Organization not mapped to Huntress' };
  if (ctx.kind === 'inactive') return { error: 'Huntress integration is disconnected' };

  // The Huntress Account Key used in the download URL and /ACCT_KEY.
  // VERIFICATION (spec open question 4b): confirm whether accountId is the deploy
  // account key, or whether a dedicated decrypted field must be used here.
  const acctKey = ctx.integration.accountId;
  const orgKey = ctx.mapping.orgKey;
  if (!acctKey) return { error: 'Huntress account key not available; reconnect the integration' };
  if (!orgKey) return { error: 'Huntress org key not synced; run Sync in Integrations' };

  return substituteHuntress(
    { downloadUrlTemplate: params.downloadUrlTemplate, silentInstallArgsTemplate: params.silentInstallArgsTemplate },
    { acctKey, orgKey },
  );
}

// Placeholder until Task 11 implements it.
async function resolveSentinelOne(_params: {
  orgId: string;
  downloadUrlTemplate: string | null;
  silentInstallArgsTemplate: string | null;
}): Promise<ResolvedInstaller | EdrResolveError> {
  return { error: 'SentinelOne resolution not yet implemented' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/edrInstallerResolver.test.ts`
Expected: PASS. (Remove the unused `./edrInstallerResolver.queries` mock if your final structure doesn't split queries; the test's `substituteHuntress` cases are the gate.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/edrInstallerResolver.ts apps/api/src/services/edrInstallerResolver.test.ts
git commit -m "feat(software): deploy-time Huntress installer key resolver"
```

---

### Task 6: Wire resolver into the deploy dispatch path

**Files:**
- Modify: `apps/api/src/routes/software.ts` (POST `/deployments` ~1066-1106; POST `/deploy` ~1223-1262)
- Test: `apps/api/src/routes/software.test.ts`

**Interfaces:**
- Consumes: `resolveEdrInstaller` (Task 5); `softwareCatalog.integrationProvider`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/software.test.ts` a test that deploying a built-in package whose org is **unmapped** marks results `failed` and sends **no** agent command. Use the existing test harness/mocks in that file (mock `sendCommandToAgent` and assert it was not called):

```typescript
it('built-in deploy to an unmapped org fails results without dispatching', async () => {
  // Arrange: a software_versions row whose catalog has integration_provider='huntress'
  // and no huntress_org_mapping for the target org. (Use the file's existing
  // catalog/version/device seeding helpers.)
  // Act: POST /software/deployments targeting a device in that org.
  // Assert:
  expect(sendCommandToAgentMock).not.toHaveBeenCalled();
  // and the inserted deployment_results rows have status 'failed' with the
  // "Organization not mapped to Huntress" message.
});
```

> Follow the mocking style already present in `software.test.ts` (Drizzle mock + `sendCommandToAgent` spy). If that file mocks the DB rather than using a real one, assert on the captured `deploymentResults` insert/update values instead of querying.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/software.test.ts`
Expected: FAIL — currently the deploy path ignores `integrationProvider` and still dispatches.

- [ ] **Step 3: Implement the wiring in POST `/deployments`**

In `apps/api/src/routes/software.ts`, add the import:

```typescript
import { resolveEdrInstaller, type EdrResolveError } from '../services/edrInstallerResolver';
```

The deploy handler already loads `catalogItem` and `versionRecord` and computes `downloadUrl`. Ensure the catalog select includes `integrationProvider` (add `integrationProvider: softwareCatalog.integrationProvider` to the `catalogItem` select). Then, immediately **before** the `for (const device of targetDevices)` dispatch loop (~line 1091), insert:

```typescript
// Built-in EDR packages: resolve per-org keys server-side. Templates live on the
// version row (downloadUrl / silentInstallArgs). On any resolution failure, mark
// every result failed and skip dispatch — never send a broken installer.
let resolvedInstaller: { downloadUrl: string | null; silentInstallArgs: string | null } | null = null;
if (catalogItem.integrationProvider === 'huntress' || catalogItem.integrationProvider === 'sentinelone') {
  const resolved = await resolveEdrInstaller({
    provider: catalogItem.integrationProvider,
    orgId,
    downloadUrlTemplate: versionRecord.downloadUrl,
    silentInstallArgsTemplate: versionRecord.silentInstallArgs,
  });
  if ('error' in resolved) {
    await db.update(deploymentResults)
      .set({ status: 'failed', errorMessage: (resolved as EdrResolveError).error, completedAt: new Date() })
      .where(eq(deploymentResults.deploymentId, deployment!.id));
    return c.json({ data: { id: deployment!.id, status: 'failed', message: (resolved as EdrResolveError).error } }, 200);
  }
  resolvedInstaller = resolved;
}
```

Then in the command payload (lines 1095-1102), use the resolved values when present:

```typescript
payload: {
  deploymentId: deployment!.id,
  downloadUrl: resolvedInstaller?.downloadUrl ?? downloadUrl,
  checksum: versionRecord.checksum,
  fileName: versionRecord.originalFileName ?? `package.${versionRecord.fileType ?? 'exe'}`,
  fileType: versionRecord.fileType ?? 'exe',
  silentInstallArgs: resolvedInstaller?.silentInstallArgs ?? versionRecord.silentInstallArgs,
  softwareName: catalogItem.name,
  version: versionRecord.version,
},
```

- [ ] **Step 4: Mirror the wiring in POST `/deploy`**

Apply the identical block to the legacy `/deploy` handler (resolution before its dispatch loop ~line 1246, and the same payload swap ~lines 1252-1259). The `catalogItem`/`versionRecord`/`orgId`/`downloadUrl` variables exist there too.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/software.test.ts`
Expected: PASS — unmapped built-in deploy fails results, no dispatch; normal (non-built-in) deploys still dispatch unchanged.

- [ ] **Step 6: Also surface `integrationProvider`/`partnerId` in GET /catalog**

In the `GET /catalog` select (~line 405) add `partnerId: softwareCatalog.partnerId` and `integrationProvider: softwareCatalog.integrationProvider` to the returned columns, so the web layer can render the badge and gate deploys.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/software.ts apps/api/src/routes/software.test.ts
git commit -m "feat(software): inject per-org EDR keys at deploy dispatch; fail cleanly when unmapped"
```

---

### Task 7: Web — built-in badge, read-only, deploy-disabled

**Files:**
- Modify: `apps/web/src/components/software/SoftwareCatalog.tsx` (type ~17-24; fetch map ~67-74; card ~242-298; detail delete ~368-385)
- Test: `apps/web/src/components/software/SoftwareCatalog.test.tsx`

**Interfaces:**
- Consumes: GET /catalog now returns `partnerId`, `integrationProvider`.

- [ ] **Step 1: Write the failing test**

Create/extend `apps/web/src/components/software/SoftwareCatalog.test.tsx` (jsdom):

```typescript
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import SoftwareCatalog from './SoftwareCatalog';

// Mock fetchWithAuth to return one built-in huntress package.
vi.mock('../../lib/api', () => ({
  fetchWithAuth: vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: [{
      id: 'p1', name: 'Huntress EDR Agent', vendor: 'Huntress',
      category: 'security', description: '', createdAt: '',
      integrationProvider: 'huntress', partnerId: 'pp1',
    }] }),
  })),
}));

describe('SoftwareCatalog built-in packages', () => {
  it('shows a Built-in · Huntress badge and hides Delete', async () => {
    render(<SoftwareCatalog />);
    expect(await screen.findByText(/Built-in · Huntress/i)).toBeInTheDocument();
    // Built-in cards must not expose a Delete control.
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });
});
```

> Match the real import path/name of `fetchWithAuth` used in `SoftwareCatalog.tsx`. Adjust the mock module path accordingly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/software/SoftwareCatalog.test.tsx`
Expected: FAIL — no badge rendered.

- [ ] **Step 3: Extend the type and fetch mapping**

In `SoftwareCatalog.tsx`, extend `SoftwareItem` (lines 17-24):

```typescript
type SoftwareItem = {
  id: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  createdAt: string;
  integrationProvider?: string;
  partnerId?: string;
};
```

In `fetchCatalog`'s map (lines 67-74), carry the new fields:

```typescript
integrationProvider: item.integrationProvider ? String(item.integrationProvider) : undefined,
partnerId: item.partnerId ? String(item.partnerId) : undefined,
```

- [ ] **Step 4: Render the badge + gate the controls**

Add a helper near the top of the component:

```typescript
const providerLabel = (p?: string) =>
  p === 'huntress' ? 'Huntress' : p === 'sentinelone' ? 'SentinelOne' : null;
```

In the card (after the category span ~line 267), render the badge when built-in:

```tsx
{providerLabel(item.integrationProvider) && (
  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
    Built-in · {providerLabel(item.integrationProvider)}
  </span>
)}
```

Wrap the detail-modal Delete button (lines 368-375) so it's hidden for built-ins:

```tsx
{!selectedSoftware?.integrationProvider && (
  /* existing Delete button */
)}
```

For the Deploy buttons (card ~284-293 and detail ~376-385), disable when built-in and there's no version yet (SentinelOne-before-upload) — for Huntress the version always exists. Gate on a simple rule for v1: built-in packages are deployable; disconnected-integration gating is enforced server-side (Task 6) and the result surfaces via `runAction`. Add a tooltip title:

```tsx
title={item.integrationProvider ? 'Deploys to mapped organizations only' : undefined}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/software/SoftwareCatalog.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/software/SoftwareCatalog.tsx apps/web/src/components/software/SoftwareCatalog.test.tsx
git commit -m "feat(web): built-in EDR package badge + read-only catalog rows"
```

---

## Phase 3 — SentinelOne

### Task 8: S1 client `listSites()` + `registration_token` column

**Files:**
- Create: `apps/api/migrations/2026-06-26-b-s1-org-mappings-registration-token.sql`
- Modify: `apps/api/src/db/schema/sentinelOne.ts:104-126`
- Modify: `apps/api/src/services/sentinelOneClient.ts` (add `listSites`)
- Test: `apps/api/src/services/sentinelOneClient.test.ts`

**Interfaces:**
- Produces:
  - `s1_org_mappings.registration_token text NULL` (stores encrypted token).
  - `S1Site` interface `{ siteId: string; siteName: string | null; registrationToken: string | null }` and `client.listSites(): Promise<S1Site[]>`.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-26-b-s1-org-mappings-registration-token.sql`:

```sql
-- Store the SentinelOne site registration token (deploy token) per mapped org.
-- Encrypted at the application layer via secretCrypto (AAD s1_org_mappings.registration_token).
ALTER TABLE s1_org_mappings
  ADD COLUMN IF NOT EXISTS registration_token text;
```

(No RLS change — `s1_org_mappings` is already covered; the new column inherits the table's existing policies.)

- [ ] **Step 2: Update the Drizzle schema**

In `apps/api/src/db/schema/sentinelOne.ts`, add to `s1OrgMappings` (after `s1SiteName`, line 109):

```typescript
  registrationToken: text('registration_token'),
```

- [ ] **Step 3: Write the failing client test**

Add to `apps/api/src/services/sentinelOneClient.test.ts` a test that `listSites()` parses the S1 `GET /web/api/v2.1/sites` response and returns `registrationToken` per site. Mock the HTTP layer the file already uses:

```typescript
it('listSites returns site id, name, and registrationToken', async () => {
  // Mock fetch to return: { data: { sites: [{ id: 's1', name: 'Acme', registrationToken: 'eyJ...' }] } }
  const sites = await client.listSites();
  expect(sites[0]).toEqual({ siteId: 's1', siteName: 'Acme', registrationToken: 'eyJ...' });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/sentinelOneClient.test.ts`
Expected: FAIL — `listSites` not defined.

- [ ] **Step 5: Implement `listSites`**

In `apps/api/src/services/sentinelOneClient.ts`, add the interface and method following the existing `listAgents` request/pagination/SSRF-guard pattern in that file:

```typescript
export interface S1Site {
  siteId: string;
  siteName: string | null;
  registrationToken: string | null;
}

// inside the client class/factory, mirroring listAgents:
async listSites(): Promise<S1Site[]> {
  const res = await this.request('/web/api/v2.1/sites', { query: { limit: 100 } });
  const sites = (res?.data?.sites ?? []) as Array<Record<string, unknown>>;
  return sites.map((s) => ({
    siteId: String(s.id),
    siteName: s.name == null ? null : String(s.name),
    registrationToken: s.registrationToken == null ? null : String(s.registrationToken),
  }));
}
```

> Use the file's actual request helper name and SSRF-validated base URL handling (the same one `listAgents` uses). Confirm the exact response envelope (`data.sites` vs `data`) against the file's existing parsing of list endpoints.

- [ ] **Step 6: Run tests + drift check**

Run:
```bash
cd apps/api && npx vitest run src/services/sentinelOneClient.test.ts
pnpm --filter @breeze/api exec drizzle-kit check
```
Expected: client test PASS; no drift.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-06-26-b-s1-org-mappings-registration-token.sql apps/api/src/db/schema/sentinelOne.ts apps/api/src/services/sentinelOneClient.ts apps/api/src/services/sentinelOneClient.test.ts
git commit -m "feat(s1): listSites() with registrationToken + s1_org_mappings.registration_token column"
```

---

### Task 9: S1 sync captures the registration token

**Files:**
- Modify: `apps/api/src/jobs/s1Sync.ts` (`upsertDiscoveredSites` ~331-367; the sync body ~499-545)
- Test: `apps/api/src/jobs/s1Sync.test.ts`

**Interfaces:**
- Consumes: `client.listSites()` (Task 8), `encryptSecret`.
- Produces: `s1_org_mappings.registration_token` populated (encrypted) on each sync.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/jobs/s1Sync.test.ts` a test asserting that after a sync where `listSites()` returns a token, the mapping row's `registrationToken` is the **encrypted** form (starts with `enc:`), and decrypts back to the original via `decryptForColumn('s1_org_mappings','registration_token', value)`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/jobs/s1Sync.test.ts`
Expected: FAIL — token not captured.

- [ ] **Step 3: Implement token capture**

Extend `upsertDiscoveredSites` to accept and write the encrypted token. Change its `sites` param type to include `registrationToken: string | null`, encrypt before insert, and add it to the conflict `set`:

```typescript
import { encryptSecret } from '../services/secretCrypto';

// in the values map:
registrationToken: site.registrationToken
  ? encryptSecret(site.registrationToken, { aad: 's1_org_mappings.registration_token' })
  : null,

// in onConflictDoUpdate.set, only overwrite when a fresh token was fetched:
registrationToken: sql`COALESCE(excluded.registration_token, s1_org_mappings.registration_token)`,
```

In the sync body (~499-545), call `listSites()` (outside DB context, like `listAgents`) and merge each site's `registrationToken` into the `discoveredSites` entries by `siteId` before calling `upsertDiscoveredSites`:

```typescript
const siteTokens = await dbModule.runOutsideDbContext(() => client.listSites());
const tokenBySite = new Map(siteTokens.map((s) => [s.siteId, s.registrationToken]));
// when building discoveredSites:
registrationToken: tokenBySite.get(siteId) ?? null,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/jobs/s1Sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/s1Sync.ts apps/api/src/jobs/s1Sync.test.ts
git commit -m "feat(s1): sync and encrypt site registration tokens into org mappings"
```

---

### Task 10: Auto-provision S1 built-in package on connect

**Files:**
- Modify: `apps/api/src/routes/sentinelOne.ts` (after integration upsert ~line 454)

**Interfaces:**
- Consumes: `ensureBuiltinPackage` (Task 4) — already provider-generic.

- [ ] **Step 1: Add the import**

In `apps/api/src/routes/sentinelOne.ts`:

```typescript
import { ensureBuiltinPackage } from '../services/builtinDeploymentPackages';
```

- [ ] **Step 2: Call it after the integration is persisted**

After `if (!integration) { return ...; }` and before the sync-scheduling block, add:

```typescript
try {
  await ensureBuiltinPackage({ provider: 'sentinelone', partnerId: integration.partnerId });
} catch (error) {
  console.error('[s1-route] failed to provision built-in deployment package:', error);
  captureException(error instanceof Error ? error : new Error(String(error)));
}
```

- [ ] **Step 3: Run S1 route tests**

Run: `cd apps/api && npx vitest run src/routes/sentinelOne.test.ts`
Expected: PASS (provisioning is best-effort; SentinelOne row has no version until the partner uploads the MSI).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/sentinelOne.ts
git commit -m "feat(software): auto-provision built-in SentinelOne package on connect"
```

---

### Task 11: Resolver — SentinelOne site token substitution

**Files:**
- Modify: `apps/api/src/services/edrInstallerResolver.ts`
- Modify: `apps/api/src/services/edrInstallerResolver.test.ts`

**Interfaces:**
- Produces: `resolveSentinelOne` implementation; `substituteS1(template, { siteToken })`.
- Consumes: `s1OrgMappings`, `s1Integrations` schema; `decryptForColumn`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/edrInstallerResolver.test.ts`:

```typescript
import { substituteS1 } from './edrInstallerResolver';

describe('substituteS1', () => {
  it('replaces the site token placeholder', () => {
    const out = substituteS1(
      { downloadUrlTemplate: null, silentInstallArgsTemplate: 'SITE_TOKEN={s1_site_token} /q /NORESTART' },
      { siteToken: 'eyJ-token' },
    );
    expect(out.silentInstallArgs).toBe('SITE_TOKEN=eyJ-token /q /NORESTART');
    expect(out.downloadUrl).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/edrInstallerResolver.test.ts`
Expected: FAIL — `substituteS1` not exported.

- [ ] **Step 3: Implement the S1 resolution**

In `apps/api/src/services/edrInstallerResolver.ts`, add the schema imports and replace the placeholder `resolveSentinelOne`:

```typescript
import { s1Integrations, s1OrgMappings } from '../db/schema';

export function substituteS1(
  templates: { downloadUrlTemplate: string | null; silentInstallArgsTemplate: string | null },
  keys: { siteToken: string },
): ResolvedInstaller {
  const apply = (s: string | null) =>
    s == null ? null : s.replaceAll('{s1_site_token}', keys.siteToken);
  return {
    downloadUrl: apply(templates.downloadUrlTemplate),
    silentInstallArgs: apply(templates.silentInstallArgsTemplate),
  };
}

async function resolveSentinelOne(params: {
  orgId: string;
  downloadUrlTemplate: string | null;
  silentInstallArgsTemplate: string | null;
}): Promise<ResolvedInstaller | EdrResolveError> {
  const ctx = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [mapping] = await db
        .select({
          tokenEncrypted: s1OrgMappings.registrationToken,
          integrationId: s1OrgMappings.integrationId,
        })
        .from(s1OrgMappings)
        .where(eq(s1OrgMappings.orgId, params.orgId))
        .limit(1);
      if (!mapping) return { kind: 'unmapped' as const };

      const [integration] = await db
        .select({ isActive: s1Integrations.isActive })
        .from(s1Integrations)
        .where(eq(s1Integrations.id, mapping.integrationId))
        .limit(1);
      if (!integration || !integration.isActive) return { kind: 'inactive' as const };

      return { kind: 'ok' as const, tokenEncrypted: mapping.tokenEncrypted };
    })
  );

  if (ctx.kind === 'unmapped') return { error: 'Organization not mapped to SentinelOne' };
  if (ctx.kind === 'inactive') return { error: 'SentinelOne integration is disconnected' };

  if (!ctx.tokenEncrypted) {
    return { error: 'SentinelOne site token not synced — run Sync in Integrations' };
  }
  const siteToken = decryptForColumn('s1_org_mappings', 'registration_token', ctx.tokenEncrypted);
  if (!siteToken) return { error: 'SentinelOne site token could not be decrypted' };

  return substituteS1(
    { downloadUrlTemplate: params.downloadUrlTemplate, silentInstallArgsTemplate: params.silentInstallArgsTemplate },
    { siteToken },
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/edrInstallerResolver.test.ts`
Expected: PASS (both Huntress and S1 substitution cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/edrInstallerResolver.ts apps/api/src/services/edrInstallerResolver.test.ts
git commit -m "feat(software): resolve SentinelOne site token at deploy dispatch"
```

---

### Task 12: Web — SentinelOne upload-required state + deploy POST via runAction

**Files:**
- Modify: `apps/web/src/components/software/SoftwareCatalog.tsx`
- Modify: `apps/web/src/components/software/DeploymentWizard.tsx` (deploy POST ~398-401)
- Test: `apps/web/src/components/software/SoftwareCatalog.test.tsx`

**Interfaces:**
- Consumes: GET /catalog `integrationProvider`; version list (to know if S1 has an uploaded binary).

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/software/SoftwareCatalog.test.tsx` a case: a `sentinelone` built-in package with **no versions** shows a "Upload installer to enable deploy" hint and a disabled Deploy button.

```typescript
it('SentinelOne built-in with no version disables Deploy with an upload hint', async () => {
  // Mock fetchWithAuth: catalog returns one sentinelone package; its versions endpoint returns [].
  render(<SoftwareCatalog />);
  const deploy = await screen.findByRole('button', { name: /deploy/i });
  expect(deploy).toBeDisabled();
  expect(screen.getByText(/upload installer/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/software/SoftwareCatalog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the SentinelOne upload-gate**

In `SoftwareCatalog.tsx`, when an item has `integrationProvider === 'sentinelone'`, determine whether it has a deployable version (the component already loads versions on detail open; for the card, fetch a lightweight `hasVersion` flag via the existing versions endpoint or extend GET /catalog to include a `versionCount`). Disable Deploy and render the hint when `versionCount === 0`:

```tsx
{item.integrationProvider === 'sentinelone' && (item.versionCount ?? 0) === 0 && (
  <p className="text-xs text-muted-foreground">Upload installer to enable deploy</p>
)}
```

> Simplest backend support: add `versionCount` to the `GET /catalog` select via a `count(software_versions)` left-join/subquery, and to the web `SoftwareItem` type (`versionCount?: number`). Include this small API change in this task.

- [ ] **Step 4: Convert the deploy POST to runAction**

In `DeploymentWizard.tsx` (lines ~398-401), wrap the deploy submission in `runAction` for consistent success/error toasts:

```typescript
import { runAction } from '../../lib/runAction';

await runAction({
  request: () => fetchWithAuth('/software/deployments', { method: 'POST', body: JSON.stringify(payload) }),
  errorFallback: 'Failed to start deployment',
  successMessage: 'Deployment started',
});
```

This also surfaces the server-side "Organization not mapped / disconnected" failures from Task 6 to the user.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
cd apps/web && npx vitest run src/components/software/SoftwareCatalog.test.tsx
cd apps/api && npx vitest run src/routes/software.test.ts
```
Expected: PASS.

- [ ] **Step 6: Check the no-silent-mutations guard**

Run: `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS (DeploymentWizard now uses `runAction`; if the guard tracks a count, update its expected value/allowlist accordingly).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/software/SoftwareCatalog.tsx apps/web/src/components/software/DeploymentWizard.tsx apps/web/src/components/software/SoftwareCatalog.test.tsx apps/api/src/routes/software.ts
git commit -m "feat(web): SentinelOne upload-required gate + deploy via runAction"
```

---

## Verification & Wrap-up

- [ ] **Run the full API + web suites** (single-fork for the API per the known parallel flakiness):
  ```bash
  cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork
  cd apps/web && npx vitest run
  ```
- [ ] **RLS forge re-check** as `breeze_app`: confirm a partner A admin cannot read partner B's built-in `software_catalog` row, and an org-scoped caller cannot insert a partner-scoped row.
- [ ] **Resolve the two flagged verification items** before merge:
  1. **Huntress account key source** — confirm `huntress_integrations.account_id` is the deploy Account Key used in the download URL + `/ACCT_KEY`. If not, capture/fetch it and update `resolveHuntress` (Task 5, Step 3).
  2. **S1 `registrationToken` field** — confirm the exact field name/envelope on the target console's `GET /sites` response (Task 8, Step 5).
- [ ] **db:check-drift** clean: `pnpm db:check-drift`.

---

## Self-Review Notes (coverage vs spec)

- Spec §1 (partner axis + dual-axis RLS) → Tasks 1-2. ✓
- Spec §2 (registry + auto-provision on connect) → Tasks 3-4 (Huntress), 10 (S1). ✓
- Spec §3 (per-device/per-org resolution, fail-clean, secrets server-side) → Tasks 5-6 (Huntress), 11 (S1). Resolution is per-deployment-org (single-org deploys), which is equivalent given org-scoped targeting. ✓
- Spec §4 (S1 token sync; Huntress account-key verification) → Tasks 8-9; verification item carried to Wrap-up. ✓
- Spec §5 (UI: badge, read-only, deploy-disabled) → Tasks 7, 12. ✓
- Spec §6 (testing: RLS forge, resolver units, secretCrypto round-trip, web disabled-state) → Tasks 2, 5, 9, 11, 7, 12. ✓
