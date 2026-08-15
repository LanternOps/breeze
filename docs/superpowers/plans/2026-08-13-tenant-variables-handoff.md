# Tenant Variables (#3409) — Session Handoff

**Written:** 2026-08-13 · **Worktree:** `scripts-custom-variables` · **Status at handoff:** PR0/1/2 merged, unreleased

---

## 1. Where the initiative stands

| PR | What it delivered | State |
|---|---|---|
| **PR0** — #3418 + #3438 | Extracted reusable `services/scriptDispatch.ts`; all 5 dispatch sites became thin callers | Merged |
| **PR1** — #3494 (`da6a8efe9`) | `tenant_variables` table, CRUD, `variables:read`/`variables:manage`, Settings → Variables UI, 7 locales | Merged |
| **PR2** — #3495 (`2e7ee0621`) | `{{var.*}}` resolution per device at dispatch, editor picker, per-device failure channel | Merged |
| **PR3** | Sourced script parameters (`source: runtime \| tenantVariable \| deviceCustomField \| builtin`) | **Not started — this is next** |
| **PR4** | Secret delivery (`BREEZE_VAR_*` / `secretEnv`), agent changes, redaction, effect-digest pinning | Not started |

All merges are green on `main`, confirmed including the `Smoke Test` job that only runs on main (real Docker build + stack boot with both migrations applied).

**Not in any release.** Latest tags are `v0.105.2`; PR0/1/2 all land in the next cut (0.106.0). Main has moved ~8 commits past our merge — rebase before starting PR3.

---

## 2. Release notes owed for 0.106.0

These are behaviour changes for **existing** users, not new features. They are the highest-risk part of what shipped.

**Script parameters are now strictly validated and canonicalized to strings.** One shared `scriptParametersSchema` is enforced at `routes/scripts.ts`, `routes/mobile.ts`, and `automationRuntime.ts`. Now rejected: `null`, objects, arrays, `NaN`, `Infinity`, and keys the agent can't turn into an env var name (`has space`, `a.b`, `a=b`). Caps: 64 parameters, 4096 chars/value. Numbers and booleans are now accepted and coerced to strings.

This *fixes* a silent pre-existing outage — the wire type is `map[string]string` and the agent silently dropped every non-string value, so a number/boolean parameter left `{{name}}` verbatim in the script and never set `BREEZE_PARAM_*`. But callers sending malformed parameters now get a hard validation error instead of a silent drop.

> **The surprising one:** `normalizeAutomationActions` runs at **runtime** against **stored** automation actions. So an automation nobody has edited can start failing loudly after upgrade. Call this out explicitly — it is the item most likely to generate support load.

Also worth a line:
- Script fan-out no longer aborts on the first per-device failure; failing devices get a `script_executions` row with `status:'failed'` and count toward `devicesFailed`.
- Content containing a strictly-well-formed `{{var.<key>}}` is no longer passed through verbatim — it substitutes, or the device fails with `unresolved_variables`. (`${{var.x}}` and whitespace forms are unaffected.)
- Saving/importing a script referencing a **secret** variable is now a 400.
- PR1's migration grants `variables:read` + `variables:manage` to every existing **system** `Org Admin` role.

---

## 3. Known-open items (deliberately not fixed)

Recorded so they aren't rediscovered as bugs:

1. **`scriptDispatch.ts` canonicalizes unvalidated values on untouched ingresses.** `aiToolsScripts`, `aiAgentSdkTools`, `scriptBuilderTools`, `remediationSuggestions` don't run the strict schema, so `String({})` ships `"[object Object]"` where the agent previously dropped it. Asymmetric with the validated routes.
2. **Parameter *definitions* are still `z.any()`** while execution is strict — a script defining `app.mode` or `Log Level` now 400s at run time with no migration path. Compounds with the hyphen collision: `log-level` and `log_level` both map to `BREEZE_PARAM_LOG_LEVEL`, and Go map order decides the winner.
3. **PUT scope-change secret gate** — not tightened.
4. **`loadTenantVariableScope` is per-device in `automationRuntime`** → N connection acquisitions for an N-device automation, where `scriptExecution` does 1. Hoisting it is a contained perf win.
5. **Four-eyes effect digest is not extended.** It hashes `scripts.content` (the template) at both pin and release, so a variable's *value* changing between approval and release does not invalidate the digest. **PR4 must close this** — it's the security-relevant one.
6. **`userhelper/client.go` drops parameters entirely for `runAs:'user'`** — pre-existing, needs a helper IPC change, PR4 territory.

---

## 4. Mechanics learned the hard way (read before opening PR3)

**Rebase a days-old branch onto `main` *before* opening the PR, not after CI goes green.** Both PR1 and PR2 were cut before the Workspace-ee merge (`cfa16d03a`) and were honestly green on that base. Rebasing surfaced a real break that would have gone green on the PR and then reddened main.

**Root-mounted routers need hand-registered namespaces.** `api.route('/', xRoutes)` is invisible to the extension guard's namespace derivation, so an extension could claim that segment and shadow core endpoints. Four places, all in the same PR:
1. `RESERVED_ROUTE_NAMESPACES` in `packages/extension-sdk/src/manifest.ts`
2. `RESERVED_ROUTE_NAMESPACES` in `packages/extension-api/src/legacy.ts` — **a separate copy**; one alone is still hijackable via the other code path
3. the pinned `rootMounts` list in `packages/extension-api/src/index.test.ts` (+ its comment block)
4. the `it.each` reserves-and-rejects list in the same file

Fails as CI step **"Test legacy extension adapter"** inside the **Test API** job. The error names `src/index.test.ts`, which is the *extension-api package's* file — `apps/api/src/index.test.ts` does not exist. Repro: `pnpm --filter @breeze/extension-api test` (~300ms).

**Stacked-PR CI.** A PR targeting a sibling branch gets **no CI at all** while `gh pr checks` reads green. Either dispatch per branch (`gh workflow run CI --ref <branch>`) or, better, retarget the base to `main` **first** and *then* force-push — the push fires a real `pull_request` run; changing the base alone does not.

**After a parent squash-merge, restack with `git rebase --onto <new-main> <old-parent-tip> <branch>`** — never hand-resolve. Verify three ways rather than trusting the exit code: commit count, distance behind main (`rev-list --count branch..origin/main` must be 0), and that the parent's files are **absent** from the child's diff (proving the squashed content was absorbed, not duplicated).

**Local full-suite runs:** don't pipe through `tail` — you lose all progress visibility and can't distinguish "slow" from "wedged". `NODE_OPTIONS=--max-old-space-size=8192` is required for API typecheck locally (known OOM, not a regression). And don't launch `sleep N && check` as a *background* task then poll immediately — you get an instant snapshot, not a delayed one.

---

## 5. Starting PR3

Plan docs for the shipped work (useful as shape references):
- `docs/superpowers/plans/2026-08-11-pr1-tenant-variables.md`
- `docs/superpowers/plans/2026-08-11-pr2-tenant-variable-resolution.md`

PR3 scope from the original breakdown: **sourced parameters** — a script parameter declares where its value comes from (`runtime | tenantVariable | deviceCustomField | builtin`) rather than always being caller-supplied.

Design constraints inherited from PR2 that PR3 must respect:
- Resolution must reuse the **scope snapshot** pattern: `runOutsideDbContext(() => withSystemDbAccessContext(...))` — **both** wrappers. A bare system context nested in a held org-scoped request txn does not elevate, and org tokens without a `partnerId` see zero partner-wide rows.
- The snapshot carries its org set; `resolveForOrg` throws for an org outside it (TOCTOU guard).
- Substitution belongs at the single `scriptDispatch.ts` chokepoint, gated so token-free scripts stay allocation- and query-free.
- **Secrets stay blocked until PR4.** PR3 must not open a textual path for a secret value.
- Item 2 in §3 (definitions still `z.any()`) is naturally PR3's problem — sourced parameters means definitions gain real structure. Fixing the definition schema and the hyphen collision fits here.

Per repo convention, convene the advisor quorum (own position + `codex exec` read-only `xhigh`) before implementing — sourced parameters is a cross-module contract and a public API surface change.

---

## 6. Verification commands

```bash
# Targeted (fast)
pnpm --filter @breeze/shared test
pnpm --filter @breeze/extension-api test          # the namespace guard
cd apps/api && pnpm exec vitest run src/routes/scripts.test.ts

# Typecheck (needs the heap bump locally)
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit

# Contract suites — NOT covered by `pnpm test`; run when touching tenancy/cascade
# (need a live DB; see the fsync=off tmpfs note in memory)
```

`pnpm test` misses the RLS/integration contract suites entirely — local green ≠ CI green. Integration Tests blocks PRs and runs in 4 shards.
