# OneDrive Helper — Phase 0 (Spike) + Phase 1 (Server Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side foundation for the OneDrive Helper — the `onedrive_helper` config-policy feature, its settings/library/device-state tables (with RLS), the Graph functions for listing libraries and resolving group membership, and the heartbeat config delivery + device-state ingest — and first de-risk the `TenantAutoMount` library-ID format with a spike.

**Architecture:** A new `onedrive_helper` feature type plugs into the existing configuration-policy system (`config_policy_feature_links` → normalized per-feature tables, exactly like `monitoring`). Effective config is resolved per device with the existing "closest-level-wins" hierarchy merge and delivered in the heartbeat `configUpdate`. The agent reports OneDrive state back in the heartbeat payload, persisted to a device-scoped table. Graph calls reuse the per-org M365 connection (`getToken` → `graphFetch`).

**Tech Stack:** Hono + Drizzle (API, TypeScript), PostgreSQL with forced RLS, hand-written SQL migrations, Vitest (unit + integration), Microsoft Graph v1.0.

## Global Constraints

- **Node:** prefix node/pnpm/vitest commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict).
- **Scope:** Server-only. NO agent Go code and NO web UI in this plan — the agent applier and UI are separate plans gated on the Task 1 spike. Per-user Graph-group *filtering* delivery is gated on agent UPN reporting (see Task 8 note).
- **Migrations:** `apps/api/migrations/YYYY-MM-DD-<slug>.sql`, same-day ordering via `-a-/-b-` infix. Idempotent (`IF NOT EXISTS`, `pg_policies` existence checks, `DO $$`). NO inner `BEGIN;`/`COMMIT;` (autoMigrate wraps each file in a transaction). Never edit a shipped migration. `ALTER TYPE ... ADD VALUE IF NOT EXISTS`.
- **RLS (mandatory, same migration as the table):** every new tenant table gets `ENABLE` + `FORCE ROW LEVEL SECURITY` + per-command policies using `public.breeze_has_org_access(org_id)`, plus `GRANT SELECT,INSERT,UPDATE,DELETE ... TO breeze_app`. All three new tables carry a direct/denormalized `org_id` → Shape 1, auto-discovered by the RLS-coverage test (no allowlist entry needed). Add each to `ORG_CASCADE_DELETE_ORDER` alphabetically. Verify a forged cross-tenant insert fails as `breeze_app` before claiming done.
- **Real-DB tests** go in `apps/api/src/__tests__/integration/*.integration.test.ts` (BLOCKING integration-test job, `breeze_app` conn, autoMigrate + TRUNCATE-per-test). Pure-logic/Graph tests go alongside source as `*.test.ts` with mocked `fetch`/`db`.
- **Graph:** reuse `getToken(orgId)` → `graphFetch(token, method, path)` from `m365DirectGraph.ts`; never build a second token path. Secrets decrypt via `decryptForColumn('m365_connections','client_secret', cipher)`.

---

## File Structure

**Create:**
- `apps/api/migrations/2026-06-19-a-onedrive-helper-feature-enum.sql` — add enum value
- `apps/api/migrations/2026-06-19-b-onedrive-helper-settings.sql` — settings table + RLS
- `apps/api/migrations/2026-06-19-c-onedrive-helper-libraries.sql` — libraries table + RLS
- `apps/api/migrations/2026-06-19-d-onedrive-device-state.sql` — device-state table + RLS
- `apps/api/src/db/schema/onedriveHelper.ts` — Drizzle defs for the three tables
- `apps/api/src/services/onedriveGraph.ts` — `listSharePointLibraries`, `resolveUserGroupMembership`
- `apps/api/src/services/onedriveGraph.test.ts` — unit tests (mocked fetch)
- `apps/api/src/__tests__/integration/onedrive-helper-rls.integration.test.ts` — RLS forge tests
- `apps/api/src/__tests__/integration/onedrive-helper-config-delivery.integration.test.ts` — delivery + ingest
- `docs/superpowers/spikes/2026-06-19-tenant-automount-library-id.md` — spike findings

**Modify:**
- `apps/api/src/db/schema/configurationPolicies.ts` — add `'onedrive_helper'` to `configFeatureTypeEnum`
- `apps/api/src/db/schema/index.ts` (or wherever schema is re-exported) — export `onedriveHelper`
- `apps/api/src/services/configurationPolicy.ts` — add `'onedrive_helper'` to `ConfigFeatureType`; allow it in `validateFeaturePolicyExists` as inline-only
- `apps/api/src/routes/agents/helpers.ts` — add `buildOnedriveHelperConfigUpdate(deviceId)` + `resolveDeviceOnedriveSettings`
- `apps/api/src/routes/agents/heartbeat.ts` — merge onedrive config into the response; persist reported `onedriveDeviceState`
- `apps/api/src/services/tenantCascade.ts` — add three table names to `ORG_CASCADE_DELETE_ORDER`

---

## Task 1: De-risking spike — `TenantAutoMount` library-ID format

**This is a research task with a written decision gate, not a TDD task.** Everything downstream (the Graph library picker, the agent applier) depends on its outcome, so it runs first and its result is committed as a doc.

**Files:**
- Create: `docs/superpowers/spikes/2026-06-19-tenant-automount-library-id.md`

- [ ] **Step 1: Establish ground truth from a real tenant**

On a test Windows box signed into a OneDrive business account, manually "Sync" a SharePoint document library, then read the resulting AutoMount value:

```powershell
Get-ItemProperty 'HKCU:\SOFTWARE\Policies\Microsoft\OneDrive\TenantAutoMount' 2>$null
# also inspect the mounted-scope cache OneDrive actually wrote:
Get-ChildItem 'HKCU:\SOFTWARE\Microsoft\OneDrive\Accounts\Business1\Tenants' -Recurse 2>$null
```

Record the **exact** value-name and value-data format (the composite `tenantId&siteId&webId&listId&webUrl&webTitle&listTitle`-style string) verbatim in the spike doc.

- [ ] **Step 2: Pull the same library's IDs from Graph**

For the same library, capture from Graph: site id (`GET /sites/{hostname}:/sites/{path}`), the drive/list (`GET /sites/{site-id}/drives`, `GET /sites/{site-id}/lists`), and note which Graph fields (`site.id` is itself a `hostname,siteCollectionId,webId` triple; `list.id`) map to the registry composite's `siteId`/`webId`/`listId` segments.

- [ ] **Step 3: Validate construction round-trip**

Construct an AutoMount value purely from Graph-derived IDs, write it to `TenantAutoMount` on a *clean* test user, restart OneDrive (`& "$env:LOCALAPPDATA\Microsoft\OneDrive\OneDrive.exe"`), and confirm the library actually mounts.

- [ ] **Step 4: Record the decision**

In the spike doc, write one of:
- **CLEAN** — Graph IDs construct a working AutoMount value; document the exact mapping formula. The Graph library picker (Phase 1 Task 6) is viable as designed.
- **NOT CLEAN** — document what's missing; the fallback is assisted "Copy library ID" capture (operator pastes the sync-client-produced ID), and Task 6's picker degrades to a verification helper. Note any extra Graph scope needed.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/spikes/2026-06-19-tenant-automount-library-id.md
git commit -m "spike(onedrive-helper): validate TenantAutoMount library-id format vs Graph IDs"
```

> Tasks 6 and 8 below assume **CLEAN**. If the spike returns NOT CLEAN, keep the table columns (`siteId`/`webId`/`listId` plus a raw `libraryId`) — they still hold the captured composite — and the only change is how `libraryId` is *sourced* (operator paste vs Graph construction). The plan's data model is robust to either outcome.

---

## Task 2: Register the `onedrive_helper` feature type

**Files:**
- Modify: `apps/api/src/db/schema/configurationPolicies.ts:28-45` (`configFeatureTypeEnum`)
- Modify: `apps/api/src/services/configurationPolicy.ts:56` (`ConfigFeatureType`) and `validateFeaturePolicyExists`
- Create: `apps/api/migrations/2026-06-19-a-onedrive-helper-feature-enum.sql`
- Test: `apps/api/src/services/configurationPolicy.onedrive.test.ts`

**Interfaces:**
- Produces: the literal `'onedrive_helper'` is a valid `ConfigFeatureType` and `config_feature_type` enum value; linking it requires `inlineSettings` (no `featurePolicyId`), validated like `monitoring`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/services/configurationPolicy.onedrive.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: {}, withDbAccessContext: vi.fn(), withSystemDbAccessContext: vi.fn() }));

import { validateFeaturePolicyExists } from './configurationPolicy';

describe('onedrive_helper feature type', () => {
  it('rejects a featurePolicyId (inline-only feature)', async () => {
    const res = await validateFeaturePolicyExists('onedrive_helper', 'some-id', 'org-1');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/does not support featurePolicyId/);
  });

  it('accepts inline-only (no featurePolicyId)', async () => {
    const res = await validateFeaturePolicyExists('onedrive_helper', null, 'org-1');
    expect(res.valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/configurationPolicy.onedrive.test.ts`
Expected: FAIL — `'onedrive_helper'` not assignable to `ConfigFeatureType` / validation falls through to "Unknown feature type".

- [ ] **Step 3: Add the enum value (schema + service type)**

In `configurationPolicies.ts`, add `'onedrive_helper'` to `configFeatureTypeEnum` (append after `'pam'`):

```typescript
export const configFeatureTypeEnum = pgEnum('config_feature_type', [
  'patch', 'alert_rule', 'backup', 'security', 'monitoring', 'maintenance',
  'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data',
  'peripheral_control', 'warranty', 'helper', 'remote_access', 'pam',
  'onedrive_helper',
]);
```

In `configurationPolicy.ts:56`, append `| 'onedrive_helper'` to the `ConfigFeatureType` union.

- [ ] **Step 4: Treat it as inline-only in `validateFeaturePolicyExists`**

Extend the existing `monitoring`/`event_log` inline-only branch to include the new type:

```typescript
if (featureType === 'monitoring' || featureType === 'event_log' || featureType === 'onedrive_helper') {
  if (featurePolicyId) {
    return { valid: false, error: `${featureType} feature type does not support featurePolicyId; use inlineSettings instead` };
  }
  return { valid: true };
}
```

- [ ] **Step 5: Write the enum migration**

```sql
-- apps/api/migrations/2026-06-19-a-onedrive-helper-feature-enum.sql
-- Add the onedrive_helper feature type to the config_feature_type enum.
-- ADD VALUE IF NOT EXISTS is transaction-safe in PG12+ as long as the value
-- isn't *used* in the same transaction (it isn't here).
ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'onedrive_helper';
```

- [ ] **Step 6: Run the test + drift check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/configurationPolicy.onedrive.test.ts`
Expected: PASS.
Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Expected: no drift.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/configurationPolicies.ts apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.onedrive.test.ts apps/api/migrations/2026-06-19-a-onedrive-helper-feature-enum.sql
git commit -m "feat(onedrive-helper): register onedrive_helper config-policy feature type"
```

---

## Task 3: `config_policy_onedrive_settings` table (base config)

One row per `onedrive_helper` feature link, denormalized `org_id`, holding base-provisioning toggles.

**Files:**
- Create: `apps/api/src/db/schema/onedriveHelper.ts`
- Modify: schema barrel export
- Create: `apps/api/migrations/2026-06-19-b-onedrive-helper-settings.sql`
- Modify: `apps/api/src/services/tenantCascade.ts` (`ORG_CASCADE_DELETE_ORDER`)
- Test: `apps/api/src/__tests__/integration/onedrive-helper-rls.integration.test.ts`

**Interfaces:**
- Produces: Drizzle export `configPolicyOnedriveSettings` with columns `id, featureLinkId, orgId, silentAccountConfig, filesOnDemand, kfmSilentOptIn, kfmFolders (jsonb string[]), kfmBlockOptOut, tenantAssociationId, restartOnChange, createdAt, updatedAt`.

- [ ] **Step 1: Write the failing RLS test (settings portion)**

```typescript
// apps/api/src/__tests__/integration/onedrive-helper-rls.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getAppPool, seedTwoOrgsWithPolicy } from './helpers/rlsHarness'; // existing harness

describe('onedrive_helper RLS — settings', () => {
  beforeEach(async () => { await seedTwoOrgsWithPolicy(); });

  it('breeze_app cannot insert settings for another org', async () => {
    const pool = getAppPool('orgA'); // RLS context = orgA
    await expect(pool.query(
      `INSERT INTO config_policy_onedrive_settings (feature_link_id, org_id, silent_account_config)
       VALUES ($1, $2, true)`,
      [/* orgB feature link */ '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b0'],
    )).rejects.toThrow(/row-level security/);
  });
});
```

> Use the repo's existing integration RLS harness (the same one `rls-coverage` / other `*-rls.integration.test.ts` files use to set the `breeze_app` org context). If a reusable `seedTwoOrgsWithPolicy` helper doesn't exist, inline the seed (insert two orgs, a partner, a configuration policy + feature link per org) in `beforeEach`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `export DATABASE_URL=... && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/onedrive-helper-rls.integration.test.ts`
Expected: FAIL — relation `config_policy_onedrive_settings` does not exist.

- [ ] **Step 3: Add the Drizzle schema**

```typescript
// apps/api/src/db/schema/onedriveHelper.ts
import { pgTable, uuid, boolean, varchar, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { configPolicyFeatureLinks } from './configurationPolicies';

export const configPolicyOnedriveSettings = pgTable('config_policy_onedrive_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull()
    .references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  silentAccountConfig: boolean('silent_account_config').notNull().default(true),
  filesOnDemand: boolean('files_on_demand').notNull().default(true),
  kfmSilentOptIn: boolean('kfm_silent_opt_in').notNull().default(false),
  kfmFolders: jsonb('kfm_folders').notNull().default(['Desktop', 'Documents', 'Pictures']),
  kfmBlockOptOut: boolean('kfm_block_opt_out').notNull().default(false),
  tenantAssociationId: varchar('tenant_association_id', { length: 64 }),
  restartOnChange: boolean('restart_on_change').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  featureLinkUniq: uniqueIndex('onedrive_settings_feature_link_uniq').on(t.featureLinkId),
  orgIdx: index('onedrive_settings_org_idx').on(t.orgId),
}));
```

Export it from the schema barrel.

- [ ] **Step 4: Write the migration with RLS (template = `metric_anomalies`)**

```sql
-- apps/api/migrations/2026-06-19-b-onedrive-helper-settings.sql
CREATE TABLE IF NOT EXISTS config_policy_onedrive_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id UUID NOT NULL REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  silent_account_config BOOLEAN NOT NULL DEFAULT true,
  files_on_demand BOOLEAN NOT NULL DEFAULT true,
  kfm_silent_opt_in BOOLEAN NOT NULL DEFAULT false,
  kfm_folders JSONB NOT NULL DEFAULT '["Desktop","Documents","Pictures"]'::jsonb,
  kfm_block_opt_out BOOLEAN NOT NULL DEFAULT false,
  tenant_association_id VARCHAR(64),
  restart_on_change BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT onedrive_settings_kfm_folders_array_check CHECK (jsonb_typeof(kfm_folders) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS onedrive_settings_feature_link_uniq
  ON config_policy_onedrive_settings (feature_link_id);
CREATE INDEX IF NOT EXISTS onedrive_settings_org_idx
  ON config_policy_onedrive_settings (org_id);

ALTER TABLE config_policy_onedrive_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_onedrive_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_onedrive_settings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_onedrive_settings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_onedrive_settings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_onedrive_settings;

CREATE POLICY breeze_org_isolation_select ON config_policy_onedrive_settings
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON config_policy_onedrive_settings
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON config_policy_onedrive_settings
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON config_policy_onedrive_settings
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE config_policy_onedrive_settings TO breeze_app;
```

- [ ] **Step 5: Add to the cascade list**

In `tenantCascade.ts`, insert `'config_policy_onedrive_settings'` into `ORG_CASCADE_DELETE_ORDER` in `localeCompare` order (after `config_policy_monitoring_*` entries, before `config_policy_*` that sort later — verify exact neighbors by eye against the file, the list is alphabetical).

- [ ] **Step 6: Run the test + drift check**

Run: `export DATABASE_URL=... && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/onedrive-helper-rls.integration.test.ts`
Expected: PASS (cross-org insert rejected).
Run: `pnpm db:check-drift` → no drift.

- [ ] **Step 7: Manually verify the forge as `breeze_app`**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c \
  "INSERT INTO config_policy_onedrive_settings (feature_link_id, org_id) VALUES (gen_random_uuid(), gen_random_uuid());"
```
Expected: `ERROR: new row violates row-level security policy`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/db/schema/onedriveHelper.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-06-19-b-onedrive-helper-settings.sql apps/api/src/services/tenantCascade.ts apps/api/src/__tests__/integration/onedrive-helper-rls.integration.test.ts
git commit -m "feat(onedrive-helper): config_policy_onedrive_settings table + RLS"
```

---

## Task 4: `config_policy_onedrive_libraries` table (per-library mappings)

N rows per settings row; each is one SharePoint library + its targeting rule.

**Files:**
- Modify: `apps/api/src/db/schema/onedriveHelper.ts`
- Create: `apps/api/migrations/2026-06-19-c-onedrive-helper-libraries.sql`
- Modify: `apps/api/src/services/tenantCascade.ts`
- Test: extend `onedrive-helper-rls.integration.test.ts`

**Interfaces:**
- Produces: `configPolicyOnedriveLibraries` with `id, settingsId, orgId, libraryId, displayName, siteUrl, siteId, webId, listId, targetingMode ('everyone'|'graph_group'|'local_ad_group'), groupId, groupName, hiveScope ('hkcu'|'hklm'), sortOrder, enabled, createdAt`.

- [ ] **Step 1: Write the failing test (libraries portion)**

Add to the RLS integration file:

```typescript
it('breeze_app cannot insert a library mapping for another org', async () => {
  const pool = getAppPool('orgA');
  await expect(pool.query(
    `INSERT INTO config_policy_onedrive_libraries
       (settings_id, org_id, library_id, display_name, targeting_mode)
     VALUES ($1, $2, 'lib-x', 'Finance', 'everyone')`,
    ['00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b0'],
  )).rejects.toThrow(/row-level security/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: same integration command as Task 3 Step 6.
Expected: FAIL — relation `config_policy_onedrive_libraries` does not exist.

- [ ] **Step 3: Add the Drizzle schema**

```typescript
// append to apps/api/src/db/schema/onedriveHelper.ts
import { integer } from 'drizzle-orm/pg-core';

export const configPolicyOnedriveLibraries = pgTable('config_policy_onedrive_libraries', {
  id: uuid('id').primaryKey().defaultRandom(),
  settingsId: uuid('settings_id').notNull()
    .references(() => configPolicyOnedriveSettings.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  libraryId: varchar('library_id', { length: 1024 }).notNull(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  siteUrl: varchar('site_url', { length: 1024 }),
  siteId: varchar('site_id', { length: 512 }),
  webId: varchar('web_id', { length: 128 }),
  listId: varchar('list_id', { length: 128 }),
  targetingMode: varchar('targeting_mode', { length: 20 }).notNull().default('everyone'),
  groupId: varchar('group_id', { length: 128 }),
  groupName: varchar('group_name', { length: 255 }),
  hiveScope: varchar('hive_scope', { length: 8 }).notNull().default('hkcu'),
  sortOrder: integer('sort_order').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  settingsIdx: index('onedrive_libraries_settings_idx').on(t.settingsId),
  orgIdx: index('onedrive_libraries_org_idx').on(t.orgId),
}));
```

- [ ] **Step 4: Write the migration with RLS**

```sql
-- apps/api/migrations/2026-06-19-c-onedrive-helper-libraries.sql
CREATE TABLE IF NOT EXISTS config_policy_onedrive_libraries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settings_id UUID NOT NULL REFERENCES config_policy_onedrive_settings(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  library_id VARCHAR(1024) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  site_url VARCHAR(1024),
  site_id VARCHAR(512),
  web_id VARCHAR(128),
  list_id VARCHAR(128),
  targeting_mode VARCHAR(20) NOT NULL DEFAULT 'everyone',
  group_id VARCHAR(128),
  group_name VARCHAR(255),
  hive_scope VARCHAR(8) NOT NULL DEFAULT 'hkcu',
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT onedrive_libraries_targeting_mode_check CHECK (
    targeting_mode IN ('everyone', 'graph_group', 'local_ad_group')
  ),
  CONSTRAINT onedrive_libraries_hive_scope_check CHECK (hive_scope IN ('hkcu', 'hklm')),
  CONSTRAINT onedrive_libraries_group_required_check CHECK (
    targeting_mode = 'everyone' OR group_id IS NOT NULL OR group_name IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS onedrive_libraries_settings_idx
  ON config_policy_onedrive_libraries (settings_id);
CREATE INDEX IF NOT EXISTS onedrive_libraries_org_idx
  ON config_policy_onedrive_libraries (org_id);

ALTER TABLE config_policy_onedrive_libraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_onedrive_libraries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_onedrive_libraries;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_onedrive_libraries;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_onedrive_libraries;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_onedrive_libraries;

CREATE POLICY breeze_org_isolation_select ON config_policy_onedrive_libraries
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON config_policy_onedrive_libraries
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON config_policy_onedrive_libraries
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON config_policy_onedrive_libraries
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE config_policy_onedrive_libraries TO breeze_app;
```

- [ ] **Step 5: Add to the cascade list**

Insert `'config_policy_onedrive_libraries'` into `ORG_CASCADE_DELETE_ORDER` alphabetically (it sorts immediately before `config_policy_onedrive_settings` — `i` < `s`).

- [ ] **Step 6: Run test + drift + forge**

Run the integration test (PASS), `pnpm db:check-drift` (no drift), and the `breeze_app` forge insert (expect RLS rejection) as in Task 3.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(onedrive-helper): config_policy_onedrive_libraries table + RLS"
```

---

## Task 5: `onedrive_device_state` table (agent-reported state)

Device-scoped, denormalized `org_id`. One row per device.

**Files:**
- Modify: `apps/api/src/db/schema/onedriveHelper.ts`
- Create: `apps/api/migrations/2026-06-19-d-onedrive-device-state.sql`
- Modify: `apps/api/src/services/tenantCascade.ts`
- Test: extend `onedrive-helper-rls.integration.test.ts`

**Interfaces:**
- Produces: `onedriveDeviceState` with `deviceId (PK), orgId, signedIn, oneDriveVersion, filesOnDemandOn, kfmFolderStates (jsonb), mountedLibraries (jsonb string[]), entitledLibraries (jsonb string[]), driftEntries (jsonb), lastReportedAt, updatedAt`.

- [ ] **Step 1: Write the failing test (device-state portion)**

```typescript
it('breeze_app cannot read another org device state', async () => {
  const pool = getAppPool('orgA');
  const res = await pool.query(
    `SELECT device_id FROM onedrive_device_state WHERE org_id = $1`,
    ['00000000-0000-0000-0000-0000000000b0'], // orgB
  );
  expect(res.rows).toHaveLength(0); // RLS filters, no error on SELECT
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run the integration command. Expected: FAIL — relation `onedrive_device_state` does not exist.

- [ ] **Step 3: Add the Drizzle schema (denormalized org_id, device-keyed)**

```typescript
// append to apps/api/src/db/schema/onedriveHelper.ts
import { doublePrecision } from 'drizzle-orm/pg-core';
import { devices } from './devices';

export const onedriveDeviceState = pgTable('onedrive_device_state', {
  deviceId: uuid('device_id').primaryKey().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  signedIn: boolean('signed_in').notNull().default(false),
  oneDriveVersion: varchar('onedrive_version', { length: 64 }),
  filesOnDemandOn: boolean('files_on_demand_on').notNull().default(false),
  kfmFolderStates: jsonb('kfm_folder_states').notNull().default({}),
  mountedLibraries: jsonb('mounted_libraries').notNull().default([]),
  entitledLibraries: jsonb('entitled_libraries').notNull().default([]),
  driftEntries: jsonb('drift_entries').notNull().default([]),
  lastReportedAt: timestamp('last_reported_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  orgIdx: index('onedrive_device_state_org_idx').on(t.orgId),
}));
```

(`doublePrecision` import is unused here — drop it; left as a reminder that the schema file has multiple tables.)

- [ ] **Step 4: Write the migration with RLS (Shape 5 — denormalized org_id, same policy form)**

```sql
-- apps/api/migrations/2026-06-19-d-onedrive-device-state.sql
CREATE TABLE IF NOT EXISTS onedrive_device_state (
  device_id UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  signed_in BOOLEAN NOT NULL DEFAULT false,
  onedrive_version VARCHAR(64),
  files_on_demand_on BOOLEAN NOT NULL DEFAULT false,
  kfm_folder_states JSONB NOT NULL DEFAULT '{}'::jsonb,
  mounted_libraries JSONB NOT NULL DEFAULT '[]'::jsonb,
  entitled_libraries JSONB NOT NULL DEFAULT '[]'::jsonb,
  drift_entries JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_reported_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS onedrive_device_state_org_idx
  ON onedrive_device_state (org_id);

ALTER TABLE onedrive_device_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE onedrive_device_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON onedrive_device_state;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON onedrive_device_state;
DROP POLICY IF EXISTS breeze_org_isolation_update ON onedrive_device_state;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON onedrive_device_state;

CREATE POLICY breeze_org_isolation_select ON onedrive_device_state
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON onedrive_device_state
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON onedrive_device_state
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON onedrive_device_state
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE onedrive_device_state TO breeze_app;
```

- [ ] **Step 5: Add to cascade list + device-delete list**

Insert `'onedrive_device_state'` into `ORG_CASCADE_DELETE_ORDER` alphabetically. Because it's device-scoped with a denormalized `org_id` kept in sync by the existing `breeze_cascade_device_org_id` trigger, no manual device-child clear-order entry is needed (the topological sort handles FK order via `device_id → devices`).

- [ ] **Step 6: Run test + drift + forge (insert)**

Integration test PASS; `pnpm db:check-drift` no drift; forge insert as `breeze_app` rejected.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(onedrive-helper): onedrive_device_state table + RLS"
```

---

## Task 6: Graph — `listSharePointLibraries(orgId)`

Powers the library picker. Mirrors the `getToken` → `graphFetch` pattern.

**Files:**
- Create: `apps/api/src/services/onedriveGraph.ts`
- Test: `apps/api/src/services/onedriveGraph.test.ts`

**Interfaces:**
- Consumes: `getToken(orgId)` and `graphFetch(token, method, path)` — re-export them from `m365DirectGraph.ts` (export them there if currently module-private) or replicate the tiny `getToken` body. Prefer exporting from `m365DirectGraph.ts`.
- Produces: `listSharePointLibraries(orgId: string): Promise<DirectInvokeResult>` where success `data` is `{ libraries: Array<{ siteId: string; siteName: string; siteUrl: string; driveId: string; listId: string; libraryName: string }> }`.

- [ ] **Step 1: Export the shared helpers from `m365DirectGraph.ts`**

Change `async function getToken` → `export async function getToken` and `async function graphFetch` → `export async function graphFetch` (and export `DirectInvokeResult` if not already). No behavior change.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/api/src/services/onedriveGraph.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./m365DirectGraph', () => ({
  getToken: vi.fn(async () => ({ token: 'tok' })),
  graphFetch: vi.fn(),
}));

import { getToken, graphFetch } from './m365DirectGraph';
import { listSharePointLibraries } from './onedriveGraph';

describe('listSharePointLibraries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns flattened site+library list', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'host,scid,webid', displayName: 'Marketing', webUrl: 'https://c.sharepoint.com/sites/mktg' },
      ] } }) // /sites?search=*
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'drive-1', name: 'Documents', list: { id: 'list-1' } },
      ] } }); // /sites/{id}/drives

    const res = await listSharePointLibraries('org-1');
    expect(res.kind).toBe('ok');
    expect((res as any).data.libraries[0]).toMatchObject({
      siteName: 'Marketing', driveId: 'drive-1', listId: 'list-1', libraryName: 'Documents',
    });
  });

  it('propagates a token error', async () => {
    (getToken as any).mockResolvedValueOnce({ kind: 'error', code: 'no_connection', message: 'x' });
    const res = await listSharePointLibraries('org-1');
    expect(res.kind).toBe('error');
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/onedriveGraph.test.ts`
Expected: FAIL — `listSharePointLibraries` not exported.

- [ ] **Step 4: Implement**

```typescript
// apps/api/src/services/onedriveGraph.ts
import { getToken, graphFetch, type DirectInvokeResult } from './m365DirectGraph';

export async function listSharePointLibraries(orgId: string): Promise<DirectInvokeResult> {
  const tok = await getToken(orgId);
  if ('kind' in tok) return tok; // error result
  const token = tok.token;

  const sites = await graphFetch(token, 'GET', `/sites?search=*&$top=100&$select=id,displayName,webUrl`);
  if (sites.kind === 'error') return sites;

  const siteRows = Array.isArray((sites.data as any)?.value) ? (sites.data as any).value : [];
  const libraries: Array<Record<string, string>> = [];

  for (const site of siteRows) {
    const drives = await graphFetch(
      token, 'GET',
      `/sites/${encodeURIComponent(site.id)}/drives?$select=id,name,list`,
    );
    if (drives.kind === 'error') continue; // skip a site we can't read; don't fail the whole list
    const driveRows = Array.isArray((drives.data as any)?.value) ? (drives.data as any).value : [];
    for (const d of driveRows) {
      libraries.push({
        siteId: site.id,
        siteName: site.displayName ?? '',
        siteUrl: site.webUrl ?? '',
        driveId: d.id,
        listId: d.list?.id ?? '',
        libraryName: d.name ?? '',
      });
    }
  }

  return { kind: 'ok', data: { libraries } };
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run the Step-3 command. Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/onedriveGraph.ts apps/api/src/services/onedriveGraph.test.ts apps/api/src/services/m365DirectGraph.ts
git commit -m "feat(onedrive-helper): Graph listSharePointLibraries for the library picker"
```

---

## Task 7: Graph — `resolveUserGroupMembership(orgId, upn)`

Resolves a user's group ids for `graph_group` targeting.

**Files:**
- Modify: `apps/api/src/services/onedriveGraph.ts`
- Test: extend `apps/api/src/services/onedriveGraph.test.ts`

**Interfaces:**
- Produces: `resolveUserGroupMembership(orgId: string, upn: string): Promise<DirectInvokeResult>` where success `data` is `{ groupIds: string[] }` (transitive membership, ids only).

- [ ] **Step 1: Write the failing test**

```typescript
// add to onedriveGraph.test.ts
import { resolveUserGroupMembership } from './onedriveGraph';

describe('resolveUserGroupMembership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns transitive group ids for the user', async () => {
    (graphFetch as any).mockResolvedValueOnce({ kind: 'ok', data: { value: [
      { id: 'g-1' }, { id: 'g-2' },
    ] } });
    const res = await resolveUserGroupMembership('org-1', "user@contoso.com");
    expect((res as any).data.groupIds).toEqual(['g-1', 'g-2']);
    // verify the OData id was single-quote-escaped into the path
    const calledPath = (graphFetch as any).mock.calls[0][2] as string;
    expect(calledPath).toContain('/users/');
    expect(calledPath).toContain('transitiveMemberOf');
  });

  it('rejects an empty upn before calling Graph', async () => {
    const res = await resolveUserGroupMembership('org-1', '');
    expect(res.kind).toBe('error');
    expect((graphFetch as any)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/onedriveGraph.test.ts`
Expected: FAIL — `resolveUserGroupMembership` not exported.

- [ ] **Step 3: Implement**

```typescript
// append to apps/api/src/services/onedriveGraph.ts
export async function resolveUserGroupMembership(orgId: string, upn: string): Promise<DirectInvokeResult> {
  if (!upn || typeof upn !== 'string') {
    return { kind: 'error', code: 'bad_request', message: 'upn is required.' };
  }
  const tok = await getToken(orgId);
  if ('kind' in tok) return tok;

  // transitiveMemberOf so nested group membership counts; only group objects, ids only.
  const res = await graphFetch(
    tok.token, 'GET',
    `/users/${encodeURIComponent(upn)}/transitiveMemberOf/microsoft.graph.group?$select=id&$top=200`,
  );
  if (res.kind === 'error') return res;

  const rows = Array.isArray((res.data as any)?.value) ? (res.data as any).value : [];
  const groupIds = rows.map((g: any) => g.id).filter((id: unknown): id is string => typeof id === 'string');
  return { kind: 'ok', data: { groupIds } };
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run the Step-2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/onedriveGraph.ts apps/api/src/services/onedriveGraph.test.ts
git commit -m "feat(onedrive-helper): Graph resolveUserGroupMembership for graph_group targeting"
```

---

## Task 8: Heartbeat delivery — `buildOnedriveHelperConfigUpdate(deviceId)`

Resolves the effective `onedrive_helper` settings + libraries for a device (closest-level-wins, mirroring `resolveDeviceMonitoringSettings`) and delivers base config + the library rules in the heartbeat `configUpdate`.

> **Phase boundary:** this delivers base config + the full library list **with each library's targeting rule** (`mode` + `groupId`/`groupName`). It does NOT yet filter `graph_group` libraries per logged-in user — that requires the device to report logged-in UPNs (an agent change in the next plan). At that point the server calls `resolveUserGroupMembership` (Task 7) per reported UPN and tags allow/deny. For now `graph_group`/`local_ad_group` libraries are delivered as rules for the agent to (eventually) evaluate; `everyone` libraries are immediately actionable. This is the honest seam between the server-foundation and agent plans.

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` (add resolver + builder)
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (merge into response)
- Test: `apps/api/src/__tests__/integration/onedrive-helper-config-delivery.integration.test.ts`

**Interfaces:**
- Consumes: `configPolicyOnedriveSettings`, `configPolicyOnedriveLibraries`, the existing `LEVEL_PRIORITY`, `configPolicyAssignments`, `configurationPolicies`, `configPolicyFeatureLinks`.
- Produces: `buildOnedriveHelperConfigUpdate(deviceId: string): Promise<OnedriveConfigUpdate | null>` returning `{ base: {...}, libraries: Array<{ libraryId, displayName, siteUrl, targetingMode, groupId, groupName, hiveScope }> } | null`. Merged into the heartbeat response under key `onedrive_helper_settings`.

- [ ] **Step 1: Write the failing integration test**

```typescript
// apps/api/src/__tests__/integration/onedrive-helper-config-delivery.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { seedDeviceWithOnedrivePolicy } from './helpers/onedriveSeed'; // create inline if absent
import { buildOnedriveHelperConfigUpdate } from '../../routes/agents/helpers';

describe('buildOnedriveHelperConfigUpdate', () => {
  let deviceId: string;
  beforeEach(async () => { ({ deviceId } = await seedDeviceWithOnedrivePolicy({
    base: { silentAccountConfig: true, filesOnDemand: true, kfmSilentOptIn: true },
    libraries: [
      { libraryId: 'lib-fin', displayName: 'Finance', targetingMode: 'graph_group', groupId: 'g-fin' },
      { libraryId: 'lib-all', displayName: 'Company', targetingMode: 'everyone' },
    ],
  })); });

  it('returns base config + library rules for an assigned device', async () => {
    const cfg = await buildOnedriveHelperConfigUpdate(deviceId);
    expect(cfg).not.toBeNull();
    expect(cfg!.base.kfmSilentOptIn).toBe(true);
    expect(cfg!.libraries).toHaveLength(2);
    expect(cfg!.libraries.find(l => l.libraryId === 'lib-fin')!.targetingMode).toBe('graph_group');
  });

  it('returns null for a device with no onedrive_helper policy', async () => {
    const { deviceId: bare } = await seedDeviceWithOnedrivePolicy({ base: null, libraries: [] });
    expect(await buildOnedriveHelperConfigUpdate(bare)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `export DATABASE_URL=... && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/onedrive-helper-config-delivery.integration.test.ts`
Expected: FAIL — `buildOnedriveHelperConfigUpdate` not exported.

- [ ] **Step 3: Implement the resolver + builder** (mirror `resolveDeviceMonitoringSettings`)

```typescript
// apps/api/src/routes/agents/helpers.ts
import { configPolicyOnedriveSettings, configPolicyOnedriveLibraries } from '../../db/schema/onedriveHelper';

export interface OnedriveConfigUpdate {
  base: {
    silentAccountConfig: boolean;
    filesOnDemand: boolean;
    kfmSilentOptIn: boolean;
    kfmFolders: string[];
    kfmBlockOptOut: boolean;
    tenantAssociationId: string | null;
    restartOnChange: boolean;
  };
  libraries: Array<{
    libraryId: string;
    displayName: string;
    siteUrl: string | null;
    targetingMode: string;
    groupId: string | null;
    groupName: string | null;
    hiveScope: string;
  }>;
}

async function resolveDeviceOnedriveSettings(deviceId: string): Promise<OnedriveConfigUpdate | null> {
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) return null;

  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations).where(eq(organizations.id, device.orgId)).limit(1);

  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships).where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  const targetConditions = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!,
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!,
    );
  }

  const rows = await db
    .select({
      level: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      settingsId: configPolicyOnedriveSettings.id,
      silentAccountConfig: configPolicyOnedriveSettings.silentAccountConfig,
      filesOnDemand: configPolicyOnedriveSettings.filesOnDemand,
      kfmSilentOptIn: configPolicyOnedriveSettings.kfmSilentOptIn,
      kfmFolders: configPolicyOnedriveSettings.kfmFolders,
      kfmBlockOptOut: configPolicyOnedriveSettings.kfmBlockOptOut,
      tenantAssociationId: configPolicyOnedriveSettings.tenantAssociationId,
      restartOnChange: configPolicyOnedriveSettings.restartOnChange,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyFeatureLinks, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configPolicyFeatureLinks.featureType, 'onedrive_helper'),
    ))
    .innerJoin(configPolicyOnedriveSettings, eq(configPolicyOnedriveSettings.featureLinkId, configPolicyFeatureLinks.id))
    .where(and(
      eq(configurationPolicies.status, 'active'),
      eq(configurationPolicies.orgId, device.orgId),
      or(...targetConditions),
    ));

  if (rows.length === 0) return null;

  rows.sort((a, b) => {
    const levelDiff = (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    return a.assignmentPriority - b.assignmentPriority;
  });
  const winner = rows[0];
  if (!winner) return null;

  const libs = await db
    .select()
    .from(configPolicyOnedriveLibraries)
    .where(and(
      eq(configPolicyOnedriveLibraries.settingsId, winner.settingsId),
      eq(configPolicyOnedriveLibraries.enabled, true),
    ))
    .orderBy(configPolicyOnedriveLibraries.sortOrder);

  return {
    base: {
      silentAccountConfig: winner.silentAccountConfig,
      filesOnDemand: winner.filesOnDemand,
      kfmSilentOptIn: winner.kfmSilentOptIn,
      kfmFolders: (winner.kfmFolders as string[]) ?? [],
      kfmBlockOptOut: winner.kfmBlockOptOut,
      tenantAssociationId: winner.tenantAssociationId,
      restartOnChange: winner.restartOnChange,
    },
    libraries: libs.map((l) => ({
      libraryId: l.libraryId,
      displayName: l.displayName,
      siteUrl: l.siteUrl,
      targetingMode: l.targetingMode,
      groupId: l.groupId,
      groupName: l.groupName,
      hiveScope: l.hiveScope,
    })),
  };
}

export async function buildOnedriveHelperConfigUpdate(deviceId: string): Promise<OnedriveConfigUpdate | null> {
  return resolveDeviceOnedriveSettings(deviceId);
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run the Step-2 command. Expected: PASS (both cases).

- [ ] **Step 5: Merge into the heartbeat response**

In `heartbeat.ts`, beside the existing `buildMonitoringConfigUpdate`/`buildPamConfigUpdate` calls, add:

```typescript
let onedriveSettings: OnedriveConfigUpdate | null = null;
try {
  onedriveSettings = await buildOnedriveHelperConfigUpdate(device.id);
} catch (err) {
  console.error(`[agents] failed to build onedrive_helper config update for ${agentId}:`, err);
}
```

and in the `mergedConfigUpdate` assembly:

```typescript
if (configUpdate || eventLogSettings || monitoringSettings || onedriveSettings) {
  mergedConfigUpdate = { ...(configUpdate ?? {}) };
  if (eventLogSettings) mergedConfigUpdate.event_log_settings = eventLogSettings;
  if (monitoringSettings) mergedConfigUpdate.monitoring_settings = monitoringSettings;
  if (onedriveSettings) mergedConfigUpdate.onedrive_helper_settings = onedriveSettings;
}
```

- [ ] **Step 6: Run the full delivery test again + typecheck**

Run: the Step-2 integration command (PASS) and
`PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/__tests__/integration/onedrive-helper-config-delivery.integration.test.ts
git commit -m "feat(onedrive-helper): resolve + deliver effective config in heartbeat"
```

---

## Task 9: Heartbeat ingest — persist reported `onedriveDeviceState`

Accept an optional `onedriveDeviceState` field in the heartbeat payload and upsert it.

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (zod schema + upsert)
- Test: extend `onedrive-helper-config-delivery.integration.test.ts`

**Interfaces:**
- Consumes: `onedriveDeviceState` schema table.
- Produces: heartbeat accepts `onedriveDeviceState?: { signedIn, oneDriveVersion?, filesOnDemandOn, kfmFolderStates, mountedLibraries, entitledLibraries, driftEntries }` and upserts one row keyed by `device_id`, writing the device's `org_id`.

- [ ] **Step 1: Write the failing test**

```typescript
// add to onedrive-helper-config-delivery.integration.test.ts
import { onedriveDeviceState } from '../../db/schema/onedriveHelper';
import { postHeartbeat } from './helpers/heartbeatClient'; // existing helper that posts an authed heartbeat
import { withSystemDbAccessContext, db } from '../../db';
import { eq } from 'drizzle-orm';

it('persists reported onedrive device state', async () => {
  const { deviceId, agentToken } = await seedDeviceWithOnedrivePolicy({ base: null, libraries: [] });
  await postHeartbeat(deviceId, agentToken, {
    status: 'online', agentVersion: '1.0.0',
    onedriveDeviceState: {
      signedIn: true, filesOnDemandOn: true,
      kfmFolderStates: { Documents: 'redirected' },
      mountedLibraries: ['lib-all'], entitledLibraries: ['lib-all'], driftEntries: [],
    },
  });
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(onedriveDeviceState).where(eq(onedriveDeviceState.deviceId, deviceId)));
  expect(row.signedIn).toBe(true);
  expect(row.mountedLibraries).toEqual(['lib-all']);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run the integration command for this file. Expected: FAIL — state row not written (field ignored).

- [ ] **Step 3: Extend the heartbeat zod schema**

Add to `heartbeatSchema` (optional, non-breaking):

```typescript
onedriveDeviceState: z.object({
  signedIn: z.boolean(),
  oneDriveVersion: z.string().max(64).optional(),
  filesOnDemandOn: z.boolean(),
  kfmFolderStates: z.record(z.string(), z.string()).default({}),
  mountedLibraries: z.array(z.string().max(1024)).default([]),
  entitledLibraries: z.array(z.string().max(1024)).default([]),
  driftEntries: z.array(z.record(z.string(), z.unknown())).default([]),
}).optional(),
```

- [ ] **Step 4: Upsert in the handler**

After the device is loaded/validated, before building the response:

```typescript
if (data.onedriveDeviceState) {
  const s = data.onedriveDeviceState;
  await db.insert(onedriveDeviceState).values({
    deviceId: device.id,
    orgId: device.orgId,
    signedIn: s.signedIn,
    oneDriveVersion: s.oneDriveVersion ?? null,
    filesOnDemandOn: s.filesOnDemandOn,
    kfmFolderStates: s.kfmFolderStates,
    mountedLibraries: s.mountedLibraries,
    entitledLibraries: s.entitledLibraries,
    driftEntries: s.driftEntries,
    lastReportedAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: onedriveDeviceState.deviceId,
    set: {
      signedIn: s.signedIn,
      oneDriveVersion: s.oneDriveVersion ?? null,
      filesOnDemandOn: s.filesOnDemandOn,
      kfmFolderStates: s.kfmFolderStates,
      mountedLibraries: s.mountedLibraries,
      entitledLibraries: s.entitledLibraries,
      driftEntries: s.driftEntries,
      lastReportedAt: new Date(),
      updatedAt: new Date(),
    },
  });
}
```

> The heartbeat runs in the agent's request DB context (the device's own org), so this insert satisfies `breeze_has_org_access(org_id)` with `org_id = device.orgId`. No `withSystemDbAccessContext` needed here.

- [ ] **Step 5: Run it to confirm it passes**

Run the integration command. Expected: PASS.

- [ ] **Step 6: Run the whole onedrive integration + the RLS-coverage contract test**

Run: `export DATABASE_URL=... && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/onedrive-helper-config-delivery.integration.test.ts src/__tests__/integration/onedrive-helper-rls.integration.test.ts`
Expected: all PASS.
Run the RLS-coverage contract test (auto-discovers the three new org_id tables):
`... exec vitest run --config vitest.config.rls-coverage.ts` (per the repo's rls-coverage runner)
Expected: PASS — no uncovered tenant tables.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/agents/heartbeat.ts apps/api/src/__tests__/integration/onedrive-helper-config-delivery.integration.test.ts
git commit -m "feat(onedrive-helper): ingest + persist reported OneDrive device state"
```

---

## Self-Review (completed during authoring)

**Spec coverage:** Base-config ownership → Task 3 (`config_policy_onedrive_settings` incl. KFM fields). Source-flexible per-library targeting → Task 4 (`targetingMode` enum + group columns). Graph picker → Task 6. Graph-group resolution → Task 7. Server-side resolution split + delivery → Task 8 (with explicit phase seam for per-user filtering). State reporting (for the reporting view) → Task 5 + Task 9. RLS/cascade discipline → Tasks 3–5. The library-ID format risk → Task 1 spike, gating Task 6/8. *Deferred by design (not gaps):* agent applier, web UI, per-user graph filtering hookup, unmount, sync-health/alerting — all Sub-project B or the agent/UI plans.

**Placeholder scan:** No "TBD"/"add error handling"/"similar to" — each step carries real SQL/TS/test code. The one intentional note is Task 1 (a genuine research spike, correctly not TDD) and the Task 8 phase-seam note (a real architectural boundary, not a deferred detail).

**Type consistency:** `OnedriveConfigUpdate` defined in Task 8 and consumed in the heartbeat merge; `configPolicyOnedriveSettings`/`configPolicyOnedriveLibraries`/`onedriveDeviceState` Drizzle names consistent across Tasks 3–5, 8, 9; `getToken`/`graphFetch`/`DirectInvokeResult` reused from `m365DirectGraph.ts` consistently in Tasks 6–7. Heartbeat config key `onedrive_helper_settings` used once (delivery). Targeting-mode literals (`everyone`/`graph_group`/`local_ad_group`) match between the CHECK constraint (Task 4) and the test (Task 8).
