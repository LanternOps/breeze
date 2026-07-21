# OneDrive Helper — Provisioning + Library Sync (Sub-project A) — Design Spec

**Date:** 2026-06-19
**Status:** Approved (brainstorm) — pending implementation plan
**Author:** Todd Hebebrand + Claude

## Summary

A new **OneDrive Helper** capability in Breeze RMM that does reliably what
Intune does badly: silently mount the right SharePoint document libraries to
each Windows user based on their group membership, manage the foundational
OneDrive configuration those mounts depend on, and give the MSP the visibility
into mount/backup state that Intune never surfaces.

It ships as a new **configuration-policy feature** (`onedrive_helper`) so it
inherits the existing partner → org → site → device_group → device assignment
and priority-merge model. Windows-only behavior; a no-op build on macOS/Linux.

The overall product is **two sub-projects**, built in order:

| | **Sub-project A — Provisioning + Library Sync** (this spec) | **Sub-project B — Sync Health** (later spec) |
|---|---|---|
| Job | Mount the right libraries per user + own base OneDrive config + report state | Detect / fix / alert on sync problems, nudge end users |
| Depends on | M365 Graph, agent registry/hive writes, config policy | Agent state collection, alert engine, script/remediation, Breeze Helper |

**This spec covers Sub-project A only.** Sub-project B is summarized under
[Deferred to Sub-project B](#deferred-to-sub-project-b).

## Scope decisions (from brainstorm)

- **Group source is flexible, per library:** each library mapping is targeted by
  one of `everyone` (ungated) · `graph_group` (Entra/M365 group via Graph) ·
  `local_ad_group` (on-prem/hybrid, resolved on the device). The manual-list
  mode (paste a library, apply to everyone) is the `everyone` case — i.e. the
  Intune `AutoMountTeamSites` equivalent, but delivered and self-healed
  reliably.
- **Membership resolution is split by where the data lives:** `graph_group`
  gates are resolved **server-side** (Graph credentials stay in the API);
  `local_ad_group` gates are resolved **agent-side** from the local token;
  `everyone` always applies.
- **Own base config too:** the helper manages `SilentAccountConfig`,
  `FilesOnDemandEnabled`, tenant association, and **Known Folder Move**
  (`KFMSilentOptIn` + folder set; optional `KFMBlockOptOut`). Rationale: a
  `TenantAutoMount` key does nothing unless OneDrive is already silently
  signed in with Files On-Demand — in the messy tenants where the MSP looks
  bad today, *that* is usually what's broken, not the library list.
- **Additive-only mounting in v1:** when a user leaves a group, the helper
  stops enforcing that library; it does **not** silently unmount (AutoMount is
  one-way and there is no clean silent unmount). Entitlement drift
  ("mounted but no longer entitled") is surfaced in reporting. An explicit,
  gated unmount action is deferred to Sub-project B.
- **Reporting is first-class in v1:** per-device and org-level rollup of
  signed-in / FOD / KFM-redirection / mounted-vs-entitled / drift. This
  visibility is roughly half the value over Intune.
- **KFM is a health check, scoped two ways:** v1 (A) **enforces** KFM in base
  config and **reports** known-folder redirection state. Alerting on KFM
  backup *failures* rides with Sub-project B.

## Existing platform building blocks this relies on

| Concern | Reuse from |
|---|---|
| Per-org M365 tenant connection, OAuth client-credentials, admin consent | `apps/api/src/services/c2cM365.ts`, `apps/api/src/routes/c2c/m365Auth.ts`, `apps/api/src/db/schema/m365.ts` |
| Direct Graph calls (client-credentials token → Graph endpoints) | `apps/api/src/services/m365DirectGraph.ts` |
| Policy definition, feature links, hierarchical assignment + priority merge | `apps/api/src/db/schema/configurationPolicies.ts`, `apps/api/src/services/configurationPolicy.ts`, `apps/api/src/routes/configurationPolicies/crud.ts` |
| Config delivery to agent (`ConfigUpdate` in heartbeat) | `agent/internal/heartbeat/heartbeat.go` |
| Windows registry read/write | `golang.org/x/sys/windows/registry` (see `agent/internal/collectors/software_windows.go`) |
| Logged-in user / SID / session resolution | `agent/internal/sessionbroker/session.go`, `agent/internal/collectors/sessions.go` |
| PowerShell / user-context execution | `agent/internal/procoutput/shell_windows.go`, `agent/internal/executor/executor.go` |
| Alerts (state reported by agent, raised server-side) | `apps/api/src/services/alertService.ts`, `apps/api/src/db/schema/alerts.ts` |

## Architecture

### 1 · Server data model

New tables (org-scoped). **RLS is mandatory** and must ship in the same
migration that creates each table, with the allowlist + cascade-list updates in
the same PR (see [Tenancy / RLS](#tenancy--rls)).

- **`onedrive_helper_settings`** (policy-linked, one row per `onedrive_helper`
  feature link): base-config toggles — `silentAccountConfig`,
  `filesOnDemandEnabled`, `tenantAssociationId`, `kfmSilentOptIn`,
  `kfmFolders` (Desktop/Documents/Pictures subset), `kfmBlockOptOut`,
  OneDrive restart behavior on key change.
- **`sharepoint_library_mappings`** (policy-linked, N per policy): the composite
  `libraryId` (the `AutoMountTeamSites` value), `displayName`, `siteUrl`, Graph
  refs (`siteId` / `webId` / `listId`), `targetingMode`
  (`everyone | graph_group | local_ad_group`), `groupId` / `groupName`,
  `hiveScope` (`hkcu | hklm`).
- **`onedrive_device_state`** (agent-reported, **device-scoped → denormalized
  `org_id`**, hot write path): `signedIn`, `oneDriveVersion`,
  `filesOnDemandOn`, `kfmFolderStates`, `mountedLibraries[]`,
  `entitledLibraries[]`, `driftEntries[]`, `lastReportedAt`.

### 2 · Server Graph integration (extend `m365DirectGraph.ts`)

- `listSharePointLibraries(orgId)` → tenant sites + document libraries, powering
  the **library picker** in the UI (the Intune-killer: browse instead of pasting
  a cryptic ID).
- `resolveUserGroupMembership(orgId, upn)` → `/users/{upn}/memberOf` group ids,
  for `graph_group` targeting.
- *(optional, recommended)* `userCanAccessLibrary(orgId, upn, libraryRef)` —
  pre-mount access check so we don't manufacture sync errors by mounting a
  library the user has no SharePoint permission to.

### 3 · Config delivery / heartbeat

- The effective `onedrive_helper` config is computed per device and delivered in
  the heartbeat `ConfigUpdate`. For the device's reported logged-in user(s), the
  API **pre-resolves `graph_group` gates** (tagging each library allow/deny per
  SID/UPN); `local_ad_group` rules pass through for the agent to evaluate;
  `everyone` always applies.
- The agent reports `onedrive_device_state` back on each heartbeat.

### 4 · Agent applier — new package `agent/internal/onedrivehelper` (Windows build tag)

- Resolve active sessions via `sessionbroker` → SID + UPN. UPN source: read from
  OneDrive's own account registry (`HKCU\Software\Microsoft\OneDrive\Accounts\*`
  `UserEmail`), fallback to `whoami /upn` in user context.
- Write **base config** to `HKLM\SOFTWARE\Policies\Microsoft\OneDrive`.
- For each active user session: compute the effective library list (server-tagged
  Graph allows + locally-evaluated AD groups + `everyone`) and write
  `TenantAutoMount` keys into `HKU\<SID>\SOFTWARE\Policies\Microsoft\OneDrive\TenantAutoMount`.
- **Verify *real* mount state** (read OneDrive's `Accounts\Business1` tenants /
  scope cache), not just key presence. This handles the documented trap that
  OneDrive will **not** re-mount a library the user previously stopped syncing:
  rather than rewriting the key forever, record it as **drift**.
- Idempotent self-heal each cycle; gently signal/restart OneDrive when keys
  change.
- macOS/Linux: no-op behind build tags.

### 5 · Web UI

- **Policy editor:** base-config toggles (silent sign-in, FOD, KFM folders);
  library list with the **Graph picker** when a tenant is connected, or manual
  paste when it isn't; per-library targeting (everyone / Graph group / AD group
  name).
- **Per-device OneDrive panel:** signed-in, FOD, KFM folder redirection,
  mounted-vs-entitled libraries, drift flags.
- **Org rollup:** who's entitled to what, mount success, drift, and a
  "KFM not protected" list.

### 6 · De-risking spike — do this FIRST in the implementation plan

Validate that Graph `siteId` / `webId` / `listId` can construct a
`TenantAutoMount` library ID that OneDrive **actually mounts**. The AutoMount
value is a composite (`tenantId&siteId&webId&listId&webUrl&…`), not a plain URL,
and it is not yet proven that Graph's IDs map cleanly to that exact format.

- **If clean:** the Graph library picker is viable as designed.
- **If not:** fall back to assisted "Copy library ID" capture (operator pastes
  the ID OneDrive's sync client produces), and the picker becomes a
  nice-to-have.

This spike gates the picker UX, so it runs before the rest of the build is
committed.

## Tenancy / RLS

Per `CLAUDE.md` + the RLS-coverage contract test:

- `onedrive_helper_settings`, `sharepoint_library_mappings` — org-scoped
  (Shape 1, direct `org_id`) or policy-scoped resolving to org; RLS policies in
  the creating migration.
- `onedrive_device_state` — device-id scoped hot write path → **denormalize
  `org_id`** (Shape 5, Phase 1–4), with `breeze_has_org_access(org_id)` policy.
- Update the relevant allowlists in
  `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` and the
  cascade-delete lists (`core.ts` device-delete + `tenantCascade.ts`
  `ORG_CASCADE_DELETE_ORDER`, alpha-ordered via `localeCompare`) in the same PR.
- Verify a forged cross-tenant insert fails as `breeze_app` before merging.

## Carried risks (track through implementation)

1. **Library-ID format** — top technical risk; gated by the §6 spike.
2. **User-declined-library won't re-mount** — handled by real-mount-state
   detection + drift flagging, not infinite key rewriting.
3. **SID → UPN mapping** — multi-session / RDS hosts need per-SID handling.
4. **Entra group ≠ SharePoint permission** — optional Graph access pre-check to
   avoid generating sync errors.
5. **Coexistence with existing Intune AutoMount** — both fight over the same
   keys mid-migration; provide a clean "Breeze owns this now, retire your Intune
   profile" story (and ideally detect existing Intune-managed AutoMount keys in
   the report).

## Deferred to Sub-project B

- Sync-error detection taxonomy (no official OneDrive status API — reverse-
  engineered from logs / Cloud Files sync-root state / named pipe).
- Tiered remediation: auto-run **safe** fixes (resume paused, restart hung
  OneDrive.exe); **gate** disruptive fixes (`/reset`, re-link) behind MSP
  approval or a scheduled window; **alert-only** for unfixable (quota, file
  conflicts, expired auth).
- MSP alerts + **end-user nudge via the Breeze Helper** (per-user toast:
  "OneDrive needs your attention"), to close the "broken for months because
  nobody told the user" gap.
- **KFM backup-*failure* alerting** (A reports KFM state; B alerts on it).
- Explicit, gated **unmount / deprovisioning** action.
- Data-safety pre-flight before destructive actions (reading 2 from brainstorm —
  noted but not selected).

## Success criteria (Sub-project A)

- A library mapping targeted at a Graph group mounts for an entitled user and
  not for a non-entitled user, silently, without per-device touch.
- Base config (silent sign-in + FOD + KFM) is enforced and converges on a device
  that started non-compliant.
- The org rollup correctly shows entitled-vs-mounted state and flags drift for a
  user removed from a group.
- All new tenant tables pass the RLS-coverage contract test and a forged
  cross-tenant insert fails as `breeze_app`.
