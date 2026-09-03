# Unrated Patch Auto-Approve Signaling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Patches with no severity rating (`patches.severity IS NULL`, or the sentinel value `'unknown'`) already never auto-approve — that fail-closed behavior is correct and stays unchanged. This plan makes the hold *visible*: stop the web UI from mislabeling unrated patches as "Low" severity, add an explicit "Unrated" badge that explains itself, warn admins on the ring config screen that unrated patches sit outside severity-based auto-approve, add an opt-in toggle for admins who want to auto-approve them anyway, and surface a count of pending unrated patches on the compliance summary and dashboard.

**Architecture:** No new tables, no migrations, no RLS/tenancy shape change. The opt-in lives as a new key inside the existing `patch_policies.auto_approve` JSONB column (mirroring how `thirdPartyApps` was added), following the same optional-field + `mergeRingAutoApproveWrite` merge pattern already established for that column. The evaluator's two `!patch.severity` guards (category-rule path and ring-level path in `apps/api/src/services/patchApprovalEvaluator.ts`) are extended to also treat DB `severity = 'unknown'` as unrated (today they only catch `NULL` by accident of the falsy check), and to only bypass the hold when a new `autoApproveUnrated` flag is explicitly on. The web fix, which is independently valuable, corrects `normalizeSeverity()` in `apps/web/src/components/patches/patchHelpers.ts`, which currently silently coerces `severity: null` and any unrecognized value (including `'unknown'`) to `'low'` — actively mislabeling unrated patches, not just failing to label them.

**Tech Stack:** Hono routes (`apps/api/src/routes`), Drizzle (JSONB column, no schema change), Zod validators (`packages/shared/src/validators`), React + react-hook-form + Zod resolver (`apps/web/src/components/patches`), Vitest for all layers.

**Spec:** GitHub issue [LanternOps/breeze#3758](https://github.com/LanternOps/breeze/issues/3758) — this plan document also serves as the spec; no separate spec doc exists.

## Global Constraints

- **No migration, no schema change.** `autoApproveUnrated` is a new key inside the *existing* `patch_policies.auto_approve` JSONB column and the *existing* `category_rules` JSONB array column — never a new top-level column. This is a deliberate scope choice (see "Tenancy / RLS / cascade impact" below) to avoid migration + export-registry churn for a boolean opt-in, matching how `thirdPartyApps` was added to the same column.
- **Fail-closed stays fail-closed.** The default for `autoApproveUnrated` is `false` everywhere (schema, merge fallback, evaluator). An unrated patch never auto-approves unless an admin explicitly opts in. Do not change this default in any task.
- **`'unknown'` and `NULL` are both "unrated."** `patches.severity` is a nullable enum that also has a literal `'unknown'` value (`patchSeverityEnum`, `apps/api/src/db/schema/patches.ts`). Today the evaluator's `!patch.severity` check only catches `NULL` (empty string) by the accident of JS truthiness — `'unknown'` is truthy and separately fails the `severityAllowlist.includes(...)` check. Every task that reasons about "unrated" must treat both the same way: a `isUnratedSeverity(severity: string | null | undefined) => !severity || severity === 'unknown'` predicate, not a bare `!severity` check.
- **Follow the `thirdPartyApps` precedent exactly** for every new optional field on `ringAutoApproveSchema` / `categoryRuleSchema`: no `.default()` in the Zod schema (an absent field means "writer predates this field", not "explicit false"), and add merge-preservation logic to `mergeRingAutoApproveWrite` so an old-shape PATCH body doesn't silently reset a previously-set opt-in.
- Every route file already in this area (`updateRings.ts`, `patches/compliance.ts`) uses Hono + Drizzle + the existing `authMiddleware`/`requirePermission`/`requireScope` chain — new work matches those, no new middleware.

---

## Tenancy / RLS / cascade impact (read before Wave 2)

This section is the CLAUDE.md-required tenancy callout. Read once; applies to every backend task below.

- **Migration: none.** No new table, no new top-level column on any existing table. `autoApproveUnrated` is nested inside `patch_policies.auto_approve` (jsonb) and, for category overrides, inside `patch_policies.category_rules` (jsonb array). Both columns already exist and already carry a Zod-validated typed shape (`ringAutoApproveSchema`, `categoryRuleSchema`) that this plan extends in place.
- **RLS shape: unchanged.** `patch_policies` is tenancy shape 3 (partner-axis, `breeze_has_partner_access(partner_id)`), already registered in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`['patch_policies', 'partner_id']`). Adding a key inside an already-RLS'd JSONB column does not change the table's RLS shape — no policy edits, no allowlist edits.
- **Cascade registration (the four lists): none required.**
  - `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts`): N/A — `patch_policies` has no `org_id` column at all (partner-only), so it was never in this list and isn't affected. It's covered by the partner-axis dynamic sweep in `cascadeDeletePartner()`, which needs no per-table registration.
  - `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`): N/A — `patch_policies` has no `device_id` column.
  - `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts`): N/A, and this is the one CLAUDE.md warns fires on a bare **column** addition to an already-registered table — but `patch_policies` was never registered there in the first place, because that registry only covers tables with an `organizationKey: 'id' | 'org_id'`, and `patch_policies` has neither (it's `partnerId`-only). Confirmed via `apps/api/src/services/tenantExportPolicyRegistry.ts`: no `patch_policies` entry exists today. A new key inside its `auto_approve` jsonb blob does not change that — still no entry needed.
  - If a future task instead added `autoApproveUnrated` as a **new top-level column** on `patch_policies` (not what this plan does), the export-policy row still would not fire (no org-key), but the `updateRings.ts` `GET /` explicit column select list (`updateRings.ts:191-208`) would need the new column added to stay visible — noted here only so nobody "fixes" this plan into that shape without re-checking that list.
- **Partner-Wide First (epic #2135) / dual-ownership default: does not apply.** `patch_policies` is a pre-existing table, not one this plan creates. It predates the epic's `org_id XOR partner_id` default and is *already* fully partner-scoped (`partnerId NOT NULL`, no `org_id` column at all — narrower than dual-axis, not broader). Update Rings are explicitly partner-level tooling by design (`updateRings.ts:45-51`, `canManagePartnerWidePolicies`). This plan adds a field inside that table's existing JSONB column; it does not touch ownership shape.
- **Net effect:** none of the four registration lists change in this plan. Wave 2's tests should still run the RLS coverage integration suite once (see Wave 2 verification) to confirm this — cheap insurance, not because a change is expected.

---

## CI traps for this plan (read before opening any PR)

- **Wave 3 is stacked on Wave 2.** The web ring-form toggle only does something once the API/shared-validator field exists; branch Wave 3 off Wave 2's branch rather than off `main`. Per CLAUDE.md: a PR whose base is a sibling branch (not `main`) gets **no CI at all** from `ci.yml` (only the two non-blocking `smoke-binary-source-*` workflows run), so `gh pr checks` on the Wave 3 PR will read green while nothing actually ran. Before merging Wave 3, dispatch CI explicitly for that branch: `gh workflow run CI --ref <wave-3-branch>`. Waves 1 and 4 have no such dependency and can each be branched directly off `main`.
- **`pnpm test` does not run the RLS/integration suites.** Even though this plan asserts "no RLS/cascade change," Wave 2 touches `patch_policies`-adjacent code (the evaluator, the ring route) closely enough that it's worth actually running `apps/api/vitest.config.rls.ts` and `apps/api/vitest.integration.config.ts` locally before opening the PR, not just the default `pnpm test`.
- **Scoping a single test file:** use `cd apps/api && npx vitest run <path>` (or `pnpm --filter @breeze/api test --run <path>`, no `--`) per CLAUDE.md's test-running section — never `pnpm --filter <pkg> test -- --run <path>` (runs the whole suite) and never a trailing-slash directory filter for files with dotted siblings (`patchApprovalEvaluator.test.ts` has no dotted siblings today, but `compliance.test.ts` and `updateRings*.test.ts` are split across multiple files with shared prefixes — list them explicitly if scoping).

---

## Wave 1 — Web: stop mislabeling unrated patches; add an explicit "Unrated" badge

**Independently shippable:** yes. Pure frontend, reads an API field (`severity: string | null`) that already flows through unchanged today. No backend dependency, no flag.

**Files:**
- Modify: `apps/web/src/components/patches/patchHelpers.ts`
- Modify: `apps/web/src/components/patches/PatchList.tsx`
- Modify: `apps/web/src/locales/en/patches.json`
- Test: `apps/web/src/components/patches/patchHelpers.test.ts`
- Test: `apps/web/src/components/patches/PatchList.test.tsx`

**Interfaces:**
- Produces: `PatchSeverity` widened to include `'unrated'` (exported from `PatchList.tsx`, consumed by `patchHelpers.ts`, `UpdateRingForm.tsx` stays on its own separate `Severity` type — untouched in this wave, see Wave 3).
- Produces: `normalizeSeverity(value?: string): PatchSeverity` now returns `'unrated'` for `undefined`/`null`/empty/`'unknown'`/any unrecognized string, instead of silently defaulting to `'low'`.

### Task 1.1: Widen `PatchSeverity` and stop the silent `'low'` fallback

- [ ] **Step 1: Write the failing test for `normalizeSeverity` via `normalizePatch`**

Add to `apps/web/src/components/patches/patchHelpers.test.ts` (create the file with this content if it doesn't already cover `normalizePatch`; if it exists, add these cases to the existing `describe('normalizePatch'`-equivalent block):

```ts
import { describe, it, expect } from 'vitest';
import { normalizePatch } from './patchHelpers';

describe('normalizePatch severity', () => {
  it('maps a null severity to "unrated", not "low"', () => {
    const patch = normalizePatch({ id: 'p1', title: 'KB123', severity: null }, 0);
    expect(patch.severity).toBe('unrated');
  });

  it('maps a missing severity field to "unrated"', () => {
    const patch = normalizePatch({ id: 'p1', title: 'KB123' }, 0);
    expect(patch.severity).toBe('unrated');
  });

  it('maps the literal "unknown" severity to "unrated"', () => {
    const patch = normalizePatch({ id: 'p1', title: 'KB123', severity: 'unknown' }, 0);
    expect(patch.severity).toBe('unrated');
  });

  it('still maps recognized severities correctly', () => {
    expect(normalizePatch({ id: 'p1', title: 't', severity: 'critical' }, 0).severity).toBe('critical');
    expect(normalizePatch({ id: 'p1', title: 't', severity: 'high' }, 0).severity).toBe('important');
    expect(normalizePatch({ id: 'p1', title: 't', severity: 'medium' }, 0).severity).toBe('moderate');
    expect(normalizePatch({ id: 'p1', title: 't', severity: 'low' }, 0).severity).toBe('low');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/patches/patchHelpers.test.ts`
Expected: FAIL — `null`/missing/`'unknown'` cases currently return `'low'`, not `'unrated'`.

- [ ] **Step 3: Widen `PatchSeverity` in `PatchList.tsx`**

In `apps/web/src/components/patches/PatchList.tsx`, change:

```ts
export type PatchSeverity = 'critical' | 'important' | 'moderate' | 'low';
```

to:

```ts
export type PatchSeverity = 'critical' | 'important' | 'moderate' | 'low' | 'unrated';
```

- [ ] **Step 4: Fix `normalizeSeverity` in `patchHelpers.ts`**

Replace:

```ts
function normalizeSeverity(value?: string): PatchSeverity {
  if (!value) return 'low';
  return severityMap[value.toLowerCase()] ?? 'low';
}
```

with:

```ts
function normalizeSeverity(value?: string): PatchSeverity {
  if (!value) return 'unrated';
  const normalized = value.toLowerCase();
  if (normalized === 'unknown') return 'unrated';
  return severityMap[normalized] ?? 'unrated';
}
```

(`severityMap` itself is unchanged — it stays the recognized-value lookup table; only the two fallback branches change from `'low'` to `'unrated'`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/patches/patchHelpers.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/patches/patchHelpers.ts apps/web/src/components/patches/patchHelpers.test.ts apps/web/src/components/patches/PatchList.tsx
git commit -m "fix(patches): stop coercing unrated patch severity to Low"
```

### Task 1.2: Render an explicit "Unrated" badge with explanatory text

**Interfaces:**
- Consumes: `PatchSeverity` (now includes `'unrated'`) from Task 1.1.
- Produces: `severityConfig` covers all five `PatchSeverity` values (compile-time exhaustiveness via `Record<PatchSeverity, ...>` — a missing key is now a type error, which is why Task 1.1's widen must land first).

- [ ] **Step 1: Write the failing test for the badge**

Add to `apps/web/src/components/patches/PatchList.test.tsx` (follow the existing render-and-query pattern in that file — import `render`, `screen` from `@testing-library/react` as the file already does):

```tsx
it('renders an Unrated badge with a will-not-auto-approve note for a null-severity patch', () => {
  render(
    <PatchList
      patches={[
        {
          id: 'p1',
          title: 'KB5000001',
          severity: 'unrated',
          source: 'microsoft',
          os: 'Windows',
          releaseDate: '2026-08-01',
          approvalStatus: 'pending',
        },
      ]}
    />
  );

  expect(screen.getByText('Unrated')).toBeInTheDocument();
  expect(screen.getByText(/will not auto-approve/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/patches/PatchList.test.tsx`
Expected: FAIL — no `'unrated'` entry in `severityConfig` (TypeScript error under `Record<PatchSeverity, ...>`) and no "Unrated"/"will not auto-approve" text rendered.

- [ ] **Step 3: Add the `unrated` entry to `severityConfig` and render the explanatory note**

In `apps/web/src/components/patches/PatchList.tsx`, extend `severityConfig`:

```ts
const severityConfig: Record<PatchSeverity, { labelKey: string; color: string }> = {
  critical: { labelKey: 'patchList.severity.critical', color: 'bg-red-500/20 text-red-700 border-red-500/40' },
  important: { labelKey: 'patchList.severity.important', color: 'bg-orange-500/20 text-orange-700 border-orange-500/40' },
  moderate: { labelKey: 'patchList.severity.moderate', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  low: { labelKey: 'patchList.severity.low', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  unrated: { labelKey: 'patchList.severity.unrated', color: 'bg-muted text-muted-foreground border-border' }
};
```

Extend `severityRank` (same file, so sort doesn't crash on the new key — rank unrated last, after `low`):

```ts
const severityRank: Record<PatchSeverity, number> = {
  critical: 0,
  important: 1,
  moderate: 2,
  low: 3,
  unrated: 4
};
```

Update `renderSeverityBadge` to append the explanatory note next to the badge (both the desktop table cell and the mobile `CardField` reuse this one function, so both surfaces get the note automatically):

```tsx
const renderSeverityBadge = (patch: Patch) => {
  const severity = severityConfig[patch.severity];
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className={cn('inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-xs font-medium', severity.color)}>
        {t(/* i18n-dynamic */ severity.labelKey)}
      </span>
      {patch.severity === 'unrated' && (
        <span className="text-[10px] text-muted-foreground">{t('patchList.severity.unratedNote')}</span>
      )}
    </span>
  );
};
```

- [ ] **Step 4: Add the locale strings**

In `apps/web/src/locales/en/patches.json`, inside the existing `"severity"` object under `"patchList"` (currently lines 242-247), add two keys:

```json
"severity": {
  "critical": "Critical",
  "important": "Important",
  "moderate": "Moderate",
  "low": "Low",
  "unrated": "Unrated",
  "unratedNote": "Will not auto-approve"
},
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/patches/PatchList.test.tsx`
Expected: PASS

- [ ] **Step 6: Run the full patches component suite + typecheck to catch any other exhaustive-`Record<PatchSeverity,...>` site**

Run: `cd apps/web && npx vitest run src/components/patches/`
Run: `pnpm --filter @breeze/web exec tsc --noEmit` (or the repo's web typecheck entry point if different — there is no root typecheck script per CLAUDE.md, so run it inside the package)
Expected: all PASS; typecheck surfaces any other `Record<PatchSeverity, ...>` (e.g. a filter dropdown) that also needs an `'unrated'` case — extend it the same way if found (follow the same badge-note pattern; do not add a placeholder).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/patches/PatchList.tsx apps/web/src/components/patches/PatchList.test.tsx apps/web/src/locales/en/patches.json
git commit -m "feat(patches): show an explicit Unrated badge with auto-approve note"
```

---

## Wave 2 — API + shared validators: opt-in `autoApproveUnrated`, wired into the evaluator

**Independently shippable:** yes, standalone — ships real behavior change (an admin can already flip the flag via a raw API PATCH once this merges, even before Wave 3's UI exists) and is fully covered by its own tests. Wave 3 depends on this wave merging first (see CI traps above).

**Files:**
- Modify: `packages/shared/src/validators/index.ts`
- Modify: `apps/api/src/routes/updateRings.ts`
- Modify: `apps/api/src/services/patchApprovalEvaluator.ts`
- Test: `packages/shared/src/validators/index_inline_settings.test.ts`
- Test: `apps/api/src/services/patchApprovalEvaluator.test.ts`

**Interfaces:**
- Produces: `ringAutoApproveSchema` gains optional `autoApproveUnrated: boolean`.
- Produces: `categoryRuleSchema` (in `updateRings.ts`) gains optional `autoApproveUnrated: boolean`.
- Produces: `mergeRingAutoApproveWrite(incoming, storedRaw)` return type gains `autoApproveUnrated: boolean` (always concrete, default `false`).
- Produces: `RingAutoApproveConfig` (evaluator-internal) gains `autoApproveUnrated: boolean`; `parseRingAutoApprove` populates it.
- Produces: `CategoryRule` (evaluator-internal) gains optional `autoApproveUnrated?: boolean`.
- Produces: `isUnratedSeverity(severity: string | null | undefined): boolean` — new exported helper in `patchApprovalEvaluator.ts`, `true` for `null`/`undefined`/`''`/`'unknown'`.

### Task 2.1: Add `autoApproveUnrated` to the shared ring auto-approve schema and its merge function

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/validators/index_inline_settings.test.ts`, inside (or right after) the existing `describe('ringAutoApproveSchema', ...)` block:

```ts
it('accepts autoApproveUnrated as an optional boolean, absent by default', () => {
  const result = ringAutoApproveSchema.safeParse({ enabled: true, severities: ['critical'], deferralDays: 0 });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.autoApproveUnrated).toBeUndefined();
  }
});

it('accepts an explicit autoApproveUnrated: true alongside severities', () => {
  const result = ringAutoApproveSchema.safeParse({
    enabled: true, severities: ['critical'], deferralDays: 0, autoApproveUnrated: true,
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.autoApproveUnrated).toBe(true);
  }
});

it('mergeRingAutoApproveWrite: absent autoApproveUnrated carries the stored value; explicit value wins; create defaults to false', () => {
  const incoming = ringAutoApproveSchema.parse({ enabled: true, severities: ['low'], deferralDays: 2 });
  expect(mergeRingAutoApproveWrite(incoming, {
    enabled: true, severities: ['critical'], deferralDays: 0, autoApproveUnrated: true,
  }).autoApproveUnrated).toBe(true);

  const explicitOff = ringAutoApproveSchema.parse({
    enabled: true, severities: ['low'], deferralDays: 0, autoApproveUnrated: false,
  });
  expect(mergeRingAutoApproveWrite(explicitOff, {
    enabled: true, severities: [], deferralDays: 0, autoApproveUnrated: true,
  }).autoApproveUnrated).toBe(false);

  expect(mergeRingAutoApproveWrite(incoming, undefined).autoApproveUnrated).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/validators/index_inline_settings.test.ts`
Expected: FAIL — `autoApproveUnrated` doesn't exist on the schema or the merge return type yet.

- [ ] **Step 3: Extend `ringAutoApproveSchema`**

In `packages/shared/src/validators/index.ts`, add the field right after `thirdPartyDeferralDays` (before the closing `})` and `.superRefine`):

```ts
export const ringAutoApproveSchema = z.object({
  enabled: z.boolean().default(false),
  severities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])).default([]),
  deferralDays: z.number().int().min(0).max(365).default(0),
  thirdPartyApps: z.boolean().optional(),
  thirdPartyDeferralDays: z.number().int().min(0).max(365).nullable().optional(),
  // Opt-in to auto-approving patches with no severity rating (severity IS NULL
  // or the 'unknown' sentinel) — issue #3758. Fail-closed default: unrated
  // patches never auto-approve unless this is explicitly true. OPTIONAL (no
  // default) for the same old-shape-preservation reason as thirdPartyApps: an
  // omitted value means "writer predates this field" and is preserved by
  // mergeRingAutoApproveWrite, not reset to false.
  autoApproveUnrated: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.enabled && data.severities.length === 0 && !data.thirdPartyApps) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['severities'],
      message: 'Select at least one severity or enable third-party app auto-approval.',
    });
  }
});
```

(Deliberately do not add `autoApproveUnrated` to the `superRefine` OR-condition — an admin must still select at least one severity or third-party before the ring is considered "configured"; `autoApproveUnrated` is additive on top of that, matching the issue's suggestion #3 framing of it as a widening toggle, not a standalone auto-approve-everything switch.)

- [ ] **Step 4: Extend `mergeRingAutoApproveWrite`**

In the same file, update the return type and body:

```ts
export function mergeRingAutoApproveWrite(
  incoming: RingAutoApprove,
  storedRaw: unknown
): {
  enabled: boolean;
  severities: RingAutoApprove['severities'];
  deferralDays: number;
  thirdPartyApps: boolean;
  thirdPartyDeferralDays: number | null;
  autoApproveUnrated: boolean;
} {
  let storedThirdPartyApps = false;
  let storedThirdPartyDeferralDays: number | null = null;
  let storedAutoApproveUnrated = false;
  if (storedRaw && typeof storedRaw === 'object') {
    const stored = storedRaw as Record<string, unknown>;
    const storedSeverities = Array.isArray(stored.severities)
      ? stored.severities.filter(
          (s): s is string => typeof s === 'string' && RING_AUTO_APPROVE_SEVERITIES.has(s)
        )
      : [];
    storedThirdPartyApps =
      'thirdPartyApps' in stored ? stored.thirdPartyApps === true : storedSeverities.length > 0;
    const rawTp = stored.thirdPartyDeferralDays;
    storedThirdPartyDeferralDays =
      typeof rawTp === 'number' && Number.isInteger(rawTp) && rawTp >= 0 && rawTp <= 365
        ? rawTp
        : null;
    storedAutoApproveUnrated = stored.autoApproveUnrated === true;
  }
  return {
    enabled: incoming.enabled,
    severities: incoming.severities,
    deferralDays: incoming.deferralDays,
    thirdPartyApps: incoming.thirdPartyApps ?? storedThirdPartyApps,
    thirdPartyDeferralDays:
      incoming.thirdPartyDeferralDays !== undefined
        ? incoming.thirdPartyDeferralDays
        : storedThirdPartyDeferralDays,
    autoApproveUnrated: incoming.autoApproveUnrated ?? storedAutoApproveUnrated,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/shared && npx vitest run src/validators/index_inline_settings.test.ts`
Expected: PASS (including all pre-existing tests in this `describe` block — the new field must not break the fail-closed-defaults test, which asserts exact `toEqual` on an empty parse; confirm that test still passes since `autoApproveUnrated` is optional-with-no-default and won't appear in the parsed object for `{}` input).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/index.ts packages/shared/src/validators/index_inline_settings.test.ts
git commit -m "feat(shared): add autoApproveUnrated opt-in to ringAutoApproveSchema"
```

### Task 2.2: Add `autoApproveUnrated` to the ring route's category-rule schema and default

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/updateRings.test.ts`-equivalent (per the Explore report, ring routes are split across `updateRings_list_create.test.ts`, `updateRings_detail_update_delete.test.ts`, etc. — add this to `apps/api/src/routes/updateRings_detail_update_delete.test.ts`, next to the other `categoryRules`/`autoApprove` PATCH tests in that file):

```ts
it('accepts autoApproveUnrated on the default rule and persists it in auto_approve', async () => {
  // Follow this file's existing pattern for creating/patching a ring and
  // reading back patchPolicies.autoApprove — mirror whatever helper the
  // adjacent "thirdPartyApps" round-trip test in this file already uses for
  // request auth/setup instead of duplicating it here.
  const response = await patchRing(ringId, {
    autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0, autoApproveUnrated: true },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.autoApprove.autoApproveUnrated).toBe(true);
});
```

(This step names the test intent and the exact assertion; wire it to whatever request-building helper — e.g. an existing `patchRing(id, body)` wrapper around a signed-in `app.request(...)` call — the adjacent tests in this file already use. Do not invent a second helper.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/updateRings_detail_update_delete.test.ts`
Expected: FAIL — `autoApproveUnrated` not accepted by `updateRingSchema`'s nested `ringAutoApproveSchema` yet propagates from Task 2.1, but `categoryRuleSchema` and `DEFAULT_RING_AUTO_APPROVE` in this file also need updating for full coverage (category-rule case tested in Task 2.3's evaluator tests, not duplicated here).

- [ ] **Step 3: Update `DEFAULT_RING_AUTO_APPROVE` and `categoryRuleSchema` in `updateRings.ts`**

```ts
// Typed default for a ring's autoApprove JSONB (#1317). A freshly created or
// auto-provisioned ring auto-approves nothing until an operator opts in.
const DEFAULT_RING_AUTO_APPROVE = {
  enabled: false, severities: [], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: null,
  autoApproveUnrated: false,
} as const;
```

```ts
const categoryRuleSchema = z.object({
  category: z.string().max(100).refine((c) => c.trim().toLowerCase() !== 'third_party_app', {
    message: "The 'third_party_app' category rule was replaced by autoApprove.thirdPartyApps on the ring.",
  }),
  autoApprove: z.boolean(),
  autoApproveSeverities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])).optional(),
  autoApproveUnrated: z.boolean().optional(),
  deferralDaysOverride: z.number().int().min(0).max(365).nullable().optional(),
});
```

(`createRingSchema` and `updateRingSchema` already embed `ringAutoApproveSchema` and `categoryRuleSchema` by reference — no change needed to those two schema objects themselves, since Task 2.1 already extended `ringAutoApproveSchema` in the shared package.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/updateRings_detail_update_delete.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/updateRings.ts apps/api/src/routes/updateRings_detail_update_delete.test.ts
git commit -m "feat(patches): accept autoApproveUnrated on ring default rule and category overrides"
```

### Task 2.3: Wire `autoApproveUnrated` into the evaluator's two severity guards

**Interfaces:**
- Consumes: `RingAutoApproveConfig` and `CategoryRule` types (this task extends both, in the same file where they're already defined).

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/services/patchApprovalEvaluator.test.ts`, inside the existing `describe('ring-level auto-approve', ...)` block (right after the existing "does NOT auto-approve a null-severity patch under a restricted severity list" test at line 947-969):

```ts
it('auto-approves a null-severity patch when autoApproveUnrated is true', async () => {
  mockPendingAndApprovals([pendingRow({ patchId: P1, severity: null })], []);

  const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
    ringId: RING_ID,
    categoryRules: [],
    autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0, autoApproveUnrated: true },
    deferralDays: 0,
  });

  expect(result).toHaveLength(1);
  expect(result[0]?.approvalReason).toBe('ring_auto_approve');
});

it('auto-approves a severity:"unknown" patch when autoApproveUnrated is true (same as null)', async () => {
  mockPendingAndApprovals([pendingRow({ patchId: P1, severity: 'unknown' })], []);

  const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
    ringId: RING_ID,
    categoryRules: [],
    autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0, autoApproveUnrated: true },
    deferralDays: 0,
  });

  expect(result).toHaveLength(1);
  expect(result[0]?.approvalReason).toBe('ring_auto_approve');
});

it('still holds a null-severity patch when autoApproveUnrated is false (default)', async () => {
  mockPendingAndApprovals([pendingRow({ patchId: P1, severity: null })], []);

  const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
    ringId: RING_ID,
    categoryRules: [],
    autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0 },
    deferralDays: 0,
  });

  expect(result).toEqual([]);
});
```

Add a new `describe` block for the category-rule path, near the existing `describe('category rules — repaired semantics (#spec 2026-08-04)', ...)` block:

```ts
describe('category rule autoApproveUnrated (#3758)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('auto-approves a null-severity patch matching a category rule with autoApproveUnrated: true', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, category: 'security', severity: null })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [
        { category: 'security', autoApprove: true, autoApproveSeverities: ['critical'], autoApproveUnrated: true },
      ],
      autoApprove: { enabled: false, severities: [], deferralDays: 0 },
      deferralDays: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('category_rule');
  });

  it('holds a null-severity patch matching a category rule without autoApproveUnrated', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: P1, category: 'security', severity: null })],
      []
    );

    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID,
      categoryRules: [
        { category: 'security', autoApprove: true, autoApproveSeverities: ['critical'] },
      ],
      autoApprove: { enabled: false, severities: [], deferralDays: 0 },
      deferralDays: 0,
    });

    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/patchApprovalEvaluator.test.ts`
Expected: FAIL on all five new tests — `autoApproveUnrated` is not read by either guard yet.

- [ ] **Step 3: Add the `isUnratedSeverity` helper**

In `apps/api/src/services/patchApprovalEvaluator.ts`, add near the other exported helpers (e.g. right after `isThirdPartyPatchSource`, around line 215-230):

```ts
/**
 * True when a patch carries no usable severity signal: `severity` is
 * NULL/empty, or the DB's explicit `'unknown'` sentinel value. Both must be
 * treated identically by every auto-approve severity gate (#3758) — treating
 * only NULL as "unrated" left 'unknown'-severity patches falling through a
 * *different* code path that happened to reach the same fail-closed outcome,
 * which is fragile (see the two guards below).
 */
export function isUnratedSeverity(severity: string | null | undefined): boolean {
  return !severity || severity === 'unknown';
}
```

- [ ] **Step 4: Extend `CategoryRule` and update the category-rule guard**

Update the `CategoryRule` interface (near the top of the file, currently lines 25-33):

```ts
export interface CategoryRule {
  category: string;
  autoApprove: boolean;
  /** Severity allowlist — the canonical field name the route/UI write (updateRings.ts categoryRuleSchema). */
  autoApproveSeverities?: string[];
  /** @deprecated Legacy stored alias for autoApproveSeverities (rows/snapshots written before 2026-08). Read-only. */
  severityFilter?: string[];
  /** Opt-in: also auto-approve patches with no severity rating (#3758). Default false (fail-closed). */
  autoApproveUnrated?: boolean;
  deferralDaysOverride?: number | null;
}
```

Update the guard inside `evaluatePatchApproval` (currently lines 570-575):

```ts
const severityAllowlist = rule.autoApproveSeverities ?? rule.severityFilter;
if (severityAllowlist && severityAllowlist.length > 0) {
  if (isUnratedSeverity(patch.severity)) {
    if (!rule.autoApproveUnrated) {
      return null;
    }
  } else if (!severityAllowlist.includes(patch.severity)) {
    return null;
  }
}
```

- [ ] **Step 5: Extend `RingAutoApproveConfig`, `parseRingAutoApprove`, and update the ring-level guard**

Update `RingAutoApproveConfig` (currently lines 679-691):

```ts
interface RingAutoApproveConfig {
  enabled: boolean;
  severities: string[];
  /** Deferral window (days) for OS ring auto-approve. 0 = no deferral. */
  deferralDays: number;
  /** Third-party source-level auto-approve toggle (dual consent with policy sources). */
  thirdPartyApps: boolean;
  /**
   * Third-party hold override; null = inherit deferralDays. Anchored on
   * releaseDate when present, first-seen otherwise (#2218).
   */
  thirdPartyDeferralDays: number | null;
  /** Opt-in: also auto-approve OS patches with no severity rating (#3758). Default false (fail-closed). */
  autoApproveUnrated: boolean;
}
```

Update `DISABLED_RING_AUTO_APPROVE` (currently lines 695-701):

```ts
const DISABLED_RING_AUTO_APPROVE: RingAutoApproveConfig = {
  enabled: false,
  severities: [],
  deferralDays: 0,
  thirdPartyApps: false,
  thirdPartyDeferralDays: null,
  autoApproveUnrated: false,
};
```

In `parseRingAutoApprove`, add the parse for the new field right before the final `return` (currently line 766), and thread it through the two other early returns (`autoApprove === true` and the `config.enabled !== true` branch already return `DISABLED_RING_AUTO_APPROVE`, which now correctly carries `autoApproveUnrated: false` via the updated constant above — no extra change needed there):

```ts
const autoApproveUnrated = config.autoApproveUnrated === true;

return { enabled: true, severities, deferralDays, thirdPartyApps, thirdPartyDeferralDays, autoApproveUnrated };
```

Update the OS-path guard inside `evaluatePatchApproval` (currently lines 613-621):

```ts
// OS path: unchanged fail-closed severity gating, now also gated on the
// autoApproveUnrated opt-in for patches carrying no severity signal (#3758).
// Enabled with an empty severity set approves no OS patches (legacy boolean
// `true` and malformed `{enabled:true}` rows stay inert here).
if (ringAutoApprove.severities.length === 0) {
  return null;
}
if (isUnratedSeverity(patch.severity)) {
  if (!ringAutoApprove.autoApproveUnrated) {
    return null;
  }
} else if (!ringAutoApprove.severities.includes(patch.severity)) {
  return null;
}
if (isHeldByDeferral(patch, ringAutoApprove.deferralDays, now, 'ring')) {
  return null;
}
return 'ring_auto_approve';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/patchApprovalEvaluator.test.ts`
Expected: PASS — all five new tests, plus every pre-existing test in the file (in particular the "does NOT auto-approve a null-severity patch under a restricted severity list" test at line 947, which must still pass since it never sets `autoApproveUnrated`).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/patchApprovalEvaluator.ts apps/api/src/services/patchApprovalEvaluator.test.ts
git commit -m "feat(patches): honor autoApproveUnrated opt-in in ring and category-rule evaluator guards"
```

### Wave 2 verification (before opening the PR)

- [ ] Run the full API unit suite for touched files: `cd apps/api && npx vitest run src/services/patchApprovalEvaluator.test.ts src/routes/updateRings_list_create.test.ts src/routes/updateRings_detail_update_delete.test.ts src/routes/updateRings.partnerWide.test.ts`
- [ ] Run the shared package suite: `cd packages/shared && npx vitest run src/validators/index_inline_settings.test.ts`
- [ ] Run the RLS coverage integration suite once to confirm the "no tenancy shape change" claim above: `cd apps/api && npx vitest run --config vitest.config.rls.ts src/__tests__/integration/rls-coverage.integration.test.ts` (needs a live DB per CLAUDE.md — use the dev DB or `wt-stack`). Expected: PASS, no diff in `patch_policies` handling.
- [ ] `pnpm lint` from repo root.

---

## Wave 3 — Web: ring form warning note + opt-in toggle

**Independently shippable:** as a PR, yes — but functionally depends on Wave 2 being merged (the field it writes is silently dropped by the API's Zod schema until Wave 2 ships). Branch off Wave 2's branch; see "CI traps" above for the stacked-PR CI dispatch requirement.

**Files:**
- Modify: `apps/web/src/components/patches/UpdateRingForm.tsx`
- Modify: `apps/web/src/components/patches/patchHelpers.ts`
- Modify: `apps/web/src/locales/en/patches.json`
- Test: `apps/web/src/components/patches/UpdateRingForm.test.tsx`

**Interfaces:**
- Consumes: `autoApproveUnrated?: boolean` on the ring's `auto_approve` (Wave 2, Task 2.1/2.2) — the web schema and read/write normalization must match the API shape exactly (`enabled, severities, deferralDays, thirdPartyApps, thirdPartyDeferralDays, autoApproveUnrated`).
- Produces: `UpdateRingFormValues['autoApprove'].autoApproveUnrated: boolean` (form-side, always concrete — the web form pre-fills booleans, unlike the API's optional-for-merge convention).
- Produces: `UpdateRingItem['autoApprove'].autoApproveUnrated: boolean` (list/normalize side, in `patchHelpers.ts`).

### Task 3.1: Round-trip `autoApproveUnrated` through `normalizeRingAutoApprove` (read path)

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/patches/patchHelpers.test.ts`:

```ts
import { normalizeRing } from './patchHelpers';

describe('normalizeRing autoApprove.autoApproveUnrated', () => {
  it('defaults to false when absent from the stored auto_approve object', () => {
    const ring = normalizeRing({ id: 'r1', name: 'Ring 1', autoApprove: { enabled: true, severities: ['critical'] } });
    expect(ring.autoApprove?.autoApproveUnrated).toBe(false);
  });

  it('passes through an explicit true', () => {
    const ring = normalizeRing({
      id: 'r1', name: 'Ring 1',
      autoApprove: { enabled: true, severities: ['critical'], autoApproveUnrated: true },
    });
    expect(ring.autoApprove?.autoApproveUnrated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/patches/patchHelpers.test.ts`
Expected: FAIL — `normalizeRingAutoApprove` doesn't read `autoApproveUnrated` yet.

- [ ] **Step 3: Extend `normalizeRingAutoApprove` and `DISABLED_RING_AUTO_APPROVE`**

In `apps/web/src/components/patches/patchHelpers.ts`:

```ts
const DISABLED_RING_AUTO_APPROVE: NonNullable<UpdateRingItem['autoApprove']> = {
  enabled: false, severities: [], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: null,
  autoApproveUnrated: false,
};
```

Add the read at the end of `normalizeRingAutoApprove`, right before its final `return` (currently line 161):

```ts
const autoApproveUnrated = obj.autoApproveUnrated === true;

return { enabled: obj.enabled === true, severities, deferralDays, thirdPartyApps, thirdPartyDeferralDays, autoApproveUnrated };
```

(The `raw === true` legacy-boolean branch and the `!raw`/non-object branch both already `return`/spread `DISABLED_RING_AUTO_APPROVE`, which now carries `autoApproveUnrated: false` via the updated constant — no separate edit needed there, mirroring Wave 2 Task 2.3's `parseRingAutoApprove` structure exactly.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/patches/patchHelpers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/patches/patchHelpers.ts apps/web/src/components/patches/patchHelpers.test.ts
git commit -m "feat(patches): normalize autoApproveUnrated when reading a ring's stored auto_approve"
```

### Task 3.2: Add the warning note + opt-in toggle to the ring form

**Interfaces:**
- Consumes: `normalizeRing`'s `autoApproveUnrated` field (Task 3.1) as the form's `defaultValues` source (wherever the caller of `UpdateRingForm` currently maps a fetched `UpdateRingItem` into `UpdateRingFormDefaults` — the existing `thirdPartyApps`/`thirdPartyDeferralDays` mapping right next to it is the template to copy).

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/patches/UpdateRingForm.test.tsx`, following the existing render/interact pattern in that file (it already exercises `ring-auto-approve-enabled`, `ring-auto-approve-severity-critical`, etc. via `data-testid`):

```tsx
it('shows the unrated-patches warning note and an opt-in toggle once auto-approve is enabled', async () => {
  const user = userEvent.setup();
  render(<UpdateRingForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

  await user.click(screen.getByTestId('ring-auto-approve-enabled'));

  expect(screen.getByTestId('ring-unrated-severity-note')).toHaveTextContent(/unrated patches/i);
  expect(screen.getByTestId('ring-auto-approve-unrated-toggle')).toBeInTheDocument();
});

it('submits autoApproveUnrated: true when the opt-in toggle is checked', async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<UpdateRingForm onSubmit={onSubmit} onCancel={vi.fn()} />);

  await user.click(screen.getByTestId('ring-auto-approve-enabled'));
  await user.click(screen.getByTestId('ring-auto-approve-severity-critical'));
  await user.click(screen.getByTestId('ring-auto-approve-unrated-toggle'));
  await user.click(screen.getByRole('button', { name: /save ring/i }));

  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      autoApprove: expect.objectContaining({ autoApproveUnrated: true }),
    })
  );
});
```

(Match this file's existing `render(<UpdateRingForm .../>)` call signature and `userEvent` import — copy the setup block from an existing test in the same file rather than guessing prop names.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/patches/UpdateRingForm.test.tsx`
Expected: FAIL — neither the note nor the toggle exist yet.

- [ ] **Step 3: Extend `ringAutoApproveFormSchema`**

In `apps/web/src/components/patches/UpdateRingForm.tsx`, inside `makeRingSchema`:

```ts
const ringAutoApproveFormSchema = z.object({
  enabled: z.boolean(),
  severities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])),
  deferralDays: z.coerce.number().int().min(0).max(365),
  thirdPartyApps: z.boolean(),
  thirdPartyDeferralDays: z.coerce.number().int().min(0).max(365),
  // Opt-in: also auto-approve patches with no severity rating (#3758). Always
  // a concrete boolean in the form (unlike the API's optional-for-merge
  // shape) — the form always has an explicit checked/unchecked state.
  autoApproveUnrated: z.boolean(),
}).superRefine((data, ctx) => {
  if (data.enabled && data.severities.length === 0 && !data.thirdPartyApps) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['severities'],
      message: t('updateRingForm.validation.selectSeverityOrThirdParty'),
    });
  }
});
```

- [ ] **Step 4: Add the warning note + toggle in the default-rule panel**

In the same file, in the default-rule block (the `data-testid="ring-auto-approve-section"` panel), replace the existing severity-note paragraph:

```tsx
<p
  className="mt-1.5 max-w-md text-xs text-muted-foreground"
  data-testid="ring-third-party-severity-note"
>
  {t('updateRingForm.approvalPolicy.severityNote')}
</p>
```

with the same note plus a new one immediately after it, plus the toggle:

```tsx
<p
  className="mt-1.5 max-w-md text-xs text-muted-foreground"
  data-testid="ring-third-party-severity-note"
>
  {t('updateRingForm.approvalPolicy.severityNote')}
</p>
<p
  className="mt-1.5 max-w-md text-xs text-muted-foreground"
  data-testid="ring-unrated-severity-note"
>
  {t('updateRingForm.approvalPolicy.unratedSeverityNote')}
</p>
<div className="mt-2 flex items-center gap-2">
  <ApproveToggle
    checked={!!autoApprove?.autoApproveUnrated}
    field={register('autoApprove.autoApproveUnrated')}
    testId="ring-auto-approve-unrated-toggle"
    t={t}
  />
  <span className="text-xs text-muted-foreground">{t('updateRingForm.approvalPolicy.autoApproveUnratedLabel')}</span>
</div>
```

Note: `ApproveToggle`'s built-in label already renders "Auto-approve"/"Manual" via `t('updateRingForm.approveToggle.autoApprove'/'manual')` — reusing it here for a *checkbox that isn't about ring auto-approve itself* would read confusingly ("Manual"/"Auto-approve" next to a toggle that's actually "include unrated patches"), so the adjacent `<span>` supplies the specific label instead of relying on `ApproveToggle`'s built-in text; leave `ApproveToggle`'s own label rendering as-is (used correctly elsewhere) and do not change that component.

- [ ] **Step 5: Add the same toggle to each category override row**

In the category-override rendering block (`fields.map(...)`), inside the `rule?.autoApprove ? (...)` branch, after the existing `SeverityChips`/`HoldField` row:

```tsx
<div className="mt-3 flex items-center gap-2">
  <ApproveToggle
    checked={!!rule?.autoApproveUnrated}
    field={register(`categoryRules.${index}.autoApproveUnrated`)}
    testId={`ring-category-${index}-auto-approve-unrated-toggle`}
    t={t}
  />
  <span className="text-xs text-muted-foreground">{t('updateRingForm.approvalPolicy.autoApproveUnratedLabel')}</span>
</div>
```

And extend `categoryRuleSchema` inside `makeRingSchema`:

```ts
const categoryRuleSchema = z.object({
  category: z.string().min(1, t('updateRingForm.validation.selectCategory')),
  autoApprove: z.boolean(),
  autoApproveSeverities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])).optional(),
  autoApproveUnrated: z.boolean().optional(),
  deferralDaysOverride: z.coerce.number().int().min(0).max(365).nullable().optional(),
});
```

- [ ] **Step 6: Add the locale strings**

In `apps/web/src/locales/en/patches.json`, inside `"approvalPolicy"` (currently lines 426-435):

```json
"approvalPolicy": {
  "title": "Approval policy",
  "description": "What auto-approves in this ring, and how long to hold a patch after its vendor release. The default applies to every category; add an override to treat one differently.",
  "allCategories": "All categories",
  "default": "Default",
  "severityNote": "Severities apply to OS updates only. Third-party app updates are controlled by the toggle below — they are not severity-controlled.",
  "unratedSeverityNote": "Patches with no severity rating are excluded from this severity selection and will not auto-approve, even with every severity checked, unless you turn on the toggle below.",
  "autoApproveUnratedLabel": "Also auto-approve unrated patches",
  "manualDefault": "Every patch in this ring needs manual approval.",
  "manualCategory": "Patches in this category need manual approval.",
  "noOverrides": "All categories follow the default. Add an override to treat one differently."
},
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/patches/UpdateRingForm.test.tsx`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/patches/UpdateRingForm.tsx apps/web/src/locales/en/patches.json apps/web/src/components/patches/UpdateRingForm.test.tsx
git commit -m "feat(patches): add unrated-patch warning note and opt-in toggle to ring form"
```

### Wave 3 verification (before opening the PR)

- [ ] `cd apps/web && npx vitest run src/components/patches/`
- [ ] `pnpm --filter @breeze/web exec tsc --noEmit`
- [ ] `pnpm lint` from repo root.
- [ ] Confirm the PR base branch is Wave 2's branch, not `main`; dispatch `gh workflow run CI --ref <this-branch>` before merging per the CI-traps section.

---

## Wave 4 — API + Web: surface a pending-unrated count

**Independently shippable:** yes, fully independent of Waves 2/3 (reads `patches.severity`/`'unknown'`+`NULL`, doesn't touch the evaluator or ring config at all). Can be branched directly off `main` and merged in any order relative to the other waves.

**Files:**
- Modify: `apps/api/src/routes/patches/compliance.ts`
- Modify: `apps/web/src/components/dashboard/types.ts`
- Modify: `apps/web/src/components/dashboard/PatchComplianceCard.tsx`
- Modify: `apps/web/src/locales/en/common.json`
- Test: `apps/api/src/routes/patches/compliance.test.ts`
- Test: `apps/web/src/components/dashboard/PatchComplianceCard.test.tsx`

**Interfaces:**
- Produces: `GET /patches/compliance` response gains `unratedSummary: { total: number; patched: number; pending: number }`, same shape as the existing `criticalSummary`/`importantSummary`.
- Consumes (web): `PatchCompliance.unratedSummary` (new field on the existing interface).

### Task 4.1: Add `unratedSummary` to the compliance API response

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/patches/compliance.test.ts`, following this file's existing pattern for seeding `devicePatches`/`patches` rows and asserting on the JSON response body (look at the existing `criticalSummary` assertion in this file for the exact request-building helper to reuse):

```ts
it('includes unratedSummary counting both NULL and "unknown" severity as unrated', async () => {
  // Seed: one outstanding NULL-severity patch, one outstanding 'unknown'-severity
  // patch, one installed NULL-severity patch — mirror this file's existing
  // seeding helper for devicePatches/patches rows (see the criticalSummary test
  // in this file for the exact fixture shape and org/device ids to reuse).
  const response = await fetchCompliance(); // reuse this file's existing request helper
  const body = await response.json();

  expect(body.data.unratedSummary).toEqual({ total: 3, patched: 1, pending: 2 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/patches/compliance.test.ts`
Expected: FAIL — `unratedSummary` is not in the response body yet.

- [ ] **Step 3: Add `unratedSummary` to the response**

In `apps/api/src/routes/patches/compliance.ts`, the `severityMap` computed at lines ~343-350 already buckets `NULL` and `'unknown'` together under the `'unknown'` key (`const key = row.severity ?? 'unknown';` — note DB rows with `severity: 'unknown'` and `severity: NULL` land in the same `groupBy` output only if Postgres treats them as the same group, which it does NOT — `groupBy(patches.severity)` produces a SEPARATE row for `NULL` vs the string `'unknown'`; the `row.severity ?? 'unknown'` key coalesces them into the same **map key**, summing their counts together — confirm this by re-reading the loop, no code change needed there, only the response object below needs the new field):

```ts
return c.json({
  data: {
    summary,
    compliancePercent,
    totalDevices: deviceIds.length,
    compliantDevices: compliantDeviceCount,
    criticalSummary: severityMap['critical'] ?? { total: 0, patched: 0, pending: 0 },
    importantSummary: severityMap['important'] ?? { total: 0, patched: 0, pending: 0 },
    unratedSummary: severityMap['unknown'] ?? { total: 0, patched: 0, pending: 0 },
    devicesNeedingPatches,
    filters: {
      source: query.source ?? null,
      severity: query.severity ?? null,
      ringId: query.ringId ?? null
    }
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/patches/compliance.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/patches/compliance.ts apps/api/src/routes/patches/compliance.test.ts
git commit -m "feat(patches): surface unratedSummary (NULL + unknown severity) on compliance endpoint"
```

### Task 4.2: Show the unrated-pending count on the dashboard patch compliance card

**Interfaces:**
- Consumes: `PatchCompliance.unratedSummary` (Task 4.1).

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/dashboard/PatchComplianceCard.test.tsx` (follow the existing pattern for building a `DashboardQueryState<PatchCompliance>` fixture in this file — the `criticalSummary.pending > 0` callout test right above is the template):

```tsx
it('shows an unrated-pending note when unratedSummary.pending > 0', () => {
  render(
    <PatchComplianceCard
      patch={{
        isLoading: false,
        unavailable: false,
        error: null,
        data: {
          summary: { total: 10, pending: 5, installed: 5, failed: 0, missing: 0, skipped: 0 },
          compliancePercent: 50,
          totalDevices: 3,
          compliantDevices: 1,
          criticalSummary: { total: 0, patched: 0, pending: 0 },
          importantSummary: { total: 0, patched: 0, pending: 0 },
          unratedSummary: { total: 4, patched: 0, pending: 4 },
          devicesNeedingPatches: [],
        },
      }}
    />
  );

  expect(screen.getByText(/4.*unrated.*pending/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/dashboard/PatchComplianceCard.test.tsx`
Expected: FAIL — `unratedSummary` isn't on the `PatchCompliance` type and no callout renders it.

- [ ] **Step 3: Add `unratedSummary` to the `PatchCompliance` type**

In `apps/web/src/components/dashboard/types.ts`:

```ts
/** GET /patches/compliance — apps/api/src/routes/patches/compliance.ts */
export interface PatchCompliance {
  summary: { total: number; pending: number; installed: number; failed: number; missing: number; skipped: number };
  compliancePercent: number;
  totalDevices: number;
  compliantDevices: number;
  criticalSummary: { total: number; patched: number; pending: number };
  importantSummary: { total: number; patched: number; pending: number };
  unratedSummary: { total: number; patched: number; pending: number };
}
```

(Adding `importantSummary` here too is a pre-existing gap the API already returns but this type never declared — include it since the type would otherwise be inconsistent with itself; do not wire a UI consumer for `importantSummary` beyond the type fix, that's out of this plan's scope.)

- [ ] **Step 4: Render the callout in `PatchComplianceCard.tsx`**

Immediately after the existing `criticalSummary.pending > 0` block:

```tsx
{data.criticalSummary.pending > 0 && (
  <p className="mt-3 border-t border-border/60 pt-3 text-xs font-medium text-destructive">
    {t('dashboard.patch.criticalPending', { count: data.criticalSummary.pending })}
  </p>
)}
{data.unratedSummary.pending > 0 && (
  <p className={cn(
    'text-xs font-medium text-muted-foreground',
    data.criticalSummary.pending > 0 ? 'mt-1' : 'mt-3 border-t border-border/60 pt-3'
  )}>
    {t('dashboard.patch.unratedPending', { count: data.unratedSummary.pending })}
  </p>
)}
```

(This file doesn't currently import `cn` — add `import { cn } from '@/lib/utils';` at the top, matching the import style already used in `PatchList.tsx` and `UpdateRingForm.tsx`.)

- [ ] **Step 5: Add the locale strings**

In `apps/web/src/locales/en/common.json`, inside `"patch"` (currently lines 351-360):

```json
"patch": {
  "title": "Patch compliance",
  "installed": "Installed",
  "failed": "Failed",
  "devicesCompliant": "{{compliant}} of {{total}} devices fully patched",
  "criticalPending": "{{count}} critical patches pending",
  "criticalPending_one": "{{count}} critical patch pending",
  "criticalPending_other": "{{count}} critical patches pending",
  "unratedPending": "{{count}} unrated patches pending (won't auto-approve)",
  "unratedPending_one": "{{count}} unrated patch pending (won't auto-approve)",
  "unratedPending_other": "{{count}} unrated patches pending (won't auto-approve)",
  "empty": "No patch data yet"
},
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/dashboard/PatchComplianceCard.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/dashboard/types.ts apps/web/src/components/dashboard/PatchComplianceCard.tsx apps/web/src/locales/en/common.json apps/web/src/components/dashboard/PatchComplianceCard.test.tsx
git commit -m "feat(dashboard): show pending-unrated patch count on the compliance card"
```

### Wave 4 verification (before opening the PR)

- [ ] `cd apps/api && npx vitest run src/routes/patches/compliance.test.ts`
- [ ] `cd apps/web && npx vitest run src/components/dashboard/`
- [ ] `pnpm lint` from repo root.

---

## Out of scope (flagged for a follow-up decision, not this plan)

- **The ring-less "policy-level" auto-approve path** (`ApprovalEvaluationConfig.policyAutoApprove` / `PolicyAutoApproveConfig`, referenced in the evaluator's header comment and threaded from `patchJobExecutor.ts`/`patchJobSnapshot.ts`) appears to be dead code inside `evaluatePatchApproval` — the `if (!ringConfig.ringId) return null;` early exit (line 533-536) unconditionally kills it before any auto-approve logic runs, so a ring-less config policy's `autoApprove`/`autoApproveSeverities` in `apps/api/src/routes/configurationPolicies/patchJobs.ts` may never actually take effect today. This is a pre-existing, separate-from-#3758 finding from the exploration for this plan (confirmed only by static read, not by running the code) — it needs its own investigation before deciding whether `PatchTab.tsx`'s equivalent severity chips need the same unrated-warning treatment as `UpdateRingForm.tsx`. Do not fold a fix for this into Wave 2/3.
- **Manual per-device installs and CVE-remediation jobs bypass the evaluator entirely** (per the evaluator's own header comment, line 13: "Manual per-device installs do NOT pass through this evaluator") — unrelated to the "no indication in the UI" defect this issue reports, since those paths never claim to auto-approve based on severity in the first place.
- **A per-device "why is this patch held" explainer** (e.g. on `apps/api/src/routes/devices/patches.ts`'s per-device pending list) was not included as a wave — Wave 1's badge-plus-note in `PatchList.tsx` and Wave 4's aggregate count are judged sufficient to close the "no indication" gap the issue describes; a per-row explainer for every hold reason (deferral, category rule, unrated, etc.) is a larger feature and should be scoped separately if wanted.

## Self-review notes

- **Spec coverage:** issue suggestion (1) "label the patch" → Wave 1. Suggestion (2) "warn on the ring" → Wave 3 Task 3.2. Suggestion (3) "consider an explicit opt-in" → Wave 2 (backend) + Wave 3 (UI toggle). "Surfacing a count" → Wave 4. The two "related" gaps (ring-less/manual-install bypass) are explicitly flagged out of scope above rather than silently dropped.
- **Placeholder scan:** no TBD/TODO/"add error handling" left in any step; every code block is complete, copy-pasteable, and references exact existing line ranges as of this plan's writing (2026-09-02, repo HEAD `0632f6edc`) — an implementer should diff against current HEAD before pasting, since line numbers drift.
- **Type consistency:** `autoApproveUnrated` is spelled identically across all four waves (shared schema, API route schema, evaluator's `RingAutoApproveConfig`/`CategoryRule`, web form schema, web normalize helpers) — verified no `autoApproveUnrated` vs `autoApproveIncludeUnrated` drift. `PatchSeverity` (Wave 1, `PatchList.tsx`) and the ring form's separate `Severity` type (`UpdateRingForm.tsx`, unchanged — ring severities never include `'unrated'`, since the opt-in is a separate boolean, not a fifth severity chip) are deliberately different types for different concerns; do not merge them.
