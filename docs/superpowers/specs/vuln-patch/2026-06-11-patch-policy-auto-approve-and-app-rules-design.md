# Patch Policy Auto-Approve Wiring + Per-App Rules (Phase 3) — Design

**Date:** 2026-06-11
**Status:** Approved
**Predecessors:** PR #1269 (`docs/superpowers/plans/vuln-patch/2026-06-11-third-party-patch-sources.md`), May third-party patching plan (`docs/superpowers/plans/vuln-patch/2026-05-13-windows-third-party-patching.md`)

## Context

PR #1269 shipped enforced `sources` filtering in the patch approval evaluator and the Patch Sources UI, but deliberately did **not** ship the policy-level auto-approval UI: `autoApprove`/`autoApproveSeverities` exist in `patchInlineSettingsSchema` (`packages/shared/src/validators/index.ts:456-457`) and round-trip through the Patch tab, yet no job-creation path reads them — auto-approval comes only from the linked update ring, and ring-less policies are manual-approval-only by evaluator design (`patchApprovalEvaluator.ts`: `if (!ringConfig.ringId) return null` for non-manual paths).

This design covers both parked follow-ups as one combined effort:

1. **Policy-level auto-approve wiring**, including the safety decision on ring-less policies.
2. **Phase 3 of the gap analysis**: per-app allow/block lists, version pinning, catalog picker. The `third_party_package_catalog` table, seed data, and CRUD routes already exist (`apps/api/src/db/schema/thirdPartyCatalog.ts`, `apps/api/src/routes/thirdPartyCatalog/`).

## Decisions (settled during brainstorming)

| Question | Decision |
|---|---|
| Scope | Both follow-ups, one combined effort / one PR |
| Ring-less auto-approve | **Allowed.** Policy fields govern when no ring is linked; a linked ring takes full precedence (policy fields ignored, UI says so explicitly) |
| Per-app list model | **Blocklist on top of sources** — default is everything the selected sources allow; no allowlist mode |
| Version pinning | **Hold-at-version** — evaluator excludes patches whose target version exceeds the pin; no agent changes |
| Picker data source | Curated catalog + observed org patches + manual `(source, packageId)` entry |
| Storage | Extend the inline-settings JSON (`patchInlineSettingsSchema`), same path `sources` took — no new tables, no RLS work |

## Design

### 1. Schema (`packages/shared/src/validators/index.ts`)

Extend `patchInlineSettingsSchema`:

```ts
autoApproveDeferralDays: z.number().int().min(0).max(60).default(0),
apps: z.array(z.object({
  source: z.string().min(1).max(64),          // patches.source value, e.g. 'winget', 'homebrew'
  packageId: z.string().min(1).max(256),
  displayName: z.string().max(255).optional(), // snapshot for UI; identity is (source, packageId)
  action: z.enum(['block', 'pin']),
  pinnedVersion: z.string().max(64).optional(),
})).max(200).default([]),
```

`superRefine` additions: `action: 'pin'` requires `pinnedVersion`; entries unique by `(source, packageId)`. Existing `autoApprove`/`autoApproveSeverities` fields and their cross-field refinement are unchanged. All new fields default to no-op values, so existing stored settings parse unchanged.

### 2. Job creation (`routes/configurationPolicies/patchJobs.ts`, `jobs/patchSchedulerWorker.ts`)

Both job-creation paths snapshot the same `patches` JSONB today (`{ ringId, ringName, categoryRules, autoApprove: ring.autoApprove, sources, ringValidation }`). Add:

```ts
policyAutoApprove: {
  enabled: settings.autoApprove,
  severities: settings.autoApproveSeverities,
  deferralDays: settings.autoApproveDeferralDays,
},
apps: settings.apps,
```

Namespacing under `policyAutoApprove` keeps it unambiguous next to the existing ring-level `autoApprove` key.

### 3. Executor (`jobs/patchJobExecutor.ts`)

Extract the new keys with the same malformed-data posture as `sources`: absent → undefined (legacy job, no behavior change); present-but-malformed → ignore that key **loudly** (`console.warn`) rather than guessing. For `apps`, drop individual malformed entries with a warn; for `policyAutoApprove`, malformed → treated as disabled (fail-closed — the dangerous direction is silently widening installs, same reasoning as the sources handling at `patchJobExecutor.ts:373-388`).

`RingConfig` keeps its name (renaming would churn every call site for no behavior change; its doc comment gains a note that it now also carries policy-level config) and gains:

```ts
policyAutoApprove?: { enabled: boolean; severities: string[]; deferralDays: number };
apps?: PolicyAppRule[];
```

### 4. Evaluator (`services/patchApprovalEvaluator.ts`)

**App rules filter (applies first, to all approval paths).** After the existing source filter, exclude candidates matching an app rule by `(source, packageId)`:

- `block` → always excluded from the job flow, **including manually-approved patches** — consistent with how source filtering already excludes manually-approved third-party patches in an os-only job (PR #1269 semantics). Manual per-device install (`POST /devices/:id/patches/install`) remains unaffected.
- `pin` → excluded when `compareVersions(patch.version, pinnedVersion) > 0`. `patches.version` exists (`db/schema/patches.ts:116`).
- Exclusions logged like the existing source-exclusion warning.

**Version comparator.** New exported `comparePatchVersions(a, b)`: tolerant numeric/alphanumeric segment comparison (split on `.`/`-`/`+`; numeric segments compared numerically, non-numeric lexicographically) — winget/homebrew versions are not strict semver. If either side is missing/unparseable, the patch is **held** (treated as exceeding the pin) with a `console.warn` — fail-closed matches pin intent.

**Policy auto-approve path.** In `evaluatePatchApproval`, replace the bare ring-less early-return:

```
Priority 1: manual approval                      (unchanged)
If ringId is null:
  → if policyAutoApprove.enabled
       AND patch.severity ∈ policyAutoApprove.severities
       AND deferral window (deferralDays vs patch.releaseDate) has passed
     → 'policy_auto_approve'
  → else null
Priority 2/3: category rule / legacy auto-approve (unchanged, ring-linked only)
```

When a ring **is** linked, `policyAutoApprove` is never consulted — ring precedence is absolute. A patch with `severity: null` never matches the severity list (no silent widening). New `approvalReason` value `'policy_auto_approve'` added to `ApprovedPatch` and anywhere reasons are displayed/audited.

### 5. Picker endpoint (`routes/patches/`)

Lives under `apps/api/src/routes/patches/` (it merges org-scoped patch data; `routes/thirdPartyCatalog/` stays pure system-catalog CRUD).

`GET /patches/app-options?search=&limit=` (org-scoped): merges

1. `third_party_package_catalog` rows (source, package_id, vendor, friendly_name), and
2. distinct observed `(source, packageId, vendor, title)` from the org's `patches` rows where source is third-party,

deduped by `(source, packageId)` (catalog metadata wins), filtered by case-insensitive search over name/vendor/packageId, capped (~50). Standard auth + org scoping; observed query runs under the request's RLS context as usual.

### 6. Web UI (`components/configurationPolicies/featureTabs/PatchTab.tsx`)

- **Automatic Approval section restored — now wired.** Toggle + severity checkboxes + deferral-days input bound to the schema fields. When the policy has a linked update ring (directly or inherited), the section renders disabled with copy: *"Automatic approval is governed by the linked update ring ‹name›. These settings apply only when no ring is linked."* This addresses the looks-configured-but-does-nothing trap that got the earlier UI reverted (a185f8fb).
- **Application Rules section (new).** List of block/pin entries with action badge and pinned version; add-flow opens a picker (search against the new endpoint, manual-entry fallback for `(source, packageId)`); pin entries get a version input. Saves through the existing inline-settings payload; mutations already flow through `runAction` via the tab's save handler.
- If `PatchTab.tsx` grows unwieldy, extract `PatchAppRulesSection.tsx` / `PatchAutoApproveSection.tsx` (CLAUDE.md file-size guidance — split for clarity, not line count).

## Compatibility

- All new schema fields default to no-op values; existing policies and stored settings are unaffected until an admin opts in.
- Legacy jobs (no `policyAutoApprove`/`apps` keys in JSONB) behave exactly as today.
- No migrations, no RLS changes, no agent changes.

## Testing

- **Evaluator** (extend `patchApprovalEvaluator.test.ts`): policy auto-approve approves ring-less matching patch; ring-linked ignores policy fields entirely; severity not in list / null severity → no approval; deferral window blocks until elapsed; block rule excludes even manually-approved patch; pin holds greater version, allows equal/lesser; unparseable version → held + warned; comparator table-driven cases (numeric, mixed, missing segments); combined sources + apps + auto-approve flow.
- **Executor** (extend `patchJobExecutor.test.ts`): threads `policyAutoApprove`/`apps` to evaluator; malformed `policyAutoApprove` → disabled + warn; malformed `apps` entries dropped + warn; absent keys → undefined.
- **Validators**: new field defaults; pin-requires-version; duplicate `(source, packageId)` rejected; existing autoApprove refinement still holds.
- **Picker route**: merge/dedup/search behavior, org scoping.
- **PatchTab component tests**: auto-approve section wired into save payload; ring-linked disabled state + notice; app rules add/remove/pin flows; stored-settings round-trip still preserved.
- Per `breeze-testing` skill conventions throughout.

## Out of scope

- Exact-version installs / downgrades (agent command changes).
- Allowlist mode for app rules.
- Compliance view treating unmanaged third-party-missing as informational.
- `firmware`/`drivers` sources (no agent provider).
- Agent-side honoring of the `patch_scan` source parameter.
