# Ring-Owned Patch Approval Rules (finish the WHEN/WHERE vs WHAT split) — Design

**Date:** 2026-10-06
**Status:** Proposed (plan drafted; awaiting approval)
**Issue:** LanternOps/breeze#1317
**Plan:** `docs/superpowers/plans/vuln-patch/2026-10-06-ring-owned-approval-rules.md`
**Predecessors:** PR #1355 (phase 1: typed ring `autoApprove`), `2026-06-11-patch-policy-auto-approve-and-app-rules-design.md`
(policy-level `apps[]` + policy auto-approve), `2026-06-21-org-independent-partner-scoped-update-rings-design.md`
(rings → partner axis), `2026-08-04-third-party-update-ring-auto-approve-design.md` (ring `thirdPartyApps`, dual consent).

## Target model (unchanged from the issue)

- **Configuration Policy = WHEN and WHERE**: `sources`, schedule, reboot, offline behaviour, exclusive
  Windows Update, and the ring link (`featurePolicyId`).
- **Update Ring = WHAT**: auto-approve (severities, deferral, third-party, unrated), category
  include/exclude, category rules, and **per-app block/pin rules**.
- **No ring linked → manual approval only.**

Decisions already recorded on the issue (Todd, 2026-09-22): the auto-approve deferral stays a distinct
field (it is `autoApprove.deferralDays` on the ring, separate from the ring's rollout `deferralDays`);
sources stay policy-side; app rules get a **dedicated `app_rules` column**; rollout is dual-read —
write both → cut reads over → drop the old field.

## What is already done on main (verified against `origin/main` @ 9b9f3fc28d)

| Item from #1317 | State | Evidence |
|---|---|---|
| Typed ring auto-approve JSONB (`enabled`, `severities`, `deferralDays`, + `thirdPartyApps`, `thirdPartyDeferralDays`, `autoApproveUnrated`) | **Done** | `packages/shared/src/validators/index.ts:639-673` (`ringAutoApproveSchema`); `apps/api/src/routes/updateRings.ts:128,144` |
| Ring auto-approve editor in the web UI | **Done** | `apps/web/src/components/patches/UpdateRingForm.tsx:20-52` |
| Category include/exclude + category rules on the ring | **Done** | `apps/api/src/db/schema/patches.ts:168-170`; `UpdateRingForm.tsx:275` |
| Rings + approvals partner-scoped | **Done** | `patches.ts:150` (`partner_id NOT NULL`, no `org_id`), `patches.ts:178,190-194` |
| "No ring → manual only" (policy-level auto-approve fallback removed from the decision) | **Done** — the evaluator returns `no_ring_resolved` | `apps/api/src/services/patchApprovalEvaluator.ts:393-396`; doc comment `:88-95` says `policyAutoApprove` is "still snapshotted and threaded, but NOT consulted" |
| Policy auto-approve UI removed from the Patch tab | **Done** (render) — state still carried and saved | `apps/web/src/components/configurationPolicies/featureTabs/PatchTab.tsx:29-32,48-51,312-348` |
| `patch_policies.sources` dropped | **Done** | `apps/api/migrations/2026-08-14-drop-patch-policies-sources.sql` |
| Legacy `ring_id IS NULL` approvals | **Resolved by design** — they are partner-wide blanket approvals honoured under every ring | `patches.ts:190-194`, 06-21 design |
| Agent back-compat | **No agent surface** — the Go agent reads no approval / app-rule fields; approval is resolved server-side before `install_patches` dispatch | grep of `agent/**/*.go` for `autoApprove|appRule|policyAutoApprove` finds nothing patch-related |

## What remains

1. **Per-app block/pin rules are still policy-owned and LIVE.** They live only in
   `config_policy_feature_links.inline_settings->'apps'` (no column; `configPolicyPatching.ts:335-345`),
   are threaded as `config.apps` (`patchEligibility.ts:441-444`) and snapshotted into
   `patch_jobs.patches.apps` (`patchJobSnapshot.ts:70`), and are enforced for every job approval path,
   ring or not, overriding manual approvals (`patchEligibility.ts:236-262`). Moving them is the only part
   of this work that changes where a *live* rule is stored, so it carries the data migration.
2. **Policy-level auto-approve is dead data still exposed on several surfaces.**
   `config_policy_patch_settings.auto_approve` / `auto_approve_severities`
   (`configurationPolicies.ts:297-333`) and inline `autoApproveDeferralDays` are still validated
   (`patchInlineSettingsSchema`, `validators/index.ts:732-768`), loaded, snapshotted as
   `policyAutoApprove`, exported through the partner API (`routes/partnerApi/configuration.ts:47-61`,
   and the SQL projection in `migrations/2026-10-13-100300-patch-offline-behavior-export-projection.sql:64-65`),
   and **written by the `setup_auto_approval` AI tool** (`services/aiToolsFleet.ts`, which defaults
   `autoApprove: true` with `['critical','important']`) — a tool that today reports success for a setting
   the evaluator ignores.
3. **No ring-side app-rule surface**: no column, no route field, no AI-tool field, no UI.

## Design

### Storage

- New column `patch_policies.app_rules jsonb NOT NULL DEFAULT '[]'` with a `jsonb_typeof = 'array'`
  CHECK. Element type is the existing `policyAppRuleSchema` (`validators/index.ts:602-616`); the list
  schema is a new `ringAppRulesSchema` = `z.array(policyAppRuleSchema).max(200)` + uniqueness by the
  evaluator's canonical key (`appRuleKey`: `third_party`/`custom` collapse to one bucket, packageId
  lowercased).
- Tenancy: `patch_policies` is shape 3 (partner axis, `rls-coverage` `PARTNER_TENANT_TABLES`), has no
  `org_id` and no `device_id`, and is not in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry`, or
  `CORE_TENANT_EXPORT_POLICY` (verified by grep). Adding a column changes none of these registrations.
  Partner deletion is covered by the partner-axis sweep. If `patch_policies` is ever added to the export
  registry, `app_rules` is `excludedOpen` (jsonb).
- Not a new config table, so Partner-Wide-First does not apply; rings are already partner-level.

### Evaluation

- `PatchRingResolution` gains `appRules`; `ApprovalEvaluationConfig` gains `ringAppRules`.
- **Dual-read window (W01 → W02):** app rules from the ring and from the policy are both evaluated; a
  candidate is denied if *either* map's verdict is not `allowed` (worst-verdict wins: `blocked` >
  `held` > `allowed`). Before the backfill the ring list is always empty, so this changes nothing.
- **After cutover (W02):** only ring app rules are read. Same position in the pipeline (after source and
  category filters, before manual approvals), same "overrides manual approval in the job flow"
  semantics, same allow-with-warn for unidentified third-party patches. A policy with no ring has no app
  rules — consistent with "no ring → nothing but manual approvals"; the backfill guarantees no
  currently-blocked app becomes unblocked by giving every ring-less policy that has rules its own ring.
- **Job snapshot:** new key `ringAppRules`. From W02 on, the snapshot writes ring rules into
  **both** `ringAppRules` and the legacy `apps` key, so an executor from before W01 (rolling deploy)
  still enforces them. The executor keeps parsing both keys indefinitely (frozen snapshots), with the
  existing fail-closed coercion (malformed-but-identifiable → `block`). W04 stops writing `apps`.

### Data migration (W02)

For every authored `config_policy_feature_links` row with `feature_type = 'patch'` and a non-empty
`inline_settings->'apps'`, normalise the list exactly as the runtime does
(`normalizeStoredInlineSettingsWithSalvage`: drop entries `policyAppRuleSchema` rejects, last entry wins
per canonical key), then:

| Link state | Action |
|---|---|
| **A. No ring** (`feature_policy_id IS NULL`) | Create a ring (partner = the policy's `partner_id`, else its org's partner) named `"<policy name> — app rules"`, `auto_approve = '{}'` (approves nothing), every other column at its default, `app_rules` = the list; set the link's `feature_policy_id` to it. Behaviour is unchanged: manual approvals still apply, auto-approve still approves nothing, schedule is policy-side, the ring's empty category filters filter nothing, and the patch scheduler does not read ring scheduling fields (`patchSchedulerWorker.ts` reads only `settings.schedule*`). |
| **B. Ring R, every link to R carries the same rule set** | `R.app_rules` = that set. |
| **C. Ring R shared by links with different sets** | R keeps the set of links with **no** rules if any exist (so they are unaffected), else the most common set. Every other distinct set gets a **clone** of R (all columns copied, name `"<R name> — <policy name>"`), R's ring-scoped `patch_approvals` copied to the clone, and those links relinked. Every linked policy keeps exactly the rules it has today. |
| **D. Link points at an invalid ring reference** | Skip; `RAISE WARNING` the count (the scheduler already skips such policies). |
| **R already has non-empty `app_rules`** | Skip that ring's links; `RAISE WARNING` (only possible if a ring writer ran before the backfill — W01 adds no writer). |

Idempotent without marker keys: a link is processed only when its normalised rules differ from its
resolved ring's `app_rules`, so a second run finds nothing to do. The policy-side `apps` key is left in
place until W04 so pre-W02 instances keep enforcing during the rolling deploy. Every write reports its
row count via `GET DIAGNOSTICS … RAISE WARNING`, and the file elects `breeze.scope = 'system'` before
any write.

Policy-level auto-approve is **not** converted into rings: it has not affected any decision since the
evaluator stopped consulting it, so creating enabled rings from it would *start* auto-approving patches
that are approved manually today. The migration only reports the count of ring-less links with
`auto_approve = true` (see Open Decision 1).

### Write surfaces

- `/update-rings` create/update and `manage_update_rings` accept and return `appRules`
  (`ringAppRulesSchema`). Ring writes already require partner-wide permission
  (`canManagePartnerWidePolicies`) and `manage_update_rings` writes are already approval-gated.
- From W02, config-policy patch writes reject a **changed** `apps` list or `autoApprove: true` with a
  400 whose message names the Update Ring as the new home; an unchanged round-trip from an old client
  is accepted and ignored (see Open Decision 4).
- `setup_auto_approval` is retargeted to create or update an Update Ring and link it (Open Decision 2).
- `manage_policy_feature_link` / the `aiToolsConfigPolicy.ts` patch shape stop advertising `apps` and
  `autoApprove*`.

### Web

- `UpdateRingForm.tsx` gains an "Application rules" section (moved `PatchAppRulesSection`, bound to
  `appRules`); `UpdateRingList.tsx` shows an app-rule count badge.
- `PatchTab.tsx` drops the `autoApprove*` / `apps` state and the app-rules section, and stops sending
  them; the ring picker shows a hint that approval and app rules are edited on the ring.
- `DeviceEffectiveConfigTab.tsx` stops showing the policy auto-approve row ("unused") and shows app rules
  from the ring.

### Contract (W04, one release after W02/W03)

- Drop `config_policy_patch_settings.auto_approve` and `auto_approve_severities`.
- Re-create `breeze_partner_export_policy_settings_pre_patch` without those keys (full body reproduced
  from `2026-10-13-100300`, with the REVOKE/GRANT block re-emitted), and remove them from
  `PATCH_NORMALIZED_MATERIAL_KEYS` in the same PR — exact-membership check
  (`canonicalizePolicyPatchSettings`).
- Strip `apps`, `autoApprove`, `autoApproveSeverities`, `autoApproveDeferralDays` from stored
  `inline_settings` (row-count reported) and from `patchInlineSettingsSchema`.
- Remove `policyAutoApprove` from `ApprovalEvaluationConfig`, the snapshot, and the device view; the
  executor keeps ignoring the legacy key in old snapshots.

## Settings accounting (CLAUDE.md rule 9)

| Concept | Home after | Level | Resolver | Places configured before → after |
|---|---|---|---|---|
| Per-app block/pin | Update Ring | Partner | `resolvePatchPolicyReference` → `ring.appRules` | 1 (policy Patch tab) → 1 (ring form) |
| Auto-approve | Update Ring | Partner | `parseRingAutoApprove` | 2 (ring form + dead policy fields via API/AI) → 1 |

**Level change:** app rules move from a setting an org-scoped user could edit on an org-owned policy to a
partner-level ring. Org-scoped users can no longer author app rules (consistent with the 06-21 decision
that rings are partner-admin only). See Open Decision 3.

## Out of scope

- An allowlist mode for app rules, exact-version installs, and deadline/grace enforcement (unchanged from
  earlier specs).
- Making the `/patches/app-options` picker partner-wide; it stays as is, and the ring form keeps the
  manual `(source, packageId)` entry fallback (Open Decision 5).
