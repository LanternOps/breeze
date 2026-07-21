# #1379 Silent-Failure Observability — Remaining Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the observability hardening for issue #1379 — make tenant context, PII scrubbing, fatal-error capture, and a generalized silent-write contract test land on top of the already-shipped worker observability (B1, #1380) and RLS-deny tagging (B6, #1805).

**Architecture:** Incremental, low-risk additions to the existing Sentry service (`apps/api/src/services/sentry.ts`), the auth middleware (`apps/api/src/middleware/auth.ts`), the boot/signal-handler section of `apps/api/src/index.ts`, and the `db` proxy guard (`apps/api/src/db/index.ts`). Each phase is independently shippable as its own PR, matching the issue's "subsequent PRs" framing.

**Tech Stack:** TypeScript, Hono, `@sentry/node` ^10.54.0 (auto request-isolation scopes via httpIntegration), Vitest (unit + integration configs), PostgreSQL + `breeze_app` RLS role.

## Global Constraints

- **Already shipped — do NOT re-implement:** B1 worker observability (`apps/api/src/jobs/workerObservability.ts`, #1380), the `db`-proxy contextless-write guard in *warn mode* (`apps/api/src/db/index.ts:245` `reportContextlessWrite`, #1380), `captureMessage` export (`services/sentry.ts:64`, #1380), and B6 Postgres `42501` tagging in `captureException` (#1805).
- **Sentry is opt-in at runtime:** every helper must early-return when `!initialized` / `!isSentryEnabled()`. Tests must not require a real DSN.
- **No PII in Sentry:** never tag/extra a raw token, password hash, cookie, or `mfaSecret`. B2 tags only `userId` (a UUID), `scope`, `orgId`, `partnerId` — all non-secret identifiers.
- **Sentry v10 isolation scopes:** module-level `Sentry.setUser()` / `Sentry.setTag()` write to the per-request isolation scope automatically under the node http integration. Use those (not `getCurrentScope()`) so context survives across async hops within a request.
- **Migrations:** none of these tasks touch the schema. No migration files.
- **Test placement:** unit tests alongside source (`*.test.ts`); real-`breeze_app`-DB tests in `apps/api/src/__tests__/integration/*.integration.test.ts` (run via `--config vitest.integration.config.ts`). See CLAUDE.md.
- **Rollout order (issue C, with B1/B6 done):** B2 → A1 + A3 → B3 + B4 → A2. B5 (tracing) is explicitly out of scope for this plan.

---

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `apps/api/src/services/sentry.ts` | Add `setSentryRequestContext()` (B2), `beforeSend` scrubber + `profilesSampleRate` knob (B3) | B2, B3 |
| `apps/api/src/services/sentry.test.ts` | Unit tests for the new helpers (mock `@sentry/node`) | B2, B3 |
| `apps/api/src/middleware/auth.ts` | Call `setSentryRequestContext()` after `c.set('auth', …)` | B2 |
| `apps/api/src/index.ts` | `uncaughtException` handler + flush (B4); read centralized suppression list (B3) | B3, B4 |
| `apps/api/src/services/rejectionSuppressions.ts` | Centralized benign-rejection suppression predicate (B3) | B3 |
| `apps/api/src/services/rejectionSuppressions.test.ts` | Unit tests for the predicate | B3 |
| `apps/api/src/db/index.ts` | Env-gated throw escalation in `reportContextlessWrite` (A1) | A1 |
| `apps/api/src/__tests__/integration/silent-write-contract.integration.test.ts` | Generalized #1375 functional contract test (A3) | A3 |
| `apps/api/src/db/dbWriteExpectingRows.ts` | `dbWriteExpectingRows()` helper (A2) | A2 |
| `apps/api/src/db/dbWriteExpectingRows.test.ts` | Unit tests for the helper | A2 |

---

## Phase B2 — Per-request tenant/user Sentry context

Makes every existing Sentry event (route throws, worker failures, contextless-write warnings, RLS-deny tags) attributable to a tenant. Highest triage value, lowest risk. Ships as one PR.

### Task 1: `setSentryRequestContext()` helper

**Files:**
- Modify: `apps/api/src/services/sentry.ts` (add export after `captureMessage`, ~line 78)
- Test: `apps/api/src/services/sentry.test.ts` (create if absent)

**Interfaces:**
- Produces: `setSentryRequestContext(ctx: { userId: string; scope: 'system' | 'partner' | 'organization'; orgId: string | null; partnerId: string | null }): void` — no-op when Sentry is disabled; otherwise sets the isolation-scope user + tenant tags.

- [ ] **Step 1: Write the failing test**

Create/append `apps/api/src/services/sentry.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setUser = vi.fn();
const setTag = vi.fn();
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  setUser,
  setTag,
  withScope: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
}));

import { initSentry, setSentryRequestContext } from './sentry';

describe('setSentryRequestContext', () => {
  beforeEach(() => {
    setUser.mockClear();
    setTag.mockClear();
  });

  it('is a no-op when Sentry is not initialized', () => {
    // No SENTRY_DSN → initSentry() never marks initialized.
    setSentryRequestContext({ userId: 'u-1', scope: 'organization', orgId: 'o-1', partnerId: 'p-1' });
    expect(setUser).not.toHaveBeenCalled();
    expect(setTag).not.toHaveBeenCalled();
  });

  it('sets user id + tenant tags when initialized', () => {
    process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0';
    initSentry();
    setSentryRequestContext({ userId: 'u-1', scope: 'organization', orgId: 'o-1', partnerId: 'p-1' });
    expect(setUser).toHaveBeenCalledWith({ id: 'u-1' });
    expect(setTag).toHaveBeenCalledWith('scope', 'organization');
    expect(setTag).toHaveBeenCalledWith('orgId', 'o-1');
    expect(setTag).toHaveBeenCalledWith('partnerId', 'p-1');
    delete process.env.SENTRY_DSN;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/sentry.test.ts`
Expected: FAIL — `setSentryRequestContext is not a function` (import undefined).

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/services/sentry.ts`, add after `captureMessage` (~line 78):

```ts
/**
 * Attach the authenticated tenant/user to the current request's Sentry
 * isolation scope (#1379 B2). Every event captured later in the request —
 * route throws, contextless-write warnings, RLS-deny tags — inherits these,
 * so triage on a multi-tenant RMM stops being guesswork. Only non-secret
 * identifiers are tagged (no token, no password, no mfaSecret).
 */
export function setSentryRequestContext(ctx: {
  userId: string;
  scope: 'system' | 'partner' | 'organization';
  orgId: string | null;
  partnerId: string | null;
}): void {
  if (!initialized) {
    return;
  }
  // Module-level setters target the per-request isolation scope under the
  // node http integration — safe across concurrent requests and async hops.
  Sentry.setUser({ id: ctx.userId });
  Sentry.setTag('scope', ctx.scope);
  Sentry.setTag('orgId', ctx.orgId ?? 'none');
  Sentry.setTag('partnerId', ctx.partnerId ?? 'none');
}
```

> Note: the failing test asserts `setTag('orgId', 'o-1')` with a non-null value; the `?? 'none'` only changes the null case. Keep the test's orgId/partnerId non-null so it matches. (If you prefer to assert the null-coalescing, add a third case with `orgId: null` expecting `setTag('orgId', 'none')`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/sentry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/sentry.ts apps/api/src/services/sentry.test.ts
git commit -m "feat(observability): setSentryRequestContext helper for tenant tags (#1379 B2)"
```

### Task 2: Wire the helper into `authMiddleware`

**Files:**
- Modify: `apps/api/src/middleware/auth.ts` (import + call after `c.set('auth', …)` at line 458)

**Interfaces:**
- Consumes: `setSentryRequestContext` (Task 1); `payload.scope`, `payload.orgId`, `payload.partnerId`, `user.id` (already in scope at line 442).

- [ ] **Step 1: Add the import**

At the top of `apps/api/src/middleware/auth.ts`, alongside the other service imports (after line 12 `import { writeAuditEvent } …`):

```ts
import { setSentryRequestContext } from '../services/sentry';
```

- [ ] **Step 2: Call it right after the auth context is set**

In `authMiddleware`, immediately after the `c.set('auth', { … });` block closes at line 458, insert:

```ts
  // #1379 B2 — tag this request's Sentry isolation scope with the tenant so
  // any event captured downstream is attributable. Non-secret ids only.
  setSentryRequestContext({
    userId: user.id,
    scope: payload.scope,
    orgId: payload.orgId,
    partnerId: payload.partnerId
  });
```

- [ ] **Step 3: Run the auth middleware tests + typecheck**

Run:
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/middleware/auth.test.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit
```
Expected: PASS, no type errors. (If `auth.test.ts` does not exist, the typecheck alone is the gate — the call uses only already-in-scope, correctly-typed values.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/middleware/auth.ts
git commit -m "feat(observability): attach tenant context to Sentry in authMiddleware (#1379 B2)"
```

---

## Phase A1 — Escalate the contextless-write guard to throw in dev/CI

The guard already warns (#1380). This makes it *throw* outside production so a contextless write fails CI loudly. **This task has an inherent discovery loop:** turning the throw on will surface intentional contextless writes that must be allowlisted before the suite is green. Ships as one PR.

### Task 3: Env-gated throw + allowlist in `reportContextlessWrite`

**Files:**
- Modify: `apps/api/src/db/index.ts` (`reportContextlessWrite`, ~line 245)

**Interfaces:**
- Consumes: existing `reportContextlessWrite(label: string)` and the proxy call-sites at `db/index.ts:332` (`.insert/.update/.delete`) and `:341` (`.execute(verb)`).
- Produces: a `STRICT_DB_CONTEXT` env gate — when `'true'`, contextless writes throw instead of only warning.

- [ ] **Step 1: Read the current guard and known intentional exceptions**

Read `apps/api/src/db/index.ts:220-260`. The documented intentional contextless paths are: the `device_commands` agent-WS write path and the separate `auditAdminPool` (which bypasses the proxy entirely — see `db/index.ts:242`, `auditAdminPool.ts`). Note these — they must NOT throw.

- [ ] **Step 2: Add the env-gated throw**

In `reportContextlessWrite` (~line 245), after the existing `console.warn(message)` + `captureMessage(...)`, append:

```ts
  // #1379 A1 — escalate to a hard failure outside production so a contextless
  // write (the #1375 class) reds CI instead of silently warning. Gated by
  // STRICT_DB_CONTEXT so prod never throws and the rollout is reversible.
  // Intentional contextless paths (device_commands agent-WS, auditAdminPool)
  // never reach here: auditAdminPool bypasses the proxy, and device_commands
  // is written under an explicit system context.
  if (process.env.STRICT_DB_CONTEXT === 'true') {
    throw new Error(`Contextless DB write blocked (STRICT_DB_CONTEXT): ${label}`);
  }
```

- [ ] **Step 3: Run the full integration suite WITH the gate on to discover violations**

Run:
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH \
  STRICT_DB_CONTEXT=true pnpm exec vitest run --config vitest.integration.config.ts
```
Expected: some tests THROW with `Contextless DB write blocked`. For each failure, read the stack and decide: **(a) a real bug** → fix the call-site to run under `withDbAccessContext`/`withSystemDbAccessContext` (this is the #1375 class — the entire point); or **(b) genuinely intentional** → wrap it in an explicit system context so it is no longer contextless (preferred over an allowlist, which the proxy guard has no clean hook for). Record each decision in the PR description.

- [ ] **Step 4: Re-run until green, then enable the gate in CI**

After all violations are resolved, set `STRICT_DB_CONTEXT=true` in the API test job(s) of `.github/workflows/ci.yml` (the `test-api` and integration jobs' `env:` block). Re-run locally to confirm green:
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH \
  STRICT_DB_CONTEXT=true pnpm exec vitest run --config vitest.integration.config.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/index.ts .github/workflows/ci.yml apps/api/src/  # + any call-site fixes
git commit -m "feat(observability): throw on contextless DB writes under STRICT_DB_CONTEXT in CI (#1379 A1)"
```

---

## Phase A3 — Generalized unauthenticated-route side-effect contract test

`login.test.ts:377` proves *one* site writes under a system context, but it mocks `db` — it can't prove the row actually moved under real `breeze_app` RLS. This adds a functional check against a real DB that the RLS-coverage test structurally cannot do. Ships with A1 or as its own PR.

### Task 4: `silent-write-contract.integration.test.ts`

**Files:**
- Create: `apps/api/src/__tests__/integration/silent-write-contract.integration.test.ts`

**Interfaces:**
- Consumes: the integration harness conventions (real `breeze_app` conn on test DB :5433, `autoMigrate` + per-test TRUNCATE, seed-fresh-per-`it`). Mirror an existing file in `apps/api/src/__tests__/integration/` for the exact imports/setup (e.g. `rls-coverage.integration.test.ts` or any `*.integration.test.ts` that seeds a user).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/integration/silent-write-contract.integration.test.ts`. Pattern: seed a user, capture `last_login_at` before, drive the real login route (or call the route's exported handler) end-to-end against `breeze_app`, then re-SELECT the row and assert the column actually changed. The assertion is the row movement — NOT a mock spy.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
// Import the real app/handler + the integration db helpers the same way a
// neighboring *.integration.test.ts does. Replace these with the actual
// harness exports used in this repo's integration suite.
import { testDb, seedUser, resetDb } from './helpers'; // match existing convention
import { app } from '../../index'; // or the auth route's app/handler

describe('silent-write contract: unauthenticated routes move their side-effect row (#1379 A3)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('POST /auth/login updates users.last_login_at under real breeze_app RLS', async () => {
    const user = await seedUser({ email: 'admin@msp.com', password: 'correct-horse', status: 'active' });

    const before = await testDb
      .select({ lastLogin: usersTable.lastLoginAt })
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    expect(before[0].lastLogin).toBeNull();

    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@msp.com', password: 'correct-horse' }),
    });
    expect(res.status).toBe(200);

    const after = await testDb
      .select({ lastLogin: usersTable.lastLoginAt })
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    // The #1375 bug froze this at NULL platform-wide. A functional row check
    // is the only thing that catches a future RLS regression that lets the
    // wrapper through but still denies the row.
    expect(after[0].lastLogin).not.toBeNull();
  });
});
```

> The implementer must align imports (`usersTable`, `eq`, `app`, the seed/reset helpers) with the actual exports used by existing integration tests — copy the header of a sibling file verbatim rather than inventing helper names.

- [ ] **Step 2: Run against the real test DB and watch it pass (or catch a regression)**

Run:
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH \
  pnpm exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/silent-write-contract.integration.test.ts
```
Expected: PASS (the route currently writes under a system context, so the row moves). A plain `:5432` dev-DB run will SKIP — that is expected; only the `vitest.integration.config.ts` path (`:5433`, `breeze_app`) is authoritative.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/silent-write-contract.integration.test.ts
git commit -m "test(observability): functional contract for unauthenticated-route side-effect writes (#1379 A3)"
```

---

## Phase B3 — `beforeSend` PII scrub + centralized rejection suppression + profiles knob

Scrub secrets before they leave the process, add a `profilesSampleRate` knob, and lift the hardcoded `unhandledRejection` suppression list out of `index.ts` into a tested predicate reused by B4. Ships as one PR (pairs naturally with B4).

### Task 5: Centralized rejection-suppression predicate

**Files:**
- Create: `apps/api/src/services/rejectionSuppressions.ts`
- Test: `apps/api/src/services/rejectionSuppressions.test.ts`

**Interfaces:**
- Produces: `isBenignRejection(reason: unknown): boolean` — true for the known SDK session-cleanup races currently inlined at `index.ts:1380-1386`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/rejectionSuppressions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isBenignRejection } from './rejectionSuppressions';

describe('isBenignRejection', () => {
  it('suppresses ProcessTransport-not-ready', () => {
    expect(isBenignRejection(new Error('ProcessTransport is not ready for writing'))).toBe(true);
  });
  it('suppresses AbortError by name', () => {
    const e = new Error('aborted'); e.name = 'AbortError';
    expect(isBenignRejection(e)).toBe(true);
  });
  it('suppresses "Operation aborted" + Transport', () => {
    expect(isBenignRejection(new Error('Operation aborted on Transport'))).toBe(true);
  });
  it('does NOT suppress a real error', () => {
    expect(isBenignRejection(new Error('TypeError: cannot read x of undefined'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/rejectionSuppressions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/services/rejectionSuppressions.ts` (lift the exact conditions from `index.ts:1380-1386`):

```ts
/**
 * Benign unhandled-rejection predicate (#1379 B3). Centralizes the SDK
 * session-cleanup races previously inlined in index.ts so the
 * unhandledRejection AND uncaughtException (B4) handlers share one list.
 */
export function isBenignRejection(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return (
    message.includes('ProcessTransport is not ready for writing') ||
    (reason instanceof Error && reason.name === 'AbortError') ||
    (message.includes('Operation aborted') && message.includes('Transport'))
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/rejectionSuppressions.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it in `index.ts`**

In `apps/api/src/index.ts`, add the import near line 144 (`import { captureException … }`):

```ts
import { isBenignRejection } from './services/rejectionSuppressions';
```

Replace the inlined condition in the `process.on('unhandledRejection', …)` block (lines 1380-1386) with:

```ts
  process.on('unhandledRejection', (reason) => {
    if (isBenignRejection(reason)) {
      const message = reason instanceof Error ? reason.message : String(reason);
      console.warn('[SDK] Suppressed benign unhandled rejection (session already closed):', message);
      return;
    }
    console.error('[FATAL] Unhandled rejection:', reason);
    captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/rejectionSuppressions.ts apps/api/src/services/rejectionSuppressions.test.ts apps/api/src/index.ts
git commit -m "refactor(observability): centralize benign-rejection suppression predicate (#1379 B3)"
```

### Task 6: `beforeSend` scrubber + `profilesSampleRate` knob

**Files:**
- Modify: `apps/api/src/services/sentry.ts` (`initSentry`, lines 26-35)
- Test: `apps/api/src/services/sentry.test.ts` (append)

**Interfaces:**
- Produces: a `scrubEvent(event)` pure function (exported for test) registered as Sentry's `beforeSend`; redacts `authorization`/`cookie` request headers and any `password`/`mfaSecret`/`brz_*`/token-shaped values in `extra`/`contexts`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/sentry.test.ts`:

```ts
import { scrubEvent } from './sentry';

describe('scrubEvent', () => {
  it('redacts authorization and cookie headers', () => {
    const out = scrubEvent({
      request: { headers: { authorization: 'Bearer brz_secret', cookie: 'session=abc', 'user-agent': 'x' } },
    } as any);
    expect(out.request.headers.authorization).toBe('[redacted]');
    expect(out.request.headers.cookie).toBe('[redacted]');
    expect(out.request.headers['user-agent']).toBe('x');
  });

  it('redacts password and mfaSecret in extra', () => {
    const out = scrubEvent({ extra: { password: 'p', mfaSecret: 's', orgId: 'o-1' } } as any);
    expect(out.extra.password).toBe('[redacted]');
    expect(out.extra.mfaSecret).toBe('[redacted]');
    expect(out.extra.orgId).toBe('o-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/sentry.test.ts`
Expected: FAIL — `scrubEvent is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/services/sentry.ts`, add the exported scrubber above `initSentry`:

```ts
const SENSITIVE_KEYS = new Set(['password', 'passwordhash', 'mfasecret', 'token', 'authorization', 'cookie']);

/** Redact secrets before an event leaves the process (#1379 B3). Exported for test. */
export function scrubEvent<T extends Record<string, any>>(event: T): T {
  const headers = event?.request?.headers;
  if (headers) {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'authorization' || k.toLowerCase() === 'cookie') headers[k] = '[redacted]';
    }
  }
  const extra = event?.extra;
  if (extra) {
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      if (SENSITIVE_KEYS.has(k.toLowerCase()) || (typeof v === 'string' && v.startsWith('brz_'))) {
        extra[k] = '[redacted]';
      }
    }
  }
  return event;
}
```

Then register it (and the profiles knob) in `Sentry.init` (lines 26-35):

```ts
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: API_VERSION,
    tracesSampleRate,
    profilesSampleRate: parseSampleRate(process.env.SENTRY_PROFILES_SAMPLE_RATE),
    beforeSend: (event) => scrubEvent(event)
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/sentry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/sentry.ts apps/api/src/services/sentry.test.ts
git commit -m "feat(observability): beforeSend PII scrub + profilesSampleRate knob (#1379 B3)"
```

---

## Phase B4 — `uncaughtException` handler + flush

`index.ts` handles `unhandledRejection` but a synchronous `uncaughtException` still exits silently with no Sentry event. Adds the handler, reusing B3's suppression predicate. Ships with B3.

### Task 7: `uncaughtException` handler

**Files:**
- Modify: `apps/api/src/index.ts` (alongside the `unhandledRejection` block, ~line 1389)

**Interfaces:**
- Consumes: `isBenignRejection` (Task 5), `captureException` + `flushSentry` (already imported at `index.ts:144`).

- [ ] **Step 1: Add the handler**

In `apps/api/src/index.ts`, immediately after the `process.on('unhandledRejection', …)` block closes (~line 1389), insert:

```ts
  // #1379 B4 — a synchronous uncaughtException otherwise tears the process
  // down with no telemetry. Capture + flush before exit; reuse the benign
  // suppression list so SDK races don't crash us.
  process.on('uncaughtException', (err) => {
    if (isBenignRejection(err)) {
      console.warn('[SDK] Suppressed benign uncaught exception:', err.message);
      return;
    }
    console.error('[FATAL] Uncaught exception:', err);
    captureException(err);
    // Best-effort drain, then exit non-zero so the supervisor restarts us.
    void flushSentry().finally(() => process.exit(1));
  });
```

Confirm `flushSentry` is imported at line 144 (it is). If not, add it to that import.

- [ ] **Step 2: Typecheck**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Sanity-run the API unit suite (no regressions in boot wiring)**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/services/rejectionSuppressions.test.ts src/services/sentry.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(observability): uncaughtException handler with capture + flush (#1379 B4)"
```

---

## Phase A2 — `dbWriteExpectingRows()` helper

Opt-in, zero-false-positive helper for the known self-write sites: asserts a write actually affected ≥1 row, catching a future RLS regression that lets the context wrapper through but still denies the row (the bug the A3 functional test catches at runtime, this catches at the call-site). Lowest priority — ships last, as its own PR. Do NOT add the generic "0-row UPDATE" warning (too noisy per the issue).

### Task 8: `dbWriteExpectingRows()` helper

**Files:**
- Create: `apps/api/src/db/dbWriteExpectingRows.ts`
- Test: `apps/api/src/db/dbWriteExpectingRows.test.ts`

**Interfaces:**
- Produces: `dbWriteExpectingRows<T>(label: string, run: () => Promise<T[]>): Promise<T[]>` — runs the write (which must `.returning()`), and if it resolves to 0 rows, `captureMessage('warning')` + `console.warn` with `label`, then returns the (empty) result unchanged. Never throws (opt-in observability, not a gate).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/dbWriteExpectingRows.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const captureMessage = vi.fn();
vi.mock('../services/sentry', () => ({ captureMessage }));

import { dbWriteExpectingRows } from './dbWriteExpectingRows';

describe('dbWriteExpectingRows', () => {
  beforeEach(() => captureMessage.mockClear());

  it('returns rows untouched and does NOT warn when ≥1 row moved', async () => {
    const out = await dbWriteExpectingRows('users.last_login_at', async () => [{ id: 'u-1' }]);
    expect(out).toEqual([{ id: 'u-1' }]);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('warns via captureMessage when 0 rows moved', async () => {
    const out = await dbWriteExpectingRows('users.last_login_at', async () => []);
    expect(out).toEqual([]);
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('users.last_login_at'),
      'warning',
      expect.any(Object)
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/db/dbWriteExpectingRows.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/db/dbWriteExpectingRows.ts`:

```ts
import { captureMessage } from '../services/sentry';

/**
 * Run a write that MUST move ≥1 row (use `.returning()`) and surface a 0-row
 * result as a Sentry warning (#1379 A2). Catches an RLS regression that lets
 * the context wrapper through but still denies the row — the #1375 class, at
 * the call-site. Opt-in and non-throwing: zero false positives, only wrap
 * sites you KNOW must affect a row (never idempotent upserts).
 */
export async function dbWriteExpectingRows<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
  const rows = await run();
  if (rows.length === 0) {
    const message = `Expected-rows write affected 0 rows: ${label}`;
    console.warn(message);
    captureMessage(message, 'warning', { label, stack: new Error().stack });
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/db/dbWriteExpectingRows.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply at one known self-write site (the #1375 canonical site)**

Find the `users.last_login_at` update on the login path (the site `login.test.ts:377` guards). Wrap it so the write uses `.returning({ id: users.id })` and goes through the helper, e.g.:

```ts
await dbWriteExpectingRows('users.last_login_at', () =>
  db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id)).returning({ id: users.id })
);
```

Keep it inside the existing `withSystemDbAccessContext` wrapper — the helper is additive, not a replacement.

- [ ] **Step 6: Run the login tests + typecheck**

Run:
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/routes/auth/login.test.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit
```
Expected: PASS, no type errors. (Update `login.test.ts` mocks if `.returning()` now needs a mocked return — return `[{ id: 'user-1' }]` from the update chain.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/dbWriteExpectingRows.ts apps/api/src/db/dbWriteExpectingRows.test.ts apps/api/src/routes/auth/  # + the wired site
git commit -m "feat(observability): dbWriteExpectingRows helper + apply to last_login_at (#1379 A2)"
```

---

## Out of scope for this plan

- **B5 — tracing/spans:** the `tracesSampleRate` and `profilesSampleRate` knobs exist (B3 adds the latter), but instrumenting spans is a separate, larger effort. Track separately if/when triage demand justifies it.
- **Already shipped:** B1 (#1380), B6 (#1805), warn-mode A1 guard (#1380), `captureMessage` (#1380). Do not redo.

## Self-Review notes

- **Spec coverage:** B2 (Task 1-2), A1 (Task 3), A3 (Task 4), B3 (Task 5-6), B4 (Task 7), A2 (Task 8). B5 explicitly deferred. B1/B6 done. All issue items accounted for.
- **Type consistency:** `setSentryRequestContext` signature is identical in Task 1 (definition) and Task 2 (call). `isBenignRejection` defined Task 5, reused Task 7. `captureMessage(message, level, extra)` matches the shipped signature at `sentry.ts:64`. `dbWriteExpectingRows<T>(label, run)` consistent across Task 8.
- **Discovery loops flagged:** Task 3 (STRICT_DB_CONTEXT surfaces unknown violations) and Task 4 (align helper imports to the actual integration harness) require live iteration — their steps say so explicitly rather than pretending the violation set is known up front.
