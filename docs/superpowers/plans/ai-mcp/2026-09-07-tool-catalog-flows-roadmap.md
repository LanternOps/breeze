---
tracking_issue: LanternOps/breeze#5215
---

# Tool Catalog + Flows — Wave Roadmap

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md` (approved in dialogue 2026-09-07; Codex xhigh quorum folded in, §11).
**Detailed plans:** one per wave, written when the wave starts (W1: `2026-09-07-tool-catalog-w1-tool-sources-mcp.md`). Each later plan is written against the as-built code of the waves before it, not against this roadmap.

## Dependency graph

```
W1 tool sources (MCP) ──► W2 OpenAPI kind
        │
        └──► W3 flow document + validator + draft tool ──► W4 runner + triggers + approvals ──► W5 webhook, flows-as-tools, ai/http steps ──► W6 automations conversion
```
W1/W2 are independent of W3+. W3 can start once W1's resolver (`resolveTenantTools`) is merged, because the validator resolves step tools through it.

## Waves

Sub-issues: W01 #5216, W02 #5217, W03 #5218, W04 #5219, W05 #5220, W06 #5221 (parent #5215).

| key | title | scope (spec §) | proves | PR shape |
|---|---|---|---|---|
| W01 | Tool sources (MCP): tables, discovery, resolver, chat + MCP bridge, external Tier 3 via intents, UI | §5, §8 | an MSP connects an MCP server and uses its tools in chat with correct tiers and approvals | PR A API core, PR B external Tier 3, PR C web |
| W02 | OpenAPI source kind | §5.3 (OpenAPI), §5.5 executor | vendors with only a REST API are reachable | one PR (parser/generator/executor + fixtures + UI kind toggle) |
| W03 | Flow document, expression grammar, validator, `flows` table, draft/validate/get tools, Flow card, read-only Flows UI | §6.1–6.4 (flows table only), §6.8 authoring | the AI produces a valid, reviewable flow from a sentence | PR A shared grammar + API, PR B web |
| W04 | `flow_runs`/`flow_run_steps`, runner, manual + schedule + event triggers, approval pause/resume with drift checks, pre-approval rule, runs UI, run/explain tools | §6.5–6.7 | a flow runs end to end with a human tap on the sensitive step | PR A runner + tables, PR B triggers, PR C web |
| W05 | Webhook trigger with org resolver, `flow.<slug>` as tool, for-each concurrency, `ai` and `http_request` steps, budgets and caps, `action_intents.requesting_flow_run_id` | §6.1 triggers, §6.6, §6.7, §8 | cross-system and external-event flows; agents can call flows | PR A + PR B |
| W06 | Legacy automations converter (`create_alert` core tool, awaitCompletion, deploy-after-fan-out), parity test, worker retirement gate | §7 | one engine | one PR + a release-gated follow-up to retire the worker |

## Standing rules for every wave plan

- Rigor: high (tenancy, credentials, approvals). Red test first; RLS forge suite per new table; contract suites (RLS coverage, cascade, export, erasure, org-merge) run against a real DB before the PR opens.
- Every new `org_id` table: `DUAL_AXIS_TENANT_TABLES` or shape-1 auto-discovery, `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY` (all jsonb → `excludedOpen`, secrets → `excludedSensitive`), `orgMergeRegistry`.
- Migrations sort after the newest committed file on **origin/main** (`2026-10-13-110000-…` as of 2026-09-07 — the ratchet is ~5 weeks ahead of real time; a worktree forked from a stale local main shows an older ceiling; check `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1`).
- Every org-XOR-partner table gets the additive `FOR SELECT`-only `<table>_partner_wide_select` policy on `breeze_current_partner_id()` (Partner-Wide First step 3) and is registered in `XOR_OWNERSHIP_DUAL_AXIS_TABLES`; never escalate to a system context to read partner-wide config.
- Non-goals (spec §3) hold in every wave: no connector library, no canvas, no branching beyond `when`/for-each, no sync engine, no LLM-per-run.
- Stacked PRs get no CI: `gh workflow run CI --ref <branch>` before merge; merge with bare `gh pr merge --squash`.
