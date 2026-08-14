# Tenant Variable Resolution (PR 2 of #3409) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `tenant_variables` rows PR 1 created actually do something: a `{{var.<key>}}` token in a script body (and in a software installer URL / silent-install args) resolves server-side, per target device, to that device's org-then-partner value — failing that one device loudly rather than shipping a literal `{{...}}`.

**Architecture:** A resolver service loads an opaque, immutable **scope snapshot** for a set of orgs in ONE system-context query, and dispatch consumes that snapshot per device. Resolution never rides ambient RLS, because the five dispatch call sites run under three different DB contexts and would otherwise resolve different variable sets for the same script. Substitution happens at the single `scriptDispatch` chokepoint, between field resolution and the `script_executions` insert, so every ingress inherits it. Secret variables are rejected at save time and again at dispatch — PR 2 has no way to deliver them out-of-band, and textual substitution of a secret is the exact leak class PR 4 exists to prevent.

**Tech Stack:** TypeScript (Hono routes, Drizzle, Zod v4 in `@breeze/shared`), Vitest unit + real-Postgres integration, React + Monaco for the editor picker.

## Global Constraints

- **Issue:** #3409. Scope comment: `gh api repos/lanternops/breeze/issues/comments/5248871605`. PR 1 (this branch's parent): `ToddHebebrand/tenant-variables-pr1`, plan `docs/superpowers/plans/2026-08-11-pr1-tenant-variables.md`.
- **Branch:** `ToddHebebrand/tenant-variables-pr2`, stacked on PR 1. **A stacked PR gets NO CI** (`ci.yml` triggers on `pull_request: branches: [main]`), so `gh pr checks` reads green while nothing ran. Dispatch explicitly before merging: `gh workflow run CI --ref ToddHebebrand/tenant-variables-pr2`.
- **Token grammar:** only `{{var.<key>}}` with `<key>` matching `TENANT_VARIABLE_KEY_PATTERN` (`/^[a-z][a-z0-9_]{0,63}$/`, `packages/shared/src/validators/tenantVariables.ts:14`) is live. Every other `{{...}}` passes through **verbatim** — scripts legitimately contain GitHub Actions expressions, Jinja, and shell brace expansion.
- **`${{var.x}}` must NOT be treated as a variable token.** A `$` immediately before `{{` means the author wrote a shell/Actions construct. This is the one deliberate divergence from the existing installer tokenizer (`TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g`, `apps/api/src/services/installerVariables.ts:29`), which happily eats it.
- **No inner whitespace.** `{{ var.x }}` is NOT a token. The existing client tokenizer strips all whitespace before lookup while the server only trims (`apps/web/src/lib/installerVariables.ts:83` vs `installerVariables.ts:79`), which already produces client-passes/server-fails divergence. Do not extend that bug into the new namespace: one strict form, both sides.
- **Resolution precedence:** org-owned value beats partner-wide value for the same key. Site axis does not exist yet.
- **Empty string is unresolved.** Matches `resolveKey`'s existing rule (`installerVariables.ts:50-60`) — a blank value must fail the device, not silently produce an empty URL segment or an empty argument.
- **Secret variables cannot be referenced in content in v1.** `{{var.<secret_key>}}` is a 400 at script save/import and a per-device failure at dispatch (a variable can be flipped to secret *after* a script referencing it was saved).
- **Resolution runs in a system DB context with explicit `{orgId, partnerId}` filters**, never ambient RLS, and the snapshot is produced by the resolver — never assembled by a caller.
- **The four-eyes effect digest is NOT extended in this PR.** It hashes `scripts.content` — the template — at both pin and release (`services/actionIntents/effectDigest.ts:135,147`), so a variable's *value* changing between approval and release will not invalidate the digest. PR 4 closes this. Say so in the PR body.
- **No agent (Go) changes in this PR.** Delivery of secret values as `BREEZE_VAR_*` env vars is PR 4.
- Commit after every task.

---

## Deviations from the scope comment (deliberate, state in the PR body)

| Scope comment says | This plan does | Why |
|---|---|---|
| "all referenced variables inject as `BREEZE_VAR_<UPPER_KEY>` env vars; textual substitution only where the author wrote a non-secret token" | textual substitution only; **no env injection at all** | The agent has no `BREEZE_VAR_*` handling until PR 4. The only env channel that exists today is the `parameters` map, and the agent substitutes *every* parameter into script text as well as mirroring it to `BREEZE_PARAM_*` (`agent/internal/executor/shell.go:160-176`, `executor.go:329-343`) — routing variables through it would make every value textually substitutable, the precise leak PR 4's separate `secretEnv` channel is designed to avoid. |
| "preloaded scope … that dispatch verifies" | same, plus: the snapshot carries the org ids it was built for and dispatch throws if asked to resolve for an org outside it | Makes the "verifies" concrete and testable. |

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `packages/shared/src/validators/variableTokens.ts` | the `{{var.*}}` grammar: tokenizer, `findVariableTokens`, `hasVariableTokens`; shared by API and web so the two can never diverge |
| `packages/shared/src/validators/variableTokens.test.ts` | tokenizer edge cases (`${{}}`, whitespace, nesting, unbalanced) |
| `packages/shared/src/validators/scriptParameters.ts` | the ONE script-parameter value schema + `canonicalizeScriptParameters` |
| `packages/shared/src/validators/scriptParameters.test.ts` | coercion + rejection coverage |
| `apps/api/src/services/tenantVariableResolution.ts` | scope snapshot loader (system context, one query), per-org resolution, content substitution |
| `apps/api/src/services/tenantVariableResolution.test.ts` | unit coverage with a mocked db |
| `apps/api/src/__tests__/integration/tenantVariableResolution.integration.test.ts` | real-Postgres: org-over-partner precedence, cross-tenant isolation, secret exclusion |
| `apps/web/src/lib/tenantVariableTokens.ts` | web-side vocabulary entry: builds `{{var.*}}` picker entries from a fetched key list |
| `apps/web/src/components/scripts/ScriptVariablePicker.tsx` | Monaco-aware insert-variable menu for the script editor |
| `apps/web/src/components/scripts/ScriptVariablePicker.test.tsx` | picker + warn-only validation coverage |

**Modified**

| Path | Change |
|---|---|
| `apps/api/src/services/scriptDispatch.ts` | accept a scope snapshot; substitute content per device between `:114` and `:116`; new failure code |
| `apps/api/src/services/scriptExecution.ts` | preload the snapshot once; per-device soft-fail instead of `throw` (`:217-222`) |
| `apps/api/src/services/automationRuntime.ts` | preload for both `run_script` (`:888`) and `execute_command` (`:966`) |
| `apps/api/src/services/aiToolsScripts.ts` | preload inside the existing `runOutsideDbContext` escape (`:285-296`) |
| `apps/api/src/routes/scripts.ts` | reject `{{var.<secret>}}` on create (`:230`) / update (`:248`); adopt the shared parameter schema at `:273` |
| `apps/api/src/services/scriptBundle/schema.ts` | same rejection on import |
| `apps/api/src/services/installerVariables.ts` | `var.<key>` arm in `resolveKey`; `vars` on `InstallerVariableContext` |
| `apps/api/src/services/softwareDeployment.ts` | prefetch the variable map alongside `orgName`/`siteNames` (`:317-335`) |
| `apps/web/src/lib/installerVariables.ts` | new `'Variables'` group + dynamic token builder |
| `apps/web/src/components/software/VariableInput.tsx` | accept `tenantVariables` prop, render the new group |
| `apps/web/src/components/scripts/ScriptForm.tsx` | mount the picker + warn-only unknown-token notice |

---

### Task 1: The shared `{{var.*}}` tokenizer

**Files:**
- Create: `packages/shared/src/validators/variableTokens.ts`, `packages/shared/src/validators/variableTokens.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (re-export)

**Interfaces:**
- Produces:
  ```ts
  export const VARIABLE_TOKEN_PATTERN: RegExp;              // global, use with matchAll only
  export function findVariableTokens(content: string): string[];   // unique keys, in first-seen order
  export function hasVariableTokens(content: string): boolean;
  export function variableToken(key: string): string;       // `{{var.${key}}}`
  export function replaceVariableTokens(
    content: string,
    lookup: (key: string) => string | undefined,
  ): { content: string; unresolved: string[] };
  ```
  Task 2 (API resolver) and Task 6 (web picker) both import these. `replaceVariableTokens` is the single substitution implementation — the API wraps it, the web never substitutes.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { findVariableTokens, replaceVariableTokens, variableToken } from './variableTokens';

describe('findVariableTokens', () => {
  it('finds a well-formed token', () => {
    expect(findVariableTokens('curl {{var.repo_url}}/pkg')).toEqual(['repo_url']);
  });

  it('de-duplicates and preserves first-seen order', () => {
    expect(findVariableTokens('{{var.b}} {{var.a}} {{var.b}}')).toEqual(['b', 'a']);
  });

  it('ignores a token escaped by a leading $ — that is shell/Actions syntax', () => {
    expect(findVariableTokens('run ${{var.repo_url}}')).toEqual([]);
  });

  it.each([
    '{{ var.x }}',        // inner whitespace: one strict form only
    '{{VAR.X}}',          // case-sensitive
    '{{var.9bad}}',       // key grammar
    '{{var.Bad_Key}}',
    '{{var.}}',
    '{{var.x}',           // unbalanced
    '{{varx}}',           // no dot
    '{{org.name}}',       // a different namespace passes through
    '{file}',             // the agent's own single-brace token
  ])('does not treat %j as a variable token', (input) => {
    expect(findVariableTokens(input)).toEqual([]);
  });

  it('leaves an unrelated {{...}} expression alone', () => {
    const gha = 'if: ${{ github.event_name == \'push\' }}';
    expect(findVariableTokens(gha)).toEqual([]);
  });
});

describe('replaceVariableTokens', () => {
  it('substitutes verbatim, with no escaping', () => {
    const out = replaceVariableTokens('token={{var.k}}', (k) => (k === 'k' ? 'a b"c' : undefined));
    expect(out).toEqual({ content: 'token=a b"c', unresolved: [] });
  });

  it('reports an unknown key and leaves the token in place', () => {
    const out = replaceVariableTokens('{{var.missing}}', () => undefined);
    expect(out).toEqual({ content: '{{var.missing}}', unresolved: ['missing'] });
  });

  it('treats an empty value as unresolved', () => {
    const out = replaceVariableTokens('{{var.blank}}', () => '');
    expect(out.unresolved).toEqual(['blank']);
    expect(out.content).toBe('{{var.blank}}');
  });

  it('never re-scans a substituted value (no recursive expansion)', () => {
    const out = replaceVariableTokens('{{var.a}}', (k) => (k === 'a' ? '{{var.b}}' : 'SHOULD-NOT-APPEAR'));
    expect(out.content).toBe('{{var.b}}');
  });

  it('leaves a $-escaped token untouched', () => {
    const out = replaceVariableTokens('${{var.k}}', () => 'v');
    expect(out).toEqual({ content: '${{var.k}}', unresolved: [] });
  });

  it('round-trips variableToken', () => {
    expect(replaceVariableTokens(variableToken('k'), () => 'v').content).toBe('v');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/shared test -- variableTokens`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

The regex must reject a preceding `$` without consuming the character before the token (a lookbehind keeps the match offsets clean; Node 22 supports it):

```ts
/** `{{var.<key>}}` — no inner whitespace, key grammar enforced, `${{...}}` excluded. */
export const VARIABLE_TOKEN_PATTERN = /(?<!\$)\{\{var\.([a-z][a-z0-9_]{0,63})\}\}/g;
```

`replaceVariableTokens` must build the output with a single `String.replace(VARIABLE_TOKEN_PATTERN, cb)` pass so a substituted value is never re-scanned, and push the key to `unresolved` when the lookup returns `undefined`, `null`, or `''` (returning the original token unchanged in that case).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/shared test -- variableTokens`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/variableTokens.ts packages/shared/src/validators/variableTokens.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(shared): {{var.*}} token grammar shared by API and web (#3409 PR2)"
```

---

### Task 2: The resolver — scope snapshot, precedence, substitution

**Files:**
- Create: `apps/api/src/services/tenantVariableResolution.ts`, `apps/api/src/services/tenantVariableResolution.test.ts`
- Create: `apps/api/src/__tests__/integration/tenantVariableResolution.integration.test.ts`

**Interfaces:**
- Consumes: `tenantVariables` (`db/schema`), `decryptTenantVariableValue` (`services/tenantVariables.ts:75`), `replaceVariableTokens` / `findVariableTokens` (Task 1).
- Produces:
  ```ts
  export interface ResolvedVariable { key: string; value: string; isSecret: boolean; variableId: string; version: number; }
  /** Opaque. Built only by loadTenantVariableScope; carries the org ids it is valid for. */
  export interface TenantVariableScope { readonly orgIds: ReadonlySet<string>; /* private carrier */ }
  export async function loadTenantVariableScope(orgIds: string[]): Promise<TenantVariableScope>;
  export function resolveForOrg(scope: TenantVariableScope, orgId: string): Map<string, ResolvedVariable>;
  export interface SubstitutionOutcome {
    content: string;
    unresolved: string[];      // keys with no visible value
    secretsReferenced: string[]; // keys that resolved but are is_secret — never substituted
  }
  export function substituteTenantVariables(content: string, resolved: Map<string, ResolvedVariable>): SubstitutionOutcome;
  export function describeVariableFailure(outcome: SubstitutionOutcome): string | null;
  ```
  Tasks 3 and 5 consume these.

- [ ] **Step 1: Write the failing unit tests**

Mock `../db` only (never `../db/schema` — the query is built with real Drizzle columns). Cover:

```ts
it('org value shadows a partner-wide value for the same key', () => { /* both rows in the snapshot; resolveForOrg returns the org one */ });
it('a partner-wide key with no org override still resolves', () => {});
it('never leaks another org value into this org resolution', () => { /* two orgs in one snapshot */ });
it('throws when asked to resolve for an org the snapshot was not built for', () => {
  expect(() => resolveForOrg(scope, 'org-not-in-snapshot')).toThrow(/not in this snapshot/i);
});
it('substituteTenantVariables reports a secret key instead of substituting it', () => {
  const out = substituteTenantVariables('{{var.s1_token}}', mapWith({ key: 's1_token', isSecret: true }));
  expect(out.content).toBe('{{var.s1_token}}');
  expect(out.secretsReferenced).toEqual(['s1_token']);
  expect(out.unresolved).toEqual([]);
});
it('never puts a secret value in the returned content even when the same key is also referenced twice', () => {});
it('describeVariableFailure names the keys but never a value', () => {});
it('loadTenantVariableScope issues ONE query for many orgs', async () => { /* assert db.select called once */ });
it('loadTenantVariableScope filters on org OR (partner-wide AND that org partner)', async () => {
  // Walk the captured condition's BOUND PARAMS (see services/tenantVariables.test.ts's
  // boundParams helper) — a stringified-condition assertion passes with the guard deleted.
});
it('an undecryptable row is treated as unresolved, not as an empty value', async () => {});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api test -- tenantVariableResolution`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`loadTenantVariableScope(orgIds)`:
- de-duplicate `orgIds`; return an empty scope for an empty input without querying.
- run the whole load inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`. **Both wrappers are required.** The route path calls this from inside a held org-scoped request transaction; a bare `withSystemDbAccessContext` nested in an existing context does not elevate it, and an org token whose JWT lacks `partnerId` would then see zero partner-wide rows. System scope makes resolution identical across all five call sites — at the cost that RLS no longer constrains it, so the WHERE clause below is the only tenancy boundary and must be exact.
- one query joining `organizations` for `partner_id`:
  ```sql
  SELECT tv.*, o.id AS for_org_id
  FROM organizations o
  JOIN tenant_variables tv
    ON tv.org_id = o.id
    OR (tv.org_id IS NULL AND tv.partner_id = o.partner_id)
  WHERE o.id = ANY($1)
  ```
  Express it in Drizzle with `inArray(organizations.id, orgIds)`; every row comes back tagged with the org it is FOR, so a partner-wide row appears once per org that inherits it.
- decrypt each value with `decryptTenantVariableValue`; a throw is logged (`console.warn`, id only) and the row is **omitted** — an unreadable variable must fail the device, not resolve to `''`.
- build `Map<orgId, Map<key, ResolvedVariable>>`, applying org-over-partner precedence at insert time.

`resolveForOrg` throws when `orgId` is absent from `scope.orgIds` — that is the "dispatch verifies the snapshot" contract.

`substituteTenantVariables` calls `replaceVariableTokens` with a lookup that returns `undefined` for a secret key while recording it in `secretsReferenced`, so a secret is reported separately from a genuinely missing key and its value never enters the output string.

- [ ] **Step 4: Write the integration suite**

`tenantVariableResolution.integration.test.ts`, modeled on `tenantVariablesPartnerRls.integration.test.ts`. Must prove against real Postgres:
1. org-owned value shadows the partner-wide one with the same key;
2. an org inherits its partner's partner-wide value;
3. an org NEVER sees another partner's partner-wide value (build two partners);
4. a two-org snapshot resolves each org independently in one call;
5. resolution works when called from inside an ORG-SCOPED `withDbAccessContext` — the regression that proves the system-context escape is present (delete the escape and this test must fail);
6. a secret variable is loaded but reported via `secretsReferenced`, never substituted.

- [ ] **Step 5: Run both suites**

```bash
pnpm --filter @breeze/api test -- tenantVariableResolution
pnpm --filter @breeze/api test:integration -- tenantVariableResolution
```
Expected: PASS. (The test stack is already up on this worktree; `pnpm test-stack up` at the repo root if not.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/tenantVariableResolution.ts apps/api/src/services/tenantVariableResolution.test.ts apps/api/src/__tests__/integration/tenantVariableResolution.integration.test.ts
git commit -m "feat(api): tenant variable resolver with org-over-partner precedence (#3409 PR2)"
```

---

### Task 3: Per-device failure channel for script dispatch

**Files:**
- Modify: `apps/api/src/services/scriptExecution.ts` (`:217-222`), `apps/api/src/services/scriptDispatch.ts` (`:46-59`)
- Modify: `apps/api/src/services/scriptExecution.test.ts`, `apps/api/src/services/scriptDispatch.test.ts`

**Why this is its own task:** today `executeScriptOnDevices` throws on any dispatch failure, so devices after the failing one never get a row and the batch's `devicesTargeted` becomes a lie. Fail-loud variable resolution would turn one org's missing variable into a silently truncated fan-out. This task builds the channel; Task 4 uses it.

**Interfaces:**
- Produces: `DispatchScriptResult` gains failure code `'unresolved_variables'`; `ExecuteScriptOnDevicesSuccess` gains `failures: Array<{ deviceId: string; code: string; error: string }>`, and `executions` keeps its existing meaning (successfully dispatched only).

- [ ] **Step 1: Write the failing test**

In `scriptExecution.test.ts`:

```ts
it('records a per-device failure and still dispatches the remaining devices', async () => {
  // dispatch mock: device B fails, A and C succeed
  const result = await executeScriptOnDevices({ /* three devices */ });
  expect(result.executions).toHaveLength(2);
  expect(result.failures).toEqual([{ deviceId: DEVICE_B, code: 'unresolved_variables', error: expect.any(String) }]);
});

it('writes a failed script_executions row for the failed device, not nothing', async () => {
  // assert the insert carried status 'failed' + a non-empty errorMessage
});

it('counts a per-device failure toward the batch devicesFailed, not devicesTargeted', async () => {});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api test -- scriptExecution`
Expected: FAIL — `failures` undefined / the throw still aborts.

- [ ] **Step 3: Implement**

Replace the `throw new Error(dispatch.error)` at `scriptExecution.ts:217-222` with: push to `failures`, insert a `script_executions` row with `status: 'failed'`, `errorMessage: dispatch.error`, `completedAt: new Date()` (mirroring `softwareDeployment.ts:399-414`), increment the org's batch `devicesFailed`, and `continue`. Keep throwing for codes that indicate a programming error rather than a per-device condition (`insert_failed`) so a real bug still surfaces loudly.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api test -- scriptExecution scriptDispatch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(api): per-device failure channel for script fan-out (#3409 PR2)"
```

---

### Task 4: Wire resolution into dispatch

**Files:**
- Modify: `apps/api/src/services/scriptDispatch.ts`, `scriptExecution.ts`, `automationRuntime.ts` (`:888`, `:966`), `aiToolsScripts.ts` (`:285-296`)
- Modify: `apps/api/src/services/scriptDispatch.test.ts` + the three call-site test files

**Interfaces:**
- Consumes: Task 2's resolver, Task 3's failure channel.
- Produces: `DispatchScriptInput` gains `variableScope?: TenantVariableScope`.

- [ ] **Step 1: Write the failing tests**

```ts
it('substitutes a non-secret variable into the content that reaches the payload', async () => {
  // assert the payload content contains the value and NOT the token
});
it('fails the device with unresolved_variables when a token has no value', async () => {
  // and assert queueCommand was NEVER called for it
});
it('fails the device when the content references a SECRET variable', async () => {
  // PR 4 delivers secrets; PR 2 must never substitute one
  expect(result).toMatchObject({ ok: false, code: 'unresolved_variables' });
  expect(result.error).toMatch(/secret/i);
});
it('never puts a secret value anywhere in the payload', async () => {
  expect(JSON.stringify(payload)).not.toContain(SECRET_VALUE);
});
it('resolves nothing and issues no query when the content has no {{var.}} token', async () => {});
it('throws if the supplied scope was not built for this device org', async () => {});
it('does not substitute into a raw execute_command source', async () => {
  // {kind:'raw'} has no declaring script; per the scope decision, tokens pass through
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api test -- scriptDispatch`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `scriptDispatch.ts`, between the field resolution at `:109-114` and the `script_executions` insert at `:116`:

```ts
let content = source.kind === 'saved' ? source.script.content : source.content;
if (source.kind === 'saved' && hasVariableTokens(content)) {
  if (!input.variableScope) throw new Error('variableScope is required to dispatch a script containing {{var.*}} tokens');
  const outcome = substituteTenantVariables(content, resolveForOrg(input.variableScope, device.orgId));
  const failure = describeVariableFailure(outcome);
  if (failure) return { ok: false, code: 'unresolved_variables', error: failure };
  content = outcome.content;
}
```

- The `hasVariableTokens` guard keeps the common (token-free) path allocation-free and query-free.
- Placing this BEFORE the execution-row insert means a failed device gets its `failed` row from Task 3's channel in the caller, with no orphan `pending` row to discard.
- `{kind:'raw'}` is deliberately skipped: an ad-hoc `execute_command` has no declaring script, so there is nothing that could have been validated at save time.

Call sites preload once per fan-out, outside the per-device loop:
- `scriptExecution.ts`: after `executableDevices` is known, `loadTenantVariableScope([...new Set(devices.map(d => d.orgId))])`.
- `automationRuntime.ts:888`: single device — `loadTenantVariableScope([device.orgId])`.
- `aiToolsScripts.ts`: inside the existing `runOutsideDbContext` escape at `:285-296`, before `dispatchScriptToDevice`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api test -- scriptDispatch scriptExecution automationRuntime aiToolsScripts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(api): resolve {{var.*}} per device at script dispatch (#3409 PR2)"
```

---

### Task 5: Save-time enforcement + software-deploy wiring

**Files:**
- Modify: `apps/api/src/routes/scripts.ts` (create `:230`, update `:248`), `apps/api/src/services/scriptBundle/schema.ts`
- Modify: `apps/api/src/services/installerVariables.ts`, `apps/api/src/services/softwareDeployment.ts` (`:317-335`, `:382-420`)
- Modify: `apps/api/src/services/installerVariables.test.ts`, `apps/api/src/routes/scripts.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// routes/scripts.test.ts
it('400s a script whose content references a secret variable', async () => {});
it('accepts a script referencing a non-secret variable', async () => {});
it('accepts a script referencing an UNKNOWN variable key — warn-only, not a block', async () => {
  // a key may be created after the script; only the secret rule is a hard block
});

// installerVariables.test.ts
it('resolves {{var.key}} from the prefetched map', () => {});
it('treats an empty variable value as unresolved (fail loudly)', () => {});
it('leaves ${{var.key}} alone', () => {});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api test -- scripts installerVariables`
Expected: FAIL.

- [ ] **Step 3: Implement**

Save-time check (create, update, bundle import): if `findVariableTokens(content)` is non-empty, load the caller's visible variables and 400 on any key whose row has `is_secret = true`. An unknown key is allowed — it may be created later, and the dispatch path already fails loudly. The error message names the offending keys.

`installerVariables.ts`: add `vars: Record<string, string>` to `InstallerVariableContext` and a `var.<key>` arm to `resolveKey` returning `ctx.vars[key] ?? null` (the existing empty-string-is-null rule at `:50-60` then applies unchanged). Keep the resolver **sync and DB-free** — the map is prefetched.

`softwareDeployment.ts`: alongside the existing `templatesUseVariables` prefetch at `:317-335`, call `loadTenantVariableScope([orgId])` and flatten the non-secret entries into `vars`. Secret variables are omitted from the map, so referencing one in an installer URL fails that device through the existing unresolved branch at `:399-414` — no new code path.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api test -- scripts installerVariables softwareDeployment scriptBundle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(api): reject secret variable tokens at save; resolve {{var.*}} in installer templates (#3409 PR2)"
```

---

### Task 6: Web — vocabulary, software picker, script-editor picker

**Files:**
- Create: `apps/web/src/lib/tenantVariableTokens.ts`, `apps/web/src/components/scripts/ScriptVariablePicker.tsx` + test
- Modify: `apps/web/src/lib/installerVariables.ts`, `apps/web/src/components/software/VariableInput.tsx`, `apps/web/src/components/scripts/ScriptForm.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// VariableInput.test.tsx — mirrors the existing custom-fields group test at :47
it('renders tenant variables under their own group and inserts at the caret', () => {});

// ScriptVariablePicker.test.tsx
it('inserts {{var.key}} into Monaco at the current selection', () => {});
it('marks a secret variable as unusable with a reason', () => {});
it('warns — without blocking submit — when the content references an unknown key', () => {});
it('does not warn on ${{var.x}} or on a {{org.name}} token from another namespace', () => {});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/web test -- VariableInput ScriptVariablePicker`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `installerVariables.ts`: add `'Variables'` to `InstallerVariableGroup` (`:22`) and to `GROUP_ORDER` (`VariableInput.tsx:36-41`). Tenant variables are **dynamic**, like custom fields — do NOT add static entries to `BUILTIN_INSTALLER_VARIABLES`, whose exact contents are pinned by a cross-boundary tripwire test at `apps/web/src/lib/installerVariables.test.ts:14-18`.
- `VariableInput.tsx`: new optional `tenantVariables?: Array<{ key: string; description: string | null; isSecret: boolean }>` prop, folded into the existing `variables` memo at `:72-80`. Secret entries render disabled with a "delivered as an environment variable in a later release" hint.
- `ScriptForm.tsx`: mount the picker in the toolbar row that already holds the AI toggle (`:495-512`). Insert via `editorInstanceRef.current.executeEdits(...)` at the live selection — NOT `setSelectionRange`, which is the `<input>`-only approach `VariableInput` uses. Warn-only validation derives from `watch('content')` and renders beside the existing error slot at `:566`, styled as a warning; it must NOT go through `zodResolver` (`:161`), which would block submit.
- Fetch the key list from `GET /tenant-variables` via `fetchWithAuth` (it injects the current `orgId` automatically). A failed fetch degrades to an empty list and suppresses unknown-token warnings entirely — the same "accept on structure alone until the async list arrives" convention as `requireKnownCustomKeys` (`VariableInput.tsx:94-100`).
- New user-facing strings need keys in all seven locales (`localeParity` + `translationCoverage` will fail otherwise).

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @breeze/web test -- VariableInput ScriptVariablePicker ScriptForm installerVariables
pnpm --filter @breeze/web test -- localeParity translationCoverage
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(web): {{var.*}} picker for scripts and software templates (#3409 PR2)"
```

---

### Task 7: One script-parameter schema, canonicalized to strings

**Files:**
- Create: `packages/shared/src/validators/scriptParameters.ts` + test
- Modify: `apps/api/src/routes/scripts.ts` (`:273`), `apps/api/src/routes/mobile.ts` (`:307`), `apps/api/src/services/automationRuntime.ts` (`:371`), `apps/api/src/services/scriptDispatch.ts` (payload build `:180`)

**Why:** the wire type is already `map[string]string` (`agent/internal/executor/executor.go:39`) and the agent silently drops every non-string value (`agent/internal/heartbeat/handlers_script.go:40`) — so a `number`/`boolean` parameter, which the UI actively encourages, leaves `{{name}}` verbatim in the script and never sets `BREEZE_PARAM_*`. Canonicalizing at the API is the fix; the agent stays unchanged.

**Interfaces:**
- Produces:
  ```ts
  export const SCRIPT_PARAMETER_KEY_PATTERN: RegExp;          // /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
  export const MAX_SCRIPT_PARAMETERS: number;                  // 64
  export const MAX_SCRIPT_PARAMETER_VALUE_LENGTH: number;      // 4096
  export const scriptParametersSchema: z.ZodType<Record<string, string | number | boolean>>;
  export function canonicalizeScriptParameters(input: Record<string, string | number | boolean>): Record<string, string>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts strings, finite numbers and booleans', () => {});
it('rejects null, objects, arrays, NaN and Infinity', () => {});
it('rejects a key the agent could not turn into an env var name', () => {
  // 'has space', 'a.b', 'a=b' — see the BREEZE_PARAM_ construction at executor.go:329-343
});
it('enforces the count and per-value size caps', () => {});
it('canonicalizes a number and a boolean to their string forms', () => {
  expect(canonicalizeScriptParameters({ n: 3, b: true })).toEqual({ n: '3', b: 'true' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/shared test -- scriptParameters`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Adopt `scriptParametersSchema` at the three ingresses, and call `canonicalizeScriptParameters` ONCE inside `scriptDispatch.ts` at the payload build (`:180`) so every ingress — including the ones this plan does not touch (`aiToolsScripts`, `aiAgentSdkTools`, `scriptBuilderTools`, `remediationSuggestions`) — gets string values on the wire. Keep the existing 64KB cap on the execute route.

> Note for the reviewer: `agent/internal/userhelper/client.go:743` drops parameters entirely for `runAs: 'user'` runs — a separate, pre-existing outage this PR does NOT fix (it needs a helper IPC change, which is PR 4 territory). File it as a follow-up rather than widening this PR.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @breeze/shared test -- scriptParameters
pnpm --filter @breeze/api test -- scripts mobile automationRuntime scriptDispatch commandAudit
```
Expected: PASS. Several existing fixtures assert today's shape (`routes/scripts.test.ts:512` sends `parameters: { flag: true }`) — update them to the canonicalized expectation rather than loosening the schema.

- [ ] **Step 5: Commit**

```bash
git commit -am "fix(api): one script-parameter schema, canonicalized to strings on the wire (#3409 PR2)"
```

---

### Task 8: Full verification

- [ ] **Step 1: Run everything**

```bash
pnpm --filter @breeze/shared test
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
cd apps/web && npx astro check
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantVariableResolution.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.rls-coverage.ts
pnpm db:check-drift
```

- [ ] **Step 2: Dispatch CI explicitly — the stacked PR gets none by default**

```bash
gh workflow run CI --ref ToddHebebrand/tenant-variables-pr2
```

---

## Self-Review

**Spec coverage** against the scope comment's PR-2 row ("`{{var.*}}` vocabulary + editor picker + per-device resolver (env-first, batch, fail-loud) + software-deploy wiring + shared param schema"):

| Requirement | Task |
|---|---|
| `{{var.*}}` vocabulary, `${{...}}` exclusion, other `{{...}}` passes through | 1 |
| editor picker + warn-only validation | 6 |
| per-device resolver, batch (one query per snapshot), fail-loud | 2, 4 |
| org-over-partner precedence | 2 |
| hard block on `{{var.<secret>}}` at save AND re-check at dispatch | 4, 5 |
| software-deploy wiring | 5 |
| shared param schema at all ingresses, canonicalized to strings | 7 |
| "env-first" delivery | **deliberately deferred to PR 4** — see the deviations table |

Deferred with the PR that owns each: `BREEZE_VAR_*` / `secretEnv` delivery, payload erasure on all terminal transitions, redaction, and effect-digest pinning (PR 4); sourced parameters (PR 3); the `runAs: 'user'` parameter outage (follow-up issue).

**Type consistency:** `replaceVariableTokens` (Task 1) is the only substitution implementation; `substituteTenantVariables` (Task 2) wraps it and is the only caller in the API. `TenantVariableScope` is produced solely by `loadTenantVariableScope` and consumed by `resolveForOrg`. The failure code is spelled `'unresolved_variables'` in Tasks 3 and 4 alike.
