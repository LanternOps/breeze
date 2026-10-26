---
tracking_issue: LanternOps/breeze#6754
wave: W09 (#6779)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W08 (#6778, PR #10204) and W19 (#10087) merged to main
branch: feature/6754-ai-full-control/wave-6779
---
# AI full control W09: SNMP + network monitoring tools — class review and plan

**Goal:** expose the route modules the W05 triage tagged `W09` to chat and MCP with a class that survives the spec's class review **before** the tool is reachable (spec D2). Paths are under `apps/api/src/`.

**Verified against** `origin/main` `4466874a45` (2026-10-26; W08 #10204 merged, `KNOWN_MISSING_TOOL_TIERS` gone).

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | #10204 merged; `KNOWN_MISSING_TOOL_TIERS` absent | yes (comments only) |
| 0.2 | none of the eight names in registry / `TOOL_TIERS` / `HUMAN_ONLY_TOOLS`; the five route modules exist | names absent, modules exist — **but see D0** |
| 0.3 | no `wave-6779` branch or PR | yes |
| 0.4 | #6779 and #6754 open | yes |

## D0 — two of the eight tools have no live route (premise deviation)

The brief says to drop a tool whose route was removed. In `routes/snmp.ts` every **device**, **per-device metric** and **threshold** route is a deprecation stub that returns `410`:

| Route | Today |
|---|---|
| `GET/POST /snmp/devices`, `GET/PATCH/DELETE /snmp/devices/:id`, `POST /snmp/devices/:id/poll`, `POST /snmp/devices/:id/test` | 410 ("Manage SNMP monitoring via `/monitoring/assets` and `/monitoring/assets/:id/snmp`. On-demand poll and test are not yet available") |
| `GET /snmp/metrics/:deviceId[/history|/:oid]` | 410 |
| `GET/POST/PATCH/DELETE /snmp/thresholds…` | 410 ("Thresholds have been deprecated … use alert rules on network monitors") |

So **`manage_snmp_devices` and `manage_snmp_thresholds` are NOT built**: a tool would mirror a door that is shut, and `poll` / `test` do not exist anywhere in the API. This is the same call W07 made for `test_alert_rule`. The live SNMP surface is: templates CRUD, OID browse / validate, the dashboard, and `GET /monitoring/assets/:id/metrics` (bucketed history). W09 therefore builds **six** tools, not eight. The per-asset SNMP configuration (`/monitoring/assets/:id/snmp`, `monitoring.ts`) is outside this wave's route list and is left for a follow-up (it is where device-level SNMP edit and threshold-equivalent alert rules now live).

## Facts the triage did not have

1. The handlers are not thin. To keep one copy of the rules, W09 first moves four route bodies **verbatim** into services the routes and the tools both call: `snmpTemplates.ts` (org resolution, visibility, built-in / org mutation rule, OID browse + validate), `snmpDashboard.ts`, `snmpMetricHistory.ts` (every cap in `metricBucketing.ts` stays), `assetProbeRun.ts` (steps 2-6 of the probe). The route test suites (`snmp`, `monitoringAssetMetrics`, `discoveryAssetProbe`) pass unchanged.
2. SNMP templates have **no partner axis**: `snmp_templates.org_id` is nullable only for built-ins (`is_built_in`) and system-scope rows. The brief's `canManagePartnerWidePolicies` gate for partner-wide template rows therefore does not apply to templates; it applies to the two tools whose state IS partner-wide: known guests (`network_known_guests.partner_id`) and UniFi (`unifi_integrations.partner_id`). Both REST routers gate every call on it.
3. The known-guest and UniFi routers also require `organizations:read|write` (guests) and `billing:manage` (UniFi, reads **and** writes) — the tool floor mirrors that, not a "reasonable" permission.
4. `canManagePartnerWidePolicies` reads `partnerOrgAccess`, which agent, helper and MCP-key contexts never carry, so those principals fail closed. Known guests and both UniFi tools are `AGENT_HUMAN_ONLY_TOOLS` (like W08): they would be listed to an agent and refused every time.
5. SNMP template writes edit an **org-wide** row; REST applies no site gate. A site- or device-restricted caller editing it would change polling for assets in sites they cannot see. The tool is **tighter than REST**: template writes (and the dashboard, which aggregates org-wide) refuse a site- or device-restricted caller. Recorded as a deliberate toolOnly delta.
6. `probe_network_asset` mirrors `POST /discovery/assets/:id/probe`: stamp `pending` then dispatch a `network_ping` from a **site-strict** executor (no org-wide fallback) and wait up to 8 s. It is held in the per-call transaction exactly as the REST request is (an UPDATE by the agent's result handler waits for the commit, then applies). It refuses a hidden / out-of-site / device-restricted asset as one indistinguishable "not found".
7. UniFi `hosts` is the only read that leaves the process: it calls the vendor cloud with the partner's stored API key (read-only list). `telemetry` / `collectors` rows are projected: **no** `raw` payloads, no encrypted keys (`listCollectors` already omits the key).

## Class review (Q1 reversible in a minute? Q2 leaves the tenant / reaches a person or device? Q3 blast radius? Q4 agent grants itself authority?)

| Tool:action | Q1 | Q2 | Q3 | Q4 | Triage | **W09** | Note |
|---|---|---|---|---|---|---|---|
| `manage_snmp_templates` list / get / browse_oids / validate_oids | read | none | org + built-ins | no | read | **t1** | |
| `…:create` | yes (delete it) | none | one org | no | t2 | **t2** | org-bound; unrestricted caller only (fact 5) |
| `…:update` | yes (edit back) | none; changes which OIDs every device on the template polls | one org | no | **sup** (hits every device using it) | **t2** | brief says t2; **dissent candidate vs triage**. Built-ins refused. |
| `…:delete` | recreate (the OID list is in the call) | none | one org; FK refuses a template still in use | no | t2 | **t2** | |
| `get_snmp_metrics:history` | read | none | one asset, capped series | no | read | **t1** | bucketed, `MAX_SERIES` capped; site-gated like the route |
| `get_snmp_metrics:dashboard` | read | none | one org | no | read | **t1** | restricted callers refused (fact 5) |
| `probe_network_asset` | yes (the stamp is a status field) | **dispatches a ping from an agent to one IP** | one asset | no | t2 | **t2** | site-strict executor; one in flight per asset; hidden asset = not found |
| `manage_known_guests:list` | read | none | partner | no | read | **t1** | partner-wide gate |
| `…:add` | yes (delete) | none; suppresses "unknown device" findings for a MAC on **every** org | partner | no | t2 | **t2** | |
| `…:delete` | yes (re-add) | none | partner | no | t2 | **t2** | cross-partner id = not found |
| `get_unifi_status` status / collectors / mappings / telemetry / sync_runs / controller_sites | read | none | partner | no | read | **t1** | telemetry site-gated; collectors / mappings narrowed to the caller's sites |
| `get_unifi_status:hosts` | read | **a read-only call to the vendor cloud with the partner's key** | partner | no | read | **t1** | **dissent candidate** (external call) |
| `trigger_unifi_sync` | n/a (an idempotent pull) | queues a vendor pull for the integration; rewrites synced device telemetry | partner | no | t2 | **t2** | the worker is rate-limited; one integration per partner |

No W09 action is supervised or four-eyes: nothing is irreversible, nothing reaches a customer-visible surface, and there is no external write. The UniFi connect / test / disconnect / mappings / collectors writes (triage row #157 "partial") stay unbuilt and stay in `FROZEN_GAPS` (`unifi/index.ts` is one module entry, so it cannot carry a split note; the entry is unchanged and its comment names the remaining routes).

## Decisions

- **W09-D0** build six tools, not eight (above).
- **W09-D1** one PR (verbatim route extractions + six thin adapters). No migration.
- **W09-D2** `manage_known_guests`, `get_unifi_status`, `trigger_unifi_sync` are agent-human-only (fact 4); the SNMP and probe tools stay agent-reachable (they run on the caller's org / site scope, like `list_network_assets`).
- **W09-D3** template writes and the dashboard refuse a restricted caller (fact 5) — stricter than REST, by design.
- **W09-D4** all six live in the `network` domain / capability (measured below).

## Measured (W19 bounds; `AI_TOOL_INDEX=lazy`)

_filled in T5._

## Quorum (codex `exec`, read-only, xhigh)

_filled after the review._

## Tests

`aiToolSchemas.networkMonitoring.test.ts` (registry / Zod / action-enum parity), `aiToolsNetworkMonitoring.test.ts` (per-action scope, hidden asset, partner gate, projection, ceilings), `aiToolsNetworkMonitoring.permissions.contract.test.ts` (route permission read from source -> tool floor), class rows in `aiGuardrails.approvalScope`, agent catalog rows, and two integration suites (`aiToolsSnmpWritesScope`, `aiToolsNetworkMonitoringScope`) with guard-flip controls.

## Follow-ups (not filed)

- Per-asset SNMP config (`/monitoring/assets/:id/snmp`) and the network-monitor alert rules that replaced thresholds have no tool in this wave's list.
- UniFi connect / mappings / collectors writes stay `vendor_console_admin` (human-only).
- A tool for on-demand SNMP poll / test once the API has one (today: 410, "not yet available").
