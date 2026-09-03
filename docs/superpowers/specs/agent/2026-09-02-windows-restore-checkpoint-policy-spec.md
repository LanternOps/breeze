---
issue: LanternOps/breeze#4609
status: approved
area: agent
date: 2026-09-02
advisors: Fable (in-session) + Codex gpt-5.6-sol xhigh (read-only)
approved: 2026-09-02 (Gate A, Todd via handoff board; Open Decisions resolved as recommended)
plan: docs/superpowers/plans/agent/2026-09-02-windows-restore-checkpoint-policy.md
---

# Windows System Restore checkpoint before risky actions (policy toggle)

## Problem

Breeze creates a Windows System Restore checkpoint in exactly one place:
`agent/internal/patching/windows.go:96`, inside `WindowsUpdateProvider.Install`,
once per non-`definitions` update, best-effort, logged at `Debug` and never
reported. `agent/internal/patching/preflight_windows.go:319`
`CreateRestorePoint` is the native `SRSetRestorePointW` (srclient.dll) call;
`preflight_other.go:49` is the non-Windows no-op.

Four gaps follow:

1. **Coverage.** Script execution (`agent/internal/heartbeat/handlers_script.go`)
   and software install (`agent/internal/remote/tools/software_install.go`,
   `software_install_manager.go`) — the two actions techs run ad hoc against
   production machines — never create a checkpoint.
2. **Invisibility.** No result field, no column, no console surface. A tech
   cannot answer "did a checkpoint actually get created for what I just did?".
3. **Silent ineffectiveness.** Windows throttles restore-point creation to one
   per `SystemRestorePointCreationFrequency` minutes (default 1440) and
   `SRSetRestorePointW` returns `TRUE`/`ERROR_SUCCESS` inside that window while
   reusing the previous point's sequence number. A 12-patch job "creates" 12
   checkpoints and actually gets at most one. Nobody can see that today.
4. **No control.** No policy, config field, or toggle exists anywhere in
   `apps/api`, `apps/web`, or `packages/shared`.

**Option B was chosen on the issue (2026-09-02, handoff board D5):** a policy
toggle honoured by all three paths, with the outcome surfaced in the
command/job result and the console.

> **Advisor-quorum finding that reframes the whole feature.** Codex flags that
> the shipped native call may not work at all: `RESTOREPOINTINFOW.llSequenceNumber`
> and `STATEMGRSTATUS.llSequenceNumber` are `INT64` in the Windows SDK, while
> `preflight_windows.go:329-336` declares both `uint32` — with a code comment
> (added in `13aee57b6a`, a 39-finding hardening PR) asserting the opposite. If
> Codex is right, the description field is misaligned and Windows may write past
> the Go struct. **We cannot claim Breeze creates usable restore points today
> until this is settled on real hardware.** See Open Decision 1; it gates
> everything else.

## Users & scope

**Primary user: the MSP technician / owner (partner scope).** An MSP defines
"take a checkpoint before you touch a production box" once and expects it to
apply to every customer. This is a config-ish policy in the sense of CLAUDE.md's
*Partner-Wide First* rule (epic #2135), so it must be authorable partner-wide
from day one.

**Secondary user: the org-scoped admin**, overriding for one customer —
typically to *disable* it on machines where System Restore is off or shadow
storage is precious.

Ownership comes for free: the toggle lives on a `config_policy_feature_links`
row whose parent `configuration_policies` is already dual-axis (`org_id` XOR
`partner_id`, `configuration_policies_one_owner_chk`, migration
`2026-06-27-config-policies-partner-ownership.sql`), registered in
`DUAL_AXIS_TENANT_TABLES`. Partner-wide authoring is already gated on
`canManagePartnerWidePolicies(auth)`; resolution already admits partner-owned
rows via `policyOwnershipCondition(hierarchy)` + `withPartnerWideVisibility`
(`services/configPolicyOwnership.ts:82`). The new feature type must **not** be
added to `ORG_SCOPED_ONLY_FEATURE_TYPES`
(`packages/shared/src/constants/configFeatureTypes.ts:53`) — its settings are
partner-agnostic booleans with no per-tenant anchor.

**Not users:** portal (end-customer) and mobile. This is technician-facing.

**Product language constraint.** System Restore protects system files, registry,
programs and settings — **not** personal files, and a created point can later be
purged by VSS under storage pressure or (since the July 2026 Windows update)
become unusable under VBS rules. Every surface must say *"System Restore point
creation was confirmed at execution time"*, never *"rollback available"*.

## Proposed design

### 1. Policy: a new `system_protection` feature type (inline settings, Pattern B)

Follow `vulnerability` (`featureConfigResolver.ts:1158`) — an inline-settings
feature type with **no normalized table**. Both advisors agree. A normalized
`config_policy_system_protection_settings` table would require registration in
`PARENT_FK_JOIN_POLICY_TABLES` (`rls-coverage.integration.test.ts:593`), a new
`WHEN` branch in `breeze_partner_export_effective_policy_settings`, and an entry
in the normalized-child trigger array
(`2026-07-25-partner-export-canonical-configuration.sql:245`) — three extra
registration lists for four booleans with no independent identity, lifecycle, or
query surface. Inline settings need **zero**: they ride
`config_policy_feature_links.inline_settings` (already RLS'd, already cascaded,
already exported — the canonical export's `ELSE result := NULL; RETURN
COALESCE(result, mirror)` returns the inline mirror for feature types with no
normalized table).

**Do not copy `vulnerability` literally.** Its resolver does an unchecked cast
(`featureConfigResolver.ts:1202`) and the generic validator accepts essentially
any record (`packages/shared/src/validators/index.ts:578`). Required instead:

- a strict shared `systemProtectionInlineSettingsSchema` with defaults and
  `.strict()` (pattern: `validators/remoteAccessInlineSettings.ts`);
- the resolver **parses** rather than casts; malformed stored settings produce a
  visible resolution error, never a silent downgrade to "off";
- validation in both service entry points, not only the HTTP route — direct
  callers bypass route validation (see the backstop note at
  `services/configurationPolicy.ts:1206`);
- `system_protection` added to the inline-only validation branch at
  `services/configurationPolicy.ts:2309`.

Registration required (all existing lists, no new ones):

| Where | Change |
|---|---|
| `apps/api/src/db/schema/configurationPolicies.ts:30` | `'system_protection'` in `configFeatureTypeEnum` — needs its own migration, `ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS`, precedent `2026-06-29-vuln-config-feature-type.sql` |
| `packages/shared/src/constants/configFeatureTypes.ts:22` | add to `CONFIG_FEATURE_TYPES` |
| `packages/shared/src/validators/` | strict inline-settings schema + wire into `addFeatureLinkSchema` |
| `apps/api/src/services/policyBaselineDefaults.ts:62` | `NOT_ENFORCED` entry |
| `apps/web/.../featureTabs/types.ts` + `SystemProtectionTab.tsx` | `featureTypeParity.test.ts` fails until both exist |

Inline settings shape:

```ts
{
  beforePatching: boolean            // effective default true (legacy parity)
  beforeScripts: boolean             // effective default false
  beforeSoftwareInstall: boolean     // effective default false
  labelPrefix?: string               // default "Breeze"; ≤64 chars
  // onFailure / strict modes: see Open Decision 2 — NOT in v1 as drafted
}
```

Resolver `resolveSystemProtectionForDevice(deviceId)` in
`featureConfigResolver.ts`, structured like
`resolveVulnerabilityEnabledForDevice` — `loadDeviceHierarchy` →
`buildTargetConditions` → `withPartnerWideVisibility(...)` →
`sortByHierarchy(rows)[0]` → **strict parse**. Closest-wins, so a device-level
`beforeScripts: false` suppresses a partner-wide opt-in.

The effective defaults are a single typed constant, and the UI must distinguish
*"platform default"* from an explicit policy value.

### 2. Delivery: a versioned request block stamped at command-creation time

The agent's existing patch preflight knobs (`PatchMinDiskSpaceGB`, …) come from
the agent's **local config file**, not from policy; there is no server→agent
policy channel for them. Rather than build one, resolve on the server when the
concrete per-device command is created and stamp the decision into the payload:

```jsonc
"restorePoint": {
  "v": 1,
  "requestId": "<server-generated uuid>",
  "enabled": true,
  "label": "Breeze: install 6 updates",
  "resolvedAt": "2026-09-02T18:03:11Z",
  "policyRevision": "<config policy updatedAt or hash>",
  "validUntil": "2026-09-03T18:03:11Z"
}
```

Three creation sites:

| Path | File | Command type |
|---|---|---|
| Patching | `apps/api/src/jobs/patchJobExecutor.ts:1050` (`prepareDeviceExecution`) | `install_patches` |
| Scripts | `apps/api/src/services/scriptDispatch.ts:457-501` | `script` |
| Software install | `apps/api/src/services/softwareDeployment.ts:423` and `:837` (dispatcher at `:87`) | `software_install` |

Why creation-time and not heartbeat config: the safety decision belongs to the
operation, not to the machine; the agent heartbeat runs under an org-scoped RLS
context and **cannot see partner-wide policy rows** (#2930, #1105), so resolving
server-side keeps the `withPartnerWideVisibility` escape inside one audited
helper; and there is no cache-staleness window between a policy edit and the
next heartbeat.

**Semantics the first draft got wrong or left out** (all from the advisor pass,
each verified against the code):

- **Scheduled work** resolves when the per-device command is created, never when
  the schedule is authored. The software path already rebuilds at execution time
  (`softwareDeployment.ts:87`).
- **Retries.** "A retry must re-resolve" is *wrong as a blanket rule*. Transport
  redelivery of the **same** command id must reuse the frozen snapshot; a new
  business attempt with a **new** command id re-resolves.
- **Offline devices.** Queued commands can sit pending for days
  (`jobs/staleCommandReaper.ts`), so a policy change mid-queue has no effect
  today. `validUntil` + `policyRevision` let the delivery-claim path supersede a
  stale command and recreate it with a fresh snapshot.
- **Agent restart/replay.** Command dedup is an in-memory map evicted after two
  minutes (`heartbeat.go:5945`), so a crash can replay both the checkpoint and
  the risky action. The `requestId` makes the ledger row idempotent.
- **Mixed-version fleets.** An old agent ignores `enabled: true` — and also
  ignores `enabled: false`, continuing the legacy per-patch calls. Protocol
  contract: **missing block on `install_patches` means legacy best-effort
  enabled; missing block on script/software means disabled.** An explicit patch
  *disable* is unenforceable until the device reports the new capability, and
  the UI must say so.
- **Auditability.** The draft's claim that the persisted payload is after-the-fact
  evidence is **false**: terminal processing erases payload data
  (`terminalPayloadErasureSet()`, `routes/agentWs.ts:1810`;
  `routes/agents/commands.ts:449`). The attempt ledger below is the only durable
  record.
- **Policy-resolution errors fail command creation visibly**, never silently
  downgrade protection.

`enabled` is stamped `true` only when the resolved toggle is on **and** the
device is Windows. The agent's `!windows` no-op is defence in depth, not the gate.

### 3. Agent: `agent/internal/systemrestore`

New package with `create_windows.go` / `create_other.go`.
`patching.CreateRestorePoint` moves here; the one existing call site is updated.

```go
type Status string
const (
    StatusCreated             Status = "created"
    StatusExistingAccepted    Status = "existing_accepted"      // rate-limited: a prior point was reused
    StatusSkippedDisabled     Status = "skipped_disabled"
    StatusSkippedDefinitions  Status = "skipped_definition_only"
    StatusUnsupported         Status = "unsupported"
    StatusBusy                Status = "busy"                   // VSS/SR subsystem in use
    StatusInsufficientPrivs   Status = "insufficient_privileges"
    StatusVerificationFailed  Status = "verification_failed"
    StatusFailed              Status = "failed"
)

type Outcome struct {
    Status          Status `json:"status"`
    RequestID       string `json:"requestId"`
    SequenceNumber  string `json:"sequenceNumber,omitempty"` // decimal STRING: int64 exceeds JS safe range
    Description     string `json:"description,omitempty"`
    Message         string `json:"message,omitempty"`
    AttemptedAt     string `json:"attemptedAt"`
    DurationMs      int64  `json:"durationMs"`
    ExistingPointAgeMinutes int64 `json:"existingPointAgeMinutes,omitempty"`
    FrequencyMinutes        int64 `json:"frequencyMinutes,omitempty"`
}
```

**Win32 ABI (blocked on Open Decision 1).** Per the Windows SDK, both
`RESTOREPOINTINFOW.llSequenceNumber` and `STATEMGRSTATUS.llSequenceNumber` are
`INT64`, and on 64-bit Windows `STATEMGRSTATUS` needs padding before the 64-bit
field. The spec's position is that the structs must be declared with correctly
aligned `int64` fields **and covered by Windows build tests asserting
`unsafe.Sizeof` and `unsafe.Offsetof`** — a test that would have caught this
either way. `int64` propagates to a decimal **string** on the wire and `bigint`
in Postgres.

**Identity-based verification, not "max sequence advanced".** Sequence ordering
is not an identity contract and a third-party requester can create a point
between two reads. Algorithm:

1. (Optional, an optimization) snapshot existing sequence ids and the newest
   `CreationTime` from `root\default:SystemRestore`.
2. Build a **unique, length-bounded description embedding the `requestId`**.
3. Call the correctly declared native API; inspect **both** the boolean return
   and `nStatus`.
4. Take the returned native sequence number as the candidate identity.
5. Poll `root\default:SystemRestore` briefly for **that exact sequence with the
   matching unique description**.
6. Sequence existed before the call ⇒ `existing_accepted` (the throttle path),
   reporting the existing point's age and the configured frequency.
7. WMI cannot confirm identity ⇒ `verification_failed`, **never** silently
   `created` and never mislabelled as rate-limited.

**COM.** `SRSetRestorePoint` requires `CoInitializeEx` and process-wide
`CoInitializeSecurity`. Today the call happens incidentally inside the patching
COM thread; moving it to a generic handler removes even that. See Open Decision 3.

**Timeout is not free.** `windows.Proc.Call` is synchronous and **cannot** be
cancelled by `context.WithTimeout` — the first draft's "120s bounded context"
was fiction. Either an out-of-process helper provides a killable boundary
(Open Decision 3) or the spec must admit the call is unbounded and size the
server-side deadlines accordingly. Patch polling currently gives up after 30
minutes (`patchJobExecutor.ts:1070`); the checkpoint allowance must fit inside
that, and inside the script's own `timeoutSeconds` budget rather than consuming
it.

**Privileges.** Command privilege checking is warn-only (`heartbeat.go:6014`)
and script/software commands are not in the elevated list. Detect the actual
token and return `insufficient_privileges` rather than a generic failure.
User-context scripts are checkpointed by the **service** process before the IPC
handoff to the helper.

**VSS coordination, not an isolated mutex.** Breeze backup already serialises
snapshot creation process-wide (`agent/internal/backup/vss/vss_windows.go:294`,
`snapshotCreationBusy()`) and keeps auto-release snapshots alive during a backup
(`:257`). A private System Restore mutex would not see any of that, nor Windows
Update, MSI, or third-party VSS requesters. Restore-point creation must go
through the **same** snapshot-creation gate and return `busy` rather than
blocking or thrashing shadow storage.

**Checkpoint boundary.** Create the checkpoint *after* validation, download +
checksum, and no-op/"already installed" detection — immediately before the first
mutation (`software_install.go:78` is the pre-mutation reject path;
`:175` starts the installer). Equivalent placement after script validation and
session selection. A command that never mutates must not consume the day's one
restore point.

**Definitions-only skip.** Not implementable as drafted: the `install_patches`
payload carries no category (`patchJobExecutor.ts:1040`) and the agent's patch
reference has none (`heartbeat.go:6040`). Either add `category` to the payload
or pre-resolve every update before checkpointing. Unknown category ⇒ treat as
risky. Emit `skipped_definition_only` so an enabled request never vanishes
without an outcome.

**One checkpoint per command**, not per patch: the existing per-update call
moves up to `handlers_patch.go`.

**Non-Windows**: `create_other.go` returns
`Outcome{Status: StatusUnsupported, Message: "System Restore is Windows-only"}`.
No process spawns, no registry read, no error.

### 4. Result transport and the attempt ledger

**Transport is four files, not one.** All of these currently drop unknown
fields:

- `agent/internal/remote/tools/types.go:251` — `tools.CommandResult`
- `agent/internal/websocket/client.go:75` — the WS `CommandResult` struct, and
  the explicit conversion at `heartbeat.go:5722`
- `apps/api/src/routes/agents/schemas.ts:439` — `commandResultSchema` (Zod ingest)
- both stored-result builders: `routes/agentWs.ts:532`,
  `routes/agents/commands.ts:105`

A dedicated top-level `restorePoint` field, not a key inside `Result`/`Stdout`:
script and software-install results already use `Stdout` for their own payloads
with type-specific parsers. Precedent for a sub-outcome riding the result and
landing in its own column: `rebootRequired` on `install_patches`
(`patchJobExecutor.ts:1150-1189` → `patch_job_results.reboot_required` →
`PatchInstallHistory.tsx:574`).

**Table name: `device_restore_point_attempts`** — not `device_restore_points`.
Failed and skipped rows are not restore points, and even a created point can be
purged by VSS later. The table records *attempts and observations*, never a
promise of recoverability.

```
device_restore_point_attempts
  id                         uuid pk
  request_id                 uuid not null unique   -- from the command block; idempotency key
  org_id                     uuid not null          -- denormalized from the device (RLS shape 1)
  device_id                  uuid not null
  device_command_id          uuid                   -- optional, NOT the identity
  trigger                    varchar(24) not null   -- 'patch' | 'script' | 'software_install'
  status                     varchar(32) not null   -- 'requested' + the Status values
  sequence_number            bigint
  description                text
  message                    text
  policy_revision            text
  accepted_existing_point    boolean not null default false
  existing_point_age_minutes integer
  frequency_minutes          integer
  duration_ms                integer
  requested_at               timestamp not null default now()  -- server, at command creation
  attempted_at               timestamp                          -- agent clock
  received_at                timestamp                          -- server, at result ingest
  script_execution_id        uuid
  software_deployment_id     uuid
  patch_job_id               uuid
  CONSTRAINT device_restore_point_attempts_device_org_fk
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
```

- **The row is created at request time with `status='requested'`** and
  terminalised from the result. Without this, an absent row ambiguously means
  policy-off, old agent, lost result, or command timeout.
- Composite `(device_id, org_id)` FK (pattern: `db/schema/agentHealth.ts:30`)
  makes a mismatched tenant stamp impossible.
- **No jsonb column** — every field is typed, so the whole table classifies as
  `included` in the export policy with nothing in `excludedOpen`.
- Indexes on `(device_id, requested_at desc)` and `(org_id, requested_at desc)`,
  plus a retention/prune policy.

**Ingestion must run after the authoritative terminal compare-and-set in both
transports.** Direct non-UUID software results take a separate branch
(`routes/agentWs.ts:1634`); a single insertion inside `processCommandResult` is
not sufficient.

### 5. Console

- **Config policy editor**: `SystemProtectionTab.tsx` under
  `apps/web/src/components/configurationPolicies/featureTabs/`, on
  `FeatureTabShell` + `useFeatureLink`, inheriting the ownerScope selector and
  "All orgs" badge.
- **Inline badge** on `scripts/ExecutionDetails.tsx`,
  `software/DeploymentProgress.tsx`, `patches/PatchInstallHistory.tsx` —
  rendered the way `rebootRequired` is today, with the constrained language:
  *"Restore point creation confirmed 14:03"* / *"Existing point reused — created
  4h ago (Windows limit: every 24h)"* / *"Not available on this device"* /
  *"Could not be verified"* / *"Failed — <message>"*.
- **Device detail**: a "System Restore attempts" list reading the ledger.
- **Capability signal** on the device: a timestamped
  `available | disabled | unsupported | unknown` inventory field driving fleet
  visibility and the "explicit disable is unenforceable" warning. It is
  advisory — **the agent's runtime outcome stays authoritative**, because
  inventory goes stale.

All surfaces are read-only renders; no mutation handler is added, so `runAction`
does not apply.

## Tenancy & data model impact

**No new config table.** The toggle is inline settings on
`config_policy_feature_links`, whose FK-join RLS policy through
`configuration_policies` already covers
`breeze_has_org_access(policy.org_id) OR breeze_has_partner_access(policy.partner_id)`.
Partner-wide-first is satisfied structurally: the parent is already dual-axis,
the CHECK constraint exists, and no new RLS policy is written.

**One new table: `device_restore_point_attempts`.** Tenancy shape **1** (direct
`org_id`), the hot agent-write pattern.

Registration checklist (CLAUDE.md step 4 — **six** lists, all in the same PR;
the first draft listed five and missed the composite-FK one):

| List | Entry |
|---|---|
| RLS in the creating migration | `breeze_has_org_access(org_id)`, ENABLE + FORCE, four command-complete policies, `GRANT` to `breeze_app` |
| `rls-coverage.integration.test.ts` | none — shape 1 is auto-discovered |
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) | yes — alphabetical, and verify FK-children-before-parents (it references `devices`) |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts`) | yes — has `device_id` |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (same file) | yes — `device_id` **and** denormalized `org_id`; device-move must rewrite it |
| `DEVICE_ORG_FK_CASCADE_TABLES` (`routes/devices/core.ts:254`) | yes — required by the composite `(device_id, org_id)` FK |
| `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) | `tablePolicy("org_id", { included: [every column], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] })` |
| `orgMergeRegistry` | yes — org merge must re-point `org_id` |
| `AUDIT_ADMIN_REQUIRED_TABLES` | no — not append-only; ordinary DELETE needed for erasure |

**Enum change.** `ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS
'system_protection'` must be its own migration file — Postgres forbids using a
new enum value in the transaction that adds it, and `autoMigrate` wraps each
file in one transaction. Precedent: `2026-06-29-vuln-config-feature-type.sql`.

**Migration naming.** The newest committed migration is
`2026-10-04-100003-portal-visibility-indexes.sql` — over a month ahead of real
time. A file named for today would replay *before* it. Name to sort after the
newest committed file and re-check against `origin/main` before pushing.

**No secret material** enters any payload or result, so `commandSecretRedaction`
and `redactAgentResultErrorFields` are unaffected.

## Out of scope

- **Invoking a restore.** This spec creates and records checkpoints. Performing
  a rollback needs an approval flow, reboot orchestration, and a hard
  multi-tenant guard. Separate feature.
- **macOS / Linux snapshot analogues** (APFS, Btrfs/LVM, Timeshift).
- **Non-system volumes / user data.** Not a backup; the docs must say so.
- **Auto-enabling System Restore** (`Enable-ComputerRestore`) — Open Decision 5.
- **Shadow-storage capacity management** (`vssadmin resize shadowstorage`).
- **Other risky actions** (remote terminal, file ops, PAM elevation, CIS
  hardening). Adding them later is a settings-shape change; the transport is
  generic.
- **Extending `RunPreflight`.** Checkpointing is not a preflight check;
  conflating them would overload `PreflightResult.OK`.

## Open Decisions

**1. Is the shipped `RESTOREPOINTINFOW` / `STATEMGRSTATUS` layout wrong, and how
do we settle it?**
The Windows SDK declares `llSequenceNumber` as `INT64` in both structs;
`preflight_windows.go:329-336` declares `uint32` in both, with a comment (from
hardening commit `13aee57b6a`) asserting that `int64` "would corrupt the
Description field offset". Both cannot be true. If the SDK is right, today's
checkpoints may never have been created correctly — which changes what we tell
the prospect.
- **A — verify on real Windows hardware before writing any other code**: a
  throwaway harness that calls both layouts and enumerates
  `root\default:SystemRestore` for the result, on Win10/11 client and Server
  2022/2025. Pro: settles a factual question with a fact, and produces the
  `unsafe.Sizeof`/`unsafe.Offsetof` regression test either way. Con: needs a
  Windows box before the feature starts.
- **B — trust the SDK, change to aligned `int64` now**, ship the offset test
  with it. Pro: fastest path; the SDK is the normative source. Con: contradicts
  a deliberate prior fix with no evidence about *why* it was made — if the
  original author had a real repro, we reintroduce their bug.
- **C — keep `uint32`.** Pro: no change to shipped agent behaviour. Con: if
  wrong, every downstream claim in this spec is built on a call that silently
  does nothing.

**Recommend A**, and treat it as a **hard gate on the rest of the work**. This
also decides whether the issue's framing ("we already do this for patching") is
even accurate.

**2. Does a strict "abort if unprotected" mode ship in v1?**
The first draft proposed `onFailure: 'proceed' | 'abort'` with abort firing on
`failed`/`skipped_disabled` but not `unsupported`/`rate_limited`. **The advisors
disagree.**
- **A — ship the `onFailure` knob as drafted.** Pro: the prospect's real ask is
  *trusting* the rollback path; reporting-only leaves the toggle advisory. Con:
  Codex's objection is strong — "abort" means the action requires protection, so
  it is incoherent for an unsupported machine to proceed while a merely-disabled
  one aborts; whether an admin *can* fix the cause is irrelevant to whether the
  requirement was met. It also treats a 23-hour-old unrelated point as success.
- **B — v1 is reporting-only best-effort; strictness lands in v2** as per-action
  modes `off | best_effort | require_recent`, where `require_recent` takes
  `maxExistingPointAgeMinutes` and aborts on unsupported, disabled, failed,
  busy, timed-out, unverified, stale-inventory, or unsupported-agent. Pro:
  coherent contract; per-action granularity (require for patching, best-effort
  for ad-hoc scripts) which a single global knob cannot express; v1 telemetry
  tells us how often abort would actually fire. Con: two shipping rounds, and
  v1 alone does not fully answer the prospect.

**Recommend B.** The disagreement is real and I concede it: a global `onFailure`
is the wrong granularity, and `existing_accepted` genuinely should not count as
success without an age bound. Todd's call if v1 must be self-sufficient for the
prospect.

**3. In-process native call, or an out-of-process helper?**
`SRSetRestorePoint` needs `CoInitializeEx` + process-wide `CoInitializeSecurity`,
and `windows.Proc.Call` cannot be cancelled — so an in-process call has no real
timeout and inherits whatever COM security the agent process already set.
- **A — in-process, in the `systemrestore` package.** Pro: no new binary, no new
  IPC surface, no install/update/signing work. Con: an unbounded synchronous
  call inside the command handler; process-wide `CoInitializeSecurity` conflicts
  with whatever the backup/VSS subsystem already needs; the agent's generic
  watchdog is log-only and waits two hours (`heartbeat.go:5794`).
- **B — a small helper process** owning COM security, giving a genuinely
  killable timeout boundary. Pro: fixes both problems properly; isolates a
  historically flaky Windows subsystem from the agent. Con: another shipped
  Windows binary — code signing, updater plumbing, install layout, a new IPC
  contract, and it must not repeat the `WaitDelay` hang class.

**Recommend B for correctness, A only if the wave budget forces it** — and if A,
the spec must state plainly that the call is unbounded and size server deadlines
around it rather than claim a timeout it does not have.

**4. How do we describe and gate Windows Server?**
The first draft asserted flatly that Server has no System Restore. Codex found
the Microsoft documentation conflicts: older PowerShell/native pages say
client-only ("minimum supported server: none"), while the July 2026 restore
documentation discusses Server 2025 and says earlier server releases keep
supporting restore points without the new VBS restrictions.
- **A — never gate by SKU; probe the DLL, entry point, provider, and enabled
  state at runtime**, and let the outcome say what happened. Pro: correct under
  either reading of the docs, and survives future Windows changes. Con: we
  cannot tell an MSP up front which of their servers will be protected — they
  learn per device, after the first attempt.
- **B — probe at runtime AND ship a documented support matrix** derived from the
  hardware verification in Open Decision 1. Pro: answers "will this work on my
  fleet?" before they enable it. Con: a matrix that must be maintained as
  Windows changes, and it will be wrong somewhere.

**Recommend A for the gate (unconditional — SKU gating is simply incorrect)**,
with B's matrix as documentation only, populated from Open Decision 1's results.

**5. Should the policy be able to turn System Restore *on* when it is off?**
Many OEM and "debloated" images ship with SR disabled, so `skipped_disabled` will
be common and techs will ask Breeze to fix it.
- **A — no; report `skipped_disabled` and let the MSP remediate with their own
  script.** Pro: Breeze never silently reconfigures a customer's OS as a side
  effect of running a script; the failure is visible and actionable. Con: an
  extra manual step, and the feature looks broken across a chunk of the fleet.
- **B — a separate `autoEnableSystemRestore` (default false).** Pro: makes the
  feature work fleet-wide with one explicit opt-in. Con: enabling SR allocates
  shadow storage on the system volume, which can evict existing shadow copies
  and collide with the Breeze backup agent's own snapshots.

**Recommend A for v1**, revisiting once the real `skipped_disabled` rate is
known. Surfacing the count is cheap; guessing the shadow-storage blast radius is
not.

**6. Should Breeze ever lower `SystemRestorePointCreationFrequency`?**
Setting it to `0` would make every requested checkpoint actually happen.
- **A — never write it.** Pro: the throttle is Microsoft's protection against
  shadow-storage thrash; overriding it to checkpoint before a two-line script is
  a trade the customer did not ask for. Con: `beforeScripts` will frequently
  report `existing_accepted`, which reads as the feature not working.
- **B — a knob that sets it to 0 for the duration and restores the prior value.**
  Pro: honours the toggle literally. Con: a crashed or killed agent leaves the
  customer's throttle permanently disabled — a persistent side effect from a
  transient action.

**Recommend A**, and render `existing_accepted` as a *neutral* state naming the
existing point's age, which is usually the answer the tech actually wanted. Note
this interacts with Open Decision 2: under `require_recent`, an
`existing_accepted` older than `maxExistingPointAgeMinutes` is a failure, not a
neutral.

## Test & rollout notes

**Agent (Go, `go test -race ./...`).**
- **Windows build tests asserting `unsafe.Sizeof` and `unsafe.Offsetof`** for
  both native structs — the regression test that makes Open Decision 1
  permanently settled rather than re-litigated.
- `systemrestore` table-driven tests against injected seams for the frequency
  read, the WMI enumeration, and the native call: fresh machine ⇒ `created`;
  call succeeds but the returned sequence pre-existed ⇒ `existing_accepted`
  (the honesty case); WMI cannot confirm the description/sequence ⇒
  `verification_failed`, **not** `created` and **not** rate-limited; provider
  absent ⇒ `unsupported`; SR off ⇒ `skipped_disabled`; snapshot gate held ⇒
  `busy`; non-elevated token ⇒ `insufficient_privileges`.
- `create_other.go`: `unsupported`, no side effects, on `!windows`.
- Boundary tests: an install rejected at validation or detected as already
  present creates **no** checkpoint; the checkpoint happens after download and
  checksum, before the first mutation.
- Handler tests per path: missing block on `install_patches` ⇒ legacy
  best-effort attempt; missing block on script/software ⇒ no attempt; exactly
  one attempt for an N-patch command.
- A replay test: the same `requestId` delivered twice produces one ledger row.

**API (Vitest).**
- `resolveSystemProtectionForDevice`: closest-wins across all five levels;
  device-level `false` beats partner-wide `true`; malformed stored settings
  raise rather than silently resolving to off.
- Creation-time stamping at all three sites: non-Windows never gets
  `enabled: true`; unset policy produces the legacy-parity default matrix.
- `validUntil`/`policyRevision`: a stale queued command is superseded and
  recreated; a transport redelivery of the same command id keeps its snapshot.
- Result ingest through **both** transports, including the direct non-UUID
  software branch (`agentWs.ts:1634`), asserting the ledger terminalises the
  `requested` row rather than inserting a second one.

**Integration / contract (needs a live DB — `pnpm test` does NOT run these).**
- `deviceRestorePointAttemptsRls.integration.test.ts`: cross-tenant forge as
  `breeze_app` ⇒ `42501`; composite-FK tenant mismatch ⇒ `23503`.
- `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`,
  `tenantExportErasureRoundtrip.integration.test.ts` run locally — these caught
  the missed-cascade bug 5/5 where code review caught it 0/5.
- **Partner-wide fan-out** (CLAUDE.md step 5): a partner-wide policy with
  `beforeScripts: true` and no org-level policy makes a script enqueued for a
  device in *any* of that partner's orgs carry `enabled: true`.

**Windows integration (manual/hardware, gated on Open Decision 1).**
- Restore-point creation while a Breeze backup holds the VSS snapshot gate ⇒
  `busy`, and neither operation corrupts the other.
- Shadow-storage consumption measured across a 10-command sweep.

**Web (Vitest + jsdom).**
- `featureTypeParity.test.ts` fails until `FEATURE_META` + the tab exist — the
  intended red-first signal.
- `SystemProtectionTab.test.tsx` including the partner-wide path.
- Badge rendering for every status, asserting the constrained language (no
  string containing "rollback available").

**Repo-wide sweep before done** (CLAUDE.md step 7): every creation site for the
three command types, including AI-tool paths (`aiToolsScripts*`,
`aiToolsSoftware*`), the automation worker's script dispatch,
`softwareRemediationWorker`, and every retry path — classifying each as
transport redelivery (keep snapshot) or new attempt (re-resolve).

**Rollout.**
1. Open Decision 1 first, on hardware. Nothing else starts until it resolves.
2. Ship dark: policy type + resolver + agent package + ledger, defaults matching
   today's behaviour. An unassigned feature link is itself the off switch, so no
   feature flag is needed.
3. The agent change is **customer-machine code** — normal agent release plus the
   fleet-promote gate. The API must tolerate agents that never return a
   `restorePoint` field, and the UI must mark an explicit patch-disable as
   unenforceable until the device reports the capability.
4. Docs (`apps/docs`): `features/configuration-policies.mdx` for the new tab,
   plus notes on the patch-management, scripts, and software pages — stating
   plainly that System Restore is not a backup, does not protect personal files,
   is rate-limited to once per 24h by default, and that a created point can later
   be purged or rendered unusable.
5. Release notes must call out the patching-default decision explicitly so
   self-hosters can tell whether behaviour changed for them.
