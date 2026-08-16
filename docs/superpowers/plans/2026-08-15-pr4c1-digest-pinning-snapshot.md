# Tenant Variables #3409 — PR4c-1 Implementation Plan (approval-digest pinning + verified release snapshot)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an approved `run_script` action-intent fail closed when the material it will actually execute has drifted — specifically when a tenant variable is rotated, rebound, deleted, reclassified `isSecret`, newly overridden at org level, or has become unreadable — and close the check/use race by resolving **once** into a verified snapshot that is then handed to dispatch instead of re-queried.

**This PR ships no secret delivery.** Secrets remain blocked everywhere (PR4c-2 activates them). This is the integrity foundation that must land first.

**Why first (settled by advisor quorum, Opus + codex gpt-5.6-sol xhigh, 2026-08-15, user-approved):** PR3 already introduced approval drift. `effectDigest.ts` excludes `scripts.parameters` from the digest on the explicit stated grounds that the column "has no effect on execution" — but PR3 made `scriptDispatch` consume that column (the `hasTenantVariableBoundParameters` branch) to drive variable-scope loading and per-parameter bindings. **That comment's premise is false today, and the exclusion is a live approval-integrity bug.** Activating secrets before fixing it would let a rebound or rotated credential ride an unchanged digest straight through an approval.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL, Vitest, Zod 4.

---

## Global Constraints

- **Branch:** `ToddHebebrand/tenant-variables-pr4c`, based on `origin/main` (which now contains PR4a #3557 and PR4b #3562). Worktree `/Users/toddhebebrand/orca/workspaces/breeze/tenant-variables-pr4c`.
- **Never put a resolved variable VALUE into digest material.** The digest is a sha256 input and lands in `action_intents.effect_digest`, which is widely readable. Pin a stable *reference* — variable id + version + `isSecret` — never the plaintext. A reviewer will check this specifically.
- **Fail closed, in both directions.** Unresolvable, unreadable, or ambiguous state must produce a *mismatch or an unresolved outcome*, never a silent pass. Where the existing code has a fail-soft path, do not copy it.
- **`isSecret` can flip WITHOUT a version bump** (`services/tenantVariables.ts`, the update path). Pinning version alone misses it — pin `isSecret` explicitly, and treat a flip in **either** direction as drift.
- **Distinguish absent from unreadable.** Today `decryptRow` catches, warns, returns null, and the row is simply omitted from the scope — indistinguishable from "no such variable". An unreadable variable must block approval and release rather than looking absent.
- **Digest material is versioned.** Bump the run_script material to a `v: 2` envelope. See the Deployment Hazard section — this is deliberate and must be release-noted.
- **Do not widen `AuthContext` and do not smuggle the snapshot through `args`.** The snapshot travels via an explicit, typed parameter (Task 6).
- **Test commands:** `pnpm --filter @breeze/api test -- <path>` for a slice; the **full** API suite before opening the PR. Contract/integration suites are mandatory here (see Task 8) — `effectDigestToctou.integration.test.ts` and `effectDigestCoverage.contract.test.ts` both guard this exact surface, and the integration suites do NOT run in the unit job.
- **Mutation-verify every guard.** Force it off, confirm the new tests fail *and nothing else does*, restore.

---

## Verified seams (checked against this branch — do not re-derive)

| What | Where |
|---|---|
| Resolver map + `run_script` resolver (pins only `orgId`/`language`/`content`/`timeoutSeconds`/`runAs`) | `apps/api/src/services/actionIntents/effectDigest.ts:105-152` |
| The **false** exclusion comment for `scripts.parameters` | `effectDigest.ts:119-122` |
| `ResolverResult` three-way union (`material` / `missing_arg` / `target_absent`) | `effectDigest.ts:83-90` |
| Central hash — sha256 hex, **no canonicalization layer** | `effectDigest.ts:348-361` |
| `computeEffectDigest` flattener returning `string \| null` | `effectDigest.ts:372-379` |
| `hasPinnedDigest` | `effectDigest.ts:394-396` |
| Pin site (inside the creation transaction; no scope branch) | `apps/api/src/services/actionIntents/intentService.ts:407-408`, stored at `:441` |
| Column | `apps/api/src/db/schema/actionIntents.ts:169` (`char('effect_digest', {length:64})`), immutable trigger |
| Durable release: recompute + compare | `apps/api/src/jobs/intentReleaseWorker.ts:369-412`; execute at `:459` |
| Inline release: recompute + compare | `apps/api/src/services/aiAgentSdk.ts:1188-1206` |
| `executeTool` signature + handler dispatch | `apps/api/src/services/aiTools.ts:423-476`; handler called at `:475` |
| `AiTool.handler` type — `(input, auth) => Promise<string>`, **189 handlers, none takes a third arg** | `aiTools.ts:186-202` |
| Extension mirror of the handler type | `packages/extension-sdk/src/server.ts:9-14`; cloned at `apps/api/src/extensions/contributionRegistry.ts:68-95` |
| `run_script` handler (script re-query at `:185-189`, scope built at `:300-302`, dispatch at `:303`) | `apps/api/src/services/aiToolsScripts.ts:156-318` |
| `DispatchScriptInput.variableScope` — an existing explicit pre-resolved-snapshot channel | `apps/api/src/services/scriptDispatch.ts:73-78` |
| `TenantVariableScope` (opaque; private `byOrg`) + `resolveForOrg` membership check | `apps/api/src/services/tenantVariableResolution.ts:47-66`, `:222` |
| `ResolvedVariable` — already carries `variableId`, `version`, `isSecret`, `ownerScope` | `tenantVariableResolution.ts:29-45` |
| `decryptRow` — **fail-soft**, omits the row on decrypt failure | `tenantVariableResolution.ts:85-107` |
| Org-over-partner precedence, deliberate two-pass | `tenantVariableResolution.ts:181-198` |
| `findVariableTokens` / `hasVariableTokens` | `packages/shared/src/validators/variableTokens.ts:56-72` |
| `scriptParameterDefinitionsEqual` + env-collision rule — **reuse, do not reinvent** | `packages/shared/src/validators/scriptParameterDefinitions.ts` |
| `scriptNeedsVariableScope` (content tokens OR bound parameters) | `apps/api/src/services/sourcedParameters.ts:249-254` |
| Three **stale** comments claiming supervised intents are never pinned | `intentReleaseWorker.ts:356-358`, `aiAgentSdk.ts:1172-1174`, `db/schema/actionIntents.ts:163-168` |
| AsyncLocalStorage exists for DB context ONLY; `runOutsideDbContext` is per-store `.exit()` | `apps/api/src/db/index.ts:110-118` |
| Precedent for "handler needs more context": fork the registry and bypass `executeTool` (`makeSessionAwareHandler`) | `apps/api/src/services/aiAgentSdkTools.ts:493-520`; note at `aiTools.ts:174-178` |

---

## Deployment hazard — read before Task 1

Bumping the digest material invalidates **every already-approved, not-yet-released `run_script` intent**: its stored `v1` digest can never equal a `v2` recompute, so it fails `content_changed` at release.

That is the correct direction (fail closed, an operator re-approves), but it is operator-visible and must not be a surprise:

- It is bounded — only intents in `approved` state awaiting release, for one tool.
- **Do not** attempt a compatibility shim that recomputes v1 and accepts either. A dual-accept path is exactly the bypass this PR exists to close.
- Task 8 requires a release note entry and a one-line count query the operator can run before deploying:
  `SELECT count(*) FROM action_intents WHERE status='approved' AND action_name='run_script';`

---

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `apps/api/src/services/actionIntents/runScriptSnapshot.ts` | Build the verified `run_script` snapshot (script row + canonical parameter definitions + per-org variable reference metadata); produce its digest material; expose the resolved scope for reuse at dispatch. |
| `apps/api/src/services/actionIntents/runScriptSnapshot.test.ts` | Unit tests for material shape, determinism, absent/unreadable sentinels, and the no-plaintext invariant. |
| `apps/api/src/services/toolExecutionContext.ts` | The typed `ToolExecutionContext` carrier threaded from release verification into a handler. |

**Modify**

| File | Change |
|---|---|
| `apps/api/src/services/tenantVariableResolution.ts` | Distinguish unreadable from absent; expose reference metadata without values. |
| `apps/api/src/services/actionIntents/effectDigest.ts` | `run_script` resolver consumes the snapshot builder; v2 material; correct the false exclusion comment. |
| `apps/api/src/jobs/intentReleaseWorker.ts` | Carry the verified snapshot from compare to execute; fix the stale comment. |
| `apps/api/src/services/aiAgentSdk.ts` | Same for the inline path; fix the stale comment. |
| `apps/api/src/services/aiTools.ts` | Optional `ToolExecutionContext` parameter on `executeTool` and on `AiTool.handler`. |
| `apps/api/src/services/aiToolsScripts.ts` | `run_script` consumes the snapshot instead of re-querying. |
| `apps/api/src/db/schema/actionIntents.ts` | Fix the stale `effect_digest` doc comment. |

---

### Task 1: Distinguish an unreadable variable from an absent one

`decryptRow` (`tenantVariableResolution.ts:85-107`) catches, warns, returns null, and the row is omitted from the scope. Downstream that is indistinguishable from "no such key": `substituteTenantVariables` reports `no value set for {{var.k}}`, and `lookupBoundSource` reports `{kind:'missing'}`. For the digest that is unacceptable — an unreadable variable would pin as `absent`, and a later successful decrypt (key rotation fixed) would read as drift, or worse, an approval would be granted against a variable nobody can actually read.

**Files:**
- Modify: `apps/api/src/services/tenantVariableResolution.ts`
- Test: `apps/api/src/services/tenantVariableResolution.test.ts`

**Interfaces:**
- `TenantVariableScope` gains `readonly unreadableKeysByOrg: ReadonlyMap<string, ReadonlySet<string>>` (or an equivalent accessor — keep `byOrg` private, and follow the module's existing "the snapshot is opaque, `resolveForOrg` is the only sanctioned accessor" design; add `unreadableForOrg(scope, orgId): ReadonlySet<string>` with the same membership check that `resolveForOrg` performs).

- [ ] **Step 1: Write the failing tests**

In `tenantVariableResolution.test.ts`:
- A row whose decrypt throws is reported as **unreadable**, not absent, and is still omitted from the resolved value map (no placeholder value ever).
- A key that simply does not exist is **absent** and appears in neither collection.
- `unreadableForOrg` throws for an org not in the snapshot, exactly like `resolveForOrg`.
- Org-over-partner precedence is preserved: an unreadable **org** row shadows a readable partner row (the org row won the precedence pass, so the key is unreadable — it must NOT silently fall back to the partner value, which would substitute a different tenant's material).

That last case is the subtle one. Read the two-pass precedence at `:181-198` before implementing and make the behaviour explicit in a comment.

- [ ] **Step 2: Run to verify RED**, then implement, then GREEN.

Run: `pnpm --filter @breeze/api test -- src/services/tenantVariableResolution.test.ts`

- [ ] **Step 3: Sweep the consumers**

`resolveForOrg` has five callers (`scriptExecution.ts`, `automationRuntime.ts`, `aiToolsScripts.ts`, `softwareDeployment.ts`, `scriptBundle/index.ts`). This task must not change their behaviour — an unreadable variable stays a per-device failure. Only the *reporting channel* becomes distinguishable. Confirm each still compiles and its tests pass, and report any site where "unreadable" should produce a better message than today (record it; do not fix it here).

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(api): distinguish unreadable tenant variables from absent ones (#3409 PR4c-1)"
```

---

### Task 2: The `run_script` verified snapshot builder

**Files:**
- Create: `apps/api/src/services/actionIntents/runScriptSnapshot.ts`
- Create: `apps/api/src/services/actionIntents/runScriptSnapshot.test.ts`

**Interfaces:**

```ts
export type VariableReferenceState = 'present' | 'absent' | 'unreadable';

export type PinnedVariableReference = {
  orgId: string;
  key: string;
  state: VariableReferenceState;
  // present only when state === 'present' — NEVER the value
  variableId?: string;
  version?: number;
  isSecret?: boolean;
  ownerScope?: 'organization' | 'partner';
};

export type RunScriptSnapshot = {
  script: { id: string; orgId: string | null; language: string; content: string; timeoutSeconds: number; runAs: string };
  parameterDefinitions: unknown;      // canonicalized, see Step 3
  deviceOrgIds: string[];             // sorted, unique
  variableReferences: PinnedVariableReference[];  // sorted by (orgId, key)
  variableScope: TenantVariableScope; // the SAME snapshot dispatch will use
};

export async function buildRunScriptSnapshot(args, database): Promise<
  | { kind: 'snapshot'; snapshot: RunScriptSnapshot }
  | { kind: 'missing_arg' }
  | { kind: 'target_absent' }
>;

export function runScriptDigestMaterial(snapshot: RunScriptSnapshot): string;
```

- [ ] **Step 1: Write the failing tests**

`runScriptSnapshot.test.ts` — follow the existing `effectDigest.test.ts` harness exactly (hand-rolled `makeFakeDb(queue)` chainable stub, `scriptRow()` factory; **no `vi.mock` of the db module**). Required cases:

*Material content:*
- Material includes the five existing script fields, the canonical parameter definitions, and the sorted variable references.
- **Material contains no variable VALUE.** Build a snapshot whose variable value is a distinctive string and assert `runScriptDigestMaterial(...)` does not contain it. This is the single most important test in the PR — write it first.
- Material is a `v: 2` envelope, and a v1-shaped material never equals a v2 one.

*Determinism:*
- Two snapshots differing only in device-id ORDER produce identical material.
- Two snapshots differing only in variable insertion order produce identical material (sort by `(orgId, key)`).
- Two snapshots differing only in parameter-definition key order produce identical material.

*Drift sensitivity — each of these must CHANGE the material:*
- variable `version` bumped
- `isSecret` flipped **true→false** and **false→true** (both directions, separate cases)
- `variableId` changed (an org override added, shadowing a partner-wide variable — same key, same value, different id)
- a reference going `present → absent`
- a reference going `present → unreadable`
- a parameter definition's `variableKey` rebound
- a parameter definition added or removed

*Reference enumeration:*
- References are the UNION of content tokens (`findVariableTokens(script.content)`) and every parameter definition's `variableKey`.
- A script with neither yields an empty reference list and does no variable query at all.
- One reference per (org, key) pair, for every device org — the same key resolving differently in two orgs produces two entries.

*Resolver outcomes:*
- Missing `scriptId` → `missing_arg`; soft-deleted or absent script → `target_absent`, mirroring the existing resolver's `isNull(deletedAt)` filter.
- Absent `deviceIds`, or an empty array → decide and TEST one behaviour: treat as `missing_arg` (the tool schema marks `deviceIds` required). Document the choice in a comment.

- [ ] **Step 2: Verify RED, implement, verify GREEN**

Implementation notes:
- Resolve `deviceIds` → org ids with one query; sort and dedupe. A device id that does not resolve must **not** be silently dropped — that changes the reference set. Treat an unresolvable device as `target_absent`.
- Reuse `loadTenantVariableScope(orgIds)` and `resolveForOrg` / `unreadableForOrg` (Task 1). Do not write a second resolution query.
- Canonicalize parameter definitions with the existing `@breeze/shared` helper rather than a new serializer — read `scriptParameterDefinitionsEqual` and the surrounding module first and reuse its normalization. If no canonical *serializer* exists (only an equality predicate), add one **there**, beside the predicate, so the two cannot drift.
- Sorting must be explicit (`localeCompare` or codepoint — pick one, state it in a comment, and test it), not incidental.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(api): verified run_script snapshot with pinned tenant-variable references (#3409 PR4c-1)"
```

---

### Task 3: Wire the snapshot into the effect digest

**Files:**
- Modify: `apps/api/src/services/actionIntents/effectDigest.ts`
- Test: `apps/api/src/services/actionIntents/effectDigest.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend `effectDigest.test.ts` (do not create a parallel file): the `run_script` resolver now returns material built by `runScriptDigestMaterial`, still returns `missing_arg` / `target_absent` in the same conditions, and the digest changes for each drift case from Task 2.

- [ ] **Step 2: Implement**

Replace the `run_script` resolver body (`:128-152`) with a call to `buildRunScriptSnapshot` + `runScriptDigestMaterial`.

**Rewrite the comment at `:119-122`.** Its current claim — that `scripts.parameters` "has no effect on execution" because the handler passes `input.parameters` and never the column — is **false as of PR3**: the column drives `scriptNeedsVariableScope` and per-parameter `tenantVariable` bindings at `scriptDispatch.ts`. The new comment must say the column IS pinned, and why the old reasoning stopped holding, so nobody re-derives the exclusion.

Keep the resolver's existing `isNull(deletedAt)` filter and its `target_absent` semantics.

- [ ] **Step 3: Check the coverage contract**

`effectDigestCoverage.contract.test.ts` asserts every four-eyes surface either resolves or sits in a `DELIBERATELY_UNPINNED` allowlist with a written reason. Run it and confirm it still passes; if the run_script entry carries a stale reason, update it.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(api): pin parameter definitions and tenant-variable references in the run_script digest (#3409 PR4c-1)"
```

---

### Task 4: Correct the three stale "never pinned for supervised" comments

Pinning stopped being gated on `approvalScope === 'four_eyes'` on 2026-08-06, but three comments still tell the reader that a supervised intent is never pinned. Each sits directly above a branch that in fact runs for supervised intents. A future reader trusting them will conclude the branch is dead.

**Files:** `apps/api/src/jobs/intentReleaseWorker.ts:356-358`, `apps/api/src/services/aiAgentSdk.ts:1172-1174`, `apps/api/src/db/schema/actionIntents.ts:163-168`.

Comment-only. No behaviour change, no test change. Verify by reading `intentService.ts:407-408` (no scope branch) and `intentService.test.ts:823-843` (the supervised-pinning regression test) that the corrected text is true.

- [ ] **Commit**

```bash
git commit -m "docs(api): correct three stale comments claiming supervised intents are never digest-pinned"
```

---

### Task 5: The `ToolExecutionContext` carrier

**Files:**
- Create: `apps/api/src/services/toolExecutionContext.ts`
- Modify: `apps/api/src/services/aiTools.ts`
- Test: `apps/api/src/services/aiTools.executeToolGate.test.ts`

**Design — chosen deliberately; do not substitute an AsyncLocalStorage store.** ALS was considered and rejected: the inline release path verifies in `aiAgentSdk.ts` and executes later from `aiAgentSdkTools.ts`'s handler factory, coupled only through `pendingIntentBySession`, so the two are not in one async scope; and both SDK handler factories call `runOutsideDbContext` around the whole handler, so context-exit semantics are already load-bearing in this area. An explicit typed parameter is greppable and cannot silently fail to propagate.

- [ ] **Step 1: Write the failing test**

Extend `aiTools.executeToolGate.test.ts` — it already injects a synthetic probe tool into the real registry and calls the real `executeTool`, which is exactly the harness needed. Assert:
- a context passed to `executeTool` reaches the handler's third argument,
- omitting it leaves the third argument `undefined`,
- a handler declared with only `(input, auth)` still works unchanged (this is the compatibility proof for the other 188 handlers).

- [ ] **Step 2: Implement**

```ts
/**
 * Material a release path has ALREADY resolved and verified against the
 * approval's pinned digest, handed to the tool handler so it does not re-query
 * — a second read reopens the check/use window the digest exists to close.
 *
 * Deliberately narrow and deliberately explicit: not on AuthContext (which is
 * a caller identity, not an execution input), not inside `args` (which is the
 * digest's own input and is immutable on the intent row).
 */
export type ToolExecutionContext = {
  verifiedRunScript?: RunScriptSnapshot;
};
```

Widen `AiTool.handler` to `(input, auth, context?: ToolExecutionContext) => Promise<string>` and add a trailing optional `context` parameter to `executeTool`, forwarded at the `tool.handler(...)` call. Adding an optional trailing parameter is source-compatible with all 189 existing handlers.

Mirror the type widening in `packages/extension-sdk/src/server.ts` **only if** TypeScript requires it for the registry clone in `contributionRegistry.ts` to keep compiling. Extensions must not receive the snapshot — check what the clone does and keep the extension surface unchanged if it can stay unchanged; report which you did and why.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(api): explicit ToolExecutionContext channel for pre-verified release material (#3409 PR4c-1)"
```

---

### Task 6: Carry the snapshot from verification to dispatch

**Files:**
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts`, `apps/api/src/services/aiAgentSdk.ts`, `apps/api/src/services/aiToolsScripts.ts`
- Modify: `apps/api/src/services/actionIntents/effectDigest.ts` (expose a compute that returns the snapshot alongside the digest)
- Tests: `intentReleaseWorker.test.ts`, `aiAgentSdk.test.ts`, `aiToolsScripts.runScript.orgEquality.test.ts`

This is the task with real regression potential. Read all three call paths before editing.

- [ ] **Step 1: Write the failing tests**

- Durable worker: on a digest match, the snapshot produced by the recompute is passed to `executeTool` as the context; on a mismatch, `executeTool` is still never called.
- Inline SDK path: same, through whatever channel couples `aiAgentSdk.ts`'s verification to `aiAgentSdkTools.ts`'s handler invocation. **If that coupling cannot carry the snapshot without restructuring, STOP and report** — see the fallback below.
- `run_script` handler: given a context with `verifiedRunScript`, it does **not** re-query the script row and does **not** call `loadTenantVariableScope`; it uses the snapshot's script and `variableScope`. Given no context (direct chat / MCP / script-builder callers), behaviour is exactly as today.
- `aiToolsScripts.runScript.orgEquality.test.ts` asserts dispatch runs nested inside both `runOutsideDbContext` and `withSystemDbAccessContext` via flag-tracking passthroughs. Those assertions must still hold — do not restructure the escape-hatch nesting.

- [ ] **Step 2: Implement**

Add a compute variant that returns `{ digest, snapshot }` so the release path can compare the digest and keep the snapshot. Do not change `computeEffectDigest`'s existing `string | null` signature — other callers depend on it; add a sibling.

The org-equality and partner checks in the handler (`aiToolsScripts.ts:227-242`) are **security invariants and must keep running** even when a snapshot is supplied. The snapshot removes a re-*read*; it does not remove a *check*.

**Fallback if the inline path cannot carry it:** thread it on the durable worker path only, leave the inline path recomputing-and-re-querying exactly as today, and record the residual race in the ledger and the PR body. A partial fix that is honest beats a restructure of the inline chat release path inside this PR. Do not silently leave it out — if you take the fallback, say so explicitly in your report.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(api): hand the verified run_script snapshot to dispatch instead of re-querying (#3409 PR4c-1)"
```

---

### Task 7: Integration proof against real Postgres

`effectDigestToctou.integration.test.ts` already drives pin → edit → recompute-mismatch → `content_changed` against a real database, using `run_script` as its subject. Extend it — this is the only suite that proves the property end to end.

**Files:** `apps/api/src/__tests__/integration/effectDigestToctou.integration.test.ts`

- [ ] Add, each as a real-database case, mirroring the file's existing structure:
  - rotating a bound tenant variable's value (version bump) after approval → release fails `content_changed`
  - flipping `isSecret` on a bound variable **without** a version bump → fails `content_changed` *(the case that pinning version alone would miss)*
  - adding an **org override** that shadows a partner-wide variable of the same key and same value → fails `content_changed` (different `variableId`)
  - deleting a bound variable → fails `content_changed`
  - editing the script's `parameters` column → fails `content_changed` *(this is the PR3 drift bug; it must be RED before Task 3 and GREEN after)*
  - the negative mirror: an untouched script and untouched variables → releases `completed`

- [ ] Run: `pnpm --filter @breeze/api test:integration -- src/__tests__/integration/effectDigestToctou.integration.test.ts` (confirm the exact script name in `apps/api/package.json` first). Needs a live database.

- [ ] **Commit**

```bash
git commit -m "test(api): prove tenant-variable and parameter drift fails an approved release (#3409 PR4c-1)"
```

---

### Task 8: Full verification, release note, and PR

- [ ] **Step 1: Typecheck and the FULL API suite** — not just touched slices. `pnpm --filter @breeze/api test`.

- [ ] **Step 2: The contract and integration suites** — these do NOT run in the unit job, and this PR touches exactly the surface they guard:

```bash
pnpm --filter @breeze/api test -- src/services/actionIntents/effectDigestCoverage.contract.test.ts
# integration (needs a live DB):
pnpm --filter @breeze/api test:integration -- src/__tests__/integration/effectDigestToctou.integration.test.ts
```

No schema or migration changed in this PR, so the cascade/export-policy contracts are not implicated — **verify that claim** with `git diff --stat origin/main...HEAD -- apps/api/migrations apps/api/src/db/schema` and report the result rather than asserting it.

- [ ] **Step 3: Grep the no-plaintext invariant** — `runScriptDigestMaterial` and everything it calls must never touch `ResolvedVariable.value`. Show the grep output in the report.

- [ ] **Step 4: Rebase onto current main BEFORE opening the PR**, then re-run the touched slices.

- [ ] **Step 5: Release note** for the deployment hazard (see the section above): approved-but-unreleased `run_script` intents must be re-approved after deploy, with the count query.

- [ ] **Step 6: Open the PR.** Body must cover: the PR3 drift bug this fixes; that no secret is delivered yet; the v2 digest invalidation and its operator impact; and, if Task 6's fallback was taken, the residual inline-path race.

---

## Explicitly out of scope

| Item | Where it belongs |
|---|---|
| `source: 'tenantSecret'` parameter arm, `secretEnv` population, unblocking secrets | PR4c-2 |
| Capability gates at enqueue and claim | PR4c-2 |
| UI for declaring a secret parameter | PR4c-2 |
| The `softwareDeployment.ts` silent secret filter | PR4c-2 (or its own issue) |
| Better per-device messages for an unreadable variable at the five `resolveForOrg` callers | Recorded in Task 1 Step 3; own issue |
