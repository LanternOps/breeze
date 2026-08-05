# Third-Party Patching as a First-Class Update Ring Auto-Approval — Design

**Date:** 2026-08-04
**Status:** Proposed
**Branch/worktree:** `ToddHebebrand/3rd-party-patch-update-rings`
**Advisor quorum:** Fable position + independent Codex (gpt-5.6, xhigh, read-only) review — agreed on
direction; Codex refinements incorporated (dual consent, source-specific kill-switch, category-rule
repairs, two-release column drop).

## Problem

MSPs cannot see or control third-party (winget/Chocolatey/Homebrew) auto-approval from the Update
Ring UI. Third-party patching is *mostly built* — same `patches`/`device_patches` pipeline, same
approval model, dedicated evaluator accommodations — but it is invisible and effectively
unconfigurable from the ring, for four compounding reasons:

1. **The source scope gate is on the config policy, not the ring.**
   `config_policy_patch_settings.sources` defaults to `['os']`
   (`apps/api/src/db/schema/configurationPolicies.ts:194`); `buildAllowedPatchSources`
   (`apps/api/src/services/patchApprovalEvaluator.ts:187`) filters third-party out **before any ring
   logic runs**. The only UI control is the "Include third-party software updates" switch buried on
   the config-policy Patch tab (`PatchTab.tsx:509-563`, restored by #2300 after #1428 deleted it).
2. **The ring's own `sources` column is dead.** `patch_policies.sources` is written by
   `routes/updateRings.ts:233,348` and read back for display, but has **no consumer in the approval
   path** — a leftover from #1428's unfinished "sources live on rings" intent.
3. **Severity is a dead axis for third-party.** Ring auto-approve is severity-driven
   (`ringAutoApproveSchema` allows only `critical|important|moderate|low`,
   `packages/shared/src/validators/index.ts:631-645`), while third-party patches ingest with
   `severity='unknown'`. The workaround — the severity-membership exemption at
   `patchApprovalEvaluator.ts:593-595` — keys off the *policy's* raw `sources` array, which the ring
   UI can neither see nor set.
4. **The ring form has no third-party control at all.** `UpdateRingForm.tsx` shows severity chips and
   category rules; nothing says "third-party apps" except a buried `third_party_app` entry in the
   category-rule picker whose severity filter is broken (see Repairs below).

Net effect: the answer to "why isn't 3rd-party in update ring auto-approvals" is *it is, but only via
an invisible exemption behind a config-policy toggle that defaults off, with zero ring-level UI*.

## Decision: authority split (settled, keep it)

- **Config policy = eligibility/scope.** "May this policy install third-party patches at all?"
  (`sources`, the existing PatchTab toggle). Stays the outer gate, default `['os']` (opt-in).
- **Update ring = positive auto-approval rules.** "Which eligible patches auto-approve, and when?"
  Third-party becomes an **explicit ring-level toggle**, not a severity exemption.
- **Dual consent is required** for third-party auto-approval — both the policy source opt-in *and*
  the ring toggle. This is deliberate defense-in-depth and also protects legacy job snapshots whose
  absent `sources` mean "no filtering" (`patchJobExecutor.ts:544-560`): without the policy-side
  check, such a job plus a permissive ring would silently widen to third-party.
- **`patch_policies.sources` is deprecated and dropped** (two-release expand/contract), not wired.
  Wiring it would create two overlapping source authorities with unexplainable intersection
  semantics.

Rejected alternatives:
- *Wire `patch_policies.sources` as the authority* — duplicates the policy control; a partner-level
  ring is linked from many policies with potentially different scopes.
- *Keep policy-only control (status quo)* — conflates "may install" with "should auto-approve";
  invisible from the ring UI, which is the reported problem.
- *Per-category-rule only (`third_party_app`)* — third-party is a first-class *source* decision;
  `third_party_app` is a virtual implementation category with (currently broken) severity semantics.

## Data model & schema changes

### `ringAutoApproveSchema` (`packages/shared/src/validators/index.ts`)

```ts
{
  enabled: boolean,
  severities: ('critical'|'important'|'moderate'|'low')[],  // OS-only, unchanged
  deferralDays: number,                                     // unchanged
  thirdPartyApps: boolean,                                  // NEW — default false on write
  thirdPartyDeferralDays: number | null,                    // NEW — null = inherit deferralDays
}
```

- Write-side refinement changes from "enabled ⇒ severities non-empty" to
  **"enabled ⇒ (severities non-empty OR thirdPartyApps)"** — this enables third-party-only rings.
- `severities` remains OS-only; **`unknown` is deliberately not added** to the enum. Third-party
  auto-approval is not severity-controlled (note: catalog enrichment can stamp a
  `defaultSeverity` on third-party rows — `thirdPartyEnrichment.ts:87` — so UI copy must say
  "not severity-controlled", not "third-party has no severity").
- `thirdPartyApps` covers sources `third_party` **and** `custom` (the `isThirdPartyPatchSource`
  bucket, `patchApprovalEvaluator.ts:176-179`) — document and test this explicitly.

No new columns: this all lives in the existing `patch_policies.auto_approve` jsonb.

### Backfill migration

One idempotent migration rewrites existing `auto_approve` jsonb rows to the explicit shape:
`thirdPartyApps = (enabled === true AND severities contains ≥1 recognized severity)`, plus the
`third_party_app` category-rule conversion described under Category-rule repairs. This preserves
today's exemption behavior exactly (the exemption only ever fired for enabled rings, and the write
schema required non-empty severities), while leaving legacy/malformed rows
(`true`, `{enabled:true, severities:[]}`) inert. Wrap the UPDATE in the `GET DIAGNOSTICS` row-count
warning pattern. Prod survey 2026-08-04: zero rings in either region have auto-approve enabled, so
the severity-derived branch is expected to touch 0 rows; the category-rule conversion touches 1.

### `patch_policies.sources` removal (expand/contract)

- **Release N:** stop writing the column; drop `sources` from ring create/update route schemas and
  responses (`updateRings.ts:101,118,182,233,348`), the AI tool contract
  (`aiToolsPolicyPrereqs.ts:183,267`), and the retained one-shot script
  (`migrateToConfigPolicies.ts:491`). Drizzle schema keeps the column marked deprecated.
- **Release N+1:** migration `ALTER TABLE patch_policies DROP COLUMN IF EXISTS sources;` + remove
  from Drizzle schema. (Same-release drop would 500 older API instances during a rolling deploy.)

## Evaluator changes (`patchApprovalEvaluator.ts`)

1. **Replace the exemption predicate with dual consent.** Third-party ring auto-approval requires:
   ```ts
   isThirdPartyPatchSource(patch.source)
     && (ringConfig.sources ?? []).includes('third_party')   // policy consent — KEEP
     && ringAutoApprove.enabled
     && ringAutoApprove.thirdPartyApps                        // ring consent — NEW
   ```
   `ringConfig.sources` here is the snapshotted *policy* sources (as today); the literal-`'third_party'`
   / expanded-bucket lockstep note at :587-592 still applies.
2. **Make the empty-severities kill-switch source-specific.** Today `enabled + severities:[]`
   approves nothing (:571-575). New semantics: OS candidates still require non-empty `severities`
   and membership; third-party candidates ignore `severities` entirely and require `thirdPartyApps`.
   A third-party-only ring (`severities:[]`, `thirdPartyApps:true`) must work.
3. **Third-party deferral:** hold window = `thirdPartyDeferralDays ?? deferralDays`, anchored on
   first-seen (`device_patches.createdAt`) as today (:626-635, #2218). Fail-closed anchor handling
   unchanged.
4. **`parseRingAutoApprove` legacy rule (fail-closed):**
   - Field **absent** (pre-backfill rows, old job snapshots — snapshots freeze `autoApprove` jsonb,
     so compatibility parsing must remain even after the backfill):
     `thirdPartyApps = severities.length > 0` (mirrors the backfill rule).
   - Field **present but malformed** (non-boolean): `false`. Same for `thirdPartyDeferralDays`
     (non-integer/negative → `null`).
   - While in there, tighten the existing fail-open wart: unrecognized severity strings are dropped
     (not silently kept), and an invalid *non-zero* `deferralDays` disables auto-approve for that
     row rather than coercing to 0 (:699-707 today coerces invalid → no deferral, which is
     fail-open).

## Category-rule repairs (pre-existing bugs, fix in the same change)

These must land with (or before) the new toggle — adding a second third-party control on top of
broken category semantics compounds the confusion:

1. **Severity field mismatch — category severity chips are inert.** The route/UI write
   `autoApproveSeverities` (`updateRings.ts:85`); the evaluator reads `rule.severityFilter`
   (`patchApprovalEvaluator.ts:27,543`), which is always `undefined` for UI-written rules → a rule
   configured "auto-approve critical only" approves **every** severity in that category (fail-open).
   Fix: evaluator reads `autoApproveSeverities` (accept `severityFilter` as a legacy alias when
   parsing stored jsonb/snapshots).
2. **Manual category rules are not terminal.** `autoApprove:false` rules fall through to ring-level
   auto-approve (:538), contradicting the UI's "manual approval required" copy
   (`UpdateRingForm.tsx:464`). Fix: a matching rule with `autoApprove:false` returns `null`
   (terminal), matching the UI contract.
3. **`third_party_app` virtual category is removed entirely** (evaluator match at :535-537, UI
   picker option, API acceptance). Prod survey (2026-08-04, both regions): **zero** rings have
   ring-level auto-approve enabled anywhere; exactly **one** ring fleet-wide (EU, "Default") has a
   `third_party_app` category rule — currently inert because its partner has no policy with
   third-party sources. The backfill migration converts stored `third_party_app` rules to the new
   shape (`thirdPartyApps=true` + `enabled=true`, `deferralDaysOverride` → `thirdPartyDeferralDays`)
   and strips them from `category_rules`, preserving intent with no behavior change. Category rules
   become OS-only. (Job snapshots frozen pre-deploy still parse; the evaluator ignores an
   unrecognized `third_party_app` rule after removal, which for the one affected ring changes
   nothing — it was inert.)

## UI rework

### `UpdateRingForm.tsx` — auto-approve section splits into two subsections

- **"Operating system updates"** — existing severity chips + deferral, unchanged behavior. Copy fix:
  deferral is anchored on vendor release date.
- **"Third-party applications"** — new toggle ("Auto-approve third-party app updates
  (winget, Chocolatey, Homebrew)"), optional deferral-days override (placeholder = ring deferral),
  and two explainer lines:
  - "Third-party auto-approval is not severity-controlled; app block/pin rules and deferral still
    apply." (replaces the current #2218 exemption note at :397-402)
  - "Applies only to devices whose configuration policy includes third-party software updates
    (Policy → Patch settings)." — with a link/hint to the PatchTab toggle. This is the critical
    cross-navigation affordance: dual consent must be *visible*, not discovered.
- Enable-state validation mirrors the new refinement: enabling auto-approve requires ≥1 severity OR
  the third-party toggle.
- Category-rule picker drops `third_party_app` from options (stored rules are migrated away by the
  backfill, so nothing legacy needs rendering).

### `UpdateRingList.tsx` / rings tab

- Per-ring auto-approve badges: e.g. `OS: critical+important · 3rd-party: on` / `off`. Today the
  list shows deferral/deadline/grace but nothing about what actually auto-approves.

### Config-policy PatchTab

- Unchanged functionally. Copy addition under the third-party switch: "Auto-approval rules for
  third-party updates are configured on the linked Update Ring." (mirror of the ring-side hint).

### Out-of-scope UI (noted, not in this change)

- An "effective status" indicator on the ring ("N linked policies include third-party") — needs a
  new aggregate endpoint; nice-to-have.
- `DevicePatchStatusTab` / compliance views already render third-party correctly.

## AI tool / MCP surface sweep

`manage_update_rings` (`aiToolsPolicyPrereqs.ts`) must gain `thirdPartyApps`/`thirdPartyDeferralDays`
in its input schema and lose `sources`; sweep `aiToolSchemas.ts`, `aiAgentSdkTools.ts`,
`mcpGuidance.ts`, `aiAgentSystemPrompt.ts`, `aiGuardrails.ts` for ring-shape references. The
evaluator's fail-closed read boundary already assumes AI-written rows can be malformed — keep it.

## Testing

- **Unit (`patchApprovalEvaluator.test.ts`):** dual-consent matrix (policy±, toggle±, enabled±);
  third-party-only ring (empty severities) approves 3P and no OS; legacy-parse rule (absent field
  with/without severities; malformed field); `custom` source included; category-rule severity alias
  + terminal-manual fixes; tightened deferral parsing.
- **Integration (`patchThirdPartyRingAutoApprove.integration.test.ts`):** update to the new flag;
  add a case proving a legacy job snapshot with absent `sources` does NOT auto-approve third-party.
- **Validators (`index_inline_settings.test.ts`):** new refinement shapes.
- **Web:** UpdateRingForm subsection render/validation; badges.

## Phase 2 (explicitly out of scope)

- **`requireBreezeTested` gate:** only auto-approve a third-party patch when
  `third_party_release_tests` has a `result='pass'` row for the **exact** source/package/version
  (`breeze_tested` alone merely opts a catalog item into testing — `wingetReleaseTestWorker.ts:21`).
- Severity/CVE-informed third-party approval (catalog `defaultSeverity`, `patches.cve_ids`).
- Ring-aware manual per-device install (`routes/devices/patches.ts:172-185` known limitation).
- Deadline/grace enforcement (stored on rings, never consumed by the executor).
- Unidentified third-party patches (missing `packageId`) bypass app rules by design (:400-408) —
  revisit if broad third-party auto-approval increases exposure.
