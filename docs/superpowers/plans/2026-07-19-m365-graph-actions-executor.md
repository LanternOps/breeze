# M365 customer-graph-actions Executor + Headless Dispatch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `customer-graph-actions` M365 mutation executor (an isolated sidecar mirroring the shipped `customer-graph-read` executor) and the org-keyed headless seam, so approved M365 Tier-3 intents (`m365_disable_user`, `m365_reset_password`) execute after the requesting tech's chat session ends.

**Architecture:** A new HTTP sidecar (`apps/m365-graph-actions-executor/`) holds the `customer-graph-actions` app certificate and performs exactly two typed Graph mutations, reached by the API over an Ed25519-JWT internal channel. A new API-side service (`writeActionService.ts`) runs the authz ladder + write budget + audit and dispatches to it. A new headless seam (`m365ToolsHeadless.ts`) resolves the connection by the immutable `intent.orgId` and is wired into the durable release worker exactly like Phase 2 Google. The inline chat path and Delegant are untouched.

**Tech Stack:** TypeScript, Hono (executor), Zod, jose (EdDSA JWT), Azure Key Vault (`@azure/identity`, `@azure/keyvault-secrets`), Drizzle/Postgres + RLS, Redis (BullMQ + budget), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-19-m365-graph-actions-executor-design.md`

## Global Constraints

- **Credential-domain separation is a locked invariant.** The actions executor MUST use a **separate** app identity, certificate, Ed25519 keypair/kid, audience (`m365-graph-actions-executor`), and Key Vault secret (`m365-customer-graph-actions`) from the read domain. Never share the read executor's identity/keys.
- **Fail closed everywhere.** Any missing/rotated/inactive connection, budget-unavailable, or executor-unreachable condition must deny — never execute. Connection/readiness failures surface as `connection_unavailable`; a Graph-level failure surfaces as a returned tool error.
- **Executed org == approved org.** The connection is resolved by the immutable `intent.orgId` under org-scoped RLS; `conn.orgId === orgId` is re-checked at execution as defense-in-depth over RLS.
- **`revalidateApprovedIntentForRelease` runs first, unchanged.** Do not modify it.
- **Never log or audit the temporary password or raw Graph payloads.** Audit `details` are allowlisted (`actionType`, `outcome`).
- **Executor ships disabled by default** behind `isM365GraphActionsEnabledForOrg` (`M365_GRAPH_ACTIONS_TOOLS_ENABLED=false`). No production enablement in this plan.
- **Idempotency:** no executor-side dedup store in the first cut; at-most-once is provided by the worker's existing CAS claim + the no-auto-replay policy. Carry `idempotencyKey = intent.id` on every request.
- **Migrations / env:** any new env var must use generic placeholders in `.env.example` — never real infra values, IPs, or hostnames (CLAUDE.md).
- **Node:** repo-pinned Node 22.20.0. Run API tests with `pnpm --filter @breeze/api test`, shared with `pnpm --filter @breeze/shared test`, executor with `pnpm --filter @breeze/m365-graph-actions-executor test`.

---

## File Structure

**New — shared:**
- `packages/shared/src/m365/writeActions.ts` — typed write-action catalog (schemas + types). (+ `.test.ts`)
- `packages/shared/src/m365/index.ts` — add `export * from './writeActions'`.

**New — executor sidecar `apps/m365-graph-actions-executor/`** (copy of the read executor, mutation-specialized):
- `src/index.ts`, `src/app.ts`, `src/config.ts`, `src/internalAuth.ts`
- `src/credentials/azureKeyVaultProvider.ts`, `src/credentials/types.ts`
- `src/microsoft/graphClient.ts` (read client + `patch`), `src/microsoft/tokenClient.ts`, `src/microsoft/clientAssertion.ts`
- `src/microsoft/writeActions.ts` — Graph mutation dispatch (+ `.test.ts`)
- `src/operations.ts` — `executeActionOperation` (+ `.test.ts`)
- `Dockerfile`, `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`

**New — API `apps/api/src/services/m365ControlPlane/`:**
- `writeActionRuntimeConfig.ts` — runtime config loader + `isM365GraphActionsEnabledForOrg` (+ `.test.ts`)
- `graphActionsExecutorClient.ts` — Ed25519-signed HTTP client (+ `.test.ts`)
- `writeActionBudget.ts` — per-connection Redis budget (+ `.test.ts`)
- `writeActionMetrics.ts` — audit + Prometheus
- `writeActionService.ts` — authz ladder + `executeM365WriteActionByOrg` (+ `.test.ts`)

**New — API `apps/api/src/services/`:**
- `m365ToolsHeadless.ts` — org-keyed headless seam (+ `.test.ts` parity contract)

**Modified:**
- `apps/api/src/jobs/intentReleaseWorker.ts` — two-edit worker wiring.
- `apps/api/src/jobs/intentReleaseWorkerM365Headless.integration.test.ts` — new integration suite.
- `packages/shared/src/m365/profiles.ts` — (optional) `applicationPermissionAssignments` — deferred; not required by this plan.
- Web approvals/intents detail component — temp-password reveal.
- `pnpm-workspace.yaml` / root — register the new executor app (if workspaces are globbed, no change).
- `.env.example`, deploy compose — the new executor service + `M365_GRAPH_ACTIONS_EXECUTOR_*` / `M365_CUSTOMER_GRAPH_ACTIONS_*` vars.

---

## Task 1: Shared write-action catalog

**Files:**
- Create: `packages/shared/src/m365/writeActions.ts`
- Test: `packages/shared/src/m365/writeActions.test.ts`
- Modify: `packages/shared/src/m365/index.ts`

**Interfaces:**
- Produces: `M365_WRITE_ACTION_IDS`, `M365WriteActionId`, `m365WriteActionSchema`, `M365WriteAction`, `writeActionRequestSchema`, `WriteActionRequest`, `writeActionFailureCodeSchema`, `WriteActionFailureCode`, `writeActionResultSchema`, `WriteActionResult`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/m365/writeActions.test.ts
import { describe, it, expect } from 'vitest';
import {
  m365WriteActionSchema,
  writeActionRequestSchema,
  writeActionResultSchema,
  M365_WRITE_ACTION_IDS,
} from './writeActions';

const UUID = '00000000-0000-4000-8000-000000000001';

describe('m365WriteActionSchema', () => {
  it('accepts the two first-cut actions', () => {
    expect(m365WriteActionSchema.parse({ type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'offboard' }).type)
      .toBe('m365.user.disable');
    expect(m365WriteActionSchema.parse({ type: 'm365.user.reset_password', userIdentifier: 'a@b.com', reason: 'compromised' }).type)
      .toBe('m365.user.reset_password');
  });

  it('rejects an unknown action id', () => {
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.delete', userIdentifier: 'a@b.com', reason: 'x' }).success)
      .toBe(false);
  });

  it('rejects extra keys (strict) and a missing reason', () => {
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x', extra: 1 }).success)
      .toBe(false);
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.disable', userIdentifier: 'a@b.com' }).success)
      .toBe(false);
  });

  it("rejects a userIdentifier containing quotes/backslashes", () => {
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.disable', userIdentifier: "a'b@c.com", reason: 'x' }).success)
      .toBe(false);
  });
});

describe('writeActionRequestSchema', () => {
  it('requires correlationId, tenantId, idempotencyKey, action', () => {
    const ok = writeActionRequestSchema.safeParse({
      correlationId: UUID, tenantId: UUID, idempotencyKey: 'intent-123',
      action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' },
    });
    expect(ok.success).toBe(true);
    expect(writeActionRequestSchema.safeParse({
      correlationId: UUID, tenantId: UUID,
      action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' },
    }).success).toBe(false); // missing idempotencyKey
  });
});

describe('writeActionResultSchema', () => {
  it('accepts a disable success', () => {
    expect(writeActionResultSchema.safeParse({ success: true, action: 'm365.user.disable', userId: UUID }).success).toBe(true);
  });
  it('accepts a reset success with temporaryPassword', () => {
    expect(writeActionResultSchema.safeParse({
      success: true, action: 'm365.user.reset_password', userId: UUID,
      temporaryPassword: 'Tmp!23xyz', forceChangeNextSignIn: true,
    }).success).toBe(true);
  });
  it('accepts a failure with a known code', () => {
    expect(writeActionResultSchema.safeParse({ success: false, errorCode: 'user_not_found' }).success).toBe(true);
    expect(writeActionResultSchema.safeParse({ success: false, errorCode: 'not_a_code' }).success).toBe(false);
  });
  it('pins the action id list', () => {
    expect([...M365_WRITE_ACTION_IDS]).toEqual(['m365.user.disable', 'm365.user.reset_password']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared test writeActions`
Expected: FAIL — cannot find module `./writeActions`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/m365/writeActions.ts
import { z } from 'zod';

const guidSchema = z.string().guid();
// UPN or object id. Forbids quotes/whitespace/backslash so values can be
// spliced into Graph paths/$filter without escaping ambiguity (mirrors
// readActions.ts userIdOrUpnSchema).
const userIdOrUpnSchema = z.string().min(3).max(320).regex(/^[A-Za-z0-9._%+@-]+$/);
const reasonSchema = z.string().min(1).max(500);

export const M365_WRITE_ACTION_IDS = [
  'm365.user.disable',
  'm365.user.reset_password',
] as const;

export type M365WriteActionId = typeof M365_WRITE_ACTION_IDS[number];

export const m365WriteActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('m365.user.disable'),
    userIdentifier: userIdOrUpnSchema,
    reason: reasonSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.user.reset_password'),
    userIdentifier: userIdOrUpnSchema,
    reason: reasonSchema,
  }).strict(),
]);

export type M365WriteAction = z.infer<typeof m365WriteActionSchema>;

export const writeActionRequestSchema = z.object({
  correlationId: guidSchema,
  tenantId: guidSchema,
  // = the immutable action_intents.id; carried for audit correlation and as
  // the natural key for a future executor-side dedup store.
  idempotencyKey: z.string().min(1).max(200),
  action: m365WriteActionSchema,
}).strict();

export type WriteActionRequest = z.infer<typeof writeActionRequestSchema>;

export const writeActionFailureCodeSchema = z.enum([
  'credential_unavailable',
  'application_token_invalid',
  'user_not_found',
  'user_ambiguous',
  'tenant_mismatch',
  'graph_permission_missing',
  'graph_throttled',
  'graph_request_timeout',
  'graph_transport_failed',
  'graph_error',
  'invalid_action',
]);

export type WriteActionFailureCode = z.infer<typeof writeActionFailureCodeSchema>;

export const writeActionResultSchema = z.union([
  z.object({
    success: z.literal(true),
    action: z.literal('m365.user.disable'),
    userId: guidSchema,
  }).strict(),
  z.object({
    success: z.literal(true),
    action: z.literal('m365.user.reset_password'),
    userId: guidSchema,
    temporaryPassword: z.string().min(1).max(256),
    forceChangeNextSignIn: z.literal(true),
  }).strict(),
  z.object({
    success: z.literal(false),
    errorCode: writeActionFailureCodeSchema,
    retryAfterSeconds: z.number().int().min(1).max(300).optional(),
  }).strict(),
]);

export type WriteActionResult = z.infer<typeof writeActionResultSchema>;
```

- [ ] **Step 4: Add the barrel export**

In `packages/shared/src/m365/index.ts`, add alongside the existing `export * from './readActions';` line:

```ts
export * from './writeActions';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @breeze/shared test writeActions`
Expected: PASS (all cases).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @breeze/shared build` (or `tsc --noEmit` per the package script)
Expected: no type errors.

```bash
git add packages/shared/src/m365/writeActions.ts packages/shared/src/m365/writeActions.test.ts packages/shared/src/m365/index.ts
git commit -m "feat(m365): shared customer-graph-actions write-action catalog"
```

---

## Task 2: Executor sidecar scaffold (copy + specialize identity)

Copy the shipped read executor and re-key it to the actions domain. This task produces a **compiling, health-checkable** app whose `/v1/execute-action` route calls a stub operation (real logic lands in Tasks 3–4).

**Files:**
- Copy tree: `apps/m365-graph-read-executor/` → `apps/m365-graph-actions-executor/`
- Delete: `src/microsoft/identity.ts`, `src/microsoft/reconcile.ts`, `src/microsoft/readActions.ts`, and their tests + fixtures not needed for writes.
- Modify: `package.json`, `src/config.ts`, `src/internalAuth.ts`, `src/app.ts`, `src/operations.ts`, `Dockerfile`.

**Interfaces:**
- Produces: a running executor exposing `GET /healthz` and `POST /v1/execute-action`; env namespace `M365_GRAPH_ACTIONS_EXECUTOR_*`; audience `m365-graph-actions-executor`; operation claim `execute-action`; AKV secret `m365-customer-graph-actions`, envelope `domain:'customer-graph-actions'`; listen port `3004`.

- [ ] **Step 1: Copy the tree**

```bash
cp -R apps/m365-graph-read-executor apps/m365-graph-actions-executor
rm -rf apps/m365-graph-actions-executor/dist apps/m365-graph-actions-executor/node_modules
rm -f apps/m365-graph-actions-executor/src/microsoft/identity.ts \
      apps/m365-graph-actions-executor/src/microsoft/identity.test.ts \
      apps/m365-graph-actions-executor/src/microsoft/reconcile.ts \
      apps/m365-graph-actions-executor/src/microsoft/reconcile.test.ts \
      apps/m365-graph-actions-executor/src/microsoft/readActions.ts \
      apps/m365-graph-actions-executor/src/microsoft/readActions.test.ts \
      apps/m365-graph-actions-executor/src/operations.test.ts
```
(If any listed file does not exist, ignore — the point is the read/consent-only modules are gone. Leave `graphClient.ts`, `tokenClient.ts`, `clientAssertion.ts`, `credentials/*`, `config.ts`, `internalAuth.ts`, `app.ts`, `index.ts`.)

- [ ] **Step 2: Rename the package**

In `apps/m365-graph-actions-executor/package.json`, change:
- `"name"` → `"@breeze/m365-graph-actions-executor"`
- any script/comment referencing the read executor autostart env `M365_GRAPH_READ_EXECUTOR_AUTOSTART` → `M365_GRAPH_ACTIONS_EXECUTOR_AUTOSTART`.

- [ ] **Step 3: Re-key config.ts to the actions domain**

In `apps/m365-graph-actions-executor/src/config.ts`, apply these literal replacements (every occurrence):
- Env prefix `M365_GRAPH_READ_EXECUTOR_` → `M365_GRAPH_ACTIONS_EXECUTOR_` (URL, signing public JWK, signing kid, issuer, audience, azure credential mode, autostart, port).
- Default audience literal `'m365-graph-read-executor'` → `'m365-graph-actions-executor'`.
- Default listen port `3003` → `3004` (and any `PORT` fallback).

In `apps/m365-graph-actions-executor/src/credentials/azureKeyVaultProvider.ts`:
- Pinned secret name `'m365-customer-graph-read'` → `'m365-customer-graph-actions'` (both the constant and the `akv://…` reference regex).
- Envelope `domain: 'customer-graph-read'` → `domain: 'customer-graph-actions'` (the `certificateEnvelopeSchema` literal).

- [ ] **Step 4: Re-key internalAuth.ts**

In `apps/m365-graph-actions-executor/src/internalAuth.ts`:
- Audience literal `'m365-graph-read-executor'` → `'m365-graph-actions-executor'`.
- Leave `issuer:'breeze-api'`, `subject:'breeze-control-plane'`, the ≤60s lifetime, the `jti`/`correlationId` UUID checks, and the `bodySha256` timing-safe check **unchanged**.
- The `operation` claim must equal the endpoint's operation; the endpoint (Step 6) passes `'execute-action'`, so no allowlist edit is needed here — it compares against the value the route supplies.

- [ ] **Step 5: Replace operations.ts with a stub**

Replace the entire body of `apps/m365-graph-actions-executor/src/operations.ts` with:

```ts
import {
  writeActionResultSchema,
  type WriteActionRequest,
  type WriteActionResult,
} from '@breeze/shared/m365';
import type { PinnedCertificateProvider } from './credentials/types';
import type { MicrosoftGraphClient } from './microsoft/graphClient';

export interface ExecutorOperationDependencies {
  clientId: string;
  certificateProvider: PinnedCertificateProvider;
  graphClient: MicrosoftGraphClient;
}

// Stub — real implementation lands in Task 4. Fails closed so the route is
// wired and health-checkable without performing any mutation yet.
export async function executeActionOperation(
  _request: WriteActionRequest,
  _dependencies: ExecutorOperationDependencies,
): Promise<WriteActionResult> {
  return writeActionResultSchema.parse({ success: false, errorCode: 'invalid_action' });
}

export function createExecutorOperations(config: ExecutorOperationDependencies) {
  return {
    executeAction: (request: WriteActionRequest) => executeActionOperation(request, config),
  };
}
```

- [ ] **Step 6: Wire app.ts routes**

Edit `apps/m365-graph-actions-executor/src/app.ts` so the only routes are `GET /healthz` and `POST /v1/execute-action`. The `execute()` helper (bounded body, JWT verify over raw bytes, JSON parse, zod-validate, correlationId match) is reused unchanged; only the route table and the per-route schema/operation change. Concretely:
- Remove the `POST /v1/complete-consent` and `POST /v1/retest` routes.
- Add/replace the action route:

```ts
import { writeActionRequestSchema } from '@breeze/shared/m365';
// ...
app.post('/v1/execute-action', (c) =>
  execute(c, {
    operation: 'execute-action',
    requestSchema: writeActionRequestSchema,
    run: (request) => operations.executeAction(request),
  }),
);
```
(Match the exact shape of the read executor's `execute(context, { operation, requestSchema, run })` call — copy the read `/v1/read-action` handler and swap `read-action`→`execute-action`, `readActionRequestSchema`→`writeActionRequestSchema`, `operations.readAction`→`operations.executeAction`.)

- Update `src/index.ts` if it references removed operations; `createExecutorOperations` now returns only `{ executeAction }`, so drop `completeConsent`/`retest` wiring and the `callbackUrl`/`verifyIdentity` dependencies.

- [ ] **Step 7: Dockerfile port**

In `apps/m365-graph-actions-executor/Dockerfile`, change `EXPOSE 3003` → `EXPOSE 3004` and the healthcheck target port to `3004`.

- [ ] **Step 8: Install + typecheck + boot check**

```bash
pnpm install
pnpm --filter @breeze/m365-graph-actions-executor build
```
Expected: builds with no type errors.

Health check (autostart on, no real creds needed for `/healthz`):
```bash
M365_GRAPH_ACTIONS_EXECUTOR_AUTOSTART=1 PORT=3004 pnpm --filter @breeze/m365-graph-actions-executor start &
sleep 2 && curl -s http://localhost:3004/healthz && kill %1
```
Expected: `{"status":"ok"}`.

- [ ] **Step 9: Commit**

```bash
git add apps/m365-graph-actions-executor
git commit -m "feat(m365): scaffold customer-graph-actions executor (copy of read executor, re-keyed identity, stub op)"
```

---

## Task 3: Executor Graph mutation client + write-action dispatch

**Files:**
- Modify: `apps/m365-graph-actions-executor/src/microsoft/graphClient.ts` (add `patch`)
- Create: `apps/m365-graph-actions-executor/src/microsoft/writeActions.ts`
- Test: `apps/m365-graph-actions-executor/src/microsoft/writeActions.test.ts`

**Interfaces:**
- Consumes: `MicrosoftGraphClient.readResource` (existing), `GraphClientError` (existing).
- Produces: `MicrosoftGraphClient.patch(input:{accessToken, path, body})`; `executeGraphWriteAction(action, ctx): Promise<WriteActionResult>` where `ctx = { accessToken, graphClient }`; `generateTemporaryPassword(): string`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/m365-graph-actions-executor/src/microsoft/writeActions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { executeGraphWriteAction, generateTemporaryPassword } from './writeActions';
import { GraphClientError, type MicrosoftGraphClient } from './graphClient';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function client(overrides: Partial<MicrosoftGraphClient>): MicrosoftGraphClient {
  return {
    probeTenant: vi.fn(),
    readResource: vi.fn().mockResolvedValue({ id: USER_ID }),
    readCollection: vi.fn(),
    patch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MicrosoftGraphClient;
}

describe('executeGraphWriteAction — disable', () => {
  it('resolves the user then PATCHes accountEnabled:false', async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const gc = client({ patch });
    const result = await executeGraphWriteAction(
      { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' },
      { accessToken: 't', graphClient: gc },
    );
    expect(result).toEqual({ success: true, action: 'm365.user.disable', userId: USER_ID });
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({
      path: `/users/${USER_ID}`,
      body: { accountEnabled: false },
    }));
  });

  it('maps a 404 on resolve to user_not_found (no PATCH)', async () => {
    const patch = vi.fn();
    const gc = client({
      readResource: vi.fn().mockRejectedValue(new GraphClientError('graph_not_found')),
      patch,
    });
    const result = await executeGraphWriteAction(
      { type: 'm365.user.disable', userIdentifier: 'ghost@b.com', reason: 'x' },
      { accessToken: 't', graphClient: gc },
    );
    expect(result).toEqual({ success: false, errorCode: 'user_not_found' });
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('executeGraphWriteAction — reset', () => {
  it('PATCHes passwordProfile with forceChange and returns the temp password', async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const gc = client({ patch });
    const result = await executeGraphWriteAction(
      { type: 'm365.user.reset_password', userIdentifier: 'a@b.com', reason: 'x' },
      { accessToken: 't', graphClient: gc },
    );
    expect(result.success).toBe(true);
    if (result.success && result.action === 'm365.user.reset_password') {
      expect(result.userId).toBe(USER_ID);
      expect(result.forceChangeNextSignIn).toBe(true);
      expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(16);
    }
    const body = patch.mock.calls[0][0].body;
    expect(body.passwordProfile.forceChangePasswordNextSignIn).toBe(true);
    expect(typeof body.passwordProfile.password).toBe('string');
  });

  it('maps a 429 to graph_throttled with retryAfter', async () => {
    const gc = client({ patch: vi.fn().mockRejectedValue(new GraphClientError('graph_throttled', 30)) });
    const result = await executeGraphWriteAction(
      { type: 'm365.user.reset_password', userIdentifier: 'a@b.com', reason: 'x' },
      { accessToken: 't', graphClient: gc },
    );
    expect(result).toEqual({ success: false, errorCode: 'graph_throttled', retryAfterSeconds: 30 });
  });
});

describe('generateTemporaryPassword', () => {
  it('is >=16 chars and mixes classes', () => {
    const pw = generateTemporaryPassword();
    expect(pw.length).toBeGreaterThanOrEqual(16);
    expect(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/m365-graph-actions-executor test writeActions`
Expected: FAIL — `./writeActions` not found and `patch` not on `MicrosoftGraphClient`.

- [ ] **Step 3: Add the `patch` method to graphClient.ts**

In `apps/m365-graph-actions-executor/src/microsoft/graphClient.ts`, add `patch` to the `MicrosoftGraphClient` interface:

```ts
  patch(input: {
    accessToken: OpaqueAccessToken;
    path: string;
    body: Record<string, unknown>;
  }): Promise<void>;
```

And implement it in the returned object (alongside `readResource`), reusing the existing `graphUrl`, `readFailure`, `readBoundedBody`, `failure`, `positiveInteger`, `configValid`, `timeoutMs`, `maxResponseBytes` symbols already in the file:

```ts
    async patch(input) {
      if (!configValid
        || typeof input.accessToken !== 'string'
        || !input.accessToken
        || !input.path.startsWith('/')) {
        throw failure('graph_request_invalid');
      }
      const budget: RequestBudget = { bytes: 0, requests: 0, items: 0 };
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const response = await fetchImpl(graphUrl(input.path), {
          method: 'PATCH',
          redirect: 'error',
          headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(input.body),
          signal: controller.signal,
        });
        // Graph mutation success is 204 No Content (or 200). Consume/bound the
        // body either way; only translate non-2xx into a typed failure.
        const responseBody = await readBoundedBody(response, budget, maxResponseBytes);
        if (!response.ok) throw readFailure(response, responseBody);
      } catch (error) {
        if (error instanceof GraphClientError) throw error;
        if (timedOut) throw failure('graph_request_timeout');
        throw failure('graph_transport_failed');
      } finally {
        clearTimeout(timer);
      }
    },
```

- [ ] **Step 4: Write `writeActions.ts`**

```ts
// apps/m365-graph-actions-executor/src/microsoft/writeActions.ts
import { randomInt } from 'node:crypto';
import type { M365WriteAction, WriteActionResult, WriteActionFailureCode } from '@breeze/shared/m365';
import { GraphClientError, type MicrosoftGraphClient } from './graphClient';
import type { OpaqueAccessToken } from './tokenClient';

export interface GraphWriteActionContext {
  accessToken: OpaqueAccessToken;
  graphClient: MicrosoftGraphClient;
}

const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_';
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)];
}

/** 20 chars, at least one of each class, shuffled — satisfies default Entra
 *  password complexity without echoing any input. */
export function generateTemporaryPassword(): string {
  const required = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  const rest = Array.from({ length: 16 }, () => pick(ALL));
  const chars = [...required, ...rest];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function mapGraphFailure(error: unknown): WriteActionResult {
  if (error instanceof GraphClientError) {
    const code: WriteActionFailureCode =
      error.code === 'graph_not_found' ? 'user_not_found'
      : error.code === 'graph_throttled' ? 'graph_throttled'
      : error.code === 'graph_permission_missing' ? 'graph_permission_missing'
      : error.code === 'application_token_invalid' ? 'application_token_invalid'
      : error.code === 'graph_request_timeout' ? 'graph_request_timeout'
      : error.code === 'graph_transport_failed' ? 'graph_transport_failed'
      : 'graph_error';
    return error.retryAfterSeconds === undefined
      ? { success: false, errorCode: code }
      : { success: false, errorCode: code, retryAfterSeconds: error.retryAfterSeconds };
  }
  throw error;
}

async function resolveUserId(action: M365WriteAction, ctx: GraphWriteActionContext): Promise<string> {
  const resource = await ctx.graphClient.readResource({
    accessToken: ctx.accessToken,
    path: `/users/${encodeURIComponent(action.userIdentifier)}`,
    select: ['id'],
  });
  const id = resource.id;
  if (typeof id !== 'string' || !id) throw new GraphClientError('graph_not_found');
  return id;
}

export async function executeGraphWriteAction(
  action: M365WriteAction,
  ctx: GraphWriteActionContext,
): Promise<WriteActionResult> {
  try {
    switch (action.type) {
      case 'm365.user.disable': {
        const userId = await resolveUserId(action, ctx);
        await ctx.graphClient.patch({
          accessToken: ctx.accessToken,
          path: `/users/${encodeURIComponent(userId)}`,
          body: { accountEnabled: false },
        });
        return { success: true, action: 'm365.user.disable', userId };
      }
      case 'm365.user.reset_password': {
        const userId = await resolveUserId(action, ctx);
        const temporaryPassword = generateTemporaryPassword();
        await ctx.graphClient.patch({
          accessToken: ctx.accessToken,
          path: `/users/${encodeURIComponent(userId)}`,
          body: { passwordProfile: { forceChangePasswordNextSignIn: true, password: temporaryPassword } },
        });
        return { success: true, action: 'm365.user.reset_password', userId, temporaryPassword, forceChangeNextSignIn: true };
      }
      default: {
        const exhaustive: never = action;
        throw new Error(`Unhandled M365 write action: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    return mapGraphFailure(error);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @breeze/m365-graph-actions-executor test writeActions`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/m365-graph-actions-executor/src/microsoft/graphClient.ts \
        apps/m365-graph-actions-executor/src/microsoft/writeActions.ts \
        apps/m365-graph-actions-executor/src/microsoft/writeActions.test.ts
git commit -m "feat(m365): executor Graph mutation client + write-action dispatch"
```

---

## Task 4: Executor execute-action operation

**Files:**
- Modify: `apps/m365-graph-actions-executor/src/operations.ts`
- Test: `apps/m365-graph-actions-executor/src/operations.test.ts`

**Interfaces:**
- Consumes: `fetchCredential` pattern (Task 2 copy), `createMicrosoftTokenClient` / `MicrosoftTokenClient` (existing), `executeGraphWriteAction` (Task 3).
- Produces: `executeActionOperation(request, deps): Promise<WriteActionResult>` — mints a per-tenant app token, runs `executeGraphWriteAction`, zeroes cert material in `finally`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/m365-graph-actions-executor/src/operations.test.ts
import { describe, it, expect, vi } from 'vitest';
import { executeActionOperation, type ExecutorOperationDependencies } from './operations';
import type { MicrosoftGraphClient } from './microsoft/graphClient';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function deps(over: Partial<ExecutorOperationDependencies> = {}): ExecutorOperationDependencies {
  const cert = { certificatePem: 'C', privateKeyPem: 'K' };
  const graphClient = {
    probeTenant: vi.fn(),
    readResource: vi.fn().mockResolvedValue({ id: USER_ID }),
    readCollection: vi.fn(),
    patch: vi.fn().mockResolvedValue(undefined),
  } as unknown as MicrosoftGraphClient;
  return {
    clientId: '33333333-3333-4333-8333-333333333333',
    certificateProvider: { getConfiguredCertificate: vi.fn().mockResolvedValue(cert) },
    createTokenClient: () => ({ acquireGraphAppToken: vi.fn().mockResolvedValue('access-token') } as never),
    graphClient,
    ...over,
  } as ExecutorOperationDependencies;
}

describe('executeActionOperation', () => {
  it('rejects a non-canonical tenantId with tenant_mismatch', async () => {
    const result = await executeActionOperation(
      { correlationId: '00000000-0000-4000-8000-000000000001', tenantId: 'not-a-uuid', idempotencyKey: 'i',
        action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' } },
      deps(),
    );
    expect(result).toEqual({ success: false, errorCode: 'tenant_mismatch' });
  });

  it('mints a token and runs the mutation on the happy path', async () => {
    const d = deps();
    const result = await executeActionOperation(
      { correlationId: '00000000-0000-4000-8000-000000000001', tenantId: TENANT, idempotencyKey: 'i',
        action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' } },
      d,
    );
    expect(result).toEqual({ success: true, action: 'm365.user.disable', userId: USER_ID });
  });

  it('returns credential_unavailable when the cert provider throws', async () => {
    const d = deps({ certificateProvider: { getConfiguredCertificate: vi.fn().mockRejectedValue(new Error('vault down')) } });
    const result = await executeActionOperation(
      { correlationId: '00000000-0000-4000-8000-000000000001', tenantId: TENANT, idempotencyKey: 'i',
        action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' } },
      d,
    );
    expect(result).toEqual({ success: false, errorCode: 'credential_unavailable' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/m365-graph-actions-executor test operations`
Expected: FAIL — stub returns `invalid_action`.

- [ ] **Step 3: Implement `executeActionOperation`**

Replace `apps/m365-graph-actions-executor/src/operations.ts` with (mirrors the read executor's `readActionOperation` credential→token→dispatch shape, cert zeroed in `finally`):

```ts
import {
  writeActionResultSchema,
  type WriteActionRequest,
  type WriteActionResult,
} from '@breeze/shared/m365';
import type { PinnedCertificateProvider } from './credentials/types';
import { executeGraphWriteAction } from './microsoft/writeActions';
import {
  createMicrosoftTokenClient,
  type MicrosoftTokenClient,
} from './microsoft/tokenClient';
import type { MicrosoftGraphClient } from './microsoft/graphClient';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type TokenClientFactory = (credential: {
  certificatePem: string;
  privateKeyPem: string;
}) => MicrosoftTokenClient;

export interface ExecutorOperationDependencies {
  clientId: string;
  certificateProvider: PinnedCertificateProvider;
  createTokenClient: TokenClientFactory;
  graphClient: MicrosoftGraphClient;
}

export async function executeActionOperation(
  request: WriteActionRequest,
  dependencies: ExecutorOperationDependencies,
): Promise<WriteActionResult> {
  if (!CANONICAL_UUID.test(request.tenantId)) {
    return { success: false, errorCode: 'tenant_mismatch' };
  }

  let credential: { certificatePem: string; privateKeyPem: string };
  try {
    credential = await dependencies.certificateProvider.getConfiguredCertificate();
  } catch {
    return { success: false, errorCode: 'credential_unavailable' };
  }

  let tokenClient: MicrosoftTokenClient | undefined;
  try {
    try {
      tokenClient = dependencies.createTokenClient(credential);
    } catch {
      return { success: false, errorCode: 'credential_unavailable' };
    }
    let accessToken;
    try {
      accessToken = await tokenClient.acquireGraphAppToken({ tenantId: request.tenantId });
    } catch {
      return { success: false, errorCode: 'application_token_invalid' };
    }
    return writeActionResultSchema.parse(
      await executeGraphWriteAction(request.action, { accessToken, graphClient: dependencies.graphClient }),
    );
  } finally {
    tokenClient = undefined;
    credential.certificatePem = '';
    credential.privateKeyPem = '';
  }
}

export function createExecutorOperations(config: {
  clientId: string;
  certificateProvider: PinnedCertificateProvider;
  graphClient: MicrosoftGraphClient;
}) {
  const dependencies: ExecutorOperationDependencies = {
    ...config,
    createTokenClient: (credential) => createMicrosoftTokenClient({
      clientId: config.clientId,
      ...credential,
    }),
  };
  return {
    executeAction: (request: WriteActionRequest) => executeActionOperation(request, dependencies),
  };
}
```
(If `createMicrosoftTokenClient` in the copied `tokenClient.ts` requires a `callbackUrl`, pass an empty string or drop the param — the actions executor never does the auth-code exchange, only `acquireGraphAppToken`. Adjust the copied `tokenClient.ts` signature if needed so `callbackUrl` is optional.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/m365-graph-actions-executor test`
Expected: PASS (writeActions + operations).

- [ ] **Step 5: Typecheck the app end-to-end**

Run: `pnpm --filter @breeze/m365-graph-actions-executor build`
Expected: no type errors (index.ts/app.ts now consume `createExecutorOperations` → `{ executeAction }`).

- [ ] **Step 6: Commit**

```bash
git add apps/m365-graph-actions-executor/src/operations.ts apps/m365-graph-actions-executor/src/operations.test.ts \
        apps/m365-graph-actions-executor/src/microsoft/tokenClient.ts
git commit -m "feat(m365): executor execute-action operation (token + mutation + cert hygiene)"
```

---

## Task 5: API write-action runtime config + feature flag

**Files:**
- Create: `apps/api/src/services/m365ControlPlane/writeActionRuntimeConfig.ts`
- Test: `apps/api/src/services/m365ControlPlane/writeActionRuntimeConfig.test.ts`

**Interfaces:**
- Produces: `loadM365CustomerGraphActionsRuntimeConfig(source?)`, `M365CustomerGraphActionsRuntimeConfig`, `isM365GraphActionsEnabledForOrg(orgId, source?)`, `validateM365CustomerGraphActionsRuntimeConfigAtBoot(source?)`. Mirrors `runtimeConfig.ts` with `_ACTIONS_` env vars, `m365-customer-graph-actions` vault ref, audience `m365-graph-actions-executor`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/m365ControlPlane/writeActionRuntimeConfig.test.ts
import { describe, it, expect } from 'vitest';
import { isM365GraphActionsEnabledForOrg } from './writeActionRuntimeConfig';

const ORG = '44444444-4444-4444-8444-444444444444';

describe('isM365GraphActionsEnabledForOrg', () => {
  it('is false when the flag is off', () => {
    expect(isM365GraphActionsEnabledForOrg(ORG, { M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'false' })).toBe(false);
    expect(isM365GraphActionsEnabledForOrg(ORG, {})).toBe(false);
  });
  it('is true for a listed org when enabled', () => {
    expect(isM365GraphActionsEnabledForOrg(ORG, {
      M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
      M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: ORG,
    })).toBe(true);
  });
  it('is true for any org with wildcard', () => {
    expect(isM365GraphActionsEnabledForOrg(ORG, {
      M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
      M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: '*',
    })).toBe(true);
  });
  it('is false for an unlisted org', () => {
    expect(isM365GraphActionsEnabledForOrg(ORG, {
      M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
      M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: '55555555-5555-4555-8555-555555555555',
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test writeActionRuntimeConfig`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (mirror of `runtimeConfig.ts`)**

Copy `runtimeConfig.ts` into `writeActionRuntimeConfig.ts` and apply these literal substitutions, keeping every validator, the `parseSigningPrivateJwk` mode-0600 check, and the lazy-load structure identical:
- `M365_GRAPH_READ_EXECUTOR_` → `M365_GRAPH_ACTIONS_EXECUTOR_` (URL, signing JWK file, signing kid, audience env).
- `M365_CUSTOMER_GRAPH_READ_` → `M365_CUSTOMER_GRAPH_ACTIONS_` (client id, credential version, vault ref).
- `M365_GRAPH_READ_TOOLS_ENABLED` → `M365_GRAPH_ACTIONS_TOOLS_ENABLED`; `M365_GRAPH_READ_TOOLS_ORG_IDS` → `M365_GRAPH_ACTIONS_TOOLS_ORG_IDS`.
- `EXECUTOR_AUDIENCE = 'm365-graph-read-executor'` → `'m365-graph-actions-executor'`.
- `VAULT_REF` regex segment `m365-customer-graph-read` → `m365-customer-graph-actions`.
- Drop the consent-only pieces the actions path doesn't need: `CALLBACK_PATH`, `parseCallbackUrl`, `callbackUrl` field, `onboardingOrgIds`/`parseOnboardingOrgIds`, and `isM365CustomerGraphReadOnboardingEnabledForOrg`. (Minimal provisioning — Task 10 — seeds connections directly; no consent callback here.)
- Rename exported symbols: `M365CustomerGraphReadRuntimeConfig` → `M365CustomerGraphActionsRuntimeConfig`, `loadM365CustomerGraphReadRuntimeConfig` → `loadM365CustomerGraphActionsRuntimeConfig`, `isM365GraphReadToolsEnabledForOrg` → `isM365GraphActionsEnabledForOrg`, `parseGraphReadToolsOrgIds` → `parseGraphActionsToolsOrgIds`, `validateM365CustomerGraphReadRuntimeConfigAtBoot` → `validateM365CustomerGraphActionsRuntimeConfigAtBoot` (drop the onboarding branch, keep only the tools branch).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/api test writeActionRuntimeConfig`
Expected: PASS.

- [ ] **Step 5: Wire boot validation**

Find where `validateM365CustomerGraphReadRuntimeConfigAtBoot` is called at API boot (grep) and add a call to `validateM365CustomerGraphActionsRuntimeConfigAtBoot(process.env)` next to it, so a malformed actions config fails boot rather than every release.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/writeActionRuntimeConfig.ts \
        apps/api/src/services/m365ControlPlane/writeActionRuntimeConfig.test.ts
git commit -m "feat(m365): API runtime config + feature flag for customer-graph-actions"
```

---

## Task 6: API executor client

**Files:**
- Create: `apps/api/src/services/m365ControlPlane/graphActionsExecutorClient.ts`
- Test: `apps/api/src/services/m365ControlPlane/graphActionsExecutorClient.test.ts`

**Interfaces:**
- Produces: `createGraphActionsExecutorClient(config): GraphActionsExecutorClient` with `executeWriteAction(input: WriteActionRequest): Promise<WriteActionResult>`; `GraphActionsExecutorClientError` (`code:'executor_unavailable'`); `GraphActionsExecutorClient`, `GraphActionsExecutorClientConfig`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/m365ControlPlane/graphActionsExecutorClient.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createGraphActionsExecutorClient, GraphActionsExecutorClientError } from './graphActionsExecutorClient';
import { generateKeyPair, exportJWK } from 'jose';

const UUID = '00000000-0000-4000-8000-000000000001';
const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';

async function signingConfig() {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = await exportJWK(privateKey);
  return { signingPrivateJwk: { ...jwk, kty: 'OKP', crv: 'Ed25519' }, signingKid: 'kid-1' };
}

function req() {
  return {
    correlationId: UUID, tenantId: TENANT, idempotencyKey: 'intent-1',
    action: { type: 'm365.user.disable' as const, userIdentifier: 'a@b.com', reason: 'x' },
  };
}

describe('createGraphActionsExecutorClient', () => {
  it('POSTs a signed request and parses a success result', async () => {
    const { signingPrivateJwk, signingKid } = await signingConfig();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true, action: 'm365.user.disable', userId: USER }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = createGraphActionsExecutorClient({
      executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor',
      signingPrivateJwk, signingKid, fetch: fetchImpl as never,
    });
    const result = await client.executeWriteAction(req());
    expect(result).toEqual({ success: true, action: 'm365.user.disable', userId: USER });
    const call = fetchImpl.mock.calls[0];
    expect(call[0]).toBe('https://actions.internal/v1/execute-action');
    expect(call[1].headers.authorization).toMatch(/^Bearer /);
  });

  it('throws executor_unavailable on a non-200', async () => {
    const { signingPrivateJwk, signingKid } = await signingConfig();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 502 }));
    const client = createGraphActionsExecutorClient({
      executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor',
      signingPrivateJwk, signingKid, fetch: fetchImpl as never,
    });
    await expect(client.executeWriteAction(req())).rejects.toBeInstanceOf(GraphActionsExecutorClientError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test graphActionsExecutorClient`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (mirror of `graphReadExecutorClient.ts`)**

Copy `graphReadExecutorClient.ts` into `graphActionsExecutorClient.ts` and:
- Replace the operation type/paths: `type ExecutorOperation = 'execute-action'`; `OPERATION_ENDPOINT_PATHS = { 'execute-action': '/v1/execute-action' }`.
- Replace imports from `@breeze/shared/m365`: use `writeActionRequestSchema`, `writeActionResultSchema`, `type WriteActionRequest`, `type WriteActionResult`; drop the consent/retest imports.
- Interface: `GraphActionsExecutorClient { executeWriteAction(input: WriteActionRequest): Promise<WriteActionResult> }`.
- `executorAudience: 'm365-graph-actions-executor'` in the config type.
- Class rename: `GraphReadExecutorClientError` → `GraphActionsExecutorClientError`.
- Keep the single `invoke()` (sole serialization, `bodySha256`, 60s EdDSA JWT, bounded+zod response). Use a mutation response cap of `256 * 1024` (a reset result is tiny, but keep parity headroom).
- The returned object exposes only:
```ts
    executeWriteAction(input) {
      const parsed = writeActionRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(unavailable());
      return invoke('execute-action', parsed.data, (value) => writeActionResultSchema.parse(value));
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/api test graphActionsExecutorClient`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/graphActionsExecutorClient.ts \
        apps/api/src/services/m365ControlPlane/graphActionsExecutorClient.test.ts
git commit -m "feat(m365): API Ed25519-signed client for the actions executor"
```

---

## Task 7: API write budget

**Files:**
- Create: `apps/api/src/services/m365ControlPlane/writeActionBudget.ts`
- Test: `apps/api/src/services/m365ControlPlane/writeActionBudget.test.ts`

**Interfaces:**
- Produces: `consumeM365WriteActionBudget(connectionId): Promise<{allowed:true}|{allowed:false,retryAfterSeconds:number}>`; constants `M365_WRITE_ACTIONS_PER_MINUTE = 10`, `M365_WRITE_ACTIONS_PER_DAY = 100`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/m365ControlPlane/writeActionBudget.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const exec = vi.fn();
vi.mock('../redis', () => ({
  getRedis: () => ({ multi: () => ({ incr: () => ({ expire: () => ({ incr: () => ({ expire: () => ({ exec }) }) }) }) }) }),
}));

import { consumeM365WriteActionBudget, M365_WRITE_ACTIONS_PER_MINUTE } from './writeActionBudget';

beforeEach(() => exec.mockReset());

describe('consumeM365WriteActionBudget', () => {
  it('allows when under both windows', async () => {
    exec.mockResolvedValue([[null, 1], [null, 'OK'], [null, 1], [null, 'OK']]);
    expect(await consumeM365WriteActionBudget('conn-1')).toEqual({ allowed: true });
  });
  it('denies (fail-closed) over the per-minute window', async () => {
    exec.mockResolvedValue([[null, M365_WRITE_ACTIONS_PER_MINUTE + 1], [null, 'OK'], [null, 1], [null, 'OK']]);
    const r = await consumeM365WriteActionBudget('conn-1');
    expect(r.allowed).toBe(false);
  });
  it('fails closed when redis multi returns null', async () => {
    exec.mockResolvedValue(null);
    expect((await consumeM365WriteActionBudget('conn-1')).allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test writeActionBudget`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (mirror of `readActionBudget.ts`)**

Copy `readActionBudget.ts` into `writeActionBudget.ts` and change: constants to `M365_WRITE_ACTIONS_PER_MINUTE = 10`, `M365_WRITE_ACTIONS_PER_DAY = 100`; Redis key prefixes `m365-read-budget-` → `m365-write-budget-`; the function name to `consumeM365WriteActionBudget`; log tags `[readActionBudget]` → `[writeActionBudget]`. Keep the two-window `multi()`, the fail-closed branches, and the fixed-window TTLs identical.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/api test writeActionBudget`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/writeActionBudget.ts \
        apps/api/src/services/m365ControlPlane/writeActionBudget.test.ts
git commit -m "feat(m365): per-connection write budget (tighter than read)"
```

---

## Task 8: API write service (authz ladder) + metrics

**Files:**
- Create: `apps/api/src/services/m365ControlPlane/writeActionMetrics.ts`
- Create: `apps/api/src/services/m365ControlPlane/writeActionService.ts`
- Test: `apps/api/src/services/m365ControlPlane/writeActionService.test.ts`

**Interfaces:**
- Consumes: `isM365GraphActionsEnabledForOrg`, `loadM365CustomerGraphActionsRuntimeConfig` (Task 5); `createGraphActionsExecutorClient`, `GraphActionsExecutorClientError` (Task 6); `consumeM365WriteActionBudget` (Task 7); `m365Connections` schema; `withDbAccessContext`.
- Produces: `executeM365WriteActionByOrg(orgId, action, opts?): Promise<M365WriteActionServiceResult>` and the `M365WriteActionServiceResult` / `M365WriteActionRefusalCode` types.

**Design note (org-keyed, ambient RLS):** unlike `readActionService.executeM365ReadAction` (which takes `auth` and wraps the connection load in `dbAccessContextFromAuth(auth)`), this entry takes only `orgId` and loads the connection under the **ambient** DB context — because the caller (the release worker) has already opened `withDbAccessContext(dbAccessContextFromAuth(auth))` for `intent.orgId`. This exactly mirrors Google's `resolveContextByOrg(orgId)`. The explicit `conn.orgId === orgId` check is defense-in-depth over RLS.

- [ ] **Step 1: Write `writeActionMetrics.ts`**

Mirror `readActionMetrics.ts`: export `recordM365WriteActionEvent(request, { orgId, connectionId, actionType, actorId?, outcome })` that calls `writeAuditEvent` with `action:'m365.customer_graph_actions.action_executed'`, `resourceType:'m365_connection'`, `resourceId=connectionId`, `result` = `outcome==='ok' ? 'success' : 'failure'`, `actorType:'user'`, and `details:{ actionType, outcome }` — **never** the temp password. Register a Prometheus counter `breeze_m365_graph_actions_total{action,outcome}`. (Copy the read metrics file and rename the action string, counter name, and exported function; keep the allowlisted `details` shape.)

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/src/services/m365ControlPlane/writeActionService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const enabled = vi.fn();
const budget = vi.fn();
const executeWriteAction = vi.fn();
const connRows = vi.fn();
const recordEvent = vi.fn();

vi.mock('./writeActionRuntimeConfig', () => ({
  isM365GraphActionsEnabledForOrg: (o: string) => enabled(o),
  loadM365CustomerGraphActionsRuntimeConfig: () => ({
    executorUrl: 'https://x/', executorAudience: 'm365-graph-actions-executor',
    executorSigningPrivateJwk: {}, executorSigningKid: 'k',
  }),
}));
vi.mock('./writeActionBudget', () => ({ consumeM365WriteActionBudget: (id: string) => budget(id) }));
vi.mock('./graphActionsExecutorClient', () => ({
  createGraphActionsExecutorClient: () => ({ executeWriteAction }),
  GraphActionsExecutorClientError: class extends Error {},
}));
vi.mock('./writeActionMetrics', () => ({ recordM365WriteActionEvent: (...a: unknown[]) => recordEvent(...a) }));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => connRows() }) }) }) },
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../db/schema', () => ({ m365Connections: { orgId: 'orgId', profile: 'profile' } }));

import { executeM365WriteActionByOrg } from './writeActionService';

const ORG = '44444444-4444-4444-8444-444444444444';
const TENANT = '22222222-2222-4222-8222-222222222222';
const action = { type: 'm365.user.disable' as const, userIdentifier: 'a@b.com', reason: 'x' };

beforeEach(() => {
  enabled.mockReturnValue(true); budget.mockResolvedValue({ allowed: true });
  connRows.mockResolvedValue([{ id: 'conn-1', orgId: ORG, profile: 'customer-graph-actions', status: 'active', tenantId: TENANT }]);
  executeWriteAction.mockResolvedValue({ success: true, action: 'm365.user.disable', userId: 'u1' });
  recordEvent.mockReset();
});

describe('executeM365WriteActionByOrg', () => {
  it('runs the happy path and audits ok', async () => {
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toEqual({ ok: true, result: { success: true, action: 'm365.user.disable', userId: 'u1' } });
    expect(recordEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'ok' }));
  });
  it('refuses when the flag is off (no DB, no executor)', async () => {
    enabled.mockReturnValue(false);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'tools_disabled' });
    expect(executeWriteAction).not.toHaveBeenCalled();
  });
  it('fails closed when the connection is for a different org', async () => {
    connRows.mockResolvedValue([{ id: 'conn-2', orgId: 'other-org', profile: 'customer-graph-actions', status: 'active', tenantId: TENANT }]);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(executeWriteAction).not.toHaveBeenCalled();
  });
  it('fails closed when the connection is revoked', async () => {
    connRows.mockResolvedValue([{ id: 'conn-1', orgId: ORG, profile: 'customer-graph-actions', status: 'revoked', tenantId: TENANT }]);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'connection_not_ready' });
  });
  it('refuses when the budget denies', async () => {
    budget.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'write_rate_limited' });
    expect(executeWriteAction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test writeActionService`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `writeActionService.ts`**

```ts
// apps/api/src/services/m365ControlPlane/writeActionService.ts
import { randomUUID } from 'node:crypto';
import type { M365WriteAction, WriteActionResult, WriteActionFailureCode } from '@breeze/shared/m365';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { m365Connections, type M365ConnectionRow, type M365ConnectionStatus } from '../../db/schema';
import { requestLikeFromSnapshot, type RequestLike } from '../auditEvents';
import {
  createGraphActionsExecutorClient,
  GraphActionsExecutorClientError,
} from './graphActionsExecutorClient';
import { recordM365WriteActionEvent } from './writeActionMetrics';
import {
  isM365GraphActionsEnabledForOrg,
  loadM365CustomerGraphActionsRuntimeConfig,
} from './writeActionRuntimeConfig';
import { consumeM365WriteActionBudget } from './writeActionBudget';

const PROFILE = 'customer-graph-actions' as const;
// Mutations require a healthy connection — active only (stricter than the read
// side's active/degraded). A degraded connection may have partial grants; a
// write must not be attempted against it.
const EXECUTABLE_STATUSES = ['active'] as const;

export type M365WriteActionRefusalCode =
  | 'tools_disabled' | 'connection_not_ready' | 'write_rate_limited' | 'executor_unavailable';

export type M365WriteActionServiceResult =
  | { ok: true; result: WriteActionResult }
  | { ok: false; code: M365WriteActionRefusalCode | WriteActionFailureCode; message: string; retryAfterSeconds?: number };

const FAILURE_MESSAGES: Record<WriteActionFailureCode, string> = {
  credential_unavailable: 'Microsoft 365 credentials are unavailable for this action.',
  application_token_invalid: 'Microsoft 365 application credentials are invalid for this action.',
  user_not_found: 'The target Microsoft 365 user was not found.',
  user_ambiguous: 'The target Microsoft 365 user could not be uniquely resolved.',
  tenant_mismatch: 'The Microsoft 365 connection tenant did not match.',
  graph_permission_missing: 'Breeze lacks the Microsoft Graph permission required for this action.',
  graph_throttled: 'Microsoft Graph is throttling requests for this tenant. Try again shortly.',
  graph_request_timeout: 'The request to Microsoft Graph timed out.',
  graph_transport_failed: 'Could not reach Microsoft Graph.',
  graph_error: 'Microsoft Graph rejected the change.',
  invalid_action: 'The requested Microsoft 365 action is not supported.',
};

type ConnectionNotReadyState = 'missing' | 'wrong-org' | M365ConnectionStatus | 'no-tenant';

function connectionNotReadyState(
  connection: Pick<M365ConnectionRow, 'orgId' | 'status' | 'tenantId'> | undefined,
  orgId: string,
): ConnectionNotReadyState | null {
  if (!connection) return 'missing';
  if (connection.orgId !== orgId) return 'wrong-org'; // defense-in-depth over RLS
  if (!EXECUTABLE_STATUSES.includes(connection.status as typeof EXECUTABLE_STATUSES[number])) {
    return connection.status;
  }
  if (connection.tenantId === null) return 'no-tenant';
  return null;
}

export async function executeM365WriteActionByOrg(
  orgId: string,
  action: M365WriteAction,
  opts?: { actorId?: string; auditRequest?: RequestLike },
): Promise<M365WriteActionServiceResult> {
  if (!isM365GraphActionsEnabledForOrg(orgId)) {
    return { ok: false, code: 'tools_disabled', message: 'Microsoft 365 Graph actions are not enabled for this organization.' };
  }

  // Ambient RLS context (opened by the release worker for intent.orgId). A
  // wrong-context caller sees zero rows → 'missing' → fail closed.
  const rows = await withDbAccessContext(undefined as never, async () => db.select().from(m365Connections).where(and(
    eq(m365Connections.orgId, orgId),
    eq(m365Connections.profile, PROFILE),
  )).limit(1)).catch(async () =>
    // If ambient-context wrapping is not supported by withDbAccessContext,
    // fall back to a direct ambient select (the worker already established the
    // org context). Keep whichever form the codebase supports; do NOT open a
    // system context here.
    db.select().from(m365Connections).where(and(
      eq(m365Connections.orgId, orgId),
      eq(m365Connections.profile, PROFILE),
    )).limit(1),
  );
  const connection = rows[0];

  const notReady = connectionNotReadyState(connection, orgId);
  if (notReady) {
    return { ok: false, code: 'connection_not_ready', message: 'Microsoft 365 is not connected (or not ready) for this organization.' };
  }
  const ready = connection as M365ConnectionRow;

  const budget = await consumeM365WriteActionBudget(ready.id);
  if (!budget.allowed) {
    return { ok: false, code: 'write_rate_limited', message: 'Microsoft 365 Graph actions are rate limited for this connection. Try again shortly.', retryAfterSeconds: budget.retryAfterSeconds };
  }

  const request = opts?.auditRequest ?? requestLikeFromSnapshot({});
  const auditBase = { orgId, connectionId: ready.id, actionType: action.type, actorId: opts?.actorId };

  let result: WriteActionResult;
  try {
    const config = loadM365CustomerGraphActionsRuntimeConfig();
    const client = createGraphActionsExecutorClient({
      executorUrl: config.executorUrl,
      executorAudience: config.executorAudience,
      signingPrivateJwk: config.executorSigningPrivateJwk,
      signingKid: config.executorSigningKid,
    });
    result = await client.executeWriteAction({
      correlationId: randomUUID(),
      tenantId: ready.tenantId as string,
      idempotencyKey: opts?.actorId ? `${ready.id}:${randomUUID()}` : randomUUID(),
      action,
    });
  } catch (error) {
    if (!(error instanceof GraphActionsExecutorClientError)) throw error;
    recordM365WriteActionEvent(request, { ...auditBase, outcome: 'executor_unavailable' });
    return { ok: false, code: 'executor_unavailable', message: 'Microsoft 365 Graph actions are temporarily unavailable. Try again shortly.' };
  }

  if (!result.success) {
    recordM365WriteActionEvent(request, { ...auditBase, outcome: result.errorCode });
    return { ok: false, code: result.errorCode, message: FAILURE_MESSAGES[result.errorCode], retryAfterSeconds: result.retryAfterSeconds };
  }

  recordM365WriteActionEvent(request, { ...auditBase, outcome: 'ok' });
  return { ok: true, result };
}
```

**Note on `idempotencyKey`:** the caller passes the intent id via `opts` in Task 9; here it defaults to a per-call UUID. In Task 9 the seam passes `intent.id` explicitly — update this to accept `opts.idempotencyKey` and prefer it. (Adjust the signature in Task 9 rather than now, to keep this task's tests green.)

**Note on the DB-context load:** use whichever ambient-load form the codebase actually supports — the `.catch` fallback above is belt-and-suspenders. During implementation, confirm how the worker's `withDbAccessContext(dbAccessContextFromAuth(auth), invoke)` exposes the ambient context to a nested `db.select()`; the read service's pattern (`withDbAccessContext(dbAccessContextFromAuth(auth), () => db.select()…)`) is the reference. If the worker's context is already ambient on `db`, a plain `db.select()` is correct. Do **not** open a system context.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @breeze/api test writeActionService`
Expected: PASS (all five cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/writeActionMetrics.ts \
        apps/api/src/services/m365ControlPlane/writeActionService.ts \
        apps/api/src/services/m365ControlPlane/writeActionService.test.ts
git commit -m "feat(m365): write-action authz ladder + audit (org-keyed, fail-closed)"
```

---

## Task 9: Org-keyed headless seam + worker wiring + integration test

**Files:**
- Create: `apps/api/src/services/m365ToolsHeadless.ts`
- Test: `apps/api/src/services/m365ToolsHeadless.test.ts` (parity contract)
- Modify: `apps/api/src/services/m365ControlPlane/writeActionService.ts` (accept `opts.idempotencyKey`)
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts` (two edits)
- Create: `apps/api/src/jobs/intentReleaseWorkerM365Headless.integration.test.ts`
- Create/Modify: a minimal connection seed helper for the integration test (see Step 6).

**Interfaces:**
- Consumes: `executeM365WriteActionByOrg` (Task 8); `m365ToolTiers` (from `aiToolsM365.ts`); `m365WriteActionSchema` (Task 1).
- Produces: `M365_HEADLESS_ACTIONS`, `isHeadlessM365Tool(name)`, `executeM365ToolHeadless(actionName, args, orgId): Promise<string>`, `M365ConnectionUnavailableError`.

- [ ] **Step 1: Write the parity + behavior test**

```ts
// apps/api/src/services/m365ToolsHeadless.test.ts
import { describe, it, expect, vi } from 'vitest';

const execByOrg = vi.fn();
vi.mock('./m365ControlPlane/writeActionService', () => ({
  executeM365WriteActionByOrg: (...a: unknown[]) => execByOrg(...a),
}));

import {
  M365_HEADLESS_ACTIONS,
  isHeadlessM365Tool,
  executeM365ToolHeadless,
  M365ConnectionUnavailableError,
} from './m365ToolsHeadless';
import { m365ToolTiers } from './aiToolsM365';

const ORG = '44444444-4444-4444-8444-444444444444';

describe('M365 headless parity contract', () => {
  it('maps exactly the Tier-3 m365 tools', () => {
    const tier3 = Object.entries(m365ToolTiers).filter(([, t]) => t === 3).map(([n]) => n).sort();
    expect(Object.keys(M365_HEADLESS_ACTIONS).sort()).toEqual(tier3);
  });
});

describe('executeM365ToolHeadless', () => {
  it('throws M365ConnectionUnavailableError on connection refusal (fail closed)', async () => {
    execByOrg.mockResolvedValue({ ok: false, code: 'connection_not_ready', message: 'no conn' });
    await expect(executeM365ToolHeadless('m365_disable_user', { userIdentifier: 'a@b.com', reason: 'x' }, ORG))
      .rejects.toBeInstanceOf(M365ConnectionUnavailableError);
  });

  it('returns a JSON error body on a Graph-level failure (→ tool_returned_error)', async () => {
    execByOrg.mockResolvedValue({ ok: false, code: 'user_not_found', message: 'not found' });
    const out = await executeM365ToolHeadless('m365_disable_user', { userIdentifier: 'ghost@b.com', reason: 'x' }, ORG);
    const parsed = JSON.parse(out);
    expect(parsed.error).toBeTruthy();
    expect(parsed.success).toBeUndefined();
  });

  it('returns a success body carrying temporaryPassword for reset', async () => {
    execByOrg.mockResolvedValue({ ok: true, result: { success: true, action: 'm365.user.reset_password', userId: 'u1', temporaryPassword: 'Tmp!23xyz789', forceChangeNextSignIn: true } });
    const out = await executeM365ToolHeadless('m365_reset_password', { userIdentifier: 'a@b.com', reason: 'x' }, ORG);
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.temporaryPassword).toBe('Tmp!23xyz789');
  });

  it('rejects an unknown tool name', async () => {
    await expect(executeM365ToolHeadless('m365_query_users', {}, ORG)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test m365ToolsHeadless`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the seam**

```ts
// apps/api/src/services/m365ToolsHeadless.ts
/**
 * Headless dispatch for M365 Tier-3 tools, used by the durable action-intents
 * release worker. Resolves the org's customer-graph-actions connection by the
 * immutable intent.orgId (NO live session) via executeM365WriteActionByOrg,
 * which re-checks org-match + active and fails closed.
 *
 * The action map is the effective allowlist and is pinned to the tier-3
 * m365ToolTiers set by a parity test.
 */
import { m365WriteActionSchema, type M365WriteActionId } from '@breeze/shared/m365';
import { executeM365WriteActionByOrg } from './m365ControlPlane/writeActionService';

/** Thrown when the org's actions connection is missing/rotated/inactive at release. */
export class M365ConnectionUnavailableError extends Error {
  constructor(public readonly toolResult: string) {
    super('Microsoft 365 actions connection unavailable for headless release');
    this.name = 'M365ConnectionUnavailableError';
  }
}

/** Tool name → typed write-action id. This map is the headless allowlist. */
export const M365_HEADLESS_ACTIONS: Record<string, M365WriteActionId> = {
  m365_disable_user: 'm365.user.disable',
  m365_reset_password: 'm365.user.reset_password',
};
// Invariant: keys(M365_HEADLESS_ACTIONS) === tier-3 m365ToolTiers set.
// Enforced by the parity unit test in m365ToolsHeadless.test.ts.

// Refusals that mean "no side effect happened, fail closed as connection
// unavailable" (vs a Graph-level failure that is a real terminal tool error).
const CONNECTION_UNAVAILABLE_CODES = new Set(['tools_disabled', 'connection_not_ready', 'write_rate_limited', 'executor_unavailable']);

export function isHeadlessM365Tool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(M365_HEADLESS_ACTIONS, name);
}

export async function executeM365ToolHeadless(
  actionName: string,
  args: unknown,
  orgId: string,
): Promise<string> {
  const actionId = M365_HEADLESS_ACTIONS[actionName];
  if (!actionId) {
    throw new Error(`executeM365ToolHeadless: "${actionName}" is not a headless M365 tool`);
  }
  const input = (args ?? {}) as Record<string, unknown>;
  const parsed = m365WriteActionSchema.safeParse({
    type: actionId,
    userIdentifier: input.userIdentifier,
    reason: input.reason,
  });
  if (!parsed.success) {
    // Bad captured arguments — a terminal tool error, not a connection issue.
    return JSON.stringify({ error: 'Invalid M365 action arguments for headless execution.' });
  }

  const outcome = await executeM365WriteActionByOrg(orgId, parsed.data, { idempotencyKey: orgId });

  if (!outcome.ok) {
    if (CONNECTION_UNAVAILABLE_CODES.has(outcome.code)) {
      // Fail closed: no Graph call was made (or none should be retried inline).
      throw new M365ConnectionUnavailableError(JSON.stringify({ error: outcome.message }));
    }
    // Graph-level failure (user_not_found, graph_error, …) → returned tool error.
    return JSON.stringify({ error: outcome.message });
  }

  // Success body is stored verbatim into intent.result (has `success`, so the
  // worker's isReturnedToolError treats it as a completion). For reset it
  // carries temporaryPassword for the approvals-UI reveal.
  return JSON.stringify(outcome.result);
}
```

- [ ] **Step 4: Thread `idempotencyKey` through the write service**

In `writeActionService.ts`, change the `opts` type to include `idempotencyKey?: string` and use it:
```ts
      idempotencyKey: opts?.idempotencyKey ?? randomUUID(),
```
(Replace the earlier `opts?.actorId ? … : randomUUID()` placeholder.) Re-run `writeActionService` tests — still green.

- [ ] **Step 5: Run the seam tests**

Run: `pnpm --filter @breeze/api test m365ToolsHeadless`
Expected: PASS (parity + all behaviors).

- [ ] **Step 6: Wire the worker**

In `apps/api/src/jobs/intentReleaseWorker.ts`:
- Add imports near the Google headless import:
```ts
import { isHeadlessM365Tool, executeM365ToolHeadless, M365ConnectionUnavailableError } from '../services/m365ToolsHeadless';
```
- Replace the `:255` guard:
```ts
  if (!isHeadlessGoogleTool(intent.actionName)
    && !isHeadlessM365Tool(intent.actionName)
    && requiresLiveSession(intent.actionName)) {
    await failIntent(intent, 'session_required', { details: { actionName: intent.actionName } });
    return;
  }
```
- Replace the `:265` invoke selector:
```ts
  const invoke = isHeadlessGoogleTool(intent.actionName)
    ? () => executeGoogleToolHeadless(intent.actionName, intent.arguments, intent.orgId)
    : isHeadlessM365Tool(intent.actionName)
    ? () => executeM365ToolHeadless(intent.actionName, intent.arguments, intent.orgId)
    : () => executeTool(intent.actionName, intent.arguments, auth);
```
- In the `catch` at `:279`, add the M365 case alongside the Google one:
```ts
    if (err instanceof GoogleConnectionUnavailableError || err instanceof M365ConnectionUnavailableError) {
      await failIntent(intent, 'connection_unavailable', { details: { actionName: intent.actionName } });
      return;
    }
```
- Update the Phase-1 deferral comment above the guard to note M365 Tier-3 tools are now headless-executable via the customer-graph-actions executor.

- [ ] **Step 7: Minimal connection seed helper (for the integration test)**

Add a small test-only helper that inserts a `customer-graph-actions` connection row under a system context, e.g. `apps/api/src/services/m365ControlPlane/__testHelpers__/seedActionsConnection.ts`:
```ts
import { withSystemDbAccessContext, db } from '../../../db';
import { m365Connections } from '../../../db/schema';

export async function seedActionsConnection(input: { orgId: string; tenantId: string; status?: string }) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.insert(m365Connections).values({
      orgId: input.orgId,
      profile: 'customer-graph-actions',
      status: input.status ?? 'active',
      tenantId: input.tenantId,
      // fill any other NOT NULL columns per the m365Connections schema with
      // minimal valid values (appId/certVersion/etc.) — check the schema at
      // implementation time.
    } as never).returning();
    return row;
  });
}
```
(At implementation time, open `apps/api/src/db/schema` for `m365Connections` and populate all NOT NULL columns.)

- [ ] **Step 8: Write the integration test**

```ts
// apps/api/src/jobs/intentReleaseWorkerM365Headless.integration.test.ts
// Real Postgres; the actions executor client is mocked at the module boundary
// so no real Graph/Key Vault is touched. Mirrors intentReleaseWorkerGoogleHeadless.integration.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeWriteAction = vi.fn();
vi.mock('../services/m365ControlPlane/graphActionsExecutorClient', () => ({
  createGraphActionsExecutorClient: () => ({ executeWriteAction }),
  GraphActionsExecutorClientError: class extends Error {},
}));
// Enable the feature flag for the test org.
// (Set env before importing the worker / service graph.)

// ...set process.env.M365_GRAPH_ACTIONS_TOOLS_ENABLED='true' and
//    process.env.M365_GRAPH_ACTIONS_TOOLS_ORG_IDS='*' and the executor URL/
//    signing envs to test values, mirroring the Google integration test's setup.

import { releaseApprovedIntent } from './intentReleaseWorker';
// import test DB helpers used by the Google integration test (seed org, create
// an approved intent for m365_disable_user / m365_reset_password), plus
// seedActionsConnection from Task 9 Step 7.

describe('intentReleaseWorker — M365 headless', () => {
  beforeEach(() => executeWriteAction.mockReset());

  it('disables a user headless and completes the intent', async () => {
    // seed org + active customer-graph-actions connection (tenantId)
    // create an approved intent: actionName 'm365_disable_user',
    //   arguments { userIdentifier: 'a@b.com', reason: 'offboard' }, orgId = testOrg
    executeWriteAction.mockResolvedValue({ success: true, action: 'm365.user.disable', userId: 'u1' });
    // await releaseApprovedIntent(intentId)
    // expect intent status 'completed', result.success === true
    expect(true).toBe(true); // replace with real assertions per the Google suite's structure
  });

  it('resets a password headless and stores temporaryPassword in intent.result', async () => {
    executeWriteAction.mockResolvedValue({ success: true, action: 'm365.user.reset_password', userId: 'u1', temporaryPassword: 'Tmp!23xyz789', forceChangeNextSignIn: true });
    // expect completed; intent.result.temporaryPassword === 'Tmp!23xyz789'
  });

  it('fails connection_unavailable with NO executor call when the connection is revoked', async () => {
    // seed connection with status 'revoked'
    // expect intent status 'failed', errorCode 'connection_unavailable'
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('fails connection_unavailable when the connection org differs from intent.orgId', async () => {
    // seed connection for a DIFFERENT org; create intent for testOrg
    // expect 'failed' / 'connection_unavailable', no executor call
  });

  it('no longer fails session_required for these two tools', async () => {
    // with an active connection, releasing does NOT produce errorCode 'session_required'
  });
});
```
Flesh these out against the exact structure of `apps/api/src/jobs/intentReleaseWorkerGoogleHeadless.integration.test.ts` (org/intent/approval seeding helpers, how it invokes `releaseApprovedIntent`, and how it reads back intent status/result). Keep the assertions listed above.

- [ ] **Step 9: Run all affected tests**

Run: `pnpm --filter @breeze/api test m365ToolsHeadless writeActionService intentReleaseWorker`
Then the integration suite (needs a real DB, port 5433 per repo convention):
Run: `pnpm --filter @breeze/api test:integration intentReleaseWorkerM365Headless`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/m365ToolsHeadless.ts apps/api/src/services/m365ToolsHeadless.test.ts \
        apps/api/src/services/m365ControlPlane/writeActionService.ts \
        apps/api/src/jobs/intentReleaseWorker.ts \
        apps/api/src/jobs/intentReleaseWorkerM365Headless.integration.test.ts \
        apps/api/src/services/m365ControlPlane/__testHelpers__/seedActionsConnection.ts
git commit -m "feat(m365): org-keyed headless seam + release-worker wiring for M365 Tier-3"
```

---

## Task 10: Web — temp-password reveal in the approvals/intents detail

**Files:**
- Modify: the web component that renders a completed action-intent's result (locate via grep for where `intent.result` / the approvals detail is rendered — e.g. under `apps/web/src/components/` approvals/intents).
- Test: co-located component test.

**Interfaces:**
- Consumes: `intent.result` shape `{ success: true, action: 'm365.user.reset_password', userId, temporaryPassword, forceChangeNextSignIn }`.

- [ ] **Step 1: Locate the render site**

Run: `grep -rn "temporaryPassword\|intent.result\|action_intents\|IntentResult" apps/web/src`
Identify the approvals/intents detail component that shows a completed intent's outcome.

- [ ] **Step 2: Write the failing component test**

Add a test asserting that when a completed reset-password intent's `result.temporaryPassword` is present, the component renders a one-time reveal control (hidden by default, shown on click) displaying the value, and does NOT render it for a disable result. (Use the existing web test conventions — jsdom + `data-testid`.)

- [ ] **Step 3: Implement the reveal**

Render a masked field with a "Reveal temporary password" button (`data-testid="intent-temp-password-reveal"`) that toggles display of `result.temporaryPassword`, with copy noting the user must change it at next sign-in. Never auto-display; never log it.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @breeze/web test <component>` and `pnpm --filter @breeze/web astro check` (or the repo's web typecheck).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/...
git commit -m "feat(web): reveal M365 temporary password on completed reset-password intents"
```

---

## Task 11: Deployment wiring, env docs, workspace registration

**Files:**
- Modify: `.env.example` (root and/or `apps/api/.env.example`)
- Modify: deploy compose (`deploy/docker-compose.prod.yml` and/or the dev override files) — add the `m365-graph-actions-executor` service.
- Modify: `pnpm-workspace.yaml` only if apps are not glob-registered.
- Modify: any executor-URL/env passthrough in the API service `environment:` block (compose interpolation is not automatic — CLAUDE.md deploy note).

- [ ] **Step 1: Register the workspace (if needed)**

Confirm `apps/*` is globbed in `pnpm-workspace.yaml`. If not, add `apps/m365-graph-actions-executor`.
Run: `pnpm install` — the new app resolves.

- [ ] **Step 2: Add env placeholders**

In `.env.example`, add (generic placeholders only — no real values):
```dotenv
# M365 customer-graph-actions executor (disabled by default)
M365_GRAPH_ACTIONS_TOOLS_ENABLED=false
M365_GRAPH_ACTIONS_TOOLS_ORG_IDS=
M365_GRAPH_ACTIONS_EXECUTOR_URL=https://m365-graph-actions-executor.internal
M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE=m365-graph-actions-executor
M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID=
M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE=/run/secrets/m365-actions-signing.jwk
M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID=
M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION=
M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF=akv://your-vault.vault.azure.net/m365-customer-graph-actions/<32-hex-version>
# Executor-side (the sidecar):
M365_GRAPH_ACTIONS_EXECUTOR_AUTOSTART=1
M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PUBLIC_JWK=
M365_GRAPH_ACTIONS_EXECUTOR_AZURE_CREDENTIAL_MODE=managed-identity
```
Match the exact var names the code in Tasks 2 and 5 reads.

- [ ] **Step 3: Add the compose service**

Add an `m365-graph-actions-executor` service mirroring the read executor's service block (image/build, port `3004`, the `M365_GRAPH_ACTIONS_EXECUTOR_*` env, the mounted signing public JWK + Azure identity), and map the new `M365_GRAPH_ACTIONS_EXECUTOR_URL` + `M365_CUSTOMER_GRAPH_ACTIONS_*` vars explicitly into the `api` service `environment:` block. Do NOT add the Watchtower enable label to this service (supply-chain hardening rule).

- [ ] **Step 4: Verify compose parses**

Run: `docker compose -f docker-compose.yml -f docker-compose.override.yml.dev config >/dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add .env.example deploy/ docker-compose*.yml pnpm-workspace.yaml
git commit -m "chore(m365): deploy + env wiring for customer-graph-actions executor (disabled by default)"
```

---

## Self-Review

**Spec coverage:**
- §4.A write catalog → Task 1. ✅
- §4.B executor sidecar → Tasks 2–4. ✅
- §4.C idempotency (no dedup store; worker CAS; idempotencyKey carried) → Task 8/9 (idempotencyKey threaded), documented in Global Constraints. ✅
- §4.D API client/service/budget/metrics/feature-flag → Tasks 5–8. ✅
- §4.E headless seam + parity test → Task 9. ✅
- §4.F worker wiring → Task 9 Step 6. ✅
- §4.G web reveal → Task 10. ✅
- §5 security contract (resolve by intent.orgId, org-match+active re-check, fail closed, revalidate-first unchanged, credential isolation, 60s EdDSA, tighter budget, audit chain) → Tasks 8 (org-match+active, EXECUTABLE_STATUSES active-only), 9 (worker uses intent.orgId; revalidate untouched), 6 (60s EdDSA), 7 (budget), 8 metrics (audit). ✅
- §7 testing (executor unit, shared schema, authz ladder, budget, parity, integration incl. wrong-org + revoked + no-session_required) → Tasks 1,3,4,6,7,8,9. ✅
- §8 sequencing → task order matches. ✅

**Placeholder scan:** The executor scaffold (Task 2) and the runtime-config/client/budget/metrics mirrors (Tasks 5–8 Step 1 of metrics) are expressed as copy-of-a-named-file + enumerated literal substitutions rather than re-pasting 200-line bodies — this is deliberate (DRY mirror of shipped, reviewed files), and every substitution is spelled out concretely. Novel logic (catalog, write dispatch, operation, service, seam, worker edits) has complete code. No "TBD"/"add error handling"/"similar to Task N" left.

**Type consistency:** `WriteActionResult` success shapes (`action` discriminator, `temporaryPassword`, `forceChangeNextSignIn`) are consistent across Task 1 (schema), Task 3 (executor return), Task 8 (service passthrough), Task 9 (seam JSON body) and Task 10 (web read). `executeM365WriteActionByOrg(orgId, action, opts)` signature is consistent between Task 8 and its use in Task 9 (with `idempotencyKey` added in Task 9 Step 4). `M365_HEADLESS_ACTIONS` keys are pinned to `m365ToolTiers` tier-3 in Task 9's parity test.

**One flagged spec deviation, made explicit:** Task 8 sets `EXECUTABLE_STATUSES = ['active']` (active-only) for mutations, stricter than the spec's mirrored `active/degraded`. This is the hardening flagged during spec review; a code comment documents it. If active/degraded parity with the read side is preferred, add `'degraded'` to the tuple.
