# UniFi Self-Hosted Controller Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP register a single self-hosted UniFi Network controller (one VM serving many customer sites) by URL + collector agent + local API key — with no UniFi cloud (`api.ui.com`) involvement — and have that one controller deliver both inventory and deep telemetry, routed to the correct customer org per site.

**Architecture:** Add a `connection_type` discriminator (`'cloud' | 'self_hosted'`) to `unifi_integrations`. For self-hosted, the existing agent collector loop and telemetry-ingest pipeline are reused almost verbatim — the agent already enumerates every site on the controller and tags each device/client with its `unifi_site_id`, and `reconcileTelemetry` already routes rows to the right Breeze site via `unifi_site_mappings`. The work is: relax the host-id-keyed collector constraints so one controller (no cloud host) can exist and fan out to many site mappings; add an agent-reported controller-site discovery list so the mapping UI has something to map; reconcile telemetry devices into `discovered_assets` for inventory parity; and add the self-hosted connect/register/map UI.

**Tech Stack:** PostgreSQL + Drizzle ORM, Hono (TypeScript) API, BullMQ workers, Go agent, Astro + React (web). Tests: Vitest (API/web), `go test -race` (agent), RLS integration test (`vitest.config.rls.ts` / `rls-coverage.integration.test.ts`).

## Global Constraints

- **Design spec:** `docs/superpowers/specs/integrations/2026-06-29-unifi-self-hosted-controller-design.md`. Every task implements part of it.
- **Migrations:** hand-written SQL in `apps/api/migrations/`, named `2026-06-29-<slug>.sql`. **Idempotent** (`IF NOT EXISTS`, `DROP ... IF EXISTS` then recreate, `DO $$ ... pg_policies` checks). **No inner `BEGIN;`/`COMMIT;`** (the runner wraps each file). Never edit a shipped migration. Same-day dependent migrations use `-a-`/`-b-` infixes.
- **RLS:** every tenant-scoped table has RLS enabled + forced + policies created in the same migration. New tables added to the matching allowlist in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` in this PR. `unifi_controller_sites` is org-axis (direct `org_id` column) → auto-discovered, no allowlist entry needed, but must have policies.
- **DB context:** request paths use `db` under `withDbAccessContext` (middleware-provided); agent/worker paths use `withSystemDbAccessContext`. Never use a bare pool in request code.
- **Drizzle:** type-safe queries only. Do NOT run `drizzle-kit generate/push`. After schema edits run `pnpm db:check-drift`.
- **Web mutations:** new POST/PUT handlers wrap requests in `runAction` (`apps/web/src/lib/runAction.ts`).
- **Partner scope:** all `/unifi/*` routes are `requireScope('partner','system')` + `BILLING_MANAGE`. Keep that.
- **Self-hosted invariants (non-goals):** one `connection_type` per partner integration (no mixed cloud+self-hosted simultaneously); one collector agent per controller (no HA).
- **Local site ids:** the UniFi Network *integration* API returns an opaque per-site `id` (not the `default` slug). `reconcileTelemetry` keys the site map on `unifi_site_id` alone; self-hosted mapping rows store `unifi_host_id = <collectorId>` as a stable sentinel so the existing `(integration_id, unifi_host_id, unifi_site_id)` unique index still applies.

---

## File map

**Create:**
- `apps/api/migrations/2026-06-29-a-unifi-self-hosted-connection.sql` — `connection_type`, nullable cloud key + CHECK.
- `apps/api/migrations/2026-06-29-b-unifi-self-hosted-collectors-and-sites.sql` — collector host-id nullability + index surgery; new `unifi_controller_sites` table + RLS.
- `apps/api/src/services/unifi/unifiControllerSiteService.ts` — upsert/list agent-reported controller sites.
- `apps/api/src/services/unifi/unifiControllerSiteService.test.ts`
- `apps/api/src/services/unifi/unifiSelfHostedService.test.ts` (self-hosted integration + controller upsert)

**Modify:**
- `apps/api/src/db/schema/unifi.ts` — `connectionType` col; nullable `unifiHostId`; `unifiControllerSites` table.
- `apps/api/src/services/unifi/unifiConnectionService.ts` — `createSelfHostedIntegration`, expose `connectionType`.
- `apps/api/src/services/unifi/unifiCollectorService.ts` — self-hosted upsert keyed on `controller_url`; null host id in `AgentCollectorConfig`.
- `apps/api/src/routes/unifi/index.ts` — `POST /unifi/connect-self-hosted`, `PUT /unifi/controllers`, `GET /unifi/controller-sites`.
- `apps/api/src/routes/unifi/index.test.ts` (create if absent) — route tests.
- `apps/api/src/routes/agents/unifiTelemetry.ts` — accept optional `sites: [{id,name}]` in `telemetrySchema`.
- `apps/api/src/services/unifi/unifiTelemetryService.ts` — upsert `unifi_controller_sites` from payload; reconcile devices into `discovered_assets`.
- `apps/api/src/services/unifi/unifiTelemetryService.test.ts`
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — allowlist note for `unifi_controller_sites` (auto-discovered org-axis; assert policies present).
- `agent/internal/unifi/client.go` — capture site `name`; return discovered sites from `Poll`.
- `agent/internal/unifi/client_test.go`
- `agent/internal/unifi/collector.go` — carry `Sites` into `telemetryPayload`.
- `agent/internal/unifi/collector_test.go`
- `apps/web/src/components/integrations/UnifiIntegration.tsx` — connection-type choice; self-hosted register + map from controller sites.

---

## Phase A — Schema & migration

### Task A1: `connection_type` on `unifi_integrations`

**Files:**
- Create: `apps/api/migrations/2026-06-29-a-unifi-self-hosted-connection.sql`
- Modify: `apps/api/src/db/schema/unifi.ts:22-40`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing ordering regression test — just runs; no new test code here, verified via drift + migrate)

**Interfaces:**
- Produces: `unifi_integrations.connection_type text NOT NULL DEFAULT 'cloud'`; `api_key_encrypted` becomes nullable with CHECK that it is non-null when `connection_type='cloud'`. Drizzle: `unifiIntegrations.connectionType`, `unifiIntegrations.apiKeyEncrypted` (now nullable).

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-29-a-unifi-self-hosted-connection.sql`:

```sql
-- UniFi self-hosted controllers (part a): connection_type discriminator on the
-- partner integration row. 'cloud' = existing Site Manager (api.ui.com) flow;
-- 'self_hosted' = agent-mediated local Network controller with no cloud key.

ALTER TABLE unifi_integrations
  ADD COLUMN IF NOT EXISTS connection_type text NOT NULL DEFAULT 'cloud';

-- Self-hosted integrations carry no cloud API key; relax the NOT NULL and guard
-- it with a CHECK so cloud rows still require a key.
ALTER TABLE unifi_integrations ALTER COLUMN api_key_encrypted DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unifi_integrations_cloud_key_chk'
  ) THEN
    ALTER TABLE unifi_integrations
      ADD CONSTRAINT unifi_integrations_cloud_key_chk
      CHECK (connection_type <> 'cloud' OR api_key_encrypted IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unifi_integrations_connection_type_chk'
  ) THEN
    ALTER TABLE unifi_integrations
      ADD CONSTRAINT unifi_integrations_connection_type_chk
      CHECK (connection_type IN ('cloud', 'self_hosted'));
  END IF;
END $$;
```

- [ ] **Step 2: Update the Drizzle schema**

In `apps/api/src/db/schema/unifi.ts`, edit the `unifiIntegrations` table (lines 22-35). Change `apiKeyEncrypted` to nullable and add `connectionType`:

```ts
export const unifiIntegrations = pgTable('unifi_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  connectionType: text('connection_type').notNull().default('cloud'),
  baseUrl: text('base_url').notNull().default('https://api.ui.com'),
  apiKeyEncrypted: text('api_key_encrypted'),
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
```

- [ ] **Step 3: Apply migration + verify no drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
pnpm db:check-drift
```
Expected: autoMigrate test passes (ordering OK); `db:check-drift` reports no drift between schema and migrations.

- [ ] **Step 4: Verify idempotency**

Run the migration test a second time (re-apply must be a no-op — the runner skips already-applied files, and the SQL is guarded). Confirm no error.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-29-a-unifi-self-hosted-connection.sql apps/api/src/db/schema/unifi.ts
git commit -m "feat(unifi): add connection_type to unifi_integrations for self-hosted"
```

---

### Task A2: nullable collector host id + index surgery

**Files:**
- Modify: `apps/api/migrations/2026-06-29-b-unifi-self-hosted-collectors-and-sites.sql` (created here; controller-sites table added in A3 to the same file)
- Modify: `apps/api/src/db/schema/unifi.ts:109-131`

**Interfaces:**
- Produces: `unifi_collectors.unifi_host_id` nullable. Unique index `unifi_collectors_integration_host_idx` becomes partial (`WHERE unifi_host_id IS NOT NULL`). New partial unique index `unifi_collectors_integration_url_idx` on `(integration_id, controller_url) WHERE unifi_host_id IS NULL`. Drizzle: `unifiCollectors.unifiHostId` nullable.

- [ ] **Step 1: Start the part-b migration with collector changes**

Create `apps/api/migrations/2026-06-29-b-unifi-self-hosted-collectors-and-sites.sql`:

```sql
-- UniFi self-hosted controllers (part b): one collector row per controller (no
-- cloud host id), plus the agent-reported controller-site discovery table.

-- 1. Collector host id becomes nullable; a self-hosted controller has no cloud host.
ALTER TABLE unifi_collectors ALTER COLUMN unifi_host_id DROP NOT NULL;

-- Replace the unconditional unique (integration, host) with a partial that only
-- governs cloud collectors (host id present). Self-hosted rows (null host id) are
-- governed by a separate (integration, controller_url) unique index below.
DROP INDEX IF EXISTS unifi_collectors_integration_host_idx;
CREATE UNIQUE INDEX IF NOT EXISTS unifi_collectors_integration_host_idx
  ON unifi_collectors(integration_id, unifi_host_id)
  WHERE unifi_host_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS unifi_collectors_integration_url_idx
  ON unifi_collectors(integration_id, controller_url)
  WHERE unifi_host_id IS NULL;
```

> Note: dropping and recreating `unifi_collectors_integration_host_idx` as a partial index is safe because no production self-hosted rows exist yet; all existing rows have a non-null host id and remain covered.

- [ ] **Step 2: Update the Drizzle schema**

In `apps/api/src/db/schema/unifi.ts`, edit `unifiCollectors` (lines 109-131): make `unifiHostId` nullable and update the index definitions:

```ts
  unifiHostId: text('unifi_host_id'),
```
and replace the table-config block (lines 128-131):
```ts
}, (table) => ({
  integrationHostIdx: uniqueIndex('unifi_collectors_integration_host_idx')
    .on(table.integrationId, table.unifiHostId)
    .where(sql`${table.unifiHostId} IS NOT NULL`),
  integrationUrlIdx: uniqueIndex('unifi_collectors_integration_url_idx')
    .on(table.integrationId, table.controllerUrl)
    .where(sql`${table.unifiHostId} IS NULL`),
  deviceIdx: index('unifi_collectors_device_idx').on(table.collectorDeviceId).where(sql`${table.isEnabled}`),
}));
```

- [ ] **Step 3: Apply + drift check**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
pnpm db:check-drift
```
Expected: passes, no drift. (Schema `.where()` partial-index predicates must match the SQL exactly or drift will flag.)

- [ ] **Step 4: Commit** (combined with A3; if committing separately:)

```bash
git add apps/api/migrations/2026-06-29-b-unifi-self-hosted-collectors-and-sites.sql apps/api/src/db/schema/unifi.ts
git commit -m "feat(unifi): nullable collector host id + controller_url uniqueness"
```

---

### Task A3: `unifi_controller_sites` discovery table

**Files:**
- Modify: `apps/api/migrations/2026-06-29-b-unifi-self-hosted-collectors-and-sites.sql` (append)
- Modify: `apps/api/src/db/schema/unifi.ts` (append table)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

**Interfaces:**
- Produces: table `unifi_controller_sites` (`id`, `collector_id`, `org_id`, `local_site_id`, `name`, `last_seen_at`, timestamps), unique `(collector_id, local_site_id)`, org-axis RLS. Drizzle export `unifiControllerSites`.

- [ ] **Step 1: Append the table to the part-b migration**

Append to `apps/api/migrations/2026-06-29-b-unifi-self-hosted-collectors-and-sites.sql`:

```sql
-- 2. unifi_controller_sites: the local sites the agent discovered on a self-hosted
-- controller, so the mapping UI can list them. org-axis = collector agent's org.
CREATE TABLE IF NOT EXISTS unifi_controller_sites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id  uuid NOT NULL REFERENCES unifi_collectors(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id),
  local_site_id text NOT NULL,
  name          text,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unifi_controller_sites_collector_site_idx
  ON unifi_controller_sites(collector_id, local_site_id);

ALTER TABLE unifi_controller_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_controller_sites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON unifi_controller_sites;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON unifi_controller_sites;
DROP POLICY IF EXISTS breeze_org_isolation_update ON unifi_controller_sites;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON unifi_controller_sites;
CREATE POLICY breeze_org_isolation_select ON unifi_controller_sites
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON unifi_controller_sites
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON unifi_controller_sites
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON unifi_controller_sites
  FOR DELETE USING (public.breeze_has_org_access(org_id));
```

- [ ] **Step 2: Add the Drizzle table**

Append to `apps/api/src/db/schema/unifi.ts`:

```ts
export const unifiControllerSites = pgTable('unifi_controller_sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectorId: uuid('collector_id').notNull().references(() => unifiCollectors.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  localSiteId: text('local_site_id').notNull(),
  name: text('name'),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  collectorSiteIdx: uniqueIndex('unifi_controller_sites_collector_site_idx')
    .on(table.collectorId, table.localSiteId),
}));
```

- [ ] **Step 3: Confirm RLS contract test discovers the table**

`unifi_controller_sites` has a direct `org_id` column (tenancy shape #1), so the RLS coverage test auto-discovers it — no allowlist edit. Run the contract test (needs a real DB):

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS, with `unifi_controller_sites` covered (RLS enabled + forced + 4 policies). If it reports the table as missing policies, the migration didn't apply — re-run migrate.

- [ ] **Step 4: Forge a cross-tenant insert as `breeze_app`**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "INSERT INTO unifi_controller_sites (collector_id, org_id, local_site_id) VALUES (gen_random_uuid(), gen_random_uuid(), 'x');"
```
Expected: `ERROR: new row violates row-level security policy for table "unifi_controller_sites"`.

- [ ] **Step 5: Drift check + commit**

```bash
pnpm db:check-drift
git add apps/api/migrations/2026-06-29-b-unifi-self-hosted-collectors-and-sites.sql apps/api/src/db/schema/unifi.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(unifi): unifi_controller_sites discovery table with org-axis RLS"
```

---

## Phase B — API services & routes

### Task B1: self-hosted integration creation

**Files:**
- Modify: `apps/api/src/services/unifi/unifiConnectionService.ts`
- Modify: `apps/api/src/routes/unifi/index.ts` (add `POST /unifi/connect-self-hosted`; surface `connectionType` in `GET /unifi`)
- Test: `apps/api/src/services/unifi/unifiSelfHostedService.test.ts`

**Interfaces:**
- Consumes: `db`, `partnerId`.
- Produces: `createSelfHostedIntegration(db, partnerId, { accountLabel, createdBy }): Promise<{ id: string; connectionType: 'self_hosted' }>`. `getConnection` result gains `connectionType: 'cloud' | 'self_hosted'`. Route `POST /unifi/connect-self-hosted` body `{ accountLabel?: string }` → `{ connected: true, connectionType: 'self_hosted' }`.

- [ ] **Step 1: Write the failing service test**

Create `apps/api/src/services/unifi/unifiSelfHostedService.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createSelfHostedIntegration } from './unifiConnectionService';

function mockDb(returning: any[]) {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(returning),
        }),
      }),
    }),
  } as any;
}

describe('createSelfHostedIntegration', () => {
  it('inserts a self_hosted integration with no api key', async () => {
    const db = mockDb([{ id: 'int-1', connectionType: 'self_hosted' }]);
    const out = await createSelfHostedIntegration(db, 'partner-1', { accountLabel: 'HQ VM', createdBy: 'user-1' });
    expect(out).toEqual({ id: 'int-1', connectionType: 'self_hosted' });
    const values = (db.insert as any).mock.results[0].value.values.mock.calls[0][0];
    expect(values.connectionType).toBe('self_hosted');
    expect(values.apiKeyEncrypted ?? null).toBeNull();
    expect(values.partnerId).toBe('partner-1');
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `pnpm --filter @breeze/api exec vitest run src/services/unifi/unifiSelfHostedService.test.ts`
Expected: FAIL — `createSelfHostedIntegration is not a function`.

- [ ] **Step 3: Implement the service function**

In `apps/api/src/services/unifi/unifiConnectionService.ts`, add (mirror the existing `upsertConnection`, but with no key and `connectionType: 'self_hosted'`; reuse the same `unifi_integrations_partner_active_idx` conflict target). Add near the existing exports:

```ts
export async function createSelfHostedIntegration(
  db: DbExecutor,
  partnerId: string,
  fields: { accountLabel?: string | null; createdBy?: string | null },
): Promise<{ id: string; connectionType: 'self_hosted' }> {
  const rows = await db
    .insert(unifiIntegrations)
    .values({
      partnerId,
      connectionType: 'self_hosted',
      apiKeyEncrypted: null,
      accountLabel: fields.accountLabel ?? null,
      createdBy: fields.createdBy ?? null,
      status: 'connected',
      isActive: true,
    })
    .onConflictDoUpdate({
      target: unifiIntegrations.partnerId,
      targetWhere: sql`${unifiIntegrations.isActive}`,
      set: {
        connectionType: 'self_hosted',
        accountLabel: fields.accountLabel ?? null,
        status: 'connected',
        updatedAt: new Date(),
      },
    })
    .returning({ id: unifiIntegrations.id, connectionType: unifiIntegrations.connectionType });
  if (!rows[0]) throw new Error('createSelfHostedIntegration returned no row');
  return { id: rows[0].id, connectionType: 'self_hosted' };
}
```

Ensure `sql` is imported from `drizzle-orm` and `connectionType` is included in the `getConnection` select (add `connectionType: unifiIntegrations.connectionType` to its returned object so the route can branch).

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm --filter @breeze/api exec vitest run src/services/unifi/unifiSelfHostedService.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the route**

In `apps/api/src/routes/unifi/index.ts`, import `createSelfHostedIntegration`, and after the `POST /unifi/connect` handler add:

```ts
const connectSelfHostedSchema = z.object({
  accountLabel: z.string().max(200).optional(),
});

// POST /unifi/connect-self-hosted — create a self-hosted integration (no cloud key)
unifiRoutes.post('/connect-self-hosted', partnerScopes, writePerm, requireMfa(), zValidator('json', connectSelfHostedSchema), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const { accountLabel } = c.req.valid('json');
  const integration = await createSelfHostedIntegration(db, partner.partnerId, {
    accountLabel: accountLabel ?? null,
    createdBy: auth.user.id,
  });
  return c.json({ connected: true, connectionType: integration.connectionType });
});
```

Also extend `GET /unifi` (lines 73-80) to include `connectionType: conn.connectionType` in the response.

- [ ] **Step 6: Run the API unit suite for the route file**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/unifi/`
Expected: PASS (existing tests still green; new route compiles).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/unifi/unifiConnectionService.ts apps/api/src/services/unifi/unifiSelfHostedService.test.ts apps/api/src/routes/unifi/index.ts
git commit -m "feat(unifi): self-hosted integration creation endpoint"
```

---

### Task B2: self-hosted controller registration

**Files:**
- Modify: `apps/api/src/services/unifi/unifiCollectorService.ts`
- Modify: `apps/api/src/routes/unifi/index.ts` (add `PUT /unifi/controllers`)
- Test: `apps/api/src/services/unifi/unifiCollectorService.test.ts` (create if absent)

**Interfaces:**
- Consumes: `db`, validated body.
- Produces: `upsertSelfHostedController(db, { integrationId, orgId, siteId, collectorDeviceId, controllerUrl, apiKey, pollIntervalSeconds?, createdBy? }): Promise<UnifiCollector>` — inserts with `unifiHostId: null`, conflict target `(integration_id, controller_url)`. `AgentCollectorConfig.unifiHostId` becomes `string | null`. Route `PUT /unifi/controllers` body `{ siteId, collectorDeviceId, controllerUrl, apiKey, pollIntervalSeconds? }` → `{ success, collectorId }`.

- [ ] **Step 1: Write the failing service test**

Create/append `apps/api/src/services/unifi/unifiCollectorService.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { upsertSelfHostedController } from './unifiCollectorService';

vi.mock('../secretCrypto', () => ({
  encryptSecret: (v: string) => `enc(${v})`,
  decryptForColumn: (_t: string, _c: string, v: string) => v.replace(/^enc\(|\)$/g, ''),
}));

function mockInsertDb(returning: any[]) {
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(returning) });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return { db: { insert } as any, insert, values, onConflictDoUpdate };
}

describe('upsertSelfHostedController', () => {
  it('inserts a collector with null host id keyed on controller_url', async () => {
    const { db, values } = mockInsertDb([{
      id: 'col-1', integrationId: 'int-1', orgId: 'org-1', siteId: 'site-1', unifiHostId: null,
      collectorDeviceId: 'dev-1', controllerUrl: 'https://192.168.1.1', isEnabled: true,
      pollIntervalSeconds: 60, status: 'pending', firmwareOk: null, lastPollAt: null, lastPollStatus: null, lastPollError: null,
    }]);
    const out = await upsertSelfHostedController(db, {
      integrationId: 'int-1', orgId: 'org-1', siteId: 'site-1', collectorDeviceId: 'dev-1',
      controllerUrl: 'https://192.168.1.1', apiKey: 'secret',
    });
    expect(out.id).toBe('col-1');
    const inserted = values.mock.calls[0][0];
    expect(inserted.unifiHostId ?? null).toBeNull();
    expect(inserted.localApiKeyEncrypted).toBe('enc(secret)');
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `pnpm --filter @breeze/api exec vitest run src/services/unifi/unifiCollectorService.test.ts`
Expected: FAIL — `upsertSelfHostedController is not a function`.

- [ ] **Step 3: Implement the service function**

In `apps/api/src/services/unifi/unifiCollectorService.ts`: change `AgentCollectorConfig.unifiHostId` and `UnifiCollector.unifiHostId` to `string | null`. Add:

```ts
export async function upsertSelfHostedController(
  db: DbExecutor,
  fields: {
    integrationId: string;
    orgId: string;
    siteId: string;
    collectorDeviceId: string;
    controllerUrl: string;
    apiKey: string;
    pollIntervalSeconds?: number;
    createdBy?: string | null;
  },
): Promise<UnifiCollector> {
  const localApiKeyEncrypted = encryptSecret(fields.apiKey, { aad: 'unifi_collectors.local_api_key_encrypted' });
  const rows = await db
    .insert(unifiCollectors)
    .values({
      integrationId: fields.integrationId,
      orgId: fields.orgId,
      siteId: fields.siteId,
      unifiHostId: null,
      collectorDeviceId: fields.collectorDeviceId,
      controllerUrl: fields.controllerUrl,
      localApiKeyEncrypted,
      pollIntervalSeconds: fields.pollIntervalSeconds ?? 60,
      createdBy: fields.createdBy ?? null,
      status: 'pending',
    })
    .onConflictDoUpdate({
      target: [unifiCollectors.integrationId, unifiCollectors.controllerUrl],
      targetWhere: sql`${unifiCollectors.unifiHostId} IS NULL`,
      set: {
        orgId: fields.orgId,
        siteId: fields.siteId,
        collectorDeviceId: fields.collectorDeviceId,
        localApiKeyEncrypted,
        pollIntervalSeconds: fields.pollIntervalSeconds ?? 60,
        status: 'pending',
        lastPollError: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!rows[0]) throw new Error('upsertSelfHostedController returned no unifi_collectors row');
  return toCollector(rows[0]);
}
```

Add `import { sql } from 'drizzle-orm';` (the file currently imports only `and, eq`). The partial-index conflict target requires `targetWhere` to match the index predicate.

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm --filter @breeze/api exec vitest run src/services/unifi/unifiCollectorService.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the route**

In `apps/api/src/routes/unifi/index.ts`, import `upsertSelfHostedController`, add a schema and handler after `PUT /unifi/collectors`:

```ts
const controllerSchema = z.object({
  siteId: z.string().guid(),
  collectorDeviceId: z.string().guid(),
  controllerUrl: z.string().url().max(300),
  apiKey: z.string().min(1),
  pollIntervalSeconds: z.number().int().min(15).max(3600).optional(),
});

// PUT /unifi/controllers — register/update a self-hosted controller (no cloud host)
unifiRoutes.put('/controllers', partnerScopes, writePerm, requireMfa(), zValidator('json', controllerSchema), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ success: false, message: 'Not connected' }, 400);
  if (conn.connectionType !== 'self_hosted') {
    return c.json({ success: false, message: 'Controllers can only be registered on a self-hosted integration' }, 400);
  }
  const body = c.req.valid('json');
  const [site] = await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(eq(sites.id, body.siteId)).limit(1);
  if (!site) return c.json({ success: false, message: `Unknown Breeze site: ${body.siteId}` }, 400);
  if (!auth.canAccessOrg(site.orgId)) return c.json({ success: false, message: 'Access to target organization denied' }, 403);
  const [dev] = await db.select({ id: devices.id, orgId: devices.orgId }).from(devices).where(eq(devices.id, body.collectorDeviceId)).limit(1);
  if (!dev) return c.json({ success: false, message: 'Unknown collector agent' }, 400);
  if (dev.orgId !== site.orgId) return c.json({ success: false, message: 'Collector agent must belong to the site\'s organization' }, 400);
  const collector = await upsertSelfHostedController(db, {
    integrationId: conn.id,
    orgId: site.orgId,
    siteId: site.id,
    collectorDeviceId: body.collectorDeviceId,
    controllerUrl: body.controllerUrl,
    apiKey: body.apiKey,
    pollIntervalSeconds: body.pollIntervalSeconds,
    createdBy: auth.user.id,
  });
  return c.json({ success: true, collectorId: collector.id });
});
```

- [ ] **Step 6: Run the API suite**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/unifi/ src/services/unifi/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/unifi/unifiCollectorService.ts apps/api/src/services/unifi/unifiCollectorService.test.ts apps/api/src/routes/unifi/index.ts
git commit -m "feat(unifi): register self-hosted controllers keyed on controller_url"
```

---

### Task B3: controller-site discovery (ingest + list)

**Files:**
- Create: `apps/api/src/services/unifi/unifiControllerSiteService.ts`
- Test: `apps/api/src/services/unifi/unifiControllerSiteService.test.ts`
- Modify: `apps/api/src/routes/agents/unifiTelemetry.ts` (accept `sites`)
- Modify: `apps/api/src/services/unifi/unifiTelemetryService.ts` (`TelemetryPayload.sites`, call upsert)
- Modify: `apps/api/src/routes/unifi/index.ts` (`GET /unifi/controller-sites`)

**Interfaces:**
- Consumes: collector `orgId` (resolved in `reconcileTelemetry`), payload `sites: [{ id, name }]`.
- Produces: `upsertControllerSites(db, collectorId, orgId, sites): Promise<void>`; `listControllerSitesForIntegration(db, integrationId): Promise<Array<{ collectorId, localSiteId, name, mapped: boolean }>>`. `TelemetryPayload.sites?: Array<{ id: string; name?: string | null }>`. Route `GET /unifi/controller-sites` → `{ sites: [...] }`.

- [ ] **Step 1: Write the failing service test**

Create `apps/api/src/services/unifi/unifiControllerSiteService.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { upsertControllerSites } from './unifiControllerSiteService';

function mockDb() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return { db: { insert } as any, values };
}

describe('upsertControllerSites', () => {
  it('upserts one row per reported site with the collector org', async () => {
    const { db, values } = mockDb();
    await upsertControllerSites(db, 'col-1', 'org-1', [{ id: 's1', name: 'HQ' }, { id: 's2' }]);
    expect(values).toHaveBeenCalledTimes(2);
    expect(values.mock.calls[0][0]).toMatchObject({ collectorId: 'col-1', orgId: 'org-1', localSiteId: 's1', name: 'HQ' });
    expect(values.mock.calls[1][0]).toMatchObject({ collectorId: 'col-1', orgId: 'org-1', localSiteId: 's2', name: null });
  });

  it('no-ops on an empty list', async () => {
    const { db, values } = mockDb();
    await upsertControllerSites(db, 'col-1', 'org-1', []);
    expect(values).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `pnpm --filter @breeze/api exec vitest run src/services/unifi/unifiControllerSiteService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/unifi/unifiControllerSiteService.ts`:

```ts
import { eq, inArray } from 'drizzle-orm';
import { unifiControllerSites, unifiCollectors, unifiSiteMappings } from '../../db/schema';
import type { DbExecutor } from './unifiConnectionService';

export interface ReportedSite { id: string; name?: string | null }

// Upsert the agent-reported local sites for a self-hosted controller. Keyed on
// (collector_id, local_site_id). org comes from the collector (caller resolves it).
export async function upsertControllerSites(
  db: DbExecutor,
  collectorId: string,
  orgId: string,
  sites: ReportedSite[],
): Promise<void> {
  const now = new Date();
  for (const s of sites) {
    await db.insert(unifiControllerSites).values({
      collectorId, orgId, localSiteId: s.id, name: s.name ?? null, lastSeenAt: now,
    }).onConflictDoUpdate({
      target: [unifiControllerSites.collectorId, unifiControllerSites.localSiteId],
      set: { name: s.name ?? null, lastSeenAt: now, updatedAt: now },
    });
  }
}

// List discovered sites for a self-hosted integration's collectors, flagging which
// already have a Phase-1-style mapping row (unifi_host_id = collectorId sentinel).
export async function listControllerSitesForIntegration(
  db: DbExecutor,
  integrationId: string,
): Promise<Array<{ collectorId: string; localSiteId: string; name: string | null; mapped: boolean }>> {
  const collectors = await db.select({ id: unifiCollectors.id })
    .from(unifiCollectors).where(eq(unifiCollectors.integrationId, integrationId));
  const collectorIds = collectors.map((c: any) => c.id);
  if (collectorIds.length === 0) return [];
  const rows = await db.select({
    collectorId: unifiControllerSites.collectorId,
    localSiteId: unifiControllerSites.localSiteId,
    name: unifiControllerSites.name,
  }).from(unifiControllerSites).where(inArray(unifiControllerSites.collectorId, collectorIds));
  const mappings = await db.select({
    unifiHostId: unifiSiteMappings.unifiHostId, unifiSiteId: unifiSiteMappings.unifiSiteId,
  }).from(unifiSiteMappings).where(eq(unifiSiteMappings.integrationId, integrationId));
  const mappedKeys = new Set(mappings.map((m: any) => `${m.unifiHostId}::${m.unifiSiteId}`));
  return rows.map((r: any) => ({
    collectorId: r.collectorId, localSiteId: r.localSiteId, name: r.name,
    mapped: mappedKeys.has(`${r.collectorId}::${r.localSiteId}`),
  }));
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm --filter @breeze/api exec vitest run src/services/unifi/unifiControllerSiteService.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread `sites` through the ingest schema + payload type**

In `apps/api/src/routes/agents/unifiTelemetry.ts`, add to `telemetrySchema` (after `clients`):
```ts
  sites: z.array(z.object({ id: z.string().min(1), name: z.string().nullable().optional() })).optional(),
```
In `apps/api/src/services/unifi/unifiTelemetryService.ts`, add to `TelemetryPayload`:
```ts
  sites?: Array<{ id: string; name?: string | null }>;
```

- [ ] **Step 6: Call the upsert from reconcile**

In `reconcileTelemetry` (`unifiTelemetryService.ts`), after the collector is loaded (right after line 52, the `if (!collector) throw`), add:
```ts
  if (payload.sites && payload.sites.length > 0) {
    await upsertControllerSites(db, collector.id, collector.orgId, payload.sites);
  }
```
Add the import at the top: `import { upsertControllerSites } from './unifiControllerSiteService';`

- [ ] **Step 7: Add the list route**

In `apps/api/src/routes/unifi/index.ts`, import `listControllerSitesForIntegration`, add:
```ts
// GET /unifi/controller-sites — agent-discovered local sites for the mapping UI
unifiRoutes.get('/controller-sites', partnerScopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn) return c.json({ sites: [] });
  const sitesOut = await listControllerSitesForIntegration(db, conn.id);
  return c.json({ sites: sitesOut });
});
```

- [ ] **Step 8: Run API suites**

Run: `pnpm --filter @breeze/api exec vitest run src/services/unifi/ src/routes/unifi/ src/routes/agents/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/unifi/unifiControllerSiteService.ts apps/api/src/services/unifi/unifiControllerSiteService.test.ts apps/api/src/routes/agents/unifiTelemetry.ts apps/api/src/services/unifi/unifiTelemetryService.ts apps/api/src/routes/unifi/index.ts
git commit -m "feat(unifi): agent-reported controller-site discovery + list endpoint"
```

---

### Task B4: inventory parity — reconcile telemetry devices into `discovered_assets`

**Files:**
- Modify: `apps/api/src/services/unifi/unifiTelemetryService.ts`
- Test: `apps/api/src/services/unifi/unifiTelemetryService.test.ts`

**Interfaces:**
- Consumes: per-device resolved `{ orgId, siteId }`, device `mac`/`ip`/`name`.
- Produces: in the device loop, find-or-create a `discovered_assets` row by `(org_id, mac)` then `(org_id, ip_address)`, and set `unifi_device_telemetry.discoveredAssetId`. New helper `linkTelemetryDeviceToAsset(db, orgId, siteId, device): Promise<string | null>`. (Telemetry devices expose IP only inside `raw`; extract `ip` from `raw` when present — UniFi integration device JSON carries `ipAddress`/`ip`. When no IP is available, skip asset creation, matching the cloud path which requires an IP.)

> Note: `unifi_device_telemetry` has no `discovered_asset_id` column today. Add it in a follow-on migration step below so device inventory links the same way clients already do.

- [ ] **Step 1: Migration — add `discovered_asset_id` to `unifi_device_telemetry`**

Append to `apps/api/migrations/2026-06-29-b-unifi-self-hosted-collectors-and-sites.sql`:
```sql
-- 3. Link telemetry devices to discovered_assets (inventory parity for self-hosted;
-- harmless for cloud collectors, which simply leave it null).
ALTER TABLE unifi_device_telemetry
  ADD COLUMN IF NOT EXISTS discovered_asset_id uuid REFERENCES discovered_assets(id);
```
And in `apps/api/src/db/schema/unifi.ts`, add to `unifiDeviceTelemetry` (after `numClients`):
```ts
  discoveredAssetId: uuid('discovered_asset_id').references(() => discoveredAssets.id),
```
Run `pnpm db:check-drift` — expect no drift.

- [ ] **Step 2: Write the failing test**

Append to `apps/api/src/services/unifi/unifiTelemetryService.test.ts` a test asserting that a device with a mac+ip in `raw` creates/links a `discovered_assets` row and stamps `discoveredAssetId` on the telemetry upsert. Use the existing mock-db harness in that file (follow its established pattern for `select().from().where().limit()` and `insert().values().onConflictDoUpdate()`); assert:
```ts
// after reconcileTelemetry with one device { unifiDeviceId:'d1', mac:'AA:BB:CC:00:11:22', raw:{ ipAddress:'10.0.0.5', name:'sw1' } }
// expect a discoveredAssets insert/update happened with orgId of the resolved site
// expect the unifiDeviceTelemetry upsert `set`/`values` carried discoveredAssetId
```

- [ ] **Step 3: Run it — expect failure**

Run: `pnpm --filter @breeze/api exec vitest run src/services/unifi/unifiTelemetryService.test.ts`
Expected: FAIL — `discoveredAssetId` not set / no asset reconcile.

- [ ] **Step 4: Implement device→asset linking**

In `unifiTelemetryService.ts`, add a helper modeled on `reconcileDiscoveredAsset` from `unifiSyncService.ts` (find by `(org,mac)` then `(org,ip)`, else insert with `onConflictDoUpdate` on `(org_id, ip_address)`; `manufacturer: 'Ubiquiti'`). Extract the IP from the device DTO's `raw` (`raw.ipAddress ?? raw.ip`), skip when absent. Then in the device loop set `discoveredAssetId` on both the insert `values` and the `onConflictDoUpdate` `set`. Keep the asset type mapping minimal (`'access_point' | 'switch' | 'router' | 'firewall' | 'unknown'`) reusing the device `raw.type`/`raw.model` when present, else `'unknown'`.

```ts
function deviceIp(raw: unknown): string | null {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const ip = r.ipAddress ?? r.ip;
    if (typeof ip === 'string' && ip.length > 0) return ip;
  }
  return null;
}

async function linkTelemetryDeviceToAsset(
  db: DbExecutor,
  orgId: string,
  siteId: string,
  device: TelemetryDeviceDto,
): Promise<string | null> {
  const ip = deviceIp(device.raw);
  if (!ip) return null;
  const enrich = {
    macAddress: device.mac ?? undefined,
    hostname: device.name ?? undefined,
    manufacturer: 'Ubiquiti',
    isOnline: true,
    lastSeenAt: new Date(),
  };
  let existing: { id: string } | null = null;
  if (device.mac) {
    const byMac = await db.select({ id: discoveredAssets.id }).from(discoveredAssets)
      .where(and(eq(discoveredAssets.orgId, orgId), eq(discoveredAssets.macAddress, device.mac))).limit(1);
    existing = byMac[0] ?? null;
  }
  if (!existing) {
    const byIp = await db.select({ id: discoveredAssets.id }).from(discoveredAssets)
      .where(and(eq(discoveredAssets.orgId, orgId), eq(discoveredAssets.ipAddress, ip))).limit(1);
    existing = byIp[0] ?? null;
  }
  if (existing) {
    await db.update(discoveredAssets).set(enrich).where(eq(discoveredAssets.id, existing.id));
    return existing.id;
  }
  const inserted = await db.insert(discoveredAssets)
    .values({ orgId, siteId, ipAddress: ip, ...enrich })
    .onConflictDoUpdate({ target: [discoveredAssets.orgId, discoveredAssets.ipAddress], set: enrich })
    .returning({ id: discoveredAssets.id });
  return inserted[0]?.id ?? null;
}
```
In the device loop (line 76+), after resolving `{ orgId, siteId }`, add `const discoveredAssetId = await linkTelemetryDeviceToAsset(db, orgId, siteId, d);` and include `discoveredAssetId` in both the `values` and the `onConflictDoUpdate` `set`.

- [ ] **Step 5: Run the test — expect pass**

Run: `pnpm --filter @breeze/api exec vitest run src/services/unifi/unifiTelemetryService.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-06-29-b-unifi-self-hosted-collectors-and-sites.sql apps/api/src/db/schema/unifi.ts apps/api/src/services/unifi/unifiTelemetryService.ts apps/api/src/services/unifi/unifiTelemetryService.test.ts
git commit -m "feat(unifi): reconcile telemetry devices into discovered_assets (inventory parity)"
```

---

## Phase C — Agent

### Task C1: report discovered sites in the telemetry payload

**Files:**
- Modify: `agent/internal/unifi/client.go`
- Modify: `agent/internal/unifi/collector.go`
- Test: `agent/internal/unifi/client_test.go`, `agent/internal/unifi/collector_test.go`

**Interfaces:**
- Produces: `Snapshot.Sites []SiteRef` where `type SiteRef struct { ID string; Name string }`; `telemetryPayload.Sites []uploadSite` with JSON `sites: [{ id, name }]`. The agent now reports every site it enumerated even when a site has zero devices/clients, so the server can populate `unifi_controller_sites`.

- [ ] **Step 1: Write the failing client test**

In `agent/internal/unifi/client_test.go`, add a test that stands up an `httptest` server returning two sites (with `name`) from `/proxy/network/integration/v1/sites` and empty device/client arrays, then asserts `snap.Sites` has both site ids and names:

```go
func TestPoll_ReportsSitesWithNames(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/sites"):
			io.WriteString(w, `{"data":[{"id":"s1","name":"HQ"},{"id":"s2","name":"Branch"}]}`)
		default:
			io.WriteString(w, `{"data":[]}`)
		}
	}))
	defer srv.Close()
	c := NewAPIClient(srv.URL, "k", srv.Client())
	snap, err := c.Poll(context.Background())
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(snap.Sites) != 2 || snap.Sites[0].ID != "s1" || snap.Sites[0].Name != "HQ" {
		t.Fatalf("got sites %+v", snap.Sites)
	}
}
```

- [ ] **Step 2: Run it — expect failure**

Run: `cd agent && go test -race ./internal/unifi/ -run TestPoll_ReportsSitesWithNames`
Expected: FAIL — `snap.Sites undefined`.

- [ ] **Step 3: Implement in `client.go`**

Add the type and field, and capture names in `Poll`:
```go
type SiteRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
```
Add `Sites []SiteRef` to `Snapshot`. Change the `sites` decode struct in `Poll` (lines 161-163) to include `Name`, and after decoding, populate `snap.Sites`:
```go
	var sites []SiteRef
	if err := json.Unmarshal(sitesData, &sites); err != nil {
		return snap, fmt.Errorf("decode sites: %w", err)
	}
	snap.Sites = sites
```
(The loop below still iterates `sites` by `.ID`; add `.ID` references remain valid since `SiteRef` has `ID`.)

- [ ] **Step 4: Run client test — expect pass**

Run: `cd agent && go test -race ./internal/unifi/ -run TestPoll_ReportsSitesWithNames`
Expected: PASS.

- [ ] **Step 5: Carry sites into the upload (collector.go)**

In `agent/internal/unifi/collector.go`, add:
```go
type uploadSite struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}
```
Add `Sites []uploadSite \`json:"sites,omitempty"\`` to `telemetryPayload`. In `RunOnce`, populate it:
```go
	sites := make([]uploadSite, len(snap.Sites))
	for i, s := range snap.Sites {
		sites[i] = uploadSite{ID: s.ID, Name: s.Name}
	}
	payload := telemetryPayload{
		CollectorID: cfg.CollectorID,
		PolledAt:    time.Now().UTC().Format(time.RFC3339),
		FirmwareOK:  snap.FirmwareOK,
		Devices:     toUploadDevices(snap.Devices),
		Clients:     toUploadClients(snap.Clients),
		Sites:       sites,
	}
```

- [ ] **Step 6: Write + run a collector test asserting `sites` is in the posted body**

In `agent/internal/unifi/collector_test.go`, add a test (or extend an existing upload test) that captures the POST body to `/unifi-telemetry` and asserts it contains `"sites":[{"id":"s1"`. Run:
```bash
cd agent && go test -race ./internal/unifi/
```
Expected: PASS (all unifi package tests).

- [ ] **Step 7: Commit**

```bash
git add agent/internal/unifi/client.go agent/internal/unifi/collector.go agent/internal/unifi/client_test.go agent/internal/unifi/collector_test.go
git commit -m "feat(agent): report discovered UniFi sites in telemetry upload"
```

---

## Phase D — Web UI

### Task D1: connection-type choice + self-hosted connect

**Files:**
- Modify: `apps/web/src/components/integrations/UnifiIntegration.tsx`

**Interfaces:**
- Consumes: `GET /unifi` now returns `connectionType`. New `POST /unifi/connect-self-hosted` `{ accountLabel? }`.
- Produces: connect screen offers **Cloud (Site Manager API key)** vs **Self-hosted controller**; selecting self-hosted + submitting calls `connect-self-hosted` via `runAction` and transitions to the connected (self-hosted) view.

- [ ] **Step 1: Read the current component**

Read `apps/web/src/components/integrations/UnifiIntegration.tsx` fully to learn its state shape (`isConnected`, the connect form at ~523-535, `handleConnect` at ~391, the `runAction` usage, and how `GET /unifi` status is loaded). Match its existing patterns.

- [ ] **Step 2: Add connection-type state + a mode toggle on the connect screen**

In the not-connected branch, add a two-option selector (radio or segmented control) bound to a `connectMode: 'cloud' | 'self_hosted'` state (default `'cloud'`). When `'cloud'`, render the existing API-key form unchanged. When `'self_hosted'`, render an optional **Account label** text input and a **Connect** button. Keep copy concrete: cloud = "Connect your UniFi Site Manager account with a cloud API key"; self-hosted = "Connect a self-hosted UniFi Network controller. A Breeze agent on the controller's network polls it directly — no UniFi cloud account needed."

- [ ] **Step 3: Add the self-hosted connect handler**

Mirror `handleConnect`, wrapping in `runAction`:
```ts
async function handleConnectSelfHosted() {
  await runAction({
    action: () => fetch('/api/unifi/connect-self-hosted', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountLabel: accountLabel || undefined }),
    }),
    successMessage: 'Self-hosted UniFi controller connected',
  });
  await reloadStatus(); // existing function that re-fetches GET /unifi
}
```
(Use the file's actual `runAction` signature and status-reload function names discovered in Step 1; the catch pattern from CLAUDE.md applies — let runAction toast non-401 failures.)

- [ ] **Step 4: Branch the connected view on `connectionType`**

Store `connectionType` from `GET /unifi`. When `'self_hosted'`, hide the cloud-only "Sync now"/host-mapping affordances that depend on `api.ui.com`, and show the self-hosted controllers section (Task D2). When `'cloud'`, the existing UI is unchanged.

- [ ] **Step 5: Run the web unit tests**

Run: `pnpm --filter @breeze/web exec vitest run src/components/integrations/`
Expected: PASS (existing tests green; add a render test asserting the self-hosted toggle appears when not connected).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/integrations/UnifiIntegration.tsx
git commit -m "feat(web): UniFi connect screen offers self-hosted controller mode"
```

---

### Task D2: self-hosted controller register + map from controller sites

**Files:**
- Modify: `apps/web/src/components/integrations/UnifiIntegration.tsx`

**Interfaces:**
- Consumes: `PUT /unifi/controllers`, `GET /unifi/controller-sites`, `PUT /unifi/mappings` (existing), `GET /devices?limit=500` (existing agent list).
- Produces: a self-hosted controllers panel: register controller(s) (Controller URL, Collector agent, Local API key), then map each agent-discovered local site → a Breeze site.

- [ ] **Step 1: Controller registration form**

In the self-hosted connected view, render a "Controllers" card with fields: **Controller URL** (`placeholder="https://192.168.1.1"`), **Collector agent** (`<select>` sourced from the existing `agents` list loaded via `GET /devices?limit=500`), **Site this controller serves** (a Breeze `<select>` grouped by org from the existing `sitesByOrg`), and **Local API key** (password). Submit via `runAction` to `PUT /unifi/controllers` with `{ siteId, collectorDeviceId, controllerUrl, apiKey }`. On success, reload controllers + controller-sites.

> The "Site this controller serves" picks the collector's *own* org/site (the fallback used by `reconcileTelemetry` for any site that isn't explicitly mapped). Per-customer sites are mapped in Step 2.

- [ ] **Step 2: Load + render agent-discovered sites for mapping**

Add a fetch of `GET /unifi/controller-sites` into state (`controllerSites: Array<{ collectorId, localSiteId, name, mapped }>`). Render one mapping row per discovered site: show the site name/id, and a Breeze-site `<select>` (grouped by org, from `sitesByOrg`). This replaces the cloud `GET /unifi/hosts` source for self-hosted.

- [ ] **Step 3: Save mappings (reuse existing endpoint, sentinel host id)**

On save, call the existing `PUT /unifi/mappings` with each row mapped as:
```ts
{
  unifiHostId: row.collectorId,   // sentinel: self-hosted has no cloud host
  unifiSiteId: row.localSiteId,
  unifiSiteName: row.name ?? undefined,
  siteId: selectedBreezeSiteId,
}
```
This writes a `unifi_site_mappings` row whose `(integration_id, unifi_host_id=collectorId, unifi_site_id=localSiteId)` is unique, and which `reconcileTelemetry` consumes (it keys the site map on `unifi_site_id`).

- [ ] **Step 4: Empty-state copy**

When `controllerSites` is empty, show: "No sites discovered yet. Once the assigned agent reaches the controller (within ~1 minute), its sites appear here to map." (The agent reports sites on its next poll via Task C1.)

- [ ] **Step 5: Run web tests**

Run: `pnpm --filter @breeze/web exec vitest run src/components/integrations/`
Expected: PASS. Add a test that, given a mocked `GET /unifi/controller-sites` with one site, the mapping row renders and saving posts the sentinel `unifiHostId`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/integrations/UnifiIntegration.tsx
git commit -m "feat(web): register self-hosted controllers and map discovered sites"
```

---

## Final verification

- [ ] **Step 1: Full API + web + agent test pass**

Run:
```bash
pnpm test --filter=@breeze/api
pnpm test --filter=@breeze/web
cd agent && go test -race ./... && cd ..
```
Expected: all green.

- [ ] **Step 2: RLS contract + drift**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: no drift; RLS coverage passes including `unifi_controller_sites`.

- [ ] **Step 3: Manual end-to-end smoke (optional, needs a controller or a stub)**

Connect a self-hosted integration, register a controller pointed at a UniFi Network integration API (or a stub returning `/sites`, `/sites/:id/devices`, `/sites/:id/clients`), confirm: collector status flips to `connected`, discovered sites appear under controller-sites, a mapped site routes device telemetry + a `discovered_assets` row to the right org, and `unifi_device_telemetry`/`unifi_clients` populate.

---

## Self-review notes (coverage vs spec)

- **`connection_type` discriminator** → Task A1. ✅
- **Nullable host id + revised indexes** → Task A2. ✅
- **`unifi_controller_sites` + RLS** → Task A3. ✅
- **Self-hosted connect (no cloud key)** → Task B1. ✅
- **Controller registration fanning to many sites** → Task B2 (one collector per controller) + D2 (many mappings). ✅
- **Agent multi-site discovery + `local_site_id` tagging** → already present (`client.go` Poll tags `SiteID`, `collector.go` uploads `unifiSiteId`); only the empty-site discovery list is added → Task C1. ✅
- **Server inventory reconcile + telemetry routing** → routing already in `reconcileTelemetry` (keys on `unifiSiteId`); device→`discovered_assets` parity added in Task B4. ✅
- **UI: connection-type choice, self-hosted register, mapping from controller sites** → Tasks D1, D2. ✅
- **Tenancy/security** → partner-scoped routes preserved; org-axis RLS on new table; ownership gate in ingest unchanged; agent self-signed TLS + redirect-refusal unchanged. ✅
- **Non-goals** (mixed mode, collector HA) → not implemented, by design. ✅
