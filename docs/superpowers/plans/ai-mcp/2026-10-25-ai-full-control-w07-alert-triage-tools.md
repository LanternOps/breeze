---
tracking_issue: LanternOps/breeze#6754
wave: W07 (#6777)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W06 (#6776, PR #10160) and W19 (#10087) merged to main
branch: feature/6754-ai-full-control/wave-6777
---
# AI full control W07: alert correlation and signal-triage tools — class review and plan

**Goal:** expose the alert-correlation, device-anomaly and reliability-triage routes to chat, agents and MCP with a class that survives the spec's class review rule **before** the tool is reachable (spec D2).

**Verified against** `origin/main` `14a62577b4` (2026-10-25; W06 #10160 merged, `KNOWN_MISSING_TOOL_TIERS` gone). Paths are under `apps/api/src/`.

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | #10160 merged; `KNOWN_MISSING_TOOL_TIERS` absent | yes (comments only) |
| 0.2 | none of the W07 names in registry / `TOOL_TIERS` / `HUMAN_ONLY_TOOLS` | yes |
| 0.3 | no `wave-6777` branch or PR | yes |
| 0.4 | #6777 and #6754 open | yes |
| **new** | the `test_alert_rule` route exists | **NO.** `routes/configurationPolicies/alertRuleTest.ts` was deleted in W05d (#6917; `configurationPolicies/index.test.ts` pins its absence) and `POST /alerts/rules/:id/test` returns 410 (`legacyAlertingGone`). There is no live twin to mirror. |

**`test_alert_rule` is not built.** The brief says to abort if the premise fails; the other four tools have live routes and independent value, so the wave ships without it and records this (a dry-run for the replacement alerting model would be a new design, not a mirror). Golden prompt g87 (reliability offenders) replaces the "dry-run an alert rule" prompt.

## What the routes do (facts the triage did not have)

1. All route logic was inline in Hono handlers. W07 **extracts it into exported functions** that the routes and the tools both call (`mutateCorrelationGroup`, `acknowledgeAlertWithRelated`, `recordCorrelationFeedback`, `recordRcaFeedback`, `explainCorrelationGroup`, `buildAlertCorrelationView`, `listCorrelationGroups`, `getCorrelationGroupDetail`, `listCorrelationLinks`, `analyzeCorrelationLinks`, `queryDeviceAnomalies`, `applyAnomalyStatus`, `recordDeviceReliabilityFeedback`). A tool that re-derived any of it would drift from the route's site axis, compare-and-swap or dedupe keys. The existing route suites (correlations 45, alertTemplates 81, anomalies 27, reliability 37) are green unchanged.
2. The feedback routes need only `alerts:read` / `devices:read`; group ack is `alerts:acknowledge`, group resolve `alerts:write`, anomaly status (all three statuses) `alerts:write`.
3. `explain` is the deterministic evidence builder (`buildAlertCorrelationRca`), **not a model call**. Its timeline carries event-log text authored on endpoints (fenced) and gates the sensitive log category on `canReadSensitiveEventLogCategory`.
4. Anomaly `promoted` creates an alert row and publishes `alert.triggered`, which reaches notification channels and ticket automation. `dismissed` / `resolved` only set a status (there is no route back to `open`).
5. The routes have no exact-device axis, and `evaluateReliabilityScores` / `getOrgReliabilitySummary` take only org and site filters.

## Class review (Q1 reversible in a minute? Q2 leaves the tenant / reaches a person? Q3 blast radius? Q4 agent grants itself authority?)

| Tool:action | Q1 | Q2 | Q3 | Q4 | Triage | **W07** | Note |
|---|---|---|---|---|---|---|---|
| `get_alert_correlations` groups/get/by_alert/links/analyze/evaluation/explain | read | none | caller scope | no | read | **t1** | explain is not a model call (so not t2); log text fenced; refused to exact-device runs |
| `manage_alert_correlations:acknowledge_group` / `resolve_group` / `acknowledge_related` | partly (ack/resolve events already published) | internal events (webhook subscribers) | one org's group | no | t2 | **t2** | `manage_alerts:acknowledge/resolve` precedent; **quorum dissent QW1** |
| `…:feedback` / `rca_feedback` | no (no retraction) | none | one row | no | t2 | **t2** | ML labels; route needs only alerts:read; **quorum dissent QW2** |
| `manage_device_anomalies:list` | read | none | one device | no | read | **t1** | |
| `…:dismiss` / `resolve` | no reopen path | none | one row | no | t2 | **t2** | **dissent QW2** |
| `…:promote` | no | **alert.triggered reaches channels / tickets** | one device | no | t2 | **sup** | the triage said t2; Q2 says supervised |
| `get_fleet_health:history/offenders/evaluation/org_summary` | read | none | device / scope | no | read | **t1** | offender labels fenced; evaluation/org_summary refused to exact-device runs |
| `reliability_feedback` | no | none | one row | no | t2 | **t2** | its own tool so `get_fleet_health` stays `readOnlyHint:true` |

Final per-action classes (the approval-scope contract's `W07_EXPECTED` copies this): t1 reads above; t2 = correlation group/alert ack/resolve, both feedbacks, anomaly dismiss/resolve, `reliability_feedback`; **supervised = `manage_device_anomalies:promote`**; no four-eyes.

## Wiring

- Registry: `get_alert_correlations` t1, `manage_alert_correlations` t2, `manage_device_anomalies` t1 (multiplexer: `list` in `TIER1_READ_ACTIONS`, `dismiss`/`resolve` in `TIER2_ACTIONS`, `promote` in `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS`), `reliability_feedback` t2. `get_fleet_health` stays t1 and `alwaysLoad`; `get_alert_correlations` and `get_fleet_health` actions are declared in `TIER1_READ_ACTIONS` (the tier-1 write-action contract wants a multiplexer's vocabulary declared).
- Domains: `monitoring` (correlations, anomalies), `devices` (`reliability_feedback`). Handlers: `aiToolsAlertCorrelations.ts`, `aiToolsAnomalies.ts`, `aiToolsReliabilityTriage.ts`; schemas `aiToolSchemasAlertTriage.ts`.
- RBAC: per-action `TOOL_PERMISSIONS` copied from the routes; 24 route-binding rows pin `tool ⊇ route` with no surplus.
- Axes: central device gate (`deviceArgs: ['deviceId']`) plus `verifyDeviceAccess` for device-addressed actions; a site-restricted caller needs a visible member for any group write or label; exact-device runs are refused the cross-device views.
- Agents: `manage_alert_correlations` is `AGENT_HUMAN_ONLY_TOOLS` (QW3). Anomaly dismiss/resolve/promote and `reliability_feedback` are proposals released as the approver (`USER_OWNED_RELEASE_ACTIONS` +4, each branch checks `approverReleaseMismatch`); a direct `ai_agent` call never writes.
- Rate limits 60/30/40/30 per 300 s; fence entries for correlation text, reliability offender labels, anomaly metric names; `mcpCoverage.ts` four routes move from gap to `{ tools }`; four `FROZEN_GAPS` entries deleted; web `tierConfig` rows; docs.

## Measured (W19 bounds; `AI_TOOL_INDEX=lazy`)

| Measure | without the 4 tools | with |
|---|---|---|
| Always-on (B1 < 2,560) | 2,494 | 2,494 |
| `monitoring` block (B2 < 2,048) | 787 | 1,025 |
| `devices` block | 1,165 | 1,187 |
| Largest block | security 1,268 | unchanged |
| Worst page turn, alert (B3 < 7,040) | 4,471 | 4,731 |
| Legacy whole index (informational) | 8,622 | 8,882 |

No ceiling, `DOMAIN_NOTES` or vocabulary change. `MCP_TOOL_COUNT_APPROX` stays 280 (registry 288 is inside the ±10 tolerance).

## Quorum (codex `exec`, read-only, xhigh): AGREE WITH CHANGES

- **QW1 ack/resolve/promote → four-eyes (events reach webhooks). NOT accepted; dissent recorded for Todd.** `manage_alerts:acknowledge/resolve` publish the same events and are t2 (brief: "t2 on the manage_alerts precedent"); four-eyes would stop a solo operator acknowledging a group from chat. Promote stays supervised.
- **QW2 feedback labels and anomaly dismiss/resolve → supervised (no undo). NOT accepted; dissent recorded.** Tenant-internal status/label rows, brief says t2. Todd decides.
- **QW3 approver substitution drops the originating run's exact-device ceiling. Accepted:** `manage_alert_correlations` is `AGENT_HUMAN_ONLY_TOOLS` (agents read correlations and ack per alert through `manage_alerts`); the four remaining agent-mintable writes are device-addressed, so the ceiling is enforced at mint time by the central device gate.
- **QW4 site scope on feedback. Accepted (fixes the REST route too):** a restricted caller needs a visible member of the group; every caller may cite only visible alerts of the group's own org and merge only into a visible group of the same org (the automated commit review asked for the second part to apply to all callers).
- **QW5 verdict / counts. Accepted for the verdict:** `aiVerdict` is withheld (`aiVerdictWithheld:true`) when a restricted caller sees only part of the group. The evaluation feedback counts are org-wide aggregate numbers with no identifiers and are left (recorded).
- **QW6 RCA evidence devices. Accepted:** a restricted caller's `explain` uses only alerts whose device is on a currently allowed site; a group with none left is not found.
- **QW7 `buildApproverAuthContextForIntent` requires a partner-axis approver. Out of scope** (the release worker; affects every user-owned release, fails closed); follow-up.

## Decisions

- **W07-D1** `test_alert_rule` not built (route retired).
- **W07-D2** routes refactored to export the shared operations; behaviour unchanged except the QW4/5/6 site-axis hardening, which applies to the REST routes too.
- **W07-D3** `reliability_feedback` is a separate tool (a write behind `get_fleet_health` would flip its MCP `readOnlyHint`).
- **W07-D4** anomaly *episodes* (list/get/action) and reliability *baselines* are not exposed (outside the triage rows); `mcpCoverage` notes say so.
- **W07-D5** exact-device (device-bound) runs are refused correlation views and the two aggregate reliability views.

## Tasks (done in this PR)

Classes + wiring + guardrail maps → route-binding rows → approval-scope rows → agent catalog rows → fences / rate limits → golden prompts (+3) → web tierConfig → docs → W19 measure → site-scope integration suites.

## Follow-ups (not filed)

- `buildApproverAuthContextForIntent` partner-axis requirement (QW7).
- Feedback aggregate counts on `/correlations/evaluation` are org-wide for a site-restricted caller.
- Expose anomaly episodes; reliability baselines stay human.
- A dry-run for the replacement alerting model, if wanted (`test_alert_rule` had no live twin).
