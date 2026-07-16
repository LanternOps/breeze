# API Test Stability Implementation Plan

> **For Codex:** Execute this plan task-by-task with test-driven development. Keep these changes in commits separate from the Security & Compliance Posture report commits so they can be split into a follow-up if desired.

**Goal:** Eliminate the seven API-suite timeout failures by removing repeated heavy module initialization and a filesystem-wide synchronous scan from the affected tests.

**Architecture:** Preserve production behavior while making dependency boundaries explicit. Move the backup threshold to a dependency-free constants module, enforce the validator import rule through ESLint, and make route tests import each route graph once with hoisted mutable mock state instead of resetting Vitest's module registry for every case. Keep the OAuth-disabled mount assertion in an isolated test module so its environment configuration remains deterministic.

**Tech Stack:** TypeScript, Vitest, Hono, ESLint flat config, pnpm.

---

## Global constraints

- Do not increase test timeouts as the fix.
- Do not weaken assertions or replace the real guardrail/RBAC units under test with mocks.
- Mock only unrelated heavy leaves such as the schema barrel, AI tool registry, Sentry logging, database client, and authentication middleware.
- Reset mutable mock state and call history between tests; do not call `vi.resetModules()` in the stabilized files.
- Keep all report implementation commits intact; create separate stabilization commits.

### Task 1: Replace the synchronous validator import scan with ESLint

**Files:**
- Modify: `apps/api/eslint.config.js`
- Delete: `apps/api/src/lib/validation.imports.test.ts`

**Step 1: Demonstrate the missing lint enforcement**

Run:

```bash
printf '%s\n' "import { zValidator } from '@hono/zod-validator';" | pnpm --filter @breeze/api exec eslint --stdin --stdin-filename src/routes/__validator_guard_probe.ts
```

Expected before the change: exit 0, proving ESLint does not yet enforce the invariant.

**Step 2: Add the flat-config rule**

Add a production-source config entry after the parser entry:

```js
{
  files: ['src/**/*.ts'],
  ignores: ['src/**/*.test.ts', 'src/lib/validation.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@hono/zod-validator',
            message: 'Import zValidator from src/lib/validation instead.',
          },
        ],
      },
    ],
  },
},
```

Delete the recursive Vitest scanner. The required lint job now performs the same invariant check while it is already parsing source files.

**Step 3: Verify forbidden and allowed cases**

Run the forbidden import and re-export probes and expect non-zero exits:

```bash
printf '%s\n' "import { zValidator } from '@hono/zod-validator';" | pnpm --filter @breeze/api exec eslint --stdin --stdin-filename src/routes/__validator_guard_probe.ts
printf '%s\n' "export { zValidator } from '@hono/zod-validator';" | pnpm --filter @breeze/api exec eslint --stdin --stdin-filename src/routes/__validator_guard_probe.ts
```

Run the wrapper and test exemptions and expect exit 0:

```bash
printf '%s\n' "import { zValidator } from '@hono/zod-validator';" | pnpm --filter @breeze/api exec eslint --stdin --stdin-filename src/lib/validation.ts
printf '%s\n' "import { zValidator } from '@hono/zod-validator';" | pnpm --filter @breeze/api exec eslint --stdin --stdin-filename src/routes/__validator_guard_probe.test.ts
```

Then run:

```bash
pnpm --filter @breeze/api lint
```

**Step 4: Commit**

```bash
git add apps/api/eslint.config.js apps/api/src/lib/validation.imports.test.ts
git commit -m "test(api): move validator import guard to eslint"
```

### Task 2: Decouple metrics from backup verification startup

**Files:**
- Create: `apps/api/src/routes/backup/constants.ts`
- Modify: `apps/api/src/routes/backup/verificationService.ts`
- Modify: `apps/api/src/routes/metrics.ts`
- Modify: `apps/api/src/routes/metrics.test.ts`

**Step 1: Capture the current timeout**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/routes/metrics.test.ts --fileParallelism=false --maxWorkers=1
```

Expected before the change: the first hooks exceed their 10-second limit because importing `metrics.ts` loads `verificationService.ts` and its command/remote-session graph.

**Step 2: Extract the shared constant**

Create `constants.ts`:

```ts
export const BACKUP_LOW_READINESS_THRESHOLD = 70;
```

Import and re-export that symbol from `verificationService.ts` so existing consumers keep working:

```ts
import { BACKUP_LOW_READINESS_THRESHOLD } from './constants';
export { BACKUP_LOW_READINESS_THRESHOLD } from './constants';
```

Change `metrics.ts` to import the threshold directly from `./backup/constants`.

**Step 3: Give the DB mock a benign default select chain**

In `metrics.test.ts`, use a stable `selectMock` reference and, after `vi.clearAllMocks()`, restore a default query builder that resolves to `[{ count: 0 }]`. Per-test `mockReturnValueOnce` trend builders must continue to take precedence. This keeps the metrics scrape's backup-gauge refresh from throwing and printing caught stack traces.

**Step 4: Verify**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/routes/metrics.test.ts --fileParallelism=false --maxWorkers=1
pnpm --filter @breeze/api exec vitest run src/routes/backup/verificationService.test.ts --fileParallelism=false --maxWorkers=1
```

Expected: both files pass without hook timeouts or `undefined.from` backup-gauge errors.

**Step 5: Commit**

```bash
git add apps/api/src/routes/backup/constants.ts apps/api/src/routes/backup/verificationService.ts apps/api/src/routes/metrics.ts apps/api/src/routes/metrics.test.ts
git commit -m "test(api): lighten metrics route initialization"
```

### Task 3: Import the OAuth interaction route once

**Files:**
- Modify: `apps/api/src/routes/oauthInteraction.test.ts`
- Create: `apps/api/src/routes/oauthInteraction.disabled.test.ts`

**Step 1: Capture the current timeout**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/routes/oauthInteraction.test.ts --fileParallelism=false --maxWorkers=1
```

Expected before the change: initial tests time out while `loadApp()` resets and reimports the full OAuth graph; the abandoned import later consumes one-shot DB mocks.

**Step 2: Stabilize the enabled-route test module**

- Mock `../oauth/log` with inert `logOAuthEvent` / error logging functions so the route test does not load Sentry.
- Mock `../config/env` with the real exports plus deterministic OAuth values and a live `BILLING_URL` getter backed by mutable hoisted state.
- Import `oauthInteractionRoutes` once after the mocks.
- Make `loadApp()` synchronously construct the Hono app from that imported route; remove `vi.resetModules()` and its `enabled` parameter.
- Reset the mutable billing URL and all queued DB implementations in `beforeEach`.

**Step 3: Isolate disabled configuration**

Move the “does not mount routes when MCP_OAUTH_ENABLED is false” assertion to `oauthInteraction.disabled.test.ts`. In that file, mock `../config/env` with `MCP_OAUTH_ENABLED: false`, mock unrelated heavy leaves, import the route once, and assert the route is absent. This avoids switching import-time configuration inside a shared module cache.

**Step 4: Verify**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/routes/oauthInteraction.test.ts src/routes/oauthInteraction.disabled.test.ts --fileParallelism=false --maxWorkers=1
```

Expected: all cases pass under their existing timeouts and no later test observes a DB queue consumed by an abandoned import.

**Step 5: Commit**

```bash
git add apps/api/src/routes/oauthInteraction.test.ts apps/api/src/routes/oauthInteraction.disabled.test.ts
git commit -m "test(api): stabilize oauth interaction route setup"
```

### Task 4: Stabilize MCP bootstrap lifecycle tests

**Files:**
- Modify: `apps/api/src/routes/mcpServer.bootstrapLifecycle.test.ts`

**Step 1: Capture the current timeout**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/routes/mcpServer.bootstrapLifecycle.test.ts --fileParallelism=false --maxWorkers=1
```

Expected before the change: the first request times out during a fresh `mcpServer` module import.

**Step 2: Replace per-test module mocks with mutable state**

- Add a static `../db/schema` mock containing the table fields imported by `mcpServer.ts`, matching the lightweight pattern in `mcpServer.test.ts`.
- Replace `mockDb`, `mockApiKey`, and `mockPerms` `vi.doMock` factories with hoisted state objects consumed by static `vi.mock` factories.
- Keep `getUserPermissions` from the real permissions module except for its mutable test return value, preserving real guardrail permission mapping.
- Import `mcpServerRoutes` and `__loadMcpBootstrapForTests` once.
- In `beforeEach`, reset scope, permission, role, billing-email, handler, ledger, and audit state. Do not reset the module registry.
- In `callBootstrap`, set state, call `__loadMcpBootstrapForTests()`, and issue the request through the cached route.

**Step 3: Verify**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/routes/mcpServer.bootstrapLifecycle.test.ts --fileParallelism=false --maxWorkers=1
```

Expected: all 14 cases pass under the existing 5-second limits.

**Step 4: Commit**

```bash
git add apps/api/src/routes/mcpServer.bootstrapLifecycle.test.ts
git commit -m "test(api): reuse mcp bootstrap route graph"
```

### Task 5: Stabilize MCP effective-tier and resource-RBAC tests

**Files:**
- Modify: `apps/api/src/routes/mcpServer.effectiveTier.test.ts`
- Modify: `apps/api/src/routes/mcpServer.resourceRbac.test.ts`

**Step 1: Capture both current failures**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/routes/mcpServer.effectiveTier.test.ts src/routes/mcpServer.resourceRbac.test.ts --fileParallelism=false --maxWorkers=1
```

Expected before the change: first-use imports exceed existing 5- or 15-second limits.

**Step 2: Use one statically imported route per file**

For both files:

- Mock `../db/schema` with only the table-shaped exports consumed by `mcpServer.ts`.
- Mock `../middleware/apiKeyAuth`, `../db`, and `../services/permissions` statically. Route their behavior through mutable per-test state.
- Import `mcpServerRoutes` once after all static mocks.
- Remove `vi.resetModules()`, `vi.doMock`, and `vi.doUnmock`; reset state and spies in `beforeEach`.

For `mcpServer.effectiveTier.test.ts` specifically:

- Keep the real `checkGuardrails` implementation and the real site-scope helpers.
- Use a mutable AI-tools delegate for `getToolTier`, `executeTool`, and tool definitions so the two existing describe blocks can select their behavior without reimporting the route.
- Use mutable permission results for unrestricted and site-restricted cases.

For `mcpServer.resourceRbac.test.ts` specifically:

- Add an inert static `../services/aiTools` mock because this file tests resource RBAC, not the eager 47-tool registry.
- Keep real `checkPermissionRequirement` behavior through the real guardrails module.
- Use mutable DB rows and permission grants; assert denial still occurs before `db.select`.

**Step 3: Verify**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/routes/mcpServer.effectiveTier.test.ts src/routes/mcpServer.resourceRbac.test.ts --fileParallelism=false --maxWorkers=1
```

Expected: all cases pass under their existing timeouts while retaining the real tier escalation, resource permission, and site narrowing assertions.

**Step 4: Commit**

```bash
git add apps/api/src/routes/mcpServer.effectiveTier.test.ts apps/api/src/routes/mcpServer.resourceRbac.test.ts
git commit -m "test(api): reuse mcp authorization route graphs"
```

### Task 6: Regression and full-suite verification

**Files:**
- Verify all modified files

**Step 1: Run the focused failure set together**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/routes/oauthInteraction.test.ts \
  src/routes/oauthInteraction.disabled.test.ts \
  src/routes/metrics.test.ts \
  src/routes/mcpServer.bootstrapLifecycle.test.ts \
  src/routes/mcpServer.effectiveTier.test.ts \
  src/routes/mcpServer.resourceRbac.test.ts \
  --fileParallelism=false --maxWorkers=1
```

Expected: zero failures and no timeout retries.

**Step 2: Run static checks**

```bash
pnpm --filter @breeze/api lint
pnpm --filter @breeze/api typecheck
```

**Step 3: Run the full API package suite**

```bash
pnpm test --filter=@breeze/api
```

Expected: all API tests pass, including the seven formerly timing-out cases.

**Step 4: Inspect branch scope**

```bash
git status --short
git log --oneline --decorate -10
```

Confirm the pre-existing local hook files remain untracked and untouched, report commits remain unchanged, and stabilization work is represented by separate commits.

---

## Second stabilization wave discovered by the normal full suite

The first wave fixes the original seven timeout failures and passes its 91-test focused set. Running the normal API suite twice exposed a smaller, overlapping set of older test harnesses with the same cold-import/module-reset failure mode. The following tasks extend the plan; the global constraints above continue to apply.

### Task 7: Stabilize connected-app and OAuth route setup

**Files:**
- Modify: `apps/api/src/routes/connectedApps.test.ts`
- Create: `apps/api/src/routes/connectedApps.disabled.test.ts`
- Modify: `apps/api/src/routes/oauth.test.ts`
- Create: `apps/api/src/routes/oauth.disabled.test.ts`

**Step 1: Preserve the full-suite failures as RED evidence**

Run the exact connected-app denial and OAuth-disabled cases under their existing default timeout. Confirm the cold import times out or remains close to the five-second boundary; use an extended timeout only diagnostically to prove finite completion.

**Step 2: Cache the connected-app enabled route**

- Add a minimal static `../db/schema` mock containing the `oauthClients` and `oauthClientPartnerGrants` columns used by the route.
- Import `connectedAppsRoutes` once with OAuth enabled and make `loadApp()` synchronous.
- In `beforeEach`, call `mockReset()` on `select`, `update`, `delete`, and `revokeClientFamilies`, then restore the revocation service's default resolved value. This clears abandoned `mockImplementationOnce` queues.
- Move the disabled-mount assertion to `connectedApps.disabled.test.ts`, with a static disabled `../config/env` mock and lightweight direct dependencies.

**Step 3: Isolate OAuth import-time configurations**

- Move the disabled catch-all assertion to `oauth.disabled.test.ts`. Mock `../oauth/provider` before importing the route and assert `getProvider` is never called.
- In `oauth.test.ts`, statically mock the provider, Redis, and rate limiter, set enabled configuration through a stable config mock, and import the enabled route once for the provider-deferred and resource-alias cases.
- Reset only mutable provider/rate-limit state and request fixtures between tests; remove `vi.resetModules()`, `vi.doMock()`, and `vi.doUnmock()` from both stabilized files.

**Step 4: Verify and commit**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/routes/connectedApps.test.ts src/routes/connectedApps.disabled.test.ts \
  src/routes/oauth.test.ts src/routes/oauth.disabled.test.ts \
  src/routes/oauth.revocation.test.ts src/routes/oauth.rate-limit.test.ts \
  --fileParallelism=false --maxWorkers=1
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/routes/connectedApps.test.ts apps/api/src/routes/connectedApps.disabled.test.ts apps/api/src/routes/oauth.test.ts apps/api/src/routes/oauth.disabled.test.ts
git commit -m "test(api): stabilize oauth route setup"
```

### Task 8: Stabilize MCP bearer, streamable, and bootstrap transport setup

**Files:**
- Modify: `apps/api/src/routes/mcpServer.bearer.test.ts`
- Modify: `apps/api/src/routes/mcpServer.streamable.test.ts`
- Modify: `apps/api/src/routes/mcpServer.test.ts`
- Optionally create narrowly scoped `mcpServer.*.test.ts` files when import-time configurations cannot share one harness

**Step 1: Preserve the repeated timeout/cascade failures as RED evidence**

Run the three exact full-suite cases at the existing default timeout. Confirm that extended diagnostic timeouts complete with the expected assertions and that request bodies execute in milliseconds after import.

**Step 2: Reuse route graphs in bearer and streamable files**

- Mock `../config/env` with live `MCP_OAUTH_ENABLED` / issuer getters backed by hoisted state where tests vary the OAuth flag.
- Import `mcpServerRoutes` once per file and construct Hono apps synchronously.
- Reset middleware implementations, tool delegates, session stores, and environment-backed state in `beforeEach`; do not reset the module registry.
- Preserve real auth selection, partner/org auth building, session minting/ownership, byte limits, scope gates, and JSON-RPC dispatch.

**Step 3: Remove the timed cold import from `mcpServer.test.ts`**

- Correct the stale bootstrap comment: the route no longer reads `IS_HOSTED` or starts bootstrap loading at import.
- Move the bootstrap carve-out block to a stable static-mock harness (a dedicated test file is preferred if the rest of the large test requires distinct import-time configuration).
- Use hoisted mutable API-key/bootstrap/DB/ledger delegates, import the route once, and keep real Zod-to-JSON-Schema conversion plus all handler/list/401 assertions.
- For remaining dynamic-configuration blocks in `mcpServer.test.ts`, either convert them to live mutable delegates or split only the genuinely different import-time configurations into dedicated files. No timed test may perform a first cold import of the full route graph.

**Step 4: Verify and commit**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/routes/mcpServer.bearer.test.ts \
  src/routes/mcpServer.streamable.test.ts \
  src/routes/mcpServer.test.ts \
  --fileParallelism=false --maxWorkers=1
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/routes/mcpServer.bearer.test.ts apps/api/src/routes/mcpServer.streamable.test.ts apps/api/src/routes/mcpServer.test.ts apps/api/src/routes/mcpServer.*.test.ts
git commit -m "test(api): stabilize mcp transport route setup"
```

### Task 9: Remove database startup from encrypted-column unit tests

**Files:**
- Modify: `apps/api/src/services/encryptedColumnRegistry.test.ts`
- Modify or create focused tests beside `apps/api/src/services/sentinelOne/metrics.ts` only if needed by review

**Step 1: Capture the current import-heavy behavior**

Run the exact v1-to-v2 transform test at the existing timeout and record its cold duration. The existing prefix and decrypt assertions are the behavioral RED/GREEN contract; do not add a brittle duration assertion.

**Step 2: Use static real registry/crypto imports**

- Add a narrow `../db` mock so this unit file does not initialize dotenv, the schema barrel, Postgres, or Drizzle. The transform cases never call DB; the batch case injects its own executor.
- Statically import the real `transformEncryptedColumnValue`, `reencryptRegisteredSecrets`, `encryptSecret`, and `decryptSecret`.
- Remove `loadRegistry()`, every `vi.resetModules()`, and every dynamic registry/crypto import.
- Continue clearing and restoring the encryption environment around each test. The crypto module reads active key ID/keyring per call; the current cases use one legacy v1 primary key, so no test-only production cache reset is required.
- Preserve real encryption/decryption, JSON recursion, dry-run statistics, and executor call-count assertions.

**Step 3: Verify and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/encryptedColumnRegistry.test.ts --fileParallelism=false --maxWorkers=1
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/encryptedColumnRegistry.test.ts
git commit -m "test(api): stabilize encrypted column registry setup"
```

### Task 10: Repeat the full verification gate

**Step 1: Run both focused waves together**

Run all first-wave files plus the connected-app, OAuth, MCP transport, and encrypted-column files under one worker. Expect zero failures, timeouts, or cascade mock errors.

**Step 2: Run static checks**

```bash
pnpm --filter @breeze/api lint
pnpm --filter @breeze/api exec tsc --noEmit
```

**Step 3: Run the normal full suite twice**

```bash
pnpm test --filter=@breeze/api
pnpm test --filter=@breeze/api
```

Both runs must pass under the repository's normal parallel configuration. Do not substitute serial execution or a higher global timeout.

**Step 4: Review scope**

Confirm the report commits remain unchanged, both stabilization waves are separately committed, and only the four pre-existing local hook files remain untracked.

---

## Final residual stabilization

The second verification wave reduced the normal suite from 24 failures to three timeout-only failures, and the next identical full run passed. Two OAuth harnesses still reload their route/crypto graphs per test, and the migration-ordering repository contract shares a worker with the DB-heavy auto-migration module. The following tasks remove those last avoidable timing hazards.

### Task 11: Stabilize OAuth rate-limit and revocation harnesses

**Files:**
- Modify: `apps/api/src/routes/oauth.rate-limit.test.ts`
- Create: `apps/api/src/routes/oauth.rate-limit.disabled.test.ts`
- Modify: `apps/api/src/routes/oauth.revocation.test.ts`

**Requirements:**

- Split the import-time disabled OAuth topology into `oauth.rate-limit.disabled.test.ts` with static `MCP_OAUTH_ENABLED: false`, static provider/Redis/rate mocks, one route import, and both 404/no-rate-limiter assertions.
- In the main rate-limit file, use static enabled configuration and a live mutable `OAUTH_DCR_ENABLED` getter, static provider/Redis/rate delegates, and one route import. Reset delegate implementations, call history, DCR state, `NODE_ENV`, and proxy-related environment in `beforeEach).
- Keep real Hono routing, client-IP resolution, redirect policy, body-size parsing, resource normalization, and rate-limit key construction.
- In revocation tests, use one static enabled route graph and stable provider/cache/rate/Redis delegates. Generate one legitimate Ed25519 keypair in `beforeAll`, expose its private JWKS through live config before the first request, and reuse it. Generate only the foreign key required by the forged-token assertion.
- Keep real JWKS loading, JOSE signing/verification, client binding, body parsing, status handling, and Hono middleware.
- Remove `vi.resetModules()`, `vi.doMock()`, `vi.doUnmock()`, and dynamic OAuth route imports. Do not add timeouts or production cache reset hooks.

**Verification and commit:**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/routes/oauth.rate-limit.test.ts \
  src/routes/oauth.rate-limit.disabled.test.ts \
  src/routes/oauth.revocation.test.ts \
  --cache=false
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/routes/oauth.rate-limit.test.ts apps/api/src/routes/oauth.rate-limit.disabled.test.ts apps/api/src/routes/oauth.revocation.test.ts
git commit -m "test(api): stabilize oauth security harnesses"
```

### Task 12: Isolate the migration-ordering repository contract

**Files:**
- Modify: `apps/api/src/db/autoMigrate.test.ts`
- Create: `apps/api/src/db/migrationOrdering.test.ts`

**Requirements:**

- Move the entire `migration ordering` describe unchanged into the adjacent lightweight test file.
- The new file may import only Vitest and Node filesystem/path modules. It must continue scanning the live repository's core SQL migrations, sorting by filename, extracting created tables, enforcing same-file-before-reference ordering, honoring the same system-table exclusions, and asserting the complete violations array is empty.
- Leave the pure runner and extension-migration tests in `autoMigrate.test.ts`.
- Do not move the scan outside the timed test, mock migration contents, weaken it to filename checks, raise the timeout, or change production migration logic.

**Verification and commit:**

```bash
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts src/db/migrationOrdering.test.ts --reporter=verbose
pnpm --filter @breeze/api exec vitest run -t "every referenced table is created in the same file or an earlier one" --reporter=verbose
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/db/autoMigrate.test.ts apps/api/src/db/migrationOrdering.test.ts
git commit -m "test(api): isolate migration ordering contract"
```

### Task 13: Final all-green gate

Run the expanded focused set, API lint, direct TypeScript compilation, and then the normal full API suite twice. Both normal runs must pass without a global timeout increase or serial override. Confirm only the pre-existing local hook files remain untracked, then perform the final whole-branch review.

### Task 14: Bound API test worker parallelism

**Files:**
- Modify: `apps/api/vitest.config.ts`

**Context:** Vitest 4 defaults to `availableParallelism() - 1` fork workers. This host reports 14, so a normal run launches 13 workers; changing unrelated timeout victims, a 240/240 green focused gate, and high aggregate import time demonstrate worker starvation. The public 4-vCPU CI runner similarly benefits from reducing its default three workers to two.

**Requirements:**

- Import `availableParallelism` from `node:os`.
- Set `maxWorkers` to:

```ts
Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))
```

- Keep `fileParallelism: true`, the default fork pool, isolation, reporters, and all test/hook timeouts unchanged.
- Add a focused config test only if the repository has an existing config-test pattern; otherwise TypeScript compilation plus full-suite evidence is the contract.

**Verification and commit:**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
pnpm test --filter=@breeze/api
git add apps/api/vitest.config.ts
git commit -m "test(api): bound vitest worker parallelism"
```

### Task 15: Final consecutive green verification

Run the expanded focused set, API lint, direct TypeScript compilation, and two consecutive normal `pnpm test --filter=@breeze/api` commands with no CLI worker override. Both full runs must pass. Record worker count and durations, confirm timeouts remain unchanged, inspect branch scope, and then perform the final whole-branch review.

### Task 16: Remove the final two timed cold paths

**Files:**
- Modify: `apps/api/src/db/migrationOrdering.test.ts`
- Modify: `apps/api/src/routes/partner_multi_org_orgid.test.ts`

**Requirements:**

- In `migrationOrdering.test.ts`, import `readdir` and `readFile` from `node:fs/promises`, make the assertion async, read the sorted migration list with `Promise.all`, and then process the returned `{ file, sql }` array sequentially in the same sorted order. Preserve every filter, regex, exclusion, same-file ordering rule, and violation assertion. Keep all work inside the timed test.
- In `partner_multi_org_orgid.test.ts`, statically import `orgRoutes` once and use one Hono app instead of four per-test dynamic imports.
- Add the missing minimal `sites` schema mock and a resettable DB select delegate that models the allowed `/sites` query chain.
- Strengthen successful precedence cases to assert HTTP 200 (and the relevant scoped-query condition/body where available) instead of merely asserting “not 403,” which previously allowed a 500 to pass.
- Preserve the 403 denial cases, hoisted auth state, and real organizationId precedence logic. Do not add timeouts or production changes.

**Verification and commit:**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/db/migrationOrdering.test.ts \
  src/routes/partner_multi_org_orgid.test.ts \
  --maxWorkers=4 --cache=false --reporter=verbose
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/db/migrationOrdering.test.ts apps/api/src/routes/partner_multi_org_orgid.test.ts
git commit -m "test(api): stabilize final cold-path harnesses"
```

### Task 17: Final handoff gate

Run the expanded focused set, lint, direct TypeScript compilation, and two consecutive normal API-suite runs with the committed worker cap and no CLI overrides. Both runs must pass. Then complete final whole-branch review and address all Critical/Important findings plus any recorded stale-comment/mock-export cleanup.

### Task 18: Decouple bootstrap permission parity from the AI tool registry

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.bootstrapParity.test.ts`

Add a static `./aiTools` mock exporting `getToolTier` because this test exercises the real bootstrap tool names against the real `TOOL_PERMISSIONS` map, not the independently covered eager 48-tool registry. Keep real `initMcpBootstrap`, real `aiGuardrails.TOOL_PERMISSIONS`, the non-empty assertion, and exact empty-missing assertion. Do not change its timeout or production code.

Verify the bootstrap parity test under `--no-cache`, then run it with `aiGuardrails.test.ts`, `aiToolsRegistryParity.test.ts`, and the two bootstrap handler suites. Run TypeScript, commit as `test(api): isolate bootstrap permission parity`.

### Task 19: Definitive all-green verification and review

Run the focused gate, lint, TypeScript, and two forced-fresh normal API suites. Both must pass with zero timeout messages. Then perform final whole-branch review and cleanup.
