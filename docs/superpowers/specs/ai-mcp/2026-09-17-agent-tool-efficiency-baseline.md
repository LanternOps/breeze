---
tracking_issue: LanternOps/breeze#6147
---
# Agent Tool Efficiency — A-W01 Baseline

**Date measured:** 2026-09-19 · **Branch:** `feature/6147-agent-tool-efficiency/wave-6148` @ `70116bb709` · **Plan:** `2026-09-17-agent-tool-efficiency-a01-baseline-harness.md` Task 9

All measurements below were produced locally against the real Anthropic API (no dev stack, no prod DB). Every cell is either a measured number with the source line/file, or `not run: <reason>`.

## 1. What was measured and how

- **Harness:** `pnpm --filter @breeze/api ai:tool-capture` (`apps/api/src/services/llm/__scripts__/tool-capture.ts`) drives `runSurfaceCapture` (`toolCapture/runSurface.ts`), which calls `query()` from `@anthropic-ai/claude-agent-sdk` with each surface's real `allowedTools`/`onlyTools` from `CAPTURE_SURFACES` (`toolCapture/surfaces.ts`).
- **Deny mode:** every `createBreezeMcpServer`/`createScriptBuilderMcpServer` handler is wrapped in `onPreToolUse: denyPreToolUse`, which refuses at the handler level *before* `getAuth()` or any DB access runs (`runSurface.ts:11-27`). This means every capture is safe to run with no seeded org/device data and no live DB — a tool call is attempted, observed, and denied; no side effects. `DATABASE_URL` is only required because module-load-time registry imports touch `../../../db`; it is never queried in deny mode. A `result` message with a non-`success` subtype (e.g. `error_max_turns`, because every tool attempt is refused) is expected, not a harness failure.
- **`--proxy`:** starts a local HTTP proxy (`toolCapture/captureProxy.ts`) in front of `ANTHROPIC_BASE_URL` and records `tools[]` length, `defer_loading` per tool, `system` field byte length, and usage from each `/v1/messages` request. **Trap found while running this task:** the proxy also captures the CLI's own `/api/hello` handshake and a small Haiku `/v1/messages` call the CLI issues first (title/summary generation) — both have `tools: []`. The script's console-table renderer picks `proxyRequests[0]`, which is one of these non-tool-call requests, so the printed "tools sent"/"deferred" columns show `0`/`null` even when the real Sonnet call carried tools. This is a **display-only** bug in the console summary; the JSONL itself has the full `proxyRequests` array with every request in order, so this doc's numbers below were read directly from the JSONL (the correct Sonnet `/v1/messages` record — 3rd request in each turn's window), not from the printed table. Not fixed in code this run: it does not affect what is measured, only what the ad hoc CLI table prints, and the plan's Task 9 scope is measurement + doc, not harness hardening. Flagging as a known follow-up for A-W02+ (`runSurfaceCapture`'s consumer should filter `proxyRequests` to `model !== null && tools.length > 0` rather than index `[0]`).
- **`--tool-search on|off`:** sets `ENABLE_TOOL_SEARCH=true|false` in the child env before spawning the CLI subprocess; **required** with `--proxy` because the local proxy is not a first-party Anthropic host and the SDK silently disables tool search's default-on behavior against a non-default base URL (`tool-capture.ts` `UsageError` guard).
- **SDK / CLI:** `@anthropic-ai/claude-agent-sdk@0.3.277` (installed, `apps/api/node_modules/@anthropic-ai/claude-agent-sdk/package.json`).
- **Model:** `resolveDefaultModel()` resolved to `claude-sonnet-4-6` for all captures and the eval; the CLI additionally issues one `claude-haiku-4-5-20251001` call per turn for its own title/summary purpose (see proxy trap above) — this is CLI overhead, not something Breeze's code requests.
- **`AI_SYSTEM_PROMPT_BASE` bytes:** `Buffer.byteLength(AI_SYSTEM_PROMPT_BASE)` = **12265 bytes** (captured field `systemPromptBytes` in every JSONL row; also printed by `ai:tool-eval`'s summary line). The wire `system` field (JSON-stringified, as sent to the API) is 12640 bytes (proxy `systemBytes` field) — the delta is JSON string-escaping overhead, not extra content.
- **Raw output:** `tool-capture.jsonl` (7 rows: chat×2 proxy modes, helper-standard, helper-basic, agent-full, script-builder ×1 turn each) and `tool-eval-report.json` / `tool-eval-summary.md` (60/60 golden cases, chat surface, default tool search), all under the run's scratchpad `measure/` directory (not committed — JSONL/report files are run artifacts, not source).
- **Not run this session:** BYO `--base-url` endpoint (no BYO catalog credentials available in this environment — Todd owns those), `--turns 2` for every surface (only `chat` was run at 2 turns per the plan's cache-read-share ask; the other surfaces were run at `--turns 1` per this task's instructions), prod hot/cold SQL (needs Todd's DB access, see §4), `curl` against a live dev stack's external MCP `tools/list` (no stack running — see §6).
- **Env-gating caveat:** every tool count in this doc (117 for the full chat/agent-full registry) was measured with `M365_ENABLED`, `DELEGANT_BASE_URL`, `GOOGLE_WORKSPACE_ENABLED`, and `BREEZE_AI_SCRIPT_AUTHORING_ENABLED` all unset. 117 is the **floor** for a default install, not a ceiling: a fully configured chat surface registers roughly 34 more tools (25 `google_*`, 5 `m365_*`, and the script proposal tools), since `buildBreezeSdkTools` (`aiAgentSdkTools.ts`) conditionally spreads in `googleToolDefinitions`/`aiToolsM365`/`scriptProposalToolDefinitions` at call time — none of which are static `TOOL_TIERS` entries. `runSurfaceCapture` (`toolCapture/runSurface.ts`) now derives `registeredToolCount`/`registeredToolNames` from `buildBreezeSdkTools(...).filter(onlyTools)` under the harness's actual env, not from `Object.keys(TOOL_TIERS).length`, so a future capture run against a fully configured environment will show the higher number automatically.

## 2. Tool search: on or off today?

| Surface | `ENABLE_TOOL_SEARCH` | ToolSearch seen | Tools sent (proxy) | Deferred (proxy) | Turn-1 `input_tokens` | `cache_creation` | `cache_read` | Turn-2 `cache_read` share | TTFT ms |
|---|---|---|---|---|---|---|---|---|---|
| chat | on (forced by proxy) | uses=0, blocks=0, refs=0, stderr=0 | 117 | 0 | 4 | 55971 | 55842 | not run: only 1 turn captured with `--tool-search on/off` (2-turn capture was run without `--tool-search`/`--proxy`, see row below) | 2535 |
| chat | off (forced by proxy) | uses=0, blocks=0, refs=0, stderr=0 | 117 | 0 | 4 | 0 | 111813 | see above | 1480 |
| chat (default, no proxy, 2 turns — cited from task brief, not re-run this session) | unset (SDK default) | reported: not seen | not run: no `--proxy` on this citation | — | 4 | 10241 | 101618 | turn 2: input=3, cache_create=177, cache_read=56012 → **56012 / (3+177+56012) = 99.7%** | 2667 |
| helper-standard | unset (SDK default) | uses=0, blocks=0, refs=0, stderr=0 | not run: no `--proxy` | — | 4 | 10266 | 101640 | not run (1 turn) | 1673 |
| helper-basic | unset (SDK default) | uses=0, blocks=0, refs=0, stderr=0 | not run: no `--proxy` | — | 4 | 0 | 111906 | not run (1 turn) | 1476 |
| agent-full | unset (SDK default) | uses=0, blocks=0, refs=0, stderr=0 | not run: no `--proxy` | — | 4 | 157 | 111738 | not run (1 turn) | null (agent-full has `includePartialMessages: false`, so no streaming TTFT is observable) |
| script-builder | unset (SDK default) | uses=0, blocks=0, refs=0, stderr=0 | not run: no `--proxy` | — | 3 | 12804 | 0 | not run (1 turn); no tool call this turn (`first tool: null`) | 1201 |
| `byo:<host>` | — | — | — | — | — | — | — | — | not run: no BYO catalog endpoint/credentials available this session |

This session's own `chat`/`--tool-search on` proxy run shows different cache numbers (`cache_create=55971 cache_read=55842`) than the task brief's earlier, un-proxied 2-turn run (`cache_create=10241 cache_read=101618`) for the same "turn 1" label — Anthropic's prompt cache is a live, shared, TTL'd resource, not a harness constant, and the earlier run's higher cache-read number likely reflects a warmer cache from prior activity against the same account. Compare shape (input tokens near-zero, cache dominating) rather than exact digits across runs.

**Answer to the spec's question ("is tool search already on, and where does it silently fall back or fail?"):** Tool search is **not observed as active anywhere** on the first-party path today. Across every surface and every `--tool-search` setting tested (including forcing `ENABLE_TOOL_SEARCH=true` through the proxy), `ToolSearch seen` reports `uses=0, blocks=0, refs=0, stderr=0`, and the proxy shows all 117 tools sent with `defer_loading: false` on every one — even under `--tool-search on`. Breeze's registry (117 tools for the full chat/agent-full surface) sits well under whatever count triggers the SDK's automatic deferral; nothing in this codebase currently sets `searchHint`/`alwaysLoad`/per-tool `defer_loading` to opt in explicitly. So the finding is: tool search is not silently falling back on a BYO/non-default host (that path is untested — no BYO endpoint available) — it simply never engages on the default host either, because nothing asks for it. This matches the design doc's suspicion (`2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md`: "Breeze sets none of it and has never measured whether it is active") and answers it: confirmed inactive, not silently degraded.

## 3. Golden eval

Run: `pnpm --filter @breeze/api ai:tool-eval -- --out tool-eval-report.json --summary-md tool-eval-summary.md` (chat surface, default tool search, `claude-sonnet-4-6`, all 60 cases, deny mode). Completed in ~2 minutes — not a partial run.

**Overall: 19/60 = 31.7%** (`tool-eval-summary.md` header line 1; `tool-eval-report.json` `summary.hits=19, summary.total=60, summary.accuracy=0.3167`).

**Only `chat` was run** (per this task's instructions, which asked for the 60-case chat-surface default run, not the plan's full per-surface/per-mode matrix); `helper-standard` accuracy and the Haiku 4.5 row (spec open decision 2) are `not run: out of scope for this pass — see plan Task 9 §3 for the fuller matrix Todd/A-W04 should run`.

**The task brief's "21 golden-case expected tools are registered but undeclared for chat" is a one-off from the actual count: it is 21 *exception-list entries* (`PENDING_DECLARATION` = `search_documentation`, 1 tool — A-W02 Task 5 will declare it; `BASELINE_UNDECLARED_TOOLS` = 20 pre-existing #3300 gaps: `browse_snapshots`, `get_backup_status`, `get_compliance_status`, `get_executive_summary`, `get_ip_history`, `get_network_changes`, `get_peripheral_activity`, `get_sensitive_data_overview`, `get_sla_breaches`, `get_sla_compliance_report`, `get_software_compliance`, `list_monitors`, `manage_quotes`, `manage_tags`, `manage_tickets`, `query_agent_versions`, `query_backups`, `restore_snapshot`, `search_script_library`, `trigger_backup`, `trigger_mssql_backup`), but **22 distinct tool names actually appear in `GOLDEN_CASES[].expect[].tool`** when cross-referenced against those two sets (verified by loading `GOLDEN_CASES` directly and intersecting) — every one of the 21 exception-list entries is used by at least one golden case (as `goldenPrompts.test.ts`'s "unused exception" check requires), and no case uses more than one, so the +1 is simply that the exception list and the used-tool list are the same size (21) plus... on direct recount there are 22 because `search_documentation` (`PENDING_DECLARATION`) plus all 20 `BASELINE_UNDECLARED_TOOLS` entries are each referenced by at least one case = 21, and the 22nd is `get_sla_compliance_report`, which is referenced by g26's `expect[]` in addition to `get_sla_breaches` — i.e. 21 distinct exception-list tool names, 22 counting a golden case that names two of them. These tools (all 21) are absent from `TOOL_TIERS`, so they get no system-prompt domain-index promotion — see the reachability caveat below.

**Correction (this session):** the framing above conflated two different things — "has at least one undeclared expected tool" (20 cases) with "structurally unwinnable" (a stricter, smaller set). The right question is whether EVERY tool in a case's `expect[]` is undeclared, since a case with even one declared alternate is winnable through ordinary system-prompt promotion. Cross-referencing `GOLDEN_CASES[i].expect[].tool` against `PENDING_DECLARATION ∪ BASELINE_UNDECLARED_TOOLS` with an "every, not some" filter (frozen by `goldenPrompts.test.ts`'s "freezes the structurally-unwinnable-on-chat case set" test) gives exactly **10 structurally unwinnable cases**: `g23, g26, g34, g35, g36, g49, g55, g59, g60` (g57 became winnable once A-W02 declared `search_documentation`) — ceiling **50/60 = 83.3%** on chat until A-W02/A-W06 declares those tools. The other 10 of the original 20 (`g16, g24, g25, g27, g29, g32, g37, g51, g53, g54`) each have at least one *declared* tool among their acceptable answers and are winnable today through ordinary prompt-level promotion. In particular, `query_monitors` (g51) and `get_fleet_health` (g54) **are declared** in `TOOL_TIERS` (tiers 1 and 1 respectively, `aiAgentSdkTools.ts`) — the earlier framing that these were "undeclared tools that hit anyway, showing undeclared doesn't mean unreachable" was simply wrong; they hit because they are declared, not despite not being declared. (`get_sla_breaches`, which g26 hit on, genuinely is undeclared, but g26 is one of the 10 structurally-unwinnable cases precisely because its only other acceptable answer, `get_sla_compliance_report`, is also undeclared.)

**Accuracy excluding structurally-unwinnable cases:** filtering `tool-eval-report.json`'s 60 cases down to the 50 winnable ones (excluding `g23, g26, g34, g35, g36, g49, g55, g59, g60` (g57 became winnable once A-W02 declared `search_documentation`)) leaves **18 hits / 50 = 36.0%** (vs. 31.7% unfiltered, 19/60). This replaces the earlier 16/40 figure, which used the wrong (looser) exclusion set. This is the fairer baseline number for judging real tool-selection quality and for A-W04's "+10 points" success measure.

**Misses table** (verbatim from `tool-eval-summary.md`, 41 rows — id / prompt / expected / observed):

| id | prompt | expected | observed |
| --- | --- | --- | --- |
| g03 | Is CPU on FS-01 pegged? Show the last hour. | analyze_metrics, resolve_device_context | query_devices |
| g05 | Acknowledge the disk-space alert on ACME-DC1, I am on it. | manage_alerts.acknowledge, resolve_device_context | query_devices |
| g07 | Which machines are still missing the September cumulative update? | manage_patches.list | manage_patches.compliance |
| g10 | List the CVEs on WEB-03. | get_device_vulnerabilities, resolve_device_context | query_devices |
| g12 | Run a CIS benchmark check on the finance server. | get_cis_compliance, get_cis_device_report, resolve_device_context | query_devices |
| g13 | Search the logs on PRINT-SRV for spooler crashes today. | search_logs, resolve_device_context | query_devices |
| g14 | Restart the Print Spooler service on PRINT-SRV. | manage_services.restart, resolve_device_context | query_devices |
| g15 | Run "ipconfig /all" on LAB-WS-042. | execute_command, resolve_device_context | query_devices |
| g16 | Do we have a script that clears the Teams cache? | list_scripts, search_script_library | workspace_run |
| g17 | Run the "Clear Teams cache" script on every machine at Northwind. | run_script, list_scripts, query_devices | list_organizations |
| g19 | What is eating the disk on ACME-DC1? | analyze_disk_usage, resolve_device_context | query_devices |
| g20 | Free up space on ACME-DC1 — temp files, update leftovers, the usual. | disk_cleanup, analyze_disk_usage, resolve_device_context | query_devices |
| g21 | Who is logged on to RDS-02 right now? | get_active_users, resolve_device_context | query_devices |
| g22 | Take a screenshot of what the user on KIOSK-1 sees. | take_screenshot, resolve_device_context | query_devices |
| g23 | Did last night's backups succeed for Contoso? | get_backup_status, query_backups | list_organizations |
| g24 | Restore yesterday's copy of the Finance share on FS-01. | browse_snapshots, restore_snapshot, resolve_device_context | No tool call |
| g25 | Kick off a backup of SQL-01 now. | trigger_backup, trigger_mssql_backup, resolve_device_context | query_devices |
| g27 | What new devices showed up on the Contoso network this week? | get_network_changes, network_discovery | list_organizations |
| g28 | Scan the 10.20.0.0/24 subnet at Northwind. | network_discovery | list_organizations |
| g29 | What IPs has LAB-WS-042 had this month? | get_ip_history, resolve_device_context | query_devices |
| g30 | Is DNS filtering on for Contoso? | get_dns_security, manage_dns_policy | list_organizations |
| g31 | Add the three new laptops to the "Sales" device group. | manage_groups.add_devices, manage_groups.list, query_devices | No tool call |
| g32 | Tag WEB-03 as "pci". | manage_tags, resolve_device_context | No tool call |
| g34 | Open a ticket: Northwind reports slow email since Monday. | manage_tickets | No tool call |
| g35 | Log 45 minutes on ticket 1042 for the printer fix. | manage_tickets.log_time_entry | No tool call |
| g36 | Start my timer on ticket 1042. | manage_tickets.start_timer | No tool call |
| g37 | Draft a quote for 25 M365 Business Premium seats for Contoso. | manage_quotes, search_catalog | list_organizations |
| g39 | When does the Contoso managed-services contract renew? | list_contracts, get_contract, manage_contracts | list_organizations |
| g41 | Show me the Microsoft 365 users at Contoso without MFA. | m365_query_users | list_organizations |
| g42 | Any risky sign-ins at Contoso in the last 24 hours? | m365_query_signins | list_organizations |
| g43 | Which Contoso devices are non-compliant in Intune? | m365_query_intune_devices | list_organizations |
| g45 | Isolate WEB-03 in SentinelOne. | s1_isolate_device, resolve_device_context | query_devices |
| g47 | Which configuration policies apply to the Contoso servers? | list_configuration_policies, get_effective_configuration | list_organizations |
| g49 | Which software is banned by policy but still installed somewhere? | get_software_compliance, get_compliance_status | manage_software_policies.list |
| g50 | When is the next maintenance window for Northwind? | manage_maintenance_windows | list_organizations |
| g53 | Generate a monthly health report for Contoso. | generate_report, get_executive_summary | list_organizations |
| g55 | Which agents are running an old version? | query_agent_versions | query_devices |
| g56 | Pull the agent logs from LAB-WS-042, it keeps disconnecting. | search_agent_logs, resolve_device_context | query_devices |
| g57 | How do I set up a maintenance window in Breeze? | search_documentation | manage_maintenance_windows.list |
| g59 | Any USB storage plugged in at Contoso this week? | get_peripheral_activity | list_organizations |
| g60 | Where is Contoso keeping credit-card numbers in files? | get_sensitive_data_overview | list_organizations |

Note the dominant miss pattern is **not** wrong-domain confusion: the model very often calls `query_devices` or `list_organizations` as an exploratory first step (get context, then act) rather than jumping straight to the specific action tool the golden case names — e.g. g03/g05/g10/g12/g13/g14/g15/g19/g20/g21/g22/g25/g29/g45/g55/g56 all observed `query_devices` against an `expect` that starts with a more specific tool (or `resolve_device_context`). This is a real accuracy signal (deny mode means the model never gets a real device match back to justify the broader call), not a harness artifact.

### 2026-09-21 — A-W03 Task 7: re-measured baseline + after (production-prompt harness)

The numbers above (31.7%/19-60, measured 2026-09-19) predate PR #6405, which fixed the harness to send each surface's real production system prompt (`composeStaticSystemPrompt`) instead of `AI_SYSTEM_PROMPT_BASE` alone. That changed what the model actually sees, so the old row is not a valid comparison point for A-W03's "accuracy did not drop" gate. Both rows below were produced with the **same**, post-#6405 harness (`ai:tool-eval`, `chat` surface, `--tool-search default`, `claude-sonnet-4-6`, all 60 golden cases, deny mode, `GITHUB_ACTIONS`/`AI_TOOL_EVAL_KEY` via `.github/workflows/ai-tool-eval.yml`, `workflow_dispatch`), so they are directly comparable to each other even though they are not directly comparable to the 2026-09-19 row.

| Branch | Run | Commit | Hits/Total | Accuracy | `systemPromptBytes` |
|---|---|---|---|---|---|
| `main` (pre-A-W03 descriptions) | [run 35633528749](https://github.com/LanternOps/breeze/actions/runs/35633528749) | `main` @ dispatch time 2026-09-21 | 18/60 | 30.0% | 11347 |
| `feature/6147-agent-tool-efficiency/wave-6150` (A-W03 description diet) | [run 35633521176](https://github.com/LanternOps/breeze/actions/runs/35633521176) | `21926244d` | 20/60 | 33.3% | 10906 |

**Gate: accuracy must not drop vs. the same-harness baseline.** 33.3% (20/60) ≥ 30.0% (18/60) → **PASS** (+2 hits). `systemPromptBytes` also dropped 441 bytes (11347 → 10906), consistent with the description diet shrinking the static prompt while the moved disambiguation prose lands in the generated tool index (included in `systemPromptBytes` on both runs, since both are measured via the same `composeStaticSystemPrompt` path).

Full miss tables for both runs are in the workflow run artifacts (`tool-eval-report.json`, `tool-eval-summary.md`; 90-day retention) linked above; not reproduced here as the per-case rows are identical in method to §3's table above and add no new information beyond the summary row.

## 4. Hot/cold (90 days, EU + US)

**Measured 2026-09-23.** The operator ran the SQL from `toolUsageReportSqlText(90)` in `apps/api/src/services/aiToolUsageReport.ts`, a superset of `sql/2026-09-17-ai-tool-usage-90d.sql` that adds the delivered-size columns. It ran read-only (`SET TRANSACTION READ ONLY` plus a `breeze.scope=system` election) against both managed production databases. Ranking follows the `hotForShaping` rule: chat and Helper rows only, scored `executions × delivered_bytes_p50` and summed across regions.

**Volume is low, so treat this ranking as a rough signal.** There were 1,069 tool executions in 90 days:

| Surface | US | EU |
|---|---|---|
| chat | 671 | 10 |
| helper | 84 | 250 |
| agent | 32 | 0 |
| script_builder | 22 | 0 |

US used 57 distinct tools and EU used 33.

| # | Tool | Calls (chat+helper) | Max-region p50 bytes | Max-region p95 bytes | Score | Shaped in A-W05 |
|---|---|---|---|---|---|---|
| 1 | `get_device_details` | 46 | 7468 | 7835 | 324114 | yes |
| 2 | `query_change_log` | 45 | 6516 | 8109 | 235560 | yes |
| 3 | `query_audit_log` | 8 | 7704 | 8145 | 61392 | yes |
| 4 | `analyze_metrics` | 19 | 5140 | 5172 | 48857 | no |
| 5 | `get_log_trends` | 8 | 5602 | 5798 | 43974 | no |
| 6 | `disk_cleanup` | 6 | 7120 | 7485 | 40524 | no |
| 7 | `search_logs` | 99 | 1997 | 7556 | 40371 | no |
| 8 | `get_fleet_health` | 18 | 2005 | 7859 | 35770 | no |
| 9 | `analyze_boot_performance` | 6 | 4237 | 4299 | 24922 | no |
| 10 | `execute_command` | 234 | 464 | 2051 | 24133 | no |
| 11 | `get_effective_configuration` | 11 | 2940 | 3222 | 20400 | no |
| 12 | `get_security_posture` | 10 | 2227 | 5628 | 20066 | yes |
| 13 | `list_playbooks` | 5 | 4293 | 4293 | 17201 | yes |
| 14 | `manage_patches` | 88 | 2504 | 7259 | 13543 | yes |
| 15 | `search_documentation` | 2 | 6110 | 6571 | 12220 | no |
| 16 | `query_devices` | 23 | 485 | 2692 | 11025 | yes |
| 17 | `get_configuration_policy` | 4 | 3332 | 5405 | 9797 | no |
| 18 | `manage_alert_rules` | 6 | 2529 | 2529 | 7677 | no |
| 19 | `manage_policy_feature_link` | 16 | 535 | 1187 | 6769 | no |
| 20 | `manage_startup_items` | 1 | 5019 | 5019 | 5019 | no |

The byte columns take the higher of the two regions' per-surface values.

**What this says about the A-W05 20-tool list (§7.1):**
- **Confirmed hot:** A-W05 shaped the top 3 (`get_device_details`, `query_change_log`, `query_audit_log`) and 7 of the top 20 overall.
- **Hot but not shaped:** 7 tools: `analyze_metrics`, `get_log_trends`, `disk_cleanup`, `search_logs`, `get_fleet_health`, `analyze_boot_performance`, `get_effective_configuration`. Tracked in #6745.
- **Deliberately skipped:** `execute_command` ranks 10th only on call volume. Its median output is under 500 bytes.
- **Shaped but cold in production:** `list_scripts`, `get_device_vulnerabilities`, `manage_alerts`, `search_agent_logs`, `list_organizations`, `list_configuration_policies`, `get_script_execution`, `get_cis_compliance`. They stay shaped, since shaping them caused no regression, but they were a lower priority than the survey assumed.
- **Never called, because chat can't call them:** `manage_tickets`, `list_monitors`, `list_ai_agents`, `get_incident_timeline`, `get_active_users`.
  - The first four have no `TOOL_TIERS` entry. Either they sit in the frozen `KNOWN_MISSING_TOOL_TIERS` baseline, or they postdate this measurement window. Chat's pre-tool gate rejects them as unknown, so a zero count here shows a wiring gap, not a lack of demand.
  - `get_active_users` does have a tier and was simply not called in the window.
  - MCP usage can't be ranked: the MCP ledger keeps only a 500-char summary (Q10).

## 5. Inputs to A-W04

§4 now has measured data, and the hot list for the `alwaysLoad` intersection is the §4 table. The Haiku and BYO rows below are still `not run`. The plan's Task 9 makes A-W04's `alwaysLoad` set, the Helper `onlyTools` recommendation, and the BYO fallback decision each derive from the hot/cold list intersected with the context-tool set — none of which exists without §4's data. What this session can contribute instead:

- **Haiku decision (spec open decision 2):** `not run` — the plan calls for a `--model claude-haiku-4-5-20251001` eval row to decide this; out of scope for this task's instructed command set (chat/default only). Left for A-W04 alongside the full per-surface/per-mode eval matrix.
- **BYO fallback decision:** `not run` — no BYO endpoint/credentials available to test whether `tool_reference` is rejected.
- Qualitative candidate for `alwaysLoad`, **not a substitute for the hot-list intersection**: `resolve_device_context` and `query_devices` are the two tools the golden eval's model reaches for as a first exploratory step across most device-scoped prompts (§3), which is suggestive but not a measured hot-list — do not treat this as the A-W04 input; it is only a hint pending §4.

## 6. Success-measure baselines (spec "Success measures" section, as measured today)

| Success measure | Baseline (today) | Source |
|---|---|---|
| Web chat first-turn input tokens | **4** (`input_tokens`, turn 1, chat surface) | `tool-capture.jsonl` row 0 (`--surface chat --proxy --tool-search on`), `observation.apiCalls` reduced; also seen as 4 across every surface's turn-1 row this session |
| Cache-read share of input, turn 2+ | **99.7%** (`56012 / (3 + 177 + 56012)`), chat surface, 2-turn no-proxy capture (per the task brief's stated numbers: turn 2 input=3, cache_create=177, cache_read=56012) | Task brief's supplied first-run numbers (this session's own `--proxy` runs only went 1 turn per surface except the on/off `chat` pair, which also went 1 turn; the 2-turn number is the one already on record from the prior run referenced in this task's instructions, reproduced here as the baseline since re-running it added no new information) |
| Golden eval first-call accuracy | **31.7%** unfiltered (19/60); **36.0%** excluding the 10 structurally-unwinnable cases (18/50) | `tool-eval-summary.md` line 1; `tool-eval-report.json` `summary`; §3 above |
| System prompt bytes | **12265 bytes** (`AI_SYSTEM_PROMPT_BASE`, `Buffer.byteLength`) — well over the ≤6 KB target, and this is the *base* prompt only (before any per-request additions) | `tool-capture.jsonl` `systemPromptBytes` field (every row); `tool-eval-report.json` `systemPromptBytes`; `apps/api/src/services/aiAgentSystemPrompt.ts:17` |
| External `tools/list` bytes for a single-domain grant | `not run: no dev stack running this session (no docker/postgres up in this worktree) to `curl` the external MCP server (`routes/mcpServer.ts`) with a live `ai:read` key.` | — |
| Route modules without an `MCP_COVERAGE` entry | **504 of 504** (all of them) — `grep -rn "MCP_COVERAGE" apps/api/src` returns zero matches anywhere in the codebase, and `find apps/api/src/routes -name "*.ts" ! -name "*.test.ts"` counts 504 non-test route module files | ad hoc grep/find this session; the contract this measure refers to (`MCP_COVERAGE`) does not exist until A-W06 |
| Golden eval first-call accuracy (2026-09-21, A-W03 Task 7, post-#6405 harness) | `main` (same-harness baseline): **30.0%** (18/60); `wave-6150` (after description diet): **33.3%** (20/60) — gate PASS, +2 hits | Workflow runs [35633528749](https://github.com/LanternOps/breeze/actions/runs/35633528749) (main) and [35633521176](https://github.com/LanternOps/breeze/actions/runs/35633521176) (`21926244d`); §3 above |
| System prompt bytes (2026-09-21, post-#6405 production-prompt harness) | `main`: **11347 bytes**; `wave-6150`: **10906 bytes** (−441 bytes) | Same two runs, `tool-eval-report.json` `systemPromptBytes`; not comparable to the 12265-byte `AI_SYSTEM_PROMPT_BASE`-only row above, which predates #6405 and measured a different (smaller) prompt surface |

## Appendix: raw capture rows (from `tool-capture.jsonl`, this session)

| surface | turn | proxy | tool-search | input | cache_create | cache_read | ttft ms | first tool | result |
|---|---|---|---|---|---|---|---|---|---|
| chat | 1 | on | on | 4 | 55971 | 55842 | 2535 | mcp__breeze__query_devices | success |
| chat | 1 | on | off | 4 | 0 | 111813 | 1480 | mcp__breeze__query_devices | success |
| helper-standard | 1 | off | default | 4 | 10266 | 101640 | 1673 | mcp__breeze__query_devices | success |
| helper-basic | 1 | off | default | 4 | 0 | 111906 | 1476 | mcp__breeze__query_devices | success |
| agent-full | 1 | off | default | 4 | 157 | 111738 | null | mcp__breeze__query_devices | success |
| script-builder | 1 | off | default | 3 | 12804 | 0 | 1201 | (none) | success |

## 7. Output efficiency (A-W05)

**Date measured:** 2026-09-22 · **Branch:** `feature/6147-agent-tool-efficiency/wave-6152` · **Plan:** `2026-09-17-agent-tool-efficiency-a05-output-efficiency.md`

### 7.1 The 20-tool before/after table

"Today" is the plan's pre-wave survey (§"The 20 tools" of the A-W05 plan, `9b8189c1df`). "After (measured)" is each tool's own `*.outputShape.test.ts`/`aiToolsPerformance.test.ts`/`aiToolsScripts.getExecution.window.test.ts` fixture, printed by `expectDefaultPageFits`'s `[output-budget]` log line (`aiToolOutputBudget.testkit.ts:37`) via `cd apps/api && npx vitest run outputShape --reporter=verbose | grep '\[output-budget\]'` (console output is silent under the default reporter — `--reporter=verbose` is required to see it) plus a direct run of the two non-`outputShape`-named files. All 20 pass `expectDefaultPageFits` (default page < `MAX_TOOL_RESULT_CHARS` = 8000, uncompacted) against a **realistic** fixture; several tools additionally carry a worst-case fixture proving compaction degrades honestly (`hasMore`/`nextCursor` survive) rather than falling through to a full digest — see 5b's follow-up commit below.

Several defaults were lowered below the plan's provisional table where a realistic fixture page still overflowed 8000 chars; those are called out in the "Default" column as `plan→final`.

| # | Tool | Group | Today (pre-wave) | Mode | Default (plan→final) | Max | Measured default page (chars) |
|---|---|---|---|---|---|---|---|
| 1 | `query_devices` | 5a | `{devices, total, showing}`, limit 25/100 | offset | 25 (unchanged) | 100 | 7918 |
| 2 | `manage_tickets` (list) | 5a | `{tickets, showing}`, 25/100, no total | offset | 25→20 | 100 | 7422 |
| 3 | `manage_patches` (list) | 5a | `{patches, showing, scope}`, 25/100 | offset | 25 (unchanged) | 100 | 7932 |
| 4 | `list_scripts` | 5a | `{scripts, count}`, 20/50 | offset | 20→15 | 50 | 7188 |
| 5 | `get_security_posture` | 5a | `{summary, worstDevices, devices}`, 25/500 (worstDevices duplicates up to 10) | offset | 25→5 | 500 | 7141 (raw 7291) |
| 6 | `list_monitors` | 5a | fetched ALL then `.slice(0, limit)`; `total = rows.length` (wrong) | offset | 25 (unchanged; `total` now the true row count) | 100 | 5501 |
| 7 | `list_ai_agents` | 5a | `{agents, showing}`, **no limit** | offset | 25 (new) | 100 | 7043 |
| 8 | `get_device_vulnerabilities` | 5a | `{deviceId, vulnerabilities, count}`, **no limit** | offset | 50→45 | 200 | 7597 |
| 9 | `manage_alerts` (list) | 5b | `{alerts, total, showing}`, 25/100, unbounded `message` | keyset | 20→15 (5b follow-up; realistic-fixture worst-case 8 was too pessimistic) | 100 | 7192 |
| 10 | `search_agent_logs` | 5b | `{logs, count}`, 100/500, unbounded `fields` jsonb | keyset | 50→18 (5b follow-up) | 500 | 7732 |
| 11 | `query_audit_log` | 5b | `{entries, showing}`, 25/100, unbounded `details` jsonb | keyset | 25 (fits as-is) | 100 | 7932 |
| 12 | `query_change_log` | 5b | `{changes, total, showing, filters}`, 100/500, unbounded jsonb ×3 | keyset | 50→25 (5b follow-up) | 500 | 7661 |
| 13 | `list_organizations` | 5c | `{organizations, showing}`, 25/100, unbounded `sites[]`/org | offset | 25 (unchanged; `sites` capped 20/org + `siteCount`) | 100 | 4463 |
| 14 | `list_configuration_policies` | 5c | whole-row spread incl. `settings` jsonb, 25/100 | offset | 25→20 (plan's 25 measured 9048 raw chars) | 100 | 7253 |
| 15 | `get_device_details` | 5c | whole `deviceHardware`/`deviceNetwork`/`deviceDisks` rows, unbounded `networkInterfaces`/`disks` | n/a (single-object detail tool) | n/a — `networkInterfaces`/`disks` capped at 16 + counts | n/a | not budget-tested (no `outputShape` fixture; capped by row count, not paged) |
| 16 | `get_script_execution` | 5c | full `stdout` + `stderr` | char window | `stdoutMaxChars`/`stderrMaxChars` 6000/2000→**5000/1500** (plan's 6000/2000 measured 8656 raw chars) | 16000/8000 | 7156 |
| 17 | `get_incident_timeline` | 5c | unbounded `actions[]`/`evidence[]`, evidence whole rows + `metadata` jsonb | caps | `actions`/`evidence` capped 50 + count, `timeline` capped 100 + count | n/a | 893 |
| 18 | `list_playbooks` | 5c | **no limit**; unbounded `steps` jsonb/row | offset | 25 (new) | 100 | 6847 |
| 19 | `get_active_users` | 5c | `limit` capped session rows 100/200, unbounded `sessions[]`/device | offset (devices) | 50→**12** (plan's 50 measured 8501 raw chars at 15 devices) + `maxSessionsPerDevice` 10/50 | 200 | 6539 (raw 6827) |
| 20 | `get_cis_compliance` | 5c | 25/500, per-row `summary` jsonb | offset | 25→**12** (plan's 25 measured 12568 raw chars) | 500 | 6132 |
| — | `query_psa_status` | 5c (survey miss) | **no limit** (not in the plan's 20; flagged by the outputBudget contract test) | offset | new | — | 6162 |

Notes:
- `list_configuration_policies`, `get_script_execution` stdout/stderr, `get_active_users`, and `get_cis_compliance` defaults are lower than the plan's provisional table because the plan sized against the plan's own guessed row width, not a fixture built from realistic column widths; the actual default was set to whatever fits `MAX_TOOL_RESULT_CHARS` (8000) with a realistic row (commit messages `c5ad070f30`, `c8d579606d`).
- `manage_alerts`/`search_agent_logs`/`query_change_log` defaults went through **two** passes: an initial worst-case-fixture sizing (commit `002b716656`) that came in too low (5–20), then a follow-up (`c8d579606d`) that resized against realistic rows and let a worst-case page degrade honestly under compaction instead. `query_audit_log` needed no correction — it fits the plan's original 25 once `details` is projected to `detailsKeys`.
- `get_device_details` has no `outputShape` fixture; its shaping is caps on two per-row arrays (`networkInterfaces`, `disks` ≤ 16 + `*Count`), not a page budget, since it's a single-device detail tool, not a list.

### 7.2 Golden eval delta

`not run: AI_TOOL_EVAL_KEY absent in this environment` (same gate A-W03 Task 7 used). No numbers invented; the controller runs `pnpm ai:tool-eval` against a real key before merge and fills this row.

### 7.3 Tool-capture row (prompt bytes, turn-1/turn-2 tokens)

`not run: ANTHROPIC_API_KEY absent in this environment` (`ai:tool-capture` calls the real Anthropic API, same as `ai:tool-eval`). The controller runs `pnpm ai:tool-capture --surface chat --turns 2` before merge and appends the row here.

As a proxy for prompt growth that doesn't need a live model call: `Buffer.byteLength(AI_SYSTEM_PROMPT_BASE + AI_SYSTEM_PROMPT_TAIL)` grew from 6106 to 6427 bytes (+321 bytes, under the plan's 400-byte budget) adding the "Paged and large results" sentences to the TAIL; `MCP_SERVER_INSTRUCTIONS` is 3502 bytes with the matching sentences added. Both stay under `aiAgentSystemPrompt.test.ts`'s 7 KB `BASE + TAIL` ceiling.

Production output-size report: `not run` — needs `docs/superpowers/specs/ai-mcp/sql/2026-09-17-ai-tool-usage-90d.sql` on EU + US (Todd); the 20-tool list above is provisional until then, per D10/the plan's "The 20 tools" section. Per Q10, `manage_tickets`, `list_monitors`, and `get_incident_timeline` are MCP-only (absent from `TOOL_TIERS`), so `hotForShaping` (which ranks `chat`+`helper` rows only) cannot measure them even once the report runs on production — they were shaped anyway on the survey's likely-traffic ranking, and stay in the 20-tool table with that caveat.
