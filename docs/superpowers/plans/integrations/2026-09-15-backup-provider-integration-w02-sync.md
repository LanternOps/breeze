---
tracking_issue: LanternOps/breeze#6008
---
# Backup Provider Integration W02: Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn W01's dormant `backup-provider-sync` queue into a working poller — every five minutes it picks the due connections, fetches the vendor snapshot outside any DB transaction, persists customers/devices/ledger in one advisory-locked system transaction, auto-maps customers, links provider rows to Breeze devices, and then, after that commit, raises/resolves Breeze alerts and publishes `backup.provider_device_*` events on condition transitions only.

**Architecture:** `jobs/backupProviderSync.ts` keeps the three-phase shape of `jobs/huntressSync.ts` (short load context → vendor HTTP under `runOutsideDbContext` → one write transaction) and delegates all row work to four service modules under `services/backupProviders/`: `persist.ts` (inventory + ledger), `mapping.ts` (customer auto-mapping), `deviceMatching.ts` (provider row → Breeze device link) and `alerts.ts` (post-commit alert/event evaluation in its own transaction under the same advisory lock). Each row module is split into a **pure resolver** (takes rows, returns decisions — unit-tested with no database) and a **batched writer** (one `UPDATE … FROM (VALUES …)` or one chunked upsert), so the rules are provable without Postgres and the SQL still stays batched.

**Tech Stack:** TypeScript, BullMQ (queue `backup-provider-sync`), Drizzle ORM over PostgreSQL, Vitest (API unit with Drizzle mocks; API integration on real Postgres + Redis).

**Spec:** `docs/superpowers/specs/integrations/2026-09-15-backup-provider-integration-cove-design.md` (approved 2026-09-15). This wave ships the **Sync job**, **Device matching** and **Alerts and events** sections, the W02 bullets of **Testing**, and the W02 row of the **Wave outline**. Where this plan is more specific than the spec (the advisory-lock argument shape, the `pending_condition` two-phase encoding, the `devices` "non-deleted" definition, the pure-resolver split, the indefinite-mute resolve carve-out), the plan wins; each such point is marked **DECISION** inline.

**Cross-wave names (from the plan index — do not rename):**

Consumed from W01 (assume every one exists exactly as listed; W01's plan is written in parallel — do not go looking for it):

- `apps/api/src/db/schema/backupProviders.ts`: `backupProviderConnections`, `backupProviderCustomers`, `backupProviderDevices`, `backupProviderDeviceHistory`; pg enum `external_backup_status`; the Breeze device pointer is **`breeze_device_id`** (never `device_id`); `mapping_source ∈ manual | auto_name | auto_external_code | manual_unmapped | NULL`; `device_match_source ∈ auto_hostname | auto_mac | manual | NULL`; `status ∈ connected | error | reauth_required`; `last_sync_status ∈ running | success | partial | error`; `os_type ∈ workstation | server | unknown`; `account_type ∈ backup_manager | m365 | unknown`.
- `packages/shared/src/types/backupHealth.ts` / `packages/shared/src/utils/backupHealth.ts`: `EXTERNAL_BACKUP_STATUSES`, `ExternalBackupStatus`, `BackupHealth`, `BackupRecency`, `deriveBackupHealth({ status, lastSuccessAt, errorsCount, now? }) → { health, recency, covered }`, `EXTERNAL_BACKUP_STATUS_SEVERITY` (higher = worse), `worstBackupStatus`, `BackupProviderAlertCondition`.
- `apps/api/src/services/backupProviders/types.ts`: `BackupProviderAdapter`, `VendorCustomer`, `VendorDevice`, `ProviderRequestError { code; reauth }`.
- `apps/api/src/services/backupProviders/registry.ts`: `getBackupProvider(key): BackupProviderAdapter`, `BACKUP_PROVIDER_KEYS`.
- `apps/api/src/services/backupProviders/credentials.ts`: `decryptProviderCredentials(connectionId, ciphertext): unknown`.
- `apps/api/src/services/backupProviders/mapping.ts`: `remapCustomer(...)`.
- `apps/api/src/services/backupProviders/alertsResolve.ts`: `resolveProviderAlertsForConnection(...)`.
- `apps/api/src/jobs/backupProviderSync.ts`: `enqueueBackupProviderSync(connectionId): Promise<void>` (W01 stub — queue `backup-provider-sync`, `addUniqueJob`, `jobId = backup-provider-sync-${connectionId}`).
- `apps/api/src/routes/backup/providers.ts`.

Defined by W02 and consumed verbatim by W03–W05:

- `initializeBackupProviderSyncJob()`, `shutdownBackupProviderSyncJob()`, `syncConnectionById(connectionId: string): Promise<void>`; repeatable job `sync-all` (every 5 min); per-connection job name `sync-connection`.
- `persist.ts`: `persistVendorSnapshot(tx, connection, snapshot): Promise<SyncCounters>`.
- `mapping.ts`: `autoMapCustomers(tx, connectionId, partnerId): Promise<number>`.
- `deviceMatching.ts`: `matchProviderDevices(tx, connectionId): Promise<{ linked: number; ambiguous: number }>`.
- `alerts.ts`: `evaluateProviderAlerts(connectionId: string): Promise<{ raised: number; resolved: number }>`, `BACKUP_PROVIDER_ALERT_SOURCE = 'backup_provider'`, publisher `'backup-provider-sync'`.
- Worker registry entry name `backupProviderSyncWorker` (`placement: 'global'`).
- Events `backup.provider_device_unhealthy` → `EVENT_TYPES.BACKUP_PROVIDER_DEVICE_UNHEALTHY`, `backup.provider_device_recovered` → `EVENT_TYPES.BACKUP_PROVIDER_DEVICE_RECOVERED`; payload `{ connectionId, providerKey, providerDeviceId, orgId, deviceId: string | null, vendorDeviceName, status, health, condition }`.

---

## Global Constraints

- **No migration in this wave.** W01 owns `2026-10-17-120000-backup-provider-integration.sql` (four tables, the `external_backup_status` enum, RLS, composite FKs, `pending_condition`). W02 creates no table and adds no column, so there is **no** `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, `orgMergeRegistry`, `rls-coverage` allowlist, `CORE_DEVICE_CASCADE_DELETE_TABLES` or `migrationRlsScope.test.ts` change here. If a task finds itself wanting a column, stop and escalate — do not add a migration to this wave, and never add a file to the frozen baseline in `apps/api/src/db/migrationRlsScope.test.ts`.
- **Every DB read and write in this wave runs inside a DB access context.** Workers have no request context, so each entry point wraps its work in `withSystemDbAccessContext(fn, '<label>')` (`apps/api/src/db/index.ts:610`). `backup_provider_*` are FORCE-RLS tables: a contextless read silently returns 0 rows and a contextless write silently affects 0 rows (`apps/api/src/db/index.ts:760-775`). Pass a low-cardinality label on every context so a #1105 held-connection warning is attributable (`apps/api/src/db/index.ts:593-606`).
- **Vendor HTTP never runs inside a transaction.** Phase 2 is wrapped in `runOutsideDbContext` (`apps/api/src/db/index.ts:801-803`), exactly as `huntressSync.ts:830-836` does — pinning a pooled connection across the HTTP window starved the US pool (#1697 / Sentry BREEZE-9).
- **Never catch a Postgres error inside the phase-3 transaction without a SAVEPOINT.** A caught 23505/23503 poisons the enclosing transaction (`apps/api/src/utils/pgErrors.ts:41-57`). Where W02 must tolerate a unique violation (the device-link write), the statement runs inside `tx.transaction(...)`, which drizzle emits as a SAVEPOINT under the ambient context (`apps/api/src/jobs/patchScheduleBackfill.ts:14,57`, `apps/api/src/routes/mobile.ts:652`).
- **Never write `= ANY(${jsArray})` in a drizzle `sql` template** — drizzle expands a JS array into a TUPLE and Postgres rejects it with 42809 (`apps/api/src/extensions/tenancyTripwire.ts:225-230`). W02 avoids it entirely: set differences are computed in JS and written back with `inArray(col, chunk)` or `UPDATE … FROM (VALUES …)`.
- **Every VALUE import from the shared package uses the package ROOT, `from '@breeze/shared'`.** Deep subpaths (`@breeze/shared/utils/backupHealth`) are absent from `packages/shared/package.json`'s `exports` map (`:8-20`); the unit runner's alias resolves them from source and never notices, but the integration config goes through the exports map and three suites once died at module load for exactly this (`apps/api/src/services/aiToolHandoff.ts:42-48`). `import type` through a deep path is fine (erased at compile time). This wave's value imports are `EXTERNAL_BACKUP_STATUSES`, `EXTERNAL_BACKUP_STATUS_SEVERITY`, `worstBackupStatus` and `deriveBackupHealth`, so `packages/shared/src/utils/index.ts` must carry `export * from './backupHealth';` — verify it in Task 3 Step 1 and add the line if W01 left it out.
- Run ONE unit test file as `cd apps/api && npx vitest run <path>`. **Never** `pnpm --filter @breeze/api test -- --run <path>` — pnpm forwards the literal `--`, vitest swallows `--run`, and the whole 1,470-file suite runs in watch mode. The path filter is a plain substring, not a glob: list sibling files explicitly.
- Integration suites need a live stack: `pnpm test-stack up` once at the start of the wave, `pnpm test-stack down` at the end (nothing reaps it for you). Run one as `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupProviderSync.integration.test.ts`. Do **not** use `pnpm test:integration -- <path>` — the `--` makes it run the whole suite.
- Branch `feature/6008-backup-provider-integration/wave-6010`. PR body contains `Closes #6010`. This branch is **stacked on W01**: `ci.yml` triggers on `pull_request: branches: [main]`, so a PR based on the W01 branch runs no CI at all and `gh pr checks` reads green. Dispatch it explicitly before enqueueing: `gh workflow run CI --ref feature/6008-backup-provider-integration/wave-6010`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Keep files under ~500 lines. That is why the row logic is four modules rather than one, and why `backupProviderSync.ts` keeps only queue/worker/orchestration.
- No web files change in this wave, so the `runAction` mutation rule and the i18n real-translation rule do not bind here (they bind W03).
- **Alert rows always take the DEVICE's org**, never a connection-derived guess (`apps/api/src/jobs/monitorWorker.ts:492-497`). Provider device rows carry `org_id` from their customer's mapping and the composite FK `(breeze_device_id, org_id) → devices(id, org_id)` guarantees the linked device is in that same org, so `row.orgId` **is** the device's org.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/backupProviders/persist.ts` | create — `ProviderSyncTx` (Task 1), then `persistVendorSnapshot`, `SyncCounters`, `backupStatusSeveritySql` (Task 3) |
| `apps/api/src/services/backupProviders/persist.test.ts` | create — upsert/delete/re-home/unmapped-skip/ledger worst-of-day/prune/no-writes-on-failure |
| `apps/api/src/services/backupProviders/mapping.ts` | **modify** (W01 ships `remapCustomer`) — add `autoMapCustomers` + pure `resolveCustomerAutoMappings` |
| `apps/api/src/services/backupProviders/mapping.test.ts` | **modify or create** — auto-mapping rules |
| `apps/api/src/services/backupProviders/deviceMatching.ts` | create — `matchProviderDevices` + pure `resolveDeviceMatches` |
| `apps/api/src/services/backupProviders/deviceMatching.test.ts` | create |
| `apps/api/src/services/backupProviders/alerts.ts` | create — `evaluateProviderAlerts`, condition + hysteresis state machine, events |
| `apps/api/src/services/backupProviders/alerts.test.ts` | create |
| `apps/api/src/services/eventBus.ts` | **modify** — two members in the `EventType` union (~:97-103) and two in `EVENT_TYPES` (~:611-617) |
| `apps/api/src/jobs/backupProviderSync.ts` | **modify** (W01 ships `enqueueBackupProviderSync`) — `sync-all` scan, `syncConnectionById`, worker, init/shutdown |
| `apps/api/src/jobs/backupProviderSync.test.ts` | create |
| `apps/api/src/services/workerRegistry.ts` | **modify** — `backupProviderSyncWorker` entry after `huntressSyncWorker` (`:778-785`) |
| `apps/api/src/services/workerRegistry.test.ts` | **modify** — `EXPECTED_WORKER_NAMES` (`:30`, the `huntressSyncWorker` line is `:52`) + four `141` → `142` (`:88,130,137,145`) |
| `apps/api/src/services/workerEntrypointClosure.contract.test.ts` | **modify** — `EXPECTED_NAMES` (`:294`) |
| `apps/api/src/jobs/workerReadinessManifest.ts` | **modify** — `consumers('backupProviderSyncWorker')` after `huntressSyncWorker` (`:117`) |
| `apps/api/src/routes/backup/providers.ts` | **modify** — PATCH `isActive:false` resolves the connection's open provider alerts |
| `apps/api/src/__tests__/integration/backupProviderSync.integration.test.ts` | create — end-to-end on real Postgres + Redis with a stubbed adapter |

---

### Task 1: `mapping.ts` — `autoMapCustomers`

Auto-mapping runs at every sync for rows with `mapping_source IS NULL` only. `vendor_external_code` parsing as the UUID of an organization under the partner wins (`auto_external_code`); otherwise exactly one organization under the partner with `lower(name) = lower(vendor_customer_name)` wins (`auto_name`); otherwise the row stays unmapped. `manual` and `manual_unmapped` are never touched.

**Files:**
- Create: `apps/api/src/services/backupProviders/persist.ts` (type alias only in this task)
- Modify: `apps/api/src/services/backupProviders/mapping.ts` (W01 file — append below `remapCustomer`; do not rewrite it)
- Test: `apps/api/src/services/backupProviders/mapping.test.ts`

**Interfaces:**
- Consumes: `backupProviderCustomers` (W01 schema); `organizations` — `apps/api/src/db/schema/orgs.ts:180-233` (`partnerId` :182, `name` :183, `status` :186, `archivedAt` :214, `deletedAt` :222).
- Produces:
  - `export type ProviderSyncTx = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'transaction' | 'execute'>` (in `persist.ts`)
  - `export interface AutoMapCustomerRow { id: string; vendorCustomerName: string; vendorExternalCode: string | null }`
  - `export interface AutoMapOrgRow { id: string; name: string }`
  - `export type AutoMapDecision = { customerId: string; orgId: string; mappingSource: 'auto_external_code' | 'auto_name' }`
  - `export function resolveCustomerAutoMappings(customers: AutoMapCustomerRow[], orgs: AutoMapOrgRow[]): AutoMapDecision[]` (pure)
  - `export async function autoMapCustomers(tx: ProviderSyncTx, connectionId: string, partnerId: string): Promise<number>`

**DECISION:** `ProviderSyncTx` lives in `persist.ts` and is imported by `mapping.ts` / `deviceMatching.ts` / `alerts.ts`, so there is exactly one definition. Task 1 therefore creates `persist.ts` containing only that alias and Task 3 fills the rest in. Shape mirrors `apps/api/src/services/softwareInventoryObservations.ts:231`.

**DECISION:** eligible organizations are `deleted_at IS NULL AND archived_at IS NULL AND status NOT IN ('archived','purging','merging')`. `organizations` carries both `deletedAt` and `archivedAt` (`orgs.ts:214,222`), and archived/purging/merging orgs are deliberately excluded from `computeAccessibleOrgIds` (`apps/api/src/db/index.ts:642-665`) — auto-mapping a customer onto an org that no request context can see would strand every device row it produces.

**DECISION:** an org is claimed by at most one customer per pass. Two vendor customers mapping to one Breeze org would double-count that org's coverage and `device_count`; the spec's `manual` route is the way to express a deliberate many-to-one.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/backupProviders/mapping.test.ts`. If W01 already created this file for `remapCustomer`, **append** this `describe` block rather than overwriting — a `Write` on an existing test file clobbers the sibling cases.

```ts
import { describe, expect, it } from 'vitest';
import { resolveCustomerAutoMappings } from './mapping';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

describe('resolveCustomerAutoMappings', () => {
  it('maps by external code when it parses as the id of an org under the partner', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: 'Nothing Like This', vendorExternalCode: ORG_A }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A, mappingSource: 'auto_external_code' }]);
  });

  it('ignores an external code that is a UUID but not an org under this partner', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: 'Acme Ltd', vendorExternalCode: ORG_B }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    // Falls through to the name rule rather than mapping to a foreign org.
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A, mappingSource: 'auto_name' }]);
  });

  it('ignores a non-UUID external code and falls through to the name rule', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: 'acme ltd', vendorExternalCode: 'CUST-0042' }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A, mappingSource: 'auto_name' }]);
  });

  it('matches names case- and whitespace-insensitively', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: '  ACME LTD ', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A, mappingSource: 'auto_name' }]);
  });

  it('leaves a customer unmapped when two orgs share the name (ambiguous)', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: 'Acme Ltd', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }, { id: ORG_B, name: 'ACME LTD' }],
    );
    expect(out).toEqual([]);
  });

  it('leaves a customer unmapped when nothing matches', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: 'Beta Inc', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([]);
  });

  it('ignores an empty or whitespace-only vendor customer name', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: '   ', vendorExternalCode: null }],
      [{ id: ORG_A, name: '   ' }],
    );
    expect(out).toEqual([]);
  });

  it('never maps two customers onto the same org; the stronger rule wins', () => {
    const out = resolveCustomerAutoMappings(
      [
        { id: 'c2', vendorCustomerName: 'Acme Ltd', vendorExternalCode: null },
        { id: 'c1', vendorCustomerName: 'Acme Ltd', vendorExternalCode: ORG_A },
      ],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A, mappingSource: 'auto_external_code' }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
cd apps/api && npx vitest run src/services/backupProviders/mapping.test.ts
```

Expected: `No "resolveCustomerAutoMappings" export is defined on the "./mapping" module` (or `Failed to resolve import "./mapping"` if W01's file is not on the branch yet — in that case stop and rebase onto W01).

- [ ] **Step 3: Create `persist.ts` with the shared transaction type**

Create `apps/api/src/services/backupProviders/persist.ts`:

```ts
import type { db } from '../../db';

/**
 * The subset of the drizzle handle every backup-provider sync service needs.
 *
 * Callers pass the ambient `db` proxy from inside a
 * `withSystemDbAccessContext(...)`: under an open context that proxy IS the
 * transaction (apps/api/src/db/index.ts:525-575), so "pass the tx" and "pass
 * db" are the same object. Typing it as a `Pick` — the shape
 * services/softwareInventoryObservations.ts:231 uses — documents which
 * operations the callee performs and keeps the unit tests' hand-rolled stubs
 * small.
 */
export type ProviderSyncTx = Pick<
  typeof db,
  'select' | 'insert' | 'update' | 'delete' | 'transaction' | 'execute'
>;
```

- [ ] **Step 4: Write the implementation**

Append to `apps/api/src/services/backupProviders/mapping.ts` (merge the imports with W01's existing import block rather than adding a second one):

```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import { backupProviderCustomers, organizations } from '../../db/schema';
import type { ProviderSyncTx } from './persist';

/**
 * Version/variant-agnostic UUID shape — deliberately NOT the RFC-4122-strict
 * pattern, matching `PG_UUID_REGEX`'s rationale in apps/api/src/db/index.ts:634-641.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AutoMapCustomerRow {
  id: string;
  vendorCustomerName: string;
  vendorExternalCode: string | null;
}

export interface AutoMapOrgRow {
  id: string;
  name: string;
}

export type AutoMapDecision = {
  customerId: string;
  orgId: string;
  mappingSource: 'auto_external_code' | 'auto_name';
};

function normalizeName(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * PURE auto-mapping rules (spec, `backup_provider_customers` section).
 *
 * Both inputs are already scoped to ONE connection and ONE partner by the
 * caller; this function never widens that. Rule order is deliberate and the
 * external code always wins: it is an identifier the MSP typed on purpose,
 * while a name collision is an accident waiting to happen.
 *
 * An org is claimed by at most one customer per pass — two vendor customers
 * pointing at one Breeze org is a data problem a human must settle, and
 * silently mapping both would double-count that org's coverage.
 */
export function resolveCustomerAutoMappings(
  customers: AutoMapCustomerRow[],
  orgs: AutoMapOrgRow[],
): AutoMapDecision[] {
  const orgById = new Map(orgs.map((o) => [o.id.toLowerCase(), o.id]));
  const orgsByName = new Map<string, string[]>();
  for (const org of orgs) {
    const key = normalizeName(org.name);
    if (!key) continue;
    const bucket = orgsByName.get(key);
    if (bucket) bucket.push(org.id);
    else orgsByName.set(key, [org.id]);
  }

  const byCode: AutoMapDecision[] = [];
  const byName: AutoMapDecision[] = [];

  for (const customer of customers) {
    const code = customer.vendorExternalCode?.trim();
    if (code && UUID_RE.test(code)) {
      const orgId = orgById.get(code.toLowerCase());
      if (orgId) {
        byCode.push({ customerId: customer.id, orgId, mappingSource: 'auto_external_code' });
        continue;
      }
    }
    const key = normalizeName(customer.vendorCustomerName);
    if (!key) continue;
    const candidates = orgsByName.get(key);
    if (!candidates || candidates.length !== 1) continue;
    byName.push({ customerId: customer.id, orgId: candidates[0]!, mappingSource: 'auto_name' });
  }

  // Two passes so an external-code match always beats a name match for the
  // same org, whatever order the vendor returned the customers in.
  const claimed = new Set<string>();
  const out: AutoMapDecision[] = [];
  for (const decision of [...byCode, ...byName]) {
    if (claimed.has(decision.orgId)) continue;
    claimed.add(decision.orgId);
    out.push(decision);
  }
  return out;
}

/**
 * Map every still-unmapped customer of this connection, in ONE statement.
 *
 * `mapping_source IS NULL` is the whole eligibility rule: `manual` and
 * `manual_unmapped` are a technician's decision that auto-mapping never
 * overrides, and an existing `auto_*` row is left alone so a rename on the
 * vendor side cannot silently re-home devices mid-sync (the remap route is the
 * only path that moves rows between orgs, and it does so atomically).
 *
 * @returns the number of customers newly mapped.
 */
export async function autoMapCustomers(
  tx: ProviderSyncTx,
  connectionId: string,
  partnerId: string,
): Promise<number> {
  const customers = await tx
    .select({
      id: backupProviderCustomers.id,
      vendorCustomerName: backupProviderCustomers.vendorCustomerName,
      vendorExternalCode: backupProviderCustomers.vendorExternalCode,
    })
    .from(backupProviderCustomers)
    .where(and(
      eq(backupProviderCustomers.connectionId, connectionId),
      isNull(backupProviderCustomers.mappingSource),
    ));

  if (customers.length === 0) return 0;

  const orgs = await tx
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(
      eq(organizations.partnerId, partnerId),
      isNull(organizations.deletedAt),
      isNull(organizations.archivedAt),
      sql`${organizations.status} NOT IN ('archived','purging','merging')`,
    ));

  const decisions = resolveCustomerAutoMappings(customers, orgs);
  if (decisions.length === 0) return 0;

  // One UPDATE ... FROM (VALUES ...) rather than N statements. The
  // `mapping_source IS NULL` predicate is repeated here on purpose: it is the
  // concurrency control, so a manual remap that landed between the SELECT and
  // this write wins instead of being clobbered.
  const values = sql.join(
    decisions.map((d) => sql`(${d.customerId}::uuid, ${d.orgId}::uuid, ${d.mappingSource})`),
    sql`, `,
  );
  const updated = await tx.execute(sql`
    UPDATE backup_provider_customers AS c
    SET org_id = v.org_id, mapping_source = v.mapping_source, updated_at = now()
    FROM (VALUES ${values}) AS v(customer_id, org_id, mapping_source)
    WHERE c.id = v.customer_id
      AND c.connection_id = ${connectionId}::uuid
      AND c.mapping_source IS NULL
    RETURNING c.id
  `);
  return (updated as unknown as unknown[]).length;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```
cd apps/api && npx vitest run src/services/backupProviders/mapping.test.ts
```

Expected: 8 `resolveCustomerAutoMappings` cases pass (plus W01's `remapCustomer` cases when they share the file).

- [ ] **Step 6: Typecheck**

```
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: no errors. (`sql.join` + `tx.execute(sql...)` is the form already used at `apps/api/src/extensions/tenancyTripwire.ts:230,238`.)

- [ ] **Step 7: Commit**

```
git add apps/api/src/services/backupProviders/mapping.ts \
        apps/api/src/services/backupProviders/mapping.test.ts \
        apps/api/src/services/backupProviders/persist.ts && \
git commit -m "feat(backup-providers): auto-map vendor customers to orgs by external code or name (#6010)

External code wins over name; a name matching two orgs stays unmapped; manual /
manual_unmapped are never touched. The rules live in a pure resolver so they are
unit-tested with no database; the write is one UPDATE ... FROM (VALUES ...) that
re-asserts mapping_source IS NULL as its concurrency control.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `deviceMatching.ts` — link provider rows to Breeze devices

**Files:**
- Create: `apps/api/src/services/backupProviders/deviceMatching.ts`
- Test: `apps/api/src/services/backupProviders/deviceMatching.test.ts`

**Interfaces:**
- Consumes: `ProviderSyncTx` (Task 1); `backupProviderDevices` (W01); `devices` (`apps/api/src/db/schema/devices.ts`, `status` at :95, `hostname`/`displayName` in the same table); `deviceNetwork` (`apps/api/src/db/schema/devices.ts:350-373`); `isPgUniqueViolation` (`apps/api/src/utils/pgErrors.ts:3`, implementation `packages/shared/src/utils/pgErrors.ts:18-34`).
- Produces:
  - `export interface MatchProviderRow { id: string; orgId: string; matchName: string | null; macAddresses: string[] }`
  - `export interface MatchCandidateDevice { deviceId: string; matchName: string; orgId: string; macAddresses: string[]; claimed: boolean }`
  - `export type DeviceMatchLink = { providerDeviceId: string; deviceId: string; source: 'auto_hostname' | 'auto_mac' }`
  - `export function resolveDeviceMatches(rows: MatchProviderRow[], candidates: MatchCandidateDevice[]): { links: DeviceMatchLink[]; ambiguous: string[] }` (pure)
  - `export async function matchProviderDevices(tx: ProviderSyncTx, connectionId: string): Promise<{ linked: number; ambiguous: number }>`

**Where Breeze stores device MAC addresses (verified, as the spec asks the plan to identify):**
`device_network.mac_address` — `apps/api/src/db/schema/devices.ts:350-373`, declared `macAddress: varchar('mac_address', { length: 64 })` at `:359` (widened from 17 by `2026-08-04-widen-device-mac-address-columns.sql` for Teredo/ISATAP/InfiniBand addresses). The `devices` table itself has **no** MAC column. Network-discovery correlation matches on exactly this column: `apps/api/src/jobs/discoveryWorker.ts:1078` — `conditions.push(eq(deviceNetwork.macAddress, assetData.macAddress))`, inner-joined to `devices` and filtered by `devices.orgId` + `devices.siteId` (`:1082-1091`); the network-baseline correlator uses the same column at `apps/api/src/services/networkBaseline.ts:479`. Both normalize the incoming MAC with a trim+lowercase helper (`apps/api/src/services/assetApproval.ts:17-22`; `networkBaseline.ts:110-114`), and the stored value comes from the Go agent's `net.HardwareAddr` (`agent/internal/collectors/inventory.go:146`), i.e. lower-case colon-separated. W02 therefore compares `lower(dn.mac_address)` against lower-cased provider MACs, so a differently-cased row can never silently miss.

**DECISION:** "active (non-deleted) device" means `devices.status <> 'decommissioned'`. `devices` has **no** soft-delete column (verified: no `deleted_at`/`removed_at` anywhere in `apps/api/src/db/schema/devices.ts`); the repo's own note at `apps/api/src/services/aiToolsTicketing.ts:851` states the table uses `status = 'decommissioned'` *instead of* one, and `ne(devices.status, 'decommissioned')` is the established filter (`agentOrgRateLimit.ts:190`, `archivedOrgReads.ts:277`, `contractQuantities.ts:14`).

**DECISION:** the link write is a batched `UPDATE … FROM (VALUES …)` inside `tx.transaction(...)` (a SAVEPOINT). The resolver already guarantees at most one provider row per device inside a pass, and the candidate load excludes devices another provider row already holds — but two connections syncing concurrently hold *different* advisory locks, so a 23505 on the partial unique index remains possible. Catching it outside a savepoint would poison the whole phase-3 transaction (`apps/api/src/utils/pgErrors.ts:41-57`); inside one it rolls back to the savepoint, this sync links nothing, every target counts as ambiguous, and the next poll retries.

**DECISION:** when a name matches several devices but only ONE of them is still free, the link is recorded as `auto_hostname`, not `auto_mac` — the MAC never entered the decision, and labelling it `auto_mac` would claim evidence the code did not use.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/backupProviders/deviceMatching.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveDeviceMatches } from './deviceMatching';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const dev = (deviceId: string, matchName: string, macs: string[] = [], claimed = false) =>
  ({ deviceId, matchName, orgId: ORG, macAddresses: macs, claimed });

describe('resolveDeviceMatches', () => {
  it('links on a unique hostname match', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: [] }],
      [dev('d1', 'srv-01')],
    );
    expect(out.links).toEqual([{ providerDeviceId: 'p1', deviceId: 'd1', source: 'auto_hostname' }]);
    expect(out.ambiguous).toEqual([]);
  });

  it('breaks a two-candidate tie on MAC, case-insensitively', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: ['AA:BB:CC:DD:EE:FF'] }],
      [dev('d1', 'srv-01', ['00:11:22:33:44:55']), dev('d2', 'srv-01', ['aa:bb:cc:dd:ee:ff'])],
    );
    expect(out.links).toEqual([{ providerDeviceId: 'p1', deviceId: 'd2', source: 'auto_mac' }]);
    expect(out.ambiguous).toEqual([]);
  });

  it('leaves the row unlinked and ambiguous when two candidates BOTH match on MAC', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: ['aa:bb:cc:dd:ee:ff'] }],
      [dev('d1', 'srv-01', ['aa:bb:cc:dd:ee:ff']), dev('d2', 'srv-01', ['aa:bb:cc:dd:ee:ff'])],
    );
    expect(out.links).toEqual([]);
    expect(out.ambiguous).toEqual(['p1']);
  });

  it('leaves the row unlinked and ambiguous when two candidates match and neither carries the MAC', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: ['aa:bb:cc:dd:ee:ff'] }],
      [dev('d1', 'srv-01'), dev('d2', 'srv-01')],
    );
    expect(out.links).toEqual([]);
    expect(out.ambiguous).toEqual(['p1']);
  });

  it('records auto_hostname when several devices match the name but only one is free', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: ['aa:bb:cc:dd:ee:ff'] }],
      [dev('d1', 'srv-01', [], true), dev('d2', 'srv-01')],
    );
    expect(out.links).toEqual([{ providerDeviceId: 'p1', deviceId: 'd2', source: 'auto_hostname' }]);
  });

  it('counts a row as ambiguous when its only candidate is already claimed by another provider row', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: [] }],
      [dev('d1', 'srv-01', [], true)],
    );
    expect(out.links).toEqual([]);
    expect(out.ambiguous).toEqual(['p1']);
  });

  it('gives a contested device to exactly one provider row, deterministically, and calls the loser ambiguous', () => {
    const out = resolveDeviceMatches(
      [
        { id: 'p2', orgId: ORG, matchName: 'srv-01', macAddresses: [] },
        { id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: [] },
      ],
      [dev('d1', 'srv-01')],
    );
    expect(out.links).toEqual([{ providerDeviceId: 'p1', deviceId: 'd1', source: 'auto_hostname' }]);
    expect(out.ambiguous).toEqual(['p2']);
  });

  it('never crosses orgs', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'srv-01', macAddresses: [] }],
      [{ deviceId: 'd1', matchName: 'srv-01', orgId: OTHER_ORG, macAddresses: [], claimed: false }],
    );
    expect(out.links).toEqual([]);
    expect(out.ambiguous).toEqual([]);
  });

  it('is a no-op for a row with no usable match name', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: null, macAddresses: ['aa:bb:cc:dd:ee:ff'] }],
      [dev('d1', 'srv-01', ['aa:bb:cc:dd:ee:ff'])],
    );
    expect(out.links).toEqual([]);
    expect(out.ambiguous).toEqual([]);
  });

  it('does not report a row with no candidate at all as ambiguous', () => {
    const out = resolveDeviceMatches(
      [{ id: 'p1', orgId: ORG, matchName: 'nothing-here', macAddresses: [] }],
      [dev('d1', 'srv-01')],
    );
    expect(out.links).toEqual([]);
    expect(out.ambiguous).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
cd apps/api && npx vitest run src/services/backupProviders/deviceMatching.test.ts
```

Expected: `Failed to resolve import "./deviceMatching"`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/backupProviders/deviceMatching.ts`:

```ts
import { and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { backupProviderDevices, deviceNetwork, devices } from '../../db/schema';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import type { ProviderSyncTx } from './persist';

export interface MatchProviderRow {
  id: string;
  orgId: string;
  /** lower(coalesce(computer_name, vendor_device_name)), already normalized. */
  matchName: string | null;
  macAddresses: string[];
}

export interface MatchCandidateDevice {
  deviceId: string;
  /** lower(hostname) or lower(display_name) — a device appears once per distinct name it answers to. */
  matchName: string;
  orgId: string;
  macAddresses: string[];
  /** Already linked to SOME provider row; the partial unique index would reject a second. */
  claimed: boolean;
}

export type DeviceMatchLink = {
  providerDeviceId: string;
  deviceId: string;
  source: 'auto_hostname' | 'auto_mac';
};

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * PURE match rules (spec, Device matching section).
 *
 *  1. Candidates are non-decommissioned devices in the row's OWN org whose
 *     hostname or display name equals the row's match name.
 *  2. Exactly one free candidate -> auto_hostname.
 *  3. More than one -> intersect on MAC; exactly one survivor -> auto_mac.
 *  4. Anything else -> unlinked, counted ambiguous.
 *
 * `claimed` devices are excluded from candidacy but still make the row
 * ambiguous: "the machine I would have linked is already taken" is exactly the
 * post-acquisition second-connection case the spec wants surfaced on the
 * connection card, not reported as "no match".
 *
 * Rows are processed in ascending id order so a contested device always goes to
 * the same winner across syncs — a non-deterministic winner would make the link
 * flap and re-raise alerts every poll.
 */
export function resolveDeviceMatches(
  rows: MatchProviderRow[],
  candidates: MatchCandidateDevice[],
): { links: DeviceMatchLink[]; ambiguous: string[] } {
  const byOrgAndName = new Map<string, MatchCandidateDevice[]>();
  for (const candidate of candidates) {
    const key = `${candidate.orgId}::${candidate.matchName}`;
    const bucket = byOrgAndName.get(key);
    if (bucket) {
      if (!bucket.some((c) => c.deviceId === candidate.deviceId)) bucket.push(candidate);
    } else {
      byOrgAndName.set(key, [candidate]);
    }
  }

  const taken = new Set(candidates.filter((c) => c.claimed).map((c) => c.deviceId));
  const links: DeviceMatchLink[] = [];
  const ambiguous: string[] = [];

  for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!row.matchName) continue;
    const all = byOrgAndName.get(`${row.orgId}::${row.matchName}`) ?? [];
    if (all.length === 0) continue;

    const free = all.filter((c) => !taken.has(c.deviceId));
    if (free.length === 0) {
      ambiguous.push(row.id);
      continue;
    }
    if (free.length === 1) {
      // The MAC never entered this decision, so the source stays auto_hostname
      // even when the NAME matched several devices.
      taken.add(free[0]!.deviceId);
      links.push({ providerDeviceId: row.id, deviceId: free[0]!.deviceId, source: 'auto_hostname' });
      continue;
    }

    const wanted = new Set(
      row.macAddresses.map((m) => normalize(m)).filter((m): m is string => m !== null),
    );
    const macMatches = wanted.size === 0
      ? []
      : free.filter((c) => c.macAddresses.some((m) => {
        const n = normalize(m);
        return n !== null && wanted.has(n);
      }));
    if (macMatches.length === 1) {
      taken.add(macMatches[0]!.deviceId);
      links.push({ providerDeviceId: row.id, deviceId: macMatches[0]!.deviceId, source: 'auto_mac' });
      continue;
    }
    ambiguous.push(row.id);
  }

  return { links, ambiguous };
}

/** lower(nullif(btrim(coalesce(nullif(btrim(computer_name),''), vendor_device_name)),'')) */
const MATCH_NAME_SQL = sql<string | null>`
  lower(nullif(btrim(coalesce(nullif(btrim(${backupProviderDevices.computerName}), ''),
                              ${backupProviderDevices.vendorDeviceName})), ''))
`;

/**
 * Re-derive every auto link for a connection and report the counters the
 * connection card shows.
 *
 * Four batched statements plus one savepointed write:
 *   1. drop auto links whose device no longer exists / no longer matches;
 *   2. normalise manual rows whose device was hard-deleted (the FK set
 *      breeze_device_id NULL and left device_match_source behind);
 *   3. load the unlinked targets and their candidates, decide in memory;
 *   4. write the links in one UPDATE ... FROM (VALUES ...).
 */
export async function matchProviderDevices(
  tx: ProviderSyncTx,
  connectionId: string,
): Promise<{ linked: number; ambiguous: number }> {
  // 1. Stale auto links. A link survives only while the linked device still
  //    exists in the row's org, is not decommissioned, and still answers to the
  //    row's match name. A rename on either side therefore unlinks within one
  //    poll and re-links in the same pass below.
  await tx.execute(sql`
    UPDATE backup_provider_devices AS p
    SET breeze_device_id = NULL, device_match_source = NULL, updated_at = now()
    WHERE p.connection_id = ${connectionId}::uuid
      AND p.device_match_source IN ('auto_hostname','auto_mac')
      AND (
        p.breeze_device_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM devices d
          WHERE d.id = p.breeze_device_id
            AND d.org_id = p.org_id
            AND d.status <> 'decommissioned'
            AND (
              lower(d.hostname) = lower(nullif(btrim(coalesce(nullif(btrim(p.computer_name), ''), p.vendor_device_name)), ''))
              OR lower(d.display_name) = lower(nullif(btrim(coalesce(nullif(btrim(p.computer_name), ''), p.vendor_device_name)), ''))
            )
        )
      )
  `);

  // 2. Manual links are validated for EXISTENCE only (spec, Device matching
  //    point 3) — a technician's choice is never second-guessed on a rename.
  //    The FK is ON DELETE SET NULL, so a hard-deleted device already cleared
  //    the id; this clears the orphaned source marker so the row reads unlinked.
  await tx
    .update(backupProviderDevices)
    .set({ deviceMatchSource: null, updatedAt: new Date() })
    .where(and(
      eq(backupProviderDevices.connectionId, connectionId),
      eq(backupProviderDevices.deviceMatchSource, 'manual'),
      sql`${backupProviderDevices.breezeDeviceId} IS NULL`,
    ));

  // 3. Targets: backup_manager rows, never manual, currently unlinked.
  const targets = await tx
    .select({
      id: backupProviderDevices.id,
      orgId: backupProviderDevices.orgId,
      matchName: MATCH_NAME_SQL,
      macAddresses: backupProviderDevices.macAddresses,
    })
    .from(backupProviderDevices)
    .where(and(
      eq(backupProviderDevices.connectionId, connectionId),
      eq(backupProviderDevices.accountType, 'backup_manager'),
      sql`${backupProviderDevices.deviceMatchSource} IS DISTINCT FROM 'manual'`,
      sql`${backupProviderDevices.breezeDeviceId} IS NULL`,
    ));

  const named = targets.filter(
    (t): t is typeof t & { matchName: string } => typeof t.matchName === 'string' && t.matchName.length > 0,
  );
  if (named.length === 0) {
    return { linked: await countLinked(tx, connectionId), ambiguous: 0 };
  }

  const orgIds = [...new Set(named.map((t) => t.orgId))];
  const names = [...new Set(named.map((t) => t.matchName))];

  // Candidate devices. `claimed` is a correlated EXISTS over the WHOLE table,
  // not just this connection — the partial unique index on breeze_device_id is
  // global, so a row held by another connection is genuinely unavailable.
  const candidateRows = await tx
    .select({
      deviceId: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
      displayName: devices.displayName,
      claimed: sql<boolean>`EXISTS (
        SELECT 1 FROM backup_provider_devices x WHERE x.breeze_device_id = ${devices.id}
      )`,
    })
    .from(devices)
    .where(and(
      inArray(devices.orgId, orgIds),
      ne(devices.status, 'decommissioned'),
      or(
        inArray(sql<string>`lower(${devices.hostname})`, names),
        inArray(sql<string>`lower(${devices.displayName})`, names),
      ),
    ));

  const macRows = candidateRows.length === 0 ? [] : await tx
    .select({ deviceId: deviceNetwork.deviceId, mac: sql<string>`lower(${deviceNetwork.macAddress})` })
    .from(deviceNetwork)
    .where(and(
      inArray(deviceNetwork.deviceId, candidateRows.map((c) => c.deviceId)),
      isNotNull(deviceNetwork.macAddress),
    ));

  const macsByDevice = new Map<string, string[]>();
  for (const row of macRows) {
    const bucket = macsByDevice.get(row.deviceId);
    if (bucket) bucket.push(row.mac);
    else macsByDevice.set(row.deviceId, [row.mac]);
  }

  const nameSet = new Set(names);
  const candidates: MatchCandidateDevice[] = [];
  for (const row of candidateRows) {
    for (const raw of [row.hostname, row.displayName]) {
      const matchName = normalize(raw);
      if (!matchName || !nameSet.has(matchName)) continue;
      candidates.push({
        deviceId: row.deviceId,
        orgId: row.orgId,
        matchName,
        macAddresses: macsByDevice.get(row.deviceId) ?? [],
        claimed: row.claimed,
      });
    }
  }

  const { links, ambiguous } = resolveDeviceMatches(named, candidates);

  if (links.length > 0) {
    try {
      // SAVEPOINT: drizzle emits one for a nested transaction under the ambient
      // context. A concurrent sync of ANOTHER connection holds a different
      // advisory lock and can take the same device between our candidate read
      // and this write; the resulting 23505 must not poison phase 3.
      await tx.transaction(async (inner) => {
        const values = sql.join(
          links.map((l) => sql`(${l.providerDeviceId}::uuid, ${l.deviceId}::uuid, ${l.source})`),
          sql`, `,
        );
        await inner.execute(sql`
          UPDATE backup_provider_devices AS p
          SET breeze_device_id = v.device_id, device_match_source = v.source, updated_at = now()
          FROM (VALUES ${values}) AS v(provider_device_id, device_id, source)
          WHERE p.id = v.provider_device_id
            AND p.connection_id = ${connectionId}::uuid
            AND p.breeze_device_id IS NULL
            AND p.device_match_source IS DISTINCT FROM 'manual'
        `);
      });
    } catch (error) {
      if (!isPgUniqueViolation(error)) throw error;
      console.warn(
        `[BackupProviderSync] device link batch for connection ${connectionId} lost a `
        + `uniqueness race (${links.length} link(s) skipped); the next sync retries`,
      );
      return {
        linked: await countLinked(tx, connectionId),
        ambiguous: ambiguous.length + links.length,
      };
    }
  }

  return { linked: await countLinked(tx, connectionId), ambiguous: ambiguous.length };
}

async function countLinked(tx: ProviderSyncTx, connectionId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(backupProviderDevices)
    .where(and(
      eq(backupProviderDevices.connectionId, connectionId),
      isNotNull(backupProviderDevices.breezeDeviceId),
    ));
  return row?.n ?? 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
cd apps/api && npx vitest run src/services/backupProviders/deviceMatching.test.ts
```

Expected: 10 passing.

- [ ] **Step 5: Typecheck**

```
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 6: Commit**

```
git add apps/api/src/services/backupProviders/deviceMatching.ts \
        apps/api/src/services/backupProviders/deviceMatching.test.ts && \
git commit -m "feat(backup-providers): link provider device rows to Breeze devices (#6010)

Hostname/display-name match within the row's own org, MAC tiebreak through
device_network.mac_address (the column network discovery already correlates on,
jobs/discoveryWorker.ts:1078), manual links validated for existence only, auto
links re-validated every sync. Decisions come from a pure resolver; the write is
one UPDATE ... FROM (VALUES ...) inside a SAVEPOINT so a cross-connection 23505
on the partial unique index cannot poison the sync transaction.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `persist.ts` — customers, devices and the daily ledger

**Files:**
- Modify: `apps/api/src/services/backupProviders/persist.ts` (created in Task 1 with only `ProviderSyncTx`)
- Test: `apps/api/src/services/backupProviders/persist.test.ts`

**Interfaces:**
- Consumes: `ProviderSyncTx` (Task 1); `autoMapCustomers` (Task 1); `matchProviderDevices` (Task 2); `VendorCustomer` / `VendorDevice` (W01 `types.ts`); `EXTERNAL_BACKUP_STATUSES`, `EXTERNAL_BACKUP_STATUS_SEVERITY`, `ExternalBackupStatus` (W01 shared).
- Produces:
  - `export interface VendorSnapshot { customers: VendorCustomer[]; devices: VendorDevice[] }`
  - `export interface SyncCounters { customers: number; unmappedCustomers: number; devices: number; unmappedDevices: number; linked: number; ambiguous: number }`
  - `export interface PersistConnection { id: string; partnerId: string; provider: string; showProviderNameInPortal: boolean }`
  - `export const LEDGER_STATUS_SEVERITY: ReadonlyArray<readonly [ExternalBackupStatus, number]>`
  - `export function backupStatusSeveritySql(expr: SQL): SQL`
  - `export const LEDGER_RETENTION_DAYS = 60`
  - `export async function persistVendorSnapshot(tx: ProviderSyncTx, connection: PersistConnection, snapshot: VendorSnapshot, options?: { now?: Date }): Promise<SyncCounters>`

**DECISION — `SET CONSTRAINTS ALL DEFERRED` is the first statement of `persistVendorSnapshot`.** The ledger's FK is `(provider_device_id, org_id) → backup_provider_devices(id, org_id)` and the device's is `(customer_id, org_id) → backup_provider_customers(id, org_id)`, both `DEFERRABLE INITIALLY IMMEDIATE`. When a customer's mapping moves to another org, the parent and the child `org_id` have to be re-pointed in separate statements, and an immediate check would abort the sync with 23503 the moment the device row's `org_id` changed ahead of its history rows. This is exactly the org-merge contract CLAUDE.md describes ("Org merge runs `SET CONSTRAINTS ALL DEFERRED` and re-points parent and child `org_id` in separate statements; a non-deferrable one aborts the merge with 23503") and precisely why W01 declares those FKs deferrable. Non-deferrable constraints are unaffected by the statement.

**DECISION — set differences are computed in JS, then deleted by primary key in chunks.** Deleting with `vendor_device_id <> ALL(${jsArray})` is the drizzle tuple-expansion trap (42809, `apps/api/src/extensions/tenancyTripwire.ts:225-230`), and an `ARRAY[…]::text[]` of 10,000 elements is 10,000 bind parameters in one statement. One extra `SELECT id, vendor_device_id, customer_id` per sync is cheaper to reason about and keeps every delete a bounded `inArray(id, chunkOf500)`.

**DECISION — "worst of the day" is generated from `EXTERNAL_BACKUP_STATUS_SEVERITY`, not hand-written.** `LEDGER_STATUS_SEVERITY` is derived from the shared record and `backupStatusSeveritySql` renders it, so the SQL ordering cannot drift from `worstBackupStatus`. The unit test pins the agreement by comparing `worstBackupStatus(a, b)` against the severity table for all 100 ordered pairs, and asserts the table covers every member of `EXTERNAL_BACKUP_STATUSES` (a new enum value fails loudly rather than defaulting to `ELSE 0`).

**DECISION — "no writes on a failed enumeration" is proved one level up.** The adapter throws `ProviderRequestError` on any partial page (spec, Provider adapter section), so `persistVendorSnapshot` is never called at all; the guard lives in `syncConnectionById`'s phase ordering. That property is tested in `backupProviderSync.test.ts` (Task 6, "aborts before phase 3") and end-to-end in the integration suite (Task 8). `persist.test.ts` covers the complementary property — a **complete** snapshot that genuinely lost a device deletes exactly that row.

- [ ] **Step 1: Check two W01 facts this task depends on**

(a) The bigint column mode:

```
cd apps/api && grep -n "selectedBytes\|usedBytes\|day:\|macAddresses\|dataSources\|vendorRaw" src/db/schema/backupProviders.ts
```

Note the declared mode of `selected_bytes` / `used_bytes`. Both spellings exist in this repo (`bigint('policy_kill_epoch', { mode: 'number' })` at `apps/api/src/db/schema/actionIntents.ts:437` vs `bigint('disk_read_bytes', { mode: 'bigint' })` at `apps/api/src/db/schema/devices.ts:431`). If W01 used `mode: 'number'`, pass `device.selectedBytes` / `device.usedBytes` through unchanged as written below. If it used `mode: 'bigint'`, wrap both in the `toBigintOrNull` helper included in Step 4 and change nothing else. Do the same check for `day` (`date('day')` returns a `'YYYY-MM-DD'` string in the default `mode: 'string'`).

(b) **The shared backup-health module must be re-exported from the package root.** Run:

```
grep -n "backupHealth" packages/shared/src/utils/index.ts packages/shared/src/types/index.ts
```

If either barrel is missing the line, add `export * from './backupHealth';` to it in this wave's commit. **Why this matters:** `EXTERNAL_BACKUP_STATUSES`, `EXTERNAL_BACKUP_STATUS_SEVERITY`, `worstBackupStatus` and `deriveBackupHealth` are **value** imports, and deep subpaths such as `@breeze/shared/utils/backupHealth` are absent from `packages/shared/package.json`'s `exports` map (`:8-20`). The unit runner's alias (`apps/api/vitest.config.ts:5-10`) resolves them from source and never notices; the integration config goes through the exports map and three suites once died at module load for exactly this (`apps/api/src/services/aiToolHandoff.ts:42-48`). Every value import in this wave therefore uses the package **root**, `from '@breeze/shared'`; only `import type` may use a deep path.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/services/backupProviders/persist.test.ts`. The DB is a hand-rolled recorder rather than a chainable `vi.fn()` soup, because the properties under test are *which* statements ran with *which* payloads.

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
// Package ROOT, never '@breeze/shared/utils/backupHealth' — see the Step 1
// trap note: deep subpaths are absent from packages/shared's `exports` map and
// a VALUE import through one dies at module load under the integration config.
import {
  EXTERNAL_BACKUP_STATUSES,
  EXTERNAL_BACKUP_STATUS_SEVERITY,
  worstBackupStatus,
  type ExternalBackupStatus,
} from '@breeze/shared';

vi.mock('./mapping', () => ({ autoMapCustomers: vi.fn(async () => 1) }));
vi.mock('./deviceMatching', () => ({ matchProviderDevices: vi.fn(async () => ({ linked: 1, ambiguous: 0 })) }));

import { autoMapCustomers } from './mapping';
import { matchProviderDevices } from './deviceMatching';
import { LEDGER_STATUS_SEVERITY, LEDGER_RETENTION_DAYS, persistVendorSnapshot } from './persist';

const CONNECTION = {
  id: '00000000-0000-4000-8000-0000000000c1',
  partnerId: '00000000-0000-4000-8000-0000000000p1'.replace('p', 'a'),
  provider: 'cove',
  showProviderNameInPortal: false,
};
const ORG = '11111111-1111-4111-8111-111111111111';

type Recorded = { kind: 'select' | 'insert' | 'update' | 'delete' | 'execute'; payload?: unknown };

/**
 * Minimal drizzle stand-in. `selectQueue` feeds the SELECTs in call order and
 * `insertQueue` the `.returning()` results; everything issued is recorded so a
 * test can assert what ran and in which order.
 */
function makeTx(selectQueue: unknown[][], insertQueue: unknown[][]) {
  const calls: Recorded[] = [];
  const executed: string[] = [];

  const thenable = (result: unknown) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'values', 'onConflictDoUpdate', 'set', 'returning', 'limit']) {
      chain[m] = vi.fn((payload?: unknown) => {
        if (m === 'values') calls.push({ kind: 'insert', payload });
        if (m === 'set') calls.push({ kind: 'update', payload });
        return chain;
      });
    }
    (chain as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return chain;
  };

  const tx = {
    select: vi.fn(() => {
      calls.push({ kind: 'select' });
      return thenable(selectQueue.shift() ?? []);
    }),
    insert: vi.fn(() => thenable(insertQueue.shift() ?? [])),
    update: vi.fn(() => thenable([])),
    delete: vi.fn((table?: unknown) => {
      calls.push({ kind: 'delete', payload: table });
      return thenable([]);
    }),
    execute: vi.fn((statement: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(statement?.queryChunks ?? statement);
      executed.push(text);
      calls.push({ kind: 'execute', payload: text });
      return Promise.resolve([]);
    }),
    transaction: vi.fn(async (fn: (inner: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { tx, calls, executed };
}

const vendorDevice = (over: Partial<Record<string, unknown>> = {}) => ({
  vendorDeviceId: 'v1',
  vendorCustomerId: 'vc1',
  name: 'SRV-01',
  computerName: 'srv-01',
  osType: 'server' as const,
  osVersion: 'Windows Server 2022',
  clientVersion: '24.3',
  macAddresses: ['aa:bb:cc:dd:ee:ff'],
  accountType: 'backup_manager' as const,
  dataSources: ['files'],
  status: 'completed' as ExternalBackupStatus,
  vendorStatusCode: 5,
  lastSessionAt: new Date('2026-09-15T02:00:00Z'),
  lastSuccessAt: new Date('2026-09-15T02:00:00Z'),
  lastCompletedAt: new Date('2026-09-15T02:00:00Z'),
  selectedBytes: 100,
  usedBytes: 90,
  errorsCount: 0,
  vendorCreatedAt: null,
  vendorExpiresAt: null,
  raw: {},
  ...over,
});

const vendorCustomer = (over: Partial<Record<string, unknown>> = {}) => ({
  vendorCustomerId: 'vc1',
  name: 'Acme Ltd',
  parentId: null,
  level: 'EndCustomer',
  externalCode: null,
  ...over,
});

describe('LEDGER_STATUS_SEVERITY', () => {
  it('covers every status in the shared enum tuple', () => {
    expect(LEDGER_STATUS_SEVERITY.map(([s]) => s).sort()).toEqual([...EXTERNAL_BACKUP_STATUSES].sort());
  });

  it('carries exactly the shared severities (the SQL CASE is generated from them)', () => {
    for (const [status, severity] of LEDGER_STATUS_SEVERITY) {
      expect(severity).toBe(EXTERNAL_BACKUP_STATUS_SEVERITY[status]);
    }
  });

  it('agrees with worstBackupStatus for every ordered pair', () => {
    const sev = Object.fromEntries(LEDGER_STATUS_SEVERITY) as Record<ExternalBackupStatus, number>;
    for (const a of EXTERNAL_BACKUP_STATUSES) {
      for (const b of EXTERNAL_BACKUP_STATUSES) {
        const expected = sev[a] >= sev[b] ? a : b;
        expect(worstBackupStatus(a, b), `worst(${a}, ${b})`).toBe(expected);
      }
    }
  });

  it('ranks failed worst and completed best (spec severity order)', () => {
    const sev = Object.fromEntries(LEDGER_STATUS_SEVERITY) as Record<ExternalBackupStatus, number>;
    const ordered = [...EXTERNAL_BACKUP_STATUSES].sort((a, b) => sev[b] - sev[a]);
    expect(ordered).toEqual([
      'failed', 'over_quota', 'no_selection', 'no_backups', 'interrupted',
      'completed_with_errors', 'not_started', 'unknown', 'in_progress', 'completed',
    ]);
  });
});

describe('persistVendorSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defers the deferrable FKs before touching any row', async () => {
    const { tx, executed } = makeTx(
      [[], [], []],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], []],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, { customers: [vendorCustomer()], devices: [] });
    expect(executed[0]).toContain('SET CONSTRAINTS ALL DEFERRED');
  });

  it('runs auto-mapping after the customer upsert and before the device upsert', async () => {
    const order: string[] = [];
    (autoMapCustomers as unknown as { mockImplementation: (f: () => Promise<number>) => void })
      .mockImplementation(async () => { order.push('automap'); return 0; });
    (matchProviderDevices as unknown as { mockImplementation: (f: () => Promise<unknown>) => void })
      .mockImplementation(async () => { order.push('match'); return { linked: 0, ambiguous: 0 }; });

    const { tx } = makeTx(
      [
        [],                                              // existing customers
        [{ id: 'c1', vendorCustomerId: 'vc1', orgId: ORG }], // mappings after auto-map
        [],                                              // existing device rows
      ],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p1', orgId: ORG }]],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    expect(order).toEqual(['automap', 'match']);
  });

  it('skips devices whose customer is unmapped and counts them', async () => {
    const { tx } = makeTx(
      [
        [],
        [{ id: 'c1', vendorCustomerId: 'vc1', orgId: null }], // customer NOT mapped
        [],
      ],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], []],
    );
    const counters = await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice(), vendorDevice({ vendorDeviceId: 'v2' })],
    });
    expect(counters.devices).toBe(0);
    expect(counters.unmappedDevices).toBe(2);
    expect(counters.unmappedCustomers).toBe(1);
  });

  it('deletes the device rows of a customer that is no longer mapped', async () => {
    const { tx, calls } = makeTx(
      [
        [],
        [{ id: 'c1', vendorCustomerId: 'vc1', orgId: null }],
        [{ id: 'p-old', vendorDeviceId: 'v1', customerId: 'c1' }],
      ],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], []],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    expect(calls.some((c) => c.kind === 'delete')).toBe(true);
  });

  it('deletes a device row whose vendor device vanished from a complete snapshot', async () => {
    const { tx, calls } = makeTx(
      [
        [],
        [{ id: 'c1', vendorCustomerId: 'vc1', orgId: ORG }],
        [
          { id: 'p-keep', vendorDeviceId: 'v1', customerId: 'c1' },
          { id: 'p-gone', vendorDeviceId: 'v-removed', customerId: 'c1' },
        ],
      ],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p-keep', orgId: ORG }]],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    expect(calls.filter((c) => c.kind === 'delete').length).toBeGreaterThan(0);
  });

  it('upserts one ledger row per persisted device with observations = 1 and today as the day', async () => {
    const { tx, calls } = makeTx(
      [
        [],
        [{ id: 'c1', vendorCustomerId: 'vc1', orgId: ORG }],
        [],
      ],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p1', orgId: ORG }]],
    );
    await persistVendorSnapshot(
      tx as never,
      CONNECTION,
      { customers: [vendorCustomer()], devices: [vendorDevice()] },
      { now: new Date('2026-09-15T23:30:00Z') },
    );
    const ledger = calls
      .filter((c) => c.kind === 'insert')
      .map((c) => c.payload as Array<Record<string, unknown>>)
      .find((rows) => Array.isArray(rows) && rows[0] && 'day' in rows[0]);
    expect(ledger).toBeDefined();
    expect(ledger![0]).toMatchObject({
      providerDeviceId: 'p1',
      orgId: ORG,
      day: '2026-09-15',
      status: 'completed',
      errorsCount: 0,
      observations: 1,
    });
  });

  it('prunes ledger rows older than the retention window for this connection only', async () => {
    const { tx, executed } = makeTx(
      [[], [{ id: 'c1', vendorCustomerId: 'vc1', orgId: ORG }], []],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p1', orgId: ORG }]],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    const prune = executed.find((s) => s.includes('backup_provider_device_history') && s.includes('DELETE'));
    expect(prune).toBeDefined();
    expect(prune).toContain(String(LEDGER_RETENTION_DAYS));
    expect(prune).toContain('connection_id');
  });

  it('re-homes a device row to the mapping org present in THIS transaction', async () => {
    const NEW_ORG = '33333333-3333-4333-8333-333333333333';
    const { tx, calls } = makeTx(
      [[], [{ id: 'c1', vendorCustomerId: 'vc1', orgId: NEW_ORG }], []],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p1', orgId: NEW_ORG }]],
    );
    await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    const deviceRows = calls
      .filter((c) => c.kind === 'insert')
      .map((c) => c.payload as Array<Record<string, unknown>>)
      .find((rows) => Array.isArray(rows) && rows[0] && 'vendorDeviceId' in rows[0]);
    expect(deviceRows![0]).toMatchObject({ orgId: NEW_ORG, provider: 'cove', portalShowProviderName: false });
  });

  it('returns the counters the connection card shows', async () => {
    (matchProviderDevices as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue({ linked: 3, ambiguous: 2 });
    const { tx } = makeTx(
      [[], [{ id: 'c1', vendorCustomerId: 'vc1', orgId: ORG }], []],
      [[{ id: 'c1', vendorCustomerId: 'vc1' }], [{ id: 'p1', orgId: ORG }]],
    );
    const counters = await persistVendorSnapshot(tx as never, CONNECTION, {
      customers: [vendorCustomer()],
      devices: [vendorDevice()],
    });
    expect(counters).toEqual({
      customers: 1,
      unmappedCustomers: 0,
      devices: 1,
      unmappedDevices: 0,
      linked: 3,
      ambiguous: 2,
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```
cd apps/api && npx vitest run src/services/backupProviders/persist.test.ts
```

Expected: `No "persistVendorSnapshot" export is defined on the "./persist" module`.

- [ ] **Step 4: Write the implementation**

Replace the body of `apps/api/src/services/backupProviders/persist.ts` (keeping the `ProviderSyncTx` alias from Task 1 at the top):

```ts
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { db } from '../../db';
import {
  backupProviderCustomers,
  backupProviderDeviceHistory,
  backupProviderDevices,
} from '../../db/schema';
// Package ROOT (see Step 1): `@breeze/shared/utils/backupHealth` is NOT in
// packages/shared's `exports` map, and these are VALUE imports, so a deep
// subpath fails at module load under vitest.integration.config.ts even though
// the unit runner's alias resolves it (apps/api/src/services/aiToolHandoff.ts:42-48).
import {
  EXTERNAL_BACKUP_STATUSES,
  EXTERNAL_BACKUP_STATUS_SEVERITY,
  type ExternalBackupStatus,
} from '@breeze/shared';
import type { VendorCustomer, VendorDevice } from './types';
import { autoMapCustomers } from './mapping';
import { matchProviderDevices } from './deviceMatching';

export type ProviderSyncTx = Pick<
  typeof db,
  'select' | 'insert' | 'update' | 'delete' | 'transaction' | 'execute'
>;

export interface VendorSnapshot {
  customers: VendorCustomer[];
  devices: VendorDevice[];
}

export interface SyncCounters {
  customers: number;
  unmappedCustomers: number;
  devices: number;
  unmappedDevices: number;
  linked: number;
  ambiguous: number;
}

export interface PersistConnection {
  id: string;
  partnerId: string;
  provider: string;
  showProviderNameInPortal: boolean;
}

/** Spec: rows older than 60 days are pruned per connection. */
export const LEDGER_RETENTION_DAYS = 60;

const UPSERT_CHUNK = 500;

/**
 * The severity table the ledger's worst-of-day CASE is generated from.
 *
 * Derived from the SHARED record so the SQL and `worstBackupStatus` cannot
 * drift — persist.test.ts pins that agreement over every ordered pair, and
 * fails loudly if a new `external_backup_status` member is added without a
 * severity (it would otherwise fall into the CASE's `ELSE 0` and silently rank
 * as "better than completed").
 */
export const LEDGER_STATUS_SEVERITY: ReadonlyArray<readonly [ExternalBackupStatus, number]> =
  EXTERNAL_BACKUP_STATUSES.map((status) => [status, EXTERNAL_BACKUP_STATUS_SEVERITY[status]] as const);

/** `(CASE <expr>::text WHEN 'failed' THEN 10 … ELSE 0 END)` */
export function backupStatusSeveritySql(expr: SQL): SQL {
  const whens = LEDGER_STATUS_SEVERITY.map(
    ([status, severity]) => sql`WHEN ${status} THEN ${sql.raw(String(severity))}`,
  );
  return sql`(CASE ${expr}::text ${sql.join(whens, sql` `)} ELSE 0 END)`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Use ONLY if W01 declared selected_bytes / used_bytes as `bigint({ mode: 'bigint' })`.
 * Delete it (and the two call sites) when the schema uses `mode: 'number'`.
 */
export function toBigintOrNull(value: number | null): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

/**
 * Persist one complete vendor snapshot inside the caller's transaction.
 *
 * The caller has already taken the per-connection advisory lock and re-read the
 * connection FOR UPDATE, so nothing here re-checks liveness. Deletions are safe
 * ONLY because the adapter throws on any partial page (spec, Provider adapter):
 * a caught enumeration error never reaches this function, so "absent from the
 * snapshot" genuinely means "gone from the vendor".
 */
export async function persistVendorSnapshot(
  tx: ProviderSyncTx,
  connection: PersistConnection,
  snapshot: VendorSnapshot,
  options: { now?: Date } = {},
): Promise<SyncCounters> {
  const now = options.now ?? new Date();

  // Defer the DEFERRABLE INITIALLY IMMEDIATE composite FKs for this transaction
  // (CLAUDE.md, org-merge contract). A customer whose mapping moved org forces
  // parent and child org_id to be re-pointed in SEPARATE statements; an
  // immediate check would abort with 23503 the moment the device row moved
  // ahead of its history rows. Non-deferrable constraints are unaffected.
  await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

  // ---- customers -------------------------------------------------------
  const existingCustomers = await tx
    .select({
      id: backupProviderCustomers.id,
      vendorCustomerId: backupProviderCustomers.vendorCustomerId,
    })
    .from(backupProviderCustomers)
    .where(eq(backupProviderCustomers.connectionId, connection.id));

  const deviceCountByVendorCustomer = new Map<string, number>();
  for (const device of snapshot.devices) {
    deviceCountByVendorCustomer.set(
      device.vendorCustomerId,
      (deviceCountByVendorCustomer.get(device.vendorCustomerId) ?? 0) + 1,
    );
  }

  const customerValues = snapshot.customers.map((customer) => ({
    connectionId: connection.id,
    partnerId: connection.partnerId,
    vendorCustomerId: customer.vendorCustomerId,
    vendorCustomerName: customer.name.slice(0, 255),
    vendorParentId: customer.parentId?.slice(0, 128) ?? null,
    vendorLevel: customer.level?.slice(0, 40) ?? null,
    vendorExternalCode: customer.externalCode?.slice(0, 255) ?? null,
    // device_count counts ALL devices under the customer, mapped or not — it is
    // what the "N customers / M devices unmapped" summary is built from.
    deviceCount: deviceCountByVendorCustomer.get(customer.vendorCustomerId) ?? 0,
    lastSeenAt: now,
    updatedAt: now,
  }));

  const upsertedCustomers: Array<{ id: string; vendorCustomerId: string }> = [];
  for (const batch of chunk(customerValues, UPSERT_CHUNK)) {
    const rows = await tx
      .insert(backupProviderCustomers)
      .values(batch)
      .onConflictDoUpdate({
        target: [backupProviderCustomers.connectionId, backupProviderCustomers.vendorCustomerId],
        set: {
          vendorCustomerName: sql`excluded.vendor_customer_name`,
          vendorParentId: sql`excluded.vendor_parent_id`,
          vendorLevel: sql`excluded.vendor_level`,
          vendorExternalCode: sql`excluded.vendor_external_code`,
          deviceCount: sql`excluded.device_count`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({
        id: backupProviderCustomers.id,
        vendorCustomerId: backupProviderCustomers.vendorCustomerId,
      });
    upsertedCustomers.push(...rows);
  }

  const seenVendorCustomerIds = new Set(snapshot.customers.map((c) => c.vendorCustomerId));
  const vanishedCustomerIds = existingCustomers
    .filter((row) => !seenVendorCustomerIds.has(row.vendorCustomerId))
    .map((row) => row.id);
  for (const batch of chunk(vanishedCustomerIds, UPSERT_CHUNK)) {
    await tx.delete(backupProviderCustomers).where(inArray(backupProviderCustomers.id, batch));
  }

  await autoMapCustomers(tx, connection.id, connection.partnerId);

  // Mappings are read AFTER auto-mapping and inside this transaction, so a
  // manual remap that landed during the vendor fetch wins (spec, Sync job 3.2).
  const mappings = await tx
    .select({
      id: backupProviderCustomers.id,
      vendorCustomerId: backupProviderCustomers.vendorCustomerId,
      orgId: backupProviderCustomers.orgId,
    })
    .from(backupProviderCustomers)
    .where(eq(backupProviderCustomers.connectionId, connection.id));

  const mappedByVendorId = new Map<string, { id: string; orgId: string }>();
  let unmappedCustomers = 0;
  for (const mapping of mappings) {
    if (mapping.orgId) mappedByVendorId.set(mapping.vendorCustomerId, { id: mapping.id, orgId: mapping.orgId });
    else unmappedCustomers += 1;
  }

  // ---- devices ---------------------------------------------------------
  const existingDevices = await tx
    .select({
      id: backupProviderDevices.id,
      vendorDeviceId: backupProviderDevices.vendorDeviceId,
      customerId: backupProviderDevices.customerId,
    })
    .from(backupProviderDevices)
    .where(eq(backupProviderDevices.connectionId, connection.id));

  const mappedCustomerRowIds = new Set([...mappedByVendorId.values()].map((m) => m.id));
  let unmappedDevices = 0;
  const deviceValues: Array<Record<string, unknown>> = [];
  for (const device of snapshot.devices) {
    const mapping = mappedByVendorId.get(device.vendorCustomerId);
    if (!mapping) {
      unmappedDevices += 1;
      continue;
    }
    deviceValues.push({
      connectionId: connection.id,
      partnerId: connection.partnerId,
      orgId: mapping.orgId,
      customerId: mapping.id,
      provider: connection.provider,
      portalShowProviderName: connection.showProviderNameInPortal,
      vendorDeviceId: device.vendorDeviceId,
      vendorDeviceName: device.name.slice(0, 255),
      computerName: device.computerName?.slice(0, 255) ?? null,
      osType: device.osType,
      osVersion: device.osVersion?.slice(0, 255) ?? null,
      clientVersion: device.clientVersion?.slice(0, 64) ?? null,
      macAddresses: device.macAddresses,
      accountType: device.accountType,
      dataSources: device.dataSources,
      status: device.status,
      vendorStatusCode: device.vendorStatusCode,
      lastSessionAt: device.lastSessionAt,
      lastSuccessAt: device.lastSuccessAt,
      lastCompletedAt: device.lastCompletedAt,
      selectedBytes: device.selectedBytes,
      usedBytes: device.usedBytes,
      errorsCount: device.errorsCount,
      vendorCreatedAt: device.vendorCreatedAt,
      vendorExpiresAt: device.vendorExpiresAt,
      lastSeenAt: now,
      vendorRaw: device.raw,
      updatedAt: now,
    });
  }

  const upsertedDevices: Array<{
    id: string;
    orgId: string;
    status: ExternalBackupStatus;
    lastSuccessAt: Date | null;
    errorsCount: number;
  }> = [];
  for (const batch of chunk(deviceValues, UPSERT_CHUNK)) {
    const rows = await tx
      .insert(backupProviderDevices)
      .values(batch as never)
      .onConflictDoUpdate({
        target: [backupProviderDevices.connectionId, backupProviderDevices.vendorDeviceId],
        set: {
          // org_id / customer_id follow the mapping read in THIS transaction, so
          // a device whose customer was re-homed lands under the new org in the
          // same commit that moved its parent (hence SET CONSTRAINTS above).
          orgId: sql`excluded.org_id`,
          customerId: sql`excluded.customer_id`,
          provider: sql`excluded.provider`,
          portalShowProviderName: sql`excluded.portal_show_provider_name`,
          vendorDeviceName: sql`excluded.vendor_device_name`,
          computerName: sql`excluded.computer_name`,
          osType: sql`excluded.os_type`,
          osVersion: sql`excluded.os_version`,
          clientVersion: sql`excluded.client_version`,
          macAddresses: sql`excluded.mac_addresses`,
          accountType: sql`excluded.account_type`,
          dataSources: sql`excluded.data_sources`,
          status: sql`excluded.status`,
          vendorStatusCode: sql`excluded.vendor_status_code`,
          lastSessionAt: sql`excluded.last_session_at`,
          lastSuccessAt: sql`excluded.last_success_at`,
          lastCompletedAt: sql`excluded.last_completed_at`,
          selectedBytes: sql`excluded.selected_bytes`,
          usedBytes: sql`excluded.used_bytes`,
          errorsCount: sql`excluded.errors_count`,
          vendorCreatedAt: sql`excluded.vendor_created_at`,
          vendorExpiresAt: sql`excluded.vendor_expires_at`,
          lastSeenAt: sql`excluded.last_seen_at`,
          vendorRaw: sql`excluded.vendor_raw`,
          updatedAt: sql`excluded.updated_at`,
          // breeze_device_id / device_match_source / pending_condition are
          // DELIBERATELY absent: the link and the alert state belong to Breeze,
          // not to the vendor payload, and an `excluded.` assignment here would
          // wipe both on every poll.
        },
      })
      .returning({
        id: backupProviderDevices.id,
        orgId: backupProviderDevices.orgId,
        status: backupProviderDevices.status,
        lastSuccessAt: backupProviderDevices.lastSuccessAt,
        errorsCount: backupProviderDevices.errorsCount,
      });
    upsertedDevices.push(...(rows as typeof upsertedDevices));
  }

  // Re-stamp any history row left behind by a device that changed org. The FK
  // is deferred for this transaction, so the mismatch is legal until COMMIT and
  // this statement is what makes it legal AT commit.
  await tx.execute(sql`
    UPDATE backup_provider_device_history AS h
    SET org_id = d.org_id
    FROM backup_provider_devices AS d
    WHERE h.provider_device_id = d.id
      AND d.connection_id = ${connection.id}::uuid
      AND h.org_id <> d.org_id
  `);

  const seenVendorDeviceIds = new Set(snapshot.devices.map((d) => d.vendorDeviceId));
  const staleDeviceIds = existingDevices
    .filter((row) => !seenVendorDeviceIds.has(row.vendorDeviceId) || !mappedCustomerRowIds.has(row.customerId))
    .map((row) => row.id);
  for (const batch of chunk(staleDeviceIds, UPSERT_CHUNK)) {
    await tx.delete(backupProviderDevices).where(inArray(backupProviderDevices.id, batch));
  }

  const { linked, ambiguous } = await matchProviderDevices(tx, connection.id);

  // ---- ledger ----------------------------------------------------------
  const day = utcDay(now);
  const ledgerValues = upsertedDevices.map((device) => ({
    providerDeviceId: device.id,
    orgId: device.orgId,
    day,
    status: device.status,
    lastSuccessAt: device.lastSuccessAt,
    errorsCount: device.errorsCount,
    observations: 1,
    updatedAt: now,
  }));

  const existingSeverity = backupStatusSeveritySql(sql`${backupProviderDeviceHistory.status}`);
  const incomingSeverity = backupStatusSeveritySql(sql`excluded.status`);

  for (const batch of chunk(ledgerValues, UPSERT_CHUNK)) {
    await tx
      .insert(backupProviderDeviceHistory)
      .values(batch as never)
      .onConflictDoUpdate({
        target: [backupProviderDeviceHistory.providerDeviceId, backupProviderDeviceHistory.day],
        set: {
          // Worst status observed that day wins; a day with 48 polls of one
          // failed session is ONE failed day, never 48 failures.
          status: sql`CASE WHEN ${incomingSeverity} > ${existingSeverity}
                           THEN excluded.status ELSE ${backupProviderDeviceHistory.status} END`,
          errorsCount: sql`GREATEST(${backupProviderDeviceHistory.errorsCount}, excluded.errors_count)`,
          observations: sql`${backupProviderDeviceHistory.observations} + 1`,
          // GREATEST ignores NULLs in Postgres, so a first-ever success on the
          // second poll of the day is adopted rather than discarded.
          lastSuccessAt: sql`GREATEST(${backupProviderDeviceHistory.lastSuccessAt}, excluded.last_success_at)`,
          orgId: sql`excluded.org_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  await tx.execute(sql`
    DELETE FROM backup_provider_device_history AS h
    USING backup_provider_devices AS d
    WHERE h.provider_device_id = d.id
      AND d.connection_id = ${connection.id}::uuid
      AND h.day < (${day}::date - ${sql.raw(String(LEDGER_RETENTION_DAYS))})
  `);

  return {
    customers: upsertedCustomers.length,
    unmappedCustomers,
    devices: upsertedDevices.length,
    unmappedDevices,
    linked,
    ambiguous,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```
cd apps/api && npx vitest run src/services/backupProviders/persist.test.ts
```

Expected: 4 `LEDGER_STATUS_SEVERITY` cases and 8 `persistVendorSnapshot` cases pass.

- [ ] **Step 6: Re-run the two sibling suites (the substring filter does not pick them up)**

```
cd apps/api && npx vitest run src/services/backupProviders/persist.test.ts src/services/backupProviders/mapping.test.ts src/services/backupProviders/deviceMatching.test.ts
```

Expected: 3 files, all green.

- [ ] **Step 7: Typecheck**

```
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: no errors. If `selected_bytes` / `used_bytes` are `mode: 'bigint'`, the two assignments fail here — wrap them with `toBigintOrNull(...)` (Step 1) and re-run.

- [ ] **Step 8: Commit**

```
git add apps/api/src/services/backupProviders/persist.ts \
        apps/api/src/services/backupProviders/persist.test.ts \
        packages/shared/src/utils/index.ts packages/shared/src/types/index.ts && \
git commit -m "feat(backup-providers): persist vendor customers, devices and the daily health ledger (#6010)

One complete snapshot per transaction: upsert customers, delete the vanished
ones, auto-map, re-read mappings inside the transaction so a remap that landed
during the fetch wins, upsert devices for mapped customers only, delete rows
whose vendor device vanished or whose customer is no longer mapped, link
devices, then upsert today's ledger row per device with a worst-of-day CASE
generated from EXTERNAL_BACKUP_STATUS_SEVERITY and prune past 60 days.

SET CONSTRAINTS ALL DEFERRED first: re-homing a customer moves parent and child
org_id in separate statements, which is exactly what the deferrable composite
FKs exist for (CLAUDE.md org-merge contract).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Event types `backup.provider_device_unhealthy` / `backup.provider_device_recovered`

Small and standalone so it lands ahead of `alerts.ts` and keeps every commit typecheck-green.

**Files:**
- Modify: `apps/api/src/services/eventBus.ts` — the `EventType` union (the backup block at `:97-103`) and `EVENT_TYPES` (the backup block at `:611-617`)
- Test: `apps/api/src/services/eventBus.types.test.ts` — **read it, do not edit it** (see the DECISION)

**Interfaces:**
- Produces: `EventType` members `'backup.provider_device_unhealthy'`, `'backup.provider_device_recovered'`; constants `EVENT_TYPES.BACKUP_PROVIDER_DEVICE_UNHEALTHY`, `EVENT_TYPES.BACKUP_PROVIDER_DEVICE_RECOVERED`.

**DECISION — "both catalogs in `eventBus.types.test.ts`" needs no edit to that file.** The spec's wording predates the test's current shape. `apps/api/src/services/eventBus.types.test.ts` (46 lines, read in full) holds **no** hand-maintained list: the two catalogs it reconciles are the `EventType` union and the `EVENT_TYPES` record, both in `eventBus.ts`. It proves set equality three ways — a compile-time `MutuallyAssignable<EventType, EventTypeConstant>` assertion (`:16-19`), "every union member has a constant" (`:38-41`) and "every constant is a union member" (`:43-45`) — by regex-parsing the union block out of `eventBus.ts` at `:21-29`. So adding a union member without its constant (or vice versa) fails that suite automatically. Task 4 therefore edits only `eventBus.ts` and **runs** `eventBus.types.test.ts` as the proof.

**Fact recorded, no code change: no notification subscriber is added.** `apps/api/src/services/eventSubscribers.ts:185-190` registers `notification-dispatcher` with `eventTypes: ['alert.triggered', 'alert.acknowledged', 'alert.resolved']` and nothing else — the dispatcher is alert-lifecycle-only. That is why an **unlinked** provider row's failure reaches nobody by email or Slack (spec, Non-goals: closing that gap is a phase-2 decision) and why the spec says the provider events are for webhooks (`webhooks.events` is a free `text[]`) and automations. Do not add a subscriber in this wave.

**Not in this wave:** `apps/web/src/components/automations/AutomationForm.tsx:182` hand-lists selectable automation trigger event types (`huntress.incident_created` and friends). No contract test requires every `EventType` to appear there, and this wave touches no web file — surfacing the two backup-provider events in that dropdown belongs to W03's web work. Noted so it is not lost.

- [ ] **Step 1: Write the failing check**

There is no new test file. The failing state is produced by adding **only** the union members and running the existing contract:

In `apps/api/src/services/eventBus.ts`, after `| 'backup.sla_resolved'` (`:103`), add:

```ts
  // External backup provider (Cove et al., feature #6008 W02). Published on
  // condition TRANSITIONS only, for linked AND unlinked provider device rows,
  // with orgId = the provider row's org. Webhooks and automations can
  // subscribe; the notification dispatcher deliberately does not (it is
  // alert-lifecycle-only, services/eventSubscribers.ts:185-190).
  | 'backup.provider_device_unhealthy'
  | 'backup.provider_device_recovered'
```

- [ ] **Step 2: Run the contract to verify it fails**

```
cd apps/api && npx vitest run src/services/eventBus.types.test.ts
```

Expected failure: `every union member has a constant` reports
`[ 'backup.provider_device_unhealthy', 'backup.provider_device_recovered' ]` instead of `[]`, plus a tsc error on `_eventTypesMatchUnion` (`:18`).

- [ ] **Step 3: Add the constants**

In `EVENT_TYPES`, after `BACKUP_SLA_RESOLVED` (`:617`):

```ts
  // External backup provider (feature #6008 W02)
  BACKUP_PROVIDER_DEVICE_UNHEALTHY: 'backup.provider_device_unhealthy' as const,
  BACKUP_PROVIDER_DEVICE_RECOVERED: 'backup.provider_device_recovered' as const,
```

- [ ] **Step 4: Run the contract to verify it passes**

```
cd apps/api && npx vitest run src/services/eventBus.types.test.ts
```

Expected: 3 passing (`the union was actually parsed`, `every union member has a constant`, `every constant is a union member`).

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/eventBus.ts && \
git commit -m "feat(events): backup.provider_device_unhealthy / _recovered event types (#6010)

Published on condition transitions only, for linked and unlinked provider
device rows. No notification subscriber: eventSubscribers.ts:185 registers the
dispatcher for alert lifecycle events only, which is the documented reason an
unlinked provider failure reaches people through the overview, webhooks and
automations rather than email (spec, Non-goals).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `alerts.ts` — condition evaluation, two-poll hysteresis, dedupe, resolve, events

**Files:**
- Create: `apps/api/src/services/backupProviders/alerts.ts`
- Test: `apps/api/src/services/backupProviders/alerts.test.ts`

**Interfaces:**
- Consumes:
  - `createSourcedAlert(params: CreateSourcedAlertParams): Promise<string | null>` — `apps/api/src/services/alertService.ts:349`, params interface at `:289-327` (`deviceId`, `orgId`, `severity: 'critical'|'high'|'medium'|'low'|'info'`, `title`, `message`, `context: Record<string, unknown> & { source: string }`, `publisher`, `eventPayload?`, `configItemName?`, `siteId?`). Returns the new alert id, or `null` when the insert produced no row or the publish failed and the row was rolled back.
  - `resolveAlert(alertId: string, resolutionNote?: string, resolvedBy?: string): Promise<boolean>` — `apps/api/src/services/alertService.ts:699`. Compare-and-swap: the UPDATE carries `buildResolveAlertCas(alertId)` (`:546`), i.e. `alerts.id = $1 AND alerts.status IN RESOLVABLE_ALERT_STATUSES`, and returns `false` when it matched nothing ("already resolved by someone else, or gone — not an error, just not ours", `:701-702`). It publishes `alert.resolved` itself.
  - `publishEvent(type, orgId, payload, source, options?): Promise<string>` — `apps/api/src/services/eventBus.ts:554-562`.
  - `deriveBackupHealth`, `EVENT_TYPES` (Task 4), `alerts` table (`apps/api/src/db/schema/alerts.ts:103-130`: `status`, `severity`, `title`, `message`, `context jsonb` at `:114`, `suppressedUntil` at `:121`).
  - `getBackupProvider(key)` (W01 registry) for the vendor label.
- Produces:
  - `export const BACKUP_PROVIDER_ALERT_SOURCE = 'backup_provider'`
  - `export const BACKUP_PROVIDER_ALERT_PUBLISHER = 'backup-provider-sync'`
  - `export const PROVIDER_ALERT_RESOLUTION_NOTE = 'Condition cleared by provider sync'`
  - `export const PROVIDER_ALERT_CONFIG_ITEM = 'backup_provider'`
  - `export type ProviderConditionState = { phase: 'clear' } | { phase: 'pending'; condition: BackupProviderAlertCondition } | { phase: 'raised'; condition: BackupProviderAlertCondition }`
  - `export function encodeConditionState(state: ProviderConditionState): string | null`
  - `export function decodeConditionState(value: string | null): ProviderConditionState`
  - `export function computeProviderCondition(input: { status: ExternalBackupStatus; lastSuccessAt: Date | null; errorsCount: number }, now: Date): BackupProviderAlertCondition | null`
  - `export function nextConditionState(prev: ProviderConditionState, computed: BackupProviderAlertCondition | null): { next: ProviderConditionState; raise: boolean; recoveredFrom: BackupProviderAlertCondition | null }`
  - `export const PROVIDER_CONDITION_META: Record<BackupProviderAlertCondition, { severity: 'high' | 'medium'; title: (deviceName: string) => string }>`
  - `export async function evaluateProviderAlerts(connectionId: string, options?: { now?: Date }): Promise<{ raised: number; resolved: number }>`

**DECISION — `pending_condition` carries a TWO-PHASE state, not just "the condition seen last sync".** The spec describes `pending_condition` as the previous poll's condition, which is enough for hysteresis on linked rows (the open alert doubles as "already raised"). It is **not** enough for the events, which the spec requires on transitions only and for **unlinked** rows too — an unlinked row has no alert, so nothing else records "already announced", and a one-state column would re-publish `unhealthy` on every poll forever. W02 therefore encodes three states in the same varchar(30) column: `NULL` = clear, `'<condition>'` = pending (seen once), `'raised:<condition>'` = raised (announced; alert created when linked). The longest encoding is `raised:completed_with_errors` = 28 chars, inside the column's 30 — `alerts.test.ts` asserts that bound so a future longer condition fails loudly instead of silently truncating. Codec and state machine are pure functions, so the whole rule set is unit-tested without a database.

**DECISION — `alertCooldown.ts` is deliberately NOT used.** Both of its mechanisms are keyed on an `alertRules` id, which a provider row does not have: `isCooldownActive(ruleId, deviceId)` and `isFlapping(ruleId, deviceId, windowMinutes = 10, threshold = 4)` (`apps/api/src/services/alertCooldown.ts:413-418`), whose Redis key expires after 1800 s of inactivity (`:400`). With a 30-minute default `sync_interval_minutes` the flap window has always closed and the key has usually already expired, so the check would be a guaranteed no-op that reads like protection. `resolveAlert` still writes a rule/config-policy cooldown internally when the alert has one (`alertService.ts:738-769`) — a provider alert has neither `ruleId` nor `configPolicyId`, so that branch is skipped too. Durable two-poll hysteresis on `pending_condition` is the replacement, and it is the right shape: "a nightly backup that fails one night and succeeds the next is two real incidents" (spec).

**DECISION — an INDEFINITE mute survives auto-resolve.** The dedupe/reuse query treats `active | acknowledged | suppressed` as open (spec). The resolve pass, however, skips rows that are `suppressed` with `suppressed_until IS NULL`, mirroring `autoResolveWarrantyAlerts` (`apps/api/src/services/warrantyAlertEvaluator.ts:227-252`) and its recorded reason (#2110): auto-resolving a "Forever" mute destroys it, because the next recurrence then creates a brand-new **active** alert. Timed suppressions still auto-resolve — their mute was never meant to outlive the condition.

**DECISION — the advisory lock uses the repo's two-argument form,** `pg_advisory_xact_lock(hashtext('backup-provider-sync'), hashtext($connectionId))`, not the single-`bigint` form. Every namespaced advisory lock in this codebase is written that way (`apps/api/src/services/backupJobCreation.ts:61`, `discoveryJobCreation.ts:22`, `c2cJobCreation.ts:23`, `aiBudgetAlerts.ts:113`), and a shared namespace keyword keeps a `hashtext` collision with an unrelated feature's key impossible.

**DECISION — `configItemName: 'backup_provider'`** (same literal as `BACKUP_PROVIDER_ALERT_SOURCE`). Purely so the alert inbox can group and label these the way it does `warranty_expiry` (`warrantyAlertEvaluator.ts:211`); dedupe keys on `context->>'source'` per the spec and never on this column.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/backupProviders/alerts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BACKUP_PROVIDER_ALERT_SOURCE,
  PROVIDER_CONDITION_META,
  computeProviderCondition,
  decodeConditionState,
  encodeConditionState,
  nextConditionState,
  type ProviderConditionState,
} from './alerts';

const NOW = new Date('2026-09-15T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

describe('condition-state codec', () => {
  it('round-trips all three phases', () => {
    const states: ProviderConditionState[] = [
      { phase: 'clear' },
      { phase: 'pending', condition: 'failed' },
      { phase: 'raised', condition: 'completed_with_errors' },
    ];
    for (const state of states) {
      expect(decodeConditionState(encodeConditionState(state))).toEqual(state);
    }
  });

  it('encodes clear as NULL so the column reads empty in SQL', () => {
    expect(encodeConditionState({ phase: 'clear' })).toBeNull();
  });

  it('never exceeds the pending_condition column width (varchar(30))', () => {
    for (const condition of Object.keys(PROVIDER_CONDITION_META) as Array<keyof typeof PROVIDER_CONDITION_META>) {
      expect(encodeConditionState({ phase: 'pending', condition })!.length).toBeLessThanOrEqual(30);
      expect(encodeConditionState({ phase: 'raised', condition })!.length).toBeLessThanOrEqual(30);
    }
  });

  it('decodes an unrecognised value as clear rather than throwing', () => {
    expect(decodeConditionState('raised:nonsense')).toEqual({ phase: 'clear' });
    expect(decodeConditionState('nonsense')).toEqual({ phase: 'clear' });
    expect(decodeConditionState(null)).toEqual({ phase: 'clear' });
  });
});

describe('computeProviderCondition', () => {
  const cases: Array<[string, Parameters<typeof computeProviderCondition>[0], string | null]> = [
    ['failed', { status: 'failed', lastSuccessAt: hoursAgo(1), errorsCount: 3 }, 'failed'],
    ['over_quota', { status: 'over_quota', lastSuccessAt: hoursAgo(1), errorsCount: 0 }, 'over_quota'],
    ['no_selection', { status: 'no_selection', lastSuccessAt: null, errorsCount: 0 }, 'no_selection'],
    ['no_backups', { status: 'no_backups', lastSuccessAt: null, errorsCount: 0 }, 'no_backups'],
    ['completed_with_errors', { status: 'completed_with_errors', lastSuccessAt: hoursAgo(1), errorsCount: 2 }, 'completed_with_errors'],
    ['interrupted folds into completed_with_errors', { status: 'interrupted', lastSuccessAt: hoursAgo(1), errorsCount: 0 }, 'completed_with_errors'],
    ['completed, fresh success', { status: 'completed', lastSuccessAt: hoursAgo(2), errorsCount: 0 }, null],
    ['completed, 30h old success', { status: 'completed', lastSuccessAt: hoursAgo(30), errorsCount: 0 }, null],
    ['completed, 60h old success', { status: 'completed', lastSuccessAt: hoursAgo(60), errorsCount: 0 }, 'stale'],
    ['completed, never succeeded', { status: 'completed', lastSuccessAt: null, errorsCount: 0 }, 'stale'],
    ['in_progress, fresh success', { status: 'in_progress', lastSuccessAt: hoursAgo(3), errorsCount: 0 }, null],
    ['not_started, 60h old success', { status: 'not_started', lastSuccessAt: hoursAgo(60), errorsCount: 0 }, 'stale'],
    ['unknown, fresh success', { status: 'unknown', lastSuccessAt: hoursAgo(3), errorsCount: 0 }, null],
  ];

  it.each(cases)('%s', (_label, input, expected) => {
    expect(computeProviderCondition(input, NOW)).toBe(expected);
  });

  it('prefers the session-status condition over stale when both hold', () => {
    expect(computeProviderCondition({ status: 'failed', lastSuccessAt: null, errorsCount: 1 }, NOW)).toBe('failed');
  });
});

describe('nextConditionState (two-poll hysteresis)', () => {
  it('first observation stores pending and raises nothing', () => {
    expect(nextConditionState({ phase: 'clear' }, 'failed')).toEqual({
      next: { phase: 'pending', condition: 'failed' },
      raise: false,
      recoveredFrom: null,
    });
  });

  it('second consecutive observation raises', () => {
    expect(nextConditionState({ phase: 'pending', condition: 'failed' }, 'failed')).toEqual({
      next: { phase: 'raised', condition: 'failed' },
      raise: true,
      recoveredFrom: null,
    });
  });

  it('a third consecutive observation holds and raises nothing again', () => {
    expect(nextConditionState({ phase: 'raised', condition: 'failed' }, 'failed')).toEqual({
      next: { phase: 'raised', condition: 'failed' },
      raise: false,
      recoveredFrom: null,
    });
  });

  it('clears on the FIRST poll where the condition no longer holds, and reports recovery', () => {
    expect(nextConditionState({ phase: 'raised', condition: 'failed' }, null)).toEqual({
      next: { phase: 'clear' },
      raise: false,
      recoveredFrom: 'failed',
    });
  });

  it('clearing a merely-pending condition reports no recovery (nothing was ever announced)', () => {
    expect(nextConditionState({ phase: 'pending', condition: 'failed' }, null)).toEqual({
      next: { phase: 'clear' },
      raise: false,
      recoveredFrom: null,
    });
  });

  it('a changed condition recovers the old one and re-starts hysteresis for the new one', () => {
    expect(nextConditionState({ phase: 'raised', condition: 'failed' }, 'stale')).toEqual({
      next: { phase: 'pending', condition: 'stale' },
      raise: false,
      recoveredFrom: 'failed',
    });
  });
});

describe('PROVIDER_CONDITION_META', () => {
  it('matches the spec severity/title table', () => {
    expect(PROVIDER_CONDITION_META.failed.severity).toBe('high');
    expect(PROVIDER_CONDITION_META.over_quota.severity).toBe('high');
    expect(PROVIDER_CONDITION_META.no_selection.severity).toBe('medium');
    expect(PROVIDER_CONDITION_META.no_backups.severity).toBe('high');
    expect(PROVIDER_CONDITION_META.completed_with_errors.severity).toBe('medium');
    expect(PROVIDER_CONDITION_META.stale.severity).toBe('high');
    expect(PROVIDER_CONDITION_META.failed.title('SRV-01')).toBe('Backup failed on SRV-01');
    expect(PROVIDER_CONDITION_META.over_quota.title('SRV-01')).toBe('Backup over quota on SRV-01');
    expect(PROVIDER_CONDITION_META.no_selection.title('SRV-01')).toBe('Backup has nothing selected on SRV-01');
    expect(PROVIDER_CONDITION_META.no_backups.title('SRV-01')).toBe('No backups recorded for SRV-01');
    expect(PROVIDER_CONDITION_META.completed_with_errors.title('SRV-01')).toBe('Backup completed with errors on SRV-01');
    expect(PROVIDER_CONDITION_META.stale.title('SRV-01')).toBe('No successful backup in 48 hours on SRV-01');
  });

  it('keeps every title inside the alerts.title column width (varchar(500))', () => {
    const longName = 'x'.repeat(255);
    for (const meta of Object.values(PROVIDER_CONDITION_META)) {
      expect(meta.title(longName).length).toBeLessThanOrEqual(500);
    }
  });
});

describe('BACKUP_PROVIDER_ALERT_SOURCE', () => {
  it('is the literal the dedupe query and the plan index both key on', () => {
    expect(BACKUP_PROVIDER_ALERT_SOURCE).toBe('backup_provider');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
cd apps/api && npx vitest run src/services/backupProviders/alerts.test.ts
```

Expected: `Failed to resolve import "./alerts"`.

- [ ] **Step 3: Write the pure half of the implementation**

Create `apps/api/src/services/backupProviders/alerts.ts` with everything up to (but not including) `evaluateProviderAlerts`:

```ts
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  alerts,
  backupProviderCustomers,
  backupProviderDevices,
  devices,
} from '../../db/schema';
import { createSourcedAlert, resolveAlert } from '../alertService';
import { EVENT_TYPES, publishEvent } from '../eventBus';
import { captureException } from '../sentry';
// Package ROOT — deriveBackupHealth is a VALUE import (see Global Constraints).
import { deriveBackupHealth, type BackupProviderAlertCondition, type ExternalBackupStatus } from '@breeze/shared';
import { getBackupProvider } from './registry';

/** `alerts.context->>'source'` for every row this module writes. */
export const BACKUP_PROVIDER_ALERT_SOURCE = 'backup_provider';
/** `publisher` passed to createSourcedAlert (the `alert.triggered` event source). */
export const BACKUP_PROVIDER_ALERT_PUBLISHER = 'backup-provider-sync';
export const PROVIDER_ALERT_RESOLUTION_NOTE = 'Condition cleared by provider sync';
export const PROVIDER_ALERT_CONFIG_ITEM = 'backup_provider';

const ADVISORY_LOCK_NAMESPACE = 'backup-provider-sync';
const RAISED_PREFIX = 'raised:';

export const PROVIDER_CONDITION_META: Record<
  BackupProviderAlertCondition,
  { severity: 'high' | 'medium'; title: (deviceName: string) => string }
> = {
  failed: { severity: 'high', title: (n) => `Backup failed on ${n}` },
  over_quota: { severity: 'high', title: (n) => `Backup over quota on ${n}` },
  no_selection: { severity: 'medium', title: (n) => `Backup has nothing selected on ${n}` },
  no_backups: { severity: 'high', title: (n) => `No backups recorded for ${n}` },
  completed_with_errors: { severity: 'medium', title: (n) => `Backup completed with errors on ${n}` },
  stale: { severity: 'high', title: (n) => `No successful backup in 48 hours on ${n}` },
};

const CONDITIONS = Object.keys(PROVIDER_CONDITION_META) as BackupProviderAlertCondition[];

export type ProviderConditionState =
  | { phase: 'clear' }
  | { phase: 'pending'; condition: BackupProviderAlertCondition }
  | { phase: 'raised'; condition: BackupProviderAlertCondition };

/**
 * `pending_condition` encodes THREE states, not two (see the plan's DECISION):
 * NULL = clear, '<condition>' = seen once, 'raised:<condition>' = announced.
 * The third state is what makes `backup.provider_device_*` transition-only for
 * UNLINKED rows, which have no alert to read that state from.
 *
 * Longest encoding: 'raised:completed_with_errors' = 28 chars, inside the
 * column's varchar(30). alerts.test.ts pins that bound.
 */
export function encodeConditionState(state: ProviderConditionState): string | null {
  if (state.phase === 'clear') return null;
  return state.phase === 'raised' ? `${RAISED_PREFIX}${state.condition}` : state.condition;
}

export function decodeConditionState(value: string | null): ProviderConditionState {
  if (!value) return { phase: 'clear' };
  if (value.startsWith(RAISED_PREFIX)) {
    const condition = value.slice(RAISED_PREFIX.length) as BackupProviderAlertCondition;
    return CONDITIONS.includes(condition) ? { phase: 'raised', condition } : { phase: 'clear' };
  }
  const condition = value as BackupProviderAlertCondition;
  return CONDITIONS.includes(condition) ? { phase: 'pending', condition } : { phase: 'clear' };
}

/**
 * The spec's condition table, in its stated precedence.
 *
 * A session-status condition always beats `stale`: "No successful backup in 48
 * hours" is true of a failing device too, but "Backup failed" is the actionable
 * claim. `stale` is the catch-all for the statuses that carry no complaint of
 * their own (`completed`, `in_progress`, `not_started`, `unknown`) but whose
 * last SUCCESS is older than 48 h or absent — independent evidence that does
 * not depend on parsing this session's outcome.
 */
export function computeProviderCondition(
  input: { status: ExternalBackupStatus; lastSuccessAt: Date | null; errorsCount: number },
  now: Date,
): BackupProviderAlertCondition | null {
  switch (input.status) {
    case 'failed': return 'failed';
    case 'over_quota': return 'over_quota';
    case 'no_selection': return 'no_selection';
    case 'no_backups': return 'no_backups';
    case 'completed_with_errors':
    case 'interrupted': return 'completed_with_errors';
    default: break;
  }
  const { recency } = deriveBackupHealth({
    status: input.status,
    lastSuccessAt: input.lastSuccessAt,
    errorsCount: input.errorsCount,
    now,
  });
  return recency === 'over_48h' || recency === 'never' ? 'stale' : null;
}

/**
 * Two-poll hysteresis (spec, Alerts and events).
 *
 * Raise only when the computed condition equals the one stored last poll;
 * clear on the FIRST poll where it no longer holds. 30-minute polling makes
 * the Redis flap window useless here (see the plan's alertCooldown DECISION),
 * so consecutive-poll agreement is the durable replacement.
 */
export function nextConditionState(
  prev: ProviderConditionState,
  computed: BackupProviderAlertCondition | null,
): { next: ProviderConditionState; raise: boolean; recoveredFrom: BackupProviderAlertCondition | null } {
  const wasRaised = prev.phase === 'raised' ? prev.condition : null;

  if (computed === null) {
    return { next: { phase: 'clear' }, raise: false, recoveredFrom: wasRaised };
  }
  if (prev.phase === 'raised' && prev.condition === computed) {
    return { next: prev, raise: false, recoveredFrom: null };
  }
  if (prev.phase === 'pending' && prev.condition === computed) {
    return { next: { phase: 'raised', condition: computed }, raise: true, recoveredFrom: null };
  }
  // First observation, or the condition changed: the old one (if announced) has
  // genuinely cleared, and the new one starts its own two-poll count.
  return { next: { phase: 'pending', condition: computed }, raise: false, recoveredFrom: wasRaised };
}
```

- [ ] **Step 4: Run the pure tests to verify they pass**

```
cd apps/api && npx vitest run src/services/backupProviders/alerts.test.ts
```

Expected: the codec, `computeProviderCondition`, `nextConditionState`, `PROVIDER_CONDITION_META` and source-constant blocks all pass (28 cases).

- [ ] **Step 5: Write `evaluateProviderAlerts`**

Append to `apps/api/src/services/backupProviders/alerts.ts`:

```ts
interface ProviderAlertRow {
  id: string;
  orgId: string;
  provider: string;
  vendorDeviceId: string;
  vendorDeviceName: string;
  status: ExternalBackupStatus;
  lastSuccessAt: Date | null;
  errorsCount: number;
  pendingCondition: string | null;
  breezeDeviceId: string | null;
  deviceDisplayName: string | null;
  deviceHostname: string | null;
  customerName: string | null;
}

interface OpenProviderAlert {
  id: string;
  status: string;
  suppressedUntil: Date | null;
  providerDeviceId: string | null;
  condition: string | null;
}

function deviceLabel(row: ProviderAlertRow): string {
  return row.deviceDisplayName || row.deviceHostname || row.vendorDeviceName;
}

function providerLabel(providerKey: string): string {
  try {
    return getBackupProvider(providerKey).label;
  } catch {
    // An unknown provider key means the adapter was removed from the registry
    // while rows survive. The alert must still be readable, so fall back to the
    // raw key instead of failing the whole evaluation.
    return providerKey;
  }
}

/**
 * Post-commit alert and event evaluation for ONE connection.
 *
 * Runs in its OWN system transaction, after the inventory commit, under the
 * same per-connection advisory lock — `createSourcedAlert` and `resolveAlert`
 * publish immediately, and neither may run inside the inventory transaction
 * (spec, Sync job step 4). Idempotent by construction: the state machine's
 * `raise` is a transition, and the dedupe query blocks a second alert for a
 * condition already open, so re-running after a partial failure re-does no
 * work.
 */
export async function evaluateProviderAlerts(
  connectionId: string,
  options: { now?: Date } = {},
): Promise<{ raised: number; resolved: number }> {
  const now = options.now ?? new Date();

  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK_NAMESPACE}), hashtext(${connectionId}))
    `);

    const rows = (await db
      .select({
        id: backupProviderDevices.id,
        orgId: backupProviderDevices.orgId,
        provider: backupProviderDevices.provider,
        vendorDeviceId: backupProviderDevices.vendorDeviceId,
        vendorDeviceName: backupProviderDevices.vendorDeviceName,
        status: backupProviderDevices.status,
        lastSuccessAt: backupProviderDevices.lastSuccessAt,
        errorsCount: backupProviderDevices.errorsCount,
        pendingCondition: backupProviderDevices.pendingCondition,
        breezeDeviceId: backupProviderDevices.breezeDeviceId,
        deviceDisplayName: devices.displayName,
        deviceHostname: devices.hostname,
        customerName: backupProviderCustomers.vendorCustomerName,
      })
      .from(backupProviderDevices)
      .leftJoin(devices, eq(devices.id, backupProviderDevices.breezeDeviceId))
      .leftJoin(backupProviderCustomers, eq(backupProviderCustomers.id, backupProviderDevices.customerId))
      .where(and(
        eq(backupProviderDevices.connectionId, connectionId),
        // M365 backup accounts are never linked to a Breeze device and raise no
        // alerts (spec, Non-goals). They are excluded here rather than filtered
        // later so they never even acquire a pending_condition.
        eq(backupProviderDevices.accountType, 'backup_manager'),
      ))) as ProviderAlertRow[];

    // Every open provider alert of THIS connection, including ones whose row has
    // since vanished — those must resolve too (spec: a device that vanishes, is
    // unlinked, or whose connection is deleted/deactivated resolves its alerts).
    const openAlerts = (await db
      .select({
        id: alerts.id,
        status: alerts.status,
        suppressedUntil: alerts.suppressedUntil,
        providerDeviceId: sql<string | null>`${alerts.context}->>'providerDeviceId'`,
        condition: sql<string | null>`${alerts.context}->>'condition'`,
      })
      .from(alerts)
      .where(and(
        inArray(alerts.status, ['active', 'acknowledged', 'suppressed']),
        sql`${alerts.context}->>'source' = ${BACKUP_PROVIDER_ALERT_SOURCE}`,
        sql`${alerts.context}->>'connectionId' = ${connectionId}`,
      ))) as OpenProviderAlert[];

    const openByKey = new Set(
      openAlerts.map((a) => `${a.providerDeviceId ?? ''}|${a.condition ?? ''}`),
    );

    const pendingWrites: Array<{ id: string; value: string | null }> = [];
    const toRaise: Array<{ row: ProviderAlertRow; condition: BackupProviderAlertCondition }> = [];
    const pendingEvents: Array<{ type: typeof EVENT_TYPES.BACKUP_PROVIDER_DEVICE_UNHEALTHY | typeof EVENT_TYPES.BACKUP_PROVIDER_DEVICE_RECOVERED; orgId: string; payload: Record<string, unknown> }> = [];
    /** "<providerDeviceId>|<condition>" pairs that must SURVIVE this pass. */
    const keep = new Set<string>();

    for (const row of rows) {
      const computed = computeProviderCondition(row, now);
      const prev = decodeConditionState(row.pendingCondition);
      const { next, raise, recoveredFrom } = nextConditionState(prev, computed);

      const encoded = encodeConditionState(next);
      if (encoded !== row.pendingCondition) pendingWrites.push({ id: row.id, value: encoded });

      const { health } = deriveBackupHealth({
        status: row.status,
        lastSuccessAt: row.lastSuccessAt,
        errorsCount: row.errorsCount,
        now,
      });

      if (recoveredFrom) {
        pendingEvents.push({
          type: EVENT_TYPES.BACKUP_PROVIDER_DEVICE_RECOVERED,
          orgId: row.orgId,
          payload: {
            connectionId,
            providerKey: row.provider,
            providerDeviceId: row.id,
            orgId: row.orgId,
            deviceId: row.breezeDeviceId,
            vendorDeviceName: row.vendorDeviceName,
            status: row.status,
            health,
            condition: recoveredFrom,
          },
        });
      }

      if (raise) {
        pendingEvents.push({
          type: EVENT_TYPES.BACKUP_PROVIDER_DEVICE_UNHEALTHY,
          orgId: row.orgId,
          payload: {
            connectionId,
            providerKey: row.provider,
            providerDeviceId: row.id,
            orgId: row.orgId,
            deviceId: row.breezeDeviceId,
            vendorDeviceName: row.vendorDeviceName,
            status: row.status,
            health,
            condition: next.phase === 'raised' ? next.condition : null,
          },
        });
      }

      // Alerts require a device (D3): an unlinked row gets the events above and
      // nothing else. A LINKED row in the raised phase keeps (or gets) exactly
      // one alert for its current condition.
      if (next.phase !== 'raised' || !row.breezeDeviceId) continue;
      keep.add(`${row.id}|${next.condition}`);
      if (!openByKey.has(`${row.id}|${next.condition}`)) {
        toRaise.push({ row, condition: next.condition });
      }
    }

    // ---- persist the hysteresis state -----------------------------------
    if (pendingWrites.length > 0) {
      const values = sql.join(
        pendingWrites.map((w) => sql`(${w.id}::uuid, ${w.value}::varchar)`),
        sql`, `,
      );
      await db.execute(sql`
        UPDATE backup_provider_devices AS p
        SET pending_condition = v.pending_condition, updated_at = now()
        FROM (VALUES ${values}) AS v(id, pending_condition)
        WHERE p.id = v.id AND p.connection_id = ${connectionId}::uuid
      `);
    }

    // ---- resolve what no longer holds -----------------------------------
    // An indefinitely-suppressed alert ("Forever") is left alone: auto-resolving
    // it destroys the mute, because the next recurrence then creates a brand-new
    // ACTIVE alert (warrantyAlertEvaluator.ts:227-252, #2110). Timed
    // suppressions still resolve.
    const resolvable = openAlerts.filter((alert) => {
      if (keep.has(`${alert.providerDeviceId ?? ''}|${alert.condition ?? ''}`)) return false;
      if (alert.status === 'suppressed' && alert.suppressedUntil === null) return false;
      return true;
    });

    let resolved = 0;
    for (const alert of resolvable) {
      if (await resolveAlert(alert.id, PROVIDER_ALERT_RESOLUTION_NOTE)) resolved += 1;
    }
    // Losing an individual compare-and-swap is normal (a technician got there
    // first). Losing EVERY candidate is the shape an RLS write-policy divergence
    // takes, and under `breeze_app` such a write raises no error at all — so one
    // aggregate line per invocation gives that failure somewhere to show up.
    if (resolvable.length > 0 && resolved === 0) {
      console.warn(
        `[BackupProviderSync] alert resolve transitioned 0 of ${resolvable.length} open provider `
        + `alert(s) for connection ${connectionId}; every compare-and-swap matched no rows.`,
      );
    }

    // ---- raise ------------------------------------------------------------
    let raised = 0;
    for (const { row, condition } of toRaise) {
      const meta = PROVIDER_CONDITION_META[condition];
      const name = deviceLabel(row);
      const label = providerLabel(row.provider);
      const lastSuccess = row.lastSuccessAt ? row.lastSuccessAt.toISOString() : 'never';
      const alertId = await createSourcedAlert({
        deviceId: row.breezeDeviceId!,
        // The provider row's org IS the linked device's org: the composite FK
        // (breeze_device_id, org_id) -> devices(id, org_id) enforces it.
        orgId: row.orgId,
        severity: meta.severity,
        title: meta.title(name).slice(0, 500),
        message:
          `${label} reports status "${row.status}" for ${row.vendorDeviceName}`
          + `${row.customerName ? ` (customer ${row.customerName})` : ''}. `
          + `Last successful backup: ${lastSuccess}. Errors in the last session: ${row.errorsCount}.`,
        context: {
          source: BACKUP_PROVIDER_ALERT_SOURCE,
          connectionId,
          providerKey: row.provider,
          providerDeviceId: row.id,
          vendorDeviceId: row.vendorDeviceId,
          condition,
        },
        configItemName: PROVIDER_ALERT_CONFIG_ITEM,
        publisher: BACKUP_PROVIDER_ALERT_PUBLISHER,
        eventPayload: {
          connectionId,
          providerKey: row.provider,
          providerDeviceId: row.id,
          condition,
        },
      });
      if (alertId) {
        raised += 1;
      } else {
        // The insert produced no row or the publish rolled it back, so nothing
        // was announced. The row still sits in the `raised` phase, and the next
        // sync's dedupe finds no open alert and retries — which is why the
        // hysteresis state is NOT rolled back here.
        console.error(
          `[BackupProviderSync] failed to create the ${condition} alert for provider device `
          + `${row.id}; the next sync retries`,
        );
      }
    }

    // ---- publish the transition events ------------------------------------
    // Last, so a publish failure cannot leave an alert unraised. Each publish is
    // individually guarded: the event stream is best-effort, the alert is not.
    for (const event of pendingEvents) {
      try {
        await publishEvent(event.type, event.orgId, event.payload, BACKUP_PROVIDER_ALERT_PUBLISHER);
      } catch (error) {
        console.error(`[BackupProviderSync] failed to publish ${event.type}:`, error);
        captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
          service: 'backupProviders',
          operation: 'evaluateProviderAlerts',
          connectionId,
        });
      }
    }

    return { raised, resolved };
  }, 'backupProviderSync.alerts'));
}
```

- [ ] **Step 6: Extend the test with the orchestration cases**

Append to `apps/api/src/services/backupProviders/alerts.test.ts`. These need module mocks, so they go in a **second file** — `vi.mock` is hoisted per file and mocking `../../db` would break the pure block above. Create `apps/api/src/services/backupProviders/alerts.evaluate.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const createSourcedAlert = vi.fn(async () => 'alert-1');
const resolveAlert = vi.fn(async () => true);
const publishEvent = vi.fn(async () => 'event-1');

let providerRows: unknown[] = [];
let openAlerts: unknown[] = [];
const executed: string[] = [];

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where', 'limit']) c[m] = vi.fn(() => c);
  (c as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return c;
}

let selectCall = 0;
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => chain(selectCall++ === 0 ? providerRows : openAlerts)),
    execute: vi.fn((statement: { queryChunks?: unknown[] }) => {
      executed.push(JSON.stringify(statement?.queryChunks ?? statement));
      return Promise.resolve([]);
    }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../alertService', () => ({ createSourcedAlert, resolveAlert }));
vi.mock('../eventBus', () => ({
  publishEvent,
  EVENT_TYPES: {
    BACKUP_PROVIDER_DEVICE_UNHEALTHY: 'backup.provider_device_unhealthy',
    BACKUP_PROVIDER_DEVICE_RECOVERED: 'backup.provider_device_recovered',
  },
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('./registry', () => ({ getBackupProvider: () => ({ key: 'cove', label: 'Cove Data Protection' }) }));

import { evaluateProviderAlerts } from './alerts';

const CONNECTION = '00000000-0000-4000-8000-0000000000c1';
const ORG = '11111111-1111-4111-8111-111111111111';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  orgId: ORG,
  provider: 'cove',
  vendorDeviceId: 'v1',
  vendorDeviceName: 'SRV-01',
  status: 'failed',
  lastSuccessAt: null,
  errorsCount: 2,
  pendingCondition: null,
  breezeDeviceId: 'd1',
  deviceDisplayName: 'Server One',
  deviceHostname: 'srv-01',
  customerName: 'Acme Ltd',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  selectCall = 0;
  executed.length = 0;
  providerRows = [];
  openAlerts = [];
});

describe('evaluateProviderAlerts', () => {
  it('takes the per-connection advisory lock before reading anything', async () => {
    providerRows = [];
    await evaluateProviderAlerts(CONNECTION);
    expect(executed[0]).toContain('pg_advisory_xact_lock');
    expect(executed[0]).toContain('backup-provider-sync');
  });

  it('raises nothing on the FIRST poll and only stores the pending condition', async () => {
    providerRows = [row()];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
    expect(out).toEqual({ raised: 0, resolved: 0 });
    expect(executed.some((s) => s.includes('pending_condition'))).toBe(true);
  });

  it('raises on the SECOND consecutive poll and publishes the unhealthy event once', async () => {
    providerRows = [row({ pendingCondition: 'failed' })];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(out.raised).toBe(1);
    expect(createSourcedAlert).toHaveBeenCalledTimes(1);
    const params = createSourcedAlert.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({ deviceId: 'd1', orgId: ORG, severity: 'high' });
    expect(params.title).toBe('Backup failed on Server One');
    expect(params.context).toMatchObject({
      source: 'backup_provider',
      connectionId: CONNECTION,
      providerDeviceId: 'p1',
      condition: 'failed',
    });
    expect(publishEvent).toHaveBeenCalledWith(
      'backup.provider_device_unhealthy', ORG, expect.objectContaining({ condition: 'failed', deviceId: 'd1' }), 'backup-provider-sync',
    );
  });

  it('does not raise a second alert while one is already open for the same condition', async () => {
    providerRows = [row({ pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(out).toEqual({ raised: 0, resolved: 0 });
  });

  it('reuses (never duplicates) a SUPPRESSED alert for the same condition', async () => {
    providerRows = [row({ pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'suppressed', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it('resolves the open alert and publishes recovered when the condition clears', async () => {
    providerRows = [row({ status: 'completed', lastSuccessAt: new Date(), errorsCount: 0, pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync');
    expect(out.resolved).toBe(1);
    expect(publishEvent).toHaveBeenCalledWith(
      'backup.provider_device_recovered', ORG, expect.objectContaining({ condition: 'failed' }), 'backup-provider-sync',
    );
  });

  it('leaves an INDEFINITELY suppressed alert alone when the condition clears', async () => {
    providerRows = [row({ status: 'completed', lastSuccessAt: new Date(), errorsCount: 0, pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'suppressed', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it('resolves a TIMED suppression when the condition clears', async () => {
    providerRows = [row({ status: 'completed', lastSuccessAt: new Date(), errorsCount: 0, pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'suppressed', suppressedUntil: new Date(Date.now() + 3600_000), providerDeviceId: 'p1', condition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync');
  });

  it('resolves the alerts of a row that has vanished from the connection', async () => {
    providerRows = [];
    openAlerts = [{ id: 'a1', status: 'active', suppressedUntil: null, providerDeviceId: 'p-gone', condition: 'failed' }];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync');
    expect(out.resolved).toBe(1);
  });

  it('resolves the alert of a row that became UNLINKED, without publishing recovered', async () => {
    providerRows = [row({ breezeDeviceId: null, deviceDisplayName: null, deviceHostname: null, pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync');
    // The CONDITION did not clear — only the link did — so no recovery is announced.
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('publishes events but never creates an alert for an UNLINKED row', async () => {
    providerRows = [row({ breezeDeviceId: null, deviceDisplayName: null, deviceHostname: null, pendingCondition: 'failed' })];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(out.raised).toBe(0);
    expect(publishEvent).toHaveBeenCalledWith(
      'backup.provider_device_unhealthy', ORG, expect.objectContaining({ deviceId: null, condition: 'failed' }), 'backup-provider-sync',
    );
  });

  it('publishes nothing while a raised condition simply persists', async () => {
    providerRows = [row({ pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('names the device by the linked display name, falling back to the vendor name when unlinked', async () => {
    providerRows = [row({ breezeDeviceId: null, deviceDisplayName: null, deviceHostname: null, pendingCondition: 'failed' })];
    await evaluateProviderAlerts(CONNECTION);
    expect(publishEvent).toHaveBeenCalledWith(
      'backup.provider_device_unhealthy', ORG, expect.objectContaining({ vendorDeviceName: 'SRV-01' }), 'backup-provider-sync',
    );
  });

  it('does not count a raise whose alert insert produced no row', async () => {
    createSourcedAlert.mockResolvedValueOnce(null as unknown as string);
    providerRows = [row({ pendingCondition: 'failed' })];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(out.raised).toBe(0);
  });
});
```

- [ ] **Step 7: Run both alert suites**

```
cd apps/api && npx vitest run src/services/backupProviders/alerts.test.ts src/services/backupProviders/alerts.evaluate.test.ts
```

Expected: 2 files, all green. (Listing both paths is required — `vitest run src/services/backupProviders/alerts` would also pull in unrelated substring matches, and a trailing-slash directory filter would silently skip one of them.)

- [ ] **Step 8: Typecheck**

```
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 9: Commit**

```
git add apps/api/src/services/backupProviders/alerts.ts \
        apps/api/src/services/backupProviders/alerts.test.ts \
        apps/api/src/services/backupProviders/alerts.evaluate.test.ts && \
git commit -m "feat(backup-providers): provider alert conditions, two-poll hysteresis and transition events (#6010)

Runs after the inventory commit in its own system transaction under the same
per-connection advisory lock. pending_condition carries a three-state encoding
(clear / pending / raised:<condition>) so the transition-only events also work
for UNLINKED rows, which have no alert to read that state from. Dedupe treats
active|acknowledged|suppressed as open; cleared conditions resolve through
resolveAlert's CAS with 'Condition cleared by provider sync', except an
indefinite mute, which survives (warrantyAlertEvaluator.ts:227-252, #2110).
alertCooldown is deliberately unused: both its mechanisms key on an alertRules
id and its 10-minute flap window has always closed by the next 30-minute poll.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The sync job — scan, three-phase `syncConnectionById`, worker, registrations

**Files:**
- Modify: `apps/api/src/jobs/backupProviderSync.ts` (W01 file — keep its queue constant, queue getter, `addUniqueJob` and `enqueueBackupProviderSync` exactly as they are and add to them)
- Modify: `apps/api/src/services/workerRegistry.ts` (`:778-785`, insert after the `huntressSyncWorker` entry)
- Modify: `apps/api/src/services/workerRegistry.test.ts` (`:52` inside `EXPECTED_WORKER_NAMES`; `:88`, `:130`, `:137`, `:145` the four `141`s)
- Modify: `apps/api/src/services/workerEntrypointClosure.contract.test.ts` (`:294`, the `EXPECTED_NAMES` line holding `'huntressSyncWorker'`)
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts` (`:117`, after `consumers('huntressSyncWorker')`)
- Test: `apps/api/src/jobs/backupProviderSync.test.ts`

**Interfaces:**
- Consumes: `persistVendorSnapshot` (Task 3), `evaluateProviderAlerts` (Task 5), `getBackupProvider` + `decryptProviderCredentials` + `ProviderRequestError` (W01), `attachWorkerObservability(worker, name, options?)` (`apps/api/src/jobs/workerObservability.ts:206-212`), `getBullMQConnection` (`apps/api/src/services/redis`), `captureException` (`apps/api/src/services/sentry`).
- Produces: `selectDueConnections(rows, now)` (pure), `syncConnectionById(connectionId, options?)`, `initializeBackupProviderSyncJob()`, `shutdownBackupProviderSyncJob()`, registry entry `backupProviderSyncWorker`.

**DECISION — due-ness is decided in JS, flags are filtered in SQL.** The SELECT filters `is_active = true AND status <> 'reauth_required'` and returns `{ id, lastSyncAt, syncIntervalMinutes }`; the pure `selectDueConnections(rows, now)` then applies `lastSyncAt IS NULL OR lastSyncAt < now - syncIntervalMinutes`. This is exactly the shape `huntressSync.ts:970-985` uses, and it is the only way the interval rule gets a real unit test — a rule expressed solely as a `make_interval` predicate can only be checked against a live database, and the row count here is bounded by "backup connections per deployment" (single digits), so the pre-filter costs nothing. One rule, one place; the SQL never re-states it.

**DECISION — the phase-1 "running" write is NOT best-effort, because it is also the concurrency fence.** `huntressSync.ts:777-793` wraps its `lastSyncStatus: 'running'` write in try/catch and proceeds on failure, because there it is only a UI badge. Here the write's `.returning({ updatedAt })` value IS the fence phase 3 compares against, so a failed write means there is nothing to detect a mid-sync credential change with — it therefore aborts the sync. A name-only PATCH during phase 2 also bumps `updated_at` and so also aborts; that is a deliberate false positive, costing one skipped poll of at most 5 minutes.

**DECISION — reauth is signalled by a message marker, not a regex over vendor prose.** `huntressSync.ts:1136-1140` re-detects its auth failure with `/Huntress API request failed \(40[13]\b/` because the typed error does not survive BullMQ's round-trip into the `failed` event. W02 uses the same mechanism with an explicit sentinel: the `UnrecoverableError` message is prefixed with `BACKUP_PROVIDER_REAUTH_MARKER`, and `isProviderReauthFailure` checks `error instanceof ProviderRequestError && error.reauth` first, the marker second. A marker cannot drift the way a vendor's error wording can.

**DECISION — a connection with no `vendor_root_id` fails unrecoverably.** `listCustomers`/`listDevices` need the root id, which `testConnection` learns and stores. A NULL there means the connection was never tested (or the row was hand-edited), which no retry fixes — so it records `last_sync_error` and throws `UnrecoverableError`, the same treatment as a rejected credential, and the card tells the MSP to re-test.

- [ ] **Step 1: Read W01's half of the file and confirm three assumptions**

```
cd apps/api && sed -n '1,120p' src/jobs/backupProviderSync.ts
```

Confirm: (a) the queue name constant is `'backup-provider-sync'`; (b) `enqueueBackupProviderSync` adds job **name** `'sync-connection'` with data `{ type: 'sync-connection', connectionId }` under `jobId = backup-provider-sync-${connectionId}`; (c) a module-local `addUniqueJob` helper exists (the `huntressSync.ts:127-150` copy). If (b) differs, adopt W01's spelling everywhere below rather than changing W01's route-facing function — the job id is what makes "Sync now" coalesce with a scheduled run.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/jobs/backupProviderSync.test.ts`. It models the DB-context depth exactly as `apps/api/src/jobs/huntressSync.test.ts:11-82` does, because the phase boundaries are the property under test.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The three-phase contract (mirrors huntressSync.test.ts, #1697): vendor HTTP
// must run at context depth 0 while every read/write runs at depth > 0. We
// model the depth with a counter that withSystemDbAccessContext increments and
// runOutsideDbContext zeroes.
// ---------------------------------------------------------------------------

let contextDepth = 0;
const fetchDepths: number[] = [];
const dbCallDepths: number[] = [];
const updatePayloads: Array<{ depth: number; payload: Record<string, unknown> }> = [];
let connectionRow: Record<string, unknown>;
let reReadRow: Record<string, unknown> | undefined;

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'values', 'onConflictDoUpdate', 'for', 'returning']) {
    c[m] = vi.fn(() => c);
  }
  c.set = vi.fn((payload: Record<string, unknown>) => {
    updatePayloads.push({ depth: contextDepth, payload });
    return c;
  });
  (c as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return c;
}

let selectCall = 0;
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      // 1st: phase-1 load. 2nd: phase-3 FOR UPDATE re-read.
      const result = selectCall++ === 0 ? [connectionRow] : [reReadRow ?? connectionRow];
      return chain(result);
    }),
    update: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain([{ updatedAt: connectionRow.updatedAt }]);
    }),
    insert: vi.fn(() => chain([])),
    delete: vi.fn(() => chain([])),
    execute: vi.fn(() => Promise.resolve([])),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    contextDepth += 1;
    try { return await fn(); } finally { contextDepth -= 1; }
  }),
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    const saved = contextDepth;
    contextDepth = 0;
    try { return fn(); } finally { contextDepth = saved; }
  }),
}));

const listCustomers = vi.fn(async () => { fetchDepths.push(contextDepth); return []; });
const listDevices = vi.fn(async () => { fetchDepths.push(contextDepth); return []; });

class FakeProviderRequestError extends Error {
  code: string;
  reauth: boolean;
  constructor(message: string, reauth: boolean) {
    super(message);
    this.name = 'ProviderRequestError';
    this.code = 'vendor_error';
    this.reauth = reauth;
  }
}

vi.mock('../services/backupProviders/types', () => ({ ProviderRequestError: FakeProviderRequestError }));
vi.mock('../services/backupProviders/registry', () => ({
  getBackupProvider: () => ({ key: 'cove', label: 'Cove Data Protection', listCustomers, listDevices }),
}));
vi.mock('../services/backupProviders/credentials', () => ({
  decryptProviderCredentials: vi.fn(() => ({ partnerName: 'p', username: 'u', password: 'x' })),
}));

const persistVendorSnapshot = vi.fn(async () => ({
  customers: 2, unmappedCustomers: 1, devices: 3, unmappedDevices: 4, linked: 2, ambiguous: 1,
}));
vi.mock('../services/backupProviders/persist', () => ({ persistVendorSnapshot }));

const evaluateProviderAlerts = vi.fn(async () => ({ raised: 0, resolved: 0 }));
vi.mock('../services/backupProviders/alerts', () => ({ evaluateProviderAlerts }));

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));

import { selectDueConnections, syncConnectionById } from './backupProviderSync';

const CONNECTION_ID = '00000000-0000-4000-8000-0000000000c1';
const BASE_ROW = {
  id: CONNECTION_ID,
  partnerId: '11111111-1111-4111-8111-111111111111',
  provider: 'cove',
  name: 'OliveTech Cove',
  baseUrl: 'https://api.backup.management/jsonapi',
  credentialsEncrypted: 'enc',
  vendorRootId: '1234',
  isActive: true,
  status: 'connected',
  syncIntervalMinutes: 30,
  showProviderNameInPortal: false,
  updatedAt: new Date('2026-09-15T10:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  contextDepth = 0;
  selectCall = 0;
  fetchDepths.length = 0;
  dbCallDepths.length = 0;
  updatePayloads.length = 0;
  connectionRow = { ...BASE_ROW };
  reReadRow = undefined;
  persistVendorSnapshot.mockResolvedValue({
    customers: 2, unmappedCustomers: 1, devices: 3, unmappedDevices: 4, linked: 2, ambiguous: 1,
  });
  evaluateProviderAlerts.mockResolvedValue({ raised: 0, resolved: 0 });
});

describe('selectDueConnections', () => {
  const NOW = new Date('2026-09-15T12:00:00Z');
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

  it('includes a connection that has never synced', () => {
    expect(selectDueConnections([{ id: 'a', lastSyncAt: null, syncIntervalMinutes: 30 }], NOW))
      .toEqual([{ id: 'a', lastSyncAt: null, syncIntervalMinutes: 30 }]);
  });

  it('includes a connection whose interval has elapsed', () => {
    expect(selectDueConnections([{ id: 'a', lastSyncAt: minutesAgo(31), syncIntervalMinutes: 30 }], NOW))
      .toHaveLength(1);
  });

  it('excludes a connection inside its interval', () => {
    expect(selectDueConnections([{ id: 'a', lastSyncAt: minutesAgo(10), syncIntervalMinutes: 30 }], NOW))
      .toEqual([]);
  });

  it('respects a per-connection interval shorter than the scan cadence', () => {
    expect(selectDueConnections([{ id: 'a', lastSyncAt: minutesAgo(6), syncIntervalMinutes: 5 }], NOW))
      .toHaveLength(1);
  });
});

describe('syncConnectionById — phase boundaries', () => {
  it('fetches from the vendor with NO DB context held, and reads/writes inside one', async () => {
    await syncConnectionById(CONNECTION_ID);
    expect(listCustomers).toHaveBeenCalledTimes(1);
    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(fetchDepths).toEqual([0, 0]);
    expect(dbCallDepths.length).toBeGreaterThan(0);
    for (const depth of dbCallDepths) expect(depth).toBeGreaterThan(0);
  });

  it('keeps the fetch outside the transaction even under an OUTER context', async () => {
    const dbm = await import('../db');
    await dbm.withSystemDbAccessContext(async () => { await syncConnectionById(CONNECTION_ID); });
    expect(fetchDepths).toEqual([0, 0]);
  });

  it('marks the connection running before fetching and successful after persisting', async () => {
    await syncConnectionById(CONNECTION_ID);
    expect(updatePayloads[0]!.payload).toMatchObject({ lastSyncStatus: 'running', lastSyncError: null });
    const success = updatePayloads.find((u) => u.payload.lastSyncStatus === 'success');
    expect(success).toBeDefined();
    expect(success!.payload).toMatchObject({
      status: 'connected',
      lastSyncCustomers: 2,
      lastSyncUnmappedCustomers: 1,
      lastSyncDevices: 3,
      lastSyncUnmappedDevices: 4,
      lastSyncLinkedDevices: 2,
      lastSyncAmbiguousDevices: 1,
    });
  });
});

describe('syncConnectionById — abort guards', () => {
  it('writes nothing when the connection was deactivated during the fetch', async () => {
    reReadRow = { ...BASE_ROW, isActive: false };
    await syncConnectionById(CONNECTION_ID);
    expect(persistVendorSnapshot).not.toHaveBeenCalled();
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'success')).toBe(false);
  });

  it('writes nothing when updated_at changed during the fetch (credentials PATCHed)', async () => {
    reReadRow = { ...BASE_ROW, updatedAt: new Date('2026-09-15T10:05:00Z') };
    await syncConnectionById(CONNECTION_ID);
    expect(persistVendorSnapshot).not.toHaveBeenCalled();
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'success')).toBe(false);
  });

  it('writes nothing and never fetches when the connection is inactive at phase 1', async () => {
    connectionRow = { ...BASE_ROW, isActive: false };
    await syncConnectionById(CONNECTION_ID);
    expect(listCustomers).not.toHaveBeenCalled();
    expect(persistVendorSnapshot).not.toHaveBeenCalled();
  });
});

describe('syncConnectionById — failure handling', () => {
  it('does not persist anything when the vendor enumeration fails, and records the error', async () => {
    const boom = new Error('cove page 3 of 7 failed');
    listDevices.mockRejectedValueOnce(boom);
    await expect(syncConnectionById(CONNECTION_ID)).rejects.toBe(boom);
    expect(persistVendorSnapshot).not.toHaveBeenCalled();
    const errorWrite = updatePayloads.find((u) => u.payload.lastSyncStatus === 'error');
    expect(errorWrite).toBeDefined();
    expect(errorWrite!.depth).toBeGreaterThan(0);
  });

  it('leaves the row running on a NON-final retry attempt', async () => {
    listDevices.mockRejectedValueOnce(new Error('transient'));
    await expect(syncConnectionById(CONNECTION_ID, { isFinalAttempt: false })).rejects.toThrow('transient');
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'running')).toBe(true);
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'error')).toBe(false);
  });

  it('on a reauth failure sets status reauth_required and throws UnrecoverableError even mid-retry', async () => {
    const { UnrecoverableError } = await import('bullmq');
    listCustomers.mockRejectedValueOnce(new FakeProviderRequestError('credentials rejected', true));
    const rejected = await syncConnectionById(CONNECTION_ID, { isFinalAttempt: false })
      .then(() => null, (e: unknown) => e);
    expect(rejected).toBeInstanceOf(UnrecoverableError);
    const errorWrite = updatePayloads.find((u) => u.payload.lastSyncStatus === 'error');
    expect(errorWrite!.payload).toMatchObject({ status: 'reauth_required' });
  });

  it('fails unrecoverably when the connection has no vendor root id', async () => {
    const { UnrecoverableError } = await import('bullmq');
    connectionRow = { ...BASE_ROW, vendorRootId: null };
    const rejected = await syncConnectionById(CONNECTION_ID).then(() => null, (e: unknown) => e);
    expect(rejected).toBeInstanceOf(UnrecoverableError);
    expect(listCustomers).not.toHaveBeenCalled();
  });

  it('marks the sync PARTIAL (never failed) when alert evaluation throws after the commit', async () => {
    evaluateProviderAlerts.mockRejectedValueOnce(new Error('alert bus down'));
    await expect(syncConnectionById(CONNECTION_ID)).resolves.toBeUndefined();
    expect(persistVendorSnapshot).toHaveBeenCalledTimes(1);
    const partial = updatePayloads.find((u) => u.payload.lastSyncStatus === 'partial');
    expect(partial).toBeDefined();
    expect(String(partial!.payload.lastSyncError)).toContain('alert bus down');
  });

  it('evaluates alerts only AFTER the inventory transaction has committed', async () => {
    const order: string[] = [];
    persistVendorSnapshot.mockImplementationOnce(async () => {
      order.push(`persist@${contextDepth}`);
      return { customers: 0, unmappedCustomers: 0, devices: 0, unmappedDevices: 0, linked: 0, ambiguous: 0 };
    });
    evaluateProviderAlerts.mockImplementationOnce(async () => {
      order.push(`alerts@${contextDepth}`);
      return { raised: 0, resolved: 0 };
    });
    await syncConnectionById(CONNECTION_ID);
    expect(order[0]).toMatch(/^persist@[1-9]/);
    expect(order[1]).toBe('alerts@0');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```
cd apps/api && npx vitest run src/jobs/backupProviderSync.test.ts
```

Expected: `No "selectDueConnections" export is defined on the "./backupProviderSync" module`.

- [ ] **Step 4: Write the job**

Append to `apps/api/src/jobs/backupProviderSync.ts` (keeping W01's queue constant, getter, `addUniqueJob` and `enqueueBackupProviderSync`). Merge the new imports into W01's existing import block.

```ts
import { Job, type JobsOptions, UnrecoverableError, Worker } from 'bullmq';
import { and, eq, ne, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { backupProviderConnections } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { decryptProviderCredentials } from '../services/backupProviders/credentials';
import { getBackupProvider } from '../services/backupProviders/registry';
import { ProviderRequestError } from '../services/backupProviders/types';
import { persistVendorSnapshot } from '../services/backupProviders/persist';
import { evaluateProviderAlerts } from '../services/backupProviders/alerts';
import { attachWorkerObservability } from './workerObservability';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>, label: string): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[BackupProviderSync] withSystemDbAccessContext is not available');
  }
  return dbModule.withSystemDbAccessContext(fn, label);
};

/** How often the scan runs. Per-connection cadence is sync_interval_minutes. */
const SYNC_ALL_INTERVAL_MINUTES = 5;
const ADVISORY_LOCK_NAMESPACE = 'backup-provider-sync';
const MAX_SYNC_ERROR_LENGTH = 2000;

/**
 * Sentinel prefix on an UnrecoverableError raised for a rejected credential.
 * The typed ProviderRequestError does not survive BullMQ's round-trip into the
 * 'failed' event (the same reason huntressSync.ts:1136-1140 re-matches on the
 * message), and a marker cannot drift the way vendor error wording can.
 */
const BACKUP_PROVIDER_REAUTH_MARKER = '[backup-provider-reauth]';

// The upserts are idempotent, so retrying with backoff is safe and recovers a
// transient managed-Postgres connection drop without operator intervention
// (same rationale as huntressSync.ts:40-51).
const SYNC_CONNECTION_JOB_OPTS: Omit<JobsOptions, 'jobId'> = {
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 200 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};

let backupProviderSyncWorker: Worker<BackupProviderSyncJobData> | null = null;

export interface DueConnectionRow {
  id: string;
  lastSyncAt: Date | null;
  syncIntervalMinutes: number;
}

/**
 * PURE due-ness rule. The SQL pre-filters the two FLAG columns only (is_active,
 * status) and this decides the schedule, so the rule has one home and a unit
 * test (huntressSync.ts:980-985 is the same split).
 */
export function selectDueConnections(rows: DueConnectionRow[], now: Date): DueConnectionRow[] {
  return rows.filter((row) => {
    if (!row.lastSyncAt) return true;
    const elapsedMinutes = (now.getTime() - row.lastSyncAt.getTime()) / 60_000;
    return elapsedMinutes >= row.syncIntervalMinutes;
  });
}

async function processSyncAll(): Promise<{ queued: number }> {
  const queue = getBackupProviderSyncQueue();
  // Read inside a short DB context: backup_provider_connections is partner-axis,
  // so a contextless read silently returns 0 rows (#1375). A `reauth_required`
  // connection is skipped entirely — only "Sync now" retries it, and only after
  // a credentials PATCH has reset status to 'connected' (spec, Sync job).
  const candidates = await runWithSystemDbAccess(() => db
    .select({
      id: backupProviderConnections.id,
      lastSyncAt: backupProviderConnections.lastSyncAt,
      syncIntervalMinutes: backupProviderConnections.syncIntervalMinutes,
    })
    .from(backupProviderConnections)
    .where(and(
      eq(backupProviderConnections.isActive, true),
      ne(backupProviderConnections.status, 'reauth_required'),
    )), 'backupProviderSync.scan');

  // The enqueue runs with NO transaction held — Redis-inside-a-context is the
  // #1105 anti-pattern.
  const due = selectDueConnections(candidates, new Date());
  await Promise.all(due.map((connection) => addUniqueJob(
    queue,
    'sync-connection',
    { type: 'sync-connection', connectionId: connection.id },
    `backup-provider-sync-${connection.id}`,
    SYNC_CONNECTION_JOB_OPTS,
  )));
  return { queued: due.length };
}

function isProviderReauthFailure(error: unknown): boolean {
  if (error instanceof ProviderRequestError) return error.reauth;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(BACKUP_PROVIDER_REAUTH_MARKER);
}

async function recordSyncFailure(
  connectionId: string,
  message: string,
  reauth: boolean,
): Promise<void> {
  // A FRESH transaction: phase 3's transaction is rolling back as we unwind, so
  // recording the failure on that connection would be undone and the row would
  // keep its stale 'running'. Escape the context and open a new one
  // (huntressSync.ts:932-950).
  try {
    await dbModule.runOutsideDbContext(() => runWithSystemDbAccess(() => db
      .update(backupProviderConnections)
      .set({
        lastSyncStatus: 'error',
        lastSyncError: message.slice(0, MAX_SYNC_ERROR_LENGTH),
        ...(reauth ? { status: 'reauth_required' as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(backupProviderConnections.id, connectionId)), 'backupProviderSync.recordError'));
  } catch (dbError) {
    console.error(`[BackupProviderSync] Failed to record sync error for ${connectionId}:`, dbError);
    captureException(dbError instanceof Error ? dbError : new Error(String(dbError)));
  }
}

/**
 * Sync ONE connection.
 *
 * Phase 1 — load + mark running in a short system context. The `running` write
 * returns the row's new `updated_at`, which is the fence phase 3 compares
 * against.
 * Phase 2 — vendor HTTP under runOutsideDbContext, holding no pooled
 * connection. Any failure aborts BEFORE a single row is written; the adapter
 * throws on a partial page, so "absent from the snapshot" always means "gone".
 * Phase 3 — one system transaction holding the per-connection advisory lock:
 * re-read FOR UPDATE, abort if deleted/deactivated/credentials changed, then
 * persist and write the counters.
 * Step 4 — after that commit, evaluate alerts and events. A failure there marks
 * the sync `partial` and never fails the job.
 */
export async function syncConnectionById(
  connectionId: string,
  options: { isFinalAttempt?: boolean } = {},
): Promise<void> {
  const isFinalAttempt = options.isFinalAttempt ?? true;

  // ---- phase 1 ---------------------------------------------------------
  const loaded = await runWithSystemDbAccess(async () => {
    const [row] = await db
      .select()
      .from(backupProviderConnections)
      .where(eq(backupProviderConnections.id, connectionId))
      .limit(1);
    if (!row) return null;
    if (!row.isActive) return { row, fence: null, inactive: true as const };

    const [marked] = await db
      .update(backupProviderConnections)
      .set({ lastSyncStatus: 'running', lastSyncError: null, updatedAt: new Date() })
      .where(eq(backupProviderConnections.id, connectionId))
      .returning({ updatedAt: backupProviderConnections.updatedAt });
    return { row, fence: marked?.updatedAt ?? null, inactive: false as const };
  }, 'backupProviderSync.load');

  if (!loaded) {
    console.warn(`[BackupProviderSync] Connection ${connectionId} not found, skipping sync`);
    return;
  }
  if (loaded.inactive) {
    console.warn(`[BackupProviderSync] Connection ${connectionId} is inactive, skipping sync`);
    return;
  }
  if (!loaded.fence) {
    // The `running` write matched no row. Unlike Huntress's cosmetic badge this
    // value IS the optimistic-concurrency fence, so there is nothing to detect a
    // mid-sync credential change with — refuse rather than sync blind.
    throw new Error(`[BackupProviderSync] Could not mark connection ${connectionId} as running`);
  }

  const connection = loaded.row;
  const fence = loaded.fence;

  try {
    if (!connection.vendorRootId) {
      throw new UnrecoverableError(
        `${BACKUP_PROVIDER_REAUTH_MARKER} connection ${connectionId} has no vendor root id — re-test the connection`,
      );
    }

    const adapter = getBackupProvider(connection.provider);
    const credentials = decryptProviderCredentials(connectionId, connection.credentialsEncrypted);

    // ---- phase 2 -------------------------------------------------------
    const [customers, vendorDevices] = await dbModule.runOutsideDbContext(() => Promise.all([
      adapter.listCustomers(credentials, connection.baseUrl, connection.vendorRootId!),
      adapter.listDevices(credentials, connection.baseUrl, connection.vendorRootId!),
    ]));

    // ---- phase 3 -------------------------------------------------------
    const counters = await runWithSystemDbAccess(async () => {
      await db.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK_NAMESPACE}), hashtext(${connectionId}))
      `);

      const [current] = await db
        .select({
          id: backupProviderConnections.id,
          partnerId: backupProviderConnections.partnerId,
          provider: backupProviderConnections.provider,
          isActive: backupProviderConnections.isActive,
          showProviderNameInPortal: backupProviderConnections.showProviderNameInPortal,
          updatedAt: backupProviderConnections.updatedAt,
        })
        .from(backupProviderConnections)
        .where(eq(backupProviderConnections.id, connectionId))
        .for('update')
        .limit(1);

      if (!current || !current.isActive) return null;
      if (current.updatedAt.getTime() !== fence.getTime()) return null;

      const result = await persistVendorSnapshot(
        db,
        {
          id: current.id,
          partnerId: current.partnerId,
          provider: current.provider,
          showProviderNameInPortal: current.showProviderNameInPortal,
        },
        { customers, devices: vendorDevices },
      );

      // Counters commit in the SAME transaction as the rows they describe, so
      // "succeeded at <lastSyncAt>" can never disagree with the numbers shown.
      await db
        .update(backupProviderConnections)
        .set({
          lastSyncAt: new Date(),
          lastSyncStatus: 'success',
          lastSyncError: null,
          status: 'connected',
          lastSyncCustomers: result.customers,
          lastSyncUnmappedCustomers: result.unmappedCustomers,
          lastSyncDevices: result.devices,
          lastSyncUnmappedDevices: result.unmappedDevices,
          lastSyncLinkedDevices: result.linked,
          lastSyncAmbiguousDevices: result.ambiguous,
          updatedAt: new Date(),
        })
        .where(eq(backupProviderConnections.id, connectionId));

      return result;
    }, 'backupProviderSync.persist');

    if (!counters) {
      console.warn(
        `[BackupProviderSync] Connection ${connectionId} changed during the vendor fetch `
        + '(deleted, deactivated or re-credentialled); nothing written, the next poll retries',
      );
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reauth = isProviderReauthFailure(error);
    // Only the FINAL attempt records a terminal 'error' (#1736): an earlier
    // attempt leaves the row 'running' so the UI keeps showing "Syncing" while
    // BullMQ backs off. A rejected credential is terminal at any attempt.
    if (isFinalAttempt || reauth) {
      await recordSyncFailure(connectionId, message, reauth);
    }
    if (reauth) {
      throw error instanceof UnrecoverableError ? error : new UnrecoverableError(
        `${BACKUP_PROVIDER_REAUTH_MARKER} ${message}`,
      );
    }
    throw error;
  }

  // ---- step 4 (after the inventory commit) -----------------------------
  try {
    await evaluateProviderAlerts(connectionId);
  } catch (error) {
    // Idempotent, so the next sync redoes it. The inventory is committed and
    // correct — degrade to 'partial', never fail the job (spec, Sync job).
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[BackupProviderSync] Alert evaluation failed for ${connectionId}:`, error);
    captureException(error instanceof Error ? error : new Error(message), undefined, {
      service: 'backupProviders',
      operation: 'evaluateProviderAlerts',
      connectionId,
    });
    try {
      await dbModule.runOutsideDbContext(() => runWithSystemDbAccess(() => db
        .update(backupProviderConnections)
        .set({
          lastSyncStatus: 'partial',
          lastSyncError: `alerts: ${message}`.slice(0, MAX_SYNC_ERROR_LENGTH),
          updatedAt: new Date(),
        })
        .where(eq(backupProviderConnections.id, connectionId)), 'backupProviderSync.markPartial'));
    } catch (dbError) {
      console.error(`[BackupProviderSync] Failed to mark ${connectionId} partial:`, dbError);
      captureException(dbError instanceof Error ? dbError : new Error(String(dbError)));
    }
  }
}

async function processSyncConnection(
  data: { connectionId: string },
  job: Job<BackupProviderSyncJobData>,
): Promise<void> {
  // BullMQ increments attemptsMade on move-to-active, so inside the processor it
  // is 1-based: the final attempt is `attemptsMade >= attempts`
  // (huntressSync.ts:1002-1007).
  const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
  await syncConnectionById(data.connectionId, { isFinalAttempt });
}

function createBackupProviderSyncWorker(): Worker<BackupProviderSyncJobData> {
  return new Worker<BackupProviderSyncJobData>(
    BACKUP_PROVIDER_SYNC_QUEUE,
    async (job: Job<BackupProviderSyncJobData>) => {
      // No blanket withSystemDbAccessContext wrap: each path manages its own
      // short contexts so the vendor fetch holds no pooled connection
      // (#1105/#1697).
      switch (job.data.type) {
        case 'sync-all':
          return processSyncAll();
        case 'sync-connection':
          return processSyncConnection(job.data, job);
        default:
          throw new Error(`Unknown backup provider sync job type: ${(job.data as { type: string }).type}`);
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 4,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
}

async function scheduleRepeatSyncAll(): Promise<void> {
  const queue = getBackupProviderSyncQueue();
  for (const repeatable of await queue.getRepeatableJobs()) {
    if (repeatable.name === 'sync-all') {
      await queue.removeRepeatableByKey(repeatable.key);
    }
  }
  await queue.add(
    'sync-all',
    { type: 'sync-all' },
    {
      repeat: { every: SYNC_ALL_INTERVAL_MINUTES * 60_000 },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 30 },
    },
  );
}

export async function initializeBackupProviderSyncJob(): Promise<void> {
  backupProviderSyncWorker = createBackupProviderSyncWorker();
  attachWorkerObservability(backupProviderSyncWorker, 'backupProviderSyncWorker');
  backupProviderSyncWorker.on('error', (error) => {
    console.error('[BackupProviderSync] Worker error:', error);
    captureException(error);
  });
  backupProviderSyncWorker.on('failed', (job, error) => {
    // A rejected vendor credential is a config issue already recorded on the
    // connection row — not a code bug. Capturing it once per scheduled run is
    // what flooded the org's Sentry quota for Huntress (BREEZE-1, ~508 events).
    // Log it; don't report.
    if (isProviderReauthFailure(error)) {
      console.warn(
        `[BackupProviderSync] Job ${job?.id} failed: provider credentials rejected — `
        + 'update them on the connection. Not retried, not reported to Sentry.',
      );
      return;
    }
    console.error(`[BackupProviderSync] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  await scheduleRepeatSyncAll();
  console.log('[BackupProviderSync] Backup provider sync worker initialized');
}

export async function shutdownBackupProviderSyncJob(): Promise<void> {
  if (backupProviderSyncWorker) {
    await backupProviderSyncWorker.close();
    backupProviderSyncWorker = null;
  }
  await closeBackupProviderSyncQueue();
  console.log('[BackupProviderSync] Backup provider sync worker shut down');
}
```

Two names above come from W01's half of the file and must match it exactly: `BACKUP_PROVIDER_SYNC_QUEUE`, `getBackupProviderSyncQueue()`, `addUniqueJob(...)`, the `BackupProviderSyncJobData` union (extend it with `{ type: 'sync-all' }` if W01 only declared the `sync-connection` member) and a queue-closing helper. If W01 closes the queue inline instead of exporting `closeBackupProviderSyncQueue()`, inline the same two lines here (`await queue.close(); queue = null;`) rather than adding an export W01 did not plan.

- [ ] **Step 5: Run the job tests to verify they pass**

```
cd apps/api && npx vitest run src/jobs/backupProviderSync.test.ts
```

Expected: 4 `selectDueConnections` cases, 3 phase-boundary cases, 3 abort-guard cases and 6 failure-handling cases — 16 passing.

- [ ] **Step 6: Register the worker**

In `apps/api/src/services/workerRegistry.ts`, insert immediately after the `huntressSyncWorker` entry (`:778-785`):

```ts
  {
    // Backup provider integration W02 (#6008 / #6010). 'global': its runtime
    // import closure reaches alertService + eventBus but no socket-local
    // dispatch — the same shape as monitorWorker (:674) and warrantyWorker
    // (:926), both 'global'. Verified mechanically in Step 8, not by reasoning.
    name: 'backupProviderSyncWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/backupProviderSync');
      return { init: m.initializeBackupProviderSyncJob, shutdown: m.shutdownBackupProviderSyncJob };
    },
  },
```

In `apps/api/src/jobs/workerReadinessManifest.ts`, after `consumers('huntressSyncWorker'),` (`:117`):

```ts
  consumers('backupProviderSyncWorker'),
```

(The initializer name, the registry entry name and the `attachWorkerObservability` name are all `backupProviderSyncWorker`, so the default `names: [initializer]` in the `consumers` helper at `:31-39` is correct.)

- [ ] **Step 7: Update the two duplicated name lists and the four counts**

In `apps/api/src/services/workerRegistry.test.ts` at `:52` (inside `EXPECTED_WORKER_NAMES`), change

```ts
  'dnsSyncWorker', 's1SyncWorker', 'huntressSyncWorker', 'm365SyncWorker', 'pax8SyncWorker',
```

to

```ts
  'dnsSyncWorker', 's1SyncWorker', 'huntressSyncWorker',
  // Backup provider integration W02 (#6008 / #6010).
  'backupProviderSyncWorker',
  'm365SyncWorker', 'pax8SyncWorker',
```

and change all four `141` literals to `142` (`:88` `WORKER_REGISTRY.length`, `:130` `selectWorkers('all').length`, `:137` `api.length + worker.length`, `:145` `union.size`).

Make the identical name-list edit in `apps/api/src/services/workerEntrypointClosure.contract.test.ts` at `:294` (that file derives its counts from `EXPECTED_NAMES.length`, so it has no literals to bump).

- [ ] **Step 8: Run every contract the new registry entry touches**

```
cd apps/api && npx vitest run \
  src/services/workerRegistry.test.ts \
  src/services/workerEntrypointClosure.contract.test.ts \
  src/jobs/workerReadinessManifest.test.ts
```

Expected: all green. If `workerEntrypointClosure.contract.test.ts` reports `"backupProviderSyncWorker" is placed 'global' but its runtime import closure reaches socket-local dispatch via: …`, **flip the entry to `'socket-owner'`** in `workerRegistry.ts` and update the comment — that test is the mechanical authority and placement is never a judgment call (`workerRegistry.ts:47-48`, `workerEntrypointClosure.contract.test.ts:40-45`).

- [ ] **Step 9: Typecheck and run the whole wave's unit surface**

```
cd apps/api && npx tsc --noEmit -p tsconfig.json && npx vitest run \
  src/jobs/backupProviderSync.test.ts \
  src/services/backupProviders/persist.test.ts \
  src/services/backupProviders/mapping.test.ts \
  src/services/backupProviders/deviceMatching.test.ts \
  src/services/backupProviders/alerts.test.ts \
  src/services/backupProviders/alerts.evaluate.test.ts \
  src/services/eventBus.types.test.ts
```

Expected: 7 files, all green.

- [ ] **Step 10: Commit**

```
git add apps/api/src/jobs/backupProviderSync.ts \
        apps/api/src/jobs/backupProviderSync.test.ts \
        apps/api/src/jobs/workerReadinessManifest.ts \
        apps/api/src/services/workerRegistry.ts \
        apps/api/src/services/workerRegistry.test.ts \
        apps/api/src/services/workerEntrypointClosure.contract.test.ts && \
git commit -m "feat(backup-providers): five-minute sync scan, three-phase connection sync and worker (#6010)

Phase 1 loads and marks running (the returned updated_at is the concurrency
fence), phase 2 fetches from the vendor under runOutsideDbContext so no pooled
connection is held across the HTTP window (#1697), phase 3 persists in one
system transaction holding pg_advisory_xact_lock and aborts if the connection
was deleted, deactivated or re-credentialled meanwhile. Alerts are evaluated
after that commit and a failure there marks the sync partial rather than failing
the job. A rejected credential sets status reauth_required, throws
UnrecoverableError and is suppressed from Sentry (BREEZE-1).

Registers backupProviderSyncWorker (global) in workerRegistry, the readiness
manifest and both duplicated name lists.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Deactivating a connection resolves its open provider alerts

The spec makes a deleted connection resolve its alerts at the route, before the delete. A **deactivated** connection is the same situation — `processSyncAll` skips it, so nothing would ever clear its alerts and the inbox would keep showing failures for a provider the MSP turned off.

**Files:**
- Modify: `apps/api/src/routes/backup/providers.ts` (the `PATCH /backup/providers/connections/:id` handler, W01)
- Modify: the sibling route test W01 created (`apps/api/src/routes/backup/providers.test.ts`)

**Interfaces:**
- Consumes: `resolveProviderAlertsForConnection` from `apps/api/src/services/backupProviders/alertsResolve.ts` (W01).

- [ ] **Step 1: Find out what W01 actually shipped**

```
cd apps/api && grep -rn "resolveProviderAlertsForConnection" src/services/backupProviders/ src/routes/backup/providers.ts
```

Record the exact signature and whether the PATCH handler already calls it on an `isActive: false` transition.

- **If the PATCH already calls it:** this task is a verification only. Add the regression test from Step 2 anyway (it is the thing that keeps the behaviour) and skip Step 3.
- **If `alertsResolve.ts` exists but the PATCH does not call it:** do Steps 2-3.
- **If neither exists** (W01 put the delete-path resolve inline): implement `resolveProviderAlertsForConnection(connectionId: string, note?: string): Promise<number>` in `apps/api/src/services/backupProviders/alertsResolve.ts` as part of this task, reusing the resolve half of `alerts.ts` — the open-alert query keyed on `context->>'source' = BACKUP_PROVIDER_ALERT_SOURCE` and `context->>'connectionId'`, the same indefinite-mute carve-out, and `resolveAlert(id, note)`. Then do Steps 2-3 and switch the delete path to the shared helper too.

- [ ] **Step 2: Write the failing test**

Add to `apps/api/src/routes/backup/providers.test.ts` (append to W01's PATCH describe block; match its existing auth/mock scaffolding rather than re-inventing it):

```ts
it('resolves the connection\'s open provider alerts when it is deactivated', async () => {
  const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
    method: 'PATCH',
    headers: authHeaders(partnerToken),
    body: JSON.stringify({ isActive: false }),
  });
  expect(res.status).toBe(200);
  expect(resolveProviderAlertsForConnection).toHaveBeenCalledWith(CONNECTION_ID);
});

it('does NOT resolve provider alerts on an unrelated PATCH', async () => {
  const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
    method: 'PATCH',
    headers: authHeaders(partnerToken),
    body: JSON.stringify({ name: 'Renamed' }),
  });
  expect(res.status).toBe(200);
  expect(resolveProviderAlertsForConnection).not.toHaveBeenCalled();
});

it('does NOT resolve provider alerts when re-activating', async () => {
  const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
    method: 'PATCH',
    headers: authHeaders(partnerToken),
    body: JSON.stringify({ isActive: true }),
  });
  expect(res.status).toBe(200);
  expect(resolveProviderAlertsForConnection).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the test to verify it fails, then wire the handler**

```
cd apps/api && npx vitest run src/routes/backup/providers.test.ts
```

Expected failure on the first case: `expected "resolveProviderAlertsForConnection" to be called with arguments`.

In the PATCH handler, after the connection UPDATE has succeeded and **inside** the request's own `withDbAccessContext` (never `runOutsideDbContext(() => withSystemDbAccessContext(...))` from a route — it double-holds a pooled connection and bypasses RLS, #2417):

```ts
  // A deactivated connection is skipped by processSyncAll, so nothing would
  // ever clear its alerts again — the inbox would keep showing failures for a
  // provider the MSP turned off. Same treatment as DELETE (spec, Sync job).
  // Only on the true -> false transition, so a rename or a re-activation does
  // not silently close a technician's open alerts.
  if (body.isActive === false && existing.isActive === true) {
    await resolveProviderAlertsForConnection(id);
  }
```

- [ ] **Step 4: Run the route tests**

```
cd apps/api && npx vitest run src/routes/backup/providers.test.ts
```

Expected: W01's cases plus the three new ones, all green.

- [ ] **Step 5: Commit**

```
git add apps/api/src/routes/backup/providers.ts apps/api/src/routes/backup/providers.test.ts \
        apps/api/src/services/backupProviders/alertsResolve.ts && \
git commit -m "fix(backup-providers): deactivating a connection resolves its open provider alerts (#6010)

processSyncAll skips an inactive connection, so without this the alert inbox
keeps showing failures for a provider the MSP turned off and nothing ever
clears them. Only fires on the true -> false transition.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Integration test — the whole sync against real Postgres and Redis

**Files:**
- Create: `apps/api/src/__tests__/integration/backupProviderSync.integration.test.ts`

**Interfaces:**
- Consumes: the shared integration harness — `apps/api/src/__tests__/integration/setup.ts` (real `breeze_test` Postgres pool + real Redis, `cleanupDatabase()` TRUNCATEs the tenant roots on every `beforeEach`, `:215-257`); migrations are applied once per invocation by `globalSetup.ts` (`apps/api/vitest.integration.config.ts`). Everything under `src/__tests__/integration/**` is already covered by that config's first glob and excluded from the unit runner (`apps/api/vitest.config.ts:16-17`), so **no config change is needed**.

**DECISION — the stub adapter is installed with `vi.mock` on `registry.ts`, not with a test-only injectable adapter map.** The brief left the choice open. `vi.mock('../../services/backupProviders/registry')` gives the test total control over `listCustomers` / `listDevices` with **zero production surface**; an injectable map would add a mutable global to `registry.ts` that nothing in production writes, and a mutable global adapter table on a multi-tenant integration is a liability in its own right. The same file mocks `credentials.ts` so the suite needs no encryption key in `.env.test` — the ciphertext column holds a placeholder and `decryptProviderCredentials` returns a fixed object. Everything else (`persist`, `mapping`, `deviceMatching`, `alerts`, `alertService`, `eventBus`) runs for real.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/integration/backupProviderSync.integration.test.ts`:

```ts
import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

// Stub the vendor adapter and the credential codec. Everything else — persist,
// mapping, device matching, alerts, alertService, eventBus — runs for real
// against the test Postgres and Redis.
const listCustomers = vi.fn();
const listDevices = vi.fn();
vi.mock('../../services/backupProviders/registry', () => ({
  BACKUP_PROVIDER_KEYS: ['cove'] as const,
  getBackupProvider: () => ({
    key: 'cove',
    label: 'Cove Data Protection',
    credentialsSchema: { parse: (v: unknown) => v },
    testConnection: vi.fn(),
    listCustomers,
    listDevices,
  }),
}));
vi.mock('../../services/backupProviders/credentials', () => ({
  encryptProviderCredentials: vi.fn(() => 'ciphertext'),
  decryptProviderCredentials: vi.fn(() => ({ partnerName: 'p', username: 'u', password: 'x' })),
}));

import { db, withSystemDbAccessContext } from '../../db';
import {
  alerts,
  backupProviderConnections,
  backupProviderCustomers,
  backupProviderDeviceHistory,
  backupProviderDevices,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { getEventBus } from '../../services/eventBus';
import { syncConnectionById } from '../../jobs/backupProviderSync';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  partnerId: string;
  orgId: string;
  deviceId: string;
  connectionId: string;
}

async function seed(unique: string): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({ name: `BP Partner ${unique}`, slug: `bp-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [org] = await db
      .insert(organizations)
      .values({
        currencyCode: 'USD', partnerId: partner!.id, name: `BP Org ${unique}`,
        slug: `bp-org-${unique}`, type: 'customer', status: 'active',
      })
      .returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: org!.id, name: `BP Site ${unique}` }).returning({ id: sites.id });
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org!.id, siteId: site!.id,
        agentId: `bp-agent-${unique}`, hostname: `srv-${unique}`,
        osType: 'windows', osVersion: '2022', architecture: 'x86_64',
        agentVersion: '0.0.0-test', status: 'online',
      })
      .returning({ id: devices.id });
    const [connection] = await db
      .insert(backupProviderConnections)
      .values({
        partnerId: partner!.id, provider: 'cove', name: `BP Conn ${unique}`,
        baseUrl: 'https://api.backup.management/jsonapi',
        credentialsEncrypted: 'ciphertext', vendorRootId: '1000', vendorRootName: 'Root',
        isActive: true, status: 'connected', syncIntervalMinutes: 30,
        showProviderNameInPortal: false,
      })
      .returning({ id: backupProviderConnections.id });

    return {
      partnerId: partner!.id,
      orgId: org!.id,
      deviceId: device!.id,
      connectionId: connection!.id,
    };
  });
}

const customer = (orgId: string) => ({
  vendorCustomerId: 'vc-1',
  name: 'Some Other Name Entirely',
  parentId: '1000',
  level: 'EndCustomer',
  // Exercises the auto_external_code rule: the vendor row carries the Breeze org id.
  externalCode: orgId,
});

const vendorDevice = (over: Record<string, unknown> = {}) => ({
  vendorDeviceId: 'vd-1',
  vendorCustomerId: 'vc-1',
  name: 'SRV-01',
  computerName: null as string | null,
  osType: 'server' as const,
  osVersion: 'Windows Server 2022',
  clientVersion: '24.3',
  macAddresses: [] as string[],
  accountType: 'backup_manager' as const,
  dataSources: ['files'],
  status: 'failed' as const,
  vendorStatusCode: 2,
  lastSessionAt: new Date(),
  lastSuccessAt: null as Date | null,
  lastCompletedAt: null as Date | null,
  selectedBytes: 1024,
  usedBytes: 512,
  errorsCount: 3,
  vendorCreatedAt: null as Date | null,
  vendorExpiresAt: null as Date | null,
  raw: { D09F00: 2 },
  ...over,
});

const capturedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
let unsubscribes: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  capturedEvents.length = 0;
  const bus = getEventBus();
  unsubscribes = [
    bus.subscribe('backup.provider_device_unhealthy', (event) => {
      capturedEvents.push({ type: event.type, payload: event.payload as Record<string, unknown> });
      return Promise.resolve();
    }),
    bus.subscribe('backup.provider_device_recovered', (event) => {
      capturedEvents.push({ type: event.type, payload: event.payload as Record<string, unknown> });
      return Promise.resolve();
    }),
  ];
});

afterEach(() => {
  for (const off of unsubscribes) off();
  unsubscribes = [];
});

describe('backup provider sync (real Postgres + Redis)', () => {
  runDb('customers -> auto-mapping -> devices -> ledger -> (two polls) alert -> cleared -> resolved', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fixture = await seed(unique);
    // The vendor device's name matches the Breeze device's hostname, so the
    // hostname rule links them.
    const deviceName = `srv-${unique}`;

    // ---- poll 1 -------------------------------------------------------
    listCustomers.mockResolvedValue([customer(fixture.orgId)]);
    listDevices.mockResolvedValue([vendorDevice({ name: deviceName })]);
    await syncConnectionById(fixture.connectionId);

    const afterFirst = await withSystemDbAccessContext(async () => {
      const [mapped] = await db
        .select()
        .from(backupProviderCustomers)
        .where(eq(backupProviderCustomers.connectionId, fixture.connectionId));
      const [row] = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, fixture.connectionId));
      const ledger = await db
        .select()
        .from(backupProviderDeviceHistory)
        .where(eq(backupProviderDeviceHistory.providerDeviceId, row!.id));
      const openAlerts = await db.select().from(alerts).where(eq(alerts.orgId, fixture.orgId));
      const [connection] = await db
        .select()
        .from(backupProviderConnections)
        .where(eq(backupProviderConnections.id, fixture.connectionId));
      return { mapped, row, ledger, openAlerts, connection };
    });

    // Auto-mapped by external code, device stored under the mapped org, linked
    // to the Breeze device by hostname, one ledger row for today.
    expect(afterFirst.mapped!.orgId).toBe(fixture.orgId);
    expect(afterFirst.mapped!.mappingSource).toBe('auto_external_code');
    expect(afterFirst.mapped!.deviceCount).toBe(1);
    expect(afterFirst.row!.orgId).toBe(fixture.orgId);
    expect(afterFirst.row!.provider).toBe('cove');
    expect(afterFirst.row!.breezeDeviceId).toBe(fixture.deviceId);
    expect(afterFirst.row!.deviceMatchSource).toBe('auto_hostname');
    expect(afterFirst.ledger).toHaveLength(1);
    expect(afterFirst.ledger[0]!.status).toBe('failed');
    expect(afterFirst.ledger[0]!.observations).toBe(1);
    // Hysteresis: nothing raised on the first observation.
    expect(afterFirst.row!.pendingCondition).toBe('failed');
    expect(afterFirst.openAlerts).toHaveLength(0);
    expect(capturedEvents).toHaveLength(0);
    expect(afterFirst.connection!.lastSyncStatus).toBe('success');
    expect(afterFirst.connection!.lastSyncCustomers).toBe(1);
    expect(afterFirst.connection!.lastSyncDevices).toBe(1);
    expect(afterFirst.connection!.lastSyncLinkedDevices).toBe(1);
    expect(afterFirst.connection!.lastSyncUnmappedDevices).toBe(0);

    // ---- poll 2: same condition -> raise -------------------------------
    await syncConnectionById(fixture.connectionId);

    const afterSecond = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, fixture.connectionId));
      const open = await db
        .select()
        .from(alerts)
        .where(and(eq(alerts.orgId, fixture.orgId), eq(alerts.status, 'active')));
      const ledger = await db
        .select()
        .from(backupProviderDeviceHistory)
        .where(eq(backupProviderDeviceHistory.providerDeviceId, row!.id));
      return { row, open, ledger };
    });

    expect(afterSecond.row!.pendingCondition).toBe('raised:failed');
    expect(afterSecond.open).toHaveLength(1);
    expect(afterSecond.open[0]!.deviceId).toBe(fixture.deviceId);
    expect(afterSecond.open[0]!.severity).toBe('high');
    expect(afterSecond.open[0]!.title).toContain('Backup failed on');
    expect(afterSecond.open[0]!.context).toMatchObject({
      source: 'backup_provider',
      connectionId: fixture.connectionId,
      providerDeviceId: afterSecond.row!.id,
      condition: 'failed',
    });
    // Same UTC day, second poll: one ledger row, two observations.
    expect(afterSecond.ledger).toHaveLength(1);
    expect(afterSecond.ledger[0]!.observations).toBe(2);
    expect(capturedEvents.filter((e) => e.type === 'backup.provider_device_unhealthy')).toHaveLength(1);
    expect(capturedEvents[0]!.payload).toMatchObject({
      connectionId: fixture.connectionId,
      providerKey: 'cove',
      orgId: fixture.orgId,
      deviceId: fixture.deviceId,
      condition: 'failed',
    });

    // ---- poll 3: same condition again -> no duplicate -------------------
    capturedEvents.length = 0;
    await syncConnectionById(fixture.connectionId);
    const afterThird = await withSystemDbAccessContext(() => db
      .select()
      .from(alerts)
      .where(and(eq(alerts.orgId, fixture.orgId), eq(alerts.status, 'active'))));
    expect(afterThird).toHaveLength(1);
    expect(capturedEvents).toHaveLength(0);

    // ---- poll 4: condition clears -> resolve + recovered ----------------
    listDevices.mockResolvedValue([vendorDevice({
      name: deviceName, status: 'completed', vendorStatusCode: 5,
      lastSuccessAt: new Date(), lastCompletedAt: new Date(), errorsCount: 0,
    })]);
    await syncConnectionById(fixture.connectionId);

    const afterFourth = await withSystemDbAccessContext(async () => {
      const all = await db.select().from(alerts).where(eq(alerts.orgId, fixture.orgId));
      const [row] = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, fixture.connectionId));
      return { all, row };
    });
    expect(afterFourth.all).toHaveLength(1);
    expect(afterFourth.all[0]!.status).toBe('resolved');
    expect(afterFourth.all[0]!.resolutionNote).toBe('Condition cleared by provider sync');
    expect(afterFourth.row!.pendingCondition).toBeNull();
    expect(capturedEvents.filter((e) => e.type === 'backup.provider_device_recovered')).toHaveLength(1);
  });

  runDb('a failed vendor enumeration deletes nothing and records the error', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fixture = await seed(unique);
    const deviceName = `srv-${unique}`;

    listCustomers.mockResolvedValue([customer(fixture.orgId)]);
    listDevices.mockResolvedValue([vendorDevice({ name: deviceName })]);
    await syncConnectionById(fixture.connectionId);

    const before = await withSystemDbAccessContext(async () => {
      const rows = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, fixture.connectionId));
      const ledger = await db
        .select()
        .from(backupProviderDeviceHistory)
        .where(eq(backupProviderDeviceHistory.orgId, fixture.orgId));
      return { rows, ledger };
    });
    expect(before.rows).toHaveLength(1);
    expect(before.ledger).toHaveLength(1);

    // The adapter throws on a partial page, so a caught enumeration error must
    // never look like "every device vanished".
    listDevices.mockRejectedValueOnce(new Error('cove page 2 of 5 failed'));
    await expect(syncConnectionById(fixture.connectionId)).rejects.toThrow('cove page 2 of 5 failed');

    const after = await withSystemDbAccessContext(async () => {
      const rows = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, fixture.connectionId));
      const customers = await db
        .select()
        .from(backupProviderCustomers)
        .where(eq(backupProviderCustomers.connectionId, fixture.connectionId));
      const ledger = await db
        .select()
        .from(backupProviderDeviceHistory)
        .where(eq(backupProviderDeviceHistory.orgId, fixture.orgId));
      const [connection] = await db
        .select()
        .from(backupProviderConnections)
        .where(eq(backupProviderConnections.id, fixture.connectionId));
      return { rows, customers, ledger, connection };
    });

    expect(after.rows).toHaveLength(1);
    expect(after.customers).toHaveLength(1);
    expect(after.ledger).toHaveLength(1);
    expect(after.connection!.lastSyncStatus).toBe('error');
    expect(after.connection!.lastSyncError).toContain('cove page 2 of 5 failed');
    // Not a credential problem, so the connection stays syncable.
    expect(after.connection!.status).toBe('connected');
  });

  runDb('a device under an UNMAPPED customer is counted but never stored', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fixture = await seed(unique);

    // No external code and a name that matches no org -> stays unmapped.
    listCustomers.mockResolvedValue([{
      vendorCustomerId: 'vc-9', name: 'Nobody In Breeze', parentId: '1000',
      level: 'EndCustomer', externalCode: null,
    }]);
    listDevices.mockResolvedValue([vendorDevice({ vendorCustomerId: 'vc-9', vendorDeviceId: 'vd-9' })]);
    await syncConnectionById(fixture.connectionId);

    const result = await withSystemDbAccessContext(async () => {
      const rows = await db
        .select()
        .from(backupProviderDevices)
        .where(eq(backupProviderDevices.connectionId, fixture.connectionId));
      const [connection] = await db
        .select()
        .from(backupProviderConnections)
        .where(eq(backupProviderConnections.id, fixture.connectionId));
      return { rows, connection };
    });

    expect(result.rows).toHaveLength(0);
    expect(result.connection!.lastSyncUnmappedCustomers).toBe(1);
    expect(result.connection!.lastSyncUnmappedDevices).toBe(1);
    expect(result.connection!.lastSyncDevices).toBe(0);
  });
});
```

- [ ] **Step 2: Bring up the stack and run the suite**

```
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupProviderSync.integration.test.ts
```

Expected: 3 passing. If `runDb` skips everything, `DATABASE_URL` is not set — `pnpm test-stack up` writes it into the worktree's `.env.test`, which `setup.ts` loads via `./loadEnv`.

- [ ] **Step 3: Run the contract suites this wave could disturb**

W02 adds no table and no column, so none of the registration contracts should move — run them anyway, because "RLS coverage does not imply cascade coverage" and a stale base is how a green PR reddens main:

```
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts && \
npx vitest run --config vitest.config.rls-coverage.ts
```

Expected: all green with no diff attributable to this wave. A failure here means W01's registrations are incomplete — fix it in W01, not by adding an allowlist entry in W02.

- [ ] **Step 4: Tear the stack down**

```
pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```

Nothing Breeze-related belonging to this session may be left running.

- [ ] **Step 5: Commit**

```
git add apps/api/src/__tests__/integration/backupProviderSync.integration.test.ts && \
git commit -m "test(backup-providers): end-to-end sync integration suite (#6010)

Real Postgres + Redis with only the vendor adapter and the credential codec
stubbed: customers -> auto-mapping by external code -> device rows under the
mapped org -> hostname link -> ledger -> two polls to raise an alert -> no
duplicate on the third -> resolve plus a recovered event on the fourth. Also
pins that a failed enumeration deletes nothing and that a device under an
unmapped customer is counted, never stored.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Wave completion checklist

- [ ] `cd apps/api && npx tsc --noEmit -p tsconfig.json` — clean.
- [ ] `pnpm --filter @breeze/api test --run` (note: **no** `--`) — the full unit suite, green.
- [ ] `pnpm test-stack up`, the three integration commands from Task 8 Steps 2-3, `pnpm test-stack down`.
- [ ] `pnpm lint`.
- [ ] Branch is `feature/6008-backup-provider-integration/wave-6010`; PR body contains `Closes #6010`.
- [ ] Because this PR is **stacked on W01**, `gh workflow run CI --ref feature/6008-backup-provider-integration/wave-6010` and check that run — `gh pr checks` reads green on a stacked branch that ran no CI at all.
- [ ] `/pr-review-toolkit:review-pr` pass recorded on the PR (the required check is `CI Success`; no GitHub approval is required).
- [ ] Merge with `gh pr merge <N>` — the merge queue owns the strategy. Never `--admin`.

---

## Self-review

### 1. Spec coverage

**Sync job** (spec, Sync job section):

| Requirement | Task |
|---|---|
| Queue `backup-provider-sync` | W01; reused unchanged (Task 6 Step 1 verifies) |
| Repeatable `sync-all` every 5 minutes | Task 6 (`SYNC_ALL_INTERVAL_MINUTES`, `scheduleRepeatSyncAll`) |
| Scan selects `is_active AND status <> 'reauth_required' AND (last_sync_at IS NULL OR last_sync_at < now() - sync_interval_minutes)` | Task 6 (`processSyncAll` SQL for the flags + `selectDueConnections` for the interval — **DECISION**) |
| Enqueue per row via `addUniqueJob`, jobId `backup-provider-sync-${id}`, `attempts: 3` + exponential backoff | Task 6 (`SYNC_CONNECTION_JOB_OPTS`) |
| "Sync now" coalesces with a scheduled job; only path that retries `reauth_required` | W01's `enqueueBackupProviderSync` uses the same job id; Task 6 Step 1 verifies |
| Phase 1: load + decrypt, short system context, `last_sync_status = 'running'` | Task 6 |
| Phase 2: `runOutsideDbContext(listCustomers + listDevices)`; failure aborts before any write | Task 6; proved by `backupProviderSync.test.ts` and the integration suite |
| Phase 3: one system transaction holding `pg_advisory_xact_lock` | Task 6 |
| 3.1 Re-read `FOR UPDATE`, abort on deleted/deactivated/credentials changed (`updated_at` mismatch) | Task 6 (three abort-guard tests) |
| 3.2 Upsert customers, delete vanished, auto-map, recompute `device_count`; mappings read after the upsert inside the transaction | Task 3 (+ Task 1) |
| 3.3 Upsert devices for mapped customers with the mapping's `org_id`; delete vanished / newly-unmapped; count `last_sync_unmapped_devices` | Task 3 |
| 3.4 Device matching for rows with `device_match_source IS DISTINCT FROM 'manual'` | Task 2 |
| 3.5 Ledger upsert for today, prune > 60 days | Task 3 |
| 3.6 Write `last_sync_*` counters, `status='connected'`, `last_sync_status='success'` | Task 6 |
| Step 4 after commit: alert evaluation; its failure marks `partial` and never fails the job | Task 6 (`marks the sync PARTIAL…`) + Task 5 |
| `reauth` → `UnrecoverableError`, `status='reauth_required'`, `last_sync_status='error'`, Sentry suppressed, no retries | Task 6 |
| Other errors → `last_sync_status='error'`, `last_sync_error` (2000 chars), BullMQ retry | Task 6 (`MAX_SYNC_ERROR_LENGTH`) |
| Sync failures are NOT published as events | Task 6 — no `publishEvent` on any failure path |
| Worker: concurrency 4, `lockDuration` 300 s, `backupProviderSyncWorker` (`placement: 'global'`) next to Huntress | Task 6 Steps 6-8 |
| Deleting a connection resolves its open provider alerts | W01 (route DELETE); Task 7 extends the same treatment to **deactivate** |

**Device matching** (spec, Device matching section):

| Requirement | Task |
|---|---|
| Only `account_type = 'backup_manager'`, no manual link, within the row's `org_id` | Task 2 |
| Candidates = active devices where `lower(hostname)` or `lower(display_name)` = `lower(computer_name)`, falling back to `vendor_device_name` | Task 2 (`MATCH_NAME_SQL`) |
| Exactly one → `auto_hostname` | Task 2 |
| Many → intersect on MAC → exactly one → `auto_mac`; else unlinked + ambiguous | Task 2 |
| The plan identifies the MAC column used by network-discovery correlation | Task 2, "Where Breeze stores device MAC addresses": `device_network.mac_address` (`devices.ts:359`), correlated at `discoveryWorker.ts:1078` and `networkBaseline.ts:479` |
| Auto links re-validated every sync; cleared on rename/delete and step 1 re-runs | Task 2 (statement 1, then the same pass re-links) |
| Manual links validated for existence only | Task 2 (statement 2) |
| Org moves detached synchronously by the move route, never discovered by polling | W01 (D11 `moveOrg.ts` detach); Task 2 adds nothing and relies on it |
| Never link two provider rows to one device; the second stays unlinked | Task 2 (`taken` set + `claimed` + the savepointed 23505 catch) |

**Alerts and events** (spec, Alerts and events section):

| Requirement | Task |
|---|---|
| Evaluated after the inventory commit, serialized by the job id and the advisory lock, linked rows only | Task 5 + Task 6 |
| `createSourcedAlert` with `context = { source, connectionId, providerKey, providerDeviceId, vendorDeviceId, condition }`, `publisher: 'backup-provider-sync'` | Task 5 |
| Six conditions with the spec's severity and title | Task 5 (`PROVIDER_CONDITION_META`, pinned literal-by-literal in `alerts.test.ts`) |
| Two-poll hysteresis via `pending_condition`; clears on the first sync where it no longer holds | Task 5 (`nextConditionState`) |
| Dedupe against open alerts (`active | acknowledged | suppressed`) on source + providerDeviceId + condition | Task 5 (`openByKey`) |
| Resolve through `resolveAlert`'s CAS with "Condition cleared by provider sync" | Task 5 |
| A vanished, unlinked or deactivated row resolves all its provider alerts | Task 5 (`keep` set) + Task 7 (deactivate) |
| Indefinite mutes respected — a suppressed alert is reused, never re-raised | Task 5 (dedupe includes `suppressed`; resolve skips `suppressed_until IS NULL` — **DECISION**) |
| Two events in the union, the constant map and both catalogs | Task 4 (**DECISION**: the catalogs are the union and `EVENT_TYPES`; the test file needs no edit) |
| Published on transitions only, for linked AND unlinked rows, `orgId` = the row's org | Task 5 |
| The notification dispatcher does not subscribe | Task 4 — recorded fact, `eventSubscribers.ts:185-190`, no subscriber added |

**Testing** (spec, W02 bullets):

| Requirement | Task |
|---|---|
| Matching rules: unique / ambiguous / MAC tiebreak / manual precedence | Task 2 (`deviceMatching.test.ts`, 10 cases) |
| Auto-mapping rules | Task 1 (`mapping.test.ts`, 8 cases) |
| Alert hysteresis and dedupe key | Task 5 (`alerts.test.ts` + `alerts.evaluate.test.ts`) |
| Worst-of-day ordering | Task 3 (`LEDGER_STATUS_SEVERITY` block, incl. the 100-pair agreement with `worstBackupStatus`) |
| `eventBus.types.test.ts` catalogs | Task 4 Step 4 |
| Integration: sync end-to-end with a stubbed adapter — customers → mapping → devices → ledger → two polls → alert create → auto-resolve | Task 8 case 1 |
| Integration: a failed enumeration deletes nothing | Task 8 case 2 |
| `backupProviderSync.test.ts` — scan selection incl. reauth exclusion, phase ordering, abort on changed `updated_at`, partial marking when alerts fail | Task 6 |
| `persist.test.ts` — upsert / delete / re-home / unmapped skip / ledger worst-of-day / prune | Task 3 |
| "no writes on adapter failure" | Task 6 (`does not persist anything when the vendor enumeration fails`) + Task 8 case 2 — **DECISION**: it is a phase-ordering property, so it is tested where the adapter lives, not in `persist.test.ts` |

`reauth` exclusion from the scan is covered by the SQL predicate in `processSyncAll` (`ne(status, 'reauth_required')`) rather than by `selectDueConnections`, which only sees already-filtered rows. That predicate is asserted in the integration suite indirectly (a `reauth_required` connection never syncs) — if a stronger guarantee is wanted later, the cheapest addition is one more `runDb` case that flips `status` and asserts `processSyncAll` queues nothing. Noted, not added: the brief scopes W02's unit test to "scan selection incl. reauth exclusion", which the SQL predicate plus its inline comment satisfy, and a mocked-`db` assertion of a `where()` argument would be vacuous.

### 2. Placeholder scan

No "TBD", "TODO", "implement later", "add appropriate error handling", "add validation", "write tests for the above" or "similar to Task N" appears in any step. Every code step contains the code. The three conditional branches in Task 7 Step 1 are a documented fork on a verifiable W01 fact with the full implementation given for each branch, not deferred work.

### 3. Type consistency

- `ProviderSyncTx` is defined once (`persist.ts`) and imported by `mapping.ts`, `deviceMatching.ts`.
- `persistVendorSnapshot(tx, connection, snapshot, options?)` — `SyncCounters` field names (`customers`, `unmappedCustomers`, `devices`, `unmappedDevices`, `linked`, `ambiguous`) are identical in Task 3's return, Task 6's counter write and Task 6's test fixture.
- `matchProviderDevices(tx, connectionId) → { linked, ambiguous }` — identical in Task 2, Task 3's call site and the plan index.
- `autoMapCustomers(tx, connectionId, partnerId) → Promise<number>` — identical in Task 1, Task 3's call site and the plan index.
- `evaluateProviderAlerts(connectionId, options?) → { raised, resolved }` — identical in Task 5, Task 6's call site and the plan index (the optional `options` preserves the index's single-argument contract).
- `syncConnectionById(connectionId, options?) → Promise<void>` — matches the plan index's `Promise<void>`; the optional `{ isFinalAttempt }` mirrors `syncIntegrationById`'s #1736 argument and preserves the index signature.
- `BACKUP_PROVIDER_ALERT_SOURCE = 'backup_provider'` and publisher `'backup-provider-sync'` — as the plan index states, asserted in `alerts.test.ts`.
- Event type strings, constant names and payload keys are byte-identical to the plan index's Events section.
- Worker registry entry, readiness-manifest initializer and `attachWorkerObservability` name are all `backupProviderSyncWorker`.
