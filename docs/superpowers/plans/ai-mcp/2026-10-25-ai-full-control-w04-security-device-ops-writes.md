---
tracking_issue: LanternOps/breeze#6754
wave: W04 (#6758)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
depends_on: W02 (#6756, PR #9767) and W19 (#10065, PR #10087) merged to main; W03 (#6757, PR #10117) concurrent
branch: feature/6754-ai-full-control/wave-6758
---
# AI full control W04: security, incident and device-operation writes — class review and plan

**Goal:** wire the 19 security, incident and device-operation tools into chat and headless agents, so each is tiered, declared and classified. Fix every classification or parity gap the per-action review finds **before** the tool is exposed (spec D2). This is the highest-risk wave of the feature: these tools run on customer machines.

**Verified against** `origin/main` `30d2519965` (2026-10-25: W02 #9767 and W19 #10087 merged; W03 #10117 open). Evidence comes from:
- reading the code;
- a `vitest` probe over the real registry (registry `input_schema` keys vs Zod keys, `action` enums, `deviceArgs`, domain, current class through `checkGuardrails`/`resolveApprovalScope`, `TOOL_PERMISSIONS`, rate limits, path fields);
- three parallel read-only handler/route audits (incident/PAM/remote; device operations; policies + `manage_groups`).

Paths are under `apps/api/src/`; line numbers drift, so re-grep before editing.

**House style:** the W01, W02 and W03 plans. W04 builds on `inputShape()`, `TIER1_READ_ACTIONS`/`TIER1_ACTIONS`, the tier-1 write-action contract, `AGENT_HUMAN_ONLY_ACTIONS`, `isInputAwareTier3`/`TIER3_INPUT_AWARE_*`/`TIER_DECIDING_INPUT_KEYS`, the `W0x_EXPECTED` row style and the D6 MCP-change heading.

## Starting state (measured, `30d2519965`)

- **Tiering and declaration:** all 19 are registered; none is in `TOOL_TIERS` or `HUMAN_ONLY_TOOLS`. `KNOWN_MISSING_TOOL_TIERS` holds 38 (W03's 19 + these 19). Whichever of W03/W04 merges second deletes it (spec "Contracts").
- **Schemas:** all 19 have a plain `z.object` `toolInputSchemas` entry; `action` enums equal the registry's. **One key drift:** `manage_peripheral_policy` advertises `priority` in the registry; Zod lacks it, so the chat SDK shape (derived from Zod) would drop it (W04-D16).
- **Chat index (W19):** the always-on index is unchanged by W04 (2,494 B). Six domain blocks grow (largest: security 970 → 1,268 B, < 2,048). Worst page turn: alert 4,190 → 4,423 B (< 7,040). Legacy whole index (informational): 6,917 → 7,636 B default, 6,966 → 7,685 B flag-on. None of the 19 is `alwaysLoad`.
- **Device-path fields (#8852):** `registry_operations.keyPath` is classified `exempt` (a registry key; `isDeniedRegistryTarget` applies) and `remediate_sensitive_data.quarantineDir` is `safePath`. No other W04 field names a device path. **No path-policy work.**
- **Route bindings:** rows exist only for `create_remote_session`, `manage_processes:list`, `manage_scheduled_tasks:list`, `registry_operations:read_key`/`get_value`.
- **MFA (common to all):** every system-tools, PAM, remote, incident, sensitive-data, software- and peripheral-policy REST twin carries `requireMfa()`; the network twins do not. The tool handlers have no MFA step, except `assign_security_training` (`hasSatisfiedMfa`, `aiToolsUserRisk.ts:316`). In chat the session is MFA-gated and every tier-3 call goes through the approval card. A tier-2 W04 tool over MCP has no MFA step: the W02-D11 class, recorded, not fixed.

## Per-tool class review (spec "Class review rule")

Columns follow the W02/W03 plans. **Q1** reversible within a minute? **Q2** leaves the tenant or reaches a person, including "touches a customer machine"? **Q3** blast radius. **Q4** can an agent grant itself authority? **Today** = the class on main (reachable over MCP only; chat cannot call any of these). t1-read = `TIER1_READ_ACTIONS`/`TIER1_ACTIONS`; t2-ro = `TIER2_READONLY_ACTIONS` (live device read: audited, no prompt); t2 = the user approves unless `auto_approve`; sup / 4e = tier-3 scopes.

**`incident.created` subscriber reading (spec concern row; codex QW3 dissents — see Quorum).** The AI handler publishes `incident.created` (`aiToolsIncident.ts:194-206`). There is **no dedicated subscriber**. Only the generic `'*'` subscribers see it (`eventSubscribers.ts`): partner/org-configured outbound webhooks (`webhook-delivery`, only when a webhook row subscribes to it or `*`), partner-authored event-trigger automations (`automation-worker`; incident payloads carry no top-level `deviceId`, so the config-policy device branch is inert), plugin hooks, and the live console WS. `notification-dispatcher` handles `alert.*` only. **Nothing always-on emails a customer, calls a vendor or runs on a device.** That is the W02 "partner webhooks are tenant plumbing" class (W02 kept `manage_tickets:create` at t2 though `ticket.created` reaches the same webhooks; W03 QW1 kept `configure_backup_sla` there on the same precedent), so `create_incident` is **t2**.

### Incident response

| Tool | Q1 | Q2 (cite) | Q3 | Q4 | Today | **W04** | Scope parity tool / route | RBAC tool / route |
|---|---|---|---|---|---|---|---|---|
| `execute_containment` (`actionType` ∈ process_kill / network_isolation / account_disable / usb_block — one class, no `action` enum) | **no** (`process_kill` terminates a process; no release/un-contain action exists in the tool or anywhere) | **device:** one `execute_containment` command (`aiToolsIncident.ts:318-340`); `incident_actions` row first. On the current agent only `process_kill` is implemented; the other three return "requires platform-specific implementation" (`agent/internal/remote/tools/incident_response.go:189-205`). **`account_disable` does nothing today** — no local, domain or M365 account is touched. Classed for intent, as W03 classed the C2C stubs | one device | no | sup | **sup** (unchanged) | `findIncidentWithAccess` + central gate + `device.orgId === incident.orgId` (#9662, `:277`) ⊇ `devices/commands.ts` `POST /:id/commands` (`canAccessDeviceSite`) | **devices:execute + alerts:write** (W04-D9, quorum QW6): = dispatch twin `POST /devices/:id/commands` + the incident mutation the record twin `POST /incidents/:id/contain` gates on alerts:write |
| `create_incident` | partly (closeable, not deletable; a webhook already fired is not recallable) | none always-on (see the subscriber reading) | one org | no | t2 | **t2** | org `resolveWritableToolOrgId`; `affectedDeviceIds` through the central gate (route checks none) — tool **stricter** | **organizations:write vs route alerts:write — fixed to alerts:write (T3)** |
| `collect_evidence` (`evidenceTypes[]`) | n/a (read on the device) | **device:** `collect_evidence` command (`:424-441`). `processes`/`connections` are real; `screenshot` and `logs` are agent stubs today. A real screenshot is the `take_screenshot` class (tier 3 sup, screen-consent gate) | one device | no | t2 | **input-aware:** `screenshot` in `evidenceTypes` → **sup**; otherwise **t2** (spec concern row) | `findIncidentWithAccess` + central gate; **missing `device.orgId === incident.orgId`** — fixed (W04-D12) | devices:execute = `POST /devices/:id/commands` |

### PAM and remote access

| Tool | Q1 | Q2 (cite) | Q3 | Q4 | Today | **W04** | Scope parity | RBAC |
|---|---|---|---|---|---|---|---|---|
| `request_elevation` | the request yes; a grant it leads to is revocable | none on its own: inserts a `pending` request (`aiToolsPam.ts:236-262`). **An `auto_approve` PAM rule is NOT applied** — only `auto_deny` is (`:212-221`); a different `pam:approve` holder must answer via `POST /pam/elevation-requests/:id/respond`. The guardrail comments saying a rule can grant with no human are stale (corrected in T2) | one device | **no** (the subject is the caller; self-approval is refused by `selfApprovalPolicy.ts`) | 4e | **4e** (unchanged; no loosening proposed) | `loadDeviceWithAccess` + central gate; no human REST create twin | devices:execute (no route) |
| `revoke_elevation` | no (re-grant needs a new request + approval) | none (a de-escalation) | one device | no | t2 | **t2** ("tier 2 is correct", spec row) | org + `deviceSiteDenied` (site **and** exact device, `:377`) — **stricter** than `routes/pam.ts:906` (site only when non-null). **Weaker on effect: never calls `requestPamCleanup`**, so an actuated grant gets no device cleanup and the expiry sweep skips `revoked` rows — fixed (W04-D10) | pam:approve = |
| `create_remote_session` (terminal / file_transfer) | the row yes; a live session is arbitrary command/file access | **device + person:** opens a terminal or file-transfer session on a customer machine | one device | no | 4e | **4e** (unchanged). An autonomous run may *propose* one (reachable); a human approves it and a second person approves the four-eyes intent | central gate + `verifyDeviceAccess(online)`. **Weaker than `POST /remote/sessions` (`routes/remote/sessions.ts:229-380`):** skips `checkRemoteAccess` (the tenant's remote-access policy), the org and per-user concurrent-session caps and the `session_initiated` audit — fixed (W04-D11) | devices:execute + remote:access ⊇ remote:access (existing row) |

### Device operations (system tools)

**Common facts:** every write dispatches through `aiExecuteCommand` → `checkAiRemoteToolsPolicy` → `executeCommand` (`assertDeviceExecuteAllowed`); the queue audits `KILL_PROCESS`, `TASK_*`, `REGISTRY_*` (`AUDITED_COMMANDS`, `commandQueue.ts:355-380`). Device text in results is fenced (`stdout`/`stderr`/`error`, `aiToolOutput.ts:1031-1034`). REST twins are `routes/systemTools/*.ts` under `/system-tools` (router-wide `devices:execute` + MFA + device org/site chokepoint + remote-tools policy, `systemTools/index.ts:34-90`).

| Tool / action | Q1 | Q2 | Q3 | Q4 | Today | **W04** | Route twin |
|---|---|---|---|---|---|---|---|
| `manage_processes:list` | read | device read | one device | no | t2-ro | **t2-ro** (unchanged; a live device read keeps its audit row — not moved to `TIER1_READ_ACTIONS`) | GET `/devices/:deviceId/processes` (bound) |
| `manage_processes:kill` | **no** | device | one device, one PID | no | sup | **sup** (unchanged). **#4149:** wiring is condition (a) of the `actManifest.ts` deferral; (b), the dispatch-time pid→name pin in `actRevalidation.ts`, is not done, so `kill` stays out of `ACT_MANIFEST`. `processName` is accepted but never checked by the handler; the headline says so | POST `/devices/:deviceId/processes/:pid/kill` |
| `manage_scheduled_tasks:list` | read | device read | one device | no | t2-ro | **t2-ro** | GET `/devices/:deviceId/tasks` (bound) |
| `manage_scheduled_tasks:run` | no (task side effects unknown; tasks can run as SYSTEM) | device | one device | no | sup | **sup** | POST `/devices/:deviceId/tasks/:path/run` |
| `manage_scheduled_tasks:disable` / `enable` | yes (the inverse action) | device | one device | no | sup | **sup** | POST `…/tasks/:path/disable` / `…/enable` |
| `registry_operations:read_key` / `get_value` | read | device read (allowlisted for agents: values can be secrets-adjacent) | one device | no | t2 | **t2** (unchanged) | bound |
| `registry_operations:set_value` | no (overwrites, no prior read) | device; can disable a security control or break boot | one device | no | sup | **sup** | PUT `/devices/:deviceId/registry/value` |
| `registry_operations:create_key` | yes | device | one device | no | sup | **sup** | POST `/devices/:deviceId/registry/key` |
| `registry_operations:delete_key` | **no** (leaf keys only) | device | one device | no | sup | **sup** — irreversible but single-device and tenant-internal, so the class rule gives sup, not 4e | DELETE `/devices/:deviceId/registry/key` |

Scope parity: every action rides the central `deviceArgs` gate (org + site + exact device + not parked) plus a local `verifyDeviceAccess(online)`; the HKLM\SAM/SECURITY deny is equal on both paths. Inputs: the AI schemas had no bounds where the routes do (registry path 1024 / name 256, task path 512, PID an integer) — added (W04-D17).

### Agent maintenance

| Tool | Q1 | Q2 | Q3 | Q4 | Today | **W04** | Scope / RBAC parity |
|---|---|---|---|---|---|---|---|
| `trigger_agent_restart` | yes (automatic recovery) | **device:** `restart_agent` to the **watchdog** (`aiToolsAgentMgmt.ts:565-569`), works on offline devices | ≤ 50 devices per call | no | sup | **sup** (unchanged) | central gate on every id = `routes/devices/agentRecovery.ts`. **RBAC: tool devices:execute vs route devices:recover_agent — fixed to devices:recover_agent (T3).** The `.slice(0, 50)` silently dropped ids; Zod now caps at 50 (W04-D17) |
| `trigger_agent_upgrade` | semi (another upgrade) | **device:** `update_agent` to the watchdog | ≤ 50 devices | no | sup | **sup** (unchanged) | **No REST twin** — the recovery route rejects `update_agent` as "a release decision, not a button" (`agentRecovery.ts:20-25`). An explicit `targetVersion` **overrode the org's agent pin and allowed downgrades** (`:301-304`) — agent rollback is a spec standing exclusion. Fixed (W04-D13) |

### Policies and remediation

**Common facts:** the singular tools write the same tables and reach the same routes as the already-wired plural prereq tools (`manage_software_policies`, `manage_peripheral_policies`, #3552: create/update supervised, list/get `TIER1_READ_ACTIONS`). Partner-wide rows are gated by `canManagePartnerWidePolicies` in the handlers; org callers never see them (`orgCondition`). Every write requires `canMutateOrgWideGovernance`, which refuses any caller with a site or exact-device ceiling — every device-bound agent run.

| Tool / action | Q1 | Q2 | Q3 | Q4 | Today | **W04** | Route twin / RBAC |
|---|---|---|---|---|---|---|---|
| `manage_software_policy:list` / `get` | read | none (policy config; creator user id, no personal data, no device text) | org + own partner | no | sup (whole-tool backstop — reads resolve tier 3 and are MCP-denied) | **t1-read** via `TIER1_ACTIONS` (**loosening**, precedent `manage_software_policies` / `security_scan:['vulnerabilities']` — sign-off line) | GET `/software-policies` / `/:id`, devices:read = |
| `…:create` | yes | none until linked (an unlinked policy resolves to zero devices) | one org (always org-owned) | no | sup | **sup** (per-action row) | POST `/software-policies`, devices:write = |
| `…:update` | partly | **arms fleet uninstall** (`enforceMode` + `autoUninstall` on a linked policy, `softwarePolicyService.ts:236-276`) | org or partner-wide (gated) | no | sup | **sup** | PATCH `/:id`. **Tool skipped `cleanupSoftwarePolicyElevations`** on deactivation, leaving PAM elevations tied to the policy live — fixed (W04-D15) |
| `…:delete` | soft delete | removes enforcement | org or partner-wide (gated) | no | sup | **sup** | DELETE `/:id` (same cleanup gap, D15) |
| `manage_browser_policy:list` | read | none (policy config, 200-row cap) | org | no | sup (backstop) | **t1-read** via `TIER1_ACTIONS` (**loosening**, sign-off line) | GET `/browser-security/policies`, devices:read = |
| `…:create` / `update` | yes | none by itself (browser policy is detect/report: violations rows) | org (site-scoped writes via `policyWithinSiteWriteScope`) | no | sup | **sup** | POST/PUT `/browser-security/policies`, devices:write = |
| `…:apply` | re-apply | **device:** one `apply_browser_policy` per device (`aiToolsBrowser.ts:595-601`; the Go agent has no handler for it today) | org's devices | no | sup | **sup** | **no REST twin**; devices:execute (stronger than the write twin) |
| `manage_peripheral_policy:create` / `update` / `disable` | yes | **device:** `peripheral_policy_sync_v2` arms block/read-only on targeted devices | org; partner-wide fan-out to every org for a partner row (gated) | no | sup | **sup** (per-action rows) | POST `/peripherals/policies` (`peripheralControl.ts`), organizations:write = |
| `…:add_exception` / `remove_exception` | yes | device (an `allow:true` exception opens access) | same | no | sup | **sup** | POST `/peripherals/exceptions`, organizations:write = |
| `remediate_sensitive_data:encrypt` / `quarantine` / `secure_delete` | **no** for `secure_delete` (one random overwrite + remove); encrypt secure-deletes the source | device (file operations on a customer machine) | the findings' devices | no | sup | **sup** (`secure_delete` irreversible, tenant-internal → sup by the rule) | POST `/sensitive-data/remediate` (`routes/sensitiveData.ts:811`), devices:execute + MFA |
| `…:accept_risk` / `false_positive` / `mark_remediated` | **no reopen path** (re-detection creates a new row) | none (DB status flips) | the findings | no | sup | **sup** (kept; no loosening — closing a finding with no reopen path is not "undoable within a minute") | **same route, devices:execute. Tool required devices:write — fixed to devices:execute (T3)** |
| `remediate_software_violation` | **no** (uninstall) | **device:** `software_uninstall` per violating row via the remediation worker | **unbounded** — every violating device of an armed policy | no | sup | **sup** | POST `/software-policies/:id/remediate`, devices:execute =. **No device cap (route: 500) — fixed (W04-D14)** |

### User risk and network

| Tool | Q1 | Q2 | Q3 | Q4 | Today | **W04** | Scope / RBAC parity |
|---|---|---|---|---|---|---|---|
| `assign_security_training` | no un-assign (24 h dedup) | **none:** a `user_risk_events` row + `user.training_assigned` event; **nothing emails or notifies the user** (only a partner webhook/automation subscribed to the event could react — tenant plumbing) | one user | no | t2 | **t2** | org + `getUserRiskOrgMembership(…, allowedSiteIds)` = `POST /user-risk/assign-training`; users:write = |
| `configure_network_baseline` | yes (edit/disable in the UI; **the tool itself has no disable/delete**) | **touches customer machines:** create arms a **recurring** discovery scan (`scanSchedule.enabled: true`, every 1–168 h, `aiToolsNetwork.ts:617-620`) run by an on-site agent against the subnet, bound to the caller's live authority (`networkBaselineAuthority.ts`) | one subnet, repeatedly | no (an agent principal fails closed: `BaselineAuthorityUnsupportedError`) | t2 | **sup, registry 2 → 3** (W04-D7: `network_discovery`, a one-shot scan, is already supervised; arming a recurring one at t2 would let `auto_approve` schedule hourly scans of any model-chosen subnet) | org + site = `routes/networkBaselines.ts`; devices:write =. `subnet` was not CIDR-validated — fixed (W04-D17) |
| `acknowledge_network_device` | soft (no un-ack) | none (one `network_change_events` flag + note) | one event | no | t2 | **t2** | org + site + exact device = `POST /network/changes/:id/acknowledge`; alerts:acknowledge =. `notes` unbounded (route 2000) — fixed (W04-D17) |

### Agent (headless) exposure, per tool (spec D4; W01 rule)

| Tool | Exposure |
|---|---|
| `manage_software_policy:list/get`, `manage_browser_policy:list` | **reachable; skip the allowlist** (tier 1). Output is policy configuration written by staff — no personal data, no device-originated text. The W01 per-read rule is satisfied. |
| `manage_processes:list`, `manage_scheduled_tasks:list` | **reachable; read-only to agents** (t2-ro skips the allowlist). Process and task names are device text, already fenced (`aiToolOutput.ts:1032-1034`). |
| `registry_operations:read_key/get_value` | **reachable; allowlisted** (t2, not read-only): registry values can carry secrets-adjacent data, so an agent needs an explicit allowlist entry. |
| `create_incident`, `collect_evidence` (non-screenshot), `assign_security_training`, `acknowledge_network_device`, `revoke_elevation` | **reachable; allowlisted t2.** `revoke_elevation` and `acknowledge_network_device` refuse an agent principal in the handler (#6911: user FK) — reachable in the catalog, refused at run time; recorded, unchanged. |
| `configure_network_baseline` (now sup) | **reachable as a proposal.** A released create still fails closed for an agent principal (`BaselineAuthorityUnsupportedError`) — the schedule is bound to a person's authority. Decision recorded: an autonomous run can propose, never arm by itself. |
| `create_remote_session`, `request_elevation` (4e) | **reachable as proposals only.** 4e keys are never pre-authorisable. Q4 does not apply: the session/elevation belongs to the approving human, and the agent gains no standing authority. |
| The other sup tools/actions | **reachable as proposals.** No W04 key is in `POLICY_DECIDABLE_TIER3` (pinned). |
| Software/peripheral policy writes | Refused by `canMutateOrgWideGovernance` for every device-bound run (site + exact-device ceiling). |
| **`manage_groups:add_devices` / `remove_devices` (W02 Task 16 follow-up — W04 decides)** | **Accepted → `AGENT_HUMAN_ONLY_ACTIONS`** (W04-D8). Group membership is a live read at run admission and before tool use (`runService.ts:1407`, `runLoop.ts:3904-3927`, `runResourceScope.ts:49-54`), so an allowlisted add puts a device inside any agent whose `triggers.deviceGroupIds` names the group — the `manage_tags:add` self-scope path exactly. A remove can drop a device out of a group-targeted config/peripheral policy. The tool is already wired; no index bytes. |

### Existing entries, and whether they change

| Map | Entry today | W04 |
|---|---|---|
| `TIER1_ACTIONS` | — for these tools | **+ `manage_software_policy: ['list','get']`, `manage_browser_policy: ['list']`** (loosenings) |
| `TIER3_ACTIONS` / `TIER3_SUPERVISED_ACTIONS` | `manage_processes:kill`, `manage_scheduled_tasks` run/disable/enable, `registry_operations` writes | unchanged |
| `TIER3_SUPERVISED_ACTIONS` (per-action rows for whole-tool backstops) | — | **+ `manage_software_policy` create/update/delete, `manage_browser_policy` create/update/apply, `manage_peripheral_policy` all five, `remediate_sensitive_data` all six** (the whole-tool backstops stay) |
| `TIER3_SUPERVISED_TOOLS` | containment, agent upgrade/restart, software/browser/peripheral policy, sensitive data, software violation | **+ `configure_network_baseline`** |
| Registry `tier` | `configure_network_baseline` 2 | **→ 3** (D1: registry and `TOOL_TIERS` together) |
| `TIER3_INPUT_AWARE_TOOLS` | `s1_isolate_device`, `run_script` | **+ `collect_evidence`** (action-less base-tier-2 tool escalated on input; docstring widened) |
| `isInputAwareTier3` | tickets, policy feature link | **+ `collect_evidence` arm:** `evidenceTypes` not an array, or containing `'screenshot'` |
| `TIER_DECIDING_INPUT_KEYS` | 6 tools | **+ `collect_evidence: ['evidenceTypes']`** |
| `TIER3_FOUR_EYES_TOOLS` | `create_remote_session`, `request_elevation` | unchanged |
| `TIER2_ACTIONS` / `TIER2_READONLY_ACTIONS` | `manage_processes:list`, `manage_scheduled_tasks:list`, registry reads, `manage_groups` add/remove | unchanged |
| `AGENT_HUMAN_ONLY_ACTIONS` | `manage_tags` add/remove | **+ `manage_groups:add_devices`, `manage_groups:remove_devices`** |
| `TOOL_PERMISSIONS` | see the tables | **`create_incident` → alerts:write; `trigger_agent_restart` → devices:recover_agent; `remediate_sensitive_data` flips → devices:execute** |
| `TOOL_RATE_LIMITS` | containment 5/600, evidence 10/300, remote 10/300, processes 15/300, tasks 10/300, registry 15/300, agent restart/upgrade 5/600, violation 10/600, training 10/300 | unchanged (W04-D5) |
| Four-eyes fallback moved to supervised | — | **none.** Every W04 tier-3 tool already had an explicit class. |
| `ACT_MANIFEST` | `kill` absent | unchanged; deferral comment updated (#4149 (a) landed) |

### Final per-action classes (T7's `W04_EXPECTED` copies this)

| Tool | t1 (read) | t2 | supervised | four-eyes |
|---|---|---|---|---|
| `execute_containment`, `trigger_agent_restart`, `trigger_agent_upgrade`, `remediate_software_violation`, `configure_network_baseline` | — | — | whole tool | — |
| `create_remote_session`, `request_elevation` | — | — | — | whole tool |
| `create_incident`, `revoke_elevation`, `assign_security_training`, `acknowledge_network_device` | — | whole tool | — | — |
| `collect_evidence` | — | `evidenceTypes` without `screenshot` | `evidenceTypes` with `screenshot` | — |
| `manage_processes` | — | list (read-only) | kill | — |
| `manage_scheduled_tasks` | — | list (read-only) | run, disable, enable | — |
| `registry_operations` | — | read_key, get_value | set_value, create_key, delete_key | — |
| `manage_software_policy` | list, get | — | create, update, delete | — |
| `manage_browser_policy` | list | — | create, update, apply | — |
| `manage_peripheral_policy` | — | — | create, update, disable, add_exception, remove_exception | — |
| `remediate_sensitive_data` | — | — | encrypt, quarantine, secure_delete, accept_risk, false_positive, mark_remediated | — |

## Decisions (W04-D1 … W04-D17)

- **W04-D1: no new four-eyes and no four-eyes → supervised move.** Every W04 tier-3 tool was already explicitly classed; nothing relied on the unclassified fail-safe. No `EFFECT_DIGEST_RESOLVERS` or `DELIBERATELY_UNPINNED` change is needed except the input-aware `collect_evidence` pair, if the coverage contract folds it in.
- **W04-D2: loosenings (Todd signs each in the PR).** `manage_software_policy:list/get` and `manage_browser_policy:list` move from the tier-3 whole-tool backstop to tier 1. They are reads of staff-written policy config, already tier 1 on the plural sibling tool for the same table. `remediate_sensitive_data` bookkeeping stays supervised (no reopen path; also listed as user-owned release actions in `intentReleaseWorker.ts`).
- **W04-D3: `collect_evidence` is input-aware.** `screenshot` → supervised (the `take_screenshot` class, spec concern row), anything else t2. The predicate escalates a non-array `evidenceTypes` (fail-safe; Zod rejects it anyway). Screenshot is an agent stub today; classed for intent so the day it lands needs no reclassification.
- **W04-D4: #4149 statement.** `manage_processes:kill` is wired (supervised in chat; a proposal for agents). Act-mode re-admission still needs the dispatch-time pid→name pin in `actRevalidation.ts`; `ACT_MANIFEST` is unchanged and the `actManifest.ts` comment now says condition (a) landed in W04.
- **W04-D5 (revised by QW11): rate limits for every device-touching W04 tool** (spec checklist item 3). New: `manage_browser_policy` 20/300 s, `manage_peripheral_policy` 10/300 s, `remediate_sensitive_data` 10/600 s, `configure_network_baseline` 10/300 s. `request_elevation` (no device effect; the second approver bounds it) and `manage_software_policy` (config; `remediate_software_violation` carries the uninstall budget) stay without one.
- **W04-D6: MCP surface change (Todd signs off in the PR).** Tier 3 over MCP is denied by default (`MCP_APPROVAL_REQUIRED`), except with `MCP_TIER3_INTENTS_ENABLED=true` or a `MCP_UNATTENDED_TIER3_PRINCIPALS` principal.
  - **Losses:** `configure_network_baseline` (whole tool; drops out of `tools/list`). `collect_evidence` is **not** a loss: every input is already MCP-approval-gated through `MCP_APPROVAL_REQUIRED_EXTRA_TOOLS` (`routes/mcpServer.ts:1481`), and that stays (QW12).
  - **Gains:** `manage_software_policy:list/get` and `manage_browser_policy:list` stop being denied.
  - Unchanged: everything else in the table is either already tier 3 or stays t2.
- **W04-D7: `configure_network_baseline` escalates to supervised** (registry 2 → 3 + `TIER3_SUPERVISED_TOOLS`). An escalation from the brief's t2 proposal: the class rule's "touches a customer machine" applies to a recurring on-site discovery scan, and the one-shot `network_discovery` is already supervised.
- **W04-D8: `manage_groups:add_devices`/`remove_devices` join `AGENT_HUMAN_ONLY_ACTIONS`** (see the exposure table). Reasons ≥ 20 chars; `agentPrincipal` contract rows (deny both + `list` control); the capability picker filter already reads the map.
- **W04-D9 (reversed by quorum QW6): `execute_containment` requires devices:execute + alerts:write.** It is dispatch **plus** an incident mutation: it writes the `incident_actions` row through which the result handler moves the incident to `contained`, writes its timeline and publishes `incident.contained` (`incidentContainmentResults.ts:131-189`) — a generic `POST /devices/:id/commands` without that row cannot. REST gates that incident mutation on alerts:write (`routes/incidentActions.ts:32-39`). **Who loses:** both seeded technician roles (Org Technician, Partner Technician hold devices:execute but not alerts:write) lose AI containment; Org Admin and Partner Admin keep it. They keep the plain device command over REST.
- **W04-D10: `revoke_elevation` requests PAM cleanup like the route.** In the same transaction, after the audit row, it calls `requestPamCleanup(tx, { cause: 'revoked' })`; `PamActuationNotFoundError` (nothing was ever dispatched) is not an error, matching the expiry enforcer (`jobs/pamJobs.ts:159`). The result carries `enforcementStatus`.
- **W04-D11: `create_remote_session` applies the route's gates:** `checkRemoteAccess(deviceId, 'remoteTools')`, the org and per-user concurrent-session caps, and the `session_initiated` audit. The same-user stale-session teardown is a browser-reconnect convenience, not a gate; not mirrored.
- **W04-D12: `collect_evidence` requires the device to be in the incident's org**, as `execute_containment` does (#9662).
- **W04-D13 (+ quorum QW7): `trigger_agent_upgrade` makes no release decision.** An explicit `targetVersion` is accepted for a device only when it equals the version the org's pin (or, unpinned, the promoted latest) resolves for that device. On **both** paths a device is dispatched only when that sanctioned target is strictly newer than its installed `agentVersion` (`compareAgentVersions`, the heartbeat's comparison); an unknown/unparseable installed version fails closed. Both agent tools pass `expectedOrgId`, so a device that moved orgs between resolution and dispatch is refused. The tool can bring a device to its sanctioned version sooner; it cannot override a pin, re-push, or roll an agent back (a spec standing exclusion).
- **W04-D14: `remediate_software_violation` caps a call at 500 devices** (`MAX_REMEDIATION_DEVICES`, the route's cap) for both an explicit list and the implicit violating set.
- **W04-D15: `manage_software_policy` update (deactivation) and delete call `cleanupSoftwarePolicyElevations`,** as the REST PATCH/DELETE do.
- **W04-D16: `manage_peripheral_policy` parity.** Zod gains `priority` (`int 0..1000`, the route's bound) so the chat shape keeps it; a `target_type` change without new ids clears the stored ids (REST `resolveUpdateTargeting`, #9620); an exception without `allow` defaults to `true` (REST `peripheralControl.ts:220`).
- **W04-D18 (quorum QW8): screenshot evidence honours the screen-access consent gate.** The screenshot branch runs `checkScreenAccessConsentGate` (new surface `collect_evidence`) before dispatch, as `take_screenshot` does.
- **W04-D19 (quorum QW10): `manage_software_policy:update` refuses a resulting install-armed state.** The tool refused only an incoming `autoInstall: true`; an update that omitted `remediationOptions` re-approved (bumped `approvalGeneration` on) an already install-armed policy. It now applies `willBeArmedForInstall` to the merged state (the REST predicate); disarming stays allowed.
- **W04-D20 (quorum QW11): bounds the REST twins enforce.** `manage_browser_policy:apply` refuses a resolved target set over 1,000 devices (the explicit-list cap) before any dispatch; `trigger_agent_restart` refuses a decommissioned device and does not queue a second watchdog recovery while one is pending/sent (`agentRecovery.ts` 409 `ALREADY_PENDING`).
- **W04-D17: input bounds the routes enforce.** Registry `keyPath` ≤ 1024, `valueName` ≤ 256; scheduled-task `taskName` ≤ 512; `manage_processes.processId` digits only; `trigger_agent_restart`/`upgrade` `deviceIds` ≤ 50 (was a silent `.slice`); `acknowledge_network_device.notes` ≤ 2000; `configure_network_baseline.subnet` an IPv4 CIDR (the route's regex). Zod only; registry text unchanged unless the constraint-visibility contract asks for it.

## Quorum (codex `exec`, read-only, xhigh, 2026-10-25)

**Codex's verdict: AGREE WITH CHANGES** (QW1–QW12). It agreed with every class except the three noted below, with both loosenings (W04-D2), the `configure_network_baseline` escalation (D7), the `collect_evidence` predicate (D3), D8, and D10–D12/D14–D17. Each requested change is resolved on the merits:

- **QW3 `create_incident` → supervised minimum. Kept at t2; dissent recorded for Todd.** Codex is right on the mechanism: model-written incident fields reach partner webhooks through the `'*'` subscriber, and a partner-authored event automation can run against its configured device targets. That is exactly the W02 class (`manage_tickets:create` stays t2 though `ticket.created` reaches the same webhooks and automations) that W03 QW1 also kept on precedent. Supervising incidents and not tickets would be incoherent; flipping both is one decision for Todd.
- **QW4 partner-wide software-policy update/delete → four-eyes (input/state-aware). Rejected; recorded for Todd.** Ownership is DB state, so it could only be static 4e for every update/delete. The plural `manage_software_policies` already writes the same rows from chat at supervised (#3552), so 4e on the singular alone moves no risk. W03-D1 (partner-wide backup profiles) took supervised on the same reasoning. If Todd wants 4e for partner-wide policy writes it belongs on both tools (follow-up).
- **QW5 `assign_security_training` / `acknowledge_network_device` → supervised (no undo). Kept at t2; dissent recorded.** Precedent: `manage_alerts:acknowledge/resolve` are t2 (`aiGuardrails.ts:91`); both are tenant-internal bookkeeping that reach nobody (training sends no email or notification). `remediate_sensitive_data`'s status flips stay supervised for a different reason: closing a sensitive-data finding hides a PII/cardholder exposure from remediation, and they are user-owned release actions. The MFA statement is corrected (training checks MFA).
- **QW6 containment RBAC. Accepted** — W04-D9 reversed (devices:execute + alerts:write).
- **QW7 agent upgrade downgrade/re-push and `expectedOrgId`. Accepted** — W04-D13 strengthened.
- **QW8 screenshot consent gate. Accepted** — W04-D18.
- **QW9 `manage_groups` add/remove → supervised + group-site/dynamic-group guards. D8 accepted; the rest recorded as a follow-up.** `manage_groups` was wired before W04 and is not one of this wave's 19; reclassifying its chat class and fixing its handler is a W02-territory change that needs its own review. D8 closes the agent self-scope path, which is the part W04 owns.
- **QW10 merged-state install gate. Accepted** — W04-D19.
- **QW11 browser apply cap, rate limits, restart dedupe. Accepted** — W04-D20 and the revised D5. **Route MFA for tier-2 tools over MCP: not adopted** — the W02-D11 program-wide follow-up (W02 and W03 recorded the same); gating `manage_processes:list` and registry reads behind MFA would break API-key MCP read workflows and needs Todd's call.
- **QW12 D6 accounting. Accepted** — `collect_evidence` was already MCP-approval-gated for every input.

## Budget (W19 bounds; the brief's whole-index policy is obsolete)

| Measure | main | projected (branch) |
|---|---|---|
| Always-on (B1 < 2,560) | 2,494 | 2,494 |
| devices block (B2 < 2,048) | 940 | 1,117 |
| security block | 970 | 1,268 |
| monitoring block | 731 | 787 |
| network block | 452 | 508 |
| patching block | 337 | 423 |
| admin block | 260 | 306 |
| Worst page turn (B3 < 7,040) — alert | 4,190 | 4,423 |
| device page turn (default / flag-on) | 3,822 / 3,871 | 3,999 / 4,048 |
| Legacy full index (informational) default / flag-on | 6,917 / 6,966 | 7,636 / 7,685 |

`FIXTURE_W03_W04` loses W04's 19 names; with W03 merged it is empty and the fixture test is adjusted.

## Tasks

T1 (this doc + quorum) → T2 guardrail classes → T3 route bindings + permission fixes → T4 handler pre-exposure fixes (D10–D17) → T5 wiring + `FIXTURE_W03_W04` → T6 agent catalog → T7 `W04_EXPECTED` → T8 web `tierConfig.ts` → T9 docs → T10 prompt-size gate (D5) → T11 golden prompts g79–g81 → T12 integration suites → T13 merge main, gates, PR. Each task red first; one commit per task.

## Follow-ups (not filed)

- `manage_groups` (already wired) writes manual rows into dynamic groups and does not check the group's site or same-site membership; REST does both (`routes/groups.ts:1026-1097`). Codex QW9 also asks that add/remove be supervised in chat (they schedule peripheral reconciliation).
- QW4: if partner-wide software/peripheral policy writes should be four-eyes, apply it to both the singular and plural tools.
- QW3/QW5 dissents: `create_incident`, `assign_security_training`, `acknowledge_network_device` at t2 (precedent `manage_tickets:create`, `manage_alerts:acknowledge`).
- `manage_software_policy` advertises `targetType`/`targetIds`/`priority` that the handler never reads.
- `manage_browser_policy` create/update never trigger `triggerBrowserPolicyEvaluation` (empty `try {}`); the Go agent has no `apply_browser_policy` handler; `apply` does not check explicit `deviceIds` against the policy's targets for an unrestricted caller.
- `execute_containment.approvalRef` is free text never checked against an approval record (the tier-3 card is the real gate).
- Route-style audit rows missing on the tool paths: `create_incident`, `assign_security_training` (+ risk feedback), `configure_network_baseline`, `acknowledge_network_device`.
- Tier-2 W04 tools over MCP skip the routes' `requireMfa()` (W02-D11 class).
- The `SAFE_WRITE_SITES` scanner misses `manage_scheduled_tasks` (`commandTypeMap`) and the inline `{ userId: auth.user.id, … }` form in `manage_processes`/`manage_services`; substantively the same `resolveCommandCreatedBy` degrade path.
- `policyDecidableKeys.ts` says `manage_processes:kill` is "unregistered from dispatch (#4149)" — stale after W04.
