# Per-user Windows software inventory: design

**Status:** draft · **Date:** 2026-10-22
**Split from:** `docs/superpowers/specs/vuln-patch/2026-10-21-vuln-catalog-coverage-design.md` §5.6 (Todd, 2026-10-22)
**Builds on:** the fleet-integrity inventory rules in `docs/superpowers/specs/misc/2026-08-24-s0-fleet-integrity-program-design.md` and `docs/superpowers/plans/2026-08-24-s0-track-b-fleet-execution-truth.md`

## 1. Why

The Windows agent runs as a SYSTEM service. Its software collector reads the machine-wide Uninstall keys plus `CURRENT_USER`, which for SYSTEM is SYSTEM's own hive, not any person's (`agent/internal/collectors/software_windows.go`). Anything installed "for this user only" is invisible to Breeze: VS Code's user installer, Cursor, per-user Chrome, Zoom, Slack, Teams and many others. In the lab comparison that started this work, the commercial scanner found 25 CVEs in two such apps (VS Code and Cursor) that Breeze could not see.

These are real, runnable programs that people launch every day. Missing them means missing a common place where unpatched software hides.

## 2. Goals

1. Programs installed per user on Windows appear in device inventory, attributed to the user profile that owns them.
2. They flow into vulnerability matching like any other installed program.
3. A user logging off does not make their programs look uninstalled. Findings on them stay open, and no false "removed" change events fire.
4. Programs disappear from inventory only when Breeze has actually observed their absence: the user's hive was read and the program was gone, or the user's profile was deleted.
5. Older agents and older servers keep working through the rollout in either upgrade order.

## 3. Non-goals

- **macOS and Linux per-user installs.** macOS app matching is out of scope in the parent spec, and Linux per-user installs are rare.
- **Remotely uninstalling per-user programs.** The agent deliberately refuses to run per-user uninstall strings as SYSTEM, because the user can write them (`agent/internal/remote/tools/software_uninstall_registry.go`). That boundary stays.
- **Per-user patching.** Third-party patching already has a user-scope concept (`device_patches.scope`). This spec does not change it.
- **Profiles of users who have never logged on to the machine.** They have no per-user installs.
- **Change history for per-user installs and removals.** The agent's change tracker stays machine-only. Server-side diffing of per-user scopes is a possible follow-up.

## 4. Anti-goals

- **Loading offline users' registry hives.** The agent never calls `RegLoadKey` on a user's `NTUSER.DAT`. Loading it as SYSTEM can collide with that user's next logon. Only hives Windows has already loaded are read.
- **Inventory that flaps with logons.** If a device's software list changes every time someone logs on or off, change history, alerts and findings all become noise.
- **Breaking the inventory-integrity rules.** Incomplete evidence must never erase last-known-good inventory or resolve a vulnerability by absence (fleet-integrity program, RMM-QA-297). Per-user scopes follow the same rule, applied per scope.
- **Network calls on the collection path.** Resolving a SID to a name through the directory can block on Azure AD-joined machines.

## 5. Design

### 5.1 What the agent collects

- The agent takes a snapshot of the profile list from `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList`. It covers every local, domain and Azure AD user profile, whether or not the user is logged on. Service accounts (`S-1-5-18`, `-19`, `-20`) are skipped. The snapshot is marked complete only when the whole key was enumerated without error.
- For each profile whose hive is already loaded under `HKEY_USERS\<SID>`, the agent reads that hive's Uninstall key. `_Classes` hives are skipped. The agent never loads a hive.
- Each profile gets exactly one state in the observation:
  - `read`: every entry was enumerated and read. A missing Uninstall key counts as a successful, empty read.
  - `not_loaded`: the user isn't logged on.
  - `failed`: something went wrong partway, such as an unreadable entry, a value-read error, or the hive unloading mid-read. Today's collector silently skips unreadable subkeys (`agent/internal/collectors/software_windows.go`). Per-user reads must not reuse that behaviour, because it would falsely certify absence.
  - `skipped_budget`: not read because a collection budget ran out (see below).
- Each per-user item carries scope `user` and its owner: the SID, plus a display name taken from the profile folder's name in the profile list. No directory lookup happens, so Azure AD machines can't stall. Machine-wide items carry scope `machine` and no owner. This matches the `device_patches.scope` vocabulary.
- Each user item must belong to a profile in state `read`. SIDs in the observation are unique.
- The de-duplication key includes scope and owner. Today it is name plus version only (`agent/internal/collectors/software.go`), which drops a per-user copy at the same version as a machine-wide one.
- The existing `hkcu` source, which reads SYSTEM's own hive, is retired. Profile states are a separate field, not entries in `expectedSources` or `failedSources`. A failed source forces the whole report to `partial` (`packages/shared/src/types/softwareInventoryObservation.ts`), and the source list caps at 64 entries.

**Budgets.** User hives are writable by their users, so they are untrusted input. Enumeration runs under explicit limits:
- entries per profile;
- total profiles read;
- time per profile and overall;
- encoded bytes of user items, so the report stays under the endpoint's 5 MB body limit;
- the existing 5,000-item cap across the report.

Machine-wide items are always collected first and are never dropped for user items. When a budget runs out, the current profile becomes `failed` and the remaining profiles become `skipped_budget`. Machine delivery is unaffected.

### 5.2 Agent-internal consumers stay machine-only

- There is no separate legacy collection path. `Collect()` wraps `CollectObservation()`. Three consumers read it: the change tracker, the uninstall verifier, and the on-demand software collection command (`agent/internal/heartbeat/handlers.go`). Each filters to machine scope explicitly.
- Uninstall and remediation actions carry scope. A name-only uninstall request can only ever target a machine-wide entry, so a user who plants an entry with a machine program's name can't redirect an action. The existing refusal to run per-user uninstall strings as SYSTEM (`agent/internal/remote/tools/software_uninstall_registry.go`) stays.

### 5.3 Wire contract and compatibility

- The server's observation schema is strict, so an older server rejects any new field with a 400.
- The server advertises a versioned per-user inventory capability. It defaults to off, and the agent clears it when the server URL changes or the advertisement is missing. Without it, the agent sends today's payload, with no new fields at all. Existing precedents: the heartbeat's security capabilities and the patch scan's `userScopeScanned` flag. The builder picks the mechanism.
- An environment flag on the server stops advertising the capability. It acts as a kill switch.
- **A report without profile data means "user coverage unknown", never "zero profiles".** That covers older agents, rolled-back agents, a withdrawn capability, and an incomplete profile-list snapshot. In all those cases every existing per-user row and finding is kept unchanged.

### 5.4 How the server stores and replaces inventory

- `software_inventory` gains a scope and the owner's SID and display name. Existing rows are machine scope.
- Today an accepted report deletes all of the device's rows and reinserts them (`apps/api/src/services/softwareInventoryObservations.ts`). That becomes a scoped replacement:
  - Machine-scope rows are replaced, as today.
  - Rows for profiles in state `read` are replaced.
  - Rows for profiles in state `not_loaded`, `failed` or `skipped_budget` are kept as they are, with their last-seen time unchanged.
  - Rows for a SID are removed only when the report carries a complete profile-list snapshot and that SID is missing from it. The profile was deleted, so the programs are really gone.
- **Evidence is tracked per scope.** Acceptance and the count-collapse guard are judged separately for the machine scope and for each profile:
  - A machine scope that fails or collapses rejects the report, as today.
  - A profile that fails is not replaced. It does not reject the report.
  - Each scope keeps its own last-accepted baseline. Profile churn never resets machine protection.
  - Retiring the `hkcu` source must not switch the machine guard off for the first report after the upgrade. Today a changed source set bypasses it.
- Because unobserved rows are retained, a device's stored row count can differ from the report's item count. Nothing may assume they are equal.

### 5.5 Vulnerability findings

- Per-user programs are matched like any other installed program.
- One finding per device and CVE stays the rule. It stays open while any copy on the device, machine-wide or in any profile, observed now or retained, is vulnerable.
- **Affected copies are derived at read time.** The finding keeps its single inventory link, with a deterministic preference: the machine copy first, then the profile copy by SID order. The finding detail lists every current vulnerable copy and owner by joining inventory through the product resolution. No new table is added. Codex recommended persisting every copy's provenance. The author judged that a new tenant table, with its own registrations, isn't worth it for a display need, because the current copies are what a technician acts on.
- **Absence is scope-aware.** A finding resolves only when no vulnerable copy remains, judged across the machine scope and every profile. Retained rows from unobserved profiles count as present. A copy in a profile that wasn't read never resolves anything.
- **Correlation must be generation-consistent.** Today correlation reads candidate rows before taking the finding locks, and it checks the latest observation separately (`apps/api/src/services/vulnerabilityCorrelation.ts`). A concurrent ingest can supply newer evidence than the inventory it evaluated. Scope-aware absence must evaluate the same inventory generation it decides on, through locking or a validated retry. The existing finding-before-inventory lock order is kept.

### 5.6 Trust boundary

- Per-user registry entries are written by an ordinary user. The user can invent entries, change versions to hide their own vulnerable programs, or set the "system component" flag. That is accepted: the user's own scope is theirs to misreport, just as they could uninstall the program.
- A user's scope can never mask machine evidence. Per-user data never resolves, hides or relinks a finding on a machine-wide copy.
- Owner names, program names, vendors and versions from user hives are untrusted strings. They are escaped for their context in the UI, exports, reports, PSA payloads and AI tool output.

### 5.7 Other server consumers

- **Software policy:** per-user programs count toward allowlist and blocklist evaluation, so violations are visible. Automatic remediation skips them, and the violation says manual removal is needed instead of retrying.
- **Software currency:** the automation deploy gate (`isDeviceSoftwareCurrent`, called from `automationRuntime.ts`) keeps using machine scope only. Otherwise a stale per-user copy that a machine-wide install can't update would trigger a redeploy on every run. Reporting views may show per-user copies separately.
- **Partner API software count:** counts distinct name, version and vendor per device. For devices with no per-user rows, the number does not change.
- **Device software tab:** shows a user column or badge and can filter by scope.
- **Owner visibility:** owner names appear wherever device software is shown today. The program's install location already exposes `C:\Users\<name>`. The new columns take the same export classification as `install_location`, which is `included`.
- The builder sweeps every other reader of `software_inventory` for a one-row-per-program assumption. The known list: correlation, policy evaluation, currency, third-party update matching, filters, presence alerts, reports, the AI export dataset, install-boundary classification, the partner API and the portal.

## 6. Rollout

1. Server first: schema, scoped replacement, per-scope evidence, consumers and the capability advertisement ship together. Older agents see no change.
2. Agent next, through the normal lab and promote path. It sends per-user data only to servers that advertise support.
3. **First-sighting alerts.** A device's first per-user report creates findings for programs that may have been installed for years. Findings created from a profile's first `read` report do not emit per-finding `vulnerability.critical_detected` events. One summary per organization is sent instead, the same handling the parent spec uses for backfill. Later reports behave normally.
4. Lab legs before promotion, on Windows:
   - Two local users, one logged on and one not. Expect the logged-on user's per-user installs to appear, and nothing to disappear when that user logs off.
   - An Azure AD user. Expect no network stall during collection.
   - A terminal server with many sessions. Expect machine inventory to stay complete when budgets run out.
   - A deleted profile. Expect its programs and findings to go away on the next report.
   - An agent rollback to the previous version. Expect per-user rows and findings to stay unchanged.

## 7. Constraints

- No `RegLoadKey`. Only already-loaded hives are read.
- Agent code that ships to customer machines: the lab legs above are required before promotion.
- `software_inventory` is an org-cascade table. New columns need export-policy classification, and any JSON column is `excludedOpen` (`docs/agents/tenancy-rls.md`).
- Migrations follow `apps/api/migrations/README.md`.
- The fleet-integrity rules hold per scope: incomplete evidence never erases last-known-good inventory or resolves a finding.
- **Required tests:**
  - both upgrade orders;
  - agent rollback;
  - incomplete enumeration;
  - a budget running out partway through a profile;
  - machine and per-user copies at different versions;
  - severed inventory links;
  - concurrent ingest and correlation;
  - planted entries that try to mask a machine finding.

## 8. Calls made by the author

These were settled from existing rules or reviews. Todd can override any of them.

- Missing profile evidence means unknown coverage, so rows are kept (§5.3). This follows the fleet-integrity rule.
- Affected copies are derived at read time, not stored in a new table (§5.5).
- The automation deploy gate stays machine-only (§5.7).
- First-sighting findings send one summary per organization, and a server flag can switch the capability off (§5.3, §6). This is a global rollout, not a per-partner opt-in.
- Change history for per-user programs is out of scope (§3).
- Owner names are visible wherever device software is, and they are exported like `install_location` (§5.7).

## 9. Left to the builder

- The capability-advertisement mechanism (§5.3).
- Column names and types, and the exact profile-state field in the observation schema.
- Budget values (§5.1), set from lab data.
- How per-scope baselines are stored (§5.4), within the stated rules.
- Device software tab layout.
