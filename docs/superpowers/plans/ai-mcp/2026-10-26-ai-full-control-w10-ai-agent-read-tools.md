---
tracking_issue: LanternOps/breeze#6754
wave: W10 (#6780)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W09 (#6779, PR #10241) and W19 (#10087) merged to main
branch: feature/6754-ai-full-control/wave-6780
---
# AI full control W10: AI-agent read tools — class review and plan

**Goal:** expose the read halves of the four AI-run route modules the W05 triage tagged `W10` (`devices/aiOrigin.ts`, `aiOperatorTasks.ts`, `aiAgentSchedules.ts`, `fleetDesign.ts`) to chat and MCP with a class that survives the spec's class review **before** the tool is reachable (spec D2). Reads only; every write counterpart is W16 (#6786). Paths are under `apps/api/src/`.

**Verified against** `origin/main` `aa8c1b77d0` (2026-10-26; W09 #10241 merged, `KNOWN_MISSING_TOOL_TIERS` gone).

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | #10241 merged; `KNOWN_MISSING_TOOL_TIERS` absent | yes (comments only) |
| 0.2 | none of the six names in registry / `TOOL_TIERS` / `HUMAN_ONLY_TOOLS`; the four route modules exist | yes / yes |
| 0.3 | no `wave-6780` branch or PR | yes |
| 0.4 | #6780 and #6754 open | yes |

## Facts the triage did not have

1. **Three of the four reads are inline in the route.** `GET /devices/:id/ai-activity` (count query), `GET /ai/operator/tasks` + `/tasks/:id` (list query, detail assembly, `readTaskPlan`) and `GET /ai/fleet-design` (list) hold their query in the handler. To keep one copy of the rules W10 first moves them **verbatim** into services (`deviceAiActivity.ts`, `aiOperator/taskReadQueries.ts`, `fleetDesign/listing.ts`) that the route and the tool both call; the route suites pass unchanged. The schedules read (`listSchedules`), the origin summary (`resolveAiOriginSummary`) and the design detail (`loadFleetDesignReport`) are already services.
2. **Every route in scope is gated on `ai_agents:read`, except the device pair** (`devices:read` + `canAccessDeviceSite`). The tool floors mirror that; `aiGuardrails.routeBinding.contract` reads each floor from the route source.
3. **Operator-task detail carries credential-handover pointers in more than one place (quorum QW1).** For an `identity_onboarding` task the REST detail appends `accounts: CreatedAccountView[]`, whose `intentId`, `revealableByUserId/Name` and `revealExpiresAt` locate the one-time reveal of a newly created account's temporary password (`POST /action-intents/:id/reveal-secret`). The same intent id is also in `operations[].intentId` (the join `credentialHandover.ts` itself uses), `plan[].intentId`, and `waitDependencyId`; the nested `targetAccounts` carry `externalId` and connection ids. The credential itself is never in any projection, but the tool does not need a single pointer: **`get_operator_task` builds its output from an explicit allow-list projection** (`projectTaskDetailForTool`): `accounts` becomes `{ provider, principalLabel, credentialState }`; `operations` drops `intentId` and `executionRef*`; `plan` drops `intentId`; target accounts drop `externalId` / connection ids; `waitDependencyId` is dropped. Stricter than REST, by design. The integration test seeds a sealed result and scans the **serialised tool output byte-for-byte** for the ciphertext, the plaintext, the seal key names, the intent id and the revealer. (The Entra object id still appears inside the coordinator's own event narrative "m365 account <id> (<upn>) frozen", as it does over REST; it is a directory id, not a reveal pointer, and no structured `externalId` field survives. The same holds for the approver's user id inside "plan revision N approved … by user <id>": event narrative is passed through as over REST; every structured actor field is dropped.)
4. **No tool reads `ai_tool_executions`, `action_intents.result`, `ai_operator_tasks.checkpoint`, or step `checkpoint`.** The REST mappers are named-field (never `{ ...row }`) and the detail query names its columns; the tool reuses them unchanged. A contract test pins the tool's output keys.
5. **The REST task site gate has a hole the tool must not inherit (quorum QW2).** `siteVisibilityCondition` admits every task whose root `deviceId` is null, but identity admission creates exactly that shape and then attaches device targets (`taskService.ts:778`); the detail loads all targets, steps, events and plan text with only task/org predicates. A site-restricted human reading REST can therefore see hidden-site device ids and labels. **Decision (W10-D5): both operator-task tools refuse a site- or device-restricted caller outright** (`ACCESS_DENIED`, "organization-wide records"). The unrestricted caller path is the verbatim REST query. The REST hole is pre-existing and out of this wave (no REST behaviour change); filed as a Needs-Todd follow-up.
6. **Fleet Design is an org-wide inventory.** The design enumerates every device function, watch and rule of an org; REST gates it on `ai_agents:read` only (org condition via `loadFleetDesignReport`). A site-restricted caller reading it would see sites they cannot see, so the tool refuses a site- or device-restricted session (as W09 did for shared state). The design markdown is model-generated from device-reported data: fenced as untrusted text and capped; the stored `scripts` the REST detail returns inside `summary` are NOT returned (the tool returns the outcome sections' names/counts and the markdown).
7. **Schedules (quorum QW3).** `listSchedules` strips a partner baseline's `lastRunSummary` for an org caller, but its partner branch passes `includeRunSummary = true` even when the caller reaches only a *selected* subset of the partner's orgs (`partnerOrgAccess = 'selected'`), and that summary aggregates every org under the partner. The tool projection nulls `lastRunSummary` on any partner-owned row unless the caller is `system` or a partner caller with `partnerOrgAccess === 'all'`. A foreign org id is one opaque "not found".
8. **`get_device_ai_activity`** combines the two device routes behind one tool: the count (`GET /ai-activity`) and, when `source` + `sourceId` are given, the authorized origin summary (`GET /ai-origin`). The origin summary is owner-bound for chat transcripts (`getSession`) and omits an id the caller cannot open; the tool relays the DTO as is. Device resolution uses `verifyDeviceAccess` (helper lock, exact-device `allowedDeviceIds` membership, org, site), so a device-bound agent can read its **own** device and nothing else (quorum QW6); `deviceArgs: ['device_id']` lets the executor pre-check it too.

## Class review (Q1 reversible in a minute? Q2 leaves the tenant / reaches a person or device? Q3 blast radius? Q4 agent grants itself authority?)

None of these tools calls a model: they replay stored rows, so the spec's "explain-style = t2" rule (a tool that asks a model to reason) does not apply even where the stored text is model output (`handoffSummary`, `outcomeDetail`, design markdown). That text is fenced as data.

| Tool | Q1 | Q2 | Q3 | Q4 | Triage | **W10** | Agents |
|---|---|---|---|---|---|---|---|
| `get_device_ai_activity` | read | none | one device, count + one origin label | no | read | **t1** | yes (own device for a device-bound agent) |
| `list_operator_tasks` | read | none | one org, site-visible rows, keyset page | no | read | **t1** | **no** |
| `get_operator_task` | read | none | one task; credential pointers removed (fact 3) | no | read | **t1** | **no** |
| `list_ai_agent_schedules` | read | none | one org / partner baselines | no | read | **t1** | yes |
| `list_fleet_designs` | read | none | the caller's orgs (optional `orgId`; ≤100 rows) | no | read | **t1** | yes (unrestricted callers only) |
| `get_fleet_design` | read | none | one org report | no | read | **t1** | yes (unrestricted callers only) |

**Agent exposure of operator-task reads: denied to headless agents through `AGENT_DENIED_READ_TOOLS`** (quorum QW5 — not `AGENT_HUMAN_ONLY_TOOLS`, which is for self-granted authority; Q4 is "no" here). They are ordinary reads whose output is an unbounded prompt-injection channel: `objective`, `handoffSummary`, `outcomeDetail`, step criteria and event details are free text written by humans and by other agent runs, with no device axis to bound an autonomous run. Chat and MCP (the human holds the RBAC permission) keep them. Registered with a written reason; this is the one entry in that map this wave adds and needs Todd's sign-off (listed in the PR).

No W10 action is supervised or four-eyes: nothing is written, nothing leaves the tenant.

## Decisions

- **W10-D1** one PR: three verbatim route extractions + six thin adapters. No migration.
- **W10-D2** all six in the `ai` domain, capability `tenancy` (siblings `list_ai_agent_runs` / `get_ai_agent_run`); measured below.
- **W10-D3** operator-task reads are `AGENT_DENIED_READ_TOOLS` entries (above), not human-only.
- **W10-D4** the task-detail tool is an allow-list projection that drops every credential-handover pointer (fact 3) and reads nothing from `ai_tool_executions`.
- **W10-D5** operator-task and fleet-design reads refuse a site- or device-restricted caller (facts 5, 6). Device and schedule reads keep their route gates; the device read admits a device-bound agent's own device only.
- **W10-D6** every miss, foreign-org id, hidden-site device or malformed id is one "not found" with the same body (the routes' 403 vs 404 split would fingerprint ids); fixtures cover missing, foreign-org, hidden-site and malformed ids.
- **W10-D7** every free-text field, nested included (`label`, `objective`, `targetLabel`, `principalLabel`, `handoffSummary`, `outcomeDetail`, `expectedCriterion`, `detail`, `rendering`, `agentName`, `name`, `markdown`, …), is registered in `RAW_TEXT_FIELDS_BY_TOOL` (quorum QW4) and a test feeds a forged closing delimiter through the fence.

## Measured (W19 bounds; `AI_TOOL_INDEX=lazy`)

| Measure | W09 main | with the 6 tools |
|---|---|---|
| Always-on (B1 < 2,560) | 2,494 | 2,494 |
| `ai` block (B2 < 2,048) | ~198 | 325 |
| Largest block | security 1,268 | security 1,268 (`network` 1,113, `devices` 1,187) |
| Worst page turn, alert (B3 < 7,040) | 4,731 | 4,731 (device 4,069) |
| Legacy whole index (informational) | 9,487 | 9,614 |

All six sit in the `ai` domain, capability `tenancy`; no ceiling, `DOMAIN_NOTES` or vocabulary change. `MCP_TOOL_COUNT_APPROX` 296 -> 310 (registry 310; the ±10 pin went red at +14 against W08's value, own commit).

## Quorum (codex `exec`, read-only, xhigh): AGREE WITH CHANGES

- **QW1 credential-pointer redaction is incomplete (`operations[].intentId`, target accounts). ACCEPTED** — fact 3, allow-list projection, byte scan.
- **QW2 the task site gate misses device targets in the task graph. ACCEPTED** — fact 5, W10-D5.
- **QW3 schedules leak partner-wide aggregates to selected-org partner callers. ACCEPTED** — fact 7.
- **QW4 injection contract needs every untrusted string, nested, fenced. ACCEPTED** — W10-D7.
- **QW5 use the read-denial registry, not human-only. ACCEPTED** — exposure paragraph.
- **QW6 device-agent exposure contradicted the exact-device refusal. ACCEPTED** — fact 8.
- **QW7 (weak) tier above 1 is not justified; fix the "one org" Q3 text. Agreed** — all six stay t1, table corrected.
- **QW8 (weak) no direct sealed-result / checkpoint leak. Agreed** — the pointer finding (QW1) is the real one.
- **QW9 (weak) 403/404 already collapsed. Agreed** — W10-D6 now requires identical bodies and fixtures.
- **Dissents: none** (every accepted item tightens; nothing loosens relative to REST except the single `AGENT_DENIED_READ_TOOLS` addition, which is stricter for agents).

## Tests

`aiToolSchemas.aiReads.test.ts` (registry / Zod / action parity), `aiToolsAiReads.test.ts` (projection, redaction keys, restricted callers, opaque not-found, pagination), route-binding rows, class rows, agent catalog rows, +3 golden prompts, and `aiToolsAiReadsScope.integration.test.ts` with guard-flip controls (out-of-site device, other-org task, sealed handover byte scan, fleet-design visibility).

## Follow-ups (not filed)

- Write counterparts (schedule CRUD, operator task create, Fleet Design run / apply / rollback, patch plan): W16 (#6786).
- A paged event timeline for very long tasks (the detail caps events at the newest 500 like the route).
