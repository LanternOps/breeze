# Ring-Owned Patch Approval Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish #1317. Move per-app block/pin rules from the configuration-policy patch link onto Update Rings (`patch_policies.app_rules`), migrating existing rules so that no policy's effective rules change. Then retire the dead policy-level auto-approve fields from every surface.

**Architecture:** Four waves, using expand → backfill + cutover → contract. W01 adds the column and a dual read: ring rules and policy rules are both enforced, and the stricter verdict wins. W02 backfills ring rules from policy links in one idempotent migration and cuts reads over to the ring. In the same wave, the ring routes, AI tools and job snapshot start writing ring rules; the snapshot writes them to both the new and the legacy key. W03 moves the UI. W04 drops the policy columns and the inline keys one release later.

**Tech Stack:** Hono routes, Drizzle (queries only) + hand-written SQL migrations, Zod (`packages/shared/src/validators`), React + react-hook-form, Vitest, real-Postgres integration tests (`vitest.integration.config.ts`).

**Spec:** `docs/superpowers/specs/vuln-patch/2026-10-06-ring-owned-approval-rules-design.md` — read it first. It records what is already done on main and why policy auto-approve is *not* migrated into rings.

## Wave table

| Wave | PR scope | Depends on | Migration | Blast radius | Impl / review tier |
|---|---|---|---|---|---|
| **W01** Expand | shared `ringAppRulesSchema`; `patch_policies.app_rules` column; resolver + eligibility dual-read; snapshot/executor `ringAppRules`; ring GET returns `appRules` (read-only) | — | DDL: add column + CHECK | Medium (approval evaluator; no behaviour change because the column is empty) | Sonnet / Sonnet |
| **W02** Backfill + cutover | backfill migration; reads ring-only; snapshot dual-writes `apps` + `ringAppRules`; ring route + `manage_update_rings` write `appRules`; policy writes reject edited `apps`/`autoApprove`; invalid-ring policies fail closed; `setup_auto_approval` cleanup; AI shape/prompt sweep | W01 merged | Data: create/clone rings, relink links, copy ring approvals | **High** (data migration, live approval rules, AI write tool) | Opus / Opus (+ Codex `medium` second opinion on the SQL) |
| **W03** Web | ring form "Application rules"; ring list badge; PatchTab strip; device effective-config tab | W02 merged; **must ship in the same release as W02** | none | Low–medium (UI) | Sonnet / Sonnet |
| **W04** Contract | drop `auto_approve`, `auto_approve_severities`; re-create the partner export projection; strip inline keys; remove `policyAutoApprove`; stop writing snapshot `apps` | W02 + W03 **released** (one release later) | DDL drop + function replace + data strip | Medium (public partner-API export shape, exact-membership parity test) | Sonnet / Opus |

**Migration names:** take the newest committed migration at implementation time (`ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -1`) and name the file one minute past it. On 2026-10-06 that file was `2026-12-13-110200-…`. Example names: W01 `2026-12-14-100000-patch-policies-app-rules.sql`, W02 `2026-12-14-100100-ring-app-rules-backfill.sql`, W04 `2026-12-14-100200-drop-policy-patch-auto-approve.sql`. The pre-push hook re-checks against `origin/main`. Rename if it fails.

## Global Constraints

- **No behaviour change for any existing policy at any deploy step.** Every policy keeps exactly the app rules it enforces today. Nothing that is manual-approval today starts auto-approving.
- **Policy-level auto-approve is never converted into an enabled ring.** It has not been consulted since the evaluator stopped reading it (`patchApprovalEvaluator.ts:88-95`, `:393-396`).
- App-rule element type stays `policyAppRuleSchema` (`packages/shared/src/validators/index.ts:602-616`). Max 200 rules. Rules are unique by `appRuleKey` (`patchApprovalEvaluator.ts:293-296`: `third_party`/`custom` → one bucket, packageId lowercased).
- Verdict precedence when two rule sets apply: `blocked` > `held` > `allowed`.
- Malformed job-snapshot rules keep the executor's fail-closed coercion (identifiable → `block`; unidentifiable → dropped loudly), `patchJobExecutor.ts:1162-1185`.
- Migrations: idempotent, no inner `BEGIN/COMMIT`, `set_config('breeze.scope','system',true)` before the first write, `GET DIAGNOSTICS … RAISE WARNING` on every write, never edit a shipped migration (CLAUDE.md "Schema Migration Workflow").
- `patch_policies` is partner-axis (shape 3), and no cascade, merge or export registration applies to it (spec "Storage"). Do **not** add it to `CORE_ORG_CASCADE_DELETE_ORDER` / `orgMergeRegistry` / `CORE_TENANT_EXPORT_POLICY`.
- Web mutations go through `runAction`; the ring form already uses the documented inline-error pattern.
- PR bodies and commits use neutral wording. Every PR touching `PatchTab.tsx` / `UpdateRingForm.tsx` states the settings accounting from the spec (home, level, resolver, count before → after).
- Tests run in the foreground: `cd apps/api && npx vitest run <files>`; never `pnpm … test -- --run`.

## Review Focus

1. **A ring shared by many policies, only some of which carry app rules.** Expected: the policies without rules keep enforcing no rules, and the others keep exactly theirs, via clones (W02 Task 2.1, fixture C).
2. **Rolling deploy: a job created by a W02 instance executes on a pre-W01 instance.** Expected: ring rules are still enforced because the snapshot dual-writes `apps` (W02 Task 2.3 test "legacy apps key mirrors ring rules").
3. **Stale PatchTab saved after W02 deploys, re-sending the stored `apps` unchanged.** Expected: the save succeeds. A *changed* list gets a 400 that names the Update Ring (W02 Task 2.4).
4. **SQL normalisation drifts from the TS salvage.** Expected: for every fixture, the migration's per-link rule list equals `normalizeStoredInlineSettingsWithSalvage(...).apps` (W02 Task 2.1, parity test).
5. **Second run of the backfill (re-applied file).** Expected: no new rings, no relinks, no copied approvals, and all row-count warnings report 0 (W02 Task 2.1, idempotency test).

---

## Pre-W02 survey (orchestrator, read-only, once per region)

Run before dispatching W02 to size cases A/B/C/D. Paste the result into the W02 PR body. Run it as the `breeze` owner role with system scope, read-only:

```sql
BEGIN READ ONLY;
SELECT set_config('breeze.scope','system',true);
WITH l AS (
  SELECT l.id, l.feature_policy_id AS ring_ref,
         COALESCE(cp.partner_id, o.partner_id) AS partner_id,
         jsonb_typeof(l.inline_settings->'apps') = 'array'
           AND jsonb_array_length(l.inline_settings->'apps') > 0 AS has_apps,
         COALESCE((s.auto_approve), (l.inline_settings->>'autoApprove')::boolean, false) AS policy_auto
  FROM config_policy_feature_links l
  JOIN configuration_policies cp ON cp.id = l.config_policy_id
  LEFT JOIN organizations o ON o.id = cp.org_id
  LEFT JOIN config_policy_patch_settings s ON s.feature_link_id = l.id
  WHERE l.feature_type = 'patch'
)
SELECT
  count(*) FILTER (WHERE has_apps AND ring_ref IS NULL)                         AS case_a_ringless_with_apps,
  count(*) FILTER (WHERE has_apps AND ring_ref IS NOT NULL)                     AS ring_linked_with_apps,
  count(DISTINCT ring_ref) FILTER (WHERE has_apps AND ring_ref IS NOT NULL)     AS rings_touched,
  count(*) FILTER (WHERE policy_auto AND ring_ref IS NULL)                      AS ringless_policy_auto_on,
  count(*) FILTER (WHERE ring_ref IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM patch_policies p
       WHERE p.id = l.ring_ref AND p.kind = 'ring' AND p.partner_id = l.partner_id))   AS case_d_invalid_ref_all,
  count(*) FILTER (WHERE has_apps AND ring_ref IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM patch_policies p
       WHERE p.id = l.ring_ref AND p.kind = 'ring' AND p.partner_id = l.partner_id))   AS case_d_invalid_ref_with_apps
FROM l;
ROLLBACK;
```

---

## W01 — Expand: `app_rules` column + dual read

Branch: `feature/1317-ring-approval-rules/wave-<W01 sub-issue#>` off fresh `origin/main`.

### Task 1.1: Shared `ringAppRulesSchema`

**Files:**
- Modify: `packages/shared/src/validators/index.ts` (after `PolicyAppRule` at `:618`)
- Test: `packages/shared/src/validators/index_inline_settings.test.ts`

**Interfaces:**
- Produces: `ringAppRulesSchema: z.ZodType<PolicyAppRule[]>`, `type RingAppRules = PolicyAppRule[]`, `canonicalAppRuleKey(source: string, packageId: string): string` (shared copy of the evaluator's key, so the validator and evaluator agree).

- [ ] **Step 1: Write the failing tests**

```ts
import { ringAppRulesSchema, canonicalAppRuleKey } from './index';

describe('ringAppRulesSchema', () => {
  it('accepts block and pin rules', () => {
    const r = ringAppRulesSchema.safeParse([
      { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
      { source: 'custom', packageId: 'acme.tool', action: 'pin', pinnedVersion: '1.2.3' },
    ]);
    expect(r.success).toBe(true);
  });
  it('rejects a pin without a version', () => {
    expect(ringAppRulesSchema.safeParse([{ source: 'third_party', packageId: 'x', action: 'pin' }]).success).toBe(false);
  });
  it('rejects duplicates by canonical key (custom/third_party bucket, case-insensitive id)', () => {
    const r = ringAppRulesSchema.safeParse([
      { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
      { source: 'custom', packageId: 'mozilla.firefox', action: 'block' },
    ]);
    expect(r.success).toBe(false);
  });
  it('caps the list at 200', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ source: 'third_party', packageId: `p${i}`, action: 'block' }));
    expect(ringAppRulesSchema.safeParse(many).success).toBe(false);
  });
  it('canonicalAppRuleKey collapses custom into third_party and lowercases', () => {
    expect(canonicalAppRuleKey('custom', 'A.B')).toBe('third_party|a.b');
  });
});
```

- [ ] **Step 2: Run and confirm the tests fail**

Run: `cd packages/shared && npx vitest run src/validators/index_inline_settings.test.ts`
Expected: FAIL. `ringAppRulesSchema` is not exported.

- [ ] **Step 3: Implement**

```ts
/** Canonical app-rule identity. MUST match apps/api patchApprovalEvaluator.appRuleKey. */
export function canonicalAppRuleKey(source: string, packageId: string): string {
  const bucket = source === 'third_party' || source === 'custom' ? 'third_party' : source;
  return `${bucket}|${packageId.toLowerCase()}`;
}

/** Update Ring per-app block/pin rules (#1317) — patch_policies.app_rules. */
export const ringAppRulesSchema = z.array(policyAppRuleSchema).max(200).superRefine((rules, ctx) => {
  const seen = new Set<string>();
  rules.forEach((rule, i) => {
    const key = canonicalAppRuleKey(rule.source, rule.packageId);
    if (seen.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'packageId'], message: 'Duplicate application rule.' });
    }
    seen.add(key);
  });
});
export type RingAppRules = z.infer<typeof ringAppRulesSchema>;
```

Check `isThirdPartyPatchSource` in `patchApprovalEvaluator.ts:228-230`. If its bucket includes more than `third_party`/`custom`, mirror that set here exactly. Then make `appRuleKey` in the evaluator delegate to `canonicalAppRuleKey`, so there is only one implementation. Run the evaluator tests afterwards (`npx vitest run src/services/patchApprovalEvaluator.test.ts`).

- [ ] **Step 4: Run and confirm the tests pass**, then rebuild shared (`pnpm --filter @breeze/shared build`) so the API sees the export.

- [ ] **Step 5: Commit** `feat(shared): ring app-rules schema (#1317)`

### Task 1.2: Column + Drizzle schema

**Files:**
- Create: `apps/api/migrations/<W01 name>.sql`
- Modify: `apps/api/src/db/schema/patches.ts:170` (after `categoryRules`)
- Test: `apps/api/src/db/autoMigrate.test.ts` (runs as-is; ordering)

- [ ] **Step 1: Write the migration**

```sql
-- #1317 W01: Update Rings own per-app block/pin rules. DDL only — no row
-- writes, so no breeze.scope elevation. patch_policies is partner-axis
-- (shape 3); no cascade/merge/export registration applies.
ALTER TABLE patch_policies
  ADD COLUMN IF NOT EXISTS app_rules jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patch_policies_app_rules_array_chk'
  ) THEN
    ALTER TABLE patch_policies
      ADD CONSTRAINT patch_policies_app_rules_array_chk CHECK (jsonb_typeof(app_rules) = 'array');
  END IF;
END $$;
```

- [ ] **Step 2: Drizzle**: add `appRules: jsonb('app_rules').notNull().default([]),` after `categoryRules`.

- [ ] **Step 3: Verify**: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`, then `pnpm test-stack up` and `pnpm db:check-drift` against it. Expected: PASS, no drift.

- [ ] **Step 4: Commit** `feat(api): patch_policies.app_rules column (#1317)`

### Task 1.3: Resolver carries `appRules`; eligibility dual-reads

**Files:**
- Modify: `apps/api/src/services/configPolicyPatching.ts:40-50` (`PatchRingResolution`), `:188-291` (every return of `resolvePatchPolicyReference`)
- Modify: `apps/api/src/services/patchApprovalEvaluator.ts:64-102` (`ApprovalEvaluationConfig`), plus a new `evaluateAppRuleSets`
- Modify: `apps/api/src/services/patchEligibility.ts:236-262` and `:414-475`
- Test: `apps/api/src/services/configPolicyPatching.test.ts`, `patchApprovalEvaluator.test.ts`, `patchEligibility.test.ts`

**Interfaces:**
- Produces: `PatchRingResolution.appRules: PolicyAppRule[]` (`[]` for every non-`valid_ring` classification). `ApprovalEvaluationConfig.ringAppRules?: PolicyAppRule[]`.
- Produces: `evaluateAppRuleSets(patch, maps: AppRuleMap[]): AppRuleVerdict` returns the worst verdict across the maps.
- Produces: `coerceRingAppRules(raw: unknown, ringId: string): PolicyAppRule[]`. It parses each element with `policyAppRuleSchema` and coerces a malformed but identifiable element (`source` in the bucket, non-empty `packageId`) to `block` with a `console.warn`. Elements that cannot be identified are dropped with a warn and `captureException`. Display-only fields are stripped. These are the same semantics as the executor's.

- [ ] **Step 1: Failing tests**

`patchApprovalEvaluator.test.ts`:
```ts
describe('evaluateAppRuleSets', () => {
  const p = { source: 'third_party', packageId: 'Mozilla.Firefox', version: '130.0' };
  it('blocked in either set wins', () => {
    const ring = buildAppRuleMap([{ source: 'third_party', packageId: 'mozilla.firefox', action: 'block' }]);
    const policy = buildAppRuleMap([]);
    expect(evaluateAppRuleSets(p, [ring, policy])).toBe('blocked');
    expect(evaluateAppRuleSets(p, [policy, ring])).toBe('blocked');
  });
  it('blocked beats held', () => {
    const pin = buildAppRuleMap([{ source: 'third_party', packageId: 'mozilla.firefox', action: 'pin', pinnedVersion: '120' }]);
    const block = buildAppRuleMap([{ source: 'custom', packageId: 'MOZILLA.FIREFOX', action: 'block' }]);
    expect(evaluateAppRuleSets(p, [pin, block])).toBe('blocked');
  });
  it('allowed only when every set allows', () => {
    expect(evaluateAppRuleSets(p, [buildAppRuleMap([]), buildAppRuleMap([])])).toBe('allowed');
  });
});
```

`patchEligibility.test.ts`: in the existing mocked-ring setup, give the ring `appRules: [{ source:'third_party', packageId:'Mozilla.Firefox', action:'block' }]` and the policy `apps: []`. Assert that the Firefox candidate is denied `blocked_by_app_rule` even when it is manually approved. Add the mirror case, where the rule sits on the policy and not on the ring, and assert that it is still denied. That mirror case is the dual read.

`configPolicyPatching.test.ts`: assert that a `valid_ring` resolution returns `appRules` from the row, and that the `null` / `legacy_patch_policy` / `config_policy_uuid` / `missing_target` classifications return `appRules: []`. Add one test where the row's `appRules` contains `{ source:'third_party', packageId:'x', action:'pin' }` (no version). It must come back as `block`, with a warning.

- [ ] **Step 2: Run the tests and confirm they fail**: `cd apps/api && npx vitest run src/services/patchApprovalEvaluator.test.ts src/services/patchEligibility.test.ts src/services/configPolicyPatching.test.ts`

- [ ] **Step 3: Implement**

In the evaluator, next to `evaluateAppRule`:
```ts
const VERDICT_RANK: Record<AppRuleVerdict, number> = { allowed: 0, held: 1, blocked: 2 };
/** Worst verdict across rule sets (W01 dual-read: ring + policy). */
export function evaluateAppRuleSets(
  patch: { source: string; packageId: string | null; version: string | null },
  maps: AppRuleMap[]
): AppRuleVerdict {
  let worst: AppRuleVerdict = 'allowed';
  for (const m of maps) {
    const v = evaluateAppRule(patch, m);
    if (VERDICT_RANK[v] > VERDICT_RANK[worst]) worst = v;
  }
  return worst;
}
```

In `patchEligibility.ts:240`, replace the single map with:
```ts
const appRuleMaps = [buildAppRuleMap(ringConfig.ringAppRules), buildAppRuleMap(ringConfig.apps)]
  .filter((m) => m.size > 0);
const finalCandidates = appRuleMaps.length > 0
  ? categoryFiltered.filter((p) => {
      /* unchanged missing-packageId allow-with-warn branch */
      const verdict = evaluateAppRuleSets(p, appRuleMaps);
      /* unchanged deny/log branch */
    })
  : categoryFiltered;
```

In `resolveDevicePatchEvaluation` (`:426-445`), set `ringAppRules: ringId ? ring.appRules : []`. Carry `ringAppRules: []` into the vanished-ring fail-closed return at `:469`. That return keeps `apps`, so the policy rules still apply in W01.

In `resolvePatchPolicyReference`, add `appRules: patchPolicies.appRules` to the select. Return `appRules: coerceRingAppRules(patchPolicy.appRules, patchPolicy.id)` for `valid_ring`, and `appRules: []` in every other branch.

- [ ] **Step 4: Run the tests and confirm they pass.** Then run `npx tsc --noEmit -p apps/api` with `NODE_OPTIONS=--max-old-space-size=12288`, and check the exit code directly. Do not pipe it to `tail`.

- [ ] **Step 5: Commit** `feat(api): enforce ring app rules alongside policy app rules (#1317)`

### Task 1.4: Job snapshot + executor carry `ringAppRules`

**Files:**
- Modify: `apps/api/src/services/patchJobSnapshot.ts` (`PatchesSnapshot` + builder)
- Modify: `apps/api/src/jobs/patchJobExecutor.ts:1105-1185` (extract `parseJobAppRules(raw, jobId, key)` from the inline `apps` loop and call it for both keys)
- Test: `patchJobSnapshot.test.ts`, `patchJobExecutor.test.ts`

**Interfaces:**
- Produces: `PatchesSnapshot.ringAppRules: PolicyAppRule[]`, and the executor threads `ringAppRules` into `ApprovalEvaluationConfig`.

- [ ] **Step 1: Failing tests**. Snapshot: a ring with `appRules` gives `snapshot.ringAppRules` equal to it, and `snapshot.apps` is still the policy list (unchanged in W01). Executor: (a) a job whose `patches.ringAppRules` has a block for the candidate → the device result excludes it; (b) `ringAppRules` absent → undefined, no warning; (c) `ringAppRules: "nope"` → warning + `captureException`, treated as no ring rules. The policy `apps` still applies here, which is the same posture as today's malformed `apps`; (d) a malformed but identifiable entry → coerced to `block`.
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.** `buildPatchesSnapshot` adds `ringAppRules: policyLocal.ring.appRules`. In the executor, move the existing `apps` loop body unchanged into `parseJobAppRules`, and call it as `parseJobAppRules(patchesConfig.apps, patchJobId, 'apps')` and `parseJobAppRules(patchesConfig.ringAppRules, patchJobId, 'ringAppRules')`.
- [ ] **Step 4: Run the tests and confirm they pass**, plus `src/routes/configurationPolicies/patchJobs.test.ts src/services/patchJobService.test.ts`.
- [ ] **Step 5: Commit** `feat(api): snapshot ring app rules on patch jobs (#1317)`

### Task 1.5: Ring GET returns `appRules` (read-only)

**Files:**
- Modify: `apps/api/src/routes/updateRings.ts` (explicit select at `:191-208` and the `:id` detail select)
- Modify: `apps/api/src/services/aiToolsPolicyPrereqs.ts` (`get`/`list` output)
- Test: `apps/api/src/routes/updateRings_list_create.test.ts`, `updateRings_detail_update_delete.test.ts`, `aiToolsPolicyPrereqs.test.ts`

- [ ] **Step 1: Failing tests**: the GET list and detail responses include `appRules` (default `[]`), and `manage_update_rings get` includes `appRules`. **No write accepts it yet.** The ring schemas are non-strict, so a create/update body carrying `appRules` is stripped; assert the stored row's `appRules` stays `[]` (this guarantees the W02 backfill only ever sees empty ring lists).
- [ ] **Steps 2–4**: run the tests and confirm they fail, add the column to the selects, then run the tests and confirm they pass.
- [ ] **Step 5: Commit**. Then open the W01 PR (`Part of #1317`, `Closes #<W01 sub-issue>`), run `/pr-review-toolkit:review-pr`, and also run `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` once as cheap insurance.

---

## W02 — Backfill + cutover (high blast radius)

Branch off `origin/main` after W01 merges. Run the pre-W02 survey first.

### Task 2.1: Backfill migration

**Files:**
- Create: `apps/api/migrations/<W02 name>.sql`
- Create: `apps/api/src/__tests__/integration/ringAppRulesBackfill.integration.test.ts`

**Interfaces:**
- Consumes: `patch_policies.app_rules` (W01).
- Produces: for every patch link with rules, the link resolves to a ring whose `app_rules` equal the link's normalised rules.

- [ ] **Step 1: Write the integration test first.** Seed through the system context and replay the migration by path. Use the pattern in `orgLifecycleFoundations.integration.test.ts`: `readFileSync` the file and `sql.unsafe` it. Fixtures, one partner P with orgs O1/O2:
  - **A**: org policy on O1, link with no ring, `apps=[block third_party Mozilla.Firefox]`. Expect: one new ring with `partner_id = P`, `kind = 'ring'`, `auto_approve = '{}'`, `app_rules = [that rule]`, and the link's `feature_policy_id` set to it.
  - **A′**: partner-wide policy (`org_id NULL`, `partner_id = P`) with no ring and with apps. Expect: a new ring under P.
  - **B**: ring R1 linked by two policies with the same set (in a different order and different case). Expect: `R1.app_rules` = the canonical set, and no clone.
  - **C**: ring R2 linked by P1 (no apps), P2 (`block X`) and P3 (`pin Y 1.0`). R2 has a ring-scoped `patch_approvals` row (approved). Expect: `R2.app_rules = []`; two clones, each with R2's columns copied (`auto_approve`, `category_rules`, `categories`, `exclude_categories`, `deferral_days`, `ring_order`, `enabled`); P2 and P3 relinked to their clones; the approval row copied to each clone (same `partner_id`, `patch_id`, `status`).
  - **D**: link pointing at a non-existent uuid with apps, and a link pointing at another partner's ring. Expect: both untouched (Task 2.2 makes invalid-ring policies fail closed — Open Decision 8).
  - **R already carries rules that differ from a linker's**: pre-set `R3.app_rules = [block Z]`, link a policy with `[block X]`. Expect: the migration **raises an exception** (aborts) rather than skipping — a skip would silently drop that policy's rules at cutover.
  - **Salvage parity** (`configPolicyPatching.ts:139-170` — **first valid entry wins** per canonical key, invalid entries dropped whole, cap 200 unique valid entries): a link whose `apps` holds `[block third_party Foo.App, pin custom foo.app 1.0]` (first-wins must keep the **block**), a pin without a version, `source:'winget'`, an entry with a 300-char `displayName` (whole entry dropped), an entry with numeric `packageId` (dropped), and a 205-entry list (only the first 200 unique valid survive). Expect: the SQL result equals `normalizeStoredInlineSettingsWithSalvage(inline, ctx).apps` imported from `services/configPolicyPatching.ts` (export it if it is not exported). Compare by canonical key, action, and pinnedVersion.
  - **Idempotency**: run the file a second time. Expect: ring count, link targets and approval count all unchanged.
  - **policy auto-approve is not converted**: a ring-less link with `auto_approve = true` and no apps → no ring created.
  - **Runs under FORCE RLS**: execute it as the migration role, not as a superuser that bypasses RLS. Use the same connection the other replay suites use.

- [ ] **Step 2: Run and confirm it fails**: `pnpm test-stack up && cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/ringAppRulesBackfill.integration.test.ts`. Expected: ENOENT (the file does not exist yet).

- [ ] **Step 3: Write the migration**

```sql
-- #1317 W02: move per-app block/pin rules from configuration-policy patch links
-- onto Update Rings (patch_policies.app_rules). Preserves every policy's
-- effective rules: ring-less links get their own ring (auto_approve '{}' =
-- approves nothing); a ring shared by links with different rule sets is cloned
-- per extra set, with its ring-scoped approvals copied. Policy-level
-- auto-approve is NOT converted (it has not been consulted by the evaluator
-- since 2026-08; converting would start auto-approving). The policy-side
-- inline `apps` key is left in place until the W04 contract migration.
-- Idempotent: only links whose normalised rules differ from their resolved
-- ring's app_rules are processed (step 0 filter), so a re-run after success
-- finds nothing. A ring that already carries DIFFERENT non-empty rules aborts
-- the migration (no writer exists before W02, so this means a partial or
-- out-of-order apply that must be looked at, not skipped).
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n bigint;
  g record;
  new_ring uuid;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  DROP TABLE IF EXISTS pg_temp.ring_app_rules_links;
  CREATE TEMP TABLE ring_app_rules_links ON COMMIT DROP AS
  WITH src AS (
    SELECT l.id AS link_id, cp.name AS policy_name,
           COALESCE(cp.partner_id, o.partner_id) AS partner_id,
           l.feature_policy_id AS ring_ref,
           l.inline_settings->'apps' AS raw
    FROM config_policy_feature_links l
    JOIN configuration_policies cp ON cp.id = l.config_policy_id
    LEFT JOIN organizations o ON o.id = cp.org_id
    WHERE l.feature_type = 'patch'
      AND jsonb_typeof(l.inline_settings->'apps') = 'array'
      AND jsonb_array_length(l.inline_settings->'apps') > 0
  ), entries AS (
    -- Mirror policyAppRuleSchema exactly (validators/index.ts:602-616): an entry
    -- failing ANY field check is dropped whole, as salvage does.
    SELECT s.link_id, e.ord,
           CASE WHEN e.v->>'source' IN ('third_party','custom') THEN 'third_party' END
             || '|' || lower(e.v->>'packageId') AS k,
           jsonb_strip_nulls(jsonb_build_object(
             'source', e.v->>'source',
             'packageId', e.v->>'packageId',
             'displayName', e.v->>'displayName',
             'action', e.v->>'action',
             'pinnedVersion', e.v->>'pinnedVersion'
           )) AS entry
    FROM src s
    CROSS JOIN LATERAL jsonb_array_elements(s.raw) WITH ORDINALITY AS e(v, ord)
    WHERE jsonb_typeof(e.v) = 'object'
      AND jsonb_typeof(e.v->'source') = 'string' AND e.v->>'source' IN ('third_party','custom')
      AND jsonb_typeof(e.v->'packageId') = 'string' AND length(e.v->>'packageId') BETWEEN 1 AND 256
      AND jsonb_typeof(e.v->'action') = 'string' AND e.v->>'action' IN ('block','pin')
      AND (e.v->'displayName' IS NULL
           OR (jsonb_typeof(e.v->'displayName') = 'string' AND length(e.v->>'displayName') <= 255))
      AND (e.v->'pinnedVersion' IS NULL
           OR (jsonb_typeof(e.v->'pinnedVersion') = 'string' AND length(e.v->>'pinnedVersion') BETWEEN 1 AND 64))
      AND (e.v->>'action' = 'block' OR e.v->'pinnedVersion' IS NOT NULL)
  ), dedup AS (
    -- FIRST valid entry wins per canonical key (salvage: seenAppKeys → continue).
    SELECT DISTINCT ON (link_id, k) link_id, k, ord, entry
    FROM entries ORDER BY link_id, k, ord ASC
  ), capped AS (
    -- Salvage keeps the first 200 unique valid entries in document order.
    SELECT * FROM (
      SELECT d.*, row_number() OVER (PARTITION BY link_id ORDER BY ord) AS rn FROM dedup d
    ) x WHERE rn <= 200
  ), norm AS (
    SELECT link_id,
           jsonb_agg(entry ORDER BY k) AS apps,
           jsonb_agg(jsonb_build_array(k, entry->>'action',
             CASE WHEN entry->>'action' = 'pin' THEN entry->>'pinnedVersion' END) ORDER BY k) AS apps_key
    FROM capped GROUP BY link_id
  )
  SELECT s.link_id, s.policy_name, s.partner_id, s.ring_ref, n.apps, n.apps_key,
         (p.id IS NOT NULL) AS ring_valid
  FROM src s
  JOIN norm n USING (link_id)
  LEFT JOIN patch_policies p
    ON p.id = s.ring_ref AND p.kind = 'ring' AND p.partner_id = s.partner_id;
  -- Steps that follow (each with GET DIAGNOSTICS + RAISE WARNING, even when 0):
  --  0. Report and skip rows with partner_id NULL, and rows with ring_ref NOT NULL AND NOT ring_valid
  --     (case D — handled at read time by Task 2.2, Open Decision 8). Then DELETE from the temp table
  --     every row whose ring_valid ring already has app_rules equal to the row's apps (compare the
  --     canonical apps_key computed the same way from p.app_rules) — this is the idempotency filter.
  --     If any remaining row's valid ring has app_rules <> '[]', RAISE EXCEPTION naming the ring id.
  --  1. Case A: FOR g IN ring-less rows LOOP INSERT INTO patch_policies
  --       (partner_id, kind, name, auto_approve, app_rules) VALUES
  --       (g.partner_id, 'ring', left(g.policy_name || ' — app rules', 255), '{}'::jsonb, g.apps)
  --       RETURNING id INTO new_ring; UPDATE config_policy_feature_links SET feature_policy_id = new_ring,
  --       updated_at = now() WHERE id = g.link_id; END LOOP.
  --  2. Rings: for each ring still referenced by a remaining row, build pg_temp.ring_groups over ALL
  --     patch links to that ring (links without apps carry apps_key '[]'). Per ring, keep_key = '[]' if any linker has no
  --     rules, else the key with the most linkers (tie → min(link_id::text)).
  --     UPDATE patch_policies SET app_rules = <apps for keep_key>, updated_at = now()
  --       WHERE keep_key <> '[]' AND app_rules = '[]'.
  --  3. For every (ring, apps_key) <> keep_key: INSERT a clone (SELECT every column of R except
  --     id/created_at/updated_at/name/app_rules; name = left(R.name || ' — ' || <first policy_name
  --     of the group>, 255); app_rules = group apps) RETURNING id; INSERT INTO patch_approvals
  --     (partner_id, patch_id, policy_id, ring_id, status, approved_by, approved_at, defer_until, notes)
  --     SELECT partner_id, patch_id, policy_id, <clone>, status, approved_by, approved_at, defer_until, notes
  --     FROM patch_approvals WHERE ring_id = R ON CONFLICT DO NOTHING; UPDATE the group's links to the clone.
  --  4. RAISE WARNING the count of ring-less patch links with policy auto-approve on
  --     (config_policy_patch_settings.auto_approve OR inline autoApprove) — informational for release notes.
END $$;
```

Write steps 0–4 out in full PL/pgSQL in the file. The comment block above is the specification, and the integration test pins it. Before step 3, list every column of `patch_policies` on main with `\d patch_policies`. The clone `INSERT … SELECT` must name each copied column explicitly (`targets`, `auto_approve`, `schedule`, `reboot_policy`, `rollback_on_failure`, `pre_install_script_id`, `post_install_script_id`, `notify_on_complete`, `ring_order`, `deferral_days`, `deadline_days`, `grace_period_hours`, `categories`, `exclude_categories`, `category_rules`, `enabled`, `kind`, `partner_id`, `description`, `created_by`). If W01 or a later PR added a column, copy it too. The default-ring partial unique index (`2026-06-27-c`) cannot collide, because clone and new-ring names never equal `default`.

- [ ] **Step 4: Run the integration test and confirm it passes**, then run `npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts` (unit). Ask Codex `medium` to read the migration and test only, and to look for a fixture where any policy's effective rule set changes. Resolve any finding before you commit.

- [ ] **Step 5: Commit** `feat(api): move policy app rules onto update rings (#1317)`

### Task 2.2: Reads cut over to the ring

**Files:**
- Modify: `apps/api/src/services/patchEligibility.ts` (drop `ringConfig.apps` from `appRuleMaps`; `resolveDevicePatchEvaluation` stops populating `apps` from settings)
- Modify: the policy-`apps` consumers — `patchEligibility.ts:441-444`, `routes/configurationPolicies/patchJobs.ts:464-468` (preview payload), `configPolicyPatching.ts:345` (keep loading for the W02 write guard only); re-run `grep -rn "settings.apps\|\.apps\b" apps/api/src/services apps/api/src/routes/configurationPolicies apps/api/src/jobs` and handle every hit
- Modify: `patchEligibility.ts` — **invalid ring reference fails closed** (Open Decision 8): when the loaded `ring.valid === false` (classification `legacy_patch_policy` / `config_policy_uuid` / `missing_target`, i.e. NOT the `null` no-ring case), deny every candidate with a new `PatchIneligibleReason` `'ring_reference_invalid'` instead of evaluating with `ringId: null`. The scheduler already refuses these policies (`patchSchedulerWorker.ts:767`); this makes install proposals and the device view agree, and means no app rule can be lost for them at cutover. Add the reason to `devicePatchApprovalView.ts` and the web label map (`DevicePatchStatusTab.tsx` near `:396`).
- Test: `patchEligibility.test.ts`, `devicePatchApprovalView.test.ts`, `patchJobService.test.ts`

- [ ] **Step 1: Failing tests**: (a) a policy whose inline `apps` blocks Firefox, linked to a ring with `appRules: []` → Firefox is **eligible** (cutover: policy rules no longer apply); keep the W01 test that a ring block is enforced. (b) a policy whose link points at a missing ring, with a manually approved patch → denied `ring_reference_invalid`. (c) a policy with **no** ring and a manual approval → still approved `manual` (no-ring path unchanged).
- [ ] **Steps 2–4**: run the tests and confirm they fail, implement, then run the tests and confirm they pass.
- [ ] **Step 5: Commit** `refactor(api): app rules resolve from the update ring only (#1317)`

### Task 2.3: Snapshot dual-write

**Files:** `apps/api/src/services/patchJobSnapshot.ts`, `patchJobSnapshot.test.ts`

- [ ] **Step 1: Failing test** "legacy apps key mirrors ring rules": the ring has a block, and the policy inline has a different block. Assert that `snapshot.apps` deep-equals `snapshot.ringAppRules` and equals the ring's rules, and that the policy rule is absent.
- [ ] **Step 3: Implement**: `apps: policyLocal.ring.appRules` (comment: written for executors that predate `ringAppRules`; W04 removes it). Remove `apps` from `PatchesSnapshotInput.settings`.
- [ ] **Steps 2/4/5**: run the tests and confirm they fail, then confirm they pass, then commit `feat(api): job snapshots carry ring app rules under both keys (#1317)`.

### Task 2.4: Write surfaces

**Files:**
- Modify: `apps/api/src/routes/updateRings.ts` (`createRingSchema`/`updateRingSchema` + `appRules: ringAppRulesSchema.optional()`; insert `appRules: data.appRules ?? []`; update `if (data.appRules !== undefined) updateFields.appRules = data.appRules`)
- Modify: `apps/api/src/services/aiToolsPolicyPrereqs.ts` (create/update validate `appRules` through `ringAppRulesSchema`, same pattern as `validateRingAutoApprove` at `:65-81`)
- Modify: `apps/api/src/services/aiAgentSdkTools.ts:2715-2733` (`appRules: z.array(z.object({ source: z.enum(['third_party','custom']), packageId: z.string().min(1).max(256), action: z.enum(['block','pin']), pinnedVersion: z.string().min(1).max(64).optional(), displayName: z.string().max(255).optional() })).max(200).optional()`. Do not use `z.undefined()` anywhere: the model would get zero tools)
- Modify: `apps/api/src/services/configurationPolicy.ts` (`addFeatureLink` `:1730`, `updateFeatureLink` `:1850`: for `featureType === 'patch'` call the new `assertNoPolicyApprovalEdits(storedInline, incomingInline)`)
- Create: the `assertNoPolicyApprovalEdits` helper in `apps/api/src/services/configPolicyPatching.ts`
- Modify: `apps/api/src/services/aiToolsFleet.ts` (`setup_auto_approval`: the action is already disabled at `:1159-1163`; its body `:1619-1710` is unreachable), `apps/api/src/services/aiToolSchemasFleet.ts`, `apps/api/src/services/aiToolsConfigPolicy.ts:229` (patch inline shape), `apps/api/src/services/aiAgentSystemPrompt.ts:40`, and `mcpGuidance.ts` if it describes patch inline settings
- Test: `updateRings_list_create.test.ts`, `updateRings_detail_update_delete.test.ts`, `aiToolsPolicyPrereqs.test.ts`, `configurationPolicy.test.ts`, `aiToolSchemasFleet.test.ts`, plus a `setup_auto_approval` test next to the existing `aiToolsFleet` tests

**Interfaces:**
- Produces: `assertNoPolicyApprovalEdits(stored: unknown, incoming: unknown): void`. It throws `PolicyApprovalFieldMovedError` (status 400, code `APPROVAL_RULES_MOVED_TO_RING`, message: `"Approval and application rules are configured on the Update Ring linked to this policy."`) when `incoming.apps` is present and its canonical set differs from the stored set, or when `incoming.autoApprove === true` and the stored value is not `true`. A round-trip of the stored values passes.

- [ ] **Step 1: Failing tests**:
  - ring create/update persist `appRules` and reject duplicates (400).
  - `manage_update_rings create` with a duplicate → error string; with a valid list → persisted.
  - `updateFeatureLink` (patch) with an added app rule → 400 `APPROVAL_RULES_MOVED_TO_RING`; with the unchanged stored list → OK; with `autoApprove: true` newly set → 400.
  - `setup_auto_approval` (Open Decision 2, recommended A): the action stays disabled, its unreachable body and the `autoApprove`/`autoApproveSeverities` input fields in `aiToolSchemasFleet.ts` are removed, and the disabled-action error now says auto-approval is configured on an Update Ring (`manage_update_rings`) linked via `manage_policy_feature_link` — today it steers the model to set auto-approval on the policy, which has no effect.
  - The `manage_policy_feature_link` schema description no longer lists `apps` / `autoApprove*` for patch.
- [ ] **Steps 2–4**: run the tests and confirm they fail, implement, then confirm they pass. Also run `src/services/aiGuardrails.test.ts`. `manage_update_rings` writes are already action-level escalated (`aiGuardrails.ts:382,591`), so do not lower that.
- [ ] **Step 5: Commit**, then open the W02 PR with the survey output and these release notes: *"Per-app block/pin rules moved from configuration policies to Update Rings. Policies that had rules but no ring now link to a new ring named '<policy> — app rules' that auto-approves nothing. Rings shared by policies with different rules were split; the split rings start with a copy of the original ring's approvals, and later approvals must be made on each ring. Policy-level auto-approve settings (unused since 2026-08) are no longer accepted; configure auto-approval on the Update Ring."* Run `/pr-review-toolkit:review-pr` with an Opus reviewer, plus the full API unit suite and the integration shard locally (`vitest.integration.config.ts`) before marking ready.

---

## W03 — Web (same release as W02)

### Task 3.1: Ring form "Application rules"

**Files:**
- Move: `apps/web/src/components/configurationPolicies/featureTabs/PatchAppRulesSection.tsx` (+ test) → `apps/web/src/components/patches/RingAppRulesSection.tsx`. Keep the component API (`rules`, `onChange`) and its picker + manual-entry fallback.
- Modify: `apps/web/src/components/patches/UpdateRingForm.tsx` (schema field `appRules`, default `[]`, render the section under the auto-approve block), `patchHelpers.ts` (`normalizeRing` coerces `appRules`, tolerating a missing value or non-array), `PatchesPage.tsx` / `UpdateRingList.tsx` (submit + edit defaults + badge `N app rules` when N > 0)
- Test: `UpdateRingForm.test.tsx`, `RingAppRulesSection.test.tsx`, `patchHelpers.test.ts`, `UpdateRingList` test

- [ ] **Step 1: Failing tests**: adding a block rule includes `appRules: [{…}]` in the submit payload; an edited ring loads stored rules; the list shows the `2 app rules` badge (`data-testid="ring-app-rules-badge"`); `normalizeRing({ appRules: 'x' })` gives `appRules: []`.
- [ ] **Step 2: Picker check**: `GET /patches/app-options` already accepts partner scope (`routes/patches/appOptions.ts:39` `requireScope('organization','partner','system')`, partner filter `:76-86`, optional `orgId` narrows). Call it from the ring form without `orgId` and verify it returns catalog + partner-observed apps in "All orgs" mode; keep the manual-entry fallback.
- [ ] **Steps 3–5**: implement, run `cd apps/web && npx vitest run src/components/patches src/lib/__tests__/no-silent-mutations.test.ts`, then commit.

### Task 3.2: Patch tab + device view cleanup

**Files:**
- Modify: `PatchTab.tsx` (remove `autoApprove`, `autoApproveSeverities`, `autoApproveDeferralDays`, `apps` from state `:29-32`/`:48-51` and from the save payload `:312-348`; remove `<PatchAppRulesSection>` `:606`; under the ring picker add `data-testid="patch-ring-owns-approval-hint"` with the text "Auto-approval and application rules are set on the linked Update Ring."; when no ring is selected, show "No ring linked — patches install only after manual approval.")
- Modify: `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx` (drop the unused policy auto-approve row; app rules come from the ring)
- Test: `PatchTab.test.tsx`, `DeviceEffectiveConfigTab.patchApproval.test.tsx`

- [ ] **Step 1: Failing tests**: the PatchTab save payload has no `apps`/`autoApprove*` keys; the hint renders both with and without a ring; the device tab no longer renders the policy auto-approve row.
- [ ] **Steps 2–5**: run the tests and confirm they fail, implement, then confirm they pass (`npx vitest run src/components/configurationPolicies src/components/devices/DeviceEffectiveConfigTab`), and commit. The PR body carries the settings accounting table from the spec.

---

## W04 — Contract (one release after W02/W03 shipped)

### Task 4.1: Drop policy auto-approve columns + export projection

**Files:**
- Create: `apps/api/migrations/<W04 name>.sql`
- Modify: `apps/api/src/db/schema/configurationPolicies.ts` (remove `autoApprove`, `autoApproveSeverities`), `services/configurationPolicy.ts:842-860` (insert), `services/configPolicyPatching.ts` (loader `:331-358`, `backfillMissingPatchSettings` `:386-440`), `routes/partnerApi/configuration.ts:47-61,134-139`
- Test: `apps/api/src/__tests__/integration/patchCanonicalExportParity.integration.test.ts`, `partnerApiConfigurationWatermark.integration.test.ts`, `routes/partnerApi/configuration.test.ts`

- [ ] **Step 1: Update the parity/watermark tests to expect the projection without `autoApprove`/`autoApproveSeverities`.** Confirm they fail against the current function.
- [ ] **Step 2: Migration**: (a) `CREATE OR REPLACE FUNCTION public.breeze_partner_export_policy_settings_pre_patch(...)`. Reproduce the **whole body** from the newest migration that defines it (find it with `grep -l breeze_partner_export_policy_settings_pre_patch apps/api/migrations/*.sql | sort | tail -1`), removing only the two keys. Re-emit its trailing REVOKE/GRANT block verbatim. (b) `ALTER TABLE config_policy_patch_settings DROP COLUMN IF EXISTS auto_approve, DROP COLUMN IF EXISTS auto_approve_severities;`. (c) Run `SELECT set_config('breeze.scope','system',true);`, then in a `DO` block: `UPDATE config_policy_feature_links SET inline_settings = inline_settings - 'apps' - 'autoApprove' - 'autoApproveSeverities' - 'autoApproveDeferralDays' WHERE feature_type = 'patch' AND inline_settings ?| ARRAY['apps','autoApprove','autoApproveSeverities','autoApproveDeferralDays'];` with `GET DIAGNOSTICS` + `RAISE WARNING`.
- [ ] **Step 3**: remove the keys from `PATCH_NORMALIZED_MATERIAL_KEYS` and drop the `autoApproveDeferralDays`/`apps` splice in `canonicalizePolicyPatchSettings`.
- [ ] **Step 4**: run the integration tests and confirm they pass, then run `pnpm db:check-drift` and the unit tests for every touched file.
- [ ] **Step 5: Commit** `refactor(api): retire policy-level patch auto-approve storage (#1317)`

### Task 4.2: Remove `policyAutoApprove` + legacy schema fields

**Files:** `packages/shared/src/validators/index.ts` (`patchInlineSettingsSchema`: remove the four fields and the auto-approve `superRefine` branch; keep `policyAppRuleSchema`, which the ring uses), `patchApprovalEvaluator.ts:88-95,114` (remove `policyAutoApprove` and the unused `'policy_auto_approve'` reason, keeping it in any audit display mapping for historical rows), `patchEligibility.ts`, `patchJobSnapshot.ts` (stop writing `policyAutoApprove` and `apps`), `patchJobExecutor.ts` (stop parsing `policyAutoApprove`; keep parsing `apps` from old snapshots), `routes/configurationPolicies/patchJobs.ts:464-468`, `assertNoPolicyApprovalEdits` (delete it: the fields no longer exist, so zod strips them), plus web `apiError.test.ts` and `PatchTab.test.tsx` fixtures.

- [ ] **Step 1: Failing tests**: the snapshot has no `policyAutoApprove` and no `apps`; a `patchInlineSettingsSchema.parse` of a payload carrying `apps` strips it; an executor given an old snapshot with `apps: [block X]` and no `ringAppRules` still blocks X.
- [ ] **Steps 2–5**: run the tests and confirm they fail, implement, then confirm they pass (shared validators, evaluator, eligibility, snapshot, executor, patchJobs, configurationPolicy, partnerApi tests) with `tsc --noEmit` for api, web and shared. Commit and open the PR. Update `apps/docs` patching pages through `/update-breeze-docs`.

---

## Open Decisions

1. **Ring-less policies with policy auto-approve switched on.** These have been inert since the evaluator stopped reading them.
   - **A — Report only (recommended).** The migration counts them; the release notes tell operators to create a ring. Pro: no install starts that is not already happening. Con: the operator's stated intent stays unfulfilled until they act.
   - **B — Create a disabled ring pre-filled from them.** Pro: one click to enable. Con: clutters the ring list with ambiguous rings.
   - **C — Create an enabled ring.** Pro: honours the original intent. Con: starts auto-approving patches the day it deploys, which is a behaviour change.
   **Recommend A.** No deploy step should widen what installs.
2. **`setup_auto_approval` AI tool.** The action is already disabled (`aiToolsFleet.ts:1159-1163`), but its error message points the model at policy-level auto-approval, and its schema and unreachable body still describe `autoApprove`/`autoApproveSeverities`.
   - **A — Keep it disabled; delete the dead body and schema fields; reword the error to point to Update Rings (recommended).** Pro: no new write path. Con: no one-call setup.
   - **B — Re-enable it on rings (create/reuse a ring, link it).** Pro: one-call UX. Con: a new arming write path needing its own guardrail review.
   **Recommend A.** `manage_update_rings` + `manage_policy_feature_link` already cover it.
3. **Org-scoped users lose app-rule authoring.** Rings are partner-level, per the 06-21 design.
   - **A — Accept (recommended).** It is consistent with ring/approval management already being partner-only.
   - **B — Add org-owned rings.** That is a new tenancy shape on `patch_policies` and a large change.
   **Recommend A.** Call it out in the release notes.
4. **Policy writes that still carry `apps`/`autoApprove` after W02.**
   - **A — Reject only real edits, accept unchanged round-trips (recommended).** A stale tab can still save its other fields.
   - **B — Reject any presence.** Stale tabs fail every save until they are refreshed.
   - **C — Strip silently.** This is a silent no-op on a user's edit, which the `runAction` rules forbid.
   **Recommend A.**
5. **App picker** — *resolved, no decision needed*: `/patches/app-options` already accepts partner scope (`routes/patches/appOptions.ts:39,76-86`).
6. **Partner-API export shape (W04).** `autoApprove`/`autoApproveSeverities`/`autoApproveDeferralDays`/`apps` disappear from exported patch settings.
   - **A — Remove them and note it in the release notes (recommended).** The values have been inert or relocated.
   - **B — Keep the constant keys `false`/`[]` for one more release.**
   **Recommend A** unless a known integrator consumes those keys.
7. **Clone vs union for shared rings with different rule sets (case C).**
   - **A — Clone (recommended; as specified).** Exact preservation, at the cost of extra rings.
   - **B — Union onto the shared ring.** No new rings, but policies that had fewer rules gain blocks.
   **Recommend A.** Decide after the pre-W02 survey; if case C is 0 in both regions, the choice is moot.
8. **Policies whose patch link points at an invalid ring reference (case D).** Today the scheduler skips them, but install proposals and the device view still evaluate them with policy app rules.
   - **A — Fail closed at cutover: deny everything with `ring_reference_invalid` (recommended).** Pro: matches the scheduler, no rule can be lost; Con: manual-approval proposals for those policies stop until the link is fixed.
   - **B — Keep reading policy `apps` for invalid-ring links until W04.** Con: W04 strips the inline key, so the problem only moves.
   **Recommend A.** The survey's `case_d_invalid_ref_all` sizes the impact; include it in the W02 release notes.
