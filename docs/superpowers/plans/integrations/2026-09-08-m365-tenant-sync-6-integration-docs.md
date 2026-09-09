# M365 Tenant Sync — Wave 6: End-to-end integration suite, re-consent proof, benchmark harness, docs, card verification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** prove the whole sync path end to end against real Postgres with an in-process fake executor (all six domains, continuation, change-only writes, truncation, fencing, disconnect); prove the non-interrupting re-consent transition; add the multi-domain concurrency case W04's claim suite is missing; close the metric-name contract's one gap; ship a repeatable capacity benchmark (not CI) with pass criteria written before the run; and finish the operator- and customer-facing surface — deploy doc, runbook acceptance checklist, release notes, product docs, and a rendering check that W05's card really does show its "Last synced …" line and its per-domain chips.

**Architecture:** the suite drives `runSyncDomain` directly (never through BullMQ — the ticker/queue path is W04's own claim suite) against a node `http` server that verifies the API's EdDSA internal-auth JWT exactly as `apps/m365-graph-read-executor/src/internalAuth.ts` does, and returns canned `M365SyncActionResult` payloads keyed by `action.type`. The API is pointed at it by stubbing `globalThis.fetch` for the configured executor origin only, so signing, `bodySha256` binding, response bounding, and result-schema parsing all run for real. The benchmark reuses the same fake executor with injected latency and a seeded size distribution, and reports drain time, ticker utilisation, queue depth, WAL delta, pool occupancy, and foreground probe p95.

**Tech Stack:** TypeScript, Vitest (`vitest.integration.config.ts` against Postgres `:5433` + Redis `:6380`), Drizzle + raw `sql` for verification reads, `jose` (EdDSA), `prom-client`, `tsx` scripts, React + Testing Library (web), Astro/Starlight MDX (`apps/docs`).

**Spec:** `docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md` — this wave implements §9 (testing, all bullets from "End-to-end integration" down, plus the claim-protocol concurrency case and the metric registration), §5.11 (benchmark), §10.5 (self-hoster rollout notes), and a read-only verification of the card half of §2.2 (W05 owns every line of card code).

**Wave issue:** `LanternOps/breeze#5333` (parent `#5327`). Branch: `feature/5327-m365-tenant-sync/wave-5333`.

---

## Global Constraints (inherited from the overview — `2026-09-08-m365-tenant-sync-0-overview.md`)

- Migration file name must sort after the newest committed migration (`2026-10-14-100500-…` as of 2026-09-08; re-check with `ls apps/api/migrations | sort | tail -1`). Idempotent, no inner `BEGIN/COMMIT`, RLS enabled + forced + policies in the same file. **This wave writes no migration.** If one becomes necessary, stop and reconcile with W02.
- All new tables are shape 1: `org_id NOT NULL` → `organizations(id)`, policy `USING (public.breeze_has_org_access(org_id))` FOR ALL.
- Composite FKs on `(x, org_id)` are `DEFERRABLE INITIALLY IMMEDIATE`.
- Every jsonb column is `excludedOpen`; every column whose name contains `mfa` or `hash` is `reviewedIncluded` in `CORE_TENANT_EXPORT_POLICY`.
- BullMQ custom job ids contain no `:`.
- Fail-closed: no Redis budget signal = deny; missing flag = off.
- Never edit a shipped migration. Never call the bare pool in request code.
- Test one file with `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`).
- Executor projection allowlists are the only fields that leave the executor.

## Constraints specific to this wave

- **The new suite MUST live in `apps/api/src/__tests__/integration/`.** `vitest.integration.config.ts` includes `src/__tests__/integration/**/*.test.ts` (line 11) and the CI job runs `pnpm --filter=@breeze/api test:integration --shard=${{ matrix.shard }}/4` across four shards. A `*.integration.test.ts` placed anywhere else must be dual-listed by hand (include here, exclude in `vitest.config.ts`) or it runs in **zero** CI jobs. Task 14 asserts inclusion mechanically; do not skip it.
- **Never drive the suite through BullMQ.** `runSyncDomain(data)` is called directly. The queue/ticker/backpressure behaviour is W04's `m365SyncWorker` surface; duplicating it here buys a flaky Redis dependency and no coverage.
- **`globalThis.fetch` is stubbed for the executor origin only**, and restored in `afterAll`. Any other host falls through to the real fetch. The API's executor client captures `config.fetch ?? globalThis.fetch` **at factory-creation time** (`graphReadExecutorClient.ts:141`), so the stub must be installed before the first sync call.
- **The fake executor verifies the JWT for real.** EdDSA, `alg` pinned, `kid` match, `iss=breeze-api`, `aud=m365-graph-read-executor`, `sub=breeze-control-plane`, `iat`/`exp` present with `exp - iat <= 60`, `jti` a UUID, `operation === 'sync-action'`, `correlationId` a UUID, and `bodySha256` equal to the base64url SHA-256 of the exact received bytes. Mirrors `apps/m365-graph-read-executor/src/internalAuth.ts:78-106`. A harness that accepts anything proves nothing about the wire contract.
- **Verification reads use the superuser client** (`getTestDb()`), never the `breeze_app` proxy — these are assertions about rows the worker wrote under a system context, not RLS probes. RLS itself is `rls-coverage.integration.test.ts`'s contract (W02).
- **Bind `Date` values as `toISOString()` inside raw `sql`` fragments.** A `Date` passed straight into a drizzle raw fragment throws `Buffer.byteLength` at bind time under postgres.js; compiled-SQL tests never see it, only real Postgres does.
- **No real tenant ids, client ids, hostnames or secrets in fixtures.** Use the all-1s/2s/3s GUID style already used by `m365ConnectionLifecycle.integration.test.ts`.
- **No card code, no new locale keys.** W05 owns every change to `M365CustomerGraphReadCard.tsx` and to `apps/web/src/locales/*/integrations.json` (its Task 15: the `Sync now` button, the `Last synced …` line, the per-domain chips, and the `m365CustomerGraphRead.sync.*` keys in all eight catalogs). This wave only *renders* that card in a test and asserts the text it already produces. If an assertion fails because a key, a parser branch, or a line is missing, that is a W05 gap: fix it in W05's files and say so in the PR body — never add a second copy of the card's parser, chips or copy here.
- **No duplicated docs blocks.** W01 owns the manifest-v3 app-role table rows in `docs/deploy/m365-customer-graph-read-executor.md` and the whole re-consent story in `docs/release-notes/m365-customer-graph-read-manifest-v3.md`; W03 owns the executor env-var rows and the executor metric names; W04 owns `apps/api/src/services/m365Sync/metrics.test.ts`. Link to them or append to them — do not restate them.
- **Docs jobs:** any `apps/docs/**` edit must pass `pnpm --filter @breeze/docs check` and `pnpm --filter @breeze/docs build` (the `docs-check` CI job runs both).

## Baseline verification — run before Task 1

This wave consumes W01–W05. Verify they are on the branch base; if any check fails, **stop** and land the missing wave first.

```bash
# W01 — manifest v3 + upgrade consent
node -e "const {M365_PERMISSION_PROFILES}=require('./packages/shared/dist/index.cjs');process.exit(M365_PERMISSION_PROFILES['customer-graph-read'].version===3?0:1)" \
  || grep -q "version: 3" packages/shared/src/m365/profiles.ts
grep -q "initiateCustomerGraphReadUpgradeConsent" apps/api/src/services/m365ControlPlane/connectionService.ts
grep -q "grantHealth" apps/api/src/routes/m365CustomerGraphRead.ts
# W02 — schema
test -f apps/api/src/db/schema/m365Sync.ts
grep -q "m365PostureRollups" apps/api/src/db/schema/m365Sync.ts
# W03 — shared sync contract + executor route
grep -q "m365SyncActionResultSchema" packages/shared/src/m365/readActions.ts packages/shared/src/m365/sync.ts
grep -q "/v1/sync-action" apps/m365-graph-read-executor/src/app.ts
grep -q "'sync-action'" apps/api/src/services/m365ControlPlane/graphReadExecutorClient.ts
# W04 — sync core
test -f apps/api/src/services/m365Sync/run.ts
test -f apps/api/src/services/m365Sync/claim.ts
test -f apps/api/src/jobs/m365SyncWorker.ts
grep -q "isM365TenantSyncEnabled" apps/api/src/config/env.ts
# W05 — enrichment + lifecycle + DTO sync block
test -f apps/api/src/services/m365Sync/lifecycle.ts
test -f apps/api/src/services/m365Sync/rollup.ts
grep -q "syncEnabled" apps/api/src/routes/m365CustomerGraphRead.ts
```

Also confirm the two names this wave leans on actually shipped:

```bash
grep -rn "export function registerM365SyncMetrics" apps/api/src/services/m365Sync/metrics.ts
grep -rn "m365_sync_actions_total" apps/m365-graph-read-executor/src/
```

`registerM365SyncMetrics(registry)` is the registrar the overview's contract pins, and W04's `apps/api/src/services/m365Sync/metrics.test.ts` is the single metric-name contract suite — Tasks 4 and 8 both use them. An empty grep means W04 has not landed: stop and land it rather than inventing a second registrar or a second name-contract suite.

## Local stack

```bash
pnpm test-stack up        # worktree-private Postgres :5433 + Redis :6380, writes .env.test
# … work …
pnpm test-stack down
docker compose ls -a      # the only reliable "is it actually down" check
```

## Task ordering & dependencies

1. **Task 1** — fake executor harness + fixture builders (everything else imports it)
2. **Task 2** — first-run end-to-end across all six domains (needs 1)
3. **Task 3** — change-only second run (needs 2's seeding helpers)
4. **Task 4** — truncated run + fenced run (needs 1, 2)
5. **Task 5** — disconnect deletes entities, keeps history (needs 1, 2)
6. **Task 6** — re-consent / upgrade-consent integration cases (needs 1)
7. **Task 7** — two-ticker `SKIP LOCKED` completeness, appended to W04's claim suite (independent)
8. **Task 8** — metric-name guards: one case appended to W04's `metrics.test.ts`, one executor source scan (independent)
9. **Task 9** — benchmark harness + its runbook (needs 1's fixture builders)
10. **Task 10** — deploy doc operational sections (docs only)
11. **Task 11** — runbook sync acceptance checklist (docs only)
12. **Task 12** — release notes + `apps/docs` feature page + `environment.mdx` (docs only)
13. **Task 13** — card rendering check against W05's card (one web test, no card code)
14. **Task 14** — full verification, CI-shard proof, PR

Tasks 2–5 all edit `m365TenantSync.integration.test.ts`; run them in order in one session. Tasks 6–13 are file-disjoint from each other. One PR, one commit per task.

---

### Task 1: Fake sync executor harness

Spec §4.2–§4.3 (wire contract), §9 ("real Postgres, fake executor HTTP server").

**Files:**
- Create: `apps/api/src/__tests__/integration/m365SyncFakeExecutor.ts`
- Create: `apps/api/src/__tests__/integration/m365TenantSync.integration.test.ts` (harness contract block only; Tasks 2–5 add the domain blocks)

**Interfaces:**
- Consumes: `M365SyncActionResult`, `M365SyncSourceState`, `m365SyncActionResultSchema` from `@breeze/shared/m365` (W03); `apps/m365-graph-read-executor/src/internalAuth.ts:78-106` as the verification reference (read, do not import — the executor is not a dependency of `@breeze/api`).
- Produces (consumed by Tasks 2–5, 9):
  - `createFakeSyncExecutor(options?: { latencyMs?: number }): Promise<FakeSyncExecutor>`
  - `interface FakeSyncExecutor { origin: string; signingPrivateJwk: JWK; signingKid: string; calls: FakeSyncCall[]; enqueue(actionType: string, response: M365SyncActionResult | FakeSyncErrorResponse): void; unauthorizedCount: number; close(): Promise<void> }`
  - `interface FakeSyncCall { actionType: string; tenantId: string; correlationId: string; continuation?: string; backfill?: boolean }`
  - fixture builders `syncUsersResult`, `syncSigninActivityResult`, `syncIntuneDevicesResult`, `syncCaPoliciesResult`, `syncSkusResult`, `syncSecureScoreResult`

- [ ] **Step 1: Write the failing harness contract tests**

`apps/api/src/__tests__/integration/m365TenantSync.integration.test.ts`:

```ts
/**
 * Integration test — M365 tenant sync end to end (real PG + in-process fake executor)
 *
 * Drives `runSyncDomain` directly (never through BullMQ) against a node http
 * server that verifies the API's EdDSA internal-auth JWT exactly as
 * apps/m365-graph-read-executor/src/internalAuth.ts does, and returns canned
 * M365SyncActionResult payloads keyed by action.type.
 *
 * Run:
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/m365TenantSync.integration.test.ts
 */
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, importJWK } from 'jose';
import { createFakeSyncExecutor, type FakeSyncExecutor } from './m365SyncFakeExecutor';

const runDb = it.runIf(!!process.env.DATABASE_URL);

let executor: FakeSyncExecutor;

beforeAll(async () => {
  executor = await createFakeSyncExecutor();
});

afterAll(async () => {
  await executor.close();
});

async function post(body: unknown, mutate: (claims: Record<string, unknown>) => Record<string, unknown> = (c) => c) {
  const raw = JSON.stringify(body);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const claims = mutate({
    operation: 'sync-action',
    correlationId: randomUUID(),
    bodySha256: createHash('sha256').update(raw).digest('base64url'),
  });
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: executor.signingKid })
    .setIssuer('breeze-api')
    .setAudience('m365-graph-read-executor')
    .setSubject('breeze-control-plane')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 60)
    .setJti(randomUUID())
    .sign(await importJWK(executor.signingPrivateJwk, 'EdDSA'));
  return fetch(`${executor.origin}/v1/sync-action`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: raw,
  });
}

describe('fake sync executor harness', () => {
  it('accepts a correctly signed sync-action and returns the queued result', async () => {
    executor.enqueue('m365.sync.skus', {
      success: true, kind: 'sync', items: [], truncated: false,
      fetchedAt: '2026-09-08T10:00:00.000Z', sources: { subscribedSkus: 'ok' },
    });
    const response = await post({
      correlationId: randomUUID(),
      tenantId: '44444444-4444-4444-8444-444444444444',
      action: { type: 'm365.sync.skus' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.json()).resolves.toMatchObject({ kind: 'sync', truncated: false });
    expect(executor.calls.at(-1)).toMatchObject({ actionType: 'm365.sync.skus' });
  });

  it('rejects a token whose bodySha256 does not bind the received bytes', async () => {
    const before = executor.unauthorizedCount;
    const response = await post(
      { correlationId: randomUUID(), tenantId: '44444444-4444-4444-8444-444444444444', action: { type: 'm365.sync.skus' } },
      (claims) => ({ ...claims, bodySha256: createHash('sha256').update('{}').digest('base64url') }),
    );
    expect(response.status).toBe(401);
    expect(executor.unauthorizedCount).toBe(before + 1);
  });

  it('rejects a token bound to another operation', async () => {
    const response = await post(
      { correlationId: randomUUID(), tenantId: '44444444-4444-4444-8444-444444444444', action: { type: 'm365.sync.skus' } },
      (claims) => ({ ...claims, operation: 'read-action' }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects a token whose lifetime exceeds 60 seconds', async () => {
    const raw = JSON.stringify({ correlationId: randomUUID(), tenantId: '44444444-4444-4444-8444-444444444444', action: { type: 'm365.sync.skus' } });
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({
      operation: 'sync-action', correlationId: randomUUID(),
      bodySha256: createHash('sha256').update(raw).digest('base64url'),
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: executor.signingKid })
      .setIssuer('breeze-api').setAudience('m365-graph-read-executor').setSubject('breeze-control-plane')
      .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 3_600).setJti(randomUUID())
      .sign(await importJWK(executor.signingPrivateJwk, 'EdDSA'));
    const response = await fetch(`${executor.origin}/v1/sync-action`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: raw,
    });
    expect(response.status).toBe(401);
  });

  it('returns 500 with no fixture queued rather than inventing a payload', async () => {
    const response = await post({
      correlationId: randomUUID(), tenantId: '44444444-4444-4444-8444-444444444444',
      action: { type: 'm365.sync.ca_policies' },
    });
    expect(response.status).toBe(500);
  });
});
```

Note the harness block posts through the *bridged* `globalThis.fetch` — the bridge rewrites `executor.origin` to the loopback server, so these four cases exercise the same path the API client takes.

- [ ] **Step 2: Run — expect red (module not found)**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365TenantSync.integration.test.ts
```

- [ ] **Step 3: Implement the harness**

`apps/api/src/__tests__/integration/m365SyncFakeExecutor.ts`:

```ts
/**
 * In-process fake `m365-graph-read-executor` for the tenant-sync integration
 * suite.
 *
 * It is a real node http server and it verifies the API's internal-auth JWT
 * with the same checks the real executor applies
 * (apps/m365-graph-read-executor/src/internalAuth.ts:78-106): EdDSA only, kid
 * match, iss/aud/sub pinned, iat+exp present with a lifetime of at most 60 s,
 * jti and correlationId UUIDs, operation bound to the route, and bodySha256
 * equal to the base64url SHA-256 of the exact received bytes. A harness that
 * accepted anything would prove nothing about the wire contract, which is the
 * only reason this exists instead of a client stub.
 *
 * The executor package is NOT a dependency of @breeze/api, so the checks are
 * mirrored here rather than imported. Keep them in step with that file.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, importJWK, jwtVerify, type JWK } from 'jose';
import type { M365SyncActionResult, M365SyncSourceState } from '@breeze/shared/m365';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BODY_DIGEST = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_LIFETIME_SECONDS = 60;

/** The https origin the API is configured with; the bridge maps it to loopback. */
export const FAKE_EXECUTOR_ORIGIN = 'https://executor.internal.example.test';
export const FAKE_EXECUTOR_KID = 'sync-test-key-1';

export interface FakeSyncCall {
  actionType: string;
  tenantId: string;
  correlationId: string;
  continuation?: string;
  backfill?: boolean;
}

export interface FakeSyncErrorResponse {
  status: number;
  body: unknown;
  retryAfterSeconds?: number;
}

export interface FakeSyncExecutor {
  origin: string;
  signingPrivateJwk: JWK;
  signingPublicJwk: JWK;
  signingKid: string;
  calls: FakeSyncCall[];
  unauthorizedCount: number;
  latencyMs: number;
  enqueue(actionType: string, response: M365SyncActionResult | FakeSyncErrorResponse): void;
  reset(): void;
  close(): Promise<void>;
}

function digestMatches(actual: string, claimed: unknown): boolean {
  if (typeof claimed !== 'string' || !BODY_DIGEST.test(claimed)) return false;
  const a = Buffer.from(actual, 'base64url');
  const b = Buffer.from(claimed, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}

function isErrorResponse(value: unknown): value is FakeSyncErrorResponse {
  return typeof value === 'object' && value !== null && 'status' in value;
}

export async function createFakeSyncExecutor(
  options: { latencyMs?: number } = {},
): Promise<FakeSyncExecutor> {
  const { publicKey, privateKey } = await generateKeyPair('Ed25519', { extractable: true });
  const signingPrivateJwk = { ...(await exportJWK(privateKey)), kid: FAKE_EXECUTOR_KID, alg: 'EdDSA' };
  const signingPublicJwk = { ...(await exportJWK(publicKey)), kid: FAKE_EXECUTOR_KID, alg: 'EdDSA' };
  const verificationKey = await importJWK(signingPublicJwk, 'EdDSA');

  const queues = new Map<string, Array<M365SyncActionResult | FakeSyncErrorResponse>>();
  const calls: FakeSyncCall[] = [];
  const state = { unauthorized: 0 };
  const latencyMs = options.latencyMs ?? 0;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks);
        const send = (status: number, body: unknown) => {
          const payload = JSON.stringify(body);
          response.writeHead(status, {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          });
          response.end(payload);
        };

        if (request.method !== 'POST' || request.url !== '/v1/sync-action') {
          send(404, { code: 'not_found' });
          return;
        }

        try {
          const authorization = request.headers.authorization;
          if (!authorization?.startsWith('Bearer ')) throw new Error('unauthorized');
          const token = authorization.slice('Bearer '.length);
          if (!token || /[\s]/.test(token)) throw new Error('unauthorized');
          const nowSeconds = Math.floor(Date.now() / 1_000);
          const { payload, protectedHeader } = await jwtVerify(token, verificationKey, {
            algorithms: ['EdDSA'],
            issuer: 'breeze-api',
            audience: 'm365-graph-read-executor',
            subject: 'breeze-control-plane',
            requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti'],
          });
          if (
            protectedHeader.kid !== FAKE_EXECUTOR_KID
            || !Number.isSafeInteger(payload.iat)
            || !Number.isSafeInteger(payload.exp)
            || (payload.exp as number) <= (payload.iat as number)
            || (payload.exp as number) - (payload.iat as number) > MAX_TOKEN_LIFETIME_SECONDS
            || (payload.iat as number) > nowSeconds
            || nowSeconds - (payload.iat as number) > MAX_TOKEN_LIFETIME_SECONDS
            || typeof payload.jti !== 'string' || !UUID.test(payload.jti)
            || payload.operation !== 'sync-action'
            || typeof payload.correlationId !== 'string' || !UUID.test(payload.correlationId)
            || !digestMatches(createHash('sha256').update(raw).digest('base64url'), payload.bodySha256)
          ) throw new Error('unauthorized');
        } catch {
          state.unauthorized += 1;
          send(401, { code: 'internal_request_unauthorized' });
          return;
        }

        let body: { correlationId?: string; tenantId?: string; action?: Record<string, unknown> };
        try {
          body = JSON.parse(raw.toString('utf8')) as typeof body;
        } catch {
          send(400, { code: 'invalid_request' });
          return;
        }
        const action = body.action ?? {};
        const actionType = typeof action.type === 'string' ? action.type : '';
        calls.push({
          actionType,
          tenantId: body.tenantId ?? '',
          correlationId: body.correlationId ?? '',
          continuation: typeof action.continuation === 'string' ? action.continuation : undefined,
          backfill: typeof action.backfill === 'boolean' ? action.backfill : undefined,
        });

        if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));

        const queued = queues.get(actionType)?.shift();
        if (!queued) {
          send(500, { code: 'no_fixture', action: actionType });
          return;
        }
        if (isErrorResponse(queued)) {
          if (queued.retryAfterSeconds !== undefined) {
            response.setHeader('retry-after', String(queued.retryAfterSeconds));
          }
          send(queued.status, queued.body);
          return;
        }
        send(200, queued);
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const loopback = `http://127.0.0.1:${port}`;

  // The API client captures `config.fetch ?? globalThis.fetch` at factory time
  // and refuses any non-https executor origin, so the only way to keep signing
  // + bounding + schema parsing real is to bridge the configured origin here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(FAKE_EXECUTOR_ORIGIN)) {
      return realFetch(`${loopback}${url.slice(FAKE_EXECUTOR_ORIGIN.length)}`, init);
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof globalThis.fetch;

  return {
    origin: FAKE_EXECUTOR_ORIGIN,
    signingPrivateJwk,
    signingPublicJwk,
    signingKid: FAKE_EXECUTOR_KID,
    calls,
    latencyMs,
    get unauthorizedCount() { return state.unauthorized; },
    enqueue(actionType, queued) {
      const list = queues.get(actionType) ?? [];
      list.push(queued);
      queues.set(actionType, list);
    },
    reset() {
      queues.clear();
      calls.length = 0;
      state.unauthorized = 0;
    },
    async close() {
      globalThis.fetch = realFetch;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture builders — projected item shapes per the shared interface contract.
// ---------------------------------------------------------------------------

function result(
  items: Record<string, unknown>[],
  sources: Record<string, M365SyncSourceState>,
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return {
    success: true,
    kind: 'sync',
    items,
    truncated: false,
    fetchedAt: '2026-09-08T10:00:00.000Z',
    sources,
    ...extra,
  };
}

export interface FakeUser {
  id: string;
  userPrincipalName: string;
  displayName?: string;
  accountEnabled?: boolean;
  assignedLicenses?: string[];
  mfaRegistered?: boolean | null;
  adminRoles?: { roleTemplateId: string; displayName: string; viaGroupId?: string }[] | null;
}

export function syncUsersResult(
  users: FakeUser[],
  sources: Record<string, M365SyncSourceState> = { users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok' },
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return result(users.map((user) => ({
    id: user.id,
    userPrincipalName: user.userPrincipalName,
    displayName: user.displayName ?? user.userPrincipalName,
    mail: user.userPrincipalName,
    accountEnabled: user.accountEnabled ?? true,
    jobTitle: null,
    department: null,
    usageLocation: 'US',
    onPremisesSyncEnabled: false,
    createdDateTime: '2026-01-05T00:00:00.000Z',
    assignedLicenses: user.assignedLicenses ?? [],
    mfaRegistered: user.mfaRegistered ?? true,
    mfaCapable: user.mfaRegistered ?? true,
    defaultMfaMethod: user.mfaRegistered === null ? null : 'microsoftAuthenticatorPush',
    adminRoles: user.adminRoles ?? [],
  })), sources, extra);
}

export function syncSigninActivityResult(
  entries: { id: string; lastSuccessfulSignInAt: string | null }[],
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return result(entries, { signInActivity: 'ok' }, extra);
}

export function syncIntuneDevicesResult(
  devices: { id: string; deviceName: string; serialNumber?: string | null; complianceState?: string }[],
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return result(devices.map((device) => ({
    id: device.id,
    deviceName: device.deviceName,
    operatingSystem: 'Windows',
    osVersion: '10.0.26100.1',
    complianceState: device.complianceState ?? 'compliant',
    lastSyncDateTime: '2026-09-08T09:00:00.000Z',
    userPrincipalName: 'ada@contoso.example',
    managedDeviceOwnerType: 'company',
    enrolledDateTime: '2026-02-01T00:00:00.000Z',
    model: 'OptiPlex 7010',
    manufacturer: 'Dell Inc.',
    serialNumber: device.serialNumber ?? null,
    azureADDeviceId: '99999999-9999-4999-8999-999999999999',
    managementAgent: 'mdm',
    jailBroken: 'Unknown',
  })), { managedDevices: 'ok' }, extra);
}

export function syncCaPoliciesResult(
  policies: { id: string; displayName: string; state: string; modifiedDateTime?: string }[],
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return result(policies.map((policy) => ({
    id: policy.id,
    displayName: policy.displayName,
    state: policy.state,
    createdDateTime: '2026-03-01T00:00:00.000Z',
    modifiedDateTime: policy.modifiedDateTime ?? '2026-08-01T00:00:00.000Z',
    conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] } },
    grantControls: { operator: 'OR', builtInControls: ['mfa'] },
    sessionControls: null,
  })), { policies: 'ok' }, extra);
}

export function syncSkusResult(
  skus: { skuId: string; skuPartNumber: string; consumedUnits: number; enabled: number }[],
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return result(skus.map((sku) => ({
    skuId: sku.skuId,
    skuPartNumber: sku.skuPartNumber,
    consumedUnits: sku.consumedUnits,
    prepaidUnits: { enabled: sku.enabled, suspended: 0, warning: 0 },
    capabilityStatus: 'Enabled',
    appliesTo: 'User',
  })), { subscribedSkus: 'ok' }, extra);
}

/** `days` scores ending at `endDate`, one per calendar day, Graph-dated. */
export function syncSecureScoreResult(
  endDate: string,
  days: number,
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  const end = new Date(`${endDate}T02:00:00.000Z`);
  const items = Array.from({ length: days }, (_unused, index) => {
    const created = new Date(end.getTime() - index * 24 * 3_600 * 1_000);
    return {
      id: `score-${created.toISOString().slice(0, 10)}`,
      createdDateTime: created.toISOString(),
      currentScore: 410 - index,
      maxScore: 600,
      activeUserCount: 42,
      licensedUserCount: 50,
      controlScores: [
        // `title` is part of the projected controlScores shape in the contract
        // (string | null) — the executor joins it from controlProfiles, and a
        // profile it could not resolve arrives as null.
        { controlName: 'MfaRegistrationV2', title: 'Ensure all users can complete multi-factor authentication', score: 30, maxScore: 30, implementationStatus: 'Implemented' },
        { controlName: 'BlockLegacyAuthentication', title: null, score: 0, maxScore: 20, implementationStatus: 'Not implemented' },
      ],
    };
  });
  return result(items, { secureScores: 'ok', controlProfiles: 'ok' }, extra);
}
```

- [ ] **Step 4: Run — expect green**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365TenantSync.integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/m365SyncFakeExecutor.ts \
        apps/api/src/__tests__/integration/m365TenantSync.integration.test.ts
git commit -m "$(cat <<'MSG'
test(m365): in-process fake sync executor with real internal-auth verification

The harness is a node http server that applies the same JWT checks as
apps/m365-graph-read-executor/src/internalAuth.ts (EdDSA, kid, iss/aud/sub,
<=60s lifetime, UUID jti + correlationId, operation binding, bodySha256 over
the exact received bytes) and returns canned M365SyncActionResult payloads
keyed by action.type. globalThis.fetch is bridged for the configured executor
origin only, so signing, response bounding and schema parsing stay real.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 2: First-run end-to-end across all six domains

Spec §9 ("seed a connection, run all six domains (sign-in with a continuation), assert rows, sync state, rollup, 90-day score backfill keyed by Graph dates"), §3.1–§3.3, §5.3–§5.4, §5.9.

**Files:**
- Modify: `apps/api/src/__tests__/integration/m365TenantSync.integration.test.ts`

**Interfaces:**
- Consumes: `runSyncDomain` and `M365SyncJobData` (`apps/api/src/services/m365Sync/run.ts`, `…/types.ts`, W04); `claimDueDomains` (`…/claim.ts`, W04); `upsertPostureRollup` (`…/rollup.ts`, W05); `isM365TenantSyncEnabled` (`apps/api/src/config/env.ts`, W04); `m365Connections` (`apps/api/src/db/schema`); tables `m365_sync_state`, `m365_users`, `m365_intune_devices`, `m365_ca_policies`, `m365_license_skus`, `m365_secure_score_snapshots`, `m365_posture_rollups` (W02); `createOrganization`, `createPartner`, `createUser` (`./db-utils`); `getTestDb` (`./setup`).

- [ ] **Step 1: Write the failing test**

Append to `m365TenantSync.integration.test.ts` (module-level helpers first, then the block):

```ts
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { m365Connections } from '../../db/schema';
import { runSyncDomain } from '../../services/m365Sync/run';
import { claimDueDomains } from '../../services/m365Sync/claim';
import type { M365SyncDomain } from '@breeze/shared/m365';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';
import {
  syncCaPoliciesResult, syncIntuneDevicesResult, syncSecureScoreResult,
  syncSigninActivityResult, syncSkusResult, syncUsersResult,
} from './m365SyncFakeExecutor';

vi.mock('../../services/m365ControlPlane/runtimeConfig', () => ({
  loadM365CustomerGraphReadRuntimeConfig: vi.fn(() => ({
    clientId: '55555555-5555-4555-8555-555555555555',
    vaultRef: 'akv://vault.example/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
    credentialVersion: '0123456789abcdef0123456789abcdef',
    callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback',
    executorUrl: syncExecutorConfig.origin,
    executorAudience: 'm365-graph-read-executor',
    executorSigningPrivateJwk: syncExecutorConfig.signingPrivateJwk,
    executorSigningKid: syncExecutorConfig.signingKid,
    onboardingOrgIds: '*',
  })),
}));

// `vi.mock` is hoisted above `beforeAll`, so the config it closes over must be
// a hoisted, mutable holder rather than the executor object itself.
const syncExecutorConfig = vi.hoisted(() => ({
  origin: 'https://executor.internal.example.test',
  signingPrivateJwk: {} as Record<string, unknown>,
  signingKid: 'sync-test-key-1',
}));

const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const DOMAINS: M365SyncDomain[] = [
  'users', 'signin_activity', 'intune_devices', 'ca_policies', 'skus', 'secure_score',
];

interface SyncFixture { orgId: string; connectionId: string; actorId: string }

async function seedConnectedOrg(): Promise<SyncFixture> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `m365-sync-${Date.now()}-${crypto.randomUUID()}@example.com`,
    });
    const [connection] = await db.insert(m365Connections).values({
      orgId: org.id,
      userId: null,
      tenantId: TENANT_ID,
      clientId: '55555555-5555-4555-8555-555555555555',
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: 'akv://vault.example/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
      credentialVersion: '0123456789abcdef0123456789abcdef',
      permissionManifestVersion: 3,
      observedGrants: [],
      consentAttemptId: crypto.randomUUID(),
      grantsVerifiedAt: new Date('2026-09-08T08:00:00.000Z'),
      displayName: 'Contoso',
      status: 'active',
      consentedAt: new Date('2026-09-08T08:00:00.000Z'),
      lastVerifiedAt: new Date('2026-09-08T08:00:00.000Z'),
      createdBy: user.id,
    }).returning();
    return { orgId: org.id, connectionId: connection!.id, actorId: user.id };
  });
}

async function seedDueStateRows(fixture: SyncFixture, domains = DOMAINS): Promise<void> {
  const admin = getTestDb();
  for (const domain of domains) {
    await admin.execute(sql`
      INSERT INTO m365_sync_state (org_id, connection_id, domain, next_sync_at, interval_seconds)
      VALUES (${fixture.orgId}::uuid, ${fixture.connectionId}::uuid, ${domain}::m365_sync_domain,
              now(), 21600)
      ON CONFLICT (org_id, domain) DO UPDATE SET next_sync_at = now(), lease_until = NULL
    `);
  }
}

async function claimFor(fixture: SyncFixture) {
  const claimed = await claimDueDomains({ limit: 20 });
  return claimed.filter((job) => job.orgId === fixture.orgId);
}

async function rows<T = Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await getTestDb().execute(query);
  return result as unknown as T[];
}
```

Then the block:

```ts
describe('m365 tenant sync — first run across all six domains', () => {
  runDb('populates every table, sync state, rollup, and the Graph-dated score backfill', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture);

    executor.enqueue('m365.sync.users', syncUsersResult([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example', assignedLicenses: ['11111111-0000-4000-8000-00000000000a'] },
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', userPrincipalName: 'grace@contoso.example', mfaRegistered: null,
        adminRoles: [{ roleTemplateId: '62e90394-69f5-4237-9190-012177145e10', displayName: 'Global Administrator' }] },
      { id: 'aaaaaaaa-0000-4000-8000-000000000003', userPrincipalName: 'alan@contoso.example', accountEnabled: false },
    ]));
    // Sign-in activity returns a continuation once, then completes.
    executor.enqueue('m365.sync.signin_activity', syncSigninActivityResult(
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', lastSuccessfulSignInAt: '2026-09-07T12:00:00.000Z' }],
      { continuation: 'page-2-token' },
    ));
    executor.enqueue('m365.sync.signin_activity', syncSigninActivityResult([
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', lastSuccessfulSignInAt: '2026-09-06T09:30:00.000Z' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000003', lastSuccessfulSignInAt: null },
    ]));
    executor.enqueue('m365.sync.intune_devices', syncIntuneDevicesResult([
      { id: 'bbbbbbbb-0000-4000-8000-000000000001', deviceName: 'CONTOSO-LT-01', serialNumber: 'SN-ALPHA-1' },
      { id: 'bbbbbbbb-0000-4000-8000-000000000002', deviceName: 'CONTOSO-LT-02', serialNumber: 'SN-ALPHA-2', complianceState: 'noncompliant' },
    ]));
    executor.enqueue('m365.sync.ca_policies', syncCaPoliciesResult([
      { id: 'cccccccc-0000-4000-8000-000000000001', displayName: 'Require MFA for admins', state: 'enabled' },
      { id: 'cccccccc-0000-4000-8000-000000000002', displayName: 'Legacy auth block (report only)', state: 'enabledForReportingButNotEnforced' },
    ]));
    executor.enqueue('m365.sync.skus', syncSkusResult([
      { skuId: '11111111-0000-4000-8000-00000000000a', skuPartNumber: 'SPB', consumedUnits: 3, enabled: 10 },
    ]));
    executor.enqueue('m365.sync.secure_score', syncSecureScoreResult('2026-09-08', 90));

    // Drive every claimed domain. The sign-in fixture hands back
    // `continuation: 'page-2-token'` on its first call, so THAT run resolves
    // 'partial-continue' — a control-flow-only M365SyncRunResult that never
    // reaches last_status. Every other domain completes in one pass.
    for (const job of await claimFor(fixture)) {
      await expect(runSyncDomain(job), job.domain).resolves.toBe(
        job.domain === 'signin_activity' ? 'partial-continue' : 'success',
      );
    }
    const [signinAgain] = (await claimFor(fixture)).filter((job) => job.domain === 'signin_activity');
    expect(signinAgain, 'a continuation must leave signin_activity due immediately').toBeDefined();
    // Second page: the fixture carries no continuation, so the walk completes.
    await expect(runSyncDomain(signinAgain!)).resolves.toBe('success');

    // Entity rows
    expect(await rows(sql`SELECT graph_id, is_stale FROM m365_users WHERE org_id = ${fixture.orgId}::uuid`)).toHaveLength(3);
    expect(await rows(sql`SELECT graph_id FROM m365_intune_devices WHERE org_id = ${fixture.orgId}::uuid`)).toHaveLength(2);
    expect(await rows(sql`SELECT graph_id FROM m365_ca_policies WHERE org_id = ${fixture.orgId}::uuid`)).toHaveLength(2);
    expect(await rows(sql`SELECT graph_id FROM m365_license_skus WHERE org_id = ${fixture.orgId}::uuid`)).toHaveLength(1);

    // Enrichment semantics: unknown MFA stays NULL, never false.
    const [grace] = await rows<{ mfa_registered: boolean | null; is_admin: boolean }>(sql`
      SELECT mfa_registered, is_admin FROM m365_users
      WHERE org_id = ${fixture.orgId}::uuid AND graph_id = 'aaaaaaaa-0000-4000-8000-000000000002'`);
    expect(grace!.mfa_registered).toBeNull();
    expect(grace!.is_admin).toBe(true);

    // Sign-in activity landed field-wise on the user rows.
    const [ada] = await rows<{ last_successful_sign_in_at: Date | null }>(sql`
      SELECT last_successful_sign_in_at FROM m365_users
      WHERE org_id = ${fixture.orgId}::uuid AND graph_id = 'aaaaaaaa-0000-4000-8000-000000000001'`);
    expect(ada!.last_successful_sign_in_at?.toISOString()).toBe('2026-09-07T12:00:00.000Z');

    // Secure score: 90 rows keyed by Graph's own date, not the fetch day.
    const scores = await rows<{ score_date: string; current_score: string }>(sql`
      SELECT score_date::text AS score_date, current_score::text AS current_score
      FROM m365_secure_score_snapshots WHERE org_id = ${fixture.orgId}::uuid ORDER BY score_date DESC`);
    expect(scores).toHaveLength(90);
    expect(scores[0]!.score_date).toBe('2026-09-08');
    expect(scores.at(-1)!.score_date).toBe('2026-06-11');
    expect(await rows(sql`
      SELECT 1 FROM m365_secure_score_snapshots
      WHERE org_id = ${fixture.orgId}::uuid AND tenant_id = ${TENANT_ID}::uuid`)).toHaveLength(90);

    // Sync state completion fields, per domain.
    const states = await rows<{
      domain: string; last_status: string; truncated: boolean; continuation: string | null;
      last_complete_snapshot_at: Date | null; sources: Record<string, string>;
      last_counts: Record<string, number>; lease_until: Date | null; next_sync_at: Date | null;
    }>(sql`
      SELECT domain, last_status, truncated, continuation, last_complete_snapshot_at,
             sources, last_counts, lease_until, next_sync_at
      FROM m365_sync_state WHERE org_id = ${fixture.orgId}::uuid ORDER BY domain`);
    expect(states.map((state) => state.domain).sort()).toEqual([...DOMAINS].sort());
    for (const state of states) {
      expect(state.last_status, state.domain).toBe('success');
      expect(state.truncated, state.domain).toBe(false);
      expect(state.continuation, state.domain).toBeNull();
      expect(state.lease_until, state.domain).toBeNull();
      expect(state.last_complete_snapshot_at, state.domain).not.toBeNull();
      expect(state.next_sync_at, state.domain).not.toBeNull();
      expect(Object.values(state.sources), state.domain).not.toContain('error');
    }
    // last_counts holds the snake_case ROLLUP column names (contract: "counts
    // keys are snake_case rollup column names"), not the persister's
    // inserted/updated/unchanged tally — that lives on DomainPersistResult and
    // is asserted in Task 3.
    const users = states.find((state) => state.domain === 'users')!;
    expect(users.last_counts).toMatchObject({
      users_total: 3, users_enabled: 2, users_mfa_unknown: 1, users_admin: 1,
    });

    // Rollup row for today, with per-domain freshness.
    const [rollup] = await rows<{
      users_total: number; users_mfa_unknown: number; devices_total: number;
      devices_noncompliant: number; ca_policies_enabled: number; ca_policies_report_only: number;
      seats_purchased: number; seats_consumed: number; secure_score: string;
      domains_fresh: Record<string, { asOf: string; complete: boolean }>;
    }>(sql`
      SELECT users_total, users_mfa_unknown, devices_total, devices_noncompliant,
             ca_policies_enabled, ca_policies_report_only, seats_purchased, seats_consumed,
             secure_score::text AS secure_score, domains_fresh
      FROM m365_posture_rollups
      WHERE org_id = ${fixture.orgId}::uuid AND rollup_date = current_date`);
    expect(rollup).toBeDefined();
    expect(rollup!).toMatchObject({
      users_total: 3, users_mfa_unknown: 1, devices_total: 2, devices_noncompliant: 1,
      ca_policies_enabled: 1, ca_policies_report_only: 1, seats_purchased: 10, seats_consumed: 3,
    });
    expect(Object.keys(rollup!.domains_fresh).sort()).toEqual([...DOMAINS].sort());
    for (const domain of DOMAINS) {
      expect(rollup!.domains_fresh[domain]!.complete, domain).toBe(true);
    }

    // The executor saw the backfill flag exactly once and the continuation round trip.
    expect(executor.calls.filter((call) => call.actionType === 'm365.sync.secure_score')[0]!.backfill).toBe(true);
    const signinCalls = executor.calls.filter((call) => call.actionType === 'm365.sync.signin_activity');
    expect(signinCalls).toHaveLength(2);
    expect(signinCalls[0]!.continuation).toBeUndefined();
    expect(signinCalls[1]!.continuation).toBe('page-2-token');
  });
});
```

Wire the hoisted config in `beforeAll`, before any sync call:

```ts
beforeAll(async () => {
  executor = await createFakeSyncExecutor();
  syncExecutorConfig.origin = executor.origin;
  syncExecutorConfig.signingPrivateJwk = executor.signingPrivateJwk as Record<string, unknown>;
  syncExecutorConfig.signingKid = executor.signingKid;
});
```

- [ ] **Step 2: Run — expect red on the row assertions**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365TenantSync.integration.test.ts
```

- [ ] **Step 3: Implement**

No production change is expected — W04/W05 own this behaviour. Any red here is either a fixture mismatch (fix the fixture) or a real defect in W04/W05 (fix it in `apps/api/src/services/m365Sync/`, and say which file and why in the PR body). Do not weaken an assertion to make it pass; the assertions above are the spec's §5.4 freshness contract and §5.9 rollup contract restated.

- [ ] **Step 4: Run — expect green**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365TenantSync.integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/m365TenantSync.integration.test.ts
git commit -m "$(cat <<'MSG'
test(m365): end-to-end first sync run across all six domains

Seeds an org with an active manifest-v3 customer-graph-read connection and six
due sync-state rows, claims them, and runs runSyncDomain directly for each.
Asserts rows in all seven tables, per-domain sync-state completion fields,
mfa_registered NULL for a user absent from the registration report, the
sign-in continuation round trip, the 90-day Secure Score backfill keyed by
Graph's createdDateTime (not the fetch day), and the posture rollup including
domains_fresh.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 3: Change-only second run — exactly one entity write

Spec §5.4 ("Unchanged rows are not written"), §9 ("run again with one changed user and assert exactly one entity write").

**Files:**
- Modify: `apps/api/src/__tests__/integration/m365TenantSync.integration.test.ts`

**Interfaces:**
- Consumes: as Task 2, plus `DOMAIN_PERSISTERS` (`apps/api/src/services/m365Sync/run.ts`, W04) — wrapped for the duration of one run so the `DomainPersistResult` the users persister returns can be asserted directly. `canonicalHash` (`apps/api/src/services/m365Sync/hash.ts`, W04) is referenced in a comment only, never asserted.

Add `DOMAIN_PERSISTERS` to the existing `../../services/m365Sync/run` import at the top of the file (it already imports `runSyncDomain` from there).

**Technique (stated explicitly, because "no writes" is the assertion that is easiest to fake):** Postgres stamps every new tuple version with the id of the transaction that produced it, readable as the system column `xmin`. An `UPDATE` always writes a new tuple version, so `xmin` changes for exactly the rows that were written, whether or not the new values differ. Snapshot `(graph_id, xmin)` for the org before the second run, snapshot again after, and assert the multiset difference is exactly one row. `last_changed_at` is asserted alongside it because `xmin` alone would also move for a spurious "touch" write — which is precisely what §5.4 forbids.

- [ ] **Step 1: Write the failing test**

```ts
describe('m365 tenant sync — change-only writes', () => {
  runDb('writes exactly one user row when exactly one user changed', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['users']);

    const baseline = [
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example', displayName: 'Ada Lovelace' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', userPrincipalName: 'grace@contoso.example', displayName: 'Grace Hopper' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000003', userPrincipalName: 'alan@contoso.example', displayName: 'Alan Turing' },
    ];
    executor.enqueue('m365.sync.users', syncUsersResult(baseline));
    const [firstJob] = await claimFor(fixture);
    await expect(runSyncDomain(firstJob!)).resolves.toBe('success');

    const tupleVersions = async () => rows<{ graph_id: string; xmin: string; last_changed_at: Date }>(sql`
      SELECT graph_id, xmin::text AS xmin, last_changed_at
      FROM m365_users WHERE org_id = ${fixture.orgId}::uuid ORDER BY graph_id`);
    const before = await tupleVersions();
    expect(before).toHaveLength(3);

    // Second run: identical payload except one user's job title.
    executor.enqueue('m365.sync.users', syncUsersResult(baseline.map((user) =>
      user.id.endsWith('002') ? { ...user, displayName: 'Grace M. Hopper' } : user)));
    await getTestDb().execute(sql`
      UPDATE m365_sync_state SET next_sync_at = now(), lease_until = NULL
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'users'`);
    // The inserted/updated/unchanged tally is the persister's
    // DomainPersistResult, NOT last_counts — last_counts carries the
    // snake_case rollup columns (users_total, users_enabled, …). Observe the
    // real returned value by wrapping the registered persister for this run.
    type PersistResult = Awaited<ReturnType<NonNullable<(typeof DOMAIN_PERSISTERS)['users']>>>;
    const persisted: PersistResult[] = [];
    const realPersistUsers = DOMAIN_PERSISTERS.users!;
    DOMAIN_PERSISTERS.users = async (context, actionResult) => {
      const outcome = await realPersistUsers(context, actionResult);
      persisted.push(outcome);
      return outcome;
    };
    try {
      const [secondJob] = await claimFor(fixture);
      await expect(runSyncDomain(secondJob!)).resolves.toBe('success');
    } finally {
      DOMAIN_PERSISTERS.users = realPersistUsers;
    }

    const after = await tupleVersions();
    const rewritten = after.filter((row, index) => row.xmin !== before[index]!.xmin);
    expect(rewritten.map((row) => row.graph_id)).toEqual(['aaaaaaaa-0000-4000-8000-000000000002']);
    expect(after[1]!.last_changed_at.getTime()).toBeGreaterThan(before[1]!.last_changed_at.getTime());
    expect(after[0]!.last_changed_at.getTime()).toBe(before[0]!.last_changed_at.getTime());
    expect(after[2]!.last_changed_at.getTime()).toBe(before[2]!.last_changed_at.getTime());

    expect(persisted, 'the users persister ran exactly once on the second pass').toHaveLength(1);
    expect(persisted[0]).toMatchObject({ inserted: 0, updated: 1, unchanged: 2 });

    // And the state row's last_counts still carries only rollup columns.
    const [state] = await rows<{ last_counts: Record<string, number> }>(sql`
      SELECT last_counts FROM m365_sync_state
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'users'`);
    expect(state!.last_counts).toMatchObject({ users_total: 3, users_enabled: 3 });
    expect(Object.keys(state!.last_counts)).not.toContain('updated');
  });

  runDb('writes nothing at all when the tenant is unchanged', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['ca_policies']);
    const policies = [{ id: 'cccccccc-0000-4000-8000-000000000001', displayName: 'Require MFA for admins', state: 'enabled' }];

    executor.enqueue('m365.sync.ca_policies', syncCaPoliciesResult(policies));
    await runSyncDomain((await claimFor(fixture))[0]!);
    const before = await rows<{ xmin: string }>(sql`
      SELECT xmin::text AS xmin FROM m365_ca_policies WHERE org_id = ${fixture.orgId}::uuid ORDER BY graph_id`);

    executor.enqueue('m365.sync.ca_policies', syncCaPoliciesResult(policies));
    await getTestDb().execute(sql`
      UPDATE m365_sync_state SET next_sync_at = now(), lease_until = NULL
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'ca_policies'`);
    await runSyncDomain((await claimFor(fixture))[0]!);

    const after = await rows<{ xmin: string }>(sql`
      SELECT xmin::text AS xmin FROM m365_ca_policies WHERE org_id = ${fixture.orgId}::uuid ORDER BY graph_id`);
    expect(after).toEqual(before);
  });
});
```

- [ ] **Step 2: Run — expect red**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365TenantSync.integration.test.ts -t 'change-only'
```

- [ ] **Step 3: Implement** — as Task 2, no production change expected; fix W04's persister only if the hash genuinely covers a non-primary field (that is the §5.4 defect the test is designed to catch).

- [ ] **Step 4: Run — expect green** (same command, then the whole file).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/m365TenantSync.integration.test.ts
git commit -m "$(cat <<'MSG'
test(m365): prove change-only writes with an xmin tuple-version diff

A second run with one changed user must rewrite exactly one row. Asserted by
snapshotting (graph_id, xmin) before and after — every UPDATE produces a new
tuple version, so xmin moves for precisely the rows written — plus
last_changed_at staying put on the two unchanged rows. A fully unchanged
tenant writes no entity rows at all.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 4: Truncated run leaves no stale marks; fenced run writes nothing

Spec §5.3 (Phase C fencing), §5.4 (complete run gates stale marking), §6 (generation mismatch → discard + metric), §9.

**Files:**
- Modify: `apps/api/src/__tests__/integration/m365TenantSync.integration.test.ts`

**Interfaces:**
- Consumes: `registerM365SyncMetrics` (`apps/api/src/services/m365Sync/metrics.ts`, W04 — the registrar the contract pins); metric `m365_sync_fenced_total`; `Registry` from `prom-client`.

- [ ] **Step 1: Write the failing test**

```ts
import { Registry } from 'prom-client';
import { registerM365SyncMetrics } from '../../services/m365Sync/metrics';

async function counterValue(registry: Registry, name: string): Promise<number> {
  const metric = registry.getSingleMetric(name);
  if (!metric) return Number.NaN;
  const collected = (await metric.get()) as { values: { value: number }[] };
  return collected.values.reduce((total, sample) => total + sample.value, 0);
}

describe('m365 tenant sync — incomplete and fenced runs', () => {
  runDb('a truncated run persists what it got and marks nothing stale', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['users']);

    executor.enqueue('m365.sync.users', syncUsersResult([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', userPrincipalName: 'grace@contoso.example' },
    ]));
    await runSyncDomain((await claimFor(fixture))[0]!);
    const [completeState] = await rows<{ last_complete_snapshot_at: Date | null }>(sql`
      SELECT last_complete_snapshot_at FROM m365_sync_state
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'users'`);
    expect(completeState!.last_complete_snapshot_at).not.toBeNull();

    // Second run truncates and omits the second user. Nothing may go stale.
    executor.enqueue('m365.sync.users', syncUsersResult(
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example' }],
      { users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok' },
      { truncated: true },
    ));
    await getTestDb().execute(sql`
      UPDATE m365_sync_state SET next_sync_at = now(), lease_until = NULL
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'users'`);
    await expect(runSyncDomain((await claimFor(fixture))[0]!)).resolves.toBe('partial');

    expect(await rows(sql`
      SELECT graph_id FROM m365_users
      WHERE org_id = ${fixture.orgId}::uuid AND is_stale`)).toEqual([]);
    const [state] = await rows<{
      last_status: string; truncated: boolean; last_complete_snapshot_at: Date | null; interval_seconds: number;
    }>(sql`
      SELECT last_status, truncated, last_complete_snapshot_at, interval_seconds
      FROM m365_sync_state WHERE org_id = ${fixture.orgId}::uuid AND domain = 'users'`);
    expect(state!.last_status).toBe('partial');
    expect(state!.truncated).toBe(true);
    expect(state!.last_complete_snapshot_at?.getTime())
      .toBe(completeState!.last_complete_snapshot_at?.getTime());
    expect(state!.interval_seconds, 'truncation doubles the interval (§5.7)').toBe(43_200);
  });

  runDb('a complete run after a truncated one does mark the vanished row stale', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['users']);
    executor.enqueue('m365.sync.users', syncUsersResult([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', userPrincipalName: 'grace@contoso.example' },
    ]));
    await runSyncDomain((await claimFor(fixture))[0]!);

    executor.enqueue('m365.sync.users', syncUsersResult([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example' },
    ]));
    await getTestDb().execute(sql`
      UPDATE m365_sync_state SET next_sync_at = now(), lease_until = NULL
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'users'`);
    await runSyncDomain((await claimFor(fixture))[0]!);

    const stale = await rows<{ graph_id: string; stale_since: Date | null }>(sql`
      SELECT graph_id, stale_since FROM m365_users
      WHERE org_id = ${fixture.orgId}::uuid AND is_stale`);
    expect(stale.map((row) => row.graph_id)).toEqual(['aaaaaaaa-0000-4000-8000-000000000002']);
    expect(stale[0]!.stale_since).not.toBeNull();
  });

  runDb('a run whose generation was superseded discards its result and counts a fence', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['skus']);

    executor.enqueue('m365.sync.skus', syncSkusResult([
      { skuId: '11111111-0000-4000-8000-00000000000a', skuPartNumber: 'SPB', consumedUnits: 3, enabled: 10 },
    ]));
    const [job] = await claimFor(fixture);
    // The ticker reclaimed the row while this job was in flight.
    await getTestDb().execute(sql`
      UPDATE m365_sync_state SET run_generation = run_generation + 1
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'skus'`);

    const fencedBefore = await counterValue(registry, 'm365_sync_fenced_total');
    await expect(runSyncDomain(job!)).resolves.toBe('fenced');
    expect(await counterValue(registry, 'm365_sync_fenced_total')).toBe(fencedBefore + 1);

    expect(await rows(sql`SELECT graph_id FROM m365_license_skus WHERE org_id = ${fixture.orgId}::uuid`)).toEqual([]);
    const [state] = await rows<{ last_status: string | null; last_run_at: Date | null }>(sql`
      SELECT last_status, last_run_at FROM m365_sync_state
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'skus'`);
    expect(state!.last_status).toBeNull();
    expect(state!.last_run_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect red**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365TenantSync.integration.test.ts -t 'incomplete and fenced'
```

- [ ] **Step 3: Implement** — as Task 2. `m365_sync_fenced_total` is unprefixed by contract (W04 decision 9); if it is missing entirely, register it in W04's `metrics.ts` rather than renaming the assertion.

- [ ] **Step 4: Run — expect green.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/m365TenantSync.integration.test.ts
git commit -m "$(cat <<'MSG'
test(m365): truncated runs never mark stale; superseded generations write nothing

Covers the §5.4 freshness contract (a truncated run persists what it got,
leaves last_complete_snapshot_at alone, doubles the interval, and marks no row
stale; the next complete run does mark the vanished row) and the §5.3 Phase C
fence (a job whose run_generation was superseded mid-flight discards its
result, writes no entity rows, leaves the state row untouched, and increments
m365_sync_fenced_total).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 5: Disconnect deletes entities and keeps history

Spec §5.8 (disconnect hook), §3.3 (`tenant_id` on history tables), §9 (lifecycle tests).

**Files:**
- Modify: `apps/api/src/__tests__/integration/m365TenantSync.integration.test.ts`

**Interfaces:**
- Consumes: `disconnectCustomerGraphReadConnection` (`apps/api/src/services/m365ControlPlane/connectionService.ts`); `onConnectionDisconnected` (`apps/api/src/services/m365Sync/lifecycle.ts`, W05) — exercised through the disconnect route service, not called directly, so the hook wiring is what is proved.

- [ ] **Step 1: Write the failing test**

```ts
import { disconnectCustomerGraphReadConnection } from '../../services/m365ControlPlane/connectionService';

describe('m365 tenant sync — disconnect', () => {
  runDb('deletes entity and state rows, keeps tenant-stamped history', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['users', 'skus', 'secure_score']);

    executor.enqueue('m365.sync.users', syncUsersResult([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example' },
    ]));
    executor.enqueue('m365.sync.skus', syncSkusResult([
      { skuId: '11111111-0000-4000-8000-00000000000a', skuPartNumber: 'SPB', consumedUnits: 1, enabled: 5 },
    ]));
    executor.enqueue('m365.sync.secure_score', syncSecureScoreResult('2026-09-08', 3));
    for (const job of await claimFor(fixture)) await runSyncDomain(job);

    expect(await rows(sql`SELECT graph_id FROM m365_users WHERE org_id = ${fixture.orgId}::uuid`)).toHaveLength(1);
    expect(await rows(sql`SELECT score_date FROM m365_secure_score_snapshots WHERE org_id = ${fixture.orgId}::uuid`)).toHaveLength(3);
    const rollupsBefore = await rows(sql`SELECT rollup_date FROM m365_posture_rollups WHERE org_id = ${fixture.orgId}::uuid`);
    expect(rollupsBefore.length).toBeGreaterThan(0);

    await disconnectCustomerGraphReadConnection({
      id: fixture.connectionId, orgId: fixture.orgId, actorId: fixture.actorId,
    });

    // Entities and schedule: gone.
    expect(await rows(sql`SELECT graph_id FROM m365_users WHERE org_id = ${fixture.orgId}::uuid`)).toEqual([]);
    expect(await rows(sql`SELECT graph_id FROM m365_license_skus WHERE org_id = ${fixture.orgId}::uuid`)).toEqual([]);
    expect(await rows(sql`SELECT domain FROM m365_sync_state WHERE org_id = ${fixture.orgId}::uuid`)).toEqual([]);

    // History: kept, still stamped with the tenant it came from.
    const scores = await rows<{ tenant_id: string }>(sql`
      SELECT tenant_id::text AS tenant_id FROM m365_secure_score_snapshots
      WHERE org_id = ${fixture.orgId}::uuid`);
    expect(scores).toHaveLength(3);
    expect(new Set(scores.map((score) => score.tenant_id))).toEqual(new Set([TENANT_ID]));
    expect(await rows(sql`SELECT rollup_date FROM m365_posture_rollups WHERE org_id = ${fixture.orgId}::uuid`))
      .toHaveLength(rollupsBefore.length);

    // The connection row itself survives as revoked with the tenant released.
    const [connection] = await withSystemDbAccessContext(() => db.select().from(m365Connections)
      .where(eq(m365Connections.id, fixture.connectionId)));
    expect(connection).toMatchObject({ status: 'revoked', tenantId: null });
  });
});
```

- [ ] **Step 2: Run — expect red**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365TenantSync.integration.test.ts -t 'disconnect'
```

- [ ] **Step 3: Implement** — as Task 2. The likely genuine defect this catches is the disconnect hook not being wired into `disconnectCustomerGraphReadConnection` at all (the spec calls it out as a hook, and disconnect does not delete the connection row so no FK cascade fires).

- [ ] **Step 4: Run — expect green**, then the whole file:

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365TenantSync.integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/m365TenantSync.integration.test.ts
git commit -m "$(cat <<'MSG'
test(m365): disconnect drops entities and schedule, keeps tenant-stamped history

Disconnect sets revoked and clears the tenant without deleting the connection
row, so no FK cascade fires and the lifecycle hook is the only thing that can
clean up. Asserts m365_users / m365_license_skus / m365_sync_state are emptied
while m365_secure_score_snapshots and m365_posture_rollups survive with their
tenant_id intact.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 6: Re-consent integration cases

Spec §2.2 (upgrade consent), §9 ("v2 row derives manifest-stale, DTO exposes it, sync still runs").

**Scope, deliberately narrow.** W01's own suite already proves the consent-session mechanics: that a new upgrade session binds to the existing consent attempt, that a successful callback promotes the manifest in place and bumps `consentGeneration`, and that an abandoned upgrade leaves the connection executing on v2. Re-asserting them here would be a second copy of W01's contract that drifts the first time W01 changes. What is left — and what only this wave can see, because it needs both W01's DTO and W04/W05's sync path in one process — is the **DTO exposure** of `grantHealth`, and the fact that **sync keeps running on v2 grants** while the upgrade is pending.

**Files:**
- Modify: `apps/api/src/__tests__/integration/m365ConnectionLifecycle.integration.test.ts`

That suite is 266 lines and already carries the `runtimeConfig` mock, the org/partner/user fixture, and the connection helper these cases need; a new file would clone all three. Add a `describe` block at the end.

**Interfaces:**
- Consumes: `deriveGrantHealth` and `initiateCustomerGraphReadUpgradeConsent` (`connectionService.ts`, W01); the read DTO builder in `apps/api/src/routes/m365CustomerGraphRead.ts` (W01's `grantHealth` / `currentManifestVersion`); `M365_PERMISSION_PROFILES['customer-graph-read']` v3 grants; `runSyncDomain` + `claimDueDomains` + the fake executor from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `m365ConnectionLifecycle.integration.test.ts`:

```ts
import { M365_PERMISSION_PROFILES } from '@breeze/shared/m365';
import {
  deriveGrantHealth,
  initiateCustomerGraphReadUpgradeConsent,
} from '../../services/m365ControlPlane/connectionService';
import { createFakeSyncExecutor, syncSkusResult, type FakeSyncExecutor } from './m365SyncFakeExecutor';
import { runSyncDomain } from '../../services/m365Sync/run';
import { claimDueDomains } from '../../services/m365Sync/claim';

const V2_GRANTS = [...M365_PERMISSION_PROFILES['customer-graph-read'].applicationPermissionAssignments]
  .filter((grant) => ![
    'Policy.Read.All', 'RoleManagement.Read.Directory',
    'SecurityEvents.Read.All', 'AuditLogsQuery.Read.All',
  ].includes(grant.value ?? ''));

describe('customer Graph-read upgrade consent (manifest v2 → v3)', () => {
  let upgradeExecutor: FakeSyncExecutor;

  beforeAll(async () => { upgradeExecutor = await createFakeSyncExecutor(); });
  afterAll(async () => { await upgradeExecutor.close(); });

  async function v2Connection() {
    const owner = await ownerFixture();
    const initiated = await initiateCustomerGraphReadConsent({ orgId: owner.orgId, actorId: owner.actorId });
    const verifiedAt = new Date('2026-09-01T10:00:00.000Z');
    await withSystemDbAccessContext(() => db.update(m365Connections).set({
      tenantId: '44444444-4444-4444-8444-444444444444',
      displayName: 'Contoso',
      permissionManifestVersion: 2,
      observedGrants: V2_GRANTS,
      grantsVerifiedAt: verifiedAt,
      lastVerifiedAt: verifiedAt,
      consentedAt: verifiedAt,
      status: 'active',
      consentGeneration: 1,
    }).where(eq(m365Connections.id, initiated.connection.id)));
    return { owner, connectionId: initiated.connection.id };
  }

  runDb('derives manifest-stale on a v2 row and exposes it through the read DTO', async () => {
    const { owner, connectionId } = await v2Connection();
    const stored = await currentConnection(owner.orgId);
    expect(deriveGrantHealth(stored!, M365_PERMISSION_PROFILES['customer-graph-read']).state)
      .toBe('manifest-stale');

    const response = await m365CustomerGraphReadRoutes.request(
      `/connections?orgId=${owner.orgId}`,
      { headers: { authorization: `Bearer ${await partnerToken(owner)}` } },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connection: { id: connectionId, grantHealth: 'manifest-stale', manifestVersion: 2, currentManifestVersion: 3 },
    });
  });

  runDb('keeps syncing on v2 grants while the upgrade is pending', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const { owner, connectionId } = await v2Connection();
    const admin = getTestDb();
    await admin.execute(sql`
      INSERT INTO m365_sync_state (org_id, connection_id, domain, next_sync_at, interval_seconds)
      VALUES (${owner.orgId}::uuid, ${connectionId}::uuid, 'skus'::m365_sync_domain, now(), 86400)
      ON CONFLICT (org_id, domain) DO UPDATE SET next_sync_at = now(), lease_until = NULL`);

    await initiateCustomerGraphReadUpgradeConsent({
      connectionId, orgId: owner.orgId,
      auth: { scope: 'organization', orgId: owner.orgId, accessibleOrgIds: [owner.orgId], partnerId: null, user: { id: owner.actorId } } as never,
    });
    const pending = await currentConnection(owner.orgId);
    expect(pending, 'upgrade consent must not move the connection off active').toMatchObject({
      status: 'active', permissionManifestVersion: 2,
    });

    upgradeExecutor.enqueue('m365.sync.skus', syncSkusResult([
      { skuId: '11111111-0000-4000-8000-00000000000a', skuPartNumber: 'SPB', consumedUnits: 2, enabled: 5 },
    ]));
    const [job] = (await claimDueDomains({ limit: 20 })).filter((claimed) => claimed.orgId === owner.orgId);
    await expect(runSyncDomain(job!)).resolves.toBe('success');
    const skus = await admin.execute(sql`SELECT graph_id FROM m365_license_skus WHERE org_id = ${owner.orgId}::uuid`);
    expect(skus as unknown as unknown[]).toHaveLength(1);
  });
});
```

The DTO case needs the route and a token. Add, next to the existing imports:

```ts
import { m365CustomerGraphReadRoutes } from '../../routes/m365CustomerGraphRead';
import { createAccessToken } from '../../services/jwt';

async function partnerToken(owner: { orgId: string; actorId: string }): Promise<string> {
  return createAccessToken({
    userId: owner.actorId, scope: 'organization', orgId: owner.orgId, partnerId: null,
  } as never);
}
```

Match `createAccessToken`'s real signature to the one used in `m365CustomerGraphActionsConsent.integration.test.ts` (that suite already mints a token for a route request) rather than inventing one.

- [ ] **Step 2: Run — expect red**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365ConnectionLifecycle.integration.test.ts
```

- [ ] **Step 3: Implement** — W01 owns the DTO fields and W04/W05 own the sync path; expect no production change. The two failures worth chasing are a DTO that omits `grantHealth`/`currentManifestVersion` (fix in W01's route) and a claim or run that refuses a v2 connection (fix in W04's `claim.ts`/`run.ts` — a manifest-stale connection is executable by design).

- [ ] **Step 4: Run — expect green.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/m365ConnectionLifecycle.integration.test.ts
git commit -m "$(cat <<'MSG'
test(m365): upgrade-consent keeps a v2 connection executing throughout

Two real-DB cases for §2.2, the two that need W01's DTO and the sync path in
one process: a v2 row derives manifest-stale and the read DTO exposes
grantHealth + manifestVersion + currentManifestVersion, and a skus sync still
completes on v2 grants while the upgrade is pending. The consent-session
mechanics (attempt binding, in-place promotion with a consentGeneration bump,
abandoned upgrade leaving v2) stay in W01's own suite rather than being
re-asserted here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 7: Claim protocol — two concurrent tickers over a multi-domain batch

Spec §5.2, §9 ("two concurrent tickers with SKIP LOCKED").

**Files:**
- Modify: `apps/api/src/__tests__/integration/m365SyncClaim.integration.test.ts` (W04 creates this file in its Task 16; this task is **append-only**)

**What W04 already proves, and what this adds.** W04's suite covers a single-domain disjointness case over six tenants, the live-lease skip and the lease-expiry reclaim, `next_sync_at` surviving a claim, batch limits, and oldest-due-first ordering. Do not restate any of them. What it does not cover — and what a rolling deploy actually produces — is two tickers racing over a batch that spans **several domains per org**, where the failure mode is not an overlap but a *lost* row: `SKIP LOCKED` silently drops a row that a concurrent transaction holds, so a claimer that stops at its limit can leave due rows unclaimed by either side. This task asserts the union is complete.

**Interfaces:**
- Consumes W04's module-local helpers in that file — `seedConnection(status?)`, `seedState(tenant, overrides?)`, `readState(orgId, domain?)` — plus `claimDueDomains`. Add no second copy of them, and add no second claim suite.

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `apps/api/src/__tests__/integration/m365SyncClaim.integration.test.ts`:

```ts
describe('m365 sync claim — two concurrent tickers over a multi-domain batch', () => {
  runDb('partition the due rows completely: no overlap and nothing lost', async () => {
    // Six tenants × two domains = twelve due rows, so each claimer's limit is
    // reachable and SKIP LOCKED has something to skip.
    const tenants = await Promise.all(Array.from({ length: 6 }, () => seedConnection()));
    for (const tenant of tenants) {
      await seedState(tenant, { domain: 'users' });
      await seedState(tenant, { domain: 'skus' });
    }
    const orgIds = new Set(tenants.map((tenant) => tenant.orgId));

    const [left, right] = await Promise.all([
      claimDueDomains({ limit: 12 }),
      claimDueDomains({ limit: 12 }),
    ]);
    const mine = (claimed: typeof left) => claimed
      .filter((job) => orgIds.has(job.orgId))
      .map((job) => `${job.orgId}:${job.domain}`);
    const leftKeys = mine(left);
    const rightKeys = mine(right);

    expect(new Set(leftKeys).size, 'a single claim never returns a duplicate').toBe(leftKeys.length);
    expect(leftKeys.filter((key) => rightKeys.includes(key)), 'claims must be disjoint').toEqual([]);
    expect(
      new Set([...leftKeys, ...rightKeys]).size,
      'SKIP LOCKED must not lose a row: the union of both claims covers all twelve',
    ).toBe(12);

    // Every row was claimed exactly once: one generation bump, a live lease,
    // and a due time the claim did not advance.
    for (const tenant of tenants) {
      for (const domain of ['users', 'skus'] as const) {
        const state = await readState(tenant.orgId, domain);
        expect(state.runGeneration, `${tenant.orgId}:${domain}`).toBe(1);
        expect(state.leaseUntil, `${tenant.orgId}:${domain}`).not.toBeNull();
        expect(
          state.nextSyncAt!.getTime(),
          'the claim must not advance next_sync_at',
        ).toBeLessThanOrEqual(Date.now());
      }
    }
  });
});
```

`seedState`'s default `runGeneration` is 0, so a single claim leaves it at 1; a row claimed twice would read 2 and fail the loop above — which is the same overlap the key comparison catches, asserted a second way from the database side.

- [ ] **Step 2: Run — expect red**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365SyncClaim.integration.test.ts
```

Check the reported test count: `it.runIf(!!process.env.DATABASE_URL)` reports a green run of zero tests when the stack is down, which is a skip, not a pass.

- [ ] **Step 3: Implement** — expect no production change. A red here means the claim is not using `FOR UPDATE … SKIP LOCKED`, is advancing `next_sync_at`, or is stopping short of its limit when it skips a locked row — all W04 defects worth fixing in `claim.ts`.

- [ ] **Step 4: Run — expect green.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/m365SyncClaim.integration.test.ts
git commit -m "$(cat <<'MSG'
test(m365): concurrent ticker claims lose no row across a multi-domain batch

W04 covers single-domain disjointness; this adds the case a rolling deploy
actually produces — two tickers racing over twelve due rows spanning two
domains per org. The interesting failure is not an overlap but a lost row:
SKIP LOCKED silently drops rows held by the other transaction, so the union of
both claims, not just their intersection, is what has to be asserted. Each row
ends with exactly one generation bump, a live lease, and an unadvanced
next_sync_at.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 8: Metric-name registration contract

Spec §7. The overview's contract fixes nine API metric names and five executor ones. W04 already owns the API half: `apps/api/src/services/m365Sync/metrics.ts` and its `metrics.test.ts`, which the contract names as **the single name-contract suite**. This task adds the one assertion that suite is missing — that no `breeze_`-prefixed twin has crept in — and pins the executor's five names, which nothing asserts at all.

**Files:**
- Modify: `apps/api/src/services/m365Sync/metrics.test.ts` (W04's suite — append one case; do **not** create a second contract file)
- Create: `apps/m365-graph-read-executor/src/syncMetricNames.contract.test.ts`

**Interfaces:**
- Consumes: `registerM365SyncMetrics` (`apps/api/src/services/m365Sync/metrics.ts`, W04) — already imported by that suite.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/m365Sync/metrics.test.ts`, inside its existing top-level `describe`:

```ts
  /**
   * The nine sync series are UNPREFIXED on purpose, departing from the
   * neighbouring `breeze_m365_graph_read_actions_total`: the shared interface
   * contract and spec §7 both pin the bare names, and W04's plan (decision 9)
   * records that choice. The positive "is it registered" assertions live in
   * the cases above; this one is the guard against a later hand adding the
   * house prefix to some of them, which would leave the dashboards and alert
   * rules pointing at a series that no longer exists.
   */
  it('registers no breeze_-prefixed twin of any sync series', () => {
    const registry = new Registry();
    registerM365SyncMetrics(registry);

    for (const name of [
      'm365_sync_runs_total',
      'm365_sync_items',
      'm365_sync_executor_seconds',
      'm365_sync_due_backlog',
      'm365_sync_queue_depth',
      'm365_sync_ticker_utilisation',
      'm365_sync_ticker_skipped_total',
      'm365_sync_fenced_total',
      'm365_sync_link_ambiguous_total',
    ]) {
      expect(registry.getSingleMetric(name), `${name} is not registered`).toBeDefined();
      expect(
        registry.getSingleMetric(`breeze_${name}`),
        `${name} must stay unprefixed (contract + spec §7); found a breeze_ twin`,
      ).toBeUndefined();
    }
  });
```

Both `Registry` and `registerM365SyncMetrics` are already imported by that file; add nothing. If the nine names are already listed in a `const` in that suite, reuse it rather than retyping the array.

`apps/m365-graph-read-executor/src/syncMetricNames.contract.test.ts`:

```ts
/**
 * The executor has no prom-client dependency; it hand-rolls Prometheus text on
 * GET /metrics (contract, executor section). So there is no registry to
 * interrogate — what can still be pinned mechanically is the SPELLING: the
 * contract's five names must appear verbatim in the source, so a rename cannot
 * silently orphan a dashboard.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [readFileSync(full, 'utf8')] : [];
  });
}

describe('m365 sync executor metric names', () => {
  it('emits every metric name from the shared interface contract', () => {
    const corpus = sources(srcDir).join('\n');
    for (const name of [
      'm365_sync_actions_total',
      'm365_sync_in_flight',
      'm365_in_flight_total',
      'm365_sync_capacity_rejected_total',
      'm365_signin_limiter_tokens',
    ]) {
      expect(corpus.includes(name), `${name} appears nowhere in the executor source`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run — expect red**

```bash
cd apps/api && npx vitest run src/services/m365Sync/metrics.test.ts
cd apps/m365-graph-read-executor && npx vitest run src/syncMetricNames.contract.test.ts
```

- [ ] **Step 3: Implement** — register any missing series in W04's `metrics.ts`, or emit any missing name in W03's executor. Do not delete a name from either list to make it pass; if a name is genuinely wrong, change it in the overview's contract block too and say so in the PR body.

- [ ] **Step 4: Run — expect green.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/metrics.test.ts \
        apps/m365-graph-read-executor/src/syncMetricNames.contract.test.ts
git commit -m "$(cat <<'MSG'
test(m365): guard the unprefixed sync metric names on both sides

W04's metrics.test.ts is the single name-contract suite, so the missing
assertion goes there rather than into a second file: no breeze_-prefixed twin
of any of the nine sync series may be registered, because half-prefixed names
would leave every dashboard and alert rule pointing at a series that no longer
exists. The executor has no prom-client registry to interrogate, so its five
names are pinned by scanning its own source for the exact spellings.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 9: Capacity benchmark harness (NOT CI) + its runbook

Spec §5.11 ("The plan includes a benchmark against a real Postgres sized like production … Pass criteria are written before the run"), §5.9 (capacity rule).

**Files:**
- Create: `apps/api/scripts/m365-sync-benchmark.lib.ts`
- Create: `apps/api/scripts/m365-sync-benchmark.lib.test.ts`
- Create: `apps/api/scripts/m365-sync-benchmark.ts`
- Modify: `apps/api/package.json` (one script entry)
- Create: `docs/runbooks/m365-sync-benchmark.md`

`apps/api/scripts/` is where this repo's `tsx` operational scripts live (`metric-rollup-backfill.ts`, `recover-stuck-agents.ts`), each with a `.lib.ts` holding the pure, unit-tested part and a thin `.ts` entrypoint. This follows that split so the size distribution and the percentile maths are tested without a database, and the script itself stays a driver.

**Interfaces:**
- Consumes: `createFakeSyncExecutor` and the fixture builders (Task 1); `claimDueDomains`, `runSyncDomain` (W04); `closeDb`, `db`, `withSystemDbAccessContext` (`apps/api/src/db`); `M365_SYNC_DOMAINS` (`@breeze/shared/m365`).

- [ ] **Step 1: Write the failing unit tests**

`apps/api/scripts/m365-sync-benchmark.lib.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_PASS_CRITERIA,
  makeSizeDistribution,
  parseBenchmarkArgs,
  percentile,
} from './m365-sync-benchmark.lib';

describe('parseBenchmarkArgs', () => {
  it('defaults to the spec §5.11 shape', () => {
    expect(parseBenchmarkArgs([])).toEqual({
      orgs: 1_000,
      windowMinutes: 60,
      executorLatencyMs: 200,
      concurrency: 4,
      tickBatch: 200,
      probeIntervalMs: 1_000,
      seed: 20260908,
      keepData: false,
    });
  });

  it('accepts overrides and rejects nonsense', () => {
    expect(parseBenchmarkArgs(['--orgs=50', '--window-minutes=5', '--keep-data']))
      .toMatchObject({ orgs: 50, windowMinutes: 5, keepData: true });
    expect(() => parseBenchmarkArgs(['--orgs=0'])).toThrow(/--orgs/);
    expect(() => parseBenchmarkArgs(['--orgs=abc'])).toThrow(/--orgs/);
    expect(() => parseBenchmarkArgs(['--nope'])).toThrow(/unknown/i);
  });
});

describe('makeSizeDistribution', () => {
  const sizes = makeSizeDistribution(1_000, 20260908);

  it('produces one entry per org', () => {
    expect(sizes).toHaveLength(1_000);
  });

  it('hits the spec median (60 users / 40 devices) within 10 %', () => {
    expect(percentile(sizes.map((size) => size.users), 50)).toBeGreaterThanOrEqual(54);
    expect(percentile(sizes.map((size) => size.users), 50)).toBeLessThanOrEqual(66);
    expect(percentile(sizes.map((size) => size.devices), 50)).toBeGreaterThanOrEqual(36);
    expect(percentile(sizes.map((size) => size.devices), 50)).toBeLessThanOrEqual(44);
  });

  it('hits the spec p95 (2000 users / 1500 devices) within 15 %', () => {
    expect(percentile(sizes.map((size) => size.users), 95)).toBeGreaterThanOrEqual(1_700);
    expect(percentile(sizes.map((size) => size.users), 95)).toBeLessThanOrEqual(2_300);
    expect(percentile(sizes.map((size) => size.devices), 95)).toBeGreaterThanOrEqual(1_275);
    expect(percentile(sizes.map((size) => size.devices), 95)).toBeLessThanOrEqual(1_725);
  });

  it('always includes exactly two 25k tenants', () => {
    expect(sizes.filter((size) => size.users === 25_000)).toHaveLength(2);
    expect(sizes.filter((size) => size.devices === 25_000)).toHaveLength(2);
  });

  it('is deterministic for a given seed', () => {
    expect(makeSizeDistribution(50, 7)).toEqual(makeSizeDistribution(50, 7));
    expect(makeSizeDistribution(50, 7)).not.toEqual(makeSizeDistribution(50, 8));
  });
});

describe('percentile', () => {
  it('interpolates nothing — it takes the nearest-rank sample', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('BENCHMARK_PASS_CRITERIA', () => {
  it('is written down before the run, not derived from it', () => {
    expect(BENCHMARK_PASS_CRITERIA).toMatchObject({
      tickerUtilisationMax: 0.5,
      tickDrainSecondsMax: 60,
      queueDepthMax: 500,
      poolOccupancyFractionMax: 0.5,
      probeP95MillisecondsMax: 50,
      steadyStateEntityWritesMax: 0,
    });
  });
});
```

- [ ] **Step 2: Run — expect red**

```bash
cd apps/api && npx vitest run scripts/m365-sync-benchmark.lib.test.ts
```

- [ ] **Step 3: Implement the lib**

`apps/api/scripts/m365-sync-benchmark.lib.ts`:

```ts
/**
 * Pure helpers for the M365 tenant-sync capacity benchmark (spec §5.11).
 * Kept separate from the driver so the size distribution and the percentile
 * maths are unit-tested without a database.
 */

export interface BenchmarkOptions {
  orgs: number;
  windowMinutes: number;
  executorLatencyMs: number;
  concurrency: number;
  tickBatch: number;
  probeIntervalMs: number;
  seed: number;
  keepData: boolean;
}

export interface OrgSize { users: number; devices: number }

/**
 * Pass criteria, fixed BEFORE the run (spec §5.11: "Pass criteria are written
 * before the run"). Reading them off the first result would make the
 * benchmark a description instead of a test.
 *
 *  - tickerUtilisationMax 0.5     — §5.9's capacity rule: claimed runs must sit
 *                                   at or under 50 % of BATCH × 1440 slots/day.
 *  - tickDrainSecondsMax 60       — a tick's claims must finish before the next
 *                                   tick fires, or the backlog compounds.
 *  - queueDepthMax 500            — M365_SYNC_MAX_BACKLOG's default; above it the
 *                                   ticker sheds load and freshness slips.
 *  - poolOccupancyFractionMax 0.5 — the fetch phase holds no connection, so sync
 *                                   must never occupy more than half the pool.
 *  - probeP95MillisecondsMax 50   — an unrelated foreground query must stay fast
 *                                   while sync runs; this is the user-visible bar.
 *  - steadyStateEntityWritesMax 0 — a second pass over an unchanged tenant writes
 *                                   zero rows for users/ca_policies/skus/secure_score
 *                                   (§5.9 is explicit that intune_devices and
 *                                   signin_activity are excluded from this claim).
 */
export const BENCHMARK_PASS_CRITERIA = {
  tickerUtilisationMax: 0.5,
  tickDrainSecondsMax: 60,
  queueDepthMax: 500,
  poolOccupancyFractionMax: 0.5,
  probeP95MillisecondsMax: 50,
  steadyStateEntityWritesMax: 0,
} as const;

const DEFAULTS: BenchmarkOptions = {
  orgs: 1_000,
  windowMinutes: 60,
  executorLatencyMs: 200,
  concurrency: 4,
  tickBatch: 200,
  probeIntervalMs: 1_000,
  seed: 20260908,
  keepData: false,
};

const NUMERIC_FLAGS: Record<string, keyof BenchmarkOptions> = {
  '--orgs': 'orgs',
  '--window-minutes': 'windowMinutes',
  '--executor-latency-ms': 'executorLatencyMs',
  '--concurrency': 'concurrency',
  '--tick-batch': 'tickBatch',
  '--probe-interval-ms': 'probeIntervalMs',
  '--seed': 'seed',
};

export function parseBenchmarkArgs(argv: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = { ...DEFAULTS };
  for (const argument of argv) {
    if (argument === '--keep-data') { options.keepData = true; continue; }
    const [flag, rawValue] = argument.split('=', 2);
    const key = NUMERIC_FLAGS[flag ?? ''];
    if (!key) throw new Error(`unknown argument: ${argument}`);
    const value = Number(rawValue);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${flag} needs a positive integer, got: ${rawValue ?? '(missing)'}`);
    }
    (options[key] as number) = value;
  }
  return options;
}

/** Deterministic 32-bit PRNG (mulberry32) so a run is reproducible by seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile; no interpolation, so a reported p95 is a real sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

/**
 * Log-normal sizes fitted to the spec's median/p95 pair, with two 25k tenants
 * forced in: median 60 users / 40 devices, p95 2 000 / 1 500. sigma comes from
 * ln(p95/median) / z(0.95) with z = 1.645.
 */
export function makeSizeDistribution(orgs: number, seed: number): OrgSize[] {
  const next = rng(seed);
  const userSigma = Math.log(2_000 / 60) / 1.645;
  const deviceSigma = Math.log(1_500 / 40) / 1.645;
  const sizes: OrgSize[] = [];
  for (let index = 0; index < orgs; index += 1) {
    // Box-Muller from two uniforms, shared across both axes so a big tenant is
    // big in users AND devices (they correlate in reality).
    const u1 = Math.max(next(), Number.EPSILON);
    const u2 = next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    sizes.push({
      users: Math.max(1, Math.min(25_000, Math.round(60 * Math.exp(userSigma * z)))),
      devices: Math.max(1, Math.min(25_000, Math.round(40 * Math.exp(deviceSigma * z)))),
    });
  }
  for (const index of [0, Math.min(1, orgs - 1)]) {
    if (index >= 0 && index < orgs) sizes[index] = { users: 25_000, devices: 25_000 };
  }
  // Keep exactly two at the cap: clamp any other org that landed there.
  for (let index = 2; index < sizes.length; index += 1) {
    if (sizes[index]!.users === 25_000) sizes[index]!.users = 24_999;
    if (sizes[index]!.devices === 25_000) sizes[index]!.devices = 24_999;
  }
  return sizes;
}

export interface BenchmarkReport {
  options: BenchmarkOptions;
  ticks: number;
  runsCompleted: number;
  /** Sign-in continuation pages: work done, but NOT completed domain runs. */
  pagesCompleted: number;
  tickDrainSecondsP95: number;
  tickerUtilisation: number;
  maxQueueDepth: number;
  walBytes: number;
  poolOccupancyPeak: number;
  poolMax: number;
  probeP95Milliseconds: number;
  entityWritesSecondPass: number;
}

export function formatReport(report: BenchmarkReport): string {
  const pass = (label: string, actual: number, limit: number, unit = '') =>
    `${actual <= limit ? 'PASS' : 'FAIL'}  ${label.padEnd(32)} ${actual}${unit} (limit ${limit}${unit})`;
  return [
    '=== M365 tenant sync benchmark ===',
    `orgs=${report.options.orgs} window=${report.options.windowMinutes}m ` +
      `latency=${report.options.executorLatencyMs}ms concurrency=${report.options.concurrency} ` +
      `tickBatch=${report.options.tickBatch} seed=${report.options.seed}`,
    `ticks=${report.ticks} runsCompleted=${report.runsCompleted} ` +
      `pagesCompleted=${report.pagesCompleted} walBytes=${report.walBytes}`,
    '',
    pass('tick drain p95 (s)', report.tickDrainSecondsP95, BENCHMARK_PASS_CRITERIA.tickDrainSecondsMax),
    pass('ticker utilisation', Number(report.tickerUtilisation.toFixed(3)), BENCHMARK_PASS_CRITERIA.tickerUtilisationMax),
    pass('max queue depth', report.maxQueueDepth, BENCHMARK_PASS_CRITERIA.queueDepthMax),
    pass('pool occupancy fraction',
      Number((report.poolOccupancyPeak / Math.max(report.poolMax, 1)).toFixed(3)),
      BENCHMARK_PASS_CRITERIA.poolOccupancyFractionMax),
    pass('foreground probe p95 (ms)', report.probeP95Milliseconds, BENCHMARK_PASS_CRITERIA.probeP95MillisecondsMax),
    pass('steady-state entity writes', report.entityWritesSecondPass, BENCHMARK_PASS_CRITERIA.steadyStateEntityWritesMax),
  ].join('\n');
}
```

- [ ] **Step 4: Run the unit tests — expect green**

```bash
cd apps/api && npx vitest run scripts/m365-sync-benchmark.lib.test.ts
```

- [ ] **Step 5: Implement the driver**

`apps/api/scripts/m365-sync-benchmark.ts`:

```ts
#!/usr/bin/env tsx
/**
 * M365 tenant-sync capacity benchmark (spec §5.11). NOT part of CI.
 *
 * Seeds N orgs with a realistic size distribution (median 60 users / 40
 * devices, p95 2 000 / 1 500, two at 25k), points the API at an in-process
 * fake executor with 200 ms latency, then runs the ticker + worker loop for
 * one cadence window and reports:
 *
 *   - tick drain time (p95 over ticks)
 *   - ticker utilisation (claimed runs / (tickBatch × ticks))
 *   - max queue depth (claimed-but-not-yet-run)
 *   - WAL bytes written (pg_current_wal_lsn delta)
 *   - pool occupancy peak (pg_stat_activity for the app role) against pool max
 *   - p95 latency of an unrelated foreground probe query sampled every second
 *   - entity writes on a second, unchanged pass
 *
 * PASS CRITERIA, fixed before the first run (BENCHMARK_PASS_CRITERIA in
 * ./m365-sync-benchmark.lib.ts):
 *   ticker utilisation      <= 0.50 of tickBatch × ticks   (§5.9 capacity rule)
 *   tick drain p95          <= 60 s                        (a tick finishes before the next)
 *   max queue depth         <= 500                         (M365_SYNC_MAX_BACKLOG default)
 *   pool occupancy peak     <= 50 % of the pool            (fetch holds no connection)
 *   foreground probe p95    <= 50 ms                       (unrelated endpoints stay fast)
 *   steady-state writes     == 0 rows for users/ca_policies/skus/secure_score
 *
 * Run it against a production-class Postgres (1 vCPU managed class), never a
 * laptop container, or the numbers mean nothing:
 *   docs/runbooks/m365-sync-benchmark.md
 *
 * Usage:
 *   DATABASE_URL_APP=... M365_TENANT_SYNC_ENABLED=true \
 *     pnpm --filter @breeze/api m365-sync:benchmark -- --orgs=1000 --window-minutes=60
 */
import { sql } from 'drizzle-orm';
import { M365_SYNC_DOMAINS } from '@breeze/shared/m365';
import { closeDb, db, withSystemDbAccessContext } from '../src/db';
import { claimDueDomains } from '../src/services/m365Sync/claim';
import { runSyncDomain } from '../src/services/m365Sync/run';
import {
  createFakeSyncExecutor,
  syncCaPoliciesResult, syncIntuneDevicesResult, syncSecureScoreResult,
  syncSkusResult, syncUsersResult,
} from '../src/__tests__/integration/m365SyncFakeExecutor';
import {
  formatReport, makeSizeDistribution, parseBenchmarkArgs, percentile,
  type BenchmarkReport,
} from './m365-sync-benchmark.lib';

const BENCH_TAG = 'm365-sync-benchmark';

async function walLsnBytes(): Promise<bigint> {
  const [row] = (await withSystemDbAccessContext(() =>
    db.execute(sql`SELECT pg_current_wal_lsn() - '0/0'::pg_lsn AS bytes`))) as unknown as { bytes: string }[];
  return BigInt(row!.bytes);
}

async function poolOccupancy(): Promise<{ active: number; max: number }> {
  const [row] = (await withSystemDbAccessContext(() => db.execute(sql`
    SELECT count(*) FILTER (WHERE state <> 'idle') AS active,
           current_setting('max_connections')::int AS max
    FROM pg_stat_activity WHERE usename = current_user`))) as unknown as { active: string; max: number }[];
  return { active: Number(row!.active), max: row!.max };
}

async function main(): Promise<void> {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  if (process.env.M365_TENANT_SYNC_ENABLED !== 'true') {
    throw new Error('set M365_TENANT_SYNC_ENABLED=true — every sync entry point is flag-gated');
  }
  const sizes = makeSizeDistribution(options.orgs, options.seed);
  const executor = await createFakeSyncExecutor({ latencyMs: options.executorLatencyMs });

  // --- seed ---------------------------------------------------------------
  console.log(`[${BENCH_TAG}] seeding ${options.orgs} orgs …`);
  const orgIds = await withSystemDbAccessContext(async () => {
    const [partner] = (await db.execute(sql`
      INSERT INTO partners (name, slug, status)
      VALUES (${`${BENCH_TAG} partner`}, ${`${BENCH_TAG}-${Date.now()}`}, 'active')
      RETURNING id`)) as unknown as { id: string }[];
    const created: string[] = [];
    for (let index = 0; index < options.orgs; index += 1) {
      const [org] = (await db.execute(sql`
        INSERT INTO organizations (partner_id, name, status)
        VALUES (${partner!.id}::uuid, ${`${BENCH_TAG}-org-${index}`}, 'active')
        RETURNING id`)) as unknown as { id: string }[];
      const [connection] = (await db.execute(sql`
        INSERT INTO m365_connections (
          org_id, tenant_id, client_id, profile, auth_mode, credential_domain,
          vault_ref, credential_version, permission_manifest_version,
          observed_grants, consent_attempt_id, status, display_name)
        VALUES (${org!.id}::uuid, gen_random_uuid(), '55555555-5555-4555-8555-555555555555',
                'customer-graph-read', 'application-certificate', 'customer-graph-read',
                'akv://vault.example/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
                '0123456789abcdef0123456789abcdef', 3, '[]'::jsonb, gen_random_uuid(),
                'active', ${`${BENCH_TAG}-tenant-${index}`})
        RETURNING id`)) as unknown as { id: string }[];
      for (const domain of M365_SYNC_DOMAINS) {
        await db.execute(sql`
          INSERT INTO m365_sync_state (org_id, connection_id, domain, next_sync_at, interval_seconds)
          VALUES (${org!.id}::uuid, ${connection!.id}::uuid, ${domain}::m365_sync_domain,
                  now() + (random() * interval '1 hour'), 21600)
          ON CONFLICT (org_id, domain) DO NOTHING`);
      }
      created.push(org!.id);
    }
    return created;
  });

  // --- fixtures per org size ----------------------------------------------
  const fixtureFor = (index: number, domain: string) => {
    const size = sizes[index]!;
    switch (domain) {
      case 'm365.sync.users':
        return syncUsersResult(Array.from({ length: size.users }, (_unused, userIndex) => ({
          id: `aaaaaaaa-0000-4000-8000-${String(userIndex).padStart(12, '0')}`,
          userPrincipalName: `user${userIndex}@bench${index}.example`,
        })));
      case 'm365.sync.intune_devices':
        return syncIntuneDevicesResult(Array.from({ length: size.devices }, (_unused, deviceIndex) => ({
          id: `bbbbbbbb-0000-4000-8000-${String(deviceIndex).padStart(12, '0')}`,
          deviceName: `BENCH-${index}-${deviceIndex}`,
          serialNumber: `SN-${index}-${deviceIndex}`,
        })));
      case 'm365.sync.signin_activity':
        return { success: true as const, kind: 'sync' as const, items: [], truncated: false,
                 fetchedAt: new Date().toISOString(), sources: { signInActivity: 'ok' as const } };
      case 'm365.sync.ca_policies':
        return syncCaPoliciesResult([{ id: 'cccccccc-0000-4000-8000-000000000001', displayName: 'MFA', state: 'enabled' }]);
      case 'm365.sync.skus':
        return syncSkusResult([{ skuId: '11111111-0000-4000-8000-00000000000a', skuPartNumber: 'SPB', consumedUnits: size.users, enabled: size.users + 10 }]);
      default:
        return syncSecureScoreResult(new Date().toISOString().slice(0, 10), 3);
    }
  };
  const orgIndex = new Map(orgIds.map((id, index) => [id, index]));

  // --- probe sampler ------------------------------------------------------
  const probeLatencies: number[] = [];
  let poolPeak = 0;
  let poolMax = 1;
  const sampler = setInterval(() => {
    void (async () => {
      const started = process.hrtime.bigint();
      await withSystemDbAccessContext(() => db.execute(sql`
        SELECT count(*) FROM devices WHERE org_id = ${orgIds[0]!}::uuid`));
      probeLatencies.push(Number(process.hrtime.bigint() - started) / 1_000_000);
      const occupancy = await poolOccupancy();
      poolPeak = Math.max(poolPeak, occupancy.active);
      poolMax = occupancy.max;
    })();
  }, options.probeIntervalMs);

  // --- ticker + worker loop ----------------------------------------------
  const walBefore = await walLsnBytes();
  const deadline = Date.now() + options.windowMinutes * 60_000;
  const tickDrainSeconds: number[] = [];
  let ticks = 0;
  let runsCompleted = 0;
  let pagesCompleted = 0;
  let maxQueueDepth = 0;

  while (Date.now() < deadline) {
    const tickStarted = Date.now();
    const claimed = await claimDueDomains({ limit: options.tickBatch });
    maxQueueDepth = Math.max(maxQueueDepth, claimed.length);
    const queue = [...claimed];
    await Promise.all(Array.from({ length: options.concurrency }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const index = orgIndex.get(job.orgId);
        if (index === undefined) continue;
        executor.enqueue(`m365.sync.${job.domain}`, fixtureFor(index, `m365.sync.${job.domain}`) as never);
        const outcome = await runSyncDomain(job);
        // 'noop' means the domain has no registered persister. After W05 all
        // six are registered, so a noop here is a wiring regression — and it
        // would flatter every number in the report, because a domain that does
        // no work drains instantly and invents utilisation headroom.
        if (outcome === 'noop') {
          throw new Error(
            `domain ${job.domain} returned 'noop' — no persister registered, so this run measures nothing`,
          );
        }
        // A sign-in run that still holds a continuation completed a PAGE, not a
        // run: the same row comes back due immediately, so counting it as a run
        // would understate ticker utilisation.
        if (outcome === 'partial-continue') {
          if (job.domain !== 'signin_activity') {
            throw new Error(`domain ${job.domain} returned 'partial-continue'; only signin_activity paginates`);
          }
          pagesCompleted += 1;
          continue;
        }
        runsCompleted += 1;
      }
    }));
    ticks += 1;
    tickDrainSeconds.push((Date.now() - tickStarted) / 1_000);
    const remaining = 60_000 - (Date.now() - tickStarted);
    if (remaining > 0 && Date.now() + remaining < deadline) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  // --- steady-state second pass ------------------------------------------
  await withSystemDbAccessContext(() => db.execute(sql`
    UPDATE m365_sync_state SET next_sync_at = now(), lease_until = NULL
    WHERE domain IN ('users','ca_policies','skus','secure_score')`));
  const [writesBefore] = (await withSystemDbAccessContext(() => db.execute(sql`
    SELECT (SELECT count(*) FROM m365_users WHERE last_changed_at > now() - interval '1 second') AS n`))) as unknown as { n: string }[];
  const secondPass = await claimDueDomains({ limit: options.tickBatch });
  for (const job of secondPass) {
    const index = orgIndex.get(job.orgId);
    if (index === undefined) continue;
    executor.enqueue(`m365.sync.${job.domain}`, fixtureFor(index, `m365.sync.${job.domain}`) as never);
    await runSyncDomain(job);
  }
  const [writesAfter] = (await withSystemDbAccessContext(() => db.execute(sql`
    SELECT count(*) AS n FROM m365_users WHERE last_changed_at > now() - interval '5 minutes'`))) as unknown as { n: string }[];

  clearInterval(sampler);
  const walAfter = await walLsnBytes();

  const report: BenchmarkReport = {
    options,
    ticks,
    runsCompleted,
    pagesCompleted,
    tickDrainSecondsP95: Number(percentile(tickDrainSeconds, 95).toFixed(2)),
    tickerUtilisation: runsCompleted / Math.max(options.tickBatch * ticks, 1),
    maxQueueDepth,
    walBytes: Number(walAfter - walBefore),
    poolOccupancyPeak: poolPeak,
    poolMax,
    probeP95Milliseconds: Number(percentile(probeLatencies, 95).toFixed(2)),
    entityWritesSecondPass: Number(writesAfter!.n) - Number(writesBefore!.n),
  };
  console.log(formatReport(report));
  console.log(JSON.stringify(report, null, 2));

  await executor.close();
  if (!options.keepData) {
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM organizations WHERE name LIKE ${`${BENCH_TAG}-org-%`}`));
  }
}

main()
  .catch((error) => {
    console.error(`[${BENCH_TAG}] failed:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => { await closeDb(); });
```

Add the script entry to `apps/api/package.json`, alphabetically among the existing operational scripts:

```json
"m365-sync:benchmark": "tsx scripts/m365-sync-benchmark.ts",
```

- [ ] **Step 6: Smoke the driver at a tiny size against the test stack**

```bash
pnpm test-stack up
cd apps/api && DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5433/breeze_test \
  DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test \
  M365_TENANT_SYNC_ENABLED=true \
  npx tsx scripts/m365-sync-benchmark.ts --orgs=5 --window-minutes=1 --tick-batch=10
```

Expect a printed report with six PASS/FAIL lines. A tiny run is a smoke test of the driver, **not** a capacity result — record nothing from it.

- [ ] **Step 7: Write the benchmark runbook**

`docs/runbooks/m365-sync-benchmark.md`:

````markdown
# M365 tenant sync — capacity benchmark

Spec: `docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md` §5.11.

This benchmark is **not** part of CI. Run it before enabling
`M365_TENANT_SYNC_ENABLED` on a region for the first time, and again whenever
the fleet's org count roughly doubles or the sync cadence defaults change.

## What it measures

| Metric | Source | Pass criterion |
|---|---|---|
| Tick drain p95 | wall clock per ticker iteration | ≤ 60 s (a tick finishes before the next fires) |
| Ticker utilisation | completed runs ÷ (`--tick-batch` × ticks) | ≤ 0.50 (spec §5.9 capacity rule) |
| Max queue depth | rows claimed but not yet run | ≤ 500 (`M365_SYNC_MAX_BACKLOG` default) |
| WAL bytes | `pg_current_wal_lsn()` delta over the window | reported, no fixed limit — compare across runs |
| Pool occupancy peak | `pg_stat_activity` non-idle for the app role | ≤ 50 % of `max_connections` |
| Foreground probe p95 | an unrelated indexed query sampled every second | ≤ 50 ms |
| Steady-state entity writes | second pass over an unchanged tenant | 0 rows for users / CA / SKUs / Secure Score |

The pass criteria are fixed in `apps/api/scripts/m365-sync-benchmark.lib.ts`
(`BENCHMARK_PASS_CRITERIA`) and were written before the first run. Do not edit
them to make a run pass; a failure is a capacity finding.

Ticker utilisation counts **completed runs**. A `signin_activity` call that
comes back with a continuation is reported separately as `pagesCompleted`: it
did real work, but its row is due again immediately, so counting it as a run
would understate utilisation. The driver also aborts if any domain returns
`'noop'` — that means no persister is registered for it, and a domain doing no
work drains instantly and invents headroom that does not exist.

`intune_devices` and `signin_activity` are excluded from the steady-state
zero-write criterion by design (spec §5.9): device rows carry
`last_intune_sync_at` in the hash and churn every run, and sign-in activity
writes only changed timestamps.

## Environment

Run against a **production-class managed Postgres** — the hosted regions use a
1 vCPU managed class. A laptop container has a different fsync profile and
different `max_connections`; numbers from one are not comparable to the other.

1. Provision a throwaway database on the same managed class and region as
   production. Never point this at a production database: it inserts ~`--orgs`
   organizations and deletes them again on exit.
2. Apply migrations: `DATABASE_URL=<throwaway> pnpm db:migrate`.
3. Export the app role URL the API itself uses:

```bash
export DATABASE_URL=postgresql://<superuser>@<host>:25060/breeze?sslmode=require
export DATABASE_URL_APP=postgresql://breeze_app@<host>:25060/breeze?sslmode=require
export M365_TENANT_SYNC_ENABLED=true
```

`DATABASE_URL_APP` is the pool the sync worker uses; `DATABASE_URL` is only
used for the WAL and `pg_stat_activity` reads.

## Run

```bash
pnpm --filter @breeze/api m365-sync:benchmark -- \
  --orgs=1000 --window-minutes=60 --executor-latency-ms=200 \
  --concurrency=4 --tick-batch=200
```

Flags: `--orgs`, `--window-minutes`, `--executor-latency-ms`,
`--concurrency`, `--tick-batch`, `--probe-interval-ms`, `--seed`,
`--keep-data` (skips the cleanup delete so you can inspect the rows).

A full 1 000-org / 60-minute run takes just over an hour of wall clock. Run it
in `tmux`; it prints the report to stdout and a JSON blob after it.

## Recording a result

Paste the JSON report into the release's readiness note together with:

- Postgres version, instance class, and `max_connections`
- the region it ran in
- the git SHA of `apps/api`
- any criterion that failed and the dial you turned (`--tick-batch` is the
  ticker dial; `M365_SYNC_CONCURRENCY` is the worker dial;
  `M365_SYNC_MAX_IN_FLIGHT` is the executor dial)

If ticker utilisation exceeds 0.50, raise `M365_SYNC_TICK_BATCH` and re-run —
that is the documented remedy in spec §5.9, not a reason to lengthen cadences.
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/scripts/m365-sync-benchmark.lib.ts \
        apps/api/scripts/m365-sync-benchmark.lib.test.ts \
        apps/api/scripts/m365-sync-benchmark.ts \
        apps/api/package.json \
        docs/runbooks/m365-sync-benchmark.md
git commit -m "$(cat <<'MSG'
feat(m365): capacity benchmark harness for tenant sync (not CI)

Seeds N orgs on the spec's size distribution (median 60/40, p95 2000/1500, two
at 25k), drives the ticker + worker loop against an in-process fake executor
with 200 ms latency for one cadence window, and reports tick drain p95, ticker
utilisation, max queue depth, WAL delta, pool occupancy peak, foreground probe
p95, and steady-state entity writes. Pass criteria are fixed in the lib and
were written before the first run. Runbook covers running it against a
production-class managed Postgres.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 10: Deploy doc — sync route, capacity, sign-in RPM split, memory

Spec §4.2, §5.11, §10.5. **This task adds only the operational sections.** W01 adds the four manifest-v3 app-role rows to this file (its own task), and W03 adds the executor env-var *table rows*. Cross-check both exist; if a row is missing, add it here and say so in the PR body — but never restate the app-role table or the manifest-v3 re-consent story, which live in W01's rows and in `docs/release-notes/m365-customer-graph-read-manifest-v3.md`.

**Files:**
- Modify: `docs/deploy/m365-customer-graph-read-executor.md`

- [ ] **Step 1: Cross-check what W01 and W03 already added**

```bash
grep -n "M365_SYNC_MAX_IN_FLIGHT\|M365_MAX_IN_FLIGHT\|M365_SIGNIN_ACTIVITY_RPM\|M365_SIGNIN_PAGES_PER_CALL\|M365_SYNC_MAX_ITEMS" docs/deploy/m365-customer-graph-read-executor.md
grep -n "M365_TENANT_SYNC_ENABLED\|M365_SYNC_CONCURRENCY\|M365_SYNC_MAX_BACKLOG\|M365_SYNC_TICK_BATCH" docs/deploy/m365-customer-graph-read-executor.md
# W01 owns these four rows; they must already be here.
grep -c "AuditLogsQuery.Read.All\|Policy.Read.All\|RoleManagement.Read.Directory\|SecurityEvents.Read.All" docs/deploy/m365-customer-graph-read-executor.md
````

If the Step 1 grep shows the four app-role rows are missing, W01 has not landed — stop rather than adding them here; duplicated rows with hand-typed GUIDs are exactly the drift this split avoids.

- [ ] **Step 2: Add the sync operational sections**

After `## Runtime configuration`, add:

```markdown
## Tenant sync

The executor serves whole-domain snapshot pulls on `POST /v1/sync-action`, a
fourth operation alongside `complete-consent`, `retest`, and `read-action`.
It uses the same EdDSA internal-auth scheme, with the operation bound into the
token, and it is only ever called by the Breeze API.

- `/v1/read-action` rejects `m365.sync.*` action ids with
  `400 { "code": "action_not_allowed" }`, and `/v1/sync-action` rejects every
  non-sync id the same way. The split exists so a bulk pull can never sit in
  front of, or starve, an interactive AI-tool call: the two routes have
  independent caps, timeouts and metrics.
- The sync Graph-client profile is 60 pages, 64 MiB cumulative, and a 110 s
  per-call deadline enforced by an `AbortController`. The interactive profile
  (20 pages / 1 000 items / 512 KiB) is unchanged.
- The API side of the call has a 130 s timeout and a 32 MiB response cap.

### Capacity

| Dial | Where | Default | Raise it when |
|---|---|---|---|
| `M365_SYNC_MAX_IN_FLIGHT` | executor | 4 | sustained `503 sync_capacity` with CPU and memory headroom to spare |
| `M365_MAX_IN_FLIGHT` | executor | 32 | total in-flight saturation; sync may never consume more than the sync cap out of this total, so interactive calls always keep headroom |
| `M365_SYNC_TICK_BATCH` (API) | API | 200 | `m365_sync_ticker_utilisation` above 0.5 — this is the ticker dial, not the cadences |
| `M365_SYNC_CONCURRENCY` (API) | API | 4 | queue depth grows while DB latency is flat |

Beyond the sync in-flight cap the route returns
`503 { "code": "sync_capacity", "retryAfterSeconds": 30 }` with a `Retry-After`
header and does **not** queue internally; the API retries with BullMQ backoff
(30 s, 2 min, 8 min) and then lengthens that domain's interval by 1.5×.

There is no separate sync-executor origin in v1. Sync and interactive calls
share `M365_GRAPH_READ_EXECUTOR_URL`, and the isolation between them is the
two routes' independent caps, timeouts and metrics — not deployment topology.
Making that a hard guarantee instead would mean a new variable and a second
executor deployment, which is a decision for a later wave, not a dial that
already exists.

### Sign-in activity is app-wide limited — split the RPM across regions

Microsoft throttles `signInActivity` at **10 requests per minute per
application across all tenants**, not per tenant. `M365_SIGNIN_ACTIVITY_RPM`
(default 4) is a per-instance token bucket, so:

- **One shared app registration across both hosted regions:** set 4 in each
  region (4 + 4 = 8, leaving headroom under 10).
- **A separate registration per region:** each region may run up to 8.
- **More than one executor replica per region:** divide the value by the
  replica count. The bucket is per instance and is not coordinated.

At 4 RPM and 5 pages per call (`M365_SIGNIN_PAGES_PER_CALL`), one region
fetches roughly 5 700 single-page tenants per day. Larger fleets get a
proportionally longer sign-in cadence through the adaptive rule, and the UI
shows the "as of" date rather than pretending the data is current. Every other
domain is bounded per tenant, not per app.

When the bucket empties mid-call the executor returns the pages it completed
plus an opaque `continuation`; it never blocks. Continuations are encrypted
and tenant-bound by the executor and expire after one hour.

### Memory

A sync worker holds one whole-domain snapshot in memory at a time. Size the
executor for `M365_SYNC_MAX_IN_FLIGHT` concurrent maximum-size snapshots:

| Concurrent max-size snapshots | Measured RSS ceiling | Recommended container limit |
|---|---|---|
| 4 × 25 000 users | the value measured by scenario **S7** below — write it into this cell | ≥ 1.5× the measured ceiling |

The number is measured before the first canary, not after it: scenario S7 in
`docs/runbooks/m365-customer-graph-read-real-tenant.md` drives four concurrent
25 000-user snapshots through the executor in fake-executor mode and records
peak RSS. Fill this cell from that run and do not carry a guess into a
container limit. The 64 MiB cumulative response cap and the 25 000-item cap
bound a single snapshot, so the ceiling is a product of those two and the
in-flight cap, not of tenant count.
```

- [ ] **Step 3: Verify and commit**

W03 adds the executor's metric names to `## Operational signals` in this same
file. Do not add a second list; confirm it landed and move on.

```bash
grep -n "m365_sync_actions_total" docs/deploy/m365-customer-graph-read-executor.md
! grep -n "M365_GRAPH_SYNC_EXECUTOR_URL" docs/deploy/m365-customer-graph-read-executor.md  # struck from v1
git add docs/deploy/m365-customer-graph-read-executor.md
git commit -m "$(cat <<'MSG'
docs(m365): deploy guidance for the tenant-sync route, caps and sign-in RPM

Adds the /v1/sync-action route contract and Graph sync profile, the four
capacity dials with when to raise each, the app-wide sign-in limiter and how to
split M365_SIGNIN_ACTIVITY_RPM across regions and replicas, and a memory
sizing table filled from the runbook's S7 measurement. The manifest-v3 app-role
rows are W01's and the executor metric names are W03's; this change links to
them rather than restating either.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 11: Runbook — sync acceptance checklist

Spec §9 last bullet: "v3 consent on a fresh tenant, upgrade-consent on an existing one, first sync populates all domains, on-demand sync, unlicensed sign-in on a non-P1 tenant, a role assigned via a role-assignable group".

**Files:**
- Modify: `docs/runbooks/m365-customer-graph-read-real-tenant.md`

The file already ends with a `## Read-action acceptance` section (prerequisites → acceptance matrix → numbered scenarios `R1`–`R5`). Add a parallel `## Tenant-sync acceptance` section in the same shape, with scenarios `S1`–`S7`.

- [ ] **Step 1: Append the section**

````markdown
---

## Tenant-sync acceptance

Run after the read-action acceptance passes, on a real customer tenant with an
administrator available. Sync is gated by `M365_TENANT_SYNC_ENABLED`; turn it
on for the acceptance window and record the flag state in the evidence record.

### Prerequisites

- `M365_TENANT_SYNC_ENABLED=true` on the API under test.
- The read app registration carries all four manifest-v3 roles
  (`Policy.Read.All`, `RoleManagement.Read.Directory`,
  `SecurityEvents.Read.All`, `AuditLogsQuery.Read.All`).
- Two tenants: one with Entra ID P1 or higher, one **without** (scenario S5).
- One directory role assigned through a **role-assignable group** rather than
  directly to a user (scenario S6). Create it as: a role-assignable security
  group → add one member → assign the group a directory role.
- `psql` access to the API's database as an administrator for the row
  assertions, and the Prometheus scrape URL for the metric assertions.
- Scenario **S7** needs none of the above — it measures the executor's memory
  ceiling against a fake Graph and can be run before any tenant is available.

### Acceptance matrix

| # | Scenario | Must be true |
|---|---|---|
| S1 | v3 consent on a fresh tenant | Six sync-state rows seeded, all six domains complete within one cadence window |
| S2 | Upgrade-consent on an existing v2 connection | Reads and sync never stop; manifest promotes in place; `consent_generation` increments |
| S3 | First sync populates every domain | Rows in all seven tables; rollup row for today with `domains_fresh` complete for all six |
| S4 | On-demand sync | Five non-sign-in domains re-run at priority 1; a second call within 15 minutes is refused |
| S5 | Non-P1 tenant | `sources.signInActivity = "unlicensed"`, domain status `success`, interval at its maximum, UI says sign-in needs Entra ID P1 |
| S6 | Role via a role-assignable group | The member's `admin_roles` entry carries `viaGroupId`; `is_admin` is true |
| S7 | Executor memory ceiling | Peak RSS under four concurrent 25 000-user snapshots is measured, and the deploy doc's memory-table cell is filled with it |

### S1. v3 consent on a fresh tenant

1. Connect a tenant that has never consented, approving the v3 manifest.
2. Assert six state rows exist and are due immediately:

```sql
SELECT domain, next_sync_at, interval_seconds, last_status
FROM m365_sync_state WHERE org_id = '<org>' ORDER BY domain;
```

3. Wait one ticker interval. Every row reaches `last_status = 'success'` (or
   `'partial'` with a recorded `sources` entry explaining which secondary
   source failed) and a non-null `last_complete_snapshot_at`.
4. Assert the first Secure Score run backfilled history:

```sql
SELECT count(*), min(score_date), max(score_date)
FROM m365_secure_score_snapshots WHERE org_id = '<org>';
```

   Expect up to 90 rows, dated by Graph's `createdDateTime` — the oldest row's
   date must be roughly 90 days before today, **not** today.

### S2. Upgrade-consent on an existing v2 connection

1. Start from a connection at `permission_manifest_version = 2`, status
   `active`. The card shows the amber "New Microsoft 365 permissions are
   required" banner.
2. Before approving, run an AI read tool and confirm it still answers, and
   confirm a `skus` sync run still completes. **Reads and sync must not stop
   while the upgrade is pending.**
3. Click **Approve new permissions** and complete the Microsoft flow.
4. Assert in-place promotion — the connection id does not change:

```sql
SELECT id, status, permission_manifest_version, consent_generation
FROM m365_connections WHERE org_id = '<org>' AND profile = 'customer-graph-read';
```

   `permission_manifest_version` is 3, `consent_generation` incremented by
   one, `status` still `active`, `id` unchanged from step 1.
5. Repeat with an **abandoned** flow: start the upgrade, close the Microsoft
   tab without approving, wait five minutes. The connection stays `active` at
   version 2 with `last_error_code` null, and reads keep working.

### S3. First sync populates every domain

```sql
SELECT 'users' AS t, count(*) FROM m365_users WHERE org_id = '<org>'
UNION ALL SELECT 'devices', count(*) FROM m365_intune_devices WHERE org_id = '<org>'
UNION ALL SELECT 'ca', count(*) FROM m365_ca_policies WHERE org_id = '<org>'
UNION ALL SELECT 'skus', count(*) FROM m365_license_skus WHERE org_id = '<org>'
UNION ALL SELECT 'scores', count(*) FROM m365_secure_score_snapshots WHERE org_id = '<org>'
UNION ALL SELECT 'rollups', count(*) FROM m365_posture_rollups WHERE org_id = '<org>';

SELECT domains_fresh FROM m365_posture_rollups
WHERE org_id = '<org>' AND rollup_date = current_date;
```

Every domain key in `domains_fresh` carries `"complete": true` and an `asOf`
within the cadence window. Cross-check counts against the Microsoft 365 admin
centre: user count, licensed seat count, and Intune device count must match
within the enrolment lag. Confirm the card's "Last synced" line agrees.

Then re-run the same domain and confirm the change-only contract holds:

```sql
SELECT last_counts FROM m365_sync_state WHERE org_id = '<org>' AND domain = 'users';
```

`updated` and `inserted` are 0 on an unchanged tenant, `unchanged` equals the
user count.

### S4. On-demand sync

1. Press the on-demand sync control (MFA-gated, like Retest).
2. Assert the five non-sign-in domains got `next_sync_at = now()` and were
   claimed at priority 1; `signin_activity` is untouched (it is app-wide
   budgeted and deliberately excluded).
3. Press it again immediately: it is refused by the per-org 15-minute Redis
   limit, with a message saying when it can be retried.

### S5. Non-P1 tenant: sign-in activity is unlicensed, not broken

```sql
SELECT last_status, sources, interval_seconds
FROM m365_sync_state WHERE org_id = '<non-p1-org>' AND domain = 'signin_activity';
```

`sources ->> 'signInActivity'` is `unlicensed`, `last_status` is `success`
(not `error`), and `interval_seconds` has been stretched to its maximum
(604800). No other domain is affected. The UI shows "Sign-in activity needs
Entra ID P1", never a blank or a zero.

### S6. Role assigned through a role-assignable group

```sql
SELECT user_principal_name, is_admin, admin_roles
FROM m365_users WHERE org_id = '<org>' AND is_admin;
```

The group member appears with `is_admin = true` and an `admin_roles` entry
carrying `viaGroupId` set to the group's object id. Nested groups are **not**
followed by design; a member of a group nested inside the role-assignable
group must not appear. Record both observations.

### S7. Executor memory ceiling under four concurrent maximum-size snapshots

The one scenario here that needs **no customer tenant**: it measures the
executor, not Microsoft. Run it before the first canary, because the memory
table in `docs/deploy/m365-customer-graph-read-executor.md` has a cell that
must hold a measured number rather than a guess, and a 25 000-seat tenant is
not something an acceptance window can conjure on demand. The ceiling is a
function of the item cap and the in-flight cap, not of who the users are.

1. Start the executor on its own, with the sync cap at its default and a
   container limit high enough that the limit is not what you are measuring:

```bash
M365_SYNC_MAX_IN_FLIGHT=4 M365_SYNC_MAX_ITEMS_USERS=25000 \
  node apps/m365-graph-read-executor/dist/index.js &
EXECUTOR_PID=$!
```

2. Point its Graph base URL at a local server that serves 25 000 projected
   users per pull. The payload shape is the one
   `apps/api/src/__tests__/integration/m365SyncFakeExecutor.ts` builds with
   `syncUsersResult` — generate it once and serve the same body to every call.
3. Issue four `m365.sync.users` calls concurrently and sample RSS throughout:

```bash
( while kill -0 "$EXECUTOR_PID" 2>/dev/null; do ps -o rss= -p "$EXECUTOR_PID"; sleep 0.25; done ) \
  | sort -n | tail -1     # peak RSS in kilobytes
```

4. Convert the peak to MiB and write it into the "4 × 25 000 users" row of the
   memory table in `docs/deploy/m365-customer-graph-read-executor.md`, then set
   the container limit to at least 1.5× that figure.
5. Repeat once with `M365_SYNC_MAX_IN_FLIGHT=1`. The peak should scale roughly
   linearly with the in-flight cap. If it does not, a snapshot is being
   retained after its response is written — that is a leak to fix, not a sizing
   number to record.

### Evidence to record

For each scenario: date, tenant display name (never the tenant id), operator,
the SQL output, the card screenshot where the scenario has a UI assertion, and
the values of `m365_sync_ticker_utilisation` and `m365_sync_due_backlog` at the
end of the window. Add the block to the evidence record template above.
````

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/m365-customer-graph-read-real-tenant.md
git commit -m "$(cat <<'MSG'
docs(m365): real-tenant acceptance checklist for tenant sync

Seven scenarios in the same shape as the existing read-action acceptance
section: v3 consent on a fresh tenant with the Graph-dated 90-day backfill,
upgrade-consent proving reads and sync never stop (including the abandoned
flow), first-sync population plus the change-only re-run, on-demand sync and
its 15-minute limit, a non-P1 tenant reporting unlicensed rather than error, a
directory role granted through a role-assignable group, and a tenant-free
measurement of the executor's RSS ceiling under four concurrent 25 000-user
snapshots, which is what fills the deploy doc's memory-table cell.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 12: Release notes, product docs, and environment reference

Spec §10.4–§10.5, §2.2.

**Files:**
- Create: `docs/release-notes/m365-tenant-sync.md`
- Modify: `apps/docs/src/content/docs/features/identity-integrations.mdx`
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx`

`docs/release-notes/` files are named by topic, not by date (`m365-ticket-mailbox-reconsent.md`, `remote-session-consent.md`, `native-consent-fallback.md`), so this follows that convention.

**W01 owns the manifest-v3 story.** Its own note, `docs/release-notes/m365-customer-graph-read-manifest-v3.md`, is the single source for the four new app roles, their GUIDs, and the non-interrupting re-consent behaviour — W01's plan says so explicitly. This note links to it and restates none of it; what belongs here is the sync-specific half: the environment variables, the flag-on rollout order, verification, and rollback.

- [ ] **Step 1: Write the release note**

`docs/release-notes/m365-tenant-sync.md`:

````markdown
# Microsoft 365 tenant sync

## Action required for self-hosters

This release adds a scheduled snapshot of each connected Microsoft 365 tenant
(users, sign-in activity, Intune devices, Conditional Access policies, license
SKUs, Secure Score) with a daily posture rollup. **It ships switched off.**

### 1. Read the manifest v3 note first

The `customer-graph-read` permission manifest moves from version 2 to
version 3 in this same release. Everything you must do about that — the four
Microsoft Graph application permissions to add to your own app registration,
their app-role GUIDs, and why existing connections keep working through the
amber **Approve new permissions** banner instead of stopping — is in
[Customer Graph Read manifest v3](./m365-customer-graph-read-manifest-v3.md).

The only sync-specific consequence: a domain whose scope has not been approved
yet stays `needs_consent` and is simply not scheduled. Every other domain keeps
running on the old grants, and turning sync on does not force the re-consent to
happen any sooner.

### 2. Set the environment variables

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `M365_TENANT_SYNC_ENABLED` | API | `false` | Master switch. Gates **every** entry point: the ticker, consent seeding, the on-demand route, and the disconnect hook's seeding side. Leave it off until you have read the deploy doc. |
| `M365_SYNC_CONCURRENCY` | API | `4` | Sync jobs processed per API instance. |
| `M365_SYNC_MAX_BACKLOG` | API | `500` | Queue depth above which the ticker sheds a tick rather than piling on. |
| `M365_SYNC_TICK_BATCH` | API | `200` | Rows claimed per 60-second tick. This is the capacity dial. |
| `M365_SYNC_MAX_IN_FLIGHT` | executor | `4` | Concurrent sync pulls per executor instance. |
| `M365_MAX_IN_FLIGHT` | executor | `32` | Total concurrent operations per executor instance; sync may use at most the sync cap out of this, so interactive AI-tool calls always keep headroom. |
| `M365_SIGNIN_ACTIVITY_RPM` | executor | `4` | Token bucket for sign-in-activity Graph requests. Microsoft limits these to **10 per minute per application across all tenants** — divide this value across regions and replicas that share one app registration. |
| `M365_SIGNIN_PAGES_PER_CALL` | executor | `5` | Pages per sign-in call before returning a continuation. |

Sync and interactive calls share one executor origin
(`M365_GRAPH_READ_EXECUTOR_URL`); there is no separate sync-executor URL. The
two routes are isolated by their independent caps, timeouts and metrics.

## Deployment

1. Deploy the database migration and the API together. The migration creates
   seven tables and adds one unique index to `m365_connections`; it creates no
   rows and takes no long lock.
2. Deploy the web UI and the executor.
3. Leave `M365_TENANT_SYNC_ENABLED=false` and confirm the stack is healthy.
   The upgrade-consent banner appears at this point, independently of the sync
   flag.
4. Turn `M365_TENANT_SYNC_ENABLED=true` on **one** region. No manual seeding is
   needed: the ticker's reconciliation step inserts sync-state rows for every
   executable connection that lacks them, staggered over the first hour, with
   the first Secure Score run backfilling 90 days of history.
5. Watch `m365_sync_ticker_utilisation`, `m365_sync_due_backlog`, the
   executor's `503 sync_capacity` counter, and database latency for one full
   cadence window (six hours) before enabling the second region.

## Verification

```sql
-- Every executable connection has six sync-state rows.
SELECT c.org_id, count(s.domain) AS domains
FROM m365_connections c
LEFT JOIN m365_sync_state s ON (s.connection_id, s.org_id) = (c.id, c.org_id)
WHERE c.profile = 'customer-graph-read' AND c.status IN ('active','degraded')
GROUP BY c.org_id HAVING count(s.domain) <> 6;
```

Zero rows means reconciliation has caught up. Domains that legitimately stay
unscheduled show `next_sync_at IS NULL` with `last_status = 'needs_consent'`;
they are still rows, so they do not appear in the query above.

## Rollback

Set `M365_TENANT_SYNC_ENABLED=false`. The ticker stops claiming, in-flight
jobs finish or are fenced harmlessly, and everything already stored stays
readable. **Keep the tables and the migration**; dropping them discards Secure
Score history, which cannot be regenerated (Graph serves only the recent
window). Manifest version 3 and the upgrade-consent route are independent of
the flag and should not be rolled back — a connection already promoted to v3
keeps working either way.
````

- [ ] **Step 2: Update the product docs feature page**

In `apps/docs/src/content/docs/features/identity-integrations.mdx`, first fix what manifest v3 changed (skip any that W01 already corrected — check with `grep -n "nine required permissions\|manifest version 2" apps/docs/src/content/docs/features/identity-integrations.mdx`):

- step 2 of the `<Steps>` list: "nine required permissions" → "thirteen required permissions"
- step 6: "manifest version 2" → "manifest version 3"
- the permission table: add the four v3 rows

```markdown
| `AuditLogsQuery.Read.All` | Run unified audit log queries on request |
| `Policy.Read.All` | Read Conditional Access policies and named locations |
| `RoleManagement.Read.Directory` | Read directory role assignments to identify administrators |
| `SecurityEvents.Read.All` | Read Microsoft Secure Score and its control profiles |
```

Then add a new section immediately before `### Legacy direct (existing client-secret method)`:

```markdown
#### Tenant sync and "as of" semantics

Once a tenant is connected, Breeze keeps a scheduled snapshot of it rather than
querying Microsoft on every page load. Six domains sync independently:

| Domain | Default cadence | What it stores |
|---|---|---|
| Users | 6 hours | Directory profile, licenses, MFA registration state, admin roles |
| Intune devices | 6 hours | Managed devices, compliance state, and the link to the Breeze device |
| Conditional Access | 24 hours | Policy definitions and enabled / report-only / disabled state |
| Licenses | 24 hours | Purchased and consumed seats per SKU |
| Secure Score | 24 hours | Daily score and per-control detail, backfilled 90 days on first sync |
| Sign-in activity | 24 hours | Last **successful** interactive sign-in per user |

Every figure Breeze shows carries an **as of** time — the last run that
completed a full enumeration of that domain, not the last time anything was
written. A domain that returned only part of the tenant (a very large tenant,
or Microsoft throttling mid-pull) is labelled **partial** and never causes a
user or device to be marked as gone. A domain whose permission has not been
approved yet is labelled **needs consent** and is simply not scheduled; the
other five keep running.

Cadences adapt on their own: a domain that truncates or runs slowly backs off,
a domain that has been quiet drifts back toward its default. You can force a
refresh from the card at most once every 15 minutes per organization.

**Sign-in activity requires Microsoft Entra ID P1 or higher.** On a tenant
without it, Breeze shows "Sign-in activity needs Entra ID P1" rather than an
empty or zero value — the data does not exist to be read. Sign-in activity is
also the one domain Microsoft rate-limits per application rather than per
tenant, so on large fleets it refreshes less often than the others and its
"as of" date is the honest answer to how current it is.

Disconnecting a tenant deletes the stored users, devices, policies and license
rows immediately. Secure Score history and the daily posture rollups are kept
and stay stamped with the tenant they came from, so reconnecting a different
tenant never mixes the two.

Breeze stores no sign-in logs, no IP addresses, and no audit-log rows. User
records are customer data of the customer's own tenant: they are included in an
organization export, erased with the organization, deleted on disconnect, and
purged 30 days after a user disappears from the tenant.
```

- [ ] **Step 3: Add the environment rows**

In `apps/docs/src/content/docs/deploy/environment.mdx`, extend the
`## Customer Microsoft 365 Graph-read consent (optional)` table with the API-side
sync variables and add a short subsection for the executor-side ones:

```markdown
| `M365_TENANT_SYNC_ENABLED` | — (the switch) | `true` / `false` (default `false`) | Master switch for the scheduled tenant snapshot (users, sign-in activity, Intune devices, Conditional Access, licenses, Secure Score). Gates **every** entry point: the ticker, post-consent seeding, the on-demand sync route, and the disconnect hook. Off means no sync work of any kind runs. |
| `M365_SYNC_CONCURRENCY` | No | Positive integer (default `4`) | Sync jobs processed concurrently per API instance. The Graph fetch holds no database connection, so this bounds persist work, not fetch work. |
| `M365_SYNC_MAX_BACKLOG` | No | Positive integer (default `500`) | Queue depth (`waiting + prioritized + delayed + active`) above which the ticker skips a tick. Due rows keep their past due time and are picked up next tick. |
| `M365_SYNC_TICK_BATCH` | No | Positive integer (default `200`) | Rows claimed per 60-second tick. This is the capacity dial: target at most 50 % utilisation of `batch × 1440` runs per day. |

### Executor: tenant sync

These are set on the **executor** sidecar, not the API.

| Variable | Required | Format / example | Meaning |
|---|---|---|---|
| `M365_SYNC_MAX_IN_FLIGHT` | No | Positive integer (default `4`) | Concurrent sync pulls per executor instance. Above it the sync route returns `503 sync_capacity` with `Retry-After: 30` and never queues internally. |
| `M365_MAX_IN_FLIGHT` | No | Positive integer (default `32`) | Total concurrent operations per instance. Sync may consume at most `M365_SYNC_MAX_IN_FLIGHT` of this, so interactive calls always keep reserved headroom. |
| `M365_SIGNIN_ACTIVITY_RPM` | No | Positive integer (default `4`) | Token bucket for sign-in-activity Graph requests. Microsoft's limit is **10 per minute per application across all tenants**, so divide this across every region and replica that shares one app registration. |
| `M365_SIGNIN_PAGES_PER_CALL` | No | Positive integer (default `5`) | Pages fetched per sign-in call before returning an opaque continuation. |
| `M365_SYNC_MAX_ITEMS_USERS` | No | Positive integer (default `25000`) | Per-pull user cap. A tenant over the cap syncs as `partial` and never has vanished rows marked stale; raising the cap is the remedy. |
| `M365_SYNC_MAX_ITEMS_DEVICES` | No | Positive integer (default `25000`) | Same, for Intune managed devices. |
| `M365_SYNC_MAX_ITEMS_CA` | No | Positive integer (default `500`) | Same, for Conditional Access policies. |
| `M365_SYNC_MAX_ITEMS_SKUS` | No | Positive integer (default `200`) | Same, for subscribed SKUs. |
```

- [ ] **Step 4: Run the docs checks**

```bash
pnpm --filter @breeze/docs check
pnpm --filter @breeze/docs build
```

- [ ] **Step 5: Commit**

```bash
git add docs/release-notes/m365-tenant-sync.md \
        apps/docs/src/content/docs/features/identity-integrations.mdx \
        apps/docs/src/content/docs/deploy/environment.mdx
git commit -m "$(cat <<'MSG'
docs(m365): release note, feature page, and env reference for tenant sync

Release note links to W01's manifest-v3 note for the four new app roles and the
re-consent behaviour rather than restating them, and covers the sync-specific
half: every new environment variable with its default, the flag-on rollout
order, a verification query, and a rollback that explicitly keeps the tables
(Secure Score history cannot be regenerated). Feature page gains the per-domain
cadence table, the "as of" semantics, the Entra P1 note for sign-in activity,
and what disconnect keeps. Environment reference gains the API and executor
variable rows.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 13: Card verification — W05's "Last synced …" line and chips actually render

Spec §2.2 point 3 (card presentation), §6 (what each state surfaces).

**W05 owns the card. This task adds no card code.** The parser widening (`parseEnvelope`), the `Sync now` button, the "Last synced …" line, the per-domain chips, `formatRelativeTime`, and the `m365CustomerGraphRead.sync.*` keys in all eight locale catalogs are W05's Task 15. What is missing after W05 is only a check that the envelope shape the API actually sends — the `sync` block on the **envelope**, not on the connection — reaches the screen. That is one test.

**Files:**
- Modify: `apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx` (W05's suite — append one `describe`; add no imports, no mocks, no locale keys, no component code)

**Interfaces:**
- Consumes: the file's existing `envelope()` helper, `fetchWithAuthMock`, `render`, `screen`. Nothing new is imported. The envelope fields come from the overview's contract:

```ts
syncEnabled: boolean;
sync: null | {
  lastSuccessAt: string | null;
  users: number | null;
  devices: number | null;
  domains: Array<{
    domain: 'users' | 'signin_activity' | 'intune_devices' | 'ca_policies' | 'skus' | 'secure_score';
    status: 'success' | 'partial' | 'needs_consent' | 'throttled' | 'error' | 'never';
    asOf: string | null;      // last_complete_snapshot_at
    truncated: boolean;
    unlicensed: boolean;      // sources.signInActivity === 'unlicensed'
  }>;
};
```

- [ ] **Step 1: Write the verification test**

Append to `apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx`:

```ts
/**
 * Verification, not TDD: W05 built this card and its own suite covers the
 * button, the parser and the hidden states. What only this wave can see is
 * that the envelope shape the API really sends — `syncEnabled` and `sync` on
 * the ENVELOPE, beside `connection`, not inside it — survives the card's
 * strict `hasExactKeys` parser and reaches the screen. A drift between the
 * DTO and the parser degrades the whole card to "unavailable" silently, which
 * is exactly the failure no other test in this wave would notice.
 */
describe("sync summary renders from the envelope", () => {
  it("shows the last-synced line, the counts, and a chip for the unlicensed domain", async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({
      syncEnabled: true,
      sync: {
        lastSuccessAt: "2026-09-08T11:30:00.000Z",
        users: 128,
        devices: 96,
        domains: [
          { domain: "users", status: "success", asOf: "2026-09-08T11:30:00.000Z", truncated: false, unlicensed: false },
          { domain: "signin_activity", status: "success", asOf: null, truncated: false, unlicensed: true },
          { domain: "intune_devices", status: "success", asOf: "2026-09-08T11:00:00.000Z", truncated: false, unlicensed: false },
          { domain: "ca_policies", status: "success", asOf: "2026-09-08T02:00:00.000Z", truncated: false, unlicensed: false },
          { domain: "skus", status: "success", asOf: "2026-09-08T02:00:00.000Z", truncated: false, unlicensed: false },
          { domain: "secure_score", status: "never", asOf: null, truncated: false, unlicensed: false },
        ],
      },
    })));

    render(<M365CustomerGraphReadCard />);

    // The card parsed the envelope rather than degrading to its
    // "Connection details are unavailable." state.
    expect(await screen.findByText(/Last synced/)).toBeInTheDocument();
    expect(screen.getByText(/128 users/)).toBeInTheDocument();
    expect(screen.getByText(/96 devices/)).toBeInTheDocument();
    // At least one chip: sign-in activity on a tenant without Entra ID P1.
    expect(screen.getByText(/Entra ID P1/)).toBeInTheDocument();
  });
});
```

Two things to check against the code before running, because both are W05's and this test only asserts what W05 shipped:

- The English copy. Read `apps/web/src/locales/en/integrations.json` under `m365CustomerGraphRead.sync` and assert the strings that are actually there. Do not add, rename or translate a key here — that is W05's Task 15, in all eight catalogs at once.
- Whether the counts render in one node with the relative time or in a separate one. If they share a node, assert with `toHaveTextContent` on that node instead of three separate `getByText` calls.

If the file's `envelope()` helper does not already carry `syncEnabled` and `sync`, W05's parser change landed without its fixture update and every test in the file is failing already — fix the helper in W05's file and say so in the PR body.

- [ ] **Step 2: Run**

```bash
cd apps/web && npx vitest run src/components/integrations/M365CustomerGraphReadCard.test.tsx
```

Expected: PASS. This one is deliberately not red-first — the behaviour already exists. **A red here is the finding**, not a step in the process: either the DTO and the card's parser have drifted apart (fix whichever is wrong, in W05's files), or the card never renders the line for an envelope-level `sync` block. Either way it is a W05 defect fixed in W05's files, with the reason in the PR body — never patched around by relaxing this assertion or by adding a second parser here.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx
git commit -m "$(cat <<'MSG'
test(m365): prove the envelope sync block reaches the card

W05 owns the card; this adds the one case its suite cannot have: the exact
envelope shape the API sends, with syncEnabled and sync as siblings of
connection rather than fields inside it, driven through the card's strict
hasExactKeys parser. A drift between the DTO and that parser degrades the whole
card to its "unavailable" state without failing anything else in this wave.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
MSG
)"
```

---

### Task 14: Full verification, CI-shard proof, and PR

- [ ] **Step 1: Prove the new suites are actually in a CI shard**

The `integration-test` job runs `pnpm --filter=@breeze/api test:integration --shard=N/4`, and that config's first include is the directory glob. Prove both the glob and the discovery:

```bash
grep -n "src/__tests__/integration/\*\*/\*.test.ts" apps/api/vitest.integration.config.ts
grep -n "test:integration --shard" .github/workflows/ci.yml

cd apps/api && npx vitest list --config vitest.integration.config.ts \
  | grep -E "m365TenantSync|m365SyncClaim|m365ConnectionLifecycle"
```

All three files must appear. Then run the contract test that guards this mapping for everyone else:

```bash
pnpm --filter=@breeze/api test:integration-suite-coverage
```

- [ ] **Step 2: Run everything this wave touched**

```bash
pnpm test-stack up

# New and modified integration suites (real Postgres + Redis)
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365TenantSync.integration.test.ts \
  src/__tests__/integration/m365SyncClaim.integration.test.ts \
  src/__tests__/integration/m365ConnectionLifecycle.integration.test.ts

# Unit tests touched here (metrics.test.ts is W04's suite, appended to)
cd apps/api && npx vitest run src/services/m365Sync/metrics.test.ts \
  scripts/m365-sync-benchmark.lib.test.ts
cd apps/m365-graph-read-executor && npx vitest run src/syncMetricNames.contract.test.ts
cd apps/web && npx vitest run src/components/integrations/M365CustomerGraphReadCard.test.tsx

# Tenancy contract suites — this wave adds no table, but it touched the
# lifecycle/disconnect path, so prove the cascade contracts still hold.
# Run the WHOLE integration suite through the package script with no path
# arguments; `test:integration -- <path>` silently runs everything anyway.
pnpm --filter=@breeze/api test:integration
pnpm --filter=@breeze/api test:rls-coverage

# Typecheck + lint
pnpm lint
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/web exec tsc --noEmit
pnpm --filter @breeze/m365-graph-read-executor exec tsc --noEmit

# Docs
pnpm --filter @breeze/docs check && pnpm --filter @breeze/docs build

pnpm test-stack down && docker compose ls -a
```

Scoping one integration file always means `npx vitest run --config vitest.integration.config.ts <path>` — never `pnpm … test:integration -- <path>`, which forwards the `--` into the script's argv and runs the entire suite regardless.

- [ ] **Step 2b: Merge main and re-verify before pushing**

```bash
git fetch origin main && git merge origin/main
git diff --stat origin/main...HEAD -- apps/api/migrations/   # must be empty for this wave
```

Local green on a stale base is not CI green — the PR tests the merge commit.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feature/5327-m365-tenant-sync/wave-5333
gh pr create --base main --title "test(m365): tenant sync end-to-end suite, benchmark harness, docs and card last-synced line" --body "$(cat <<'BODY'
## Summary

Wave 6 of the M365 tenant sync foundation (`#5327`). No new tables, no
migration, and no runtime code at all — this wave is the proof, the capacity
tooling, and the operator/customer documentation for what W01–W05 built.

- **End-to-end integration suite** (`m365TenantSync.integration.test.ts`,
  real Postgres): seeds an org with an active manifest-v3 connection, runs all
  six domains through `runSyncDomain` directly against an in-process fake
  executor that verifies the EdDSA internal-auth JWT exactly as the real one
  does, with sign-in returning a continuation once. Asserts rows in all seven
  tables, per-domain sync-state completion fields, the rollup including
  `domains_fresh`, and the 90-day Secure Score backfill keyed by Graph's own
  dates rather than the fetch day.
- **Change-only writes** proved with an `xmin` tuple-version diff: a second run
  with one changed user rewrites exactly one row, and an unchanged tenant
  writes none.
- **Truncated runs** persist without marking anything stale and without moving
  `last_complete_snapshot_at`; the next complete run does mark the vanished row.
- **Fenced runs** (superseded `run_generation`) discard silently, write nothing,
  and increment `m365_sync_fenced_total`.
- **Disconnect** drops entities and schedule while keeping tenant-stamped
  Secure Score history and rollups.
- **Re-consent** cases in `m365ConnectionLifecycle.integration.test.ts`: a v2
  row derives `manifest-stale` and the read DTO exposes it, and sync keeps
  running on v2 grants while the upgrade is pending. The consent-session
  mechanics stay in W01's suite.
- **Claim concurrency:** two simultaneous `claimDueDomains` calls over twelve
  due rows spanning two domains per org partition them with no overlap and
  **nothing lost**, each with one generation bump and an unadvanced
  `next_sync_at`. Appended to W04's claim suite.
- **Metric names:** the `breeze_`-prefixed-twin guard is appended to W04's
  `metrics.test.ts` (the single name-contract suite), and the executor's five
  names are pinned by a source scan.
- **Benchmark harness** (`pnpm --filter @breeze/api m365-sync:benchmark`, not
  CI) with pass criteria fixed before the first run, plus
  `docs/runbooks/m365-sync-benchmark.md` on running it against a
  production-class managed Postgres.
- **Docs:** deploy doc gains the sync route, capacity dials, the app-wide
  sign-in RPM split and a memory sizing table; the real-tenant runbook gains a
  six-scenario sync acceptance checklist; a self-hoster release note; the
  feature page gains cadences, "as of" semantics and the Entra P1 note; the
  environment reference gains every new variable.
- **Card verification:** one test proving the envelope-level `syncEnabled` /
  `sync` block survives the card's strict parser and renders W05's "Last
  synced …" line, counts, and the unlicensed sign-in chip. No card code here —
  W05 owns all of it.

## Testing

- `pnpm --filter=@breeze/api test:integration` (full suite, real PG + Redis)
- `pnpm --filter=@breeze/api test:rls-coverage`
- `pnpm --filter=@breeze/api test:integration-suite-coverage` — confirms the new
  suite is matched by the config the CI shards run
- `cd apps/web && npx vitest run src/components/integrations`
- `cd apps/m365-graph-read-executor && npx vitest run`
- `pnpm lint`, `tsc --noEmit` in api / web / executor
- `pnpm --filter @breeze/docs check && build`
- Benchmark smoke run at `--orgs=5 --window-minutes=1` against the test stack
  (a real capacity run belongs on a managed instance, per the runbook)

## Risk

Test- and docs-only: no production TypeScript changes in any app, no migration,
no new table, no new locale key. The only executable additions are test files,
the (not-CI) benchmark script, and one `package.json` script entry.

Closes #5333

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 4: Watch CI, then complete the wave**

```bash
gh pr checks --watch ; true   # `gh pr checks` exits non-zero while PENDING
```

When green, merge through the queue (`gh pr merge <N> --squash`, **never**
`--admin`), then `complete_wave` for `#5333` via the feature-lifecycle MCP.
