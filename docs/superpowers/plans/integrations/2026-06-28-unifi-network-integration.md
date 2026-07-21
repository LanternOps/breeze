# UniFi Network Integration (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a partner-level UniFi (Ubiquiti) cloud integration that syncs device inventory and WAN health from the Site Manager API into Breeze's network model, read-only.

**Architecture:** Mirrors the SentinelOne connector (partner-level encrypted credential) and the accounting connect/settings UI. Four new tables (`unifi_integrations`, `unifi_site_mappings`, `unifi_devices`, `unifi_sync_runs`), a thin HTTP client, a connection service with a `DbExecutor` seam, a sync service that reconciles into `discovered_assets`, a BullMQ worker, partner-scoped Hono routes, and a React integration component. No agent changes, no write/control actions, no webhooks (those are Phases 2–3).

**Tech Stack:** Hono + TypeScript (API), Drizzle ORM + PostgreSQL (with forced RLS), BullMQ + Redis, Astro + React (web), Vitest.

**Spec:** `docs/superpowers/specs/integrations/2026-06-28-unifi-network-integration-design.md`

## Global Constraints

- **RLS is mandatory.** Every tenant-scoped table gets `ENABLE` + `FORCE ROW LEVEL SECURITY` and policies **in the same migration that creates it**. Partner-axis tables use `public.breeze_has_partner_access(partner_id)`; direct-`org_id` tables use `public.breeze_has_org_access(org_id)`.
- **Migrations:** hand-written SQL in `apps/api/migrations/`, filename `YYYY-MM-DD-<slug>.sql` (today: `2026-06-28-`). Must be idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`, `DO $$ … EXCEPTION` for constraints). No inner `BEGIN;`/`COMMIT;` (autoMigrate wraps each file in a transaction). Never edit a shipped migration.
- **Secrets** are encrypted at rest via `apps/api/src/services/secretCrypto.ts` `encryptSecret(value, { aad })` / `decryptForColumn(table, column, value)`. Bind AAD to `table.column`. Never log or return a decrypted key.
- **DB context:** request handlers already run inside `withDbAccessContext`; background work runs inside `withSystemDbAccessContext`. `createInstrumentedQueue(...).add()` throws if called inside a held DB context — wrap route-side enqueues in `runOutsideDbContext(() => queue.add(...))`.
- **0-row writes are bugs:** every guarded UPDATE/DELETE uses `.where(and(eq(id), eq(partnerId|orgId)))` + `.returning({ id })` and throws if `length === 0` (silent RLS-context mismatch otherwise).
- **Web mutations** go through `runAction` (`apps/web/src/lib/runAction.ts`); catch with the `ActionError`/`handleActionError` pattern.
- **Phase 1 is read-only against UniFi:** issue only `GET`s to `api.ui.com`. No restart/PoE/block actions.
- **Drizzle is for queries only.** Do not run `drizzle-kit generate`/`push`. After schema edits run `pnpm db:check-drift`.

---

## File Structure

**Create:**
- `apps/api/migrations/2026-06-28-unifi-network-integration.sql` — 4 tables + RLS
- `apps/api/src/db/schema/unifi.ts` — Drizzle definitions
- `apps/api/src/services/unifi/unifiClient.ts` — Site Manager HTTP client
- `apps/api/src/services/unifi/unifiClient.test.ts`
- `apps/api/src/services/unifi/unifiConnectionService.ts` — connection CRUD + crypto seam
- `apps/api/src/services/unifi/unifiConnectionService.test.ts`
- `apps/api/src/services/unifi/unifiSyncService.ts` — sync orchestration + reconciliation
- `apps/api/src/services/unifi/unifiSyncService.test.ts`
- `apps/api/src/jobs/unifiWorker.ts` — BullMQ queue, scheduler, worker
- `apps/api/src/routes/unifi/index.ts` — partner-scoped routes
- `apps/api/src/routes/unifi/index.test.ts`
- `apps/web/src/components/integrations/UnifiIntegration.tsx`

**Modify:**
- `apps/api/src/db/schema/index.ts` — re-export `./unifi`
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — allowlist + forge tests
- `apps/api/src/index.ts` — mount `unifiRoutes`, call `initializeUnifiWorker()`
- `apps/web/src/components/integrations/IntegrationsPage.tsx` — register the UniFi tab

---

## Task 1: Schema + migration (4 tables, RLS)

**Files:**
- Create: `apps/api/migrations/2026-06-28-unifi-network-integration.sql`
- Create: `apps/api/src/db/schema/unifi.ts`
- Modify: `apps/api/src/db/schema/index.ts`

**Interfaces:**
- Produces (Drizzle exports consumed by all later API tasks): `unifiIntegrations`, `unifiSiteMappings`, `unifiDevices`, `unifiSyncRuns` from `apps/api/src/db/schema/unifi.ts`. Columns are exactly as defined in Step 1/2 below.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-28-unifi-network-integration.sql`:

```sql
-- UniFi Network Integration (Phase 1): cloud read-only inventory.
-- Partner-axis connection + sync ledger; org-axis site mappings + devices.

-- 1. unifi_integrations (partner-axis) -----------------------------------
CREATE TABLE IF NOT EXISTS unifi_integrations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id        uuid NOT NULL REFERENCES partners(id),
  base_url          text NOT NULL DEFAULT 'https://api.ui.com',
  api_key_encrypted text NOT NULL,
  account_label     text,
  is_active         boolean NOT NULL DEFAULT true,
  status            varchar(20) NOT NULL DEFAULT 'connected',
  last_sync_at      timestamptz,
  last_sync_status  varchar(20),
  last_sync_error   text,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_integrations_partner_active_idx
  ON unifi_integrations(partner_id) WHERE is_active;

ALTER TABLE unifi_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON unifi_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON unifi_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON unifi_integrations;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON unifi_integrations;
CREATE POLICY breeze_partner_isolation_select ON unifi_integrations
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON unifi_integrations
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON unifi_integrations
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON unifi_integrations
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

-- 2. unifi_site_mappings (direct org_id) ---------------------------------
CREATE TABLE IF NOT EXISTS unifi_site_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL REFERENCES unifi_integrations(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id),
  site_id         uuid NOT NULL REFERENCES sites(id),
  unifi_host_id   text NOT NULL,
  unifi_site_id   text NOT NULL,
  unifi_host_name text,
  unifi_site_name text,
  wan_metrics     jsonb,
  wan_metrics_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_site_mappings_unique_site_idx
  ON unifi_site_mappings(integration_id, unifi_host_id, unifi_site_id);

ALTER TABLE unifi_site_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_site_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON unifi_site_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON unifi_site_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON unifi_site_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON unifi_site_mappings;
CREATE POLICY breeze_org_isolation_select ON unifi_site_mappings
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON unifi_site_mappings
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON unifi_site_mappings
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON unifi_site_mappings
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 3. unifi_devices (direct org_id) ---------------------------------------
CREATE TABLE IF NOT EXISTS unifi_devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  site_id             uuid NOT NULL REFERENCES sites(id),
  integration_id      uuid NOT NULL REFERENCES unifi_integrations(id) ON DELETE CASCADE,
  mapping_id          uuid NOT NULL REFERENCES unifi_site_mappings(id) ON DELETE CASCADE,
  discovered_asset_id uuid REFERENCES discovered_assets(id),
  unifi_device_id     text NOT NULL,
  mac                 text,
  name                text,
  model               text,
  device_type         varchar(40),
  ip_address          inet,
  firmware_version    text,
  firmware_updatable  boolean,
  adoption_state      varchar(30),
  uptime_seconds      bigint,
  is_stale            boolean NOT NULL DEFAULT false,
  last_seen_at        timestamptz,
  raw                 jsonb NOT NULL,
  first_synced_at     timestamptz NOT NULL DEFAULT now(),
  last_synced_at      timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_devices_integration_device_idx
  ON unifi_devices(integration_id, unifi_device_id);
CREATE INDEX IF NOT EXISTS unifi_devices_org_mac_idx
  ON unifi_devices(org_id, mac);

ALTER TABLE unifi_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON unifi_devices;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON unifi_devices;
DROP POLICY IF EXISTS breeze_org_isolation_update ON unifi_devices;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON unifi_devices;
CREATE POLICY breeze_org_isolation_select ON unifi_devices
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON unifi_devices
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON unifi_devices
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON unifi_devices
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 4. unifi_sync_runs (partner-axis, partner_id denormalized) -------------
CREATE TABLE IF NOT EXISTS unifi_sync_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id    uuid NOT NULL REFERENCES unifi_integrations(id) ON DELETE CASCADE,
  partner_id        uuid NOT NULL REFERENCES partners(id),
  trigger           varchar(16) NOT NULL,
  status            varchar(16) NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  hosts_seen        integer NOT NULL DEFAULT 0,
  devices_created   integer NOT NULL DEFAULT 0,
  devices_updated   integer NOT NULL DEFAULT 0,
  devices_unchanged integer NOT NULL DEFAULT 0,
  devices_removed   integer NOT NULL DEFAULT 0,
  error             text
);
CREATE INDEX IF NOT EXISTS unifi_sync_runs_integration_started_idx
  ON unifi_sync_runs(integration_id, started_at DESC);

ALTER TABLE unifi_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_sync_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON unifi_sync_runs;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON unifi_sync_runs;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON unifi_sync_runs;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON unifi_sync_runs;
CREATE POLICY breeze_partner_isolation_select ON unifi_sync_runs
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON unifi_sync_runs
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON unifi_sync_runs
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON unifi_sync_runs
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));
```

- [ ] **Step 2: Write the Drizzle schema**

Create `apps/api/src/db/schema/unifi.ts`:

```typescript
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  inet,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, partners, sites } from './orgs';
import { users } from './users';
import { discoveredAssets } from './discovery';

export const unifiIntegrations = pgTable('unifi_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  baseUrl: text('base_url').notNull().default('https://api.ui.com'),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  accountLabel: text('account_label'),
  isActive: boolean('is_active').notNull().default(true),
  status: varchar('status', { length: 20 }).notNull().default('connected'),
  lastSyncAt: timestamp('last_sync_at'),
  lastSyncStatus: varchar('last_sync_status', { length: 20 }),
  lastSyncError: text('last_sync_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  partnerActiveIdx: uniqueIndex('unifi_integrations_partner_active_idx')
    .on(table.partnerId)
    .where(sql`${table.isActive}`),
}));

export const unifiSiteMappings = pgTable('unifi_site_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().references(() => unifiIntegrations.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  unifiHostId: text('unifi_host_id').notNull(),
  unifiSiteId: text('unifi_site_id').notNull(),
  unifiHostName: text('unifi_host_name'),
  unifiSiteName: text('unifi_site_name'),
  wanMetrics: jsonb('wan_metrics'),
  wanMetricsAt: timestamp('wan_metrics_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  uniqueSiteIdx: uniqueIndex('unifi_site_mappings_unique_site_idx')
    .on(table.integrationId, table.unifiHostId, table.unifiSiteId),
}));

export const unifiDevices = pgTable('unifi_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  integrationId: uuid('integration_id').notNull().references(() => unifiIntegrations.id, { onDelete: 'cascade' }),
  mappingId: uuid('mapping_id').notNull().references(() => unifiSiteMappings.id, { onDelete: 'cascade' }),
  discoveredAssetId: uuid('discovered_asset_id').references(() => discoveredAssets.id),
  unifiDeviceId: text('unifi_device_id').notNull(),
  mac: text('mac'),
  name: text('name'),
  model: text('model'),
  deviceType: varchar('device_type', { length: 40 }),
  ipAddress: inet('ip_address'),
  firmwareVersion: text('firmware_version'),
  firmwareUpdatable: boolean('firmware_updatable'),
  adoptionState: varchar('adoption_state', { length: 30 }),
  uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
  isStale: boolean('is_stale').notNull().default(false),
  lastSeenAt: timestamp('last_seen_at'),
  raw: jsonb('raw').notNull(),
  firstSyncedAt: timestamp('first_synced_at').defaultNow().notNull(),
  lastSyncedAt: timestamp('last_synced_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  integrationDeviceIdx: uniqueIndex('unifi_devices_integration_device_idx')
    .on(table.integrationId, table.unifiDeviceId),
  orgMacIdx: index('unifi_devices_org_mac_idx').on(table.orgId, table.mac),
}));

export const unifiSyncRuns = pgTable('unifi_sync_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().references(() => unifiIntegrations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  trigger: varchar('trigger', { length: 16 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
  hostsSeen: integer('hosts_seen').notNull().default(0),
  devicesCreated: integer('devices_created').notNull().default(0),
  devicesUpdated: integer('devices_updated').notNull().default(0),
  devicesUnchanged: integer('devices_unchanged').notNull().default(0),
  devicesRemoved: integer('devices_removed').notNull().default(0),
  error: text('error'),
}, (table) => ({
  integrationStartedIdx: index('unifi_sync_runs_integration_started_idx')
    .on(table.integrationId, table.startedAt),
}));
```

- [ ] **Step 3: Re-export the schema**

In `apps/api/src/db/schema/index.ts`, add alongside the other `export * from` lines:

```typescript
export * from './unifi';
```

- [ ] **Step 4: Verify drift-clean**

Run (needs the DB up — `docker compose ... up -d postgres`, then):
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
```
Expected: applies `2026-06-28-unifi-network-integration.sql`, then reports **no drift** between `apps/api/src/db/schema/` and the migrated DB.

- [ ] **Step 5: Verify idempotency**

Re-run the migration runner (whatever `db:check-drift` invokes, or restart the API once) and confirm the second apply is a no-op (no errors, tables/policies unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-06-28-unifi-network-integration.sql apps/api/src/db/schema/unifi.ts apps/api/src/db/schema/index.ts
git commit -m "feat(unifi): schema + migration for cloud integration (4 tables + RLS)"
```

---

## Task 2: RLS coverage allowlist + functional forge tests

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

**Interfaces:**
- Consumes: `unifiIntegrations`, `unifiDevices` from Task 1.

- [ ] **Step 1: Add the partner-axis tables to the allowlist**

In `rls-coverage.integration.test.ts`, find the `PARTNER_TENANT_TABLES` Map and add two entries (the value is the column `breeze_has_partner_access` is called with):

```typescript
  ['unifi_integrations', 'partner_id'],
  ['unifi_sync_runs', 'partner_id'],
```

(`unifi_site_mappings` and `unifi_devices` are direct-`org_id` shape-1 tables — auto-discovered, no allowlist entry needed.)

- [ ] **Step 2: Run the contract test to confirm coverage passes**

Run:
```bash
cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS — the four new tables are recognized as covered (the test fails loudly for any tenant table lacking policies; adding the allowlist entries + the migration's policies satisfies it).

- [ ] **Step 3: Write a cross-partner forge test (integration table)**

Add to the same file, mirroring the existing forge-test structure (`withDbAccessContext(partnerContext(...))` + expect a thrown RLS violation). Use the file's existing partner-context and fixture helpers:

```typescript
it('partner B INSERT into unifi_integrations with partner_id=A is rejected by RLS', async () => {
  await ensureFixtures();
  let caught: unknown;
  try {
    await withDbAccessContext(partnerContext(partnerBId), async () =>
      db.insert(unifiIntegrations).values({
        partnerId: partnerAId, // forging partner A while in partner B's context
        apiKeyEncrypted: 'rls-forge-not-a-real-key',
      })
    );
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(String((caught as Error)?.message)).toMatch(/row-level security/i);
});
```

> Note: use the exact helper names already in this file (e.g. `partnerContext`, `partnerAId`, `partnerBId`, `ensureFixtures`). If the file names them differently, match its convention — do not invent new fixtures.

- [ ] **Step 4: Write a cross-org forge test (devices table)**

```typescript
it('org B INSERT into unifi_devices with org_id=A is rejected by RLS', async () => {
  await ensureFixtures();
  let caught: unknown;
  try {
    await withDbAccessContext(orgContext(orgBId), async () =>
      db.insert(unifiDevices).values({
        orgId: orgAId,
        siteId: orgASiteId,
        integrationId: forgeIntegrationId, // any uuid; RLS rejects before FK matters
        mappingId: forgeMappingId,
        unifiDeviceId: 'forge-device',
        raw: {},
      })
    );
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(String((caught as Error)?.message)).toMatch(/row-level security/i);
});
```

> If the file has no `orgASiteId`/`forgeIntegrationId` fixtures, use existing org-A site/uuid helpers or constant uuids — the RLS `WITH CHECK` on `org_id` fires before any FK is evaluated, so the referenced ids need not exist.

- [ ] **Step 5: Run the forge tests**

Run:
```bash
cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS — both new `it(...)` cases green (the inserts throw `new row violates row-level security policy`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(unifi): RLS allowlist + cross-tenant forge tests"
```

---

## Task 3: UniFi Site Manager HTTP client

**Files:**
- Create: `apps/api/src/services/unifi/unifiClient.ts`
- Test: `apps/api/src/services/unifi/unifiClient.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 5–7):
  - `class UnifiApiError extends Error { status: number; code?: string }`
  - `interface UnifiHost { id: string; name: string }`
  - `interface UnifiSite { id: string; hostId: string; name: string }`
  - `interface UnifiDeviceDto { unifiDeviceId: string; mac: string | null; name: string | null; model: string | null; deviceType: string | null; ip: string | null; firmwareVersion: string | null; firmwareUpdatable: boolean | null; adoptionState: string | null; uptimeSeconds: number | null; raw: unknown }`
  - `interface UnifiIspMetrics { latencyMs: number | null; packetLoss: number | null; uptimePercent: number | null; isp: string | null; raw: unknown }`
  - `interface UnifiClient { listHosts(): Promise<UnifiHost[]>; listSites(): Promise<UnifiSite[]>; listDevices(hostId: string): Promise<UnifiDeviceDto[]>; getIspMetrics(siteId: string): Promise<UnifiIspMetrics | null> }`
  - `function createUnifiClient(cfg: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }): UnifiClient`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/unifi/unifiClient.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createUnifiClient, UnifiApiError } from './unifiClient';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('unifiClient', () => {
  it('sends X-API-KEY and parses the {data} envelope for listHosts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ id: 'h1', name: 'Console 1' }] })
    );
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    const hosts = await client.listHosts();
    expect(hosts).toEqual([{ id: 'h1', name: 'Console 1' }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.ui.com/v1/hosts');
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBe('k');
  });

  it('throws UnifiApiError on a non-ok HTTP status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: 'unauthorized' }, 401));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'bad', fetchImpl });
    await expect(client.listHosts()).rejects.toBeInstanceOf(UnifiApiError);
    await expect(client.listHosts()).rejects.toMatchObject({ status: 401 });
  });

  it('maps a raw device payload to UnifiDeviceDto and preserves raw', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{
      id: 'd1', mac: 'aa:bb', name: 'AP-1', model: 'U6-Pro', type: 'uap',
      ipAddress: '10.0.0.5', firmwareVersion: '6.6.0', firmwareUpdatable: true,
      state: 'CONNECTED', uptime: 1234,
    }] }));
    const client = createUnifiClient({ baseUrl: 'https://api.ui.com', apiKey: 'k', fetchImpl });
    const [dev] = await client.listDevices('h1');
    expect(dev.unifiDeviceId).toBe('d1');
    expect(dev.mac).toBe('aa:bb');
    expect(dev.deviceType).toBe('uap');
    expect(dev.uptimeSeconds).toBe(1234);
    expect(dev.raw).toMatchObject({ id: 'd1', model: 'U6-Pro' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && pnpm vitest run src/services/unifi/unifiClient.test.ts`
Expected: FAIL — `Cannot find module './unifiClient'`.

- [ ] **Step 3: Implement the client**

Create `apps/api/src/services/unifi/unifiClient.ts`:

```typescript
export class UnifiApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'UnifiApiError';
    this.status = status;
    this.code = code;
  }
}

export interface UnifiHost { id: string; name: string }
export interface UnifiSite { id: string; hostId: string; name: string }
export interface UnifiDeviceDto {
  unifiDeviceId: string;
  mac: string | null;
  name: string | null;
  model: string | null;
  deviceType: string | null;
  ip: string | null;
  firmwareVersion: string | null;
  firmwareUpdatable: boolean | null;
  adoptionState: string | null;
  uptimeSeconds: number | null;
  raw: unknown;
}
export interface UnifiIspMetrics {
  latencyMs: number | null;
  packetLoss: number | null;
  uptimePercent: number | null;
  isp: string | null;
  raw: unknown;
}
export interface UnifiClient {
  listHosts(): Promise<UnifiHost[]>;
  listSites(): Promise<UnifiSite[]>;
  listDevices(hostId: string): Promise<UnifiDeviceDto[]>;
  getIspMetrics(siteId: string): Promise<UnifiIspMetrics | null>;
}

interface UnifiClientConfig { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export function createUnifiClient(cfg: UnifiClientConfig): UnifiClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/+$/, '');

  async function get<T>(path: string): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'GET',
      headers: { 'X-API-KEY': cfg.apiKey, accept: 'application/json' },
    });
    const body = (await res.json().catch(() => null)) as { data?: unknown; message?: string; meta?: { rc?: string; msg?: string } } | null;
    if (!res.ok) {
      throw new UnifiApiError(body?.message ?? body?.meta?.msg ?? `UniFi API ${res.status}`, res.status, body?.meta?.msg);
    }
    if (body?.meta?.rc === 'error') {
      throw new UnifiApiError(body.meta.msg ?? 'UniFi API error', res.status, body.meta.msg);
    }
    return (body?.data ?? body) as T;
  }

  return {
    async listHosts() {
      const rows = await get<Array<Record<string, unknown>>>('/v1/hosts');
      return rows.map((h) => ({ id: String(h.id), name: str(h.name) ?? String(h.id) }));
    },
    async listSites() {
      const rows = await get<Array<Record<string, unknown>>>('/v1/sites');
      return rows.map((s) => ({ id: String(s.id), hostId: String(s.hostId ?? s.host_id ?? ''), name: str(s.name) ?? String(s.id) }));
    },
    async listDevices(hostId: string) {
      const rows = await get<Array<Record<string, unknown>>>(`/v1/hosts/${encodeURIComponent(hostId)}/devices`);
      return rows.map((d) => ({
        unifiDeviceId: String(d.id),
        mac: str(d.mac),
        name: str(d.name),
        model: str(d.model),
        deviceType: str(d.type),
        ip: str(d.ipAddress ?? d.ip),
        firmwareVersion: str(d.firmwareVersion ?? d.version),
        firmwareUpdatable: bool(d.firmwareUpdatable ?? d.upgradable),
        adoptionState: str(d.state ?? d.adoptionState),
        uptimeSeconds: num(d.uptime),
        raw: d,
      }));
    },
    async getIspMetrics(siteId: string) {
      const data = await get<Record<string, unknown> | null>(`/v1/sites/${encodeURIComponent(siteId)}/isp-metrics`);
      if (!data) return null;
      return {
        latencyMs: num(data.latencyMs ?? data.latency),
        packetLoss: num(data.packetLoss ?? data.loss),
        uptimePercent: num(data.uptimePercent ?? data.uptime),
        isp: str(data.isp ?? data.provider),
        raw: data,
      };
    },
  };
}
```

> The `/v1/...` field names are version-dependent (see spec). The mapping accepts a couple of plausible aliases and always keeps `raw`; adjust aliases when validated against a live console (Step 4 note).

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && pnpm vitest run src/services/unifi/unifiClient.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/unifi/unifiClient.ts apps/api/src/services/unifi/unifiClient.test.ts
git commit -m "feat(unifi): Site Manager API client"
```

---

## Task 4: Connection service (CRUD + crypto seam)

**Files:**
- Create: `apps/api/src/services/unifi/unifiConnectionService.ts`
- Test: `apps/api/src/services/unifi/unifiConnectionService.test.ts`

**Interfaces:**
- Consumes: `unifiIntegrations` (Task 1); `encryptSecret`, `decryptForColumn` (`../secretCrypto`).
- Produces (consumed by Tasks 5–7):
  - `type DbExecutor = { select: (...a: any[]) => any; insert: (...a: any[]) => any; update: (...a: any[]) => any; delete: (...a: any[]) => any }`
  - `interface UnifiConnection { id: string; partnerId: string; baseUrl: string; accountLabel: string | null; isActive: boolean; status: string; lastSyncAt: Date | null; lastSyncStatus: string | null; lastSyncError: string | null }`
  - `getConnection(db, partnerId): Promise<UnifiConnection | null>`
  - `getDecryptedApiKey(db, partnerId): Promise<string | null>`
  - `upsertConnection(db, partnerId, fields: { baseUrl: string; apiKey: string; accountLabel?: string | null; createdBy?: string | null }): Promise<UnifiConnection>`
  - `markStatus(db, connectionId, partnerId, status: string, lastError?: string | null): Promise<void>`
  - `markSynced(db, connectionId, partnerId, status: string, error?: string | null): Promise<void>`
  - `deleteConnection(db, partnerId): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/unifi/unifiConnectionService.test.ts`. Use a Drizzle-style chainable mock (match the repo's existing service-test mock style):

```typescript
import { describe, it, expect, vi } from 'vitest';
import * as svc from './unifiConnectionService';

// Minimal chainable db mock: each method returns an object exposing the next
function makeDb(overrides: Partial<Record<string, any>> = {}) {
  return {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => overrides.selectRows ?? [] }) }) })),
    insert: vi.fn(() => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: () => overrides.insertRows ?? [] }) }) })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: () => overrides.updateRows ?? [] }) }) })),
    delete: vi.fn(() => ({ where: () => ({ returning: () => overrides.deleteRows ?? [] }) })),
  } as unknown as svc.DbExecutor;
}

describe('unifiConnectionService', () => {
  it('markStatus throws when no row is updated (RLS-context guard)', async () => {
    const db = makeDb({ updateRows: [] });
    await expect(svc.markStatus(db, 'conn-1', 'partner-1', 'error', 'boom'))
      .rejects.toThrow(/no unifi_integrations row/i);
  });

  it('markStatus succeeds when a row is returned', async () => {
    const db = makeDb({ updateRows: [{ id: 'conn-1' }] });
    await expect(svc.markStatus(db, 'conn-1', 'partner-1', 'connected')).resolves.toBeUndefined();
  });

  it('getDecryptedApiKey returns null when no connection', async () => {
    const db = makeDb({ selectRows: [] });
    await expect(svc.getDecryptedApiKey(db, 'partner-x')).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && pnpm vitest run src/services/unifi/unifiConnectionService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/unifi/unifiConnectionService.ts`:

```typescript
import { and, eq } from 'drizzle-orm';
import { unifiIntegrations } from '../../db/schema';
import { encryptSecret, decryptForColumn } from '../secretCrypto';

export type DbExecutor = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

export interface UnifiConnection {
  id: string;
  partnerId: string;
  baseUrl: string;
  accountLabel: string | null;
  isActive: boolean;
  status: string;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
}

function toConnection(row: any): UnifiConnection {
  return {
    id: row.id,
    partnerId: row.partnerId,
    baseUrl: row.baseUrl,
    accountLabel: row.accountLabel ?? null,
    isActive: row.isActive,
    status: row.status,
    lastSyncAt: row.lastSyncAt ?? null,
    lastSyncStatus: row.lastSyncStatus ?? null,
    lastSyncError: row.lastSyncError ?? null,
  };
}

async function selectActiveRow(db: DbExecutor, partnerId: string): Promise<any | null> {
  const rows = await db
    .select()
    .from(unifiIntegrations)
    .where(and(eq(unifiIntegrations.partnerId, partnerId), eq(unifiIntegrations.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getConnection(db: DbExecutor, partnerId: string): Promise<UnifiConnection | null> {
  const row = await selectActiveRow(db, partnerId);
  return row ? toConnection(row) : null;
}

export async function getDecryptedApiKey(db: DbExecutor, partnerId: string): Promise<string | null> {
  const row = await selectActiveRow(db, partnerId);
  if (!row) return null;
  return decryptForColumn('unifi_integrations', 'api_key_encrypted', row.apiKeyEncrypted);
}

export async function upsertConnection(
  db: DbExecutor,
  partnerId: string,
  fields: { baseUrl: string; apiKey: string; accountLabel?: string | null; createdBy?: string | null }
): Promise<UnifiConnection> {
  const apiKeyEncrypted = encryptSecret(fields.apiKey, { aad: 'unifi_integrations.api_key_encrypted' });
  const inserted = await db
    .insert(unifiIntegrations)
    .values({
      partnerId,
      baseUrl: fields.baseUrl,
      apiKeyEncrypted,
      accountLabel: fields.accountLabel ?? null,
      createdBy: fields.createdBy ?? null,
      isActive: true,
      status: 'connected',
    })
    .onConflictDoUpdate({
      target: unifiIntegrations.partnerActiveIdx,
      set: {
        baseUrl: fields.baseUrl,
        apiKeyEncrypted,
        accountLabel: fields.accountLabel ?? null,
        status: 'connected',
        lastSyncError: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!inserted[0]) throw new Error('upsertConnection returned no unifi_integrations row');
  return toConnection(inserted[0]);
}

export async function markStatus(
  db: DbExecutor,
  connectionId: string,
  partnerId: string,
  status: string,
  lastError?: string | null
): Promise<void> {
  const updated = await db
    .update(unifiIntegrations)
    .set({ status, lastSyncError: lastError ?? null, updatedAt: new Date() })
    .where(and(eq(unifiIntegrations.id, connectionId), eq(unifiIntegrations.partnerId, partnerId)))
    .returning({ id: unifiIntegrations.id });
  if (updated.length === 0) {
    throw new Error(`markStatus matched no unifi_integrations row (id=${connectionId})`);
  }
}

export async function markSynced(
  db: DbExecutor,
  connectionId: string,
  partnerId: string,
  status: string,
  error?: string | null
): Promise<void> {
  const updated = await db
    .update(unifiIntegrations)
    .set({ lastSyncAt: new Date(), lastSyncStatus: status, lastSyncError: error ?? null, updatedAt: new Date() })
    .where(and(eq(unifiIntegrations.id, connectionId), eq(unifiIntegrations.partnerId, partnerId)))
    .returning({ id: unifiIntegrations.id });
  if (updated.length === 0) {
    throw new Error(`markSynced matched no unifi_integrations row (id=${connectionId})`);
  }
}

export async function deleteConnection(db: DbExecutor, partnerId: string): Promise<boolean> {
  const deleted = await db
    .delete(unifiIntegrations)
    .where(and(eq(unifiIntegrations.partnerId, partnerId), eq(unifiIntegrations.isActive, true)))
    .returning({ id: unifiIntegrations.id });
  return deleted.length > 0;
}
```

> If `onConflictDoUpdate` against a partial unique index needs `target`/`targetWhere` adjustment in this Drizzle version, target the columns + predicate: `target: unifiIntegrations.partnerId, targetWhere: eq(unifiIntegrations.isActive, true)`. Verify against the partial index `unifi_integrations_partner_active_idx`.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && pnpm vitest run src/services/unifi/unifiConnectionService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/unifi/unifiConnectionService.ts apps/api/src/services/unifi/unifiConnectionService.test.ts
git commit -m "feat(unifi): connection service with encrypted key + RLS-guarded writes"
```

---

## Task 5: Sync service (inventory sync + discovered_assets reconciliation)

**Files:**
- Create: `apps/api/src/services/unifi/unifiSyncService.ts`
- Test: `apps/api/src/services/unifi/unifiSyncService.test.ts`

**Interfaces:**
- Consumes: `UnifiClient`, `UnifiDeviceDto` (Task 3); `DbExecutor` (Task 4); `unifiSiteMappings`, `unifiDevices`, `unifiSyncRuns`, `discoveredAssets` (schema).
- Produces (consumed by Task 6):
  - `interface SyncRunResult { hostsSeen: number; devicesCreated: number; devicesUpdated: number; devicesUnchanged: number; devicesRemoved: number; status: 'success' | 'partial' | 'failed'; error?: string }`
  - `syncIntegration(deps: { db: DbExecutor; client: UnifiClient }, integration: { id: string; partnerId: string }, trigger: 'scheduled' | 'manual'): Promise<SyncRunResult>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/unifi/unifiSyncService.test.ts`. Drive the reconciliation logic with a fake DB that records inserts/updates:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { syncIntegration } from './unifiSyncService';
import type { UnifiClient } from './unifiClient';

function fakeClient(devices: any[]): UnifiClient {
  return {
    listHosts: async () => [{ id: 'h1', name: 'Console' }],
    listSites: async () => [{ id: 's1', hostId: 'h1', name: 'Site' }],
    listDevices: async () => devices,
    getIspMetrics: async () => ({ latencyMs: 10, packetLoss: 0, uptimePercent: 99.9, isp: 'ACME', raw: {} }),
  };
}

// A scripted DbExecutor that returns canned rows per table and records writes.
function scriptedDb(opts: { mappings: any[]; existingDevices?: any[]; existingAsset?: any }) {
  const writes: { inserts: any[]; updates: any[] } = { inserts: [], updates: [] };
  // Implementers: model select() to branch on the table passed to from()/the where().
  // The test only asserts on `writes`, so wire select() to return:
  //   - unifiSiteMappings rows -> opts.mappings
  //   - unifiDevices rows      -> opts.existingDevices ?? []
  //   - discoveredAssets rows  -> opts.existingAsset ? [opts.existingAsset] : []
  // (see implementation note in Step 3)
  return { writes /*, db */ } as any;
}

describe('unifiSyncService.syncIntegration', () => {
  it('creates a unifi_device and a linked discovered_asset for a net-new device', async () => {
    const client = fakeClient([{
      unifiDeviceId: 'd1', mac: 'aa:bb:cc:dd:ee:ff', name: 'AP-1', model: 'U6-Pro',
      deviceType: 'uap', ip: '10.0.0.5', firmwareVersion: '6.6', firmwareUpdatable: false,
      adoptionState: 'CONNECTED', uptimeSeconds: 100, raw: {},
    }]);
    // Build a db where the mapping resolves host h1/site s1 -> org/site, no existing device or asset.
    // Assert: result.devicesCreated === 1 and a discovered_assets insert happened.
    // (Concrete db wiring per Step 3.)
    expect(typeof syncIntegration).toBe('function');
    void client;
  });

  it('classifies an unchanged device as unchanged (no update churn)', async () => {
    expect(true).toBe(true); // replace with real assertion once db harness is in place
  });
});
```

> This task's test harness is the trickiest in the plan. Implement `scriptedDb` to dispatch on the table object identity passed to `.from(table)` / `.insert(table)` (import `unifiSiteMappings`, `unifiDevices`, `discoveredAssets` and compare by reference). Record each `.insert(table).values(v)` into `writes.inserts` as `{ table, values: v }` and each `.update(table).set(v)` into `writes.updates`. Then assert against `writes`. Keep the two scaffolded cases above and flesh them into real assertions before implementing.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && pnpm vitest run src/services/unifi/unifiSyncService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sync service**

Create `apps/api/src/services/unifi/unifiSyncService.ts`:

```typescript
import { and, eq, sql } from 'drizzle-orm';
import { unifiSiteMappings, unifiDevices, unifiSyncRuns, discoveredAssets } from '../../db/schema';
import type { DbExecutor } from './unifiConnectionService';
import type { UnifiClient, UnifiDeviceDto } from './unifiClient';

export interface SyncRunResult {
  hostsSeen: number;
  devicesCreated: number;
  devicesUpdated: number;
  devicesUnchanged: number;
  devicesRemoved: number;
  status: 'success' | 'partial' | 'failed';
  error?: string;
}

// Map UniFi device.type -> discovered_asset_type enum value.
function assetType(deviceType: string | null): 'switch' | 'access_point' | 'router' | 'firewall' | 'unknown' {
  switch ((deviceType ?? '').toLowerCase()) {
    case 'usw': case 'switch': return 'switch';
    case 'uap': case 'ap': return 'access_point';
    case 'ugw': case 'usg': case 'udm': case 'gateway': return 'router';
    default: return 'unknown';
  }
}
function unifiToBreezeDeviceType(deviceType: string | null): 'gateway' | 'switch' | 'ap' | 'other' {
  switch ((deviceType ?? '').toLowerCase()) {
    case 'usw': case 'switch': return 'switch';
    case 'uap': case 'ap': return 'ap';
    case 'ugw': case 'usg': case 'udm': case 'gateway': return 'gateway';
    default: return 'other';
  }
}

// Find-or-create a discovered_assets row for a UniFi device; return its id.
async function reconcileDiscoveredAsset(
  db: DbExecutor,
  device: UnifiDeviceDto,
  mapping: { orgId: string; siteId: string }
): Promise<string | null> {
  if (!device.ip) return null; // discovered_assets.ip_address is NOT NULL — cannot create without an IP
  const aType = assetType(device.deviceType);

  // 1. Match by (org_id, mac) first — the stable identifier.
  let existing: any | null = null;
  if (device.mac) {
    const byMac = await db
      .select({ id: discoveredAssets.id })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.orgId, mapping.orgId), eq(discoveredAssets.macAddress, device.mac)))
      .limit(1);
    existing = byMac[0] ?? null;
  }
  // 2. Fall back to the (org_id, ip_address) unique key.
  if (!existing) {
    const byIp = await db
      .select({ id: discoveredAssets.id })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.orgId, mapping.orgId), sql`${discoveredAssets.ipAddress} = ${device.ip}`))
      .limit(1);
    existing = byIp[0] ?? null;
  }

  const enrich = {
    macAddress: device.mac ?? undefined,
    hostname: device.name ?? undefined,
    manufacturer: 'Ubiquiti',
    model: device.model ?? undefined,
    assetType: aType,
    isOnline: device.adoptionState === 'CONNECTED',
    lastSeenAt: new Date(),
  };

  if (existing) {
    await db.update(discoveredAssets).set(enrich).where(eq(discoveredAssets.id, existing.id));
    return existing.id;
  }

  // Net-new: insert, absorbing a race with agent discovery via the (org,ip) unique key.
  const inserted = await db
    .insert(discoveredAssets)
    .values({ orgId: mapping.orgId, siteId: mapping.siteId, ipAddress: device.ip, ...enrich })
    .onConflictDoUpdate({ target: [discoveredAssets.orgId, discoveredAssets.ipAddress], set: enrich })
    .returning({ id: discoveredAssets.id });
  return inserted[0]?.id ?? null;
}

export async function syncIntegration(
  deps: { db: DbExecutor; client: UnifiClient },
  integration: { id: string; partnerId: string },
  trigger: 'scheduled' | 'manual'
): Promise<SyncRunResult> {
  const { db, client } = deps;
  const result: SyncRunResult = {
    hostsSeen: 0, devicesCreated: 0, devicesUpdated: 0, devicesUnchanged: 0, devicesRemoved: 0, status: 'success',
  };

  const [run] = await db.insert(unifiSyncRuns).values({
    integrationId: integration.id, partnerId: integration.partnerId, trigger, status: 'running',
  }).returning({ id: unifiSyncRuns.id });

  try {
    const mappings = await db.select().from(unifiSiteMappings)
      .where(eq(unifiSiteMappings.integrationId, integration.id));
    const hosts = await client.listHosts();
    result.hostsSeen = hosts.length;

    const seenDeviceIds = new Set<string>();
    let anySiteFailed = false;

    for (const mapping of mappings) {
      try {
        const devices = await client.listDevices(mapping.unifiHostId);
        const metrics = await client.getIspMetrics(mapping.unifiSiteId);
        await db.update(unifiSiteMappings)
          .set({ wanMetrics: metrics?.raw ?? null, wanMetricsAt: new Date(), updatedAt: new Date() })
          .where(eq(unifiSiteMappings.id, mapping.id));

        for (const d of devices) {
          seenDeviceIds.add(d.unifiDeviceId);
          const discoveredAssetId = await reconcileDiscoveredAsset(db, d, mapping);

          const existing = await db.select({ id: unifiDevices.id, raw: unifiDevices.raw })
            .from(unifiDevices)
            .where(and(eq(unifiDevices.integrationId, integration.id), eq(unifiDevices.unifiDeviceId, d.unifiDeviceId)))
            .limit(1);

          const fields = {
            orgId: mapping.orgId, siteId: mapping.siteId, integrationId: integration.id, mappingId: mapping.id,
            discoveredAssetId, unifiDeviceId: d.unifiDeviceId, mac: d.mac, name: d.name, model: d.model,
            deviceType: unifiToBreezeDeviceType(d.deviceType), ipAddress: d.ip, firmwareVersion: d.firmwareVersion,
            firmwareUpdatable: d.firmwareUpdatable, adoptionState: d.adoptionState, uptimeSeconds: d.uptimeSeconds,
            isStale: false, lastSeenAt: new Date(), raw: d.raw, lastSyncedAt: new Date(), updatedAt: new Date(),
          };

          if (existing[0]) {
            const changed = JSON.stringify(existing[0].raw) !== JSON.stringify(d.raw);
            await db.update(unifiDevices).set(fields).where(eq(unifiDevices.id, existing[0].id));
            if (changed) result.devicesUpdated++; else result.devicesUnchanged++;
          } else {
            await db.insert(unifiDevices).values(fields);
            result.devicesCreated++;
          }
        }
      } catch (siteErr) {
        anySiteFailed = true;
        result.error = `site ${mapping.unifiSiteId}: ${(siteErr as Error).message}`;
      }
    }

    // Mark devices that disappeared this run as stale and unlink them.
    const allForIntegration = await db.select({ id: unifiDevices.id, unifiDeviceId: unifiDevices.unifiDeviceId })
      .from(unifiDevices).where(eq(unifiDevices.integrationId, integration.id));
    for (const row of allForIntegration) {
      if (!seenDeviceIds.has(row.unifiDeviceId)) {
        await db.update(unifiDevices)
          .set({ isStale: true, discoveredAssetId: null, updatedAt: new Date() })
          .where(eq(unifiDevices.id, row.id));
        result.devicesRemoved++;
      }
    }

    result.status = anySiteFailed ? 'partial' : 'success';
  } catch (err) {
    result.status = 'failed';
    result.error = (err as Error).message;
  }

  await db.update(unifiSyncRuns).set({
    status: result.status, finishedAt: new Date(), hostsSeen: result.hostsSeen,
    devicesCreated: result.devicesCreated, devicesUpdated: result.devicesUpdated,
    devicesUnchanged: result.devicesUnchanged, devicesRemoved: result.devicesRemoved, error: result.error ?? null,
  }).where(eq(unifiSyncRuns.id, run.id));

  return result;
}
```

- [ ] **Step 4: Flesh out and run the tests**

Complete the `scriptedDb` harness from Step 1 (dispatch on table identity, record writes), assert `devicesCreated === 1` + a `discoveredAssets` insert for the net-new case, and `devicesUnchanged === 1` when `existing.raw` deep-equals the incoming `raw`. Then run:
```bash
cd apps/api && pnpm vitest run src/services/unifi/unifiSyncService.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/unifi/unifiSyncService.ts apps/api/src/services/unifi/unifiSyncService.test.ts
git commit -m "feat(unifi): sync service with discovered_assets reconciliation + ledger"
```

---

## Task 6: BullMQ worker (queue, scheduler, processor)

**Files:**
- Create: `apps/api/src/jobs/unifiWorker.ts`
- Modify: `apps/api/src/index.ts` (call `initializeUnifiWorker()` where other workers init)

**Interfaces:**
- Consumes: `createInstrumentedQueue` (`../services/bullmqQueue`), `getBullMQConnection` (`../services/redis`), `withSystemDbAccessContext`, `getDbContext`/`db` accessor (`../db`), `syncIntegration` (Task 5), `getDecryptedApiKey`/`markStatus`/`markSynced` (Task 4), `createUnifiClient` (Task 3), `unifiIntegrations` schema.
- Produces (consumed by Task 7): `getUnifiSyncQueue(): Queue`, `enqueueUnifiSync(integrationId: string, partnerId: string, trigger: 'manual'): Promise<void>`, `initializeUnifiWorker(): Promise<void>`.

- [ ] **Step 1: Write the worker**

Create `apps/api/src/jobs/unifiWorker.ts`:

```typescript
import { Worker, type Job, type Queue } from 'bullmq';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { getBullMQConnection } from '../services/redis';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { unifiIntegrations } from '../db/schema';
import { createUnifiClient } from '../services/unifi/unifiClient';
import { syncIntegration } from '../services/unifi/unifiSyncService';
import { getDecryptedApiKey, markStatus, markSynced } from '../services/unifi/unifiConnectionService';

export const UNIFI_SYNC_QUEUE = 'unifi-sync';

const jobSchema = z.union([
  z.object({ type: z.literal('sync-scheduler') }),
  z.object({ type: z.literal('sync-integration'), integrationId: z.string(), partnerId: z.string(), trigger: z.enum(['scheduled', 'manual']) }),
]);
type UnifiJobData = z.infer<typeof jobSchema>;

let queue: Queue<UnifiJobData> | null = null;
export function getUnifiSyncQueue(): Queue<UnifiJobData> {
  if (!queue) queue = createInstrumentedQueue<UnifiJobData>(UNIFI_SYNC_QUEUE);
  return queue;
}

export async function enqueueUnifiSync(integrationId: string, partnerId: string, trigger: 'manual'): Promise<void> {
  // Route handlers run inside a held DB context; the instrumented queue forbids enqueue there.
  await runOutsideDbContext(() =>
    getUnifiSyncQueue().add('sync-integration', { type: 'sync-integration', integrationId, partnerId, trigger })
  );
}

async function processScheduler(): Promise<void> {
  // Enumerate active integrations under system context, enqueue one job each.
  const rows = await withSystemDbAccessContext(() =>
    db.select({ id: unifiIntegrations.id, partnerId: unifiIntegrations.partnerId })
      .from(unifiIntegrations).where(eq(unifiIntegrations.isActive, true))
  );
  for (const r of rows) {
    await getUnifiSyncQueue().add('sync-integration', {
      type: 'sync-integration', integrationId: r.id, partnerId: r.partnerId, trigger: 'scheduled',
    });
  }
}

async function processSyncIntegration(data: Extract<UnifiJobData, { type: 'sync-integration' }>): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const apiKey = await getDecryptedApiKey(db, data.partnerId);
    if (!apiKey) {
      await markStatus(db, data.integrationId, data.partnerId, 'reauth_required', 'No API key on connection');
      return;
    }
    const [row] = await db.select({ baseUrl: unifiIntegrations.baseUrl })
      .from(unifiIntegrations).where(eq(unifiIntegrations.id, data.integrationId)).limit(1);
    const client = createUnifiClient({ baseUrl: row?.baseUrl ?? 'https://api.ui.com', apiKey });
    try {
      const result = await syncIntegration({ db, client }, { id: data.integrationId, partnerId: data.partnerId }, data.trigger);
      await markSynced(db, data.integrationId, data.partnerId, result.status, result.error ?? null);
      if (result.status !== 'failed') {
        await markStatus(db, data.integrationId, data.partnerId, 'connected', result.error ?? null);
      }
    } catch (err) {
      const msg = (err as Error).message;
      const authFailed = /\b401\b|unauthorized/i.test(msg);
      await markStatus(db, data.integrationId, data.partnerId, authFailed ? 'reauth_required' : 'error', msg);
      await markSynced(db, data.integrationId, data.partnerId, 'failed', msg);
    }
  });
}

function createWorker(): Worker<UnifiJobData> {
  return new Worker<UnifiJobData>(
    UNIFI_SYNC_QUEUE,
    async (job: Job<UnifiJobData>) => {
      const data = jobSchema.parse(job.data);
      if (data.type === 'sync-scheduler') return processScheduler();
      return processSyncIntegration(data);
    },
    { connection: getBullMQConnection(), concurrency: 3, lockDuration: 300_000, stalledInterval: 60_000, maxStalledCount: 2 }
  );
}

let workerInstance: Worker<UnifiJobData> | null = null;
export async function initializeUnifiWorker(): Promise<void> {
  workerInstance = createWorker();
  workerInstance.on('error', (e) => console.error('[UnifiWorker] error:', e));
  workerInstance.on('failed', (job, e) => console.error(`[UnifiWorker] job ${job?.id} failed:`, e));

  const q = getUnifiSyncQueue();
  for (const j of await q.getRepeatableJobs()) {
    if (j.name === 'sync-scheduler') await q.removeRepeatableByKey(j.key);
  }
  await q.add('sync-scheduler', { type: 'sync-scheduler' }, {
    repeat: { every: 30 * 60 * 1000 }, attempts: 1, removeOnComplete: { count: 10 }, removeOnFail: { count: 20 },
  });
  console.log('[UnifiWorker] initialized (sync every 30m)');
}
```

> Verify the exact import surface of `../db` (the extraction confirmed `withSystemDbAccessContext` and `runOutsideDbContext` live in `apps/api/src/db/index.ts`; confirm a `db` query handle is exported there or import the request-context `db` the other workers use). Match whatever `monitorWorker.ts` imports.

- [ ] **Step 2: Register worker startup**

In `apps/api/src/index.ts`, find the call to `initializeMonitorWorker()` (grep: `grep -n initializeMonitorWorker apps/api/src/index.ts`) and add next to it:

```typescript
import { initializeUnifiWorker } from './jobs/unifiWorker';
// ... in the same startup block that awaits initializeMonitorWorker():
await initializeUnifiWorker();
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && pnpm tsc --noEmit` (or the repo's `pnpm -F @breeze/api typecheck`).
Expected: no type errors in `unifiWorker.ts` / `index.ts`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/jobs/unifiWorker.ts apps/api/src/index.ts
git commit -m "feat(unifi): BullMQ sync worker + 30m scheduler"
```

---

## Task 7: Partner-scoped routes

**Files:**
- Create: `apps/api/src/routes/unifi/index.ts`
- Create: `apps/api/src/routes/unifi/index.test.ts`
- Modify: `apps/api/src/index.ts` (mount `unifiRoutes`)

**Interfaces:**
- Consumes: `authMiddleware`, `requireScope`, `requirePermission`, `PERMISSIONS` (`../../middleware/auth`, `../../services/permissions`); the Task 4 service; `enqueueUnifiSync` (Task 6); `createUnifiClient` (Task 3); the request-context `db`; `unifiSiteMappings`, `unifiSyncRuns`, `sites` schema.
- Produces: `export const unifiRoutes` (a Hono app), mounted at `/unifi`.

- [ ] **Step 1: Write the failing route test**

Create `apps/api/src/routes/unifi/index.test.ts`. Follow the repo's existing route-test harness (mock `../../middleware/auth` to inject a partner-scoped `auth`, mock the service module). Minimum cases:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/unifi/unifiConnectionService', () => ({
  getConnection: vi.fn(),
  upsertConnection: vi.fn(),
  deleteConnection: vi.fn(),
  markStatus: vi.fn(),
}));

// Mock auth middleware to set a partner-scoped auth context (match the repo's existing approach).
vi.mock('../../middleware/auth', async (orig) => {
  const actual = await (orig as any)();
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => { c.set('auth', { scope: 'partner', partnerId: 'partner-1', user: { id: 'u1' } }); return next(); },
    requireScope: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
    requireMfa: () => (_c: any, next: any) => next(),
  };
});

import { unifiRoutes } from './index';
import * as svc from '../../services/unifi/unifiConnectionService';

describe('unifi routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /unifi returns disconnected when no connection', async () => {
    (svc.getConnection as any).mockResolvedValue(null);
    const res = await unifiRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connected: false });
  });

  it('POST /unifi/disconnect calls deleteConnection for the partner', async () => {
    (svc.deleteConnection as any).mockResolvedValue(true);
    const res = await unifiRoutes.request('/disconnect', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(svc.deleteConnection).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && pnpm vitest run src/routes/unifi/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the routes**

Create `apps/api/src/routes/unifi/index.ts`:

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import { authMiddleware, requireScope, requirePermission, requireMfa } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { db } from '../../db';
import { unifiSiteMappings, unifiSyncRuns, sites } from '../../db/schema';
import { createUnifiClient } from '../../services/unifi/unifiClient';
import { getConnection, upsertConnection, deleteConnection } from '../../services/unifi/unifiConnectionService';
import { enqueueUnifiSync, getUnifiSyncQueue } from '../../jobs/unifiWorker';

export const unifiRoutes = new Hono();
unifiRoutes.use('*', authMiddleware);

const read = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const write = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

function resolvePartnerId(c: any): { partnerId: string } | { error: string; status: 400 | 403 } {
  const auth = c.get('auth');
  if (auth?.scope === 'partner') {
    if (!auth.partnerId) return { error: 'Partner context required', status: 403 };
    return { partnerId: auth.partnerId };
  }
  const requested = c.req.query('partnerId');
  if (!requested) return { error: 'partnerId is required for this scope', status: 400 };
  return { partnerId: requested };
}

const connectSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  accountLabel: z.string().max(200).optional(),
});
const mappingsSchema = z.object({
  mappings: z.array(z.object({
    unifiHostId: z.string(), unifiSiteId: z.string(),
    unifiHostName: z.string().optional(), unifiSiteName: z.string().optional(),
    siteId: z.string().guid(),
  })),
});

// GET /unifi — connection status
unifiRoutes.get('/', requireScope('partner', 'system'), read, async (c) => {
  const r = resolvePartnerId(c);
  if ('error' in r) return c.json({ error: r.error }, r.status);
  const conn = await getConnection(db, r.partnerId);
  if (!conn) return c.json({ connected: false });
  return c.json({ connected: true, status: conn.status, accountLabel: conn.accountLabel,
    lastSyncAt: conn.lastSyncAt, lastSyncStatus: conn.lastSyncStatus, lastSyncError: conn.lastSyncError });
});

// POST /unifi/connect — validate key then store
unifiRoutes.post('/connect', requireScope('partner', 'system'), write, requireMfa(),
  zValidator('json', connectSchema), async (c) => {
    const r = resolvePartnerId(c);
    if ('error' in r) return c.json({ error: r.error }, r.status);
    const auth = c.get('auth');
    const { apiKey, baseUrl, accountLabel } = c.req.valid('json');
    const base = baseUrl ?? 'https://api.ui.com';
    try {
      await createUnifiClient({ baseUrl: base, apiKey }).listHosts(); // validate
    } catch {
      return c.json({ success: false, message: 'Could not validate the UniFi API key.' }, 400);
    }
    const conn = await upsertConnection(db, r.partnerId, { baseUrl: base, apiKey, accountLabel, createdBy: auth?.user?.id });
    return c.json({ connected: true, status: conn.status });
  });

// POST /unifi/test — re-validate stored key
unifiRoutes.post('/test', requireScope('partner', 'system'), write, async (c) => {
  const r = resolvePartnerId(c);
  if ('error' in r) return c.json({ error: r.error }, r.status);
  const conn = await getConnection(db, r.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  await enqueueUnifiSync(conn.id, r.partnerId, 'manual');
  return c.json({ success: true });
});

// POST /unifi/disconnect
unifiRoutes.post('/disconnect', requireScope('partner', 'system'), write, async (c) => {
  const r = resolvePartnerId(c);
  if ('error' in r) return c.json({ error: r.error }, r.status);
  const ok = await deleteConnection(db, r.partnerId);
  return c.json({ success: ok });
});

// GET /unifi/hosts — live host/site list for mapping UI
unifiRoutes.get('/hosts', requireScope('partner', 'system'), read, async (c) => {
  const r = resolvePartnerId(c);
  if ('error' in r) return c.json({ error: r.error }, r.status);
  const conn = await getConnection(db, r.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  // getDecryptedApiKey lives in the service; import and use it here.
  return c.json({ hosts: [] }); // implementer: call client.listHosts()+listSites(), join, return shape {hosts:[{id,name,sites:[{id,name}]}]}
});

// PUT /unifi/mappings — set site->Breeze-site mappings (derive org_id from chosen site)
unifiRoutes.put('/mappings', requireScope('partner', 'system'), write, zValidator('json', mappingsSchema), async (c) => {
  const r = resolvePartnerId(c);
  if ('error' in r) return c.json({ error: r.error }, r.status);
  const conn = await getConnection(db, r.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  const { mappings } = c.req.valid('json');
  for (const m of mappings) {
    const [site] = await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(eq(sites.id, m.siteId)).limit(1);
    if (!site) return c.json({ success: false, message: `Unknown site ${m.siteId}` }, 400);
    await db.insert(unifiSiteMappings).values({
      integrationId: conn.id, orgId: site.orgId, siteId: site.id,
      unifiHostId: m.unifiHostId, unifiSiteId: m.unifiSiteId,
      unifiHostName: m.unifiHostName ?? null, unifiSiteName: m.unifiSiteName ?? null,
    }).onConflictDoUpdate({
      target: [unifiSiteMappings.integrationId, unifiSiteMappings.unifiHostId, unifiSiteMappings.unifiSiteId],
      set: { orgId: site.orgId, siteId: site.id, unifiHostName: m.unifiHostName ?? null, unifiSiteName: m.unifiSiteName ?? null, updatedAt: new Date() },
    });
  }
  return c.json({ success: true });
});

// POST /unifi/sync — manual trigger
unifiRoutes.post('/sync', requireScope('partner', 'system'), write, async (c) => {
  const r = resolvePartnerId(c);
  if ('error' in r) return c.json({ error: r.error }, r.status);
  const conn = await getConnection(db, r.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  await enqueueUnifiSync(conn.id, r.partnerId, 'manual');
  return c.json({ success: true });
});

// GET /unifi/sync-runs — ledger history
unifiRoutes.get('/sync-runs', requireScope('partner', 'system'), read, async (c) => {
  const r = resolvePartnerId(c);
  if ('error' in r) return c.json({ error: r.error }, r.status);
  const conn = await getConnection(db, r.partnerId);
  if (!conn) return c.json({ runs: [] });
  const runs = await db.select().from(unifiSyncRuns)
    .where(eq(unifiSyncRuns.integrationId, conn.id))
    .orderBy(desc(unifiSyncRuns.startedAt)).limit(20);
  return c.json({ runs });
});
```

> Two implementer to-dos flagged inline: (a) `/unifi/hosts` must call `getDecryptedApiKey` + the client and return `{hosts:[{id,name,sites:[...]}]}`; (b) confirm `sites.orgId` is the column name (grep `apps/api/src/db/schema/orgs.ts`). Keep handlers returning `{success:false,...}` bodies so the web `runAction` surfaces failures.

- [ ] **Step 4: Mount the routes**

In `apps/api/src/index.ts`, near the other `api.route(...)` mounts:

```typescript
import { unifiRoutes } from './routes/unifi';
// ...
api.route('/unifi', unifiRoutes);
```

- [ ] **Step 5: Run the route tests**

Run: `cd apps/api && pnpm vitest run src/routes/unifi/index.test.ts`
Expected: PASS (both cases). Add cases for `/connect` validation failure and `/mappings` org derivation as you implement.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/unifi/index.ts apps/api/src/routes/unifi/index.test.ts apps/api/src/index.ts
git commit -m "feat(unifi): partner-scoped routes (connect/mappings/sync/ledger)"
```

---

## Task 8: Web integration component

**Files:**
- Create: `apps/web/src/components/integrations/UnifiIntegration.tsx`
- Modify: `apps/web/src/components/integrations/IntegrationsPage.tsx`

**Interfaces:**
- Consumes: `runAction`, `ActionError`, `handleActionError` (`../../lib/runAction`); `fetchWithAuth` (`../../stores/auth`); `showToast` (the toast singleton used by `QuickbooksIntegration.tsx`); `getJwtClaims`, `navigateTo`, `loginPathWithNext` (same imports `QuickbooksIntegration.tsx` uses).

- [ ] **Step 1: Build the component**

Create `apps/web/src/components/integrations/UnifiIntegration.tsx`, modeled on `QuickbooksIntegration.tsx` (same imports/patterns). Core shape:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { runAction, ActionError, handleActionError } from '../../lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../ui/Toast'; // match QuickbooksIntegration's toast import path
import { getJwtClaims, navigateTo, loginPathWithNext } from '../../stores/auth'; // match QB's actual import sources

interface UnifiStatus {
  connected: boolean;
  status?: string;
  accountLabel?: string | null;
  lastSyncAt?: string | null;
  lastSyncStatus?: string | null;
  lastSyncError?: string | null;
}

export default function UnifiIntegration() {
  const claims = getJwtClaims();
  const isOrgScoped = claims.scope === 'organization';
  const [status, setStatus] = useState<UnifiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);

  const onUnauthorized = useCallback(() => navigateTo(loginPathWithNext()), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/unifi');
      if (res.status === 401) return onUnauthorized();
      setStatus(await res.json());
    } finally { setLoading(false); }
  }, [onUnauthorized]);

  useEffect(() => { if (!isOrgScoped) void load(); else setLoading(false); }, [isOrgScoped, load]);

  const handleConnect = useCallback(async () => {
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/unifi/connect', { method: 'POST', body: JSON.stringify({ apiKey }) }),
        errorFallback: 'Could not connect UniFi.',
        successMessage: 'UniFi connected',
        onUnauthorized,
      });
      setApiKey('');
      await load();
    } catch (err) { if (!(err instanceof ActionError)) handleActionError(err, 'Could not connect UniFi.'); }
    finally { setBusy(false); }
  }, [apiKey, load, onUnauthorized]);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/unifi/disconnect', { method: 'POST' }),
        errorFallback: 'Could not disconnect UniFi.', successMessage: 'UniFi disconnected', onUnauthorized,
      });
      await load();
    } catch (err) { if (!(err instanceof ActionError)) handleActionError(err, 'Could not disconnect UniFi.'); }
    finally { setBusy(false); }
  }, [load, onUnauthorized]);

  const handleSync = useCallback(async () => {
    setBusy(true);
    try {
      await runAction({ request: () => fetchWithAuth('/unifi/sync', { method: 'POST' }),
        errorFallback: 'Could not start a sync.', successMessage: 'Sync started', onUnauthorized });
    } catch (err) { if (!(err instanceof ActionError)) handleActionError(err, 'Could not start a sync.'); }
    finally { setBusy(false); }
  }, [onUnauthorized]);

  if (isOrgScoped) return <p className="py-12 text-center text-sm text-muted-foreground">UniFi is available to partner accounts only.</p>;
  if (loading) return <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>;

  if (!status?.connected) {
    return (
      <div className="space-y-3" data-testid="unifi-disconnected">
        <p className="text-sm text-muted-foreground">Paste a UniFi Site Manager API key (generate one at unifi.ui.com → Settings → API Keys).</p>
        <input data-testid="unifi-api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder="UniFi API key" className="w-full rounded border px-3 py-2 text-sm" />
        <button data-testid="unifi-connect" disabled={busy || !apiKey} onClick={handleConnect}
          className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">Connect</button>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="unifi-connected">
      <div className="text-sm">Status: <strong>{status.status}</strong>{status.lastSyncAt ? ` · last sync ${new Date(status.lastSyncAt).toLocaleString()} (${status.lastSyncStatus})` : ' · never synced'}</div>
      {status.lastSyncError && <div className="text-sm text-red-600">{status.lastSyncError}</div>}
      <div className="flex gap-2">
        <button data-testid="unifi-sync" disabled={busy} onClick={handleSync} className="rounded border px-4 py-2 text-sm disabled:opacity-50">Sync now</button>
        <button data-testid="unifi-disconnect" disabled={busy} onClick={handleDisconnect} className="rounded border px-4 py-2 text-sm text-red-600 disabled:opacity-50">Disconnect</button>
      </div>
      {/* Site-mapping table + sync-run history table are added here, fed by GET /unifi/hosts and GET /unifi/sync-runs. */}
    </div>
  );
}
```

> Match the exact import sources for `showToast`/`getJwtClaims`/`navigateTo`/`loginPathWithNext` to whatever `QuickbooksIntegration.tsx` imports (the extraction confirmed these symbols exist; copy its import lines). Use Tailwind classes consistent with the surrounding components.

- [ ] **Step 2: Register the tab on the Integrations page**

In `apps/web/src/components/integrations/IntegrationsPage.tsx`:
1. Add the import: `import UnifiIntegration from './UnifiIntegration';`
2. Add a top-level tab entry `unifi` (label `"UniFi"`) to the tab list, gated partner-only like the accounting tab.
3. Add the render branch: `{activeTab === 'unifi' && !isOrgScoped && <UnifiIntegration />}` (and the org-scoped notice mirroring the accounting one).

> Mirror exactly how `HuntressIntegration`/`Pax8Integration` are registered as their own tabs in this file (the extraction showed the accounting sub-tab + render-branch pattern; reuse it for a top-level `unifi` tab).

- [ ] **Step 3: Typecheck + web tests**

Run:
```bash
cd apps/web && pnpm vitest run && pnpm astro check
```
Expected: existing suite stays green; no type errors. (No new web unit test is strictly required for Phase 1; the component is exercised in feature testing. If you add one, mock `fetchWithAuth` and assert the disconnected→connected render flip.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/integrations/UnifiIntegration.tsx apps/web/src/components/integrations/IntegrationsPage.tsx
git commit -m "feat(unifi): web integration panel (connect/sync/disconnect)"
```

---

## Final verification

- [ ] **Step 1: Full API + web suites green**

```bash
pnpm test --filter=@breeze/api
cd apps/web && pnpm vitest run
```

- [ ] **Step 2: RLS integration suite green**

```bash
cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```

- [ ] **Step 3: Live forge check (as `breeze_app`)**

Per CLAUDE.md, forge a cross-tenant insert via psql and confirm it fails:
```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "insert into unifi_integrations(partner_id, api_key_encrypted) values (gen_random_uuid(),'x');"
```
Expected: `ERROR: new row violates row-level security policy for table "unifi_integrations"`.

- [ ] **Step 4: Manual smoke (optional, needs a real Ubiquiti account)**

Connect with a real Site Manager key, map one UniFi site to a Breeze site, trigger a sync, and confirm devices appear in `unifi_devices` and linked rows in `discovered_assets`, plus a `unifi_sync_runs` row with sane counts.

---

## Self-Review notes (coverage map)

- Spec "four tables + RLS" → Task 1. Allowlist + forge → Task 2.
- "thin typed client, 429/Retry-After, envelope" → Task 3 (Retry-After/backoff: see follow-up note below).
- "connection service w/ DbExecutor seam, encrypted key, guarded writes" → Task 4.
- "sync orchestration + reconciliation + ledger, partial status, stale-on-disappear" → Task 5.
- "instrumented queue, system context, 30m scheduler, reauth on auth failure" → Task 6.
- "connect/test/disconnect/hosts/mappings/sync/sync-runs, no OAuth" → Task 7.
- "connect/sync/disconnect UI, partner-only, runAction" → Task 8.

**Known follow-ups deferred within Phase 1 (not blockers, do as polish):**
- `unifiClient` 429 `Retry-After` handling is described in the spec but not yet in the Task 3 code — add a bounded retry wrapper in `get()` before shipping if a live key rate-limits.
- `/unifi/hosts` handler body and the UI mapping/history tables are scaffolded with explicit implementer to-dos (Tasks 7 & 8) — complete them against the live host/site shape.
