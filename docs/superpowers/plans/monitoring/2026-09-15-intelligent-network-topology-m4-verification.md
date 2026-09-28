---
tracking_issue: LanternOps/breeze#5995
wave: W05 (#6000) M4
tasks: 5, 6 (plus the post-rebase gate)
date: 2026-09-26
---

# M4 verification record (post-rebase gate, Tasks 5 and 6)

Only what was actually executed on 2026-09-26 in worktree `w6000`
(branch `feature/5995-topology/wave-6000`) is recorded here. Anything not
listed was not run. No test in any run below reached a real model: the API
suites mock the provider at `chatStream` (and make the SDK transport throw if
constructed), the web suites mock `fetchWithAuth`.

## Step 1: rebase onto the reviewed W04 head

The four W05 commits were replayed onto `origin/feature/5995-topology/wave-5999`
(`26633a98d`, then again onto `7f4749315` when W04 gained the
`topology:execute` permission commit).

Conflict resolutions:
- `routes/mobile.ts`: kept W04's site-owned alert scoping imports and W05's
  topology-session access condition on mobile search.
- `routes/orgs.ts` `DELETE /orgs/sites/:id`: one transaction under the site row
  lock removes the site-owned topology alerts (W04) and the site's pinned
  topology investigation sessions (W05) before the site row; the audit row
  carries both `removedTopologyAlerts` and `topologyInvestigationsDeleted`.
  `routes/orgs.test.ts` transaction doubles updated for both cleanups.

Gate fix (`84487b79d`): `topologyAiApproval.integration.test.ts` flaked on
whichever case decided fastest. Root cause, measured: the local Postgres clock
runs ~31 ms ahead of the host, and the release check compared
`action_intents.decided_at` (API clock) with `created_at` (DB clock) exactly,
refusing a legitimate fresh-factor approval as `fresh_mfa_required`. The check
now tolerates 60 s of skew; a decision recorded well before the proposal is
still refused. Both directions pinned (red on the old code, then 3 green runs).

| Command | Result |
|---|---|
| `apps/api: npx tsc --noEmit -p .` (12 GB heap) | exit 0 |
| `apps/web: npx tsc --noEmit -p .` | exit 0 |
| `packages/shared: npx tsc --noEmit -p .` | exit 0 |
| `apps/api: npx vitest run src/services/ai src/services/actionIntents src/services/topology src/routes/ai src/routes/orgs src/routes/mobile src/routes/alerts src/__tests__/mcp-coverage.test.ts src/services/siteOwnedAlerts` | 619 files, 10,964 passed, 2 skipped |
| Integration (`vitest.integration.config.ts`, real Postgres :33252 / Redis :33253, 2FA not disabled): `topology*`, `siteDelete*`, `alert*`, `tenantCascade*`, `tenantExportErasureRoundtrip`, `tenant-export-policy`, `orgMergeRegistry`, `orgLifecycleFoundations`, `deviceMoveOrgAlert*` | on `26633a98d`: 93 files, 593 passed; on `7f4749315` with the gate fix: 94 files, 596 passed |
| `DB_CONTEXTLESS_WRITE_STRICT=true npx vitest run --config vitest.config.rls-coverage.ts` | 1 file, 103 passed |
| `bash scripts/check-migration-naming.sh --against-ref origin/main` | OK |

## Task 5: Explain this (`40f70a936`)

| Command | Result |
|---|---|
| `apps/web: npx vitest run` (full web suite) | 1,222 files, 13,232 passed, 1 todo |
| `packages/shared: npx vitest run` (full) | 184 files, 3,948 passed |
| `apps/api` unit subset above, re-run after Task 5 | 618 files passed; the one red file (`aiOutputGate.test.ts`, fixture without `modelEvidence.nodes`) fixed and re-run: 21 passed with `aiCitations.test.ts` |
| `apps/api: npx vitest run src/services/aiAgentSdk.approvalWait.test.ts src/services/aiAgentSdk` | 19 files, 334 passed |
| `apps/api`/`apps/web`/`packages/shared` `tsc --noEmit` after Task 5 | exit 0 each |
| `npx eslint` on every touched API and web source file | exit 0 |

Red first (seen failing before the implementation): host-alias mapping
(`aiCitations.test.ts`, 2 red), run announcement (`aiAgentSdk.topologyTools.test.ts`),
pinned approval card (`aiAgentSdk.approvalWait.test.ts`, 2 red), fresh-factor
decide (`intentApprovals.test.ts`, 3 red), approval dialog (3 red), hash keys
(1 red), store topology behavior (`aiStore.topology.test.ts`, 8 red against the
previous store). The panel, citation and hook suites were written after their
components; their discriminating power was checked by mutation instead
(alias mapping removed, unmount interrupt removed, selection-change
cancellation removed: each turned exactly one test red).

Not done in Task 5: the plan's optional "accept manual assertion" control (no
AI hypothesis can be persisted from the panel at all); browser keyboard /
screen-reader / small-viewport checks were not run by hand.

## Task 6: isolation, fallback and release accounting

New real-DB suites (`vitest.integration.config.ts`):
- `topologyAiIsolation.integration.test.ts` (real eligible origin, real
  intent/approval chain, real M1 run): another org cannot reuse the session to
  propose, decide the approval, see the intent or read the run (RLS, service
  and HTTP route); a same-org user restricted to another site gets the same
  refusals and cannot pin the site; citations re-authorize to nothing for
  either (including a forged scope); no topology tool result is offered to
  artifact capture while a non-exempt control tool is (mutation-checked:
  flipping `captureExempt` turns it red); a spent approval never starts a
  second run.
- `topologyAiFailureAccounting.integration.test.ts` (real AI routes, provider
  mocked): a thrown provider error and a provider error event both end in the
  fixed failure with no partial text, nothing persisted, the lease released
  and the reservation unsettled; one live investigation settles exactly once
  (1.5 cents for 100/50 tokens on the reservation, session and org usage),
  consumes its per-investigation token budget and counts once per hour; a
  cached replay costs nothing and never calls the model; a scope move refuses
  the cached replay (409); one user's cached answer is never replayed to
  another; a hostile node label never reaches the model; a model instruction to
  run commands creates no intent or command; links, invented aliases, unknown
  recipes and tool-call-shaped answers are stripped or fall back.

| Command | Result |
|---|---|
| `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyAi src/__tests__/integration/topologySiteDeleteSessions src/__tests__/integration/siteDelete` | 9 files, 52 passed |
| same two new suites after the review tightening (below) | `topologyAiIsolation` 5 passed, `topologyAiFailureAccounting` 8 passed |
| final re-run of the 9 files above on `01238cf4b` + the Task 6 suites | 9 files, 53 passed |
| `apps/web: npx vitest run` (full) on `01238cf4b` | 1,222 files, 13,238 passed, 1 todo |
| `apps/api: npx vitest run src/config/composeBindMounts.test.ts` (overlay tracked) | 3 passed |

### Review round (one independent review of `40f70a936` + the two new suites)

Three web defects, each reproduced as a red test and fixed in `dd49ae313`:
the approvals inbox would have shown a refused `fresh_mfa_required` approve as
approved (the new outcome is now returned only on the fresh-factor path); a
topology `createSession` while the shared store was streaming left
`isStreaming` set, so the first question was never sent; a proposal card
decided elsewhere or timed out stayed actionable after the turn (withdrawn on
`topology_diagnostic_run` and `done`). Test weaknesses fixed: the session-hijack
case now uses a same-org user WITH site access (refused as
`topology_session_required`, no intent written) with a positive control; the
site-pin refusal has a positive control; the failure case asserts the one held
reservation exists and is unsettled.

### E2E: `e2e-tests/tests/topology-ai.spec.ts` on a worktree stack

Stack: `pnpm wt-stack up` for this worktree (arm64 dev images), plus the repo
overlay `docker-compose.override.yml.topology-ai-e2e`, which maps `MCP_LLM_*`
into the api container and runs `e2e-tests/fixtures/mockLlmServer.mjs` as the
`mock-llm` service inside the stack network (the API's egress guard refuses
loopback and OrbStack's host gateway). The API used the OpenAI-compatible
chat-only transport pointed at the mock; provider keys in the worktree `.env`
were blanked, so no real model was reachable. Seed: `e2e-tests/helpers/topologyAiSeed.ts`
(fresh site, topology flags on, a device-bound node whose label is a
prompt-injection string, a peer node, one relationship).

First run (on `dd49ae313`): test 1 red, which exposed two product defects:
the validated explanation arrives after the transport's `message_end` and was
dropped client-side, and a reload with `#…/explain/<id>` never re-fetched the
session. Both reproduced as red unit tests, fixed in `01238cf4b`.

Final runs (on `01238cf4b`), full file in one invocation, twice:
**4 passed, 0 failed, 0 skipped** (20.8 s; repeat 14.1 s):
1. no model request before Explain, exactly one after it; findings,
   hypotheses, missing data and next checks render; the hash carries
   `explain/<id>`; the model request body contains no raw injection label, no
   host name and no org/site/device id, and no `tools`;
2. a fresh context opening that hash (and reloading) re-shows the stored
   explanation with the model request count unchanged;
3. provider HTTP 500 → the deterministic fallback, with Diagnose still present;
4. no unapproved dispatch: zero `topology_diagnostic_runs`, `device_commands`,
   `action_intents` (diagnose_connectivity / execute_command) and AI tool
   executions for the test site after the runs.

Teardown: `pnpm wt-stack down`, then `docker compose -p breeze-wt-feature-5995-topology-wave-6000 down -v --remove-orphans`;
`docker compose ls -a` shows no `breeze-wt-…-6000` project afterwards. Side
effect: the shared local `breeze-*:dev` images were re-tagged as arm64 builds.

Not run in the browser: the approve path. The chat-only transport has no tool
calling, so a proposal cannot occur end to end with this mock, and a fresh
WebAuthn approval would additionally need a registered virtual approver
device. The proposal, fresh-factor approval, release and isolation are covered
by the real-DB suites and the web unit suites above.

Not done in Task 6: the plan's `seedAiSiteMoveFixture` lifecycle suite (old/new
site readers across a device move with paused provider promises) was not built;
the move is covered only by the existing mid-turn move case, the evidence
invalidation case and the new cached-replay-after-move case (which refuses with
409 `graph_revision_changed`/`investigation_scope_changed` and no model call).
The SDK (tool-calling) transport was not exercised end to end with a mocked
model.
