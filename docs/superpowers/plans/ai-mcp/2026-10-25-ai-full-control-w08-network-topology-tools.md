---
tracking_issue: LanternOps/breeze#6754
wave: W08 (#6778)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W07 (#6777, PR #10169) and W19 (#10087) merged to main
branch: feature/6754-ai-full-control/wave-6778
---
# AI full control W08: network topology tools — class review and plan

**Goal:** expose the eight topology route modules the W05 triage tagged `W08` to chat and MCP with a class that survives the spec's class review **before** the tool is reachable (spec D2). Paths are under `apps/api/src/`.

**Verified against** `origin/main` `b113a52d3f` (2026-10-26; W07 #10169 merged, `KNOWN_MISSING_TOOL_TIERS` gone).

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | #10169 merged; `KNOWN_MISSING_TOOL_TIERS` absent | yes (comments only) |
| 0.2 | none of the six names in registry / `TOOL_TIERS` / `HUMAN_ONLY_TOOLS`; eight route modules exist | yes |
| 0.3 | no `wave-6778` branch or PR | yes |
| 0.4 | #6778 and #6754 open | yes |

## Facts the triage did not have

1. The routes are thin: every handler calls an exported service (`services/topology/*`) with a `TopologyRequestContext` from `requireTopologySiteAccess(auth, permissions, siteId, capability)`. The tools call the **same** exported services; no route logic is re-derived. Capabilities: `read` = topology:read + devices:read; `write` adds topology:write; `execute` adds topology:execute + devices:execute; `configure` = write + devices:write + devices:execute.
2. Template-library routes authorise in the service (`assertTopologyTemplateAccess`): writes refuse an `ai_agent` principal, require satisfied MFA, `topology:write`+`devices:write`, and `canManagePartnerWidePolicies` for a partner-owned template.
3. `requireTopologySiteAccess` resolves `getUserPermissions(auth.user.id, …)`. An `ai_agent` principal's id is not a user, so it resolves to `null` and every call is refused. The existing topology tools are pinned-investigation tools for the same reason (`topology/aiToolGate.ts`). **W08-D1: all six tools are `AGENT_HUMAN_ONLY_TOOLS`** (chat / MCP / Helper only); an agent keeps the pinned-session reads.
4. Template **apply** freezes the actor with `freezeApplicationActor`: it needs a `user_session` principal whose token carries the `aep`/`mep` epochs. A supervised release rebuilds the approver's auth with a synthesised token that has neither, so a supervised `apply` could never succeed. **W08-D2:** `buildUserOwnedAuthContext` carries the live `users.authEpoch/mfaEpoch` into the token for `apply_topology_template` only (one-entry allowlist, test-pinned); other actions are unchanged.
5. A supervised release synthesises `mfa: true`. That is the platform's accepted model for tier-3 tools (see the MFA note in `aiGuardrails.ts`), but it is exactly why M4 built a *verified* start with a fresh approver factor for `diagnose_connectivity`. The ordinary `createTopologyDiagnosticRun` therefore must never run from a release: `run_topology_diagnostic:start` is **tier 2 inline** (live chat session, real MFA claim, service refuses `ai_agent`), never supervised.
6. Existing M4 reads project through an allowlist with sanitised text and no raw addresses (`topology/aiRead.ts`). The console reads here project the same way (ids, kinds, lifecycle, freshness, evidence summary, health codes, sanitised label/role, device bindings; **no** addresses, MACs, raw attributes or collector payloads).
7. No topology route has a `requirePermission(...)` call (they use `requireTopologySiteCapability`), so `aiGuardrails.routeBinding` cannot parse them. W08 adds its own parity contract: each tool action's capability → `topologyPermissionPairs` ⊆ `requiredPermissionsForTool`.

## Class review (Q1 reversible in a minute? Q2 leaves the tenant / reaches a person or device? Q3 blast radius? Q4 agent grants itself authority?)

| Tool:action | Q1 | Q2 | Q3 | Q4 | Triage | **W08** | Note |
|---|---|---|---|---|---|---|---|
| `get_topology_graph` graph/nodes/node/relationship/evidence/group_members/expansion/health | read | none | one site | no | read | **t1** | allowlist projection, fenced text |
| `run_topology_diagnostic:collectors` / `get` | read | none | one site | no | read | **t1** | |
| `run_topology_diagnostic:start` | no | **dispatches a probe to a device** | one device, budgeted | no | t2 | **t2** | device arg gate + site scope; not supervised (fact 5); **dissent candidate vs `diagnose_connectivity`** |
| `run_topology_diagnostic:cancel` | n/a | stops own run | one run | no | t2 | **t2** | |
| `manage_topology_manual` create/update/delete node, create/delete relationship | delete no | none | one site | no | t2 | **t2** | manual assertions only; no tool argument can bind a device or move one between sites |
| `manage_topology_monitoring:list_policies/list_targets/get_settings` | read | none | one site | no | read | **t1** | |
| `…:upsert_policy/delete_policy/upsert_target/delete_target/patch_settings` | yes (revision CAS) | none (arming stays human-only, `monitoringArms`) | one site | no | t2 | **t2** | |
| `manage_topology_templates:list_templates/list_versions/site_options` | read | none | partner/org | no | read | **t1** | partner rows need `canReadPartnerWideRows` (service) |
| `…:create_template/update_template/create_version` | yes (draft) | none | partner/org | no | t2 | **t2** | partner-owned needs `canManagePartnerWidePolicies` (service) |
| `…:publish_version` | no | makes the version appliable partner/org-wide | partner/org | no | sup | **supervised** | |
| `…:revoke_template` | no (terminal) | disables every policy that references the template | partner/org | no | (in update) | **supervised** | split out of `update_template` after the quorum; `update_template` refuses `revoked` |
| `apply_topology_template:preview` | yes | none (persists a preview record) | named sites | no | read | **t2** | not t1: it writes a preview row |
| `apply_topology_template:apply` | no | rewrites site monitoring configuration | named sites | no | sup | **supervised** | W08-D2 |
| `apply_topology_template:status` | read | none | one application | no | read | **t1** | |

Two rows changed after the quorum (below): `revoke_template` is a separate **supervised** action (the service makes revocation terminal and it disables every referencing policy), and `update_template` refuses `lifecycle: revoked`.

## Measured (W19 bounds; `AI_TOOL_INDEX=lazy`)

| Measure | without the 6 tools | with |
|---|---|---|
| Always-on (B1 < 2,560) | 2,494 | 2,494 |
| `network` block (B2 < 2,048) | 508 | 824 |
| Largest block | integrations 1,472 | unchanged |
| Worst page turn, alert (B3 < 7,040) | 4,731 | 4,731 |
| Legacy whole index (informational) | 10,015 | 10,331 |

No ceiling, `DOMAIN_NOTES` or vocabulary change. `MCP_TOOL_COUNT_APPROX` 280 → 286 (the ±10 pin went red at registry 294 and is raised by the six new tools).

## Quorum (codex `exec`, read-only, xhigh): AGREE WITH CHANGES

- **QW1 `run_topology_diagnostic:start` must be supervised (reuse the `diagnose_connectivity` verified path). NOT accepted; dissent recorded for Todd.** The wave brief fixes `start` at tier 2 with device args and site scope. It runs inline in the person's own MFA session (the service refuses `ai_agent` and an unsatisfied MFA claim), is capped by the service's per-user / site / org budget, and the handler refuses a released context, so the synthetic-MFA concern does not apply to it. The investigation flow keeps its supervised, fresh-factor start (`diagnose_connectivity`). Todd decides whether a person's own chat session should also need an approval.
- **QW2 `patch_settings` and policy / target mutations should be supervised (a change disarms an armed policy; re-arming is human). NOT accepted; dissent recorded.** Brief says tier 2; the route's revision CAS makes the write retryable and arming is never granted by this tool. The docs say plainly that changing an armed check disarms it. Todd decides.
- **QW3 manual deletes should be supervised (hard delete of legacy rows, new identity on re-create). NOT accepted; dissent recorded.** Brief says tier 2 for manual CRUD.
- **QW4 the epoch carry is a revocation fence from release onward, not session continuity or fresh MFA; restrict to `(apply_topology_template, apply, user_session)`; say "requester". Accepted.** A post-commit security review made the same point (live epochs at release hide a sign-out between approval and release). **Hardened:** `applyTopologyTemplatePreview` now refuses (`permission_changed`) when the caller's epochs differ from the epochs the PREVIEW recorded in the person's live session, so the fence runs from the moment the person read the preview, not from the release. A unit test pins both the refusal and its same-epoch control. `SESSION_EPOCH_RELEASE_ACTIONS` is one entry, gated on a `user_session` origin and the literal `apply` action; the doc comment states the limit; a unit test per exclusion (other action, other tool, agent origin, MCP key).
- **QW5 the carry fails for MSP actors (organization scope vs `users.orgId`). Accepted.** A requester who resolves on the intent's own partner axis keeps the partner scope for this release; a requester of another partner is not widened. Both actor types are tested.
- **QW6 keep the agent exclusion; correct the availability claims (preview / status also need a session with epochs). Accepted.** Docs say "signed-in person"; the principal matrix is in `aiToolsTopologyApply.ts` and tested (an MCP key gets `topology_permission_denied`, never a relabelled success).
- **QW7 sanitized collected labels weaken the M4 alias boundary; allowlist every result. Partly accepted.** Graph reads are allowlist projections (no addresses, MACs, available actions, free-text health messages, presentation or layout rows) and policy / target rows are allowlist views. Node labels are returned sanitized and fenced (`RAW_TEXT_FIELDS_BY_TOOL`), NOT aliased: a person asking "what is the core switch connected to" needs the name, and `query_devices` / `list_network_assets` already return hostnames and addresses to the same caller. User-authored settings and template payloads are returned as written (they are what a person edits). Recorded for Todd.

## Decisions

- **W08-D1** all six tools `AGENT_HUMAN_ONLY_TOOLS` (fact 3). Follow-up: a principal-aware topology access resolver for agents.
- **W08-D2** release token carries session epochs (and the requester's real axis) for `apply_topology_template:apply` only (fact 4, QW4, QW5). Apply at release covers sites of the intent's org; others report per-site outcomes.
- **W08-D3** `run_topology_diagnostic:start` stays tier 2 (fact 5, QW1 dissent).
- **W08-D4** no migration; one PR (the tool surface is thin adapters over the route services; no split needed).
- **W08-D5** `revoke_template` is its own supervised action.

## Tests

`aiToolSchemas.topologyOps.test.ts` (registry / Zod / action-enum parity), `aiToolsTopologyOps.test.ts` (per-action capability, hidden site, agent refusal, projection, ceilings), `aiToolsTopologyOps.permissions.contract.test.ts` (route capability read from source -> whole floor), class rows in `aiGuardrails.approvalScope`, agent catalog rows, `actorContext.test.ts` (epoch carry), and two integration suites (`aiToolsTopologyWritesScope`, `aiToolsTopologyApplyDiagnosticScope`; 30 tests on a per-worktree stack). Guard-flip controls: site ceiling lifted in `topologySite` -> 4 integration tests red; `deviceArgs` dropped from `run_topology_diagnostic` -> 1 red; every refusal also has a lifted-guard control that lands.

## Follow-ups (not filed)

- A principal-aware topology access resolver so an agent run can use these tools.
- Approval card for `apply` shows the opaque preview token; surfacing the previewed effect on the card needs an intent-summary hook.
- `get_topology_graph` returns names, not aliases (QW7); aliasing could be a per-org option.
- Policy / target edits that touch an armed policy could be classified input-aware (QW2) if Todd wants it.
