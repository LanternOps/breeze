# Shared zValidator Error Shape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal**

Every zValidator 400 in the API currently returns `@hono/zod-validator`'s raw safeParse result: `{success:false, error: ZodError}` — and under zod v4, `ZodError.issues` is non-enumerable, so the wire body is `{success:false, error:{name:'ZodError', message:'<stringified issues>'}}`. Unreadable for every string-first consumer (mobile renders "An error occurred"; MCP clients and scripts get an object where they expect a string). Fix: one shared wrapped `zValidator` (`apps/api/src/lib/validation.ts`) that injects a default 400 hook emitting the stable, string-first contract `{error: '<path-prefixed messages joined with "; ">', details: {formErrors, fieldErrors}}`, adopted repo-wide via an import-swap codemod across all 229 route files / 1154 call sites. Closes #2201. Refs #2198, #2200.

**Architecture**

A new module `apps/api/src/lib/validation.ts` re-exports `zValidator` with the identical overloaded generic signature (via `as typeof honoZValidator` cast, so `c.req.valid(...)` inference is untouched — `tsc --noEmit` proves it) and composes any per-route hook with a default hook: the route hook runs first and wins if it returns a response; otherwise validation failures get the standard body. All 229 files under `apps/api/src/routes/` swap their import line from `'@hono/zod-validator'` to the local module — nothing else changes per route. A repo-idiomatic guard test (modeled on `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`; the API's eslint flat config has zero custom rules, so a test is the enforcement mechanism here) prevents regression to direct imports.

**Tech Stack**

- API: Hono 4.12.x + `@hono/zod-validator` 0.8.0 + zod 4.4.3 (exposes both `z.flattenError(err)` and deprecated `err.flatten()`; use `z.flattenError`)
- Tests: Vitest (`apps/api/vitest.config.ts` unit runner — includes `src/**/*.test.ts`), web Vitest + jsdom
- Sweep: `grep -El` + `perl -pi -e` (BSD sed is a known footgun on this repo — use perl)

## Global Constraints

- Wire contract on every zValidator validation failure: HTTP 400, body `{error: string, details: {formErrors: string[], fieldErrors: Record<string, string[]>}}` — `error` is path-prefixed messages joined with `'; '` (e.g. `'settings.urlTemplate: Template must include {id}; name: Name is required'`), `details` is `z.flattenError(result.error)`.
- The wrapper MUST preserve `c.req.valid(...)` type inference — `pnpm exec tsc --noEmit --project apps/api/tsconfig.json` (the exact CI Type Check command) is the gate; zero new errors.
- No behavior change for 2xx paths: valid requests parse and reach handlers exactly as before.
- The sweep is import-swap ONLY — same call name `zValidator`, no per-route logic changes; routes whose OWN handlers return `{error: <object>}` bodies (e.g. `configurationPolicies/featureLinks.ts`, unifi `{success:false, message}` bodies) are out of scope.
- The 4 test files that `vi.mock('@hono/zod-validator', ...)` (`routes/agents/heartbeat.test.ts`, `routes/devices/groups.test.ts`, `routes/scriptAi_sessions.test.ts`, `routes/scriptAi_messages_approve.test.ts`) are NOT touched: vitest mocks by resolved module id, so the wrapper's own upstream import receives the mock, and those mocks ignore the extra hook argument.

---

### Task 1: Shared wrapper module `apps/api/src/lib/validation.ts`

**Files**
- Create: `apps/api/src/lib/validation.ts`
- Create: `apps/api/src/lib/validation.test.ts`

**Interfaces**

```ts
export type ValidationErrorDetails = { formErrors: string[]; fieldErrors: Record<string, string[]> };
export type ValidationErrorBody = { error: string; details: ValidationErrorDetails };
export function formatZodIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string;
export function validationErrorBody(error: z.core.$ZodError): ValidationErrorBody;
export const zValidator: typeof honoZValidator; // identical overloaded generic signature
```

**Steps**

- [ ] Write the failing test `apps/api/src/lib/validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator, formatZodIssues, validationErrorBody } from './validation';

describe('shared zValidator wrapper (#2201)', () => {
  const schema = z
    .object({
      name: z.string().min(1, 'Name is required'),
      settings: z
        .object({
          urlTemplate: z.string().refine((v) => v.includes('{id}'), 'Template must include {id}'),
        })
        .optional(),
    })
    .strict();

  function makeApp() {
    const app = new Hono();
    app.post('/things', zValidator('json', schema), (c) => {
      const body = c.req.valid('json');
      // Compile-time inference checks — the wrapper must preserve the upstream
      // generic signature. `tsc --noEmit` over apps/api is the real gate.
      const name: string = body.name;
      // @ts-expect-error — property does not exist on the parsed body; if the
      // wrapper widened the type to `any`, this directive itself errors.
      void body.doesNotExist;
      return c.json({ ok: true, name });
    });
    return app;
  }

  const postJson = (app: Hono, body: unknown) =>
    app.request('/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('passes valid bodies through untouched (2xx path unchanged)', async () => {
    const res = await postJson(makeApp(), { name: 'router-01' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, name: 'router-01' });
  });

  it('emits the string-first contract on a single field error', async () => {
    const res = await postJson(makeApp(), { name: '' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'name: Name is required',
      details: { formErrors: [], fieldErrors: { name: ['Name is required'] } },
    });
  });

  it('joins multiple issues with "; " and dot-joins nested paths', async () => {
    const res = await postJson(makeApp(), { name: '', settings: { urlTemplate: 'no-placeholder' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('name: Name is required; settings.urlTemplate: Template must include {id}');
    // flattenError keys nested issues by their TOP-LEVEL path segment.
    expect(body.details.fieldErrors).toEqual({
      name: ['Name is required'],
      settings: ['Template must include {id}'],
    });
  });

  it('never emits the raw {success:false, error: ZodError} body', async () => {
    const res = await postJson(makeApp(), { name: 'x', unknownKey: true });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBeUndefined();
    expect(typeof body.error).toBe('string');
    // strict() unrecognized-key issues have an empty path — message lands bare
    // and still names the offending key.
    expect(body.error).toContain('unknownKey');
    expect(body.details.formErrors.join(' ')).toContain('unknownKey');
  });

  it('lets a per-route hook win when it returns a response (orgs.ts 422 pattern)', async () => {
    const app = new Hono();
    app.post(
      '/things',
      zValidator('json', schema, (result, c) => {
        if (!result.success && result.error.issues.some((i) => i.path[0] === 'name')) {
          return c.json({ error: 'custom' }, 422);
        }
      }),
      (c) => c.json({ ok: true, got: c.req.valid('json').name })
    );

    const custom = await postJson(app, { name: '' });
    expect(custom.status).toBe(422);
    await expect(custom.json()).resolves.toEqual({ error: 'custom' });

    // Hook returned void for this failure → default contract, NOT the raw
    // fall-through body upstream would emit.
    const fallthrough = await postJson(app, { name: 'x', settings: { urlTemplate: 'nope' } });
    expect(fallthrough.status).toBe(400);
    const body = await fallthrough.json();
    expect(body.error).toBe('settings.urlTemplate: Template must include {id}');
    expect(body.success).toBeUndefined();
  });

  it('formatZodIssues falls back to "Invalid request" on an empty issue list', () => {
    expect(formatZodIssues([])).toBe('Invalid request');
  });

  it('validationErrorBody produces the exact contract from a caught ZodError', () => {
    const parsed = schema.safeParse({ name: '' });
    if (parsed.success) throw new Error('expected failure');
    expect(validationErrorBody(parsed.error)).toEqual({
      error: 'name: Name is required',
      details: { formErrors: [], fieldErrors: { name: ['Name is required'] } },
    });
  });
});
```

- [ ] Run: `pnpm --filter @breeze/api exec vitest run src/lib/validation.test.ts` — expect FAIL (module `./validation` does not exist).
- [ ] Implement `apps/api/src/lib/validation.ts`:

```ts
/**
 * Shared zValidator wrapper — the ONE validation-error contract for the API.
 *
 * @hono/zod-validator's default 400 hook returns the raw safeParse result
 * (`c.json(result, 400)` → `{success:false, error: ZodError}`). Under zod v4,
 * `ZodError.issues` is non-enumerable, so the serialized `error` is
 * `{name:'ZodError', message:'<stringified issues>'}` — unreadable for any
 * string-first consumer (mobile, MCP clients, scripts). Issue #2201.
 *
 * This module re-exports `zValidator` with a default hook emitting a stable,
 * string-first body on validation failure:
 *
 *   { error: 'path.to.field: message; other: message',
 *     details: { formErrors: string[], fieldErrors: Record<string, string[]> } }
 *
 * Route files must import `zValidator` from here, never from
 * '@hono/zod-validator' directly (enforced by validation.importGuard.test.ts).
 */
import { zValidator as honoZValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { z } from 'zod';

export type ValidationErrorDetails = {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
};

export type ValidationErrorBody = {
  error: string;
  details: ValidationErrorDetails;
};

/** Joins zod issues into one readable line: `a.b: msg; c: msg`. */
export function formatZodIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>
): string {
  const joined = issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join('.')}: ${issue.message}`
        : issue.message
    )
    .join('; ');
  return joined || 'Invalid request';
}

/** Builds the stable wire body from a ZodError (also usable by manual safeParse call sites). */
export function validationErrorBody(error: z.core.$ZodError): ValidationErrorBody {
  return {
    error: formatZodIssues(error.issues),
    // zod v4: `error.flatten()` is deprecated; `z.flattenError` is the
    // supported API and accepts core $ZodError. Cast: flattenError's mapped
    // fieldErrors type is keyed by the (unknown-here) schema shape.
    details: z.flattenError(error) as ValidationErrorDetails,
  };
}

type HookResult =
  | { success: true }
  | { success: false; error: z.core.$ZodError };

// Composes an optional per-route hook with the default error shape: the route
// hook runs first and wins if it returns a response (e.g. orgs.ts's 422 for
// inboundLocalPart). When it returns nothing on a failure, we emit the
// standard body instead of letting @hono/zod-validator fall through to
// `c.json(result, 400)` (the raw ZodError).
function composeHook(routeHook?: (result: never, c: never) => unknown) {
  return async (result: HookResult, c: Context) => {
    if (routeHook) {
      const hookResult = await (routeHook as (r: HookResult, c: Context) => unknown)(result, c);
      if (hookResult !== undefined && hookResult !== null) {
        return hookResult as Response;
      }
    }
    if (!result.success) {
      return c.json(validationErrorBody(result.error), 400);
    }
    return undefined;
  };
}

// The `as unknown as typeof honoZValidator` cast is the load-bearing line: it
// preserves the upstream overloaded generic signature verbatim, so
// `c.req.valid('json')` inference in every route is identical to importing
// '@hono/zod-validator' directly. (The two-step cast through `unknown` is
// deliberate — the untyped implementation and the overloaded generic type are
// not directly comparable.) `tsc --noEmit --project apps/api/tsconfig.json`
// is the gate.
//
// Known, accepted typing gap: because callers without a hook still resolve the
// no-hook overload, the *typed* 400 response body (used only by hono RPC
// clients, which this repo does not use) still says ZodValidatorFailureBody;
// the runtime body is ValidationErrorBody.
export const zValidator = ((
  target: unknown,
  schema: unknown,
  hook?: (result: never, c: never) => unknown,
  options?: unknown
) =>
  (honoZValidator as unknown as (...args: unknown[]) => unknown)(
    target,
    schema,
    composeHook(hook),
    options
  )) as unknown as typeof honoZValidator;
```

- [ ] Run: `pnpm --filter @breeze/api exec vitest run src/lib/validation.test.ts` — expect PASS (8 tests).
- [ ] Run: `pnpm exec tsc --noEmit --project apps/api/tsconfig.json` — expect zero errors (proves the `@ts-expect-error` inference check compiles, i.e. inference survived the wrapper).
- [ ] Commit: `git add apps/api/src/lib/validation.ts apps/api/src/lib/validation.test.ts && git commit -m "feat(api): shared zValidator wrapper emitting stable {error, details} 400 body (#2201)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 2: Codemod sweep — swap all route imports to the wrapper

**Files**
- Modify: all 229 files under `apps/api/src/routes/` that import from `'@hono/zod-validator'` (73 at depth `src/routes/*.ts`, 156 at depth `src/routes/*/*.ts`; verified: no deeper nesting, no importers outside `src/routes/`). 227 use single quotes; 2 use double quotes (`routes/agentVersions.ts`, `routes/enrollmentKeys.ts`) — the regex handles both.

**Interfaces** — none; the call name stays `zValidator`, only the import specifier changes:
- `src/routes/*.ts`: `import { zValidator } from '../lib/validation';`
- `src/routes/*/*.ts`: `import { zValidator } from '../../lib/validation';`

**Steps**

- [ ] Baseline count (expect 229 files, 1154 call sites):

```bash
cd apps/api
# Scope to src/routes: Task 1 already added legitimate zValidator( occurrences
# in src/lib/validation.test.ts and the allowed upstream import in src/lib/validation.ts.
grep -rEl "from ['\"]@hono/zod-validator['\"]" src/routes | wc -l    # expect 229
grep -rno "zValidator\(" src/routes --include='*.ts' | wc -l         # expect 1154
```

- [ ] Run the codemod (perl, NOT BSD sed):

```bash
cd apps/api
# Depth-1 route files (73):
grep -El "from ['\"]@hono/zod-validator['\"]" src/routes/*.ts \
  | xargs perl -pi -e "s|from ['\"]\@hono/zod-validator['\"]|from '../lib/validation'|g"
# Depth-2 route files (156):
grep -El "from ['\"]@hono/zod-validator['\"]" src/routes/*/*.ts \
  | xargs perl -pi -e "s|from ['\"]\@hono/zod-validator['\"]|from '../../lib/validation'|g"
```

- [ ] Verify zero direct imports remain outside the wrapper (the `vi.mock('@hono/zod-validator', ...)` lines in the 4 test files intentionally do NOT match `from ...` and must remain untouched):

```bash
cd apps/api
grep -rEln "from ['\"]@hono/zod-validator['\"]" src | grep -v '^src/lib/validation.ts'   # expect empty
git diff --stat | tail -1   # expect 229 files changed
```

- [ ] Gate 1 — type inference across all 1154 call sites: `pnpm exec tsc --noEmit --project apps/api/tsconfig.json` (run from repo root) — expect zero errors. Any error here means the wrapper broke inference; fix the wrapper, not the routes.
- [ ] Gate 2 — full API unit suite: `pnpm --filter @breeze/api test:run` — expect green, with one known candidate for failure triaged in Task 3 (`routes/enrollmentKeys_strict.test.ts` asserts only substring presence, so it is expected to keep passing — confirm). Explicitly confirm the 4 vi.mock suites pass: `pnpm --filter @breeze/api exec vitest run src/routes/agents/heartbeat.test.ts src/routes/devices/groups.test.ts src/routes/scriptAi_sessions.test.ts src/routes/scriptAi_messages_approve.test.ts`.
- [ ] Risk callout: any test failure whose assertion targets a handler-emitted body (e.g. `routes/unifi/index.test.ts`'s `{success:false, message:'Not connected'}` 400s, `deployments_actions.test.ts:233`'s `initializeDeployment` failure body) is NOT caused by this sweep — those are the routes' own JSON bodies, unrelated to zValidator. Do not "fix" them.
- [ ] Commit: `git add apps/api/src/routes && git commit -m "refactor(api): route-wide import swap to shared zValidator wrapper (#2201)" -m "229 files / 1154 call sites; mechanical import-specifier change only." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 3: Reconcile API tests that referenced the raw 400 shape

Research found exactly ONE API test file that encodes knowledge of the raw zValidator wire shape: `apps/api/src/routes/enrollmentKeys_strict.test.ts` (its `bodyContains` helper + doc comment at lines ~91-101 describe the old `{success:false, error}` body). It asserts via full-body substring search, so it keeps passing — but its comment now documents a shape the API no longer emits, and its assertions can be strengthened to pin the NEW contract. (`c2c/schemas.test.ts` and `services/aiToolSchemas.security.test.ts` call `safeParse` directly on schemas — not wire-shape tests; leave them alone.)

**Files**
- Modify: `apps/api/src/routes/enrollmentKeys_strict.test.ts`

**Steps**

- [ ] Update the stale doc comment and tighten one assertion to the new contract. Replace the `bodyContains` helper block:

```ts
/**
 * The Hono zValidator default error hook returns `c.json({ success: false,
 * error }, 400)` where `error` is the serialized ZodError. The exact JSON
 * shape isn't part of our public contract, so this helper just stringifies
 * the body and asserts the offending key name appears somewhere in it —
 * enough to confirm the unknown-key was surfaced to the caller.
 */
async function bodyContains(res: Response, needle: string): Promise<boolean> {
  const text = await res.text();
  return text.includes(needle);
}
```

with:

```ts
/**
 * Validation 400s go through the shared zValidator wrapper
 * (src/lib/validation.ts, #2201): `{error: string, details: {formErrors,
 * fieldErrors}}`. `error` is the public string-first contract; assert the
 * offending key name is surfaced there.
 */
async function bodyContains(res: Response, needle: string): Promise<boolean> {
  const body = (await res.json()) as { error?: unknown };
  return typeof body.error === 'string' && body.error.includes(needle);
}
```

- [ ] Run: `pnpm --filter @breeze/api exec vitest run src/routes/enrollmentKeys_strict.test.ts` — expect PASS (zod v4 unrecognized-key messages name the key, e.g. `Unrecognized key: "maxUses"`, and the wrapper puts them in `error`). If run BEFORE the Task 2 sweep this version would FAIL (old body's `error` is an object) — that ordering is the TDD signal if you want it; task order here assumes the sweep already landed.
- [ ] Run the full suite once more to prove no other file asserted the raw shape: `pnpm --filter @breeze/api test:run` — expect green.
- [ ] Commit: `git add apps/api/src/routes/enrollmentKeys_strict.test.ts && git commit -m "test(api): pin enrollment-key strict 400s to the shared validation contract (#2201)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 4: orgs.ts:577 reconciliation — keep the 422 hook, gain the standard fall-through

`apps/api/src/routes/orgs.ts:577` is the ONLY per-route hook in the repo (verified by grep). It returns a 422 for `inboundLocalPart` regex failures and `void` for every other failure — which previously fell through to the raw ZodError body. With the composed wrapper, the 422 special case is preserved and the fall-through now emits the standard `{error, details}` 400. **Keep the hook unchanged** (it encodes a deliberate 422 + friendlier message); add a test pinning the newly-fixed fall-through branch. Existing 422 tests live at `apps/api/src/routes/orgs.test.ts` (~line 2506, `PATCH /partners/me — inboundLocalPart` describe block, with `patchPartnerMe` + `mockCurrentPartnerSelect` helpers).

**Files**
- Modify: `apps/api/src/routes/orgs.test.ts` (add one test inside the `PATCH /partners/me — inboundLocalPart` describe block, after the 422 tests)

**Steps**

- [ ] Add the failing-first test (it FAILS before Task 2's sweep, PASSES after — since the sweep already landed, verify it passes and temporarily revert `orgs.ts`'s import line to `'@hono/zod-validator'` to watch it fail, then restore):

```ts
      // #2201: the per-route hook only handles inboundLocalPart (422). Every
      // OTHER validation failure used to fall through to @hono/zod-validator's
      // raw {success:false, error: ZodError} body; the shared wrapper now
      // emits the standard string-first contract instead.
      it('returns the standard {error, details} 400 for non-inboundLocalPart validation failures', async () => {
        const res = await patchPartnerMe({ billingEmail: 'not-an-email' });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBeUndefined();
        expect(typeof body.error).toBe('string');
        expect(body.error).toContain('billingEmail');
        expect(body.details.fieldErrors.billingEmail).toHaveLength(1);
      });
```

- [ ] Run: `pnpm --filter @breeze/api exec vitest run src/routes/orgs.test.ts` — expect PASS (including the pre-existing 422 and 409 inboundLocalPart tests, proving the composed hook preserved the custom branch).
- [ ] Commit: `git add apps/api/src/routes/orgs.test.ts && git commit -m "test(api): pin partner-settings non-inboundLocalPart 400s to the shared contract (#2201)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 5: Import-guard test — no direct '@hono/zod-validator' imports

The API's eslint flat config (`apps/api/eslint.config.js`) has `rules: {}` and no custom-rule infrastructure, so the repo-idiomatic guard is a sweep test (pattern: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`). A regex scan is sufficient here (unlike no-silent-mutations, an import statement is syntactically regular). `vi.mock('@hono/zod-validator', ...)` calls intentionally stay legal — they must reference the real module id to intercept it transitively — and don't match the `from`-anchored regex.

**Files**
- Create: `apps/api/src/lib/validation.importGuard.test.ts`

**Steps**

- [ ] Write the test:

```ts
/**
 * Guard (#2201): every route must import `zValidator` via src/lib/validation
 * (the shared wrapper that emits the stable {error: string, details} 400
 * body). A direct upstream-package import silently reverts that endpoint's
 * validation 400s to the raw ZodError shape that mobile/MCP consumers
 * cannot read.
 *
 * `vi.mock('@hono/zod-validator', ...)` in tests is fine (and required — the
 * mock must target the real module id); only import clauses are forbidden.
 * NOTE: keep the exact `from '<pkg>'` sequence out of comments in this file —
 * the scan below is a plain-text regex and would flag itself.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // apps/api/src

// lib/validation.ts is the only file allowed to import the upstream package;
// this guard file is allowlisted defensively so a future comment edit can't
// make the suite flag itself.
const ALLOWLIST = new Set(['lib/validation.ts', 'lib/validation.importGuard.test.ts']);

const DIRECT_IMPORT = /from\s+['"]@hono\/zod-validator['"]/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('zValidator import guard (#2201)', () => {
  it('no file under apps/api/src imports @hono/zod-validator directly', () => {
    const offenders = walk(SRC_ROOT)
      .map((file) => relative(SRC_ROOT, file).split(sep).join('/'))
      .filter((rel) => !ALLOWLIST.has(rel))
      .filter((rel) => DIRECT_IMPORT.test(readFileSync(join(SRC_ROOT, rel), 'utf8')));
    expect(offenders, 'import zValidator from src/lib/validation instead').toEqual([]);
  });
});
```

- [ ] Prove it has teeth: temporarily add `import { zValidator as _direct } from '@hono/zod-validator';` to any route file, run `pnpm --filter @breeze/api exec vitest run src/lib/validation.importGuard.test.ts` — expect FAIL naming that file. Revert the temporary line.
- [ ] Run: `pnpm --filter @breeze/api exec vitest run src/lib/validation.importGuard.test.ts` — expect PASS.
- [ ] Commit: `git add apps/api/src/lib/validation.importGuard.test.ts && git commit -m "test(api): guard against direct @hono/zod-validator imports (#2201)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 6: Web — shared validation-error fixture helper + fixtures on the NEW wire shape + dedupe polish

`extractApiError` (`apps/web/src/lib/apiError.ts`) already renders `{error: string, details: flatten}` — the three known component fixtures keep passing unmodified (their assertions are substring/regex matches). But (a) they now encode a wire shape the API no longer emits, and (b) each re-encodes the fixture inline — a confirmed review finding on PR #2200. Consolidate into ONE helper and update all copies to the new shape. Also: `extractApiError`'s details-dedupe is exact-match only (`parts.includes(fromDetails)`), so a nested-path error (`settings.urlTemplate: msg` vs flatten's top-level-keyed `settings: msg`) renders the message twice — add a message-level redundancy check. Keep the existing legacy-shape tests in `apiError.test.ts`: old agents/proxies and the raw-shape recovery path (`error.message` JSON parse) remain reachable from cached bundles and third-party emitters.

**Files**
- Create: `apps/web/src/lib/__tests__/apiErrorFixtures.ts`
- Modify: `apps/web/src/lib/apiError.ts`
- Modify: `apps/web/src/lib/apiError.test.ts`
- Modify: `apps/web/src/components/settings/PartnerSettingsPage.test.tsx` (~lines 90-102)
- Modify: `apps/web/src/components/discovery/AssetDetailModal.test.tsx` (~lines 419-431, the `zodErrorBody` const)
- Modify: `apps/web/src/components/pam/PamRuleModal.test.tsx` (~lines 300-305)

**Interfaces**

```ts
// apps/web/src/lib/__tests__/apiErrorFixtures.ts
export type WireIssue = { message: string; path?: Array<string | number> };
export function zodValidationErrorBody(...issues: WireIssue[]): {
  error: string;
  details: { formErrors: string[]; fieldErrors: Record<string, string[]> };
};
```

**Steps**

- [ ] Create the shared fixture helper `apps/web/src/lib/__tests__/apiErrorFixtures.ts` (mirrors `apps/api/src/lib/validation.ts` exactly — if the API contract changes, change BOTH):

```ts
/**
 * Builds the wire body the API's shared zValidator hook emits on a
 * validation 400 (apps/api/src/lib/validation.ts, issue #2201):
 *   { error: 'a.b: msg; c: msg', details: { formErrors, fieldErrors } }
 * Single source of truth for web test fixtures — do not re-encode the shape
 * inline (review finding on PR #2200).
 */
export type WireIssue = { message: string; path?: Array<string | number> };

export function zodValidationErrorBody(...issues: WireIssue[]) {
  const error =
    issues
      .map((i) => (i.path && i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ') || 'Invalid request';
  const formErrors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  for (const i of issues) {
    if (i.path && i.path.length > 0) {
      const key = String(i.path[0]);
      (fieldErrors[key] ??= []).push(i.message);
    } else {
      formErrors.push(i.message);
    }
  }
  return { error, details: { formErrors, fieldErrors } };
}
```

- [ ] Write failing tests in `apps/web/src/lib/apiError.test.ts` (append to the existing describe; keep every existing test — they are now labeled legacy-compat coverage):

```ts
  // ---- #2201: the shared API zValidator hook's wire shape ----
  it('renders the shared-hook body without duplicating messages (nested path vs top-level fieldErrors key)', () => {
    const body = zodValidationErrorBody({
      message: 'Template must include the {id} placeholder',
      path: ['settings', 'remoteAccessProviders', 0, 'urlTemplate'],
    });
    // error: 'settings.remoteAccessProviders.0.urlTemplate: Template must include the {id} placeholder'
    // details.fieldErrors: { settings: ['Template must include the {id} placeholder'] }
    expect(extractApiError(body, FALLBACK)).toBe(
      'settings.remoteAccessProviders.0.urlTemplate: Template must include the {id} placeholder'
    );
  });

  it('renders multi-issue shared-hook bodies once each', () => {
    const body = zodValidationErrorBody(
      { message: 'Name is required', path: ['name'] },
      { message: 'Invalid email address', path: ['billingEmail'] }
    );
    expect(extractApiError(body, FALLBACK)).toBe(
      'name: Name is required; billingEmail: Invalid email address'
    );
  });

  it('still appends details that add NEW information beyond the error label', () => {
    // featureLinks-style body: generic label + substantive flatten. Must NOT
    // be swallowed by the redundancy check.
    const body = {
      error: 'Invalid patch settings',
      details: { formErrors: [], fieldErrors: { rebootPolicy: ['Invalid enum value'] } },
    };
    expect(extractApiError(body, FALLBACK)).toBe('Invalid patch settings: rebootPolicy: Invalid enum value');
  });
```

with the import added at the top: `import { zodValidationErrorBody } from './__tests__/apiErrorFixtures';`

- [ ] Run: `pnpm --filter @breeze/web exec vitest run src/lib/apiError.test.ts` — expect the nested-path test to FAIL (current output duplicates: `'settings.remoteAccessProviders.0.urlTemplate: Template must include the {id} placeholder: settings: Template must include the {id} placeholder'`); the other two may already pass.
- [ ] Implement the redundancy check in `apps/web/src/lib/apiError.ts`. Add below `detailsToString`:

```ts
// The shared API validation hook (#2201) emits path-prefixed messages in
// `error` AND the same messages (keyed by top-level field) in `details`.
// Appending both renders "a.b: msg: a: msg", so skip details whose every
// message already appears verbatim in the error text. Bodies where details
// add information (e.g. featureLinks' generic label + substantive flatten)
// still concatenate.
function flattenMessages(details: unknown): string[] {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  const { formErrors, fieldErrors } = details as { formErrors?: unknown; fieldErrors?: unknown };
  const out: string[] = [];
  if (Array.isArray(formErrors)) {
    for (const m of formErrors) {
      if (typeof m === 'string' && m.length > 0) out.push(m);
    }
  }
  if (fieldErrors && typeof fieldErrors === 'object' && !Array.isArray(fieldErrors)) {
    for (const messages of Object.values(fieldErrors as Record<string, unknown>)) {
      if (!Array.isArray(messages)) continue;
      for (const m of messages) {
        if (typeof m === 'string' && m.length > 0) out.push(m);
      }
    }
  }
  return out;
}

function detailsRedundant(details: unknown, parts: string[]): boolean {
  if (parts.length === 0) return false;
  const messages = flattenMessages(details);
  if (messages.length === 0) return false;
  const errorText = parts.join(': ');
  return messages.every((m) => errorText.includes(m));
}
```

and change the append line in `extractApiError` from:

```ts
  const fromDetails = detailsToString(body.details);
  if (fromDetails && !parts.includes(fromDetails)) parts.push(fromDetails);
```

to:

```ts
  const fromDetails = detailsToString(body.details);
  if (fromDetails && !parts.includes(fromDetails) && !detailsRedundant(body.details, parts)) {
    parts.push(fromDetails);
  }
```

- [ ] Run: `pnpm --filter @breeze/web exec vitest run src/lib/apiError.test.ts` — expect PASS (all pre-existing legacy tests AND the three new ones).
- [ ] Swap the three inline fixtures to the helper + NEW shape (assertions unchanged — they're substring/regex based and the messages are identical):
  - `PartnerSettingsPage.test.tsx` (~90-102): replace the inline `zodValidatorBody` const with `const zodValidatorBody = zodValidationErrorBody({ message: 'Template must include the {id} placeholder for the per-device value', path: ['settings', 'remoteAccessProviders', 0, 'urlTemplate'] });` and update the comment to reference the shared hook (#2201) instead of the raw zod v4 serialization.
  - `AssetDetailModal.test.tsx` (~419-431): `const zodErrorBody = zodValidationErrorBody({ message: 'Invalid input: expected string, received null', path: ['label'] });` — update the comment block above it likewise.
  - `PamRuleModal.test.tsx` (~300-305): replace the inline `{ success: false, error: { issues: [...] } }` body with `zodValidationErrorBody({ message: 'matchHash must be a 64-char sha256 hex string', path: ['matchHash'] })`.
  - Import in each: `import { zodValidationErrorBody } from '../../lib/__tests__/apiErrorFixtures';` (adjust relative depth per file: `components/settings`, `components/discovery`, `components/pam` are all two levels below `src`).
- [ ] Run: `pnpm --filter @breeze/web exec vitest run src/lib/apiError.test.ts src/components/settings/PartnerSettingsPage.test.tsx src/components/discovery/AssetDetailModal.test.tsx src/components/pam/PamRuleModal.test.tsx` — expect PASS.
- [ ] Mobile check (read-only, NO code change): `apps/mobile/src/services/api.ts` lines ~233-241 accept `typeof body.error === 'string' && body.error` — the new contract satisfies it; validation detail now reaches mobile toasts with zero mobile changes. Confirm by reading; do not edit.
- [ ] Commit: `git add apps/web/src/lib/__tests__/apiErrorFixtures.ts apps/web/src/lib/apiError.ts apps/web/src/lib/apiError.test.ts apps/web/src/components/settings/PartnerSettingsPage.test.tsx apps/web/src/components/discovery/AssetDetailModal.test.tsx apps/web/src/components/pam/PamRuleModal.test.tsx && git commit -m "test(web): shared zodValidationErrorBody fixture on the new API contract; dedupe details in extractApiError (#2201)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 7: Docs — document the validation-error contract

`apps/docs` mentions validation errors once in prose (`security/overview.mdx:232`: "Validation errors return structured error objects with field paths.") — true before and after, but now the shape is a stable public contract worth documenting. No reference page documents the raw shape (grepped `formErrors|fieldErrors|validation error` across `apps/docs`), and no e2e test asserts it (grepped `e2e-tests/`).

**Files**
- Modify: `apps/docs/src/content/docs/security/overview.mdx` (~line 232)

**Steps**

- [ ] Replace the sentence at ~line 232:

```
Validation errors return structured error objects with field paths. Sensitive values are never echoed in error responses.
```

with:

````
Validation failures return `400` with a stable, string-first body — `error` is a human-readable summary (path-prefixed messages joined with `;`), `details` carries the machine-readable field breakdown:

```json
{
  "error": "billingEmail: Invalid email address; name: Name is required",
  "details": {
    "formErrors": [],
    "fieldErrors": {
      "billingEmail": ["Invalid email address"],
      "name": ["Name is required"]
    }
  }
}
```

Sensitive values are never echoed in error responses.
````

(In `overview.mdx` itself the JSON block is a normal top-level triple-backtick fence; the four-backtick fence above only exists to quote it inside this plan.)

- [ ] Build the docs to verify MDX validity: `pnpm --filter @breeze/docs build` (if no such filter name, `cd apps/docs && pnpm build`) — expect success.
- [ ] Commit: `git add apps/docs/src/content/docs/security/overview.mdx && git commit -m "docs: document the validation-error wire contract (#2201)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

## Verification

```bash
# 1. Type inference across all 1154 call sites (same command CI's Type Check job runs)
pnpm exec tsc --noEmit --project apps/api/tsconfig.json

# 2. Full API unit suite (includes the wrapper tests, import guard, orgs + enrollment-key reconciliations)
pnpm --filter @breeze/api test:run

# 3. Web suite (fixture helper + extractApiError dedupe + three component suites)
pnpm --filter @breeze/web exec vitest run

# 4. Zero direct imports (belt-and-braces alongside the guard test)
grep -rEln "from ['\"]@hono/zod-validator['\"]" apps/api/src | grep -v '^apps/api/src/lib/validation.ts' && echo "FAIL: direct import found" || echo "OK"
```

Manual check against a dev stack (`docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up -d`, or `pnpm dev`; API listens on `API_PORT`, default 3001, mounted at `/api/v1`). `/auth/login` is public and zValidator-guarded, so no token needed:

```bash
curl -s -X POST http://localhost:3001/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"not-an-email","password":"short"}' | jq
```

Expected (exact message text comes from zod 4.4.3; assert the SHAPE — string `error`, object `details` with `formErrors`/`fieldErrors` — not the wording):

```json
{
  "error": "email: Invalid email address; password: Too small: expected string to have >=8 characters",
  "details": {
    "formErrors": [],
    "fieldErrors": {
      "email": ["Invalid email address"],
      "password": ["Too small: expected string to have >=8 characters"]
    }
  }
}
```

Before this change, the same request returned `{"success":false,"error":{"name":"ZodError","message":"[...stringified issues...]"}}`.
