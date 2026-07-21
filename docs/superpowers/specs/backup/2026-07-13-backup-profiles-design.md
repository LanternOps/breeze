# Backup Profiles — Design Spec

**Status:** Implemented (branch `ToddHebebrand/backup-profiles`, 2026-07-13 — phases 1+2). Deviations: selection keys match backupModeEnum (`system_image`, not `system_state`); missing-destination job creation logs a loud worker error + UI warning instead of a failed job row (backup_jobs.config_id is NOT NULL); volumes/drive-letters remain phase 3.
**Depends on:** PR #2415 (Backup tab redesign — four-group layout; the Source group is the swap point)
**Related:** `2026-07-12-backup-tab-redesign-brief.md`, epic #2135 (partner-wide first)

## Problem

A server that needs file backups **and** System State **and** SQL backups cannot be protected today. The backup feature is one winner-take-all slot per device:

- One backup feature link per config policy (unique on `(configPolicyId, featureType)`), carrying a single `backupMode` (`file` | `hyperv` | `mssql` | `system_image`) on `config_policy_backup_settings.backup_mode`.
- `resolveBackupConfigForDevice` (`featureConfigResolver.ts:517`) and the scheduler's `resolveAllBackupAssignedDevices` (`featureConfigResolver.ts:1220`) both collapse to exactly one winning link per device (level → priority → createdAt).
- Assigning three policies (file / System State / SQL) to one server silently shadows two of them. The mode-filtered readers (`hyperv.ts:132`, `mssql.ts:137`) filter *after* the per-device dedup, so the shadowed modes vanish without any error, warning, or UI signal — three green "assigned" states, one working backup.

Separately, `backup` is **not** in `PARTNER_LINKABLE_FEATURE_TYPES` (`configurationPolicy.ts:1869`), so partner-library policies cannot carry backup links at all. The blocker is structural: the backup link's `featurePolicyId` points at an org's `backup_configs` row (storage credentials), which a partner-wide policy cannot sensibly pin.

## Proposal

Introduce **Backup Profiles** — a standalone, partner-wide-capable "selection profile" entity (Cove-style), following the update-rings precedent (Pattern A linked policy). A profile answers **what to protect** for a device class; the config policy link answers **when and where**.

The concern split:

| Concern | Entity | Ownership |
|---|---|---|
| **What** — data-source selections (Files / System State / SQL / Hyper-V), paths, exclusions, drive selection, per-source options | `backup_profiles` (new) | Dual: `org_id` XOR `partner_id` (partner-wide first, #2135) |
| **Where** — bucket/path + credentials | `backup_configs` (existing) | Org-owned (credentials justify the exception) |
| **When + keep** — schedule, retention, GFS, protection, profile choice, destination choice | backup feature link (`config_policy_backup_settings`) | Follows the config policy |

**Multi-mode composition without touching resolution semantics.** The winner-take-all hierarchy stays exactly as-is — one backup link still wins per device — but the winner's profile contains N enabled selections, and job creation fans out one job stream per selection. No per-mode resolution, no shadowing, and conflicts still resolve by the existing hierarchy *between* policies.

## Data model

### `backup_profiles` (new)

```
id              uuid PK
org_id          uuid NULL  FK organizations
partner_id      uuid NULL  FK partners
name            varchar(200) NOT NULL
description     text
selections      jsonb NOT NULL      -- see shape below
is_active       boolean NOT NULL DEFAULT true
created_by      uuid
created_at / updated_at

CHECK backup_profiles_one_owner_chk ((org_id IS NULL) <> (partner_id IS NULL))
```

RLS: ONE dual-axis policy (`system OR breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id)`) in the **same migration** that creates the table. Register in `DUAL_AXIS_TENANT_TABLES` in `rls-coverage.integration.test.ts` in the same PR.

### `selections` shape

One profile enables any subset of source types; each enabled source carries its own options. This is where Cove-parity decisions live:

```jsonc
{
  "file": {
    "enabled": true,
    "paths": ["C:\\Users"],            // explicit paths, and/or:
    "volumes": "all_fixed" | ["C:", "D:"],  // drive selection (deferred item from the tab redesign lands here; needs agent volume inventory — see Open Questions)
    "excludes": ["**/AppData/Local/Temp/**", "..."]
  },
  "system_state": { "enabled": true },
  "mssql": {
    "enabled": true,
    "backupType": "full" | "differential" | "log",
    "excludeDatabases": ["tempdb"]
  },
  "hyperv": {
    "enabled": false,
    "consistencyType": "application" | "crash",
    "excludeVms": []
  }
}
```

Validation: at least one source enabled; `file.enabled` requires paths or volumes non-empty. Zod schema in `packages/shared/src/validators/`.

### `config_policy_backup_settings` changes

- `backup_profile_id uuid NULL` FK → `backup_profiles` (new column).
- `destination_config_id uuid NULL` FK → `backup_configs` (new column — the destination reference moves here from the feature link's `featurePolicyId`, see Plumbing).
- Existing `backup_mode` / `paths` / `targets` columns stay as the **custom selection** (legacy/inline) path: when `backup_profile_id IS NULL`, behavior is exactly today's single-mode link. No data migration required at ship time.

### Feature-link plumbing

`featurePolicyId` currently points at `backup_configs`. Repoint it at `backup_profiles` (that is the thing being "linked" in `FEATURE_TABLE_MAP` semantics), and read the destination from `config_policy_backup_settings.destination_config_id`:

- `FEATURE_TABLE_MAP['backup']` → `backup_profiles`.
- Add `backup` to `PARTNER_LINKABLE_FEATURE_TYPES` and the dual-axis branch of `validateFeaturePolicyExists`.
- Write path: the tab saves `featurePolicyId = profileId` (or null for custom selection) + `inlineSettings` including `destinationConfigId`; decompose writes the two new columns.
- **Back-compat during rollout:** existing links have `featurePolicyId` = a `backup_configs` id. Resolver treats a `featurePolicyId` that resolves in `backup_configs` as a legacy destination pointer (custom selection), and one that resolves in `backup_profiles` as a profile. A follow-up backfill migration can move legacy ids into `destination_config_id` and null the link's `featurePolicyId`; until then both are honored. (Cleanup statements must RAISE row counts per migration conventions.)

## The partner-destination problem → org default destination

A partner-wide policy (or partner-wide profile) cannot pin one org's credentials. Introduce a **default backup destination** per org:

- `organizations`-scoped setting (either a `is_default` flag on `backup_configs` with a partial unique index `ON (org_id) WHERE is_default`, or an org-settings key; recommend the flag — it keeps destination semantics inside the backup domain).
- The policy link's destination choice becomes: **specific config** (org policies) or **"org default"** sentinel (`destination_config_id NULL` + profile set ⇒ resolve the device's org default at job-creation time).
- Partner-library policies with backup links MUST use "org default" (validation rejects a pinned org config on a partner-owned policy).
- Job creation fails loudly (job row with clear `errorLog`, surfaced on the backup dashboard) when a device's org has no default destination — never silently skip.

This is the unlock for partner-wide backup: partner profile ("Server") + partner policy (schedule/retention) + each org's own default destination.

## Runtime: fan-out per selection

`backupWorker` / scheduler changes:

1. Resolution unchanged: one winning backup link per device.
2. If the winner has a profile: expand to the enabled selections; create one backup job per (device, selection) with the selection's options as the job's mode+targets. Schedule/retention/protection come from the link (shared across selections).
3. If no profile (custom selection): exactly today's single-job behavior.
4. Mode-filtered readers (`hyperv.ts`, `mssql.ts`, dashboard, SLA/readiness calculators) switch from `settings.backupMode === X` to "winning link's effective selections include X" via a shared helper (`resolveEffectiveBackupSelections(link)`), so a profile-based server appears in all applicable views.

Job/agent contract is unchanged — the agent already receives per-mode commands; fan-out is API-side.

## Web UI

1. **Backup Profiles management page** (like Update Rings): list + editor with per-source sections, "All orgs" badge for partner-wide, create-only `ownerScope` selector (pattern: `PolicyForm.tsx`). **Confirmed 2026-07-13:** starter profiles are *templates at creation* (template cards pre-fill the editor; the tech names and saves their own copy — no seeded magic rows), and the editor is a *flat list* — all four sources always visible with enable toggles, options expanding under enabled ones (Cove-style). The OS quick-start presets from #2415 become the template contents; the tab's preset cards remain for custom selection.
2. **Backup tab Source group** (built as a swappable unit in #2415): mode toggle at top — **"Use a profile"** (radio-card picker, same pattern as destination cards, with inline "New profile" for org-scoped quick creation) vs **"Custom selection"** (current per-type UI). Profile card shows enabled sources as chips + owner badge.
3. **Destination group**: adds a "Use org default" option; shows which config is the org default; partner-owned policies lock to org-default.
4. **Effective config / device backup views**: show profile name + expanded selections; warn when the org default destination is missing.

## AI tools / MCP

- `manage_backup_profiles` (tier 2) + list/get (tier 1), registered alongside `manage_backup_configs`.
- `manage_policy_feature_link` docs updated: `featurePolicyId` = profile id; `inlineSettings.destinationConfigId` documented; the 15-feature-types shape reference in `aiToolsConfigPolicy.ts` updated.
- `get_backup_status` / SLA tools updated to be selection-aware (a server is "protected" per selection, not per single mode).

## Testing (per repo playbook)

- `rls-coverage`: register `backup_profiles` in `DUAL_AXIS_TENANT_TABLES`.
- `backupProfilesPartnerRls.integration.test.ts`: cross-partner forge 42501, XOR 23514, org isolation, partner fan-out fires against real Postgres.
- Fan-out integration test: one profile with 3 selections → 3 jobs per device; org-default destination resolution; loud failure when default missing.
- Resolver unit tests: legacy `featurePolicyId`→`backup_configs` links still resolve (back-compat); winner-take-all unchanged with profiles present.
- Tab tests: profile picker, custom-selection fallback, partner-policy destination lock.
- Sweep ALL `backupMode`/`featurePolicyId` call sites repo-wide before calling it done (hidden readers: dashboard, readiness, criticality, SLA worker, hyperv/mssql routes, AI tools) — playbook step 7.

## Phasing

1. **Phase 1 — entity + org-scoped:** `backup_profiles` table (dual-axis schema from day one, but UI exposes org scope only), CRUD, profile picker in the tab, worker fan-out, mode-filtered reader updates. Ships multi-mode servers.
2. **Phase 2 — partner-wide:** org default destination, `PARTNER_LINKABLE_FEATURE_TYPES` + dual-axis validation, ownerScope UI + "All orgs" badge, partner RLS suite. Ships "define Server once, apply everywhere."
3. **Phase 3 — cleanup:** backfill legacy `featurePolicyId` destinations into `destination_config_id`; volumes/drive-letter selection once the agent reports volume inventory.

**Confirmed 2026-07-13: phases 1 and 2 ship together** (org + partner-wide, org default destination, partner-linkable backup in one pass). The phase boundary above is kept only as a fallback decomposition if the combined PR grows unwieldy. Phase 3 (legacy backfill, drive-letter volumes) remains a follow-up.

## Open questions

1. **Drive selection semantics** (`volumes: "all_fixed"`): needs the agent to enumerate fixed volumes at job time (`extractVolumes` exists in `agent/internal/backup/backup.go` for VSS but volume inventory isn't reported to the API). Phase 3; profile schema reserves the field now so profiles don't need a shape migration later.
2. **Per-selection schedule overrides?** Cove allows e.g. SQL log backups hourly while files run nightly. Out of scope for v1 (one schedule per link); if needed later, add optional per-selection schedule overrides in the profile. Flagging so the jsonb shape can accommodate it without migration.
3. **`hyperv` in a "Server" profile:** Hyper-V backups are only meaningful on hosts; including it in a broadly-assigned profile is harmless (no VMs discovered → no jobs) but may create noisy "skipped" jobs. Decide whether job creation skips selections with zero discovered targets silently or records an informational skip.
4. **Profile deletion:** block when referenced by any feature link (RESTRICT + friendly 409 listing referencing policies), matching update-ring behavior.
