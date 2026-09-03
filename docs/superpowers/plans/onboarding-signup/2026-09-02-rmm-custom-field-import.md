---
tracking_issue: LanternOps/breeze#4768
---

# Importing Custom Fields From Another RMM — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP migrating off Datto RMM / ConnectWise Automate / NinjaOne / N-central bulk-import their incumbent's custom-field *definitions* and then backfill those fields' *values* onto enrolled Breeze devices, through a preview→commit pipeline that never guesses which device a row belongs to.

**Architecture:** Two passes with two route pairs — definitions (dual-axis config, partner-wide first) and values (org-scoped, device-scoped). CSV is parsed in the browser (`apps/web/src/lib/csvParse.ts`) and posted as canonical JSON rows, so the API keeps zero CSV dependencies. Before any importer ships, the destination is hardened: `custom_field_definitions` gains uniqueness + an XOR + an anti-shadowing rule, values move out of the `devices.custom_fields` jsonb into a real `device_custom_field_values` table (with `devices.custom_fields` retained as a trigger-maintained projection so ~34 JS readers and both partner-export statement triggers keep working), and a durable `device_external_links` table turns a fuzzy hostname join into an exact lookup on every subsequent run.

**Tech Stack:** Hono + Zod routes, Drizzle ORM, hand-written idempotent PostgreSQL migrations, Vitest (unit / RLS / integration configs), React + Astro islands on the web side, `runAction` for every mutation.

**Spec:** `docs/superpowers/specs/onboarding-signup/2026-09-02-rmm-custom-field-import-spec.md` (approved Gate A, 2026-09-02; all seven Open Decisions resolved as recommended — see "Decisions as approved" below). Issue [#3257](https://github.com/LanternOps/breeze/issues/3257), epic #3249 Phase 3.

---

## Decisions as approved

The spec left seven Open Decisions. Todd approved the spec "with Open Decisions resolved as recommended", which fixes them as follows. **Do not re-litigate these while executing.**

| # | Decision | Resolution | Where it lands |
|---|---|---|---|
| 1 | Value storage | **A — normalize into `device_custom_field_values`, keep `devices.custom_fields` as a trigger-maintained projection.** The anti-shadowing constraint is still built (W03) because the projection is lossy under a collided key. | W03 + W05 |
| 2 | `device_external_links` unique key | **A with the reservation** — `(partner_id, system, COALESCE(source_instance,''), external_id)`; `source_instance` ships nullable and unused, so adopting Codex's refinement later is a backfill, not a migration of a unique key. | W06 |
| 3 | Import job persistence | **A — stateless.** No `custom_field_import_jobs` table. Acknowledgement state lives on the client; the server writes audits. | W07, W08 |
| 4 | Field types | **A — import the incumbent's declared types**, with the browser applying explicit coercion rules before preview. | W07, W09 |
| 5 | Ambiguous hostnames | **A — ranked candidates + explicit, identity-pinned pick.** Ranking is presentational; never auto-select. | W06, W08, W09 |
| 6 | Partner-wide UI gap | **A — separate PR ahead of the feature.** That is W01, and it ships whether or not the rest of #3257 does. | W01 |
| 7 | `warranty` mapping target | **A — keep it in v1, specified to the same depth**: its own task, its own `status` computation, its own provider-precedence rule, its own tests. | W08 Task 4 |

## What changed under the spec since it was written

The spec was verified against `main` at `2e2e094e0` on 2026-09-02. This plan is verified against `2296bb870`, which includes **#4679/#4692 (script custom-field write-back)**. Three of the spec's claims are now stale, in the plan's favour:

1. **`validateCustomFieldValue` EXISTS.** `apps/api/src/services/customFields/validateValue.ts` shipped with #4692 and its own header says it was extracted on "the path #3257's backfill-import plan reserved". W04 therefore *applies* it rather than writing it. It already handles both `choices` shapes, `min`/`max`, text length, boolean/date coercion.
2. **The bounded system definition lookup EXISTS.** `services/customFields/queries.ts` `loadScriptWritableDefinitions(orgId)` is exactly the "device → org → partner → visible definitions" helper the spec asked for, including the `runOutsideDbContext(() => withSystemDbAccessContext(...))` form and the reasoning comment. W04 generalises it instead of inventing a second one.
3. **`custom_field_definitions` gained a `script_write` column** and is already classified in `CORE_TENANT_EXPORT_POLICY`. It is *not* in `DUAL_AXIS_TENANT_TABLES`… it is: `rls-coverage.integration.test.ts:341`. No registration change is needed for that table.

One spec recommendation is superseded on technical grounds, and the plan says so at the point of use: **§Tenancy's "denormalize `field_key` into the exported projection via a `specific` policy" cannot work.** `services/tenantExport.ts:149-163` (`readOrgRows`) is a bare `SELECT <included columns> FROM <table> WHERE <orgKey> = $1` with no joins, and `specific` in `tablePolicy` only assigns a *decision* to a column that already exists. The plan therefore stores `field_key` as a real denormalized `NOT NULL` column on `device_custom_field_values`, which also makes the projection trigger cheaper (no join to `custom_field_definitions` to rebuild the jsonb) and gives `custom.<key>` filters a B-tree they can actually use.

---

## Global Constraints

Copied verbatim from CLAUDE.md and the spec. **Every task's requirements implicitly include this section.**

- **Migration naming.** The newest committed migration is `apps/api/migrations/2026-10-06-100000-script-custom-field-writeback.sql`. Every new file must sort **strictly after it** under `localeCompare`. This plan assigns `2026-10-07-…` through `2026-10-10-…`. **Re-check `origin/main` immediately before every push** — `scripts/check-migration-naming.sh --against-ref origin/main` runs in the pre-push hook and the ceiling moves whenever anyone else merges a migration. Rename if it fails. Today's calendar date does NOT sort last and never will until real time catches up.
- **`2026-08-06-` is a CLOSED date block.** Never add `-g-` or later to it.
- **Migrations are idempotent** (`IF NOT EXISTS` / `DO $$ … EXCEPTION`), carry **no inner `BEGIN;`/`COMMIT;`** (`autoMigrate` wraps each file in `client.begin`), and **never edit a shipped file** — fix forward.
- **Cleanup statements report row counts.** Any `UPDATE`/`DELETE`/`INSERT` of suspect rows wraps in `DO $$ … GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE WARNING …; END IF; END $$;` — even a zero count is forensic evidence.
- **`RAISE WARNING` does not abort a migration.** `autoMigrate` records the file as applied and returns success. Only `RAISE EXCEPTION` aborts. Where the plan wants a deploy to stop, it raises an exception *after* warning the count.
- **Backfills must set `breeze.scope = system`** or they are a silent 0-row no-op on managed Postgres as `doadmin`. CI's superuser masks this.
- **Every composite FK that references an `org_id` column must be `DEFERRABLE`** (`INITIALLY IMMEDIATE` unless a documented reason wants `DEFERRED`). Enforced by `orgLifecycleFoundations.integration.test.ts`, which only runs under **Integration Tests** (shard 2) — a unit-green PR still goes red there.
- **Six registration lists**, not four. A new `org_id` table is not done until it is in every one that applies: `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`, alphabetical, `organizations` last), `CORE_DEVICE_CASCADE_DELETE_TABLES` and `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`), `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts` — **fires on a new COLUMN too**), `orgMergeRegistry.ts`, and the relevant allowlist in `rls-coverage.integration.test.ts` (shape 1 is auto-discovered, so no entry needed for a direct `org_id` column).
- **RLS is not the backstop on the importer path.** Resolving devices across orgs runs in a system DB context, where `breeze_has_org_access` short-circuits to TRUE. Every isolation guarantee on that path is app-layer and must be proven by a forge test that runs *under system context*. An appeal to RLS in an importer test is a vacuous assertion.
- **Partner-wide first (#2135).** `custom_field_definitions` is already dual-axis; partner-wide writes gate on `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts`), and app-layer dual-axis read conditions must be gated on `auth.scope === 'partner'`.
- **All four import routes:** `requireScope('organization','partner','system')` + `requireOrgWrite` (`PERMISSIONS.ORGS_WRITE` for definitions is wrong — use `PERMISSIONS.DEVICES_WRITE`, matching `routes/customFields.ts`) + `requireMfa()`. **No `X-API-Key` branch**, deliberately.
- **Always HTTP 200**, even with a non-empty `errors[]`. The web caller reads the body through `runAction`, which treats `success: false` as a hard failure and would hide a partial success. Errors carry a typed `code`, never free text; `write-failed` copy is chosen from the SQLSTATE, never the driver `.message` (it carries column values and constraint text).
- **One transaction per DEVICE ROW**, opened via `runOutsideDbContext(() => …)` from inside the request's context. Per-row failure isolation is unachievable inside one Postgres transaction — a failed statement aborts it and every later statement raises 25P02.
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`). Tab/step state goes in `window.location.hash`, never query params.
- **Test path filters are substrings, not globs.** `vitest run src/routes/foo/` silently skips `src/routes/foo.test.ts`. Never write `pnpm --filter <pkg> test -- --run <path>` — the `--` makes vitest run the whole suite in watch mode. Use `pnpm --filter @breeze/api test --run <path>` or `cd apps/api && npx vitest run <path>`.
- **Integration/RLS suites are separate vitest configs.** `pnpm test` does not run them. Run `vitest.integration.config.ts` and `vitest.config.rls.ts` locally before every PR in this plan; several contracts here can only fail there.

## Wave map

Each wave is an independently shippable PR. Waves are ordered by dependency; W01 is independent of everything else and ships first because it fixes two live bugs.

| Wave | Deliverable | Depends on |
|---|---|---|
| W01 | Partner-wide custom-field UI gate + dropdown `options` contract fix | — |
| W02 | Definition uniqueness + XOR + org-merge reconcile | — |
| W03 | Anti-shadowing: one effective `field_key` namespace per device | W02 |
| W04 | `validateCustomFieldValue` applied to both shipped write paths | — |
| W05 | `device_custom_field_values` + projection + backfill + 6 registration lists | W03 |
| W06 | `device_external_links` + serial index + device resolution service | — |
| W07 | Definitions importer (service + routes) | W02, W03 |
| W08 | Values importer (service + routes) incl. the `warranty` target | W04, W05, W06, W07 |
| W09 | Web UI: "Import from another RMM" wizard | W07, W08 |
| W10 | Migration docs (overview + four vendor guides) | W09 |

## File structure

**New files**

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-07-100000-custom-field-definition-integrity.sql` | XOR + two partial unique indexes + duplicate-key report/abort (W02) |
| `apps/api/migrations/2026-10-08-100000-custom-field-no-cross-axis-shadowing.sql` | Shadowing report/abort + BEFORE-write trigger (W03) |
| `apps/api/migrations/2026-10-09-100000-device-custom-field-values.sql` | Table, FKs, coherence trigger, projection trigger, backfill (W05) |
| `apps/api/migrations/2026-10-10-100000-device-external-links.sql` | Link table + `device_hardware (org_id, serial_number)` index (W06) |
| `apps/api/src/db/schema/deviceCustomFieldValues.ts` | Drizzle schema for both new tables |
| `apps/api/src/services/customFields/import/types.ts` | Wire types, annotations, caps — dependency-free |
| `apps/api/src/services/customFields/import/schemas.ts` | Zod wire schemas for all four routes |
| `apps/api/src/services/customFields/import/deviceIdentity.ts` | Junk-serial denylist ported from the Go agent; hostname/serial normalisation |
| `apps/api/src/services/customFields/import/resolveDevice.ts` | id → link → serial → hostname resolution, ranked candidates, `identity-conflict` |
| `apps/api/src/services/customFields/import/definitionImport.ts` | Definitions preview + commit |
| `apps/api/src/services/customFields/import/valueImport.ts` | Values preview + commit (per-row transaction) |
| `apps/api/src/services/customFields/import/warrantyTarget.ts` | `warranty` mapping target incl. status computation and provider precedence |
| `apps/api/src/services/customFields/import/audit.ts` | `writeRouteAudit` fan-out for both commits |
| `apps/api/src/routes/customFieldImport.ts` | Definitions route pair |
| `apps/api/src/routes/devices/customFieldImport.ts` | Values route pair |
| `apps/web/src/components/devices/RmmCustomFieldImport.tsx` | Wizard shell + step routing |
| `apps/web/src/components/devices/CustomFieldDefinitionImportStep.tsx` | Step 1 |
| `apps/web/src/components/devices/CustomFieldValueImportStep.tsx` | Step 2 |
| `apps/web/src/components/devices/CustomFieldImportPreviewTable.tsx` | Shared preview table + candidate expander |

**Modified files**

| Path | Change |
|---|---|
| `apps/api/src/routes/customFields.ts` | `customFieldOptionsSchema` reconciled with the shared contract (W01) |
| `apps/web/src/components/settings/CustomFieldsPage.tsx` | `ownerScope` selector, "All orgs" badge, Edit/Delete gating (W01) |
| `apps/api/src/services/orgMergeRegistry.ts` / `orgMergeCustomExecutors.ts` | `custom_field_definitions` → `custom` policy (W02, extended W05) |
| `apps/api/src/services/customFields/queries.ts` | Generalised visible-definition lookup; value persistence moves to the table (W04, W05) |
| `apps/api/src/routes/devices/customFieldValues.ts` | Validation + write to the normalized table (W04, W05) |
| `apps/api/src/routes/devices/core.ts` | `PATCH /devices/:id` validation; two cascade lists (W04, W05) |
| `apps/api/src/services/customFields/scriptWriteBack.ts` | Writes through the normalized path (W05) |
| `apps/api/src/services/filterEngine.ts` | `custom.<key>` reads the table, not `jsonb_extract_path_text` (W05) |
| `apps/api/src/routes/partnerApi/configuration.ts` | `customFieldValueSource` reads the table; one record per datum (W05) |
| `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts` | Registration (W05, W06) |
| `apps/api/src/services/warrantySync.ts` | `export` `computeWarrantyStatus` (W08) |
| `apps/api/src/routes/index.ts`, `routes/devices/index.ts` | Mount the two route pairs (W07, W08) |
| `apps/docs/src/content/docs/migration/*.mdx` | Backfill flow (W10) |

---

# Wave 01 — Phase 0: partner-wide custom-field gate + dropdown contract

**Ships regardless of #3257.** Two live bugs found while specifying: an ordinary tech with `orgAccess='selected'` gets a 403 from the plain "Add custom field" modal, and **creating a dropdown custom field through the web UI is rejected by its own API**. Branch: `feature/<parent#>-rmm-custom-field-import/wave-<subissue#>`.

### Task 1: Reconcile the route's `options` schema with the shared contract

`routes/customFields.ts:11-17` declares `choices: z.array(z.string())`. The shared type (`packages/shared/src/types/filters.ts:184-193`) and the web form (`CustomFieldsPage.tsx:221` — `dropdownChoices.filter((c) => c.label && c.value)`) both use `Array<{label, value}>`. Zod rejects the whole create. The route schema is also missing `minLength`/`maxLength`, which a non-strict `z.object` silently strips out of the UI's `text` payload.

`services/customFields/validateValue.ts` `readChoices()` already normalises **both** shapes, so widening the route is a pure superset — no stored data is invalidated and no validation regresses.

**Files:**
- Modify: `apps/api/src/routes/customFields.ts:11-18`
- Test: `apps/api/src/routes/customFields_create_update_delete.test.ts`

**Interfaces:**
- Produces: `customFieldOptionsSchema` accepting `choices?: Array<{label: string, value: string}> | Array<string>`, `min`, `max`, `minLength`, `maxLength`, `pattern`, `placeholder`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/customFields_create_update_delete.test.ts`, inside the existing `describe` that covers POST:

```ts
it('accepts a dropdown created with the shared {label,value} choices shape', async () => {
  const created = {
    id: FIELD_ID_1, orgId: ORG_ID, partnerId: null, name: 'Contract Tier',
    fieldKey: 'contract_tier', type: 'dropdown',
    options: { choices: [{ label: 'Gold', value: 'gold' }, { label: 'Silver', value: 'silver' }] },
    required: false, defaultValue: null, deviceTypes: null, scriptWrite: false,
    createdAt: new Date(), updatedAt: new Date(),
  };
  (db.insert as any).mockReturnValue({
    values: () => ({ returning: async () => [created] }),
  });

  const res = await app.request('/custom-fields', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Contract Tier', fieldKey: 'contract_tier', type: 'dropdown',
      options: { choices: [{ label: 'Gold', value: 'gold' }, { label: 'Silver', value: 'silver' }] },
    }),
  });

  expect(res.status).toBe(201);
});

it('preserves text minLength/maxLength instead of stripping them', async () => {
  let inserted: any;
  (db.insert as any).mockReturnValue({
    values: (v: any) => { inserted = v; return { returning: async () => [{
      id: FIELD_ID_2, orgId: ORG_ID, partnerId: null, name: 'Asset Tag', fieldKey: 'asset_tag',
      type: 'text', options: v.options, required: false, defaultValue: null,
      deviceTypes: null, scriptWrite: false, createdAt: new Date(), updatedAt: new Date(),
    }] }; },
  });

  await app.request('/custom-fields', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Asset Tag', fieldKey: 'asset_tag', type: 'text',
      options: { minLength: 3, maxLength: 32 },
    }),
  });

  expect(inserted.options).toEqual({ minLength: 3, maxLength: 32 });
});
```

- [ ] **Step 2: Run it and watch both fail**

```bash
cd apps/api && npx vitest run src/routes/customFields_create_update_delete.test.ts
```

Expected: the dropdown test fails with a 400 (zod: `Expected string, received object` at `options.choices.0`); the text test fails because `inserted.options` is `{}`.

- [ ] **Step 3: Widen the schema**

Replace `routes/customFields.ts:11-17` with:

```ts
// Mirrors CustomFieldOptions in packages/shared/src/types/filters.ts. The
// {label,value} choice shape is the one the shared contract, the web form and
// services/customFields/validateValue.ts readChoices() all use; the bare-string
// array is accepted for the rows already stored that way. Widening here was a
// live bug fix, not a nicety: a dropdown created through the UI was rejected by
// this very schema (#3257 Phase 0).
const customFieldChoiceSchema = z.union([
  z.string().min(1).max(255),
  z.object({ label: z.string().min(1).max(255), value: z.string().min(1).max(255) }),
]);

const customFieldOptionsSchema = z.object({
  choices: z.array(customFieldChoiceSchema).max(200).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().max(512).optional(),
  placeholder: z.string().max(255).optional()
});
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/routes/customFields_create_update_delete.test.ts src/services/customFields/validateValue.test.ts
```

Expected: PASS, including the pre-existing validateValue suite (which already covers both choice shapes).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/customFields.ts apps/api/src/routes/customFields_create_update_delete.test.ts
git commit -m "fix(api): custom-field options schema accepts the shared {label,value} choices shape

Creating a dropdown custom field through the web UI was rejected by its own
API: the route declared choices as z.array(z.string()) while the shared type,
the web form and validateValue.readChoices all use Array<{label,value}>.
minLength/maxLength were also absent and silently stripped from text fields.

Refs #3257"
```

### Task 2: `ownerScope` selector, "All orgs" badge, and Edit/Delete gating

`CustomFieldsPage.tsx` has no ownership control and never sends `orgId`/`partnerId` (grep: zero hits). A partner-scoped caller with no ownership in the body falls through to `partnerId = auth.partnerId` at `routes/customFields.ts:328`, and `canManagePartnerWidePolicies` requires `partnerOrgAccess === 'all'` — so a tech with `orgAccess='selected'` gets a 403 from the plain create modal. The list also renders unconditional Edit/Delete on partner-wide rows, which the API then refuses at `canEditField` (`routes/customFields.ts:145`) — swapping one 403 for another unless both are gated.

The repo already has both halves of the pattern: `useDefaultOwnerScope()` (`apps/web/src/hooks/useDefaultOwnerScope.ts`) decides whether to show the selector and what it defaults to, and `user.canManagePartnerWide` (`apps/web/src/stores/auth.ts:74`, surfaced by `/users/me`) says whether the partner-wide option is offered at all. Treat `canManagePartnerWide === undefined` as capable — a session persisted before the field existed has no value, and the server enforces regardless.

**Files:**
- Modify: `apps/web/src/components/settings/CustomFieldsPage.tsx`
- Test: `apps/web/src/components/settings/CustomFieldsPage.ownerScope.test.tsx` (new)

**Interfaces:**
- Consumes: `useDefaultOwnerScope(): { isPartnerScope: boolean; defaultOwnerScope: 'organization' | 'partner' }`; `useAuthStore` → `user.canManagePartnerWide?: boolean`.
- Produces: create POST body gains exactly one of `{ partnerId }` (partner-wide) or `{ orgId }` (org-owned); rows whose `orgId === null` render an "All organizations" badge and hide Edit/Delete for non-capable users.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/settings/CustomFieldsPage.ownerScope.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: () => ({ user: { canManagePartnerWide: false } }),
}));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({ isPartnerScope: true, defaultOwnerScope: 'organization' }),
}));

import CustomFieldsPage from './CustomFieldsPage';

const PARTNER_WIDE_FIELD = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orgId: null, partnerId: 'p-1',
  name: 'Asset Tag', fieldKey: 'asset_tag', type: 'text', options: null,
  required: false, defaultValue: null, deviceTypes: null, scriptWrite: false,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ data: [PARTNER_WIDE_FIELD], total: 1 }),
  });
});

describe('CustomFieldsPage partner-wide gating', () => {
  it('badges a partner-wide row as All organizations', async () => {
    render(<CustomFieldsPage />);
    expect(await screen.findByTestId('custom-field-all-orgs-badge')).toBeInTheDocument();
  });

  it('hides Edit and Delete on a partner-wide row from a user who cannot manage partner-wide state', async () => {
    render(<CustomFieldsPage />);
    await screen.findByTestId('custom-field-all-orgs-badge');
    expect(screen.queryByTestId('custom-field-edit')).toBeNull();
    expect(screen.queryByTestId('custom-field-delete')).toBeNull();
  });

  it('does not offer the partner-wide owner option to a user who cannot manage it', async () => {
    render(<CustomFieldsPage />);
    await userEvent.click(await screen.findByTestId('custom-field-add'));
    expect(screen.queryByTestId('custom-field-owner-partner')).toBeNull();
    expect(screen.getByTestId('custom-field-owner-org')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/settings/CustomFieldsPage.ownerScope.test.tsx
```

Expected: FAIL — no `custom-field-all-orgs-badge` testid exists, and both action buttons render unconditionally.

- [ ] **Step 3: Implement**

In `CustomFieldsPage.tsx`:

```tsx
import { useDefaultOwnerScope, type OwnerScope } from '@/hooks/useDefaultOwnerScope';
import { useAuthStore } from '../../stores/auth';

// …inside the component:
const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
const user = useAuthStore((s) => s.user);
// Absent means UNKNOWN on a session persisted before /users/me carried the
// field — treat as capable; the server gates every partner-wide write anyway.
const canManagePartnerWide = user?.canManagePartnerWide !== false;
const showOwnerScope = isPartnerScope && canManagePartnerWide;
const [formOwnerScope, setFormOwnerScope] = useState<OwnerScope>(defaultOwnerScope);
// Only a user who may manage partner-wide state can edit/delete a partner-wide
// row — routes/customFields.ts canEditField refuses otherwise, and an
// unconditional button just trades a create 403 for a delete 403.
const canMutateField = (field: CustomField) =>
  field.orgId !== null || canManagePartnerWide;
```

Reset `formOwnerScope` to `defaultOwnerScope` in `handleOpenCreate`, and render the selector only on create (never on edit — ownership is immutable, exactly as `PolicyForm.tsx:87` scopes it to `modalMode === 'create'`):

```tsx
{modalMode === 'create' && showOwnerScope && (
  <fieldset className="space-y-2 rounded-md border p-3" data-testid="custom-field-owner">
    <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
      {t('customFieldsPage.ownerScope.legend')}
    </legend>
    <label className="flex items-center gap-2 text-sm">
      <input type="radio" name="ownerScope" value="partner"
        data-testid="custom-field-owner-partner"
        checked={formOwnerScope === 'partner'}
        onChange={() => setFormOwnerScope('partner')} />
      {t('customFieldsPage.ownerScope.allOrganizations')}
    </label>
    <label className="flex items-center gap-2 text-sm">
      <input type="radio" name="ownerScope" value="organization"
        data-testid="custom-field-owner-org"
        checked={formOwnerScope === 'organization'}
        onChange={() => setFormOwnerScope('organization')} />
      {t('customFieldsPage.ownerScope.thisOrganizationOnly')}
    </label>
  </fieldset>
)}
```

Send exactly one ownership key on create (never both — the route 400s on both, `customFields.ts:296`); send neither on PATCH:

```tsx
const payload = {
  name: trimmedName, fieldKey: trimmedKey, type: formType,
  required: formRequired, defaultValue: formDefaultValue,
  deviceTypes: formDeviceTypes.length > 0 ? formDeviceTypes : null,
  options: Object.keys(options).length > 0 ? options : null,
  ...(modalMode === 'create' && showOwnerScope
    ? (formOwnerScope === 'partner' ? { partnerId } : { orgId: currentOrgId })
    : {}),
};
```

Add the badge in the name cell and gate the two action buttons:

```tsx
{field.orgId === null && (
  <span data-testid="custom-field-all-orgs-badge"
    className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
    {t('customFieldsPage.allOrganizations')}
  </span>
)}
…
{canMutateField(field) && (
  <>
    <button type="button" data-testid="custom-field-edit" onClick={() => handleOpenEdit(field)} …/>
    <button type="button" data-testid="custom-field-delete" onClick={() => handleOpenDelete(field)} …/>
  </>
)}
```

Add the four i18n keys (`customFieldsPage.ownerScope.legend`, `.allOrganizations`, `.thisOrganizationOnly`, `customFieldsPage.allOrganizations`) to `apps/web/src/locales/en/settings.json` **and every other locale file** — `tr-TR` parity is asserted and a missing key reddens every branch cut before the parity fix.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/settings/CustomFieldsPage
```

Check the reported file count: the bare substring matches `CustomFieldsPage.tsx`'s siblings too, which is what you want here.

- [ ] **Step 5: Commit and open the PR**

```bash
git add apps/web/src/components/settings/CustomFieldsPage.tsx \
        apps/web/src/components/settings/CustomFieldsPage.ownerScope.test.tsx \
        apps/web/src/locales
git commit -m "fix(web): gate partner-wide custom fields in the UI (#2135 step 6)

A tech with orgAccess='selected' got a 403 from the plain 'Add custom field'
modal, because the page never sent an ownership key and the API defaulted the
create to partner-wide. Adds a create-only ownerScope selector, an
'All organizations' badge, and hides Edit/Delete on partner-wide rows from
users canEditField would refuse.

Refs #3257"
```

PR body must note this is Phase 0 and ships independently of #3257.

---

# Wave 02 — Definition uniqueness, XOR, and org-merge reconcile

`custom_field_definitions` has a primary key and two foreign keys — nothing else (verified against `0001-baseline.sql:6761-6766, 11891-11907`; no later migration adds an index). So a definitions import has **no idempotency key**: re-running mints a duplicate `udf7`. And `(NULL, NULL)` is structurally legal, invisible to every non-system caller, and survives org cascade forever, because the cascade deletes by `org_id` — a latent GDPR orphan.

> **Gate before merging this wave.** The duplicate report must come back **zero on both prod regions**. The migration aborts by design when it finds duplicates, and a deploy is the wrong place to discover that. Run the preflight in Step 1 and paste the two results into the PR body. Per the managed-Postgres lesson, prod is a managed DO instance reached through the billing container's `postgres` module — never source `/opt/breeze/.env` (line 116 is unquoted).

### Task 1: Preflight — duplicate `field_key` and `(NULL,NULL)` report

**Files:**
- Create: `apps/api/migrations/preflight/2026-10-07-custom-field-definition-integrity-preflight.sql` (read-only, not applied by the runner — the `preflight/` directory is outside `^\d{4}-.*\.sql$` discovery at the migrations root, same as `migrations/optional/`)

- [ ] **Step 1: Write the read-only report**

```sql
-- READ-ONLY preflight for 2026-10-07-100000-custom-field-definition-integrity.sql.
-- Run on EACH prod region before merging. Every result must be empty.

-- (a) duplicate field_key within one owner
SELECT COALESCE(org_id::text, 'partner:' || partner_id::text) AS owner,
       field_key, count(*) AS n, array_agg(id ORDER BY created_at) AS ids
  FROM public.custom_field_definitions
 GROUP BY 1, 2 HAVING count(*) > 1
 ORDER BY n DESC;

-- (b) ownerless rows that the XOR will reject
SELECT id, field_key, name, created_at
  FROM public.custom_field_definitions
 WHERE (org_id IS NULL) = (partner_id IS NULL)
 ORDER BY created_at;
```

- [ ] **Step 2: Run it against both regions and record the output**

Hand the file to Todd to run (the auto-mode classifier blocks prod SSH from an agent). Record both results verbatim in the PR body. **If (a) is non-empty, stop and escalate** — the spec is explicit that existing duplicates are *reported, not resolved*: deleting one silently retypes every value stored under that key (the survivor dictates `type`; values carry none), and renaming one orphans every value instantly and breaks consumers holding the key as configuration (`remoteAccessLauncher.ts:73` `provider.customFieldKey`, `installerVariables.ts:46`).

- [ ] **Step 3: Commit**

```bash
git add apps/api/migrations/preflight/2026-10-07-custom-field-definition-integrity-preflight.sql
git commit -m "chore(api): read-only preflight for custom-field definition integrity

Refs #3257"
```

### Task 2: The integrity migration

**Files:**
- Create: `apps/api/migrations/2026-10-07-100000-custom-field-definition-integrity.sql`
- Test: `apps/api/src/__tests__/integration/customFieldDefinitionIntegrity.integration.test.ts`

**Interfaces:**
- Produces: constraint `custom_field_definitions_one_owner_chk`; indexes `custom_field_definitions_org_key_uq`, `custom_field_definitions_partner_key_uq`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/__tests__/integration/customFieldDefinitionIntegrity.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { seedPartnerAndOrg } from './helpers/tenantSeed'; // existing integration helper

const sys = <T>(fn: () => Promise<T>) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, 'test.customFieldIntegrity'));

describe('custom_field_definitions integrity constraints', () => {
  let orgId: string; let partnerId: string;
  beforeAll(async () => { ({ orgId, partnerId } = await seedPartnerAndOrg()); });

  it('rejects a second org-owned definition with the same field_key', async () => {
    await sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (org_id, name, field_key, type)
      VALUES (${orgId}::uuid, 'Asset Tag', 'asset_tag', 'text')`));
    await expect(sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (org_id, name, field_key, type)
      VALUES (${orgId}::uuid, 'Asset Tag Again', 'asset_tag', 'text')`)))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('rejects a second partner-wide definition with the same field_key', async () => {
    await sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (partner_id, name, field_key, type)
      VALUES (${partnerId}::uuid, 'UDF 7', 'udf7', 'text')`));
    await expect(sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (partner_id, name, field_key, type)
      VALUES (${partnerId}::uuid, 'UDF 7 dup', 'udf7', 'text')`)))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('rejects an ownerless (NULL, NULL) row', async () => {
    await expect(sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (name, field_key, type)
      VALUES ('Orphan', 'orphan_key', 'text')`)))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a row claiming BOTH owners', async () => {
    await expect(sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (org_id, partner_id, name, field_key, type)
      VALUES (${orgId}::uuid, ${partnerId}::uuid, 'Both', 'both_key', 'text')`)))
      .rejects.toMatchObject({ code: '23514' });
  });
});
```

- [ ] **Step 2: Run it and watch all four fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/customFieldDefinitionIntegrity.integration.test.ts
```

Expected: all four FAIL — every insert succeeds today.

- [ ] **Step 3: Write the migration**

```sql
-- 2026-10-07-100000-custom-field-definition-integrity.sql
-- custom_field_definitions ships with a PK and two FKs and nothing else, which
-- leaves two defects that #3257's definitions importer would industrialise:
--
--   1. No unique key on field_key, so an import has no idempotency key and a
--      re-run mints a duplicate udf7. Two definitions with one key also make
--      the partner export emit two records for one datum (the identity hash
--      includes f.id — routes/partnerApi/configuration.ts:433,440).
--   2. (org_id, partner_id) = (NULL, NULL) is structurally legal. Such a row is
--      invisible to every non-system caller AND survives org cascade forever,
--      because the cascade deletes by org_id. A latent GDPR orphan.
--
-- Existing duplicates are REPORTED, never resolved. Deleting one silently
-- retypes every value stored under that key (the survivor dictates `type`;
-- values carry none) and renaming one orphans every value instantly, breaking
-- consumers that hold the key as configuration (remoteAccessLauncher.ts:73,
-- installerVariables.ts:46). So this file WARNs the count and the affected
-- pairs, then RAISEs to abort the deploy: a WARNING alone returns success and
-- autoMigrate records the file as applied forever (db/autoMigrate.ts wraps each
-- file in client.begin; only an exception rolls it back). A read-only preflight
-- ran against both prod regions before this merged — see the PR body.

DO $$
DECLARE n bigint; pairs text;
BEGIN
  SELECT count(*), string_agg(owner || ' / ' || field_key, ', ' ORDER BY owner, field_key)
    INTO n, pairs
    FROM (
      SELECT COALESCE(org_id::text, 'partner:' || partner_id::text) AS owner, field_key
        FROM public.custom_field_definitions
       GROUP BY 1, 2 HAVING count(*) > 1
    ) d;
  IF n > 0 THEN
    RAISE WARNING 'custom_field_definitions: % duplicate (owner, field_key) pairs: %', n, pairs;
    RAISE EXCEPTION 'custom_field_definitions has % duplicate (owner, field_key) pairs; resolve them by hand before deploying — see the migration header', n
      USING ERRCODE = 'P0001';
  ELSE
    RAISE WARNING 'custom_field_definitions: 0 duplicate (owner, field_key) pairs';
  END IF;
END $$;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.custom_field_definitions
   WHERE (org_id IS NULL) = (partner_id IS NULL);
  IF n > 0 THEN
    RAISE WARNING 'custom_field_definitions: % ownerless or dual-owner rows', n;
    RAISE EXCEPTION 'custom_field_definitions has % rows violating the org XOR partner rule', n
      USING ERRCODE = 'P0001';
  ELSE
    RAISE WARNING 'custom_field_definitions: 0 ownerless or dual-owner rows';
  END IF;
END $$;

-- Exactly one owner. Copies 2026-07-01-alert-rules-partner-ownership.sql:38-48.
ALTER TABLE public.custom_field_definitions
  DROP CONSTRAINT IF EXISTS custom_field_definitions_one_owner_chk;
ALTER TABLE public.custom_field_definitions
  ADD CONSTRAINT custom_field_definitions_one_owner_chk
  CHECK ((org_id IS NULL) <> (partner_id IS NULL));

-- Two PARTIAL unique indexes, not one composite: uniqueness has to hold within
-- each axis independently, and a composite over two nullable columns would
-- treat every NULL as distinct and enforce nothing.
CREATE UNIQUE INDEX IF NOT EXISTS custom_field_definitions_org_key_uq
  ON public.custom_field_definitions (org_id, field_key) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS custom_field_definitions_partner_key_uq
  ON public.custom_field_definitions (partner_id, field_key) WHERE partner_id IS NOT NULL;
```

- [ ] **Step 4: Apply and re-run the tests**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/customFieldDefinitionIntegrity.integration.test.ts
pnpm db:check-drift
```

Expected: PASS ×4; drift check clean (indexes and CHECK constraints are not Drizzle-schema-visible, so no schema edit is needed).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-07-100000-custom-field-definition-integrity.sql \
        apps/api/src/__tests__/integration/customFieldDefinitionIntegrity.integration.test.ts
git commit -m "feat(api): unique field_key per owner + org-XOR-partner on custom field definitions

Refs #3257"
```

### Task 3: `customFieldDefinitionsPartnerRls.integration.test.ts`

#2135 playbook step 6 was never done for this table. Write the suite the playbook asks for.

**Files:**
- Create: `apps/api/src/__tests__/integration/customFieldDefinitionsPartnerRls.integration.test.ts`

- [ ] **Step 1: Write the suite**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { seedTwoPartners } from './helpers/tenantSeed';

describe('custom_field_definitions partner RLS', () => {
  let a: { partnerId: string; orgId: string };
  let b: { partnerId: string; orgId: string };
  beforeAll(async () => { ({ a, b } = await seedTwoPartners()); });

  it('refuses a cross-partner forge with 42501', async () => {
    await expect(
      withDbAccessContext(
        { scope: 'partner', partnerId: a.partnerId, accessiblePartnerIds: [a.partnerId], accessibleOrgIds: [a.orgId] },
        () => db.execute(sql`
          INSERT INTO custom_field_definitions (partner_id, name, field_key, type)
          VALUES (${b.partnerId}::uuid, 'Forged', 'forged_key', 'text')`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a (NULL, NULL) row with 23514 before RLS even applies', async () => {
    await expect(
      withDbAccessContext(
        { scope: 'partner', partnerId: a.partnerId, accessiblePartnerIds: [a.partnerId], accessibleOrgIds: [a.orgId] },
        () => db.execute(sql`
          INSERT INTO custom_field_definitions (name, field_key, type)
          VALUES ('Orphan', 'orphan_key_2', 'text')`),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('hides partner A partner-wide rows from an ORG token under partner A', async () => {
    await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO custom_field_definitions (partner_id, name, field_key, type)
      VALUES (${a.partnerId}::uuid, 'Partner Wide', 'partner_wide_key', 'text')`), 'seed'));

    // An ORG token carries a partnerId but never passes breeze_has_partner_access.
    // RLS is STRICTER than the app layer here — never claim parity.
    const rows = await withDbAccessContext(
      { scope: 'organization', orgId: a.orgId, accessibleOrgIds: [a.orgId], accessiblePartnerIds: [] },
      () => db.execute(sql`SELECT id FROM custom_field_definitions WHERE field_key = 'partner_wide_key'`),
    );
    expect((rows as unknown[]).length).toBe(0);
  });

  it('hides partner A rows from partner B entirely', async () => {
    const rows = await withDbAccessContext(
      { scope: 'partner', partnerId: b.partnerId, accessiblePartnerIds: [b.partnerId], accessibleOrgIds: [b.orgId] },
      () => db.execute(sql`SELECT id FROM custom_field_definitions WHERE partner_id = ${a.partnerId}::uuid`),
    );
    expect((rows as unknown[]).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/customFieldDefinitionsPartnerRls.integration.test.ts
```

Expected: PASS. (The XOR test is the only new-behaviour one; the three RLS assertions document the shipped dual-axis policy and are the regression guard for it.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/customFieldDefinitionsPartnerRls.integration.test.ts
git commit -m "test(api): partner RLS contract suite for custom_field_definitions (#2135 step 6)

Refs #3257"
```

### Task 4: Org merge must reconcile duplicate `field_key`s instead of raising 23505

`custom_field_definitions` is a plain `repoint` today (`orgMergeRegistry.ts` `REPOINT_TABLES`). Task 2's `custom_field_definitions_org_key_uq` makes a merge **fail with 23505** whenever the source and destination org both define the same key — which, for two orgs imported from the same Datto tenant, is *every* key. A blind `repoint-dedupe` is worse: it drops the loser's definition, and once W05 lands that cascade-deletes every value stored under it.

The repo already has the right shape: `rehomeChildrenThenDelete` (`orgMergeCustomExecutors.ts`), used by `mergePlaybookDefinitions`. At W02 the children list is empty — values are still string-keyed jsonb, so the survivor's definition picks them up automatically because it has the same `field_key`. **W05 Task 5 adds the `device_custom_field_values` child.** Write the executor with the array in place so that addition is one line.

**Files:**
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (move `custom_field_definitions` out of `REPOINT_TABLES` into the `custom` set)
- Modify: `apps/api/src/services/orgMergeCustomExecutors.ts`
- Test: `apps/api/src/services/orgMergeCustomExecutors.test.ts`; `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts` (existing contract test, must stay green)

**Interfaces:**
- Produces: `CUSTOM_EXECUTORS.custom_field_definitions = mergeCustomFieldDefinitions`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/orgMergeCustomExecutors.test.ts`:

```ts
const mergeCustomFieldDefinitions = CUSTOM_EXECUTORS.custom_field_definitions!;

it('drops a loser definition whose field_key already exists under the survivor, and repoints the rest', async () => {
  const executed: string[] = [];
  mockRun((q) => { executed.push(q); return q.includes('DELETE') ? 1 : 2; });

  const result = await mergeCustomFieldDefinitions(LOSER_ORG, SURVIVOR_ORG);

  expect(executed.some((q) => /DELETE FROM .*custom_field_definitions/.test(q))).toBe(true);
  expect(result.dropped).toBe(1);
  expect(result.moved).toBe(2);
  expect(result.notes[0]).toMatch(/custom_field_definitions: dropped 1 duplicate/);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/orgMergeCustomExecutors.test.ts
```

Expected: FAIL — `CUSTOM_EXECUTORS.custom_field_definitions` is `undefined`.

- [ ] **Step 3: Implement**

In `orgMergeCustomExecutors.ts`:

```ts
/**
 * #3257 W02. custom_field_definitions gained UNIQUE (org_id, field_key), so a
 * plain repoint now raises 23505 whenever the loser and the survivor both
 * define the same key — which for two orgs imported from one Datto tenant is
 * every key. The generic repoint-dedupe DELETE is not safe either: once
 * device_custom_field_values exists (W05), dropping the loser's definition
 * cascade-deletes every value stored under it. So the children are re-homed
 * onto the survivor's identically-keyed definition first, then the duplicate
 * definition is dropped.
 *
 * The CHILDREN array is empty until W05 registers device_custom_field_values.
 * Until then the values live in the string-keyed devices.custom_fields jsonb
 * and follow the survivor's definition for free, because it carries the same
 * field_key.
 */
const CUSTOM_FIELD_DEFINITION_CHILDREN: readonly ChildRef[] = [
  // W05: { table: 'device_custom_field_values', column: 'definition_id' },
];

const mergeCustomFieldDefinitions: CustomMergeExecutor = async (loser, survivor) => {
  const { dropped, rehomed } = await rehomeChildrenThenDelete(
    'custom_field_definitions',
    ['field_key'],
    CUSTOM_FIELD_DEFINITION_CHILDREN,
    loser,
    survivor,
  );
  const moved = await run(buildRepoint('custom_field_definitions', loser, survivor));
  return {
    moved,
    dropped,
    notes: dropped > 0
      ? [
        `custom_field_definitions: dropped ${dropped} duplicate field definition from the merged-away org whose field_key already existed under the survivor`
        + (rehomed.length > 0 ? ` and re-homed its stored values onto the survivor's definition (${describeRehomed(rehomed)})` : '')
        + " — the survivor's TYPE and dropdown choices are now authoritative for that key; compare them if the two definitions had diverged",
      ]
      : [],
  };
};
```

Register it in `CUSTOM_EXECUTORS` and reclassify in `orgMergeRegistry.ts`: remove `"custom_field_definitions"` from `REPOINT_TABLES` and add

```ts
custom_field_definitions: { kind: 'custom', note:
  'UNIQUE (org_id, field_key) (#3257 W02) makes a plain repoint raise 23505 when both orgs define the same key. '
  + 'Re-homes the loser definition\'s values onto the survivor\'s identically-keyed definition, then drops the duplicate. '
  + 'A blind dedupe DELETE would cascade-delete those values once device_custom_field_values lands (W05).' },
```

- [ ] **Step 4: Run the unit test and the merge contract suite**

```bash
cd apps/api && npx vitest run src/services/orgMergeCustomExecutors.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts
```

Expected: PASS. The registry contract test fails loudly if a table has no policy or a policy names a table out of scope — it must stay green.

- [ ] **Step 5: Write the merge integration proof**

Add to `apps/api/src/__tests__/integration/orgMerge.integration.test.ts` (or a new `customFieldDefinitionsMerge.integration.test.ts` if that file is already unwieldy):

```ts
it('merges two orgs that both define asset_tag without raising 23505', async () => {
  await seedDefinition(loserOrgId, 'asset_tag', 'text');
  await seedDefinition(survivorOrgId, 'asset_tag', 'text');

  const summary = await mergeOrganizations({ loserOrgId, survivorOrgId, actor });

  expect(summary.warnings.join(' ')).toMatch(/custom_field_definitions: dropped 1 duplicate/);
  const survivors = await sys(() => db.execute(sql`
    SELECT field_key FROM custom_field_definitions WHERE org_id = ${survivorOrgId}::uuid`));
  expect(survivors).toHaveLength(1);
  const stranded = await sys(() => db.execute(sql`
    SELECT 1 FROM custom_field_definitions WHERE org_id = ${loserOrgId}::uuid`));
  expect(stranded).toHaveLength(0);
});
```

- [ ] **Step 6: Run and commit**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgMerge
git add apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/orgMergeCustomExecutors.ts \
        apps/api/src/services/orgMergeCustomExecutors.test.ts apps/api/src/__tests__/integration/orgMerge.integration.test.ts
git commit -m "fix(api): org merge reconciles duplicate custom-field keys instead of 23505

Refs #3257"
```

- [ ] **Step 7: Open the wave PR**

Before pushing, re-check migration ordering (`origin/main` may have gained one):

```bash
git fetch origin main
bash scripts/check-migration-naming.sh --against-ref origin/main
```

PR body must carry both prod preflight results and `Closes #<wave sub-issue>`.

---

# Wave 03 — Anti-shadowing: one effective `field_key` namespace per device

Depends on W02. Required under **both** branches of the storage decision, and it is what makes W05's projection lossless: `devices.custom_fields` is a flat object with one `udf7` key, so if an org-owned `udf7` and a partner-wide `udf7` can both exist for one device, no projection from a `definition_id`-keyed table can represent it — and W05's backfill cannot attribute an existing blob value to one of the two.

Uniqueness across two nullable ownership columns over disjoint row sets is exactly what an index cannot express (that is why W02 needed two *partial* indexes). This needs a trigger.

### Task 1: Report existing shadowing, then forbid it

**Files:**
- Create: `apps/api/migrations/preflight/2026-10-08-custom-field-shadowing-preflight.sql`
- Create: `apps/api/migrations/2026-10-08-100000-custom-field-no-cross-axis-shadowing.sql`
- Test: `apps/api/src/__tests__/integration/customFieldShadowing.integration.test.ts`

**Interfaces:**
- Produces: `public.breeze_custom_field_no_cross_axis_shadow()` trigger function; trigger `custom_field_definitions_no_shadow` (BEFORE INSERT OR UPDATE OF org_id, partner_id, field_key … FOR EACH ROW).

- [ ] **Step 1: Write the preflight and run it on both prod regions**

```sql
-- READ-ONLY. Must return zero rows on each region before the migration merges.
SELECT o.partner_id, o.id AS org_id, f_org.field_key,
       f_org.id AS org_definition_id, f_partner.id AS partner_definition_id
  FROM public.custom_field_definitions f_org
  JOIN public.organizations o ON o.id = f_org.org_id
  JOIN public.custom_field_definitions f_partner
    ON f_partner.org_id IS NULL
   AND f_partner.partner_id = o.partner_id
   AND f_partner.field_key = f_org.field_key
 ORDER BY o.partner_id, f_org.field_key;
```

Record the two results in the PR body, exactly as W02 Task 1 did.

- [ ] **Step 2: Write the failing integration test**

Create `apps/api/src/__tests__/integration/customFieldShadowing.integration.test.ts`:

```ts
describe('cross-axis field_key shadowing', () => {
  it('refuses an org-owned key that shadows a partner-wide key visible to that org', async () => {
    await sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (partner_id, name, field_key, type)
      VALUES (${partnerId}::uuid, 'UDF 7', 'udf7', 'text')`));
    await expect(sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (org_id, name, field_key, type)
      VALUES (${orgId}::uuid, 'Local UDF 7', 'udf7', 'text')`)))
      .rejects.toMatchObject({ code: 'P0001' });
  });

  it('refuses a partner-wide key that shadows an existing org-owned key under that partner', async () => {
    await sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (org_id, name, field_key, type)
      VALUES (${orgId}::uuid, 'Asset Tag', 'asset_tag', 'text')`));
    await expect(sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (partner_id, name, field_key, type)
      VALUES (${partnerId}::uuid, 'Asset Tag', 'asset_tag', 'text')`)))
      .rejects.toMatchObject({ code: 'P0001' });
  });

  it('allows the same key under two DIFFERENT partners', async () => {
    await sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (partner_id, name, field_key, type)
      VALUES (${partnerA}::uuid, 'Site Code', 'site_code', 'text')`));
    await expect(sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (partner_id, name, field_key, type)
      VALUES (${partnerB}::uuid, 'Site Code', 'site_code', 'text')`)))
      .resolves.toBeDefined();
  });

  it('allows the same org-owned key in two orgs under one partner', async () => {
    await sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (org_id, name, field_key, type)
      VALUES (${orgOne}::uuid, 'Rack', 'rack', 'text')`));
    await expect(sys(() => db.execute(sql`
      INSERT INTO custom_field_definitions (org_id, name, field_key, type)
      VALUES (${orgTwo}::uuid, 'Rack', 'rack', 'text')`)))
      .resolves.toBeDefined();
  });
});
```

- [ ] **Step 3: Run it and watch the first two fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/customFieldShadowing.integration.test.ts
```

Expected: tests 1 and 2 FAIL (both inserts succeed today); tests 3 and 4 already pass and are the guard against over-tightening.

- [ ] **Step 4: Write the migration**

```sql
-- 2026-10-08-100000-custom-field-no-cross-axis-shadowing.sql
-- One EFFECTIVE field_key namespace per device.
--
-- custom_field_definitions is dual-axis, but devices.custom_fields is a FLAT
-- jsonb object keyed by a bare string. When an org-owned udf7 and a
-- partner-wide udf7 both exist for one org, that one datum has two definitions
-- and the partner export emits TWO records for it, each with a different
-- synthetic id (the identity hash includes f.id — partnerApi/configuration.ts
-- :433,440). It also makes the normalized device_custom_field_values table
-- (#3257 W05) impossible to project back into the jsonb without loss, and makes
-- its backfill unable to attribute an existing blob value to one of the two
-- definitions.
--
-- Uniqueness here spans two NULLABLE ownership columns over DISJOINT row sets,
-- which is precisely what no index can express (hence W02's two PARTIAL unique
-- indexes). So this is a row-level trigger, with a transaction-scoped advisory
-- lock on (partner, field_key) so two concurrent inserts cannot both pass their
-- own EXISTS check.

DO $$
DECLARE n bigint; pairs text;
BEGIN
  SELECT count(*), string_agg(o.partner_id::text || '/' || f_org.field_key, ', ')
    INTO n, pairs
    FROM public.custom_field_definitions f_org
    JOIN public.organizations o ON o.id = f_org.org_id
   WHERE EXISTS (
     SELECT 1 FROM public.custom_field_definitions f_p
      WHERE f_p.org_id IS NULL AND f_p.partner_id = o.partner_id
        AND f_p.field_key = f_org.field_key);
  IF n > 0 THEN
    RAISE WARNING 'custom_field_definitions: % org-owned keys shadow a partner-wide key: %', n, pairs;
    RAISE EXCEPTION 'custom_field_definitions has % cross-axis shadowed keys; reconcile them by hand before deploying', n
      USING ERRCODE = 'P0001';
  ELSE
    RAISE WARNING 'custom_field_definitions: 0 cross-axis shadowed keys';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.breeze_custom_field_no_cross_axis_shadow()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE owner_partner uuid; conflicting uuid;
BEGIN
  IF NEW.org_id IS NOT NULL THEN
    SELECT o.partner_id INTO owner_partner FROM public.organizations o WHERE o.id = NEW.org_id;
    IF owner_partner IS NULL THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(1000257, hashtext(owner_partner::text || ':' || NEW.field_key));
    SELECT f.id INTO conflicting FROM public.custom_field_definitions f
     WHERE f.org_id IS NULL AND f.partner_id = owner_partner
       AND f.field_key = NEW.field_key LIMIT 1;
    IF conflicting IS NOT NULL THEN
      RAISE EXCEPTION 'custom field key "%" already exists as an all-organizations field for this partner', NEW.field_key
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.partner_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(1000257, hashtext(NEW.partner_id::text || ':' || NEW.field_key));
    SELECT f.id INTO conflicting FROM public.custom_field_definitions f
      JOIN public.organizations o ON o.id = f.org_id
     WHERE o.partner_id = NEW.partner_id AND f.field_key = NEW.field_key
       AND f.id IS DISTINCT FROM NEW.id LIMIT 1;
    IF conflicting IS NOT NULL THEN
      RAISE EXCEPTION 'custom field key "%" is already defined by at least one organization under this partner', NEW.field_key
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_field_definitions_no_shadow ON public.custom_field_definitions;
CREATE TRIGGER custom_field_definitions_no_shadow
  BEFORE INSERT OR UPDATE OF org_id, partner_id, field_key
  ON public.custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION public.breeze_custom_field_no_cross_axis_shadow();
```

- [ ] **Step 5: Apply and re-run**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/customFieldShadowing.integration.test.ts
```

Expected: PASS ×4.

- [ ] **Step 6: Surface the refusal as a 409, not a 500**

`routes/customFields.ts` POST/PATCH must not turn a P0001 into a generic 500. Add to the create and update handlers:

```ts
import { pgErrorCode } from '../utils/pgErrors';

// …around the insert/update:
} catch (err) {
  // The anti-shadowing trigger (#3257 W03) raises P0001 with copy that names
  // the key and the axis it collides on. Surface it: a 500 here tells the
  // operator nothing and the condition is entirely their own to fix.
  if (pgErrorCode(err) === 'P0001') {
    return c.json({ error: (err as { message: string }).message, code: 'field-key-shadowed' }, 409);
  }
  throw err;
}
```

Add a route unit test asserting the 409 and the `code`, mocking `db.insert` to throw `{ code: 'P0001', message: '…' }`.

- [ ] **Step 7: Run, then commit**

```bash
cd apps/api && npx vitest run src/routes/customFields_create_update_delete.test.ts
git add apps/api/migrations/2026-10-08-100000-custom-field-no-cross-axis-shadowing.sql \
        apps/api/migrations/preflight/2026-10-08-custom-field-shadowing-preflight.sql \
        apps/api/src/__tests__/integration/customFieldShadowing.integration.test.ts \
        apps/api/src/routes/customFields.ts apps/api/src/routes/customFields_create_update_delete.test.ts
git commit -m "feat(api): forbid an org custom-field key shadowing a partner-wide one

One effective field_key namespace per device. Without it the flat
devices.custom_fields jsonb cannot represent two definitions for one key, the
partner export emits two records for one datum, and #3257's normalized value
table cannot project back losslessly.

Refs #3257"
```

---

# Wave 04 — `validateCustomFieldValue` on both shipped write paths

Independent of W02/W03 and shippable on its own. Nothing today validates a custom-field value against its definition's declared `type` on either user-facing write path, while values are both an execution sink (`installerVariables.ts:46,88` substitutes `{{device.customField.<key>}}` into installer command lines that reach `sendCommandToAgent`) and a targeting control (`filterEngine`'s `custom.<key>` feeds `groupMembership.ts` and `deploymentTargetResolver.ts`). The script write-back path (#4692) already validates; the two older paths do not.

**Behaviour change on a shipped API — this wave needs a release note.**

### Task 1: Generalise the bounded definition lookup

`services/customFields/queries.ts` already has `loadScriptWritableDefinitions(orgId)`, which does exactly the right thing: a `runOutsideDbContext(() => withSystemDbAccessContext(...))` lookup so a partner-wide definition (`org_id IS NULL`) is visible from an org-scoped caller, with a narrow explicit predicate. Its only problem for our purposes is the projection — it omits `id`, `name` and `required`, and the script path additionally filters on `script_write`.

**Files:**
- Modify: `apps/api/src/services/customFields/queries.ts`
- Test: `apps/api/src/services/customFields/queries.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export interface VisibleCustomFieldDefinition {
    id: string;
    fieldKey: string;
    name: string;
    type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
    options: unknown;
    deviceTypes: string[] | null;
    required: boolean;
    scriptWrite: boolean;
    orgId: string | null;
    partnerId: string | null;
  }
  export async function loadVisibleCustomFieldDefinitions(orgId: string): Promise<VisibleCustomFieldDefinition[]>;
  ```
- `loadScriptWritableDefinitions` is retained as a thin filter over it so `scriptWriteBack.ts` is untouched.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/customFields/queries.test.ts
it('returns org-owned AND partner-wide definitions for the org', async () => {
  mockOrgPartner('partner-1');
  mockDefinitions([
    { id: 'd1', fieldKey: 'asset_tag', orgId: 'org-1', partnerId: null, type: 'text', options: null, deviceTypes: null, required: false, scriptWrite: false, name: 'Asset Tag' },
    { id: 'd2', fieldKey: 'udf7', orgId: null, partnerId: 'partner-1', type: 'number', options: null, deviceTypes: null, required: false, scriptWrite: false, name: 'UDF 7' },
  ]);
  const defs = await loadVisibleCustomFieldDefinitions('org-1');
  expect(defs.map((d) => d.fieldKey).sort()).toEqual(['asset_tag', 'udf7']);
  expect(defs.find((d) => d.fieldKey === 'udf7')!.id).toBe('d2');
});

it('loadScriptWritableDefinitions still filters to script_write rows', async () => {
  mockOrgPartner('partner-1');
  mockDefinitions([
    { id: 'd1', fieldKey: 'a', orgId: 'org-1', partnerId: null, scriptWrite: true, type: 'text', options: null, deviceTypes: null, required: false, name: 'A' },
    { id: 'd2', fieldKey: 'b', orgId: 'org-1', partnerId: null, scriptWrite: false, type: 'text', options: null, deviceTypes: null, required: false, name: 'B' },
  ]);
  expect((await loadScriptWritableDefinitions('org-1')).map((d) => d.fieldKey)).toEqual(['a', 'b']);
  // note: the CALLER (scriptWriteBack) applies the script_write gate per field,
  // so this loader intentionally returns both — assert the existing contract,
  // do not silently change it.
});
```

Read `scriptWriteBack.ts:104-107` before writing the second assertion: the `script_write` gate is applied **by the caller**, per field, so the loader returns both rows today. Assert the *shipped* behaviour; do not change it in this wave.

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/services/customFields/queries.test.ts
```

Expected: FAIL — `loadVisibleCustomFieldDefinitions` is not exported.

- [ ] **Step 3: Implement**

Rename the body of `loadScriptWritableDefinitions` to `loadVisibleCustomFieldDefinitions`, widen the projection to the interface above, keep its whole system-context comment block verbatim (it explains the only correct form), and re-export:

```ts
/**
 * The script write-back loader, kept as a named alias so callers that only
 * care about script-writable fields keep reading as they did. The script_write
 * gate itself stays where it is — applied per field by scriptWriteBack.ts, so
 * a field that exists but is not writable is REJECTED with
 * 'not_script_writable' rather than reported as 'unknown_field'.
 */
export const loadScriptWritableDefinitions = loadVisibleCustomFieldDefinitions;
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/api && npx vitest run src/services/customFields/
```

Expected: PASS, including the existing `scriptWriteBack.test.ts` untouched.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/customFields/queries.ts apps/api/src/services/customFields/queries.test.ts
git commit -m "refactor(api): generalise the bounded custom-field definition lookup

Refs #3257"
```

### Task 2: Validate on `PATCH /devices/:id/custom-fields`

**Files:**
- Modify: `apps/api/src/routes/devices/customFieldValues.ts`
- Test: `apps/api/src/routes/devices/customFieldValues.test.ts`

**Interfaces:**
- Produces: 400 `{ error, code: 'invalid-custom-field-value', fields: Array<{ fieldKey: string; reason: CustomFieldValueRejection | 'unknown_field' }> }` when any key fails; nothing is written when any key fails (all-or-nothing per request, unlike the importer's per-value partial apply — a single PATCH is one operator action, not a bulk load).

- [ ] **Step 1: Write the failing tests**

```ts
it('rejects a value whose type does not match its definition', async () => {
  mockVisibleDefinitions([{ id: 'd1', fieldKey: 'rack_units', type: 'number', options: null, deviceTypes: null, required: false, scriptWrite: false, name: 'Rack Units', orgId: ORG_ID, partnerId: null }]);
  const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
    method: 'PATCH', headers: JSON_HEADERS,
    body: JSON.stringify({ rack_units: 'abc' }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({
    code: 'invalid-custom-field-value',
    fields: [{ fieldKey: 'rack_units', reason: 'invalid_type' }],
  });
  expect(db.update).not.toHaveBeenCalled();
});

it('rejects a key with no visible definition', async () => {
  mockVisibleDefinitions([]);
  const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ nope: 'x' }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).fields).toEqual([{ fieldKey: 'nope', reason: 'unknown_field' }]);
});

it('rejects a dropdown value outside options.choices', async () => {
  mockVisibleDefinitions([{ id: 'd1', fieldKey: 'tier', type: 'dropdown',
    options: { choices: [{ label: 'Gold', value: 'gold' }] },
    deviceTypes: null, required: false, scriptWrite: false, name: 'Tier', orgId: ORG_ID, partnerId: null }]);
  const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ tier: 'bronze' }),
  });
  expect((await res.json()).fields).toEqual([{ fieldKey: 'tier', reason: 'not_a_choice' }]);
});

it('stores the COERCED value, not the raw string', async () => {
  mockVisibleDefinitions([{ id: 'd1', fieldKey: 'rack_units', type: 'number', options: null, deviceTypes: null, required: false, scriptWrite: false, name: 'Rack Units', orgId: ORG_ID, partnerId: null }]);
  let written: any;
  (db.update as any).mockReturnValue({ set: (v: any) => { written = v; return { where: () => ({ returning: async () => [{ customFields: v.customFields }] }) }; } });
  await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ rack_units: '4' }),
  });
  expect(written.customFields.rack_units).toBe(4);
});

it('rejects an API-key write that fails validation, same as a session write', async () => {
  // The API-key branch is the trivially scriptable one; validating only the
  // JWT branch would leave the interesting path open.
  mockVisibleDefinitions([{ id: 'd1', fieldKey: 'rack_units', type: 'number', options: null, deviceTypes: null, required: false, scriptWrite: false, name: 'Rack Units', orgId: ORG_ID, partnerId: null }]);
  const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
    method: 'PATCH', headers: { ...JSON_HEADERS, 'X-API-Key': 'k-1' },
    body: JSON.stringify({ rack_units: 'abc' }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run and watch all five fail**

```bash
cd apps/api && npx vitest run src/routes/devices/customFieldValues.test.ts
```

Expected: FAIL — every write currently succeeds unvalidated.

- [ ] **Step 3: Implement**

In the PATCH handler, after `loadAccessibleDevice` and before the merge:

```ts
import { loadVisibleCustomFieldDefinitions } from '../../services/customFields/queries';
import { validateCustomFieldValue, type CustomFieldValueRejection } from '../../services/customFields/validateValue';

// …
// Validate every key against its definition BEFORE merging. Custom-field
// values are an execution sink (installerVariables substitutes them into
// installer command lines) and a targeting control (filterEngine's
// custom.<key> selects deployment targets), so an unconstrained
// Record<string, string|number|boolean|null> was the wrong contract on both
// branches of dualAuth (#3257 W04). The definitions lookup deliberately runs
// in a bounded SYSTEM context: an org-scoped caller cannot see partner-wide
// definitions under RLS, and most fields are partner-wide.
const definitions = await loadVisibleCustomFieldDefinitions(device.orgId);
const byKey = new Map(definitions.map((d) => [d.fieldKey, d]));
const rejected: Array<{ fieldKey: string; reason: CustomFieldValueRejection | 'unknown_field' }> = [];
const coerced: Record<string, string | number | boolean | null> = {};

for (const [fieldKey, raw] of Object.entries(updates)) {
  const definition = byKey.get(fieldKey);
  if (!definition) { rejected.push({ fieldKey, reason: 'unknown_field' }); continue; }
  const result = validateCustomFieldValue(definition, raw);
  if (!result.ok) { rejected.push({ fieldKey, reason: result.reason }); continue; }
  coerced[fieldKey] = result.value;
}

// All-or-nothing: one PATCH is one operator action. The IMPORTER applies
// partially (spec §6.1) because a 30-column row is a bulk load, not an action.
if (rejected.length > 0) {
  return c.json({
    error: 'One or more custom field values are invalid for their definition',
    code: 'invalid-custom-field-value',
    fields: rejected,
  }, 400);
}

const merged = { ...readExistingCustomFields(device.customFields), ...coerced };
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/api && npx vitest run src/routes/devices/customFieldValues
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/customFieldValues.ts apps/api/src/routes/devices/customFieldValues.test.ts
git commit -m "feat(api): validate custom-field values against their definition on PATCH /devices/:id/custom-fields

Refs #3257"
```

### Task 3: Validate on `PATCH /devices/:id`

`routes/devices/core.ts` merges `updateDeviceSchema.customFields` straight into the jsonb. Same treatment, same helper, same error shape.

**Files:**
- Modify: `apps/api/src/routes/devices/core.ts` (the `customFields` branch of the device PATCH)
- Test: `apps/api/src/routes/devices/core.permissions.test.ts` or a new `core.customFieldValidation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('rejects an invalid custom field on PATCH /devices/:id and writes nothing', async () => {
  mockVisibleDefinitions([{ id: 'd1', fieldKey: 'purchase_date', type: 'date', options: null, deviceTypes: null, required: false, scriptWrite: false, name: 'Purchase Date', orgId: ORG_ID, partnerId: null }]);
  const res = await app.request(`/devices/${DEVICE_ID}`, {
    method: 'PATCH', headers: JSON_HEADERS,
    body: JSON.stringify({ customFields: { purchase_date: 'never' } }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('invalid-custom-field-value');
  expect(db.update).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/devices/core.customFieldValidation.test.ts
```

- [ ] **Step 3: Extract the shared guard and use it in both routes**

To avoid two copies, put the loop in `services/customFields/validateValueMap.ts`:

```ts
import { loadVisibleCustomFieldDefinitions } from './queries';
import { validateCustomFieldValue, type CustomFieldValueRejection } from './validateValue';

export type CustomFieldMapRejection = { fieldKey: string; reason: CustomFieldValueRejection | 'unknown_field' };
export type CustomFieldMapResult =
  | { ok: true; values: Record<string, string | number | boolean | null> }
  | { ok: false; rejected: CustomFieldMapRejection[] };

/**
 * Validate and coerce a whole custom-field map for ONE device's org.
 * All-or-nothing by design — see the note in customFieldValues.ts.
 */
export async function validateCustomFieldMap(
  orgId: string,
  updates: Record<string, unknown>,
): Promise<CustomFieldMapResult> { /* the loop from Task 2 */ }

export const INVALID_CUSTOM_FIELD_VALUE_MESSAGE =
  'One or more custom field values are invalid for their definition';
```

Rewrite Task 2's inline loop to call it, then call it from `core.ts` too. Re-run Task 2's suite to prove the extraction is behaviour-preserving.

- [ ] **Step 4: Run both suites**

```bash
cd apps/api && npx vitest run src/routes/devices/customFieldValues src/routes/devices/core.customFieldValidation.test.ts src/services/customFields/
```

- [ ] **Step 5: Commit and open the wave PR**

```bash
git add apps/api/src/services/customFields/validateValueMap.ts apps/api/src/routes/devices/core.ts \
        apps/api/src/routes/devices/core.customFieldValidation.test.ts apps/api/src/routes/devices/customFieldValues.ts
git commit -m "feat(api): validate custom-field values on PATCH /devices/:id too

Refs #3257"
```

PR body: **release note required** — `PATCH /devices/:id` and `PATCH /devices/:id/custom-fields` now reject a value that does not match its definition's declared type, with `code: 'invalid-custom-field-value'` and a per-field reason list. Callers that were storing free-form strings under a `number` or `dropdown` field will start getting 400s.

---

# Wave 05 — `device_custom_field_values`: normalize, project, backfill, register

**Depends on W03** — the anti-shadowing trigger is what makes the projection lossless and the backfill unambiguous. Do not start this wave before W03 is merged.

Open Decision 1 resolved to **A**: values become a real table; `devices.custom_fields` stays as a **trigger-maintained projection**, so the ~34 JS readers, both partner-export statement triggers and the MCP `SAFE_DEVICE_RESOURCE_FIELDS` projection keep working unchanged. Only three SQL consumers are rewritten. Retrofitting this *after* backfilling 300k imported values is strictly worse than doing it before, which is why it precedes the importer.

Four things this closes that are live defects today: the partner export emits two records for one datum under a collided key (`partnerApi/configuration.ts:428-441`); `devices.custom_fields` is `excludedOpen` in `tenantExportPolicyRegistry.ts:187`, so every custom-field value is silently dropped from the GDPR tenant export; `custom.<key>` filters do an unindexed `jsonb_extract_path_text` scan; and deleting a definition orphans every value stored under it forever.

### Task 1: The table, its constraints, and its two triggers

**Files:**
- Create: `apps/api/migrations/2026-10-09-100000-device-custom-field-values.sql`
- Test: `apps/api/src/__tests__/integration/deviceCustomFieldValues.integration.test.ts`

**Interfaces:**
- Produces: table `device_custom_field_values`; function `public.breeze_device_custom_field_value_coherent()`; function `public.breeze_device_custom_field_project()`; triggers `device_custom_field_values_coherent` (BEFORE INSERT/UPDATE FOR EACH ROW) and `device_custom_field_values_project_{ins,upd,del}` (AFTER … FOR EACH STATEMENT with transition tables).

**Design notes the implementer must not "simplify" away.**

- `field_key` is a **real denormalized `NOT NULL` column**, not a join. Two reasons. (1) The GDPR tenant export reads each table with a bare `SELECT <columns> FROM <table> WHERE <orgKey> = $1` and no joins (`services/tenantExport.ts:149-163`), so a `definition_id`-only row exports as an opaque uuid the data subject cannot read — and partner-wide definitions have `org_id IS NULL`, so they are not in the export at all. The spec's suggested `specific` export policy cannot fix this: `specific` assigns a *decision* to an existing column, it cannot add one. (2) The projection trigger needs the key to rebuild the jsonb, and reading it off the row avoids a join to `custom_field_definitions` on every write.
- The composite FK to `devices(id, org_id)` is `ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED`, copying `device_mtls_certificates` (`2026-08-06-d-…:79-85`). Both halves are load-bearing: `moveOrg.ts:214` flips the **device row first** and re-stamps child `org_id`s at `:352`, so an immediate FK fails at step one; and `orgLifecycleFoundations.integration.test.ts` fails any composite FK referencing an `org_id` column that is not deferrable.
- The projection **preserves unmanaged legacy keys**. A key in `devices.custom_fields` with no visible definition cannot be represented in the table (the FK needs a `definition_id`), and the backfill mints a definition only for keys matching the enforced `^[a-z][a-z0-9_]*$` pattern. A camelCase key can be *read* but was never creatable, so a few may exist in the wild. Rebuilding the jsonb purely from the table would silently delete them. The trigger therefore keeps every key that has no visible definition and overlays the projected ones.
- `value_*` columns are mutually exclusive but **all-NULL is legal** — that is how an explicitly-cleared value is stored, matching `customFieldValueSchema`'s `z.null()`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/__tests__/integration/deviceCustomFieldValues.integration.test.ts`:

```ts
describe('device_custom_field_values', () => {
  it('projects a written value into devices.custom_fields', async () => {
    await sys(() => db.execute(sql`
      INSERT INTO device_custom_field_values (device_id, org_id, definition_id, field_key, value_text)
      VALUES (${deviceId}::uuid, ${orgId}::uuid, ${defId}::uuid, 'asset_tag', 'AB-1234')`));
    const [row]: any = await sys(() => db.execute(sql`
      SELECT custom_fields FROM devices WHERE id = ${deviceId}::uuid`));
    expect(row.custom_fields).toMatchObject({ asset_tag: 'AB-1234' });
  });

  it('bumps devices.partner_export_updated_at when the projection changes', async () => {
    const before = await readExportStamp(deviceId);
    await sys(() => db.execute(sql`
      UPDATE device_custom_field_values SET value_text = 'AB-9999'
       WHERE device_id = ${deviceId}::uuid AND field_key = 'asset_tag'`));
    expect(await readExportStamp(deviceId)).not.toEqual(before);
  });

  it('removes the key from the projection when the value row is deleted', async () => {
    await sys(() => db.execute(sql`
      DELETE FROM device_custom_field_values WHERE device_id = ${deviceId}::uuid`));
    const [row]: any = await sys(() => db.execute(sql`
      SELECT custom_fields FROM devices WHERE id = ${deviceId}::uuid`));
    expect(row.custom_fields).not.toHaveProperty('asset_tag');
  });

  it('preserves a legacy jsonb key that has no definition', async () => {
    await sys(() => db.execute(sql`
      UPDATE devices SET custom_fields = custom_fields || '{"legacyCamelKey":"keep me"}'::jsonb
       WHERE id = ${deviceId}::uuid`));
    await sys(() => db.execute(sql`
      INSERT INTO device_custom_field_values (device_id, org_id, definition_id, field_key, value_text)
      VALUES (${deviceId}::uuid, ${orgId}::uuid, ${defId}::uuid, 'asset_tag', 'AB-1234')`));
    const [row]: any = await sys(() => db.execute(sql`
      SELECT custom_fields FROM devices WHERE id = ${deviceId}::uuid`));
    expect(row.custom_fields).toMatchObject({ asset_tag: 'AB-1234', legacyCamelKey: 'keep me' });
  });

  it('refuses a row whose device belongs to another org (composite FK)', async () => {
    await expect(sys(() => db.execute(sql`
      INSERT INTO device_custom_field_values (device_id, org_id, definition_id, field_key, value_text)
      VALUES (${deviceId}::uuid, ${otherOrgId}::uuid, ${defId}::uuid, 'asset_tag', 'x')`)))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('refuses a definition_id owned by ANOTHER partner (coherence trigger)', async () => {
    await expect(sys(() => db.execute(sql`
      INSERT INTO device_custom_field_values (device_id, org_id, definition_id, field_key, value_text)
      VALUES (${deviceId}::uuid, ${orgId}::uuid, ${foreignPartnerDefId}::uuid, 'udf7', 'x')`)))
      .rejects.toMatchObject({ code: 'P0001' });
  });

  it('refuses a field_key that disagrees with its definition', async () => {
    await expect(sys(() => db.execute(sql`
      INSERT INTO device_custom_field_values (device_id, org_id, definition_id, field_key, value_text)
      VALUES (${deviceId}::uuid, ${orgId}::uuid, ${defId}::uuid, 'wrong_key', 'x')`)))
      .rejects.toMatchObject({ code: 'P0001' });
  });

  it('cascade-deletes values when their definition is deleted', async () => {
    await sys(() => db.execute(sql`DELETE FROM custom_field_definitions WHERE id = ${defId}::uuid`));
    const rows = await sys(() => db.execute(sql`
      SELECT 1 FROM device_custom_field_values WHERE definition_id = ${defId}::uuid`));
    expect(rows).toHaveLength(0);
  });

  it('refuses two value columns on one row', async () => {
    await expect(sys(() => db.execute(sql`
      INSERT INTO device_custom_field_values (device_id, org_id, definition_id, field_key, value_text, value_number)
      VALUES (${deviceId}::uuid, ${orgId}::uuid, ${defId}::uuid, 'asset_tag', 'x', 1)`)))
      .rejects.toMatchObject({ code: '23514' });
  });
});
```

- [ ] **Step 2: Run it and watch every test fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceCustomFieldValues.integration.test.ts
```

Expected: FAIL — relation `device_custom_field_values` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- 2026-10-09-100000-device-custom-field-values.sql
-- Promote device custom-field VALUES out of the devices.custom_fields jsonb
-- into a real table (#3257, Open Decision 1 = A), keeping the jsonb as a
-- trigger-maintained PROJECTION so the ~34 JS readers, the MCP resource
-- projection and BOTH partner-export statement triggers keep working unchanged.
--
-- What this closes, all live today:
--   * the partner export emits TWO records for one datum when an org-owned and
--     a partner-wide definition share a field_key (the identity hash includes
--     f.id — partnerApi/configuration.ts:433,440). W03's anti-shadowing trigger
--     already forbids new ones; this removes the shape entirely.
--   * devices.custom_fields is excludedOpen in the tenant-export policy, so
--     every custom-field value is silently DROPPED from the GDPR export.
--   * custom.<key> filters scan with jsonb_extract_path_text and no index.
--   * deleting a definition orphans every value stored under it, forever.
--
-- Tenancy: RLS shape 5 (device-id scoped, hot, DENORMALIZED org_id) — a direct
-- breeze_has_org_access(org_id) policy, not an EXISTS join. A direct-org_id
-- policy TRUSTS org_id, so two coherence guards sit under it: a composite FK to
-- devices(id, org_id), and a trigger for definition_id (which is dual-axis and
-- therefore not expressible as a single FK).

CREATE TABLE IF NOT EXISTS device_custom_field_values (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     uuid NOT NULL,
  org_id        uuid NOT NULL,
  definition_id uuid NOT NULL REFERENCES custom_field_definitions (id) ON DELETE CASCADE,
  -- Denormalized deliberately. tenantExport.ts readOrgRows is a bare column
  -- projection with NO joins, so a definition_id-only row exports as an opaque
  -- uuid the data subject cannot read — and a partner-wide definition has
  -- org_id NULL, so it is not in their export at all. It also lets the
  -- projection trigger rebuild the jsonb without joining the definitions table.
  -- Kept honest by the coherence trigger below.
  field_key     varchar(100) NOT NULL,
  value_text    text,
  value_number  double precision,
  value_bool    boolean,
  value_date    date,
  -- 'manual' | 'api' | 'script' | 'import' | 'backfill'
  source        varchar(32) NOT NULL DEFAULT 'manual',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- ALL-NULL is legal: that is an explicitly cleared value, which
  -- customFieldValueSchema has always accepted as z.null().
  CONSTRAINT device_custom_field_values_one_value_chk CHECK (
    (value_text IS NOT NULL)::int + (value_number IS NOT NULL)::int
  + (value_bool IS NOT NULL)::int + (value_date IS NOT NULL)::int <= 1
  )
);

-- ON UPDATE CASCADE + DEFERRABLE, copying device_mtls_certificates
-- (2026-08-06-d-device-mtls-certificate-history.sql:79-85). Both halves matter:
-- moveOrg.ts:214 flips the DEVICE row first and re-stamps children at :352, so
-- an immediate FK fails at step one; and orgLifecycleFoundations.integration
-- .test.ts fails ANY composite FK referencing an org_id column that is not
-- deferrable (the org merge runs SET CONSTRAINTS ALL DEFERRED).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_custom_field_values_device_org_fk') THEN
    ALTER TABLE device_custom_field_values
      ADD CONSTRAINT device_custom_field_values_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices (id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS device_custom_field_values_device_def_uq
  ON device_custom_field_values (device_id, definition_id);
-- The index custom.<key> filters have never had.
CREATE INDEX IF NOT EXISTS device_custom_field_values_org_key_text_idx
  ON device_custom_field_values (org_id, field_key, value_text);
CREATE INDEX IF NOT EXISTS device_custom_field_values_definition_idx
  ON device_custom_field_values (definition_id);
CREATE INDEX IF NOT EXISTS device_custom_field_values_device_idx
  ON device_custom_field_values (device_id);

ALTER TABLE device_custom_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_custom_field_values FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_custom_field_values;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_custom_field_values;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_custom_field_values;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_custom_field_values;
CREATE POLICY breeze_org_isolation_select ON device_custom_field_values FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_custom_field_values FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_custom_field_values FOR UPDATE
  USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_custom_field_values FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON device_custom_field_values TO breeze_app;

-- ── Coherence: definition_id must be visible to this row's org ──────────────
-- The definition is DUAL-AXIS, so there is no single-FK way to say this. Left
-- purely app-layer, a partner-wide udf7 belonging to partner B could be
-- attached to a device in partner A's org and the direct-org_id RLS policy
-- would not notice.
CREATE OR REPLACE FUNCTION public.breeze_device_custom_field_value_coherent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE def_org uuid; def_partner uuid; def_key varchar(100); row_partner uuid;
BEGIN
  SELECT f.org_id, f.partner_id, f.field_key INTO def_org, def_partner, def_key
    FROM public.custom_field_definitions f WHERE f.id = NEW.definition_id;
  IF def_key IS NULL THEN
    RAISE EXCEPTION 'custom field definition % does not exist', NEW.definition_id
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.field_key <> def_key THEN
    RAISE EXCEPTION 'field_key "%" disagrees with definition % ("%")', NEW.field_key, NEW.definition_id, def_key
      USING ERRCODE = 'P0001';
  END IF;
  IF def_org IS NOT NULL THEN
    IF def_org <> NEW.org_id THEN
      RAISE EXCEPTION 'custom field definition % belongs to a different organization', NEW.definition_id
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT o.partner_id INTO row_partner FROM public.organizations o WHERE o.id = NEW.org_id;
    IF row_partner IS NULL OR row_partner <> def_partner THEN
      RAISE EXCEPTION 'custom field definition % belongs to a different partner', NEW.definition_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS device_custom_field_values_coherent ON device_custom_field_values;
CREATE TRIGGER device_custom_field_values_coherent
  BEFORE INSERT OR UPDATE ON device_custom_field_values
  FOR EACH ROW EXECUTE FUNCTION public.breeze_device_custom_field_value_coherent();

-- ── Projection: rebuild devices.custom_fields for touched devices ───────────
-- Statement-level with transition tables, matching the partner-export triggers'
-- shape. The UPDATE on devices is what fires
-- breeze_partner_export_devices_update (whose comparison tuple INCLUDES
-- custom_fields), so the export stamp and the per-org advisory lock behave
-- exactly as they did when the jsonb was written directly.
--
-- Keys with NO visible definition are PRESERVED. They cannot live in this table
-- (the FK needs a definition_id) and the backfill can only mint a definition
-- for a key matching the enforced ^[a-z][a-z0-9_]*$ pattern, so a camelCase key
-- written before that pattern was enforced would otherwise be silently deleted.
CREATE OR REPLACE FUNCTION public.breeze_device_custom_field_project()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE device_ids uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT device_id) INTO device_ids FROM old_rows;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT device_id) INTO device_ids FROM new_rows;
  ELSE
    SELECT array_agg(DISTINCT id) INTO device_ids
      FROM (SELECT device_id AS id FROM old_rows UNION SELECT device_id FROM new_rows) u;
  END IF;
  IF COALESCE(array_length(device_ids, 1), 0) = 0 THEN RETURN NULL; END IF;

  UPDATE public.devices d
     SET custom_fields = projected.obj, updated_at = now()
    FROM (
      SELECT d2.id AS device_id,
             COALESCE(unmanaged.obj, '{}'::jsonb) || COALESCE(managed.obj, '{}'::jsonb) AS obj
        FROM public.devices d2
        JOIN public.organizations o ON o.id = d2.org_id
        LEFT JOIN LATERAL (
          SELECT jsonb_object_agg(e.k, e.v) AS obj
            FROM jsonb_each(COALESCE(d2.custom_fields, '{}'::jsonb)) e(k, v)
           WHERE NOT EXISTS (
             SELECT 1 FROM public.custom_field_definitions f
              WHERE f.field_key = e.k
                AND (f.org_id = d2.org_id OR (f.org_id IS NULL AND f.partner_id = o.partner_id)))
        ) unmanaged ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_object_agg(
                   v.field_key,
                   COALESCE(to_jsonb(v.value_text), to_jsonb(v.value_number),
                            to_jsonb(v.value_bool), to_jsonb(v.value_date::text), 'null'::jsonb)
                 ) AS obj
            FROM public.device_custom_field_values v
           WHERE v.device_id = d2.id
        ) managed ON true
       WHERE d2.id = ANY(device_ids)
    ) projected
   WHERE d.id = projected.device_id
     AND d.custom_fields IS DISTINCT FROM projected.obj;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS device_custom_field_values_project_ins ON device_custom_field_values;
DROP TRIGGER IF EXISTS device_custom_field_values_project_upd ON device_custom_field_values;
DROP TRIGGER IF EXISTS device_custom_field_values_project_del ON device_custom_field_values;
CREATE TRIGGER device_custom_field_values_project_ins
  AFTER INSERT ON device_custom_field_values
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.breeze_device_custom_field_project();
CREATE TRIGGER device_custom_field_values_project_upd
  AFTER UPDATE ON device_custom_field_values
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.breeze_device_custom_field_project();
CREATE TRIGGER device_custom_field_values_project_del
  AFTER DELETE ON device_custom_field_values
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.breeze_device_custom_field_project();
```

- [ ] **Step 4: Apply and re-run**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceCustomFieldValues.integration.test.ts
```

Expected: PASS ×9.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-09-100000-device-custom-field-values.sql \
        apps/api/src/__tests__/integration/deviceCustomFieldValues.integration.test.ts
git commit -m "feat(api): device_custom_field_values table with coherence and projection triggers

Refs #3257"
```

### Task 2: Backfill the existing jsonb, minting definitions for orphan keys

Appended to the **same migration file** — it must not be a separate one, because between the two files the projection trigger would rebuild every device's jsonb from an empty table and erase the data.

> **Order matters inside the file:** the backfill has to run *before* any statement that touches `device_custom_field_values`, and its `INSERT` fires the projection trigger, which is harmless because the projection recomputes the same object it read from.

- [ ] **Step 1: Write the failing assertion first**

Add to the integration suite:

```ts
it('backfills an existing jsonb value into the table without changing the projection', async () => {
  // seeded by the migration replay in the suite's beforeAll
  const [v]: any = await sys(() => db.execute(sql`
    SELECT value_text, source FROM device_custom_field_values
     WHERE device_id = ${legacyDeviceId}::uuid AND field_key = 'asset_tag'`));
  expect(v).toMatchObject({ value_text: 'LEGACY-1', source: 'backfill' });
  const [d]: any = await sys(() => db.execute(sql`
    SELECT custom_fields FROM devices WHERE id = ${legacyDeviceId}::uuid`));
  expect(d.custom_fields).toMatchObject({ asset_tag: 'LEGACY-1' });
});

it('mints an org-owned text definition for a snake_case key with no definition', async () => {
  const [f]: any = await sys(() => db.execute(sql`
    SELECT type, name, org_id FROM custom_field_definitions
     WHERE field_key = 'orphan_key' AND org_id = ${orgId}::uuid`));
  expect(f).toMatchObject({ type: 'text', org_id: orgId });
});
```

- [ ] **Step 2: Append the backfill to the migration**

```sql
-- ── Backfill ────────────────────────────────────────────────────────────────
-- MANAGED POSTGRES: without this the whole backfill is a silent 0-row no-op as
-- doadmin, because devices/custom_field_definitions are RLS-forced and there is
-- no ambient context in a migration. CI's superuser masks it.
SET LOCAL breeze.scope = 'system';

-- 1. Mint an org-owned text definition for every stored key that has no visible
--    definition and CAN be created (the enforced ^[a-z][a-z0-9_]*$ pattern).
--    Not doing this would strand those values: the FK needs a definition_id.
--    A camelCase key cannot be minted (the pattern is enforced on every create
--    path) and is instead PRESERVED by the projection trigger's unmanaged
--    branch — reported below so the count is on the record either way.
DO $$
DECLARE n bigint;
BEGIN
  WITH stored AS (
    SELECT DISTINCT d.org_id, o.partner_id, e.k AS field_key
      FROM public.devices d
      JOIN public.organizations o ON o.id = d.org_id
      CROSS JOIN LATERAL jsonb_each(COALESCE(d.custom_fields, '{}'::jsonb)) e(k, v)
     WHERE d.custom_fields IS NOT NULL AND d.custom_fields <> '{}'::jsonb
  ), minted AS (
    INSERT INTO public.custom_field_definitions (org_id, name, field_key, type)
    SELECT s.org_id, s.field_key, s.field_key, 'text'
      FROM stored s
     WHERE s.field_key ~ '^[a-z][a-z0-9_]*$'
       AND NOT EXISTS (
         SELECT 1 FROM public.custom_field_definitions f
          WHERE f.field_key = s.field_key
            AND (f.org_id = s.org_id OR (f.org_id IS NULL AND f.partner_id = s.partner_id)))
    RETURNING 1
  )
  SELECT count(*) INTO n FROM minted;
  RAISE WARNING 'device_custom_field_values backfill: minted % definitions for previously undefined keys', n;
END $$;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT DISTINCT d.id, e.k
      FROM public.devices d
      CROSS JOIN LATERAL jsonb_each(COALESCE(d.custom_fields, '{}'::jsonb)) e(k, v)
     WHERE e.k !~ '^[a-z][a-z0-9_]*$') x;
  RAISE WARNING 'device_custom_field_values backfill: % stored keys do not match the enforced key pattern and stay in the jsonb projection only', n;
END $$;

-- 2. Copy every stored value in. `type` decides which typed column it lands in;
--    a value that does not parse for its declared type falls back to value_text
--    rather than being dropped — this is a data MOVE, not a validation gate,
--    and validation now happens on the write paths (W04).
DO $$
DECLARE n bigint;
BEGIN
  INSERT INTO public.device_custom_field_values
    (device_id, org_id, definition_id, field_key, value_text, value_number, value_bool, value_date, source)
  SELECT d.id, d.org_id, f.id, f.field_key,
         CASE WHEN f.type IN ('text', 'dropdown') OR jsonb_typeof(e.v) = 'string'
                   AND f.type NOT IN ('number', 'boolean', 'date')
              THEN CASE WHEN jsonb_typeof(e.v) = 'string' THEN e.v #>> '{}' ELSE e.v::text END
              WHEN f.type = 'number' AND (e.v #>> '{}') !~ '^-?\d+(\.\d+)?$'
              THEN e.v #>> '{}'
              WHEN f.type = 'date' AND (e.v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}'
              THEN e.v #>> '{}'
              ELSE NULL END,
         CASE WHEN f.type = 'number' AND (e.v #>> '{}') ~ '^-?\d+(\.\d+)?$'
              THEN (e.v #>> '{}')::double precision ELSE NULL END,
         CASE WHEN f.type = 'boolean' AND lower(e.v #>> '{}') IN ('true', 'false')
              THEN (lower(e.v #>> '{}'))::boolean ELSE NULL END,
         CASE WHEN f.type = 'date' AND (e.v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}'
              THEN left(e.v #>> '{}', 10)::date ELSE NULL END,
         'backfill'
    FROM public.devices d
    JOIN public.organizations o ON o.id = d.org_id
    CROSS JOIN LATERAL jsonb_each(COALESCE(d.custom_fields, '{}'::jsonb)) e(k, v)
    JOIN public.custom_field_definitions f
      ON f.field_key = e.k
     AND (f.org_id = d.org_id OR (f.org_id IS NULL AND f.partner_id = o.partner_id))
   WHERE jsonb_typeof(e.v) <> 'null'
  ON CONFLICT (device_id, definition_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'device_custom_field_values backfill: copied % values out of devices.custom_fields', n;
END $$;
```

> The `CASE` ladder is deliberately verbose rather than clever: every branch says which typed column a value lands in and, crucially, what happens when it does not parse. A silently dropped value here is unrecoverable.

> **W03 is what makes the join in step 2 single-valued.** With cross-axis shadowing forbidden, `f.field_key = e.k AND (org OR partner-wide)` matches at most one definition. Without W03 it could match two and the insert would violate `device_custom_field_values_device_def_uq` — or worse, pick arbitrarily.

- [ ] **Step 3: Replay and verify**

```bash
docker exec -it breeze-postgres psql -U breeze -d breeze -c "DROP TABLE IF EXISTS device_custom_field_values CASCADE"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:seed && pnpm db:migrate
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceCustomFieldValues.integration.test.ts
```

Then re-run `pnpm db:migrate` a second time and confirm the WARNINGs report **0 minted / 0 copied** — re-application must be a true no-op.

- [ ] **Step 4: Verify as `breeze_app`, per the tenancy checklist**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
-- forge a cross-tenant insert; must fail with "new row violates row-level security policy"
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-09-100000-device-custom-field-values.sql \
        apps/api/src/__tests__/integration/deviceCustomFieldValues.integration.test.ts
git commit -m "feat(api): backfill devices.custom_fields into device_custom_field_values

Refs #3257"
```

### Task 3: Drizzle schema and all six registration lists

**This is the step that has shipped broken five times** (#1359, #1351, #1365, #2179, #2514). Code review has caught it 0/5; the contract tests 5/5. Treat it as a mechanical grep, not a judgement call.

**Files:**
- Create: `apps/api/src/db/schema/deviceCustomFieldValues.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`)
- Modify: `apps/api/src/routes/devices/core.ts` (`CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`)
- Modify: `apps/api/src/services/orgMergeRegistry.ts`

- [ ] **Step 1: Write the schema**

```ts
// apps/api/src/db/schema/deviceCustomFieldValues.ts
import { boolean, date, doublePrecision, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { customFieldDefinitions } from './customFields';

/**
 * Device custom-field VALUES (#3257). `devices.custom_fields` remains as a
 * trigger-maintained projection of this table — do NOT write it directly.
 *
 * `field_key` is denormalized on purpose: the tenant export reads each table
 * with a bare column projection and no joins, so a definition_id-only row
 * exports as an opaque uuid; and a partner-wide definition (org_id NULL) is not
 * in the org's export at all. Kept honest by
 * breeze_device_custom_field_value_coherent().
 *
 * Tenancy shape 5 (device-id scoped with denormalized org_id).
 */
export const deviceCustomFieldValues = pgTable('device_custom_field_values', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull(),
  orgId: uuid('org_id').notNull(),
  definitionId: uuid('definition_id').notNull()
    .references(() => customFieldDefinitions.id, { onDelete: 'cascade' }),
  fieldKey: varchar('field_key', { length: 100 }).notNull(),
  valueText: text('value_text'),
  valueNumber: doublePrecision('value_number'),
  valueBool: boolean('value_bool'),
  valueDate: date('value_date'),
  source: varchar('source', { length: 32 }).notNull().default('manual'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  deviceOrgFk: foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'device_custom_field_values_device_org_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  deviceDefUq: uniqueIndex('device_custom_field_values_device_def_uq')
    .on(table.deviceId, table.definitionId),
  orgKeyTextIdx: index('device_custom_field_values_org_key_text_idx')
    .on(table.orgId, table.fieldKey, table.valueText),
  definitionIdx: index('device_custom_field_values_definition_idx').on(table.definitionId),
  deviceIdx: index('device_custom_field_values_device_idx').on(table.deviceId),
}));

export type DeviceCustomFieldValue = typeof deviceCustomFieldValues.$inferSelect;
export type NewDeviceCustomFieldValue = typeof deviceCustomFieldValues.$inferInsert;
```

Export it from `db/schema/index.ts`.

- [ ] **Step 2: Register in all six lists**

```bash
# The mechanical grep. Every hit must be considered, none skipped.
grep -rn "device_hardware" apps/api/src/services/tenantCascade.ts \
  apps/api/src/routes/devices/core.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/services/orgMergeRegistry.ts
```

1. `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts`) — alphabetical, `organizations` last. `device_custom_field_values` sorts between `device_connections` and `device_disks`. **Check the FK direction, not just membership:** it is a leaf (nothing references it), and its parents `devices` and `custom_field_definitions` both sort after it, so children-before-parents holds. `custom_field_definitions` is at `tenantCascade.ts:~200` — verify it still sorts before `device_custom_field_values` (`c` < `d`: yes).
2. `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts`) — add to the "Core device tables" block.
3. `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (same file) — **required**, `moveOrg` must rewrite `org_id`. Insert alphabetically next to `device_connections`. Do **not** add it to `DEVICE_ORG_FK_CASCADE_TABLES`: that list is for tables that revoke app-role UPDATE, which this one does not. The `ON UPDATE CASCADE` already re-stamps it and moveOrg's generic UPDATE is then a harmless no-op — exactly the `device_mtls_certificates` situation.
4. `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts`), alphabetically placed:
   ```ts
   // Closes the gap where devices.custom_fields is excludedOpen and every
   // custom-field value therefore vanished from the tenant export. field_key is
   // denormalized precisely so this projection is readable without a join.
   "device_custom_field_values": tablePolicy("org_id", {"included":["id","device_id","org_id","definition_id","field_key","value_text","value_number","value_bool","value_date","source","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
   ```
   No `json`/`jsonb`/`bytea` column exists on this table — that is deliberate, and an open container must never be added here without accepting that it becomes `excludedOpen`.
5. `orgMergeRegistry.ts` — plain `repoint`: it carries `org_id` and `device_id`, has no per-org uniqueness of its own beyond `(device_id, definition_id)`, and the devices under the loser org repoint with it. Add `"device_custom_field_values"` to `REPOINT_TABLES` alphabetically.
6. `rls-coverage.integration.test.ts` — **no entry needed.** Shape 1 (a direct `org_id` column with a `breeze_has_org_access(org_id)` policy) is auto-discovered. Do not add it to `DEVICE_ID_JOIN_POLICY_TABLES`; that is for the cold `EXISTS`-join tables.

- [ ] **Step 3: Run every contract test**

```bash
cd apps/api
npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```

All must be green. `tenantCascade` asserts five properties (alphabetised by `localeCompare` with `organizations` last; every `org_id` table present; no entry naming a non-existent table; every cascade table exactly once; FK children before parents). Neither export-policy suite can fail in **Test API** — they need a live DB, which is why they are run explicitly here.

- [ ] **Step 4: Add the moveOrg proof**

Add to `apps/api/src/__tests__/integration/deviceMoveOrg.integration.test.ts` (or the existing moveOrg integration suite):

```ts
it('moves a device carrying custom-field values and lands them on the new org', async () => {
  await seedValue(deviceId, sourceOrgId, defId, 'asset_tag', 'AB-1');
  await moveDeviceOrg({ deviceId, targetOrgId, actor });
  const [v]: any = await sys(() => db.execute(sql`
    SELECT org_id FROM device_custom_field_values WHERE device_id = ${deviceId}::uuid`));
  expect(v.org_id).toBe(targetOrgId);
});
```

**Do not assume which mechanism re-stamps it.** The FK is `ON UPDATE CASCADE`, so Postgres may do it before moveOrg's generic loop reaches the table; the test proves the outcome either way, which is the point (the spec says: verify which, with a real integration test that moves a device carrying values).

> Caveat the implementer must handle: an org-owned definition does **not** move with the device. After a cross-org move the value's `definition_id` may point at a definition belonging to the *source* org, which the coherence trigger forbids. Decide and implement one of: (a) moveOrg re-points each value onto the target org's identically-keyed definition and drops values with no counterpart, reporting the count in the move audit; or (b) values under org-owned definitions are deleted on move and reported. **Recommend (a)** — it preserves data, mirrors `rehomeChildrenThenDelete`, and a device moving between two orgs of one MSP almost always finds the same key on the other side. Values under partner-wide definitions need no action. Write this as its own test before implementing it.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/deviceCustomFieldValues.ts apps/api/src/db/schema/index.ts \
        apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts \
        apps/api/src/routes/devices/moveOrg.ts apps/api/src/__tests__/integration/
git commit -m "feat(api): register device_custom_field_values in all six tenancy lists

Refs #3257"
```

### Task 4: Move both existing writers onto the table

The spec's second hole in Option B: without this, the "source of truth" is bypassed on day one by the two shipped write paths. `routes/devices/customFieldValues.ts` and `routes/devices/core.ts` both merge into the jsonb directly, and `services/customFields/queries.ts` `persistDeviceCustomFields` does the same for the script path.

**Files:**
- Modify: `apps/api/src/services/customFields/queries.ts` — replace `persistDeviceCustomFields` with `persistDeviceCustomFieldValues`
- Modify: `apps/api/src/routes/devices/customFieldValues.ts`, `apps/api/src/routes/devices/core.ts`, `apps/api/src/services/customFields/scriptWriteBack.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CustomFieldValueWrite {
    definitionId: string;
    fieldKey: string;
    type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
    value: string | number | boolean | null;
  }
  /** Upserts on (device_id, definition_id). Returns the keys actually changed. */
  export async function persistDeviceCustomFieldValues(
    deviceId: string,
    orgId: string,
    writes: CustomFieldValueWrite[],
    source: 'manual' | 'api' | 'script' | 'import',
  ): Promise<string[]>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
it('writes through device_custom_field_values, not the jsonb', async () => {
  const changed = await persistDeviceCustomFieldValues(deviceId, orgId, [
    { definitionId: defId, fieldKey: 'asset_tag', type: 'text', value: 'AB-1' },
  ], 'api');
  expect(changed).toEqual(['asset_tag']);
  const [v]: any = await sys(() => db.execute(sql`
    SELECT value_text, source FROM device_custom_field_values WHERE device_id = ${deviceId}::uuid`));
  expect(v).toMatchObject({ value_text: 'AB-1', source: 'api' });
});

it('is a no-op when the stored value already equals the incoming one', async () => {
  await persistDeviceCustomFieldValues(deviceId, orgId, [
    { definitionId: defId, fieldKey: 'asset_tag', type: 'text', value: 'AB-1' }], 'api');
  const before = await readExportStamp(deviceId);
  const changed = await persistDeviceCustomFieldValues(deviceId, orgId, [
    { definitionId: defId, fieldKey: 'asset_tag', type: 'text', value: 'AB-1' }], 'api');
  expect(changed).toEqual([]);
  // The compare-before-write is not cosmetic: an UPDATE that changes
  // custom_fields fires breeze_partner_export_devices_update, which takes an
  // EXCLUSIVE per-org advisory lock held to transaction end. A fleet-wide
  // rewrite of unchanged values would serialise the whole org.
  expect(await readExportStamp(deviceId)).toEqual(before);
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceCustomFieldValues.integration.test.ts
```

- [ ] **Step 3: Implement the writer**

```ts
export async function persistDeviceCustomFieldValues(
  deviceId: string, orgId: string, writes: CustomFieldValueWrite[],
  source: 'manual' | 'api' | 'script' | 'import',
): Promise<string[]> {
  if (writes.length === 0) return [];
  const changed: string[] = [];
  for (const w of writes) {
    const columns = valueColumnsFor(w.type, w.value); // { valueText, valueNumber, valueBool, valueDate }
    const updated = await db
      .insert(deviceCustomFieldValues)
      .values({ deviceId, orgId, definitionId: w.definitionId, fieldKey: w.fieldKey, source, ...columns })
      .onConflictDoUpdate({
        target: [deviceCustomFieldValues.deviceId, deviceCustomFieldValues.definitionId],
        set: { ...columns, source, updatedAt: new Date() },
        // Compare BEFORE writing. An unchanged row means no UPDATE, which means
        // the projection trigger takes no per-org advisory lock and writes no
        // WAL — the same reasoning scriptWriteBack.ts already documents.
        setWhere: sql`
          ${deviceCustomFieldValues.valueText} IS DISTINCT FROM ${columns.valueText}
       OR ${deviceCustomFieldValues.valueNumber} IS DISTINCT FROM ${columns.valueNumber}
       OR ${deviceCustomFieldValues.valueBool} IS DISTINCT FROM ${columns.valueBool}
       OR ${deviceCustomFieldValues.valueDate} IS DISTINCT FROM ${columns.valueDate}`,
      })
      .returning({ fieldKey: deviceCustomFieldValues.fieldKey });
    if (updated.length > 0) changed.push(w.fieldKey);
  }
  return changed;
}
```

`valueColumnsFor` maps `type` + `value` onto exactly one typed column (or all-null when `value === null`) — a small pure function with its own unit test covering all five types plus null.

- [ ] **Step 4: Rewire the three callers**

Each already resolves the definition (W04's `validateCustomFieldMap` returns the coerced map; extend it to also return the matched `VisibleCustomFieldDefinition` so the caller has `definitionId` and `type` without a second lookup). Replace each `db.update(devices).set({ customFields: merged })` with a `persistDeviceCustomFieldValues` call. **Leave the audit writes exactly as they are** — same action, same `changedFields`, same synchronous-vs-async choice per path.

For `scriptWriteBack.ts`, the existing compare-before-write block becomes redundant (the writer does it) — delete it and keep the comment's reasoning on the writer.

- [ ] **Step 5: Run everything that touches custom fields**

```bash
cd apps/api
npx vitest run src/routes/devices/customFieldValues src/services/customFields/ src/services/commandResultHandlers.customFields.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptCustomFieldWriteBack.integration.test.ts src/__tests__/integration/deviceCustomFieldValues.integration.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/customFields apps/api/src/routes/devices
git commit -m "refactor(api): all three custom-field writers go through device_custom_field_values

Refs #3257"
```

### Task 5: Rewrite the three SQL consumers, and prove the export defect is gone

**Files:**
- Modify: `apps/api/src/services/filterEngine.ts:175-182`
- Modify: `apps/api/src/routes/partnerApi/configuration.ts:428-441`
- Modify: `apps/api/src/services/orgMergeCustomExecutors.ts` (uncomment the W02 child)
- Test: `apps/api/src/routes/partnerApi/configuration.test.ts` + an integration assertion

- [ ] **Step 1: Write the export regression test against TODAY's code and watch it fail**

The spec is explicit that this one is written red first, against the pre-fix code.

```ts
it('emits exactly one partner-export record per datum when two definitions share a key', async () => {
  // Pre-W03 shape, forged in a system context so the anti-shadowing trigger is
  // bypassed — this is the historical data the fix has to survive.
  await sysNoTriggers(() => seedOrgDefinition(orgId, 'udf7'));
  await sysNoTriggers(() => seedPartnerDefinition(partnerId, 'udf7'));
  await seedValue(deviceId, orgId, orgDefId, 'udf7', 'ONE');

  const records = await runCustomFieldValueExport({ partnerId });
  expect(records.filter((r) => r.fieldKey === 'udf7')).toHaveLength(1);
});
```

- [ ] **Step 2: Rewrite `customFieldValueSource`**

```sql
WITH effective_orgs AS (…),
value_rows AS (
  SELECT d.id AS device_id, d.site_id, d.created_at AS device_created_at,
         v.definition_id, f.created_at AS definition_created_at,
         f.name, v.field_key, f.type,
         COALESCE(to_jsonb(v.value_text), to_jsonb(v.value_number),
                  to_jsonb(v.value_bool), to_jsonb(v.value_date::text), 'null'::jsonb) AS value,
         eo.id AS org_id, eo.material_updated_at,
         md5(d.id::text || ':' || v.definition_id::text) AS identity_hash
    FROM public.device_custom_field_values v
    JOIN public.devices d ON d.id = v.device_id
    JOIN effective_orgs eo ON eo.id = d.org_id
    JOIN public.custom_field_definitions f ON f.id = v.definition_id
)
```

The duplication is structurally impossible now: the row *is* the datum, and `UNIQUE (device_id, definition_id)` bounds it. The `identity_hash` shape is unchanged, so shipped partner-API consumers do not re-sync.

- [ ] **Step 3: Rewrite the `custom.` branch of `filterEngine.ts`**

```ts
if (field.startsWith('custom.')) {
  const customField = getCustomFieldKey(field);
  if (!customField) throw new Error(`Invalid custom field key: ${field}`);
  // Reads the normalized table rather than jsonb_extract_path_text on
  // devices.custom_fields (#3257 W05): the (org_id, field_key, value_text)
  // index makes this a lookup instead of a per-row jsonb scan. The projection
  // still exists, so nothing else in this file changes.
  return {
    table: 'devices',
    column: 'customFields',
    computed: sql`(
      SELECT COALESCE(v.value_text, v.value_number::text, v.value_bool::text, v.value_date::text)
        FROM ${deviceCustomFieldValues} v
       WHERE v.device_id = ${devices.id} AND v.field_key = ${customField}
       LIMIT 1)`,
  };
}
```

`LIMIT 1` is belt-and-braces: `(device_id, field_key)` is single-valued because W03 forbids two visible definitions with one key, and `(device_id, definition_id)` is unique.

- [ ] **Step 4: Register the merge child**

In `orgMergeCustomExecutors.ts`, uncomment:

```ts
const CUSTOM_FIELD_DEFINITION_CHILDREN: readonly ChildRef[] = [
  { table: 'device_custom_field_values', column: 'definition_id' },
];
```

Then add the guard the re-home needs: a device can only hold values for definitions visible to *its* org, so a loser-org device cannot already hold a value under the survivor's definition and the `(device_id, definition_id)` unique index cannot collide. **Assert that rather than assuming it** — add an integration test that merges two orgs where both define `asset_tag` and both have valued devices, and check every value survives with the survivor's `definition_id`.

- [ ] **Step 5: Run everything**

```bash
cd apps/api
npx vitest run src/services/filterEngine src/routes/partnerApi/configuration
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/
```

Also run `pnpm --filter @breeze/api test` in full: `custom.<key>` reaches `groupMembership.ts` and `deploymentTargetResolver.ts`, and this wave is the one that could break device targeting.

- [ ] **Step 6: Commit and open the wave PR**

```bash
git add apps/api/src
git commit -m "fix(api): partner export emits one record per custom-field datum

The export joined devices.custom_fields (a flat, string-keyed jsonb) to a
dual-axis definitions table, so a collided field_key produced two records for
one datum, each with a different synthetic id. Reading the normalized value
table makes the duplication structurally impossible.

Refs #3257"
```

PR body must list all six registration lists with a tick, and note that both export-policy suites and the org-cascade suite only fail under **Integration Tests** — a unit-green PR on a stale base can still redden main.

---

# Wave 06 — `device_external_links`, the serial index, and device resolution

Independent of W05 and shippable alongside it. This is the substantive addition over the superseded 2026-08-09 design, which had no durable device identity and accepted stranded re-imports. Every source in the issue exports a stable device UID (Datto `uid`, Ninja device id, Automate `ComputerID`, N-central `applianceID`); recording it on the first successful match turns a fuzzy hostname join into an exact lookup on **every** subsequent run — which is what makes a multi-day migration (import, enroll more machines, re-import) work at all.

### Task 1: The link table and the missing serial index

**Files:**
- Create: `apps/api/migrations/2026-10-10-100000-device-external-links.sql`
- Create: `apps/api/src/db/schema/deviceExternalLinks.ts`
- Test: `apps/api/src/__tests__/integration/deviceExternalLinks.integration.test.ts`

**Interfaces:**
- Produces: table `device_external_links`; index `device_hardware_org_serial_idx`.

- [ ] **Step 1: Write the failing integration test**

```ts
it('refuses two links with the same (partner, system, external_id)', async () => {
  await sys(() => insertLink({ deviceId: d1, orgId, partnerId, system: 'datto_rmm', externalId: 'uid-1' }));
  await expect(sys(() => insertLink({ deviceId: d2, orgId, partnerId, system: 'datto_rmm', externalId: 'uid-1' })))
    .rejects.toMatchObject({ code: '23505' });
});

it('treats a NULL source_instance as the empty discriminator in the unique index', async () => {
  await sys(() => insertLink({ deviceId: d1, orgId, partnerId, system: 'csv', externalId: '1' }));
  await expect(sys(() => insertLink({ deviceId: d2, orgId, partnerId, system: 'csv', externalId: '1', sourceInstance: 'tenant-b' })))
    .resolves.toBeDefined(); // a discriminator makes it a different key
});

it('allows the same external_id under a different partner', async () => {
  await expect(sys(() => insertLink({ deviceId: dOther, orgId: orgB, partnerId: partnerB, system: 'datto_rmm', externalId: 'uid-1' })))
    .resolves.toBeDefined();
});

it('refuses a link whose device belongs to another org', async () => {
  await expect(sys(() => insertLink({ deviceId: d1, orgId: orgB, partnerId, system: 'datto_rmm', externalId: 'uid-9' })))
    .rejects.toMatchObject({ code: '23503' });
});

it('deletes the link when the device is deleted', async () => {
  await sys(() => db.execute(sql`DELETE FROM devices WHERE id = ${d1}::uuid`));
  expect(await sys(() => db.execute(sql`SELECT 1 FROM device_external_links WHERE device_id = ${d1}::uuid`))).toHaveLength(0);
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceExternalLinks.integration.test.ts
```

- [ ] **Step 3: Write the migration**

```sql
-- 2026-10-10-100000-device-external-links.sql
-- Durable device identity for re-import (#3257), mirroring
-- organization_external_links (2026-08-08) and contact_external_links
-- (2026-08-19). Every migration source exports a stable device UID; recording
-- it on the first successful match turns a fuzzy hostname join into an exact
-- lookup on every subsequent run, which is what makes a multi-day migration
-- (import, enroll more machines, re-import) work.
--
-- The unique key is on the PARTNER axis, matching organization_external_links
-- and NOT contact_external_links: a Datto UID is unique across the Datto
-- tenant, which is partner-shaped, and a partner key survives moveOrg
-- untouched. `source_instance` is RESERVED (Open Decision 2): it ships nullable
-- and unused but is in the unique index from day one via COALESCE, so adopting
-- an account/instance discriminator later (two Datto tenants, or two unrelated
-- CSVs both keyed '1') is a BACKFILL rather than a migration of a unique key.

CREATE TABLE IF NOT EXISTS device_external_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       uuid NOT NULL,
  org_id          uuid NOT NULL,
  partner_id      uuid NOT NULL,
  system          text NOT NULL,
  source_instance text,
  external_id     text NOT NULL,
  label           text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_external_links_device_org_fk') THEN
    ALTER TABLE device_external_links
      ADD CONSTRAINT device_external_links_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices (id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_external_links_org_partner_fk') THEN
    ALTER TABLE device_external_links
      ADD CONSTRAINT device_external_links_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS device_external_links_uniq
  ON device_external_links (partner_id, system, COALESCE(source_instance, ''), external_id);
CREATE INDEX IF NOT EXISTS device_external_links_device_idx ON device_external_links (device_id);
CREATE INDEX IF NOT EXISTS device_external_links_org_idx ON device_external_links (org_id);

ALTER TABLE device_external_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_external_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_external_links;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_external_links;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_external_links;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_external_links;
CREATE POLICY breeze_org_isolation_select ON device_external_links FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_external_links FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_external_links FOR UPDATE
  USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_external_links FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON device_external_links TO breeze_app;

-- device_hardware declares NO index beyond its device_id primary key, so a
-- serial-keyed resolution pass across a partner is a sequential scan per
-- lookup. Expression-indexed on the NORMALISED form, because the resolver
-- compares upper(btrim(serial_number)) on both sides of the join.
CREATE INDEX IF NOT EXISTS device_hardware_org_serial_idx
  ON device_hardware (org_id, upper(btrim(serial_number)))
  WHERE serial_number IS NOT NULL;

-- devices.hostname has no case-insensitive index either, and the resolver's
-- last-resort pass is case-insensitive by design.
CREATE INDEX IF NOT EXISTS devices_org_hostname_lower_idx
  ON devices (org_id, lower(hostname)) WHERE hostname IS NOT NULL;
```

- [ ] **Step 4: Write the Drizzle schema and register it**

`apps/api/src/db/schema/deviceExternalLinks.ts`, structurally mirroring `orgExternalLinks.ts`, then the **same six lists** as W05 Task 3:
- `CORE_ORG_CASCADE_DELETE_ORDER`: `device_external_links` sorts between `device_event_logs` and `device_filesystem_cleanup_runs`. Leaf table; parents sort after it.
- `CORE_DEVICE_CASCADE_DELETE_TABLES`: add to the core device block.
- `CORE_DEVICE_ORG_DENORMALIZED_TABLES`: **required.**
- `CORE_TENANT_EXPORT_POLICY`:
  ```ts
  // `system` and `external_id` are tenant IDENTIFIERS, not secrets — the same
  // classification organization_external_links and contact_external_links carry.
  "device_external_links": tablePolicy("org_id", {"included":["id","device_id","org_id","partner_id","system","source_instance","external_id","label","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  ```
- `orgMergeRegistry.ts`: plain `repoint`. **But check the unique key first** — it is partner-scoped, and an org merge keeps both orgs under one partner, so two links with the same `(partner, system, external_id)` pointing at two devices cannot arise from a merge (the unique index already forbade them before the merge). Plain repoint is correct; state that reasoning in the registry note.
- `rls-coverage.integration.test.ts`: no entry (shape 1, auto-discovered).

- [ ] **Step 5: Run migration, tests and every contract suite**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-10-10-100000-device-external-links.sql apps/api/src/db/schema apps/api/src/services apps/api/src/routes apps/api/src/__tests__
git commit -m "feat(api): device_external_links + org/serial and org/hostname resolution indexes

Refs #3257"
```

### Task 2: Port the agent's junk-identity denylist to TypeScript

Junk serials are already in the database and must be filtered on **both** sides of the join. The agent has the denylist — `cleanHardwareIdentityValue()` (`agent/internal/collectors/hardware.go:156-190`) — but applies it **only on Windows** (`hardware_windows.go:136`). Linux reads raw DMI (`hardware_linux.go:35`) and macOS shells out to `system_profiler` (`hardware_darwin.go:36`); both write the raw value through. Without this filter every Linux box reporting `Default string` collapses into one giant ambiguous group.

**Port the exact list. Do not author a second, divergent one.**

**Files:**
- Create: `apps/api/src/services/customFields/import/deviceIdentity.ts`
- Test: `apps/api/src/services/customFields/import/deviceIdentity.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const JUNK_HARDWARE_IDENTITY_VALUES: ReadonlySet<string>;
  export function isJunkHardwareIdentity(value: string | null | undefined): boolean;
  export function normalizeSerial(value: string | null | undefined): string | null;   // upper(btrim(...)), null when junk/empty
  export function normalizeHostname(value: string | null | undefined): string | null; // lower(btrim(...)), null when empty
  ```

- [ ] **Step 1: Write the failing test — table-driven, mirroring the Go test**

```ts
import { describe, it, expect } from 'vitest';
import { isJunkHardwareIdentity, normalizeSerial, normalizeHostname } from './deviceIdentity';

describe('isJunkHardwareIdentity', () => {
  // Ported verbatim from agent/internal/collectors/hardware.go:163-188. Adding a
  // value here without adding it there (or vice versa) is the divergence this
  // test exists to prevent.
  const junk = [
    '0', '00000000', '000000000000000', '123456789', 'default string', 'none',
    'null', 'n/a', 'na', 'not applicable', 'not available', 'not specified',
    'o.e.m', 'oem', 'serial number', 'system manufacturer',
    'system product name', 'system serial number', 'unknown',
  ];
  it.each(junk)('rejects %s', (v) => expect(isJunkHardwareIdentity(v)).toBe(true));
  it.each(junk.map((v) => v.toUpperCase()))('rejects %s case-insensitively', (v) =>
    expect(isJunkHardwareIdentity(v)).toBe(true));
  it('rejects any value containing "to be filled by"', () =>
    expect(isJunkHardwareIdentity('To Be Filled By O.E.M.')).toBe(true));
  it('collapses internal whitespace before comparing', () =>
    expect(isJunkHardwareIdentity('  Default   String  ')).toBe(true));
  it('trims leading and trailing dots before comparing', () =>
    expect(isJunkHardwareIdentity('.O.E.M.')).toBe(true));
  it('is an EXACT list, not an all-zeros pattern', () =>
    // A zero run of a different length is NOT junk — the Go switch is exact
    // matches, and inventing a general pattern here would diverge.
    expect(isJunkHardwareIdentity('0000')).toBe(false));
  it('accepts a real serial', () => expect(isJunkHardwareIdentity('5CG9210ABC')).toBe(false));
});

describe('normalizeSerial', () => {
  it('uppercases and trims', () => expect(normalizeSerial('  5cg9210abc ')).toBe('5CG9210ABC'));
  it('returns null for junk', () => expect(normalizeSerial('Default string')).toBeNull());
  it('returns null for empty', () => expect(normalizeSerial('   ')).toBeNull());
});

describe('normalizeHostname', () => {
  it('lowercases and trims', () => expect(normalizeHostname(' WKSTN-01 ')).toBe('wkstn-01'));
  it('returns null for empty', () => expect(normalizeHostname('')).toBeNull());
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/services/customFields/import/deviceIdentity.test.ts
```

- [ ] **Step 3: Implement**

```ts
/**
 * Junk hardware-identity values, ported VERBATIM from the Go agent's
 * cleanHardwareIdentityValue (agent/internal/collectors/hardware.go:156-190).
 *
 * The agent applies it only on Windows (hardware_windows.go:136); Linux reads
 * raw DMI and macOS shells out to system_profiler, and both write the raw value
 * through. So these values are already in device_hardware.serial_number and
 * must be filtered on BOTH sides of an import join — otherwise every Linux box
 * reporting "Default string" collapses into one giant ambiguous group.
 *
 * It is an EXACT list, not a general all-zeros pattern: a zero run of a
 * different length passes straight through, in Go and here. Do not "improve" it
 * into a regex — divergence from the agent is worse than the gap.
 */
export const JUNK_HARDWARE_IDENTITY_VALUES: ReadonlySet<string> = new Set([
  '0', '00000000', '000000000000000', '123456789', 'default string', 'none',
  'null', 'n/a', 'na', 'not applicable', 'not available', 'not specified',
  'o.e.m', 'oem', 'serial number', 'system manufacturer',
  'system product name', 'system serial number', 'unknown',
]);

export function isJunkHardwareIdentity(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  // strings.ToLower(strings.Join(strings.Fields(v), " ")), then strings.Trim(v, ".")
  const normalized = trimmed.toLowerCase().split(/\s+/).join(' ').replace(/^\.+|\.+$/g, '');
  if (JUNK_HARDWARE_IDENTITY_VALUES.has(normalized)) return true;
  return normalized.includes('to be filled by');
}

export function normalizeSerial(value: string | null | undefined): string | null {
  if (isJunkHardwareIdentity(value)) return null;
  return value!.trim().toUpperCase();
}

export function normalizeHostname(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed.toLowerCase();
}
```

- [ ] **Step 4: Run and commit**

```bash
cd apps/api && npx vitest run src/services/customFields/import/deviceIdentity.test.ts
git add apps/api/src/services/customFields/import/deviceIdentity.ts apps/api/src/services/customFields/import/deviceIdentity.test.ts
git commit -m "feat(api): port the agent junk-serial denylist for import-side device matching

Refs #3257"
```

### Task 3: The device resolution service

Resolution order, **always within one organization**, with every supplied identifier resolved and disagreement refused.

**Files:**
- Create: `apps/api/src/services/customFields/import/types.ts` — the dependency-free wire-type module. **Created here, in W06, and extended by W07 Task 1**; putting the device-resolution types in `resolveDevice.ts` instead would force `types.ts` to import a service module and give W08 an import cycle.
- Create: `apps/api/src/services/customFields/import/resolveDevice.ts`
- Test: `apps/api/src/services/customFields/import/resolveDevice.test.ts`

**Interfaces:**
- Consumes: `normalizeSerial`, `normalizeHostname` (Task 2).
- Produces, in `import/types.ts` (type-only, so it is erased at compile time and the module keeps its dependency-free runtime shape — the same reason `services/contacts/types.ts` gives):
  ```ts
  export const DEFAULT_IMPORT_SYSTEM = 'csv';
  export const IMPORT_SYSTEMS = ['datto_rmm', 'ninjaone', 'cw_automate', 'n_central', 'csv'] as const;
  export type ImportSystem = (typeof IMPORT_SYSTEMS)[number];

  export type DeviceMatchMethod = 'id' | 'link' | 'serial' | 'hostname';
  export type DeviceRowOutcome =
    | 'matched' | 'link-match' | 'ambiguous' | 'not-found'
    | 'org-not-found' | 'identity-conflict';

  export interface DeviceCandidate {
    deviceId: string;
    hostname: string | null;
    displayName: string | null;
    serialNumber: string | null;
    osType: string | null;
    status: string | null;
    enrolledAt: string | null;
    lastSeenAt: string | null;
    siteId: string | null;
    /** Which identifier produced this candidate. Presentational. */
    method: DeviceMatchMethod;
  }

  export interface DeviceResolution {
    outcome: DeviceRowOutcome;
    deviceId: string | null;
    method: DeviceMatchMethod | null;
    /** Populated for `ambiguous`; ordered by the ranking below. */
    candidates: DeviceCandidate[];
    /** Populated for `identity-conflict`: which identifiers disagreed. */
    conflictingMethods?: DeviceMatchMethod[];
  }

  ```
- Produces, in `import/resolveDevice.ts`:
  ```ts
  export interface DeviceResolutionScope {
    partnerId: string;
    /** null = system scope (unrestricted). An EMPTY array reaches nothing. */
    accessibleOrgIds: string[] | null;
    /** null/absent = unrestricted. RLS NEVER covered the site axis. */
    allowedSiteIds: string[] | null;
  }

  export async function loadDeviceResolutionSnapshot(
    rows: readonly DeviceCustomFieldImportRow[],
    scope: DeviceResolutionScope,
  ): Promise<DeviceResolutionSnapshot>;

  export function resolveDeviceRow(
    row: DeviceCustomFieldImportRow,
    snapshot: DeviceResolutionSnapshot,
  ): DeviceResolution;
  ```

**Rules the tests must pin.**
- Order: `deviceId` → `(externalSystem, externalId)` via `device_external_links` → `serialNumber` → `hostname` (case-insensitive).
- **Every** supplied identifier is resolved, not just the first. If two resolve to different devices → `identity-conflict`, refuse. "First hit wins" silently picks one and discards the evidence that the row is wrong.
- 0 candidates → `not-found`. >1 → `ambiguous` with ranked candidates. **Never auto-pick.**
- Ranking uses enrollment's own collision priority chain (token-authenticated > online > non-decommissioned > oldest, `routes/agents/enrollment.ts:514-518`) and is **presentational only** — it must never read as identity proof. Each candidate carries serial, OS, enrollment date and last-seen so the operator picks on evidence.
- Junk serials are excluded on **both** sides.
- The snapshot is loaded under `runOutsideDbContext(() => withSystemDbAccessContext(...))` and bounded by `scope.accessibleOrgIds` and `scope.allowedSiteIds` **in the query**. RLS returns TRUE in system scope, so this is the whole boundary.
- **Do not reuse `getDeviceWithOrgCheck`** (`routes/devices/helpers.ts:83-113`) anywhere on this path. It selects with no org predicate and checks in JS afterwards, which is fine under RLS and is the *only* check under a system context. Every query here carries its org predicate in the SQL.
- A row that names an org outside the scope resolves `org-not-found` — the same annotation an unknown org gets, so the response is never an existence oracle for another partner's tenants.

- [ ] **Step 1: Write the failing tests**

```ts
describe('resolveDeviceRow', () => {
  it('an explicit deviceId wins over every other identifier', () => {
    const r = resolveDeviceRow({ deviceId: D1, serialNumber: 'S-D2', hostname: 'wkstn-d3', values: [] }, snapshot);
    // …but only when they AGREE; see identity-conflict below.
    expect(r).toMatchObject({ outcome: 'matched', deviceId: D1, method: 'id' });
  });

  it('a link beats a serial', () => {
    const r = resolveDeviceRow({ externalSystem: 'datto_rmm', externalId: 'uid-1', serialNumber: 'S-D1', values: [] }, snapshot);
    expect(r).toMatchObject({ outcome: 'link-match', method: 'link' });
  });

  it('a serial beats a hostname', () => {
    const r = resolveDeviceRow({ serialNumber: 'S-D1', hostname: 'shared-name', values: [] }, snapshot);
    expect(r).toMatchObject({ outcome: 'matched', method: 'serial' });
  });

  it('refuses a row whose serial and hostname resolve to DIFFERENT devices', () => {
    const r = resolveDeviceRow({ serialNumber: 'S-D1', hostname: 'wkstn-d2', values: [] }, snapshot);
    expect(r.outcome).toBe('identity-conflict');
    expect(r.conflictingMethods).toEqual(['serial', 'hostname']);
    expect(r.deviceId).toBeNull();
  });

  it('returns ranked candidates for a hostname collision and never auto-picks', () => {
    const r = resolveDeviceRow({ hostname: 'shared-name', values: [] }, snapshot);
    expect(r.outcome).toBe('ambiguous');
    expect(r.deviceId).toBeNull();
    expect(r.candidates.map((c) => c.deviceId)).toEqual([ONLINE_NEWER, OFFLINE_OLDER, DECOMMISSIONED]);
    expect(r.candidates[0]).toHaveProperty('serialNumber');
    expect(r.candidates[0]).toHaveProperty('lastSeenAt');
  });

  it('ignores a junk serial on the ROW side', () => {
    const r = resolveDeviceRow({ serialNumber: 'Default string', hostname: 'wkstn-d1', values: [] }, snapshot);
    expect(r).toMatchObject({ outcome: 'matched', method: 'hostname' });
  });

  it('ignores a junk serial on the DATABASE side', () => {
    // Two devices both store "To Be Filled By O.E.M." — they must not group.
    const r = resolveDeviceRow({ serialNumber: 'To Be Filled By O.E.M.', values: [] }, snapshot);
    expect(r.outcome).toBe('not-found');
  });

  it('never resolves a hostname collision that spans orgs', () => {
    const r = resolveDeviceRow({ hostname: 'wkstn-in-other-org', values: [] }, snapshot);
    expect(r.outcome).toBe('not-found');
  });

  it('reports org-not-found for an org outside the caller reach, without disclosing existence', () => {
    const r = resolveDeviceRow({ organizationId: FOREIGN_ORG, hostname: 'anything', values: [] }, snapshot);
    expect(r).toMatchObject({ outcome: 'org-not-found', deviceId: null });
  });

  it('excludes a device on a site the caller cannot reach', () => {
    const r = resolveDeviceRow({ hostname: 'wkstn-restricted-site', values: [] }, snapshotWithSiteLimit);
    expect(r.outcome).toBe('not-found');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/services/customFields/import/resolveDevice.test.ts
```

- [ ] **Step 3: Implement the snapshot loader and the resolver**

Model `loadDeviceResolutionSnapshot` on `services/contacts/import.ts` `loadSnapshot`: one system-context block, an explicit org/site predicate in the SQL, and maps keyed by the four identifiers. Fetch only the devices the submitted rows could possibly match (`inArray` on the collected ids / external ids / normalised serials / lowered hostnames) so a 1000-row chunk is a bounded read, not a fleet scan.

```ts
export async function loadDeviceResolutionSnapshot(rows, scope) {
  const ids = collect(rows, (r) => r.deviceId);
  const externals = collect(rows, (r) => r.externalId && `${r.externalSystem ?? DEFAULT_IMPORT_SYSTEM}:${r.externalId}`);
  const serials = collect(rows, (r) => normalizeSerial(r.serialNumber));
  const hostnames = collect(rows, (r) => normalizeHostname(r.hostname));

  // SYSTEM context: resolving devices across a partner's orgs needs it, and
  // breeze_has_org_access short-circuits to TRUE under system scope — so RLS is
  // NOT the boundary here. The org and site predicates below are the whole of
  // it, exactly as services/contacts/import.ts:229 documents.
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    // …one query per identifier axis, each bounded by:
    //   organizations.partner_id = scope.partnerId
    //   AND (scope.accessibleOrgIds IS NULL OR devices.org_id = ANY(...))
    //   AND (scope.allowedSiteIds IS NULL OR devices.site_id = ANY(...))
    //   AND upper(btrim(device_hardware.serial_number)) NOT IN (junk list)
  }, 'customFields.import.resolveDevice'));
}
```

Ranking comparator, applied only to build `candidates[]`:

```ts
/**
 * PRESENTATION ONLY. Copies enrollment's collision priority chain
 * (routes/agents/enrollment.ts:514-518) so the operator sees the same order the
 * platform itself would consider most likely — it is NOT identity proof and it
 * never selects. Each candidate carries serial, OS, enrolment date and
 * last-seen so the pick is made on evidence.
 */
function rankCandidates(a: DeviceCandidate, b: DeviceCandidate): number { … }
```

- [ ] **Step 4: Run the unit tests, then write the isolation proof**

The one that matters. In `apps/api/src/__tests__/integration/deviceCustomFieldImportIsolation.integration.test.ts`:

```ts
it('a cross-partner forge is refused by the APP LAYER under a system DB context', async () => {
  // Deliberately NOT an RLS assertion: this whole path runs in a system
  // context, where breeze_has_org_access returns TRUE. An appeal to RLS here
  // would be a vacuous assertion.
  const snapshot = await loadDeviceResolutionSnapshot(
    [{ hostname: 'wkstn-partner-b', values: [] }],
    { partnerId: partnerA, accessibleOrgIds: [orgA], allowedSiteIds: null },
  );
  expect(resolveDeviceRow({ hostname: 'wkstn-partner-b', values: [] }, snapshot).outcome).toBe('not-found');
});

it('a site-restricted org user cannot resolve a device outside their sites', async () => {
  const snapshot = await loadDeviceResolutionSnapshot(
    [{ hostname: 'wkstn-site-2', values: [] }],
    { partnerId: partnerA, accessibleOrgIds: [orgA], allowedSiteIds: [siteOne] },
  );
  expect(resolveDeviceRow({ hostname: 'wkstn-site-2', values: [] }, snapshot).outcome).toBe('not-found');
});
```

- [ ] **Step 5: Run and commit**

```bash
cd apps/api && npx vitest run src/services/customFields/import/
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceCustomFieldImportIsolation.integration.test.ts
git add apps/api/src/services/customFields/import apps/api/src/__tests__/integration
git commit -m "feat(api): device resolution for custom-field import (id > link > serial > hostname)

Refs #3257"
```

---

# Wave 07 — Definitions importer

Depends on W02 and W03 (the uniqueness key the importer's idempotency rests on, and the shadowing rule it must report). Definitions and values have different tenancy, authorization and lifecycle, so they do **not** share an endpoint.

**Naming discipline:** the services are `customFieldDefinitionImport` and (W08) `deviceCustomFieldImport` — never `customFieldImport`. `tickets.custom_fields` (`db/schema/portal.ts:74`) and the PSA/Jira `customFields` (`services/psa/jira.ts:26`) are unrelated namesakes already in the tree.

### Task 1: Wire types and caps

**Files:**
- Modify: `apps/api/src/services/customFields/import/types.ts` — **W06 Task 3 created this module** with the device-resolution types and `IMPORT_SYSTEMS`/`DEFAULT_IMPORT_SYSTEM`. Extend it; do not re-declare them.
- Test: none (type-only module; it is exercised by every later suite)

**Interfaces:**
- Produces (added to the existing module):
  ```ts
  /** Same cap as the org and contact importers. */
  export const MAX_IMPORT_ROWS = 1000;
  /**
   * A SEPARATE, lower ceiling on sum(row.values.length). One device row carries
   * up to 30 values, so 1000 rows x 30 values is 30,000 writes in one request.
   * Rejected at the zod layer with copy telling the browser to split the chunk.
   */
  export const MAX_IMPORT_VALUES = 5000;

  export type CustomFieldType = 'text' | 'number' | 'boolean' | 'dropdown' | 'date';

  export interface CustomFieldDefinitionImportRow {
    fieldKey: string;
    name: string;
    type: CustomFieldType;
    /** SHARED contract shape (packages/shared/src/types/filters.ts:184), which
     *  W01 made the route accept. */
    options?: { choices?: Array<{ label: string; value: string }>; min?: number; max?: number;
                minLength?: number; maxLength?: number; pattern?: string };
    required?: boolean;
    deviceTypes?: Array<'windows' | 'macos' | 'linux'>;
    ownerScope: 'partner' | 'organization';
    /** Required when ownerScope === 'organization'. */
    organizationId?: string;
    /** e.g. 'udf7' — preserved in the audit, never stored. */
    sourceLabel?: string;
  }

  export type DefinitionAnnotation = 'create' | 'already-exists' | 'type-conflict' | 'key-shadowed' | 'org-not-found';

  export interface AnnotatedDefinitionRow extends CustomFieldDefinitionImportRow {
    index: number;
    annotation: DefinitionAnnotation;
    /** The existing definition this row matched, for the preview UI. */
    existingId: string | null;
    existingType: CustomFieldType | null;
    conflictReason?: string;
  }

  export interface CommitDefinitionRowInput extends CustomFieldDefinitionImportRow {
    /** Commit re-derives and refuses any row whose annotation moved. */
    expectedAnnotation?: DefinitionAnnotation;
    /** Identity pin for `already-exists`. */
    expectedDefinitionId?: string;
  }

  export type DefinitionImportErrorCode =
    | 'org-not-found' | 'type-conflict' | 'key-shadowed'
    | 'annotation-changed' | 'match-changed' | 'partner-wide-denied' | 'write-failed';

  export interface DefinitionImportSummary {
    created: Array<{ index: number; definitionId: string; fieldKey: string; ownerScope: 'partner' | 'organization'; organizationId: string | null }>;
    skipped: Array<{ index: number; definitionId: string; fieldKey: string; reason: 'already-exists' }>;
    errors: Array<{ index: number; fieldKey: string; error: string; code: DefinitionImportErrorCode; cause?: unknown }>;
  }
  ```

- [ ] **Step 1: Write the module** (verbatim from the interface block above, with the doc comments that explain each cap and each annotation).

- [ ] **Step 2: Typecheck**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/customFields/import/types.ts
git commit -m "feat(api): custom-field import wire types and caps

Refs #3257"
```

### Task 2: Preview

**Files:**
- Create: `apps/api/src/services/customFields/import/definitionImport.ts`
- Test: `apps/api/src/services/customFields/import/definitionImport.test.ts`

**Interfaces:**
- Consumes: `resolveImportPartnerId` (`routes/importScope.ts`), `canManagePartnerWidePolicies` (`services/partnerWideAccess.ts`), the types above.
- Produces:
  ```ts
  export interface DefinitionImportContext {
    partnerId: string;
    accessibleOrgIds: string[] | null;
    /** From canManagePartnerWidePolicies(auth). A partner-wide row from a
     *  caller without it is refused at PREVIEW, not just at commit. */
    canManagePartnerWide: boolean;
  }
  export async function previewCustomFieldDefinitionImport(
    rows: readonly CustomFieldDefinitionImportRow[], ctx: DefinitionImportContext,
  ): Promise<AnnotatedDefinitionRow[]>;
  export async function commitCustomFieldDefinitionImport(
    rows: readonly CommitDefinitionRowInput[], ctx: DefinitionImportContext,
    actor: { userId: string | null },
  ): Promise<DefinitionImportSummary>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('previewCustomFieldDefinitionImport', () => {
  it('annotates an unseen key as create', async () => {
    const [r] = await previewCustomFieldDefinitionImport(
      [{ fieldKey: 'udf7', name: 'Warranty Expiry', type: 'date', ownerScope: 'partner' }], ctx);
    expect(r).toMatchObject({ annotation: 'create', existingId: null });
  });

  it('annotates a key that already exists with the SAME type as already-exists', async () => {
    seedPartnerDefinition('udf7', 'date');
    const [r] = await previewCustomFieldDefinitionImport(
      [{ fieldKey: 'udf7', name: 'Warranty', type: 'date', ownerScope: 'partner' }], ctx);
    expect(r).toMatchObject({ annotation: 'already-exists', existingType: 'date' });
  });

  it('annotates a differing type as type-conflict, never a silent cast', async () => {
    // `type` is immutable on update (updateCustomFieldSchema omits it), so a
    // differing type can only be a delete-and-recreate — which orphans every
    // value stored under the key. Refuse.
    seedPartnerDefinition('udf7', 'text');
    const [r] = await previewCustomFieldDefinitionImport(
      [{ fieldKey: 'udf7', name: 'Warranty', type: 'date', ownerScope: 'partner' }], ctx);
    expect(r).toMatchObject({ annotation: 'type-conflict', existingType: 'text' });
  });

  it('annotates an org-owned key that shadows a partner-wide one as key-shadowed', async () => {
    seedPartnerDefinition('udf7', 'text');
    const [r] = await previewCustomFieldDefinitionImport(
      [{ fieldKey: 'udf7', name: 'Local', type: 'text', ownerScope: 'organization', organizationId: ORG }], ctx);
    expect(r.annotation).toBe('key-shadowed');
  });

  it('refuses a partner-wide row from a caller without the capability, at PREVIEW', async () => {
    const [r] = await previewCustomFieldDefinitionImport(
      [{ fieldKey: 'udf7', name: 'X', type: 'text', ownerScope: 'partner' }],
      { ...ctx, canManagePartnerWide: false });
    expect(r).toMatchObject({ annotation: 'org-not-found' });
    // …no. See step 3: this needs its OWN annotation so the UI can explain it.
  });

  it('reports an org outside the caller reach as org-not-found, never an existence oracle', async () => {
    const [r] = await previewCustomFieldDefinitionImport(
      [{ fieldKey: 'a', name: 'A', type: 'text', ownerScope: 'organization', organizationId: FOREIGN_ORG }], ctx);
    expect(r.annotation).toBe('org-not-found');
  });

  it('detects a duplicate key WITHIN the submitted batch', async () => {
    const rows = await previewCustomFieldDefinitionImport([
      { fieldKey: 'udf7', name: 'A', type: 'text', ownerScope: 'partner' },
      { fieldKey: 'udf7', name: 'B', type: 'text', ownerScope: 'partner' },
    ], ctx);
    // The unique index would reject the second at commit with a bare 23505.
    // Saying so at preview is the difference between a fixable file and a
    // mystery failure.
    expect(rows[1]).toMatchObject({ annotation: 'type-conflict' });
    expect(rows[1].conflictReason).toMatch(/appears more than once/i);
  });
});
```

> The fifth test above is written deliberately wrong so the implementer notices: reusing `org-not-found` for a capability refusal would tell a tech "that organization does not exist" when the truth is "you may not create all-organizations fields". Add `'partner-wide-denied'` to `DefinitionAnnotation` and `DefinitionImportErrorCode`, and fix the test to assert it. Fixing the plan's own test is part of the task.

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/services/customFields/import/definitionImport.test.ts
```

- [ ] **Step 3: Implement preview**

One snapshot load (all definitions visible to the partner: org-owned within `accessibleOrgIds`, plus partner-wide), then a pure annotation pass. Load it under `runOutsideDbContext(() => withSystemDbAccessContext(...))` bounded by `ctx.partnerId` and `ctx.accessibleOrgIds` — same reasoning as `contacts/import.ts:229`, same comment.

- [ ] **Step 4: Run and commit**

```bash
cd apps/api && npx vitest run src/services/customFields/import/definitionImport.test.ts
git add apps/api/src/services/customFields/import/definitionImport.ts apps/api/src/services/customFields/import/definitionImport.test.ts
git commit -m "feat(api): custom-field definition import preview

Refs #3257"
```

### Task 3: Commit, with TOCTOU re-derivation and identity pinning

- [ ] **Step 1: Write the failing tests**

```ts
describe('commitCustomFieldDefinitionImport', () => {
  it('creates a partner-wide definition and reports it', async () => {
    const s = await commitCustomFieldDefinitionImport(
      [{ fieldKey: 'udf7', name: 'Warranty', type: 'date', ownerScope: 'partner', expectedAnnotation: 'create' }], ctx, actor);
    expect(s.created).toHaveLength(1);
    expect(s.created[0]).toMatchObject({ fieldKey: 'udf7', ownerScope: 'partner', organizationId: null });
  });

  it('refuses a row whose annotation moved since preview', async () => {
    seedPartnerDefinition('udf7', 'date'); // created by someone else between preview and commit
    const s = await commitCustomFieldDefinitionImport(
      [{ fieldKey: 'udf7', name: 'Warranty', type: 'date', ownerScope: 'partner', expectedAnnotation: 'create' }], ctx, actor);
    expect(s.errors[0]).toMatchObject({ code: 'annotation-changed' });
    expect(s.created).toHaveLength(0);
  });

  it('refuses an already-exists acknowledgement pinned to a DIFFERENT definition', async () => {
    seedPartnerDefinition('udf7', 'date', 'def-new');
    const s = await commitCustomFieldDefinitionImport(
      [{ fieldKey: 'udf7', name: 'W', type: 'date', ownerScope: 'partner',
         expectedAnnotation: 'already-exists', expectedDefinitionId: 'def-old' }], ctx, actor);
    expect(s.errors[0]).toMatchObject({ code: 'match-changed' });
  });

  it('is idempotent: re-running an identical file creates nothing', async () => {
    const rows = [{ fieldKey: 'udf7', name: 'W', type: 'date' as const, ownerScope: 'partner' as const, expectedAnnotation: 'create' as const }];
    await commitCustomFieldDefinitionImport(rows, ctx, actor);
    const again = await commitCustomFieldDefinitionImport(
      [{ ...rows[0], expectedAnnotation: 'already-exists', expectedDefinitionId: firstId }], ctx, actor);
    expect(again.created).toHaveLength(0);
    expect(again.skipped).toHaveLength(1);
  });

  it('turns a 23505 into a typed write-failed with FIXED copy, never the driver message', async () => {
    mockInsertToThrow({ code: '23505', message: 'duplicate key value violates unique constraint "…" DETAIL: Key (org_id, field_key)=(…) already exists.' });
    const s = await commitCustomFieldDefinitionImport([row], ctx, actor);
    expect(s.errors[0].code).toBe('write-failed');
    // A pg error's .message carries column values and constraint text.
    expect(s.errors[0].error).not.toMatch(/DETAIL|constraint/);
  });

  it('surfaces the anti-shadowing trigger P0001 as key-shadowed', async () => {
    mockInsertToThrow({ code: 'P0001', message: 'custom field key "udf7" already exists as an all-organizations field for this partner' });
    const s = await commitCustomFieldDefinitionImport([row], ctx, actor);
    expect(s.errors[0].code).toBe('key-shadowed');
  });

  it('never lets a row land in BOTH created and errors', async () => {
    // Fold the snapshot write back BEFORE reporting, exactly as
    // contacts/import.ts does, so a throw after a successful insert cannot
    // double-report.
  });
});
```

- [ ] **Step 2: Run and watch them fail; then implement**

Commit re-derives every annotation against freshly loaded state (never preview's), applies `checkExpectation` (annotation + identity pin), and opens **one transaction per row** via `runOutsideDbContext`. A `writeFailureMessage(err)` helper maps SQLSTATE → fixed copy, copying `contacts/import.ts:694`. The `cause` is attached **non-enumerably** so it never reaches a JSON body but error trackers keep the stack.

- [ ] **Step 3: Write the audits**

`services/customFields/import/audit.ts`, modelled on `services/contacts/audit.ts`: one `writeRouteAudit` per definition created, carrying `externalSystem`, `sourceLabel`, `ownerScope` and the row count, so a post-migration dispute about "where did this field come from" is answerable.

- [ ] **Step 4: Run and commit**

```bash
cd apps/api && npx vitest run src/services/customFields/import/
git add apps/api/src/services/customFields/import
git commit -m "feat(api): custom-field definition import commit with TOCTOU re-derivation

Refs #3257"
```

### Task 4: The definitions route pair

**Files:**
- Create: `apps/api/src/routes/customFieldImport.ts`
- Modify: `apps/api/src/routes/index.ts` (mount under `/custom-fields`)
- Test: `apps/api/src/routes/customFieldImport.test.ts`

**Routes:** `POST /custom-fields/import/preview`, `POST /custom-fields/import`.

- [ ] **Step 1: Write the failing route tests**

```ts
it('rejects an X-API-Key caller on both routes', async () => {
  for (const path of ['/custom-fields/import/preview', '/custom-fields/import']) {
    const res = await app.request(path, { method: 'POST', headers: { 'X-API-Key': 'k' }, body: '{"rows":[]}' });
    expect(res.status).toBe(401);
  }
});

it('requires MFA', async () => { /* assert requireMfa ran */ });

it('403s an org token naming another partner in the body', async () => {
  const res = await postAs(orgToken, '/custom-fields/import/preview', { rows: [], partnerId: OTHER_PARTNER });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe('Access denied to this partner');
});

it('rejects more than MAX_IMPORT_ROWS rows at the zod layer', async () => {
  const res = await postAs(partnerToken, '/custom-fields/import/preview', { rows: tooMany });
  expect(res.status).toBe(400);
});

it('returns 200 with a non-empty errors[] on a partial commit', async () => {
  mockCommitToReturn({ created: [{ index: 0 }], skipped: [], errors: [{ index: 1, code: 'type-conflict' }] });
  const res = await postAs(partnerToken, '/custom-fields/import', { rows: twoRows });
  expect(res.status).toBe(200);
  // runAction reads a failure body as a hard failure and would hide the row
  // that DID import.
  expect((await res.json()).errors).toHaveLength(1);
});
```

- [ ] **Step 2: Run, watch fail, implement**

```ts
customFieldImportRoutes.post(
  '/import/preview',
  // `organization` must be in this list: the site-gating and org-token paths
  // below are dead code without it. Matches routes/orgContacts.ts:208.
  requireScope('organization', 'partner', 'system'),
  requireCustomFieldWrite,     // PERMISSIONS.DEVICES_WRITE, matching routes/customFields.ts
  requireMfa(),                // a bulk backfill is exactly the operation that should need it
  zValidator('json', previewDefinitionImportSchema),
  async (c) => { … },
);
```

Deliberately **no `dualAuth`**: the existing value route's `dualAuth` applies `requireMfa` only on the JWT branch and skips the site allowlist for API keys. An unattended integration is not a user of this feature.

- [ ] **Step 3: Run, mount, commit, open the wave PR**

```bash
cd apps/api && npx vitest run src/routes/customFieldImport.test.ts
git add apps/api/src/routes/customFieldImport.ts apps/api/src/routes/customFieldImport.test.ts apps/api/src/routes/index.ts
git commit -m "feat(api): POST /custom-fields/import{,/preview}

Refs #3257"
```

---

# Wave 08 — Values importer

Depends on W04, W05, W06 and W07.

### Task 1: Value wire types, with per-VALUE annotation granularity

The single most important shape decision in this wave. One device row carries up to 30 values, but `no-definition`, `type-error`, `already-set` and the `skip`/`update` conflict policy are all **per value**. A flat row-level annotation cannot express the normal case — a row where 28 values land, one has no definition, and one fails type validation.

**Files:**
- Modify: `apps/api/src/services/customFields/import/types.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MappingTarget =
    | { kind: 'customField'; fieldKey: string }
    | { kind: 'warranty'; field: 'warrantyEndDate' | 'warrantyStartDate' | 'manufacturer' };

  export interface DeviceCustomFieldImportRow {
    // Join keys — at least one required, resolved in W06's order.
    deviceId?: string;
    externalId?: string;
    externalSystem?: ImportSystem;
    sourceInstance?: string;   // reserved; written to device_external_links
    serialNumber?: string;
    hostname?: string;
    organization?: string;     // org name or externalId, to narrow the search
    organizationId?: string;
    /** One row carries EVERY mapped column for one device. */
    values: Array<{ target: MappingTarget; value: string | number | boolean | null }>;
  }

  /** Row-level: how the DEVICE resolved. Declared in this same module by
   *  W06 Task 3 — aliased, not redefined. */
  export type ValueRowOutcome = DeviceRowOutcome;

  /** Per-value: what happened to this one datum. */
  export type ValueOutcome =
    | 'applied' | 'skipped-already-set' | 'no-definition'
    | 'type-error' | 'reserved-key' | 'not-applicable-to-device';

  export interface AnnotatedValueRow {
    index: number;
    outcome: ValueRowOutcome;
    deviceId: string | null;
    method: DeviceMatchMethod | null;
    organizationId: string | null;
    /** Ranked, for `ambiguous`. The UI must require an explicit pick. */
    candidates: DeviceCandidate[];
    conflictingMethods?: DeviceMatchMethod[];
    values: Array<{
      target: MappingTarget;
      outcome: ValueOutcome;
      /** Set on `type-error`. */
      reason?: CustomFieldValueRejection;
      /** Set on `reserved-key`: the partner-integration contract this populates. */
      warning?: string;
    }>;
  }

  export interface CommitValueRowInput extends DeviceCustomFieldImportRow {
    expectedOutcome?: ValueRowOutcome;
    /** Identity pin. REQUIRED when expectedOutcome is 'ambiguous' — an
     *  acknowledgement that says "apply this" without saying "to whom" would
     *  transfer to a different device if the candidate set moved. */
    expectedDeviceId?: string;
  }

  /** Verbatim from the contacts importer (ContactImportMode), including the
   *  default. A third importer using the same word with the same default is
   *  worth more than a marginally better one. */
  export type ValueImportMode = 'skip' | 'update';

  export interface ValueImportSummary {
    /** Counts VALUES, not rows — an operator cannot reconcile "30,000 in the
     *  file" against "1,180 imported" otherwise. */
    appliedValues: number;
    skippedValues: number;
    rows: Array<{ index: number; deviceId: string; applied: number; skipped: number; failed: number }>;
    linksCreated: number;
    errors: Array<{ index: number; error: string; code: ValueImportErrorCode; cause?: unknown }>;
  }
  ```

- [ ] **Step 1: Write the module, then typecheck and commit** (as W07 Task 1).

### Task 2: Preview

**Files:**
- Create: `apps/api/src/services/customFields/import/valueImport.ts`
- Test: `apps/api/src/services/customFields/import/valueImport.test.ts`

**Interfaces:**
- Consumes: `loadDeviceResolutionSnapshot`, `resolveDeviceRow` (W06); `loadVisibleCustomFieldDefinitions` (W04); `validateCustomFieldValue` (shipped); `persistDeviceCustomFieldValues` (W05); `applyWarrantyImport` (Task 4).
- Produces:
  ```ts
  export interface ValueImportContext extends DeviceResolutionScope {
    /** partnerId, accessibleOrgIds and allowedSiteIds come from DeviceResolutionScope. */
    mode?: ValueImportMode;
    /** Decision 7: an operator opt-in, off by default. */
    overrideProviderWarranty?: boolean;
  }
  export async function previewDeviceCustomFieldImport(
    rows: readonly DeviceCustomFieldImportRow[], ctx: ValueImportContext,
  ): Promise<AnnotatedValueRow[]>;
  export async function commitDeviceCustomFieldImport(
    rows: readonly CommitValueRowInput[], ctx: ValueImportContext,
    actor: { userId: string | null }, options?: { mode?: ValueImportMode },
  ): Promise<ValueImportSummary>;
  export type ValueImportErrorCode =
    | 'org-not-found' | 'not-found' | 'identity-conflict'
    | 'annotation-changed' | 'match-changed' | 'match-unconfirmed' | 'write-failed';
  ```
  In the test bodies below, `preview(...)` and `commit(...)` are local aliases for these two.

- [ ] **Step 1: Write the failing tests**

```ts
describe('previewDeviceCustomFieldImport', () => {
  it('annotates a link-resolved row as link-match', async () => {
    const [r] = await preview([{ externalSystem: 'datto_rmm', externalId: 'uid-1', values: [v('asset_tag', 'AB-1')] }], ctx);
    expect(r).toMatchObject({ outcome: 'link-match', method: 'link' });
  });

  it('partially annotates a row: 1 applied, 1 no-definition, 1 type-error', async () => {
    const [r] = await preview([{ hostname: 'wkstn-1', values: [
      v('asset_tag', 'AB-1'), v('nope', 'x'), v('rack_units', 'abc'),
    ] }], ctx);
    expect(r.outcome).toBe('matched');
    expect(r.values.map((x) => x.outcome)).toEqual(['applied', 'no-definition', 'type-error']);
    expect(r.values[2].reason).toBe('invalid_type');
  });

  it('marks a value equal to the stored one as skipped-already-set', async () => {
    seedValue(D1, 'asset_tag', 'AB-1');
    const [r] = await preview([{ deviceId: D1, values: [v('asset_tag', 'AB-1')] }], ctx);
    expect(r.values[0].outcome).toBe('skipped-already-set');
  });

  it('warns on a reserved key', async () => {
    // partnerApi/devices.ts:123-125 derives stableIdentifiers.assetTag from
    // ['assetTag','asset_tag'], likewise inventoryId and externalId. Importing
    // to asset_tag populates a partner-integration identity contract
    // FLEET-WIDE — intended, but the preview must say so on the row.
    const [r] = await preview([{ deviceId: D1, values: [v('asset_tag', 'AB-1')] }], ctx);
    expect(r.values[0].warning).toMatch(/partner integration identity/i);
  });

  it('marks a value whose definition excludes this device OS as not-applicable-to-device', async () => {
    seedDefinition('bitlocker_status', { deviceTypes: ['windows'] });
    const [r] = await preview([{ deviceId: MAC_DEVICE, values: [v('bitlocker_status', 'on')] }], ctx);
    expect(r.values[0].outcome).toBe('not-applicable-to-device');
  });

  it('returns ranked candidates for an ambiguous row and applies nothing', async () => {
    const [r] = await preview([{ hostname: 'shared-name', values: [v('asset_tag', 'AB-1')] }], ctx);
    expect(r.outcome).toBe('ambiguous');
    expect(r.candidates.length).toBeGreaterThan(1);
    expect(r.values.every((x) => x.outcome !== 'applied')).toBe(true);
  });
});
```

- [ ] **Step 2: Run, watch fail, implement**

Preview loads two snapshots — the device resolution snapshot (W06) and the visible definitions per resolved org (W04's `loadVisibleCustomFieldDefinitions`, batched by org) — then annotates purely. Validation reuses `validateCustomFieldValue`; **do not write a second validator.**

- [ ] **Step 3: Run and commit.**

### Task 3: Commit — per-row transaction, partial value application, durable link

- [ ] **Step 1: Write the failing tests**

```ts
it('writes 28 values and reports 2 for a mixed row, in ONE transaction', async () => {
  const s = await commit([mixedRow30], ctx, actor, { mode: 'update' });
  expect(s.rows[0]).toMatchObject({ applied: 28, failed: 2 });
  expect(await countStoredValues(D1)).toBe(28);
});

it('a row that fails to write does not poison its neighbours', async () => {
  // This is the property a per-ORG chunk could not provide: inside one Postgres
  // transaction a failed statement aborts it and every later statement raises
  // 25P02. Assert that rows AFTER a deliberately failing row still commit.
  mockRowWriteToThrowOnce(1);
  const s = await commit([rowA, rowBad, rowC], ctx, actor, { mode: 'update' });
  expect(s.errors.map((e) => e.index)).toEqual([1]);
  expect(s.rows.map((r) => r.index)).toEqual([0, 2]);
});

it('records a device_external_links row on the first match by serial or hostname', async () => {
  const s = await commit([{ externalSystem: 'datto_rmm', externalId: 'uid-9', hostname: 'wkstn-1', values: [v('asset_tag', 'AB-1')] }], ctx, actor);
  expect(s.linksCreated).toBe(1);
});

it('the SECOND run resolves by link with zero hostname lookups', async () => {
  await commit([rowWithExternalIdAndHostname], ctx, actor);
  const queries = await countQueriesDuring(() => commit([rowWithExternalIdAndHostname], ctx, actor));
  // Assert the query COUNT, not just the result: "it still works" would pass
  // even if the link were being ignored.
  expect(queries.hostnameLookups).toBe(0);
});

it('re-running an identical file in default skip mode writes nothing', async () => {
  await commit(rows, ctx, actor);              // mode defaults to 'skip'
  const again = await commit(rows, ctx, actor);
  expect(again.appliedValues).toBe(0);
  expect(again.skippedValues).toBe(sumValues(rows));
});

it('refuses an ambiguous acknowledgement with no expectedDeviceId', async () => {
  const s = await commit([{ hostname: 'shared-name', expectedOutcome: 'ambiguous', values: [v('asset_tag', 'x')] }], ctx, actor);
  expect(s.errors[0].code).toBe('match-unconfirmed');
});

it('refuses an acknowledgement pinned to a device the row no longer resolves to', async () => {
  const s = await commit([{ hostname: 'shared-name', expectedOutcome: 'ambiguous', expectedDeviceId: GONE, values: [v('asset_tag', 'x')] }], ctx, actor);
  expect(s.errors[0].code).toBe('match-changed');
});

it('a link-match needs no acknowledgement — the durable link IS the acknowledgement', async () => {
  const s = await commit([linkedRow], ctx, actor, { mode: 'update' });
  expect(s.errors).toHaveLength(0);
});
```

- [ ] **Step 2: Run, watch fail, implement**

```ts
for (const row of normalized) {
  const resolution = resolveDeviceRow(row, snapshot);   // RE-derived, never preview's
  … // outcome + expectation checks, as contacts/import.ts checkExpectation does
  try {
    // Each row escapes the request's withDbAccessContext transaction and opens
    // its own. Per-row failure isolation is unachievable inside one Postgres
    // transaction (25P02), and a per-org chunk therefore cannot return a
    // trustworthy per-row write-failed at all — the first bad row poisons the
    // rest. Same escape, same reason, as contacts/import.ts:9-16.
    //
    // It also satisfies the lock constraint strictly better than chunking:
    // breeze_partner_export_devices_update takes a shared partner lock plus a
    // per-org pg_advisory_xact_lock, which is TRANSACTION-scoped — released at
    // transaction end, on commit OR rollback.
    const written = await runOutsideDbContext(() =>
      retryOnTransientLockError('custom-field-import row', () => writeRowValues(row, resolution, ctx, mode)));
    …
  } catch (err) { summary.errors.push({ index: row.index, code: 'write-failed', error: writeFailureMessage(err), cause: err }); }
}
```

`writeRowValues` opens one transaction that (a) upserts every good value through `persistDeviceCustomFieldValues` (W05), (b) upserts the `device_external_links` row when the row carried an `externalId` and none existed, and (c) writes the warranty target (Task 4). A `write-failed` rolls back that device's values only.

- [ ] **Step 3: Write the per-device audit**

Extend `services/customFields/import/audit.ts` with the values half. The spec's requirement is exact: one audit per **device backfilled**, carrying `externalSystem`, the **resolution method** (`id`/`link`/`serial`/`hostname`) and the row count — so a post-migration dispute about "where did this asset tag come from" is answerable.

```ts
it('audits every backfilled device with its resolution method', async () => {
  await commit([{ hostname: 'wkstn-1', externalSystem: 'datto_rmm', values: [v('asset_tag', 'AB-1')] }], ctx, actor);
  expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    action: 'device.custom_field.import',
    resourceType: 'device',
    details: expect.objectContaining({
      externalSystem: 'datto_rmm', resolutionMethod: 'hostname',
      // Field KEYS only. A value can be anything the incumbent held and must
      // never enter the audit payload — the same rule scriptWriteBack.ts and
      // customFieldValues.ts already apply.
      changedFields: ['asset_tag'],
    }),
  }));
});
```

`commitDeviceCustomFieldImport` has no Hono context, so — exactly as `commitContactImport` does — it writes no audits itself and the **route** fans them out from the returned summary. The summary therefore has to carry `externalSystem` and `method` per row; add them to `ValueImportSummary.rows` if they are not already there.

- [ ] **Step 4: Run and commit.**

### Task 4: The `warranty` mapping target

Open Decision 7 kept this in v1 **on condition it is specified to the same depth as the custom-field path**. This task is that condition.

Importing warranty expiry into a custom field ships the flagship use case **inert**: `device_warranty` already exists with a `status` enum, an index on the end date, a `data_source` column defaulting to `'provider'`, and it feeds `warrantyAlertEvaluator.ts`, the warranty dashboard and `routes/partnerApi/inventory.ts`. `filterEngine` has no warranty field at all.

**Files:**
- Create: `apps/api/src/services/customFields/import/warrantyTarget.ts`
- Modify: `apps/api/src/services/warrantySync.ts` (export `computeWarrantyStatus`)
- Test: `apps/api/src/services/customFields/import/warrantyTarget.test.ts` + an integration assertion

**Interfaces:**
- Consumes: `computeWarrantyStatus(endDate: string | null, warnDays?: number): WarrantyStatus` — currently a **private** function at `warrantySync.ts:10`. Export it; do not copy it.
- Produces:
  ```ts
  export interface WarrantyImportWrite {
    deviceId: string; orgId: string;
    warrantyStartDate?: string | null;
    warrantyEndDate?: string | null;
    manufacturer?: string | null;
  }
  export type WarrantyImportOutcome = 'applied' | 'skipped-provider-owned' | 'skipped-already-set';
  export async function applyWarrantyImport(
    tx: DbTransaction, write: WarrantyImportWrite, options: { overrideProvider: boolean },
  ): Promise<WarrantyImportOutcome>;
  ```

**Rules:**
1. **Compute and write `status`.** `evaluateWarrantyAlerts` returns early on `status === 'unknown'` (`warrantyAlertEvaluator.ts:140`) and `status` defaults to `'unknown'`, so writing `warranty_end_date` alone leaves the feature inert. A test that only writes the date would pass **vacuously** against a null return.
2. **`data_source: 'import'`**, and never clobber a `data_source = 'provider'` row without an explicit opt-in — a manufacturer lookup is more trustworthy than a hand-typed CSV.
3. Upsert on the existing `device_warranty_device_id_idx` unique index.
4. Never set `is_subscription`; an import cannot know it, and a true value suppresses expiry alerts (`warrantyAlertEvaluator.ts:147`).

- [ ] **Step 1: Write the failing tests**

```ts
it('writes a COMPUTED status alongside the imported end date', async () => {
  await applyWarrantyImport(tx, { deviceId: D1, orgId: ORG, warrantyEndDate: in30Days }, { overrideProvider: false });
  const [w] = await readWarranty(D1);
  expect(w).toMatchObject({ status: 'expiring', data_source: 'import' });
});

it('makes the alert evaluator actually fire', async () => {
  // The vacuous version of this test writes only the date and asserts a
  // non-null return; it would pass against status='unknown' returning null.
  // Assert the STATUS write explicitly, then the alert.
  await applyWarrantyImport(tx, { deviceId: D1, orgId: ORG, warrantyEndDate: in30Days }, { overrideProvider: false });
  const [w] = await readWarranty(D1);
  expect(w.status).toBe('expiring');
  expect(await evaluateWarrantyAlerts(D1)).not.toBeNull();
});

it('refuses to clobber a provider-sourced row without an explicit opt-in', async () => {
  await seedWarranty(D1, { dataSource: 'provider', warrantyEndDate: in400Days });
  const outcome = await applyWarrantyImport(tx, { deviceId: D1, orgId: ORG, warrantyEndDate: in30Days }, { overrideProvider: false });
  expect(outcome).toBe('skipped-provider-owned');
  expect((await readWarranty(D1))[0].warranty_end_date).toBe(in400Days);
});

it('overrides a provider row when the operator opted in', async () => {
  await seedWarranty(D1, { dataSource: 'provider' });
  expect(await applyWarrantyImport(tx, { deviceId: D1, orgId: ORG, warrantyEndDate: in30Days }, { overrideProvider: true })).toBe('applied');
});

it('appears in the partner API inventory record', async () => {
  await applyWarrantyImport(tx, { deviceId: D1, orgId: ORG, warrantyEndDate: in30Days }, { overrideProvider: false });
  const record = await runInventoryExport({ partnerId, deviceId: D1 });
  expect(record.warranty).toMatchObject({ status: 'expiring', endDate: in30Days });
});

it('leaves is_subscription false — an import cannot know it', async () => {
  await applyWarrantyImport(tx, { deviceId: D1, orgId: ORG, warrantyEndDate: in30Days }, { overrideProvider: false });
  expect((await readWarranty(D1))[0].is_subscription).toBe(false);
});
```

- [ ] **Step 2: Run, watch fail, implement**

Export `computeWarrantyStatus` from `warrantySync.ts` with a comment pointing at this caller, and write `applyWarrantyImport` as an `onConflictDoUpdate` on `deviceWarranty.deviceId` with a `setWhere` that excludes `data_source = 'provider'` unless `overrideProvider`.

- [ ] **Step 3: Wire the target into the value commit**

`writeRowValues` splits `row.values` by `target.kind` and calls `applyWarrantyImport` inside the same per-row transaction, so a warranty failure rolls back that device's custom-field values too — one row, one atom.

- [ ] **Step 4: Run and commit.**

### Task 5: The values route pair, and the caps

**Files:**
- Create: `apps/api/src/routes/devices/customFieldImport.ts`
- Modify: `apps/api/src/routes/devices/index.ts`
- Test: `apps/api/src/routes/devices/customFieldImport.test.ts`

**Routes:** `POST /devices/custom-fields/import/preview`, `POST /devices/custom-fields/import`.

> **Mount order matters.** `routes/devices/index.ts` mounts `customFieldValuesRoutes` FIRST, before `coreRoutes` and the other `.use('*', authMiddleware)` sub-routers, because a wildcard `.use('*')` in a sibling attaches to every route mounted after it. This router uses per-route middleware (no wildcard), so mount it beside `customFieldValuesRoutes`, before `coreRoutes`, and add a `customFieldImport.mountorder.test.ts` mirroring the existing `customFieldValues.mountorder.test.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
it('rejects 1000 rows x 30 values at the zod layer with actionable copy', async () => {
  const res = await postAs(partnerToken, '/devices/custom-fields/import/preview', { rows: thirtyThousandValues });
  expect(res.status).toBe(400);
  // The browser needs to be told to split, not just refused.
  expect((await res.json()).error).toMatch(/split/i);
});

it('rejects X-API-Key on both routes', async () => { … });
it('requires MFA on both routes', async () => { … });
it('403s an org token naming another partner', async () => { … });
it('returns 200 with a partial summary', async () => { … });
```

- [ ] **Step 2: Implement the caps in the schema**

```ts
const valueRowsSchema = z.array(deviceCustomFieldImportRowSchema)
  .max(MAX_IMPORT_ROWS, `At most ${MAX_IMPORT_ROWS} device rows per request — split the file into chunks`)
  .refine(
    (rows) => rows.reduce((n, r) => n + r.values.length, 0) <= MAX_IMPORT_VALUES,
    // The row cap alone does not bound the work: 1000 rows x 30 values is
    // 30,000 writes in one request.
    { message: `At most ${MAX_IMPORT_VALUES} values per request — split the file into smaller chunks` },
  );
```

- [ ] **Step 3: Run, mount, commit, open the wave PR**

```bash
cd apps/api
npx vitest run src/routes/devices/customFieldImport src/services/customFields/import/
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/
git add apps/api/src
git commit -m "feat(api): POST /devices/custom-fields/import{,/preview}

Refs #3257"
```

PR body must list the isolation proof (cross-partner forge under system context), the transaction-isolation proof, the partial-application proof, and the second-run link-resolution query-count proof.

---

# Wave 09 — Web UI: "Import from another RMM"

One wizard, reachable from the device list and from Settings → Custom Fields, modelled on `apps/web/src/components/organizations/BulkContactImport.tsx` (the newest and most complete of the two shipped importers).

```
Step 0  Source picker — Datto RMM / NinjaOne / ConnectWise Automate / N-central / Generic CSV
        (chooses header presets for guessMapping and sets externalSystem)
Step 1  Definitions — upload the incumbent's field list
        → ownerScope: All orgs (partner-wide) | one organization    [gated as W01]
        → rename udf1..udf30 in one grid, pre-filled from sourceLabel
        → preview: create / already-exists / type-conflict / key-shadowed
        → commit
Step 2  Values — drag-drop CSV → csvParse.ts
        → per-column mapping target (custom field | warranty | ignore) + join-key column
        → preview table with per-row status badges and per-value sub-rows
        → ambiguous rows expand to ranked candidates and require an explicit pick
        → commit in chunks, cumulative progress, partial success surfaced
```

Step 1 is skippable when the definitions already exist (a re-run).

### Task 1: Shared preview table and wire types

**Files:**
- Create: `apps/web/src/components/devices/CustomFieldImportPreviewTable.tsx`
- Test: `apps/web/src/components/devices/CustomFieldImportPreviewTable.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
it('select-all spans only matched and link-match rows', async () => {
  render(<CustomFieldImportPreviewTable rows={[matched, linkMatch, ambiguous, notFound]} … />);
  await userEvent.click(screen.getByTestId('cf-import-select-all'));
  // A bulk toggle must not opt hundreds of rows into a fuzzy match — the same
  // guard the shipped importers apply.
  expect(onSelectionChange).toHaveBeenCalledWith([matched.index, linkMatch.index]);
});

it('an ambiguous row expands to ranked candidates showing serial, OS, enrolled and last-seen', async () => {
  render(<CustomFieldImportPreviewTable rows={[ambiguous]} … />);
  await userEvent.click(screen.getByTestId(`cf-import-expand-${ambiguous.index}`));
  const first = screen.getByTestId('cf-import-candidate-0');
  for (const field of ['serial', 'os', 'enrolled', 'last-seen']) {
    expect(within(first).getByTestId(`cf-import-candidate-${field}`)).toBeInTheDocument();
  }
});

it('an ambiguous row cannot be committed until a candidate is picked', async () => {
  render(<CustomFieldImportPreviewTable rows={[ambiguous]} … />);
  expect(screen.getByTestId(`cf-import-row-${ambiguous.index}`)).toHaveAttribute('aria-disabled', 'true');
  await userEvent.click(screen.getByTestId(`cf-import-expand-${ambiguous.index}`));
  await userEvent.click(screen.getByTestId('cf-import-candidate-0-pick'));
  expect(onPick).toHaveBeenCalledWith(ambiguous.index, CANDIDATE_0_ID);
});

it('renders per-value outcomes under a partially-applied row', async () => {
  render(<CustomFieldImportPreviewTable rows={[partial]} … />);
  expect(screen.getByTestId('cf-import-value-outcome-no-definition')).toBeInTheDocument();
  expect(screen.getByTestId('cf-import-value-outcome-type-error')).toBeInTheDocument();
});

it('renders the reserved-key warning inline', async () => {
  render(<CustomFieldImportPreviewTable rows={[reservedKeyRow]} … />);
  expect(screen.getByTestId('cf-import-reserved-key-warning')).toBeInTheDocument();
});
```

Every query is by `data-testid` — that is the repo convention for both Vitest component tests and Playwright specs.

- [ ] **Step 2: Run, watch fail, implement, run, commit.**

### Task 2: Step 1 — definitions

**Files:**
- Create: `apps/web/src/components/devices/CustomFieldDefinitionImportStep.tsx`
- Test: alongside

- [ ] **Step 1: Write the failing tests**

```tsx
it('pre-fills each name from sourceLabel so 30 slots are renamed in one grid', async () => {
  render(<CustomFieldDefinitionImportStep source="datto_rmm" />);
  await uploadCsv('UDF Slot,Label\nudf7,\nudf8,\n');
  expect(screen.getByTestId('cf-def-name-udf7')).toHaveValue('udf7');
  expect(screen.getByTestId('cf-def-source-label-udf7')).toHaveTextContent('udf7');
});

it('defaults every field to text so an operator who changes nothing still lands values', async () => {
  render(<CustomFieldDefinitionImportStep source="datto_rmm" />);
  await uploadCsv('UDF Slot\nudf7\n');
  expect(screen.getByTestId('cf-def-type-udf7')).toHaveValue('text');
});

it('hides the partner-wide owner option from a user who cannot manage it', async () => {
  mockUser({ canManagePartnerWide: false });
  render(<CustomFieldDefinitionImportStep source="datto_rmm" />);
  expect(screen.queryByTestId('cf-def-owner-partner')).toBeNull();
});

it('defaults ownerScope from useDefaultOwnerScope, not from a local copy of the rule', async () => {
  mockDefaultOwnerScope({ isPartnerScope: true, defaultOwnerScope: 'partner' });
  render(<CustomFieldDefinitionImportStep source="datto_rmm" />);
  expect(screen.getByTestId('cf-def-owner-partner')).toBeChecked();
});

it('sends the preview POST through runAction', async () => {
  render(<CustomFieldDefinitionImportStep source="datto_rmm" />);
  await uploadCsv('UDF Slot\nudf7\n');
  await userEvent.click(screen.getByTestId('cf-def-preview'));
  expect(runAction).toHaveBeenCalled();
});

it('surfaces a type-conflict row and excludes it from the commit selection', async () => {
  mockPreview([{ index: 0, fieldKey: 'udf7', annotation: 'type-conflict', existingType: 'text' }]);
  render(<CustomFieldDefinitionImportStep source="datto_rmm" />);
  await uploadCsv('UDF Slot,Type\nudf7,date\n');
  await userEvent.click(screen.getByTestId('cf-def-preview'));
  expect(screen.getByTestId('cf-def-annotation-type-conflict')).toBeInTheDocument();
  expect(screen.getByTestId('cf-def-row-0')).toHaveAttribute('aria-disabled', 'true');
});

it('is skippable when the definitions already exist', async () => {
  mockPreview([{ index: 0, fieldKey: 'udf7', annotation: 'already-exists' }]);
  render(<CustomFieldDefinitionImportStep source="datto_rmm" />);
  await uploadCsv('UDF Slot\nudf7\n');
  await userEvent.click(screen.getByTestId('cf-def-preview'));
  expect(screen.getByTestId('cf-def-skip-to-values')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/web && npx vitest run src/components/devices/CustomFieldDefinitionImportStep
```

- [ ] **Step 3: Implement**

Per-source header presets drive `guessMapping` (reuse the shape from `BulkContactImport.tsx:61-88` — a `Record<field, string[]>` of lowercased, whitespace-stripped guesses, first match wins, each header claimed once). `ownerScope` and the capability gate come from `useDefaultOwnerScope()` and `user.canManagePartnerWide` — **import W01's rule, do not re-derive it**. Every field's `type` select defaults to `text`, so Decision 4 degrades gracefully to "everything as text" by inaction. Both the preview POST and the commit POST go through `runAction`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/devices/CustomFieldDefinitionImportStep
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/CustomFieldDefinitionImportStep.tsx \
        apps/web/src/components/devices/CustomFieldDefinitionImportStep.test.tsx
git commit -m "feat(web): custom-field definition import step

Refs #3257"
```

### Task 3: Step 2 — values, with explicit CSV coercion

**Files:**
- Create: `apps/web/src/components/devices/CustomFieldValueImportStep.tsx`
- Create: `apps/web/src/components/devices/customFieldImportCoercion.ts`
- Test: `apps/web/src/components/devices/customFieldImportCoercion.test.ts`

**The coercion rules are a required, tested unit** (Decision 4's added requirement): without them every `number` column arrives as a string and annotates `type-error` fleet-wide.

- [ ] **Step 1: Write the failing coercion tests**

```ts
describe('coerceCellForType', () => {
  it('number: strips thousands separators and a currency prefix', () => {
    expect(coerceCellForType('1,234', 'number')).toBe(1234);
    expect(coerceCellForType('$1,234.50', 'number')).toBe(1234.5);
  });
  it('number: an empty cell is "no data", not zero', () => expect(coerceCellForType('', 'number')).toBeNull());
  it('boolean: accepts the spreadsheet vocabulary', () => {
    for (const t of ['TRUE', 'Yes', 'Y', '1']) expect(coerceCellForType(t, 'boolean')).toBe(true);
    for (const f of ['FALSE', 'No', 'N', '0']) expect(coerceCellForType(f, 'boolean')).toBe(false);
  });
  it('boolean: leaves an unrecognised token alone so the server annotates type-error', () =>
    expect(coerceCellForType('maybe', 'boolean')).toBe('maybe'));
  it('date: normalises to ISO yyyy-mm-dd', () => {
    expect(coerceCellForType('12/31/2026', 'date')).toBe('2026-12-31');
    expect(coerceCellForType('2026-12-31T00:00:00Z', 'date')).toBe('2026-12-31');
  });
  it('date: refuses an ambiguous dd/mm vs mm/dd rather than guessing', () => {
    // 03/04/2026 is either 3 April or 4 March. Guessing silently mis-dates a
    // whole fleet's warranties; the operator picks the format in the mapper.
    expect(coerceCellForType('03/04/2026', 'date')).toBe('03/04/2026');
  });
  it('text: never trims to empty-as-null — a blank cell is "no data" and the row omits it', () =>
    expect(coerceCellForType('  ', 'text')).toBeNull());
});
```

Add a date-format selector to the mapping UI (`MM/DD/YYYY` | `DD/MM/YYYY` | `ISO`), defaulting to ISO, and pass it into `coerceCellForType`.

- [ ] **Step 2: Implement, then the step component**

Chunked commit: split at `MAX_IMPORT_ROWS` **and** `MAX_IMPORT_VALUES`, mirroring the server caps from a single shared constant in `packages/shared` so the two cannot drift. Cumulative progress across chunks; every chunk through `runAction`; partial success surfaced with the per-value counts (**values, not rows** — the summary counts must reconcile against "30,000 in the file").

- [ ] **Step 3: Run, commit.**

### Task 4: Entry points and wiring

**Files:**
- Create: `apps/web/src/components/devices/RmmCustomFieldImport.tsx`
- Modify: the device list page and `CustomFieldsPage.tsx` to launch it
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` — add the three new components to `TARGET_GLOBS`

- [ ] **Step 1: Wire the wizard**

Step state in `window.location.hash` (`#import-definitions`, `#import-values`), never query params.

- [ ] **Step 2: Add the components to the no-silent-mutations adopted set**

```ts
// #3257: the RMM custom-field importer. Every preview and commit POST is a
// multi-tenant write of customer data with a partial-success body — exactly the
// class this guard exists for, and the class where a silent failure looks
// identical to "nothing matched".
'src/components/devices/RmmCustomFieldImport.tsx',
'src/components/devices/CustomFieldDefinitionImportStep.tsx',
'src/components/devices/CustomFieldValueImportStep.tsx',
```

- [ ] **Step 3: Add the E2E spec**

`e2e-tests/tests/custom-field-import.spec.ts` with a Page Object under `e2e-tests/pages/`. Cover the one flow that unit tests cannot: upload → map → preview → **pick a candidate for an ambiguous row** → commit → the value appears on the device detail page. Query by `data-testid` only.

- [ ] **Step 4: Run everything and commit**

```bash
cd apps/web && npx vitest run src/components/devices/ src/lib/__tests__/no-silent-mutations.test.ts
pnpm lint
cd ../../e2e-tests && pnpm test custom-field-import
git add apps/web/src e2e-tests
git commit -m "feat(web): Import from another RMM wizard for custom fields

Refs #3257"
```

---

# Wave 10 — Docs

**Files:**
- Modify: `apps/docs/src/content/docs/migration/overview.mdx` (the phase list)
- Modify: `datto-rmm.mdx`, `ninjaone.mdx`, `connectwise-automate.mdx`, `n-central.mdx`
- Modify: `apps/docs/src/content/docs/features/custom-fields.mdx`

- [ ] **Step 1: Update the migration overview**

Add the custom-field backfill as its own phase after enrollment, stating plainly that it is a **second pass run after devices exist**, that it is safe to re-run, and that recording the incumbent's device UID on the first run makes every later run exact.

- [ ] **Step 2: Per-vendor field surfaces**

Name the exact source surface for each, as the issue does:

| Guide | Field surface to document |
|---|---|
| `datto-rmm.mdx` | `udf1`–`udf30` per device, `GET /api/v2/device/{uid}` → `udf`; one partner-wide definitions import, not 200 org ones |
| `ninjaone.mdx` | custom fields at global / organization / location / device scope; global → partner-wide, org/location → org-owned |
| `connectwise-automate.mdx` | EDFs at computer scope (`extradatavalues` / `extrafield`) → partner-wide; **location/client EDFs are out of scope** |
| `n-central.mdx` | custom properties at device scope → partner-wide; **customer/site properties are out of scope** |

Say what is *not* imported as plainly as what is — an operator discovering the gap mid-migration is the failure this section prevents.

- [ ] **Step 3: Update the custom-fields feature doc**

Document the behaviour changes users will notice: values are now validated against their declared type on every write path (W04); an org-owned key may no longer shadow an all-organizations key (W03); `field_key` is unique per owner (W02).

- [ ] **Step 4: Verify the published URLs and commit**

```bash
cd apps/docs && pnpm build
git add apps/docs
git commit -m "docs: custom-field import in the migration guides

Refs #3257"
```

When citing these pages later, cite the published `docs.breezermm.com` URL and `curl` it for a 200 first — never the source path.

---

## Known-inert surfaces — flagged, not fixed

File these as follow-up issues during W08; **do not fix them in this plan.**

- **No dynamic group re-evaluates after an import**, for two independent reasons: `events/deviceEvents.ts:114` maps `customFields → 'custom'` while `filterEngine.ts:685-687` records the verbatim `custom.<key>`, so an array-overlap lookup never matches; and `initializeDeviceEventHandlers` (`deviceEvents.ts:170`) has **no caller anywhere** in `apps/api/src`. The whole device-change → `updateDeviceMemberships` pipeline is unwired. Imported values therefore do not affect targeting until something else touches the device.
- **MCP/AI exposure**: `customFields` is in `SAFE_DEVICE_RESOURCE_FIELDS` (`mcpServer.ts:1875`), so every imported value is exposed to the `breeze://devices/{id}` MCP resource on landing. The projection keeps this working unchanged — that is the point — but the exposure is worth stating.
- **Secret scanning at volume**: `custom-field-values` is classified `'customer-authored'` (`partnerApi/exportSafety.classification.ts:46`). A competitor's UDF dump is a plausible way for credentials to arrive in bulk into a store whose own route header warns it is "NOT A SECRETS STORE". Confirm the heuristic does not false-positive at volume and block a partner export.
- **Recording incumbent identity at enrollment** so late-arriving devices are backfilled on arrival. The pattern exists (`modules/mcpInvites/matchInviteOnEnrollment.ts:28-54`) and becomes trivial once `device_external_links` exists.

## Explicitly out of scope

- **Org- and site-level custom fields.** `custom_field_definitions` has no site axis, and organizations/sites carry only a generic `settings` jsonb with no value home. Narrower than it looks now that #3258 shipped: the most valuable org-level fields in practice (contract reference, account manager) are contact/contract data, which `organization_contacts` and the contracts module already model.
- **Vendor API pull.** Every source needs its own credential, paging and rate limit. The seam is left open the way `orgImport` did it — a `DeviceCustomFieldImportSource` interface producing canonical rows, with `csv` as the only implementation — so a Datto connector is additive later, not a rewrite.
- **Importing values for devices that do not exist.** A value with no device is a pending join with no expiry. `device_external_links` makes the re-run after later enrollment exact, which is the right answer.
- **Changing a definition's `type` on re-import.** Immutable today; a conflict, never a silent cast.
- **Dynamic-group recompute after import** — the pipeline is unwired; separate issue.
- Contacts (#3258, shipped) and orgs/sites (#3242, shipped).

## Pre-PR checklist for every wave in this plan

Run these before opening any wave PR. Local green is not CI green.

```bash
# 1. Migrations sort after origin/main's newest — the ceiling moves under you.
git fetch origin main && bash scripts/check-migration-naming.sh --against-ref origin/main

# 2. Merge main first: PR CI tests the MERGE COMMIT, not your branch.
git merge origin/main

# 3. Unit + web + shared.
pnpm --filter @breeze/api test --run && pnpm --filter @breeze/web test --run && pnpm lint

# 4. The suites `pnpm test` does NOT run, and which are the only place several
#    of this plan's contracts can fail.
cd apps/api
npx vitest run --config vitest.config.rls.ts
npx vitest run --config vitest.integration.config.ts

# 5. Schema drift.
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift

# 6. Verify RLS as the app role, per the tenancy checklist.
docker exec -it breeze-postgres psql -U breeze_app -d breeze
# forge a cross-tenant insert into each new table; must fail with
# "new row violates row-level security policy"
```

**If a wave PR is stacked on a sibling branch rather than `main`, `ci.yml` runs no CI at all** (`pull_request: branches: [main]`), and `gh pr checks` reads as green. Dispatch it explicitly before merging: `gh workflow run CI --ref <branch>`.

Tear down any local stack when the wave is done — `docker compose ls -a` is the truth.
