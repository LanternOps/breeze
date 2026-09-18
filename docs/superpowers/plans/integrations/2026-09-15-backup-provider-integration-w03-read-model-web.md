---
tracking_issue: LanternOps/breeze#6008
---
# Backup Provider Integration W03: Unified Read Model + Web — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One read model that answers "what is the backup state of every device this caller can see", over first-party `backup_jobs` and third-party `backup_provider_devices` at once, plus the four web surfaces that consume it — the Integrations **Backup** tab, the `/backup` overview in both org and all-organizations mode, the device Backup tab's external card, and the dashboard's coverage/attention panels.

**Architecture:** `services/backupHealthReadModel.ts` runs two independently-ordered leg queries (Breeze devices joined to their newest / newest-restorable `backup_jobs` row; provider devices left-joined to their connection and linked device) and merge-sorts them in JS on `(lower(name), key)`; health, recency and coverage are derived exclusively through W01's shared `deriveBackupHealth`, never re-implemented in SQL. Two pure sibling modules hold everything testable without a database: `backupHealthCursor.ts` (keyset token) and `backupHealthRows.ts` (row assembly, status inversion, history fill, summary fold). The route `GET /backup/health/devices` is a thin scope-resolver over it; `routes/backup/dashboard.ts` consumes the same service for provider-aware coverage. On the web, three integrations components and three backup components render it, all mutations through `runAction`.

**Tech Stack:** Hono + Zod + Drizzle ORM (Postgres), Vitest with the repo's Drizzle chain mocks; Astro + React 19 islands, react-i18next, Tailwind, Vitest + jsdom + Testing Library with `data-testid` selectors.

**Spec:** `docs/superpowers/specs/integrations/2026-09-15-backup-provider-integration-cove-design.md` (approved 2026-09-15). This wave ships the **Unified read model** section in full (including its Routes row for `GET /backup/health` and the stated `GET /backup/dashboard` changes), the **Web UI** section in full, the W03 bullets of **Testing**, and the W03 row of the **Wave outline**. Where this plan is more specific than the spec — or contradicts it because the repo says otherwise — the plan wins and the point is marked **DECISION** inline with the `path:line` that forced it.

**Cross-wave names (from the plan index — do not rename):**

Consumed from W01 (assumed to exist exactly as listed; do not redefine):
- `packages/shared/src/types/backupHealth.ts` / `packages/shared/src/utils/backupHealth.ts`: `EXTERNAL_BACKUP_STATUSES`, `ExternalBackupStatus`, `BackupHealth`, `BackupRecency`, `BACKUP_WARNING_AFTER_HOURS = 24`, `BACKUP_CRITICAL_AFTER_HOURS = 48`, `deriveBackupHealth({ status, lastSuccessAt, errorsCount, now? }) → { health, recency, covered }`, `EXTERNAL_BACKUP_STATUS_SEVERITY`, `worstBackupStatus(a, b)`, `mapBackupJobStatus(jobStatus)`, `BackupHealthRow`, `BackupHealthSummary`, `BackupProviderAlertCondition`.
- The status→bucket grouping the overview bars and the W05 report share: `BACKUP_STATUS_BUCKET_IDS`, `type BackupStatusBucketId = 'no_backups' | 'completed' | 'completed_with_errors' | 'in_progress' | 'unsuccessful' | 'other'`, `BACKUP_STATUS_BUCKET_MEMBERS: Record<BackupStatusBucketId, readonly ExternalBackupStatus[]>` (`unsuccessful = ['failed','over_quota','no_selection','interrupted']`, `other = ['not_started','unknown']`), `bucketForBackupStatus(status)`. **W03 consumes this and never re-declares any part of it** (Task 10).
- `apps/api/src/db/schema/backupProviders.ts`: `backupProviderConnections`, `backupProviderCustomers`, `backupProviderDevices`, `backupProviderDeviceHistory`, `externalBackupStatusEnum`. Device pointer column is **`breezeDeviceId` / `breeze_device_id`**, never `deviceId`.
- `apps/api/src/services/backupProviders/registry.ts`: `BACKUP_PROVIDER_KEYS`, `BackupProviderKey`, `getBackupProvider(key)` (throws on unknown).
- `apps/api/src/routes/backup/providers.ts`: `GET /backup/providers/connections`, `POST /backup/providers/connections`, `PATCH|DELETE /backup/providers/connections/:id`, `POST /backup/providers/connections/:id/test`, `POST /backup/providers/connections/:id/sync`, `GET /backup/providers/connections/:id/customers`, `PUT /backup/providers/customers/:id/mapping`, `GET /backup/providers/devices`, `PUT /backup/providers/devices/:id/link`.

Defined here and consumed verbatim by W04/W05:
- `apps/api/src/services/backupHealthReadModel.ts`: `listBackupHealthRows(scope, opts)`, `summarizeBackupHealth(scope, opts)`, `getProviderCoverageForDevices(orgId, deviceIds)`.
- `apps/api/src/routes/backup/health.ts`, exported as `backupHealthRoutes`.
- `apps/web/src/components/integrations/BackupProvidersIntegration.tsx` (tab id `backup`, label key `integrationsPage.backup`), `BackupProviderConnectionCard.tsx`, `BackupProviderCustomerMapping.tsx`; i18n block `backupProviders.*`.
- `apps/web/src/components/backup/BackupHealthOverview.tsx`, `apps/web/src/components/backup/ExternalBackupCard.tsx`; i18n block `backupHealth.*`.
- `apps/web/src/pages/settings/integrations/backup.astro` → 301 to `/integrations#backup`.

---

## Global Constraints

- **No migration in this wave.** W03 adds no table and no column, therefore **no** `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `orgMergeRegistry` or `rls-coverage.integration.test.ts` allowlist entry. Those all belong to W01. If a task here finds itself wanting a column, stop and raise it against W01 instead of adding one — the export-policy contract fires on a **new column of an already-registered table**, and W03 has no migration slot reserved in the plan index.
- **Never call `withSystemDbAccessContext` or `runOutsideDbContext(() => withSystemDbAccessContext(...))` from anything this wave adds.** Every read runs inside the request transaction that `authMiddleware` opened (`apps/api/src/routes/backup/index.ts:30`), against the RLS-context-aware `db` proxy (`apps/api/src/db/index.ts:1040`). The system-context escalation double-holds a pooled connection under the request's own transaction and bypasses RLS; it is not the sanctioned pattern for an org-XOR-partner read (CLAUDE.md, "Partner-Wide First", step 3).
- **Org tokens cannot read `backup_provider_connections`** — it is partner-axis (RLS shape 3). Every join to it is a `LEFT JOIN` whose NULL result must be interpreted as "active, not stale", never as "unknown, hide the row". Asserted by a test in Task 3.
- **Site is an app-layer axis Postgres RLS does not defend.** Every handler added here must reference `auth.allowedSiteIds` (`apps/api/src/middleware/auth.ts:155`, type `string[] | undefined`, `undefined` = unrestricted, `[]` = restricted to nothing). `apps/api/src/__tests__/helpers/routeScan.ts:233` scans handler bodies for the literal tokens `canAccessSite` / `allowedSiteIds`, and `apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts:286` fails any NEW device-scoped list handler without one.
- **No `Date` objects inside raw `sql` fragments** — pass ISO strings (`toISOString()`) or bind through a Drizzle column. A `Date` in a raw `sql` fragment throws at bind time under postgres.js (repo trap).
- **Every web mutation goes through `runAction`** (`apps/web/src/lib/runAction.ts`). Caller catch pattern is always:
  ```ts
  if (err instanceof ActionError && err.status === 401) return; // auth redirect owns it
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
  ```
  or the `handleActionError(err, fallback)` helper that encodes it (`runAction.ts:130-134`). The three new integrations components go into `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` and the count assertion at `:640` is bumped `133 → 136`; `ExternalBackupCard.tsx` makes it 137.
- **i18n: every new key lands in all 8 locales** — `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/<ns>.json` — **in the same commit as the component that uses it**, with a REAL translation. `apps/web/src/lib/i18n/localeParity.test.ts:457` fails on any key present in `en` and missing elsewhere, and on a differing interpolation-token multiset (`:465`). `apps/web/src/lib/i18n/translationCoverage.test.ts:974` caps exact-English duplicates **per namespace per locale**; a leaf whose whole value is a protected proper noun (`Cove`, `Breeze`) counts against that cap, so after adding keys run the suite and raise the offending `namespaceDuplicateBaselines[locale][ns]` number by exactly the reported delta, with a one-line comment. `apps/web/src/lib/i18n/keyUsage.test.ts:336` requires every literal `t('…')` key to resolve in `en`; a runtime-computed key needs a `/* i18n-dynamic */` marker.
- **i18n block names are fixed by the plan index**, not by the per-component convention: `backupProviders.*` in `integrations.json` is shared by all three integrations components, `backupHealth.*` in `backup.json` by both backup components. Cross-namespace reuse is `t('common:actions.save')` style.
- **Run one API test file** as `cd apps/api && npx vitest run <path>`. **Run one web test file** as `cd apps/web && npx vitest run <path>`. **Never** `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--` into argv, vitest stops flag parsing there, `--run` is swallowed as a positional filter and the whole 1,470-file suite runs in watch mode.
- Vitest's path filter is a plain substring match: `npx vitest run src/routes/backup/health` also matches `health.test.ts` siblings but **not** a sibling in another directory; always read the reported file count.
- **Typecheck:** `cd apps/api && pnpm exec tsc --noEmit` and `cd apps/web && pnpm exec astro check` (apps/web has no `typecheck` script; astro check is what CI runs).
- **Integration suites** need `pnpm test-stack up` once for the wave and `pnpm test-stack down` at the end (nothing reaps it). Run as `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`. This wave touches no tenancy DDL, but Task 3's live-DB test proves the org-token LEFT JOIN behaviour that unit mocks cannot.
- **File size:** keep every new file under ~500 lines (CLAUDE.md soft guideline). That is why the read model is three files and the overview is three files; do not merge them back.
- **Branch** `feature/6008-backup-provider-integration/wave-6011`; PR body contains `Closes #6011`. This branch is **stacked on W01**, so `ci.yml`'s `pull_request: branches: [main]` trigger gives it **no CI run** and `gh pr checks` reads green on nothing — dispatch per branch before enqueueing: `gh workflow run CI --ref feature/6008-backup-provider-integration/wave-6011`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

---

## DECISION log (each is expanded inline at the task that carries it)

| # | Decision | Forced by |
|---|---|---|
| D-01 | The route is `GET /backup/health/**devices**`, not `GET /backup/health` | `GET /backup/health` is shipped: `apps/api/src/routes/backup/verification.ts:69`, documented at `apps/docs/src/content/docs/backup/api-reference.mdx:143`, consumed by `apps/web/src/components/backup/BackupVerificationOverview.tsx:90` |
| D-02 | Permission is `PERMISSIONS.BACKUP_READ`, not `ORGS_READ` | Spec says `backup:read`; it exists (`packages/shared/src/constants/permissions.ts:16`) and is seeded (`apps/api/src/db/seed.ts:112`) |
| D-03 | Two ordered leg queries merge-sorted in JS, not one SQL `UNION ALL` | `apps/api/src/routes/incidents.helpers.ts:290-330` shows the ~20 per-leg `::type` casts a union needs; a two-stream merge over the same key returns the identical page |
| D-04 | System scope (`accessibleOrgIds === null`) must pass `?orgId=`, else 400 | `apps/api/src/middleware/auth.ts:118`; matches `resolveScopedOrgId` (`routes/backup/helpers.ts:328`) |
| D-05 | The `health` filter is applied in JS after derivation, behind a bounded over-fetch loop | `deriveBackupHealth` is the single source of truth (plan index); an SQL twin would drift |
| D-06 | Breeze `lastSuccessAt` = `coalesce(completed_at, started_at)` of the newest restorable job | `dashboard.ts:510` uses `completedAt` alone, which reads as "never" for a restorable job that never stamped one |
| D-07 | `onlyWithBackup`: a Breeze row qualifies iff it has ≥1 `backup_jobs` row; a provider row always qualifies | Spec, "rows with any backup evidence, like the Cove email" |
| D-08 | `sources` stays a top-level option; the route exposes it as `?source=` | Spec's read-model signature vs. its route table |
| D-09 | `BackupHealthListOptions.labels: 'vendor' \| 'portal'` added | Spec makes the generic label a portal-only rule; W04 needs the switch |
| D-10 | Two helpers beyond the index — `getFirstPartyCoverageForDevices`, `getProviderAttentionItems` | Spec: the dashboard's overdue + attention changes go "via the read model so the route stays thin" |
| D-11 | Provider attention text falls back to the org name when the customer row is invisible | `backup_provider_customers` is partner-axis; `/backup/dashboard` serves org tokens |
| D-12 | `stale` derived from a NULL-tolerant LEFT JOIN on the connection | Same RLS constraint, read side |
| D-13 | `GET /backup/dashboard` starts **emitting** `overdueDevices` | The web has read `overview.overdueDevices` since forever (`BackupDashboard.tsx:137`) but `dashboard.ts:386-418` never sent it; the spec's "overdue computation uses `covered`" presumes it exists |
| D-14 | One shared `backupProviders` / `backupHealth` i18n block per area, not one per component | Plan index locks the block names |
| D-15 | `BackupDashboard` resolves the all-orgs branch **above** `OrgRequiredGate` | `OrgRequiredGate` renders `OrgRequiredState` for `scope:'all'` (`apps/web/src/components/shared/OrgRequiredGate.tsx:40`), which would hide the very view all-orgs mode exists to show |
| D-16 | The 28-day window is the 28 UTC days ending today, inclusive | Spec calls it a 28-day bar with grey gaps; a fixed inclusive window makes cell `i` mean the same day for every row |
| D-17 | A sixth "Other" status bucket (`not_started` + `unknown`), rendered only when non-zero; the grouping is **defined in `@breeze/shared` by W01** and consumed here | The spec's five Cove-email buckets do not cover all ten enum values, so percentages would not sum to 100%; W05 renders the same buckets, so a second copy would drift |

---

## File structure

| Path | Change | Responsibility |
|---|---|---|
| `apps/api/src/services/backupHealthCursor.ts` | create | `BackupHealthCursor`, `encodeBackupHealthCursor`, `decodeBackupHealthCursor`, `cursorFromRow`, `compareRowKeys` |
| `apps/api/src/services/backupHealthCursor.test.ts` | create | round-trip, rejection of malformed/versioned tokens, total-order comparator |
| `apps/api/src/services/backupHealthRows.ts` | create | pure assembly: `invertBackupJobStatus`, `toBreezeHealthRow`, `toProviderHealthRow`, `isConnectionStale`, `providerLabelFor`, `buildHistoryWindow`, `fillHistory28d`, `mergeSortedRows`, `foldBackupHealthSummary`, `emptyBackupHealthSummary` |
| `apps/api/src/services/backupHealthRows.test.ts` | create | every rule above, incl. the `mapBackupJobStatus` ↔ `invertBackupJobStatus` round trip |
| `apps/api/src/services/backupHealthReadModel.ts` | create | `listBackupHealthRows`, `summarizeBackupHealth`, `getProviderCoverageForDevices`, `getFirstPartyCoverageForDevices`, `getProviderAttentionItems` |
| `apps/api/src/services/backupHealthReadModel.test.ts` | create | scope/site/filter predicates, the merge + over-fetch loop, NULL-connection tolerance, coverage maps |
| `apps/api/src/__tests__/integration/backupHealthReadModel.integration.test.ts` | create | live-DB: org token sees provider rows but not connections; site restriction drops unlinked rows; two rows for a dual-source device |
| `apps/api/src/routes/backup/health.ts` | create | `GET /backup/health/devices` |
| `apps/api/src/routes/backup/health.test.ts` | create | scope resolution, 403/400, site ceiling, response envelope |
| `apps/api/src/routes/backup/schemas.ts` | modify | add `backupHealthDevicesQuerySchema` (after `backupHealthQuerySchema`, `:222-224`) |
| `apps/api/src/routes/backup/index.ts` | modify | mount `backupHealthRoutes` next to `dashboardRoutes` (`:39`) |
| `apps/api/src/routes/backup/dashboard.ts` | modify | provider-aware `overdueDevices` + provider `attentionItems` |
| `apps/api/src/routes/backup/dashboard.test.ts` | modify | cases for both |
| `apps/web/src/components/integrations/BackupProviderConnectionCard.tsx` | create | one connection: badge, counters, error box, re-auth CTA, Test/Save/Sync/Delete |
| `apps/web/src/components/integrations/BackupProviderConnectionCard.test.tsx` | create | badge states, re-auth CTA, `{success:false}` toast, delete confirm |
| `apps/web/src/components/integrations/BackupProviderCustomerMapping.tsx` | create | mapping grid: org `<select>`, auto badge, "Unmapped (kept)", summary |
| `apps/web/src/components/integrations/BackupProviderCustomerMapping.test.tsx` | create | map/unmap/keep-unmapped PUTs, auto badge, summary line |
| `apps/web/src/components/integrations/BackupProvidersIntegration.tsx` | create | list + add form + partner-scope gate |
| `apps/web/src/components/integrations/BackupProvidersIntegration.test.tsx` | create | load, add, org-scope gate, test-result modal |
| `apps/web/src/components/integrations/IntegrationsPage.tsx` | modify | `backup` tab id, label key, `HardDrive` icon, `tabDocsPaths` entry |
| `apps/web/src/components/integrations/IntegrationsPage.test.tsx` | modify | tab renders the stub; `#backup` deep link |
| `apps/web/src/pages/settings/integrations/backup.astro` | create | 301 → `/integrations#backup` |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | modify | four new `TARGET_GLOBS`, count 133 → 137 |
| `apps/web/src/components/backup/backupHealthBuckets.ts` | create | pure bucket math, label maps, history cell classes |
| `apps/web/src/components/backup/backupHealthBuckets.test.ts` | create | bucket totals, percentages, gap cells |
| `apps/web/src/components/backup/BackupHealthDeviceTable.tsx` | create | the device table |
| `apps/web/src/components/backup/BackupHealthOverview.tsx` | create | banners, two bar groups, filters, fetch, load-more |
| `apps/web/src/components/backup/BackupHealthOverview.test.tsx` | create | buckets, stale banner, unmapped notice, filters, load-more |
| `apps/web/src/components/backup/BackupOverviewContent.tsx` | modify | render the health view above the tiles |
| `apps/web/src/components/backup/BackupDashboard.tsx` | modify | all-orgs branch above `OrgRequiredGate` |
| `apps/web/src/components/backup/BackupDashboard.test.tsx` | modify | `scope:'all'` skips `/backup/dashboard`; `scope:'org'` still calls it |
| `apps/web/src/components/backup/ExternalBackupCard.tsx` | create | device-tab external card + Unlink |
| `apps/web/src/components/backup/ExternalBackupCard.test.tsx` | create | render, empty, unlink PUT |
| `apps/web/src/components/backup/DeviceBackupTab.tsx` | modify | mount the card; extend the empty state |
| `apps/web/src/components/backup/DeviceBackupTab.test.tsx` | modify | card renders above the first-party sections; empty-state copy |
| `apps/web/src/locales/{8}/integrations.json` | modify | `integrationsPage.backup`, `backupProviders.*` |
| `apps/web/src/locales/{8}/backup.json` | modify | `backupHealth.*` |
| `apps/web/src/lib/i18n/translationCoverage.test.ts` | modify | raise `backup.json` / `integrations.json` duplicate baselines by the reported delta |

---

### Task 1: Keyset cursor — `backupHealthCursor.ts`

**Files:**
- Create: `apps/api/src/services/backupHealthCursor.ts`
- Create: `apps/api/src/services/backupHealthCursor.test.ts`

**Interfaces:**

Consumes: nothing (pure module, no repo imports beyond `node:buffer` globals).

Produces:
```ts
export interface BackupHealthCursor { v: 1; n: string; k: string }
export function encodeBackupHealthCursor(c: BackupHealthCursor): string;
export function decodeBackupHealthCursor(token: string | undefined | null): BackupHealthCursor | null;
export function cursorFromRow(row: { key: string; name: string }): BackupHealthCursor;
export function compareRowKeys(a: { key: string; name: string }, b: { key: string; name: string }): number;
export const BACKUP_HEALTH_DEFAULT_LIMIT = 50;
export const BACKUP_HEALTH_MAX_LIMIT = 200;
```

**Design notes (DECISION territory the spec leaves open):**
- The sort key is `(lower(name), key)`, not `(name, key)`. `name` is user-controlled text and Postgres' default collation is not byte-order, so a JS `localeCompare`/`<` on the raw value and an SQL `ORDER BY name` can disagree and make the walk skip or repeat rows. Lower-casing both sides and comparing with `<` (C-like, code-point order via `sql\`... COLLATE "C"\``) makes the two agree exactly. The cursor stores the **already lower-cased** name so the predicate is a straight tuple comparison with no function on the bound side.
- `key` is `'breeze:<device uuid>'` or `'provider:<row uuid>'` (spec's `BackupHealthRow.key`). It is globally unique across both legs, so `(lower(name), key)` is a **total** order — two devices with the same display name never flap between pages.
- The token is base64url JSON with a `v` discriminator, exactly like `apps/api/src/routes/devices/cursor.ts:99-134`, so it is diffable in logs and a future shape change is rejected rather than mis-walked.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/backupHealthCursor.test.ts
import { describe, expect, it } from 'vitest';

import {
  BACKUP_HEALTH_DEFAULT_LIMIT,
  BACKUP_HEALTH_MAX_LIMIT,
  compareRowKeys,
  cursorFromRow,
  decodeBackupHealthCursor,
  encodeBackupHealthCursor,
} from './backupHealthCursor';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const PROVIDER = '22222222-2222-4222-8222-222222222222';

describe('encode/decode round trip', () => {
  it('round-trips a cursor through a base64url token', () => {
    const cursor = { v: 1 as const, n: 'acme-srv01', k: `breeze:${DEVICE}` };
    const token = encodeBackupHealthCursor(cursor);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url: no '+', '/' or '='
    expect(decodeBackupHealthCursor(token)).toEqual(cursor);
  });

  it('lower-cases the name it stores so the SQL predicate needs no function on the bound side', () => {
    expect(cursorFromRow({ key: `breeze:${DEVICE}`, name: 'ACME-SRV01' })).toEqual({
      v: 1,
      n: 'acme-srv01',
      k: `breeze:${DEVICE}`,
    });
  });
});

describe('decodeBackupHealthCursor rejects', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['non-base64url', 'not a token!!'],
    ['valid base64url that is not JSON', Buffer.from('nope', 'utf8').toString('base64url')],
  ])('%s', (_label, token) => {
    expect(decodeBackupHealthCursor(token as string | undefined | null)).toBeNull();
  });

  it('a future version, rather than mis-walking it', () => {
    const token = Buffer.from(JSON.stringify({ v: 2, n: 'a', k: 'breeze:x' }), 'utf8').toString('base64url');
    expect(decodeBackupHealthCursor(token)).toBeNull();
  });

  it('a wrong-shaped key prefix', () => {
    const token = Buffer.from(JSON.stringify({ v: 1, n: 'a', k: 'huntress:x' }), 'utf8').toString('base64url');
    expect(decodeBackupHealthCursor(token)).toBeNull();
  });

  it('a non-string name', () => {
    const token = Buffer.from(JSON.stringify({ v: 1, n: 7, k: `breeze:${DEVICE}` }), 'utf8').toString('base64url');
    expect(decodeBackupHealthCursor(token)).toBeNull();
  });
});

describe('compareRowKeys', () => {
  it('orders by lower-cased name first', () => {
    const a = { key: `breeze:${DEVICE}`, name: 'alpha' };
    const b = { key: `breeze:${PROVIDER}`, name: 'Beta' };
    expect(compareRowKeys(a, b)).toBeLessThan(0);
    expect(compareRowKeys(b, a)).toBeGreaterThan(0);
  });

  it('breaks a name tie on the key, so two identically-named devices never flap', () => {
    const a = { key: `breeze:${DEVICE}`, name: 'SRV01' };
    const b = { key: `provider:${PROVIDER}`, name: 'srv01' };
    // 'breeze:…' < 'provider:…' in code-point order.
    expect(compareRowKeys(a, b)).toBeLessThan(0);
    expect(compareRowKeys(b, a)).toBeGreaterThan(0);
  });

  it('is 0 only for the same row', () => {
    const a = { key: `breeze:${DEVICE}`, name: 'SRV01' };
    expect(compareRowKeys(a, { ...a, name: 'srv01' })).toBe(0);
  });
});

describe('limits', () => {
  it('are the documented page sizes', () => {
    expect(BACKUP_HEALTH_DEFAULT_LIMIT).toBe(50);
    expect(BACKUP_HEALTH_MAX_LIMIT).toBe(200);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/backupHealthCursor.test.ts
```
Expected: `Failed to resolve import "./backupHealthCursor"` — the module does not exist yet.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/backupHealthCursor.ts
/**
 * Keyset cursor for the unified backup-health feed.
 *
 * The feed is a merge of two independently-queried legs (Breeze devices,
 * provider devices), so there is no single base-table primary key to walk.
 * The key is `(lower(name), key)` where `key` is the row's globally unique
 * `'breeze:<uuid>'` / `'provider:<uuid>'` identity — that pair is TOTAL, which
 * matters here: two machines called "SRV01" in different orgs are the everyday
 * case in an MSP fleet, and ordering on the name alone leaves their relative
 * order undefined between two page requests, so a client paging the fleet sees
 * one twice and misses the other.
 *
 * `n` is stored ALREADY LOWER-CASED. Both sides of the keyset predicate then
 * compare `lower(<name expr>)` against a plain bound string under `COLLATE "C"`
 * — byte order in Postgres, code-point order in JS — so the SQL walk and the
 * in-memory merge can never disagree about which row comes next. Comparing raw
 * names would put the two under different collations (the database's, and
 * JavaScript's `<`), which is exactly how a keyset develops a hole.
 */

/** Wire shape of the opaque token. `v` is bumped on an incompatible change;
 *  {@link decodeBackupHealthCursor} rejects an unknown version rather than
 *  silently mis-walking it. */
export interface BackupHealthCursor {
  v: 1;
  /** Last-row name, lower-cased. */
  n: string;
  /** Last-row `BackupHealthRow.key`. */
  k: string;
}

const BASE64URL_TOKEN_RE = /^[A-Za-z0-9_-]{1,4096}$/;
const ROW_KEY_RE = /^(?:breeze|provider):[0-9a-fA-F-]{36}$/;

/** Per-request default page size when the client passes no `limit`. */
export const BACKUP_HEALTH_DEFAULT_LIMIT = 50;
/** Defensive per-response ceiling — one page stays a small JSON body even with
 *  28 history cells and a data-source array on every row. */
export const BACKUP_HEALTH_MAX_LIMIT = 200;

export function encodeBackupHealthCursor(c: BackupHealthCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/**
 * Decode + validate an incoming token. Returns null on ANY malformed input so
 * the route can 400 cleanly on adversarial input instead of throwing a 500.
 */
export function decodeBackupHealthCursor(token: string | undefined | null): BackupHealthCursor | null {
  if (!token) return null;
  if (!BASE64URL_TOKEN_RE.test(token)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.n !== 'string' || p.n.length > 512) return null;
  if (typeof p.k !== 'string' || !ROW_KEY_RE.test(p.k)) return null;
  return { v: 1, n: p.n, k: p.k };
}

/** The cursor that resumes AFTER the given row. */
export function cursorFromRow(row: { key: string; name: string }): BackupHealthCursor {
  return { v: 1, n: row.name.toLowerCase(), k: row.key };
}

/**
 * In-memory twin of the SQL `ORDER BY lower(name) COLLATE "C", key COLLATE "C"`.
 * Sorts ascending. Used to merge the two legs and to slice a batch at the
 * cursor; expressing the order once keeps the merge and the walk aligned.
 */
export function compareRowKeys(
  a: { key: string; name: string },
  b: { key: string; name: string },
): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}
```

- [ ] **Step 4: Run it green**

```bash
cd apps/api && npx vitest run src/services/backupHealthCursor.test.ts
```
Expected: 1 file, 12 tests passing (5 `it.each` rejection cases + 7).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/backupHealthCursor.ts apps/api/src/services/backupHealthCursor.test.ts
git commit -m "$(cat <<'EOF'
feat(backup): keyset cursor for the unified backup-health feed

W03 Task 1. The feed merges two legs, so there is no base-table PK to walk:
the key is (lower(name), key) with key = 'breeze:<uuid>' / 'provider:<uuid>',
which is total. The name is stored lower-cased in the token so the SQL
predicate and the in-memory merge comparator run under the same collation —
a raw-name comparison puts them under two different ones, which is how a
keyset develops a hole.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Pure row assembly — `backupHealthRows.ts`

**Files:**
- Create: `apps/api/src/services/backupHealthRows.ts`
- Create: `apps/api/src/services/backupHealthRows.test.ts`

**Interfaces:**

Consumes (all W01, verbatim from the plan index):
```ts
import {
  deriveBackupHealth, mapBackupJobStatus, worstBackupStatus,
  type BackupHealth, type BackupHealthRow, type BackupHealthSummary,
  type BackupRecency, type ExternalBackupStatus, EXTERNAL_BACKUP_STATUSES,
} from '@breeze/shared';
import { getBackupProvider } from './backupProviders/registry';
```
Also consumes `RESTORABLE_BACKUP_JOB_STATUSES` (`apps/api/src/db/schema/backup.ts:82`) — imported only for the round-trip test, not by the module.

Produces:
```ts
export type BackupJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';
export const GENERIC_PROVIDER_LABEL = 'Managed cloud backup';
export const BACKUP_HISTORY_DAYS = 28;

export interface BreezeLegRow { /* …see Step 3… */ }
export interface ProviderLegRow { /* …see Step 3… */ }
export interface ConnectionFreshness { isActive: boolean | null; lastSyncAt: Date | string | null; syncIntervalMinutes: number | null }

export function invertBackupJobStatus(status: ExternalBackupStatus): { jobStatuses: BackupJobStatus[]; matchNoJobs: boolean };
export function isConnectionStale(c: ConnectionFreshness, now: Date): boolean;
export function providerLabelFor(providerKey: string | null, opts: { portalShowProviderName: boolean; labels: 'vendor' | 'portal' }): string | null;
export function deviceRoleToRowType(role: string | null | undefined): 'workstation' | 'server' | 'unknown';
export function toBreezeHealthRow(row: BreezeLegRow, opts: { now: Date }): BackupHealthRow;
export function toProviderHealthRow(row: ProviderLegRow, opts: { now: Date; labels: 'vendor' | 'portal' }): BackupHealthRow;
export function buildHistoryWindow(now: Date, days?: number): string[];
export function fillHistoryWindow(window: string[], observed: ReadonlyMap<string, ExternalBackupStatus>): Array<{ day: string; status: ExternalBackupStatus | null }>;
export function foldJobsIntoDays(jobs: Array<{ status: BackupJobStatus; at: Date | string | null }>): Map<string, ExternalBackupStatus>;
export function mergeSortedRows<T extends { key: string; name: string }>(left: readonly T[], right: readonly T[], limit: number): T[];
export function emptyBackupHealthSummary(): BackupHealthSummary;
export function foldBackupHealthSummary(rows: readonly BackupHealthRow[]): BackupHealthSummary;
```

**DECISIONS taken here:**
- **D-06** — Breeze `lastSuccessAt` is `coalesce(completed_at, started_at)` of the newest restorable job. `dashboard.ts:510` reads `completedAt` alone; a restorable job that never stamped one would then report "last successful backup: never" for a device that demonstrably has a snapshot, which flips it to `critical` and (via `covered`) into "devices needing backup".
- **D-18** — a **visible** connection with `last_sync_at IS NULL` is **stale**. It is the fail-closed reading of D4's "positive success evidence": we have no evidence any sync completed, so the rows are shown with `health: 'unknown'`, `covered: false` and a "data as of" banner rather than as fresh truth. An **invisible** connection (org token, RLS filtered the row → `isActive === null`) is treated as active and not stale — the org can see its device rows precisely because RLS allowed them, and hiding them for lack of a partner-axis read would make an org token see *less* than the data it owns.
- **D-19** — `BackupHealthRow.osType` is filled from `devices.device_role` (`apps/api/src/db/schema/devices.ts:64`, values from `packages/shared/src/validators/deviceRoles.ts:36`), not from `devices.os_type` (`schema/devices.ts:7`, which is `windows | macos | linux`). The spec's field name says "os" but its value domain (`workstation | server | unknown`) is the device class, and only `device_role` can produce it.
- **D-20** — the 28-day fold takes the **worst** status observed on a day (`worstBackupStatus`), matching the ledger's own rule (spec, `backup_provider_device_history`), so the Breeze leg and the provider leg mean the same thing by the same ordering.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/backupHealthRows.test.ts
import { describe, expect, it } from 'vitest';

import { EXTERNAL_BACKUP_STATUSES, deriveBackupHealth, mapBackupJobStatus } from '@breeze/shared';
import { RESTORABLE_BACKUP_JOB_STATUSES } from '../db/schema/backup';
import {
  BACKUP_HISTORY_DAYS,
  GENERIC_PROVIDER_LABEL,
  buildHistoryWindow,
  deviceRoleToRowType,
  emptyBackupHealthSummary,
  fillHistoryWindow,
  foldBackupHealthSummary,
  foldJobsIntoDays,
  invertBackupJobStatus,
  isConnectionStale,
  mergeSortedRows,
  providerLabelFor,
  toBreezeHealthRow,
  toProviderHealthRow,
  type BackupJobStatus,
  type BreezeLegRow,
  type ProviderLegRow,
} from './backupHealthRows';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ROW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const breezeLeg = (o: Partial<BreezeLegRow> = {}): BreezeLegRow => ({
  key: `breeze:${DEVICE}`,
  orgId: ORG,
  orgName: 'Acme',
  siteId: SITE,
  deviceId: DEVICE,
  name: 'SRV01',
  computerName: 'srv01.acme.local',
  deviceRole: 'server',
  deviceStatus: 'online',
  jobStatus: 'completed',
  lastSessionAt: '2026-09-15T02:00:00.000Z',
  lastSuccessAt: '2026-09-15T02:30:00.000Z',
  totalSize: 1024,
  errorsCount: 0,
  hasJobs: true,
  ...o,
});

const providerLeg = (o: Partial<ProviderLegRow> = {}): ProviderLegRow => ({
  key: `provider:${ROW}`,
  id: ROW,
  orgId: ORG,
  orgName: 'Acme',
  provider: 'cove',
  portalShowProviderName: false,
  name: 'ACME-SRV01',
  computerName: 'srv01',
  osType: 'server',
  accountType: 'backup_manager',
  dataSources: ['files', 'system_state'],
  status: 'completed',
  lastSessionAt: '2026-09-15T01:00:00.000Z',
  lastSuccessAt: '2026-09-15T01:00:00.000Z',
  selectedBytes: 2048,
  usedBytes: 4096,
  errorsCount: 0,
  breezeDeviceId: DEVICE,
  deviceStatus: 'offline',
  deviceSiteId: SITE,
  connectionIsActive: true,
  connectionLastSyncAt: '2026-09-15T11:50:00.000Z',
  connectionSyncIntervalMinutes: 30,
  ...o,
});

describe('invertBackupJobStatus', () => {
  it('round-trips every backup_status value through mapBackupJobStatus', () => {
    const jobStatuses: BackupJobStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled', 'partial'];
    for (const jobStatus of jobStatuses) {
      const external = mapBackupJobStatus(jobStatus);
      expect(
        invertBackupJobStatus(external).jobStatuses,
        `${jobStatus} -> ${external} must invert back`,
      ).toContain(jobStatus);
    }
  });

  it('maps the no-jobs case to matchNoJobs, with no job statuses', () => {
    expect(invertBackupJobStatus('no_backups')).toEqual({ jobStatuses: [], matchNoJobs: true });
  });

  it.each(['over_quota', 'no_selection', 'not_started', 'unknown'] as const)(
    'has no first-party spelling for %s, so it selects nothing',
    (status) => {
      expect(invertBackupJobStatus(status)).toEqual({ jobStatuses: [], matchNoJobs: false });
    },
  );

  it('covers every enum value without throwing', () => {
    for (const status of EXTERNAL_BACKUP_STATUSES) {
      expect(() => invertBackupJobStatus(status)).not.toThrow();
    }
  });

  it('keeps partial (a degraded but restorable run) out of the failed bucket', () => {
    expect(invertBackupJobStatus('failed').jobStatuses).not.toContain('partial');
    expect(invertBackupJobStatus('completed_with_errors').jobStatuses).toContain('partial');
    expect(RESTORABLE_BACKUP_JOB_STATUSES).toContain('partial');
  });
});

describe('isConnectionStale', () => {
  it('is false when the connection row is invisible (org token, RLS filtered it)', () => {
    expect(isConnectionStale({ isActive: null, lastSyncAt: null, syncIntervalMinutes: null }, NOW)).toBe(false);
  });

  it('is true when the connection is deactivated', () => {
    expect(
      isConnectionStale({ isActive: false, lastSyncAt: NOW.toISOString(), syncIntervalMinutes: 30 }, NOW),
    ).toBe(true);
  });

  it('is true when a visible connection has never recorded a sync', () => {
    expect(isConnectionStale({ isActive: true, lastSyncAt: null, syncIntervalMinutes: 30 }, NOW)).toBe(true);
  });

  it('is false inside 2x the interval and true outside it', () => {
    const inside = new Date(NOW.getTime() - 59 * 60_000).toISOString();
    const outside = new Date(NOW.getTime() - 61 * 60_000).toISOString();
    expect(isConnectionStale({ isActive: true, lastSyncAt: inside, syncIntervalMinutes: 30 }, NOW)).toBe(false);
    expect(isConnectionStale({ isActive: true, lastSyncAt: outside, syncIntervalMinutes: 30 }, NOW)).toBe(true);
  });

  it('falls back to a 30-minute interval when the column is null', () => {
    const outside = new Date(NOW.getTime() - 61 * 60_000).toISOString();
    expect(isConnectionStale({ isActive: true, lastSyncAt: outside, syncIntervalMinutes: null }, NOW)).toBe(true);
  });
});

describe('providerLabelFor', () => {
  it('returns the adapter label for the web (vendor mode) regardless of the portal toggle', () => {
    expect(providerLabelFor('cove', { portalShowProviderName: false, labels: 'vendor' })).toBe('Cove Data Protection');
  });

  it('hides the vendor behind the generic label in portal mode when the toggle is off', () => {
    expect(providerLabelFor('cove', { portalShowProviderName: false, labels: 'portal' })).toBe(GENERIC_PROVIDER_LABEL);
    expect(providerLabelFor('cove', { portalShowProviderName: true, labels: 'portal' })).toBe('Cove Data Protection');
  });

  it('falls back to the raw key for an unregistered provider instead of throwing', () => {
    expect(providerLabelFor('veeam', { portalShowProviderName: true, labels: 'vendor' })).toBe('veeam');
  });

  it('is null for a null key', () => {
    expect(providerLabelFor(null, { portalShowProviderName: true, labels: 'vendor' })).toBeNull();
  });
});

describe('deviceRoleToRowType', () => {
  it.each([
    ['workstation', 'workstation'],
    ['server', 'server'],
    ['printer', 'unknown'],
    ['unknown', 'unknown'],
    [null, 'unknown'],
  ])('%s -> %s', (role, expected) => {
    expect(deviceRoleToRowType(role as string | null)).toBe(expected);
  });
});

describe('toBreezeHealthRow', () => {
  it('projects a completed recent run as a healthy, covered Breeze row', () => {
    const row = toBreezeHealthRow(breezeLeg(), { now: NOW });
    expect(row).toMatchObject({
      key: `breeze:${DEVICE}`,
      source: 'breeze',
      providerKey: null,
      providerLabel: null,
      orgId: ORG,
      orgName: 'Acme',
      siteId: SITE,
      deviceId: DEVICE,
      name: 'SRV01',
      computerName: 'srv01.acme.local',
      osType: 'server',
      accountType: 'endpoint',
      status: 'completed',
      health: 'healthy',
      recency: 'under_24h',
      covered: true,
      stale: false,
      selectedBytes: null,
      usedBytes: 1024,
      errorsCount: 0,
      dataSources: [],
      agentOnline: true,
    });
    expect(row.history28d).toEqual([]); // filled by the read model, not here
  });

  it('is status no_backups — never dropped — when the device has no jobs at all', () => {
    const row = toBreezeHealthRow(
      breezeLeg({ jobStatus: null, lastSessionAt: null, lastSuccessAt: null, hasJobs: false, totalSize: null }),
      { now: NOW },
    );
    expect(row.status).toBe('no_backups');
    expect(row.health).toBe('critical');
    expect(row.covered).toBe(false);
    expect(row.lastSuccessAt).toBeNull();
  });

  it('agentOnline is false for any non-online device status, never null when linked', () => {
    expect(toBreezeHealthRow(breezeLeg({ deviceStatus: 'offline' }), { now: NOW }).agentOnline).toBe(false);
  });

  it('serialises timestamps as ISO strings', () => {
    const row = toBreezeHealthRow(breezeLeg({ lastSuccessAt: new Date('2026-09-15T02:30:00.000Z') }), { now: NOW });
    expect(row.lastSuccessAt).toBe('2026-09-15T02:30:00.000Z');
  });
});

describe('toProviderHealthRow', () => {
  it('projects a provider row with its vendor label and linked device', () => {
    const row = toProviderHealthRow(providerLeg(), { now: NOW, labels: 'vendor' });
    expect(row).toMatchObject({
      key: `provider:${ROW}`,
      source: 'provider',
      providerKey: 'cove',
      providerLabel: 'Cove Data Protection',
      deviceId: DEVICE,
      siteId: SITE,
      accountType: 'endpoint',
      status: 'completed',
      covered: true,
      stale: false,
      selectedBytes: 2048,
      usedBytes: 4096,
      dataSources: ['files', 'system_state'],
      agentOnline: false,
    });
  });

  it('has a null siteId and a null agentOnline when unlinked', () => {
    const row = toProviderHealthRow(
      providerLeg({ breezeDeviceId: null, deviceStatus: null, deviceSiteId: null }),
      { now: NOW, labels: 'vendor' },
    );
    expect(row.deviceId).toBeNull();
    expect(row.siteId).toBeNull();
    expect(row.agentOnline).toBeNull();
  });

  it('marks an m365 account with its own accountType', () => {
    expect(toProviderHealthRow(providerLeg({ accountType: 'm365' }), { now: NOW, labels: 'vendor' }).accountType).toBe('m365');
  });

  it('forces health unknown and covered false when the sync is stale, and says so', () => {
    const row = toProviderHealthRow(
      providerLeg({ connectionLastSyncAt: '2026-09-15T09:00:00.000Z' }), // 3h > 2 x 30min
      { now: NOW, labels: 'vendor' },
    );
    expect(row.stale).toBe(true);
    expect(row.health).toBe('unknown');
    expect(row.covered).toBe(false);
    // The raw status and timestamps survive — the UI still shows what was last seen.
    expect(row.status).toBe('completed');
    expect(row.lastSuccessAt).toBe('2026-09-15T01:00:00.000Z');
  });

  it('keeps a critical health when the vendor says failed but a fresh restore point exists', () => {
    const row = toProviderHealthRow(
      providerLeg({ status: 'failed', errorsCount: 3, lastSuccessAt: '2026-09-15T01:00:00.000Z' }),
      { now: NOW, labels: 'vendor' },
    );
    // D4: coverage says "it has a backup", health says "look at it".
    expect(row.health).toBe('critical');
    expect(row.covered).toBe(true);
  });
});

describe('buildHistoryWindow / fillHistoryWindow', () => {
  it('is 28 UTC days ending today, ascending', () => {
    const window = buildHistoryWindow(NOW);
    expect(window).toHaveLength(BACKUP_HISTORY_DAYS);
    expect(window[0]).toBe('2026-08-19');
    expect(window[BACKUP_HISTORY_DAYS - 1]).toBe('2026-09-15');
  });

  it('renders an unobserved day as null rather than dropping the cell', () => {
    const window = ['2026-09-13', '2026-09-14', '2026-09-15'];
    const filled = fillHistoryWindow(window, new Map([['2026-09-14', 'failed' as const]]));
    expect(filled).toEqual([
      { day: '2026-09-13', status: null },
      { day: '2026-09-14', status: 'failed' },
      { day: '2026-09-15', status: null },
    ]);
  });
});

describe('foldJobsIntoDays', () => {
  it('keeps the WORST status observed on a day, so a nightly failure is not laundered by a retry', () => {
    const days = foldJobsIntoDays([
      { status: 'completed', at: '2026-09-14T23:00:00.000Z' },
      { status: 'failed', at: '2026-09-14T01:00:00.000Z' },
      { status: 'completed', at: '2026-09-15T01:00:00.000Z' },
    ]);
    expect(days.get('2026-09-14')).toBe('failed');
    expect(days.get('2026-09-15')).toBe('completed');
  });

  it('ignores a job with no usable timestamp instead of bucketing it into today', () => {
    expect(foldJobsIntoDays([{ status: 'failed', at: null }]).size).toBe(0);
  });
});

describe('mergeSortedRows', () => {
  const r = (name: string, key: string) => ({ name, key });

  it('interleaves two already-sorted legs by (lower(name), key)', () => {
    const left = [r('alpha', 'breeze:1'), r('charlie', 'breeze:3')];
    const right = [r('Bravo', 'provider:2'), r('delta', 'provider:4')];
    expect(mergeSortedRows(left, right, 10).map((x) => x.name)).toEqual(['alpha', 'Bravo', 'charlie', 'delta']);
  });

  it('stops at the limit without consuming the rest', () => {
    const left = [r('a', 'breeze:1'), r('c', 'breeze:3')];
    const right = [r('b', 'provider:2')];
    expect(mergeSortedRows(left, right, 2).map((x) => x.name)).toEqual(['a', 'b']);
  });

  it('handles an empty leg (provider sync not merged yet)', () => {
    const left = [r('a', 'breeze:1')];
    expect(mergeSortedRows(left, [], 10)).toEqual(left);
    expect(mergeSortedRows([], left, 10)).toEqual(left);
  });
});

describe('foldBackupHealthSummary', () => {
  const row = (o: Partial<ReturnType<typeof toBreezeHealthRow>>) =>
    ({ ...toBreezeHealthRow(breezeLeg(), { now: NOW }), ...o }) as ReturnType<typeof toBreezeHealthRow>;

  it('starts from an all-zero shape with every enum key present', () => {
    const empty = emptyBackupHealthSummary();
    expect(empty.endpoints).toEqual({ total: 0, covered: 0, uncovered: 0 });
    expect(Object.keys(empty.byStatus).sort()).toEqual([...EXTERNAL_BACKUP_STATUSES].sort());
    expect(empty.byHealth).toEqual({ healthy: 0, warning: 0, critical: 0, unknown: 0 });
    expect(empty.byRecency).toEqual({ under_24h: 0, under_48h: 0, over_48h: 0, never: 0 });
  });

  it('counts a dual-source device ONCE in endpoints and ORs its coverage', () => {
    const summary = foldBackupHealthSummary([
      row({ key: `breeze:${DEVICE}`, source: 'breeze', deviceId: DEVICE, covered: false, status: 'no_backups', health: 'critical', recency: 'never' }),
      row({ key: `provider:${ROW}`, source: 'provider', deviceId: DEVICE, covered: true, status: 'completed', health: 'healthy', recency: 'under_24h' }),
    ]);
    expect(summary.endpoints).toEqual({ total: 1, covered: 1, uncovered: 0 });
    expect(summary.providerOnly).toBe(0);
    // Both rows still count in the status/health/recency bars — they are row-level facts.
    expect(summary.byStatus.no_backups).toBe(1);
    expect(summary.byStatus.completed).toBe(1);
  });

  it('counts an unlinked provider endpoint under providerOnly, not endpoints', () => {
    const summary = foldBackupHealthSummary([
      row({ key: `provider:${ROW}`, source: 'provider', deviceId: null, accountType: 'endpoint', covered: true }),
    ]);
    expect(summary.endpoints.total).toBe(0);
    expect(summary.providerOnly).toBe(1);
  });

  it('counts m365 accounts under their own denominator and never as endpoints', () => {
    const summary = foldBackupHealthSummary([
      row({ key: `provider:${ROW}`, source: 'provider', deviceId: null, accountType: 'm365', covered: true }),
    ]);
    expect(summary.m365Accounts).toBe(1);
    expect(summary.providerOnly).toBe(0);
    expect(summary.endpoints.total).toBe(0);
  });

  it('keeps uncovered = total - covered', () => {
    const summary = foldBackupHealthSummary([
      row({ key: 'breeze:1', deviceId: '1', covered: true }),
      row({ key: 'breeze:2', deviceId: '2', covered: false }),
      row({ key: 'breeze:3', deviceId: '3', covered: false }),
    ]);
    expect(summary.endpoints).toEqual({ total: 3, covered: 1, uncovered: 2 });
  });
});

describe('derivation is delegated, never re-implemented', () => {
  it('every provider row reports exactly what deriveBackupHealth says', () => {
    for (const status of EXTERNAL_BACKUP_STATUSES) {
      const leg = providerLeg({ status, lastSuccessAt: '2026-09-13T12:00:00.000Z', errorsCount: 2 });
      const expected = deriveBackupHealth({ status, lastSuccessAt: leg.lastSuccessAt, errorsCount: 2, now: NOW });
      const row = toProviderHealthRow(leg, { now: NOW, labels: 'vendor' });
      expect({ health: row.health, recency: row.recency, covered: row.covered }).toEqual(expected);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/backupHealthRows.test.ts
```
Expected: `Failed to resolve import "./backupHealthRows"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/backupHealthRows.ts
/**
 * Pure assembly for the unified backup-health feed.
 *
 * Everything in this file is I/O-free so the rules that decide what a
 * technician is told about a customer's backups are testable without a
 * database. The queries live in backupHealthReadModel.ts; the health VERDICT
 * lives in @breeze/shared's deriveBackupHealth and is never re-derived here —
 * a second implementation is how "protected" and "critical" drift apart
 * between the overview, the portal and the posture report.
 */

import {
  deriveBackupHealth,
  mapBackupJobStatus,
  worstBackupStatus,
  EXTERNAL_BACKUP_STATUSES,
  type BackupHealthRow,
  type BackupHealthSummary,
  type ExternalBackupStatus,
} from '@breeze/shared';

import { getBackupProvider } from './backupProviders/registry';

export type BackupJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';

/** What a customer is told in the portal when the connection's
 *  `show_provider_name_in_portal` toggle is off (spec D5). */
export const GENERIC_PROVIDER_LABEL = 'Managed cloud backup';

/** Width of the observed-health bar, in whole UTC days ending today. */
export const BACKUP_HISTORY_DAYS = 28;

/** Fallback poll cadence when a connection row carries no interval. Mirrors
 *  `backup_provider_connections.sync_interval_minutes DEFAULT 30`. */
const DEFAULT_SYNC_INTERVAL_MINUTES = 30;

// ── Leg row shapes (what the two queries in the read model select) ──────────

export interface BreezeLegRow {
  key: string;
  orgId: string;
  orgName: string;
  siteId: string | null;
  deviceId: string;
  name: string;
  computerName: string | null;
  deviceRole: string | null;
  deviceStatus: string;
  /** Status of the device's newest RUN (latestBackupRunOrderBy), null when it has none. */
  jobStatus: BackupJobStatus | null;
  lastSessionAt: Date | string | null;
  /** coalesce(completed_at, started_at) of the newest RESTORABLE run (D-06). */
  lastSuccessAt: Date | string | null;
  /** backup_jobs.total_size of the newest run — the closest first-party analogue
   *  of the vendor's "used storage". */
  totalSize: number | string | null;
  errorsCount: number | null;
  hasJobs: boolean;
}

export interface ProviderLegRow {
  key: string;
  id: string;
  orgId: string;
  orgName: string;
  provider: string;
  portalShowProviderName: boolean;
  name: string;
  computerName: string | null;
  osType: 'workstation' | 'server' | 'unknown';
  accountType: 'backup_manager' | 'm365' | 'unknown';
  dataSources: string[];
  status: ExternalBackupStatus;
  lastSessionAt: Date | string | null;
  lastSuccessAt: Date | string | null;
  selectedBytes: number | string | null;
  usedBytes: number | string | null;
  errorsCount: number;
  breezeDeviceId: string | null;
  /** From the LEFT JOIN on devices — null when the row is unlinked. */
  deviceStatus: string | null;
  deviceSiteId: string | null;
  /** From the LEFT JOIN on backup_provider_connections. NULL means the row was
   *  invisible to this caller (partner-axis RLS under an org token), NOT that
   *  the connection is inactive — see isConnectionStale. */
  connectionIsActive: boolean | null;
  connectionLastSyncAt: Date | string | null;
  connectionSyncIntervalMinutes: number | null;
}

export interface ConnectionFreshness {
  isActive: boolean | null;
  lastSyncAt: Date | string | null;
  syncIntervalMinutes: number | null;
}

// ── Small shared helpers ───────────────────────────────────────────────────

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** UTC calendar day of a timestamp, as `YYYY-MM-DD`. */
function utcDay(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

// ── Status inversion (external status -> first-party job statuses) ──────────

/**
 * The inverse of {@link mapBackupJobStatus}, so `?status=` can filter the
 * Breeze leg in SQL without duplicating the forward mapping's judgement.
 *
 * `matchNoJobs` is the one case that is not a job status at all: `no_backups`
 * means the device has NO backup_jobs row, which the query expresses as
 * "the latest-job join produced nothing".
 *
 * Four external statuses (`over_quota`, `no_selection`, `not_started`,
 * `unknown`) have no first-party spelling — they are vendor concepts. Asking
 * for one of those selects zero Breeze rows, which is correct and is what the
 * round-trip test pins.
 */
export function invertBackupJobStatus(
  status: ExternalBackupStatus,
): { jobStatuses: BackupJobStatus[]; matchNoJobs: boolean } {
  switch (status) {
    case 'completed':
      return { jobStatuses: ['completed'], matchNoJobs: false };
    case 'completed_with_errors':
      // #3000: `partial` is a real, restorable, degraded run — never `failed`.
      return { jobStatuses: ['partial'], matchNoJobs: false };
    case 'failed':
      return { jobStatuses: ['failed'], matchNoJobs: false };
    case 'in_progress':
      return { jobStatuses: ['running', 'pending'], matchNoJobs: false };
    case 'interrupted':
      return { jobStatuses: ['cancelled'], matchNoJobs: false };
    case 'no_backups':
      return { jobStatuses: [], matchNoJobs: true };
    default:
      return { jobStatuses: [], matchNoJobs: false };
  }
}

// ── Connection freshness ───────────────────────────────────────────────────

/**
 * Is the evidence behind a provider row too old to be believed?
 *
 * `isActive === null` means the connection row itself was invisible to this
 * caller. That is the NORMAL case for an org token: connections are
 * partner-axis (RLS shape 3) while device rows are org-axis (shape 1), so an
 * org legitimately sees its own devices and none of the partner's connector
 * config. Treating that as "unknown, therefore stale" would blank out every
 * provider row for every customer-scoped user; treating it as fresh is right,
 * because RLS handed us the device rows precisely because the org owns them.
 *
 * A VISIBLE connection with no `last_sync_at` is stale: we have no evidence
 * that any sync ever completed, and D4 requires positive evidence.
 */
export function isConnectionStale(c: ConnectionFreshness, now: Date): boolean {
  if (c.isActive === null) return false;
  if (c.isActive === false) return true;
  const lastSync = c.lastSyncAt == null ? null : new Date(c.lastSyncAt);
  if (!lastSync || Number.isNaN(lastSync.getTime())) return true;
  const intervalMinutes = c.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES;
  return now.getTime() - lastSync.getTime() > 2 * intervalMinutes * 60_000;
}

// ── Labels ─────────────────────────────────────────────────────────────────

/**
 * `labels: 'vendor'` — the technician-facing surfaces (web overview, device
 * tab, integrations hub) always name the product.
 * `labels: 'portal'`  — the customer-facing surface obeys the per-connection
 * toggle (D5), defaulting to the generic label.
 */
export function providerLabelFor(
  providerKey: string | null,
  opts: { portalShowProviderName: boolean; labels: 'vendor' | 'portal' },
): string | null {
  if (!providerKey) return null;
  if (opts.labels === 'portal' && !opts.portalShowProviderName) return GENERIC_PROVIDER_LABEL;
  try {
    return getBackupProvider(providerKey).label;
  } catch {
    // A row written by a provider this build no longer registers is data, not a
    // crash: show the raw key rather than 500 the whole overview.
    return providerKey;
  }
}

/** `devices.device_role` -> the row's device class (D-19). */
export function deviceRoleToRowType(role: string | null | undefined): 'workstation' | 'server' | 'unknown' {
  return role === 'workstation' || role === 'server' ? role : 'unknown';
}

// ── Row projection ─────────────────────────────────────────────────────────

export function toBreezeHealthRow(row: BreezeLegRow, opts: { now: Date }): BackupHealthRow {
  const status = mapBackupJobStatus(row.jobStatus);
  const lastSuccessAt = toIso(row.lastSuccessAt);
  const errorsCount = row.errorsCount ?? 0;
  const { health, recency, covered } = deriveBackupHealth({
    status,
    lastSuccessAt,
    errorsCount,
    now: opts.now,
  });
  return {
    key: row.key,
    source: 'breeze',
    providerKey: null,
    providerLabel: null,
    orgId: row.orgId,
    orgName: row.orgName,
    siteId: row.siteId,
    deviceId: row.deviceId,
    name: row.name,
    computerName: row.computerName,
    osType: deviceRoleToRowType(row.deviceRole),
    accountType: 'endpoint',
    status,
    health,
    recency,
    covered,
    stale: false,
    lastSuccessAt,
    lastSessionAt: toIso(row.lastSessionAt),
    // First-party runs report one size (what was written). Mapping it to
    // `usedBytes` and leaving `selectedBytes` null keeps the table column
    // honest rather than repeating one number under two headings.
    selectedBytes: null,
    usedBytes: toNumber(row.totalSize),
    errorsCount,
    dataSources: [],
    history28d: [],
    agentOnline: row.deviceStatus === 'online',
  };
}

export function toProviderHealthRow(
  row: ProviderLegRow,
  opts: { now: Date; labels: 'vendor' | 'portal' },
): BackupHealthRow {
  const lastSuccessAt = toIso(row.lastSuccessAt);
  const derived = deriveBackupHealth({
    status: row.status,
    lastSuccessAt,
    errorsCount: row.errorsCount,
    now: opts.now,
  });
  const stale = isConnectionStale(
    {
      isActive: row.connectionIsActive,
      lastSyncAt: row.connectionLastSyncAt,
      syncIntervalMinutes: row.connectionSyncIntervalMinutes,
    },
    opts.now,
  );
  return {
    key: row.key,
    source: 'provider',
    providerKey: row.provider,
    providerLabel: providerLabelFor(row.provider, {
      portalShowProviderName: row.portalShowProviderName,
      labels: opts.labels,
    }),
    orgId: row.orgId,
    orgName: row.orgName,
    // A provider row has no site of its own; it borrows the linked device's.
    siteId: row.breezeDeviceId ? row.deviceSiteId : null,
    deviceId: row.breezeDeviceId,
    name: row.name,
    computerName: row.computerName,
    osType: row.osType,
    accountType: row.accountType === 'm365' ? 'm365' : 'endpoint',
    status: row.status,
    // Stale evidence is not a verdict. The status and timestamps stay as last
    // observed so the UI can still say WHAT it last saw and WHEN, but the
    // health/coverage claims are withdrawn.
    health: stale ? 'unknown' : derived.health,
    recency: derived.recency,
    covered: stale ? false : derived.covered,
    stale,
    lastSuccessAt,
    lastSessionAt: toIso(row.lastSessionAt),
    selectedBytes: toNumber(row.selectedBytes),
    usedBytes: toNumber(row.usedBytes),
    errorsCount: row.errorsCount,
    dataSources: row.dataSources ?? [],
    history28d: [],
    agentOnline: row.breezeDeviceId ? row.deviceStatus === 'online' : null,
  };
}

// ── 28-day observed-health bar ─────────────────────────────────────────────

/** The 28 UTC days ending today, ascending, as `YYYY-MM-DD` (D-16). A fixed
 *  inclusive window means cell `i` is the same calendar day on every row, so
 *  the bars in a table line up vertically. */
export function buildHistoryWindow(now: Date, days: number = BACKUP_HISTORY_DAYS): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const window: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    window.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return window;
}

/** A day with no observation is `null`, rendered grey — NOT "healthy". */
export function fillHistoryWindow(
  window: string[],
  observed: ReadonlyMap<string, ExternalBackupStatus>,
): Array<{ day: string; status: ExternalBackupStatus | null }> {
  return window.map((day) => ({ day, status: observed.get(day) ?? null }));
}

/**
 * Fold first-party jobs into one status per UTC day, keeping the WORST
 * (D-20) — the same rule the provider ledger applies, so a bar means the same
 * thing on both sources. A nightly run that failed and was retried
 * successfully is a day that needed attention, not a clean day.
 */
export function foldJobsIntoDays(
  jobs: Array<{ status: BackupJobStatus; at: Date | string | null }>,
): Map<string, ExternalBackupStatus> {
  const days = new Map<string, ExternalBackupStatus>();
  for (const job of jobs) {
    if (job.at == null) continue;
    const day = utcDay(job.at);
    if (!day) continue;
    const observed = mapBackupJobStatus(job.status);
    const existing = days.get(day);
    days.set(day, existing ? worstBackupStatus(existing, observed) : observed);
  }
  return days;
}

// ── Merge + summary ────────────────────────────────────────────────────────

/** Merge two legs that are each already ordered by `(lower(name), key)`.
 *  Stops as soon as `limit` rows are taken. */
export function mergeSortedRows<T extends { key: string; name: string }>(
  left: readonly T[],
  right: readonly T[],
  limit: number,
): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (out.length < limit && (i < left.length || j < right.length)) {
    if (i >= left.length) {
      out.push(right[j++]!);
    } else if (j >= right.length) {
      out.push(left[i++]!);
    } else {
      out.push(compareRowKeys(left[i]!, right[j]!) <= 0 ? left[i++]! : right[j++]!);
    }
  }
  return out;
}

export function emptyBackupHealthSummary(): BackupHealthSummary {
  const byStatus = Object.fromEntries(
    EXTERNAL_BACKUP_STATUSES.map((s) => [s, 0]),
  ) as BackupHealthSummary['byStatus'];
  return {
    endpoints: { total: 0, covered: 0, uncovered: 0 },
    providerOnly: 0,
    m365Accounts: 0,
    byStatus,
    byHealth: { healthy: 0, warning: 0, critical: 0, unknown: 0 },
    byRecency: { under_24h: 0, under_48h: 0, over_48h: 0, never: 0 },
  };
}

/**
 * Fold rows into the overview's counters.
 *
 * The bars count ROWS (a device backed up twice is two facts a technician can
 * act on). `endpoints` counts DISTINCT Breeze devices, because "how many of my
 * machines have a backup" must not double from switching a customer onto Cove.
 * Coverage for such a device is the OR of its rows: a stale first-party job
 * plus a fresh Cove restore point is a covered machine.
 */
export function foldBackupHealthSummary(rows: readonly BackupHealthRow[]): BackupHealthSummary {
  const summary = emptyBackupHealthSummary();
  const endpointCoverage = new Map<string, boolean>();

  for (const row of rows) {
    summary.byStatus[row.status] += 1;
    summary.byHealth[row.health] += 1;
    summary.byRecency[row.recency] += 1;

    if (row.accountType === 'm365') {
      summary.m365Accounts += 1;
      continue;
    }
    if (row.deviceId) {
      endpointCoverage.set(row.deviceId, (endpointCoverage.get(row.deviceId) ?? false) || row.covered);
      continue;
    }
    // An endpoint the vendor protects that Breeze does not manage.
    summary.providerOnly += 1;
  }

  summary.endpoints.total = endpointCoverage.size;
  for (const covered of endpointCoverage.values()) {
    if (covered) summary.endpoints.covered += 1;
  }
  summary.endpoints.uncovered = summary.endpoints.total - summary.endpoints.covered;
  return summary;
}
```

Add the import of `compareRowKeys` at the top of the file:
```ts
import { compareRowKeys } from './backupHealthCursor';
```

- [ ] **Step 4: Run it green**

```bash
cd apps/api && npx vitest run src/services/backupHealthRows.test.ts
```
Expected: 1 file, 34 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/backupHealthRows.ts apps/api/src/services/backupHealthRows.test.ts
git commit -m "$(cat <<'EOF'
feat(backup): pure row assembly for the unified backup-health feed

W03 Task 2. Projection, status inversion, connection-freshness and the summary
fold, all I/O-free. The health verdict itself is delegated to @breeze/shared's
deriveBackupHealth and asserted against it for every enum value — a second
implementation is how "protected" drifts apart between the overview, the portal
and the posture report.

Two rules worth naming: an INVISIBLE connection row (org token, partner-axis
RLS) is treated as active and fresh, because RLS handed us the device rows
precisely because the org owns them; a VISIBLE one that never synced is stale,
because D4 wants positive evidence.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The read model — `backupHealthReadModel.ts`

**Files:**
- Create: `apps/api/src/services/backupHealthReadModel.ts`
- Create: `apps/api/src/services/backupHealthReadModel.test.ts`
- Create: `apps/api/src/__tests__/integration/backupHealthReadModel.integration.test.ts`

**Interfaces:**

Consumes:
- `db` (`apps/api/src/db/index.ts:1040`) — the RLS-context-aware proxy; the caller's request transaction is ambient.
- `devices`, `organizations`, `backupJobs`, `RESTORABLE_BACKUP_JOB_STATUSES` (`apps/api/src/db/schema/backup.ts:82`), `backupProviderDevices`, `backupProviderCustomers`, `backupProviderConnections`, `backupProviderDeviceHistory`.
- `latestBackupRunWindowOrder` (`apps/api/src/services/backupJobOrdering.ts:38`) — the window-function spelling of "most recent RUN".
- `escapeLike` (`apps/api/src/utils/sql.ts:9`).
- Everything from Tasks 1 and 2.

Produces:
```ts
export interface BackupHealthScope { orgIds: string[]; siteIds?: string[] }
export interface BackupHealthFilter { health?: BackupHealth[]; status?: ExternalBackupStatus[]; search?: string }
export interface BackupHealthListOptions {
  sources?: Array<'breeze' | 'provider'>;
  onlyWithBackup?: boolean;
  filter?: BackupHealthFilter;
  labels?: 'vendor' | 'portal';   // default 'vendor'; W04's portal passes 'portal'
  page: { limit: number; cursor?: string | null };
  now?: Date;                     // test seam only
}
export type BackupHealthSummaryOptions = Omit<BackupHealthListOptions, 'page' | 'labels'>;

export async function listBackupHealthRows(
  scope: BackupHealthScope, opts: BackupHealthListOptions,
): Promise<{ rows: BackupHealthRow[]; nextCursor: string | null }>;

export async function summarizeBackupHealth(
  scope: BackupHealthScope, opts?: BackupHealthSummaryOptions,
): Promise<BackupHealthSummary>;

export async function getProviderCoverageForDevices(
  orgId: string, deviceIds: string[],
): Promise<Map<string, { covered: boolean; health: BackupHealth }>>;

export async function getFirstPartyCoverageForDevices(
  orgId: string, deviceIds: string[],
): Promise<Map<string, { covered: boolean; health: BackupHealth; status: ExternalBackupStatus; lastSuccessAt: string | null }>>;

export async function getProviderAttentionItems(
  orgId: string, opts: { allowedDeviceIds: string[] | null; limit: number; now?: Date },
): Promise<Array<{ id: string; title: string; description: string; severity: 'critical' }>>;

export const BACKUP_HEALTH_SCAN_BATCH = 500;
export const BACKUP_HEALTH_MAX_BATCHES = 20;
export const BACKUP_HEALTH_SUMMARY_MAX_ROWS = 50_000;
```

**DECISIONS taken here:**
- **D-03** — no SQL `UNION ALL`. Two legs, each ordered by the SAME `(lower(name) COLLATE "C", key COLLATE "C")`, are merged in JS. Because each leg is individually ordered by the global key, the first `n` rows of the union are always inside the first `n` of each leg, so the merge returns exactly the page a union would. The alternative costs ~20 `::type` casts per leg to line the column lists up (`apps/api/src/routes/incidents.helpers.ts:290-330` is the worked example) and puts the whole query beyond the repo's `db.select()` chain mock. Cost: two round-trips per batch instead of one.
- **D-05** — `health` is derived, so it is filtered in JS after `deriveBackupHealth`. To keep pages full rather than shredded, the list runs a bounded over-fetch loop: batches of `min(BACKUP_HEALTH_SCAN_BATCH, (limit + 1) * 4)` advancing the keyset until `limit + 1` rows survive, at most `BACKUP_HEALTH_MAX_BATCHES`. **With no `health` filter exactly one batch of `limit + 1` runs** — the common case pays nothing. Hitting the batch cap ends the page early WITH a cursor, so the client continues rather than silently seeing a truncated fleet.
- **D-07** — `onlyWithBackup` means "has any backup evidence". For a Breeze row that is `≥ 1 backup_jobs` row (the latest-job join produced something); a provider row always qualifies, because the row exists only because the vendor holds a backup account for it.
- **D-10** — `getFirstPartyCoverageForDevices` and `getProviderAttentionItems` are added beyond the three index-locked exports so `routes/backup/dashboard.ts` can stay a thin caller (spec: "both via the read model so the route stays thin"). They are additions, not renames; nothing in the index moves.
- **D-21** — `summarizeBackupHealth` scans the scope with the SAME leg builders (so a filter can never mean two different things between the bars and the table), capped at `BACKUP_HEALTH_SUMMARY_MAX_ROWS`. At the cap it logs `console.warn` once naming the scope; it does not silently report a partial fleet as the whole one.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/backupHealthReadModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_1 = 'd1111111-1111-4111-8111-111111111111';
const DEVICE_2 = 'd2222222-2222-4222-8222-222222222222';
const PROVIDER_ROW = 'f1111111-1111-4111-8111-111111111111';

// Drizzle chain mock, same idiom as routes/backup/dashboard.test.ts:14-24 with
// innerJoin added. Every builder method returns a thenable that resolves to the
// queued rows, so `await db.select()...limit(n)` works and the call arguments
// stay inspectable.
function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'as', 'groupBy']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  chain.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
    Promise.resolve(resolvedValue).then(ok, err);
  return chain;
}

const selectMock = vi.fn(() => chainMock([]));

vi.mock('../db', () => ({ db: { select: (...a: unknown[]) => selectMock(...(a as [])) } }));

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.org_id', siteId: 'devices.site_id', hostname: 'devices.hostname', displayName: 'devices.display_name', deviceRole: 'devices.device_role', status: 'devices.status', isEphemeral: 'devices.is_ephemeral' },
  organizations: { id: 'organizations.id', name: 'organizations.name' },
  backupJobs: { id: 'backup_jobs.id', orgId: 'backup_jobs.org_id', deviceId: 'backup_jobs.device_id', status: 'backup_jobs.status', startedAt: 'backup_jobs.started_at', createdAt: 'backup_jobs.created_at', completedAt: 'backup_jobs.completed_at', totalSize: 'backup_jobs.total_size', errorCount: 'backup_jobs.error_count' },
  RESTORABLE_BACKUP_JOB_STATUSES: ['completed', 'partial'] as const,
  backupProviderDevices: { id: 'bpd.id', orgId: 'bpd.org_id', connectionId: 'bpd.connection_id', customerId: 'bpd.customer_id', provider: 'bpd.provider', portalShowProviderName: 'bpd.portal_show_provider_name', vendorDeviceName: 'bpd.vendor_device_name', computerName: 'bpd.computer_name', osType: 'bpd.os_type', accountType: 'bpd.account_type', dataSources: 'bpd.data_sources', status: 'bpd.status', lastSessionAt: 'bpd.last_session_at', lastSuccessAt: 'bpd.last_success_at', selectedBytes: 'bpd.selected_bytes', usedBytes: 'bpd.used_bytes', errorsCount: 'bpd.errors_count', breezeDeviceId: 'bpd.breeze_device_id' },
  backupProviderCustomers: { id: 'bpc.id', vendorCustomerName: 'bpc.vendor_customer_name' },
  backupProviderConnections: { id: 'bpn.id', partnerId: 'bpn.partner_id', isActive: 'bpn.is_active', lastSyncAt: 'bpn.last_sync_at', syncIntervalMinutes: 'bpn.sync_interval_minutes' },
  backupProviderDeviceHistory: { providerDeviceId: 'bpdh.provider_device_id', day: 'bpdh.day', status: 'bpdh.status' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...c: unknown[]) => ({ op: 'and', conditions: c.filter(Boolean) }),
  or: (...c: unknown[]) => ({ op: 'or', conditions: c.filter(Boolean) }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  ne: (column: unknown, value: unknown) => ({ op: 'ne', column, value }),
  gte: (column: unknown, value: unknown) => ({ op: 'gte', column, value }),
  isNull: (column: unknown) => ({ op: 'isNull', column }),
  isNotNull: (column: unknown) => ({ op: 'isNotNull', column }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
  ilike: (column: unknown, value: unknown) => ({ op: 'ilike', column, value }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values, as: (alias: string) => ({ op: 'sql', strings, values, alias }) }),
    { raw: (s: string) => ({ op: 'raw', s }) },
  ),
}));

import {
  BACKUP_HEALTH_MAX_BATCHES,
  getFirstPartyCoverageForDevices,
  getProviderAttentionItems,
  getProviderCoverageForDevices,
  listBackupHealthRows,
  summarizeBackupHealth,
} from './backupHealthReadModel';
import { decodeBackupHealthCursor } from './backupHealthCursor';

const NOW = new Date('2026-09-15T12:00:00.000Z');

const breezeRow = (o: Record<string, unknown> = {}) => ({
  orgId: ORG_A, orgName: 'Acme', siteId: SITE_A, deviceId: DEVICE_1,
  name: 'SRV01', computerName: 'srv01', deviceRole: 'server', deviceStatus: 'online',
  jobStatus: 'completed', lastSessionAt: '2026-09-15T02:00:00.000Z',
  lastSuccessAt: '2026-09-15T02:30:00.000Z', totalSize: 1024, errorsCount: 0, hasJobs: true,
  ...o,
});

const providerRow = (o: Record<string, unknown> = {}) => ({
  id: PROVIDER_ROW, orgId: ORG_A, orgName: 'Acme', provider: 'cove', portalShowProviderName: false,
  name: 'ACME-SRV02', computerName: 'srv02', osType: 'workstation', accountType: 'backup_manager',
  dataSources: ['files'], status: 'completed', lastSessionAt: '2026-09-15T01:00:00.000Z',
  lastSuccessAt: '2026-09-15T01:00:00.000Z', selectedBytes: 10, usedBytes: 20, errorsCount: 0,
  breezeDeviceId: null, deviceStatus: null, deviceSiteId: null,
  connectionIsActive: true, connectionLastSyncAt: '2026-09-15T11:55:00.000Z', connectionSyncIntervalMinutes: 30,
  ...o,
});

/** Queue leg results in call order: breeze leg, provider leg, then the two
 *  history queries. */
function queue(...results: unknown[][]) {
  selectMock.mockReset();
  for (const rows of results) selectMock.mockReturnValueOnce(chainMock(rows));
  selectMock.mockImplementation(() => chainMock([]));
}

const whereArg = (callIndex: number) => selectMock.mock.results[callIndex]!.value.where.mock.calls[0][0];
const flatConditions = (node: any): any[] =>
  node?.op === 'and' || node?.op === 'or' ? node.conditions.flatMap(flatConditions) : [node];

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockReset();
  selectMock.mockImplementation(() => chainMock([]));
});

describe('listBackupHealthRows — scope', () => {
  it('returns nothing without querying when the org scope is empty', async () => {
    const out = await listBackupHealthRows({ orgIds: [] }, { page: { limit: 10 }, now: NOW });
    expect(out).toEqual({ rows: [], nextCursor: null });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns nothing when the caller is site-restricted to zero sites', async () => {
    const out = await listBackupHealthRows({ orgIds: [ORG_A], siteIds: [] }, { page: { limit: 10 }, now: NOW });
    expect(out).toEqual({ rows: [], nextCursor: null });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('constrains both legs to the scope org ids', async () => {
    queue([breezeRow()], [providerRow()]);
    await listBackupHealthRows({ orgIds: [ORG_A, ORG_B] }, { page: { limit: 10 }, now: NOW });
    for (const call of [0, 1]) {
      expect(flatConditions(whereArg(call))).toContainEqual(
        expect.objectContaining({ op: 'inArray', values: [ORG_A, ORG_B] }),
      );
    }
  });
});

describe('listBackupHealthRows — site authority', () => {
  it('narrows the Breeze leg to the allowed sites', async () => {
    queue([breezeRow()], []);
    await listBackupHealthRows({ orgIds: [ORG_A], siteIds: [SITE_A] }, { page: { limit: 10 }, now: NOW });
    expect(flatConditions(whereArg(0))).toContainEqual(
      expect.objectContaining({ op: 'inArray', column: 'devices.site_id', values: [SITE_A] }),
    );
  });

  it('requires a linked, in-site device for provider rows when the caller is site-restricted', async () => {
    queue([], [providerRow()]);
    await listBackupHealthRows({ orgIds: [ORG_A], siteIds: [SITE_A] }, { page: { limit: 10 }, now: NOW });
    const conditions = flatConditions(whereArg(1));
    expect(conditions).toContainEqual(expect.objectContaining({ op: 'isNotNull', column: 'bpd.breeze_device_id' }));
    expect(conditions).toContainEqual(
      expect.objectContaining({ op: 'inArray', column: 'devices.site_id', values: [SITE_A] }),
    );
  });

  it('places no site condition on either leg for an unrestricted caller', async () => {
    queue([breezeRow()], [providerRow()]);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    for (const call of [0, 1]) {
      expect(flatConditions(whereArg(call))).not.toContainEqual(
        expect.objectContaining({ column: 'devices.site_id' }),
      );
    }
  });
});

describe('listBackupHealthRows — the all-devices contract', () => {
  it('returns a row for a device with no jobs at all, as no_backups', async () => {
    queue([breezeRow({ jobStatus: null, lastSessionAt: null, lastSuccessAt: null, totalSize: null, hasJobs: false })], []);
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'breeze', status: 'no_backups', covered: false });
  });

  it('excludes ephemeral and decommissioned devices from the Breeze leg', async () => {
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    const conditions = flatConditions(whereArg(0));
    expect(conditions).toContainEqual(expect.objectContaining({ op: 'eq', column: 'devices.is_ephemeral', value: false }));
    expect(conditions).toContainEqual(expect.objectContaining({ op: 'ne', column: 'devices.status', value: 'decommissioned' }));
  });

  it('emits TWO rows for a device that is both first-party backed up and provider-linked', async () => {
    queue([breezeRow()], [providerRow({ breezeDeviceId: DEVICE_1, deviceStatus: 'online', deviceSiteId: SITE_A })]);
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows.map((r) => r.source)).toEqual(['ACME-SRV02', 'SRV01'].map(() => expect.any(String)));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.deviceId === DEVICE_1)).toHaveLength(2);
  });

  it('merges the two legs into one (lower(name), key) order', async () => {
    queue(
      [breezeRow({ name: 'bravo', deviceId: DEVICE_2 }), breezeRow({ name: 'Delta' })],
      [providerRow({ name: 'ALPHA' }), providerRow({ name: 'charlie', id: 'f2222222-2222-4222-8222-222222222222' })],
    );
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows.map((r) => r.name)).toEqual(['ALPHA', 'bravo', 'charlie', 'Delta']);
  });
});

describe('listBackupHealthRows — filters', () => {
  it('sources: ["provider"] skips the Breeze leg entirely', async () => {
    queue([providerRow()]);
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { sources: ['provider'], page: { limit: 10 }, now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('provider');
    expect(selectMock).toHaveBeenCalledTimes(2); // provider leg + its history query
  });

  it('onlyWithBackup drops Breeze devices with no jobs at the SQL layer', async () => {
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { onlyWithBackup: true, page: { limit: 10 }, now: NOW });
    expect(JSON.stringify(whereArg(0))).toContain('bh_latest_job');
  });

  it('status=completed_with_errors selects partial jobs on the Breeze leg, never failed', async () => {
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { filter: { status: ['completed_with_errors'] }, page: { limit: 10 }, now: NOW });
    const serialised = JSON.stringify(whereArg(0));
    expect(serialised).toContain('partial');
    expect(serialised).not.toContain('"failed"');
  });

  it('search escapes LIKE metacharacters before building the ILIKE pattern', async () => {
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { filter: { search: '100%_srv' }, page: { limit: 10 }, now: NOW });
    expect(JSON.stringify(whereArg(0))).toContain('100\\\\%\\\\_srv');
  });

  it('filters health in memory and keeps fetching batches until the page is full', async () => {
    // Batch 1: four rows, one critical. Batch 2: one more critical, then dry.
    queue(
      [breezeRow({ name: 'a', jobStatus: 'failed' }), breezeRow({ name: 'b', deviceId: DEVICE_2 })],
      [],
      [breezeRow({ name: 'c', jobStatus: 'failed', deviceId: DEVICE_2 })],
      [],
    );
    const { rows } = await listBackupHealthRows(
      { orgIds: [ORG_A] },
      { filter: { health: ['critical'] }, page: { limit: 2 }, now: NOW },
    );
    expect(rows.map((r) => r.name)).toEqual(['a', 'c']);
  });

  it('gives up after BACKUP_HEALTH_MAX_BATCHES but still returns a cursor, never a silently short fleet', async () => {
    selectMock.mockImplementation(() => chainMock([breezeRow({ name: `n${Math.random()}` })]));
    const { rows, nextCursor } = await listBackupHealthRows(
      { orgIds: [ORG_A] },
      { filter: { health: ['unknown'] }, page: { limit: 10 }, now: NOW },
    );
    expect(rows).toHaveLength(0);
    expect(nextCursor).not.toBeNull();
    expect(selectMock.mock.calls.length).toBeLessThanOrEqual(BACKUP_HEALTH_MAX_BATCHES * 2);
  });
});

describe('listBackupHealthRows — pagination', () => {
  it('emits a nextCursor that decodes to the last returned row', async () => {
    queue(
      [breezeRow({ name: 'a' }), breezeRow({ name: 'b', deviceId: DEVICE_2 })],
      [providerRow({ name: 'c' })],
    );
    const { rows, nextCursor } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 2 }, now: NOW });
    expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
    expect(decodeBackupHealthCursor(nextCursor)).toEqual({ v: 1, n: 'b', k: `breeze:${DEVICE_2}` });
  });

  it('emits a null nextCursor once both legs run dry', async () => {
    queue([breezeRow({ name: 'a' })], []);
    const { nextCursor } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(nextCursor).toBeNull();
  });

  it('applies the incoming cursor as a keyset predicate on both legs', async () => {
    const cursor = Buffer.from(JSON.stringify({ v: 1, n: 'b', k: `breeze:${DEVICE_2}` }), 'utf8').toString('base64url');
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10, cursor }, now: NOW });
    for (const call of [0, 1]) expect(JSON.stringify(whereArg(call))).toContain(`breeze:${DEVICE_2}`);
  });

  it('treats a malformed cursor as no cursor rather than throwing', async () => {
    queue([breezeRow()], []);
    const out = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10, cursor: 'not a token!!' }, now: NOW });
    expect(out.rows).toHaveLength(1);
  });
});

describe('listBackupHealthRows — connection visibility', () => {
  it('treats an invisible connection row (org token) as active and fresh', async () => {
    queue([], [providerRow({ connectionIsActive: null, connectionLastSyncAt: null, connectionSyncIntervalMinutes: null })]);
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows[0]).toMatchObject({ stale: false, health: 'healthy', covered: true });
  });

  it('withdraws the verdict when a visible connection has gone stale', async () => {
    queue([], [providerRow({ connectionLastSyncAt: '2026-09-15T08:00:00.000Z' })]);
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows[0]).toMatchObject({ stale: true, health: 'unknown', covered: false });
  });
});

describe('listBackupHealthRows — 28-day history', () => {
  it('fills provider cells from the ledger and leaves unobserved days null', async () => {
    queue(
      [], [providerRow()],
      [{ providerDeviceId: PROVIDER_ROW, day: '2026-09-14', status: 'failed' }],
    );
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows[0]!.history28d).toHaveLength(28);
    expect(rows[0]!.history28d.at(-1)).toEqual({ day: '2026-09-15', status: null });
    expect(rows[0]!.history28d.at(-2)).toEqual({ day: '2026-09-14', status: 'failed' });
  });

  it('folds first-party jobs into the worst status per UTC day', async () => {
    queue(
      [breezeRow()], [],
      [
        { deviceId: DEVICE_1, status: 'completed', at: '2026-09-14T23:00:00.000Z' },
        { deviceId: DEVICE_1, status: 'failed', at: '2026-09-14T01:00:00.000Z' },
      ],
    );
    const { rows } = await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(rows[0]!.history28d.at(-2)).toEqual({ day: '2026-09-14', status: 'failed' });
  });

  it('issues no history query when the page is empty', async () => {
    queue([], []);
    await listBackupHealthRows({ orgIds: [ORG_A] }, { page: { limit: 10 }, now: NOW });
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});

describe('summarizeBackupHealth', () => {
  it('counts a dual-source device once and ORs its coverage', async () => {
    queue(
      [breezeRow({ jobStatus: null, lastSuccessAt: null, hasJobs: false })],
      [providerRow({ breezeDeviceId: DEVICE_1, deviceStatus: 'online', deviceSiteId: SITE_A })],
    );
    const summary = await summarizeBackupHealth({ orgIds: [ORG_A] }, { now: NOW });
    expect(summary.endpoints).toEqual({ total: 1, covered: 1, uncovered: 0 });
    expect(summary.byStatus.no_backups).toBe(1);
    expect(summary.byStatus.completed).toBe(1);
  });

  it('is the all-zero shape for an empty scope, without querying', async () => {
    const summary = await summarizeBackupHealth({ orgIds: [] });
    expect(summary.endpoints).toEqual({ total: 0, covered: 0, uncovered: 0 });
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('getProviderCoverageForDevices', () => {
  it('maps linked device ids to their provider coverage', async () => {
    queue([{ breezeDeviceId: DEVICE_1, status: 'completed', lastSuccessAt: '2026-09-15T01:00:00.000Z', errorsCount: 0, connectionIsActive: true, connectionLastSyncAt: '2026-09-15T11:55:00.000Z', connectionSyncIntervalMinutes: 30 }]);
    const map = await getProviderCoverageForDevices(ORG_A, [DEVICE_1, DEVICE_2]);
    expect(map.get(DEVICE_1)).toEqual({ covered: true, health: 'healthy' });
    expect(map.has(DEVICE_2)).toBe(false);
  });

  it('short-circuits on an empty device list', async () => {
    expect((await getProviderCoverageForDevices(ORG_A, [])).size).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('getProviderAttentionItems', () => {
  it('names the vendor device and its customer, and falls back to the org name when the customer row is invisible', async () => {
    queue([
      { id: PROVIDER_ROW, name: 'ACME-SRV02', customerName: 'Acme North', orgName: 'Acme', status: 'failed', lastSuccessAt: null, errorsCount: 2, connectionIsActive: true, connectionLastSyncAt: '2026-09-15T11:55:00.000Z', connectionSyncIntervalMinutes: 30 },
      { id: 'f3333333-3333-4333-8333-333333333333', name: 'ACME-WS09', customerName: null, orgName: 'Acme', status: 'no_backups', lastSuccessAt: null, errorsCount: 0, connectionIsActive: null, connectionLastSyncAt: null, connectionSyncIntervalMinutes: null },
    ]);
    const items = await getProviderAttentionItems(ORG_A, { allowedDeviceIds: null, limit: 20, now: NOW });
    expect(items[0]).toMatchObject({ id: `provider:${PROVIDER_ROW}`, severity: 'critical' });
    expect(items[0]!.description).toBe('ACME-SRV02 (Acme North) — failed');
    expect(items[1]!.description).toBe('ACME-WS09 (Acme) — no_backups');
  });

  it('drops non-critical rows', async () => {
    queue([{ id: PROVIDER_ROW, name: 'ok', customerName: 'Acme', orgName: 'Acme', status: 'completed', lastSuccessAt: '2026-09-15T01:00:00.000Z', errorsCount: 0, connectionIsActive: true, connectionLastSyncAt: '2026-09-15T11:55:00.000Z', connectionSyncIntervalMinutes: 30 }]);
    expect(await getProviderAttentionItems(ORG_A, { allowedDeviceIds: null, limit: 20, now: NOW })).toEqual([]);
  });

  it('hides unlinked rows from a site-restricted caller', async () => {
    queue([]);
    await getProviderAttentionItems(ORG_A, { allowedDeviceIds: [DEVICE_1], limit: 20, now: NOW });
    const conditions = flatConditions(whereArg(0));
    expect(conditions).toContainEqual(expect.objectContaining({ op: 'inArray', column: 'bpd.breeze_device_id', values: [DEVICE_1] }));
  });
});

describe('getFirstPartyCoverageForDevices', () => {
  it('reports covered for a device whose newest restorable job is inside 48h', async () => {
    queue([{ deviceId: DEVICE_1, jobStatus: 'completed', lastSuccessAt: '2026-09-15T02:00:00.000Z', errorsCount: 0, hasJobs: true }]);
    const map = await getFirstPartyCoverageForDevices(ORG_A, [DEVICE_1]);
    expect(map.get(DEVICE_1)).toMatchObject({ covered: true, status: 'completed' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/backupHealthReadModel.test.ts
```
Expected: `Failed to resolve import "./backupHealthReadModel"`.

---

- [ ] **Step 3: Implement the leg builders and `listBackupHealthRows`**

```ts
// apps/api/src/services/backupHealthReadModel.ts
/**
 * The unified backup read model.
 *
 * One question, asked once: "what is the backup state of every device this
 * caller can see?" — over first-party backup_jobs AND third-party
 * backup_provider_devices. Every surface that used to answer it from
 * backup_jobs alone (the /backup overview, the device tab, the portal, the
 * posture report, the org narrative) reads it from here instead, so a customer
 * protected by Cove stops reading as "unprotected" in one place and
 * "protected" in another.
 *
 * Two contracts this file exists to keep:
 *
 *  1. EVERY active Breeze device in scope is a row. A device with no backup_jobs
 *     row is `status: 'no_backups'`, not an absence. The unprotected population
 *     is the whole point of the view and must never fall out of a join.
 *  2. SITE is enforced here. Postgres RLS defends org and partner; it cannot see
 *     the site axis. Breeze rows are filtered by devices.site_id; unlinked
 *     provider rows have no site at all and are therefore returned only to a
 *     caller with no site restriction.
 *
 * Everything runs on the ambient request transaction via the RLS-aware `db`
 * proxy. Nothing here opens a system context.
 */

import { and, eq, gte, ilike, inArray, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';

import {
  deriveBackupHealth,
  type BackupHealth,
  type BackupHealthRow,
  type BackupHealthSummary,
  type ExternalBackupStatus,
} from '@breeze/shared';

import { db } from '../db';
import {
  backupJobs,
  backupProviderConnections,
  backupProviderCustomers,
  backupProviderDeviceHistory,
  backupProviderDevices,
  devices,
  organizations,
  RESTORABLE_BACKUP_JOB_STATUSES,
} from '../db/schema';
import { escapeLike } from '../utils/sql';
import { latestBackupRunWindowOrder } from './backupJobOrdering';
import {
  cursorFromRow,
  decodeBackupHealthCursor,
  encodeBackupHealthCursor,
  type BackupHealthCursor,
} from './backupHealthCursor';
import {
  BACKUP_HISTORY_DAYS,
  buildHistoryWindow,
  fillHistoryWindow,
  foldBackupHealthSummary,
  foldJobsIntoDays,
  emptyBackupHealthSummary,
  invertBackupJobStatus,
  isConnectionStale,
  mergeSortedRows,
  toBreezeHealthRow,
  toProviderHealthRow,
  type BackupJobStatus,
  type BreezeLegRow,
  type ProviderLegRow,
} from './backupHealthRows';

export interface BackupHealthScope {
  orgIds: string[];
  /** The caller's site ceiling. `undefined` = unrestricted; `[]` = sees nothing. */
  siteIds?: string[];
}

export interface BackupHealthFilter {
  health?: BackupHealth[];
  status?: ExternalBackupStatus[];
  search?: string;
}

export interface BackupHealthListOptions {
  sources?: Array<'breeze' | 'provider'>;
  onlyWithBackup?: boolean;
  filter?: BackupHealthFilter;
  /** 'vendor' names the product (technician surfaces); 'portal' obeys the
   *  per-connection toggle (D5). W04's portal read model passes 'portal'. */
  labels?: 'vendor' | 'portal';
  page: { limit: number; cursor?: string | null };
  /** Test seam. Production callers omit it. */
  now?: Date;
}

export type BackupHealthSummaryOptions = Omit<BackupHealthListOptions, 'page' | 'labels'>;

/** Rows pulled per SQL batch while a health filter is narrowing the page. */
export const BACKUP_HEALTH_SCAN_BATCH = 500;
/** Ceiling on batches per request, so a fleet that is 100% healthy cannot make
 *  `?health=critical` walk the whole table in one HTTP request. */
export const BACKUP_HEALTH_MAX_BATCHES = 20;
/** Ceiling on the summary scan. */
export const BACKUP_HEALTH_SUMMARY_MAX_ROWS = 50_000;

// ── shared SQL fragments ───────────────────────────────────────────────────

/** The Breeze leg's display name. `nullif(…, '')` matters: an empty
 *  display_name would otherwise sort every such device to the top under an
 *  empty-string key. */
const breezeNameExpr = sql<string>`coalesce(nullif(${devices.displayName}, ''), ${devices.hostname})`;
const breezeKeyExpr = sql<string>`('breeze:' || ${devices.id}::text)`;
const providerNameExpr = sql<string>`${backupProviderDevices.vendorDeviceName}`;
const providerKeyExpr = sql<string>`('provider:' || ${backupProviderDevices.id}::text)`;

/**
 * `ORDER BY lower(name) COLLATE "C", key COLLATE "C"` — byte order, which is
 * exactly what the JS comparator in backupHealthCursor does. Without the
 * explicit collation the database sorts under its own locale and the merge
 * disagrees with the walk.
 */
function orderExprs(nameExpr: SQL<string>, keyExpr: SQL<string>): SQL[] {
  return [sql`lower(${nameExpr}) COLLATE "C" asc`, sql`${keyExpr} COLLATE "C" asc`];
}

function keysetPredicate(nameExpr: SQL<string>, keyExpr: SQL<string>, cursor: BackupHealthCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(lower(${nameExpr}) COLLATE "C", ${keyExpr} COLLATE "C") > (${cursor.n}::text COLLATE "C", ${cursor.k}::text COLLATE "C")`;
}

function searchPattern(search: string | undefined): string | null {
  const trimmed = search?.trim();
  return trimmed ? `%${escapeLike(trimmed)}%` : null;
}

// ── Breeze leg ─────────────────────────────────────────────────────────────

/** The device's newest RUN (not newest inserted row — see backupJobOrdering). */
function latestJobSubquery(orgIds: string[]) {
  return db
    .select({
      deviceId: backupJobs.deviceId,
      status: backupJobs.status,
      startedAt: backupJobs.startedAt,
      createdAt: backupJobs.createdAt,
      totalSize: backupJobs.totalSize,
      errorCount: backupJobs.errorCount,
      rn: sql<number>`row_number() over (partition by ${backupJobs.deviceId} order by ${latestBackupRunWindowOrder})`.as('rn'),
    })
    .from(backupJobs)
    .where(inArray(backupJobs.orgId, orgIds))
    .as('bh_latest_job');
}

/** The device's newest RESTORABLE run. `partial` counts (#3000): it left a real
 *  restore point, and excluding it would report "never backed up" for a device
 *  that demonstrably has a snapshot. */
function latestSuccessSubquery(orgIds: string[]) {
  return db
    .select({
      deviceId: backupJobs.deviceId,
      completedAt: backupJobs.completedAt,
      startedAt: backupJobs.startedAt,
      createdAt: backupJobs.createdAt,
      rn: sql<number>`row_number() over (partition by ${backupJobs.deviceId} order by ${latestBackupRunWindowOrder})`.as('rn'),
    })
    .from(backupJobs)
    .where(
      and(
        inArray(backupJobs.orgId, orgIds),
        inArray(backupJobs.status, [...RESTORABLE_BACKUP_JOB_STATUSES]),
      ),
    )
    .as('bh_last_success');
}

function buildBreezeLeg(
  scope: BackupHealthScope,
  opts: BackupHealthListOptions,
  cursor: BackupHealthCursor | null,
  limit: number,
) {
  const latest = latestJobSubquery(scope.orgIds);
  const success = latestSuccessSubquery(scope.orgIds);
  const conditions: Array<SQL | undefined> = [
    inArray(devices.orgId, scope.orgIds),
    // Quick Support devices live in the hidden per-partner org and are not part
    // of anyone's backup posture.
    eq(devices.isEphemeral, false),
    // `devices` carries no deleted_at — offboarding retires a device via
    // status='decommissioned' (see aiToolsTicketing.ts:849-853).
    ne(devices.status, 'decommissioned'),
  ];

  if (scope.siteIds) conditions.push(inArray(devices.siteId, scope.siteIds));
  if (opts.onlyWithBackup) conditions.push(sql`${latest.deviceId} is not null`);

  if (opts.filter?.status?.length) {
    const jobStatuses = new Set<BackupJobStatus>();
    let matchNoJobs = false;
    for (const status of opts.filter.status) {
      const inverted = invertBackupJobStatus(status);
      inverted.jobStatuses.forEach((s) => jobStatuses.add(s));
      matchNoJobs ||= inverted.matchNoJobs;
    }
    const branches: SQL[] = [];
    if (jobStatuses.size > 0) branches.push(sql`${latest.status} in ${[...jobStatuses]}`);
    if (matchNoJobs) branches.push(sql`${latest.deviceId} is null`);
    // No first-party spelling for the requested statuses => select nothing.
    conditions.push(branches.length > 0 ? (or(...branches) as SQL) : sql`false`);
  }

  const pattern = searchPattern(opts.filter?.search);
  if (pattern) {
    conditions.push(
      or(
        ilike(devices.displayName, pattern),
        ilike(devices.hostname, pattern),
        ilike(organizations.name, pattern),
      ) as SQL,
    );
  }
  conditions.push(keysetPredicate(breezeNameExpr, breezeKeyExpr, cursor));

  return db
    .select({
      key: breezeKeyExpr.as('key'),
      orgId: devices.orgId,
      orgName: organizations.name,
      siteId: devices.siteId,
      deviceId: devices.id,
      name: breezeNameExpr.as('name'),
      computerName: devices.hostname,
      deviceRole: devices.deviceRole,
      deviceStatus: devices.status,
      jobStatus: sql<BackupJobStatus | null>`${latest.status}`.as('jobStatus'),
      lastSessionAt: sql<Date | null>`coalesce(${latest.startedAt}, ${latest.createdAt})`.as('lastSessionAt'),
      // D-06: a restorable run that never stamped completed_at still happened.
      lastSuccessAt: sql<Date | null>`coalesce(${success.completedAt}, ${success.startedAt})`.as('lastSuccessAt'),
      totalSize: latest.totalSize,
      errorsCount: latest.errorCount,
      hasJobs: sql<boolean>`(${latest.deviceId} is not null)`.as('hasJobs'),
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(latest, and(eq(latest.deviceId, devices.id), eq(latest.rn, 1)))
    .leftJoin(success, and(eq(success.deviceId, devices.id), eq(success.rn, 1)))
    .where(and(...conditions))
    .orderBy(...orderExprs(breezeNameExpr, breezeKeyExpr))
    .limit(limit);
}

// ── provider leg ───────────────────────────────────────────────────────────

function buildProviderLeg(
  scope: BackupHealthScope,
  opts: BackupHealthListOptions,
  cursor: BackupHealthCursor | null,
  limit: number,
) {
  const conditions: Array<SQL | undefined> = [inArray(backupProviderDevices.orgId, scope.orgIds)];

  if (scope.siteIds) {
    // A site-restricted caller sees provider rows only through a linked device
    // that is in one of their sites. An unlinked row has no site to attribute,
    // so it is withheld rather than shown to everyone.
    conditions.push(isNotNull(backupProviderDevices.breezeDeviceId));
    conditions.push(inArray(devices.siteId, scope.siteIds));
  }

  if (opts.filter?.status?.length) {
    conditions.push(inArray(backupProviderDevices.status, opts.filter.status));
  }

  const pattern = searchPattern(opts.filter?.search);
  if (pattern) {
    conditions.push(
      or(
        ilike(backupProviderDevices.vendorDeviceName, pattern),
        ilike(backupProviderDevices.computerName, pattern),
        ilike(organizations.name, pattern),
      ) as SQL,
    );
  }
  conditions.push(keysetPredicate(providerNameExpr, providerKeyExpr, cursor));

  return db
    .select({
      key: providerKeyExpr.as('key'),
      id: backupProviderDevices.id,
      orgId: backupProviderDevices.orgId,
      orgName: organizations.name,
      provider: backupProviderDevices.provider,
      portalShowProviderName: backupProviderDevices.portalShowProviderName,
      name: providerNameExpr.as('name'),
      computerName: backupProviderDevices.computerName,
      osType: backupProviderDevices.osType,
      accountType: backupProviderDevices.accountType,
      dataSources: backupProviderDevices.dataSources,
      status: backupProviderDevices.status,
      lastSessionAt: backupProviderDevices.lastSessionAt,
      lastSuccessAt: backupProviderDevices.lastSuccessAt,
      selectedBytes: backupProviderDevices.selectedBytes,
      usedBytes: backupProviderDevices.usedBytes,
      errorsCount: backupProviderDevices.errorsCount,
      breezeDeviceId: backupProviderDevices.breezeDeviceId,
      deviceStatus: sql<string | null>`${devices.status}`.as('deviceStatus'),
      deviceSiteId: sql<string | null>`${devices.siteId}`.as('deviceSiteId'),
      // LEFT JOIN, and NULL here means "invisible under this caller's RLS", not
      // "inactive" — backup_provider_connections is partner-axis while these
      // rows are org-axis, so an org token legitimately sees one and not the
      // other. isConnectionStale() reads the null accordingly.
      connectionIsActive: sql<boolean | null>`${backupProviderConnections.isActive}`.as('connectionIsActive'),
      connectionLastSyncAt: sql<Date | null>`${backupProviderConnections.lastSyncAt}`.as('connectionLastSyncAt'),
      connectionSyncIntervalMinutes: sql<number | null>`${backupProviderConnections.syncIntervalMinutes}`.as('connectionSyncIntervalMinutes'),
    })
    .from(backupProviderDevices)
    .innerJoin(organizations, eq(organizations.id, backupProviderDevices.orgId))
    .leftJoin(devices, eq(devices.id, backupProviderDevices.breezeDeviceId))
    .leftJoin(backupProviderConnections, eq(backupProviderConnections.id, backupProviderDevices.connectionId))
    .where(and(...conditions))
    .orderBy(...orderExprs(providerNameExpr, providerKeyExpr))
    .limit(limit);
}

// ── 28-day history attachment ──────────────────────────────────────────────

async function attachHistory(rows: BackupHealthRow[], now: Date): Promise<void> {
  if (rows.length === 0) return;
  const window = buildHistoryWindow(now, BACKUP_HISTORY_DAYS);
  const windowStart = window[0]!;

  const deviceIds = rows.filter((r) => r.source === 'breeze' && r.deviceId).map((r) => r.deviceId!);
  const providerIds = rows.filter((r) => r.source === 'provider').map((r) => r.key.slice('provider:'.length));

  const [jobRows, ledgerRows] = await Promise.all([
    deviceIds.length === 0
      ? Promise.resolve([] as Array<{ deviceId: string; status: BackupJobStatus; at: Date | string | null }>)
      : db
          .select({
            deviceId: backupJobs.deviceId,
            status: backupJobs.status,
            at: sql<Date>`coalesce(${backupJobs.startedAt}, ${backupJobs.createdAt})`.as('at'),
          })
          .from(backupJobs)
          .where(
            and(
              inArray(backupJobs.deviceId, deviceIds),
              // ISO string, never a Date object, inside a raw fragment.
              sql`coalesce(${backupJobs.startedAt}, ${backupJobs.createdAt}) >= ${windowStart}::date`,
            ),
          ),
    providerIds.length === 0
      ? Promise.resolve([] as Array<{ providerDeviceId: string; day: string; status: ExternalBackupStatus }>)
      : db
          .select({
            providerDeviceId: backupProviderDeviceHistory.providerDeviceId,
            day: sql<string>`to_char(${backupProviderDeviceHistory.day}, 'YYYY-MM-DD')`.as('day'),
            status: backupProviderDeviceHistory.status,
          })
          .from(backupProviderDeviceHistory)
          .where(
            and(
              inArray(backupProviderDeviceHistory.providerDeviceId, providerIds),
              sql`${backupProviderDeviceHistory.day} >= ${windowStart}::date`,
            ),
          ),
  ]);

  const byDevice = new Map<string, Array<{ status: BackupJobStatus; at: Date | string | null }>>();
  for (const job of jobRows) {
    const list = byDevice.get(job.deviceId) ?? [];
    list.push({ status: job.status as BackupJobStatus, at: job.at });
    byDevice.set(job.deviceId, list);
  }

  const byProvider = new Map<string, Map<string, ExternalBackupStatus>>();
  for (const row of ledgerRows) {
    const days = byProvider.get(row.providerDeviceId) ?? new Map<string, ExternalBackupStatus>();
    days.set(row.day, row.status);
    byProvider.set(row.providerDeviceId, days);
  }

  for (const row of rows) {
    const observed =
      row.source === 'breeze'
        ? foldJobsIntoDays(byDevice.get(row.deviceId!) ?? [])
        : (byProvider.get(row.key.slice('provider:'.length)) ?? new Map<string, ExternalBackupStatus>());
    row.history28d = fillHistoryWindow(window, observed);
  }
}

// ── list ───────────────────────────────────────────────────────────────────

function wantsSource(opts: BackupHealthListOptions, source: 'breeze' | 'provider'): boolean {
  return !opts.sources || opts.sources.includes(source);
}

export async function listBackupHealthRows(
  scope: BackupHealthScope,
  opts: BackupHealthListOptions,
): Promise<{ rows: BackupHealthRow[]; nextCursor: string | null }> {
  if (scope.orgIds.length === 0 || scope.siteIds?.length === 0) return { rows: [], nextCursor: null };

  const now = opts.now ?? new Date();
  const labels = opts.labels ?? 'vendor';
  const limit = Math.max(1, opts.page.limit);
  const healthFilter = opts.filter?.health?.length ? new Set(opts.filter.health) : null;
  // No health filter => exactly one batch of limit+1. The over-fetch loop only
  // costs anything when a derived predicate is doing the narrowing.
  const batchSize = healthFilter ? Math.min(BACKUP_HEALTH_SCAN_BATCH, (limit + 1) * 4) : limit + 1;

  let cursor = decodeBackupHealthCursor(opts.page.cursor);
  const kept: BackupHealthRow[] = [];
  let exhausted = false;
  let batches = 0;

  while (kept.length < limit + 1 && !exhausted && batches < BACKUP_HEALTH_MAX_BATCHES) {
    batches += 1;
    const [breezeRaw, providerRaw] = await Promise.all([
      wantsSource(opts, 'breeze')
        ? (buildBreezeLeg(scope, opts, cursor, batchSize) as unknown as Promise<BreezeLegRow[]>)
        : Promise.resolve([] as BreezeLegRow[]),
      wantsSource(opts, 'provider')
        ? (buildProviderLeg(scope, opts, cursor, batchSize) as unknown as Promise<ProviderLegRow[]>)
        : Promise.resolve([] as ProviderLegRow[]),
    ]);

    const breezeRows = breezeRaw.map((r) => toBreezeHealthRow(r, { now }));
    const providerRows = providerRaw.map((r) => toProviderHealthRow(r, { now, labels }));
    const merged = mergeSortedRows(breezeRows, providerRows, batchSize);
    if (merged.length === 0) break;

    // Both legs short AND nothing was dropped by the merge's own limit => the
    // scan reached the end of the feed.
    exhausted =
      breezeRows.length < batchSize &&
      providerRows.length < batchSize &&
      merged.length >= breezeRows.length + providerRows.length;

    cursor = cursorFromRow(merged[merged.length - 1]!);
    for (const row of merged) {
      if (healthFilter && !healthFilter.has(row.health)) continue;
      kept.push(row);
      if (kept.length >= limit + 1) break;
    }
  }

  const hasMore = kept.length > limit;
  const rows = kept.slice(0, limit);
  const last = rows[rows.length - 1];

  let nextCursor: string | null = null;
  if (hasMore && last) {
    nextCursor = encodeBackupHealthCursor(cursorFromRow(last));
  } else if (!exhausted && cursor) {
    // The batch cap stopped a health-filtered scan mid-feed. Hand back where we
    // got to so the client keeps walking rather than believing the fleet ends
    // here.
    nextCursor = encodeBackupHealthCursor(cursor);
  }

  await attachHistory(rows, now);
  return { rows, nextCursor };
}

// ── summary ────────────────────────────────────────────────────────────────

export async function summarizeBackupHealth(
  scope: BackupHealthScope,
  opts: BackupHealthSummaryOptions = {},
): Promise<BackupHealthSummary> {
  if (scope.orgIds.length === 0 || scope.siteIds?.length === 0) return emptyBackupHealthSummary();

  const now = opts.now ?? new Date();
  // Same builders as the list, so a filter can never mean two different things
  // between the bars and the table underneath them.
  const listOpts: BackupHealthListOptions = { ...opts, page: { limit: BACKUP_HEALTH_SUMMARY_MAX_ROWS } };
  const [breezeRaw, providerRaw] = await Promise.all([
    wantsSource(listOpts, 'breeze')
      ? (buildBreezeLeg(scope, listOpts, null, BACKUP_HEALTH_SUMMARY_MAX_ROWS) as unknown as Promise<BreezeLegRow[]>)
      : Promise.resolve([] as BreezeLegRow[]),
    wantsSource(listOpts, 'provider')
      ? (buildProviderLeg(scope, listOpts, null, BACKUP_HEALTH_SUMMARY_MAX_ROWS) as unknown as Promise<ProviderLegRow[]>)
      : Promise.resolve([] as ProviderLegRow[]),
  ]);

  if (breezeRaw.length >= BACKUP_HEALTH_SUMMARY_MAX_ROWS || providerRaw.length >= BACKUP_HEALTH_SUMMARY_MAX_ROWS) {
    // Not silent: a partial fleet reported as the whole one is exactly the kind
    // of false assurance this feature exists to remove.
    console.warn(
      `[backupHealthReadModel] summary hit the ${BACKUP_HEALTH_SUMMARY_MAX_ROWS}-row cap for orgs ${scope.orgIds.length}`,
    );
  }

  const rows = [
    ...breezeRaw.map((r) => toBreezeHealthRow(r, { now })),
    ...providerRaw.map((r) => toProviderHealthRow(r, { now, labels: 'vendor' })),
  ].filter((row) => !opts.filter?.health?.length || opts.filter.health.includes(row.health));

  return foldBackupHealthSummary(rows);
}

// ── coverage helpers ───────────────────────────────────────────────────────

export async function getProviderCoverageForDevices(
  orgId: string,
  deviceIds: string[],
): Promise<Map<string, { covered: boolean; health: BackupHealth }>> {
  const out = new Map<string, { covered: boolean; health: BackupHealth }>();
  if (deviceIds.length === 0) return out;

  const rows = await db
    .select({
      breezeDeviceId: backupProviderDevices.breezeDeviceId,
      status: backupProviderDevices.status,
      lastSuccessAt: backupProviderDevices.lastSuccessAt,
      errorsCount: backupProviderDevices.errorsCount,
      connectionIsActive: sql<boolean | null>`${backupProviderConnections.isActive}`.as('connectionIsActive'),
      connectionLastSyncAt: sql<Date | null>`${backupProviderConnections.lastSyncAt}`.as('connectionLastSyncAt'),
      connectionSyncIntervalMinutes: sql<number | null>`${backupProviderConnections.syncIntervalMinutes}`.as('connectionSyncIntervalMinutes'),
    })
    .from(backupProviderDevices)
    .leftJoin(backupProviderConnections, eq(backupProviderConnections.id, backupProviderDevices.connectionId))
    .where(
      and(
        eq(backupProviderDevices.orgId, orgId),
        inArray(backupProviderDevices.breezeDeviceId, deviceIds),
      ),
    );

  const now = new Date();
  for (const row of rows) {
    if (!row.breezeDeviceId) continue;
    const stale = isConnectionStale(
      {
        isActive: row.connectionIsActive,
        lastSyncAt: row.connectionLastSyncAt,
        syncIntervalMinutes: row.connectionSyncIntervalMinutes,
      },
      now,
    );
    const derived = deriveBackupHealth({
      status: row.status,
      lastSuccessAt: row.lastSuccessAt,
      errorsCount: row.errorsCount,
      now,
    });
    const next = { covered: stale ? false : derived.covered, health: stale ? ('unknown' as const) : derived.health };
    const existing = out.get(row.breezeDeviceId);
    // The partial unique index makes two rows per device a post-acquisition
    // corner, not the norm — but if it happens, coverage is the OR.
    out.set(
      row.breezeDeviceId,
      existing ? { covered: existing.covered || next.covered, health: existing.covered ? existing.health : next.health } : next,
    );
  }
  return out;
}

export async function getFirstPartyCoverageForDevices(
  orgId: string,
  deviceIds: string[],
): Promise<Map<string, { covered: boolean; health: BackupHealth; status: ExternalBackupStatus; lastSuccessAt: string | null }>> {
  const out = new Map<string, { covered: boolean; health: BackupHealth; status: ExternalBackupStatus; lastSuccessAt: string | null }>();
  if (deviceIds.length === 0) return out;

  const latest = latestJobSubquery([orgId]);
  const success = latestSuccessSubquery([orgId]);
  const rows = await db
    .select({
      deviceId: devices.id,
      jobStatus: sql<BackupJobStatus | null>`${latest.status}`.as('jobStatus'),
      lastSuccessAt: sql<Date | null>`coalesce(${success.completedAt}, ${success.startedAt})`.as('lastSuccessAt'),
      errorsCount: latest.errorCount,
    })
    .from(devices)
    .leftJoin(latest, and(eq(latest.deviceId, devices.id), eq(latest.rn, 1)))
    .leftJoin(success, and(eq(success.deviceId, devices.id), eq(success.rn, 1)))
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)));

  const now = new Date();
  for (const row of rows) {
    const projected = toBreezeHealthRow(
      {
        key: `breeze:${row.deviceId}`,
        orgId,
        orgName: '',
        siteId: null,
        deviceId: row.deviceId,
        name: '',
        computerName: null,
        deviceRole: null,
        deviceStatus: 'offline',
        jobStatus: row.jobStatus,
        lastSessionAt: null,
        lastSuccessAt: row.lastSuccessAt,
        totalSize: null,
        errorsCount: row.errorsCount,
        hasJobs: row.jobStatus != null,
      },
      { now },
    );
    out.set(row.deviceId, {
      covered: projected.covered,
      health: projected.health,
      status: projected.status,
      lastSuccessAt: projected.lastSuccessAt,
    });
  }
  return out;
}

// ── attention items ────────────────────────────────────────────────────────

export async function getProviderAttentionItems(
  orgId: string,
  opts: { allowedDeviceIds: string[] | null; limit: number; now?: Date },
): Promise<Array<{ id: string; title: string; description: string; severity: 'critical' }>> {
  const conditions: Array<SQL | undefined> = [eq(backupProviderDevices.orgId, orgId)];
  if (opts.allowedDeviceIds) {
    // Site-restricted: only rows attributable to a device this caller may see.
    // `allowedSiteIds` was already resolved into device ids by the route.
    conditions.push(
      opts.allowedDeviceIds.length > 0
        ? inArray(backupProviderDevices.breezeDeviceId, opts.allowedDeviceIds)
        : sql`false`,
    );
  }

  const rows = await db
    .select({
      id: backupProviderDevices.id,
      name: backupProviderDevices.vendorDeviceName,
      // Partner-axis LEFT JOIN: null under an org token (D-11).
      customerName: sql<string | null>`${backupProviderCustomers.vendorCustomerName}`.as('customerName'),
      orgName: organizations.name,
      status: backupProviderDevices.status,
      lastSuccessAt: backupProviderDevices.lastSuccessAt,
      errorsCount: backupProviderDevices.errorsCount,
      connectionIsActive: sql<boolean | null>`${backupProviderConnections.isActive}`.as('connectionIsActive'),
      connectionLastSyncAt: sql<Date | null>`${backupProviderConnections.lastSyncAt}`.as('connectionLastSyncAt'),
      connectionSyncIntervalMinutes: sql<number | null>`${backupProviderConnections.syncIntervalMinutes}`.as('connectionSyncIntervalMinutes'),
    })
    .from(backupProviderDevices)
    .innerJoin(organizations, eq(organizations.id, backupProviderDevices.orgId))
    .leftJoin(backupProviderCustomers, eq(backupProviderCustomers.id, backupProviderDevices.customerId))
    .leftJoin(backupProviderConnections, eq(backupProviderConnections.id, backupProviderDevices.connectionId))
    .where(and(...conditions))
    .limit(opts.limit * 4);

  const now = opts.now ?? new Date();
  const items: Array<{ id: string; title: string; description: string; severity: 'critical' }> = [];
  for (const row of rows) {
    const stale = isConnectionStale(
      {
        isActive: row.connectionIsActive,
        lastSyncAt: row.connectionLastSyncAt,
        syncIntervalMinutes: row.connectionSyncIntervalMinutes,
      },
      now,
    );
    const health = stale
      ? 'unknown'
      : deriveBackupHealth({ status: row.status, lastSuccessAt: row.lastSuccessAt, errorsCount: row.errorsCount, now }).health;
    if (health !== 'critical') continue;
    items.push({
      id: `provider:${row.id}`,
      title: `${row.name}: external backup needs attention`,
      // D-11: the customer name is partner-axis, so it is null for an org
      // token. The mapped org's name is the faithful stand-in — it IS the
      // customer, spelled the way Breeze spells it.
      description: `${row.name} (${row.customerName ?? row.orgName}) — ${row.status}`,
      severity: 'critical',
    });
    if (items.length >= opts.limit) break;
  }
  return items;
}
```

- [ ] **Step 4: Run the unit test green**

```bash
cd apps/api && npx vitest run src/services/backupHealthReadModel.test.ts
```
Expected: 1 file, 27 tests passing.

- [ ] **Step 5: Write the live-DB test the mocks cannot cover**

```ts
// apps/api/src/__tests__/integration/backupHealthReadModel.integration.test.ts
//
// Three claims that only a real database and real policies can settle:
//   1. an ORG token reads its provider device rows while the partner-axis
//      connection row stays invisible — and the rows are NOT marked stale;
//   2. a site-restricted caller loses unlinked provider rows entirely;
//   3. a device that is both first-party backed up and provider-linked yields
//      two rows and ONE endpoint in the summary.
//
// Everything above is a LEFT JOIN interacting with RLS, which a Drizzle mock
// asserts the shape of but can never actually exercise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { listBackupHealthRows, summarizeBackupHealth } from '../../services/backupHealthReadModel';
// …seed helpers: create partner, two orgs, a site, two devices, a backup_provider
// connection + customer + two device rows (one linked to device 1, one unlinked),
// and one completed backup_jobs row for device 1. Use the suite's existing
// integration fixtures (see apps/api/src/__tests__/integration/ for the
// partner/org/device builders the other suites share).

describe('backupHealthReadModel against real policies', () => {
  it('an org token sees its provider rows and treats the invisible connection as fresh', async () => {
    await withDbAccessContext({ scope: 'organization', orgId, userId, partnerId }, async () => {
      const { rows } = await listBackupHealthRows({ orgIds: [orgId] }, { page: { limit: 50 } });
      const providerRow = rows.find((r) => r.source === 'provider');
      expect(providerRow).toBeDefined();
      // The connection row itself is partner-axis and must NOT be readable.
      expect(providerRow!.stale).toBe(false);
      expect(providerRow!.health).not.toBe('unknown');
    });
  });

  it('a site-restricted caller loses unlinked provider rows', async () => {
    await withDbAccessContext({ scope: 'organization', orgId, userId, partnerId }, async () => {
      const { rows } = await listBackupHealthRows({ orgIds: [orgId], siteIds: [siteId] }, { page: { limit: 50 } });
      expect(rows.filter((r) => r.source === 'provider' && r.deviceId === null)).toEqual([]);
      expect(rows.some((r) => r.source === 'provider' && r.deviceId === deviceOneId)).toBe(true);
    });
  });

  it('emits two rows and one endpoint for a dual-source device', async () => {
    await withDbAccessContext({ scope: 'partner', partnerId, userId }, async () => {
      const { rows } = await listBackupHealthRows({ orgIds: [orgId] }, { page: { limit: 50 } });
      expect(rows.filter((r) => r.deviceId === deviceOneId)).toHaveLength(2);
      const summary = await summarizeBackupHealth({ orgIds: [orgId] });
      expect(summary.endpoints.total).toBe(2); // two devices, not three rows
      expect(summary.providerOnly).toBe(1);    // the unlinked vendor endpoint
    });
  });

  it('never drops a device that has no backup jobs', async () => {
    await withDbAccessContext({ scope: 'partner', partnerId, userId }, async () => {
      const { rows } = await listBackupHealthRows({ orgIds: [orgId] }, { page: { limit: 50 } });
      expect(rows.some((r) => r.deviceId === deviceTwoId && r.status === 'no_backups')).toBe(true);
    });
  });
});
```

```bash
pnpm test-stack up   # once for the wave
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupHealthReadModel.integration.test.ts
```
Expected: 4 tests passing.

- [ ] **Step 6: Typecheck and commit**

```bash
cd apps/api && pnpm exec tsc --noEmit
git add apps/api/src/services/backupHealthReadModel.ts \
        apps/api/src/services/backupHealthReadModel.test.ts \
        apps/api/src/__tests__/integration/backupHealthReadModel.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(backup): unified backup-health read model over first-party and provider rows

W03 Task 3. Two legs — every active Breeze device joined to its newest run and
its newest RESTORABLE run, and every provider device row — each ordered by the
same (lower(name), key) under COLLATE "C" and merged in JS. No UNION ALL: the
column lists would need ~20 casts per leg to line up, and the merge of two
streams ordered by the global key returns the identical page.

Two contracts the tests pin: a device with no backup_jobs row is a row with
status 'no_backups', never an absence; and site is enforced HERE, because RLS
defends org and partner but cannot see the site axis — so an unlinked provider
row, which has no site to attribute, is withheld from a site-restricted caller.

The connection LEFT JOIN is deliberately NULL-tolerant: org tokens cannot read
the partner-axis connection table, and reading that null as "inactive" would
blank every provider row for every customer-scoped user.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The route — `GET /backup/health/devices`

**Files:**
- Create: `apps/api/src/routes/backup/health.ts`
- Create: `apps/api/src/routes/backup/health.test.ts`
- Modify: `apps/api/src/routes/backup/schemas.ts` (add after `backupHealthQuerySchema`, `:222-224`)
- Modify: `apps/api/src/routes/backup/index.ts:39` (mount next to `dashboardRoutes`)

**Interfaces:**

Consumes: `listBackupHealthRows`, `summarizeBackupHealth` (Task 3); `BACKUP_HEALTH_DEFAULT_LIMIT`, `BACKUP_HEALTH_MAX_LIMIT` (Task 1); `requirePermission` + `PERMISSIONS.BACKUP_READ`; `auth.accessibleOrgIds` / `auth.canAccessOrg` / `auth.allowedSiteIds` (`apps/api/src/middleware/auth.ts:113-163`); `backupProviderConnections` for the partner-scope `unmappedDevices` roll-up.

Produces:
```ts
export const backupHealthRoutes: Hono;
// GET /backup/health/devices
//   ?orgId= &source=breeze|provider &health=…,… &status=…,… &withBackup=true|false &search= &cursor= &limit=
// → 200 { data: { rows: BackupHealthRow[]; summary: BackupHealthSummary;
//                 nextCursor: string | null; stale: boolean; unmappedDevices: number } }
```

**DECISION D-01 — the path is `/backup/health/devices`, not `/backup/health`.**
`GET /backup/health` is already taken: `apps/api/src/routes/backup/verification.ts:69` serves the verification/readiness summary, it is documented at `apps/docs/src/content/docs/backup/api-reference.mdx:143`, and `apps/web/src/components/backup/BackupVerificationOverview.tsx:90` fetches it. Hono is first-match-wins with no fall-through, so mounting a second `/health` before `backupVerificationRoutes` (`routes/backup/index.ts:40`) would **silently shadow** the shipped handler and blank the Verification tab. `/backup/health/devices` is a distinct static path, so both coexist, the file name from the plan index (`routes/backup/health.ts`) is kept, and the `/backup/health` namespace is preserved for the feature. The plan index's route table is amended here and W04/W05 must use the sub-path.

**DECISION D-02 — permission is `PERMISSIONS.BACKUP_READ`.** The spec says `backup:read`; it exists (`packages/shared/src/constants/permissions.ts:16`), is seeded (`apps/api/src/db/seed.ts:112`) and granted to the roles that seed `backup:write` (`seed.ts:316`, `:384`). Sibling backup routes already gate on it (`routes/backup/configs.ts:227`). `dashboard.ts` and `verification.ts` gate on `ORGS_READ` instead — that inconsistency predates this wave and is **not** changed here; touching it would silently widen or narrow access on four shipped endpoints.

**DECISION D-04 — a system-scope caller must pass `?orgId=`.** `accessibleOrgIds` is `null` for system scope (`middleware/auth.ts:113-118`), i.e. "all orgs" with no finite list, and the read model's scope is `orgIds: string[]`. Rather than invent an unbounded cross-partner fleet scan, the route answers `400 { error: 'orgId is required for this scope' }` — the same wording and shape `resolveScopedOrgId` callers already use (`dashboard.ts:279`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/routes/backup/health.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE_A = '11111111-1111-4111-8111-111111111111';

const listMock = vi.fn();
const summarizeMock = vi.fn();
const selectMock = vi.fn();

vi.mock('../../services/backupHealthReadModel', () => ({
  listBackupHealthRows: (...a: unknown[]) => listMock(...(a as [])),
  summarizeBackupHealth: (...a: unknown[]) => summarizeMock(...(a as [])),
}));
vi.mock('../../middleware/auth', () => ({ requirePermission: vi.fn(() => (c: any, next: any) => next()) }));
vi.mock('../../db', () => ({ db: { select: (...a: unknown[]) => selectMock(...(a as [])) } }));
vi.mock('../../db/schema', () => ({
  backupProviderConnections: { partnerId: 'bpn.partner_id', isActive: 'bpn.is_active', lastSyncUnmappedDevices: 'bpn.last_sync_unmapped_devices', lastSyncAt: 'bpn.last_sync_at', syncIntervalMinutes: 'bpn.sync_interval_minutes' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...c: unknown[]) => ({ op: 'and', conditions: c.filter(Boolean) }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
}));

import { backupHealthRoutes } from './health';

const emptySummary = {
  endpoints: { total: 0, covered: 0, uncovered: 0 },
  providerOnly: 0, m365Accounts: 0,
  byStatus: {}, byHealth: {}, byRecency: {},
};

let authState: any;
let permissionsState: any;

function chain(rows: unknown[]) {
  const c: Record<string, any> = {};
  for (const m of ['from', 'where', 'limit']) c[m] = vi.fn(() => Object.assign(Promise.resolve(rows), c));
  c.then = (ok: any, err?: any) => Promise.resolve(rows).then(ok, err);
  return c;
}

describe('GET /backup/health/devices', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({ rows: [], nextCursor: null });
    summarizeMock.mockResolvedValue(emptySummary);
    selectMock.mockImplementation(() => chain([]));
    authState = {
      scope: 'partner', orgId: null, partnerId: 'p1',
      accessibleOrgIds: [ORG_A, ORG_B],
      canAccessOrg: (id: string) => [ORG_A, ORG_B].includes(id),
      allowedSiteIds: undefined,
      user: { id: 'u1' },
    };
    permissionsState = undefined;
    app = new Hono();
    app.use('*', async (c: any, next) => {
      c.set('auth', authState);
      if (permissionsState) c.set('permissions', permissionsState);
      await next();
    });
    app.route('/backup', backupHealthRoutes);
  });

  it('defaults to every accessible org when no orgId is given', async () => {
    const res = await app.request('/backup/health/devices');
    expect(res.status).toBe(200);
    expect(listMock.mock.calls[0]![0]).toEqual({ orgIds: [ORG_A, ORG_B], siteIds: undefined });
  });

  it('narrows to one org when orgId is given and accessible', async () => {
    await app.request(`/backup/health/devices?orgId=${ORG_A}`);
    expect(listMock.mock.calls[0]![0]).toMatchObject({ orgIds: [ORG_A] });
  });

  it('403s for an inaccessible orgId rather than silently narrowing to nothing', async () => {
    const res = await app.request('/backup/health/devices?orgId=99999999-9999-4999-8999-999999999999');
    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('400s for a system-scope caller with no orgId (accessibleOrgIds is null = all orgs)', async () => {
    authState.scope = 'system';
    authState.accessibleOrgIds = null;
    const res = await app.request('/backup/health/devices');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'orgId is required for this scope' });
  });

  it('passes the site ceiling from auth into the scope', async () => {
    authState.allowedSiteIds = [SITE_A];
    await app.request('/backup/health/devices');
    expect(listMock.mock.calls[0]![0]).toEqual({ orgIds: [ORG_A, ORG_B], siteIds: [SITE_A] });
  });

  it('falls back to the permissions context when auth carries no site ceiling', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    await app.request('/backup/health/devices');
    expect(listMock.mock.calls[0]![0]).toMatchObject({ siteIds: [SITE_A] });
  });

  it('parses the filter query into read-model options', async () => {
    await app.request(
      `/backup/health/devices?source=provider&health=critical,warning&status=failed&withBackup=false&search=srv&limit=25&cursor=abc`,
    );
    expect(listMock.mock.calls[0]![1]).toMatchObject({
      sources: ['provider'],
      onlyWithBackup: false,
      filter: { health: ['critical', 'warning'], status: ['failed'], search: 'srv' },
      page: { limit: 25, cursor: 'abc' },
    });
  });

  it('defaults withBackup to true, matching the Cove-email view', async () => {
    await app.request('/backup/health/devices');
    expect(listMock.mock.calls[0]![1]).toMatchObject({ onlyWithBackup: true });
  });

  it('caps limit at BACKUP_HEALTH_MAX_LIMIT', async () => {
    const res = await app.request('/backup/health/devices?limit=5000');
    expect(res.status).toBe(400); // zod max
  });

  it('422s on an unknown health value instead of silently ignoring it', async () => {
    const res = await app.request('/backup/health/devices?health=green');
    expect(res.status).toBe(400);
  });

  it('returns rows, summary and nextCursor under data', async () => {
    listMock.mockResolvedValue({ rows: [{ key: 'breeze:1', stale: false }], nextCursor: 'next' });
    const res = await app.request('/backup/health/devices');
    expect(await res.json()).toMatchObject({
      data: { rows: [{ key: 'breeze:1' }], summary: emptySummary, nextCursor: 'next', stale: false, unmappedDevices: 0 },
    });
  });

  it('reports stale:true when any returned row is stale', async () => {
    listMock.mockResolvedValue({ rows: [{ key: 'provider:1', stale: true }], nextCursor: null });
    const body = await (await app.request('/backup/health/devices')).json();
    expect(body.data.stale).toBe(true);
  });

  it('rolls up unmappedDevices across the partner active connections for a partner caller', async () => {
    selectMock.mockImplementation(() => chain([{ unmapped: 4, isActive: true, lastSyncAt: null, syncIntervalMinutes: 30 }, { unmapped: 3, isActive: true, lastSyncAt: null, syncIntervalMinutes: 30 }]));
    const body = await (await app.request('/backup/health/devices')).json();
    expect(body.data.unmappedDevices).toBe(7);
  });

  it('reports unmappedDevices 0 for an org-scope caller, which cannot read connections', async () => {
    authState.scope = 'organization';
    authState.orgId = ORG_A;
    authState.accessibleOrgIds = [ORG_A];
    const body = await (await app.request('/backup/health/devices')).json();
    expect(body.data.unmappedDevices).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns an empty payload without querying when the site ceiling is empty', async () => {
    authState.allowedSiteIds = [];
    const body = await (await app.request('/backup/health/devices')).json();
    expect(body.data.rows).toEqual([]);
    expect(listMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/backup/health.test.ts
```
Expected: `Failed to resolve import "./health"`.

- [ ] **Step 3: Add the query schema**

In `apps/api/src/routes/backup/schemas.ts`, immediately after `backupHealthQuerySchema` (`:222-224`):

```ts
/** Comma-separated enum list in a query string: `?health=critical,warning`. */
const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.enum(values)).min(1),
  );

export const backupHealthDevicesQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  source: csvEnum(['breeze', 'provider'] as const).optional(),
  health: csvEnum(['healthy', 'warning', 'critical', 'unknown'] as const).optional(),
  status: csvEnum([...EXTERNAL_BACKUP_STATUSES] as unknown as [string, ...string[]]).optional(),
  withBackup: queryBoolean.optional(),
  search: z.string().trim().max(200).optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(BACKUP_HEALTH_MAX_LIMIT).optional(),
});
```

with these imports added at the top of `schemas.ts`:
```ts
import { EXTERNAL_BACKUP_STATUSES } from '@breeze/shared';
import { BACKUP_HEALTH_MAX_LIMIT } from '../../services/backupHealthCursor';
```

- [ ] **Step 4: Implement the route**

```ts
// apps/api/src/routes/backup/health.ts
/**
 * GET /backup/health/devices — the unified backup-health feed.
 *
 * NOT `/backup/health`: that path is the shipped verification/readiness summary
 * (verification.ts:69, documented in apps/docs, fetched by
 * BackupVerificationOverview.tsx:90). Hono is first-match-wins with no
 * fall-through, so re-using it here would silently blank the Verification tab.
 *
 * The handler is deliberately thin — scope in, read model out. Every rule about
 * what a row means lives in services/backupHealthReadModel.ts so the portal and
 * the posture report reach the same verdict from the same code.
 */
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';

import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { backupProviderConnections } from '../../db/schema';
import { requirePermission } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import {
  listBackupHealthRows,
  summarizeBackupHealth,
  type BackupHealthListOptions,
} from '../../services/backupHealthReadModel';
import { BACKUP_HEALTH_DEFAULT_LIMIT } from '../../services/backupHealthCursor';
import { emptyBackupHealthSummary } from '../../services/backupHealthRows';
import { backupHealthDevicesQuerySchema } from './schemas';

export const backupHealthRoutes = new Hono();

/**
 * The caller's site ceiling. `auth.allowedSiteIds` is primary (the auth
 * middleware always populates it); the `permissions` fallback exists because
 * `c.get('permissions')` is only set by `requirePermission`. Reading both can
 * only ever make this stricter. Mirrors verification.ts:47-52 — duplicated
 * rather than exported from there because that helper is file-local and the
 * duplication keeps the literal `allowedSiteIds` token in THIS handler, which
 * is what __tests__/helpers/routeScan.ts:233 scans for.
 */
function callerAllowedSiteIds(
  auth: { allowedSiteIds?: string[] } | undefined,
  c: { get(key: 'permissions'): unknown },
): string[] | undefined {
  return auth?.allowedSiteIds ?? (c.get('permissions') as UserPermissions | undefined)?.allowedSiteIds;
}

backupHealthRoutes.get(
  '/health/devices',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('query', backupHealthDevicesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    // Org scope. An explicit ?orgId must be accessible — pre-checking rather
    // than leaning on RLS means the caller learns the filter was rejected
    // instead of reading an empty fleet as "all clear".
    let orgIds: string[];
    if (query.orgId) {
      if (!auth.canAccessOrg(query.orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      orgIds = [query.orgId];
    } else if (Array.isArray(auth.accessibleOrgIds)) {
      orgIds = auth.accessibleOrgIds;
    } else {
      // system scope: accessibleOrgIds === null means "all orgs" with no finite
      // list. Rather than invent an unbounded cross-partner scan, ask for one.
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const siteIds = callerAllowedSiteIds(auth, c);
    const summary = emptyBackupHealthSummary();

    if (orgIds.length === 0 || siteIds?.length === 0) {
      // A caller who can see nothing has not observed a healthy fleet; the
      // all-zero summary says exactly that.
      return c.json({ data: { rows: [], summary, nextCursor: null, stale: false, unmappedDevices: 0 } });
    }

    const opts: BackupHealthListOptions = {
      sources: query.source,
      // The Cove-email default: rows with backup evidence. The overview's
      // "Include devices without any backup" toggle sends withBackup=false.
      onlyWithBackup: query.withBackup ?? true,
      filter: { health: query.health, status: query.status, search: query.search },
      page: { limit: query.limit ?? BACKUP_HEALTH_DEFAULT_LIMIT, cursor: query.cursor ?? null },
    };
    const scope = { orgIds, siteIds };

    const [page, totals, unmappedDevices] = await Promise.all([
      listBackupHealthRows(scope, opts),
      summarizeBackupHealth(scope, { sources: opts.sources, onlyWithBackup: opts.onlyWithBackup, filter: opts.filter }),
      resolveUnmappedDevices(auth),
    ]);

    return c.json({
      data: {
        rows: page.rows,
        summary: totals,
        nextCursor: page.nextCursor,
        // Drives the overview's "data as of" banner. True when ANY row on this
        // page is backed by evidence we no longer trust.
        stale: page.rows.some((row) => row.stale),
        unmappedDevices,
      },
    });
  },
);

/**
 * "N devices under unmapped customers" — the Huntress-style honesty counter, so
 * a partner-wide view never implies complete vendor coverage.
 *
 * `backup_provider_connections` is partner-axis, so this is meaningful only for
 * a partner/system caller; an org token would read zero rows through RLS
 * anyway, and short-circuiting saves the round-trip.
 */
async function resolveUnmappedDevices(auth: { scope: string; partnerId: string | null }): Promise<number> {
  if (auth.scope !== 'partner' && auth.scope !== 'system') return 0;
  if (!auth.partnerId) return 0;
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${backupProviderConnections.lastSyncUnmappedDevices}), 0)::int` })
    .from(backupProviderConnections)
    .where(and(eq(backupProviderConnections.partnerId, auth.partnerId), eq(backupProviderConnections.isActive, true)));
  return row?.total ?? 0;
}
```

- [ ] **Step 5: Mount it**

In `apps/api/src/routes/backup/index.ts`, add the import next to the others and the mount immediately after `dashboardRoutes` (`:39`):

```ts
import { backupHealthRoutes } from './health';
// …
backupRoutes.route('/', dashboardRoutes);
// GET /backup/health/devices. Mounted AFTER dashboardRoutes and BEFORE
// backupVerificationRoutes is irrelevant for correctness — '/health/devices'
// and '/health' are distinct static paths — but keeping the two health
// surfaces adjacent makes the split obvious to the next reader.
backupRoutes.route('/', backupHealthRoutes);
backupRoutes.route('/', backupVerificationRoutes);
```

- [ ] **Step 6: Run the route tests, plus the shadowing guard**

```bash
cd apps/api && npx vitest run src/routes/backup/health.test.ts src/routes/backup/verification.siteScope.test.ts
```
Expected: `health.test.ts` 14 passing; `verification.siteScope.test.ts` still green — that suite requests `/backup/health` directly (`:81`, `:108`, `:129`, `:151`) and is the regression guard that the new mount did not shadow the old one.

- [ ] **Step 7: Commit**

```bash
cd apps/api && pnpm exec tsc --noEmit
git add apps/api/src/routes/backup/health.ts apps/api/src/routes/backup/health.test.ts \
        apps/api/src/routes/backup/schemas.ts apps/api/src/routes/backup/index.ts
git commit -m "$(cat <<'EOF'
feat(backup): GET /backup/health/devices over the unified read model

W03 Task 4. NOT /backup/health — that path is the shipped verification/readiness
summary (verification.ts:69, documented, fetched by BackupVerificationOverview),
and Hono is first-match-wins with no fall-through, so re-using it would have
silently blanked the Verification tab. verification.siteScope.test.ts is the
regression guard.

Gated on backup:read (the spec's permission; it exists and is seeded) rather
than the ORGS_READ the neighbouring backup read routes happen to use — that
inconsistency predates this wave and is left alone.

A system-scope caller must name an org: accessibleOrgIds is null for system
scope, and the alternative to a 400 is an unbounded cross-partner scan.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Dashboard — provider-aware coverage and attention

**Files:**
- Modify: `apps/api/src/routes/backup/dashboard.ts` (`:275-419`, the `/dashboard` handler)
- Modify: `apps/api/src/routes/backup/dashboard.test.ts`

**Interfaces:**

Consumes: `getProviderCoverageForDevices`, `getFirstPartyCoverageForDevices`, `getProviderAttentionItems` (Task 3); the existing `resolveSiteAllowedDeviceIds` (`dashboard.ts:26-30`), `resolveAllBackupAssignedDevices` (`services/featureConfigResolver`), `resolveAttentionItems` (`dashboard.ts:64-175`).

Produces: two additions to the `/backup/dashboard` response `data`:
```ts
overdueDevices: Array<{ id: string; name: string; lastBackup: string | null }>;   // NEW key
attentionItems: AttentionItem[];  // now also carries `provider:<row id>` entries
```

**DECISION D-13 — `/backup/dashboard` starts emitting `overdueDevices`.**
`apps/web/src/components/backup/BackupDashboard.tsx:136-142` has read `overview.overdueDevices` (or `devicesOverdue`) since the page was written, and `BackupOverviewContent.tsx:369-406` renders a whole "Devices needing backup" panel plus a "Run overdue backups" button from it — but `dashboard.ts:386-418` has never sent either key, so the panel has always rendered its empty state and the button has always been disabled. The spec says "its overdue *devices needing backup* computation uses the read model's `covered`", which presumes the computation exists. It does not, so W03 adds it: assigned devices whose first-party coverage is false **and** whose provider coverage is false. Adding the key is additive and the web already tolerates its absence, so nothing regresses if this ships before the web change.

**DECISION D-11 — provider attention items name the mapped org when the customer row is invisible** (implemented in Task 3's `getProviderAttentionItems`).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/backup/dashboard.test.ts` (inside the existing top-level `describe('backup dashboard routes')`), and add the read-model mock next to the existing `vi.mock` block at `:72-78`:

```ts
const getProviderCoverageMock = vi.fn(async () => new Map());
const getFirstPartyCoverageMock = vi.fn(async () => new Map());
const getProviderAttentionItemsMock = vi.fn(async () => [] as unknown[]);

vi.mock('../../services/backupHealthReadModel', () => ({
  getProviderCoverageForDevices: (...a: unknown[]) => getProviderCoverageMock(...(a as [])),
  getFirstPartyCoverageForDevices: (...a: unknown[]) => getFirstPartyCoverageMock(...(a as [])),
  getProviderAttentionItems: (...a: unknown[]) => getProviderAttentionItemsMock(...(a as [])),
}));
```

```ts
  describe('provider-aware coverage', () => {
    it('lists an assigned device with no fresh backup under overdueDevices', async () => {
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
        { deviceId: DEVICE_ID, configId: 'config-1', featureLinkId: 'feature-1' },
      ]);
      getFirstPartyCoverageMock.mockResolvedValueOnce(
        new Map([[DEVICE_ID, { covered: false, health: 'critical', status: 'failed', lastSuccessAt: null }]]),
      );
      getProviderCoverageMock.mockResolvedValueOnce(new Map());

      const body = await (await app.request('/backup/dashboard')).json();

      expect(body.data.overdueDevices).toEqual([
        expect.objectContaining({ id: DEVICE_ID, lastBackup: null }),
      ]);
    });

    it('drops a device from overdueDevices when a provider backup covers it', async () => {
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
        { deviceId: DEVICE_ID, configId: 'config-1', featureLinkId: 'feature-1' },
      ]);
      getFirstPartyCoverageMock.mockResolvedValueOnce(
        new Map([[DEVICE_ID, { covered: false, health: 'critical', status: 'failed', lastSuccessAt: null }]]),
      );
      getProviderCoverageMock.mockResolvedValueOnce(
        new Map([[DEVICE_ID, { covered: true, health: 'healthy' }]]),
      );

      const body = await (await app.request('/backup/dashboard')).json();

      expect(body.data.overdueDevices).toEqual([]);
    });

    it('counts a provider-covered device as protected', async () => {
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
      getProviderCoverageMock.mockResolvedValueOnce(
        new Map([[DEVICE_ID, { covered: true, health: 'healthy' }]]),
      );

      const body = await (await app.request('/backup/dashboard')).json();

      expect(body.data.coverage.protectedDevices).toBe(1);
    });

    it('appends critical provider rows to attentionItems with a provider: id', async () => {
      getProviderAttentionItemsMock.mockResolvedValueOnce([
        { id: 'provider:row-1', title: 'ACME-SRV02: external backup needs attention', description: 'ACME-SRV02 (Acme North) — failed', severity: 'critical' },
      ]);

      const body = await (await app.request('/backup/dashboard')).json();

      expect(body.data.attentionItems).toContainEqual(
        expect.objectContaining({ id: 'provider:row-1', severity: 'critical' }),
      );
    });

    it('passes the site-allowed device ids to the provider attention query', async () => {
      permissionsState = { allowedSiteIds: [SITE_A] };
      selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]));

      await app.request('/backup/dashboard');

      expect(getProviderAttentionItemsMock.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: [DEVICE_ID] });
    });

    it('survives a read-model failure without 500ing the dashboard', async () => {
      getProviderCoverageMock.mockRejectedValueOnce(new Error('boom'));
      getProviderAttentionItemsMock.mockRejectedValueOnce(new Error('boom'));

      const res = await app.request('/backup/dashboard');

      expect(res.status).toBe(200);
      const body = await res.json();
      // Degraded, but never an implied all-clear.
      expect(body.data.attentionError).toBe(true);
    });
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npx vitest run src/routes/backup/dashboard.test.ts
```
Expected: `expected undefined to deeply equal [...]` on `body.data.overdueDevices` — the key does not exist yet.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/backup/dashboard.ts`, add the import:

```ts
import {
  getFirstPartyCoverageForDevices,
  getProviderAttentionItems,
  getProviderCoverageForDevices,
} from '../../services/backupHealthReadModel';
```

and the helper, next to `resolveAttentionItems`:

```ts
/**
 * "Devices needing backup" — assigned devices with no fresh restore point from
 * EITHER source.
 *
 * Coverage is the OR of the two sources (spec D4): a customer whose servers are
 * protected by Cove is protected, full stop, and listing them here — under a
 * button that dispatches a first-party backup job — is exactly the false
 * negative this integration exists to remove. Both lookups go through the
 * unified read model so this panel, the overview bars, the portal and the
 * posture report cannot disagree about the word "covered".
 */
const OVERDUE_MAX_ITEMS = 20;

async function resolveOverdueDevices(
  orgId: string,
  assignedDeviceIds: string[],
  nameByDeviceId: ReadonlyMap<string, string>,
): Promise<Array<{ id: string; name: string; lastBackup: string | null }>> {
  if (assignedDeviceIds.length === 0) return [];
  const [firstParty, provider] = await Promise.all([
    getFirstPartyCoverageForDevices(orgId, assignedDeviceIds),
    getProviderCoverageForDevices(orgId, assignedDeviceIds),
  ]);
  const overdue: Array<{ id: string; name: string; lastBackup: string | null }> = [];
  for (const deviceId of assignedDeviceIds) {
    if (firstParty.get(deviceId)?.covered) continue;
    if (provider.get(deviceId)?.covered) continue;
    overdue.push({
      id: deviceId,
      name: nameByDeviceId.get(deviceId) ?? deviceId.slice(0, 8),
      lastBackup: firstParty.get(deviceId)?.lastSuccessAt ?? null,
    });
    if (overdue.length >= OVERDUE_MAX_ITEMS) break;
  }
  return overdue;
}
```

Then, inside the `/dashboard` handler after `const protectedDevices = new Set(...)` (`dashboard.ts:368`), replace that line and add the new work:

```ts
  const assignedDeviceIds = assignedDevices.map((a) => a.deviceId);
  const nameByDeviceId = new Map<string, string>(
    recentJobs.map((r) => [r.job.deviceId, r.deviceName ?? r.deviceHostname ?? r.job.deviceId]),
  );

  // One try/catch for the whole provider block: a transient failure here must
  // degrade the panel, not 500 the dashboard — and must SAY it degraded, so the
  // UI never renders "no devices need backup" it cannot vouch for.
  let overdueDevices: Array<{ id: string; name: string; lastBackup: string | null }> = [];
  let providerCoverage = new Map<string, { covered: boolean; health: string }>();
  let providerAttention: AttentionItem[] = [];
  let providerError = false;
  try {
    [overdueDevices, providerCoverage, providerAttention] = await Promise.all([
      resolveOverdueDevices(orgId, assignedDeviceIds, nameByDeviceId),
      getProviderCoverageForDevices(orgId, assignedDeviceIds),
      noSiteAllowedDevices
        ? Promise.resolve([] as AttentionItem[])
        : (getProviderAttentionItems(orgId, {
            allowedDeviceIds,
            limit: ATTENTION_MAX_ITEMS,
          }) as Promise<AttentionItem[]>),
    ]);
  } catch (err) {
    console.error('[BackupDashboard] provider coverage failed:', err instanceof Error ? err.message : err);
    providerError = true;
  }

  // A device the vendor protects counts as protected even when no first-party
  // policy is assigned to it (spec D4).
  const protectedDevices = new Set(assignedDeviceIds);
  for (const [deviceId, coverage] of providerCoverage) {
    if (coverage.covered) protectedDevices.add(deviceId);
  }
```

and in the JSON body (`dashboard.ts:386-418`):

```ts
      coverage: {
        protectedDevices: protectedDevices.size,
      },
      latestJobs,
      // NEW (D-13): the web has rendered this panel from an absent key since it
      // was written. Provider-covered devices are excluded — dispatching a
      // first-party job to a machine Cove already backed up is the false
      // negative this integration removes.
      overdueDevices,
      attentionItems: [...attention.items, ...providerAttention].slice(0, ATTENTION_MAX_ITEMS),
      attentionError: attention.error || providerError,
```

- [ ] **Step 4: Run the tests green**

```bash
cd apps/api && npx vitest run src/routes/backup/dashboard.test.ts
```
Expected: 1 file, all previous tests plus the 6 new ones passing.

- [ ] **Step 5: Commit**

```bash
cd apps/api && pnpm exec tsc --noEmit
git add apps/api/src/routes/backup/dashboard.ts apps/api/src/routes/backup/dashboard.test.ts
git commit -m "$(cat <<'EOF'
feat(backup): dashboard coverage and attention understand provider backups

W03 Task 5. A device with a fresh Cove restore point now counts as protected and
drops out of "devices needing backup"; critical provider rows join the attention
panel as provider:<row id>.

Also starts EMITTING overdueDevices. BackupDashboard.tsx:136 has read that key
and BackupOverviewContent.tsx:369 has rendered a whole panel plus a Run-overdue
button from it since the page was written, but the route never sent it — the
panel has always shown its empty state. The spec's "overdue computation uses
covered" presumes the computation exists, so this wave adds it.

The provider block is wrapped in one try/catch that sets attentionError rather
than 500ing: a swallowed failure rendering as "nothing needs backup" is the
exact class of false assurance this feature exists to remove.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: i18n — `backupProviders.*` and `backupHealth.*` in all 8 locales

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/integrations.json`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/backup.json`
- Modify: `apps/web/src/lib/i18n/translationCoverage.test.ts` (duplicate baselines, only if the suite reports a regression)

**Why this is its own task, first:** `apps/web/src/lib/i18n/localeParity.test.ts:457` compares the flattened key set of every locale against `en`, so keys must land in all 8 files in one commit. Doing that once, up front, keeps Tasks 7–12 to component code and leaves every intermediate commit green. Unused keys are fine — `keyUsage.test.ts:336` only walks keys that a component actually calls.

**Key-design rules applied here:**
- **No `count` interpolation.** `keyUsage.test.ts:228-233` treats a literal `count` option as a plural call and then requires `_one`/`_other` siblings. Counters are rendered as a label in one element and the number in a sibling element (`<dt>`/`<dd>`), and the few inline numbers use `{{value}}`. This also dodges `extractionQuality.test.ts:309`'s ban on `{t('k')}{expr}` adjacency.
- **Reuse `common:`** for Save / Cancel / Delete / Close / Refresh / Status / Organization / Name / Type / Active / Unknown / Online / Offline rather than re-translating them (`apps/web/src/locales/en/common.json` → `actions.*`, `labels.*`, `states.*`).
- **Proper nouns stay byte-identical** in every locale — `localeParity.test.ts:287` counts occurrences of `Breeze`, `Cove`, `Microsoft 365` and fails on a changed count.

- [ ] **Step 1: Add the `integrations.json` keys**

`en/integrations.json` — add `"backup": "Backup"` inside the existing `integrationsPage` block (`:408-433`), and a new top-level `backupProviders` block:

```json
  "backupProviders": {
    "title": "Backup providers",
    "subtitle": "Bring third-party backup status into Breeze. Cove Data Protection is supported today.",
    "partnerOnly": "Backup provider connections are available to partner accounts only.",
    "addConnection": "Add connection",
    "providerLabel": "Provider",
    "cove": "Cove Data Protection",
    "nameLabel": "Connection name",
    "namePlaceholder": "OliveTech Cove",
    "partnerNameLabel": "Cove partner name",
    "usernameLabel": "Username",
    "passwordLabel": "Password",
    "showPassword": "Show password",
    "hidePassword": "Hide password",
    "portalLabelToggle": "Show the provider name in the client portal",
    "portalLabelHelp": "Off by default: customers see \"Managed cloud backup\" instead of the vendor name.",
    "credentialsHelp": "Create a dedicated Cove console user with a read-only role, a unique password and no two-factor authentication. Breeze only reads status; it never changes anything in Cove.",
    "test": "Test connection",
    "syncNow": "Sync now",
    "reauthRequired": "Credentials rejected",
    "reenterCredentials": "Re-enter credentials",
    "lastSync": "Last sync {{relative}}",
    "neverSynced": "Never synced",
    "customers": "Customers",
    "devices": "Devices",
    "linked": "Linked",
    "ambiguous": "Ambiguous",
    "unmappedDevices": "Unmapped devices",
    "unmappedSummary": "{{customers}} unmapped customers, {{devices}} devices",
    "syncErrorTitle": "Last sync failed",
    "empty": "No backup provider is connected yet.",
    "deleteConfirm": "Delete \"{{name}}\"? Its synced devices and history are removed from Breeze. The backup product itself is untouched.",
    "mappingTitle": "Customer mapping",
    "mappingHelp": "Map each provider customer to a Breeze organization. Devices under unmapped customers are counted but never stored.",
    "vendorCustomer": "Provider customer",
    "level": "Level",
    "selectOrganization": "Select organization",
    "keepUnmapped": "Unmapped (kept)",
    "auto": "Auto",
    "autoTitle": "Matched automatically by {{source}}",
    "mappingEmpty": "No customers discovered yet. Run a sync.",
    "testSuccess": "Connection succeeded",
    "testFailed": "Connection failed",
    "testSignedIn": "Signed in as {{name}}",
    "testVisible": "{{value}} customers visible",
    "savedToast": "Backup connection saved",
    "deletedToast": "Backup connection deleted",
    "syncQueuedToast": "Sync queued",
    "mappedToast": "Mapping updated",
    "errorLoad": "Could not load backup connections",
    "errorSave": "Could not save the backup connection",
    "errorTest": "Could not test the backup connection",
    "errorSync": "Could not start a sync",
    "errorDelete": "Could not delete the backup connection",
    "errorMap": "Could not update the mapping"
  },
```

`de-DE/integrations.json` — `integrationsPage.backup`: `"Backup"`; block:

```json
  "backupProviders": {
    "title": "Backup-Anbieter",
    "subtitle": "Holen Sie den Status externer Backups nach Breeze. Cove Data Protection wird bereits unterstützt.",
    "partnerOnly": "Verbindungen zu Backup-Anbietern stehen nur Partnerkonten zur Verfügung.",
    "addConnection": "Verbindung hinzufügen",
    "providerLabel": "Anbieter",
    "cove": "Cove Data Protection",
    "nameLabel": "Name der Verbindung",
    "namePlaceholder": "OliveTech Cove",
    "partnerNameLabel": "Cove-Partnername",
    "usernameLabel": "Benutzername",
    "passwordLabel": "Passwort",
    "showPassword": "Passwort anzeigen",
    "hidePassword": "Passwort verbergen",
    "portalLabelToggle": "Anbieternamen im Kundenportal anzeigen",
    "portalLabelHelp": "Standardmäßig aus: Kunden sehen \"Verwaltetes Cloud-Backup\" statt des Herstellernamens.",
    "credentialsHelp": "Legen Sie einen eigenen Cove-Konsolenbenutzer mit Nur-Lese-Rolle, einem eigenen Passwort und ohne Zwei-Faktor-Authentifizierung an. Breeze liest nur den Status und ändert nichts in Cove.",
    "test": "Verbindung testen",
    "syncNow": "Jetzt synchronisieren",
    "reauthRequired": "Zugangsdaten abgelehnt",
    "reenterCredentials": "Zugangsdaten erneut eingeben",
    "lastSync": "Letzte Synchronisierung {{relative}}",
    "neverSynced": "Nie synchronisiert",
    "customers": "Kunden",
    "devices": "Geräte",
    "linked": "Verknüpft",
    "ambiguous": "Mehrdeutig",
    "unmappedDevices": "Nicht zugeordnete Geräte",
    "unmappedSummary": "{{customers}} nicht zugeordnete Kunden, {{devices}} Geräte",
    "syncErrorTitle": "Letzte Synchronisierung fehlgeschlagen",
    "empty": "Es ist noch kein Backup-Anbieter verbunden.",
    "deleteConfirm": "\"{{name}}\" löschen? Die synchronisierten Geräte und deren Verlauf werden aus Breeze entfernt. Das Backup-Produkt selbst bleibt unberührt.",
    "mappingTitle": "Kundenzuordnung",
    "mappingHelp": "Ordnen Sie jeden Anbieterkunden einer Breeze-Organisation zu. Geräte nicht zugeordneter Kunden werden gezählt, aber nie gespeichert.",
    "vendorCustomer": "Anbieterkunde",
    "level": "Ebene",
    "selectOrganization": "Organisation auswählen",
    "keepUnmapped": "Nicht zugeordnet (beibehalten)",
    "auto": "Automatisch",
    "autoTitle": "Automatisch zugeordnet über {{source}}",
    "mappingEmpty": "Noch keine Kunden gefunden. Starten Sie eine Synchronisierung.",
    "testSuccess": "Verbindung erfolgreich",
    "testFailed": "Verbindung fehlgeschlagen",
    "testSignedIn": "Angemeldet als {{name}}",
    "testVisible": "{{value}} Kunden sichtbar",
    "savedToast": "Backup-Verbindung gespeichert",
    "deletedToast": "Backup-Verbindung gelöscht",
    "syncQueuedToast": "Synchronisierung eingeplant",
    "mappedToast": "Zuordnung aktualisiert",
    "errorLoad": "Backup-Verbindungen konnten nicht geladen werden",
    "errorSave": "Backup-Verbindung konnte nicht gespeichert werden",
    "errorTest": "Backup-Verbindung konnte nicht getestet werden",
    "errorSync": "Synchronisierung konnte nicht gestartet werden",
    "errorDelete": "Backup-Verbindung konnte nicht gelöscht werden",
    "errorMap": "Zuordnung konnte nicht aktualisiert werden"
  },
```

`es-419/integrations.json` — `integrationsPage.backup`: `"Copia de seguridad"`; block:

```json
  "backupProviders": {
    "title": "Proveedores de copia de seguridad",
    "subtitle": "Lleve el estado de las copias de seguridad de terceros a Breeze. Hoy es compatible con Cove Data Protection.",
    "partnerOnly": "Las conexiones con proveedores de copia de seguridad solo están disponibles para cuentas de partner.",
    "addConnection": "Agregar conexión",
    "providerLabel": "Proveedor",
    "cove": "Cove Data Protection",
    "nameLabel": "Nombre de la conexión",
    "namePlaceholder": "OliveTech Cove",
    "partnerNameLabel": "Nombre de partner en Cove",
    "usernameLabel": "Usuario",
    "passwordLabel": "Contraseña",
    "showPassword": "Mostrar contraseña",
    "hidePassword": "Ocultar contraseña",
    "portalLabelToggle": "Mostrar el nombre del proveedor en el portal del cliente",
    "portalLabelHelp": "Desactivado de forma predeterminada: los clientes ven \"Copia de seguridad gestionada en la nube\" en lugar del nombre del fabricante.",
    "credentialsHelp": "Cree un usuario dedicado de la consola de Cove con rol de solo lectura, una contraseña única y sin autenticación de dos factores. Breeze solo lee el estado; nunca modifica nada en Cove.",
    "test": "Probar conexión",
    "syncNow": "Sincronizar ahora",
    "reauthRequired": "Credenciales rechazadas",
    "reenterCredentials": "Volver a ingresar las credenciales",
    "lastSync": "Última sincronización {{relative}}",
    "neverSynced": "Nunca sincronizado",
    "customers": "Clientes",
    "devices": "Dispositivos",
    "linked": "Vinculados",
    "ambiguous": "Ambiguos",
    "unmappedDevices": "Dispositivos sin asignar",
    "unmappedSummary": "{{customers}} clientes sin asignar, {{devices}} dispositivos",
    "syncErrorTitle": "La última sincronización falló",
    "empty": "Todavía no hay ningún proveedor de copia de seguridad conectado.",
    "deleteConfirm": "¿Eliminar \"{{name}}\"? Sus dispositivos sincronizados y su historial se quitan de Breeze. El producto de copia de seguridad no se toca.",
    "mappingTitle": "Asignación de clientes",
    "mappingHelp": "Asigne cada cliente del proveedor a una organización de Breeze. Los dispositivos de clientes sin asignar se cuentan, pero nunca se almacenan.",
    "vendorCustomer": "Cliente del proveedor",
    "level": "Nivel",
    "selectOrganization": "Seleccionar organización",
    "keepUnmapped": "Sin asignar (se mantiene)",
    "auto": "Automático",
    "autoTitle": "Asignado automáticamente por {{source}}",
    "mappingEmpty": "Todavía no se detectaron clientes. Ejecute una sincronización.",
    "testSuccess": "Conexión correcta",
    "testFailed": "Error de conexión",
    "testSignedIn": "Sesión iniciada como {{name}}",
    "testVisible": "{{value}} clientes visibles",
    "savedToast": "Conexión de copia de seguridad guardada",
    "deletedToast": "Conexión de copia de seguridad eliminada",
    "syncQueuedToast": "Sincronización en cola",
    "mappedToast": "Asignación actualizada",
    "errorLoad": "No se pudieron cargar las conexiones de copia de seguridad",
    "errorSave": "No se pudo guardar la conexión de copia de seguridad",
    "errorTest": "No se pudo probar la conexión de copia de seguridad",
    "errorSync": "No se pudo iniciar la sincronización",
    "errorDelete": "No se pudo eliminar la conexión de copia de seguridad",
    "errorMap": "No se pudo actualizar la asignación"
  },
```

`fr-FR/integrations.json` — `integrationsPage.backup`: `"Sauvegarde"`; block:

```json
  "backupProviders": {
    "title": "Fournisseurs de sauvegarde",
    "subtitle": "Remontez l'état des sauvegardes tierces dans Breeze. Cove Data Protection est pris en charge dès aujourd'hui.",
    "partnerOnly": "Les connexions aux fournisseurs de sauvegarde sont réservées aux comptes partenaires.",
    "addConnection": "Ajouter une connexion",
    "providerLabel": "Fournisseur",
    "cove": "Cove Data Protection",
    "nameLabel": "Nom de la connexion",
    "namePlaceholder": "OliveTech Cove",
    "partnerNameLabel": "Nom du partenaire Cove",
    "usernameLabel": "Identifiant",
    "passwordLabel": "Mot de passe",
    "showPassword": "Afficher le mot de passe",
    "hidePassword": "Masquer le mot de passe",
    "portalLabelToggle": "Afficher le nom du fournisseur dans le portail client",
    "portalLabelHelp": "Désactivé par défaut : les clients voient « Sauvegarde cloud infogérée » au lieu du nom de l'éditeur.",
    "credentialsHelp": "Créez un utilisateur de console Cove dédié, en lecture seule, avec un mot de passe unique et sans authentification à deux facteurs. Breeze lit uniquement l'état et ne modifie rien dans Cove.",
    "test": "Tester la connexion",
    "syncNow": "Synchroniser maintenant",
    "reauthRequired": "Identifiants refusés",
    "reenterCredentials": "Ressaisir les identifiants",
    "lastSync": "Dernière synchronisation {{relative}}",
    "neverSynced": "Jamais synchronisé",
    "customers": "Clients",
    "devices": "Appareils",
    "linked": "Liés",
    "ambiguous": "Ambigus",
    "unmappedDevices": "Appareils non associés",
    "unmappedSummary": "{{customers}} clients non associés, {{devices}} appareils",
    "syncErrorTitle": "Échec de la dernière synchronisation",
    "empty": "Aucun fournisseur de sauvegarde n'est encore connecté.",
    "deleteConfirm": "Supprimer « {{name}} » ? Ses appareils synchronisés et leur historique sont retirés de Breeze. Le produit de sauvegarde lui-même n'est pas touché.",
    "mappingTitle": "Association des clients",
    "mappingHelp": "Associez chaque client du fournisseur à une organisation Breeze. Les appareils des clients non associés sont comptés mais jamais stockés.",
    "vendorCustomer": "Client du fournisseur",
    "level": "Niveau",
    "selectOrganization": "Sélectionner une organisation",
    "keepUnmapped": "Non associé (conservé)",
    "auto": "Automatique",
    "autoTitle": "Associé automatiquement par {{source}}",
    "mappingEmpty": "Aucun client détecté pour l'instant. Lancez une synchronisation.",
    "testSuccess": "Connexion réussie",
    "testFailed": "Échec de la connexion",
    "testSignedIn": "Connecté en tant que {{name}}",
    "testVisible": "{{value}} clients visibles",
    "savedToast": "Connexion de sauvegarde enregistrée",
    "deletedToast": "Connexion de sauvegarde supprimée",
    "syncQueuedToast": "Synchronisation planifiée",
    "mappedToast": "Association mise à jour",
    "errorLoad": "Impossible de charger les connexions de sauvegarde",
    "errorSave": "Impossible d'enregistrer la connexion de sauvegarde",
    "errorTest": "Impossible de tester la connexion de sauvegarde",
    "errorSync": "Impossible de lancer la synchronisation",
    "errorDelete": "Impossible de supprimer la connexion de sauvegarde",
    "errorMap": "Impossible de mettre à jour l'association"
  },
```

`fr-CA/integrations.json` — `integrationsPage.backup`: `"Sauvegarde"`; same block as `fr-FR` with the Canadian register (straight quotes, "ouverture de session", "courriel"-style vocabulary):

```json
  "backupProviders": {
    "title": "Fournisseurs de sauvegarde",
    "subtitle": "Remontez l'état des sauvegardes tierces dans Breeze. Cove Data Protection est pris en charge dès maintenant.",
    "partnerOnly": "Les connexions aux fournisseurs de sauvegarde sont réservées aux comptes partenaires.",
    "addConnection": "Ajouter une connexion",
    "providerLabel": "Fournisseur",
    "cove": "Cove Data Protection",
    "nameLabel": "Nom de la connexion",
    "namePlaceholder": "OliveTech Cove",
    "partnerNameLabel": "Nom du partenaire Cove",
    "usernameLabel": "Nom d'utilisateur",
    "passwordLabel": "Mot de passe",
    "showPassword": "Afficher le mot de passe",
    "hidePassword": "Masquer le mot de passe",
    "portalLabelToggle": "Afficher le nom du fournisseur dans le portail client",
    "portalLabelHelp": "Désactivé par défaut : les clients voient \"Sauvegarde infonuagique gérée\" au lieu du nom de l'éditeur.",
    "credentialsHelp": "Créez un utilisateur dédié de la console Cove avec un rôle en lecture seule, un mot de passe unique et sans authentification à deux facteurs. Breeze lit seulement l'état et ne modifie rien dans Cove.",
    "test": "Tester la connexion",
    "syncNow": "Synchroniser maintenant",
    "reauthRequired": "Identifiants refusés",
    "reenterCredentials": "Saisir de nouveau les identifiants",
    "lastSync": "Dernière synchronisation {{relative}}",
    "neverSynced": "Jamais synchronisé",
    "customers": "Clients",
    "devices": "Appareils",
    "linked": "Liés",
    "ambiguous": "Ambigus",
    "unmappedDevices": "Appareils non associés",
    "unmappedSummary": "{{customers}} clients non associés, {{devices}} appareils",
    "syncErrorTitle": "Échec de la dernière synchronisation",
    "empty": "Aucun fournisseur de sauvegarde n'est encore connecté.",
    "deleteConfirm": "Supprimer \"{{name}}\"? Ses appareils synchronisés et leur historique sont retirés de Breeze. Le produit de sauvegarde lui-même n'est pas touché.",
    "mappingTitle": "Association des clients",
    "mappingHelp": "Associez chaque client du fournisseur à une organisation Breeze. Les appareils des clients non associés sont comptés, mais jamais stockés.",
    "vendorCustomer": "Client du fournisseur",
    "level": "Niveau",
    "selectOrganization": "Sélectionner une organisation",
    "keepUnmapped": "Non associé (conservé)",
    "auto": "Automatique",
    "autoTitle": "Associé automatiquement par {{source}}",
    "mappingEmpty": "Aucun client détecté pour l'instant. Lancez une synchronisation.",
    "testSuccess": "Connexion réussie",
    "testFailed": "Échec de la connexion",
    "testSignedIn": "Connecté en tant que {{name}}",
    "testVisible": "{{value}} clients visibles",
    "savedToast": "Connexion de sauvegarde enregistrée",
    "deletedToast": "Connexion de sauvegarde supprimée",
    "syncQueuedToast": "Synchronisation mise en file",
    "mappedToast": "Association mise à jour",
    "errorLoad": "Impossible de charger les connexions de sauvegarde",
    "errorSave": "Impossible d'enregistrer la connexion de sauvegarde",
    "errorTest": "Impossible de tester la connexion de sauvegarde",
    "errorSync": "Impossible de lancer la synchronisation",
    "errorDelete": "Impossible de supprimer la connexion de sauvegarde",
    "errorMap": "Impossible de mettre à jour l'association"
  },
```

`it-IT/integrations.json` — `integrationsPage.backup`: `"Backup"`; block:

```json
  "backupProviders": {
    "title": "Provider di backup",
    "subtitle": "Porta in Breeze lo stato dei backup di terze parti. Oggi è supportato Cove Data Protection.",
    "partnerOnly": "Le connessioni ai provider di backup sono disponibili solo per gli account partner.",
    "addConnection": "Aggiungi connessione",
    "providerLabel": "Provider",
    "cove": "Cove Data Protection",
    "nameLabel": "Nome della connessione",
    "namePlaceholder": "OliveTech Cove",
    "partnerNameLabel": "Nome partner Cove",
    "usernameLabel": "Nome utente",
    "passwordLabel": "Password",
    "showPassword": "Mostra la password",
    "hidePassword": "Nascondi la password",
    "portalLabelToggle": "Mostra il nome del provider nel portale clienti",
    "portalLabelHelp": "Disattivato per impostazione predefinita: i clienti vedono \"Backup cloud gestito\" invece del nome del fornitore.",
    "credentialsHelp": "Crea un utente dedicato della console Cove con ruolo di sola lettura, una password univoca e senza autenticazione a due fattori. Breeze legge solo lo stato e non modifica nulla in Cove.",
    "test": "Prova la connessione",
    "syncNow": "Sincronizza ora",
    "reauthRequired": "Credenziali rifiutate",
    "reenterCredentials": "Inserisci di nuovo le credenziali",
    "lastSync": "Ultima sincronizzazione {{relative}}",
    "neverSynced": "Mai sincronizzato",
    "customers": "Clienti",
    "devices": "Dispositivi",
    "linked": "Collegati",
    "ambiguous": "Ambigui",
    "unmappedDevices": "Dispositivi non associati",
    "unmappedSummary": "{{customers}} clienti non associati, {{devices}} dispositivi",
    "syncErrorTitle": "Ultima sincronizzazione non riuscita",
    "empty": "Nessun provider di backup ancora collegato.",
    "deleteConfirm": "Eliminare \"{{name}}\"? I dispositivi sincronizzati e la loro cronologia vengono rimossi da Breeze. Il prodotto di backup non viene toccato.",
    "mappingTitle": "Associazione dei clienti",
    "mappingHelp": "Associa ogni cliente del provider a un'organizzazione Breeze. I dispositivi dei clienti non associati vengono conteggiati ma mai memorizzati.",
    "vendorCustomer": "Cliente del provider",
    "level": "Livello",
    "selectOrganization": "Seleziona un'organizzazione",
    "keepUnmapped": "Non associato (mantenuto)",
    "auto": "Automatico",
    "autoTitle": "Associato automaticamente tramite {{source}}",
    "mappingEmpty": "Nessun cliente rilevato finora. Avvia una sincronizzazione.",
    "testSuccess": "Connessione riuscita",
    "testFailed": "Connessione non riuscita",
    "testSignedIn": "Accesso eseguito come {{name}}",
    "testVisible": "{{value}} clienti visibili",
    "savedToast": "Connessione di backup salvata",
    "deletedToast": "Connessione di backup eliminata",
    "syncQueuedToast": "Sincronizzazione in coda",
    "mappedToast": "Associazione aggiornata",
    "errorLoad": "Impossibile caricare le connessioni di backup",
    "errorSave": "Impossibile salvare la connessione di backup",
    "errorTest": "Impossibile provare la connessione di backup",
    "errorSync": "Impossibile avviare la sincronizzazione",
    "errorDelete": "Impossibile eliminare la connessione di backup",
    "errorMap": "Impossibile aggiornare l'associazione"
  },
```

`pt-BR/integrations.json` — `integrationsPage.backup`: `"Backup"`; block:

```json
  "backupProviders": {
    "title": "Provedores de backup",
    "subtitle": "Traga o status dos backups de terceiros para o Breeze. Hoje há suporte ao Cove Data Protection.",
    "partnerOnly": "As conexões com provedores de backup estão disponíveis apenas para contas de parceiro.",
    "addConnection": "Adicionar conexão",
    "providerLabel": "Provedor",
    "cove": "Cove Data Protection",
    "nameLabel": "Nome da conexão",
    "namePlaceholder": "OliveTech Cove",
    "partnerNameLabel": "Nome do parceiro no Cove",
    "usernameLabel": "Usuário",
    "passwordLabel": "Senha",
    "showPassword": "Mostrar a senha",
    "hidePassword": "Ocultar a senha",
    "portalLabelToggle": "Mostrar o nome do provedor no portal do cliente",
    "portalLabelHelp": "Desativado por padrão: os clientes veem \"Backup gerenciado em nuvem\" em vez do nome do fabricante.",
    "credentialsHelp": "Crie um usuário dedicado do console do Cove com função somente leitura, uma senha exclusiva e sem autenticação em duas etapas. O Breeze apenas lê o status e nunca altera nada no Cove.",
    "test": "Testar conexão",
    "syncNow": "Sincronizar agora",
    "reauthRequired": "Credenciais recusadas",
    "reenterCredentials": "Informar as credenciais novamente",
    "lastSync": "Última sincronização {{relative}}",
    "neverSynced": "Nunca sincronizado",
    "customers": "Clientes",
    "devices": "Dispositivos",
    "linked": "Vinculados",
    "ambiguous": "Ambíguos",
    "unmappedDevices": "Dispositivos sem mapeamento",
    "unmappedSummary": "{{customers}} clientes sem mapeamento, {{devices}} dispositivos",
    "syncErrorTitle": "A última sincronização falhou",
    "empty": "Nenhum provedor de backup conectado ainda.",
    "deleteConfirm": "Excluir \"{{name}}\"? Os dispositivos sincronizados e o histórico deles saem do Breeze. O produto de backup em si não é alterado.",
    "mappingTitle": "Mapeamento de clientes",
    "mappingHelp": "Mapeie cada cliente do provedor para uma organização do Breeze. Dispositivos de clientes sem mapeamento são contados, mas nunca armazenados.",
    "vendorCustomer": "Cliente do provedor",
    "level": "Nível",
    "selectOrganization": "Selecionar organização",
    "keepUnmapped": "Sem mapeamento (mantido)",
    "auto": "Automático",
    "autoTitle": "Mapeado automaticamente por {{source}}",
    "mappingEmpty": "Nenhum cliente detectado ainda. Execute uma sincronização.",
    "testSuccess": "Conexão bem-sucedida",
    "testFailed": "Falha na conexão",
    "testSignedIn": "Conectado como {{name}}",
    "testVisible": "{{value}} clientes visíveis",
    "savedToast": "Conexão de backup salva",
    "deletedToast": "Conexão de backup excluída",
    "syncQueuedToast": "Sincronização na fila",
    "mappedToast": "Mapeamento atualizado",
    "errorLoad": "Não foi possível carregar as conexões de backup",
    "errorSave": "Não foi possível salvar a conexão de backup",
    "errorTest": "Não foi possível testar a conexão de backup",
    "errorSync": "Não foi possível iniciar a sincronização",
    "errorDelete": "Não foi possível excluir a conexão de backup",
    "errorMap": "Não foi possível atualizar o mapeamento"
  },
```

`tr-TR/integrations.json` — `integrationsPage.backup`: `"Yedekleme"`; block:

```json
  "backupProviders": {
    "title": "Yedekleme sağlayıcıları",
    "subtitle": "Üçüncü taraf yedekleme durumunu Breeze'e taşıyın. Bugün Cove Data Protection destekleniyor.",
    "partnerOnly": "Yedekleme sağlayıcısı bağlantıları yalnızca iş ortağı hesaplarında kullanılabilir.",
    "addConnection": "Bağlantı ekle",
    "providerLabel": "Sağlayıcı",
    "cove": "Cove Data Protection",
    "nameLabel": "Bağlantı adı",
    "namePlaceholder": "OliveTech Cove",
    "partnerNameLabel": "Cove iş ortağı adı",
    "usernameLabel": "Kullanıcı adı",
    "passwordLabel": "Parola",
    "showPassword": "Parolayı göster",
    "hidePassword": "Parolayı gizle",
    "portalLabelToggle": "Sağlayıcı adını müşteri portalında göster",
    "portalLabelHelp": "Varsayılan olarak kapalıdır: müşteriler üretici adı yerine \"Yönetilen bulut yedeklemesi\" ifadesini görür.",
    "credentialsHelp": "Salt okunur role sahip, benzersiz parolalı ve iki adımlı doğrulaması olmayan ayrı bir Cove konsol kullanıcısı oluşturun. Breeze yalnızca durumu okur, Cove üzerinde hiçbir değişiklik yapmaz.",
    "test": "Bağlantıyı sına",
    "syncNow": "Şimdi eşitle",
    "reauthRequired": "Kimlik bilgileri reddedildi",
    "reenterCredentials": "Kimlik bilgilerini yeniden girin",
    "lastSync": "Son eşitleme {{relative}}",
    "neverSynced": "Hiç eşitlenmedi",
    "customers": "Müşteriler",
    "devices": "Cihazlar",
    "linked": "Bağlı",
    "ambiguous": "Belirsiz",
    "unmappedDevices": "Eşlenmemiş cihazlar",
    "unmappedSummary": "{{customers}} eşlenmemiş müşteri, {{devices}} cihaz",
    "syncErrorTitle": "Son eşitleme başarısız oldu",
    "empty": "Henüz bağlı bir yedekleme sağlayıcısı yok.",
    "deleteConfirm": "\"{{name}}\" silinsin mi? Eşitlenen cihazları ve geçmişleri Breeze'den kaldırılır. Yedekleme ürününün kendisine dokunulmaz.",
    "mappingTitle": "Müşteri eşlemesi",
    "mappingHelp": "Her sağlayıcı müşterisini bir Breeze kuruluşuyla eşleyin. Eşlenmemiş müşterilerin cihazları sayılır ama hiçbir zaman saklanmaz.",
    "vendorCustomer": "Sağlayıcı müşterisi",
    "level": "Düzey",
    "selectOrganization": "Kuruluş seçin",
    "keepUnmapped": "Eşlenmemiş (korunuyor)",
    "auto": "Otomatik",
    "autoTitle": "{{source}} ile otomatik eşlendi",
    "mappingEmpty": "Henüz müşteri bulunamadı. Bir eşitleme çalıştırın.",
    "testSuccess": "Bağlantı başarılı",
    "testFailed": "Bağlantı başarısız",
    "testSignedIn": "{{name}} olarak oturum açıldı",
    "testVisible": "{{value}} müşteri görünüyor",
    "savedToast": "Yedekleme bağlantısı kaydedildi",
    "deletedToast": "Yedekleme bağlantısı silindi",
    "syncQueuedToast": "Eşitleme sıraya alındı",
    "mappedToast": "Eşleme güncellendi",
    "errorLoad": "Yedekleme bağlantıları yüklenemedi",
    "errorSave": "Yedekleme bağlantısı kaydedilemedi",
    "errorTest": "Yedekleme bağlantısı sınanamadı",
    "errorSync": "Eşitleme başlatılamadı",
    "errorDelete": "Yedekleme bağlantısı silinemedi",
    "errorMap": "Eşleme güncellenemedi"
  },
```

- [ ] **Step 2: Add the `backup.json` keys**

`en/backup.json` — new top-level `backupHealth` block:

```json
  "backupHealth": {
    "title": "Backup health",
    "subtitle": "Every device Breeze manages, plus everything your backup provider reports.",
    "staleBanner": "Some provider data is out of date. Showing what was last seen.",
    "unmappedNotice": "{{value}} devices sit under provider customers that are not mapped to a Breeze organization yet.",
    "statusTitle": "Status",
    "recencyTitle": "Last successful backup",
    "coverage": "{{covered}} of {{total}} endpoints have a recent backup",
    "providerOnly": "{{value}} provider-only endpoints",
    "m365Accounts": "{{value}} Microsoft 365 accounts",
    "status": {
      "no_backups": "No backups",
      "completed": "Completed",
      "completed_with_errors": "Completed with errors",
      "in_progress": "In process",
      "unsuccessful": "Unsuccessful",
      "other": "Other"
    },
    "recency": {
      "never": "Never",
      "under_24h": "Less than 24 hours",
      "under_48h": "Less than 48 hours",
      "over_48h": "More than 48 hours"
    },
    "health": {
      "healthy": "Healthy",
      "warning": "Needs attention",
      "critical": "Critical",
      "unknown": "Unknown"
    },
    "sourceAll": "All sources",
    "healthAll": "All health",
    "sourceBreeze": "Breeze",
    "searchPlaceholder": "Search device or organization",
    "includeWithoutBackup": "Include devices without any backup",
    "table": {
      "device": "Device",
      "computerName": "Computer name",
      "source": "Source",
      "dataSources": "Data sources",
      "selected": "Selected",
      "used": "Used",
      "history": "Last 28 days",
      "errors": "Errors",
      "agent": "Agent"
    },
    "noObservation": "No observation",
    "openDevice": "Open device",
    "empty": "No devices match these filters.",
    "loadMore": "Load more",
    "error": "Could not load backup health",
    "external": {
      "title": "External backup",
      "customer": "Provider customer",
      "lastSuccess": "Last successful backup",
      "lastSession": "Last session",
      "unlink": "Unlink",
      "unlinkConfirm": "Unlink this provider device from the Breeze device? It stays in the backup product and can be linked again.",
      "unlinkedToast": "Provider device unlinked",
      "errorUnlink": "Could not unlink the provider device",
      "error": "Could not load external backup status",
      "alsoCheck": "Also check third-party backup connections under Integrations."
    }
  },
```

The seven translated catalogs take the same structure. Values (only the leaves differ; keys and interpolation tokens are identical everywhere, which `localeParity.test.ts:465` enforces):

| key | de-DE | es-419 | fr-FR / fr-CA | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|
| `title` | Backup-Zustand | Estado de las copias de seguridad | État des sauvegardes | Stato dei backup | Integridade dos backups | Yedekleme durumu |
| `subtitle` | Jedes von Breeze verwaltete Gerät, plus alles, was Ihr Backup-Anbieter meldet. | Todos los dispositivos que administra Breeze, más todo lo que informa su proveedor de copias de seguridad. | Tous les appareils gérés par Breeze, ainsi que tout ce que remonte votre fournisseur de sauvegarde. | Ogni dispositivo gestito da Breeze, più tutto ciò che segnala il provider di backup. | Todos os dispositivos que o Breeze gerencia, além de tudo o que o provedor de backup informa. | Breeze'in yönettiği her cihaz ve yedekleme sağlayıcınızın bildirdiği her şey. |
| `staleBanner` | Einige Anbieterdaten sind veraltet. Angezeigt wird der zuletzt bekannte Stand. | Algunos datos del proveedor están desactualizados. Se muestra lo último que se vio. | Certaines données du fournisseur ne sont plus à jour. Voici le dernier état connu. | Alcuni dati del provider non sono aggiornati. Viene mostrato l'ultimo stato rilevato. | Alguns dados do provedor estão desatualizados. Mostrando o último estado visto. | Bazı sağlayıcı verileri güncel değil. En son görülen durum gösteriliyor. |
| `unmappedNotice` | {{value}} Geräte gehören zu Anbieterkunden, die noch keiner Breeze-Organisation zugeordnet sind. | {{value}} dispositivos pertenecen a clientes del proveedor que todavía no están asignados a una organización de Breeze. | {{value}} appareils appartiennent à des clients du fournisseur qui ne sont pas encore associés à une organisation Breeze. | {{value}} dispositivi appartengono a clienti del provider non ancora associati a un'organizzazione Breeze. | {{value}} dispositivos pertencem a clientes do provedor que ainda não estão mapeados para uma organização do Breeze. | {{value}} cihaz, henüz bir Breeze kuruluşuyla eşlenmemiş sağlayıcı müşterilerine ait. |
| `statusTitle` | Status | Estado | Statut | Stato | Status | Durum |
| `recencyTitle` | Letzte erfolgreiche Sicherung | Última copia de seguridad correcta | Dernière sauvegarde réussie | Ultimo backup riuscito | Último backup bem-sucedido | Son başarılı yedekleme |
| `coverage` | {{covered}} von {{total}} Endgeräten haben eine aktuelle Sicherung | {{covered}} de {{total}} endpoints tienen una copia de seguridad reciente | {{covered}} des {{total}} postes ont une sauvegarde récente | {{covered}} endpoint su {{total}} hanno un backup recente | {{covered}} de {{total}} endpoints têm um backup recente | {{total}} uç noktadan {{covered}} tanesinin güncel yedeği var |
| `providerOnly` | {{value}} Endgeräte nur beim Anbieter | {{value}} endpoints solo del proveedor | {{value}} postes connus du seul fournisseur | {{value}} endpoint solo del provider | {{value}} endpoints apenas do provedor | Yalnızca sağlayıcıda olan {{value}} uç nokta |
| `m365Accounts` | {{value}} Microsoft 365 Konten | {{value}} cuentas de Microsoft 365 | {{value}} comptes Microsoft 365 | {{value}} account Microsoft 365 | {{value}} contas do Microsoft 365 | {{value}} Microsoft 365 hesabı |
| `status.no_backups` | Keine Sicherungen | Sin copias de seguridad | Aucune sauvegarde | Nessun backup | Sem backups | Yedek yok |
| `status.completed` | Abgeschlossen | Completado | Terminée | Completato | Concluído | Tamamlandı |
| `status.completed_with_errors` | Mit Fehlern abgeschlossen | Completado con errores | Terminée avec des erreurs | Completato con errori | Concluído com erros | Hatalarla tamamlandı |
| `status.in_progress` | In Bearbeitung | En proceso | En cours | In corso | Em andamento | İşleniyor |
| `status.unsuccessful` | Nicht erfolgreich | Sin éxito | Sans succès | Non riuscito | Sem sucesso | Başarısız |
| `status.other` | Sonstige | Otros | Autre | Altro | Outros | Diğer |
| `recency.never` | Nie | Nunca | Jamais | Mai | Nunca | Hiç |
| `recency.under_24h` | Weniger als 24 Stunden | Menos de 24 horas | Moins de 24 heures | Meno di 24 ore | Menos de 24 horas | 24 saatten az |
| `recency.under_48h` | Weniger als 48 Stunden | Menos de 48 horas | Moins de 48 heures | Meno di 48 ore | Menos de 48 horas | 48 saatten az |
| `recency.over_48h` | Mehr als 48 Stunden | Más de 48 horas | Plus de 48 heures | Più di 48 ore | Mais de 48 horas | 48 saatten fazla |
| `health.healthy` | In Ordnung | Correcto | Correct | Integro | Saudável | Sağlıklı |
| `health.warning` | Prüfen | Requiere atención | À surveiller | Da verificare | Requer atenção | İlgi gerekiyor |
| `health.critical` | Kritisch | Crítico | Critique | Critico | Crítico | Kritik |
| `health.unknown` | Unbekannt | Desconocido | Inconnu | Sconosciuto | Desconhecido | Bilinmiyor |
| `sourceAll` | Alle Quellen | Todas las fuentes | Toutes les sources | Tutte le origini | Todas as origens | Tüm kaynaklar |
| `healthAll` | Jeder Zustand | Cualquier estado | Tous les états | Qualsiasi stato | Qualquer estado | Tüm durumlar |
| `sourceBreeze` | Breeze | Breeze | Breeze | Breeze | Breeze | Breeze |
| `searchPlaceholder` | Gerät oder Organisation suchen | Buscar dispositivo u organización | Rechercher un appareil ou une organisation | Cerca un dispositivo o un'organizzazione | Pesquisar dispositivo ou organização | Cihaz veya kuruluş ara |
| `includeWithoutBackup` | Geräte ohne jede Sicherung einbeziehen | Incluir dispositivos sin ninguna copia de seguridad | Inclure les appareils sans aucune sauvegarde | Includi i dispositivi senza alcun backup | Incluir dispositivos sem nenhum backup | Hiç yedeği olmayan cihazları da göster |
| `table.device` | Gerät | Dispositivo | Appareil | Dispositivo | Dispositivo | Cihaz |
| `table.computerName` | Computername | Nombre del equipo | Nom de l'ordinateur | Nome del computer | Nome do computador | Bilgisayar adı |
| `table.source` | Quelle | Fuente | Source | Origine | Origem | Kaynak |
| `table.dataSources` | Datenquellen | Orígenes de datos | Sources de données | Origini dati | Fontes de dados | Veri kaynakları |
| `table.selected` | Ausgewählt | Seleccionado | Sélectionné | Selezionato | Selecionado | Seçilen |
| `table.used` | Belegt | Usado | Utilisé | Utilizzato | Usado | Kullanılan |
| `table.history` | Letzte 28 Tage | Últimos 28 días | 28 derniers jours | Ultimi 28 giorni | Últimos 28 dias | Son 28 gün |
| `table.errors` | Fehler | Errores | Erreurs | Errori | Erros | Hatalar |
| `table.agent` | Agent | Agente | Agent | Agente | Agente | Aracı |
| `noObservation` | Keine Beobachtung | Sin observación | Aucune observation | Nessuna osservazione | Sem observação | Gözlem yok |
| `openDevice` | Gerät öffnen | Abrir dispositivo | Ouvrir l'appareil | Apri il dispositivo | Abrir dispositivo | Cihazı aç |
| `empty` | Kein Gerät passt zu diesen Filtern. | Ningún dispositivo coincide con estos filtros. | Aucun appareil ne correspond à ces filtres. | Nessun dispositivo corrisponde a questi filtri. | Nenhum dispositivo corresponde a esses filtros. | Bu filtrelere uyan cihaz yok. |
| `loadMore` | Mehr laden | Cargar más | Charger plus | Carica altri | Carregar mais | Daha fazla yükle |
| `error` | Backup-Zustand konnte nicht geladen werden | No se pudo cargar el estado de las copias de seguridad | Impossible de charger l'état des sauvegardes | Impossibile caricare lo stato dei backup | Não foi possível carregar a integridade dos backups | Yedekleme durumu yüklenemedi |
| `external.title` | Externe Sicherung | Copia de seguridad externa | Sauvegarde externe | Backup esterno | Backup externo | Dış yedekleme |
| `external.customer` | Anbieterkunde | Cliente del proveedor | Client du fournisseur | Cliente del provider | Cliente do provedor | Sağlayıcı müşterisi |
| `external.lastSuccess` | Letzte erfolgreiche Sicherung | Última copia de seguridad correcta | Dernière sauvegarde réussie | Ultimo backup riuscito | Último backup bem-sucedido | Son başarılı yedekleme |
| `external.lastSession` | Letzte Sitzung | Última sesión | Dernière session | Ultima sessione | Última sessão | Son oturum |
| `external.unlink` | Verknüpfung lösen | Desvincular | Dissocier | Scollega | Desvincular | Bağlantıyı kaldır |
| `external.unlinkConfirm` | Verknüpfung dieses Anbietergeräts mit dem Breeze-Gerät lösen? Es bleibt im Backup-Produkt und kann erneut verknüpft werden. | ¿Desvincular este dispositivo del proveedor del dispositivo de Breeze? Permanece en el producto de copia de seguridad y se puede volver a vincular. | Dissocier cet appareil du fournisseur de l'appareil Breeze ? Il reste dans le produit de sauvegarde et peut être réassocié. | Scollegare questo dispositivo del provider dal dispositivo Breeze? Rimane nel prodotto di backup e può essere ricollegato. | Desvincular este dispositivo do provedor do dispositivo do Breeze? Ele permanece no produto de backup e pode ser vinculado de novo. | Bu sağlayıcı cihazının Breeze cihazıyla bağlantısı kaldırılsın mı? Yedekleme ürününde kalır ve yeniden bağlanabilir. |
| `external.unlinkedToast` | Verknüpfung des Anbietergeräts gelöst | Dispositivo del proveedor desvinculado | Appareil du fournisseur dissocié | Dispositivo del provider scollegato | Dispositivo do provedor desvinculado | Sağlayıcı cihazının bağlantısı kaldırıldı |
| `external.errorUnlink` | Verknüpfung des Anbietergeräts konnte nicht gelöst werden | No se pudo desvincular el dispositivo del proveedor | Impossible de dissocier l'appareil du fournisseur | Impossibile scollegare il dispositivo del provider | Não foi possível desvincular o dispositivo do provedor | Sağlayıcı cihazının bağlantısı kaldırılamadı |
| `external.error` | Externer Sicherungsstatus konnte nicht geladen werden | No se pudo cargar el estado de la copia de seguridad externa | Impossible de charger l'état de la sauvegarde externe | Impossibile caricare lo stato del backup esterno | Não foi possível carregar o status do backup externo | Dış yedekleme durumu yüklenemedi |
| `external.alsoCheck` | Prüfen Sie auch die Verbindungen zu externen Backup-Produkten unter "Integrationen". | Revise también las conexiones de copia de seguridad de terceros en Integraciones. | Vérifiez aussi les connexions de sauvegarde tierces dans Intégrations. | Controlla anche le connessioni di backup di terze parti in Integrazioni. | Verifique também as conexões de backup de terceiros em Integrações. | Üçüncü taraf yedekleme bağlantılarını Entegrasyonlar bölümünde de kontrol edin. |

`fr-CA` uses the `fr-FR` column with straight quotes instead of guillemets (there are none in this block) and "Dissocier" / "Ouvrir l'appareil" unchanged.

- [ ] **Step 3: Run the i18n guards**

```bash
cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts src/lib/i18n/extractionQuality.test.ts
```
Expected: `localeParity` green (all 8 catalogs carry the same key set and the same `{{token}}` multisets). `translationCoverage` may fail with lines shaped `integrations: N exact-English duplicates exceeds baseline M` — the unavoidable duplicates are `backupProviders.cove` (a protected proper noun in every locale), `backupProviders.namePlaceholder`, `backupHealth.sourceBreeze`, and `integrationsPage.backup` in de-DE/it-IT/pt-BR. Raise only the reported `namespaceDuplicateBaselines[<locale>][<namespace>]` numbers, by exactly the reported delta, each with a trailing comment:
```ts
    // +3 (W03 #6011): backupProviders.cove, backupProviders.namePlaceholder and
    // backupHealth.sourceBreeze are protected proper nouns — localeParity.test.ts
    // requires them to stay byte-identical, so they can never be "translated away".
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/locales apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "$(cat <<'EOF'
i18n(backup): backupProviders and backupHealth keys in all 8 locales

W03 Task 6. Added up front, in one commit, because localeParity compares the
whole key set of every catalog against en — staging them per component would
red the suite between commits.

No `count` interpolation anywhere: keyUsage treats a literal count option as a
plural call and then demands _one/_other siblings, so counters render as a label
element plus a sibling number element instead.

Duplicate baselines were raised only for the leaves that CANNOT be translated:
localeParity pins Cove / Breeze / Microsoft 365 to byte-identical occurrences.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `BackupProviderConnectionCard.tsx`

**Files:**
- Create: `apps/web/src/components/integrations/BackupProviderConnectionCard.tsx`
- Create: `apps/web/src/components/integrations/BackupProviderConnectionCard.test.tsx`

**Interfaces:**

Consumes: `runAction`, `ActionError` (`apps/web/src/lib/runAction.ts:22,45`), `handleActionError` (`:130`), `showToast` (`apps/web/src/components/shared/Toast`), `fetchWithAuth` (`apps/web/src/stores/auth`), `formatRelativeTime` (`apps/web/src/lib/dateTimeFormat.ts:158` — the localized one, NOT `@/lib/utils`'s hardcoded-English twin at `utils.ts:67`).

Produces:
```tsx
export type BackupProviderConnection = {
  id: string; provider: string; name: string; baseUrl: string;
  vendorRootName: string | null; isActive: boolean;
  status: 'connected' | 'error' | 'reauth_required';
  syncIntervalMinutes: number; showProviderNameInPortal: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: 'running' | 'success' | 'partial' | 'error' | null;
  lastSyncError: string | null;
  lastSyncCustomers: number | null; lastSyncUnmappedCustomers: number | null;
  lastSyncDevices: number | null; lastSyncUnmappedDevices: number | null;
  lastSyncLinkedDevices: number | null; lastSyncAmbiguousDevices: number | null;
  hasCredentials: boolean;
};
export type BackupProviderTestResult = { success: boolean; message?: string; error?: string; rootName?: string; customerCount?: number };

export default function BackupProviderConnectionCard(props: {
  connection: BackupProviderConnection;
  onChanged: () => void;                                  // parent refetches
  onTestResult: (result: BackupProviderTestResult) => void; // parent owns the modal
}): JSX.Element;
```

**DECISION D-22 — the test-result MODAL lives in the parent** (`BackupProvidersIntegration`), not the card. The card raises `onTestResult`. This is the PSA shape (`apps/web/src/components/psa/PsaConnectionsPage.tsx:235-266` raises, `:520-566` renders) and it keeps one modal on screen when a partner has several connections.

**DECISION D-23 — `syncStatusBadge` is copied, not imported.** The original is a file-local function in `SecurityIntegration.tsx:76-119` (not exported) and it reads `Integration.lastSyncStatus` with Huntress' value domain. Copying ~25 lines and re-pointing it at `BackupProviderConnection` is cheaper and safer than exporting a shared badge that then has to satisfy two value domains; the repo already treats these badges as per-integration.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/integrations/BackupProviderConnectionCard.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BackupProviderConnectionCard, { type BackupProviderConnection } from "./BackupProviderConnectionCard";
import { fetchWithAuth } from "../../stores/auth";
import { showToast } from "../shared/Toast";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? "OK" : "ERROR", json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const connection = (o: Partial<BackupProviderConnection> = {}): BackupProviderConnection => ({
  id: "conn-1", provider: "cove", name: "OliveTech Cove", baseUrl: "https://api.backup.management/jsonapi",
  vendorRootName: "OliveTech", isActive: true, status: "connected", syncIntervalMinutes: 30,
  showProviderNameInPortal: false, lastSyncAt: "2026-09-15T11:50:00.000Z", lastSyncStatus: "success",
  lastSyncError: null, lastSyncCustomers: 12, lastSyncUnmappedCustomers: 2, lastSyncDevices: 340,
  lastSyncUnmappedDevices: 18, lastSyncLinkedDevices: 300, lastSyncAmbiguousDevices: 4,
  hasCredentials: true, ...o,
});

const onChanged = vi.fn();
const onTestResult = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(res({ success: true }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("BackupProviderConnectionCard", () => {
  it("shows the counters, including the honesty counters", () => {
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    expect(screen.getByTestId("backup-connection-customers").textContent).toContain("12");
    expect(screen.getByTestId("backup-connection-devices").textContent).toContain("340");
    expect(screen.getByTestId("backup-connection-linked").textContent).toContain("300");
    expect(screen.getByTestId("backup-connection-unmapped-devices").textContent).toContain("18");
    expect(screen.getByTestId("backup-connection-ambiguous").textContent).toContain("4");
  });

  it.each([
    ["success", "backup-connection-badge-active"],
    ["partial", "backup-connection-badge-active"],
    ["running", "backup-connection-badge-syncing"],
    ["error", "backup-connection-badge-error"],
    [null, "backup-connection-badge-pending"],
  ])("renders the %s sync badge", (lastSyncStatus, testId) => {
    render(
      <BackupProviderConnectionCard
        connection={connection({ lastSyncStatus: lastSyncStatus as BackupProviderConnection["lastSyncStatus"] })}
        onChanged={onChanged}
        onTestResult={onTestResult}
      />,
    );
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });

  it("renders the last sync error in its own box", () => {
    render(
      <BackupProviderConnectionCard
        connection={connection({ lastSyncStatus: "error", lastSyncError: "Login rejected by Cove" })}
        onChanged={onChanged}
        onTestResult={onTestResult}
      />,
    );
    expect(screen.getByTestId("backup-connection-sync-error").textContent).toContain("Login rejected by Cove");
  });

  it("offers Re-enter credentials only when the connection is reauth_required", () => {
    const { rerender } = render(
      <BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />,
    );
    expect(screen.queryByTestId("backup-connection-reauth")).toBeNull();

    rerender(
      <BackupProviderConnectionCard
        connection={connection({ status: "reauth_required" })}
        onChanged={onChanged}
        onTestResult={onTestResult}
      />,
    );
    expect(screen.getByTestId("backup-connection-reauth")).toBeInTheDocument();
  });

  it("POSTs the test endpoint and hands the result up rather than rendering its own modal", async () => {
    fetchMock.mockResolvedValue(res({ success: true, rootName: "OliveTech", customerCount: 12 }));
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);

    fireEvent.click(screen.getByTestId("backup-connection-test"));

    await waitFor(() => expect(onTestResult).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/backup/providers/connections/conn-1/test", { method: "POST" });
    expect(onTestResult.mock.calls[0]![0]).toMatchObject({ success: true, rootName: "OliveTech" });
  });

  it("treats an HTTP-200 {success:false} test as a failure and still surfaces the provider message", async () => {
    fetchMock.mockResolvedValue(res({ success: false, error: "2FA is enabled on this Cove user" }));
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);

    fireEvent.click(screen.getByTestId("backup-connection-test"));

    await waitFor(() => expect(onTestResult).toHaveBeenCalled());
    // runAction toasted it; the modal still opens with the provider's own words.
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(onTestResult.mock.calls[0]![0]).toMatchObject({ success: false, error: "2FA is enabled on this Cove user" });
  });

  it("queues a sync and tells the parent to refetch", async () => {
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-sync"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/backup/providers/connections/conn-1/sync", { method: "POST" });
  });

  it("PATCHes only the fields the form changed", async () => {
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-portal-toggle"));
    fireEvent.click(screen.getByTestId("backup-connection-save"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/backup/providers/connections/conn-1");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: "OliveTech Cove", isActive: true, showProviderNameInPortal: true,
    });
  });

  it("never sends an empty credentials object when the password field was left blank", async () => {
    render(
      <BackupProviderConnectionCard connection={connection({ status: "reauth_required" })} onChanged={onChanged} onTestResult={onTestResult} />,
    );
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string)).not.toHaveProperty("credentials");
  });

  it("confirms before deleting and names the connection in the prompt", async () => {
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-delete"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toContain("OliveTech Cove");
    expect((fetchMock.mock.calls.at(-1)![1] as RequestInit).method).toBe("DELETE");
  });

  it("does not delete when the confirm is dismissed", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-delete"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/integrations/BackupProviderConnectionCard.test.tsx
```
Expected: `Failed to resolve import "./BackupProviderConnectionCard"`.

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/components/integrations/BackupProviderConnectionCard.tsx
import { useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Eye, EyeOff, Loader2, RefreshCw, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { fetchWithAuth } from "../../stores/auth";
import { showToast } from "../shared/Toast";
import { handleActionError, runAction } from "@/lib/runAction";
import { formatRelativeTime } from "@/lib/dateTimeFormat";
import "@/lib/i18n";

export type BackupProviderConnection = {
  id: string;
  provider: string;
  name: string;
  baseUrl: string;
  vendorRootName: string | null;
  isActive: boolean;
  status: "connected" | "error" | "reauth_required";
  syncIntervalMinutes: number;
  showProviderNameInPortal: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: "running" | "success" | "partial" | "error" | null;
  lastSyncError: string | null;
  lastSyncCustomers: number | null;
  lastSyncUnmappedCustomers: number | null;
  lastSyncDevices: number | null;
  lastSyncUnmappedDevices: number | null;
  lastSyncLinkedDevices: number | null;
  lastSyncAmbiguousDevices: number | null;
  hasCredentials: boolean;
};

export type BackupProviderTestResult = {
  success: boolean;
  message?: string;
  error?: string;
  rootName?: string;
  customerCount?: number;
};

/**
 * Copied from SecurityIntegration.tsx:76-119 rather than imported: that one is
 * file-local and typed against Huntress' own row shape. A shared badge would
 * have to satisfy two value domains for no gain.
 */
function syncStatusBadge(connection: BackupProviderConnection, t: (key: string) => string) {
  if (connection.lastSyncStatus === "success" || connection.lastSyncStatus === "partial") {
    return (
      <span data-testid="backup-connection-badge-active" className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" /> {t("common:states.active")}
      </span>
    );
  }
  if (connection.lastSyncStatus === "running") {
    return (
      <span data-testid="backup-connection-badge-syncing" className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("common:states.processing")}
      </span>
    );
  }
  if (connection.lastSyncStatus === "error") {
    return (
      <span data-testid="backup-connection-badge-error" className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700">
        <AlertTriangle className="h-3.5 w-3.5" /> {t("common:states.error")}
      </span>
    );
  }
  return (
    <span data-testid="backup-connection-badge-pending" className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
      <Activity className="h-3.5 w-3.5" /> {t("common:states.pending")}
    </span>
  );
}

function Counter({ testId, label, value }: { testId: string; label: string; value: number | null }) {
  // Label and number are SEPARATE elements on purpose: extractionQuality.test.ts
  // bans `{t('k')}{expr}` adjacency, and a `{{count}}` interpolation would pull
  // the whole key into keyUsage's plural contract.
  return (
    <div data-testid={testId} className="rounded-md border bg-muted/20 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold text-foreground">{value ?? 0}</dd>
    </div>
  );
}

export default function BackupProviderConnectionCard({
  connection,
  onChanged,
  onTestResult,
}: {
  connection: BackupProviderConnection;
  onChanged: () => void;
  onTestResult: (result: BackupProviderTestResult) => void;
}) {
  const { t } = useTranslation("integrations");
  const [name, setName] = useState(connection.name);
  const [isActive, setIsActive] = useState(connection.isActive);
  const [showInPortal, setShowInPortal] = useState(connection.showProviderNameInPortal);
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<null | "test" | "sync" | "save" | "delete">(null);

  const handleTest = async () => {
    setBusy("test");
    try {
      // The route answers HTTP 200 with {success:false} on a rejected
      // credential; runAction treats that as a failure and toasts it. The modal
      // still opens in BOTH branches — it carries the provider's own message,
      // which a toast alone truncates the context of (PsaConnectionsPage.tsx:235).
      const result = await runAction<BackupProviderTestResult>({
        request: () => fetchWithAuth(`/backup/providers/connections/${connection.id}/test`, { method: "POST" }),
        errorFallback: t("backupProviders.errorTest"),
      });
      onTestResult(result);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: "error", message: t("backupProviders.errorTest") });
      const body = err instanceof ActionError ? (err.body as BackupProviderTestResult | undefined) : undefined;
      onTestResult({ success: false, error: body?.error ?? (err instanceof Error ? err.message : t("backupProviders.errorTest")) });
    } finally {
      setBusy(null);
    }
  };

  const handleSync = async () => {
    setBusy("sync");
    try {
      await runAction({
        request: () => fetchWithAuth(`/backup/providers/connections/${connection.id}/sync`, { method: "POST" }),
        errorFallback: t("backupProviders.errorSync"),
        successMessage: t("backupProviders.syncQueuedToast"),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t("backupProviders.errorSync"));
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    setBusy("save");
    const body: Record<string, unknown> = { name, isActive, showProviderNameInPortal: showInPortal };
    // A blank password means "keep the stored secret" — never send an empty
    // credentials blob, which the API would re-encrypt over a working one.
    if (editingCredentials && password.trim()) {
      body.credentials = { partnerName: partnerName.trim(), username: username.trim(), password };
    }
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/backup/providers/connections/${connection.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        errorFallback: t("backupProviders.errorSave"),
        successMessage: t("backupProviders.savedToast"),
      });
      setEditingCredentials(false);
      setPassword("");
      onChanged();
    } catch (err) {
      handleActionError(err, t("backupProviders.errorSave"));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(t("backupProviders.deleteConfirm", { name: connection.name }))) return;
    setBusy("delete");
    try {
      await runAction({
        request: () => fetchWithAuth(`/backup/providers/connections/${connection.id}`, { method: "DELETE" }),
        errorFallback: t("backupProviders.errorDelete"),
        successMessage: t("backupProviders.deletedToast"),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t("backupProviders.errorDelete"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid={`backup-connection-${connection.id}`} className="rounded-lg border bg-card p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">{connection.name}</h3>
          <p className="text-sm text-muted-foreground">{t("backupProviders.cove")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {connection.lastSyncAt
              ? t("backupProviders.lastSync", { relative: formatRelativeTime(connection.lastSyncAt) })
              : t("backupProviders.neverSynced")}
          </p>
        </div>
        {syncStatusBadge(connection, t)}
      </div>

      {connection.status === "reauth_required" && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <p className="font-medium">{t("backupProviders.reauthRequired")}</p>
          <button
            type="button"
            data-testid="backup-connection-reauth"
            onClick={() => setEditingCredentials(true)}
            className="mt-2 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900"
          >
            {t("backupProviders.reenterCredentials")}
          </button>
        </div>
      )}

      {connection.lastSyncError && (
        <div data-testid="backup-connection-sync-error" className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <p className="font-medium">{t("backupProviders.syncErrorTitle")}</p>
          <p className="mt-1 break-words">{connection.lastSyncError}</p>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Counter testId="backup-connection-customers" label={t("backupProviders.customers")} value={connection.lastSyncCustomers} />
        <Counter testId="backup-connection-devices" label={t("backupProviders.devices")} value={connection.lastSyncDevices} />
        <Counter testId="backup-connection-linked" label={t("backupProviders.linked")} value={connection.lastSyncLinkedDevices} />
        <Counter testId="backup-connection-unmapped-devices" label={t("backupProviders.unmappedDevices")} value={connection.lastSyncUnmappedDevices} />
        <Counter testId="backup-connection-ambiguous" label={t("backupProviders.ambiguous")} value={connection.lastSyncAmbiguousDevices} />
      </dl>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-xs text-muted-foreground">{t("common:labels.name")}</span>
          <input
            data-testid="backup-connection-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
          />
        </label>
        <div className="flex flex-col justify-end gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input data-testid="backup-connection-active" type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            <span>{t("common:states.active")}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input data-testid="backup-connection-portal-toggle" type="checkbox" checked={showInPortal} onChange={(e) => setShowInPortal(e.target.checked)} />
            <span>{t("backupProviders.portalLabelToggle")}</span>
          </label>
          <p className="text-xs text-muted-foreground">{t("backupProviders.portalLabelHelp")}</p>
        </div>
      </div>

      {editingCredentials && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-sm">
            <span className="text-xs text-muted-foreground">{t("backupProviders.partnerNameLabel")}</span>
            <input data-testid="backup-connection-partner-name" value={partnerName} onChange={(e) => setPartnerName(e.target.value)} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-muted-foreground">{t("backupProviders.usernameLabel")}</span>
            <input data-testid="backup-connection-username" value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-muted-foreground">{t("backupProviders.passwordLabel")}</span>
            <div className="mt-1 flex items-center gap-1">
              <input
                data-testid="backup-connection-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
              <button
                type="button"
                data-testid="backup-connection-password-toggle"
                aria-label={showPassword ? t("backupProviders.hidePassword") : t("backupProviders.showPassword")}
                onClick={() => setShowPassword((v) => !v)}
                className="rounded-md border px-2 py-1.5"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </label>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" data-testid="backup-connection-test" disabled={busy !== null} onClick={() => void handleTest()} className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm font-medium disabled:opacity-50">
          {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
          {t("backupProviders.test")}
        </button>
        <button type="button" data-testid="backup-connection-sync" disabled={busy !== null} onClick={() => void handleSync()} className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm font-medium disabled:opacity-50">
          <RefreshCw className="h-4 w-4" /> {t("backupProviders.syncNow")}
        </button>
        <button type="button" data-testid="backup-connection-save" disabled={busy !== null} onClick={() => void handleSave()} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
          <Save className="h-4 w-4" /> {t("common:actions.save")}
        </button>
        <button type="button" data-testid="backup-connection-delete" disabled={busy !== null} onClick={() => void handleDelete()} className="ml-auto inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium text-destructive disabled:opacity-50">
          <Trash2 className="h-4 w-4" /> {t("common:actions.delete")}
        </button>
      </div>
    </div>
  );
}
```

Add `ActionError` to the `runAction` import: `import { ActionError, handleActionError, runAction } from "@/lib/runAction";`.

- [ ] **Step 4: Run it green**

```bash
cd apps/web && npx vitest run src/components/integrations/BackupProviderConnectionCard.test.tsx
```
Expected: 1 file, 15 tests passing (5 `it.each` badge cases + 10).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/integrations/BackupProviderConnectionCard.tsx \
        apps/web/src/components/integrations/BackupProviderConnectionCard.test.tsx
git commit -m "$(cat <<'EOF'
feat(web/integrations): backup provider connection card

W03 Task 7. Badge, counters (including the unmapped/ambiguous honesty counters),
last-sync-error box, re-auth CTA, and Test/Save/Sync/Delete through runAction.

Two behaviours pinned by tests: a blank password never ships an empty
credentials blob over a working one, and an HTTP-200 {success:false} test is a
failure that still opens the result modal with the provider's own words — the
toast alone truncates the context that tells the tech WHY Cove refused.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `BackupProviderCustomerMapping.tsx`

**Files:**
- Create: `apps/web/src/components/integrations/BackupProviderCustomerMapping.tsx`
- Create: `apps/web/src/components/integrations/BackupProviderCustomerMapping.test.tsx`

**Interfaces:**

Consumes: `useOrgStore` (`apps/web/src/stores/orgStore.ts`, `Organization` at `:15`), `runAction`, `fetchWithAuth`. Grid markup follows `HuntressIntegration.tsx:1160-1250` (the `<select value={row.mappedOrgId ?? ""}>` + saving spinner + status icon shape).

Produces:
```tsx
export type BackupProviderCustomer = {
  id: string; vendorCustomerId: string; vendorCustomerName: string;
  vendorLevel: string | null; vendorExternalCode: string | null;
  orgId: string | null;
  mappingSource: "manual" | "auto_name" | "auto_external_code" | "manual_unmapped" | null;
  deviceCount: number; unmappedDeviceCount: number; lastSeenAt: string | null;
};
export default function BackupProviderCustomerMapping(props: {
  connectionId: string;
  customers: BackupProviderCustomer[];
  onChanged: () => void;
}): JSX.Element;
```

**DECISION D-24 — the `<select>` carries a third option, `__unmapped__`, distinct from the empty "Select organization" placeholder.** `PUT /backup/providers/customers/:id/mapping { orgId: null }` means two different things depending on intent: "I have not decided yet" (leave `mapping_source` NULL so auto-mapping keeps trying) versus "deliberately not mapped" (`manual_unmapped`, which auto-mapping must never touch — spec, `backup_provider_customers`). Only the API can set the latter, and it does so when the PUT arrives with `orgId: null`. So the placeholder is inert (selecting it is a no-op) and `__unmapped__` is the control that sends the PUT. Without that split, opening the dropdown and closing it would silently pin a customer out of auto-mapping forever.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/integrations/BackupProviderCustomerMapping.test.tsx
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BackupProviderCustomerMapping, { type BackupProviderCustomer } from "./BackupProviderCustomerMapping";
import { fetchWithAuth } from "../../stores/auth";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));
vi.mock("../../stores/orgStore", () => ({
  useOrgStore: (selector: (s: { organizations: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ organizations: [{ id: "org-1", name: "Acme" }, { id: "org-2", name: "Globex" }] }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: "OK", json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const customer = (o: Partial<BackupProviderCustomer> = {}): BackupProviderCustomer => ({
  id: "cust-1", vendorCustomerId: "9001", vendorCustomerName: "Acme North", vendorLevel: "EndCustomer",
  vendorExternalCode: null, orgId: null, mappingSource: null, deviceCount: 12, unmappedDeviceCount: 12,
  lastSeenAt: "2026-09-15T11:50:00.000Z", ...o,
});

const onChanged = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(res({ success: true }));
});

describe("BackupProviderCustomerMapping", () => {
  it("PUTs the chosen org for an unmapped customer", async () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer()]} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId("backup-mapping-select-cust-1"), { target: { value: "org-2" } });

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/backup/providers/customers/cust-1/mapping");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ orgId: "org-2" });
  });

  it("sends orgId:null for the explicit Unmapped (kept) choice", async () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer({ orgId: "org-1", mappingSource: "manual" })]} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId("backup-mapping-select-cust-1"), { target: { value: "__unmapped__" } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string)).toEqual({ orgId: null });
  });

  it("does nothing when the inert placeholder is re-selected", async () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer()]} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId("backup-mapping-select-cust-1"), { target: { value: "" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([["auto_name"], ["auto_external_code"]])("shows the Auto badge for %s mappings", (mappingSource) => {
    render(
      <BackupProviderCustomerMapping
        connectionId="conn-1"
        customers={[customer({ orgId: "org-1", mappingSource: mappingSource as BackupProviderCustomer["mappingSource"] })]}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByTestId("backup-mapping-auto-cust-1")).toBeInTheDocument();
  });

  it("does not show the Auto badge for a manual mapping", () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer({ orgId: "org-1", mappingSource: "manual" })]} onChanged={onChanged} />);
    expect(screen.queryByTestId("backup-mapping-auto-cust-1")).toBeNull();
  });

  it("selects Unmapped (kept) for a manual_unmapped customer, not the placeholder", () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer({ mappingSource: "manual_unmapped" })]} onChanged={onChanged} />);
    expect((screen.getByTestId("backup-mapping-select-cust-1") as HTMLSelectElement).value).toBe("__unmapped__");
  });

  it("summarises the unmapped customers and their devices", () => {
    render(
      <BackupProviderCustomerMapping
        connectionId="conn-1"
        customers={[
          customer({ id: "cust-1", unmappedDeviceCount: 12 }),
          customer({ id: "cust-2", unmappedDeviceCount: 6 }),
          customer({ id: "cust-3", orgId: "org-1", mappingSource: "manual", unmappedDeviceCount: 0 }),
        ]}
        onChanged={onChanged}
      />,
    );
    const summary = screen.getByTestId("backup-mapping-summary").textContent ?? "";
    expect(summary).toContain("2");
    expect(summary).toContain("18");
  });

  it("renders an empty state when nothing has been discovered", () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[]} onChanged={onChanged} />);
    expect(screen.getByTestId("backup-mapping-empty")).toBeInTheDocument();
  });

  it("shows the device count per row", () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer()]} onChanged={onChanged} />);
    const row = screen.getByTestId("backup-mapping-row-cust-1");
    expect(within(row).getByTestId("backup-mapping-devices-cust-1").textContent).toContain("12");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/integrations/BackupProviderCustomerMapping.test.tsx
```
Expected: `Failed to resolve import "./BackupProviderCustomerMapping"`.

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/components/integrations/BackupProviderCustomerMapping.tsx
import { useMemo, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { fetchWithAuth } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { handleActionError, runAction } from "@/lib/runAction";
import "@/lib/i18n";

export type BackupProviderCustomer = {
  id: string;
  vendorCustomerId: string;
  vendorCustomerName: string;
  vendorLevel: string | null;
  vendorExternalCode: string | null;
  orgId: string | null;
  mappingSource: "manual" | "auto_name" | "auto_external_code" | "manual_unmapped" | null;
  deviceCount: number;
  unmappedDeviceCount: number;
  lastSeenAt: string | null;
};

/**
 * Sentinel for "deliberately not mapped". `orgId: null` on the wire means two
 * different things to the API — a never-decided customer keeps mapping_source
 * NULL so auto-mapping retries it, while an explicit unmap sets
 * `manual_unmapped`, which auto-mapping must never touch. The empty-string
 * placeholder therefore stays INERT: opening the dropdown and closing it must
 * not silently pin a customer out of auto-mapping forever.
 */
const UNMAPPED = "__unmapped__";

export default function BackupProviderCustomerMapping({
  connectionId,
  customers,
  onChanged,
}: {
  connectionId: string;
  customers: BackupProviderCustomer[];
  onChanged: () => void;
}) {
  const { t } = useTranslation("integrations");
  const organizations = useOrgStore((s) => s.organizations);
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const summary = useMemo(() => {
    const unmappedCustomers = customers.filter((c) => !c.orgId);
    return {
      customers: unmappedCustomers.length,
      devices: unmappedCustomers.reduce((sum, c) => sum + (c.unmappedDeviceCount ?? 0), 0),
    };
  }, [customers]);

  const handleMap = async (customerId: string, value: string) => {
    if (value === "") return; // inert placeholder
    const orgId = value === UNMAPPED ? null : value;
    setSaving((s) => ({ ...s, [customerId]: true }));
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/backup/providers/customers/${customerId}/mapping`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orgId }),
          }),
        errorFallback: t("backupProviders.errorMap"),
        successMessage: t("backupProviders.mappedToast"),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t("backupProviders.errorMap"));
    } finally {
      setSaving((s) => ({ ...s, [customerId]: false }));
    }
  };

  return (
    <div data-testid={`backup-mapping-${connectionId}`} className="mt-6 rounded-lg border bg-card p-5 shadow-xs">
      <h4 className="text-sm font-semibold text-foreground">{t("backupProviders.mappingTitle")}</h4>
      <p className="mt-1 text-sm text-muted-foreground">{t("backupProviders.mappingHelp")}</p>
      <p data-testid="backup-mapping-summary" className="mt-2 text-xs text-muted-foreground">
        {t("backupProviders.unmappedSummary", { customers: summary.customers, devices: summary.devices })}
      </p>

      {customers.length === 0 ? (
        <p data-testid="backup-mapping-empty" className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t("backupProviders.mappingEmpty")}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs font-semibold uppercase text-muted-foreground">
                <th className="pb-2 pr-4">{t("backupProviders.vendorCustomer")}</th>
                <th className="pb-2 pr-4">{t("backupProviders.level")}</th>
                <th className="pb-2 pr-4">{t("backupProviders.devices")}</th>
                <th className="pb-2 pr-4">{t("common:labels.organization")}</th>
                <th className="pb-2">{t("common:labels.status")}</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((row) => (
                <tr key={row.id} data-testid={`backup-mapping-row-${row.id}`} className="border-b last:border-0">
                  <td className="py-3 pr-4">
                    <div className="font-medium">{row.vendorCustomerName}</div>
                    <div className="text-xs text-muted-foreground">{row.vendorCustomerId}</div>
                  </td>
                  <td className="py-3 pr-4 text-muted-foreground">{row.vendorLevel ?? "--"}</td>
                  <td data-testid={`backup-mapping-devices-${row.id}`} className="py-3 pr-4 text-muted-foreground">
                    {row.deviceCount}
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <select
                        data-testid={`backup-mapping-select-${row.id}`}
                        value={row.orgId ?? (row.mappingSource === "manual_unmapped" ? UNMAPPED : "")}
                        onChange={(e) => void handleMap(row.id, e.target.value)}
                        disabled={saving[row.id]}
                        className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm disabled:opacity-50"
                      >
                        <option value="">{t("backupProviders.selectOrganization")}</option>
                        <option value={UNMAPPED}>{t("backupProviders.keepUnmapped")}</option>
                        {organizations.map((org) => (
                          <option key={org.id} value={org.id}>
                            {org.name}
                          </option>
                        ))}
                      </select>
                      {(row.mappingSource === "auto_name" || row.mappingSource === "auto_external_code") && (
                        <span
                          data-testid={`backup-mapping-auto-${row.id}`}
                          title={t("backupProviders.autoTitle", { source: row.mappingSource })}
                          className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs text-sky-700"
                        >
                          {t("backupProviders.auto")}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3">
                    {saving[row.id] ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : row.orgId ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("backupProviders.keepUnmapped")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run it green**

```bash
cd apps/web && npx vitest run src/components/integrations/BackupProviderCustomerMapping.test.tsx
```
Expected: 1 file, 10 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/integrations/BackupProviderCustomerMapping.tsx \
        apps/web/src/components/integrations/BackupProviderCustomerMapping.test.tsx
git commit -m "$(cat <<'EOF'
feat(web/integrations): backup provider customer-mapping grid

W03 Task 8. Org select, auto badge, per-row device count and the unmapped
summary line, all writes through runAction.

The dropdown carries THREE states, not two: the empty placeholder is inert and
"Unmapped (kept)" is its own option. `orgId: null` on the wire sets
mapping_source='manual_unmapped', which auto-mapping never touches again — so a
dropdown that sent it on the placeholder would let an idle click pin a customer
out of auto-mapping permanently.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `BackupProvidersIntegration.tsx`, the hub tab, the alias page and the guard

**Files:**
- Create: `apps/web/src/components/integrations/BackupProvidersIntegration.tsx`
- Create: `apps/web/src/components/integrations/BackupProvidersIntegration.test.tsx`
- Create: `apps/web/src/pages/settings/integrations/backup.astro`
- Modify: `apps/web/src/components/integrations/IntegrationsPage.tsx` (`:2-12` icons, `:46-56` `TabId`, `:62-82` `tabs`, `:113-124` `tabDocsPaths`, render block near `:566`)
- Modify: `apps/web/src/components/integrations/IntegrationsPage.test.tsx`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS` at `:35`, count at `:640`)

**Interfaces:**

Consumes: `BackupProviderConnectionCard` + its types (Task 7), `BackupProviderCustomerMapping` + its types (Task 8), `getJwtClaims` (`apps/web/src/lib/authScope`), `fetchWithAuth`, `runAction`.

Produces:
```tsx
export default function BackupProvidersIntegration(): JSX.Element;
```
and the tab wiring: `TabId` gains `"backup"`, `tabs` gains `{ id: "backup", labelKey: "integrationsPage.backup", icon: HardDrive }`, `tabDocsPaths` gains `backup: "/features/backup-provider-integrations/"`.

**DECISION D-25 — the docs path is `/features/backup-provider-integrations/`,** matching the plural pattern every sibling uses (`tabDocsPaths` at `IntegrationsPage.tsx:113-124`: `edr-integrations`, `psa-integrations`, `monitoring-integrations`, …). The page itself is W04's docs task; a `tabDocsPaths` entry that 404s only affects the "View … documentation" button and does not fail any test, so this wave does not block on it.

**DECISION D-26 — the tab is gated on partner scope in the UI.** Every connection route is `requireScope('partner','system')` server-side (spec, Security). `IntegrationsPage` already has the idiom for this — `const isOrgScoped = claims.scope === "organization"` (`:311`) plus a `data-testid="<tab>-org-scope"` message (`:519-527`) — and this tab follows it, so an org-scope user reads one sentence instead of a screen of 403s.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/integrations/BackupProvidersIntegration.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let scope: "system" | "partner" | "organization" = "partner";
vi.mock("../../lib/authScope", () => ({
  getJwtClaims: () => ({ scope, orgId: null, partnerId: "partner-1" }),
  loginPathWithNext: () => "/login",
}));
vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));
vi.mock("../../stores/orgStore", () => ({
  useOrgStore: (selector: (s: { organizations: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ organizations: [{ id: "org-1", name: "Acme" }] }),
}));

import BackupProvidersIntegration from "./BackupProvidersIntegration";
import { fetchWithAuth } from "../../stores/auth";

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: "OK", json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const conn = {
  id: "conn-1", provider: "cove", name: "OliveTech Cove", baseUrl: "https://api.backup.management/jsonapi",
  vendorRootName: "OliveTech", isActive: true, status: "connected", syncIntervalMinutes: 30,
  showProviderNameInPortal: false, lastSyncAt: "2026-09-15T11:50:00.000Z", lastSyncStatus: "success",
  lastSyncError: null, lastSyncCustomers: 3, lastSyncUnmappedCustomers: 1, lastSyncDevices: 40,
  lastSyncUnmappedDevices: 5, lastSyncLinkedDevices: 30, lastSyncAmbiguousDevices: 0, hasCredentials: true,
};

function routeFetch(connections: unknown[] = [conn], customers: unknown[] = []) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (url === "/backup/providers/connections" && method === "GET") return res({ data: connections });
    if (url.endsWith("/customers")) return res({ data: customers });
    return res({ success: true });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  scope = "partner";
  routeFetch();
});

describe("BackupProvidersIntegration", () => {
  it("lists the partner's connections", async () => {
    render(<BackupProvidersIntegration />);
    expect(await screen.findByTestId("backup-connection-conn-1")).toBeInTheDocument();
  });

  it("shows the partner-only message and queries nothing for an org-scope user", async () => {
    scope = "organization";
    render(<BackupProvidersIntegration />);
    expect(await screen.findByTestId("backup-providers-org-scope")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the empty state when no provider is connected", async () => {
    routeFetch([]);
    render(<BackupProvidersIntegration />);
    expect(await screen.findByTestId("backup-providers-empty")).toBeInTheDocument();
  });

  it("POSTs a new connection with the credentials blob and refetches", async () => {
    render(<BackupProvidersIntegration />);
    await screen.findByTestId("backup-connection-conn-1");

    fireEvent.click(screen.getByTestId("backup-providers-add"));
    fireEvent.change(screen.getByTestId("backup-add-name"), { target: { value: "Second Cove" } });
    fireEvent.change(screen.getByTestId("backup-add-partner-name"), { target: { value: "OliveTech" } });
    fireEvent.change(screen.getByTestId("backup-add-username"), { target: { value: "breeze-ro" } });
    fireEvent.change(screen.getByTestId("backup-add-password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByTestId("backup-add-submit"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/backup/providers/connections",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls.find(([u, i]) => u === "/backup/providers/connections" && (i as RequestInit)?.method === "POST")![1] as RequestInit).body as string,
    );
    expect(body).toEqual({
      provider: "cove",
      name: "Second Cove",
      showProviderNameInPortal: false,
      credentials: { partnerName: "OliveTech", username: "breeze-ro", password: "s3cret" },
    });
  });

  it("toggles the password field between masked and plain", async () => {
    render(<BackupProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("backup-providers-add"));
    const field = screen.getByTestId("backup-add-password") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.click(screen.getByTestId("backup-add-password-toggle"));
    expect((screen.getByTestId("backup-add-password") as HTMLInputElement).type).toBe("text");
  });

  it("shows the dedicated-user help text on the add form", async () => {
    render(<BackupProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("backup-providers-add"));
    expect(screen.getByTestId("backup-add-help").textContent).toContain("read-only");
  });

  it("opens the test-result modal when a card reports a result", async () => {
    render(<BackupProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("backup-connection-test"));
    expect(await screen.findByTestId("backup-test-modal")).toBeInTheDocument();
  });

  it("loads the customer mapping grid for each connection", async () => {
    routeFetch([conn], [
      { id: "cust-1", vendorCustomerId: "9001", vendorCustomerName: "Acme North", vendorLevel: "EndCustomer", vendorExternalCode: null, orgId: null, mappingSource: null, deviceCount: 12, unmappedDeviceCount: 12, lastSeenAt: null },
    ]);
    render(<BackupProvidersIntegration />);
    expect(await screen.findByTestId("backup-mapping-row-cust-1")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/backup/providers/connections/conn-1/customers");
  });

  it("surfaces a load failure instead of rendering an empty, all-clear list", async () => {
    fetchMock.mockResolvedValue(res({ error: "nope" }, false, 500));
    render(<BackupProvidersIntegration />);
    expect(await screen.findByTestId("backup-providers-error")).toBeInTheDocument();
    expect(screen.queryByTestId("backup-providers-empty")).toBeNull();
  });
});
```

Add to `apps/web/src/components/integrations/IntegrationsPage.test.tsx` (stub the panel next to the others at `:36-44`, then):

```tsx
vi.mock("./BackupProvidersIntegration", () => ({
  default: () => <div data-testid="stub-backup" />,
}));
```

```tsx
  it("renders the Backup tab from the #backup deep link", async () => {
    window.location.hash = "#backup";
    render(<IntegrationsPage />);
    expect(await screen.findByTestId("stub-backup")).toBeInTheDocument();
  });

  it("opens the backup docs page from the Backup tab", async () => {
    window.location.hash = "#backup";
    render(<IntegrationsPage />);
    await screen.findByTestId("stub-backup");
    fireEvent.click(screen.getByTestId("integrations-docs-link"));
    expect(openMock).toHaveBeenCalledWith(expect.stringContaining("/features/backup-provider-integrations/"));
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/web && npx vitest run src/components/integrations/BackupProvidersIntegration.test.tsx src/components/integrations/IntegrationsPage.test.tsx
```
Expected: `Failed to resolve import "./BackupProvidersIntegration"`, and `Unable to find an element by: [data-testid="stub-backup"]`.

- [ ] **Step 3: Implement the panel**

```tsx
// apps/web/src/components/integrations/BackupProvidersIntegration.tsx
import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, HardDrive, Loader2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getJwtClaims } from "../../lib/authScope";
import { fetchWithAuth } from "../../stores/auth";
import { handleActionError, runAction } from "@/lib/runAction";
import BackupProviderConnectionCard, {
  type BackupProviderConnection,
  type BackupProviderTestResult,
} from "./BackupProviderConnectionCard";
import BackupProviderCustomerMapping, { type BackupProviderCustomer } from "./BackupProviderCustomerMapping";
import "@/lib/i18n";

export default function BackupProvidersIntegration() {
  const { t } = useTranslation("integrations");
  // The connection/customer routes are requireScope('partner','system'). Gate on
  // the JWT scope — never on useOrgStore().partners.length, which is empty for
  // real partner users (the known anti-pattern called out in IntegrationsPage).
  const isOrgScoped = getJwtClaims().scope === "organization";

  const [connections, setConnections] = useState<BackupProviderConnection[]>([]);
  const [customers, setCustomers] = useState<Record<string, BackupProviderCustomer[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<BackupProviderTestResult | null>(null);

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", partnerName: "", username: "", password: "", showInPortal: false });
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (isOrgScoped) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetchWithAuth("/backup/providers/connections");
      if (!response.ok) throw new Error(`${response.status}`);
      const payload = await response.json();
      const rows: BackupProviderConnection[] = Array.isArray(payload?.data) ? payload.data : [];
      setConnections(rows);

      const grids = await Promise.all(
        rows.map(async (row) => {
          const res = await fetchWithAuth(`/backup/providers/connections/${row.id}/customers`);
          if (!res.ok) return [row.id, [] as BackupProviderCustomer[]] as const;
          const body = await res.json();
          return [row.id, Array.isArray(body?.data) ? body.data : []] as const;
        }),
      );
      setCustomers(Object.fromEntries(grids));
    } catch (err) {
      console.error("[BackupProvidersIntegration] load:", err);
      // Never fall through to the empty state: "no provider connected" and
      // "we could not ask" are different facts, and only one of them is an
      // all-clear.
      setLoadError(t("backupProviders.errorLoad"));
    } finally {
      setLoading(false);
    }
  }, [isOrgScoped, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    setSubmitting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth("/backup/providers/connections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: "cove",
              name: form.name.trim(),
              showProviderNameInPortal: form.showInPortal,
              credentials: {
                partnerName: form.partnerName.trim(),
                username: form.username.trim(),
                password: form.password,
              },
            }),
          }),
        errorFallback: t("backupProviders.errorSave"),
        successMessage: t("backupProviders.savedToast"),
      });
      setAdding(false);
      setForm({ name: "", partnerName: "", username: "", password: "", showInPortal: false });
      await load();
    } catch (err) {
      handleActionError(err, t("backupProviders.errorSave"));
    } finally {
      setSubmitting(false);
    }
  };

  if (isOrgScoped) {
    return (
      <p data-testid="backup-providers-org-scope" className="py-12 text-center text-sm text-muted-foreground">
        {t("backupProviders.partnerOnly")}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <HardDrive className="h-5 w-5" />
            {t("backupProviders.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("backupProviders.subtitle")}</p>
        </div>
        <button
          type="button"
          data-testid="backup-providers-add"
          onClick={() => setAdding((v) => !v)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> {t("backupProviders.addConnection")}
        </button>
      </div>

      {adding && (
        <div className="rounded-lg border bg-card p-5 shadow-xs">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("backupProviders.providerLabel")}</span>
              <select data-testid="backup-add-provider" disabled className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm">
                <option value="cove">{t("backupProviders.cove")}</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("backupProviders.nameLabel")}</span>
              <input
                data-testid="backup-add-name"
                value={form.name}
                placeholder={t("backupProviders.namePlaceholder")}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("backupProviders.partnerNameLabel")}</span>
              <input
                data-testid="backup-add-partner-name"
                value={form.partnerName}
                onChange={(e) => setForm((f) => ({ ...f, partnerName: e.target.value }))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("backupProviders.usernameLabel")}</span>
              <input
                data-testid="backup-add-username"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-muted-foreground">{t("backupProviders.passwordLabel")}</span>
              <div className="mt-1 flex items-center gap-1">
                <input
                  data-testid="backup-add-password"
                  type={showPassword ? "text" : "password"}
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                />
                <button
                  type="button"
                  data-testid="backup-add-password-toggle"
                  aria-label={showPassword ? t("backupProviders.hidePassword") : t("backupProviders.showPassword")}
                  onClick={() => setShowPassword((v) => !v)}
                  className="rounded-md border px-2 py-1.5"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>
            <label className="flex items-end gap-2 text-sm">
              <input
                data-testid="backup-add-portal-toggle"
                type="checkbox"
                checked={form.showInPortal}
                onChange={(e) => setForm((f) => ({ ...f, showInPortal: e.target.checked }))}
              />
              <span>{t("backupProviders.portalLabelToggle")}</span>
            </label>
          </div>
          <p data-testid="backup-add-help" className="mt-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            {t("backupProviders.credentialsHelp")}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              data-testid="backup-add-submit"
              disabled={submitting || !form.name.trim() || !form.password}
              onClick={() => void handleCreate()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("common:actions.save")}
            </button>
            <button type="button" onClick={() => setAdding(false)} className="rounded-md border px-3 py-1.5 text-sm font-medium">
              {t("common:actions.cancel")}
            </button>
          </div>
        </div>
      )}

      {loadError && (
        <div data-testid="backup-providers-error" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {loadError}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("common:states.loading")}
        </div>
      ) : !loadError && connections.length === 0 ? (
        <p data-testid="backup-providers-empty" className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("backupProviders.empty")}
        </p>
      ) : (
        connections.map((connection) => (
          <div key={connection.id}>
            <BackupProviderConnectionCard connection={connection} onChanged={() => void load()} onTestResult={setTestResult} />
            <BackupProviderCustomerMapping
              connectionId={connection.id}
              customers={customers[connection.id] ?? []}
              onChanged={() => void load()}
            />
          </div>
        ))
      )}

      {testResult && (
        <div data-testid="backup-test-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
            <h3 className="text-lg font-semibold">
              {testResult.success ? t("backupProviders.testSuccess") : t("backupProviders.testFailed")}
            </h3>
            {testResult.success ? (
              <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                <p>{t("backupProviders.testSignedIn", { name: testResult.rootName ?? "" })}</p>
                <p className="mt-1">{t("backupProviders.testVisible", { value: testResult.customerCount ?? 0 })}</p>
              </div>
            ) : (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                <p>{testResult.error ?? testResult.message}</p>
                <p className="mt-2 text-muted-foreground">{t("backupProviders.credentialsHelp")}</p>
              </div>
            )}
            <div className="mt-6 flex justify-end">
              <button type="button" onClick={() => setTestResult(null)} className="rounded-md border px-3 py-1.5 text-sm font-medium">
                {t("common:actions.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire the hub tab**

In `apps/web/src/components/integrations/IntegrationsPage.tsx`:

```diff
@@ imports (:2-12)
-  DollarSign,
+  DollarSign,
+  HardDrive,
@@ (:18)
+import BackupProvidersIntegration from "./BackupProvidersIntegration";
@@ TabId (:46-56)
   | "accounting"
-  | "unifi";
+  | "unifi"
+  | "backup";
@@ tabs (:62-82)
   { id: "unifi", labelKey: "integrationsPage.unifi", icon: Network },
+  { id: "backup", labelKey: "integrationsPage.backup", icon: HardDrive },
@@ tabDocsPaths (:113-124)
   unifi: "/features/unifi-integration/",
+  backup: "/features/backup-provider-integrations/",
@@ render, after the unifi block (:566-568)
   {activeTab === "unifi" && !isOrgScoped && <UnifiIntegration />}
+  {/* The panel owns its own partner-scope gate, so no isOrgScoped branch is
+      needed here — see BackupProvidersIntegration. */}
+  {activeTab === "backup" && <BackupProvidersIntegration />}
```

`parseHash` needs no change: `tabs.some((t) => t.id === hash)` (`:174`) picks up `#backup` from the new `tabs` entry automatically.

- [ ] **Step 5: Add the alias page**

```astro
---
// apps/web/src/pages/settings/integrations/backup.astro
// Backup provider config lives in the /integrations hub (tab-based UI). Keep
// this route as a permanent alias so existing bookmarks / in-app links land on
// the right tab instead of an orphaned standalone page. Copy of huntress.astro.
return Astro.redirect('/integrations#backup', 301);
---
```

- [ ] **Step 6: Keep the mutation guard green**

In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, add to `TARGET_GLOBS` (`:35`):

```ts
  // Backup provider integration (W03, #6011): these three write partner-level
  // connector credentials and the customer→org mapping that decides whose
  // backup data lands in whose tenant. A silent failure here is invisible until
  // a customer's devices quietly stop appearing.
  'src/components/integrations/BackupProvidersIntegration.tsx',
  'src/components/integrations/BackupProviderConnectionCard.tsx',
  'src/components/integrations/BackupProviderCustomerMapping.tsx',
```

and bump the count at `:640`:

```ts
    // Backup provider integration (W03 #6011) adds three adopters, so the count
    // is now 136.
    expect(absoluteFiles.length).toBe(136);
```

- [ ] **Step 7: Run everything this task touches**

```bash
cd apps/web && npx vitest run \
  src/components/integrations/BackupProvidersIntegration.test.tsx \
  src/components/integrations/IntegrationsPage.test.tsx \
  src/components/integrations/IntegrationsPage.accountingPermissions.test.tsx \
  src/lib/__tests__/no-silent-mutations.test.ts \
  src/lib/i18n/keyUsage.test.ts \
  src/lib/i18n/extractionQuality.test.ts
cd apps/web && pnpm exec astro check
```
Expected: all green. `keyUsage` is the one that catches a typo'd `backupProviders.*` key; `extractionQuality` catches a bare `t()` on a key that carries `{{…}}`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/integrations/BackupProvidersIntegration.tsx \
        apps/web/src/components/integrations/BackupProvidersIntegration.test.tsx \
        apps/web/src/components/integrations/IntegrationsPage.tsx \
        apps/web/src/components/integrations/IntegrationsPage.test.tsx \
        apps/web/src/pages/settings/integrations/backup.astro \
        apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "$(cat <<'EOF'
feat(web/integrations): Backup tab for third-party backup providers

W03 Task 9. New top-level hub tab (#backup, HardDrive), the connection list and
add form, the shared test-result modal, and /settings/integrations/backup as a
301 alias for bookmarks.

The panel owns its own partner-scope gate on the JWT claim, not on
useOrgStore().partners.length — that array is empty for real partner users and
gating on it is the known anti-pattern this page already warns about.

A failed load renders an error, never the empty state: "no provider connected"
and "we could not ask" are different facts and only one is an all-clear.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Bucket math and the device table

**Files:**
- Create: `apps/web/src/components/backup/backupHealthBuckets.ts`
- Create: `apps/web/src/components/backup/backupHealthBuckets.test.ts`
- Create: `apps/web/src/components/backup/BackupHealthDeviceTable.tsx`

**Interfaces:**

Consumes: `BackupHealthRow`, `BackupHealthSummary`, `ExternalBackupStatus`, `BackupHealth`, `BackupRecency` from `@breeze/shared`; **the status→bucket grouping, also from `@breeze/shared` (W01)** — `BACKUP_STATUS_BUCKET_IDS`, `type BackupStatusBucketId`, `BACKUP_STATUS_BUCKET_MEMBERS`, `bucketForBackupStatus(status)`; `formatBytes` (`apps/web/src/components/backup/backupDashboardHelpers.ts:217` — the backup-directory helper the other backup components use, not `@/lib/utils`'s 2-decimal variant); `formatDateTime` (`apps/web/src/lib/dateTimeFormat.ts:110`).

Produces:
```ts
// The bucket IDENTITY and MEMBERSHIP are shared (W01). Only the Tailwind
// classes and the percentage maths are web-side.
export const STATUS_CLASS: Record<BackupStatusBucketId, string>;
export const STATUS_BUCKETS: ReadonlyArray<{ id: BackupStatusBucketId; statuses: readonly ExternalBackupStatus[]; className: string }>;
export const RECENCY_BUCKETS: readonly BackupRecency[];
export const HEALTH_DOT_CLASS: Record<BackupHealth, string>;
export const HISTORY_CELL_CLASS: Record<ExternalBackupStatus | 'none', string>;
export function statusBuckets(byStatus: BackupHealthSummary['byStatus']): Array<{ id: BackupStatusBucketId; count: number; percent: number; className: string }>;
export function recencyBuckets(byRecency: BackupHealthSummary['byRecency']): Array<{ id: BackupRecency; count: number; percent: number; className: string }>;
export default function BackupHealthDeviceTable(props: { rows: BackupHealthRow[] }): JSX.Element;  // in the .tsx
```

`StatusBucketId` is **not** declared here — `BackupStatusBucketId` comes from `@breeze/shared`. A local copy would be a second definition of the same closed set, which is exactly what W01 moved into shared to prevent.

**DECISION D-17 — there is a sixth bucket, `other`, and the grouping lives in `@breeze/shared`.** The spec's Cove-email bars name five (No backups / Completed / Completed with errors / In process / Unsuccessful = failed + over_quota + no_selection + interrupted). That leaves `not_started` and `unknown` in no bucket, so the percentages would not sum to 100% and a device in one of those states would vanish from the bars while still appearing in the table under it. `other` collects them and renders only when its count is non-zero.

W01 now ships that grouping as `BACKUP_STATUS_BUCKET_IDS` / `BACKUP_STATUS_BUCKET_MEMBERS` / `bucketForBackupStatus` so the W05 backup-status report and this overview cannot drift — two hand-maintained copies of "which statuses are Unsuccessful" is precisely how a report and a dashboard end up disagreeing about the same fleet. **W03 consumes it and adds nothing to it**: this file contributes the Tailwind classes and the percentage maths, and the exhaustiveness proof ("every status in exactly one bucket") is W01's test, not this one's.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/components/backup/backupHealthBuckets.test.ts
//
// SCOPE: this suite owns the WEB half only — counts, percentages, the
// `other`-when-non-zero filter, and that every bucket carries a class. The
// exhaustiveness proof ("every ExternalBackupStatus is in exactly one bucket")
// lives with the grouping itself, in @breeze/shared (W01), so it is asserted
// once for the overview AND the W05 report rather than once per consumer.
import { describe, expect, it } from 'vitest';
import { BACKUP_STATUS_BUCKET_IDS, EXTERNAL_BACKUP_STATUSES } from '@breeze/shared';

import { STATUS_BUCKETS, STATUS_CLASS, recencyBuckets, statusBuckets } from './backupHealthBuckets';

const zeroStatus = () => Object.fromEntries(EXTERNAL_BACKUP_STATUSES.map((s) => [s, 0])) as Record<string, number>;

describe('STATUS_BUCKETS', () => {
  it('is the shared bucket list, in the shared order, with nothing added or dropped', () => {
    expect(STATUS_BUCKETS.map((b) => b.id)).toEqual([...BACKUP_STATUS_BUCKET_IDS]);
  });

  it('gives every shared bucket a class — a new bucket in W01 must not render invisible', () => {
    for (const id of BACKUP_STATUS_BUCKET_IDS) {
      expect(STATUS_CLASS[id], `no class for bucket ${id}`).toBeTruthy();
    }
    expect(Object.keys(STATUS_CLASS).sort()).toEqual([...BACKUP_STATUS_BUCKET_IDS].sort());
  });
});

describe('statusBuckets', () => {
  it('sums each bucket and reports whole-number percentages of the total', () => {
    const buckets = statusBuckets({
      ...zeroStatus(),
      completed: 6, failed: 2, over_quota: 1, no_backups: 1,
    } as never);
    const byId = Object.fromEntries(buckets.map((b) => [b.id, b]));
    expect(byId.completed!.count).toBe(6);
    expect(byId.completed!.percent).toBe(60);
    expect(byId.unsuccessful!.count).toBe(3);
    expect(byId.unsuccessful!.percent).toBe(30);
    expect(byId.no_backups!.percent).toBe(10);
  });

  it('omits the `other` bucket when it is empty, and includes it when it is not', () => {
    expect(statusBuckets(zeroStatus() as never).some((b) => b.id === 'other')).toBe(false);
    expect(statusBuckets({ ...zeroStatus(), unknown: 1 } as never).some((b) => b.id === 'other')).toBe(true);
  });

  it('never divides by zero', () => {
    for (const bucket of statusBuckets(zeroStatus() as never)) expect(bucket.percent).toBe(0);
  });

  it('keeps the five named buckets even at zero, so the bar group never reflows', () => {
    expect(statusBuckets(zeroStatus() as never).map((b) => b.id)).toEqual([
      'no_backups', 'completed', 'completed_with_errors', 'in_progress', 'unsuccessful',
    ]);
  });
});

describe('recencyBuckets', () => {
  it('reports the four recency states in worst-first order', () => {
    const buckets = recencyBuckets({ never: 1, over_48h: 2, under_48h: 3, under_24h: 4 });
    expect(buckets.map((b) => b.id)).toEqual(['never', 'over_48h', 'under_48h', 'under_24h']);
    expect(buckets.map((b) => b.percent)).toEqual([10, 20, 30, 40]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/backup/backupHealthBuckets.test.ts
```
Expected: `Failed to resolve import "./backupHealthBuckets"`.

- [ ] **Step 3: Implement the helper**

```ts
// apps/web/src/components/backup/backupHealthBuckets.ts
/**
 * Bucket PRESENTATION for the backup-health bars.
 *
 * The grouping itself — which statuses make up "Unsuccessful", and the fact
 * that a sixth "other" bucket catches `not_started` and `unknown` so the
 * percentages sum to 100 and no device vanishes from the bars — lives in
 * @breeze/shared (W01) because the W05 backup-status report renders the same
 * buckets. Two hand-maintained copies of that membership is exactly how a
 * report and a dashboard end up describing one fleet differently.
 *
 * What is web-only, and therefore lives here: the Tailwind classes and the
 * percentage maths.
 */
import {
  BACKUP_STATUS_BUCKET_IDS,
  BACKUP_STATUS_BUCKET_MEMBERS,
  type BackupHealth,
  type BackupHealthSummary,
  type BackupRecency,
  type BackupStatusBucketId,
  type ExternalBackupStatus,
} from '@breeze/shared';

/** Typed against the shared id union, so adding a bucket in W01 fails to
 *  compile here until it is given a colour rather than rendering invisible. */
export const STATUS_CLASS: Record<BackupStatusBucketId, string> = {
  no_backups: 'bg-slate-400',
  completed: 'bg-emerald-500',
  completed_with_errors: 'bg-amber-500',
  in_progress: 'bg-sky-500',
  unsuccessful: 'bg-red-500',
  other: 'bg-slate-300',
};

export const STATUS_BUCKETS: ReadonlyArray<{
  id: BackupStatusBucketId;
  statuses: readonly ExternalBackupStatus[];
  className: string;
}> = BACKUP_STATUS_BUCKET_IDS.map((id) => ({
  id,
  statuses: BACKUP_STATUS_BUCKET_MEMBERS[id],
  className: STATUS_CLASS[id],
}));

/** Worst first — a reader scanning top-down meets the problem before the win. */
export const RECENCY_BUCKETS: readonly BackupRecency[] = ['never', 'over_48h', 'under_48h', 'under_24h'];

const RECENCY_CLASS: Record<BackupRecency, string> = {
  never: 'bg-red-500',
  over_48h: 'bg-amber-500',
  under_48h: 'bg-sky-500',
  under_24h: 'bg-emerald-500',
};

export const HEALTH_DOT_CLASS: Record<BackupHealth, string> = {
  healthy: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-red-500',
  unknown: 'bg-slate-400',
};

/** `none` is a day with NO observation — grey, and never green. */
export const HISTORY_CELL_CLASS: Record<ExternalBackupStatus | 'none', string> = {
  none: 'bg-muted',
  completed: 'bg-emerald-500',
  completed_with_errors: 'bg-amber-500',
  in_progress: 'bg-sky-400',
  not_started: 'bg-slate-300',
  interrupted: 'bg-amber-600',
  failed: 'bg-red-500',
  over_quota: 'bg-red-400',
  no_selection: 'bg-red-300',
  no_backups: 'bg-slate-400',
  unknown: 'bg-slate-300',
};

function percentOf(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 100);
}

export function statusBuckets(
  byStatus: BackupHealthSummary['byStatus'],
): Array<{ id: BackupStatusBucketId; count: number; percent: number; className: string }> {
  const counted = STATUS_BUCKETS.map((bucket) => ({
    ...bucket,
    count: bucket.statuses.reduce((sum, status) => sum + (byStatus[status] ?? 0), 0),
  }));
  const total = counted.reduce((sum, bucket) => sum + bucket.count, 0);
  return counted
    // The five named buckets always render, so the bar group does not reflow as
    // a fleet changes shape. `other` appears only when it has something to say.
    .filter((bucket) => bucket.id !== 'other' || bucket.count > 0)
    .map(({ id, count, className }) => ({ id, count, className, percent: percentOf(count, total) }));
}

export function recencyBuckets(
  byRecency: BackupHealthSummary['byRecency'],
): Array<{ id: BackupRecency; count: number; percent: number; className: string }> {
  const total = RECENCY_BUCKETS.reduce((sum, id) => sum + (byRecency[id] ?? 0), 0);
  return RECENCY_BUCKETS.map((id) => ({
    id,
    count: byRecency[id] ?? 0,
    percent: percentOf(byRecency[id] ?? 0, total),
    className: RECENCY_CLASS[id],
  }));
}
```

- [ ] **Step 4: Implement the table**

```tsx
// apps/web/src/components/backup/BackupHealthDeviceTable.tsx
import type { BackupHealthRow } from '@breeze/shared';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatBytes } from './backupDashboardHelpers';
import { HEALTH_DOT_CLASS, HISTORY_CELL_CLASS } from './backupHealthBuckets';
import '../../lib/i18n';

/** The 28-day observed-health bar. A day with no observation is grey, NOT
 *  green — "we did not look" and "it was fine" are different facts. */
function HistoryBar({ row }: { row: BackupHealthRow }) {
  const { t } = useTranslation('backup');
  return (
    <div data-testid={`backup-health-history-${row.key}`} className="flex gap-px" aria-hidden="false">
      {row.history28d.map((cell) => (
        <span
          key={cell.day}
          title={`${cell.day} — ${cell.status ?? t('backupHealth.noObservation')}`}
          className={cn('h-4 w-1 rounded-[1px]', HISTORY_CELL_CLASS[cell.status ?? 'none'])}
        />
      ))}
    </div>
  );
}

export default function BackupHealthDeviceTable({ rows }: { rows: BackupHealthRow[] }) {
  const { t } = useTranslation('backup');

  if (rows.length === 0) {
    return (
      <p data-testid="backup-health-empty" className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        {t('backupHealth.empty')}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1100px] text-sm">
        <thead>
          <tr className="border-b text-left text-xs font-semibold uppercase text-muted-foreground">
            <th className="pb-2 pr-3">{t('backupHealth.table.device')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.computerName')}</th>
            <th className="pb-2 pr-3">{t('common:labels.organization')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.source')}</th>
            <th className="pb-2 pr-3">{t('common:labels.type')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.dataSources')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.selected')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.used')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.history')}</th>
            <th className="pb-2 pr-3">{t('common:labels.status')}</th>
            <th className="pb-2 pr-3">{t('backupHealth.table.errors')}</th>
            <th className="pb-2">{t('backupHealth.table.agent')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-testid={`backup-health-row-${row.key}`} className="border-b last:border-0">
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  <span
                    data-testid={`backup-health-dot-${row.key}`}
                    title={t(/* i18n-dynamic */ `backupHealth.health.${row.health}`)}
                    className={cn('h-2.5 w-2.5 shrink-0 rounded-full', HEALTH_DOT_CLASS[row.health])}
                  />
                  {row.deviceId ? (
                    <a href={`/devices/${row.deviceId}`} className="font-medium text-primary hover:underline">
                      {row.name}
                    </a>
                  ) : (
                    <span className="font-medium text-foreground">{row.name}</span>
                  )}
                </div>
                <div className="pl-[18px] text-xs text-muted-foreground">
                  {formatDateTime(row.lastSuccessAt, { fallback: '--', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{row.computerName ?? '--'}</td>
              <td className="py-2 pr-3 text-muted-foreground">{row.orgName}</td>
              <td className="py-2 pr-3">
                <span
                  data-testid={`backup-health-source-${row.key}`}
                  className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {row.source === 'breeze' ? t('backupHealth.sourceBreeze') : (row.providerLabel ?? row.providerKey)}
                </span>
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{row.osType}</td>
              <td className="py-2 pr-3 text-muted-foreground">{row.dataSources.join(', ') || '--'}</td>
              <td className="py-2 pr-3 text-muted-foreground">{row.selectedBytes == null ? '--' : formatBytes(row.selectedBytes)}</td>
              <td className="py-2 pr-3 text-muted-foreground">{row.usedBytes == null ? '--' : formatBytes(row.usedBytes)}</td>
              <td className="py-2 pr-3"><HistoryBar row={row} /></td>
              <td className="py-2 pr-3 text-muted-foreground">{row.status}</td>
              <td className="py-2 pr-3 text-muted-foreground">{row.errorsCount}</td>
              <td className="py-2 text-muted-foreground">
                {row.agentOnline == null
                  ? '--'
                  : row.agentOnline
                    ? t('common:states.online')
                    : t('common:states.offline')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 5: Run the helper tests green and commit**

```bash
cd apps/web && npx vitest run src/components/backup/backupHealthBuckets.test.ts
cd apps/web && pnpm exec astro check
git add apps/web/src/components/backup/backupHealthBuckets.ts \
        apps/web/src/components/backup/backupHealthBuckets.test.ts \
        apps/web/src/components/backup/BackupHealthDeviceTable.tsx
git commit -m "$(cat <<'EOF'
feat(web/backup): bucket presentation and the unified backup-health device table

W03 Task 10. The bucket identity and membership come from @breeze/shared
(BACKUP_STATUS_BUCKET_IDS / _MEMBERS, W01) because the W05 report renders the
same buckets — two hand-maintained copies of "which statuses are Unsuccessful"
is how a report and a dashboard end up describing one fleet differently. This
file contributes the Tailwind classes and the percentage maths only, and
STATUS_CLASS is typed against the shared id union so a bucket added in W01
fails to compile here rather than rendering invisible.

A 28-day cell with no observation is grey, never green — "we did not look" and
"it was fine" are different facts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `BackupHealthOverview.tsx` and the all-orgs wiring

**Files:**
- Create: `apps/web/src/components/backup/BackupHealthOverview.tsx`
- Create: `apps/web/src/components/backup/BackupHealthOverview.test.tsx`
- Modify: `apps/web/src/components/backup/BackupOverviewContent.tsx` (`:156-166` props + the block above the stat grid at `:204`)
- Modify: `apps/web/src/components/backup/BackupDashboard.tsx` (`:89-182` fetch, `:390-418` render, `:491-497` gate)
- Modify: `apps/web/src/components/backup/BackupDashboard.test.tsx`

**Interfaces:**

Consumes: `BackupHealthDeviceTable`, `statusBuckets`, `recencyBuckets` (Task 10); `useOrgScope` (`apps/web/src/hooks/useOrgScope.ts:51`); `widthPercentClass` (`apps/web/src/lib/utils.ts:162` — the same helper the storage bars use at `BackupOverviewContent.tsx:345`); `fetchWithAuth`.

Produces:
```tsx
export default function BackupHealthOverview(props: { orgId: string | null }): JSX.Element;
```

**DECISION D-15 — `BackupDashboard` resolves the all-orgs branch ABOVE `OrgRequiredGate`.** The gate renders `OrgRequiredState` whenever `scope === 'all'` (`apps/web/src/components/shared/OrgRequiredGate.tsx:40`), which would hide the very view all-orgs mode exists to show. So `BackupDashboard` reads `useOrgScope()` itself: on `scope: 'all'` it renders `BackupHealthOverview` alone (skipping `/backup/dashboard` and `/backup/usage-history`, both of which 400 without an org); on `scope: 'org'` it keeps the gate and renders the health view above the existing tiles. Loading / error / empty still fall through to the gate.

**DECISION D-27 — the overview fetches `/backup/health/devices` itself** rather than receiving rows as props. `BackupOverviewContent` already takes 24 props (`:126-153`); threading rows, summary, filters, cursor and four setters through it would add nine more for no benefit, and the health view is independent of the tile data.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/backup/BackupHealthOverview.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BackupHealthOverview from './BackupHealthOverview';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const row = (o: Record<string, unknown> = {}) => ({
  key: 'breeze:d1', source: 'breeze', providerKey: null, providerLabel: null,
  orgId: 'org-1', orgName: 'Acme', siteId: 's1', deviceId: 'd1',
  name: 'SRV01', computerName: 'srv01', osType: 'server', accountType: 'endpoint',
  status: 'completed', health: 'healthy', recency: 'under_24h', covered: true, stale: false,
  lastSuccessAt: '2026-09-15T02:00:00.000Z', lastSessionAt: '2026-09-15T02:00:00.000Z',
  selectedBytes: null, usedBytes: 1024, errorsCount: 0, dataSources: [],
  history28d: [{ day: '2026-09-15', status: 'completed' }], agentOnline: true,
  ...o,
});

const summary = (o: Record<string, unknown> = {}) => ({
  endpoints: { total: 10, covered: 6, uncovered: 4 },
  providerOnly: 2, m365Accounts: 1,
  byStatus: { completed: 6, failed: 2, over_quota: 1, no_backups: 1, completed_with_errors: 0, in_progress: 0, interrupted: 0, no_selection: 0, not_started: 0, unknown: 0 },
  byHealth: { healthy: 6, warning: 0, critical: 4, unknown: 0 },
  byRecency: { under_24h: 4, under_48h: 3, over_48h: 2, never: 1 },
  ...o,
});

function respond(body: Record<string, unknown>) {
  fetchMock.mockResolvedValue(res({ data: { rows: [row()], summary: summary(), nextCursor: null, stale: false, unmappedDevices: 0, ...body } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  respond({});
});

describe('BackupHealthOverview', () => {
  it('requests the org-scoped feed with the Cove-email default filter', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/backup/health/devices');
    expect(url).toContain('orgId=org-1');
    expect(url).toContain('withBackup=true');
  });

  it('omits orgId entirely in all-organizations mode', async () => {
    render(<BackupHealthOverview orgId={null} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('orgId=');
  });

  it('renders the status bars with counts and percentages', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    const completed = await screen.findByTestId('backup-health-status-completed');
    expect(completed.textContent).toContain('6');
    expect(completed.textContent).toContain('60');
    const unsuccessful = screen.getByTestId('backup-health-status-unsuccessful');
    expect(unsuccessful.textContent).toContain('3');
  });

  it('renders the four last-successful-backup bars', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    for (const id of ['never', 'over_48h', 'under_48h', 'under_24h']) {
      expect(await screen.findByTestId(`backup-health-recency-${id}`)).toBeInTheDocument();
    }
  });

  it('shows the coverage line with the endpoint denominators', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    const coverage = await screen.findByTestId('backup-health-coverage');
    expect(coverage.textContent).toContain('6');
    expect(coverage.textContent).toContain('10');
  });

  it('shows the stale banner only when the API says the data is stale', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    await screen.findByTestId('backup-health-coverage');
    expect(screen.queryByTestId('backup-health-stale')).toBeNull();

    respond({ stale: true });
    render(<BackupHealthOverview orgId="org-2" />);
    expect(await screen.findByTestId('backup-health-stale')).toBeInTheDocument();
  });

  it('shows the unmapped-devices notice only when there are unmapped devices', async () => {
    respond({ unmappedDevices: 18 });
    render(<BackupHealthOverview orgId="org-1" />);
    const notice = await screen.findByTestId('backup-health-unmapped');
    expect(notice.textContent).toContain('18');
  });

  it('refetches with the health filter and resets the cursor', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    await screen.findByTestId('backup-health-coverage');
    fireEvent.change(screen.getByTestId('backup-health-filter-health'), { target: { value: 'critical' } });
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('health=critical'));
    expect(String(fetchMock.mock.calls.at(-1)![0])).not.toContain('cursor=');
  });

  it('refetches with the source filter', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    await screen.findByTestId('backup-health-coverage');
    fireEvent.change(screen.getByTestId('backup-health-filter-source'), { target: { value: 'provider' } });
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('source=provider'));
  });

  it('flips withBackup when the include-without-backup toggle is used', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    await screen.findByTestId('backup-health-coverage');
    fireEvent.click(screen.getByTestId('backup-health-filter-without-backup'));
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('withBackup=false'));
  });

  it('appends the next page and hides Load more once the cursor runs out', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ data: { rows: [row()], summary: summary(), nextCursor: 'c1', stale: false, unmappedDevices: 0 } }))
      .mockResolvedValueOnce(res({ data: { rows: [row({ key: 'provider:p1', deviceId: null, source: 'provider', providerLabel: 'Cove Data Protection', name: 'ACME-WS09' })], summary: summary(), nextCursor: null, stale: false, unmappedDevices: 0 } }));

    render(<BackupHealthOverview orgId="org-1" />);
    fireEvent.click(await screen.findByTestId('backup-health-load-more'));

    expect(await screen.findByTestId('backup-health-row-provider:p1')).toBeInTheDocument();
    expect(screen.getByTestId('backup-health-row-breeze:d1')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('backup-health-load-more')).toBeNull());
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('cursor=c1');
  });

  it('surfaces a load failure rather than an empty, all-clear table', async () => {
    fetchMock.mockResolvedValue(res({ error: 'nope' }, false, 500));
    render(<BackupHealthOverview orgId="org-1" />);
    expect(await screen.findByTestId('backup-health-error')).toBeInTheDocument();
    expect(screen.queryByTestId('backup-health-empty')).toBeNull();
  });
});
```

Add to `apps/web/src/components/backup/BackupDashboard.test.tsx` (with a mutable `vi.hoisted` org-scope stub, the `IntegrationsPage.test.tsx:9-12` idiom):

```tsx
const scopeState = vi.hoisted(() => ({ scope: 'org' as 'org' | 'all', orgId: 'org-1' as string | null }));
vi.mock('@/hooks/useOrgScope', () => ({
  useOrgScope: () => (scopeState.scope === 'all'
    ? { ready: true, status: 'resolved', scope: 'all', orgId: null, org: null, error: null }
    : { ready: true, status: 'resolved', scope: 'org', orgId: scopeState.orgId, org: null, error: null }),
}));
vi.mock('./BackupHealthOverview', () => ({ default: () => <div data-testid="stub-health-overview" /> }));
```

```tsx
  it('renders the health view alone in all-organizations mode, calling neither org-only endpoint', async () => {
    scopeState.scope = 'all';
    render(<BackupDashboard />);
    expect(await screen.findByTestId('stub-health-overview')).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).not.toContain('/backup/dashboard');
    expect(urls.some((u) => u.startsWith('/backup/usage-history'))).toBe(false);
  });

  it('renders the health view above the tiles in org mode and still loads the dashboard', async () => {
    scopeState.scope = 'org';
    render(<BackupDashboard />);
    expect(await screen.findByTestId('stub-health-overview')).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain('/backup/dashboard');
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/web && npx vitest run src/components/backup/BackupHealthOverview.test.tsx src/components/backup/BackupDashboard.test.tsx
```
Expected: `Failed to resolve import './BackupHealthOverview'`.

- [ ] **Step 3: Implement the overview**

```tsx
// apps/web/src/components/backup/BackupHealthOverview.tsx
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BackupHealth, BackupHealthRow, BackupHealthSummary } from '@breeze/shared';

import { cn, widthPercentClass } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import BackupHealthDeviceTable from './BackupHealthDeviceTable';
import { recencyBuckets, statusBuckets } from './backupHealthBuckets';
import '../../lib/i18n';

type Filters = {
  health: BackupHealth | 'all';
  source: 'all' | 'breeze' | 'provider';
  search: string;
  withBackup: boolean;
};

const EMPTY_FILTERS: Filters = { health: 'all', source: 'all', search: '', withBackup: true };

function BarGroup({
  title,
  testIdPrefix,
  buckets,
  label,
}: {
  title: string;
  testIdPrefix: string;
  buckets: Array<{ id: string; count: number; percent: number; className: string }>;
  label: (id: string) => string;
}) {
  return (
    <div className="rounded-lg border bg-card p-5 shadow-xs">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <div className="mt-4 space-y-3">
        {buckets.map((bucket) => (
          <div key={bucket.id} data-testid={`${testIdPrefix}-${bucket.id}`} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground">{label(bucket.id)}</span>
              <span className="text-xs text-muted-foreground">
                <span>{bucket.count}</span>
                <span> · </span>
                <span>{bucket.percent}</span>
                <span>%</span>
              </span>
            </div>
            {/* Same bar shape as the storage-provider bars (BackupOverviewContent.tsx:344). */}
            <div className="h-2 w-full rounded-full bg-muted">
              <div className={cn('h-2 rounded-full', bucket.className, widthPercentClass(bucket.percent))} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BackupHealthOverview({ orgId }: { orgId: string | null }) {
  const { t } = useTranslation('backup');
  const [rows, setRows] = useState<BackupHealthRow[]>([]);
  const [summary, setSummary] = useState<BackupHealthSummary | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [unmappedDevices, setUnmappedDevices] = useState(0);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (orgId) params.set('orgId', orgId);
      if (filters.health !== 'all') params.set('health', filters.health);
      if (filters.source !== 'all') params.set('source', filters.source);
      if (filters.search.trim()) params.set('search', filters.search.trim());
      params.set('withBackup', String(filters.withBackup));
      if (cursor) params.set('cursor', cursor);
      try {
        const response = await fetchWithAuth(`/backup/health/devices?${params.toString()}`);
        if (!response.ok) throw new Error(`${response.status}`);
        const payload = await response.json();
        const data = payload?.data ?? {};
        setRows((current) => (append ? [...current, ...(data.rows ?? [])] : (data.rows ?? [])));
        setSummary(data.summary ?? null);
        setNextCursor(data.nextCursor ?? null);
        setStale(Boolean(data.stale));
        setUnmappedDevices(Number(data.unmappedDevices ?? 0));
      } catch (err) {
        console.error('[BackupHealthOverview] load:', err);
        // An empty table under a failed fetch reads as "nothing needs
        // attention". Say what actually happened instead.
        setError(t('backupHealth.error'));
      } finally {
        setLoading(false);
      }
    },
    [filters, orgId, t],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const patchFilters = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">{t('backupHealth.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('backupHealth.subtitle')}</p>
      </div>

      {stale && (
        <div data-testid="backup-health-stale" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('backupHealth.staleBanner')}</span>
        </div>
      )}

      {unmappedDevices > 0 && (
        <div data-testid="backup-health-unmapped" className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {t('backupHealth.unmappedNotice', { value: unmappedDevices })}
        </div>
      )}

      {error && (
        <div data-testid="backup-health-error" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {summary && (
        <>
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span data-testid="backup-health-coverage">
              {t('backupHealth.coverage', { covered: summary.endpoints.covered, total: summary.endpoints.total })}
            </span>
            <span data-testid="backup-health-provider-only">
              {t('backupHealth.providerOnly', { value: summary.providerOnly })}
            </span>
            <span data-testid="backup-health-m365">
              {t('backupHealth.m365Accounts', { value: summary.m365Accounts })}
            </span>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <BarGroup
              title={t('backupHealth.statusTitle')}
              testIdPrefix="backup-health-status"
              buckets={statusBuckets(summary.byStatus)}
              label={(id) => t(/* i18n-dynamic */ `backupHealth.status.${id}`)}
            />
            <BarGroup
              title={t('backupHealth.recencyTitle')}
              testIdPrefix="backup-health-recency"
              buckets={recencyBuckets(summary.byRecency)}
              label={(id) => t(/* i18n-dynamic */ `backupHealth.recency.${id}`)}
            />
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <select
          data-testid="backup-health-filter-health"
          value={filters.health}
          onChange={(e) => patchFilters({ health: e.target.value as Filters['health'] })}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="all">{t('backupHealth.healthAll')}</option>
          {(['critical', 'warning', 'healthy', 'unknown'] as const).map((value) => (
            <option key={value} value={value}>
              {t(/* i18n-dynamic */ `backupHealth.health.${value}`)}
            </option>
          ))}
        </select>
        <select
          data-testid="backup-health-filter-source"
          value={filters.source}
          onChange={(e) => patchFilters({ source: e.target.value as Filters['source'] })}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="all">{t('backupHealth.sourceAll')}</option>
          <option value="breeze">{t('backupHealth.sourceBreeze')}</option>
          <option value="provider">{t('backupProviders.cove', { ns: 'integrations' })}</option>
        </select>
        <input
          data-testid="backup-health-filter-search"
          value={filters.search}
          placeholder={t('backupHealth.searchPlaceholder')}
          onChange={(e) => patchFilters({ search: e.target.value })}
          className="h-9 min-w-[220px] rounded-md border bg-background px-2 text-sm"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            data-testid="backup-health-filter-without-backup"
            type="checkbox"
            checked={!filters.withBackup}
            onChange={(e) => patchFilters({ withBackup: !e.target.checked })}
          />
          <span>{t('backupHealth.includeWithoutBackup')}</span>
        </label>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {!error && <BackupHealthDeviceTable rows={rows} />}

      {nextCursor && (
        <div className="flex justify-center">
          <button
            type="button"
            data-testid="backup-health-load-more"
            disabled={loading}
            onClick={() => void load(nextCursor, true)}
            className="rounded-md border bg-card px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {t('backupHealth.loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire it into the overview and the dashboard**

`BackupOverviewContent.tsx` — add one prop and render the health view above the stat grid:

```diff
@@ props type (:126-153)
   fetchOverview: () => void;
+  /** Org for the unified health view, or null in all-organizations mode. */
+  healthOrgId: string | null;
@@ destructuring (:158-165)
-    fetchOverview
+    fetchOverview, healthOrgId
@@ above the stat grid (:204)
+      <BackupHealthOverview orgId={healthOrgId} />
+
       <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
```
plus `import BackupHealthOverview from './BackupHealthOverview';`.

`BackupDashboard.tsx`:

```diff
@@ imports
+import { useOrgScope } from '@/hooks/useOrgScope';
+import BackupHealthOverview from './BackupHealthOverview';
@@ BackupDashboardInner (:68-71)
 function BackupDashboardInner() {
   const { t } = useTranslation('backup');
+  const orgScope = useOrgScope();
@@ BackupOverviewContent call (:390-418)
           fetchOverview={fetchOverview}
+          healthOrgId={orgScope.scope === 'org' ? orgScope.orgId : null}
@@ default export (:491-497)
 export default function BackupDashboard() {
+  const scope = useOrgScope();
+  // The org gate renders OrgRequiredState for scope 'all' (OrgRequiredGate.tsx:40),
+  // which would hide the very view all-organizations mode exists to show. The
+  // fleet view needs no org — and /backup/dashboard and /backup/usage-history
+  // both 400 without one — so it is resolved before the gate.
+  if (scope.status === 'resolved' && scope.scope === 'all') {
+    return (
+      <div className="space-y-6">
+        <BackupHealthOverview orgId={null} />
+      </div>
+    );
+  }
   return (
     <OrgRequiredGate>
       <BackupDashboardInner />
     </OrgRequiredGate>
   );
 }
```

- [ ] **Step 5: Run everything and commit**

```bash
cd apps/web && npx vitest run src/components/backup/BackupHealthOverview.test.tsx \
  src/components/backup/BackupDashboard.test.tsx \
  src/lib/i18n/keyUsage.test.ts src/lib/i18n/extractionQuality.test.ts
cd apps/web && pnpm exec astro check
git add apps/web/src/components/backup/BackupHealthOverview.tsx \
        apps/web/src/components/backup/BackupHealthOverview.test.tsx \
        apps/web/src/components/backup/BackupOverviewContent.tsx \
        apps/web/src/components/backup/BackupDashboard.tsx \
        apps/web/src/components/backup/BackupDashboard.test.tsx
git commit -m "$(cat <<'EOF'
feat(web/backup): unified backup-health overview with an all-organizations mode

W03 Task 11. Status and last-successful-backup bars, the device table, stale
banner, unmapped-devices notice, filters and cursor paging — over both sources
at once.

All-orgs mode is resolved ABOVE OrgRequiredGate: the gate renders
OrgRequiredState for scope 'all', which would hide exactly the fleet view this
mode exists for, and /backup/dashboard and /backup/usage-history both 400
without an org. In org mode the gate stays and the health view sits above the
existing tiles.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `ExternalBackupCard.tsx` on the device Backup tab

**Files:**
- Create: `apps/web/src/components/backup/ExternalBackupCard.tsx`
- Create: `apps/web/src/components/backup/ExternalBackupCard.test.tsx`
- Modify: `apps/web/src/components/backup/DeviceBackupTab.tsx` (`:211-234` fetch block, `:380-390` empty state, `:419-421` render root)
- Modify: `apps/web/src/components/backup/DeviceBackupTab.test.tsx`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS`, count 136 → 137)

**Interfaces:**

Consumes: `GET /backup/providers/devices?deviceId=<id>` and `PUT /backup/providers/devices/:id/link` (both W01); `HISTORY_CELL_CLASS`, `HEALTH_DOT_CLASS` (Task 10); `formatBytes` (`backupDashboardHelpers.ts:217`); `formatDateTime` (`@/lib/dateTimeFormat`); `runAction`.

Produces:
```tsx
export type ProviderDeviceRow = {
  id: string; provider: string; orgId: string;
  vendorDeviceName: string; computerName: string | null;
  customerName: string | null;
  status: ExternalBackupStatus; health?: BackupHealth;
  lastSuccessAt: string | null; lastSessionAt: string | null;
  selectedBytes: number | null; usedBytes: number | null;
  errorsCount: number; dataSources: string[];
  breezeDeviceId: string | null;
  history28d?: Array<{ day: string; status: ExternalBackupStatus | null }>;
};
export default function ExternalBackupCard(props: {
  deviceId: string;
  onUnlinked?: () => void;
  /** Rendered when there is no provider row AND no first-party config. */
  onPresenceChange?: (present: boolean) => void;
}): JSX.Element | null;
```

**DECISION D-28 — the component consumes W01's `GET /backup/providers/devices` defensively.** W01 is being written in parallel, so this wave pins only what the plan index already locks: the route path, the `{ data: [...] }` envelope every other Breeze list route uses, and column names camel-cased from the spec's `backup_provider_devices` table. `health` and `history28d` are read as **optional** — if W01's route returns raw table rows without them, the card derives `health` client-side from `status` + `lastSuccessAt` using `deriveBackupHealth` from `@breeze/shared` and renders no bar. That keeps W03 shippable whichever shape W01 lands, and the fallback is asserted by a test.

**DECISION D-29 — the card renders `null` when there is no provider row,** and reports that through `onPresenceChange` so `DeviceBackupTab` can extend its empty state without a second fetch.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/backup/ExternalBackupCard.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ExternalBackupCard from './ExternalBackupCard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const providerRow = (o: Record<string, unknown> = {}) => ({
  id: 'row-1', provider: 'cove', orgId: 'org-1',
  vendorDeviceName: 'ACME-SRV01', computerName: 'srv01', customerName: 'Acme North',
  status: 'completed', health: 'healthy',
  lastSuccessAt: '2026-09-15T01:00:00.000Z', lastSessionAt: '2026-09-15T01:00:00.000Z',
  selectedBytes: 2048, usedBytes: 4096, errorsCount: 0, dataSources: ['files', 'mssql'],
  breezeDeviceId: 'device-1',
  history28d: [{ day: '2026-09-15', status: 'completed' }],
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(res({ data: [providerRow()] }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('ExternalBackupCard', () => {
  it('fetches the provider row for this device only', async () => {
    render(<ExternalBackupCard deviceId="device-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/backup/providers/devices?deviceId=device-1'));
  });

  it('renders status, health, sizes, data sources and the customer name', async () => {
    render(<ExternalBackupCard deviceId="device-1" />);
    const card = await screen.findByTestId('external-backup-card');
    expect(card.textContent).toContain('completed');
    expect(card.textContent).toContain('Acme North');
    expect(card.textContent).toContain('files, mssql');
    expect(screen.getByTestId('external-backup-selected').textContent).toContain('2.00 KB');
    expect(screen.getByTestId('external-backup-used').textContent).toContain('4.00 KB');
    expect(screen.getByTestId('external-backup-health-dot')).toBeInTheDocument();
  });

  it('renders the 28-day bar when the API supplies history', async () => {
    render(<ExternalBackupCard deviceId="device-1" />);
    expect(await screen.findByTestId('external-backup-history')).toBeInTheDocument();
  });

  it('derives health client-side and skips the bar when the API omits both', async () => {
    fetchMock.mockResolvedValue(res({ data: [providerRow({ health: undefined, history28d: undefined, status: 'failed' })] }));
    render(<ExternalBackupCard deviceId="device-1" />);
    await screen.findByTestId('external-backup-card');
    expect(screen.queryByTestId('external-backup-history')).toBeNull();
    expect(screen.getByTestId('external-backup-health-dot')).toBeInTheDocument();
  });

  it('renders nothing and reports absence when there is no provider row', async () => {
    fetchMock.mockResolvedValue(res({ data: [] }));
    const onPresenceChange = vi.fn();
    render(<ExternalBackupCard deviceId="device-1" onPresenceChange={onPresenceChange} />);
    await waitFor(() => expect(onPresenceChange).toHaveBeenCalledWith(false));
    expect(screen.queryByTestId('external-backup-card')).toBeNull();
  });

  it('PUTs deviceId:null to unlink, after confirming', async () => {
    const onUnlinked = vi.fn();
    render(<ExternalBackupCard deviceId="device-1" onUnlinked={onUnlinked} />);
    fireEvent.click(await screen.findByTestId('external-backup-unlink'));

    await waitFor(() => expect(onUnlinked).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('/backup/providers/devices/row-1/link');
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ deviceId: null });
  });

  it('does not unlink when the confirm is dismissed', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<ExternalBackupCard deviceId="device-1" />);
    fireEvent.click(await screen.findByTestId('external-backup-unlink'));
    expect(fetchMock).toHaveBeenCalledTimes(1); // the initial GET only
  });

  it('surfaces a load failure instead of silently rendering nothing', async () => {
    fetchMock.mockResolvedValue(res({ error: 'nope' }, false, 500));
    render(<ExternalBackupCard deviceId="device-1" />);
    expect(await screen.findByTestId('external-backup-error')).toBeInTheDocument();
  });
});
```

Add to `apps/web/src/components/backup/DeviceBackupTab.test.tsx`:

```tsx
vi.mock('./ExternalBackupCard', () => ({
  default: ({ onPresenceChange }: { onPresenceChange?: (p: boolean) => void }) => {
    onPresenceChange?.(externalPresent);
    return externalPresent ? <div data-testid="stub-external-backup" /> : null;
  },
}));
let externalPresent = true;
```

```tsx
  it('renders the external backup card above the first-party sections', async () => {
    externalPresent = true;
    render(<DeviceBackupTab deviceId="device-1" />);
    expect(await screen.findByTestId('stub-external-backup')).toBeInTheDocument();
  });

  it('points at third-party connections from the empty state when neither source has anything', async () => {
    externalPresent = false;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/status/device-1') return makeJsonResponse({ data: { protected: false } });
      return makeJsonResponse({ data: [] });
    });
    render(<DeviceBackupTab deviceId="device-1" />);
    expect(await screen.findByTestId('device-backup-empty-external-hint')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/web && npx vitest run src/components/backup/ExternalBackupCard.test.tsx src/components/backup/DeviceBackupTab.test.tsx
```
Expected: `Failed to resolve import './ExternalBackupCard'`.

- [ ] **Step 3: Implement the card**

```tsx
// apps/web/src/components/backup/ExternalBackupCard.tsx
import { useCallback, useEffect, useState } from 'react';
import { HardDrive, Loader2, Unlink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { deriveBackupHealth, type BackupHealth, type ExternalBackupStatus } from '@breeze/shared';

import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError, runAction } from '@/lib/runAction';
import { formatBytes } from './backupDashboardHelpers';
import { HEALTH_DOT_CLASS, HISTORY_CELL_CLASS } from './backupHealthBuckets';
import '../../lib/i18n';

export type ProviderDeviceRow = {
  id: string;
  provider: string;
  orgId: string;
  vendorDeviceName: string;
  computerName: string | null;
  customerName: string | null;
  status: ExternalBackupStatus;
  /** Optional: W01's route may return the raw row. Derived locally when absent. */
  health?: BackupHealth;
  lastSuccessAt: string | null;
  lastSessionAt: string | null;
  selectedBytes: number | null;
  usedBytes: number | null;
  errorsCount: number;
  dataSources: string[];
  breezeDeviceId: string | null;
  /** Optional: the bar is skipped rather than faked when the route omits it. */
  history28d?: Array<{ day: string; status: ExternalBackupStatus | null }>;
};

export default function ExternalBackupCard({
  deviceId,
  onUnlinked,
  onPresenceChange,
}: {
  deviceId: string;
  onUnlinked?: () => void;
  onPresenceChange?: (present: boolean) => void;
}) {
  const { t } = useTranslation('backup');
  const [row, setRow] = useState<ProviderDeviceRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchWithAuth(`/backup/providers/devices?deviceId=${deviceId}`);
      if (!response.ok) throw new Error(`${response.status}`);
      const payload = await response.json();
      const first: ProviderDeviceRow | null = Array.isArray(payload?.data) ? (payload.data[0] ?? null) : null;
      setRow(first);
      onPresenceChange?.(first !== null);
    } catch (err) {
      console.error('[ExternalBackupCard] load:', err);
      // Not silent: an absent card and a failed lookup look identical to the
      // reader, and only one of them means "no third-party backup".
      setError(t('backupHealth.external.error'));
      onPresenceChange?.(false);
    }
  }, [deviceId, onPresenceChange, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUnlink = async () => {
    if (!row) return;
    if (!window.confirm(t('backupHealth.external.unlinkConfirm'))) return;
    setBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/backup/providers/devices/${row.id}/link`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: null }),
          }),
        errorFallback: t('backupHealth.external.errorUnlink'),
        successMessage: t('backupHealth.external.unlinkedToast'),
      });
      setRow(null);
      onPresenceChange?.(false);
      onUnlinked?.();
    } catch (err) {
      handleActionError(err, t('backupHealth.external.errorUnlink'));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div data-testid="external-backup-error" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!row) return null;

  const health: BackupHealth =
    row.health ??
    deriveBackupHealth({ status: row.status, lastSuccessAt: row.lastSuccessAt, errorsCount: row.errorsCount }).health;

  return (
    <div data-testid="external-backup-card" className="rounded-lg border bg-card p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            data-testid="external-backup-health-dot"
            title={t(/* i18n-dynamic */ `backupHealth.health.${health}`)}
            className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', HEALTH_DOT_CLASS[health])}
          />
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <HardDrive className="h-4 w-4" />
              {t('backupHealth.external.title')}
            </h3>
            <p className="text-sm text-muted-foreground">{row.vendorDeviceName}</p>
          </div>
        </div>
        <span className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">{row.status}</span>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">{t('backupHealth.external.lastSuccess')}</dt>
          <dd className="text-sm text-foreground">
            {formatDateTime(row.lastSuccessAt, { fallback: '--', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('backupHealth.external.lastSession')}</dt>
          <dd className="text-sm text-foreground">
            {formatDateTime(row.lastSessionAt, { fallback: '--', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('backupHealth.external.customer')}</dt>
          <dd className="text-sm text-foreground">{row.customerName ?? '--'}</dd>
        </div>
        <div data-testid="external-backup-selected">
          <dt className="text-xs text-muted-foreground">{t('backupHealth.table.selected')}</dt>
          <dd className="text-sm text-foreground">{row.selectedBytes == null ? '--' : formatBytes(row.selectedBytes)}</dd>
        </div>
        <div data-testid="external-backup-used">
          <dt className="text-xs text-muted-foreground">{t('backupHealth.table.used')}</dt>
          <dd className="text-sm text-foreground">{row.usedBytes == null ? '--' : formatBytes(row.usedBytes)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('backupHealth.table.errors')}</dt>
          <dd className="text-sm text-foreground">{row.errorsCount}</dd>
        </div>
        <div className="sm:col-span-3">
          <dt className="text-xs text-muted-foreground">{t('backupHealth.table.dataSources')}</dt>
          <dd className="text-sm text-foreground">{row.dataSources.join(', ') || '--'}</dd>
        </div>
      </dl>

      {row.history28d && row.history28d.length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-muted-foreground">{t('backupHealth.table.history')}</p>
          <div data-testid="external-backup-history" className="mt-1 flex gap-px">
            {row.history28d.map((cell) => (
              <span
                key={cell.day}
                title={`${cell.day} — ${cell.status ?? t('backupHealth.noObservation')}`}
                className={cn('h-4 w-1.5 rounded-[1px]', HISTORY_CELL_CLASS[cell.status ?? 'none'])}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-4">
        <button
          type="button"
          data-testid="external-backup-unlink"
          disabled={busy}
          onClick={() => void handleUnlink()}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
          {t('backupHealth.external.unlink')}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Mount it on the device tab**

In `apps/web/src/components/backup/DeviceBackupTab.tsx`:

```diff
@@ imports
+import ExternalBackupCard from './ExternalBackupCard';
@@ state (:199-209)
+  // Reported by ExternalBackupCard so the empty state below can be accurate
+  // without a second fetch. `null` = not answered yet.
+  const [hasExternalBackup, setHasExternalBackup] = useState<boolean | null>(null);
@@ empty state (:380-390)
-  if (!error && !status?.protected && !status?.lastJob && jobs.length === 0) {
+  if (!error && !status?.protected && !status?.lastJob && jobs.length === 0 && hasExternalBackup !== true) {
     return (
       <div className="flex flex-col items-center justify-center py-20 text-center">
         <Database className="h-12 w-12 text-muted-foreground/40" />
         <h3 className="mt-4 text-base font-semibold text-foreground">{t('deviceBackupTab.noBackupConfigured')}</h3>
         <p className="mt-1 text-sm text-muted-foreground">
           {t('deviceBackupTab.assignABackupPolicyToProtectThisDevice')} </p>
+        <p data-testid="device-backup-empty-external-hint" className="mt-1 text-sm text-muted-foreground">
+          {t('backupHealth.external.alsoCheck')} </p>
+        {/* Still mounted: it is what answers hasExternalBackup, and if it finds
+            a row this branch stops rendering on the next commit. */}
+        <ExternalBackupCard deviceId={deviceId} onPresenceChange={setHasExternalBackup} />
       </div>
     );
   }
@@ render root (:419-421)
   return (
     <div className="space-y-6">
+      {/* Above the first-party sections: a technician opening this tab for a
+          Cove-protected machine must not scroll past "no backup" to find it. */}
+      <ExternalBackupCard
+        deviceId={deviceId}
+        onPresenceChange={setHasExternalBackup}
+        onUnlinked={() => void fetchData()}
+      />
       {error && (
```

- [ ] **Step 5: Keep the mutation guard green**

In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, add to `TARGET_GLOBS`:

```ts
  // Device-tab external backup (W03, #6011): Unlink detaches a provider row
  // from a Breeze device; a silent failure leaves the tech believing the link
  // is gone while alerts keep firing against it.
  'src/components/backup/ExternalBackupCard.tsx',
```

and bump the count from 136 to 137, extending the comment block at `:630-640`.

- [ ] **Step 6: Run everything and commit**

```bash
cd apps/web && npx vitest run src/components/backup/ExternalBackupCard.test.tsx \
  src/components/backup/DeviceBackupTab.test.tsx \
  src/lib/__tests__/no-silent-mutations.test.ts \
  src/lib/i18n/keyUsage.test.ts
cd apps/web && pnpm exec astro check
git add apps/web/src/components/backup/ExternalBackupCard.tsx \
        apps/web/src/components/backup/ExternalBackupCard.test.tsx \
        apps/web/src/components/backup/DeviceBackupTab.tsx \
        apps/web/src/components/backup/DeviceBackupTab.test.tsx \
        apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "$(cat <<'EOF'
feat(web/backup): external backup card on the device Backup tab

W03 Task 12. Status, health, last successful/last session, sizes, data sources,
errors, the 28-day bar, the provider customer and an Unlink action — rendered
ABOVE the first-party sections, so a technician opening this tab for a
Cove-protected machine does not scroll past "no backup configured" to find it.
The empty state now points at Integrations when neither source has anything.

The card reads W01's route defensively: `health` and `history28d` are optional,
health is derived locally when absent and the bar is skipped rather than faked,
so this ships whichever shape W01's GET /backup/providers/devices lands in.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Pre-PR checklist

- [ ] `cd apps/api && pnpm exec tsc --noEmit`
- [ ] `cd apps/web && pnpm exec astro check`
- [ ] `cd apps/api && npx vitest run src/services/backupHealth src/routes/backup/health src/routes/backup/dashboard.test.ts src/routes/backup/verification` — the last one is the shadowing guard for D-01.
- [ ] `cd apps/web && npx vitest run src/components/backup src/components/integrations src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts`
- [ ] `pnpm test-stack up` then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupHealthReadModel.integration.test.ts`; also re-run the contract suites even though this wave adds no DDL, because Task 3 reads four tables W01 created: `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/site-scope-coverage.integration.test.ts`
- [ ] `pnpm test-stack down` — nothing reaps it for you; say what you left running.
- [ ] `gh workflow run CI --ref feature/6008-backup-provider-integration/wave-6011` — this branch is stacked on W01, so `ci.yml`'s `pull_request: branches: [main]` trigger gives it no run and `gh pr checks` would read green on nothing.
- [ ] PR body contains `Closes #6011` and the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` trailer.
- [ ] Manual pass on a wt-stack: Integrations → Backup with a real Cove tenant (credentials from the owner, never committed); `/backup` in both org and All-organizations mode; one device tab with a linked provider row.

---

## Self-review

### 1. Spec coverage

**Unified read model**

| Spec requirement | Task |
|---|---|
| `BackupHealthRow` shape, all fields | 2 (`toBreezeHealthRow` / `toProviderHealthRow`) |
| `BackupHealthSummary` shape | 2 (`emptyBackupHealthSummary` / `foldBackupHealthSummary`) |
| `listBackupHealthRows(scope, opts)` exact signature | 3 |
| `summarizeBackupHealth(scope, opts)` exact signature | 3 |
| `getProviderCoverageForDevices(orgId, deviceIds)` exact signature | 3 |
| Every active Breeze device is a row; `no_backups` when jobless | 2 + 3 (tested both levels) |
| First-party status via `mapBackupJobStatus` over the newest run by `compareBackupRunRecency` | 2 (`toBreezeHealthRow`) + 3 (`latestJobSubquery` uses `latestBackupRunWindowOrder`) |
| First-party `lastSuccessAt` = newest `RESTORABLE_BACKUP_JOB_STATUSES` job | 3 (`latestSuccessSubquery`), D-06 |
| Provider rows joined to connections for label/active/stale only | 3 (`buildProviderLeg`) |
| `stale` = `last_sync_at` older than 2 × `sync_interval_minutes` | 2 (`isConnectionStale`) |
| Labels from the denormalized `provider` / `portal_show_provider_name` | 2 (`providerLabelFor`) |
| `history28d` from `backup_jobs` per UTC day / from the ledger | 2 (`foldJobsIntoDays`, `fillHistoryWindow`) + 3 (`attachHistory`) |
| `agentOnline` from `devices.status` | 2 |
| Two rows for a dual-source device | 3 (unit + integration) |
| Distinct-device coverage counts, `providerOnly`, `m365Accounts` | 2 (`foldBackupHealthSummary`) |
| `onlyWithBackup` filter | 3, D-07 |
| Filters `source`, `health`, `status`, `search` | 3 (D-05 for `health`, `escapeLike` for `search`) |
| Keyset cursor pagination | 1 + 3 |
| Site authority through the linked device's `site_id`; unlinked rows only for unrestricted callers | 3 (unit + integration + the route's ceiling) |
| `GET /backup/health` route row | 4, **amended to `/backup/health/devices`** (D-01) |
| Response `{ rows, summary, nextCursor, stale, unmappedDevices }` | 4 |
| `orgId` optional; `auth.orgCondition`/`accessibleOrgIds` when absent | 4 |
| Permission `backup:read` | 4, D-02 |
| `unmappedDevices` = sum over the partner's active connections | 4 |
| Dashboard overdue uses `covered` | 5, D-13 |
| Dashboard `attentionItems` gains critical provider rows, `id: provider:<row id>`, "<name> (<customer>) — <status>" | 3 (`getProviderAttentionItems`) + 5, D-11 |

**Web UI**

| Spec requirement | Task |
|---|---|
| New `backup` tab, label "Backup", icon `HardDrive` | 9 |
| `BackupProvidersIntegration`: connection list | 9 |
| Per connection: provider badge, name, `syncStatusBadge`, last sync time | 7 |
| Counters incl. unmapped and ambiguous | 7 |
| `last_sync_error` box | 7 |
| "Re-enter credentials" on `reauth_required` | 7 |
| Add form: provider select (Cove only), name, Cove partner name, username, password show/hide, portal toggle, help text | 9 |
| Test / Save / Sync now via `runAction` | 7 + 9 |
| Customer mapping grid: vendor customer, level, device count, org `<select>`, auto badge, "Unmapped (kept)", summary | 8 |
| `settings/integrations/backup.astro` 301 alias | 9 |
| i18n, real translations in every locale | 6 |
| All-orgs mode: do not call `/backup/dashboard`, render the health view only | 11, D-15 |
| Stale "data as of" banner | 11 |
| "N devices under unmapped customers" notice | 11 |
| Status bars (5 buckets, Unsuccessful = failed+over_quota+no_selection+interrupted) | 10, D-17 — membership consumed from W01's `BACKUP_STATUS_BUCKET_MEMBERS`, plus the `other` bucket so no status is orphaned |
| Last-successful-backup bars (never / <24h / <48h / >48h) | 10 |
| Each bar with count and percentage | 10 + 11 |
| Device table: health dot, name, computer name, org, source badge, type, data sources, selected, used, 28-day bar with grey gaps, status, errors, agent online | 10 |
| Filters: health, source, org search, include-without-backup | 11 |
| Link to the device page when linked | 10 |
| Bars reuse the existing overview chart styling | 10 + 11 (`widthPercentClass`, the `BackupOverviewContent.tsx:344` bar shape) |
| Device tab: external card above the first-party sections with every listed field | 12 |
| Unlink (manual) action | 12 |
| Empty state adds "Also check third-party backup connections" | 12 |

**Testing (W03 bullets)**

| Spec requirement | Task |
|---|---|
| Integrations card: add / test / save / mapping select via `runAction`, error toast on `{success:false}` | 7, 8, 9 |
| Overview buckets and table under `scope:'all'` and `scope:'org'` | 11 |
| Stale banner | 11 |
| Device tab external card | 12 |
| `no-silent-mutations` guard passes | 9, 12 |
| Locale parity passes | 6 |

No spec requirement of this wave is unmapped.

### 2. Placeholder scan

No occurrence of "TBD", "TODO", "implement later", "add appropriate error handling", "add validation", "write tests for the above" or "similar to Task N". Every code step shows the code. The two places that reference existing repo fixtures rather than inlining them are: Task 3 Step 5's integration seed (which uses the suite's shared partner/org/device builders and says so, because inlining a fifth copy of them is what those helpers exist to prevent), and the `@@`-style diffs in Tasks 9, 11 and 12, which quote the exact surrounding lines at the cited `path:line`.

### 3. Type consistency

- `listBackupHealthRows`, `summarizeBackupHealth`, `getProviderCoverageForDevices` keep the plan index's signatures byte-for-byte. `BackupHealthListOptions` is defined in Task 3 and referenced by that name in Task 4.
- `BackupHealthRow` / `BackupHealthSummary` / `ExternalBackupStatus` / `BackupHealth` / `BackupRecency` are imported from `@breeze/shared` everywhere (API, web components, bucket helper) and never re-declared.
- `BackupStatusBucketId`, `BACKUP_STATUS_BUCKET_IDS` and `BACKUP_STATUS_BUCKET_MEMBERS` likewise come from `@breeze/shared` (W01). Task 10 declares **no** local `StatusBucketId` and **no** local `statuses` arrays; `STATUS_BUCKETS` is derived from the shared list, and the only local map is `STATUS_CLASS`, typed `Record<BackupStatusBucketId, string>` so a bucket added in W01 is a compile error here until it is given a colour. The "every status in exactly one bucket" proof is W01's test; Task 10's suite asserts only order-parity with the shared list, class coverage, counts, percentages and the `other`-when-non-zero filter.
- `BreezeLegRow` / `ProviderLegRow` are declared once in Task 2 and imported by Task 3; the mock row builders in Task 3's test match them field for field.
- `BackupProviderConnection`, `BackupProviderTestResult`, `BackupProviderCustomer`, `ProviderDeviceRow` are each declared once (Tasks 7, 8, 12) and imported by their consumers (Task 9, Task 12).
- Component filenames match the plan index exactly: `BackupProvidersIntegration.tsx`, `BackupProviderConnectionCard.tsx`, `BackupProviderCustomerMapping.tsx`, `BackupHealthOverview.tsx`, `ExternalBackupCard.tsx`, `pages/settings/integrations/backup.astro`, tab id `backup`, label key `integrationsPage.backup`, i18n blocks `backupProviders.*` / `backupHealth.*`.
- The one index deviation is the route PATH (`/backup/health/devices`, D-01); the FILE is still `apps/api/src/routes/backup/health.ts` and the response shape is unchanged. W04 and W05 must consume the sub-path.
