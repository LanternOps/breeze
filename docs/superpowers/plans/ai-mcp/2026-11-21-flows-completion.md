---
tracking_issue: LanternOps/breeze#12433
---

# Flows Completion (standalone Jobs: editor through R3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technician can build, edit, validate, enable and delete a flow without AI. Jobs and Flows share one nav entry, "Automations". The census is extended and run, and the live checks are recorded. Job creation is refused again, per trigger. The R2 freeze and the per-installation R3 retirement then ship as the W06 plan designed them.

**Architecture:**
- **Shared form core (`packages/shared/src/flows/form/`).** Pure, browser-safe functions:
  - compile form values into a `FlowDocumentV1`;
  - decode a document back into form values;
  - a whole-document recognizer that decides whether a stored document opens in the form.

  The step emitters for a script action, an alert action and the on-failure notice move here from the converter. The converter then calls them, and its output bytes do not change.
- **API.** Four REST routes in `routes/flows.ts` over the existing `saveDraftFlow`, a new delete service, and a validation service. There are no new AI or MCP tools.
- **Web.**
  - A guided form plus a Monaco JSON "Document" tab, at `/flows/new` and `/flows/:id/edit`.
  - `FlowEnableDialog` learns `fleetMaxTargets`.
  - One "Automations" sidebar entry, with a path-based tab strip on the existing `/flows` and `/jobs` pages.
- **Later waves** reuse the W06 plan's PR D and PR E as their design record, with the changes from spec §3.6.

**Tech stack:** TypeScript, Zod 4, Hono, Drizzle (queries only), Postgres forced RLS, React + Astro + react-i18next (8 locales), `@monaco-editor/react`, Vitest, Playwright (`data-testid` only).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-11-21-flows-completion-spec.md` (approved 2026-11-21; the resolutions are in the table at the top of §6). Read it together with this plan. This plan links to its sections rather than restating them.

**Related documents:**
- W06 plan: `docs/superpowers/plans/ai-mcp/2026-10-27-tool-catalog-w6-legacy-automations.md`. Waves 4 and 5 implement its "PR D — R2 freeze" and "PR E — R3 standalone admission retirement" sections. Its "Conversion map" fixes the shapes that the shared emitters keep. Its Decision 8 carries the 2026-11-21 amendment that this plan carries forward (W3, W4).
- Flows spec: `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md`. W1 amends its §3 (non-goals table, canvas row) and its §6.8.
- `CLAUDE.md`, `docs/agents/testing.md`, `docs/agents/tenancy-rls.md`.

**Baseline.** This plan was written at `origin/main` `ee33349cea`, against the state after PR #12366 (branch `fix/12310-reopen-job-creation`). That PR merged on 2026-11-22 as `affca27e0f`:
- `POST /automations` creates a Job whatever `FLOWS_ENABLED` says.
- "New job" opens the Job form.
- The Flows nav item carries `previewTag: true` (`Sidebar.tsx`, key `common:nav.previewTag`).
- `FlowsPage.tsx` shows `flows-preview-tag` and the rewritten empty state (`flows:empty.body`, `empty.how`, `empty.jobsLink`).
- The W06 plan has the Decision 8 amendment.
- Two keys are deliberately unused and are reused in W3: `flows:jobs.migration.newJobOpensFlows` ("New flow") and `flows:conversion.errors.automations_moved_to_flows`.

**Every part's first step is the baseline check.** Check the state, not a commit subject (a squash title can differ). Run `git fetch origin main && git show origin/main:apps/web/src/components/layout/Sidebar.tsx | grep -c previewTag`. It must be non-zero, and `git show origin/main:apps/api/src/routes/automations.ts | grep -c refuseCreateWhenFlowsEnabled` must be `0`. If not, #12366 has not merged: stop and report, because several W1 tests assume its files.

## Global Constraints

- **Rigor.**
  - W01a, W01b and W01e are high: a public API surface, a partner-wide write path, a delete, a refactor of the converter whose shapes the W06 parity suite proved, and the authority shown in the enable dialog. Each task writes its test first. One Opus review round per part.
  - W01c is high: it sets what a pre-approval authorizes.
  - W01d is low/mechanical: red first, typecheck, targeted tests.
  - W2 code is low. W3 is medium. W4 and W5 follow the W06 plan's high-rigor rules.
- **One PR per sub-issue part, base `main`, never stacked.** A PR whose base is not `main` gets no CI; if one is stacked anyway, run `gh workflow run CI --ref <branch>`. Merge with a bare `gh pr merge <N>`.
- **No migrations in W1 to W5.** A part that finds it needs one stops and raises it as a question for the owner. Every part states `Migration slot: none`.
- **Tests.**
  - API: `cd apps/api && npx vitest run <exact files…>`.
  - Shared: `cd packages/shared && npx vitest run <files>`.
  - Web: `cd apps/web && npx vitest run <files>`.
  - Never `pnpm --filter <pkg> test -- --run <path>`. Path filters are substring matches, so list dotted siblings explicitly. A run that reports 0 tests is a stall, not a pass.
- **Typecheck.** Read exit codes directly, never through a pipe to `tail`.
  - API, as CI runs it, from the repo root: `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"`. If it dies of heap, raise the heap and rerun. An OOM is not a pass.
  - Shared: `cd packages/shared && npx tsc --noEmit; echo "exit=$?"`.
  - Web: `cd apps/web && pnpm exec astro check; echo "exit=$?"`, then `pnpm lint`.
- **Integration suites** run only under the CI "Integration Tests" job. Locally:
  - Bring up the stack once: `pnpm test-stack up`.
  - Run a suite: `cd apps/api && npx vitest run --config vitest.integration.config.ts <file>`.
  - Tear it down afterwards and say so: `pnpm test-stack down`.
- **DB context** (`apps/api/src/db/index.ts`).
  - Request code runs in the caller's `withDbAccessContext` (RLS decides reach). No bare pool.
  - A `catch` around a query wraps that query in `withDbTransaction`, with the catch outside it. The precedent is `createDraft` in `services/flows/service.ts` (the slug-conflict savepoint).
  - Never start `withDbTransaction` beside siblings in a `Promise.all`.
- **Web mutations.**
  - Every POST/PUT/PATCH/DELETE goes through `runAction` (`apps/web/src/lib/runAction.ts`), using the CLAUDE.md catch pattern.
  - `apps/web/src/components/flows/api.ts` is already in the target set of `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`.
  - `POST /flows/validate` writes nothing. Its call site carries a reasoned `// runaction-exempt:` marker, because it gives inline feedback and must not toast (the guard's documented escape).
- **URL state.**
  - Transient UI state uses `window.location.hash` (`useHashTab` in `apps/web/src/lib/useHashState.ts`; guard `apps/web/src/lib/__tests__/no-hash-in-usestate.test.ts`). This covers the editor's Form/Document tab and the W3 "Waiting for enable" filter.
  - The Automations tab strip is path-based (spec §3.3). The Jobs page keeps its own hash tabs and `#convert-<id>`.
- **Locales.**
  - Every new key goes into all 8 locales: en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR.
  - Contracts: `apps/web/src/lib/i18n/{localeParity,translationCoverage,keyUsage,titleKeyUsage}.test.ts` and `apps/web/src/locales/{humanizedKeyRegression,monitoringNoInternalWaveNames}.test.ts`.
  - `t(cond ? a : b)` fails `keyUsage`. Use two literal `t()` calls, or an `/* i18n-dynamic */` key whose every value exists.
  - A value identical to English counts against the per-namespace baselines in `translationCoverage.test.ts`. Translate it, or justify a baseline entry.
  - Copy never names an internal wave.
- **Files** aim to stay under about 500 lines, split by resource or domain. `services/flows/service.ts` (530), `services/flows/versions.ts` (665), `routes/automations.ts` (about 2,240) and `routes/partnerApi/configuration.ts` (588) are already over, so new logic goes into new files.
- **Docs.**
  - User-facing changes update `apps/docs`, then regenerate the search index: `npx tsx scripts/build-docs-index.ts` (repo root; writes `apps/api/src/data/docsIndex.json`). `apps/api/src/services/aiToolsDocs.test.ts` fails on a stale index.
  - Exactly one part per wave owns `apps/docs/**` and `docsIndex.json`.
- **Release notes.** Each wave appends under its own heading in `docs/release-notes/next-release-draft.md` (`## Features / API`, or `## Self-Hosting / Upgrade Notes` for env lines). The file is a merge-queue hot spot: **append only, and rebase just before opening the PR.** One part per wave owns the append.
- **Public repo.**
  - No IPs, hostnames, regions, tenant or customer names, or internal domain mappings. Say "the two hosted installations"; never name their regions in the repo or on a public issue.
  - Census output never enters the repo.
  - Test addresses use `example.com`.
- **Permissions (unchanged rows).**
  - Draft create, update and validate: `automations.write` (validate: `automations.read`). No MFA, on either path (OD2 option i).
  - Delete: `automations.delete` + `requireMfa()`.
  - Partner-wide create, update and delete also need `canManagePartnerWidePolicies(auth)`.
  - Enable is unchanged (`automations.write` + MFA + interactive session + every delegation check).
- **Names and values (verbatim).**
  - Routes: `POST /api/v1/flows`, `PUT /api/v1/flows/:id`, `DELETE /api/v1/flows/:id`, `POST /api/v1/flows/validate`.
  - Error codes: `invalid`, `version_conflict`, `flow_not_draft`, `flow_not_found`, `partner_wide_forbidden`, `flow_has_history`, `slug_unavailable`, `slug_conflict`, `invalid_slug`, `owner_invalid`.
  - Audit actions: `flow.draft.save` (existing) and `flow.draft.delete` (new).
  - The W3 refusal is `410 { error: 'automations_moved_to_flows', flowsUrl: '/flows/new' }`.
  - `FLEET_MAX_TARGETS = 500`. `FLOW_RUN_LIMITS.notifyPerRunMax = 20`. `FLOW_LIMITS.maxSteps = 50`.
  - The editor paths are `/flows/new` and `/flows/:id/edit`.

## Review Focus

These are five conditions the spec implies that no single route test exercises, each pinned by a test in its owning task.

1. **A converted or AI-written document that looks like a form but is not one.** A script step with `timeoutSec: 600`, a document with `limits` or `notices`, or a converted notification (one per device) must open with the form read-only and the Document tab as the edit surface. Saving from the form must never drop a field. Tests:
   - W01a: `custom timeoutSec is not form-shaped`, `limits or notices are not form-shaped`, `converted per-device notice is not form-shaped`.
   - W01e: `a non-form document opens read-only with the Document tab active`.
2. **A stale write racing a person's save.** The editor sends `expectedVersion`. A 409 keeps the user's unsaved document and offers a reload. An AI or MCP `draft_flow` update without `expectedVersion` gets a warning in W1 and a refusal in W3. Tests:
   - W01b: `PUT with a stale expectedVersion is 409 version_conflict`, `draft_flow update without expectedVersion warns`.
   - W01e: `a 409 keeps the unsaved document and offers reload`.
3. **An org-scoped user looking at a partner-wide flow.** They can read it. Edit and Delete are not offered, and the API answers 404, never 403, so the row's writability is not disclosed. Tests:
   - W01b: `org token PUT on a partner-wide flow is 404`, `org token DELETE on a partner-wide flow is 404`.
   - W01e: `an org-scoped user sees no Edit or Delete on a partner-wide flow`.
4. **Delete racing enable.** Two tabs act on one draft. Both lock the row `FOR UPDATE`, so the second action sees the first one's commit: a delete after an enable is `409 flow_has_history`; an enable after a delete is a 404. Test: W01b integration `delete after a concurrent enable commits is flow_has_history`.
5. **Enabling a hand-built scheduled script with a pre-approval.** Ticking pre-approval on a `run_script_on_targets` step requires a `maxTargets` between 1 and 500 before Confirm is active. A webhook-triggered flow offers no pre-approval and says why. Tests (W01c): `pre-approving a fleet step requires maxTargets 1–500`, `enable sends fleetMaxTargets for ticked fleet steps only`, `a webhook flow offers no pre-approval`.

## Decisions taken in this plan (deviations from and sharpenings of the spec)

Each one is flagged in its PR body.

- **P1. W1 has five parts, not three PRs.** Spec §8 lists PRs A, B and C. The shared compile helpers and recognizer are carved out as W01a, because the editor depends on them and the API routes do not. The `fleetMaxTargets` enable-dialog work is carved out as W01c, because it touches no locale file and no editor file. The result is that W01b, W01c and W01d start at once, and W01e starts once W01a's shared commit exists. See "Execution split and parallelism" under W1.
- **P2. Fleet outputs gain `succeededCount` and `failedCount`.** Spec §3.1 says the one-per-run notification "says how many devices succeeded and failed". Flow templates are paths only (`packages/shared/src/flows/templates.ts`: "template bodies are paths only, never expressions"), and `FlowFleetStepOutput` carries id arrays, `count`, `warnings` and (for `resolve_targets` only) an optional `devices` list, but no per-outcome counts. No validator checks a template path below `.output` against a declared shape (`flows/structure.ts`), so no schema change is needed. W01a adds two scalar fields to `FlowFleetStepOutput`, set by all three builders (`builtins/runScriptOnTargets.ts`, `fleetStep.ts`, `builtins/resolveTargets.ts`). The form's notify message can then template `{{steps.<id>.output.succeededCount}}`. The change is additive. Test: `run_script_on_targets output carries succeeded and failed counts`.
- **P3. The run link.** The `notify` built-in links `/flows/<flowId>` (`builtins/notify.ts`), not the run, and the template scope has no run id (`runSlice.ts`: roots `trigger, inputs, steps, item, flow, now`). This plan does **not** change the link, which leaves "links the run" unmet. The flow page's Runs tab lists the run. This is an owner question (Q2).
- **P4. The recognizer is browser-safe and does not use the shared canonicalizer.** `@breeze/shared/canonicalize` pulls in `node:crypto` and is kept out of the root barrel (its own header says so). The recognizer normalizes both documents with `flowDocumentV1Schema.parse` (which fills step defaults) and compares them with a key-order-insensitive structural equality in the form module.
- **P5. The `/automations` redirect is a client island, not a server redirect.** No Astro page reads the server's `FLOWS_ENABLED` at SSR; the web learns it from `/config` through `useFlowsGate()` in `stores/featuresStore.ts`. `pages/automations/index.astro` renders a small island that calls `window.location.replace(enabled ? '/flows' : '/jobs')` once the gate has loaded, with a plain `<noscript>` link. The response is a 200, so it is never cached as a permanent redirect. The old cached 301 to `/jobs` still lands on a page that carries the tab strip (spec §3.3). Test: `/automations sends Flows-on users to /flows and Flows-off users to /jobs`.
- **P6. The Jobs tab count comes from a new additive field on `GET /automations`.** The Jobs page pages the list (default 50, maximum 100) and hides monitor-managed rows on the client, so a client-side count is wrong. W01b adds `jobCounts: { notMoved: number }` to the existing list response. `notMoved` counts rows in the caller's reach (the same owner and site rules as the list) that are standalone (class S: not retired, `managed_by_monitor_id` NULL, `managed_by_agent_id` NULL, no `_policyWorkflow` filter key) and not switched (`converted_to_flow_id` NULL). This adds no route. The web treats a missing field as "no count". Test: `GET /automations reports jobCounts.notMoved for standalone unswitched rows only`.
- **P7. The `draft_flow` refusal lands in W3.** Spec §3.2 stages "warn for one release, then refuse" without naming a wave. W3 is the first wave guaranteed to ship at least one release after W1, and its release notes already describe a refusal.
- **P8. Parity pins for the no-MFA decision.** `routes/flows.ts`'s `requireAutomationWrite` alias includes `requireMfa()`, so the draft routes must not reuse it. W01b adds a test that an MFA-unsatisfied session can save a draft, and a pin that `draft_flow` is absent from `MFA_GATED_TOOL_ACTIONS`. It also adds binding rows to `services/aiGuardrails.routeBinding.contract.test.ts`: `draft_flow` ↔ `POST /` and `PUT /:id`, and `validate_flow` ↔ `POST /validate` in `flows.ts`. The tool then can never require less than its route.
- **P9. W2 adds one more census number.** `approval_each_run` fires both for webhook runs and for non-pre-approvable scripts (`convertAutomation.ts`), so it cannot decide OD5 on its own. W02a adds `webhookScriptJobs`: enabled, unswitched S rows with a webhook trigger and at least one `run_script` or `execute_command` action. Aggregate only.
- **P10. Census class C.** It counts `config_policy_automations` rows with `retired_at IS NULL`, total and enabled. It reads that table only and never `config_policy_feature_links`, so `services/featureLinkReaders.contract.test.ts` is unaffected.
- **P11. Page titles.** Page titles live in `locales/*/pages.json`. To avoid adding a title key in 8 locales, `/flows/new` uses the existing `titles.flows` key and `/flows/:id/edit` uses `titles.flowDetail`; no part touches `pages.json` in W1.
- **P12. Keyboard shortcut.** `G` then `J` (`lib/keyboard/goToShortcuts.ts`, `nav.jobs`, `/jobs`) stays, because `/jobs` stays a real tab. No change.
- **P13. Route error codes.** The spec names the statuses; this plan names the bodies:
  - A partner-wide denial is `403 { error: 'partner_wide_forbidden' }`. The service returns prose (`PARTNER_WIDE_WRITE_DENIED_MESSAGE`).
  - Any other owner-resolution message is `400 { error: 'owner_invalid', message }`, or 403 for an access denial.
  - An invalid document is `422 { error: 'invalid', validation }`.
  - A successful delete is `204` with no body.
- **P14. The W3 refusal's input.** It reads `trigger.type ?? triggerType` (the route accepts both, `createAutomationSchema`). A missing or unknown type answers 410 when Flows are on. Only `event` on a non-durable installation passes through.
- **P15. "Waiting for enable" API shape.** `GET /flows?awaitingEnable=true`, evaluated per row over at most one page (≤ 100) against the creator's current permissions, with the enable path's delegation rule. There is no new column (spec §4).
- **P16. Where "Delete draft" sits.** On the flow detail page, only for a never-published, never-converted draft and only with `automations.delete`. The editor does not show it.
- **P17. Webhook secrets and the editor.** `updateDraft` always bumps `definition_version` and `updated_at`, and `webhookSecretSurvivesEnable` (`versions.ts`, #10270) then clears a secret minted against an older draft. So:
  - The editor never sends a PUT for an unchanged document. "Save and enable" skips the save when nothing changed.
  - For a webhook-triggered flow the editor offers Save only, never "Save and enable" (P21). The secret is minted and the flow enabled on `/flows/<id>#webhook`, after the last save.
  - So the editor's own enable path should never see `webhookSecretInvalidated: true`: enable sets it only for a webhook trigger (`enableFlow` in `versions.ts`). If it ever arrives, the editor stays put and shows the existing `flows:enable.webhookSecretInvalidated` notice with a link to `/flows/<id>#webhook` instead of navigating away. Otherwise it navigates to `/flows/<id>`.
  - Whether "Disable and edit" warns about this up front is Q6.
- **P18. Model tiers that differ from the default heuristic.**
  - W01a runs as **sonnet**, with Opus review of its recognizer and converter-rewiring commits. It is pure code, guarded by a golden file.
  - W02a runs as **opus**, because its one guarantee is that no identifier leaves a production host for a public issue.
- **P19. Event targets.** The form binds the triggering device for every event type in the Job form's list and hides the picker, as the converter does for every event Job (`selectorOf` in `convertAutomation.ts`). `trigger.device` exists only when the payload carries the uuid of a device in the run org (`services/flows/triggerScope.ts`). Some events may carry none (for example a SentinelOne threat without a mapped device), and then the step fails. This is Q5.
- **P20. `draft_flow` also requires `automations.read`.** Its REST twins (`POST /flows`, `PUT /flows/:id`) inherit the router-level `requirePermission('automations', 'read')` in `routes/flows.ts`, so the route requires read and write. `aiGuardrails.routeBinding.contract.test.ts` adds that router-level gate to the route's set and fails any tool that requires less than its route. W01b adds `draft_flow: [{ resource: 'automations', action: 'read' }]` to `TOOL_EXTRA_PERMISSIONS` in `services/aiGuardrails.ts` (the primary `automations.write` in `TOOL_PERMISSIONS` stays). The tool then needs read and write, the same as its REST twin. A caller with write but not read could never reach the REST route either. W01b checks the seeded role definitions for any role that grants `automations.write` without `automations.read` and states the result in the PR; if one exists, it stops and raises it as a question for the owner (not checked by this plan). Each draft route writes its permission gate inline in the route call, never as a `const` array alias: the binder's alias parser recognizes only `const X = requirePermission(…)`, and an array alias would resolve to nothing.
- **P21. Webhook flows are enabled from the flow page, not the editor.** A webhook flow cannot be enabled without a secret (`webhook_secret_missing`), the secret is minted on `/flows/<id>#webhook`, and any draft save after the mint invalidates it at the next enable (P17). So for a webhook-triggered flow the editor shows Save only. After a successful save it shows a notice (`flow-editor-webhook-next`) linking to `/flows/<id>#webhook`, where the person mints the secret and enables. Tests (W01e): `a webhook flow offers Save only and links to the webhook tab after saving`.
- **P22. The Flows-off branch is pinned by component tests, not Playwright.** One Playwright stack runs one `FLOWS_ENABLED` value. E8a runs with Flows on and covers `/automations`, `/automations/new` and `/automations/<id>`. The Flows-off behaviour (sidebar entry links `/jobs`, no Flows tab, `/automations` lands on `/jobs`) is pinned by the W01d component tests (`it links /jobs when Flows is off`, `the Flows tab is hidden when Flows is off`, `/automations sends Flows-on users to /flows and Flows-off users to /jobs`).

## Owner gates

- **Census on the two hosted installations (W02b).** This is a production action. It runs **only on the owner's separate go-ahead**, given after W1 is deployed to both. Only the JSON aggregates the CLI prints leave the host. The results go into a comment on the feature issue, **never into the repo**. The operator should expect the system audit rows that §3.5 describes.
- **Release spacing.**
  - W3 ships at least one release after W1, only after the W02b checks pass and OD5 and OD6 are decided from the census.
  - W4 ships at least one release after W3.
  - W5 ships at least one release after W4, and only after every W3a item adopted for R3 has shipped.
- **The hosted condition for W5.** R3 on the hosted installations requires the hosted census to show zero enabled unswitched S rows, or the owner's recorded acceptance. Setting `LEGACY_JOBS_RETIREMENT_ACCEPTED=true` on a hosted installation is a production change that needs that recorded acceptance. Each self-hosted installation decides for itself.
- **W3a items.** Each needs its own plan approval (Gate B) before any code.

## Wave and sub-issue map

| Id | Title | Depends on | Parallel with | Model | Size | Owner gate |
|---|---|---|---|---|---|---|
| W01a | Shared flow-form core and converter rewiring | — | W01b, W01c, W01d | sonnet (Opus review of A2, A3) | M | — |
| W01b | Draft REST routes, delete, validate, `jobCounts` | — | W01a, W01c, W01d | opus | M | — |
| W01c | Enable dialog: `fleetMaxTargets` and the webhook rule | — | W01a, W01b, W01d | opus | S | — |
| W01d | One "Automations" nav entry and the path tab strip | — (reads W01b's `jobCounts` when present) | W01a, W01b, W01c | sonnet | S | — (built to the Q1 default, option a) |
| W01e | Manual flow editor, docs, spec amendment, wave verification | W01a's shared commit (copied); merges after W01a–d | W01b, W01c, W01d (until merge) | opus | L | — |
| W02a | Census additions | W1 merged | — | opus | S | — |
| W02b | Census run and the eight live checks (operator, no PR) | W02a + W1 deployed to hosted | — | owner/operator | operator time | **Production census go-ahead** |
| W03a | Per-trigger create refusal and API pieces | W02b passed; OD5, OD6 decided | W03b | opus | S | **≥ 1 release after W1** |
| W03b | Web, Preview removal, docs, wave verification | W03a merges first | W03a (until merge) | sonnet | S | same as W03a (Q4 answered before W3 is briefed; default option a) |
| W3a-1…4 | Conditional parity prerequisites | census counts | each other | per plan | 0 to L | **Each its own Gate B** |
| W04a | R2 freeze and pre-create sweep (W06 PR D) | W3 released | W04b | opus | M | **≥ 1 release after W3** |
| W04b | Partner API read-only flows export | — | W04a | opus | S | same release as W04a or earlier |
| W04c | R2 banner, read-only edit page, all W4 docs except the env row, wave verification | W04a, W04b merged (starts after) | — | sonnet | S | — |
| W05a | R3 gate and retirement sweep (W06 PR E) | W4 released; adopted W3a items shipped | — | opus | M | **≥ 1 release after W4; hosted condition** |
| W05b | R3 banner, Jobs-tab hiding, docs, wave verification | W05a merged (starts after) | — | sonnet | S | — |

**Tracking.** Feature parent: #12433. Sub-issues, in the order of the map above: W01a #12434, W01b #12435, W01c #12436, W01d #12437, W01e #12438, W02a #12439, W02b #12440, W03a #12441, W03b #12442, W04a #12443, W04b #12444, W04c #12445, W05a #12446, W05b #12447. The W3a items have no sub-issue until the census adopts one. The tracker's own wave keys run W01 to W14 in that order; the ids in this plan are the names used in titles and branches.

**Open questions.** The six questions at the end of this plan are open. W1 is built to the default each one names; a different answer is a follow-up change, not a blocker.

## File structure (W1)

**packages/shared (W01a)**
- Create `src/flows/form/types.ts`: `FlowFormValues`, `FlowFormTrigger`, `FlowFormTarget`, `FlowFormAction`, `FlowFormOnFailure`.
- Create `src/flows/form/emit.ts`, the step emitters shared with the converter.
- Create `src/flows/form/compile.ts` (`compileFlowForm`) and `src/flows/form/decode.ts` (`decodeFlowForm`).
- Create `src/flows/form/recognize.ts` (`normalizeFlowDocument`, `recognizeFlowForm`), `src/flows/form/equality.ts` (`structurallyEqual`, `sameFlowDocument`) and `src/flows/form/jsonSchema.ts` (`flowDocumentJsonSchema`).
- Create `src/flows/form/index.ts`, with tests beside each file.
- Modify `src/flows/index.ts` (export `./form`) and `src/flows/builtins.ts` (`FlowFleetStepOutput` gains the counts).

**packages/shared (W01b)**
- Create `src/validators/flowDrafts.ts`: `flowDraftCreateRequestSchema`, `flowDraftUpdateRequestSchema`, `flowDraftDeleteRequestSchema`, `flowDraftValidateRequestSchema`, plus a test.
- Modify `src/validators/index.ts` (export it).

**apps/api (W01a)**
- Modify `services/flows/conversion/convertAutomation.ts` to call the shared emitters.
- Modify `services/flows/builtins/runScriptOnTargets.ts`, `services/flows/fleetStep.ts` and `services/flows/builtins/resolveTargets.ts` to set the counts.
- Create `services/flows/conversion/convertAutomation.golden.test.ts` and `__fixtures__/convertAutomation.golden.json`.
- Create `services/flows/form/flowFormCompile.validates.test.ts`, which runs the real catalog-aware validator over compiled form documents.

**apps/api (W01b)**
- Modify `routes/flows.ts`: the four routes, registered before every `/:id` route.
- Create `services/flows/deleteDraft.ts` (`deleteDraftFlow`) and `services/flows/draftValidation.ts` (`validateFlowDraft`).
- Modify `services/aiToolsFlows.ts` (the `draft_flow` warning), `services/mcpCoverage.ts` (the `flows.ts` entry), `services/aiGuardrails.ts` (`draft_flow` in `TOOL_EXTRA_PERMISSIONS`, Decision P20) and `routes/automations.ts` (`jobCounts` on `GET /`).
- Tests:
  - `routes/flows.drafts.test.ts`, `services/flows/deleteDraft.test.ts`, `services/flows/draftValidation.test.ts`;
  - `__tests__/integration/flowDraftRoutes.integration.test.ts`;
  - edits to `services/aiToolsFlows.test.ts`, `routes/automations.test.ts` and `services/aiGuardrails.routeBinding.contract.test.ts`.

**apps/web (W01c)**
- Create `components/flows/FleetMaxTargetsField.tsx`, with a test.
- Modify `components/flows/FlowEnableDialog.tsx` and `components/automations/conversion/SwitchDialog.tsx`, with their tests.
- No locale files.

**apps/web (W01d)**
- Modify `components/layout/Sidebar.tsx`, `lib/paletteIndex.ts`, `pages/flows/index.astro`, `pages/jobs/index.astro` and `pages/automations/index.astro`.
- Create `components/automations/AutomationsTabStrip.tsx` and `components/automations/AutomationsRedirect.tsx`, with tests.
- Modify `common.json` in all 8 locales, `components/layout/Sidebar.flows.test.tsx` and `components/layout/Sidebar.nav.test.tsx` (it pins a top-level Jobs entry at `/jobs`), plus any other `Sidebar.*.test.tsx` the change turns red. The full set, every one run by W01d: `Sidebar.aiSection`, `Sidebar.billing`, `Sidebar.collapsedrail`, `Sidebar.contrast`, `Sidebar.extensions`, `Sidebar.featuregate`, `Sidebar.flows`, `Sidebar.hydration`, `Sidebar.mobiledrawer`, `Sidebar.module`, `Sidebar.nav`, `Sidebar.railflyout`, `Sidebar.rbac`, `Sidebar.recents`, `Sidebar.scrollpersist`, `Sidebar.sites`, `Sidebar.staleness`, `Sidebar.tickettypes`, `Sidebar.toolSources`, `Sidebar.unassigned` (each `.test.tsx`).

**apps/web, apps/docs, docs (W01e)**
- Create `components/flows/editor/`:
  - `FlowEditorPage.tsx`, `FlowFormView.tsx`;
  - `TriggerSection.tsx`, `TargetSection.tsx`, `ActionsSection.tsx`, `OnFailureSection.tsx`;
  - `FlowDocumentTab.tsx`, `useFlowValidation.ts`, `editorState.ts`;
  - tests beside each.
- Create `pages/flows/new.astro` and `pages/flows/[id]/edit.astro`.
- Modify `components/flows/api.ts`, `FlowDetailPage.tsx` and `FlowsPage.tsx`.
- Modify `components/automations/AutomationForm.tsx`, to export its event-type list as `getEventTypeOptions`.
- Modify `flows.json` in all 8 locales.
- Docs: `apps/docs/src/content/docs/reference/api.mdx`, `features/flows.mdx`, `features/automations.mdx`, and `apps/api/src/data/docsIndex.json`.
- Modify the Flows spec (§3 canvas row, §6.8) and `docs/release-notes/next-release-draft.md`.
- Create `e2e-tests/tests/flows-editor.spec.ts` and `e2e-tests/pages/FlowEditorPage.ts`.

---

## W1 — Editor and one nav item

Spec §3.1–§3.3 and §8 row W1. Gating: none beyond `FLOWS_ENABLED`. "Preview" stays on through W1 (its placement depends on Q1).

### Execution split and parallelism

**Sub-issue split.** W1 is split into five parts, every one branched from `main`, each opening one PR to `main`.

| Part | Owns (file-disjoint) | Session model |
|---|---|---|
| **W01a** | `packages/shared/src/flows/**` (the form module and `builtins.ts`); `apps/api/src/services/flows/conversion/convertAutomation.ts` and its new golden test; the three fleet output builders and their tests; `apps/api/src/services/flows/form/**` (test only) | sonnet, with Opus review of A2 (recognizer) and A3 (converter rewiring). Pure code, guarded by the golden file (P18). |
| **W01b** | `packages/shared/src/validators/{flowDrafts.ts,index.ts}`; `apps/api/src/routes/flows.ts`, `routes/automations.ts` (the `GET /` handler only); `services/flows/{deleteDraft,draftValidation}.ts`; `services/flows/versions.ts` (a single export, see B3); `services/aiToolsFlows.ts`; `services/mcpCoverage.ts`; `services/aiGuardrails.ts` (one `TOOL_EXTRA_PERMISSIONS` entry, P20; no other W1 part touches it); their tests; the new integration file; `aiGuardrails.routeBinding.contract.test.ts` | opus (partner-wide writes, delete, MFA) |
| **W01c** | `apps/web/src/components/flows/{FleetMaxTargetsField,FlowEnableDialog}.tsx`, `components/automations/conversion/SwitchDialog.tsx`, their tests | opus (what a pre-approval authorizes) |
| **W01d** | `components/layout/Sidebar.tsx` and every `components/layout/Sidebar.*.test.tsx` it turns red (at least `Sidebar.flows` and `Sidebar.nav`; full list under "File structure (W1)"), `lib/paletteIndex.ts` and its test, `components/automations/{AutomationsTabStrip,AutomationsRedirect}.tsx`, `pages/{flows/index,jobs/index,automations/index}.astro`, `locales/*/common.json` | sonnet |
| **W01e** | `components/flows/editor/**`, `pages/flows/{new,[id]/edit}.astro`, `components/flows/{api,FlowDetailPage,FlowsPage}.tsx` and their tests, `components/automations/AutomationForm.tsx` (one export), `locales/*/flows.json`, `translationCoverage.test.ts` if needed, `apps/docs/**`, `docsIndex.json`, the Flows spec, the release-notes append, `e2e-tests/**` | opus |

**Real dependency order.**
1. W01a, W01b, W01c and W01d start together.
2. W01e starts once W01a has pushed its shared-module commit (Task A2). It copies `packages/shared/src/flows/form/**` and the `src/flows/index.ts` export line **verbatim** from W01a's branch, so the later rebase is byte-identical. It re-copies after any W01a review change to those files. Before opening its PR, after rebasing on `main` with W01a merged, W01e checks that `git diff origin/main -- packages/shared/src/flows/form packages/shared/src/flows/index.ts` is empty; a non-empty diff means the copy went stale and is re-copied from `main`.
   - W01e does not import W01b's `flowDrafts` request schemas; its API client declares its own request types (Task E1), so it compiles before W01b merges.
   - W01d declares the `jobCounts` response field as a local optional type in the web; it does not import a shared DTO from W01b.
3. Merge order: W01a, then W01b, W01c and W01d in any order, then W01e. W01e merges last because its "New automation" button and editor need W01b's routes, and its Playwright run needs W01c's dialog and W01d's strip.

W01d reads W01b's `jobCounts` field when it is present and renders no count without it, so either can merge first. If a release is cut mid-wave, the parts already merged are inert or additive: the routes are unused until the editor ships, the dialog field only appears for fleet steps, and the nav is self-contained.

**Whole-wave verification:** W01e (Task E8).

**W01a — PARALLEL GROUPS**
- **SERIAL first:** A1, the golden capture on unmodified code.
- **SERIAL:** A2, the shared emitters and the form module. Push this commit at once; W01e copies it.
- **PARALLEL GROUP A-1 (file-disjoint, after A2):**
  - A3: the converter rewiring (`convertAutomation.ts`).
  - A4: fleet counts (`builtins.ts` type plus the three API builders).
  - A5: the API-side `flowFormCompile.validates.test.ts`.

  A4's edit to `builtins.ts` is a single interface; A3 does not touch that file.
- **SERIAL last:** A6, contracts and PR.
- **Sonnet (session):** all tasks.
- **Opus review:** A1's case list, A2's `emit.ts`, `compile.ts`, `decode.ts` and `recognize.ts`, and A3.
- **Commands:**
  - `cd packages/shared && npx vitest run src/flows/form src/flows/builtins.test.ts src/browserSafeBarrel.test.ts` (the last is the guard behind Decision P4);
  - `cd apps/api && npx vitest run src/services/flows/conversion src/services/flows/form src/services/flows/builtins/runScriptOnTargets.test.ts src/services/flows/builtins/resolveTargets.test.ts src/services/flows/fleetStep.test.ts`;
  - both typechecks.
- **Migration slot:** none.

**W01b — PARALLEL GROUPS**
- **SERIAL first:** B1, the shared request schemas and the create and update routes.
- **PARALLEL GROUP B-1 (after B1):**
  - B2: validate (`draftValidation.ts`, its route block).
  - B4: `aiToolsFlows.ts` and `mcpCoverage.ts`.
  - B5: `routes/automations.ts` `jobCounts`.

  B2 adds a route block to `flows.ts` that B3 also edits. Run B2 and B3 serially, or let one subagent own `flows.ts` and merge at review.
- **SERIAL:** B3, delete (`deleteDraft.ts`, its route block, the integration file).
- **SERIAL last:** B6, contracts and PR.
- **Sonnet-eligible:** B1's schema file and its test; B4's `mcpCoverage.ts` line; B5's response plumbing.
- **Opus:** B1's routes, B2, B3, B4's warning, B6.
- **Commands:**
  - `cd apps/api && npx vitest run src/routes/flows.drafts.test.ts src/routes/flows.test.ts src/services/flows/deleteDraft.test.ts src/services/flows/draftValidation.test.ts src/services/aiToolsFlows.test.ts src/routes/automations.test.ts src/services/aiGuardrails.test.ts src/services/aiToolPermissionsCatalogParity.contract.test.ts`;
  - the contract batch in B6;
  - `cd packages/shared && npx vitest run src/validators/flowDrafts.test.ts`;
  - both typechecks.
- **Migration slot:** none.

**W01c — PARALLEL GROUPS**
- **SERIAL:** C1 (extract the field), then C2 (enable dialog). Two tasks; no parallel group.
- **Sonnet-eligible:** C1's extraction.
- **Opus:** C2.
- **Commands:** `cd apps/web && npx vitest run src/components/flows/FleetMaxTargetsField.test.tsx src/components/flows/FlowEnableDialog.test.tsx src/components/automations/conversion/SwitchDialog.test.tsx`; astro check; lint.
- **Migration slot:** none.

**W01d — PARALLEL GROUPS**
- **PARALLEL GROUP D-1:**
  - D1: Sidebar, palette.
  - D2: the tab strip and the two list pages.
  - D3: the `/automations` island and its page.
- **SERIAL last:** D4, the `common.json` fan-out in all 8 locales, then the i18n contracts and PR.
- **Sonnet:** all of it. Opus reviews D1's active-state rule.
- **Commands:**
  - `cd apps/web && npx vitest run src/components/layout/Sidebar.aiSection.test.tsx src/components/layout/Sidebar.billing.test.tsx src/components/layout/Sidebar.collapsedrail.test.tsx src/components/layout/Sidebar.contrast.test.tsx src/components/layout/Sidebar.extensions.test.tsx src/components/layout/Sidebar.featuregate.test.tsx src/components/layout/Sidebar.flows.test.tsx src/components/layout/Sidebar.hydration.test.tsx src/components/layout/Sidebar.mobiledrawer.test.tsx src/components/layout/Sidebar.module.test.tsx src/components/layout/Sidebar.nav.test.tsx src/components/layout/Sidebar.railflyout.test.tsx src/components/layout/Sidebar.rbac.test.tsx src/components/layout/Sidebar.recents.test.tsx src/components/layout/Sidebar.scrollpersist.test.tsx src/components/layout/Sidebar.sites.test.tsx src/components/layout/Sidebar.staleness.test.tsx src/components/layout/Sidebar.tickettypes.test.tsx src/components/layout/Sidebar.toolSources.test.tsx src/components/layout/Sidebar.unassigned.test.tsx src/components/automations/AutomationsTabStrip.test.tsx src/components/automations/AutomationsRedirect.test.tsx src/lib/paletteIndex.test.ts`;
  - the i18n batch in D4;
  - astro check; lint.
- **Migration slot:** none.

**W01e — PARALLEL GROUPS**
- **SERIAL first:** E1, the API client.
- **PARALLEL GROUP E-1 (after E1):**
  - E2: the editor shell and state.
  - E4: the Document tab.
  - E5: the entry points on the detail and list pages.
- **SERIAL:** E3 (form sections) after E2.
- **SERIAL:** E6, the `flows.json` fan-out in all 8 locales, after E2–E5 settle their keys.
- **PARALLEL GROUP E-2:**
  - E7: docs, docs index, spec amendment, release notes.
  - E8a: the Playwright spec.
- **SERIAL last:** E8, wave verification and PR.
- **Sonnet-eligible:** E1's plumbing, E6, E7, E8a's page object.
- **Opus:** E2, E3, E4, E5, E8, and the review of all Sonnet output.
- **Commands:**
  - `cd apps/web && npx vitest run src/components/flows/editor src/components/flows/api.test.ts src/components/flows/FlowDetailPage.test.tsx src/components/flows/FlowsPage.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/lib/__tests__/no-hash-in-usestate.test.ts`;
  - the i18n batch;
  - astro check; lint;
  - `npx tsx scripts/build-docs-index.ts && cd apps/docs && pnpm exec astro check`.
- **Migration slot:** none.

**CPU.** Never more than one `tsc` at a time across a parallel group.

---

### W01a — Shared flow-form core and converter rewiring

#### Task A1: Golden capture of the converter's output (characterization, before any move)

**Files:**
- Create `apps/api/src/services/flows/conversion/convertAutomation.golden.test.ts`.
- Create `apps/api/src/services/flows/conversion/__fixtures__/convertAutomation.golden.json`.

**Interfaces:**
- Consumes: `convertAutomation`, `row`, `ctx` and the fixture constants from `__fixtures__/automations.ts`.
- Produces: a frozen record that A3 must reproduce byte for byte.

- [ ] **Step 0:** the baseline check (header).
- [ ] **Step 1: Write the capture test.** Cover at least the eight `CASES` in `convertAutomation.validates.test.ts`, plus:
  - `onFailure: 'notify'` with one channel and a script;
  - an alert first (a `targets` step);
  - an alert after a script under `continue` (an `a<i>_devices` step);
  - a partner-wide schedule on a filter target;
  - event-bound with an alert only.

  For each case, `it('converter output is unchanged — <label>')` asserts that `JSON.stringify({ fidelity, findings, document, documentDigest, preApprovalCandidates, generatedScripts })` equals the stored JSON entry. A missing entry fails unless `UPDATE_GOLDEN=1` writes it.
- [ ] **Step 2:** run `UPDATE_GOLDEN=1 npx vitest run src/services/flows/conversion/convertAutomation.golden.test.ts` once on **unmodified** code, then without the variable. Expected: every test passes and the JSON is non-empty.
- [ ] **Step 3: Commit** `test(flows): golden capture of converter output before the emitter move (#<sub-issue>)`.

#### Task A2: The shared form module

**Files:**
- Create `packages/shared/src/flows/form/{types,emit,compile,decode,recognize,equality,jsonSchema,index}.ts`, with `*.test.ts` beside `emit`, `compile`, `decode`, `recognize`, `equality` and `jsonSchema`.
- Modify `packages/shared/src/flows/index.ts`.

**Interfaces (produced; W01e, W02a and A3 consume these exact names):**

```ts
// types.ts
export type FlowFormTrigger =
  | { type: 'schedule'; cron: string; timezone: string }
  | { type: 'event'; event: string; filter: Record<string, string | number | boolean> }
  | { type: 'webhook'; auth: 'hmac' | 'token'; orgResolver?: FlowWebhookOrgResolver }
  | { type: 'manual' };
export type FlowFormTarget = { kind: 'trigger_device' } | { kind: 'target'; target: DeploymentTargetConfig };
export type FlowFormAction =
  | { type: 'run_script'; scriptId: string; parameters?: Record<string, string | number | boolean>; runAs?: 'system' | 'user'; whenOffline: 'queue' | 'skip' }
  | { type: 'notify'; channelId: string; title: string; message: string; severity: 'info' | 'warning' | 'critical' }
  | { type: 'create_alert'; severity: (typeof ALERT_SEVERITIES)[number]; title: string; message: string };
export type FlowFormOnFailure = { mode: 'stop' } | { mode: 'continue' } | { mode: 'notify'; channelIds: string[] };
export interface FlowFormValues {
  name: string; description?: string;
  trigger: FlowFormTrigger; target: FlowFormTarget;
  actions: FlowFormAction[]; onFailure: FlowFormOnFailure;
}

// emit.ts (the converter's shapes, verbatim)
export type FleetChainSet = 'succeeded' | 'dispatched';
export interface ActiveSet { stepId: string; kind: 'resolve' | 'fleet' }
export function emitRunScriptStep(i: number, kind: 'run_script' | 'command', input: Record<string, unknown>): FlowDocumentV1['steps'][number];
export function emitDeviceItems(i: number, active: ActiveSet | null, selectorInput: Record<string, unknown>, chainSet: FleetChainSet):
  { steps: FlowDocumentV1['steps']; items: string; active: ActiveSet };
export function emitCreateAlertStep(i: number, items: string, alert: { severity: string; title: string; message: string }): FlowDocumentV1['steps'][number];
export function emitFailureNoticeSteps(i: number, fleetStepId: string, flowName: string, channelIds: string[]): FlowDocumentV1['steps'];

// compile.ts / decode.ts / recognize.ts / jsonSchema.ts
export function compileFlowForm(values: FlowFormValues): FlowDocumentV1;
export function decodeFlowForm(doc: FlowDocumentV1): FlowFormValues | null;
export function normalizeFlowDocument(doc: unknown): FlowDocumentV1 | null; // flowDocumentV1Schema.safeParse; null when invalid
export type FlowFormRecognition =
  | { formShaped: true; values: FlowFormValues }
  | { formShaped: false; reason: 'invalid_document' | 'not_decodable' | 'differs_after_recompile' };
export function recognizeFlowForm(doc: unknown): FlowFormRecognition;
export function flowDocumentJsonSchema(): Record<string, unknown>; // z.toJSONSchema(flowDocumentV1Schema, { io: 'input' })

// equality.ts (exported from form/index.ts; the recognizer and the W01e editor both use it)
export function structurallyEqual(a: unknown, b: unknown): boolean; // plain objects key-order-insensitive, arrays ordered, primitives ===
export function sameFlowDocument(a: unknown, b: unknown): boolean;  // normalizeFlowDocument on both sides, then structurallyEqual; false if either is invalid
```

`form/index.ts` re-exports every name above, including `structurallyEqual` and `sameFlowDocument`. Callers compare documents with `sameFlowDocument`, which normalizes both sides first (schema defaults filled), so a stored document missing a defaulted field still equals its normalized twin.

**Pinned shapes.** These are the converter's own shapes (W06 plan "Conversion map"). A3 proves them through the golden file.
- The step defaults are `approval: 'default'`, `onFailure: 'continue'`, `timeoutSec: 300`. A script step uses `timeoutSec: 3600`. A `targets` resolve step uses `onFailure: 'stop'`.
- Step ids are `targets`, `a<i>_run_script`, `a<i>_command`, `a<i>_devices`, `a<i>_alert`, `a<i>_failed`, `a<i>_failnotice_<n>` and `a<i>_notify`. The converter also emits `a<i>_notify`, but with a `forEach` over the active devices (one notice per device, `convertAutomation.ts`); the form's `a<i>_notify` has no `forEach`. The recognizer tells them apart by that `forEach`, never by the id.
- The chain set is `succeeded` under stop or notify and `dispatched` under continue.
- The failure block is:
  - `a<i>_failed`: `resolve_targets` with `fromStep {stepId, set: 'failed'}` and `when: length(steps.<fleet>.output.failedDeviceIds) > 0`.
  - One `a<i>_failnotice_<n>` per channel: `notify` under `forEach { items: steps.a<i>_failed.output.devices, as: 'item', maxItems: 500, concurrency: 1 }`, with title `<name> action failed`, message `Automation <name> action <i+1> failed on {{item.hostname}}: {{item.failureReason}}`, severity `warning`, and the same `when`.
- The alert is `create_alert` under the same `forEach` over the active devices, with input `{ deviceId: '{{item.id}}', severity, title, message }`.

**Form-only rules in `compileFlowForm`.** These are decisions; the tests below pin them.
- `inputs: []`. `limits` and `notices` are absent. `description` is omitted when empty or whitespace.
- The selector is `{ deviceIds: ['{{trigger.device.id}}'] }` for `trigger_device`, else `{ target }`.
- A `notify` action is **one step, no `forEach`**: `a<i>_notify` with `{ channelId, title, message, severity }`.
  - When a script step precedes it, the compiled message is the user's text, a blank line, and `Devices: {{steps.<lastScriptStepId>.output.succeededCount}} succeeded, {{steps.<lastScriptStepId>.output.failedCount}} failed.`
  - `decodeFlowForm` strips exactly that suffix.
- A notify-only form emits no `targets` step.
- When no step carries a selector (a notify-only form), `decodeFlowForm` sets `target` from the trigger: `{ kind: 'trigger_device' }` for an event trigger, else `{ kind: 'target', target: { type: 'all' } }`. That matches what the form holds for each trigger (an event trigger always targets the triggering device), so both the document and the values round-trip.
- Webhook `orgResolver` is carried as given. Whether it is required or refused for the owner is the API validator's call (`webhook_org_resolver_required` / `_not_allowed`).
- `runAs` is `system` or `user` only (the built-in refuses `elevated`).

**Steps:**
- [ ] **Step 1: Failing tests** (`packages/shared/src/flows/form/*.test.ts`):
  - `compileFlowForm` (`compile.test.ts`):
    - `scheduled script on a group compiles to one run_script_on_targets step with timeoutSec 3600`;
    - `event trigger binds the triggering device`;
    - `notify after a script is one message with the counts suffix`;
    - `notify first emits no targets step`;
    - `alert after a script under continue chains on dispatched`;
    - `onFailure notify emits a failed step and one notice per channel`;
    - `compiled documents pass flowDocumentV1Schema and checkFlowStructure`;
    - `compile is deterministic` (same values, same JSON).
  - `recognize.test.ts`:
    - `every form-built document is recognized and round-trips its values` (table over the compile cases, including an event trigger with a notify-only action list and a schedule with a notify-only action list);
    - `custom timeoutSec is not form-shaped`;
    - `limits or notices are not form-shaped`;
    - `a when expression the form did not emit is not form-shaped`;
    - `converted per-device notice is not form-shaped`;
    - `legacy conditions arrays are not form-shaped`;
    - `an ai, http_request, wait or set step is not form-shaped`;
    - `an invalid document is invalid_document`;
    - `key order does not matter`.
  - `jsonSchema.test.ts`: `the JSON schema requires version, name, trigger and steps`.
  - `equality.test.ts`: `structurallyEqual ignores key order and respects array order`; `sameFlowDocument treats a missing defaulted step field as equal to its default`; `sameFlowDocument is false for an invalid document`.
  - `emit.test.ts`: one test per emitter pinning the exact object (the values above).
- [ ] **Step 2:** `cd packages/shared && npx vitest run src/flows/form`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** The recognizer runs `normalizeFlowDocument` on the input, then `decodeFlowForm`, then `compileFlowForm`, then `normalizeFlowDocument` on the result, then `structurallyEqual` from `equality.ts` (plain objects key-order-insensitive, arrays ordered, primitives `===`). Export `structurallyEqual` and `sameFlowDocument` from `form/index.ts`; W01e's editor uses `sameFlowDocument`. **Do not import `@breeze/shared/canonicalize`** (it pulls in `node:crypto`; the root barrel is bundled into the web).
- [ ] **Step 4:** rerun. Expected: PASS. Shared typecheck `exit=0`.
- [ ] **Step 5: Commit** `feat(shared): flow form compile, decode and whole-document recognizer (#<sub-issue>)`, **and push the branch** (W01e copies these files).

#### Task A3: The converter emits through the shared emitters

**Files:** Modify `apps/api/src/services/flows/conversion/convertAutomation.ts`.

**Interfaces:** Consumes the `emit.ts` exports. `convertAutomation`'s signature and `ConversionResult` are unchanged. Converter-only behaviour stays in the API:
- per-device `send_notification` notices;
- generated command scripts;
- `alertText` placeholder mapping;
- findings and fidelity.

- [ ] **Step 1:** replace the inline `step()` uses for script, devices, alert and failure-notice emission with the shared emitters.
- [ ] **Step 2:** run `npx vitest run src/services/flows/conversion/convertAutomation.golden.test.ts src/services/flows/conversion/convertAutomation.test.ts src/services/flows/conversion/convertAutomation.validates.test.ts src/services/flows/conversion/census.test.ts src/services/flows/conversion/shadowEvaluate.test.ts`. Expected: PASS with **no golden update**.
  - Any golden diff is a bug in A2 or A3, never a fixture refresh.
  - Why bytes matter: existing shadows are not reset by a code change, because `resetShadowIfChanged` (`conversion/ledger.ts`) compares the *stored* draft's digest with the ledger's. But new conversions and previews would emit shapes outside what `automationFlowParity.integration.test.ts` proved, and the form recognizer relies on those shapes.
- [ ] **Step 3: Commit** `refactor(flows): converter emits script, alert and failure-notice steps through the shared emitters (#<sub-issue>)`.

#### Task A4: Fleet outputs carry succeeded and failed counts

**Files:**
- Modify `packages/shared/src/flows/builtins.ts`: add `succeededCount: number; failedCount: number` to `FlowFleetStepOutput`, with a doc comment.
- Modify `apps/api/src/services/flows/builtins/runScriptOnTargets.ts`, `services/flows/fleetStep.ts` (`emptyOutput`) and `services/flows/builtins/resolveTargets.ts`, with their tests.

- [ ] **Step 1: Failing tests:**
  - `run_script_on_targets output carries succeeded and failed counts` (3 of 5 failed gives 2 and 3);
  - `an empty fleet output reports zero counts`;
  - `resolve_targets reports every resolved device as succeeded`.
- [ ] **Step 2:** run the three test files. Expected: FAIL.
- [ ] **Step 3:** set `succeededCount = succeededDeviceIds.length` and `failedCount = failedDeviceIds.length` in each builder. Update the existing exact-equality pins on the whole output in `runScriptOnTargets.test.ts` (the `toEqual` on the completed outcome) and `resolveTargets.test.ts` (the `toEqual` on the resolved set); both files are A4's.
- [ ] **Step 4:** rerun, plus `src/services/flows/conversion` and the golden test. Expected: PASS. Converter documents do not embed outputs, so the golden is unchanged.
- [ ] **Step 5: Commit.**

#### Task A5: Compiled form documents pass the real validator

**Files:** Create `apps/api/src/services/flows/form/flowFormCompile.validates.test.ts`. Mock ownership the way `convertAutomation.validates.test.ts` does.

- [ ] **Step 1:** `it('a compiled form document validates for the owner — <case>')` over the A2 compile cases, plus a partner-wide webhook case with an `orgResolver` and a partner-wide `filter` target. Assert no error-severity issue.
- [ ] **Step 2:** run it. It goes red only if A2 emits something the validator refuses. Fix A2, never the test.
- [ ] **Step 3: Commit.**

#### Task A6: Contracts and PR

- [ ] Run the A commands above (they include `src/browserSafeBarrel.test.ts`, which proves nothing reachable from the root barrel imports a Node builtin), plus `cd apps/api && npx vitest run src/__tests__/parkedFanout.contract.test.ts`. Discovery there is conditional: a file is listed only if it reads `devices` or carries a quick-support or hidden-org exclusion. No A file does, so it must stay green unchanged.
- [ ] Open PR `feat(flows): shared flow-form core; converter emits through it (#<sub-issue>)`. The body states the golden-file evidence (no diff) and Decisions P2 and P4. Run one review round with Opus on A2 and A3. Post the summary comment.

---

### W01b — Draft REST routes, delete, validate, `jobCounts`

#### Task B1: Request schemas, `POST /flows` and `PUT /flows/:id`

**Files:**
- Create `packages/shared/src/validators/flowDrafts.ts` and `flowDrafts.test.ts`.
- Modify `packages/shared/src/validators/index.ts`.
- Modify `apps/api/src/routes/flows.ts`.
- Create `apps/api/src/routes/flows.drafts.test.ts`.

**Interfaces:**

```ts
export const flowDraftCreateRequestSchema   // { document: Record<string, unknown>; ownerScope?: 'organization'|'partner'; orgId?: uuid; slug?: string }, strict
export const flowDraftUpdateRequestSchema   // { document; expectedVersion: int ≥ 1 }, strict, expectedVersion REQUIRED
export const flowDraftDeleteRequestSchema   // { expectedVersion: int ≥ 1 }, strict
export const flowDraftValidateRequestSchema // { document; ownerScope?; orgId?; flowId?: uuid }, strict
```

Routes. The draft gate is `requirePermission('automations', 'write')` **without** `requireMfa()`, deliberately not the file's `requireAutomationWrite` alias. Write it inline in each route call (`flowsRoutes.post('/', requirePermission('automations', 'write'), zValidator(…), …)`), never through a `const` array alias, so `aiGuardrails.routeBinding.contract.test.ts` can see it (Decision P20). Register the routes before every `/:id` route. Widen the file's `Status` type (`403 | 404 | 409 | 422 | 429` today) to include `400` and `201` where the new handlers need them.
- `POST /` calls `saveDraftFlow(auth, body)` and returns `201 { flow, validation }`.
- `PUT /:id` calls `saveDraftFlow(auth, { ...body, flowId })` and returns `200 { flow, validation }`.
- Failure mapping, one table (a `DRAFT_STATUS` record like `ENABLE_STATUS`):
  - `saved: false` with `validation` and no `error` gives `422 { error: 'invalid', validation }`.
  - `flow_not_found` gives 404.
  - `flow_not_draft` and `version_conflict` give 409.
  - `slug_unavailable` and `slug_conflict` give 409. `invalid_slug` gives 422.
  - `PARTNER_WIDE_WRITE_DENIED_MESSAGE` gives `403 { error: 'partner_wide_forbidden' }`.
  - Any other owner-resolution message from `resolveFlowOwnerForCaller` (`services/flows/owner.ts`) gives `400 { error: 'owner_invalid', message }`, except an access-denied message, which gives `403 { error: 'owner_invalid', message }`. The access-denied messages are `'Cannot access another organization'` and `'Access denied to this organization'` (`services/aiToolWriteOrg.ts` `resolveWritableToolOrgId`) and `'Partner-wide flows require a partner-scoped caller'` (`owner.ts`). Every other message (`'orgId cannot be combined with ownerScope "partner"'`, `'Organization context required'`, `'orgId is required for this operation'`, the ambiguous-org message, `'Organization not found'`) is 400. Pin each message with a test; match on a shared constant where one exists rather than retyping the string.

- [ ] **Step 0:** the baseline check.
- [ ] **Step 1: Failing tests** (`flows.drafts.test.ts`; the `flows.test.ts` mocking pattern):
  - `POST /flows saves a draft and is 201`;
  - `an invalid document is 422 invalid with the validation`;
  - `a selected-access partner user creating a partner-wide flow is 403 partner_wide_forbidden`;
  - `PUT with a stale expectedVersion is 409 version_conflict`;
  - `PUT on an enabled flow is 409 flow_not_draft`;
  - `org token PUT on a partner-wide flow is 404`;
  - `PUT without expectedVersion is 400`;
  - `an MFA-unsatisfied session can save a draft` (token without an MFA claim, `ENABLE_2FA` on);
  - `FLOWS_ENABLED=false makes every draft route 404`;
  - `automations.read alone cannot save`.
  - Schema tests in `flowDrafts.test.ts`.
- [ ] **Step 2:** run them. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** rerun plus `src/routes/flows.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.**

#### Task B2: `POST /flows/validate`

**Files:**
- Create `apps/api/src/services/flows/draftValidation.ts` and `draftValidation.test.ts`.
- Modify `routes/flows.ts`.

**Interfaces:** `validateFlowDraft(auth: AuthContext, req: { document: unknown; ownerScope?: 'organization'|'partner'; orgId?: string; flowId?: string }): Promise<{ ok: true; validation: FlowValidationResult } | { ok: false; error: 'flow_not_found' | 'owner_invalid'; message?: string; accessDenied?: boolean }>`.
- With `flowId`: read the row in the caller's context. **Validate with a `flowId` applies the same reach rule as update**: when the row is partner-wide (`org_id` NULL) and the caller's scope is neither `partner` nor `system`, answer `flow_not_found`, before any owner lookup or catalog read (the rule `updateDraft` applies in `services/flows/service.ts`). Then take the owner from `ownerForFlowRow` and apply `shadowPlaceholderAllowance` + `allowGeneratedScriptPlaceholders` exactly as `updateDraft` does. `ownerScope` and `orgId` in the body are ignored when `flowId` is present.
- Without it: `resolveFlowOwnerForCaller(…, 'read')`.
- Writes nothing. Route gate: the router's `automations.read`.

**Route response** (the same envelope as create and update):
- Success: `200 { validation }`, whether or not the document is valid (`validation.valid` says which). A validate call is never a 422.
- `flow_not_found`: `404 { error: 'flow_not_found' }`.
- An owner-resolution message: `400 { error: 'owner_invalid', message }`, or `403 { error: 'owner_invalid', message }` for an access-denied message (the same message table as B1).

- [ ] **Step 1: Failing tests:**
  - `validate with flowId answers what save would for a shadow draft` (a placeholder script id passes for a shadow conversion's flow and fails for an ordinary draft);
  - `validate writes nothing` (no insert or update called);
  - `an event trigger on a non-durable installation returns the event_dispatch_not_durable warning with pointer /trigger/event`;
  - `an unknown flowId is 404`;
  - `validate with a flowId applies the same reach rule as update` (an org token with a partner-wide flow's id is 404 and no catalog read happens);
  - `validate answers 200 { validation } for an invalid document`;
  - `an access-denied owner message is 403 owner_invalid and any other is 400`.
- [ ] **Steps 2–4:** implement, run, PASS. **Step 5:** commit.

#### Task B3: `DELETE /flows/:id`

**Files:**
- Create `apps/api/src/services/flows/deleteDraft.ts` and `deleteDraft.test.ts`.
- Create `apps/api/src/__tests__/integration/flowDraftRoutes.integration.test.ts` (the shared glob `src/__tests__/integration/**/*.test.ts` in `vitest.integration.config.ts` includes it).
- Modify `routes/flows.ts`.
- Modify `services/flows/versions.ts`, only to add `export` to the existing `partnerWideReach` function.

**Interfaces:** `deleteDraftFlow(auth: AuthContext, flowId: string, expectedVersion: number): Promise<{ ok: true } | { ok: false; error: 'flow_not_found' | 'partner_wide_forbidden' | 'version_conflict' | 'flow_has_history'; conversionId?: string; automationId?: string }>`. `conversionId` and `automationId` (the Job the conversion came from) are both set whenever a conversion of any state exists for the flow; the web links `/jobs#convert-<automationId>`.

Order, all in the caller's transaction:
1. `SELECT … FOR UPDATE` on the row. Under RLS this matches only a row the caller may update; none is `flow_not_found`.
2. `partnerWideReach`. An org token on a partner-wide row is `flow_not_found`.
3. Call `canManagePartnerWidePolicies(auth)` by name in this file, or `partner-wide-write-coverage.test.ts` fails: the file deletes from a partner-axis table.
4. `expectedVersion` must equal `definition_version`.
5. Status `draft`, `enabled_publication_seq` NULL, zero `flow_versions` rows and zero `flow_automation_conversions` rows of any state for the flow. Anything else is `flow_has_history`, with `conversionId` and `automationId` when a conversion exists.
6. Delete, then audit `flow.draft.delete`: same shape as `auditDraftSave`, never the definition.

Route: `DELETE /:id` with `requirePermission('automations', 'delete'), requireMfa()` written inline and the `flowDraftDeleteRequestSchema` body. Success is 204 with no body. Map `flow_not_found` 404, `partner_wide_forbidden` 403, `version_conflict` 409 and `flow_has_history` 409; the 409 body for `flow_has_history` is `{ error: 'flow_has_history', conversionId?, automationId? }`.

- [ ] **Step 1: Failing tests:**
  - Unit:
    - `delete of a never-published draft is 204 and audited`;
    - `a draft with a publication is 409 flow_has_history`;
    - `a shadow conversion's draft is 409 flow_has_history with conversionId and automationId`;
    - `a disabled flow is 409 flow_has_history`;
    - `stale expectedVersion is 409`;
    - `automations.write without automations.delete is 403`;
    - `an MFA-unsatisfied session is 403 MFA_REQUIRED`;
    - `org token DELETE on a partner-wide flow is 404`.
  - Integration, real DB as `breeze_app` under forced RLS:
    - `org token cannot delete a partner-wide draft`;
    - `selected-access partner user cannot delete a partner-wide draft`;
    - `delete after a concurrent enable commits is flow_has_history` (two connections, enable first);
    - `deleting a draft cascades nothing else`.
- [ ] **Step 2:** run the unit file and the integration file locally (test stack). Expected: FAIL.
- [ ] **Steps 3–4:** implement, run, PASS. Tear down the test stack. **Step 5:** commit.

#### Task B4: `draft_flow` warns on an unversioned update; `mcp-coverage`

**Files:** Modify `apps/api/src/services/aiToolsFlows.ts`, `services/aiToolsFlows.test.ts` and `services/mcpCoverage.ts`.

- `draft_flow` behaviour is otherwise unchanged:
  - With `flowId` and no `expectedVersion`, a successful save returns `warning: { code: 'expected_version_required_soon', message: 'Pass expectedVersion on every update; updates without it will be refused in a later release.' }`.
  - Every such call is counted with a `console.warn` carrying the bounded tool name only (no ids).
- `mcpCoverage.ts`, `flows.ts` entry: the tool list gains `draft_flow` and `validate_flow`. Its comment says that delete, enable and disable are UI-only. `FROZEN_GAPS` does not change.
- Do not change `draft_flow`'s description or `searchHint`. The tool index is built from `searchHint` and actions (`services/aiToolIndex.ts`), so no index bytes move.

- [ ] **Step 1: Failing tests:**
  - `draft_flow update without expectedVersion warns`;
  - `draft_flow create carries no warning`;
  - `draft_flow update with expectedVersion carries no warning`;
  - `mcp-coverage.test.ts` passes with the new tool list.
- [ ] **Steps 2–4:** implement, run, PASS. **Step 5:** commit.

#### Task B5: `jobCounts.notMoved` on `GET /automations`

**Files:** Modify `apps/api/src/routes/automations.ts` (the `GET /` handler only) and `routes/automations.test.ts`.

- Add `jobCounts: { notMoved }` beside `pagination` (Decision P6).
- On the unrestricted path: one extra `count(*)` with the list's `whereCondition`, plus the class-S predicate and `converted_to_flow_id IS NULL`.
- On the site-restricted path: count during the existing scan with the same predicate.
- The early return for a partner caller with no accessible org and no partner-wide condition (`{ data: [], pagination }`) also carries `jobCounts: { notMoved: 0 }`.
- The class-S predicate is the one `classify.ts` uses: `managed_by_monitor_id` NULL, `managed_by_agent_id` NULL, and the trigger's `filter` object has no `_policyWorkflow` key (`isPolicyWorkflowTrigger`), expressed in SQL on the `trigger` jsonb.

- [ ] **Step 1: Failing tests:**
  - `GET /automations reports jobCounts.notMoved for standalone unswitched rows only` (monitor, agent, policy-workflow and switched rows are excluded);
  - `a site-limited caller's notMoved counts only rows within their sites`;
  - `a partner caller with no reachable org gets jobCounts.notMoved 0`.
- [ ] **Steps 2–4:** implement, run, PASS. **Step 5:** commit.

#### Task B6: Contracts and PR

- [ ] Add binding rows to `services/aiGuardrails.routeBinding.contract.test.ts` (Decision P8): `draft_flow` ↔ `flows.ts` `post /` and `put /:id`; `validate_flow` ↔ `flows.ts` `post /validate`.
  - The binder adds the router-level `requirePermission('automations', 'read')` of `flows.ts` to each route's set, so `POST /` and `PUT /:id` require `automations:read` and `automations:write`. Add `draft_flow: [{ resource: 'automations', action: 'read' }]` to `TOOL_EXTRA_PERMISSIONS` in `services/aiGuardrails.ts`, with a comment naming this binding (Decision P20). Write the rows first and watch the `draft_flow` rows fail on `automations:read`, then add the entry. Never weaken the expectation and never change the route.
  - `validate_flow` needs no change: its route requires only the router-level `automations:read`, which the tool already requires.
  - Add a test in `services/aiGuardrails.test.ts`: `draft_flow requires automations read and write`.
- [ ] Add a pin in `flows.drafts.test.ts`: `draft_flow is not in MFA_GATED_TOOL_ACTIONS and POST/PUT /flows carry no requireMfa`.
- [ ] Run in `apps/api`, each `> 0` tests:
  - `src/__tests__/partner-wide-write-coverage.test.ts`
  - `src/__tests__/routerAuthGate.contract.test.ts`
  - `src/__tests__/writeRoutePermissionGate.contract.test.ts`
  - `src/__tests__/mcp-coverage.test.ts`
  - `src/__tests__/parkedFanout.contract.test.ts` (B's new services files read no devices, so they are not discovered)
  - `src/__tests__/site-ceiling-write-coverage.test.ts`
  - `src/services/aiToolMfaGate.routeParity.contract.test.ts`
  - `src/services/aiGuardrails.routeBinding.contract.test.ts`
  - `src/services/aiGuardrails.test.ts`
  - `src/services/aiToolPermissionsCatalogParity.contract.test.ts` (every pair in `TOOL_EXTRA_PERMISSIONS` must be in the permission catalog)
  - `src/services/aiTools.userOwnedRelease.contract.test.ts` (keyed by `file:line`; it has no `aiToolsFlows.ts` entry today, but it scans every `aiTools*.ts` module, so run it after the edit and re-key, never delete, if a key moves)
  - `src/services/aiTools.descriptionBudget.contract.test.ts`
  - `src/services/aiToolIndex.test.ts`
- [ ] Run `pnpm --filter=@breeze/api test:site-scope-coverage`. This is its own CI step. The scanner matches `:deviceId` routes only, so it stays green.
- [ ] Integration: `flowDraftRoutes`, `flowsPartnerRls`, `flowToolsRls`, plus `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. Tear down afterwards.
- [ ] Both typechecks.
- [ ] Open PR `feat(flows): REST draft create, update, delete and validate (#<sub-issue>)`. The body lists P6, P7, P8 and P20 (with the seeded-role check result) and the status table. One Opus review round, then the summary comment.

---

### W01c — Enable dialog: `fleetMaxTargets` and the webhook rule

#### Task C1: Extract the `maxTargets` field

**Files:**
- Create `apps/web/src/components/flows/FleetMaxTargetsField.tsx` and `.test.tsx`.
- Modify `components/automations/conversion/SwitchDialog.tsx`.

**Interfaces:**
- `parseFleetMaxTargets(raw: string | undefined): number | null` (moved from `SwitchDialog`'s `parseMaxTargets`).
- `FleetMaxTargetsField({ stepId, value, onChange, partnerWide, testIdPrefix, perOrgTestId }: { stepId: string; value: string; onChange: (v: string) => void; partnerWide: boolean; testIdPrefix: string; perOrgTestId: string })`.
- It renders the number input, the invalid message, and the live-membership, frozen-device and per-org copy.
- Test ids: the input is `${testIdPrefix}-${stepId}`, the invalid message `${testIdPrefix}-invalid-${stepId}`, and the per-org copy `perOrgTestId` as given. `SwitchDialog` passes `testIdPrefix: 'conversion-switch-maxtargets'` and `perOrgTestId: 'conversion-switch-perorg'`, which reproduces its current ids exactly (`conversion-switch-maxtargets-<id>`, `conversion-switch-maxtargets-invalid-<id>`, `conversion-switch-perorg`). `FlowEnableDialog` passes `testIdPrefix: 'flow-enable-maxtargets'` and `perOrgTestId: 'flow-enable-perorg-<stepId>'`, so the E8a page object types into `flow-enable-maxtargets-<stepId>`.
- It **reuses the existing keys** `flows:conversion.switch.{maxTargets,maxTargetsInvalid,liveMembership,frozenDevices,perOrgMultiplies}`. No new locale key.

- [ ] **Step 1: Failing tests:**
  - `FleetMaxTargetsField marks 0 and 501 invalid and accepts 1 and 500`;
  - `per-org copy shows only for partner-wide`.
  - `SwitchDialog.test.tsx` keeps passing unchanged with its `conversion-switch-maxtargets-<id>` and `conversion-switch-perorg` test ids, now produced through `testIdPrefix` and `perOrgTestId`.
- [ ] **Steps 2–4:** implement, run, PASS. **Step 5:** commit.

#### Task C2: `FlowEnableDialog` collects `fleetMaxTargets`; webhook flows offer no pre-approval

**Files:** Modify `apps/web/src/components/flows/FlowEnableDialog.tsx` and `.test.tsx`.

- For a ticked, eligible step whose `validation.steps[].tool` is `run_script_on_targets`, render `FleetMaxTargetsField` (`testIdPrefix: 'flow-enable-maxtargets'`, `perOrgTestId: 'flow-enable-perorg-<stepId>'`, `partnerWide: flow.ownerScope === 'partner'`).
- Confirm is disabled until every ticked fleet step has a valid value.
- Submit sends `fleetMaxTargets: { [stepId]: n }` for ticked fleet steps only, beside `preApprovedStepIds`.
- When `flow.definition.trigger.type === 'webhook'`:
  - render no pre-approval checkbox;
  - show `flows:conversion.switch.webhookApprovalEachRun` (existing key) under `data-testid="flow-enable-webhook-no-preapproval"`;
  - send `preApprovedStepIds: []`.

- [ ] **Step 1: Failing tests:**
  - `pre-approving a fleet step requires maxTargets 1–500`;
  - `enable sends fleetMaxTargets for ticked fleet steps only`;
  - `a non-fleet tier-3 step needs no maxTargets`;
  - `a webhook flow offers no pre-approval`.
- [ ] **Steps 2–4:** implement, run, PASS, then astro check and lint.
- [ ] **Step 5: Commit.** Open PR `feat(flows): pre-approve hand-built script steps from the enable dialog (#<sub-issue>)`. One Opus review round.

---

### W01d — One "Automations" nav entry and the path tab strip

#### Task D1: One sidebar entry

**Files:**
- Modify `apps/web/src/components/layout/Sidebar.tsx`, `Sidebar.flows.test.tsx` and `Sidebar.nav.test.tsx` (its `exposes Jobs at top level right after Scripts` test pins the entry this task replaces; rewrite it to pin the Automations entry in the same position), plus any other `Sidebar.*.test.tsx` the change turns red.
- Modify `lib/paletteIndex.ts` and its test.

**Behaviour:**
- `topLevelNav` replaces the Jobs and Flows items with one item: `{ name: 'Automations', labelKey: 'nav.automations', icon: Workflow, requiredPermission: automations.read }`.
- Its `href` is `/flows` when `useFlowsGate().enabled`, else `/jobs`.
- It is active on `/flows`, `/flows/*`, `/jobs` and `/jobs/*` whichever href it carries. Extend the active-match rule; do not add a static `pathAliases` entry that breaks the Flows-off case.
- `paletteIndex.ts` merges the `/jobs` and `/flows` synonym lists under the item's href.
- **Preview tag:** per Q1. Plan default, pending the answer: `previewTag` is removed from the nav entry and moves to the Flows tab (D2). Under option (b), keep `previewTag: true` on this entry and the rail label.

- [ ] **Step 0:** the baseline check.
- [ ] **Step 1: Failing tests** (rewrite `Sidebar.flows.test.tsx`):
  - `one Automations entry links /flows when Flows is on`;
  - `it links /jobs when Flows is off`;
  - `it is active on /jobs and on /flows/runs/<id>`;
  - `no Jobs or Flows entry remains`;
  - `without automations.read there is no entry`.
  - The Preview tests are moved or rewritten per Q1.
  - In `Sidebar.nav.test.tsx`: `exposes Automations at top level right after Scripts` replaces the Jobs test.
- [ ] **Steps 2–4:** implement, run every `Sidebar.*.test.tsx` listed in the W01d commands plus `paletteIndex.test.ts`, PASS. **Step 5:** commit.

#### Task D2: The path tab strip on `/flows` and `/jobs`

**Files:**
- Create `apps/web/src/components/automations/AutomationsTabStrip.tsx` and `.test.tsx`.
- Modify `pages/flows/index.astro` and `pages/jobs/index.astro`.
- Precedent: `components/alerts/AlertsTabStrip.tsx`, rendered from an Astro page the way `pages/alerts/correlations.astro` does.

**Behaviour:**
- `AutomationsTabStrip({ currentPath })` renders `<a href>` tabs with `data-testid="automations-tab-flows"` and `"automations-tab-jobs"`, labelled `nav.flows` and `nav.jobs` (existing keys).
- The Flows tab is first, and is shown only when the gate is enabled.
- The Jobs tab label carries the count from `GET /automations?limit=1` → `jobCounts.notMoved`, when that field exists. Declare the field as a local optional type (`jobCounts?: { notMoved: number }`); do not import a shared DTO, so W01d compiles and passes before W01b merges. It is always visible in W1 (spec §3.3: hidden only after R3).
- Per the Q1 default, the Flows tab carries `nav.previewTag` (`data-testid="automations-tab-preview"`).
- `aria-label` is `nav.automationsSections` (new).
- The strip sits above the page island in both `.astro` files. It is not inside `FlowsPage.tsx` or `AutomationsPage.tsx`; W01e owns `FlowsPage.tsx`.

- [ ] **Step 1: Failing tests:**
  - `the strip marks /jobs active and keeps the Jobs page hash`;
  - `the Flows tab is hidden when Flows is off`;
  - `the Jobs tab shows the not-moved count when the API sends it and no count otherwise`.
- [ ] **Steps 2–4:** implement, run, PASS. **Step 5:** commit.

#### Task D3: `/automations` goes to `/flows` or `/jobs` (Decision P5)

**Files:**
- Create `apps/web/src/components/automations/AutomationsRedirect.tsx` and `.test.tsx`.
- Modify `pages/automations/index.astro` to render it inside `DashboardLayout`, with a `<noscript>` link to `/jobs`.
- `pages/automations/new.astro` and `[id].astro` are unchanged (they keep following `/jobs/new` and `/jobs/:id`).

- [ ] **Step 1: Failing test:** `/automations sends Flows-on users to /flows and Flows-off users to /jobs`, asserting `window.location.replace` with each and no call before the gate loads.
- [ ] **Steps 2–4:** implement, run, PASS. **Step 5:** commit.

#### Task D4: Locales, contracts, PR

- [ ] Add `nav.automations` and `nav.automationsSections` to `common.json` in all 8 locales. Translate them in every locale, so no value equals English and `translationCoverage` is not touched.
- [ ] Run in `apps/web`: `src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts src/lib/i18n/titleKeyUsage.test.ts src/locales/humanizedKeyRegression.test.ts src/locales/monitoringNoInternalWaveNames.test.ts`. Then astro check and lint.
- [ ] Open PR `feat(web): one Automations nav entry with Flows and Jobs tabs (#<sub-issue>)`. The body states the Q1 answer applied.

---

### W01e — Manual flow editor, docs, spec amendment, wave verification

#### Task E1: API client

**Files:** Modify `apps/web/src/components/flows/api.ts` and `api.test.ts`.

**Interfaces:**
- `createFlowDraft(body: { document: FlowDocumentV1 | Record<string, unknown>; ownerScope?: 'organization'|'partner'; orgId?: string }): Promise<{ flow: FlowDetailDto; validation: FlowValidationResult }>`
- `updateFlowDraft(flowId: string, body: { document; expectedVersion: number })`, same return.
- `deleteFlowDraft(flowId: string, expectedVersion: number): Promise<void>` (DELETE with a JSON body `{ expectedVersion }`; 204 on success)
- `validateFlowDraftDocument(body: { document; ownerScope?; orgId?; flowId? }): Promise<FlowValidationResult>`, which unwraps the route's `200 { validation }` body and returns `validation`. A 404 (`flow_not_found`) or a 400/403 `owner_invalid` throws an error carrying the status and body, for the caller to render inline.

Rules:
- Declare these request types in `api.ts`. Do not import W01b's `flowDrafts` schemas from `@breeze/shared`; W01e must compile before W01b merges.
- The three mutations go through `runAction`. A 422 (`invalid`), a 409 (`version_conflict`, `flow_not_draft`, `flow_has_history`) and `partner_wide_forbidden` are suppressed from the toast and rendered inline (the `ENABLE_INLINE_CODES` pattern). The `flow_has_history` body carries `conversionId` and `automationId` when a conversion exists.
- A 422 body is read defensively: `invalid` carries `validation`, but `invalid_slug` (also 422) carries none.
- `validateFlowDraftDocument` uses plain `fetchWithAuth` with a `// runaction-exempt: read-only validation, inline feedback, no state change` marker.

- [ ] **Step 0:** the baseline check. Copy W01a's `packages/shared/src/flows/form/**` and its `src/flows/index.ts` line verbatim if W01a has not merged.
- [ ] **Step 1: Failing tests:**
  - `create, update and delete go through runAction`;
  - `a 422 is not toasted and carries validation`;
  - `validate sends flowId and returns the validation` (unwrapped from `{ validation }`);
  - `a validate 404 or owner_invalid throws with the status and body`;
  - `a delete 409 flow_has_history carries automationId`;
  - `no-silent-mutations` stays green.
- [ ] **Steps 2–5:** implement, run, PASS, commit.

#### Task E2: Editor shell and state

**Files:**
- Create `components/flows/editor/FlowEditorPage.tsx`, `editorState.ts` and `useFlowValidation.ts`, with tests.
- Create `pages/flows/new.astro` (`titles.flows`) and `pages/flows/[id]/edit.astro` (`titles.flowDetail`) (Decision P11).

**Behaviour:**
- **Loading.** `FlowEditorPage({ flowId?: string })` loads the flow with `getFlow` and runs `recognizeFlowForm(flow.definition)`.
- **Tabs.** `useHashTab(['form', 'document'], 'form')`.
- **A document that is not form-shaped:**
  - the Document tab is active;
  - the Form tab shows the existing `FlowStepList` read-only;
  - a notice (`flow-editor-not-form-shaped`) says the form cannot show the whole document.
- **Save.**
  - New: `createFlowDraft`, then navigate to `/flows/<id>/edit`.
  - Existing: `updateFlowDraft` with `expectedVersion: flow.definitionVersion`; after a save, hold the returned flow's `definitionVersion` for the next save.
  - **No PUT for an unchanged document**: `sameFlowDocument(current, loadedDefinition)` from the shared form module, which normalizes both sides first (P17).
- **Save and enable** (not offered for a webhook-triggered flow, P21). Save (skipped when unchanged), then **re-fetch the flow with `getFlow`** and open `FlowEnableDialog` (from W01c) with the re-fetched `flow` and `validation`. The save response's flow carries an empty `preApprovalEligibility` (only `getFlow` computes it), and the dialog disables every step whose eligibility is missing, so opening it on the save response would make pre-approval impossible. On success:
  - when `result.webhookSecretInvalidated === true` (not expected from this path, P17), stay and show `flows:enable.webhookSecretInvalidated` with a link to `/flows/<id>#webhook`;
  - otherwise navigate to `/flows/<id>`.
- **Webhook flows** (P21): Save only. After a successful save, show `flow-editor-webhook-next`, a notice linking to `/flows/<id>#webhook` to create the secret and enable there.
- **Status.**
  - Enabled: the editor is read-only, and **Disable and edit** opens a `ConfirmDialog` that says disabling cancels queued and waiting runs and pending approvals, and stops running runs at their next checkpoint. On confirm it calls `disableFlow`, then reloads.
  - `draft`, `disabled`, `paused`: editable.
- **Shadow draft** (`flow.convertedFrom?.state === 'shadow'`): Save first shows a confirm that the comparison evidence resets.
- **Owner selector** (organization or all organizations) at create only, shown when `useAuthStore` `canManagePartnerWide` is true. It mirrors `AutomationForm`'s `showOwnerScope`.
- **409.** The user's document is kept in state and a **Reload** action is offered. Nothing is discarded silently.
- **Validation.** `useFlowValidation(document, owner, flowId)` debounces at 400 ms and calls `validateFlowDraftDocument`.

- [ ] **Step 1: Failing tests:**
  - `a form-shaped draft opens in the form`;
  - `a non-form document opens read-only with the Document tab active`;
  - `Save on a new flow creates and navigates to edit`;
  - `an enabled flow is read-only and Disable and edit confirms what is cancelled`;
  - `saving a shadow draft warns that evidence resets`;
  - `a 409 keeps the unsaved document and offers reload`;
  - `the owner selector shows only for partner-wide-capable users and only on create`;
  - `the tab follows the hash`;
  - `Save and enable with no change sends no PUT`;
  - `Save and enable re-fetches the flow before opening the enable dialog` (the dialog receives `getFlow`'s eligibility, not the save response's);
  - `a webhook flow offers Save only and links to the webhook tab after saving`;
  - `an enable result that reports a cleared webhook secret stays on the editor with the notice and a link to the webhook tab`;
  - `a successful enable navigates to the flow`.
- [ ] **Steps 2–5:** implement, run, PASS, commit.

#### Task E3: Form sections

**Files:** Create `components/flows/editor/{FlowFormView,TriggerSection,TargetSection,ActionsSection,OnFailureSection}.tsx` with tests. Modify `components/automations/AutomationForm.tsx` to export `getEventTypeOptions`. Its labels stay in the `scripts` namespace.

**Behaviour** (spec §3.1 table):
- **Trigger.** Schedule (cron plus time zone), event (type from `getEventTypeOptions`, plus a scalar equality filter), webhook (HMAC or token; for an all-organizations flow, the resolver path and system), or manual.
  - An `event_dispatch_not_durable` warning from validation shows beside the event picker (`flow-editor-event-unavailable`).
- **Target.**
  - An event trigger targets the triggering device and hides the picker. This applies to every listed event type, pending Q5 (P19).
  - Otherwise `DeviceTargetSelector`.
  - A partner-wide flow is offered `modes={['all', 'filter']}` only, because the validator refuses a literal device (`device_in_partner_flow`) and an org's group (`group_in_partner_flow`) in a partner-wide flow (`flowValidator.ts`, `flows/validateBuiltins.ts`).
- **Actions.** Ordered; add, remove, reorder.
  - Run a script: script picker, parameters, `runAs` system or user only, when offline queue or skip.
  - Send a notification: one message per run. The help text says the device counts are appended when a script runs first.
  - Raise an alert.
  - There is no "Run a command"; a line links to Scripts.
- **On failure.** Stop, continue, or notify channels. The label says "if the script can't be sent to a device", never "if the script fails".
- **Limits note** at save: at most 500 target devices; at most 20 notifications per run (the spec's "the editor states the limits at save").
- Every change runs `compileFlowForm` into the editor state.

- [ ] **Step 1: Failing tests:**
  - `an event trigger hides the target picker and binds the triggering device`;
  - `a partner-wide flow offers only all and filter targets`;
  - `runAs offers system and user only`;
  - `no command action is offered`;
  - `the on-failure label says can't be sent`;
  - `building the Job-form equivalent of a scheduled script with an on-failure notice compiles to the expected document` (asserts against `compileFlowForm` of the same values).
- [ ] **Steps 2–5:** implement, run, PASS, commit.

#### Task E4: Document tab

**Files:** Create `components/flows/editor/FlowDocumentTab.tsx` and its test. Load Monaco the way `components/scripts/ScriptForm.tsx` does (dynamic `@monaco-editor/react` import, `configureMonacoLoader`). Mock it in tests the way `ScriptForm.test.tsx` does.

**Behaviour:**
- JSON language with `flowDocumentJsonSchema()` registered for completion.
- Each validation issue's `pointer` maps to an editor marker, and the list renders in the existing `FlowIssuesPanel`.
- A JSON parse error blocks Save with an inline message.
- Saving from this tab saves the document exactly as typed (no recompile).

- [ ] **Step 1: Failing tests:**
  - `issues with pointers become markers and panel rows`;
  - `a JSON parse error blocks save`;
  - `saving from the Document tab sends the document unchanged`.
- [ ] **Steps 2–5:** implement, run, PASS, commit.

#### Task E5: Entry points on the detail and list pages

**Files:** Modify `components/flows/FlowDetailPage.tsx`, `FlowsPage.tsx` and their tests.

- **`FlowDetailPage`:**
  - **Edit** links `/flows/<id>/edit` when `canWrite` and the flow is editable.
  - **Delete draft** shows when `status === 'draft'`, `enabledPublicationSeq === null` and `convertedFrom === null`. It needs `can('automations', 'delete')`, confirms, then calls `deleteFlowDraft`. A 409 `flow_has_history` renders inline, linking `/jobs#convert-<automationId>` with the `automationId` from the 409 body when it is present (the page's own `convertedFrom` is null whenever Delete was offered, so it cannot supply the id).
  - For a partner-wide flow viewed by an organization-scoped user, Edit and Delete are hidden.
- **`FlowsPage`:**
  - A **New automation** button (`data-testid="flows-new"`, label `scripts:automationsPage.actions.new`, an existing key) links `/flows/new` when `canWrite`.
  - The empty state's `empty.how` copy is rewritten (E6) to point at that button.
  - The #12366 `flows-preview-tag` stays (Preview comes off in W3).

- [ ] **Step 1: Failing tests:**
  - `Edit shows for an editable flow and not for an enabled one`;
  - `Delete draft shows only for a never-published, never-converted draft`;
  - `an org-scoped user sees no Edit or Delete on a partner-wide flow`;
  - `flow_has_history renders inline with the conversion link built from the 409 body's automationId`;
  - `New automation links /flows/new with write access only`.
  - The existing `FlowsPage.test.tsx` empty-state assertions are updated to the new copy.
- [ ] **Steps 2–5:** implement, run, PASS, commit.

#### Task E6: `flows.json` in all 8 locales

- [ ] Add every `flowEditor.*`, `detail.edit`, `detail.delete*` key E2–E5 introduced, and the new `empty.how` text, to all 8 `flows.json` files.
  - The new `empty.how` says flows can be built with **New automation**, drafted by Breeze AI, or moved from a job.
  - Keep `empty.body` unless its last sentence contradicts the editor; it currently says "a job is simpler" for a scheduled script, which stays true until W3.
- [ ] Add a `translationCoverage.test.ts` baseline entry only for a true loanword, with its reason.
- [ ] Run the i18n batch (as in D4), then commit.

#### Task E7: Docs, docs index, spec amendment, release notes

- [ ] Use the `update-breeze-docs` skill.
  - `reference/api.mdx`: a "Flows" table with the four routes, their permissions, MFA on delete only, the status codes, and the `expectedVersion` rule.
  - `features/flows.mdx`: "Building a flow by hand" (form, Document tab, round trip, Save and enable with `maxTargets`, webhook flows saved in the editor and enabled from the flow's Webhook tab, Disable and edit, Delete draft).
  - `features/automations.mdx`: one "Automations" entry; the `/flows` and `/jobs` tabs; where `/automations` goes.
- [ ] Run `npx tsx scripts/build-docs-index.ts`, then `cd apps/docs && pnpm exec astro check` (0 errors), then `cd apps/api && npx vitest run src/services/aiToolsDocs.test.ts`.
- [ ] Amend the Flows spec. Add a dated **Amendment (Flows completion plan, 2026-11-21)** under the §3 canvas row and in §6.8: humans may author flows through a form and a document editor; a canvas stays a non-goal.
- [ ] Append the W1 block to `docs/release-notes/next-release-draft.md` under `## Features / API` (spec §3.8 Wave 1 list): the editor and the four routes; one "Automations" entry; the old URLs and where they go; the `draft_flow` warning (refused in a later release); "Preview" still on. Append only; rebase just before the PR.
- [ ] Commit.

#### Task E8: Playwright and wave verification

- [ ] **E8a.** Create `e2e-tests/pages/FlowEditorPage.ts` and `e2e-tests/tests/flows-editor.spec.ts`, using `data-testid` only:
  - build and save a scheduled script automation;
  - enable it with `maxTargets`;
  - open a non-form document read-only;
  - the path tabs;
  - the redirects that exist after W1, on one stack with Flows on: `/automations` lands on `/flows`, `/automations/new` lands on `/jobs/new`, and `/automations/<id>` lands on `/jobs/<id>` (a seeded Job's id). The Flows-off branch is pinned by the W01d component tests, not here (Decision P22).
- [ ] **Wave verification**, after W01a–W01d have merged and W01e is rebased on `main`:
  - Run the full W1 test commands for all five parts on the rebased branch.
  - Run both typechecks and the API contract batch from B6.
  - On a per-worktree stack (`worktree-stack` skill, `FLOWS_ENABLED=true`, AI keys blank), run the Playwright spec.
  - Walk spec §3.5 live check 8 locally: build, enable with pre-approval and `maxTargets`, and watch one scheduled run complete unattended.
  - Screenshots stay local. Tear the stack down and say so.
- [ ] Open PR `feat(web): manual flow editor (#<sub-issue>)`. One Opus review round, then the summary comment.

**W1 exit checklist**
- [ ] The golden converter output is unchanged; every form-built document is recognized; every non-form document opens read-only.
- [ ] The four routes answer every status in spec §3.2, including the 404 for an org token and delete's 409 on history. No MFA on drafts on either path; MFA on delete.
- [ ] The enable dialog sends `fleetMaxTargets`; webhook flows offer no pre-approval.
- [ ] One "Automations" entry; tabs at `/flows` and `/jobs`; no redirect touches either; `/automations` lands correctly with Flows on and off.
- [ ] Docs, docs index, spec amendment and release notes are in; 8 locales; contracts green.

---

## W2 — Census additions and live checks

Spec §3.5 and §8 row W2. W2 starts after W1 has merged; W02b needs W1 deployed to the hosted installations.

### Execution split and parallelism

- **W02a — Census additions** (API, one PR, **opus**: its guarantee is that no identifier leaves a production host for a public issue, P18). It owns `apps/api/src/services/flows/conversion/census.ts`, `census.test.ts` and `apps/api/scripts/automationConversionCensus.ts` (comment only). Tasks run serially (2.1 → 2.2). The Sonnet-eligible task is 2.2's CLI comment and the release-notes line.
  - Commands: `cd apps/api && npx vitest run src/services/flows/conversion/census.test.ts src/services/flows/conversion/convertAutomation.golden.test.ts src/services/featureLinkReaders.contract.test.ts src/__tests__/parkedFanout.contract.test.ts`; the API typecheck.
  - Migration slot: none.
  - W02a owns the W2 release-notes append ("census additions; nothing changes for users").
- **W02b — Census run and live checks** (operator, **no PR**). An owner gate; see "Owner gates".

### W02a tasks

- **2.1 Census counts.** `ConversionCensus` gains these fields:
  - `byClass.C: { total, enabled }` — `config_policy_automations` with `retired_at IS NULL`. Read that table only (Decision P10).
  - `notFormShapedEnabledUnswitchedS: number` — for each enabled, unswitched S row whose `convertAutomation` result has a document, `recognizeFlowForm(document).formShaped === false`. A row with no document (unconvertible) is not counted here; it is already in `byFidelity.unconvertible`.
  - `webhookScriptJobs: number` (Decision P9).

  Failing tests first:
  - `counts class C rows that are not retired`;
  - `counts enabled unswitched S rows the editor cannot open in the form`;
  - `counts webhook Jobs that run a script`;
  - `census output contains no uuid` (extend the existing rule to the new fields and to a C fixture);
  - `the census still never prints a name`.

  Then implement and commit.
- **2.2 PR.** Update the CLI header comment to list the new fields. Append the release notes. Open the PR.

### W02b — the operator run and the eight live checks (owner gate)

- Runs only on the owner's separate go-ahead, after a release that includes W02a is deployed to both hosted installations.
  - The CLI's own invocation is in its header: `cd apps/api && DATABASE_URL=... npx tsx scripts/automationConversionCensus.ts`.
  - How to run it against a hosted installation (which container or host, which credentials) is the operator's call under `docs/agents/merge-and-deploy.md`. This plan has **not checked** that procedure.
- **Only the printed JSON aggregates leave the host.** Post them in a comment on the feature issue, one per installation, labelled only "hosted installation 1" and "hosted installation 2" (which is which stays in the operator's private notes, never on the issue). Never post them to the repo.
- Record each of the spec §3.5 live checks 1–8 as pass or fail in a feature-issue comment. Screenshots stay local. A failed check opens a bug issue before W3 is dispatched.
- **Decision inputs written in that comment, for the owner:**
  - OD5: `webhookScriptJobs`, `approval_each_run`.
  - OD6: `deploy_software_unmapped`.
  - OD8 conditional items:
    - event filters: `event_filter_string_coercion`, `event_filter_null`, `event_filter_not_strict`;
    - fleet cap: `targets_over_cap`, `notify_per_run_cap`, `failure_notice_cap`.
  - The Document-tab load: `notFormShapedEnabledUnswitchedS`.
  - Note that `byFinding` counts every S row, not only enabled unswitched ones.

---

## W3 — The create refusal returns

Spec §3.4, §3.3 (URLs) and §8 row W3. **Gates:** at least one release after W1; the W02b checks pass; OD5 and OD6 decided from the census. **Before writing any W3 task:** confirm #12366 is on `origin/main`. Also confirm `POST /automations` in `routes/automations.ts` has no create refusal, so the 410 is being brought back, not added beside an existing one.

**Carried forward from the W06 plan's Decision 8 amendment:** W3 brings back `POST /automations` → 410, now per trigger.

### Execution split and parallelism

- **W03a — Per-trigger create refusal and API pieces** (API, **opus**, about 5 tasks, one PR).
  - Owns:
    - a new `apps/api/src/services/flows/conversion/createRefusal.ts` (+ test);
    - `routes/automations.ts` (the `POST /` chain only);
    - `services/aiToolsFleet.ts` (the `manage_automations` description and `action` param description only);
    - `services/aiToolsFlows.ts` (the `draft_flow` refusal);
    - `services/flows/service.ts` or a new `services/flows/awaitingEnable.ts` (the list filter);
    - `routes/flows.ts` (the list query param);
    - `routes/config.ts` and its test (only if Q4 is answered (a));
    - `packages/shared` (any DTO).
  - **PARALLEL GROUP 3a-1:** the refusal (3.1); the `draft_flow` refusal (3.3). **SERIAL:** 3.2, 3.4, then 3.5.
  - Sonnet-eligible: 3.2's description text. Opus: the rest.
- **W03b — Web, Preview removal, docs, wave verification** (web and docs, **sonnet**, about 4 tasks, one PR, merges after W03a).
  - Owns:
    - `components/automations/{AutomationsPage,AutomationEditPage}.tsx`, `pages/jobs/new.astro`;
    - the `/jobs/new` island if Q4 needs one;
    - `components/flows/FlowsPage.tsx` (filter, Preview removal);
    - `components/layout/Sidebar.tsx` and `components/automations/AutomationsTabStrip.tsx` (Preview removal);
    - `components/automations/conversion/{JobsMigrationBanner,conversionApi}.ts(x)`;
    - locales in all 8 files;
    - `apps/docs/**`, `docsIndex.json`, the release-notes append.
  - **PARALLEL GROUP 3b-1:** 3.6, 3.7, then 3.8, docs.
  - Owns whole-wave verification (3.9).
- **W03a commands:**
  - `cd apps/api && npx vitest run src/services/flows/conversion/createRefusal.test.ts src/routes/automations.test.ts src/routes/automations.managedByMonitor.test.ts src/services/aiToolsFlows.test.ts src/services/aiToolsFleet.test.ts src/services/aiToolsFleet.userOwnedRelease.contract.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiToolIndex.test.ts src/services/aiToolIndex.w15-budget.test.ts src/services/aiToolIndex.w16-budget.test.ts src/services/aiToolIndex.w16b-budget.test.ts src/services/aiToolIndex.w18-budget.test.ts src/services/aiGuardrails.routeBinding.contract.test.ts src/services/aiToolMfaGate.routeParity.contract.test.ts src/routes/flows.test.ts src/routes/config.test.ts`;
  - the new `awaitingEnable` test file;
  - the B6 contract batch;
  - the API typecheck.
- **W03b commands:**
  - `cd apps/web && npx vitest run src/components/automations/AutomationsPage.conversion.test.tsx src/components/automations/AutomationEditPage.test.tsx src/components/flows/FlowsPage.test.tsx src/components/layout/Sidebar.flows.test.tsx src/components/automations/AutomationsTabStrip.test.tsx`;
  - the i18n batch (D4);
  - astro check; lint;
  - `npx tsx scripts/build-docs-index.ts && cd apps/api && npx vitest run src/services/aiToolsDocs.test.ts`.
- Migration slot: none.

### W03a tasks

- **3.1 The refusal.** `createRefusalFor(triggerType: string | undefined): boolean`:
  - true when `flowsEnabled()` and the type is `schedule`, `manual` or `webhook`;
  - true when the type is `event` and `isFlowEventDeliveryDurable()`;
  - true when the type is missing or unknown;
  - false only for `event` on a non-durable installation, and whenever Flows are off.

  A middleware before `zValidator` on `POST /automations` reads only `trigger.type ?? triggerType` from the raw body and answers `410 { error: 'automations_moved_to_flows', flowsUrl: '/flows/new' }`. Managed writers (triage seeding, monitor compile) never come through this route.

  Failing tests:
  - `POST /automations is 410 with flowsUrl /flows/new for schedule, manual and webhook when Flows are on`;
  - `an event Job is 410 when event delivery is durable`;
  - `an event Job is still created when event delivery is not durable`;
  - `POST /automations still creates when FLOWS_ENABLED=false`;
  - `the refusal answers before body validation`;
  - `managed triage seeding still inserts` and `monitor compile still upserts` (these pass already).
- **3.2 `manage_automations` points to flows.** Its description and its `action` parameter description stop pointing at `manage_policy_feature_link` and say new automations are drafted as flows (`draft_flow`) where Flows are on.
  - Keep `searchHint` unchanged, so the tool index does not move (it is built from `searchHint` and actions).
  - Limits: description ≤ 300 characters, parameter descriptions ≤ 160 (`aiTools.descriptionBudget.contract.test.ts`).
  - Also run `aiToolIndex.test.ts` (B3 worst turn `INDEX_BUDGET_BYTES = 7040`, always-on < 2,560 B) and the budget siblings `aiToolIndex.w15-budget.test.ts`, `aiToolIndex.w16-budget.test.ts`, `aiToolIndex.w16b-budget.test.ts` and `aiToolIndex.w18-budget.test.ts`.
  - Re-key line-keyed entries if `aiToolsFleet.ts` lines move (`aiToolsFleet.userOwnedRelease.contract.test.ts`, `aiGuardrails.ts` comments); never delete an entry.
- **3.3 `draft_flow` refuses an unversioned update** (Decision P7): `{ error: 'expected_version_required' }`. Failing test first. The W1 warning test becomes a refusal test.
- **3.4 "Waiting for enable" API.** `GET /flows?awaitingEnable=true` lists `draft` flows in the caller's reach whose creator cannot enable them. The rule is the enable path's delegation check (`ceilingAllowsDelegation`, a site ceiling) evaluated for `created_by_user_id` against the flow's owner, over at most one page (≤ 100 rows).
  - Put the rule in a new `services/flows/awaitingEnable.ts`, not in `service.ts`.
  - Tests: `a draft saved by a site-limited user is listed`; `a draft saved by a user who can enable is not`; `org reach is the caller's RLS`.
- **3.5 PR** with the B6 contract batch.
- **If Q4 is answered (a):** `GET /config` adds `features.flowEventsDurable` (`isFlowEventDeliveryDurable()`), with tests in `routes/config.test.ts`.

### W03b tasks

- **3.6 Jobs page and `/jobs/new`.**
  - With Flows on, the Jobs page's **New** button links `/flows/new`, labelled `flows:jobs.migration.newJobOpensFlows` (existing, unused since #12366).
  - `/jobs/new` sends the user to `/flows/new` by a client island (Decision P5's mechanism), per Q4:
    - (a) only when Flows are on **and** event delivery is durable; otherwise the Job form opens with the Event trigger only;
    - (b) whenever Flows are on.
  - `/automations/new` keeps its 301 to `/jobs/new`, so nothing loops.
  - `conversionApi.ts` maps `automations_moved_to_flows` (existing key) again.
  - The R1 banner body stops saying jobs can still be created.
  - Tests: `with Flows on, New opens /flows/new`; `/jobs/new goes to /flows/new` (per Q4); `a 410 from the form renders the moved-to-Flows notice with a link to /flows/new`.
- **3.7 "Waiting for enable" filter** on the Flows tab, with hash state `#filter=awaiting-enable`. Test: `the filter follows the hash and lists drafts awaiting enable`.
- **3.8 Preview removed.**
  - Remove the `previewTag` field, `flows-preview-tag`, the strip's preview tag and the rail label suffix.
  - Remove `nav.previewTag` from all 8 `common.json` files when nothing else uses it.
  - Update `Sidebar.flows.test.tsx` and `FlowsPage.test.tsx`.
  - Rewrite `flows:empty.body`'s last sentence ("a job is simpler") in all 8 locales.
- **3.9 Docs, release notes, wave verification.**
  - Docs (`features/automations.mdx`, `features/flows.mdx`); regenerate the docs index.
  - Release notes (spec §3.8 Wave 3 list), including the exact lines `EVENT_DISPATCH_MODE=enforce` and `EVENT_DISPATCH_QUEUE_SUBSCRIBERS` containing `flow-event-trigger` (the subscriber id in `flowValidator.ts`); the accepted exceptions; "Preview" removed.
  - Locally verify the 410 per trigger, the `/jobs/new` behaviour and the filter on a per-worktree stack, with durable and non-durable event settings. Tear down.
  - Open the PR.

---

## W3a — Conditional parity prerequisites (placeholder)

Spec §3.4, §8 row W3a, OD5, OD6 and OD8. Nothing here is dispatched until the owner adopts it from the W02b census. **Each adopted item needs its own plan, approved at its own Gate B, before any code, and must ship before W5 if it is adopted for R3.**

| Item | Triggered by (W02b census) | Default if not adopted | Notes for its plan |
|---|---|---|---|
| **W3a-1** Webhook pre-approval for literal selectors | `webhookScriptJobs` (with `approval_each_run`). OD5: adopted if the owner judges the count material | OD5 option B: webhook flows always ask a person, and the accepted exception is named in the W3 and W5 release notes | Reopens W05 Decision 4. It needs its own Codex quorum (W06 Decision 5, "Alternative"). |
| **W3a-2** A deployment path | `deploy_software_unmapped` | OD6 option B: deployment automation points at software policies and deployments, and deployment Jobs join the "kept" list at R3 | Option A is a new built-in and a Tier 3 lane (W06 Decision 18). |
| **W3a-3** Event-filter coercion | `event_filter_string_coercion`, `event_filter_null`, `event_filter_not_strict` | Filed as a roadmap issue | W06 Decision 17 left string filters at review and null, array and object filters as blockers. |
| **W3a-4** A higher fleet or for-each cap | `targets_over_cap`, `notify_per_run_cap`, `failure_notice_cap` | Filed as a roadmap issue | W06 Decision 18 raised no limit. |

OD8's other deferred items are filed as roadmap issues; the auto-switch grant is dropped (spec §6 table). The orchestrator files them when the W02b comment is posted. They are not plan tasks.

### Execution split and parallelism

Each adopted item's own plan defines its parts, models, commands and migration slot. Until then there is nothing to dispatch.
- Expected default: one API part per item, plus one web or docs part if it changes the editor or enable dialog. All based on `main`.
- Opus for W3a-1 and W3a-2: pre-approval authority and a Tier 3 lane.

---

## W4 — R2 freeze

**Design record:** the W06 plan, section "PR D — R2 freeze": Task D1 (standalone writes return 410), Task D2 (pre-create sweep and startup check) and Task D3 (R2 banner, docs, release notes). Implement them as written there, with the changes below. **Gate:** at least one release after W3.

**Changes from spec §3.6 and the Decision 8 amendment:**
1. **D1's failing-test list adds back `POST /automations is 410`.** This is carried forward explicitly from the W06 Decision 8 amendment. With W3 in place it reads: `POST /automations stays 410 per trigger under the freeze (an event Job on a non-durable installation is still created)`.
2. **One rule for the freeze and the create refusal.** D1's environment exception (a row blocked by `flows_disabled` or `event_dispatch_not_durable` stays writable) is the same rule as W3's `createRefusalFor`. D1 calls a shared predicate so the two cannot disagree. Test: `an installation without durable event delivery can create and edit event Jobs and nothing else`.
3. **Banner and Jobs tab copy:** "Jobs can't be changed any more. Move them to Flows", with a link to `/flows/new` for new work (keys `jobs.migration.banner.r2` and `r2Body`, all 8 locales).
4. **The Partner API read-only flows export (OD2)** ships in W4, at the latest in the same release as the freeze. See W04b.
5. **Gating restated:** at least one release after W3, not after R1.

### Execution split and parallelism

- **W04a — Freeze and sweep** (API, **opus**, high rigor).
  - Scope: W06 Tasks D1 and D2, plus changes 1, 2 and 5.
  - Owns:
    - `routes/automations.ts` (write routes);
    - `services/aiToolsFleet.ts` (`manage_automations` enable/run);
    - a new `services/flows/conversion/precreateSweep.ts` (+ test);
    - `src/index.ts` (the detached boot hook);
    - `FLOW_CONVERSION_SWEEP_DISABLED` plumbing: `config/env.ts`, `config/validate.ts`, `system/connections/internalEnvVars.ts`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`, `.env.example` (both), `apps/docs/src/content/docs/deploy/environment.mdx`.
  - W04a regenerates `docsIndex.json` for its `environment.mdx` row (`config/envReadComposeCoverage.test.ts` ties env reads, compose and that page together). It is the only parallel W4 part that touches docs; W04b touches none, and W04c starts after both merge.
  - **PARALLEL GROUP 4a-1:** D1; D2's sweep service. **SERIAL:** the boot hook, then env plumbing.
  - Sonnet-eligible: env, compose and `.env.example` plumbing.
  - Commands:
    - `cd apps/api && npx vitest run src/routes/automations.test.ts src/routes/automations.managedByMonitor.test.ts src/services/aiToolsFleet.test.ts src/services/aiToolsFleet.userOwnedRelease.contract.test.ts src/services/aiGuardrails.routeBinding.contract.test.ts src/services/aiToolMfaGate.routeParity.contract.test.ts src/services/flows/conversion/precreateSweep.test.ts src/services/flows/conversion/createRefusal.test.ts src/config/envReadComposeCoverage.test.ts src/__tests__/orgSettingsWriters.contract.test.ts src/__tests__/parkedFanout.contract.test.ts`;
    - the integration file;
    - the API typecheck.
  - Contracts:
    - re-key, never delete, `aiToolsFleet.userOwnedRelease.contract.test.ts` and any `file:line`-keyed entry the edits shift;
    - `aiGuardrails.routeBinding` and `aiToolMfaGate.routeParity` stay green (PUT/PATCH still exist);
    - `orgSettingsWriters.contract.test.ts` classifies the `partners.settings.flowConversionSweep` write if it covers partner settings;
    - `envReadComposeCoverage`.
  - Integration: `automationConversionSweep`.
- **W04b — Partner API flows export** (API, **opus**: export classification and tenancy).
  - Owns:
    - a new `routes/partnerApi/configurationFlows.ts` (`configuration.ts` is 588 lines);
    - its mount line in `configuration.ts`;
    - `routes/partnerApi/exportSafety.classification.ts` and its test;
    - the envelope schema in `packages/shared`.
  - **No docs.** W04c writes the Partner API row in `reference/api.mdx`.
  - Commands: `cd apps/api && npx vitest run src/routes/partnerApi/configurationFlows.test.ts src/routes/partnerApi/exportSafety.classification.test.ts src/__tests__/mcp-coverage.test.ts src/__tests__/routerAuthGate.contract.test.ts src/__tests__/writeRoutePermissionGate.contract.test.ts`; `cd packages/shared && npx vitest run <envelope schema test>`; both typechecks.
  - Behaviour, per spec §3.2: `GET /partner-api/configuration/flows` with `requirePartnerApiScope('configuration:read')`.
    - Join key: the automations export's `conversion.flowId`.
    - The draft definition and the live publication (sequence, enabled time, delegator id) are separate fields.
    - The webhook secret ciphertext is never exported (`excludedSensitive` in `tenantExportPolicyRegistry.ts`).
    - `definition` follows the `customer-authored` classification.
    - `mcpCoverage.ts`: classify the new route file the way the existing partner API files are.
  - Tests:
    - `the flows export is read-only and scoped to the partner's orgs`;
    - `the webhook secret is never in the export`;
    - `every column is classified`;
    - Partner API compat: additive fields only.
- **W04c — R2 banner, read-only edit page, docs, verification** (web and docs, **sonnet**).
  - Scope: W06 Task D3, plus change 3.
  - Owns:
    - `components/automations/conversion/JobsMigrationBanner.tsx`;
    - `AutomationEditPage.tsx` (read-only for frozen rows);
    - `AutomationsTabStrip.tsx` (the Jobs tab tooltip copy, if any);
    - locales in all 8 files;
    - `features/automations.mdx`, `reference/api.mdx` (Partner API flows export row), `docsIndex.json`;
    - the release-notes append (spec §3.8 Wave 4 list).
  - Owns whole-wave verification: on a stack, PUT, PATCH, trigger and run on an unswitched S row are 410; disable, delete, preview and convert work; M, A and P rows are unaffected; a rerun of the sweep is a no-op; the startup error appears with pending rows.
  - Commands:
    - `cd apps/web && npx vitest run src/components/automations/AutomationsPage.conversion.test.tsx src/components/automations/conversion/JobsMigrationBanner.test.tsx (new; none exists today) src/components/automations/AutomationEditPage.test.tsx src/components/automations/AutomationsTabStrip.test.tsx`;
    - the i18n batch;
    - astro check; lint;
    - `npx tsx scripts/build-docs-index.ts && cd apps/api && npx vitest run src/services/aiToolsDocs.test.ts`.
- Merge order: W04b and W04a (either order; same release), then W04c. W04c starts after both have merged.
- Migration slot: none (W06 plan header: "PRs D (R2) and E (R3) need no migration at the defaults").

---

## W5 — R3 retirement

**Design record:** the W06 plan, section "PR E — R3 standalone admission retirement": Task E1 (the gate), Task E2 (retirement sweep under acceptance) and Task E3 (docs, release notes). Implement them as written there, with the changes below.

**Gates:**
- at least one release after W4;
- every W3a item adopted for R3 has shipped;
- OD5 and OD6 are settled;
- the hosted condition in "Owner gates".

**Changes from spec §3.6:**
1. **R3 is inert when `FLOWS_ENABLED=false`.** `resolveRetirementGate()` checks `flowsEnabled()` first. When Flows are off it returns both admission flags open with `reason: 'flows_disabled'`, whatever the census and the acceptance flag say. Test: `with FLOWS_ENABLED=false the gate keeps every admission open even with LEGACY_JOBS_RETIREMENT_ACCEPTED=true`.
2. **The hosted condition.** On the hosted installations, unswitched admission closes only through the gate's own zero-pending rule or through `LEGACY_JOBS_RETIREMENT_ACCEPTED=true`. Setting that variable on hosted requires the owner's recorded acceptance. This is a deploy-time gate, not code. The W05b PR body and the release notes say so.
3. **Deployment and webhook Jobs** follow the OD5 and OD6 decisions. If OD6 resolves to option B, the E2 sweep keeps deployment Jobs, like the S+R rows: `keptForRemediation` becomes `kept: { remediation, deployment }`. Test: `deployment Jobs survive the sweep under OD6 option B`. If OD5 resolves to option B, the release notes name webhook script Jobs that stop at R3 as an accepted exception.
4. **The Jobs tab** is hidden only once R3 has closed revert on the installation (`REVERT_CLOSED`) and no unretired Job remains (spec §3.3). Test: `the Jobs tab hides only after revert is closed and no Job is listed`.
5. **Gating restated:** at least one release after W4.

### Execution split and parallelism

- **W05a — Gate and sweep** (API, **opus**, high rigor).
  - Scope: W06 Tasks E1 and E2, plus changes 1 and 3.
  - Owns:
    - a new `services/flows/conversion/retirementGate.ts` (+ test);
    - `jobs/automationWorker.ts`, `routes/automations.ts`;
    - `services/flows/conversion/revert.ts` (`REVERT_CLOSED`);
    - a new `services/flows/conversion/retirementSweep.ts` (+ test);
    - `LEGACY_JOBS_RETIREMENT_ACCEPTED` plumbing: same file set as W04a's env plumbing, including `environment.mdx` and its `docsIndex.json` regeneration;
    - `GET /config` or the automations list response, for the R3 state change 4 needs. Name the field in the PR.
  - Update the `parkedFanoutModules.ts` guard counts if they move.
  - **PARALLEL GROUP 5a-1:** E1 gate; E2 sweep (after E1's interface is fixed). **SERIAL:** env plumbing.
  - Sonnet-eligible: env plumbing.
  - Commands:
    - `cd apps/api && npx vitest run src/services/flows/conversion/retirementGate.test.ts src/services/flows/conversion/retirementSweep.test.ts src/services/flows/conversion/revert.test.ts (new; revert has no unit test today, only the integration suite flowConversionRevert) src/routes/automations.test.ts src/config/envReadComposeCoverage.test.ts src/__tests__/parkedFanout.contract.test.ts`;
    - every `src/jobs/automationWorker*.test.ts` and `src/services/automationRuntime*.test.ts` sibling, listed by exact name (`ls` them first; vitest does not expand globs);
    - the W06 integration suites listed in W06 Task B7;
    - the API typecheck.
- **W05b — R3 banner, Jobs-tab hiding, docs, verification** (web and docs, **sonnet**).
  - Scope: W06 Task E3, plus change 4.
  - Owns:
    - `JobsMigrationBanner.tsx` (`r3Retired`, `r3Pending`);
    - `AutomationsTabStrip.tsx`;
    - locales in all 8 files;
    - `features/automations.mdx` (it becomes a history page that points to Flows, per the W06 close-out list), `docsIndex.json`;
    - the release-notes append (spec §3.8 Wave 5 list).
  - Owns whole-wave verification against the W06 plan's Review Focus "Retirement on a self-hosted install" scenario, plus change 1.
  - Commands:
    - `cd apps/web && npx vitest run src/components/automations/AutomationsPage.conversion.test.tsx src/components/automations/conversion/JobsMigrationBanner.test.tsx (new; none exists today) src/components/automations/AutomationsTabStrip.test.tsx`;
    - the i18n batch;
    - astro check; lint;
    - the docs-index regeneration and `aiToolsDocs.test.ts`.
- Merge order: W05a, then W05b. W05b starts after W05a merges, because both regenerate `docsIndex.json`.
- Migration slot: none. No table or column is dropped (spec §5, OD7).

**W4 and W5 exit:** the W06 plan's "Exit checklist" rows for **R2 (PR D)** and **R3 (PR E)** are all true, plus each change listed above has its test.

---

## CI traps

- **#12366 baseline.** Several W1 tests assume its files (the Preview tag, the empty-state keys, the reopened `POST /automations`). Every part's Step 0 checks it.
- **The golden file is evidence, not a fixture.** A W01a golden diff means the move changed the converter's output. New conversions would then leave the shapes the W06 parity suite proved. Never regenerate it to get green.
- **`requireAutomationWrite` carries `requireMfa()`.** Draft routes use their own gate. `aiToolMfaGate.routeParity.contract.test.ts` reads aliases spread into chains.
- **`partner-wide-write-coverage.test.ts` is textual.** `deleteDraft.ts` must name `canManagePartnerWidePolicies` itself.
- **`no-silent-mutations`.** `api.ts` is targeted. The validate POST needs its `// runaction-exempt:` marker on the call.
- **`parkedFanout.contract.test.ts`** discovers only files that read `devices` or carry quick-support or hidden-org exclusions. Run it anyway. It sits in `__tests__/`, which fixers miss.
- **Line-keyed AI-tool allowlists.** `aiTools.userOwnedRelease.contract.test.ts` (`SAFE_WRITE_SITES`, `file:line`) and `aiToolsFleet.userOwnedRelease.contract.test.ts`. Edits in `aiToolsFlows.ts` (W1, W3) and `aiToolsFleet.ts` (W3, W4) can move keys. Re-key; never delete.
- **Tool index and descriptions.** The index renders `searchHint` and actions, not descriptions. The binding limit for a description edit is `aiTools.descriptionBudget.contract.test.ts` (300 / 160). The index limits are in `aiToolIndex.test.ts`: `INDEX_BUDGET_BYTES = 7040` worst turn and always-on < 2,560 B, plus the budget siblings `aiToolIndex.w15-budget.test.ts`, `aiToolIndex.w16-budget.test.ts`, `aiToolIndex.w16b-budget.test.ts` and `aiToolIndex.w18-budget.test.ts`.
- **`site-scope-coverage`** runs as its own CI step (`test:site-scope-coverage`). It scans `:deviceId` routes only.
- **Integration only in CI.** `flowDraftRoutes`, `flowsPartnerRls`, `rls-coverage` (own runner), cascade, export and org-merge suites run only under Integration Tests. A green unit run proves nothing about them.
- **Locales.** All 8. A value identical to English counts against `translationCoverage.test.ts`. No `t(cond ? a : b)`. No internal wave names (`monitoringNoInternalWaveNames.test.ts`).
- **Docs index.** Any `.mdx` change without `npx tsx scripts/build-docs-index.ts` fails `aiToolsDocs.test.ts`. Two parts that regenerate it must merge one after the other, the second rebased and regenerated.
- **Release-notes draft.** Append only, under a per-wave heading; rebase just before opening the PR. Do not enqueue behind a queued PR that touches it without rebasing.
- **The web eslint config has no react-hooks plugin.** A `react-hooks/*` disable comment fails `pnpm lint`.
- **Monaco in tests.** Mock `@monaco-editor/react` as `ScriptForm.test.tsx` does. jsdom cannot load the worker.
- **tsc under a pipe** reads an OOM as green. Always `echo "exit=$?"`.
- **Stacked PRs get no CI.** Every part branches from `main`.

## Out of scope

- Classes M, A, P and C, the R dependency, deleting `automationWorker`, the `automations` queue and `scan-schedules`, and the table drop sequence (spec §5, OD7). #10336 stays the roadmap item for them.
- Editing an enabled flow without disabling it (OD2 option B; a later wave once every `flows.definition` reader is audited).
- A canvas or node editor; new built-ins except what W3a adopts.
- Any automatic switch of a Job to a flow.
- The Wisp ceiling redesign (#11155) and the chat gaps in spec §3.7.
- Re-aiming #9900, #9209 and #11643 (spec OD9). The orchestrator handles those issue comments; they are not plan tasks.

## Self-review

- **Spec coverage.**
  - §3.1 editor → W01a, W01c, W01e (with the two deliberate differences: one-per-run notify in A2, no command action in E3).
  - §3.2 routes, `draft_flow` parity and `mcp-coverage` → W01b. The Partner API export → W04b.
  - §3.3 nav, tabs and URLs → W01d (and `/jobs/new` in W3b).
  - §3.4 per-trigger refusal → W03a. The "Waiting for enable" filter → W03a and W03b. Preview removal → W03b.
  - §3.5 census and the eight live checks → W02a and W02b.
  - §3.6 → the change lists in W4 and W5.
  - §3.8 release notes → E7, W02a, 3.9, W04c, W05b.
  - §4: no new table, column, setting or migration; stated per part.
  - §7 tests → mapped into tasks.
  - §8 order is unchanged.
  - §3.7 needs no task.
- **Step scan.** Every W1 step names files, signatures, the values the spec pins and its test names. W2 and W3 are at task level, W3a is a placeholder, and W4 and W5 reference the W06 sections by name.
- **Type consistency.** The same names are used everywhere they appear: `compileFlowForm`, `decodeFlowForm`, `recognizeFlowForm`, `normalizeFlowDocument`, `structurallyEqual`, `sameFlowDocument`, `flowDocumentJsonSchema`, `FlowFormValues`, `emitRunScriptStep`, `emitDeviceItems`, `emitCreateAlertStep`, `emitFailureNoticeSteps`, `validateFlowDraft`, `deleteDraftFlow`, `createFlowDraft`, `updateFlowDraft`, `deleteFlowDraft`, `validateFlowDraftDocument`, `FleetMaxTargetsField`, `parseFleetMaxTargets`, `createRefusalFor`, `jobCounts.notMoved`.
- **Review Focus.** Each of the five has a named test in its owning task.
- **Proportion.** Code blocks are limited to the W01a and W01b interfaces, which later parts consume verbatim.

## Questions for the owner

These are product or UX calls the spec does not settle. Each part that depends on one is written to the default shown and says so in its PR body.

**All six were answered by the owner on 2026-11-23.** The answer is recorded under each question. Wave 1 merged to the defaults before the answers; where an answer differs from what was built, the follow-up sub-issue is named. None of wave 1 was in a release when the answers came.

1. **Where does the "Preview" tag sit once Jobs and Flows share one "Automations" nav entry (W1)?**
   - **(a) On the Flows tab of the tab strip and the Flows page header, not on the nav entry.** Pro: the tag labels only what is in preview. Con: the tag is less visible from the sidebar.
   - **(b) On the "Automations" nav entry.** Pro: as visible as today. Con: it labels Jobs as a preview too.
   - **Recommend (a).** "Preview" describes Flows, not the category, and the tag comes off in W3 anyway. W01d is written to (a).
   - **Answered 2026-11-23: (a).** As built.
2. **Should the one-per-run notification link the run page instead of the flow page?** The `notify` built-in links `/flows/<flowId>` for every notice today, and a flow cannot template its run id.
   - **(a) Keep the flow link.** Pro: no engine change. Con: the spec's "links the run" is not met; the reader opens the flow's Runs tab.
   - **(b) Change the built-in's link to `/flows/runs/<runId>` for every `notify` step.** Pro: meets the spec. Con: it also changes the link in converted flows' existing notices.
   - **Recommend (b).** A run link is strictly more useful, the run page links back to the flow, and it is a one-line change in W01a. The plan is written to (a) until you answer.
   - **Answered 2026-11-23: (b).** Sub-issue #12597 (W01h).
3. **Should the editor's on-failure notice be one message per failed device or one per failing step?** The spec says "same shape as the converter", which sends one notice per failed device and channel. More than 20 failures in one run hit the per-run cap, and the excess notices fail visibly.
   - **(a) Per device, as the spec says.** Pro: one shape across the converter and the form; the recognizer is simpler. Con: noisy, and capped at 20.
   - **(b) One summary per failing step**, listing the failed count, like the notification-action change. Pro: never capped; consistent with "one message per run". Con: a second shape the converter does not emit.
   - **Recommend (b),** for the same reason the spec changed notifications. The plan is written to (a) until you answer.
   - **Answered 2026-11-23: (b).** Sub-issue #12596 (W01g). The form records which shape a flow uses. New flows get the summary. A flow that already has the per-device shape (every flow moved from a Job, because the converter's output does not change) keeps it and stays form-shaped: `recognizeFlowForm` is a round trip, so `compileFlowForm` must reproduce the shape it decoded.
4. **In W3, what does `/jobs/new` do on an installation without durable event delivery?** The spec redirects `/jobs/new` to `/flows/new` while still letting such an installation create event Jobs. With the redirect, the web has no way left to create one.
   - **(a) Redirect only when Flows are on and event delivery is durable.** Otherwise the Job form opens with only the Event trigger. This needs `GET /config` to expose `features.flowEventsDurable`. Pro: keeps the per-trigger rule usable in the product. Con: one more flag in `/config`.
   - **(b) Always redirect while Flows are on.** Event Jobs on such installations are API-only. Pro: simplest. Con: self-hosters without durable delivery lose event automations in the web.
   - **Recommend (a).** It is the UI half of the rule OD4 adopted.
   - **Answered 2026-11-23: (a).** Built in W3: W03a exposes `features.flowEventsDurable` in `GET /config`, W03b applies the conditional redirect.
5. **For event triggers whose payload may carry no device, should the form still bind the triggering device and hide the target picker (W1)?** The converter binds every event Job to the triggering device. `trigger.device` exists only when the event names a device in the run org, and otherwise the script or alert step fails. This plan did not check which listed events can arrive without one (for example a SentinelOne threat or a Huntress incident with no mapped device).
   - **(a) Bind the triggering device for every listed event (converter parity).** Pro: one rule, matches legacy Jobs. Con: a run with no device fails visibly.
   - **(b) Bind the device only for events that always carry one, and offer the picker for the rest.** Pro: no failing runs. Con: needs a maintained list of device-bearing events, and differs from converted Jobs.
   - **Recommend (a) for W1**, with a help line under the event picker that says the run needs the event to name a device. The plan is written to (a).
   - **Answered 2026-11-23: (a).** As built. A read of every publisher on 2026-11-23 found that seven of the 13 listed events can arrive with no device (two of them, `huntress.agent_offline` and `s1.threat_action_completed`, only in edge cases): `alert.triggered` and `alert.resolved` (alerts on a backup workload; no run starts), and `huntress.incident_created`, `huntress.incident_updated`, `huntress.agent_offline`, `s1.threat_detected` and `s1.threat_action_completed` (the host is not matched to a device; the run ends `failed`). The help line is corrected per event family in the PR for #12497. One rule for all of them is #12602.
6. **Should "Disable and edit" warn up front, for a webhook flow, that re-enabling after an edit clears the webhook secret?** By design (#10270), a secret minted against an older draft does not survive publishing an edited one, so the sender must get a new secret. Webhook flows are enabled from the flow page (P21), which already shows the existing notice after an enable that clears the secret (P17).
   - **(a) Add one sentence to the confirm for webhook flows.** Pro: the person learns before disabling a live integration. Con: one more locale key.
   - **(b) Notice after enable only.** Pro: no new copy. Con: the person finds out after the integration is already refusing requests.
   - **Recommend (a).** W01e is written to (b) until you answer; (a) adds one key in E6.
   - **Answered 2026-11-23: (a).** Sub-issue #12598 (W01i).
