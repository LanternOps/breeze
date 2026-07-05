# Breeze MCP Server Guidance — Design

**Date:** 2026-07-04
**Status:** Approved (design), pending implementation plan
**Author:** Todd Hebebrand (with Claude)

## Problem

Customers connect the Breeze RMM AI Agent MCP server (`mcp__claude_ai_breeze__*`, ~171 tools) to their own Claude client (Claude.ai, Desktop, Code) and drive their RMM through natural language. Today those external clients receive **zero server-side guidance**: no orientation on how to pick among ~171 tools, and — more seriously — no safety framing before invoking genuinely destructive, multi-tenant tools (`file_operations`, `registry_operations`, `disk_cleanup`, `manage_patches`, `revoke_elevation`, …).

The in-product chat agent already has a system prompt (`AI_SYSTEM_PROMPT_BASE` in `apps/api/src/services/aiAgentSystemPrompt.ts`), but it is consumed only by `aiAgent.ts` and never reaches the external MCP path (`apps/api/src/routes/mcpServer.ts`).

The failure mode we are preventing is not "the tech is confused" — it is "Claude ran a cleanup/registry edit/patch against the wrong org's device because the request was vague and nothing told the model to resolve and echo the target first."

## Goal & non-goals

**Goal:** Give every client that connects to the Breeze MCP server automatic, universal guidance — orientation, tool-selection heuristics, and non-negotiable guardrails — plus a small set of guided on-ramps for the highest-value MSP workflows. Delivered server-side so there is no install step and the guidance is always versioned with the deployed server.

**Non-goals:**
- A distributable `SKILL.md`. Considered and deferred — a skill only reaches skills-capable clients and can drift from the deployed server, so it cannot carry safety-critical guardrails. May be added later as an optional power-user layer.
- Changing the enforcement boundary. Guidance *steers the client's model*; it does **not** become the safety boundary. Enforcement stays in `aiGuardrails.ts` tier gating. We never claim parity between the guidance text and the server-side gates.

## Delivery decision (why server-side)

| Vehicle | Reaches every customer | Install step | In sync with deploy | Progressive/deep | Chosen |
|---|---|---|---|---|---|
| MCP `instructions` field | Yes, automatic | None | Yes (ships w/ server) | No (one blob) | ✅ backbone |
| MCP prompts | Yes (must invoke) | None | Yes (ships w/ server) | Per-flow | ✅ on-ramps |
| Distributable skill | No (skills-capable only) | Yes | No (drifts) | Yes | ❌ deferred |

Guardrails must reach 100% of customers with zero opt-in, which disqualifies the skill for the safety layer. The MCP server code lives in this repo, so server-side is also the natural ownership home.

## Architecture

All changes target the hand-rolled JSON-RPC server `apps/api/src/routes/mcpServer.ts` (NOT the MCP SDK — the server is a plain `switch (req.method)` dispatcher). Each addition mirrors a pattern already present in the file.

### 1. `instructions` field
Add an `instructions: string` to the `initialize` result object (`mcpServer.ts:792-801`), as a top-level sibling of `capabilities` / `serverInfo`, per MCP spec. Protocol version stays pinned at `2024-11-05`.

### 2. `prompts` capability + handlers
- Advertise the capability: add `prompts: { listChanged: false }` to the capabilities object (`mcpServer.ts:794`).
- Add dispatcher cases `prompts/list` and `prompts/get` to the `switch`, mirroring the existing `handleResourcesList` (`:1293`) / `handleResourcesRead` (`:1402`) handlers.

### 3. New module `mcpGuidance.ts`
Owns the instructions text and the prompt definitions/renderers, so `mcpServer.ts` (already 1669 lines) stays a thin transport. Exports:
- `MCP_SERVER_INSTRUCTIONS: string`
- `listMcpPrompts(): PromptDefinition[]`
- `getMcpPrompt(name, args): PromptMessages` (throws on unknown name)

### 4. Shared guardrails core (DRY)
Extract the safety rules currently embedded in `AI_SYSTEM_PROMPT_BASE` into one exported constant `BREEZE_AI_GUARDRAILS_CORE` (new or in `aiAgentSystemPrompt.ts`). Both `AI_SYSTEM_PROMPT_BASE` and `MCP_SERVER_INSTRUCTIONS` import it, so the in-product agent and external clients cannot drift apart on safety wording. This is a small, justified refactor of the existing prompt.

### Truth sources (do not duplicate)
- Destructive-tool list: `TIER3_ACTIONS` + per-tool base `tier:` declarations in `aiGuardrails.ts:72-98`. Guidance references the *concept* of Tier-3 confirmation; it does not hardcode a parallel list that could drift.
- Tenant hierarchy / device resolution: existing `resolve_device_context`, `query_devices`, `set_device_context` tools.

## The `instructions` blob (content spec)

Concise (~40-60 lines). Three parts:

1. **Orientation** — Breeze is a multi-tenant RMM; hierarchy Partner → Organization → Site → Device Group → Device. Tool-selection heuristic: (a) resolve context first (`resolve_device_context` / `query_devices`), (b) read before write (prefer `query_*` / `get_*` over `manage_*` / `execute_*`), (c) one target at a time unless explicitly a fleet operation.
2. **Guardrails** (from `BREEZE_AI_GUARDRAILS_CORE`) — always resolve and **echo the target device + org** before any mutation; treat Tier-3 tools as requiring explicit human confirmation; never act cross-tenant; never fabricate data; if a call is rejected by the server gate, surface the rejection rather than retrying blindly.
3. **Pointer** — "For common workflows, use the `breeze-*` prompts."

## MCP prompts (content spec)

Five named prompts. Read-heavy prompts are inherently safe; the two that reach Tier-3 tools embed the confirm-and-echo pattern in their rendered guidance.

| Prompt | Arguments | Rendered guidance shape |
|---|---|---|
| `breeze-fleet-triage` | `scope?` (org or site; default: all accessible) | Read-only sweep — alerts, offline devices, failed patches, reliability outliers, SLA breaches → single prioritized "what needs attention" summary |
| `breeze-device-investigate` | `device` (name/id) | Resolve context → device details, metrics, recent logs, vulnerabilities, reliability → root-cause summary with recommended next actions |
| `breeze-patch-remediate` | `target` (device/org/site) | Scan patch gaps → present findings → **echo resolved target + explicit confirm** → stage/apply (Tier-3 gated; guidance tells the model to stop at confirmation) |
| `breeze-incident-kickoff` | `summary`, `scope` | Create incident/ticket → build timeline → collect evidence → generate report |
| `breeze-turnkey-setup` | `scope` (partner or org; default partner-wide) | Opinionated baseline wizard — see below |

### `breeze-turnkey-setup` recommended baseline

Since the recommendations are encoded in the prompt (no canonical preset set exists in-product yet), the prompt walks the tech through these categories and **defaults every policy to partner-wide ownership** (`ownerScope: 'partner'`) per the partner-wide-first principle, confirming ownerScope before creating anything. Draft default values (for review — Todd's domain judgment governs):

- **Patch rings / cadence** — pilot ring patches on release; production ring 7-day deferral; security/critical auto-approve at 3-day deferral; feature updates deferred 30 days; reboots in an off-hours maintenance window.
- **Backup SLA** — daily backup, RPO 24h, retention 30 days, alert when no successful backup in 48h.
- **DNS security** — enable filtering; block malware / phishing / C2 / newly-registered-domain categories.
- **Peripheral policy** — block unauthorized USB mass-storage by default; allow HID.
- **Config / CIS baseline** — apply CIS Level 1 baseline for the device OS.
- **Core alert rules** — device offline > 15 min; disk > 90%; sustained CPU > 95% for 10 min; failed backup; critical patch missing > 7 days; reliability-score drop.

Each category maps to existing tools (`manage_update_rings`, `configure_backup_sla`, `manage_dns_policy`, `manage_peripheral_policies`, `apply_configuration_policy` / `manage_configuration_policy`, `manage_alert_rules`). The wizard previews before applying and confirms ownerScope + target.

## Testing

- **Prompt-vs-registry drift:** extend `aiToolsRegistryParity.test.ts` (or a sibling) so every tool name referenced in prompt guidance still exists in the `aiTools` registry — catches a renamed/removed tool leaving stale prompt text.
- **Prompt handlers:** unit tests for `prompts/list` (returns the five) and `prompts/get` — valid name renders, unknown name → JSON-RPC error, argument substitution works.
- **Instructions present:** a test asserting the `initialize` result now returns a non-empty `instructions` string.
- **Guardrails DRY:** a test (or type-level guarantee) that `MCP_SERVER_INSTRUCTIONS` and `AI_SYSTEM_PROMPT_BASE` both contain `BREEZE_AI_GUARDRAILS_CORE`, so neither can drop the shared safety core.

## Rollout

1. Ship `instructions` + `BREEZE_AI_GUARDRAILS_CORE` refactor first (smallest, highest safety value, universal).
2. Add the `prompts` capability + the two read-only prompts (`fleet-triage`, `device-investigate`) — zero destructive surface.
3. Add `patch-remediate` and `incident-kickoff`.
4. Add `turnkey-setup` last (biggest content lift; baseline values reviewed by Todd).

## Open items for plan phase

- Confirm the exact argument schema each existing tool expects (patch, backup SLA, DNS, peripheral, alert rules) so the turnkey wizard's guidance references real parameters.
- Decide final home for `BREEZE_AI_GUARDRAILS_CORE` (in `aiAgentSystemPrompt.ts` vs a new `aiGuardrailsText.ts`).
- Verify no client currently breaks on receiving a `prompts` capability at protocol `2024-11-05`.
