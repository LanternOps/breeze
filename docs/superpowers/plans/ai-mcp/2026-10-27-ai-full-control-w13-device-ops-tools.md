---
tracking_issue: LanternOps/breeze#6754
wave: W13 (#6783)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W12 (#6782, PR #10319) and W19 (#10087) merged to main
branch: feature/6754-ai-full-control/wave-6783
---
# AI full control W13: device inventory and ops tools — class review and plan

**Goal:** give chat and MCP the capabilities the W05 triage tagged `W13` (rows #43, #45, #46, #48, #49, #52, #53, #60, #61, #113, #132, #133) as twelve tool surfaces, each with a class that survives the spec's class review **before** it is reachable (spec D2). Paths are under `apps/api/src/`.

**Verified against** `origin/main` `f5742d2eb7` (2026-10-27; W12 #10319 merged).

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | #10319 merged and on `origin/main` | yes (`f5742d2eb7` is main's head) |
| 0.2 | none of the twelve names in the registry / `TOOL_TIERS` / `HUMAN_ONLY_TOOLS`; every route module exists | yes / yes (`devices/{events,function,health,links,manual,posture,processSamples,warranty,watchdogLogs}.ts`, `remote/supportSessions.ts`, `systemTools/eventLogs.ts`, `tenantVariables.ts`) |
| 0.3 | no `wave-6783` branch or PR | yes |
| 0.4 | #6783 and #6754 open | yes |

## Split (W13-D1): two PRs, both base `main`, sequential

The twelve surfaces fall into two risk groups with no shared design question:

- **PR A (this branch): nine surfaces** — the device reads (`get_device_events`, `get_device_health`, `get_process_samples`, `search_agent_logs` + `source`, `get_management_posture`) and the four tenant-internal device-record tools (`manage_device_function`, `manage_device_links`, `manage_manual_assets`, `manage_device_warranty`). `Part of #6783`.
- **PR B (next dispatch, branched from `main` after PR A merges): three surfaces** — `browse_device_event_log` (a live agent command), `manage_tenant_variables` (values are substituted into scripts on customer machines; secrets) and `manage_support_sessions` (mints a remote-control join code). `Closes #6783`.

Why: each PR B surface has its own credential / device-reach question (secret values, a bearer join code, a live device read) and deserves a review round of its own; PR A is the larger diff (three route extractions) with none of them. Both PRs edit the same shared class maps and contract files, so B is built on `main` **after** A merges rather than in parallel. The class review below covers all twelve, so PR B starts from settled decisions.

## Facts the triage did not have

1. **`device_function` is an execution-targeting filter.** `filterEngine.ts` (field table ~L216) classes `deviceFunction` as **allowed** for execution-target rules (admin-gated, not agent-set), so a dynamic group keyed on function selects devices for scripts, deployments and policy — and dynamic-group membership feeds an agent's run scope (`triggers.deviceGroupIds`, the W02-D2 `manage_tags` path). A function write therefore changes what runs where. `services/deviceFunction.ts` is the only writer (`upsertDeviceFunction` / `clearDeviceFunction`, manual source wins over the designer's `ai` rows); `device_function_assessments` carry a `users` FK for the writer.
2. **Device events are `audit_logs`.** GET `/devices/:id/events` (devices:read) is the device's audit timeline: rows whose `resource_id` is the device plus rows whose `details->>'deviceId'` is the device, merged; REST returns actor email, IP address and `details` (provenance-redacted).
3. **Agent health** (`device_agent_health_latest` → `agent_health_observations`) is a per-component status snapshot (schema v1) the agent reports; `get_device_details` does not include it today.
4. **Process samples** (`device_process_samples`) are periodic top-process snapshots (name, pid, CPU/RAM; no command line — quorum QW7, `db/schema/devices.ts` ~L627) — device-reported text. REST offers "nearest sample at-or-before `at`" and "timestamps in [`from`, `to`]".
5. **Watchdog logs** are `agent_logs` rows whose `component` starts with `watchdog.` (shipped by `breeze-watchdog` through the agent-log endpoint). `search_agent_logs` already returns them unfiltered; the route only adds the prefix filter. So `source: 'watchdog'` is a pure filter on an existing read.
6. **Management posture** (`services/managementPostureReport.ts`) aggregates other management products detected on devices (RMM/AV/backup agents): per-org counts, and a per-product device drill-down. Scoping is `buildDeviceScope` (org + optional `orgId` + site allowlist); REST has no exact-device axis.
7. **Link groups** (`devices.link_group_id`, `device_link_groups`) mark 2–10 device records as boot profiles of one machine (`multiboot`) or a host and its guests (`vm_host`). Non-destructive: each device keeps its data. They affect only list rendering; nothing targets or alerts by link group. Dissolve (DELETE, devices:**delete** + MFA) unlinks every member; it is undone by linking again.
8. **Manual assets** (`manual_assets`) are hand-entered non-networked inventory rows (org + site, optional contact, serial, purchase date). DELETE (devices:**delete** + MFA) is a **hard delete** (no restore; `retiredAt` via PATCH is the soft path). Link / unlink attaches the row to an agent device or a discovered asset for de-duplication. `created_by` / `updated_by` are `users` FKs.
9. **Warranty refresh calls a vendor.** POST `/devices/:id/warranty/refresh` (devices:write + MFA) queues `queueWarrantySyncForDevice(…, { force: true })`, which sends the device's serial number to the manufacturer's warranty API (Dell / Lenovo / …). It refuses agent-collected devices (HP; `WARRANTY_REFRESH_NOT_AVAILABLE`). The daily sync makes the same call unattended.
10. **Live event-log browse** (PR B): `/system-tools/devices/:id/eventlogs*` (router-level devices:**execute** + MFA + remote-tools policy, `isSensitiveEventLogChannel` → Security log) runs `EVENT_LOGS_LIST` / `EVENT_LOGS_QUERY` / `EVENT_LOG_GET` on the device's agent (30 s timeout) — the same shape as `manage_processes:list` (`TIER2_READONLY_ACTIONS`).
11. **Tenant variables are an execution sink** (PR B). `services/tenantVariableResolution.ts` substitutes `{{var.<key>}}` into every script dispatch (five call sites incl. `aiToolsScripts`) under a system context; an org row shadows a partner-wide row of the same key. Values are encrypted; `isSecret` values are never returned by REST (`toApiTenantVariable`). Writes need `variables:manage` + MFA; partner-wide writes `canManagePartnerWidePolicies`; `created_by` / `updated_by` are `users` FKs.
12. **Support sessions are Quick Support** (PR B). POST `/remote/support-sessions` (remote:access + MFA, **partner scope only**) mints a one-time join code (15 min TTL, `SUPPORT_CODE_TTL_MINUTES`) that an end user enters to download a temporary client, which enrols into the partner's hidden Quick Support org and becomes remote-controllable. **Create names no existing device** — the brief's "out-of-site device refused" for create has nothing to bite on. End (`endSupportSession`) self-destructs the client, revokes its credentials and decommissions the device. Reads are RLS-only (the hidden org's partner).

## Tools and per-action class review

Q1 reversible within a minute? Q2 leaves the tenant / reaches a person / touches a customer machine? Q3 blast radius? Q4 can an agent grant itself authority? t1 = `TIER1_READ_ACTIONS` / tier-1 tool; t2-ro = `TIER2_READONLY_ACTIONS` (live device read: audited, no prompt); t2 = the user approves unless `auto_approve`; sup = tier-3 supervised; 4e = tier-3 four-eyes.

### PR A

| Tool / action | Q1 | Q2 | Q3 | Q4 | Triage | **W13** | Route twin / floor |
|---|---|---|---|---|---|---|---|
| `get_device_events` | read | none | one device | no | read | **t1** | GET `/devices/:id/events`, devices:read |
| `get_device_health` | read | none | one device | no | read | **t1** (separate tool; `get_device_details` unchanged, W13-D2) | GET `/devices/:id/health`, devices:read |
| `get_process_samples` | read | none | one device | no | read | **t1** | GET `/devices/:id/process-samples`, devices:read |
| `search_agent_logs` + `source: 'agent' \| 'watchdog'` | read | none | unchanged | no | read | **t1** (extension, not a REMAP) | GET `/devices/:id/watchdog-logs`, devices:read |
| `get_management_posture` (summary; drill-down with `product`) | read | none | org(s), site-filtered | no | read | **t1** | GET `/devices/management-posture/{summary,devices}`, devices:read |
| `manage_device_function:get` | read | none | one device | no | read | **t1** | GET `/devices/:id/function`, devices:read |
| `manage_device_function:set` (incl. `functionKey: null` clear) | yes (set back) | **device, indirect** (fact 1: an allowed execution-target filter) | one device | **yes** (dynamic groups → run scope) | t2 | **sup** (escalated, fact 1); **agent-human-only action** | PUT `/devices/:id/function`, devices:write + MFA |
| `manage_device_links:list` / `get` / `device` | read | none | org / one group | no | read | **t1** | GET `/devices/link-groups[/:id]`, `/devices/:id/link-group`, devices:read |
| `manage_device_links:create` / `update` | yes (dissolve / update) | none (rendering only, fact 7) | 2–10 devices of one org | no | t2 | **t2** | POST / PATCH `/devices/link-groups[/:id]`, devices:write + MFA |
| `manage_device_links:dissolve` | yes (link again; data untouched) | none | one group | no | t2 | **t2** | DELETE `/devices/link-groups/:id`, **devices:delete** + MFA |
| `manage_manual_assets:list` | read | none | org, site-filtered | no | read | **t1** | GET `/devices/manual`, devices:read |
| `manage_manual_assets:create` / `update` / `link` / `unlink` | yes | none | one record | no | t2 | **t2** | POST / PATCH `/devices/manual[/:id]`, POST / DELETE `/devices/manual/:id/link`, devices:write + MFA |
| `manage_manual_assets:delete` | **no** (hard delete; retire is the soft path) | none | one record | no | t2 | **sup** (escalated: irreversible) | DELETE `/devices/manual/:id`, **devices:delete** + MFA |
| `manage_device_warranty:get` / `expiring` | read | none | one device / org, site-filtered | no | read | **t1** | GET `/devices/:id/warranty`, `/devices/warranty/expiring`, devices:read |
| `manage_device_warranty:refresh` | n/a (a lookup) | **calls a vendor** with the serial (fact 9) | one device | no | t2 ("no tenant data out") | **sup** (escalated: spec rule "nothing that leaves the tenant may be tier 2") | POST `/devices/:id/warranty/refresh`, devices:write + MFA |

### PR B (decided here, built next)

| Tool / action | Q1 | Q2 | Q3 | Q4 | Triage | **W13** | Route twin / floor |
|---|---|---|---|---|---|---|---|
| `browse_device_event_log:list_logs` | read | **device** (live agent command) | one device | no | read | **t2-ro** (`TIER2_READONLY_ACTIONS`, the `manage_processes:list` precedent) | same |
| `browse_device_event_log:query` / `get_event` | read | **device**; event **content** (Security / Application logs can carry credentials and PII) | one device | no | read | **follow the existing event-log content precedent** (`aiGuardrails.ts` ~L220, `aiChatEventLogsReadOnly.ts`: tier 3 except the narrowly pinned interactive System/Setup read-only exception; headless stays tier 3) — quorum QW1 | `/system-tools/devices/:id/eventlogs*`, devices:execute + MFA + remote-tools policy |
| `manage_tenant_variables:list` | read (secret values never returned) | none | org + inherited partner rows | no | read | **t1** | GET `/tenant-variables`, variables:read |
| `…:create` / `update` / `delete` (org row) | create/update yes, delete **no** | **device, indirect** (fact 11: substituted into every script dispatch) | one org | no | t2 | **sup** (escalated, fact 11 — the W12 install-target / custom-field-value precedent) | POST / PUT / DELETE `/tenant-variables[/:id]`, variables:manage + MFA |
| `…:create` (`ownerScope: 'partner'`) | yes (delete) | device, indirect, **every org** | partner-wide | no | sup | **sup** (+ `canManagePartnerWidePolicies`); updating / deleting an EXISTING partner-wide row is refused (W12-D10 pattern) | POST `/tenant-variables`, variables:manage + MFA |
| `manage_support_sessions:list` / `get` | read | none | own partner's sessions | no | read | **t1** | GET `/remote/support-sessions[/:id]`, remote:access + MFA |
| `…:create` | n/a (expires in 15 min) | **reaches a person + a machine** (fact 12: a remote-control join code) | one session | no | sup | **sup**; **agent-human-only action** | POST `/remote/support-sessions`, remote:access + MFA, partner scope |
| `…:end` | **no** (self-destruct command, three credential hashes cleared, device decommissioned — `quickSupportEnd.ts` ~L61) | **customer machine** | one session | no | t2 | **sup** (escalated, quorum QW2); agent proposals allowed | POST `/remote/support-sessions/:id/end`, remote:access + MFA |

**Not built (recorded):** process-sample range markers (`from`/`to` timestamp lists — chart scrubber data, no question needs it); event-feed `details` / actor email / IP (W13-D4); `browse_device_event_log` raw XML (`rawXml`, unbounded, duplicates `message`); writing or reading secret tenant-variable values (W13-D7); the `/eventlogs/:name` single-log info read (a subset of `list_logs`).

### Agent (headless) exposure (spec D4)

| Tool | Exposure |
|---|---|
| every t1 read above | **reachable; skip the allowlist.** Device reads use `deviceArgs`; org lists apply the site and exact-device axes (`get_management_posture`, `manage_manual_assets:list`, `manage_device_links:list`, `manage_device_warranty:expiring`). |
| `manage_device_links` writes, `manage_manual_assets` t2 writes | **reachable** through the `agentTier2` allowlist lane. |
| `manage_manual_assets:delete`, `manage_device_warranty:refresh` | **reachable as proposals** (tier-3 intents released under the agent's own auth). |
| `manage_device_function:set` | **`AGENT_HUMAN_ONLY_ACTIONS`** — fact 1: function selects dynamic-group members, which feed an agent's run scope (`triggers.deviceGroupIds`); the W02-D2 `manage_tags:add/remove` precedent. |
| PR B: `browse_device_event_log` | `list_logs` **reachable read-only** (the `manage_processes:list` precedent); `query` / `get_event` per the existing event-log content precedent (headless tier 3, QW1). |
| PR B: `manage_tenant_variables` writes | **`AGENT_HUMAN_ONLY_ACTIONS`** (create / update / delete) — an agent that can run scripts must not also edit the values those scripts receive. Reads reachable. |
| PR B: `manage_support_sessions:create` | **`AGENT_HUMAN_ONLY_ACTIONS`** — a join code for remote control of a person's machine; no autonomous workflow needs one (a conservative D4 exception, W12 style). `end` reachable as a proposal. |

## Decisions

- **W13-D1 two PRs** (above).
- **W13-D2 `get_device_health` is its own tool.** Folding it into `get_device_details` would change an existing tool's output (the brief forbids overlapping it) and grow every device-detail call.
- **W13-D3 route logic moves verbatim into services** the route and the tool share: `services/deviceEventFeed.ts` (events), `services/deviceLinkGroupOps.ts` (link groups), `services/manualAssetOps.ts` (manual assets), the W12 `{ status, body }` + audit-callback shape. Function, warranty, posture, health and process samples call existing exported services (`deviceFunction.ts`, `warrantyWorker.ts` / `warrantyDataSources.ts`, `managementPostureReport.ts`) or a two-table read.
- **W13-D4 event-feed projection is narrower than REST.** The tool returns id, time, action, message, category, result, actor type + display name, resource, `initiatedBy` and `errorMessage`; **not** actor email, IP address or `details` (personal data and free-form JSON the model does not need to read a timeline). The actor name is the user's name or the actor-type label, **never** the email fallback REST uses (QW7).
- **W13-D5 users-FK writes record a verified user or NULL** (W12-D3 `verifiedUserIdOrNull`): `device_link_groups.created_by`, `manual_assets.created_by` / `updated_by`, the function assessment's writer. No W13 action joins `USER_OWNED_RELEASE_ACTIONS`.
- **W13-D6 MFA parity.** Every PR A write's REST twin carries `requireMfa()` → `MFA_GATED_TOOL_ACTIONS` + `mfaGatedToolError` in the handler.
- **W13-D12 exact-device axis (quorum QW5).** A device-bound session (`allowedDeviceIds`): link-group writes are refused outright (stricter than checking every affected member: a change touches existing members, added / removed ones and any collateral dissolution, and an outright refusal has no lock-ordering window); manual assets have no device axis, so list and writes refuse device-bound sessions; posture, warranty `expiring` and link-group lists put the exact-device predicate in the SQL scope **before aggregation**, so counts cannot leak out-of-axis devices.
- **W13-D7 (PR B) the tool never touches a secret value.** `create` refuses `isSecret: true`; `update` refuses a row that is secret; `isSecret` is not in the update schema. A secret typed into chat would persist in the transcript, the action-intent input and the model context. Reads never return a value for a secret row (`toApiTenantVariable`), and a test greps the serialized tool output for the plaintext.
- **W13-D8 (PR B) support-session scope and the join code (QW3, QW6, QW7).** list / get / create / end are refused to site- or device-restricted sessions (reads are RLS-only and end runs in a system context) and to non-partner scope (REST). The code and the `landingUrl` that embeds it must never enter model context, transcripts, SSE or a plaintext intent result: create is built only on the credential-carrier path (`actionIntents/secretBearingTools.ts`, human-only reveal), or deferred. Views are an explicit projection (no `codeHash`, no `claimedFromIp`; attribution text fenced).
- **W13-D13 (PR B) tenant-variable scope (QW6).** Org writes need `canMutateOrgWideGovernance`; the tool explicitly refuses updating or deleting an existing partner-wide row (the shared service would permit a qualified caller); secret status is rechecked at release.
- **W13-D9 rate limits.** Device reads 40/300 s; writes 20/300 s; `manage_device_warranty` 10/300 s (vendor call); PR B `browse_device_event_log` 15/300 s (the `manage_processes` limit), `manage_support_sessions` 10/300 s.
- **W13-D10 MCP surface (Todd signs off in the PR).** Every tool is new except the additive `search_agent_logs.source`; nothing is lost. Supervised actions are denied over MCP by default (`MCP_APPROVAL_REQUIRED`).
- **W13-D11 fencing.** Every free-text field a tool returns (audit messages / resource names / error messages, health component messages, process names / command lines, link-group names, manual-asset names / notes / locations, warranty product strings, posture product names) is listed in `RAW_TEXT_FIELDS_BY_TOOL`.

### Existing entries, and whether they change (PR A)

| Map | W13 PR A |
|---|---|
| `TOOL_TIERS` (block after W12) | + 8 (reads 1; the four `manage_*` 1) — `search_agent_logs` already there |
| `TIER1_READ_ACTIONS` | + `manage_device_function:get`, `manage_device_links:list/get/device`, `manage_manual_assets:list`, `manage_device_warranty:get/expiring` |
| `TIER2_ACTIONS` | `manage_device_links:create/update/dissolve`, `manage_manual_assets:create/update/link/unlink` |
| `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS` | `manage_device_function:set`, `manage_manual_assets:delete`, `manage_device_warranty:refresh` |
| `TIER3_FOUR_EYES_*`, `DELIBERATELY_UNPINNED`, `EFFECT_DIGEST_RESOLVERS` | unchanged (no four-eyes W13 surface; supervised surfaces carry no digest per the W12 precedent) |
| `AGENT_HUMAN_ONLY_ACTIONS` | + `manage_device_function:set` |
| `MFA_GATED_TOOL_ACTIONS` | every PR A write |
| `TOOL_PERMISSIONS` | per-action rows from each route (dissolve / delete → devices:delete) |
| `mcpCoverage.ts` | burned down: `devices/{events,function,health,links,manual,posture,processSamples,warranty,watchdogLogs}.ts` |

## Budget (W19 bounds; `AI_TOOL_INDEX=lazy`)

| Measure | main `f5742d2eb7` | PR A branch |
|---|---|---|
| Always-on (B1 < 2,560) | 2,494 | 2,494 |
| devices block (B2 < 2,048) | 1,328 | 1,620 |
| largest block | security 1,644 | security 1,644 |
| Worst page turn (B3 < 7,040) | alert 4,872 | alert 5,164 (device 4,210 → 4,502) |

Per tool on the devices line: events 19, health 19, process samples 21, posture 24, function 34, links 66, manual assets 62, warranty 47 B. Every PR A tool joins `devices` (the domain of `get_device_details`, `query_custom_fields` and `manage_processes`). No ceiling, `DOMAIN_NOTES` or vocabulary change; none is `alwaysLoad`. Registry 327 → 335, so `MCP_TOOL_COUNT_APPROX` 320 → 330 (own commit). PR B has 428 B of devices-block headroom. D5 turn-1 token capture not run (AI keys blanked in worktree stacks).

## Quorum (codex `exec`, read-only, xhigh): AGREE WITH CHANGES

- **QW1 (blocking, PR B) event-log content is not blanket t2-ro. ACCEPTED** — `query` / `get_event` follow the existing event-log content precedent; `list_logs` stays t2-ro.
- **QW2 (blocking, PR B) support-session `end` is supervised. ACCEPTED.**
- **QW3 (blocking, PR B) the join code needs a sealed reveal path. ACCEPTED** — W13-D8.
- **QW4 (blocking) manual-asset create / update enable a later vendor lookup** (`warrantySync.ts` ~L199/609 selects eligible manual assets and sends their serials). **DECLINED on the merits, dissent recorded for Todd:** the action itself sends nothing; the egress is the tenant's standing, admin-configured warranty integration, the same one that looks up every enrolled device's serial; the data is a serial number sent to the manufacturer that issued it. `refresh` stays supervised because it calls the vendor on demand, now. If Todd prefers the stricter reading, the change is input-aware escalation of create / update carrying `serialNumber` / `manufacturer` / un-retire.
- **QW5 (blocking) exact-device ceilings. ACCEPTED** — W13-D12.
- **QW6 (blocking, PR B) org-wide governance and partner-wide refusal for tenant variables; restricted-caller refusal for support sessions. ACCEPTED** — W13-D8, W13-D13.
- **QW7 (blocking) projections. ACCEPTED** — no email fallback in actor names (W13-D4); support views explicit (W13-D8); fact 4 corrected (no command line).
- **QW8 remaining classes, the split and the exclusions agreed.**
- **Dissent for Todd:** QW4 (above).

## Tasks

T1 (this doc + quorum) → T4 service extraction, schemas, handlers → T2 guardrail classes → T3 route bindings + permission parity → T5 wiring + index measure → T6 agent catalog → T7 contract rows → T8 web `tierConfig.ts` → T9 docs → T10 prompt-size gate → T11 golden prompts → T12 integration suite → T13 merge main, gates, PR.
