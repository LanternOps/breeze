# Zod 3 → 4 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `zod` from `^3.24.1` to `^4` across all four workspaces (apps/api, apps/web, apps/portal, packages/shared) with zero behavior regressions.

**Architecture:** Staged migration in three PRs. PR 1 lands v3-and-v4-compatible pre-fixes plus a non-breaking `zod@^3.25` bump (de-risks the diff while still on v3 semantics). PR 2 flips the package to `zod@^4` and fixes the small, enumerable set of true hard-breaks. PR 3 is a codemod sweep that clears all deprecation warnings (string-format functions, object methods, error formatting) — including an audit that stored IDs pass v4's stricter `z.uuid()`. The split keeps the *actually-breaking* diff small and reviewable.

**Decisions (locked 2026-06-16):** Staged 2-PR rollout. The deprecation sweep (PR 3) IS in scope — do not skip it. Plan authored for handoff; execution deferred to a later session.

**Tech Stack:** Zod, TypeScript 5.5–5.9, Hono + `@hono/zod-validator`, React Hook Form + `@hookform/resolvers`, Vitest.

---

## Key Findings (why this is lower-risk than the raw counts suggest)

Researched against https://zod.dev/v4/changelog and the codebase on 2026-06-16.

**Deprecated-but-functional in v4 (NO code change required for v4 to run):**
- `.email()`, `.uuid()` (528 in api), `.url()`, `.datetime()`, `.date()` string-format methods — still work, just `@deprecated`.
- `.strict()` (59), `.passthrough()` (10) — legacy, will not be removed.
- `.merge()`, `z.nativeEnum`, `z.preprocess`, `.flatten()`, `.format()` — deprecated, still functional.
- `.default()` (896), `.catch()`, `z.coerce` (148) — runtime semantics preserved (see Task 7 for the one `.default()` edge case to audit).

These produce **TypeScript deprecation hints**, not compile errors or runtime failures. They are swept cosmetically in PR 3, NOT required for the upgrade.

**True hard-breaks (these WILL fail to compile or change behavior under v4) — full inventory:**

| Break | Sites | Where |
|---|---|---|
| `ZodError.errors` removed → use `.issues` | **7** | `eventWs.ts:419`, `desktopWs.ts:621`, `terminalWs.ts:528`, `agentWs.ts:1603,1659,1842,1847` |
| `required_error`/`invalid_type_error` removed → `error` param | **7** | `config/validate.ts:330,367,381,385`; web `OrganizationForm.tsx:16`, `AlertRuleForm.tsx:31`, `ScriptFormSchema.ts:39` |
| single-arg `z.record(V)` removed → `z.record(z.string(), V)` | **~121** | repo-wide, mechanical (see Task 4) |
| `.ip()` / `.cidr()` removed | **0** | none found — no work |
| `.transform().default()` output-type behavior change | **0 same-chain** | none found on a single chain; Task 7 confirms |

**Dependency tree is already v4-ready:**
- `@hookform/resolvers ^5.4.0` — supports zod 4 since 5.2.2. ✅
- `@hono/zod-validator ^0.8.0` — latest; supports zod `^3.25 || ^4`. Verify peer range in Task 1.
- `@anthropic-ai/sdk ^0.96.0` — peers `zod@3.25.76`, compatible with both. ✅
- TypeScript ≥5.5 in every workspace (zod 4 requires ≥5.5). ✅

**Import style:** 217× `import { z } from 'zod'`; no `zod/v3` or `zod/v4` subpath imports anywhere. After PR 2 the bare `zod` specifier resolves to v4 — no import rewrites needed.

---

## Strategy decision (read before executing)

This plan uses the **staged direct flip** (recommended). Two alternatives were considered and rejected:

- **Big-bang** (one PR: bump to `^4` + fix everything): viable because the hard-break set is small, but mixes the mechanical `z.record` churn with the dependency bump in one diff. Rejected for reviewability.
- **Incremental `zod/v4` subpath** (migrate file-by-file off the `zod/v4` export, flip package last): Zod's official slow path. Rejected because it touches every import twice for no benefit here — our hard-break surface is already enumerable and small.

If the reviewer prefers big-bang, collapse PR 1 + PR 2 into one. The tasks are otherwise identical.

---

## PR 1 — Compatible pre-fixes + `zod@^3.25` bump (non-breaking, stays on v3)

Everything in PR 1 compiles and behaves identically on zod 3.25 AND zod 4. Goal: shrink PR 2's breaking diff to near-zero and confirm the dependency tree resolves.

### Task 1: Bump zod to `^3.25` and verify ecosystem peers

**Files:**
- Modify: `apps/api/package.json:73`, `apps/portal/package.json:26`, `apps/web/package.json:50`, `packages/shared/package.json:20`

- [ ] **Step 1: Confirm `@hono/zod-validator` peer range accepts zod 4**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npm view @hono/zod-validator@0.8.0 peerDependencies
```
Expected: a `zod` range that includes `^4` (e.g. `"zod": "^3.25.0 || ^4.0.0"`). If it does NOT include `^4`, STOP and find the lowest `@hono/zod-validator` version that does (`npm view @hono/zod-validator versions`) — record it; it becomes a bump in Task 8.

- [ ] **Step 2: Confirm resolvers already supports zod 4**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npm view @hookform/resolvers@5.4.0 peerDependencies
```
Expected: `zod` peer includes `^4`. (5.2.2+ supports it; 5.4.0 is fine.) No action if true.

- [ ] **Step 3: Bump the four `zod` specifiers to `^3.25.0`**

Change `"zod": "^3.24.1"` → `"zod": "^3.25.0"` in all four package.json files listed above. (3.25 is the last v3 minor; it ships the `zod/v4` subpath but keeps v3 as the default export, so behavior is unchanged.)

- [ ] **Step 4: Reinstall and verify the lockfile resolves a single zod**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm why zod | head -40
```
Expected: install succeeds; `pnpm why zod` shows a 3.25.x resolution with no unmet-peer warnings for `@hono/zod-validator` or `@hookform/resolvers`.

- [ ] **Step 5: Full typecheck + test (baseline must stay green)**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm -r typecheck
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm test --filter=@breeze/shared
```
Expected: PASS. (Per memory: the full api `vitest run` is flaky in parallel — verify api changes per-file with single-fork, don't gate on the whole suite here.)

- [ ] **Step 6: Commit**

```bash
git add apps/*/package.json packages/shared/package.json pnpm-lock.yaml
git commit -m "chore(deps): bump zod to ^3.25 (ships zod/v4 subpath, v3 default)"
```

### Task 2: Replace removed `ZodError.errors` with `.issues` (7 sites)

`.issues` exists in BOTH v3 and v4; `.errors` is removed in v4. Safe to land now. **Do not touch the unrelated `result.errors` / `parsed.errors` hits** in `logForwardingWorker.ts`, `s3Storage.ts`, `binarySync.ts`, `pushoverSender.ts`, notification-sender tests, `password.test.ts` — those are custom result objects, not `ZodError`.

**Files:**
- Modify: `apps/api/src/routes/eventWs.ts:419`
- Modify: `apps/api/src/routes/desktopWs.ts:621`
- Modify: `apps/api/src/routes/terminalWs.ts:528`
- Modify: `apps/api/src/routes/agentWs.ts:1603, 1659, 1842, 1847`

- [ ] **Step 1: Edit each site, `.error.errors` → `.error.issues`**

Exact replacements (the `.issues` array has the same `{ message, path, ... }` shape used here):
- `eventWs.ts:419` — `parsed.error.errors[0]?.message` → `parsed.error.issues[0]?.message`
- `desktopWs.ts:621` — `parsed.error.errors` → `parsed.error.issues`
- `terminalWs.ts:528` — `parsed.error.errors` → `parsed.error.issues`
- `agentWs.ts:1603` — `parsed.error.errors[0]?.message` → `parsed.error.issues[0]?.message`
- `agentWs.ts:1659` — `fastPathParse.error.errors[0]?.message` → `fastPathParse.error.issues[0]?.message`
- `agentWs.ts:1842` — `parsed.error.errors` → `parsed.error.issues`
- `agentWs.ts:1847` — `details: parsed.error.errors` → `details: parsed.error.issues`

- [ ] **Step 2: Verify no Zod `.error.errors` remain**

```bash
grep -rn '\.error\.errors\b' apps/api/src apps/web/src apps/portal/src packages/shared/src --include='*.ts' --include='*.tsx'
```
Expected: no output (zero matches).

- [ ] **Step 3: Typecheck the touched files' workspace**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec tsc --noEmit
```
Expected: PASS (no new errors vs. the known pre-existing `agents.test.ts` / `apiKeyAuth.test.ts` baseline noted in CLAUDE.md memory).

- [ ] **Step 4: Run the affected route tests (single-fork)**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec vitest run src/routes/agentWs src/routes/terminalWs src/routes/desktopWs src/routes/eventWs --no-file-parallelism
```
Expected: PASS (or unchanged from a pre-edit baseline if any are pre-existing failures).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/eventWs.ts apps/api/src/routes/desktopWs.ts apps/api/src/routes/terminalWs.ts apps/api/src/routes/agentWs.ts
git commit -m "refactor(api): use ZodError.issues instead of removed .errors alias"
```

### Task 3: Add explicit key schema to single-arg `z.record()` (~121 sites)

`z.record(z.string(), V)` is valid in BOTH v3 and v4; single-arg `z.record(V)` is removed in v4. The transform is uniform: prepend `z.string(), ` as the key schema. **Two-arg calls already present (e.g. `z.record(z.string(), z.unknown())` in `queueSchemas.ts:125`, `userRisk.ts`, `orgs.ts`) must NOT be double-edited.**

**Files:** repo-wide. The matches are `z.record(z.unknown())`, `z.record(z.any())`, `z.record(z.string())`, `z.record(z.number()...)`, `z.record(z.boolean())`. Known clusters: `apps/api/src/routes/analytics.ts`, `psa.ts`, `scripts.ts`, `monitors.ts`, `software.ts`, `updateRings.ts`, `webhooks.ts`, `deployments.ts`, `incidents.validation.ts`, `playbooks.ts`, `approvals.ts`, `browserSecurity.ts`, `mobile.ts`, `auditBaselines.ts`, `db/schema/cisHardening.ts`, plus shared/web/portal.

- [ ] **Step 1: Enumerate every single-arg call**

```bash
grep -rEn 'z\.record\(z\.(unknown|any|string|number|boolean)\([^)]*\)\)' apps/api/src apps/web/src apps/portal/src packages/shared/src --include='*.ts' --include='*.tsx'
```
This regex matches ONLY single-arg forms (the value schema's `)` is immediately followed by the `record` closing `)`). Two-arg calls contain a `,` and are excluded. Expected: ~121 lines.

- [ ] **Step 2: Apply the uniform transform**

For every matched line, insert `z.string(), ` as the first argument:
- `z.record(z.unknown())` → `z.record(z.string(), z.unknown())`
- `z.record(z.any())` → `z.record(z.string(), z.any())`
- `z.record(z.string())` → `z.record(z.string(), z.string())`
- `z.record(z.number().min(0))` → `z.record(z.string(), z.number().min(0))`
- `z.record(z.boolean())` → `z.record(z.string(), z.boolean())`

Do this per-file with `Edit` (preferred over a blanket `sed`, so each diff is reviewed). For files with many identical `z.record(z.unknown())` occurrences, use `Edit` with `replace_all: true` scoped to that file.

- [ ] **Step 3: Verify zero single-arg calls remain**

```bash
grep -rEn 'z\.record\(z\.(unknown|any|string|number|boolean)\([^)]*\)\)' apps/api/src apps/web/src apps/portal/src packages/shared/src --include='*.ts' --include='*.tsx'
```
Expected: no output.

- [ ] **Step 4: Typecheck all workspaces**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm -r typecheck
```
Expected: PASS. (Inferred types are identical — `Record<string, V>` either way — so no downstream type fallout.)

- [ ] **Step 5: Run shared validator tests (filters/index use records)**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm test --filter=@breeze/shared
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: add explicit string key schema to z.record() calls (v4-required)"
```

### Task 4: Open PR 1

- [ ] **Step 1: Push branch and open PR**

```bash
git push -u origin HEAD
gh pr create --title "chore: zod 3.25 bump + v4-compatible pre-fixes (1/2)" \
  --body "Stage 1 of the Zod 3→4 upgrade. Non-breaking on zod 3.25 (v3 semantics retained). Lands the pre-fixes that are valid on both v3 and v4 so the actual v4 flip (PR 2) has a minimal breaking diff: ZodError.issues (was removed .errors), explicit z.record() key schemas. No runtime behavior change. Plan: docs/superpowers/plans/platform-ci/2026-06-16-zod-3-to-4-upgrade.md"
```

- [ ] **Step 2: Wait for CI green, then merge per repo convention**

Gate on the required checks (Test API/Web/Agent, Integration, Type Check) per memory — `mergeable=MERGEABLE` alone is insufficient. Then:
```bash
gh pr merge --squash --admin
```

---

## PR 2 — Flip to `zod@^4` and fix v4-only hard-breaks

### Task 5: Bump zod to `^4` and reinstall

**Files:**
- Modify: `apps/api/package.json`, `apps/portal/package.json`, `apps/web/package.json`, `packages/shared/package.json`

- [ ] **Step 1: Change all four `zod` specifiers `^3.25.0` → `^4`**

- [ ] **Step 2: Reinstall**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm why zod | head -40
```
Expected: a single zod 4.x resolution; no unmet peer warnings. If `@hono/zod-validator` warns, bump it to the version recorded in Task 1 Step 1 now.

- [ ] **Step 3: Typecheck to surface the full v4 break list**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm -r typecheck 2>&1 | tee /tmp/zod4-typecheck.log
```
Expected: errors ONLY at the `required_error`/`invalid_type_error` sites (Task 6) plus possibly `z.coerce` input-type fallout (Task 7). The pre-fixes from PR 1 mean `z.record`/`.errors` produce no errors here. Keep `/tmp/zod4-typecheck.log` as the worklist. Do NOT commit yet.

### Task 6: Replace removed `required_error` / `invalid_type_error` with `error` (7 sites)

In v4 the constructor params collapse into a single `error`. For a missing-vs-wrong-type distinction, `error` accepts a function receiving the issue. For these sites a plain string message is the intended behavior in all 7 cases.

**Files:**
- Modify: `apps/api/src/config/validate.ts:330, 367, 381, 385`
- Modify: `apps/web/src/components/settings/OrganizationForm.tsx:16`
- Modify: `apps/web/src/components/alerts/AlertRuleForm.tsx:31`
- Modify: `apps/web/src/components/scripts/ScriptFormSchema.ts:39`

- [ ] **Step 1: config/validate.ts — 4 `required_error` → `error`**

- `:330` `z.string({ required_error: 'DATABASE_URL is required' })` → `z.string({ error: 'DATABASE_URL is required' })`
- `:367` `z.string({ required_error: 'JWT_SECRET is required' })` → `z.string({ error: 'JWT_SECRET is required' })`
- `:381` `z.string({ required_error: 'APP_ENCRYPTION_KEY is required' })` → `z.string({ error: 'APP_ENCRYPTION_KEY is required' })`
- `:385` `z.string({ required_error: 'MFA_ENCRYPTION_KEY is required' })` → `z.string({ error: 'MFA_ENCRYPTION_KEY is required' })`

> Note on semantics: v3 `required_error` fired only on `undefined`/missing; v4 `error: string` covers both missing and wrong-type with the same message. For these env-var validators (a value is either a present string or absent) the message reads correctly in both cases. No behavior regression.

- [ ] **Step 2: Three web form schemas — `invalid_type_error` → `error`**

- `OrganizationForm.tsx:16` `z.number({ invalid_type_error: 'Enter a max device limit' })` → `z.number({ error: 'Enter a max device limit' })`
- `AlertRuleForm.tsx:31` `z.number({ invalid_type_error: 'Enter a cooldown value' })` → `z.number({ error: 'Enter a cooldown value' })`
- `ScriptFormSchema.ts:39` `z.number({ invalid_type_error: 'Enter a timeout value' })` → `z.number({ error: 'Enter a timeout value' })`

- [ ] **Step 3: Verify none remain**

```bash
grep -rn 'required_error\|invalid_type_error' apps/api/src apps/web/src apps/portal/src packages/shared/src --include='*.ts' --include='*.tsx'
```
Expected: no output.

- [ ] **Step 4: Typecheck config + web**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec tsc --noEmit
```
Expected: PASS (those error sites gone from the log).

- [ ] **Step 5: Run config validation tests**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec vitest run src/config/validate --no-file-parallelism
```
Expected: PASS. Confirm the error-message assertions still match the new `error`-param output (Zod emits the custom string identically).

### Task 7: Audit `.default()` output-type change and `z.coerce` fallout

v4 change: `.default(v)` short-circuits parsing and `v` must match the **output** type. A chain like `z.string().transform(s => s.length).default("x")` (default typed as input) breaks — the v3-equivalent is now `.prefault("x")`. Repo grep found **no same-chain `.transform().default()`**, so this is a confirm-clean step, not a fix step.

**Files:** worklist from `/tmp/zod4-typecheck.log` (any residual errors after Task 6).

- [ ] **Step 1: Confirm no transform→default chains broke**

```bash
grep -rEn '\.transform\([^;]*\)\s*\.default\(' apps/api/src packages/shared/src --include='*.ts'
grep -rEn '\.default\([^;]*\)\s*\.transform\(' apps/api/src packages/shared/src --include='*.ts'
```
Expected: no output. If any appear, change `.default(x)` → `.prefault(x)` ONLY where the default value is an input-type value feeding a transform (preserves v3 behavior).

- [ ] **Step 2: Resolve any remaining typecheck errors in the log**

Re-read `/tmp/zod4-typecheck.log` after Task 6. The likely residual category is `z.coerce.*` where v4 widens the input type to `unknown` — usually a no-op at the call sites (Hono passes `string`/`unknown` already). Fix any genuine type errors at their source; do not add `as any`.

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm -r typecheck
```
Expected: PASS across all workspaces.

### Task 8: Full verification gate

- [ ] **Step 1: Lint + typecheck everything**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm -r typecheck
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm -r lint
```
Expected: PASS.

- [ ] **Step 2: Shared + web unit suites**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm test --filter=@breeze/shared
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm test --filter=@breeze/web
```
Expected: PASS. Web covers the `@hookform/resolvers`/`zodResolver` integration on v4 — the highest-value runtime check for the form schemas touched in Task 6.

- [ ] **Step 3: API integration + RLS suites (real DB)**

The `@hono/zod-validator` middleware runs on every API route, so a green integration run is the proof that request validation still works under v4. Per CLAUDE.md, real-DB tests live in `src/__tests__/integration/*.integration.test.ts` and run via the Integration Tests job (`workflow_dispatch`), which is the only job exercising RLS forge + tenantCascade.

```bash
# locally, with a real DB available (see CLAUDE.md "Running Tests Locally")
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts --no-file-parallelism
```
Expected: PASS. If no local DB, rely on the CI Integration Tests job — force it after push with `gh workflow run ci.yml --ref <branch>` (per memory, the pull_request trigger sometimes drops Integration Tests).

- [ ] **Step 4: Smoke a Hono-validated endpoint end-to-end**

Start the API and POST a deliberately-invalid body to a `zValidator`-guarded route; confirm the 400 response shape is unchanged (the error body is built from `.issues`, fixed in PR 1).

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm dev   # in one shell
# in another: hit a known validated route with a bad payload and inspect the 400 JSON
```
Expected: 400 with the same validation-error JSON structure as before the upgrade.

- [ ] **Step 5: Commit PR 2**

```bash
git add -A
git commit -m "chore(deps): upgrade zod to v4

- bump zod ^3.25 -> ^4 in all four workspaces
- required_error/invalid_type_error -> error param (7 sites)
- confirm no .transform().default() output-type regressions
- z.record key schemas + ZodError.issues already landed in PR 1"
```

- [ ] **Step 6: Open and merge PR 2**

```bash
git push -u origin HEAD
gh pr create --title "chore: upgrade zod to v4 (2/2)" \
  --body "Stage 2: flips zod to ^4 and fixes the v4-only hard-breaks (required_error/invalid_type_error -> error). Builds on the pre-fixes in PR 1. Full typecheck + shared/web unit + API integration/RLS suites green. Plan: docs/superpowers/plans/platform-ci/2026-06-16-zod-3-to-4-upgrade.md"
```
Gate on required checks (Test API/Web/Agent, Integration, Type Check) before `gh pr merge --squash --admin`.

---

## PR 3 — Deprecation sweep (in scope)

Clears all `@deprecated` TS hints so the codebase is idiomatic v4. Do it **per workspace, one commit each**, to keep diffs reviewable. A community codemod exists (`zod-v3-to-v4` / `npx zod-v4-codemod`) but **review every change** — it rewrites refine error args and is imperfect. Land this after PR 2 is merged and green.

### Task 9: Audit stored IDs against v4's stricter `z.uuid()` (do FIRST)

v4 `z.uuid()` enforces RFC 9562/4122 (version + variant bits); v3 accepted any 8-4-4-4-12 hex shape. If any ID column holds a non-RFC value (e.g. a hand-seeded `00000000-...`, a nil UUID, or a non-versioned token), switching `.uuid()` → `z.uuid()` will start rejecting it. `z.guid()` is the lenient v4 escape hatch that matches v3 `.uuid()` behavior.

**Files:** read-only audit; informs Task 10.

- [ ] **Step 1: Check what the DB actually stores**

```bash
# against a real DB (see CLAUDE.md "Running Tests Locally" / memory infra notes)
# sample a few high-traffic id columns for non-RFC-4122 values:
#   SELECT id FROM devices WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' LIMIT 20;
# repeat for organizations, users, sites, and any column validated with .uuid() on a request path.
```
Expected: zero non-conforming rows. **If any column has them**, that schema's validator stays `z.guid()` (not `z.uuid()`) in Task 10 Step 1 — note which.

- [ ] **Step 2: Flag system/sentinel UUIDs in code**

```bash
grep -rn "00000000-0000-0000-0000-000000000000\|nil uuid\|NIL_UUID" apps/api/src packages/shared/src --include='*.ts'
```
Expected: any hits identify schemas that must use `z.guid()`. Record them.

### Task 10: Sweep deprecated forms (per workspace, one commit each)

- [ ] **Step 1: String formats → top-level functions**
  - `.email()` → `z.email()` (21 api + 5 shared + 1 web)
  - `.uuid()` → `z.uuid()` (528 api + 82 shared) — biggest bucket; codemod then verify. **Use `z.guid()` instead for any schema flagged in Task 9.**
  - `.url()` → `z.url()`; `.datetime()` → `z.iso.datetime()`; `.date()` → `z.iso.date()`

- [ ] **Step 2: Object methods**
  - `.strict()` → `z.strictObject({...})`; `.passthrough()` → `z.looseObject({...})`
  - `.merge(B)` → `.extend(B.shape)` or `{ ...A.shape, ...B.shape }`
  - `z.nativeEnum(E)` → `z.enum(E)`

- [ ] **Step 3: Error formatting**
  - `.flatten()` → `z.treeifyError()` / `.format()` → `z.treeifyError()` where touched (only if cleaning these up; they still work).

- [ ] **Step 4: After each workspace, `pnpm --filter=<ws> typecheck` + that workspace's test suite must stay green; commit per workspace.**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm -r typecheck
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm -r test
```
Expected: PASS, and `git grep` for the deprecated forms returns progressively fewer hits.

---

## Rollback

Each PR is an independent squash commit. To revert: `git revert <sha>` of PR 2 restores zod 3.25 behavior instantly (PR 1's pre-fixes are v3-compatible, so they need not be reverted). PR 1 alone is a pure no-op on v3 and safe to leave in place.
