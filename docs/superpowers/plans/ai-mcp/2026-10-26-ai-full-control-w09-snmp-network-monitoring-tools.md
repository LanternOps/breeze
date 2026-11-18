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
5. SNMP template writes edit an **org-wide** row; REST applies no site gate. A site- or device-restricted caller editing it would change polling for assets in sites they cannot see. The tool is **tighter than REST**: template create / update / delete refuse a site- or device-restricted caller. The dashboard keeps the route's own narrowing (a site-restricted caller sees only their sites' devices, quorum QW6); only an exact-device caller, who has no org-wide view, is refused.
6. `probe_network_asset` mirrors `POST /discovery/assets/:id/probe`: stamp `pending` then dispatch a `network_ping` from a **site-strict** executor (no org-wide fallback) and wait up to 8 s. It resolves the asset with the route's own **site-locking resolver** (`resolveAssetForMutation`, QW7) and runs in the per-call transaction exactly as the REST request does (an UPDATE by the agent's result handler waits for the commit, then applies). It refuses a hidden / out-of-site / device-restricted asset as one indistinguishable "not found" (the route's 403 vs 404 would let a restricted caller fingerprint ids).
7. UniFi `hosts` is the only read that leaves the process: it calls the vendor cloud with the partner's stored API key (read-only list). `telemetry` / `collectors` rows are projected: **no** `raw` payloads, no encrypted keys (`listCollectors` already omits the key), no collector device id. A vendor error body is summarised, never relayed.
8. **MFA parity (quorum QW4).** Every REST write behind these tools carries `requireMfa()` (template writes, the probe, known-guest add / delete, the UniFi sync). Permission parity is not MFA parity, and an MCP key carries no MFA claim, so each write action re-checks `hasSatisfiedMfa(auth)` in the handler (the pattern `aiToolsUserRisk` set) and is covered by a unit test per write.
9. Free text that reaches the model (template / OID names and descriptions, known-guest labels and notes, UniFi console / site / client names, SSIDs and error strings) is fenced as data through `RAW_TEXT_FIELDS_BY_TOOL`; results are bounded projections capped at 96 KB.

## Class review (Q1 reversible in a minute? Q2 leaves the tenant / reaches a person or device? Q3 blast radius? Q4 agent grants itself authority?)

| Tool:action | Q1 | Q2 | Q3 | Q4 | Triage | **W09** | Note |
|---|---|---|---|---|---|---|---|
| `manage_snmp_templates` list / get / browse_oids / validate_oids | read | none | org + built-ins | no | read | **t1** | |
| `…:create` | yes (delete it) | none | one org | no | t2 | **t2** | org-bound; unrestricted caller only (fact 5) |
| `…:update` | yes (edit back) | none; changes which OIDs every device on the template polls | one org | no | **sup** (hits every device using it) | **t2** | brief says t2; **dissent candidate vs triage**. Built-ins refused. |
| `…:delete` | yes: the result returns the removed row whole (recreate with `create`) | none | one org; a template still used by a device is refused up front | no | t2 | **t2** | quorum QW2 corrected the first wording |
| `get_snmp_metrics:history` | read | none | one asset, capped series | no | read | **t1** | bucketed, `MAX_SERIES` capped; site-gated like the route |
| `get_snmp_metrics:dashboard` | read | none | one org | no | read | **t1** | site-narrowed like the route; exact-device callers refused (fact 5) |
| `probe_network_asset` | yes (the stamp is a status field) | **dispatches a ping from an agent to one IP** | one asset | no | t2 | **t2** | site-strict executor; one in flight per asset; hidden asset = not found |
| `manage_known_guests:list` | read | none | partner | no | read | **t1** | partner-wide gate |
| `…:add` | yes (delete) | none; suppresses "unknown device" findings for a MAC on **every** org | partner | no | t2 | **t2** | |
| `…:delete` | yes (re-add) | none | partner | no | t2 | **t2** | cross-partner id = not found |
| `get_unifi_status` status / collectors / mappings / telemetry / sync_runs / controller_sites | read | none | partner | no | read | **t1** | telemetry site-gated; collectors / mappings narrowed to the caller's sites |
| `get_unifi_status:hosts` | read | **a read-only call to the vendor cloud with the partner's key** | partner | no | read | **t1** | **dissent candidate** (external call) |
| `trigger_unifi_sync` | n/a (a manual pull; nothing to undo, the next sync overwrites) | queues a vendor pull for the integration; rewrites synced device telemetry | partner | no | t2 | **t2** | 6 calls / 5 min per user; one integration per partner |

No W09 action is supervised or four-eyes: nothing is irreversible, nothing reaches a customer-visible surface, and there is no external write. The UniFi connect / test / disconnect / mappings / collectors writes (triage row #157 "partial") stay unbuilt and stay in `FROZEN_GAPS` (`unifi/index.ts` is one module entry, so it cannot carry a split note; the entry is unchanged and its comment names the remaining routes).

## Decisions

- **W09-D0** build six tools, not eight (above).
- **W09-D1** one PR (verbatim route extractions + six thin adapters). No migration.
- **W09-D2** `manage_known_guests`, `get_unifi_status`, `trigger_unifi_sync` are agent-human-only (fact 4); the SNMP and probe tools stay agent-reachable (they run on the caller's org / site scope, like `list_network_assets`).
- **W09-D3** template writes refuse a site- or device-restricted caller (fact 5) and never touch a built-in or org-less row (QW3) — stricter than REST, by design.
- **W09-D5** every write action re-checks the session's MFA claim (fact 8, QW4). The brief's "SNMP device poll / test" golden prompt became an asset probe (g91) because those routes are 410.
- **W09-D4** all six live in the `network` domain / capability (measured below).

## Measured (W19 bounds; `AI_TOOL_INDEX=lazy`)

| Measure | without the 6 tools | with |
|---|---|---|
| Always-on (B1 < 2,560) | 2,494 | 2,494 |
| `network` block (B2 < 2,048) | 824 | 1,113 |
| `monitoring` block | 1,025 | 1,025 |
| Largest block | security 1,268 | security 1,268 |
| Worst page turn, alert (B3 < 7,040) | 4,731 | 4,731 |
| Legacy whole index (informational) | 9,198 | 9,487 |

All six tools sit in the `network` domain / capability; no ceiling, `DOMAIN_NOTES` or vocabulary change. `MCP_TOOL_COUNT_APPROX` stays 296 (registry 302, inside the ±10 tolerance).

## Quorum (codex `exec`, read-only, xhigh): AGREE WITH CHANGES

- **QW1 tier 2 conflicts with Q1–Q4 for template updates, the probe, guest writes and the sync; record the brief's classes as exceptions or escalate. NOT accepted; dissent recorded for Todd.** The wave brief fixes CRUD / probe / sync at tier 2, every action is reversible or a status stamp, and nothing reaches a customer-visible surface or makes an external write. Todd decides whether an OID-list edit that changes what every device on a template polls (the triage's "sup") should be supervised.
- **QW2 delete is not "undoable in the call"; the FK claim had no evidence. Accepted.** The delete result returns the removed row whole (integration-tested) and a template still used by a device is refused up front (a foreign-key violation inside the per-call transaction would poison it); the table says so.
- **QW3 system-scope (org-less) custom rows are broader than a tenant caller's authority. Accepted.** `update` / `delete` refuse a row with no org for every caller; built-ins are refused with `BUILT_IN` (integration-tested for an org and a partner caller).
- **QW4 permission parity is not MFA parity. Accepted** (fact 8).
- **QW5 preserve scope restrictions, partner resolution and caller-scoped RLS; test per action. Accepted.** The tools run in the caller's DB context; every action has a unit test, and the integration suites prove org, site and partner gates against stored rows.
- **QW6 the dashboard rationale was wrong: the route already narrows by site. Accepted.** The tool does the same instead of refusing; only an exact-device caller is refused. Template writes stay stricter than REST.
- **QW7 the probe must keep the route's locking resolver, not an equivalent visibility check. Accepted** (fact 6): `resolveAssetForMutation` is called with the caller's site allowlist (it and `canAccessSite` now take `Pick<UserPermissions,'allowedSiteIds'>`). **Open:** a concurrent-dispatch test needs two interleaved transactions; the one-in-flight guard is tested, the lock is the route's unchanged code.
- **QW8 `browse_oids` lets a custom template overwrite catalog text while keeping `source: 'catalog'`. Pre-existing REST behaviour, shared verbatim; NOT changed here** (it would change the REST response). The text is fenced as untrusted data in the tool output. Follow-up.
- **QW9 prompt-injection boundaries need explicit treatment. Accepted** (fact 9): fenced fields, bounded projections, no vendor payloads or error bodies; the UniFi error path is asserted not to relay the vendor body.
- **QW10 UniFi `hosts` at tier 1 is defensible; add rate limits. Accepted** (30 / 5 min for `get_unifi_status`, 6 / 5 min for the sync).

## Tests

`aiToolSchemas.networkMonitoring.test.ts` (registry / Zod / action-enum parity), `aiToolsNetworkMonitoring.test.ts` (MFA per write, restricted callers, hidden asset, partner gate, projection, vendor-error redaction), route-binding rows in `aiGuardrails.routeBinding.contract.test.ts` (each tool action's permission read from the route source; it also pins `billing:manage` for the UniFi reads), class rows in `aiGuardrails.approvalScope`, agent catalog rows, and two integration suites on a per-worktree stack (`aiToolsSnmpWritesScope` 18 tests, `aiToolsNetworkMonitoringScope` 18 tests). Guard-flip controls: with the probe's site list and device gate lifted 3 tests go red; with the restricted-caller gate lifted 2; with the UniFi telemetry site gate lifted 1.

## Follow-ups (not filed)

- Per-asset SNMP config (`/monitoring/assets/:id/snmp`) and the network-monitor alert rules that replaced thresholds have no tool in this wave's list.
- UniFi connect / mappings / collectors writes stay `vendor_console_admin` (human-only).
- A tool for on-demand SNMP poll / test once the API has one (today: 410, "not yet available").
