# Third-Party Update Ring Auto-Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make third-party (winget/Chocolatey/Homebrew) patching a first-class, visible citizen of Update Ring auto-approval via an explicit `thirdPartyApps` toggle, replacing the invisible severity exemption — and fix the category-rule bugs found during design.

**Architecture:** The ring's `auto_approve` JSONB gains `thirdPartyApps: boolean` and `thirdPartyDeferralDays: number|null`. The evaluator requires **dual consent** for third-party auto-approval: the config policy's `sources` must include `'third_party'` (existing gate, kept) AND the ring toggle must be on. The `third_party_app` virtual category is removed (one inert stored rule fleet-wide, migrated by SQL). The dead `patch_policies.sources` column is deprecated this release (writers removed), dropped next release.

**Tech Stack:** TypeScript, Hono, Drizzle, Zod 4, Vitest, React + react-hook-form + i18next, hand-written SQL migrations.

**Spec:** `docs/superpowers/specs/vuln-patch/2026-08-04-third-party-update-ring-auto-approve-design.md` — read it before starting.

## Global Constraints

- Node is pinned to 22.23.2; use `pnpm`.
- Never edit a shipped migration; new migration filename must sort lexicographically AFTER the current last file in `apps/api/migrations/` (currently `2026-08-12-device-identity-collision-alert-template.sql` — verify with `ls apps/api/migrations | tail -1` and use a later date prefix, e.g. `2026-08-13-`).
- Migrations must be idempotent and must NOT contain inner `BEGIN;`/`COMMIT;`. Data-cleanup statements report row counts via `GET DIAGNOSTICS` + `RAISE WARNING`.
- i18n key parity: any key added/removed in `apps/web/src/locales/en/` MUST be added/removed in ALL locales: `de-DE`, `en`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`. Missing parity reds main.
- `pnpm test` does NOT run the integration suites. Task 10 needs a real Postgres (`DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze`); locally the integration suite wants the fsync=off tmpfs DB or it looks hung.
- Evaluator changes are fail-closed: when in doubt, approve nothing. Never widen approval for malformed stored data.
- No changes to `patchJobExecutor.ts` or `patchJobSnapshot.ts` are needed: `autoApprove` JSONB passes through the snapshot opaquely and is parsed at read time by `parseRingAutoApprove`; the policy `sources` array is already snapshotted and threaded as `ApprovalEvaluationConfig.sources`.
- This branch (`ToddHebebrand/3rd-party-patch-update-rings`) is the working branch; commit after every task.

---

### Task 1: Shared validator — `ringAutoApproveSchema` gains third-party fields

**Files:**
- Modify: `packages/shared/src/validators/index.ts:612-645`
- Test: `packages/shared/src/validators/index_inline_settings.test.ts`

**Interfaces:**
- Consumes: nothing (root task).
- Produces: `ringAutoApproveSchema` / type `RingAutoApprove` now `{ enabled: boolean; severities: ('critical'|'important'|'moderate'|'low')[]; deferralDays: number; thirdPartyApps: boolean; thirdPartyDeferralDays: number | null }`. Refinement: `enabled` requires (`severities.length > 0` OR `thirdPartyApps`). Tasks 2, 5, 7, 8 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Add to the existing `ringAutoApproveSchema` describe block in `packages/shared/src/validators/index_inline_settings.test.ts` (the block containing the test at line ~44):

```ts
  it('accepts a third-party-only ring: enabled with empty severities but thirdPartyApps', () => {
    const result = ringAutoApproveSchema.safeParse({
      enabled: true, severities: [], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: null,
    });
    expect(result.success).toBe(true);
  });

  it('still rejects enabled with empty severities and thirdPartyApps false', () => {
    const result = ringAutoApproveSchema.safeParse({
      enabled: true, severities: [], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: null,
    });
    expect(result.success).toBe(false);
  });

  it('defaults thirdPartyApps=false and thirdPartyDeferralDays=null when omitted', () => {
    const result = ringAutoApproveSchema.parse({ enabled: true, severities: ['critical'], deferralDays: 0 });
    expect(result.thirdPartyApps).toBe(false);
    expect(result.thirdPartyDeferralDays).toBeNull();
  });

  it('rejects out-of-range thirdPartyDeferralDays', () => {
    expect(ringAutoApproveSchema.safeParse({ enabled: true, severities: ['low'], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: 366 }).success).toBe(false);
    expect(ringAutoApproveSchema.safeParse({ enabled: true, severities: ['low'], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: -1 }).success).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @breeze/shared test -- index_inline_settings`
Expected: the 4 new tests FAIL (`thirdPartyApps` unknown / third-party-only shape rejected by current refinement).

- [ ] **Step 3: Implement the schema change**

In `packages/shared/src/validators/index.ts`, replace the `ringAutoApproveSchema` definition (lines 631-643) with:

```ts
export const ringAutoApproveSchema = z.object({
  enabled: z.boolean().default(false),
  severities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])).default([]),
  deferralDays: z.number().int().min(0).max(365).default(0),
  // Third-party (winget/Chocolatey/Homebrew + 'custom') auto-approval. Severity
  // is not the control axis for these (they mostly ingest severity='unknown'),
  // so this is a source-level toggle. Dual consent applies at evaluation: the
  // config policy's `sources` must ALSO include 'third_party'.
  thirdPartyApps: z.boolean().default(false),
  // Hold for third-party candidates, anchored on first-seen (#2218). null =
  // inherit deferralDays.
  thirdPartyDeferralDays: z.number().int().min(0).max(365).nullable().default(null),
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

Also update the doc comment above it (lines 612-630): change "Empty `severities` while `enabled` means nothing auto-approves" to "Empty `severities` while `enabled` approves no OS patches; `thirdPartyApps` independently opts third-party candidates in (dual consent with the policy's `sources`)."

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/shared test -- index_inline_settings`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/index.ts packages/shared/src/validators/index_inline_settings.test.ts
git commit -m "feat(shared): ringAutoApproveSchema gains thirdPartyApps + thirdPartyDeferralDays"
```

---

### Task 2: Evaluator parse layer — `parseRingAutoApprove` compatibility + fail-closed tightening

**Files:**
- Modify: `apps/api/src/services/patchApprovalEvaluator.ts:659-712` (interface `RingAutoApproveConfig` + `parseRingAutoApprove`)
- Test: `apps/api/src/services/patchApprovalEvaluator.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (the evaluator parses raw JSONB itself; it must not import the Zod schema — stored rows predate it).
- Produces: `RingAutoApproveConfig` = `{ enabled: boolean; severities: string[]; deferralDays: number; thirdPartyApps: boolean; thirdPartyDeferralDays: number | null }`. `parseRingAutoApprove(autoApprove: unknown): RingAutoApproveConfig` with the compatibility rules below. Tasks 3-4 rely on these exact field names.

Compatibility rules (from the spec, §Evaluator changes item 4):
- `thirdPartyApps` **absent** → `severities.length > 0` after sanitization (preserves the old #2218 exemption for valid pre-migration rows; keeps `{enabled:true, severities:[]}` and boolean `true` inert).
- `thirdPartyApps` **present non-boolean** → `false`.
- Unrecognized severity strings are dropped (previously any string was kept).
- A **present but invalid** `deferralDays` (non-number, non-integer, negative) now disables the whole row (previously coerced to 0 = no hold, which is fail-open). Absent `deferralDays` still → 0.
- `thirdPartyDeferralDays`: integer in [0, 365] → value; anything else (absent, null, malformed) → `null`.

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `apps/api/src/services/patchApprovalEvaluator.test.ts`. The file already exports/tests via `resolveApprovedPatchesForDevice`; for parse-level behavior, export `parseRingAutoApprove` from the evaluator (add `export` keyword) and test it directly:

```ts
import { parseRingAutoApprove } from './patchApprovalEvaluator';

describe('parseRingAutoApprove — thirdPartyApps compatibility (#spec 2026-08-04)', () => {
  it('derives thirdPartyApps=true for a legacy enabled row with recognized severities', () => {
    const cfg = parseRingAutoApprove({ enabled: true, severities: ['critical'], deferralDays: 3 });
    expect(cfg).toEqual({ enabled: true, severities: ['critical'], deferralDays: 3, thirdPartyApps: true, thirdPartyDeferralDays: null });
  });

  it('derives thirdPartyApps=false for legacy enabled rows with no recognized severities', () => {
    expect(parseRingAutoApprove({ enabled: true, severities: [] }).thirdPartyApps).toBe(false);
    expect(parseRingAutoApprove({ enabled: true, severities: ['bogus'] }).thirdPartyApps).toBe(false);
    expect(parseRingAutoApprove(true).thirdPartyApps).toBe(false);
  });

  it('honors an explicit thirdPartyApps boolean and treats malformed as false', () => {
    expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true }).thirdPartyApps).toBe(true);
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical'], thirdPartyApps: false }).thirdPartyApps).toBe(false);
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical'], thirdPartyApps: 'yes' }).thirdPartyApps).toBe(false);
  });

  it('drops unrecognized severity strings', () => {
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical', 'bogus', 7] }).severities).toEqual(['critical']);
  });

  it('disables the row on a present-but-invalid deferralDays instead of coercing to 0', () => {
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical'], deferralDays: 'soon' }).enabled).toBe(false);
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical'], deferralDays: -1 }).enabled).toBe(false);
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical'], deferralDays: 1.5 }).enabled).toBe(false);
    // absent stays fine
    expect(parseRingAutoApprove({ enabled: true, severities: ['critical'] })).toMatchObject({ enabled: true, deferralDays: 0 });
  });

  it('parses thirdPartyDeferralDays: valid int kept, malformed/absent/null → null', () => {
    expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true, thirdPartyDeferralDays: 14 }).thirdPartyDeferralDays).toBe(14);
    expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true, thirdPartyDeferralDays: null }).thirdPartyDeferralDays).toBeNull();
    expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true, thirdPartyDeferralDays: 999 }).thirdPartyDeferralDays).toBeNull();
    expect(parseRingAutoApprove({ enabled: true, severities: [], thirdPartyApps: true }).thirdPartyDeferralDays).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @breeze/api test -- patchApprovalEvaluator`
Expected: FAIL — `parseRingAutoApprove` is not exported and lacks the new fields.

- [ ] **Step 3: Implement**

Replace `RingAutoApproveConfig` (lines 659-668) and `parseRingAutoApprove` (lines 670-712) with:

```ts
interface RingAutoApproveConfig {
  enabled: boolean;
  severities: string[];
  /** Deferral window (days) for OS ring auto-approve. 0 = no deferral. */
  deferralDays: number;
  /** Third-party source-level auto-approve toggle (dual consent with policy sources). */
  thirdPartyApps: boolean;
  /** Third-party hold override; null = inherit deferralDays. First-seen anchored (#2218). */
  thirdPartyDeferralDays: number | null;
}

const RECOGNIZED_RING_SEVERITIES = new Set(['critical', 'important', 'moderate', 'low']);

const DISABLED_RING_AUTO_APPROVE: RingAutoApproveConfig = {
  enabled: false,
  severities: [],
  deferralDays: 0,
  thirdPartyApps: false,
  thirdPartyDeferralDays: null,
};

/**
 * Parse a ring's `autoApprove` JSONB into a typed config. Tolerant of every
 * historical shape, but FAIL-CLOSED about meaning:
 *  - boolean `true` → enabled, no severities, no third-party → approves nothing
 *  - missing/`{}`/malformed → disabled
 *  - unrecognized severity strings are dropped (never matched anyway; dropping
 *    them keeps the thirdPartyApps compatibility rule honest)
 *  - a PRESENT but invalid `deferralDays` disables the row entirely — the old
 *    coerce-to-0 turned a malformed hold into "no hold", which is fail-open
 *  - `thirdPartyApps` absent (pre-2026-08 rows and job snapshots frozen before
 *    the backfill): derived as `severities.length > 0`, which reproduces the
 *    old #2218 severity-exemption behavior for rows the write schema accepted,
 *    while keeping malformed `{enabled:true}` rows inert. Present non-boolean
 *    (AI-tool or hand-written rows) → false.
 */
export function parseRingAutoApprove(autoApprove: unknown): RingAutoApproveConfig {
  if (autoApprove === true) {
    return { ...DISABLED_RING_AUTO_APPROVE, enabled: true };
  }

  if (!autoApprove || typeof autoApprove !== 'object') {
    return DISABLED_RING_AUTO_APPROVE;
  }

  const config = autoApprove as Record<string, unknown>;
  if (config.enabled !== true) {
    return DISABLED_RING_AUTO_APPROVE;
  }

  const severities = Array.isArray(config.severities)
    ? config.severities.filter(
        (s): s is string => typeof s === 'string' && RECOGNIZED_RING_SEVERITIES.has(s)
      )
    : [];

  let deferralDays = 0;
  if (config.deferralDays !== undefined) {
    const raw = config.deferralDays;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      return DISABLED_RING_AUTO_APPROVE;
    }
    deferralDays = raw;
  }

  const thirdPartyApps =
    'thirdPartyApps' in config ? config.thirdPartyApps === true : severities.length > 0;

  const rawTp = config.thirdPartyDeferralDays;
  const thirdPartyDeferralDays =
    typeof rawTp === 'number' && Number.isInteger(rawTp) && rawTp >= 0 && rawTp <= 365
      ? rawTp
      : null;

  return { enabled: true, severities, deferralDays, thirdPartyApps, thirdPartyDeferralDays };
}
```

- [ ] **Step 4: Run the full evaluator test file**

Run: `pnpm --filter @breeze/api test -- patchApprovalEvaluator`
Expected: new tests PASS. Pre-existing tests may fail ONLY if they asserted the old coerce-to-0 deferral behavior — update any such test to expect the disabled row instead (the new behavior is the spec'd one).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/patchApprovalEvaluator.ts apps/api/src/services/patchApprovalEvaluator.test.ts
git commit -m "feat(api): parseRingAutoApprove thirdPartyApps compatibility + fail-closed deferral/severity parsing"
```

---

### Task 3: Evaluator — category-rule repairs (inert severity chips, non-terminal manual rules, remove virtual category)

**Files:**
- Modify: `apps/api/src/services/patchApprovalEvaluator.ts:24-29` (CategoryRule), `:530-556` (Priority 2 block)
- Test: `apps/api/src/services/patchApprovalEvaluator.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CategoryRule` = `{ category: string; autoApprove: boolean; autoApproveSeverities?: string[]; severityFilter?: string[]; deferralDaysOverride?: number | null }` (`severityFilter` kept as deprecated read alias). Priority-2 semantics: exact-category match only; a matching `autoApprove:false` rule is TERMINAL (returns null).

Three defects being fixed (all confirmed against current code):
1. Routes/UI write `autoApproveSeverities` (`updateRings.ts:85`) but the evaluator reads `severityFilter` (`:27`, `:543`) → severity chips on category rules never enforce (fail-open).
2. A matching rule with `autoApprove:false` falls through to ring auto-approve, contradicting the UI's "needs manual approval" copy.
3. The virtual `third_party_app` source-match (`:535-537`) is superseded by the ring-level toggle (Task 4); stored rules are migrated by Task 6.

- [ ] **Step 1: Write the failing tests**

The existing test file drives `resolveApprovedPatchesForDevice` with mocked DB rows. Follow its established mock pattern (look at how existing category-rule tests in the file seed `device_patches`/`patches` and build the config). Add:

```ts
describe('category rules — repaired semantics (#spec 2026-08-04)', () => {
  it('enforces autoApproveSeverities written by the route/UI (was silently ignored)', async () => {
    // patch: category 'security', severity 'moderate'
    // rule: { category: 'security', autoApprove: true, autoApproveSeverities: ['critical'] }
    // Expect: NOT approved (previously approved because the evaluator read `severityFilter`).
  });

  it('still honors legacy stored severityFilter as a read alias', async () => {
    // rule: { category: 'security', autoApprove: true, severityFilter: ['critical'] }
    // patch severity 'critical' → approved via 'category_rule'; patch severity 'low' → not approved.
  });

  it('treats a matching autoApprove:false rule as terminal — no fall-through to ring auto-approve', async () => {
    // ring autoApprove: { enabled: true, severities: ['critical'] }
    // rule: { category: 'security', autoApprove: false }
    // patch: category 'security', severity 'critical'
    // Expect: NOT approved (previously fell through and ring-auto-approved).
  });

  it('no longer matches third-party patches to a third_party_app rule', async () => {
    // ring autoApprove disabled; rule: { category: 'third_party_app', autoApprove: true }
    // patch: source 'third_party', category 'application', policy sources ['os','third_party']
    // Expect: NOT approved (virtual category removed; Task 4's toggle is the path).
  });
});
```

Flesh these out with the file's existing helpers/mocks — each test body must build real inputs, run `resolveApprovedPatchesForDevice`, and assert on the returned array. Also UPDATE the existing tests that assert the old behavior (there are existing specs covering `severityFilter` naming, third_party_app virtual matching, and fall-through — flip their expectations to the new semantics rather than deleting them; keep their descriptions accurate).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @breeze/api test -- patchApprovalEvaluator`
Expected: the 4 new tests FAIL against current logic.

- [ ] **Step 3: Implement**

Update `CategoryRule` (lines 24-29):

```ts
export interface CategoryRule {
  category: string;
  autoApprove: boolean;
  /** Severity allowlist — the canonical field name the route/UI write (updateRings.ts categoryRuleSchema). */
  autoApproveSeverities?: string[];
  /** @deprecated Legacy stored alias for autoApproveSeverities (rows/snapshots written before 2026-08). Read-only. */
  severityFilter?: string[];
  deferralDaysOverride?: number | null;
}
```

Replace the Priority 2 block (lines 530-556) with:

```ts
  // Priority 2: Category rule (OS categories only). The virtual
  // 'third_party_app' category was removed — third-party auto-approval is the
  // ring-level thirdPartyApps toggle (Priority 3); stored third_party_app rules
  // were migrated to it by the 2026-08-13 backfill. A matching rule is
  // TERMINAL either way: autoApprove:false means "needs manual approval" (the
  // UI's words) and must not fall through to ring-level auto-approve.
  const rule = patch.category
    ? categoryRuleMap.get(canonicalizePatchCategory(patch.category))
    : undefined;
  if (rule) {
    if (!rule.autoApprove) {
      return null;
    }
    // Severity allowlist. Canonical name is autoApproveSeverities (what the
    // route/UI write); severityFilter is honored as a legacy stored alias —
    // before 2026-08 the evaluator ONLY read severityFilter, which the writers
    // never produced, so chips were silently unenforced (fail-open).
    const severityAllowlist = rule.autoApproveSeverities ?? rule.severityFilter;
    if (severityAllowlist && severityAllowlist.length > 0) {
      if (!patch.severity || !severityAllowlist.includes(patch.severity)) {
        return null;
      }
    }
    const deferralDays = rule.deferralDaysOverride ?? ringConfig.deferralDays;
    if (isHeldByDeferral(patch, deferralDays, now, 'category')) {
      return null;
    }
    return 'category_rule';
  }
```

Note: `deferralDaysOverride` may be stored as `null` ("inherit") by the route schema — `?? ringConfig.deferralDays` already handles that; keep it.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api test -- patchApprovalEvaluator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/patchApprovalEvaluator.ts apps/api/src/services/patchApprovalEvaluator.test.ts
git commit -m "fix(api): category rules enforce written severities, are terminal, and drop the third_party_app virtual category"
```

---

### Task 4: Evaluator — dual-consent third-party ring auto-approve

**Files:**
- Modify: `apps/api/src/services/patchApprovalEvaluator.ts:558-609` (Priority 3 block)
- Test: `apps/api/src/services/patchApprovalEvaluator.test.ts`

**Interfaces:**
- Consumes: `RingAutoApproveConfig.thirdPartyApps` / `.thirdPartyDeferralDays` from Task 2.
- Produces: final ring-approval semantics — OS: enabled + non-empty severities + membership + deferral; third-party (`third_party`|`custom` source): enabled + policy `sources` contains `'third_party'` + `thirdPartyApps` + deferral(`thirdPartyDeferralDays ?? deferralDays`, first-seen anchored). Task 10's integration suite asserts these.

- [ ] **Step 1: Write the failing tests**

Add to `patchApprovalEvaluator.test.ts`, following the file's existing mock pattern:

```ts
describe('ring auto-approve — third-party dual consent (#spec 2026-08-04)', () => {
  it('approves a third-party patch only with BOTH policy sources third_party AND ring thirdPartyApps', async () => {
    // enabled ring { severities: [], thirdPartyApps: true }, policy sources ['os','third_party']
    // 3P patch (severity 'unknown', no releaseDate) → approved, reason 'ring_auto_approve'
  });

  it('does not approve third-party when the ring toggle is off, even with policy consent', async () => {
    // enabled ring { severities: ['critical'], thirdPartyApps: false }, sources ['os','third_party'] → 3P not approved
  });

  it('does not approve third-party when policy sources are absent (legacy snapshot) even with the toggle on', async () => {
    // enabled ring { severities: [], thirdPartyApps: true }, config.sources UNDEFINED → 3P not approved
    // (absent sources = "no filtering" upstream; the dual-consent check must still refuse)
  });

  it('supports a third-party-only ring: empty severities approves 3P and no OS patches', async () => {
    // enabled ring { severities: [], thirdPartyApps: true }, sources ['os','third_party']
    // 3P patch approved; OS patch severity 'critical' NOT approved (empty OS severity set stays fail-closed)
  });

  it('treats custom-source patches as third-party for the toggle', async () => {
    // patch source 'custom' behaves exactly like 'third_party' under the toggle
  });

  it('applies thirdPartyDeferralDays over deferralDays for 3P, anchored on firstSeenAt', async () => {
    // thirdPartyDeferralDays: 7, firstSeenAt 3 days ago → held; firstSeenAt 8 days ago → approved
    // null thirdPartyDeferralDays inherits deferralDays
  });
});
```

Flesh out with real mock rows per the file's pattern. Also update the existing #2218 exemption tests in this file — the exemption predicate is replaced, so tests asserting "3P approves because sources contains third_party while thirdPartyApps is untouched/absent" must be revisited: with the Task 2 compatibility rule, a legacy row `{enabled:true, severities:['critical']}` derives `thirdPartyApps=true`, so most existing exemption tests keep passing unchanged — verify rather than assume.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @breeze/api test -- patchApprovalEvaluator`
Expected: new tests FAIL (third-party-only ring hits the empty-severities kill-switch; toggle ignored).

- [ ] **Step 3: Implement**

Replace the Priority 3 block (current lines 558-606) with:

```ts
  // Priority 3: Ring-level auto-approve (#1317). Severity gates OS candidates;
  // third-party candidates are gated by the explicit thirdPartyApps toggle
  // (#2218 exemption replaced by spec 2026-08-04) under DUAL CONSENT:
  //  - the POLICY must have opted into third-party sources ('third_party' in
  //    the snapshotted sources; the default is ['os']). This stays even though
  //    buildAllowedPatchSources filters upstream, because ABSENT sources mean
  //    "no filtering" for legacy job snapshots — without this literal check, a
  //    legacy snapshot plus a permissive ring would silently widen to 3P.
  //  - the RING's autoApprove.thirdPartyApps must be true.
  // NOTE: the literal 'third_party' selection vs the expanded patch-source
  // bucket ('third_party'|'custom') stay in lockstep because
  // buildAllowedPatchSources only admits 'custom' rows via the 'third_party'
  // selection (or an explicit 'custom' entry) — if that expansion table ever
  // changes, revisit this check too.
  if (ringAutoApprove.enabled) {
    if (isThirdPartyPatchSource(patch.source)) {
      if (!(ringConfig.sources ?? []).includes('third_party')) {
        return null;
      }
      if (!ringAutoApprove.thirdPartyApps) {
        return null;
      }
      const hold = ringAutoApprove.thirdPartyDeferralDays ?? ringAutoApprove.deferralDays;
      if (isHeldByDeferral(patch, hold, now, 'ring')) {
        return null;
      }
      return 'ring_auto_approve';
    }

    // OS path: unchanged fail-closed severity gating. Enabled with an empty
    // severity set approves no OS patches (legacy boolean `true` and malformed
    // `{enabled:true}` rows stay inert here).
    if (ringAutoApprove.severities.length === 0) {
      return null;
    }
    if (!patch.severity || !ringAutoApprove.severities.includes(patch.severity)) {
      return null;
    }
    if (isHeldByDeferral(patch, ringAutoApprove.deferralDays, now, 'ring')) {
      return null;
    }
    return 'ring_auto_approve';
  }

  return null;
```

`isHeldByDeferral` (lines 611-657) needs no change — the first-seen fallback for third-party is already in place.

- [ ] **Step 4: Run the whole API unit suite for the touched area**

Run: `pnpm --filter @breeze/api test -- patchApprovalEvaluator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/patchApprovalEvaluator.ts apps/api/src/services/patchApprovalEvaluator.test.ts
git commit -m "feat(api): explicit dual-consent third-party ring auto-approve replaces the severity exemption"
```

---

### Task 5: Ring routes — new autoApprove fields flow; deprecate `sources`; reject `third_party_app` rules

**Files:**
- Modify: `apps/api/src/routes/updateRings.ts` (`:22` default, `:82-87` categoryRuleSchema, `:101`/`:119` sources lines, `:182` list select, `:233` insert, `:348` update, and the `GET /:id` select — grep `sources: patchPolicies.sources` for every occurrence)
- Modify: `apps/api/src/db/schema/patches.ts:151` (deprecation comment only)
- Test: `apps/api/src/routes/updateRings_list_create.test.ts`, `apps/api/src/routes/updateRings_detail_update_delete.test.ts`

**Interfaces:**
- Consumes: `ringAutoApproveSchema` from Task 1 (already imported at `updateRings.ts:18` — new fields validate automatically).
- Produces: create/update API accepts `autoApprove.thirdPartyApps`/`thirdPartyDeferralDays`, rejects `sources` (unknown key) and `third_party_app` category rules. Ring responses no longer include `sources`. Task 8's UI posts against this contract.

- [ ] **Step 1: Write the failing tests**

In `updateRings_list_create.test.ts` (follow its existing route-test mock pattern):

```ts
  it('creates a third-party-only ring (empty severities + thirdPartyApps)', async () => {
    // POST { name, autoApprove: { enabled: true, severities: [], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: 14 } }
    // Expect 200/201 and the inserted values to include the two new fields.
  });

  it('rejects a third_party_app category rule with a helpful message', async () => {
    // POST { name, categoryRules: [{ category: 'third_party_app', autoApprove: true }] } → 400
  });

  it('no longer returns sources in ring list responses', async () => {
    // GET / → each ring object lacks a `sources` key
  });
```

In `updateRings_detail_update_delete.test.ts`:

```ts
  it('PATCH persists thirdPartyApps and thirdPartyDeferralDays', async () => { /* PATCH autoApprove with new fields → updateFields.autoApprove carries them */ });
  it('PATCH rejects a sources payload as an unknown field no-op', async () => { /* PATCH { sources: ['os'] } → sources not in updateFields (Zod strips unknown keys; assert the update call received no sources) */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @breeze/api test -- updateRings_list_create updateRings_detail_update_delete`
Expected: new tests FAIL (sources still selected/written; third_party_app accepted; note `createRingSchema` currently accepts `sources` so the strip-assertion fails).

- [ ] **Step 3: Implement**

1. `DEFAULT_RING_AUTO_APPROVE` (line 22):
```ts
const DEFAULT_RING_AUTO_APPROVE = {
  enabled: false, severities: [], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: null,
} as const;
```
2. `categoryRuleSchema` (lines 82-87) — reject the retired virtual category:
```ts
const categoryRuleSchema = z.object({
  category: z.string().max(100).refine((c) => c.trim().toLowerCase() !== 'third_party_app', {
    message: "The 'third_party_app' category rule was replaced by autoApprove.thirdPartyApps on the ring.",
  }),
  autoApprove: z.boolean(),
  autoApproveSeverities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])).optional(),
  deferralDaysOverride: z.number().int().min(0).max(365).nullable().optional(),
});
```
3. Delete the `sources:` line from `createRingSchema` (:101) and `updateRingSchema` (:119).
4. Delete `sources: patchPolicies.sources,` from the list select (:182) and from the `GET /:id` select (grep for the second occurrence).
5. Delete `sources: data.sources ?? null,` from the insert (:233) and `if (data.sources !== undefined) updateFields.sources = data.sources;` from the update (:348).
6. In `apps/api/src/db/schema/patches.ts`, above the `sources` column on `patchPolicies` (~line 151), add:
```ts
  // DEPRECATED (spec 2026-08-04): never consumed by the approval path — the
  // evaluated sources are config_policy_patch_settings.sources. Writers removed
  // in the same release; DROP COLUMN ships one release later (expand/contract).
```
7. `pnpm --filter @breeze/api exec tsc --noEmit` will surface any other reader of `patchPolicies.sources` — the known one is `aiToolsPolicyPrereqs.ts` (Task 7); if others appear, remove their `sources` usage the same way and note it in the commit message.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api test -- updateRings`
Expected: PASS (update any pre-existing test fixtures that posted `sources` or asserted it in responses).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/updateRings.ts apps/api/src/db/schema/patches.ts apps/api/src/routes/updateRings_list_create.test.ts apps/api/src/routes/updateRings_detail_update_delete.test.ts
git commit -m "feat(api): ring routes accept thirdPartyApps, drop dead sources plumbing, reject third_party_app rules"
```

---

### Task 6: Backfill migration

**Files:**
- Create: `apps/api/migrations/2026-08-13-ring-third-party-auto-approve-backfill.sql` (confirm the prefix sorts after `ls apps/api/migrations | tail -1` first)

**Interfaces:**
- Consumes: the parse compatibility rule from Task 2 (the SQL must implement the SAME rule: thirdPartyApps=true iff enabled with ≥1 recognized severity).
- Produces: all `patch_policies.auto_approve` rows carry explicit `thirdPartyApps`; no `third_party_app` category rules remain. Prod expectation (surveyed 2026-08-04): statement 1 touches 0 rows, statements 2-3 touch 1 row (EU).

- [ ] **Step 1: Write the migration**

```sql
-- Spec 2026-08-04: third-party ring auto-approve. Backfills the explicit
-- autoApprove.thirdPartyApps shape and migrates legacy 'third_party_app'
-- category rules to the ring-level toggle. Idempotent; counts RAISEd so the
-- rollout numbers land in Postgres logs (expected prod: 0 / 1 / 0 rows).

DO $$
DECLARE
  n integer;
BEGIN
  -- 1) Enabled object-shaped rows lacking thirdPartyApps: derive it from
  --    whether the row has >=1 recognized severity (mirrors
  --    parseRingAutoApprove's compatibility rule / the old #2218 exemption).
  UPDATE patch_policies
  SET auto_approve = auto_approve
        || jsonb_build_object(
             'thirdPartyApps',
             EXISTS (
               SELECT 1
               FROM jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(auto_approve->'severities') = 'array'
                      THEN auto_approve->'severities'
                      ELSE '[]'::jsonb END
               ) AS sev(v)
               WHERE sev.v IN ('critical','important','moderate','low')
             )
           )
        || jsonb_build_object('thirdPartyDeferralDays', NULL::int)
  WHERE kind = 'ring'
    AND jsonb_typeof(auto_approve) = 'object'
    AND auto_approve->>'enabled' = 'true'
    AND NOT auto_approve ? 'thirdPartyApps';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'ring-3p backfill: stamped explicit thirdPartyApps on % enabled auto_approve rows', n; END IF;

  -- 2) Rings with an autoApprove:true third_party_app category rule: turn on
  --    the ring-level toggle (carrying the rule's deferral override) and strip
  --    the rule. Preserves intent: those rings wanted 3P auto-approved.
  UPDATE patch_policies p
  SET auto_approve =
        (CASE WHEN jsonb_typeof(p.auto_approve) = 'object' THEN p.auto_approve ELSE '{}'::jsonb END)
        || jsonb_build_object('enabled', true, 'thirdPartyApps', true)
        || COALESCE(
             (SELECT CASE WHEN (r.rule->>'deferralDaysOverride') ~ '^\d+$'
                          THEN jsonb_build_object('thirdPartyDeferralDays', (r.rule->>'deferralDaysOverride')::int)
                          ELSE '{}'::jsonb END
              FROM jsonb_array_elements(p.category_rules) AS r(rule)
              WHERE r.rule->>'category' = 'third_party_app'
                AND r.rule->>'autoApprove' = 'true'
              LIMIT 1),
             '{}'::jsonb),
      category_rules = COALESCE(
        (SELECT jsonb_agg(r.rule)
         FROM jsonb_array_elements(p.category_rules) AS r(rule)
         WHERE r.rule->>'category' IS DISTINCT FROM 'third_party_app'),
        '[]'::jsonb),
      updated_at = now()
  WHERE p.kind = 'ring'
    AND jsonb_typeof(p.category_rules) = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p.category_rules) AS r(rule)
      WHERE r.rule->>'category' = 'third_party_app'
        AND r.rule->>'autoApprove' = 'true'
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'ring-3p backfill: converted third_party_app category rules to the ring toggle on % rings', n; END IF;

  -- 3) Strip any remaining (autoApprove:false) third_party_app rules — nothing
  --    to preserve; the category no longer exists.
  UPDATE patch_policies p
  SET category_rules = COALESCE(
        (SELECT jsonb_agg(r.rule)
         FROM jsonb_array_elements(p.category_rules) AS r(rule)
         WHERE r.rule->>'category' IS DISTINCT FROM 'third_party_app'),
        '[]'::jsonb),
      updated_at = now()
  WHERE p.kind = 'ring'
    AND jsonb_typeof(p.category_rules) = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p.category_rules) AS r(rule)
      WHERE r.rule->>'category' = 'third_party_app'
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'ring-3p backfill: stripped inert third_party_app rules from % rings', n; END IF;
END $$;
```

- [ ] **Step 2: Apply and verify idempotency locally**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
```
Expected: applies cleanly. Then seed a probe row and re-run to prove idempotency + correctness:

```bash
psql "$DATABASE_URL" -c "UPDATE patch_policies SET auto_approve='{\"enabled\":true,\"severities\":[\"critical\"]}'::jsonb, category_rules='[{\"category\":\"third_party_app\",\"autoApprove\":true,\"deferralDaysOverride\":5}]'::jsonb WHERE kind='ring' AND id=(SELECT id FROM patch_policies WHERE kind='ring' LIMIT 1) RETURNING id;"
psql "$DATABASE_URL" -c "DELETE FROM breeze_migrations WHERE filename LIKE '2026-08-13-ring-third-party%';"
pnpm db:migrate
psql "$DATABASE_URL" -c "SELECT auto_approve, category_rules FROM patch_policies WHERE kind='ring' AND auto_approve ? 'thirdPartyApps' LIMIT 3;"
```
Expected: the probe row shows `thirdPartyApps: true`, `thirdPartyDeferralDays: 5`, and an empty/3p-free `category_rules`. Re-running `pnpm db:migrate` again (after another `DELETE FROM breeze_migrations ...`) is a no-op (all three WARNING counts absent). Reset the probe row afterwards if it was a seeded dev ring.

- [ ] **Step 3: Run `pnpm db:check-drift`**

Expected: no drift (data-only migration).

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-08-13-ring-third-party-auto-approve-backfill.sql
git commit -m "feat(api): backfill explicit thirdPartyApps and migrate third_party_app category rules"
```

---

### Task 7: AI tool surface sweep

**Files:**
- Modify: `apps/api/src/services/aiToolsPolicyPrereqs.ts` (`:35` validateRingAutoApprove doc, `:183-184` input_schema, `:216` list select, `:267` create values, `:299` update)
- Modify: `apps/api/src/services/aiToolSchemas.ts:1396` (manage_update_rings Zod: delete the `sources` line; `:1397` autoApprove uses the shared schema — updates automatically)
- Check (grep, update only if they mention ring `sources`/severity-only auto-approve): `apps/api/src/services/mcpGuidance.ts`, `aiAgentSystemPrompt.ts`, `aiGuardrails.ts`, `aiAgentSdkTools.ts`
- Test: `apps/api/src/services/aiToolsPolicyPrereqs.test.ts`

**Interfaces:**
- Consumes: `ringAutoApproveSchema` (Task 1) via `validateRingAutoApprove`.
- Produces: `manage_update_rings` accepts the new autoApprove fields, no longer accepts/returns `sources`.

- [ ] **Step 1: Write the failing tests**

In `aiToolsPolicyPrereqs.test.ts`, following its existing handler-invocation pattern:

```ts
  it('manage_update_rings create accepts a third-party-only autoApprove', async () => {
    // action create, autoApprove { enabled: true, severities: [], thirdPartyApps: true } → success (no "must list at least one severity" error)
  });

  it('manage_update_rings create/update ignore a sources input and never write the column', async () => {
    // action create with sources: ['os'] → inserted values contain no `sources` key
  });

  it('manage_update_rings still rejects enabled with no severities and no thirdPartyApps', async () => {
    // autoApprove { enabled: true, severities: [] } → error mentioning severity or third-party
  });
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm --filter @breeze/api test -- aiToolsPolicyPrereqs`
Expected: FAIL (third-party-only rejected by the old refinement path through `validateRingAutoApprove`; sources still written). Note: if `validateRingAutoApprove` (line 35) wraps the shared `ringAutoApproveSchema`, the first/third tests may already pass after Task 1 — verify, and keep the tests either way as regression cover.

- [ ] **Step 3: Implement**

1. Delete the `sources:` property from the `manage_update_rings` `input_schema` (line 183), from the list select (line 216), the create values (line 267), and the update branch (line 299).
2. Update the `autoApprove` description (line 184) to:
```ts
autoApprove: { type: 'object', description: 'Auto-approval rules, e.g. { enabled: true, severities: ["critical","important"], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: null }. severities gate OS patches only and must be a subset of ["critical","important","moderate","low"]. thirdPartyApps auto-approves third-party app updates (winget/Chocolatey/Homebrew/custom) — it also requires the linked configuration policy to include third-party patch sources. If enabled is true you MUST set at least one severity OR thirdPartyApps: true.' },
```
3. Delete the `sources:` line from the `manage_update_rings` Zod schema in `aiToolSchemas.ts` (line 1396).
4. `grep -n "sources" apps/api/src/services/mcpGuidance.ts apps/api/src/services/aiAgentSystemPrompt.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiAgentSdkTools.ts` — update any prose describing ring `sources` or "severities required" auto-approve rules to match the new contract; leave unrelated hits alone.
5. `pnpm --filter @breeze/api exec tsc --noEmit` — must be clean (this is also the check that no other `patchPolicies.sources` reader survived Tasks 5/7; `apps/api/src/scripts/migrateToConfigPolicies.ts:491` may still reference it — that script is a retained one-shot, remove its `sources` mapping too).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api test -- aiToolsPolicyPrereqs aiToolSchemas`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsPolicyPrereqs.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiToolsPolicyPrereqs.test.ts apps/api/src/scripts/migrateToConfigPolicies.ts
git commit -m "feat(api): manage_update_rings supports thirdPartyApps, drops ring sources"
```

---

### Task 8: Web — UpdateRingForm third-party subsection

**Files:**
- Modify: `apps/web/src/components/patches/UpdateRingForm.tsx`
- Modify: `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR}/patches.json`
- Test: `apps/web/src/components/patches/UpdateRingForm.test.tsx`

**Interfaces:**
- Consumes: API contract from Task 5 (`autoApprove.thirdPartyApps: boolean`, `autoApprove.thirdPartyDeferralDays: number` — the form always submits a concrete number, mirroring the existing category-override "explicit, never blank" pattern at `UpdateRingForm.tsx:266-276`; `null` inherit is for API writers only).
- Produces: form values type `UpdateRingFormValues['autoApprove']` gains the two fields; `PatchesPage.tsx` posts form values as-is, so no wiring change there (verify in Step 4).

- [ ] **Step 1: Write the failing tests**

Add to `UpdateRingForm.test.tsx`, following its existing render/interaction pattern:

```tsx
  it('renders the third-party toggle inside the enabled auto-approve section', async () => {
    // render with defaultValues { autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: 0 } }
    // expect screen.getByTestId('ring-third-party-enabled') to be in the document and unchecked
  });

  it('submits a third-party-only ring without a severity validation error', async () => {
    // enable auto-approve, leave severities empty, check ring-third-party-enabled, submit
    // expect onSubmit called with autoApprove.thirdPartyApps === true and severities []
  });

  it('still blocks enabled + no severities + third-party off', async () => {
    // enable auto-approve, submit → validation message, onSubmit not called
  });

  it('no longer offers third_party_app as a category override option', () => {
    // add an override; assert the category <select> has no option with value 'third_party_app'
  });

  it('shows the policy-consent note when third-party is on', async () => {
    // check the toggle → getByTestId('ring-third-party-policy-note') visible
  });
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm --filter @breeze/web test -- UpdateRingForm`
Expected: new tests FAIL.

- [ ] **Step 3: Implement the form changes**

1. `makeRingSchema` — extend `ringAutoApproveFormSchema` (lines 18-30):
```ts
  const ringAutoApproveFormSchema = z.object({
    enabled: z.boolean(),
    severities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])),
    deferralDays: z.coerce.number().int().min(0).max(365),
    thirdPartyApps: z.boolean(),
    // Always a concrete number in the form (pre-filled from the ring hold);
    // null "inherit" is an API-writer concept, mirroring deferralDaysOverride.
    thirdPartyDeferralDays: z.coerce.number().int().min(0).max(365),
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
2. `categoryOptions` (lines 67-74): delete the `third_party_app` entry and update the comment to note third-party moved to the ring-level toggle.
3. `initialValues` (lines 204-227): change the `autoApprove` default to
```ts
      autoApprove: { enabled: false, severities: [], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: 0 },
```
and after `merged` is built, normalize an incoming null/undefined third-party hold to the inherited value:
```ts
    const aa = merged.autoApprove ?? { enabled: false, severities: [], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: null };
    const mergedAutoApprove = {
      thirdPartyApps: false,
      ...aa,
      thirdPartyDeferralDays: aa.thirdPartyDeferralDays ?? aa.deferralDays ?? 0,
    };
```
and use `autoApprove: mergedAutoApprove` in the returned object.
4. In the enabled branch of the default-rule card (after the severities/HoldField row ending at line 405), insert the subsection:
```tsx
                <div className="mt-4 w-full border-t pt-4" data-testid="ring-third-party-section">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <span className="text-sm font-medium">{t('updateRingForm.thirdParty.title')}</span>
                      <p className="mt-0.5 max-w-md text-xs text-muted-foreground">
                        {t('updateRingForm.thirdParty.description')}
                      </p>
                    </div>
                    <ApproveToggle
                      checked={!!autoApprove?.thirdPartyApps}
                      field={register('autoApprove.thirdPartyApps')}
                      testId="ring-third-party-enabled"
                      t={t}
                    />
                  </div>
                  {autoApprove?.thirdPartyApps && (
                    <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
                      <p className="max-w-md text-xs text-muted-foreground" data-testid="ring-third-party-policy-note">
                        {t('updateRingForm.thirdParty.policyNote')}
                      </p>
                      <HoldField
                        field={register('autoApprove.thirdPartyDeferralDays')}
                        testId="ring-third-party-deferral"
                        t={t}
                      />
                    </div>
                  )}
                </div>
```
   Layout note: the enabled branch's container (line 382) is `flex flex-wrap items-end justify-between` — the new `w-full` block wraps below the severities/hold row. Keep the existing `ring-third-party-severity-note` testid on the severity note (copy changes below).
5. The `onSubmit` transform (lines 280-290) spreads `values.autoApprove`, so the new fields flow through untouched — no change needed there.

- [ ] **Step 4: Verify PatchesPage wiring**

`grep -n "autoApprove" apps/web/src/components/patches/PatchesPage.tsx` — confirm create/update handlers post `values.autoApprove` (or the whole form values) without field-picking. If a handler picks fields explicitly, add the two new ones. Also confirm `defaultValues` passed when editing a ring come from the API object (which now includes the new fields).

- [ ] **Step 5: Locale keys**

In `apps/web/src/locales/en/patches.json` under `updateRingForm`:
- Add `validation.selectSeverityOrThirdParty`: `"Select at least one severity or enable third-party app auto-approval."`
- Replace `approvalPolicy.severityNote` with: `"Severities apply to OS updates only. Third-party app updates are controlled by the toggle below — they are not severity-controlled."`
- Add object `thirdParty`:
```json
"thirdParty": {
  "title": "Third-party applications",
  "description": "Auto-approve app updates from winget, Chocolatey, and Homebrew. App block/pin rules still apply; the hold is measured from when each device first reports the update.",
  "policyNote": "Applies only to devices whose configuration policy includes third-party software updates (policy Patch settings)."
}
```
- Delete `categories.thirdPartyApp`.

Mirror in every other locale (same keys, translated; delete `categories.thirdPartyApp` everywhere):
- **de-DE:** selectSeverityOrThirdParty `"Mindestens einen Schweregrad auswählen oder die automatische Genehmigung für Drittanbieter-Apps aktivieren."` · severityNote `"Schweregrade gelten nur für Betriebssystem-Updates. Drittanbieter-App-Updates werden über den Schalter unten gesteuert — sie sind nicht schweregradbasiert."` · title `"Drittanbieter-Anwendungen"` · description `"App-Updates aus winget, Chocolatey und Homebrew automatisch genehmigen. App-Sperr-/Pin-Regeln gelten weiterhin; die Wartezeit zählt ab der ersten Meldung des Updates durch das Gerät."` · policyNote `"Gilt nur für Geräte, deren Konfigurationsrichtlinie Software-Updates von Drittanbietern einschließt (Patch-Einstellungen der Richtlinie)."`
- **es-419:** `"Selecciona al menos una severidad o habilita la aprobación automática de apps de terceros."` · `"Las severidades aplican solo a las actualizaciones del sistema operativo. Las actualizaciones de apps de terceros se controlan con el interruptor de abajo — no se controlan por severidad."` · `"Aplicaciones de terceros"` · `"Aprueba automáticamente actualizaciones de apps de winget, Chocolatey y Homebrew. Las reglas de bloqueo/fijado de apps siguen aplicando; la espera se mide desde que cada dispositivo reporta la actualización por primera vez."` · `"Aplica solo a dispositivos cuya política de configuración incluye actualizaciones de software de terceros (ajustes de parches de la política)."`
- **fr-FR / fr-CA:** `"Sélectionnez au moins une sévérité ou activez l'approbation automatique des applications tierces."` · `"Les sévérités ne s'appliquent qu'aux mises à jour du système d'exploitation. Les mises à jour d'applications tierces sont contrôlées par l'interrupteur ci-dessous — elles ne sont pas contrôlées par sévérité."` · `"Applications tierces"` · `"Approuver automatiquement les mises à jour d'applications winget, Chocolatey et Homebrew. Les règles de blocage/épinglage s'appliquent toujours ; le délai est mesuré à partir du premier signalement de la mise à jour par chaque appareil."` · `"S'applique uniquement aux appareils dont la politique de configuration inclut les mises à jour logicielles tierces (paramètres de correctifs de la politique)."`
- **it-IT:** `"Seleziona almeno una gravità o abilita l'approvazione automatica delle app di terze parti."` · `"Le gravità si applicano solo agli aggiornamenti del sistema operativo. Gli aggiornamenti delle app di terze parti sono controllati dall'interruttore qui sotto — non sono controllati per gravità."` · `"Applicazioni di terze parti"` · `"Approva automaticamente gli aggiornamenti delle app da winget, Chocolatey e Homebrew. Le regole di blocco/fissaggio delle app restano valide; l'attesa è misurata da quando ogni dispositivo segnala per la prima volta l'aggiornamento."` · `"Si applica solo ai dispositivi la cui politica di configurazione include gli aggiornamenti software di terze parti (impostazioni patch della politica)."`
- **pt-BR:** `"Selecione pelo menos uma severidade ou habilite a aprovação automática de apps de terceiros."` · `"As severidades se aplicam apenas às atualizações do sistema operacional. Atualizações de apps de terceiros são controladas pelo botão abaixo — não são controladas por severidade."` · `"Aplicativos de terceiros"` · `"Aprovar automaticamente atualizações de apps do winget, Chocolatey e Homebrew. As regras de bloqueio/fixação de apps continuam valendo; a espera é medida a partir do primeiro relato da atualização por cada dispositivo."` · `"Aplica-se apenas a dispositivos cuja política de configuração inclui atualizações de software de terceiros (configurações de patch da política)."`

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @breeze/web test -- UpdateRingForm`
Expected: PASS, including the pre-existing severity-note test (update its copy assertion if it matched the old string). Also run `pnpm --filter @breeze/web test -- i18n` if a key-parity/literal-key suite exists (grep `apps/web/src` for the i18n gate test) — parity must be green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/patches/UpdateRingForm.tsx apps/web/src/components/patches/UpdateRingForm.test.tsx apps/web/src/locales/*/patches.json
git commit -m "feat(web): third-party auto-approve subsection on the update ring form"
```

---

### Task 9: Web — ring list badges + PatchTab cross-link hint

**Files:**
- Modify: `apps/web/src/components/patches/UpdateRingList.tsx`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/PatchTab.tsx:529-563` (hint below the toggle box)
- Modify: `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR}/patches.json` and `.../policies.json`
- Test: `apps/web/src/components/patches/UpdateRingList.test.tsx` (create if absent — check first; PatchesPage.test.tsx may cover the list instead)

**Interfaces:**
- Consumes: `UpdateRingItem.autoApprove` now includes `thirdPartyApps?: boolean; thirdPartyDeferralDays?: number | null` (extend the local `RingAutoApprove` type at `UpdateRingList.tsx:25-29`).
- Produces: an "Auto-approve" column summarizing each ring.

- [ ] **Step 1: Write the failing test**

If `UpdateRingList.test.tsx` exists, add there; otherwise create it following `PatchList.test.tsx`'s render pattern:

```tsx
  it('summarizes auto-approve as badges: OS severities, third-party, or Manual', () => {
    // ring A: autoApprove { enabled: true, severities: ['critical','important'], thirdPartyApps: true }
    //   → getByTestId(`ring-badge-os-${a.id}`) contains 'Critical' and 'Important'; getByTestId(`ring-badge-third-party-${a.id}`) present
    // ring B: autoApprove { enabled: false, ... } → row shows the Manual label
    // ring C: autoApprove { enabled: true, severities: [], thirdPartyApps: true } → third-party badge only, no OS badge
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/web test -- UpdateRingList`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. Extend the type (lines 25-29):
```ts
export type RingAutoApprove = {
  enabled: boolean;
  severities: Array<'critical' | 'important' | 'moderate' | 'low'>;
  deferralDays: number;
  thirdPartyApps?: boolean;
  thirdPartyDeferralDays?: number | null;
};
```
2. Add the badge component next to `ComplianceBadge`:
```tsx
function AutoApproveBadges({ ring, t }: { ring: UpdateRingItem; t: TFunction<'patches'> }) {
  const aa = ring.autoApprove;
  const osOn = !!aa?.enabled && aa.severities.length > 0;
  const tpOn = !!aa?.enabled && !!aa.thirdPartyApps;
  if (!osOn && !tpOn) {
    return <span className="text-muted-foreground">{t('updateRingList.badges.manual')}</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {osOn && (
        <span
          className="inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-xs"
          data-testid={`ring-badge-os-${ring.id}`}
        >
          {t('updateRingList.badges.os', {
            severities: aa!.severities.map((s) => t(/* i18n-dynamic */ `updateRingForm.severities.${s}`)).join(', '),
          })}
        </span>
      )}
      {tpOn && (
        <span
          className="inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-xs"
          data-testid={`ring-badge-third-party-${ring.id}`}
        >
          {t('updateRingList.badges.thirdParty')}
        </span>
      )}
    </div>
  );
}
```
3. Add a header cell after Deadline (line 144): `<th className="px-4 py-3">{t('updateRingList.table.autoApprove')}</th>`, a body cell after the deadline cell (line 194): `<td className="px-4 py-3"><AutoApproveBadges ring={ring} t={t} /></td>`, and bump the empty-state `colSpan` from 8 to 9 (line 155).
4. PatchTab hint — after the toggle's closing `</div>` (line 562), inside the same `mt-6` section:
```tsx
        <p className="mt-2 text-xs text-muted-foreground" data-testid="patch-third-party-ring-hint">
          {i18n.t("policies:configurationPolicies.featureTabs.patchTab.thirdPartyRingHint")}
        </p>
```
5. Locale keys — `patches.json` `updateRingList` gains:
```json
"table": { "...existing...": "keep", "autoApprove": "Auto-approve" },
"badges": { "manual": "Manual", "os": "OS: {{severities}}", "thirdParty": "3rd-party apps" }
```
en values above; translations: de-DE `"Automatisch genehmigen"` / `"Manuell"` / `"OS: {{severities}}"` / `"Drittanbieter-Apps"`; es-419 `"Aprobación automática"` / `"Manual"` / `"SO: {{severities}}"` / `"Apps de terceros"`; fr-FR & fr-CA `"Approbation auto"` / `"Manuelle"` / `"SE : {{severities}}"` / `"Applications tierces"`; it-IT `"Approvazione automatica"` / `"Manuale"` / `"SO: {{severities}}"` / `"App di terze parti"`; pt-BR `"Aprovação automática"` / `"Manual"` / `"SO: {{severities}}"` / `"Apps de terceiros"`.
`policies.json` `configurationPolicies.featureTabs.patchTab` gains `thirdPartyRingHint`: en `"Auto-approval rules for third-party updates are configured on the linked Update Ring."`; de-DE `"Regeln zur automatischen Genehmigung von Drittanbieter-Updates werden im verknüpften Update-Ring konfiguriert."`; es-419 `"Las reglas de aprobación automática para actualizaciones de terceros se configuran en el anillo de actualización vinculado."`; fr-FR/fr-CA `"Les règles d'approbation automatique des mises à jour tierces se configurent dans l'anneau de mise à jour lié."`; it-IT `"Le regole di approvazione automatica per gli aggiornamenti di terze parti si configurano nell'anello di aggiornamento collegato."`; pt-BR `"As regras de aprovação automática para atualizações de terceiros são configuradas no anel de atualização vinculado."`

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/web test -- UpdateRingList PatchTab PatchesPage`
Expected: PASS (fix any snapshot/colSpan assertions in PatchesPage.test.tsx that counted columns).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/patches/UpdateRingList.tsx apps/web/src/components/patches/UpdateRingList.test.tsx apps/web/src/components/configurationPolicies/featureTabs/PatchTab.tsx apps/web/src/locales/*/patches.json apps/web/src/locales/*/policies.json
git commit -m "feat(web): ring auto-approve badges + PatchTab third-party ring hint"
```

---

### Task 10: Integration suite — real-Postgres proof of the new gates

**Files:**
- Modify: `apps/api/src/__tests__/integration/patchThirdPartyRingAutoApprove.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-4 (this suite runs `resolveApprovedPatchesForDevice` against real rows).

- [ ] **Step 1: Update the suite**

The file's `ringConfig(partnerId, sources, deferralDays?)` helper builds an `ApprovalEvaluationConfig` whose `autoApprove` today relies on the exemption. Rework:

1. Give the helper an explicit autoApprove parameter: `ringConfig(partnerId, sources, deferralDays?, autoApprove = { enabled: true, severities: ['critical'], deferralDays: deferralDays ?? 0, thirdPartyApps: true, thirdPartyDeferralDays: null })`.
2. Keep/adjust the existing cases (winget-shaped approval, OS severity gating unchanged, deferral hold/first-seen anchor) — they should pass with `thirdPartyApps: true` where they previously leaned on `sources` alone.
3. Add these cases:

```ts
  it('does NOT approve third-party when the ring toggle is off, even with sources third_party', async () => {
    // autoApprove { enabled: true, severities: ['critical'], thirdPartyApps: false }, sources ['os','third_party'] → []
  });

  it('does NOT approve third-party for a legacy snapshot with absent sources, even with the toggle on', async () => {
    // ringConfig with sources: undefined, autoApprove.thirdPartyApps: true → [] for the 3P patch
  });

  it('approves third-party on a third-party-only ring (empty severities)', async () => {
    // autoApprove { enabled: true, severities: [], thirdPartyApps: true }, sources ['third_party'] → 3P approved, OS patch not
  });

  it('legacy autoApprove without thirdPartyApps still approves 3P when severities were set (compat rule)', async () => {
    // autoApprove { enabled: true, severities: ['critical'] } (no thirdPartyApps key), sources ['os','third_party'] → 3P approved
  });

  it('applies thirdPartyDeferralDays over deferralDays using the first-seen anchor', async () => {
    // thirdPartyDeferralDays: 7, device_patches.created_at 3 days ago → held; 8 days ago → approved
  });
```

- [ ] **Step 2: Run the integration suite**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/patchThirdPartyRingAutoApprove.integration.test.ts
```
Expected: PASS. (Needs the local Postgres up; if it appears hung, that's the missing fsync=off tmpfs DB — see `docs`/memory note, use the project's standard integration DB setup.)

- [ ] **Step 3: Run the adjacent contract suites** (tenancy untouched, but cheap insurance since `patch_policies` data shapes changed)

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/patchApprovalEvaluatorTombstone.integration.test.ts src/__tests__/integration/patch-approval-org-scope.integration.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/patchThirdPartyRingAutoApprove.integration.test.ts
git commit -m "test(api): integration cover for dual-consent third-party ring auto-approve"
```

---

### Task 11: Full verification pass

- [ ] **Step 1: Typecheck + full unit suites**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/shared test
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
```
Expected: all green. Remember `pnpm test` ≠ CI green: the integration suites (Task 10) and RLS contract suite run separately — RLS is untouched here (no new tables/columns), but if anything in `apps/api/src/db/schema/` changed beyond comments, run `pnpm db:check-drift` again.

- [ ] **Step 2: Grep sweep — no stragglers**

```bash
grep -rn "third_party_app" apps/api/src apps/web/src --include="*.ts" --include="*.tsx" | grep -v test | grep -v migrations
grep -rn "severityFilter" apps/api/src --include="*.ts" | grep -v test
grep -rn "patchPolicies.sources\|sources: patchPolicies" apps/api/src --include="*.ts"
```
Expected: `third_party_app` remains only in the evaluator's legacy-alias comment/migration; `severityFilter` only as the deprecated alias in `CategoryRule` + its read; `patchPolicies.sources` only in the Drizzle schema definition (deprecated comment) — nowhere read or written.

- [ ] **Step 3: Commit any stragglers, then push**

```bash
git push -u origin ToddHebebrand/3rd-party-patch-update-rings
```

---

## Follow-ups (NOT in this branch)

1. **Release N+1 contract migration:** `ALTER TABLE patch_policies DROP COLUMN IF EXISTS sources;` + remove the column from `apps/api/src/db/schema/patches.ts`. File a GitHub issue when this branch's PR opens, labeled for the release after next, referencing the spec.
2. **Phase 2 `requireBreezeTested` gate** (spec §Phase 2): auto-approve only with an exact-version `third_party_release_tests` pass. Separate spec/plan.
3. **Docs:** after merge, run `/update-breeze-docs` for the patching docs (ring form gained a section; PatchTab copy changed).
