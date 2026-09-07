---
tracking_issue: LanternOps/breeze#5213
---

# Manual Network Asset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Assumed decision (owner may veto in one line).** `discovered_assets.ip_address` becomes **NULLable**, and `discovered_assets_org_ip_unique` becomes **partial** on `WHERE ip_address IS NOT NULL`, so a website / DNS-only target can be a first-class network asset. Two CHECK constraints hold the line the NOT NULL used to hold: non-manual rows must still carry an IP, and every manual row must carry at least one of `ip_address` / `hostname` / `url`. *Rejected alternative:* keep `ip_address NOT NULL` and resolve the hostname at create time — rejected because a website's A record is not stable, the row goes stale silently, and a stale IP would then collide with a real host on the next scan. **If the owner vetoes, the whole plan collapses to W01 minus the nullability change plus an IP-required create form; W03 (website/URL targets) becomes impossible and should be closed.**

**Goal:** Let an MSP hand-enter a network asset — including an IP-less website/URL target — as a real `discovered_assets` row (`source = 'manual'`) that inherits every network-device behaviour: the unified Devices list, monitors on the poll cycle, alerts, SNMP, tunnels, topology and the partner inventory API.

**Architecture:** No new table. A manual network asset **is** a `discovered_assets` row, because every consumer of "a network device" (`routes/monitors.ts`, `routes/snmp.ts`, `routes/monitoring.ts`, `routes/tunnels.ts`, `routes/devices/network.ts`, `routes/partnerApi/inventory.ts`, `services/networkBaseline.ts`, `jobs/monitorWorker.ts`, `jobs/reconcileTopology.ts`) is keyed on that table; a parallel table would need a `source <> 'manual'` guard in every one of them and each omission fails open. The row is born `approval_status = 'approved'`, `type_source = 'manual'`, `source = 'manual'`, `is_online = false`, `last_seen_at = NULL`. Three new pieces of state carry the whole feature: a `source` enum (`scan | unifi | manual`), a nullable `url`, and a relaxed `ip_address`.

**Tech Stack:** PostgreSQL 15+ (partial unique index, `inet`), Drizzle ORM 0.45.2 (`onConflictDoUpdate({ targetWhere })`), Hono + Zod (`zValidator`), Vitest (unit / RLS / integration configs), React islands under Astro, Playwright for e2e.

**Spec:** none — `track:plan`. The issue **LanternOps/breeze#5213** is the spec; the plan comment on it is the approval ask. Scope boundary comes from the approved sibling spec `docs/superpowers/specs/device-lifecycle/2026-09-07-manual-asset-entry-spec.md` (#4622, branch `spec/4622-manual-asset-entry`): **has a network identity (IP, hostname or URL) → here; does not → #4622's `manual_assets` table.** The two link, never merge.

---

## Global Constraints

Exact values, copied from `CLAUDE.md` and from the code cited below. Every task's requirements implicitly include this section.

- **Migration slot: `apps/api/migrations/2026-10-14-100100-discovered-assets-manual-source.sql`.** Newest committed migration on `origin/main` is `2026-10-13-110000-scripts-security-acknowledgement.sql`; #4622's plan takes `2026-10-14-100000-…`. Verify before writing with `ls apps/api/migrations | grep -E '^2026' | sort | tail -3` and take a later slot if something newer has landed. `2026-08-06` is a **closed** date block — never add `-g-` there.
- **Migration content rules.** Idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`), no inner `BEGIN;`/`COMMIT;`, never edit a shipped migration.
- **`SELECT set_config('breeze.scope', 'system', true);` — the canonical top-level form — must appear BEFORE the first `UPDATE` in the file.** `discovered_assets` is `FORCE ROW LEVEL SECURITY`; without it the backfill matches **zero rows silently** on managed Postgres while `RAISE WARNING` prints a truthful-looking `0`. CI's superuser masks this. Enforced by `apps/api/src/db/migrationRlsScope.test.ts` (**Test API**) — do NOT add this file to that test's frozen baseline.
- **Every backfill `UPDATE` is wrapped in `DO $$ … GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE WARNING 'backfilled % …', n; END IF; END $$;`** so the count lands in Postgres logs.
- **Enum values.** `ALTER TYPE public.discovered_asset_type ADD VALUE IF NOT EXISTS 'website';` (and `'service'`). Postgres forbids *using* a value added by `ALTER TYPE … ADD VALUE` inside the transaction that added it, and `autoMigrate` wraps each file in one. Nothing in this migration uses the new values, so **one file is safe** — same reasoning as the header comment of `apps/api/migrations/2026-10-11-160000-device-lifecycle-feature-and-decommissioned-at.sql:9-13`. Do not split, and do not use `-- @no-transaction`.
- **No new table ⇒ no new registration.** `discovered_assets` is already in `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts`), the device cascade lists, and `CORE_TENANT_EXPORT_POLICY`. **But the export-policy row is the one contract that fires on a NEW COLUMN**, so `source` and `url` MUST be bucketed in `apps/api/src/services/tenantExportPolicyRegistry.ts:221` in the SAME PR as the migration. Both `included` — `source` is a three-value classifier (like `type_source`, already `included`), `url` is ordinary customer inventory data and is neither jsonb nor bytea. Enforced by `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts`, **Integration Tests shard only — `pnpm test` does NOT run them.** RLS shape stays #1 (direct `org_id`, policies already in `0001-baseline.sql:15624,16485,17346,18207`); no `rls-coverage.integration.test.ts` change.
- **CI traps.** Every wave PR targets `main` directly. A PR based on a sibling branch runs **no CI at all** (`ci.yml` triggers on `pull_request: branches: [main]`) while `gh pr checks` reads green. `migrationRlsScope.test.ts` and `autoMigrate.test.ts` run in **Test API**; the export-policy and cascade suites run in **Integration Tests**.
- **Running one test file:** `pnpm --filter @breeze/api test --run <path>` — **never** insert `--` before `--run`, and never rely on a trailing-slash directory filter (it silently skips dotted siblings).
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts:44`). UI state goes in `window.location.hash` via `useHashState` (`apps/web/src/lib/useHashState.ts`), never query params.
- **`DeviceClass` stays `"agent" | "network"`.** A manual network asset **is** a network row (`apps/web/src/components/devices/DeviceList.tsx:119-126`). `source` is exposed as a column/badge and a filter field — it is **not** a new class. Do not touch `mergedListFilter.ts`'s `isNetwork` dispatch (`:24`).

---

## Verification notes — four issue claims corrected on re-read

The issue's *Proposed behavior* is directionally right but four statements point at the wrong code. Implementers must follow this section, not the issue text.

1. **`discoveryWorker.ts` has no `ON CONFLICT` on the asset write.** It is a SELECT-then-branch: `existingByIp` map built at `apps/api/src/jobs/discoveryWorker.ts:778`, `UPDATE … WHERE id = existing.id` at `:949-953`, `INSERT` at `:988-1004`. Its only `onConflictDoNothing()` (`:829`) is on an unrelated statement. **The `(org_id, ip_address)` conflict targets that need the partial-index predicate live in `apps/api/src/services/unifi/unifiSyncService.ts:193-196` and `apps/api/src/services/unifi/unifiTelemetryService.ts:115`** — those are the two clauses to change.
2. **The `device_disappeared` guard is already satisfied.** `monitoredAssetConditions` requires `eq(discoveredAssets.isOnline, true)` (`discoveryWorker.ts:784`) and the loop re-checks `asset.isOnline` (`:1199`). A manual row born `is_online = false` can never fire the event. The plan therefore ships the guard as a **regression test plus an explicit `last_seen_at IS NOT NULL` condition** (defence in depth), and makes "the create route must never set `is_online = true`" a hard rule with its own assertion.
3. **"Extend the same guard to `label`" has no target.** The scan worker's `assetData` (`discoveryWorker.ts:906-921`) never writes `label` at all, and UniFi's `enrich` (`unifiSyncService.ts:142-149`) writes `hostname`, not `label`. `label` is already safe. The columns a scan *does* clobber on a manual row are **`hostname`, `manufacturer` and `model`** — that is the guard actually worth adding, and W01 adds it.
4. **Monitors and alerts already work with a NULL IP — no worker change needed.** `createMonitorSchema.target` is caller-supplied free text (`apps/api/src/routes/monitors.ts:230`); the create handler reads only `orgId`/`siteId` off the asset (`:400-409`) and never derives `target` from `ipAddress`. `jobs/monitorWorker.ts:241-267` picks the probe agent purely from `asset.site_id`, and `resolveMonitorAlertDevice` (`:289-318`) from `linkedDeviceId`/`siteId`. Acceptance criteria 2 and 3 are reachable with zero worker edits.

**Three NULL-IP hazards the issue does not mention. All are W01 work.**

| `path:line` | Hazard |
|---|---|
| `apps/api/src/routes/tunnels.ts:535` | `const ip = String(asset.ipAddress);` on a NULL yields the literal string `"null"`, which is then handed to `isTargetBlocked(ip, …)` and on to the agent. Not a crash — a garbage tunnel target. Needs an explicit 400 before this line. |
| `apps/api/src/routes/monitoring.ts:444` | SNMP enable writes `ipAddress: asset.ipAddress ?? ''` into `snmp_devices.ip_address`, which is `varchar NOT NULL` — the empty string passes and the poller targets `''`. Needs a 400 "asset has no IP address" guard. |
| `apps/api/src/routes/devices/network.ts:186` | `.orderBy(desc(discoveredAssets.lastSeenAt), desc(discoveredAssets.id))`. Postgres sorts **NULLs FIRST** on `DESC`, so every never-scanned manual row pins to page 1 of the offset page-walk in `apps/web/src/lib/devicesFetch.ts:194`. Needs `COALESCE(last_seen_at, first_seen_at)`. |
| `apps/api/src/jobs/discoveryWorker.ts:1213` | **Compile break.** `insertDiscoveryChangeEvent({ ipAddress: asset.ipAddress, … })` is typed `typeof networkChangeEvents.$inferInsert`, and `network_change_events.ip_address` is `inet NOT NULL` (`apps/api/src/db/schema/discovery.ts:249`). The moment `discoveredAssets.ipAddress` becomes `string \| null`, this stops type-checking. The runtime path is already unreachable (see Verification note 2) but the type error is not — narrow with `if (!asset.ipAddress) continue;` at the top of the loop body, which also states the guard the issue asked for. |

Three more, benign, recorded so nobody "fixes" them twice:

- `apps/api/src/jobs/reconcileTopology.ts:229` already guards `if (r.ip)`. Safe, no change.
- The partner-export materiality deny-list (`apps/api/migrations/2026-07-20-partner-export-reconstruction-material-state.sql:253`) is a **deny**-list, so a new column defaults to *material*. `source` and `url` genuinely are material — deliberately leave them off it. This fails open (an extra export invalidation), never closed.
- `apps/api/src/services/orgMergeCustomExecutors.ts:186-220` uses `DISCOVERED_ASSET_KEY = ['ip_address']` as the org-merge collision key. `NULL = NULL` is never true, so two IP-less manual assets in the loser and survivor orgs both survive the merge under the survivor — which is the **correct** outcome (they are different assets). No code change; update the stale "IP is this table's natural key" comment, and do not be tempted to add a `url`-based collision key (two orgs legitimately monitoring the same public URL are two assets).

And one honest gap: `apps/api/src/routes/partnerApi/inventory.ts:353-366` hand-enumerates the projection **and** filters `a.asset_type IN ('printer','router','switch','firewall','access_point','nas')`. An IP-bearing manual printer/router satisfies acceptance criterion 1 unchanged; a `website`/`service` row would be invisible there. W03 owns that.

---

## File structure

**W01 — data model and writers**

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-14-100100-discovered-assets-manual-source.sql` | *Create.* Enum values, `discovered_asset_source` type, `source` + `url` columns, backfill, `ip_address` DROP NOT NULL, partial unique index swap, two CHECKs. |
| `apps/api/src/db/schema/discovery.ts` | *Modify* (`:23-36`, `:129-172`). New enum export, two columns, `ipAddress` no longer `.notNull()`, `uniqueIndex(...).where(...)`. |
| `apps/api/src/services/tenantExportPolicyRegistry.ts:221` | *Modify.* Add `"source"`, `"url"` to `discovered_assets` `included`. |
| `apps/api/src/jobs/discoveryWorker.ts` | *Modify* (`:906-921`, `:949-953`, `:988-1004`, `:780-785`). Stamp `source: 'scan'` on insert; guard `hostname`/`manufacturer`/`model` on manual rows; add the `last_seen_at IS NOT NULL` disappeared condition. |
| `apps/api/src/services/unifi/unifiSyncService.ts:176-197` | *Modify.* `source: 'unifi'` on the INSERT side; `targetWhere` on the conflict target. |
| `apps/api/src/services/unifi/unifiTelemetryService.ts:113-116` | *Modify.* Same two changes. |
| `apps/api/src/routes/tunnels.ts:~530` | *Modify.* 400 when the asset has no IP. |
| `apps/api/src/routes/monitoring.ts:~440` | *Modify.* 400 when SNMP is enabled on an IP-less asset. |
| `apps/api/src/routes/devices/network.ts:186` | *Modify.* NULL-safe ordering. |
| `apps/api/src/jobs/discoveryWorker.manualSource.test.ts` | *Create.* Unit: stamping + the three guards + the disappeared guard. |
| `apps/api/src/services/unifi/unifiSyncService.test.ts` | *Modify in place* (exists). Assert `targetWhere` and `source: 'unifi'`. |
| `apps/api/src/__tests__/integration/manualNetworkAssetScanUpsert.integration.test.ts` | *Create.* Real Postgres: partial index, in-place scan update, CHECKs. |

**W02 — create route and UI**

| File | Responsibility |
|---|---|
| `apps/api/src/routes/devices/schemas.ts` | *Modify* (after `:97`). `createNetworkAssetSchema`, `updateNetworkAssetSchema`. |
| `apps/api/src/routes/devices/network.ts` | *Modify.* `POST /network` next to the existing `GET /network`. |
| `apps/api/src/routes/devices/network.test.ts` | *Modify in place* (exists). |
| `apps/web/src/components/devices/AddNetworkAssetModal.tsx` | *Create.* The form. |
| `apps/web/src/components/devices/DevicesPage.tsx` | *Modify* (`:191`, `:463-506`, `:604-635`, `:1784-1791`, `:1854-1861`). Split menu, hash state, `source` in the transform. |
| `apps/web/src/components/devices/DeviceList.tsx` + `columnVisibility.ts` | *Modify.* `source` on the `Device` type, a network-only `source` column. |
| `apps/web/src/components/devices/mergedListFilter.ts:31-69` | *Modify.* `case 'source':` in `networkFieldValue` only. |
| `apps/web/src/components/monitoring/MonitoringPage.tsx:50-70` | *Modify.* Second entry point. |

**W03 — website/URL targets** (optional, gated on the assumed decision surviving)

| File | Responsibility |
|---|---|
| `apps/api/src/routes/partnerApi/inventory.ts:353-366` | *Modify.* Add `'website','service'` to the type filter; add `url` and `source` to the projection. |
| `apps/web/src/components/devices/AddNetworkAssetModal.tsx` | *Modify.* URL field + `http_check` hand-off. |
| `apps/docs/src/content/docs/features/discovery.mdx` | *Modify.* "Add a network asset manually" section. |
| `e2e-tests/tests/manual-network-asset.spec.ts` | *Create.* |

---

## W01 — Data model, writers, guards

**Model tier: opus.** Migration + multi-tenant column + a unique-index swap under a live upsert path = high blast radius.
**Gating suites:** `pnpm --filter @breeze/api test --run src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts src/jobs/discoveryWorker src/services/unifi/unifiSyncService.test.ts` (Test API) **and** `pnpm --filter @breeze/api test:integration` for `tenant-export-policy`, `tenantExportErasureRoundtrip`, `manualNetworkAssetScanUpsert` (Integration Tests — `pnpm test` does not run these).
**Done when:** `pnpm --filter @breeze/api exec tsc --noEmit` is clean (dropping `.notNull()` flips `ipAddress` to `string | null` repo-wide — the compiler is the enumerator here, and the `discoveryWorker.ts:1213` break above is the one that matters); a `psql` session as `breeze_app` can insert two IP-less rows in the same org (partial index permits it), cannot insert a second row with a duplicate non-NULL IP (23505), cannot insert `source='scan'` with a NULL IP (23514); every existing row has a non-NULL `source`; both export-policy suites are green.

### Task 1: Migration + schema

**Files:**
- Create: `apps/api/migrations/2026-10-14-100100-discovered-assets-manual-source.sql`
- Modify: `apps/api/src/db/schema/discovery.ts:23-36` (enum), `:129-172` (table)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:221`
- Test: `apps/api/src/__tests__/integration/manualNetworkAssetScanUpsert.integration.test.ts`

**Interfaces:**
- Produces: `discoveredAssetSourceEnum` (`pgEnum('discovered_asset_source', ['scan','unifi','manual'])`), `discoveredAssets.source: 'scan' | 'unifi' | 'manual'` (NOT NULL, default `'scan'`), `discoveredAssets.url: string | null`, `discoveredAssets.ipAddress: string | null`. Every later task depends on these names.

- [ ] **Step 1: Confirm the migration slot is still free**

```bash
ls apps/api/migrations | grep -E '^2026' | sort | tail -3
```
Expected: nothing sorting at or after `2026-10-14-100100-`. If there is, bump to the next free `2026-10-14-1002xx-` slot and use that name everywhere below.

- [ ] **Step 2: Write the failing integration test**

Create `apps/api/src/__tests__/integration/manualNetworkAssetScanUpsert.integration.test.ts`. Follow the setup/teardown shape of an existing sibling in that directory (e.g. `automationPoliciesPartnerRls.integration.test.ts`) for the pool, org/site fixtures and `withSystemDbAccessContext`.

```ts
describe('manual network assets — data model', () => {
  it('permits many IP-less rows in one org but still rejects a duplicate IP', async () => {
    await sql`insert into discovered_assets (org_id, site_id, source, url, approval_status, type_source)
              values (${orgId}, ${siteId}, 'manual', 'https://a.example', 'approved', 'manual')`;
    await sql`insert into discovered_assets (org_id, site_id, source, url, approval_status, type_source)
              values (${orgId}, ${siteId}, 'manual', 'https://b.example', 'approved', 'manual')`;
    const rows = await sql`select count(*)::int as n from discovered_assets
                           where org_id = ${orgId} and ip_address is null`;
    expect(rows[0].n).toBe(2);

    await sql`insert into discovered_assets (org_id, site_id, ip_address, source)
              values (${orgId}, ${siteId}, '10.9.9.9', 'scan')`;
    await expect(
      sql`insert into discovered_assets (org_id, site_id, ip_address, source)
          values (${orgId}, ${siteId}, '10.9.9.9', 'scan')`,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects a non-manual row with no IP', async () => {
    await expect(
      sql`insert into discovered_assets (org_id, site_id, source) values (${orgId}, ${siteId}, 'scan')`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a manual row with no identity at all', async () => {
    await expect(
      sql`insert into discovered_assets (org_id, site_id, source, approval_status, type_source)
          values (${orgId}, ${siteId}, 'manual', 'approved', 'manual')`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('backfilled every pre-existing row with a non-null source', async () => {
    const [{ n }] = await sql`select count(*)::int as n from discovered_assets where source is null`;
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @breeze/api test:integration --run src/__tests__/integration/manualNetworkAssetScanUpsert.integration.test.ts`
Expected: FAIL — `column "source" of relation "discovered_assets" does not exist` (42703).

- [ ] **Step 4: Write the migration**

```sql
-- #5213 — manual network assets. A hand-entered `discovered_assets` row that
-- inherits full network-device parity. Three pieces of state:
--
--  1. `source` (scan | unifi | manual) — who wrote the row. Backfilled from the
--     UniFi linkage; everything else is a scan. Every writer stamps it from now
--     on, so the column can never silently regress to a default.
--  2. `url` — a website/SaaS endpoint has no stable IP, so the URL is the
--     identity, not a derived attribute.
--  3. `ip_address` becomes NULLable, and the (org_id, ip_address) unique index
--     becomes partial. Two CHECKs hold the line the NOT NULL used to hold:
--     non-manual rows still require an IP, and a manual row must carry at least
--     one of ip / hostname / url. Without the first CHECK a bug in the scan
--     writer would silently produce identity-less rows that the partial index
--     can no longer deduplicate.
--
-- Nothing below USES the new enum values, so ALTER TYPE ... ADD VALUE is safe in
-- this single transaction-wrapped file — same reasoning as
-- 2026-10-11-160000-device-lifecycle-feature-and-decommissioned-at.sql:9-13.

ALTER TYPE public.discovered_asset_type ADD VALUE IF NOT EXISTS 'website';
ALTER TYPE public.discovered_asset_type ADD VALUE IF NOT EXISTS 'service';

DO $$ BEGIN
  CREATE TYPE public.discovered_asset_source AS ENUM ('scan', 'unifi', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.discovered_assets
  ADD COLUMN IF NOT EXISTS source public.discovered_asset_source;
ALTER TABLE public.discovered_assets
  ADD COLUMN IF NOT EXISTS url text;

-- REQUIRED before the first UPDATE: discovered_assets is FORCE ROW LEVEL
-- SECURITY and migrations run as an unprivileged role on managed Postgres,
-- where a context-less UPDATE matches ZERO rows silently. CI's superuser masks
-- this, so the elevation must live here, not be discovered in production.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE n integer;
BEGIN
  UPDATE public.discovered_assets a
     SET source = 'unifi'
   WHERE a.source IS NULL
     AND (a.detected_type_source = 'unifi_controller'
          OR EXISTS (SELECT 1 FROM public.unifi_devices u
                      WHERE u.discovered_asset_id = a.id));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled % discovered_assets rows to source=unifi', n; END IF;
END $$;

DO $$
DECLARE n integer;
BEGIN
  UPDATE public.discovered_assets SET source = 'scan' WHERE source IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled % discovered_assets rows to source=scan', n; END IF;
END $$;

ALTER TABLE public.discovered_assets ALTER COLUMN source SET DEFAULT 'scan';
ALTER TABLE public.discovered_assets ALTER COLUMN source SET NOT NULL;

ALTER TABLE public.discovered_assets ALTER COLUMN ip_address DROP NOT NULL;

-- Index swap. Same NAME so the Drizzle schema stays drift-free; the DROP is
-- guarded on indpred so re-applying is a true no-op rather than a rebuild.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
              WHERE c.relname = 'discovered_assets_org_ip_unique' AND i.indpred IS NULL) THEN
    DROP INDEX public.discovered_assets_org_ip_unique;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS discovered_assets_org_ip_unique
  ON public.discovered_assets (org_id, ip_address)
  WHERE ip_address IS NOT NULL;

ALTER TABLE public.discovered_assets
  DROP CONSTRAINT IF EXISTS discovered_assets_scan_requires_ip_chk;
ALTER TABLE public.discovered_assets
  ADD CONSTRAINT discovered_assets_scan_requires_ip_chk
  CHECK (source = 'manual' OR ip_address IS NOT NULL);

ALTER TABLE public.discovered_assets
  DROP CONSTRAINT IF EXISTS discovered_assets_manual_identity_chk;
ALTER TABLE public.discovered_assets
  ADD CONSTRAINT discovered_assets_manual_identity_chk
  CHECK (source <> 'manual'
         OR ip_address IS NOT NULL OR hostname IS NOT NULL OR url IS NOT NULL);

COMMENT ON COLUMN public.discovered_assets.source IS
  'Who created the row: scan (discovery worker), unifi (controller sync), manual (operator, #5213).';
COMMENT ON COLUMN public.discovered_assets.url IS
  'Website/SaaS endpoint for asset_type website|service. The identity of an IP-less asset.';
```

- [ ] **Step 5: Mirror it in the Drizzle schema**

In `apps/api/src/db/schema/discovery.ts`, add the enum beside the existing ones (`:23-36` block) and change the table (`:129-172`):

```ts
export const discoveredAssetSourceEnum = pgEnum('discovered_asset_source', [
  'scan',
  'unifi',
  'manual'
]);
```

```ts
  // NULLable since #5213: a website/DNS-only manual asset has no stable IP.
  // Uniqueness is now enforced by a PARTIAL index (see below), and two CHECK
  // constraints keep the old guarantee for scan/unifi rows.
  ipAddress: inet('ip_address'),
  // …
  source: discoveredAssetSourceEnum('source').notNull().default('scan'),
  url: text('url'),
}, (table) => ({
  orgIpUnique: uniqueIndex('discovered_assets_org_ip_unique')
    .on(table.orgId, table.ipAddress)
    .where(sql`${table.ipAddress} is not null`)
}));
```

Add `sql` to the `drizzle-orm` import in that file if it is not already there.

- [ ] **Step 6: Bucket the new columns in the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts:221`, append `"source","url"` to the `included` array of the `discovered_assets` entry. Neither is jsonb/bytea and neither matches `SUSPICIOUS_NAME_PARTS`, so `included` — not `reviewedIncluded`, not `excludedOpen`.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
pnpm --filter @breeze/api test --run src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
pnpm --filter @breeze/api test:integration --run src/__tests__/integration/manualNetworkAssetScanUpsert.integration.test.ts
pnpm --filter @breeze/api test:integration --run src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm db:check-drift
```
Expected: all PASS, drift clean.

- [ ] **Step 8: Verify isolation by hand as `breeze_app`**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "insert into discovered_assets (org_id, site_id, source) values ('<foreign-org>','<foreign-site>','manual');"
```
Expected: `new row violates row-level security policy`.

- [ ] **Step 9: Commit**

```bash
git add apps/api/migrations/2026-10-14-100100-discovered-assets-manual-source.sql \
        apps/api/src/db/schema/discovery.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts \
        apps/api/src/__tests__/integration/manualNetworkAssetScanUpsert.integration.test.ts
git commit -m "feat(discovery): add source/url columns and nullable ip_address to discovered_assets (#5213)"
```

### Task 2: Writers stamp `source`, and the partial index keeps the UniFi upserts valid

**Files:**
- Modify: `apps/api/src/jobs/discoveryWorker.ts:988-1004`
- Modify: `apps/api/src/services/unifi/unifiSyncService.ts:176-197`
- Modify: `apps/api/src/services/unifi/unifiTelemetryService.ts:113-116`
- Test: `apps/api/src/services/unifi/unifiSyncService.test.ts` (**edit in place — the file exists; do not overwrite it**)

**Interfaces:**
- Consumes: `discoveredAssets.source` from Task 1.
- Produces: nothing new; behavioural only.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe` in `apps/api/src/services/unifi/unifiSyncService.test.ts` (the file already spies on `onConflictDoUpdate` at `:79`):

```ts
it('stamps source=unifi on the insert side', async () => {
  const { db, values } = spyDb([{ id: 'a1' }]);
  await syncUnifiDevice(db, mapping, device);
  expect(values.mock.calls[0]![0]).toMatchObject({ source: 'unifi' });
});

it('carries the partial-index predicate on the conflict target', async () => {
  const { db, onConflictDoUpdate } = spyDb([{ id: 'a1' }]);
  await syncUnifiDevice(db, mapping, device);
  // Without targetWhere, Postgres cannot INFER a partial unique index and the
  // statement fails at runtime with 42P10 — which no compiled-SQL mock catches.
  expect(onConflictDoUpdate.mock.calls[0]![0]).toHaveProperty('targetWhere');
});

it('never resets an existing row\'s source on the conflict branch', async () => {
  const { db, onConflictDoUpdate } = spyDb([{ id: 'a1' }]);
  await syncUnifiDevice(db, mapping, device);
  expect(onConflictDoUpdate.mock.calls[0]![0].set).not.toHaveProperty('source');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @breeze/api test --run src/services/unifi/unifiSyncService.test.ts`
Expected: FAIL — `source` missing from the values object; no `targetWhere` key.

- [ ] **Step 3: Implement**

`unifiSyncService.ts` — in the `.values({...})` block at `:176-192`, beside the existing `typeSource: 'auto'` line and with the same reasoning (insert-side only, never the conflict branch):

```ts
      // Insert side only, exactly like typeSource above: the conflict branch
      // must never reset an existing row's source — a scan-discovered row that
      // UniFi later enriches is still a scan row, and a MANUAL row must never
      // be relabelled 'unifi' by an enrichment pass.
      source: 'unifi',
```

and the conflict target at `:193-196`:

```ts
    .onConflictDoUpdate({
      target: [discoveredAssets.orgId, discoveredAssets.ipAddress],
      // The (org_id, ip_address) unique index is PARTIAL as of #5213. Postgres
      // only infers a partial index when the statement repeats its predicate.
      targetWhere: sql`${discoveredAssets.ipAddress} is not null`,
      set: conflictSet,
    })
```

`unifiTelemetryService.ts:113-116` — the same two changes:

```ts
  const inserted = await db.insert(discoveredAssets)
    .values({ orgId, siteId, ipAddress: ip, source: 'unifi', ...enrich })
    .onConflictDoUpdate({
      target: [discoveredAssets.orgId, discoveredAssets.ipAddress],
      targetWhere: sql`${discoveredAssets.ipAddress} is not null`,
      set: enrich,
    })
    .returning({ id: discoveredAssets.id });
```

`discoveryWorker.ts` — in the net-new `INSERT` at `:988-1004`, beside `typeSource: 'auto'`:

```ts
        source: 'scan',
```

Do **not** add `source` to `assetData` (`:906-921`): that object is spread into the UPDATE branch, and a scan that re-finds a manual row must not relabel it.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @breeze/api test --run src/services/unifi/unifiSyncService.test.ts src/services/unifi/unifiTelemetryService.test.ts src/jobs/discoveryWorker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/discoveryWorker.ts apps/api/src/services/unifi/
git commit -m "feat(discovery): stamp source on every discovered_assets writer (#5213)"
```

### Task 3: Scan guards — a scan must not overwrite an operator's manual row

**Files:**
- Modify: `apps/api/src/jobs/discoveryWorker.ts:939-953` (the UPDATE set), `:780-785` (the disappeared conditions)
- Test: `apps/api/src/jobs/discoveryWorker.manualSource.test.ts` (create)

**Interfaces:**
- Consumes: `discoveredAssets.source` (Task 1), the scan writer shape (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/jobs/discoveryWorker.manualSource.test.ts`. Mock `db` the way `discoveryWorker.test.ts` already does and assert on the **bound SQL of the `set` object**, not on a deep-search of the condition tree — a Drizzle deep-search stub matches a pg enum's `enumValues` and makes the assertion vacuous.

```ts
it('guards hostname, manufacturer and model behind source <> manual', () => {
  const set = buildScanUpdateSet(assetData, null); // exported for test
  for (const col of ['hostname', 'manufacturer', 'model'] as const) {
    const frag = set[col] as SQL;
    // The CASE must name the guarded column, not just be a bare value.
    expect(String(frag)).toContain("source");
    expect(String(frag)).toContain("manual");
  }
});

it('leaves label untouched — the scan never writes it', () => {
  const set = buildScanUpdateSet(assetData, null);
  expect(set).not.toHaveProperty('label');
});

it('excludes never-scanned rows from the disappeared sweep', () => {
  const conds = buildMonitoredAssetConditions(orgId, siteId, []);
  expect(conds.map(String).join(' ')).toContain('last_seen_at');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/api test --run src/jobs/discoveryWorker.manualSource.test.ts`
Expected: FAIL — `buildScanUpdateSet is not a function`.

- [ ] **Step 3: Implement**

Extract the update-set construction at `discoveryWorker.ts:939-953` into an exported `buildScanUpdateSet(assetData, classification)` and, inside it, wrap the three operator-owned columns in the same shape `buildClassificationWrite` uses for `assetType`:

```ts
// A scan re-finding a manual row updates it IN PLACE (one identity, no
// duplicate — that is the whole point of keeping the (org_id, ip_address)
// index), but it must not overwrite what the operator typed. asset_type is
// already covered by type_source = 'manual' (discoveredAssetClassification.ts:136).
// hostname/manufacturer/model were NOT, and are the fields an operator actually
// fills in on a printer that DNS does not resolve. `label` needs no guard: the
// scan never writes it (assetData has no label key) — do not add one.
for (const col of ['hostname', 'manufacturer', 'model'] as const) {
  const proposed = assetData[col];
  updateSet[col] = sql`case when ${discoveredAssets.source} = 'manual'
                            then ${discoveredAssets[col]}
                            else ${proposed} end`;
}
```

Then extract `buildMonitoredAssetConditions(orgId, siteId, subnets)` from `:780-792` and add one condition:

```ts
  // Defence in depth. The is_online = true condition below ALREADY excludes a
  // never-scanned manual row (born is_online = false), so this is belt and
  // braces — but it is the condition that states the intent, and it survives
  // someone "helpfully" defaulting is_online to true later. The create route
  // must never set is_online; the route test asserts that.
  isNotNull(discoveredAssets.lastSeenAt),
```

Then narrow the type at the top of the disappeared loop body (`:1198`), which is **required to compile** — `insertDiscoveryChangeEvent` at `:1213` is typed `typeof networkChangeEvents.$inferInsert` and `network_change_events.ip_address` is `inet NOT NULL` (`schema/discovery.ts:249`), so passing a `string | null` is a type error:

```ts
    for (const asset of monitoredExistingAssets) {
      // network_change_events.ip_address is inet NOT NULL. An IP-less asset can
      // never legitimately reach here (it cannot have been "seen" by an IP
      // scan), so this narrows the type AND states the guard.
      if (!asset.ipAddress) continue;
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @breeze/api test --run src/jobs/discoveryWorker`
Expected: PASS (all three `discoveryWorker*` files, including the pre-existing ones).

- [ ] **Step 5: Add the real-Postgres proof**

Append to `manualNetworkAssetScanUpsert.integration.test.ts`:

```ts
it('a scan of a manual row\'s IP updates in place and preserves operator fields', async () => {
  const id = await insertManualAsset({ ipAddress: '10.4.4.4', label: 'Warehouse printer',
                                       hostname: 'wh-print', assetType: 'printer' });
  await processDiscoveryResults({ orgId, siteId, jobId, hosts: [
    { ip: '10.4.4.4', hostname: 'scanner-guess', mac: 'aa:bb:cc:dd:ee:ff' },
  ]});
  const [row] = await sql`select * from discovered_assets where org_id = ${orgId} and ip_address = '10.4.4.4'`;
  const [{ n }] = await sql`select count(*)::int as n from discovered_assets
                            where org_id = ${orgId} and ip_address = '10.4.4.4'`;
  expect(n).toBe(1);                       // no duplicate row
  expect(row.id).toBe(id);                 // same identity
  expect(row.source).toBe('manual');       // not relabelled
  expect(row.label).toBe('Warehouse printer');
  expect(row.hostname).toBe('wh-print');   // operator value survives the scan
  expect(row.asset_type).toBe('printer');
  expect(row.last_seen_at).not.toBeNull(); // but liveness DID update
});

it('does not raise device_disappeared for a never-scanned manual IP', async () => {
  await insertManualAsset({ ipAddress: '10.4.4.5' });
  await processDiscoveryResults({ orgId, siteId, jobId, hosts: [{ ip: '10.4.4.6' }] });
  const events = await sql`select * from discovery_change_events
                           where org_id = ${orgId} and event_type = 'device_disappeared'`;
  expect(events).toHaveLength(0);
});
```

- [ ] **Step 6: Run the full gating set**

```bash
pnpm --filter @breeze/api test --run src/jobs/discoveryWorker src/services/unifi src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
pnpm --filter @breeze/api test:integration --run src/__tests__/integration/manualNetworkAssetScanUpsert.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/discoveryWorker.ts apps/api/src/jobs/discoveryWorker.manualSource.test.ts apps/api/src/__tests__/integration/manualNetworkAssetScanUpsert.integration.test.ts
git commit -m "feat(discovery): guard operator-owned fields against scan overwrite (#5213)"
```

### Task 4: NULL-IP safety in the three consumers that assume an IP

**Files:**
- Modify: `apps/api/src/routes/tunnels.ts:~530`
- Modify: `apps/api/src/routes/monitoring.ts:~440`
- Modify: `apps/api/src/routes/devices/network.ts:186`
- Test: `apps/api/src/routes/devices/network.test.ts` (edit in place), plus assertions in the existing `tunnels`/`monitoring` route tests if they exist

- [ ] **Step 1: Write the failing tests**

```ts
// tunnels
it('refuses to open a tunnel to an asset with no IP', async () => {
  const res = await app.request(`/tunnels/asset`, { method: 'POST',
    body: JSON.stringify({ discoveredAssetId: ipLessAssetId, port: 443 }) });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/no IP address/i);
});

// monitoring
it('refuses to enable SNMP on an asset with no IP', async () => {
  const res = await app.request(`/monitoring/assets/${ipLessAssetId}/snmp`, { method: 'PUT', body: … });
  expect(res.status).toBe(400);
});

// network list ordering
it('does not pin never-scanned manual rows to the top of page 1', async () => {
  // one manual row (last_seen_at NULL, first_seen_at oldest) + two scanned rows
  const { data } = await listNetwork();
  expect(data[data.length - 1].id).toBe(manualId);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @breeze/api test --run src/routes/tunnels src/routes/monitoring src/routes/devices/network.test.ts`
Expected: FAIL — 200/201 instead of 400; manual row first in the list.

- [ ] **Step 3: Implement**

`tunnels.ts`, immediately before the existing `const ip = String(asset.ipAddress);` at `:535`:

```ts
    // #5213: ip_address is nullable now. String(null) is the literal "null",
    // which would sail past isTargetBlocked and reach the agent as a garbage
    // target rather than failing loudly here.
    if (!asset.ipAddress) {
      return c.json({ error: 'This asset has no IP address; a tunnel needs one' }, 400);
    }
    const ip = String(asset.ipAddress);
```

`monitoring.ts`, before the `setValues` block at `:441`:

```ts
    // snmp_devices.ip_address is varchar NOT NULL; the old `?? ''` fallback
    // satisfied the constraint and left the poller aimed at an empty string.
    if (!asset.ipAddress) {
      return c.json({ error: 'This asset has no IP address; SNMP polling needs one' }, 400);
    }
```
and drop the `?? ''` / `?? 'Unknown'` fallbacks on the next two lines now that the guard is above them.

`routes/devices/network.ts:186`:

```ts
      // COALESCE, not a bare column: Postgres sorts NULLs FIRST on DESC, so a
      // never-scanned manual row (last_seen_at NULL) would otherwise pin to the
      // top of page 1 of the offset walk in web/src/lib/devicesFetch.ts:194.
      .orderBy(desc(sql`coalesce(${discoveredAssets.lastSeenAt}, ${discoveredAssets.firstSeenAt})`),
               desc(discoveredAssets.id))
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @breeze/api test --run src/routes/tunnels src/routes/monitoring src/routes/devices/network.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit and open the W01 PR against `main`**

```bash
git add apps/api/src/routes/
git commit -m "fix(discovery): reject IP-dependent operations on IP-less assets (#5213)"
git push -u origin feature/5213-manual-network-asset/wave-01
gh pr create --base main --title "feat(discovery): manual network asset data model (#5213 W01)" --body "…"
```

---

## W02 — Create route, form, entry points

**Model tier: sonnet.** CRUD route + a form + list plumbing, all on the contract W01 already froze.
**Gating suites:** `pnpm --filter @breeze/api test --run src/routes/devices/network.test.ts`, `pnpm --filter @breeze/web test --run src/components/devices src/lib/__tests__/no-silent-mutations.test.ts`, plus `pnpm lint`.
**Done when:** an operator creates an IP-bearing network asset from the Devices list and it appears in the Network segment of the unified list with a `Manual` source badge, in `GET /devices/network`, and in `GET /partner/inventory`; a site-restricted technician gets 403 for a site outside `allowedSiteIds`; the created row has `approval_status='approved'`, `source='manual'`, `type_source='manual'`, `is_online=false`, `last_seen_at IS NULL`.

### Task 5: `POST /devices/network`

**Files:**
- Modify: `apps/api/src/routes/devices/schemas.ts` (after `listNetworkDevicesSchema`, `:83-97`)
- Modify: `apps/api/src/routes/devices/network.ts`
- Test: `apps/api/src/routes/devices/network.test.ts` (**edit in place**)

**Route placement — decided, with the reason.** The create route goes in `apps/api/src/routes/devices/network.ts` (237 lines), **not** `routes/discovery.ts` (2,247 lines). Three reasons: (a) `network.ts` already owns the org-access narrowing, the `allowedSiteIds` site-scoping block (`:88-118`) and the unified-list DTO (`:196-230`) that the create response must echo — putting the route elsewhere means duplicating all three; (b) `discovery.ts` is the *triage* surface (approve / dismiss / link / pending queue) and a manual asset exists precisely to bypass triage, so the two would read as contradictory neighbours; (c) `network.ts` is well under the 500-line guideline and `discovery.ts` is 4× over it. The route is mounted already — `deviceRoutes.route('/', networkRoutes)` at `routes/devices/index.ts:87`.

**Interfaces:**
- Consumes: `discoveredAssets.source`, `.url`, nullable `.ipAddress` (Task 1).
- Produces: `POST /devices/network` returning the same object shape as the `GET /devices/network` `data[]` element (`network.ts:196-230`) plus `source` and `url`. `createNetworkAssetSchema` and `updateNetworkAssetSchema` exported from `schemas.ts`.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/devices/network.test.ts`:

```ts
describe('POST /devices/network', () => {
  it('creates an approved, manual, never-seen asset', async () => {
    const res = await app.request('/devices/network', { method: 'POST', body: JSON.stringify({
      orgId, siteId, label: 'Warehouse printer', assetType: 'printer', ipAddress: '10.4.4.4',
    })});
    expect(res.status).toBe(201);
    const values = insertSpy.mock.calls[0]![0];
    expect(values).toMatchObject({
      approvalStatus: 'approved', source: 'manual', typeSource: 'manual', isOnline: false,
    });
    // The disappeared-sweep guard depends on this: a manual row must never be
    // born online or with a last_seen_at.
    expect(values.lastSeenAt ?? null).toBeNull();
    expect(values.isOnline).toBe(false);
  });

  it('rejects a payload with no identity at all', async () => {
    const res = await app.request('/devices/network', { method: 'POST',
      body: JSON.stringify({ orgId, siteId, label: 'Nothing' }) });
    expect(res.status).toBe(400);
  });

  it('403s a site-restricted technician outside their allowlist', async () => {
    const res = await appAsSiteTech.request('/devices/network', { method: 'POST',
      body: JSON.stringify({ orgId, siteId: otherSiteId, label: 'x', ipAddress: '10.0.0.9' }) });
    expect(res.status).toBe(403);
  });

  it('409s on a duplicate IP in the same org', async () => {
    insertSpy.mockRejectedValueOnce({ code: '23505' });
    const res = await app.request('/devices/network', { method: 'POST',
      body: JSON.stringify({ orgId, siteId, label: 'dupe', ipAddress: '10.4.4.4' }) });
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/api test --run src/routes/devices/network.test.ts`
Expected: FAIL — 404, no such route.

- [ ] **Step 3: Add the schemas**

In `apps/api/src/routes/devices/schemas.ts`, after `listNetworkDevicesSchema`:

```ts
// POST /devices/network — hand-entered network asset (#5213). At least one
// identity is required; the DB CHECK discovered_assets_manual_identity_chk is
// the backstop, this is the friendly 400.
export const createNetworkAssetSchema = z.object({
  orgId: z.string().guid(),
  siteId: z.string().guid(),
  label: z.string().min(1).max(255),
  assetType: z.enum(DISCOVERED_ASSET_TYPES).default('unknown'),
  ipAddress: z.string().ip().nullish(),
  hostname: z.string().max(255).nullish(),
  url: z.string().url().max(2048).nullish(),
  macAddress: z.string().max(17).nullish(),
  manufacturer: z.string().max(255).nullish(),
  model: z.string().max(255).nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
}).refine(
  (v) => Boolean(v.ipAddress || v.hostname || v.url),
  { message: 'Provide at least one of: IP address, hostname, or URL' },
);

export const updateNetworkAssetSchema = createNetworkAssetSchema
  .innerType()          // .refine() wraps the object; unwrap before .partial()
  .partial()
  .omit({ orgId: true, siteId: true });
```

`DISCOVERED_ASSET_TYPES` is already imported in this file for `listNetworkDevicesSchema`; regenerating it from the enum keeps `website`/`service` in step automatically.

- [ ] **Step 4: Implement the route**

In `network.ts`, directly after the `GET /network` handler, reusing the *same* org/site guard block the list arm uses (`:66-118`) — extract that block into a local `resolveAssetScope(c, orgId, siteId)` helper and call it from both so the two can never drift:

```ts
networkRoutes.post(
  '/network',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  zValidator('json', createNetworkAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const permissions = c.get('permissions') as UserPermissions | undefined;

    if (!auth.canAccessOrg(body.orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }
    if (permissions?.allowedSiteIds && !canAccessSite(permissions, body.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    try {
      const [row] = await db.insert(discoveredAssets).values({
        orgId: body.orgId,
        siteId: body.siteId,
        label: body.label,
        assetType: body.assetType,
        ipAddress: body.ipAddress ?? null,
        hostname: body.hostname ?? null,
        url: body.url ?? null,
        macAddress: body.macAddress ?? null,
        manufacturer: body.manufacturer ?? null,
        model: body.model ?? null,
        notes: body.notes ?? null,
        tags: body.tags,
        source: 'manual',
        // Born approved: a row a human typed has nothing to triage, and the
        // pending queue (routes/discovery.ts:371) must never surface it.
        approvalStatus: 'approved',
        // Pins the type against every classifier, via the existing CASE in
        // services/discoveredAssetClassification.ts:136.
        typeSource: 'manual',
        // NOT negotiable: the disappeared-sweep guard
        // (discoveryWorker.ts:780-792) keys on these two staying false/NULL
        // until a scan actually sees the asset.
        isOnline: false,
        lastSeenAt: null,
      }).returning();
      return c.json(toUnifiedListShape(row!), 201);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return c.json({ error: 'An asset with this IP already exists in this organization' }, 409);
      }
      if ((err as { code?: string }).code === '23514') {
        return c.json({ error: 'Provide at least one of: IP address, hostname, or URL' }, 400);
      }
      throw err;
    }
  },
);
```

Extract the `rows.map(...)` projection at `:196-230` into `toUnifiedListShape(row)` and use it from both handlers. While extracting, make two changes that the list arm needs anyway:

```ts
      // Name precedence: label > hostname > URL > IP. `url` is new (#5213) and
      // is the only identity an IP-less website row has.
      hostname: r.label || r.hostname || r.url || (r.ipAddress ?? ''),
      // A manual asset that no probe has ever reached is not "offline" — that
      // is a claim about reachability we have not made. Matches the
      // status:'unknown' the #4622 manual-asset spec uses.
      status: r.lastSeenAt === null && r.source === 'manual'
        ? ('unknown' as const)
        : r.isOnline ? ('online' as const) : ('offline' as const),
      source: r.source,
      url: r.url ?? null,
```

Add `source` and `url` to the `db.select({...})` projection at `:154-186` so they are available.

While here, extend the four audit `resourceName` fallback chains in `apps/api/src/routes/discovery.ts:1420,1517,1591,1731` (`updated.hostname ?? updated.ipAddress`) and the topology node label at `:1824` (`a.label ?? a.hostname ?? a.ipAddress ?? a.id`) to include `label` and `url`. Without it a website asset produces an audit entry with no `resourceName` and a topology node labelled with a raw UUID. Cosmetic, one line each, cheap to do now and annoying to find later.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @breeze/api test --run src/routes/devices/network.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/devices/
git commit -m "feat(devices): POST /devices/network create route for manual network assets (#5213)"
```

### Task 6: The form and the two entry points

**Files:**
- Create: `apps/web/src/components/devices/AddNetworkAssetModal.tsx`
- Create: `apps/web/src/components/devices/AddNetworkAssetModal.test.tsx`
- Modify: `apps/web/src/components/devices/DevicesPage.tsx:191`, `:604-635`, `:1784-1791`, `:1854-1861`
- Modify: `apps/web/src/components/devices/DeviceList.tsx:126-139`, `:320-323`, `:556-644`; `apps/web/src/components/devices/columnVisibility.ts:9-88`
- Modify: `apps/web/src/components/devices/mergedListFilter.ts:31-69`
- Modify: `apps/web/src/components/monitoring/MonitoringPage.tsx:50-70`

**Interfaces:**
- Consumes: `POST /devices/network` and the `source`/`url`/`status:'unknown'` DTO fields from Task 5.
- Produces: `<AddNetworkAssetModal isOpen onClose orgId siteId onCreated />`.

- [ ] **Step 1: Write the failing test**

`AddNetworkAssetModal.test.tsx`:

```tsx
it('submits through runAction and posts source-free payload to /devices/network', async () => {
  render(<AddNetworkAssetModal isOpen onClose={vi.fn()} orgId="o1" onCreated={vi.fn()} />);
  await userEvent.type(screen.getByTestId('asset-label'), 'Warehouse printer');
  await userEvent.type(screen.getByTestId('asset-ip'), '10.4.4.4');
  await userEvent.click(screen.getByTestId('asset-submit'));
  expect(fetchWithAuth).toHaveBeenCalledWith('/devices/network',
    expect.objectContaining({ method: 'POST' }));
});

it('blocks submit until one of IP / hostname / URL is present', async () => {
  render(<AddNetworkAssetModal isOpen onClose={vi.fn()} orgId="o1" onCreated={vi.fn()} />);
  await userEvent.type(screen.getByTestId('asset-label'), 'Nothing');
  expect(screen.getByTestId('asset-submit')).toBeDisabled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/web test --run src/components/devices/AddNetworkAssetModal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the modal**

Mirror `apps/web/src/components/discovery/AssetDetailModal.tsx` (same `Dialog` shell from `../shared/Dialog`, same field vocabulary) but POST instead of PATCH. Fields: Org (pre-filled from page context), Site (required; defaults when the org has exactly one), Label, Asset type (the `discovered_asset_type` enum with the same icons the Type column uses), IP address, Hostname, URL, MAC, Manufacturer, Model, Tags, Notes. Submit via `runAction`:

```tsx
await runAction({
  request: () => fetchWithAuth('/devices/network', {
    method: 'POST', body: JSON.stringify(payload),
  }),
  successMessage: t('addNetworkAsset.toasts.created'),
  errorFallback: t('addNetworkAsset.toasts.createFailed'),
});
```

Mandatory per `CLAUDE.md`; it is also what surfaces the 409 duplicate-IP body. Catch pattern for the caller:

```tsx
if (err instanceof ActionError && err.status === 401) return;
if (!(err instanceof ActionError)) showToast({ type: 'error', … });
```

- [ ] **Step 4: Wire the entry points**

`DevicesPage.tsx` — the header **Add Device** button (`:1784-1791`) becomes a two-item split menu, and the empty-state duplicate (`:1854-1861`) gets the same treatment. This deliberately matches the split menu #4622's spec puts on the same control, so the three "Add …" actions read as one menu:

- *Install agent…* → today's `AddDeviceModal` flow (hash `add-device`)
- *Add network asset…* → new (hash `add-network-asset`)
- *(#4622 adds "Add asset manually…" as a third item — leave room for it.)*

Hash state uses `useHashState<boolean>` exactly like `showAddDevice` at `:191`.

`MonitoringPage.tsx` — an "Add network asset" button in the header row (`:50-55`), rendered only when `activeTab === 'assets'` (`:57-70`), opening the same modal.

`DevicesPage.tsx:604-635` — add `source: d.source` and `url: d.url` to the network transform block.

- [ ] **Step 5: List integration — `source` as a column, NOT a class**

`DeviceList.tsx` — add `source?: 'scan' | 'unifi' | 'manual' | null` to the `Device` type near `manufacturer`/`model` (`:135-139`). Add `'source'` to `COLUMN_IDS` and `COLUMN_LABELS` in `columnVisibility.ts` (opt-in, i.e. **not** in `DEFAULT_VISIBLE_COLUMNS`), to `NETWORK_ONLY_COLUMNS` (`:320-323`) since agent rows have no source, plus a `sortValue` entry and a `columnDefs` cell following the `type` column's network-only pattern. Render `manual` as a badge; `scan`/`unifi` as plain text.

`mergedListFilter.ts` — add **only** `case 'source': return { applicable: true, value: d.source ?? null };` to `networkFieldValue` (`:31-69`). **Do not touch `isNetwork` (`:24`)**, do not add a `DeviceClass` value, do not touch `summarizeHiddenNetworkDevices`. A manual network asset is a network row; treating it as a fourth class would fork every branch in this file for no user-visible gain.

- [ ] **Step 6: Run to verify**

```bash
pnpm --filter @breeze/web test --run src/components/devices src/lib/__tests__/no-silent-mutations.test.ts
pnpm lint
```
Expected: PASS. If `no-silent-mutations` flags the new handler, the fix is to route it through `runAction` — not to add it to `runActionAllowlist.ts`.

- [ ] **Step 7: Commit and open the W02 PR against `main`**

```bash
git add apps/web/src/components/devices/ apps/web/src/components/monitoring/MonitoringPage.tsx
git commit -m "feat(web): add network asset form and Devices/Monitoring entry points (#5213)"
git push -u origin feature/5213-manual-network-asset/wave-02
gh pr create --base main --title "feat(devices): create a manual network asset (#5213 W02)" --body "…"
```

---

## W03 — Website/URL targets (optional)

**Model tier: sonnet.** Ship only if the assumed decision survives review; it is meaningless under the rejected alternative.
**Gating suites:** `pnpm --filter @breeze/api test --run src/routes/partnerApi`, `pnpm --filter @breeze/web test --run src/components/devices`, `cd e2e-tests && pnpm test manual-network-asset`.
**Done when:** a `website` asset with a URL and no IP is created from the UI, an `http_check` monitor attached to it reports status in the Devices list, and the row appears in `GET /partner/inventory`.

### Task 7: Website type end to end

**Files:**
- Modify: `apps/api/src/routes/partnerApi/inventory.ts:353-366`
- Modify: `apps/web/src/components/devices/AddNetworkAssetModal.tsx`
- Modify: `apps/docs/src/content/docs/features/discovery.mdx`
- Test: `e2e-tests/tests/manual-network-asset.spec.ts` (create)

- [ ] **Step 1: Write the failing partner-inventory test**

```ts
it('includes website assets in site network equipment', async () => {
  await createManualAsset({ assetType: 'website', url: 'https://shop.example', ipAddress: null });
  const { networkEquipment } = await getSiteInventory(siteId);
  const site = networkEquipment.find((e: any) => e.url === 'https://shop.example');
  expect(site).toBeDefined();
  expect(site.address).toBeNull();   // host(NULL) is NULL, not the string "null"
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @breeze/api test --run src/routes/partnerApi`
Expected: FAIL — `networkEquipment` is empty; the projection filters `asset_type IN ('printer','router','switch','firewall','access_point','nas')`.

- [ ] **Step 3: Implement**

`inventory.ts:353-366` — extend both the projection and the type filter (they are two separate hand-enumerations of the same list; change both or the `Count` disagrees with the array):

```sql
        'id', a.id, 'type', a.asset_type, 'name', COALESCE(a.label, a.hostname, a.url),
        'address', host(a.ip_address), 'url', a.url, 'source', a.source,
        'macAddress', a.mac_address, 'manufacturer', a.manufacturer, 'model', a.model
```
```sql
  AND a.asset_type IN ('printer','router','switch','firewall','access_point','nas','website','service')
```

- [ ] **Step 4: URL hand-off in the form**

In `AddNetworkAssetModal.tsx`, when `assetType` is `website` or `service`: require URL, hide the MAC field, and on success offer "Add an HTTP check" that opens `CreateMonitorForm` with `assetId` = the new row and `defaultTarget` = the URL. No API change is needed — `CreateMonitorForm.tsx:55-58` already exempts `http_check`/`dns_check` from the free-text `target` requirement, and `EnableMonitoringForm.tsx:281-289` already passes an optional `ipAddress` as `defaultTarget`.

- [ ] **Step 5: Docs and e2e**

Add an "Add a network asset manually" section to `apps/docs/src/content/docs/features/discovery.mdx` covering: what a manual asset is, the network-identity rule that separates it from #4622's manual assets, that a later scan updates it in place without duplicating, and that a website asset takes an HTTP check.

Create `e2e-tests/tests/manual-network-asset.spec.ts` querying by `data-testid` only (per `e2e-tests/README.md`): open the Devices page → split menu → Add network asset → fill label + URL + type `website` → submit → assert the row appears in the Network segment with the `Manual` badge and status `Unknown`.

- [ ] **Step 6: Run and commit**

```bash
pnpm --filter @breeze/api test --run src/routes/partnerApi
pnpm --filter @breeze/web test --run src/components/devices
cd e2e-tests && pnpm test manual-network-asset
```

```bash
git commit -m "feat(discovery): website/URL manual network assets (#5213)"
git push -u origin feature/5213-manual-network-asset/wave-03
gh pr create --base main --title "feat(discovery): website/URL network assets (#5213 W03)" --body "…"
```

---

## Self-review

**Issue coverage.** Every *Proposed behavior* bullet maps to a task: new columns + enum + nullable IP + partial index → Task 1; export policy → Task 1 Step 6; writers stamp `source` → Task 2; manual rows never enter the pending queue → Task 5 (`approvalStatus: 'approved'` + the assertion; the queue is a `'pending'` query filter at `routes/discovery.ts:371`, so nothing else leaks); scan respects `type_source='manual'` → already true at `discoveredAssetClassification.ts:136`, extended to hostname/manufacturer/model in Task 3; in-place update, no duplicate → Task 3 Step 5; disappeared guard → Task 3 Steps 3 and 5; NULL-safe `host(ip)` search and ordering → Task 4 (search is already safe: the `ilike` OR at `network.ts:129-136` short-circuits, a NULL arm only fails to *add* a match); create route + form + both entry points → Tasks 5 and 6. Acceptance criteria 1-5 map to Task 5 (list + partner API), Tasks 5-6 (monitoring — no worker change needed, see Verification note 4), Task 7 (website), Task 3 Step 5 (in-place scan), Tasks 1-4 (guards + export policy).

**Deliberately not done.** A per-asset detail *page* for manual assets — `NetworkDeviceDetailPage.tsx` and `/devices/network/:id` already exist and serve them (#1424 owns the wider work). CSV import of network assets. Editing `source` after creation — it is provenance, not a user field.

**Type consistency.** `source` is `'scan' | 'unifi' | 'manual'` in every task; `discoveredAssetSourceEnum` is the only exported enum name; `toUnifiedListShape` and `resolveAssetScope` are introduced in Task 5 and used by both `network.ts` handlers; `buildScanUpdateSet` / `buildMonitoredAssetConditions` are introduced in Task 3 and used only there; `createNetworkAssetSchema` / `updateNetworkAssetSchema` are the only two new Zod exports.

**Placeholder scan.** No TBDs. Every code step carries real code. The one intentionally deferred detail is the PR bodies (`--body "…"`), which the executing agent writes from the wave's own diff.
