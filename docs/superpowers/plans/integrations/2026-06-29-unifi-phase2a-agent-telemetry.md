# UniFi Phase 2a — Agent-Side Deep Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A designated Breeze agent at each customer site polls the on-site UniFi controller's official Network Integration API (read-only) and pushes per-device PoE/health and current-client telemetry into Breeze, linked to the existing network model.

**Architecture:** Extends the Phase 1 UniFi integration. A new per-console `unifi_collectors` config row (attached to the Phase 1 `unifi_site_mappings`) names a collector agent + local controller URL + encrypted local API key. The agent pulls its collector configs from a new agent-role endpoint, polls the controller on a schedule, and POSTs batched telemetry to a new agent-role ingest endpoint. The ingest route enqueues to a BullMQ worker that reconciles into three new current-state tables (snapshot semantics, org-axis RLS) and enriches `discovered_assets` by MAC. No control/write actions (Phase 2b), no time-series, no per-poll ledger.

**Tech Stack:** Hono + TypeScript (API), Drizzle ORM + PostgreSQL (forced RLS), BullMQ + Redis, Go (agent: `net/http`, `crypto/tls`), Astro + React (web), Vitest (API/web), Go `testing` (agent).

**Spec:** `docs/superpowers/specs/integrations/2026-06-29-unifi-phase2a-agent-telemetry-design.md`

## Global Constraints

- **RLS is mandatory.** All three new tables are shape-1 (direct `org_id`): `ENABLE` + `FORCE ROW LEVEL SECURITY` + SELECT/INSERT/UPDATE/DELETE policies on `public.breeze_has_org_access(org_id)`, **in the same migration that creates each table**. Shape-1 tables are auto-discovered by `rls-coverage.integration.test.ts` (no allowlist entry) — but add cross-org forge tests.
- **Migrations:** hand-written SQL in `apps/api/migrations/`, filename `2026-06-29-<slug>.sql`. Idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`, `DO $$ … EXCEPTION` for constraints). No inner `BEGIN;`/`COMMIT;`. Never edit a shipped migration.
- **Secrets:** the local API key is encrypted at rest via `apps/api/src/services/secretCrypto.ts` `encryptSecret(value, { aad })` / `decryptForColumn(table, column, value)`, AAD bound to `unifi_collectors.local_api_key_encrypted`. Never log or return a decrypted key except over the agent-role pull endpoint to the owning agent.
- **DB context:** request handlers run inside `withDbAccessContext`; background/agent-ingest work runs inside `withSystemDbAccessContext`. `createInstrumentedQueue(...).add()` throws inside a held DB context — wrap route-side enqueues in `runOutsideDbContext(() => queue.add(...))`.
- **0-row writes are bugs:** every guarded UPDATE/DELETE uses `.where(and(...))` + `.returning({ id })` and throws/returns-false on `length === 0`.
- **Web mutations** go through `runAction` (`apps/web/src/lib/runAction.ts`); catch with the `ActionError`/`handleActionError` pattern.
- **Read-only against UniFi:** the agent issues only `GET`s to the controller. No restart/PoE/block/firmware actions this phase.
- **Agent release:** the new agent capability requires a build + promote per repo convention (bare semver, no `v` prefix in code/config; `AGENT_AUTO_PROMOTE=false`).
- **Drizzle is for queries only.** Do not run `drizzle-kit generate`/`push`. After schema edits run `pnpm db:check-drift`.

---

## File Structure

**Create:**
- `apps/api/migrations/2026-06-29-unifi-phase2a-telemetry.sql` — 3 tables + RLS
- `apps/api/src/services/unifi/unifiCollectorService.ts` — collector CRUD + crypto seam + agent-pull query
- `apps/api/src/services/unifi/unifiCollectorService.test.ts`
- `apps/api/src/services/unifi/unifiTelemetryService.ts` — reconciliation (snapshot upsert/stale + discovered_assets enrich)
- `apps/api/src/services/unifi/unifiTelemetryService.test.ts`
- `apps/api/src/jobs/unifiTelemetryWorker.ts` — BullMQ queue + worker
- `apps/api/src/routes/agent/unifiTelemetry.ts` — agent-role ingest + collector-pull endpoints
- `apps/api/src/routes/agent/unifiTelemetry.test.ts`
- `agent/internal/unifi/client.go` — Network Integration API client
- `agent/internal/unifi/client_test.go`
- `agent/internal/unifi/collector.go` — scheduler + payload assembly + upload
- `agent/internal/unifi/collector_test.go`

**Modify:**
- `apps/api/src/db/schema/unifi.ts` — add `unifiCollectors`, `unifiDeviceTelemetry`, `unifiClients`
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — cross-org forge tests
- `apps/api/src/routes/unifi/index.ts` — add `/collectors` (GET/PUT/DELETE) + `/telemetry` (GET)
- `apps/api/src/routes/unifi/index.test.ts` — collector + telemetry route cases
- `apps/api/src/index.ts` — mount `agentUnifiRoutes`, call `initializeUnifiTelemetryWorker()`
- `agent/internal/config/config.go` — config struct fields for collector cache (if any persisted)
- `agent/cmd/.../main.go` (the agent entrypoint that starts periodic collectors) — start the UniFi collector loop
- `apps/web/src/components/integrations/UnifiIntegration.tsx` — collector config UI + telemetry panel

---

## Task 1: Schema + migration (3 tables, RLS)

**Files:**
- Create: `apps/api/migrations/2026-06-29-unifi-phase2a-telemetry.sql`
- Modify: `apps/api/src/db/schema/unifi.ts`

**Interfaces:**
- Produces (consumed by all later API tasks): `unifiCollectors`, `unifiDeviceTelemetry`, `unifiClients` from `apps/api/src/db/schema/unifi.ts`.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-29-unifi-phase2a-telemetry.sql`:

```sql
-- UniFi Phase 2a: agent-side deep telemetry (read-only). Three org-axis tables.

-- 1. unifi_collectors (per-console config; org-axis = collector agent's org) ----
CREATE TABLE IF NOT EXISTS unifi_collectors (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id          uuid NOT NULL REFERENCES unifi_integrations(id) ON DELETE CASCADE,
  org_id                  uuid NOT NULL REFERENCES organizations(id),
  site_id                 uuid NOT NULL REFERENCES sites(id),
  unifi_host_id           text NOT NULL,
  collector_device_id     uuid NOT NULL REFERENCES devices(id),
  controller_url          text NOT NULL,
  local_api_key_encrypted text NOT NULL,
  is_enabled              boolean NOT NULL DEFAULT true,
  poll_interval_seconds   integer NOT NULL DEFAULT 60,
  status                  varchar(20) NOT NULL DEFAULT 'pending',
  firmware_ok             boolean,
  last_poll_at            timestamptz,
  last_poll_status        varchar(16),
  last_poll_error         text,
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_collectors_integration_host_idx
  ON unifi_collectors(integration_id, unifi_host_id);
CREATE INDEX IF NOT EXISTS unifi_collectors_device_idx
  ON unifi_collectors(collector_device_id) WHERE is_enabled;

ALTER TABLE unifi_collectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_collectors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON unifi_collectors;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON unifi_collectors;
DROP POLICY IF EXISTS breeze_org_isolation_update ON unifi_collectors;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON unifi_collectors;
CREATE POLICY breeze_org_isolation_select ON unifi_collectors
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON unifi_collectors
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON unifi_collectors
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON unifi_collectors
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 2. unifi_device_telemetry (latest per-device snapshot; org-axis) -------------
CREATE TABLE IF NOT EXISTS unifi_device_telemetry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id      uuid NOT NULL REFERENCES unifi_collectors(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES organizations(id),
  site_id           uuid NOT NULL REFERENCES sites(id),
  unifi_device_id   text NOT NULL,
  mac               text,
  name              text,
  uptime_seconds    bigint,
  cpu_pct           real,
  mem_pct           real,
  tx_bytes          bigint,
  rx_bytes          bigint,
  num_clients       integer,
  poe_ports         jsonb,
  raw               jsonb NOT NULL,
  is_stale          boolean NOT NULL DEFAULT false,
  last_seen_at      timestamptz,
  first_synced_at   timestamptz NOT NULL DEFAULT now(),
  last_synced_at    timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_device_telemetry_collector_device_idx
  ON unifi_device_telemetry(collector_id, unifi_device_id);
CREATE INDEX IF NOT EXISTS unifi_device_telemetry_org_idx
  ON unifi_device_telemetry(org_id, site_id);

ALTER TABLE unifi_device_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_device_telemetry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON unifi_device_telemetry;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON unifi_device_telemetry;
DROP POLICY IF EXISTS breeze_org_isolation_update ON unifi_device_telemetry;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON unifi_device_telemetry;
CREATE POLICY breeze_org_isolation_select ON unifi_device_telemetry
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON unifi_device_telemetry
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON unifi_device_telemetry
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON unifi_device_telemetry
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 3. unifi_clients (current client associations; org-axis) ---------------------
CREATE TABLE IF NOT EXISTS unifi_clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id        uuid NOT NULL REFERENCES unifi_collectors(id) ON DELETE CASCADE,
  org_id              uuid NOT NULL REFERENCES organizations(id),
  site_id             uuid NOT NULL REFERENCES sites(id),
  mac                 text NOT NULL,
  hostname            text,
  ip_address          inet,
  connected_device_id text,
  uplink_port_idx     integer,
  is_wired            boolean,
  ssid                text,
  vlan                integer,
  signal_dbm          integer,
  tx_bytes            bigint,
  rx_bytes            bigint,
  uptime_seconds      bigint,
  discovered_asset_id uuid REFERENCES discovered_assets(id),
  raw                 jsonb NOT NULL,
  is_stale            boolean NOT NULL DEFAULT false,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_clients_collector_mac_idx
  ON unifi_clients(collector_id, mac);
CREATE INDEX IF NOT EXISTS unifi_clients_org_mac_idx
  ON unifi_clients(org_id, mac);

ALTER TABLE unifi_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_clients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON unifi_clients;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON unifi_clients;
DROP POLICY IF EXISTS breeze_org_isolation_update ON unifi_clients;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON unifi_clients;
CREATE POLICY breeze_org_isolation_select ON unifi_clients
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON unifi_clients
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON unifi_clients
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON unifi_clients
  FOR DELETE USING (public.breeze_has_org_access(org_id));
```

- [ ] **Step 2: Add the Drizzle schema**

Append to `apps/api/src/db/schema/unifi.ts` (it already imports `organizations, partners, sites`, `users`, `discoveredAssets`; add `real` to the `drizzle-orm/pg-core` import list and import `devices`):

```typescript
import { real } from 'drizzle-orm/pg-core';
import { devices } from './devices';

export const unifiCollectors = pgTable('unifi_collectors', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().references(() => unifiIntegrations.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  unifiHostId: text('unifi_host_id').notNull(),
  collectorDeviceId: uuid('collector_device_id').notNull().references(() => devices.id),
  controllerUrl: text('controller_url').notNull(),
  localApiKeyEncrypted: text('local_api_key_encrypted').notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(60),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  firmwareOk: boolean('firmware_ok'),
  lastPollAt: timestamp('last_poll_at'),
  lastPollStatus: varchar('last_poll_status', { length: 16 }),
  lastPollError: text('last_poll_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  integrationHostIdx: uniqueIndex('unifi_collectors_integration_host_idx').on(table.integrationId, table.unifiHostId),
  deviceIdx: index('unifi_collectors_device_idx').on(table.collectorDeviceId).where(sql`${table.isEnabled}`),
}));

export const unifiDeviceTelemetry = pgTable('unifi_device_telemetry', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectorId: uuid('collector_id').notNull().references(() => unifiCollectors.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  unifiDeviceId: text('unifi_device_id').notNull(),
  mac: text('mac'),
  name: text('name'),
  uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
  cpuPct: real('cpu_pct'),
  memPct: real('mem_pct'),
  txBytes: bigint('tx_bytes', { mode: 'number' }),
  rxBytes: bigint('rx_bytes', { mode: 'number' }),
  numClients: integer('num_clients'),
  poePorts: jsonb('poe_ports'),
  raw: jsonb('raw').notNull(),
  isStale: boolean('is_stale').notNull().default(false),
  lastSeenAt: timestamp('last_seen_at'),
  firstSyncedAt: timestamp('first_synced_at').defaultNow().notNull(),
  lastSyncedAt: timestamp('last_synced_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  collectorDeviceIdx: uniqueIndex('unifi_device_telemetry_collector_device_idx').on(table.collectorId, table.unifiDeviceId),
  orgIdx: index('unifi_device_telemetry_org_idx').on(table.orgId, table.siteId),
}));

export const unifiClients = pgTable('unifi_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectorId: uuid('collector_id').notNull().references(() => unifiCollectors.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  mac: text('mac').notNull(),
  hostname: text('hostname'),
  ipAddress: inet('ip_address'),
  connectedDeviceId: text('connected_device_id'),
  uplinkPortIdx: integer('uplink_port_idx'),
  isWired: boolean('is_wired'),
  ssid: text('ssid'),
  vlan: integer('vlan'),
  signalDbm: integer('signal_dbm'),
  txBytes: bigint('tx_bytes', { mode: 'number' }),
  rxBytes: bigint('rx_bytes', { mode: 'number' }),
  uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
  discoveredAssetId: uuid('discovered_asset_id').references(() => discoveredAssets.id),
  raw: jsonb('raw').notNull(),
  isStale: boolean('is_stale').notNull().default(false),
  firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  collectorMacIdx: uniqueIndex('unifi_clients_collector_mac_idx').on(table.collectorId, table.mac),
  orgMacIdx: index('unifi_clients_org_mac_idx').on(table.orgId, table.mac),
}));
```

- [ ] **Step 3: Verify drift-clean**

Run (DB must be up):
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
```
Expected: applies `2026-06-29-unifi-phase2a-telemetry.sql`, then reports **no drift**.

- [ ] **Step 4: Verify idempotency** — re-run the migration runner; the second apply is a no-op (no errors).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-29-unifi-phase2a-telemetry.sql apps/api/src/db/schema/unifi.ts
git commit -m "feat(unifi): phase 2a schema + migration (collectors + telemetry + clients, RLS)"
```

---

## Task 2: RLS coverage — cross-org forge tests

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

**Interfaces:**
- Consumes: `unifiCollectors`, `unifiDeviceTelemetry`, `unifiClients` (Task 1).

- [ ] **Step 1: Add forge tests**

These three tables are direct-`org_id` shape-1 (auto-discovered — no allowlist entry needed). Add cross-org forge cases mirroring the file's existing org-axis forge structure (use the file's actual helper names — `orgContext`, `orgAId`, `orgBId`, `ensureFixtures`; match its conventions, don't invent fixtures):

```typescript
it('org B INSERT into unifi_collectors with org_id=A is rejected by RLS', async () => {
  await ensureFixtures();
  let caught: unknown;
  try {
    await withDbAccessContext(orgContext(orgBId), async () =>
      db.insert(unifiCollectors).values({
        integrationId: '00000000-0000-0000-0000-000000000000',
        orgId: orgAId, // forging org A from org B's context
        siteId: orgASiteId,
        unifiHostId: 'forge-host',
        collectorDeviceId: '00000000-0000-0000-0000-000000000000',
        controllerUrl: 'https://10.0.0.1',
        localApiKeyEncrypted: 'rls-forge-not-a-real-key',
      })
    );
  } catch (err) { caught = err; }
  expect(caught).toBeDefined();
  expect(String((caught as Error)?.message)).toMatch(/row-level security/i);
});

it('org B INSERT into unifi_device_telemetry with org_id=A is rejected by RLS', async () => {
  await ensureFixtures();
  let caught: unknown;
  try {
    await withDbAccessContext(orgContext(orgBId), async () =>
      db.insert(unifiDeviceTelemetry).values({
        collectorId: '00000000-0000-0000-0000-000000000000',
        orgId: orgAId, siteId: orgASiteId, unifiDeviceId: 'forge-dev', raw: {},
      })
    );
  } catch (err) { caught = err; }
  expect(caught).toBeDefined();
  expect(String((caught as Error)?.message)).toMatch(/row-level security/i);
});

it('org B INSERT into unifi_clients with org_id=A is rejected by RLS', async () => {
  await ensureFixtures();
  let caught: unknown;
  try {
    await withDbAccessContext(orgContext(orgBId), async () =>
      db.insert(unifiClients).values({
        collectorId: '00000000-0000-0000-0000-000000000000',
        orgId: orgAId, siteId: orgASiteId, mac: 'aa:bb:cc:00:11:22', raw: {},
      })
    );
  } catch (err) { caught = err; }
  expect(caught).toBeDefined();
  expect(String((caught as Error)?.message)).toMatch(/row-level security/i);
});
```

> The RLS `WITH CHECK` on `org_id` fires before any FK is evaluated, so the referenced collector/device ids need not exist. If the file lacks `orgASiteId`, use its existing org-A site helper.

- [ ] **Step 2: Run the contract + forge tests**

```bash
cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS — coverage recognizes the three tables as policied; the three forge inserts throw `row-level security`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(unifi): phase 2a cross-org RLS forge tests"
```

---

## Task 3: Collector service (CRUD + crypto seam + agent-pull query)

**Files:**
- Create: `apps/api/src/services/unifi/unifiCollectorService.ts`
- Test: `apps/api/src/services/unifi/unifiCollectorService.test.ts`

**Interfaces:**
- Consumes: `unifiCollectors`, `unifiSiteMappings` (schema); `encryptSecret`, `decryptForColumn` (`../secretCrypto`); `DbExecutor` (re-export from `./unifiConnectionService`).
- Produces (consumed by Tasks 5–7):
  - `interface UnifiCollector { id: string; integrationId: string; orgId: string; siteId: string; unifiHostId: string; collectorDeviceId: string; controllerUrl: string; isEnabled: boolean; pollIntervalSeconds: number; status: string; firmwareOk: boolean | null; lastPollAt: Date | null; lastPollStatus: string | null; lastPollError: string | null }`
  - `interface AgentCollectorConfig { collectorId: string; unifiHostId: string; controllerUrl: string; apiKey: string; pollIntervalSeconds: number }`
  - `listCollectors(db, integrationId): Promise<UnifiCollector[]>`
  - `upsertCollector(db, fields: { integrationId; orgId; siteId; unifiHostId; collectorDeviceId; controllerUrl; apiKey: string; pollIntervalSeconds?: number; createdBy?: string | null }): Promise<UnifiCollector>`
  - `deleteCollector(db, integrationId, unifiHostId): Promise<boolean>`
  - `listCollectorsForDevice(db, deviceId): Promise<AgentCollectorConfig[]>` (decrypts each key)
  - `markCollectorPoll(db, collectorId, status: string, firmwareOk: boolean | null, error?: string | null): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/unifi/unifiCollectorService.test.ts` (Drizzle-style chainable mock, mirroring `unifiConnectionService.test.ts`):

```typescript
import { describe, it, expect, vi } from 'vitest';
import * as svc from './unifiCollectorService';

vi.mock('../secretCrypto', () => ({
  encryptSecret: vi.fn(() => 'ENC'),
  decryptForColumn: vi.fn(() => 'PLAINTEXT-KEY'),
}));

function makeDb(overrides: Partial<Record<string, any>> = {}) {
  return {
    select: vi.fn(() => ({ from: () => ({ where: () => overrides.selectRows ?? [] }) })),
    insert: vi.fn(() => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: () => overrides.insertRows ?? [] }) }) })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: () => overrides.updateRows ?? [] }) }) })),
    delete: vi.fn(() => ({ where: () => ({ returning: () => overrides.deleteRows ?? [] }) })),
  } as unknown as svc.DbExecutor;
}

describe('unifiCollectorService', () => {
  it('markCollectorPoll throws when no row is updated (RLS-context guard)', async () => {
    const db = makeDb({ updateRows: [] });
    await expect(svc.markCollectorPoll(db, 'c1', 'error', false, 'boom'))
      .rejects.toThrow(/no unifi_collectors row/i);
  });

  it('listCollectorsForDevice decrypts the key into AgentCollectorConfig', async () => {
    const db = makeDb({ selectRows: [{
      id: 'c1', unifiHostId: 'h1', controllerUrl: 'https://10.0.0.1',
      localApiKeyEncrypted: 'ENC', pollIntervalSeconds: 60,
    }] });
    const out = await svc.listCollectorsForDevice(db, 'dev-1');
    expect(out).toEqual([{ collectorId: 'c1', unifiHostId: 'h1', controllerUrl: 'https://10.0.0.1', apiKey: 'PLAINTEXT-KEY', pollIntervalSeconds: 60 }]);
  });

  it('deleteCollector returns false when no row deleted', async () => {
    const db = makeDb({ deleteRows: [] });
    await expect(svc.deleteCollector(db, 'int-1', 'h1')).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && pnpm vitest run src/services/unifi/unifiCollectorService.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/unifi/unifiCollectorService.ts`:

```typescript
import { and, eq } from 'drizzle-orm';
import { unifiCollectors } from '../../db/schema';
import { encryptSecret, decryptForColumn } from '../secretCrypto';
import type { DbExecutor } from './unifiConnectionService';

export type { DbExecutor } from './unifiConnectionService';

export interface UnifiCollector {
  id: string; integrationId: string; orgId: string; siteId: string; unifiHostId: string;
  collectorDeviceId: string; controllerUrl: string; isEnabled: boolean; pollIntervalSeconds: number;
  status: string; firmwareOk: boolean | null; lastPollAt: Date | null;
  lastPollStatus: string | null; lastPollError: string | null;
}
export interface AgentCollectorConfig {
  collectorId: string; unifiHostId: string; controllerUrl: string; apiKey: string; pollIntervalSeconds: number;
}

function toCollector(row: any): UnifiCollector {
  return {
    id: row.id, integrationId: row.integrationId, orgId: row.orgId, siteId: row.siteId,
    unifiHostId: row.unifiHostId, collectorDeviceId: row.collectorDeviceId, controllerUrl: row.controllerUrl,
    isEnabled: row.isEnabled, pollIntervalSeconds: row.pollIntervalSeconds, status: row.status,
    firmwareOk: row.firmwareOk ?? null, lastPollAt: row.lastPollAt ?? null,
    lastPollStatus: row.lastPollStatus ?? null, lastPollError: row.lastPollError ?? null,
  };
}

export async function listCollectors(db: DbExecutor, integrationId: string): Promise<UnifiCollector[]> {
  const rows = await db.select().from(unifiCollectors).where(eq(unifiCollectors.integrationId, integrationId));
  return rows.map(toCollector);
}

export async function upsertCollector(
  db: DbExecutor,
  fields: { integrationId: string; orgId: string; siteId: string; unifiHostId: string; collectorDeviceId: string; controllerUrl: string; apiKey: string; pollIntervalSeconds?: number; createdBy?: string | null }
): Promise<UnifiCollector> {
  const localApiKeyEncrypted = encryptSecret(fields.apiKey, { aad: 'unifi_collectors.local_api_key_encrypted' });
  const rows = await db.insert(unifiCollectors).values({
    integrationId: fields.integrationId, orgId: fields.orgId, siteId: fields.siteId,
    unifiHostId: fields.unifiHostId, collectorDeviceId: fields.collectorDeviceId,
    controllerUrl: fields.controllerUrl, localApiKeyEncrypted,
    pollIntervalSeconds: fields.pollIntervalSeconds ?? 60, createdBy: fields.createdBy ?? null,
    status: 'pending',
  }).onConflictDoUpdate({
    target: [unifiCollectors.integrationId, unifiCollectors.unifiHostId],
    set: {
      orgId: fields.orgId, siteId: fields.siteId, collectorDeviceId: fields.collectorDeviceId,
      controllerUrl: fields.controllerUrl, localApiKeyEncrypted,
      pollIntervalSeconds: fields.pollIntervalSeconds ?? 60, status: 'pending',
      lastPollError: null, updatedAt: new Date(),
    },
  }).returning();
  if (!rows[0]) throw new Error('upsertCollector returned no unifi_collectors row');
  return toCollector(rows[0]);
}

export async function deleteCollector(db: DbExecutor, integrationId: string, unifiHostId: string): Promise<boolean> {
  const deleted = await db.delete(unifiCollectors)
    .where(and(eq(unifiCollectors.integrationId, integrationId), eq(unifiCollectors.unifiHostId, unifiHostId)))
    .returning({ id: unifiCollectors.id });
  return deleted.length > 0;
}

// Agent-pull: configs for the agent whose device is the collector. Decrypts the key.
export async function listCollectorsForDevice(db: DbExecutor, deviceId: string): Promise<AgentCollectorConfig[]> {
  const rows = await db.select({
    id: unifiCollectors.id, unifiHostId: unifiCollectors.unifiHostId,
    controllerUrl: unifiCollectors.controllerUrl, localApiKeyEncrypted: unifiCollectors.localApiKeyEncrypted,
    pollIntervalSeconds: unifiCollectors.pollIntervalSeconds,
  }).from(unifiCollectors).where(and(eq(unifiCollectors.collectorDeviceId, deviceId), eq(unifiCollectors.isEnabled, true)));
  return rows.map((r: any) => ({
    collectorId: r.id, unifiHostId: r.unifiHostId, controllerUrl: r.controllerUrl,
    apiKey: decryptForColumn('unifi_collectors', 'local_api_key_encrypted', r.localApiKeyEncrypted),
    pollIntervalSeconds: r.pollIntervalSeconds,
  }));
}

export async function markCollectorPoll(
  db: DbExecutor, collectorId: string, status: string, firmwareOk: boolean | null, error?: string | null
): Promise<void> {
  const updated = await db.update(unifiCollectors).set({
    status, firmwareOk, lastPollAt: new Date(),
    lastPollStatus: status === 'connected' ? 'success' : status === 'firmware_too_old' ? 'failed' : status,
    lastPollError: error ?? null, updatedAt: new Date(),
  }).where(eq(unifiCollectors.id, collectorId)).returning({ id: unifiCollectors.id });
  if (updated.length === 0) throw new Error(`markCollectorPoll matched no unifi_collectors row (id=${collectorId})`);
}
```

> If `onConflictDoUpdate` against the composite unique index needs target adjustment in this Drizzle version, target the columns of `unifi_collectors_integration_host_idx`.

- [ ] **Step 4: Run to verify pass** — `cd apps/api && pnpm vitest run src/services/unifi/unifiCollectorService.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/unifi/unifiCollectorService.ts apps/api/src/services/unifi/unifiCollectorService.test.ts
git commit -m "feat(unifi): collector service (encrypted key + agent-pull + RLS-guarded writes)"
```

---

## Task 4: Telemetry reconciliation service

**Files:**
- Create: `apps/api/src/services/unifi/unifiTelemetryService.ts`
- Test: `apps/api/src/services/unifi/unifiTelemetryService.test.ts`

**Interfaces:**
- Consumes: `DbExecutor` (Task 3); `unifiCollectors`, `unifiSiteMappings`, `unifiDeviceTelemetry`, `unifiClients`, `discoveredAssets` (schema).
- Produces (consumed by Task 5):
  - `interface TelemetryDeviceDto { unifiDeviceId: string; unifiSiteId: string | null; mac: string | null; name: string | null; uptimeSeconds: number | null; cpuPct: number | null; memPct: number | null; txBytes: number | null; rxBytes: number | null; numClients: number | null; poePorts: unknown; raw: unknown }`
  - `interface TelemetryClientDto { mac: string; unifiSiteId: string | null; hostname: string | null; ip: string | null; connectedDeviceId: string | null; uplinkPortIdx: number | null; isWired: boolean | null; ssid: string | null; vlan: number | null; signalDbm: number | null; txBytes: number | null; rxBytes: number | null; uptimeSeconds: number | null; raw: unknown }`
  - `interface TelemetryPayload { collectorId: string; polledAt: string; firmwareOk: boolean; devices: TelemetryDeviceDto[]; clients: TelemetryClientDto[]; error?: string }`
  - `interface ReconcileResult { devicesUpserted: number; devicesStaled: number; clientsUpserted: number; clientsStaled: number }`
  - `reconcileTelemetry(db: DbExecutor, payload: TelemetryPayload): Promise<ReconcileResult>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/unifi/unifiTelemetryService.test.ts`. Use a scripted DbExecutor that dispatches on table identity (import the schema tables and compare by reference), recording writes — mirror the approach used in `unifiSyncService.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { reconcileTelemetry } from './unifiTelemetryService';
import { unifiCollectors, unifiSiteMappings, unifiDeviceTelemetry, unifiClients, discoveredAssets } from '../../db/schema';

// Build a DbExecutor that returns canned select rows per table and records inserts/updates.
function scriptedDb(opts: {
  collector: any; mappings: any[]; existingDevices?: any[]; existingClients?: any[]; assetByMac?: Record<string, any>;
}) {
  const writes = { inserts: [] as any[], updates: [] as any[] };
  const selForTable = (t: any) => {
    if (t === unifiCollectors) return [opts.collector];
    if (t === unifiSiteMappings) return opts.mappings;
    if (t === unifiDeviceTelemetry) return opts.existingDevices ?? [];
    if (t === unifiClients) return opts.existingClients ?? [];
    if (t === discoveredAssets) return []; // default; per-mac handled below
    return [];
  };
  const db: any = {
    select: (_cols?: any) => ({ from: (t: any) => ({ where: (_w?: any) => ({ limit: async () => selForTable(t), then: undefined }) }) }),
    insert: (t: any) => ({ values: (v: any) => ({ onConflictDoUpdate: async () => { writes.inserts.push({ t, v }); }, returning: async () => { writes.inserts.push({ t, v }); return [{ id: 'new' }]; } }) }),
    update: (t: any) => ({ set: (v: any) => ({ where: async () => { writes.updates.push({ t, v }); } }) }),
  };
  // NOTE: implementers refine the chainable shape to match how reconcileTelemetry calls it
  // (the production code's exact call chain governs the mock); assert via `writes`.
  return { db: db as any, writes };
}

describe('reconcileTelemetry', () => {
  it('upserts device + client telemetry and resolves site via mapping', async () => {
    const { db } = scriptedDb({
      collector: { id: 'c1', orgId: 'org-a', siteId: 'site-a', integrationId: 'int-1' },
      mappings: [{ unifiSiteId: 's1', siteId: 'site-a', orgId: 'org-a' }],
    });
    const res = await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true,
      devices: [{ unifiDeviceId: 'd1', unifiSiteId: 's1', mac: 'aa:bb', name: 'AP', uptimeSeconds: 10, cpuPct: 1, memPct: 2, txBytes: 3, rxBytes: 4, numClients: 1, poePorts: [], raw: {} }],
      clients: [{ mac: 'cc:dd', unifiSiteId: 's1', hostname: 'phone', ip: '10.0.0.9', connectedDeviceId: 'd1', uplinkPortIdx: null, isWired: false, ssid: 'wifi', vlan: 10, signalDbm: -50, txBytes: 1, rxBytes: 1, uptimeSeconds: 5, raw: {} }],
    });
    expect(res.devicesUpserted).toBe(1);
    expect(res.clientsUpserted).toBe(1);
  });

  it('marks devices/clients not seen this poll as stale', async () => {
    const { db, writes } = scriptedDb({
      collector: { id: 'c1', orgId: 'org-a', siteId: 'site-a', integrationId: 'int-1' },
      mappings: [{ unifiSiteId: 's1', siteId: 'site-a', orgId: 'org-a' }],
      existingDevices: [{ id: 'old-dev', unifiDeviceId: 'gone', isStale: false }],
      existingClients: [{ id: 'old-cli', mac: 'ff:ff', isStale: false }],
    });
    const res = await reconcileTelemetry(db, {
      collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true, devices: [], clients: [],
    });
    expect(res.devicesStaled).toBe(1);
    expect(res.clientsStaled).toBe(1);
    expect(writes.updates.some((u) => u.v.isStale === true)).toBe(true);
  });
});
```

> This harness is the trickiest in the plan. Implement `scriptedDb` to match the exact call chains in `reconcileTelemetry` (Step 3). Flesh the two cases into real `writes`-based assertions before implementing.

- [ ] **Step 2: Run to verify failure** — `cd apps/api && pnpm vitest run src/services/unifi/unifiTelemetryService.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/unifi/unifiTelemetryService.ts`:

```typescript
import { and, eq, sql } from 'drizzle-orm';
import { unifiCollectors, unifiSiteMappings, unifiDeviceTelemetry, unifiClients, discoveredAssets } from '../../db/schema';
import type { DbExecutor } from './unifiConnectionService';

export interface TelemetryDeviceDto {
  unifiDeviceId: string; unifiSiteId: string | null; mac: string | null; name: string | null;
  uptimeSeconds: number | null; cpuPct: number | null; memPct: number | null;
  txBytes: number | null; rxBytes: number | null; numClients: number | null; poePorts: unknown; raw: unknown;
}
export interface TelemetryClientDto {
  mac: string; unifiSiteId: string | null; hostname: string | null; ip: string | null;
  connectedDeviceId: string | null; uplinkPortIdx: number | null; isWired: boolean | null;
  ssid: string | null; vlan: number | null; signalDbm: number | null;
  txBytes: number | null; rxBytes: number | null; uptimeSeconds: number | null; raw: unknown;
}
export interface TelemetryPayload {
  collectorId: string; polledAt: string; firmwareOk: boolean;
  devices: TelemetryDeviceDto[]; clients: TelemetryClientDto[]; error?: string;
}
export interface ReconcileResult { devicesUpserted: number; devicesStaled: number; clientsUpserted: number; clientsStaled: number; }

export async function reconcileTelemetry(db: DbExecutor, payload: TelemetryPayload): Promise<ReconcileResult> {
  const result: ReconcileResult = { devicesUpserted: 0, devicesStaled: 0, clientsUpserted: 0, clientsStaled: 0 };

  const [collector] = await db.select({
    id: unifiCollectors.id, orgId: unifiCollectors.orgId, siteId: unifiCollectors.siteId,
    integrationId: unifiCollectors.integrationId,
  }).from(unifiCollectors).where(eq(unifiCollectors.id, payload.collectorId)).limit(1);
  if (!collector) throw new Error(`reconcileTelemetry: unknown collector ${payload.collectorId}`);

  // Build unifiSiteId -> {orgId, siteId} from the Phase 1 mappings for this integration.
  const mappings = await db.select({
    unifiSiteId: unifiSiteMappings.unifiSiteId, siteId: unifiSiteMappings.siteId, orgId: unifiSiteMappings.orgId,
  }).from(unifiSiteMappings).where(eq(unifiSiteMappings.integrationId, collector.integrationId));
  const siteByUnifi = new Map<string, { orgId: string; siteId: string }>();
  for (const m of mappings) if (m.unifiSiteId) siteByUnifi.set(m.unifiSiteId, { orgId: m.orgId, siteId: m.siteId });
  // Fallback to the collector's own org/site when a device reports no/unknown unifi site.
  const resolveSite = (unifiSiteId: string | null) =>
    (unifiSiteId && siteByUnifi.get(unifiSiteId)) || { orgId: collector.orgId, siteId: collector.siteId };

  const now = new Date();

  // --- Devices ---
  const seenDeviceIds = new Set<string>();
  for (const d of payload.devices) {
    seenDeviceIds.add(d.unifiDeviceId);
    const { orgId, siteId } = resolveSite(d.unifiSiteId);
    await db.insert(unifiDeviceTelemetry).values({
      collectorId: collector.id, orgId, siteId, unifiDeviceId: d.unifiDeviceId, mac: d.mac, name: d.name,
      uptimeSeconds: d.uptimeSeconds, cpuPct: d.cpuPct, memPct: d.memPct, txBytes: d.txBytes, rxBytes: d.rxBytes,
      numClients: d.numClients, poePorts: d.poePorts ?? null, raw: d.raw, isStale: false, lastSeenAt: now,
      lastSyncedAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [unifiDeviceTelemetry.collectorId, unifiDeviceTelemetry.unifiDeviceId],
      set: {
        orgId, siteId, mac: d.mac, name: d.name, uptimeSeconds: d.uptimeSeconds, cpuPct: d.cpuPct, memPct: d.memPct,
        txBytes: d.txBytes, rxBytes: d.rxBytes, numClients: d.numClients, poePorts: d.poePorts ?? null, raw: d.raw,
        isStale: false, lastSeenAt: now, lastSyncedAt: now, updatedAt: now,
      },
    });
    result.devicesUpserted++;
  }
  const existingDevices = await db.select({ id: unifiDeviceTelemetry.id, unifiDeviceId: unifiDeviceTelemetry.unifiDeviceId })
    .from(unifiDeviceTelemetry).where(eq(unifiDeviceTelemetry.collectorId, collector.id));
  for (const row of existingDevices) {
    if (!seenDeviceIds.has(row.unifiDeviceId)) {
      await db.update(unifiDeviceTelemetry).set({ isStale: true, updatedAt: now }).where(eq(unifiDeviceTelemetry.id, row.id));
      result.devicesStaled++;
    }
  }

  // --- Clients ---
  const seenMacs = new Set<string>();
  for (const cl of payload.clients) {
    seenMacs.add(cl.mac);
    const { orgId, siteId } = resolveSite(cl.unifiSiteId);
    // Enrich-only link to discovered_assets by (org_id, mac) — never create.
    let discoveredAssetId: string | null = null;
    const [asset] = await db.select({ id: discoveredAssets.id }).from(discoveredAssets)
      .where(and(eq(discoveredAssets.orgId, orgId), eq(discoveredAssets.macAddress, cl.mac))).limit(1);
    discoveredAssetId = asset?.id ?? null;

    await db.insert(unifiClients).values({
      collectorId: collector.id, orgId, siteId, mac: cl.mac, hostname: cl.hostname,
      ipAddress: cl.ip, connectedDeviceId: cl.connectedDeviceId, uplinkPortIdx: cl.uplinkPortIdx, isWired: cl.isWired,
      ssid: cl.ssid, vlan: cl.vlan, signalDbm: cl.signalDbm, txBytes: cl.txBytes, rxBytes: cl.rxBytes,
      uptimeSeconds: cl.uptimeSeconds, discoveredAssetId, raw: cl.raw, isStale: false, lastSeenAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [unifiClients.collectorId, unifiClients.mac],
      set: {
        orgId, siteId, hostname: cl.hostname, ipAddress: cl.ip, connectedDeviceId: cl.connectedDeviceId,
        uplinkPortIdx: cl.uplinkPortIdx, isWired: cl.isWired, ssid: cl.ssid, vlan: cl.vlan, signalDbm: cl.signalDbm,
        txBytes: cl.txBytes, rxBytes: cl.rxBytes, uptimeSeconds: cl.uptimeSeconds, discoveredAssetId,
        raw: cl.raw, isStale: false, lastSeenAt: now, updatedAt: now,
      },
    });
    result.clientsUpserted++;
  }
  const existingClients = await db.select({ id: unifiClients.id, mac: unifiClients.mac })
    .from(unifiClients).where(eq(unifiClients.collectorId, collector.id));
  for (const row of existingClients) {
    if (!seenMacs.has(row.mac)) {
      await db.update(unifiClients).set({ isStale: true, updatedAt: now }).where(eq(unifiClients.id, row.id));
      result.clientsStaled++;
    }
  }

  return result;
}
```

> `discoveredAssets.macAddress` is the column Phase 1 matched on (`reconcileDiscoveredAsset`); confirm the name in `apps/api/src/db/schema/discovery.ts`. The `ipAddress` is stored via the `inet` column (Drizzle passes the string through).

- [ ] **Step 4: Flesh out + run the tests** — complete `scriptedDb` to match the call chains above, assert on `writes` and the returned counts, then `cd apps/api && pnpm vitest run src/services/unifi/unifiTelemetryService.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/unifi/unifiTelemetryService.ts apps/api/src/services/unifi/unifiTelemetryService.test.ts
git commit -m "feat(unifi): telemetry reconciliation (snapshot upsert/stale + discovered_assets enrich)"
```

---

## Task 5: Telemetry ingest worker (BullMQ)

**Files:**
- Create: `apps/api/src/jobs/unifiTelemetryWorker.ts`
- Modify: `apps/api/src/index.ts` (call `initializeUnifiTelemetryWorker()` next to the other worker inits)

**Interfaces:**
- Consumes: `createInstrumentedQueue` (`../services/bullmqQueue`), `getBullMQConnection` (`../services/redis`), `db`, `withSystemDbAccessContext`, `runOutsideDbContext` (`../db`); `reconcileTelemetry`, `TelemetryPayload` (Task 4); `markCollectorPoll` (Task 3).
- Produces (consumed by Task 6): `getUnifiTelemetryQueue(): Queue`, `enqueueUnifiTelemetry(payload: TelemetryPayload): Promise<void>`, `initializeUnifiTelemetryWorker(): Promise<void>`.

- [ ] **Step 1: Write the worker**

Create `apps/api/src/jobs/unifiTelemetryWorker.ts`:

```typescript
import { Worker, type Job, type Queue } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { getBullMQConnection } from '../services/redis';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { reconcileTelemetry, type TelemetryPayload } from '../services/unifi/unifiTelemetryService';
import { markCollectorPoll } from '../services/unifi/unifiCollectorService';

export const UNIFI_TELEMETRY_QUEUE = 'unifi-telemetry';

let queue: Queue<TelemetryPayload> | null = null;
export function getUnifiTelemetryQueue(): Queue<TelemetryPayload> {
  if (!queue) queue = createInstrumentedQueue<TelemetryPayload>(UNIFI_TELEMETRY_QUEUE);
  return queue;
}

// Route handlers hold a DB context; the instrumented queue forbids enqueue there.
export async function enqueueUnifiTelemetry(payload: TelemetryPayload): Promise<void> {
  await runOutsideDbContext(() => getUnifiTelemetryQueue().add('ingest', payload, {
    attempts: 2, removeOnComplete: { count: 100 }, removeOnFail: { count: 100 },
  }));
}

async function processIngest(payload: TelemetryPayload): Promise<void> {
  await withSystemDbAccessContext(async () => {
    if (!payload.firmwareOk) {
      await markCollectorPoll(db, payload.collectorId, 'firmware_too_old', false, payload.error ?? 'Controller firmware below 9.3 or integration disabled');
      return;
    }
    try {
      await reconcileTelemetry(db, payload);
      await markCollectorPoll(db, payload.collectorId, 'connected', true, payload.error ?? null);
    } catch (err) {
      await markCollectorPoll(db, payload.collectorId, 'error', true, (err as Error).message);
      throw err; // surface to BullMQ for retry/visibility
    }
  });
}

let workerInstance: Worker<TelemetryPayload> | null = null;
export async function initializeUnifiTelemetryWorker(): Promise<void> {
  workerInstance = new Worker<TelemetryPayload>(
    UNIFI_TELEMETRY_QUEUE,
    async (job: Job<TelemetryPayload>) => processIngest(job.data),
    { connection: getBullMQConnection(), concurrency: 4 },
  );
  workerInstance.on('error', (e) => console.error('[UnifiTelemetryWorker] error:', e));
  workerInstance.on('failed', (job, e) => console.error(`[UnifiTelemetryWorker] job ${job?.id} failed:`, e));
  console.log('[UnifiTelemetryWorker] initialized');
}
```

> Confirm `../db` exports `db`, `withSystemDbAccessContext`, `runOutsideDbContext` (it does — `unifiWorker.ts` imports the same). Match whatever `unifiWorker.ts` imports.

- [ ] **Step 2: Register worker startup** — in `apps/api/src/index.ts`, next to `await initializeUnifiWorker();`:

```typescript
import { initializeUnifiTelemetryWorker } from './jobs/unifiTelemetryWorker';
// ... in the same startup block:
await initializeUnifiTelemetryWorker();
```

- [ ] **Step 3: Typecheck** — `cd apps/api && pnpm tsc --noEmit` → no errors in the new/modified files.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/jobs/unifiTelemetryWorker.ts apps/api/src/index.ts
git commit -m "feat(unifi): telemetry ingest worker (system-ctx reconcile + collector status)"
```

---

## Task 6: Agent-role ingest + collector-pull endpoints

**Files:**
- Create: `apps/api/src/routes/agent/unifiTelemetry.ts`
- Create: `apps/api/src/routes/agent/unifiTelemetry.test.ts`
- Modify: `apps/api/src/index.ts` (mount under the agent base)

**Interfaces:**
- Consumes: `requireAgentRole` (the agent-auth middleware that sets the agent's `deviceId` in context — same one guarding agent result/log routes; grep `requireAgentRole`), `db`, `withSystemDbAccessContext` (`../../db`), `listCollectorsForDevice` (Task 3), `enqueueUnifiTelemetry` + `TelemetryPayload` (Tasks 4–5).
- Produces: `export const agentUnifiRoutes` (Hono app), mounted at the agent base (e.g. `/agent`).

- [ ] **Step 1: Write the failing route test**

Create `apps/api/src/routes/agent/unifiTelemetry.test.ts` (mock the agent-auth middleware to inject a `deviceId`, mock the service + worker):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  db: {}, withSystemDbAccessContext: (fn: any) => fn(),
}));
vi.mock('../../services/unifi/unifiCollectorService', () => ({ listCollectorsForDevice: vi.fn() }));
vi.mock('../../jobs/unifiTelemetryWorker', () => ({ enqueueUnifiTelemetry: vi.fn(async () => undefined) }));
vi.mock('../../middleware/agentAuth', () => ({
  requireAgentRole: (c: any, next: any) => { c.set('agentDeviceId', 'dev-1'); return next(); },
}));

import { agentUnifiRoutes } from './unifiTelemetry';
import * as collectorSvc from '../../services/unifi/unifiCollectorService';
import * as worker from '../../jobs/unifiTelemetryWorker';

describe('agent unifi telemetry routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /agent/unifi-collectors returns this device\'s collector configs', async () => {
    (collectorSvc.listCollectorsForDevice as any).mockResolvedValue([
      { collectorId: 'c1', unifiHostId: 'h1', controllerUrl: 'https://10.0.0.1', apiKey: 'K', pollIntervalSeconds: 60 },
    ]);
    const res = await agentUnifiRoutes.request('/unifi-collectors', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ collectors: [{ collectorId: 'c1', apiKey: 'K' }] });
  });

  it('POST /agent/unifi-telemetry enqueues the payload and returns 202', async () => {
    const body = { collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true, devices: [], clients: [] };
    const res = await agentUnifiRoutes.request('/unifi-telemetry', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    expect(worker.enqueueUnifiTelemetry).toHaveBeenCalledWith(expect.objectContaining({ collectorId: 'c1' }));
  });

  it('POST /agent/unifi-telemetry rejects an invalid payload with 400', async () => {
    const res = await agentUnifiRoutes.request('/unifi-telemetry', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && pnpm vitest run src/routes/agent/unifiTelemetry.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the routes**

Create `apps/api/src/routes/agent/unifiTelemetry.ts`:

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireAgentRole } from '../../middleware/agentAuth';
import { db, withSystemDbAccessContext } from '../../db';
import { listCollectorsForDevice } from '../../services/unifi/unifiCollectorService';
import { enqueueUnifiTelemetry } from '../../jobs/unifiTelemetryWorker';

export const agentUnifiRoutes = new Hono();

const deviceDto = z.object({
  unifiDeviceId: z.string(), unifiSiteId: z.string().nullable().optional(),
  mac: z.string().nullable().optional(), name: z.string().nullable().optional(),
  uptimeSeconds: z.number().nullable().optional(), cpuPct: z.number().nullable().optional(),
  memPct: z.number().nullable().optional(), txBytes: z.number().nullable().optional(),
  rxBytes: z.number().nullable().optional(), numClients: z.number().nullable().optional(),
  poePorts: z.unknown().optional(), raw: z.unknown(),
});
const clientDto = z.object({
  mac: z.string(), unifiSiteId: z.string().nullable().optional(), hostname: z.string().nullable().optional(),
  ip: z.string().nullable().optional(), connectedDeviceId: z.string().nullable().optional(),
  uplinkPortIdx: z.number().nullable().optional(), isWired: z.boolean().nullable().optional(),
  ssid: z.string().nullable().optional(), vlan: z.number().nullable().optional(),
  signalDbm: z.number().nullable().optional(), txBytes: z.number().nullable().optional(),
  rxBytes: z.number().nullable().optional(), uptimeSeconds: z.number().nullable().optional(), raw: z.unknown(),
});
const telemetrySchema = z.object({
  collectorId: z.string().min(1), polledAt: z.string(), firmwareOk: z.boolean(),
  devices: z.array(deviceDto), clients: z.array(clientDto), error: z.string().optional(),
});

agentUnifiRoutes.use('*', requireAgentRole);

// GET /agent/unifi-collectors — the configs assigned to this agent's device (decrypted keys).
agentUnifiRoutes.get('/unifi-collectors', async (c) => {
  const deviceId = c.get('agentDeviceId') as string;
  const collectors = await withSystemDbAccessContext(() => listCollectorsForDevice(db, deviceId));
  return c.json({ collectors });
});

// POST /agent/unifi-telemetry — ingest a batched poll; enqueue, don't write inline.
agentUnifiRoutes.post('/unifi-telemetry', zValidator('json', telemetrySchema), async (c) => {
  const payload = c.req.valid('json');
  await enqueueUnifiTelemetry(payload);
  return c.json({ accepted: true }, 202);
});
```

> Confirm the real agent-auth middleware import path + the context key it sets for the device id (grep `requireAgentRole` and how `agentWs.ts`/the watchdog log route reads the agent's device). Adjust `c.get('agentDeviceId')` to the actual key. The middleware MUST be agent-role — do not mount these under partner/org auth.

- [ ] **Step 4: Mount the routes** — in `apps/api/src/index.ts`, next to the other agent routes (grep where agent log/result routes mount, e.g. `api.route('/agent', ...)`):

```typescript
import { agentUnifiRoutes } from './routes/agent/unifiTelemetry';
// ...
api.route('/agent', agentUnifiRoutes);
```

> If agent routes already mount at a different base, add these two paths there so the final URLs are `/agent/unifi-collectors` and `/agent/unifi-telemetry` (or match the existing agent URL convention and update the Go client in Task 9 to the same paths).

- [ ] **Step 5: Run the route tests** — `cd apps/api && pnpm vitest run src/routes/agent/unifiTelemetry.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agent/unifiTelemetry.ts apps/api/src/routes/agent/unifiTelemetry.test.ts apps/api/src/index.ts
git commit -m "feat(unifi): agent-role telemetry ingest + collector-pull endpoints"
```

---

## Task 7: Partner-scoped collector CRUD + telemetry read routes

**Files:**
- Modify: `apps/api/src/routes/unifi/index.ts`
- Modify: `apps/api/src/routes/unifi/index.test.ts`

**Interfaces:**
- Consumes: the existing `unifiRoutes` harness (auth/scope/perm middleware, `resolvePartnerId`, `getConnection`); `unifiCollectorService` (Task 3); `unifiCollectors`, `unifiDeviceTelemetry`, `unifiClients`, `sites`, `devices` (schema).
- Produces: new routes on `unifiRoutes` — `GET /collectors`, `PUT /collectors`, `DELETE /collectors/:hostId`, `GET /telemetry`.

- [ ] **Step 1: Write the failing route tests**

Add to `apps/api/src/routes/unifi/index.test.ts` (extend the existing mocks — add `unifiCollectors`, `unifiDeviceTelemetry`, `unifiClients`, `devices` to the `../../db/schema` mock; mock `../../services/unifi/unifiCollectorService`):

```typescript
// in the ../../services mocks block, add:
vi.mock('../../services/unifi/unifiCollectorService', () => ({
  listCollectors: vi.fn(),
  upsertCollector: vi.fn(),
  deleteCollector: vi.fn(),
}));
```

```typescript
import * as collectorSvc from '../../services/unifi/unifiCollectorService';

it('GET /collectors returns [] when not connected', async () => {
  vi.mocked(svc.getConnection).mockResolvedValue(null);
  const res = await unifiRoutes.request('/collectors', { method: 'GET' });
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toMatchObject({ collectors: [] });
});

it('PUT /collectors derives org from site, enforces canAccessOrg, and upserts', async () => {
  vi.mocked(svc.getConnection).mockResolvedValue({
    id: CONN_ID, partnerId: PARTNER_ID, baseUrl: 'https://api.ui.com', accountLabel: null,
    isActive: true, status: 'connected', lastSyncAt: null, lastSyncStatus: null, lastSyncError: null,
  });
  // site lookup → { id, orgId }
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: SITE_ID, orgId: ORG_ID }]) })) })),
  } as any);
  // device lookup → { id, orgId } belongs to same org
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: 'dev-1', orgId: ORG_ID }]) })) })),
  } as any);
  vi.mocked(collectorSvc.upsertCollector).mockResolvedValue({ id: 'c1' } as any);
  const res = await unifiRoutes.request('/collectors', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unifiHostId: 'h1', siteId: SITE_ID, collectorDeviceId: 'dev-1', controllerUrl: 'https://10.0.0.1', apiKey: 'K' }),
  });
  expect(res.status).toBe(200);
  expect(collectorSvc.upsertCollector).toHaveBeenCalled();
});

it('PUT /collectors returns 403 when canAccessOrg is false', async () => {
  const { authMiddleware } = await import('../../middleware/auth');
  vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
    c.set('auth', { scope: 'partner', partnerId: PARTNER_ID, orgId: null, canAccessOrg: vi.fn(() => false), user: { id: 'u1' } });
    return next();
  });
  vi.mocked(svc.getConnection).mockResolvedValue({ id: CONN_ID } as any);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: SITE_ID, orgId: ORG_ID }]) })) })),
  } as any);
  const res = await unifiRoutes.request('/collectors', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unifiHostId: 'h1', siteId: SITE_ID, collectorDeviceId: 'dev-1', controllerUrl: 'https://10.0.0.1', apiKey: 'K' }),
  });
  expect(res.status).toBe(403);
  expect(collectorSvc.upsertCollector).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && pnpm vitest run src/routes/unifi/index.test.ts` → FAIL on the new cases.

- [ ] **Step 3: Implement the routes**

In `apps/api/src/routes/unifi/index.ts`, add imports and routes (the `db`, `eq`, `and`, `desc`, `getConnection`, `resolvePartnerId`, `requestedPartnerId`, `partnerScopes`, `readPerm`, `writePerm`, `requireMfa`, `sites` are already in the file):

```typescript
import { devices, unifiCollectors, unifiDeviceTelemetry, unifiClients } from '../../db/schema';
import { listCollectors, upsertCollector, deleteCollector } from '../../services/unifi/unifiCollectorService';

const collectorSchema = z.object({
  unifiHostId: z.string().min(1),
  siteId: z.string().guid(),
  collectorDeviceId: z.string().guid(),
  controllerUrl: z.string().url().max(300),
  apiKey: z.string().min(1),
  pollIntervalSeconds: z.number().int().min(15).max(3600).optional(),
});

// GET /unifi/collectors — configured collectors + status
unifiRoutes.get('/collectors', partnerScopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ collectors: [] });
  const collectors = await listCollectors(db, conn.id);
  return c.json({ collectors });
});

// PUT /unifi/collectors — upsert a console's collector
unifiRoutes.put('/collectors', partnerScopes, writePerm, requireMfa(), zValidator('json', collectorSchema), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  const body = c.req.valid('json');
  const [site] = await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(eq(sites.id, body.siteId)).limit(1);
  if (!site) return c.json({ success: false, message: `Unknown Breeze site: ${body.siteId}` }, 400);
  if (!auth.canAccessOrg(site.orgId)) return c.json({ success: false, message: 'Access to target organization denied' }, 403);
  const [dev] = await db.select({ id: devices.id, orgId: devices.orgId }).from(devices).where(eq(devices.id, body.collectorDeviceId)).limit(1);
  if (!dev) return c.json({ success: false, message: 'Unknown collector agent' }, 400);
  if (dev.orgId !== site.orgId) return c.json({ success: false, message: 'Collector agent must belong to the site\'s organization' }, 400);
  const collector = await upsertCollector(db, {
    integrationId: conn.id, orgId: site.orgId, siteId: site.id, unifiHostId: body.unifiHostId,
    collectorDeviceId: body.collectorDeviceId, controllerUrl: body.controllerUrl, apiKey: body.apiKey,
    pollIntervalSeconds: body.pollIntervalSeconds, createdBy: auth.user.id,
  });
  return c.json({ success: true, collectorId: collector.id });
});

// DELETE /unifi/collectors/:hostId — remove a console's collector
unifiRoutes.delete('/collectors/:hostId', partnerScopes, writePerm, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  const ok = await deleteCollector(db, conn.id, c.req.param('hostId'));
  return c.json({ success: ok });
});

// GET /unifi/telemetry?siteId= — devices (with poe_ports) + clients for a mapped site
unifiRoutes.get('/telemetry', partnerScopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const siteId = c.req.query('siteId');
  if (!siteId) return c.json({ error: 'siteId is required' }, 400);
  // Org-axis RLS additionally constrains rows to orgs the caller can access.
  const devicesOut = await db.select().from(unifiDeviceTelemetry).where(eq(unifiDeviceTelemetry.siteId, siteId));
  const clientsOut = await db.select().from(unifiClients).where(eq(unifiClients.siteId, siteId));
  return c.json({ devices: devicesOut, clients: clientsOut });
});
```

> Confirm `devices.orgId` exists (grep `apps/api/src/db/schema/devices.ts`). Keep `{success:false,...}` bodies so the web `runAction` surfaces failures.

- [ ] **Step 4: Run the route tests** — `cd apps/api && pnpm vitest run src/routes/unifi/index.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/unifi/index.ts apps/api/src/routes/unifi/index.test.ts
git commit -m "feat(unifi): partner-scoped collector CRUD + telemetry read routes"
```

---

## Task 8: Agent Go — Network Integration API client

**Files:**
- Create: `agent/internal/unifi/client.go`
- Test: `agent/internal/unifi/client_test.go`

**Interfaces:**
- Produces (consumed by Task 9):
  - `type Device struct { ID, Mac, Name string; UptimeSeconds int64; CPUPct, MemPct float64; TxBytes, RxBytes int64; NumClients int; PoePorts []PoePort; SiteID string; Raw json.RawMessage }`
  - `type PoePort struct { PortIdx int; Name, PoeMode string; PoePowerW float64; LinkSpeedMbps int; Up bool }`
  - `type Client struct { Mac, Hostname, IP, ConnectedDeviceID, SSID, SiteID string; UplinkPortIdx, Vlan, SignalDbm int; IsWired bool; TxBytes, RxBytes, UptimeSeconds int64; Raw json.RawMessage }`
  - `type Snapshot struct { Devices []Device; Clients []Client; FirmwareOK bool }`
  - `func NewAPIClient(controllerURL, apiKey string, httpClient *http.Client) *APIClient` (the HTTP wrapper type)
  - `func (c *APIClient) Poll(ctx context.Context) (Snapshot, error)`
  - `func DefaultHTTPClient() *http.Client`

> Naming note: the HTTP wrapper type is `APIClient`; `Client` is the data struct for a station. They must not collide.

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/unifi/client_test.go`:

```go
package unifi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPollParsesDevicesAndClients(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-KEY") != "k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/proxy/network/integration/v1/sites":
			w.Write([]byte(`{"data":[{"id":"s1"}]}`))
		case "/proxy/network/integration/v1/sites/s1/devices":
			w.Write([]byte(`{"data":[{"id":"d1","mac":"aa:bb","name":"AP","uptime":10,"num_clients":1}]}`))
		case "/proxy/network/integration/v1/sites/s1/clients":
			w.Write([]byte(`{"data":[{"mac":"cc:dd","hostname":"phone","ip":"10.0.0.9","is_wired":false}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := NewAPIClient(srv.URL, "k", srv.Client())
	snap, err := c.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll error: %v", err)
	}
	if !snap.FirmwareOK {
		t.Fatalf("expected FirmwareOK true")
	}
	if len(snap.Devices) != 1 || snap.Devices[0].ID != "d1" || snap.Devices[0].SiteID != "s1" {
		t.Fatalf("unexpected devices: %+v", snap.Devices)
	}
	if len(snap.Clients) != 1 || snap.Clients[0].Mac != "cc:dd" || snap.Clients[0].SiteID != "s1" {
		t.Fatalf("unexpected clients: %+v", snap.Clients)
	}
}

func TestPollFirmwareTooOld(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound) // integration API absent → treat as firmware/integration unavailable
	}))
	defer srv.Close()
	c := NewAPIClient(srv.URL, "k", srv.Client())
	snap, err := c.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll should not hard-error on missing integration: %v", err)
	}
	if snap.FirmwareOK {
		t.Fatalf("expected FirmwareOK false when integration endpoint is 404")
	}
}
```

- [ ] **Step 2: Run to verify failure** — `cd agent && go test ./internal/unifi/...` → FAIL (no such package).

- [ ] **Step 3: Implement the client**

Create `agent/internal/unifi/client.go`:

```go
// Package unifi polls a local UniFi controller's Network Integration API (read-only).
package unifi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const apiBase = "/proxy/network/integration/v1"

type PoePort struct {
	PortIdx       int     `json:"port_idx"`
	Name          string  `json:"name"`
	PoeMode       string  `json:"poe_mode"`
	PoePowerW     float64 `json:"poe_power_w"`
	LinkSpeedMbps int     `json:"link_speed_mbps"`
	Up            bool    `json:"up"`
}

type Device struct {
	ID            string          `json:"id"`
	Mac           string          `json:"mac"`
	Name          string          `json:"name"`
	UptimeSeconds int64           `json:"uptime_seconds"`
	CPUPct        float64         `json:"cpu_pct"`
	MemPct        float64         `json:"mem_pct"`
	TxBytes       int64           `json:"tx_bytes"`
	RxBytes       int64           `json:"rx_bytes"`
	NumClients    int             `json:"num_clients"`
	PoePorts      []PoePort       `json:"poe_ports"`
	SiteID        string          `json:"site_id"`
	Raw           json.RawMessage `json:"raw"`
}

type Client struct {
	Mac               string          `json:"mac"`
	Hostname          string          `json:"hostname"`
	IP                string          `json:"ip"`
	ConnectedDeviceID string          `json:"connected_device_id"`
	SSID              string          `json:"ssid"`
	SiteID            string          `json:"site_id"`
	UplinkPortIdx     int             `json:"uplink_port_idx"`
	Vlan              int             `json:"vlan"`
	SignalDbm         int             `json:"signal_dbm"`
	IsWired           bool            `json:"is_wired"`
	TxBytes           int64           `json:"tx_bytes"`
	RxBytes           int64           `json:"rx_bytes"`
	UptimeSeconds     int64           `json:"uptime_seconds"`
	Raw               json.RawMessage `json:"raw"`
}

type Snapshot struct {
	Devices    []Device
	Clients    []Client
	FirmwareOK bool
}

type APIClient struct {
	base   string
	apiKey string
	http   *http.Client
}

// NewAPIClient builds a read-only client. Local controllers ship self-signed certs;
// callers that need to tolerate them pass an http.Client configured accordingly
// (see DefaultHTTPClient). The passed client is used verbatim.
func NewAPIClient(controllerURL, apiKey string, httpClient *http.Client) *APIClient {
	if httpClient == nil {
		httpClient = DefaultHTTPClient()
	}
	return &APIClient{base: strings.TrimRight(controllerURL, "/"), apiKey: apiKey, http: httpClient}
}

// DefaultHTTPClient tolerates the controller's self-signed TLS. SECURITY TRADEOFF:
// UniFi consoles ship rotating self-signed certs with no enrollable CA, so strict
// verification is impractical out of the box; we accept that the LAN target is FIXED
// by the operator-configured controller_url (not attacker-supplied per poll) and the
// agent reaches it over the local network. This matches the existing agent httpfetch
// self-signed handling. FUTURE HARDENING (Phase 2b or a follow-up): store an expected
// cert SHA-256 fingerprint on the unifi_collectors row and pin it here via
// tls.Config.VerifyConnection, falling back to skip only when no fingerprint is set.
func DefaultHTTPClient() *http.Client {
	// nolint:gosec // G402: self-signed LAN controller; target fixed by config. See note above.
	return &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
}

type envelope struct {
	Data json.RawMessage `json:"data"`
}

// get returns (body, statusCode, error). A 404 on the integration base is treated by
// Poll as "integration unavailable / firmware too old" rather than a hard error.
func (c *APIClient) get(ctx context.Context, path string) (json.RawMessage, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("X-API-KEY", c.apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return nil, resp.StatusCode, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.StatusCode, fmt.Errorf("unifi api %s: status %d", path, resp.StatusCode)
	}
	var env envelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("unifi api %s: bad json: %w", path, err)
	}
	return env.Data, resp.StatusCode, nil
}

// Poll reads sites, then devices + clients per site, tagging each with its SiteID.
func (c *APIClient) Poll(ctx context.Context) (Snapshot, error) {
	var snap Snapshot
	sitesData, status, err := c.get(ctx, apiBase+"/sites")
	if err != nil {
		return snap, err
	}
	if status == http.StatusNotFound {
		snap.FirmwareOK = false
		return snap, nil
	}
	snap.FirmwareOK = true
	var sites []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(sitesData, &sites); err != nil {
		return snap, fmt.Errorf("decode sites: %w", err)
	}
	for _, s := range sites {
		devData, _, err := c.get(ctx, fmt.Sprintf("%s/sites/%s/devices", apiBase, s.ID))
		if err != nil {
			return snap, err
		}
		var devs []Device
		_ = json.Unmarshal(devData, &devs)
		for i := range devs {
			devs[i].SiteID = s.ID
			devs[i].Raw = rawOf(devData, i)
		}
		snap.Devices = append(snap.Devices, devs...)

		cliData, _, err := c.get(ctx, fmt.Sprintf("%s/sites/%s/clients", apiBase, s.ID))
		if err != nil {
			return snap, err
		}
		var clis []Client
		_ = json.Unmarshal(cliData, &clis)
		for i := range clis {
			clis[i].SiteID = s.ID
			clis[i].Raw = rawOf(cliData, i)
		}
		snap.Clients = append(snap.Clients, clis...)
	}
	return snap, nil
}

// rawOf returns the raw JSON element at index i of a JSON array, or null.
func rawOf(arr json.RawMessage, i int) json.RawMessage {
	var elems []json.RawMessage
	if err := json.Unmarshal(arr, &elems); err != nil || i >= len(elems) {
		return json.RawMessage("null")
	}
	return elems[i]
}
```

> The Network Integration API field names are version-dependent. The structs map a plausible subset; the `raw` element is always preserved. Validate field names against a live ≥9.3 controller and adjust json tags (and the API-base path) when available — keep `raw` regardless.

- [ ] **Step 4: Run to verify pass** — `cd agent && go test -race ./internal/unifi/...` → PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/unifi/client.go agent/internal/unifi/client_test.go
git commit -m "feat(agent): UniFi Network Integration API read-only client"
```

---

## Task 9: Agent Go — collector scheduler + upload + wiring

**Files:**
- Create: `agent/internal/unifi/collector.go`
- Test: `agent/internal/unifi/collector_test.go`
- Modify: the agent entrypoint that starts periodic loops (grep for where other periodic collectors/heartbeat start, e.g. `agent/internal/agent/agent.go` or `agent/cmd/.../main.go`)

**Interfaces:**
- Consumes: `APIClient`, `Snapshot` (Task 8); the agent's authenticated HTTP transport to the Breeze API (the same one heartbeat/metrics use — grep how an existing periodic collector POSTs to the API with the agent token).
- Produces: `func StartCollectorLoop(ctx context.Context, deps CollectorDeps)` where `CollectorDeps` holds the API base URL, an authed `*http.Client`/poster, and a logger.

- [ ] **Step 1: Write the failing test**

Create `agent/internal/unifi/collector_test.go` — exercise the payload assembly + upload against an `httptest` server standing in for both the controller and the Breeze API:

```go
package unifi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestRunOnceUploadsTelemetry(t *testing.T) {
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/proxy/network/integration/v1/sites":
			w.Write([]byte(`{"data":[{"id":"s1"}]}`))
		case "/proxy/network/integration/v1/sites/s1/devices":
			w.Write([]byte(`{"data":[{"id":"d1","mac":"aa:bb"}]}`))
		case "/proxy/network/integration/v1/sites/s1/clients":
			w.Write([]byte(`{"data":[{"mac":"cc:dd"}]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer controller.Close()

	var mu sync.Mutex
	var got map[string]any
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/agent/unifi-telemetry" {
			mu.Lock()
			defer mu.Unlock()
			_ = json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(202)
		}
	}))
	defer api.Close()

	cfg := CollectorConfig{CollectorID: "c1", ControllerURL: controller.URL, APIKey: "k"}
	err := RunOnce(context.Background(), CollectorDeps{APIBaseURL: api.URL, HTTP: api.Client()}, cfg, controller.Client())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if got["collectorId"] != "c1" || got["firmwareOk"] != true {
		t.Fatalf("unexpected payload: %+v", got)
	}
}
```

- [ ] **Step 2: Run to verify failure** — `cd agent && go test ./internal/unifi/...` → FAIL (RunOnce/CollectorConfig/CollectorDeps undefined).

- [ ] **Step 3: Implement the collector**

Create `agent/internal/unifi/collector.go`:

```go
package unifi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type CollectorConfig struct {
	CollectorID         string `json:"collectorId"`
	UnifiHostID         string `json:"unifiHostId"`
	ControllerURL       string `json:"controllerUrl"`
	APIKey              string `json:"apiKey"`
	PollIntervalSeconds int    `json:"pollIntervalSeconds"`
}

type CollectorDeps struct {
	APIBaseURL string
	HTTP       *http.Client // authed transport to the Breeze API (agent token attached)
	Logf       func(format string, args ...any)
}

func (d CollectorDeps) logf(format string, args ...any) {
	if d.Logf != nil {
		d.Logf(format, args...)
	}
}

type telemetryPayload struct {
	CollectorID string    `json:"collectorId"`
	PolledAt    string    `json:"polledAt"`
	FirmwareOK  bool      `json:"firmwareOk"`
	Devices     []Device  `json:"devices"`
	Clients     []Client  `json:"clients"`
	Error       string    `json:"error,omitempty"`
}

// RunOnce polls one controller and uploads the snapshot. controllerHTTP may be nil
// (DefaultHTTPClient is used). Returns an error only on upload failure; controller-side
// failures are reported in the payload (FirmwareOK / Error).
func RunOnce(ctx context.Context, deps CollectorDeps, cfg CollectorConfig, controllerHTTP *http.Client) error {
	api := NewAPIClient(cfg.ControllerURL, cfg.APIKey, controllerHTTP)
	snap, pollErr := api.Poll(ctx)
	payload := telemetryPayload{
		CollectorID: cfg.CollectorID,
		PolledAt:    time.Now().UTC().Format(time.RFC3339),
		FirmwareOK:  snap.FirmwareOK,
		Devices:     snap.Devices,
		Clients:     snap.Clients,
	}
	if pollErr != nil {
		payload.Error = pollErr.Error()
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, deps.APIBaseURL+"/agent/unifi-telemetry", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := deps.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		return fmt.Errorf("telemetry upload: status %d", resp.StatusCode)
	}
	return nil
}

// StartCollectorLoop periodically fetches this agent's collector configs from
// GET /agent/unifi-collectors and runs each due collector. It exits when ctx is done.
func StartCollectorLoop(ctx context.Context, deps CollectorDeps) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	lastRun := map[string]time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			configs, err := fetchConfigs(ctx, deps)
			if err != nil {
				deps.logf("[unifi] fetch configs: %v", err)
				continue
			}
			now := time.Now()
			for _, cfg := range configs {
				interval := time.Duration(maxInt(cfg.PollIntervalSeconds, 15)) * time.Second
				if last, ok := lastRun[cfg.CollectorID]; ok && now.Sub(last) < interval {
					continue
				}
				lastRun[cfg.CollectorID] = now
				if err := RunOnce(ctx, deps, cfg, nil); err != nil {
					deps.logf("[unifi] collector %s: %v", cfg.CollectorID, err)
				}
			}
		}
	}
}

func fetchConfigs(ctx context.Context, deps CollectorDeps) ([]CollectorConfig, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, deps.APIBaseURL+"/agent/unifi-collectors", nil)
	if err != nil {
		return nil, err
	}
	resp, err := deps.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch configs: status %d", resp.StatusCode)
	}
	var out struct {
		Collectors []CollectorConfig `json:"collectors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Collectors, nil
}

func maxInt(a, b int) int { if a > b { return a }; return b }
```

- [ ] **Step 4: Run to verify pass** — `cd agent && go test -race ./internal/unifi/...` → PASS.

- [ ] **Step 5: Wire into the agent entrypoint**

Find where the agent starts its periodic loops (grep for the heartbeat/metrics goroutine launch, e.g. in `agent/internal/agent/agent.go`). Start the loop with the agent's authed API client and base URL:

```go
import "breeze/agent/internal/unifi" // match the module path

// alongside the other go func() periodic starts, once enrolled:
go unifi.StartCollectorLoop(ctx, unifi.CollectorDeps{
	APIBaseURL: cfg.ServerURL,      // the API base the agent already uses
	HTTP:       authedHTTPClient,   // the *http.Client that attaches the agent bearer token
	Logf:       logger.Infof,       // match the agent's logger signature
})
```

> Use the SAME authed HTTP client the agent uses for heartbeat/metrics (so the agent bearer token is attached and `requireAgentRole` resolves the device). Confirm the field names (`cfg.ServerURL`, the authed client) against the entrypoint. This wiring is what makes the new capability live and is the line that necessitates an agent release.

- [ ] **Step 6: Build + test the agent**

```bash
cd agent && go build ./... && go test -race ./internal/unifi/...
```
Expected: builds clean; tests pass.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/unifi/collector.go agent/internal/unifi/collector_test.go agent/internal/agent/agent.go
git commit -m "feat(agent): UniFi collector loop (pull configs, poll controller, upload telemetry)"
```

---

## Task 10: Web — collector config + telemetry panel

**Files:**
- Modify: `apps/web/src/components/integrations/UnifiIntegration.tsx`

**Interfaces:**
- Consumes: `runAction`, `ActionError`, `handleActionError` (`../../lib/runAction`); `fetchWithAuth` (`../../stores/auth`); existing component state. New endpoints: `GET/PUT/DELETE /unifi/collectors`, `GET /unifi/telemetry?siteId=`, plus the existing `/unifi/hosts`, `/unifi/mappings`, `/orgs/sites`.

- [ ] **Step 1: Add collector config to the mapping panel**

In `UnifiIntegration.tsx`, extend the connected view. For each discovered host (from `/unifi/hosts`), add a "Deep telemetry" row: a collector-agent picker (online agents at the mapped site — reuse the bridge-agent picker source `GET /devices?siteId=&online=true` the network-proxy modal uses; confirm its exact query), a controller-URL input, a password input for the local API key, an enable toggle, and a Save button. Wire Save through `runAction`:

```tsx
const saveCollector = useCallback(async (hostId: string, siteId: string, deviceId: string, controllerUrl: string, apiKey: string) => {
  try {
    await runAction({
      request: () => fetchWithAuth('/unifi/collectors', {
        method: 'PUT',
        body: JSON.stringify({ unifiHostId: hostId, siteId, collectorDeviceId: deviceId, controllerUrl, apiKey }),
      }),
      errorFallback: 'Failed to save the UniFi collector.',
      successMessage: 'UniFi collector saved',
      onUnauthorized,
    });
    await loadDetails();
  } catch (err) {
    if (err instanceof ActionError && err.status === 401) return;
    if (!(err instanceof ActionError)) handleActionError(err, 'Failed to save the UniFi collector.');
  }
}, [loadDetails, onUnauthorized]);
```

Load existing collectors in `loadDetails` (add `fetchWithAuth('/unifi/collectors')` to the parallel fetch and store the result) so each host row shows its current collector `status` (incl. `unreachable` / `firmware_too_old`) and pre-fills the agent/URL.

- [ ] **Step 2: Add a read-only telemetry panel**

Add a "Deep telemetry" card per mapped site that fetches `GET /unifi/telemetry?siteId=<breezeSiteId>` and renders: a devices table (name, model via the Phase 1 `unifi_devices` join if present, uptime, client count, and a per-port PoE summary from `poe_ports`), and a clients table (hostname, IP, connected device, signal, wired/wifi). Use the same table idiom as the existing sync-history table (`min-w-full divide-y text-sm`, `data-testid` per row). Mark `is_stale` rows visually muted.

- [ ] **Step 3: Typecheck + web tests**

```bash
cd apps/web && pnpm vitest run && pnpm astro check
```
Expected: existing suite green; no new type errors in `UnifiIntegration.tsx`. (Pre-existing unrelated `astro check` errors in form components are not introduced by this task — confirm none reference `UnifiIntegration.tsx`.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/integrations/UnifiIntegration.tsx
git commit -m "feat(unifi): web collector config + deep-telemetry panel"
```

---

## Final verification

- [ ] **Step 1: Full API + web suites green**

```bash
pnpm test --filter=@breeze/api
cd apps/web && pnpm vitest run
```

- [ ] **Step 2: Agent tests green**

```bash
cd agent && go test -race ./internal/unifi/...
```

- [ ] **Step 3: RLS integration suite green**

```bash
cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```

- [ ] **Step 4: Live forge check (as `breeze_app`)**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "insert into unifi_collectors(integration_id,org_id,site_id,unifi_host_id,collector_device_id,controller_url,local_api_key_encrypted) values (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'x',gen_random_uuid(),'https://x','x');"
```
Expected: `ERROR: new row violates row-level security policy for table "unifi_collectors"`.

- [ ] **Step 5: Agent release**

Build + release the agent with the new collector capability; promote per region (platformAdmin + MFA; `AGENT_AUTO_PROMOTE=false`). Bare semver in code/config; `v` prefix only on the git tag.

- [ ] **Step 6: Manual smoke (needs a real ≥9.3 controller + a local API key)**

Enable deep telemetry for one mapped console (pick a collector agent, enter the controller URL + local key), wait one poll interval, and confirm `unifi_device_telemetry` + `unifi_clients` populate, `unifi_collectors.status='connected'`, matching `discovered_assets` rows gain a `discovered_asset_id` link on clients, and a below-9.3 controller reports `firmware_too_old`.

---

## Self-Review notes (coverage map)

- Spec "three tables + org-axis RLS" → Task 1. Forge tests → Task 2.
- "collector config, encrypted key, agent-pull, status" → Task 3.
- "snapshot upsert/stale + discovered_assets enrich-only by MAC, per-row site resolution" → Task 4.
- "ingest enqueues, worker reconciles system-scoped, collector status incl. firmware_too_old" → Tasks 5–6.
- "agent-role ingest + collector-pull endpoints" → Task 6.
- "partner-scoped collector CRUD + cross-org guard + telemetry read" → Task 7.
- "agent Network Integration API read-only client, firmware probe, raw preserved" → Task 8.
- "agent collector loop: pull configs, poll, upload; isolated per-console failures" → Task 9.
- "web collector config + telemetry panel, runAction" → Task 10.

**Known follow-ups deferred (not blockers):**
- Field-name validation of the Network Integration API structs against a live ≥9.3 controller (Task 8 note) — keep `raw` regardless.
- Confirm the exact agent-auth middleware name/context key (Task 6) and the agent entrypoint's authed-client/field names (Task 9) before implementing those tasks.
- The bridge-agent picker query for online agents at a site (Task 10) — reuse the network-proxy modal's source.
