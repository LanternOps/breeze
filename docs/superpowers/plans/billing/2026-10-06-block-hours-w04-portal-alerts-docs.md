---
tracking_issue: LanternOps/breeze#4547
spec: docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md
index: docs/superpowers/plans/billing/2026-10-06-block-hours-index.md
wave: W04
blast_radius: medium (a customer-facing portal read path that must run in a system DB context, one new `portal_branding` column, a fleet-wide notification sweep; no money path and no new table)
---

# Block Hours W04: Portal, Alerts and Docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP show a customer their prepaid block-hours balance in the customer portal (read-only, fail-closed flag), notify the MSP's staff when a block crosses its alert threshold, and document the feature. W04 opens no new money path: it only reads what W02/W03 wrote.

**Architecture:**

1. **Flag.** `portal_branding.enable_hour_block boolean NOT NULL DEFAULT false`. Gated by the existing *strict* (fail-closed) portal gate, widened to accept this flag. It is **not** added to `PORTAL_VISIBILITY_FLAG_KEYS`, so "Enable all visibility" never turns it on (precedent: `enableNetworkAlerts`).
2. **Data.** A new endpoint `GET /portal/support-usage/hour-block` returns `{ hourBlock: PortalHourBlockDto | null }`. The handler reads in a **system** context scoped explicitly to the session's `auth.user.orgId` (the drawdown reads `time_entries`, which is partner-axis: an org-scoped context sees zero rows). It reuses W03's live open-period computation; it never re-derives drawdown.
3. **Honest buckets.** When the flag is on, the existing Support usage buckets stop calling block-covered hours "to be billed": block-drawn entries and open-period block-eligible entries land in a new `coveredByBlock` bucket. When the flag is off nothing changes.
4. **Card.** `SupportUsagePanel` renders a "Support hours" card above the usage table, only when the portal branding says `enableHourBlock`.
5. **Alerts.** `runHourBlockAlertSweep()` runs in the contract billing-sweep job **before** `runContractBillingSweep()`. One system transaction per block line; `user_notifications` rows deduped by `hour_block:<lineId>:<periodStart>:<pct>`; one `contract.hour_block_threshold` event per crossing.
6. **Docs.** Contracts and Portal pages, plus a release-notes hand-off.

**Tech Stack:** Hono, Drizzle, Postgres, BullMQ, Zod, React (web + portal islands), Astro, Vitest, MDX (Starlight).

**Spec:** `docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md` (the "Amendments" and "Plan-time amendments" sections at the top override the body).
**Index:** `docs/superpowers/plans/billing/2026-10-06-block-hours-index.md`. Cross-wave names in it (C1 migration name, C5 export row, C7 `contractWorker` row, C8 `HourBlockEstimate`, C10 `PORTAL_HOUR_BLOCK_DISABLED`, Open Decision 12) are used here verbatim and are not renamed or re-typed.
**Depends on:** W01–W03 **merged** (the schema, the drawdown engine and the estimate). W04 ships the migration `2026-12-14-130000-portal-branding-enable-hour-block.sql`.

## Assumes from W03 / W02 / W01 (orchestrator: reconcile these names before dispatch)

Everything below is **not in the tree at planning time** (W01–W03 are unmerged). Every W04 task imports each name at exactly one place, so a rename is a one-line edit per file plus the matching `vi.mock` path in that file's test. Nothing here is invented beyond what the index fixes in C2/C3/C7/C8.

| Assumed name | Owner | Signature / shape | Used by |
|---|---|---|---|
| `computeOpenHourBlockPeriod` exported from `apps/api/src/services/contractHourBlockEstimate.ts` (index C7) | **W03** (live open-period computation behind `computeContractEstimate(...).hourBlock`) | `(contract: typeof contracts.$inferSelect, line: typeof contractLines.$inferSelect, asOf: Date) => Promise<HourBlockEstimate>`. **Must be called inside a system DB context** (it reads partner-axis `time_entries`). Returns the OPEN period; `consumedHours` includes unapproved entries (Decision 4 A); `remainingHours = max(0, includedHours + carriedInHours − consumedHours)` | Task 2 (`services/portal/hourBlock.ts`), Task 6 (`contractHourBlockAlerts.ts`) |
| `HourBlockEstimate` exported from `@breeze/shared` | W03 (index C8) | exactly as C8 | Tasks 2, 6 |
| `hourBlockHoldWindows` exported from `apps/api/src/services/contractHourBlockClose.ts` | **W02** (index C7) | `(orgId: string, asOf?: Date) => Promise<Array<{ start: Date; end: Date \| null; contractLineId: string }>>`, system context required | Task 3 (`services/portal/hourBlockCoverage.ts`) |
| `contractLines.hourBlockAlertPct`, `.hourBlockRetiredAt`, `.includedQuantity`, `.overageUnitPrice`, `.hourBlockFirstPeriodStart`, `.rolloverPolicy`, `.overageMode`; `'hour_block'` in the `contractLineTypeEnum` | W01 (index C2) | Drizzle names exactly as in C2 | Tasks 2, 3, 6 and every integration fixture |
| `timeEntries.contractLineId` | W01 (index C4) | `uuid`, non-null only when `billing_status = 'contract'` | Task 3 |
| `contract_hour_periods` / `contractHourPeriods` | W01 (index C3) | not read directly by W04 (only through the W02/W03 helpers above) | — |

**Not assumed:** any W03 UI component, route or validator. W04 touches none of them.

## Global Constraints

- **Red first, always.** Every unit: write the failing test, run it, see the *expected* failure, then implement. Commands are `cd apps/api && npx vitest run <files>` (never `pnpm … test -- --run`; a vitest path filter is a plain substring, so list sibling files explicitly and check the reported file count).
- **No new tenant table.** `portal_branding` is already in every cascade/export/merge registry. W04 adds one column, so the only registry that fires is `CORE_TENANT_EXPORT_POLICY` (Task 1). `rls-coverage`, `CORE_ORG_CASCADE_DELETE_ORDER`, `REPOINT_TABLES`, and the device/ticket lists are untouched.
- **Migration:** hand-written, idempotent (`ADD COLUMN IF NOT EXISTS`), no inner `BEGIN/COMMIT`. It writes **no rows**, so no `set_config('breeze.scope','system',true)` preamble is needed (`migrationRlsScope.test.ts`). **If a reviewer asks for a backfill, the preamble and a `GET DIAGNOSTICS` row count become mandatory.** Re-check `ls apps/api/migrations | grep '^20' | LC_ALL=C sort | tail -1` when implementing; if anything newer than `2026-12-14-1300NN` has landed, rename to sort after it.
- **Fail-closed flag.** A missing `portal_branding` row, an explicit `false`, and a non-boolean all return 403 `PORTAL_HOUR_BLOCK_DISABLED`. Do **not** use `createPortalFeatureGate` (`apps/api/src/routes/portal/featureFlags.ts:27`): it only blocks on an explicit `false` (`:40`), so a missing row would *expose* a default-false flag.
- **Never trust a request for the org.** The hour-block handler's org is `c.get('portalAuth').user.orgId`, nothing else. No query param, header or body field may name an org.
- **Customer-safe DTO.** `PortalHourBlockDto` is built by an explicit whitelist mapper. It never carries `lineId`, `unapprovedHours`, `foreignCurrencyHours`, `lateEntryHours`, `alertPct`, `overageValue`, or any contract/ticket identifier. A test pins the exact key set.
- **System-context discipline.** Any `time_entries` read for the portal or the alert sweep runs under `runOutsideDbContext(() => withSystemDbAccessContext(...))` with an explicit `orgId` predicate. `withSystemDbAccessContext` is a passthrough inside an existing context; the `runOutsideDbContext` is what makes it real.
- **Per-line transactions in the sweep.** `withSystemDbAccessContext` wraps one Postgres transaction; a failed statement poisons every later statement in it, so a try/catch around *calls inside one context* does not isolate failures. The sweep opens one context per block line (same shape as `runContractBillingSweep`).
- **i18n.** The web admin editor uses i18next with 8 locales, all with real translations (`localeParity.test.ts`). The customer portal has **no i18n layer** (strings are English literals in the components; `apps/portal/src/lib/money.ts` only formats glyphs via `navigator.language`), so the portal card follows that convention and uses `Intl` for numbers and dates.
- **Mutation feedback.** The only web mutation touched is the existing `runAction` PATCH in `OrgPortalSettingsEditor.tsx`; no new handler is added.
- **Neutral public wording.** Commit messages and the PR body describe behaviour, not internal incidents. No hostnames, IPs or customer names anywhere (docs run `scripts/security/check-customer-pii.sh`).
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. One checkpoint commit per task.
- **Feature lifecycle:** run `get_feature_status` for #4547 first, branch `feature/4547-block-hours/wave-<W04 sub-issue#>`, `start_wave`; the PR body carries `Closes #<W04 sub-issue>`.

## Review Focus

The five failure modes most likely to bite, each pinned by a named test:

1. **A portal read outside a system context silently reports zero hours used.** `time_entries` is partner-axis (RLS Shape 3); an org-scoped request context sees none, so a card would read "0 of 10 hours used" with no error. *Pinned:* Task 2 integration test `reads real figures from an org-scoped request context that cannot see time_entries` (asserts the org-scoped select returns `[]` **and** the service still returns 5.5 used) plus the unit test `runs the open-period computation inside a system context`.
2. **Cross-org leak.** The handler trusts anything but the session org, or the DTO carries an identifier or internal figure. *Pinned:* Task 2 unit `ignores every org selector on the request`, Task 2 unit `whitelists the customer-safe keys`, Task 2 integration `org B never sees org A's block`.
3. **The flag fails open or "Enable all" turns it on.** *Pinned:* Task 1 `featureFlags.test.ts` (`enableHourBlock` 403 on missing row, explicit false, truthy non-boolean), `portalFlags.test.ts` (not in `PORTAL_VISIBILITY_FLAG_KEYS`), Task 2 real-mount tests in `portal.test.ts` (401, 403 auth-then-gate order, 200), Task 4 `Enable all visibility does not turn on Support hours`.
4. **The customer is told "to be billed" for hours the block already covers, or learns a block exists while the flag is off.** *Pinned:* Task 3 unit buckets (flag on: open-period eligible entries and drawn entries → `coveredByBlock`; flag off: byte-identical to today, no `coveredByBlock` key) and the Task 3 real-DB test.
5. **Alert storm, double alert, or one bad contract aborting the sweep.** *Pinned:* Task 6 `crosses once → one notification`, `second sweep in the same period writes none`, `changing the threshold alerts again exactly once`, `one failing line does not stop the others` + `opens one system context per block line`, exact integer-cent threshold table, and the real-DB dedupe (the partial-index arbiter trap that only a real database sees).

---

### Task 1: The `enable_hour_block` flag, org settings API, branding projection

**Files:**
- Create: `apps/api/migrations/2026-12-14-130000-portal-branding-enable-hour-block.sql`
- Create: `apps/api/src/db/portalBrandingHourBlock.migration.test.ts`
- Modify: `apps/api/src/db/schema/portal.ts` (after `enableNetworkAlerts`, line 64)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (the `portal_branding` row, line 632)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.portalBranding.test.ts`
- Modify: `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts` (after the test at lines 63-77)
- Modify: `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` (INSERT at :262-270, expectation at :516-529)
- Create: `apps/api/src/__tests__/integration/portalBrandingHourBlock.integration.test.ts`
- Modify: `packages/shared/src/validators/portal.ts` (the `.strict()` object at lines 95-120) and `packages/shared/src/validators/portal.test.ts`
- Modify: `apps/api/src/routes/portal/featureFlags.ts` and `featureFlags.test.ts`
- Modify: `apps/api/src/services/portal/portalFlags.test.ts`
- Modify: `apps/api/src/routes/orgPortalSettings.ts` and `orgPortalSettings.test.ts`
- Modify: `apps/api/src/routes/portal/branding.ts` (authenticated projection, line 120) and `branding.test.ts`

**Interfaces:**
- SQL: `portal_branding.enable_hour_block boolean NOT NULL DEFAULT false`.
- Drizzle: `portalBranding.enableHourBlock`.
- `export type StrictPortalGateFlag = StrictPortalVisibilityFlag | 'enableHourBlock'` in `featureFlags.ts`; `createPortalFeatureGateStrict(flag: StrictPortalGateFlag)`. Error body `{ error: 'Support hours are not enabled for this portal', code: 'PORTAL_HOUR_BLOCK_DISABLED' }`, status 403 (index C10).
- `updatePortalSettingsSchema` accepts `enableHourBlock: boolean` (optional). **Without this the PATCH is rejected 400: the schema is `.strict()`.**
- `GET/PATCH /orgs/organizations/:id/portal-settings` return/accept `enableHourBlock` (default `false`).
- Authenticated `GET /portal/branding` projection includes `enableHourBlock`; the public domain lookup does not.

- [ ] **Step 1: Write the failing static migration test**

Create `apps/api/src/db/portalBrandingHourBlock.migration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const FILE = '2026-12-14-130000-portal-branding-enable-hour-block.sql';
// W01's last migration (index C1). W04 depends on W01 being merged, so this
// file must exist and must sort before ours.
const W01_LAST = '2026-12-14-100300-time-entries-contract-line.sql';

describe('portal_branding.enable_hour_block migration (block hours W04)', () => {
  it('adds exactly one fail-closed, idempotent column and writes no rows', () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, FILE), 'utf8');
    const code = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');

    expect(code).toMatch(
      /ALTER TABLE portal_branding\s+ADD COLUMN IF NOT EXISTS enable_hour_block boolean NOT NULL DEFAULT false;/,
    );
    // autoMigrate wraps each file in a transaction already.
    expect(code).not.toMatch(/\b(BEGIN|COMMIT)\b/i);
    // No row writes => no breeze.scope preamble is needed. If this ever
    // fails, the preamble and a GET DIAGNOSTICS row count become mandatory.
    expect(code).not.toMatch(/\b(UPDATE|INSERT|DELETE|MERGE)\b/i);
  });

  it('sorts after W01 (the wave it depends on)', () => {
    expect(existsSync(path.join(MIGRATIONS_DIR, W01_LAST))).toBe(true);
    expect(FILE.localeCompare(W01_LAST)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Write the failing export-policy unit test**

Append to `apps/api/src/services/tenantExportPolicyRegistry.portalBranding.test.ts`:

```ts
describe('portal_branding.enable_hour_block export policy (block hours W04)', () => {
  it('is mapped and included (plain boolean, not jsonb/bytea, no SUSPICIOUS_NAME_PARTS hit)', () => {
    expect(
      getTenantExportPolicyRegistry()['portal_branding']?.columns['enable_hour_block']?.decision,
    ).toBe('include');
    expect(
      (getTableColumns(portalBranding) as Record<string, { name: string }>)['enableHourBlock']?.name,
    ).toBe('enable_hour_block');
  });
});
```

- [ ] **Step 3: Write the failing validator test**

In `packages/shared/src/validators/portal.test.ts`, after the `Network Alerts flag` test (line ~104) add:

```ts
  it.each([true, false])('accepts the Support hours flag=%s', (enableHourBlock) => {
    expect(updatePortalSettingsSchema.parse({ enableHourBlock })).toEqual({ enableHourBlock });
  });

  it.each([null, 'true', 1])('rejects a non-boolean Support hours flag=%s', (enableHourBlock) => {
    expect(updatePortalSettingsSchema.safeParse({ enableHourBlock }).success).toBe(false);
  });
```

- [ ] **Step 4: Write the failing gate tests**

In `apps/api/src/routes/portal/featureFlags.test.ts`:

1. Add this row to the `it.each([...])` table of `fails closed for %s` (after the `enableLifecycle` row):

```ts
    ['enableHourBlock', 'PORTAL_HOUR_BLOCK_DISABLED'],
```

2. Add inside `describe('createPortalFeatureGateStrict', …)` (before its closing `});`):

```ts
  it('enableHourBlock: continues only when the flag is strictly true', async () => {
    dbState.rows = [{ enableHourBlock: true }];
    const ok = await createTestApp('enableHourBlock').request('/protected');
    expect(ok.status).toBe(200);

    dbState.rows = [{ enableHourBlock: false }];
    const off = await createTestApp('enableHourBlock').request('/protected');
    expect(off.status).toBe(403);
    expect(await off.json()).toEqual({
      error: 'Support hours are not enabled for this portal',
      code: 'PORTAL_HOUR_BLOCK_DISABLED',
    });
  });

  it('enableHourBlock: a truthy non-boolean is not enabled', async () => {
    dbState.rows = [{ enableHourBlock: 'true' }];
    const response = await createTestApp('enableHourBlock').request('/protected');
    expect(response.status).toBe(403);
  });

  it('enableHourBlock: rejects an unauthenticated request before reading the row', async () => {
    dbState.rows = [{ enableHourBlock: true }];
    const response = await createTestApp('enableHourBlock', false).request('/protected');
    expect(response.status).toBe(401);
    expect(dbState.where).toBeUndefined();
  });
```

3. In `apps/api/src/services/portal/portalFlags.test.ts`, inside `describe('PORTAL_VISIBILITY_FLAG_KEYS', …)` add:

```ts
  it('keeps the independent, billing-sensitive flags out of "Enable all"', () => {
    // enableNetworkAlerts (#5861) and enableHourBlock (#4547 W04) each have
    // their own fail-closed gate and must be switched on one at a time.
    expect(PORTAL_VISIBILITY_FLAG_KEYS).not.toContain('enableNetworkAlerts');
    expect(PORTAL_VISIBILITY_FLAG_KEYS).not.toContain('enableHourBlock');
  });
```

- [ ] **Step 5: Write the failing org-settings and branding tests**

In `apps/api/src/routes/orgPortalSettings.test.ts`:

1. In the `returns schema defaults when no row exists` test (line ~196), add `enableHourBlock: false,` to the exact `toEqual` object, directly after `enableNetworkAlerts: false,`.
2. In `describe('PATCH /organizations/:id/portal-settings', …)` add:

```ts
  it('persists the Support hours flag without treating it as a visibility flag', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    dbUpsertReturning.mockResolvedValue([{ ...FULL_ROW, enableHourBlock: true }]);

    const res = await patch({ enableHourBlock: true });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ enableHourBlock: true });

    const { db } = await import('../db');
    const values = vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0]?.[0];
    expect(values).toMatchObject({ orgId: ORG_ID, enableHourBlock: true });
    const returning = vi.mocked(db.insert).mock.results[0]?.value.values.mock.results[0]?.value
      .onConflictDoUpdate.mock.results[0]?.value.returning;
    expect(returning.mock.calls[0]?.[0]).toHaveProperty('enableHourBlock', 'enableHourBlock');

    // Not in PORTAL_VISIBILITY_FLAG_KEYS: the provisioning hook must not run.
    expect(onPortalFlagsChanged).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: { changedFields: ['enableHourBlock'] } }),
    );
  });

  it('still rejects an unknown portal setting (strict schema)', async () => {
    const res = await patch({ enableHourBlockz: true });
    expect(res.status).toBe(400);
  });
```

In `apps/api/src/routes/portal/branding.test.ts`:

1. In `returns all visibility flags for the authenticated org`, add `enableHourBlock: true,` to the `dbState.rows[0]` fixture and to the `toMatchObject` expectation, and add `'enableHourBlock',` to the `expect.arrayContaining([...])` projection list.
2. In `returns 404 when the authenticated org has no portal_branding row`, add `expect(body).not.toHaveProperty('enableHourBlock');`.
3. In `does not require authentication and does not expose visibility flags`, add `expect(body.branding).not.toHaveProperty('enableHourBlock');` and add `'enableHourBlock',` to the `for (const flag of [...])` not-selected list.

- [ ] **Step 6: Write the failing integration assertions**

In `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts`, after the `exports every portal visibility flag` test, add:

```ts
  it('exports the Support hours flag (#4547 W04)', () => {
    const columns = getTenantExportPolicyRegistry().portal_branding?.columns;
    expect(columns?.enable_hour_block?.decision).toBe('include');
  });
```

In `tenantExportErasureRoundtrip.integration.test.ts`:

- The INSERT (line ~262) becomes:

```ts
  await db.execute(sql`
    INSERT INTO portal_branding (
      org_id,
      enable_dashboard,
      enable_security,
      enable_backups,
      enable_reports,
      enable_support_usage,
      enable_hour_block
    ) VALUES
      (${orgA}, true, true, false, true, false, true),
      (${orgB}, false, false, true, false, true, false)
  `);
```

- In the `portalBrandingRows` expectation (line ~519) add `enable_hour_block: true,` after `enable_support_usage: false,`.

Create `apps/api/src/__tests__/integration/portalBrandingHourBlock.integration.test.ts`:

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { portalBranding } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

describe('portal_branding.enable_hour_block (block hours W04)', () => {
  it('defaults to false on a fresh row — the fail-closed posture', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const [row] = await admin
      .insert(portalBranding)
      .values({ orgId: org.id })
      .returning({ enableHourBlock: portalBranding.enableHourBlock });

    expect(row?.enableHourBlock).toBe(false);
  });

  it('is NOT NULL with a false default in the catalog', async () => {
    const admin = getTestDb();
    const result = await admin.execute(sql`
      SELECT is_nullable, column_default
        FROM information_schema.columns
       WHERE table_name = 'portal_branding' AND column_name = 'enable_hour_block'
    `);
    const row = Array.from(result)[0] as { is_nullable: string; column_default: string } | undefined;
    expect(row?.is_nullable).toBe('NO');
    expect(row?.column_default).toBe('false');
  });
});
```

- [ ] **Step 7: Run the new/changed unit tests, confirm they FAIL**

```bash
cd apps/api && npx vitest run \
  src/db/portalBrandingHourBlock.migration.test.ts \
  src/services/tenantExportPolicyRegistry.portalBranding.test.ts \
  src/routes/portal/featureFlags.test.ts \
  src/services/portal/portalFlags.test.ts \
  src/routes/orgPortalSettings.test.ts \
  src/routes/portal/branding.test.ts
cd ../../packages/shared && npx vitest run src/validators/portal.test.ts
```

Expected FAIL: the migration file does not exist (`ENOENT`); the registry/drizzle column is `undefined`; `PORTAL_HOUR_BLOCK_DISABLED` rows get `undefined` bodies (and a TypeScript error on the unknown flag); the defaults `toEqual` lacks `enableHourBlock`; `enableHourBlockz`/`enableHourBlock` PATCH returns 400 (`.strict()`); the branding projection lacks the key. Confirm each failure is the expected one before moving on.

- [ ] **Step 8: Implement the migration**

Create `apps/api/migrations/2026-12-14-130000-portal-branding-enable-hour-block.sql`:

```sql
-- Block hours W04 (#4547): independent, fail-closed flag for the read-only
-- "Support hours" card the customer portal shows inside its Support usage
-- section (prepaid block hours used / remaining).
-- Deliberately NOT part of PORTAL_VISIBILITY_FLAG_KEYS / "Enable all
-- visibility": the card exposes a prepaid-hours balance, a billing figure the
-- MSP must choose to show -- same reasoning as enable_network_alerts
-- (2026-10-30-140000-portal-branding-network-alerts.sql).
-- No row is written, so no breeze.scope preamble is needed.
ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_hour_block boolean NOT NULL DEFAULT false;
```

- [ ] **Step 9: Implement the Drizzle column and export-policy row**

In `apps/api/src/db/schema/portal.ts`, immediately after the `enableNetworkAlerts` line (64), insert:

```ts
  // Block hours W04 (#4547): independent, fail-closed gate for the read-only
  // "Support hours" card inside the Support usage section. A prepaid-hours
  // balance is a billing figure the MSP must choose to show, so — like
  // enableNetworkAlerts above — it is NOT part of PORTAL_VISIBILITY_FLAG_KEYS
  // / "Enable all".
  enableHourBlock: boolean('enable_hour_block').notNull().default(false),
```

In `apps/api/src/services/tenantExportPolicyRegistry.ts` line 632, change

```
"enable_network_visibility","enable_network_alerts"],"reviewedIncluded":["enable_password_reset"]
```

to

```
"enable_network_visibility","enable_network_alerts","enable_hour_block"],"reviewedIncluded":["enable_password_reset"]
```

(`enable_hour_block` is a plain boolean: not `json/jsonb/bytea`, no `SUSPICIOUS_NAME_PARTS` hit → `included`.)

- [ ] **Step 10: Implement the validator, gate, settings API and branding projection**

`packages/shared/src/validators/portal.ts`, directly after `enableNetworkAlerts: z.boolean().optional(),` (line 111):

```ts
  // Block hours W04 (#4547): fail closed, default false. NOT a visibility
  // flag ("Enable all" never sets it).
  enableHourBlock: z.boolean().optional(),
```

`apps/api/src/routes/portal/featureFlags.ts`:

Replace lines 8-13 (the `StrictPortalVisibilityFlag` export) by itself plus a new export — keep the existing export and add directly beneath it:

```ts
// Fail-closed gates that are NOT part of the "Enable all" visibility set
// (PORTAL_VISIBILITY_FLAG_KEYS). Each is independent and billing- or
// alert-sensitive: enableHourBlock exposes a prepaid-hours balance (#4547 W04).
export type StrictPortalGateFlag = StrictPortalVisibilityFlag | 'enableHourBlock';
```

Change `const STRICT_PORTAL_FEATURES: Record<StrictPortalVisibilityFlag, …>` (line 83) to `Record<StrictPortalGateFlag, { error: string; code: string }>`, add this entry after `enableLifecycle`:

```ts
  enableHourBlock: {
    error: 'Support hours are not enabled for this portal',
    code: 'PORTAL_HOUR_BLOCK_DISABLED',
  },
```

and change line 118 to `export function createPortalFeatureGateStrict(flag: StrictPortalGateFlag): MiddlewareHandler {`. Leave `createPortalFeatureGateAny` on `StrictPortalVisibilityFlag`.

`apps/api/src/routes/orgPortalSettings.ts` — four edits:

- `PORTAL_SETTINGS_DEFAULTS`: after `enableNetworkAlerts: false,` add `enableHourBlock: false, // block hours (#4547 W04): fail-closed, never in "Enable all"`.
- `PortalSettingsRow`: after `enableNetworkAlerts: boolean;` add `enableHourBlock: boolean;`.
- `portalSettingsColumns()`: after `enableNetworkAlerts: portalBranding.enableNetworkAlerts,` add `enableHourBlock: portalBranding.enableHourBlock,`.
- `toResponse()`: after `enableNetworkAlerts: row.enableNetworkAlerts,` add `enableHourBlock: row.enableHourBlock,`.

`apps/api/src/routes/portal/branding.ts` line 120 (authenticated projection only):

```ts
      enableNetworkVisibility: portalBranding.enableNetworkVisibility,
      enableHourBlock: portalBranding.enableHourBlock
```

(The public `resolveBrandingByDomain` projection at :33-52 must **not** gain it.)

- [ ] **Step 11: Run unit tests, confirm PASS; typecheck**

```bash
cd apps/api && npx vitest run \
  src/db/portalBrandingHourBlock.migration.test.ts \
  src/services/tenantExportPolicyRegistry.portalBranding.test.ts \
  src/routes/portal/featureFlags.test.ts \
  src/services/portal/portalFlags.test.ts \
  src/routes/orgPortalSettings.test.ts \
  src/routes/portal/branding.test.ts
cd ../../packages/shared && npx vitest run src/validators/portal.test.ts && npx tsc --noEmit
cd ../../apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo "tsc exit=$?"
```

Expected: 6 + 1 files green; `tsc exit=0` (check the exit code; never pipe to `tail`).

- [ ] **Step 12: Run the real-DB suites and the drift check**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/portalBrandingHourBlock.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMerge.integration.test.ts
cd ../.. && pnpm db:check-drift
```

Expected: all green, drift clean. (`tenant-export-policy.integration.test.ts` is the suite that reds on an unclassified new column; `orgMerge.integration.test.ts` proves the `portal_branding` keep-survivor behaviour is unaffected.) Leave `pnpm test-stack up` running for Tasks 2, 3 and 6; tear it down in Task 8.

- [ ] **Step 13: Commit**

```bash
git add apps/api/migrations/2026-12-14-130000-portal-branding-enable-hour-block.sql \
  apps/api/src/db/portalBrandingHourBlock.migration.test.ts apps/api/src/db/schema/portal.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.portalBranding.test.ts \
  apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts \
  apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  apps/api/src/__tests__/integration/portalBrandingHourBlock.integration.test.ts \
  packages/shared/src/validators/portal.ts packages/shared/src/validators/portal.test.ts \
  apps/api/src/routes/portal/featureFlags.ts apps/api/src/routes/portal/featureFlags.test.ts \
  apps/api/src/services/portal/portalFlags.test.ts \
  apps/api/src/routes/orgPortalSettings.ts apps/api/src/routes/orgPortalSettings.test.ts \
  apps/api/src/routes/portal/branding.ts apps/api/src/routes/portal/branding.test.ts
git commit -m "feat(portal): fail-closed support-hours flag, settings API and branding projection (#4547)

Adds portal_branding.enable_hour_block (default false), a strict gate with
PORTAL_HOUR_BLOCK_DISABLED, the org settings read/write path, and the
authenticated branding projection. The flag is deliberately outside the
Enable-all visibility set.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Portal hour-block endpoint (system-context read, customer-safe DTO)

**Files:**
- Modify: `packages/shared/src/types/portalVisibility.ts` (after `SupportUsageDto`, line 254)
- Create: `apps/api/src/services/portal/hourBlock.ts`
- Create: `apps/api/src/services/portal/hourBlock.test.ts`
- Create: `apps/api/src/routes/portal/hourBlock.ts`
- Create: `apps/api/src/routes/portal/hourBlock.test.ts`
- Modify: `apps/api/src/routes/portal/index.ts` (import near line 21, middleware after line 82, route mount after line 112)
- Modify: `apps/api/src/routes/portal.test.ts` (mock near line 14; real-mount cases near the end of `describe('W03 strict visibility gates (real mount)')`)
- Create: `apps/api/src/__tests__/integration/hourBlockFixtures.ts`
- Create: `apps/api/src/__tests__/integration/portalHourBlock.integration.test.ts`

**Interfaces:**

```ts
// packages/shared/src/types/portalVisibility.ts
export interface PortalHourBlockDto {
  periodStart: string;            // YYYY-MM-DD, half-open [periodStart, periodEnd)
  periodEnd: string;
  includedHours: number;          // the line's included hours
  carriedInHours: number;         // rollover carried in (0 under 'none')
  usedHours: number;              // drawn so far this period (unapproved time included)
  remainingHours: number;         // max(0, included + carriedIn - used)
  overageHours: number;           // max(0, used - (included + carriedIn))
  overageRate: string;            // the contracted per-hour rate, decimal string
  currencyCode: string;           // the contract's currency
  billingTiming: 'advance' | 'arrears';
}
export interface PortalHourBlockResponse { hourBlock: PortalHourBlockDto | null }

// apps/api/src/services/portal/hourBlock.ts
export function toPortalHourBlockDto(estimate: HourBlockEstimate, currencyCode: string): PortalHourBlockDto;
export async function portalHourBlockForOrg(args: { orgId: string; asOf?: Date }): Promise<PortalHourBlockDto | null>;

// apps/api/src/routes/portal/hourBlock.ts
export const portalHourBlockRoutes: Hono;   // GET /support-usage/hour-block
```

**Design decisions recorded here (so the PR can state them):**

- **Hours plus the overage rate, no computed money.** The card shows hours (facts the customer can reconcile against their own ticket time) and the *contracted overage rate* (a term already printed on every overage invoice line). It does **not** show a projected overage amount: that figure would need tax and rounding rules, would be a promise about an invoice that does not exist yet, and moves whenever an unapproved entry is edited or approved. Adding it later is additive (the estimate already carries `overageValue`).
- **Separate path, not under `/tickets`.** `/tickets/*` carries the `enable_tickets` gate (`routes/portal/index.ts:87-98`), which Support usage deliberately opts out of via two exact-path wrappers (`:75-82`). A nested path would need a third exemption. `/support-usage/*` is a clean prefix with `auth → enableSupportUsage → enableHourBlock`: the card lives inside the Support usage section, so it requires that section to be on too (two small reads per request; no new exemption).
- **Envelope.** `{ hourBlock: … | null }` rather than a bare JSON `null`, so ETag/304 handling and the portal client's `data !== undefined` convention keep working.
- **Only the active contract's live block shows.** A paused, draft or ended contract, or a retired line, yields `null`: the card is "your current balance", not history.
- **No `unapprovedHours`.** It is an MSP-side exposure figure (Decision 4 A); `usedHours` already includes it and the customer's existing "Pending review" bucket covers the approval story.

- [ ] **Step 1: Write the shared DTO (types only — no behaviour to test red)**

In `packages/shared/src/types/portalVisibility.ts`, directly after the `SupportUsageDto` interface (line 254), add the two interfaces above verbatim, preceded by this doc comment:

```ts
/**
 * Customer-safe projection of the org's live block-hours balance (#4547 W04).
 * Built by an explicit whitelist (services/portal/hourBlock.ts), never by
 * spreading the MSP-side HourBlockEstimate: that carries unapproved hours,
 * foreign-currency hours, late-entry hours, the line id and the alert
 * threshold, none of which a customer should see.
 */
```

- [ ] **Step 2: Write the failing service unit test**

Create `apps/api/src/services/portal/hourBlock.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { HourBlockEstimate } from '@breeze/shared';

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  where: undefined as SQL | undefined,
  inSystem: false,
  outsideCalls: 0,
  computeSawSystem: undefined as boolean | undefined,
}));
const { computeMock } = vi.hoisted(() => ({ computeMock: vi.fn() }));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn((where: SQL) => {
            state.where = where;
            return { limit: vi.fn(async () => state.rows) };
          }),
        })),
      })),
    })),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => {
    state.outsideCalls += 1;
    return fn();
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    state.inSystem = true;
    try {
      return await fn();
    } finally {
      state.inSystem = false;
    }
  }),
}));
vi.mock('../contractHourBlockEstimate', () => ({ computeOpenHourBlockPeriod: computeMock }));

import { portalHourBlockForOrg, toPortalHourBlockDto } from './hourBlock';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const estimate: HourBlockEstimate = {
  lineId: 'line-secret',
  periodStart: '2026-12-01',
  periodEnd: '2027-01-01',
  includedHours: 10,
  carriedInHours: 2,
  consumedHours: 6.5,
  unapprovedHours: 1,
  foreignCurrencyHours: 0.5,
  remainingHours: 5.5,
  overageHours: 0,
  overageUnitPrice: '150.00',
  overageValue: '0.00',
  alertPct: 80,
  billingTiming: 'advance',
  lateEntryHours: 3,
};

describe('toPortalHourBlockDto', () => {
  it('whitelists the customer-safe keys and nothing else', () => {
    const dto = toPortalHourBlockDto(estimate, 'USD');

    expect(Object.keys(dto).sort()).toEqual([
      'billingTiming',
      'carriedInHours',
      'currencyCode',
      'includedHours',
      'overageHours',
      'overageRate',
      'periodEnd',
      'periodStart',
      'remainingHours',
      'usedHours',
    ]);
    expect(dto).toEqual({
      periodStart: '2026-12-01',
      periodEnd: '2027-01-01',
      includedHours: 10,
      carriedInHours: 2,
      usedHours: 6.5,
      remainingHours: 5.5,
      overageHours: 0,
      overageRate: '150.00',
      currencyCode: 'USD',
      billingTiming: 'advance',
    });
    // The MSP-side exposure figures never cross the boundary.
    expect(JSON.stringify(dto)).not.toContain('line-secret');
  });
});

describe('portalHourBlockForOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows = [];
    state.where = undefined;
    state.inSystem = false;
    state.outsideCalls = 0;
    state.computeSawSystem = undefined;
    computeMock.mockImplementation(async () => {
      state.computeSawSystem = state.inSystem;
      return estimate;
    });
  });

  it('binds the org on BOTH tables and selects only the live block of an active contract', async () => {
    await portalHourBlockForOrg({ orgId: ORG });

    const q = new PgDialect().sqlToQuery(state.where as SQL);
    expect(q.sql).toContain('"contract_lines"."org_id" = $');
    expect(q.sql).toContain('"contracts"."org_id" = $');
    expect(q.sql).toContain('"contract_lines"."line_type" = $');
    expect(q.sql).toContain('"contract_lines"."hour_block_retired_at" is null');
    expect(q.sql).toContain('"contracts"."status" = $');
    expect(q.params.filter((p) => p === ORG)).toHaveLength(2);
    expect(q.params).toEqual(expect.arrayContaining(['hour_block', 'active']));
  });

  it('returns null without computing anything when the org has no live block', async () => {
    state.rows = [];
    await expect(portalHourBlockForOrg({ orgId: ORG })).resolves.toBeNull();
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('runs the open-period computation inside a system context entered from outside the request context', async () => {
    state.rows = [{ contract: { id: 'c1', currencyCode: 'EUR' }, line: { id: 'l1' } }];
    const asOf = new Date('2026-12-20T12:00:00Z');

    const dto = await portalHourBlockForOrg({ orgId: ORG, asOf });

    expect(state.outsideCalls).toBe(1);
    // The partner-axis trap: an org-scoped read of time_entries returns zero
    // rows, so the computation MUST see a system context.
    expect(state.computeSawSystem).toBe(true);
    expect(computeMock).toHaveBeenCalledWith({ id: 'c1', currencyCode: 'EUR' }, { id: 'l1' }, asOf);
    expect(dto?.currencyCode).toBe('EUR');
  });
});
```

- [ ] **Step 3: Write the failing route unit test**

Create `apps/api/src/routes/portal/hourBlock.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { forOrgMock } = vi.hoisted(() => ({ forOrgMock: vi.fn() }));
vi.mock('../../services/portal/hourBlock', () => ({ portalHourBlockForOrg: forOrgMock }));

import { portalHourBlockRoutes } from './hourBlock';

const SESSION_ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: {
        id: 'pu-1', orgId: SESSION_ORG, email: 'c@example.test', name: 'Cust',
        contactId: null, receiveNotifications: true, status: 'active',
      },
      token: 't',
      authMethod: 'bearer',
      timezone: 'UTC',
    });
    await next();
  });
  app.route('/', portalHourBlockRoutes);
  return app;
}

const dto = {
  periodStart: '2026-12-01', periodEnd: '2027-01-01', includedHours: 10, carriedInHours: 0,
  usedHours: 4, remainingHours: 6, overageHours: 0, overageRate: '150.00',
  currencyCode: 'USD', billingTiming: 'arrears',
};

describe('GET /support-usage/hour-block', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores every org selector on the request — only the session org is read', async () => {
    forOrgMock.mockResolvedValue(dto);

    const res = await buildApp().request(
      `/support-usage/hour-block?orgId=${OTHER_ORG}&org_id=${OTHER_ORG}`,
      { headers: { 'X-Org-Id': OTHER_ORG } },
    );

    expect(res.status).toBe(200);
    expect(forOrgMock).toHaveBeenCalledTimes(1);
    expect(forOrgMock).toHaveBeenCalledWith({ orgId: SESSION_ORG });
  });

  it('wraps the DTO in an envelope and answers null (not 404) when the org has no live block', async () => {
    forOrgMock.mockResolvedValueOnce(dto).mockResolvedValueOnce(null);

    const withBlock = await buildApp().request('/support-usage/hour-block');
    expect(await withBlock.json()).toEqual({ hourBlock: dto });

    const without = await buildApp().request('/support-usage/hour-block');
    expect(without.status).toBe(200);
    expect(await without.json()).toEqual({ hourBlock: null });
  });

  it('is privately cached per viewer and honours If-None-Match', async () => {
    forOrgMock.mockResolvedValue(dto);

    const first = await buildApp().request('/support-usage/hour-block');
    expect(first.headers.get('Cache-Control')).toContain('private');
    expect(first.headers.get('Vary')).toContain('Authorization');
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();

    const second = await buildApp().request('/support-usage/hour-block', {
      headers: { 'If-None-Match': etag! },
    });
    expect(second.status).toBe(304);
  });
});
```

- [ ] **Step 4: Write the failing real-mount tests**

In `apps/api/src/routes/portal.test.ts`:

1. Next to the `supportUsageForOrgMock` hoist/mock (lines 9-17) add:

```ts
const { portalHourBlockForOrgMock } = vi.hoisted(() => ({
  portalHourBlockForOrgMock: vi.fn(),
}));

vi.mock('../services/portal/hourBlock', () => ({
  portalHourBlockForOrg: portalHourBlockForOrgMock,
}));
```

2. Inside `describe('W03 strict visibility gates (real mount)', …)`, after the last `it(...)`, add:

```ts
    describe('GET /portal/support-usage/hour-block (block hours W04)', () => {
      const path = '/portal/support-usage/hour-block';

      it('returns 401 with no Authorization header', async () => {
        const res = await app.request(path);
        expect(res.status).toBe(401);
        expect(portalHourBlockForOrgMock).not.toHaveBeenCalled();
      });

      it('returns 403 PORTAL_SUPPORT_USAGE_DISABLED when the Support usage section is off (no row)', async () => {
        vi.mocked(db.select)
          .mockReturnValueOnce(mockSelectLimit([portalUser]) as any) // loginUser()
          .mockReturnValueOnce(mockSelectLimit([portalUser]) as any) // portalAuthMiddleware hydration
          .mockReturnValueOnce(mockSelectLimit([]) as any); // enableSupportUsage gate: no row → fail closed

        const token = await loginUser();
        const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });

        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'PORTAL_SUPPORT_USAGE_DISABLED' });
        expect(portalHourBlockForOrgMock).not.toHaveBeenCalled();
      });

      it('returns 403 PORTAL_HOUR_BLOCK_DISABLED when Support usage is on but Support hours is off', async () => {
        vi.mocked(db.select)
          .mockReturnValueOnce(mockSelectLimit([portalUser]) as any)
          .mockReturnValueOnce(mockSelectLimit([portalUser]) as any)
          .mockReturnValueOnce(mockSelectLimit([{ enableSupportUsage: true }]) as any)
          .mockReturnValueOnce(mockSelectLimit([{ enableHourBlock: false }]) as any);

        const token = await loginUser();
        const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });

        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'PORTAL_HOUR_BLOCK_DISABLED' });
        expect(portalHourBlockForOrgMock).not.toHaveBeenCalled();
      });

      it('returns 200 and reads only the session org when both flags are on, even with tickets disabled', async () => {
        vi.mocked(db.select)
          .mockReturnValueOnce(mockSelectLimit([portalUser]) as any)
          .mockReturnValueOnce(mockSelectLimit([portalUser]) as any)
          .mockReturnValueOnce(mockSelectLimit([{ enableSupportUsage: true }]) as any)
          .mockReturnValueOnce(mockSelectLimit([{ enableHourBlock: true }]) as any);
        portalHourBlockForOrgMock.mockResolvedValue(null);

        const token = await loginUser();
        const res = await app.request(`${path}?orgId=00000000-0000-4000-8000-000000000000`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ hourBlock: null });
        expect(portalHourBlockForOrgMock).toHaveBeenCalledWith({ orgId: portalUser.orgId });
      });
    });
```

(`portalUser`, `loginUser`, `mockSelectLimit`, `db` and `app` are already in scope in that file — see the existing cases at lines ~1338-1388.)

- [ ] **Step 5: Write the shared integration fixture and the failing real-DB test**

Create `apps/api/src/__tests__/integration/hourBlockFixtures.ts` (used by Tasks 2, 3 and 6; it seeds through the admin test connection, so RLS does not interfere with seeding):

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  contractLines,
  contracts,
  organizations,
  portalBranding,
  tickets,
  timeEntries,
} from '../../db/schema';
import { createOrganization } from './db-utils';
import { getTestDb } from './setup';

export interface FixtureEntry {
  minutes: number;
  /** YYYY-MM-DD in December 2026 unless overridden; the entry starts 09:00 UTC. */
  day?: string;
  approved?: boolean;
  billable?: boolean;
  /** 'contract' entries are inserted already drawn by the block line. */
  status?: 'not_billed' | 'contract' | 'billed';
}

export interface SeedBlockOrgArgs {
  partnerId: string;
  technicianId: string;
  contractStatus?: 'active' | 'paused' | 'draft';
  alertPct?: number | null;
  retired?: boolean;
  archived?: boolean;
  enableHourBlock?: boolean;
  includedHours?: string;      // default '10.00'
  overageRate?: string;        // default '150.00'
  createdBy?: string | null;
  entries?: FixtureEntry[];
}

export interface SeededBlockOrg {
  orgId: string;
  contractId: string;
  lineId: string;
  ticketId: string;
}

/**
 * One org with an advance-billed monthly contract starting 2026-12-01 and ONE
 * hour_block line whose first period is 2026-12-01 (so the open period for
 * asOf = 2026-12-20 is [2026-12-01, 2027-01-01)). Column names are the
 * W01 contract (index C2/C4).
 */
export async function seedBlockOrg(args: SeedBlockOrgArgs): Promise<SeededBlockOrg> {
  const admin = getTestDb();
  const org = await createOrganization({ partnerId: args.partnerId });

  if (args.archived) {
    await admin
      .update(organizations)
      .set({ status: 'archived', archivedAt: new Date() })
      .where(eq(organizations.id, org.id));
  }

  const [contract] = await admin
    .insert(contracts)
    .values({
      partnerId: args.partnerId,
      orgId: org.id,
      name: `Block contract ${randomUUID().slice(0, 8)}`,
      status: args.contractStatus ?? 'active',
      billingTiming: 'advance',
      intervalMonths: 1,
      startDate: '2026-12-01',
      nextBillingAt: '2027-01-01',
      currencyCode: 'USD',
      createdBy: args.createdBy ?? null,
    })
    .returning({ id: contracts.id });
  if (!contract) throw new Error('contract insert failed');

  const [line] = await admin
    .insert(contractLines)
    .values({
      contractId: contract.id,
      orgId: org.id,
      lineType: 'hour_block',
      description: 'Support hours',
      unitPrice: '1000.00',
      includedQuantity: args.includedHours ?? '10.00',
      overageMode: 'bill',
      overageUnitPrice: args.overageRate ?? '150.00',
      rolloverPolicy: 'none',
      hourBlockAlertPct: args.alertPct === undefined ? 80 : args.alertPct,
      hourBlockFirstPeriodStart: '2026-12-01',
      hourBlockRetiredAt: args.retired ? new Date('2026-12-05T00:00:00Z') : null,
    })
    .returning({ id: contractLines.id });
  if (!line) throw new Error('contract line insert failed');

  const [ticket] = await admin
    .insert(tickets)
    .values({
      orgId: org.id,
      partnerId: args.partnerId,
      ticketNumber: `HB-${randomUUID()}`,
      subject: 'Block fixture',
      source: 'portal',
    })
    .returning({ id: tickets.id });
  if (!ticket) throw new Error('ticket insert failed');

  for (const entry of args.entries ?? []) {
    const startedAt = new Date(`${entry.day ?? '2026-12-10'}T09:00:00Z`);
    const status = entry.status ?? 'not_billed';
    await admin.insert(timeEntries).values({
      partnerId: args.partnerId,
      orgId: org.id,
      ticketId: ticket.id,
      userId: args.technicianId,
      startedAt,
      endedAt: new Date(startedAt.getTime() + entry.minutes * 60_000),
      durationMinutes: entry.minutes,
      isBillable: entry.billable ?? true,
      billingStatus: status,
      isApproved: entry.approved ?? true,
      currencyCode: 'USD',
      ...(status === 'contract' ? { contractLineId: line.id } : {}),
    });
  }

  if (args.enableHourBlock !== undefined) {
    await admin.insert(portalBranding).values({
      orgId: org.id,
      enableSupportUsage: true,
      enableHourBlock: args.enableHourBlock,
    });
  }

  return { orgId: org.id, contractId: contract.id, lineId: line.id, ticketId: ticket.id };
}
```

Create `apps/api/src/__tests__/integration/portalHourBlock.integration.test.ts`:

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { timeEntries } from '../../db/schema';
import { portalHourBlockForOrg } from '../../services/portal/hourBlock';
import { createPartner, createUser } from './db-utils';
import { seedBlockOrg } from './hourBlockFixtures';

const AS_OF = new Date('2026-12-20T12:00:00Z');

const orgContext = (orgId: string): DbAccessContext => ({
  scope: 'organization',
  orgId,
  accessibleOrgIds: [orgId],
  accessiblePartnerIds: [],
  userId: null,
  currentPartnerId: null,
});

async function seedPartnerAndTech() {
  const partner = await createPartner();
  const technician = await createUser({ partnerId: partner.id, orgId: null });
  return { partnerId: partner.id, technicianId: technician.id };
}

describe('portal hour-block read (block hours W04)', () => {
  it('reads real figures from an org-scoped request context that cannot see time_entries', async () => {
    const { partnerId, technicianId } = await seedPartnerAndTech();
    const a = await seedBlockOrg({
      partnerId, technicianId,
      entries: [
        { minutes: 240 },                      // 4.0 h approved
        { minutes: 90, approved: false },      // 1.5 h unapproved — still draws (Decision 4 A)
        { minutes: 60, billable: false },      // non-billable — never draws
      ],
    });

    await withDbAccessContext(orgContext(a.orgId), async () => {
      // The trap this task exists to avoid: partner-axis time_entries is
      // invisible to an org-scoped context.
      await expect(db.select({ id: timeEntries.id }).from(timeEntries)).resolves.toEqual([]);

      // ...yet the portal read still sees the real balance because it escapes
      // to a system context pinned to the org.
      const dto = await portalHourBlockForOrg({ orgId: a.orgId, asOf: AS_OF });
      expect(dto).toEqual({
        periodStart: '2026-12-01',
        periodEnd: '2027-01-01',
        includedHours: 10,
        carriedInHours: 0,
        usedHours: 5.5,
        remainingHours: 4.5,
        overageHours: 0,
        overageRate: '150.00',
        currencyCode: 'USD',
        billingTiming: 'advance',
      });
    });
  });

  it("org B never sees org A's block, and an org with no block gets null", async () => {
    const { partnerId, technicianId } = await seedPartnerAndTech();
    const a = await seedBlockOrg({ partnerId, technicianId, entries: [{ minutes: 600 }] });
    const b = await seedBlockOrg({
      partnerId, technicianId, includedHours: '4.00', overageRate: '90.00',
      entries: [{ minutes: 60 }],
    });

    const forB = await portalHourBlockForOrg({ orgId: b.orgId, asOf: AS_OF });
    expect(forB).toMatchObject({ includedHours: 4, usedHours: 1, overageRate: '90.00' });
    // Org A's 10.0 used hours and 150.00 rate are nowhere in B's answer.
    expect(JSON.stringify(forB)).not.toContain('150.00');

    const forA = await portalHourBlockForOrg({ orgId: a.orgId, asOf: AS_OF });
    expect(forA).toMatchObject({ includedHours: 10, usedHours: 10, remainingHours: 0, overageHours: 0 });

    const stranger = await createPartner();
    const noBlock = await seedBlockOrg({
      partnerId: stranger.id,
      technicianId: (await createUser({ partnerId: stranger.id, orgId: null })).id,
      retired: true,
    });
    await expect(portalHourBlockForOrg({ orgId: noBlock.orgId, asOf: AS_OF })).resolves.toBeNull();
  });

  it('reports overage hours once the block is exhausted', async () => {
    const { partnerId, technicianId } = await seedPartnerAndTech();
    const a = await seedBlockOrg({ partnerId, technicianId, entries: [{ minutes: 720 }] }); // 12 h

    const dto = await portalHourBlockForOrg({ orgId: a.orgId, asOf: AS_OF });
    expect(dto).toMatchObject({ usedHours: 12, remainingHours: 0, overageHours: 2 });
  });

  it('answers null for a paused or draft contract and for a retired line', async () => {
    const { partnerId, technicianId } = await seedPartnerAndTech();
    const paused = await seedBlockOrg({ partnerId, technicianId, contractStatus: 'paused' });
    const draft = await seedBlockOrg({ partnerId, technicianId, contractStatus: 'draft' });
    const retired = await seedBlockOrg({ partnerId, technicianId, retired: true });

    for (const org of [paused, draft, retired]) {
      await expect(portalHourBlockForOrg({ orgId: org.orgId, asOf: AS_OF })).resolves.toBeNull();
    }
  });
});
```

- [ ] **Step 6: Run, confirm FAIL**

```bash
cd apps/api && npx vitest run \
  src/services/portal/hourBlock.test.ts \
  src/routes/portal/hourBlock.test.ts \
  src/routes/portal.test.ts
```

Expected FAIL: `Cannot find module './hourBlock'` (service and route) and the real-mount cases 404 (no route yet). The integration file fails the same way; run it after Step 8.

- [ ] **Step 7: Implement the service**

Create `apps/api/src/services/portal/hourBlock.ts`:

```ts
import type { HourBlockEstimate, PortalHourBlockDto } from '@breeze/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { contractLines, contracts } from '../../db/schema';
// W03 (see "Assumes from W03"): the live OPEN-period computation behind
// computeContractEstimate(...).hourBlock. It reads time_entries, which is
// partner-axis RLS, so it MUST run inside a system DB context.
import { computeOpenHourBlockPeriod } from '../contractHourBlockEstimate';

/**
 * Explicit whitelist, never a spread: HourBlockEstimate carries MSP-side
 * figures (unapproved / foreign-currency / late-entry hours, the line id, the
 * alert threshold, the projected overage value) a customer must not see.
 */
export function toPortalHourBlockDto(
  estimate: HourBlockEstimate,
  currencyCode: string,
): PortalHourBlockDto {
  return {
    periodStart: estimate.periodStart,
    periodEnd: estimate.periodEnd,
    includedHours: estimate.includedHours,
    carriedInHours: estimate.carriedInHours,
    usedHours: estimate.consumedHours,
    remainingHours: estimate.remainingHours,
    overageHours: estimate.overageHours,
    overageRate: estimate.overageUnitPrice,
    currencyCode,
    billingTiming: estimate.billingTiming,
  };
}

/**
 * The org's live block balance for the portal, or null when it has none.
 *
 * Runs in a SYSTEM context pinned to `orgId` by explicit predicates on both
 * tables — the portal session's own org context cannot read time_entries
 * (partner-axis), so scoping here is by the predicate, not by RLS. The caller
 * must pass the SESSION org (`portalAuth.user.orgId`), never request input.
 *
 * Only the active contract's live (non-retired) block counts: at most one
 * exists per org (contract_lines_one_live_hour_block_per_org_uq).
 */
export async function portalHourBlockForOrg(args: {
  orgId: string;
  asOf?: Date;
}): Promise<PortalHourBlockDto | null> {
  const asOf = args.asOf ?? new Date();

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ contract: contracts, line: contractLines })
        .from(contractLines)
        .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
        .where(
          and(
            eq(contractLines.orgId, args.orgId),
            eq(contracts.orgId, args.orgId),
            eq(contractLines.lineType, 'hour_block'),
            isNull(contractLines.hourBlockRetiredAt),
            eq(contracts.status, 'active'),
          ),
        )
        .limit(1);

      if (!row) return null;

      const estimate = await computeOpenHourBlockPeriod(row.contract, row.line, asOf);
      return toPortalHourBlockDto(estimate, row.contract.currencyCode);
    }),
  );
}
```

- [ ] **Step 8: Implement the route and mount it**

Create `apps/api/src/routes/portal/hourBlock.ts`:

```ts
import { Hono } from 'hono';
import type { PortalHourBlockResponse } from '@breeze/shared';
import { portalHourBlockForOrg } from '../../services/portal/hourBlock';
import { applyPortalCacheHeaders, buildWeakEtag, isEtagFresh } from './helpers';

export const portalHourBlockRoutes = new Hono();

/**
 * Customer-safe block-hours balance (#4547 W04).
 *
 * Auth and both gates (enableSupportUsage, then enableHourBlock) are applied
 * at the hub (routes/portal/index.ts) on `/support-usage/*`. The org is the
 * SESSION's, and only the session's: nothing in the query, headers or body
 * can name another one.
 */
portalHourBlockRoutes.get('/support-usage/hour-block', async (c) => {
  const auth = c.get('portalAuth');
  const hourBlock = await portalHourBlockForOrg({ orgId: auth.user.orgId });
  const payload: PortalHourBlockResponse = { hourBlock };

  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 30,
    staleWhileRevalidateSeconds: 0,
    vary: ['Authorization', 'Cookie'],
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);
  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }
  return c.json(payload);
});
```

In `apps/api/src/routes/portal/index.ts`:

- after `import { portalNetworkRoutes } from './network';` add `import { portalHourBlockRoutes } from './hourBlock';`
- directly after line 82 (`portalRoutes.use('/tickets/usage', createPortalFeatureGateStrict('enableSupportUsage'));`) add:

```ts
// Block hours W04 (#4547): the "Support hours" card lives inside the Support
// usage section, so its endpoint requires BOTH fail-closed flags — auth first,
// then enableSupportUsage, then its own enableHourBlock. A separate prefix on
// purpose: nesting under `/tickets/*` would inherit the enable_tickets gate
// that Support usage deliberately opts out of (see the exact-path wrappers above).
portalRoutes.use('/support-usage/*', portalAuthMiddleware);
portalRoutes.use('/support-usage/*', createPortalFeatureGateStrict('enableSupportUsage'));
portalRoutes.use('/support-usage/*', createPortalFeatureGateStrict('enableHourBlock'));
```

- after `portalRoutes.route('/', portalNetworkRoutes);` add `portalRoutes.route('/', portalHourBlockRoutes);`

- [ ] **Step 9: Run unit tests, confirm PASS; run the integration suite; typecheck**

```bash
cd apps/api && npx vitest run \
  src/services/portal/hourBlock.test.ts \
  src/routes/portal/hourBlock.test.ts \
  src/routes/portal.test.ts \
  src/routes/portal/tickets.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/portalHourBlock.integration.test.ts
cd ../../packages/shared && npx tsc --noEmit
cd ../../apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo "tsc exit=$?"
```

Expected: 4 unit files green (check the reported file count is 4, `portal.test.ts` is large), integration file green (4 tests), `tsc exit=0`. If `computeOpenHourBlockPeriod` is named or homed differently by W03, change only the import line in `services/portal/hourBlock.ts` and the `vi.mock('../contractHourBlockEstimate', …)` path/name in `hourBlock.test.ts`.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/types/portalVisibility.ts \
  apps/api/src/services/portal/hourBlock.ts apps/api/src/services/portal/hourBlock.test.ts \
  apps/api/src/routes/portal/hourBlock.ts apps/api/src/routes/portal/hourBlock.test.ts \
  apps/api/src/routes/portal/index.ts apps/api/src/routes/portal.test.ts \
  apps/api/src/__tests__/integration/hourBlockFixtures.ts \
  apps/api/src/__tests__/integration/portalHourBlock.integration.test.ts
git commit -m "feat(portal): read-only support-hours balance endpoint (#4547)

GET /portal/support-usage/hour-block returns a customer-safe projection of
the org's live block, read in a system context pinned to the session org.
Behind the Support usage and Support hours flags, both fail-closed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Support usage buckets stop calling block-covered hours "to be billed"

**The problem.** `supportUsageForOrg` (`apps/api/src/services/portal/supportUsage.ts`) buckets each approved entry by `billing_status`: `billed`, `contract` → `coveredByContract` (:133-135), anything else → `toBeBilled` (:136-139). Block drawdown writes `billing_status='contract'` **only at period close** (W02), so for a customer with a block:

- entries in the **open** period are still `not_billed` and read "To be billed", although the block fee already pays for them and ad-hoc billing is holding them back (index Open Decision 9); and
- entries already **drawn** at a close are `contract` + `contract_line_id` and read "Covered by contract" (true, but indistinguishable from the work-type-included entries that billing profiles also mark `contract` with no line, spec amendment 1).

**Decision (recommended and implemented):** when — and only when — the org's `enable_hour_block` flag is on, report both groups in a new **`coveredByBlock`** bucket:

| Entry (approved) | Flag off | Flag on |
|---|---|---|
| `billed` | billed | billed |
| `contract`, `contract_line_id IS NULL` (card-included) | coveredByContract | coveredByContract |
| `contract`, `contract_line_id IS NOT NULL` (drawn at close) | coveredByContract | **coveredByBlock** |
| `not_billed`, `ended_at` inside a block hold window (open period) | toBeBilled | **coveredByBlock** |
| `not_billed`, anywhere else (incl. late entries in a closed period) | toBeBilled | toBeBilled |
| unapproved (any status) | pendingReview | pendingReview |

Why gated on the flag: with it off, the customer must not learn a block exists, and existing portals must be byte-identical (the pre-existing tests prove it). Why the **hold windows** (`hourBlockHoldWindows`, W02): they are the *same* function ad-hoc invoice assembly uses to withhold those entries, so "held from ad-hoc billing" and "shown as covered by the block" cannot drift apart. Why `billableMinutes ?? durationMinutes` for the block bucket: the drawdown draws `COALESCE(billable_minutes, duration_minutes)` (spec amendment 2), so the hours tie to the card. Unapproved time keeps landing in `pendingReview` (the panel's existing "approval gates classification" rule); the card is the authority on balance and already includes it.

**Files:**
- Modify: `packages/shared/src/types/portalVisibility.ts` (`SupportUsageTicketDto`, `SupportUsageDto`)
- Create: `apps/api/src/services/portal/hourBlockWindows.ts` + `hourBlockWindows.test.ts` (pure)
- Create: `apps/api/src/services/portal/hourBlockCoverage.ts` (DB; one flag read + W02's windows)
- Modify: `apps/api/src/services/portal/supportUsage.ts`
- Modify: `apps/api/src/services/portal/supportUsage.test.ts`
- Create: `apps/api/src/__tests__/integration/portalSupportUsageHourBlock.integration.test.ts`

**Interfaces:**

```ts
// packages/shared — both ADDITIVE and OPTIONAL (absent when the flag is off)
SupportUsageTicketDto.coveredByBlockMinutes?: number;
SupportUsageDto.totals.coveredByBlock?: CountHoursDto;

// hourBlockWindows.ts (pure)
export interface HourBlockHoldWindow { start: Date; end: Date | null; contractLineId: string }
export function isHeldByBlock(endedAt: Date | null, windows: readonly HourBlockHoldWindow[]): boolean;

// hourBlockCoverage.ts
export interface HourBlockCoverage { windows: HourBlockHoldWindow[] }
export async function hourBlockCoverageForOrg(orgId: string, asOf?: Date): Promise<HourBlockCoverage | null>; // null = flag off/absent

// supportUsage.ts — args gain an optional asOf (default now); the ROUTE is unchanged
supportUsageForOrg(args: { orgId; month; timezone; portalUserId; asOf?: Date }): Promise<SupportUsageDto>
```

- [ ] **Step 1: Write the failing pure-window test**

Create `apps/api/src/services/portal/hourBlockWindows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isHeldByBlock, type HourBlockHoldWindow } from './hourBlockWindows';

const win = (start: string, end: string | null): HourBlockHoldWindow => ({
  start: new Date(start),
  end: end === null ? null : new Date(end),
  contractLineId: 'line-1',
});

describe('isHeldByBlock', () => {
  const windows = [win('2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z')];

  it('holds an entry that ended inside the window', () => {
    expect(isHeldByBlock(new Date('2026-12-10T13:00:00Z'), windows)).toBe(true);
  });

  it('start is inclusive, end is exclusive (a boundary entry belongs to exactly one period)', () => {
    expect(isHeldByBlock(new Date('2026-12-01T00:00:00Z'), windows)).toBe(true);
    expect(isHeldByBlock(new Date('2027-01-01T00:00:00Z'), windows)).toBe(false);
  });

  it('does not hold an entry from before the window (a late entry in a closed period)', () => {
    expect(isHeldByBlock(new Date('2026-11-30T23:59:59Z'), windows)).toBe(false);
  });

  it('a window with no end holds everything from its start on', () => {
    expect(isHeldByBlock(new Date('2031-01-01T00:00:00Z'), [win('2026-12-01T00:00:00Z', null)])).toBe(true);
  });

  it('never holds a running entry (no ended_at) or when there are no windows', () => {
    expect(isHeldByBlock(null, windows)).toBe(false);
    expect(isHeldByBlock(new Date('2026-12-10T13:00:00Z'), [])).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing bucket tests**

In `apps/api/src/services/portal/supportUsage.test.ts`:

1. Add a coverage mock next to the existing `vi.mock('../../db', …)` (and import the real pure helper — only the DB-backed module is mocked):

```ts
const { coverageMock } = vi.hoisted(() => ({ coverageMock: vi.fn() }));
vi.mock('./hourBlockCoverage', () => ({ hourBlockCoverageForOrg: coverageMock }));
```

2. In the file's existing top-level `beforeEach` blocks (both `describe`s), add `coverageMock.mockResolvedValue(null);` so every pre-existing test keeps running with the flag off. (Add a top-level `beforeEach(() => coverageMock.mockResolvedValue(null));` if simpler.)

3. Append:

```ts
describe('block hours coverage (#4547 W04)', () => {
  const open = (start = '2026-12-01T00:00:00Z') => ({
    windows: [{ start: new Date(start), end: null, contractLineId: 'line-1' }],
  });
  const row = (over: Record<string, unknown>) => ({
    ticketNumber: 'T-1', title: null,
    durationMinutes: 60, billableMinutes: null,
    billingStatus: 'not_billed', isApproved: true,
    endedAt: new Date('2026-12-10T13:00:00Z'), contractLineId: null,
    ...over,
  });

  beforeEach(() => {
    state.rows = [];
    coverageMock.mockReset();
  });

  it('flag OFF: nothing changes — no coveredByBlock key anywhere, entries stay to-be-billed', async () => {
    coverageMock.mockResolvedValue(null);
    state.rows = [
      row({}),
      row({ ticketNumber: 'T-2', billingStatus: 'contract', contractLineId: 'line-1' }),
    ];

    const result = await supportUsageForOrg(args);

    expect(result.totals).toEqual({
      billed: { minutes: 0, hours: 0 },
      toBeBilled: { minutes: 60, hours: 1 },
      coveredByContract: { minutes: 60, hours: 1 },
      pendingReview: { minutes: 0, hours: 0 },
    });
    expect(result.totals).not.toHaveProperty('coveredByBlock');
    for (const t of result.tickets) expect(t).not.toHaveProperty('coveredByBlockMinutes');
  });

  it('flag ON: an approved not_billed entry inside the open window is covered by the block, not to-be-billed', async () => {
    coverageMock.mockResolvedValue(open());
    state.rows = [row({ durationMinutes: 60, billableMinutes: 90 })];

    const result = await supportUsageForOrg(args);

    // Block bucket uses the billed quantity (billable ?? duration) so it ties to the card.
    expect(result.totals.coveredByBlock).toEqual({ minutes: 90, hours: 1.5 });
    expect(result.totals.toBeBilled).toEqual({ minutes: 0, hours: 0 });
    expect(result.tickets[0]!.coveredByBlockMinutes).toBe(90);
    expect(result.tickets[0]!.toBeBilledMinutes).toBe(0);
  });

  it('flag ON: a drawn entry (contract + line id) moves from coveredByContract to coveredByBlock; a card-included one (no line id) does not', async () => {
    coverageMock.mockResolvedValue(open());
    state.rows = [
      row({ ticketNumber: 'T-1', billingStatus: 'contract', contractLineId: 'line-1', durationMinutes: 30 }),
      row({ ticketNumber: 'T-2', billingStatus: 'contract', contractLineId: null, durationMinutes: 45 }),
    ];

    const result = await supportUsageForOrg(args);

    expect(result.totals.coveredByBlock).toEqual({ minutes: 30, hours: 0.5 });
    expect(result.totals.coveredByContract).toEqual({ minutes: 45, hours: 0.75 });
  });

  it('flag ON: a late entry from before the window and a running entry stay to-be-billed', async () => {
    coverageMock.mockResolvedValue(open('2026-12-01T00:00:00Z'));
    state.rows = [
      row({ ticketNumber: 'T-1', endedAt: new Date('2026-11-20T10:00:00Z'), durationMinutes: 20 }),
      row({ ticketNumber: 'T-2', endedAt: null, durationMinutes: 10 }),
    ];

    const result = await supportUsageForOrg(args);

    expect(result.totals.toBeBilled).toEqual({ minutes: 30, hours: 0.5 });
    expect(result.totals.coveredByBlock).toEqual({ minutes: 0, hours: 0 });
  });

  it('flag ON: unapproved block-eligible time is still pending review (approval gates classification)', async () => {
    coverageMock.mockResolvedValue(open());
    state.rows = [row({ isApproved: false, durationMinutes: 40 })];

    const result = await supportUsageForOrg(args);

    expect(result.totals.pendingReview).toEqual({ minutes: 40, hours: 40 / 60 });
    expect(result.totals.coveredByBlock).toEqual({ minutes: 0, hours: 0 });
  });

  it('flag ON with nothing to bucket still reports a zeroed coveredByBlock (the flag, not the data, decides presence)', async () => {
    coverageMock.mockResolvedValue({ windows: [] });
    state.rows = [];

    const result = await supportUsageForOrg(args);

    expect(result.totals.coveredByBlock).toEqual({ minutes: 0, hours: 0 });
  });

  it('asks for coverage with the same org it queries, and selects the two new columns', async () => {
    coverageMock.mockResolvedValue(null);
    const asOf = new Date('2026-12-20T12:00:00Z');

    await supportUsageForOrg({ ...args, asOf });

    expect(coverageMock).toHaveBeenCalledWith(args.orgId, asOf);
    expect(state.columns).toHaveProperty('endedAt');
    expect(state.columns).toHaveProperty('contractLineId');
  });
});
```

(`state` and `args` are the existing fixtures at the top of the file; the first describe's `args` object is module-scope.)

- [ ] **Step 3: Write the failing real-DB test**

Create `apps/api/src/__tests__/integration/portalSupportUsageHourBlock.integration.test.ts`:

```ts
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { supportUsageForOrg } from '../../services/portal/supportUsage';
import { createPartner, createUser } from './db-utils';
import { seedBlockOrg } from './hourBlockFixtures';

const AS_OF = new Date('2026-12-20T12:00:00Z');
const entries = [
  { minutes: 240 },                                  // open period, approved, not_billed → block-held
  { minutes: 30, status: 'contract' as const },      // already drawn at a close (carries the line id)
];

async function run(enableHourBlock: boolean) {
  const partner = await createPartner();
  const technician = await createUser({ partnerId: partner.id, orgId: null });
  const org = await seedBlockOrg({
    partnerId: partner.id, technicianId: technician.id, enableHourBlock, entries,
  });
  return supportUsageForOrg({
    orgId: org.orgId, month: '2026-12', timezone: 'UTC', portalUserId: randomUUID(), asOf: AS_OF,
  });
}

describe('support usage with block hours (real DB)', () => {
  it('flag ON: open-period eligible time and drawn time are covered by the block, nothing is "to be billed"', async () => {
    const usage = await run(true);
    expect(usage.totals.coveredByBlock).toEqual({ minutes: 270, hours: 4.5 });
    expect(usage.totals.toBeBilled).toEqual({ minutes: 0, hours: 0 });
    expect(usage.totals.coveredByContract).toEqual({ minutes: 0, hours: 0 });
  });

  it('flag OFF: the same rows read exactly as before — to-be-billed and covered-by-contract, no block bucket', async () => {
    const usage = await run(false);
    expect(usage.totals.toBeBilled).toEqual({ minutes: 240, hours: 4 });
    expect(usage.totals.coveredByContract).toEqual({ minutes: 30, hours: 0.5 });
    expect(usage.totals).not.toHaveProperty('coveredByBlock');
  });
});
```

- [ ] **Step 4: Run, confirm FAIL**

```bash
cd apps/api && npx vitest run \
  src/services/portal/hourBlockWindows.test.ts \
  src/services/portal/supportUsage.test.ts
```

Expected FAIL: `Cannot find module './hourBlockWindows'`; in `supportUsage.test.ts` the new cases fail (`coveredByBlock` undefined) and the import of `./hourBlockCoverage` cannot resolve. The existing cases in the file must still be the only ones passing.

- [ ] **Step 5: Implement the shared type additions**

In `packages/shared/src/types/portalVisibility.ts`:

- in `SupportUsageTicketDto` add, after `pendingReviewMinutes: number;`:

```ts
  /** Present only when the org's Support hours flag is on (#4547 W04). */
  coveredByBlockMinutes?: number;
```

- in `SupportUsageDto.totals` add, after `pendingReview: CountHoursDto;`:

```ts
    /** Hours drawn by, or reserved for, the org's prepaid block. Present only
     *  when the org's Support hours flag is on (#4547 W04): with it off a
     *  customer must not learn a block exists, and every existing portal reads
     *  exactly as before. */
    coveredByBlock?: CountHoursDto;
```

- [ ] **Step 6: Implement the pure windows helper and the DB coverage helper**

Create `apps/api/src/services/portal/hourBlockWindows.ts`:

```ts
/**
 * Pure classification helper for the Support usage buckets (#4547 W04). Kept
 * out of hourBlockCoverage.ts so unit suites can use it without mocking the DB.
 */
export interface HourBlockHoldWindow {
  /** inclusive */
  start: Date;
  /** exclusive; null = open-ended */
  end: Date | null;
  contractLineId: string;
}

/** True when a not-billed entry that ended at `endedAt` is reserved for a block. */
export function isHeldByBlock(endedAt: Date | null, windows: readonly HourBlockHoldWindow[]): boolean {
  if (endedAt === null) return false;
  const t = endedAt.getTime();
  return windows.some(
    (w) => t >= w.start.getTime() && (w.end === null || t < w.end.getTime()),
  );
}
```

Create `apps/api/src/services/portal/hourBlockCoverage.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { portalBranding } from '../../db/schema';
// W02 (see "Assumes from W02"): the SAME windows ad-hoc invoice assembly uses
// to withhold block-eligible entries, so "held from ad-hoc billing" and
// "shown as covered by the block" cannot drift apart.
import { hourBlockHoldWindows } from '../contractHourBlockClose';
import type { HourBlockHoldWindow } from './hourBlockWindows';

export interface HourBlockCoverage {
  windows: HourBlockHoldWindow[];
}

/**
 * The block-coverage context for an org's Support usage buckets, or null when
 * the org's `enable_hour_block` flag is off/absent (the buckets then stay
 * exactly as they were). System context pinned to `orgId`: portal_branding is
 * org-scoped but the windows read time_entries' partner-axis neighbours.
 */
export async function hourBlockCoverageForOrg(
  orgId: string,
  asOf: Date = new Date(),
): Promise<HourBlockCoverage | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ enabled: portalBranding.enableHourBlock })
        .from(portalBranding)
        .where(eq(portalBranding.orgId, orgId))
        .limit(1);
      if (row?.enabled !== true) return null;
      return { windows: await hourBlockHoldWindows(orgId, asOf) };
    }),
  );
}
```

- [ ] **Step 7: Implement the `supportUsage.ts` change**

Edit `apps/api/src/services/portal/supportUsage.ts`:

1. Imports — after `import { tickets, timeEntries } from '../../db/schema';` add:

```ts
import { hourBlockCoverageForOrg } from './hourBlockCoverage';
import { isHeldByBlock } from './hourBlockWindows';
```

2. `UsageRow` — add two fields after `isApproved: boolean;`:

```ts
  endedAt: Date | null;
  /** Non-null only when a block close drew this entry (billing_status = 'contract'). */
  contractLineId: string | null;
```

3. Function signature — add `asOf?: Date;` to the args type. Before the `const rows = await runOutsideDbContext(…)` statement add:

```ts
  // #4547 W04: null unless the org's Support hours flag is on. Resolved in its
  // own system context BEFORE the usage query so the usage query stays a single
  // statement, and so a flag-off org pays one indexed portal_branding read.
  const coverage = await hourBlockCoverageForOrg(args.orgId, args.asOf);
```

4. In the `.select({ … })` object add after `isApproved: timeEntries.isApproved,`:

```ts
          endedAt: timeEntries.endedAt,
          contractLineId: timeEntries.contractLineId,
```

5. After `let pendingReview = 0;` add `let coveredByBlock = 0;`.

6. In the per-ticket default object (the `?? { ticketNumber: …, pendingReviewMinutes: 0, }` literal) add, after `pendingReviewMinutes: 0,`:

```ts
      ...(coverage ? { coveredByBlockMinutes: 0 } : {}),
```

7. In the bucket `if/else` chain, insert a new branch **between** the `!row.isApproved` branch and the `billed` branch:

```ts
    } else if (
      coverage &&
      ((row.billingStatus === 'contract' && row.contractLineId !== null) ||
        (row.billingStatus === 'not_billed' && isHeldByBlock(row.endedAt, coverage.windows)))
    ) {
      // #4547 W04. Drawn at a close (contract + line id) or reserved for the
      // open period (the same hold windows ad-hoc assembly uses). Reported in
      // the BILLED quantity so the hours tie to the Support hours card, which
      // draws COALESCE(billable_minutes, duration_minutes).
      coveredByBlock += billedQuantity;
      ticket.coveredByBlockMinutes = (ticket.coveredByBlockMinutes ?? 0) + billedQuantity;
```

8. In the returned `totals`, after `pendingReview: amount(pendingReview),` add:

```ts
      ...(coverage ? { coveredByBlock: amount(coveredByBlock) } : {}),
```

- [ ] **Step 8: Run unit tests, confirm PASS; run the integration suite; typecheck**

```bash
cd apps/api && npx vitest run \
  src/services/portal/hourBlockWindows.test.ts \
  src/services/portal/supportUsage.test.ts \
  src/routes/portal/tickets.test.ts \
  src/routes/portal.test.ts
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/portalSupportUsageHourBlock.integration.test.ts \
  src/__tests__/integration/portalVisibilityRls.integration.test.ts
cd ../../packages/shared && npx vitest run src/types/portalVisibility.test.ts && npx tsc --noEmit
cd ../../apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo "tsc exit=$?"
```

Expected: unit files green (the pre-existing `supportUsage` cases still pass untouched, proving flag-off parity; `tickets.test.ts` still asserts the route calls `supportUsageForOrg` with exactly `{orgId, month, timezone, portalUserId}`); both integration files green; `tsc exit=0`.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/types/portalVisibility.ts \
  apps/api/src/services/portal/hourBlockWindows.ts apps/api/src/services/portal/hourBlockWindows.test.ts \
  apps/api/src/services/portal/hourBlockCoverage.ts \
  apps/api/src/services/portal/supportUsage.ts apps/api/src/services/portal/supportUsage.test.ts \
  apps/api/src/__tests__/integration/portalSupportUsageHourBlock.integration.test.ts
git commit -m "feat(portal): report block-covered support time in its own bucket (#4547)

With Support hours enabled, drawn and open-period eligible entries are
reported as covered by the block instead of to-be-billed. With the flag off
the buckets are unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Admin toggle in Org portal settings (+ 8 locales)

**Files:**
- Modify: `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx` (type :15-35, `VisibilityToggleKey` :60-74, `VISIBILITY_TOGGLES` :136-140, `enableAllVisibility` :182-193, save body :226)
- Modify: `apps/web/src/components/settings/OrgPortalSettingsEditor.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json` (insert after `visibility.toggles.enableNetworkAlerts`, line 1871)

**Interfaces:** i18n keys `orgPortalSettingsEditor.visibility.toggles.enableHourBlock.{label,description}`; test id `org-portal-toggle-enableHourBlock` (built by the existing toggle renderer from the `key`). The toggle lives in the existing Visibility panel; **`enableAllVisibility()` does not set it.**

Settings-rule check (CLAUDE.md "Settings — one concept, one home"): one concept, one home (this editor); level = org; the portal reads the same `portal_branding` row (one resolver: `orgPortalSettings.ts`); saves through the page Save + `runAction` like its siblings.

- [ ] **Step 1: Write the failing editor tests**

In `OrgPortalSettingsEditor.test.tsx`:

1. Add `enableHourBlock: false,` to the `SETTINGS` fixture (after `enableNetworkVisibility: false,`).
2. Do **not** add it to the `Enable all` key list (lines ~123-134) — that omission is the point. Add these tests next to the existing visibility tests:

```tsx
  it('shows the Support hours toggle from the fetched settings, unchecked by default', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    const toggle = await screen.findByTestId('org-portal-toggle-enableHourBlock');
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });

  it('Enable all visibility does not turn on Support hours (billing-sensitive, enabled one at a time)', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    fireEvent.click(await screen.findByTestId('org-portal-enable-all-visibility'));

    expect((screen.getByTestId('org-portal-toggle-enableHourBlock') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('org-portal-toggle-enableSupportUsage') as HTMLInputElement).checked).toBe(true);
  });

  it('saves the Support hours flag through the existing runAction PATCH', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);

    fireEvent.click(await screen.findByTestId('org-portal-toggle-enableHourBlock'));
    expect(onDirty).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('org-portal-save'));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall![1]!.body))).toMatchObject({ enableHourBlock: true });
  });
```

3. Add an `it` that asserts every locale defines the new keys (the generic `localeParity.test.ts` covers parity; this pins the exact keys exist and are non-empty):

```tsx
  it.each(['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'])(
    'has a translated Support hours label and description in %s',
    async (locale) => {
      const catalog = (await import(`../../locales/${locale}/settings.json`)).default as {
        orgPortalSettingsEditor: { visibility: { toggles: Record<string, { label: string; description: string }> } };
      };
      const entry = catalog.orgPortalSettingsEditor.visibility.toggles.enableHourBlock;
      expect(entry?.label.length).toBeGreaterThan(0);
      expect(entry?.description.length).toBeGreaterThan(0);
    },
  );
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
cd apps/web && npx vitest run src/components/settings/OrgPortalSettingsEditor.test.tsx
```

Expected FAIL: `Unable to find an element by: [data-testid="org-portal-toggle-enableHourBlock"]`; the locale cases fail on `entry` undefined.

- [ ] **Step 3: Implement the editor change**

In `OrgPortalSettingsEditor.tsx`:

- `PortalSettings` type: after `enableNetworkAlerts: boolean;` add `enableHourBlock: boolean;`
- `VisibilityToggleKey`: change `| 'enableNetworkAlerts';` to `| 'enableNetworkAlerts'\n  | 'enableHourBlock';`
- `VISIBILITY_TOGGLES`: after the `enableNetworkAlerts` entry (before `];`) add:

```tsx
  // Billing-sensitive (a prepaid-hours balance) and only meaningful inside the
  // Support usage section, so it has its own fail-closed flag and is
  // deliberately left out of enableAllVisibility() below (block hours W04,
  // #4547; same pattern as enableNetworkAlerts above).
  {
    key: 'enableHourBlock',
    labelKey: 'orgPortalSettingsEditor.visibility.toggles.enableHourBlock.label',
    descriptionKey: 'orgPortalSettingsEditor.visibility.toggles.enableHourBlock.description',
  },
```

- `save` body: after `enableNetworkAlerts: draft.enableNetworkAlerts,` add `enableHourBlock: draft.enableHourBlock,`
- `enableAllVisibility`: leave the object unchanged.

- [ ] **Step 4: Add the 8 locale entries**

Run this one-off script from the repo root (a textual insert after the `enableNetworkAlerts` block; it preserves every other byte of each file, which a `JSON.stringify` rewrite would not guarantee). The strings are real translations; the es-419/fr/de/it/pt-BR/tr catalogs are machine drafts pending native review, like their siblings (`apps/web/src/locales/README.md`).

```bash
node - <<'NODE'
const fs = require('fs');
const entries = {
  'en': ['Support hours', "Show prepaid block hours used and remaining inside the customer's Support usage section. Requires Support usage. Not turned on by Enable all visibility."],
  'de-DE': ['Support-Stunden', 'Zeigt im Bereich Support-Nutzung des Kunden die verbrauchten und verbleibenden Stunden des vorausbezahlten Stundenkontingents an. Erfordert Support-Nutzung. Wird durch „Alle Sichtbarkeiten aktivieren“ nicht eingeschaltet.'],
  'es-419': ['Horas de soporte', 'Muestra las horas prepagadas del bloque usadas y restantes dentro de la sección de uso de soporte del cliente. Requiere Uso de soporte. No se activa al habilitar toda la visibilidad.'],
  'fr-CA': ['Heures de soutien', 'Affiche les heures prépayées du forfait utilisées et restantes dans la section Utilisation du soutien du client. Nécessite Utilisation du soutien. Non activé lorsque vous activez toute la visibilité.'],
  'fr-FR': ['Heures de support', 'Affiche les heures prépayées du forfait consommées et restantes dans la section Utilisation du support du client. Nécessite Utilisation du support. Non activé lorsque vous activez toute la visibilité.'],
  'it-IT': ['Ore di assistenza', 'Mostra le ore prepagate del pacchetto utilizzate e rimanenti nella sezione Utilizzo assistenza del cliente. Richiede Utilizzo assistenza. Non viene attivato abilitando tutta la visibilità.'],
  'pt-BR': ['Horas de suporte', 'Mostra as horas pré-pagas do pacote usadas e restantes dentro da seção de uso de suporte do cliente. Requer Uso de suporte. Não é ativado ao habilitar toda a visibilidade.'],
  'tr-TR': ['Destek saatleri', 'Müşterinin destek kullanımı bölümünde ön ödemeli saat paketinin kullanılan ve kalan saatlerini gösterir. Destek kullanımı gerektirir. Tüm görünürlüğü etkinleştirdiğinizde açılmaz.'],
};
const re = /(        "enableNetworkAlerts": \{\n[^}]*\n        \})\n/;
for (const [locale, [label, description]] of Object.entries(entries)) {
  const file = `apps/web/src/locales/${locale}/settings.json`;
  const src = fs.readFileSync(file, 'utf8');
  if (!re.test(src)) throw new Error(`${locale}: enableNetworkAlerts block not found`);
  if (src.includes('"enableHourBlock"')) throw new Error(`${locale}: already present`);
  const block =
    `,\n        "enableHourBlock": {\n          "label": ${JSON.stringify(label)},\n          "description": ${JSON.stringify(description)}\n        }\n`;
  const out = src.replace(re, (_m, g1) => g1 + block);
  JSON.parse(out); // fail loudly on malformed output
  fs.writeFileSync(file, out);
  console.log('updated', locale);
}
NODE
git diff --stat -- apps/web/src/locales
```

Expected: 8 `updated …` lines; the diff stat shows 8 files with ~5 added lines each (plus the one-line comma change on the `}` line).

- [ ] **Step 5: Run web tests (editor + locale parity), confirm PASS; typecheck**

```bash
cd apps/web && npx vitest run \
  src/components/settings/OrgPortalSettingsEditor.test.tsx \
  src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/translationCoverage.test.ts \
  src/locales/humanizedKeyRegression.test.ts
cd apps/web && npx tsc --noEmit -p . ; echo "tsc exit=$?"
```

Expected: 4 files green, `tsc exit=0`. (If `humanizedKeyRegression.test.ts` flags the new key, the English label is a human sentence, not a humanised key; re-check the English value was written, not the key name.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/OrgPortalSettingsEditor.tsx \
  apps/web/src/components/settings/OrgPortalSettingsEditor.test.tsx apps/web/src/locales
git commit -m "feat(settings): Support hours toggle in org portal settings (#4547)

Independent, off by default, and not part of Enable all visibility. Eight
locales.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Portal "Support hours" card

**Files:**
- Modify: `apps/portal/src/lib/api.ts` (`BrandingConfig` line ~819-822; `import type` line 10; `portalApi` near `getSupportUsage` :1308)
- Modify: `apps/portal/src/lib/ticketsPage.ts` + `ticketsPage.test.ts`
- Create: `apps/portal/src/components/portal/HourBlockCard.tsx` + `HourBlockCard.test.tsx`
- Modify: `apps/portal/src/components/portal/SupportUsagePanel.tsx` + `SupportUsagePanel.test.tsx`
- Modify: `apps/portal/src/pages/tickets/index.astro`

**Interfaces:**

```ts
// api.ts
BrandingConfig.enableHourBlock?: boolean;
portalApi.getHourBlock(config?): Promise<ApiResponse<PortalHourBlockResponse>>   // GET /portal/support-usage/hour-block

// ticketsPage.ts
export function shouldLoadHourBlock(branding: { enableHourBlock?: boolean }, usageResponse: { statusCode?: number }): boolean;
export function hourBlockPanelState(response: { data?: PortalHourBlockResponse; statusCode?: number } | null):
  { hourBlock: PortalHourBlockDto | null; hourBlockError: string | undefined };

// HourBlockCard.tsx
export function HourBlockCard({ hourBlock }: { hourBlock: PortalHourBlockDto }): JSX.Element
// SupportUsagePanel props gain: hourBlock?: PortalHourBlockDto | null; hourBlockError?: string
```

Copy (English literals; the portal has no i18n layer):

- Heading `Support hours`; main line `6.5 of 12 hours used`, where 12 = included + carried in; sub-line `Includes 2 hours carried over from last period` only when `carriedInHours > 0`.
- `5.5 hours remaining`, or when `overageHours > 0`: `2 hours over your block`.
- `Period: Dec 1, 2026 – Dec 31, 2026` (the API sends a half-open end; the card shows the inclusive last day).
- Rate note, `advance`: `Hours beyond your block are billed at $150.00 per hour on the invoice for the following period.` / `arrears`: `… on this period's invoice.`
- `Support hours` (the unit label) is pluralised with `Intl.PluralRules`-free logic: `1 hour` / `N hours`.
- The `Covered by your support hours` totals row appears in the usage table only when `usage.totals.coveredByBlock` has minutes.

- [ ] **Step 1: Write the failing helper tests**

Append to `apps/portal/src/lib/ticketsPage.test.ts`:

```ts
import { hourBlockPanelState, shouldLoadHourBlock } from './ticketsPage';

describe('shouldLoadHourBlock', () => {
  it('loads only when the branding flag is strictly true AND Support usage itself loaded', () => {
    expect(shouldLoadHourBlock({ enableHourBlock: true }, { statusCode: 200 })).toBe(true);
    expect(shouldLoadHourBlock({ enableHourBlock: true }, { statusCode: 403 })).toBe(false);
    expect(shouldLoadHourBlock({ enableHourBlock: true }, { statusCode: 500 })).toBe(false);
    expect(shouldLoadHourBlock({ enableHourBlock: false }, { statusCode: 200 })).toBe(false);
    expect(shouldLoadHourBlock({}, { statusCode: 200 })).toBe(false);
  });
});

describe('hourBlockPanelState', () => {
  const dto = {
    periodStart: '2026-12-01', periodEnd: '2027-01-01', includedHours: 10, carriedInHours: 0,
    usedHours: 1, remainingHours: 9, overageHours: 0, overageRate: '150.00',
    currencyCode: 'USD', billingTiming: 'advance' as const,
  };

  it('passes the block through on success', () => {
    expect(hourBlockPanelState({ statusCode: 200, data: { hourBlock: dto } }))
      .toEqual({ hourBlock: dto, hourBlockError: undefined });
  });

  it('is empty (no card, no error) when not requested, when there is no block, or when the flag raced to 403', () => {
    expect(hourBlockPanelState(null)).toEqual({ hourBlock: null, hourBlockError: undefined });
    expect(hourBlockPanelState({ statusCode: 200, data: { hourBlock: null } }))
      .toEqual({ hourBlock: null, hourBlockError: undefined });
    expect(hourBlockPanelState({ statusCode: 403 }))
      .toEqual({ hourBlock: null, hourBlockError: undefined });
  });

  it('reports a load failure instead of silently dropping the card', () => {
    expect(hourBlockPanelState({ statusCode: 500 }).hourBlockError)
      .toBe('Your support hours could not be loaded right now.');
  });
});
```

- [ ] **Step 2: Write the failing card and panel tests**

Create `apps/portal/src/components/portal/HourBlockCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PortalHourBlockDto } from '@breeze/shared';
import { HourBlockCard } from './HourBlockCard';

const base: PortalHourBlockDto = {
  periodStart: '2026-12-01',
  periodEnd: '2027-01-01',
  includedHours: 10,
  carriedInHours: 0,
  usedHours: 6.5,
  remainingHours: 3.5,
  overageHours: 0,
  overageRate: '150.00',
  currencyCode: 'USD',
  billingTiming: 'advance',
};

describe('HourBlockCard', () => {
  it('shows used of total hours, the remainder and the inclusive period', () => {
    render(<HourBlockCard hourBlock={base} />);

    expect(screen.getByTestId('portal-hour-block-used').textContent).toBe('6.5 of 10 hours used');
    expect(screen.getByTestId('portal-hour-block-remaining').textContent).toBe('3.5 hours remaining');
    const period = screen.getByTestId('portal-hour-block-period').textContent ?? '';
    expect(period).toContain('Dec 1, 2026');
    // Half-open API end (Jan 1) is shown as the inclusive last day.
    expect(period).toContain('Dec 31, 2026');
    expect(period).not.toContain('Jan 1, 2027');
  });

  it('zero state: nothing used yet', () => {
    render(<HourBlockCard hourBlock={{ ...base, usedHours: 0, remainingHours: 10 }} />);

    expect(screen.getByTestId('portal-hour-block-used').textContent).toBe('0 of 10 hours used');
    expect(screen.getByTestId('portal-hour-block-remaining').textContent).toBe('10 hours remaining');
  });

  it('counts carried-over hours into the total and says so', () => {
    render(<HourBlockCard hourBlock={{ ...base, carriedInHours: 2, remainingHours: 5.5 }} />);

    expect(screen.getByTestId('portal-hour-block-used').textContent).toBe('6.5 of 12 hours used');
    expect(screen.getByTestId('portal-hour-block-carried').textContent)
      .toBe('Includes 2 hours carried over from last period');
  });

  it('singular hour wording', () => {
    render(<HourBlockCard hourBlock={{ ...base, includedHours: 1, usedHours: 0.5, remainingHours: 0.5 }} />);

    expect(screen.getByTestId('portal-hour-block-remaining').textContent).toBe('0.5 hours remaining');
    render(<HourBlockCard hourBlock={{ ...base, includedHours: 5, usedHours: 4, remainingHours: 1 }} />);
    expect(screen.getAllByTestId('portal-hour-block-remaining')[1]!.textContent).toBe('1 hour remaining');
  });

  it('over-block state names the overage and the contracted rate, never a computed amount', () => {
    render(<HourBlockCard hourBlock={{ ...base, usedHours: 12, remainingHours: 0, overageHours: 2 }} />);

    expect(screen.getByTestId('portal-hour-block-remaining').textContent).toBe('2 hours over your block');
    const note = screen.getByTestId('portal-hour-block-rate').textContent ?? '';
    expect(note).toContain('$150.00');
    expect(note).toContain('on the invoice for the following period');
    // 2 h x 150 = 300 must NOT be projected to the customer.
    expect(screen.getByTestId('portal-hour-block').textContent).not.toContain('300');
  });

  it('arrears wording ties overage to this period\'s invoice', () => {
    render(<HourBlockCard hourBlock={{ ...base, billingTiming: 'arrears' }} />);
    expect(screen.getByTestId('portal-hour-block-rate').textContent).toContain("on this period's invoice");
  });

  it('exposes progress accessibly and clamps the bar at 100%', () => {
    render(<HourBlockCard hourBlock={{ ...base, usedHours: 12, remainingHours: 0, overageHours: 2 }} />);

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });
});
```

Append to `SupportUsagePanel.test.tsx` (the existing `usage` fixture and imports are at the top of that file):

```tsx
import type { PortalHourBlockDto } from '@breeze/shared';

const hourBlock: PortalHourBlockDto = {
  periodStart: '2026-09-01', periodEnd: '2026-10-01', includedHours: 10, carriedInHours: 0,
  usedHours: 4, remainingHours: 6, overageHours: 0, overageRate: '150.00',
  currencyCode: 'USD', billingTiming: 'advance',
};

describe('Support hours card inside the panel (block hours W04)', () => {
  it('is hidden when no block is passed (flag off / no live block) — the table is untouched', () => {
    render(<SupportUsagePanel usage={{ ...usage }} />);
    expect(screen.queryByTestId('portal-hour-block')).toBeNull();
    expect(screen.getByTestId('portal-support-usage-tickets')).toBeTruthy();

    render(<SupportUsagePanel usage={{ ...usage }} hourBlock={null} />);
    expect(screen.queryByTestId('portal-hour-block')).toBeNull();
  });

  it('is shown above the usage table, with figures, when a block is passed', () => {
    render(<SupportUsagePanel usage={{ ...usage }} hourBlock={hourBlock} />);

    const card = screen.getByTestId('portal-hour-block');
    const table = screen.getByTestId('portal-support-usage-tickets');
    expect(card.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('portal-hour-block-used').textContent).toBe('4 of 10 hours used');
  });

  it('still shows the card on a month with no support time recorded', () => {
    render(
      <SupportUsagePanel
        hourBlock={hourBlock}
        usage={{
          ...usage, dataStatus: 'no_data',
          totals: {
            billed: { minutes: 0, hours: 0 }, toBeBilled: { minutes: 0, hours: 0 },
            coveredByContract: { minutes: 0, hours: 0 }, pendingReview: { minutes: 0, hours: 0 },
          },
          tickets: [],
        }}
      />,
    );
    expect(screen.getByTestId('portal-hour-block')).toBeTruthy();
    expect(screen.getByTestId('portal-support-usage-empty')).toBeTruthy();
  });

  it('shows a load failure notice instead of silently dropping the card', () => {
    render(<SupportUsagePanel usage={{ ...usage }} hourBlockError="Your support hours could not be loaded right now." />);
    expect(screen.getByText('Your support hours could not be loaded right now.')).toBeTruthy();
    expect(screen.queryByTestId('portal-hour-block')).toBeNull();
  });

  it('adds a "Covered by your support hours" row only when the block bucket has time', () => {
    render(
      <SupportUsagePanel
        usage={{ ...usage, totals: { ...usage.totals, coveredByBlock: { minutes: 90, hours: 1.5 } } }}
        hourBlock={hourBlock}
      />,
    );
    expect(screen.getByTestId('portal-support-usage-block').textContent).toContain('90');

    render(
      <SupportUsagePanel
        usage={{ ...usage, totals: { ...usage.totals, coveredByBlock: { minutes: 0, hours: 0 } } }}
        hourBlock={hourBlock}
      />,
    );
    // second render adds no block row: exactly one in the document overall
    expect(screen.getAllByTestId('portal-support-usage-block')).toHaveLength(1);
  });

  it('keeps the existing five column headers when there is no block bucket', () => {
    render(<SupportUsagePanel usage={{ ...usage }} hourBlock={hourBlock} />);
    const headers = Array.from(
      screen.getByTestId('portal-support-usage-tickets').querySelectorAll('th[scope="col"]'),
    ).map((th) => th.textContent);
    expect(headers).toEqual(['Request', 'Billed', 'To be billed', 'Covered', 'Pending review']);
  });
});
```

- [ ] **Step 3: Run, confirm FAIL**

```bash
cd apps/portal && npx vitest run \
  src/lib/ticketsPage.test.ts \
  src/components/portal/HourBlockCard.test.tsx \
  src/components/portal/SupportUsagePanel.test.tsx
```

Expected FAIL: the two new `ticketsPage` exports are undefined, `./HourBlockCard` cannot be resolved, and the panel cases cannot find `portal-hour-block`. The seven pre-existing panel cases must still pass.

- [ ] **Step 4: Implement the client, helpers and card**

`apps/portal/src/lib/api.ts`:

- line 10: add `PortalHourBlockResponse` to the `import type { … } from '@breeze/shared'` list (alphabetical, after `NetworkOverviewDto`).
- `BrandingConfig` (after `enableNetworkVisibility?: boolean;`): add `enableHourBlock?: boolean;`
- in `portalApi`, directly after `getSupportUsage`:

```ts
  // Block hours W04 (#4547): read-only prepaid-hours balance. Only called
  // when branding.enableHourBlock is true (see pages/tickets/index.astro).
  getHourBlock: (
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<PortalHourBlockResponse>> =>
    apiGet<PortalHourBlockResponse>('/portal/support-usage/hour-block', config),
```

`apps/portal/src/lib/ticketsPage.ts` — add at the top `import type { PortalHourBlockDto, PortalHourBlockResponse } from '@breeze/shared';` and append:

```ts
/**
 * The Support hours card is fetched only when the MSP turned the flag on AND
 * the Support usage section itself loaded — the endpoint sits behind both, so
 * asking otherwise is a guaranteed 403 on every page view.
 */
export function shouldLoadHourBlock(
  branding: { enableHourBlock?: boolean },
  usageResponse: PortalResponseState,
): boolean {
  return branding.enableHourBlock === true && usageResponse.statusCode === 200;
}

/**
 * What the panel gets. A 403 is the flag having flipped between the branding
 * read and this one: quietly no card. Any other failure is reported — a
 * balance that vanishes without a word reads as "no hours left".
 */
export function hourBlockPanelState(
  response: { data?: PortalHourBlockResponse; statusCode?: number } | null,
): { hourBlock: PortalHourBlockDto | null; hourBlockError: string | undefined } {
  if (!response) return { hourBlock: null, hourBlockError: undefined };
  if (response.data !== undefined) {
    return { hourBlock: response.data.hourBlock, hourBlockError: undefined };
  }
  if (response.statusCode === 403) return { hourBlock: null, hourBlockError: undefined };
  return { hourBlock: null, hourBlockError: 'Your support hours could not be loaded right now.' };
}
```

Create `apps/portal/src/components/portal/HourBlockCard.tsx`:

```tsx
import type { PortalHourBlockDto } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { money, portalLocale } from '@/lib/money';

/** SSR-safe: the same locale source as money(). */
function hours(value: number): string {
  return new Intl.NumberFormat(portalLocale(), { maximumFractionDigits: 2 }).format(value);
}

function hoursLabel(value: number): string {
  return `${hours(value)} ${value === 1 ? 'hour' : 'hours'}`;
}

/** The API's end is half-open (the first day of the NEXT period); a customer
 *  reads "through" dates, so show the inclusive last day. */
function periodLabel(start: string, endExclusive: string): string {
  const fmt = new Intl.DateTimeFormat(portalLocale(), {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  const last = new Date(`${endExclusive}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 1);
  return `${fmt.format(new Date(`${start}T00:00:00Z`))} – ${fmt.format(last)}`;
}

export function HourBlockCard({ hourBlock }: { hourBlock: PortalHourBlockDto }) {
  const total = hourBlock.includedHours + hourBlock.carriedInHours;
  const percent = total > 0 ? Math.min(100, Math.round((hourBlock.usedHours / total) * 100)) : 100;
  const over = hourBlock.overageHours > 0;

  return (
    <section
      className="mb-8 border-y border-border/70 px-4 py-5"
      data-testid="portal-hour-block"
      aria-label="Support hours"
    >
      <h2 className="font-display text-lg font-semibold text-foreground">Support hours</h2>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="portal-hour-block-period">
        Period: {periodLabel(hourBlock.periodStart, hourBlock.periodEnd)}
      </p>

      <p className="text-figures mt-4 text-base font-medium text-foreground" data-testid="portal-hour-block-used">
        {`${hours(hourBlock.usedHours)} of ${hoursLabel(total)} used`}
      </p>

      <div
        role="progressbar"
        aria-label="Support hours used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-border/70"
      >
        <div
          className={cn('h-full rounded-full', over ? 'bg-destructive' : 'bg-foreground/70')}
          style={{ width: `${percent}%` }}
        />
      </div>

      <p
        className={cn('text-figures mt-2 text-sm', over ? 'text-destructive-on-tint' : 'text-muted-foreground')}
        data-testid="portal-hour-block-remaining"
      >
        {over
          ? `${hoursLabel(hourBlock.overageHours)} over your block`
          : `${hoursLabel(hourBlock.remainingHours)} remaining`}
      </p>

      {hourBlock.carriedInHours > 0 && (
        <p className="mt-1 text-sm text-muted-foreground" data-testid="portal-hour-block-carried">
          {`Includes ${hoursLabel(hourBlock.carriedInHours)} carried over from last period`}
        </p>
      )}

      <p className="mt-3 text-xs text-muted-foreground" data-testid="portal-hour-block-rate">
        {`Hours beyond your block are billed at ${money(hourBlock.overageRate, hourBlock.currencyCode)} per hour ${
          hourBlock.billingTiming === 'arrears'
            ? "on this period's invoice."
            : 'on the invoice for the following period.'
        }`}
      </p>
    </section>
  );
}

export default HourBlockCard;
```

- [ ] **Step 5: Wire the card into the panel and the page**

`apps/portal/src/components/portal/SupportUsagePanel.tsx`:

- imports: add `import type { PortalHourBlockDto, SupportUsageDto } from '@breeze/shared';` (replace the existing type import) and `import { HourBlockCard } from './HourBlockCard';`
- `Totals`: build the rows array so the block row is optional — replace the `rows` const with:

```tsx
  const rows = [
    { key: 'billed', label: 'Billed', value: usage.totals.billed },
    { key: 'to-be-billed', label: 'To be billed', value: usage.totals.toBeBilled },
    { key: 'contract', label: 'Covered by contract', value: usage.totals.coveredByContract },
    // #4547 W04: only when the org's Support hours flag is on AND the block
    // actually covered something; otherwise the four rows read as before.
    ...(usage.totals.coveredByBlock && usage.totals.coveredByBlock.minutes > 0
      ? [{ key: 'block', label: 'Covered by your support hours', value: usage.totals.coveredByBlock }]
      : []),
    { key: 'pending', label: 'Pending review', value: usage.totals.pendingReview },
  ];
```

  (remove the `as const` and keep the `.map` as is).
- signature: `export function SupportUsagePanel({ usage, error, hourBlock, hourBlockError }: { usage: SupportUsageDto | null; error?: string; hourBlock?: PortalHourBlockDto | null; hourBlockError?: string; })`.
- add, just above the `no_data` branch: 

```tsx
  const hourBlockSlot = (
    <>
      {hourBlockError && <div className="mb-8"><ErrorNotice>{hourBlockError}</ErrorNotice></div>}
      {hourBlock && <HourBlockCard hourBlock={hourBlock} />}
    </>
  );
```

- render `{hourBlockSlot}` directly after `<SectionHeading usage={usage} />` in **both** the `no_data` section and the main section (before `<Totals … />`).

`apps/portal/src/pages/tickets/index.astro`:

- frontmatter imports: change the `lib/server` import to `import { buildServerApiConfig, loadPortalBranding } from '../../lib/server';` and the `ticketsPage` import to `import { decideTicketsPage, hourBlockPanelState, shouldLoadHourBlock } from '../../lib/ticketsPage';`
- after the `Promise.all` and the 401 check on `response`/`usageResponse` (before `decideTicketsPage`), add:

```ts
// Block hours W04 (#4547): the "Support hours" card renders inside the Support
// usage panel. Fetched only when the MSP enabled it AND usage itself loaded
// (branding is memoised per request by the layout, so this is not a 2nd call).
const branding = await loadPortalBranding(Astro.request);
const hourBlockResponse = shouldLoadHourBlock(branding, usageResponse)
  ? await portalApi.getHourBlock(config)
  : null;
if (hourBlockResponse?.statusCode === 401) {
  return redirectToLoginAfter401(Astro);
}
const { hourBlock, hourBlockError } = hourBlockPanelState(hourBlockResponse);
```

- change `showSupportUsage` so a card-only failure still opens the section:

```ts
const showSupportUsage =
  !usageStrictlyDisabled &&
  (usageResponse.data !== undefined || usageResponse.error !== undefined);
```

  (unchanged — the card is inside the panel, which already renders whenever usage loads.)
- pass the props: `<SupportUsagePanel usage={usageResponse.data ?? null} error={usageResponse.error} hourBlock={hourBlock} hourBlockError={hourBlockError} />`

- [ ] **Step 6: Run portal tests, confirm PASS; typecheck**

```bash
cd apps/portal && npx vitest run \
  src/lib/ticketsPage.test.ts \
  src/components/portal/HourBlockCard.test.tsx \
  src/components/portal/SupportUsagePanel.test.tsx
cd apps/portal && npx astro check ; echo "astro check exit=$?"
```

Expected: 3 files green; `astro check exit=0`. If the portal has no `astro check` wiring locally, fall back to `cd apps/portal && npx tsc --noEmit -p .`.

- [ ] **Step 7: Commit**

```bash
git add apps/portal/src/lib/api.ts apps/portal/src/lib/ticketsPage.ts apps/portal/src/lib/ticketsPage.test.ts \
  apps/portal/src/components/portal/HourBlockCard.tsx apps/portal/src/components/portal/HourBlockCard.test.tsx \
  apps/portal/src/components/portal/SupportUsagePanel.tsx apps/portal/src/components/portal/SupportUsagePanel.test.tsx \
  apps/portal/src/pages/tickets/index.astro
git commit -m "feat(portal): Support hours card in the Support usage panel (#4547)

Read-only card with hours used, remaining, period and the contracted
overage rate, shown only when the org's Support hours flag is on.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Threshold alerts — `runHourBlockAlertSweep()`

**Files:**
- Modify: `apps/api/src/services/contractEvents.ts` (the `ContractEvent` type, lines 13-20)
- Modify: `apps/api/src/jobs/deliverableWorker.test.ts` (:158)
- Create: `apps/api/src/services/contractHourBlockAlerts.ts` + `contractHourBlockAlerts.test.ts`
- Modify: `apps/api/src/jobs/contractWorker.ts` (:143-146)
- Create: `apps/api/src/jobs/contractWorker.alerts.test.ts`
- Create: `apps/api/src/__tests__/integration/contractHourBlockAlerts.integration.test.ts`

**Interfaces:**

```ts
// contractEvents.ts — the type is ONE flat object (not a discriminated union), so
// "adding the variant" = one new literal in `type` + three optional fields.
type: ... | 'contract.hour_block_threshold';
contractLineId?: string;   // set on contract.hour_block_threshold
periodStart?: string;      // set on contract.hour_block_threshold
alertPct?: number;         // set on contract.hour_block_threshold

// contractHourBlockAlerts.ts
export function hasCrossedThreshold(consumedHours: number, openingHours: number, alertPct: number): boolean;
export interface HourBlockAlertSweepResult { lines: number; crossed: number; notified: number; errors: number }
export async function runHourBlockAlertSweep(asOf?: Date): Promise<HourBlockAlertSweepResult>;
```

**Design decisions:**

- **Recipients reuse `resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.CONTRACTS_READ)`** (`services/usersWithPermission.ts`), not `contractRenewal.ts`'s private `resolveMspRecipients` (:27-45): that one returns *every* active org user and every active partner user with org access, with **no permission filter**, which would notify staff who cannot open the contract. The permission resolver is wildcard-aware, filters `users.status='active'`, honours `partner_users.org_access`, and always escapes to a system read. Fallback: the contract's `created_by` if that user is still active.
- **`type: 'system'`** (spec §5). Verified allowed (`packages/shared/src/constants/notificationTypes.ts:2-14`; `'billing'` also exists since the autopay work and would suit equally — a one-word change if Todd prefers the billing filter).
- **Threshold test is exact integer-cent arithmetic**: `round(consumed×100)×100 ≥ pct × round(opening×100)`. Hours are 2-dp by construction (W02 `sumEntryHours`), so no float comparison ever decides a notification.
- **One transaction per line, event after commit.** Each line is evaluated and notified inside its own `runOutsideDbContext(() => withSystemDbAccessContext(...))`; a failure rolls back *that line's* notifications and the next line proceeds. The bus event is emitted **after** the line's transaction commits, and only when at least one notification row was newly created (so a retry sweep or a second recipient batch does not re-emit; `emitContractEvent` itself never throws).
- **Changing the threshold re-alerts once** (the pct is in the dedupe key): raising 80 → 90 mid-period while already past 90 notifies once for the new level. Documented, tested.
- **Dedupe key** is the spec's `hour_block:<lineId>:<periodStart>:<pct>`; uniqueness is per `(user_id, dedupe_key)` (partial unique index), so every recipient gets exactly one row per crossing.
- Notification `link` is the contract page `/contracts/<contractId>` (same-origin relative path, as `user_notifications` requires).

- [ ] **Step 1: Write the failing event-type test**

In `apps/api/src/jobs/deliverableWorker.test.ts` line 158 add `'contract.hour_block_threshold'` to the `for (const type of [...] as const)` list so the "ignores every other contract event type" test covers the new event (it fails to compile until the type has the literal).

- [ ] **Step 2: Write the failing sweep unit tests**

Create `apps/api/src/services/contractHourBlockAlerts.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// db: every builder method returns the chain; awaiting the chain pops the next queued result.
const { queue, whereArgs, ctx } = vi.hoisted(() => ({
  queue: [] as unknown[][],
  whereArgs: [] as unknown[],
  ctx: { systemEnters: 0 },
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'limit']) chain[m] = vi.fn(() => chain);
  chain.where = vi.fn((w: unknown) => { whereArgs.push(w); return chain; });
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(queue.shift() ?? []).then(resolve, reject);
  return {
    db: chain,
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => { ctx.systemEnters += 1; return fn(); }),
  };
});

const m = vi.hoisted(() => ({
  compute: vi.fn(), holders: vi.fn(), notify: vi.fn(), emit: vi.fn(), capture: vi.fn(),
}));
vi.mock('./contractHourBlockEstimate', () => ({ computeOpenHourBlockPeriod: m.compute }));
vi.mock('./usersWithPermission', () => ({ resolveUsersWithPermissionForOrg: m.holders }));
vi.mock('./userNotifications', () => ({ createNotification: m.notify }));
vi.mock('./contractEvents', () => ({ emitContractEvent: m.emit }));
vi.mock('./sentry', () => ({ captureException: m.capture }));
vi.mock('./permissions', () => ({ PERMISSIONS: { CONTRACTS_READ: { resource: 'contracts', action: 'read' } } }));

import { hasCrossedThreshold, runHourBlockAlertSweep } from './contractHourBlockAlerts';

const contract = (id: string, over: Record<string, unknown> = {}) => ({
  id, orgId: `org-${id}`, partnerId: 'p1', createdBy: 'creator-1', ...over,
});
const line = (id: string, pct: number | null = 80) => ({ id, hourBlockAlertPct: pct });
const est = (over: Record<string, unknown> = {}) => ({
  periodStart: '2026-12-01', periodEnd: '2027-01-01',
  includedHours: 10, carriedInHours: 0, consumedHours: 8, ...over,
});

describe('hasCrossedThreshold (exact integer-cent arithmetic)', () => {
  it.each([
    [8, 10, 80, true],        // exactly on the line
    [7.99, 10, 80, false],    // one cent short
    [10, 10, 100, true],
    [9.99, 10, 100, false],
    [9.6, 12, 80, true],      // opening includes 2 carried hours: 9.6 / 12 = 80%
    [9.59, 12, 80, false],
    [0, 10, 1, false],
    [25, 10, 100, true],      // far over the block
    [0.1 + 0.2, 1, 30, true], // 0.30000000000000004 must not flip the answer
    [5, 0, 50, false],        // a zero opening never alerts (division-free guard)
  ])('consumed %s of %s at %s%% -> %s', (consumed, opening, pct, expected) => {
    expect(hasCrossedThreshold(consumed, opening, pct)).toBe(expected);
  });
});

describe('runHourBlockAlertSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queue.length = 0;
    whereArgs.length = 0;
    ctx.systemEnters = 0;
    m.compute.mockResolvedValue(est());
    m.holders.mockResolvedValue(['u1']);
    m.notify.mockResolvedValue('notif-1');
    m.emit.mockResolvedValue(undefined);
  });

  it('selects only live, alert-configured blocks on active contracts of automation-eligible orgs (compiled SQL)', async () => {
    await runHourBlockAlertSweep(new Date('2026-12-20T12:00:00Z'));

    const q = new PgDialect().sqlToQuery(whereArgs[0] as SQL);
    expect(q.sql).toContain('"contract_lines"."line_type" = $');
    expect(q.sql).toContain('"contract_lines"."hour_block_retired_at" is null');
    expect(q.sql).toContain('"contract_lines"."hour_block_alert_pct" is not null');
    expect(q.sql).toContain('"contracts"."status" = $');
    expect(q.sql).toContain('automation_eligible_org.id = "contracts"."org_id"');
    expect(q.params).toEqual(expect.arrayContaining(['hour_block', 'active', 'active', 'trial']));
    expect(q.params).not.toContain('archived');
    expect(q.params).not.toContain('purging');
    expect(q.params).not.toContain('merging');
  });

  it('crossing -> one in-app notification with the spec fields, then ONE event after the line committed', async () => {
    queue.push([{ contract: contract('c1'), line: line('l1', 80) }], [{ name: 'Acme Dental' }]);
    const asOf = new Date('2026-12-20T12:00:00Z');

    const result = await runHourBlockAlertSweep(asOf);

    expect(m.compute).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), expect.objectContaining({ id: 'l1' }), asOf);
    expect(m.holders).toHaveBeenCalledWith('org-c1', { resource: 'contracts', action: 'read' });
    expect(m.notify).toHaveBeenCalledTimes(1);
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      orgId: 'org-c1',
      type: 'system',
      priority: 'high',
      link: '/contracts/c1',
      dedupeKey: 'hour_block:l1:2026-12-01:80',
      metadata: expect.objectContaining({ event: 'contract.hour_block_threshold', contractId: 'c1', contractLineId: 'l1', alertPct: 80 }),
    }));
    const call = m.notify.mock.calls[0]![0] as { title: string; message: string };
    expect(call.title).toContain('Acme Dental');
    expect(call.title.length).toBeLessThanOrEqual(255);
    expect(call.message).toContain('8 of 10');
    expect(call.message).toContain('2026-12-01');

    expect(m.emit).toHaveBeenCalledTimes(1);
    expect(m.emit).toHaveBeenCalledWith({
      type: 'contract.hour_block_threshold',
      contractId: 'c1', orgId: 'org-c1', partnerId: 'p1',
      contractLineId: 'l1', periodStart: '2026-12-01', alertPct: 80,
    });
    expect(result).toEqual({ lines: 1, crossed: 1, notified: 1, errors: 0 });
  });

  it('below the threshold: nothing is resolved, written or emitted', async () => {
    m.compute.mockResolvedValue(est({ consumedHours: 7.99 }));
    queue.push([{ contract: contract('c1'), line: line('l1', 80) }]);

    const result = await runHourBlockAlertSweep();

    expect(m.holders).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ lines: 1, crossed: 0, notified: 0 });
  });

  it('already notified (dedupe hit -> createNotification returns null): no event is re-emitted', async () => {
    m.notify.mockResolvedValue(null);
    queue.push([{ contract: contract('c1'), line: line('l1', 80) }], [{ name: 'Acme' }]);

    const result = await runHourBlockAlertSweep();

    expect(m.notify).toHaveBeenCalledTimes(1);
    expect(m.emit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ crossed: 1, notified: 0 });
  });

  it('notifies every permission holder, one row each', async () => {
    m.holders.mockResolvedValue(['u1', 'u2', 'u3']);
    m.notify.mockResolvedValueOnce('n1').mockResolvedValueOnce(null).mockResolvedValueOnce('n3');
    queue.push([{ contract: contract('c1'), line: line('l1') }], [{ name: 'Acme' }]);

    const result = await runHourBlockAlertSweep();

    expect(m.notify.mock.calls.map((c) => (c[0] as { userId: string }).userId)).toEqual(['u1', 'u2', 'u3']);
    expect(result.notified).toBe(2);
    expect(m.emit).toHaveBeenCalledTimes(1);
  });

  it("falls back to the contract's creator when nobody holds contracts:read", async () => {
    m.holders.mockResolvedValue([]);
    queue.push([{ contract: contract('c1'), line: line('l1') }], [{ id: 'creator-1' }], [{ name: 'Acme' }]);

    await runHourBlockAlertSweep();

    expect(m.notify).toHaveBeenCalledTimes(1);
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'creator-1' }));
  });

  it('no recipient at all: warns, writes nothing, emits nothing, does not count as an error', async () => {
    m.holders.mockResolvedValue([]);
    queue.push([{ contract: contract('c1', { createdBy: null }), line: line('l1') }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runHourBlockAlertSweep();
      expect(m.notify).not.toHaveBeenCalled();
      expect(m.emit).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      expect(result).toMatchObject({ crossed: 1, notified: 0, errors: 0 });
    } finally {
      warn.mockRestore();
    }
  });

  it('opens one system context per block line (+1 for the candidate read) so one failure cannot poison the rest', async () => {
    queue.push(
      [{ contract: contract('c1'), line: line('l1') }, { contract: contract('c2'), line: line('l2') }],
      [{ name: 'Beta' }],
    );
    m.compute.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(est());
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runHourBlockAlertSweep();

      expect(ctx.systemEnters).toBe(3);
      // line 1 failed, line 2 still notified.
      expect(m.notify).toHaveBeenCalledTimes(1);
      expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-c2' }));
      expect(m.capture).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ lines: 2, crossed: 1, notified: 1, errors: 1 });
    } finally {
      err.mockRestore();
    }
  });

  it('a changed threshold produces a different dedupe key (so it can alert once more)', async () => {
    queue.push([{ contract: contract('c1'), line: line('l1', 90) }], [{ name: 'Acme' }]);
    m.compute.mockResolvedValue(est({ consumedHours: 9.5 }));

    await runHourBlockAlertSweep();

    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'hour_block:l1:2026-12-01:90' }));
  });
});
```

- [ ] **Step 3: Write the failing worker-order test**

Create `apps/api/src/jobs/contractWorker.alerts.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
const { processorRef, alertMock, renewalMock, captureMock } = vi.hoisted(() => ({
  processorRef: { fn: undefined as undefined | ((job: { name: string }) => Promise<unknown>) },
  alertMock: vi.fn(),
  renewalMock: vi.fn(),
  captureMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Job: class {},
  Worker: class {
    constructor(_queue: string, processor: (job: { name: string }) => Promise<unknown>) {
      processorRef.fn = processor;
    }
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: captureMock }));
vi.mock('../services/contractService', () => ({ generateDueInvoice: vi.fn() }));
vi.mock('../services/invoiceService', () => ({ issueInvoice: vi.fn() }));
vi.mock('../services/invoicePdf', () => ({ sendInvoiceEmail: vi.fn() }));
vi.mock('../services/contractRenewal', () => ({ runContractRenewalSweep: renewalMock }));
vi.mock('../services/contractHourBlockAlerts', () => ({ runHourBlockAlertSweep: alertMock }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const mth of ['select', 'from']) chain[mth] = vi.fn(() => chain);
  chain.where = vi.fn(() => { order.push('billing'); return chain; });
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { createContractWorker } from './contractWorker';

describe('contract billing-sweep job ordering (block hours W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    renewalMock.mockImplementation(async () => { order.push('renewal'); });
    alertMock.mockImplementation(async () => { order.push('alerts'); });
    createContractWorker();
  });

  it('runs renewal, then threshold alerts, then billing', async () => {
    await processorRef.fn!({ name: 'billing-sweep' });
    expect(order.slice(0, 3)).toEqual(['renewal', 'alerts', 'billing']);
  });

  it('an alert-sweep failure is reported but never blocks billing', async () => {
    alertMock.mockRejectedValueOnce(new Error('alerts down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await processorRef.fn!({ name: 'billing-sweep' });
      expect(order).toContain('billing');
      expect(captureMock).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });
});
```

- [ ] **Step 4: Write the failing real-DB test**

Create `apps/api/src/__tests__/integration/contractHourBlockAlerts.integration.test.ts`:

```ts
import './setup';
import { vi } from 'vitest';
// contract-events is a BullMQ side effect; mock it so the suite needs no Redis queue.
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { contractLines, userNotifications } from '../../db/schema';
import { emitContractEvent } from '../../services/contractEvents';
import { runHourBlockAlertSweep } from '../../services/contractHourBlockAlerts';
import { assignUserToPartner, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { seedBlockOrg } from './hourBlockFixtures';
import { getTestDb } from './setup';

const AS_OF = new Date('2026-12-20T12:00:00Z');
const OVER_80 = [{ minutes: 300 }, { minutes: 210 }]; // 8.5 h of a 10 h block

async function seedStaff() {
  const partner = await createPartner();
  const technician = await createUser({ partnerId: partner.id, orgId: null });
  const staff = await createUser({ partnerId: partner.id, orgId: null, email: `staff-${partner.id}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, [{ resource: 'contracts', action: 'read' }]);
  await assignUserToPartner(staff.id, partner.id, role.id, 'all');
  return { partnerId: partner.id, technicianId: technician.id, staffId: staff.id };
}

async function notificationsFor(userId: string) {
  return getTestDb().select().from(userNotifications).where(eq(userNotifications.userId, userId));
}

describe('runHourBlockAlertSweep (real DB)', () => {
  beforeEach(() => vi.mocked(emitContractEvent).mockClear());

  it('crosses once -> one notification and one event; a second sweep in the same period writes nothing', async () => {
    const s = await seedStaff();
    const org = await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: OVER_80 });

    const first = await runHourBlockAlertSweep(AS_OF);
    expect(first).toMatchObject({ lines: 1, crossed: 1, notified: 1, errors: 0 });

    const rows = await notificationsFor(s.staffId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'system', priority: 'high', orgId: org.orgId,
      link: `/contracts/${org.contractId}`,
      dedupeKey: `hour_block:${org.lineId}:2026-12-01:80`,
    });
    expect(emitContractEvent).toHaveBeenCalledTimes(1);
    expect(emitContractEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'contract.hour_block_threshold', contractId: org.contractId, contractLineId: org.lineId,
      periodStart: '2026-12-01', alertPct: 80,
    }));

    // Real partial-index arbiter: a second sweep must be a silent no-op (a
    // missing ON CONFLICT predicate only fails against a real database).
    const second = await runHourBlockAlertSweep(AS_OF);
    expect(second).toMatchObject({ crossed: 1, notified: 0, errors: 0 });
    expect(await notificationsFor(s.staffId)).toHaveLength(1);
    expect(emitContractEvent).toHaveBeenCalledTimes(1);
  });

  it('does nothing below the threshold, with a NULL alert pct, on a retired line, or on a non-active contract', async () => {
    const s = await seedStaff();
    await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: [{ minutes: 420 }] });               // 7.0 h < 80%
    await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: OVER_80, alertPct: null });         // alerts off
    await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: OVER_80, retired: true });          // retired
    await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: OVER_80, contractStatus: 'paused' });

    const result = await runHourBlockAlertSweep(AS_OF);

    expect(result.notified).toBe(0);
    expect(await notificationsFor(s.staffId)).toHaveLength(0);
    expect(emitContractEvent).not.toHaveBeenCalled();
  });

  it('skips an archived tenant (the same automation-eligibility predicate as billing and renewal)', async () => {
    const s = await seedStaff();
    await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: OVER_80, archived: true });

    const result = await runHourBlockAlertSweep(AS_OF);

    expect(result.lines).toBe(0);
    expect(await notificationsFor(s.staffId)).toHaveLength(0);
  });

  it('changing the threshold mid-period alerts once more for the new level, and only once', async () => {
    const s = await seedStaff();
    const org = await seedBlockOrg({
      partnerId: s.partnerId, technicianId: s.technicianId,
      entries: [{ minutes: 300 }, { minutes: 270 }], // 9.5 h
    });
    await runHourBlockAlertSweep(AS_OF);                       // 80% key
    await getTestDb().update(contractLines).set({ hourBlockAlertPct: 90 }).where(eq(contractLines.id, org.lineId));

    await runHourBlockAlertSweep(AS_OF);                       // 90% key (9.5 >= 9.0)
    await runHourBlockAlertSweep(AS_OF);                       // no new key

    const keys = (await notificationsFor(s.staffId)).map((r) => r.dedupeKey).sort();
    expect(keys).toEqual([
      `hour_block:${org.lineId}:2026-12-01:80`,
      `hour_block:${org.lineId}:2026-12-01:90`,
    ]);
  });

  it("falls back to the contract's creator when no partner staff hold contracts:read", async () => {
    const partner = await createPartner();
    const technician = await createUser({ partnerId: partner.id, orgId: null });
    const creator = await createUser({ partnerId: partner.id, orgId: null, email: `creator-${partner.id}@example.test` });
    const org = await seedBlockOrg({
      partnerId: partner.id, technicianId: technician.id, entries: OVER_80, createdBy: creator.id,
    });

    await runHourBlockAlertSweep(AS_OF);

    const rows = await getTestDb().select().from(userNotifications)
      .where(and(eq(userNotifications.userId, creator.id), eq(userNotifications.orgId, org.orgId)));
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Run, confirm FAIL**

```bash
cd apps/api && npx vitest run \
  src/services/contractHourBlockAlerts.test.ts \
  src/jobs/contractWorker.alerts.test.ts \
  src/jobs/deliverableWorker.test.ts
```

Expected FAIL: `Cannot find module './contractHourBlockAlerts'` (both the service test and the worker test's `vi.mock` target is unresolved), and a TypeScript/vitest type error for `'contract.hour_block_threshold'` in `deliverableWorker.test.ts`. The integration file fails the same way; run it after Step 7.

- [ ] **Step 6: Implement the event variant**

`apps/api/src/services/contractEvents.ts`, replace the `ContractEvent` type:

```ts
export type ContractEvent = {
  type: 'contract.activated' | 'contract.invoiced' | 'contract.paused' | 'contract.cancelled' | 'contract.expired' | 'contract.auto_renewed' | 'contract.renewal_notice' | 'contract.hour_block_threshold';
  contractId: string;
  orgId: string;
  partnerId: string;
  invoiceId?: string;    // set on contract.invoiced
  actorUserId?: string;
  contractLineId?: string; // set on contract.hour_block_threshold (#4547 W04)
  periodStart?: string;    // set on contract.hour_block_threshold: the OPEN period's start (YYYY-MM-DD)
  alertPct?: number;       // set on contract.hour_block_threshold: the configured threshold that was crossed
};
```

(The only consumer, `deliverableWorker.ts:151`, acts on `contract.cancelled` and ignores every other `type`; there is no exhaustive switch over this type.)

- [ ] **Step 7: Implement the sweep and wire it into the job**

Create `apps/api/src/services/contractHourBlockAlerts.ts`:

```ts
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { contractLines, contracts, organizations, users } from '../db/schema';
import { computeOpenHourBlockPeriod } from './contractHourBlockEstimate'; // W03 — index C7
import { emitContractEvent } from './contractEvents';
import { PERMISSIONS } from './permissions';
import { captureException } from './sentry';
import { buildAutomationEligibleOrgPredicate } from './tenantStatus';
import { createNotification } from './userNotifications';
import { resolveUsersWithPermissionForOrg } from './usersWithPermission';

type ContractRow = typeof contracts.$inferSelect;
type LineRow = typeof contractLines.$inferSelect;

export interface HourBlockAlertSweepResult {
  lines: number;
  crossed: number;
  notified: number;
  errors: number;
}

/**
 * Has `consumed` reached `alertPct` percent of `opening` hours?
 *
 * Hours are 2-dp by construction (W02 sums rounded-each-then-added), so compare
 * in integer cents: round(consumed*100)*100 >= pct * round(opening*100). No float
 * comparison ever decides whether a person is notified.
 */
export function hasCrossedThreshold(consumedHours: number, openingHours: number, alertPct: number): boolean {
  const consumed = Math.round(consumedHours * 100);
  const opening = Math.round(openingHours * 100);
  if (opening <= 0) return false;
  return consumed * 100 >= alertPct * opening;
}

const hoursText = (n: number): string => String(Number(n.toFixed(2)));

async function resolveRecipients(contract: ContractRow): Promise<string[]> {
  // contracts:read holders of the owning partner with access to THIS org (plus
  // org members whose role grants it). Deliberately NOT contractRenewal's
  // private resolveMspRecipients, which has no permission filter.
  const holders = await resolveUsersWithPermissionForOrg(contract.orgId, PERMISSIONS.CONTRACTS_READ);
  if (holders.length > 0) return holders;
  if (!contract.createdBy) return [];
  const [creator] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, contract.createdBy), eq(users.status, 'active')))
    .limit(1);
  return creator ? [creator.id] : [];
}

interface LineOutcome {
  crossed: boolean;
  created: number;
  periodStart: string;
  alertPct: number;
}

/** One block line, inside the caller's per-line system transaction. */
async function evaluateLine(contract: ContractRow, line: LineRow, asOf: Date): Promise<LineOutcome> {
  const alertPct = line.hourBlockAlertPct as number; // the candidate query guarantees non-null
  const estimate = await computeOpenHourBlockPeriod(contract, line, asOf);
  const opening = estimate.includedHours + estimate.carriedInHours;
  const base = { created: 0, periodStart: estimate.periodStart, alertPct };

  if (!hasCrossedThreshold(estimate.consumedHours, opening, alertPct)) {
    return { crossed: false, ...base };
  }

  const recipients = await resolveRecipients(contract);
  if (recipients.length === 0) {
    console.warn(
      '[HourBlockAlerts] threshold crossed but nobody to notify: contract=%s org=%s line=%s',
      contract.id, contract.orgId, line.id,
    );
    return { crossed: true, ...base };
  }

  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, contract.orgId))
    .limit(1);
  const orgName = Array.from((org?.name ?? 'a customer').replace(/[\r\n]+/g, ' ')).slice(0, 120).join('');
  const usedPct = Math.floor((Math.round(estimate.consumedHours * 100) * 100) / Math.max(1, Math.round(opening * 100)));
  const title = `Block hours ${usedPct}% used: ${orgName}`;
  const message =
    `${orgName}: ${hoursText(estimate.consumedHours)} of ${hoursText(opening)} block hours used ` +
    `for ${estimate.periodStart} – ${estimate.periodEnd} (alert threshold ${alertPct}%).`;
  const dedupeKey = `hour_block:${line.id}:${estimate.periodStart}:${alertPct}`;

  let created = 0;
  for (const userId of recipients) {
    const id = await createNotification({
      userId,
      orgId: contract.orgId,
      type: 'system',
      priority: 'high',
      title,
      message,
      link: `/contracts/${contract.id}`,
      metadata: {
        event: 'contract.hour_block_threshold',
        contractId: contract.id,
        contractLineId: line.id,
        periodStart: estimate.periodStart,
        alertPct,
      },
      dedupeKey,
    });
    if (id) created++;
  }
  return { crossed: true, ...base, created };
}

/**
 * Threshold alerts for live block lines (#4547 W04). Runs in the contract
 * billing-sweep job BEFORE runContractBillingSweep (so a period about to close
 * is judged on the hours it still holds).
 *
 * Candidates: a live (non-retired) hour_block line with a non-NULL alert pct on
 * an ACTIVE contract of an automation-eligible org — the same archived/purging/
 * merging gate as the billing and renewal sweeps.
 *
 * ONE system transaction per line: a failed statement poisons every later
 * statement in a transaction, so a try/catch inside a shared context would not
 * isolate failures. (Same shape as runContractBillingSweep.) The bus event is
 * emitted after the line's transaction commits, only when a notification row
 * was newly written — a repeat sweep is silent.
 */
export async function runHourBlockAlertSweep(asOf: Date = new Date()): Promise<HourBlockAlertSweepResult> {
  const candidates = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ contract: contracts, line: contractLines })
        .from(contractLines)
        .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
        .where(
          and(
            eq(contractLines.lineType, 'hour_block'),
            isNull(contractLines.hourBlockRetiredAt),
            isNotNull(contractLines.hourBlockAlertPct),
            eq(contracts.status, 'active'),
            buildAutomationEligibleOrgPredicate(contracts.orgId),
          ),
        ),
    ),
  );

  const result: HourBlockAlertSweepResult = { lines: candidates.length, crossed: 0, notified: 0, errors: 0 };

  for (const { contract, line } of candidates) {
    try {
      const outcome = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() => evaluateLine(contract, line, asOf)),
      );
      if (!outcome.crossed) continue;
      result.crossed++;
      result.notified += outcome.created;
      if (outcome.created > 0) {
        await emitContractEvent({
          type: 'contract.hour_block_threshold',
          contractId: contract.id,
          orgId: contract.orgId,
          partnerId: contract.partnerId,
          contractLineId: line.id,
          periodStart: outcome.periodStart,
          alertPct: outcome.alertPct,
        });
      }
    } catch (err) {
      result.errors++;
      console.error(
        '[HourBlockAlerts] line failed',
        `contractId=${contract.id}`,
        `lineId=${line.id}`,
        err instanceof Error ? err.message : err,
      );
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return result;
}
```

In `apps/api/src/jobs/contractWorker.ts`:

- add `import { runHourBlockAlertSweep } from '../services/contractHourBlockAlerts';` after the `runContractRenewalSweep` import (line 18).
- replace the `billing-sweep` body (lines 143-146) with:

```ts
      if (job.name === 'billing-sweep') {
        // Renewal pre-pass MUST run before billing so an about-to-expire auto-renew
        // contract has its term extended before generateDueInvoice decides expiry.
        await runOutsideDbContext(() => withSystemDbAccessContext(() => runContractRenewalSweep()));
        // #4547 W04: block-hours threshold alerts, BEFORE billing so a period that
        // is about to close is judged on the hours it still holds. The sweep opens
        // its own per-line system contexts; a failure here is reported but must
        // never stop a customer from being billed.
        try {
          await runHourBlockAlertSweep();
        } catch (err) {
          console.error('[ContractWorker] hour-block alert sweep failed', err instanceof Error ? err.message : err);
          captureException(err instanceof Error ? err : new Error(String(err)));
        }
        return runContractBillingSweep();
      }
```

(W02 also edits this branch to run `runHourBlockCloseOutSweep` after the billing sweep. Anchor on the `await runContractRenewalSweep` line and the `runContractBillingSweep()` call; keep both W02's and this wave's lines. The ordering this wave owns is renewal → alerts → billing.)

- [ ] **Step 8: Run unit tests, confirm PASS; run the integration suite; typecheck**

```bash
cd apps/api && npx vitest run \
  src/services/contractHourBlockAlerts.test.ts \
  src/jobs/contractWorker.alerts.test.ts \
  src/jobs/contractWorker.test.ts \
  src/jobs/deliverableWorker.test.ts \
  src/services/contractRenewal.sweepScope.test.ts
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/contractHourBlockAlerts.integration.test.ts \
  src/jobs/contractWorker.renewal.integration.test.ts
NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo "tsc exit=$?"
```

Expected: 5 unit files green (confirm the file count), integration green, `tsc exit=0`. Re-run `contractWorker.renewal.integration.test.ts` to prove the renewal → billing order is unchanged. If the integration alert suite fails at `createNotification` with `42P10`, the `ON CONFLICT` predicate was dropped — that is the trap the real-DB test exists for.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/contractEvents.ts apps/api/src/jobs/deliverableWorker.test.ts \
  apps/api/src/services/contractHourBlockAlerts.ts apps/api/src/services/contractHourBlockAlerts.test.ts \
  apps/api/src/jobs/contractWorker.ts apps/api/src/jobs/contractWorker.alerts.test.ts \
  apps/api/src/__tests__/integration/contractHourBlockAlerts.integration.test.ts
git commit -m "feat(contracts): block-hours threshold alerts in the billing sweep job (#4547)

Notifies contract readers once per crossing (deduped per user, period and
threshold) and emits contract.hour_block_threshold. Runs before billing, one
transaction per block line, behind the same tenant-status gate as the other
contract sweeps.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Documentation

**Files:**
- Modify: `apps/docs/src/content/docs/features/contracts.mdx`
- Modify: `apps/docs/src/content/docs/features/portal.mdx`
- Release notes: **not in this repo.** They live on the marketing site and are written by the `update-breeze-release-notes` skill (it builds in a separate site repo) from merged PRs at release time. W04 therefore adds **no** release-notes file; the PR body carries the "what changed" list the release skill will read. State this in the PR ("release notes handled by the release skill at cut time").

**Docs have no unit-test harness; the red step is a content assertion, the green step is the docs gate** (`astro check` + `astro build`, the PII guard, and the docs-automation guard — exactly the CI `docs-check` job).

- [ ] **Step 1: Write the failing content assertion**

Create the assertion as a throwaway shell check (do not commit it):

```bash
cat > /tmp/w04-docs-assert.sh <<'EOF'
set -u
c=apps/docs/src/content/docs/features/contracts.mdx
p=apps/docs/src/content/docs/features/portal.mdx
fail=0
need() { grep -qF -- "$2" "$1" || { echo "MISSING in $1: $2"; fail=1; }; }
need $c '| Block hours |'
need $c '### Block hours'
need $c 'one period behind'
need $c 'Retire or delete'
need $c 'entered after a period closed'
need $c 'HOUR_BLOCK_DRAWN_TIME'
need $p '| **Support hours** |'
need $p '### Support hours (block hours)'
need $p '/support-usage/hour-block'
exit $fail
EOF
bash /tmp/w04-docs-assert.sh; echo "assert exit=$?"
```

Expected FAIL: `assert exit=1` with every line reported missing.

- [ ] **Step 2: Edit `contracts.mdx`**

1. In the Contract Lines table, add this row after the `Per seat` row:

```mdx
| Block hours | A prepaid bank of support hours for each billing period at a flat price. Technician time draws it down; hours beyond it bill at an overage rate. See [Block hours](#block-hours) |
```

2. In "Included quantity and overage", change `An included quantity must be a whole number greater than zero, and cannot go on a flat or manual line.` to `An included quantity must be a whole number greater than zero (a Block hours line takes fractional hours), and cannot go on a flat or manual line.`

3. Insert this section immediately **before** `## Managing the Lifecycle`:

```mdx
### Block hours

A **Block hours** line sells a prepaid bank of support hours for each billing period -- for example "10 hours a month for a flat price". Your technicians' time draws the bank down, and hours beyond it bill at an overage rate you set on the line.

| Setting | Meaning |
|---------|---------|
| Included hours | Hours in the block each period. Fractions are allowed (for example 7.5) |
| Overage rate | Price per hour beyond the block, in the contract's currency. Required, and overage is always billed on an invoice |
| Rollover | **None**: unused hours expire when the period ends. **Carry forward**: unused hours join the next period, optionally capped at a number of hours |
| Alert at | Optional percentage (1 to 100). Your team is notified once when the open period's usage reaches it |

A customer can have **one live block at a time**, across all of their contracts, drafts included. To draft next term's contract with a block, retire the current block first.

**What draws the block down.** Billable time entries for the customer that have ended inside the period and have not been billed yet. Approval is not required, so unapproved time draws down too (the contract page shows how much of the used hours is still unapproved). Each entry's hours are rounded to two decimals and then added, so three 20-minute entries count as 0.99 hours. Non-billable and no-charge time never draws down, and time with no hourly rate still does, because the unit is hours. Time already marked as included by its work type does not draw the block down. Time stamped in a different currency than the contract still draws hours -- no money is converted -- and is flagged on the contract page.

**When a period closes.** After a period has ended, the next invoice run closes it: the entries it drew are marked as covered by the contract, the period's figures are frozen, and any overage is added to the invoice as a line that names the period, for example "Support hours -- hours over block, 2026-08-01 -- 2026-09-01". A closed period is never recalculated. Once an entry has been drawn by a block it can no longer be edited or deleted.

**Advance billing runs one period behind.** On a contract billed in advance, the block fee is invoiced at the start of the period, but that period's overage lands on the *following* invoice, because the hours had not been worked when the first invoice was cut. On a contract billed in arrears the fee and the overage appear together on the same invoice.

**Rollover.** Unused hours (the period's included hours plus anything carried in, minus the hours used) carry forward under **Carry forward**, up to the cap if you set one. Carried hours do not expire separately, and the first period of a block carries nothing in.

**Held entries on ad-hoc invoices.** While a period is open, the time it will draw is reserved for the block. A hand-built invoice or a ticket invoice leaves those entries out and reports how many hours were held, so the customer is not charged ad hoc for hours the block already covers.

**Entries made after a period closed.** A closed period never reopens. Time that was entered for work done in a period that has already closed is not drawn from the block; it bills ad hoc as usual, and the contract page shows how many hours were entered after close.

**Retire or delete.** Removing a block line that has closed periods (or a claimed period) *retires* it instead of deleting it: it stops billing its fee, keeps its history, and any period it had already billed still closes. A block that never billed anything is simply deleted. Cancelling or expiring a contract retires its block. When a contract ends, the final period is closed by a daily sweep and any overage is put on a **draft** invoice that is never issued automatically, so someone reviews it first.

**Moving time between customers.** Moving a ticket or a device to another organization is refused (`HOUR_BLOCK_DRAWN_TIME`) while it holds time a block has already drawn. The message names how many entries are affected.

**Alerts.** With **Alert at** set, your team gets an in-app notification the first time the open period's usage reaches the percentage -- once per period and threshold, however many times the daily check runs. Recipients are the users who can read contracts and have access to the customer, or the contract's creator if none do. Changing the percentage mid-period can notify once more for the new level.

**Customer visibility.** The customer can see their balance in the portal. See [Support hours](/features/portal/#support-hours-block-hours).
```

- [ ] **Step 3: Edit `portal.mdx`**

1. In the visibility table (after the `Support usage` row at line 51) add:

```mdx
| **Support hours** | Off | A read-only card inside the Support section showing prepaid block hours used and remaining. Requires **Support usage**. Not turned on by **Enable all visibility** -- switch it on per customer |
```

2. Add this subsection directly after the "SLA badges and support usage" section (before `### External Ticket Integration`):

```mdx
### Support hours (block hours)

If a customer has a [Block hours](/features/contracts/#block-hours) line on an active contract, you can show them their balance. Turn on **Support hours** in the customer's portal visibility settings (it needs **Support usage** on as well, and **Enable all visibility** deliberately leaves it off). The card appears above the support-time table and shows:

- hours used against the block (the included hours plus anything carried over), the hours remaining, or the hours over the block;
- the current billing period; and
- the contracted overage rate and when an overage would be billed.

It does not show a calculated overage amount, only hours and the rate from the contract. Time that has not been approved yet counts toward the hours used, matching how the block is drawn down. While the setting is on, support time the block covers is listed under **Covered by your support hours** instead of **To be billed**; with it off, the page reads exactly as before and the customer is never told a block exists. A paused, draft or ended contract, or a retired block, shows no card.
```

3. In the Tickets endpoint table (after the `/tickets/usage` row, line 449) add a row to the same table:

```mdx
| `GET` | `/support-usage/hour-block` | Yes | The live block-hours balance for the organization, or `null`. Requires **Support usage** and **Support hours** visibility |
```

- [ ] **Step 4: Run the assertion (green) and the docs gate**

```bash
bash /tmp/w04-docs-assert.sh; echo "assert exit=$?"
pnpm test:docs-automation
bash scripts/security/check-customer-pii.sh
pnpm --filter @breeze/docs check ; echo "docs check exit=$?"
pnpm --filter @breeze/docs build ; echo "docs build exit=$?"
rm /tmp/w04-docs-assert.sh
```

Expected: `assert exit=0`, the two guards exit 0, `docs check exit=0`, `docs build exit=0`. If the Starlight anchor check fails, the heading anchors are `#block-hours` and `#support-hours-block-hours` (Starlight slugifies `Support hours (block hours)` to `support-hours-block-hours`).

- [ ] **Step 5: Commit**

```bash
git add apps/docs/src/content/docs/features/contracts.mdx apps/docs/src/content/docs/features/portal.mdx
git commit -m "docs: block hours on contracts and the Support hours portal card (#4547)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Whole-wave verification and PR

**Files:** none (verification, then the PR).

- [ ] **Step 1: Mechanical gates (cheap models first — contract tests catch what review does not)**

```bash
# unit suites for every file this wave touched (list explicitly; substring filters lie)
cd apps/api && npx vitest run \
  src/db/portalBrandingHourBlock.migration.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts \
  src/services/tenantExportPolicyRegistry.portalBranding.test.ts \
  src/routes/portal/featureFlags.test.ts src/routes/portal/branding.test.ts src/routes/portal/hourBlock.test.ts src/routes/portal/tickets.test.ts \
  src/routes/portal.test.ts src/routes/orgPortalSettings.test.ts \
  src/services/portal/portalFlags.test.ts src/services/portal/hourBlock.test.ts src/services/portal/hourBlockWindows.test.ts src/services/portal/supportUsage.test.ts \
  src/services/contractHourBlockAlerts.test.ts src/services/contractRenewal.sweepScope.test.ts \
  src/jobs/contractWorker.test.ts src/jobs/contractWorker.alerts.test.ts src/jobs/deliverableWorker.test.ts
cd ../../packages/shared && npx vitest run src/validators/portal.test.ts src/types/portalVisibility.test.ts && npx tsc --noEmit
cd ../../apps/web && npx vitest run src/components/settings/OrgPortalSettingsEditor.test.tsx src/lib/i18n/localeParity.test.ts
cd ../portal && npx vitest run src/lib/ticketsPage.test.ts src/components/portal/HourBlockCard.test.tsx src/components/portal/SupportUsagePanel.test.tsx
cd ../.. && pnpm db:check-drift
```

- [ ] **Step 2: Contract and integration suites (this wave touches `portal_branding`, so the export-policy suites are mandatory; no cascade list changes)**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/portalBrandingHourBlock.integration.test.ts \
  src/__tests__/integration/portalHourBlock.integration.test.ts \
  src/__tests__/integration/portalSupportUsageHourBlock.integration.test.ts \
  src/__tests__/integration/contractHourBlockAlerts.integration.test.ts \
  src/__tests__/integration/portalVisibilityRls.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMerge.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/jobs/contractWorker.renewal.integration.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo "api tsc exit=$?"
cd ../web && npx tsc --noEmit -p . ; echo "web tsc exit=$?"
cd ../portal && npx astro check ; echo "portal check exit=$?"
```

Then **tear the stack down** (nothing reaps it): `pnpm test-stack down`, and say in the PR what, if anything, was left running.

- [ ] **Step 3: Manual check as `breeze_app` (RLS sanity for the one column)**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "SELECT enable_hour_block FROM portal_branding LIMIT 1;"
```

Expected: a row or zero rows under no tenant context (RLS), never an error about a missing column. (No cross-org forge is needed: no policy changed.)

- [ ] **Step 4: Open the PR (feature-lifecycle)**

`get_feature_status` for #4547, branch `feature/4547-block-hours/wave-<W04 sub-issue#>`, `start_wave`; PR body includes `Closes #<W04 sub-issue>` and these required statements:

- **Settings rule 9 (verbatim from index Open Decision 12):** home = Org → Portal settings (`OrgPortalSettingsEditor.tsx`), level = org, resolver = `portal_branding` row via `orgPortalSettings.ts`, places configured 0 → 1.
- Locale review lines (machine-drafted catalogs, `apps/web/src/locales/README.md`): `pt-BR strings are machine-drafted pending native review` and `es-419, fr-FR, fr-CA, de-DE, and it-IT strings are machine-drafted pending native review`. (`tr-TR` follows the same draft process.)
- "No new tenant table: only the `portal_branding` export-policy row changed; no cascade/merge/device lists are affected."
- "Release notes handled by the release skill at cut time (they live on the marketing site)."
- Verification done: the commands above, with exit codes. Run `/pr-review-toolkit:review-pr` once; act only on confirmed, consequential findings (the portal read path and the sweep are the review surfaces; the money path is untouched). Neutral PR wording; **scrub the PR body before enqueue** (the merge queue freezes the squash message at enqueue). Merge with `gh pr merge <N>` (no strategy flag, never `--admin`).

---

## Self-review

**Spec coverage.**
- §5 Portal: card (Tasks 2, 5), `enable_hour_block` default false (Task 1), route behind a fail-closed gate (Tasks 1-2), system-context handler scoped to `auth.user.orgId` (Task 2, Review Focus 1-2). The spec says `createPortalFeatureGate`; this plan deliberately uses the *strict* gate because the non-strict one fails open on a missing row (listed under contradictions below).
- §5 Threshold alert: sweep before `runContractBillingSweep` (Task 6), same `buildAutomationEligibleOrgPredicate` gate (Task 6, compiled-SQL test), `type: 'system'`, `priority: 'high'`, spec dedupe key, `contract.hour_block_threshold` event, recipients with `contracts:read` falling back to `created_by` (Task 6).
- §6 Docs: Contract Lines row + drawdown / rollover / advance lag / retire vs delete / held entries / late entries / org-move refusal (Task 7); portal docs; release notes handed to the release skill (out of repo).
- Index: C1 W04 migration name (exact), C5 W04 export row (Task 1), C7 `contractWorker` row (Task 6), C8 `HourBlockEstimate` (consumed, not re-typed), C10 `PORTAL_HOUR_BLOCK_DISABLED` (403, Task 1), Open Decision 12 default and the rule-9 statement (Task 8). Nothing in the index is renamed or re-typed.
- Open scope the prompt listed and where it landed: `coveredByContract` / "to be billed" handling → Task 3 (decision table + code + tests); portal i18n → English literals, no portal i18n layer exists (Global Constraints).

**Placeholder scan.** No TBDs. Two honest dependencies are named, not hidden: the W03 helper and W02 `hourBlockHoldWindows` ("Assumes" table), each imported at one line and mocked at one path.

**Type consistency.** `StrictPortalGateFlag` (Task 1) is what `createPortalFeatureGateStrict('enableHourBlock')` in Task 2 requires. `PortalHourBlockDto` / `PortalHourBlockResponse` (Task 2) are the types Tasks 5's `getHourBlock` and `hourBlockPanelState` use. `SupportUsageDto.totals.coveredByBlock` / `SupportUsageTicketDto.coveredByBlockMinutes` are optional so `SupportUsageDto` consumers and the pre-existing exact-`toEqual` tests keep compiling. `ContractEvent` gains three optional fields, matching the event the sweep emits. `HourBlockEstimate` fields used: `periodStart`, `periodEnd`, `includedHours`, `carriedInHours`, `consumedHours`, `remainingHours`, `overageHours`, `overageUnitPrice`, `billingTiming` — all in C8.

**Known risks the implementer should watch.**
1. `supportUsage.test.ts` mocks a single-statement chain; the coverage read was therefore split into `hourBlockCoverage.ts` and mocked. If a future change adds a second `db.select` inside `supportUsageForOrg`, that mock chain breaks.
2. `contractWorker.ts` is edited by W02 as well (close-out sweep after billing). Both waves anchor on the `runContractRenewalSweep` / `runContractBillingSweep()` lines; resolve in favour of renewal → alerts → billing → close-out.
3. The portal tickets page memoises branding per request (`loadPortalBranding`), so reading it in `index.astro` is not an extra API call.
4. `hourBlockHoldWindows` may return windows for a *retired* line's pre-retirement period; Task 3 treats whatever W02 returns as authoritative, which is the point of reusing it.

**Contradictions between the current code and the index/spec/brief** (also returned to the orchestrator):
- `featureFlags.ts:15,27,40`: `createPortalFeatureGate` / `PortalBooleanSetting` fail OPEN on a missing row (`row?.[setting] === false`), but the spec and the brief require a fail-closed gate; used `createPortalFeatureGateStrict` (`:118`, `:131`) instead, with its flag type widened (`:10`).
- `packages/shared/src/validators/portal.ts:95-120`: `updatePortalSettingsSchema` is `.strict()`, so the PATCH needs `enableHourBlock` added there or it 400s; the brief lists only `orgPortalSettings.ts` and the editor.
- `routes/portal/index.ts:75-98`: `/tickets/*` carries the `enable_tickets` gate (Support usage opts out of it via two exact-path wrappers), so the endpoint cannot live under `/tickets`; it is `/support-usage/hour-block`.
- `routes/portal/branding.ts:116-120`: the authenticated branding projection omits `enableNetworkAlerts` (its precedent flag is read inline by the route), so the portal client would never see `enableHourBlock` without a new projection entry; added.
- `services/contractRenewal.ts:27-45`: the "existing recipient helper" is private and applies no permission filter (all active org users + all partner users with org access); not reusable for `contracts:read`. Used `usersWithPermission.ts:67` `resolveUsersWithPermissionForOrg`.
- Spec §5 `type: 'system'` is valid, but `'billing'` also exists (`packages/shared/src/constants/notificationTypes.ts:2-14`, added by the autopay work); kept `'system'`, flagged as a one-word option.
- `portalVisibilityRls.integration.test.ts` has no `portal_branding` column list; the lists to update are in `tenant-export-policy.integration.test.ts:62-76`, `tenantExportErasureRoundtrip.integration.test.ts:262-270` and `:516-529`, plus the unit `tenantExportPolicyRegistry.portalBranding.test.ts`.
- `ContractEvent` (`contractEvents.ts:13-20`) is one flat object type, not a discriminated union; "adding the variant" is a literal plus optional fields, and the only consumer (`deliverableWorker.ts:151`) ignores everything but `contract.cancelled`.
- `apps/portal` has no locales or i18n layer; the portal card's strings are English literals like every other portal component.
- Release notes are not in this repo (marketing-site, written by the release skill).
