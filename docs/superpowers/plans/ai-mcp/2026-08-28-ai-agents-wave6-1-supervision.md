---
tracking_issue: LanternOps/breeze#3821
wave: W07 (#3828) — PR 1 of 4 (Supervision)
---

# Wave 6 PR 1 — Supervision (Execution Trace) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators can finally SEE what their agents did: a runs list + run-detail page (the **execution trace** — deliberately not called a transcript; model messages are not persisted and raw tool inputs/outputs are never rendered), an org unattended-budget readout, and run-finished notifications that link somewhere real.

**Architecture:** The API gains versioned, projected DTOs (`schemaVersion: 1`, Partner-API schema precedent) replacing the raw-row returns: a keyset-paginated org-wide runs list (`(queued_at DESC, id DESC)` cursor, new index via migration) and a stitched run-detail response (run + SAFE outcome projection + ledger rows + linked intents summary). Safe projection is the load-bearing decision: `OutcomeProposedAction.args` (raw tool input) and `ai_tool_executions.toolInput/toolOutput` are NEVER serialized to the client — display fields only (`tool`, `action`, verdicts, `verifyDetail`, `actOpKey`, `actTargetName`, reasons, durations, timestamps). The exposure enforcement math extracts into a pure `computeExposureBudget(orgId)` reused by a new read route (labeled "recorded exposure", 48h window disclosed). Web: `/ai-agents/runs` list + `/ai-agents/runs/[id]` detail (Astro file-routing + `fetchWithAuth`, first cursor-pagination consumer in the web app), notification `link` wired to the detail page.

**Tech Stack:** TypeScript, Drizzle, ONE migration (the keyset index — `CREATE INDEX IF NOT EXISTS ... ON ai_agent_runs (org_id, queued_at DESC, id DESC)`, named after the newest committed migration — check at implementation time), Hono zValidator, React + Astro + i18n (8 locales).

**Design authority — LOCKED (wave-6 quorum 2026-08-28):** execution-trace framing; versioned DTOs, never raw rows; safe input projections NOW (deferring output redaction is defensible, exposing raw inputs is not); no raw transcript (persistSession stays false); exposure figures labeled "recorded exposure" reusing the exact enforcement calculation; keyset pagination with the id tiebreaker; notification links land on a page that ships in the SAME PR (vertical slice).

## Global Constraints

- Tests `cd apps/api && npx vitest run <path>`; typecheck heap bump; web: touched components + `src/lib/i18n/localeParity.test.ts`; new UI strings in `locales/*/settings.json` × ALL 8 locales.
- Migration: index-only, idempotent, sorts after newest committed (`2026-09-16-…` at plan time). `pnpm db:check-drift` clean (add the index to the Drizzle table-options too).
- DTO rule: every route response field enumerated by hand (`mapRow` precedent, aiAgents.ts:74-102) — adding a field later is a deliberate diff, and `schemaVersion: 1` literal per Partner-API precedent (partnerApi/schemas.ts:79). **Zod-validate the response shape in tests** so a raw-row regression fails loudly.
- The existing `GET /admin/tool-executions` route (routes/ai.ts:1207-1346) already exposes raw `toolInput` to admins — OUT OF SCOPE here (pre-existing, admin-gated); note it in the PR body as a candidate for the redaction-contract follow-up.
- Web mutation handlers via `runAction` where applicable (this PR is read-only UI — fetch patterns follow AiAgentsPage's `fetchWithAuth` precedent with its malformed-body guards).
- Commit after every task with trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_012o7QB15EFjEvetDAXMxmae`

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/<next>-ai-agent-runs-keyset-index.sql` (new) + schema table-options | The `(org_id, queued_at DESC, id DESC)` index. |
| `packages/shared/src/types/aiAgentRuns.ts` (new) | `AiAgentRunListItemDto`, `AiAgentRunDetailDto`, `AiAgentRunTraceEntryDto`, `ExposureBudgetDto` — all `schemaVersion: 1`. |
| `apps/api/src/routes/aiAgents.ts` (modify) | `GET /runs` (org-wide keyset list, filters: agentId?, status?), rework `GET /runs/:runId` → the stitched detail DTO; keep the legacy per-agent route shape working (or migrate its one consumer — grep). |
| `apps/api/src/services/aiAgents/runTrace.ts` (new) | The stitching + SAFE projection: outcome → trace entries; ledger rows (toolName/status/durations/error only); intents summary (id/status/actionName/approvalScope/decidedVia). |
| `apps/api/src/services/actionIntents/exposureBudget.ts` (new) | `computeExposureBudget(orgId)` extracted from policyDecide's transaction (pure read twin — policyDecide keeps its own transactional copy? NO: extract the two queries into the shared helper, call it from BOTH — inside the transaction it reuses the same SQL via the passed tx handle). |
| `apps/api/src/routes/aiAgents.ts` (modify) | `GET /exposure-budget` read route. |
| `apps/web/src/pages/ai-agents/runs/index.astro` + `[id].astro`, `apps/web/src/components/aiAgents/RunsListPage.tsx` + `RunDetailPage.tsx` (new) | The UI. |
| `apps/api/src/services/aiAgents/runFinishedNotify.ts` (modify) | `link: '/ai-agents/runs/<runId>'` (approvals link stays when intents pending — put run link in metadata `href` fallback order? NO — one link: run detail; the detail page links onward to approvals when intents pending). |
| locales × 8 (modify) | `aiAgentsPage.runs.*` keys. |

---

### Task 1: Index migration + shared DTOs

- Migration + Drizzle table-option index `orgQueuedIdIdx` (keep the old `orgQueuedIdx` — dropping an index is a separate decision; note redundancy in the migration comment for a future cleanup).
- Shared DTO types with `schemaVersion: 1` literals. Trace entry union: `{ kind: 'executed', tool, action?, result, durationMs, execution?, verification?, verifyDetail?, actOpKey?, actTargetName? } | { kind: 'proposed', tool, action?, intentId?, intentError?, downgradeReason? } | { kind: 'denied', tool, reason }` — **NO args/input/output fields exist on any variant** (the type makes the leak impossible).
- [ ] TDD (type-level + a compile-time exhaustiveness test) → commit: `feat(shared,api): run trace DTOs + keyset index (#3828)`

### Task 2: `runTrace.ts` + reworked detail route + org-wide list route

- `buildRunTrace(run, ledgerRows, intents): AiAgentRunDetailDto` — pure, unit-tested against fixture outcomes from waves 3-5 shapes (incl. v1 outcomes lacking verdict fields — tolerant). Ledger projection: `{ toolName, status, durationMs, createdAt, completedAt, errorMessage }` ONLY.
- `GET /runs/:runId` returns the detail DTO (loads ledger via `run.sessionId → ai_tool_executions`, intents via `intent_ids` array); 404 semantics unchanged; org scoping unchanged.
- `GET /runs` (new): query `{ cursor?, limit (≤50, default 25), agentId?, status? }` — keyset on `(queuedAt, id)` with opaque base64url cursor (mirror `routes/devices/cursor.ts`'s token shape, simplified to the one fixed sort); response `{ data: AiAgentRunListItemDto[], nextCursor: string | null }`. List item: id/agentId/agentName(join)/deviceId/status/triggerKind/runVerdict/queuedAt/finishedAt/costCents — no outcome payload.
- Zod response-shape tests: assert `JSON.stringify(response)` contains NO `"args"`, `"toolInput"`, `"toolOutput"`, `"arguments"` keys (the leak tripwire).
- [ ] TDD → commit: `feat(api): execution-trace detail + org-wide keyset runs list (#3828)`

### Task 3: Exposure budget helper + read route

- Extract `computeExposureBudget(dbOrTx, orgId): { distinctDevices, allowance, contractDevices, fleetPercent-limits…, policyDecisionsToday, dayCap, windowHours: 24 }` from `policyDecide.ts:252-289`'s queries; policyDecide's transaction calls it with its tx handle (behavior byte-identical — its tests must stay green untouched); the new `GET /exposure-budget` route calls it read-only + labels (`recordedOnly: true` note in the DTO; act-lane accounting is best-effort while the policy flag is dark — surface that as `accountingMode: 'partial' | 'full'` derived from the flag).
- [x] TDD (helper parity vs the inline queries — the policyDecide suite is the proof; route DTO shape) → commit: `feat(api): exposure budget read route reusing the enforcement calculation (#3828)`

### Task 4: Web — runs list + run detail + budget readout

- `RunsListPage`: filters (agent, status), cursor "Load more", verdict badges; row click → detail. `RunDetailPage`: header (agent/device/status/verdict/cost/duration), the trace timeline (executed w/ verdict chips + verifyDetail, proposed w/ downgrade reasons + intent links → `/approvals` when pending, denied w/ reasons), caps/flags (budgetExceeded etc.), budget readout card (org exposure: N of M devices, decisions today, "recorded exposure — last 48h" caption). `data-testid` on interactive elements (e2e convention). URL state via `window.location.hash` if tabs emerge (repo rule — no query params for transient UI state; the CURSOR is transient too — keep it in component state, not URL).
- Both `.astro` pages per the devices/[id] precedent. Nav entry: add a "Runs" link where AiAgentsPage lives (settings surface) — follow how sibling settings pages register; do NOT invent a new left-nav section.
- i18n keys × 8 locales + localeParity green. Component tests per repo pattern.
- [x] TDD → commit: `feat(web): agent runs list + execution-trace detail + exposure readout (#3828)`

### Task 5: Notification link + verification + PR

- `runFinishedNotify.ts:230`: `link: \`/ai-agents/runs/${run.id}\`` unconditionally (the detail page surfaces pending approvals itself); keep metadata unchanged; update its tests.
- Full api suite + shared + web tests + localeParity + typecheck + `pnpm db:check-drift` + contract suites + migration-naming; leak-tripwire greps (`"args"` etc. in route responses).
- [ ] Tick checkboxes. **Open the PR**: `feature/3821-ai-agents/wave-3828` → main, title `feat(api,web): wave 6.1 — supervision: execution-trace runs UI, exposure readout (#3828)`, body: "PR 1 of 4 for #3828 — do NOT close", the safe-projection rule, the admin-route redaction note, the deferred items list. **Stop after opening the PR.**

## Self-Review Notes

- The leak-impossible trace DTO union is the core safety property; the tripwire test enforces it at the serialization boundary too.
- `computeExposureBudget` extraction must keep policyDecide byte-identical (its suite is the regression net).
- Deferred (later PRs / follow-ups): fix-watch + circuit tables (PR 2), ticket lane (PR 3), anomaly pilot (PR 4), output redaction contract, admin tool-executions route projection.
